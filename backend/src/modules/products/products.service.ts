/**
 * 产品服务 — Hotel / Transfer / Visa / Bundle 统一 CRUD。
 *
 * 4 个 sub-resource 单独方法组；每个都是标准 list/get/create/update/delete。
 * Hotel 额外支持 nested roomTypes 替换式更新（简化处理）。
 */
import { Prisma, ProductReviewType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { ReviewsService, type ProductRatingAggregate } from '../reviews/reviews.service.js';
import { firstHotelQty } from './bundle-nights.js';

/** hotelNights 的 DB/zod 取值上限（schema: int 1..30）。 */
const HOTEL_NIGHTS_MAX = 30;

/**
 * 写入不变量：套餐 items 含 HOTEL 组件时，hotelNights 必须等于该 HOTEL 组件的 qty
 * （真实住宿晚数）。规范化口径，保证落库的 hotelNights 永不与 HOTEL.qty 背离，且
 * legacy null 行在任意一次 re-save 时自愈。夹到 zod 范围 1..30。
 *
 *   有 HOTEL 组件 → 返回 clamp(HOTEL.qty, 1, 30)；
 *   无 HOTEL 组件 → 返回 undefined（保持调用方原本要写的值，不强行覆盖）。
 */
export function deriveHotelNightsFromItems(items: unknown): number | undefined {
  const qty = firstHotelQty(items);
  if (qty == null) return undefined;
  return Math.min(HOTEL_NIGHTS_MAX, Math.max(1, qty));
}
import type {
  CreateBundleBody,
  CreateHotelBody,
  CreateTransferBody,
  CreateVisaBody,
  UpdateBundleBody,
  UpdateHotelBody,
  UpdateTransferBody,
  UpdateVisaBody,
} from './products.schemas.js';

// ── 产品编号生成 ─────────────────────────────────────────────────────
// 规则：前缀 + 4 位零填充序号（H0001 / V0001 / T0001 / B0001）。
// 序号 = 当前同前缀最大序号 + 1；并发撞 unique 时重试一次 +1。
// 编号只由服务端生成，create/update schema 不暴露 code 字段。
function formatProductCode(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

function parseCodeSeq(prefix: string, code: string | null): number {
  if (!code) return 0;
  const n = Number.parseInt(code.slice(prefix.length), 10);
  return Number.isNaN(n) ? 0 : n;
}

function isCodeUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// ── Bundle 关联房型 include（list/get/create/update 共用）──────────────
const BUNDLE_ROOM_INCLUDE = {
  hotelRoomType: {
    // capacity/maxAdults/maxChildren 暴露给前台，使其能镜像 roomsNeeded 计算并展示
    select: {
      id: true,
      name: true,
      capacity: true,
      maxAdults: true,
      maxChildren: true,
      hotel: { select: { name: true } },
    },
  },
} satisfies Prisma.BundleInclude;

type BundleWithRoom = Prisma.BundleGetPayload<{ include: typeof BUNDLE_ROOM_INCLUDE }>;

/** 查最大编号 → 生成下一个 → create；unique 冲突（并发同号）重试一次 +1。 */
async function createWithProductCode<T>(
  prefix: string,
  findMaxCode: () => Promise<string | null>,
  create: (code: string) => Promise<T>,
): Promise<T> {
  const seq = parseCodeSeq(prefix, await findMaxCode()) + 1;
  try {
    return await create(formatProductCode(prefix, seq));
  } catch (err) {
    if (!isCodeUniqueViolation(err)) throw err;
    return create(formatProductCode(prefix, seq + 1));
  }
}

const ZERO_RATING: ProductRatingAggregate = { average: 0, count: 0 };

export class ProductsService {
  private readonly reviews = new ReviewsService();

  // ══════════════════════════════════════════════════════════════════
  // Hotels
  // ══════════════════════════════════════════════════════════════════
  async listHotels(activeOnly = false) {
    const hotels = await prisma.hotel.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    const ratings = await this.hotelRatings(hotels);
    return hotels.map((h) => serializeHotel(h, ratings.get(h.id) ?? ZERO_RATING));
  }

  async getHotel(id: string) {
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
    });
    if (!hotel) throw new NotFoundError('酒店不存在');
    const ratings = await this.hotelRatings([hotel]);
    return serializeHotel(hotel, ratings.get(hotel.id) ?? ZERO_RATING);
  }

  /**
   * 酒店级评分聚合：HOTEL 评价以 hotelRoomTypeId 为 productId，故按酒店把它的
   * 所有房型 id 的评价汇总成酒店级 { average, count }。
   */
  private async hotelRatings(
    hotels: Array<{ id: string; roomTypes: Array<{ id: string }> }>,
  ): Promise<Map<string, ProductRatingAggregate>> {
    const roomTypeIds = hotels.flatMap((h) => h.roomTypes.map((rt) => rt.id));
    const byRoomType = await this.reviews.getAggregates(ProductReviewType.HOTEL, roomTypeIds);
    const byHotel = new Map<string, ProductRatingAggregate>();
    for (const h of hotels) {
      let count = 0;
      let weighted = 0;
      for (const rt of h.roomTypes) {
        const agg = byRoomType.get(rt.id);
        if (agg && agg.count > 0) {
          count += agg.count;
          weighted += agg.average * agg.count;
        }
      }
      byHotel.set(h.id, {
        count,
        average: count > 0 ? Math.round((weighted / count) * 10) / 10 : 0,
      });
    }
    return byHotel;
  }

  async createHotel(body: CreateHotelBody) {
    const hotel = await createWithProductCode(
      'H',
      async () => {
        const row = await prisma.hotel.findFirst({
          where: { code: { startsWith: 'H' } },
          orderBy: { code: 'desc' },
          select: { code: true },
        });
        return row?.code ?? null;
      },
      (code) => prisma.hotel.create({
        data: {
          code,
          name: body.name,
          nameEn: body.nameEn,
          cityCode: body.cityCode,
          area: body.area,
          address: body.address,
          starRating: body.starRating,
          basePrice: body.basePrice !== undefined ? new Prisma.Decimal(body.basePrice) : null,
          rating: body.rating !== undefined ? new Prisma.Decimal(body.rating) : null,
          reviewCount: body.reviewCount,
          emoji: body.emoji,
          highlight: body.highlight,
          amenities: body.amenities,
          photos: body.photos,
          isActive: body.isActive,
          roomTypes: {
            create: body.roomTypes.map((rt) => ({
              name: rt.name,
              bedType: rt.bedType,
              capacity: rt.capacity,
              maxAdults: rt.maxAdults,
              maxChildren: rt.maxChildren,
              basePrice: new Prisma.Decimal(rt.basePrice),
              priceMultiplier: rt.priceMultiplier !== undefined ? new Prisma.Decimal(rt.priceMultiplier) : null,
            })),
          },
        },
        include: { roomTypes: true },
      }),
    );
    return serializeHotel(hotel);
  }

  async updateHotel(id: string, body: UpdateHotelBody) {
    const existing = await prisma.hotel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('酒店不存在');

    const hotel = await prisma.$transaction(async (tx) => {
      const data: Prisma.HotelUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.nameEn !== undefined) data.nameEn = body.nameEn;
      if (body.cityCode !== undefined) data.cityCode = body.cityCode;
      if (body.area !== undefined) data.area = body.area;
      if (body.address !== undefined) data.address = body.address;
      if (body.starRating !== undefined) data.starRating = body.starRating;
      if (body.basePrice !== undefined) data.basePrice = new Prisma.Decimal(body.basePrice);
      if (body.rating !== undefined) data.rating = new Prisma.Decimal(body.rating);
      if (body.reviewCount !== undefined) data.reviewCount = body.reviewCount;
      if (body.emoji !== undefined) data.emoji = body.emoji;
      if (body.highlight !== undefined) data.highlight = body.highlight;
      if (body.amenities !== undefined) data.amenities = body.amenities;
      if (body.photos !== undefined) data.photos = body.photos;
      if (body.isActive !== undefined) data.isActive = body.isActive;

      await tx.hotel.update({ where: { id }, data });

      // 房型替换式更新（简化：若提供 roomTypes 则全量重建）
      if (body.roomTypes !== undefined) {
        await tx.hotelRoomType.deleteMany({ where: { hotelId: id } });
        if (body.roomTypes.length > 0) {
          await tx.hotelRoomType.createMany({
            data: body.roomTypes.map((rt) => ({
              hotelId: id,
              name: rt.name,
              bedType: rt.bedType,
              capacity: rt.capacity,
              maxAdults: rt.maxAdults,
              maxChildren: rt.maxChildren,
              basePrice: new Prisma.Decimal(rt.basePrice),
              priceMultiplier: rt.priceMultiplier !== undefined ? new Prisma.Decimal(rt.priceMultiplier) : null,
            })),
          });
        }
      }

      return tx.hotel.findUniqueOrThrow({
        where: { id },
        include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
      });
    });

    return serializeHotel(hotel);
  }

  async deleteHotel(id: string) {
    // 软删除：isActive=false（因为可能被订单引用）
    const hotel = await prisma.hotel.update({
      where: { id },
      data: { isActive: false },
    });
    return { id: hotel.id, isActive: hotel.isActive };
  }

  // ══════════════════════════════════════════════════════════════════
  // Transfers
  // ══════════════════════════════════════════════════════════════════
  async listTransfers(activeOnly = false) {
    const rows = await prisma.transfer.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    const ratings = await this.reviews.getAggregates(ProductReviewType.TRANSFER, rows.map((r) => r.id));
    return rows.map((t) => serializeTransfer(t, ratings.get(t.id) ?? ZERO_RATING));
  }

  async getTransfer(id: string) {
    const t = await prisma.transfer.findUnique({ where: { id } });
    if (!t) throw new NotFoundError('接送产品不存在');
    const ratings = await this.reviews.getAggregates(ProductReviewType.TRANSFER, [id]);
    return serializeTransfer(t, ratings.get(id) ?? ZERO_RATING);
  }

  async createTransfer(body: CreateTransferBody) {
    const t = await createWithProductCode(
      'T',
      async () => {
        const row = await prisma.transfer.findFirst({
          where: { code: { startsWith: 'T' } },
          orderBy: { code: 'desc' },
          select: { code: true },
        });
        return row?.code ?? null;
      },
      (code) => prisma.transfer.create({
        data: {
          ...body,
          code,
          basePrice: new Prisma.Decimal(body.basePrice),
        },
      }),
    );
    return serializeTransfer(t);
  }

  async updateTransfer(id: string, body: UpdateTransferBody) {
    const existing = await prisma.transfer.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('接送产品不存在');
    const data: Prisma.TransferUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.vehicleType !== undefined) data.vehicleType = body.vehicleType;
    if (body.capacity !== undefined) data.capacity = body.capacity;
    if (body.originArea !== undefined) data.originArea = body.originArea;
    if (body.destArea !== undefined) data.destArea = body.destArea;
    if (body.basePrice !== undefined) data.basePrice = new Prisma.Decimal(body.basePrice);
    if (body.features !== undefined) data.features = body.features;
    if (body.duration !== undefined) data.duration = body.duration;
    if (body.emoji !== undefined) data.emoji = body.emoji;
    if (body.photo !== undefined) data.photo = body.photo;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const t = await prisma.transfer.update({ where: { id }, data });
    return serializeTransfer(t);
  }

  async deleteTransfer(id: string) {
    const t = await prisma.transfer.update({
      where: { id },
      data: { isActive: false },
    });
    return { id: t.id, isActive: t.isActive };
  }

  // ══════════════════════════════════════════════════════════════════
  // Visas
  // ══════════════════════════════════════════════════════════════════
  async listVisas(activeOnly = false) {
    const rows = await prisma.visa.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    const ratings = await this.reviews.getAggregates(ProductReviewType.VISA, rows.map((r) => r.id));
    return rows.map((v) => serializeVisa(v, ratings.get(v.id) ?? ZERO_RATING));
  }

  async getVisa(id: string) {
    const v = await prisma.visa.findUnique({ where: { id } });
    if (!v) throw new NotFoundError('签证产品不存在');
    const ratings = await this.reviews.getAggregates(ProductReviewType.VISA, [id]);
    return serializeVisa(v, ratings.get(id) ?? ZERO_RATING);
  }

  async createVisa(body: CreateVisaBody) {
    const v = await createWithProductCode(
      'V',
      async () => {
        const row = await prisma.visa.findFirst({
          where: { code: { startsWith: 'V' } },
          orderBy: { code: 'desc' },
          select: { code: true },
        });
        return row?.code ?? null;
      },
      (code) => prisma.visa.create({
        data: {
          ...body,
          code,
          basePrice: new Prisma.Decimal(body.basePrice),
          expressSurcharge: body.expressSurcharge !== undefined ? new Prisma.Decimal(body.expressSurcharge) : null,
        },
      }),
    );
    return serializeVisa(v);
  }

  async updateVisa(id: string, body: UpdateVisaBody) {
    const existing = await prisma.visa.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('签证产品不存在');
    const data: Prisma.VisaUpdateInput = {};
    if (body.destinationCountry !== undefined) data.destinationCountry = body.destinationCountry;
    if (body.country !== undefined) data.country = body.country;
    if (body.visaType !== undefined) data.visaType = body.visaType;
    if (body.visaName !== undefined) data.visaName = body.visaName;
    if (body.flag !== undefined) data.flag = body.flag;
    if (body.processingDays !== undefined) data.processingDays = body.processingDays;
    if (body.basePrice !== undefined) data.basePrice = new Prisma.Decimal(body.basePrice);
    if (body.expressSurcharge !== undefined) data.expressSurcharge = new Prisma.Decimal(body.expressSurcharge);
    if (body.validityMonths !== undefined) data.validityMonths = body.validityMonths;
    if (body.highlight !== undefined) data.highlight = body.highlight;
    if (body.requiredDocs !== undefined) data.requiredDocs = body.requiredDocs;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const v = await prisma.visa.update({ where: { id }, data });
    return serializeVisa(v);
  }

  async deleteVisa(id: string) {
    const v = await prisma.visa.update({
      where: { id },
      data: { isActive: false },
    });
    return { id: v.id, isActive: v.isActive };
  }

  // ══════════════════════════════════════════════════════════════════
  // Bundles
  // ══════════════════════════════════════════════════════════════════
  async listBundles(activeOnly = false) {
    const rows = await prisma.bundle.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
      include: BUNDLE_ROOM_INCLUDE,
    });
    const ratings = await this.reviews.getAggregates(ProductReviewType.BUNDLE, rows.map((r) => r.id));
    return rows.map((b) => serializeBundle(b, ratings.get(b.id) ?? ZERO_RATING));
  }

  async getBundle(id: string) {
    const b = await prisma.bundle.findUnique({
      where: { id },
      include: BUNDLE_ROOM_INCLUDE,
    });
    if (!b) throw new NotFoundError('套餐不存在');
    const ratings = await this.reviews.getAggregates(ProductReviewType.BUNDLE, [id]);
    return serializeBundle(b, ratings.get(id) ?? ZERO_RATING);
  }

  async createBundle(body: CreateBundleBody) {
    await this.assertHotelRoomTypeExists(body.hotelRoomTypeId);
    const b = await createWithProductCode(
      'B',
      async () => {
        const row = await prisma.bundle.findFirst({
          where: { code: { startsWith: 'B' } },
          orderBy: { code: 'desc' },
          select: { code: true },
        });
        return row?.code ?? null;
      },
      (code) => prisma.bundle.create({
        data: {
          code,
          name: body.name,
          tagline: body.tagline,
          emoji: body.emoji,
          photo: body.photo,
          items: body.items as unknown as Prisma.InputJsonValue,
          flightPax: body.flightPax,
          groundDiscount: new Prisma.Decimal(body.groundDiscount),
          suitableFor: body.suitableFor,
          hotelRoomTypeId: body.hotelRoomTypeId ?? null,
          // 写入不变量：items 含 HOTEL 组件 → hotelNights 强制 = HOTEL.qty（真实晚数，clamp 1..30）；
          // 无 HOTEL 组件 → 保留请求值（或 null）。保证落库 hotelNights 永不与 HOTEL.qty 背离。
          hotelNights: deriveHotelNightsFromItems(body.items) ?? body.hotelNights ?? null,
          // 省略时落 DB 默认（单人入住 ¥80/晚、升舱 ¥700/程、来回 2 段）
          ...(body.singleSupplementCnyPerNight != null
            ? { singleSupplementCnyPerNight: body.singleSupplementCnyPerNight }
            : {}),
          ...(body.businessUpgradeCnyPerLeg != null
            ? { businessUpgradeCnyPerLeg: body.businessUpgradeCnyPerLeg }
            : {}),
          // 占座儿童折扣 / 婴儿价：省略时落 DB 默认（30 / 0）
          ...(body.childSeatDiscountCnyPerPerson != null
            ? { childSeatDiscountCnyPerPerson: body.childSeatDiscountCnyPerPerson }
            : {}),
          ...(body.infantPriceCny != null ? { infantPriceCny: body.infantPriceCny } : {}),
          ...(body.legs != null ? { legs: body.legs } : {}),
          // 运营封盘日（省略 = DB 默认 []）；前台默认出发日（省略 = null）
          ...(body.blackoutDates != null
            ? { blackoutDates: body.blackoutDates as unknown as Prisma.InputJsonValue }
            : {}),
          defaultDepartDate: body.defaultDepartDate ?? null,
          isActive: body.isActive,
        },
        include: BUNDLE_ROOM_INCLUDE,
      }),
    );
    return serializeBundle(b);
  }

  async updateBundle(id: string, body: UpdateBundleBody) {
    const existing = await prisma.bundle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('套餐不存在');
    await this.assertHotelRoomTypeExists(body.hotelRoomTypeId);
    const data: Prisma.BundleUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.tagline !== undefined) data.tagline = body.tagline;
    if (body.emoji !== undefined) data.emoji = body.emoji;
    if (body.photo !== undefined) data.photo = body.photo;
    if (body.items !== undefined) data.items = body.items as unknown as Prisma.InputJsonValue;
    if (body.flightPax !== undefined) data.flightPax = body.flightPax;
    if (body.groundDiscount !== undefined) data.groundDiscount = new Prisma.Decimal(body.groundDiscount);
    if (body.suitableFor !== undefined) data.suitableFor = body.suitableFor;
    if (body.hotelRoomTypeId !== undefined) data.hotelRoomTypeId = body.hotelRoomTypeId;
    if (body.hotelNights !== undefined) data.hotelNights = body.hotelNights;
    // 写入不变量：仅当本次在改 items 时，按新 items 的 HOTEL 组件 qty 规范化/覆盖 hotelNights
    // （即便请求显式传了别的 hotelNights，也以真实 HOTEL.qty 为准；legacy null 行借此自愈）。
    // 新 items 无 HOTEL 组件 → 不动 hotelNights，保留上面按 body.hotelNights 的处理。
    if (body.items !== undefined) {
      const derived = deriveHotelNightsFromItems(body.items);
      if (derived !== undefined) data.hotelNights = derived;
    }
    // 用 != null（排除 null 与 undefined）：列非空有默认，前端"留空=用默认"会传 null，
    // 不能把 null 写进 Prisma（会报错）。null/省略一律视为"不改"，与 createBundle 的 != null 一致。
    if (body.singleSupplementCnyPerNight != null) {
      data.singleSupplementCnyPerNight = body.singleSupplementCnyPerNight;
    }
    if (body.businessUpgradeCnyPerLeg != null) {
      data.businessUpgradeCnyPerLeg = body.businessUpgradeCnyPerLeg;
    }
    if (body.childSeatDiscountCnyPerPerson != null) {
      data.childSeatDiscountCnyPerPerson = body.childSeatDiscountCnyPerPerson;
    }
    if (body.infantPriceCny != null) {
      data.infantPriceCny = body.infantPriceCny;
    }
    if (body.legs !== undefined) data.legs = body.legs;
    if (body.blackoutDates !== undefined) {
      data.blackoutDates = body.blackoutDates as unknown as Prisma.InputJsonValue;
    }
    if (body.defaultDepartDate !== undefined) data.defaultDepartDate = body.defaultDepartDate;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const b = await prisma.bundle.update({
      where: { id },
      data,
      include: BUNDLE_ROOM_INCLUDE,
    });
    return serializeBundle(b);
  }

  /** 校验套餐关联的酒店房型存在（null/undefined 跳过） */
  private async assertHotelRoomTypeExists(hotelRoomTypeId: string | null | undefined) {
    if (!hotelRoomTypeId) return;
    const rt = await prisma.hotelRoomType.findUnique({
      where: { id: hotelRoomTypeId },
      select: { id: true },
    });
    if (!rt) throw new NotFoundError(`酒店房型 ${hotelRoomTypeId} 不存在`);
  }

  async deleteBundle(id: string) {
    const b = await prisma.bundle.update({ where: { id }, data: { isActive: false } });
    return { id: b.id, isActive: b.isActive };
  }
}

