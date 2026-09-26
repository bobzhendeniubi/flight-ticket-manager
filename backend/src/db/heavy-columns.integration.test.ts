/**
 * 图片大字段不读 · 真 DB 集成测试
 *
 * 单测（heavy-columns.test.ts）只能断言发给 Prisma 的参数，这里断言 Prisma 真正发给库的 SQL
 *（omitApi 在 5.x 是预览特性，升级 Prisma 时靠这条兜底）：
 *   · 三个 omit 片段：SQL 不出现图片列、取回的行没有这个键，其余列照常；
 *   · 全岗总表 / 三模板 / 财务明细导出端到端跑一遍：导出照常产出这位乘客（查的就是带图那一行），
 *     期间发给库的 SQL 一条都没读图片列。
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/db/heavy-columns.integration.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, PrismaClient, ReceiptSource } from '@prisma/client';
import { prisma } from './prisma.js';
import {
  PASSENGERS_WITHOUT_PHOTO,
  PAYMENTS_WITHOUT_PROOF,
  PAYMENT_PROOF_OMIT,
  RECEIPT_PROOF_OMIT,
} from './heavy-columns.js';
import { buildMasterExportWorkbook } from '../modules/orders/orders.export-master.js';
import { buildOrderTemplateExportWorkbook } from '../modules/orders/orders.export-templates.js';
import { exportMasterQuerySchema, exportTemplatesQuerySchema } from '../modules/orders/orders.schemas.js';
import { buildFinanceExportWorkbook } from '../modules/finances/finances.export.js';

// 合成的「图」：真实数据是整张 JPEG 的 data URL，这里只要带图片列、认得出来即可。
const FAKE_PHOTO = `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ${'A'.repeat(4096)}`;
const FAKE_PROOF = `data:image/png;base64,iVBORw0KGgo${'B'.repeat(4096)}`;

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 一张已付款的纯签证订单：给定的乘客（各自的护照照片列值）+ 一笔带凭证的收款。*/
async function createVisaOrder(passengers: Array<{ fullName: string; photo: string | null }>) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-HEAVY'),
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
          documentType: 'PASSPORT' as const,
          documentNumber: `E9${String(i).padStart(7, '0')}`,
          nationality: 'CN',
          dateOfBirth: new Date('1990-01-01'),
          passportPhotoUrl: p.photo,
        })),
      },
      payments: {
        create: {
          method: PaymentMethod.BANK_CARD,
          amount: new Prisma.Decimal(300),
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
          proofUrl: FAKE_PROOF,
        },
      },
    },
  });
}

/** 带查询日志的独立 client：收集它发给库的每一条 SQL。*/
const loggers: PrismaClient[] = [];
function loggingClient(): { client: PrismaClient; sqls: string[] } {
  const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  loggers.push(client);
  const sqls: string[] = [];
  client.$on('query', (e) => {
    sqls.push(e.query);
  });
  return { client, sqls };
}
afterAll(async () => {
  await Promise.all(loggers.map((c) => c.$disconnect()));
});

/** 读回了图片列的 SQL：SELECT 列表或 RETURNING 里点了这一列（WHERE 里拿它做比较不算读）。*/
function sqlsReadingHeavyColumns(sqls: string[]): string[] {
  const HEAVY = /"(passportPhotoUrl|proofUrl)"/u;
  return sqls.filter((sql) => {
    const selectList = /^\s*SELECT\s(.*?)\sFROM\s/isu.exec(sql)?.[1] ?? '';
    const returning = /\sRETURNING\s(.*)$/isu.exec(sql)?.[1] ?? '';
    return HEAVY.test(selectList) || HEAVY.test(returning);
  });
}

async function workbookText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const cells: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? '')))));
  return cells.join('\n');
}

describe('omit 片段在真库上生效', () => {
  it('乘客 / 收款 / 进账：SQL 不出现图片列，行上没有这个键，其余列照常', async () => {
    const order = await createVisaOrder([{ fullName: 'WANG OMIT', photo: FAKE_PHOTO }]);
    const receipt = await prisma.receipt.create({
      data: {
        receiptNo: uniq('RCP'),
        amountCny: new Prisma.Decimal(500),
        method: PaymentMethod.BANK_CARD,
        receivedAt: new Date(),
        source: ReceiptSource.STAFF_ENTRY,
        payerNote: '付款备注',
        proofUrl: FAKE_PROOF,
      },
    });
    const { client, sqls } = loggingClient();

    const withRelations = await client.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { passengers: PASSENGERS_WITHOUT_PHOTO, payments: PAYMENTS_WITHOUT_PROOF },
    });
    expect(withRelations.passengers[0]).toMatchObject({ fullName: 'WANG OMIT', documentNumber: 'E90000000' });
    expect(withRelations.passengers[0]).not.toHaveProperty('passportPhotoUrl');
    expect(Number(withRelations.payments[0].amount)).toBe(300);
    expect(withRelations.payments[0]).not.toHaveProperty('proofUrl');

    const [payment] = await client.payment.findMany({ where: { orderId: order.id }, omit: PAYMENT_PROOF_OMIT });
    expect(payment).not.toHaveProperty('proofUrl');

    const receipts = await client.receipt.findMany({
      where: { id: receipt.id },
      omit: RECEIPT_PROOF_OMIT,
      include: { allocations: true, holdAllocations: true },
    });
    expect(receipts[0]).toMatchObject({ receiptNo: receipt.receiptNo, payerNote: '付款备注' });
    expect(receipts[0]).not.toHaveProperty('proofUrl');

    expect(sqlsReadingHeavyColumns(sqls)).toEqual([]);
    // 对照：不 omit 时同一张表的 SQL 确实会点这一列（证明上面的判定不是空转）
    await client.passenger.findMany({ where: { orderId: order.id } });
    expect(sqlsReadingHeavyColumns(sqls)).toHaveLength(1);
  });

  it('全岗总表、三模板、财务明细：导出照常产出乘客，期间 SQL 一条都没读图片列', async () => {
    const order = await createVisaOrder([{ fullName: 'ZHANG HEAVY', photo: FAKE_PHOTO }]);
    const { client, sqls } = loggingClient();

    const master = await buildMasterExportWorkbook(exportMasterQuerySchema.parse({ orderIds: order.id }), client, {
      agentScope: null,
    });
    expect(await workbookText(master)).toContain('ZHANG');

    for (const template of ['full', 'visa'] as const) {
      const buf = await buildOrderTemplateExportWorkbook(
        exportTemplatesQuerySchema.parse({ orderIds: order.id, template }),
        client,
        { agentScope: null },
      );
      expect(await workbookText(buf)).toContain('ZHANG');
    }

    const today = new Date().toISOString().slice(0, 10);
    const finance = await buildFinanceExportWorkbook({ from: today, to: today }, client);
    expect(await workbookText(finance)).toContain(order.orderNumber);

    // 取乘客 / 收款的 SQL 确实发出去了（不是空转），且一条都没读图片列
    expect(sqls.some((sql) => sql.includes('"Passenger"'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('"Payment"'))).toBe(true);
    expect(sqlsReadingHeavyColumns(sqls)).toEqual([]);
  });
});
