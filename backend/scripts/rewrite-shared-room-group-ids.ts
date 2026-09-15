/**
 * 存量「房组 id 编码了共享房 id」的一次性改写脚本（astra B1 / B-N1）。
 *
 * 背景：跨单分房 saveSharedRooms 曾经把订单 JSON 里镜像的房组 id 写成
 * `shared:<sharedRoomId>:<orderItemId>` / `plain:<sharedRoomId>:<orderItemId>`——这个
 * sharedRoomId 是纯内部标识，房组 id 却经 room-group-dto.ts 的 serializeRoomGroupsFor
 * 原样透传给代理/客户视角，等于把内部共享房 id 泄露出去（AGENT 看到
 * `id: "shared:SHARED_SECRET:item-a"` 就能读出对方合住关系的内部标识）。
 * 服务端已改为生成不含任何关系信息的随机 id（见 hotel-control.shared-rooms.ts），本脚本
 * 把这次改动之前已经落库的存量旧式编码 id 一次性改写掉，覆盖两处载体：
 *
 *   1. `Order.roomAssignment.roomGroups[].id`——房组对象自身的 id；
 *   2. `OrderItem.metadata.splitRoomGroup.roomGroupId`（astra B-N1）——按房组拆行
 *      （`splitHotelItemByRoomGroup`）时把「这个新行是从哪个房组拆出来的」写进新行的
 *      metadata 留痕，如果拆分发生在旧式编码 id 还在用的那段时间，这里存的也是一个
 *      旧式编码 id，同样是纯内部标识、同样经序列化透传给代理视角。这个字段只是一条历史
 *      breadcrumb（仓库里没有任何代码之后再拿它去反查当前 roomGroups——split 当时用
 *      `input.roomGroupId` 现查一次即用即弃，见 orders.service.ts 的
 *      splitHotelItemByRoomGroup），改写时不需要、也不能指望它与某个当前 roomGroups id
 *      对应，直接原地换成一个新的独立随机 id 即可。
 *
 * 只改这两处的 id 值本身。不碰 sharedRoomId、orderItemId、passengerIds、roomFraction、
 * notes、hotelName、roomType、splitPairKey 等其它字段，不碰 SharedRoomMember 表（那张表
 * 不存这个 id），不碰任何金额/间数——纯粹的标识符换新，房控的物理间数聚合（groupBucketKey
 * 按 `box:${orderId}:${id}` 分桶）是把旧 id 一对一换成新 id，桶的划分结构不变，不影响
 * 任何统计。
 *
 * ⚠️ 本脚本不是、也不能充当跨单分房功能的业务回滚方案（astra N9）。它只换内部标识符，
 * 不还原共享房保存前的成员表、JSON 房组结构、roomFraction 或 roomsBilled——业务出错需要
 * 回滚的话，得从审计日志（AuditLog，`UPDATE_ROOM_ASSIGNMENT` / `SAVE_SHARED_ROOMS` 等
 * action）里的 before 快照手工重建，或者从跑本脚本之前的整库备份恢复，不能靠重跑这个脚本
 * 撤销任何共享房保存的效果。
 *
 * astra N9（回归）：修复前的版本先整表快照，`--apply` 时无条件把整份 `roomAssignment`
 * 覆盖成 `{ roomGroups: newGroups }`——① 用的是脚本一开始读到的旧快照，不是写入那一刻的
 * 最新值，运营/代理在脚本运行期间对同一张单做的任何分房改动都会被这次覆盖悄悄冲掉；
 * ② `{ roomGroups: newGroups }` 丢弃了 roomAssignment 里除 roomGroups 之外的其它顶层字段
 * （如果将来有的话）。现在改成逐单一个独立事务：`FOR UPDATE` 锁住这一行、基于**这一刻**
 * 的最新 roomAssignment / OrderItem.metadata 重新判定哪些 id 还是旧式编码、只替换命中的
 * id、用展开旧对象再覆盖的写法保留其它字段，审计写入也挪进同一个事务（成功一起提交、
 * 失败一起回滚）——不再是一次性整表快照 + 事务外单独写审计。
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
import { fileURLToPath } from 'node:url';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAudit, writeAuditWithinTx } from '../src/lib/audit.js';

const LOG_PREFIX = '[rewrite-shared-room-group-ids]';
const LEGACY_ENCODED_ID_PREFIXES = ['shared:', 'plain:'];

interface CliOptions {
  apply: boolean;
  limit?: number;
}

/** 一处旧式编码 id → 新随机 id 的改写记录，`field` 标注命中的是哪个载体，方便日志与审计辨认。*/
interface IdRewrite {
  field: 'roomGroup' | 'itemMetadata';
  oldId: string;
  newId: string;
}

