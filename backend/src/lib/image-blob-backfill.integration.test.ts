/**
 * 存量图片回填内核 · 真 DB 集成测试（BLOB_DIR 由 tests/integration/setup.ts 指到临时目录）。
 *
 * 存量行用 rawPrisma 写入（不带出库钩子，模拟上线前库里的内联 data URL），然后：
 *   - dry-run：统计对（可转 / 去重 / 转不了），库与磁盘都不动
 *   - apply：三张表都转成引用，blob 落盘，转不了 / 外链 / 空值原样；updatedAt 不动
 *   - 幂等：再跑一次没有可转的行
 *   - CAS 冲突：更新前有人改了这行 → 跳过不覆盖，下次再转
 *   - limit：只处理前 N 行
 *   - reverse：引用转回内联（与原始字节一致），blob 文件不删除；blob 缺失的行跳过
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/lib/image-blob-backfill.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { OrderStatus, PaymentMethod, Prisma, ReceiptSource } from '@prisma/client';
import { blobDir } from '../config/env.js';
import { rawPrisma } from '../db/prisma.js';
import { sha256Hex } from './blob-store.js';
import { makeBlobRef, toImageDataUrl } from './image-ref.js';
import { backfillImageBlobs, formatBackfillSummary } from './image-blob-backfill.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const NOT_IMAGE = 'data:image/png;base64,SGVsbG8=';
const EXTERNAL = 'https://example.com/passport.jpg';

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 每次造存量都用**本次独有**的字节：BLOB_DIR 在整个集成测试进程里共用（内容寻址、永不删除），
 * 同一张固定小图跑到第二个用例时已经在磁盘上了，「新 blob / 去重」的计数就会随运行顺序漂移。
 * 魔数不变（PNG 签名 / FF D8 FF）+ 尾巴拼随机字节 = 嗅探照样通过、sha 每次不同。
 */
function freshImages() {
  const salt = Buffer.from(uniq('salt'));
  const png = Buffer.concat([PNG_1PX, salt]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('backfill-jpeg-'), salt]);
  return {
    png,
    jpeg,
    pngUrl: toImageDataUrl(png, 'image/png'),
    // 申报 jpg（非标准）+ base64 里夹换行：回填后引用按嗅探 mime，反向还原成规范 data URL
    jpegUrlMessy: `data:image/jpg;base64,${jpeg.toString('base64').replace(/(.{8})/g, '$1\n')}`,
    jpegUrlCanonical: toImageDataUrl(jpeg, 'image/jpeg'),
    pngRef: makeBlobRef(sha256Hex(png), 'image/png'),
    jpegRef: makeBlobRef(sha256Hex(jpeg), 'image/jpeg'),
  };
}

async function blobFileExists(sha256: string): Promise<boolean> {
  try {
    return (await stat(path.join(blobDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256))).isFile();
  } catch {
    return false;
  }
}

async function countBlobFiles(dir: string = blobDir): Promise<number> {
  let n = 0;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += await countBlobFiles(path.join(dir, e.name));
    else if (e.isFile() && !e.name.endsWith('.tmp') && !e.name.startsWith('.probe.')) n += 1;
  }
  return n;
}

/** 用 rawPrisma（无钩子）造存量：值原样进库。 */
async function seedLegacyRows() {
  const img = freshImages();
  const { pngUrl: PNG_URL, jpegUrlMessy: JPEG_URL_MESSY } = img;
  const order = await rawPrisma.order.create({
    data: {
      orderNumber: uniq('TEST-BF'),
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(1),
      total: new Prisma.Decimal(1),
      contactName: 'A',
      contactPhone: '1',
      passengers: {
        create: [
          { fullName: 'P1', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: PNG_URL },
          { fullName: 'P2', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: PNG_URL }, // 同图 → 去重
          { fullName: 'P3', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: JPEG_URL_MESSY },
          { fullName: 'P4', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: NOT_IMAGE },
          { fullName: 'P5', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: EXTERNAL },
          { fullName: 'P6', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: null },
        ],
      },
      payments: {
        create: [{ method: PaymentMethod.BANK_CARD, amount: new Prisma.Decimal(1), proofUrl: PNG_URL }],
      },
    },
    include: { passengers: { orderBy: { fullName: 'asc' } }, payments: true },
  });
  const receipt = await rawPrisma.receipt.create({
    data: {
      receiptNo: uniq('RCP'),
      amountCny: new Prisma.Decimal(1),
      method: PaymentMethod.WECHAT_PAY,
      receivedAt: new Date(),
      source: ReceiptSource.STAFF_ENTRY,
      proofUrl: JPEG_URL_MESSY,
    },
  });
  return { order, receipt, img };
}

