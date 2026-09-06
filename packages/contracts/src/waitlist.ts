import { z } from 'zod';

// ── 候补登记 ─────────────────────────────────────────────────────────────
// 业务规则：售罄/余票不足时登记候补；单次 1-9 张（与锁位上限一致）；留电话供运营回访
export const createWaitlistBodySchema = z.object({
  flightScheduleId: z.string().min(1),
  seatClassId: z.string().min(1),
  qty: z.number().int().min(1).max(9),
  contactPhone: z.string().min(1).max(32),
});
export type CreateWaitlistBody = z.infer<typeof createWaitlistBodySchema>;

// ── 运营查询：某班次的候补名单 ───────────────────────────────────────────
export const listWaitlistQuerySchema = z.object({
  scheduleId: z.string().min(1),
});
export type ListWaitlistQuery = z.infer<typeof listWaitlistQuerySchema>;
