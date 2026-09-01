import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';

/**
 * 到账金额入参口径：正数、最多两位小数（到分）。
 *
 * 为什么要卡死两位：钱在库里是 Decimal(…,2)，三位及以上小数落库会被四舍五入，
 * 等于凭空多收/少收半分；超收判定也按分的整数比，来路不明的第三位小数只会让账面对不上。
 * 与其静默归一，不如在门口拒收、让人重填。
 */
export const cnyAmountSchema = z
  .number()
  .positive('金额必须大于 0')
  .refine((n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, {
    message: '金额最多到分（两位小数），请核对后重填',
  });

export const createPaymentBodySchema = z.object({
  orderId: z.string(),
  method: z.nativeEnum(PaymentMethod),
  returnUrl: z.string().url().optional(),
});
export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;

export const sandboxConfirmBodySchema = z.object({
  paymentId: z.string(),
  transactionId: z.string().optional(),
  amountYuan: z.number().optional(),
  // 可选标记失败，用来测 FAILED 分支
  shouldFail: z.boolean().default(false),
});

/** 已入账收款转移到另一张订单：目标订单号 + 可追溯原因。 */
export const transferManualPaymentBodySchema = z.object({
  targetOrderNumber: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(4).max(200),
});

/** 换人转出：源单留存手填换人费，其余净收款转入新订单。 */
export const swapTransferBodySchema = z.object({
  targetOrderNumber: z.string().trim().min(1, '请填写转入的订单号').max(64),
  // 换人费按单手填，每单金额可能不同；不做枚举或规则表约束。
  transferFeeCny: z.number().int().min(0),
  reason: z.string().trim().min(1, '请填写换人转出原因').max(500),
});
