import { z } from 'zod';

// ── 创建锁位 ─────────────────────────────────────────────────────────────
// 业务规则（客户确认）：单次最多锁 9 张（含），固定 10 分钟有效
export const createSeatLockBodySchema = z.object({
  flightScheduleId: z.string().min(1),
  seatClassId: z.string().min(1),
  qty: z.number().int().min(1).max(9),
});
export type CreateSeatLockBody = z.infer<typeof createSeatLockBodySchema>;
