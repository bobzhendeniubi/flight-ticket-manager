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
    hotel: { findFirst: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() },
    hotelRoomType: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    transfer: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    visa: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    flight: { findUnique: vi.fn() },
    flightSeatClass: { findMany: vi.fn() },
    // 评价聚合（ReviewsService.getAggregates 内部用；listXxx/getXxx 的 includeCost 透传测试会走到这里）
    review: { groupBy: vi.fn() },
    // updateHotel 用 $transaction 包房型 upsert；测试里直接把 mockPrisma 自己当 tx 传回调（同款方法集）
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  ProductsService,
  deriveHotelNightsFromItems,
  resolveBundleItemPrices,
  serializeHotel,
  serializeTransfer,
  serializeVisa,
} from './products.service.js';
import type { BundleItemInput } from './products.schemas.js';
import {
  getCheapestRoundTripEconomyCny,
  resetCheapestFlightRefCache,
} from './bundle-pricing.js';
import { BUNDLE_ROUTE } from './bundle-availability.service.js';

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

  it('HOTEL 未关联房型 → 抛 400（套餐含酒店组件时必须关联房型，防止起价静默漏算酒店）', async () => {
    await expect(
      resolveBundleItemPrices([item({ kind: 'HOTEL', unitPrice: 580 })], null),
    ).rejects.toThrow('套餐含酒店组件时必须关联房型');
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
  });

  it('HOTEL 未关联房型 + hotelRoomTypeId=undefined（省略）→ 同样抛 400', async () => {
    await expect(
      resolveBundleItemPrices([item({ kind: 'HOTEL', unitPrice: 580 })], undefined),
    ).rejects.toThrow('套餐含酒店组件时必须关联房型');
  });

  it('无 HOTEL 组件 + 未关联房型 → 不受影响，正常定价（如纯机票+接送套餐）', async () => {
    mockPrisma.transfer.findMany.mockResolvedValueOnce([
      { id: 't1', basePrice: new Prisma.Decimal(188) },
    ]);
    const out = await resolveBundleItemPrices(
      [
        item({ kind: 'FLIGHT', unitPrice: 0 }),
        item({ kind: 'TRANSFER', unitPrice: 1, transferId: 't1' }),
      ],
      null,
    );
    expect(out.map((i) => i.unitPrice)).toEqual([0, 188]);
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

describe('ProductsService · serviceNotes / stayDays 写入 + 序列化往返', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // createBundle/updateBundle 内部会喂 getCheapestRoundTripEconomyCny 算 originalAllInCny/originalPerPaxCny
    // （与本次新增字段无关的旁路依赖）；给个空数组兜底，避免未 mock 时读 undefined 报错。
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([]);
  });

  it('createBundle 落库 serviceNotes 并原样透出', async () => {
    mockPrisma.bundle.findFirst.mockResolvedValueOnce(null);
    mockPrisma.bundle.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: data.code,
      name: data.name,
      tagline: data.tagline ?? null,
      serviceNotes: data.serviceNotes ?? null,
      emoji: null,
      photo: null,
      items: data.items,
      flightPax: data.flightPax,
      discountPct: data.discountPct,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.createBundle({
      name: '测试套餐',
      items: [{ kind: 'FLIGHT', productName: '去程', qty: 1, unitPrice: 0 }],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: 0,
      isActive: true,
      serviceNotes: '中文客服，越南当地机场助签\n举牌接机，送至酒店并协助分房',
    });

    expect(result.serviceNotes).toBe('中文客服，越南当地机场助签\n举牌接机，送至酒店并协助分房');
    expect(mockPrisma.bundle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serviceNotes: '中文客服，越南当地机场助签\n举牌接机，送至酒店并协助分房',
        }),
      }),
    );
  });

  it('updateBundle 只传 serviceNotes 时只更新该字段（其余不变）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValueOnce({
      id: 'bundle-1',
      hotelRoomTypeId: null,
      outboundFlightId: null,
      returnFlightId: null,
    });
    mockPrisma.bundle.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: 'B0001',
      name: '测试套餐',
      tagline: null,
      serviceNotes: data.serviceNotes,
      emoji: null,
      photo: null,
      items: [],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.updateBundle('bundle-1', { serviceNotes: '离境日通知旅客，送往机场并辅助值机' });

    expect(result.serviceNotes).toBe('离境日通知旅客，送往机场并辅助值机');
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bundle-1' },
        data: { serviceNotes: '离境日通知旅客，送往机场并辅助值机' },
      }),
    );
  });

  it('createVisa 落库 stayDays 并原样透出', async () => {
    mockPrisma.visa.findFirst.mockResolvedValueOnce(null);
    mockPrisma.visa.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'visa-1',
      code: data.code,
      destinationCountry: data.destinationCountry,
      country: data.country ?? null,
      visaType: data.visaType,
      visaName: data.visaName ?? null,
      flag: null,
      photo: null,
      processingDays: data.processingDays,
      basePrice: new Prisma.Decimal(280),
      expressSurcharge: null,
      costPriceCny: null,
      validityMonths: data.validityMonths ?? null,
      stayDays: data.stayDays ?? null,
      highlight: null,
      requiredDocs: [],
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const service = new ProductsService();
    const result = await service.createVisa({
      destinationCountry: 'VN',
      visaType: 'tourist',
      processingDays: 3,
      basePrice: 280,
      isActive: true,
      stayDays: 30,
    });

    expect(result.stayDays).toBe(30);
    expect(mockPrisma.visa.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stayDays: 30 }) }),
    );
  });

  it('updateVisa 只传 stayDays 时只更新该字段（其余不变）', async () => {
    mockPrisma.visa.findUnique.mockResolvedValueOnce({ id: 'visa-1' });
    mockPrisma.visa.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'visa-1',
      code: 'V0001',
      destinationCountry: 'VN',
      country: '越南',
      visaType: 'tourist',
      visaName: '电子签证',
      flag: null,
      photo: null,
      processingDays: 3,
      basePrice: new Prisma.Decimal(280),
      expressSurcharge: null,
      costPriceCny: null,
      validityMonths: null,
      stayDays: data.stayDays,
      highlight: null,
      requiredDocs: [],
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const service = new ProductsService();
    const result = await service.updateVisa('visa-1', { stayDays: 45 });

    expect(result.stayDays).toBe(45);
    expect(mockPrisma.visa.update).toHaveBeenCalledWith({
      where: { id: 'visa-1' },
      data: { stayDays: 45 },
    });
  });
});

