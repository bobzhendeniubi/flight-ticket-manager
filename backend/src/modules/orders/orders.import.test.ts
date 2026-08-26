/**
 * 旧系统表格导入（orders.import）· 单元测试（vitest，纯内存 xlsx，匹配用注入的假依赖，不碰 DB）。
 *
 * 覆盖：
 *   - 16 列单程 / 18 列往返模版识别 + 逐行解析
 *   - 表头乱序（按表头名定位列）
 *   - 日期：dd-MM-yyyy / yyyy-MM-dd 文本、Excel 日期单元格、歧义拒收
 *   - 舱位别名（经济舱/商务/Y/C…）与未知舱位行级错误
 *   - 行级错误聚合（缺证件号/缺生日/缺有效日期/查无班次/与首行不一致）
 *   - resolve：班次匹配、代理精确/模糊/歧义匹配、代理身份忽略结算价与代理列
 *   - 坏文件：.xls 魔数 / 非 xlsx / 空表 / 表头对不上 / 超 2MB
 *
 * 测试数据全部虚构。
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  matchAgentText,
  matchCabinText,
  OrderImportError,
  parseOrderImportXlsx,
  resolveOrderImport,
  ORDER_IMPORT_MAX_BYTES,
  type OrderImportMatchDeps,
  type OrderImportScheduleLite,
} from './orders.import.js';

// ── 构造工具 ──────────────────────────────────────────────────────────────
async function rowsToXlsxBase64(rows: Array<Array<string | Date | number | null>>): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet0');
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

const ONEWAY_HEADER = [
  '选择代理', '航班号', '航班日期(yyyy-MM-dd)', '舱位', '结算价格',
  '中文姓名', '乘客姓名', '与婴儿乘客通行成人姓名', '乘客性别', '乘客生日(dd-MM-yyyy)',
  '公民身份/国籍', '证件类型', '证件编号', '签发日期(dd-MM-yyyy)', '有效日期(dd-MM-yyyy)', '备注',
];

const ROUNDTRIP_HEADER = [
  '选择代理', '去程航班号', '去程航班日期(yyyy-MM-dd)', '返程航班号', '返程航班日期(yyyy-MM-dd)',
  '舱位', '结算价格', '中文姓名', '乘客姓名', '与婴儿乘客通行成人姓名', '乘客性别',
  '乘客生日(dd-MM-yyyy)', '公民身份/国籍', '证件类型', '证件编号',
  '签发日期(dd-MM-yyyy)', '有效日期(dd-MM-yyyy)', '备注',
];

/** 单程模版数据行（16 列，虚构乘客）。*/
function onewayRow(over: Partial<Record<
  'agent' | 'flightNo' | 'date' | 'cabin' | 'price' | 'chineseName' | 'pnrName' | 'infant'
  | 'gender' | 'dob' | 'nationality' | 'docType' | 'docNumber' | 'issueDate' | 'expiryDate' | 'remarks',
  string | Date | number | null
>> = {}): Array<string | Date | number | null> {
  const d = {
    agent: '云帆国旅', flightNo: 'QH9588', date: '2026-08-15', cabin: '经济舱', price: 1500 as string | Date | number | null,
    chineseName: '测试甲', pnrName: 'CE/SHIJIA', infant: '', gender: '男', dob: '15-07-1988' as string | Date | number | null,
    nationality: 'CN', docType: '护照', docNumber: 'E00000001', issueDate: '10-03-2020',
    expiryDate: '09-03-2030' as string | Date | number | null, remarks: '',
    ...over,
  };
  return [
    d.agent, d.flightNo, d.date, d.cabin, d.price, d.chineseName, d.pnrName, d.infant,
    d.gender, d.dob, d.nationality, d.docType, d.docNumber, d.issueDate, d.expiryDate, d.remarks,
  ];
}

/** 假匹配依赖：注入班次/代理数据。*/
function fakeDeps(opts: {
  schedules?: OrderImportScheduleLite[];
  agents?: Array<{ id: string; companyName: string | null; contactName: string }>;
} = {}): OrderImportMatchDeps {
  return {
    listAgents: async () => opts.agents ?? [],
    findSchedules: async () => opts.schedules ?? [],
  };
}

const SCHED_QH9588 = {
  id: 'sched-1', flightId: 'flight-1', flightNumber: 'QH9588', departureDate: '2026-08-15',
};
const SCHED_QH9589 = {
  id: 'sched-2', flightId: 'flight-2', flightNumber: 'QH9589', departureDate: '2026-08-20',
};

