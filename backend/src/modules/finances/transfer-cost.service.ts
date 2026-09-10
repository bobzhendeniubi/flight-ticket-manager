/**
 * 车队（Transfer）结算价 · 越南盾折算（财务成本侧）
 *
 * 背景：车队按越南盾结算，财务希望录越南盾、由系统按合同汇率折人民币 —— 照酒店净房价那套做。
 * 本模块提供：
 *   1) 纯函数取价口径（不依赖 DB，供录单成本快照 / 报表回退 / 单测共用）：
 *      - 价源：costPriceVnd 有值 → 越南盾（越南盾是更晚的显式选择，两者都在以越南盾为准）；否则 costPriceCny；都没有 → null。
 *      - 越南盾按「服务日」生效的 VND 汇率行（costFxName 指定，空 = 通用行）折人民币（toCny，两位小数）；
 *        取不到汇率 → null（如实缺数据，不落 0 虚高），source 里 fxRate 为 null 并标 missingFx。
 *      - 服务日分层回退：OrderItem 目前**没有**接送日期字段 → 订单去程出发日（航段本地日）→ 下单日（北京业务日）
 *        → 都没有用今天（录单快照点订单尚未落库，「下单日」就是今天）。用了哪一层写进 source.fxDateBasis。
 *   2) 批量取数：只在这批车队里有越南盾价源时才拉 VND 汇率行（一次 load 进 Map 按日查，绝不 N+1）。
 *
 * 汇率记法（与 finances.fx.service 一致）：VND 行 rate = 多少越南盾折 1 人民币（3740）→ CNY = VND ÷ rate。
 * 不联动：售价、库存一概不碰；只改成本侧。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { businessDateISO } from '../../lib/business-time.js';
import { localDate } from './finances.cost.service.js';
import {
  loadFxRatesByCurrency,
  normalizeFxName,
  resolveFxRateInMap,
  toCny,
  type FxRateMap,
} from './finances.fx.service.js';

type DecimalLike = Prisma.Decimal | number | string;

/** 车队产品上的三列（DB 行或 DTO 都能喂）。 */
export interface TransferCostBaseInput {
  costPriceCny?: DecimalLike | null;
  costPriceVnd?: DecimalLike | null;
  costFxName?: string | null;
}

/**
 * 越南盾按哪一天的汇率折：
 *   ORDER_ITEM       行上的接送日期（目前 OrderItem 没有该字段，预留）
 *   FLIGHT_DEPARTURE 订单去程出发日（最早航段的当地日）
 *   ORDER_CREATED    下单日（北京业务日）
 *   TODAY            以上都没有（录单快照点订单尚未落库）
 */
export type TransferCostDateBasis = 'ORDER_ITEM' | 'FLIGHT_DEPARTURE' | 'ORDER_CREATED' | 'TODAY';

export interface TransferServiceDate {
  /** 'YYYY-MM-DD' */
  ymd: string;
  basis: TransferCostDateBasis;
}

/** 订单行 metadata.costSource 的形状（车队行）：记「怎么折出来的」，unitCostCny / totalCostCny 仍是折好的人民币。 */
export type TransferCostSource =
  | { currency: 'CNY'; unitAmount: number }
  | {
      currency: 'VND';
      unitAmount: number;
      fxName: string | null;
      fxRate: number | null;
      fxEffectiveFrom: string | null;
      /** 实际按哪天取的汇率 */
      fxDate: string;
      fxDateBasis: TransferCostDateBasis;
      /** 有越南盾价源但取不到汇率（cny 为 null 的原因） */
      missingFx?: true;
    };

export interface TransferUnitCost {
  /** 折好的人民币（两位小数）；缺价 / 缺汇率 → null */
  cny: number | null;
  /** 价源；人民币与越南盾都没填 → null（不写 metadata） */
  source: TransferCostSource | null;
}

function toNumber(v: DecimalLike | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : null;
}

