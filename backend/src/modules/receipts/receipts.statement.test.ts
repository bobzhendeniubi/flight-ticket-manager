/**
 * 二维码流水解析单测（纯内存，不碰 DB）。
 *
 * 覆盖：
 *   - 表头行自动定位（收单平台原表第 1 行是「订单」占位行，表头在第 2 行）
 *   - 列序按表头名对号（打乱列顺序仍解析正确）
 *   - 仅「支付成功」可导入；未支付/订单已关闭标 skipped_status
 *   - 文件内流水号重复 → 后行标 dup_in_file
 *   - 金额/时间/流水号缺失或不可解析 → invalid + warning
 *   - 支付方式映射（微信/支付宝/其它）
 *   - 交易时间按 +08:00 墙钟解释
 *   - 备注列合并进 payerNote
 *   - 核对表导出工作簿列头与行内容
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseStatementXlsx,
  buildStatementExportWorkbook,
  STATEMENT_MAX_ROWS,
  statementStorageExternalTxnId,
  type StatementExportEntry,
} from './receipts.statement.js';
import { importStatementSchema, parseStatementSchema } from './receipts.schemas.js';

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

/** 造一个收单平台风格的流水 xlsx（首行「订单」占位 + 第二行表头 + 数据行）→ base64。 */
async function buildStatementBase64(
  dataRows: Array<Array<string | number>>,
  opts: { headers?: string[]; skipPlaceholderRow?: boolean } = {},
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('订单');
  if (!opts.skipPlaceholderRow) {
    ws.addRow(HEADERS.map(() => '订单'));
  }
  ws.addRow(opts.headers ?? HEADERS);
  for (const r of dataRows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

async function buildPlatformBase64(
  sheetName: string,
  headers: string[],
  dataRows: Array<Array<string | number>>,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  for (const r of dataRows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString('base64');
}

function row(
  txnId: string,
  time: string,
  amount: string | number,
  method: string,
  status: string,
  qrRemark = '',
  payerRemark = '',
): Array<string | number> {
  return ['测试商户', '', txnId, time, amount, method, status, qrRemark, payerRemark];
}

describe('parseStatementXlsx', () => {
  it('解析标准流水：支付成功入池、其它状态标跳过', async () => {
    const b64 = await buildStatementBase64([
      row('TXN001', '2026-07-21 23:20:17', '300.00', '微信', '支付成功'),
      row('TXN002', '2026-07-21 23:19:47', '300.00', '微信', '未支付'),
      row('TXN003', '2026-07-21 22:25:36', '1558.00', '支付宝', '支付成功'),
      row('TXN004', '2026-07-21 21:56:00', '1810.00', '支付宝', '订单已关闭'),
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64);
    expect(rows).toHaveLength(4);
    expect(rows[0].disposition).toBe('ok');
    expect(rows[1].disposition).toBe('skipped_status');
    expect(rows[2].disposition).toBe('ok');
    expect(rows[3].disposition).toBe('skipped_status');
    expect(warnings).toHaveLength(0);
  });

  it('交易时间按北京时 +08:00 解释', async () => {
    const b64 = await buildStatementBase64([
      row('TXN001', '2026-07-21 23:20:17', 300, '微信', '支付成功'),
    ]);
    const { rows } = await parseStatementXlsx(b64);
    // 北京 23:20:17 = UTC 15:20:17
    expect(rows[0].receivedAt?.toISOString()).toBe('2026-07-21T15:20:17.000Z');
  });

  it('支付方式映射：微信/支付宝/其它', async () => {
    const b64 = await buildStatementBase64([
      row('TXN001', '2026-07-21 10:00:00', 100, '微信', '支付成功'),
      row('TXN002', '2026-07-21 10:01:00', 100, '支付宝', '支付成功'),
      row('TXN003', '2026-07-21 10:02:00', 100, '云闪付', '支付成功'),
    ]);
    const { rows } = await parseStatementXlsx(b64);
    expect(rows.map((r) => r.method)).toEqual(['WECHAT_PAY', 'ALIPAY', 'BANK_CARD']);
  });

  it('文件内流水号重复 → 后行 dup_in_file + warning', async () => {
    const b64 = await buildStatementBase64([
      row('TXN-DUP', '2026-07-21 10:00:00', 100, '微信', '支付成功'),
      row('TXN-DUP', '2026-07-21 10:00:00', 100, '微信', '支付成功'),
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64);
    expect(rows[0].disposition).toBe('ok');
    expect(rows[1].disposition).toBe('dup_in_file');
    expect(warnings.some((w) => w.includes('TXN-DUP'))).toBe(true);
  });

  it('缺流水号 / 金额不可解析 / 时间不可解析 → invalid + warning', async () => {
    const b64 = await buildStatementBase64([
      row('', '2026-07-21 10:00:00', 100, '微信', '支付成功'),
      row('TXN002', '2026-07-21 10:00:00', '不是数', '微信', '支付成功'),
      row('TXN003', '时间坏了', 100, '微信', '支付成功'),
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64);
    expect(rows.map((r) => r.disposition)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(warnings).toHaveLength(3);
  });

  it('金额吃千分位字符串；零金额/分以下金额（round 成 0）无效', async () => {
    const b64 = await buildStatementBase64([
      row('TXN001', '2026-07-21 10:00:00', '1,558.00', '微信', '支付成功'),
      row('TXN002', '2026-07-21 10:01:00', '0', '微信', '支付成功'),
      row('TXN003', '2026-07-21 10:02:00', 0.001, '微信', '支付成功'),
    ]);
    const { rows } = await parseStatementXlsx(b64);
    expect(rows[0].amountCny).toBe(1558);
    expect(rows[0].disposition).toBe('ok');
    expect(rows[1].disposition).toBe('invalid');
    // 0.001 若不拦会 round 成 0 元僵尸进账（认不了款也退不了款）
    expect(rows[2].disposition).toBe('invalid');
  });

  it('流水号超长（>64 字符）标 invalid，不等提交时整批被拒', async () => {
    const longId = 'X'.repeat(65);
    const b64 = await buildStatementBase64([
      row(longId, '2026-07-21 10:00:00', 100, '微信', '支付成功'),
      row('TXN-OK', '2026-07-21 10:01:00', 100, '微信', '支付成功'),
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64);
    expect(rows[0].disposition).toBe('invalid');
    expect(rows[1].disposition).toBe('ok');
    expect(warnings.some((w) => w.includes('长度异常'))).toBe(true);
  });

  it('备注超长截断到 500 字符（与 schema 上限对齐，不拒行）', async () => {
    const longNote = '备'.repeat(600);
    const b64 = await buildStatementBase64([
      row('TXN001', '2026-07-21 10:00:00', 100, '微信', '支付成功', longNote),
    ]);
    const { rows } = await parseStatementXlsx(b64);
    expect(rows[0].disposition).toBe('ok');
    expect(rows[0].payerNote?.length).toBe(500);
  });

  it('缺「交易状态」/「支付方式」列 → 显式 warning 而非静默', async () => {
    const headers = ['交易流水号', '交易时间', '交易金额'];
    const b64 = await buildStatementBase64(
      [['TXN001', '2026-07-21 10:00:00', 100]],
      { headers, skipPlaceholderRow: true },
    );
    const { rows, warnings } = await parseStatementXlsx(b64);
    // 无状态列 → rawStatus 空 ≠ 支付成功 → 全部按非成功跳过，且必须有警告说明原因
    expect(rows[0].disposition).toBe('skipped_status');
    expect(warnings.some((w) => w.includes('交易状态'))).toBe(true);
    expect(warnings.some((w) => w.includes('支付方式'))).toBe(true);
  });

  it('列序打乱仍按表头名对号解析', async () => {
    const shuffled = ['交易状态', '交易金额', '交易流水号', '支付方式', '交易时间'];
    const b64 = await buildStatementBase64(
      [['支付成功', 520, 'TXN-X', '支付宝', '2026-07-21 08:00:00']],
      { headers: shuffled, skipPlaceholderRow: true },
    );
    const { rows } = await parseStatementXlsx(b64);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalTxnId).toBe('TXN-X');
    expect(rows[0].amountCny).toBe(520);
    expect(rows[0].method).toBe('ALIPAY');
    expect(rows[0].disposition).toBe('ok');
  });

  it('备注两列合并进 payerNote', async () => {
    const b64 = await buildStatementBase64([
      row('TXN001', '2026-07-21 10:00:00', 100, '微信', '支付成功', '码A', '张三 FTM123'),
    ]);
    const { rows } = await parseStatementXlsx(b64);
    expect(rows[0].payerNote).toBe('码A / 张三 FTM123');
  });

  it('找不到表头行 → 空结果 + warning', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('随便');
    ws.addRow(['姓名', '护照号']);
    ws.addRow(['张三', 'E12345678']);
    const buf = await wb.xlsx.writeBuffer();
    const { rows, warnings } = await parseStatementXlsx(
      Buffer.from(buf as ArrayBuffer).toString('base64'),
    );
    expect(rows).toHaveLength(0);
    expect(warnings.some((w) => w.includes('表头'))).toBe(true);
  });

  it(`超过 ${STATEMENT_MAX_ROWS} 行截断 + warning`, async () => {
    const many = Array.from({ length: STATEMENT_MAX_ROWS + 5 }, (_, i) =>
      row(`TXN${i}`, '2026-07-21 10:00:00', 100, '微信', '支付成功'),
    );
    const b64 = await buildStatementBase64(many);
    const { rows, warnings } = await parseStatementXlsx(b64);
    expect(rows).toHaveLength(STATEMENT_MAX_ROWS);
    expect(warnings.some((w) => w.includes('仅解析前'))).toBe(true);
  }, 30_000);
});

describe('statement platform schemas', () => {
  it('parse/import 缺少平台时提示先选择流水平台', () => {
    const parseResult = parseStatementSchema.safeParse({ fileBase64: 'synthetic' });
    const importResult = importStatementSchema.safeParse({ rows: [] });
    expect(parseResult.success).toBe(false);
    expect(importResult.success).toBe(false);
    expect(parseResult.success ? '' : parseResult.error.issues.map((i) => i.message)).toContain(
      '请先选择流水平台',
    );
    expect(importResult.success ? '' : importResult.error.issues.map((i) => i.message)).toContain(
      '请先选择流水平台',
    );
  });
});

describe('parseStatementXlsx · 宜收宝', () => {
  const headers = ['交易单号', '日期', '交易方式', '交易状态', '交易金额', '付款人', '备注'];

  it('正常行入池、状态不符跳过、文件内重复，并保留付款备注', async () => {
    const b64 = await buildPlatformBase64('交易流水', headers, [
      ['YSB001', '2026-07-21 10:00:00', '微信支付', '支付成功', '1,558.00', '付款人甲', '订单备注'],
      ['YSB002', '2026-07-21 10:01:00', '支付宝支付', '支付失败', '300.00', '付款人乙', ''],
      ['YSB001', '2026-07-21 10:02:00', '银行卡', '支付成功', 100, '付款人丙', '重复'],
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64, 'YISHOUBAO');
    expect(rows.map((r) => r.disposition)).toEqual(['ok', 'skipped_status', 'dup_in_file']);
    expect(rows[0].amountCny).toBe(1558);
    expect(rows[0].method).toBe('WECHAT_PAY');
    expect(rows[0].payerNote).toBe('付款人甲 / 订单备注');
    expect(warnings.some((w) => w.includes('YSB001'))).toBe(true);
  });

  it('表头缺列给出宜收宝专属报错文案，且不解析数据', async () => {
    const b64 = await buildPlatformBase64(
      '交易流水',
      ['交易单号', '日期', '交易方式', '交易金额'],
      [['YSB001', '2026-07-21 10:00:00', '微信支付', 100]],
    );
    const { rows, warnings } = await parseStatementXlsx(b64, 'YISHOUBAO');
    expect(rows).toHaveLength(0);
    expect(warnings[0]).toContain('宜收宝流水表头缺少');
    expect(warnings[0]).toContain('交易状态');
    expect(warnings[0]).toContain('请上传宜收宝导出的交易流水原表');
  });

  it('存储流水号使用 YSB: 前缀，避免跨平台同号碰撞', () => {
    expect(statementStorageExternalTxnId('YISHOUBAO', 'YSB001')).toBe('YSB:YSB001');
  });
});

describe('parseStatementXlsx · 星驿付', () => {
  const headers = ['交易流水号', '交易时间', '交易金额', '支付方式', '交易状态', '交易类型', '付款人ID', '备注'];

  it('消费成功行入池，状态不符/类型不符跳过，金额支持千分位文本', async () => {
    const b64 = await buildPlatformBase64('Sheet1', headers, [
      ['XYF001', '2026-07-21 11:00:00', '2,000.00', '微信', '交易成功', '消费', 'payer-1', '备注一'],
      ['XYF002', '2026-07-21 11:01:00', 300, '支付宝', '交易失败', '消费', 'payer-2', ''],
      ['XYF003', '2026-07-21 11:02:00', 400, '银行卡', '交易成功', '退款', 'payer-3', ''],
      ['XYF001', '2026-07-21 11:03:00', 500, '微信', '交易成功', '消费', 'payer-4', '重复'],
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64, 'XINGYIFU');
    expect(rows.map((r) => r.disposition)).toEqual([
      'ok',
      'skipped_status',
      'skipped_type',
      'dup_in_file',
    ]);
    expect(rows[0].amountCny).toBe(2000);
    expect(rows[0].method).toBe('WECHAT_PAY');
    expect(rows[0].payerNote).toBe('payer-1 / 备注一');
    expect(warnings.some((w) => w.includes('XYF001'))).toBe(true);
  });

  it('非法金额行标记 invalid 并给出原因', async () => {
    const b64 = await buildPlatformBase64('Sheet1', headers, [
      ['XYF004', '2026-07-21 11:04:00', '金额坏了', '微信', '交易成功', '消费', 'payer-4', ''],
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64, 'XINGYIFU');
    expect(rows[0].disposition).toBe('invalid');
    expect(warnings[0]).toContain('金额不可解析');
  });

  it('表头缺列给出星驿付专属报错文案', async () => {
    const b64 = await buildPlatformBase64(
      'Sheet1',
      ['交易流水号', '交易时间', '交易金额', '支付方式', '交易状态'],
      [['XYF005', '2026-07-21 11:05:00', 100, '微信', '交易成功']],
    );
    const { rows, warnings } = await parseStatementXlsx(b64, 'XINGYIFU');
    expect(rows).toHaveLength(0);
    expect(warnings[0]).toContain('星驿付流水表头缺少');
    expect(warnings[0]).toContain('交易类型');
    expect(warnings[0]).toContain('请上传星驿付导出的交易流水原表');
  });

  it('存储流水号使用 XYF: 前缀，避免跨平台同号碰撞', () => {
    expect(statementStorageExternalTxnId('XINGYIFU', 'XYF001')).toBe('XYF:XYF001');
  });
});

describe('parseStatementXlsx · 会生活', () => {
  // 列名取自会生活逐笔明细模板（数据全部虚构）
  const headers = [
    '交易时间',
    '交易完成时间',
    '交易金额',
    '优惠金额',
    '实付金额',
    '商户入账金额',
    '交易类型',
    '支付方式',
    '交易状态',
    '收款备注',
    '商户订单号',
    '会生活单号',
    '流水号',
    '当前状态',
    '清算日期',
    '交易来源',
  ];

  function hshRow(opts: {
    txnId: string;
    time?: string;
    gross?: number | string;
    discount?: number;
    paid?: number | string;
    type?: string;
    method?: string;
    status?: string;
    note?: string;
    current?: string;
  }): Array<string | number> {
    return [
      opts.time ?? '2026-07-23 22:21:31',
      '2026-07-23 22:21:44',
      opts.gross ?? 2000,
      opts.discount ?? 0,
      opts.paid ?? 2000,
      1995,
      opts.type ?? '收款',
      opts.method ?? '微信支付',
      opts.status ?? '收款成功',
      opts.note ?? '',
      opts.txnId,
      '83620990101000000000',
      'HSHFLOW0001',
      opts.current ?? '正常',
      '2026-07-23',
      '会生活收款',
    ];
  }

  it('收款成功且当前状态正常入池；退款/失败/撤销行按类型或状态跳过', async () => {
    const b64 = await buildPlatformBase64('Sheet1', headers, [
      hshRow({ txnId: '222099010100000000000000101', note: '付款人甲' }),
      hshRow({ txnId: '222099010100000000000000102', type: '退款', status: '退款成功' }),
      hshRow({ txnId: '222099010100000000000000103', status: '收款失败' }),
      // 类型闸单测：状态成功但类型非收款
      hshRow({ txnId: '222099010100000000000000104', type: '预授权' }),
      // 当前状态闸单测：收款成功但已撤销
      hshRow({ txnId: '222099010100000000000000105', current: '已撤销' }),
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows.map((r) => r.disposition)).toEqual([
      'ok',
      'skipped_status',
      'skipped_status',
      'skipped_type',
      'skipped_status',
    ]);
    expect(rows[0].payerNote).toBe('付款人甲');
    expect(warnings).toHaveLength(0);
  });

  it('金额取「实付金额」（有优惠时 ≠ 交易金额），千分位文本也吃', async () => {
    const b64 = await buildPlatformBase64('Sheet1', headers, [
      hshRow({
        txnId: '222099010100000000000000201',
        gross: 1680,
        discount: 30,
        paid: '1,650.00',
      }),
    ]);
    const { rows } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows[0].disposition).toBe('ok');
    expect(rows[0].amountCny).toBe(1650);
  });

  it('支付方式映射微信支付/支付宝；交易时间按北京时 +08:00 解释', async () => {
    const b64 = await buildPlatformBase64('Sheet1', headers, [
      hshRow({ txnId: '222099010100000000000000301', method: '微信支付' }),
      hshRow({
        txnId: '222099010100000000000000302',
        method: '支付宝',
        time: '2026-07-23 22:05:42',
      }),
    ]);
    const { rows } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows.map((r) => r.method)).toEqual(['WECHAT_PAY', 'ALIPAY']);
    // 北京 22:05:42 = UTC 14:05:42
    expect(rows[1].receivedAt?.toISOString()).toBe('2026-07-23T14:05:42.000Z');
  });

  it('列序打乱仍按表头名对号解析', async () => {
    const shuffled = [
      '当前状态',
      '实付金额',
      '商户订单号',
      '支付方式',
      '交易时间',
      '交易状态',
      '交易类型',
      '收款备注',
    ];
    const b64 = await buildPlatformBase64('Sheet1', shuffled, [
      [
        '正常',
        888,
        '222099010100000000000000401',
        '支付宝',
        '2026-07-23 09:00:00',
        '收款成功',
        '收款',
        '付款人乙',
      ],
    ]);
    const { rows } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows).toHaveLength(1);
    expect(rows[0].externalTxnId).toBe('222099010100000000000000401');
    expect(rows[0].amountCny).toBe(888);
    expect(rows[0].method).toBe('ALIPAY');
    expect(rows[0].payerNote).toBe('付款人乙');
    expect(rows[0].disposition).toBe('ok');
  });

  it('文件内商户订单号重复 → 后行 dup_in_file + warning', async () => {
    const b64 = await buildPlatformBase64('Sheet1', headers, [
      hshRow({ txnId: '222099010100000000000000501' }),
      hshRow({ txnId: '222099010100000000000000501' }),
    ]);
    const { rows, warnings } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows.map((r) => r.disposition)).toEqual(['ok', 'dup_in_file']);
    expect(warnings.some((w) => w.includes('222099010100000000000000501'))).toBe(true);
  });

  it('表头缺列给出会生活专属报错文案，且不解析数据', async () => {
    const b64 = await buildPlatformBase64(
      'Sheet1',
      ['交易时间', '实付金额', '商户订单号', '支付方式', '交易状态', '交易类型'],
      [
        [
          '2026-07-23 10:00:00',
          100,
          '222099010100000000000000601',
          '微信支付',
          '收款成功',
          '收款',
        ],
      ],
    );
    const { rows, warnings } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows).toHaveLength(0);
    expect(warnings[0]).toContain('会生活流水表头缺少');
    expect(warnings[0]).toContain('当前状态');
  });

  it('整表不匹配（如按日汇总表）→ 报错提示需逐笔明细模板', async () => {
    const b64 = await buildPlatformBase64(
      'Sheet1',
      ['日期', '收款笔数', '收款总额'],
      [['2026-07-23', 54, 88888]],
    );
    const { rows, warnings } = await parseStatementXlsx(b64, 'HUISHENGHUO');
    expect(rows).toHaveLength(0);
    expect(warnings[0]).toContain('逐笔明细模板');
    expect(warnings[0]).toContain('按日汇总表不支持');
  });

  it('存储流水号使用 HSH: 前缀，避免跨平台同号碰撞（DB 防重沿用唯一索引）', () => {
    expect(statementStorageExternalTxnId('HUISHENGHUO', '222099010100000000000000701')).toBe(
      'HSH:222099010100000000000000701',
    );
  });
});

describe('buildStatementExportWorkbook', () => {
  it('列头齐全，认款标识/订单/认款人落到行里', () => {
    const entries: StatementExportEntry[] = [
      {
        receivedAt: new Date('2026-07-21T15:20:17.000Z'), // 北京 23:20
        externalTxnId: 'TXN001',
        receiptNo: 'RCP20260721ABC',
        amountCny: 300,
        methodLabel: '微信',
        sourceLabel: '流水导入',
        statusLabel: '已认款',
        allocatedCny: 300,
        remainingCny: 0,
        allocationsText: 'FTM2026072100001 ¥300.00',
        lastAllocatedAt: new Date('2026-07-22T02:00:00.000Z'),
        allocatorNames: '财务甲',
        payerNote: null,
        refundNote: null,
      },
    ];
    const wb = buildStatementExportWorkbook(entries);
    const ws = wb.getWorksheet('流水核对表');
    expect(ws).toBeDefined();
    const headerTexts: string[] = [];
    ws!.getRow(1).eachCell((c) => headerTexts.push(String(c.value)));
    expect(headerTexts).toEqual([
      '到账时间',
      '交易流水号',
      '进账号',
      '金额',
      '收款方式',
      '来源',
      '认款状态',
      '已认金额',
      '未认余额',
      '认到订单',
      '最近认款时间',
      '认款人',
      '付款备注',
      '退款备注',
    ]);
    const r2 = ws!.getRow(2);
    expect(r2.getCell(1).value).toBe('2026-07-21 23:20'); // 北京墙钟
    expect(r2.getCell(2).value).toBe('TXN001');
    expect(r2.getCell(7).value).toBe('已认款');
    expect(r2.getCell(10).value).toBe('FTM2026072100001 ¥300.00');
    expect(r2.getCell(12).value).toBe('财务甲');
  });
});
