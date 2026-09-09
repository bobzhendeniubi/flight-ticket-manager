/**
 * 酒店房型净房价 · 按日期区间取价（财务成本侧）
 *
 * 背景：净房价按日期浮动（周末/节假日/淡旺季），房型上只有一个缺省 costPriceCny 填不准。
 * 本模块提供：
 *   1) 纯函数取价口径（不依赖 DB，供录单成本快照 / 报表回退 / 单测共用）：
 *      - 某一晚：覆盖该晚的区间价 → 否则房型缺省价 → 都没有 = null（真缺数据如实报缺，不落 0 虚高）
 *      - 一段住宿：逐晚累加 × 房数；任一晚取不到价 → 整体 null
 *   2) 区间 CRUD（同房型区间不得重叠，冲突 409）。
 *
 * 日期口径：@db.Date 经 Prisma 出来是 **UTC 零点** 的 Date，所有比较都按 UTC 的 YYYY-MM-DD
 * 做 date-only 比较，绝不折本地时区（否则会把一晚折成前一天）。
 *
 * 不联动：房控 HotelBlockPeriod.unitPrice（切房单价）与本模块无关；售价、库存、占房逻辑一概不碰。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

// ── 纯函数取价口径 ────────────────────────────────────────────────────────────

/** 区间输入（DB 行或 DTO 都能喂：日期收 Date（UTC 零点）或 'YYYY-MM-DD'；价收 Decimal/number）。 */
export interface HotelCostPeriodInput {
  effectiveFrom: Date | string;
  effectiveTo: Date | string;
  costPriceCny: Prisma.Decimal | number | string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 逐晚展开的防御上限：超过视为区间异常，回退「缺省价 × 晚数」而不是跑一个巨大循环。 */
const MAX_STAY_NIGHTS_FOR_PERIODS = 366;

/** Date（UTC 零点）或 'YYYY-MM-DD' → 'YYYY-MM-DD'（date-only，按 UTC 取，不折时区）。 */
export function toYmd(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function toNumber(v: Prisma.Decimal | number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 某一晚的净房价：覆盖该晚（effectiveFrom ≤ night ≤ effectiveTo，含两端，date-only）的区间价
 * → 否则房型缺省价 baseCostCny → 都没有 = null。
 * 多条区间同时覆盖（理论上被重叠校验挡住）时取第一条命中的。
 */
export function resolveHotelNightCostCny(
  periods: ReadonlyArray<HotelCostPeriodInput> | null | undefined,
  baseCostCny: Prisma.Decimal | number | string | null | undefined,
  night: Date | string,
): number | null {
  const ymd = toYmd(night);
  for (const p of periods ?? []) {
    if (toYmd(p.effectiveFrom) <= ymd && ymd <= toYmd(p.effectiveTo)) {
      const price = toNumber(p.costPriceCny);
      if (price != null) return price;
    }
  }
  return toNumber(baseCostCny);
}

/**
 * 把住宿区间 [checkIn, checkOut)（半开）展开为逐晚 'YYYY-MM-DD'（UTC date-only）。
 * 区间非法（checkOut ≤ checkIn）或超长 → null（调用方走无日期回退）。
 */
export function expandStayNights(checkIn: Date | string, checkOut: Date | string): string[] | null {
  const startMs = Date.parse(`${toYmd(checkIn)}T00:00:00.000Z`);
  const endMs = Date.parse(`${toYmd(checkOut)}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const nights = Math.round((endMs - startMs) / DAY_MS);
  if (nights < 1 || nights > MAX_STAY_NIGHTS_FOR_PERIODS) return null;
  return Array.from({ length: nights }, (_, i) => new Date(startMs + i * DAY_MS).toISOString().slice(0, 10));
}

export interface HotelStayCostInput {
  periods: ReadonlyArray<HotelCostPeriodInput> | null | undefined;
  baseCostCny: Prisma.Decimal | number | string | null | undefined;
  checkIn?: Date | string | null;
  checkOut?: Date | string | null;
  /** 计费房数（支持 0.5 间）；缺省 1。 */
  rooms?: number;
  /** 无入住日期时的晚数（回退 缺省价 × nights）；缺省 1。 */
  nights?: number;
}

/**
 * 一段住宿的净房价合计：逐晚（区间价优先，否则缺省价）累加 × rooms。
 *   - 任一晚取不到价 → 整体 null（真缺数据如实报 null，不落 0）。
 *   - 无入住/退房日期（或区间非法）→ 回退原逻辑：缺省价 × nights × rooms；缺省价为空 → null。
 * 返回值保留两位小数（不做整数四舍五入，四舍五入交给各快照点按既有口径处理）。
 */
export function hotelStayCostCny(input: HotelStayCostInput): number | null {
  const rooms = input.rooms ?? 1;
  const stayNights =
    input.checkIn != null && input.checkOut != null ? expandStayNights(input.checkIn, input.checkOut) : null;
  if (stayNights == null) {
    const base = toNumber(input.baseCostCny);
    if (base == null) return null;
    return round2(base * (input.nights ?? 1) * rooms);
  }
  let sum = 0;
  for (const night of stayNights) {
    const nightly = resolveHotelNightCostCny(input.periods, input.baseCostCny, night);
    if (nightly == null) return null;
    sum += nightly;
  }
  return round2(sum * rooms);
}

/**
 * 一段住宿的「平均每间每晚」净房价 —— 供沿用 `unitCostCny（每间每晚）× 晚数 × 房数` 公式的
 * 快照点使用：有日期时 = 逐晚合计 ÷ 晚数（两位小数）；无日期 → 缺省价；缺数据 → null。
 * 平均值 × 晚数 = 逐晚合计（两位小数内），所以 totalCostCny 仍与 amount 同口径缩放。
 */
export function resolveHotelStayUnitCostCny(input: Omit<HotelStayCostInput, 'rooms' | 'nights'>): number | null {
  const stayNights =
    input.checkIn != null && input.checkOut != null ? expandStayNights(input.checkIn, input.checkOut) : null;
  if (stayNights == null) return toNumber(input.baseCostCny);
  const total = hotelStayCostCny({ ...input, rooms: 1 });
  if (total == null) return null;
  return round2(total / stayNights.length);
}

/** 两段闭区间是否重叠（date-only，含两端）。 */
export function hotelCostPeriodsOverlap(
  a: { effectiveFrom: Date | string; effectiveTo: Date | string },
  b: { effectiveFrom: Date | string; effectiveTo: Date | string },
): boolean {
  return toYmd(a.effectiveFrom) <= toYmd(b.effectiveTo) && toYmd(b.effectiveFrom) <= toYmd(a.effectiveTo);
}

// ── 批量取数（报表回退用，一次 load 进 Map，别 N+1）─────────────────────────

/** 报表 fallback 用的周期行。 */
export interface HotelCostPeriodRow {
  roomTypeId: string;
  effectiveFrom: Date;
  effectiveTo: Date;
  costPriceCny: Prisma.Decimal;
}

/** 给一批房型 id 批量预加载净房价区间，返回 Map<roomTypeId, periods[]>。空 id 列表不查库。 */
export async function loadHotelCostPeriodsByRoomTypeIds(
  roomTypeIds: ReadonlyArray<string | null | undefined>,
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, HotelCostPeriodRow[]>> {
  const ids = Array.from(new Set(roomTypeIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
  const map = new Map<string, HotelCostPeriodRow[]>();
  if (ids.length === 0) return map;
  const rows = await client.hotelRoomTypeCostPeriod.findMany({
    where: { roomTypeId: { in: ids } },
    orderBy: { effectiveFrom: 'asc' },
    select: { roomTypeId: true, effectiveFrom: true, effectiveTo: true, costPriceCny: true },
  });
  for (const r of rows) {
    const arr = map.get(r.roomTypeId) ?? [];
    arr.push(r);
    map.set(r.roomTypeId, arr);
  }
  return map;
}

// ── 区间 CRUD（ADMIN/STAFF）──────────────────────────────────────────────────

type HotelCostPeriodClient = PrismaClient | Prisma.TransactionClient;

export interface HotelRoomTypeCostPeriodDto {
  id: string;
  roomTypeId: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  costPriceCny: number;
  note: string | null;
  updatedAt: string;
}

export interface HotelRoomTypeCostPeriodWriteInput {
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  costPriceCny: number;
  note?: string | null;
}

function toDateOnly(s: string): Date {
  // 'YYYY-MM-DD' → UTC 零点；@db.Date 的规范写法（与航班成本周期同款）。
  return new Date(`${s}T00:00:00.000Z`);
}

function toDto(row: {
  id: string;
  roomTypeId: string;
  effectiveFrom: Date;
  effectiveTo: Date;
  costPriceCny: Prisma.Decimal;
  note: string | null;
  updatedAt: Date;
}): HotelRoomTypeCostPeriodDto {
  return {
    id: row.id,
    roomTypeId: row.roomTypeId,
    effectiveFrom: toYmd(row.effectiveFrom),
    effectiveTo: toYmd(row.effectiveTo),
    costPriceCny: round2(Number(row.costPriceCny.toString())),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listHotelRoomTypeCostPeriods(
  roomTypeId: string,
  client: PrismaClient = defaultPrisma,
): Promise<HotelRoomTypeCostPeriodDto[]> {
  const rows = await client.hotelRoomTypeCostPeriod.findMany({
    where: { roomTypeId },
    orderBy: { effectiveFrom: 'asc' },
  });
  return rows.map(toDto);
}

/**
 * 同房型区间写入的串行化闸：先锁住房型行，再查重叠再写（与航班成本周期同一思路——
 * 「先查后写」挡不住两个人同时录重叠区间，库里没有 EXCLUDE 约束兜底，靠行锁排队）。
 */
async function lockRoomTypeForCostPeriods(tx: HotelCostPeriodClient, roomTypeId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "HotelRoomType" WHERE id = ${roomTypeId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('酒店房型不存在');
}

/** 校验：from ≤ to；同房型不得与现有区间重叠（excludeId 用于 update 时排除自己）。冲突 409。 */
async function assertNoHotelCostPeriodOverlap(
  roomTypeId: string,
  from: Date,
  to: Date,
  excludeId: string | null,
  client: HotelCostPeriodClient,
): Promise<void> {
  if (from.getTime() > to.getTime()) {
    throw new ConflictError('起始日不能晚于结束日');
  }
  const overlap = await client.hotelRoomTypeCostPeriod.findFirst({
    where: {
      roomTypeId,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
      AND: [{ effectiveFrom: { lte: to } }, { effectiveTo: { gte: from } }],
    },
    select: { id: true, effectiveFrom: true, effectiveTo: true },
  });
  if (overlap) {
    throw new ConflictError(
      `日期区间与该房型现有区间重叠（${toYmd(overlap.effectiveFrom)} → ${toYmd(overlap.effectiveTo)}）`,
    );
  }
}

export async function createHotelRoomTypeCostPeriod(
  roomTypeId: string,
  input: HotelRoomTypeCostPeriodWriteInput,
  client: PrismaClient = defaultPrisma,
): Promise<HotelRoomTypeCostPeriodDto> {
  const from = toDateOnly(input.effectiveFrom);
  const to = toDateOnly(input.effectiveTo);
  return client.$transaction(async (tx) => {
    await lockRoomTypeForCostPeriods(tx, roomTypeId);
    await assertNoHotelCostPeriodOverlap(roomTypeId, from, to, null, tx);
    const row = await tx.hotelRoomTypeCostPeriod.create({
      data: {
        roomTypeId,
        effectiveFrom: from,
        effectiveTo: to,
        costPriceCny: new Prisma.Decimal(input.costPriceCny),
        note: input.note ?? null,
      },
    });
    return toDto(row);
  });
}

export async function updateHotelRoomTypeCostPeriod(
  id: string,
  input: Partial<HotelRoomTypeCostPeriodWriteInput>,
  client: PrismaClient = defaultPrisma,
): Promise<HotelRoomTypeCostPeriodDto> {
  return client.$transaction(async (tx) => {
    // 先锁住这条区间所属的房型行，再在锁里重读本行、查重叠、写。
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT rt.id FROM "HotelRoomType" rt
      JOIN "HotelRoomTypeCostPeriod" p ON p."roomTypeId" = rt.id
      WHERE p.id = ${id}
      FOR UPDATE OF rt`;
    if (locked.length === 0) throw new NotFoundError('净房价区间不存在');
    const existing = await tx.hotelRoomTypeCostPeriod.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('净房价区间不存在');
    const from = input.effectiveFrom ? toDateOnly(input.effectiveFrom) : existing.effectiveFrom;
    const to = input.effectiveTo ? toDateOnly(input.effectiveTo) : existing.effectiveTo;
    if (input.effectiveFrom || input.effectiveTo) {
      await assertNoHotelCostPeriodOverlap(existing.roomTypeId, from, to, id, tx);
    }
    const data: Prisma.HotelRoomTypeCostPeriodUpdateInput = {};
    if (input.effectiveFrom) data.effectiveFrom = from;
    if (input.effectiveTo) data.effectiveTo = to;
    if (input.costPriceCny !== undefined) data.costPriceCny = new Prisma.Decimal(input.costPriceCny);
    if (input.note !== undefined) data.note = input.note ?? null;
    const row = await tx.hotelRoomTypeCostPeriod.update({ where: { id }, data });
    return toDto(row);
  });
}

export async function deleteHotelRoomTypeCostPeriod(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string; roomTypeId: string }> {
  try {
    const row = await client.hotelRoomTypeCostPeriod.delete({ where: { id }, select: { id: true, roomTypeId: true } });
    return row;
  } catch (e: unknown) {
    // P2025 = 记录不存在（已被删或 id 无效）→ 404 友好文案而不是 500
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new NotFoundError('净房价区间不存在或已删除');
    }
    throw e;
  }
}
