import { z } from 'zod';
import { SettlementTier } from '@prisma/client';

// 出发日期（date-only，YYYY-MM-DD）
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

// 酒店档次（对齐 Prisma SettlementTier；中文标签放前端映射，后端只认枚举值）
const tierSchema = z.nativeEnum(SettlementTier);

// 住宿晚数（1–5）——同业结算表当前只维护 1..5 晚
const nightsSchema = z.number().int().min(1).max(5);

// ── 网格查询：按出发日期区间 + 可选晚数/档次筛选 ─────────────────────────
export const listRatesQuerySchema = z.object({
  from: dateStr,
  to: dateStr,
  // 查询串是字符串，coerce 成数字；缺省 = 返回区间内全部晚数
  nights: z.coerce.number().int().min(1).max(5).optional(),
  tier: tierSchema.optional(),
});
export type ListRatesQuery = z.infer<typeof listRatesQuerySchema>;

// ── 批量 upsert：一次提交多格（网格整批保存 / Excel 粘贴块）────────────────
const rateEntrySchema = z.object({
  tier: tierSchema,
  nights: nightsSchema,
  departDate: dateStr,
  // 每人结算价（CNY，整数，≥0）
  pricePerPersonCny: z.number().int().min(0).max(10_000_000),
  note: z.string().max(200).nullable().optional(),
});
export type RateEntry = z.infer<typeof rateEntrySchema>;

export const upsertRatesBodySchema = z.object({
  // 一次最多 2000 格（约 1 档 × 1 晚 × 数年，足够整月整批保存）
  rates: z.array(rateEntrySchema).min(1).max(2000),
});
export type UpsertRatesBody = z.infer<typeof upsertRatesBodySchema>;

export const deleteRateParamsSchema = z.object({
  id: z.string().min(1),
});
export type DeleteRateParams = z.infer<typeof deleteRateParamsSchema>;
