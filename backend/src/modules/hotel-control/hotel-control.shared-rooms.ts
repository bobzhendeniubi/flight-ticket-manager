/**
 * 跨单分房（共享房）工作台 · 读 + 写（§七）。
 *
 * 真值优先级：SharedRoom / SharedRoomMember 表 > 订单 roomAssignment JSON——本文件的
 * saveSharedRooms 每次改成员表都同步重写涉及订单的 JSON，读侧（房控物理口径）见
 * hotel-control.service.ts 的 computeSharedRoomPhysicalByDate / assertHotelFitAfterChange。
 *
 * 待拍板口径（保守实现，未在方案里写死，见最终报告）：
 *   - SharedRoomMember.roomFraction 是「该订单该行在本间房的份额」，同一 group 内的多名
 *     乘客共享同一个值（都写这个数，不是人均再摊）；聚合 roomsBilled / Σ份额=1 校验按
 *     (orderId, orderItemId) 去重后再求和，避免同一 group 多名乘客把份额重复计。
 *   - 共享房组镜像进订单 JSON 后的 notes 是订单自己的本地备注（不与 SharedRoom.notes 双向同步）；
 *     §五单单端点「只允许改 notes」改的是这份订单本地拷贝。
 */
import {
  OrderItemKind,
  OrderStatus,
  Prisma,
  type Gender,
  type PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import type { AuditActor } from '../../lib/audit.js';
import { writeAuditWithinTx } from '../../lib/audit.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  COUNTED_STATUSES,
  assertHotelFitAfterChange,
  type PhysicalOccupancyItem,
  type SharedRoomAfterState,
} from './hotel-control.service.js';
import type { SaveSharedRoomsBody } from './hotel-control.schemas.js';

const MAX_LOCK_RETRIES = 3;

/** [checkIn, checkOut) 逐晚 YYYY-MM-DD（date-only 字符串算术，避免时区漂移）。*/
function expandNights(checkIn: string, checkOut: string): string[] {
  const start = new Date(`${checkIn}T00:00:00.000Z`).getTime();
  const end = new Date(`${checkOut}T00:00:00.000Z`).getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const nights = Math.round((end - start) / DAY_MS);
  return Array.from({ length: nights }, (_, i) =>
    new Date(start + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/** 份额 0.5 网格四舍五入，消除浮点尾数（1 - 0.5 - 0.5 应恰为 0，不是 1.11e-16）。*/
function roundFraction(n: number): number {
  return Math.round(n * 2) / 2;
}

// ── GET /hotel-control/shared-rooms/workbench ──────────────────────────────

export interface SharedRoomWorkbenchPassenger {
  id: string;
  fullName: string;
  chineseName: string | null;
  gender: Gender | null;
}

export interface SharedRoomWorkbenchOrderItem {
  id: string;
  hotelRoomTypeId: string;
  roomTypeName: string;
  roomsBilled: number | null;
  /** 当前所在位置：null=未分房；普通房组给 groupId；共享房给 sharedRoomId。*/
  currentGroupId: string | null;
  currentSharedRoomId: string | null;
}

export interface SharedRoomWorkbenchOrder {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  agentId: string | null;
  passengers: SharedRoomWorkbenchPassenger[];
  items: SharedRoomWorkbenchOrderItem[];
  /** 本单在本酒店本区间的房组是否已全部补齐 orderItemId 归属（§三：未补齐不能拉进共享房）。*/
  fullyAttributed: boolean;
}

export interface SharedRoomWorkbenchRoom {
  sharedRoomId: string;
  hotelRoomTypeId: string;
  version: number;
  notes: string | null;
  members: Array<{
    orderId: string;
    orderItemId: string;
    passengerId: string;
    roomFraction: number;
    /** 该成员所属订单当前状态（astra B6：前端据此把已取消/软删的历史成员标成不可操作、
     *  只读展示，而不是让运营对着一个看起来正常的姓名 chip 去拖拽/编辑却被后端 400）。*/
    orderStatus: OrderStatus;
    /** = 未软删 且 status ∈ COUNTED_STATUSES；与 hotel-control.service 的房控有效状态判定
     *  同一把尺。false 的成员仍然「有份」（物理占用与计费份额都不受影响，见 §四/§八），
     *  只是不能再作为「本次改动」的一部分被重新校验其订单有效性——原样重存时会走
     *  isUnchangedMember 的放行分支。*/
    isActive: boolean;
    /** 该成员所属订单号（供灰色只读 chip 显示"哪张单"，不是敏感信息——房控本就是内部
     *  ADMIN/STAFF 视图，不受 §十对外角色 DTO 的脱敏约束）。*/
    orderNumber: string;
    /** 姓名快照：失效（已取消/软删订单）的成员也要查得到，chip 才能显示人名而不是空白。
     *  直接走 SharedRoomMember → Passenger 的关系查，不经过按 COUNTED_STATUSES 过滤的
     *  订单池，所以不受订单是否有效影响。*/
    chineseName: string | null;
    name: string;
  }>;
}

export interface SharedRoomWorkbench {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  orders: SharedRoomWorkbenchOrder[];
  sharedRooms: SharedRoomWorkbenchRoom[];
}

/** 房组是否带 sharedRoomId 镜像字段（订单 JSON 侧判定，与 hotel-control.service 的口径一致）。*/
function groupSharedId(g: Record<string, unknown>): string | null {
  const v = g.sharedRoomId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function groupOrderItemId(g: Record<string, unknown>): string | null {
  const v = g.orderItemId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function groupId(g: Record<string, unknown>): string | null {
  const v = g.id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function parseRoomGroups(roomAssignment: unknown): Array<Record<string, unknown>> {
  if (roomAssignment == null || typeof roomAssignment !== 'object') return [];
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups)) return [];
  return groups.filter((g): g is Record<string, unknown> => g != null && typeof g === 'object');
}

/**
 * 跨单分房工作台读模型：本酒店本入住区间（精确匹配 checkIn/checkOut）内全部有效订单
 * 的乘客与酒店行、以及本区间既有的共享房列表。ADMIN/STAFF 用，供前端建工作台 UI（波 4）。
 */
export async function getSharedRoomWorkbench(
  hotelId: string,
  checkIn: string,
  checkOut: string,
  client: PrismaClient = defaultPrisma,
): Promise<SharedRoomWorkbench> {
  const checkInD = new Date(`${checkIn}T00:00:00.000Z`);
  const checkOutD = new Date(`${checkOut}T00:00:00.000Z`);

  const items = await client.orderItem.findMany({
    where: {
      hotelRoomType: { hotelId },
      hotelCheckIn: checkInD,
      hotelCheckOut: checkOutD,
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      id: true,
      roomsBilled: true,
      hotelRoomType: { select: { id: true, name: true } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          agentId: true,
          roomAssignment: true,
          passengers: {
            select: { id: true, fullName: true, chineseName: true, gender: true },
          },
        },
      },
    },
  });

  const ordersById = new Map<string, SharedRoomWorkbenchOrder>();
  for (const it of items) {
    const order = it.order;
    if (!order) continue;
    let entry = ordersById.get(order.id);
    if (!entry) {
      const groups = parseRoomGroups(order.roomAssignment);
      const attributed = groups.filter((g) => groupOrderItemId(g) != null).length;
      entry = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        agentId: order.agentId,
        passengers: order.passengers.map((p) => ({
          id: p.id,
          fullName: p.fullName,
          chineseName: p.chineseName,
          gender: p.gender,
        })),
        items: [],
        // 全部房组都带归属，或整单尚未分房（无房组）→ 视为「已就绪」；
        // 部分有归属部分没有 → 不完整，工作台需提示先在编辑器里补齐。
        fullyAttributed: groups.length === 0 || attributed === groups.length,
      };
      ordersById.set(order.id, entry);
    }
    const groups = parseRoomGroups(order.roomAssignment);
    const own = groups.filter((g) => groupOrderItemId(g) === it.id);
    const sharedGroup = own.find((g) => groupSharedId(g) != null);
    const plainGroup = own.find((g) => groupSharedId(g) == null);
    entry.items.push({
      id: it.id,
      hotelRoomTypeId: it.hotelRoomType?.id ?? '',
      roomTypeName: it.hotelRoomType?.name ?? '',
      roomsBilled: it.roomsBilled == null ? null : Number(it.roomsBilled.toString()),
      currentGroupId: plainGroup ? groupId(plainGroup) : null,
      currentSharedRoomId: sharedGroup ? groupSharedId(sharedGroup) : null,
    });
  }

  const sharedRoomRows = await client.sharedRoom.findMany({
    where: { hotelId, checkIn: checkInD, checkOut: checkOutD, status: 'ACTIVE' },
    select: {
      id: true,
      hotelRoomTypeId: true,
      version: true,
      notes: true,
      members: {
        select: {
          orderId: true,
          orderItemId: true,
          passengerId: true,
          roomFraction: true,
          // astra B6：成员所属订单的当前状态——工作台读模型本就查不到「订单池」以外的
          // 单（getSharedRoomWorkbench 的主查询按 COUNTED_STATUSES 过滤），共享房的成员
          // 却不受这道过滤限制，会带出已取消/软删的历史成员。前端需要这两个字段来把它们
          // 标成只读，不能让运营对着一个看起来正常的姓名 chip 操作却被保存接口 400。
          order: { select: { status: true, deletedAt: true, orderNumber: true } },
          // 姓名快照：直接走 SharedRoomMember → Passenger 的关系查（不经过按
          // COUNTED_STATUSES 过滤的订单池），失效订单的成员也查得到，灰色 chip 才有人名
          // 可显示，不是空白。
          passenger: { select: { fullName: true, chineseName: true } },
        },
      },
    },
  });

  return {
    hotelId,
    checkIn,
    checkOut,
    orders: [...ordersById.values()],
    sharedRooms: sharedRoomRows.map((r) => ({
      sharedRoomId: r.id,
      hotelRoomTypeId: r.hotelRoomTypeId,
      version: r.version,
      notes: r.notes,
      members: r.members.map((m) => ({
        orderId: m.orderId,
        orderItemId: m.orderItemId,
        passengerId: m.passengerId,
        roomFraction: Number(m.roomFraction.toString()),
        orderStatus: m.order.status,
        isActive: m.order.deletedAt == null && COUNTED_STATUSES.includes(m.order.status),
        orderNumber: m.order.orderNumber,
        chineseName: m.passenger.chineseName,
        name: m.passenger.fullName,
      })),
    })),
  };
}

// ── PUT /hotel-control/shared-rooms ─────────────────────────────────────────

export interface SaveSharedRoomsResult {
  rooms: Array<{ sharedRoomId: string; version: number }>;
  dissolved: string[];
  warnings: string[];
}

/**
 * 单张受影响订单的分房审计负载（§七：每张涉及订单各写一条 UPDATE_ROOM_ASSIGNMENT，
 * before/after 带 roomAssignment 与 roomsBilled；after 另带 sharedRoomId + 同房其它订单号——
 * 这是内部审计，允许带对方单号，不受 §十对外角色 DTO 的脱敏约束）。
 */
interface OrderRoomAssignmentAuditPayload {
  orderId: string;
  orderNumber: string;
  beforeRoomAssignment: unknown;
  /** itemId → 变更前 roomsBilled（null=该行落库前也是 null）。*/
  beforeRoomsBilled: Record<string, number | null>;
  afterRoomAssignment: unknown;
  /** itemId → 变更后 roomsBilled（本次显式回写到的每一行）。*/
  afterRoomsBilled: Record<string, number>;
  /** sharedRoomId → 同房其它订单号（本单参与的每一间共享房各一条）。*/
  sharedRooms: Record<string, string[]>;
  /**
   * H1 修复：本单本次受「共享房 Σ有效份额=0」影响的提示（②——逐单审计 after 带这条，
   * 不止响应 warnings 一处）。没有命中时不带这个字段（避免给绝大多数正常保存的审计记录
   * 添噪音）。
   */
  orphanedSharedRoomWarnings?: string[];
}

/** 一次事务内的订单快照（锁后重读）。*/
interface LockedOrderRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  deletedAt: Date | null;
  roomAssignment: unknown;
  passengerIds: Set<string>;
  items: Array<{
    id: string;
    kind: OrderItemKind;
    hotelRoomTypeId: string | null;
    hotelCheckIn: Date | null;
    hotelCheckOut: Date | null;
    hotelId: string | null;
    randomStarTier: number | null;
    metadata: unknown;
    /** 落库前的 roomsBilled 快照（审计 before 用）。*/
    roomsBilled: number | null;
  }>;
}

async function loadLockedOrders(
  tx: Prisma.TransactionClient,
  orderIds: readonly string[],
): Promise<Map<string, LockedOrderRow>> {
  const rows = await tx.order.findMany({
    where: { id: { in: [...orderIds] } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      deletedAt: true,
      roomAssignment: true,
      passengers: { select: { id: true } },
      items: {
        select: {
          id: true,
          kind: true,
          hotelRoomTypeId: true,
          hotelCheckIn: true,
          hotelCheckOut: true,
          randomStarTier: true,
          metadata: true,
          roomsBilled: true,
          hotelRoomType: { select: { hotelId: true } },
        },
      },
    },
  });
  const out = new Map<string, LockedOrderRow>();
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      orderNumber: r.orderNumber,
      status: r.status,
      deletedAt: r.deletedAt,
      roomAssignment: r.roomAssignment,
      passengerIds: new Set(r.passengers.map((p) => p.id)),
      items: r.items.map((it) => ({
        id: it.id,
        kind: it.kind,
        hotelRoomTypeId: it.hotelRoomTypeId,
        hotelCheckIn: it.hotelCheckIn,
        hotelCheckOut: it.hotelCheckOut,
        hotelId: it.hotelRoomType?.hotelId ?? null,
        randomStarTier: it.randomStarTier,
        metadata: it.metadata,
        roomsBilled: it.roomsBilled == null ? null : Number(it.roomsBilled.toString()),
      })),
    });
  }
  return out;
}

