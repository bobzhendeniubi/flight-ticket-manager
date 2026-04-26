/**
 * 订单服务 — 下单 / 列表 / 详情 / 状态流转。
 *
 * 核心逻辑：
 * 1. 下单事务：乘客=机票张数校验 → 查班次余票 → 动态定价重算 → 写 Order+Item+Passenger → 扣减 sold
 * 2. 状态机：DRAFT → PENDING_PAYMENT → PAID → PROCESSING → TICKETED → COMPLETED
 *    分支：PENDING_PAYMENT → CANCELLED；PAID → REFUND_REQUESTED → REFUNDED
 * 3. RBAC：
 *    - ADMIN/STAFF：全部订单 + 全部状态转移
 *    - AGENT：仅看本人 + 下级代理的订单；仅允许 DRAFT → PENDING_PAYMENT
 *    - CUSTOMER：仅本人订单；仅允许取消 PENDING_PAYMENT
 * 4. 幂等：idempotencyKey 存在则直接返回已有订单（保护客户端重试）
 */
import {
  CommissionStatus,
  OrderItemKind,
  OrderStatus,
  PaymentMethod,
  Prisma,
  ProductKind,
  UserRole,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { PricingService } from '../pricing/pricing.service.js';
import type {
  CreateOrderBody,
  ListOrdersQuery,
  OrderItemInput,
  PassengerInput,
} from './orders.schemas.js';

// ── 状态机：允许的转移 ──────────────────────────────────────────────────
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['PAID', 'PAYMENT_TIMEOUT', 'CANCELLED'],
  PAID: ['PROCESSING', 'TICKETED', 'REFUND_REQUESTED'],
  PROCESSING: ['TICKETED', 'FAILED', 'REFUND_REQUESTED'],
  TICKETED: ['COMPLETED', 'CHANGE_REQUESTED', 'REFUND_REQUESTED'],
  COMPLETED: [], // 终态
  PAYMENT_TIMEOUT: ['PENDING_PAYMENT', 'CANCELLED'],
  CANCELLED: [], // 终态
  REFUND_REQUESTED: ['REFUNDED', 'PROCESSING'], // 被拒回退到 PROCESSING
  REFUNDED: [], // 终态
  CHANGE_REQUESTED: ['CHANGED', 'TICKETED'],
  CHANGED: ['COMPLETED', 'REFUND_REQUESTED'],
  FAILED: ['PROCESSING', 'REFUND_REQUESTED', 'CANCELLED'],
};

// 哪些状态视为"占用座位"（需要扣库存）
const SEAT_HOLDING_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGE_REQUESTED',
  'CHANGED',
  'REFUND_REQUESTED',
];

const SEAT_RELEASING_STATUSES: OrderStatus[] = [
  'CANCELLED',
  'PAYMENT_TIMEOUT',
  'REFUNDED',
  'FAILED',
];

// ── 类型 ────────────────────────────────────────────────────────────────
export interface OrderRequester {
  userId: string;
  role: UserRole;
  /** 当前登录代理的 agentId（如果是 AGENT） */
  agentId?: string;
  /** 显式区分系统操作（支付回调 / cron）与真实用户，而非靠 userId 字符串前缀 */
  actorType?: 'USER' | 'SYSTEM';
}

export class OrderService {
  private readonly pricing = new PricingService();

