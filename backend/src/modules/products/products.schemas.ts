import { z } from 'zod';
import { VisaEntryType, VisaIssuanceMethod } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD 且必须是真实日期（2026-02-30 之类直接拒）。*/
const dateOnlyStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`)), '无效日期');

/** [checkIn, checkOut) 的晚数；YYYY-MM-DD 按 UTC 零点解析。*/
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round(
    (Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / DAY_MS,
  );
}

// ── 酒店余量（公开端点查询）──────────────────────────────────────────────
export const MAX_STAY_NIGHTS = 30;

export const hotelAvailabilityQuerySchema = z
  .object({
    hotelRoomTypeId: z.string().min(1),
    checkIn: dateOnlyStr,
    checkOut: dateOnlyStr,
  })
  .refine((q) => q.checkIn < q.checkOut, { message: '入住日必须早于退房日' })
  .refine((q) => nightsBetween(q.checkIn, q.checkOut) <= MAX_STAY_NIGHTS, {
    message: `连住最多 ${MAX_STAY_NIGHTS} 晚`,
  });
export type HotelAvailabilityQuery = z.infer<typeof hotelAvailabilityQuerySchema>;

// ── 套餐可售日期（公开端点查询）────────────────────────────────────────────
/** 可售日期查询最长跨度（天，含两端）。*/
export const MAX_SELLABLE_RANGE_DAYS = 90;
/** 仅给了 from 时的默认跨度（天，含两端）。*/
export const DEFAULT_SELLABLE_RANGE_DAYS = 60;

/** [from, to] 的天数（含两端）；YYYY-MM-DD 按 UTC 零点解析。*/
export function daysInclusive(from: string, to: string): number {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
    ) + 1
  );
}

/** from + days → YYYY-MM-DD（UTC 零点口径）。*/
function addDaysOnly(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export const bundleSellableDatesQuerySchema = z
  .object({
    from: dateOnlyStr,
    // to 省略时 = from + (DEFAULT_SELLABLE_RANGE_DAYS - 1)（默认 60 天窗口，含两端）
    to: dateOnlyStr.optional(),
  })
  .transform((q) => ({
    from: q.from,
    to: q.to ?? addDaysOnly(q.from, DEFAULT_SELLABLE_RANGE_DAYS - 1),
  }))
  .refine((q) => q.from <= q.to, { message: '起始日不能晚于结束日' })
  .refine((q) => daysInclusive(q.from, q.to) <= MAX_SELLABLE_RANGE_DAYS, {
    message: `日期跨度最多 ${MAX_SELLABLE_RANGE_DAYS} 天`,
  });
export type BundleSellableDatesQuery = z.infer<typeof bundleSellableDatesQuerySchema>;

// ── 套餐机票参考价（后台起价换算用，ADMIN/STAFF）──────────────────────────────
/**
 * 空串 / 省略 = 该程未绑航班（后端按套餐航线兜底取最低价）；非空 = 绑定该 Flight.id。
 * query string 会把「未指定」传成 '' ，这里统一归一到 null，交给 getCheapestRoundTripEconomyCny 走航线兜底。
 */
const optionalFlightIdQuery = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

export const bundleFlightRefQuerySchema = z.object({
  outboundFlightId: optionalFlightIdQuery,
  returnFlightId: optionalFlightIdQuery,
});
export type BundleFlightRefQuery = z.infer<typeof bundleFlightRefQuerySchema>;

// ── Hotel ────────────────────────────────────────────────────────────────
export const createHotelBodySchema = z.object({
  name: z.string().min(1).max(200),
  nameEn: z.string().max(200).optional(),
  cityCode: z.string().min(2).max(10),
  area: z.string().max(100).optional(),
  address: z.string().min(1).max(500),
  starRating: z.number().int().min(1).max(5),
  basePrice: z.number().nonnegative().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  emoji: z.string().max(10).optional(),
  highlight: z.string().max(300).optional(),
  amenities: z.array(z.string().max(50)).default([]),
  photos: z.array(z.string().url()).default([]),
  isActive: z.boolean().default(true),
  roomTypes: z.array(
    z.object({
      // 编辑时回传已有房型 id → 原地更新（保留 id，避免套餐 hotelRoomTypeId 漂移失联）。
      // 新建房型不传 id。
      id: z.string().min(1).optional(),
      name: z.string().min(1).max(100),
      bedType: z.string().max(100).optional(),
      capacity: z.number().int().min(1).max(10),
      // 单间可坐几大人 / 几小孩（套餐 roomsNeeded 据此算；缺省 2大1小，与旧拼房口径一致）
      maxAdults: z.number().int().min(1).max(10).default(2),
      maxChildren: z.number().int().min(0).max(10).default(1),
      basePrice: z.number().nonnegative(),
      priceMultiplier: z.number().positive().optional(),
      // 净房价（CNY/晚，仅内部，前台不下发）— 与 finances 成本维护同一列；省略/null = 未录。
      costPriceCny: z.number().nonnegative().nullable().optional(),
    }),
  )
    // 同名房型会让 updateHotel 的 name 匹配二义（后写覆盖前写、静默丢一条）→ 直接拒绝
    .refine(
      (rts) => new Set(rts.map((rt) => rt.name)).size === rts.length,
      { message: '房型名称不能重复' },
    )
    .default([]),
});
export type CreateHotelBody = z.infer<typeof createHotelBodySchema>;
export const updateHotelBodySchema = createHotelBodySchema.partial();
export type UpdateHotelBody = z.infer<typeof updateHotelBodySchema>;

// ── Transfer ─────────────────────────────────────────────────────────────
export const createTransferBodySchema = z.object({
  name: z.string().min(1).max(200),
  vehicleType: z.string().min(1).max(100),
  capacity: z.number().int().min(1).max(30),
  originArea: z.string().min(1).max(200),
  destArea: z.string().min(1).max(200),
  basePrice: z.number().nonnegative(),
  features: z.array(z.string().max(100)).default([]),
  duration: z.string().max(50).optional(),
  emoji: z.string().max(10).optional(),
  photo: z.string().url().optional(),
  // 司机/车队结算价（CNY，仅内部，前台不下发）— 与 finances 成本维护同一列；省略/null = 未录。
  costPriceCny: z.number().nonnegative().nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateTransferBody = z.infer<typeof createTransferBodySchema>;
export const updateTransferBodySchema = createTransferBodySchema.partial();
export type UpdateTransferBody = z.infer<typeof updateTransferBodySchema>;

// ── Visa ─────────────────────────────────────────────────────────────────
export const createVisaBodySchema = z.object({
  destinationCountry: z.string().length(2),
  country: z.string().max(50).optional(),
  visaType: z.string().min(1).max(100),
  visaName: z.string().max(200).optional(),
  // 签发方式 / 入境次数（结构化分类，选填）：省略 = 不改（update）/ 未设置（create）；
  // 显式 null = 清空为未设置；与 costPriceCny 同款"真·部分更新"约定。
  issuanceMethod: z.nativeEnum(VisaIssuanceMethod).nullable().optional(),
  entryType: z.nativeEnum(VisaEntryType).nullable().optional(),
  flag: z.string().max(10).optional(),
  photo: z.string().url().optional(),
  processingDays: z.number().int().min(0).max(365),
  basePrice: z.number().nonnegative(),
  expressSurcharge: z.number().nonnegative().optional(),
  validityMonths: z.number().int().min(0).max(120).optional(),
  // 单次入境最多可停留天数（订单详情「最多可停留 X 天」展示 + 推算生效/失效日期用）
  stayDays: z.number().int().min(1).max(365).optional(),
  highlight: z.string().max(300).optional(),
  requiredDocs: z.array(z.string().max(100)).default([]),
  // 使馆/代办成本（CNY，仅内部，前台不下发）— 与 finances 成本维护同一列；省略/null = 未录。
  costPriceCny: z.number().nonnegative().nullable().optional(),
  // 签证公司/代办渠道名（财务对账用——核对某笔签证金额属于哪家供应商的账单）；
  // 仅内部，前台不下发。省略 = 不改（update）/ 未录（create）；显式 null = 清空。
  supplier: z.string().max(100).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateVisaBody = z.infer<typeof createVisaBodySchema>;
export const updateVisaBodySchema = createVisaBodySchema.partial();
export type UpdateVisaBody = z.infer<typeof updateVisaBodySchema>;

// ── Bundle ───────────────────────────────────────────────────────────────
export const bundleItemSchema = z.object({
  kind: z.enum(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA']),
  productName: z.string().min(1).max(300),
  qty: z.number().int().min(1).max(99),
  // unitPrice 仅作展示占位：HOTEL/TRANSFER/VISA 行落库前由服务端按下面的产品 id 权威取价覆盖
  // （见 products.service resolveBundleItemPrices），FLIGHT 恒为 0（出发日实时定价）。
  // 客户端传的值不会被信任写库，只用于校验通过；真正生效的价格来自关联产品。
  unitPrice: z.number().nonnegative(),
  // TRANSFER/VISA 组件关联的产品 id（服务端据此取 Transfer.basePrice / Visa.basePrice 权威定价）。
  // HOTEL 组件不在这里带 id ——沿用既有 bundle.hotelRoomTypeId 关联（单套餐一个房型，不按 item 逐条挂）。
  // 省略/undefined：TRANSFER/VISA 行必须带 id 才能定价（服务层校验），FLIGHT/HOTEL 行忽略此字段。
  transferId: z.string().min(1).optional(),
  visaId: z.string().min(1).optional(),
});
export type BundleItemInput = z.infer<typeof bundleItemSchema>;

/** 运营封盘日（按出发日 D）：[{date:"2026-02-15", reason?:"春节封盘"}]，最多 120 条。*/
export const bundleBlackoutSchema = z
  .array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD'),
      reason: z.string().max(60).optional(),
    }),
  )
  .max(120);
export type BundleBlackoutInput = z.infer<typeof bundleBlackoutSchema>;

export const createBundleBodySchema = z.object({
  name: z.string().min(1).max(200),
  tagline: z.string().max(300).optional(),
  // 服务内容（订单详情行程单 / 前台展示；运营每行一条，如「中文客服，越南当地机场助签」）
  serviceNotes: z.string().max(2000).optional(),
  emoji: z.string().max(10).optional(),
  photo: z.string().url().optional(),
  items: z.array(bundleItemSchema).min(1).max(20),
  flightPax: z.number().int().min(1).max(20).default(1),
  // 套餐折扣（百分比 0–100）：整个全包价 ×(1 − discountPct/100)。套餐唯一折扣口径。
  discountPct: z.number().int().min(0).max(100).default(0),
  // [已弃用] 旧固定 CNY 让利；被 discountPct 取代，保留以兼容旧表单提交。
  groundDiscount: z.number().nonnegative().default(0),
  suitableFor: z.string().max(100).optional(),
  // 套餐关联酒店房型（房控板计入套餐占房）；null = 解除关联
  hotelRoomTypeId: z.string().min(1).nullable().optional(),
  hotelNights: z.number().int().min(1).max(30).nullable().optional(),
  // 套餐绑定的去程 / 回程航班号（模板绑法：只绑航班号，不绑某天）。
  // 买家选出发日后按航班号 + 本地出发日解析具体班次。null = 解除绑定。
  outboundFlightId: z.string().nullable().optional(),
  returnFlightId: z.string().nullable().optional(),
  // 可选升级加价（CNY，按产品可配置）：单人入住房差/晚、升舱商务/航段。
  // 整数 CNY；单人入住房差 null / 省略时用 DB 默认 ¥80/晚。
  // 升舱商务 null / 省略时新建套餐显式落 0（= 不提供升舱，见 products.service createBundle）；
  // 更新套餐时 null / 省略 = 保留现值（不改，与其余可选升级加价字段口径一致）。
  // nullable：前端"留空=用默认/不提供"会显式传 null；服务层据此区分"省略"与"改成 0"。
  singleSupplementCnyPerNight: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  businessUpgradeCnyPerLeg: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  // 占座儿童 / 不占座婴儿定价（CNY，按产品可配置；null / 省略时用 DB 默认 30 / 0）：
  //   childSeatDiscountCnyPerPerson = 占座儿童比成人每人便宜多少 CNY（机票按成人价减此折扣；不一定 30）
  //   infantPriceCny                = 不占座婴儿每人价 CNY（默认免费 0）
  childSeatDiscountCnyPerPerson: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  infantPriceCny: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  // 自备签证可减额（CNY，整数）：客人自带签证时从套餐价里扣减多少。
  // null / 省略时用 DB 默认（0 = 不减），与上面 server-priced 字段同款 != null 写入约定。
  selfVisaDeductCny: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  // 每人操作费（CNY，整数）：计入起价/人，下单按出行人头收（买家实付的一部分，非财务成本口径）。
  // null / 省略时用 DB 默认 ¥20，与上面 server-priced 字段同款 != null 写入约定。
  operationFeeCny: z.number().int().nonnegative().max(100_000).nullable().optional(),
  // 机票航段数（来回 = 2，单程 = 1）
  legs: z.number().int().min(1).max(8).optional(),
  // 运营封盘日（按出发日 D）；该日整套餐不可售，优先级高于库存判定。省略 = 不改。
  blackoutDates: bundleBlackoutSchema.optional(),
  // 该套餐前台默认出发日（YYYY-MM-DD）；null = 用全局默认。仅影响前台初始选中，不参与可售判定。
  defaultDepartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD')
    .nullable()
    .optional(),
  // 管理端可编辑排序值：列表按 sortOrder 升序展示（数字小的排前面），留空排最后。
  // 运营用它把常用套餐置顶（如录单选套餐时）。省略 = 不改；显式 null = 清空（排到最后）。
  sortOrder: z.number().int().min(-100_000).max(100_000).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateBundleBody = z.infer<typeof createBundleBodySchema>;
export const updateBundleBodySchema = createBundleBodySchema.partial();
export type UpdateBundleBody = z.infer<typeof updateBundleBodySchema>;
