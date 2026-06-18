/**
 * 定价引擎 — 所见即所得（仓位价/底价即成交价）。
 *
 * LADDER（配了仓位阶梯）：按显式档位卖，仓位价即成交价；售罄一档自动开下一档。
 * AUTO（无仓位阶梯）：固定底价 —— 每张票都是 round(basePrice)，不叠任何倍率。
 *
 * 历史说明：旧版 AUTO 曾用两层自动倍率「日期等级（DateRanking A/B/C/D）× 余位 bucket
 * （0.7→1.55 线性）」做动态定价。应业主要求退役该老页 —— 定价统一到仓位阶梯，无阶梯则固定底价。
 * dateRank 仍解析出来供运营内部参考，但不再参与定价（dateMultiplier 恒 1）。
 * DateRanking 表保留休眠（不迁移/不删），只是不再应用其倍率。
 */
import { CabinClass } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { computeLadderBreakdown } from './pricing.calc.js';
import { parseFareBuckets } from './pricing.schemas.js';

// ── 返回类型 ──────────────────────────────────────────────────────
export interface SeatBreakdown {
  seatIndex: number; // 1-based: 这是该班次的第几张票（sold+1, sold+2, ...）
  bucket: number; // 0-based bucket index（AUTO 恒 0；LADDER 为所属档位）
  bucketMultiplier: number; // 保留字段：AUTO/LADDER 均恒为 1（无倍率概念）
  unitPrice: number; // = round(basePrice)（AUTO 固定底价）或该档仓位价（LADDER）
}

export interface PriceResult {
  scheduleId: string;
  cabin: CabinClass;
  qty: number;
  // 定价模式：LADDER=按显式仓位阶梯卖（仓位价即成交价）；AUTO=固定底价 round(basePrice)
  pricingMode: 'LADDER' | 'AUTO';
  basePrice: number;
  dateRank: string;
  dateMultiplier: number; // 两种模式均恒为 1（不再叠日期倍率，仅保留字段同形）
  bucketSize: number; // 保留字段：AUTO 固定底价填 0；LADDER 无意义填 0
  totalBuckets: number; // AUTO=1（固定底价不分档）；LADDER=阶梯档位数
  currentBucket: number; // 下一张票所在的档（基于当前 sold；AUTO 恒 0）
  currentBucketRemaining: number; // 当前档剩余多少张（LADDER 驱动"还剩 X 张就涨价"；AUTO=capacity−sold）
  perSeatBreakdown: SeatBreakdown[];
  totalPrice: number;
  averageUnitPrice: number; // = round(totalPrice / qty)
}

export class PricingService {
  /**
   * 计算指定班次、舱位、数量的动态价格。
   *
   * 不修改 sold — 只读查询。
   */
  async calculatePrice(
    scheduleId: string,
    cabin: CabinClass,
    qty: number,
  ): Promise<PriceResult> {
    // 1. 查 FlightSeatClass
    const seatClass = await prisma.flightSeatClass.findFirst({
      where: { scheduleId, cabin },
      include: { schedule: true },
    });
    if (!seatClass) {
      throw new NotFoundError(`班次 ${scheduleId} 的 ${cabin} 舱位不存在`);
    }

    const { capacity, sold, basePrice: basePriceDec } = seatClass;
    const basePrice = Number(basePriceDec);

    // 余票检查（两种模式都保持这条不变 —— 容量是硬上限，与定价模式无关）
    const available = capacity - sold;
    if (qty > available) {
      throw new BadRequestError(
        `${cabin} 余票仅 ${available} 张，不够 ${qty} 张。` +
          (available > 0 ? `最多可购 ${available} 张。` : '已售罄。'),
      );
    }

    // ── 仓位阶梯模式（显式动态加价）─────────────────────────────────────────
    // 配了非空阶梯就走这条：仓位价即成交价，忽略日期等级 / 余位倍率。
    const fareBuckets = parseFareBuckets((seatClass as { fareBuckets?: unknown }).fareBuckets);
    if (fareBuckets) {
      const ladder = computeLadderBreakdown({ fareBuckets, sold, qty });
      // dateRank 仍计算出来（运营内部参考），但不参与定价；dateMultiplier 恒 1。
      const dateRank = await this.resolveDateRank(
        seatClass.schedule.departureTz,
        seatClass.schedule.departureTime,
      );
      return {
        scheduleId,
        cabin,
        qty,
        pricingMode: 'LADDER',
        basePrice,
        dateRank,
        dateMultiplier: 1,
        bucketSize: 0, // 阶梯模式无固定 bucket 大小
        totalBuckets: ladder.totalBuckets,
        currentBucket: ladder.currentBucket,
        currentBucketRemaining: ladder.currentBucketRemaining,
        perSeatBreakdown: ladder.breakdown,
        totalPrice: ladder.totalPrice,
        averageUnitPrice: ladder.averageUnitPrice,
      };
    }

    // ── 固定底价模式（无仓位阶梯）─────────────────────────────────────────
    // 所见即所得：每张票都是 round(basePrice)，不叠日期倍率、不叠余位倍率。
    // dateRank 仍解析出来供运营内部参考，但 dateMultiplier 恒 1（不参与定价）。
    const dateRank = await this.resolveDateRank(
      seatClass.schedule.departureTz,
      seatClass.schedule.departureTime,
    );

    const unitPrice = Math.round(basePrice);
    const perSeatBreakdown: SeatBreakdown[] = [];
    let totalPrice = 0;
    for (let i = 0; i < qty; i++) {
      const seatIndex = sold + 1 + i; // 1-based
      perSeatBreakdown.push({ seatIndex, bucket: 0, bucketMultiplier: 1, unitPrice });
      totalPrice += unitPrice;
    }

    const averageUnitPrice = Math.round(totalPrice / qty);

    return {
      scheduleId,
      cabin,
      qty,
      pricingMode: 'AUTO',
      basePrice,
      dateRank,
      dateMultiplier: 1,
      bucketSize: 0, // 固定底价无 bucket 概念
      totalBuckets: 1, // 整段一个 bucket（不分档）
      currentBucket: 0,
      currentBucketRemaining: capacity - sold, // 整段剩余 = capacity − sold
      perSeatBreakdown,
      totalPrice,
      averageUnitPrice,
    };
  }

  /**
   * 日期等级解析（AUTO 与 LADDER 共用）。
   * 从出发地本地日期查 DateRanking 表；查不到按星期几兜底（DOW fallback）。
   * 注意：LADDER 模式只把它当作运营内部参考，不参与定价。
   */
  private async resolveDateRank(departureTz: string, departureTime: Date): Promise<string> {
    // 从 schedule.departureTime 提取出发地本地日期（Asia/Ho_Chi_Minh=+7, Asia/Macau=+8）
    const offsetHours =
      departureTz === 'Asia/Macau' ? 8 : departureTz === 'Asia/Ho_Chi_Minh' ? 7 : 8;
    const localMs = departureTime.getTime() + offsetHours * 3600000;
    const localDate = new Date(localMs);
    // 取 UTC midnight 作为 date 查找 key
    const dateLookup = new Date(
      Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()),
    );

    const ranking = await prisma.dateRanking.findUnique({ where: { date: dateLookup } });
    // Fallback: 按 DOW 算
    const dowFallback: Record<number, string> = {
      0: 'A', 1: 'C', 2: 'D', 3: 'D', 4: 'C', 5: 'B', 6: 'B',
    };
    return ranking?.rank ?? dowFallback[localDate.getUTCDay()] ?? 'C';
  }
}
