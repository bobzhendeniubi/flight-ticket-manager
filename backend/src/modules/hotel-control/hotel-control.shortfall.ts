/**
 * 随机档每日加房清单。
 *
 * 这里唯一负责把 getRandomTierAggregate 的逐日数组映射成「已确认包房 / 已落位 /
 * 未落位 / 缺口 / 需向地接加房」；房控接口和提醒规则都复用这份计算，避免各写一套公式。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  getRandomTierAggregate,
  randomStarTierLabel,
  RANDOM_STAR_TIERS,
  type RandomStarTier,
  type RandomTierAggregate,
} from './hotel-control.service.js';

type ShortfallDbClient = PrismaClient | Prisma.TransactionClient;

export interface RandomTierShortfallTier {
  tier: RandomStarTier;
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
  tiers: RandomTierShortfallTier[];
}

export interface RandomTierShortfallReport {
  from: string;
  to: string;
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
 * 按日期 × 随机档输出每日加房清单。
 * 每个档次只调用一次 getRandomTierAggregate，三档共三次，和销控矩阵使用同一聚合口径。
 */
export async function getRandomTierShortfall(
  from: string,
  to: string,
  client: ShortfallDbClient = defaultPrisma,
): Promise<RandomTierShortfallReport> {
  const dates = dateRange(from, to);
  const aggregates = await Promise.all(
    RANDOM_STAR_TIERS.map((tier) => getRandomTierAggregate(tier, dates, {}, client)),
  );
  const aggregateByTier = new Map<RandomStarTier, RandomTierAggregate>();
  RANDOM_STAR_TIERS.forEach((tier, index) => aggregateByTier.set(tier, aggregates[index]));

  const days = dates.map((date, dateIndex) => ({
    date,
    tiers: RANDOM_STAR_TIERS.flatMap((tier) => {
      const aggregate = aggregateByTier.get(tier)!;
      const pendingUsed = round2(at(aggregate.pendingUsed, dateIndex));
      const block = round2(at(aggregate.block, dateIndex));
      const hasBlock = block > 0;
      // 五星随机没有任何真酒店包房、也没有未落位占用时，对房控没有可执行信息，省略。
      if (tier === 5 && !hasBlock && pendingUsed === 0) return [];

      const hotelUsed = round2(at(aggregate.hotelUsed, dateIndex));
      const remaining = round2(block - hotelUsed - pendingUsed);
      const shortfall = remaining < 0 ? round2(-remaining) : 0;
      return [
        {
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

  return { from, to, days };
}
