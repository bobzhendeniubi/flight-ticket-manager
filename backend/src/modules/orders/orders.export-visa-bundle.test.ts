/**
 * 签证资料导出 · 单元测试（vitest）
 *
 * 覆盖签证岗反馈：「勾选若干订单，把这些订单的签证名单导出在同一张表格上，护照也一起下载」，
 * 以及 0713 拆分反馈：「表单独、护照打包」——合并名单 xlsx 与护照图 zip 分开两个导出。
 *   - 选单口径：queryOrdersByIdsForVisa 按勾选订单 id 取单（软删排除，空列表短路不查库）
 *   - 状态过滤：buildVisaRosterXlsx 静默不计入不合格单；buildVisaPassportsZip 在 README 点名跳过
 *   - 排序：sortOrdersForVisa 按「代理机构名 → 订单号」分组，直客（无代理）排最后
 *   - xlsx 含性别列，且每位乘客一行合并（跨订单）；名单不再打包进 zip
 *   - 护照图文件名规则：{订单号}-{LASTNAME}_{FIRSTNAME}.{ext}，无图乘客缺文件；zip 内不含 xlsx
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

// 模块链路（orders.export-templates → orders.service / passport-zip）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  buildVisaBundleXlsx,
  buildVisaRosterXlsx,
  buildVisaPassportsZip,
  queryOrdersByIdsForVisa,
  sortOrdersForVisa,
  visaRosterXlsxFilename,
  visaPassportsZipFilename,
} from './orders.export-visa-bundle.js';
import type { OrderForTemplateExport } from './orders.export-templates.js';

const D = (s: string): Date => new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : `${s}Z`);

/** 造一位乘客（只填签证名单/文件名关心的字段）。*/
function pax(overrides: Record<string, unknown>): OrderForTemplateExport['passengers'][number] {
  return {
    id: 'p_default',
    orderId: 'o1',
    fullName: 'ZHANG SAN',
    lastName: null,
    firstName: null,
    title: null,
    gender: 'M',
    documentType: 'PASSPORT',
    documentNumber: 'E12345678',
    dateOfBirth: D('1990-01-01'),
    placeOfBirth: null,
    nationality: 'CN',
    passengerType: 'ADULT',
    chineseName: null,
    passportIssueDate: null,
    passportIssueCountry: null,
    passportIssuePlace: null,
    passportExpiry: D('2030-01-01'),
    visaNumber: null,
    visaType: null,
    visaIssueDate: null,
    visaEffectiveDate: null,
    visaExpiry: null,
    visaPlaceOfIssue: null,
    visaCountryOfApplication: null,
    addressType: null,
    addressDetails: null,
    addressCity: null,
    addressState: null,
    addressCountry: null,
    addressZip: null,
    mealPreference: null,
    needsWheelchair: false,
    needsInfantBassinet: false,
    bedPref: null,
    passportPhotoUrl: null,
    pnr: null,
    eticketNumber: null,
    createdAt: D('2026-07-08'),
    updatedAt: D('2026-07-08'),
    ...overrides,
  } as OrderForTemplateExport['passengers'][number];
}

/** 造一张订单（一段机票 + 若干乘客）。overrides 可覆盖 status / agent 等。*/
function makeOrder(
  orderNumber: string,
  passengers: OrderForTemplateExport['passengers'],
  overrides: Record<string, unknown> = {},
): OrderForTemplateExport {
  return {
    id: `id_${orderNumber}`,
    orderNumber,
    status: 'PAID',
    agent: { companyName: '测试代理' },
    user: null,
    guestName: null,
    notes: null,
    noteSpecial: null,
    noteHotel: null,
    noteVisa: null,
    notePayment: null,
    roomAssignment: null,
    prepaymentOffset: 0,
    invoiceStatus: 'NONE',
    total: '2000',
    paidAmount: '0',
    createdAt: D('2026-07-01T09:00:00'),
    passengers,
    payments: [],
    refunds: [],
    items: [
      {
        kind: 'FLIGHT',
        amount: '2000',
        description: 'HAN',
        flightCabin: 'ECONOMY',
        flightSchedule: {
          departureTime: D('2026-07-10T02:00:00'),
          flight: { flightNumber: 'VN123', originCode: 'CTU', destinationCode: 'HAN' },
        },
        hotelRoomType: null,
        visa: null,
        transfer: null,
        bundle: null,
        fulfillmentTasks: [],
      },
    ],
    ...overrides,
  } as unknown as OrderForTemplateExport;
}

