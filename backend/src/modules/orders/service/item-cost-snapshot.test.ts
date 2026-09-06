/**
 * 订单行成本快照 · 单元测试（vitest）
 *
 * 这批数会直接变成经营报表与财务概览上的毛利，错了没人看得出来（数字照样是数字），
 * 所以每条「算不出来就留 NULL」的分支都得钉死 —— 一旦某条悄悄退化成 0，毛利就系统性虚高。
 *
 * 覆盖：
 *   · 机票行快照按 resolveFlightItemCost 落库，unitCostCny × quantity 与 total 对得上；
 *   · 套餐行按 items 组件求和（HOTEL×房×晚 / VISA×办签人数 / TRANSFER×qty），任一组件
 *     成本缺失 → 整行 NULL；FLIGHT 组件一律跳过（成本在同单的 FLIGHT 行上，加了就是双计）；
 *   · 换酒店时套餐行按住宿差额挪，算不出来转 NULL 而不是留着旧店的数。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/prisma.js', () => ({ prisma: {} }));

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  bundleHotelNightsOf,
  computeBundleGroundCost,
  computeSwapBundleCostSnapshot,
  flightSnapshotKey,
  loadBundleComponentCosts,
  resolveFlightCostSnapshots,
} from './item-cost-snapshot.js';

// ── 机票行 ────────────────────────────────────────────────────────────────

/** 一条班次：包机 180000 ÷ 180 座 = 每座 1000，另加机场税 50 + 燃油 30 = 每座 1080。 */
function schedule(over: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    flightId: 'flight-1',
    departureTime: new Date('2026-09-10T02:00:00Z'),
    departureTz: 'Asia/Macau',
    costLocked: false,
    charterCostCny: new Prisma.Decimal(180_000),
    airportTaxDepCny: new Prisma.Decimal(50),
    airportTaxArrCny: null,
    fuelCostCny: new Prisma.Decimal(30),
    peakSurchargeCny: null,
    aircraftAdjustCny: null,
    takeoffDiscountCny: null,
    seatClasses: [{ capacity: 180 }],
    ...over,
  };
}

function flightClient(schedules: unknown[], periods: unknown[] = []): PrismaClient {
  return {
    flightSchedule: { findMany: vi.fn().mockResolvedValue(schedules) },
    flightCostPeriod: { findMany: vi.fn().mockResolvedValue(periods) },
  } as unknown as PrismaClient;
}

describe('resolveFlightCostSnapshots — 机票行成本快照', () => {
  it('班次自身填了成本：每座成本 × 人数，unitCostCny × quantity 与 total 对得上', async () => {
    const map = await resolveFlightCostSnapshots(
      [{ flightScheduleId: 'sched-1', quantity: 2 }],
      flightClient([schedule()]),
    );
    const snap = map.get(flightSnapshotKey('sched-1', 2))!;
    expect(snap.totalCostCny).toBe(2160); // (180000/180 + 50 + 30) × 2
    expect(snap.unitCostCny).toBe(1080);
    expect(snap.unitCostCny! * 2).toBe(snap.totalCostCny);
  });

  it('班次没填、成本周期覆盖了出发日：按周期取值（override → period 的既有口径）', async () => {
    const bare = schedule({ charterCostCny: null, airportTaxDepCny: null, fuelCostCny: null });
    const periods = [
      {
        flightId: 'flight-1',
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
        effectiveTo: new Date('2026-09-30T00:00:00Z'),
        charterCostCny: new Prisma.Decimal(180_000),
        airportTaxDepCny: new Prisma.Decimal(50),
        airportTaxArrCny: null,
        fuelCostCny: new Prisma.Decimal(30),
        peakSurchargeCny: null,
        aircraftAdjustCny: null,
        takeoffDiscountCny: null,
      },
    ];
    const map = await resolveFlightCostSnapshots(
      [{ flightScheduleId: 'sched-1', quantity: 1 }],
      flightClient([bare], periods),
    );
    expect(map.get(flightSnapshotKey('sched-1', 1))!.totalCostCny).toBe(1080);
  });

  it('班次与周期都是空的：留 NULL，绝不落 0 让毛利虚高', async () => {
    const bare = schedule({
      charterCostCny: null,
      airportTaxDepCny: null,
      airportTaxArrCny: null,
      fuelCostCny: null,
      peakSurchargeCny: null,
      aircraftAdjustCny: null,
      takeoffDiscountCny: null,
    });
    const map = await resolveFlightCostSnapshots(
      [{ flightScheduleId: 'sched-1', quantity: 1 }],
      flightClient([bare]),
    );
    const snap = map.get(flightSnapshotKey('sched-1', 1))!;
    expect(snap.totalCostCny).toBeNull();
    expect(snap.unitCostCny).toBeNull();
  });

  it('同班次两条不同人数的腿：各自一份快照，不互相覆盖', async () => {
    const map = await resolveFlightCostSnapshots(
      [
        { flightScheduleId: 'sched-1', quantity: 2 },
        { flightScheduleId: 'sched-1', quantity: 3 },
      ],
      flightClient([schedule()]),
    );
    expect(map.get(flightSnapshotKey('sched-1', 2))!.totalCostCny).toBe(2160);
    expect(map.get(flightSnapshotKey('sched-1', 3))!.totalCostCny).toBe(3240);
  });

  it('班次不存在（脏 id）：不进 Map，调用方按缺成本处理', async () => {
    const map = await resolveFlightCostSnapshots(
      [{ flightScheduleId: 'ghost', quantity: 1 }],
      flightClient([]),
    );
    expect(map.size).toBe(0);
  });
});