export interface RewriteSharedRoomGroupIdsResult {
  scannedOrders: number;
  candidateGroups: number;
  /** astra B-N1：命中的 OrderItem.metadata.splitRoomGroup.roomGroupId 旧式编码个数。*/
  candidateItemMetadata: number;
  rewrittenOrders: number;
  rewrittenGroups: number;
  rewrittenItemMetadata: number;
  /** 本次真正写下去的改写清单（--apply 时用于总览审计的 after，事后可逐条核对/回溯）。*/
  rewrittenLog: Array<{ orderId: string; orderNumber: string; field: IdRewrite['field']; oldId: string; newId: string }>;
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

/** 防御式解析 OrderItem.metadata.splitRoomGroup；形状不符返回 null（原样跳过，不改写）。*/
function parseSplitRoomGroup(metadata: unknown): Record<string, unknown> | null {
  if (metadata == null || typeof metadata !== 'object') return null;
  const split = (metadata as { splitRoomGroup?: unknown }).splitRoomGroup;
  if (split == null || typeof split !== 'object') return null;
  return split as Record<string, unknown>;
}

/**
 * 逐单一个独立事务（astra N9）：`FOR UPDATE` 锁住这一行、基于锁后最新的 roomAssignment
 * 与该单全部 OrderItem.metadata 重新判定，只替换命中的旧式编码 id，保留其它字段，审计与
 * 业务写入同事务提交。
 *
 * 返回 null 的情形都是「这张单此刻不需要改写，安全跳过」，不是错误：
 *   · 订单在扫描之后、加锁之前已被删除；
 *   · 锁后重读发现两处载体都已经没有旧式编码 id 了（可能是并发的业务写入已经处理掉，
 *     也可能是这一刻它们本就没有）。
 */
async function rewriteOneOrderTransactionally(
  client: PrismaClient,
  orderId: string,
): Promise<{ orderNumber: string; idMap: IdRewrite[] } | null> {
  return client.$transaction(async (tx) => {
    // 锁行——之后的读才是「这一刻」的最新状态，不是脚本启动时的旧快照。OrderItem 不单独
    // 加锁：本脚本的写入只发生在这个函数内部、且同样先经过这把 Order 锁才能推进，与
    // 其它写路径（下单/售后等）改这些 OrderItem 时是否也遵循「先锁 Order 再改行」的约定
    // 一致（跨单分房侧的约定见 hotel-control.shared-rooms.ts 的锁协议注释）。
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const fresh = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, roomAssignment: true },
    });
    if (!fresh) return null; // 订单已被删除