  // ════════════════════════════════════════════════════════════════════
  // 下单
  // ════════════════════════════════════════════════════════════════════
  async createOrder(body: CreateOrderBody, requester: OrderRequester) {
    // 幂等：提前查 key 是否已存在
    if (body.idempotencyKey) {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
        include: { items: true, passengers: true },
      });
      if (existing) return existing;
    }

    // 机票张数 = 乘客数 校验
    const flightQty = body.items
      .filter((i) => i.kind === 'FLIGHT')
      .reduce((sum, i) => sum + i.quantity, 0);
    if (flightQty > 0 && flightQty !== body.passengers.length) {
      throw new BadRequestError(
        `机票 ${flightQty} 张，必须填 ${flightQty} 位乘客（当前 ${body.passengers.length} 位）`,
      );
    }

    // 先查所有 FLIGHT item 对应的 FlightSeatClass + 计算动态价（在事务外查，避免长事务）
    const pricedItems = await this.priceAndValidateItems(body.items);

    const subtotal = pricedItems.reduce((sum, p) => sum + p.amount, 0);
    const total = subtotal; // 目前没有 taxes / discount，直接等于 subtotal

    // 代理身份判定：非 AGENT 则 agentId=null
    const agentId = requester.role === 'AGENT' ? (requester.agentId ?? null) : null;

    // 生成订单号（有极小概率撞 unique，重试 3 次）
    const orderNumber = await generateOrderNumber();

    // 事务：原子扣座位（CAS 防超卖）→ 写订单 → 写事件
    const order = await prisma.$transaction(async (tx) => {
      // 用 updateMany 的 where 条件做原子"检查+扣减"一步到位，避免 TOCTOU
      // where: `sold + qty <= capacity` 等价于 Prisma-expressible `capacity - qty >= sold`
      // 但 Prisma raw 不支持这种 cross-column where；用 sold + qty <= capacity 需要
      // SQL 函数，改用 raw SQL 保证原子性。
      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT') continue;
        const affected = await tx.$executeRaw`
          UPDATE "FlightSeatClass"
          SET sold = sold + ${p.quantity}, "updatedAt" = NOW()
          WHERE "scheduleId" = ${p.flightScheduleId}
            AND cabin = ${p.flightCabin}::"CabinClass"
            AND sold + ${p.quantity} <= capacity
        `;
        if (affected !== 1) {
          // 查当前库存给更友好的错误消息
          const sc = await tx.flightSeatClass.findFirst({
            where: { scheduleId: p.flightScheduleId!, cabin: p.flightCabin! },
            select: { capacity: true, sold: true },
          });
          const available = sc ? sc.capacity - sc.sold : 0;
          throw new ConflictError(
            `${p.flightCabin} 余票不足：需要 ${p.quantity} 张，仅剩 ${available} 张（并发抢占）`,
          );
        }
      }

      // 初始状态直接 PENDING_PAYMENT（MVP 阶段没有 DRAFT 保存流）
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: requester.userId,
          agentId,
          status: OrderStatus.PENDING_PAYMENT,
          currency: 'CNY',
          subtotal: new Prisma.Decimal(subtotal),
          total: new Prisma.Decimal(total),
          contactName: body.contactName,
          contactPhone: body.contactPhone,
          contactEmail: body.contactEmail,
          paymentExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 分钟后超时
          idempotencyKey: body.idempotencyKey,
          notes: body.notes,
          items: {
            create: pricedItems.map((p) => ({
              kind: p.kind,
              description: p.description,
              quantity: p.quantity,
              unitPrice: new Prisma.Decimal(p.unitPrice),
              amount: new Prisma.Decimal(p.amount),
              flightScheduleId: p.flightScheduleId ?? null,
              flightCabin: p.flightCabin ?? null,
              hotelRoomTypeId: p.hotelRoomTypeId ?? null,
              hotelCheckIn: p.hotelCheckIn ?? null,
              hotelCheckOut: p.hotelCheckOut ?? null,
              transferId: p.transferId ?? null,
              visaId: p.visaId ?? null,
              bundleId: p.bundleId ?? null,
              metadata: (p.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
            })),
          },
          passengers: {
            create: body.passengers.map((px) => passengerToData(px)),
          },
          statusEvents: {
            create: {
              fromStatus: null,
              toStatus: OrderStatus.PENDING_PAYMENT,
              actorUserId: requester.userId,
              reason: '订单创建',
            },
          },
        },
        include: { items: true, passengers: true, statusEvents: true },
      });

      // 座位已在订单 create 之前原子扣减；此处无需再动库存
      return created;
    });

    // 事务成功后：排队 seat-hold 自动释放任务（订单未在 paymentExpiresAt 内支付则取消）
    const holdMs = order.paymentExpiresAt
      ? Math.max(0, order.paymentExpiresAt.getTime() - Date.now())
      : 30 * 60 * 1000;
    try {
      const { scheduleSeatHoldRelease } = await import('../../queues/queue.js');
      await scheduleSeatHoldRelease(order.id, holdMs);
    } catch (err) {
      // 排队失败不阻塞下单 —— 但记录到日志，值班可能要手动兜底
      // eslint-disable-next-line no-console
      console.error('[orders] failed to schedule seat-hold release for', order.id, err);
    }

    return order;
  }

  // ════════════════════════════════════════════════════════════════════
  // 定价 + 校验（事务外，节省行锁时间）
  // ════════════════════════════════════════════════════════════════════
  private async priceAndValidateItems(items: OrderItemInput[]) {
    const priced: Array<{
      kind: OrderItemKind;
      description: string;
      quantity: number;
      unitPrice: number;
      amount: number;
      flightScheduleId?: string;
      flightCabin?: import('@prisma/client').CabinClass;
      hotelRoomTypeId?: string;
      hotelCheckIn?: Date;
      hotelCheckOut?: Date;
      transferId?: string;
      visaId?: string;
      bundleId?: string;
      metadata?: Record<string, unknown>;
    }> = [];

    for (const item of items) {
      if (item.kind === 'FLIGHT') {
        // 动态定价重算 — 这是唯一权威价格源
        const pricing = await this.pricing.calculatePrice(
          item.flightScheduleId,
          item.flightCabin,
          item.quantity,
        );
        priced.push({
          kind: 'FLIGHT',
          description: item.description,
          quantity: item.quantity,
          unitPrice: pricing.averageUnitPrice,
          amount: pricing.totalPrice,
          flightScheduleId: item.flightScheduleId,
          flightCabin: item.flightCabin,
          metadata: {
            ...(item.metadata ?? {}),
            dateRank: pricing.dateRank,
            dateMultiplier: pricing.dateMultiplier,
            perSeatBreakdown: pricing.perSeatBreakdown,
          },
        });
      } else if (item.kind === 'HOTEL') {
        // 服务端权威定价：有 hotelRoomTypeId 就从 DB 查，不信任前端 unitPrice
        let unitPrice = item.unitPrice;
        if (item.hotelRoomTypeId) {
          const rt = await prisma.hotelRoomType.findUnique({
            where: { id: item.hotelRoomTypeId },
            select: { basePrice: true, hotel: { select: { isActive: true } } },
          });
          if (!rt) throw new NotFoundError(`酒店房型 ${item.hotelRoomTypeId} 不存在`);
          if (!rt.hotel.isActive) throw new BadRequestError('酒店已下架');
          unitPrice = Number(rt.basePrice);
        }
        priced.push({
          kind: 'HOTEL',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          amount: Math.round(unitPrice * item.quantity),
          hotelRoomTypeId: item.hotelRoomTypeId,
          hotelCheckIn: item.checkIn ? new Date(item.checkIn) : undefined,
          hotelCheckOut: item.checkOut ? new Date(item.checkOut) : undefined,
          metadata: item.metadata,
        });
      } else if (item.kind === 'TRANSFER') {
        let unitPrice = item.unitPrice;
        if (item.transferId) {
          const t = await prisma.transfer.findUnique({
            where: { id: item.transferId },
            select: { basePrice: true, isActive: true },
          });
          if (!t) throw new NotFoundError(`接送产品 ${item.transferId} 不存在`);
          if (!t.isActive) throw new BadRequestError('接送产品已下架');
          unitPrice = Number(t.basePrice);
        }
        priced.push({
          kind: 'TRANSFER',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          amount: Math.round(unitPrice * item.quantity),
          transferId: item.transferId,
          metadata: item.metadata,
        });
      } else if (item.kind === 'VISA') {
        let unitPrice = item.unitPrice;
        if (item.visaId) {
          const v = await prisma.visa.findUnique({
            where: { id: item.visaId },
            select: { basePrice: true, expressSurcharge: true, isActive: true },
          });
          if (!v) throw new NotFoundError(`签证产品 ${item.visaId} 不存在`);
          if (!v.isActive) throw new BadRequestError('签证产品已下架');
          const baseUnitPrice = Number(v.basePrice);
          const express = Boolean(item.metadata?.express);
          unitPrice = express && v.expressSurcharge
            ? baseUnitPrice + Number(v.expressSurcharge)
            : baseUnitPrice;
        }
        priced.push({
          kind: 'VISA',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          amount: Math.round(unitPrice * item.quantity),
          visaId: item.visaId,
          metadata: item.metadata,
        });
      } else if (item.kind === 'BUNDLE') {
        // BUNDLE：服务端重算套餐价（items 从 DB 取 + groundDiscount）
        const bundle = await prisma.bundle.findUnique({
          where: { id: item.bundleId },
          select: { items: true, groundDiscount: true, isActive: true },
        });
        if (!bundle) throw new NotFoundError(`套餐 ${item.bundleId} 不存在`);
        if (!bundle.isActive) throw new BadRequestError('套餐已下架');
        // 地面部分价：sum(items[kind!==FLIGHT].qty * unitPrice) - groundDiscount
        // （机票部分留给 FLIGHT item 单独动态定价）
        const bundleItems = (bundle.items as Array<{ kind: string; qty: number; unitPrice: number }>) ?? [];
        const groundTotal = bundleItems
          .filter((b) => b.kind !== 'FLIGHT')
          .reduce((s, b) => s + b.qty * b.unitPrice, 0);
        const bundleUnitPrice = Math.max(0, Math.round(groundTotal - Number(bundle.groundDiscount)));
        priced.push({
          kind: 'BUNDLE',
          description: item.description,
          quantity: item.quantity,
          unitPrice: bundleUnitPrice,
          amount: bundleUnitPrice * item.quantity,
          bundleId: item.bundleId,
          metadata: item.metadata,
        });
      }
    }

    return priced;
  }

  // ════════════════════════════════════════════════════════════════════
  // 列表
  // ════════════════════════════════════════════════════════════════════
  async listOrders(query: ListOrdersQuery, requester: OrderRequester) {
    const where: Prisma.OrderWhereInput = {};

    // RBAC 过滤 — 先建基准可见集合，再按 query 过滤（但 query.agentId 不能覆盖可见集合）
    let visibleAgentIds: string[] | null = null; // null = 无限制（ADMIN/STAFF）
    if (requester.role === 'CUSTOMER') {
      where.userId = requester.userId;
    } else if (requester.role === 'AGENT') {
      visibleAgentIds = await this.getDescendantAgentIds(requester.agentId);
      where.agentId = { in: visibleAgentIds };
    }
    // ADMIN/STAFF: visibleAgentIds 保持 null，无额外过滤

    if (query.status) where.status = query.status;
    if (query.agentId) {
      // agentId 过滤 — 必须在可见集合内才生效，否则 403（防横向越权）
      if (visibleAgentIds !== null && !visibleAgentIds.includes(query.agentId)) {
        throw new ForbiddenError('无权查看该代理的订单');
      }
      where.agentId = query.agentId;
    }
    if (query.kind) where.items = { some: { kind: query.kind } };
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
        ...(query.to ? { lte: new Date(`${query.to}T23:59:59Z`) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { contactName: { contains: query.search, mode: 'insensitive' } },
        { contactPhone: { contains: query.search } },
      ];
    }

    const [rows, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        include: {
          items: true,
          passengers: { select: { id: true, fullName: true } },
          agent: { select: { id: true, companyName: true, contactName: true } },
          user: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders: rows.map(serializeOrder),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 详情
  // ════════════════════════════════════════════════════════════════════
  async getOrder(id: string, requester: OrderRequester) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        passengers: true,
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true } },
        user: { select: { id: true, displayName: true, email: true } },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);
    return serializeOrder(order);
  }

  // ════════════════════════════════════════════════════════════════════
  // 状态流转
  // ════════════════════════════════════════════════════════════════════
  async updateStatus(
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason?: string,
  ) {
    // 收集事务里创建的任务 id，提交后再入队（避免 worker 在 tx 提交前查不到）
    const pendingFulfillmentTaskIds: string[] = [];

    const updated = await prisma.$transaction(async (tx) => {
      return this._updateStatusWithinTx(tx, id, toStatus, requester, reason, pendingFulfillmentTaskIds);
    });

    // 事务提交后 enqueue fulfillment jobs（若有）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        // 确定性 jobId = taskId 做去重，防重复 enqueue
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[orders] failed to enqueue fulfillment task:', e);
        });
      }
    }

    // 终态（PAID / CANCELLED / PAYMENT_TIMEOUT）都不再需要 seat-hold 兜底
    if (toStatus === 'PAID' || toStatus === 'CANCELLED' || toStatus === 'PAYMENT_TIMEOUT') {
      try {
        const { cancelSeatHoldRelease } = await import('../../queues/queue.js');
        await cancelSeatHoldRelease(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to cancel seat-hold job for', id, err);
      }
    }

    return serializeOrder(updated);
  }

  /**
   * 事务内执行状态流转 —— 供 payments.handleCallback 等外部事务复用。
   * 调用方负责包 $transaction 且提交后 enqueue newTaskIdsOut 里的任务。
   */
  async _updateStatusWithinTx(
    tx: Prisma.TransactionClient,
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason: string | undefined,
    newTaskIdsOut: string[],
  ) {
    const order = await tx.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanTransition(order, toStatus, requester);

    const allowed = ALLOWED_TRANSITIONS[order.status];
    if (!allowed.includes(toStatus)) {
      throw new BadRequestError(
        `不允许从 ${order.status} 转移到 ${toStatus}（允许：${allowed.join(', ') || '无'}）`,
      );
    }

    const wasHolding = SEAT_HOLDING_STATUSES.includes(order.status);
    const isReleasing = SEAT_RELEASING_STATUSES.includes(toStatus);

    const isSystemActor = requester.actorType === 'SYSTEM' || requester.userId.startsWith('system-');

    // ── 原子 CAS：where 附加当前状态，防并发重复转移（如两个支付回调同时来）──
    const extraData: Record<string, unknown> = { status: toStatus };
    if (toStatus === 'PAID') extraData.paidAmount = order.total;

    const casResult = await tx.order.updateMany({
      where: { id, status: order.status },
      data: extraData,
    });
    if (casResult.count !== 1) {
      throw new ConflictError(`订单状态已被并发修改（期望 ${order.status}，请重试）`);
    }

    await tx.orderStatusEvent.create({
      data: {
        orderId: id,
        fromStatus: order.status,
        toStatus,
        actorUserId: isSystemActor ? null : requester.userId,
        reason,
      },
    });

    if (wasHolding && isReleasing) {
      for (const item of order.items) {
        if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
        await tx.flightSeatClass.updateMany({
          where: { scheduleId: item.flightScheduleId, cabin: item.flightCabin },
          data: { sold: { decrement: item.quantity } },
        });
      }
    }

    if (toStatus === 'PAID') {
      if (order.agentId) {
        await createCommissionsForOrder(tx, order.id, order.agentId);
      }
      const newIds = await createFulfillmentTasks(tx, order.id);
      newTaskIdsOut.push(...newIds);
    }

    if (isReleasing && wasHolding && order.status !== 'PENDING_PAYMENT') {
      await tx.commissionRecord.updateMany({
        where: { orderId: order.id, status: CommissionStatus.ACCRUED },
        data: { status: CommissionStatus.REVERSED },
      });
    }

    // 同步 Refund 状态：当订单走到终态时，关联的 REQUESTED Refund 应该相应推进
    //   REFUNDED   → Refund.COMPLETED + processedAt（管理员批准退款）
    //   CANCELLED  → Refund.REJECTED（管理员拒绝退款，订单回滚到取消但不退）
    // （这是给 admin PATCH /orders/:id/status 兜底；前面 requestCancellation 创建的 Refund
    //  停在 REQUESTED 等待这一步推进）
    if (toStatus === 'REFUNDED') {
      await tx.refund.updateMany({
        where: { orderId: id, status: 'REQUESTED' },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
    } else if (toStatus === 'CANCELLED') {
      await tx.refund.updateMany({
        where: { orderId: id, status: 'REQUESTED' },
        data: { status: 'REJECTED', processedAt: new Date() },
      });
    }

    return tx.order.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        passengers: true,
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true } },
        user: { select: { id: true, displayName: true, email: true } },
      },
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // 权限校验
  // ════════════════════════════════════════════════════════════════════
  private async assertCanView(order: { userId: string; agentId: string | null }, requester: OrderRequester) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'CUSTOMER') {
      if (order.userId !== requester.userId) throw new ForbiddenError('无权查看该订单');
      return;
    }
    if (requester.role === 'AGENT') {
      const ids = await this.getDescendantAgentIds(requester.agentId);
      if (!order.agentId || !ids.includes(order.agentId)) {
        throw new ForbiddenError('无权查看该订单');
      }
    }
  }

  private async assertCanTransition(
    order: { userId: string; agentId: string | null; status: OrderStatus },
    toStatus: OrderStatus,
    requester: OrderRequester,
  ) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'CUSTOMER') {
      if (order.userId !== requester.userId) throw new ForbiddenError('无权操作该订单');
      // 客户允许的状态流转：
      //   1. PENDING_PAYMENT → CANCELLED （直接取消未支付订单）
      //   2. PAID / PROCESSING / TICKETED → REFUND_REQUESTED （申请取消已支付订单）
      const allowed =
        (toStatus === 'CANCELLED' && order.status === 'PENDING_PAYMENT') ||
        (toStatus === 'REFUND_REQUESTED' &&
          (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED'));
      if (!allowed) {
        throw new ForbiddenError(
          `客户不可将订单 ${order.status} → ${toStatus}（仅允许取消待支付订单 / 申请已支付订单退款）`,
        );
      }
      return;
    }
    if (requester.role === 'AGENT') {
      const ids = await this.getDescendantAgentIds(requester.agentId);
      if (!order.agentId || !ids.includes(order.agentId)) {
        throw new ForbiddenError('无权操作该订单');
      }
      // 代理替自己树内客户申请退款
      if (toStatus === 'REFUND_REQUESTED' &&
          (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED')) {
        return;
      }
      throw new ForbiddenError('代理仅可代客户申请取消（其他状态流转请联系运营）');
    }
  }

  // 查自己 + 所有后代代理 id — 用 PostgreSQL 递归 CTE 一次查完
  // 之前是按层 BFS 每层一次 findMany，代理树深就会放大 N 倍
  private async getDescendantAgentIds(agentId: string | undefined): Promise<string[]> {
    if (!agentId) return [];
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE agent_tree AS (
        SELECT id FROM "Agent" WHERE id = ${agentId}
        UNION ALL
        SELECT a.id FROM "Agent" a
        INNER JOIN agent_tree t ON a."parentAgentId" = t.id
      )
      SELECT id FROM agent_tree
    `;
    return rows.map((r) => r.id);
  }

  // ════════════════════════════════════════════════════════════════════
  // 取消订单（客户/代理 主动申请）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 申请取消订单：
   *   1. 算 cancellation quote
   *   2. 创建 Refund 行（amount=应退）；状态 REQUESTED 等管理员审批
   *   3. Order 状态 → REFUND_REQUESTED + 写 OrderStatusEvent
   *   4. （注意：这里不真退款 / 不释放座位 / 不冲销佣金 — 等 admin approve 后才做）
   *
   * 失败场景：
   *   - 订单状态不可取消 → BadRequestError
   *   - 已存在 REQUESTED 状态的 Refund → 返回那条（幂等）
   */
  async requestCancellation(
    id: string,
    reason: string | undefined,
    requester: OrderRequester,
  ) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { refunds: { where: { status: 'REQUESTED' }, take: 1 } },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);

    // 已有 pending 退款 → 幂等返回（先于可取消性判断，避免再点报错）
    if (order.refunds.length > 0) {
      const { computeCancellationQuote } = await import('../../lib/cancellation.js');
      const existing = order.refunds[0];
      const updated = await prisma.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_FULL_INCLUDE,
      });
      // 始终重算最新 quote（不用 snapshot），保证客户端拿到的 shape 一致 + 费率最新
      // 历史 snapshot 留在 refund.gatewayPayload.quoteSnapshot 供审计追溯
      const quote = await computeCancellationQuote(id);
      return { order: serializeOrder(updated), refund: existing, quote, isNew: false };
    }

    // 计算 quote（包含可取消性判断）
    const { computeCancellationQuote } = await import('../../lib/cancellation.js');
    const quote = await computeCancellationQuote(id);
    if (!quote.cancellable) {
      throw new BadRequestError(quote.cancellableReason ?? '订单不可取消');
    }

    // 事务：创建 Refund + 流转 Order 状态
    const result = await prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: {
          orderId: id,
          amount: new Prisma.Decimal(quote.totalRefund),
          reason: reason ?? null,
          status: 'REQUESTED',
          gatewayPayload: {
            quoteSnapshot: {
              totalFee: quote.totalFee,
              totalRefund: quote.totalRefund,
              items: quote.items.map((i) => ({
                itemId: i.itemId,
                kind: i.kind,
                feePercent: i.feePercent,
                feeAmount: i.feeAmount,
                refundAmount: i.refundAmount,
                reason: i.reason,
              })),
            },
          } as Prisma.InputJsonValue,
        },
      });

      const taskIds: string[] = [];
      await this._updateStatusWithinTx(
        tx,
        id,
        OrderStatus.REFUND_REQUESTED,
        requester,
        reason ?? `申请取消（应退 ¥${quote.totalRefund}）`,
        taskIds,
      );

      return { refund };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: ORDER_FULL_INCLUDE,
    });
    return { order: serializeOrder(finalOrder), refund: result.refund, quote, isNew: true };
  }
}

// 完整 include 给 serializeOrder 用
const ORDER_FULL_INCLUDE = {
  items: true,
  passengers: true,
  payments: true,
  refunds: true,
  statusEvents: { orderBy: { createdAt: 'asc' } },
  agent: { select: { id: true, companyName: true, contactName: true } },
  user: { select: { id: true, displayName: true, email: true } },
} as const;

// ── Helpers ────────────────────────────────────────────────────────────
function passengerToData(p: PassengerInput) {
  return {
    fullName: p.fullName,
    documentType: p.documentType,
    documentNumber: p.documentNumber,
    dateOfBirth: new Date(p.dateOfBirth),
    nationality: p.nationality,
    passengerType: p.passengerType,
    mealPreference: p.mealPreference,
    needsWheelchair: p.needsWheelchair ?? false,
    needsInfantBassinet: p.needsInfantBassinet ?? false,
  };
}

/**
 * FTMYYYYMMDD + 5 位随机 — 每天 10 万空间，撞号概率极低。
 * 真撞了也只会在 $transaction 里 P2002 抛出，上层可以重试；MVP 阶段不做自动重试。
 */
async function generateOrderNumber(): Promise<string> {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const suffix = String(randomInt(10000, 99999));
  return `FTM${yyyy}${mm}${dd}${suffix}`;
}

// 注意：list() 和 get() 的 passengers select 不同，所以 serialize 用宽松类型
// 只处理我们关心的 Decimal 字段 → string。其他字段原样透传。
interface OrderLike {
  subtotal: Prisma.Decimal;
  taxesAndFees: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
  items: Array<{ unitPrice: Prisma.Decimal; amount: Prisma.Decimal } & Record<string, unknown>>;
}

function serializeOrder<T extends OrderLike>(order: T) {
  return {
    ...order,
    subtotal: order.subtotal.toString(),
    taxesAndFees: order.taxesAndFees.toString(),
    discountTotal: order.discountTotal.toString(),
    total: order.total.toString(),
    paidAmount: order.paidAmount.toString(),
    prepaymentOffset: order.prepaymentOffset.toString(),
    items: order.items.map((i) => ({
      ...i,
      unitPrice: i.unitPrice.toString(),
      amount: i.amount.toString(),
    })),
  };
}

// 避免 PaymentMethod 未使用告警（未来接支付时会用到）
void PaymentMethod;

// ── Fulfillment 任务生成（PAID 时触发） ─────────────────────────
import { FulfillmentStatus, FulfillmentType } from '@prisma/client';

const KIND_TO_FULFILLMENT_TYPE: Partial<Record<OrderItemKind, FulfillmentType>> = {
  FLIGHT: FulfillmentType.FLIGHT_TICKETING,
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
  BUNDLE: FulfillmentType.BUNDLE_COMPOSITE,
};

async function createFulfillmentTasks(tx: Prisma.TransactionClient, orderId: string): Promise<string[]> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, kind: true, fulfillmentTasks: { select: { id: true } } },
  });
  const newTaskIds: string[] = [];
  for (const item of items) {
    const type = KIND_TO_FULFILLMENT_TYPE[item.kind];
    if (!type) continue;
    if (item.fulfillmentTasks.length > 0) continue;
    const task = await tx.fulfillmentTask.create({
      data: {
        orderItemId: item.id,
        type,
        status: FulfillmentStatus.PENDING,
      },
    });
    newTaskIds.push(task.id);
  }
  return newTaskIds;
}

// ════════════════════════════════════════════════════════════════════
// 佣金链路计算 — 当订单转 PAID 时调用，为卖家代理 + 所有上级代理创建 CommissionRecord
//
// 级联模型（child rate ≤ parent rate 不变式）：
//   - 卖家代理（链底）拿: seller.rate × baseAmount
//   - 卖家上级拿: (parent.rate - seller.rate) × baseAmount（即 spread）
//   - 再上级拿: (grandparent.rate - parent.rate) × baseAmount
//   - ...一直走到根代理或没规则的代理
//
// 如果某代理对该 productKind 没有 CommissionRule，视作 rate=0（父级会继续"吃"这部分）。
// 每条 OrderItem 单独走一次链路（因为 productKind 可能不同）。
// ════════════════════════════════════════════════════════════════════
const ORDER_ITEM_KIND_TO_PRODUCT_KIND: Partial<Record<OrderItemKind, ProductKind>> = {
  FLIGHT: ProductKind.FLIGHT,
  HOTEL: ProductKind.HOTEL,
  TRANSFER: ProductKind.TRANSFER,
  VISA: ProductKind.VISA,
};

async function createCommissionsForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  sellerAgentId: string,
) {
  // 1. 拉订单项
  const items = await tx.orderItem.findMany({ where: { orderId } });
  if (items.length === 0) return;

  // 2. 算链路（seller → parent → grandparent ...）
  const chain: Array<{ agentId: string; depth: number }> = [];
  let cur: string | null = sellerAgentId;
  let depth = 0;
  while (cur) {
    chain.push({ agentId: cur, depth });
    const parentRow: { parentAgentId: string | null } | null = await tx.agent.findUnique({
      where: { id: cur },
      select: { parentAgentId: true },
    });
    cur = parentRow?.parentAgentId ?? null;
    depth++;
    if (depth > 10) break; // 防御：层级超 10 级直接断
  }

  // 3. 为每个 item 按 productKind 生成 records
  for (const item of items) {
    const productKind = ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind];
    if (!productKind) continue; // INSURANCE/FEE/DISCOUNT 不算佣金

    // 取链路上每个代理对该 productKind 的 rate（有效期内）
    // 按 effectiveFrom DESC 排序，每个 agent 取第一条 = 最新生效的规则
    // （之前是"取最大 rate"，降档后还按高佣跑，是 bug）
    const rules = await tx.commissionRule.findMany({
      where: {
        agentId: { in: chain.map((c) => c.agentId) },
        productKind,
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    const rateByAgent = new Map<string, number>();
    for (const r of rules) {
      if (!rateByAgent.has(r.agentId)) {
        rateByAgent.set(r.agentId, Number(r.rate));
      }
    }

    // 沿着链路从底向上，每个代理拿 (自己 rate - 下级 rate) × baseAmount
    const baseAmount = Number(item.amount);
    let lowerRate = 0; // 下级代理的 rate（seller 的 "下级" 是 0，表示没有）
    for (let i = 0; i < chain.length; i++) {
      const { agentId, depth: d } = chain[i];
      const thisRate = rateByAgent.get(agentId) ?? 0;
      // 不变式：child rate ≤ parent rate — 若违反，spread 为负，跳过
      const netRate = thisRate - lowerRate;
      if (netRate > 0.00005) {
        const amt = Math.round(baseAmount * netRate * 100) / 100;
        await tx.commissionRecord.create({
          data: {
            agentId,
            orderId,
            productKind,
            baseAmount: new Prisma.Decimal(baseAmount),
            rate: new Prisma.Decimal(netRate),
            amount: new Prisma.Decimal(amt),
            chainDepth: d,
            status: CommissionStatus.ACCRUED,
          },
        });
      }
      // 下一轮循环：上一级代理看本级作为"下级"
      if (thisRate > lowerRate) lowerRate = thisRate;
    }
  }
}
