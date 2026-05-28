/**
 * 产品服务 — Hotel / Transfer / Visa / Bundle 统一 CRUD。
 *
 * 4 个 sub-resource 单独方法组；每个都是标准 list/get/create/update/delete。
 * Hotel 额外支持 nested roomTypes 替换式更新（简化处理）。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
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

export class ProductsService {
  // ══════════════════════════════════════════════════════════════════
  // Hotels
  // ══════════════════════════════════════════════════════════════════
  async listHotels(activeOnly = false) {
    const hotels = await prisma.hotel.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return hotels.map(serializeHotel);
  }

  async getHotel(id: string) {
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
    });
    if (!hotel) throw new NotFoundError('酒店不存在');
    return serializeHotel(hotel);
  }

  async createHotel(body: CreateHotelBody) {
    const hotel = await prisma.hotel.create({
      data: {
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
            basePrice: new Prisma.Decimal(rt.basePrice),
            priceMultiplier: rt.priceMultiplier !== undefined ? new Prisma.Decimal(rt.priceMultiplier) : null,
          })),
        },
      },
      include: { roomTypes: true },
    });
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
    return rows.map(serializeTransfer);
  }

  async getTransfer(id: string) {
    const t = await prisma.transfer.findUnique({ where: { id } });
    if (!t) throw new NotFoundError('接送产品不存在');
    return serializeTransfer(t);
  }

  async createTransfer(body: CreateTransferBody) {
    const t = await prisma.transfer.create({
      data: {
        ...body,
        basePrice: new Prisma.Decimal(body.basePrice),
      },
    });
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
    return rows.map(serializeVisa);
  }

  async getVisa(id: string) {
    const v = await prisma.visa.findUnique({ where: { id } });
    if (!v) throw new NotFoundError('签证产品不存在');
    return serializeVisa(v);
  }

  async createVisa(body: CreateVisaBody) {
    const v = await prisma.visa.create({
      data: {
        ...body,
        basePrice: new Prisma.Decimal(body.basePrice),
        expressSurcharge: body.expressSurcharge !== undefined ? new Prisma.Decimal(body.expressSurcharge) : null,
      },
    });
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
    });
    return rows.map(serializeBundle);
  }

  async getBundle(id: string) {
    const b = await prisma.bundle.findUnique({ where: { id } });
    if (!b) throw new NotFoundError('套餐不存在');
    return serializeBundle(b);
  }

  async createBundle(body: CreateBundleBody) {
    const b = await prisma.bundle.create({
      data: {
        name: body.name,
        tagline: body.tagline,
        emoji: body.emoji,
        photo: body.photo,
        items: body.items as unknown as Prisma.InputJsonValue,
        flightPax: body.flightPax,
        groundDiscount: new Prisma.Decimal(body.groundDiscount),
        suitableFor: body.suitableFor,
        isActive: body.isActive,
      },
    });
    return serializeBundle(b);
  }

  async updateBundle(id: string, body: UpdateBundleBody) {
    const existing = await prisma.bundle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('套餐不存在');
    const data: Prisma.BundleUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.tagline !== undefined) data.tagline = body.tagline;
    if (body.emoji !== undefined) data.emoji = body.emoji;
    if (body.photo !== undefined) data.photo = body.photo;
    if (body.items !== undefined) data.items = body.items as unknown as Prisma.InputJsonValue;
    if (body.flightPax !== undefined) data.flightPax = body.flightPax;
    if (body.groundDiscount !== undefined) data.groundDiscount = new Prisma.Decimal(body.groundDiscount);
    if (body.suitableFor !== undefined) data.suitableFor = body.suitableFor;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const b = await prisma.bundle.update({ where: { id }, data });
    return serializeBundle(b);
  }

  async deleteBundle(id: string) {
    const b = await prisma.bundle.update({ where: { id }, data: { isActive: false } });
    return { id: b.id, isActive: b.isActive };
  }
}

// ── Serializers ─────────────────────────────────────────────────────
type HotelWithRooms = Prisma.HotelGetPayload<{ include: { roomTypes: true } }>;

function serializeHotel(h: HotelWithRooms) {
  return {
    ...h,
    basePrice: h.basePrice?.toString() ?? null,
    rating: h.rating?.toString() ?? null,
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

function serializeTransfer(t: Prisma.TransferGetPayload<Record<string, never>>) {
  return {
    ...t,
    basePrice: t.basePrice.toString(),
    costPriceCny: t.costPriceCny?.toString() ?? null,
  };
}

function serializeVisa(v: Prisma.VisaGetPayload<Record<string, never>>) {
  return {
    ...v,
    basePrice: v.basePrice.toString(),
    expressSurcharge: v.expressSurcharge?.toString() ?? null,
    costPriceCny: v.costPriceCny?.toString() ?? null,
  };
}

function serializeBundle(b: Prisma.BundleGetPayload<Record<string, never>>) {
  return {
    ...b,
    groundDiscount: b.groundDiscount.toString(),
    items: b.items,
  };
}
