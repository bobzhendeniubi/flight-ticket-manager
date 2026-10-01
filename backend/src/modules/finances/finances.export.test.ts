/**
 * buildFinanceExportWorkbook · 单元测试（vitest）
 *
 * 覆盖点：
 * 1) 「是否清账」列的应收口径要加 adjustmentCny（改期费/换人费等售后费用）+
 *    prepaymentOffset（代理预付款抵扣），与 reports.service.ts 的应收余额口径
 *    （total + adjustmentCny − paidAmount − prepaymentOffset）对齐，而不是只比较 paidAmount
 *    和 total——否则有未收改期费/换人费的订单会被错误标为"已清账"。
 * 2) 清账判定不带 payableCny>0 前置——与 orders.export-master.ts / orders.export-templates.ts /
 *    reports.service.ts 三处口径一致（receivedCny >= payableCny），零额单（免费单/全减免单）
 *    应收=已收=0 时应判"已清账"，而不是因 payableCny 不大于 0 被误标"未清账"。
 * 3) 已收净额要扣已完成退款（lib/net-received.ts 统一口径）——退款完成只翻 Refund 状态、
 *    不回冲 paidAmount，不扣就会把"先收后退"的订单一直标成已清账。
 *
 * 注入 fake PrismaClient（buildFinanceExportWorkbook 支持 client 参数），构建 workbook 后
 * 用 ExcelJS 读回校验「是否清账」列（COLUMNS 第 11 列）。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { buildFinanceExportWorkbook } from './finances.export.js';

const RANGE = { from: '2026-01-01', to: '2026-01-31' };
const SETTLED_COL = 11; // COLUMNS 第 11 项 = '是否清账'（1-indexed，见 finances.export.ts）

interface OrderFixture {
  id: string;
  orderNumber: string;
  status: string;
  contactName: string;
  total: number;
  paidAmount: number;
  adjustmentCny: number;
  prepaymentOffset: number;
  createdAt: Date;
  notes: string | null;
  swapRefundedAt: Date | null;
  swapFeeCny: number | null;
  swapReplacementOrderNumber: string | null;
  agent: null;
  passengers: { id: string; fullName: string; lastName: string | null; firstName: string | null }[];
  costItems: unknown[];
  items: unknown[];
  /** 查询侧已按 status='COMPLETED' 过滤，fixture 里直接给已完成的那些 */
  refunds: { amount: number }[];
}

function makeOrder(overrides: Partial<OrderFixture> & { orderNumber: string }): OrderFixture {
  return {
    id: overrides.orderNumber,
    status: 'PAID',
    contactName: '测试联系人',
    total: 1000,
    paidAmount: 1000,
    adjustmentCny: 0,
    prepaymentOffset: 0,
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    notes: null,
    swapRefundedAt: null,
    swapFeeCny: null,
    swapReplacementOrderNumber: null,
    agent: null,
    passengers: [{ id: 'p1', fullName: '张三', lastName: null, firstName: null }],
    costItems: [],
    items: [],
    refunds: [],
    ...overrides,
  };
}

function fakeClient(orders: OrderFixture[], swapAudits: unknown[] = []): PrismaClient {
  return {
    order: { findMany: vi.fn().mockResolvedValue(orders) },
    flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    // 换人记录列取数：换人审计 + 拆单祖先单（默认都没有）。
    auditLog: { findMany: vi.fn().mockResolvedValue(swapAudits) },
    orderSplitRecord: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
}

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

describe('buildFinanceExportWorkbook — 是否清账口径含 adjustmentCny', () => {
  it('total 已付清，但有未收改期费（adjustmentCny）：不应再被误标为"已清账"', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0001',
      total: 2200,
      paidAmount: 2200, // 基础价已付清
      adjustmentCny: 300, // 改期费 300 未收
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('否');
  });

  it('total 已付清、无 adjustmentCny：仍正常标"已清账"（非回归）', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0002',
      total: 1000,
      paidAmount: 1000,
      adjustmentCny: 0,
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('是');
  });

  it('改期费通过代理预付款抵扣（prepaymentOffset）覆盖：应收=已收 → 标"已清账"', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0003',
      total: 1000,
      adjustmentCny: 300, // 应收 = 1000 + 300 = 1300
      paidAmount: 1000,
      prepaymentOffset: 300, // 已收 = 1000 + 300 = 1300
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('是');
  });

  it('改期费部分被 prepaymentOffset 抵扣但仍有缺口：标"否"', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0004',
      total: 1000,
      adjustmentCny: 300, // 应收 1300
      paidAmount: 1000,
      prepaymentOffset: 100, // 已收 1100 < 1300
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('否');
  });

  it('零额单（total=0、adjustmentCny=0、paidAmount=0、prepaymentOffset=0）：应收=已收=0 → 标"已清账"', async () => {
    // 免费单/全减免单没有 payableCny>0 前置，与 orders.export-master.ts / orders.export-templates.ts /
    // reports.service.ts 的清账口径（receivedCny >= payableCny，不含 payableCny>0 前置）保持一致。
    const order = makeOrder({
      orderNumber: 'FTM0005',
      total: 0,
      adjustmentCny: 0,
      paidAmount: 0,
      prepaymentOffset: 0,
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('是');
  });
});

