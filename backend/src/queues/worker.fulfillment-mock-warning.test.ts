/**
 * processFulfillmentTask 的 B-5 保险丝单测。
 *
 * 背景：这条 worker 的「自动履约」全是模拟数据（假票号/假酒店确认号/假司机车牌），没有接
 * 任何真实供应商 API。默认值收紧（ENABLE_AUTO_FULFILLMENT 默认 false）由另一处改动负责，
 * 这里只加一道保险——生产环境下若这个开关仍被打开，打一条显眼 WARN，不静默造假，方便运维
 * 从日志里第一时间发现异常。
 *
 * mock 风格对齐 worker.fulfillment-cas.test.ts（同一份 harness）：worker.ts 顶层有
 * `new Worker(...)`（连 Redis）与 env 读取、import 即执行，全部替换成 no-op 让单测无外部依赖。
 * env 用可变的 hoisted 对象（而不是静态字面量），好在各用例之间切换 NODE_ENV。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FulfillmentStatus, FulfillmentType, OrderStatus } from '@prisma/client';

const { mockPrisma, mockEnv } = vi.hoisted(() => ({
  mockPrisma: {
    fulfillmentTask: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    passenger: { updateMany: vi.fn() },
    // worker.ts 顶层注册了 SIGTERM/SIGINT → shutdown()，teardown 时 vitest 发信号会触发；
    // 补齐 $disconnect 让 shutdown 不因缺方法抛未处理拒绝。
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  mockEnv: { NODE_ENV: 'test' as string, REDIS_URL: 'redis://localhost:6379' },
}));

// worker.ts 顶层 `new Worker(...)` 会连 Redis —— 换成 no-op，避免单测连外部服务。
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
vi.mock('./queue.js', () => ({
  bullRedis: { quit: vi.fn() },
  enqueueWaitlistCheck: vi.fn(),
}));
vi.mock('../config/env.js', () => ({ env: mockEnv }));
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
vi.mock('../modules/hold-orders/hold-overdue.js', () => ({ markOverdueHolds: vi.fn() }));
vi.mock('../modules/orders/no-show-void.js', () => ({ voidDepartedReleasedReturnLegs: vi.fn() }));

import { processFulfillmentTask } from './worker.js';

function fakeTask(type: FulfillmentType) {
  return {
    id: 'task-1',
    type,
    status: FulfillmentStatus.PENDING,
    startedAt: null,
    orderItem: {
      orderId: 'order-1',
      order: { orderNumber: 'FTM2026090100001', status: OrderStatus.PAID, deletedAt: null },
    },
  };
}

describe('processFulfillmentTask — B-5 生产环境 mock 保险丝', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NODE_ENV = 'test';
    delete process.env.ENABLE_AUTO_FULFILLMENT;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // CAS 两次（claim → IN_PROGRESS，confirm → CONFIRMED）都放行，走完整条主流程。
    mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.ENABLE_AUTO_FULFILLMENT;
  });

  it('NODE_ENV=production 且 ENABLE_AUTO_FULFILLMENT=true → 打印一条 WARN，指名是模拟数据', async () => {
    mockEnv.NODE_ENV = 'production';
    process.env.ENABLE_AUTO_FULFILLMENT = 'true';
    mockPrisma.fulfillmentTask.findUnique.mockResolvedValue(fakeTask(FulfillmentType.HOTEL_BOOKING));

    await processFulfillmentTask({
      data: { taskId: 'task-1', simulateDelay: 0 },
      attemptsMade: 0,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain('task-1');
    expect(message).toContain('模拟数据');
  });

  it('测试/开发环境（NODE_ENV≠production）→ 不打印 WARN，哪怕开关打开', async () => {
    mockEnv.NODE_ENV = 'test';
    process.env.ENABLE_AUTO_FULFILLMENT = 'true';
    mockPrisma.fulfillmentTask.findUnique.mockResolvedValue(fakeTask(FulfillmentType.HOTEL_BOOKING));

    await processFulfillmentTask({
      data: { taskId: 'task-1', simulateDelay: 0 },
      attemptsMade: 0,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('生产环境但开关关闭（ENABLE_AUTO_FULFILLMENT≠true）→ 不打印 WARN', async () => {
    mockEnv.NODE_ENV = 'production';
    process.env.ENABLE_AUTO_FULFILLMENT = 'false';
    mockPrisma.fulfillmentTask.findUnique.mockResolvedValue(fakeTask(FulfillmentType.FLIGHT_TICKETING));

    await processFulfillmentTask({
      data: { taskId: 'task-1', simulateDelay: 0 },
      attemptsMade: 0,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
