/**
 * 星级随机档「落位」守卫 · 单元测试（vitest）
 *
 * 落位 = 把「N 星随机」的未落位随机单（kind=HOTEL、无房型、randomStarTier 非空）落到具体酒店，
 * 走的是与换酒店同一条通道（swapItemHotel）。这里钉死事务之前的三条守卫：
 *   1. 未落位随机单可以进换酒店通道（不再被「该行不含酒店」挡掉）——它本来就没有酒店，正是要落一个；
 *   2. 目标酒店星级（Hotel.starRating）低于随机档档次 = 降级交付 → 拒；同级 / 升级放行；
 *   3. 具体酒店行的既有行为一个字不变（同房型仍拒、非酒店行仍拒、鉴权不放宽）。
 *
 * 只覆盖事务前的守卫（不需要真 DB）；落地后的写入与占用转移由换酒店集成测试覆盖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    orderItem: { findUnique: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    passenger: { findMany: vi.fn().mockResolvedValue([]) },
    hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';

const service = new OrderService();
const admin = { userId: 'admin-1', role: UserRole.ADMIN };

/** 未落位随机单 fixture：kind=HOTEL、hotelRoomTypeId 为空、randomStarTier 非空。*/
function poolItem(tier: number) {
  return {
    id: 'item-1',
    orderId: 'order-1',
    kind: OrderItemKind.HOTEL,
    description: '四星随机 · 2 晚 × 1 间',
    quantity: 2,
    hotelRoomTypeId: null,
    randomStarTier: tier,
    hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
    hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
    roomsBilled: 1,
    unitCostCny: null,
    totalCostCny: null,
  };
}

/** 目标房型 fixture（其酒店的星级由 starRating 决定）。*/
function targetRoomType(starRating: number) {
  return {
    id: 'rt-new',
    name: '豪华海景房',
    hotelId: 'h-new',
    costPriceCny: null,
    hotel: { name: '明月酒店', isActive: true, starRating },
  };
}

const swapBody = { newHotelRoomTypeId: 'rt-new' };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.passenger.findMany.mockResolvedValue([]);
  mockPrisma.hotelBlockPeriod.findMany.mockResolvedValue([]);
});

describe('星级随机档落位：目标酒店星级守卫', () => {
  it('四星随机落到三星酒店 → 拒（降级交付，客人买的是四星）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(poolItem(4));
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue(targetRoomType(3));

    await expect(service.swapItemHotel('order-1', 'item-1', swapBody, admin)).rejects.toThrow(
      /四星随机只能落到 4 星及以上的酒店/,
    );
  });

  it('三星随机落到三星酒店（同级）→ 放行星级守卫', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(poolItem(3));
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue(targetRoomType(3));

    // 目标酒店未配包房周期 → 余量校验放行（未配包房 ≠ 售罄），走到事务才因 mock 未备而失败；
    // 这里只断言「没有因为星级被拒」。
    await expect(
      service.swapItemHotel('order-1', 'item-1', swapBody, admin).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/只能落到/);
  });

  it('三星随机落到五星酒店（升级）→ 放行星级守卫', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(poolItem(3));
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue(targetRoomType(5));

    await expect(
      service.swapItemHotel('order-1', 'item-1', swapBody, admin).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/只能落到/);
  });

  it('池行不再被「该行不含酒店」挡掉 —— 它本来就没落酒店，正是要落一个', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(poolItem(4));
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue(targetRoomType(4));

    await expect(
      service.swapItemHotel('order-1', 'item-1', swapBody, admin).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/该行不含酒店/);
  });

  it('目标酒店已下架 → 拒（与具体酒店行同一条既有守卫）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(poolItem(4));
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      ...targetRoomType(5),
      hotel: { name: '明月酒店', isActive: false, starRating: 5 },
    });

    await expect(service.swapItemHotel('order-1', 'item-1', swapBody, admin)).rejects.toThrow(
      '酒店已下架',
    );
  });
});