/** 从 xlsx Buffer 解出「签证专用」表的数据行（header→值 map）。*/
async function readVisaSheet(xlsxBuf: Buffer): Promise<Array<Record<string, string>>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuf);
  const ws = wb.getWorksheet('签证专用');
  expect(ws, '工作表「签证专用」应存在').toBeTruthy();

  const headers: string[] = [];
  ws!.getRow(1).eachCell((cell, col) => {
    headers[col] = String(cell.value ?? '');
  });
  const rows: Array<Record<string, string>> = [];
  ws!.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rec: Record<string, string> = {};
    row.eachCell((cell, col) => {
      rec[headers[col]] = cell.value == null ? '' : String(cell.value);
    });
    rows.push(rec);
  });
  return rows;
}

// 表头常量（含换行的越/中双语表头）
const GENDER_HEADER = 'Giới tính (*)\n性别';
const NAME_HEADER = 'Họ và tên (*)\n姓名';
const PASSPORT_HEADER = 'Số hộ chiếu (*)\n护照号';

/** 读取已加载单元格的填充色 argb（无填充返回 undefined）。*/
const fillArgb = (cell: ExcelJS.Cell): string | undefined =>
  (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;

/**
 * 从 xlsx Buffer 加载「签证专用」工作表（带样式，供排版断言用）。
 * 环境 @types/node 的 Buffer 泛型与 exceljs 的 load(Buffer) 定义不一致，在此收口一次 cast。
 */
async function loadVisaWorksheet(xlsxBuf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsxBuf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb.getWorksheet('签证专用')!;
}

describe('buildVisaBundleXlsx — 合并签证名单', () => {
  it('跨订单每位乘客一行合并，含性别列与「有无护照图」标注', async () => {
    const orders = [
      makeOrder('FTM2026071000001', [
        pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', gender: 'M', passportPhotoUrl: null }),
        pax({ id: 'a2', lastName: 'LI', firstName: 'SI', gender: 'F', passportPhotoUrl: 'https://x.test/li.jpg' }),
      ]),
      makeOrder('FTM2026071000002', [
        pax({ id: 'b1', lastName: 'ZHAO', firstName: 'WU', gender: 'M', passportPhotoUrl: null }),
      ]),
    ];

    const buf = await buildVisaBundleXlsx(orders);
    const rows = await readVisaSheet(buf);

    // 3 位乘客合并成 3 行，序号连续（首列表头按签证岗样表用「序号」）
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['序号'])).toEqual(['1', '2', '3']);

    // 姓名（LAST/FIRST）合并正确，纯拼音名不带性别称谓（签证岗反馈：英文名不需要带性别；
    // 本表另有独立「性别」列 Giới tính）
    expect(rows.map((r) => r[NAME_HEADER])).toEqual(['WANG/LIANBO', 'LI/SI', 'ZHAO/WU']);

    // 性别列存在且逐行正确
    expect(rows.map((r) => r[GENDER_HEADER])).toEqual(['M', 'F', 'M']);

    // 有无护照图：无 URL → 无护照图（手工录入）；有 URL → 有护照图
    expect(rows.map((r) => r['有无护照图'])).toEqual([
      '无护照图（手工录入）',
      '有护照图',
      '无护照图（手工录入）',
    ]);
  });

  // ── 自备签乘客（visaExempt=true）不进送签名单（P1-13）───────────────────────
  // 客人已自行办妥签证，无需送签；与签证台 fulfillment.service.ts 同口径。
  it('自备签乘客（visaExempt=true）不出现在合并名单里，且不错位到相邻乘客的行', async () => {
    const orders = [
      makeOrder('FTM2026071000010', [
        pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', passportPhotoUrl: 'https://x.test/w.jpg' }),
        // 自备签乘客：夹在中间，验证过滤后不把它后面乘客的护照图状态错位提前
        pax({ id: 'a2', lastName: 'ZI', firstName: 'BEI', visaExempt: true, passportPhotoUrl: null }),
        pax({ id: 'a3', lastName: 'LI', firstName: 'SI', passportPhotoUrl: null }),
      ]),
    ];

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    const buf = await buildVisaBundleXlsx(orders);
    const rows = await readVisaSheet(buf);

    // 自备签乘客（ZI/BEI）不上表；只剩 2 人
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[NAME_HEADER])).toEqual(['WANG/LIANBO', 'LI/SI']);
    // 护照图状态按过滤后位置对齐，不因中间被过滤的乘客而错位
    // （若按未过滤的 order.passengers 下标取，第 2 行会误把 ZI/BEI 的"无图"标给 LI/SI 之前，
    // 这里验证的是 LI/SI 自己的图状态——本人无图应仍是"无护照图（手工录入）"）
    expect(rows.map((r) => r['有无护照图'])).toEqual(['有护照图', '无护照图（手工录入）']);

    fetchSpy.mockRestore();
  });

  it('无订单时仍产出带表头的空表（含性别列）', async () => {
    const buf = await buildVisaBundleXlsx([]);
    const rows = await readVisaSheet(buf);
    expect(rows).toHaveLength(0);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('签证专用')!;
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, col) => (headers[col] = String(cell.value ?? '')));
    expect(headers).toContain(GENDER_HEADER);
    expect(headers).toContain('有无护照图');
  });
});

