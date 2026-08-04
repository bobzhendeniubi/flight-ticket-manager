/**
 * 房控 service — 酒店包房周期（HotelBlockPeriod）CRUD + 销控板 / 远期视图。
 *
 * 口径：
 *   block(d)     = SUM(该酒店所有周期 rooms，其中 dateFrom <= d <= dateTo，周期可叠加)
 *   used(d)      = 当晚占房订单行数 —— OrderItem 带 hotelRoomTypeId + 入住区间
 *                  [hotelCheckIn, hotelCheckOut)，即 checkIn <= d < checkOut，1 间/行；
 *                  只数与导出一致的有效状态订单（COUNTED_STATUSES）。
 *                  注：BUNDLE 行如带房型+入住日期同样计入；当前套餐下单不写这些字段，
 *                  纯 bundleId 的行（Bundle.items JSON 无房型/日期）无法归属酒店，跳过。
 *   remaining(d) = block(d) - used(d)
 *   physical(d)  = 物理房间口径：有权威分房表（Order.roomAssignment.roomGroups）的订单
 *                  按「有乘客的房间盒子数」直计（见 expandAssignedPhysicalByDate）；
 *                  其余订单按拼房性别推算（异性不能拼一间，见 computePhysicalUsed）。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计日志（镜像 finances 成本周期风格）。
 */
