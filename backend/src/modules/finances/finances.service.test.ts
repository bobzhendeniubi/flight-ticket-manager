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
import {
  getFinancesSummary,
  getMonthlyTrend,
  getOrderPnlDetail,
  visaItemCostCny,
} from './finances.service.js';

describe('visaItemCostCny — 签证成本取值口径（财务汇总/导出共用，两处逐字一致）', () => {
  it('任务填了结构化人均成本 → visaUnitCostCny × 需签乘客数（新口径优先，压过快照/产品）', () => {
    expect(
      visaItemCostCny({
        taskUnitCostCny: 226.8,
        visaPax: 7,
        snapshotCny: 9999, // 有快照也被结构化实际成本压过
        productCostPriceCny: 300,
        quantity: 5,
      }),
    ).toEqual({ cost: 226.8 * 7, source: 'TASK' });
  });

  it('任务没填 → 回退录单成本快照 totalCostCny（若有）', () => {
    expect(
      visaItemCostCny({
        taskUnitCostCny: null,
        visaPax: 7,
        snapshotCny: 1500,
        productCostPriceCny: 300,
        quantity: 5,
      }),
    ).toEqual({ cost: 1500, source: 'SNAPSHOT' });
  });

  it('任务没填 + 无快照 → 回退产品主数据 costPriceCny × quantity（现行口径，不算成 0）', () => {
    expect(
      visaItemCostCny({
        taskUnitCostCny: null,
        visaPax: 7,
        snapshotCny: null,
        productCostPriceCny: 300,
        quantity: 5,
      }),
    ).toEqual({ cost: 300 * 5, source: 'PRODUCT' });
  });

  it('导出侧无快照（snapshotCny=null）→ 任务优先，否则产品口径（与汇总的 TASK 分支一致）', () => {
    // 有任务成本：与汇总侧 TASK 分支同口径
    expect(
      visaItemCostCny({
        taskUnitCostCny: 100,
        visaPax: 3,
        snapshotCny: null,
        productCostPriceCny: 300,
        quantity: 5,
      }),
    ).toEqual({ cost: 300, source: 'TASK' });
    // 无任务成本：回退产品
    expect(
      visaItemCostCny({
        taskUnitCostCny: null,
        visaPax: 3,
        snapshotCny: null,
        productCostPriceCny: 300,
        quantity: 5,
      }),
    ).toEqual({ cost: 1500, source: 'PRODUCT' });
  });

  it('三来源皆无 → 0 且标记 NONE（缺成本，不静默当 0 入账）', () => {
    expect(
      visaItemCostCny({
        taskUnitCostCny: null,
        visaPax: 7,
        snapshotCny: null,
        productCostPriceCny: null,
        quantity: 5,
      }),
    ).toEqual({ cost: 0, source: 'NONE' });
  });
});

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
  visa: { costPriceCny: number | null } | null;
  transfer: null;
  fulfillmentTasks?: { visaUnitCostCny: number | null }[];
}

