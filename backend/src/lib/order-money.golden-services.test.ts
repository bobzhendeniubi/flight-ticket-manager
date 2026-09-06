/**
 * 订单金额「黄金」特征测试 · 经数据库查询的服务计算点（vitest，prisma 全部打桩）
 *
 * 与 order-money.golden.test.ts 同一组夹具，钉死以下各处今天算出来的数：
 *   · 经营报表：应收账龄 getReceivablesReport / 代理欠款 getAgentDebtsReport（应收 − 已收净额）
 *   · 财务导出：buildFinanceExportWorkbook 的「是否清账」列（已收净额 ≥ 应收）
 *   · 财务概览：getFinancesSummary 对 REFUNDED 单补的负项（paidAmount − 已完成退款）
 *   · 对账台候选：ReceiptsService.matchCandidates（尾款 = 应收 − 已付 − 预存抵扣，≤0 不进候选）
 *   · 认款建议：ReceiptsService.suggestMatches（同一尾款口径，按分算）
 *   · 结算单：SettlementService.computeSettlement 的 GMV（Σ Order.total，不含售后费）
 *   · 仪表盘：DashboardService.getKpi 的营收（Σ Order.total 的 DB 聚合，原样透传）
 *   · 代理对账单：buildAgentStatement 的应收 / 已收 / 尾款 / 人均 / 立减
 *
 * 各桩只回夹具，不做任何口径计算；status 过滤在桩里按查询参数 `status.in / notIn` 真过滤，
 * 这样状态集合本身也被钉住（哪张单进了哪张表）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  orderFindMany: vi.fn(),
  orderAggregate: vi.fn(),
  orderCount: vi.fn(),
  receiptFindMany: vi.fn(),
  commissionFindMany: vi.fn(),
  getDescendantAgentIds: vi.fn(),
}));

vi.mock('../db/prisma.js', () => ({
  prisma: {
    order: {
      findMany: (...args: unknown[]) => hoisted.orderFindMany(...args),
      aggregate: (...args: unknown[]) => hoisted.orderAggregate(...args),
      count: (...args: unknown[]) => hoisted.orderCount(...args),
    },
    receipt: { findMany: (...args: unknown[]) => hoisted.receiptFindMany(...args) },
    commissionRecord: { findMany: (...args: unknown[]) => hoisted.commissionFindMany(...args) },
  },
}));
vi.mock('./agent-tree.js', () => ({
  getDescendantAgentIds: (...args: unknown[]) => hoisted.getDescendantAgentIds(...args),
}));

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { getAgentDebtsReport, getReceivablesReport } from '../modules/reports/reports.service.js';
import { buildFinanceExportWorkbook } from '../modules/finances/finances.export.js';
import { getFinancesSummary } from '../modules/finances/finances.service.js';
import { ReceiptsService } from '../modules/receipts/receipts.service.js';
import { SettlementService } from '../modules/settlements/settlements.service.js';
import { DashboardService } from '../modules/dashboard/dashboard.service.js';
import { buildAgentStatement } from '../modules/agent-statements/agent-statements.service.js';
import {
  allFixtures,
  completedRefunds,
  fixtureMultiPax,
  fixtureOddCents,
  fixtureRefundedFull,
  fixtureRefundedPartial,
  fixtureSwapped,
  type FixtureOrder,
} from './order-money.golden.fixtures.js';

/** 查询侧 `refunds: { where: { status: 'COMPLETED' } }` 的等价：只把已完成退款喂给消费方。 */
function withCompletedRefunds(o: FixtureOrder) {
  return { ...o, refunds: completedRefunds(o) };
}

