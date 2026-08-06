/**
 * 机票结算价日历 · zod 入参（与地面结算价 settlement-rates.schemas.ts 并列同风格）。
 * 网格口径：行 = 出发日期，列 = 航班号（去程/回程各一列），每格一个每人结算价（CNY）。
 */
import { z } from 'zod';

// 出发日期（date-only，YYYY-MM-DD）
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

// 航班号：大小写字母 + 数字（如 QH9589），统一 trim + 转大写后比对，避免同一航班两行价。
const flightNumberSchema = z
  .string()
  .trim()
  .min(2, '航班号至少 2 位')
  .max(10, '航班号最多 10 位')
  .regex(/^[A-Za-z0-9]+$/u, '航班号只能是字母和数字')
  .transform((s) => s.toUpperCase());

// ── 网格查询：出发日期区间（含端点）+ 可选航班号列表 ────────────────────────
export const listFlightRatesQuerySchema = z.object({
  from: dateStr,
  to: dateStr,
  // 查询串里以逗号分隔（如 ?flightNumbers=QH9589,QH9588）；缺省 = 区间内全部航班号
  flightNumbers: z
    .string()
    .optional()
    .transform((raw) =>
      raw == null
        ? undefined
        : raw
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
    ),
});
export type ListFlightRatesQuery = z.infer<typeof listFlightRatesQuerySchema>;

// ── 批量 upsert：一次提交多格（网格整批保存 / Excel 粘贴块）──────────────────
const flightRateEntrySchema = z.object({
  flightNumber: flightNumberSchema,
  departDate: dateStr,
  // 每人结算价（CNY，整数，≥0）
  pricePerPersonCny: z.number().int().min(0).max(10_000_000),
  note: z.string().max(200).nullable().optional(),
});
export type FlightRateEntry = z.infer<typeof flightRateEntrySchema>;

export const upsertFlightRatesBodySchema = z.object({
  // 一次最多 2000 格（约 31 天 × 数十个航班号，足够整月整批保存）
  rates: z.array(flightRateEntrySchema).min(1).max(2000),
});
export type UpsertFlightRatesBody = z.infer<typeof upsertFlightRatesBodySchema>;

export const deleteFlightRateParamsSchema = z.object({
  id: z.string().min(1),
});
export type DeleteFlightRateParams = z.infer<typeof deleteFlightRateParamsSchema>;
