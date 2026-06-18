import { z } from 'zod';
import {
  CabinClass,
  DocumentType,
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
  VisaRequirement,
} from '@prisma/client';

// ── 订单级签证状态 + 结构化备注四栏（录单/编辑共用）─────────────────────────
// 全部 optional：老客户端不传则字段留空，与旧行为一致。每栏限 ~300 字。
const STRUCTURED_NOTE_MAX = 300;
export const orderStructuredNotesShape = {
  visaStatus: z.nativeEnum(VisaRequirement).optional(),
  noteHotel: z.string().max(STRUCTURED_NOTE_MAX).optional(),
  noteVisa: z.string().max(STRUCTURED_NOTE_MAX).optional(),
  notePayment: z.string().max(STRUCTURED_NOTE_MAX).optional(),
  noteSpecial: z.string().max(STRUCTURED_NOTE_MAX).optional(),
} as const;

// ── 下单 ─────────────────────────────────────────────────────────────────
// 乘客信息 — 注：所有新字段都是 optional，老客户端可继续工作
export const passengerInputSchema = z.object({
  fullName: z.string().min(1).max(120),
  // 航司 PNR 拆分姓/名（fullName 仍必填做兼容）
  lastName: z.string().max(60).optional(),
  firstName: z.string().max(80).optional(),
  title: z.enum(['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'DR']).optional(),
  gender: z.enum(['M', 'F', 'X']).optional(),
  documentType: z.nativeEnum(DocumentType).default('PASSPORT'),
  documentNumber: z.string().min(3).max(40),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  placeOfBirth: z.string().max(60).optional(),
  nationality: z.string().length(2).default('CN'),
  passengerType: z.nativeEnum(PassengerType).default('ADULT'),

  // 护照扩展
  passportIssueCountry: z.string().length(2).optional(),
  passportExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  // 签证
  visaNumber: z.string().max(40).optional(),
  visaType: z.string().max(40).optional(),
  visaIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visaExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visaPlaceOfIssue: z.string().max(60).optional(),
  visaCountryOfApplication: z.string().length(2).optional(),

  // 地址（航司提交格式）
  addressType: z.enum(['BUSINESS', 'RESIDENTIAL']).optional(),
  addressDetails: z.string().max(200).optional(),
  addressCity: z.string().max(60).optional(),
  addressState: z.string().max(60).optional(),
  addressCountry: z.string().length(2).optional(),
  addressZip: z.string().max(20).optional(),

  mealPreference: z.string().max(40).optional(),
  needsWheelchair: z.boolean().optional(),
  needsInfantBassinet: z.boolean().optional(),
  bedPref: z.enum(['SINGLE', 'DOUBLE', 'TWIN', 'SHARE_OK']).optional(),
  passportPhotoUrl: z.string().url().optional(),
});
export type PassengerInput = z.infer<typeof passengerInputSchema>;

// 订单行（OrderItem）— 前端用 kind 区分是机票/酒店/接送/签证
// FLIGHT 必须带 flightScheduleId + flightCabin + quantity；后端会重算价格并校验余票
// HOTEL/TRANSFER/VISA 暂时"信任前端价格"（产品 CRUD P1 补齐后改为后端查）
const baseItemSchema = z.object({
  description: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(20),
  metadata: z.record(z.unknown()).optional(),
});

export const flightItemSchema = baseItemSchema.extend({
  kind: z.literal('FLIGHT'),
  flightScheduleId: z.string().min(1),
  flightCabin: z.nativeEnum(CabinClass),
});

export const hotelItemSchema = baseItemSchema.extend({
  kind: z.literal('HOTEL'),
  hotelRoomTypeId: z.string().min(1).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unitPrice: z.number().nonnegative(),
});

export const transferItemSchema = baseItemSchema.extend({
  kind: z.literal('TRANSFER'),
  transferId: z.string().min(1).optional(),
  unitPrice: z.number().nonnegative(),
});

export const visaItemSchema = baseItemSchema.extend({
  kind: z.literal('VISA'),
  visaId: z.string().min(1).optional(),
  unitPrice: z.number().nonnegative(),
});

export const bundleItemSchema = baseItemSchema.extend({
  kind: z.literal('BUNDLE'),
  bundleId: z.string().min(1),
  unitPrice: z.number().nonnegative(),
  // 可选升级 add-on（server-priced，整数份数；缺省 0 = 无升级，价格与旧版完全一致）：
  //   singleCount   = 选「一个人住酒店（单人入住）」的人数 → 每人每晚加 singleSupplementCnyPerNight
  //   businessCount = 选「升舱商务」的人数 → 每人每航段加 businessUpgradeCnyPerLeg（占用真实商务舱库存）
  singleCount: z.number().int().min(0).max(20).optional(),
  businessCount: z.number().int().min(0).max(20).optional(),
  // 占座模型（业务需求）：区分成人 / 占座儿童 / 不占座婴儿（都需护照，均为出行人）：
  //   adultCount  = 成人数（占 1 座、计入拼房）
  //   childCount  = 占座儿童数（占 1 座、计入拼房；机票按成人价减 childSeatDiscountCnyPerPerson）
  //   infantCount = 不占座婴儿数（不占座、不占房；机票收 infantPriceCny/人）
  // 向后兼容：三者全缺省时，旧 pax（metadata.pax 或行 quantity）视为 adultCount，child/infant=0，定价与旧版完全一致。
  adultCount: z.number().int().min(0).max(20).optional(),
  childCount: z.number().int().min(0).max(20).optional(),
  infantCount: z.number().int().min(0).max(20).optional(),
});

// BUNDLE 行 metadata 里的出行信息（sales-web 购物车带过来，用于推导酒店入住日期）。
// 全部 optional 且逐字段 .catch(undefined) 降级 —— metadata 异常绝不阻断套餐下单。
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const bundleItemMetadataSchema = z
  .object({
    goDate: dateOnlySchema.optional().catch(undefined),
    returnDate: dateOnlySchema.optional().catch(undefined),
    pax: z.number().int().min(1).max(99).optional().catch(undefined),
    rooms: z.number().int().min(1).max(99).optional().catch(undefined),
    // 占座模型计数（前台带过来，用于出行人数校验）。逐字段降级，异常绝不阻断下单。
    adultCount: z.number().int().min(0).max(99).optional().catch(undefined),
    childCount: z.number().int().min(0).max(99).optional().catch(undefined),
    infantCount: z.number().int().min(0).max(99).optional().catch(undefined),
  })
  .catch({});
export type BundleItemMetadata = z.infer<typeof bundleItemMetadataSchema>;

export const orderItemInputSchema = z.discriminatedUnion('kind', [
  flightItemSchema,
  hotelItemSchema,
  transferItemSchema,
  visaItemSchema,
  bundleItemSchema,
]);
export type OrderItemInput = z.infer<typeof orderItemInputSchema>;

// 游客下单（免登录）联系人 —— 仅在请求未带有效登录态时必填（路由层断言）。
// 登录用户下单时忽略此字段（沿用 userId 绑定）。
export const guestContactSchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(5).max(40),
  email: z.string().email().optional(),
});
export type GuestContact = z.infer<typeof guestContactSchema>;

