import {
  CabinClass,
  HoldAmountRule,
  HoldOrderStatus,
  HoldOverdueAction,
  HoldOwnerType,
  PaymentMethod,
} from '@prisma/client';
import { z } from 'zod';
import { batchPassengerInputSchema } from '../orders/orders.schemas.js';
import { proofUrlSchema } from '../../lib/proof-url.js';

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

/**
 * 建团占位：一次为同一个团的多个航段（去程 / 回程 / 多段）建单，落同一个团号。
 * 座位数、归属、免损比例、备注全团共用；舱位与锁价逐段填（去回程价常常不同）。
 * legs 只有一段时等价于单航段建单，仍会分配团号。
 */
export const createHoldGroupBodySchema = z
  .object({
    legs: z
      .array(
        z
          .object({
            flightScheduleId: z.string().min(1),
            cabin: cabinSchema,
            perSeatPriceCny: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    seats: z.number().int().min(1).max(600),
    mode: z.enum(['RESERVE', 'ALLOTMENT']).default('RESERVE'),
    ownerType: ownerTypeSchema,
    agentId: z.string().min(1).optional(),
    groupName: z.string().trim().min(1).max(120).optional(),
    freeCancelRatio: z.number().min(0).max(0.5).optional(),
    // 手调的收款计划对全团各航段一体适用：一个团只有一套收款节奏，
    // 金额仍按各段自己的锁价算（每人金额 × 座位数）。
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
    // 同一班次同一舱位重复选：两张单会各自占座，等于把同一批人留两遍。
    const seen = new Set<string>();
    body.legs.forEach((leg, index) => {
      const key = `${leg.flightScheduleId}:${leg.cabin}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['legs', index], message: '同一班次同一舱位不能重复添加' });
      }
      seen.add(key);
    });
  });
export type CreateHoldGroupBody = z.infer<typeof createHoldGroupBodySchema>;

export const previewHoldPlanBodySchema = z.object({
  flightScheduleId: z.string().min(1),
  cabin: cabinSchema,
  seats: z.number().int().min(1).max(600),
  perSeatPriceCny: z.number().int().min(0),
  mode: z.enum(['RESERVE', 'ALLOTMENT']).default('RESERVE'),
  installmentsOverride: installmentsOverrideSchema.optional(),
});
export type PreviewHoldPlanBody = z.infer<typeof previewHoldPlanBodySchema>;

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');

export const listHoldOrdersQuerySchema = z.object({
  flightScheduleId: z.string().min(1).optional(),
  status: statusSchema.optional(),
  agentId: z.string().min(1).optional(),
  /** 出发日期起（含），按起飞地当地日折算 */
  from: ymdSchema.optional(),
  /** 出发日期止（含），按起飞地当地日折算 */
  to: ymdSchema.optional(),
  /** 航班 id：跨日期视图下只看某个航班 */
  flightId: z.string().min(1).optional(),
  /** 团号：一次看全这个团的所有航段 */
  groupRef: z.string().min(1).optional(),
});
export type ListHoldOrdersQuery = z.infer<typeof listHoldOrdersQuerySchema>;

export const convertHoldOrderBodySchema = z.object({
  requestToken: z.string().min(8).max(64).uuid(),
  passengers: z.array(batchPassengerInputSchema).min(1).max(100),
  contactName: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(120).optional()),
  contactPhone: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(5).max(40).optional()),
  allowDuplicatePassengers: z.boolean().optional(),
});
export type ConvertHoldOrderBody = z.infer<typeof convertHoldOrderBodySchema>;

export const previewConvertHoldOrderBodySchema = z.object({
  seats: z.number().int().min(1).max(100),
});
export type PreviewConvertHoldOrderBody = z.infer<typeof previewConvertHoldOrderBodySchema>;

export const updateHoldOrderPriceBodySchema = z.object({
  perSeatPriceCny: z.number().int().min(0),
  reason: z.string().trim().min(1).max(200),
});
export type UpdateHoldOrderPriceBody = z.infer<typeof updateHoldOrderPriceBodySchema>;

/**
 * 改团名 / 备注：建单后临时信息经常要补录或订正（票务反馈）。
 * groupName 允许清空（直客单在服务层单独拒绝清空）；notes 传空串视为清空。
 * 至少要传一项，否则调用方等于没改任何东西。
 */
export const updateHoldOrderInfoBodySchema = z
  .object({
    groupName: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((body) => body.groupName !== undefined || body.notes !== undefined, {
    message: '请至少填写团名或备注其中一项',
  });
export type UpdateHoldOrderInfoBody = z.infer<typeof updateHoldOrderInfoBodySchema>;

// 改归属代理：建单时选错代理的订正通道（仅代理 → 代理，直客互转暂不开）。
export const updateHoldOrderAgentBodySchema = z.object({ agentId: z.string().min(1) }).strict();
export type UpdateHoldOrderAgentBody = z.infer<typeof updateHoldOrderAgentBodySchema>;

export const allocateHoldInstallmentBodySchema = z.object({
  receiptId: z.string().min(1),
  amountCny: z.number().int().min(1),
});
export type AllocateHoldInstallmentBody = z.infer<typeof allocateHoldInstallmentBodySchema>;

// 手工到账：运营凭客户水单直接录钱（不经挂账池认款；财务事后核实）。
export const manualReceiptHoldInstallmentBodySchema = z.object({
  amountCny: z.number().int().min(1),
  method: z.enum([PaymentMethod.WECHAT_PAY, PaymentMethod.ALIPAY, PaymentMethod.BANK_CARD]),
  proofUrl: proofUrlSchema.optional(),
  note: z.string().trim().max(500).optional(),
});
export type ManualReceiptHoldInstallmentBody = z.infer<typeof manualReceiptHoldInstallmentBodySchema>;

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
