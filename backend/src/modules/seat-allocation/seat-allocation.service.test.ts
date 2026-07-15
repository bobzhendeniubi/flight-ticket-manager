/**
 * 切位（包位）服务单测（vitest）— 库存敏感，重点验证「绝不超切」与散客池口径。
 *
 * 散客池口径：散客池余票 = capacity − sold − 未过期锁位 − ACTIVE 切位。
 * 覆盖：
 *   - computePoolAvailability / isAllocationExpired 纯函数
 *   - createAllocation：seats ≤ 散客池余票 通过；> 余票 拒绝（BadRequestError '可切位余量不足'）
 *   - createAllocation：已有 ACTIVE 切位压缩散客池（不能超切）
 *   - reclaimAllocation：ACTIVE → RECLAIMED；非 ACTIVE 拒绝
 *   - listAllocations：flightScheduleId / agentId 过滤透传
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// service 顶层引用 prisma 与 writeAudit —— 先 mock。vi.mock 工厂被 hoist，用 vi.hoisted 构造共享 mock。
const prismaMock = vi.hoisted(() => {
  const mock: {
    flightSeatClass: { findUnique: ReturnType<typeof vi.fn> };
    flightSchedule: { findUnique: ReturnType<typeof vi.fn> };
    agent: { findUnique: ReturnType<typeof vi.fn> };
    seatLock: { aggregate: ReturnType<typeof vi.fn> };
    seatAllocation: {
      aggregate: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: ReturnType<typeof vi.fn>;
  } = {
    flightSeatClass: { findUnique: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    seatAllocation: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    // $queryRaw 用作 tagged template：忽略入参，返回 mock 设定值
    $queryRaw: vi.fn(),
    // $transaction(fn) 直接以同一个 mock 作为 tx 执行回调
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mock)),
  };
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
// writeAudit 在 service 内 fire-and-forget；给个空 mock 免噪声与副作用
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
  actorFromRequest: vi.fn(() => ({})),
}));

import {
  SeatAllocationService,
  computePoolAvailability,
  isAllocationExpired,
} from './seat-allocation.service.js';

const service = new SeatAllocationService();

// tx.$queryRaw 返回锁到的舱位行
function mockSeatClassRow(over: Partial<{ capacity: number; sold: number }> = {}) {
  prismaMock.$queryRaw.mockResolvedValue([
    { id: 'sc_eco', scheduleId: 'sched_1', capacity: over.capacity ?? 100, sold: over.sold ?? 0 },
  ]);
}
function mockLocked(qty: number) {
  prismaMock.seatLock.aggregate.mockResolvedValue({ _sum: { qty } });
}
function mockAllocated(seats: number | null) {
  prismaMock.seatAllocation.aggregate.mockResolvedValue({ _sum: { seats } });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  prismaMock.agent.findUnique.mockResolvedValue({ id: 'agent_1', isActive: true });
});

// ── 纯函数 ────────────────────────────────────────────────────────────────────
describe('computePoolAvailability', () => {
  it('capacity − sold − locked − allocated', () => {
    expect(computePoolAvailability({ capacity: 100, sold: 10, locked: 5, allocated: 20 })).toBe(65);
  });
  it('负数夹到 0（超占不返回负）', () => {
    expect(computePoolAvailability({ capacity: 100, sold: 60, locked: 30, allocated: 20 })).toBe(0);
  });
});

describe('isAllocationExpired', () => {
  const dep = new Date('2026-07-10T00:00:00.000Z');
  it('出发前 > reclaimDaysBefore 天 → 未到期', () => {
    // now = 出发前 10 天，回收阈值 7 天 → cutoff 在出发前 7 天，还没到
    expect(isAllocationExpired(dep, 7, new Date('2026-06-30T00:00:00.000Z'))).toBe(false);
  });
  it('已过「出发前 reclaimDaysBefore 天」这一刻 → 到期', () => {
    // now = 出发前 3 天，回收阈值 7 天 → 早过了 cutoff
    expect(isAllocationExpired(dep, 7, new Date('2026-07-07T00:00:00.000Z'))).toBe(true);
  });
  it('恰好到 cutoff（出发前 7 天整）→ 到期（≥）', () => {
    expect(isAllocationExpired(dep, 7, new Date('2026-07-03T00:00:00.000Z'))).toBe(true);
  });
});

// ── createAllocation ───────────────────────────────────────────────────────────
describe('SeatAllocationService.createAllocation', () => {
  it('seats ≤ 散客池余票 → 创建 ACTIVE 行', async () => {
    mockSeatClassRow({ capacity: 100, sold: 0 });
    mockLocked(0);
    mockAllocated(null); // 尚无切位
    prismaMock.seatAllocation.create.mockResolvedValue({
      id: 'alloc_1',
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 40,
      status: 'ACTIVE',
    });

    const result = await service.createAllocation({
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 40,
    });

    expect(result.id).toBe('alloc_1');
    expect(prismaMock.seatAllocation.create).toHaveBeenCalledTimes(1);
    const arg = prismaMock.seatAllocation.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 40,
      status: 'ACTIVE',
    });
  });

  it('seats > 散客池余票 → 拒绝（可切位余量不足），不写库', async () => {
    // capacity 100 − sold 20 − locked 10 − allocated 0 = 70；切 71 座应拒
    mockSeatClassRow({ capacity: 100, sold: 20 });
    mockLocked(10);
    mockAllocated(null);

    await expect(
      service.createAllocation({
        flightScheduleId: 'sched_1',
        cabin: 'ECONOMY',
        agentId: 'agent_1',
        seats: 71,
      }),
    ).rejects.toThrow('可切位余量不足');
    expect(prismaMock.seatAllocation.create).not.toHaveBeenCalled();
  });

  it('已有 ACTIVE 切位压缩散客池 → 剩余不足则拒绝（不能超切）', async () => {
    // capacity 100 − sold 0 − locked 0 − allocated 80 = 20；再切 30 座应拒
    mockSeatClassRow({ capacity: 100, sold: 0 });
    mockLocked(0);
    mockAllocated(80);

    await expect(
      service.createAllocation({
        flightScheduleId: 'sched_1',
        cabin: 'ECONOMY',
        agentId: 'agent_1',
        seats: 30,
      }),
    ).rejects.toThrow('可切位余量不足');
    expect(prismaMock.seatAllocation.create).not.toHaveBeenCalled();
  });

  it('恰好等于散客池余票 → 通过（边界 seats === pool）', async () => {
    // capacity 50 − sold 0 − locked 0 − allocated 30 = 20；切 20 座恰好通过
    mockSeatClassRow({ capacity: 50, sold: 0 });
    mockLocked(0);
    mockAllocated(30);
    prismaMock.seatAllocation.create.mockResolvedValue({
      id: 'alloc_edge',
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 20,
    });

    const result = await service.createAllocation({
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 20,
    });
    expect(result.id).toBe('alloc_edge');
  });

  it('班次不存在 → NotFoundError（班次不存在），不写库', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]); // 锁不到舱位行
    prismaMock.flightSchedule.findUnique.mockResolvedValue(null); // 班次也不存在

    await expect(
      service.createAllocation({
        flightScheduleId: 'nope',
        cabin: 'ECONOMY',
        agentId: 'agent_1',
        seats: 1,
      }),
    ).rejects.toThrow('班次不存在');
    expect(prismaMock.seatAllocation.create).not.toHaveBeenCalled();
  });

  it('班次存在但无此舱位 → BadRequestError（该班次没有此舱位）', async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.flightSchedule.findUnique.mockResolvedValue({ id: 'sched_1' });

    await expect(
      service.createAllocation({
        flightScheduleId: 'sched_1',
        cabin: 'FIRST',
        agentId: 'agent_1',
        seats: 1,
      }),
    ).rejects.toThrow('该班次没有此舱位');
    expect(prismaMock.seatAllocation.create).not.toHaveBeenCalled();
  });

  it('代理不存在 → NotFoundError（代理不存在），不写库', async () => {
    mockSeatClassRow({ capacity: 100, sold: 0 });
    prismaMock.agent.findUnique.mockResolvedValue(null);

    await expect(
      service.createAllocation({
        flightScheduleId: 'sched_1',
        cabin: 'ECONOMY',
        agentId: 'ghost',
        seats: 1,
      }),
    ).rejects.toThrow('代理不存在');
    expect(prismaMock.seatAllocation.create).not.toHaveBeenCalled();
  });
});

// ── reclaimAllocation ──────────────────────────────────────────────────────────
describe('SeatAllocationService.reclaimAllocation', () => {
  it('ACTIVE → RECLAIMED（座位回散客池）', async () => {
    prismaMock.seatAllocation.findUnique.mockResolvedValue({
      id: 'alloc_1',
      status: 'ACTIVE',
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 40,
    });
    prismaMock.seatAllocation.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.reclaimAllocation('alloc_1');
    expect(result).toEqual({ id: 'alloc_1', status: 'RECLAIMED' });
    // 原子 CAS：只在 ACTIVE 时改
    expect(prismaMock.seatAllocation.updateMany).toHaveBeenCalledWith({
      where: { id: 'alloc_1', status: 'ACTIVE' },
      data: { status: 'RECLAIMED' },
    });
  });

  it('已回收再点 → 拒绝（幂等报错），不重复改状态语义', async () => {
    prismaMock.seatAllocation.findUnique.mockResolvedValue({
      id: 'alloc_1',
      status: 'RECLAIMED',
      flightScheduleId: 'sched_1',
      cabin: 'ECONOMY',
      agentId: 'agent_1',
      seats: 40,
    });
    prismaMock.seatAllocation.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.reclaimAllocation('alloc_1')).rejects.toThrow('不可回收');
  });

  it('切位不存在 → NotFoundError', async () => {
    prismaMock.seatAllocation.findUnique.mockResolvedValue(null);
    await expect(service.reclaimAllocation('nope')).rejects.toThrow('切位不存在');
  });
});

// ── listAllocations ────────────────────────────────────────────────────────────
describe('SeatAllocationService.listAllocations', () => {
  const row = {
    id: 'alloc_1',
    flightScheduleId: 'sched_1',
    cabin: 'ECONOMY',
    agentId: 'agent_1',
    seats: 40,
    unitPriceCny: 1280,
    reclaimDaysBefore: 7,
    status: 'ACTIVE',
    notes: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z'),
    agent: { id: 'agent_1', companyName: 'ACME', contactName: 'Rep', tier: 1 },
    flightSchedule: {
      id: 'sched_1',
      departureTime: new Date('2026-07-10T00:00:00.000Z'),
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'CA1234', originCode: 'PEK', destinationCode: 'MFM' },
    },
  };

  it('flightScheduleId 过滤透传到 where', async () => {
    prismaMock.seatAllocation.findMany.mockResolvedValue([row]);
    await service.listAllocations({ flightScheduleId: 'sched_1' });
    expect(prismaMock.seatAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { flightScheduleId: 'sched_1' } }),
    );
  });

  it('agentId 过滤透传到 where', async () => {
    prismaMock.seatAllocation.findMany.mockResolvedValue([row]);
    await service.listAllocations({ agentId: 'agent_1' });
    expect(prismaMock.seatAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId: 'agent_1' } }),
    );
  });

  it('无筛选 → where 为空对象（返回全部）', async () => {
    prismaMock.seatAllocation.findMany.mockResolvedValue([row]);
    await service.listAllocations({});
    expect(prismaMock.seatAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('输出带代理 + 班次信息，时间 ISO，含 expired 标记', async () => {
    prismaMock.seatAllocation.findMany.mockResolvedValue([row]);
    const [out] = await service.listAllocations({});
    expect(out).toMatchObject({
      id: 'alloc_1',
      seats: 40,
      unitPriceCny: 1280,
      agent: { companyName: 'ACME', contactName: 'Rep' },
      flightNumber: 'CA1234',
      departureTime: '2026-07-10T00:00:00.000Z',
    });
    expect(typeof out.expired).toBe('boolean');
  });
});
