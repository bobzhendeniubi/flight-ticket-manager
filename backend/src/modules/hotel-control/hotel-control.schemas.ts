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

// ── 按酒店导出护照 zip（选酒店 + 入住日期区间）────────────────────────────
export const hotelPassportsQuerySchema = z
  .object({
    hotelId: z.string().min(1),
    from: dateStr,
    to: dateStr,
  })
  .refine((q) => q.from <= q.to, { message: '起始日不能晚于结束日' });
export type HotelPassportsQuery = z.infer<typeof hotelPassportsQuerySchema>;

// ── 按姓名批量导出护照 zip（不限酒店/日期，直接按姓名命中乘客）───────────
export const hotelPassportsByNamesBodySchema = z.object({
  names: z
    .array(z.string().trim().min(1).max(60))
    .min(1, '请至少输入一个姓名')
    .max(100, '单次最多按 100 个姓名导出，请分批操作'),
});
export type HotelPassportsByNamesBody = z.infer<typeof hotelPassportsByNamesBodySchema>;

// ── 提醒线（超卖加房 / 富余退房 / 班次超开票上限）─────────────────────────
export const alertsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).default(14),
});
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

// ── 占房下钻（某酒店某晚，谁占的；销控矩阵红/黄格点击用）────────────────────
export const occupantsQuerySchema = z.object({
  hotelId: z.string().min(1),
  date: dateStr,
});
export type OccupantsQuery = z.infer<typeof occupantsQuerySchema>;

// ── 当日余量（给定房型 + 入住区间逐晚展开；分房弹窗徽标用）───────────────────
export const nightlyRemainingQuerySchema = z
  .object({
    hotelRoomTypeId: z.string().min(1),
    checkIn: dateStr,
    checkOut: dateStr,
  })
  .refine((q) => q.checkIn < q.checkOut, { message: '入住日必须早于退房日' });
export type NightlyRemainingQuery = z.infer<typeof nightlyRemainingQuerySchema>;