describe('ProductsService · 套餐含酒店组件必须关联房型（create + update 路径）', () => {
  // 复现向导截图里的陷阱：酒店行没关联房型 → 服务端曾静默保留调用方乱填的 unitPrice，
  // 起价漏算酒店（¥0）却看起来是正常价格。现在两条写路径都必须在写库前硬拒绝。
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([]);
  });

  const hotelItem = { kind: 'FLIGHT' as const, productName: '澳门⇌岘港', qty: 1, unitPrice: 0 };
  const hotelOnly = { kind: 'HOTEL' as const, productName: '海景大床房', qty: 3, unitPrice: 999 };

  it('createBundle：items 含 HOTEL 但未传 hotelRoomTypeId → 抛 400，且不写库', async () => {
    const service = new ProductsService();
    await expect(
      service.createBundle({
        name: '未关联房型套餐',
        items: [hotelItem, hotelOnly],
        flightPax: 2,
        discountPct: 0,
        groundDiscount: 0,
        isActive: true,
      }),
    ).rejects.toThrow('套餐含酒店组件时必须关联房型');
    expect(mockPrisma.bundle.create).not.toHaveBeenCalled();
  });

  it('createBundle：items 含 HOTEL 且 hotelRoomTypeId 显式传 null → 同样抛 400', async () => {
    const service = new ProductsService();
    await expect(
      service.createBundle({
        name: '未关联房型套餐',
        items: [hotelItem, hotelOnly],
        flightPax: 2,
        discountPct: 0,
        groundDiscount: 0,
        isActive: true,
        hotelRoomTypeId: null,
      }),
    ).rejects.toThrow('套餐含酒店组件时必须关联房型');
  });

  it('updateBundle：改 items 加入 HOTEL 行，既有套餐 + 本次请求都没有 hotelRoomTypeId → 抛 400，且不写库', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValueOnce({
      id: 'bundle-1',
      hotelRoomTypeId: null,
      outboundFlightId: null,
      returnFlightId: null,
    });
    const service = new ProductsService();
    await expect(
      service.updateBundle('bundle-1', { items: [hotelItem, hotelOnly] }),
    ).rejects.toThrow('套餐含酒店组件时必须关联房型');
    expect(mockPrisma.bundle.update).not.toHaveBeenCalled();
  });

  it('updateBundle：既有套餐已关联房型，本次只改别的字段（不传 items）→ 不受影响，正常保存', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValueOnce({
      id: 'bundle-1',
      hotelRoomTypeId: 'room-1',
      outboundFlightId: null,
      returnFlightId: null,
    });
    mockPrisma.bundle.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: 'B0001',
      name: '关联房型套餐',
      tagline: data.tagline ?? null,
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: [hotelOnly],
      flightPax: 2,
      discountPct: 0,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: 'room-1',
      hotelNights: 3,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.updateBundle('bundle-1', { tagline: '新文案' });

    expect(result.tagline).toBe('新文案');
    expect(mockPrisma.bundle.update).toHaveBeenCalled();
  });
});

