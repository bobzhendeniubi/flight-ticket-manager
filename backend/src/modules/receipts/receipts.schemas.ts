/**
 * 收款对账台 / 挂账池 入参校验。
 */
import { z } from 'zod';
import { PaymentMethod, ReceiptStatus } from '@prisma/client';
import { proofUrlSchema } from '../../lib/proof-url.js';

/** 进账金额：> 0，封顶（防手误录入天文数字）。 */
const amountCnySchema = z.number().positive().max(100_000_000);

/** 登记新进账（财务后台手动）。 */
export const registerReceiptSchema = z.object({
  amountCny: amountCnySchema,
  method: z.nativeEnum(PaymentMethod),
  proofUrl: proofUrlSchema.optional(),
  payerNote: z.string().max(500).optional(),
  // 到账时间（财务可手填）；缺省 = 现在
  receivedAt: z.coerce.date().optional(),
  // 疑似归属订单（仅提示，不等于已认领）
  orderHintId: z.string().min(1).max(64).optional(),
});
export type RegisterReceiptInput = z.infer<typeof registerReceiptSchema>;

/** 认领进账到订单（原子、全有或全无）。 */
export const allocateReceiptSchema = z.object({
  orderId: z.string().min(1).max(64),
  amountCny: amountCnySchema,
});
export type AllocateReceiptInput = z.infer<typeof allocateReceiptSchema>;

/** 退款剩余未认领部分。 */
export const refundReceiptSchema = z.object({
  note: z.string().min(1).max(500),
});
export type RefundReceiptInput = z.infer<typeof refundReceiptSchema>;

/** 挂账池列表过滤。 */
export const listReceiptsQuerySchema = z.object({
  status: z.nativeEnum(ReceiptStatus).optional(),
  // 关键字：匹配 receiptNo / payerNote / orderHintId
  q: z.string().max(120).optional(),
});
export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;
