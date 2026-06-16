import { z } from 'zod';
import { CabinClass } from '@prisma/client';
import type { FareBucket } from './pricing.calc.js';

export const priceQuerySchema = z.object({
  scheduleId: z.string().min(1),
  cabin: z.nativeEnum(CabinClass),
  qty: z.coerce.number().int().min(1).max(9).default(1),
});
export type PriceQuery = z.infer<typeof priceQuerySchema>;

// ── 仓位阶梯（每班次×舱位的显式动态加价配置）────────────────────────────────
// 有序数组，index 0 最先卖（最便宜）；每档 { quota: 多少张, price: 单座成交价 }。
// 写入路径用：null / [] = 清空阶梯（回退旧版自动定价）。
const MAX_FARE_BUCKETS = 20;

export const fareBucketSchema = z.object({
  quota: z.number().int().min(1).max(10_000),
  price: z.number().min(0).max(1_000_000),
});

/** 单条阶梯配置：1..20 档，或 null / [] 表示清空。 */
export const fareBucketsSchema = z
  .array(fareBucketSchema)
  .max(MAX_FARE_BUCKETS)
  .nullable();
export type FareBucketsInput = z.infer<typeof fareBucketsSchema>;

/**
 * 把从 DB 读出的 Json（unknown）安全解析成 FareBucket[]。
 * 解析失败 / null / 空数组 → 返回 null（表示"无阶梯"，走旧版自动定价）。
 * 不抛错 —— 脏数据降级到旧引擎，绝不让定价路径崩溃。
 */
export function parseFareBuckets(raw: unknown): FareBucket[] | null {
  if (raw == null) return null;
  const parsed = z.array(fareBucketSchema).safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data;
}

/**
 * 写入路径归一化：把 zod 校验过的输入折叠成「要存的值」。
 * null 或 [] → null（清空）；否则原样返回（已按给定顺序，index 0 先卖）。
 * 可选计算非致命提示：Σquota ≠ capacity 时返回 note（不拒绝）。
 */
export function normalizeFareBucketsForWrite(
  input: FareBucketsInput | undefined,
  capacity?: number,
): { value: FareBucket[] | null | undefined; note?: string } {
  if (input === undefined) return { value: undefined };
  if (input === null || input.length === 0) return { value: null };
  let note: string | undefined;
  if (capacity !== undefined) {
    const totalQuota = input.reduce((s, b) => s + b.quota, 0);
    if (totalQuota !== capacity) {
      note = `阶梯总张数 ${totalQuota} 与容量 ${capacity} 不一致（超出部分将按最后一档定价）`;
    }
  }
  return { value: input, note };
}
