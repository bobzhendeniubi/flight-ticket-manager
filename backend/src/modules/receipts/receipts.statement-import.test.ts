/**
 * 流水入池 · 预览绑定与跨平台防重（vitest，fake prisma）
 *
 * 被钉住的两个破口：
 *
 * 1) 入库端点完全信任客户端提交的行。
 *    解析层（parseStatementXlsx）承载了全部业务规则——交易状态必须是平台的成功状态、
 *    金额 ≥ 0.01、时间可解析、文件内去重……而入库收的是一个裸数组，既不重读文件也不复核。
 *    结果：任何有后台账号的人都能 POST 一组编造的 {流水号, 金额, 到账时间} 凭空生成进账，
 *    再认款到订单上——等于给「凭空造钱」开了一扇带审计记录的正门。
 *    修法：预览时服务端把**自己解析出来的**可导入行记进短期缓存（按操作人 + 平台 + 流水号），
 *    入库逐行比对，对不上整批拒绝，且落库取缓存里的服务端值，不取客户端提交的值。
 *
 * 2) 存储键前缀取自**客户端提交的 platform**（CMB_QR='' / YSB: / XYF: / HSH:）。
 *    同一份流水用平台 A 导一次、平台 B 再导一次 → 落库是两个不同的 externalTxnId，
 *    唯一索引拦不住，同一笔钱在池子里出现两次、可被认款两次。
 *    修法：防重跨前缀查——原单号只要在任何平台前缀下入过池，就不再入第二次。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

const receiptFindMany = vi.fn();
const receiptCreateMany = vi.fn();

vi.mock('../../db/prisma.js', () => ({
  prisma: {
    receipt: {
      findMany: (...args: unknown[]) => receiptFindMany(...args),
      createMany: (...args: unknown[]) => receiptCreateMany(...args),
    },
  },
}));

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { PaymentMethod, UserRole } from '@prisma/client';
import { ReceiptsService, __resetStatementPreviewCacheForTests } from './receipts.service.js';

const service = new ReceiptsService();

const FINANCE = { userId: 'user_finance_1', role: UserRole.STAFF };
const OTHER_STAFF = { userId: 'user_finance_2', role: UserRole.STAFF };

const HEADERS = [
  '商户名称',
  '商户订单号',
  '交易流水号',
  '交易时间',
  '交易金额',
  '支付方式',
  '交易状态',
  '二维码备注',
  '支付付款方备注',
];

/** 造一份招行风格流水 xlsx（首行占位 + 表头 + 数据行）→ base64。 */
async function buildStatementBase64(dataRows: Array<Array<string | number>>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('订单');
  ws.addRow(HEADERS.map(() => '订单'));
  ws.addRow(HEADERS);
  for (const r of dataRows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

function row(
  txnId: string,
  time: string,
  amount: string,
  status = '支付成功',
  qrRemark = '',
): Array<string | number> {
  return ['测试商户', '', txnId, time, amount, '微信', status, qrRemark, ''];
}

/** 北京时墙钟 → Date（与解析层 parseTxnTime 同口径）。 */
const bj = (s: string): Date => new Date(`${s.replace(' ', 'T')}+08:00`);

beforeEach(() => {
  receiptFindMany.mockReset();
  receiptCreateMany.mockReset();
  receiptFindMany.mockResolvedValue([]);
  receiptCreateMany.mockImplementation((args: { data: unknown[] }) =>
    Promise.resolve({ count: args.data.length }),
  );
  __resetStatementPreviewCacheForTests();
});

describe('importStatement · 预览绑定（客户端不能凭空提交流水行）', () => {
  it('先预览再导入 → 正常入池，且落库用的是服务端解析出来的金额/时间/备注', async () => {
    const b64 = await buildStatementBase64([
      row('TXN0000001', '2026-07-21 23:20:17', '300.00', '支付成功', '尾号1234 王'),
    ]);
    const preview = await service.previewStatement(b64, 'CMB_QR', FINANCE);
    expect(preview.summary.importable).toBe(1);

    const result = await service.importStatement(
      {
        platform: 'CMB_QR',
        rows: [
          {
            externalTxnId: 'TXN0000001',
            amountCny: 300,
            method: PaymentMethod.WECHAT_PAY,
            receivedAt: bj('2026-07-21 23:20:17'),
          },
        ],
      },
      FINANCE,
    );

    expect(result.imported).toBe(1);
    const [created] = receiptCreateMany.mock.calls[0][0].data;
    expect(created.externalTxnId).toBe('TXN0000001');
    expect(Number(created.amountCny)).toBe(300);
    expect(created.receivedAt.toISOString()).toBe(bj('2026-07-21 23:20:17').toISOString());
    // 备注取服务端解析结果（客户端根本没提交 payerNote，也不该由它决定）
    expect(created.payerNote).toBe('尾号1234 王');
    expect(created.method).toBe(PaymentMethod.WECHAT_PAY);
  });

  it('没预览过的伪造行 → 整批拒绝，一条也不入池', async () => {
    await expect(
      service.importStatement(
        {
          platform: 'CMB_QR',
          rows: [
            {
              externalTxnId: 'FAKE999999',
              amountCny: 99_999,
              method: PaymentMethod.WECHAT_PAY,
              receivedAt: bj('2026-07-21 23:20:17'),
            },
          ],
        },
        FINANCE,
      ),
    ).rejects.toThrow(/不在本次预览的可导入结果里/);
    expect(receiptCreateMany).not.toHaveBeenCalled();
  });

  it('预览过但把金额改大再提交 → 整批拒绝（错误里带上预览值与提交值）', async () => {
    const b64 = await buildStatementBase64([row('TXN0000002', '2026-07-21 23:20:17', '300.00')]);
    await service.previewStatement(b64, 'CMB_QR', FINANCE);

    await expect(
      service.importStatement(
        {
          platform: 'CMB_QR',
          rows: [
            {
              externalTxnId: 'TXN0000002',
              amountCny: 30_000, // 篡改：真实到账 300
              method: PaymentMethod.WECHAT_PAY,
              receivedAt: bj('2026-07-21 23:20:17'),
            },
          ],
        },
        FINANCE,
      ),
    ).rejects.toThrow(/预览 ¥300\.00，提交 ¥30000\.00/);
    expect(receiptCreateMany).not.toHaveBeenCalled();
  });

  it('解析层判为「不可导入」的行（交易状态非成功）不进预览缓存 → 提交被拒', async () => {
    const b64 = await buildStatementBase64([
      row('TXN0000003', '2026-07-21 23:20:17', '300.00', '未支付'),
    ]);
    const preview = await service.previewStatement(b64, 'CMB_QR', FINANCE);
    expect(preview.summary.importable).toBe(0);
    expect(preview.rows[0].disposition).toBe('skipped_status');

    await expect(
      service.importStatement(
        {
          platform: 'CMB_QR',
          rows: [
            {
              externalTxnId: 'TXN0000003',
              amountCny: 300,
              method: PaymentMethod.WECHAT_PAY,
              receivedAt: bj('2026-07-21 23:20:17'),
            },
          ],
        },
        FINANCE,
      ),
    ).rejects.toThrow(/不在本次预览的可导入结果里/);
    expect(receiptCreateMany).not.toHaveBeenCalled();
  });

  it('用甲的预览去替乙导入 → 拒（预览按操作人记账，不是全局白名单）', async () => {
    const b64 = await buildStatementBase64([row('TXN0000004', '2026-07-21 23:20:17', '300.00')]);
    await service.previewStatement(b64, 'CMB_QR', FINANCE);

    await expect(
      service.importStatement(
        {
          platform: 'CMB_QR',
          rows: [
            {
              externalTxnId: 'TXN0000004',
              amountCny: 300,
              method: PaymentMethod.WECHAT_PAY,
              receivedAt: bj('2026-07-21 23:20:17'),
            },
          ],
        },
        OTHER_STAFF,
      ),
    ).rejects.toThrow(/不在本次预览的可导入结果里/);
    expect(receiptCreateMany).not.toHaveBeenCalled();
  });

  it('预览用招行、导入却声明会生活 → 拒（platform 不再是客户端可改写的自由字段）', async () => {
    const b64 = await buildStatementBase64([row('TXN0000005', '2026-07-21 23:20:17', '300.00')]);
    await service.previewStatement(b64, 'CMB_QR', FINANCE);

    await expect(
      service.importStatement(
        {
          platform: 'HUISHENGHUO', // 换个前缀就能把同一笔钱再入一次池——这里必须断掉
          rows: [
            {
              externalTxnId: 'TXN0000005',
              amountCny: 300,
              method: PaymentMethod.WECHAT_PAY,
              receivedAt: bj('2026-07-21 23:20:17'),
            },
          ],
        },
        FINANCE,
      ),
    ).rejects.toThrow(/不在本次预览的可导入结果里/);
    expect(receiptCreateMany).not.toHaveBeenCalled();
  });
});

describe('importStatement · 跨平台前缀防重（同一笔钱不进池两次）', () => {
  it('该原单号已在别的平台前缀下入过池 → 不再入第二次', async () => {
    const b64 = await buildStatementBase64([row('TXN0000006', '2026-07-21 23:20:17', '300.00')]);
    await service.previewStatement(b64, 'CMB_QR', FINANCE);
    // 库里已有同一笔钱，但当初是按「会生活」导的，落库键带 HSH: 前缀
    receiptFindMany.mockResolvedValue([{ externalTxnId: 'HSH:TXN0000006' }]);

    const result = await service.importStatement(
      {
        platform: 'CMB_QR',
        rows: [
          {
            externalTxnId: 'TXN0000006',
            amountCny: 300,
            method: PaymentMethod.WECHAT_PAY,
            receivedAt: bj('2026-07-21 23:20:17'),
          },
        ],
      },
      FINANCE,
    );

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(receiptCreateMany).not.toHaveBeenCalled();
    // 防重查询覆盖了全部平台前缀，不只是本次声明的那个
    const queriedKeys: string[] = receiptFindMany.mock.calls.at(-1)![0].where.externalTxnId.in;
    expect(queriedKeys).toEqual(
      expect.arrayContaining([
        'TXN0000006',
        'YSB:TXN0000006',
        'XYF:TXN0000006',
        'HSH:TXN0000006',
      ]),
    );
  });
});
