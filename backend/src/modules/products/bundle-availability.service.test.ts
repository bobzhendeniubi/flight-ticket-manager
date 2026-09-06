/**
 * 套餐可售日期 getBundleSellableDates · 单元测试（vitest）
 *
 * 注入 fake PrismaClient（同 hotel-availability 测试风格），覆盖 5 个 reason 分支：
 *   1. BLACKOUT —— 出发日 ∈ blackoutDates → sellable=false reason='BLACKOUT'（优先级最高，不查库）
 *   2. NO_FLIGHT_BOUND —— 套餐没绑去/回程航班 → 派生不出航线 → 整段不可售（绝不兜底到写死航线）
 *   3. FLIGHT_SOLD_OUT —— 去/回任一段无座（capacity−sold−locked ≤ 0）或无班次 → reason='FLIGHT_SOLD_OUT'
 *   4. HOTEL_SOLD_OUT —— 整段最差一晚余量 ≤ 0 → reason='HOTEL_SOLD_OUT'
 *   5. sellable —— 机票+酒店都有位、非 blackout → sellable=true reason=null
 * + 航线派生：套餐绑哪条航线就查哪条航线的余位（第二条航线口径）。
 * + 当地日折算按班次自己的 departureTz（+9 凌晨班次归属次日当地日，不按固定 +8）。
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

interface FlightStub {
  originCode: string | null;
  destinationCode: string | null;
}

interface BundleStub {
  items?: unknown;
  blackoutDates?: unknown;
  hotelNights?: number | null;
  hotelRoomTypeId?: string | null;
  /** 套餐绑定的去/回程航班（航线由此派生）；两段都缺 = 没航线 = 不可售。 */
  outboundFlight?: FlightStub | null;
  returnFlight?: FlightStub | null;
}

/** 老航线（澳门→岘港）的绑定，供不关心航线的用例复用。 */
const LEGACY_BINDING = {
  outboundFlight: { originCode: 'MFM', destinationCode: 'DAD' },
  returnFlight: { originCode: 'DAD', destinationCode: 'MFM' },
} as const;

interface FakeOpts {
  bundle?: BundleStub | null;
  /** 该用例航线的起点（fake 据此判断某次查询是去程还是回程）；默认老航线 MFM。*/
  routeOrigin?: string;
  /** 去/回程班次（用 UTC 出发时间 + 该班次的 capacity / sold 表示余位）。*/
  schedules?: Array<{
    departureTime: Date;
    departureTz: string;
    capacity: number;
    sold: number;
    seatClassId: string;
    /** 'go' = 去程方向，'ret' = 回程方向；fake 据此模拟按航线过滤。*/
    dir: 'go' | 'ret';
  }>;
  /** ACTIVE 锁位（seatClassId → qty）。*/
  locks?: Array<{ seatClassId: string; qty: number }>;
  /** 生效中的占位余座（seatClassId → seats）。*/
  holds?: Array<{ seatClassId: string; seats: number }>;
  roomType?: { hotelId: string } | null;
  periods?: Array<{ dateFrom: Date; dateTo: Date; rooms: number }>;
  items?: Array<{ hotelCheckIn: Date; hotelCheckOut: Date }>;
}

/** fake 里记录下来的每次班次查询（供断言"查的是哪条航线"）。*/
interface ScheduleQuery {
  originCode: string;
  destinationCode: string;
  gte: Date;
  lt: Date;
}

/**
 * fake client。flightSchedule.findMany 同时按 where.departureTime 宽窗 + where.flight 航线过滤
 * （真 Prisma 也是这两个条件），服务内部再按每班自己的 departureTz 折当地日聚合。
 * 查询参数记录在 client.__scheduleQueries 上，供用例断言查的是哪条航线。
 */
