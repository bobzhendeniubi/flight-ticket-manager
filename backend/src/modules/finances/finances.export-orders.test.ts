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
            items: [],
          },
          {
            id: 'order-b',
            swapRefundedAt: null,
            swapFeeCny: null,
            swapReplacementOrderNumber: null,
            agent: null,
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
