import { z } from 'zod';
import {
  FulfillmentStatus,
  FulfillmentType,
  VisaIssuanceMethod,
  VisaSubmissionStatus,
} from '@prisma/client';

/**
 * 状态筛选：允许多值，这样签证台「待办」= PENDING + IN_PROGRESS 能在**后端**表达，
 * 分页与 total 才和实际能翻到的行数对得上（旧实现只收单状态 → 前端二次过滤 →
 * 总数虚高、跨页漏单）。
 *
 * 三种写法都收（向后兼容单状态老调用）：
 *   status=PENDING                    → ['PENDING']
 *   status=PENDING,IN_PROGRESS        → ['PENDING','IN_PROGRESS']
 *   status=PENDING&status=IN_PROGRESS → ['PENDING','IN_PROGRESS']
 * 省略/空串 = 不加状态条件（「全部状态」）。
 */
const statusFilterSchema = z.preprocess(
  (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const raw = Array.isArray(v) ? v : String(v).split(',');
    const items = raw.map((s) => String(s).trim()).filter(Boolean);
    return items.length ? items : undefined;
  },
  z.array(z.nativeEnum(FulfillmentStatus)).min(1).optional(),
);

export const listFulfillmentQuerySchema = z.object({
  orderId: z.string().optional(),
  orderItemId: z.string().optional(),
  type: z.nativeEnum(FulfillmentType).optional(),
  status: statusFilterSchema,
  assigneeUserId: z.string().optional(),
  // 备注文本筛选（不区分大小写子串匹配）；省略/空串 = 不筛
  notesQuery: z.string().max(100).optional(),
  /**
   * 签发方式筛选（签证台「签证类型」）；'NONE' = 未标注。
   * 口径与 effectiveVisaClassification 的**有效签发方式**逐字对齐（含订单级 E_VISA 回退），
   * 见 fulfillment.service 的 issuanceMethodWhere。
   */
  issuanceMethod: z.union([z.nativeEnum(VisaIssuanceMethod), z.literal('NONE')]).optional(),
  /**
   * 出发日期筛选（单日 YYYY-MM-DD，按订单最早一段机票的**出发地本地日**比对）。
   * 纯签证单无航班 → 保留可见（与护照导出同口径，不被日期筛选误隐藏）。
   * 向后兼容参数：新前端改用区间 departureDateFrom/To；旧单日仍等价于 from=to=该日。
   */
  departureDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '出发日期需为 YYYY-MM-DD')
    .optional(),
  /** 出发日期区间起（YYYY-MM-DD，含）；可单独给一侧（开区间）。 */
  departureDateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '出发日期需为 YYYY-MM-DD')
    .optional(),
  /** 出发日期区间止（YYYY-MM-DD，含）；可单独给一侧（开区间）。 */
  departureDateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '出发日期需为 YYYY-MM-DD')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListFulfillmentQuery = z.infer<typeof listFulfillmentQuerySchema>;

/**
 * 签证实际成本三字段（人均口径，仅 VISA_APPLICATION 任务可设）。
 * 每个字段独立可空：任一出现即视为「设置签证金额」，三者同时置 null = 清空回退产品主数据成本。
 *   · visaUnitCostUsd + visaFxRate 齐备 → 后端自动折算 visaUnitCostCny 存底（入账权威）
 *   · 只给 visaUnitCostCny → 直接入账（美金/汇率清空）
 * 校验非负；汇率须为正。
 */
export const visaTaskCostSchema = z.object({
  visaUnitCostUsd: z.number().nonnegative().nullable().optional(),
  visaFxRate: z.number().positive().nullable().optional(),
  visaUnitCostCny: z.number().nonnegative().nullable().optional(),
});
export type VisaTaskCost = z.infer<typeof visaTaskCostSchema>;

export const updateFulfillmentBodySchema = z.object({
  status: z.nativeEnum(FulfillmentStatus).optional(),
  // 多态 data 字段（视 type 而定）
  data: z.record(z.unknown()).optional(),
  notes: z.string().max(1000).optional(),
  assigneeUserId: z.string().optional().nullable(),
  failureReason: z.string().max(500).optional(),
  // 签证实际成本（仅签证任务生效；service 层校验 type）
  visaUnitCostUsd: z.number().nonnegative().nullable().optional(),
  visaFxRate: z.number().positive().nullable().optional(),
  visaUnitCostCny: z.number().nonnegative().nullable().optional(),
});
export type UpdateFulfillmentBody = z.infer<typeof updateFulfillmentBodySchema>;

// ── 批量设置签证金额（签证公司按航班统一单价是常态）─────────────────────────
// 沿用批量机制（taskIds + 统一取值），逐条复用单任务 update 的签证成本校验/折算。
export const batchVisaTaskCostBodySchema = z
  .object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
  })
  .merge(visaTaskCostSchema);
export type BatchVisaTaskCostBody = z.infer<typeof batchVisaTaskCostBodySchema>;

// ── 批量状态流转（签证批量标"已送签"等；镜像 orders batch-status）─────────
export const batchFulfillmentStatusBodySchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(100),
  toStatus: z.nativeEnum(FulfillmentStatus),
});
export type BatchFulfillmentStatusBody = z.infer<typeof batchFulfillmentStatusBodySchema>;

// ── 批量改备注（独立于批量改状态，不动 status）─────────────────────────
export const batchFulfillmentNotesBodySchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(100),
  // 允许空串（= 批量清空备注），与单条 PATCH notes 语义一致
  notes: z.string().max(1000),
});
export type BatchFulfillmentNotesBody = z.infer<typeof batchFulfillmentNotesBodySchema>;

// ── 按人送签进度（部分送签）──────────────────────────────────────────────
// 乘客级送签进度只有三档（PENDING/IN_PROGRESS/CONFIRMED），与签证台任务状态逐字对齐。
export const updateVisaPassengerStatusBodySchema = z.object({
  status: z.nativeEnum(VisaSubmissionStatus),
});
export type UpdateVisaPassengerStatusBody = z.infer<typeof updateVisaPassengerStatusBodySchema>;

// 批量按人标记：一次「全选订单」可能带出数百乘客，上限放宽到 500（前端另有分批保护）。
export const batchVisaPassengerStatusBodySchema = z.object({
  passengerIds: z.array(z.string().min(1)).min(1).max(500),
  toStatus: z.nativeEnum(VisaSubmissionStatus),
});
export type BatchVisaPassengerStatusBody = z.infer<typeof batchVisaPassengerStatusBodySchema>;
