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
 *     订单 JSON 的 roomGroups[].sharedRoomId 镜像，真值见 hotel-control.shared-rooms.ts）；
 *     没有共享房 id 但带拆单配对键（splitPairKey，orders.service.ts 拆单时写在两个半组上的
 *     `<源行id>:<拆单令牌>`）时用它——两个半间导出编号也该合成一间，同物理房间口径。
 *     **存量 splitPairKey（旧格式 `<baseId>:<拆单令牌>`）不保证跨单唯一**（astra A 路
 *     finding 4/§十三验收反例 10 的后续复审）：baseId 可能是本地房组 id（不保证全局唯一），
 *     拆单令牌只在 (源单, 令牌) 二元组内做幂等去重，不同源单复用同一个令牌、又撞上相同的
 *     baseId（legacy 数据 / 批量脚本更容易撞），三个导出会把两张不相关订单的半间错误合成
 *     一间。**新格式**（HIGH 修复 · astra finding N7）`sp2:<sourceOrderId>:<baseId>:
 *     <拆单令牌>`（orders.service.ts splitMixedRoomGroup 写入）把源单 id 直接编进 key，
 *     天然对应 OrderSplitRecord 的 `@@unique([sourceOrderId, requestToken])`，不再需要
 *     baseId 全局唯一这个假设。`buildVerifiedSplitPairKeys` 用 OrderSplitRecord（真实拆单
 *     关系表）批量核验：新格式按**单条拆分记录**精确核验（sourceOrderId+token 唯一定位
 *     一条记录，出现该 key 的订单必须恰为该记录的 source/target 二元组）；旧格式沿用原按
 *     token 取并集的核验（已知的较弱口径，存量数据不回填新格式）。核验集缺省（调用方没传）
 *     时保持旧行为（信任 splitPairKey，供纯函数单测用，不查库）——生产调用点必须传核验集，
 *     否则退回 `${orderId}:${groupId}`。
 *   - `roomNumberScopeKey`：编号作用域——真实酒店按 hotelId（不认名字文本，名字可能是换酒店前
 *     的旧值、房控手误）；未落位的星级随机档没有 hotelId，用展示名兜底出一个隔离的作用域键
 *     （不会撞真实酒店的 hotelId）。入住日由调用方在此之外自行分桶。
 *   - `roomIdentitySortKey` / `buildIdentityNumberMap`：B10——三个导出各自的遍历顺序不同
 *     （查询排序方向、乘客展开顺序都不一样），旧口径「谁先遍历到就发哪个号」会让同一批身份
 *     在不同导出里编出不同房号（哪怕单份导出内部自洽）。改为按确定性规则排序后统一编号：
 *     共享房排在普通房组之前，共享房内部按 identityKey（即 sharedRoomId）本身升序，普通房组
 *     内部按 `${orderNumber}:${groupId}` 升序——不依赖任何查询/遍历顺序，三个导出对同一批
 *     身份必然算出同一份「身份→房号」映射。
 *   - `RoomNumberer`：同一 scope 内，同一 identityKey 恒定复用同一个号；`next()` 给「没有
 *     身份、每次都要一个新号」的未分房打包场景用，与 `numberFor` 共用同一个计数器，
 *     保证两类号码不撞、不断号。`prime()` 是 B10 的对接口：外部预建号码（来自
 *     `buildIdentityNumberMap`）占了 1..N 时，把未分房续编号的起点抬到 N+1，不与预建号相撞。
 *   - `loadSharedRoomPartnerLookup` / `sharedRoomPartnerNote`：内部导出「与 FTM… 合住」
 *     备注要点对方单号，从 SharedRoomMember 查（不能从订单 JSON 猜——JSON 只镜像本单）；
 *     B11 起附带伙伴订单的失效状态（取消/退款/软删），内部备注据此标注「（已取消）」。
 */
import { OrderStatus, type PrismaClient } from '@prisma/client';

/** roomIdentityKey 入参：房组的最小形状（跨单身份判定只看这三个字段）。*/
export interface RoomIdentityGroup {
  id: string;
  sharedRoomId?: string | null;
  /** 拆单配对键（`<源行id>:<拆单令牌>`）；两个半组写同一个值。是否可信见 buildVerifiedSplitPairKeys。*/
  splitPairKey?: string | null;
}

/**
 * 房组的跨单房间身份：共享房恒定 id 优先；没有共享房 id 但带拆单配对键（两个半间数出的
 * 同一间房）用它——两者互斥，不会撞；都没有才退回 `${orderId}:${groupId}`。
 * 共享房两侧（哪怕一侧份额 0、hotelName 文本不同）算出的是同一个字符串——导出编号/去重的
 * 唯一依据，绝不用 hotelName 或本地 groupId 单独认同房。
 *
 * @param verifiedSplitPairKeys A4 安全闸：splitPairKey 只有出现在这个集合里才会被信任用来
 *   跨单合号，否则退回 `${orderId}:${groupId}`（不跨单合并，宁可导出编号偏多，不能把两张
 *   不相关订单的半间错误合成一间）。**缺省（undefined）= 不做核验，照旧信任**——只给纯函数
 *   单测用；生产导出必须先用 `buildVerifiedSplitPairKeys` 建好集合再传进来。
 */
