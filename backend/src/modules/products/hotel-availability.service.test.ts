/**
 * 前台酒店余量 getHotelAvailability · 单元测试（vitest）
 *
 * 注入 fake PrismaClient（与 hotel-control 测试同款），覆盖：
 *   1. 房型不存在 → NotFoundError（404）
 *   2. 未配置房控（无包房周期）→ { tier: null }，不拦截销售
 *   3. 档位 = 整段最差一晚 remaining：<=0 SOLD_OUT / <=2 LOW / <=5 TIGHT / 其余 AMPLE
 *   4. 周期只盖部分夜晚 → 未覆盖夜 block=0 → SOLD_OUT
 *   5. 响应只含 { tier, nights }，不带任何原始库存数字
 *   6. 查询 schema：日期顺序 / 30 晚上限 / 非法日期
 */
import { describe, it, expect, vi } from 'vitest';

// 默认 prisma 不参与（全部走注入 client）—— 仍需 mock 掉避免真实连接配置
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';
import {
  computeHotelAvailabilityTier,
  getHotelAvailability,
} from './hotel-availability.service.js';
import { hotelAvailabilityQuerySchema } from './products.schemas.js';

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

interface FakeOpts {
  roomType?: { hotelId: string } | null;
  periods?: Array<{ dateFrom: Date; dateTo: Date; rooms: number }>;
  items?: Array<{ hotelCheckIn: Date; hotelCheckOut: Date }>;
}

function fakeClient(opts: FakeOpts = {}): PrismaClient {
  return {
    hotelRoomType: {
      findUnique: vi.fn().mockResolvedValue(
        opts.roomType === undefined ? { hotelId: 'h1' } : opts.roomType,
      ),
    },
    hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(opts.periods ?? []) },
    orderItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? []) },
  } as unknown as PrismaClient;
}

// 3 晚：07-01 / 07-02 / 07-03
const QUERY = { hotelRoomTypeId: 'rt1', checkIn: '2026-07-01', checkOut: '2026-07-04' };

describe('computeHotelAvailabilityTier', () => {
  it('<=0 → SOLD_OUT（含负数）', () => {
    expect(computeHotelAvailabilityTier(0)).toBe('SOLD_OUT');
    expect(computeHotelAvailabilityTier(-3)).toBe('SOLD_OUT');
  });

  it('1-2 → LOW', () => {
    expect(computeHotelAvailabilityTier(1)).toBe('LOW');
    expect(computeHotelAvailabilityTier(2)).toBe('LOW');
  });

  it('3-5 → TIGHT', () => {
    expect(computeHotelAvailabilityTier(3)).toBe('TIGHT');
    expect(computeHotelAvailabilityTier(5)).toBe('TIGHT');
  });

  it('>=6 → AMPLE', () => {
    expect(computeHotelAvailabilityTier(6)).toBe('AMPLE');
    expect(computeHotelAvailabilityTier(100)).toBe('AMPLE');
  });
});

describe('getHotelAvailability', () => {
  it('房型不存在 → NotFoundError', async () => {
    const client = fakeClient({ roomType: null });
    await expect(getHotelAvailability(QUERY, client)).rejects.toThrow(NotFoundError);
  });

  it('整段无包房周期 → tier=null（未配置房控，不拦截）', async () => {
    const client = fakeClient({ periods: [] });
    await expect(getHotelAvailability(QUERY, client)).resolves.toEqual({
      tier: null,
      nights: 3,
    });
  });

  it('最差一晚卖光 → SOLD_OUT（block=2，07-02 两行占房）', async () => {
    const client = fakeClient({
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-03'), rooms: 2 }],
      items: [
        { hotelCheckIn: d('2026-07-02'), hotelCheckOut: d('2026-07-03') },
        { hotelCheckIn: d('2026-07-02'), hotelCheckOut: d('2026-07-03') },
      ],
    });
    await expect(getHotelAvailability(QUERY, client)).resolves.toEqual({
      tier: 'SOLD_OUT',
      nights: 3,
    });
  });

  it('最差一晚剩 2 → LOW（block=3，一行住满全程）', async () => {
    const client = fakeClient({
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-03'), rooms: 3 }],
      items: [{ hotelCheckIn: d('2026-07-01'), hotelCheckOut: d('2026-07-04') }],
    });
    await expect(getHotelAvailability(QUERY, client)).resolves.toEqual({
      tier: 'LOW',
      nights: 3,
    });
  });

  it('最差一晚剩 4 → TIGHT（周期叠加 2+3，一行占一晚）', async () => {
    const client = fakeClient({
      periods: [
        { dateFrom: d('2026-07-01'), dateTo: d('2026-07-03'), rooms: 2 },
        { dateFrom: d('2026-07-01'), dateTo: d('2026-07-03'), rooms: 3 },
      ],
      items: [{ hotelCheckIn: d('2026-07-02'), hotelCheckOut: d('2026-07-03') }],
    });
    await expect(getHotelAvailability(QUERY, client)).resolves.toEqual({
      tier: 'TIGHT',
      nights: 3,
    });
  });

  it('全程无占房且包房充裕 → AMPLE', async () => {
    const client = fakeClient({
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-03'), rooms: 8 }],
    });
    await expect(getHotelAvailability(QUERY, client)).resolves.toEqual({
      tier: 'AMPLE',
      nights: 3,
    });
  });

  it('周期只盖部分夜晚 → 未覆盖夜 block=0 → SOLD_OUT', async () => {
    const client = fakeClient({
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-01'), rooms: 5 }],
    });
    await expect(getHotelAvailability(QUERY, client)).resolves.toEqual({
      tier: 'SOLD_OUT',
      nights: 3,
    });
  });

  it('响应只含 tier/nights（公开端点不暴露原始数字）', async () => {
    const client = fakeClient({
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-03'), rooms: 8 }],
    });
    const result = await getHotelAvailability(QUERY, client);
    expect(Object.keys(result).sort()).toEqual(['nights', 'tier']);
  });
});

describe('hotelAvailabilityQuerySchema', () => {
  it('合法查询通过', () => {
    expect(hotelAvailabilityQuerySchema.safeParse(QUERY).success).toBe(true);
  });

  it('checkIn >= checkOut 拒绝', () => {
    expect(
      hotelAvailabilityQuerySchema.safeParse({ ...QUERY, checkOut: '2026-07-01' }).success,
    ).toBe(false);
    expect(
      hotelAvailabilityQuerySchema.safeParse({ ...QUERY, checkOut: '2026-06-30' }).success,
    ).toBe(false);
  });

  it('30 晚封顶：30 晚过、31 晚拒', () => {
    expect(
      hotelAvailabilityQuerySchema.safeParse({ ...QUERY, checkOut: '2026-07-31' }).success,
    ).toBe(true);
    expect(
      hotelAvailabilityQuerySchema.safeParse({ ...QUERY, checkOut: '2026-08-01' }).success,
    ).toBe(false);
  });

  it('非法日期拒绝（格式错 / 不存在的日子）', () => {
    expect(
      hotelAvailabilityQuerySchema.safeParse({ ...QUERY, checkIn: '2026/07/01' }).success,
    ).toBe(false);
    expect(
      hotelAvailabilityQuerySchema.safeParse({ ...QUERY, checkIn: '2026-02-30' }).success,
    ).toBe(false);
  });
});