describe('ProductsService · businessUpgradeCnyPerLeg 默认值（0702 反馈：留空=不提供升舱，非 DB 默认 ¥700）', () => {
  // 0702 反馈：运营把「留空」当成「用默认 ¥700」，还把这 700 错当成起价的一部分。
  // createBundle 现在显式写 0（不再让 DB @default(700) 生效）；updateBundle 保持原「省略=保留现值」不变。
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([]);
  });

  const flightOnlyItem = { kind: 'FLIGHT' as const, productName: '去程', qty: 1, unitPrice: 0 };

  it('createBundle：省略 businessUpgradeCnyPerLeg → 显式落库 0（不落 DB 默认 700）', async () => {
    mockPrisma.bundle.findFirst.mockResolvedValueOnce(null);
    mockPrisma.bundle.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: data.code,
      name: data.name,
      tagline: null,
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: data.items,
      flightPax: data.flightPax,
      discountPct: data.discountPct,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: data.businessUpgradeCnyPerLeg,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.createBundle({
      name: '不提供升舱套餐',
      items: [flightOnlyItem],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: 0,
      isActive: true,
      // businessUpgradeCnyPerLeg 省略
    });

    expect(result.businessUpgradeCnyPerLeg).toBe(0);
    expect(mockPrisma.bundle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessUpgradeCnyPerLeg: 0 }) }),
    );
  });

  it('createBundle：businessUpgradeCnyPerLeg 显式传 null → 同样落库 0', async () => {
    mockPrisma.bundle.findFirst.mockResolvedValueOnce(null);
    mockPrisma.bundle.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: data.code,
      name: data.name,
      tagline: null,
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: data.items,
      flightPax: data.flightPax,
      discountPct: data.discountPct,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: data.businessUpgradeCnyPerLeg,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.createBundle({
      name: '不提供升舱套餐（显式 null）',
      items: [flightOnlyItem],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: 0,
      isActive: true,
      businessUpgradeCnyPerLeg: null,
    });

    expect(result.businessUpgradeCnyPerLeg).toBe(0);
    expect(mockPrisma.bundle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessUpgradeCnyPerLeg: 0 }) }),
    );
  });

  it('createBundle：显式传 700 → 原样落库 700（运营仍可主动设置）', async () => {
    mockPrisma.bundle.findFirst.mockResolvedValueOnce(null);
    mockPrisma.bundle.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: data.code,
      name: data.name,
      tagline: null,
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: data.items,
      flightPax: data.flightPax,
      discountPct: data.discountPct,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: data.businessUpgradeCnyPerLeg,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.createBundle({
      name: '显式升舱 700 套餐',
      items: [flightOnlyItem],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: 0,
      isActive: true,
      businessUpgradeCnyPerLeg: 700,
    });

    expect(result.businessUpgradeCnyPerLeg).toBe(700);
    expect(mockPrisma.bundle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessUpgradeCnyPerLeg: 700 }) }),
    );
  });

  it('updateBundle：省略 businessUpgradeCnyPerLeg → 不写该字段（保留现值，不强行改成 0）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValueOnce({
      id: 'bundle-1',
      hotelRoomTypeId: null,
      outboundFlightId: null,
      returnFlightId: null,
    });
    mockPrisma.bundle.update.mockImplementationOnce(async () => ({
      id: 'bundle-1',
      code: 'B0001',
      name: '既有套餐',
      tagline: '新文案',
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: [],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      // 既有套餐落库现值 700（历史数据）：本次只改 tagline，升舱现值应保持不变。
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.updateBundle('bundle-1', { tagline: '新文案' });

    // 保留现值 700（未被强行改成 0）——PATCH body 里根本不该出现 businessUpgradeCnyPerLeg 键。
    expect(result.businessUpgradeCnyPerLeg).toBe(700);
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bundle-1' },
        data: expect.not.objectContaining({ businessUpgradeCnyPerLeg: expect.anything() }),
      }),
    );
  });

  it('updateBundle：显式传 0 → 正常写入 0（运营主动把已有套餐的升舱关掉）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValueOnce({
      id: 'bundle-1',
      hotelRoomTypeId: null,
      outboundFlightId: null,
      returnFlightId: null,
    });
    mockPrisma.bundle.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: 'B0001',
      name: '既有套餐',
      tagline: null,
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: [],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: data.businessUpgradeCnyPerLeg ?? 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));

    const service = new ProductsService();
    const result = await service.updateBundle('bundle-1', { businessUpgradeCnyPerLeg: 0 });

    expect(result.businessUpgradeCnyPerLeg).toBe(0);
  });
});

