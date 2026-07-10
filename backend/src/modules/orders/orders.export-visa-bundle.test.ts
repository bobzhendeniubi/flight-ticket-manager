/**
 * 签证资料合并打包 · 单元测试（vitest）
 *
 * 覆盖签证岗反馈：「勾选若干订单，把这些订单的签证名单导出在同一张表格上，护照也一起下载」。
 *   - 选单口径：queryOrdersByIdsForVisa 按勾选订单 id 取单（软删排除，空列表短路不查库）
 *   - 状态过滤在 buildVisaBundleZip：被勾选但状态不合格的单跳过并在 README 点名
 *   - 排序：sortOrdersForVisa 按「代理机构名 → 订单号」分组，直客（无代理）排最后
 *   - xlsx 含性别列，且每位乘客一行合并（跨订单）
 *   - 护照图文件名规则：{订单号}-{LASTNAME}_{FIRSTNAME}.{ext}，无图乘客缺文件但仍有行
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

// 模块链路（orders.export-templates → orders.service / passport-zip）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  buildVisaBundleXlsx,
  buildVisaBundleZip,
  queryOrdersByIdsForVisa,
  sortOrdersForVisa,
  visaBundleZipFilename,
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

    // 3 位乘客合并成 3 行，STT 连续
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['STT'])).toEqual(['1', '2', '3']);

    // 姓名（LAST/FIRST）合并正确
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
    // 状态过滤放到 buildVisaBundleZip，这里不加 status 条件（否则不合格单查不回来、无法在 README 点名）
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

describe('buildVisaBundleZip — 打包结构 + 护照文件名规则', () => {
  it('zip 含合并 xlsx；护照图文件名带订单号+姓名前缀；无图乘客缺文件但仍在名单', async () => {
    const orders = [
      makeOrder('FTM2026071000001', [
        pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', passportPhotoUrl: 'https://x.test/wang.jpg' }),
        pax({ id: 'a2', lastName: 'LI', firstName: 'SI', passportPhotoUrl: null }),
      ]),
    ];
    const findMany = vi.fn().mockResolvedValue(orders);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaBundleZip>[1];

    // 有图乘客触发 fetch —— 返回一小段图字节
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    const zipBuf = await buildVisaBundleZip({ orderIds: ['id_FTM2026071000001'] }, client);
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files);

    // 合并签证名单 xlsx 存在（命名不再依赖日期）
    expect(names).toContain('签证专用_合并名单.xlsx');

    // 有图乘客：文件名 = 订单号-LASTNAME_FIRSTNAME.jpg
    expect(names).toContain('FTM2026071000001-WANG_LIANBO.jpg');

    // 无图乘客：无对应护照文件
    expect(names.some((n) => n.includes('LI_SI'))).toBe(false);

    // 名单里两人都在（含无图那位）
    const xlsxEntry = zip.file('签证专用_合并名单.xlsx')!;
    const rows = await readVisaSheet(await xlsxEntry.async('nodebuffer'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['有无护照图'])).toEqual(['有护照图', '无护照图（手工录入）']);

    fetchSpy.mockRestore();
  });

  it('被勾选但状态不合格的单跳过、不进名单，并在 README 点名', async () => {
    const paid = makeOrder('FTM2026071000001', [
      pax({ id: 'a1', lastName: 'WANG', firstName: 'LIANBO', passportPhotoUrl: null }),
    ]);
    const cancelled = makeOrder(
      'FTM2026071000009',
      [pax({ id: 'z1', lastName: 'ZHAO', firstName: 'WU', passportPhotoUrl: null })],
      { status: 'CANCELLED' },
    );
    const findMany = vi.fn().mockResolvedValue([paid, cancelled]);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaBundleZip>[1];

    const zipBuf = await buildVisaBundleZip(
      { orderIds: ['id_FTM2026071000001', 'id_FTM2026071000009', 'id_missing'] },
      client,
    );
    const zip = await JSZip.loadAsync(zipBuf);

    // 名单只含合格单（1 人）
    const rows = await readVisaSheet(
      await zip.file('签证专用_合并名单.xlsx')!.async('nodebuffer'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0][NAME_HEADER]).toBe('WANG/LIANBO');

    // README 点名跳过的状态不合格单 + 查不到的 id
    const readme = await zip.file('README.txt')!.async('string');
    expect(readme).toContain('勾选订单数：3');
    expect(readme).toContain('已打包订单数：1');
    expect(readme).toContain('FTM2026071000009（CANCELLED）');
    expect(readme).toContain('id_missing');
  });

  it('合并名单按「代理→订单号」分组排序，STT 跨订单连续', async () => {
    const orders = [
      makeOrder('B1', [pax({ id: 'b1', lastName: 'BB', firstName: 'ONE' })], {
        agent: { companyName: '乙代理' },
      }),
      makeOrder('A1', [pax({ id: 'a1', lastName: 'AA', firstName: 'ONE' })], {
        agent: { companyName: '甲代理' },
      }),
    ];
    const findMany = vi.fn().mockResolvedValue(orders);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaBundleZip>[1];

    const zipBuf = await buildVisaBundleZip({ orderIds: ['id_B1', 'id_A1'] }, client);
    const zip = await JSZip.loadAsync(zipBuf);
    const rows = await readVisaSheet(
      await zip.file('签证专用_合并名单.xlsx')!.async('nodebuffer'),
    );
    // 甲代理(A1) 在前、乙代理(B1) 在后；STT 连续 1,2
    expect(rows.map((r) => r['STT'])).toEqual(['1', '2']);
    expect(rows.map((r) => r['代理机构'])).toEqual(['甲代理', '乙代理']);
    expect(rows.map((r) => r[NAME_HEADER])).toEqual(['AA/ONE', 'BB/ONE']);
  });
});

describe('visaBundleZipFilename', () => {
  it('文件名带订单数（不再依赖出发日）', () => {
    expect(visaBundleZipFilename(3)).toMatch(/^签证资料_3单_\d{8}导出\.zip$/u);
  });
});
