/**
 * BullMQ Worker 入口 —— 独立进程启动。
 *
 * 用法：
 *   node --import tsx src/queues/worker.ts
 *
 * 或用 npm script：npm run worker
 *
 * 生产部署：用 PM2 / supervisor 单独拉起，水平扩展（多副本并发消费）。
 */
import { Worker } from 'bullmq';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { FulfillmentStatus, FulfillmentType, Prisma } from '@prisma/client';
import { bullRedis, type FulfillmentJobData, type NotificationJobData } from './queue.js';

// ══════════════════════════════════════════════════════════════════
// Fulfillment Worker — 处理出票 / 酒店预订 / 签证 / 接送
//
// 当前实现：sandbox 模拟供应商 API（延时后生成假 PNR/确认号）。
// 接入真实供应商时替换这部分逻辑即可。
// ══════════════════════════════════════════════════════════════════
const fulfillmentWorker = new Worker<FulfillmentJobData>(
  'fulfillment',
  async (job) => {
    const { taskId } = job.data;
    // eslint-disable-next-line no-console
    console.log(`[worker:fulfillment] processing task ${taskId} (attempt ${job.attemptsMade + 1})`);

    const task = await prisma.fulfillmentTask.findUnique({
      where: { id: taskId },
      include: { orderItem: { include: { order: { select: { orderNumber: true } } } } },
    });
    if (!task) throw new Error(`Task ${taskId} not found`);

    // 已完成或取消的任务直接跳过
    if (task.status === FulfillmentStatus.CONFIRMED || task.status === FulfillmentStatus.CANCELLED) {
      return { skipped: true, status: task.status };
    }

    // 标 IN_PROGRESS
    await prisma.fulfillmentTask.update({
      where: { id: taskId },
      data: {
        status: FulfillmentStatus.IN_PROGRESS,
        startedAt: task.startedAt ?? new Date(),
        attempts: { increment: 1 },
      },
    });

    // 模拟 2-5 秒供应商 API 调用
    const simulateDelay = job.data.simulateDelay ?? 2000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, simulateDelay));

    // 按类型生成结果数据
    const data: Record<string, string> = {};
    switch (task.type) {
      case FulfillmentType.FLIGHT_TICKETING:
        data.pnr = genPnr();
        data.eTicketNumber = gen17DigitEticket();
        break;
      case FulfillmentType.HOTEL_BOOKING:
        data.confirmationNumber = 'HTL-' + Date.now().toString().slice(-8);
        break;
      case FulfillmentType.VISA_APPLICATION:
        data.applicationNumber = 'VSA-' + Date.now().toString().slice(-8);
        data.progress = '材料已提交，等待使馆审核';
        break;
      case FulfillmentType.TRANSFER_DISPATCH:
        data.driverName = pick(['Nguyen Van A', 'Tran Duc B', 'Le Minh C']);
        data.vehicleNumber = '43A-' + Math.floor(10000 + Math.random() * 90000);
        break;
      case FulfillmentType.BUNDLE_COMPOSITE:
        data.note = '套餐组件按子任务拆分（未实现）';
        break;
    }

    // 标 CONFIRMED
    await prisma.fulfillmentTask.update({
      where: { id: taskId },
      data: {
        status: FulfillmentStatus.CONFIRMED,
        completedAt: new Date(),
        data: data as Prisma.InputJsonValue,
      },
    });

    // FLIGHT 完成后把 PNR / e-ticket 写回 Passenger
    if (task.type === FulfillmentType.FLIGHT_TICKETING && data.pnr) {
      await prisma.passenger.updateMany({
        where: { orderId: task.orderItem.orderId },
        data: { pnr: data.pnr, eticketNumber: data.eTicketNumber },
      });
    }

    // eslint-disable-next-line no-console
    console.log(`[worker:fulfillment] ✓ task ${taskId} done (${task.orderItem.order.orderNumber})`);
    return { taskId, data };
  },
  {
    connection: bullRedis,
    concurrency: 5,
  },
);

fulfillmentWorker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker:fulfillment] ✗ job ${job?.id} failed:`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    // 最终失败：标任务 FAILED
    prisma.fulfillmentTask.update({
      where: { id: job.data.taskId },
      data: { status: FulfillmentStatus.FAILED, failureReason: err.message, completedAt: new Date() },
    }).catch(() => {/* best-effort */});
  }
});

// ══════════════════════════════════════════════════════════════════
// Notification Worker — 发短信/邮件（沙箱只 console.log）
// ══════════════════════════════════════════════════════════════════
const notificationWorker = new Worker<NotificationJobData>(
  'notification',
  async (job) => {
    const { type, to, subject, content } = job.data;
    // TODO: 接腾讯云 SMS / 阿里云邮件 / 微信模板消息
    // eslint-disable-next-line no-console
    console.log(`[worker:notification] ${type} → ${to}${subject ? ' · ' + subject : ''}`);
    // eslint-disable-next-line no-console
    console.log(`[worker:notification]   ${content.slice(0, 100)}`);
    return { sentAt: new Date().toISOString() };
  },
  { connection: bullRedis, concurrency: 10 },
);

// ══════════════════════════════════════════════════════════════════
// 优雅关闭
// ══════════════════════════════════════════════════════════════════
async function shutdown() {
  // eslint-disable-next-line no-console
  console.log('[worker] shutting down…');
  await Promise.all([
    fulfillmentWorker.close(),
    notificationWorker.close(),
  ]);
  await prisma.$disconnect();
  await bullRedis.quit();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// eslint-disable-next-line no-console
console.log(`[worker] started · NODE_ENV=${env.NODE_ENV} · redis=${env.REDIS_URL.split('@').pop()}`);

// ── helpers ──
function genPnr(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function gen17DigitEticket(): string {
  return '738-' + Math.floor(10000000000 + Math.random() * 90000000000);
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
