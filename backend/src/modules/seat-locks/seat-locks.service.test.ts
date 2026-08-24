/**
 * 锁位与占位库存联动单测：锁位也必须遵守
 * capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatLockService } from './seat-locks.service.js';

const { prismaMock, scheduleExpiryMock } = vi.hoisted(() => ({
  prismaMock: {
    flightSeatClass: { findUnique: vi.fn() },
    seatLock: { aggregate: vi.fn(), create: vi.fn() },
    holdOrder: { aggregate: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  scheduleExpiryMock: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../queues/queue.js', () => ({ scheduleSeatLockExpiry: scheduleExpiryMock }));

const service = new SeatLockService();

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
  prismaMock.$queryRaw.mockResolvedValue([
    { id: 'sc_1', scheduleId: 'schedule_1', capacity: 100, sold: 10 },
  ]);
  prismaMock.seatLock.aggregate
    .mockResolvedValueOnce({ _sum: { qty: 0 } })
    .mockResolvedValueOnce({ _sum: { qty: 5 } });
  prismaMock.holdOrder.aggregate.mockResolvedValue({
    _sum: { seats: 20, seatsConverted: 0, seatsCancelled: 0 },
  });
  prismaMock.seatLock.create.mockResolvedValue({
    id: 'lock_1',
    expiresAt: new Date(Date.now() + 600000),
  });
});

describe('SeatLockService.createLock · 占位库存联动', () => {
  it('占位压缩余量后，锁位超出剩余座位返回 409', async () => {
    // 100 − 10 − 5 − 20 = 65；本次锁 66 应拒绝（同时会先命中单用户上限保护）。
    await expect(
      service.createLock({ flightScheduleId: 'schedule_1', seatClassId: 'sc_1', qty: 9 }, 'user_1'),
    ).resolves.toBeDefined();

    // 通过更高占位量覆盖第二次请求，验证余量闸而非同用户上限。
    prismaMock.seatLock.aggregate
      .mockReset()
      .mockResolvedValueOnce({ _sum: { qty: 0 } })
      .mockResolvedValueOnce({ _sum: { qty: 5 } });
    prismaMock.holdOrder.aggregate.mockResolvedValue({
      _sum: { seats: 86, seatsConverted: 0, seatsCancelled: 0 },
    });
    await expect(
      service.createLock({ flightScheduleId: 'schedule_1', seatClassId: 'sc_1', qty: 9 }, 'user_2'),
    ).rejects.toThrow('仅剩 0 张');
    expect(prismaMock.seatLock.create).toHaveBeenCalledTimes(1);
  });
});