/** 按 Prisma where 里的 status.in / status.notIn 真过滤（钉住状态集合本身）。 */
function filterByStatusWhere(orders: FixtureOrder[], where: unknown): FixtureOrder[] {
  const status = (where as { status?: { in?: string[]; notIn?: string[] } } | undefined)?.status;
  if (!status) return orders;
  if (Array.isArray(status.in)) return orders.filter((o) => status.in!.includes(o.status));
  if (Array.isArray(status.notIn)) return orders.filter((o) => !status.notIn!.includes(o.status));
  return orders;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('黄金 · 经营报表（应收账龄 / 代理欠款）', () => {
  it('应收账龄：余额 = total + adjustmentCny − (paidAmount + prepaymentOffset − 已完成退款)，只列余额 > 0 的进行中订单', async () => {
    const client = {
      order: {
        findMany: vi.fn(async (args: { where: unknown }) =>
          filterByStatusWhere(allFixtures(), args.where).map(withCompletedRefunds),
        ),
      },
    } as unknown as PrismaClient;
    const report = await getReceivablesReport(client);
    expect(
      report.rows.map((r) => ({
        orderNumber: r.orderNumber,
        status: r.status,
        totalCny: r.totalCny,
        paidCny: r.paidCny,
        balanceCny: r.balanceCny,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "balanceCny": 4618,
          "orderNumber": "FTM2026082000001",
          "paidCny": 5000,
          "status": "PAID",
          "totalCny": 9618,
        },
        {
          "balanceCny": 2120,
          "orderNumber": "FTM2026082000005",
          "paidCny": 1000,
          "status": "PENDING_PAYMENT",
          "totalCny": 3120,
        },
        {
          "balanceCny": 500,
          "orderNumber": "FTM2026082000002",
          "paidCny": 5800,
          "status": "PROCESSING",
          "totalCny": 6300,
        },
      ]
    `);
    expect(report.summary.totalBalanceCny).toMatchInlineSnapshot(`7238`);
  });

  it('代理欠款：按代理累计余额 > 0 的订单', async () => {
    const client = {
      order: {
        findMany: vi.fn(async (args: { where: unknown }) =>
          filterByStatusWhere(allFixtures(), args.where)
            .filter((o) => o.agentId)
            .map(withCompletedRefunds),
        ),
      },
      agent: {
        findMany: vi.fn(async () => [
          { id: 'agent-a', companyName: '甲代理', contactName: '甲', prepaymentBalance: new Prisma.Decimal(0) },
          { id: 'agent-b', companyName: '乙代理', contactName: '乙', prepaymentBalance: new Prisma.Decimal(0) },
        ]),
      },
    } as unknown as PrismaClient;
    const rows = await getAgentDebtsReport(client);
    expect(rows.map((r) => ({ agentId: r.agentId, orderCount: r.orderCount, outstandingCny: r.outstandingCny })))
      .toMatchInlineSnapshot(`
        [
          {
            "agentId": "agent-a",
            "orderCount": 2,
            "outstandingCny": 5118,
          },
          {
            "agentId": "agent-b",
            "orderCount": 1,
            "outstandingCny": 2120,
          },
        ]
      `);
  });
});

describe('黄金 · 财务导出「是否清账」（已收净额 ≥ 应收）', () => {
  it('六张夹具单逐单的是否清账', async () => {
    const client = {
      order: {
        findMany: vi.fn(async (args: { where: unknown }) =>
          filterByStatusWhere(allFixtures(), args.where).map((o) => ({
            ...withCompletedRefunds(o),
            // 金额列只吃 order.total / paidAmount / prepaymentOffset / adjustmentCny / refunds；
            // 行明细（成本 / 品类）与本口径无关，清空以免桩要模拟整条成本链。
            items: [],
            costItems: [],
          })),
        ),
      },
      flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const buf = await buildFinanceExportWorkbook({ from: '2026-08-01', to: '2026-08-31' }, client);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet('财务核对收入明细')!;
    const header = ws.getRow(1).values as unknown[];
    const col = (name: string) => header.findIndex((h) => h === name);
    const settledCol = col('是否清账');
    const orderNoCol = col('订单号');
    expect(settledCol).toBeGreaterThan(0);
    expect(orderNoCol).toBeGreaterThan(0);
    const out: Record<string, string> = {};
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const no = String(row.getCell(orderNoCol).value);
      out[no] = String(row.getCell(settledCol).value);
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": "否",
        "FTM2026082000002": "否",
        "FTM2026082000003": "是",
        "FTM2026082000005": "否",
        "FTM2026082000006": "是",
      }
    `);
  });
});

describe('黄金 · 财务概览 REFUNDED 负项（paidAmount − 已完成退款，不含预存抵扣）', () => {
  it('F4（已收 3000 / 已退 2700）与一张假设落 REFUNDED 的 F2（已收 6300 / 抵扣 500 / 已退 1000）', async () => {
    const refunded = [fixtureRefundedFull(), fixtureRefundedPartial()].map((o) => ({
      paidAmount: o.paidAmount,
      refunds: completedRefunds(o),
    }));
    const client = {
      order: {
        findMany: vi.fn(async (args: { where: { status?: unknown } }) =>
          args.where.status === 'REFUNDED' ? refunded : [],
        ),
      },
      flightSchedule: { findMany: vi.fn().mockResolvedValue([]) },
      flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const summary = await getFinancesSummary({ from: '2026-08-01', to: '2026-08-31' }, client);
    // 300 + 5300 = 5600：F2 的预存抵扣 500 **没有**被算进这条负项（与 lib/net-received 的 5800 不同）
    expect(summary.revenueBreakdown.refund).toMatchInlineSnapshot(`5600`);
    expect(summary.revenueCny).toMatchInlineSnapshot(`5600`);
  });
});

describe('黄金 · 对账台候选 / 认款建议尾款', () => {
  const service = new ReceiptsService();
  const candidates = () =>
    allFixtures().filter((o) => !['REFUNDED', 'CANCELLED', 'PAYMENT_TIMEOUT', 'DRAFT', 'REFUND_REQUESTED'].includes(o.status));

  it('matchCandidates：尾款 = total + adjustmentCny − paidAmount − prepaymentOffset；≤ 0 的单（含多付）不进候选', async () => {
    hoisted.orderFindMany.mockResolvedValue(candidates());
    const rows = await service.matchCandidates({});
    expect(
      rows.map((r) => ({
        orderNumber: r.orderNumber,
        totalPayable: r.totalPayable,
        paidAmount: r.paidAmount,
        balanceDue: r.balanceDue,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "balanceDue": 4618,
          "orderNumber": "FTM2026082000001",
          "paidAmount": 5000,
          "totalPayable": 9618,
        },
        {
          "balanceDue": 2120,
          "orderNumber": "FTM2026082000005",
          "paidAmount": 1000,
          "totalPayable": 3120,
        },
      ]
    `);
  });

  it('suggestMatches：同一尾款口径按分算；F1 尾款 4618 恰好对上一笔 4618 的流水', async () => {
    hoisted.orderFindMany.mockResolvedValue(candidates());
    hoisted.receiptFindMany.mockResolvedValue([
      {
        id: 'r-1',
        receiptNo: 'RCP-1',
        amountCny: new Prisma.Decimal(4618),
        allocatedCny: new Prisma.Decimal(0),
        status: 'OPEN',
        method: 'BANK_TRANSFER',
        source: 'STATEMENT_IMPORT',
        payerNote: 'FTM2026082000001 张三',
        externalTxnId: 'TXN-1',
        orderHintId: null,
        receivedAt: new Date('2026-08-26T02:00:00.000Z'),
      },
    ]);
    const result = await service.suggestMatches({});
    expect(result.scanned.unpaidOrders).toMatchInlineSnapshot(`2`);
    const top = result.receipts[0]?.candidates[0];
    expect(
      top && {
        orderNumber: top.orderNumber,
        totalPayable: top.totalPayable,
        paidAmount: top.paidAmount,
        balanceDue: top.balanceDue,
        suggestedAmountCny: top.suggestedAmountCny,
      },
    ).toMatchInlineSnapshot(`
      {
        "balanceDue": 4618,
        "orderNumber": "FTM2026082000001",
        "paidAmount": 5000,
        "suggestedAmountCny": 4618,
        "totalPayable": 9618,
      }
    `);
  });
});

describe('黄金 · 结算单 GMV（Σ Order.total，按下单日归期，不含售后费 adjustmentCny）', () => {
  it('甲代理本期两张单 F1（9618）+ F3（8100，应收其实是 8750）→ GMV 17718', async () => {
    hoisted.commissionFindMany.mockResolvedValue([]);
    hoisted.getDescendantAgentIds.mockResolvedValue(['agent-a']);
    hoisted.orderFindMany.mockImplementation(async (args: { where: unknown }) =>
      filterByStatusWhere([fixtureMultiPax(), fixtureSwapped()], args.where).map((o) => ({ id: o.id, total: o.total })),
    );
    const service = new SettlementService();
    const computed = await (
      service as unknown as {
        computeSettlement: (a: string, p: string, s: Date, e: Date) => Promise<{ grossRevenue: number; orderCount: number }>;
      }
    ).computeSettlement('agent-a', '2026-08', new Date('2026-08-01T00:00:00.000Z'), new Date('2026-09-01T00:00:00.000Z'));
    expect({ grossRevenue: computed.grossRevenue, orderCount: computed.orderCount }).toMatchInlineSnapshot(`
      {
        "grossRevenue": 17718,
        "orderCount": 2,
      }
    `);
  });
});

describe('黄金 · 仪表盘营收（Σ Order.total 的 DB 聚合，原样透传）', () => {
  it('getKpi.todayRevenue = _sum.total', async () => {
    hoisted.orderAggregate.mockResolvedValue({ _sum: { total: new Prisma.Decimal(17718) }, _count: { _all: 2 } });
    hoisted.orderCount.mockResolvedValue(0);
    hoisted.orderFindMany.mockResolvedValue([]);
    const kpi = await new DashboardService().getKpi();
    expect({ todayRevenue: kpi.todayRevenue, monthRevenue: kpi.monthRevenue }).toMatchInlineSnapshot(`
      {
        "monthRevenue": 17718,
        "todayRevenue": 17718,
      }
    `);
  });
});

describe('黄金 · 代理对账单（应收 / 已收净额 / 尾款不钳零 / 人均 / 立减）', () => {
  it('甲代理 2026-09 出发的三张单 F1 / F2 / F6', async () => {
    const orders = [fixtureMultiPax(), fixtureRefundedPartial(), fixtureOddCents()]
      .map(withCompletedRefunds)
      .map((o) => ({
        ...o,
        items: o.items.map((it) => ({ ...it, hotelCheckIn: null, visaIntendedDate: null })),
      }));
    const client = {
      agent: {
        findUnique: vi.fn(async () => ({ id: 'agent-a', companyName: '甲代理', contactName: '甲', tier: 1 })),
        findMany: vi.fn(async () => [{ id: 'agent-a', companyName: '甲代理', contactName: '甲' }]),
      },
      order: { findMany: vi.fn(async () => orders) },
      commissionRecord: { findMany: vi.fn(async () => []) },
      prepaymentTransaction: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const statement = await buildAgentStatement({ agentId: 'agent-a', month: '2026-09', scopeAgentIds: ['agent-a'] }, client);
    expect(
      statement.rows.map((r) => ({
        orderNumber: r.orderNumber,
        payableCny: r.payableCny,
        receivedCny: r.receivedCny,
        balanceCny: r.balanceCny,
        settlementPerPaxCny: r.settlementPerPaxCny,
        settlementPerPaxRange: r.settlementPerPaxRange,
        settlementDiscountCny: r.settlementDiscountCny,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "balanceCny": 4618,
          "orderNumber": "FTM2026082000001",
          "payableCny": 9618,
          "receivedCny": 5000,
          "settlementDiscountCny": 1032,
          "settlementPerPaxCny": 2404.5,
          "settlementPerPaxRange": "2,129.50 ~ 3,029.50",
        },
        {
          "balanceCny": 500,
          "orderNumber": "FTM2026082000002",
          "payableCny": 6300,
          "receivedCny": 5800,
          "settlementDiscountCny": 0,
          "settlementPerPaxCny": 3150,
          "settlementPerPaxRange": "",
        },
        {
          "balanceCny": 0,
          "orderNumber": "FTM2026082000006",
          "payableCny": 3333.33,
          "receivedCny": 3333.33,
          "settlementDiscountCny": 0,
          "settlementPerPaxCny": 1666.67,
          "settlementPerPaxRange": "1,666.66 ~ 1,666.67",
        },
      ]
    `);
  });
});