// ── 模版识别 + 解析 ───────────────────────────────────────────────────────
describe('parseOrderImportXlsx · 模版识别与逐行解析', () => {
  it('16 列单程模版：识别为 ONEWAY，字段逐项标准化', async () => {
    const b64 = await rowsToXlsxBase64([ONEWAY_HEADER, onewayRow()]);
    const out = await parseOrderImportXlsx(b64);

    expect(out.template).toBe('ONEWAY');
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0];
    expect(row.errors).toEqual([]);
    expect(row.agentText).toBe('云帆国旅');
    expect(row.legs).toEqual([
      { kind: 'outbound', flightNo: 'QH9588', date: '2026-08-15', scheduleId: null, flightId: null },
    ]);
    expect(row.cabin).toBe('ECONOMY');
    expect(row.settlementPriceCny).toBe(1500);
    expect(row.passenger).toMatchObject({
      chineseName: '测试甲',
      fullName: '测试甲',
      lastName: 'CE',
      firstName: 'SHIJIA',
      gender: 'M',
      dateOfBirth: '1988-07-15', // dd-MM-yyyy → ISO
      nationality: 'CN',
      documentType: 'PASSPORT',
      documentNumber: 'E00000001',
      passportIssueDate: '2020-03-10',
      passportExpiry: '2030-03-09',
    });
  });

  it('18 列往返模版：识别为 ROUNDTRIP，两条航段都解析', async () => {
    const b64 = await rowsToXlsxBase64([
      ROUNDTRIP_HEADER,
      [
        '云帆国旅', 'QH9588', '2026-08-15', 'QH9589', '2026-08-20', '商务舱', 2800,
        '测试乙', 'CE/SHIYI', '', '女', '01-12-1990', 'CHN', 'PASSPORT', 'E00000002',
        '05-06-2021', '04-06-2031', '靠窗',
      ],
    ]);
    const out = await parseOrderImportXlsx(b64);

    expect(out.template).toBe('ROUNDTRIP');
    const row = out.rows[0];
    expect(row.errors).toEqual([]);
    expect(row.legs).toEqual([
      { kind: 'outbound', flightNo: 'QH9588', date: '2026-08-15', scheduleId: null, flightId: null },
      { kind: 'inbound', flightNo: 'QH9589', date: '2026-08-20', scheduleId: null, flightId: null },
    ]);
    expect(row.cabin).toBe('BUSINESS');
    expect(row.passenger.dateOfBirth).toBe('1990-12-01');
    expect(row.passenger.nationality).toBe('CN'); // CHN → CN
    expect(row.passenger.gender).toBe('F');
    expect(row.passenger.note).toBe('靠窗');
  });

  it('表头乱序：按表头名定位列，不依赖列号', async () => {
    const header = ['证件编号', '中文姓名', '航班日期(yyyy-MM-dd)', '航班号', '乘客生日(dd-MM-yyyy)', '有效日期(dd-MM-yyyy)', '舱位'];
    const b64 = await rowsToXlsxBase64([
      header,
      ['E00000003', '测试丙', '2026-09-01', 'QH9588', '02-02-1992', '01-01-2032', 'Y'],
    ]);
    const out = await parseOrderImportXlsx(b64);

    expect(out.template).toBe('ONEWAY');
    const row = out.rows[0];
    expect(row.passenger.documentNumber).toBe('E00000003');
    expect(row.passenger.fullName).toBe('测试丙');
    expect(row.legs[0]).toMatchObject({ flightNo: 'QH9588', date: '2026-09-01' });
    expect(row.passenger.dateOfBirth).toBe('1992-02-02');
    expect(row.cabin).toBe('ECONOMY'); // Y → ECONOMY
  });

  it('日期单元格（Excel Date）：接受并转 ISO + 提醒核对', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({
        date: new Date(Date.UTC(2026, 7, 15)),
        dob: new Date(Date.UTC(1988, 6, 15)),
        expiryDate: new Date(Date.UTC(2030, 2, 9)),
      }),
    ]);
    const out = await parseOrderImportXlsx(b64);
    const row = out.rows[0];

    expect(row.errors).toEqual([]);
    expect(row.legs[0].date).toBe('2026-08-15');
    expect(row.passenger.dateOfBirth).toBe('1988-07-15');
    expect(row.passenger.passportExpiry).toBe('2030-03-09');
    // Excel 已把原文吃掉 → 每格一条「请核对」提醒
    expect(row.warnings.some((w) => w.includes('Excel 识别为日期单元格'))).toBe(true);
  });

  it('歧义日期（各段均 ≤31）拒收为行级错误，不猜', async () => {
    const b64 = await rowsToXlsxBase64([ONEWAY_HEADER, onewayRow({ dob: '05-06-07' })]);
    const out = await parseOrderImportXlsx(b64);
    const row = out.rows[0];

    expect(row.passenger.dateOfBirth).toBeUndefined();
    expect(row.errors.some((e) => e.includes('乘客生日') && e.includes('无法判定'))).toBe(true);
  });

  it('舱位别名：C→商务；未知舱位文本 → 行级错误；空舱位 → 提醒默认经济舱', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ cabin: 'C', docNumber: 'E00000011' }),
      onewayRow({ cabin: '豪华头等太空舱', docNumber: 'E00000012' }),
      onewayRow({ cabin: '', docNumber: 'E00000013' }),
    ]);
    const out = await parseOrderImportXlsx(b64);

    expect(out.rows[0].cabin).toBe('BUSINESS');
    expect(out.rows[1].cabin).toBeNull();
    expect(out.rows[1].errors.some((e) => e.includes('舱位') && e.includes('无法识别'))).toBe(true);
    expect(out.rows[2].cabin).toBeNull();
    expect(out.rows[2].warnings.some((w) => w.includes('默认经济舱'))).toBe(true);
  });

  it('行级错误聚合：缺证件号 / 缺生日 / 缺有效日期各自成条，行仍保留', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ docNumber: '', dob: '', expiryDate: '' }),
    ]);
    const out = await parseOrderImportXlsx(b64);
    const row = out.rows[0];

    expect(out.rows).toHaveLength(1); // 不整行丢弃，留给人工补
    expect(row.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('证件编号未填'),
        expect.stringContaining('乘客生日未填'),
        expect.stringContaining('有效日期未填'),
      ]),
    );
  });

  it('证件类型对不上 → 默认护照 + 警告；性别无法识别 → 警告留空', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ docType: '军官证', gender: '未知' }),
    ]);
    const out = await parseOrderImportXlsx(b64);
    const row = out.rows[0];

    expect(row.passenger.documentType).toBe('PASSPORT');
    expect(row.warnings.some((w) => w.includes('证件类型') && w.includes('默认按护照'))).toBe(true);
    expect(row.passenger.gender).toBeUndefined();
    expect(row.warnings.some((w) => w.includes('性别'))).toBe(true);
  });

  it('结算价格：文本 ¥/元/千分位可解析；负数为行级错误', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ price: '¥1,500元', docNumber: 'E00000021' }),
      onewayRow({ price: -5, docNumber: 'E00000022' }),
    ]);
    const out = await parseOrderImportXlsx(b64);

    expect(out.rows[0].settlementPriceCny).toBe(1500);
    expect(out.rows[1].settlementPriceCny).toBeNull();
    expect(out.rows[1].errors.some((e) => e.includes('结算价格不能为负'))).toBe(true);
  });
});

