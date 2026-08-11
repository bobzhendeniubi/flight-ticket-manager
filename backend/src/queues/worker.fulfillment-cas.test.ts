/**
 * Fulfillment worker「取消 vs 出票」CAS 写回单测（R3）。
 *
 * 场景：claim 把任务抢成 IN_PROGRESS 后，有 2-5s 供应商窗口；其间订单可能被取消——取消族会把
 * IN_PROGRESS 履约任务置 CANCELLED（orders.service 履约任务终态化）。worker 完成写回改用 CAS
 * （updateMany where status=IN_PROGRESS）：
 *   - count!==1（任务已被取消/改动）→ 放弃写回 PNR、不发行程单邮件、不覆盖状态；
 *   - count===1（CAS 成功）→ 才写回 PNR + 发邮件。
 *
 * mock 风格对齐 orders.payment-timeout.test.ts（vi.hoisted + vi.mock）。额外 mock bullmq / queue /
 * env / mailer / itinerary-email / orders.service —— worker.ts 顶层有 `new Worker(...)`（连 Redis）与
 * env 读取、import 即执行，全部替换成 no-op 让单测无外部依赖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FulfillmentStatus, FulfillmentType, OrderStatus } from '@prisma/client';

const { mockPrisma, mockSendItineraryEmail } = vi.hoisted(() => ({
  mockPrisma: {
    fulfillmentTask: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    passenger: { updateMany: vi.fn() },
    // worker.ts 顶层注册了 SIGTERM/SIGINT → shutdown()，teardown 时 vitest 发信号会触发；
    // 补齐 $disconnect 让 shutdown 不因缺方法抛未处理拒绝。
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  mockSendItineraryEmail: vi.fn(),
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
vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', REDIS_URL: 'redis://localhost:6379' },
}));
vi.mock('../lib/mailer.js', () => ({ closeMailer: vi.fn() }));
vi.mock('../lib/itinerary-email.js', () => ({ sendItineraryEmail: mockSendItineraryEmail }));
vi.mock('../modules/orders/orders.service.js', () => ({
  computeBundleSeatSplit: vi.fn(),
  releaseSeatFloored: vi.fn(),
}));

import { processFulfillmentTask } from './worker.js';

const job = { data: { taskId: 'task-1', simulateDelay: 0 }, attemptsMade: 0 };

function flightTask(orderStatus = OrderStatus.PAID) {
  return {
    id: 'task-1',
    status: FulfillmentStatus.PENDING,
    type: FulfillmentType.FLIGHT_TICKETING,
    startedAt: null,
    orderItem: {
      orderId: 'ord-1',
      order: { orderNumber: 'CO-1', status: orderStatus, deletedAt: null },
    },
  };
}

// claim(PENDING→IN_PROGRESS) 恒成功；confirm(IN_PROGRESS→CONFIRMED) 的命中行数由每个用例设置。
let confirmCount = 1;
function wireUpdateMany() {
  mockPrisma.fulfillmentTask.updateMany.mockImplementation(
    async (args: { where: { status?: unknown } }) => {
      if (args.where.status === FulfillmentStatus.PENDING) return { count: 1 };
      if (args.where.status === FulfillmentStatus.IN_PROGRESS) return { count: confirmCount };
      return { count: 0 };
    },
  );
}

describe('processFulfillmentTask · 取消 vs 出票 CAS（R3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmCount = 1;
    mockPrisma.fulfillmentTask.findUnique.mockResolvedValue(flightTask());
    mockPrisma.passenger.updateMany.mockResolvedValue({ count: 1 });
    mockSendItineraryEmail.mockResolvedValue({ status: 'sent', sentTo: 'x@y.z' });
    wireUpdateMany();
  });

  it('供应商窗口内订单被取消 → 完成写回被 CAS 拦下：不写回 PNR、不发邮件、不覆盖状态', async () => {
    confirmCount = 0; // 落 CONFIRMED 时任务已 CANCELLED → CAS updateMany 命中 0 行

    const res = await processFulfillmentTask(job);

    expect(res).toEqual({ skipped: true, reason: 'task cancelled during supplier window' });
    expect(mockPrisma.passenger.updateMany).not.toHaveBeenCalled();
    expect(mockSendItineraryEmail).not.toHaveBeenCalled();
  });

  it('正常出票 → CAS 成功（count=1）：写回 PNR + 发行程单邮件', async () => {
    confirmCount = 1;

    const res = (await processFulfillmentTask(job)) as { taskId: string; data: { pnr: string } };

    // 完成写回走 CAS updateMany（where status=IN_PROGRESS），不再是无状态守卫的裸 update
    expect(mockPrisma.fulfillmentTask.update).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'task-1',
          status: FulfillmentStatus.IN_PROGRESS,
          orderItem: { order: { status: { not: OrderStatus.REFUND_REQUESTED } } },
        }),
      }),
    );
    expect(mockPrisma.passenger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'ord-1' } }),
    );
    expect(mockSendItineraryEmail).toHaveBeenCalledWith('ord-1');
    expect(res.taskId).toBe('task-1');
    expect(res.data.pnr).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('claim 竞争失败（任务已被别的 worker 抢走）→ 幂等跳过，不写回', async () => {
    mockPrisma.fulfillmentTask.updateMany.mockImplementation(
      async (args: { where: { status?: unknown } }) => {
        if (args.where.status === FulfillmentStatus.PENDING) return { count: 0 }; // 抢占失败
        return { count: 0 };
      },
    );

    const res = await processFulfillmentTask(job);

    expect(res).toEqual({ skipped: true, reason: 'claim race lost' });
    expect(mockPrisma.passenger.updateMany).not.toHaveBeenCalled();
    expect(mockSendItineraryEmail).not.toHaveBeenCalled();
  });

  it('订单退款申请中 → worker 不抢任务、不推进到 CONFIRMED', async () => {
    mockPrisma.fulfillmentTask.findUnique.mockResolvedValue(
      flightTask(OrderStatus.REFUND_REQUESTED),
    );

    const res = await processFulfillmentTask(job);

    expect(res).toEqual({
      skipped: true,
      reason: '订单退款申请中，库存已释放，不可继续履约；如退款被驳回可恢复操作',
    });
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
  });
});
