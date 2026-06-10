import { z } from 'zod';
import { FulfillmentStatus, FulfillmentType } from '@prisma/client';

export const listFulfillmentQuerySchema = z.object({
  orderId: z.string().optional(),
  orderItemId: z.string().optional(),
  type: z.nativeEnum(FulfillmentType).optional(),
  status: z.nativeEnum(FulfillmentStatus).optional(),
  assigneeUserId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListFulfillmentQuery = z.infer<typeof listFulfillmentQuerySchema>;

export const updateFulfillmentBodySchema = z.object({
  status: z.nativeEnum(FulfillmentStatus).optional(),
  // 多态 data 字段（视 type 而定）
  data: z.record(z.unknown()).optional(),
  notes: z.string().max(1000).optional(),
  assigneeUserId: z.string().optional().nullable(),
  failureReason: z.string().max(500).optional(),
});
export type UpdateFulfillmentBody = z.infer<typeof updateFulfillmentBodySchema>;

// ── 批量状态流转（签证批量标"已送签"等；镜像 orders batch-status）─────────
export const batchFulfillmentStatusBodySchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(100),
  toStatus: z.nativeEnum(FulfillmentStatus),
});
export type BatchFulfillmentStatusBody = z.infer<typeof batchFulfillmentStatusBodySchema>;
