import {
  CabinClass,
  HoldAmountRule,
  HoldOrderStatus,
  HoldOverdueAction,
  HoldOwnerType,
} from '@prisma/client';
import { z } from 'zod';

const cabinSchema = z.nativeEnum(CabinClass);
const ownerTypeSchema = z.nativeEnum(HoldOwnerType);
const statusSchema = z.nativeEnum(HoldOrderStatus);
const amountRuleSchema = z.nativeEnum(HoldAmountRule);

const installmentOverrideSchema = z.object({
  label: z.string().trim().min(1).max(40),
  perPersonCny: z.number().int().min(0).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
}).strict();

const installmentsOverrideSchema = z.array(installmentOverrideSchema).min(1).max(6).superRefine((rows, ctx) => {
  rows.forEach((row, index) => {
    const isTail = index === rows.length - 1;
    if (isTail && row.perPersonCny != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'perPersonCny'], message: '尾款必须是最后一期且不能填写每人金额' });
    } else if (!isTail && row.perPersonCny == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'perPersonCny'], message: '非尾款期必须填写每人金额' });
    }
  });
});

export const createHoldOrderBodySchema = z
  .object({
    flightScheduleId: z.string().min(1),
    cabin: cabinSchema,
    seats: z.number().int().min(1).max(600),
    perSeatPriceCny: z.number().int().min(0),
    mode: z.enum(['RESERVE', 'ALLOTMENT']).default('RESERVE'),
    ownerType: ownerTypeSchema,
    agentId: z.string().min(1).optional(),
    groupName: z.string().trim().min(1).max(120).optional(),
    freeCancelRatio: z.number().min(0).max(0.5).optional(),
    installmentsOverride: installmentsOverrideSchema.optional(),
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

export const previewHoldPlanBodySchema = z.object({
  flightScheduleId: z.string().min(1),
  cabin: cabinSchema,
  seats: z.number().int().min(1).max(600),
  perSeatPriceCny: z.number().int().min(0),
  mode: z.enum(['RESERVE', 'ALLOTMENT']).default('RESERVE'),
  installmentsOverride: installmentsOverrideSchema.optional(),
});
export type PreviewHoldPlanBody = z.infer<typeof previewHoldPlanBodySchema>;

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

export const allocateHoldInstallmentBodySchema = z.object({
  receiptId: z.string().min(1),
  amountCny: z.number().int().min(1),
});
export type AllocateHoldInstallmentBody = z.infer<typeof allocateHoldInstallmentBodySchema>;

export const reverseHoldAllocationBodySchema = z.object({
  reason: z.string().trim().min(1).max(200),
});
export type ReverseHoldAllocationBody = z.infer<typeof reverseHoldAllocationBodySchema>;

export const updateHoldInstallmentBodySchema = z.object({
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});
export type UpdateHoldInstallmentBody = z.infer<typeof updateHoldInstallmentBodySchema>;

export const reduceHoldSeatsBodySchema = z.object({
  seats: z.number().int().min(1),
  note: z.string().trim().max(500).optional(),
});
export type ReduceHoldSeatsBody = z.infer<typeof reduceHoldSeatsBodySchema>;

const configInstallmentSchema = z.object({
  label: z.string().trim().min(1).max(40),
  amountRule: amountRuleSchema,
  perPersonCny: z.number().int().min(0).optional(),
  dueOffsetDays: z.number().int().min(0).nullable(),
}).superRefine((item, ctx) => {
  if (item.amountRule === HoldAmountRule.PER_PERSON_FIXED && item.perPersonCny == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['perPersonCny'], message: '固定每人金额期必须填写 perPersonCny' });
  }
  if (item.amountRule === HoldAmountRule.REMAINDER && item.perPersonCny != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['perPersonCny'], message: '尾款期不能填写 perPersonCny' });
  }
});

export const updateHoldOrderConfigBodySchema = z.object({
  installments: z.array(configInstallmentSchema).min(1).max(6),
  overdueAction: z.nativeEnum(HoldOverdueAction),
  defaultFreeCancelRatio: z.number().min(0).max(0.5),
}).superRefine((body, ctx) => {
  const remainderIndexes = body.installments
    .map((item, index) => item.amountRule === HoldAmountRule.REMAINDER ? index : -1)
    .filter((index) => index >= 0);
  if (remainderIndexes.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['installments'], message: '收款模板必须且只能有一期尾款' });
  } else if (remainderIndexes[0] !== body.installments.length - 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['installments'], message: '尾款必须是最后一期' });
  }
  const offsets = body.installments.map((item) => item.dueOffsetDays == null ? Number.POSITIVE_INFINITY : item.dueOffsetDays);
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] >= offsets[i - 1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['installments', i, 'dueOffsetDays'], message: '截止天数必须逐期递减' });
      break;
    }
  }
});
export type UpdateHoldOrderConfigBody = z.infer<typeof updateHoldOrderConfigBodySchema>;