describe('buildVisaBundleXlsx — 签证岗样表排版（列头/边框/斑马纹/对齐/签证备注）', () => {
  it('首列表头按样表用「序号」（不再是 STT）', async () => {
    const ws = await loadVisaWorksheet(
      await buildVisaBundleXlsx([
        makeOrder('FTM2026072200001', [pax({ lastName: 'WANG', firstName: 'LIANBO' })]),
      ]),
    );
    expect(String(ws.getRow(1).getCell(1).value)).toBe('序号');
  });

  it('表头灰底填充；数据区单元格四边细实线边框；数据行隔行斑马纹', async () => {
    const ws = await loadVisaWorksheet(
      await buildVisaBundleXlsx([
        makeOrder('FTM2026072200001', [
          pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO' }),
          pax({ id: 'a2', lastName: 'LI', firstName: 'SI' }),
        ]),
      ]),
    );

    // 表头灰底
    expect(fillArgb(ws.getRow(1).getCell(1))).toBe('FFEFEFEF');

    // 数据首行（第 2 行）四边细实线边框
    const dataCell = ws.getRow(2).getCell(1);
    expect(dataCell.border?.top?.style).toBe('thin');
    expect(dataCell.border?.left?.style).toBe('thin');
    expect(dataCell.border?.bottom?.style).toBe('thin');
    expect(dataCell.border?.right?.style).toBe('thin');

    // 斑马纹：第 3 行浅色填充；第 2 行不是斑马色
    expect(fillArgb(ws.getRow(3).getCell(1))).toBe('FFF3F6F9');
    expect(fillArgb(ws.getRow(2).getCell(1))).not.toBe('FFF3F6F9');
  });

  it('金额列右对齐、姓名/护照号列左对齐（对齐样表口径）', async () => {
    const ws = await loadVisaWorksheet(
      await buildVisaBundleXlsx([
        makeOrder('FTM2026072200001', [pax({ lastName: 'WANG', firstName: 'LIANBO' })]),
      ]),
    );
    const headerToCol = new Map<string, number>();
    ws.getRow(1).eachCell((cell, col) => headerToCol.set(String(cell.value ?? ''), col));
    const colOf = (h: string): number => headerToCol.get(h)!;
    const dataRow = ws.getRow(2);
    expect(dataRow.getCell(colOf('结算价格')).alignment?.horizontal).toBe('right');
    expect(dataRow.getCell(colOf('到账金额')).alignment?.horizontal).toBe('right');
    expect(dataRow.getCell(colOf(NAME_HEADER)).alignment?.horizontal).toBe('left');
    expect(dataRow.getCell(colOf(PASSPORT_HEADER)).alignment?.horizontal).toBe('left');
    // 其余列居中
    expect(dataRow.getCell(colOf('代理机构')).alignment?.horizontal).toBe('center');
  });

  it('「签证备注」列取该单签证履约任务(VISA_APPLICATION)的备注文本，无则留空', async () => {
    const withNote = makeOrder('FTM2026072200002', [pax({ lastName: 'WANG', firstName: 'LIANBO' })], {
      items: [
        {
          kind: 'VISA',
          amount: '800',
          description: '越南电子签',
          flightCabin: null,
          flightSchedule: null,
          hotelRoomType: null,
          visa: { code: 'V1', visaName: '越南电子签', visaType: 'TOURIST', supplier: '某签证行' },
          transfer: null,
          bundle: null,
          fulfillmentTasks: [
            { type: 'VISA_APPLICATION', status: 'IN_PROGRESS', notes: '材料待补护照复印件' },
          ],
        },
      ],
    });
    // 无签证任务备注的单（默认 FLIGHT 项，fulfillmentTasks 空）→ 签证备注留空
    const withoutNote = makeOrder('FTM2026072200003', [pax({ lastName: 'LI', firstName: 'SI' })]);

    const rows = await readVisaSheet(await buildVisaBundleXlsx([withNote, withoutNote]));
    const byName = new Map(rows.map((r) => [r[NAME_HEADER], r['签证备注']]));
    expect(byName.get('WANG/LIANBO')).toBe('材料待补护照复印件');
    expect(byName.get('LI/SI')).toBe('');
  });
});

