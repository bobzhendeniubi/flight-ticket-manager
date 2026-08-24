/**
 * 六档余位档位 computeAvailabilityTier · 纯函数单测（vitest）
 *
 * 阈值口径（AVAILABILITY_TIER_THRESHOLDS，运营可能调整；比例相对 capacity，非绝对张数）：
 *   available ≤ 0                    → SOLD_OUT
 *   available ≤ ceil(capacity×5%)    → VERY_LOW（夹到 < capacity）
 *   available ≤ ceil(capacity×15%)   → LOW（夹到 < capacity）
 *   available ≤ ceil(capacity×40%)   → TIGHT（夹到 < capacity）
 *   否则                              → AMPLE
 * capacity 缺省 100——数值上与旧版绝对阈值（5/15/40）完全等价，供历史调用方零行为变更接入。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Prisma } from '@prisma/client';

// flights.service 顶层会实例化 PricingService 并引用 prisma —— 先 mock 掉。
// vi.mock 工厂会被 hoist 到文件顶部，故用 vi.hoisted 构造 prismaMock 供工厂与用例共用。
const prismaMock = vi.hoisted(() => {
  const mock: {
    flight: { findUnique: ReturnType<typeof vi.fn> };
    flightSchedule: {
      findUnique: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    flightSeatClass: { update: ReturnType<typeof vi.fn> };
    seatLock: { groupBy: ReturnType<typeof vi.fn> };
    holdOrder: { groupBy: ReturnType<typeof vi.fn> };
    flightBaggagePolicy: { findMany: ReturnType<typeof vi.fn> };
    auditLog: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  } = {
    flight: { findUnique: vi.fn() },
    flightSchedule: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    flightSeatClass: { update: vi.fn() },
    // 余位口径要减「他人 ACTIVE 未过期锁位」：lockedMapForSchedules 走 seatLock.groupBy
    seatLock: { groupBy: vi.fn() },
    holdOrder: { groupBy: vi.fn() },
    flightBaggagePolicy: { findMany: vi.fn() },
    // 改点路径会 best-effort 写审计（writeAudit → prisma.auditLog.create）；给个空 mock 免噪声
    auditLog: { create: vi.fn() },
    // $transaction(fn) 直接以同一个 mock 作为 tx 执行回调
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mock)),
  };
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../pricing/pricing.service.js', () => ({ PricingService: class {} }));

import {
  AVAILABILITY_TIER_THRESHOLDS,
  capPublicAvailable,
  computeAvailabilityTier,
  FlightService,
  serializeScheduleForAgent,
  toPublicPrice,
  toPublicSeatBreakdown,
  toPublicSeatClass,
} from './flights.service.js';

describe('computeAvailabilityTier · 缺省 capacity（向后兼容旧版绝对阈值）', () => {
  // 不传 capacity → 缺省 100，数值上与旧版绝对阈值（5/15/40）完全等价。
  // 覆盖尚未接入真实 capacity 的历史调用方（如 bundle-availability.service）。
  it('avail>40 → AMPLE', () => {
    expect(computeAvailabilityTier(41)).toBe('AMPLE');
    expect(computeAvailabilityTier(180)).toBe('AMPLE');
  });

  it('16-40 → TIGHT（含边界）', () => {
    expect(computeAvailabilityTier(40)).toBe('TIGHT');
    expect(computeAvailabilityTier(16)).toBe('TIGHT');
  });

  it('6-15 → LOW（含边界）', () => {
    expect(computeAvailabilityTier(15)).toBe('LOW');
    expect(computeAvailabilityTier(6)).toBe('LOW');
  });

  it('1-5 → VERY_LOW（含边界）', () => {
    expect(computeAvailabilityTier(5)).toBe('VERY_LOW');
    expect(computeAvailabilityTier(1)).toBe('VERY_LOW');
  });

  it('≤0 → SOLD_OUT', () => {
    expect(computeAvailabilityTier(0)).toBe('SOLD_OUT');
    expect(computeAvailabilityTier(-3)).toBe('SOLD_OUT');
  });

  it('阈值常量与档位边界一致，capacity=100（防止改比例常量漏改函数）', () => {
    const cap = 100;
    const veryLowCut = Math.ceil(cap * AVAILABILITY_TIER_THRESHOLDS.VERY_LOW_MAX_RATIO); // 5
    const lowCut = Math.ceil(cap * AVAILABILITY_TIER_THRESHOLDS.LOW_MAX_RATIO); // 15
    const tightCut = Math.ceil(cap * AVAILABILITY_TIER_THRESHOLDS.TIGHT_MAX_RATIO); // 40
    expect(computeAvailabilityTier(veryLowCut, cap)).toBe('VERY_LOW');
    expect(computeAvailabilityTier(veryLowCut + 1, cap)).toBe('LOW');
    expect(computeAvailabilityTier(lowCut, cap)).toBe('LOW');
    expect(computeAvailabilityTier(lowCut + 1, cap)).toBe('TIGHT');
    expect(computeAvailabilityTier(tightCut, cap)).toBe('TIGHT');
    expect(computeAvailabilityTier(tightCut + 1, cap)).toBe('AMPLE');
  });
});

// ── 容量相对档位：这是本次改造的核心——修掉"小舱位常年误标紧张"的 bug ──────
// 场景：业务方要把约 394 个班次的商务舱容量从 20 改到 7；改前改后，一个刚建好、
// 一张没卖的商务舱（无论 7 座还是 20 座）都必须是 AMPLE，不能因为绝对张数小就紧张。
describe('computeAvailabilityTier · 容量相对档位（真实 capacity）', () => {
  it('20 座舱位满仓（20/20）→ AMPLE（不再因绝对张数 <41 被误标紧张）', () => {
    expect(computeAvailabilityTier(20, 20)).toBe('AMPLE');
  });

  it('20 座舱位仅剩 2 张（2/20）→ VERY_LOW 或 LOW（占比 10%，明显紧张，但不是 AMPLE）', () => {
    const tier = computeAvailabilityTier(2, 20);
    expect(['VERY_LOW', 'LOW']).toContain(tier);
  });

  it('7 座舱位满仓（7/7，业务方目标容量）→ AMPLE', () => {
    expect(computeAvailabilityTier(7, 7)).toBe('AMPLE');
  });

  it('7 座舱位仅剩 1 张 → VERY_LOW', () => {
    expect(computeAvailabilityTier(1, 7)).toBe('VERY_LOW');
  });

  it('任意容量：available === capacity（满仓）恒为 AMPLE（含极小容量 1/1、2/2）', () => {
    expect(computeAvailabilityTier(1, 1)).toBe('AMPLE');
    expect(computeAvailabilityTier(2, 2)).toBe('AMPLE');
    expect(computeAvailabilityTier(200, 200)).toBe('AMPLE');
  });

  it('大容量经济舱（200 座）：178/200 剩余充足 → AMPLE；20/200 → VERY_LOW（占比 10%）', () => {
    expect(computeAvailabilityTier(178, 200)).toBe('AMPLE');
    expect(computeAvailabilityTier(20, 200)).toBe('LOW');
    expect(computeAvailabilityTier(9, 200)).toBe('VERY_LOW');
  });

  it('available ≤ 0 恒为 SOLD_OUT，与 capacity 无关', () => {
    expect(computeAvailabilityTier(0, 20)).toBe('SOLD_OUT');
    expect(computeAvailabilityTier(-3, 7)).toBe('SOLD_OUT');
    expect(computeAvailabilityTier(0, 200)).toBe('SOLD_OUT');
  });

  it('档位随 capacity 单调：同一 available，capacity 越小越容易落入紧张档', () => {
    // available=8：200 座里是 VERY_LOW 边缘充足；20 座里已经是 TIGHT
    expect(computeAvailabilityTier(8, 200)).toBe('VERY_LOW');
    expect(computeAvailabilityTier(8, 20)).toBe('TIGHT');
  });
});

// ── capPublicAvailable（公开口径余位封顶：防匿名爬取实时销量）────────────────
describe('capPublicAvailable · 公开口径余位封顶', () => {
  it('≤9 报真实值（含 0 与边界 9）', () => {
    expect(capPublicAvailable(0)).toBe(0);
    expect(capPublicAvailable(5)).toBe(5);
    expect(capPublicAvailable(9)).toBe(9);
  });

  it('>9 一律封顶报 9（不再暴露精确余量）', () => {
    expect(capPublicAvailable(10)).toBe(9);
    expect(capPublicAvailable(178)).toBe(9);
  });

  it('负数夹到 0（防御）', () => {
    expect(capPublicAvailable(-3)).toBe(0);
  });

  it('封顶不影响档位：档位仍按真实余量（相对真实 capacity）计算', () => {
    expect(computeAvailabilityTier(178, 200)).toBe('AMPLE');
    expect(capPublicAvailable(178)).toBe(9);
  });
});

// ── toPublicSeatBreakdown（公开 /flights/price 的 seatIndex 脱敏：防反推 sold）──────
// 回归用例：真实 sold=1 时，未脱敏的匿名 /flights/price?qty=1 会返回 seatIndex=2（=sold+1），
// 泄露 sold=1；脱敏后必须变成相对索引 1，不再能反推历史销量。
describe('toPublicSeatBreakdown · 公开口径 seatIndex 脱敏（防反推 sold）', () => {
  it('回归：sold=1 的单张查询，脱敏前 seatIndex=2（=sold+1）会暴露 sold，脱敏后必须是相对值 1', () => {
    const sold = 1;
    const raw = [{ seatIndex: sold + 1, bucket: 0, bucketMultiplier: 1, unitPrice: 1000 }];
    expect(raw[0].seatIndex).toBe(2); // 脱敏前：能直接反推 sold = seatIndex - 1 = 1
    const sanitized = toPublicSeatBreakdown(raw);
    expect(sanitized[0].seatIndex).toBe(1); // 脱敏后：相对索引，不含 sold 信息
  });

  it('qty=N 时重编号为连续的 1..N（不管原始绝对张数 sold+1..sold+N 是多少）', () => {
    const sold = 187; // 任意较大的历史销量
    const raw = Array.from({ length: 5 }, (_, i) => ({
      seatIndex: sold + 1 + i,
      bucket: 0,
      bucketMultiplier: 1,
      unitPrice: 1000,
    }));
    const sanitized = toPublicSeatBreakdown(raw);
    expect(sanitized.map((s) => s.seatIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it('不改变价格/档位字段，只重编号 seatIndex（价格展示不受影响）', () => {
    const raw = [
      { seatIndex: 51, bucket: 2, bucketMultiplier: 1, unitPrice: 1500 },
      { seatIndex: 52, bucket: 3, bucketMultiplier: 1, unitPrice: 1800 },
    ];
    const sanitized = toPublicSeatBreakdown(raw);
    expect(sanitized).toEqual([
      { seatIndex: 1, bucket: 2, bucketMultiplier: 1, unitPrice: 1500 },
      { seatIndex: 2, bucket: 3, bucketMultiplier: 1, unitPrice: 1800 },
    ]);
  });

  it('空数组（qty 校验层已挡下 <1，但函数本身也不应崩）→ 返回空数组', () => {
    expect(toPublicSeatBreakdown([])).toEqual([]);
  });

  it('不修改输入数组（不可变）', () => {
    const raw = [{ seatIndex: 42, bucket: 0, bucketMultiplier: 1, unitPrice: 1000 }];
    const sanitized = toPublicSeatBreakdown(raw);
    expect(raw[0].seatIndex).toBe(42); // 原数组未被就地修改
    expect(sanitized).not.toBe(raw);
    expect(sanitized[0]).not.toBe(raw[0]);
  });

  it('白名单是"选字段"而非"删字段"：计价项上的未知字段不透传', () => {
    const raw = [
      {
        seatIndex: 9,
        bucket: 0,
        bucketMultiplier: 1,
        unitPrice: 1000,
        futureInternalMarginField: 'internal',
      },
    ];
    const sanitized = toPublicSeatBreakdown(raw);
    expect(sanitized[0]).not.toHaveProperty('futureInternalMarginField');
    expect(Object.keys(sanitized[0]).sort()).toEqual([
      'bucket',
      'bucketMultiplier',
      'seatIndex',
      'unitPrice',
    ]);
  });
});

// ── toPublicPrice（公开 /flights/price 响应白名单：防内部日期等级泄露）────────────
// 回归：这条路由曾用 `{ ...pricing, currentBucketRemaining, perSeatBreakdown }` 展开 PriceResult，
// 只覆盖了两个字段——PriceResult 上的 dateRank（公司内部日期等级 A/B/C/D）与 dateMultiplier
// 就跟着展开原样发给了未鉴权的匿名调用方。改白名单后内部字段默认不透传。
describe('toPublicPrice · 公开 /flights/price 响应白名单', () => {
  const internalPriceResult = () => ({
    scheduleId: 'sched_1',
    cabin: 'ECONOMY' as const,
    qty: 2,
    pricingMode: 'AUTO' as const,
    basePrice: 1000,
    dateRank: 'A', // 内部日期等级——绝不对客户输出
    dateMultiplier: 1, // 恒为 1，对客户零信息量
    bucketSize: 0,
    totalBuckets: 1,
    currentBucket: 0,
    currentBucketRemaining: 178, // 精确档内剩余（内部真值）
    perSeatBreakdown: [
      { seatIndex: 3, bucket: 0, bucketMultiplier: 1, unitPrice: 1000 },
      { seatIndex: 4, bucket: 0, bucketMultiplier: 1, unitPrice: 1000 },
    ],
    totalPrice: 2000,
    averageUnitPrice: 1000,
  });

  it('回归：响应不含 dateRank（内部日期等级）与 dateMultiplier', () => {
    const pub = toPublicPrice(internalPriceResult());
    expect(pub).not.toHaveProperty('dateRank');
    expect(pub).not.toHaveProperty('dateMultiplier');
  });

  it('回归：整个响应序列化后不出现内部日期等级字面量（含嵌套）', () => {
    const serialized = JSON.stringify(toPublicPrice(internalPriceResult()));
    expect(serialized).not.toContain('dateRank');
    expect(serialized).not.toContain('dateMultiplier');
  });

  it('白名单是"选字段"而非"删字段"：PriceResult 上未来新增的内部字段一律不透传', () => {
    const pub = toPublicPrice({
      ...internalPriceResult(),
      futureInternalCostField: 12345,
    } as unknown as Parameters<typeof toPublicPrice>[0]);
    expect(pub).not.toHaveProperty('futureInternalCostField');
    expect(Object.keys(pub).sort()).toEqual([
      'averageUnitPrice',
      'basePrice',
      'bucketSize',
      'cabin',
      'currentBucket',
      'currentBucketRemaining',
      'perSeatBreakdown',
      'pricingMode',
      'qty',
      'scheduleId',
      'totalBuckets',
      'totalPrice',
    ]);
  });

  it('沿用既有公开脱敏：currentBucketRemaining 封顶 9、seatIndex 重编号为 1..qty', () => {
    const pub = toPublicPrice(internalPriceResult());
    expect(pub.currentBucketRemaining).toBe(9); // 真值 178 → 封顶 9
    expect(pub.perSeatBreakdown.map((s) => s.seatIndex)).toEqual([1, 2]); // 真值 3,4 → 相对索引
  });

  it('保留客户要看的计价字段（价格展示不受影响）', () => {
    const pub = toPublicPrice(internalPriceResult());
    expect(pub).toMatchObject({
      scheduleId: 'sched_1',
      cabin: 'ECONOMY',
      qty: 2,
      pricingMode: 'AUTO',
      basePrice: 1000,
      totalPrice: 2000,
      averageUnitPrice: 1000,
    });
  });
});

// ── toPublicSeatClass（公开 /flights/search 舱位白名单：防内部日期等级 / 精确余位泄露）──
// 回归：GET /flights/search 完全未鉴权（同文件其余端点都有 authenticate+requireRole），
// 曾用 `({ availExact: _a, ...pub })` 逐字段剥离——只摘掉了 availExact，内部对象上的
// dateRank/dateMultiplier 原样进了公开响应。改白名单后内部字段默认不透传。
describe('toPublicSeatClass · 公开 /flights/search 舱位白名单', () => {
  const internalSeat = () => ({
    availExact: 178, // 精确余位真值（hasSpace 过滤用）
    dateRank: 'A', // 内部日期等级——绝不对客户输出
    dateMultiplier: 1,
    seatClassId: 'sc_eco',
    cabin: 'ECONOMY' as const,
    available: 9, // 已封顶
    availabilityTier: 'AMPLE' as const,
    basePrice: '1000',
    dynamicPrice: '1000',
    totalForQty: 2000,
    baggage: { checkedKg: 20, checkedPieces: 1, carryOnKg: 7, note: null },
  });

  it('回归：公开舱位不含 dateRank / dateMultiplier / availExact', () => {
    const pub = toPublicSeatClass(internalSeat());
    expect(pub).not.toHaveProperty('dateRank');
    expect(pub).not.toHaveProperty('dateMultiplier');
    expect(pub).not.toHaveProperty('availExact');
  });

  it('公开舱位不含 capacity / sold / locked（精确销量口径）', () => {
    const pub = toPublicSeatClass({
      ...internalSeat(),
      capacity: 180,
      sold: 2,
      locked: 0,
    } as unknown as Parameters<typeof toPublicSeatClass>[0]);
    expect(pub).not.toHaveProperty('capacity');
    expect(pub).not.toHaveProperty('sold');
    expect(pub).not.toHaveProperty('locked');
  });

  it('白名单是"选字段"而非"删字段"：不认识的字段（含未来新增）一律不透传', () => {
    const pub = toPublicSeatClass({
      ...internalSeat(),
      futureInternalMarginField: 'internal',
    } as unknown as Parameters<typeof toPublicSeatClass>[0]);
    expect(pub).not.toHaveProperty('futureInternalMarginField');
    expect(Object.keys(pub).sort()).toEqual([
      'availabilityTier',
      'available',
      'baggage',
      'basePrice',
      'cabin',
      'dynamicPrice',
      'seatClassId',
      'totalForQty',
    ]);
  });

  it('保留客户要看的字段：锁位用的 seatClassId、封顶余位、档位、价格、行李额', () => {
    const pub = toPublicSeatClass(internalSeat());
    expect(pub).toEqual({
      seatClassId: 'sc_eco',
      cabin: 'ECONOMY',
      available: 9,
      availabilityTier: 'AMPLE',
      basePrice: '1000',
      dynamicPrice: '1000',
      totalForQty: 2000,
      baggage: { checkedKg: 20, checkedPieces: 1, carryOnKg: 7, note: null },
    });
  });

  it('行李额未配置 → null（不透传空对象）', () => {
    const pub = toPublicSeatClass({ ...internalSeat(), baggage: null });
    expect(pub.baggage).toBeNull();
  });

  it('行李额也走白名单：行李对象上的未知字段不透传', () => {
    const pub = toPublicSeatClass({
      ...internalSeat(),
      baggage: {
        checkedKg: 20,
        checkedPieces: 1,
        carryOnKg: 7,
        note: null,
        flightId: 'flight_1', // 内部关联字段
        internalCostCny: 88,
      },
    } as unknown as Parameters<typeof toPublicSeatClass>[0]);
    expect(pub.baggage).not.toHaveProperty('flightId');
    expect(pub.baggage).not.toHaveProperty('internalCostCny');
  });

  it('回归：整个舱位序列化后不出现内部日期等级字面量', () => {
    const serialized = JSON.stringify(toPublicSeatClass(internalSeat()));
    expect(serialized).not.toContain('dateRank');
    expect(serialized).not.toContain('dateMultiplier');
    expect(serialized).not.toContain('availExact');
  });

  it('批量映射（service 层 availableSeats.map(toPublicSeatClass) 的实际用法）', () => {
    const seats = [internalSeat(), { ...internalSeat(), seatClassId: 'sc_biz', cabin: 'BUSINESS' as const }];
    const pub = seats.map(toPublicSeatClass);
    expect(pub).toHaveLength(2);
    expect(pub[1]).toMatchObject({ seatClassId: 'sc_biz', cabin: 'BUSINESS' });
    pub.forEach((p) => expect(p).not.toHaveProperty('dateRank'));
  });
});

// ── serializeScheduleForAgent（AGENT 视角班次白名单：防成本字段泄露反推毛利）──────
// 回归：GET /flights/:id/schedules 曾用黑名单只删 charterCostCny/airportTaxDepCny/
// airportTaxArrCny 三项，漏了 FlightSchedule 上后补的 fuelCostCny/peakSurchargeCny/
// aircraftAdjustCny/takeoffDiscountCny 四个 per-passenger 成本字段——随响应下发给 AGENT。
// 改成白名单（只选 AGENT 需要的字段）后，任何现有或未来新增的成本字段都不会再漏出去。
describe('serializeScheduleForAgent · AGENT 视角班次白名单（防成本字段泄露）', () => {
  const decimal = (n: number) => ({ toString: () => String(n) }) as unknown as Prisma.Decimal;

  // 完整 listSchedules() 返回形：顶层 FlightSchedule 全字段（含 7 个成本字段）+
  // seatClasses 带 locked/available（另外塞一个未来可能新增的成本字段，验证白名单
  // 不依赖字段名单，而是不认识的字段一律不进白名单——不会因为漏改字段名而复发）。
  const fullSchedule = () => ({
    id: 'sched_1',
    flightId: 'flight_1',
    departureTime: new Date('2026-08-01T01:00:00.000Z'),
    arrivalTime: new Date('2026-08-01T04:00:00.000Z'),
    departureTz: 'Asia/Shanghai',
    arrivalTz: 'Asia/Macau',
    charterCostCny: decimal(80000),
    airportTaxDepCny: decimal(120),
    airportTaxArrCny: decimal(150),
    fuelCostCny: decimal(200),
    peakSurchargeCny: decimal(300),
    aircraftAdjustCny: decimal(-50),
    takeoffDiscountCny: decimal(-20),
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    // 未来新增的成本字段（假设名字完全不含 Cost/Surcharge/Adjust/Discount）——
    // 白名单靠"只挑需要的字段"而非"认字段名黑名单"，这类字段同样必须被挡掉。
    futureMysteryMarginField: decimal(999),
    seatClasses: [
      {
        id: 'sc_eco',
        scheduleId: 'sched_1',
        cabin: 'ECONOMY' as const,
        capacity: 200,
        sold: 30,
        basePrice: decimal(3000),
        fareBuckets: [{ quota: 20, price: 3200 }],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        locked: 5,
        available: 165,
      },
    ],
  });

  it('剥离全部 7 个已知成本字段（charter/机场税×2/燃油/高峰/机型调整/起降折扣）', () => {
    const result = serializeScheduleForAgent(fullSchedule());
    const keys = Object.keys(result);
    expect(keys).not.toContain('charterCostCny');
    expect(keys).not.toContain('airportTaxDepCny');
    expect(keys).not.toContain('airportTaxArrCny');
    expect(keys).not.toContain('fuelCostCny');
    expect(keys).not.toContain('peakSurchargeCny');
    expect(keys).not.toContain('aircraftAdjustCny');
    expect(keys).not.toContain('takeoffDiscountCny');
  });

  it('响应（含 seatClasses 内）不含任何 *CostCny/*SurchargeCny/*AdjustCny/*DiscountCny 字段', () => {
    const result = serializeScheduleForAgent(fullSchedule());
    const costFieldPattern = /CostCny$|SurchargeCny$|AdjustCny$|DiscountCny$/u;
    const topLevelKeys = Object.keys(result);
    expect(topLevelKeys.some((k) => costFieldPattern.test(k))).toBe(false);
    for (const seatClass of result.seatClasses) {
      const seatClassKeys = Object.keys(seatClass);
      expect(seatClassKeys.some((k) => costFieldPattern.test(k))).toBe(false);
    }
  });

  it('白名单是"选字段"而非"删字段"：不认识的字段（含未来新增）一律不透传', () => {
    const result = serializeScheduleForAgent(fullSchedule());
    expect(result).not.toHaveProperty('futureMysteryMarginField');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result.seatClasses[0]).not.toHaveProperty('scheduleId');
    expect(result.seatClasses[0]).not.toHaveProperty('createdAt');
    expect(result.seatClasses[0]).not.toHaveProperty('updatedAt');
  });

  it('保留 AGENT 批量创单需要的字段：航班/时刻/舱位/余位/售价类', () => {
    const result = serializeScheduleForAgent(fullSchedule());
    expect(result).toMatchObject({
      id: 'sched_1',
      flightId: 'flight_1',
      departureTz: 'Asia/Shanghai',
      arrivalTz: 'Asia/Macau',
      isActive: true,
    });
    expect(result.departureTime).toEqual(new Date('2026-08-01T01:00:00.000Z'));
    expect(result.arrivalTime).toEqual(new Date('2026-08-01T04:00:00.000Z'));
    expect(result.seatClasses).toHaveLength(1);
    // basePrice 用 toString() 比较（而非 toEqual 整个 seatClass）——decimal() 每次调用
    // 都新建一个带 toString 闭包的替身对象，toEqual 对函数属性按引用比较会误判不等。
    expect(result.seatClasses[0].basePrice.toString()).toBe('3000');
    expect(result.seatClasses[0]).toMatchObject({
      id: 'sc_eco',
      cabin: 'ECONOMY',
      capacity: 200,
      sold: 30,
      fareBuckets: [{ quota: 20, price: 3200 }],
      locked: 5,
      available: 165,
    });
  });

  it('多班次批量映射（route 层 schedules.map(serializeScheduleForAgent) 的实际用法）', () => {
    const schedules = [fullSchedule(), { ...fullSchedule(), id: 'sched_2', seatClasses: [] }];
    const result = schedules.map(serializeScheduleForAgent);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('sched_1');
    expect(result[1]).toMatchObject({ id: 'sched_2', seatClasses: [] });
    result.forEach((r) => expect(r).not.toHaveProperty('charterCostCny'));
  });
});

// ── updateSchedule（月历库存视图：改价 / 改容量 / 停用启用）─────────────────
// ── 管理端余位不夹 0：容量被压到已售之下时 available 为负 = 超售张数 ──────────
// 航司减配/换机型是真实场景（如 186 座机型而已售 195），座位统计/航班管理要据此
// 标红「超售 N」去协调。前台公开口径另走 capPublicAvailable，仍夹 0，不受影响。
describe('FlightService.listSchedules / listSchedulesInRange · 余位允许为负', () => {
  const service = new FlightService();
  const decimal = (n: number) => ({ toString: () => String(n) });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.seatLock.groupBy.mockResolvedValue([]); // 默认无锁位
    prismaMock.holdOrder.groupBy.mockResolvedValue([]); // 默认无占位
  });

  const seatClass = (over: Record<string, unknown> = {}) => ({
    id: 'sc_eco',
    cabin: 'ECONOMY',
    capacity: 186,
    sold: 195,
    basePrice: decimal(3000),
    fareBuckets: null,
    ...over,
  });

  it('listSchedules：容量 186 / 已售 195 → available = -9（不再夹到 0）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched_1', flightId: 'flight_1', seatClasses: [seatClass()] },
    ]);

    const [schedule] = await service.listSchedules('flight_1');

    expect(schedule.seatClasses[0]).toMatchObject({
      capacity: 186,
      sold: 195,
      locked: 0,
      available: -9,
    });
  });

  it('listSchedules：锁位照旧参与扣减（容量 10 / 已售 8 / 锁 5 → -3）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_1',
        flightId: 'flight_1',
        seatClasses: [seatClass({ id: 'sc_small', capacity: 10, sold: 8 })],
      },
    ]);
    prismaMock.seatLock.groupBy.mockResolvedValue([{ seatClassId: 'sc_small', _sum: { qty: 5 } }]);

    const [schedule] = await service.listSchedules('flight_1');

    expect(schedule.seatClasses[0]).toMatchObject({ locked: 5, available: -3 });
  });

  it('listSchedules：未超售的正常班次读数不变（回归：去 clamp 不影响正常路径）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_1',
        flightId: 'flight_1',
        seatClasses: [seatClass({ capacity: 186, sold: 30 })],
      },
    ]);

    const [schedule] = await service.listSchedules('flight_1');

    expect(schedule.seatClasses[0]).toMatchObject({ available: 156 });
  });

  it('listSchedules：admin 余位同时扣减 held，并返回 held 字段', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched_1', flightId: 'flight_1', seatClasses: [seatClass({ capacity: 100, sold: 10 })] },
    ]);
    prismaMock.holdOrder.groupBy.mockResolvedValue([
      { seatClassId: 'sc_eco', _sum: { seats: 25, seatsConverted: 3, seatsCancelled: 2 } },
    ]);

    const [schedule] = await service.listSchedules('flight_1');
    expect(schedule.seatClasses[0]).toMatchObject({ held: 20, available: 70 });
  });

  it('listSchedulesInRange：同口径不夹 0（座位统计页取数走这条）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_1',
        flightId: 'flight_1',
        flight: { flightNumber: 'XX123', originCode: 'MFM', destinationCode: 'PVG' },
        departureTime: new Date('2026-07-01T01:00:00.000Z'),
        departureTz: 'Asia/Macau',
        seatClasses: [seatClass()],
      },
    ]);

    const [schedule] = await service.listSchedulesInRange({});

    expect(schedule.seatClasses[0]).toMatchObject({
      capacity: 186,
      sold: 195,
      locked: 0,
      available: -9,
    });
  });
});

describe('FlightService.search · 公开搜索余位扣减 held', () => {
  const service = new FlightService();

  it('占位压缩后，搜索不会把不足人数的班次标为可售', async () => {
    const departureTime = new Date(Date.now() + 86400000);
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_search',
        flightId: 'flight_1',
        departureTime,
        arrivalTime: new Date(departureTime.getTime() + 3600000),
        departureTz: 'Asia/Shanghai',
        arrivalTz: 'Asia/Shanghai',
        flight: {
          flightNumber: 'XX123',
          originCode: 'MFM',
          destinationCode: 'DAD',
          aircraftType: null,
        },
        seatClasses: [{
          id: 'sc_search',
          cabin: 'ECONOMY',
          capacity: 10,
          sold: 0,
          basePrice: { toString: () => '1000' },
        }],
      },
    ]);
    prismaMock.seatLock.groupBy.mockResolvedValue([]);
    prismaMock.holdOrder.groupBy.mockResolvedValue([
      { seatClassId: 'sc_search', _sum: { seats: 9, seatsConverted: 0, seatsCancelled: 0 } },
    ]);
    prismaMock.flightBaggagePolicy.findMany.mockResolvedValue([]);

    const result = await service.search({ passengers: 2 });
    expect(result).toEqual([]);
  });
});

describe('FlightService.updateSchedule', () => {
  const service = new FlightService();

  // basePrice 在 DB 里是 Decimal；mock 用带 .toString() 的轻量替身即可
  const decimal = (n: number) => ({ toString: () => String(n) });

  const baseSchedule = () => ({
    id: 'sched_1',
    flightId: 'flight_1',
    departureTime: new Date('2026-07-01T01:00:00.000Z'),
    arrivalTime: new Date('2026-07-01T04:00:00.000Z'),
    departureTz: 'Asia/Shanghai',
    arrivalTz: 'Asia/Shanghai',
    isActive: true,
    seatClasses: [
      { id: 'sc_eco', cabin: 'ECONOMY', capacity: 200, sold: 30, basePrice: decimal(3000) },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.holdOrder.groupBy.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(prismaMock),
    );
  });

  it('改价持久化：写库用新价，返回同形（basePrice 为字符串、时间 ISO）', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());
    // 写库后再查一次：返回改价后的行
    const after = baseSchedule();
    after.seatClasses[0].basePrice = decimal(3500);
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    const result = await service.updateSchedule('sched_1', {
      seatClasses: [{ cabin: 'ECONOMY', basePrice: 3500 }],
    });

    // 用新价写到对应 seatClass
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_eco' },
      data: { basePrice: 3500 },
    });
    // 同 listSchedules 形：id/flightId/时间/时区/isActive/seatClasses[]
    expect(result).toMatchObject({
      id: 'sched_1',
      flightId: 'flight_1',
      departureTime: '2026-07-01T01:00:00.000Z',
      arrivalTime: '2026-07-01T04:00:00.000Z',
      departureTz: 'Asia/Shanghai',
      arrivalTz: 'Asia/Shanghai',
      isActive: true,
      seatClasses: [
        { id: 'sc_eco', cabin: 'ECONOMY', capacity: 200, sold: 30, basePrice: '3500' },
      ],
    });
  });

  // ── 超售录入：航司减配/换机型把真实容量压到已售之下，运营必须能录进来 ─────────
  // 销售侧不受影响（下单扣座是 sold+qty+locked+held ≤ capacity 的原子 CAS，只会更早拒卖）。
  // 上限内（默认 FLIGHT_MAX_OVERSELL_SEATS=5）：容量 26 < 已售 30 → 超售 4 座，放行。
  it('容量低于已售但超售在上限内：允许写库（账面超售），不再抛 400', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule()); // sold = 30
    const after = baseSchedule();
    after.seatClasses[0].capacity = 26;
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    const result = await service.updateSchedule('sched_1', {
      seatClasses: [{ cabin: 'ECONOMY', capacity: 26 }],
    });

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_eco' },
      data: { capacity: 26 },
    });
    // 容量 26 < 已售 30：账面欠 4 座（≤ 上限 5），返回体如实回报两个数字
    expect(result.seatClasses[0]).toMatchObject({ cabin: 'ECONOMY', capacity: 26, sold: 30 });
  });

  it('容量低于已售但超售在上限内：写一条 WARNING 审计（含超售张数），可追溯到人和时点', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule()); // capacity 200 / sold 30
    const after = baseSchedule();
    after.seatClasses[0].capacity = 26;
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    await service.updateSchedule(
      'sched_1',
      { seatClasses: [{ cabin: 'ECONOMY', capacity: 26 }] },
      { userId: 'u1', label: '运营账号' },
    );

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE_SCHEDULE_CAPACITY_OVERSOLD',
        severity: 'WARNING',
        actorUserId: 'u1',
        before: { seatClasses: [{ cabin: 'ECONOMY', capacity: 200, sold: 30, held: 0 }] },
        after: { seatClasses: [{ cabin: 'ECONOMY', capacity: 26, sold: 30, held: 0, oversoldBy: 4 }] },
      }),
    });
  });

  // ── 超售上限守卫（拍板：超售必须有上限，防止手滑，如把 186 敲成 18）─────────
  it('超售超过上限（默认 5）：拒绝写入（400），不落库、不写审计', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule()); // capacity 200 / sold 30

    await expect(
      service.updateSchedule('sched_1', {
        seatClasses: [{ cabin: 'ECONOMY', capacity: 20 }], // 超售 10 座 > 上限 5
      }),
    ).rejects.toThrow(/超过上限/);

    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('容量砍穿占位承诺时拒绝写入（有效占用 = sold + held）', async () => {
    const schedule = baseSchedule();
    schedule.seatClasses = [
      { id: 'sc_eco', cabin: 'ECONOMY', capacity: 100, sold: 0, basePrice: decimal(3000) },
    ];
    prismaMock.flightSchedule.findUnique.mockResolvedValue(schedule);
    prismaMock.holdOrder.groupBy.mockResolvedValue([
      { seatClassId: 'sc_eco', _sum: { seats: 90, seatsConverted: 0, seatsCancelled: 0 } },
    ]);

    await expect(
      service.updateSchedule('sched_1', { seatClasses: [{ cabin: 'ECONOMY', capacity: 1 }] }),
    ).rejects.toThrow(/超过上限/);
    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('容量不低于已售：不写超售审计（正常缩容不该噪声告警）', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule()); // sold = 30
    const after = baseSchedule();
    after.seatClasses[0].capacity = 30;
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    await service.updateSchedule('sched_1', {
      seatClasses: [{ cabin: 'ECONOMY', capacity: 30 }],
    });

    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  // ── 收缩守卫：容量可以下调，只要不低于已售（业务场景：商务舱 20→7）─────────
  it('商务舱容量 20→7、已售 0：允许缩容（收缩不因绝对张数小被误挡）', async () => {
    const schedule = baseSchedule();
    schedule.seatClasses = [
      { id: 'sc_biz', cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: decimal(9000) },
    ];
    prismaMock.flightSchedule.findUnique.mockResolvedValue(schedule);
    const after = { ...schedule, seatClasses: [{ ...schedule.seatClasses[0], capacity: 7 }] };
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    const result = await service.updateSchedule('sched_1', {
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_biz' },
      data: { capacity: 7 },
    });
    expect(result.seatClasses[0]).toMatchObject({ cabin: 'BUSINESS', capacity: 7 });
  });

  it('商务舱目标容量 7、已售 8：照改（超售 1 座），审计点名该舱位', async () => {
    const schedule = baseSchedule();
    schedule.seatClasses = [
      { id: 'sc_biz', cabin: 'BUSINESS', capacity: 20, sold: 8, basePrice: decimal(9000) },
    ];
    prismaMock.flightSchedule.findUnique.mockResolvedValue(schedule);
    const after = { ...schedule, seatClasses: [{ ...schedule.seatClasses[0], capacity: 7 }] };
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    const result = await service.updateSchedule('sched_1', {
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_biz' },
      data: { capacity: 7 },
    });
    expect(result.seatClasses[0]).toMatchObject({ cabin: 'BUSINESS', capacity: 7, sold: 8 });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE_SCHEDULE_CAPACITY_OVERSOLD',
        after: { seatClasses: [{ cabin: 'BUSINESS', capacity: 7, sold: 8, held: 0, oversoldBy: 1 }] },
      }),
    });
  });

  it('isActive 切换：把整班次 isActive 写为 false', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());
    const after = baseSchedule();
    after.isActive = false;
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    const result = await service.updateSchedule('sched_1', { isActive: false });

    expect(prismaMock.flightSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sched_1' },
      data: { isActive: false },
    });
    expect(result.isActive).toBe(false);
  });

  it('班次不存在：抛 404', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(null);
    await expect(
      service.updateSchedule('nope', { isActive: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('body 含该班次没有的舱等：抛 400', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule()); // 只有 ECONOMY
    await expect(
      service.updateSchedule('sched_1', {
        seatClasses: [{ cabin: 'BUSINESS', basePrice: 9000 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
  });
});

// ── createSchedule（一个航班号一天只能一班）─────────────────────────────
// 用出发地时区把 departureTime 折成本地日比较，避免 UTC 边界跨天误判。
describe('FlightService.createSchedule · 当天唯一班次', () => {
  const service = new FlightService();

  const createBody = (departureTime: string, arrivalTime: string) => ({
    flightId: 'flight_1',
    departureTime,
    arrivalTime,
    departureTz: 'Asia/Shanghai',
    arrivalTz: 'Asia/Shanghai',
    seatClasses: [{ cabin: 'ECONOMY' as const, capacity: 200, basePrice: 3000 }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.flight.findUnique.mockResolvedValue({ id: 'flight_1' });
    // 出发时间不撞（findFirst 为 null）；当天唯一性由 findMany 结果驱动
    prismaMock.flightSchedule.findFirst.mockResolvedValue(null);
    prismaMock.flightSchedule.create.mockResolvedValue({
      id: 'sched_new',
      flightId: 'flight_1',
      departureTime: new Date('2026-07-02T01:00:00.000Z'),
      arrivalTime: new Date('2026-07-02T04:00:00.000Z'),
      departureTz: 'Asia/Shanghai',
      arrivalTz: 'Asia/Shanghai',
      isActive: true,
      seatClasses: [],
    });
  });

  it('同航班号同一本地日已有班次 → 抛 400，不写库', async () => {
    // 已有班次本地日 = 2026-07-02（Asia/Shanghai）
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { departureTime: new Date('2026-07-02T02:00:00.000Z'), departureTz: 'Asia/Shanghai' },
    ]);
    // 新班次也落在 2026-07-02 本地日
    await expect(
      service.createSchedule(createBody('2026-07-02T09:00:00.000Z', '2026-07-02T12:00:00.000Z')),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: '该航班号当天已有班次，一个航班号一天只能一班',
    });
    expect(prismaMock.flightSchedule.create).not.toHaveBeenCalled();
  });

  it('同航班号但不同本地日 → 放行，写库', async () => {
    // 已有班次本地日 = 2026-07-02
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { departureTime: new Date('2026-07-02T02:00:00.000Z'), departureTz: 'Asia/Shanghai' },
    ]);
    // 新班次 2026-07-03 本地日（不同天）
    await expect(
      service.createSchedule(createBody('2026-07-03T09:00:00.000Z', '2026-07-03T12:00:00.000Z')),
    ).resolves.toMatchObject({ id: 'sched_new' });
    expect(prismaMock.flightSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('同一本地日但不同航班号 → 放行（findMany 只查本航班号，无冲突）', async () => {
    // 本航班号当天无班次（findMany 已按 flightId 过滤 → 空）
    prismaMock.flightSchedule.findMany.mockResolvedValue([]);
    await expect(
      service.createSchedule(createBody('2026-07-02T09:00:00.000Z', '2026-07-02T12:00:00.000Z')),
    ).resolves.toMatchObject({ id: 'sched_new' });
    // 查询限定本航班号
    expect(prismaMock.flightSchedule.findMany).toHaveBeenCalledWith({
      where: { flightId: 'flight_1' },
      select: { departureTime: true, departureTz: true },
    });
    expect(prismaMock.flightSchedule.create).toHaveBeenCalledTimes(1);
  });
});

// ── updateSchedule · 改点触发当天唯一班次校验 ───────────────────────────
// 编辑不能把本地出发日挪到同航班号已占用的那天（否则绕过 createSchedule 的唯一性）。
describe('FlightService.updateSchedule · 改点当天唯一性', () => {
  const service = new FlightService();
  const decimal = (n: number) => ({ toString: () => String(n) });

  // 现有班次本地出发日 = 2026-07-01（Asia/Shanghai）
  const baseSchedule = () => ({
    id: 'sched_1',
    flightId: 'flight_1',
    departureTime: new Date('2026-07-01T01:00:00.000Z'),
    arrivalTime: new Date('2026-07-01T04:00:00.000Z'),
    departureTz: 'Asia/Shanghai',
    arrivalTz: 'Asia/Shanghai',
    isActive: true,
    seatClasses: [
      { id: 'sc_eco', cabin: 'ECONOMY', capacity: 200, sold: 30, basePrice: decimal(3000) },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(prismaMock),
    );
  });

  it('改点把本地日挪到同航班号已占用的那天 → 抛 400，不写库', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());
    // 同航班号另有一班在 2026-07-05 本地日
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { departureTime: new Date('2026-07-05T02:00:00.000Z'), departureTz: 'Asia/Shanghai' },
    ]);

    await expect(
      service.updateSchedule('sched_1', {
        departureTime: '2026-07-05T09:00:00.000Z',
        arrivalTime: '2026-07-05T12:00:00.000Z',
        confirmSoldTimeChange: true, // fixture sold=30：先过 A11 已售确认闸，聚焦唯一性断言
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: '该航班号当天已有班次，一个航班号一天只能一班',
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.flightSchedule.update).not.toHaveBeenCalled();
    // 排除被编辑班次自己
    expect(prismaMock.flightSchedule.findMany).toHaveBeenCalledWith({
      where: { flightId: 'flight_1', id: { not: 'sched_1' } },
      select: { departureTime: true, departureTz: true },
    });
  });

  it('改点到无冲突的本地日 → 放行，写库', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());
    // 同航班号另一班在 2026-07-05，本次挪到 2026-07-06（不冲突）
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { departureTime: new Date('2026-07-05T02:00:00.000Z'), departureTz: 'Asia/Shanghai' },
    ]);
    const after = baseSchedule();
    after.departureTime = new Date('2026-07-06T09:00:00.000Z');
    after.arrivalTime = new Date('2026-07-06T12:00:00.000Z');
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    const result = await service.updateSchedule('sched_1', {
      departureTime: '2026-07-06T09:00:00.000Z',
      arrivalTime: '2026-07-06T12:00:00.000Z',
      confirmSoldTimeChange: true, // fixture sold=30：先过 A11 已售确认闸
    });
    expect(result.departureTime).toBe('2026-07-06T09:00:00.000Z');
    expect(prismaMock.flightSchedule.update).toHaveBeenCalled();
  });

  it('改点但本地日不变（仅调整当天时刻）→ 不触发唯一性查库，正常写库', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());
    const after = baseSchedule();
    after.departureTime = new Date('2026-07-01T06:00:00.000Z');
    after.arrivalTime = new Date('2026-07-01T09:00:00.000Z');
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    await service.updateSchedule('sched_1', {
      departureTime: '2026-07-01T06:00:00.000Z',
      arrivalTime: '2026-07-01T09:00:00.000Z',
      confirmSoldTimeChange: true, // fixture sold=30：先过 A11 已售确认闸
    });
    // 本地日未变（都是 2026-07-01）→ 不查同航班号当天班次
    expect(prismaMock.flightSchedule.findMany).not.toHaveBeenCalled();
    expect(prismaMock.flightSchedule.update).toHaveBeenCalled();
  });

  it('非时刻字段更新（改价，无 departureTime/arrivalTime）→ 不触发唯一性查库', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());
    const after = baseSchedule();
    after.seatClasses[0].basePrice = decimal(3500);
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    await service.updateSchedule('sched_1', {
      seatClasses: [{ cabin: 'ECONOMY', basePrice: 3500 }],
    });
    expect(prismaMock.flightSchedule.findMany).not.toHaveBeenCalled();
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalled();
  });

  // ── A11 已售班次改点闸（2026-07-17）：sold>0 改时刻必须显式确认 ──
  it('已售班次改时刻、未带确认标志 → 400 拦下（报文含已售座数），不写库', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule());

    await expect(
      service.updateSchedule('sched_1', {
        departureTime: '2026-07-01T06:00:00.000Z',
        arrivalTime: '2026-07-01T09:00:00.000Z',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('已售 30 座') });
    expect(prismaMock.flightSchedule.update).not.toHaveBeenCalled();
  });

  it('零已售班次改时刻 → 无需确认标志直接放行', async () => {
    const fresh = baseSchedule();
    fresh.seatClasses = [
      { id: 'sc_eco', cabin: 'ECONOMY', capacity: 200, sold: 0, basePrice: decimal(3000) },
    ];
    prismaMock.flightSchedule.findUnique.mockResolvedValue(fresh);
    const after = baseSchedule();
    after.departureTime = new Date('2026-07-01T06:00:00.000Z');
    after.arrivalTime = new Date('2026-07-01T09:00:00.000Z');
    prismaMock.flightSchedule.findUniqueOrThrow.mockResolvedValue(after);

    await service.updateSchedule('sched_1', {
      departureTime: '2026-07-01T06:00:00.000Z',
      arrivalTime: '2026-07-01T09:00:00.000Z',
    });
    expect(prismaMock.flightSchedule.update).toHaveBeenCalled();
  });
});

// ── deleteSchedule（有销售则禁删）─────────────────────────────────────
describe('FlightService.deleteSchedule', () => {
  const service = new FlightService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无销售（sold=0、无订单项、无生效锁位/候补）→ 硬删，返回 { deleted: true }', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [],
      seatClasses: [{ sold: 0 }, { sold: 0 }],
      seatLocks: [],
      seatWaitlists: [],
    });
    prismaMock.flightSchedule.delete.mockResolvedValue({ id: 'sched_1' });

    const result = await service.deleteSchedule('sched_1');

    expect(prismaMock.flightSchedule.delete).toHaveBeenCalledWith({ where: { id: 'sched_1' } });
    expect(result).toEqual({ id: 'sched_1', deleted: true });
  });

  it('某舱位已售 sold>0 → 抛 400「该班次已有销售，不能删除（请改用售罄）」且不删', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [],
      seatClasses: [{ sold: 0 }, { sold: 3 }], // 第二个舱位有销售
      seatLocks: [],
      seatWaitlists: [],
    });

    await expect(service.deleteSchedule('sched_1')).rejects.toMatchObject({
      statusCode: 400,
      message: '该班次已有销售，不能删除（请改用售罄）',
    });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });

  it('有订单项关联（即便 sold=0）→ 抛 400 且不删', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [{ id: 'oi_1' }],
      seatClasses: [{ sold: 0 }],
      seatLocks: [],
      seatWaitlists: [],
    });

    await expect(service.deleteSchedule('sched_1')).rejects.toMatchObject({
      statusCode: 400,
      message: '该班次已有销售，不能删除（请改用售罄）',
    });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });

  it('有生效中的锁位（即便无销售/无订单）→ 抛 400「该班次有生效中的锁位/候补，暂不能删除」且不删', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [],
      seatClasses: [{ sold: 0 }],
      seatLocks: [{ id: 'lock_1' }], // 生效中的锁位（findUnique 的 include 已按 status:ACTIVE 过滤）
      seatWaitlists: [],
    });

    await expect(service.deleteSchedule('sched_1')).rejects.toMatchObject({
      statusCode: 400,
      message: '该班次有生效中的锁位/候补，暂不能删除',
    });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });

  it('有生效中的候补（即便无销售/无订单）→ 抛 400「该班次有生效中的锁位/候补，暂不能删除」且不删', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [],
      seatClasses: [{ sold: 0 }],
      seatLocks: [],
      seatWaitlists: [{ id: 'wl_1' }], // 生效中的候补
    });

    await expect(service.deleteSchedule('sched_1')).rejects.toMatchObject({
      statusCode: 400,
      message: '该班次有生效中的锁位/候补，暂不能删除',
    });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });

  it('有生效中的占位单（即便无销售/无锁位/候补）→ 抛 400 且不删', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [],
      seatClasses: [{ sold: 0 }],
      seatLocks: [],
      seatWaitlists: [],
      holdOrders: [{ id: 'hold_1' }], // findUnique include 已按生效占位状态过滤
    });

    await expect(service.deleteSchedule('sched_1')).rejects.toMatchObject({
      statusCode: 400,
      message: '该班次有生效中的占位单，暂不能删除',
    });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });

  it('班次不存在：抛 404', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(null);
    await expect(service.deleteSchedule('nope')).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });
});

// ── batchDeleteSchedules（按出发日区间批量删；已售/有订单的跳过）───────────
// 复用单删同口径守卫：任一舱位 sold>0 或有订单项关联 → 跳过并回报，其余硬删。
// 区间筛选交给 prisma.findMany 的 where（这里 mock 其返回），故测试聚焦"分流 + 删除"逻辑。
describe('FlightService.batchDeleteSchedules', () => {
  const service = new FlightService();

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.holdOrder.groupBy.mockResolvedValue([]);
    // $transaction 的数组形态：直接 resolve 传入的 promise 数组（本方法只放一个 deleteMany）。
    prismaMock.$transaction.mockImplementation(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : ops,
    );
    prismaMock.flightSchedule.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('区间内：删无销售班次、跳过已售班次，返回 deleted 计数 + skipped 明细', async () => {
    // findMany 返回区间内命中的班次：sched_a 无销售、sched_b 有已售舱位、sched_c 无销售但有订单项
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_a',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }, { sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
      },
      {
        id: 'sched_b',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }, { sold: 5 }],
        seatLocks: [],
        seatWaitlists: [],
      },
      {
        id: 'sched_c',
        flightId: 'flight_1',
        orderItems: [{ id: 'oi_1' }],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
      },
    ]);

    const result = await service.batchDeleteSchedules({
      flightId: 'flight_1',
      from: '2026-07-01',
      to: '2026-07-31',
    });

    // 只删无销售且无订单项的 sched_a；sched_b（已售）、sched_c（有订单）跳过
    expect(prismaMock.flightSchedule.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['sched_a'] } },
    });
    expect(result).toEqual({
      deleted: 1,
      skipped: [
        { scheduleId: 'sched_b', reason: '已售' },
        { scheduleId: 'sched_c', reason: '已售' },
      ],
    });
  });

  it('区间内有生效中的锁位/候补（即便无销售/无订单）→ 跳过，不参与硬删', async () => {
    // sched_a 无销售但有生效锁位；sched_b 无销售但有生效候补；sched_c 完全干净可删
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_a',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }],
        seatLocks: [{ id: 'lock_1' }],
        seatWaitlists: [],
      },
      {
        id: 'sched_b',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [{ id: 'wl_1' }],
      },
      {
        id: 'sched_c',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
      },
    ]);

    const result = await service.batchDeleteSchedules({
      flightId: 'flight_1',
      from: '2026-07-01',
      to: '2026-07-31',
    });

    // 只删完全干净的 sched_c；sched_a（生效锁位）、sched_b（生效候补）跳过且不进 deleteMany
    expect(prismaMock.flightSchedule.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['sched_c'] } },
    });
    expect(result).toEqual({
      deleted: 1,
      skipped: [
        { scheduleId: 'sched_a', reason: '有生效中的锁位/候补' },
        { scheduleId: 'sched_b', reason: '有生效中的锁位/候补' },
      ],
    });
  });

  it('区间内有生效中的占位单 → skipped 新增占位原因，不参与硬删', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_hold',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
        holdOrders: [{ id: 'hold_1' }],
      },
    ]);

    const result = await service.batchDeleteSchedules({
      flightId: 'flight_1',
      from: '2026-07-01',
      to: '2026-07-31',
    });

    expect(prismaMock.flightSchedule.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      deleted: 0,
      skipped: [{ scheduleId: 'sched_hold', reason: '有生效中的占位单' }],
    });
  });

  it('按出发日区间 + flightId 过滤查库（不碰区间外/其他航班）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([]);

    await service.batchDeleteSchedules({
      flightId: 'flight_1',
      from: '2026-07-10',
      to: '2026-07-12',
    });

    // where 带 flightId + departureTime 区间（本地日 UTC+8 折 UTC：07-10 00:00 = UTC 07-09 16:00）
    const call = prismaMock.flightSchedule.findMany.mock.calls[0][0];
    expect(call.where.flightId).toBe('flight_1');
    expect(call.where.departureTime.gte).toEqual(new Date(Date.UTC(2026, 6, 10, -8, 0, 0)));
    expect(call.where.departureTime.lte).toEqual(
      new Date(Date.UTC(2026, 6, 12, -8, 0, 0) + 24 * 3600 * 1000 - 1),
    );
    // 无可删项 → 不触发删除
    expect(prismaMock.flightSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('省略 flightId：跨全部航班按区间筛选（where 不含 flightId）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_x',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
      },
      {
        id: 'sched_y',
        flightId: 'flight_2',
        orderItems: [],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
      },
    ]);

    const result = await service.batchDeleteSchedules({ from: '2026-08-01', to: '2026-08-31' });

    const call = prismaMock.flightSchedule.findMany.mock.calls[0][0];
    expect(call.where.flightId).toBeUndefined();
    // 两个都无销售 → 一次 deleteMany 删两条
    expect(prismaMock.flightSchedule.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['sched_x', 'sched_y'] } },
    });
    expect(result).toEqual({ deleted: 2, skipped: [] });
  });

  it('区间内全部已售：deleted=0、不调用 deleteMany、全部进 skipped', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_a',
        flightId: 'flight_1',
        orderItems: [],
        seatClasses: [{ sold: 3 }],
        seatLocks: [],
        seatWaitlists: [],
      },
      {
        id: 'sched_b',
        flightId: 'flight_1',
        orderItems: [{ id: 'oi_1' }],
        seatClasses: [{ sold: 0 }],
        seatLocks: [],
        seatWaitlists: [],
      },
    ]);

    const result = await service.batchDeleteSchedules({
      flightId: 'flight_1',
      from: '2026-07-01',
      to: '2026-07-31',
    });

    expect(prismaMock.flightSchedule.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      deleted: 0,
      skipped: [
        { scheduleId: 'sched_a', reason: '已售' },
        { scheduleId: 'sched_b', reason: '已售' },
      ],
    });
  });
});

// ── batchUpdateCapacity（按 scheduleId 列表批量改容量）───────────────────────
// 与 updateSchedule 同口径：容量可以压到已售之下，这类舱位照改并进 oversold 明细，
// 但超售张数超过上限（FLIGHT_MAX_OVERSELL_SEATS，默认 5）的班次整条进 skipped。
// 不存在的班次 / 没有该舱位都不算失败，只是不产生变更（前者进 skipped，后者对该班次
// 静默跳过这一项）。
describe('FlightService.batchUpdateCapacity', () => {
  const service = new FlightService();

  beforeEach(() => {
    vi.clearAllMocks();
    // $transaction 的数组形态：直接 resolve 传入的 promise 数组（与 batchDeleteSchedules 同口径）。
    prismaMock.$transaction.mockImplementation(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : ops,
    );
    prismaMock.flightSeatClass.update.mockResolvedValue({});
  });

  it('业务场景：把命中班次的商务舱容量从 20 改到 7（已售 0）→ 全部 applied', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_a',
        seatClasses: [
          { id: 'sc_a_biz', cabin: 'BUSINESS', capacity: 20, sold: 0 },
          { id: 'sc_a_eco', cabin: 'ECONOMY', capacity: 180, sold: 50 },
        ],
      },
      {
        id: 'sched_b',
        seatClasses: [{ id: 'sc_b_biz', cabin: 'BUSINESS', capacity: 20, sold: 0 }],
      },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_a', 'sched_b'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_a_biz' },
      data: { capacity: 7 },
    });
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_b_biz' },
      data: { capacity: 7 },
    });
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ applied: 2, skipped: [], oversold: [] });
  });

  it('已售超过目标容量的班次照改，在 oversold 里点名（航司减配的真实场景）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_ok',
        seatClasses: [{ id: 'sc_ok', cabin: 'BUSINESS', capacity: 20, sold: 0 }],
      },
      {
        id: 'sched_oversold',
        seatClasses: [{ id: 'sc_over', cabin: 'BUSINESS', capacity: 20, sold: 8 }],
      },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_ok', 'sched_oversold'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_ok' },
      data: { capacity: 7 },
    });
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_over' },
      data: { capacity: 7 },
    });
    expect(result).toEqual({
      applied: 2,
      skipped: [],
      oversold: [
        { scheduleId: 'sched_oversold', cabin: 'BUSINESS', sold: 8, held: 0, capacity: 7, oversoldBy: 1 },
      ],
    });
  });

  it('班次没有请求的舱位：该项静默跳过，不算失败（整条班次没有可改项则进 skipped）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 'sched_noeco',
        // 只有经济舱，没有商务舱
        seatClasses: [{ id: 'sc_eco', cabin: 'ECONOMY', capacity: 180, sold: 10 }],
      },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_noeco'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    // 该班次没有商务舱 → 这一项静默跳过；没有任何可改项 → 整个班次进 skipped
    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      applied: 0,
      skipped: [{ scheduleId: 'sched_noeco', reason: '该班次没有匹配的舱位' }],
      oversold: [],
    });
  });

  it('scheduleId 查无此班次：跳过并回报原因，不影响其它班次', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched_real', seatClasses: [{ id: 'sc_real', cabin: 'BUSINESS', capacity: 20, sold: 0 }] },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_real', 'sched_ghost'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(result).toEqual({
      applied: 1,
      skipped: [{ scheduleId: 'sched_ghost', reason: '班次不存在' }],
      oversold: [],
    });
  });

  it('整批都超售但都在上限内：全部照改，oversold 逐条列出欠几座（运营据此逐班协调）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched_a', seatClasses: [{ id: 'sc_a', cabin: 'BUSINESS', capacity: 20, sold: 12 }] },
      { id: 'sched_b', seatClasses: [{ id: 'sc_b', cabin: 'BUSINESS', capacity: 20, sold: 10 }] },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_a', 'sched_b'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      applied: 2,
      skipped: [],
      oversold: [
        { scheduleId: 'sched_a', cabin: 'BUSINESS', sold: 12, held: 0, capacity: 7, oversoldBy: 5 },
        { scheduleId: 'sched_b', cabin: 'BUSINESS', sold: 10, held: 0, capacity: 7, oversoldBy: 3 },
      ],
    });
  });

  // ── 超售上限守卫（批量路径）：超限班次进 skipped，不拖累批次里其它班次 ─────────
  it('超售超过上限（默认 5）的班次进 skipped 带原因，不整批失败（其它班次照常应用）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      // 超售 8 座 > 上限 5 → 整条不改，进 skipped
      { id: 'sched_over', seatClasses: [{ id: 'sc_over', cabin: 'BUSINESS', capacity: 20, sold: 15 }] },
      // 超售 3 座 ≤ 上限 5 → 照常应用
      { id: 'sched_ok', seatClasses: [{ id: 'sc_ok', cabin: 'BUSINESS', capacity: 20, sold: 10 }] },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_over', 'sched_ok'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    // 只有未超限的那条真正落库
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_ok' },
      data: { capacity: 7 },
    });
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([
      {
        scheduleId: 'sched_over',
        reason: expect.stringContaining('超过上限'),
      },
    ]);
    expect(result.oversold).toEqual([
      { scheduleId: 'sched_ok', cabin: 'BUSINESS', sold: 10, held: 0, capacity: 7, oversoldBy: 3 },
    ]);
  });

  it('批量容量砍穿占位承诺 → 按 sold + held 超限分流到 skipped', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched_hold', seatClasses: [{ id: 'sc_hold', cabin: 'BUSINESS', capacity: 100, sold: 0 }] },
    ]);
    prismaMock.holdOrder.groupBy.mockResolvedValue([
      { seatClassId: 'sc_hold', _sum: { seats: 90, seatsConverted: 0, seatsCancelled: 0 } },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_hold'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 1 }],
    });

    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([
      { scheduleId: 'sched_hold', reason: expect.stringContaining('超过上限') },
    ]);
    expect(result.oversold).toEqual([]);
  });
});

// ── batchUpdateScheduleTimes（按 scheduleId 列表批量改时刻·航司整段改点）─────
// 口径要害：运营填的是**当地钟点**，各班次按自己的 departureTz/arrivalTz 折回 UTC，
// 当地出发日保持不变。已售班次要过二次确认闸（与单班次 updateSchedule 同一道）。
describe('FlightService.batchUpdateScheduleTimes', () => {
  const service = new FlightService();

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : ops,
    );
    prismaMock.flightSchedule.update.mockResolvedValue({});
  });

  /** 澳门 +8 的班次：当地 08:00 起飞（= 00:00Z），未售。 */
  const macauSchedule = (id: string, localDay: string) => ({
    id,
    departureTime: new Date(`${localDay}T00:00:00.000Z`),
    arrivalTime: new Date(`${localDay}T01:00:00.000Z`),
    departureTz: 'Asia/Macau',
    arrivalTz: 'Asia/Macau',
    seatClasses: [{ sold: 0 }],
  });

  it('业务场景：一批澳门班次统一改成当地 16:40 起飞 / 17:35 到达 → 各自当地日不变', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      macauSchedule('s1', '2026-08-05'),
      macauSchedule('s2', '2026-08-06'),
    ]);

    const result = await service.batchUpdateScheduleTimes({
      scheduleIds: ['s1', 's2'],
      departureLocalTime: '16:40',
      arrivalLocalTime: '17:35',
      arrivalNextDay: false,
    });

    expect(result.applied).toBe(2);
    expect(result.skipped).toEqual([]);
    // 澳门当地 16:40 = 08:40Z（少 8 小时）——这正是运营看到的那个时刻
    expect(prismaMock.flightSchedule.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        departureTime: new Date('2026-08-05T08:40:00.000Z'),
        arrivalTime: new Date('2026-08-05T09:35:00.000Z'),
      },
    });
    expect(prismaMock.flightSchedule.update).toHaveBeenCalledWith({
      where: { id: 's2' },
      data: {
        departureTime: new Date('2026-08-06T08:40:00.000Z'),
        arrivalTime: new Date('2026-08-06T09:35:00.000Z'),
      },
    });
  });

  it('跨时区航段：出发按 departureTz、到达按 arrivalTz 各折各的', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 's_mfm_dad',
        departureTime: new Date('2026-08-05T00:00:00.000Z'),
        arrivalTime: new Date('2026-08-05T01:00:00.000Z'),
        departureTz: 'Asia/Macau', // +8
        arrivalTz: 'Asia/Ho_Chi_Minh', // +7
        seatClasses: [{ sold: 0 }],
      },
    ]);

    await service.batchUpdateScheduleTimes({
      scheduleIds: ['s_mfm_dad'],
      departureLocalTime: '16:40',
      arrivalLocalTime: '17:35',
      arrivalNextDay: false,
    });

    expect(prismaMock.flightSchedule.update).toHaveBeenCalledWith({
      where: { id: 's_mfm_dad' },
      data: {
        departureTime: new Date('2026-08-05T08:40:00.000Z'), // 澳门 16:40
        arrivalTime: new Date('2026-08-05T10:35:00.000Z'), // 岘港 17:35
      },
    });
  });

  it('勾选「到达次日」：到达日 = 出发当地日 + 1（跨零点红眼航班）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([macauSchedule('s1', '2026-08-05')]);

    await service.batchUpdateScheduleTimes({
      scheduleIds: ['s1'],
      departureLocalTime: '23:30',
      arrivalLocalTime: '00:35',
      arrivalNextDay: true,
    });

    expect(prismaMock.flightSchedule.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: {
        departureTime: new Date('2026-08-05T15:30:00.000Z'), // 澳门 8/5 23:30
        arrivalTime: new Date('2026-08-05T16:35:00.000Z'), // 澳门 8/6 00:35
      },
    });
  });

  it('到达不晚于出发（忘了勾「到达次日」）→ 该班次跳过，不拖累其它班次', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      macauSchedule('s_bad', '2026-08-05'),
      macauSchedule('s_ok', '2026-08-06'),
    ]);

    const result = await service.batchUpdateScheduleTimes({
      scheduleIds: ['s_bad', 's_ok'],
      departureLocalTime: '23:30',
      arrivalLocalTime: '00:35',
      arrivalNextDay: false,
    });

    // 两条都算不出合法时刻 → 都跳过，一次 update 都不发
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain('到达次日');
    expect(prismaMock.flightSchedule.update).not.toHaveBeenCalled();
  });

  it('已售班次没带确认标志 → 整批拒绝并回报影响面，一条都不写', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { ...macauSchedule('s_sold', '2026-08-05'), seatClasses: [{ sold: 12 }, { sold: 3 }] },
      macauSchedule('s_free', '2026-08-06'),
    ]);

    await expect(
      service.batchUpdateScheduleTimes({
        scheduleIds: ['s_sold', 's_free'],
        departureLocalTime: '16:40',
        arrivalLocalTime: '17:35',
        arrivalNextDay: false,
      }),
    ).rejects.toThrow(/1 个班次已售共 15 座/);
    expect(prismaMock.flightSchedule.update).not.toHaveBeenCalled();
  });

  it('带上确认标志 → 已售班次照改，影响面在返回体里点名', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { ...macauSchedule('s_sold', '2026-08-05'), seatClasses: [{ sold: 12 }] },
    ]);

    const result = await service.batchUpdateScheduleTimes({
      scheduleIds: ['s_sold'],
      departureLocalTime: '16:40',
      arrivalLocalTime: '17:35',
      arrivalNextDay: false,
      confirmSoldTimeChange: true,
    });

    expect(result).toEqual({ applied: 1, skipped: [], soldSchedules: 1, soldSeats: 12 });
    expect(prismaMock.flightSchedule.update).toHaveBeenCalledTimes(1);
  });

  it('时刻与现值相同的班次跳过（不空写、不触发已售闸）', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      {
        id: 's_same',
        departureTime: new Date('2026-08-05T08:40:00.000Z'), // 澳门 16:40
        arrivalTime: new Date('2026-08-05T09:35:00.000Z'), // 澳门 17:35
        departureTz: 'Asia/Macau',
        arrivalTz: 'Asia/Macau',
        seatClasses: [{ sold: 30 }], // 已售但时刻没变 → 不该被闸拦
      },
    ]);

    const result = await service.batchUpdateScheduleTimes({
      scheduleIds: ['s_same'],
      departureLocalTime: '16:40',
      arrivalLocalTime: '17:35',
      arrivalNextDay: false,
    });

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('与现值相同');
    expect(prismaMock.flightSchedule.update).not.toHaveBeenCalled();
  });

  it('scheduleId 查无此班次 → 记入 skipped，不算失败', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([macauSchedule('s1', '2026-08-05')]);

    const result = await service.batchUpdateScheduleTimes({
      scheduleIds: ['s1', 's_gone'],
      departureLocalTime: '16:40',
      arrivalLocalTime: '17:35',
      arrivalNextDay: false,
    });

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([{ scheduleId: 's_gone', reason: '班次不存在' }]);
  });
});
