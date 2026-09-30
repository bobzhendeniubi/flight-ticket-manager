/**
 * buildFinanceExportByOrderWorkbook · 订单级财务导出单元测试
 *
 * 验证订单毛利导出同样带出退款类型、换人费和接手订单号，避免浏览器 CSV
 * 与财务下载的 XLSX 出现两套不可区分的退款口径。
 */
import { describe, expect, it, vi } from 'vitest';

const getOrderPnlMock = vi.hoisted(() => vi.fn());
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));
vi.mock('./finances.service.js', () => ({ getOrderPnl: getOrderPnlMock }));

import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { buildFinanceExportByOrderWorkbook } from './finances.export-orders.js';

const RANGE = { from: '2026-01-01', to: '2026-01-31' };

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

describe('buildFinanceExportByOrderWorkbook — 退款类型结构化列', () => {
  it('导出换人退款的标记、换人费和接手订单号', async () => {
    getOrderPnlMock.mockResolvedValue([
      {
        orderId: 'order-a',
        orderNumber: 'ORDER-A',
        status: 'REFUND_REQUESTED',
        contactName: '测试客户',
        createdAt: '2026-01-05T00:00:00.000Z',
        totalCny: 1000,
        costCny: null,
        grossMarginCny: null,
        marginPct: null,
        itemCount: 1,
        missingCostItemCount: 1,
      },
      {
        orderId: 'order-b',
        orderNumber: 'ORDER-B',
        status: 'REFUND_REQUESTED',
        contactName: '普通退款客户',
        createdAt: '2026-01-06T00:00:00.000Z',
        totalCny: 800,
        costCny: null,
        grossMarginCny: null,
        marginPct: null,
        itemCount: 1,
        missingCostItemCount: 1,
      },
    ]);
    const client = {
      order: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'order-a',
            swapRefundedAt: new Date('2026-01-10T00:00:00.000Z'),
            swapFeeCny: 450,
            swapReplacementOrderNumber: 'ORDER-NEW',
            agent: null,
            passengers: [],
            items: [],
          },
          {
            id: 'order-b',
            swapRefundedAt: null,
            swapFeeCny: null,
            swapReplacementOrderNumber: null,
            agent: null,
            passengers: [],
            items: [],
          },
        ]),
      },
    } as unknown as PrismaClient;

    const wb = await loadWorkbook(await buildFinanceExportByOrderWorkbook(RANGE, client));
    const ws = wb.getWorksheet('订单毛利')!;
    const headers = ws.getRow(1).values as unknown[];
    const col = (header: string): number => {
      const index = headers.indexOf(header);
      expect(index).toBeGreaterThan(0);
      return index;
    };

    expect(ws.getRow(2).getCell(col('退款类型')).value).toBe('换人退款');
    expect(ws.getRow(2).getCell(col('换人费(元)')).value).toBe(450);
    expect(ws.getRow(2).getCell(col('接手订单号')).value).toBe('ORDER-NEW');
    expect(ws.getRow(3).getCell(col('退款类型')).value).toBe('普通退款');
    expect(ws.getRow(3).getCell(col('换人费(元)')).value).toBe('');
  });
});

describe('buildFinanceExportByOrderWorkbook — 原地换人记录列', () => {
  it('一单多次换人合成一格，按时间先后用「；」分隔；取数带拆单祖先单', async () => {
    getOrderPnlMock.mockResolvedValue([
      {
        orderId: 'order-c',
        orderNumber: 'ORDER-C',
        status: 'PAID',
        contactName: '换人客户',
        createdAt: '2026-01-05T00:00:00.000Z',
        totalCny: 2000,
        costCny: null,
        grossMarginCny: null,
        marginPct: null,
        itemCount: 1,
        missingCostItemCount: 1,
      },
    ]);
    const auditFindMany = vi.fn().mockResolvedValue([
      {
        createdAt: new Date('2026-01-12T03:00:00.000Z'),
        before: { passengerId: 'p2', fullName: 'LI/SI', documentNumber: 'E3' },
        after: { fullName: 'WANG/WU', documentNumber: 'E4', feeCny: 0 },
      },
      {
        createdAt: new Date('2026-01-10T03:00:00.000Z'),
        before: { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
        after: { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 450 },
      },
    ]);
    const splitFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ sourceOrderId: 'order-parent' }])
      .mockResolvedValue([]);
    const client = {
      order: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'order-c',
            swapRefundedAt: null,
            swapFeeCny: null,
            swapReplacementOrderNumber: null,
            agent: null,
            passengers: [
              { id: 'p1', chineseName: '杨林' },
              { id: 'p2', chineseName: null },
            ],
            items: [],
          },
        ]),
      },
      auditLog: { findMany: auditFindMany },
      orderSplitRecord: { findMany: splitFindMany },
    } as unknown as PrismaClient;

    const ws = (await loadWorkbook(await buildFinanceExportByOrderWorkbook(RANGE, client))).getWorksheet(
      '订单毛利',
    )!;
    const headers = ws.getRow(1).values as unknown[];
    const col = headers.indexOf('换人记录');
    expect(col).toBeGreaterThan(0);
    expect(ws.getRow(2).getCell(col).value).toBe(
      '01-10 原 QIN/XUE → 新 YANG/LIN 杨林，换人费 ¥450；01-12 原 LI/SI → 新 WANG/WU',
    );
    // 换人审计挂在换人当时的单上：拆单前的祖先单要一并查。
    const where = auditFindMany.mock.calls[0][0].where as { targetId: { in: string[] } };
    expect(where.targetId.in).toEqual(expect.arrayContaining(['order-c', 'order-parent']));
  });
});
