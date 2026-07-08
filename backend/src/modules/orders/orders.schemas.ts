import { z } from 'zod';
import {
  CabinClass,
  DocumentType,
  Gender,
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
  VisaRequirement,
} from '@prisma/client';

// 团队议价结算价上限（CNY/人）。防误输天价；正常机票远低于此。
export const SETTLEMENT_PRICE_CAP_CNY = 100_000;

// 售后费用（改期费/换人费）上限（CNY）。防误输天价；正常售后费远低于此。
export const POST_SALE_FEE_CAP_CNY = 100_000;

// ── 录单调价/加项（ADMIN/STAFF 录单专用）──────────────────────────────────
// 业务场景：录单时有优惠 / 行程变更 / 升舱 / 升级酒店 / 签证改多签等需要在系统权威价上
// 手工加减金额。此处只承载「一笔调整」的金额 + 原因；不放开裸手填整单价（服务端权威定价
// 仍是安全底线）。金额（CNY，整数）可正（加钱）可负（减价/优惠），0 无意义 → 拒绝。
export const PRICE_ADJUSTMENT_CAP_CNY = 100_000;

// 调整原因下拉（枚举 + 其它自由文本）。label 供服务端拼调整行描述用（前后端各存一份，避免耦合）。
export const PRICE_ADJUSTMENT_REASON = [
  'DISCOUNT', // 优惠
  'CHANGE', // 变更
  'UPGRADE_CABIN', // 升舱
  'UPGRADE_HOTEL', // 升级酒店
  'VISA_MULTI', // 签证改多签
  'OTHER', // 其它（配合 reasonText）
] as const;
export type PriceAdjustmentReason = (typeof PRICE_ADJUSTMENT_REASON)[number];

export const PRICE_ADJUSTMENT_REASON_LABEL: Record<PriceAdjustmentReason, string> = {
  DISCOUNT: '优惠',
  CHANGE: '变更',
  UPGRADE_CABIN: '升舱',
  UPGRADE_HOTEL: '升级酒店',
  VISA_MULTI: '签证改多签',
  OTHER: '其它',
};

export const priceAdjustmentSchema = z
  .object({
    // 可正（加钱）可负（减价），整数 CNY；0 无意义（不调整就别传该字段）。
    amountCny: z
      .number()
      .int('调整金额必须为整数（CNY）')
      .refine((v) => v !== 0, { message: '调整金额不能为 0（不调整请勿传该字段）' })
      .refine((v) => Math.abs(v) <= PRICE_ADJUSTMENT_CAP_CNY, {
        message: `调整金额超出上限（±${PRICE_ADJUSTMENT_CAP_CNY}）`,
      }),
    reasonCode: z.enum(PRICE_ADJUSTMENT_REASON),
    reasonText: z.string().max(200).optional(),
  })
  // 「其它」必须补一句文本，避免出现无从追溯的匿名调价。
  .refine((v) => v.reasonCode !== 'OTHER' || Boolean(v.reasonText?.trim()), {
    message: '选择「其它」时必须填写调整原因说明',
    path: ['reasonText'],
  });
export type PriceAdjustmentInput = z.infer<typeof priceAdjustmentSchema>;

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
  chineseName: z.string().max(120).optional(),                                  // 中文姓名
  passportIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),       // 护照签发日期
  passportIssueCountry: z.string().length(2).optional(),
  passportIssuePlace: z.string().max(120).optional(),                          // 护照签发地点（城市/机关文本，OCR 或手填，选填）
  passportExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  // 签证
  visaNumber: z.string().max(40).optional(),
  visaType: z.string().max(40).optional(),
  visaIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  visaEffectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),       // 签证生效日期
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
  // 护照图 data-URL；3MB 上限让单张超大图快速失败（清晰报错，而非整请求 413 黑盒）
  passportPhotoUrl: z.string().url().max(3_000_000, '护照图过大，请压缩后重试').optional(),
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
  // 套餐折扣关联：该机票腿属于哪个套餐（前台套餐下单时打的标）。
  // 后端据此把该腿按套餐 discountPct 打折（不信前端折扣值，从 DB 读 bundle.discountPct）。
  bundleId: z.string().min(1).optional(),
});