/**
 * §六步骤 3 的重试信号（astra A9）：锁后重读成员表发现候选订单集合比锁住的还大，绝不能在
 * 已持有的锁之上再对新出现的订单补锁——两个事务各自持有一部分候选、又都在等对方已经
 * 锁住的那部分，是标准的死锁成环写法。正确做法是让整个事务回滚重开，锁全部释放后，
 * 下一次尝试用刷新后的候选集合重新按 id 升序锁一遍。这个专用错误类型只用来传递「请
 * 整个事务重来」这个信号，不代表业务失败。
 */
class SharedRoomLockSetExpandedError extends Error {
  constructor() {
    super('共享房锁集合在加锁过程中扩大，需整个事务重试');
    this.name = 'SharedRoomLockSetExpandedError';
  }
}

/**
 * §六步骤 1-3（单次尝试，事务内不自行重试）：候选订单集合（初始订单 ∪ 触及共享房当前的
 * 成员订单）→ 按 id 升序逐个 `SELECT … FOR UPDATE` → 锁后重读成员表核实集合没有扩大。
 * 扩大了就抛 SharedRoomLockSetExpandedError，交给外层 runWithLockSetRetry 整个事务重开，
 * 而不是在这次事务里继续对新出现的订单补锁。
 */
async function lockAffectedOrdersOnce(
  tx: Prisma.TransactionClient,
  initialOrderIds: ReadonlySet<string>,
  touchedSharedRoomIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const candidate = new Set(initialOrderIds);
  if (touchedSharedRoomIds.size > 0) {
    const members = await tx.sharedRoomMember.findMany({
      where: { sharedRoomId: { in: [...touchedSharedRoomIds] } },
      select: { orderId: true },
    });
    for (const m of members) candidate.add(m.orderId);
  }
  for (const orderId of [...candidate].sort()) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  }
  if (touchedSharedRoomIds.size > 0) {
    const membersAfterLock = await tx.sharedRoomMember.findMany({
      where: { sharedRoomId: { in: [...touchedSharedRoomIds] } },
      select: { orderId: true },
    });
    for (const m of membersAfterLock) {
      if (!candidate.has(m.orderId)) throw new SharedRoomLockSetExpandedError();
    }
  }
  return candidate;
}

/**
 * 跑一次可能因「锁集合扩大」而需要整个事务重开的操作，最多重试 MAX_LOCK_RETRIES 次
 * （astra A9）。重试耗尽仍不稳定 → 409，绝不允许在这种状态下继续提交（“重试耗尽还直接
 * 返回”是原实现的另一个问题：locked 拿到手就返回，从没真正跑满 3 次判定过稳定与否）。
 */
async function runWithLockSetRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_LOCK_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt >= MAX_LOCK_RETRIES;
      if (err instanceof SharedRoomLockSetExpandedError) {
        if (isLastAttempt) {
          throw new ConflictError('跨单分房涉及的订单集合在保存过程中持续变化，请刷新后重试');
        }
        continue;
      }
      throw err;
    }
  }
  /* istanbul ignore next -- 上面循环要么 return 要么 throw，这里纯粹满足 TS 控制流分析 */
  throw new ConflictError('跨单分房涉及的订单集合在保存过程中持续变化，请刷新后重试');
}

/**
 * 房组的计费份额——**只对 nullish（null / 省略）** 回落成缺省值（共享组缺省 0、普通组
 * 缺省 1，与 hotel-control.service 的 groupRoomFraction 同口径，旧客户端省略字段时的
 * 兼容行为）。显式数值（含 0）一律原样保留，不分共享组还是普通组：共享组的显式 0 是主单
 * 让份的明确值；普通组的显式 0 是解绑后留下的「与他单合住时计费 0 间」的历史值，重存时
 * 不能被这条兜底悄悄改回 1（astra A5②）。
 *
 * astra N12（回归）：曾经先 `Number(g.roomFraction)` 再判断——`Number(null) === 0` 与
 * `Number(0) === 0` 无法区分，普通组的 `roomFraction: null`（真正「没有显式值」的历史
 * 数据）会被这条兜底误判成「显式 0」，读出 0 而不是缺省的 1。必须先看原始值是不是
 * nullish，再决定要不要 `Number()` 转换。
 */
export function readBillingFraction(g: Record<string, unknown>): number {
  const raw = g.roomFraction;
  const fallback = groupSharedId(g) != null ? 0 : 1;
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 幂等占位哨兵：`sharedRoomRequest.create` 先写这个值占住 requestToken，跑完真正的业务逻辑
 * 才会被最终结果覆盖。resultJson 列是必填 Json（非 nullable），不能用 SQL NULL 当哨兵，
 * 所以用一个真结果永远不会长这样的形状（finalResult 恒有 rooms/dissolved/warnings 三个键，
 * 从不带 __pending）来判定「这行是不是还没跑完」。
 */
export const PENDING_SENTINEL = { __pending: true } as const;
function isPendingSentinel(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).__pending === true;
}

/**
 * 占位超过这个时长仍是 PENDING_SENTINEL → 视为孤儿占位（进程在占位后、写出真结果前崩溃，
 * 没有走到 catch 里的清理逻辑），允许同一个 requestToken 被重新占用重跑（astra A12）。
 * 10 分钟是「跨单分房这一次保存」正常耗时的极大冗余（正常应在秒级完成），不会误伤真正
 * 还在处理中的请求；也不宜设得更短——太短会在偶发的慢查询/长事务窗口里出现两个进程
 * 都判定「已超时」抢占同一个 token（虽然下面的按 id 精确删除保证了这种情况下只有一个能
 * 抢占成功，另一个会拿到「仍在处理中」提示，不会双写）。
 */
const PENDING_STALE_TIMEOUT_MS = 10 * 60 * 1000;
/** 幂等占位重新抢占的重试上限：初次尝试 + 抢占一次孤儿占位后的重试，两次封顶。 */
const MAX_RESERVE_ATTEMPTS = 2;

