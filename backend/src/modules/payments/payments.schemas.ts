import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';

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
