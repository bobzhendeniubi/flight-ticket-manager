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
import { writeAudit } from '../../lib/audit.js';
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
        select: { orderId: true, orderItemId: true, passengerId: true, roomFraction: true },
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
 * §六步骤 1-3：候选订单集合 → 按 id 升序锁 → 重读成员表发现集合扩大则重试（≤3 次）。
 * 返回最终锁定的订单 id 集合。
 */
async function lockAffectedOrders(
  tx: Prisma.TransactionClient,
  initialOrderIds: ReadonlySet<string>,
  touchedSharedRoomIds: ReadonlySet<string>,
): Promise<Set<string>> {
  let locked = new Set<string>();
  let candidate = new Set(initialOrderIds);
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    for (const orderId of [...candidate].sort()) {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    }
    locked = candidate;
    if (touchedSharedRoomIds.size === 0) return locked;
    const members = await tx.sharedRoomMember.findMany({
      where: { sharedRoomId: { in: [...touchedSharedRoomIds] } },
      select: { orderId: true },
    });
    const expanded = new Set(locked);
    for (const m of members) expanded.add(m.orderId);
    if (expanded.size === locked.size) return locked; // 没有新订单浮现，锁住的就是最终集合
    candidate = expanded; // 集合扩大——回去补锁新出现的订单（不持大 id 锁再补小 id：整批重新按升序锁一遍）
  }
  return locked;
}

/**
 * 房组的计费份额——**只对普通（非共享）房组**回落「缺省/非正数 → 1」（与
 * hotel-control.service 的 groupRoomFraction 同口径，旧客户端省略字段时的兼容行为）。
 * 共享房组的 0 是明确值（主单让份），不能被这条兜底吃掉，见 astra 评审 finding 1/3。
 */
function readBillingFraction(g: Record<string, unknown>): number {
  const n = Number(g.roomFraction);
  const explicit = Number.isFinite(n) ? n : null;
  if (groupSharedId(g) != null) return explicit ?? 0;
  if (explicit != null && explicit > 0) return explicit;
  return 1;
}

/**
 * 幂等占位哨兵：`sharedRoomRequest.create` 先写这个值占住 requestToken，跑完真正的业务逻辑
 * 才会被最终结果覆盖。resultJson 列是必填 Json（非 nullable），不能用 SQL NULL 当哨兵，
 * 所以用一个真结果永远不会长这样的形状（finalResult 恒有 rooms/dissolved/warnings 三个键，
 * 从不带 __pending）来判定「这行是不是还没跑完」。
 */
const PENDING_SENTINEL = { __pending: true } as const;
function isPendingSentinel(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).__pending === true;
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

  // ── 幂等：requestToken 唯一，先占位再算——占位成功才是「第一次」，占位失败读现存记录回放/冲突 ──
  //
  // 占位成功之后，本函数任何一步失败（400/409/其它异常）都必须把占位行删掉：否则占位行的
  // resultJson 停在 PENDING_SENTINEL，下次同 token 同指纹重试会被 existing.fingerprint ===
  // fingerprint 命中、直接回放一个「看起来成功但没有 rooms/dissolved」的假结果——前端按 200
  // 处理，实际什么都没落库。见下方 try/finally：reserved 为 true 时，退出前若没有把
  // resultJson 换成真结果，一律删掉占位行，让同 token 重试真正重新跑一遍。
  let reserved = false;
  try {
    await client.sharedRoomRequest.create({
      data: { requestToken: body.requestToken, fingerprint, resultJson: PENDING_SENTINEL },
    });
    reserved = true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await client.sharedRoomRequest.findUnique({
        where: { requestToken: body.requestToken },
      });
      if (existing && existing.fingerprint === fingerprint) {
        if (isPendingSentinel(existing.resultJson)) {
          // 上一次占位后还没写出真结果——可能仍在处理中，也可能失败后占位没删干净（极端竞态：
          // 两个进程同时占位失败又同时想删）。不能当「已经成功」回放，请调用方换新 token 重试。
          throw new ConflictError('该请求编号上一次保存尚未完成，请使用新的请求编号重试');
        }
        return existing.resultJson as unknown as SaveSharedRoomsResult;
      }
      throw new ConflictError('该请求编号已用于另一次不同的跨单分房保存，请刷新后重试');
    }
    throw err;
  }

  try {
    return await saveSharedRoomsInner(body, actor, client);
  } catch (err) {
    if (reserved) {
      // 最佳努力清理占位——删失败也不能吞掉原始错误，原始错误才是调用方需要看到的。
      await client.sharedRoomRequest.delete({ where: { requestToken: body.requestToken } }).catch(() => {});
    }
    throw err;
  }
}

