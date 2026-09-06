/**
 * 改单申请 · 入参校验。
 *
 * kind 决定 payload 形状，但**顶层不做判别联合**：HOTEL / CABIN 不支持批量、
 * 签证状态不许改成「已签证」这类闸，都要吐一句运营看得懂的话，走 zod 判别联合只会
 * 变成「无效的判别值」。所以顶层只认 kind + 一坨 payload，具体形状在 service 里
 * 按 kind 取对应 schema 再 parse，错误文案由我们自己定。
 */
import { OrderChangeKind, OrderChangeRequestStatus, VisaRequirement } from '@prisma/client';
import { z } from 'zod';

/** 申请说明：提交人填的一句话。 */
const noteSchema = z.string().max(200, '申请说明最多 200 字').optional();

// ── 各 kind 的提交入参（「原值」由服务端在提交那一刻自己快照，客户端传不进来）──

/** 改班次：单张单按行定位；批量按航段（去程/回程）逐单解析成对应的机票行。 */
export const flightChangeSubmitSchema = z
  .object({
    itemId: z.string().min(1).optional(),
    leg: z.enum(['OUTBOUND', 'RETURN']).optional(),
    newScheduleId: z.string().min(1, 'newScheduleId 必填'),
  })
  .refine((v) => Boolean(v.itemId) || Boolean(v.leg), {
    message: '请指定要改的航段（itemId 或 leg 二选一）',
  });
export type FlightChangeSubmit = z.infer<typeof flightChangeSubmitSchema>;

/** 订单级签证状态：只认「需要 / 电子签 / 不需要」三态，已签证的闸在 service 里单独报错。 */
export const visaChangeSubmitSchema = z.object({
  toVisaStatus: z.nativeEnum(VisaRequirement),
});
export type VisaChangeSubmit = z.infer<typeof visaChangeSubmitSchema>;

/** 换酒店：把某条住宿行换到另一个酒店房型（差价恒 0）。 */
export const hotelChangeSubmitSchema = z.object({
  itemId: z.string().min(1, 'itemId 必填'),
  toHotelRoomTypeId: z.string().min(1, 'toHotelRoomTypeId 必填'),
});
export type HotelChangeSubmit = z.infer<typeof hotelChangeSubmitSchema>;

/** 升舱：目标舱位恒为商务舱，差价由服务端算，客户端连金额字段都没有。 */
export const cabinChangeSubmitSchema = z.object({
  itemId: z.string().min(1, 'itemId 必填'),
  toCabin: z.literal('BUSINESS').optional(),
});
export type CabinChangeSubmit = z.infer<typeof cabinChangeSubmitSchema>;

// ── 扩展三类（feature flag AGENT_CHANGE_REQUEST_EXTRA_KINDS，默认关）────────────
// 共同口径：申请里**一个金额字段都不收**。三个动作各自的钱都由服务端权威算
//（拆单按每人份额、取消航段按取消政策、改自备签按建单快照费率），
// 让提交方填数就等于开了一条绕过定价的口子。

/** 拆单：要拆出去的乘客（至少 1 位，且不能是全员 —— 拆单通道自己会拒）。 */
export const splitChangeSubmitSchema = z.object({
  passengerIds: z.array(z.string().min(1)).min(1, '至少选择 1 位乘客').max(99),
  /** 落到拆单动作自己的备注上（进 SPLIT_ORDER 审计），与申请说明 note 是两件事。 */
  note: z.string().max(200, '备注最多 200 字').optional(),
});
export type SplitChangeSubmit = z.infer<typeof splitChangeSubmitSchema>;

/** 取消单程航段：只选去程/回程；退多少一律按取消政策，申请里给不出金额字段。 */
export const cancelLegChangeSubmitSchema = z.object({
  leg: z.enum(['OUTBOUND', 'RETURN']),
  note: z.string().max(200, '备注最多 200 字').optional(),
});
export type CancelLegChangeSubmit = z.infer<typeof cancelLegChangeSubmitSchema>;

