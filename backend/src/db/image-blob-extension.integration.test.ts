/**
 * 图片出库 Prisma 扩展 · 真 DB 集成测试（BLOB_DIR 由 tests/integration/setup.ts 指到临时目录）。
 *
 * 断言口径：
 *   - 库里（rawPrisma / raw SQL 看到的）是 blob:sha256 引用，blob 文件真的落在 BLOB_DIR 分片目录里
 *   - 业务客户端（prisma）读回来仍是 data URL —— 对前端契约不变
 *   - 写入口逐个过一遍：order.create 嵌套 passengers.create / 交互式事务 tx.passenger.update /
 *     批量事务 updateMany / payment.create / receipt.create；再走真实服务入口
 *     OrderService.createOrder、selfUpdatePassenger、PaymentsService.confirmManualPayment、
 *     ReceiptsService.customerUpload
 *   - hasPhoto 的 SQL 口径（列非空即有图）不变；转不了的 data URL 原样留库；blob 缺失读回引用而非 null
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/db/image-blob-extension.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CabinClass,
  OrderStatus,
  PaymentMethod,
  Prisma,
  ReceiptSource,
  ReceiptStatus,
  UserRole,
} from '@prisma/client';
import { blobDir } from '../config/env.js';
import { prisma, rawPrisma } from './prisma.js';
import { sha256Hex } from '../lib/blob-store.js';
import { BLOB_REF_PREFIX, makeBlobRef, parseBlobRef, toImageDataUrl } from '../lib/image-ref.js';
import { OrderService, type OrderRequester } from '../modules/orders/orders.service.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { ReceiptsService } from '../modules/receipts/receipts.service.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG_FAKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('integration-jpeg')]);
const PNG_URL = toImageDataUrl(PNG_1PX, 'image/png');
const JPEG_URL = toImageDataUrl(JPEG_FAKE, 'image/jpeg');
const PNG_REF = makeBlobRef(sha256Hex(PNG_1PX), 'image/png');
const JPEG_REF = makeBlobRef(sha256Hex(JPEG_FAKE), 'image/jpeg');

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function blobFileExists(sha256: string): Promise<boolean> {
  try {
    const info = await stat(path.join(blobDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256));
    return info.isFile();
  } catch {
    return false;
  }
}

async function createUser(role: UserRole) {
  return prisma.user.create({ data: { email: `${uniq('u')}@test.com`, role } });
}

async function createPendingOrder(userId: string | null, total = 1000) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-BLOB'),
      userId,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(0),
      contactName: 'WANG MEI',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试服务项',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
          },
        ],
      },
    },
  });
}

async function createSchedule() {
  const departureTime = new Date(Date.now() + 200 * 3600 * 1000);
  const flight = await prisma.flight.create({
    data: { flightNumber: `T${Math.floor(Math.random() * 100000)}`, originCode: 'MFM', destinationCode: 'DAD', isActive: true },
  });
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: { create: [{ cabin: CabinClass.ECONOMY, capacity: 50, sold: 0, basePrice: new Prisma.Decimal(1000) }] },
    },
  });
}

const passengerInput = (i: number, passportPhotoUrl?: string) => ({
  fullName: `WANG XIAO ${i}`,
  documentType: 'PASSPORT' as const,
  documentNumber: uniq(`P${i}`),
  dateOfBirth: '1990-01-01',
  nationality: 'CN',
  passengerType: 'ADULT' as const,
  passportExpiry: '2031-01-01',
  ...(passportPhotoUrl ? { passportPhotoUrl } : {}),
});

describe('图片出库扩展 · Prisma 直接写入口', () => {
  it('order.create 嵌套 passengers.create：库里是引用、blob 落盘、业务读回 data URL', async () => {
    const order = await prisma.order.create({
      data: {
        orderNumber: uniq('TEST-BLOB'),
        subtotal: 1,
        total: 1,
        contactName: 'A',
        contactPhone: '1',
        passengers: {
          create: [
            { fullName: 'X', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: PNG_URL },
            { fullName: 'Y', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: null },
          ],
        },
      },
      include: { passengers: { orderBy: { fullName: 'asc' } } },
    });
    // create 的返回值经过读钩子：已经是 data URL
    expect(order.passengers[0].passportPhotoUrl).toBe(PNG_URL);
    expect(order.passengers[1].passportPhotoUrl).toBeNull();

    const raw = await rawPrisma.passenger.findMany({ where: { orderId: order.id }, orderBy: { fullName: 'asc' } });
    expect(raw[0].passportPhotoUrl).toBe(PNG_REF);
    expect(raw[1].passportPhotoUrl).toBeNull();
    expect(await blobFileExists(sha256Hex(PNG_1PX))).toBe(true);

    const viaBusiness = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { passengers: { orderBy: { fullName: 'asc' } } },
    });
    expect(viaBusiness.passengers[0].passportPhotoUrl).toBe(PNG_URL);

    // 签证台列表的 hasPhoto SQL 口径：列非空即有图（引用非空）
    const [row] = await prisma.$queryRaw<Array<{ hasPhoto: boolean }>>`
      SELECT ("passportPhotoUrl" IS NOT NULL AND length("passportPhotoUrl") > 0) AS "hasPhoto"
      FROM "Passenger" WHERE id = ${raw[0].id}
    `;
    expect(row.hasPhoto).toBe(true);
  });

  it('交互式事务 tx.passenger.update / 批量事务 updateMany / `{ set }` 算子都走钩子', async () => {
    const order = await createPendingOrder(null);
    const passenger = await prisma.passenger.create({
      data: { orderId: order.id, fullName: 'Z', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN' },
    });

    await prisma.$transaction(async (tx) => {
      await tx.passenger.update({ where: { id: passenger.id }, data: { passportPhotoUrl: JPEG_URL } });
      const inTx = await tx.passenger.findUniqueOrThrow({ where: { id: passenger.id } });
      expect(inTx.passportPhotoUrl).toBe(JPEG_URL); // 事务内读也已还原
    });
    expect((await rawPrisma.passenger.findUniqueOrThrow({ where: { id: passenger.id } })).passportPhotoUrl).toBe(JPEG_REF);

    await prisma.$transaction([
      prisma.passenger.updateMany({ where: { id: passenger.id }, data: { passportPhotoUrl: PNG_URL } }),
    ]);
    expect((await rawPrisma.passenger.findUniqueOrThrow({ where: { id: passenger.id } })).passportPhotoUrl).toBe(PNG_REF);

    await prisma.passenger.update({ where: { id: passenger.id }, data: { passportPhotoUrl: { set: JPEG_URL } } });
    expect((await rawPrisma.passenger.findUniqueOrThrow({ where: { id: passenger.id } })).passportPhotoUrl).toBe(JPEG_REF);
  });

  it('payment.create / receipt.create 的 proofUrl 同样出库；无图 / 外链原样', async () => {
    const order = await createPendingOrder(null);
    const payment = await prisma.payment.create({
      data: { orderId: order.id, method: PaymentMethod.BANK_CARD, amount: new Prisma.Decimal(100), proofUrl: PNG_URL },
    });
    expect(payment.proofUrl).toBe(PNG_URL);
    expect((await rawPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).proofUrl).toBe(PNG_REF);

    const receipt = await prisma.receipt.create({
      data: {
        receiptNo: uniq('RCP'),
        amountCny: new Prisma.Decimal(100),
        method: PaymentMethod.WECHAT_PAY,
        receivedAt: new Date(),
        source: ReceiptSource.STAFF_ENTRY,
        proofUrl: JPEG_URL,
      },
    });
    expect((await rawPrisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).proofUrl).toBe(JPEG_REF);
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).proofUrl).toBe(JPEG_URL);

    const external = await prisma.payment.create({
      data: { orderId: order.id, method: PaymentMethod.BANK_CARD, amount: new Prisma.Decimal(1), proofUrl: 'https://example.com/p.jpg' },
    });
    expect((await rawPrisma.payment.findUniqueOrThrow({ where: { id: external.id } })).proofUrl).toBe('https://example.com/p.jpg');
  });

  it('转不了的 data URL（字节不是图片）原样留库；blob 缺失时读回引用本身而不是 null', async () => {
    const order = await createPendingOrder(null);
    const notImage = 'data:image/png;base64,SGVsbG8=';
    const p = await prisma.passenger.create({
      data: { orderId: order.id, fullName: 'N', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN', passportPhotoUrl: notImage },
    });
    expect((await rawPrisma.passenger.findUniqueOrThrow({ where: { id: p.id } })).passportPhotoUrl).toBe(notImage);
    expect((await prisma.passenger.findUniqueOrThrow({ where: { id: p.id } })).passportPhotoUrl).toBe(notImage);

    const missingRef = makeBlobRef('e'.repeat(64), 'image/jpeg');
    await rawPrisma.passenger.update({ where: { id: p.id }, data: { passportPhotoUrl: missingRef } });
    const read = await prisma.passenger.findUniqueOrThrow({ where: { id: p.id } });
    expect(read.passportPhotoUrl).toBe(missingRef);
  });
});

describe('图片出库扩展 · 真实服务入口', () => {
  const orderService = new OrderService();
  const paymentsService = new PaymentsService();
  const receiptsService = new ReceiptsService();

  it('OrderService.createOrder（后台单笔录单 / 前台下单同一入口）出行人护照图出库', async () => {
    const staff = await createUser(UserRole.STAFF);
    const requester: OrderRequester = { userId: staff.id, role: UserRole.STAFF };
    const schedule = await createSchedule();

    const order = await orderService.createOrder(
      {
        contactName: '出库录单测试',
        contactPhone: '13800138000',
        items: [
          { kind: 'FLIGHT', description: '去程（经济舱）', quantity: 2, flightScheduleId: schedule.id, flightCabin: CabinClass.ECONOMY },
        ],
        passengers: [passengerInput(1, JPEG_URL), passengerInput(2)],
      },
      requester,
    );

    const raw = await rawPrisma.passenger.findMany({ where: { orderId: order.id }, orderBy: { fullName: 'asc' } });
    expect(raw).toHaveLength(2);
    expect(raw[0].passportPhotoUrl).toBe(JPEG_REF);
    expect(raw[1].passportPhotoUrl).toBeNull();
    expect(await blobFileExists(sha256Hex(JPEG_FAKE))).toBe(true);

    // 后台详情（STAFF 请求方 → includePassportPhotos，保留大图）读回 data URL；hasPassportPhoto 口径不变
    const detail = await orderService.getOrder(order.id, requester);
    const paxes = (detail as unknown as { passengers: Array<{ passportPhotoUrl?: string; hasPassportPhoto: boolean }> })
      .passengers;
    const withPhoto = paxes.find((p) => p.hasPassportPhoto)!;
    expect(withPhoto.passportPhotoUrl).toBe(JPEG_URL);
    expect(paxes.filter((p) => p.hasPassportPhoto)).toHaveLength(1);
  });

  it('OrderService.selfUpdatePassenger（前台自助补录护照）出库，返回 hasPassportPhoto=true', async () => {
    const customer = await createUser(UserRole.CUSTOMER);
    const order = await createPendingOrder(customer.id);
    const passenger = await prisma.passenger.create({
      data: { orderId: order.id, fullName: 'SELF SERVICE', documentType: 'PASSPORT', documentNumber: uniq('D'), nationality: 'CHN' },
    });

    const result = await orderService.selfUpdatePassenger(
      order.id,
      passenger.id,
      { passportPhotoUrl: PNG_URL },
      { userId: customer.id, role: UserRole.CUSTOMER },
    );
    expect(result.changedFields).toContain('passportPhotoUrl');
    expect(result.passenger.hasPassportPhoto).toBe(true);
    expect('passportPhotoUrl' in result.passenger).toBe(false); // 自助端照旧剥离大图
    expect((await rawPrisma.passenger.findUniqueOrThrow({ where: { id: passenger.id } })).passportPhotoUrl).toBe(PNG_REF);
  });

  it('PaymentsService.confirmManualPayment（人工确认收款截图）出库，读回 data URL', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const order = await createPendingOrder(null, 1000);
    const result = await paymentsService.confirmManualPayment(
      order.id,
      { amount: 1000, method: PaymentMethod.BANK_CARD, proofUrl: JPEG_URL },
      { userId: admin.id, role: UserRole.ADMIN },
    );
    expect(result.ok).toBe(true);
    const raw = await rawPrisma.payment.findUniqueOrThrow({ where: { id: result.paymentId! } });
    expect(raw.proofUrl).toBe(JPEG_REF);
    expect(raw.proofUrl!.startsWith(BLOB_REF_PREFIX)).toBe(true);
    expect(parseBlobRef(raw.proofUrl)).not.toBeNull();

    const listed = await prisma.payment.findUniqueOrThrow({ where: { id: result.paymentId! } });
    expect(listed.proofUrl).toBe(JPEG_URL);
  });

  it('ReceiptsService.customerUpload（前台 public 上传付款凭证）出库', async () => {
    const order = await createPendingOrder(null, 1000);
    const uploaded = await receiptsService.customerUpload({
      orderId: order.id,
      amountCny: 1000,
      method: PaymentMethod.WECHAT_PAY,
      proofUrl: PNG_URL,
    });
    expect(uploaded.ok).toBe(true);
    expect(uploaded.status).toBe(ReceiptStatus.OPEN);
    const raw = await rawPrisma.receipt.findUniqueOrThrow({ where: { id: uploaded.receiptId } });
    expect(raw.proofUrl).toBe(PNG_REF);
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: uploaded.receiptId } })).proofUrl).toBe(PNG_URL);
  });
});