describe('ProductsService · updateBundle 单房差/儿童差价「留空=用默认」写回（编辑路径修复）', () => {
  // 前端表单占位符承诺「留空 = 用默认 ¥80（单房差）/ ¥30（儿童差价）」，清空输入框时前端显式发 null。
  // 更新已存在行时 DB @default 不生效，旧逻辑把 null 当「不改」→ 默认功能形同虚设。修复：显式 null → 写回默认。
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([]);
  });

  function mockUpdateReturns() {
    mockPrisma.bundle.findUnique.mockResolvedValueOnce({
      id: 'bundle-1',
      hotelRoomTypeId: null,
      outboundFlightId: null,
      returnFlightId: null,
    });
    mockPrisma.bundle.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'bundle-1',
      code: 'B0001',
      name: '既有套餐',
      tagline: null,
      serviceNotes: null,
      emoji: null,
      photo: null,
      items: [],
      flightPax: 1,
      discountPct: 0,
      groundDiscount: new Prisma.Decimal(0),
      suitableFor: null,
      hotelRoomTypeId: null,
      hotelNights: null,
      outboundFlightId: null,
      returnFlightId: null,
      // 落库现值故意设成非默认值（运营此前改过），用来验证清空后是否真的回落默认
      singleSupplementCnyPerNight: data.singleSupplementCnyPerNight ?? 150,
      businessUpgradeCnyPerLeg: 0,
      childSeatDiscountCnyPerPerson: data.childSeatDiscountCnyPerPerson ?? 99,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      blackoutDates: [],
      defaultDepartDate: null,
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      hotelRoomType: null,
      outboundFlight: null,
      returnFlight: null,
    }));
  }

  it('显式传 null（运营清空单房差输入框）→ 写回默认 ¥80', async () => {
    mockUpdateReturns();
    const service = new ProductsService();
    await service.updateBundle('bundle-1', { singleSupplementCnyPerNight: null });
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ singleSupplementCnyPerNight: 80 }) }),
    );
  });

  it('显式传 null（运营清空儿童差价输入框）→ 写回默认 ¥30', async () => {
    mockUpdateReturns();
    const service = new ProductsService();
    await service.updateBundle('bundle-1', { childSeatDiscountCnyPerPerson: null });
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ childSeatDiscountCnyPerPerson: 30 }) }),
    );
  });

  it('显式传数字 → 原样写入（不回落默认）', async () => {
    mockUpdateReturns();
    const service = new ProductsService();
    await service.updateBundle('bundle-1', {
      singleSupplementCnyPerNight: 120,
      childSeatDiscountCnyPerPerson: 45,
    });
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          singleSupplementCnyPerNight: 120,
          childSeatDiscountCnyPerPerson: 45,
        }),
      }),
    );
  });

  it('请求未带这两个字段（undefined）→ 不写这两个键（保持现值，不强刷默认）', async () => {
    mockUpdateReturns();
    const service = new ProductsService();
    await service.updateBundle('bundle-1', { tagline: '只改文案' });
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ singleSupplementCnyPerNight: expect.anything() }),
      }),
    );
    expect(mockPrisma.bundle.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ childSeatDiscountCnyPerPerson: expect.anything() }),
      }),
    );
  });
});

describe('getCheapestRoundTripEconomyCny · 机票参考价范围限定（按航线/绑定航班过滤）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCheapestFlightRefCache();
  });

  it('未绑航班 → 按套餐固定航线过滤（去程 origin→destination，回程 destination→origin），绝不扫全库', async () => {
    // 去程最低 700、回程最低 750 → 来回 = 1450（两段各自估价相加）
    mockPrisma.flightSeatClass.findMany
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(700), fareBuckets: null }])
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(750), fareBuckets: null }]);

    const value = await getCheapestRoundTripEconomyCny(new Date());

    expect(value).toBe(1450);
    const calls = mockPrisma.flightSeatClass.findMany.mock.calls;
    expect(calls).toHaveLength(2);
    // 去程航线过滤
    expect(calls[0][0].where.schedule.flight).toEqual({
      originCode: BUNDLE_ROUTE.origin,
      destinationCode: BUNDLE_ROUTE.destination,
    });
    // 回程航线过滤（方向相反）
    expect(calls[1][0].where.schedule.flight).toEqual({
      originCode: BUNDLE_ROUTE.destination,
      destinationCode: BUNDLE_ROUTE.origin,
    });
  });

  it('绑定了去/回程航班 → 只看那趟航班的班次价（schedule.flightId 过滤，优先于航线兜底）', async () => {
    mockPrisma.flightSeatClass.findMany
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(720), fareBuckets: null }])
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(720), fareBuckets: null }]);

    const value = await getCheapestRoundTripEconomyCny(new Date(), {
      outboundFlightId: 'flight-out',
      returnFlightId: 'flight-back',
    });

    expect(value).toBe(1440);
    const calls = mockPrisma.flightSeatClass.findMany.mock.calls;
    expect(calls[0][0].where.schedule.flightId).toBe('flight-out');
    expect(calls[0][0].where.schedule.flight).toBeUndefined();
    expect(calls[1][0].where.schedule.flightId).toBe('flight-back');
  });

  it('某段查不到班次 → 用另一段 ×2 兜底（对称假设）', async () => {
    mockPrisma.flightSeatClass.findMany
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(700), fareBuckets: null }])
      .mockResolvedValueOnce([]); // 回程无班次

    const value = await getCheapestRoundTripEconomyCny(new Date());
    expect(value).toBe(1400);
  });

  it('两段都查不到班次 → null（套餐原价退化为仅地面）', async () => {
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([]);
    const value = await getCheapestRoundTripEconomyCny(new Date());
    expect(value).toBeNull();
  });
});