// ── 套餐行 ────────────────────────────────────────────────────────────────

const VISA_COST = new Map([['visa-1', 200]]);
const TRANSFER_COST = new Map([['transfer-1', 300]]);

function groundCost(components: unknown, over: Record<string, unknown> = {}): number | null {
  return computeBundleGroundCost({
    components,
    hotelNightlyCostCny: 400,
    rooms: 1,
    visaHeadCount: 2,
    visaCostByIdCny: VISA_COST,
    transferCostByIdCny: TRANSFER_COST,
    ...over,
  });
}

describe('computeBundleGroundCost — 套餐行地面成本按组件求和', () => {
  it('房 + 签 + 车：各按自己的数量口径乘（晚×房 / 办签人数 / qty）', () => {
    const components = [
      { kind: 'HOTEL', qty: 4, unitPrice: 0 },
      { kind: 'VISA', qty: 1, unitPrice: 0, visaId: 'visa-1' },
      { kind: 'TRANSFER', qty: 2, unitPrice: 0, transferId: 'transfer-1' },
    ];
    // 4 晚 × 400 × 1 间 = 1600；2 位办签 × 200 = 400；2 趟 × 300 = 600。
    expect(groundCost(components)).toBe(2600);
  });

  it('半间房：住宿按 0.5 缩放（拼房口径与售价侧同一个 rooms）', () => {
    expect(groundCost([{ kind: 'HOTEL', qty: 4, unitPrice: 0 }], { rooms: 0.5 })).toBe(800);
  });

  it('全员自备签（办签人数 0）：签证那一项算 0，不是算不出来', () => {
    const components = [{ kind: 'VISA', qty: 1, unitPrice: 0, visaId: 'visa-1' }];
    expect(groundCost(components, { visaHeadCount: 0 })).toBe(0);
  });

  it('FLIGHT 组件一律跳过：机票成本在同单的 FLIGHT 行上，加在这里就是双计', () => {
    const withFlight = [
      { kind: 'FLIGHT', qty: 2, unitPrice: 0 },
      { kind: 'HOTEL', qty: 4, unitPrice: 0 },
    ];
    const withoutFlight = [{ kind: 'HOTEL', qty: 4, unitPrice: 0 }];
    expect(groundCost(withFlight)).toBe(groundCost(withoutFlight));
  });

  it('酒店没录成本价：整行 NULL（半个成本比没有成本更坏）', () => {
    const components = [
      { kind: 'HOTEL', qty: 4, unitPrice: 0 },
      { kind: 'VISA', qty: 1, unitPrice: 0, visaId: 'visa-1' },
    ];
    expect(groundCost(components, { hotelNightlyCostCny: null })).toBeNull();
  });

  it('签证产品没录成本价：整行 NULL，不把它当 0 悄悄放过', () => {
    expect(groundCost([{ kind: 'VISA', qty: 1, unitPrice: 0, visaId: 'visa-未录成本' }])).toBeNull();
  });

  it('组件没挂产品 id：整行 NULL（没有 id 就没有成本来源）', () => {
    expect(groundCost([{ kind: 'TRANSFER', qty: 1, unitPrice: 0 }])).toBeNull();
  });

  it('认不出的组件类型（未来新增品类）：整行 NULL，绝不静默当 0', () => {
    expect(groundCost([{ kind: 'INSURANCE', qty: 1, unitPrice: 0 }])).toBeNull();
  });

  it('items 是脏数据（非数组 / null 元素）：不抛错，按空处理', () => {
    expect(groundCost('这不是数组')).toBe(0);
    expect(groundCost([null, undefined])).toBe(0);
  });
});