/** 按人改自备签：哪位乘客 + 改成自备 / 不自备。确认只放行管理员与签证岗（见 service）。 */
export const visaExemptChangeSubmitSchema = z.object({
  passengerId: z.string().min(1, 'passengerId 必填'),
  visaExempt: z.boolean(),
  note: z.string().max(200, '备注最多 200 字').optional(),
});
export type VisaExemptChangeSubmit = z.infer<typeof visaExemptChangeSubmitSchema>;

/** 挂在 flag 后面的三类；提交 / 预检 / 可用类型三处都按这张表判要不要查 flag。 */
export const FLAGGED_ORDER_CHANGE_KINDS = [
  OrderChangeKind.SPLIT,
  OrderChangeKind.CANCEL_LEG,
  OrderChangeKind.VISA_EXEMPT,
] as const;

export function isFlaggedOrderChangeKind(kind: OrderChangeKind): boolean {
  return (FLAGGED_ORDER_CHANGE_KINDS as readonly OrderChangeKind[]).includes(kind);
}

// ── 路由入参 ────────────────────────────────────────────────────────────────

export const createOrderChangeRequestBodySchema = z.object({
  kind: z.nativeEnum(OrderChangeKind),
  payload: z.record(z.unknown()).default({}),
  note: noteSchema,
});
export type CreateOrderChangeRequestBody = z.infer<typeof createOrderChangeRequestBodySchema>;

/** 三类扩展的提交前预检入参（只读，不落任何东西）。 */
export const previewOrderChangeRequestBodySchema = z.object({
  kind: z.nativeEnum(OrderChangeKind),
  payload: z.record(z.unknown()).default({}),
});
export type PreviewOrderChangeRequestBody = z.infer<typeof previewOrderChangeRequestBodySchema>;

/** 一次给多张单提同一类改动；上限 200 与批量改期/批量到账同一档。 */
export const batchOrderChangeRequestBodySchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1, '至少选一张订单').max(200, '一次最多 200 张订单'),
  kind: z.nativeEnum(OrderChangeKind),
  payload: z.record(z.unknown()).default({}),
  note: noteSchema,
});
export type BatchOrderChangeRequestBody = z.infer<typeof batchOrderChangeRequestBodySchema>;

export const decideOrderChangeRequestBodySchema = z.object({
  decisionNote: z.string().max(200, '备注最多 200 字').optional(),
  // 换酒店确认专用：套餐档次与换入酒店星级不符时，换酒店通道要求写明放行原因才过
  //（字段名与录单/换酒店端点一致，前端一套表单复用）。其余 kind 传了也不起作用。
  designatedHotelStarMismatchReason: z
    .string()
    .trim()
    .min(1)
    .max(200, '放行原因最多 200 字')
    .optional(),
  // 取消单程确认专用：预检里「需要回执」的提示（最典型是该段已出票，取消后要票务撤名单/退票）
  // 的「我已知悉」。这是**点确认的运营**做的判断 —— 提申请的人看不到出票进度，也勾不了。
  // 缺省 false：有需回执的提示而没勾，取消航段通道会 400 ACKNOWLEDGEMENT_REQUIRED，绝不静默放行。
  acknowledgeWarnings: z.boolean().optional(),
});
export type DecideOrderChangeRequestBody = z.infer<typeof decideOrderChangeRequestBodySchema>;

export const batchApproveOrderChangeRequestBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1, '至少选一条申请').max(200, '一次最多 200 条申请'),
});
export type BatchApproveOrderChangeRequestBody = z.infer<
  typeof batchApproveOrderChangeRequestBodySchema
>;

export const listOrderChangeRequestsQuerySchema = z.object({
  status: z.nativeEnum(OrderChangeRequestStatus).optional(),
  kind: z.nativeEnum(OrderChangeKind).optional(),
  agentId: z.string().min(1).optional(),
  orderId: z.string().min(1).optional(),
  // 只看这个时刻之后新建的申请（ISO 时间串）：代理侧「我这批单有没有新结果」轮询用。
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type ListOrderChangeRequestsQuery = z.infer<typeof listOrderChangeRequestsQuerySchema>;
