/**
 * 订单评价准入单测（C-3）。
 *
 * 覆盖：
 *   - 订单状态门槛：只有已成行（已出票 / 已完成 / 已改期）能评价
 *   - 未出行（草稿/待支付/处理中）与已取消/已退款一律拒绝
 *   - 回收站单不能评价
 *   - 同一订单同一产品重复评价撞唯一约束 → 409
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, ProductReviewType } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  order: { findUnique: vi.fn() },
  review: { create: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

// 只借 maskFamilyName 一个纯函数，不为此把整个订单服务拉进单测
vi.mock('../orders/orders.service.js', () => ({ maskFamilyName: (s: string) => s }));

import { ReviewsService } from './reviews.service.js';

const BODY = { rating: 5, body: '很好', orderNumber: 'FTM2026090100001', phone: '13800000000' };

function orderRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'o1',
    orderNumber: 'FTM2026090100001',
    status: OrderStatus.TICKETED,
    deletedAt: null,
    userId: null,
    guestName: '张三',
    guestPhone: '13800000000',
    contactName: null,
    contactPhone: null,
    items: [
      {
        kind: OrderItemKind.BUNDLE,
        bundleId: 'b1',
        hotelRoomTypeId: null,
        transferId: null,
        visaId: null,
        flightScheduleId: null,
      },
    ],
    ...over,
  };
}

describe('createOrderReview 订单状态门槛', () => {
  const service = new ReviewsService();

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
    prismaMock.review.create.mockResolvedValue({ id: 'rv1' });
  });

  it.each([OrderStatus.TICKETED, OrderStatus.COMPLETED, OrderStatus.CHANGED])(
    '已成行状态 %s 可以评价',
    async (status) => {
      prismaMock.order.findUnique.mockResolvedValue(orderRow({ status }));

      const out = await service.createOrderReview('o1', BODY, null);
      expect(out.created).toHaveLength(1);
    },
  );

  it.each([
    OrderStatus.DRAFT,
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAID,
    OrderStatus.PROCESSING,
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
    OrderStatus.PAYMENT_TIMEOUT,
  ])('未成行/已终止状态 %s 不能评价', async (status) => {
    prismaMock.order.findUnique.mockResolvedValue(orderRow({ status }));

    await expect(service.createOrderReview('o1', BODY, null)).rejects.toThrow(/出行/);
    expect(prismaMock.review.create).not.toHaveBeenCalled();
  });

  it('回收站里的单不能评价', async () => {
    prismaMock.order.findUnique.mockResolvedValue(
      orderRow({ deletedAt: new Date('2026-09-01T00:00:00.000Z') }),
    );

    await expect(service.createOrderReview('o1', BODY, null)).rejects.toThrow(/订单不存在/);
  });
});

describe('createOrderReview 重复评价', () => {
  const service = new ReviewsService();

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.order.findUnique.mockResolvedValue(orderRow());
  });

  it('同一订单同一产品再评一次 → 409', async () => {
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.createOrderReview(
        'o1',
        { ...BODY, productType: ProductReviewType.BUNDLE, productId: 'b1' },
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
