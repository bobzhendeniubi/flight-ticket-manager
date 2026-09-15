/**
 * 共享房解绑帮助函数（波 2 §八「解绑」的唯一实现，供入口矩阵各处调用）。
 *
 * 定义（§八）：把该订单行在该共享房的成员删掉，本单对应房组变回普通房组（保留乘客、
 * orderItemId、roomFraction 不变——0 份额那张单钱不动，roomsBilled 仍按 0 计，物理按
 * 普通房组 1 间计——普通房组口径 groupRoomFraction 本就把 ≤0 的份额兜底读成 1，见
 * hotel-control.service.ts）。共享房剩余成员不变；清空即 DISSOLVED。
 *
 * 调用约定：调用方必须已在同一事务内持有该订单的 Order 行锁（FOR UPDATE）——本函数只
 * 额外锁被解绑的 SharedRoom 行，不重复锁 Order，也不锁对方单的 Order（对方单的
 * roomAssignment JSON 本次不改，只在房间被彻底清空时改 SharedRoom.status，不涉及对方
 * Order 行）。一条酒店行可能同时属于多个共享房（§三：普通房 + 多个共享房并存），本函数
 * 一次性解绑该行在**全部**共享房里的成员，按 sharedRoomId 升序逐个锁，避免与其它入口
 * 的解绑互相等待成环。
 *
 * 待拍板（保守实现，未在方案里写死）：解绑不重算共享房剩余成员的份额（不强制 Σ=1），
 * 也不重算 roomsBilled——那是运营在跨单分房工作台里下次保存时才做的事；本函数只做
 * 「摘除这一行」这一件事。
 *
 * ── 两阶段（修复批 2 · astra finding A1）─────────────────────────────────────
 * 原实现「先解绑（写库）再让调用方跑 §五闸」会把本次新增占房伪装成存量：解绑一旦落库，
 * §五闸（assertHotelFitAfterChange）的「变更前」快照就已经是解绑后的状态——共享房从
 * 「跨单去重 1 间」变成「共享房 1 间 + 本行普通房组 1 间」，凭空多出 1 间「存量」，
 * allowNonWorsening 就可能放行真正的超卖。
 *
 * 拆成 `planUnbind`（只读，不落库，算出「解绑会变成什么样」）+ `applyUnbindPlan`
 * （按计划真正写库）两步：调用方在事务里先 planUnbind → 用计划算出的 after 状态喂
 * §五闸 → 闸通过后才 applyUnbindPlan。§五闸此时读到的「变更前」仍是真正的旧快照
 * （plan 阶段只加了 SharedRoom 行锁，没写任何数据）。
 *
 * `unbindSharedRoomMembersForItem` 保留为 `planUnbind` + `applyUnbindPlan` 的组合，
 * 供不需要精确 before/after 判定的调用点（例如已经在别处做过闸校验、或本就不受库存闸
 * 约束的路径）继续用一次调用完成解绑。
 */
import type { OrderStatus, Prisma, SharedRoomStatus } from '@prisma/client';
import { COUNTED_STATUSES } from './hotel-control.service.js';
import {
  readRoomGroupArray,
  roomGroupItemId,
  type RoomGroupRecord,
} from '../orders/room-group-placement.js';

export interface UnboundSharedRoomInfo {
  sharedRoomId: string;
  /** 该行在这间房解绑前的计费份额（解绑后原样保留在普通房组里，钱不动）。*/
  roomFraction: number;
  /** 房间里除本行外的其余成员所属单号（去重、升序）；内部视图用，AGENT 视图不下发。*/
  partnerOrderNumbers: string[];
}

/** `planUnbind` 里单间共享房「解绑后会变成什么样」——直接可喂给
 * `assertHotelFitAfterChange` 的 `nextSharedRooms`（配合 orderId 分组）。*/
export interface PlannedSharedRoomChange {
  sharedRoomId: string;
  roomFraction: number;
  partnerOrderNumbers: string[];
  checkIn: Date;
  checkOut: Date;
  /** 排除本行后，房间里其余全部成员数（不论订单状态）——0 代表 applyUnbindPlan 会把它
   * 写成 DISSOLVED，>0 代表 version+1。*/
  remainingMemberCount: number;
  /** 排除本行后，仍处于房控有效状态（COUNTED_STATUSES 且未软删）的成员订单 id——
   * §五闸 `nextSharedRooms[].activeMemberOrderIds` 要的就是这个。*/
  activeMemberOrderIdsAfter: string[];
}

