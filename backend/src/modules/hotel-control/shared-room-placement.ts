/**
 * 档次共享房「整房落位」（2026-09-20 拍板 A：随机档未落位的单也能跨单合住）。
 *
 * 一间档次房（SharedRoom.randomStarTier 非空）的全部成员行，一起落到同一家真实酒店的同一房型；
 * 共享房本身**原地转成酒店房**（写 hotelId / hotelRoomTypeId、清 randomStarTier、version+1），
 * 成员关系与份额原样保留——不是解绑。
 *
 * 为什么不逐成员调用 orders.service 的 swapItemHotel：
 *   1. 它自己开 prisma.$transaction，N 个成员就是 N 个独立事务，中途失败没法整体回滚；
 *   2. 它对有共享成员的行**一定**先解绑（§八换酒店矩阵）——逐个调完这间房就被拆散、最后一个
 *      成员走时房间 DISSOLVED，与「整房转酒店房」的目标正相反；
 *   3. 它的前瞻闸把每个解绑后的成员当成目标酒店的一间独立普通房，三张单合住会被算成 3 间——
 *      目标酒店只剩 1 间时会被误拒，而这恰恰是整房落位最有价值的场景。
 * 所以本模块在一个事务里自己写行的落位，**定价 / 成本一律复用 orders 侧现成的纯函数**
 * （computeSwapHotelCostSnapshot / withHotelCostSource / resolveHotelStayUnitCost 等），
 * 差价固定为 0（同档落位不产生售后费，不写 adjustments）。
 *
 * 单个成员单独走「换酒店」（不走整房落位）→ 维持既有「自动解绑 + 警告」，本模块不干预。
 *
 * 住宿行 ≠ 物理房间（2026-09-20 评审 F1）：整房落位落的是**整条住宿行**——行上若还挂着本房
 * 以外的房组（普通房组 / 另一间共享房），会被一起迁走却只转本房主档。短修：锁后校验、命中 400，
 * 出路是先用「拆房组」把别的房组拆成独立住宿行；按本房成员拆行再迁的完整方案不在本模块。
 *
 * 锁序与跨单分房保存一致：Order（按 id 升序；本房成员单 ∪ 同住宿行其它共享房的成员单）→
 * SharedRoom（按 id 升序；本房 ∪ 同住宿行其它共享房）→ 目标酒店包房周期
 * （assertHotelFitAfterChange 内部最后才锁）。
 */
import { OrderItemKind, Prisma, type OrderStatus, type PrismaClient, type SettlementTier } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import type { AuditActor } from '../../lib/audit.js';
import { writeAuditWithinTx } from '../../lib/audit.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  buildHotelCostSourceSnapshot,
  loadHotelCostFxRatesIfNeeded,
  resolveHotelStayUnitCost,
} from '../finances/hotel-cost.service.js';
import {
  SEAT_HOLDING_STATUSES,
  buildStarMismatchMessage,
  computeSwapHotelCostSnapshot,
  isSettlementTierStarMismatch,
  withHotelCostSource,
} from '../orders/orders.service.js';
import {
  randomStarTierLabel as pendingPlacementLabel,
  randomStarTierShortLabel as pendingPlacementShortLabel,
  readRoomGroupArray,
  refreshRoomGroupsForItem,
  resolveRoomGroupPlacement,
  roomGroupItemId,
} from '../orders/room-group-placement.js';
import {
  assertHotelFitAfterChange,
  isCountedOrder,
  randomStarTierLabel,
  type PhysicalOccupancyItem,
  type SharedRoomAfterState,
} from './hotel-control.service.js';
import type { PlaceSharedRoomBody } from './hotel-control.schemas.js';
import { groupSharedId, itemPendingTier } from './hotel-control.shared-rooms.js';

export interface PlaceSharedRoomResult {
  sharedRoomId: string;
  version: number;
  hotelId: string;
  hotelRoomTypeId: string;
  hotelName: string;
  roomTypeName: string;
  /** 本次一起落位的成员行。*/
  placedItems: Array<{ orderId: string; orderNumber: string; orderItemId: string }>;
  warnings: string[];
}

