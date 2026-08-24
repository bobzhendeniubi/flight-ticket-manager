/**
 * 套餐可售日期 getBundleSellableDates · 单元测试（vitest）
 *
 * 注入 fake PrismaClient（同 hotel-availability 测试风格），覆盖 4 个 reason 分支：
 *   1. BLACKOUT —— 出发日 ∈ blackoutDates → sellable=false reason='BLACKOUT'（优先级最高，不查库）
 *   2. FLIGHT_SOLD_OUT —— 去/回任一段无座（capacity−sold−locked ≤ 0）或无班次 → reason='FLIGHT_SOLD_OUT'
 *   3. HOTEL_SOLD_OUT —— 整段最差一晚余量 ≤ 0 → reason='HOTEL_SOLD_OUT'
 *   4. sellable —— 机票+酒店都有位、非 blackout → sellable=true reason=null
 * + 查询 schema 的跨度封顶（90 天）/ 默认窗口 / 倒序拒绝。
 * + 未配置房控（无包房周期）不拦截销售。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';
import { getBundleSellableDates } from './bundle-availability.service.js';
import { bundleSellableDatesQuerySchema } from './products.schemas.js';

const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

interface BundleStub {
  items?: unknown;
  blackoutDates?: unknown;
  hotelNights?: number | null;
  hotelRoomTypeId?: string | null;
}

interface FakeOpts {
  bundle?: BundleStub | null;
  /** 去/回程班次（用 UTC 出发时间 + 该班次的 capacity / sold 表示余位）。*/
  schedules?: Array<{ departureTime: Date; capacity: number; sold: number; seatClassId: string }>;
  /** ACTIVE 锁位（seatClassId → qty）。*/
  locks?: Array<{ seatClassId: string; qty: number }>;
  /** 生效中的占位余座（seatClassId → seats）。*/
  holds?: Array<{ seatClassId: string; seats: number }>;
  roomType?: { hotelId: string } | null;
  periods?: Array<{ dateFrom: Date; dateTo: Date; rooms: number }>;
  items?: Array<{ hotelCheckIn: Date; hotelCheckOut: Date }>;
}

/**
 * fake client。flightSchedule.findMany 按 where.departureTime 窗口过滤注入的 schedules，
 * 服务内部会用本地日（Asia/Shanghai）聚合各日余位。
 */
function fakeClient(opts: FakeOpts = {}): PrismaClient {
  const schedules = opts.schedules ?? [];
  return {
    bundle: {
      findUnique: vi.fn().mockResolvedValue(
        opts.bundle === undefined
          ? { items: [], blackoutDates: [], hotelNights: 4, hotelRoomTypeId: null }
          : opts.bundle,
      ),
    },
    flightSchedule: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }: { where: { departureTime: { gte: Date; lt: Date } } }) => {
          const { gte, lt } = where.departureTime;
          const inWindow = schedules.filter((s) => s.departureTime >= gte && s.departureTime < lt);
          return Promise.resolve(
            inWindow.map((s) => ({
              departureTime: s.departureTime,
              seatClasses: [{ id: s.seatClassId, capacity: s.capacity, sold: s.sold }],
            })),
          );
        }),
    },
    seatLock: {
      groupBy: vi.fn().mockResolvedValue(
        (opts.locks ?? []).map((l) => ({ seatClassId: l.seatClassId, _sum: { qty: l.qty } })),
      ),
    },
    holdOrder: {
      groupBy: vi.fn().mockResolvedValue(
        (opts.holds ?? []).map((h) => ({
          seatClassId: h.seatClassId,
          _sum: { seats: h.seats, seatsConverted: 0, seatsCancelled: 0 },
        })),
      ),
    },
    hotelRoomType: {
      findUnique: vi.fn().mockResolvedValue(opts.roomType ?? { hotelId: 'h1' }),
    },
    hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(opts.periods ?? []) },
    orderItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? []) },
  } as unknown as PrismaClient;
}

/**
 * 班次工厂：本地出发日 dateISO（Asia/Shanghai）当天 08:00 → UTC 00:00（落在该本地日窗口内）。
 * d('2026-07-01') = UTC 00:00 = Asia/Shanghai 08:00 当日，稳稳归属 2026-07-01 本地日。
 */
