/**
 * 收款渠道（统一收款码 / 收款账户）入参校验。
 */
import { z } from 'zod';
import { dataUrlImageSchema } from '../../lib/proof-url.js';

/** kind ∈ {WECHAT, ALIPAY, BANK}（与小程序/前台付款页展示分组一致）。 */
export const PAYMENT_CHANNEL_KINDS = ['WECHAT', 'ALIPAY', 'BANK'] as const;
export const paymentChannelKindSchema = z.enum(PAYMENT_CHANNEL_KINDS);

export const createPaymentChannelSchema = z.object({
  kind: paymentChannelKindSchema,
  label: z.string().min(1).max(120),
  // 收款码图片：data:image/...;base64，≤6MB（复用统一 data-URL 校验）
  qrImageUrl: dataUrlImageSchema.optional(),
  accountText: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  // 专属代理（部分代理有专用收款码）：不填 = 公司统一码，对所有人展示
  agentId: z.string().min(1).optional(),
});
export type CreatePaymentChannelInput = z.infer<typeof createPaymentChannelSchema>;

export const updatePaymentChannelSchema = z
  .object({
    kind: paymentChannelKindSchema.optional(),
    label: z.string().min(1).max(120).optional(),
    qrImageUrl: dataUrlImageSchema.nullable().optional(),
    accountText: z.string().max(2000).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    // 传 null = 改回公司统一码；传字符串 = 绑定到该代理
    agentId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '无可更新字段' });
export type UpdatePaymentChannelInput = z.infer<typeof updatePaymentChannelSchema>;