// ── Serializers ─────────────────────────────────────────────────────
type HotelWithRooms = Prisma.HotelGetPayload<{ include: { roomTypes: true } }>;

// D3：所有产品对外统一暴露 rating: { average, count }（来自 Review 真实聚合）
// + soldCount（seed 填充）。reviewCount 用聚合 count 覆盖（有评价时），
// 老的 hotel.rating(Decimal) 改名 ratingLegacy 兼容旧前端兜底。
function serializeHotel(h: HotelWithRooms, rating: ProductRatingAggregate = ZERO_RATING) {
  const { rating: legacyRating, reviewCount, ...rest } = h;
  return {
    ...rest,
    basePrice: h.basePrice?.toString() ?? null,
    ratingLegacy: legacyRating?.toString() ?? null,
    rating, // { average, count } —— 真实评价聚合
    reviewCount: rating.count > 0 ? rating.count : (reviewCount ?? 0),
    soldCount: h.soldCount,
    latitude: h.latitude?.toString() ?? null,
    longitude: h.longitude?.toString() ?? null,
    roomTypes: h.roomTypes.map((rt) => ({
      ...rt,
      basePrice: rt.basePrice.toString(),
      priceMultiplier: rt.priceMultiplier?.toString() ?? null,
      costPriceCny: rt.costPriceCny?.toString() ?? null,
    })),
  };
}

