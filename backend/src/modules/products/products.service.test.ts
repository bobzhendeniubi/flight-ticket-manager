/**
 * ProductsService · 套餐写入不变量单测（vitest）
 *
 * 聚焦两条钱路径权威口径：
 *   1. deriveHotelNightsFromItems：套餐 items 含 HOTEL 组件时，落库 hotelNights 必须
 *      规范化 = HOTEL.qty（真实晚数），夹到 zod 范围 1..30；无 HOTEL 组件 → undefined（不覆盖）。
 *      这是「saved bundles never diverge + legacy null 行 re-save 自愈」的核心口径。
 *   2. resolveBundleItemPrices：套餐组件（HOTEL/TRANSFER/VISA）的 unitPrice 必须由服务端按
 *      关联产品权威覆盖，运营手填的值不可信；FLIGHT 恒为 0；关联产品不存在 → 干净的 404/400。
 *
 * 用 vi.mock 把 prisma 替换掉（products.service 模块加载即 import prisma），不连真 DB。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    transfer: { findMany: vi.fn() },
    visa: { findMany: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { deriveHotelNightsFromItems, resolveBundleItemPrices } from './products.service.js';
import type { BundleItemInput } from './products.schemas.js';

describe('deriveHotelNightsFromItems · 套餐写入不变量', () => {
  it('items 含 HOTEL 组件 → hotelNights = HOTEL.qty（真实晚数）', () => {
    const items = [
      { kind: 'FLIGHT', qty: 1 },
      { kind: 'HOTEL', qty: 3 },
      { kind: 'TRANSFER', qty: 1 },
    ];
    expect(deriveHotelNightsFromItems(items)).toBe(3);
  });

  it('无 HOTEL 组件 → undefined（不强行覆盖调用方原值）', () => {
    expect(
      deriveHotelNightsFromItems([
        { kind: 'FLIGHT', qty: 1 },
        { kind: 'VISA', qty: 1 },
      ]),
    ).toBeUndefined();
  });

  it('HOTEL.qty 超上限 → 夹到 30（保持 zod 1..30 范围）', () => {
    expect(deriveHotelNightsFromItems([{ kind: 'HOTEL', qty: 99 }])).toBe(30);
  });

  it('多个 HOTEL 组件 → 取第一个的 qty', () => {
    expect(
      deriveHotelNightsFromItems([
        { kind: 'HOTEL', qty: 2 },
        { kind: 'HOTEL', qty: 5 },
      ]),
    ).toBe(2);
  });

  it('items 畸形 / 空 → undefined（不抛错）', () => {
    expect(deriveHotelNightsFromItems(null)).toBeUndefined();
    expect(deriveHotelNightsFromItems([])).toBeUndefined();
    expect(deriveHotelNightsFromItems('garbage')).toBeUndefined();
  });
});

describe('resolveBundleItemPrices · 套餐组件价格服务端权威定价', () => {
  // mockPrisma 的 mock 函数在整个文件里共享；每个 test 前清空调用记录/一次性 resolve 值，
  // 避免前一个 it() 里的 mockResolvedValueOnce/调用历史串到下一个 it()（与 orders.service.test.ts 同款约定）。
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const item = (partial: Partial<BundleItemInput>): BundleItemInput => ({
    kind: 'FLIGHT',
    productName: 'x',
    qty: 1,
    unitPrice: 0,
    ...partial,
  });

  it('FLIGHT 恒为 0（即便调用方传了非零值，也会被覆盖）', async () => {
    const [out] = await resolveBundleItemPrices(
      [item({ kind: 'FLIGHT', unitPrice: 9999 })],
      null,
    );
    expect(out.unitPrice).toBe(0);
  });

  it('HOTEL 已关联房型 → unitPrice 覆盖为 HotelRoomType.basePrice（忽略调用方手填的值）', async () => {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValueOnce({
      basePrice: new Prisma.Decimal(2162),
    });
    const [out] = await resolveBundleItemPrices(
      [item({ kind: 'HOTEL', unitPrice: 1 /* 运营手填的错误值 */ })],
      'room-1',
    );
    expect(out.unitPrice).toBe(2162);
    expect(mockPrisma.hotelRoomType.findUnique).toHaveBeenCalledWith({
      where: { id: 'room-1' },
      select: { basePrice: true },
    });
  });

  it('HOTEL 未关联房型（老套餐兼容）→ 保留调用方原值，不强行覆盖', async () => {
    const [out] = await resolveBundleItemPrices(
      [item({ kind: 'HOTEL', unitPrice: 580 })],
      null,
    );
    expect(out.unitPrice).toBe(580);
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
  });

  it('TRANSFER 带 transferId → unitPrice 覆盖为 Transfer.basePrice（忽略调用方手填的值）', async () => {
    mockPrisma.transfer.findMany.mockResolvedValueOnce([
      { id: 't1', basePrice: new Prisma.Decimal(188) },
    ]);
    const [out] = await resolveBundleItemPrices(
      [item({ kind: 'TRANSFER', unitPrice: 999, transferId: 't1' })],
      null,
    );
    expect(out.unitPrice).toBe(188);
    expect(out.transferId).toBe('t1');
  });

  it('TRANSFER 缺 transferId → 抛 400（不允许无关联产品的接送组件定价）', async () => {
    await expect(
      resolveBundleItemPrices([item({ kind: 'TRANSFER', unitPrice: 100 })], null),
    ).rejects.toThrow('必须关联接送产品');
  });

  it('TRANSFER 关联的 transferId 查无此产品 → 抛 404', async () => {
    mockPrisma.transfer.findMany.mockResolvedValueOnce([]); // 查无
    await expect(
      resolveBundleItemPrices(
        [item({ kind: 'TRANSFER', unitPrice: 100, transferId: 'ghost' })],
        null,
      ),
    ).rejects.toThrow('接送产品 ghost 不存在');
  });

  it('VISA 带 visaId → unitPrice 覆盖为 Visa.basePrice（忽略调用方手填的值，qty 不影响单价）', async () => {
    mockPrisma.visa.findMany.mockResolvedValueOnce([
      { id: 'v1', basePrice: new Prisma.Decimal(280) },
    ]);
    const [out] = await resolveBundleItemPrices(
      [item({ kind: 'VISA', qty: 2, unitPrice: 1, visaId: 'v1' })],
      null,
    );
    expect(out.unitPrice).toBe(280);
    expect(out.visaId).toBe('v1');
  });

  it('VISA 缺 visaId → 抛 400', async () => {
    await expect(
      resolveBundleItemPrices([item({ kind: 'VISA', unitPrice: 100 })], null),
    ).rejects.toThrow('必须关联签证产品');
  });

  it('VISA 关联的 visaId 查无此产品 → 抛 404', async () => {
    mockPrisma.visa.findMany.mockResolvedValueOnce([]);
    await expect(
      resolveBundleItemPrices([item({ kind: 'VISA', unitPrice: 100, visaId: 'ghost' })], null),
    ).rejects.toThrow('签证产品 ghost 不存在');
  });

  it('混合组件（FLIGHT+HOTEL+TRANSFER+VISA）→ 各自按各自口径定价，互不影响；返回新数组不修改入参', async () => {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValueOnce({ basePrice: new Prisma.Decimal(2162) });
    mockPrisma.transfer.findMany.mockResolvedValueOnce([{ id: 't1', basePrice: new Prisma.Decimal(188) }]);
    mockPrisma.visa.findMany.mockResolvedValueOnce([{ id: 'v1', basePrice: new Prisma.Decimal(280) }]);

    const original = [
      item({ kind: 'FLIGHT', unitPrice: 0 }),
      item({ kind: 'HOTEL', qty: 3, unitPrice: 1 }),
      item({ kind: 'TRANSFER', qty: 2, unitPrice: 1, transferId: 't1' }),
      item({ kind: 'VISA', qty: 2, unitPrice: 1, visaId: 'v1' }),
    ];
    const originalSnapshot = JSON.parse(JSON.stringify(original));
    const out = await resolveBundleItemPrices(original, 'room-1');

    expect(out.map((i) => i.unitPrice)).toEqual([0, 2162, 188, 280]);
    // 不可变：入参数组未被就地修改
    expect(original).toEqual(originalSnapshot);
  });
});