export const hotelItemSchema = baseItemSchema.extend({
  kind: z.literal('HOTEL'),
  hotelRoomTypeId: z.string().min(1).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unitPrice: z.number().nonnegative(),
  // 计费房间数（支持 0.5 间）。缺省 → 按房型容量自动推算 roomsNeeded（旧行为）。
  roomsBilled: z.number().multipleOf(0.5).min(0.5).max(50).optional(),
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
  // 自备签证：出行人自行办妥签证，套餐加价里减去该套餐配置的自备签证减免（selfVisaDeductCny）。
  selfProvidedVisa: z.boolean().optional(),
  // 计费房间数（支持 0.5 间）。缺省 → 按房型容量自动推算 roomsNeeded（旧行为）。
  roomsBilled: z.number().multipleOf(0.5).min(0.5).max(50).optional(),
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
  // 联系人默认=录入人，电话选填：登录用户下单时缺省由后端用登录账号兜底（见 createOrder）。
  // 游客下单仍须通过 guestContact 提供联系人（路由层断言），与此处放宽无关。
  contactName: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(120).optional()),
  contactPhone: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(5).max(40).optional()),
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
  // 团队议价结算价（CNY，每位出行人）覆盖机票动态价。仅内部调用方（batchCreateOrders）
  // 在路由层完成 ADMIN/STAFF 鉴权后注入；公开下单端点不暴露此字段（createOrderBodySchema.parse
  // 会接受但路由 POST / 永不设置它）。设置时仅改 FLIGHT 行价格，扣座 quantity/班次/舱位不变。
  flightSettlementPriceCny: z
    .number()
    .min(0)
    .max(SETTLEMENT_PRICE_CAP_CNY)
    .optional(),
  // 录单调价/加项（仅 ADMIN/STAFF 录单生效）。服务端按认证身份判权限：公开散客/客户/代理
  // 携带此字段一律 400（见 createOrder）。落一条独立 OrderItem 计入 total，并写审计。
  priceAdjustment: priceAdjustmentSchema.optional(),
  // 允许重复乘客强录（仅 ADMIN/STAFF 后台录入生效）。客人重复订票且已付款场景：
  // 同班次同证件号本会被拦，运营确认后带此 flag 放行，服务端写审计 + 订单备注留痕。
  // 服务端按认证身份判权限：散客/AGENT 携带此字段无效，照旧拦（见 createOrder）。
  allowDuplicatePassengers: z.boolean().optional(),
});
export type CreateOrderBody = z.infer<typeof createOrderBodySchema>;

// ── 录单前试算（quote，只算不落库；ADMIN/STAFF）───────────────────────────
// body 为 createOrder items 子集：填完产品/人数即可拿到「系统权威价」，供录单页展示。
// 复用 priceAndValidateItems 的权威定价逻辑，绝不写库、绝不扣座。
export const quoteOrderBodySchema = z.object({
  items: z.array(orderItemInputSchema).min(1).max(20),
});
export type QuoteOrderBody = z.infer<typeof quoteOrderBodySchema>;

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
  // 签证办理状态筛选 — 与列表「签证」列徽标同源（订单 VISA 行的 VISA_APPLICATION 履约任务状态）。
  //   signed   = 已签证：订单含 VISA 行且其签证办理任务已确认(CONFIRMED)
  //   unsigned = 未签证：订单含 VISA 行但签证办理任务尚未确认（待处理/处理中/已取消/失败或无任务）
  // 无 VISA 行的订单（列表签证列显示「—」）两个值都不命中，与徽标保持一致、不引入第三口径。
  // 注：这是履约进度口径，区别于订单录单字段 Order.visaStatus（VisaRequirement 枚举）。
  visaFulfillmentStatus: z.enum(['signed', 'unsigned']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// ── 勾选导出：orderIds ───────────────────────────────────────────────────
// 「只导出勾选的订单」——列表勾选后把选中订单 id 透传给导出。
// 支持逗号分隔（?orderIds=a,b,c）或重复参数（?orderIds=a&orderIds=b），跟随现有 query 风格。
// 规整为去重后的非空字符串数组；给上限防滥用（一次导出体量可控）。
export const MAX_EXPORT_ORDER_IDS = 500;
export const orderIdsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const raw = Array.isArray(v) ? v : v.split(',');
    const ids = Array.from(new Set(raw.map((s) => s.trim()).filter(Boolean)));
    return ids.length > 0 ? ids : undefined;
  })
  .refine((ids) => ids === undefined || ids.length <= MAX_EXPORT_ORDER_IDS, {
    message: `一次最多导出 ${MAX_EXPORT_ORDER_IDS} 条勾选订单`,
  });

