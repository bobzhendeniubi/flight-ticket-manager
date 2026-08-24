import { CabinClass, HoldOrderStatus, HoldOwnerType } from '@prisma/client';
import { z } from 'zod';

const cabinSchema = z.nativeEnum(CabinClass);
const ownerTypeSchema = z.nativeEnum(HoldOwnerType);
const statusSchema = z.nativeEnum(HoldOrderStatus);

export const createHoldOrderBodySchema = z
  .object({
    flightScheduleId: z.string().min(1),
    cabin: cabinSchema,
    seats: z.number().int().min(1).max(600),
    perSeatPriceCny: z.number().int().min(0),
    ownerType: ownerTypeSchema,
    agentId: z.string().min(1).optional(),
    groupName: z.string().trim().min(1).max(120).optional(),
    freeCancelRatio: z.number().min(0).max(0.5).optional(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.ownerType === HoldOwnerType.AGENT && !body.agentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agentId'], message: '代理占位必须选择代理' });
    }
    if (body.ownerType === HoldOwnerType.CUSTOMER && !body.groupName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groupName'], message: '直客占位必须填写团名或客户备注名' });
    }
  });
export type CreateHoldOrderBody = z.infer<typeof createHoldOrderBodySchema>;

export const listHoldOrdersQuerySchema = z.object({
  flightScheduleId: z.string().min(1).optional(),
  status: statusSchema.optional(),
  agentId: z.string().min(1).optional(),
});
export type ListHoldOrdersQuery = z.infer<typeof listHoldOrdersQuerySchema>;

export const updateHoldOrderPriceBodySchema = z.object({
  perSeatPriceCny: z.number().int().min(0),
  reason: z.string().trim().min(1).max(200),
});
export type UpdateHoldOrderPriceBody = z.infer<typeof updateHoldOrderPriceBodySchema>;