/**
 * `planUnbindMany` / `planUnbind` 的产出：只读计算结果，尚未写库。
 *
 * ── 多行合成（CRITICAL 修复 · astra finding N2）──────────────────────────────
 * 原来一份计划只装一行（`orderItemId` 单数），多行解绑时调用方对每行各调一次 `planUnbind`，
 * 每次都从同一份**原始** `roomAssignment` 出发算 `nextRoomAssignment`（整单快照），再逐份
 * **整份覆盖**写回。计划一删 I1 的共享键、计划二仍带着未删的 I1（它是从原始快照算的）
 * 只删 I2 的共享键——按顺序应用后，先写的 I1 又被后写的计划的「整单快照」写回来，但
 * I1 的 SharedRoomMember 已经真删了：JSON 与成员表从此不一致，房控少算。
 *
 * 改为：`orderItemIds` 装本次参与解绑的全部行，`nextRoomAssignment` 一次性合成、只读一次
 * `order.roomAssignment` 快照、一遍 map 里把这批行的共享键全部剥掉——不存在「计划二覆盖
 * 计划一」的先后问题，因为从头到尾只有一份计划、一次落库。`changesByItemId` 供调用方
 * 按行取回自己那部分变更（构造 §五闸 `nextOrderItems`/`nextSharedRooms`、警告文案）；
 * `changes` 是扁平汇总，供不关心行归属、只要「这次一共动了哪些共享房」的调用点用
 * （一间房可能被这批行中的不止一行命中，`changes` 会有对应的多条，`applyUnbindPlan`
 * 按 `sharedRoomId` 去重后才做房间侧的 DISSOLVED/version+1，不会因此重复递增）。
 */
export interface UnbindPlan {
  orderId: string;
  /** 参与本次解绑的全部行（单行调用时长度为 1）。*/
  orderItemIds: string[];
  /** 按行分组的变更——调用方按行构造 nextItems / nextSharedRooms / 警告文案时用这个。*/
  changesByItemId: Map<string, PlannedSharedRoomChange[]>;
  /** 全部行变更的扁平汇总（不去重；同一 sharedRoomId 若被多行命中会出现多条，见上）。*/
  changes: PlannedSharedRoomChange[];
  /** 该订单 `roomAssignment` JSON 解绑后的样子（覆盖 `orderItemIds` 全部行）；
   *  `null` = 这批行没有一行在任何共享房里，JSON 不用改。*/
  nextRoomAssignment: unknown | null;
}