import { OrderItemKind, OrderStatus, Prisma, type Gender, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { fmtDepartureLocalDate } from '../orders/passport-zip.js';
import type { CreateBlockPeriodBody, UpdateBlockPeriodBody } from './hotel-control.schemas.js';

/** 与财务/订单导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入。*/
export const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 销控板最长跨度（天）—— 超出按 from 起截断。*/
const MAX_BOARD_DAYS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── 星级随机池（三星随机 / 四星随机）──────────────────────────────────────
/**
 * 「N 星随机」是真库存池，不是汇总视图：先按星级切总量（HotelBlockPeriod.randomStarTier
 * 的池周期），客人下单只占池（OrderItem.randomStarTier 的占房行），之后房控再把这单落到
 * 具体酒店（换酒店流程，写 hotelRoomTypeId + 清 randomStarTier）。
 *
 * 池与具体酒店**互不扣减**：选明月扣明月，选随机扣池；落地那一刻占用才从池转到该酒店。
 * 酒店的星级分类直接取 Hotel.starRating（不另建分类表）。
 */
export const RANDOM_STAR_TIERS = [3, 4] as const;
export type RandomStarTier = (typeof RANDOM_STAR_TIERS)[number];

const CN_NUMERALS = ['一', '二', '三', '四', '五'] as const;

/** 池档次的展示名：3 → 「三星随机」。超出 1..5 的异常值回落成数字，不抛错。*/
export function randomStarTierLabel(tier: number): string {
  return `${CN_NUMERALS[tier - 1] ?? String(tier)}星随机`;
}

/**
 * 销控板里池组的分组键。**不是真实酒店 id** —— 前端据 `randomStarTier` 非空判定池组，
 * 这个键只用于 React key / 分组归并；把它当 hotelId 传给按酒店的接口不会命中任何酒店。
 */
export function randomPoolGroupKey(tier: number): string {
  return `random-star-${tier}`;
}

/**
 * 房量口径的作用域：一家具体酒店，或一个星级随机池。周期与占房行的过滤条件由此派生，
 * 保证「池」与「酒店」两条线共用同一套展开/物理口径实现，不出现第二本账。
 */
export type RoomScope = { hotelId: string } | { randomStarTier: number };

/** 该作用域的包房周期过滤条件（池周期 hotelId 为 NULL，按酒店查天然不会命中，反之亦然）。*/
function scopePeriodWhere(scope: RoomScope): Prisma.HotelBlockPeriodWhereInput {
  return 'hotelId' in scope
    ? { hotelId: scope.hotelId }
    : { randomStarTier: scope.randomStarTier };
}

/**
 * 该作用域的占房行过滤条件。
 * 池行显式要求 hotelRoomTypeId 为空 —— 与销控板分组「有房型就归该酒店」同优先级，
 * 万一出现两列都有值的异常行，两边都把它算成具体酒店的占房，不会被重复计两次。
 */
function scopeItemWhere(scope: RoomScope): Prisma.OrderItemWhereInput {
  return 'hotelId' in scope
    ? { hotelRoomTypeId: { not: null }, hotelRoomType: { hotelId: scope.hotelId } }
    : { hotelRoomTypeId: null, randomStarTier: scope.randomStarTier };
}

// ── helpers ──────────────────────────────────────────────────────────────
function dec(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Prisma @db.Date 返回 UTC 0:00 的 Date；序列化为 'YYYY-MM-DD'。*/
function fmtDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toDateOnly(s: string): Date {
  // 'YYYY-MM-DD' → UTC midnight，与 Prisma @db.Date 的存取口径一致
  return new Date(`${s}T00:00:00.000Z`);
}

// ── 包房周期 CRUD ─────────────────────────────────────────────────────────
export interface HotelBlockPeriodDto {
  /** 池周期为 null（此时 randomStarTier 非空）。*/
  hotelId: string | null;
  id: string;
  /** 具体酒店周期 = 酒店名；池周期 = 「三星随机」/「四星随机」。恒非空，前端直接展示。*/
  hotelName: string;
  /** 非空 = 星级随机池周期（3=三星随机、4=四星随机）。*/
  randomStarTier: number | null;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD（闭区间）
  rooms: number;
  unitPrice: number | null;
  note: string | null;
  updatedAt: string;
}

type BlockPeriodRow = Prisma.HotelBlockPeriodGetPayload<{
  include: { hotel: { select: { name: true } } };
}>;

function toDto(row: BlockPeriodRow): HotelBlockPeriodDto {
  const price = dec(row.unitPrice);
  return {
    id: row.id,
    hotelId: row.hotelId,
    // hotel 关联随 hotelId 一起为空（池周期）→ 用池档次名占位，前端无需分支即可展示
    hotelName: row.hotel?.name ?? randomStarTierLabel(row.randomStarTier ?? 0),
    randomStarTier: row.randomStarTier,
    dateFrom: fmtDateOnly(row.dateFrom),
    dateTo: fmtDateOnly(row.dateTo),
    rooms: row.rooms,
    unitPrice: price == null ? null : round2(price),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 周期归属的 XOR 校验：具体酒店（hotelId）与星级随机池（randomStarTier）二选一必填。
 * 库里两列都可空 —— 语义完整性由这里守住，绝不落「两者皆空」的孤儿周期或「两者都有」的歧义周期。
 */
function assertBlockPeriodScope(input: {
  hotelId?: string | null;
  randomStarTier?: number | null;
}): void {
  const hasHotel = !!input.hotelId;
  const hasTier = input.randomStarTier != null;
  if (hasHotel === hasTier) {
    throw new BadRequestError('包房周期必须二选一：指定一家酒店，或指定一个星级随机池');
  }
  if (hasTier && !RANDOM_STAR_TIERS.includes(input.randomStarTier as RandomStarTier)) {
    throw new BadRequestError(
      `星级随机池仅支持 ${RANDOM_STAR_TIERS.map((t) => randomStarTierLabel(t)).join(' / ')}`,
    );
  }
}

export async function listBlockPeriods(
  filter: { hotelId?: string; randomStarTier?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<HotelBlockPeriodDto[]> {
  const rows = await client.hotelBlockPeriod.findMany({
    where: filter.hotelId
      ? { hotelId: filter.hotelId }
      : filter.randomStarTier != null
        ? { randomStarTier: filter.randomStarTier }
        : undefined,
    orderBy: [{ hotelId: 'asc' }, { dateFrom: 'desc' }],
    include: { hotel: { select: { name: true } } },
  });
  return rows.map(toDto);
}

export async function createBlockPeriod(
  input: CreateBlockPeriodBody,
  client: PrismaClient = defaultPrisma,
): Promise<HotelBlockPeriodDto> {
  if (input.dateFrom > input.dateTo) {
    throw new BadRequestError('起始日不能晚于结束日');
  }
  assertBlockPeriodScope(input);
  if (input.hotelId) {
    const hotel = await client.hotel.findUnique({
      where: { id: input.hotelId },
      select: { id: true },
    });
    if (!hotel) throw new NotFoundError('酒店不存在');
  }

  const row = await client.hotelBlockPeriod.create({
    data: {
      hotelId: input.hotelId ?? null,
      randomStarTier: input.randomStarTier ?? null,
      dateFrom: toDateOnly(input.dateFrom),
      dateTo: toDateOnly(input.dateTo),
      rooms: input.rooms,
      unitPrice: input.unitPrice ?? null,
      note: input.note ?? null,
    },
    include: { hotel: { select: { name: true } } },
  });
  return toDto(row);
}

export async function updateBlockPeriod(
  id: string,
  input: UpdateBlockPeriodBody,
  client: PrismaClient = defaultPrisma,
): Promise<HotelBlockPeriodDto> {
  const existing = await client.hotelBlockPeriod.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('包房周期不存在');

  const from = input.dateFrom ?? fmtDateOnly(existing.dateFrom);
  const to = input.dateTo ?? fmtDateOnly(existing.dateTo);
  if (from > to) {
    throw new BadRequestError('起始日不能晚于结束日');
  }

  const data: Prisma.HotelBlockPeriodUpdateInput = {};
  if (input.dateFrom) data.dateFrom = toDateOnly(input.dateFrom);
  if (input.dateTo) data.dateTo = toDateOnly(input.dateTo);
  if (input.rooms !== undefined) data.rooms = input.rooms;
  if (input.unitPrice !== undefined) data.unitPrice = input.unitPrice ?? null;
  if (input.note !== undefined) data.note = input.note ?? null;

  const row = await client.hotelBlockPeriod.update({
    where: { id },
    data,
    include: { hotel: { select: { name: true } } },
  });
  return toDto(row);
}

export async function deleteBlockPeriod(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  const existing = await client.hotelBlockPeriod.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('包房周期不存在');
  await client.hotelBlockPeriod.delete({ where: { id } });
  return { id };
}

// ── 逐日展开（销控板 / 前台余量共用）─────────────────────────────────────
/** dates 上逐日累加包房数：dateFrom <= d <= dateTo（闭区间，周期可叠加）。*/
export function expandBlockByDate(
  periods: ReadonlyArray<{ dateFrom: Date; dateTo: Date; rooms: number }>,
  dates: readonly string[],
): number[] {
  const block = new Array<number>(dates.length).fill(0);
  for (const p of periods) {
    const fromStr = fmtDateOnly(p.dateFrom);
    const toStr = fmtDateOnly(p.dateTo);
    for (let i = 0; i < dates.length; i++) {
      if (fromStr <= dates[i] && dates[i] <= toStr) block[i] += p.rooms;
    }
  }
  return block;
}

/**
 * 单行真实占房间数：roomsBilled（新列，支持 0.5 半间）→ metadata.roomsNeeded（套餐已写）
 * → metadata.rooms（酒店行写）→ 1（兜底）。任意值非有限正数都回落到下一优先级。
 * export：占房下钻（getOccupyingOrders）复用同一口径，避免与销控板 used 计算漂移。
 */
export function itemRoomCount(it: {
  roomsBilled?: Prisma.Decimal | number | null;
  metadata?: unknown;
}): number {
  const billed = dec(it.roomsBilled ?? null);
  if (billed != null && Number.isFinite(billed) && billed > 0) return billed;
  if (it.metadata != null && typeof it.metadata === 'object') {
    const meta = it.metadata as { roomsNeeded?: unknown; rooms?: unknown };
    const needed = Number(meta.roomsNeeded);
    if (Number.isFinite(needed) && needed > 0) return needed;
    const rooms = Number(meta.rooms);
    if (Number.isFinite(rooms) && rooms > 0) return rooms;
  }
  return 1;
}

/**
 * dates 上逐日累计占房间数：checkIn <= d < checkOut（半开区间）。
 * 每行按真实房间数计（见 itemRoomCount），支持 0.5 半间 — 用浮点累加后 round2。
 */
export function expandUsedByDate(
  items: ReadonlyArray<{
    hotelCheckIn: Date | null;
    hotelCheckOut: Date | null;
    roomsBilled?: Prisma.Decimal | number | null;
    metadata?: unknown;
  }>,
  dates: readonly string[],
): number[] {
  const used = new Array<number>(dates.length).fill(0);
  for (const it of items) {
    if (!it.hotelCheckIn || !it.hotelCheckOut) continue;
    const checkIn = fmtDateOnly(it.hotelCheckIn);
    const checkOut = fmtDateOnly(it.hotelCheckOut);
    const rooms = itemRoomCount(it);
    for (let i = 0; i < dates.length; i++) {
      if (checkIn <= dates[i] && dates[i] < checkOut) used[i] += rooms;
    }
  }
  // 浮点累加可能引入 0.999… 误差 — 统一 round2，半间(0.5)精度足够
  return used.map(round2);
}

/** roomsBilled 判为半间（拼房 0.5）：恰为 0.5 的分数占房行。*/
function isHalfRoom(it: { roomsBilled?: Prisma.Decimal | number | null }): boolean {
  const billed = dec(it.roomsBilled ?? null);
  return billed != null && billed === 0.5;
}

/**
 * 拼房客逐日按性别分桶计数（异性不能拼一间）。每桶数组与 dates 等长。
 *   m/f = 明确性别为 男/女 的拼房客数；
 *   u   = 性别未知（Passenger.gender 为 null 或 X）的拼房客数——保守口径每人独占 1 间。
 */
export interface SharedGenderBuckets {
  m: number[];
  f: number[];
  u: number[];
}

/**
 * 取拼房单出行人的性别：拼房单（roomsBilled==0.5）恒为 adultCount===1 的套餐单，
 * 正常只 1 位真实出行人。取第一位性别为 M/F 的出行人；X / null / 无出行人一律视为「未知」。
 * 订单若含多位出行人（异常兜底），取第一位有明确性别（M/F）者，其余忽略。
 */
function pickSoloGender(
  passengers: ReadonlyArray<{ gender: Gender | null }> | null | undefined,
): 'M' | 'F' | 'U' {
  if (!passengers) return 'U';
  for (const p of passengers) {
    if (p.gender === 'M' || p.gender === 'F') return p.gender;
  }
  return 'U';
}

/**
 * dates 上逐日按性别累计「拼房客」人数：roomsBilled == 0.5 的占房行，
 * 入住区间 [checkIn, checkOut) 覆盖该晚即按其出行人性别 +1（每行 = 1 位拼房客）。
 * 异性不能拼一间 → 男/女各自两两配对、未知每人独占，用于物理房间与落单口径。
 *
 * 注：有权威分房表的订单（含运营故意混拼）已由 expandAssignedPhysicalByDate 在上游拆分
 * 排除——物理口径调用方应只传拆分后的 fallback 行，分房表订单不进此保守推算。
 */
export function expandSharedHalfByDate(
  items: ReadonlyArray<{
    hotelCheckIn: Date | null;
    hotelCheckOut: Date | null;
    roomsBilled?: Prisma.Decimal | number | null;
    order?: { passengers: Array<{ gender: Gender | null }> } | null;
  }>,
  dates: readonly string[],
): SharedGenderBuckets {
  const m = new Array<number>(dates.length).fill(0);
  const f = new Array<number>(dates.length).fill(0);
  const u = new Array<number>(dates.length).fill(0);
  for (const it of items) {
    if (!it.hotelCheckIn || !it.hotelCheckOut) continue;
    if (!isHalfRoom(it)) continue;
    const g = pickSoloGender(it.order?.passengers);
    const bucket = g === 'M' ? m : g === 'F' ? f : u;
    const checkIn = fmtDateOnly(it.hotelCheckIn);
    const checkOut = fmtDateOnly(it.hotelCheckOut);
    for (let i = 0; i < dates.length; i++) {
      if (checkIn <= dates[i] && dates[i] < checkOut) bucket[i] += 1;
    }
  }
  return { m, f, u };
}

/**
 * 物理房间口径占房：逐日真实占用的整间数（可由销控板既有数组在内存推导，无需查库）。
 *   physicalUsed[i] = ceil(m/2) + ceil(f/2) + u + 整间预订数
 * 其中（按性别分组，异性不能拼一间）：
 *   m/f = 当晚男/女拼房客数 → 同性两两配对、落单向上取整独占 ⇒ ceil(m/2)+ceil(f/2)；
 *   u   = 性别未知拼房客数 → 保守口径每人独占 1 间；
 *   整间预订数 = (used*2 的 half-unit 总量 − 拼房客 half-unit) / 2（应为整数）。
 * 防浮点误差：used 由 Decimal 0.5 累加而来，先按 0.5 网格对齐消除 0.999… 类误差，最后 round2 输出。
 */
export function computePhysicalUsed(
  used: readonly number[],
  buckets: SharedGenderBuckets,
): number[] {
  return used.map((bedUsed, i) => {
    const m = buckets.m[i] ?? 0;
    const f = buckets.f[i] ?? 0;
    const u = buckets.u[i] ?? 0;
    const solos = m + f + u; // 拼房客总数（各 = 0.5 = 1 个 half-unit）
    // used 由 Decimal 0.5 累加而来，先按 0.5 网格对齐消除 0.999… 类误差
    const usedHalfUnits = Math.round(bedUsed * 2);
    const wholeRooms = (usedHalfUnits - solos) / 2; // 整间预订数（应为整数）
    return round2(Math.ceil(m / 2) + Math.ceil(f / 2) + u + wholeRooms);
  });
}

// ── 权威分房表（Order.roomAssignment）────────────────────────────────────
/**
 * 权威分房表的物理间数：Order.roomAssignment.roomGroups（orders 模块分房保存的 JSON）中
 * 「至少 1 名出行人」的房间盒子数量。返回 null = 无有效分房表（未分房 / 形状不符 /
 * 全部盒子无人）→ 调用方走拼房性别推算 fallback。防御式解析，形状不符不抛错。
 *
 * 背景：分房保存把 Σ roomFraction 塌缩写进首个酒店行的 roomsBilled（床位/计费口径），
 * "男+女各半间分 2 房"会塌缩成 1.0——物理间数必须回读分房表，不能只看 roomsBilled。
 */
export function assignedPhysicalRooms(roomAssignment: unknown): number | null {
  if (roomAssignment == null || typeof roomAssignment !== 'object') return null;
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const withPassengers = groups.filter((g) => {
    if (g == null || typeof g !== 'object') return false;
    const ids = (g as { passengerIds?: unknown }).passengerIds;
    return Array.isArray(ids) && ids.length > 0;
  }).length;
  return withPassengers > 0 ? withPassengers : null;
}

/** 占房行（物理口径拆分用）：订单级分房表 + 拼房性别 fallback 所需字段。*/
export interface PhysicalOccupancyItem {
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
  roomsBilled?: Prisma.Decimal | number | null;
  metadata?: unknown;
  order?: {
    id?: string;
    roomAssignment?: unknown;
    passengers: Array<{ gender: Gender | null }>;
  } | null;
}

/**
 * 物理房间口径拆分：有权威分房表的订单逐日按「有乘客的 roomGroup 数」直计物理间数
 * （assignedPhysical），其余行原样返回（fallbackItems）走性别推算（expandSharedHalfByDate
 * + computePhysicalUsed）。分房表订单不再参与 isHalfRoom / 性别配对 / 整间推算，
 * 也不进「拼」落单口径（sharedUnpaired）。
 *
 * 订单级去重：分房是订单级、占房行是行级——同一订单在同酒店的多行（两种房型 / 分段住）
 * 只按分房表间数计一次/晚：对该单所有行的 [checkIn, checkOut) 取并集覆盖，
 * 覆盖到的每晚 += 分房表间数（日期展开方式对齐 expandUsedByDate 的半开区间）。
 */
export function expandAssignedPhysicalByDate<T extends PhysicalOccupancyItem>(
  items: ReadonlyArray<T>,
  dates: readonly string[],
): { assignedPhysical: number[]; fallbackItems: T[] } {
  const assignedPhysical = new Array<number>(dates.length).fill(0);
  const fallbackItems: T[] = [];
  const byOrder = new Map<string, { rooms: number; covered: boolean[] }>();
  items.forEach((it, idx) => {
    const rooms = assignedPhysicalRooms(it.order?.roomAssignment);
    if (rooms == null || !it.hotelCheckIn || !it.hotelCheckOut) {
      fallbackItems.push(it);
      return;
    }
    // 订单 id 缺失（异常兜底）按行独立计，避免静默丢占房
    const key = it.order?.id ?? `__row_${idx}`;
    const entry = byOrder.get(key) ?? {
      rooms,
      covered: new Array<boolean>(dates.length).fill(false),
    };
    if (!byOrder.has(key)) byOrder.set(key, entry);
    const checkIn = fmtDateOnly(it.hotelCheckIn);
    const checkOut = fmtDateOnly(it.hotelCheckOut);
    for (let i = 0; i < dates.length; i++) {
      if (checkIn <= dates[i] && dates[i] < checkOut) entry.covered[i] = true;
    }
  });
  for (const { rooms, covered } of byOrder.values()) {
    for (let i = 0; i < dates.length; i++) {
      if (covered[i]) assignedPhysical[i] += rooms;
    }
  }
  return { assignedPhysical, fallbackItems };
}

/**
 * 单酒店逐晚余量（remaining = block - used），口径与销控板 getBoard 完全一致。
 * 一次 findMany 拉周期 + 一次 findMany 拉占房行，JS 内展开（无逐日查询）。
 * hasBlock=false 表示整段没有任何包房周期（未配置房控）—— 调用方自行决定降级行为。
 *
 * 返回逐晚 `block`（该晚被包房周期管控的房量）供调用方区分「被管控但售罄」与「未被管控」：
 *   block[i] > 0 ⇒ 该晚由房控管控，remaining[i] 可信；
 *   block[i] === 0 ⇒ 该晚无任何周期覆盖（未管控），不应据 remaining 判为售罄。
 */
export async function getHotelNightlyRemaining(
  hotelId: string,
  nightDates: readonly string[],
  client: PrismaClient = defaultPrisma,
): Promise<{ remaining: number[]; hasBlock: boolean; block: number[]; physicalRemaining: number[] }> {
  if (nightDates.length === 0) {
    return { remaining: [], hasBlock: false, block: [], physicalRemaining: [] };
  }
  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);

  const periods = await client.hotelBlockPeriod.findMany({
    where: { hotelId, dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    select: { dateFrom: true, dateTo: true, rooms: true },
  });
  if (periods.length === 0) {
    return { remaining: [], hasBlock: false, block: [], physicalRemaining: [] };
  }

  // 占晚区间 [checkIn, checkOut) 与夜晚集合有交集 ⇔ checkIn <= 最后一晚 && checkOut > 第一晚
  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelRoomType: { hotelId },
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      // 物理房间口径 physicalRemaining 需要（口径同 getBoard）：
      //   roomAssignment = 权威分房表（优先直计物理间数）；passengers.gender = fallback 性别推算
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });

  const block = expandBlockByDate(periods, nightDates);
  const used = expandUsedByDate(items, nightDates);
  // 物理房间口径（与销控板 getBoard / 房态导出同口径）：权威分房表订单按「有乘客的
  // roomGroup 数」直计整间；无分房表订单按性别分桶推算真实占用整间数（异性不能拼）——
  // 避免"男+女各半间已分 2 房"被塌缩的 roomsBilled=1.0 误算成 1 间。
  const physicalUsed = computePhysicalUsedForItems(items, nightDates, null);
  const physicalRemaining = block.map((b, i) => round2(b - physicalUsed[i]));

  return {
    remaining: block.map((b, i) => b - used[i]),
    hasBlock: true,
    block,
    physicalRemaining,
  };
}

// ── 物理房间口径前瞻闸（下单 / 换酒店 / 分房写入共用）──────────────────────
/**
 * 本次操作**打算新增**的占房——前瞻闸的输入。
 *   wholeRooms = 新增整间数（非负整数）；
 *   solos      = 新增拼房客逐人性别（'M'/'F'/'U'；未知按保守口径每人独占 1 间）。
 *
 * 为什么必须拆这两维、而不是拿 `physicalRemaining >= rooms` 直接比：
 *   1) 量纲不同 —— rooms 可能是 0.5（单人拼房的床位/计费口径），物理余量是整间；
 *   2) **一个新拼房客的物理增量是 0 还是 1，取决于当晚有没有可配对的同性落单** ——
 *      这在「余量」这个存量数字里根本看不出来。往「已有 1 位男拼房客」里再加 1 位男
 *      → ceil(2/2)=1 → 增量 0（放行）；往「0 位男」里加 → 增量 1。
 *   所以只能把人真的塞进性别桶里、按 computePhysicalUsed 重算一遍，才是权威判定。
 */
export interface ProspectiveOccupancy {
  wholeRooms: number;
  solos: ReadonlyArray<'M' | 'F' | 'U'>;
}

/** 前瞻闸判定为「装不下」的某一晚。*/
export interface PhysicalFitViolation {
  index: number; // 在 nightDates 中的下标
  date: string; // YYYY-MM-DD
  block: number; // 该晚包房间数
  physicalUsed: number; // 本次操作后该晚需要的物理间数
  shortfall: number; // = physicalUsed − block（超出的物理间数）
}

export interface PhysicalFitResult {
  /** false = 整段没有任何包房周期（未配房控）→ 调用方不应据此拦截。*/
  hasBlock: boolean;
  block: number[];
  physicalUsedBefore: number[];
  physicalUsedAfter: number[];
  violations: PhysicalFitViolation[];
}

/**
 * 物理房间口径占房（逐晚），可选叠加一笔「打算新增的占房」。
 * 口径与销控板 getBoard / physicalRemaining 完全一致，纯内存推算，不额外查库。
 */
function computePhysicalUsedForItems<T extends PhysicalOccupancyItem>(
  items: ReadonlyArray<T>,
  dates: readonly string[],
  prospective: ProspectiveOccupancy | null,
): number[] {
  const { assignedPhysical, fallbackItems } = expandAssignedPhysicalByDate(items, dates);
  const baseBuckets = expandSharedHalfByDate(fallbackItems, dates);
  const baseUsed = expandUsedByDate(fallbackItems, dates);

  const solos = prospective?.solos ?? [];
  // 防御：整间数按非负整数取，避免调用方误传 0.5（0.5 间的语义是「拼房客」，应走 solos）。
  const extraWhole = prospective ? Math.max(0, Math.ceil(prospective.wholeRooms)) : 0;
  const soloCount = (g: 'M' | 'F' | 'U'): number => solos.filter((s) => s === g).length;
  const buckets: SharedGenderBuckets = {
    m: baseBuckets.m.map((v) => v + soloCount('M')),
    f: baseBuckets.f.map((v) => v + soloCount('F')),
    u: baseBuckets.u.map((v) => v + soloCount('U')),
  };
  // 拼房客各 0.5 间 + 新增整间，一并加进床位口径 used —— computePhysicalUsed 由
  // (usedHalfUnits − solos)/2 反推整间数，两边必须同步加，否则整间数会被算成负。
  const used = baseUsed.map((v) => round2(v + solos.length * 0.5 + extraWhole));

  const fallbackPhysical = computePhysicalUsed(used, buckets);
  return fallbackPhysical.map((v, i) => round2(v + assignedPhysical[i]));
}

/**
 * 前瞻闸：把 prospective 的新增占房塞进当晚的性别桶后重算物理间数，逐晚判定装不装得下。
 *   逐晚拒绝条件：block[i] > 0（该晚确被包房周期管控）且 block[i] − physicalUsedAfter[i] < 0。
 *   block[i] === 0（未被任何周期覆盖）→ 视为未管控，不据此拦截（房控哲学：未配包房 ≠ 售罄）。
 *
 * @param excludeOrderId 改存量单（换酒店 / 重排分房）时排除该单自身的既有占房，避免把自己算两遍。
 */
export async function checkHotelPhysicalFit(
  hotelId: string,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: { excludeOrderId?: string } = {},
  client: PrismaClient = defaultPrisma,
): Promise<PhysicalFitResult> {
  return checkRoomScopePhysicalFit({ hotelId }, nightDates, prospective, opts, client);
}

/**
 * checkHotelPhysicalFit 的作用域通用版：既可判一家具体酒店，也可判一个星级随机池
 * （池是真库存，与具体酒店互不扣减 —— 见 RoomScope 注释）。判定口径两者完全一致：
 * 权威分房表直计 + 拼房性别推算，block[i] === 0 视为未管控不拦截。
 */
export async function checkRoomScopePhysicalFit(
  scope: RoomScope,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: { excludeOrderId?: string } = {},
  client: PrismaClient = defaultPrisma,
): Promise<PhysicalFitResult> {
  const empty: PhysicalFitResult = {
    hasBlock: false,
    block: [],
    physicalUsedBefore: [],
    physicalUsedAfter: [],
    violations: [],
  };
  if (nightDates.length === 0) return empty;

  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);
  const periods = await client.hotelBlockPeriod.findMany({
    where: { ...scopePeriodWhere(scope), dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    select: { dateFrom: true, dateTo: true, rooms: true },
  });
  if (periods.length === 0) return empty;

  // 过滤口径与 getHotelNightlyRemaining / getBoard 的 used 完全一致
  const items = await client.orderItem.findMany({
    where: {
      ...scopeItemWhere(scope),
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: {
        deletedAt: null,
        status: { in: COUNTED_STATUSES },
        ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
      },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });

  const block = expandBlockByDate(periods, nightDates);
  const physicalUsedBefore = computePhysicalUsedForItems(items, nightDates, null);
  const physicalUsedAfter = computePhysicalUsedForItems(items, nightDates, prospective);

  const violations: PhysicalFitViolation[] = [];
  nightDates.forEach((date, i) => {
    if (block[i] > 0 && block[i] - physicalUsedAfter[i] < 0) {
      violations.push({
        index: i,
        date,
        block: block[i],
        physicalUsed: physicalUsedAfter[i],
        shortfall: round2(physicalUsedAfter[i] - block[i]),
      });
    }
  });

  return { hasBlock: true, block, physicalUsedBefore, physicalUsedAfter, violations };
}

/**
 * checkHotelPhysicalFit 的抛错版：装不下就抛 BadRequestError。
 *
 * @param opts.allowNonWorsening 只拦「让某晚更差」的操作。存量单可能**已经**物理超卖
 *   （切闸前累积的），运营重排分房去补救时不该被自己造成的存量超卖挡在门外 —— 这类
 *   「改完不比改前差」的操作放行。新增占房（下单/换酒店）不应开这个豁免。
 * @param opts.buildMessage 定制错误文案（对外端点用中性话术，后台可回明细）。
 */
export async function assertHotelPhysicalFit(
  hotelId: string,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: {
    excludeOrderId?: string;
    allowNonWorsening?: boolean;
    buildMessage?: (violations: readonly PhysicalFitViolation[]) => string;
  } = {},
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  return assertRoomScopePhysicalFit({ hotelId }, nightDates, prospective, opts, client);
}

/** assertHotelPhysicalFit 的作用域通用版（具体酒店 / 星级随机池共用）。*/
export async function assertRoomScopePhysicalFit(
  scope: RoomScope,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: {
    excludeOrderId?: string;
    allowNonWorsening?: boolean;
    buildMessage?: (violations: readonly PhysicalFitViolation[]) => string;
  } = {},
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const fit = await checkRoomScopePhysicalFit(
    scope,
    nightDates,
    prospective,
    { excludeOrderId: opts.excludeOrderId },
    client,
  );
  if (!fit.hasBlock || fit.violations.length === 0) return;
  if (
    opts.allowNonWorsening &&
    fit.violations.every((v) => fit.physicalUsedAfter[v.index] <= fit.physicalUsedBefore[v.index])
  ) {
    return;
  }
  const subject =
    'hotelId' in scope ? '酒店实际房间' : `${randomStarTierLabel(scope.randomStarTier)}池房量`;
  const message = opts.buildMessage
    ? opts.buildMessage(fit.violations)
    : `${subject}不足（${fit.violations[0].date} 包房 ${fit.violations[0].block} 间，本次操作后需 ${fit.violations[0].physicalUsed} 间）`;
  throw new BadRequestError(message);
}

// ── 销控板（按酒店 × 日期）────────────────────────────────────────────────
export interface HotelControlBoard {
  dates: string[];
  hotels: Array<{
    /**
     * 分组键。具体酒店 = 真实 Hotel.id；星级随机池 = 合成键 `random-star-{tier}`
     * （见 randomPoolGroupKey）—— 池组不是酒店，别拿它去调按 hotelId 的接口，
     * 判定池组一律看 `randomStarTier` 是否非空。
     */
    hotelId: string;
    /** 具体酒店 = 酒店名；池组 = 「三星随机」/「四星随机」。*/
    hotelName: string;
    /** 非空 = 星级随机池虚拟组（3=三星随机、4=四星随机）。*/
    randomStarTier: number | null;
    /** 最新周期（dateFrom 最晚且有价）的切房单价；都没填则 null */
    unitPrice: number | null;
    rows: {
      block: number[];
      /** 床位口径占房：Σ roomsBilled（拼房客各计 0.5，可为小数），逐日 */
      used: number[];
      /** 床位口径余量 = block - used，逐日 */
      remaining: number[];
      /** 当晚拼房客（roomsBilled==0.5，仅无分房表的 fallback 订单）总人数（含各性别），逐日 */
      sharedHalfCount: number[];
      /**
       * 当晚无法配对的拼房客数（落单数），逐日。仅统计无分房表的 fallback 订单——
       * 已有权威分房表的订单不再标为落单。
       * = m%2 + f%2 + u（同性两两配对后的余数 + 未知性别全算落单）。
       */
      sharedUnpaired: number[];
      /** 当晚有拼房客无法配对（sharedUnpaired > 0，需补单房差或另行配对），逐日 */
      sharedOdd: boolean[];
      /**
       * 物理房间口径占房：真实占用的整间数，逐日。
       * 有权威分房表（Order.roomAssignment.roomGroups）的订单 = 有乘客的房间盒子数（直计）；
       * 其余订单 = ceil(男/2) + ceil(女/2) + 未知 + 整间预订数
       *   异性不能拼一间：男/女各自两两共用 1 间、落单向上取整独占；未知每人独占 1 间。
       */
      physicalUsed: number[];
      /** 物理房间口径余量 = block - physicalUsed，逐日 */
      physicalRemaining: number[];
    };
  }>;
}

/** from..to（含两端）展开为 YYYY-MM-DD 数组；超 MAX_BOARD_DAYS 按 from 起截断。*/
function buildDateRange(from: string, to: string): string[] {
  if (from > to) {
    throw new BadRequestError('起始日不能晚于结束日');
  }
  const fromMs = toDateOnly(from).getTime();
  const toMs = toDateOnly(to).getTime();
  const days = Math.min(Math.floor((toMs - fromMs) / DAY_MS) + 1, MAX_BOARD_DAYS);
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

export async function getBoard(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<HotelControlBoard> {
  const dates = buildDateRange(range.from, range.to);
  const fromD = toDateOnly(dates[0]);
  const toD = toDateOnly(dates[dates.length - 1]);

  // 周期：与 [from, to] 有交集的全部（按 dateFrom 倒序 → 第一条即"最新周期"）
  const periods = await client.hotelBlockPeriod.findMany({
    where: { dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    orderBy: { dateFrom: 'desc' },
    include: { hotel: { select: { name: true } } },
  });

  // 占房订单行：一次 findMany 拉全范围内相关行，再在 JS 里按天展开（无逐日查询）
  // 入住区间 [checkIn, checkOut) 与 [from, to] 有交集 ⇔ checkIn <= to && checkOut > from
  // 两类占房行：盖了房型的（归具体酒店）+ 星级随机池行（randomStarTier 非空，归池组）。
  const items = await client.orderItem.findMany({
    where: {
      OR: [{ hotelRoomTypeId: { not: null } }, { randomStarTier: { not: null } }],
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      randomStarTier: true,
      hotelRoomType: { select: { hotelId: true, hotel: { select: { name: true } } } },
      // roomAssignment = 权威分房表（优先直计物理间数，订单级去重需 id）；
      // passengers.gender = fallback 拼房性别推算（异性不能拼一间）——拼房单恒为
      // adultCount===1 的套餐单，取其出行人性别；批量随主查带回，不额外查库。
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });

  // 分组集合 = 有周期的 ∪ 有占房的；具体酒店按 hotelId 分组、星级随机池按合成键分组。
  // 池组与酒店组互不扣减（真库存池语义）：一条周期/占房行只落进其中一组。
  const groups = new Map<string, { name: string; randomStarTier: number | null }>();
  for (const p of periods) {
    if (p.hotelId) groups.set(p.hotelId, { name: p.hotel?.name ?? p.hotelId, randomStarTier: null });
    else if (p.randomStarTier != null) {
      groups.set(randomPoolGroupKey(p.randomStarTier), {
        name: randomStarTierLabel(p.randomStarTier),
        randomStarTier: p.randomStarTier,
      });
    }
  }
  for (const it of items) {
    if (it.hotelRoomType) {
      if (!groups.has(it.hotelRoomType.hotelId)) {
        groups.set(it.hotelRoomType.hotelId, {
          name: it.hotelRoomType.hotel.name,
          randomStarTier: null,
        });
      }
    } else if (it.randomStarTier != null) {
      const key = randomPoolGroupKey(it.randomStarTier);
      if (!groups.has(key)) {
        groups.set(key, {
          name: randomStarTierLabel(it.randomStarTier),
          randomStarTier: it.randomStarTier,
        });
      }
    }
  }

  const hotels = Array.from(groups.entries())
    // 池组排在最前（房控先看「随机池还剩多少没落地」），其余酒店按名称
    .sort(([, a], [, b]) => {
      const poolDelta = Number(b.randomStarTier != null) - Number(a.randomStarTier != null);
      if (poolDelta !== 0) return poolDelta;
      return a.name.localeCompare(b.name, 'zh-CN');
    })
    .map(([hotelId, { name: hotelName, randomStarTier }]) => {
      const hotelPeriods =
        randomStarTier != null
          ? periods.filter((p) => p.hotelId == null && p.randomStarTier === randomStarTier)
          : periods.filter((p) => p.hotelId === hotelId);
      const hotelItems =
        randomStarTier != null
          ? items.filter((it) => it.hotelRoomType == null && it.randomStarTier === randomStarTier)
          : items.filter((it) => it.hotelRoomType?.hotelId === hotelId);
      const block = expandBlockByDate(hotelPeriods, dates);
      const used = expandUsedByDate(hotelItems, dates);
      // 权威分房表订单直计物理间数并退出拼房口径；其余行（fallback）按性别推算
      const { assignedPhysical, fallbackItems } = expandAssignedPhysicalByDate(hotelItems, dates);
      // 拼房客（0.5 半间）逐日按性别分桶（仅 fallback 订单；异性不能拼一间；
      // 已有分房表的订单不进拼房桶、不标「拼」落单）
      const buckets = expandSharedHalfByDate(fallbackItems, dates);
      const sharedHalfCount = buckets.m.map((mv, i) => mv + buckets.f[i] + buckets.u[i]);
      // 落单数 = 同性两两配对后的余数 + 未知性别（全算落单）
      const sharedUnpaired = buckets.m.map((mv, i) => (mv % 2) + (buckets.f[i] % 2) + buckets.u[i]);
      const sharedOdd = sharedUnpaired.map((n) => n > 0);

      const remaining = block.map((b, i) => b - used[i]);
      // 物理房间口径（内存推导，无额外查库）：分房表直计 + fallback 性别推算
      const fallbackPhysical = computePhysicalUsed(expandUsedByDate(fallbackItems, dates), buckets);
      const physicalUsed = fallbackPhysical.map((v, i) => round2(v + assignedPhysical[i]));
      const physicalRemaining = block.map((b, i) => round2(b - physicalUsed[i]));
      const latestPriced = hotelPeriods.find((p) => p.unitPrice != null);
      const unitPrice = latestPriced ? round2(dec(latestPriced.unitPrice)!) : null;

      return {
        hotelId,
        hotelName,
        randomStarTier,
        unitPrice,
        rows: {
          block,
          used,
          remaining,
          sharedHalfCount,
          sharedUnpaired,
          sharedOdd,
          physicalUsed,
          physicalRemaining,
        },
      };
    });

  return { dates, hotels };
}

// ── 提醒线（超卖加房 / 富余退房 / 班次超开票上限 / 拼房落单临近）──────────
export interface HotelControlAlerts {
  /** 余量 < 0：占房超过包房，提醒加房 */
  oversold: Array<{
    hotelId: string;
    hotelName: string;
    date: string; // YYYY-MM-DD
    block: number;
    used: number;
    deficit: number; // used - block（正数）
  }>;
  /** 距今 3 天内仍有剩余包房（block > 0 且 remaining > 0）：提示该退房 */
  surplusSoon: Array<{ hotelName: string; date: string; surplus: number }>;
  /** 出发在 30 天内、计入口径乘客数超过班次开票上限（默认 191）的班次 */
  overCapacitySchedules: Array<{
    flightNumber: string;
    departureDate: string; // YYYY-MM-DD
    paxCount: number;
  }>;
  /**
   * 入住临近（SHARED_ODD_NEAR_DAYS 天内）当晚有拼房客无法配对（落单数 > 0，异性不能拼、
   * 未知性别每人独占）：需趁出发前补单房差或另配。被动的销控板「拼」角标之外的主动推送。
   */
  sharedOddNear: Array<{
    hotelId: string;
    hotelName: string;
    date: string; // YYYY-MM-DD（入住晚）
    sharedHalfCount: number; // 当晚拼房客总人数（触发条件是落单数 > 0）
  }>;
}

/** 富余提醒窗口（天）— 距今 3 天内还剩包房就该考虑退房了。*/
const SURPLUS_WINDOW_DAYS = 3;

/** 班次超员检查窗口（天）。*/
const SCHEDULE_ALERT_WINDOW_DAYS = 30;

/** 拼房客落单主动提醒窗口（天）— 入住在此天数内且当晚有拼房客落单（落单数>0）就推送。*/
const SHARED_ODD_NEAR_DAYS = 7;

/**
 * 按需计算提醒线（无 cron）：
 *   - 超卖 / 富余直接复用销控板 getBoard 的展开结果，不重复口径；
 *   - 班次乘客数按导出同款 COUNTED_STATUSES 统计，对比 FlightSchedule.ticketingCap（默认 191）。
 *
 * 星级随机池同样是 getBoard 的一个分组，因此池的超卖 / 富余 / 拼房落单一并进提醒线；
 * 此时 hotelName = 「三星随机」/「四星随机」、hotelId = 池合成键（非真实酒店 id，仅供去重）。
 */
export async function getAlerts(
  days: number,
  client: PrismaClient = defaultPrisma,
): Promise<HotelControlAlerts> {
  const today = new Date().toISOString().slice(0, 10);
  const fromMs = toDateOnly(today).getTime();
  // [today, today+days) → 销控板闭区间 [today, today+days-1]
  const to = new Date(fromMs + (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const board = await getBoard({ from: today, to }, client);

  const oversold: HotelControlAlerts['oversold'] = [];
  const surplusSoon: HotelControlAlerts['surplusSoon'] = [];
  const sharedOddNear: HotelControlAlerts['sharedOddNear'] = [];
  const surplusCutoff = new Date(fromMs + SURPLUS_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  // 拼房落单临近窗口：入住晚在 [today, today+SHARED_ODD_NEAR_DAYS) 内即算「临近」。
  const sharedOddCutoff = new Date(fromMs + SHARED_ODD_NEAR_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  for (const hotel of board.hotels) {
    for (let i = 0; i < board.dates.length; i++) {
      const date = board.dates[i];
      const block = hotel.rows.block[i];
      const used = hotel.rows.used[i];
      const remaining = hotel.rows.remaining[i];
      if (remaining < 0) {
        oversold.push({
          hotelId: hotel.hotelId,
          hotelName: hotel.hotelName,
          date,
          block,
          used,
          deficit: used - block,
        });
      }
      if (date < surplusCutoff && block > 0 && remaining > 0) {
        surplusSoon.push({ hotelName: hotel.hotelName, date, surplus: remaining });
      }
      // 有拼房客落单（异性不能拼、未知独占后仍无法配对）且入住临近 → 主动提醒补单房差 / 另配
      const shared = hotel.rows.sharedHalfCount[i];
      const unpaired = hotel.rows.sharedUnpaired[i];
      if (date < sharedOddCutoff && unpaired > 0) {
        sharedOddNear.push({
          hotelId: hotel.hotelId,
          hotelName: hotel.hotelName,
          date,
          sharedHalfCount: shared,
        });
      }
    }
  }

  // 班次乘客数 > 开票上限 — 出发日在 [today, today+30d)
  const fromD = toDateOnly(today);
  const horizon = new Date(fromD.getTime() + SCHEDULE_ALERT_WINDOW_DAYS * DAY_MS);
  const schedules = await client.flightSchedule.findMany({
    where: { departureTime: { gte: fromD, lt: horizon } },
    orderBy: { departureTime: 'asc' },
    select: {
      id: true,
      departureTime: true,
      // 座位库存 = Σ 各舱位 capacity（商务 + 经济 + …），与开票上限同源（见 orders/ticketing-cap.ts）。
      // 曾经这里读 FlightSchedule.ticketingCap（常量 191）—— 那是与真实座位数从不对账的第二本账，已删。
      seatClasses: { select: { capacity: true } },
      flight: { select: { flightNumber: true } },
    },
  });
  const paxCounts = await Promise.all(
    schedules.map((s) =>
      client.passenger.count({
        where: {
          order: {
            deletedAt: null, // 排除已软删订单
            status: { in: COUNTED_STATUSES },
            items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: s.id } },
          },
        },
      }),
    ),
  );
  const overCapacitySchedules: HotelControlAlerts['overCapacitySchedules'] = [];
  schedules.forEach((s, i) => {
    // 一个舱位都没配的班次 → 无库存可比，跳过（与 getScheduleSeatCapacity 同口径：
    // 这种班次本来就卖不出座，把上限当 0 会把它全部报成超员）。
    if (s.seatClasses.length === 0) return;
    const seatCapacity = s.seatClasses.reduce((sum, sc) => sum + sc.capacity, 0);
    if (paxCounts[i] > seatCapacity) {
      overCapacitySchedules.push({
        flightNumber: s.flight.flightNumber,
        departureDate: fmtDateOnly(s.departureTime),
        paxCount: paxCounts[i],
      });
    }
  });

  return { oversold, surplusSoon, overCapacitySchedules, sharedOddNear };
}

// ── 近期用房变更（读审计流，不新做事件系统）────────────────────────────────
/**
 * 会实际改动酒店用房口径、或影响占房行程日期的订单操作 —— 全部由 orders 路由在成功后 writeAudit 落库：
 *   UPDATE_ROOM_ASSIGNMENT  调整分房（改 roomAssignment / 计费房数 → 直接影响「占」）
 *   SWAP_ORDER_ITEM_HOTEL   换酒店（改 hotelRoomTypeId → 换一家酒店占房）
 *   ADD_ROOM_SUPPLEMENT     补收单房差（房数/房态相关的售后补收）
 *   RESCHEDULE_ORDER_ITEM   改期（改航班班次/出发日）——不落 hotelCheckIn/hotelCheckOut，
 *                           不改变销控板占房数字口径，但会改变出行日期，房控需要能看到这单动了。
 * 四者 targetType 均为 ORDER、targetId=订单 id、targetLabel=订单号。
 */
export const ROOM_CHANGE_ACTIONS = [
  'UPDATE_ROOM_ASSIGNMENT',
  'SWAP_ORDER_ITEM_HOTEL',
  'ADD_ROOM_SUPPLEMENT',
  'RESCHEDULE_ORDER_ITEM',
] as const;

/** 近期用房变更返回上限（条）。*/
const ROOM_CHANGE_LIMIT = 100;

const ROOM_CHANGE_ACTION_LABELS: Record<string, string> = {
  UPDATE_ROOM_ASSIGNMENT: '调整分房',
  SWAP_ORDER_ITEM_HOTEL: '换酒店',
  ADD_ROOM_SUPPLEMENT: '补收单房差',
  RESCHEDULE_ORDER_ITEM: '改期',
};

export interface HotelRoomChangeEntry {
  id: string;
  action: string;
  actionLabel: string; // 人类可读中文（不含任何内部人名）
  orderId: string | null; // = AuditLog.targetId
  orderNumber: string | null; // = AuditLog.targetLabel
  actor: string | null; // 操作人（displayName/email/角色，运行期真实数据）
  summary: string; // 关键字段摘要（房数/酒店等）
  severity: string;
  at: string; // ISO8601
  /** 出行人姓名（优先中文名，无则回落护照姓名；占位联系人不列）。订单查不到/已软删 → []。 */
  passengerNames: string[];
  /** 出发日（YYYY-MM-DD，按出发地时区折算）——订单 FLIGHT 行按班次 departureTime 升序第 1 段；无航段/查不到订单 → null。 */
  departDate: string | null;
  /** 返程日（YYYY-MM-DD）——FLIGHT 行第 2 段；单程/无航段/查不到订单 → null。 */
  returnDate: string | null;
  /** 订单总额（CNY）= Order.total；查不到订单 → null。 */
  orderAmountCny: number | null;
}

export interface HotelRecentRoomChanges {
  days: number;
  count: number;
  changes: HotelRoomChangeEntry[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** 从 before/after JSON 里挑关键字段拼出一句人类可读的变更摘要。*/
function summarizeRoomChange(action: string, before: unknown, after: unknown): string {
  const b = asRecord(before);
  const a = asRecord(after);
  if (action === 'UPDATE_ROOM_ASSIGNMENT') {
    const from = readNum(b.roomsBilled);
    const to = readNum(a.roomsBilled);
    if (from != null && to != null && from !== to) return `计费房数 ${from} → ${to} 间`;
    if (to != null) return `分房调整（计费房数 ${to} 间）`;
    return '分房调整';
  }
  if (action === 'SWAP_ORDER_ITEM_HOTEL') {
    const fromH = readStr(b.hotelName);
    const fromR = readStr(b.roomTypeName);
    const toH = readStr(a.hotelName);
    const toR = readStr(a.roomTypeName);
    const fromLabel = fromH ? `${fromH}${fromR ? `·${fromR}` : ''}` : '原酒店';
    const toLabel = toH ? `${toH}${toR ? `·${toR}` : ''}` : '新酒店';
    return `换酒店 ${fromLabel} → ${toLabel}`;
  }
  if (action === 'ADD_ROOM_SUPPLEMENT') {
    const perNight = readNum(a.perNightCny);
    const nights = readNum(a.nights);
    const amount = readNum(a.amountCny);
    if (perNight != null && nights != null) {
      return `补收单房差 ${perNight}元 × ${nights} 晚${amount != null ? ` = ${amount} 元` : ''}`;
    }
    return '补收单房差';
  }
  if (action === 'RESCHEDULE_ORDER_ITEM') {
    // before/after.departure 是 writeAudit 落库时 Date.toISOString() 的完整 ISO8601 串（非 @db.Date）。
    const fromDate = readStr(b.departure)?.slice(0, 10) ?? null;
    const toDate = readStr(a.departure)?.slice(0, 10) ?? null;
    if (fromDate && toDate && fromDate !== toDate) return `改期 ${fromDate} → ${toDate}`;
    if (toDate) return `改期至 ${toDate}`;
    return '改期';
  }
  return ROOM_CHANGE_ACTION_LABELS[action] ?? action;
}

interface RoomChangeOrderInfo {
  passengerNames: string[];
  departDate: string | null;
  returnDate: string | null;
  orderAmountCny: number | null;
}

/**
 * 按 orderId 去重批量查订单，给「近期用房变更」面板补充乘客姓名/出行日期/订单金额。
 * 查不到的订单（id 已失效等）不在返回的 Map 里——调用方按 undefined 处理，各字段置 null/[]，不抛错。
 */
async function buildRoomChangeOrderInfo(
  orderIds: string[],
  client: PrismaClient,
): Promise<Map<string, RoomChangeOrderInfo>> {
  const map = new Map<string, RoomChangeOrderInfo>();
  if (orderIds.length === 0) return map;

  const orders = await client.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      total: true,
      passengers: { select: { documentNumber: true, chineseName: true, fullName: true } },
      // 出发/返程日：订单 FLIGHT 行按班次 departureTime 升序，第 1 段=去程、第 2 段=回程（与 Order.outboundInvoiced 注释同口径）。
      items: {
        where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        orderBy: { flightSchedule: { departureTime: 'asc' } },
        select: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
      },
    },
  });

  for (const order of orders) {
    const legs = order.items
      .map((it) => it.flightSchedule)
      .filter((fs): fs is NonNullable<typeof fs> => fs != null);
    map.set(order.id, {
      passengerNames: order.passengers
        .filter((p) => p.documentNumber !== 'N/A')
        .map((p) => p.chineseName?.trim() || p.fullName),
      departDate: legs[0] ? fmtDepartureLocalDate(legs[0].departureTime, legs[0].departureTz) : null,
      returnDate: legs[1] ? fmtDepartureLocalDate(legs[1].departureTime, legs[1].departureTz) : null,
      orderAmountCny: dec(order.total),
    });
  }
  return map;
}

/**
 * 近期用房变更（近 N 天，倒序，上限 100 条）——读 AuditLog 中会影响用房的订单操作，
 * 并批量补充乘客姓名/出行日期/订单金额，方便房控核对是谁、哪天走、多少钱的单动了用房。
 * 给房控看板顶部「近期用房变更」面板做可见性，不做已读态、不建事件系统。
 */
export async function getRecentRoomChanges(
  days: number,
  client: PrismaClient = defaultPrisma,
): Promise<HotelRecentRoomChanges> {
  const since = new Date(Date.now() - days * DAY_MS);
  const logs = await client.auditLog.findMany({
    where: {
      action: { in: [...ROOM_CHANGE_ACTIONS] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: ROOM_CHANGE_LIMIT,
    select: {
      id: true,
      action: true,
      targetId: true,
      targetLabel: true,
      before: true,
      after: true,
      severity: true,
      createdAt: true,
      actorLabel: true,
      actorRole: true,
      actor: { select: { displayName: true, email: true } },
    },
  });

  const orderIds = Array.from(
    new Set(logs.map((log) => log.targetId).filter((id): id is string => !!id)),
  );
  const orderInfoById = await buildRoomChangeOrderInfo(orderIds, client);

  const changes: HotelRoomChangeEntry[] = logs.map((log) => {
    const info = log.targetId ? orderInfoById.get(log.targetId) : undefined;
    return {
      id: log.id,
      action: log.action,
      actionLabel: ROOM_CHANGE_ACTION_LABELS[log.action] ?? log.action,
      orderId: log.targetId,
      orderNumber: log.targetLabel,
      actor:
        log.actor?.displayName ??
        log.actor?.email ??
        log.actorLabel ??
        (log.actorRole ? String(log.actorRole) : null),
      summary: summarizeRoomChange(log.action, log.before, log.after),
      severity: String(log.severity),
      at: log.createdAt.toISOString(),
      passengerNames: info?.passengerNames ?? [],
      departDate: info?.departDate ?? null,
      returnDate: info?.returnDate ?? null,
      orderAmountCny: info?.orderAmountCny ?? null,
    };
  });

  return { days, count: changes.length, changes };
}

// ── 远期视图（按日期跨酒店合计）──────────────────────────────────────────
export interface HotelControlForward {
  dates: string[];
  held: number[]; // 切房合计
  occupied: number[]; // 占房合计
  remaining: number[]; // held - occupied
}

export async function getForward(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<HotelControlForward> {
  const board = await getBoard(range, client);
  const held = board.dates.map((_, i) =>
    board.hotels.reduce((sum, h) => sum + h.rows.block[i], 0),
  );
  const occupied = board.dates.map((_, i) =>
    board.hotels.reduce((sum, h) => sum + h.rows.used[i], 0),
  );
  const remaining = held.map((v, i) => v - occupied[i]);
  return { dates: board.dates, held, occupied, remaining };
}

// ── 占房下钻（某酒店某晚，谁占的；销控矩阵余量格点击下钻用）──────────────────
export interface HotelOccupantDto {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  contactName: string;
  /** 该订单出行人数（占位联系人 documentNumber='N/A' 不计，口径同前台分房池） */
  passengerCount: number;
  /**
   * 该订单出行人姓名（优先中文名，无则回落护照姓名；占位联系人 documentNumber='N/A' 不列）。
   * 用于房控核对分房——一眼看清这几间房住的是哪几个人。
   */
  passengerNames: string[];
  /**
   * 该占房行的间数。有权威分房表（Order.roomAssignment.roomGroups）的订单按
   * 「有乘客的房间盒子数」展示（物理间数，覆盖被塌缩的 roomsBilled）；
   * 否则与销控板「用房」同口径（见 itemRoomCount）。
   */
  rooms: number;
  checkIn: string; // YYYY-MM-DD（该行入住日）
  checkOut: string; // YYYY-MM-DD（该行退房日）
  agentName: string; // 无代理 = '直客'
}

/**
 * 某酒店某晚的占房订单明细。过滤口径与 getHotelNightlyRemaining 的 used 完全一致
 * （COUNTED_STATUSES + [checkIn, checkOut) 半开区间覆盖该晚）。
 * 一个订单若有多行占该酒店该晚（如同订单订了两种房型）展开成多行、不做订单级合并——
 * 每行对应一次真实占房，避免合并后间数/入住区间失真。
 */
export async function getOccupyingOrders(
  scope: string | RoomScope,
  date: string,
  client: PrismaClient = defaultPrisma,
): Promise<HotelOccupantDto[]> {
  // 兼容既有按 hotelId 字符串调用（分房表导出等）
  const roomScope: RoomScope = typeof scope === 'string' ? { hotelId: scope } : scope;
  const d = toDateOnly(date);
  const items = await client.orderItem.findMany({
    where: {
      ...scopeItemWhere(roomScope),
      hotelCheckIn: { lte: d },
      hotelCheckOut: { gt: d },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    orderBy: { hotelCheckIn: 'asc' },
    select: {
      roomsBilled: true,
      metadata: true,
      hotelCheckIn: true,
      hotelCheckOut: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          contactName: true,
          roomAssignment: true, // 权威分房表——间数展示优先按「有乘客的房间盒子数」
          agent: { select: { companyName: true } },
          passengers: { select: { documentNumber: true, chineseName: true, fullName: true } },
        },
      },
    },
  });

  return items
    .filter((it) => it.hotelCheckIn != null && it.hotelCheckOut != null)
    .map((it) => ({
      orderId: it.order.id,
      orderNumber: it.order.orderNumber,
      status: it.order.status,
      contactName: it.order.contactName,
      passengerCount: it.order.passengers.filter((p) => p.documentNumber !== 'N/A').length,
      passengerNames: it.order.passengers
        .filter((p) => p.documentNumber !== 'N/A')
        .map((p) => p.chineseName?.trim() || p.fullName),
      rooms: assignedPhysicalRooms(it.order.roomAssignment) ?? itemRoomCount(it),
      checkIn: fmtDateOnly(it.hotelCheckIn!),
      checkOut: fmtDateOnly(it.hotelCheckOut!),
      agentName: it.order.agent?.companyName ?? '直客',
    }));
}

// ── 当日余量（给定房型 + 入住区间；分房弹窗徽标用）───────────────────────────
export interface HotelNightlyRemainingResult {
  dates: string[];
  remaining: number[];
  block: number[];
  hasBlock: boolean;
}

/** [checkIn, checkOut) 逐晚展开为 YYYY-MM-DD（半开区间）。*/
function buildNightDates(checkIn: string, checkOut: string): string[] {
  const fromMs = toDateOnly(checkIn).getTime();
  const toMs = toDateOnly(checkOut).getTime();
  const nights = Math.max(0, Math.round((toMs - fromMs) / DAY_MS));
  return Array.from({ length: nights }, (_, i) =>
    new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * 由 hotelRoomTypeId 解出 hotelId 后复用 getHotelNightlyRemaining——分房弹窗徽标（RoomingEditor）用。
 * ADMIN/STAFF only：直接回原始数字，与前台 /products/hotel-availability 的档位口径不同（那是公开端点，
 * 只回 tier 不回数字）。
 *
 * `remaining` 回的是**物理房间口径**（physicalRemaining），与销控板看板 / 房态导出 / 下单闸完全一致：
 * 分房是按真实房间盒子摆人的，徽标必须回真实可用整间数。床位口径（block − Σ roomsBilled）会把
 * 「男+女各一位拼房客」算成 1 间、把落单拼房客算成半间，分房时照着摆必然摆不下。
 */
export async function getNightlyRemainingForRoomType(
  hotelRoomTypeId: string,
  checkIn: string,
  checkOut: string,
  client: PrismaClient = defaultPrisma,
): Promise<HotelNightlyRemainingResult> {
  const roomType = await client.hotelRoomType.findUnique({
    where: { id: hotelRoomTypeId },
    select: { hotelId: true },
  });
  if (!roomType) throw new NotFoundError('房型不存在');

  const dates = buildNightDates(checkIn, checkOut);
  const { physicalRemaining, block, hasBlock } = await getHotelNightlyRemaining(
    roomType.hotelId,
    dates,
    client,
  );
  return { dates, remaining: physicalRemaining, block, hasBlock };
}
