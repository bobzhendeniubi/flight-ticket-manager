/**
 * 产品服务 — Hotel / Transfer / Visa / Bundle 统一 CRUD。
 *
 * 4 个 sub-resource 单独方法组；每个都是标准 list/get/create/update/delete。
 * Hotel 额外支持 nested roomTypes 替换式更新（简化处理）。
 */
import { Prisma, ProductReviewType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError, BadRequestError } from '../../lib/errors.js';
import { ReviewsService, type ProductRatingAggregate } from '../reviews/reviews.service.js';
import { firstHotelQty, resolveBundleNights } from './bundle-nights.js';
import {
  getCheapestRoundTripEconomyCny,
  computeBundleOriginalAllInCny,
  computeBundleOriginalPerPaxCny,
  type BundleFlightBinding,
} from './bundle-pricing.js';
import type {
  BundleItemInput,
  CreateBundleBody,
  CreateHotelBody,
  CreateTransferBody,
  CreateVisaBody,
  UpdateBundleBody,
  UpdateHotelBody,
  UpdateTransferBody,
  UpdateVisaBody,
} from './products.schemas.js';

/** hotelNights 的 DB/zod 取值上限（schema: int 1..30）。 */
const HOTEL_NIGHTS_MAX = 30;

/**
 * 单房差 / 儿童差价的默认值（须与 schema.prisma 的 @default 一致，也与前端表单占位符
 * 「留空 = 用默认 ¥80/¥30」承诺一致）。更新已存在的行时 DB @default 只在 INSERT 生效，
 * 故 updateBundle 里运营显式清空（传 null）需由服务端主动写回这两个默认值。
 */
const DEFAULT_SINGLE_SUPPLEMENT_CNY_PER_NIGHT = 80;
const DEFAULT_CHILD_SEAT_DISCOUNT_CNY_PER_PERSON = 30;

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

/**
 * 套餐组件价格权威定价（写入前的服务端 authoritative 定价，钱路径关键函数）：
 *   FLIGHT   → unitPrice 恒为 0（客户选出发日后由 /flights/price 实时定价，不在此定价）。
 *   HOTEL    → 套餐必须关联房型（hotelRoomTypeId），用 HotelRoomType.basePrice 覆盖
 *              （与 orders.service 对 HOTEL 行的权威取价口径一致，绝不信任 items JSON 里手填的值）；
 *              未关联房型 → 400。旧版曾对「未关联」静默放行、保留调用方乱填的 unitPrice —— 这正是
 *              向导里「酒店行 ¥0 但看起来价格正常」陷阱的根因（起价漏算酒店却不报错），现改为硬拒绝。
 *   TRANSFER → 必须带 transferId，按其查 Transfer.basePrice 覆盖；查无此产品 → 404。
 *   VISA     → 必须带 visaId，按其查 Visa.basePrice 覆盖；查无此产品 → 404。
 *
 * 客户端传的 unitPrice 在 HOTEL/TRANSFER/VISA 上永远被服务端权威值覆盖 ——
 * 运营在后台唯一能动的定价杠杆是 discountPct + 目标价（换算折扣%）与升级加价项，价格本身不可手改。
 * 返回新数组（不可变，不修改入参）。
 */
