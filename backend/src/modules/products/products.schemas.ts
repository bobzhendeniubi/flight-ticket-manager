import { z } from 'zod';

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
      name: z.string().min(1).max(100),
      bedType: z.string().max(100).optional(),
      capacity: z.number().int().min(1).max(10),
      // 单间可坐几大人 / 几小孩（套餐 roomsNeeded 据此算；缺省 2大1小，与旧拼房口径一致）
      maxAdults: z.number().int().min(1).max(10).default(2),
      maxChildren: z.number().int().min(0).max(10).default(1),
      basePrice: z.number().nonnegative(),
      priceMultiplier: z.number().positive().optional(),
    }),
  ).default([]),
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
  flag: z.string().max(10).optional(),
  photo: z.string().url().optional(),
  processingDays: z.number().int().min(0).max(365),
  basePrice: z.number().nonnegative(),
  expressSurcharge: z.number().nonnegative().optional(),
  validityMonths: z.number().int().min(0).max(120).optional(),
  highlight: z.string().max(300).optional(),
  requiredDocs: z.array(z.string().max(100)).default([]),
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
  unitPrice: z.number().nonnegative(),
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
  emoji: z.string().max(10).optional(),
  photo: z.string().url().optional(),
  items: z.array(bundleItemSchema).min(1).max(20),
  flightPax: z.number().int().min(1).max(20).default(1),
  groundDiscount: z.number().nonnegative().default(0),
  suitableFor: z.string().max(100).optional(),
  // 套餐关联酒店房型（房控板计入套餐占房）；null = 解除关联
  hotelRoomTypeId: z.string().min(1).nullable().optional(),
  hotelNights: z.number().int().min(1).max(30).nullable().optional(),
  // 可选升级加价（CNY，按产品可配置）：单人入住房差/晚、升舱商务/航段。
  // 整数 CNY；null / 省略时用 DB 默认（单人入住 ¥80/晚、升舱 ¥700/程）。
  // nullable：前端"留空=用默认"会显式传 null；列本身非空有默认，服务层把 null 当省略处理。
  singleSupplementCnyPerNight: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  businessUpgradeCnyPerLeg: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  // 占座儿童 / 不占座婴儿定价（CNY，按产品可配置；null / 省略时用 DB 默认 30 / 0）：
  //   childSeatDiscountCnyPerPerson = 占座儿童比成人每人便宜多少 CNY（机票按成人价减此折扣；不一定 30）
  //   infantPriceCny                = 不占座婴儿每人价 CNY（默认免费 0）
  childSeatDiscountCnyPerPerson: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  infantPriceCny: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
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
  isActive: z.boolean().default(true),
});
export type CreateBundleBody = z.infer<typeof createBundleBodySchema>;
export const updateBundleBodySchema = createBundleBodySchema.partial();
export type UpdateBundleBody = z.infer<typeof updateBundleBodySchema>;