interface CountedOrderFixture {
  id: string;
  total: number;
  passengers: { id: string; visaExempt?: boolean }[];
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

/** 签证 item 构造：可带任务结构化成本（taskUnitCostCny）与产品主数据成本（productCostPriceCny）。 */
function visaItem(opts: {
  amount: number;
  quantity: number;
  totalCostCny?: number | null;
  taskUnitCostCny?: number | null;
  productCostPriceCny?: number | null;
}): CountedOrderItemFixture {
  return {
    kind: 'VISA',
    amount: opts.amount,
    quantity: opts.quantity,
    totalCostCny: opts.totalCostCny ?? null,
    hotelCheckIn: null,
    hotelCheckOut: null,
    flightSchedule: null,
    hotelRoomType: null,
    visa: opts.productCostPriceCny != null ? { costPriceCny: opts.productCostPriceCny } : null,
    transfer: null,
    fulfillmentTasks:
      opts.taskUnitCostCny !== undefined ? [{ visaUnitCostCny: opts.taskUnitCostCny }] : [],
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

describe('getFinancesSummary — 签证成本按任务实际成本（人均×需签数）优先', () => {
  it('签证任务填了人均成本 → visa 成本 = visaUnitCostCny × 需签乘客数（压过产品主数据）', async () => {
    const client = fakeClient({
      countedOrders: [
        {
          id: 'o1',
          total: 5000,
          // 3 人需签 + 1 人自备签（visaExempt）→ 需签乘客数 = 3
          passengers: [
            { id: 'p1', visaExempt: false },
            { id: 'p2', visaExempt: false },
            { id: 'p3', visaExempt: false },
            { id: 'p4', visaExempt: true },
          ],
          costItems: [],
          items: [
            visaItem({
              amount: 5000,
              quantity: 4,
              taskUnitCostCny: 226.8, // 结构化实际成本
              productCostPriceCny: 300, // 产品主数据（应被压过）
            }),
          ],
        },
      ],
    });
    const summary = await getFinancesSummary(RANGE, client);

    // 226.8 × 3 = 680.4（而非产品口径 300 × 4 = 1200）
    expect(summary.costBreakdown.visa).toBe(680.4);
  });

  it('签证任务未填 → 回退产品主数据 costPriceCny × quantity（不算成 0）', async () => {
    const client = fakeClient({
      countedOrders: [
        {
          id: 'o1',
          total: 5000,
          passengers: [
            { id: 'p1', visaExempt: false },
            { id: 'p2', visaExempt: false },
          ],
          costItems: [],
          items: [
            visaItem({
              amount: 5000,
              quantity: 2,
              taskUnitCostCny: null, // 任务未填
              productCostPriceCny: 300,
            }),
          ],
        },
      ],
    });
    const summary = await getFinancesSummary(RANGE, client);

    // 回退产品口径：300 × 2 = 600
    expect(summary.costBreakdown.visa).toBe(600);
  });
});

describe('getMonthlyTrend — 缺成本 → 毛利 null（未知，非 0）', () => {
  function trendClient(items: { amount: number; totalCostCny: number | null }[]): PrismaClient {
    return {
      order: {
        // n=1 → 只查当月一次；返回同一批订单项即可
        findMany: vi.fn(async () => [{ items }]),
      },
    } as unknown as PrismaClient;
  }

  it('全部有成本 → 毛利 = 收入 − 成本，missingCostItemCount = 0', async () => {
    const points = await getMonthlyTrend(1, trendClient([
      { amount: 1000, totalCostCny: 600 },
      { amount: 500, totalCostCny: 200 },
    ]));
    expect(points).toHaveLength(1);
    expect(points[0].revenueCny).toBe(1500);
    expect(points[0].costCny).toBe(800);
    expect(points[0].grossMarginCny).toBe(700);
    expect(points[0].missingCostItemCount).toBe(0);
  });

  it('有一件缺成本 → 毛利 null，不把缺失当 0 造成虚高', async () => {
    const points = await getMonthlyTrend(1, trendClient([
      { amount: 1000, totalCostCny: 600 },
      { amount: 500, totalCostCny: null }, // 缺成本
    ]));
    // 收入/成本仍如实累加（成本只累加已知件）
    expect(points[0].revenueCny).toBe(1500);
    expect(points[0].costCny).toBe(600);
    // 但毛利不显示 900（=1500−600 的虚高值），而是 null
    expect(points[0].grossMarginCny).toBeNull();
    expect(points[0].missingCostItemCount).toBe(1);
  });
});

// ── getOrderPnlDetail —— 单订单收支明细下钻 ──────────────────────────────────
interface DetailItemFixture {
  kind: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  totalCostCny: number | null;
  metadata: Record<string, unknown> | null;
  flightSchedule: { departureTime: Date } | null;
}

interface DetailOrderFixture {
  id: string;
  orderNumber: string;
  status: string;
  contactName: string;
  total: number;
  createdAt: Date;
  agent: { companyName: string | null; contactName: string | null } | null;
  costItems: { category: string; amountCny: number; note: string | null }[];
  items: DetailItemFixture[];
}

function detailItem(p: Partial<DetailItemFixture>): DetailItemFixture {
  return {
    kind: p.kind ?? 'HOTEL',
    description: p.description ?? '房费',
    quantity: p.quantity ?? 1,
    unitPrice: p.unitPrice ?? 0,
    amount: p.amount ?? 0,
    totalCostCny: p.totalCostCny === undefined ? 0 : p.totalCostCny,
    metadata: p.metadata ?? null,
    flightSchedule: p.flightSchedule ?? null,
  };
}

function detailClient(order: DetailOrderFixture | null): PrismaClient {
  return {
    order: {
      findFirst: vi.fn(async () => order),
    },
  } as unknown as PrismaClient;
}

describe('getOrderPnlDetail — 单订单收支明细', () => {
  it('全部有成本：收入逐项 + 成本逐项 + 杂项逐条；毛利与列表口径一致（不含杂项）', async () => {
    const order: DetailOrderFixture = {
      id: 'o1',
      orderNumber: 'FTM2026072200001',
      status: 'PAID',
      contactName: '张三',
      total: 12800,
      createdAt: new Date('2026-07-22T02:00:00Z'),
      agent: { companyName: '某旅行社', contactName: null },
      costItems: [
        { category: 'OPERATION_FEE', amountCny: 200, note: null },
        { category: 'GUIDE_SERVICE', amountCny: 300, note: '含小费' },
      ],
      items: [
        detailItem({
          kind: 'FLIGHT',
          description: '去程机票',
          quantity: 2,
          unitPrice: 4900,
          amount: 9800,
          totalCostCny: 7200,
          flightSchedule: { departureTime: new Date('2026-08-10T01:00:00Z') },
        }),
        detailItem({ kind: 'HOTEL', description: '海景房', amount: 3000, totalCostCny: 2000 }),
      ],
    };
    const detail = await getOrderPnlDetail('o1', detailClient(order));
    expect(detail).not.toBeNull();
    if (!detail) return;

    // 收入构成
    expect(detail.income.rows).toHaveLength(2);
    expect(detail.income.rows[0]).toMatchObject({
      label: '去程机票', kind: 'FLIGHT', quantity: 2, unitPriceCny: 4900, subtotalCny: 9800, isAdjustment: false,
    });
    expect(detail.income.itemsSumCny).toBe(12800);
    expect(detail.income.totalCny).toBe(12800); // = Order.total

    // 成本构成（逐 OrderItem.totalCostCny，getOrderPnl 口径）
    expect(detail.cost.itemCostCny).toBe(9200); // 7200 + 2000
    expect(detail.cost.missingCostItemCount).toBe(0);
    // 杂项逐条 + 小计
    expect(detail.cost.miscRows).toHaveLength(2);
    expect(detail.cost.miscRows[0]).toMatchObject({ label: '操作费', category: 'OPERATION_FEE', amountCny: 200 });
    expect(detail.cost.miscCostCny).toBe(500);
    expect(detail.cost.totalWithMiscCny).toBe(9700);

    // 与订单毛利 tab 行严格一致：毛利 = total − itemCost（不含杂项）
    expect(detail.grossMarginCny).toBe(3600); // 12800 − 9200
    expect(detail.marginPct).toBeCloseTo(0.2813, 3);
    // 参考：含杂项完整毛利
    expect(detail.grossMarginWithMiscCny).toBe(3100); // 12800 − 9700

    expect(detail.agentName).toBe('某旅行社');
    expect(detail.departureDate).toBe('2026-08-10');
  });

  it('有一件缺成本：itemCostCny/毛利 = null，杂项照常，含杂项毛利同样 null', async () => {
    const order: DetailOrderFixture = {
      id: 'o2',
      orderNumber: 'FTM2026072200002',
      status: 'PROCESSING',
      contactName: '李四',
      total: 5000,
      createdAt: new Date('2026-07-22T03:00:00Z'),
      agent: null,
      costItems: [{ category: 'HANDLING_FEE', amountCny: 100, note: null }],
      items: [
        detailItem({ kind: 'HOTEL', description: '标准房', amount: 3000, totalCostCny: 2000 }),
        detailItem({ kind: 'VISA', description: '签证', amount: 2000, totalCostCny: null }), // 缺成本
      ],
    };
    const detail = await getOrderPnlDetail('o2', detailClient(order));
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.cost.itemRows[1].totalCostCny).toBeNull();
    expect(detail.cost.itemCostCny).toBeNull();
    expect(detail.cost.missingCostItemCount).toBe(1);
    expect(detail.grossMarginCny).toBeNull();
    expect(detail.marginPct).toBeNull();
    // 杂项仍如实汇总，但含杂项毛利在缺成本时同样为 null（不造 0）
    expect(detail.cost.miscCostCny).toBe(100);
    expect(detail.cost.totalWithMiscCny).toBeNull();
    expect(detail.grossMarginWithMiscCny).toBeNull();
    expect(detail.agentName).toBeNull();
    expect(detail.departureDate).toBeNull(); // 无航段
  });

  it('识别价格调整行（metadata.priceAdjustment=true）', async () => {
    const order: DetailOrderFixture = {
      id: 'o3',
      orderNumber: 'FTM2026072200003',
      status: 'PAID',
      contactName: '王五',
      total: 800,
      createdAt: new Date('2026-07-22T04:00:00Z'),
      agent: null,
      costItems: [],
      items: [
        detailItem({ kind: 'HOTEL', description: '房费', amount: 1000, totalCostCny: 600 }),
        detailItem({
          kind: 'DISCOUNT',
          description: '价格调整：优惠（−¥200）',
          unitPrice: -200,
          amount: -200,
          totalCostCny: 0,
          metadata: { priceAdjustment: true, reasonCode: 'DISCOUNT' },
        }),
      ],
    };
    const detail = await getOrderPnlDetail('o3', detailClient(order));
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.income.rows[1].isAdjustment).toBe(true);
    expect(detail.income.rows[1].subtotalCny).toBe(-200);
    expect(detail.income.itemsSumCny).toBe(800);
  });

  it('订单不存在 / 已软删 → null', async () => {
    const detail = await getOrderPnlDetail('missing', detailClient(null));
    expect(detail).toBeNull();
  });
});