// ── 三模板筛选导出（全岗可用 / 票务专用 / 签证专用）────────────────────────
// 与 listOrders 共用同一组筛选字段（status/agentId/kind/search/from/to/
// travelFrom/travelTo/flightNumber/passengerName/invoiceStatus），外加 template。
// 另可选 orderIds：给了就「只导勾选的这些订单」，忽略上述筛选（见 buildOrderFilterWhere）。
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
    visaFulfillmentStatus: true,
  })
  .extend({
    template: z.enum(['full', 'ticketing', 'visa']),
    // 精确按班次（整班·全岗导出用）；优先于 travelFrom/travelTo，只导该班次订单。
    scheduleId: z.string().min(1).optional(),
    // 勾选导出：给了就以这批 id 为准（忽略其余筛选），无则按上面的筛选条件。
    orderIds: orderIdsQuerySchema,
  });
export type ExportTemplatesQuery = z.infer<typeof exportTemplatesQuerySchema>;

// ── 分房表导出（成都格式：按入住日期分 sheet）────────────────────────────
export const exportRoomAllocationQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
  // 按出发日口径：选出该日出发的订单，导出其全部入住晚（与 from/to 互斥，给了它就优先）。
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD').optional(),
});
export type ExportRoomAllocationQuery = z.infer<typeof exportRoomAllocationQuerySchema>;

// ── 签证资料整日打包（zip：合并签证名单 xlsx + 全部护照图）─────────────────
// 按出发日选订单（与分房表 departDate 同口径），一次导出该日所有订单的签证资料。
export const visaBundleQuerySchema = z.object({
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD'),
});
export type VisaBundleQuery = z.infer<typeof visaBundleQuerySchema>;

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

// ── B5: 批量建单 productType 枚举 ─────────────────────────────────────────────
// 必须在 batchCreateOrdersBodySchema 之前声明（const 不提升；下方对象字段直接引用）。
export const batchProductTypeSchema = z
  .enum(['FLIGHT_ONEWAY', 'FLIGHT_ROUNDTRIP', 'BUNDLE'])
  .default('FLIGHT_ONEWAY');
export type BatchProductType = z.infer<typeof batchProductTypeSchema>;

