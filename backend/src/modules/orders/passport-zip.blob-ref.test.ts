/**
 * 护照包 / 按酒店导护照 / 签证包 · 三种落库形态混合（存量 data URL + blob 引用 + 缺失 blob）· 单元测试
 *
 * 出库后一张单里可能同时有：还没回填的内联 data URL、已出库的 blob 引用、以及引用指向的 blob
 * 丢了（卷没同步）的情况。三个打包入口共用 passport-zip.fetchPhoto / extFromUrl，这里逐个入口断言：
 *   - data URL 与 blob 引用都能出图，扩展名按各自 mime
 *   - blob 缺失记「下载失败」（不是「没传」），不 500
 *   - 无图乘客照旧记「没传护照照片」
 *
 * BLOB_DIR 在 import 前指到临时目录（config/env 在 import 时读 process.env），不会碰 backend/var/blobs。
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import type { Passenger } from '@prisma/client';

const { tmpDir } = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftm-zip-blob-'));
  process.env.BLOB_DIR = dir;
  return { tmpDir: dir };
});

// 送签表订单级取数（出发日/备注）顶层引用 prisma —— mock 成空，不连库
vi.mock('../../db/prisma.js', () => ({
  prisma: {
    orderItem: { findFirst: vi.fn().mockResolvedValue(null) },
    order: { findUnique: vi.fn().mockResolvedValue(null) },
    fulfillmentTask: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { createLocalBlobStore, sha256Hex } from '../../lib/blob-store.js';
import { makeBlobRef, toImageDataUrl } from '../../lib/image-ref.js';
import { buildPassportPhotoZip, extFromUrl, fetchPhoto } from './passport-zip.js';
import { buildVisaPassportsZip } from './orders.export-visa-bundle.js';
import {
  buildHotelPassportsZip,
  type HotelPassportSelection,
} from '../hotel-control/hotel-control.passports.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const PNG_DATA_URL = toImageDataUrl(PNG_1PX, 'image/png');
const JPEG_REF = makeBlobRef(sha256Hex(JPEG_FAKE), 'image/jpeg');
const MISSING_REF = makeBlobRef('c'.repeat(64), 'image/png');

// 只把 JPEG 放进 blob 存储；MISSING_REF 指向的 blob 故意不存在
const store = createLocalBlobStore(tmpDir);
await store.put(JPEG_FAKE);
vi.spyOn(console, 'warn').mockImplementation(() => undefined);

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
    upgradeRedeemLeg: 'NONE',
    upgradeRedeemNote: null,
    visaExempt: false,
    singleRoom: false,
    visaSubmissionStatus: 'PENDING',
    passportPhotoUrl: null,
    pnr: null,
    eticketNumber: null,
    formerIdentities: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Passenger;
}

const MIXED = [
  makePassenger({ id: 'a', lastName: 'INLINE', firstName: 'PNG', documentNumber: 'E1', passportPhotoUrl: PNG_DATA_URL }),
  makePassenger({ id: 'b', lastName: 'BLOB', firstName: 'JPG', documentNumber: 'E2', passportPhotoUrl: JPEG_REF }),
  makePassenger({ id: 'c', lastName: 'LOST', firstName: 'BLOB', documentNumber: 'E3', passportPhotoUrl: MISSING_REF }),
  makePassenger({ id: 'd', lastName: 'NO', firstName: 'PHOTO', documentNumber: 'E4', passportPhotoUrl: null }),
];

async function names(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files).filter((n) => !zip.files[n].dir);
}

async function readme(buf: Buffer, entryPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return zip.file(entryPath)!.async('string');
}

describe('fetchPhoto / extFromUrl · blob 引用', () => {
  it('fetchPhoto 读引用得字节；缺失 blob → null；extFromUrl 按引用 mime 给后缀', async () => {
    expect(await fetchPhoto(JPEG_REF)).toEqual(JPEG_FAKE);
    expect(await fetchPhoto(PNG_DATA_URL)).toEqual(PNG_1PX);
    expect(await fetchPhoto(MISSING_REF)).toBeNull();
    expect(extFromUrl(JPEG_REF)).toBe('jpg');
    expect(extFromUrl(MISSING_REF)).toBe('png');
    expect(extFromUrl(makeBlobRef('d'.repeat(64), 'image/webp'))).toBe('webp');
    expect(extFromUrl(PNG_DATA_URL)).toBe('png');
  });
});

describe('buildPassportPhotoZip（订单详情 / 签证台护照包）· 混合形态', () => {
  it('内联与引用都出图（后缀各按 mime），缺失 blob 记下载失败，无图记没传', async () => {
    const buf = await buildPassportPhotoZip({ orderNumber: 'FTM2026092500001', passengers: MIXED });
    const files = await names(buf);
    expect(files).toContain('FTM2026092500001/INLINE_PNG_E1.png');
    expect(files).toContain('FTM2026092500001/BLOB_JPG_E2.jpg');
    expect(files.some((n) => n.includes('LOST_BLOB'))).toBe(false);
    expect(files.some((n) => n.includes('NO_PHOTO'))).toBe(false);

    const zip = await JSZip.loadAsync(buf);
    expect(await zip.file('FTM2026092500001/BLOB_JPG_E2.jpg')!.async('nodebuffer')).toEqual(JPEG_FAKE);
    expect(await zip.file('FTM2026092500001/INLINE_PNG_E1.png')!.async('nodebuffer')).toEqual(PNG_1PX);

    const text = await readme(buf, 'FTM2026092500001/README.txt');
    expect(text).toContain('成功打包：2');
    expect(text).toContain('缺失/失败：2');
    expect(text).toContain('LOST_BLOB_E3  — 下载失败');
    expect(text).toContain('NO_PHOTO_E4  — 该乘客没传护照照片');
    // 送签表照旧附带
    expect(zip.file('FTM2026092500001/送签表.xlsx')).not.toBeNull();
  });
});

describe('buildHotelPassportsZip（按酒店导护照）· 混合形态', () => {
  it('每单文件夹里内联与引用都出图，缺失 blob 与无图分别点名', async () => {
    const selection: HotelPassportSelection = {
      hotelName: '测试酒店',
      groups: [
        {
          orderNumber: 'FTM2026092500002',
          passengers: MIXED.map((p) => ({
            id: p.id,
            fullName: p.fullName,
            lastName: p.lastName,
            firstName: p.firstName,
            documentNumber: p.documentNumber,
            passportPhotoUrl: p.passportPhotoUrl,
          })),
        },
      ],
    };
    const { buf, photoCount } = await buildHotelPassportsZip(selection, {
      hotelId: 'h1',
      from: '2026-09-25',
      to: '2026-09-30',
    });
    expect(photoCount).toBe(2);
    const files = await names(buf);
    expect(files).toContain('FTM2026092500002/INLINE_E1.png');
    expect(files).toContain('FTM2026092500002/BLOB_E2.jpg');
    const text = await readme(buf, 'README.txt');
    expect(text).toContain('成功打包护照图：2');
    expect(text).toContain('缺失/失败：2');
    expect(text).toContain('LOST_E3  — 护照图下载失败');
    expect(text).toContain('NO_E4  — 该乘客没传护照照片');
  });
});

describe('buildVisaPassportsZip（签证包）· 混合形态', () => {
  it('内联与引用都出图，缺失 blob 记下载失败', async () => {
    const order = {
      id: 'id_FTM2026092500003',
      orderNumber: 'FTM2026092500003',
      status: 'PAID',
      agent: null,
      items: [],
      passengers: MIXED,
    };
    const findMany = vi.fn().mockResolvedValue([order]);
    const client = { order: { findMany } } as unknown as Parameters<typeof buildVisaPassportsZip>[1];

    const buf = await buildVisaPassportsZip(['id_FTM2026092500003'], client);
    const files = await names(buf);
    expect(files).toContain('FTM2026092500003-INLINE_PNG.png');
    expect(files).toContain('FTM2026092500003-BLOB_JPG.jpg');
    expect(files.some((n) => n.includes('LOST_BLOB'))).toBe(false);
    const text = await readme(buf, 'README.txt');
    expect(text).toContain('护照图成功：2');
    expect(text).toContain('护照图缺失/失败：2');
    expect(text).toContain('下载失败');
  });
});