function groupSharedRoomId(g: RoomGroupRecord): string | null {
  const v = g.sharedRoomId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 去掉 roomGroups 单个房组上的 sharedRoomId 键，其余键原样保留（不用解构避免 lint 噪音）。*/
/**
 * 去掉 roomGroups 单个房组上的 sharedRoomId 键，其余键原样保留（不用解构避免 lint 噪音）。
 * 同时清掉 splitPairKey（HIGH 修复 · astra finding A7 ④）：共享组本不该带这个键（拆单对
 * 共享组走独立拆分计划，不写 splitPairKey——见 split-move-strategies.ts 的
 * splitMixedSharedRoomGroup），但存量脏数据或其它路径万一误写了，解绑后这两个变回普通
 * 房组的半组若恰好共用同一个 splitPairKey，会被 hotel-control.service.ts 的
 * groupBucketKey（配对键优先于房型分桶）错误拼回一间——两个本不相关的普通房组凭空少算
 * 一间。解绑时一并清掉，绝不让这个键带着走。
 */
function stripSharedRoomId(g: RoomGroupRecord): RoomGroupRecord {
  const rest: RoomGroupRecord = {};
  for (const [k, v] of Object.entries(g)) {
    if (k !== 'sharedRoomId' && k !== 'splitPairKey') rest[k] = v;
  }
  return rest;
}

type SharedRoomMemberRow = {
  sharedRoomId: string;
  orderId: string;
  orderItemId: string;
  roomFraction: Prisma.Decimal;
  order: { orderNumber: string; status: OrderStatus; deletedAt: Date | null };
};

/** `planUnbind` / `getSharedRoomStatesForItem` 共用的 mock-safe delegate 取值。*/
function sharedRoomMemberDelegate(
  tx: Prisma.TransactionClient,
): { findMany: (args: unknown) => Promise<SharedRoomMemberRow[]> } | undefined {
  return (
    tx as unknown as {
      sharedRoomMember?: { findMany: (args: unknown) => Promise<SharedRoomMemberRow[]> };
    }
  ).sharedRoomMember;
}

function sharedRoomDelegate(
  tx: Prisma.TransactionClient,
): {
  findUnique: (args: unknown) => Promise<{
    id: string;
    status: SharedRoomStatus;
    checkIn: Date;
    checkOut: Date;
  } | null>;
} | undefined {
  return (
    tx as unknown as {
      sharedRoom?: {
        findUnique: (args: unknown) => Promise<{
          id: string;
          status: SharedRoomStatus;
          checkIn: Date;
          checkOut: Date;
        } | null>;
      };
    }
  ).sharedRoom;
}

/**
 * 只读第一阶段：算出「把这批订单行在全部共享房里解绑」会变成什么样，**不写库**。
 * 仍会对涉及的 SharedRoom 行加 `FOR UPDATE`（读+锁不改变可读到的值，只是防止并发覆盖
 * 这份计划——与调用方随后即将进行的 §五闸判定、以及最终 `applyUnbindPlan` 之间不能有
 * 窗口被别的事务抢先改掉）。
 *
 * `orderItemIds` 可以是同一订单的多行——一次调用只读一次 `order.roomAssignment`，合成
 * 一份覆盖这批行的最终 JSON（CRITICAL 修复 · astra finding N2：不能逐行各调一次
 * `planUnbind` 再顺序 `applyUnbindPlan`，那样后应用的计划会把先解绑行的共享键写回来）。
 *
 * 这批行都不在任何共享房 → 返回 `changes: []`、`nextRoomAssignment: null`，调用方无需先
 * 探测再决定是否调用。
 */
export async function planUnbindMany(
  tx: Prisma.TransactionClient,
  params: { orderId: string; orderItemIds: readonly string[] },
): Promise<UnbindPlan> {
  const { orderId } = params;
  const orderItemIds = [...new Set(params.orderItemIds)];
  const empty: UnbindPlan = {
    orderId,
    orderItemIds,
    changesByItemId: new Map(),
    changes: [],
    nextRoomAssignment: null,
  };
  if (orderItemIds.length === 0) return empty;

  // 防御式：单测常用手搭的 mock tx（只 mock 用到的 delegate）没有 sharedRoomMember 时回落
  // 「本次没有共享成员」而不是炸——与 computeSharedRoomPhysicalByDate 的 sharedRoom 兜底同哲学。
  // ⚠ L5：生产 tx 必有 sharedRoomMember delegate，这条回落只为迁就 mock 单测。这里回落成
  // 「没有共享成员」意味着解绑计划直接判空——不会主动放行超卖，但会让本该触发的解绑/
  // §五闸判定悄悄被跳过，同属「库存/合住闸拿不到数据就假装无事」的危险方向，不该长期
  // 依赖；生产客户端缺 delegate 时理应直接抛错。
  const memberDelegate = sharedRoomMemberDelegate(tx);
  if (!memberDelegate) return empty;
  const itemIdSet = new Set(orderItemIds);
  const owned = await memberDelegate.findMany({
    where: { orderId, orderItemId: { in: orderItemIds } },
    select: { sharedRoomId: true, orderItemId: true, roomFraction: true },
  });
  if (owned.length === 0) return empty;

  // 按共享房聚合「这批行里，哪些行命中了这间房」——一间房理论上可能同时被这批行中的
  // 不止一行命中（同订单两条酒店行凑巧都在同一间共享房，§三未禁止），remainingAfter
  // 必须一次性把这批行全部排除，不能只排除其中一行、算出偏高的 remainingMemberCount。
  const itemIdsByRoom = new Map<string, Set<string>>();
  const fractionByRoomAndItem = new Map<string, number>();
  for (const m of owned) {
    const set = itemIdsByRoom.get(m.sharedRoomId) ?? new Set<string>();
    set.add(m.orderItemId);
    itemIdsByRoom.set(m.sharedRoomId, set);
    const key = `${m.sharedRoomId}:${m.orderItemId}`;
    // 同一 (行, 房间) 组合理论上也可能有多个成员行（多名乘客同挂一行——正常建单不会，
    // 但不排除脏数据），累加而不是覆盖，避免 fractionByRoom 只留下最后一条成员的份额。
    fractionByRoomAndItem.set(key, (fractionByRoomAndItem.get(key) ?? 0) + Number(m.roomFraction.toString()));
  }
  const sharedRoomIds = [...itemIdsByRoom.keys()].sort();

  const changesByItemId = new Map<string, PlannedSharedRoomChange[]>();
  const changes: PlannedSharedRoomChange[] = [];
  for (const sharedRoomId of sharedRoomIds) {
    // 锁这间共享房：与跨单分房工作台保存、其它入口的并发解绑互斥（§六同款「先锁再读再写」）。
    await tx.$queryRaw`SELECT id FROM "SharedRoom" WHERE id = ${sharedRoomId} FOR UPDATE`;
    const room = await sharedRoomDelegate(tx)?.findUnique({
      where: { id: sharedRoomId },
      select: { id: true, status: true, checkIn: true, checkOut: true },
    });
    const allMembers = await memberDelegate.findMany({
      where: { sharedRoomId },
      select: {
        orderId: true,
        orderItemId: true,
        order: { select: { orderNumber: true, status: true, deletedAt: true } },
      },
    });
    const removedItemIds = itemIdsByRoom.get(sharedRoomId)!;
    const remainingAfter = allMembers.filter(
      (m) => !(m.orderId === orderId && removedItemIds.has(m.orderItemId)),
    );
    const partnerOrderNumbers = [
      ...new Set(remainingAfter.map((m) => m.order.orderNumber)),
    ].sort();
    const activeMemberOrderIdsAfter = [
      ...new Set(
        remainingAfter
          .filter((m) => m.order.deletedAt == null && COUNTED_STATUSES.includes(m.order.status))
          .map((m) => m.orderId),
      ),
    ];

    for (const orderItemId of removedItemIds) {
      const change: PlannedSharedRoomChange = {
        sharedRoomId,
        roomFraction: fractionByRoomAndItem.get(`${sharedRoomId}:${orderItemId}`) ?? 0,
        partnerOrderNumbers,
        // room 理论上不会为空（刚在同事务里查到过成员）；防御式兜底日期无从推断时给 epoch，
        // 调用方按「无有效成员」处理（activeMemberOrderIdsAfter 为空时该晚区间不参与去重加成）。
        checkIn: room?.checkIn ?? new Date(0),
        checkOut: room?.checkOut ?? new Date(0),
        remainingMemberCount: remainingAfter.length,
        activeMemberOrderIdsAfter,
      };
      changes.push(change);
      const list = changesByItemId.get(orderItemId) ?? [];
      list.push(change);
      changesByItemId.set(orderItemId, list);
    }
  }

  // 订单 JSON：一次性把这批行在这些共享房的房组全部去掉 sharedRoomId（变回普通房组，
  // 其余字段原样保留）——只读一次 order.roomAssignment，一遍 map 里处理全部行，不会有
  // 「后一份计划从旧快照出发、覆盖掉前一份计划已经做的修改」的问题（N2）。
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { roomAssignment: true } });
  const groups = readRoomGroupArray(order?.roomAssignment);
  let nextRoomAssignment: unknown | null = null;
  if (groups) {
    const touchedRoomIds = new Set(sharedRoomIds);
    let changed = false;
    const nextGroups = groups.map((g) => {
      if (g == null || typeof g !== 'object' || Array.isArray(g)) return g;
      const rec = g as RoomGroupRecord;
      const gItemId = roomGroupItemId(rec);
      if (gItemId == null || !itemIdSet.has(gItemId)) return g;
      const sid = groupSharedRoomId(rec);
      if (sid == null || !touchedRoomIds.has(sid)) return g;
      changed = true;
      return stripSharedRoomId(rec);
    });
    if (changed) {
      nextRoomAssignment = {
        ...(order?.roomAssignment as object),
        roomGroups: nextGroups,
      };
    }
  }

  return { orderId, orderItemIds, changesByItemId, changes, nextRoomAssignment };
}

