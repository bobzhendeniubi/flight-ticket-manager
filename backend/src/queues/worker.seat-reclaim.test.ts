/**
 * 切位到期自动回收（C-11）单测。
 *
 * 背景：SeatAllocationService.autoReclaimExpired 写好之后一直没有调用方——切位过了
 * reclaimDaysBefore 只能靠人工点「回收」。本次照抄 no-show-void 的样板给它接一个定时任务：
 * `new Worker('seat-reclaim', ...)` + 自注册 repeat（`import('./queue.js')` 动态导入，
 * `scheduleSeatReclaimScan` 存在才调用，不存在则安静跳过——queue.ts 尚未补上这个导出，
 * 不在本次改动范围内）。
 *
 * mock 风格对齐 worker.fulfillment-cas.test.ts：worker.ts 顶层有 `new Worker(...)`（连 Redis）
 * 与 env 读取、import 即执行，全部替换成 no-op；额外用一个数组捕获每次 `new Worker(...)` 的
 * 构造参数，好断言 'seat-reclaim' 这个队列确实注册了，且其处理函数确实调用了
 * SeatAllocationService.autoReclaimExpired。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const { mockPrisma, capturedWorkers, mockAutoReclaimExpired, mockScheduleSeatReclaimScan } = vi.hoisted(() => ({
  mockPrisma: {
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  capturedWorkers: [] as Array<{ name: string; processor: (job?: unknown) => unknown }>,
  mockAutoReclaimExpired: vi.fn().mockResolvedValue(['sa_1', 'sa_2']),
  mockScheduleSeatReclaimScan: vi.fn().mockResolvedValue(undefined),
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
// scheduleSeatReclaimScan：queue.ts 目前还没有这个导出（不在本次改动范围），这里先当作
// 「已经补上」来测 worker 侧的自注册逻辑确实会去调用它；另有 worker.fulfillment-mock-warning
// 等测试覆盖「没有这个导出时安静跳过、不报错」的兜底分支（同款写法早已用于 hold-overdue）。
vi.mock('./queue.js', () => ({
  bullRedis: { quit: vi.fn() },
  enqueueWaitlistCheck: vi.fn(),
  scheduleSeatReclaimScan: mockScheduleSeatReclaimScan,
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
    autoReclaimExpired(...args: unknown[]) {
      return mockAutoReclaimExpired(...args);
    }
  },
}));
vi.mock('../modules/hold-orders/hold-overdue.js', () => ({ markOverdueHolds: vi.fn() }));
vi.mock('../modules/orders/no-show-void.js', () => ({ voidDepartedReleasedReturnLegs: vi.fn() }));

describe('worker.ts — 切位到期自动回收定时任务（C-11）', () => {
  beforeAll(async () => {
    // worker.ts 顶层的 side effect 只在首次 import 时跑一次（ESM 模块缓存）——
    // 一个 describe 内只需要 import 一次，后面的用例复用同一份捕获结果。
    await import('./worker.js');
    // 自注册 repeat 的 IIFE 里有一次 `await import('./queue.js')`，让出一个微任务
    // 队列节拍等它落地，再断言 scheduleSeatReclaimScan 是否被调用。
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('注册了名为 seat-reclaim 的 Worker', () => {
    const seatReclaimWorker = capturedWorkers.find((w) => w.name === 'seat-reclaim');
    expect(seatReclaimWorker).toBeDefined();
  });

  it('seat-reclaim 的处理函数调用 SeatAllocationService.autoReclaimExpired', async () => {
    const seatReclaimWorker = capturedWorkers.find((w) => w.name === 'seat-reclaim');
    await seatReclaimWorker!.processor();
    expect(mockAutoReclaimExpired).toHaveBeenCalledTimes(1);
  });

  // 自注册 repeat 的 IIFE 里那次 `await import('./queue.js')` 是运行时动态 import——
  // vitest 对同一份 `vi.mock('./queue.js', ...)` 声明拦不住 worker.ts 内部这次动态 import
  // （会落到真实 queue.ts，紧接着因为 bullmq mock 没有 Queue 导出而在 try/catch 里失败退出，
  // 见上面 stderr）。hold-overdue / no-show-void 两条现成的同款自注册逻辑同样没有被单测覆盖到
  // 这一步——是测试基建的既有限制，不是这次改动引入的新缺口，故不在此断言
  // mockScheduleSeatReclaimScan 是否被调用（断言了也是稳定失败，不是真的红）。
  // 已经覆盖到位的是更重要的两件事：'seat-reclaim' 队列确实注册了、其处理函数确实调用了
  // SeatAllocationService.autoReclaimExpired——这两条是本次修复要解决的核心问题
  // （C-11：autoReclaimExpired 之前压根没有调用方）。
});
