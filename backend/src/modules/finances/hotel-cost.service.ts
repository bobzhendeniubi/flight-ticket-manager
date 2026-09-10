/**
 * 酒店房型净房价 · 按日期区间取价 + 越南盾折算（财务成本侧）
 *
 * 背景：净房价按日期浮动（周末/节假日/淡旺季），房型上只有一个缺省 costPriceCny 填不准；
 * 酒店又按越南盾结算，财务希望录越南盾、由系统按合同汇率折人民币。
 * 本模块提供：
 *   1) 纯函数取价口径（不依赖 DB，供录单成本快照 / 报表回退 / 单测共用）：
 *      - 某一晚先取「当晚适用的价源」：覆盖该晚的区间 → 否则房型缺省 → 都没有 = null（真缺数据如实报缺，不落 0 虚高）。
 *        价源是人民币 → 照旧；价源是越南盾 → 按**当晚**生效的 VND 汇率行（costFxName 指定，空 = 通用行）折人民币，
 *        取不到汇率 → 该晚 null（如实缺数据，快照 / 报表里能看出「缺汇率」）。
 *      - 一段住宿：逐晚累加 × 房数；任一晚取不到价 → 整体 null。
 *      - 每晚回带 source（币种 / 原币单价 / 汇率名 / 汇率值 / 汇率生效日）供订单行 metadata.costSource 快照。
 *   2) 区间 CRUD（同房型区间不得重叠，冲突 409；一行里人民币与越南盾只能填一个）。
 *
 * 汇率记法（与 finances.fx.service 一致）：VND 行 rate = 多少越南盾折 1 人民币（3740）→ CNY = VND ÷ rate，两位小数。
 * 汇率行**一次性 load 进 Map**（loadFxRatesByCurrency('VND')）在内存里按晚找，绝不按晚查库。
 *
 * 日期口径：@db.Date 经 Prisma 出来是 **UTC 零点** 的 Date，所有比较都按 UTC 的 YYYY-MM-DD
 * 做 date-only 比较，绝不折本地时区（否则会把一晚折成前一天）。
 *
 * 不联动：房控 HotelBlockPeriod.unitPrice（切房单价）与本模块无关；售价、库存、占房逻辑一概不碰。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  loadFxRatesByCurrency,
  normalizeFxName,
  resolveFxRateInMap,
  toCny,
  type FxRateMap,
} from './finances.fx.service.js';

// ── 纯函数取价口径 ────────────────────────────────────────────────────────────

type DecimalLike = Prisma.Decimal | number | string;

/** 区间输入（DB 行或 DTO 都能喂：日期收 Date（UTC 零点）或 'YYYY-MM-DD'；价收 Decimal/number）。 */
export interface HotelCostPeriodInput {
  effectiveFrom: Date | string;
  effectiveTo: Date | string;
  /** 区间价（人民币）；与 costPriceVnd 二选一 */
  costPriceCny?: DecimalLike | null;
  /** 区间价（越南盾）；与 costPriceCny 二选一 */
  costPriceVnd?: DecimalLike | null;
  /** 越南盾按哪条 VND 汇率行折算；空 = 通用行 */
  costFxName?: string | null;
}

/** 房型缺省价源（HotelRoomType 上的三列）。 */
export interface HotelCostBaseInput {
  costPriceCny?: DecimalLike | null;
  costPriceVnd?: DecimalLike | null;
  costFxName?: string | null;
}

/** 某一晚的价源快照：人民币直取，或越南盾 + 折算用的汇率（fxRate 为 null = 当晚缺汇率）。 */
export type HotelNightCostSource =
  | { currency: 'CNY'; unitAmount: number }
  | {
      currency: 'VND';
      unitAmount: number;
      fxName: string | null;
      fxRate: number | null;
      fxEffectiveFrom: string | null;
    };

