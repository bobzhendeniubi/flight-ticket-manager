/**
 * BullMQ 队列基础设施
 *
 * 复用现有 Redis 连接（ioredis）。队列按用途分：
 *   - fulfillment: 出票 / 酒店预订 / 签证跟踪 的异步执行
 *   - notification: 短信/邮件（未来接）
 *   - ocr: 护照识别（当前前端跑 tesseract，可迁移到后台）
 *
 * 使用模式：
 *   producer: queue.add('generate-pnr', { taskId }, { delay: 3000 })
 *   consumer: worker.ts 启动独立进程
 *
 * 运维：
 *   - Bull Board UI 可挂 /admin/queues（待加）
 *   - 失败任务：默认 retry 3 次，指数退避
 */
import { Queue, QueueEvents } from 'bullmq';
// ioredis 在 ESM 下的默认导出兼容性 —— 用 namespace import
import * as IORedisNs from 'ioredis';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const IORedis: typeof import('ioredis').default = (IORedisNs as any).default ?? IORedisNs;
import { env } from '../config/env.js';

// 给 BullMQ 专用的连接（ioredis, maxRetriesPerRequest: null 是 BullMQ 要求）
export const bullRedis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// ── Fulfillment 队列 ───────────────────────────────────────────────
export interface FulfillmentJobData {
  taskId: string;
  simulateDelay?: number; // 开发 mock 用
}

export const fulfillmentQueue = new Queue<FulfillmentJobData>('fulfillment', {
  connection: bullRedis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 }, // 保留 7 天或 1000 条
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

export const fulfillmentQueueEvents = new QueueEvents('fulfillment', { connection: bullRedis });

// ── Seat Hold 队列 — 订单 30 分钟未支付自动释放座位 ───────────────
export interface SeatHoldJobData {
  orderId: string;
}

export const seatHoldQueue = new Queue<SeatHoldJobData>('seat-hold', {
  connection: bullRedis,
  defaultJobOptions: {
    attempts: 2, // 幂等：worker 自己判断 order 状态
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

/**
 * 订单创建时排队：delay 毫秒后如果订单仍是 PENDING_PAYMENT 则取消 + 释放座位。
 * jobId 用 `hold-<orderId>`，方便支付成功时 remove() 取消。
 */
export async function scheduleSeatHoldRelease(orderId: string, delayMs: number): Promise<void> {
  await seatHoldQueue.add(
    'release-seat-hold',
    { orderId },
    {
      jobId: `hold-${orderId}`,
      delay: delayMs,
    },
  );
}

/** 支付成功或手动取消时调用；若任务已执行（订单已自动取消）则静默返回。 */
export async function cancelSeatHoldRelease(orderId: string): Promise<void> {
  try {
    const job = await seatHoldQueue.getJob(`hold-${orderId}`);
    if (job) await job.remove();
  } catch {
    /* best-effort */
  }
}

// ── Seat Lock 队列 — 锁位固定 10 分钟，到期自动失效回归可售 ───────
export interface SeatLockJobData {
  lockId: string;
}

export const seatLockQueue = new Queue<SeatLockJobData>('seat-lock', {
  connection: bullRedis,
  defaultJobOptions: {
    attempts: 2, // 幂等：worker 只在锁仍 ACTIVE 时标 EXPIRED
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

// 占位单逾期扫描：每小时运行一次，业务日期在 worker 内按各班次 departureTz 比较。
export interface HoldOverdueJobData {
  requestedAt?: string;
}

export const holdOverdueQueue = new Queue<HoldOverdueJobData>('hold-overdue', {
  connection: bullRedis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 30 * 24 * 3600 },
  },
});

export async function scheduleHoldOverdueScan(): Promise<void> {
  await holdOverdueQueue.add('scan-hold-overdue', {}, {
    jobId: 'hold-overdue-hourly',
    repeat: { every: 60 * 60 * 1000 },
  });
}

/**
 * 创建锁位时排队：delay 毫秒后若锁仍 ACTIVE 则标 EXPIRED（座位自动回归可售）。
 * jobId 用 `seatlock-<lockId>`，方便下单消费 / 手动释放时 remove() 取消。
 */
export async function scheduleSeatLockExpiry(lockId: string, delayMs: number): Promise<void> {
  await seatLockQueue.add(
    'expire-seat-lock',
    { lockId },
    {
      jobId: `seatlock-${lockId}`,
      delay: delayMs,
    },
  );
}

/** 锁位被消费 / 手动释放时调用；若任务已执行（锁已自动过期）则静默返回。 */
export async function cancelSeatLockExpiry(lockId: string): Promise<void> {
  try {
    const job = await seatLockQueue.getJob(`seatlock-${lockId}`);
    if (job) await job.remove();
  } catch {
    /* best-effort */
  }
}

// ── Notification 队列（预留）──────────────────────────────────────
export interface NotificationJobData {
  type: 'SMS' | 'EMAIL' | 'WECHAT_TEMPLATE';
  to: string;
  subject?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// 候补检查任务（job name 'waitlist-check'）— 座位释放后检查该舱位最早的 ACTIVE 候补
export interface WaitlistCheckJobData {
  seatClassId: string;
}

export const notificationQueue = new Queue<NotificationJobData | WaitlistCheckJobData>('notification', {
  connection: bullRedis,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
});

/**
 * 座位释放（订单取消/超时、锁位过期）后排队候补检查。
 * 调用方包 try/catch best-effort —— 排队失败不阻塞释放主流程。
 */
export async function enqueueWaitlistCheck(seatClassId: string): Promise<void> {
  await notificationQueue.add('waitlist-check', { seatClassId });
}

// ── 优雅关闭 ─────────────────────────────────────────────────────
export async function closeQueues(): Promise<void> {
  await Promise.all([
    fulfillmentQueue.close(),
    notificationQueue.close(),
    seatHoldQueue.close(),
    seatLockQueue.close(),
    holdOverdueQueue.close(),
    fulfillmentQueueEvents.close(),
  ]);
  await bullRedis.quit();
}
