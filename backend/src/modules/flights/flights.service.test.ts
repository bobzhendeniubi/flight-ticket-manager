/**
 * 六档余位档位 computeAvailabilityTier · 纯函数单测（vitest）
 *
 * 阈值口径（AVAILABILITY_TIER_THRESHOLDS，运营可能调整）：
 *   >40 AMPLE；16-40 TIGHT；6-15 LOW；1-5 VERY_LOW；≤0 SOLD_OUT
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
  computeAvailabilityTier,
  FlightService,
} from './flights.service.js';

describe('computeAvailabilityTier', () => {
  it('>40 → AMPLE', () => {
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

  it('阈值常量与档位边界一致（防止改常量漏改函数）', () => {
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.AMPLE_MIN)).toBe('AMPLE');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.AMPLE_MIN - 1)).toBe('TIGHT');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.TIGHT_MIN - 1)).toBe('LOW');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.LOW_MIN - 1)).toBe('VERY_LOW');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.VERY_LOW_MIN - 1)).toBe('SOLD_OUT');
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

  it('无销售（sold=0、无订单项）→ 硬删，返回 { deleted: true }', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched_1',
      isActive: true,
      orderItems: [],
      seatClasses: [{ sold: 0 }, { sold: 0 }],
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
    });

    await expect(service.deleteSchedule('sched_1')).rejects.toMatchObject({
      statusCode: 400,
      message: '该班次已有销售，不能删除（请改用售罄）',
    });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });

  it('班次不存在：抛 404', async () => {
    prismaMock.flightSchedule.findUnique.mockResolvedValue(null);
    await expect(service.deleteSchedule('nope')).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.flightSchedule.delete).not.toHaveBeenCalled();
  });
});