function sched(dateISO: string, seatClassId: string, capacity: number, sold: number) {
  return { departureTime: d(dateISO), capacity, sold, seatClassId };
}

describe('getBundleSellableDates', () => {
  it('套餐不存在 → NotFoundError', async () => {
    const client = fakeClient({ bundle: null });
    await expect(
      getBundleSellableDates('nope', '2026-07-01', '2026-07-03', client),
    ).rejects.toThrow(NotFoundError);
  });

  it('BLACKOUT 优先：封盘日 sellable=false reason=BLACKOUT（即便机票/酒店都有位）', async () => {
    // nights=2，去程 07-01/07-02/07-03，回程 07-03/07-04/07-05，全部充裕
    const goDays = ['2026-07-01', '2026-07-02', '2026-07-03'];
    const retDays = ['2026-07-03', '2026-07-04', '2026-07-05'];
    const schedules = [
      ...goDays.map((dt, i) => sched(dt, `go${i}`, 100, 0)),
      ...retDays.map((dt, i) => sched(dt, `ret${i}`, 100, 0)),
    ];
    const client = fakeClient({
      bundle: {
        items: [],
        blackoutDates: [{ date: '2026-07-02', reason: '春节封盘' }],
        hotelNights: 2,
        hotelRoomTypeId: null,
      },
      schedules,
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-03', client);
    expect(res.find((r) => r.dateISO === '2026-07-02')).toMatchObject({
      sellable: false,
      reason: 'BLACKOUT',
    });
    // 其他日仍可售
    expect(res.find((r) => r.dateISO === '2026-07-01')).toMatchObject({
      sellable: true,
      reason: null,
    });
  });

  it('FLIGHT_SOLD_OUT：去程当日售罄 → 不可售', async () => {
    // nights=2。去程 07-01 售罄（capacity=sold），其余有位；无房型（酒店不拦截）
    const schedules = [
      sched('2026-07-01', 'go0', 10, 10), // 售罄
      sched('2026-07-02', 'go1', 100, 0),
      sched('2026-07-03', 'ret0', 100, 0),
      sched('2026-07-04', 'ret1', 100, 0),
    ];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null },
      schedules,
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-02', client);
    expect(res.find((r) => r.dateISO === '2026-07-01')).toMatchObject({
      sellable: false,
      reason: 'FLIGHT_SOLD_OUT',
    });
    expect(res.find((r) => r.dateISO === '2026-07-02')).toMatchObject({
      sellable: true,
      reason: null,
    });
  });

  it('FLIGHT_SOLD_OUT：占位余座也会压缩套餐日期余量', async () => {
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null },
      schedules: [
        sched('2026-07-01', 'go0', 10, 0),
        sched('2026-07-03', 'ret0', 100, 0),
      ],
      holds: [{ seatClassId: 'go0', seats: 10 }],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: false, reason: 'FLIGHT_SOLD_OUT' });
  });

  it('FLIGHT_SOLD_OUT：某日无去程班次 → 不可售', async () => {
    // nights=2。去程只有 07-02，没有 07-01 班次；回程齐全
    const schedules = [
      sched('2026-07-02', 'go1', 100, 0),
      sched('2026-07-03', 'ret0', 100, 0),
      sched('2026-07-04', 'ret1', 100, 0),
    ];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null },
      schedules,
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-02', client);
    expect(res.find((r) => r.dateISO === '2026-07-01')).toMatchObject({
      sellable: false,
      reason: 'FLIGHT_SOLD_OUT',
    });
  });

  it('HOTEL_SOLD_OUT：机票有位但整段最差一晚余量≤0 → 不可售', async () => {
    // nights=2，出发日 07-01 → 住 07-01/07-02。block=1，07-02 两行占房 → 余量 -1
    const schedules = [sched('2026-07-01', 'go0', 100, 0), sched('2026-07-03', 'ret0', 100, 0)];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: 'rt1' },
      schedules,
      roomType: { hotelId: 'h1' },
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-05'), rooms: 1 }],
      items: [
        { hotelCheckIn: d('2026-07-02'), hotelCheckOut: d('2026-07-03') },
        { hotelCheckIn: d('2026-07-02'), hotelCheckOut: d('2026-07-03') },
      ],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: false, reason: 'HOTEL_SOLD_OUT' });
    expect(res[0].hotelTier).toBe('SOLD_OUT');
  });

  it('sellable：机票+酒店都有位、非 blackout → sellable=true reason=null', async () => {
    const schedules = [sched('2026-07-01', 'go0', 100, 0), sched('2026-07-03', 'ret0', 100, 0)];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: 'rt1' },
      schedules,
      roomType: { hotelId: 'h1' },
      periods: [{ dateFrom: d('2026-07-01'), dateTo: d('2026-07-05'), rooms: 20 }],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ dateISO: '2026-07-01', sellable: true, reason: null });
    expect(res[0].flightTier).toBe('AMPLE');
    expect(res[0].hotelTier).toBe('AMPLE');
  });

  it('未配置房控（无包房周期）→ 酒店不拦截，hotelTier=null，仍按机票判定', async () => {
    const schedules = [sched('2026-07-01', 'go0', 100, 0), sched('2026-07-03', 'ret0', 100, 0)];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: 'rt1' },
      schedules,
      roomType: { hotelId: 'h1' },
      periods: [], // 无包房周期
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: true, reason: null });
    expect(res[0].hotelTier).toBeNull();
  });

  it('商务舱套餐：cabin 解析为 BUSINESS（有位即可售）', async () => {
    const schedules = [sched('2026-07-01', 'go0', 50, 0), sched('2026-07-03', 'ret0', 50, 0)];
    const client = fakeClient({
      bundle: {
        items: [{ kind: 'FLIGHT', productName: '澳门⇌岘港 商务舱往返' }],
        blackoutDates: [],
        hotelNights: 2,
        hotelRoomTypeId: null,
      },
      schedules,
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: true, reason: null });
  });

  it('锁位吃掉余位 → FLIGHT_SOLD_OUT（capacity−sold−locked≤0）', async () => {
    const schedules = [sched('2026-07-01', 'go0', 10, 5), sched('2026-07-03', 'ret0', 100, 0)];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null },
      schedules,
      locks: [{ seatClassId: 'go0', qty: 5 }], // 10 - 5 - 5 = 0 → 售罄
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: false, reason: 'FLIGHT_SOLD_OUT' });
  });
});

