/**
 * releaseOrderSeatsForTimeout · 超时释放按占座数（婴儿不占座）单测。
 *
 * 与建单扣座 / 状态机释放同读 metadata.seatQuantity；老行缺省回落 quantity；婴儿单独一单 0 座不放。
 * mock 风格对齐 worker.seat-reclaim.test.ts：worker.ts 顶层 `new Worker(...)`（连 Redis）与 env
 * 读取全部替换成 no-op；orders.service 只保留一个与真实现同口径的 computeBundleSeatSplit 桩 +
 * 可断言的 releaseSeatFloored。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CabinClass, OrderItemKind } from '@prisma/client';

const { mockPrisma, mockReleaseSeatFloored } = vi.hoisted(() => ({
  mockPrisma: { $disconnect: vi.fn().mockResolvedValue(undefined) },
  mockReleaseSeatFloored: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  },
}));
vi.mock('../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('./queue.js', () => ({ bullRedis: { quit: vi.fn() }, enqueueWaitlistCheck: vi.fn() }));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../lib/mailer.js', () => ({ closeMailer: vi.fn() }));
vi.mock('../lib/itinerary-email.js', () => ({ sendItineraryEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../modules/orders/orders.service.js', () => ({
  // 与真实现同口径的最小桩：经济舱行把升舱人数拆到商务舱，其余全在原舱。
  computeBundleSeatSplit: (cabin: string, quantity: number, upgrade?: number) => {
    const business = cabin === 'ECONOMY' ? Math.min(Math.max(0, upgrade ?? 0), quantity) : 0;
    return { sameCabin: quantity - business, business };
  },
  releaseSeatFloored: mockReleaseSeatFloored,
}));
vi.mock('../modules/seat-allocation/seat-allocation.service.js', () => ({
  SeatAllocationService: class {
    autoReclaimExpired() {
      return Promise.resolve([]);
    }
  },
}));
vi.mock('../modules/hold-orders/hold-overdue.js', () => ({ markOverdueHolds: vi.fn() }));
vi.mock('../modules/orders/no-show-void.js', () => ({ voidDepartedReleasedReturnLegs: vi.fn() }));

import { releaseOrderSeatsForTimeout } from './worker.js';

const tx = {} as Parameters<typeof releaseOrderSeatsForTimeout>[0];

function flightItem(quantity: number, metadata: Record<string, unknown> | null) {
  return {
    kind: OrderItemKind.FLIGHT,
    flightScheduleId: 'sched1',
    flightCabin: CabinClass.ECONOMY,
    quantity,
    metadata,
  };
}

/** releaseSeatFloored 被调用的 (cabin, qty) 列表（qty=0 的调用由 helper 内部短路，这里照样记）。 */
function releaseCalls(): Array<[string, number]> {
  return mockReleaseSeatFloored.mock.calls.map((c) => [c[2] as string, c[3] as number]);
}

describe('releaseOrderSeatsForTimeout · 占座数口径', () => {
  beforeEach(() => {
    mockReleaseSeatFloored.mockClear();
  });

  it('1 成人 + 1 婴儿（quantity 2、seatQuantity 1）→ 只放 1 座', async () => {
    await releaseOrderSeatsForTimeout(tx, [flightItem(2, { seatQuantity: 1, infantCount: 1 })]);
    expect(releaseCalls()).toEqual([
      ['BUSINESS', 0],
      ['ECONOMY', 1],
    ]);
  });

  it('婴儿单独一单（seatQuantity 0）→ 两舱都是 0（一座不放）', async () => {
    await releaseOrderSeatsForTimeout(tx, [flightItem(1, { seatQuantity: 0, infantCount: 1 })]);
    expect(releaseCalls()).toEqual([
      ['BUSINESS', 0],
      ['ECONOMY', 0],
    ]);
  });

  it('老行没有 seatQuantity → 回落 quantity（与旧行为一致）', async () => {
    await releaseOrderSeatsForTimeout(tx, [flightItem(2, null)]);
    expect(releaseCalls()).toEqual([
      ['BUSINESS', 0],
      ['ECONOMY', 2],
    ]);
  });

  it('套餐升舱行（seatQuantity=quantity=3，升舱 1）→ 商务 1 + 经济 2，不受影响', async () => {
    await releaseOrderSeatsForTimeout(tx, [
      flightItem(3, { seatQuantity: 3, infantCount: 1, businessUpgradeCount: 1 }),
    ]);
    expect(releaseCalls()).toEqual([
      ['BUSINESS', 1],
      ['ECONOMY', 2],
    ]);
  });
});
