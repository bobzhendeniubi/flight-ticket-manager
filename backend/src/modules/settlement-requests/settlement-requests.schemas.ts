/**
 * 结算价议价申请 · 入参校验。
 *
 * 代理不能自己改结算价（那等于自己给自己打折），只能提交一个「想要的整单价」；
 * 订单金额一分不动，运营确认时才由服务端按既有调价通道生成差额行。
 */
import { z } from 'zod';
import { SettlementRequestStatus } from '@prisma/client';

/**
 * 申请价的绝对上限：Order.total 落 Decimal(12, 2)，越界会在写库时炸成 500。
 * 真正管事的闸是「申请价与应收的差额 ≤ PRICE_ADJUSTMENT_CAP_CNY」（服务层校验），
 * 这里只挡手误多打几个零，让它在入参层就变成可读的 400。
 */
export const MAX_REQUESTED_TOTAL_CNY = 99_999_999;

/** 金额：非负，最多两位小数（应收本身是 Decimal(12,2)，差额自然可能带小数）。 */
const requestedTotalSchema = z
  .number()
  .min(0, '申请价不能为负')
  .max(MAX_REQUESTED_TOTAL_CNY, '申请价过大，请核对后重填')
  // 浮点直接比较（v * 100 === Math.round(v * 100)）在 1234.56 这类值上会因二进制表示失真而误判，
  // 故用「放大到分后与自身四舍五入值的差 < 1e-6」判定两位小数。
  .refine((v) => Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: '申请价最多两位小数',
  });

export const createSettlementRequestBodySchema = z.object({
  requestedTotalCny: requestedTotalSchema,
  note: z.string().max(200, '申请说明最多 200 字').optional(),
});
export type CreateSettlementRequestBody = z.infer<typeof createSettlementRequestBodySchema>;

/** 确认 / 驳回共用：决定备注可空（驳回时建议填，但不强制，避免卡住急件）。 */
export const decideSettlementRequestBodySchema = z.object({
  note: z.string().max(200, '备注最多 200 字').optional(),
});
export type DecideSettlementRequestBody = z.infer<typeof decideSettlementRequestBodySchema>;

export const listSettlementRequestsQuerySchema = z.object({
  status: z.nativeEnum(SettlementRequestStatus).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSettlementRequestsQuery = z.infer<typeof listSettlementRequestsQuerySchema>;
