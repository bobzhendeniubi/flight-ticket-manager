import { z } from 'zod';
import { FulfillmentStatus, FulfillmentType, VisaIssuanceMethod } from '@prisma/client';

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
   */
  departureDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '出发日期需为 YYYY-MM-DD')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListFulfillmentQuery = z.infer<typeof listFulfillmentQuerySchema>;

export const updateFulfillmentBodySchema = z.object({
  status: z.nativeEnum(FulfillmentStatus).optional(),
  // 多态 data 字段（视 type 而定）
  data: z.record(z.unknown()).optional(),
  notes: z.string().max(1000).optional(),
  assigneeUserId: z.string().optional().nullable(),
  failureReason: z.string().max(500).optional(),
});
export type UpdateFulfillmentBody = z.infer<typeof updateFulfillmentBodySchema>;

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
