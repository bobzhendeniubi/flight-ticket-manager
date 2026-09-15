/**
 * 跨单分房 —— 房组对外角色化 DTO（§十）。
 *
 * Order.roomAssignment.roomGroups[] 原样是内部房控产出的完整对象：可能带 sharedRoomId
 * （共享房镜像字段，见 hotel-control.shared-rooms.ts）、split-room-group 留下的
 * splitPairKey、以及未来可能新增的内部业务键。改前 orders.service.ts 的 serializeOrder
 * 对代理/客户视角是 `...order` 原样展开，roomAssignment 完全没经过脱敏；代理导出模板也是
 * 直接把 group.notes 拼进备注（见 astra 评审 finding 8：这些不是「现有代理泄露漏洞」——审计
 * / 提醒本就 ADMIN/STAFF only、专用导出也仅内部开放——但方案新增的换酒店/改期「已解绑」
 * 警告，以及跨单分房带来的 sharedRoomId/对方单号，会经这两条通道第一次泄露给代理）。
 *
 * serializeRoomGroupsFor 是唯一入口：ADMIN/STAFF（已知内部角色）原样透传，不改变现状；
 * 其余一切（AGENT、CUSTOMER、角色未知/未传）按 fail-closed 哲学一律拿外部 DTO——
 * 宁可少给，不能因为调用方漏传角色就多给。外部 DTO 只保留
 * { id, roomType, passengerIds（本单）, roomFraction, isShared, notes（本单） }，
 * 剥掉 sharedRoomId 本身、splitPairKey、hotelName 等内部/无关字段——isShared 只是个
 * 布尔，不暴露对方是哪张单（对方单号只在内部视图动态生成，见 room-identity.ts 的
 * sharedRoomPartnerNote，不写进这个 DTO）。
 */
import { UserRole } from '@prisma/client';

/** 对外可见的单个房组形状（§十）。*/
export interface ExternalRoomGroup {
  id: string;
  roomType: string;
  /** 本单成员——共享房组的 JSON 镜像本就只含本单乘客（§三真值优先级：成员表 > 订单 JSON）。*/
  passengerIds: string[];
  /** 计费份额，缺省 1（老数据 / 未填）。*/
  roomFraction: number;
  /** 是否与他单合住——只给布尔，不给 sharedRoomId 本身，也不给对方单号。*/
  isShared: boolean;
  /** 本单房组备注（房控填的自由文本；不含服务端生成的「与 FTM… 合住」内部文案）。*/
  notes: string;
  /**
   * 房组归属的本单订单行 id（astra B 路终审 M2）——只是「这个房组挂在本单哪一条酒店/套餐
   * 行下」，不含任何跨单信息（不是共享房 id、不指向对方单号），泄露面为零。缺失该字段
   * 会让多酒店行订单的代理重存分房时丢归属：外部 DTO 原本没有 orderItemId，代理只能在
   * 下拉里盲选，容易改挂错行。省略（未归属 / 老数据没有该字段）时不返回这个键。
   */
  orderItemId?: string;
}

/** 防御式解析 roomAssignment.roomGroups；形状不符返回空数组，不抛错。*/
function parseGroupsLoose(roomAssignment: unknown): Array<Record<string, unknown>> {
  if (roomAssignment == null || typeof roomAssignment !== 'object') return [];
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups)) return [];
  return groups.filter((g): g is Record<string, unknown> => g != null && typeof g === 'object');
}

/**
 * 按角色序列化 roomAssignment：
 *   - role 为 ADMIN / STAFF：原样返回，不改变现状（向后兼容既有 ADMIN/STAFF 调用方）。
 *   - 其余（AGENT / CUSTOMER / 角色缺失）：剥成 `{ roomGroups: ExternalRoomGroup[] }`。
 * roomAssignment 为空 / 形状不符：内部角色原样返回原值（null/undefined 等）；
 * 外部角色返回 `{ roomGroups: [] }`（不是 null——响应形状恒定，前端不用判两种类型）。
 */
export function serializeRoomGroupsFor(
  role: UserRole | undefined,
  roomAssignment: unknown,
): unknown {
  if (role === UserRole.ADMIN || role === UserRole.STAFF) return roomAssignment;
  const groups = parseGroupsLoose(roomAssignment);
  return {
    roomGroups: groups.map((g): ExternalRoomGroup => {
      const orderItemId = typeof g.orderItemId === 'string' ? g.orderItemId : undefined;
      return {
        id: typeof g.id === 'string' ? g.id : '',
        roomType: typeof g.roomType === 'string' ? g.roomType : '',
        passengerIds: Array.isArray(g.passengerIds)
          ? g.passengerIds.filter((id): id is string => typeof id === 'string')
          : [],
        roomFraction: typeof g.roomFraction === 'number' ? g.roomFraction : 1,
        isShared: typeof g.sharedRoomId === 'string' && g.sharedRoomId.length > 0,
        notes: typeof g.notes === 'string' ? g.notes : '',
        ...(orderItemId !== undefined ? { orderItemId } : {}),
      };
    }),
  };
}
