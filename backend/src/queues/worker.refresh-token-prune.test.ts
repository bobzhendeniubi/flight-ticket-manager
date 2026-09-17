/**
 * RefreshToken 过期行每日清理 · worker 注册单测。
 *
 * 样板同 worker.seat-reclaim.test.ts：把 bullmq 的 Worker 换成记录构造参数的 no-op 类，
 * 断言 'refresh-token-prune' 队列确实注册了，且其处理函数确实调用了 pruneExpiredRefreshTokens
 * 并把删掉的行数回传（cutoff 口径在 refresh-token-prune.test.ts 里单独钉住）。
 * 自注册 repeat 那次动态 import 受测试基建限制不在此断言（原因见 seat-reclaim 同款说明）。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';


const { mockPrisma, capturedWorkers, mockPrune } = vi.hoisted(() => ({
  mockPrisma: {
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  capturedWorkers: [] as Array<{ name: string; processor: (job?: unknown) => unknown }>,
  mockPrune: vi.fn().mockResolvedValue(42),
}));

// worker.ts 顶层为每个队列都 `new Worker(name, processor, opts)` —— 换成会记录构造参数的
// no-op 类，既不连 Redis，又能让测试拿到 'seat-reclaim' 那一条的处理函数直接调用断言。
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(name: string, processor: (job?: unknown) => unknown) {
      capturedWorkers.push({ name, processor });
    }
    on() {
      return this;
    }
    close() {
      return Promise.resolve();
    }
  },
}));

vi.mock('../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('./queue.js', () => ({
  bullRedis: { quit: vi.fn() },
  enqueueWaitlistCheck: vi.fn(),
}));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../lib/mailer.js', () => ({ closeMailer: vi.fn() }));
vi.mock('../lib/itinerary-email.js', () => ({ sendItineraryEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../modules/orders/orders.service.js', () => ({
  computeBundleSeatSplit: vi.fn(),
  releaseSeatFloored: vi.fn(),
}));
vi.mock('../modules/seat-allocation/seat-allocation.service.js', () => ({
  SeatAllocationService: class {
    autoReclaimExpired() {
      return Promise.resolve([]);
    }
  },
}));
vi.mock('../modules/auth/refresh-token-prune.js', () => ({
  pruneExpiredRefreshTokens: mockPrune,
}));
vi.mock('../modules/hold-orders/hold-overdue.js', () => ({ markOverdueHolds: vi.fn() }));
vi.mock('../modules/orders/no-show-void.js', () => ({ voidDepartedReleasedReturnLegs: vi.fn() }));


describe('worker.ts — RefreshToken 过期行每日清理', () => {
  beforeAll(async () => {
    await import('./worker.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('注册了名为 refresh-token-prune 的 Worker', () => {
    expect(capturedWorkers.find((w) => w.name === 'refresh-token-prune')).toBeDefined();
  });

  it('处理函数调用 pruneExpiredRefreshTokens 并回传删掉的行数', async () => {
    const w = capturedWorkers.find((w) => w.name === 'refresh-token-prune');
    const result = await w!.processor();
    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ deleted: 42 });
  });
});