export const batchCreateOrdersBodySchema = z
  .object({
    // ── 产品类型（B5 新增）──────────────────────────────────────────────────────
    // FLIGHT_ONEWAY  : outboundScheduleId + cabin（单程，每人 1 条 FLIGHT 行）
    // FLIGHT_ROUNDTRIP: outboundScheduleId + returnScheduleId + cabin（往返，每人 2 条 FLIGHT 行）
    // BUNDLE          : bundleId（套餐，每人 1 张套餐订单，含 HOTEL 项）
    // 向后兼容：旧调用只传 flightScheduleId 时等价于 FLIGHT_ONEWAY。
    productType: batchProductTypeSchema,

    // ── FLIGHT_ONEWAY / FLIGHT_ROUNDTRIP ──────────────────────────────────────
    // 兼容旧字段名：flightScheduleId → 等价于 outboundScheduleId
    flightScheduleId: z.string().optional(), // 旧路径（向后兼容）
    outboundScheduleId: z.string().optional(),
    returnScheduleId: z.string().optional(), // 仅 FLIGHT_ROUNDTRIP 必填
    flightCabin: z.nativeEnum(CabinClass).optional(),

    // ── BUNDLE ─────────────────────────────────────────────────────────────────
    bundleId: z.string().optional(),
    // 套餐入住晚数 / 占座等（透传给 bundleItemSchema add-on 字段）
    bundleNights: z.number().int().min(1).max(30).optional(),
    bundleSingleCount: z.number().int().min(0).max(20).optional(),
    bundleBusinessCount: z.number().int().min(0).max(20).optional(),

    // ── 公共字段 ────────────────────────────────────────────────────────────────
    description: z.string().min(1).max(200), // 航段/套餐描述（每张子单写入 item.description）
    // 录入人即登录账号 —— 后端用登录用户名兜底联系人，前台不再要求填写。
    contactName: z.string().min(1).max(120).optional(),
    contactPhone: z.string().min(5).max(40).optional(),
    contactEmail: z.string().email().optional(),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
    notes: z.string().max(500).optional(),
    // 签证状态 + 结构化备注四栏（整批共用，写入每张子单）
    ...orderStructuredNotesShape,
    // 运营批量录单时整批归属的代理（仅 ADMIN/STAFF 生效）
    agentId: z.string().optional(),
    // 团队议价结算价（CNY，每位出行人）。仅 ADMIN/STAFF 生效（路由层断言）。
    // 仅对 FLIGHT 行生效（BUNDLE 套餐走 bundleItemSchema 的 server-priced 逻辑）。
    settlementPriceCny: z
      .number()
      .min(0, '结算价不能为负')
      .max(SETTLEMENT_PRICE_CAP_CNY, `结算价超出上限（${SETTLEMENT_PRICE_CAP_CNY}）`)
      .optional(),
    // 团期备注（写入每张子单 notes + noteSpecial）
    groupNote: z.string().max(500).optional(),
    // 允许重复乘客强录（仅 ADMIN/STAFF 生效；透传给每张子单的 createOrder）。
    // 客人重复订票且已付款场景：同班次同证件号本会整批拒，运营确认后带此 flag 放行。
    allowDuplicatePassengers: z.boolean().optional(),
    // 每位 → 一单。note 为该乘客个别备注（选填），与整批备注合并写入本人订单 notes。
    passengers: z
      .array(passengerInputSchema.extend({ note: z.string().max(500).optional() }))
      .min(1)
      .max(100),
  })
  .superRefine((val, ctx) => {
    const pt = val.productType;
    const outbound = val.outboundScheduleId ?? val.flightScheduleId;
    if (pt === 'FLIGHT_ONEWAY' || pt === 'FLIGHT_ROUNDTRIP') {
      if (!outbound) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FLIGHT 类型必须提供 outboundScheduleId（或 flightScheduleId）',
          path: ['outboundScheduleId'],
        });
      }
      if (!val.flightCabin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FLIGHT 类型必须提供 flightCabin',
          path: ['flightCabin'],
        });
      }
      if (pt === 'FLIGHT_ROUNDTRIP' && !val.returnScheduleId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'FLIGHT_ROUNDTRIP 必须提供 returnScheduleId',
          path: ['returnScheduleId'],
        });
      }
    }
    if (pt === 'BUNDLE') {
      if (!val.bundleId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'BUNDLE 类型必须提供 bundleId',
          path: ['bundleId'],
        });
      }
    }
  });
export type BatchCreateOrdersBody = z.infer<typeof batchCreateOrdersBodySchema>;

// ── 售后改单：改期（reschedule）─────────────────────────────────────────────
// PATCH /orders/:id/reschedule（ADMIN/STAFF）：把某条 FLIGHT 行就地改到新班次/新舱位 + 可选改期费。
const postSaleFeeSchema = z
  .number()
  .int('费用必须为整数（CNY）')
  .min(0, '费用不能为负')
  .max(POST_SALE_FEE_CAP_CNY, `费用超出上限（${POST_SALE_FEE_CAP_CNY}）`)
  .optional();

export const rescheduleOrderBodySchema = z.object({
  orderItemId: z.string().min(1, 'orderItemId 必填'),
  newScheduleId: z.string().min(1, 'newScheduleId 必填'),
  newCabin: z.nativeEnum(CabinClass).optional(), // 缺省沿用原舱位
  feeCny: postSaleFeeSchema, // 改期费（CNY，整数；0/缺省=不收）
  feeLabel: z.string().max(120).optional(), // 自定义费用名（缺省"改期费"）
  note: z.string().max(500).optional(),
});
export type RescheduleOrderBody = z.infer<typeof rescheduleOrderBodySchema>;

