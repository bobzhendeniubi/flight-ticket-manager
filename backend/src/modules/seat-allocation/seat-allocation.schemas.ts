import { z } from 'zod';
import { CabinClass } from '@prisma/client';

// ── 创建切位（包位）───────────────────────────────────────────────────────────
// 从散客池划 seats 座给 agentId 专卖；service 层校验 seats ≤ 当前散客池余票。
export const createSeatAllocationBodySchema = z.object({
  flightScheduleId: z.string().min(1),
  cabin: z.nativeEnum(CabinClass),
  agentId: z.string().min(1),
  seats: z.number().int().min(1),
  // 约定单价（选填；null / 省略 = 按常规售价）
  unitPriceCny: z.number().int().min(0).nullish(),
  // 出发前多少天回收未售部分（默认 7）
  reclaimDaysBefore: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(500).nullish(),
});
export type CreateSeatAllocationBody = z.infer<typeof createSeatAllocationBodySchema>;

// ── 列表筛选（两个都选填；都不填 = 全部 ACTIVE + RECLAIMED）────────────────────
export const listSeatAllocationsQuerySchema = z.object({
  flightScheduleId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});
export type ListSeatAllocationsQuery = z.infer<typeof listSeatAllocationsQuerySchema>;