export async function resolveBundleItemPrices(
  items: ReadonlyArray<BundleItemInput>,
  hotelRoomTypeId: string | null | undefined,
): Promise<BundleItemInput[]> {
  // 套餐含酒店组件时必须关联房型：没有房型就没有权威取价源，起价公式会静默漏算酒店那一项。
  // 在发任何查询前先拦，给出干净的 400，而非放行后让 HOTEL 行的 unitPrice 停留在调用方乱填的值。
  if (!hotelRoomTypeId && items.some((i) => i.kind === 'HOTEL')) {
    throw new BadRequestError('套餐含酒店组件时必须关联房型');
  }
  // 先滤掉 undefined 再去重：TRANSFER/VISA 行缺 id 是校验错误（下面逐行 400），
  // 不该先为它发一次 findMany({where:{id:{in:[undefined]}}})（Prisma 会报错，且语义上没有查询意义）。
  const transferIds = [
    ...new Set(
      items
        .filter((i) => i.kind === 'TRANSFER')
        .map((i) => i.transferId)
        .filter((id): id is string => id != null),
    ),
  ];
  const visaIds = [
    ...new Set(
      items
        .filter((i) => i.kind === 'VISA')
        .map((i) => i.visaId)
        .filter((id): id is string => id != null),
    ),
  ];

  const [transfers, visas, hotelRoomType] = await Promise.all([
    transferIds.length > 0
      ? prisma.transfer.findMany({ where: { id: { in: transferIds } }, select: { id: true, basePrice: true } })
      : Promise.resolve([]),
    visaIds.length > 0
      ? prisma.visa.findMany({ where: { id: { in: visaIds } }, select: { id: true, basePrice: true } })
      : Promise.resolve([]),
    hotelRoomTypeId
      ? prisma.hotelRoomType.findUnique({ where: { id: hotelRoomTypeId }, select: { basePrice: true } })
      : Promise.resolve(null),
  ]);
  const transferPriceById = new Map(transfers.map((t) => [t.id, Number(t.basePrice)]));
  const visaPriceById = new Map(visas.map((v) => [v.id, Number(v.basePrice)]));

  return items.map((item) => {
    if (item.kind === 'FLIGHT') return { ...item, unitPrice: 0 };
    if (item.kind === 'HOTEL') {
      // 走到这里 hotelRoomTypeId 必已存在（上面已拦未关联的情况）；
      // hotelRoomType 为 null 仅当调用方在此函数之外跳过了 assertHotelRoomTypeExists 校验
      // （正常两条写路径都会先校验），防御性保留原值而非抛错崩溃整个请求。
      return hotelRoomType ? { ...item, unitPrice: Number(hotelRoomType.basePrice) } : item;
    }
    if (item.kind === 'TRANSFER') {
      if (!item.transferId) throw new BadRequestError('套餐 TRANSFER 组件必须关联接送产品（transferId）');
      const price = transferPriceById.get(item.transferId);
      if (price === undefined) throw new NotFoundError(`接送产品 ${item.transferId} 不存在`);
      return { ...item, unitPrice: price };
    }
    // VISA
    if (!item.visaId) throw new BadRequestError('套餐 VISA 组件必须关联签证产品（visaId）');
    const price = visaPriceById.get(item.visaId);
    if (price === undefined) throw new NotFoundError(`签证产品 ${item.visaId} 不存在`);
    return { ...item, unitPrice: price };
  });
}

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
// 套餐绑定航班号（去/回程）对外暴露的字段：id + 航班号 + 起降地
const BUNDLE_FLIGHT_SELECT = {
  select: { id: true, flightNumber: true, originCode: true, destinationCode: true },
} satisfies Prisma.Bundle$outboundFlightArgs;