/** 导出仅供单测直接驱动 CAS 分支（astra N10），不是给业务调用方用的公共 API。*/
export interface ReserveOutcome {
  /** 非 null = 直接回放这个结果（同 token 同指纹的正常重放），调用方不必再跑业务逻辑。*/
  replay: SaveSharedRoomsResult | null;
  /**
   * 非 null = 这次调用真正拿到的占位行主键（cuid，与 requestToken 分离，见 astra N10）。
   * `replay` 非 null 时恒为 null——回放路径没有新占位，不该有所有权可言。业务写入完成后
   * 的最终结果写入、以及失败时的占位清理，都必须绑定这个 id，不能再用 requestToken：
   * requestToken 在「孤儿占位被抢占」后会指向一张全新的行（新 id），旧持有者若还在用
   * requestToken 做条件，就会误伤新占位的行。
   */
  reservationId: string | null;
}

/**
 * §六幂等占位（单独抽出便于说清楚每条分支）：requestToken 唯一，先占位再算——占位成功
 * 就是「这次是第一次跑」，占位失败（唯一键冲突）说明已有记录，按指纹决定回放/冲突/抢占。
 */
export async function reserveRequestOrReplay(
  client: PrismaClient,
  body: SaveSharedRoomsBody,
  fingerprint: string,
): Promise<ReserveOutcome> {
  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
    try {
      const created = await client.sharedRoomRequest.create({
        data: { requestToken: body.requestToken, fingerprint, resultJson: PENDING_SENTINEL },
        select: { id: true },
      });
      return { replay: null, reservationId: created.id };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;

      const existing = await client.sharedRoomRequest.findUnique({
        where: { requestToken: body.requestToken },
      });
      if (!existing) {
        // 刚才冲突时那一行还在、现在读又没了——多半是另一进程的失败清理正好插在中间。
        // 不是我们能处理的稳定状态，回到循环顶部重新尝试占位（占位的 create 本身是原子的）。
        continue;
      }
      if (existing.fingerprint !== fingerprint) {
        throw new ConflictError('该请求编号已用于另一次不同的跨单分房保存，请刷新后重试');
      }
      if (!isPendingSentinel(existing.resultJson)) {
        return { replay: existing.resultJson as unknown as SaveSharedRoomsResult, reservationId: null };
      }
      // 走到这里：同 token 同指纹、且仍是 PENDING——上一次占位还没写出真结果。
      const ageMs = Date.now() - existing.createdAt.getTime();
      if (ageMs < PENDING_STALE_TIMEOUT_MS) {
        // 大概率真的还在处理中（或极端竞态下清理没删干净）。不能当「已经成功」回放，
        // 也不建议换新 token——换号只会让这个尚未结束的首次请求和新请求同时执行，
        // 提示调用方稍后用同一个 token 重试才是安全的（astra A12）。
        throw new ConflictError('该请求编号上一次保存尚未完成，请稍后使用同一请求编号重试');
      }
      // 超过孤儿占位超时——按 id + 仍为 PENDING 的条件 CAS 删除（astra N10 回归）：只按
      // requestToken + id 删不够——如果就在我们读到 existing 之后、真正执行删除之前，
      // 它原来的持有者（其实没死，只是慢）刚好写完真结果，这一行的 resultJson 已经从
      // PENDING_SENTINEL 变成真正的业务结果，此时按 id 删还是会把这个「刚成功」的记录删掉，
      // 原持有者的完整占位历史凭空消失。加上 `resultJson: { equals: PENDING_SENTINEL }`
      // 让这次删除成为一次条件 CAS：仍是 PENDING 才真的删得掉；已经被原持有者写完的情况下，
      // 删除影响 0 行，回落到下面的「仍在处理中」提示，调用方用同一个 token 再试一次就能
      // 读到原持有者的真实结果。
      const reclaimed = await client.sharedRoomRequest.deleteMany({
        where: {
          requestToken: body.requestToken,
          id: existing.id,
          resultJson: { equals: PENDING_SENTINEL },
        },
      });
      if (reclaimed.count === 0) {
        throw new ConflictError('该请求编号上一次保存尚未完成，请稍后使用同一请求编号重试');
      }
      // 抢占成功，continue 到循环顶部重新 create。
    }
  }
  throw new ConflictError('该请求编号处理竞争过多，请刷新后重试');
}

export async function saveSharedRooms(
  body: SaveSharedRoomsBody,
  actor: AuditActor,
  client: PrismaClient = defaultPrisma,
): Promise<SaveSharedRoomsResult> {
  const fingerprint = canonicalJson({
    hotelId: body.hotelId,
    checkIn: body.checkIn,
    checkOut: body.checkOut,
    expectedVersions: body.expectedVersions ?? {},
    rooms: body.rooms,
    dissolve: body.dissolve,
  });

  const reservation = await reserveRequestOrReplay(client, body, fingerprint);
  if (reservation.replay) return reservation.replay;
  // reservation.replay 为 null 时 reserveRequestOrReplay 恒返回非 null 的 reservationId
  // （见 ReserveOutcome 的接口注释）——两者互斥，这里非空断言反映的是该函数自身的契约，
  // 不是绕过类型检查。
  const reservationId = reservation.reservationId!;

  // 占位成功之后，本函数任何一步失败（400/409/其它异常）都必须把占位行删掉：否则占位行的
  // resultJson 停在 PENDING_SENTINEL，下次同 token 同指纹重试会被判定「仍在处理中」白等到
  // 超时窗口，或者（改指纹）直接 409——都不是「重新跑一遍」。按 id（不是 requestToken）
  // 删除（astra N10）：如果这次占位已经被别的进程判定超时、抢占并重建（新 id、同
  // requestToken），按 requestToken 删会误删新占位的行；按自己的 id 删，抢占已发生时
  // 这里天然影响 0 行，不会牵连无关的新占位。
  try {
    return await saveSharedRoomsInner(body, actor, client, reservationId);
  } catch (err) {
    // 最佳努力清理占位——删失败也不能吞掉原始错误，原始错误才是调用方需要看到的。
    await client.sharedRoomRequest.deleteMany({ where: { id: reservationId } }).catch(() => {});
    throw err;
  }
}

