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
 */
import type { Prisma } from '@prisma/client';
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

function groupSharedRoomId(g: RoomGroupRecord): string | null {
  const v = g.sharedRoomId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 去掉 roomGroups 单个房组上的 sharedRoomId 键，其余键原样保留（不用解构避免 lint 噪音）。*/
function stripSharedRoomId(g: RoomGroupRecord): RoomGroupRecord {
  const rest: RoomGroupRecord = {};
  for (const [k, v] of Object.entries(g)) {
    if (k !== 'sharedRoomId') rest[k] = v;
  }
  return rest;
}

/**
 * 把某订单某酒店/套餐行在全部共享房里的成员解绑：
 *   1. 删该行在每间共享房的 SharedRoomMember；
 *   2. 房间清空 → DISSOLVED（dissolvedReason=reason）；否则 version+1；
 *   3. 该单 roomAssignment JSON 里对应房组去掉 sharedRoomId（变回普通房组，其余字段不变，
 *      含 roomFraction——即便是 0）。
 * 不改 roomsBilled（钱不动）；不改其余成员的份额，也不改对方单的 JSON。
 * 该行本不在任何共享房 → 直接返回 `{ unbound: [] }`，调用方无需先探测再决定是否调用。
 */
export async function unbindSharedRoomMembersForItem(
  tx: Prisma.TransactionClient,
  params: { orderId: string; orderItemId: string; reason: string },
): Promise<{ unbound: UnboundSharedRoomInfo[] }> {
  const { orderId, orderItemId, reason } = params;
  // 防御式：单测常用手搭的 mock tx（只 mock 用到的 delegate）没有 sharedRoomMember 时回落
  // 「本次没有共享成员」而不是炸——与 computeSharedRoomPhysicalByDate 的 sharedRoom 兜底同哲学。
  const delegate = (
    tx as unknown as {
      sharedRoomMember?: {
        findMany: (args: unknown) => Promise<
          Array<{ sharedRoomId: string; roomFraction: Prisma.Decimal }>
        >;
      };
    }
  ).sharedRoomMember;
  if (!delegate) return { unbound: [] };
  const owned = await delegate.findMany({
    where: { orderId, orderItemId },
    select: { sharedRoomId: true, roomFraction: true },
  });
  if (owned.length === 0) return { unbound: [] };

  const sharedRoomIds = [...new Set(owned.map((m) => m.sharedRoomId))].sort();
  const fractionByRoom = new Map(
    owned.map((m) => [m.sharedRoomId, Number(m.roomFraction.toString())]),
  );

  const unbound: UnboundSharedRoomInfo[] = [];
  for (const sharedRoomId of sharedRoomIds) {
    // 锁这间共享房：与跨单分房工作台保存、其它入口的并发解绑互斥（§六同款「先锁再读再写」）。
    await tx.$queryRaw`SELECT id FROM "SharedRoom" WHERE id = ${sharedRoomId} FOR UPDATE`;
    const allMembers = await tx.sharedRoomMember.findMany({
      where: { sharedRoomId },
      select: { orderId: true, orderItemId: true, order: { select: { orderNumber: true } } },
    });
    const partnerOrderNumbers = [
      ...new Set(allMembers.filter((m) => m.orderId !== orderId).map((m) => m.order.orderNumber)),
    ].sort();
    const remainingAfter = allMembers.filter(
      (m) => !(m.orderId === orderId && m.orderItemId === orderItemId),
    );

    await tx.sharedRoomMember.deleteMany({ where: { sharedRoomId, orderId, orderItemId } });
    if (remainingAfter.length === 0) {
      await tx.sharedRoom.update({
        where: { id: sharedRoomId },
        data: { status: 'DISSOLVED', dissolvedAt: new Date(), dissolvedReason: reason },
      });
    } else {
      await tx.sharedRoom.update({ where: { id: sharedRoomId }, data: { version: { increment: 1 } } });
    }

    unbound.push({
      sharedRoomId,
      roomFraction: fractionByRoom.get(sharedRoomId) ?? 0,
      partnerOrderNumbers,
    });
  }

  // 订单 JSON：把本行在这些共享房的房组去掉 sharedRoomId（变回普通房组），其余字段原样保留。
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { roomAssignment: true } });
  const groups = readRoomGroupArray(order?.roomAssignment);
  if (groups) {
    const touchedIds = new Set(sharedRoomIds);
    let changed = false;
    const nextGroups = groups.map((g) => {
      if (g == null || typeof g !== 'object' || Array.isArray(g)) return g;
      const rec = g as RoomGroupRecord;
      if (roomGroupItemId(rec) !== orderItemId) return g;
      const sid = groupSharedRoomId(rec);
      if (sid == null || !touchedIds.has(sid)) return g;
      changed = true;
      return stripSharedRoomId(rec);
    });
    if (changed) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          roomAssignment: {
            ...(order?.roomAssignment as object),
            roomGroups: nextGroups,
          } as unknown as object,
        },
      });
    }
  }

  return { unbound };
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