export function roomIdentityKey(
  group: RoomIdentityGroup,
  orderId: string,
  verifiedSplitPairKeys?: ReadonlySet<string>,
): string {
  if (group.sharedRoomId) return group.sharedRoomId;
  if (group.splitPairKey && (!verifiedSplitPairKeys || verifiedSplitPairKeys.has(group.splitPairKey))) {
    return group.splitPairKey;
  }
  return `${orderId}:${group.id}`;
}

/**
 * A4 安全闸：批量核验一批 splitPairKey 是否真的对应同一次拆单——用 OrderSplitRecord
 * （拆单唯一真值表，`@@unique([sourceOrderId, requestToken])`）核对。
 *
 * splitPairKey 格式是 `<baseId>:<拆单令牌>`，baseId 可能是订单行 id、也可能是房组本地 id
 * （orders.service.ts splitMixedRoomGroup 的 `pax:` 派生兜底），**不保证跨单唯一**；拆单令牌
 * （requestToken）只在 (源单, 令牌) 内做幂等去重，不同源单复用同一个令牌不会被系统拒绝。
 * 因此不能只看 splitPairKey 字面值相等就认定「这是同一次拆单」——必须反查 OrderSplitRecord：
 * 出现同一个 splitPairKey 的全部订单，必须**恰好**落在同一条拆单记录的
 * `{sourceOrderId, targetOrderId}` 二元组里，才判定为可信。
 *
 * 令牌解析：取 splitPairKey 最后一个 `:` 之后的子串（baseId 本身不含 `:`——房组 id / 订单行
 * id / `pax:` 派生兜底都不产出冒号；拆单令牌是 requestToken，同样不含冒号）。
 *
 * 单订单内部出现同一个 splitPairKey（理论不该发生：同订单没有跨单泄露风险）视为可信，
 * 不需要查表。
 */
