/**
 * 代理认款（充值申请）入参校验。
 *
 * 流程：代理上传付款凭证 + 申报金额 → 财务核实到账后确认 → 生成 TOP_UP 预存流水并加余额。
 * 余额只能这样充进来，不许赊账（Agent.prepaymentBalance 永不为负）。
 */
import { z } from 'zod';
import { AgentRechargeStatus } from '@prisma/client';
import { dataUrlImageSchema } from '../../lib/proof-url.js';

/** 单笔认款申报上限（¥200 万），防手误多加零。 */
export const MAX_RECHARGE_AMOUNT_CNY = 2_000_000;

/** 凭证图片：1-3 张，复用统一 data-URL 校验（≤6MB/张，必须是 data:image/...）。 */
const proofImagesSchema = z
  .array(dataUrlImageSchema)
  .min(1, '至少上传 1 张付款凭证')
  .max(3, '最多上传 3 张付款凭证');

export const createRechargeRequestSchema = z.object({
  // ADMIN/STAFF 代提交时必填；AGENT 自己提交时会被忽略，一律取 req.user 解析出的 agentId
  agentId: z.string().min(1).optional(),
  amountCny: z.number().positive('申报金额必须大于 0').max(MAX_RECHARGE_AMOUNT_CNY, '单笔认款金额过大，请拆分提交或联系财务'),
  note: z.string().max(500).optional(),
  proofImages: proofImagesSchema,
});
export type CreateRechargeRequestInput = z.infer<typeof createRechargeRequestSchema>;

export const listRechargeRequestsQuerySchema = z.object({
  status: z.nativeEnum(AgentRechargeStatus).optional(),
  // 仅 ADMIN/STAFF 生效；AGENT 请求带这个参数也会被服务层忽略（只能看自己的）
  agentId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRechargeRequestsQuery = z.infer<typeof listRechargeRequestsQuerySchema>;

export const confirmRechargeRequestSchema = z.object({
  // 缺省 = 按申报金额（amountCny）全额入账
  confirmedAmountCny: z.number().positive('到账金额必须大于 0').max(MAX_RECHARGE_AMOUNT_CNY).optional(),
  reviewNote: z.string().max(500).optional(),
});
export type ConfirmRechargeRequestInput = z.infer<typeof confirmRechargeRequestSchema>;

export const rejectRechargeRequestSchema = z.object({
  reviewNote: z.string().min(1, '请填写驳回原因').max(500),
});
export type RejectRechargeRequestInput = z.infer<typeof rejectRechargeRequestSchema>;

/**
 * 手动余额调整（人工修正用，如线下对账差异）。
 * 只允许 TOP_UP（正向）/ ADJUSTMENT（正负均可，但负向必须 ≤ 当前余额，结果不为负）。
 * 不接受 OFFSET/REFUND —— 那两种类型专属于订单抵扣 / 结算流程，不走这个手动入口。
 */
export const manualBalanceAdjustmentSchema = z.object({
  agentId: z.string().min(1, '请选择代理'),
  // 正数 = 加余额，负数 = 扣余额（扣减后不得为负，由服务层校验）
  amount: z
    .number()
    .refine((v) => v !== 0, '调整金额不能为 0')
    .refine((v) => Math.abs(v) <= MAX_RECHARGE_AMOUNT_CNY, '单次调整金额过大'),
  reason: z.string().min(1, '请填写调整原因').max(500),
});
export type ManualBalanceAdjustmentInput = z.infer<typeof manualBalanceAdjustmentSchema>;