const BUNDLE_ROOM_INCLUDE = {
  hotelRoomType: {
    // capacity/maxAdults/maxChildren 暴露给前台，使其能镜像 roomsNeeded 计算并展示。
    // basePrice：整间夜价（服务端权威取价源，也是「起价/人」拼房 0.5 的被乘数）——
    //   admin 编辑器按此展示「酒店 ¥X/晚」（整间价，不预先打 0.5，0.5 只在 originalPerPaxCny 内部生效）。
    select: {
      id: true,
      name: true,
      capacity: true,
      maxAdults: true,
      maxChildren: true,
      basePrice: true,
      hotel: { select: { name: true } },
    },
  },
  // 套餐绑定的去程 / 回程航班号（买家选出发日后据此解析具体班次）
  outboundFlight: BUNDLE_FLIGHT_SELECT,
  returnFlight: BUNDLE_FLIGHT_SELECT,
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
  /** includeCost：仅 ADMIN/STAFF（由路由层按 req.user 角色判定）传 true，下发 costPriceCny；匿名/游客恒 false。 */
  async listHotels(activeOnly = false, includeCost = false) {
    const hotels = await prisma.hotel.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    const ratings = await this.hotelRatings(hotels);
    return hotels.map((h) => serializeHotel(h, ratings.get(h.id) ?? ZERO_RATING, includeCost));
  }

  async getHotel(id: string, includeCost = false) {
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      include: { roomTypes: { orderBy: { basePrice: 'asc' } } },
    });
    if (!hotel) throw new NotFoundError('酒店不存在');
    const ratings = await this.hotelRatings([hotel]);
    return serializeHotel(hotel, ratings.get(hotel.id) ?? ZERO_RATING, includeCost);
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
              // 净房价（仅内部）：省略/null 两种"未录"都落 null（== 而非 === undefined，因该字段本身可空）。
              costPriceCny: rt.costPriceCny != null ? new Prisma.Decimal(rt.costPriceCny) : null,
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

      // 房型 upsert 式更新（关键：保留已有房型 id，避免套餐 hotelRoomTypeId / 订单引用漂移失联）。
      // 匹配优先用回传的 id，其次按名称匹配现有房型 → 原地 update；未匹配的为新建；
      // 现有房型中本次未出现的才删除（按 id 集合差）。
      if (body.roomTypes !== undefined) {
        const existing = await tx.hotelRoomType.findMany({
          where: { hotelId: id },
          select: { id: true, name: true },
        });
        const existingById = new Map(existing.map((rt) => [rt.id, rt]));
        const existingByName = new Map(existing.map((rt) => [rt.name, rt]));

        const keptIds = new Set<string>();
        for (const rt of body.roomTypes) {
          const matched =
            (rt.id && existingById.get(rt.id)) || existingByName.get(rt.name) || null;
          const data = {
            name: rt.name,
            bedType: rt.bedType,
            capacity: rt.capacity,
            maxAdults: rt.maxAdults,
            maxChildren: rt.maxChildren,
            basePrice: new Prisma.Decimal(rt.basePrice),
            priceMultiplier:
              rt.priceMultiplier !== undefined ? new Prisma.Decimal(rt.priceMultiplier) : null,
            // 净房价（仅内部）：房型行是整行覆盖式提交（非增量 PATCH），省略/null 都表示"未录" → null。
            costPriceCny: rt.costPriceCny != null ? new Prisma.Decimal(rt.costPriceCny) : null,
          };
          if (matched) {
            // 原地更新：保留原 id
            await tx.hotelRoomType.update({ where: { id: matched.id }, data });
            keptIds.add(matched.id);
          } else {
            const created = await tx.hotelRoomType.create({ data: { hotelId: id, ...data } });
            keptIds.add(created.id);
          }
        }

        // 只删本次未保留的现有房型（被移除的）
        const toDelete = existing.filter((rt) => !keptIds.has(rt.id)).map((rt) => rt.id);
        if (toDelete.length > 0) {
          await tx.hotelRoomType.deleteMany({ where: { id: { in: toDelete } } });
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
  async listTransfers(activeOnly = false, includeCost = false) {
    const rows = await prisma.transfer.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    const ratings = await this.reviews.getAggregates(ProductReviewType.TRANSFER, rows.map((r) => r.id));
    return rows.map((t) => serializeTransfer(t, ratings.get(t.id) ?? ZERO_RATING, includeCost));
  }

  async getTransfer(id: string, includeCost = false) {
    const t = await prisma.transfer.findUnique({ where: { id } });
    if (!t) throw new NotFoundError('接送产品不存在');
    const ratings = await this.reviews.getAggregates(ProductReviewType.TRANSFER, [id]);
    return serializeTransfer(t, ratings.get(id) ?? ZERO_RATING, includeCost);
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
          // 司机/车队结算价（仅内部）：省略/null 两种"未录"都落 null（新建无"保留现值"这一说）。
          costPriceCny: body.costPriceCny != null ? new Prisma.Decimal(body.costPriceCny) : null,
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
    // 真·部分更新字段（与上面同款 !== undefined 守卫一致）：省略 = 不改；显式 null = 清空为未录；
    // 数字 = 覆盖。costPriceCny 本身可空，不能用 !=null 一并吞掉"显式清空"这个语义。
    if (body.costPriceCny !== undefined) {
      data.costPriceCny = body.costPriceCny === null ? null : new Prisma.Decimal(body.costPriceCny);
    }
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
  async listVisas(activeOnly = false, includeCost = false) {
    const rows = await prisma.visa.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    const ratings = await this.reviews.getAggregates(ProductReviewType.VISA, rows.map((r) => r.id));
    return rows.map((v) => serializeVisa(v, ratings.get(v.id) ?? ZERO_RATING, includeCost));
  }

  async getVisa(id: string, includeCost = false) {
    const v = await prisma.visa.findUnique({ where: { id } });
    if (!v) throw new NotFoundError('签证产品不存在');
    const ratings = await this.reviews.getAggregates(ProductReviewType.VISA, [id]);
    return serializeVisa(v, ratings.get(id) ?? ZERO_RATING, includeCost);
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
          // 使馆/代办成本（仅内部）：省略/null 两种"未录"都落 null（新建无"保留现值"这一说）。
          costPriceCny: body.costPriceCny != null ? new Prisma.Decimal(body.costPriceCny) : null,
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
    // 签发方式 / 入境次数：省略 = 不改；显式 null = 清空为未设置；枚举值 = 覆盖（同 costPriceCny 约定）。
    if (body.issuanceMethod !== undefined) data.issuanceMethod = body.issuanceMethod;
    if (body.entryType !== undefined) data.entryType = body.entryType;
    if (body.processingDays !== undefined) data.processingDays = body.processingDays;
    if (body.basePrice !== undefined) data.basePrice = new Prisma.Decimal(body.basePrice);
    if (body.expressSurcharge !== undefined) data.expressSurcharge = new Prisma.Decimal(body.expressSurcharge);
    if (body.validityMonths !== undefined) data.validityMonths = body.validityMonths;
    if (body.stayDays !== undefined) data.stayDays = body.stayDays;
    if (body.highlight !== undefined) data.highlight = body.highlight;
    if (body.requiredDocs !== undefined) data.requiredDocs = body.requiredDocs;
    // 真·部分更新字段：省略 = 不改；显式 null = 清空为未录；数字 = 覆盖（与 updateTransfer 同款约定）。
    if (body.costPriceCny !== undefined) {
      data.costPriceCny = body.costPriceCny === null ? null : new Prisma.Decimal(body.costPriceCny);
    }
    // 签证公司/代办渠道名（财务对账用）：省略 = 不改；显式 null = 清空。
    if (body.supplier !== undefined) data.supplier = body.supplier;
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
      // 管理端可编辑排序（数字小的排前面，留空排最后），同 sortOrder 再按创建时间兜底；
      // 录单套餐下拉/列表走同一条查询，故此处排序对两处都生效。
      orderBy: [{ sortOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      include: BUNDLE_ROOM_INCLUDE,
    });
    const ratings = await this.reviews.getAggregates(ProductReviewType.BUNDLE, rows.map((r) => r.id));
    // 当前最低来回机票，喂给每个套餐算「原价（含机票）」，供后台目标价↔折扣% 换算。
    // 按 (去程航班, 回程航班) 组合去重后各查一次：绑了航班的用该航班班次价，未绑的按航线兜底。
    // 业务航线有限（通常 1~3 种组合），既避免 N+1 逐套餐查库，也不让全局最低价污染所有套餐起价。
    const now = new Date();
    const bindingKey = (ob: string | null, rt: string | null) => `${ob ?? 'route'}|${rt ?? 'route'}`;
    const uniqueBindings = new Map<string, BundleFlightBinding>();
    for (const b of rows) {
      const key = bindingKey(b.outboundFlightId, b.returnFlightId);
      if (!uniqueBindings.has(key)) {
        uniqueBindings.set(key, { outboundFlightId: b.outboundFlightId, returnFlightId: b.returnFlightId });
      }
    }
    const flightRefByKey = new Map<string, number | null>();
    await Promise.all(
      [...uniqueBindings].map(async ([key, binding]) => {
        flightRefByKey.set(key, await getCheapestRoundTripEconomyCny(now, binding));
      }),
    );
    return rows.map((b) =>
      serializeBundle(
        b,
        ratings.get(b.id) ?? ZERO_RATING,
        flightRefByKey.get(bindingKey(b.outboundFlightId, b.returnFlightId)) ?? null,
      ),
    );
  }

  async getBundle(id: string) {
    const b = await prisma.bundle.findUnique({
      where: { id },
      include: BUNDLE_ROOM_INCLUDE,
    });
    if (!b) throw new NotFoundError('套餐不存在');
    const ratings = await this.reviews.getAggregates(ProductReviewType.BUNDLE, [id]);
    // 机票参考价按本套餐绑定的去/回程航班取价（未绑则按航线兜底），不再共用全局最低价。
    const flightRef = await getCheapestRoundTripEconomyCny(new Date(), {
      outboundFlightId: b.outboundFlightId,
      returnFlightId: b.returnFlightId,
    });
    return serializeBundle(b, ratings.get(id) ?? ZERO_RATING, flightRef);
  }

  /**
   * 单个「绑定组合」当前最低来回经济舱机票 / 人（CNY，null = 无可估班次）。
   *
   * 供后台套餐表单按「这个套餐自己绑定的去/回程航班」实时取机票基数，反推「想卖的价格」↔折扣%，
   * 保证向导预览起价与卡片展示同源（两处都调 getCheapestRoundTripEconomyCny + 同一 binding）。
   * binding 两参数都空 = 按套餐航线兜底（由 getCheapestRoundTripEconomyCny 内部处理）。只读，不落库。
   */
  async getBundleFlightRef(
    binding: BundleFlightBinding,
  ): Promise<{ flightRefRoundTripCny: number | null }> {
    const flightRefRoundTripCny = await getCheapestRoundTripEconomyCny(new Date(), binding);
    return { flightRefRoundTripCny };
  }

  async createBundle(body: CreateBundleBody) {
    await this.assertHotelRoomTypeExists(body.hotelRoomTypeId);
    await this.assertFlightExists(body.outboundFlightId);
    await this.assertFlightExists(body.returnFlightId);
    // 组件价格权威定价（HOTEL/TRANSFER/VISA 覆盖为产品价，FLIGHT 归零）——
    // 运营在表单里填的 unitPrice 只用来过校验，落库前在此被服务端权威值覆盖。
    const pricedItems = await resolveBundleItemPrices(body.items, body.hotelRoomTypeId);
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
          serviceNotes: body.serviceNotes,
          emoji: body.emoji,
          photo: body.photo,
          items: pricedItems as unknown as Prisma.InputJsonValue,
          flightPax: body.flightPax,
          discountPct: body.discountPct,
          groundDiscount: new Prisma.Decimal(body.groundDiscount),
          suitableFor: body.suitableFor,
          hotelRoomTypeId: body.hotelRoomTypeId ?? null,
          // 套餐绑定去/回程航班号（模板绑法：只绑航班号，不绑某天）；省略 / null = 不绑
          outboundFlightId: body.outboundFlightId ?? null,
          returnFlightId: body.returnFlightId ?? null,
          // 写入不变量：items 含 HOTEL 组件 → hotelNights 强制 = HOTEL.qty（真实晚数，clamp 1..30）；
          // 无 HOTEL 组件 → 保留请求值（或 null）。保证落库 hotelNights 永不与 HOTEL.qty 背离。
          hotelNights: deriveHotelNightsFromItems(body.items) ?? body.hotelNights ?? null,
          // 省略时落 DB 默认（单人入住 ¥80/晚、来回 2 段）
          ...(body.singleSupplementCnyPerNight != null
            ? { singleSupplementCnyPerNight: body.singleSupplementCnyPerNight }
            : {}),
          // 升舱差价：省略/null 落 null = 「跟随航班」（按绑定航班 Flight.businessUpgradeCnyPerLeg 计价）。
          // 显式传数值 = 套餐自有覆盖（含 0 = 不提供升舱）。运营留空即随航班浮动，无需在每个套餐里重复填。
          businessUpgradeCnyPerLeg: body.businessUpgradeCnyPerLeg ?? null,
          // 占座儿童折扣 / 婴儿价：省略时落 DB 默认（30 / 0）
          ...(body.childSeatDiscountCnyPerPerson != null
            ? { childSeatDiscountCnyPerPerson: body.childSeatDiscountCnyPerPerson }
            : {}),
          ...(body.infantPriceCny != null ? { infantPriceCny: body.infantPriceCny } : {}),
          // 自备签证可减额：省略 / null 时落 DB 默认（0 = 不减）
          ...(body.selfVisaDeductCny != null ? { selfVisaDeductCny: body.selfVisaDeductCny } : {}),
          // 每人操作费：省略 / null 时落 DB 默认 ¥20
          ...(body.operationFeeCny != null ? { operationFeeCny: body.operationFeeCny } : {}),
          ...(body.legs != null ? { legs: body.legs } : {}),
          // 运营封盘日（省略 = DB 默认 []）；前台默认出发日（省略 = null）
          ...(body.blackoutDates != null
            ? { blackoutDates: body.blackoutDates as unknown as Prisma.InputJsonValue }
            : {}),
          defaultDepartDate: body.defaultDepartDate ?? null,
          // 管理端可编辑排序值：省略/null = 排最后（DB 默认 null）
          sortOrder: body.sortOrder ?? null,
          isActive: body.isActive,
        },
        include: BUNDLE_ROOM_INCLUDE,
      }),
    );
    // 与 getBundle/listBundles 同口径喂机票参考价（按本套餐绑定航班取价），保证创建响应里的
    // originalPerPaxCny/originalAllInCny 与随后 GET 到的值一致（不留「刚创建时是 0，下次 GET 才对」窗口）。
    const flightRef = await getCheapestRoundTripEconomyCny(new Date(), {
      outboundFlightId: b.outboundFlightId,
      returnFlightId: b.returnFlightId,
    });
    return serializeBundle(b, ZERO_RATING, flightRef);
  }

  async updateBundle(id: string, body: UpdateBundleBody) {
    const existing = await prisma.bundle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('套餐不存在');
    await this.assertHotelRoomTypeExists(body.hotelRoomTypeId);
    await this.assertFlightExists(body.outboundFlightId);
    await this.assertFlightExists(body.returnFlightId);
    const data: Prisma.BundleUncheckedUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.tagline !== undefined) data.tagline = body.tagline;
    if (body.serviceNotes !== undefined) data.serviceNotes = body.serviceNotes;
    if (body.emoji !== undefined) data.emoji = body.emoji;
    if (body.photo !== undefined) data.photo = body.photo;
    if (body.items !== undefined) {
      // 组件价格权威定价：本次生效的 hotelRoomTypeId = 请求里显式改的值（含解绑 null），
      // 否则沿用落库的现值 —— 保证「只改 items 不改房型」时 HOTEL 行仍按当前关联房型权威取价。
      const effectiveHotelRoomTypeId =
        body.hotelRoomTypeId !== undefined ? body.hotelRoomTypeId : existing.hotelRoomTypeId;
      const pricedItems = await resolveBundleItemPrices(body.items, effectiveHotelRoomTypeId);
      data.items = pricedItems as unknown as Prisma.InputJsonValue;
    }
    if (body.flightPax !== undefined) data.flightPax = body.flightPax;
    if (body.discountPct !== undefined) data.discountPct = body.discountPct;
    if (body.groundDiscount !== undefined) data.groundDiscount = new Prisma.Decimal(body.groundDiscount);
    if (body.suitableFor !== undefined) data.suitableFor = body.suitableFor;
    if (body.hotelRoomTypeId !== undefined) data.hotelRoomTypeId = body.hotelRoomTypeId;
    if (body.hotelNights !== undefined) data.hotelNights = body.hotelNights;
    // 套餐绑定去/回程航班号：列可空，null = 解除绑定、undefined = 不改（与 hotelRoomTypeId 同款可空口径）
    if (body.outboundFlightId !== undefined) data.outboundFlightId = body.outboundFlightId;
    if (body.returnFlightId !== undefined) data.returnFlightId = body.returnFlightId;
    // 写入不变量：仅当本次在改 items 时，按新 items 的 HOTEL 组件 qty 规范化/覆盖 hotelNights
    // （即便请求显式传了别的 hotelNights，也以真实 HOTEL.qty 为准；legacy null 行借此自愈）。
    // 新 items 无 HOTEL 组件 → 不动 hotelNights，保留上面按 body.hotelNights 的处理。
    if (body.items !== undefined) {
      const derived = deriveHotelNightsFromItems(body.items);
      if (derived !== undefined) data.hotelNights = derived;
    }
    // 单房差 / 儿童差价：用 !== undefined 区分「请求没带这个字段（不改）」与「显式传 null（运营清空
    // 输入框，前端占位符承诺"留空=用默认"）」。显式 null → 写回文档承诺的默认值（列非空、不能落 null，
    // 且 DB @default 只在 INSERT 生效，UPDATE 不会自动回落）。这兑现了前端「留空=用默认 ¥80/¥30」。
    if (body.singleSupplementCnyPerNight !== undefined) {
      data.singleSupplementCnyPerNight =
        body.singleSupplementCnyPerNight ?? DEFAULT_SINGLE_SUPPLEMENT_CNY_PER_NIGHT;
    }
    // 升舱差价：key 省略（undefined）= 不改，保留现值；key 显式给值则写入 —— 含 null=「跟随航班」、
    // 数值=套餐自有覆盖（含 0=不提供升舱）。用 !== undefined 区分「没传」与「显式传 null」，让运营能把
    // 已有套餐改回「跟随航班」。
    if (body.businessUpgradeCnyPerLeg !== undefined) {
      data.businessUpgradeCnyPerLeg = body.businessUpgradeCnyPerLeg;
    }
    if (body.childSeatDiscountCnyPerPerson !== undefined) {
      data.childSeatDiscountCnyPerPerson =
        body.childSeatDiscountCnyPerPerson ?? DEFAULT_CHILD_SEAT_DISCOUNT_CNY_PER_PERSON;
    }
    if (body.infantPriceCny != null) {
      data.infantPriceCny = body.infantPriceCny;
    }
    if (body.selfVisaDeductCny != null) {
      data.selfVisaDeductCny = body.selfVisaDeductCny;
    }
    if (body.operationFeeCny != null) {
      data.operationFeeCny = body.operationFeeCny;
    }
    if (body.legs !== undefined) data.legs = body.legs;
    if (body.blackoutDates !== undefined) {
      data.blackoutDates = body.blackoutDates as unknown as Prisma.InputJsonValue;
    }
    if (body.defaultDepartDate !== undefined) data.defaultDepartDate = body.defaultDepartDate;
    // 管理端可编辑排序值：省略 = 不改；显式 null = 清空（排到最后）。
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const b = await prisma.bundle.update({
      where: { id },
      data,
      include: BUNDLE_ROOM_INCLUDE,
    });
    // 与 getBundle/listBundles/createBundle 同口径喂机票参考价（按更新后生效的绑定航班取价）。
    const flightRef = await getCheapestRoundTripEconomyCny(new Date(), {
      outboundFlightId: b.outboundFlightId,
      returnFlightId: b.returnFlightId,
    });
    return serializeBundle(b, ZERO_RATING, flightRef);
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

  /**
   * 校验套餐绑定的航班存在（null/undefined 跳过 —— null = 解绑）。
   * 在写库前显式校验，给出干净的 404「所选航班不存在」，而非依赖 Prisma 原始外键错误。
   */
  private async assertFlightExists(flightId: string | null | undefined) {
    if (!flightId) return;
    const flight = await prisma.flight.findUnique({
      where: { id: flightId },
      select: { id: true },
    });
    if (!flight) throw new NotFoundError('所选航班不存在');
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
//
// includeCost（0702 后台反馈 6·成本泄漏修复）：costPriceCny 是内部结算成本，不是给匿名/游客看的字段。
// 默认 true —— create/update 这几条写路径（已在路由层用 adminPre 强制 ADMIN/STAFF）继续无脑下发，
// 不用逐个改调用点；唯二会显式传 false 的是 list/get 这几条公开只读路由，按 req.user 角色现算
// （见 products.routes.ts isCostVisible）。false 时直接不放这个 key，而不是塞 null —— 防止「反正都能
// 看到 key，null 判断松了照样能探出「有没有录成本」」这种旁路信息泄漏。
export function serializeHotel(
  h: HotelWithRooms,
  rating: ProductRatingAggregate = ZERO_RATING,
  includeCost = true,
) {
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
    roomTypes: h.roomTypes.map((rt) => {
      const { costPriceCny, ...rtRest } = rt;
      return {
        ...rtRest,
        basePrice: rt.basePrice.toString(),
        priceMultiplier: rt.priceMultiplier?.toString() ?? null,
        ...(includeCost ? { costPriceCny: costPriceCny?.toString() ?? null } : {}),
      };
    }),
  };
}