export async function buildVerifiedSplitPairKeys(
  entries: Iterable<{ orderId: string; splitPairKey: string | null | undefined }>,
  client: PrismaClient,
): Promise<Set<string>> {
  const orderIdsByKey = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!e.splitPairKey) continue;
    let set = orderIdsByKey.get(e.splitPairKey);
    if (!set) {
      set = new Set();
      orderIdsByKey.set(e.splitPairKey, set);
    }
    set.add(e.orderId);
  }

  const verified = new Set<string>();
  if (orderIdsByKey.size === 0) return verified;

  // HIGH 修复（astra finding N7）：新格式 `sp2:<sourceOrderId>:<baseId>:<token>`
  // （orders.service.ts splitMixedRoomGroup 写入）按**单条拆分关系**核验——解析出
  // sourceOrderId + token，精确查 (sourceOrderId, requestToken) 这一条 OrderSplitRecord
  // （= 唯一索引 @@unique([sourceOrderId, requestToken])），可信集合就是那一条记录的
  // {sourceOrderId, targetOrderId} 二元组，不再像旧实现那样把所有共享同一个 token 的
  // 拆分记录的 source/target 并成一个大集合——两个各自复用同一 token 的独立拆分，即使
  // 观测到的订单都落在这个并集里，也不代表它们是同一次拆分（原碰撞仍会通过）。
  //
  // sourceOrderId 用第一个冒号定位（位置固定，即便 baseId 内部含冒号也不影响：baseId
  // 只在 "sp2:" 与 token 之间，两头都按位置切，不需要 baseId 本身无冒号）；token 用最后
  // 一个冒号定位（token 本身不含冒号，同旧格式的既有假设）。
  const sp2Parsed = new Map<string, { sourceOrderId: string; token: string }>();
  // 旧格式（无 sp2: 前缀）：沿用原按 token 取并集的校验——存量数据不回填新格式
  // （见 splitMixedRoomGroup 头注释），核验仍是已知的较弱口径。
  const legacyTokens = new Set<string>();

  for (const key of orderIdsByKey.keys()) {
    if (key.startsWith('sp2:')) {
      const rest = key.slice(4);
      const firstColon = rest.indexOf(':');
      if (firstColon <= 0) continue; // 形状不符（不可信，留在 verified 之外，退回 orderId:groupId）
      const sourceOrderId = rest.slice(0, firstColon);
      const afterSource = rest.slice(firstColon + 1);
      const lastColon = afterSource.lastIndexOf(':');
      if (lastColon <= 0) continue;
      const token = afterSource.slice(lastColon + 1);
      if (!sourceOrderId || !token) continue;
      sp2Parsed.set(key, { sourceOrderId, token });
    } else {
      const idx = key.lastIndexOf(':');
      if (idx > 0) legacyTokens.add(key.slice(idx + 1));
    }
  }

  if (sp2Parsed.size > 0) {
    const pairs = new Map<string, { sourceOrderId: string; requestToken: string }>();
    for (const p of sp2Parsed.values()) {
      pairs.set(`${p.sourceOrderId} ${p.token}`, { sourceOrderId: p.sourceOrderId, requestToken: p.token });
    }
    const records = await client.orderSplitRecord.findMany({
      where: {
        OR: [...pairs.values()].map((p) => ({ sourceOrderId: p.sourceOrderId, requestToken: p.requestToken })),
      },
      select: { sourceOrderId: true, targetOrderId: true, requestToken: true },
    });
    const recordByPair = new Map<string, { sourceOrderId: string; targetOrderId: string }>();
    for (const r of records) {
      recordByPair.set(`${r.sourceOrderId} ${r.requestToken}`, r);
    }
    for (const [key, parsed] of sp2Parsed) {
      const orderIds = orderIdsByKey.get(key)!;
      if (orderIds.size <= 1) {
        verified.add(key); // 单订单内部撞键，不跨单，没有泄露风险
        continue;
      }
      const record = recordByPair.get(`${parsed.sourceOrderId} ${parsed.token}`);
      if (record) {
        const legit = new Set([record.sourceOrderId, record.targetOrderId]);
        if ([...orderIds].every((id) => legit.has(id))) verified.add(key);
      }
    }
  }

  if (legacyTokens.size > 0) {
    const legacyRecords = await client.orderSplitRecord.findMany({
      where: { requestToken: { in: [...legacyTokens] } },
      select: { sourceOrderId: true, targetOrderId: true, requestToken: true },
    });
    const legitOrderIdsByToken = new Map<string, Set<string>>();
    for (const r of legacyRecords) {
      let set = legitOrderIdsByToken.get(r.requestToken);
      if (!set) {
        set = new Set();
        legitOrderIdsByToken.set(r.requestToken, set);
      }
      set.add(r.sourceOrderId);
      set.add(r.targetOrderId);
    }
    for (const [key, orderIds] of orderIdsByKey) {
      if (key.startsWith('sp2:')) continue; // 上面已处理
      if (orderIds.size <= 1) {
        verified.add(key);
        continue;
      }
      const idx = key.lastIndexOf(':');
      const token = idx > 0 ? key.slice(idx + 1) : '';
      const legit = legitOrderIdsByToken.get(token);
      if (legit && [...orderIds].every((id) => legit.has(id))) verified.add(key);
    }
  }

  return verified;
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
 * B10：identityKey 的确定性排序键——三个导出各自遍历顺序不同（查询排序方向、乘客展开顺序
 * 都不一样），不能再靠「谁先遍历到就编几号」，改按这个规则统一排序后编号：
 *   - 共享房（`0` 前缀）排在普通房组（`1` 前缀）之前，两类内部各自排序，前缀保证不会混叠；
 *   - 共享房内部：按 identityKey 本身（即 sharedRoomId）升序；
 *   - 普通房组内部：按 `${orderNumber}:${groupId}` 升序——orderNumber 三个导出都拿得到，
 *     比订单内部 id 更符合「人读的确定顺序」，也不受订单 id 生成算法变化影响。
 * 拆单半间（identityKey = splitPairKey）没有独立身份意义上的「谁是共享房」——按普通房组
 * 规则排序即可（isShared 传 false），splitPairKey 字符串本身已经跨单唯一，用 orderNumber
 * 更利于人读。
 */
export function roomIdentitySortKey(
  group: RoomIdentityGroup,
  identityKey: string,
  orderNumber: string,
): string {
  return group.sharedRoomId ? `0:${identityKey}` : `1:${orderNumber}:${group.id}`;
}

/** buildIdentityNumberMap 结果 Map 的 key（scope 与 identityKey 用空格分隔，与 RoomNumberer 内部同口径）。*/
export function scopedIdentityMapKey(scope: string, identityKey: string): string {
  return `${scope} ${identityKey}`;
}

export interface IdentityNumberEntry {
  scope: string;
  identityKey: string;
  sortKey: string;
}

/**
 * B10：按 scope 分桶，桶内全部去重后的 identityKey 按 sortKey 升序统一编号（1 起）——
 * 不依赖调用方遍历这些身份的顺序。三个导出对同一批身份用这份映射，就必然算出同一个
 * 「身份→房号」结果，不再因为查询排序方向、乘客展开顺序不同而把两间共享房的号印反。
 */