// ── 坏文件 ────────────────────────────────────────────────────────────────
describe('parseOrderImportXlsx · 坏文件全部 OrderImportError（路由转 400）', () => {
  it('旧 .xls（OLE 魔数）→ 提示另存为 .xlsx', async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]).toString('base64');
    await expect(parseOrderImportXlsx(ole)).rejects.toThrowError(/另存为.*\.xlsx/);
  });

  it('非 xlsx 内容 → 明确报错', async () => {
    const junk = Buffer.from('这不是表格文件').toString('base64');
    await expect(parseOrderImportXlsx(junk)).rejects.toThrowError(OrderImportError);
  });

  it('超过 2MB → 拒收', async () => {
    const big = Buffer.alloc(ORDER_IMPORT_MAX_BYTES + 1, 0x50).toString('base64');
    await expect(parseOrderImportXlsx(big)).rejects.toThrowError(/2MB/);
  });

  it('表头对不上（无航班号列）→ 明确报错', async () => {
    const b64 = await rowsToXlsxBase64([['姓名', '电话'], ['测试丁', '13800000000']]);
    await expect(parseOrderImportXlsx(b64)).rejects.toThrowError(/表头/);
  });

  it('只有表头没有数据行 → 明确报错', async () => {
    const b64 = await rowsToXlsxBase64([ONEWAY_HEADER]);
    await expect(parseOrderImportXlsx(b64)).rejects.toThrowError(/没有数据行/);
  });

  it('空 base64 → 明确报错', async () => {
    await expect(parseOrderImportXlsx('')).rejects.toThrowError(/文件内容为空/);
  });
});

