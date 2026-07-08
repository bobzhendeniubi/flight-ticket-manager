/**
 * 签证资料整日打包 · 单元测试（vitest）
 *
 * 覆盖 0708 签证岗反馈：「同一天出发的所有订单，签证名单导出在同一张表格上，护照也一起下载」。
 *   - 合并选单口径：queryOrdersByDepartDateForVisa 按出发日选订单（FLIGHT 班次 UTC 日 / 无航班回退入住日）
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
  queryOrdersByDepartDateForVisa,
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

/** 造一张订单（一段机票 + 若干乘客）。*/
function makeOrder(
  orderNumber: string,
  passengers: OrderForTemplateExport['passengers'],
): OrderForTemplateExport {
  return {
    id: `id_${orderNumber}`,
    orderNumber,
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

describe('queryOrdersByDepartDateForVisa — 合并选单口径', () => {
  it('按出发日 UTC 半开区间选订单（FLIGHT 班次日 / 无航班回退入住日），排除未计数状态', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { order: { findMany } } as unknown as Parameters<
      typeof queryOrdersByDepartDateForVisa
    >[1];

    await queryOrdersByDepartDateForVisa('2026-07-10', client);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    // 状态过滤：不计入草稿/取消/退款等
    expect(arg.where.status.in).toContain('PAID');
    expect(arg.where.status.in).not.toContain('CANCELLED');

    // 出发日 OR：航班班次落在 [dayStart, 次日)
    const flightBranch = arg.where.OR[0].items.some;
    expect(flightBranch.kind).toBe('FLIGHT');
    expect(flightBranch.flightSchedule.departureTime.gte).toEqual(D('2026-07-10'));
    expect(flightBranch.flightSchedule.departureTime.lt).toEqual(D('2026-07-11'));

    // 回退分支：无挂班次航班 + 占房 item 入住日 == 出发日
    const fallback = arg.where.OR[1].AND;
    expect(fallback[0].items.none.kind).toBe('FLIGHT');
    expect(fallback[1].items.some.hotelCheckIn).toEqual(D('2026-07-10'));
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

    const zipBuf = await buildVisaBundleZip({ departDate: '2026-07-10' }, client);
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files);

    // 合并签证名单 xlsx 存在
    expect(names).toContain('签证专用_出发2026-07-10.xlsx');

    // 有图乘客：文件名 = 订单号-LASTNAME_FIRSTNAME.jpg
    expect(names).toContain('FTM2026071000001-WANG_LIANBO.jpg');

    // 无图乘客：无对应护照文件
    expect(names.some((n) => n.includes('LI_SI'))).toBe(false);

    // 名单里两人都在（含无图那位）
    const xlsxEntry = zip.file('签证专用_出发2026-07-10.xlsx')!;
    const rows = await readVisaSheet(await xlsxEntry.async('nodebuffer'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['有无护照图'])).toEqual(['有护照图', '无护照图（手工录入）']);

    fetchSpy.mockRestore();
  });
});

describe('visaBundleZipFilename', () => {
  it('文件名带出发日', () => {
    expect(visaBundleZipFilename('2026-07-10')).toBe('签证资料_出发2026-07-10.zip');
  });
});