describe('bundleSellableDatesQuerySchema', () => {
  it('合法：只给 from → to 默认 = from + 59 天（60 天窗口）', () => {
    const parsed = bundleSellableDatesQuerySchema.parse({ from: '2026-07-01' });
    expect(parsed.from).toBe('2026-07-01');
    expect(parsed.to).toBe('2026-08-29'); // 07-01 + 59 天
  });

  it('合法：from..to 在 90 天内通过（90 天含两端）', () => {
    expect(
      bundleSellableDatesQuerySchema.safeParse({ from: '2026-07-01', to: '2026-09-28' }).success,
    ).toBe(true);
  });

  it('拒绝：跨度 > 90 天（91 天）', () => {
    expect(
      bundleSellableDatesQuerySchema.safeParse({ from: '2026-07-01', to: '2026-09-29' }).success,
    ).toBe(false);
  });

  it('拒绝：from 晚于 to（倒序）', () => {
    expect(
      bundleSellableDatesQuerySchema.safeParse({ from: '2026-07-10', to: '2026-07-01' }).success,
    ).toBe(false);
  });

  it('拒绝：日期格式不合法（非 YYYY-MM-DD）', () => {
    // 注：与现有 dateOnlyStr 口径一致——只校验格式 + Date.parse 非 NaN；
    // JS Date.parse('2026-02-30') 会滚动到 03-02 不报错，故"日历不存在的日子"不在本层拦截。
    expect(bundleSellableDatesQuerySchema.safeParse({ from: '2026/07/01' }).success).toBe(false);
    expect(bundleSellableDatesQuerySchema.safeParse({ from: '20260701' }).success).toBe(false);
    expect(bundleSellableDatesQuerySchema.safeParse({ from: 'not-a-date' }).success).toBe(false);
  });
});
