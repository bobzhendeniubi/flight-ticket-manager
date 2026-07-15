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
});