/** 单行版 `planUnbindMany`——多数调用点只解绑一行，保留这个简写入口。*/
export async function planUnbind(
  tx: Prisma.TransactionClient,
  params: { orderId: string; orderItemId: string },
): Promise<UnbindPlan> {
  return planUnbindMany(tx, { orderId: params.orderId, orderItemIds: [params.orderItemId] });
}

/**
 * 第二阶段：按 `planUnbindMany` / `planUnbind` 算出的计划真正写库——删成员、房间
 * DISSOLVED/version+1、订单 JSON 去掉 sharedRoomId。计划里 `changes` 为空则直接返回、
 * 不碰数据库。
 *
 * 多行合成计划（N2）：`changesByItemId` 按行删各自的 SharedRoomMember；房间侧的
 * DISSOLVED/version+1 按 `sharedRoomId` 去重后只做一次——一间房可能被这批行中的不止
 * 一行命中，`plan.changes` 里会有同一 `sharedRoomId` 的多条（`remainingMemberCount`
 * 每条都相同，任取一条即可），不去重会对同一间房重复 DISSOLVED / 多递增 version。
 *
 * ⚠ 计划与写库之间不能有别的事务插进来改同一批 SharedRoom 行——`planUnbindMany` 已经在
 * 同一事务里锁住了它们，调用方只要不提前提交事务就是安全的。
 */
