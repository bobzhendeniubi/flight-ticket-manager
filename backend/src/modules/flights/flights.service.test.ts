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
  sanitizePublicSeatBreakdown,
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

// ── sanitizePublicSeatBreakdown（公开 /flights/price 的 seatIndex 脱敏：防反推 sold）──────
// 回归用例：真实 sold=1 时，未脱敏的匿名 /flights/price?qty=1 会返回 seatIndex=2（=sold+1），
// 泄露 sold=1；脱敏后必须变成相对索引 1，不再能反推历史销量。
describe('sanitizePublicSeatBreakdown · 公开口径 seatIndex 脱敏（防反推 sold）', () => {
  it('回归：sold=1 的单张查询，脱敏前 seatIndex=2（=sold+1）会暴露 sold，脱敏后必须是相对值 1', () => {
    const sold = 1;
    const raw = [{ seatIndex: sold + 1, bucket: 0, bucketMultiplier: 1, unitPrice: 1000 }];
    expect(raw[0].seatIndex).toBe(2); // 脱敏前：能直接反推 sold = seatIndex - 1 = 1
    const sanitized = sanitizePublicSeatBreakdown(raw);
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
    const sanitized = sanitizePublicSeatBreakdown(raw);
    expect(sanitized.map((s) => s.seatIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it('不改变价格/档位字段，只重编号 seatIndex（价格展示不受影响）', () => {
    const raw = [
      { seatIndex: 51, bucket: 2, bucketMultiplier: 1, unitPrice: 1500 },
      { seatIndex: 52, bucket: 3, bucketMultiplier: 1, unitPrice: 1800 },
    ];
    const sanitized = sanitizePublicSeatBreakdown(raw);
    expect(sanitized).toEqual([
      { seatIndex: 1, bucket: 2, bucketMultiplier: 1, unitPrice: 1500 },
      { seatIndex: 2, bucket: 3, bucketMultiplier: 1, unitPrice: 1800 },
    ]);
  });

  it('空数组（qty 校验层已挡下 <1，但函数本身也不应崩）→ 返回空数组', () => {
    expect(sanitizePublicSeatBreakdown([])).toEqual([]);
  });

  it('不修改输入数组（不可变）', () => {
    const raw = [{ seatIndex: 42, bucket: 0, bucketMultiplier: 1, unitPrice: 1000 }];
    const sanitized = sanitizePublicSeatBreakdown(raw);
    expect(raw[0].seatIndex).toBe(42); // 原数组未被就地修改
    expect(sanitized).not.toBe(raw);
    expect(sanitized[0]).not.toBe(raw[0]);
  });
});

// ── updateSchedule（月历库存视图：改价 / 改容量 / 停用启用）─────────────────
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

  it('容量低于已售：抛 400 且不写库', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(baseSchedule()); // sold = 30

    await expect(
      service.updateSchedule('sched_1', {
        seatClasses: [{ cabin: 'ECONOMY', capacity: 20 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // 校验失败 → 不进事务、不改任何 seatClass
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
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

  it('商务舱目标容量 7、已售 8：拒 400（超过目标容量），不写库', async () => {
    const schedule = baseSchedule();
    schedule.seatClasses = [
      { id: 'sc_biz', cabin: 'BUSINESS', capacity: 20, sold: 8, basePrice: decimal(9000) },
    ];
    prismaMock.flightSchedule.findUnique.mockResolvedValue(schedule);

    await expect(
      service.updateSchedule('sched_1', {
        seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: '商务舱已售 8，容量不能低于 8' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
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

// ── batchUpdateCapacity（按 scheduleId 列表批量改容量；命中守卫的班次跳过）─────
// 复用与 updateSchedule 相同的"容量不能低于已售"守卫；不存在的班次 / 没有该舱位
// 都不算失败，只是不产生变更（前者进 skipped，后者对该班次静默跳过这一项）。
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
    expect(result).toEqual({ applied: 2, skipped: [] });
  });

  it('已售超过目标容量的班次自动跳过（不是整批失败），其余正常改', async () => {
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

    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.flightSeatClass.update).toHaveBeenCalledWith({
      where: { id: 'sc_ok' },
      data: { capacity: 7 },
    });
    expect(result).toEqual({
      applied: 1,
      skipped: [{ scheduleId: 'sched_oversold', reason: '已售8超过目标容量7' }],
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
    });
  });

  it('全部命中守卫：applied=0、不调用 flightSeatClass.update、全部进 skipped', async () => {
    prismaMock.flightSchedule.findMany.mockResolvedValue([
      { id: 'sched_a', seatClasses: [{ id: 'sc_a', cabin: 'BUSINESS', capacity: 20, sold: 15 }] },
      { id: 'sched_b', seatClasses: [{ id: 'sc_b', cabin: 'BUSINESS', capacity: 20, sold: 10 }] },
    ]);

    const result = await service.batchUpdateCapacity({
      scheduleIds: ['sched_a', 'sched_b'],
      seatClasses: [{ cabin: 'BUSINESS', capacity: 7 }],
    });

    expect(prismaMock.flightSeatClass.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      applied: 0,
      skipped: [
        { scheduleId: 'sched_a', reason: '已售15超过目标容量7' },
        { scheduleId: 'sched_b', reason: '已售10超过目标容量7' },
      ],
    });
  });
});
