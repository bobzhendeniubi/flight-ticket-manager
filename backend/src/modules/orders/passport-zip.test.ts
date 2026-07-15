/**
 * 护照打包 zip · 单元测试（vitest）
 *
 * 重点覆盖签证岗 0708 反馈：「手动录入、没护照图」的乘客也必须能下载并拿到可用资料表。
 *   - 送签表.xlsx 始终附带，无图乘客也占一行
 *   - 无图乘客标记「无护照图（手工录入）」
 *   - 护照姓名走 LAST/FIRST 斜线；lastName/firstName 缺失时从 fullName 拆分，不留空白
 *
 * 只测无图路径 —— 不触发 fetch(照片)，故不 mock 网络；订单级取数（出发日/备注）mock prisma 为空。
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import type { Passenger } from '@prisma/client';

// 送签表订单级取数（出发日/备注）顶层引用 prisma —— mock 成空，不连库
vi.mock('../../db/prisma.js', () => ({
  prisma: {
    orderItem: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findUnique: vi.fn().mockResolvedValue(null) },
    fulfillmentTask: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { buildPassportPhotoZip, extFromUrl } from './passport-zip.js';

/** 造一个乘客 fixture，只填测试关心的字段，其余给合理默认 */
function makePassenger(overrides: Partial<Passenger>): Passenger {
  return {
    id: 'p_default',
    orderId: 'o1',
    fullName: 'ZHANG SAN',
    lastName: null,
    firstName: null,
    title: null,
    gender: null,
    documentType: 'PASSPORT',
    documentNumber: 'E12345678',
    dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
    placeOfBirth: null,
    nationality: 'CHN',
    passengerType: 'ADULT',
    chineseName: null,
    passportIssueDate: null,
    passportIssueCountry: null,
    passportIssuePlace: null,
    passportExpiry: null,
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
    createdAt: new Date('2026-07-08T00:00:00.000Z'),
    updatedAt: new Date('2026-07-08T00:00:00.000Z'),
    ...overrides,
  } as Passenger;
}

/** 从 zip Buffer 里解出 送签表.xlsx 的数据行（去表头），每行是 header→cell 值的 map */
async function readVisaSheetRows(
  zipBuf: Buffer,
  orderNumber: string,
): Promise<Array<Record<string, string>>> {
  const zip = await JSZip.loadAsync(zipBuf);
  const entry = zip.file(`${orderNumber}/送签表.xlsx`);
  expect(entry, '送签表.xlsx 应始终存在于 zip 中').not.toBeNull();
  const sheetBuf = await entry!.async('nodebuffer');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(sheetBuf);
  const ws = wb.getWorksheet('送签表');
  expect(ws, '工作表「送签表」应存在').toBeTruthy();

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

// ── extFromUrl · data URI 扩展名识别 ────────────────────────────────────────
// 曾经只匹配 URL 路径后缀，data:image/png;base64,... 这类内嵌图（OCR/小程序直传常见）
// 没有路径后缀可匹配，一律被误标成 .jpg（图内容与文件后缀不符）。
describe('extFromUrl', () => {
  it('data URI：按 MIME type 映射扩展名（png/webp/gif 各自识别，不再回落 jpg）', () => {
    expect(extFromUrl('data:image/png;base64,AAAA')).toBe('png');
    expect(extFromUrl('data:image/webp;base64,AAAA')).toBe('webp');
    expect(extFromUrl('data:image/gif;base64,AAAA')).toBe('gif');
  });

  it('data URI：jpeg → jpg（与非 data URI 口径一致，扩展名不用 jpeg）', () => {
    expect(extFromUrl('data:image/jpeg;base64,AAAA')).toBe('jpg');
  });

  it('data URI：未知/不支持的 MIME 兜底 jpg（不引入未知后缀）', () => {
    expect(extFromUrl('data:image/svg+xml;base64,AAAA')).toBe('jpg');
  });

  it('普通 URL：维持原口径，按路径末尾扩展名匹配', () => {
    expect(extFromUrl('https://cdn.example.com/passports/a.png')).toBe('png');
    expect(extFromUrl('https://cdn.example.com/passports/a.jpeg?x=1')).toBe('jpg');
    expect(extFromUrl('https://cdn.example.com/passports/a.webp')).toBe('webp');
  });

  it('普通 URL：无可识别后缀 → 兜底 jpg', () => {
    expect(extFromUrl('https://cdn.example.com/passports/no-ext')).toBe('jpg');
  });
});

describe('buildPassportPhotoZip — 送签表排除自备签乘客（P1-13）', () => {
  // 自备签乘客（visaExempt=true）已自行办妥签证，不需要送签——与签证台
  // fulfillment.service.ts 同口径。护照 zip 图片本身仍打包（业务上护照图可能仍有用途），
  // 只有"送签表"这张名单排除，避免签证岗把自备签客人也当送签对象核对/催材料。
  it('自备签乘客不出现在送签表，但其护照图仍打包进 zip', async () => {
    const orderNumber = 'FTM2026070800005';
    const passengers = [
      makePassenger({
        id: 'p1',
        fullName: 'ZHANG SAN',
        chineseName: '张三',
        visaExempt: true,
        // data URI 本地解码、不出网——护照图抓取已收口到 safe-fetch（真实 DNS 解析），
        // mock 全局 fetch 拦不住，测试一律用 data URI。
        passportPhotoUrl: 'data:image/jpeg;base64,AQIDBA==',
      }),
      makePassenger({ id: 'p2', fullName: 'LI SI', chineseName: '李四', visaExempt: false }),
    ];

    const zipBuf = await buildPassportPhotoZip({ orderNumber, passengers });

    // 送签表：只剩非自备签的「李四」
    const rows = await readVisaSheetRows(zipBuf, orderNumber);
    expect(rows).toHaveLength(1);
    expect(rows[0]['中文名']).toBe('李四');

    // 护照图 zip：自备签乘客「张三」的图仍打包（不受送签表过滤影响）
    const zip = await JSZip.loadAsync(zipBuf);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.includes('ZHANG'))).toBe(true);
  });
});

