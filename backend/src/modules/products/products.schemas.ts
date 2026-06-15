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
  // 整数 CNY；省略时用 DB 默认（单人入住 ¥80/晚、升舱 ¥700/程）。
  singleSupplementCnyPerNight: z.number().int().nonnegative().max(1_000_000).optional(),
  businessUpgradeCnyPerLeg: z.number().int().nonnegative().max(1_000_000).optional(),
  // 机票航段数（来回 = 2，单程 = 1）
  legs: z.number().int().min(1).max(8).optional(),
  isActive: z.boolean().default(true),
});
export type CreateBundleBody = z.infer<typeof createBundleBodySchema>;
export const updateBundleBodySchema = createBundleBodySchema.partial();
export type UpdateBundleBody = z.infer<typeof updateBundleBodySchema>;