export const createOrderBodySchema = z.object({
  contactName: z.string().min(1).max(120),
  contactPhone: z.string().min(5).max(40),
  contactEmail: z.string().email().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  items: z.array(orderItemInputSchema).min(1).max(20),
  passengers: z.array(passengerInputSchema).min(1).max(20),
  notes: z.string().max(500).optional(),
  // 签证状态 + 结构化备注四栏（可选；兼容旧客户端）
  ...orderStructuredNotesShape,
  idempotencyKey: z.string().min(8).max(128).optional(),
  // 游客下单联系人（免登录时必填；登录用户忽略）
  guestContact: guestContactSchema.optional(),
  // 运营代下单时归属的代理（仅 ADMIN/STAFF 录单时生效）。
  // AGENT 自助下单忽略此字段（只能归属自己）；游客忽略。
  agentId: z.string().optional(),
});
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

// ── 列表 / 详情 ─────────────────────────────────────────────────────────
export const listOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  agentId: z.string().optional(),
  kind: z.nativeEnum(OrderItemKind).optional(),
  search: z.string().max(120).optional(), // 订单号/姓名/电话
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // 下单日期起
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),    // 下单日期止
  // 按出行日期筛选（票务/签证流程按日期批量处理，反馈高优需求）
  travelFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  travelTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // 接单状态过滤
  claimedById: z.string().optional(),   // 指定 ops
  unclaimedOnly: z.coerce.boolean().optional(),
  // ops 确认的三个筛选（航班号 / 乘客姓名 / 开票状态）
  flightNumber: z.string().max(20).optional(),    // 订单含该航班号的 FLIGHT 行（不区分大小写）
  passengerName: z.string().max(120).optional(),  // 乘客姓名模糊匹配
  invoiceStatus: z.nativeEnum(InvoiceStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ── 三模板筛选导出（全岗可用 / 票务专用 / 签证专用）────────────────────────
// 与 listOrders 共用同一组筛选字段（status/agentId/kind/search/from/to/
// travelFrom/travelTo/flightNumber/passengerName/invoiceStatus），外加 template。
export const exportTemplatesQuerySchema = listOrdersQuerySchema
  .pick({
    status: true,
    agentId: true,
    kind: true,
    search: true,
    from: true,
    to: true,
    travelFrom: true,
    travelTo: true,
    flightNumber: true,
    passengerName: true,
    invoiceStatus: true,
  })
  .extend({
    template: z.enum(['full', 'ticketing', 'visa']),
  });
export type ExportTemplatesQuery = z.infer<typeof exportTemplatesQuerySchema>;

// ── 分房表导出（成都格式：按入住日期分 sheet）────────────────────────────
export const exportRoomAllocationQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
});
export type ExportRoomAllocationQuery = z.infer<typeof exportRoomAllocationQuerySchema>;