describe('buildPassportPhotoZip — 送签表覆盖手工录入/无图乘客', () => {
  it('无图乘客也出现在送签表，并标记「无护照图（手工录入）」', async () => {
    const orderNumber = 'FTM2026070800001';
    const passengers = [
      makePassenger({ id: 'p1', fullName: 'ZHANG SAN', chineseName: '张三' }),
    ];

    const zipBuf = await buildPassportPhotoZip({ orderNumber, passengers });
    const rows = await readVisaSheetRows(zipBuf, orderNumber);

    expect(rows).toHaveLength(1);
    expect(rows[0]['是否有护照图']).toBe('无护照图（手工录入）');
    expect(rows[0]['中文名']).toBe('张三');
    expect(rows[0]['证件号']).toBe('E12345678');
  });

  it('lastName/firstName 缺失时，护照姓名从 fullName 拆成 LAST/FIRST', async () => {
    const orderNumber = 'FTM2026070800002';
    const passengers = [
      makePassenger({ id: 'p1', lastName: null, firstName: null, fullName: 'ZHANG SAN' }),
    ];

    const zipBuf = await buildPassportPhotoZip({ orderNumber, passengers });
    const rows = await readVisaSheetRows(zipBuf, orderNumber);

    expect(rows[0]['护照姓名(LAST/FIRST)']).toBe('ZHANG/SAN');
  });

  it('已拆分 lastName/firstName 时，护照姓名用其大写斜线格式', async () => {
    const orderNumber = 'FTM2026070800003';
    const passengers = [
      makePassenger({ id: 'p1', lastName: 'li', firstName: 'ming', fullName: 'whatever' }),
    ];

    const zipBuf = await buildPassportPhotoZip({ orderNumber, passengers });
    const rows = await readVisaSheetRows(zipBuf, orderNumber);

    expect(rows[0]['护照姓名(LAST/FIRST)']).toBe('LI/MING');
  });

  it('多名乘客（有图/无图混合）每人一行，均出现在送签表', async () => {
    const orderNumber = 'FTM2026070800004';
    const passengers = [
      makePassenger({ id: 'p1', fullName: 'ZHANG SAN', passportPhotoUrl: null }),
      makePassenger({ id: 'p2', fullName: 'LI SI', passportPhotoUrl: 'https://example.test/x.jpg' }),
    ];

    // p2 有图会触发 fetch —— stub 成失败，走「下载失败」分支即可（不影响送签表行数）
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));

    const zipBuf = await buildPassportPhotoZip({ orderNumber, passengers });
    const rows = await readVisaSheetRows(zipBuf, orderNumber);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['护照姓名(LAST/FIRST)'])).toEqual(['ZHANG/SAN', 'LI/SI']);

    fetchSpy.mockRestore();
  });
});