function serializeTransfer(
  t: Prisma.TransferGetPayload<Record<string, never>>,
  rating: ProductRatingAggregate = ZERO_RATING,
) {
  return {
    ...t,
    basePrice: t.basePrice.toString(),
    costPriceCny: t.costPriceCny?.toString() ?? null,
    rating,
    reviewCount: rating.count,
    soldCount: t.soldCount,
  };
}

function serializeVisa(
  v: Prisma.VisaGetPayload<Record<string, never>>,
  rating: ProductRatingAggregate = ZERO_RATING,
) {
  return {
    ...v,
    basePrice: v.basePrice.toString(),
    expressSurcharge: v.expressSurcharge?.toString() ?? null,
    costPriceCny: v.costPriceCny?.toString() ?? null,
    rating,
    reviewCount: rating.count,
    soldCount: v.soldCount,
  };
}

function serializeBundle(b: BundleWithRoom, rating: ProductRatingAggregate = ZERO_RATING) {
  const { hotelRoomType, ...rest } = b;
  return {
    ...rest,
    groundDiscount: b.groundDiscount.toString(),
    // 可选升级加价（CNY，整数，server-priced add-on）+ 航段数；前端据此报价升级项
    singleSupplementCnyPerNight: b.singleSupplementCnyPerNight,
    businessUpgradeCnyPerLeg: b.businessUpgradeCnyPerLeg,
    // 占座儿童折扣 / 婴儿价（CNY，整数，server-priced）；前端据此报价儿童/婴儿
    childSeatDiscountCnyPerPerson: b.childSeatDiscountCnyPerPerson,
    infantPriceCny: b.infantPriceCny,
    legs: b.legs,
    // 运营封盘日（按出发日 D；admin 读回）+ 前台默认出发日（仅影响初始选中）
    blackoutDates: b.blackoutDates,
    defaultDepartDate: b.defaultDepartDate,
    items: b.items,
    rating,
    reviewCount: rating.count,
    soldCount: b.soldCount,
    // admin-web 表单需要房型名 + 酒店名做展示；前台用 capacity/maxAdults/maxChildren 镜像 roomsNeeded
    hotelRoomType: hotelRoomType
      ? {
          id: hotelRoomType.id,
          name: hotelRoomType.name,
          hotelName: hotelRoomType.hotel.name,
          capacity: hotelRoomType.capacity,
          maxAdults: hotelRoomType.maxAdults,
          maxChildren: hotelRoomType.maxChildren,
        }
      : null,
  };
}