const silent = () => undefined;

describe('backfillImageBlobs · 真 DB', () => {
  it('dry-run：统计可转 / 去重 / 转不了，库与磁盘都不动', async () => {
    const { order, receipt, img } = await seedLegacyRows();
    const filesBefore = await countBlobFiles();

    const result = await backfillImageBlobs({ log: silent });
    expect(result.mode).toBe('dry-run');
    const pax = result.tables.find((t) => t.table === 'Passenger')!;
    expect(pax.scanned).toBe(4); // P1 P2 P3 P4（外链 / 空值不匹配 data: 前缀）
    expect(pax.converted).toBe(3);
    expect(pax.skippedUnconvertible).toBe(1);
    expect(pax.blobsCreated).toBe(2); // PNG + JPEG 各一张新图
    expect(pax.blobsDeduped).toBe(1); // P2 与 P1 同图
    expect(pax.bytes).toBe(img.png.byteLength * 2 + img.jpeg.byteLength);
    expect(pax.remaining).toBe(4);
    const pay = result.tables.find((t) => t.table === 'Payment')!;
    expect(pay.converted).toBe(1);
    expect(pay.blobsDeduped).toBe(1); // 与乘客同一张 PNG：去重计数跨表（本轮已见 sha），dry-run 与 apply 同口径
    const rcp = result.tables.find((t) => t.table === 'Receipt')!;
    expect(rcp.converted).toBe(1);
    expect(rcp.blobsDeduped).toBe(1);
    expect(result.vacuumHint).toBeNull();

    // 库没动、磁盘没动
    const raw = await rawPrisma.passenger.findMany({ where: { orderId: order.id }, orderBy: { fullName: 'asc' } });
    expect(raw.map((p) => p.passportPhotoUrl)).toEqual([img.pngUrl, img.pngUrl, img.jpegUrlMessy, NOT_IMAGE, EXTERNAL, null]);
    expect((await rawPrisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).proofUrl).toBe(img.jpegUrlMessy);
    expect(await countBlobFiles()).toBe(filesBefore);
    expect(await blobFileExists(sha256Hex(img.png))).toBe(false);
    expect(formatBackfillSummary(result)).toContain('dry-run');
  });

  it('apply：三张表转成引用、blob 落盘、转不了 / 外链 / 空值原样、updatedAt 不动；再跑幂等', async () => {
    const { order, receipt, img } = await seedLegacyRows();
    const before = await rawPrisma.passenger.findMany({ where: { orderId: order.id }, orderBy: { fullName: 'asc' } });
    const filesBefore = await countBlobFiles();

    const result = await backfillImageBlobs({ apply: true, batchSize: 2, log: silent });
    expect(result.mode).toBe('apply');
    const pax = result.tables.find((t) => t.table === 'Passenger')!;
    expect(pax.converted).toBe(3);
    expect(pax.blobsCreated).toBe(2);
    expect(pax.blobsDeduped).toBe(1);
    expect(pax.skippedUnconvertible).toBe(1);
    expect(pax.skippedConflict).toBe(0);
    expect(pax.remaining).toBe(1); // 只剩转不了的 P4
    expect(result.vacuumHint).toContain('VACUUM FULL');
    expect(result.vacuumHint).toContain('"Passenger"');
    // 收款 / 进账用的是同两张图 → 全部去重，磁盘上只多了 2 个文件
    expect(result.tables.find((t) => t.table === 'Payment')!.blobsDeduped).toBe(1);
    expect(result.tables.find((t) => t.table === 'Receipt')!.blobsDeduped).toBe(1);
    expect(await countBlobFiles()).toBe(filesBefore + 2);

    const after = await rawPrisma.passenger.findMany({ where: { orderId: order.id }, orderBy: { fullName: 'asc' } });
    expect(after.map((p) => p.passportPhotoUrl)).toEqual([img.pngRef, img.pngRef, img.jpegRef, NOT_IMAGE, EXTERNAL, null]);
    expect(after.map((p) => p.updatedAt.getTime())).toEqual(before.map((p) => p.updatedAt.getTime()));
    expect((await rawPrisma.payment.findUniqueOrThrow({ where: { id: order.payments[0].id } })).proofUrl).toBe(img.pngRef);
    expect((await rawPrisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).proofUrl).toBe(img.jpegRef);
    expect(await blobFileExists(sha256Hex(img.png))).toBe(true);
    expect(await blobFileExists(sha256Hex(img.jpeg))).toBe(true);

    // 幂等：第二次 apply 只会再扫到转不了的那行，什么都不改
    const again = await backfillImageBlobs({ apply: true, log: silent });
    const paxAgain = again.tables.find((t) => t.table === 'Passenger')!;
    expect(paxAgain.scanned).toBe(1);
    expect(paxAgain.converted).toBe(0);
    expect(paxAgain.skippedUnconvertible).toBe(1);
    expect(again.tables.find((t) => t.table === 'Payment')!.scanned).toBe(0);
    expect(again.vacuumHint).toBeNull();
  });

  it('CAS 冲突：更新前有人改了这行 → 跳过不覆盖，下次运行再转', async () => {
    const { order, img } = await seedLegacyRows();
    const target = (await rawPrisma.passenger.findFirst({ where: { orderId: order.id, fullName: 'P1' } }))!;
    const replacement = toImageDataUrl(Buffer.concat([img.jpeg, Buffer.from('-v2')]), 'image/jpeg');

    let bumped = false;
    const result = await backfillImageBlobs({
      apply: true,
      tables: ['Passenger'],
      log: silent,
      beforeUpdate: async (row) => {
        if (row.id === target.id && !bumped) {
          bumped = true;
          await rawPrisma.passenger.update({ where: { id: target.id }, data: { passportPhotoUrl: replacement } });
        }
      },
    });
    const pax = result.tables[0];
    expect(pax.skippedConflict).toBe(1);
    expect(pax.converted).toBe(2); // P2 P3 照转
    const kept = await rawPrisma.passenger.findUniqueOrThrow({ where: { id: target.id } });
    expect(kept.passportPhotoUrl).toBe(replacement); // 并发写入的新值没被覆盖
    expect(pax.remaining).toBe(2); // 冲突行 + 转不了的行

    const next = await backfillImageBlobs({ apply: true, tables: ['Passenger'], log: silent });
    expect(next.tables[0].converted).toBe(1);
    expect((await rawPrisma.passenger.findUniqueOrThrow({ where: { id: target.id } })).passportPhotoUrl).toMatch(/^blob:sha256:/);
  });

  it('limit：只处理前 N 行（断点续跑的基本单元）', async () => {
    await seedLegacyRows();
    const result = await backfillImageBlobs({ apply: true, limit: 2, batchSize: 50, log: silent });
    expect(result.processed).toBe(2);
    const pax = result.tables.find((t) => t.table === 'Passenger')!;
    expect(pax.scanned).toBe(2);
    expect(result.tables.find((t) => t.table === 'Payment')).toBeUndefined(); // 预算用完，后面的表没开始
  });

  it('reverse：引用转回内联（规范 data URL，字节一致），blob 文件保留；blob 缺失的行跳过', async () => {
    const { order, receipt, img } = await seedLegacyRows();
    await backfillImageBlobs({ apply: true, log: silent });
    // 再塞一行指向不存在 blob 的引用
    await rawPrisma.passenger.create({
      data: {
        orderId: order.id,
        fullName: 'P0',
        documentType: 'PASSPORT',
        documentNumber: uniq('D'),
        nationality: 'CHN',
        passportPhotoUrl: makeBlobRef('f'.repeat(64), 'image/jpeg'),
      },
    });
    const filesBefore = await countBlobFiles();

    const result = await backfillImageBlobs({ apply: true, reverse: true, log: silent });
    expect(result.direction).toBe('reverse');
    const pax = result.tables.find((t) => t.table === 'Passenger')!;
    expect(pax.converted).toBe(3);
    expect(pax.skippedUnconvertible).toBe(1); // 孤儿引用
    expect(pax.remaining).toBe(1);

    const after = await rawPrisma.passenger.findMany({ where: { orderId: order.id }, orderBy: { fullName: 'asc' } });
    expect(after.map((p) => p.passportPhotoUrl)).toEqual([
      makeBlobRef('f'.repeat(64), 'image/jpeg'), // P0 孤儿引用原样
      img.pngUrl,
      img.pngUrl,
      img.jpegUrlCanonical, // 原本夹换行、申报 jpg 的 → 规范化
      NOT_IMAGE,
      EXTERNAL,
      null,
    ]);
    expect((await rawPrisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).proofUrl).toBe(img.jpegUrlCanonical);
    expect(await countBlobFiles()).toBe(filesBefore); // 永不删除 blob
  });
});
