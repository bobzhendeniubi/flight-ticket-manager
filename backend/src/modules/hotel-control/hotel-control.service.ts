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
import { OrderItemKind, OrderStatus, Prisma, type PrismaClient } from '@prisma/client';
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
 */
function itemRoomCount(it: {
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
): Promise<{ remaining: number[]; hasBlock: boolean; block: number[] }> {
  if (nightDates.length === 0) return { remaining: [], hasBlock: false, block: [] };
  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);

  const periods = await client.hotelBlockPeriod.findMany({
    where: { hotelId, dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    select: { dateFrom: true, dateTo: true, rooms: true },
  });
  if (periods.length === 0) return { remaining: [], hasBlock: false, block: [] };

  // 占晚区间 [checkIn, checkOut) 与夜晚集合有交集 ⇔ checkIn <= 最后一晚 && checkOut > 第一晚
  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelRoomType: { hotelId },
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { status: { in: COUNTED_STATUSES } },
    },
    select: { hotelCheckIn: true, hotelCheckOut: true, roomsBilled: true, metadata: true },
  });

  const block = expandBlockByDate(periods, nightDates);
  const used = expandUsedByDate(items, nightDates);
  return { remaining: block.map((b, i) => b - used[i]), hasBlock: true, block };
}

// ── 销控板（按酒店 × 日期）────────────────────────────────────────────────
export interface HotelControlBoard {
  dates: string[];
  hotels: Array<{
    hotelId: string;
    hotelName: string;
    /** 最新周期（dateFrom 最晚且有价）的切房单价；都没填则 null */
    unitPrice: number | null;
    rows: { block: number[]; used: number[]; remaining: number[] };
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
      order: { status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      hotelRoomType: { select: { hotelId: true, hotel: { select: { name: true } } } },
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
      const block = expandBlockByDate(hotelPeriods, dates);
      const used = expandUsedByDate(
        items.filter((it) => it.hotelRoomType?.hotelId === hotelId),
        dates,
      );

      const remaining = block.map((b, i) => b - used[i]);
      const latestPriced = hotelPeriods.find((p) => p.unitPrice != null);
      const unitPrice = latestPriced ? round2(dec(latestPriced.unitPrice)!) : null;

      return { hotelId, hotelName, unitPrice, rows: { block, used, remaining } };
    });

  return { dates, hotels };
}

// ── 提醒线（超卖加房 / 富余退房 / 班次超开票上限）────────────────────────
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
}

/** 富余提醒窗口（天）— 距今 3 天内还剩包房就该考虑退房了。*/
const SURPLUS_WINDOW_DAYS = 3;

/** 班次超员检查窗口（天）。*/
const SCHEDULE_ALERT_WINDOW_DAYS = 30;

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
  const surplusCutoff = new Date(fromMs + SURPLUS_WINDOW_DAYS * DAY_MS)
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

  return { oversold, surplusSoon, overCapacitySchedules };
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
