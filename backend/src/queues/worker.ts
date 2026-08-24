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
import {
  CabinClass,
  FulfillmentStatus,
  FulfillmentType,
  OrderItemKind,
  OrderStatus,
  Prisma,
  SeatLockStatus,
  WaitlistStatus,
} from '@prisma/client';
import {
  bullRedis,
  enqueueWaitlistCheck,
  type FulfillmentJobData,
  type NotificationJobData,
  type SeatHoldJobData,
  type SeatLockJobData,
  type WaitlistCheckJobData,
} from './queue.js';
import { closeMailer } from '../lib/mailer.js';
import { sendItineraryEmail } from '../lib/itinerary-email.js';
import { computeBundleSeatSplit, releaseSeatFloored } from '../modules/orders/orders.service.js';
import { REFUND_REQUESTED_FULFILLMENT_ERROR } from '../modules/fulfillment/fulfillment.service.js';
import { heldSeatsForSeatClass } from '../modules/hold-orders/held-seats.js';

/**
 * 超时释放某订单占用的座位——套餐升舱拆座感知 + 下限钳制在 0（MEDIUM 修复）。
 *
 * 抽成独立函数（而不是内联在 seatHoldWorker 的匿名回调里）供单测直接驱动——BullMQ 的
 * `new Worker(name, processor, opts)` 的 processor 是匿名回调，不好单独调用/断言。
 *
 * 与状态机释放分支（orders.service.ts `_updateStatusWithinTx` 的 releaseSeat）同一口径：
 *   - 按 item.metadata.businessUpgradeCount 拆分 BUSINESS/原舱位分别释放——旧版这里是扁平
 *     `sold - quantity` 只退原舱位，套餐升舱订单超时会漏退 BUSINESS、多退 ECONOMY（净释放量算
 *     对了但退错了舱，两边台账都不诚实）。
 *   - 用 releaseSeatFloored（GREATEST(0, sold-qty)）取代旧版 `sold >= qty` 才更新的写法——两者
 *     都不会打出负数，但 floor 版本即使某一侧 sold 已经因为其他 bug 偏离预期也不会卡死整条更新
 *     （旧版 `sold >= qty` 不满足时整条 UPDATE 直接不生效，released 状态和库存会不一致）。
 */
export async function releaseOrderSeatsForTimeout(
  tx: Prisma.TransactionClient,
  items: ReadonlyArray<{
    kind: OrderItemKind;
    flightScheduleId: string | null;
    flightCabin: CabinClass | null;
    quantity: number;
    metadata: Prisma.JsonValue;
  }>,
): Promise<void> {
  for (const item of items) {
    if (item.kind !== OrderItemKind.FLIGHT || !item.flightScheduleId || !item.flightCabin) continue;
    const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
    const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
    const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
    await releaseSeatFloored(tx, item.flightScheduleId, CabinClass.BUSINESS, split.business);
    await releaseSeatFloored(tx, item.flightScheduleId, item.flightCabin, split.sameCabin);
  }
}

// ══════════════════════════════════════════════════════════════════
// Fulfillment Worker — 处理出票 / 酒店预订 / 签证 / 接送
//
// 当前实现：sandbox 模拟供应商 API（延时后生成假 PNR/确认号）。
// 接入真实供应商时替换这部分逻辑即可。
// ══════════════════════════════════════════════════════════════════
/**
 * Fulfillment 任务处理器 —— 抽成独立命名函数（与本文件 releaseOrderSeatsForTimeout 同一做法）
 * 供单测直接驱动 CAS 写回分支：BullMQ 的 `new Worker(name, processor, opts)` 的 processor 是
 * 匿名回调，不好单独调用/断言。
 *
 * 竞态收口（取消 vs 出票）：claim 之后有一段 2-5s 供应商窗口，其间订单可能被取消——取消族会把
 * IN_PROGRESS 履约任务置 CANCELLED（见 orders.service `_updateStatusWithinTx` 履约任务终态化）。
 * 若完成时用无状态守卫的裸 update 落 CONFIRMED，会把 CANCELLED 抹成 CONFIRMED，还给已取消订单
 * 写回 PNR + 发行程单邮件。故完成写回改为 CAS（updateMany where status=IN_PROGRESS）：
 *   - count===1：CAS 成功，才写回 PNR / 发邮件；
 *   - count!==1：任务已被取消/改动 → 放弃写回 PNR、不发邮件、不覆盖状态，记一条日志。
 */
