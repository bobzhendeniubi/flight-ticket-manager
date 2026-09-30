/**
 * 「换人记录」列 · 真 DB 集成测试
 *
 * 单测只能断言发给 Prisma 的参数；这里用真库跑全岗总表（全岗 / 代理视角）与财务核对明细，
 * 验证换人审计 → 按乘客槽位 → 单元格的整条链路，含「拆单搬走的人，审计挂在祖先单上」。
 *
 * 跑：npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.export-swap-records.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { AuditSeverity, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { buildMasterExportWorkbook } from './orders.export-master.js';
import { exportMasterQuerySchema } from './orders.schemas.js';
import { buildFinanceExportWorkbook } from '../finances/finances.export.js';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createVisaOrder(passengers: Array<{ fullName: string; chineseName: string | null }>) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-SWAPREC'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(300),
      total: new Prisma.Decimal(300),
      paidAmount: new Prisma.Decimal(300),
      contactName: '联系人',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '电子签证',
            quantity: passengers.length,
            unitPrice: new Prisma.Decimal(100),
            amount: new Prisma.Decimal(100 * passengers.length),
          },
        ],
      },
      passengers: {
        create: passengers.map((p, i) => ({
          fullName: p.fullName,
          chineseName: p.chineseName,
          documentType: 'PASSPORT' as const,
          documentNumber: `E8${String(i).padStart(7, '0')}`,
          nationality: 'CN',
          dateOfBirth: new Date('1990-01-01'),
        })),
      },
    },
    include: { passengers: { select: { id: true, fullName: true } } },
  });
}

async function writeSwapAudit(input: {
  orderId: string;
  passengerId: string;
  oldName: string;
  oldChineseName: string;
  newName: string;
  feeCny: number;
  createdAt: Date;
}) {
  await prisma.auditLog.create({
    data: {
      action: 'SWAP_ORDER_PASSENGER',
      targetType: 'ORDER',
      targetId: input.orderId,
      before: {
        passengerId: input.passengerId,
        fullName: input.oldName,
        documentNumber: 'OLD1',
        snapshot: { chineseName: input.oldChineseName },
      },
      after: { fullName: input.newName, documentNumber: 'NEW1', feeCny: input.feeCny },
      severity: AuditSeverity.WARNING,
      createdAt: input.createdAt,
    },
  });
}

/** 按表头取某一列的全部数据行值（第 1 行是表头）；没有这一列 → null。*/
async function columnValues(buf: Buffer, sheet: string, header: string): Promise<string[] | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.getWorksheet(sheet)!;
  const headers = ws.getRow(1).values as unknown[];
  const col = headers.indexOf(header);
  if (col <= 0) return null;
  const out: string[] = [];
  ws.eachRow((row, i) => {
    if (i > 1) out.push(String(row.getCell(col).value ?? ''));
  });
  return out;
}

describe('换人记录列（真库）', () => {
  it('全岗总表：记录挂在新人那一行；拆单搬走的人从祖先单审计里取回；代理视角同样可见', async () => {
    const parent = await createVisaOrder([
      { fullName: 'YANG/LIN', chineseName: '杨林' },
      { fullName: 'LI/SI', chineseName: null },
    ]);
    const child = await createVisaOrder([{ fullName: 'WANG/WU', chineseName: '王五' }]);
    const moved = child.passengers[0];
    await prisma.orderSplitRecord.create({
      data: {
        sourceOrderId: parent.id,
        targetOrderId: child.id,
        passengerCount: 1,
        movedShareCny: new Prisma.Decimal(100),
        movedPaidCny: new Prisma.Decimal(100),
        snapshot: [],
        requestToken: uniq('tok'),
        createdById: 'test',
      },
    });
    await writeSwapAudit({
      orderId: parent.id,
      passengerId: parent.passengers[0].id,
      oldName: 'QIN/XUE',
      oldChineseName: '覃雪',
      newName: 'YANG/LIN',
      feeCny: 480,
      createdAt: new Date('2026-09-30T02:00:00.000Z'), // 北京时间 09-30 10:00
    });
    // 被拆到子单的那位：换人发生在拆单前，审计挂在父单上
    await writeSwapAudit({
      orderId: parent.id,
      passengerId: moved.id,
      oldName: 'ZHAO/MU',
      oldChineseName: '赵木',
      newName: 'WANG/WU',
      feeCny: 0,
      createdAt: new Date('2026-09-28T02:00:00.000Z'),
    });

    const query = exportMasterQuerySchema.parse({ orderIds: `${parent.id},${child.id}` });
    const all = await buildMasterExportWorkbook(query, prisma, { agentScope: null });
    const names = await columnValues(all, '全岗总表', '纯拼音名');
    const swaps = await columnValues(all, '全岗总表', '换人记录');
    expect(swaps).not.toBeNull();
    const byName = new Map(names!.map((n, i) => [n, swaps![i]]));
    expect(byName.get('YANG/LIN')).toBe('09-30 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥480');
    expect(byName.get('LI/SI')).toBe('');
    expect(byName.get('WANG/WU')).toBe('09-28 原 ZHAO/MU 赵木 → 新 WANG/WU 王五');

    const agent = await buildMasterExportWorkbook({ ...query, role: 'agent' }, prisma, { agentScope: null });
    expect(await columnValues(agent, '全岗总表', '换人记录')).toEqual(
      expect.arrayContaining(['09-30 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥480']),
    );
  });

  it('财务核对明细：同一列按乘客行写出', async () => {
    const order = await createVisaOrder([{ fullName: 'YANG/LIN', chineseName: '杨林' }]);
    await writeSwapAudit({
      orderId: order.id,
      passengerId: order.passengers[0].id,
      oldName: 'QIN/XUE',
      oldChineseName: '覃雪',
      newName: 'YANG/LIN',
      feeCny: 450,
      createdAt: new Date('2026-09-30T02:00:00.000Z'),
    });
    const today = new Date().toISOString().slice(0, 10);
    const buf = await buildFinanceExportWorkbook({ from: today, to: today }, prisma);
    const orderNumbers = await columnValues(buf, '财务核对收入明细', '订单号');
    const swaps = await columnValues(buf, '财务核对收入明细', '换人记录');
    const idx = orderNumbers!.indexOf(order.orderNumber);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(swaps![idx]).toBe('09-30 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥450');
  });
});
