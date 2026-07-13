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
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计日志（镜像 finances 成本周期风格）。
 */
import { OrderItemKind, OrderStatus, Prisma, type Gender, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
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
  id: string;
  hotelId: string;
  hotelName: string;
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
    hotelName: row.hotel.name,
    dateFrom: fmtDateOnly(row.dateFrom),
    dateTo: fmtDateOnly(row.dateTo),
    rooms: row.rooms,
    unitPrice: price == null ? null : round2(price),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listBlockPeriods(
  filter: { hotelId?: string } = {},
  client: PrismaClient = defaultPrisma,
): Promise<HotelBlockPeriodDto[]> {
  const rows = await client.hotelBlockPeriod.findMany({
    where: filter.hotelId ? { hotelId: filter.hotelId } : undefined,
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
  const hotel = await client.hotel.findUnique({
    where: { id: input.hotelId },
    select: { id: true },
  });
  if (!hotel) throw new NotFoundError('酒店不存在');

  const row = await client.hotelBlockPeriod.create({
    data: {
      hotelId: input.hotelId,
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
 * TODO(房控-下一波): 运营故意混拼（Order.roomAssignment 分房表已指定同房不同性别）时，
 * 应读分房表覆盖此按性别的保守推算；当前迭代不做（分房表覆盖留待后续）。
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
      // 拼房客性别（异性不能拼一间）——物理房间口径 physicalRemaining 需要，口径同 getBoard
      order: { select: { passengers: { select: { gender: true } } } },
    },
  });

  const block = expandBlockByDate(periods, nightDates);
  const used = expandUsedByDate(items, nightDates);
  // 物理房间口径（与销控板 getBoard / 房态导出同口径）：按性别分桶推算真实占用整间数，
  // 而不是直接对床位用量取 ceil——避免"男+女各半间"被误算成 1 间（异性不能拼）。
  const buckets = expandSharedHalfByDate(items, nightDates);
  const physicalUsed = computePhysicalUsed(used, buckets);
  const physicalRemaining = block.map((b, i) => round2(b - physicalUsed[i]));

  return {
    remaining: block.map((b, i) => b - used[i]),
    hasBlock: true,
    block,
    physicalRemaining,
  };
}

// ── 销控板（按酒店 × 日期）────────────────────────────────────────────────
export interface HotelControlBoard {
  dates: string[];
  hotels: Array<{
    hotelId: string;
    hotelName: string;
    /** 最新周期（dateFrom 最晚且有价）的切房单价；都没填则 null */
    unitPrice: number | null;
    rows: {
      block: number[];
      /** 床位口径占房：Σ roomsBilled（拼房客各计 0.5，可为小数），逐日 */
      used: number[];
      /** 床位口径余量 = block - used，逐日 */
      remaining: number[];
      /** 当晚拼房客（roomsBilled==0.5）总人数（含各性别），逐日 */
      sharedHalfCount: number[];
      /**
       * 当晚无法配对的拼房客数（落单数），逐日。
       * = m%2 + f%2 + u（同性两两配对后的余数 + 未知性别全算落单）。
       */
      sharedUnpaired: number[];
      /** 当晚有拼房客无法配对（sharedUnpaired > 0，需补单房差或另行配对），逐日 */
      sharedOdd: boolean[];
      /**
       * 物理房间口径占房：真实占用的整间数，逐日。
       * = ceil(男/2) + ceil(女/2) + 未知 + 整间预订数
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
  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      hotelRoomType: { select: { hotelId: true, hotel: { select: { name: true } } } },
      // 拼房客性别（异性不能拼一间）——拼房单恒为 adultCount===1 的套餐单，取其出行人性别；
      // 仅取 gender 字段、批量随主查带回，不额外查库（见 expandSharedHalfByDate / pickSoloGender）。
      order: { select: { passengers: { select: { gender: true } } } },
    },
  });

  // 酒店集合 = 有周期的 ∪ 有占房的
  const hotelNames = new Map<string, string>();
  for (const p of periods) hotelNames.set(p.hotelId, p.hotel.name);
  for (const it of items) {
    if (it.hotelRoomType && !hotelNames.has(it.hotelRoomType.hotelId)) {
      hotelNames.set(it.hotelRoomType.hotelId, it.hotelRoomType.hotel.name);
    }
  }

  const hotels = Array.from(hotelNames.entries())
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
    .map(([hotelId, hotelName]) => {
      const hotelPeriods = periods.filter((p) => p.hotelId === hotelId);
      const hotelItems = items.filter((it) => it.hotelRoomType?.hotelId === hotelId);
      const block = expandBlockByDate(hotelPeriods, dates);
      const used = expandUsedByDate(hotelItems, dates);
      // 拼房客（0.5 半间）逐日按性别分桶（异性不能拼一间；同一份占房行复用，O(items)）
      const buckets = expandSharedHalfByDate(hotelItems, dates);
      const sharedHalfCount = buckets.m.map((mv, i) => mv + buckets.f[i] + buckets.u[i]);
      // 落单数 = 同性两两配对后的余数 + 未知性别（全算落单）
      const sharedUnpaired = buckets.m.map((mv, i) => (mv % 2) + (buckets.f[i] % 2) + buckets.u[i]);
      const sharedOdd = sharedUnpaired.map((n) => n > 0);

      const remaining = block.map((b, i) => b - used[i]);
      // 物理房间口径（内存推导，无额外查库）：整间占用数 + 余量
      const physicalUsed = computePhysicalUsed(used, buckets);
      const physicalRemaining = block.map((b, i) => round2(b - physicalUsed[i]));
      const latestPriced = hotelPeriods.find((p) => p.unitPrice != null);
      const unitPrice = latestPriced ? round2(dec(latestPriced.unitPrice)!) : null;

      return {
        hotelId,
        hotelName,
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
      ticketingCap: true,
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
    if (paxCounts[i] > s.ticketingCap) {
      overCapacitySchedules.push({
        flightNumber: s.flight.flightNumber,
        departureDate: fmtDateOnly(s.departureTime),
        paxCount: paxCounts[i],
      });
    }
  });

  return { oversold, surplusSoon, overCapacitySchedules, sharedOddNear };
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
  /** 该占房行的间数（与销控板「用房」同口径，见 itemRoomCount） */
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
  hotelId: string,
  date: string,
  client: PrismaClient = defaultPrisma,
): Promise<HotelOccupantDto[]> {
  const d = toDateOnly(date);
  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelRoomType: { hotelId },
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
      rooms: itemRoomCount(it),
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
  const { remaining, block, hasBlock } = await getHotelNightlyRemaining(roomType.hotelId, dates, client);
  return { dates, remaining, block, hasBlock };
}
