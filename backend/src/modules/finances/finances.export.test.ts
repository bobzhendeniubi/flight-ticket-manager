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
  agent: null;
  passengers: { id: string; fullName: string; lastName: string | null; firstName: string | null }[];
  costItems: unknown[];
  items: unknown[];
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
    agent: null,
    passengers: [{ id: 'p1', fullName: '张三', lastName: null, firstName: null }],
    costItems: [],
    items: [],
    ...overrides,
  };
}

function fakeClient(orders: OrderFixture[]): PrismaClient {
  return {
    order: { findMany: vi.fn().mockResolvedValue(orders) },
    flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
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