export async function processFulfillmentTask(
  job: { data: FulfillmentJobData; attemptsMade: number },
): Promise<Record<string, unknown>> {
  const { taskId } = job.data;
  // eslint-disable-next-line no-console
  console.log(`[worker:fulfillment] processing task ${taskId} (attempt ${job.attemptsMade + 1})`);

  const task = await prisma.fulfillmentTask.findUnique({
    where: { id: taskId },
    include: {
      orderItem: {
        include: { order: { select: { orderNumber: true, status: true, deletedAt: true } } },
      },
    },
  });
  if (!task) throw new Error(`Task ${taskId} not found`);

  // 退款申请中库存已释放：worker 可以看到任务，但不得开始会落 CONFIRMED 的自动履约。
  // 保留任务原状态，驳回回 PROCESSING 后仍可由原任务继续操作。
  if (task.orderItem.order.status === OrderStatus.REFUND_REQUESTED) {
    return { skipped: true, reason: REFUND_REQUESTED_FULFILLMENT_ERROR };
  }

  // 已完成或取消的任务直接跳过
  if (task.status === FulfillmentStatus.CONFIRMED || task.status === FulfillmentStatus.CANCELLED) {
    return { skipped: true, status: task.status };
  }

  // CAS 标 IN_PROGRESS —— 只在当前还是 PENDING 时抢占
  // 防止 reissue 并发、或 BullMQ retry 抖动造成两个 worker 同时执行 → 出双 PNR。
  const claimed = await prisma.fulfillmentTask.updateMany({
    where: {
      id: taskId,
      status: FulfillmentStatus.PENDING,
      orderItem: { order: { status: { not: OrderStatus.REFUND_REQUESTED } } },
    },
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

  // CAS 标 CONFIRMED —— 只在任务仍 IN_PROGRESS 时落终态。
  // 供应商窗口内订单若被取消（任务已 CANCELLED），此处 count 为 0 → 放弃写回，不覆盖终态。
  const confirmed = await prisma.fulfillmentTask.updateMany({
    where: {
      id: taskId,
      status: FulfillmentStatus.IN_PROGRESS,
      // 供应商窗口内若订单进入退款申请中，关系条件使最终 CONFIRMED CAS 直接落空。
      orderItem: { order: { status: { not: OrderStatus.REFUND_REQUESTED } } },
    },
    data: {
      status: FulfillmentStatus.CONFIRMED,
      completedAt: new Date(),
      data: data as Prisma.InputJsonValue,
    },
  });
  if (confirmed.count !== 1) {
    // 任务已被取消/改动（典型：供应商窗口内订单落取消族）→ 不写回 PNR、不发邮件、不覆盖状态。
    // eslint-disable-next-line no-console
    console.log(`[worker:fulfillment] ○ task ${taskId} 已被取消，跳过出票回写`);
    return { skipped: true, reason: 'task cancelled during supplier window' };
  }

  // FLIGHT 完成后把 PNR / e-ticket 写回 Passenger —— 仅在上面 CAS 成功后执行
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
}

const fulfillmentWorker = new Worker<FulfillmentJobData>('fulfillment', processFulfillmentTask, {
  connection: bullRedis,
  concurrency: 5,
});

fulfillmentWorker.on('failed', (job, err) => {
  // eslint-disable-next-line no-console
  console.error(`[worker:fulfillment] ✗ job ${job?.id} failed:`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    // 最终失败：CAS 标 FAILED —— 只在任务仍 IN_PROGRESS 时覆盖。
    // 供应商窗口内订单若被取消（任务已 CANCELLED），裸 update 会把 CANCELLED 抹成 FAILED；
    // 用 updateMany where status=IN_PROGRESS 收口，count!==1 则放弃（不覆盖终态）。
    prisma.fulfillmentTask.updateMany({
      where: { id: job.data.taskId, status: FulfillmentStatus.IN_PROGRESS },
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
//   2. releaseOrderSeatsForTimeout：按套餐升舱拆座（BUSINESS/原舱位分别退）+ 下限钳制在 0
//      （GREATEST(0, sold-qty)，见该函数注释）
//   3. 订单状态 → PAYMENT_TIMEOUT + 写 OrderStatusEvent
// ══════════════════════════════════════════════════════════════════
const seatHoldWorker = new Worker<SeatHoldJobData>(
  'seat-hold',
  async (job) => {
    const { orderId } = job.data;
    // eslint-disable-next-line no-console
    console.log(`[worker:seat-hold] checking expiry for order ${orderId}`);

    // 轻量预检（事务外）：仅用于快速跳过——已支付/已取消/不限时/已延期的单不必开事务。
    // 非权威：真正的释放决策在下面事务内 FOR UPDATE 锁 + 事务内复核。seat-hold 任务约在建单
    // 30 分钟后触发，多数单此刻已 PAID/CANCELLED，此预检让常见路径免开事务。
    const pre = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, paymentExpiresAt: true },
    });
    if (!pre) return { skipped: true, reason: 'order not found' };

    // 幂等：非 PENDING_PAYMENT 直接跳过
    if (pre.status !== OrderStatus.PENDING_PAYMENT) {
      return { skipped: true, reason: `status=${pre.status}` };
    }

    // 不限时订单（后台/代理录入，paymentExpiresAt=null）→ 机位永不自动释放，直接跳过。
    // 正常路径下这类单不会入队；此为防御性兜底，避免 null 被当成「已超时」而误放机位。
    if (!pre.paymentExpiresAt) {
      return { skipped: true, reason: 'no payment timeout (staff/agent-entered)' };
    }

    // 已手动延长过期时间（e.g. 客户协商）→ 重新排队剩余时长
    if (pre.paymentExpiresAt.getTime() > Date.now()) {
      return { skipped: true, reason: 'expiresAt extended', requeueSuggested: true };
    }

    // 事务：FOR UPDATE 锁 Order 行 → 事务内读最新 items → 释放座位 → 二次 CAS 标 PAYMENT_TIMEOUT。
    //
    // R2 收口（超时 vs 改期双放/幽灵持有）：旧版把 order+items 快照读在事务外，改期（换舱 A→B，
    // 改期不改 status，超时 worker 的 status CAS 拦不住 PENDING_PAYMENT 单）若挤在读快照与释放之间，
    // 就会按旧快照再释放 A 一次（双放）、B 挂已超时单幽灵持有。这里对 Order 行 FOR UPDATE 行锁
    // （对齐 payments/settlements 现有写法），并把 items 的读移进事务内：与改期串行化——谁先拿锁谁先
    // 提交，释放按事务内最新 items 执行，不会用事务外旧快照双放旧舱 / 漏挂新舱。
    // 注：完整对称还需改期侧 rescheduleOrderItem 也对 Order 行 FOR UPDATE（在 orders.service，另棒处理）。
    let releasedItems: Array<{
      kind: OrderItemKind;
      flightScheduleId: string | null;
      flightCabin: CabinClass | null;
      quantity: number;
      metadata: Prisma.JsonValue;
    }> = [];
    let released = false;

    await prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁 Order 行 —— 事务内串行化改期/支付到达等并发写。
      const locked = await tx.$queryRaw<
        Array<{ id: string; status: OrderStatus; paymentExpiresAt: Date | null }>
      >`SELECT id, status, "paymentExpiresAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const row = locked[0];
      if (!row) return; // 订单已被删 → 跳过

      // 拿锁后事务内复核：预检与拿锁之间状态可能已变（支付到达 / 取消 / 延期）。
      if (row.status !== OrderStatus.PENDING_PAYMENT) return;
      if (!row.paymentExpiresAt || row.paymentExpiresAt.getTime() > Date.now()) return;

      // 事务内读最新 items —— 改期已换舱则读到新舱，释放据此执行（R2 核心）。
      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: {
          kind: true,
          flightScheduleId: true,
          flightCabin: true,
          quantity: true,
          metadata: true,
        },
      });
      await releaseOrderSeatsForTimeout(tx, items);

      // 二次 CAS — 只在状态仍是 PENDING_PAYMENT 时更新。
      // 锁内已复核为 PENDING_PAYMENT，正常必 count=1；兜底：若竟被并发改动则抛错回滚（含座位释放）。
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

      releasedItems = items;
      released = true;
    });

    // 拿锁后复核不再符合释放条件（支付到达 / 取消 / 延期）→ 未释放，直接跳过。
    if (!released) {
      return { skipped: true, reason: 'not eligible after lock' };
    }

    // eslint-disable-next-line no-console
    console.log(`[worker:seat-hold] ✓ order ${orderId} expired + seats released`);

    // 座位已释放 → 排队候补检查（best-effort，失败不影响释放结果）
    try {
      for (const item of releasedItems) {
        if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
        const sc = await prisma.flightSeatClass.findFirst({
          where: { scheduleId: item.flightScheduleId, cabin: item.flightCabin },
          select: { id: true },
        });
        if (sc) await enqueueWaitlistCheck(sc.id);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[worker:seat-hold] failed to enqueue waitlist-check for order ${orderId}:`, err);
    }

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

      // 锁位过期 → 座位回归可售，排队候补检查（best-effort）
      try {
        const lock = await prisma.seatLock.findUnique({
          where: { id: lockId },
          select: { seatClassId: true },
        });
        if (lock) await enqueueWaitlistCheck(lock.seatClassId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[worker:seat-lock] failed to enqueue waitlist-check for lock ${lockId}:`, err);
      }
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
//
// 额外承载 'waitlist-check' 任务：座位释放后检查该舱位最早的 ACTIVE 候补，
// 余量够则 CAS 标 NOTIFIED（真实短信通知后续接入，当前按占位模式只打日志）。
// ══════════════════════════════════════════════════════════════════
const notificationWorker = new Worker<NotificationJobData | WaitlistCheckJobData>(
  'notification',
  async (job) => {
    if (job.name === 'waitlist-check') {
      return processWaitlistCheck((job.data as WaitlistCheckJobData).seatClassId);
    }
    const { type, to, subject, content } = job.data as NotificationJobData;
    // TODO: 接腾讯云 SMS / 阿里云邮件 / 微信模板消息
    // eslint-disable-next-line no-console
    console.log(`[worker:notification] ${type} → ${to}${subject ? ' · ' + subject : ''}`);
    // eslint-disable-next-line no-console
    console.log(`[worker:notification]   ${content.slice(0, 100)}`);
    return { sentAt: new Date().toISOString() };
  },
  { connection: bullRedis, concurrency: 10 },
);

/**
 * 候补检查：该舱位最早的 ACTIVE 候补，若当前可售余量（capacity - sold -
 * ACTIVE 未过期锁位 - 占位余座）≥ 其登记张数则 CAS 标 NOTIFIED。一次只通知一条 ——
 * 下一次座位释放再检查下一条（先来先到，避免一次放量引发并发抢座纠纷）。
 */
async function processWaitlistCheck(seatClassId: string) {
  const entry = await prisma.seatWaitlist.findFirst({
    where: { seatClassId, status: WaitlistStatus.ACTIVE },
    orderBy: { createdAt: 'asc' },
    include: {
      flightSchedule: { select: { flight: { select: { flightNumber: true } } } },
      seatClass: { select: { cabin: true, capacity: true, sold: true } },
    },
  });
  if (!entry) return { seatClassId, skipped: true, reason: 'no active waitlist' };

  const lockedAgg = await prisma.seatLock.aggregate({
    _sum: { qty: true },
    where: { seatClassId, status: SeatLockStatus.ACTIVE, expiresAt: { gt: new Date() } },
  });
  const held = await heldSeatsForSeatClass(prisma, seatClassId);
  const available = entry.seatClass.capacity - entry.seatClass.sold - (lockedAgg._sum.qty ?? 0) - held;
  if (available < entry.qty) {
    return { seatClassId, skipped: true, reason: `available=${available} < qty=${entry.qty}` };
  }

  // 原子 CAS：只在仍 ACTIVE 时标 NOTIFIED（防并发重复通知）
  const upd = await prisma.seatWaitlist.updateMany({
    where: { id: entry.id, status: WaitlistStatus.ACTIVE },
    data: { status: WaitlistStatus.NOTIFIED },
  });
  if (upd.count !== 1) {
    return { seatClassId, skipped: true, reason: 'entry status changed concurrently' };
  }

  // TODO: 接腾讯云 SMS / 微信模板消息（与上方 notification 占位同批接入）
  // eslint-disable-next-line no-console
  console.log(
    `[worker:notification] SMS → ${entry.contactPhone} · 候补有票提醒 ` +
      `${entry.flightSchedule.flight.flightNumber} ${entry.seatClass.cabin} ×${entry.qty}（entry ${entry.id} → NOTIFIED）`,
  );
  return { seatClassId, notifiedEntryId: entry.id };
}

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
