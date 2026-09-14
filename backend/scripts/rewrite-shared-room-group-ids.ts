/**
 * 存量「房组 id 编码了共享房 id」的一次性改写脚本（astra B1）。
 *
 * 背景：跨单分房 saveSharedRooms 曾经把订单 JSON 里镜像的房组 id 写成
 * `shared:<sharedRoomId>:<orderItemId>` / `plain:<sharedRoomId>:<orderItemId>`——这个
 * sharedRoomId 是纯内部标识，房组 id 却经 room-group-dto.ts 的 serializeRoomGroupsFor
 * 原样透传给代理/客户视角，等于把内部共享房 id 泄露出去（AGENT 看到
 * `id: "shared:SHARED_SECRET:item-a"` 就能读出对方合住关系的内部标识）。
 * 服务端已改为生成不含任何关系信息的随机 id（见 hotel-control.shared-rooms.ts），本脚本
 * 把这次改动之前已经落库的存量房组 id 一次性改写掉。
 *
 * 只改一个字段：房组对象的 `id`（一律换成新的随机 uuid）。不碰 sharedRoomId、
 * orderItemId、passengerIds、roomFraction、notes、hotelName、roomType、splitPairKey
 * 等其它字段，不碰 SharedRoomMember 表（那张表不存这个 id），不碰任何金额/间数——
 * 纯粹的标识符换新，房控的物理间数聚合（groupBucketKey 按 `box:${orderId}:${id}` 分桶）
 * 是把旧 id 一对一换成新 id，桶的划分结构不变，不影响任何统计。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/rewrite-shared-room-group-ids.ts                # dry-run 全量预览（只读）
 *   npx tsx scripts/rewrite-shared-room-group-ids.ts --limit=20     # 只看前 20 条候选订单
 *   npx tsx scripts/rewrite-shared-room-group-ids.ts --apply        # 真正写回
 *
 * 参数：
 *   --apply     真正写库（不加 = dry-run，只读）
 *   --limit=N   只处理前 N 张候选订单（按建单时间升序），用于试水
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
 *       npx tsx scripts/rewrite-shared-room-group-ids.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/rewrite-shared-room-group-ids.ts --apply    # 核对无误再执行
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAudit } from '../src/lib/audit.js';

const LOG_PREFIX = '[rewrite-shared-room-group-ids]';
const LEGACY_ENCODED_ID_PREFIXES = ['shared:', 'plain:'];

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

function isLegacyEncodedId(id: unknown): id is string {
  return typeof id === 'string' && LEGACY_ENCODED_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** 防御式解析 roomAssignment.roomGroups；形状不符返回 null（原样跳过，不改写）。*/
function parseRoomGroups(roomAssignment: unknown): Array<Record<string, unknown>> | null {
  if (roomAssignment == null || typeof roomAssignment !== 'object') return null;
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups)) return null;
  return groups;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${apply ? '写库（--apply）' : 'dry-run（只读）'}`);

  // roomAssignment 是 Json 列，「id 是否带 shared:/plain: 前缀」没法用 Prisma where 表达，
  // 只能整表扫 roomAssignment 非空的订单，逐条在 JS 里判断。跨单分房存量数据规模不大
  // （功能刚上线），全表扫可接受；真上线体量变大再按需加 createdAt 游标分页。
  const orders = await prisma.order.findMany({
    where: { roomAssignment: { not: Prisma.JsonNull } },
    select: { id: true, orderNumber: true, roomAssignment: true },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  });

  let scannedOrders = 0;
  let candidateGroups = 0;
  let rewrittenOrders = 0;
  let rewrittenGroups = 0;
  /** 本次真正写下去的改写清单（--apply 时整份进审计的 after，事后可逐条核对/回溯）。*/
  const rewrittenLog: Array<{
    orderId: string;
    orderNumber: string;
    oldId: string;
    newId: string;
  }> = [];

  for (const order of orders) {
    const groups = parseRoomGroups(order.roomAssignment);
    if (!groups) continue;
    const legacyGroups = groups.filter((g) => isLegacyEncodedId(g.id));
    if (legacyGroups.length === 0) continue;

    scannedOrders += 1;
    candidateGroups += legacyGroups.length;
    const idMap: Array<{ oldId: string; newId: string }> = [];
    const newGroups = groups.map((g) => {
      if (!isLegacyEncodedId(g.id)) return g;
      const newId = randomUUID();
      idMap.push({ oldId: g.id, newId });
      return { ...g, id: newId };
    });

    for (const { oldId, newId } of idMap) {
      console.log(
        `${LOG_PREFIX} ${order.orderNumber}#${order.id} · ${oldId} → ${newId}` +
          (apply ? '' : '（dry-run，未写）'),
      );
    }

    if (!apply) continue;

    await prisma.order.update({
      where: { id: order.id },
      data: { roomAssignment: { roomGroups: newGroups } as unknown as Prisma.InputJsonValue },
    });
    rewrittenOrders += 1;
    rewrittenGroups += idMap.length;
    for (const { oldId, newId } of idMap) {
      rewrittenLog.push({ orderId: order.id, orderNumber: order.orderNumber, oldId, newId });
    }
  }

  // --apply 必留一条审计：事后要能回答「谁、什么时候、把哪些订单的哪个 id 换成了什么」。
  // 不是 CRITICAL——这是纯标识符换新，不动钱也不动房量，但仍值得留痕方便核对/回溯。
  if (apply && rewrittenLog.length > 0) {
    await writeAudit({
      actor: { label: 'rewrite-shared-room-group-ids', role: 'SYSTEM' },
      action: 'REWRITE_SHARED_ROOM_GROUP_IDS',
      targetType: 'ORDER',
      targetLabel: `房组 id 去敏改写 · ${rewrittenOrders} 张订单 / ${rewrittenGroups} 个房组`,
      after: {
        scannedOrders,
        rewrittenOrders,
        rewrittenGroups,
        limit: limit ?? null,
        // 全量清单进 after：核对或回滚时按 orderId 找回具体改了哪个 id。
        rewrites: rewrittenLog,
      },
      severity: 'WARNING',
    });
  }

  console.log(
    `${LOG_PREFIX} 完成：命中 ${scannedOrders} 张订单 / ${candidateGroups} 个旧式编码 id 的房组。` +
      (apply
        ? ` 已实际改写 ${rewrittenOrders} 张订单 / ${rewrittenGroups} 个房组。`
        : ' 确认无误后加 --apply 真正写回。'),
  );
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