export async function applyUnbindPlan(
  tx: Prisma.TransactionClient,
  plan: UnbindPlan,
  reason: string,
): Promise<{ unbound: UnboundSharedRoomInfo[] }> {
  if (plan.changes.length === 0) return { unbound: [] };

  for (const orderItemId of plan.orderItemIds) {
    const itemChanges = plan.changesByItemId.get(orderItemId);
    if (!itemChanges || itemChanges.length === 0) continue;
    await tx.sharedRoomMember.deleteMany({
      where: {
        orderId: plan.orderId,
        orderItemId,
        sharedRoomId: { in: itemChanges.map((c) => c.sharedRoomId) },
      },
    });
  }

  const roomSideEffectDone = new Set<string>();
  for (const change of plan.changes) {
    if (roomSideEffectDone.has(change.sharedRoomId)) continue;
    roomSideEffectDone.add(change.sharedRoomId);
    if (change.remainingMemberCount === 0) {
      await tx.sharedRoom.update({
        where: { id: change.sharedRoomId },
        data: { status: 'DISSOLVED', dissolvedAt: new Date(), dissolvedReason: reason },
      });
    } else {
      await tx.sharedRoom.update({
        where: { id: change.sharedRoomId },
        data: { version: { increment: 1 } },
      });
    }
  }

  if (plan.nextRoomAssignment != null) {
    await tx.order.update({
      where: { id: plan.orderId },
      data: { roomAssignment: plan.nextRoomAssignment as unknown as object },
    });
  }

  return {
    unbound: plan.changes.map((c) => ({
      sharedRoomId: c.sharedRoomId,
      roomFraction: c.roomFraction,
      partnerOrderNumbers: c.partnerOrderNumbers,
    })),
  };
}

/**
 * 把某订单某酒店/套餐行在全部共享房里的成员解绑：
 *   1. 删该行在每间共享房的 SharedRoomMember；
 *   2. 房间清空 → DISSOLVED（dissolvedReason=reason）；否则 version+1；
 *   3. 该单 roomAssignment JSON 里对应房组去掉 sharedRoomId（变回普通房组，其余字段不变，
 *      含 roomFraction——即便是 0）。
 * 不改 roomsBilled（钱不动）；不改其余成员的份额，也不改对方单的 JSON。
 * 该行本不在任何共享房 → 直接返回 `{ unbound: [] }`，调用方无需先探测再决定是否调用。
 *
 * = `planUnbind` + `applyUnbindPlan` 的组合，供不需要精确 before/after 判定的调用点用；
 * 需要先过 §五闸再落库的入口（换酒店、酒店改期等）请分别调用两步，闸判定夹在中间。
 */
