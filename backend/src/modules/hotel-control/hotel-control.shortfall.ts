/**
 * 随机档每日加房清单。
 *
 * 这里唯一负责把 getRandomTierAggregate 的逐日数组映射成「已确认包房 / 已落位 /
 * 未落位 / 缺口 / 需向地接加房」；房控接口和提醒规则都复用这份计算，避免各写一套公式。
 *
 * 按 **城市 × 档次** 出行：岘港三星的缺口只看岘港三星的真酒店，绝不吃会安的房。
 * 城市集合来自 listRandomTierCities（所有酒店的 distinct cityCode ∪ 存量默认城市）。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  cityLabel,
  getRandomTierAggregate,
  listRandomTierCities,
  normalizeCityCode,
  randomStarTierLabel,
  RANDOM_STAR_TIERS,
  type RandomStarTier,
  type RandomTierAggregate,
} from './hotel-control.service.js';

type ShortfallDbClient = PrismaClient | Prisma.TransactionClient;

export interface RandomTierShortfallTier {
  /** 该行圈定的城市（归一后的 Hotel.cityCode）。*/
  cityCode: string;
  /** 城市展示名（未知码原样）。*/
  cityLabel: string;
  tier: RandomStarTier;
  /** 档次名（不带城市，与销控板列头一致）；带城市的句子请自行拼 `${cityLabel}${label}`。*/
  label: string;
  hasBlock: boolean;
  block: number;
  hotelUsed: number;
  pendingUsed: number;
  remaining: number;
  shortfall: number;
  roomsToRequest: number;
}

export interface RandomTierShortfallDay {
  date: string;
  /** 同一天可能有多个城市的行；按 (城市, 档次) 排序。*/
  tiers: RandomTierShortfallTier[];
}

export interface RandomTierShortfallReport {
  from: string;
  to: string;
  /** 本次清单覆盖的城市（主营地排最前）；带 cityCode 筛选时只有一个。*/
  cities: Array<{ cityCode: string; cityLabel: string }>;
  days: RandomTierShortfallDay[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function at(values: number[], index: number): number {
  return values[index] ?? 0;
}

/**
 * 某城市某档次某天要不要出现在清单里：
 *   · 有包房 / 有未落位占用 → 一定列（这就是清单要回答的问题）；
 *   · 三星/四星：该城市有这一档的真酒店也列（显示「未切房」提醒房控去切）；
 *   · 五星随机极少卖：没有任何真酒店包房、也没有未落位占用时省略，对房控没有可执行信息。
 */
function shouldListTier(
  tier: RandomStarTier,
  aggregate: RandomTierAggregate,
  hasBlock: boolean,
  pendingUsed: number,
): boolean {
  if (hasBlock || pendingUsed > 0) return true;
  if (tier === 5) return false;
  return (aggregate.hotelCount ?? 0) > 0;
}

/**
 * 按日期 × 城市 × 随机档输出每日加房清单。
 * 每个 (城市, 档次) 只调用一次 getRandomTierAggregate，和销控矩阵使用同一聚合口径。
 * opts.cityCode：只出这一个城市（缺省全部）。
 */
export async function getRandomTierShortfall(
  from: string,
  to: string,
  client: ShortfallDbClient = defaultPrisma,
  opts: { cityCode?: string } = {},
): Promise<RandomTierShortfallReport> {
  const dates = dateRange(from, to);
  const cityCodes = opts.cityCode
    ? [normalizeCityCode(opts.cityCode)]
    : await listRandomTierCities(client);

  const scopes = cityCodes.flatMap((cityCode) =>
    RANDOM_STAR_TIERS.map((tier) => ({ cityCode, tier })),
  );
  const aggregates = await Promise.all(
    scopes.map((scope) => getRandomTierAggregate(scope, dates, {}, client)),
  );

  const days = dates.map((date, dateIndex) => ({
    date,
    tiers: scopes.flatMap(({ cityCode, tier }, scopeIndex) => {
      const aggregate = aggregates[scopeIndex];
      const pendingUsed = round2(at(aggregate.pendingUsed, dateIndex));
      const block = round2(at(aggregate.block, dateIndex));
      const hasBlock = block > 0;
      if (!shouldListTier(tier, aggregate, hasBlock, pendingUsed)) return [];

      const hotelUsed = round2(at(aggregate.hotelUsed, dateIndex));
      const remaining = round2(block - hotelUsed - pendingUsed);
      const shortfall = remaining < 0 ? round2(-remaining) : 0;
      return [
        {
          cityCode,
          cityLabel: cityLabel(cityCode),
          tier,
          label: randomStarTierLabel(tier),
          hasBlock,
          block,
          hotelUsed,
          pendingUsed,
          remaining,
          shortfall,
          roomsToRequest: Math.ceil(shortfall),
        },
      ];
    }),
  }));

  return {
    from,
    to,
    cities: cityCodes.map((cityCode) => ({ cityCode, cityLabel: cityLabel(cityCode) })),
    days,
  };
}
