/**
 * 签证台列表 hasPhoto · 真 DB 集成测试
 *
 * hasPhoto 在库内算（原生 SQL），护照大图不拉到应用层。判定式从 length() 换成 octet_length()：
 * UTF8 库里 length() 要把行外存储的整张图读出来逐字数字符，octet_length 只读长度头。
 * 两者对「有没有照片」的判定必须完全一致，这里用真库锁住口径：
 *   没传（NULL）/ 空串 → false；有图 → true；含多字节字符的值同样判有；自备签乘客照旧不进列表。
 *
 * 跑：TEST_DATABASE_URL=… npm run test:integration -- src/modules/fulfillment/fulfillment.list-has-photo.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { FulfillmentStatus, FulfillmentType, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { FulfillmentService } from './fulfillment.service.js';
import { listFulfillmentQuerySchema } from './fulfillment.schemas.js';

// 合成的「图」：真实数据是整张 JPEG 的 data URL，这里只要是个非空的长串即可。
const FAKE_PHOTO = `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ${'A'.repeat(4096)}`;

async function createVisaOrderWithTask(
  passengers: Array<{ fullName: string; photo: string | null; visaExempt?: boolean }>,
) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `TEST-PHOTO-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(500),
      total: new Prisma.Decimal(500),
      paidAmount: new Prisma.Decimal(500),
      contactName: '联系人',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '电子签证',
            quantity: passengers.length,
            unitPrice: new Prisma.Decimal(100),
            amount: new Prisma.Decimal(100 * passengers.length),
          },
        ],
      },
      passengers: {
        create: passengers.map((p, i) => ({
          fullName: p.fullName,
          documentType: 'PASSPORT' as const,
          documentNumber: `E8${String(i).padStart(7, '0')}`,
          nationality: 'CN',
          dateOfBirth: new Date('1990-01-01'),
          visaExempt: p.visaExempt ?? false,
          passportPhotoUrl: p.photo,
        })),
      },
    },
    include: { items: true },
  });
  await prisma.fulfillmentTask.create({
    data: { orderItemId: order.items[0].id, type: FulfillmentType.VISA_APPLICATION, status: FulfillmentStatus.PENDING },
  });
  return order;
}

describe('签证台列表 hasPhoto（库内判定，不读图）', () => {
  it('没传 / 空串 → 无照片；有图（含多字节字符）→ 有照片；自备签乘客照旧不进列表', async () => {
    const order = await createVisaOrderWithTask([
      { fullName: 'PHOTO NULL', photo: null },
      { fullName: 'PHOTO EMPTY', photo: '' },
      { fullName: 'PHOTO JPEG', photo: FAKE_PHOTO },
      { fullName: 'PHOTO CJK', photo: '护照' },
      { fullName: 'SELF VISA', photo: FAKE_PHOTO, visaExempt: true },
    ]);

    const result = await new FulfillmentService().list(
      listFulfillmentQuerySchema.parse({ orderId: order.id, type: 'VISA_APPLICATION' }),
    );

    expect(result.tasks).toHaveLength(1);
    const passengers = result.tasks[0].passengers ?? [];
    expect(Object.fromEntries(passengers.map((p) => [p.fullName, p.hasPhoto]))).toEqual({
      'PHOTO NULL': false,
      'PHOTO EMPTY': false,
      'PHOTO JPEG': true,
      'PHOTO CJK': true,
    });
    // 列表响应本身不带图（真图走按单取图接口 listPassengerPhotos）
    expect(passengers.every((p) => p.passportPhotoUrl === null)).toBe(true);
  });
});