export function serializeTransfer(
  t: Prisma.TransferGetPayload<Record<string, never>>,
  rating: ProductRatingAggregate = ZERO_RATING,
  includeCost = true,
) {
  const { costPriceCny, ...rest } = t;
  return {
    ...rest,
    basePrice: t.basePrice.toString(),
    ...(includeCost ? { costPriceCny: costPriceCny?.toString() ?? null } : {}),
    rating,
    reviewCount: rating.count,
    soldCount: t.soldCount,
  };
}

export function serializeVisa(
  v: Prisma.VisaGetPayload<Record<string, never>>,
  rating: ProductRatingAggregate = ZERO_RATING,
  includeCost = true,
) {
  const { costPriceCny, ...rest } = v;
  return {
    ...rest,
    basePrice: v.basePrice.toString(),
    expressSurcharge: v.expressSurcharge?.toString() ?? null,
    ...(includeCost ? { costPriceCny: costPriceCny?.toString() ?? null } : {}),
    // 单次入境最多可停留天数（订单详情行程单据此推算签证生效/失效预计日期）
    stayDays: v.stayDays,
    rating,
    reviewCount: rating.count,
    soldCount: v.soldCount,
  };
}

/**
 * Bundle 序列化 — admin 编辑器的定价 CONTRACT（本次改版新增/变更的字段见下方注释）：
 *
 *   originalPerPaxCny  — 起价 / 人（1 人 · 半间房拼房口径，唯一权威）；见 bundle-pricing 里的公式与出处。
 *                        本次改版起含每人操作费（operationFeeCny，起价按 1 人加一次）。
 *   operationFeeCny    — 每人操作费（CNY，计入起价/人 + 下单按人头收）；随 ...rest 下发，admin 表单读回编辑。
 *   originalAllInCny   — [未变] 整包原价锚点（地面 1 间房 + 机票×flightPax），admin-web 仍用它反推展示用机票价。
 *   discountPct        — [未变] 套餐唯一折扣杠杆。
 *   items[].unitPrice  — 服务端权威定价（HOTEL 已关联房型 / TRANSFER / VISA 均为产品价，只读展示）。
 *   items[].transferId / items[].visaId — 组件关联的产品 id（写入时校验存在，读回供 admin 编辑器回显选中项）。
 *   hotelRoomType.id            — 即 hotelRoomTypeId（已在 ...rest 里，此处 hotelRoomType 对象额外带全名/容量展示）。
 *   hotelRoomType.nightlyPriceCny — 房型整间夜价（¥/晚，服务端权威取价源）—— 明确不预先打 0.5，
 *                                    0.5 拼房折算只在 originalPerPaxCny 内部生效，这里展示的是整间价。
 */