async function saveSharedRoomsInner(
  body: SaveSharedRoomsBody,
  actor: AuditActor,
  client: PrismaClient,
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

  const touchedSharedRoomIds = new Set<string>([
    ...body.rooms.map((r) => r.sharedRoomId).filter((v): v is string => !!v),
    ...body.dissolve,
  ]);
  const initialOrderIds = new Set<string>(body.rooms.flatMap((r) => r.groups.map((g) => g.orderId)));

  const result = await client.$transaction(async (tx) => {
    const lockedOrderIds = await lockAffectedOrders(tx, initialOrderIds, touchedSharedRoomIds);
    const orders = await loadLockedOrders(tx, [...lockedOrderIds]);

    // ── expectedVersions CAS：先于业务校验判——版本对不上就是「这把牌已经不是你看到的那把」──
    const currentSharedRooms = await tx.sharedRoom.findMany({
      where: { id: { in: [...touchedSharedRoomIds] } },
      select: { id: true, version: true, hotelId: true, checkIn: true, checkOut: true, status: true },
    });
    const currentById = new Map(currentSharedRooms.map((r) => [r.id, r]));
    for (const roomId of touchedSharedRoomIds) {
      const current = currentById.get(roomId);
      if (!current) throw new NotFoundError(`共享房 ${roomId} 不存在或已被解散`);
      const expected = body.expectedVersions?.[roomId];
      if (expected == null || expected !== current.version) {
        throw new ConflictError('该房间已被他人修改，请刷新后重试');
      }
      if (current.hotelId !== body.hotelId) {
        throw new BadRequestError(`共享房 ${roomId} 不属于本酒店`);
      }
    }

    // ── §七 400 语义校验 ──────────────────────────────────────────────────
    const seenPassengerIds = new Set<string>();
    const warnings: string[] = [];
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
        const order = orders.get(g.orderId);
        if (!order || order.deletedAt != null || !COUNTED_STATUSES.includes(order.status)) {
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
        throw new BadRequestError(`房间「${room.hotelRoomTypeId}」的计费份额合计须为 1，当前为 ${totalFraction}`);
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
    const dissolveSet = new Set(body.dissolve);
    const newGroupsByOrder = new Map<string, Array<Record<string, unknown>>>();
    for (const [orderId, order] of orders) {
      const groups = parseRoomGroups(order.roomAssignment);
      // 保留：既不带 touched 共享键、也不含本次被吸收乘客的房组
      const kept = groups.filter((g) => {
        const sid = groupSharedId(g);
        if (sid != null && touchedSharedRoomIds.has(sid)) return false; // 本次改动的共享房，整体重建
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
        const arr = newGroupsByOrder.get(entry.orderId) ?? [];
        arr.push({
          id: `plain:${roomId}:${entry.orderItemId}`,
          hotelName: '',
          roomType: '',
          passengerIds: entry.passengerIds,
          orderItemId: entry.orderItemId,
          roomFraction: entry.fraction,
        });
        newGroupsByOrder.set(entry.orderId, arr);
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
        arr.push({
          id: `shared:${sharedRoomId}:${g.orderItemId}`,
          hotelName: '',
          roomType: roomTypeCache.get(room.hotelRoomTypeId)?.name ?? '',
          passengerIds: g.passengerIds,
          orderItemId: g.orderItemId,
          roomFraction: g.roomFraction,
          sharedRoomId,
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
    const nextSharedRooms: SharedRoomAfterState[] = [];
    for (const roomId of dissolveSet) {
      nextSharedRooms.push({
        sharedRoomId: roomId,
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
        checkIn: checkInD,
        checkOut: checkOutD,
        activeMemberOrderIds: activeOrderIds,
      });
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
        data: { status: 'DISSOLVED', dissolvedAt: new Date(), dissolvedReason: '跨单分房工作台解散' },
      });
      await tx.sharedRoomMember.deleteMany({ where: { sharedRoomId: roomId } });
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
            version: { increment: 1 },
          },
          select: { id: true, version: true },
        });
        savedRooms.push({ sharedRoomId: updated.id, version: updated.version });
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

    // 每张受影响订单的审计负载（事务内收集，事务外才 writeAudit——审计不参与业务事务）。
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

      orderAuditPayloads.push({
        orderId,
        orderNumber: order.orderNumber,
        beforeRoomAssignment: order.roomAssignment,
        beforeRoomsBilled: Object.fromEntries(order.items.map((it) => [it.id, it.roomsBilled])),
        afterRoomAssignment: { roomGroups: groups },
        afterRoomsBilled,
        sharedRooms: coMemberOrderNumbersBySharedRoomId,
      });
    }

    const finalResult: SaveSharedRoomsResult = {
      rooms: savedRooms,
      dissolved: [...dissolveSet],
      warnings,
    };
    await tx.sharedRoomRequest.update({
      where: { requestToken: body.requestToken },
      data: { resultJson: finalResult as unknown as Prisma.InputJsonValue },
    });
    // 主单：受影响订单里 id 最小的一个，给 SAVE_SHARED_ROOMS 总览审计条挂载（本条本身
    // 只是「这次保存做了什么」的总览，逐单细节在上面 orderAuditPayloads 里）。
    const primaryOrderId = [...orders.keys()].sort()[0] ?? null;
    return { finalResult, orderAuditPayloads, primaryOrderId };
  });

  const { finalResult, orderAuditPayloads, primaryOrderId } = result;

  for (const payload of orderAuditPayloads) {
    void writeAudit({
      actor,
      action: 'UPDATE_ROOM_ASSIGNMENT',
      targetType: 'ORDER',
      targetId: payload.orderId,
      targetLabel: payload.orderNumber,
      before: { roomAssignment: payload.beforeRoomAssignment, roomsBilled: payload.beforeRoomsBilled },
      after: {
        roomAssignment: payload.afterRoomAssignment,
        roomsBilled: payload.afterRoomsBilled,
        sharedRooms: payload.sharedRooms,
      },
    });
  }
  if (primaryOrderId) {
    void writeAudit({
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
}
