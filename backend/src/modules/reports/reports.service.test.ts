/**
 * reports.service · 单元测试（vitest）
 *
 * 覆盖两条管理层看钱的口径：
 *
 * 1) 缺成本 → 毛利未知。桶内只要有一行成本快照为 NULL，costCny 就只是「部分成本」，
 *    据此算的毛利必然虚高——机票/套餐行成本恒空时，按品类毛利率会恒等于 100%。
 *    此时 grossMarginCny / marginPct 必须是 null（与 finances.service.ts 的 A5 收口同哲学），
 *    而不是拿部分成本减出一个精确但虚高的数字。
 *
 * 2) 已收净额要扣已完成退款（lib/net-received.ts 统一口径）。退款完成只翻 Refund 状态、
 *    不回冲 paidAmount，应收账龄/代理欠款不扣就会把已经退回客户的钱当成还收着。
 *
 * 注入 fake PrismaClient（三个聚合函数都支持 client 参数）。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import {
  getAgentDebtsReport,
  getReceivablesReport,
  getSalesReport,
  type DateRange,
} from './reports.service.js';

const RANGE: DateRange = { from: '2026-01-01', to: '2026-01-31' };

interface ItemFixture {
  kind: string;
  amount: number;
  totalCostCny: number | null;
}

function salesOrder(id: string, items: ItemFixture[]) {
  return { id, agentId: null, userId: null, agent: null, items };
}

function salesClient(orders: unknown[]): PrismaClient {
  return {
    order: { findMany: vi.fn().mockResolvedValue(orders) },
  } as unknown as PrismaClient;
}

describe('getSalesReport — 缺成本时毛利报「未知」而不是虚高数字', () => {
  it('全部行都有成本快照：毛利/毛利率照常给数字', async () => {
    const client = salesClient([
      salesOrder('o1', [{ kind: 'HOTEL', amount: 1000, totalCostCny: 600 }]),
    ]);

    const report = await getSalesReport(RANGE, 'kind', client);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.costCny).toBe(600);
    expect(report.rows[0]!.grossMarginCny).toBe(400);
    expect(report.rows[0]!.marginPct).toBe(0.4);
    expect(report.rows[0]!.missingCostItemCount).toBe(0);
    expect(report.totals.grossMarginCny).toBe(400);
  });

  it('机票行成本恒 NULL：该桶毛利/毛利率为 null，不再报 100% 毛利率', async () => {
    const client = salesClient([
      salesOrder('o1', [{ kind: 'FLIGHT', amount: 5000, totalCostCny: null }]),
    ]);

    const report = await getSalesReport(RANGE, 'kind', client);

    const flight = report.rows.find((r) => r.key === 'FLIGHT')!;
    expect(flight.revenueCny).toBe(5000);
    expect(flight.missingCostItemCount).toBe(1);
    // 旧口径：cost 累计跳过缺失行 → grossMargin=5000、marginPct=1（100% 毛利率）
    expect(flight.grossMarginCny).toBeNull();
    expect(flight.marginPct).toBeNull();
  });

  it('桶内部分行缺成本：整桶毛利即为未知（不拿部分成本减出精确数）', async () => {
    const client = salesClient([
      salesOrder('o1', [
        { kind: 'HOTEL', amount: 1000, totalCostCny: 600 },
        { kind: 'HOTEL', amount: 2000, totalCostCny: null },
      ]),
    ]);

    const report = await getSalesReport(RANGE, 'kind', client);
    const hotel = report.rows.find((r) => r.key === 'HOTEL')!;

    expect(hotel.revenueCny).toBe(3000);
    // costCny 仍是「已录到的部分成本」，前端据 missingCostItemCount 提示这不是全额成本
    expect(hotel.costCny).toBe(600);
    expect(hotel.missingCostItemCount).toBe(1);
    expect(hotel.grossMarginCny).toBeNull();
    expect(hotel.marginPct).toBeNull();
  });

  it('合计行同样口径：任一行缺成本 → totals 毛利为 null，但成本齐全的桶仍出数字', async () => {
    const client = salesClient([
      salesOrder('o1', [
        { kind: 'HOTEL', amount: 1000, totalCostCny: 600 },
        { kind: 'FLIGHT', amount: 5000, totalCostCny: null },
      ]),
    ]);

    const report = await getSalesReport(RANGE, 'kind', client);

    expect(report.rows.find((r) => r.key === 'HOTEL')!.grossMarginCny).toBe(400);
    expect(report.rows.find((r) => r.key === 'FLIGHT')!.grossMarginCny).toBeNull();
    expect(report.totals.missingCostItemCount).toBe(1);
    expect(report.totals.grossMarginCny).toBeNull();
    expect(report.totals.marginPct).toBeNull();
  });
});

interface ReceivableFixture {
  orderNumber: string;
  total: number;
  paidAmount: number;
  prepaymentOffset?: number;
  adjustmentCny?: number;
  refunds?: { amount: number }[];
  agentId?: string | null;
}

function receivableOrder(f: ReceivableFixture) {
  return {
    id: f.orderNumber,
    orderNumber: f.orderNumber,
    contactName: '测试联系人',
    status: 'PAID',
    total: f.total,
    paidAmount: f.paidAmount,
    prepaymentOffset: f.prepaymentOffset ?? 0,
    adjustmentCny: f.adjustmentCny ?? 0,
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    agent: null,
    agentId: f.agentId ?? null,
    // 查询侧已按 status='COMPLETED' 过滤，fixture 直接给已完成的那些
    refunds: f.refunds ?? [],
  };
}

function receivableClient(orders: unknown[], agents: unknown[] = []): PrismaClient {
  return {
    order: { findMany: vi.fn().mockResolvedValue(orders) },
    agent: { findMany: vi.fn().mockResolvedValue(agents) },
  } as unknown as PrismaClient;
}

describe('getReceivablesReport — 已收净额扣已完成退款', () => {
  it('先收后退：退掉的钱重新变成应收余额，进账龄表', async () => {
    const client = receivableClient([
      // 退款完成不回冲 paidAmount，账面仍是 1000；已收净额 = 1000 − 400 = 600
      receivableOrder({
        orderNumber: 'FTM0001',
        total: 1000,
        paidAmount: 1000,
        refunds: [{ amount: 400 }],
      }),
    ]);

    const report = await getReceivablesReport(client);

    // 旧口径：balance = 1000 − 1000 = 0 → 被 balance<=0 过滤掉，整单从账龄表消失
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.balanceCny).toBe(400);
    expect(report.rows[0]!.paidCny).toBe(600);
    expect(report.summary.totalBalanceCny).toBe(400);
  });

  it('多笔已完成退款累加', async () => {
    const client = receivableClient([
      receivableOrder({
        orderNumber: 'FTM0002',
        total: 1000,
        paidAmount: 1000,
        refunds: [{ amount: 250 }, { amount: 150 }],
      }),
    ]);

    const report = await getReceivablesReport(client);

    expect(report.rows[0]!.balanceCny).toBe(400);
  });

  it('无退款：口径不变（非回归）', async () => {
    const client = receivableClient([
      receivableOrder({ orderNumber: 'FTM0003', total: 1000, paidAmount: 400 }),
    ]);

    const report = await getReceivablesReport(client);

    expect(report.rows[0]!.balanceCny).toBe(600);
  });

  it('退款与改期费叠加：余额 = total + adjustmentCny − 已收净额', async () => {
    const client = receivableClient([
      receivableOrder({
        orderNumber: 'FTM0004',
        total: 1000,
        adjustmentCny: 300, // 应收 1300
        paidAmount: 1000,
        refunds: [{ amount: 200 }], // 已收净额 800
      }),
    ]);

    const report = await getReceivablesReport(client);

    expect(report.rows[0]!.balanceCny).toBe(500);
  });
});

describe('getAgentDebtsReport — 与账龄同口径扣已完成退款', () => {
  it('代理欠款按扣退款后的余额聚合', async () => {
    const client = receivableClient(
      [
        receivableOrder({
          orderNumber: 'FTM0005',
          total: 1000,
          paidAmount: 1000,
          refunds: [{ amount: 400 }],
          agentId: 'a1',
        }),
      ],
      [{ id: 'a1', companyName: '测试代理', contactName: '联系人', prepaymentBalance: 0 }],
    );

    const rows = await getAgentDebtsReport(client);

    // 旧口径：余额 0 → 该代理被 filter 掉，欠款表看不到这笔已退未收回的窟窿
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentLabel).toBe('测试代理');
    expect(rows[0]!.orderCount).toBe(1);
    expect(rows[0]!.outstandingCny).toBe(400);
  });
});