function serializeBundle(
  b: BundleWithRoom,
  rating: ProductRatingAggregate = ZERO_RATING,
  flightRefRoundTripCny: number | null = null,
) {
  const { hotelRoomType, outboundFlight, returnFlight, ...rest } = b;
  const bItems = Array.isArray(b.items) ? (b.items as Array<{ kind: string; qty: number; unitPrice: number }>) : [];
  // 机票参考价缺失（无可估来回经济舱班次）→ 原价/起价里机票项静默按 0 计（见 bundle-pricing
  //   computeBundleOriginalAllInCny / computeBundleOriginalPerPaxCny）。纯函数拿不到 logger 也没有 bundleId
  //   上下文，故在此调用方按仓库惯例（console.warn '[products]'）留痕，带 bundleId/绑定航班，便于排查
  //   「套餐起价缺机票」这类静默降级（不阻断序列化，只是可观测）。
  if (flightRefRoundTripCny == null) {
    console.warn('[products] bundle flight reference price unavailable → flight priced as 0 in original/per-pax', {
      bundleId: b.id,
      outboundFlightId: b.outboundFlightId ?? null,
      returnFlightId: b.returnFlightId ?? null,
    });
  }
  // 原价（含当前最低来回机票）：后台「想卖的价格」录入据此反推 discountPct + 展示「原价划线/省X%」。
  // 估算锚点，不参与买家实际计价（买家价 = 实时全包 ×(1 − discountPct/100)）。公式/口径未变。
  const originalAllInCny = computeBundleOriginalAllInCny(bItems, b.flightPax, flightRefRoundTripCny);
  // 起价 / 人：1 人 · 半间房拼房口径（唯一权威，见 bundle-pricing computeBundleOriginalPerPaxCny）。
  // 与 originalAllInCny 是两条独立口径，不再用 originalAllInCny / flightPax 派生。
  const nights = resolveBundleNights(b.items, b.hotelNights);
  const originalPerPaxCny = computeBundleOriginalPerPaxCny({
    items: bItems,
    nights,
    hotelRoomTypeNightlyCny: hotelRoomType ? Number(hotelRoomType.basePrice) : null,
    flightRoundTripPerPaxCny: flightRefRoundTripCny,
    operationFeePerPaxCny: b.operationFeeCny,
  });
  return {
    ...rest,
    // 套餐折扣（%）：整个全包价 ×(1 − discountPct/100)，前台据此展示原价划线/省X%
    discountPct: b.discountPct,
    // 原价（含当前最低来回机票，整包/flightPax 均分口径，未变）+ 起价/人（1人半间房，本次改版新公式）；
    // 后台目标价↔折扣% 换算、以及套餐卡「¥X 起/人」展示均用 originalPerPaxCny。
    originalAllInCny,
    originalPerPaxCny,
    groundDiscount: b.groundDiscount.toString(),
    // 服务内容（订单详情行程单「服务内容」板块；每行一条，admin 表单读回编辑）
    serviceNotes: b.serviceNotes,
    // 可选升级加价（CNY，整数，server-priced add-on）+ 航段数；前端据此报价升级项
    singleSupplementCnyPerNight: b.singleSupplementCnyPerNight,
    businessUpgradeCnyPerLeg: b.businessUpgradeCnyPerLeg,
    // 占座儿童折扣 / 婴儿价（CNY，整数，server-priced）；前端据此报价儿童/婴儿
    childSeatDiscountCnyPerPerson: b.childSeatDiscountCnyPerPerson,
    infantPriceCny: b.infantPriceCny,
    // 自备签证可减额（CNY，整数）；admin 表单读回
    selfVisaDeductCny: b.selfVisaDeductCny,
    legs: b.legs,
    // 运营封盘日（按出发日 D；admin 读回）+ 前台默认出发日（仅影响初始选中）
    blackoutDates: b.blackoutDates,
    defaultDepartDate: b.defaultDepartDate,
    // 组件明细：unitPrice 已是服务端权威产品价（只读展示，非运营手填）；
    // TRANSFER/VISA 行带 transferId/visaId（关联产品 id，供 admin 编辑器回显选中项 + 换产品时重新取价）。
    items: b.items,
    rating,
    reviewCount: rating.count,
    soldCount: b.soldCount,
    // admin-web 表单需要房型名 + 酒店名做展示；前台用 capacity/maxAdults/maxChildren 镜像 roomsNeeded。
    // nightlyPriceCny：整间夜价只读展示（¥/晚，非半价）——hotelRoomTypeId 本身已在 ...rest 里。
    hotelRoomType: hotelRoomType
      ? {
          id: hotelRoomType.id,
          name: hotelRoomType.name,
          hotelName: hotelRoomType.hotel.name,
          capacity: hotelRoomType.capacity,
          maxAdults: hotelRoomType.maxAdults,
          maxChildren: hotelRoomType.maxChildren,
          nightlyPriceCny: Number(hotelRoomType.basePrice),
        }
      : null,
    // 套餐绑定的去/回程航班号（各含 id + 航班号 + 起降地）；未绑 = null。
    // 后台读回做展示/编辑；前台买家选出发日后按航班号 + 本地出发日解析具体班次。
    outboundFlight: outboundFlight ?? null,
    returnFlight: returnFlight ?? null,
  };
}
