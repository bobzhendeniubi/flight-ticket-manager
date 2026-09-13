/**
 * 存量分房表房组「酒店名 / 房型」+ 机票腿 description 套餐名前缀的**回填**脚本。
 *
 * 背景：分房表 `Order.roomAssignment.roomGroups[].hotelName` 是归属订单行落位的**照抄文本**。
 * 早期分房弹窗对套餐(BUNDLE)行没联查到酒店名时，拿行 description 首段（= 套餐名，
 * 「四星 2天1晚 岘港」）顶上存进了房组；套餐改档流程此前也不刷这段文本。而三张导出表的
 * 「酒店」列刻意优先取房组文本（跟房控走）→ 产品内容已改成三星，导出仍印「四星 2天1晚 岘港」。
 * 改档 / 换酒店流程现已同事务刷新（orders.service → room-group-placement.refreshRoomGroupsForItem），
 * 本脚本只管**存量**。
 *
 * 判定内核全部在 `src/modules/orders/room-group-placement.ts`（纯函数、有单测：
 * planRoomGroupTextBackfill），脚本这一层只负责捞数据、打印、按 --apply 落库 ——
 * 判定逻辑一行都不在这里复制，避免脚本成为新的口径分叉源。
 *
 * 房组改写判据（全部满足才写，宁可不改也不覆盖房控手填）：
 *   · 房组带 orderItemId 且指向本单存活的行，且该行能解析出落位名（真酒店 FK / 占位酒店档次 /
 *     randomStarTier）；无归属的房组只在「文本是套餐名 + 本单恰好一条能解析落位的占房行」时才认；
 *   · 房组当前 hotelName 属于派生残留四类之一：空 / 套餐名（含「N天N晚」）/ 占位酒店字面名 /
 *     短档次名「X星随机」—— 其它文本一律视为房控手填，**不动**，只打印「交人工」；
 *   · roomType 随 hotelName 一起改成落位房型（真酒店 = FK 房型名；随机档 = 「待落位」），
 *     但房控已填的非空、非「待落位」、非套餐名的房型文本保留。
 * 机票腿 description：仅限套餐行 metadata.bundleChange 能推出 to 名、且与套餐行现名一致的单，
 *   把「<from 名> · 」前缀（from 名 = bundleChange.fromBundleName + 历次差额行描述里的新旧名）
 *   换成 to 名；只认精确前缀。
 *
 * 留档（--apply 时）：
 *   1. 先把每张改动单的 before（整份 roomAssignment + 受影响行的 description）写进 JSON 备份文件
 *      （默认 ./backfill-room-group-hotel-name-<UTC 时间戳>.json，--backup=<路径> 可改），写不出文件就不落库；
 *   2. 再逐单一个事务写库（roomAssignment + 各行 description 一起成功或一起回滚）；
 *   3. 最后落一条 WARNING 审计 `BACKFILL_ROOM_GROUP_HOTEL_NAME`，after 带本次全量改动清单与备份文件路径，
 *      事后可据此逐单回溯 / 回滚。
 *
 * ⚠ 一个字都不动钱与房量：unitPrice / amount / roomsBilled / roomFraction / passengerIds /
 *   splitPairKey 全部原样，只改房组的 hotelName / roomType 与派生行的 description 文本。
 * 回收站单（order.deletedAt 非空）不回填。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/backfill-room-group-hotel-name.ts                 # dry-run 全量预览（只读）
 *   npx tsx scripts/backfill-room-group-hotel-name.ts --limit=20      # 只看前 20 张候选单
 *   npx tsx scripts/backfill-room-group-hotel-name.ts --order=FTM2026091242989   # 只看某张单（可逗号分隔）
 *   npx tsx scripts/backfill-room-group-hotel-name.ts --apply         # 真正写回（先写备份 JSON 再落库）
 *
 * 参数：
 *   --apply           真正写库（不加 = dry-run，只读）
 *   --limit=N         只处理前 N 张候选单（按建单时间升序），用于试水
 *   --order=A,B       只处理指定订单号
 *   --backup=<路径>   备份 JSON 文件路径（仅 --apply 有效）
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
 *       npx tsx scripts/backfill-room-group-hotel-name.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-room-group-hotel-name.ts --apply --backup=/app/backfill-room-group-hotel-name.json
 *     docker cp ftm-backend-1:/app/backfill-room-group-hotel-name.json /opt/ftm/backups/   # 备份文件拷出容器
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OrderItemKind, Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAudit } from '../src/lib/audit.js';
import {
  planRoomGroupTextBackfill,
  type BackfillOrderView,
  type BackfillPlan,
} from '../src/modules/orders/room-group-placement.js';

const LOG_PREFIX = '[backfill-room-group-hotel-name]';
const PAGE_SIZE = 200;
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 15_000;

interface CliOptions {
  apply: boolean;
  limit?: number;
  orderNumbers?: string[];
  backupPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const apply = argv.includes('--apply');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limitRaw = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
  if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
    throw new Error('--limit 必须是正整数');
  }
  const orderArg = argv.find((a) => a.startsWith('--order='));
  const orderNumbers = orderArg
    ? orderArg
        .slice('--order='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const backupArg = argv.find((a) => a.startsWith('--backup='));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(
    backupArg ? backupArg.slice('--backup='.length) : `./backfill-room-group-hotel-name-${stamp}.json`,
  );
  return { apply, limit: limitRaw, orderNumbers, backupPath };
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  roomAssignment: true,
  items: {
    select: {
      id: true,
      kind: true,
      description: true,
      metadata: true,
      randomStarTier: true,
      hotelRoomType: {
        select: { name: true, hotel: { select: { name: true, randomTierPlaceholder: true } } },
      },
    },
  },
} as const;

type RawOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

function toView(row: RawOrder): BackfillOrderView {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    roomAssignment: row.roomAssignment,
    items: row.items.map((it) => ({
      id: it.id,
      kind: it.kind,
      description: it.description,
      metadata: it.metadata,
      randomStarTier: it.randomStarTier,
      hotelRoomType: it.hotelRoomType,
    })),
  };
}

/** 备份文件里每张单的条目：before 足够整单还原（整份 roomAssignment + 受影响行的原 description）。 */
interface BackupEntry {
  orderId: string;
  orderNumber: string;
  before: {
    roomAssignment: unknown;
    items: Array<{ id: string; description: string }>;
  };
  after: {
    roomAssignment: unknown;
    items: Array<{ id: string; description: string }>;
  };
  groupChanges: BackfillPlan['groupChanges'];
}