describe('loadBundleComponentCosts — 只把录了成本价的产品收进表', () => {
  it('未录成本价（costPriceCny 为 NULL）的产品不进表 → 求和时该组件算不出来', async () => {
    const client = {
      visa: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'visa-1', costPriceCny: new Prisma.Decimal(200) },
          { id: 'visa-2', costPriceCny: null },
        ]),
      },
      transfer: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const costs = await loadBundleComponentCosts(
      [
        [
          { kind: 'VISA', visaId: 'visa-1' },
          { kind: 'VISA', visaId: 'visa-2' },
        ],
      ],
      client,
    );
    expect(costs.visaCostByIdCny.get('visa-1')).toBe(200);
    expect(costs.visaCostByIdCny.has('visa-2')).toBe(false);
  });

  it('没有签证 / 用车组件时不打库（省两条查询）', async () => {
    const client = {
      visa: { findMany: vi.fn() },
      transfer: { findMany: vi.fn() },
    } as unknown as PrismaClient;
    await loadBundleComponentCosts([[{ kind: 'HOTEL', qty: 3 }]], client);
    expect(client.visa.findMany).not.toHaveBeenCalled();
    expect(client.transfer.findMany).not.toHaveBeenCalled();
  });
});

// ── 换酒店：套餐行按住宿差额挪 ──────────────────────────────────────────────

describe('bundleHotelNightsOf', () => {
  it('取 HOTEL 组件的 qty 之和；没有 HOTEL 组件 = 0；脏数据不抛错', () => {
    expect(bundleHotelNightsOf([{ kind: 'HOTEL', qty: 4 }, { kind: 'VISA', qty: 1 }])).toBe(4);
    expect(bundleHotelNightsOf([{ kind: 'VISA', qty: 1 }])).toBe(0);
    expect(bundleHotelNightsOf(null)).toBe(0);
  });
});

describe('computeSwapBundleCostSnapshot — 换酒店后套餐行的成本', () => {
  const base = {
    beforeTotalCostCny: 2600,
    oldCostPriceCny: 400,
    newCostPriceCny: 500,
    nights: 4,
    rooms: 1,
  };

  it('换到更贵的店：只把住宿那一项的差额加上去，签证/用车那两项原样不动', () => {
    // 2600 + (500 − 400) × 4 晚 × 1 间 = 3000
    expect(computeSwapBundleCostSnapshot(base)).toBe(3000);
  });

  it('换到更便宜的店：差额是负的，成本降下来', () => {
    expect(computeSwapBundleCostSnapshot({ ...base, newCostPriceCny: 300 })).toBe(2200);
  });

  it('半间房：差额同样按 0.5 缩放', () => {
    expect(computeSwapBundleCostSnapshot({ ...base, rooms: 0.5 })).toBe(2800);
  });

  it('建单时就没算出整包成本：差额没有基数可加 → 保持 NULL', () => {
    expect(computeSwapBundleCostSnapshot({ ...base, beforeTotalCostCny: null })).toBeNull();
  });

  it('新房型没录成本价：转 NULL —— 换完之后是真不知道，不能留着旧店那个数', () => {
    expect(computeSwapBundleCostSnapshot({ ...base, newCostPriceCny: null })).toBeNull();
  });

  it('旧房型没录成本价（如随机档占位酒店）：减不出旧店那一项 → 转 NULL', () => {
    expect(computeSwapBundleCostSnapshot({ ...base, oldCostPriceCny: null })).toBeNull();
  });

  it('晚数为 0（套餐没有住宿组件）：差额无从谈起 → NULL', () => {
    expect(computeSwapBundleCostSnapshot({ ...base, nights: 0 })).toBeNull();
  });

  it('差额大到把整包成本冲成负数：夹到 0，不出现负成本', () => {
    expect(
      computeSwapBundleCostSnapshot({ ...base, newCostPriceCny: 0, beforeTotalCostCny: 100 }),
    ).toBe(0);
  });
});