// ── resolve：班次 / 代理 / 批次汇总 ───────────────────────────────────────
describe('resolveOrderImport · 匹配与批次汇总', () => {
  it('班次唯一匹配 → 填 scheduleId；查无班次 → 行级错误', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ docNumber: 'E00000031' }),
      onewayRow({ date: '2026-08-16', docNumber: 'E00000032' }), // 该日无班次
    ]);
    const parsed = await parseOrderImportXlsx(b64);
    const res = await resolveOrderImport(parsed, fakeDeps({ schedules: [SCHED_QH9588] }), {
      includeSettlement: true,
      includeAgent: true,
    });

    expect(res.rows[0].legs[0]).toMatchObject({ scheduleId: 'sched-1', flightId: 'flight-1' });
    expect(res.rows[1].legs[0].scheduleId).toBeNull();
    expect(res.rows[1].errors.some((e) => e.includes('查无班次：QH9588 2026-08-16'))).toBe(true);
    expect(res.batch.outbound).toMatchObject({
      flightNo: 'QH9588', date: '2026-08-15', scheduleId: 'sched-1',
    });
    expect(res.batch.cabin).toBe('ECONOMY');
    expect(res.batch.settlementPriceCny).toBe(1500);
  });

  it('往返：去/回程各自匹配班次', async () => {
    const b64 = await rowsToXlsxBase64([
      ROUNDTRIP_HEADER,
      [
        '云帆国旅', 'QH9588', '2026-08-15', 'QH9589', '2026-08-20', '经济舱', 1500,
        '测试戊', 'CE/SHIWU', '', '男', '15-07-1988', 'CN', '护照', 'E00000033',
        '10-03-2020', '09-03-2030', '',
      ],
    ]);
    const parsed = await parseOrderImportXlsx(b64);
    const res = await resolveOrderImport(
      parsed,
      fakeDeps({ schedules: [SCHED_QH9588, SCHED_QH9589] }),
      { includeSettlement: true, includeAgent: true },
    );

    expect(res.rows[0].errors).toEqual([]);
    expect(res.batch.outbound?.scheduleId).toBe('sched-1');
    expect(res.batch.inbound?.scheduleId).toBe('sched-2');
  });

  it('与首行不同航班/日期的行 → 行级错误（一批只能同一班次）', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ docNumber: 'E00000041' }),
      onewayRow({ flightNo: 'QH9589', date: '2026-08-20', docNumber: 'E00000042' }),
    ]);
    const parsed = await parseOrderImportXlsx(b64);
    const res = await resolveOrderImport(
      parsed,
      fakeDeps({ schedules: [SCHED_QH9588, SCHED_QH9589] }),
      { includeSettlement: true, includeAgent: true },
    );

    expect(res.rows[0].errors).toEqual([]);
    expect(res.rows[1].errors.some((e) => e.includes('与第一行') && e.includes('拆到另一批'))).toBe(true);
  });

  it('代理：精确唯一命中带 agentId；歧义只给候选 + 顶层提醒', async () => {
    const agents = [
      { id: 'ag-1', companyName: '云帆国旅', contactName: '虚构联系人一' },
      { id: 'ag-2', companyName: '云帆国际旅行社', contactName: '虚构联系人二' },
    ];
    // 精确命中
    expect(matchAgentText('云帆国旅', agents)).toMatchObject({ agentId: 'ag-1' });
    // 模糊歧义（'云帆' 两家都含）
    const fuzzy = matchAgentText('云帆', agents);
    expect(fuzzy.agentId).toBeNull();
    expect(fuzzy.candidates).toHaveLength(2);

    const b64 = await rowsToXlsxBase64([ONEWAY_HEADER, onewayRow({ agent: '云帆' })]);
    const parsed = await parseOrderImportXlsx(b64);
    const res = await resolveOrderImport(
      parsed,
      fakeDeps({ schedules: [SCHED_QH9588], agents }),
      { includeSettlement: true, includeAgent: true },
    );
    expect(res.batch.agent?.agentId).toBeNull();
    expect(res.batch.agent?.candidates).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes('匹配到多个候选'))).toBe(true);
  });

  it('代理身份上传（includeSettlement/includeAgent=false）：结算价与代理列忽略并提示', async () => {
    const b64 = await rowsToXlsxBase64([ONEWAY_HEADER, onewayRow()]);
    const parsed = await parseOrderImportXlsx(b64);
    const res = await resolveOrderImport(parsed, fakeDeps({ schedules: [SCHED_QH9588] }), {
      includeSettlement: false,
      includeAgent: false,
    });

    expect(res.batch.settlementPriceCny).toBeNull();
    expect(res.batch.agent).toBeNull();
    expect(res.rows[0].settlementPriceCny).toBeNull();
    expect(res.warnings.some((w) => w.includes('结算价格') && w.includes('已忽略'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('选择代理') && w.includes('已忽略'))).toBe(true);
  });

  it('结算价不一致 → 不自动填入 + 顶层提醒', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ docNumber: 'E00000051' }),
      onewayRow({ price: 1600, docNumber: 'E00000052' }),
    ]);
    const parsed = await parseOrderImportXlsx(b64);
    const res = await resolveOrderImport(parsed, fakeDeps({ schedules: [SCHED_QH9588] }), {
      includeSettlement: true,
      includeAgent: true,
    });

    expect(res.batch.settlementPriceCny).toBeNull();
    expect(res.warnings.some((w) => w.includes('结算价格不一致'))).toBe(true);
  });

  it('resolve 不改入参（解析结果保持原样）', async () => {
    const b64 = await rowsToXlsxBase64([ONEWAY_HEADER, onewayRow()]);
    const parsed = await parseOrderImportXlsx(b64);
    const before = JSON.stringify(parsed);
    await resolveOrderImport(parsed, fakeDeps({ schedules: [SCHED_QH9588] }), {
      includeSettlement: true,
      includeAgent: true,
    });
    expect(JSON.stringify(parsed)).toBe(before);
  });
});

