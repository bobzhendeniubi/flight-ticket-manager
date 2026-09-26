/**
 * 图片出库每日兜底清扫 · worker 注册单测。
 *
 * 样板同 worker.refresh-token-prune.test.ts：把 bullmq 的 Worker 换成记录构造参数的 no-op 类，
 * 断言 'image-blob-sweep' 队列确实注册了，且其处理函数按 IMAGE_BLOB_SWEEP_LIMIT 调用回填内核
 * （apply=true、limit 透传）；limit=0 时跳过不调用。
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { mockPrisma, capturedWorkers, mockBackfill, mockEnv } = vi.hoisted(() => ({
  mockPrisma: {
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  capturedWorkers: [] as Array<{ name: string; processor: (job?: unknown) => unknown }>,
  mockBackfill: vi.fn().mockResolvedValue({
    mode: 'apply',
    direction: 'forward',
    processed: 3,
    vacuumHint: null,
    tables: [
      { table: 'Passenger', converted: 2 },
      { table: 'Payment', converted: 1 },
    ],
  }),
  mockEnv: { NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379', IMAGE_BLOB_SWEEP_LIMIT: 200 },
}));

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
vi.mock('../config/env.js', () => ({ env: mockEnv }));
vi.mock('../lib/mailer.js', () => ({ closeMailer: vi.fn() }));
vi.mock('../lib/itinerary-email.js', () => ({ sendItineraryEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/image-blob-backfill.js', () => ({
  backfillImageBlobs: mockBackfill,
  formatBackfillSummary: () => 'summary',
}));
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
  pruneExpiredRefreshTokens: vi.fn().mockResolvedValue(0),
}));
vi.mock('../modules/hold-orders/hold-overdue.js', () => ({ markOverdueHolds: vi.fn() }));
vi.mock('../modules/orders/no-show-void.js', () => ({ voidDepartedReleasedReturnLegs: vi.fn() }));

describe('worker.ts — 图片出库每日兜底清扫', () => {
  beforeAll(async () => {
    await import('./worker.js');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  beforeEach(() => {
    mockBackfill.mockClear();
    mockEnv.IMAGE_BLOB_SWEEP_LIMIT = 200;
  });

  it('注册了名为 image-blob-sweep 的 Worker', () => {
    expect(capturedWorkers.find((w) => w.name === 'image-blob-sweep')).toBeDefined();
  });

  it('处理函数以 apply=true + IMAGE_BLOB_SWEEP_LIMIT 调回填内核，并回传处理/转换行数', async () => {
    const w = capturedWorkers.find((w) => w.name === 'image-blob-sweep')!;
    const result = await w.processor();
    expect(mockBackfill).toHaveBeenCalledTimes(1);
    const opts = mockBackfill.mock.calls[0][0] as { apply: boolean; limit: number; log: unknown };
    expect(opts.apply).toBe(true);
    expect(opts.limit).toBe(200);
    expect(typeof opts.log).toBe('function');
    expect(result).toEqual({ processed: 3, converted: 3 });
  });

  it('IMAGE_BLOB_SWEEP_LIMIT=0 → 跳过，不碰回填内核', async () => {
    mockEnv.IMAGE_BLOB_SWEEP_LIMIT = 0;
    const w = capturedWorkers.find((w) => w.name === 'image-blob-sweep')!;
    const result = await w.processor();
    expect(mockBackfill).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: 'disabled' });
  });
});