// ── 伪落位行（房型挂在随机档「占位酒店」上）────────────────────────────────
/**
 * 占位酒店 = Hotel.randomTierPlaceholder 非空，是随机档早期用假酒店承载时留下的形态。
 * 这类行有 hotelRoomTypeId、但业务上**还没落到任何真酒店**，因此与正规未落位随机单同款：
 *   1. 走同一条换酒店通道把它落到真酒店；
 *   2. 同吃「不许降级交付」的星级约束（档次取占位酒店的 randomTierPlaceholder）。
 * 判定一律看该列，绝不按酒店名字匹配。
 */
describe('星级随机档落位：占位酒店上的伪落位行', () => {
  /** 伪落位行 fixture：有房型（挂在占位酒店上）、randomStarTier 为空。*/
  const placeholderRow = () => ({
    ...poolItem(4),
    randomStarTier: null,
    hotelRoomTypeId: 'rt-placeholder',
  });
  /** 占位酒店的房型 fixture（原房型侧的 select 形状）。*/
  const placeholderRoomType = (tier: number) => ({
    id: 'rt-placeholder',
    name: '标准间',
    hotelId: 'h-placeholder',
    hotel: { name: '随机四星', randomTierPlaceholder: tier },
  });

  it('伪落位行落到低星酒店 → 拒（档次取占位酒店的 randomTierPlaceholder）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(placeholderRow());
    mockPrisma.hotelRoomType.findUnique
      .mockResolvedValueOnce(placeholderRoomType(4))
      .mockResolvedValueOnce(targetRoomType(3));

    await expect(service.swapItemHotel('order-1', 'item-1', swapBody, admin)).rejects.toThrow(
      /四星随机只能落到 4 星及以上的酒店/,
    );
  });

  it('伪落位行落到同级真酒店 → 放行星级守卫（这就是清算这批伪落位单的通道）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(placeholderRow());
    mockPrisma.hotelRoomType.findUnique
      .mockResolvedValueOnce(placeholderRoomType(4))
      .mockResolvedValueOnce(targetRoomType(4));

    await expect(
      service.swapItemHotel('order-1', 'item-1', swapBody, admin).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/只能落到/);
  });

  it('真酒店之间换房不受影响：低星目标也放行星级守卫（不是随机档单）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      ...placeholderRow(),
      hotelRoomTypeId: 'rt-old',
    });
    mockPrisma.hotelRoomType.findUnique
      .mockResolvedValueOnce({
        id: 'rt-old',
        name: '标准间',
        hotelId: 'h-old',
        hotel: { name: '明月酒店', randomTierPlaceholder: null },
      })
      .mockResolvedValueOnce(targetRoomType(2));

    await expect(
      service.swapItemHotel('order-1', 'item-1', swapBody, admin).catch((e: Error) => e.message),
    ).resolves.not.toMatch(/只能落到/);
  });
});

describe('星级随机档落位：具体酒店行行为不变（回归）', () => {
  it('既无房型又无池档次的 HOTEL 行 → 仍拒「该行不含酒店」', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue({ ...poolItem(4), randomStarTier: null });

    await expect(service.swapItemHotel('order-1', 'item-1', swapBody, admin)).rejects.toThrow(
      '该行不含酒店，无法换酒店',
    );
  });

  it('具体酒店行换成同一房型 → 仍拒「无需更换」', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      ...poolItem(4),
      randomStarTier: null,
      hotelRoomTypeId: 'rt-new',
    });

    await expect(service.swapItemHotel('order-1', 'item-1', swapBody, admin)).rejects.toThrow(
      '目标房型与当前房型相同，无需更换',
    );
  });

  it('非 ADMIN/STAFF 调用 → 仍拒（池行不放宽鉴权）', async () => {
    mockPrisma.orderItem.findUnique.mockResolvedValue(poolItem(4));

    await expect(
      service.swapItemHotel('order-1', 'item-1', swapBody, {
        userId: 'agent-1',
        role: UserRole.AGENT,
      }),
    ).rejects.toThrow('仅运营/管理员可换酒店');
  });
});