async function saveSharedRoomsInner(
  body: SaveSharedRoomsBody,
  actor: AuditActor,
  client: PrismaClient,
  reservationId: string,
): Promise<SaveSharedRoomsResult> {
  const checkInD = new Date(`${body.checkIn}T00:00:00.000Z`);
  const checkOutD = new Date(`${body.checkOut}T00:00:00.000Z`);
  const nightDates = expandNights(body.checkIn, body.checkOut);
  if (nightDates.length === 0) throw new BadRequestError('入住日必须早于退房日');

  const hotel = await client.hotel.findUnique({
    where: { id: body.hotelId },
    select: { id: true, randomTierPlaceholder: true },
  });
  if (!hotel) throw new NotFoundError('酒店不存在');
  if (hotel.randomTierPlaceholder != null) {
    throw new BadRequestError('占位酒店不参与跨单分房，请先把随机档落位到真实酒店');
  }

  const roomIdsBeingSaved = new Set(
    body.rooms.map((r) => r.sharedRoomId).filter((v): v is string => !!v),
  );
  const dissolveSet = new Set(body.dissolve);
  // rooms 与 dissolve 不许重叠（astra A3）：同一请求里既要保留/更新一间房、又要解散它，
  // 语义自相矛盾——不判的话哪一段先跑就决定了最终状态，是隐藏的执行顺序依赖。
  for (const roomId of dissolveSet) {
    if (roomIdsBeingSaved.has(roomId)) {
      throw new BadRequestError(`共享房 ${roomId} 同时出现在 rooms 与 dissolve 中，一次请求只能二选一`);
    }
  }

  // rooms 与 dissolve 里客户端明确点名的共享房（过 expectedVersions CAS 的那批）。
  const explicitTouchedSharedRoomIds = new Set<string>([...roomIdsBeingSaved, ...dissolveSet]);
  const initialOrderIds = new Set<string>(body.rooms.flatMap((r) => r.groups.map((g) => g.orderId)));
  // 本次请求认领的全部乘客——用来发现「请求没提，但乘客正被从里面拽走」的旧共享房
  // （astra A6②，下面在事务内按它查隐式触及的房间）。
  const allRequestedPassengerIds = new Set<string>(
    body.rooms.flatMap((r) => r.groups.flatMap((g) => g.passengerIds)),
  );

  const result = await runWithLockSetRetry(() => client.$transaction(async (tx) => {
    // 隐式触及的旧共享房（astra A6②）：请求没有点名它，但本次认领的某个乘客眼下正挂在
    // 「本酒店本区间」的这间房里。不把它纳入锁与清理范围，会留下两个坑——
    //   · 这个乘客在原订单 JSON 里的旧共享组会被下面 kept 过滤器正常收窄/丢弃（narrowing
    //     分支不看 sid 是否在 touched 集合里），但 SharedRoomMember 表里对应的行永远不删，
    //     变成指向「JSON 已经不认它」的孤儿引用，物理去重口径会一直把这个乘客算进旧房；
    //   · 旧房的 version 永远不涨，membership 却在变，等于绕开了整套 CAS 协议。
    // 只在「本酒店本区间」匹配的范围内找——乘客可能在别的酒店/别的行程也挂着别的共享房，
    // 那些与本次请求无关，不该被牵连进来。
    //
    // 这一步查询发生在任何锁之前，结果只是「候选」，不是定论（astra N5：下面锁完之后会
    // 重新核实一遍，见 lockAffectedOrdersOnce 调用之后的复查）——**不要**在这里改成先给
    // initialOrderIds 加锁再查：两个并发请求各自只锁自己请求里明确点名的那部分订单、彼此
    // 顺序不一致时，会与下面按统一排序锁完整候选集合的做法相冲突，人为制造出锁序不一致的
    // 死锁（试过，真会死锁：见集成测试「并发交错提交不死锁」）。全局锁序必须只有一处
    // 决定——按 lockAffectedOrdersOnce 内部「候选集合排序后逐个锁」这一处，不能在它之前
    // 再插一次单独排序的锁。
    const implicitRoomIds = new Set<string>();
    if (allRequestedPassengerIds.size > 0) {
      const implicitMemberships = await tx.sharedRoomMember.findMany({
        where: {
          passengerId: { in: [...allRequestedPassengerIds] },
          sharedRoomId: { notIn: [...explicitTouchedSharedRoomIds] },
          sharedRoom: { hotelId: body.hotelId, checkIn: checkInD, checkOut: checkOutD, status: 'ACTIVE' },
        },
        select: { sharedRoomId: true },
      });
      for (const m of implicitMemberships) implicitRoomIds.add(m.sharedRoomId);
    }
    const touchedSharedRoomIds = new Set<string>([...explicitTouchedSharedRoomIds, ...implicitRoomIds]);

    const lockedOrderIds = await lockAffectedOrdersOnce(tx, initialOrderIds, touchedSharedRoomIds);

    // 锁后重新发现隐式房（astra N5 回归修复）：上面那次查询是锁前的候选，
    // lockAffectedOrdersOnce 内部只核实「已经发现的 touchedSharedRoomIds 里成员有没有
    // 变多」，从来不会发现「一开始就没发现的房间」——如果就在上面查完之后、这里锁到之前，
    // 本次认领的乘客被另一个并发请求挪去了一间我们完全没发现的第三间房，我们既不会锁那
    // 间房、也不会在下面清理它对这些乘客的成员表引用，留下孤儿引用。
    //
    // 现在锁已经拿到手：lockedOrderIds ⊇ initialOrderIds，这些乘客全部归属
    // initialOrderIds 里的订单（body.rooms 的 g.orderId），而任何想把这些乘客挪进/挪出
    // 一间共享房的并发写入，同样要把这些订单纳入它自己的 initialOrderIds、同样要走这个
    // 函数、同样要先抢到这些订单的 Order 锁——换句话说，我们锁住这些订单的那一刻起，这些
    // 乘客的共享房归属就已经冻结了。这里用锁后的最新状态重新查一遍隐式房，只在真发现了
    // 锁前那次查询没有覆盖到的新房间时才抛 SharedRoomLockSetExpandedError 交给外层整个
    // 事务重试（该房间下一轮会被正确纳入 touched 并锁上）；查询本身很轻，允许每次都重查，
    // 不必用「变了没有」的增量判断去省这一次查询。
    if (allRequestedPassengerIds.size > 0) {
      const recheckedMemberships = await tx.sharedRoomMember.findMany({
        where: {
          passengerId: { in: [...allRequestedPassengerIds] },
          sharedRoomId: { notIn: [...explicitTouchedSharedRoomIds] },
          sharedRoom: { hotelId: body.hotelId, checkIn: checkInD, checkOut: checkOutD, status: 'ACTIVE' },
        },
        select: { sharedRoomId: true },
      });
      for (const m of recheckedMemberships) {
        if (!implicitRoomIds.has(m.sharedRoomId)) throw new SharedRoomLockSetExpandedError();
      }
    }

    const orders = await loadLockedOrders(tx, [...lockedOrderIds]);

    // 订单集合稳定后，按 SharedRoom id 升序显式锁共享房行（astra A9：原实现直到落库段的
    // UPDATE 才隐式锁住 SharedRoom，CAS 版本判定发生在锁之前，两个并发请求能同时读到
    // 「版本对得上」再各自提交）。全局加锁顺序固定为 Order（已锁）→ SharedRoom（这里）→
    // 酒店包房周期（assertHotelFitAfterChange 内部最后才锁），三层各自升序，不交叉等待。
    for (const roomId of [...touchedSharedRoomIds].sort()) {
      await tx.$queryRaw`SELECT id FROM "SharedRoom" WHERE id = ${roomId} FOR UPDATE`;
    }

    // ── expectedVersions CAS：先于业务校验判——版本对不上就是「这把牌已经不是你看到的那把」──
    const currentSharedRooms = await tx.sharedRoom.findMany({
      where: { id: { in: [...touchedSharedRoomIds] } },
      select: { id: true, version: true, hotelId: true, checkIn: true, checkOut: true, status: true },
    });
    const currentById = new Map(currentSharedRooms.map((r) => [r.id, r]));
    for (const roomId of touchedSharedRoomIds) {
      const current = currentById.get(roomId);
      if (!current) throw new NotFoundError(`共享房 ${roomId} 不存在`);
      if (implicitRoomIds.has(roomId)) {
        // 隐式触及的房间（astra A6②）：客户端根本不知道它存在，不能要求 expectedVersions；
        // 也不因为它并发被解散/挪了日期就报错整次保存——现状已经不是「活跃」就跳过它，
        // 不勉强摘成员（下面落库段和上面 nextSharedRooms 都已按 currentById 的最新状态
        // 决定是否还需要处理它）。这条房间不参与后面「不在 dissolve 里就要求 ACTIVE+
        // 日期一致」的严格校验——那是给客户端明确点名要更新的房间用的。
        continue;
      }
      const expected = body.expectedVersions?.[roomId];
      if (expected == null || expected !== current.version) {
        throw new ConflictError('该房间已被他人修改，请刷新后重试');
      }
      if (current.hotelId !== body.hotelId) {
        throw new BadRequestError(`共享房 ${roomId} 不属于本酒店`);
      }
      // 会被保留/更新的房间（不在本次 dissolve 列表里）：锁内强制校验 ACTIVE + 入住区间与
      // 本次请求完全一致（astra A3）——否则「更新」一间已解散的房会把它悄悄复活成幽灵房
      // （成员/JSON 重新写入，SharedRoom.status 却仍是 DISSOLVED，两套聚合口径都跳过它，
      // 实际住宿计成 0）；或者把一间旧日期的房套用到新日期的订单行上，落库后房控仍按
      // 旧日期计物理占用，逃过新日期那晚的前瞻闸。不一致一律拒绝，逼调用方新建 + 解散旧房，
      // 而不是借「更新」悄悄挪日期/复活。
      if (!dissolveSet.has(roomId)) {
        if (current.status !== 'ACTIVE') {
          throw new BadRequestError(`共享房 ${roomId} 已解散，不能更新，请新建一间房`);
        }
        if (
          current.checkIn.getTime() !== checkInD.getTime() ||
          current.checkOut.getTime() !== checkOutD.getTime()
        ) {
          throw new BadRequestError(
            `共享房 ${roomId} 的入住区间与本次请求不一致，不能借更新挪动日期，请新建一间房后解散旧房`,
          );
        }
      }
    }

    // ── 未变更成员放行（astra B6）：工作台读模型把共享房的全部成员原样列出，包括所属
    // 订单已取消/软删的历史成员（那些成员在物理占用上仍然「有份」，见 §四「主单取消、
    // 只剩 0 份额成员」）。前端把整间房原样提交回来（哪怕只是改了别的成员），若严格要求
    // 每个成员所属订单都处于房控有效状态，这类历史成员会让整次保存 400——运营连房间里
    // 别的正常改动都保存不了。做法：对「本次改动到的既有房间」，逐 (orderId, orderItemId)
    // 比对——passengerIds 与 roomFraction 都和落库现状一模一样才算「未变更」，未变更的
    // 成员放行订单有效状态校验（其余结构性校验——订单行归属/酒店/日期一致——仍然照做，
    // 那些和订单是否取消无关）。新建房没有「落库现状」可比，不适用这条豁免。
    //
    // 选择记录（供前端修复批对齐）：这里选的是「未变更放行」，不是「未列出即不动」——
    // 本函数的更新语义本就是「listed 决定最终成员」（deleteMany 后按 room.groups 重建），
    // 若改成「未列出即不动」需要额外区分「乘客被移出」与「乘客只是没在这次 payload 里」，
    // 与现有解绑/迁出逻辑（依赖「未出现 = 移出」判定 kept/丢弃）冲突面更大。
    const currentMembersByRoom = new Map<
      string,
      Map<string, { passengerIds: Set<string>; fraction: number }>
    >();
    if (touchedSharedRoomIds.size > 0) {
      const existingMembers = await tx.sharedRoomMember.findMany({
        where: { sharedRoomId: { in: [...touchedSharedRoomIds] } },
        select: { sharedRoomId: true, orderId: true, orderItemId: true, passengerId: true, roomFraction: true },
      });
      for (const m of existingMembers) {
        let byItem = currentMembersByRoom.get(m.sharedRoomId);
        if (!byItem) {
          byItem = new Map();
          currentMembersByRoom.set(m.sharedRoomId, byItem);
        }
        const itemKey = `${m.orderId}:${m.orderItemId}`;
        let entry = byItem.get(itemKey);
        if (!entry) {
          entry = { passengerIds: new Set(), fraction: Number(m.roomFraction.toString()) };
          byItem.set(itemKey, entry);
        }
        entry.passengerIds.add(m.passengerId);
      }
    }
    const isUnchangedMember = (
      sharedRoomId: string | undefined,
      g: { orderId: string; orderItemId: string; passengerIds: readonly string[]; roomFraction: number },
    ): boolean => {
      if (!sharedRoomId) return false; // 新建房没有落库现状可比
      const existing = currentMembersByRoom.get(sharedRoomId)?.get(`${g.orderId}:${g.orderItemId}`);
      if (!existing || existing.fraction !== g.roomFraction) return false;
      if (existing.passengerIds.size !== g.passengerIds.length) return false;
      return g.passengerIds.every((pid) => existing.passengerIds.has(pid));
    };

    // ── §七 400 语义校验 ──────────────────────────────────────────────────
    const seenPassengerIds = new Set<string>();
    const warnings: string[] = [];
    // H1 修复：一间共享房「Σ有效份额=0」（原计费方已迁出，剩下的都是 0 份额留守成员，物理
    // 仍占 1 间、金额未重算）——既有房显式重提的情形（④，下面 Σ=1 校验里判定）与隐式触及
    // 旧房的情形（下面留守镜像重建之后判定）都会往这两个集合里记，最后统一转成 warnings
    // 并附到相关订单的审计 after 里（②），不再悄无声息。
    const orphanedLeftoverRoomIds = new Set<string>();
    const orphanWarningsByOrderId = new Map<string, string[]>();
    const pushOrphanWarning = (sharedRoomId: string, survivorOrderNumbers: readonly string[]): void => {
      const who = survivorOrderNumbers.length > 0 ? survivorOrderNumbers.join('、') : '剩余成员';
      const message = `共享房 ${sharedRoomId} 原计费方已迁出，${who} 计费 0 间，物理仍占 1 间，金额未重算。`;
      warnings.push(message);
    };
    for (const room of body.rooms) {
      const roomType = await tx.hotelRoomType.findUnique({
        where: { id: room.hotelRoomTypeId },
        select: { id: true, hotelId: true, capacity: true },
      });
      if (!roomType || roomType.hotelId !== body.hotelId) {
        throw new BadRequestError('房型不存在或不属于本酒店');
      }
      // Σ份额=1（按 orderId+orderItemId 去重——同一 group 内的多名乘客共享同一份额值，不重复求和）
      const fractionByOrderItem = new Map<string, number>();
      let totalPassengers = 0;
      for (const g of room.groups) {
        // 同一房内同一 (orderId, orderItemId) 出现多个 group → 400（astra A6①）：不规范化
        // 合并——`fractionByOrderItem.set` 是覆盖语义，重复键悄悄丢弃前一份额，Σ 校验可能
        // 侥幸算对，但下面 JSON 生成、SharedRoomMember 落库都是逐 group 处理，会把两份
        // passengerIds 都建成成员行，物理/计费口径就此对不上 Σ 校验看到的那份。
        const orderItemKey = `${g.orderId}:${g.orderItemId}`;
        if (fractionByOrderItem.has(orderItemKey)) {
          throw new BadRequestError(
            `房间「${room.hotelRoomTypeId}」里订单行 ${g.orderItemId} 出现了不止一个成员组，请合并成一组再提交`,
          );
        }
        const order = orders.get(g.orderId);
        if (!order) {
          throw new BadRequestError(`订单 ${g.orderId} 不存在`);
        }
        const invalidStatus = order.deletedAt != null || !COUNTED_STATUSES.includes(order.status);
        if (invalidStatus && !isUnchangedMember(room.sharedRoomId, g)) {
          throw new BadRequestError(`订单 ${g.orderId} 不存在或不处于房控有效状态`);
        }
        const item = order.items.find((it) => it.id === g.orderItemId);
        if (
          !item ||
          item.hotelRoomTypeId == null ||
          (item.kind !== OrderItemKind.HOTEL && item.kind !== OrderItemKind.BUNDLE)
        ) {
          throw new BadRequestError(`订单行 ${g.orderItemId} 不是本单的酒店/套餐行`);
        }
        if (item.hotelId !== body.hotelId) {
          throw new BadRequestError(`订单行 ${g.orderItemId} 不属于本酒店`);
        }
        if (item.randomStarTier != null) {
          throw new BadRequestError(`订单行 ${g.orderItemId} 是未落位的随机档，不能跨单分房`);
        }
        if (
          !item.hotelCheckIn ||
          !item.hotelCheckOut ||
          item.hotelCheckIn.getTime() !== checkInD.getTime() ||
          item.hotelCheckOut.getTime() !== checkOutD.getTime()
        ) {
          throw new BadRequestError(`订单行 ${g.orderItemId} 的入住区间与本次共享房不一致`);
        }
        for (const pid of g.passengerIds) {
          if (!order.passengerIds.has(pid)) {
            throw new BadRequestError(`乘客 ${pid} 不属于订单 ${g.orderId}`);
          }
          if (seenPassengerIds.has(pid)) {
            throw new BadRequestError(`乘客 ${pid} 在本次请求里出现了不止一次`);
          }
          seenPassengerIds.add(pid);
        }
        totalPassengers += g.passengerIds.length;
        fractionByOrderItem.set(`${g.orderId}:${g.orderItemId}`, g.roomFraction);

        // 首次拉进共享房：该单全部房组必须已补齐 orderItemId（不能部分归属）。
        const groups = parseRoomGroups(order.roomAssignment);
        const attributed = groups.filter((gg) => groupOrderItemId(gg) != null).length;
        if (groups.length > 0 && attributed !== groups.length) {
          throw new BadRequestError(
            `订单 ${order.orderNumber} 的房组归属不完整，请先在分房编辑器里给全部房组选归属订单行`,
          );
        }
      }
      const totalFraction = roundFraction(
        [...fractionByOrderItem.values()].reduce((s, f) => s + f, 0),
      );
      if (totalFraction !== 1) {
        // H1 修复 · 拍板 5(b)④：既有房（room.sharedRoomId 有值）若 Σ份额=0 且本次提交的
        // 每个成员组都与落库现状一模一样（isUnchangedMember——不是新增/改动，只是把「原计费
        // 方已迁出、剩下的都是 0 份额留守成员」这个既成事实原样交回来），不当 400 拦：
        // 运营手上拿到的就是这间房的当前真实状态，硬拒没有可操作的出路（把它拖进 dissolve
        // 也不对——房间物理仍在占用，见下方 orphanedLeftoverRoomIds 的 warning）。其余情形
        // （Σ 是其它非 1 值、或有改动）一律照旧硬闸。
        // N2 修复：isUnchangedMember 只管「列出来的组没改」，不管「有没有漏列」——请求体
        // 只列一部分现存成员时，`every` 对列出的子集仍然成立，会把「原样交回」误判成立，
        // 现场把没列出的计费方从成员表里摘掉（份额从 1 悄悄变没）。这里再加一道「本次列出
        // 的成员必须覆盖落库现状该房的全部成员」——键集合（orderId:orderItemId）与乘客
        // 集合都要被完全覆盖，有漏列就仍然走 Σ≠1 的硬闸。
        const currentByRoom = room.sharedRoomId != null ? currentMembersByRoom.get(room.sharedRoomId) : undefined;
        const listedItemKeys = new Set(room.groups.map((g) => `${g.orderId}:${g.orderItemId}`));
        const listedPassengerIds = new Set(room.groups.flatMap((g) => g.passengerIds));
        const coversAllCurrentMembers =
          currentByRoom == null ||
          ([...currentByRoom.keys()].every((key) => listedItemKeys.has(key)) &&
            [...currentByRoom.values()]
              .flatMap((v) => [...v.passengerIds])
              .every((pid) => listedPassengerIds.has(pid)));
        const isLeftoverOnlyResubmit =
          room.sharedRoomId != null &&
          totalFraction === 0 &&
          room.groups.length > 0 &&
          room.groups.every((g) => isUnchangedMember(room.sharedRoomId, g)) &&
          coversAllCurrentMembers;
        if (!isLeftoverOnlyResubmit) {
          throw new BadRequestError(`房间「${room.hotelRoomTypeId}」的计费份额合计须为 1，当前为 ${totalFraction}`);
        }
        orphanedLeftoverRoomIds.add(room.sharedRoomId!);
        const survivorOrderIds = [...new Set(room.groups.map((g) => g.orderId))];
        const survivorOrderNumbers = survivorOrderIds
          .map((oid) => orders.get(oid)?.orderNumber)
          .filter((v): v is string => !!v)
          .sort();
        pushOrphanWarning(room.sharedRoomId!, survivorOrderNumbers);
        for (const oid of survivorOrderIds) {
          const list = orphanWarningsByOrderId.get(oid) ?? [];
          list.push(
            `共享房 ${room.sharedRoomId!} 原计费方已迁出，本单剩余计费 0 间，物理仍占 1 间，金额未重算。`,
          );
          orphanWarningsByOrderId.set(oid, list);
        }
      }
      if (roomType.capacity > 0 && totalPassengers > roomType.capacity) {
        warnings.push(
          `房型容量 ${roomType.capacity} 人，本次分入 ${totalPassengers} 人，超出容量提示（不拦截）`,
        );
      }
    }
    for (const roomId of body.dissolve) {
      const current = currentById.get(roomId);
      if (current && current.status !== 'ACTIVE') {
        throw new BadRequestError(`共享房 ${roomId} 已是解散状态`);
      }
    }

    // ── 计算变更后状态：每张受影响订单的新 roomGroups + 每张房的成员表覆盖 ──────
    // dissolveSet 复用函数顶部（pre-tx）算好的那份，不在这里重新 new Set——两处必须是
    // 同一个集合，否则上面 CAS 循环判过的「是否在本次 dissolve 里」和这里实际解散的
    // 集合就可能对不上（虽然目前两处输入相同不会真出岔子，但同一份数据只算一次更稳）。
    // 本单房组备注（astra B7）：带 touched 共享键的旧组整体重建时，它在这张订单 JSON 里
    // 自己的 notes（单单编辑器维护的本地备注，与 SharedRoom.notes 是两回事，见文件头
    // 「待拍板口径」）会跟着旧对象一起被丢弃；工作台保存的 room.groups 里又没有承载
    // 这个字段的位置（Σ份额=1 之类的服务端校验只关心 orderId/orderItemId/passengerIds/
    // roomFraction）。保存前先把这些旧 notes 摘出来，按 (sharedRoomId, orderId,
    // orderItemId) 存好，重建时原样写回去——工作台端点本就没有输入这个字段的地方，
    // 只能是「保留」，不存在「省略=不动、空串=清空」的二义性（那是单单编辑器端点的语义，
    // 那边已经用 `g.notes ?? old?.notes` 正确处理，见 orders.routes.ts）。
    const preservedGroupNotes = new Map<string, string>();
    // 房组 id 服务端生成、不编码关系（astra B1）：老数据的 id 是 `shared:<sharedRoomId>:
    // <orderItemId>` / `plain:<sharedRoomId>:<orderItemId>`，原样透传给代理/客户视角
    // （room-group-dto.ts 的 serializeRoomGroupsFor 只挑字段不改值）就等于把内部共享房 id
    // 泄露出去。新组的 id 一律用不含任何关系信息的随机 id；重建同一间房时尽量沿用它
    // 上一次的（非旧式编码）随机 id 保持稳定，避免前端正开着的编辑器因 id 突变而对不上号；
    // 旧式编码的 id 一律不沿用，逼着它在下一次触及时换成新的随机 id（相当于惰性迁移）。
    const preservedGroupIds = new Map<string, string>();
    const LEGACY_ENCODED_ID_PREFIXES = ['shared:', 'plain:'];
    const isLegacyEncodedId = (id: string): boolean =>
      LEGACY_ENCODED_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
    // 审计 before 快照（astra A13）：下面的 kept 过滤器会**原地修改**旧 group 的
    // passengerIds（`g.passengerIds = remaining`，见下）——`parseRoomGroups` 只是
    // filter 出一个新数组，元素还是 `order.roomAssignment.roomGroups[]` 里的同一批
    // 对象引用，原地改了就是真的改了 order.roomAssignment 本身。审计 before 如果直接
    // 引用 order.roomAssignment，读到的会是「已经被本函数自己改过」的状态，不是这次
    // 保存开始前的真实旧值。这里在任何原地修改发生之前先深拷贝一份，专供审计使用；
    // 后面的业务逻辑（kept 计算、newGroupsByOrder）继续读/改 order.roomAssignment 本身，
    // 互不干扰。
    const beforeRoomAssignmentByOrder = new Map<string, unknown>();
    for (const [orderId, order] of orders) {
      beforeRoomAssignmentByOrder.set(orderId, structuredClone(order.roomAssignment));
    }
    const newGroupsByOrder = new Map<string, Array<Record<string, unknown>>>();
    for (const [orderId, order] of orders) {
      const groups = parseRoomGroups(order.roomAssignment);
      // 保留：既不带 touched 共享键、也不含本次被吸收乘客的房组
      const kept = groups.filter((g) => {
        const sid = groupSharedId(g);
        if (sid != null && touchedSharedRoomIds.has(sid)) {
          const itemId = groupOrderItemId(g);
          if (itemId != null && typeof g.notes === 'string' && g.notes.length > 0) {
            preservedGroupNotes.set(`${sid}:${orderId}:${itemId}`, g.notes);
          }
          if (itemId != null && typeof g.id === 'string' && g.id.length > 0 && !isLegacyEncodedId(g.id)) {
            preservedGroupIds.set(`${sid}:${orderId}:${itemId}`, g.id);
          }
          return false; // 本次改动的共享房，整体重建
        }
        const ids = Array.isArray(g.passengerIds)
          ? (g.passengerIds as unknown[]).filter((v): v is string => typeof v === 'string')
          : [];
        const remaining = ids.filter((pid) => !seenPassengerIds.has(pid));
        if (remaining.length !== ids.length) {
          if (remaining.length === 0) return false; // 盒子被搬空——整体丢弃
          g.passengerIds = remaining; // 盒子还有别人留守——原地收窄乘客集合
        }
        return true;
      });
      newGroupsByOrder.set(orderId, kept);
    }
    // 解散：把旧成员退回普通房组（保留乘客/orderItemId/份额，去掉 sharedRoomId）
    for (const roomId of dissolveSet) {
      const members = await tx.sharedRoomMember.findMany({
        where: { sharedRoomId: roomId },
        select: { orderId: true, orderItemId: true, passengerId: true, roomFraction: true },
      });
      const byOrderItem = new Map<
        string,
        { orderId: string; orderItemId: string; passengerIds: string[]; fraction: number }
      >();
      for (const m of members) {
        const key = `${m.orderId}:${m.orderItemId}`;
        const entry = byOrderItem.get(key) ?? {
          orderId: m.orderId,
          orderItemId: m.orderItemId,
          passengerIds: [],
          fraction: Number(m.roomFraction.toString()),
        };
        entry.passengerIds.push(m.passengerId);
        if (!byOrderItem.has(key)) byOrderItem.set(key, entry);
      }
      for (const entry of byOrderItem.values()) {
        // 只承接本次没有被其它目标房认领走的成员（astra B-N2，回归修复）：解散 S 的同时
        // 把 S 的某个成员重新分到本次请求里另一间房 T（body.rooms 里某个 group 认领了
        // 同一个乘客），下面「新建/更新的共享房」那一段会给这个乘客在同一 (orderId,
        // orderItemId) 上再追加一个指向 T 的共享组——如果这里不过滤，这个乘客会同时落在
        // 一个普通组（这里退回的）和一个共享组（T 的）里，两边的 roomFraction 在下面
        // roomsBilled 回写时按 orderItemId 累加，行级计费份额直接翻倍。反例：A 原在 S
        // （fraction 1），S 被解散同时 A 被拖进 T（fraction 1）——A 最终应该只在 T，
        // roomsBilled 仍是 1，不是 2。
        const survivors = entry.passengerIds.filter((pid) => !seenPassengerIds.has(pid));
        if (survivors.length === 0) continue; // 这一行的乘客全部被本次请求重新认领，不留普通组残留
        const arr = newGroupsByOrder.get(entry.orderId) ?? [];
        const preserveKey = `${roomId}:${entry.orderId}:${entry.orderItemId}`;
        const preservedNotes = preservedGroupNotes.get(preserveKey);
        // 房组 id 不编码 sharedRoomId（astra B1）：解散后退回普通组的 id 不能再用
        // `plain:${roomId}:...`——roomId 就是被解散的那间共享房 id，原样保留反而是
        // 「解散了但 id 还认得出是哪间共享房」，泄露面不会因为组变普通了就消失。
        const groupId = preservedGroupIds.get(preserveKey) ?? randomUUID();
        arr.push({
          id: groupId,
          hotelName: '',
          roomType: '',
          passengerIds: survivors,
          orderItemId: entry.orderItemId,
          roomFraction: entry.fraction, // 保留原份额，不重新分配（部分乘客被认领走不重算剩余份额）
          ...(preservedNotes != null ? { notes: preservedNotes } : {}),
        });
        newGroupsByOrder.set(entry.orderId, arr);
      }
    }
    // 隐式触及旧共享房的留守成员镜像重建（astra N5，回归修复）：上面的 kept 过滤器只要
    // sid 在 touchedSharedRoomIds 里就整体丢弃这个订单在这间房的旧 JSON 组——隐式房同样
    // 在 touchedSharedRoomIds 里（本函数顶部并入的），所以隐式房里「没有被本次请求认领走」
    // 的其它订单（比如反例里的 B：S 有 A、B，只把 A 拖进新房且请求不列 S）的旧组同样被
    // 丢弃，但它们在 SharedRoomMember 表里仍然是这间房的成员——下面落库段对隐式房的清理
    // 只摘除 seenPassengerIds 认领走的那些人，B 不在其中，不会被摘。旧实现到这里就结束了，
    // 从未把 B 的组重新写回 newGroupsByOrder：JSON 侧 B 的这间房凭空消失，紧接着的
    // roomsBilled 回写只看 newGroupsByOrder 里还有没有 B 这一行的组引用，查不到就显式写
    // 0，把 B 在这间房的计费份额也一起清没了。
    //
    // 用 currentMembersByRoom（锁后落库现状，上面已按 touchedSharedRoomIds 查过）逐
    // (orderId, orderItemId) 重建：排除本次被认领走的乘客（seenPassengerIds），剩余乘客
    // 非空才重建、原样保留原份额与原 notes/id——这只是把「继续留守这间房」的事实原样写回
    // JSON，不是一次业务改动，不重算 Σ=1（保留其份额，不重新分配，见方案 §五「解绑」的
    // 份额处理原则）。如果某个 (orderId, orderItemId) 的乘客本次全部被认领走就不重建，
    // 与下面落库段「隐式房清空后自动 DISSOLVED」判断依据一致（都是「排除
    // seenPassengerIds 之后还有没有人」），两处不会出现「JSON 说有房、DB 说已解散」的
    // 不一致。
    for (const roomId of implicitRoomIds) {
      const membersByItem = currentMembersByRoom.get(roomId);
      if (!membersByItem) continue;
      // H1 修复：这间房本次没被点名，只是被动留守——统计留守方的 Σ份额，摘完之后如果这
      // 间房仍有留守成员但份额合计是 0（原计费方被这次请求拖进了别的房），物理仍占 1 间、
      // 却没有任何人计费，必须提示（①②），不能像旧实现那样悄无声息。
      let survivorTotalFraction = 0;
      let hasSurvivors = false;
      const survivorOrderIdsForRoom = new Set<string>();
      for (const [itemKey, entry] of membersByItem) {
        const survivors = [...entry.passengerIds].filter((pid) => !seenPassengerIds.has(pid));
        if (survivors.length === 0) continue; // 这一行的乘客本次全部被认领走，不重建
        const [survivorOrderId, survivorItemId] = itemKey.split(':');
        if (!survivorOrderId || !survivorItemId) continue; // 防御：key 格式不对就跳过，不该发生
        hasSurvivors = true;
        survivorTotalFraction = roundFraction(survivorTotalFraction + entry.fraction);
        survivorOrderIdsForRoom.add(survivorOrderId);
        const arr = newGroupsByOrder.get(survivorOrderId) ?? [];
        const preserveKey = `${roomId}:${survivorOrderId}:${survivorItemId}`;
        const preservedNotes = preservedGroupNotes.get(preserveKey);
        const groupId = preservedGroupIds.get(preserveKey) ?? randomUUID();
        arr.push({
          id: groupId,
          hotelName: '',
          roomType: '',
          passengerIds: survivors,
          orderItemId: survivorItemId,
          roomFraction: entry.fraction,
          sharedRoomId: roomId,
          ...(preservedNotes != null ? { notes: preservedNotes } : {}),
        });
        newGroupsByOrder.set(survivorOrderId, arr);
      }
      if (hasSurvivors && survivorTotalFraction === 0) {
        orphanedLeftoverRoomIds.add(roomId);
        const survivorOrderNumbers = [...survivorOrderIdsForRoom]
          .map((oid) => orders.get(oid)?.orderNumber)
          .filter((v): v is string => !!v)
          .sort();
        pushOrphanWarning(roomId, survivorOrderNumbers);
        for (const oid of survivorOrderIdsForRoom) {
          const list = orphanWarningsByOrderId.get(oid) ?? [];
          list.push(
            `共享房 ${roomId} 原计费方已迁出，本单剩余计费 0 间，物理仍占 1 间，金额未重算。`,
          );
          orphanWarningsByOrderId.set(oid, list);
        }
      }
    }
    // 新建/更新的共享房：给每个 group 所在订单追加一个共享房组。
    //
    // 新房的 id 在这里（写订单 JSON 镜像）与下面「落库」段（真正 tx.sharedRoom.create）分两处
    // 用到——必须是同一个值，否则订单 JSON 里的 sharedRoomId 会指向一个数据库里根本不存在的
    // 幽灵 id（两处各自调用 randomUUID() 就会各生成一个，谁也不认识谁）。resolvedRoomIds 按
    // body.rooms 的下标一一对应，在这整个函数里只生成一次、两处复用同一份。
    const resolvedRoomIds = body.rooms.map((r) => r.sharedRoomId ?? randomUUID());
    const roomTypeCache = new Map<string, { name: string }>();
    for (let roomIndex = 0; roomIndex < body.rooms.length; roomIndex++) {
      const room = body.rooms[roomIndex];
      if (!roomTypeCache.has(room.hotelRoomTypeId)) {
        const rt = await tx.hotelRoomType.findUnique({
          where: { id: room.hotelRoomTypeId },
          select: { name: true },
        });
        roomTypeCache.set(room.hotelRoomTypeId, { name: rt?.name ?? '' });
      }
      const sharedRoomId = resolvedRoomIds[roomIndex];
      for (const g of room.groups) {
        const arr = newGroupsByOrder.get(g.orderId) ?? [];
        // 更新既有房（room.sharedRoomId 有值）时，sharedRoomId 与旧组相同，按
        // (sharedRoomId, orderId, orderItemId) 能查到旧 notes / id 原样带回来；新建房
        // 的 sharedRoomId 是刚生成的随机 id，查不到旧记录，两者都从零生成/留空。
        const preserveKey = `${sharedRoomId}:${g.orderId}:${g.orderItemId}`;
        const preservedNotes = preservedGroupNotes.get(preserveKey);
        // 房组 id 服务端生成、不编码 sharedRoomId（astra B1）：这里不再用
        // `shared:${sharedRoomId}:...` 拼 id——那等于把内部共享房 id 原样嵌进一个
        // 对外可见的字段，AGENT/CUSTOMER 视角（room-group-dto.ts）会原样把它传出去。
        const groupId = preservedGroupIds.get(preserveKey) ?? randomUUID();
        arr.push({
          id: groupId,
          hotelName: '',
          roomType: roomTypeCache.get(room.hotelRoomTypeId)?.name ?? '',
          passengerIds: g.passengerIds,
          orderItemId: g.orderItemId,
          roomFraction: g.roomFraction,
          sharedRoomId,
          ...(preservedNotes != null ? { notes: preservedNotes } : {}),
        });
        newGroupsByOrder.set(g.orderId, arr);
      }
    }

    // ── §五闸：受影响订单在本酒店变更后的占房快照 + 共享房变更后状态 ─────────
    const nextOrderItems = new Map<string, PhysicalOccupancyItem[]>();
    for (const [orderId, order] of orders) {
      const newGroups = newGroupsByOrder.get(orderId) ?? [];
      const itemsAtHotel: PhysicalOccupancyItem[] = order.items
        .filter((it) => it.hotelId === body.hotelId)
        .map((it) => ({
          id: it.id,
          hotelCheckIn: it.hotelCheckIn,
          hotelCheckOut: it.hotelCheckOut,
          roomsBilled: null, // 物理口径按新 roomGroups JSON 直计，不看 roomsBilled 快照
          metadata: it.metadata,
          order: { id: orderId, roomAssignment: { roomGroups: newGroups }, passengers: [] },
        }));
      nextOrderItems.set(orderId, itemsAtHotel);
    }
    // hotelId 全部显式带上（astra N1）：新建房的 sharedRoomId 是刚生成、还没落库的随机
    // id，被 assertHotelFitAfterChange 内部的 hotelId 兜底过滤查库时天然查不到——不带
    // hotelId 会让「查不到归属」与「不属于本酒店」这两种不同的信号被同一个 false 混淆，
    // 一间即将新建、马上要占用物理房间的共享房会被整间从前瞻闸的统计里过滤掉，前瞻算出
    // 的物理间数比实际提交后少一间。本端点单次请求只服务一个 body.hotelId（已在函数顶部
    // 校验过是真实酒店、非占位），三类覆盖项（解散、新建/更新、隐式旧房）一律显式带上它，
    // 不依赖被调用方按 sharedRoomId 查库兜底。
    const nextSharedRooms: SharedRoomAfterState[] = [];
    for (const roomId of dissolveSet) {
      nextSharedRooms.push({
        sharedRoomId: roomId,
        hotelId: body.hotelId,
        checkIn: checkInD,
        checkOut: checkOutD,
        activeMemberOrderIds: [],
      });
    }
    for (let roomIndex = 0; roomIndex < body.rooms.length; roomIndex++) {
      const room = body.rooms[roomIndex];
      const activeOrderIds = [
        ...new Set(
          room.groups
            .map((g) => g.orderId)
            .filter((oid) => {
              const o = orders.get(oid);
              return !!o && o.deletedAt == null && COUNTED_STATUSES.includes(o.status);
            }),
        ),
      ];
      nextSharedRooms.push({
        sharedRoomId: resolvedRoomIds[roomIndex], // 新房也带上——与订单 JSON/落库用的是同一个 id
        hotelId: body.hotelId,
        checkIn: checkInD,
        checkOut: checkOutD,
        activeMemberOrderIds: activeOrderIds,
      });
    }
    // 隐式触及旧房的「变更后」状态（astra A6②）：本次被认领走的乘客从这些房间的成员里
    // 摘除，物理去重口径要跟着变——不摘的话前瞻闸看到的还是摘除前的旧成员集合，可能把
    // 已经腾出来的物理间数误判成仍被占用。
    const implicitRoomSurvivors = new Map<string, Set<string>>();
    if (implicitRoomIds.size > 0) {
      const implicitMembers = await tx.sharedRoomMember.findMany({
        where: { sharedRoomId: { in: [...implicitRoomIds] } },
        select: { sharedRoomId: true, orderId: true, passengerId: true },
      });
      for (const m of implicitMembers) {
        if (seenPassengerIds.has(m.passengerId)) continue; // 本次被摘除，不算幸存
        let set = implicitRoomSurvivors.get(m.sharedRoomId);
        if (!set) {
          set = new Set();
          implicitRoomSurvivors.set(m.sharedRoomId, set);
        }
        set.add(m.orderId);
      }
      for (const roomId of implicitRoomIds) {
        const current = currentById.get(roomId);
        if (!current || current.status !== 'ACTIVE') continue; // 并发已不是活跃状态，不掺和
        const survivorOrderIds = [...(implicitRoomSurvivors.get(roomId) ?? [])].filter((oid) => {
          const o = orders.get(oid);
          return !!o && o.deletedAt == null && COUNTED_STATUSES.includes(o.status);
        });
        nextSharedRooms.push({
          sharedRoomId: roomId,
          hotelId: body.hotelId,
          checkIn: current.checkIn,
          checkOut: current.checkOut,
          activeMemberOrderIds: survivorOrderIds,
        });
      }
    }

    await assertHotelFitAfterChange(tx, body.hotelId, nightDates, {
      affectedOrderIds: [...orders.keys()],
      nextOrderItems,
      nextSharedRooms,
      options: { allowNonWorsening: true },
    });

    // ── 落库：SharedRoom / SharedRoomMember / 订单 JSON / roomsBilled ────────
    const savedRooms: Array<{ sharedRoomId: string; version: number }> = [];
    for (const roomId of dissolveSet) {
      await tx.sharedRoom.update({
        where: { id: roomId },
        // version 也要递增（astra A3）：解散同样是一次「变更」，不递增的话别处拿着解散前的
        // 旧 expectedVersions 还能在 CAS 那一关侥幸对上号——虽然上面新增的 ACTIVE 校验已经会
        // 拦下「更新一间已解散的房」，但版本本就该随每次状态变化单调递增，不留特例。
        data: {
          status: 'DISSOLVED',
          dissolvedAt: new Date(),
          dissolvedReason: '跨单分房工作台解散',
          version: { increment: 1 },
        },
      });
      await tx.sharedRoomMember.deleteMany({ where: { sharedRoomId: roomId } });
    }
    // 隐式触及旧房的实际清理（astra A6②）：摘掉本次被认领走的乘客在这些房间里的成员行；
    // 摘完如果这间房空了就顺手解散（不留一间零成员的幽灵 ACTIVE 房），否则只递增版本
    // （membership 变了，版本就该跟着涨，即便这次不是客户端主动发起的更新）。这些房间
    // 不出现在返回值 rooms/dissolved 列表里——它们是本次请求的副作用，不是主体。
    for (const roomId of implicitRoomIds) {
      const current = currentById.get(roomId);
      if (!current || current.status !== 'ACTIVE') continue; // 并发已不是活跃状态，不掺和
      await tx.sharedRoomMember.deleteMany({
        where: { sharedRoomId: roomId, passengerId: { in: [...seenPassengerIds] } },
      });
      const remaining = await tx.sharedRoomMember.count({ where: { sharedRoomId: roomId } });
      if (remaining === 0) {
        await tx.sharedRoom.update({
          where: { id: roomId },
          data: {
            status: 'DISSOLVED',
            dissolvedAt: new Date(),
            dissolvedReason: '成员全部转移到其它跨单分房请求',
            version: { increment: 1 },
          },
        });
      } else {
        await tx.sharedRoom.update({ where: { id: roomId }, data: { version: { increment: 1 } } });
      }
    }
    for (let roomIndex = 0; roomIndex < body.rooms.length; roomIndex++) {
      const room = body.rooms[roomIndex];
      const sharedRoomId = resolvedRoomIds[roomIndex]; // 与订单 JSON 镜像里写的必须是同一个 id
      if (room.sharedRoomId) {
        const updated = await tx.sharedRoom.update({
          where: { id: sharedRoomId },
          data: {
            hotelRoomTypeId: room.hotelRoomTypeId,
            notes: room.notes ?? null,
            // checkIn/checkOut 显式带上（虽然上面的 CAS 循环已经强制校验它们与本次请求一致，
            // 这里再写一遍纯属防御：万一以后那道校验被改坏，落库这行仍然不会悄悄挪日期）。
            checkIn: checkInD,
            checkOut: checkOutD,
            version: { increment: 1 },
          },
          select: { id: true, version: true },
        });
        savedRooms.push({ sharedRoomId: updated.id, version: updated.version });
        // M6 修复：本函数的更新语义是「listed 决定最终成员」（下面 deleteMany 后按
        // room.groups 重建）——客户端提交一间既有房时若漏掉某个成员的 group（不管是手滑
        // 还是前端渲染漏了），这个人会被静默摘出成员表、不报错也不 warning，运营完全看
        // 不出这次保存"顺手"把谁踢出去了。落库前比一次「现状成员 − 本次 listed 成员」，
        // 差集非空就进 warnings，把「移除」变成看得见的事实（不阻断——这本就是端点的
        // 合法语义，只是不能悄无声息）。
        const listedPassengerIds = new Set(room.groups.flatMap((g) => g.passengerIds));
        const removedByOrderId = new Map<string, number>();
        for (const [itemKey, entry] of currentMembersByRoom.get(sharedRoomId) ?? []) {
          const ownerOrderId = itemKey.split(':')[0];
          if (!ownerOrderId) continue; // 防御：key 格式不对就跳过，不该发生
          for (const pid of entry.passengerIds) {
            if (listedPassengerIds.has(pid)) continue;
            removedByOrderId.set(ownerOrderId, (removedByOrderId.get(ownerOrderId) ?? 0) + 1);
          }
        }
        if (removedByOrderId.size > 0) {
          const removedCount = [...removedByOrderId.values()].reduce((s, n) => s + n, 0);
          const removedOrderNumbers = [...removedByOrderId.keys()]
            .map((oid) => orders.get(oid)?.orderNumber)
            .filter((v): v is string => !!v)
            .sort();
          warnings.push(
            `已从共享房 ${sharedRoomId} 移除 ${removedCount} 名成员：${removedOrderNumbers.join('、') || '未知订单'}` +
              '（本次保存未列出，按当前语义视为移出，请确认）。',
          );
        }
        await tx.sharedRoomMember.deleteMany({ where: { sharedRoomId } });
      } else {
        const created = await tx.sharedRoom.create({
          data: {
            id: sharedRoomId, // 显式传 id，覆盖 @default(cuid())——必须等于上面 JSON 里已经写的值
            hotelId: body.hotelId,
            hotelRoomTypeId: room.hotelRoomTypeId,
            checkIn: checkInD,
            checkOut: checkOutD,
            notes: room.notes ?? null,
            createdById: actor.userId ?? null,
          },
          select: { id: true, version: true },
        });
        savedRooms.push({ sharedRoomId: created.id, version: created.version });
      }
      for (const g of room.groups) {
        for (const pid of g.passengerIds) {
          await tx.sharedRoomMember.create({
            data: {
              sharedRoomId,
              orderId: g.orderId,
              orderItemId: g.orderItemId,
              passengerId: pid,
              roomFraction: g.roomFraction,
            },
          });
        }
      }
    }

    // 每张受影响订单各写一条审计——用 writeAuditWithinTx，与本次业务写入同一个事务
    // 一起成功、一起回滚（astra A13）：份额调整这类操作，审计本就该和它描述的落库
    // 结果同生共死，不能是「业务成功了，进程在这之后崩溃或审计写失败，就再也没有
    // 逐单审计」的 fire-and-forget（原实现在事务外才 void writeAudit(...)）。
    const orderAuditPayloads: OrderRoomAssignmentAuditPayload[] = [];
    for (const [orderId, groups] of newGroupsByOrder) {
      const order = orders.get(orderId);
      if (!order) continue;
      await tx.order.update({
        where: { id: orderId },
        data: { roomAssignment: { roomGroups: groups } as unknown as object },
      });
      // roomsBilled：按 orderItemId 去重后求和（同一行若被拆成多个 group——正常只会有一个
      // 普通组 + 至多多个共享组，见 §三「一条酒店行可能同时有普通房和多个共享房」——按行累加）。
      const roomsByItemId = new Map<string, number>();
      for (const g of groups) {
        const itemId = groupOrderItemId(g);
        if (!itemId) continue;
        roomsByItemId.set(itemId, (roomsByItemId.get(itemId) ?? 0) + readBillingFraction(g));
      }
      // 显式回写的行 = 本次新 groups 引用到的行 ∪ 变更前旧 groups 引用过的行。前者按新值写
      // （哪怕算出 0 也写 0，不留 null——null 会重新激活 metadata 兜底）；后者若这次不再被
      // 任何组引用（乘客被整体搬去挂在另一条行的房组/共享房），同样要显式写 0——否则那条行
      // 的乘客已经没有任何房组承载，roomsBilled 却还停在搬走前的旧值，两本账对不上。
      // 变更前后都没有房组引用过的行（从未分房，roomsBilled 是录单时算的）保持不动。
      const oldGroupsForOrder = parseRoomGroups(order.roomAssignment);
      const oldItemIds = new Set(
        oldGroupsForOrder.map((g) => groupOrderItemId(g)).filter((v): v is string => v != null),
      );
      const itemIdsToWrite = new Set<string>([...roomsByItemId.keys(), ...oldItemIds]);
      const afterRoomsBilled: Record<string, number> = {};
      for (const itemId of itemIdsToWrite) {
        const rooms = roundFraction(roomsByItemId.get(itemId) ?? 0);
        afterRoomsBilled[itemId] = rooms;
        await tx.orderItem.update({
          where: { id: itemId },
          data: { roomsBilled: new Prisma.Decimal(rooms) },
        });
      }

      // 本单参与的共享房 → 同房其它订单号（内部审计，可以带单号）。
      const sharedIdsForOrder = [
        ...new Set(groups.map((g) => groupSharedId(g)).filter((v): v is string => v != null)),
      ];
      const coMemberOrderNumbersBySharedRoomId: Record<string, string[]> = {};
      for (const sid of sharedIdsForOrder) {
        const members = await tx.sharedRoomMember.findMany({
          where: { sharedRoomId: sid, orderId: { not: orderId } },
          select: { orderId: true },
        });
        const otherOrderIds = [...new Set(members.map((m) => m.orderId))];
        const otherOrders =
          otherOrderIds.length > 0
            ? await tx.order.findMany({
                where: { id: { in: otherOrderIds } },
                select: { orderNumber: true },
              })
            : [];
        coMemberOrderNumbersBySharedRoomId[sid] = otherOrders.map((o) => o.orderNumber);
      }

      const orphanWarningsForOrder = orphanWarningsByOrderId.get(orderId);
      const auditPayload: OrderRoomAssignmentAuditPayload = {
        orderId,
        orderNumber: order.orderNumber,
        // 用锁后读到、尚未被本函数任何逻辑原地修改过的深拷贝（astra A13），不是
        // order.roomAssignment 本身——上面 kept 过滤器已经原地改过它的嵌套 group 对象。
        beforeRoomAssignment: beforeRoomAssignmentByOrder.get(orderId) ?? null,
        beforeRoomsBilled: Object.fromEntries(order.items.map((it) => [it.id, it.roomsBilled])),
        afterRoomAssignment: { roomGroups: groups },
        afterRoomsBilled,
        sharedRooms: coMemberOrderNumbersBySharedRoomId,
        // H1 修复（②）：本单若受共享房 Σ份额=0 影响，逐单审计 after 也带这条，不止响应
        // warnings 一处——事后查审计的人不该只能靠翻当时的接口响应才看得到。
        ...(orphanWarningsForOrder && orphanWarningsForOrder.length > 0
          ? { orphanedSharedRoomWarnings: orphanWarningsForOrder }
          : {}),
      };
      orderAuditPayloads.push(auditPayload);
      await writeAuditWithinTx(tx, {
        actor,
        action: 'UPDATE_ROOM_ASSIGNMENT',
        targetType: 'ORDER',
        targetId: auditPayload.orderId,
        targetLabel: auditPayload.orderNumber,
        before: { roomAssignment: auditPayload.beforeRoomAssignment, roomsBilled: auditPayload.beforeRoomsBilled },
        after: {
          roomAssignment: auditPayload.afterRoomAssignment,
          roomsBilled: auditPayload.afterRoomsBilled,
          sharedRooms: auditPayload.sharedRooms,
          ...(auditPayload.orphanedSharedRoomWarnings
            ? { orphanedSharedRoomWarnings: auditPayload.orphanedSharedRoomWarnings }
            : {}),
        },
      });
    }

    const finalResult: SaveSharedRoomsResult = {
      rooms: savedRooms,
      dissolved: [...dissolveSet],
      warnings,
    };
    // 按占位行的主键 id 写最终结果，不是 requestToken（astra N10）：如果这次执行已经被
    // 判定超时、占位被回收（见 reserveRequestOrReplay 的 CAS 回收），本次持有的
    // reservationId 这一刻在库里已经不存在了——`update` 会抛 P2025（记录不存在），让
    // 整个事务连同上面已经写好的成员表 / 订单 JSON / roomsBilled 一起回滚，不会把一个
    // 「已被判定为过期」的执行结果当成功提交（过期执行者不得提交业务结果）。按
    // requestToken 更新则做不到这一点：抢占后同一个 requestToken 指向一张新 id 的行，
    // 过期的这次执行仍能匹配上、把自己的（可能是旧的/错的）结果写进新占位里，污染新执行。
    try {
      await tx.sharedRoomRequest.update({
        where: { id: reservationId },
        data: { resultJson: finalResult as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new ConflictError(
          '本次跨单分房保存的请求编号占位已被判定超时并回收，本次提交作废，请刷新后使用新的请求编号重试',
        );
      }
      throw err;
    }
    // 主单：受影响订单里 id 最小的一个，给 SAVE_SHARED_ROOMS 总览审计条挂载（本条本身
    // 只是「这次保存做了什么」的总览，逐单细节在上面逐单审计里）。同样用 writeAuditWithinTx
    // 与业务同事务提交（astra A13）。
    const primaryOrderId = [...orders.keys()].sort()[0] ?? null;
    if (primaryOrderId) {
      await writeAuditWithinTx(tx, {
        actor,
        action: 'SAVE_SHARED_ROOMS',
        targetType: 'ORDER',
        targetId: primaryOrderId,
        targetLabel: `${body.hotelId} ${body.checkIn}→${body.checkOut}`,
        after: {
          rooms: finalResult.rooms,
          dissolved: finalResult.dissolved,
          requestToken: body.requestToken,
          orderIds: orderAuditPayloads.map((p) => p.orderId),
        },
      });
    }
    return finalResult;
  }));

  return result;
}