describe('ProductsService.getBundleFlightRef · 后台起价换算用机票参考价端点', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCheapestFlightRefCache();
  });

  it('按传入绑定取当前最低来回机票，包成 { flightRefRoundTripCny }（去程 720 + 回程 720 = 1440）', async () => {
    mockPrisma.flightSeatClass.findMany
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(720), fareBuckets: null }])
      .mockResolvedValueOnce([{ basePrice: new Prisma.Decimal(720), fareBuckets: null }]);

    const service = new ProductsService();
    const res = await service.getBundleFlightRef({
      outboundFlightId: 'flight-out',
      returnFlightId: 'flight-back',
    });

    expect(res).toEqual({ flightRefRoundTripCny: 1440 });
    // 绑定透传：按航班 id 过滤，不落到航线兜底
    const calls = mockPrisma.flightSeatClass.findMany.mock.calls;
    expect(calls[0][0].where.schedule.flightId).toBe('flight-out');
    expect(calls[1][0].where.schedule.flightId).toBe('flight-back');
  });

  it('未绑航班（两参数都空）→ 按套餐航线兜底；查不到任何班次 → { flightRefRoundTripCny: null }', async () => {
    mockPrisma.flightSeatClass.findMany.mockResolvedValue([]);

    const service = new ProductsService();
    const res = await service.getBundleFlightRef({ outboundFlightId: null, returnFlightId: null });

    expect(res).toEqual({ flightRefRoundTripCny: null });
    const calls = mockPrisma.flightSeatClass.findMany.mock.calls;
    // 航线兜底：按 origin→destination / destination→origin 过滤，不是 flightId
    expect(calls[0][0].where.schedule.flight).toEqual({
      originCode: BUNDLE_ROUTE.origin,
      destinationCode: BUNDLE_ROUTE.destination,
    });
  });
});

