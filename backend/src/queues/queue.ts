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

// ── Notification 队列（预留）──────────────────────────────────────
export interface NotificationJobData {
  type: 'SMS' | 'EMAIL' | 'WECHAT_TEMPLATE';
  to: string;
  subject?: string;
  content: string;
  metadata?: Record<string, unknown>;
}
export const notificationQueue = new Queue<NotificationJobData>('notification', {
  connection: bullRedis,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
});

// ── 优雅关闭 ─────────────────────────────────────────────────────
export async function closeQueues(): Promise<void> {
  await Promise.all([
    fulfillmentQueue.close(),
    notificationQueue.close(),
    fulfillmentQueueEvents.close(),
  ]);
  await bullRedis.quit();
}