function fakeClient(opts: FakeOpts = {}): PrismaClient & { __scheduleQueries: ScheduleQuery[] } {
  const schedules = opts.schedules ?? [];
  const scheduleQueries: ScheduleQuery[] = [];
  return {
    __scheduleQueries: scheduleQueries,
    bundle: {
      findUnique: vi.fn().mockResolvedValue(
        opts.bundle === undefined
          ? { items: [], blackoutDates: [], hotelNights: 4, hotelRoomTypeId: null, ...LEGACY_BINDING }
          : opts.bundle,
      ),
    },
    flightSchedule: {
      findMany: vi
        .fn()
        .mockImplementation(
          ({
            where,
          }: {
            where: {
              departureTime: { gte: Date; lt: Date };
              flight: { originCode: string; destinationCode: string };
            };
          }) => {
            const { gte, lt } = where.departureTime;
            scheduleQueries.push({
              originCode: where.flight.originCode,
              destinationCode: where.flight.destinationCode,
              gte,
              lt,
            });
            // 去程查询 origin=航线起点；回程查询方向相反 —— 用它区分该返回哪一批班次。
            const wantDir: 'go' | 'ret' =
              where.flight.originCode === (opts.routeOrigin ?? 'MFM') ? 'go' : 'ret';
            const hit = schedules.filter(
              (s) => s.dir === wantDir && s.departureTime >= gte && s.departureTime < lt,
            );
            return Promise.resolve(
              hit.map((s) => ({
                departureTime: s.departureTime,
                departureTz: s.departureTz,
                seatClasses: [{ id: s.seatClassId, capacity: s.capacity, sold: s.sold }],
              })),
            );
          },
        ),
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
 * 班次工厂：UTC 00:00 起飞，按 Asia/Macau(+8) 折即当地 08:00，稳稳归属 dateISO 当地日。
 * 方向按 seatClassId 前缀约定推断（'ret' 开头 = 回程，其余 = 去程）——本文件所有用例都按这个
 * 前缀命名；fake client 据此模拟 Prisma 的 flight.originCode/destinationCode 过滤。
 */
function sched(dateISO: string, seatClassId: string, capacity: number, sold: number) {
  return {
    departureTime: d(dateISO),
    departureTz: 'Asia/Macau',
    capacity,
    sold,
    seatClassId,
    dir: (seatClassId.startsWith('ret') ? 'ret' : 'go') as 'go' | 'ret',
  };
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
        ...LEGACY_BINDING,
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
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null, ...LEGACY_BINDING },
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
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null, ...LEGACY_BINDING },
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
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null, ...LEGACY_BINDING },
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
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: 'rt1', ...LEGACY_BINDING },
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
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: 'rt1', ...LEGACY_BINDING },
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
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: 'rt1', ...LEGACY_BINDING },
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
        items: [{ kind: 'FLIGHT', productName: '商务舱往返' }],
        blackoutDates: [],
        hotelNights: 2,
        hotelRoomTypeId: null,
        ...LEGACY_BINDING,
      },
      schedules,
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: true, reason: null });
  });

  // ── 航线派生（第二条航线口径：航线来自套餐绑定航班，不是全站写死常量）────────────
  it('套餐绑 KIX 航线 → 查的是 KIX 航线余位（去程 MFM→KIX / 回程 KIX→MFM）', async () => {
    const client = fakeClient({
      routeOrigin: 'MFM',
      bundle: {
        items: [],
        blackoutDates: [],
        hotelNights: 2,
        hotelRoomTypeId: null,
        outboundFlight: { originCode: 'MFM', destinationCode: 'KIX' },
        returnFlight: { originCode: 'KIX', destinationCode: 'MFM' },
      },
      schedules: [sched('2026-07-01', 'go0', 100, 0), sched('2026-07-03', 'ret0', 100, 0)],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: true, reason: null });
    // 两次查询：去程 MFM→KIX、回程 KIX→MFM；绝不是老航线 MFM→DAD
    expect(client.__scheduleQueries).toHaveLength(2);
    expect(client.__scheduleQueries[0]).toMatchObject({ originCode: 'MFM', destinationCode: 'KIX' });
    expect(client.__scheduleQueries[1]).toMatchObject({ originCode: 'KIX', destinationCode: 'MFM' });
  });

  it('只绑了回程 → 按回程反推去程方向航线（回程 KIX→MFM ⇒ 去程 MFM→KIX）', async () => {
    const client = fakeClient({
      routeOrigin: 'MFM',
      bundle: {
        items: [],
        blackoutDates: [],
        hotelNights: 2,
        hotelRoomTypeId: null,
        outboundFlight: null,
        returnFlight: { originCode: 'KIX', destinationCode: 'MFM' },
      },
      schedules: [sched('2026-07-01', 'go0', 100, 0), sched('2026-07-03', 'ret0', 100, 0)],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-01', client);
    expect(res[0]).toMatchObject({ sellable: true, reason: null });
    expect(client.__scheduleQueries[0]).toMatchObject({ originCode: 'MFM', destinationCode: 'KIX' });
  });

  it('NO_FLIGHT_BOUND：套餐没绑任何航班 → 全区间不可售，且一次班次库都不查（不兜底老航线）', async () => {
    const client = fakeClient({
      bundle: {
        items: [],
        blackoutDates: [],
        hotelNights: 2,
        hotelRoomTypeId: null,
        outboundFlight: null,
        returnFlight: null,
      },
      schedules: [sched('2026-07-01', 'go0', 100, 0), sched('2026-07-03', 'ret0', 100, 0)],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-03', client);
    expect(res).toHaveLength(3);
    for (const day of res) {
      expect(day).toMatchObject({
        sellable: false,
        reason: 'NO_FLIGHT_BOUND',
        flightTier: null,
        hotelTier: null,
      });
    }
    expect(client.__scheduleQueries).toHaveLength(0);
  });

  it('NO_FLIGHT_BOUND 之上 BLACKOUT 仍优先（封盘日报封盘，其余日报没绑航班）', async () => {
    const client = fakeClient({
      bundle: {
        items: [],
        blackoutDates: ['2026-07-02'],
        hotelNights: 2,
        hotelRoomTypeId: null,
        outboundFlight: null,
        returnFlight: null,
      },
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-02', client);
    expect(res.find((r) => r.dateISO === '2026-07-02')).toMatchObject({ reason: 'BLACKOUT' });
    expect(res.find((r) => r.dateISO === '2026-07-01')).toMatchObject({ reason: 'NO_FLIGHT_BOUND' });
  });

  // ── 当地日折算按班次自己的 departureTz（S2：不再固定 +8）──────────────────────
  it('+9 时区凌晨班次归属当地次日：UTC 07-01 22:00 在 Asia/Tokyo 是 07-02 07:00', async () => {
    // 去程只有这一班；按固定 +8 会折成 07-02 06:00 也是 07-02——故再放一班 UTC 07-01 16:30，
    // 它在 +9 是 07-02 01:30、在 +8 是 07-02 00:30，两者同日，无法区分。
    // 真正能区分的是 UTC 07-01 15:30：+9 = 07-02 00:30（次日），+8 = 07-01 23:30（当日）。
    const client = fakeClient({
      routeOrigin: 'MFM',
      bundle: {
        items: [],
        blackoutDates: [],
        hotelNights: 2,
        hotelRoomTypeId: null,
        outboundFlight: { originCode: 'MFM', destinationCode: 'KIX' },
        returnFlight: { originCode: 'KIX', destinationCode: 'MFM' },
      },
      schedules: [
        {
          departureTime: new Date('2026-07-01T15:30:00.000Z'),
          departureTz: 'Asia/Tokyo',
          capacity: 100,
          sold: 0,
          seatClassId: 'go0',
          dir: 'go',
        },
        {
          departureTime: new Date('2026-07-03T15:30:00.000Z'),
          departureTz: 'Asia/Tokyo',
          capacity: 100,
          sold: 0,
          seatClassId: 'ret0',
          dir: 'ret',
        },
      ],
    });
    const res = await getBundleSellableDates('b1', '2026-07-01', '2026-07-02', client);
    // 该班当地日 = 07-02（+9），不是 07-01（固定 +8 会算成 07-01 → 老口径会把可售日期错一天）
    expect(res.find((r) => r.dateISO === '2026-07-01')).toMatchObject({
      sellable: false,
      reason: 'FLIGHT_SOLD_OUT',
    });
    expect(res.find((r) => r.dateISO === '2026-07-02')).toMatchObject({
      sellable: true,
      reason: null,
    });
  });

  it('锁位吃掉余位 → FLIGHT_SOLD_OUT（capacity−sold−locked≤0）', async () => {
    const schedules = [sched('2026-07-01', 'go0', 10, 5), sched('2026-07-03', 'ret0', 100, 0)];
    const client = fakeClient({
      bundle: { items: [], blackoutDates: [], hotelNights: 2, hotelRoomTypeId: null, ...LEGACY_BINDING },
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