/** 候选单：未删、且（有分房表 或 套餐行带改档留痕）。分页捞，避免一把抓整表。 */
async function* iterateCandidates(opts: CliOptions): AsyncGenerator<RawOrder> {
  const where: Prisma.OrderWhereInput = {
    deletedAt: null,
    ...(opts.orderNumbers ? { orderNumber: { in: opts.orderNumbers } } : {}),
    OR: [
      { roomAssignment: { not: Prisma.DbNull } },
      {
        items: {
          some: {
            kind: OrderItemKind.BUNDLE,
            metadata: { path: ['bundleChange'], not: Prisma.DbNull },
          },
        },
      },
    ],
  };
  let cursor: string | null = null;
  let yielded = 0;
  for (;;) {
    const page: RawOrder[] = await prisma.order.findMany({
      where,
      select: ORDER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) return;
    for (const row of page) {
      yield row;
      yielded += 1;
      if (opts.limit && yielded >= opts.limit) return;
    }
    cursor = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) return;
  }
}

async function applyPlan(view: BackfillOrderView, plan: BackfillPlan): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      if (plan.roomAssignment) {
        await tx.order.update({
          where: { id: view.id },
          data: { roomAssignment: plan.roomAssignment as Prisma.InputJsonValue },
        });
      }
      for (const change of plan.descriptionChanges) {
        // 乐观校验：只在 description 仍是计划时读到的旧值时才改（并发售后动了就跳过，不覆盖）。
        await tx.orderItem.updateMany({
          where: { id: change.itemId, orderId: view.id, description: change.before },
          data: { description: change.after },
        });
      }
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${opts.apply ? '写库（--apply）' : 'dry-run（只读）'}`);
  if (opts.orderNumbers) console.log(`${LOG_PREFIX} 只看订单：${opts.orderNumbers.join(', ')}`);

  let scanned = 0;
  const planned: Array<{ view: BackfillOrderView; plan: BackfillPlan }> = [];
  const skipReasons = new Map<string, number>();

  for await (const row of iterateCandidates(opts)) {
    scanned += 1;
    const view = toView(row);
    const plan = planRoomGroupTextBackfill(view);
    for (const s of plan.skipped) {
      skipReasons.set(s.reason, (skipReasons.get(s.reason) ?? 0) + 1);
      console.log(`${LOG_PREFIX} ${view.orderNumber} 房组 ${s.groupId || '(无 id)'} 跳过：${s.reason}`);
    }
    if (plan.groupChanges.length === 0 && plan.descriptionChanges.length === 0) continue;
    planned.push({ view, plan });
    for (const c of plan.groupChanges) {
      console.log(
        `${LOG_PREFIX} ${view.orderNumber} 房组 ${c.groupId || '(无 id)'}：` +
          `「${c.before.hotelName}」/「${c.before.roomType}」 → 「${c.after.hotelName}」/「${c.after.roomType}」`,
      );
    }
    for (const d of plan.descriptionChanges) {
      console.log(`${LOG_PREFIX} ${view.orderNumber} 行 ${d.itemId}：「${d.before}」 → 「${d.after}」`);
    }
  }

  const groupTotal = planned.reduce((n, p) => n + p.plan.groupChanges.length, 0);
  const descTotal = planned.reduce((n, p) => n + p.plan.descriptionChanges.length, 0);
  console.log(
    `${LOG_PREFIX} 扫描 ${scanned} 张候选单：需改 ${planned.length} 张（房组 ${groupTotal} 个 · 派生行 ${descTotal} 条）`,
  );
  if (skipReasons.size > 0) {
    console.log(`${LOG_PREFIX} 跳过原因汇总：`);
    for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${LOG_PREFIX}   ${count} 个 · ${reason}`);
    }
  }
  if (!opts.apply) {
    console.log(`${LOG_PREFIX} dry-run 结束，未写库。确认无误后加 --apply 真正写回。`);
    return;
  }
  if (planned.length === 0) {
    console.log(`${LOG_PREFIX} 没有需要改的单，不写库、不留档。`);
    return;
  }

  // 1. 先落备份文件（写不出来就不碰库）。
  const backup: BackupEntry[] = planned.map(({ view, plan }) => {
    const touchedItemIds = new Set(plan.descriptionChanges.map((d) => d.itemId));
    return {
      orderId: view.id,
      orderNumber: view.orderNumber,
      before: {
        roomAssignment: view.roomAssignment,
        items: view.items
          .filter((it) => touchedItemIds.has(it.id))
          .map((it) => ({ id: it.id, description: it.description })),
      },
      after: {
        roomAssignment: plan.roomAssignment ?? view.roomAssignment,
        items: plan.descriptionChanges.map((d) => ({ id: d.itemId, description: d.after })),
      },
      groupChanges: plan.groupChanges,
    };
  });
  writeFileSync(
    opts.backupPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), entries: backup }, null, 2),
    'utf8',
  );
  console.log(`${LOG_PREFIX} 备份已写：${opts.backupPath}（${backup.length} 张单的 before/after）`);

  // 2. 逐单事务写库。
  let applied = 0;
  for (const { view, plan } of planned) {
    await applyPlan(view, plan);
    applied += 1;
  }

  // 3. 审计留痕（after 带全量清单：谁、什么时候、把哪些房组 / 行从什么改成了什么）。
  await writeAudit({
    actor: { label: 'backfill-room-group-hotel-name', role: 'SYSTEM' },
    action: 'BACKFILL_ROOM_GROUP_HOTEL_NAME',
    targetType: 'ORDER',
    targetLabel: `分房表房组酒店名回填 · ${applied} 张单（房组 ${groupTotal} 个 · 派生行 ${descTotal} 条）`,
    after: {
      scanned,
      applied,
      groupChanges: groupTotal,
      descriptionChanges: descTotal,
      backupPath: opts.backupPath,
      limit: opts.limit ?? null,
      orderNumbers: opts.orderNumbers ?? null,
      skipReasons: Object.fromEntries(skipReasons),
      changes: planned.map(({ view, plan }) => ({
        orderNumber: view.orderNumber,
        groupChanges: plan.groupChanges,
        descriptionChanges: plan.descriptionChanges,
      })),
    },
    severity: 'WARNING',
  });

  console.log(`${LOG_PREFIX} 完成：写库 ${applied} 张单。`);
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
