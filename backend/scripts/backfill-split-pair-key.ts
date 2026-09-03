/**
 * 存量「拆单半间行」的配对键（`splitPairKey`）**回填**脚本。
 *
 * 背景：一间房被拆单劈成两张单的两个半间时，现在两侧会写同一个 `splitPairKey`
 *（split-move-strategies 的 splitPairKeyOf / orders.service 的 splitMixedRoomGroup），
 * 房控的 expandSplitPairedByDate 据此把它们**配回一间**。这把键是后加的：
 * 在它之前拆出来的存量行没有键，房控只能退回按房型/性别推算 —— 夫妻拼房被拆开
 * 正是「一男一女各半间」，性别口径把本来的一间算成两间，凭空多占一间房。
 *
 * 本脚本给这些存量行补上键。判定内核全部在
 * `src/modules/orders/split-pair-backfill.ts`（纯函数、有单测），脚本这一层只负责
 * 捞数据、打印、按 --apply 落库 —— 判定逻辑一行都不在这里复制，避免脚本自己成为新的口径分叉源。
 *
 * 配对判据（全部满足才写，宁可不配也绝不错配 —— 错配会把两间真房并成一间，直接超卖）：
 *   · 新行 metadata 带 splitFromItemId，且新行与源行 roomsBilled **都恰好 0.5**；
 *   · 同 kind（HOTEL / BUNDLE）、分属两张不同订单；
 *   · 同酒店房型（hotelRoomTypeId 相等；都为空时星级随机档也要相等）、同入住区间；
 *   · 两侧都还没有 splitPairKey（已有的一律不碰）。
 * 键值：`源行id:backfill-<该次拆单记录的 requestToken；取不到则回落到新行 id>`。
 *
 * 分房表同步：两张单的 roomAssignment 里，各自「半间 + 无配对键 + **显式写了 orderItemId
 * 且指向这一行**」的房组**各恰好一个**时写同一把键；有两个以上就跳过交人工（无从判断谁配谁）。
 * 没写 orderItemId 的老房组一律跳过（原因「房组无行归属，交人工」）—— 一张单有两行住宿时
 * 按单兜底会把另一行的半房组配过来，两间真房并成一间 = 超卖。
 *
 * 回收站单（order.deletedAt 非空）两侧都不回填。
 * --apply 会额外落一条 CRITICAL 审计 `BACKFILL_SPLIT_PAIR_KEY`（after 带本次全量配对清单），
 * 事后可据此逐条回溯或回滚。
 *
 * ⚠ 一个字都不动钱与房量：unitPrice / amount / unitCostCny / totalCostCny / roomsBilled /
 *   roomFraction 全部原样，只往 metadata 与房组上加一个 `splitPairKey` 字段。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/backfill-split-pair-key.ts                # dry-run 全量预览（只读）
 *   npx tsx scripts/backfill-split-pair-key.ts --limit=20     # 只看前 20 条候选
 *   npx tsx scripts/backfill-split-pair-key.ts --apply        # 真正写回
 *
 * 参数：
 *   --apply     真正写库（不加 = dry-run，只读）
 *   --limit=N   只处理前 N 条候选行（按建单时间升序），用于试水
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量，与后端服务同一个 src/db/prisma.js 客户端。
 *
 * ⚠️ 线上怎么跑（scripts/ 既不被 build 编译、也不进 Docker 镜像）：
 *   本目录下的脚本不在镜像里，容器内直接 `npx tsx scripts/...` 找不到文件。做法是把源码拷进
 *   容器再用镜像自带的 tsx 跑（以实测环境 /opt/ftm 为例，测试环境把 ftm 换成 ftm-staging）：
 *     cd /opt/ftm
 *     docker cp backend/src     ftm-backend-1:/app/src
 *     docker cp backend/scripts ftm-backend-1:/app/scripts
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-split-pair-key.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-split-pair-key.ts --apply    # 核对无误再执行
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 */
import { OrderItemKind, Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAudit } from '../src/lib/audit.js';
import {
  decideItemPair,
  decideRoomGroupPair,
  readBackfillRoomGroups,
  splitFromItemIdOf,
  withGroupPairKey,
  type BackfillItemView,
} from '../src/modules/orders/split-pair-backfill.js';

const LOG_PREFIX = '[backfill-split-pair-key]';

/** 一对行 + 它们两张单的分房表，一个事务内写完（半写会让房控只看到一侧带键 = 照样配不上对）。 */
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 15_000;

