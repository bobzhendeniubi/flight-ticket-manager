/**
 * 跨单分房导出统一房间身份映射（§九）。
 *
 * 三个导出（分房表 orders.export-room-allocation.ts、整班机 orders.export.ts、全岗总表
 * orders.export-master.ts）以前各编各的房号：分房表/整班机共用 assignRoomNumbers，但按
 * （人工填的）酒店名文本分桶、按房组本地 id 认同房；全岗总表干脆在单内自建 groupRoomNo，
 * 从 1 重新数。三处房号互不对齐，共享房两侧更是各印各的号（见 astra 评审 finding 1/10）。
 *
 * 本文件是三处共用的唯一入口：
 *   - `roomIdentityKey`：房组的跨单身份——共享房恒定用 SharedRoom.id（服务端生成、写进两边
 *     订单 JSON 的 roomGroups[].sharedRoomId 镜像，真值见 hotel-control.shared-rooms.ts），
 *     普通房组退回 `${orderId}:${groupId}`（本地 id 只在本单内有意义，带上 orderId 避免
 *     跨单短随机串撞车）。
 *   - `roomNumberScopeKey`：编号作用域——真实酒店按 hotelId（不认名字文本，名字可能是换酒店前
 *     的旧值、房控手误，见 finding 10）；未落位的星级随机档没有 hotelId，用展示名兜底出一个
 *     隔离的作用域键（不会撞真实酒店的 hotelId）。入住日由调用方在此之外自行分桶
 *     （现有 assignRoomNumbers 调用方已按入住日分桶，未改动）。
 *   - `RoomNumberer`：同一 scope 内，同一 identityKey 恒定复用同一个号；`next()` 给「没有
 *     身份、每次都要一个新号」的未分房打包场景用，与 `numberFor` 共用同一个计数器，
 *     保证两类号码不撞、不断号。
 *   - `loadSharedRoomPartnerLookup` / `sharedRoomPartnerNote`：内部导出「与 FTM… 合住」
 *     备注要点对方单号，从 SharedRoomMember 查（不能从订单 JSON 猜——JSON 只镜像本单）。
 */
import type { PrismaClient } from '@prisma/client';

/** roomIdentityKey 入参：房组的最小形状（跨单身份判定只看这两个字段）。*/
export interface RoomIdentityGroup {
  id: string;
  sharedRoomId?: string | null;
}

/**
 * 房组的跨单房间身份：共享房恒定 id 优先，普通房组退回 `${orderId}:${groupId}`。
 * 共享房两侧（哪怕一侧份额 0、hotelName 文本不同）算出的是同一个字符串——导出编号/去重的
 * 唯一依据，绝不用 hotelName 或本地 groupId 单独认同房。
 */
export function roomIdentityKey(group: RoomIdentityGroup, orderId: string): string {
  return group.sharedRoomId || `${orderId}:${group.id}`;
}

/**
 * 房号编号作用域键：真实酒店按 hotelId；未落位（随机档待落位）没有 hotelId，
 * 用调用方传入的展示名（如「4星随机（待落位）」）兜底出一个隔离作用域——
 * 加 `pending:` 前缀避免与任何真实 hotelId 字符串巧合相撞。
 */
export function roomNumberScopeKey(hotelId: string | null, pendingScopeLabel: string): string {
  return hotelId ? `hotel:${hotelId}` : `pending:${pendingScopeLabel}`;
}

/**
 * 房号编号器：`numberFor(scope, identityKey)` 同一 scope + identityKey 恒定复用同一个号，
 * 不同 identityKey 按首次出现顺序递增；`next(scope)` 不认身份，每次都发一个新号
 * （未分房乘客按容量打包场景用）。两个方法共用同一套按 scope 维护的计数器，
 * 保证「已分房用掉的号」与「打包分配的号」不会撞在一起。
 */
export class RoomNumberer {
  private readonly counters = new Map<string, number>();
  private readonly assigned = new Map<string, number>();

  numberFor(scope: string, identityKey: string): number {
    const cacheKey = `${scope} ${identityKey}`;
    const existing = this.assigned.get(cacheKey);
    if (existing !== undefined) return existing;
    const n = this.next(scope);
    this.assigned.set(cacheKey, n);
    return n;
  }

  next(scope: string): number {
    const n = (this.counters.get(scope) ?? 0) + 1;
    this.counters.set(scope, n);
    return n;
  }
}

/**
 * 批量查一批 sharedRoomId 各自的全部成员单号（去重，含本单——调用方自行按本单号排除）。
 * 内部导出（分房表/整班机/全岗总表，均 ADMIN/STAFF only）用来拼「与 FTM… 合住」备注；
 * 代理侧一律不查这个、只用中性文案（见 §十 serializeRoomGroupsFor）。
 *
 * client 用真实 `PrismaClient` 类型（不是自定义 duck-type 接口）：findMany 的 `select`
 * 字面量要留在调用点，Prisma 的泛型才能按 select 精确收窄返回类型；单测按本文件既有
 * 惯例传 `{ sharedRoomMember: { findMany: vi.fn()... } } as unknown as PrismaClient`。
 */
export async function loadSharedRoomPartnerLookup(
  sharedRoomIds: Iterable<string>,
  client: PrismaClient,
): Promise<Map<string, string[]>> {
  const ids = Array.from(new Set(sharedRoomIds));
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await client.sharedRoomMember.findMany({
    where: { sharedRoomId: { in: ids } },
    select: { sharedRoomId: true, order: { select: { orderNumber: true } } },
  });
  for (const row of rows) {
    const list = out.get(row.sharedRoomId) ?? [];
    if (!list.includes(row.order.orderNumber)) list.push(row.order.orderNumber);
    out.set(row.sharedRoomId, list);
  }
  return out;
}

/** 代理导出统一走这句中性文案——不带对方单号（§十拍板 3）。*/
export const AGENT_SHARED_ROOM_NOTE = '与他单合住';

/**
 * 内部导出「与 FTM… 合住」备注（本单单号从结果里排除，多个伙伴用「、」连接）。
 * 查不到伙伴（理论上 sharedRoomId 存在必有 ≥2 张单）→ 返回空串，不编造——留给下次导出
 * 复现问题，比编一句错误的备注安全。
 */
export function sharedRoomPartnerNote(
  sharedRoomId: string,
  ownOrderNumber: string,
  lookup: ReadonlyMap<string, readonly string[]>,
): string {
  const partners = (lookup.get(sharedRoomId) ?? []).filter((n) => n !== ownOrderNumber);
  if (partners.length === 0) return '';
  return `与 ${partners.join('、')} 合住`;
}