describe('ProductsService · costPriceCny 成本价往返（0702 后台反馈 5·成本价进产品表单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createHotel：roomTypes[].costPriceCny 落库为 Decimal 并原样透出', async () => {
    mockPrisma.hotel.findFirst.mockResolvedValueOnce(null);
    mockPrisma.hotel.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'hotel-1',
      code: data.code,
      name: data.name,
      nameEn: null,
      cityCode: 'DAD',
      area: null,
      address: '测试地址',
      starRating: 4,
      basePrice: null,
      rating: null,
      reviewCount: null,
      soldCount: 0,
      emoji: null,
      highlight: null,
      latitude: null,
      longitude: null,
      amenities: [],
      photos: [],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      roomTypes: (data.roomTypes as { create: Array<Record<string, unknown>> }).create.map((rt, i) => ({
        id: `rt-${i}`,
        hotelId: 'hotel-1',
        ...rt,
      })),
    }));

    const service = new ProductsService();
    const result = await service.createHotel({
      name: '测试酒店',
      cityCode: 'DAD',
      address: '测试地址',
      starRating: 4,
      isActive: true,
      amenities: [],
      photos: [],
      roomTypes: [
        { name: '标准房', capacity: 2, maxAdults: 2, maxChildren: 1, basePrice: 500, costPriceCny: 350 },
      ],
    });

    expect(result.roomTypes[0].costPriceCny).toBe('350');
    const callArg = mockPrisma.hotel.create.mock.calls[0][0] as {
      data: { roomTypes: { create: Array<{ costPriceCny: Prisma.Decimal }> } };
    };
    expect(callArg.data.roomTypes.create[0].costPriceCny.toString()).toBe('350');
  });

  it('createHotel：roomTypes[].costPriceCny 省略 → 落库 null（未录，不是 0，也不报错）', async () => {
    mockPrisma.hotel.findFirst.mockResolvedValueOnce(null);
    mockPrisma.hotel.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'hotel-1',
      code: data.code,
      name: data.name,
      nameEn: null,
      cityCode: 'DAD',
      area: null,
      address: '测试地址',
      starRating: 4,
      basePrice: null,
      rating: null,
      reviewCount: null,
      soldCount: 0,
      emoji: null,
      highlight: null,
      latitude: null,
      longitude: null,
      amenities: [],
      photos: [],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      roomTypes: (data.roomTypes as { create: Array<Record<string, unknown>> }).create.map((rt, i) => ({
        id: `rt-${i}`,
        hotelId: 'hotel-1',
        ...rt,
      })),
    }));

    const service = new ProductsService();
    const result = await service.createHotel({
      name: '测试酒店',
      cityCode: 'DAD',
      address: '测试地址',
      starRating: 4,
      isActive: true,
      amenities: [],
      photos: [],
      roomTypes: [{ name: '标准房', capacity: 2, maxAdults: 2, maxChildren: 1, basePrice: 500 }],
    });

    expect(result.roomTypes[0].costPriceCny).toBeNull();
  });

  it('updateHotel：房型行编辑时把成本价字段留空提交 → 清空为 null（整行覆盖式提交，省略≠"不改"）', async () => {
    mockPrisma.hotel.findUnique.mockResolvedValueOnce({ id: 'hotel-1' });
    mockPrisma.$transaction.mockImplementationOnce(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
    mockPrisma.hotel.update.mockResolvedValueOnce({});
    mockPrisma.hotelRoomType.findMany.mockResolvedValueOnce([{ id: 'rt-1', name: '标准房' }]);
    mockPrisma.hotelRoomType.update.mockResolvedValueOnce({});
    mockPrisma.hotel.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'hotel-1',
      code: 'H0001',
      name: '测试酒店',
      nameEn: null,
      cityCode: 'DAD',
      area: null,
      address: '测试地址',
      starRating: 4,
      basePrice: null,
      rating: null,
      reviewCount: null,
      soldCount: 0,
      emoji: null,
      highlight: null,
      latitude: null,
      longitude: null,
      amenities: [],
      photos: [],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      roomTypes: [
        {
          id: 'rt-1',
          hotelId: 'hotel-1',
          name: '标准房',
          bedType: null,
          capacity: 2,
          maxAdults: 2,
          maxChildren: 1,
          basePrice: new Prisma.Decimal(500),
          priceMultiplier: null,
          costPriceCny: null,
          photos: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const service = new ProductsService();
    const result = await service.updateHotel('hotel-1', {
      roomTypes: [
        // costPriceCny 省略（表单里被清空提交）
        { id: 'rt-1', name: '标准房', capacity: 2, maxAdults: 2, maxChildren: 1, basePrice: 500 },
      ],
    });

    expect(result.roomTypes[0].costPriceCny).toBeNull();
    expect(mockPrisma.hotelRoomType.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'rt-1' },
        data: expect.objectContaining({ costPriceCny: null }),
      }),
    );
  });

  it('createTransfer：costPriceCny 落库为 Decimal 并原样透出', async () => {
    mockPrisma.transfer.findFirst.mockResolvedValueOnce(null);
    mockPrisma.transfer.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'transfer-1',
      code: data.code,
      name: data.name,
      vehicleType: data.vehicleType,
      capacity: data.capacity,
      originArea: data.originArea,
      destArea: data.destArea,
      basePrice: data.basePrice,
      costPriceCny: data.costPriceCny,
      features: [],
      duration: null,
      soldCount: 0,
      emoji: null,
      photo: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const service = new ProductsService();
    const result = await service.createTransfer({
      name: '机场接送',
      vehicleType: '轿车',
      capacity: 3,
      originArea: 'A',
      destArea: 'B',
      basePrice: 100,
      features: [],
      isActive: true,
      costPriceCny: 65,
    });

    expect(result.costPriceCny).toBe('65');
    const callArg = mockPrisma.transfer.create.mock.calls[0][0] as { data: { costPriceCny: Prisma.Decimal } };
    expect(callArg.data.costPriceCny.toString()).toBe('65');
  });

  it('updateTransfer：省略 costPriceCny → 不写该字段（保留现值，不强行清空）', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValueOnce({ id: 'transfer-1' });
    mockPrisma.transfer.update.mockResolvedValueOnce({
      id: 'transfer-1',
      code: 'T0001',
      name: '改名后',
      vehicleType: '轿车',
      capacity: 3,
      originArea: 'A',
      destArea: 'B',
      basePrice: new Prisma.Decimal(100),
      costPriceCny: new Prisma.Decimal(65),
      features: [],
      duration: null,
      soldCount: 0,
      emoji: null,
      photo: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const service = new ProductsService();
    const result = await service.updateTransfer('transfer-1', { name: '改名后' });

    expect(result.costPriceCny).toBe('65');
    expect(mockPrisma.transfer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ costPriceCny: expect.anything() }),
      }),
    );
  });

  it('updateTransfer：显式传 null → 清空成本价为 null（运营主动清空已录的成本，不是"忘了填"）', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValueOnce({ id: 'transfer-1' });
    mockPrisma.transfer.update.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'transfer-1',
      code: 'T0001',
      name: '机场接送',
      vehicleType: '轿车',
      capacity: 3,
      originArea: 'A',
      destArea: 'B',
      basePrice: new Prisma.Decimal(100),
      costPriceCny: data.costPriceCny,
      features: [],
      duration: null,
      soldCount: 0,
      emoji: null,
      photo: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const service = new ProductsService();
    const result = await service.updateTransfer('transfer-1', { costPriceCny: null });

    expect(result.costPriceCny).toBeNull();
    expect(mockPrisma.transfer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ costPriceCny: null }) }),
    );
  });

  it('createVisa：costPriceCny 落库为 Decimal 并原样透出', async () => {
    mockPrisma.visa.findFirst.mockResolvedValueOnce(null);
    mockPrisma.visa.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'visa-1',
      code: data.code,
      destinationCountry: data.destinationCountry,
      country: data.country ?? null,
      visaType: data.visaType,
      visaName: data.visaName ?? null,
      flag: null,
      photo: null,
      processingDays: data.processingDays,
      basePrice: new Prisma.Decimal(280),
      expressSurcharge: null,
      costPriceCny: data.costPriceCny,
      validityMonths: data.validityMonths ?? null,
      stayDays: data.stayDays ?? null,
      highlight: null,
      requiredDocs: [],
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const service = new ProductsService();
    const result = await service.createVisa({
      destinationCountry: 'VN',
      visaType: 'tourist',
      processingDays: 3,
      basePrice: 280,
      isActive: true,
      costPriceCny: 150,
    });

    expect(result.costPriceCny).toBe('150');
    const callArg = mockPrisma.visa.create.mock.calls[0][0] as { data: { costPriceCny: Prisma.Decimal } };
    expect(callArg.data.costPriceCny.toString()).toBe('150');
  });

  it('updateVisa：省略 costPriceCny → 不写该字段（保留现值）', async () => {
    mockPrisma.visa.findUnique.mockResolvedValueOnce({ id: 'visa-1' });
    mockPrisma.visa.update.mockResolvedValueOnce({
      id: 'visa-1',
      code: 'V0001',
      destinationCountry: 'VN',
      country: '越南',
      visaType: 'tourist',
      visaName: '电子签证',
      flag: null,
      photo: null,
      processingDays: 3,
      basePrice: new Prisma.Decimal(280),
      expressSurcharge: null,
      costPriceCny: new Prisma.Decimal(150),
      validityMonths: null,
      stayDays: null,
      highlight: null,
      requiredDocs: [],
      soldCount: 0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const service = new ProductsService();
    const result = await service.updateVisa('visa-1', { highlight: '限时优惠' });

    expect(result.costPriceCny).toBe('150');
    expect(mockPrisma.visa.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ costPriceCny: expect.anything() }),
      }),
    );
  });
});