/** Date 或 'YYYY-MM-DD…' → 'YYYY-MM-DD'（Date 按 UTC 取，@db.Date 出来是 UTC 零点，不折时区）。 */
function toYmd(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * 服务日分层回退（纯函数）：行上接送日期 → 去程出发日 → 下单日（北京业务日）→ 今天（北京业务日）。
 * 每层给的是 'YYYY-MM-DD'（已按各自时区折好的当地日）或 Date（下单时刻 / 现在，按北京业务日折）。
 */
export function resolveTransferServiceDate(input: {
  itemDate?: Date | string | null;
  outboundDepartureDate?: string | null;
  orderCreatedAt?: Date | null;
  now?: Date;
}): TransferServiceDate {
  if (input.itemDate != null) return { ymd: toYmd(input.itemDate), basis: 'ORDER_ITEM' };
  if (input.outboundDepartureDate) return { ymd: input.outboundDepartureDate.slice(0, 10), basis: 'FLIGHT_DEPARTURE' };
  if (input.orderCreatedAt != null) return { ymd: businessDateISO(input.orderCreatedAt), basis: 'ORDER_CREATED' };
  return { ymd: businessDateISO(input.now ?? new Date()), basis: 'TODAY' };
}

/**
 * 订单去程出发日：所有航段里最早出发那段的当地日（按班次自己的 departureTz 折）；没有航段 → null。
 * 报表侧与录单侧共用，避免两边各写一套「哪段算去程」。
 */
export function earliestDepartureLocalDate(
  schedules: ReadonlyArray<{ departureTime: Date; departureTz: string | null | undefined } | null | undefined>,
): string | null {
  let earliest: { departureTime: Date; departureTz: string | null | undefined } | null = null;
  for (const s of schedules) {
    if (!s) continue;
    if (!earliest || s.departureTime.getTime() < earliest.departureTime.getTime()) earliest = s;
  }
  if (!earliest) return null;
  return localDate(earliest.departureTime, earliest.departureTz ?? 'UTC');
}

export interface ResolveTransferUnitCostInput extends TransferCostBaseInput {
  /**
   * 服务日（越南盾按这天生效的汇率折）：给 TransferServiceDate 会把用的是哪一层记进 source；
   * 给裸 Date / 'YYYY-MM-DD' 视为行上的接送日期；不给 → 今天（北京业务日）。人民币价源用不到。
   */
  date?: TransferServiceDate | Date | string | null;
  /** VND 汇率行（loadFxRatesByCurrency('VND')）；价源是越南盾而没给 Map → 视为缺汇率 */
  fxRates?: FxRateMap | null;
}

function toServiceDate(date: ResolveTransferUnitCostInput['date']): TransferServiceDate {
  if (date == null) return resolveTransferServiceDate({});
  if (typeof date === 'object' && !(date instanceof Date)) return date;
  return { ymd: toYmd(date), basis: 'ORDER_ITEM' };
}

/**
 * 一份车队服务的单位结算价（人民币）+ 价源：
 *   costPriceVnd 有值 → 按 date 生效的 VND 汇率行（name → 同币种通用行）折 CNY，缺汇率 → null；
 *   否则 costPriceCny；都没有 → { cny: null, source: null }。
 */
export function resolveTransferUnitCost(input: ResolveTransferUnitCostInput): TransferUnitCost {
  const vnd = toNumber(input.costPriceVnd);
  if (vnd != null) {
    const serviceDate = toServiceDate(input.date);
    const fxName = normalizeFxName(input.costFxName);
    const fx = input.fxRates ? resolveFxRateInMap(input.fxRates, serviceDate.ymd, fxName) : null;
    const cny = fx ? toCny(vnd, 'VND', fx.rate) : null;
    const source: TransferCostSource = {
      currency: 'VND',
      unitAmount: vnd,
      fxName,
      fxRate: fx?.rate ?? null,
      fxEffectiveFrom: fx?.effectiveFrom ?? null,
      fxDate: serviceDate.ymd,
      fxDateBasis: serviceDate.basis,
    };
    if (cny == null) source.missingFx = true;
    return { cny, source };
  }
  const cny = toNumber(input.costPriceCny);
  if (cny == null) return { cny: null, source: null };
  return { cny, source: { currency: 'CNY', unitAmount: cny } };
}

/** 这批车队价源里有没有越南盾（有才需要拉 VND 汇率行）。 */
export function transferCostNeedsFx(bases: ReadonlyArray<TransferCostBaseInput | null | undefined>): boolean {
  return bases.some((b) => b != null && toNumber(b.costPriceVnd) != null);
}

/**
 * 只在有越南盾价源时一次拉全部 VND 汇率行（按名称分组）；没有越南盾 → undefined（不查库）。
 * 报表回退与录单快照共用，绝不按行查库。
 */
export async function loadTransferCostFxRatesIfNeeded(
  bases: ReadonlyArray<TransferCostBaseInput | null | undefined>,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<FxRateMap | undefined> {
  if (!transferCostNeedsFx(bases)) return undefined;
  return loadFxRatesByCurrency('VND', client);
}
