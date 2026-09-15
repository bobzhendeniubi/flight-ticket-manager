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
 * ⚠️ 本脚本不是、也不能充当跨单分房功能的业务回滚方案（astra N9）。它只换一个内部标识符，
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
 * 的最新 roomAssignment 重新判定哪些 id 还是旧式编码、只替换命中的 id、用展开旧对象再
 * 覆盖 roomGroups 的写法保留其它顶层字段，审计写入也挪进同一个事务（成功一起提交、失败
 * 一起回滚）——不再是一次性整表快照 + 事务外单独写审计。
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

/** 一张订单里旧式编码 id → 新随机 id 的改写记录。*/
interface IdRewrite {
  oldId: string;
  newId: string;
}

export interface RewriteSharedRoomGroupIdsResult {
  scannedOrders: number;
  candidateGroups: number;
  rewrittenOrders: number;
  rewrittenGroups: number;
  /** 本次真正写下去的改写清单（--apply 时用于总览审计的 after，事后可逐条核对/回溯）。*/
  rewrittenLog: Array<{ orderId: string; orderNumber: string; oldId: string; newId: string }>;
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

/**
 * 逐单一个独立事务（astra N9）：`FOR UPDATE` 锁住这一行、基于锁后最新的 roomAssignment
 * 重新判定，只替换命中的旧式编码 id，保留 roomAssignment 里的其它顶层字段，审计与业务
 * 写入同事务提交。
 *
 * 返回 null 的情形都是「这张单此刻不需要改写，安全跳过」，不是错误：
 *   · 订单在扫描之后、加锁之前已被删除；
 *   · 锁后重读发现 roomAssignment 已经没有旧式编码 id 了（可能是并发的业务写入已经把
 *     这一批组整体替换掉，也可能是这一刻它本就没有 roomGroups）。
 */
async function rewriteOneOrderTransactionally(
  client: PrismaClient,
  orderId: string,
): Promise<{ orderNumber: string; idMap: IdRewrite[] } | null> {
  return client.$transaction(async (tx) => {
    // 锁行——之后的读才是「这一刻」的最新状态，不是脚本启动时的旧快照。
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const fresh = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, roomAssignment: true },
    });
    if (!fresh) return null; // 订单已被删除
    const groups = parseRoomGroups(fresh.roomAssignment);
    if (!groups) return null;
    const legacyGroups = groups.filter((g) => isLegacyEncodedId(g.id));
    if (legacyGroups.length === 0) return null; // 已经被并发的业务写入处理掉，或此刻本就没有

    const idMap: IdRewrite[] = [];
    const newGroups = groups.map((g) => {
      if (!isLegacyEncodedId(g.id)) return g;
      const newId = randomUUID();
      idMap.push({ oldId: g.id as string, newId });
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

    // 逐单审计同事务（astra N9）：不是脚本跑完之后再补一条事务外的汇总审计，这一单的
    // before/after 与它的业务写入一起成功、一起回滚。
    await writeAuditWithinTx(tx, {
      actor: { label: 'rewrite-shared-room-group-ids', role: 'SYSTEM' },
      action: 'REWRITE_SHARED_ROOM_GROUP_IDS',
      targetType: 'ORDER',
      targetId: fresh.id,
      targetLabel: `${fresh.orderNumber} · 房组 id 去敏改写 ${idMap.length} 个`,
      before: { roomGroups: groups },
      after: { roomGroups: newGroups },
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
  // roomAssignment 是 Json 列，「id 是否带 shared:/plain: 前缀」没法用 Prisma where 表达，
  // 只能整表扫 roomAssignment 非空的订单，逐条在 JS 里判断。跨单分房存量数据规模不大
  // （功能刚上线），全表扫可接受；真上线体量变大再按需加 createdAt 游标分页。
  const orders = await client.order.findMany({
    where: { roomAssignment: { not: Prisma.JsonNull } },
    select: { id: true, orderNumber: true, roomAssignment: true },
    orderBy: { createdAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  let scannedOrders = 0;
  let candidateGroups = 0;
  let rewrittenOrders = 0;
  let rewrittenGroups = 0;
  const rewrittenLog: RewriteSharedRoomGroupIdsResult['rewrittenLog'] = [];

  for (const order of orders) {
    const groups = parseRoomGroups(order.roomAssignment);
    if (!groups) continue;
    const legacyGroups = groups.filter((g) => isLegacyEncodedId(g.id));
    if (legacyGroups.length === 0) continue;

    scannedOrders += 1;
    candidateGroups += legacyGroups.length;

    if (!opts.apply) {
      for (const g of legacyGroups) {
        console.log(
          `${LOG_PREFIX} ${order.orderNumber}#${order.id} · ${g.id}（dry-run，未写，实际改写时按锁后现状重判）`,
        );
      }
      continue;
    }

    const result = await rewriteOneOrderTransactionally(client, order.id);
    if (!result) continue; // 并发下这张单已经不需要改写，跳过
    rewrittenOrders += 1;
    rewrittenGroups += result.idMap.length;
    for (const { oldId, newId } of result.idMap) {
      console.log(`${LOG_PREFIX} ${result.orderNumber}#${order.id} · ${oldId} → ${newId}`);
      rewrittenLog.push({ orderId: order.id, orderNumber: result.orderNumber, oldId, newId });
    }
  }

  return { scannedOrders, candidateGroups, rewrittenOrders, rewrittenGroups, rewrittenLog };
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
      targetLabel: `房组 id 去敏改写汇总 · ${result.rewrittenOrders} 张订单 / ${result.rewrittenGroups} 个房组`,
      after: {
        scannedOrders: result.scannedOrders,
        rewrittenOrders: result.rewrittenOrders,
        rewrittenGroups: result.rewrittenGroups,
        limit: limit ?? null,
        rewrites: result.rewrittenLog,
      },
      severity: 'WARNING',
    });
  }

  console.log(
    `${LOG_PREFIX} 完成：命中 ${result.scannedOrders} 张订单 / ${result.candidateGroups} 个旧式编码 id 的房组。` +
      (apply
        ? ` 已实际改写 ${result.rewrittenOrders} 张订单 / ${result.rewrittenGroups} 个房组。`
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