/** Prisma @db.Date（UTC 0:00）→ 'YYYY-MM-DD'。*/
function fmtDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** [checkIn, checkOut) 逐晚 YYYY-MM-DD（口径同 hotel-control.shared-rooms.ts 的 expandNights）。*/
function expandNights(checkIn: Date, checkOut: Date): string[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const start = checkIn.getTime();
  const end = checkOut.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const nights = Math.round((end - start) / DAY_MS);
  return Array.from({ length: nights }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

interface MemberItemRow {
  id: string;
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  orderDeletedAt: Date | null;
  roomAssignment: unknown;
  kind: OrderItemKind;
  description: string;
  quantity: number;
  hotelRoomTypeId: string | null;
  randomStarTier: number | null;
  placeholderTier: number | null;
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
  roomsBilled: Prisma.Decimal | null;
  unitCostCny: Prisma.Decimal | null;
  totalCostCny: Prisma.Decimal | null;
  metadata: unknown;
  bundle: { id: string; name: string | null; settlementTier: SettlementTier | null } | null;
  /** 占座人数（成人 + 儿童，指定酒店加价按它计）；婴儿证件号 N/A 不计。*/
  seatPax: number;
}

/**
 * 「同住宿行的其它共享房」：本房成员行（orderItemId）上还挂着的其它活跃共享房，及这些房的
 * 全部成员订单。成员表是真值（订单 JSON 里的 sharedRoomId 只是镜像，下面行独占校验里两边取并集）。
 * 锁前用它扩大候选锁集合（Order ∪ SharedRoom）；锁后再查一次核实集合没有扩大（§六步骤 3 同款）。
 */
interface SiblingSharedRooms {
  roomIds: string[];
  orderIds: string[];
  /** orderItemId → 该行上挂着的其它活跃共享房 id。*/
  byItemId: ReadonlyMap<string, ReadonlySet<string>>;
}

async function loadSiblingSharedRooms(
  db: Pick<Prisma.TransactionClient, 'sharedRoomMember'>,
  sharedRoomId: string,
  itemIds: readonly string[],
): Promise<SiblingSharedRooms> {
  const empty: SiblingSharedRooms = { roomIds: [], orderIds: [], byItemId: new Map() };
  if (itemIds.length === 0) return empty;
  const onSameItems = await db.sharedRoomMember.findMany({
    where: {
      orderItemId: { in: [...itemIds] },
      sharedRoomId: { not: sharedRoomId },
      sharedRoom: { status: 'ACTIVE' },
    },
    select: { sharedRoomId: true, orderItemId: true },
  });
  if (onSameItems.length === 0) return empty;
  const byItemId = new Map<string, Set<string>>();
  for (const m of onSameItems) {
    const set = byItemId.get(m.orderItemId) ?? new Set<string>();
    set.add(m.sharedRoomId);
    byItemId.set(m.orderItemId, set);
  }
  const roomIds = [...new Set(onSameItems.map((m) => m.sharedRoomId))].sort();
  const members = await db.sharedRoomMember.findMany({
    where: { sharedRoomId: { in: roomIds } },
    select: { orderId: true },
  });
  return { roomIds, orderIds: [...new Set(members.map((m) => m.orderId))].sort(), byItemId };
}

export async function placeSharedRoom(
  sharedRoomId: string,
  body: PlaceSharedRoomBody,
  actor: AuditActor,
  client: PrismaClient = defaultPrisma,
): Promise<PlaceSharedRoomResult> {
  // 锁前候选：本房成员订单 ∪ 同住宿行其它共享房及其成员订单（锁后复核，扩大则 409 让调用方
  // 刷新重试——整房落位不是高频操作，不做自动重试）
  const preRoom = await client.sharedRoom.findUnique({
    where: { id: sharedRoomId },
    select: { id: true, members: { select: { orderId: true, orderItemId: true } } },
  });
  if (!preRoom) throw new NotFoundError('共享房不存在');
  const preSiblings = await loadSiblingSharedRooms(client, sharedRoomId, [
    ...new Set(preRoom.members.map((m) => m.orderItemId)),
  ]);
  const candidateOrderIds = [
    ...new Set([...preRoom.members.map((m) => m.orderId), ...preSiblings.orderIds]),
  ].sort();
  const candidateRoomIds = [...new Set([sharedRoomId, ...preSiblings.roomIds])].sort();

  return client.$transaction(async (tx) => {
    for (const orderId of candidateOrderIds) {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    }
    for (const roomId of candidateRoomIds) {
      await tx.$queryRaw`SELECT id FROM "SharedRoom" WHERE id = ${roomId} FOR UPDATE`;
    }

    const room = await tx.sharedRoom.findUnique({
      where: { id: sharedRoomId },
      select: {
        id: true,
        status: true,
        version: true,
        hotelId: true,
        randomStarTier: true,
        checkIn: true,
        checkOut: true,
        members: { select: { orderId: true, orderItemId: true, passengerId: true, roomFraction: true } },
      },
    });
    if (!room) throw new NotFoundError('共享房不存在');
    if (room.version !== body.expectedVersion) {
      throw new ConflictError('该房间已被他人修改，请刷新后重试');
    }
    if (room.status !== 'ACTIVE') throw new BadRequestError('共享房已解散，不能整房落位');
    if (room.randomStarTier == null || room.hotelId != null) {
      throw new BadRequestError('这间共享房已经是酒店房，不需要整房落位');
    }
    const tier = room.randomStarTier;
    const memberOrderIds = [...new Set(room.members.map((m) => m.orderId))].sort();
    if (memberOrderIds.length === 0) throw new BadRequestError('共享房没有成员，请先解散');
    if (memberOrderIds.some((oid) => !candidateOrderIds.includes(oid))) {
      throw new ConflictError('共享房成员在落位过程中发生变化，请刷新后重试');
    }
    const memberItemIds = [...new Set(room.members.map((m) => m.orderItemId))];
    // 锁后复核「同住宿行的其它共享房」（与上面成员订单集合的复核同款）：只有锁前发现的房间 /
    // 订单在锁集合里，锁后多出来的没被锁住、读到的不是稳定快照 → 409 让调用方刷新重试。
    const siblings = await loadSiblingSharedRooms(tx, room.id, memberItemIds);
    if (
      siblings.roomIds.some((rid) => !candidateRoomIds.includes(rid)) ||
      siblings.orderIds.some((oid) => !candidateOrderIds.includes(oid))
    ) {
      throw new ConflictError('共享房成员的住宿行在落位过程中发生变化，请刷新后重试');
    }

    // ── 目标房型：真实酒店、在架、星级不低于档次 ────────────────────────────
    const newRoomType = await tx.hotelRoomType.findUnique({
      where: { id: body.hotelRoomTypeId },
      select: {
        id: true,
        name: true,
        hotelId: true,
        capacity: true,
        costPriceCny: true,
        costPriceVnd: true,
        costFxName: true,
        costPeriods: {
          select: { effectiveFrom: true, effectiveTo: true, costPriceCny: true, costPriceVnd: true, costFxName: true },
        },
        hotel: {
          select: {
            name: true,
            isActive: true,
            starRating: true,
            intlFiveStar: true,
            randomTierPlaceholder: true,
            designationSurchargeCnyPerPerson: true,
          },
        },
      },
    });
    if (!newRoomType) throw new NotFoundError('酒店房型不存在');
    if (newRoomType.hotel.randomTierPlaceholder != null) {
      throw new BadRequestError('目标是随机档占位酒店，不是真实酒店，不能落位');
    }
    if (!newRoomType.hotel.isActive) throw new BadRequestError('酒店已下架');
    if (newRoomType.hotel.starRating < tier) {
      throw new BadRequestError(
        `${randomStarTierLabel(tier)}只能落到 ${tier} 星及以上的酒店（所选酒店为 ${newRoomType.hotel.starRating} 星）`,
      );
    }

    // ── 成员行锁后重读 ────────────────────────────────────────────────────
    const rows = await tx.orderItem.findMany({
      where: { id: { in: memberItemIds } },
      select: {
        id: true,
        kind: true,
        description: true,
        quantity: true,
        hotelRoomTypeId: true,
        randomStarTier: true,
        hotelCheckIn: true,
        hotelCheckOut: true,
        roomsBilled: true,
        unitCostCny: true,
        totalCostCny: true,
        metadata: true,
        hotelRoomType: { select: { hotel: { select: { randomTierPlaceholder: true } } } },
        bundle: { select: { id: true, name: true, settlementTier: true } },
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            deletedAt: true,
            roomAssignment: true,
            passengers: { select: { documentNumber: true } },
          },
        },
      },
    });
    const items: MemberItemRow[] = rows.map((r) => ({
      id: r.id,
      orderId: r.order.id,
      orderNumber: r.order.orderNumber,
      orderStatus: r.order.status,
      orderDeletedAt: r.order.deletedAt,
      roomAssignment: r.order.roomAssignment,
      kind: r.kind,
      description: r.description,
      quantity: r.quantity,
      hotelRoomTypeId: r.hotelRoomTypeId,
      randomStarTier: r.randomStarTier,
      placeholderTier: r.hotelRoomType?.hotel?.randomTierPlaceholder ?? null,
      hotelCheckIn: r.hotelCheckIn,
      hotelCheckOut: r.hotelCheckOut,
      roomsBilled: r.roomsBilled,
      unitCostCny: r.unitCostCny,
      totalCostCny: r.totalCostCny,
      metadata: r.metadata,
      bundle: r.bundle ? { id: r.bundle.id, name: r.bundle.name, settlementTier: r.bundle.settlementTier } : null,
      seatPax: r.order.passengers.filter((p) => p.documentNumber !== 'N/A').length,
    }));
    if (items.length !== memberItemIds.length) {
      throw new ConflictError('共享房成员对应的订单行已不存在，请刷新后重试');
    }

    // ── 成员行逐条校验（任一不过整体 400，列出是谁）──────────────────────────
    const failures: string[] = [];
    for (const it of items) {
      if (it.orderDeletedAt != null || !SEAT_HOLDING_STATUSES.includes(it.orderStatus)) {
        failures.push(`${it.orderNumber} 已不是有效订单，请先在工作台把它移出共享房`);
        continue;
      }
      if (itemPendingTier(it) !== tier) {
        failures.push(`${it.orderNumber} 的住宿行已不是${randomStarTierLabel(tier)}未落位状态`);
        continue;
      }
      if (
        !it.hotelCheckIn ||
        !it.hotelCheckOut ||
        it.hotelCheckIn.getTime() !== room.checkIn.getTime() ||
        it.hotelCheckOut.getTime() !== room.checkOut.getTime()
      ) {
        failures.push(`${it.orderNumber} 的住宿区间与共享房不一致`);
      }
    }
    if (failures.length > 0) {
      throw new BadRequestError(`整房落位未执行：${failures.join('；')}`);
    }

    // ── 住宿行 ≠ 物理房间：每位成员的住宿行必须只承载本共享房（短修：拒绝，不拆行）────────
    // 下面的落库是「整条住宿行落到目标房型」：行上若还挂着别的房组（普通房组 / 另一间共享房），
    // 它们会一起被迁走、房组文本一起刷成目标酒店，但只有本房主档转酒店房、目标物理占用也只计
    // 本房 1 间——另一间共享房的成员 / 主档 / 订单行随即不一致。完整做法是按本房成员拆出住宿行
    // 再迁（份额 / 成本 / 成员引用同步），本次不做。校验在锁后现状上做（与 CAS 同处，避免
    // TOCTOU）：订单 JSON（归属本行的房组）与成员表（同行挂着的其它活跃共享房）取并集。
    // 无归属（orderItemId 空）的房组不天然属于任何一行，但若其 hotelName 恰好是本档的随机占位
    // 文案（旧数据 / 手改 JSON 留下的、事实上就是这行落位前的自己），也当成「本行还承载着别的
    // 房组」一并拒绝——不然它既不参与行独占校验，落位后也没人去刷新它（2026-09-20 复审 N3）。
    // 注意：这里必须用 room-group-placement.ts 的 randomStarTierLabel（别名 pendingPlacementLabel，
    // 落「X星随机（待落位）」的全文案，写进房组 JSON 的正是这个函数）——不是同名从
    // hotel-control.service.ts 引入的短展示名「X星随机」（用户提示语用的那个，两者故意不同，
    // 混用会导致文本比对永远不命中）。
    const pendingGroupLabel = pendingPlacementLabel(tier);
    // 存量房组还有落位名改造前写的短文案「X星随机」（无「（待落位）」后缀），一并认（复审 R4）。
    const pendingGroupLabels = new Set([pendingGroupLabel, pendingPlacementShortLabel(tier)]);
    const isOrphanPendingName = (v: unknown) => typeof v === 'string' && pendingGroupLabels.has(v);
    const lineConflicts: string[] = [];
    for (const it of items) {
      const allGroups = readRoomGroupArray(it.roomAssignment) ?? [];
      const ownGroups = allGroups
        .filter((g) => roomGroupItemId(g) === it.id)
        .map((g) => g as Record<string, unknown>);
      const orphanPendingGroups = allGroups
        .filter(
          (g): g is Record<string, unknown> =>
            g != null &&
            typeof g === 'object' &&
            !Array.isArray(g) &&
            roomGroupItemId(g) == null &&
            isOrphanPendingName((g as Record<string, unknown>).hotelName),
        );
      const plainGroupCount =
        ownGroups.filter((g) => groupSharedId(g) == null).length + orphanPendingGroups.length;
      const otherSharedRoomIds = new Set<string>(
        ownGroups.map((g) => groupSharedId(g)).filter((sid): sid is string => sid != null && sid !== room.id),
      );
      for (const sid of siblings.byItemId.get(it.id) ?? []) otherSharedRoomIds.add(sid);
      if (plainGroupCount === 0 && otherSharedRoomIds.size === 0) continue;
      const carried = [
        ...(plainGroupCount > 0 ? [`${plainGroupCount} 个普通房组`] : []),
        ...(otherSharedRoomIds.size > 0 ? [`${otherSharedRoomIds.size} 间其它共享房`] : []),
      ].join('、');
      lineConflicts.push(`${it.orderNumber} 的住宿行「${it.description}」还承载 ${carried}`);
    }
    if (lineConflicts.length > 0) {
      throw new BadRequestError(
        `整房落位未执行：${lineConflicts.join('；')}。整房落位会把整条住宿行连同上面的全部房组一起迁到目标酒店，` +
          '请先在该单金额明细里对这条住宿行用「拆房组」，把本房以外的房组拆成独立住宿行，再回来整房落位',
      );
    }

    // ── 差价必须为 0：指定酒店加价 / 套餐档次与酒店星级不符 → 整体拒绝并列出是谁 ──────
    // 同档落位不产生售后费（差价固定 0，不写 adjustments）；目标酒店若有指定酒店加价，
    // 按录单口径每人都该补钱——整房落位不替运营做这个定价决定，请走单单换酒店手填差价。
    const surcharge = Math.max(0, Math.trunc(Number(newRoomType.hotel.designationSurchargeCnyPerPerson) || 0));
    if (surcharge > 0) {
      const who = items.map((it) => `${it.orderNumber}（${it.seatPax} 人，¥${surcharge * it.seatPax}）`).join('、');
      throw new BadRequestError(
        `目标酒店「${newRoomType.hotel.name}」有指定酒店加价 ¥${surcharge}/人，整房落位要求差价为 0；涉及：${who}。` +
          '如确需落到该酒店，请逐单走「换酒店」并手填差价',
      );
    }
    const starMismatches = items
      .filter(
        (it) =>
          it.kind === OrderItemKind.BUNDLE &&
          it.bundle?.settlementTier != null &&
          isSettlementTierStarMismatch(it.bundle.settlementTier, newRoomType.hotel),
      )
      .map((it) => `${it.orderNumber}：${buildStarMismatchMessage(it.bundle!.settlementTier!, newRoomType.hotel)}`);
    if (starMismatches.length > 0) {
      throw new BadRequestError(`整房落位未执行（套餐档次与酒店星级不符）：${starMismatches.join('；')}`);
    }

    // ── §五闸：目标酒店变更前后全量比较（共享房整间去重计 1，不是 N 个普通房）────────
    const nightDates = expandNights(room.checkIn, room.checkOut);
    const affectedOrderIds = memberOrderIds;
    const otherItemsAtTarget = await tx.orderItem.findMany({
      where: {
        orderId: { in: affectedOrderIds },
        id: { notIn: memberItemIds },
        hotelRoomType: { hotelId: newRoomType.hotelId },
      },
      select: { id: true, orderId: true, hotelCheckIn: true, hotelCheckOut: true, metadata: true },
    });
    const roomAssignmentByOrder = new Map<string, unknown>();
    for (const it of items) roomAssignmentByOrder.set(it.orderId, it.roomAssignment);
    const nextOrderItems = new Map<string, PhysicalOccupancyItem[]>();
    const pushNext = (orderId: string, entry: PhysicalOccupancyItem): void => {
      const arr = nextOrderItems.get(orderId) ?? [];
      arr.push(entry);
      nextOrderItems.set(orderId, arr);
    };
    for (const it of otherItemsAtTarget) {
      pushNext(it.orderId, {
        id: it.id,
        hotelId: newRoomType.hotelId,
        hotelCheckIn: it.hotelCheckIn,
        hotelCheckOut: it.hotelCheckOut,
        roomsBilled: null,
        metadata: it.metadata,
        order: { id: it.orderId, roomAssignment: roomAssignmentByOrder.get(it.orderId) ?? null, passengers: [] },
      });
    }
    for (const it of items) {
      pushNext(it.orderId, {
        id: it.id,
        hotelId: newRoomType.hotelId,
        hotelCheckIn: it.hotelCheckIn,
        hotelCheckOut: it.hotelCheckOut,
        roomsBilled: null,
        metadata: it.metadata,
        order: { id: it.orderId, roomAssignment: it.roomAssignment, passengers: [] },
      });
    }
    for (const orderId of affectedOrderIds) {
      if (!nextOrderItems.has(orderId)) nextOrderItems.set(orderId, []);
    }
    const activeMemberOrderIds = [
      ...new Set(
        items
          .filter((it) => isCountedOrder({ deletedAt: it.orderDeletedAt, status: it.orderStatus }))
          .map((it) => it.orderId),
      ),
    ];
    const nextSharedRooms: SharedRoomAfterState[] = [
      {
        sharedRoomId: room.id,
        hotelId: newRoomType.hotelId,
        checkIn: room.checkIn,
        checkOut: room.checkOut,
        activeMemberOrderIds,
      },
    ];
    await assertHotelFitAfterChange(tx, newRoomType.hotelId, nightDates, {
      affectedOrderIds,
      nextOrderItems,
      nextSharedRooms,
      options: { allowNonWorsening: true },
    });

    // ── 落库：逐行落位（复用换酒店的成本快照口径）+ 房组文本刷新 + 共享房转酒店房 ──
    const fxRates = await loadHotelCostFxRatesIfNeeded(
      { periodsMap: new Map([[newRoomType.id, newRoomType.costPeriods]]), bases: [newRoomType] },
      tx,
    );
    const placement = resolveRoomGroupPlacement({ hotelRoomType: newRoomType });
    const roomAssignmentPatches = new Map<string, unknown>();
    const placedItems: PlaceSharedRoomResult['placedItems'] = [];
    for (const it of items) {
      const roomsBilled = it.roomsBilled != null ? Number(it.roomsBilled.toString()) : 1;
      // HOTEL 行：成本按新房型重打（口径同 swapItemHotel）；BUNDLE 行不重算（建单时未快照酒店成本）。
      const swapUnit =
        it.kind === OrderItemKind.HOTEL
          ? resolveHotelStayUnitCost({
              periods: newRoomType.costPeriods,
              baseCostCny: newRoomType.costPriceCny,
              baseCostVnd: newRoomType.costPriceVnd,
              baseFxName: newRoomType.costFxName,
              fxRates,
              checkIn: it.hotelCheckIn,
              checkOut: it.hotelCheckOut,
            })
          : null;
      const swapCost = swapUnit
        ? computeSwapHotelCostSnapshot({ newCostPriceCny: swapUnit.unitCostCny, nights: it.quantity, rooms: roomsBilled })
        : null;
      const swapMetadata = swapUnit
        ? withHotelCostSource(
            (it.metadata ?? null) as Record<string, unknown> | null,
            buildHotelCostSourceSnapshot(swapUnit.detail),
          )
        : undefined;
      // HOTEL 行按创建期同款格式重建 description；BUNDLE 行不含酒店名，不用重建（同 swapItemHotel）。
      let description = it.description;
      if (it.kind === OrderItemKind.HOTEL && it.hotelCheckIn && it.hotelCheckOut) {
        const roomsLabel = Number.isInteger(roomsBilled) ? String(roomsBilled) : roomsBilled.toFixed(1);
        description =
          `${newRoomType.hotel.name} · ${newRoomType.name} · ` +
          `${fmtDateOnly(it.hotelCheckIn)}~${fmtDateOnly(it.hotelCheckOut)} · ` +
          `${nightDates.length}晚 × ${roomsLabel}间`;
      }
      await tx.orderItem.update({
        where: { id: it.id },
        data: {
          hotelRoomTypeId: newRoomType.id,
          randomStarTier: null, // 占用从「未落位」转到该酒店，随机档合计不变
          description,
          ...(swapCost
            ? {
                unitCostCny: swapCost.unitCostCny != null ? new Prisma.Decimal(swapCost.unitCostCny) : null,
                totalCostCny: swapCost.totalCostCny != null ? new Prisma.Decimal(swapCost.totalCostCny) : null,
                ...(swapMetadata ? { metadata: swapMetadata as Prisma.InputJsonValue } : {}),
              }
            : {}),
        },
      });
      placedItems.push({ orderId: it.orderId, orderNumber: it.orderNumber, orderItemId: it.id });

      // 分房表里归属本行的房组 → 改名到新酒店 + 新房型（共享组 sharedRoomId 原样保留，不解绑）。
      // legacyMatch 与换酒店 / 套餐改档同款口径（orders.service.ts 换酒店、套餐改档两处）：本行没有
      // 任何归属组时，才对「无归属 + hotelName 恰好是落位前的随机占位文案」的房组做旧文本匹配——
      // 行独占校验已经把这类房组算进 plainGroupCount 挡在前面，这里只是同一口径的兜底，不指望它
      // 成为常态路径（2026-09-20 复审 N3）。
      if (placement) {
        const current = roomAssignmentPatches.get(it.orderId) ?? it.roomAssignment;
        const refreshed = refreshRoomGroupsForItem(current, it.id, placement, {
          legacyMatch: (g) => isOrphanPendingName(g.hotelName),
        });
        if (refreshed.changed) roomAssignmentPatches.set(it.orderId, refreshed.roomAssignment);
      }
    }
    for (const [orderId, roomAssignment] of roomAssignmentPatches) {
      await tx.order.update({
        where: { id: orderId },
        data: { roomAssignment: roomAssignment as Prisma.InputJsonValue },
      });
    }
    const warnings: string[] = [];
    if (newRoomType.capacity > 0 && room.members.length > newRoomType.capacity) {
      warnings.push(
        `房型容量 ${newRoomType.capacity} 人，这间房现有 ${room.members.length} 人，超出容量提示（不拦截）`,
      );
    }

    const updated = await tx.sharedRoom.update({
      where: { id: room.id },
      data: {
        hotelId: newRoomType.hotelId,
        hotelRoomTypeId: newRoomType.id,
        randomStarTier: null,
        version: { increment: 1 },
      },
      select: { id: true, version: true },
    });

    // ── 审计：逐单一条 SWAP_ORDER_ITEM_HOTEL（房控「近期用房变更」按这个动作读）+ 总览一条 ──
    // 审计用短展示名「X星随机」（hotel-control.service.ts 的 randomStarTierLabel），不是上面
    // 行独占校验/legacyMatch 用来比对房组 JSON 文本的 pendingGroupLabel（带「（待落位）」后缀）。
    const beforeLabel = randomStarTierLabel(tier);
    for (const it of items) {
      await writeAuditWithinTx(tx, {
        actor,
        action: 'SWAP_ORDER_ITEM_HOTEL',
        targetType: 'ORDER',
        targetId: it.orderId,
        targetLabel: it.orderNumber,
        before: {
          orderItemId: it.id,
          hotelRoomTypeId: it.hotelRoomTypeId,
          hotelName: beforeLabel,
          roomTypeName: null,
          unitCostCny: it.unitCostCny != null ? Number(it.unitCostCny.toString()) : null,
          totalCostCny: it.totalCostCny != null ? Number(it.totalCostCny.toString()) : null,
        },
        after: {
          hotelRoomTypeId: newRoomType.id,
          hotelName: newRoomType.hotel.name,
          roomTypeName: newRoomType.name,
          feeCny: 0,
          sharedRoomId: room.id,
          source: 'SHARED_ROOM_PLACE',
        },
        severity: 'WARNING',
      });
    }
    await writeAuditWithinTx(tx, {
      actor,
      action: 'PLACE_SHARED_ROOM',
      targetType: 'ORDER',
      targetId: memberOrderIds[0]!,
      targetLabel: `${beforeLabel} → ${newRoomType.hotel.name} · ${newRoomType.name} ${fmtDateOnly(room.checkIn)}→${fmtDateOnly(room.checkOut)}`,
      before: { sharedRoomId: room.id, randomStarTier: tier, version: room.version },
      after: {
        sharedRoomId: room.id,
        hotelId: newRoomType.hotelId,
        hotelRoomTypeId: newRoomType.id,
        version: updated.version,
        orderIds: memberOrderIds,
        orderItemIds: memberItemIds,
      },
      severity: 'WARNING',
    });

    return {
      sharedRoomId: updated.id,
      version: updated.version,
      hotelId: newRoomType.hotelId,
      hotelRoomTypeId: newRoomType.id,
      hotelName: newRoomType.hotel.name,
      roomTypeName: newRoomType.name,
      placedItems,
      warnings,
    };
  });
}
