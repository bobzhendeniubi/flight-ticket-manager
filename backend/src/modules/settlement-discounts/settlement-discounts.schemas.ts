import { z } from 'zod';
import { SettlementDiscountKind, SettlementTier } from '@prisma/client';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');
const tierSchema = z.nativeEnum(SettlementTier);
const kindSchema = z.nativeEnum(SettlementDiscountKind);
const nightsSchema = z.number().int().min(1).max(5);

export const listDiscountRulesQuerySchema = z
  .object({
    kind: kindSchema.optional(),
    agentId: z.string().min(1).optional(),
    tier: tierSchema.optional(),
    nights: z.coerce.number().int().min(1).max(5).optional(),
    from: dateStr.optional(),
    to: dateStr.optional(),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: '起始日期不能晚于结束日期',
    path: ['to'],
  });
export type ListDiscountRulesQuery = z.infer<typeof listDiscountRulesQuerySchema>;

export const discountRuleEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    kind: kindSchema,
    agentId: z.string().min(1).optional(),
    tier: tierSchema,
    nights: nightsSchema,
    startDate: dateStr,
    endDate: dateStr,
    discountPerPersonCny: z.number().int().min(1).max(20_000),
    isActive: z.boolean().optional().default(true),
    note: z.string().max(200).nullable().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: '结束日期不能早于开始日期',
    path: ['endDate'],
  })
  .refine((v) => (v.kind === SettlementDiscountKind.AGENT) === Boolean(v.agentId), {
    message: '指定代理立减必须选择代理；代理兜底和散客立减不能绑定代理',
    path: ['agentId'],
  });
export type DiscountRuleEntry = z.infer<typeof discountRuleEntrySchema>;

export const upsertDiscountRulesBodySchema = z.object({
  rules: z.array(discountRuleEntrySchema).min(1).max(200),
});
export type UpsertDiscountRulesBody = z.infer<typeof upsertDiscountRulesBodySchema>;

export const deleteDiscountRuleParamsSchema = z.object({
  id: z.string().min(1),
});
export type DeleteDiscountRuleParams = z.infer<typeof deleteDiscountRuleParamsSchema>;

export const retailQuoteQuerySchema = z.object({
  tier: tierSchema,
  nights: z.coerce.number().int().min(1).max(5),
  departDate: dateStr,
});
export type RetailQuoteQuery = z.infer<typeof retailQuoteQuerySchema>;