    const idMap: IdRewrite[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    // ── 1. Order.roomAssignment.roomGroups[].id ──────────────────────────────
    const groups = parseRoomGroups(fresh.roomAssignment);
    if (groups) {
      const legacyGroups = groups.filter((g) => isLegacyEncodedId(g.id));
      if (legacyGroups.length > 0) {
        const newGroups = groups.map((g) => {
          if (!isLegacyEncodedId(g.id)) return g;
          const newId = randomUUID();
          idMap.push({ field: 'roomGroup', oldId: g.id as string, newId });
          return { ...g, id: newId };
        });
        // 只替换 roomGroups，展开旧 roomAssignment 对象保留其它顶层字段（astra N9）——
        // 不是 `{ roomGroups: newGroups }` 整份覆盖。
        const baseAssignment: Record<string, unknown> =
          fresh.roomAssignment != null && typeof fresh.roomAssignment === 'object'
            ? (fresh.roomAssignment as Record<string, unknown>)
            : {};
        const nextAssignment = { ...baseAssignment, roomGroups: newGroups };
        await tx.order.update({
          where: { id: fresh.id },
          data: { roomAssignment: nextAssignment as unknown as Prisma.InputJsonValue },
        });
        before.roomGroups = groups;
        after.roomGroups = newGroups;
      }
    }

    // ── 2. OrderItem.metadata.splitRoomGroup.roomGroupId（astra B-N1）────────
    const items = await tx.orderItem.findMany({
      where: { orderId: fresh.id, metadata: { not: Prisma.JsonNull } },
      select: { id: true, metadata: true },
    });
    const itemMetadataBefore: Array<{ itemId: string; metadata: unknown }> = [];
    const itemMetadataAfter: Array<{ itemId: string; metadata: unknown }> = [];
    for (const item of items) {
      const split = parseSplitRoomGroup(item.metadata);
      if (!split || !isLegacyEncodedId(split.roomGroupId)) continue;
      const oldId = split.roomGroupId as string;
      const newId = randomUUID();
      idMap.push({ field: 'itemMetadata', oldId, newId });
      const baseMetadata =
        item.metadata != null && typeof item.metadata === 'object'
          ? (item.metadata as Record<string, unknown>)
          : {};
      const nextMetadata = { ...baseMetadata, splitRoomGroup: { ...split, roomGroupId: newId } };
      await tx.orderItem.update({
        where: { id: item.id },
        data: { metadata: nextMetadata as unknown as Prisma.InputJsonValue },
      });
      itemMetadataBefore.push({ itemId: item.id, metadata: item.metadata });
      itemMetadataAfter.push({ itemId: item.id, metadata: nextMetadata });
    }
    if (itemMetadataBefore.length > 0) {
      before.itemMetadata = itemMetadataBefore;
      after.itemMetadata = itemMetadataAfter;
    }

    if (idMap.length === 0) return null; // 两处载体锁后都没有旧式编码 id，安全跳过

    // 逐单审计同事务（astra N9）：不是脚本跑完之后再补一条事务外的汇总审计，这一单的
    // before/after 与它的业务写入一起成功、一起回滚。
    await writeAuditWithinTx(tx, {
      actor: { label: 'rewrite-shared-room-group-ids', role: 'SYSTEM' },
      action: 'REWRITE_SHARED_ROOM_GROUP_IDS',
      targetType: 'ORDER',
      targetId: fresh.id,
      targetLabel: `${fresh.orderNumber} · 房组/行 metadata id 去敏改写 ${idMap.length} 个`,
      before,
      after,
      severity: 'WARNING',
    });

    return { orderNumber: fresh.orderNumber, idMap };
  });
}

/**
 * 扫描 + （可选）改写主流程。dry-run 时只基于扫描阶段读到的快照打印预览，不加锁、不写库
 * （纯只读预览，谁的快照都无所谓）；`--apply` 时逐单走 rewriteOneOrderTransactionally。
 */