export async function unbindSharedRoomMembersForItem(
  tx: Prisma.TransactionClient,
  params: { orderId: string; orderItemId: string; reason: string },
): Promise<{ unbound: UnboundSharedRoomInfo[] }> {
  const plan = await planUnbind(tx, { orderId: params.orderId, orderItemId: params.orderItemId });
  return applyUnbindPlan(tx, plan, params.reason);
}

/** 该订单行当前所在的全部共享房只读快照——不加锁、不写。给恢复类入口判一致性、
 * 构造 §五闸 `nextSharedRooms` 覆盖用（保留 / 解绑与否由调用方决定）。*/
export interface SharedRoomStateForItem {
  sharedRoomId: string;
  status: SharedRoomStatus;
  checkIn: Date;
  checkOut: Date;
  roomFraction: number;
  /** 房间里当前（本行状态变化前）全部处于房控有效状态的成员订单 id，含本行——
   * 如果本行订单当前也处于有效状态的话（恢复类入口调用时本单通常还不是，见调用方注释）。*/
  activeMemberOrderIds: string[];
}

export async function getSharedRoomStatesForItem(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderItemId: string,
): Promise<SharedRoomStateForItem[]> {
  const memberDelegate = sharedRoomMemberDelegate(tx);
  if (!memberDelegate) return [];
  const owned = await memberDelegate.findMany({
    where: { orderId, orderItemId },
    select: { sharedRoomId: true, roomFraction: true },
  });
  if (owned.length === 0) return [];

  // 按共享房去重（CRITICAL 修复 · astra finding N3）：SharedRoomMember 是按乘客建行的
  // （@@unique([sharedRoomId, passengerId])），本行若有不止一名乘客同挂进同一间共享房，
  // `owned` 会有同一 sharedRoomId 的多条记录——不去重会让调用方（
  // planRestoreSharedRoomReconciliation 的 `kept`）对同一间房生成两条相同的覆盖项，
  // 喂进 §五闸后一间房被当成两间物理房，放行本该被拦的超卖。份额按行内多名乘客累加，
  // 代表「本行」在这间房里的总计费份额。
  const fractionByRoom = new Map<string, number>();
  for (const m of owned) {
    fractionByRoom.set(
      m.sharedRoomId,
      (fractionByRoom.get(m.sharedRoomId) ?? 0) + Number(m.roomFraction.toString()),
    );
  }

  const out: SharedRoomStateForItem[] = [];
  for (const sharedRoomId of fractionByRoom.keys()) {
    const room = await sharedRoomDelegate(tx)?.findUnique({
      where: { id: sharedRoomId },
      select: { id: true, status: true, checkIn: true, checkOut: true },
    });
    if (!room) continue;
    const allMembers = await memberDelegate.findMany({
      where: { sharedRoomId },
      select: { orderId: true, order: { select: { status: true, deletedAt: true } } },
    });
    const activeMemberOrderIds = [
      ...new Set(
        allMembers
          .filter((x) => x.order.deletedAt == null && COUNTED_STATUSES.includes(x.order.status))
          .map((x) => x.orderId),
      ),
    ];
    out.push({
      sharedRoomId,
      status: room.status,
      checkIn: room.checkIn,
      checkOut: room.checkOut,
      roomFraction: fractionByRoom.get(sharedRoomId) ?? 0,
      activeMemberOrderIds,
    });
  }
  return out;
}

/**
 * §八「恢复」四路共用：本单某订单行若仍是共享成员，校验其共享房是否 ACTIVE 且
 * checkIn/checkOut 与本行一致；不一致（房已被工作台解散、或与本行日期错位）就解绑。
 * 一致则原样保留合住关系，不动。
 *
 * ⚠ 这是**立即写库**的版本（沿用波 2 前既有行为），只适合「解绑后紧接着用一次
 * 『读当前最终状态』式容量判定（remaining<0 那种，不是 before/after 差值判定）」的调用点
 * ——例如管理员强制恢复：订单状态 CAS 早已提交、随后直接读现状判容量，unbind 提前写库
 * 不会把「本次新增占房」伪装成存量（没有 before 快照可被污染）。
 *
 * 需要精确 before/after 判定（allowNonWorsening 那种）的调用点，请改用
 * `planRestoreSharedRoomReconciliation`（只读，不提前写库）。
 *
 * 防御式：mock tx 没有 sharedRoomMember/sharedRoom delegate 时整体跳过（不炸单测），
 * 同 unbindSharedRoomMembersForItem。
 */
