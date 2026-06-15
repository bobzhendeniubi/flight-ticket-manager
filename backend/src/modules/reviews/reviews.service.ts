/**
 * 评价服务（D1）。
 *
 * - listReviews：公开分页 + 汇总（average/count/distribution），最新优先。
 * - getAggregate(s)：给产品列表/详情用的 { average, count } 聚合（D3）。
 * - createOrderReview：订单完成后提交评价（verified:true）。登录用户用 token 校验
 *   订单归属；游客需 orderNumber+phone 与订单匹配。缺省 productType/productId 时
 *   对订单里所有可评产品各建一条。
 */
import { OrderItemKind, ProductReviewType, type Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { maskFamilyName } from '../orders/orders.service.js';
import type { CreateOrderReviewBody, ListReviewsQuery } from './reviews.schemas.js';

export interface ReviewSummary {
  average: number;
  count: number;
  distribution: Record<'5' | '4' | '3' | '2' | '1', number>;
}

export interface ProductRatingAggregate {
  average: number;
  count: number;
}

// OrderItemKind → ProductReviewType（仅可评产品；FEE/DISCOUNT/INSURANCE 等不可评）
const ITEM_KIND_TO_REVIEW_TYPE: Partial<Record<OrderItemKind, ProductReviewType>> = {
  BUNDLE: ProductReviewType.BUNDLE,
  HOTEL: ProductReviewType.HOTEL,
  TRANSFER: ProductReviewType.TRANSFER,
  VISA: ProductReviewType.VISA,
  FLIGHT: ProductReviewType.FLIGHT,
};

export class ReviewsService {
  // ══════════════════════════════════════════════════════════════════
  // 列表 + 汇总（公开）
  // ══════════════════════════════════════════════════════════════════
  async listReviews(query: ListReviewsQuery) {
    const where: Prisma.ReviewWhereInput = {
      productType: query.productType,
      productId: query.productId,
    };
    const [items, total, summary] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: (query.page - 1) * query.limit,
      }),
      prisma.review.count({ where }),
      this.computeSummary(query.productType, query.productId),
    ]);

    return {
      items,
      total,
      page: query.page,
      limit: query.limit,
      summary,
    };
  }

  /** 单产品评分汇总（average/count/分布）。 */
  async computeSummary(productType: ProductReviewType, productId: string): Promise<ReviewSummary> {
    const grouped = await prisma.review.groupBy({
      by: ['rating'],
      where: { productType, productId },
      _count: { _all: true },
    });
    const distribution: ReviewSummary['distribution'] = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
    let count = 0;
    let sum = 0;
    for (const g of grouped) {
      const n = g._count._all;
      const r = g.rating;
      if (r >= 1 && r <= 5) distribution[String(r) as keyof ReviewSummary['distribution']] = n;
      count += n;
      sum += r * n;
    }
    const average = count > 0 ? Math.round((sum / count) * 10) / 10 : 0;
    return { average, count, distribution };
  }

  // ══════════════════════════════════════════════════════════════════
  // 产品聚合（D3）— 给产品列表/详情用，一次批量查多产品
  // ══════════════════════════════════════════════════════════════════
  /** 批量取某 type 下多个 productId 的 { average, count }；缺省产品返回 {0,0}。 */
  async getAggregates(
    productType: ProductReviewType,
    productIds: string[],
  ): Promise<Map<string, ProductRatingAggregate>> {
    const map = new Map<string, ProductRatingAggregate>();
    for (const id of productIds) map.set(id, { average: 0, count: 0 });
    if (productIds.length === 0) return map;

    const grouped = await prisma.review.groupBy({
      by: ['productId'],
      where: { productType, productId: { in: productIds } },
      _avg: { rating: true },
      _count: { _all: true },
    });
    for (const g of grouped) {
      map.set(g.productId, {
        average: g._avg.rating ? Math.round(g._avg.rating * 10) / 10 : 0,
        count: g._count._all,
      });
    }
    return map;
  }

  // ══════════════════════════════════════════════════════════════════
  // 订单后提交评价（verified:true）
  // ══════════════════════════════════════════════════════════════════
  async createOrderReview(
    orderId: string,
    body: CreateOrderReviewBody,
    auth: { userId: string } | null,
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // 权限：登录用户必须是订单本人；游客必须 orderNumber+phone 匹配
    if (auth) {
      if (order.userId !== auth.userId) throw new ForbiddenError('无权评价该订单');
    } else {
      const okOrderNumber = Boolean(body.orderNumber) && body.orderNumber === order.orderNumber;
      const phone = body.phone?.trim();
      const orderPhones = [order.guestPhone, order.contactPhone]
        .filter((v): v is string => Boolean(v))
        .map((v) => v.trim());
      const okPhone = Boolean(phone) && orderPhones.includes(phone!);
      if (!okOrderNumber || !okPhone) {
        throw new ForbiddenError('游客评价需提供与订单匹配的订单号与手机号');
      }
    }

    // 作者展示名：登录用 displayName，游客用联系人；统一脱敏
    const authorRaw = order.guestName ?? order.contactName ?? '匿名用户';
    const authorName = maskFamilyName(authorRaw);

    // 决定要评价哪些 (productType, productId)
    const targets = this.resolveReviewTargets(order.items, body);
    if (targets.length === 0) {
      throw new BadRequestError('该订单没有可评价的产品，或指定的产品不在订单内');
    }

    const created = await prisma.$transaction(
      targets.map((t) =>
        prisma.review.create({
          data: {
            productType: t.productType,
            productId: t.productId,
            rating: body.rating,
            title: body.title ?? null,
            body: body.body,
            authorName,
            verified: true,
            tripType: body.tripType ?? null,
            orderId: order.id,
          },
        }),
      ),
    );
    return { created };
  }

  /**
   * 从订单行解出可评价目标：
   * - 指定 productType+productId → 校验确实在订单内，单条；
   * - 未指定 → 订单里全部可评产品各一条（去重）。
   * productId 取该 kind 对应的产品 id（BUNDLE→bundleId 等；FLIGHT→flightScheduleId）。
   */
  private resolveReviewTargets(
    items: Array<{
      kind: OrderItemKind;
      bundleId: string | null;
      hotelRoomTypeId: string | null;
      transferId: string | null;
      visaId: string | null;
      flightScheduleId: string | null;
    }>,
    body: CreateOrderReviewBody,
  ): Array<{ productType: ProductReviewType; productId: string }> {
    const all = new Map<string, { productType: ProductReviewType; productId: string }>();
    for (const it of items) {
      const productType = ITEM_KIND_TO_REVIEW_TYPE[it.kind];
      if (!productType) continue;
      const productId = this.itemProductId(it);
      if (!productId) continue;
      all.set(`${productType}:${productId}`, { productType, productId });
    }

    if (body.productType && body.productId) {
      const key = `${body.productType}:${body.productId}`;
      return all.has(key) ? [all.get(key)!] : [];
    }
    return [...all.values()];
  }

  private itemProductId(it: {
    kind: OrderItemKind;
    bundleId: string | null;
    hotelRoomTypeId: string | null;
    transferId: string | null;
    visaId: string | null;
    flightScheduleId: string | null;
  }): string | null {
    switch (it.kind) {
      case OrderItemKind.BUNDLE:
        return it.bundleId;
      case OrderItemKind.HOTEL:
        return it.hotelRoomTypeId;
      case OrderItemKind.TRANSFER:
        return it.transferId;
      case OrderItemKind.VISA:
        return it.visaId;
      case OrderItemKind.FLIGHT:
        return it.flightScheduleId;
      default:
        return null;
    }
  }
}
