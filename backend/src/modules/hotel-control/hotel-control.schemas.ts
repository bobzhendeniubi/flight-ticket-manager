import { z } from 'zod';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

// ── 包房周期 CRUD ─────────────────────────────────────────────────────────
export const listBlockPeriodsQuerySchema = z.object({
  hotelId: z.string().optional(),
});
export type ListBlockPeriodsQuery = z.infer<typeof listBlockPeriodsQuerySchema>;

export const createBlockPeriodBodySchema = z.object({
  hotelId: z.string().min(1),
  dateFrom: dateStr,
  dateTo: dateStr,
  rooms: z.number().int().min(0),
  unitPrice: z.number().nonnegative().nullable().optional(), // 切房单价（CNY/间/晚）
  note: z.string().max(200).nullable().optional(),
});
export type CreateBlockPeriodBody = z.infer<typeof createBlockPeriodBodySchema>;

export const updateBlockPeriodBodySchema = z.object({
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
  rooms: z.number().int().min(0).optional(),
  unitPrice: z.number().nonnegative().nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});
export type UpdateBlockPeriodBody = z.infer<typeof updateBlockPeriodBodySchema>;

// ── 销控板 / 远期视图 ─────────────────────────────────────────────────────
export const boardQuerySchema = z.object({
  from: dateStr,
  to: dateStr,
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;