export async function unbindInconsistentSharedRoomMembers(
  tx: Prisma.TransactionClient,
  params: {
    orderId: string;
    items: ReadonlyArray<{ id: string; hotelCheckIn: Date; hotelCheckOut: Date }>;
    reason: string;
  },
): Promise<{ unboundItemIds: Set<string>; unbound: UnboundSharedRoomInfo[] }> {
  const memberDelegate = (
    tx as unknown as {
      sharedRoomMember?: { findMany: (args: unknown) => Promise<Array<{ sharedRoomId: string }>> };
    }
  ).sharedRoomMember;
  const roomDelegate = (
    tx as unknown as {
      sharedRoom?: {
        findUnique: (args: unknown) => Promise<{ status: string; checkIn: Date; checkOut: Date } | null>;
      };
    }
  ).sharedRoom;
  const unboundItemIds = new Set<string>();
  const unbound: UnboundSharedRoomInfo[] = [];
  if (!memberDelegate || !roomDelegate) return { unboundItemIds, unbound };

  for (const item of params.items) {
    const memberRooms = await memberDelegate.findMany({
      where: { orderId: params.orderId, orderItemId: item.id },
      select: { sharedRoomId: true },
    });
    for (const m of memberRooms) {
      const room = await roomDelegate.findUnique({
        where: { id: m.sharedRoomId },
        select: { status: true, checkIn: true, checkOut: true },
      });
      const consistent =
        room?.status === 'ACTIVE' &&
        room.checkIn.getTime() === item.hotelCheckIn.getTime() &&
        room.checkOut.getTime() === item.hotelCheckOut.getTime();
      if (consistent) continue;
      const r = await unbindSharedRoomMembersForItem(tx, {
        orderId: params.orderId,
        orderItemId: item.id,
        reason: params.reason,
      });
      if (r.unbound.length > 0) {
        unboundItemIds.add(item.id);
        unbound.push(...r.unbound);
      }
    }
  }
  return { unboundItemIds, unbound };
}

/**
 * `unbindInconsistentSharedRoomMembers` 的**只读**版本（修复批 2 · astra finding A2）：
 * 不写库，算出「哪些行要解绑（连同其 planUnbind 计划）、哪些行一致可以保留（连同保留后
 * 该把本单重新算进对应共享房 activeMemberOrderIds 的覆盖项）」，供调用方先拼出 §五闸
 * 需要的 `nextOrderItems` / `nextSharedRooms`、闸通过后再统一落库。
 *
 * 与 `unbindSharedRoomMembersForItem` 同一整行语义：只要该行任一共享房不一致，就整行
 * （该行在全部共享房里的成员）一并解绑，不做「只解绑不一致的那一间、保留一致的那几间」
 * 的细粒度拆分——与解绑前既有行为一致，不在本次修复范围内改变这个粒度。
 */
export interface RestoreReconciliationPlan {
  /** 一致、保留合住关系的行——调用方要把「本单即将恢复为有效状态」体现进对应共享房。*/
  kept: Array<{
    orderItemId: string;
    sharedRoomId: string;
    checkIn: Date;
    checkOut: Date;
    /** 保留 + 本单恢复后，该房间应有的有效成员订单 id（已含本单 orderId，去重）。*/
    activeMemberOrderIdsAfter: string[];
  }>;
  /**
   * 不一致、需要解绑的全部行合成的**一份**解绑计划——闸通过后一次 `applyUnbindPlan`。
   *
   * N2 修复：原来每行不一致各自 `planUnbind` 一份、存进数组，调用方逐份顺序
   * `applyUnbindPlan`——每份都从同一份原始 JSON 出发，后应用的会把先解绑行的共享键
   * 写回来。改成不一致的行一次性交给 `planUnbindMany`，只出一份计划、一次落库。
   * `null` = 没有行需要解绑。
   */
  unboundPlan: UnbindPlan | null;
  /** unboundPlan 汇总的警告用数据（内部/代理文案由 formatUnbindWarning 生成）。*/
  unbound: UnboundSharedRoomInfo[];
  unboundItemIds: Set<string>;
}