export function buildIdentityNumberMap(entries: Iterable<IdentityNumberEntry>): Map<string, number> {
  const byScope = new Map<string, Map<string, string>>(); // scope -> identityKey -> sortKey
  for (const e of entries) {
    let idMap = byScope.get(e.scope);
    if (!idMap) {
      idMap = new Map();
      byScope.set(e.scope, idMap);
    }
    if (!idMap.has(e.identityKey)) idMap.set(e.identityKey, e.sortKey);
  }
  const result = new Map<string, number>();
  for (const [scope, idMap] of byScope) {
    const sorted = [...idMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    sorted.forEach(([identityKey], i) => result.set(scopedIdentityMapKey(scope, identityKey), i + 1));
  }
  return result;
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

  /**
   * B10 对接口：把某个 scope 的计数器下限抬到至少 floor——外部预建号码（
   * buildIdentityNumberMap）已经占了 1..floor，未分房续编号（next()）不能从 1 重开，
   * 否则会撞进已经用掉的号。只在计数器当前小于 floor 时才推高，不会把已经领先的计数器
   * 往回拨（例如同一 scope 内先调用过 numberFor/next 的场景）。
   */
  prime(scope: string, floor: number): void {
    const cur = this.counters.get(scope) ?? 0;
    if (floor > cur) this.counters.set(scope, floor);
  }
}

/** 房控有效订单状态——镜像 hotel-control.service.ts 的 COUNTED_STATUSES（B11 用于判定
 * 共享房伙伴订单是否已失效）；两处含义相同，各自独立维护，改动需同步。*/
const PARTNER_ACTIVE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
]);

export interface SharedRoomPartnerInfo {
  orderNumber: string;
  /** B11：该成员所属订单是否已失效（非有效状态，或软删）——内部备注据此标「（已取消）」。*/
  cancelled: boolean;
}

/**
 * 批量查一批 sharedRoomId 各自的全部成员单号 + 失效状态（去重，含本单——调用方自行按本单
 * 号排除）。内部导出（分房表/整班机/全岗总表，均 ADMIN/STAFF only）用来拼「与 FTM… 合住」
 * 备注；代理侧一律不查这个、只用中性文案（见 §十 serializeRoomGroupsFor）。
 *
 * client 用真实 `PrismaClient` 类型（不是自定义 duck-type 接口）：findMany 的 `select`
 * 字面量要留在调用点，Prisma 的泛型才能按 select 精确收窄返回类型；单测按本文件既有
 * 惯例传 `{ sharedRoomMember: { findMany: vi.fn()... } } as unknown as PrismaClient`。
 */
export async function loadSharedRoomPartnerLookup(
  sharedRoomIds: Iterable<string>,
  client: PrismaClient,
): Promise<Map<string, SharedRoomPartnerInfo[]>> {
  const ids = Array.from(new Set(sharedRoomIds));
  const out = new Map<string, SharedRoomPartnerInfo[]>();
  if (ids.length === 0) return out;
  const rows = await client.sharedRoomMember.findMany({
    where: { sharedRoomId: { in: ids } },
    select: {
      sharedRoomId: true,
      order: { select: { orderNumber: true, status: true, deletedAt: true } },
    },
  });
  for (const row of rows) {
    const list = out.get(row.sharedRoomId) ?? [];
    if (!list.some((p) => p.orderNumber === row.order.orderNumber)) {
      const cancelled = row.order.deletedAt != null || !PARTNER_ACTIVE_STATUSES.has(row.order.status);
      list.push({ orderNumber: row.order.orderNumber, cancelled });
    }
    out.set(row.sharedRoomId, list);
  }
  return out;
}

/** 代理导出统一走这句中性文案——不带对方单号、也不带状态细节（§十拍板 3）。*/
export const AGENT_SHARED_ROOM_NOTE = '与他单合住';

/**
 * 内部导出「与 FTM… 合住」备注（本单单号从结果里排除，多个伙伴用「、」连接）。
 * B11：伙伴订单已失效（取消/退款/软删）的单独标注「（已取消）」，不与正常伙伴混在一起——
 * 「掏钱那张单没了、这边还占着房」是运营该核对的异常状态，备注里看不出来就只能翻库查。
 * 查不到伙伴（理论上 sharedRoomId 存在必有 ≥2 张单）→ 返回空串，不编造——留给下次导出
 * 复现问题，比编一句错误的备注安全。
 */
export function sharedRoomPartnerNote(
  sharedRoomId: string,
  ownOrderNumber: string,
  lookup: ReadonlyMap<string, readonly SharedRoomPartnerInfo[]>,
): string {
  const partners = (lookup.get(sharedRoomId) ?? []).filter((p) => p.orderNumber !== ownOrderNumber);
  if (partners.length === 0) return '';
  return `与 ${partners.map((p) => (p.cancelled ? `${p.orderNumber}（已取消）` : p.orderNumber)).join('、')} 合住`;
}
