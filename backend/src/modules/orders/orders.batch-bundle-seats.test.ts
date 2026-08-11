/**
 * P0-4 · 批量套餐单占座（后端收口）· 服务级单测（vitest，mock Prisma + spy createOrder，不依赖真 DB）
 *
 * 覆盖任务硬性要求（纯函数 + 优雅失败路径）：
 *   1. buildBatchItems BUNDLE：注入去/回程 FLIGHT 航段行（quantity=1、经济舱、打 bundleId）+ 地面 BUNDLE 行。
 *   2. addDaysToYmd：出发日 + 晚数 → 回程/退房日（含跨月），非法输入原样返回。
 *   3. batchCreateOrders BUNDLE 优雅失败（不阻断整批、逐单回报、createOrder 从不触发）：
 *        套餐未绑航班 / 缺出发日期 / 当日无班次。
 *   4. batchCreateOrders BUNDLE 成功路径：按套餐绑定航班 + 出发日期匹配当日班次，
 *        注入的 FLIGHT 行传入 createOrder（机票座位链路），房控盖章日期与机票出发日期同源。
 *
 * 真 DB 全链路扣座 / 卖穿逐单失败见 orders.batch-settlement.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    bundle: { findUnique: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, buildBatchItems, addDaysToYmd } from './orders.service.js';
import type { BatchCreateOrdersBody } from './orders.schemas.js';

const service = new OrderService();

function baseBundleBody(overrides: Partial<BatchCreateOrdersBody> = {}): BatchCreateOrdersBody {
  return {
    productType: 'BUNDLE',
    bundleId: 'bundle-1',
    description: '海岛 5 日套餐',
    passengers: [
      { fullName: 'WU FEI', documentNumber: 'EB9452866', dateOfBirth: '1983-09-20', nationality: 'CN' },
      { fullName: 'LI NA', documentNumber: 'EB1112223', dateOfBirth: '1990-02-10', nationality: 'CN' },
    ],
    ...overrides,
  } as unknown as BatchCreateOrdersBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ displayName: '运营A', email: 'op@x.io', phone: '-' });
});

// ── (1) buildBatchItems 纯函数：BUNDLE 航段注入 ─────────────────────────────
describe('buildBatchItems · BUNDLE 航段注入', () => {
  const body = baseBundleBody();

  it('往返（2 段）→ [FLIGHT(去程), FLIGHT(回程), BUNDLE]，机票行 quantity=1 / 经济舱 / 打 bundleId', () => {
    const items = buildBatchItems(body, 'BUNDLE', undefined, { goDate: '2026-09-15', returnDate: '2026-09-18' }, [
      { scheduleId: 'sch-go', label: '去程' },
      { scheduleId: 'sch-ret', label: '回程' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['FLIGHT', 'FLIGHT', 'BUNDLE']);
    const flights = items.filter(
      (i): i is Extract<(typeof items)[number], { kind: 'FLIGHT' }> => i.kind === 'FLIGHT',
    );
    expect(flights.map((f) => f.flightScheduleId)).toEqual(['sch-go', 'sch-ret']);
    for (const f of flights) {
      expect(f.quantity).toBe(1);
      expect(f.flightCabin).toBe('ECONOMY');
      expect(f.bundleId).toBe('bundle-1'); // 折扣按套餐 discountPct 应用到机票腿
    }
    // 地面 BUNDLE 行盖章日期来自 bundleDates（房控/销控计入套餐占房）
    const bundleRow = items.find(
      (i): i is Extract<(typeof items)[number], { kind: 'BUNDLE' }> => i.kind === 'BUNDLE',
    )!;
    expect(bundleRow.metadata).toMatchObject({ goDate: '2026-09-15', returnDate: '2026-09-18' });
  });

  it('单程（1 段）→ [FLIGHT(去程), BUNDLE]', () => {
    const items = buildBatchItems(body, 'BUNDLE', undefined, { goDate: '2026-09-15' }, [
      { scheduleId: 'sch-go', label: '去程' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['FLIGHT', 'BUNDLE']);
  });

  it('行级指定酒店 → 房型 id 只写入该乘客自己的 BUNDLE 行', () => {
    const items = buildBatchItems(
      body,
      'BUNDLE',
      undefined,
      { goDate: '2026-09-15' },
      [{ scheduleId: 'sch-go', label: '去程' }],
      {
        adultCount: 1,
        childCount: 0,
        infantCount: 0,
        designatedHotelRoomTypeId: 'room-type-designated',
      },
    );
    const bundleRow = items.find((item) => item.kind === 'BUNDLE') as Extract<
      (typeof items)[number],
      { kind: 'BUNDLE' }
    >;
    expect(bundleRow.designatedHotelRoomTypeId).toBe('room-type-designated');
  });

  it('无航段（解析失败兜底）→ 仅 [BUNDLE]（循环不会用它，逐单短路失败）', () => {
    const items = buildBatchItems(body, 'BUNDLE', undefined, {}, []);
    expect(items.map((i) => i.kind)).toEqual(['BUNDLE']);
  });

});

// ── (2) addDaysToYmd 纯函数 ────────────────────────────────────────────────
describe('addDaysToYmd', () => {
  it('出发日 + 晚数 → 回程/退房日', () => {
    expect(addDaysToYmd('2026-09-15', 3)).toBe('2026-09-18');
  });
  it('跨月进位正确', () => {
    expect(addDaysToYmd('2026-09-29', 3)).toBe('2026-10-02');
  });
  it('非法输入原样返回', () => {
    expect(addDaysToYmd('not-a-date', 3)).toBe('not-a-date');
  });
});

// ── (3) batchCreateOrders BUNDLE 优雅失败（逐单回报、createOrder 从不触发）──────
describe('batchCreateOrders · BUNDLE 优雅失败（不阻断整批、逐单失败原因明确）', () => {
  function spyCreateOrder(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(service as never, 'createOrder');
  }

  it('套餐未绑定航班 → 每单失败「套餐未绑定航班…」，createOrder 从不触发', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      defaultDepartDate: '2026-09-15',
      hotelNights: 3,
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 600 }],
      legs: 2,
      outboundFlightId: null,
      returnFlightId: null,
    });
    const createSpy = spyCreateOrder();

    const res = await service.batchCreateOrders(baseBundleBody(), { userId: 'u-admin', role: 'ADMIN' } as never);

    expect(res.successCount).toBe(0);
    expect(res.failureCount).toBe(2);
    expect(res.results.every((r) => !r.success && /套餐未绑定航班/.test(r.error ?? ''))).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
    // 未绑航班时不必查班次池
    expect(mockPrisma.flightSchedule.findMany).not.toHaveBeenCalled();
  });

  it('缺出发日期（弹窗未填 + 套餐无默认）→ 每单失败「套餐缺少出发日期…」', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      defaultDepartDate: null,
      hotelNights: 3,
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 600 }],
      legs: 2,
      outboundFlightId: 'flight-go',
      returnFlightId: 'flight-ret',
    });
    const createSpy = spyCreateOrder();

    const res = await service.batchCreateOrders(baseBundleBody(), { userId: 'u-admin', role: 'ADMIN' } as never);

    expect(res.successCount).toBe(0);
    expect(res.results.every((r) => /套餐缺少出发日期/.test(r.error ?? ''))).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('去程当日无班次 → 每单失败「没有匹配的去程班次」', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      defaultDepartDate: '2026-09-15',
      hotelNights: 3,
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 600 }],
      legs: 2,
      outboundFlightId: 'flight-go',
      returnFlightId: 'flight-ret',
    });
    // 班次池里没有本地出发日 == 2026-09-15 的班次
    mockPrisma.flightSchedule.findMany.mockResolvedValue([
      { id: 'sch-x', departureTime: new Date('2026-09-20T04:00:00Z'), departureTz: 'Asia/Macau' },
    ]);
    const createSpy = spyCreateOrder();

    const res = await service.batchCreateOrders(baseBundleBody(), { userId: 'u-admin', role: 'ADMIN' } as never);

    expect(res.successCount).toBe(0);
    expect(res.results.every((r) => /没有匹配的去程班次/.test(r.error ?? ''))).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ── (4) batchCreateOrders BUNDLE 成功路径：注入 FLIGHT 行 + 房控日期同源 ────────
describe('batchCreateOrders · BUNDLE 成功路径（航段注入 + 房控日期与机票同源）', () => {
  function configureOneWayBundle(businessUpgradeCnyPerLeg: number | null = null): void {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      defaultDepartDate: '2026-09-15',
      hotelNights: 3,
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 600 }],
      legs: 1,
      outboundFlightId: 'flight-go',
      returnFlightId: null,
      businessUpgradeCnyPerLeg,
    });
    mockPrisma.flightSchedule.findMany.mockResolvedValue([
      { id: 'sch-go', departureTime: new Date('2026-09-15T04:00:00Z'), departureTz: 'Asia/Macau' },
    ]);
  }

  it('弹窗出发日期匹配去/回程班次 → createOrder 收到去/回程 FLIGHT 行；房控 goDate == 机票去程本地日', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      defaultDepartDate: '2026-01-01', // 会被弹窗 bundleDepartDate 覆盖
      hotelNights: 3,
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 600 }],
      legs: 2,
      outboundFlightId: 'flight-go',
      returnFlightId: 'flight-ret',
    });
    // 去程航班池：本地出发日 2026-09-15 有一班；回程航班池：本地出发日 2026-09-18（15 + 3 晚）有一班。
    mockPrisma.flightSchedule.findMany.mockImplementation((args: { where: { flightId: string } }) => {
      if (args.where.flightId === 'flight-go') {
        return Promise.resolve([
          { id: 'sch-go', departureTime: new Date('2026-09-15T04:00:00Z'), departureTz: 'Asia/Macau' },
        ]);
      }
      return Promise.resolve([
        { id: 'sch-ret', departureTime: new Date('2026-09-18T04:00:00Z'), departureTz: 'Asia/Ho_Chi_Minh' },
      ]);
    });

    const captured: Array<{ items: unknown }> = [];
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { items: unknown }) => {
      captured.push({ items: body.items });
      return { id: `o-${captured.length}`, orderNumber: `N-${captured.length}` };
    }) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({ bundleDepartDate: '2026-09-15', bundleNights: 3 }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(0);
    expect(captured).toHaveLength(2);

    // 每张子单：去/回程 FLIGHT 行 + 地面 BUNDLE 行
    const items = captured[0].items as Array<Record<string, unknown>>;
    const flights = items.filter((i) => i.kind === 'FLIGHT');
    expect(flights.map((f) => f.flightScheduleId)).toEqual(['sch-go', 'sch-ret']);
    expect(flights.every((f) => f.quantity === 1 && f.flightCabin === 'ECONOMY' && f.bundleId === 'bundle-1')).toBe(
      true,
    );
    // 房控盖章日期与机票去程本地出发日同源（goDate = 弹窗出发日；returnDate = +3 晚）
    const bundleRow = items.find((i) => i.kind === 'BUNDLE') as { metadata?: Record<string, unknown> };
    expect(bundleRow.metadata).toMatchObject({ goDate: '2026-09-15', returnDate: '2026-09-18' });
  });

  it('逐行套餐选项 + 按出发日生日分类 → 只有第 2 张子单带单住/升舱及对应人数', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      defaultDepartDate: '2026-09-15',
      hotelNights: 3,
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 600 }],
      legs: 1,
      outboundFlightId: 'flight-go',
      returnFlightId: null,
    });
    mockPrisma.flightSchedule.findMany.mockResolvedValue([
      { id: 'sch-go', departureTime: new Date('2026-09-15T04:00:00Z'), departureTz: 'Asia/Macau' },
    ]);

    const captured: Array<{ items: unknown; passengers: unknown }> = [];
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { items: unknown; passengers: unknown }) => {
      captured.push({ items: body.items, passengers: body.passengers });
      return { id: `o-${captured.length}`, orderNumber: `N-${captured.length}` };
    }) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({
        bundleDepartDate: '2026-09-15',
        passengers: [
          { fullName: 'ADULT ONE', documentNumber: 'P001', dateOfBirth: '1990-01-01', nationality: 'CN' },
          {
            fullName: 'CHILD TWO',
            documentNumber: 'P002',
            dateOfBirth: '2016-09-15',
            nationality: 'CN',
            visaExempt: true,
            singleRoom: true,
            businessUpgrade: true,
          },
          { fullName: 'ADULT THREE', documentNumber: 'P003', dateOfBirth: '1980-09-15', nationality: 'CN' },
        ],
      }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res).toMatchObject({ successCount: 3, failureCount: 0 });
    expect(captured).toHaveLength(3);
    expect(captured.map(({ items }) => {
      const bundle = (items as Array<Record<string, unknown>>).find((item) => item.kind === 'BUNDLE')!;
      return {
        singleCount: bundle.singleCount,
        businessCount: bundle.businessCount,
        adultCount: bundle.adultCount,
        childCount: bundle.childCount,
        infantCount: bundle.infantCount,
      };
    })).toEqual([
      { singleCount: 0, businessCount: 0, adultCount: 1, childCount: 0, infantCount: 0 },
      { singleCount: 1, businessCount: 1, adultCount: 0, childCount: 1, infantCount: 0 },
      { singleCount: 0, businessCount: 0, adultCount: 1, childCount: 0, infantCount: 0 },
    ]);
    expect(captured.map(({ passengers }) => (passengers as Array<Record<string, unknown>>)[0])).toEqual([
      expect.not.objectContaining({ visaExempt: true, singleRoom: true }),
      expect.objectContaining({ visaExempt: true, singleRoom: true, businessUpgrade: true }),
      expect.not.objectContaining({ visaExempt: true, singleRoom: true }),
    ]);
  });

  it('行级指定酒店 → 只有对应子单的 BUNDLE 行带房型 id，交由既有定价/占房链路处理', async () => {
    configureOneWayBundle(null);
    const captured: Array<{ items: unknown }> = [];
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { items: unknown }) => {
      captured.push({ items: body.items });
      return { id: `o-${captured.length}`, orderNumber: `N-${captured.length}` };
    }) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({
        bundleDepartDate: '2026-09-15',
        passengers: [
          {
            fullName: 'ADULT ONE',
            documentNumber: 'P101',
            dateOfBirth: '1990-01-01',
            nationality: 'CN',
            designatedHotelRoomTypeId: 'room-type-designated',
          },
          {
            fullName: 'ADULT TWO',
            documentNumber: 'P102',
            dateOfBirth: '1990-01-01',
            nationality: 'CN',
          },
        ],
      }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res).toMatchObject({ successCount: 2, failureCount: 0 });
    const bundleRows = captured.map(({ items }) =>
      (items as Array<Record<string, unknown>>).find((item) => item.kind === 'BUNDLE')!,
    );
    expect(bundleRows[0].designatedHotelRoomTypeId).toBe('room-type-designated');
    expect(bundleRows[1].designatedHotelRoomTypeId).toBeUndefined();
  });

  it('套餐批量优惠 → 子单携带优惠调整行，日历收敛时由 createOrder 叠加处理', async () => {
    configureOneWayBundle(null);
    const captured: Array<{ priceAdjustment?: unknown }> = [];
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { priceAdjustment?: unknown }) => {
      captured.push({ priceAdjustment: body.priceAdjustment });
      return { id: `o-${captured.length}`, orderNumber: `N-${captured.length}` };
    }) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({
        agentId: 'agent-1',
        bundleDepartDate: '2026-09-15',
        discountPerPersonCny: 50,
        passengers: [{
          fullName: 'ADULT DISCOUNT',
          documentNumber: 'P103',
          dateOfBirth: '1990-01-01',
          nationality: 'CN',
        }],
      }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(captured[0].priceAdjustment).toEqual({
      amountCny: -50,
      reasonCode: 'DISCOUNT',
      reasonText: '同业优惠 ¥50/人×1',
      stackWithSettlementCalendar: true,
    });
  });

  it('套餐显式升舱费率为 0 + 行勾选升舱 → 该子单逐单失败且不建单', async () => {
    configureOneWayBundle(0);
    const createSpy = vi.spyOn(service as never, 'createOrder').mockImplementation((async () => ({
      id: 'should-not-create',
      orderNumber: 'should-not-create',
    })) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({
        bundleDepartDate: '2026-09-15',
        passengers: [{
          fullName: 'ADULT UPGRADE',
          documentNumber: 'P004',
          dateOfBirth: '1990-01-01',
          nationality: 'CN',
          businessUpgrade: true,
        }],
      }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(res.results[0].error).toContain('该套餐不提供升舱');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('婴儿单独成单 → 逐单失败并提示需与同行成人同单录入', async () => {
    configureOneWayBundle(null);
    const createSpy = vi.spyOn(service as never, 'createOrder').mockImplementation((async () => ({
      id: 'should-not-create',
      orderNumber: 'should-not-create',
    })) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({
        bundleDepartDate: '2026-09-15',
        passengers: [{
          fullName: 'INFANT PAX',
          documentNumber: 'P005',
          dateOfBirth: '2025-09-15',
          nationality: 'CN',
        }],
      }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(res.results[0].error).toContain('婴儿');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('儿童批量套餐子单 → passengerType 显式传 CHILD', async () => {
    configureOneWayBundle(null);
    const captured: Array<{ passengers: unknown }> = [];
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { passengers: unknown }) => {
      captured.push({ passengers: body.passengers });
      return { id: 'o-child', orderNumber: 'N-child' };
    }) as never);

    const res = await service.batchCreateOrders(
      baseBundleBody({
        bundleDepartDate: '2026-09-15',
        passengers: [{
          fullName: 'CHILD PAX',
          documentNumber: 'P006',
          dateOfBirth: '2016-09-15',
          nationality: 'CN',
        }],
      }),
      { userId: 'u-admin', role: 'ADMIN' } as never,
    );

    expect(res).toMatchObject({ successCount: 1, failureCount: 0 });
    expect((captured[0].passengers as Array<Record<string, unknown>>)[0].passengerType).toBe('CHILD');
  });
});
