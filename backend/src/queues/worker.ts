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
import { FulfillmentStatus, FulfillmentType, OrderStatus, Prisma, SeatLockStatus } from '@prisma/client';
import {
  bullRedis,
  type FulfillmentJobData,
  type NotificationJobData,
  type SeatHoldJobData,
  type SeatLockJobData,
} from './queue.js';
import { closeMailer } from '../lib/mailer.js';
import { sendItineraryEmail } from '../lib/itinerary-email.js';

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

    // CAS 标 IN_PROGRESS —— 只在当前还是 PENDING 时抢占
    // 防止 reissue 并发、或 BullMQ retry 抖动造成两个 worker 同时执行 → 出双 PNR。
    const claimed = await prisma.fulfillmentTask.updateMany({
      where: { id: taskId, status: FulfillmentStatus.PENDING },
      data: {
        status: FulfillmentStatus.IN_PROGRESS,
        startedAt: task.startedAt ?? new Date(),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      // 别的 worker 抢到了；直接退出（幂等）
      return { skipped: true, reason: 'claim race lost' };
    }

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

      // 渲染 PDF + 发邮件（非阻塞主流程，失败进 catch）
      void sendItineraryEmail(task.orderItem.orderId).catch((e) => {
        // eslint-disable-next-line no-console
        console.error(`[worker:fulfillment] itinerary email failed for order ${task.orderItem.orderId}:`, e);
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
// Seat-Hold Expiry Worker — 订单超时未支付自动取消并释放座位
//
// 触发：createOrder 时排队 delay = paymentExpiresAt - now（~30 min）。
// 执行：
//   1. 查订单；若已 PAID / CANCELLED / PAYMENT_TIMEOUT 直接退出（幂等）
//   2. 对每个 FLIGHT item 做 `UPDATE sold = sold - qty WHERE sold >= qty`（CAS 防负值）
//   3. 订单状态 → PAYMENT_TIMEOUT + 写 OrderStatusEvent
// ══════════════════════════════════════════════════════════════════
const seatHoldWorker = new Worker<SeatHoldJobData>(
  'seat-hold',
  async (job) => {
    const { orderId } = job.data;
    // eslint-disable-next-line no-console
    console.log(`[worker:seat-hold] checking expiry for order ${orderId}`);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return { skipped: true, reason: 'order not found' };

    // 幂等：非 PENDING_PAYMENT 直接跳过
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      return { skipped: true, reason: `status=${order.status}` };
    }

    // 已手动延长过期时间（e.g. 客户协商）→ 重新排队剩余时长
    if (order.paymentExpiresAt && order.paymentExpiresAt.getTime() > Date.now()) {
      return { skipped: true, reason: 'expiresAt extended', requeueSuggested: true };
    }

    // 事务：释放座位 + 标订单 PAYMENT_TIMEOUT
    await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
        await tx.$executeRaw`
          UPDATE "FlightSeatClass"
          SET sold = sold - ${item.quantity}, "updatedAt" = NOW()
          WHERE "scheduleId" = ${item.flightScheduleId}
            AND cabin = ${item.flightCabin}::"CabinClass"
            AND sold >= ${item.quantity}
        `;
      }

      // 二次 CAS — 只在状态仍是 PENDING_PAYMENT 时更新
      // 如果别人刚刚改了状态（e.g. 支付到达），抛错让整个 tx 回滚（包括座位释放）
      const upd = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
        data: { status: OrderStatus.PAYMENT_TIMEOUT },
      });
      if (upd.count === 0) {
        throw new Error('ORDER_STATUS_CHANGED_DURING_EXPIRY');
      }

      await tx.orderStatusEvent.create({
        data: {
          orderId,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.PAYMENT_TIMEOUT,
          reason: '支付超时自动取消 — 释放座位',
        },
      });
    });

    // eslint-disable-next-line no-console
    console.log(`[worker:seat-hold] ✓ order ${orderId} expired + seats released`);
    return { orderId, released: true };
  },
  { connection: bullRedis, concurrency: 5 },
);

seatHoldWorker.on('failed', (job, err) => {
  // 正常情况（支付刚到达）我们主动抛 ORDER_STATUS_CHANGED_DURING_EXPIRY 让 tx 回滚，
  // 这不算真故障。其他错误才告警。
  if (err.message === 'ORDER_STATUS_CHANGED_DURING_EXPIRY') {
    // eslint-disable-next-line no-console
    console.log(`[worker:seat-hold] ○ order ${job?.data.orderId} paid or cancelled during expiry race`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`[worker:seat-hold] ✗ job ${job?.id} failed:`, err.message);
});

// ══════════════════════════════════════════════════════════════════
// Seat-Lock Expiry Worker — 锁位 10 分钟到期自动失效
//
// 触发：seat-locks.service.createLock 时排队 delay = expiresAt - now（10 min）。
// 执行：只在锁仍 ACTIVE 时标 EXPIRED（幂等）；已消费/已释放的锁不动。
// 注：所有可用量查询都按 status=ACTIVE AND expiresAt > now 惰性过滤，
//     正确性不依赖本 worker 准时执行 —— 这里只是把状态落库方便排查。
// ══════════════════════════════════════════════════════════════════
const seatLockWorker = new Worker<SeatLockJobData>(
  'seat-lock',
  async (job) => {
    const { lockId } = job.data;
    const upd = await prisma.seatLock.updateMany({
      where: { id: lockId, status: SeatLockStatus.ACTIVE },
      data: { status: SeatLockStatus.EXPIRED },
    });
    if (upd.count === 1) {
      // eslint-disable-next-line no-console
      console.log(`[worker:seat-lock] ✓ lock ${lockId} expired`);
    }
    return { lockId, expired: upd.count === 1 };
  },
  { connection: bullRedis, concurrency: 5 },
);

seatLockWorker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker:seat-lock] ✗ job ${job?.id} failed:`, err.message);
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
    seatHoldWorker.close(),
    seatLockWorker.close(),
    notificationWorker.close(),
  ]);
  await closeMailer();
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