// ── 售后改单：换人（passenger swap）─────────────────────────────────────────
// PATCH /orders/:id/passengers/:passengerId（ADMIN/STAFF）：就地改出行人身份 + 可选重置开票/签证 + 换人费。
export const swapPassengerBodySchema = z
  .object({
    lastName: z.string().max(120).optional(),
    firstName: z.string().max(120).optional(),
    fullName: z.string().max(120).optional(),
    // 中文姓名（护照扩展字段；下单时已支持，此处补录/编辑用同一约束）
    chineseName: z.string().max(120).optional(),
    documentNumber: z.string().max(60).optional(),
    dateOfBirth: z.string().optional(), // ISO 日期字符串
    gender: z.nativeEnum(Gender).optional(),
    nationality: z.string().max(60).optional(),
    resetInvoice: z.boolean().optional(), // → 开票状态回 NONE
    resetVisa: z.boolean().optional(), // → 该订单 VISA 履约任务回 PENDING
    feeCny: postSaleFeeSchema, // 换人费（CNY，整数；0/缺省=不收）
    feeLabel: z.string().max(120).optional(), // 自定义费用名（缺省"换人费"）
    note: z.string().max(500).optional(),
  })
  // 至少改一项身份字段，或触发一次重置/收费 —— 防空 PATCH
  .refine(
    (b) =>
      b.lastName !== undefined ||
      b.firstName !== undefined ||
      b.fullName !== undefined ||
      b.chineseName !== undefined ||
      b.documentNumber !== undefined ||
      b.dateOfBirth !== undefined ||
      b.gender !== undefined ||
      b.nationality !== undefined ||
      b.resetInvoice === true ||
      b.resetVisa === true ||
      (b.feeCny ?? 0) > 0,
    { message: '换人请求需至少包含一项身份变更 / 重置 / 费用' },
  );
export type SwapPassengerBody = z.infer<typeof swapPassengerBodySchema>;

// ── B4: 改结算价（ADMIN/STAFF）────────────────────────────────────────────────
// PATCH /orders/:id/items/:itemId/settlement-price
// 仅允许 kind=FLIGHT；事务内重算 order.subtotal/total；
// 不走 adjustmentCny（那是售后费用，这是基础价订正）。
export const updateItemSettlementPriceBodySchema = z.object({
  unitPriceCny: z
    .number()
    .positive('结算价必须大于 0')
    .max(SETTLEMENT_PRICE_CAP_CNY, `结算价超出上限（${SETTLEMENT_PRICE_CAP_CNY}）`),
  reason: z.string().max(500).optional(),
});
export type UpdateItemSettlementPriceBody = z.infer<typeof updateItemSettlementPriceBodySchema>;

// ── 售后改单：换酒店（hotel swap）───────────────────────────────────────────
// PATCH /orders/:id/items/:itemId/hotel（ADMIN/STAFF）：把某条 HOTEL 行（或已盖章酒店的
// BUNDLE 行）就地换到另一个房型/酒店。定价哲学（owner 批准 A+B）：价格默认冻结——绝不按新
// 房型的 basePrice 重算 unitPrice/amount；feeCny 是可选的人工调整（可正可负，与改期费/换人费
// 同一 adjustmentCny 机制）。0 没有意义（"不调整"应留空不传该字段），故显式拒绝。
const hotelSwapFeeSchema = z
  .number()
  .int('金额必须为整数（CNY）')
  .refine((v) => v !== 0, { message: '金额不能为 0（不调整价格请留空，不要传 0）' })
  .refine((v) => Math.abs(v) <= POST_SALE_FEE_CAP_CNY, {
    message: `金额超出上限（±${POST_SALE_FEE_CAP_CNY}）`,
  })
  .optional();

export const swapItemHotelBodySchema = z.object({
  newHotelRoomTypeId: z.string().min(1, 'newHotelRoomTypeId 必填'),
  feeCny: hotelSwapFeeSchema, // 换酒店差价（CNY，整数，可负；不填/不传=不调整价格）
  feeLabel: z.string().max(60).optional(), // 自定义费用名（缺省"换酒店差价"）
  note: z.string().max(200).optional(),
});
export type SwapItemHotelBody = z.infer<typeof swapItemHotelBodySchema>;

