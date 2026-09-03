/**
 * 结算价议价申请 · 入参校验。
 *
 * 代理不能自己改结算价（那等于自己给自己打折），只能提交一个「想要的整单价」；
 * 订单金额一分不动，运营确认时才由服务端按既有调价通道生成差额行。
 */
import { z } from 'zod';
import { SettlementRequestStatus } from '@prisma/client';
import { PRICE_ADJUSTMENT_CAP_CNY } from '../orders/orders.schemas.js';

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

/**
 * 指定乘客时填的「调整净额」（正=补收 / 负=优惠）。
 *
 * 口径与事后调价 addPriceAdjustment 的 amountCny 一字一致（整数 CNY、非 0、不超单笔上限）——
 * 按人改价只能填净额、不能填「这个人的新结算价」：每人结算价是「应收均摊 + 该乘客调整净额」
 * 派生出来的展示值，本来就不接受手填，收一个新总价反而要倒推均摊、两处口径必然漂移。
 */
const adjustmentCnySchema = z
  .number()
  .int('调整金额必须为整数（CNY）')
  .refine((v) => v !== 0, { message: '调整金额不能为 0（不调整请勿提交）' })
  .refine((v) => Math.abs(v) <= PRICE_ADJUSTMENT_CAP_CNY, {
    message: `调整金额超出上限（±${PRICE_ADJUSTMENT_CAP_CNY}）`,
  });

/**
 * 提交申请的两种口径，二选一（互斥，服务端按 passengerId 是否为空分流）：
 *   · 整单：只传 requestedTotalCny =「这一单我想收多少」（老客户端原样可用，行为不变）；
 *   · 指定乘客：传 passengerId + adjustmentCny =「只给这个人加/减多少」。
 * 两组字段都在同一个对象上（不用 discriminatedUnion）是为了让老请求体一字不改仍然合法。
 */
export const createSettlementRequestBodySchema = z
  .object({
    requestedTotalCny: requestedTotalSchema.optional(),
    passengerId: z.string().min(1).max(64).optional(),
    adjustmentCny: adjustmentCnySchema.optional(),
    note: z.string().max(200, '申请说明最多 200 字').optional(),
  })
  .superRefine((v, ctx) => {
    if (v.passengerId) {
      if (v.adjustmentCny === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['adjustmentCny'],
          message: '指定乘客时请填写调整净额（正=补收 / 负=优惠）',
        });
      }
      if (v.requestedTotalCny !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requestedTotalCny'],
          message: '指定乘客时按调整净额提交，不接受整单结算总价',
        });
      }
      return;
    }
    if (v.requestedTotalCny === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedTotalCny'],
        message: '请填写本单结算总价',
      });
    }
    if (v.adjustmentCny !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adjustmentCny'],
        message: '整单申请按结算总价提交；调整净额只用于指定乘客',
      });
    }
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
