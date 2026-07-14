/**
 * getFinancesSummary · 单元测试（vitest）
 *
 * 覆盖点（本次修复）：
 *   1. REFUNDED 订单的已收-已退净额计入 revenueCny / revenueBreakdown.refund，
 *      而不是整单从统计消失（先收后退长期对不平的 bug）。
 *   2. 全额退款（净额=0）仍显式体现为 0，不是被过滤掉。
 *   3. 多笔 REFUNDED 订单净额正确累加。
 *   4. REFUNDED 订单不影响 costCny / costBreakdown / categories（分品类结构不变，
 *      口径上刻意的最小侵入取舍）。
 *   5. 退款金额超过实收（数据异常）时保留真实负数，不做 clamp。
 *
 * 注入 fake PrismaClient（getFinancesSummary 支持 client 参数）：
 *   - order.findMany 按 where.status 的形状区分两次调用：
 *     · { in: COUNTED_STATUSES } → 主口径订单（按 OrderItem 展开分品类）
 *     · 'REFUNDED'                → 已收-已退净额来源
 *   - flightSchedule.findMany（空座沉没成本）固定回空数组——测试用例都不含 FLIGHT 行，
 *     用不到，避免整个 fixture 被航班座位细节稀释掉本次要覆盖的口径本身。
 */
import { describe, it, expect, vi } from 'vitest';

// 默认 prisma 不参与（全部走注入 client）—— 仍需 mock 掉避免真实连接配置
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { getFinancesSummary } from './finances.service.js';

const RANGE = { from: '2026-01-01', to: '2026-01-31' };

interface RefundedOrderFixture {
  paidAmount: number;
  refunds: { amount: number }[];
}

interface CountedOrderItemFixture {
  kind: string;
  amount: number;
  quantity: number;
  totalCostCny: number | null;
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
  flightSchedule: null;
  hotelRoomType: null;
  visa: null;
  transfer: null;
}

interface CountedOrderFixture {
  id: string;
  total: number;
  passengers: { id: string }[];
  costItems: { category: string; amountCny: number }[];
  items: CountedOrderItemFixture[];
}

function hotelItem(amount: number, totalCostCny: number | null): CountedOrderItemFixture {
  return {
    kind: 'HOTEL',
    amount,
    quantity: 1,
    totalCostCny,
    hotelCheckIn: null,
    hotelCheckOut: null,
    flightSchedule: null,
    hotelRoomType: null,
    visa: null,
    transfer: null,
  };
}

function fakeClient(opts: {
  countedOrders?: CountedOrderFixture[];
  refundedOrders?: RefundedOrderFixture[];
}): PrismaClient {
  const countedOrders = opts.countedOrders ?? [];
  const refundedOrders = opts.refundedOrders ?? [];
  return {
    order: {
      findMany: vi.fn(async (args: { where: { status?: unknown } }) => {
        const status = args.where.status;
        if (status && typeof status === 'object' && 'in' in (status as Record<string, unknown>)) {
          return countedOrders;
        }
        if (status === 'REFUNDED') return refundedOrders;
        return [];
      }),
    },
    flightSchedule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    flightCostPeriod: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

describe('getFinancesSummary — REFUNDED 订单已收-已退净额', () => {
  it('先收后退（部分退款）：净额计入 revenue，而不是从统计消失', async () => {
    const client = fakeClient({
      refundedOrders: [{ paidAmount: 1000, refunds: [{ amount: 300 }] }], // 净留存 700
    });
    const summary = await getFinancesSummary(RANGE, client);

    expect(summary.revenueBreakdown.refund).toBe(700);
    expect(summary.revenueCny).toBe(700);
    expect(summary.revenueBreakdown.total).toBe(700);
    expect(summary.costCny).toBe(0);
    expect(summary.grossMarginCny).toBe(700);
    // REFUNDED 订单不计入主口径订单数（只贡献 revenueBreakdown.refund 这一笔净额）
    expect(summary.orderCount).toBe(0);
  });

  it('全额退款：净额为 0，仍显式体现在 revenueBreakdown.refund（不是被过滤掉）', async () => {
    const client = fakeClient({
      refundedOrders: [{ paidAmount: 1000, refunds: [{ amount: 1000 }] }],
    });
    const summary = await getFinancesSummary(RANGE, client);

    expect(summary.revenueBreakdown.refund).toBe(0);
    expect(summary.revenueCny).toBe(0);
    // 字段存在且为数字 0，不是 undefined/缺省——证明不是被静默丢弃
    expect(typeof summary.revenueBreakdown.refund).toBe('number');
  });

  it('多笔 REFUNDED 订单：净额逐单累加', async () => {
    const client = fakeClient({
      refundedOrders: [
        { paidAmount: 1000, refunds: [{ amount: 700 }] }, // 净 300
        { paidAmount: 500, refunds: [{ amount: 500 }] }, // 净 0
        { paidAmount: 200, refunds: [] }, // 未查到已完成退款记录 → 净 200（如实反映，不臆测）
      ],
    });
    const summary = await getFinancesSummary(RANGE, client);

    expect(summary.revenueBreakdown.refund).toBe(500);
    expect(summary.revenueCny).toBe(500);
  });

  it('REFUNDED 订单净额不影响 costCny/costBreakdown/categories（分品类结构不变）', async () => {
    const countedOrders: CountedOrderFixture[] = [
      {
        id: 'o1',
        total: 1000,
        passengers: [{ id: 'p1' }],
        costItems: [],
        items: [hotelItem(1000, 400)],
      },
    ];
    const client = fakeClient({
      countedOrders,
      refundedOrders: [{ paidAmount: 2000, refunds: [{ amount: 500 }] }], // 净 1500
    });
    const summary = await getFinancesSummary(RANGE, client);

    // costCny / costBreakdown 只反映主口径订单的成本快照，REFUNDED 订单不参与
    expect(summary.costCny).toBe(400);
    expect(summary.costBreakdown.hotel).toBe(400);
    expect(summary.costBreakdown.total).toBe(400);

    // revenue 侧：主口径 1000（HOTEL）+ REFUNDED 净额 1500
    expect(summary.revenueCny).toBe(2500);
    expect(summary.revenueBreakdown.hotel).toBe(1000);
    expect(summary.revenueBreakdown.refund).toBe(1500);
    expect(summary.revenueBreakdown.total).toBe(2500);

    // 旧 UI 兼容的 categories 按 OrderItem.kind 分组，不含 REFUNDED 净额（预期的口径差异，非 bug）
    expect(summary.categories).toEqual([
      expect.objectContaining({ kind: 'HOTEL', revenueCny: 1000, costCny: 400, orderItemCount: 1 }),
    ]);

    expect(summary.orderCount).toBe(1);
  });

  it('退款金额超过实收（数据异常）：保留真实负数，不 clamp', async () => {
    const client = fakeClient({
      refundedOrders: [{ paidAmount: 500, refunds: [{ amount: 800 }] }], // 净 -300，异常但如实反映
    });
    const summary = await getFinancesSummary(RANGE, client);

    expect(summary.revenueBreakdown.refund).toBe(-300);
    expect(summary.revenueCny).toBe(-300);
  });
});