interface CliOptions {
  apply: boolean;
  limit?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const apply = argv.includes('--apply');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limitRaw = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
  if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
    throw new Error('--limit 必须是正整数');
  }
  return { apply, limit: limitRaw };
}

/** Prisma 行的原始形状（Decimal → number 的转换在 toView 里做，判定层只见纯数）。 */
type RawItem = {
  id: string;
  orderId: string;
  kind: OrderItemKind;
  hotelRoomTypeId: string | null;
  randomStarTier: number | null;
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
  roomsBilled: Prisma.Decimal | null;
  metadata: Prisma.JsonValue | null;
};

function toView(row: RawItem): BackfillItemView {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    hotelRoomTypeId: row.hotelRoomTypeId,
    randomStarTier: row.randomStarTier,
    hotelCheckIn: row.hotelCheckIn,
    hotelCheckOut: row.hotelCheckOut,
    roomsBilled: row.roomsBilled == null ? null : Number(row.roomsBilled),
    metadata: row.metadata,
  };
}

const ITEM_SELECT = {
  id: true,
  orderId: true,
  kind: true,
  hotelRoomTypeId: true,
  randomStarTier: true,
  hotelCheckIn: true,
  hotelCheckOut: true,
  roomsBilled: true,
  metadata: true,
} as const;

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${apply ? '写库（--apply）' : 'dry-run（只读）'}`);

  // 候选：住宿相关的半间行。「带 splitFromItemId」在 JSON 里没法用 Prisma where 表达，
  // 所以先按 kind + roomsBilled=0.5 粗筛，再在 JS 里逐行看 metadata。
  const candidates = (await prisma.orderItem.findMany({
    where: {
      kind: { in: [OrderItemKind.HOTEL, OrderItemKind.BUNDLE] },
      roomsBilled: new Prisma.Decimal(0.5),
      // 回收站单不回填（口径同全站导出）：那些行早就不占房，给它们配上键只会
      // 让房控把两个已删除的半间当成一间真房。
      order: { deletedAt: null },
    },
    select: ITEM_SELECT,
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  })) as RawItem[];

  const scanned = candidates.filter((row) => splitFromItemIdOf(row.metadata) != null);
  console.log(
    `${LOG_PREFIX} 候选半间行 ${candidates.length} 条，其中带 splitFromItemId 的 ${scanned.length} 条`,
  );

  let paired = 0;
  let pairedGroups = 0;
  /** 本次真正写下去的配对清单（--apply 时整份进审计的 after，事后可逐条回溯/回滚）。 */
  const pairedLog: Array<{
    sourceOrderNumber: string;
    sourceItemId: string;
    splitOrderNumber: string;
    splitItemId: string;
    splitPairKey: string;
    roomGroupPaired: boolean;
  }> = [];
  const skipReasons = new Map<string, number>();
  const skip = (itemId: string, reason: string): void => {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
    console.log(`${LOG_PREFIX} 跳过 ${itemId}：${reason}`);
  };

  for (const row of scanned) {
    const splitView = toView(row);
    const sourceId = splitFromItemIdOf(row.metadata);
    const sourceRow = sourceId
      ? ((await prisma.orderItem.findUnique({
          where: { id: sourceId },
          select: ITEM_SELECT,
        })) as RawItem | null)
      : null;
    const sourceView = sourceRow ? toView(sourceRow) : null;

    // 该次拆单的 requestToken：键里带上它，事后能把回填出来的键对回那一次拆单记录。
    // 取不到（老拆单没留记录 / 记录已删）→ 判定内核回落到新行 id，键照样唯一。
    const splitRecord = sourceView
      ? await prisma.orderSplitRecord.findFirst({
          where: { sourceOrderId: sourceView.orderId, targetOrderId: splitView.orderId },
          select: { requestToken: true },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    const decision = decideItemPair(splitView, sourceView, splitRecord?.requestToken ?? null);
    if (!decision.ok || sourceView == null) {
      skip(row.id, decision.ok ? '源行缺失' : decision.reason);
      continue;
    }
    const key = decision.splitPairKey;

    // 分房表：两张单各挑出恰好一个半房组写同一把键（挑不出 / 不唯一就只写订单行那一层）。
    const [sourceOrder, splitOrder] = await Promise.all([
      prisma.order.findUnique({
        where: { id: sourceView.orderId },
        select: { id: true, orderNumber: true, roomAssignment: true, deletedAt: true },
      }),
      prisma.order.findUnique({
        where: { id: splitView.orderId },
        select: { id: true, orderNumber: true, roomAssignment: true, deletedAt: true },
      }),
    ]);
    // 源行那张单在回收站 → 整对不回填（候选侧已按 order.deletedAt 筛过，这里补上另一侧）。
    if (sourceOrder?.deletedAt != null || splitOrder?.deletedAt != null) {
      skip(row.id, '配对的另一张单在回收站');
      continue;
    }
    const groupDecision = decideRoomGroupPair(
      readBackfillRoomGroups(sourceOrder?.roomAssignment),
      readBackfillRoomGroups(splitOrder?.roomAssignment),
      sourceView.id,
      splitView.id,
    );

    console.log(
      `${LOG_PREFIX} 配对 ${sourceOrder?.orderNumber ?? sourceView.orderId}#${sourceView.id}` +
        ` ↔ ${splitOrder?.orderNumber ?? splitView.orderId}#${splitView.id}` +
        ` → ${key}` +
        (groupDecision.ok ? '（含分房表两个半房组）' : `（分房表未配对：${groupDecision.reason}）`) +
        (apply ? '' : '（dry-run，未写）'),
    );
    paired += 1;
    if (groupDecision.ok) pairedGroups += 1;

    if (!apply) continue;

    // 一对行 + 两张单的分房表同一个事务：半写状态下房控只看到一侧带键，照样配不上对。
    await prisma.$transaction(
      async (tx) => {
        for (const target of [sourceView, splitView]) {
          const current = await tx.orderItem.findUniqueOrThrow({
            where: { id: target.id },
            select: { metadata: true },
          });
          const meta =
            current.metadata != null &&
            typeof current.metadata === 'object' &&
            !Array.isArray(current.metadata)
              ? (current.metadata as Record<string, unknown>)
              : {};
          await tx.orderItem.update({
            where: { id: target.id },
            data: { metadata: { ...meta, splitPairKey: key } as Prisma.InputJsonValue },
          });
        }
        if (groupDecision.ok && sourceOrder && splitOrder) {
          await tx.order.update({
            where: { id: sourceOrder.id },
            data: {
              roomAssignment: withGroupPairKey(
                sourceOrder.roomAssignment,
                groupDecision.sourceIndex,
                key,
              ) as Prisma.InputJsonValue,
            },
          });
          await tx.order.update({
            where: { id: splitOrder.id },
            data: {
              roomAssignment: withGroupPairKey(
                splitOrder.roomAssignment,
                groupDecision.splitIndex,
                key,
              ) as Prisma.InputJsonValue,
            },
          });
        }
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
    );

    // 写成了才记进清单：事务抛错时这一对没落库，审计里不该出现它。
    pairedLog.push({
      sourceOrderNumber: sourceOrder?.orderNumber ?? '',
      sourceItemId: sourceView.id,
      splitOrderNumber: splitOrder?.orderNumber ?? '',
      splitItemId: splitView.id,
      splitPairKey: key,
      roomGroupPaired: groupDecision.ok,
    });
  }

  // --apply 必留一条 CRITICAL 审计：这把键决定房控把两个半间算成一间还是两间，
  // 写错就是超卖。事后要能回答「谁、什么时候、给哪些行补了哪把键」，
  // 光靠脚本的 stdout 是留不住的。
  if (apply) {
    await writeAudit({
      actor: { label: 'backfill-split-pair-key', role: 'SYSTEM' },
      action: 'BACKFILL_SPLIT_PAIR_KEY',
      targetType: 'ORDER',
      targetLabel: `拆单配对键回填 · 写入 ${pairedLog.length} 对（其中分房表 ${pairedGroups} 对）`,
      after: {
        scanned: scanned.length,
        paired: pairedLog.length,
        pairedRoomGroups: pairedGroups,
        skipped: scanned.length - paired,
        limit: limit ?? null,
        skipReasons: Object.fromEntries(skipReasons),
        // 全量清单进 after：回滚时逐条按 splitPairKey 找回这两行。
        pairs: pairedLog,
      },
      severity: 'CRITICAL',
    });
  }

  console.log(
    `${LOG_PREFIX} 完成：scanned ${scanned.length} / paired ${paired}` +
      `（其中分房表也配上的 ${pairedGroups}）/ skipped ${scanned.length - paired}` +
      (apply ? '' : '。确认无误后加 --apply 真正写回。'),
  );
  if (skipReasons.size > 0) {
    console.log(`${LOG_PREFIX} 跳过原因汇总：`);
    for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${LOG_PREFIX}   ${count} 条 · ${reason}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