describe('buildFinanceExportWorkbook — 已收净额扣已完成退款', () => {
  it('先收后退：已收净额低于应收 → 不应再标"已清账"', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0006',
      total: 1000,
      paidAmount: 1000, // 退款完成不回冲 paidAmount，账面仍是 1000
      refunds: [{ amount: 400 }], // 已收净额 = 1000 − 400 = 600 < 应收 1000
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const ws = (await loadWorkbook(buf)).getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('否');
  });

  it('多笔已完成退款累加后仍收满：标"已清账"', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0007',
      total: 600,
      paidAmount: 1000,
      refunds: [{ amount: 250 }, { amount: 150 }], // 已收净额 = 1000 − 400 = 600 ≥ 应收 600
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const ws = (await loadWorkbook(buf)).getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('是');
  });

  it('无退款记录：口径不变（非回归）', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0008',
      total: 1000,
      paidAmount: 1000,
      refunds: [],
    });
    const client = fakeClient([order]);
    const buf = await buildFinanceExportWorkbook(RANGE, client);
    const ws = (await loadWorkbook(buf)).getWorksheet('财务核对收入明细')!;

    expect(ws.getRow(2).getCell(SETTLED_COL).value).toBe('是');
  });
});

describe('buildFinanceExportWorkbook — 退款类型结构化列', () => {
  it('换人退款、普通退款和非退款订单分别写入三列', async () => {
    const orders = [
      makeOrder({
        orderNumber: 'FTM-SWAP',
        status: 'REFUND_REQUESTED',
        swapRefundedAt: new Date('2026-01-10T00:00:00.000Z'),
        swapFeeCny: 450,
        swapReplacementOrderNumber: 'FTM-NEW',
      }),
      makeOrder({ orderNumber: 'FTM-REFUND', status: 'REFUND_REQUESTED' }),
      makeOrder({ orderNumber: 'FTM-PAID', status: 'PAID' }),
    ];
    const wb = await loadWorkbook(await buildFinanceExportWorkbook(RANGE, fakeClient(orders)));
    const ws = wb.getWorksheet('财务核对收入明细')!;
    const headers = ws.getRow(1).values as unknown[];
    const col = (header: string): number => {
      const index = headers.indexOf(header);
      expect(index).toBeGreaterThan(0);
      return index;
    };
    const refundTypeCol = col('退款类型');
    const feeCol = col('换人费(元)');
    const replacementCol = col('接手订单号');

    expect(ws.getRow(2).getCell(refundTypeCol).value).toBe('换人退款');
    expect(ws.getRow(2).getCell(feeCol).value).toBe(450);
    expect(ws.getRow(2).getCell(replacementCol).value).toBe('FTM-NEW');
    expect(ws.getRow(3).getCell(refundTypeCol).value).toBe('普通退款');
    expect(ws.getRow(3).getCell(feeCol).value).toBe('');
    expect(ws.getRow(4).getCell(refundTypeCol).value).toBe('');
  });
});

describe('buildFinanceExportWorkbook — 车费成本口径：录单快照优先', () => {
  const TRANSFER_COST_COL = 24; // COLUMNS 第 24 项 = '车费(RMB)'
  function transferItem(overrides: Record<string, unknown>) {
    return {
      kind: 'TRANSFER',
      description: '机场接送',
      quantity: 2,
      unitPrice: 150,
      amount: 300,
      totalCostCny: null,
      metadata: null,
      flightSchedule: null,
      hotelRoomType: null,
      visa: null,
      fulfillmentTasks: [],
      transfer: { costPriceCny: 100, costPriceVnd: null, costFxName: null },
      ...overrides,
    };
  }

  it('有录单快照 totalCostCny → 车费取快照，不按产品现行结算价重算', async () => {
    const order = makeOrder({ orderNumber: 'FTM0101', items: [transferItem({ totalCostCny: 250 })] });
    const buf = await buildFinanceExportWorkbook(RANGE, fakeClient([order]));
    const ws = (await loadWorkbook(buf)).getWorksheet('财务核对收入明细')!;
    expect(ws.getRow(2).getCell(TRANSFER_COST_COL).value).toBe(250);
  });

  it('无快照的老单 → 回退产品现行结算价 × 数量', async () => {
    const order = makeOrder({ orderNumber: 'FTM0102', items: [transferItem({})] });
    const buf = await buildFinanceExportWorkbook(RANGE, fakeClient([order]));
    const ws = (await loadWorkbook(buf)).getWorksheet('财务核对收入明细')!;
    expect(ws.getRow(2).getCell(TRANSFER_COST_COL).value).toBe(200);
  });
});