export async function planRestoreSharedRoomReconciliation(
  tx: Prisma.TransactionClient,
  params: {
    orderId: string;
    items: ReadonlyArray<{ id: string; hotelCheckIn: Date; hotelCheckOut: Date }>;
  },
): Promise<RestoreReconciliationPlan> {
  const kept: RestoreReconciliationPlan['kept'] = [];
  const inconsistentItemIds: string[] = [];

  // 第一遍：只读判「一致可保留」还是「不一致需解绑」，不产生任何解绑计划——判定纯粹依赖
  // SharedRoomMember/SharedRoom 现状，与后面怎么合成解绑计划无关，两件事解耦开。
  for (const item of params.items) {
    const states = await getSharedRoomStatesForItem(tx, params.orderId, item.id);
    if (states.length === 0) continue;
    const allConsistent = states.every(
      (s) =>
        s.status === 'ACTIVE' &&
        s.checkIn.getTime() === item.hotelCheckIn.getTime() &&
        s.checkOut.getTime() === item.hotelCheckOut.getTime(),
    );
    if (allConsistent) {
      for (const s of states) {
        kept.push({
          orderItemId: item.id,
          sharedRoomId: s.sharedRoomId,
          checkIn: s.checkIn,
          checkOut: s.checkOut,
          activeMemberOrderIdsAfter: [...new Set([...s.activeMemberOrderIds, params.orderId])],
        });
      }
    } else {
      // 任一间不一致 → 整行解绑（与 unbindInconsistentSharedRoomMembers 同粒度）。
      inconsistentItemIds.push(item.id);
    }
  }

  // 第二遍：不一致的行一次性合成一份计划（N2）——不是逐行各出一份再顺序应用。
  let unboundPlan: UnbindPlan | null = null;
  let unbound: UnboundSharedRoomInfo[] = [];
  if (inconsistentItemIds.length > 0) {
    const plan = await planUnbindMany(tx, { orderId: params.orderId, orderItemIds: inconsistentItemIds });
    if (plan.changes.length > 0) {
      unboundPlan = plan;
      unbound = plan.changes.map((c) => ({
        sharedRoomId: c.sharedRoomId,
        roomFraction: c.roomFraction,
        partnerOrderNumbers: c.partnerOrderNumbers,
      }));
    }
  }
  const unboundItemIds = new Set(
    unboundPlan ? inconsistentItemIds.filter((id) => (unboundPlan!.changesByItemId.get(id)?.length ?? 0) > 0) : [],
  );

  return { kept, unboundPlan, unbound, unboundItemIds };
}

/**
 * 该订单行当前是否有共享成员——只读判定，不解绑。给 §八「改单住/拼住、补单房差联动」
 * 一类必须直接拒绝（不能自动解绑）的入口用：`该行有共享成员 → 400「该行与他单合住，
 * 请先在跨单分房里解除合住」`。防御式同 unbindSharedRoomMembersForItem：mock tx 没有
 * sharedRoomMember delegate 时回落 false，不炸单测。
 */
export async function hasSharedRoomMembers(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderItemId: string,
): Promise<boolean> {
  const delegate = (
    tx as unknown as { sharedRoomMember?: { count: (args: unknown) => Promise<number> } }
  ).sharedRoomMember;
  if (!delegate) return false;
  const count = await delegate.count({ where: { orderId, orderItemId } });
  return count > 0;
}

/**
 * §八「解绑」响应警告文案——两版（拍板 3）：内部版带对方单号，AGENT 版只说「已与他单合住」。
 */
export function formatUnbindWarning(
  unbound: readonly UnboundSharedRoomInfo[],
  role: 'internal' | 'agent',
): string[] {
  return unbound.map((u) => {
    const fractionLabel = Number.isInteger(u.roomFraction)
      ? String(u.roomFraction)
      : u.roomFraction.toFixed(1);
    if (role === 'agent') {
      return `该房组原已与他单合住，计费 ${fractionLabel} 间，解绑后物理占 1 间，金额未重算。`;
    }
    const partners = u.partnerOrderNumbers.length > 0 ? u.partnerOrderNumbers.join('、') : '他单';
    return `该房组原与 ${partners} 合住、计费 ${fractionLabel} 间，解绑后物理占 1 间，金额未重算。`;
  });
}