describe('queryOrdersByIdsForVisa — 按 id 选单', () => {
  it('按订单 id 列表取单，软删排除；状态过滤不在这里做', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { order: { findMany } } as unknown as Parameters<
      typeof queryOrdersByIdsForVisa
    >[1];

    await queryOrdersByIdsForVisa(['id_a', 'id_b'], client);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.id.in).toEqual(['id_a', 'id_b']);
    expect(arg.where.deletedAt).toBeNull();
    // 状态过滤放到 partitionOrdersForVisa（名单/护照包共用），这里不加 status 条件（否则不合格单查不回来）
    expect(arg.where.status).toBeUndefined();
  });

  it('空 id 列表 → 短路，不查库', async () => {
    const findMany = vi.fn();
    const client = { order: { findMany } } as unknown as Parameters<
      typeof queryOrdersByIdsForVisa
    >[1];
    const res = await queryOrdersByIdsForVisa([], client);
    expect(res).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('sortOrdersForVisa — 代理→订单号分组，直客排最后', () => {
  it('按代理机构名、再订单号排序；无代理归为一组排最后', () => {
    const o = (num: string, company: string | null): OrderForTemplateExport =>
      ({ orderNumber: num, agent: company ? { companyName: company } : null }) as OrderForTemplateExport;
    const sorted = sortOrdersForVisa([
      o('B2', '乙代理'),
      o('D1', null), // 直客
      o('A1', '甲代理'),
      o('B1', '乙代理'),
      o('C1', '甲代理'),
    ]);
    // 甲代理(A1,C1) → 乙代理(B1,B2) → 直客(D1)
    expect(sorted.map((s) => s.orderNumber)).toEqual(['A1', 'C1', 'B1', 'B2', 'D1']);
  });
});

describe('buildVisaRosterXlsx — 仅名单 xlsx（不含护照图）', () => {
  it('按勾选订单 id 取单、状态过滤、排序后合并成一张名单', async () => {
    const orders = [
      makeOrder('B1', [pax({ id: 'b1', lastName: 'BB', firstName: 'ONE' })], {
        agent: { companyName: '乙代理' },
      }),
      makeOrder('A1', [pax({ id: 'a1', lastName: 'AA', firstName: 'ONE' })], {
        agent: { companyName: '甲代理' },
      }),
    ];
    const findMany = vi.fn().mockResolvedValue(orders);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaRosterXlsx>[1];

    const xlsxBuf = await buildVisaRosterXlsx(['id_B1', 'id_A1'], client);
    const rows = await readVisaSheet(xlsxBuf);

    // 甲代理(A1) 在前、乙代理(B1) 在后；序号连续 1,2
    expect(rows.map((r) => r['序号'])).toEqual(['1', '2']);
    expect(rows.map((r) => r['代理机构'])).toEqual(['甲代理', '乙代理']);
    // 纯拼音名不带性别称谓（签证岗反馈：英文名不需要带性别）
    expect(rows.map((r) => r[NAME_HEADER])).toEqual(['AA/ONE', 'BB/ONE']);
  });

  it('被勾选但状态不合格 / 查不到的单静默不计入名单（无 README，纯 xlsx）', async () => {
    const paid = makeOrder('FTM2026071000001', [
      pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', passportPhotoUrl: null }),
    ]);
    const cancelled = makeOrder(
      'FTM2026071000009',
      [pax({ id: 'z1', lastName: 'ZHAO', firstName: 'WU', passportPhotoUrl: null })],
      { status: 'CANCELLED' },
    );
    const findMany = vi.fn().mockResolvedValue([paid, cancelled]);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaRosterXlsx>[1];

    const xlsxBuf = await buildVisaRosterXlsx(
      ['id_FTM2026071000001', 'id_FTM2026071000009', 'id_missing'],
      client,
    );
    const rows = await readVisaSheet(xlsxBuf);

    // 名单只含合格单（1 人）；状态不合格 / 查不到的单静默不出现
    expect(rows).toHaveLength(1);
    expect(rows[0][NAME_HEADER]).toBe('WANG/LIANBO');
  });
});

describe('buildVisaPassportsZip — 仅护照图 zip（不含 xlsx 名单）', () => {
  it('zip 不含 xlsx；护照图文件名带订单号+姓名前缀；无图乘客缺文件', async () => {
    const orders = [
      makeOrder('FTM2026071000001', [
        // data URI 本地解码、不出网——护照图抓取已收口到 safe-fetch（真实 DNS 解析），
        // mock 全局 fetch 拦不住，测试一律用 data URI。
        pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', passportPhotoUrl: 'data:image/jpeg;base64,AQIDBA==' }),
        pax({ id: 'a2', lastName: 'LI', firstName: 'SI', passportPhotoUrl: null }),
      ]),
    ];
    const findMany = vi.fn().mockResolvedValue(orders);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaPassportsZip>[1];

    const zipBuf = await buildVisaPassportsZip(['id_FTM2026071000001'], client);
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files);

    // 不再打包 xlsx 名单
    expect(names).not.toContain('签证专用_合并名单.xlsx');
    expect(names.some((n) => n.endsWith('.xlsx'))).toBe(false);

    // 有图乘客：文件名 = 订单号-LASTNAME_FIRSTNAME.jpg
    expect(names).toContain('FTM2026071000001-WANG_LIANBO.jpg');

    // 无图乘客：无对应护照文件
    expect(names.some((n) => n.includes('LI_SI'))).toBe(false);

    // README 存在且记录缺图明细
    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('护照图成功：1');
    expect(readme).toContain('护照图缺失/失败：1');
  });

  it('被勾选但状态不合格的单跳过、不打包护照图，并在 README 点名（连同查不到的 id）', async () => {
    const paid = makeOrder('FTM2026071000001', [
      pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', passportPhotoUrl: null }),
    ]);
    const cancelled = makeOrder(
      'FTM2026071000009',
      [pax({ id: 'z1', lastName: 'ZHAO', firstName: 'WU', passportPhotoUrl: null })],
      { status: 'CANCELLED' },
    );
    const findMany = vi.fn().mockResolvedValue([paid, cancelled]);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaPassportsZip>[1];

    const zipBuf = await buildVisaPassportsZip(
      ['id_FTM2026071000001', 'id_FTM2026071000009', 'id_missing'],
      client,
    );
    const zip = await JSZip.loadAsync(zipBuf);

    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('勾选订单数：3');
    expect(readme).toContain('已打包订单数：1');
    expect(readme).toContain('FTM2026071000009（CANCELLED）');
    expect(readme).toContain('id_missing');
  });
});

describe('visaRosterXlsxFilename', () => {
  it('文件名带订单数与 YYYY-MM-DD 日期', () => {
    expect(visaRosterXlsxFilename(3)).toMatch(/^签证名单_3单_\d{4}-\d{2}-\d{2}\.xlsx$/u);
  });
});

describe('visaPassportsZipFilename', () => {
  it('文件名带订单数与 YYYY-MM-DD 日期', () => {
    expect(visaPassportsZipFilename(3)).toMatch(/^签证护照_3单_\d{4}-\d{2}-\d{2}\.zip$/u);
  });
});