export interface HotelNightCost {
  /** 'YYYY-MM-DD'；无入住日期回退时为 null */
  night: string | null;
  /** 折好的人民币；缺价 / 缺汇率 → null */
  cny: number | null;
  /** 价源；房型与区间都没价 → null */
  source: HotelNightCostSource | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 逐晚展开的防御上限：超过视为区间异常，回退「缺省价 × 晚数」而不是跑一个巨大循环。 */
const MAX_STAY_NIGHTS_FOR_PERIODS = 366;

/** Date（UTC 零点）或 'YYYY-MM-DD' → 'YYYY-MM-DD'（date-only，按 UTC 取，不折时区）。 */
export function toYmd(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function toNumber(v: DecimalLike | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface PickedPriceSource {
  currency: 'CNY' | 'VND';
  unitAmount: number;
  fxName: string | null;
}

/** 价源（区间或缺省）→ 原币单价：越南盾优先（越南盾是更晚的显式选择），否则人民币；都没有 → null。 */
function priceSourceOf(src: HotelCostBaseInput | null | undefined): PickedPriceSource | null {
  if (!src) return null;
  const vnd = toNumber(src.costPriceVnd);
  if (vnd != null) return { currency: 'VND', unitAmount: vnd, fxName: normalizeFxName(src.costFxName) };
  const cny = toNumber(src.costPriceCny);
  if (cny != null) return { currency: 'CNY', unitAmount: cny, fxName: null };
  return null;
}

export interface ResolveHotelNightCostInput {
  periods: ReadonlyArray<HotelCostPeriodInput> | null | undefined;
  base: HotelCostBaseInput | null | undefined;
  /** 'YYYY-MM-DD' 或 UTC 零点 Date；null = 无入住日期（只看缺省价，越南盾按 fxDate 折） */
  night: Date | string | null;
  /** VND 汇率行（按名称分组）；价源是越南盾而没给 Map → 视为缺汇率 */
  fxRates?: FxRateMap | null;
  /** 无入住日期时越南盾按哪天的汇率折（缺省 = 今天 UTC 日） */
  fxDate?: Date | string | null;
}

/**
 * 某一晚的价源与人民币：覆盖该晚（effectiveFrom ≤ night ≤ effectiveTo，含两端，date-only）的区间价
 * → 否则房型缺省价 → 都没有 = null。多条区间同时覆盖（理论上被重叠校验挡住）时取第一条命中的。
 * 越南盾价源按当晚生效的 VND 汇率行折算；取不到汇率 → cny null，source 里 fxRate 为 null（缺汇率）。
 */
export function resolveHotelNightCost(input: ResolveHotelNightCostInput): HotelNightCost {
  const ymd = input.night == null ? null : toYmd(input.night);
  let picked: PickedPriceSource | null = null;
  if (ymd != null) {
    for (const p of input.periods ?? []) {
      if (toYmd(p.effectiveFrom) <= ymd && ymd <= toYmd(p.effectiveTo)) {
        picked = priceSourceOf(p);
        if (picked) break;
      }
    }
  }
  if (!picked) picked = priceSourceOf(input.base);
  if (!picked) return { night: ymd, cny: null, source: null };
  if (picked.currency === 'CNY') {
    return { night: ymd, cny: picked.unitAmount, source: { currency: 'CNY', unitAmount: picked.unitAmount } };
  }
  const fxDate = ymd ?? (input.fxDate != null ? toYmd(input.fxDate) : new Date().toISOString().slice(0, 10));
  const fx = input.fxRates ? resolveFxRateInMap(input.fxRates, fxDate, picked.fxName) : null;
  const cny = fx ? toCny(picked.unitAmount, 'VND', fx.rate) : null;
  return {
    night: ymd,
    cny,
    source: {
      currency: 'VND',
      unitAmount: picked.unitAmount,
      fxName: picked.fxName,
      fxRate: fx?.rate ?? null,
      fxEffectiveFrom: fx?.effectiveFrom ?? null,
    },
  };
}

/**
 * 某一晚的净房价（人民币）。老签名保留（区间价 → 缺省 CNY → null）；
 * 越南盾价源经 extra（缺省越南盾 / 汇率 Map）折算，没给 extra 时越南盾按缺汇率处理（null）。
 */
export function resolveHotelNightCostCny(
  periods: ReadonlyArray<HotelCostPeriodInput> | null | undefined,
  baseCostCny: DecimalLike | null | undefined,
  night: Date | string,
  extra?: { baseCostVnd?: DecimalLike | null; baseFxName?: string | null; fxRates?: FxRateMap | null },
): number | null {
  return resolveHotelNightCost({
    periods,
    base: { costPriceCny: baseCostCny, costPriceVnd: extra?.baseCostVnd, costFxName: extra?.baseFxName },
    night,
    fxRates: extra?.fxRates,
  }).cny;
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
  /** 房型缺省净房价（人民币） */
  baseCostCny: DecimalLike | null | undefined;
  /** 房型缺省净房价（越南盾；与 baseCostCny 二选一，两者都在以越南盾为准） */
  baseCostVnd?: DecimalLike | null;
  /** 缺省越南盾按哪条 VND 汇率行折算；空 = 通用行 */
  baseFxName?: string | null;
  /** VND 汇率行（loadFxRatesByCurrency('VND')）；有越南盾价源而没给 → 该晚缺汇率 null */
  fxRates?: FxRateMap | null;
  checkIn?: Date | string | null;
  checkOut?: Date | string | null;
  /** 计费房数（支持 0.5 间）；缺省 1。 */
  rooms?: number;
  /** 无入住日期时的晚数（回退 缺省价 × nights）；缺省 1。 */
  nights?: number;
  /** 无入住日期时越南盾按哪天的汇率折（缺省今天） */
  fxDate?: Date | string | null;
}

export interface HotelStayCostDetail {
  /** 逐晚合计 × 房数（两位小数）；任一晚缺价 / 缺汇率 → null */
  totalCny: number | null;
  /** 逐晚明细（无日期回退时 night 为 null，条数 = nights） */
  nights: HotelNightCost[];
  /** 有越南盾价源但取不到汇率的晚数 > 0 */
  missingFx: boolean;
}

/**
 * 一段住宿的净房价合计 + 逐晚价源：逐晚（区间价优先，否则缺省价；越南盾按当晚汇率折）累加 × rooms。
 *   - 任一晚取不到价（含缺汇率）→ totalCny null（真缺数据如实报 null，不落 0）。
 *   - 无入住/退房日期（或区间非法）→ 回退：缺省价 × nights × rooms（越南盾按 fxDate / 今天的汇率折）。
 * 返回值保留两位小数（不做整数四舍五入，四舍五入交给各快照点按既有口径处理）。
 */
export function hotelStayCostDetail(input: HotelStayCostInput): HotelStayCostDetail {
  const rooms = input.rooms ?? 1;
  const base: HotelCostBaseInput = {
    costPriceCny: input.baseCostCny,
    costPriceVnd: input.baseCostVnd,
    costFxName: input.baseFxName,
  };
  const stayNights =
    input.checkIn != null && input.checkOut != null ? expandStayNights(input.checkIn, input.checkOut) : null;
  const nights: HotelNightCost[] =
    stayNights == null
      ? Array.from({ length: Math.max(1, Math.round(input.nights ?? 1)) }, () =>
          resolveHotelNightCost({ periods: null, base, night: null, fxRates: input.fxRates, fxDate: input.fxDate }),
        )
      : stayNights.map((night) =>
          resolveHotelNightCost({ periods: input.periods, base, night, fxRates: input.fxRates }),
        );
  const missingFx = nights.some((n) => n.source?.currency === 'VND' && n.source.fxRate == null);
  if (nights.some((n) => n.cny == null)) return { totalCny: null, nights, missingFx };
  // 无日期回退：晚数可能非整数（历史 nights 传法），按 缺省价 × nights × rooms 原口径算
  if (stayNights == null) {
    const perNight = nights[0]!.cny!;
    return { totalCny: round2(perNight * (input.nights ?? 1) * rooms), nights, missingFx };
  }
  const sum = nights.reduce((acc, n) => acc + (n.cny ?? 0), 0);
  return { totalCny: round2(sum * rooms), nights, missingFx };
}

/** 一段住宿的净房价合计（人民币）；口径见 hotelStayCostDetail。 */
export function hotelStayCostCny(input: HotelStayCostInput): number | null {
  return hotelStayCostDetail(input).totalCny;
}

export interface HotelStayUnitCost {
  /** 平均每间每晚（两位小数）；缺数据 → null */
  unitCostCny: number | null;
  detail: HotelStayCostDetail;
}

/**
 * 一段住宿的「平均每间每晚」净房价 —— 供沿用 `unitCostCny（每间每晚）× 晚数 × 房数` 公式的
 * 快照点使用：有日期时 = 逐晚合计 ÷ 晚数（两位小数）；无日期 → 缺省价（越南盾按今天汇率折）；缺数据 → null。
 * 平均值 × 晚数 = 逐晚合计（两位小数内），所以 totalCostCny 仍与 amount 同口径缩放。
 */
export function resolveHotelStayUnitCost(input: Omit<HotelStayCostInput, 'rooms' | 'nights'>): HotelStayUnitCost {
  const detail = hotelStayCostDetail({ ...input, rooms: 1, nights: 1 });
  if (detail.totalCny == null) return { unitCostCny: null, detail };
  return { unitCostCny: round2(detail.totalCny / detail.nights.length), detail };
}

export function resolveHotelStayUnitCostCny(input: Omit<HotelStayCostInput, 'rooms' | 'nights'>): number | null {
  return resolveHotelStayUnitCost(input).unitCostCny;
}

// ── 成本快照 metadata（订单行 metadata.costSource）────────────────────────────

export interface HotelCostSourceNightSnapshot {
  night: string | null;
  currency: 'CNY' | 'VND';
  unitAmount: number | null;
  fxName?: string | null;
  fxRate?: number | null;
  fxEffectiveFrom?: string | null;
  cny: number | null;
}

/**
 * 订单行 metadata.costSource 的形状：
 *   - 逐晚同币种同单价同汇率 → 紧凑形：{ currency, unitAmountPerNight, fxName, fxRate, fxEffectiveFrom, nights }
 *   - 否则 → { currency: 'MIXED' 或统一币种, nights, nightly: [...] }
 *   - missingFx = 有越南盾价源但取不到汇率（unitCostCny 为 null 的原因）
 * unitCostCny / totalCostCny 语义不变（仍是折好的人民币），这里只记「怎么折出来的」。
 */
export interface HotelCostSourceSnapshot {
  currency: 'CNY' | 'VND' | 'MIXED';
  nights: number;
  unitAmountPerNight?: number;
  fxName?: string | null;
  fxRate?: number | null;
  fxEffectiveFrom?: string | null;
  nightly?: HotelCostSourceNightSnapshot[];
  missingFx?: true;
}

/** 由逐晚明细生成快照；房型与区间都没价（没有任何价源）→ null（不写 metadata）。 */
export function buildHotelCostSourceSnapshot(detail: HotelStayCostDetail): HotelCostSourceSnapshot | null {
  const withSource = detail.nights.filter((n) => n.source != null);
  if (withSource.length === 0) return null;
  const nightly: HotelCostSourceNightSnapshot[] = detail.nights.map((n) => {
    const s = n.source;
    if (!s) return { night: n.night, currency: 'CNY', unitAmount: null, cny: null };
    return s.currency === 'CNY'
      ? { night: n.night, currency: 'CNY', unitAmount: s.unitAmount, cny: n.cny }
      : {
          night: n.night,
          currency: 'VND',
          unitAmount: s.unitAmount,
          fxName: s.fxName,
          fxRate: s.fxRate,
          fxEffectiveFrom: s.fxEffectiveFrom,
          cny: n.cny,
        };
  });
  const first = nightly[0]!;
  const uniform =
    withSource.length === detail.nights.length &&
    nightly.every(
      (n) =>
        n.currency === first.currency &&
        n.unitAmount === first.unitAmount &&
        (n.fxName ?? null) === (first.fxName ?? null) &&
        (n.fxRate ?? null) === (first.fxRate ?? null) &&
        (n.fxEffectiveFrom ?? null) === (first.fxEffectiveFrom ?? null),
    );
  const currencies = new Set(nightly.map((n) => n.currency));
  const currency: HotelCostSourceSnapshot['currency'] = currencies.size === 1 ? first.currency : 'MIXED';
  const snap: HotelCostSourceSnapshot = { currency, nights: detail.nights.length };
  if (uniform && first.unitAmount != null) {
    snap.unitAmountPerNight = first.unitAmount;
    if (first.currency === 'VND') {
      snap.fxName = first.fxName ?? null;
      snap.fxRate = first.fxRate ?? null;
      snap.fxEffectiveFrom = first.fxEffectiveFrom ?? null;
    }
  } else {
    snap.nightly = nightly;
  }
  if (detail.missingFx) snap.missingFx = true;
  return snap;
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
  costPriceCny: Prisma.Decimal | null;
  costPriceVnd: Prisma.Decimal | null;
  costFxName: string | null;
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
    select: {
      roomTypeId: true,
      effectiveFrom: true,
      effectiveTo: true,
      costPriceCny: true,
      costPriceVnd: true,
      costFxName: true,
    },
  });
  for (const r of rows) {
    const arr = map.get(r.roomTypeId) ?? [];
    arr.push(r);
    map.set(r.roomTypeId, arr);
  }
  return map;
}

/** 这批价源里有没有越南盾（有才需要拉 VND 汇率行）。 */
export function hotelCostNeedsFx(
  periodsMap: ReadonlyMap<string, ReadonlyArray<HotelCostPeriodInput> | null | undefined>,
  bases: ReadonlyArray<HotelCostBaseInput | null | undefined>,
): boolean {
  for (const periods of periodsMap.values()) {
    if ((periods ?? []).some((p) => toNumber(p.costPriceVnd) != null)) return true;
  }
  return bases.some((b) => b != null && toNumber(b.costPriceVnd) != null);
}

/**
 * 报表回退用：只在有越南盾价源时一次拉全部 VND 汇率行（按名称分组）；没有越南盾 → undefined（不查库）。
 */
export async function loadHotelCostFxRatesIfNeeded(
  input: {
    periodsMap: ReadonlyMap<string, ReadonlyArray<HotelCostPeriodInput> | null | undefined>;
    bases: ReadonlyArray<HotelCostBaseInput | null | undefined>;
  },
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<FxRateMap | undefined> {
  if (!hotelCostNeedsFx(input.periodsMap, input.bases)) return undefined;
  return loadFxRatesByCurrency('VND', client);
}

// ── 区间 CRUD（ADMIN/STAFF）──────────────────────────────────────────────────

type HotelCostPeriodClient = PrismaClient | Prisma.TransactionClient;

export interface HotelRoomTypeCostPeriodDto {
  id: string;
  roomTypeId: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  /** 区间价（人民币）；越南盾行为 null */
  costPriceCny: number | null;
  /** 区间价（越南盾）；人民币行为 null */
  costPriceVnd: number | null;
  /** 越南盾按哪条 VND 汇率行折算；null = 通用行 */
  costFxName: string | null;
  note: string | null;
  updatedAt: string;
}

export interface HotelRoomTypeCostPeriodWriteInput {
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string; // YYYY-MM-DD
  costPriceCny?: number | null;
  costPriceVnd?: number | null;
  costFxName?: string | null;
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
  costPriceCny: Prisma.Decimal | null;
  costPriceVnd: Prisma.Decimal | null;
  costFxName: string | null;
  note: string | null;
  updatedAt: Date;
}): HotelRoomTypeCostPeriodDto {
  return {
    id: row.id,
    roomTypeId: row.roomTypeId,
    effectiveFrom: toYmd(row.effectiveFrom),
    effectiveTo: toYmd(row.effectiveTo),
    costPriceCny: row.costPriceCny == null ? null : round2(Number(row.costPriceCny.toString())),
    costPriceVnd: row.costPriceVnd == null ? null : round2(Number(row.costPriceVnd.toString())),
    costFxName: row.costFxName,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 「人民币 / 越南盾二选一」校验（写入后的最终态）：两个都空或都有数 → 400。
 * 越南盾行才带 costFxName；人民币行一律清空 costFxName。
 */
export function resolveHotelCostPriceColumns(input: {
  costPriceCny: number | null;
  costPriceVnd: number | null;
  costFxName: string | null;
}): { costPriceCny: Prisma.Decimal | null; costPriceVnd: Prisma.Decimal | null; costFxName: string | null } {
  const hasCny = input.costPriceCny != null;
  const hasVnd = input.costPriceVnd != null;
  if (hasCny === hasVnd) {
    throw new BadRequestError('净房价填人民币或越南盾其中一个');
  }
  return {
    costPriceCny: hasCny ? new Prisma.Decimal(input.costPriceCny!) : null,
    costPriceVnd: hasVnd ? new Prisma.Decimal(input.costPriceVnd!) : null,
    costFxName: hasVnd ? normalizeFxName(input.costFxName) : null,
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
  const price = resolveHotelCostPriceColumns({
    costPriceCny: input.costPriceCny ?? null,
    costPriceVnd: input.costPriceVnd ?? null,
    costFxName: input.costFxName ?? null,
  });
  return client.$transaction(async (tx) => {
    await lockRoomTypeForCostPeriods(tx, roomTypeId);
    await assertNoHotelCostPeriodOverlap(roomTypeId, from, to, null, tx);
    const row = await tx.hotelRoomTypeCostPeriod.create({
      data: {
        roomTypeId,
        effectiveFrom: from,
        effectiveTo: to,
        ...price,
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
    const touchesPrice =
      input.costPriceCny !== undefined || input.costPriceVnd !== undefined || input.costFxName !== undefined;
    if (touchesPrice) {
      // 改价：给了越南盾就切成越南盾行（人民币清空），给了人民币就切成人民币行（越南盾清空）；
      // 只改 costFxName 不改金额 → 沿用现有金额列。最终态仍须「二选一」。
      const existingVnd = existing.costPriceVnd == null ? null : Number(existing.costPriceVnd.toString());
      const existingCny = existing.costPriceCny == null ? null : Number(existing.costPriceCny.toString());
      const nextVnd =
        input.costPriceVnd !== undefined ? input.costPriceVnd : input.costPriceCny != null ? null : existingVnd;
      const nextCny =
        input.costPriceCny !== undefined ? input.costPriceCny : input.costPriceVnd != null ? null : existingCny;
      const price = resolveHotelCostPriceColumns({
        costPriceCny: nextCny,
        costPriceVnd: nextVnd,
        costFxName: input.costFxName !== undefined ? input.costFxName : existing.costFxName,
      });
      data.costPriceCny = price.costPriceCny;
      data.costPriceVnd = price.costPriceVnd;
      data.costFxName = price.costFxName;
    }
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