describe('serializeHotel / serializeTransfer / serializeVisa · includeCost 角色隔离（0702 反馈 6·成本泄漏修复）', () => {
  const hotelRow = {
    id: 'hotel-1',
    code: 'H0001',
    name: '测试酒店',
    nameEn: null,
    cityCode: 'DAD',
    area: null,
    address: '测试地址',
    starRating: 4,
    basePrice: new Prisma.Decimal(880),
    rating: null,
    reviewCount: 0,
    soldCount: 0,
    emoji: null,
    highlight: null,
    latitude: null,
    longitude: null,
    amenities: [] as string[],
    photos: [] as string[],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    roomTypes: [
      {
        id: 'rt-1',
        hotelId: 'hotel-1',
        name: '标准房',
        bedType: null,
        capacity: 2,
        maxAdults: 2,
        maxChildren: 1,
        basePrice: new Prisma.Decimal(880),
        priceMultiplier: null,
        costPriceCny: new Prisma.Decimal(620),
        photos: [] as string[],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const transferRow = {
    id: 't1',
    code: 'T0001',
    name: '机场接送',
    vehicleType: '轿车',
    capacity: 3,
    originArea: 'A',
    destArea: 'B',
    basePrice: new Prisma.Decimal(100),
    costPriceCny: new Prisma.Decimal(65),
    features: [] as string[],
    duration: null,
    soldCount: 0,
    emoji: null,
    photo: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const visaRow = {
    id: 'v1',
    code: 'V0001',
    destinationCountry: 'VN',
    country: '越南',
    visaType: 'tourist',
    visaName: null,
    flag: null,
    photo: null,
    processingDays: 3,
    basePrice: new Prisma.Decimal(280),
    expressSurcharge: null,
    costPriceCny: new Prisma.Decimal(150),
    validityMonths: 1,
    stayDays: null,
    highlight: null,
    requiredDocs: [] as string[],
    soldCount: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('includeCost=false（匿名/游客）→ 三种产品序列化结果都完全不含 costPriceCny 这个 key（不是 null，是没有该 key）', () => {
    const hotel = serializeHotel(hotelRow, undefined, false);
    expect(hotel.roomTypes[0]).not.toHaveProperty('costPriceCny');

    const transfer = serializeTransfer(transferRow, undefined, false);
    expect(transfer).not.toHaveProperty('costPriceCny');

    const visa = serializeVisa(visaRow, undefined, false);
    expect(visa).not.toHaveProperty('costPriceCny');
  });

  it('includeCost=true（ADMIN/STAFF）→ 三种产品都正常下发 costPriceCny（转成字符串，与 basePrice 同款序列化口径）', () => {
    const hotel = serializeHotel(hotelRow, undefined, true);
    expect(hotel.roomTypes[0].costPriceCny).toBe('620');

    const transfer = serializeTransfer(transferRow, undefined, true);
    expect(transfer.costPriceCny).toBe('65');

    const visa = serializeVisa(visaRow, undefined, true);
    expect(visa.costPriceCny).toBe('150');
  });

  it('不传 includeCost（省略第三个参数）→ 默认 true，既有内部调用点（create/update 等）行为不受影响', () => {
    const hotel = serializeHotel(hotelRow);
    expect(hotel.roomTypes[0].costPriceCny).toBe('620');

    const transfer = serializeTransfer(transferRow);
    expect(transfer.costPriceCny).toBe('65');

    const visa = serializeVisa(visaRow);
    expect(visa.costPriceCny).toBe('150');
  });

  it('costPriceCny 本身为 null（未录）：includeCost=true → 下发 null；includeCost=false → 仍不含该 key', () => {
    const rowNoCost = { ...transferRow, costPriceCny: null };
    expect(serializeTransfer(rowNoCost, undefined, true).costPriceCny).toBeNull();
    expect(serializeTransfer(rowNoCost, undefined, false)).not.toHaveProperty('costPriceCny');
  });
});

describe('ProductsService.getTransfer/listTransfers · includeCost 透传（路由层按 req.user 角色算好后传入）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.review.groupBy.mockResolvedValue([]);
  });

  const row = {
    id: 't1',
    code: 'T0001',
    name: '机场接送',
    vehicleType: '轿车',
    capacity: 3,
    originArea: 'A',
    destArea: 'B',
    basePrice: new Prisma.Decimal(100),
    costPriceCny: new Prisma.Decimal(65),
    features: [] as string[],
    duration: null,
    soldCount: 0,
    emoji: null,
    photo: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('getTransfer(id, false)（匿名请求）→ 结果不含 costPriceCny key', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValueOnce(row);
    const service = new ProductsService();
    const result = await service.getTransfer('t1', false);
    expect(result).not.toHaveProperty('costPriceCny');
  });

  it('getTransfer(id, true)（ADMIN/STAFF 请求）→ 结果含 costPriceCny', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValueOnce(row);
    const service = new ProductsService();
    const result = await service.getTransfer('t1', true);
    expect(result.costPriceCny).toBe('65');
  });

  it('listTransfers(false, false)（不带 token 的匿名列表）→ 每一条都不含 costPriceCny key', async () => {
    mockPrisma.transfer.findMany.mockResolvedValueOnce([row]);
    const service = new ProductsService();
    const [result] = await service.listTransfers(false, false);
    expect(result).not.toHaveProperty('costPriceCny');
  });

  it('listTransfers(false)（省略 includeCost）→ 默认 false，与 getXxx 系列同款「默认不下发」口径', async () => {
    mockPrisma.transfer.findMany.mockResolvedValueOnce([row]);
    const service = new ProductsService();
    const [result] = await service.listTransfers(false);
    expect(result).not.toHaveProperty('costPriceCny');
  });
});