export async function rewriteSharedRoomGroupIds(
  client: PrismaClient,
  opts: CliOptions,
): Promise<RewriteSharedRoomGroupIdsResult> {
  // roomAssignment / metadata 都是 Json 列，「id 是否带 shared:/plain: 前缀」没法用 Prisma
  // where 表达，只能整表扫、逐条在 JS 里判断。跨单分房存量数据规模不大（功能刚上线），
  // 全表扫可接受；真上线体量变大再按需加 createdAt 游标分页。
  const orders = await client.order.findMany({
    where: { roomAssignment: { not: Prisma.JsonNull } },
    select: { id: true, orderNumber: true, roomAssignment: true },
    orderBy: { createdAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  });
  // astra B-N1：OrderItem.metadata.splitRoomGroup.roomGroupId 是独立的候选来源——一张单
  // 可能 roomAssignment 早就干净（比如从没建过共享房），却因为按房组拆行时留下的历史
  // metadata 仍带着旧式编码 id 而需要处理，两边扫描各自独立、结果按订单 id 合并去重。
  const itemsWithLegacyMetadata = await client.orderItem.findMany({
    where: { metadata: { not: Prisma.JsonNull } },
    select: { id: true, orderId: true, metadata: true },
  });

  const orderById = new Map(orders.map((o) => [o.id, o]));
  const candidateOrderIds = new Set<string>();
  let candidateGroups = 0;
  let candidateItemMetadata = 0;
  const previewByOrderId = new Map<string, string[]>(); // dry-run 展示用：orderId → 命中的旧 id 列表

  for (const order of orders) {
    const groups = parseRoomGroups(order.roomAssignment);
    if (!groups) continue;
    const legacyGroups = groups.filter((g) => isLegacyEncodedId(g.id));
    if (legacyGroups.length === 0) continue;
    candidateOrderIds.add(order.id);
    candidateGroups += legacyGroups.length;
    const preview = previewByOrderId.get(order.id) ?? [];
    preview.push(...legacyGroups.map((g) => `roomGroup:${g.id as string}`));
    previewByOrderId.set(order.id, preview);
  }
  for (const item of itemsWithLegacyMetadata) {
    const split = parseSplitRoomGroup(item.metadata);
    if (!split || !isLegacyEncodedId(split.roomGroupId)) continue;
    candidateOrderIds.add(item.orderId);
    candidateItemMetadata += 1;
    const preview = previewByOrderId.get(item.orderId) ?? [];
    preview.push(`itemMetadata:${split.roomGroupId as string}`);
    previewByOrderId.set(item.orderId, preview);
  }

  // --limit 语义：只处理前 N 张候选订单（按建单时间；roomAssignment 扫描已经按 createdAt
  // 排过序，itemMetadata 单独扫描出来的订单如果不在 orders 快照里，取不到 createdAt 排序
  // 位置——用「先出现在 orders 列表里的排前面，剩下的按发现顺序接在后面」这个近似顺序，
  // --limit 本来就只是试水用途，不追求精确的全局时间排序）。
  const orderedCandidateIds = [
    ...orders.map((o) => o.id).filter((id) => candidateOrderIds.has(id)),
    ...[...candidateOrderIds].filter((id) => !orderById.has(id)),
  ];
  const limitedCandidateIds =
    opts.limit != null ? orderedCandidateIds.slice(0, opts.limit) : orderedCandidateIds;

  let rewrittenOrders = 0;
  let rewrittenGroups = 0;
  let rewrittenItemMetadata = 0;
  const rewrittenLog: RewriteSharedRoomGroupIdsResult['rewrittenLog'] = [];

  for (const orderId of limitedCandidateIds) {
    const orderNumberForLog = orderById.get(orderId)?.orderNumber ?? orderId;

    if (!opts.apply) {
      for (const hit of previewByOrderId.get(orderId) ?? []) {
        console.log(`${LOG_PREFIX} ${orderNumberForLog}#${orderId} · ${hit}（dry-run，未写，实际改写时按锁后现状重判）`);
      }
      continue;
    }

    const result = await rewriteOneOrderTransactionally(client, orderId);
    if (!result) continue; // 并发下这张单已经不需要改写，跳过
    rewrittenOrders += 1;
    for (const { field, oldId, newId } of result.idMap) {
      if (field === 'roomGroup') rewrittenGroups += 1;
      else rewrittenItemMetadata += 1;
      console.log(`${LOG_PREFIX} ${result.orderNumber}#${orderId} · [${field}] ${oldId} → ${newId}`);
      rewrittenLog.push({ orderId, orderNumber: result.orderNumber, field, oldId, newId });
    }
  }

  return {
    scannedOrders: candidateOrderIds.size,
    candidateGroups,
    candidateItemMetadata,
    rewrittenOrders,
    rewrittenGroups,
    rewrittenItemMetadata,
    rewrittenLog,
  };
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${apply ? '写库（--apply）' : 'dry-run（只读）'}`);

  const result = await rewriteSharedRoomGroupIds(prisma, { apply, limit });

  // 额外的事务外汇总审计（best-effort）：方便一眼看到「这一次运行总共改了多少」，
  // 不是替代上面逐单事务内的审计——每一单的 before/after 已经在各自事务里落地。
  if (apply && result.rewrittenLog.length > 0) {
    await writeAudit({
      actor: { label: 'rewrite-shared-room-group-ids', role: 'SYSTEM' },
      action: 'REWRITE_SHARED_ROOM_GROUP_IDS',
      targetType: 'ORDER',
      targetLabel:
        `房组/行 metadata id 去敏改写汇总 · ${result.rewrittenOrders} 张订单 / ` +
        `${result.rewrittenGroups} 个房组 / ${result.rewrittenItemMetadata} 个行 metadata`,
      after: {
        scannedOrders: result.scannedOrders,
        rewrittenOrders: result.rewrittenOrders,
        rewrittenGroups: result.rewrittenGroups,
        rewrittenItemMetadata: result.rewrittenItemMetadata,
        limit: limit ?? null,
        rewrites: result.rewrittenLog,
      },
      severity: 'WARNING',
    });
  }

  console.log(
    `${LOG_PREFIX} 完成：命中 ${result.scannedOrders} 张订单 / ${result.candidateGroups} 个旧式编码房组 id / ` +
      `${result.candidateItemMetadata} 个旧式编码行 metadata id。` +
      (apply
        ? ` 已实际改写 ${result.rewrittenOrders} 张订单 / ${result.rewrittenGroups} 个房组 / ` +
          `${result.rewrittenItemMetadata} 个行 metadata。`
        : ' 确认无误后加 --apply 真正写回。'),
  );
}

// 只在直接执行本文件时跑 main()——被测试文件 import 时不应该连真库跑全套流程。
const isDirectlyExecuted =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectlyExecuted) {
  main()
    .catch((err) => {
      console.error(`${LOG_PREFIX} 失败：`, err);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