// ── passengerType 派生（按出生日期 + 出发日，同 pnr-export.ts derivePtcByAge 口径）──
describe('parseOrderImportXlsx · passengerType 按年龄派生', () => {
  it('出发日与出生日期相差 38 年 → 成人', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ date: '2026-08-15', dob: '15-07-1988', docNumber: 'E00000061' }),
    ]);
    const out = await parseOrderImportXlsx(b64);
    expect(out.rows[0].passenger.passengerType).toBe('ADULT');
  });

  it('出发日与出生日期相差 6 年 → 儿童', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ date: '2026-08-15', dob: '15-08-2020', docNumber: 'E00000062' }),
    ]);
    const out = await parseOrderImportXlsx(b64);
    expect(out.rows[0].passenger.passengerType).toBe('CHILD');
  });

  it('出发日与出生日期相差 1 年 → 婴儿（名单导入此前落库一律按成人，多收钱+虚占座）', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ date: '2026-08-15', dob: '15-08-2025', docNumber: 'E00000063' }),
    ]);
    const out = await parseOrderImportXlsx(b64);
    expect(out.rows[0].passenger.passengerType).toBe('INFANT');
  });

  it('出生日期缺失/无法解析 → 不设 passengerType，沿用建单侧默认值（成人）', async () => {
    const b64 = await rowsToXlsxBase64([
      ONEWAY_HEADER,
      onewayRow({ dob: '05-06-07', docNumber: 'E00000064' }), // 歧义日期，拒收
    ]);
    const out = await parseOrderImportXlsx(b64);
    expect(out.rows[0].passenger.dateOfBirth).toBeUndefined();
    expect(out.rows[0].passenger.passengerType).toBeUndefined();
  });
});

// ── matchCabinText 单点 ───────────────────────────────────────────────────
describe('matchCabinText', () => {
  it('常见写法全覆盖', () => {
    expect(matchCabinText('经济舱')).toBe('ECONOMY');
    expect(matchCabinText('经济')).toBe('ECONOMY');
    expect(matchCabinText('y')).toBe('ECONOMY');
    expect(matchCabinText('商务舱')).toBe('BUSINESS');
    expect(matchCabinText('商务')).toBe('BUSINESS');
    expect(matchCabinText('C')).toBe('BUSINESS');
    expect(matchCabinText('J')).toBe('BUSINESS');
    expect(matchCabinText('头等舱')).toBe('FIRST');
    expect(matchCabinText('超级经济舱')).toBe('PREMIUM_ECONOMY');
    expect(matchCabinText('')).toBeNull();
    expect(matchCabinText('豪华太空舱')).toBeNull();
  });
});
