/**
 * 收款对账台 / 挂账池 入参校验。
 */
import { z } from 'zod';
import { PaymentMethod, ReceiptStatus } from '@prisma/client';
import { proofUrlSchema } from '../../lib/proof-url.js';
import { STATEMENT_PLATFORMS, type StatementPlatform } from './receipts.statement.js';

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
  // '1' = 只回未认完的（OPEN + PARTIALLY_ALLOCATED）——认款工作台专用，
  // 防止 take 500 被大量已认款记录占满、把更早的未认款流水挤出池子
  unallocatedOnly: z.literal('1').optional(),
  // 关键字：匹配 receiptNo / payerNote / orderHintId / externalTxnId
  q: z.string().max(120).optional(),
});
export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 二维码流水导入（收单平台对账单）
// ─────────────────────────────────────────────────────────────────────────────

// base64 xlsx 上限 ~12MB（收单平台单日流水远小于此；防误传超大文件）
const STATEMENT_FILE_MAX_BASE64 = 12 * 1024 * 1024;

/** 解析流水文件（仅预览，不写库）。 */
export const parseStatementSchema = z.object({
  platform: z.enum(STATEMENT_PLATFORMS, {
    required_error: '请先选择流水平台',
    invalid_type_error: '请先选择流水平台',
  }),
  fileBase64: z.string().min(1).max(STATEMENT_FILE_MAX_BASE64),
});
export type ParseStatementInput = z.infer<typeof parseStatementSchema>;

/**
 * 导入流水行（预览确认后提交；服务端按 externalTxnId 唯一索引兜底去重）。
 * - 流水号 trim：防 " TXN1" 与 "TXN1" 被当成两笔分别入库（审计发现#3）。
 * - 金额加「round 到分后 ≥ 0.01」：防分以下金额 round 成 0 生成僵尸进账（审计发现#6）。
 * - 方式白名单：收单流水只可能是微信/支付宝/银行卡——AGENT_PREPAYMENT 是内部记账
 *   方式，不允许经流水导入伪造（审计发现#1 的可行部分）。
 */
export const importStatementSchema = z.object({
  platform: z.enum(STATEMENT_PLATFORMS, {
    required_error: '请先选择流水平台',
    invalid_type_error: '请先选择流水平台',
  }),
  rows: z
    .array(
      z.object({
        externalTxnId: z.string().trim().min(4).max(64),
        amountCny: amountCnySchema.refine(
          (v) => Math.round(v * 100) / 100 >= 0.01,
          '金额需不少于 0.01 元',
        ),
        method: z.enum([PaymentMethod.WECHAT_PAY, PaymentMethod.ALIPAY, PaymentMethod.BANK_CARD]),
        receivedAt: z.coerce.date(),
        payerNote: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export type ImportStatementInput = z.infer<typeof importStatementSchema>;
export type { StatementPlatform };

/** 流水核对表导出过滤（到账日期闭区间，北京时；缺省全量分页导出）。 */
export const exportStatementQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '导出区间无效：开始日期晚于结束日期',
  });
export type ExportStatementQuery = z.infer<typeof exportStatementQuerySchema>;