// ── 状态流转 ─────────────────────────────────────────────────────────────
export const updateStatusBodySchema = z.object({
  toStatus: z.nativeEnum(OrderStatus),
  reason: z.string().max(500).optional(),
  // ADMIN 强制覆盖：跳过 ALLOWED_TRANSITIONS 检查（仅 ADMIN 生效；STAFF/CUSTOMER 忽略）
  force: z.boolean().optional(),
});
export type UpdateStatusBody = z.infer<typeof updateStatusBodySchema>;

// ── 批量状态流转（ADMIN/STAFF）──────────────────────────────────────────
export const batchUpdateStatusBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  toStatus: z.nativeEnum(OrderStatus),
  reason: z.string().max(500).optional(),
  force: z.boolean().optional(),
});
export type BatchUpdateStatusBody = z.infer<typeof batchUpdateStatusBodySchema>;

// ── 批量散客建单（后台）─────────────────────────────────────────────────────
// 选一个航班班次 + 舱位 + 共享联系人 → 名单里每位乘客各成一单（FLIGHT × 1）
// ── 公开订单查询（免登录，A4）──────────────────────────────────────────────
// orderNumber + (phone 或 email) 任一匹配；至少给一个联系方式。
export const publicOrderLookupQuerySchema = z
  .object({
    orderNumber: z.string().min(3).max(40),
    phone: z.string().min(3).max(40).optional(),
    email: z.string().email().optional(),
  })
  .refine((q) => Boolean(q.phone) || Boolean(q.email), {
    message: '需提供手机号或邮箱',
  });
export type PublicOrderLookupQuery = z.infer<typeof publicOrderLookupQuerySchema>;

export const batchCreateOrdersBodySchema = z.object({
  flightScheduleId: z.string().min(1),
  flightCabin: z.nativeEnum(CabinClass),
  description: z.string().min(1).max(200), // 航段描述，如 "QH9589 澳门→岘港 2026-06-01 经济舱"
  // 录入人即登录账号 —— 后端用登录用户名兜底联系人，前台不再要求填写。
  // 仍可选传（兼容旧前端/特殊场景）；不传则 service 用登录账号 displayName 落 contactName。
  contactName: z.string().min(1).max(120).optional(),
  contactPhone: z.string().min(5).max(40).optional(),
  contactEmail: z.string().email().optional(),
  paymentMethod: z.nativeEnum(PaymentMethod).optional(),
  notes: z.string().max(500).optional(),
  // 签证状态 + 结构化备注四栏（整批共用，写入每张子单）
  ...orderStructuredNotesShape,
  // 运营批量录单时整批归属的代理（仅 ADMIN/STAFF 生效，校验同单条下单）。
  agentId: z.string().optional(),
  passengers: z.array(passengerInputSchema).min(1).max(100), // 每位 → 一单
});
export type BatchCreateOrdersBody = z.infer<typeof batchCreateOrdersBodySchema>;