describe('buildFinanceExportWorkbook — 原地换人记录列', () => {
  it('被换下去的人按乘客槽位写进「换人记录」，没换过人的乘客留空', async () => {
    const order = makeOrder({
      orderNumber: 'FTM0101',
      passengers: [
        { id: 'p1', fullName: 'YANG/LIN', lastName: 'YANG', firstName: 'LIN' },
        { id: 'p2', fullName: 'LI/SI', lastName: 'LI', firstName: 'SI' },
      ],
    });
    const client = fakeClient(
      [order],
      [
        {
          createdAt: new Date('2026-01-10T02:00:00.000Z'), // 北京时间 01-10
          before: { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1', snapshot: { chineseName: '覃雪' } },
          after: { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 480 },
        },
      ],
    );
    const ws = (await loadWorkbook(await buildFinanceExportWorkbook(RANGE, client))).getWorksheet(
      '财务核对收入明细',
    )!;
    const headers = ws.getRow(1).values as unknown[];
    const col = headers.indexOf('换人记录');
    expect(col).toBeGreaterThan(0);
    expect(ws.getRow(2).getCell(col).value).toBe('01-10 原 QIN/XUE 覃雪 → 新 YANG/LIN，换人费 ¥480');
    expect(ws.getRow(3).getCell(col).value).toBe('');
  });
});

// ── 已换人（SWAPPED）单：成本列一律 0、人数不计被换下的人；收入列照常（order-cost-policy）──
describe('buildFinanceExportWorkbook — 已换人单成本按 0', () => {
  /** 同一套明细：房费快照 800、导游服务费 200、两位乘客；只有状态与应收不同。 */
  function orderWith(status: string, orderNumber: string, total: number): OrderFixture {
    return makeOrder({
      orderNumber,
      status,
      total,
      paidAmount: total,
      passengers: [
        { id: `${orderNumber}-p1`, fullName: '张三', lastName: null, firstName: null },
        { id: `${orderNumber}-p2`, fullName: '李四', lastName: null, firstName: null },
      ],
      costItems: [{ category: 'GUIDE_SERVICE', amountCny: 200 }],
      items: [
        {
          kind: 'HOTEL',
          amount: total,
          quantity: 1,
          totalCostCny: 800,
          hotelCheckIn: null,
          hotelCheckOut: null,
          hotelRoomTypeId: null,
          hotelRoomType: null,
          randomStarTier: null,
          flightSchedule: null,
          visa: null,
          transfer: null,
          fulfillmentTasks: [],
        },
      ],
    });
  }

  it('已换人行：成本列全 0、客单利润 = 客单收入、人数 0；对照的已支付单照常算成本', async () => {
    const client = fakeClient([
      orderWith('SWAPPED', 'FTMSWAP01', 450),
      orderWith('PAID', 'FTMPAID01', 1000),
    ]);
    const ws = (await loadWorkbook(await buildFinanceExportWorkbook(RANGE, client))).getWorksheet(
      '财务核对收入明细',
    )!;
    const headers = ws.getRow(1).values as unknown[];
    const col = (header: string): number => {
      const index = headers.indexOf(header);
      expect(index).toBeGreaterThan(0);
      return index;
    };
    const cell = (row: number, header: string) => ws.getRow(row).getCell(col(header)).value;

    // 行 2/3 = 已换人单两位乘客；行 4/5 = 已支付单两位乘客（订单级合计只写在各自第一位乘客行）。
    expect(cell(2, '订单状态')).toBe('已换人');
    expect(cell(2, '人数')).toBe(0);
    for (const header of [
      '房费(RMB)',
      '导游服务费(RMB)',
      '杂项(赠送+手续费+操作费+其他)(RMB)',
      '客单成本合计',
      '酒店支出',
      '总成本',
    ]) {
      expect(cell(2, header)).toBe(0);
      expect(cell(3, header)).toBe(0);
    }
    expect(cell(2, '客单收入')).toBe(225);
    expect(cell(2, '客单利润')).toBe(225);
    expect(cell(2, '总收入')).toBe(450);
    expect(cell(2, '毛利')).toBe(450);

    expect(cell(4, '订单状态')).toBe('已支付');
    expect(cell(4, '人数')).toBe(2);
    expect(cell(4, '房费(RMB)')).toBe(400);
    expect(cell(4, '导游服务费(RMB)')).toBe(100);
    expect(cell(4, '客单成本合计')).toBe(500);
    expect(cell(4, '酒店支出')).toBe(800);
    expect(cell(4, '总成本')).toBe(1000);
    expect(cell(4, '毛利')).toBe(0);
  });
});
