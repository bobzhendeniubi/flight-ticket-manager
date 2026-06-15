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
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  PaymentMethod,
  Prisma,
  ProductKind,
  SeatLockStatus,
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
import { OPERATION_FEE_CNY_PER_ORDER } from './order-cost-items.service.js';
import { bundleItemMetadataSchema } from './orders.schemas.js';
import { assertTicketingCap } from './ticketing-cap.js';
import type {
  BatchCreateOrdersBody,
  CreateOrderBody,
  ListOrdersQuery,
  OrderItemInput,
  PassengerInput,
  PublicOrderLookupQuery,
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

// 服务端价格校验容差（CNY）：客户端提交金额与服务端权威重算金额相差超过此值则拒单（A3）
const PRICE_TOLERANCE_CNY = 1.0;

// 护照有效期规则（相对出发日）— 反馈：李萍
const PASSPORT_EXPIRY_BLOCK_DAYS = 90; // 不足 90 天禁止下单
const PASSPORT_EXPIRY_SURCHARGE_DAYS = 180; // 不足 6 个月加收附加费
const NEAR_EXPIRY_SURCHARGE_CNY = 200; // 每位临期乘客附加费

// ── 类型 ────────────────────────────────────────────────────────────────
export interface OrderRequester {
  userId: string;
  role: UserRole;
  /** 当前登录代理的 agentId（如果是 AGENT） */
  agentId?: string;
  /** 显式区分系统操作（支付回调 / cron）与真实用户，而非靠 userId 字符串前缀 */
  actorType?: 'USER' | 'SYSTEM';
}

/**
 * 游客下单上下文（免登录，A1）。createOrder 收到 guest 时：
 * userId=null、agentId=null、无佣金/结算（等同直客无代理单）。
 */
export interface GuestRequester {
  guest: { name: string; phone: string; email?: string };
}

function isGuestRequester(r: OrderRequester | GuestRequester): r is GuestRequester {
  return 'guest' in r;
}

export class OrderService {
  private readonly pricing = new PricingService();

  // ════════════════════════════════════════════════════════════════════
  // 下单
  // ════════════════════════════════════════════════════════════════════
  async createOrder(body: CreateOrderBody, requester: OrderRequester | GuestRequester) {
    // 游客 vs 登录用户：拆出统一的归属信息（userId/agentId/锁位归属/事件 actor）
    const isGuest = isGuestRequester(requester);
    const ownerUserId: string | null = isGuest ? null : requester.userId;
    const guest = isGuest ? requester.guest : null;
    // 幂等：提前查 key 是否已存在
    if (body.idempotencyKey) {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
        include: { items: true, passengers: true },
      });
      if (existing) return existing;
    }

    // 出行人数校验（与前台 effectivePax 同口径）。
    // 关键：往返机票是「同一批人」，会拆成去/回两条 FLIGHT 行（各 quantity=pax）。
    // 所需出行人按「单程最大人数」算，取各 FLIGHT 行 quantity 的 MAX，绝不两段相加 ——
    // 否则 2 人往返会被错误要求 4 本护照（公测反馈）。
    // 签证/接送/套餐也都是「按人」的产品（同一批出行人），同样取 MAX 不取 SUM：
    //   required = max( max(FLIGHT 行 quantity), Σ(BUNDLE pax), Σ(VISA qty), Σ(TRANSFER qty) )
    // 镜像前台 CheckoutPage 的 effectivePax 计算，保证两端结论一致。
    const requiredPax = computeRequiredPassengerCount(body.items);
    if (requiredPax > 0 && requiredPax !== body.passengers.length) {
      throw new BadRequestError(
        `本次行程共需 ${requiredPax} 位出行人，当前填了 ${body.passengers.length} 位`,
      );
    }

    // 重复乘客校验：同班次「占座中」订单里已有同证件号乘客 → 拒绝，防同人同航班重复占座
    const flightScheduleIds = [
      ...new Set(
        body.items
          .filter((i): i is Extract<OrderItemInput, { kind: 'FLIGHT' }> => i.kind === 'FLIGHT')
          .map((i) => i.flightScheduleId),
      ),
    ];
    await this.assertNoDuplicatePassengersOnFlights(
      flightScheduleIds,
      body.passengers.map((px) => px.documentNumber),
    );

    // 先查所有 FLIGHT item 对应的 FlightSeatClass + 计算动态价（在事务外查，避免长事务）
    const pricedItems = await this.priceAndValidateItems(body.items);

    // 签证订单规则：含 VISA 行时每位出行人必须填写护照有效期（送签材料必填）
    assertVisaPassengersHavePassportExpiry(body.items, body.passengers);

    // 护照有效期规则（相对出发日）：<90 天禁止下单；不足 6 个月每人 +200 临期附加费
    await this.applyPassportExpiryRule(body, pricedItems);

    const subtotal = pricedItems.reduce((sum, p) => sum + p.amount, 0);
    const total = subtotal; // 目前没有 taxes / discount，直接等于 subtotal

    // 代理身份判定：游客无代理；登录用户里非 AGENT 也 agentId=null
    const agentId = !isGuest && requester.role === 'AGENT' ? (requester.agentId ?? null) : null;

    // 生成订单号（有极小概率撞 unique，重试 3 次）
    const orderNumber = await generateOrderNumber();

    // 事务：原子扣座位（CAS 防超卖）→ 写订单 → 写事件 → 消费本人锁位
    // 事务提交后要移除已消费锁位的到期任务（jobId seatlock:<id>），先收集 id
    const consumedLockIds: string[] = [];
    const order = await prisma.$transaction(async (tx) => {
      // 用 updateMany 的 where 条件做原子"检查+扣减"一步到位，避免 TOCTOU
      // where: `sold + qty <= capacity` 等价于 Prisma-expressible `capacity - qty >= sold`
      // 但 Prisma raw 不支持这种 cross-column where；用 sold + qty <= capacity 需要
      // SQL 函数，改用 raw SQL 保证原子性。
      // 原子扣座（CAS 防超卖）。一行经济舱 FLIGHT 在套餐升舱时会拆成两笔：
      //   ECONOMY  sold += quantity − businessUpgradeCount（剩下没升舱的人）
      //   BUSINESS sold += businessUpgradeCount（升舱的人，占用真实商务舱座位）
      // 净占座仍 = quantity，不超售商务舱、不持有幽灵经济舱座位。businessUpgradeCount=0 → 行为与旧版完全一致。
      const decrementSeat = async (
        scheduleId: string,
        cabin: import('@prisma/client').CabinClass,
        qty: number,
      ): Promise<void> => {
        if (qty <= 0) return;
        // 锁位语义：他人的 ACTIVE 未过期锁位占用余票（下单人自己的锁位不挡自己下单）
        const lockedAgg = await tx.seatLock.aggregate({
          _sum: { qty: true },
          where: {
            seatClass: { scheduleId, cabin },
            // 游客无锁位归属 → 所有他人 ACTIVE 锁位都占用余票
            ...(ownerUserId ? { userId: { not: ownerUserId } } : {}),
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
        });
        const lockedByOthers = lockedAgg._sum.qty ?? 0;
        const affected = await tx.$executeRaw`
          UPDATE "FlightSeatClass"
          SET sold = sold + ${qty}, "updatedAt" = NOW()
          WHERE "scheduleId" = ${scheduleId}
            AND cabin = ${cabin}::"CabinClass"
            AND sold + ${qty} + ${lockedByOthers} <= capacity
        `;
        if (affected !== 1) {
          // 查当前库存给更友好的错误消息
          const sc = await tx.flightSeatClass.findFirst({
            where: { scheduleId, cabin },
            select: { capacity: true, sold: true },
          });
          const available = sc ? Math.max(0, sc.capacity - sc.sold - lockedByOthers) : 0;
          throw new ConflictError(
            `${cabin} 余票不足：需要 ${qty} 张，仅剩 ${available} 张（并发抢占）`,
          );
        }
      };

      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT' || !p.flightScheduleId || !p.flightCabin) continue;
        const split = computeBundleSeatSplit(p.flightCabin, p.quantity, p.businessUpgradeCount);
        // 升舱的人占商务舱真实座位
        await decrementSeat(p.flightScheduleId, 'BUSINESS', split.business);
        // 其余人占本行原舱位（经济舱减掉升舱人数；非经济舱行 split.business=0，等于全额扣原舱）
        await decrementSeat(p.flightScheduleId, p.flightCabin, split.sameCabin);
      }

      // 初始状态直接 PENDING_PAYMENT（MVP 阶段没有 DRAFT 保存流）
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: ownerUserId,
          agentId,
          // 游客下单：存联系人，供公开订单查询匹配 + 履约联系
          guestName: guest?.name ?? null,
          guestPhone: guest?.phone ?? null,
          guestEmail: guest?.email ?? null,
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
              actorUserId: ownerUserId, // 游客下单 → null（系统/匿名）
              reason: isGuest ? '游客下单创建' : '订单创建',
            },
          },
        },
        include: { items: true, passengers: true, statusEvents: true },
      });

      // 操作费自动计提（财务定：订单录入/服务人员费，每单固定 ¥20）
      // 注意：操作费 ≠ 手续费（手续费=收款二维码/国际清算行结算手续费，仍走 HANDLING_FEE）
      await tx.orderCostItem.create({
        data: {
          orderId: created.id,
          category: 'OPERATION_FEE',
          amountCny: new Prisma.Decimal(OPERATION_FEE_CNY_PER_ORDER),
          note: '系统自动计提（每单固定操作费）',
        },
      });

      // 消费下单人自己的锁位：FLIGHT 行对应舱位上本人的 ACTIVE 未过期锁位 → CONSUMED
      // （座位已通过 sold 扣减真实占用，锁位完成使命；过期任务提交后再移除）
      // 游客无锁位归属 → 跳过整段
      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT' || !ownerUserId) continue;
        const myLocks = await tx.seatLock.findMany({
          where: {
            seatClass: { scheduleId: p.flightScheduleId!, cabin: p.flightCabin! },
            userId: ownerUserId,
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (myLocks.length === 0) continue;
        const lockIds = myLocks.map((l) => l.id);
        await tx.seatLock.updateMany({
          where: { id: { in: lockIds } },
          data: { status: SeatLockStatus.CONSUMED, consumedOrderId: created.id },
        });
        consumedLockIds.push(...lockIds);
      }

      // 座位已在订单 create 之前原子扣减；此处无需再动库存
      return created;
    });

    // 事务成功后：移除已消费锁位的到期任务（best-effort；worker 端幂等）
    if (consumedLockIds.length > 0) {
      try {
        const { cancelSeatLockExpiry } = await import('../../queues/queue.js');
        await Promise.all(consumedLockIds.map((lockId) => cancelSeatLockExpiry(lockId)));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to cancel seat-lock expiry jobs for', order.id, err);
      }
    }

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
  /**
   * 护照有效期业务规则（反馈：李萍）。仅对有出发日的订单（含 FLIGHT）生效，
   * 且只检查填了 passportExpiry 的乘客（OCR/手填得到）。
   *   - 距出发日不足 90 天 → 禁止下单（抛 BadRequestError）
   *   - 距出发日不足 6 个月（180 天）→ 每位 +200 临期附加费（FEE 行）
   * 通过 push 到 pricedItems 让附加费自然进入 subtotal/total/items。
   */
  private async applyPassportExpiryRule(
    body: CreateOrderBody,
    pricedItems: Array<{ kind: OrderItemKind; description: string; quantity: number; unitPrice: number; amount: number }>,
  ): Promise<void> {
    const scheduleIds = body.items
      .filter((i): i is Extract<OrderItemInput, { kind: 'FLIGHT' }> => i.kind === 'FLIGHT')
      .map((i) => i.flightScheduleId);
    if (scheduleIds.length === 0) return; // 无航班 → 无出发日 → 跳过

    const scheds = await prisma.flightSchedule.findMany({
      where: { id: { in: scheduleIds } },
      select: { departureTime: true },
    });
    if (scheds.length === 0) return;
    // 取最早出发日做基准（行程第一段）
    const departure = scheds.reduce<Date>(
      (min, s) => (s.departureTime < min ? s.departureTime : min),
      scheds[0].departureTime,
    );

    const DAY = 24 * 60 * 60 * 1000;
    const blocked: string[] = [];
    let surchargeCount = 0;
    for (const px of body.passengers) {
      if (!px.passportExpiry) continue; // 没填有效期 → 无法判定，跳过
      const expiry = new Date(px.passportExpiry);
      const days = Math.floor((expiry.getTime() - departure.getTime()) / DAY);
      if (days < PASSPORT_EXPIRY_BLOCK_DAYS) blocked.push(px.fullName);
      else if (days < PASSPORT_EXPIRY_SURCHARGE_DAYS) surchargeCount += 1;
    }

    if (blocked.length > 0) {
      throw new BadRequestError(
        `护照有效期不足 ${PASSPORT_EXPIRY_BLOCK_DAYS} 天（相对出发日），禁止下单：${blocked.join('、')}。请更换护照后再订。`,
      );
    }
    if (surchargeCount > 0) {
      pricedItems.push({
        kind: 'FEE',
        description: `护照临期附加费（有效期不足 6 个月，${surchargeCount} 人）`,
        quantity: surchargeCount,
        unitPrice: NEAR_EXPIRY_SURCHARGE_CNY,
        amount: NEAR_EXPIRY_SURCHARGE_CNY * surchargeCount,
      });
    }
  }

  /**
   * 重复乘客校验：同一航班班次的「占座中」订单（SEAT_HOLDING_STATUSES）里，
   * 同证件号乘客不允许再次下单 —— 已取消/已退款/超时的订单不算占座，可重订。
   * 命中则抛 BadRequestError，列出证件号与冲突订单号。
   */
  private async assertNoDuplicatePassengersOnFlights(
    flightScheduleIds: string[],
    documentNumbers: string[],
  ): Promise<void> {
    if (flightScheduleIds.length === 0 || documentNumbers.length === 0) return;

    const conflicts = await prisma.passenger.findMany({
      where: {
        documentNumber: { in: [...new Set(documentNumbers)] },
        order: {
          status: { in: SEAT_HOLDING_STATUSES },
          items: { some: { flightScheduleId: { in: flightScheduleIds } } },
        },
      },
      select: {
        documentNumber: true,
        order: { select: { orderNumber: true } },
      },
    });
    if (conflicts.length === 0) return;

    const orderNumbersByDoc = new Map<string, Set<string>>();
    for (const c of conflicts) {
      const orderNumbers = orderNumbersByDoc.get(c.documentNumber) ?? new Set<string>();
      orderNumbers.add(c.order.orderNumber);
      orderNumbersByDoc.set(c.documentNumber, orderNumbers);
    }
    const detail = [...orderNumbersByDoc.entries()]
      .map(([doc, orderNumbers]) => `${doc}（订单 ${[...orderNumbers].join('、')}）`)
      .join('；');
    throw new BadRequestError(
      `以下乘客证件号已在同航班的有效订单中，不能重复下单：${detail}`,
    );
  }

  private async priceAndValidateItems(items: OrderItemInput[]) {
    const priced: Array<{
      kind: OrderItemKind;
      description: string;
      quantity: number;
      unitPrice: number;
      amount: number;
      flightScheduleId?: string;
      flightCabin?: import('@prisma/client').CabinClass;
      // 套餐升舱：这条经济舱 FLIGHT 行里有多少个座位要占用真实商务舱库存
      // （扣座时 ECONOMY sold += quantity − businessUpgradeCount，BUSINESS sold += businessUpgradeCount）
      businessUpgradeCount?: number;
      hotelRoomTypeId?: string;
      hotelCheckIn?: Date;
      hotelCheckOut?: Date;
      transferId?: string;
      visaId?: string;
      bundleId?: string;
      metadata?: Record<string, unknown>;
    }> = [];

    // 本单所有 BUNDLE 行选「升舱商务」的总人数（多份套餐叠加）。
    // 循环结束后分摊到本单的经济舱 FLIGHT 航段：每段占用 businessUpgradeCount 个真实商务舱座位。
    let bundleBusinessUpgradeCount = 0;

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
          // A3：拒绝偏离服务端权威价超容差的提交（仅有产品 id 时校验，无 id 走信任旧路径）
          assertAmountWithinTolerance('酒店', item.unitPrice, unitPrice, item.quantity);
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
          assertAmountWithinTolerance('接送', item.unitPrice, unitPrice, item.quantity);
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
          assertAmountWithinTolerance('签证', item.unitPrice, unitPrice, item.quantity);
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
          select: {
            items: true,
            groundDiscount: true,
            isActive: true,
            hotelRoomTypeId: true,
            hotelNights: true,
            // 可选升级加价费率（server-priced，按产品可配置）+ 航段数
            singleSupplementCnyPerNight: true,
            businessUpgradeCnyPerLeg: true,
            // 占座儿童折扣 / 婴儿价（server-priced，按产品可配置）
            childSeatDiscountCnyPerPerson: true,
            infantPriceCny: true,
            legs: true,
            // 关联房型容量 → 算 roomsNeeded（自动加房，套餐酒店部分按房价 ×rooms 收费）
            hotelRoomType: { select: { maxAdults: true, maxChildren: true } },
          },
        });
        if (!bundle) throw new NotFoundError(`套餐 ${item.bundleId} 不存在`);
        if (!bundle.isActive) throw new BadRequestError('套餐已下架');
        // 占座模型归一化（成人 / 占座儿童 / 不占座婴儿；向后兼容旧 pax → 全成人）。
        // 先算占座，再据房型容量推 roomsNeeded（酒店地面部分按房间数缩放）。
        const occupancy = resolveBundleOccupancy({
          adultCount: item.adultCount,
          childCount: item.childCount,
          infantCount: item.infantCount,
          quantity: item.quantity,
          metadata: item.metadata,
        });
        // 所需房间数：选的人数一间房坐不下时自动加房（赵姐口径）。
        //   roomsNeeded = max( ceil(成人/maxAdults), ceil(占座儿童/maxChildren), 1 )
        // 套餐没绑房型 / 容量缺失 → computeRoomsNeeded 回退默认 2大1小（≈旧 ceil(seatPax/2) 行为）。
        // 注意：单人入住（singleCount）不在此计入 —— 它是独立自愿加价项，容量才驱动房间数。
        const roomsNeeded = computeRoomsNeeded(occupancy, bundle.hotelRoomType);

        // 地面部分价（机票部分留给 FLIGHT item 单独动态定价）：
        //   HOTEL 行（unitPrice=每间每晚, qty=晚数）按 unitPrice×qty×roomsNeeded 收费 → 套餐价随房间数涨；
        //   非 HOTEL 地面行（TRANSFER/VISA 等）固定 unitPrice×qty×1（不随房间数变）。
        //   bundleGround = Σ(HOTEL×rooms) + Σ(其它非机票) − groundDiscount
        const bundleItems = (bundle.items as Array<{ kind: string; qty: number; unitPrice: number }>) ?? [];
        const groundTotal = bundleItems
          .filter((b) => b.kind !== 'FLIGHT')
          .reduce((s, b) => {
            const roomFactor = b.kind === 'HOTEL' ? roomsNeeded : 1;
            return s + b.qty * b.unitPrice * roomFactor;
          }, 0);
        const bundleUnitPrice = Math.max(0, Math.round(groundTotal - Number(bundle.groundDiscount)));
        // 套餐关联酒店 → 把房型+入住日期盖到订单行（房控板自动计入套餐占房）。
        // metadata 缺失/异常时只是不盖章，绝不阻断下单。
        const hotelStamp = resolveBundleHotelStamp(bundle, item.metadata);

        // 可选升级 add-on（server-priced，权威重算；缺省 0 → 与旧版价格完全一致）：
        //   单人入住房差 = singleCount × singleSupplementCnyPerNight × nights
        //   升舱商务加价 = businessCount × businessUpgradeCnyPerLeg × legs
        //     —— 这是客户升舱的「总加价」（不是在全价商务票之上再加 ¥700）。客户机票仍按经济舱套餐价收，
        //        差价由商家补贴；升舱只占用真实商务舱库存（不超售），见下方按经济舱航段拆座逻辑。
        const addOn = computeBundleAddOn(
          bundle,
          hotelStamp,
          item.singleCount,
          item.businessCount,
          occupancy,
        );
        // 累计本单的升舱人数（多份套餐叠加），下方循环结束后统一分摊到经济舱航段并预检商务舱余位。
        // 注意：addOn.breakdown.businessCount 已夹到占座人数（seatPax）上限，婴儿不计入。
        bundleBusinessUpgradeCount += addOn.breakdown.businessCount;

        priced.push({
          kind: 'BUNDLE',
          description: item.description,
          quantity: item.quantity,
          unitPrice: bundleUnitPrice,
          // 升级加价加在套餐行总额上（不摊进 unitPrice，保持基础单价语义不变）
          amount: bundleUnitPrice * item.quantity + addOn.total,
          bundleId: item.bundleId,
          hotelRoomTypeId: hotelStamp?.hotelRoomTypeId,
          hotelCheckIn: hotelStamp?.hotelCheckIn,
          hotelCheckOut: hotelStamp?.hotelCheckOut,
          // 把升级选择 + 重算明细 + roomsNeeded 落到订单行 metadata，供运营/财务查看
          //（admin 内部仍可叫"单房差/升舱"；roomsNeeded 解释酒店部分为何按房价 ×rooms 收费）
          metadata: addOn.hasAddOn || roomsNeeded > 1
            ? { ...(item.metadata ?? {}), roomsNeeded, addOns: addOn.breakdown }
            : item.metadata,
        });
      }
    }

    // ── 套餐升舱占座：把 businessCount 个座位从经济舱航段「拆」到真实商务舱库存 ──
    // 套餐本身不绑班次（bundle.items 里的 FLIGHT 组件只有描述、无 scheduleId），故升舱要占用的
    // 真实座位来自本单的经济舱 FLIGHT 行（前台套餐订单的往返机票就是这些经济舱航段）。
    // 客户机票仍按经济舱收费（FLIGHT 行 amount 不变）；升舱只改变扣座的舱位分布：
    //   每个经济舱航段：BUSINESS sold += businessUpgradeCount，ECONOMY sold += quantity − businessUpgradeCount。
    // 净占座仍 = quantity（不持有幽灵经济舱座位、不超售商务舱）。
    if (bundleBusinessUpgradeCount > 0) {
      const economyLegs = priced.filter(
        (p) => p.kind === 'FLIGHT' && p.flightCabin === 'ECONOMY',
      );
      if (economyLegs.length === 0) {
        // 没有可升舱的经济舱航段 → 无从占用真实商务舱座位（套餐本身不绑班次）。
        throw new BadRequestError('商务舱余位不足，无法升舱');
      }
      // 每段经济舱座位数必须 ≥ 升舱人数（不能把比本段乘客还多的人升舱）。
      for (const leg of economyLegs) {
        if (leg.quantity < bundleBusinessUpgradeCount) {
          throw new BadRequestError('商务舱余位不足，无法升舱');
        }
      }
      // 逐段预检真实商务舱余位（事务前友好预检，真正扣减由事务里的原子 CAS 完成，最终防超售）。
      await this.assertBusinessAvailabilityForBundle(economyLegs, bundleBusinessUpgradeCount);
      // 标记每个经济舱航段要拆多少座到商务舱，并落到订单行 metadata（取消退座时按此还原拆座）。
      for (const leg of economyLegs) {
        leg.businessUpgradeCount = bundleBusinessUpgradeCount;
        leg.metadata = { ...(leg.metadata ?? {}), businessUpgradeCount: bundleBusinessUpgradeCount };
      }
    }

    return priced;
  }

  /**
   * 升舱占座预检（套餐升级商务舱时调用）。
   *
   * 套餐升舱的正确模型：客户机票仍按经济舱套餐价收，¥700/程 是升舱的「总加价」（不是在全价商务票上再加）；
   * 升舱要占用的真实商务舱座位来自本单的经济舱 FLIGHT 航段（套餐本身不绑班次）。
   * 这里逐段按六档余位口径（available = capacity − sold − 他人 ACTIVE 锁位）预检每个经济舱航段对应班次的
   * 商务舱余位是否够 businessCount：
   *   - 任一航段班次没有商务舱舱位 / 商务舱余位 < businessCount → 拒单（"商务舱余位不足，无法升舱"）
   * 真正的扣减（ECONOMY 减 businessCount、BUSINESS 加 businessCount）由事务里的原子 CAS 完成，最终防超售；
   * 此处只做事务前的友好预检。
   */
  private async assertBusinessAvailabilityForBundle(
    economyLegs: Array<{ flightScheduleId?: string }>,
    businessCount: number,
  ): Promise<void> {
    const now = new Date();
    for (const leg of economyLegs) {
      if (!leg.flightScheduleId) continue;
      const sc = await prisma.flightSeatClass.findFirst({
        where: { scheduleId: leg.flightScheduleId, cabin: 'BUSINESS' },
        select: { capacity: true, sold: true },
      });
      if (!sc) {
        throw new BadRequestError('商务舱余位不足，无法升舱');
      }
      const lockedAgg = await prisma.seatLock.aggregate({
        _sum: { qty: true },
        where: {
          seatClass: { scheduleId: leg.flightScheduleId, cabin: 'BUSINESS' },
          status: SeatLockStatus.ACTIVE,
          expiresAt: { gt: now },
        },
      });
      const locked = lockedAgg._sum.qty ?? 0;
      const available = Math.max(0, sc.capacity - sc.sold - locked);
      if (available < businessCount) {
        throw new BadRequestError('商务舱余位不足，无法升舱');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 列表
  // ════════════════════════════════════════════════════════════════════
  async listOrders(query: ListOrdersQuery, requester: OrderRequester) {
    const where = buildOrderFilterWhere(query);

    // RBAC 过滤 — 先建基准可见集合，再按 query 过滤（但 query.agentId 不能覆盖可见集合）
    if (requester.role === 'CUSTOMER') {
      where.userId = requester.userId;
    } else if (requester.role === 'AGENT') {
      const visibleAgentIds = await this.getDescendantAgentIds(requester.agentId);
      if (query.agentId) {
        // agentId 过滤 — 必须在可见集合内才生效，否则 403（防横向越权）
        if (!visibleAgentIds.includes(query.agentId)) {
          throw new ForbiddenError('无权查看该代理的订单');
        }
        // where.agentId 已由 buildOrderFilterWhere 设为 query.agentId
      } else {
        where.agentId = { in: visibleAgentIds };
      }
    }
    // ADMIN/STAFF: 无额外过滤；query.agentId（如有）已由 buildOrderFilterWhere 设置

    if (query.claimedById) where.claimedById = query.claimedById;
    if (query.unclaimedOnly) where.claimedById = null;

    const [rows, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        include: {
          // 带上 fulfillment 任务(类型+状态)，前端据此派生「签证状态」列
          items: { include: { fulfillmentTasks: { select: { type: true, status: true } } } },
          passengers: { select: { id: true, fullName: true } },
          agent: { select: { id: true, companyName: true, contactName: true } },
          user: { select: { id: true, displayName: true, email: true } },
          claimedBy: { select: { id: true, displayName: true, email: true } },
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
        passengers: true, // 含护照/签证/地址全部新字段
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true } },
        user: { select: { id: true, displayName: true, email: true } },
        claimedBy: { select: { id: true, displayName: true, email: true } },
        reminders: {
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
          include: { createdBy: { select: { id: true, displayName: true } } },
        },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);
    return serializeOrder(order);
  }

  // ════════════════════════════════════════════════════════════════════
  // 公开订单查询（A4，免登录）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 用 orderNumber + (phone 或 email) 匹配订单，命中返回脱敏视图，否则返回 null。
   * 匹配范围：订单游客联系人(guestPhone/guestEmail/contactPhone/contactEmail) 或
   * 归属用户(user.phone/user.email)。任一字段命中即可。
   * 安全：永不泄露内部备注/成本/代理/expectedAmount/PII；不命中统一返回 null（路由 → 404）。
   */
  async lookupOrderPublic(query: PublicOrderLookupQuery): Promise<MaskedOrderView | null> {
    const order = await prisma.order.findUnique({
      where: { orderNumber: query.orderNumber },
      include: {
        items: { include: { flightSchedule: { select: { departureTime: true } } } },
        passengers: { select: { fullName: true, firstName: true } },
        payments: { select: { status: true } },
        user: { select: { phone: true, email: true } },
      },
    });
    if (!order) return null;

    // 联系方式匹配（phone / email 任一）。比对时去空白；电话忽略大小写无意义但邮箱忽略大小写。
    const phone = query.phone?.trim();
    const email = query.email?.trim().toLowerCase();
    const orderPhones = [order.guestPhone, order.contactPhone, order.user?.phone]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim());
    const orderEmails = [order.guestEmail, order.contactEmail, order.user?.email]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase());

    const phoneMatch = phone ? orderPhones.includes(phone) : false;
    const emailMatch = email ? orderEmails.includes(email) : false;
    if (!phoneMatch && !emailMatch) return null;

    return maskOrderForPublic(order);
  }

  // ════════════════════════════════════════════════════════════════════
  // 状态流转
  // ════════════════════════════════════════════════════════════════════
  async updateStatus(
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason?: string,
    force?: boolean,
  ) {
    // 收集事务里创建的任务 id，提交后再入队（避免 worker 在 tx 提交前查不到）
    const pendingFulfillmentTaskIds: string[] = [];
    // 收集释放座位的舱位 id，提交后排队候补检查
    const releasedSeatClassIds: string[] = [];

    const updated = await prisma.$transaction(async (tx) => {
      return this._updateStatusWithinTx(
        tx,
        id,
        toStatus,
        requester,
        reason,
        pendingFulfillmentTaskIds,
        force,
        releasedSeatClassIds,
      );
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

    // 释放了座位 → 排队候补检查（best-effort，失败不阻塞状态流转）
    if (releasedSeatClassIds.length > 0) {
      try {
        const { enqueueWaitlistCheck } = await import('../../queues/queue.js');
        await Promise.all(
          [...new Set(releasedSeatClassIds)].map((seatClassId) => enqueueWaitlistCheck(seatClassId)),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to enqueue waitlist-check for', id, err);
      }
    }

    return serializeOrder(updated);
  }

  /**
   * 批量状态流转（ADMIN/STAFF 后台用）。
   * 每个 id 独立 transaction，partial failure 不回滚成功项；返回 per-id 结果。
   */
  async batchUpdateStatus(
    ids: string[],
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason?: string,
    force?: boolean,
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ id: string; success: boolean; orderNumber?: string; error?: string }>;
  }> {
    const results: Array<{ id: string; success: boolean; orderNumber?: string; error?: string }> = [];
    let successCount = 0;
    let failureCount = 0;
    for (const id of ids) {
      try {
        const order = await this.updateStatus(id, toStatus, requester, reason, force);
        results.push({ id, success: true, orderNumber: order.orderNumber });
        successCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        results.push({ id, success: false, error: message });
        failureCount += 1;
      }
    }
    return { successCount, failureCount, results };
  }

  /**
   * 批量散客建单：选一个航班班次 + 舱位 + 共享联系人，名单里每位乘客各成一单（FLIGHT × 1）。
   * 逐单复用 createOrder（含动态定价 / 原子扣座 / 订单号），单条失败不影响其余，逐行返回结果。
   */
  async batchCreateOrders(
    body: BatchCreateOrdersBody,
    requester: OrderRequester,
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{
      index: number;
      passengerName: string;
      success: boolean;
      orderId?: string;
      orderNumber?: string;
      error?: string;
    }>;
  }> {
    // 重复乘客校验（整批先查，命中则整批拒绝，不产生部分建单）：
    // 1) 名单内证件号重复；2) 与同班次「占座中」订单的乘客证件号重复
    const seenDocs = new Set<string>();
    const dupInBatch = new Set<string>();
    for (const px of body.passengers) {
      if (seenDocs.has(px.documentNumber)) dupInBatch.add(px.documentNumber);
      seenDocs.add(px.documentNumber);
    }
    if (dupInBatch.size > 0) {
      throw new BadRequestError(`名单内证件号重复：${[...dupInBatch].join('、')}`);
    }
    await this.assertNoDuplicatePassengersOnFlights(
      [body.flightScheduleId],
      body.passengers.map((px) => px.documentNumber),
    );

    const results: Array<{
      index: number;
      passengerName: string;
      success: boolean;
      orderId?: string;
      orderNumber?: string;
      error?: string;
    }> = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < body.passengers.length; i++) {
      const passenger = body.passengers[i];
      try {
        const order = await this.createOrder(
          {
            contactName: body.contactName,
            contactPhone: body.contactPhone,
            contactEmail: body.contactEmail,
            paymentMethod: body.paymentMethod,
            notes: body.notes,
            items: [
              {
                kind: 'FLIGHT',
                description: body.description,
                quantity: 1,
                flightScheduleId: body.flightScheduleId,
                flightCabin: body.flightCabin,
              },
            ],
            passengers: [passenger],
          },
          requester,
        );
        results.push({
          index: i,
          passengerName: passenger.fullName,
          success: true,
          orderId: order.id,
          orderNumber: order.orderNumber,
        });
        successCount += 1;
      } catch (err) {
        results.push({
          index: i,
          passengerName: passenger.fullName,
          success: false,
          error: err instanceof Error ? err.message : '未知错误',
        });
        failureCount += 1;
      }
    }

    return { successCount, failureCount, results };
  }

  /**
   * 设置开票状态（路由层限 ADMIN/STAFF）。
   * 转 ISSUED 前校验班次开票上限（FlightSchedule.ticketingCap，默认 191 张/班次），
   * 超限抛 422。校验+更新同包一个事务，缩小并发开票越限的窗口。
   */
  async setInvoiceStatus(
    id: string,
    invoiceStatus: InvoiceStatus,
  ): Promise<{ id: string; orderNumber: string; invoiceStatus: InvoiceStatus }> {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          invoiceStatus: true,
          items: {
            where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            select: { flightScheduleId: true },
          },
          _count: { select: { passengers: true } },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // 已是 ISSUED 的订单重复设置不再计数（幂等）；改回 NONE/REQUESTED 不受限
      if (invoiceStatus === InvoiceStatus.ISSUED && order.invoiceStatus !== InvoiceStatus.ISSUED) {
        const scheduleIds = order.items
          .map((it) => it.flightScheduleId)
          .filter((sid): sid is string => sid !== null);
        await assertTicketingCap(tx, scheduleIds, order._count.passengers);
      }

      return tx.order.update({
        where: { id },
        data: { invoiceStatus },
        select: { id: true, orderNumber: true, invoiceStatus: true },
      });
    });
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
    force?: boolean,
    releasedSeatClassIdsOut?: string[],
  ) {
    const order = await tx.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanTransition(order, toStatus, requester);

    const allowed = ALLOWED_TRANSITIONS[order.status];
    // ADMIN 可用 force=true 跳过状态机；其他角色或非 force 调用走标准检查
    const isAdminForce = force === true && requester.role === 'ADMIN';
    if (!allowed.includes(toStatus) && !isAdminForce) {
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
      const releaseSeat = async (
        scheduleId: string,
        cabin: import('@prisma/client').CabinClass,
        qty: number,
      ): Promise<void> => {
        if (qty <= 0) return;
        await tx.flightSeatClass.updateMany({
          where: { scheduleId, cabin },
          data: { sold: { decrement: qty } },
        });
        // 收集释放座位的舱位 id —— 调用方提交事务后排队候补检查
        if (releasedSeatClassIdsOut) {
          const sc = await tx.flightSeatClass.findFirst({
            where: { scheduleId, cabin },
            select: { id: true },
          });
          if (sc) releasedSeatClassIdsOut.push(sc.id);
        }
      };

      for (const item of order.items) {
        if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
        // 套餐升舱拆座的镜像还原：经济舱行下单时拆了 businessUpgradeCount 个座到商务舱，
        // 退座时也要按同一拆分各退各舱（否则会少退商务舱、多退经济舱）。
        const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
        const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
        const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
        await releaseSeat(item.flightScheduleId, 'BUSINESS', split.business);
        await releaseSeat(item.flightScheduleId, item.flightCabin, split.sameCabin);
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
  private async assertCanView(order: { userId: string | null; agentId: string | null }, requester: OrderRequester) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'CUSTOMER') {
      // 游客单（userId=null）无登录归属 → 普通客户不可通过此路径查看（走公开 lookup）
      if (!order.userId || order.userId !== requester.userId) throw new ForbiddenError('无权查看该订单');
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
    order: { userId: string | null; agentId: string | null; status: OrderStatus },
    toStatus: OrderStatus,
    requester: OrderRequester,
  ) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'CUSTOMER') {
      if (!order.userId || order.userId !== requester.userId) throw new ForbiddenError('无权操作该订单');
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

/** listOrders / 三模板导出共用的筛选字段（不含 RBAC / 接单 / 分页）。 */
export type OrderListFilters = Pick<
  ListOrdersQuery,
  | 'status'
  | 'agentId'
  | 'kind'
  | 'search'
  | 'from'
  | 'to'
  | 'travelFrom'
  | 'travelTo'
  | 'flightNumber'
  | 'passengerName'
  | 'invoiceStatus'
>;

/**
 * 把列表/导出共用的筛选参数转成 Prisma where。
 * listOrders 与 orders.export-templates.ts 三模板导出共用，避免两处过滤逻辑漂移。
 * 注意：不含 RBAC（userId/可见代理集合）、claimedById/unclaimedOnly、分页 —— 由调用方叠加。
 */
export function buildOrderFilterWhere(query: OrderListFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};

  if (query.status) where.status = query.status;
  if (query.agentId) where.agentId = query.agentId;
  if (query.kind) where.items = { some: { kind: query.kind } };
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
      ...(query.to ? { lte: new Date(`${query.to}T23:59:59Z`) } : {}),
    };
  }
  // 按出行日期筛选 — 跨 OrderItem 多种字段
  // FLIGHT: 取 schedule.departureTime；HOTEL: hotelCheckIn；其他暂时用 createdAt 兜底
  if (query.travelFrom || query.travelTo) {
    const start = query.travelFrom ? new Date(`${query.travelFrom}T00:00:00Z`) : undefined;
    const end = query.travelTo ? new Date(`${query.travelTo}T23:59:59Z`) : undefined;
    where.items = {
      some: {
        OR: [
          {
            flightSchedule: {
              departureTime: {
                ...(start ? { gte: start } : {}),
                ...(end ? { lte: end } : {}),
              },
            },
          },
          {
            hotelCheckIn: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {}),
            },
          },
        ],
      },
    };
  }
  if (query.invoiceStatus) where.invoiceStatus = query.invoiceStatus;
  // 航班号筛选 — 订单需含该航班号的 FLIGHT 行
  // 用 AND 叠加，避免覆盖 kind / 出行日期已占用的 where.items
  if (query.flightNumber) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        items: {
          some: {
            kind: OrderItemKind.FLIGHT,
            flightSchedule: {
              flight: {
                flightNumber: { equals: query.flightNumber, mode: 'insensitive' },
              },
            },
          },
        },
      },
    ];
  }
  // 乘客姓名模糊匹配
  if (query.passengerName) {
    where.passengers = {
      some: { fullName: { contains: query.passengerName, mode: 'insensitive' } },
    };
  }
  if (query.search) {
    where.OR = [
      { orderNumber: { contains: query.search, mode: 'insensitive' } },
      { contactName: { contains: query.search, mode: 'insensitive' } },
      { contactPhone: { contains: query.search } },
    ];
  }

  return where;
}

// ── 签证订单：护照有效期必填 ─────────────────────────────────────────
/**
 * items 含 VISA 行时，每位出行人都必须填写护照有效期（送签材料必填，
 * 缺失会导致使馆退件）。不含 VISA 行的订单不受此规则约束。
 *
 * 导出供 createOrder 调用 + 单测使用。
 */
export function assertVisaPassengersHavePassportExpiry(
  items: ReadonlyArray<Pick<OrderItemInput, 'kind'>>,
  passengers: ReadonlyArray<Pick<PassengerInput, 'passportExpiry'>>,
): void {
  const hasVisaItem = items.some((i) => i.kind === 'VISA');
  if (!hasVisaItem) return;
  const hasMissingExpiry = passengers.some((px) => !px.passportExpiry);
  if (hasMissingExpiry) {
    throw new BadRequestError('签证订单每位出行人需填写护照有效期');
  }
}

// ── 服务端价格校验（A3）─────────────────────────────────────────────
/**
 * 比对客户端提交的「单价 × 数量」与服务端权威「单价 × 数量」。
 * 偏差超过 PRICE_TOLERANCE_CNY（1.00 元）则抛 400，拒绝下单。
 * 用于 HOTEL/VISA/TRANSFER —— FLIGHT/BUNDLE 走各自动态重算，不需此通用比对。
 * 导出仅供单测使用。
 */
export function assertAmountWithinTolerance(
  label: string,
  clientUnitPrice: number,
  serverUnitPrice: number,
  quantity: number,
): void {
  const clientAmount = clientUnitPrice * quantity;
  const serverAmount = serverUnitPrice * quantity;
  if (Math.abs(clientAmount - serverAmount) > PRICE_TOLERANCE_CNY) {
    throw new BadRequestError(
      `${label}价格已变动（提交 ¥${clientAmount.toFixed(2)}，当前 ¥${serverAmount.toFixed(2)}），请刷新后重试`,
    );
  }
}

// ── 套餐酒店盖章 ─────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUNDLE_HOTEL_NIGHTS = 1;

/**
 * 套餐关联了酒店房型时，从订单行 metadata（goDate/returnDate）推导入住/退房日期。
 * - returnDate 合法且晚于 goDate → 用 returnDate 做退房日
 * - 否则按 goDate + hotelNights（默认 1 晚）推退房日
 * - 套餐没关联房型、或 goDate 缺失/非法 → 返回 null（不盖章，下单照常）
 *
 * 导出仅供单测使用。
 */
export function resolveBundleHotelStamp(
  bundle: { hotelRoomTypeId: string | null; hotelNights: number | null },
  metadata: Record<string, unknown> | undefined,
): { hotelRoomTypeId: string; hotelCheckIn: Date; hotelCheckOut: Date } | null {
  if (!bundle.hotelRoomTypeId) return null;
  const meta = bundleItemMetadataSchema.parse(metadata ?? {});
  if (!meta.goDate) return null;
  const checkIn = new Date(meta.goDate);
  if (Number.isNaN(checkIn.getTime())) return null;
  const returnDate = meta.returnDate ? new Date(meta.returnDate) : null;
  const checkOut =
    returnDate && !Number.isNaN(returnDate.getTime()) && returnDate.getTime() > checkIn.getTime()
      ? returnDate
      : new Date(checkIn.getTime() + (bundle.hotelNights ?? DEFAULT_BUNDLE_HOTEL_NIGHTS) * DAY_MS);
  return {
    hotelRoomTypeId: bundle.hotelRoomTypeId,
    hotelCheckIn: checkIn,
    hotelCheckOut: checkOut,
  };
}

// ── 套餐可选升级 add-on 重算（server-priced）─────────────────────────
/** 写到订单行 metadata.addOns 的升级重算明细（金额单位 CNY，整数）。 */
export interface BundleAddOnBreakdown {
  singleCount: number; // 选「一个人住酒店（单人入住）」的人数
  businessCount: number; // 选「升舱商务」的人数
  // 占座模型（赵姐需求）：成人 / 占座儿童 / 不占座婴儿
  adultCount: number; // 成人数（占座、占房）
  childCount: number; // 占座儿童数（占座、占房；机票按成人价减折扣）
  infantCount: number; // 不占座婴儿数（不占座、不占房；按婴儿价收）
  seatPax: number; // 占座人数 = adultCount + childCount（拼房按此计房；businessCount ≤ seatPax）
  headCount: number; // 全部出行人 = adultCount + childCount + infantCount（都需护照）
  rooms: number; // 拼房间数 = ceil(seatPax / 2)（婴儿不占房）
  nights: number; // 计费晚数（用于单人入住房差）
  legs: number; // 计费航段数（用于升舱商务）
  singleSupplementCnyPerNight: number; // 该套餐配置的单人入住房差/晚
  businessUpgradeCnyPerLeg: number; // 该套餐配置的升舱/航段
  childSeatDiscountCnyPerPerson: number; // 该套餐配置的占座儿童折扣/人
  infantPriceCny: number; // 该套餐配置的婴儿价/人
  singleSupplementTotal: number; // = singleCount × rate × nights
  businessUpgradeTotal: number; // = businessCount × rate × legs
  childSeatDiscountTotal: number; // = childCount × childSeatDiscountCnyPerPerson（机票折扣，负向计入套餐行）
  infantPriceTotal: number; // = infantCount × infantPriceCny（婴儿机票价，正向计入套餐行）
  total: number; // 升级加价 + 婴儿价 − 儿童折扣 的净额（计入套餐行总额）
}

/**
 * 套餐占座模型归一化（纯函数，向后兼容）。
 * 优先用订单行显式三计数；缺省时用 metadata.adultCount/childCount/infantCount；
 * 若三者都没有，则把旧的 pax（metadata.pax）或行 quantity 视为 adultCount（child/infant = 0），
 * 保证旧客户端/旧订单的占座 + 定价与扩展前完全一致。
 *
 * 导出供单测与 createOrder 共用。
 */
export interface BundleOccupancyInput {
  adultCount?: number;
  childCount?: number;
  infantCount?: number;
  quantity?: number;
  metadata?: Record<string, unknown>;
}
export interface BundleOccupancy {
  adultCount: number;
  childCount: number;
  infantCount: number;
  seatPax: number; // adult + child（占座）
  headCount: number; // adult + child + infant（出行人）
  rooms: number; // ceil(seatPax / 2)
}
export function resolveBundleOccupancy(item: BundleOccupancyInput): BundleOccupancy {
  const meta = bundleItemMetadataSchema.parse(item.metadata ?? {});
  const norm = (v: number | undefined): number | undefined =>
    v == null ? undefined : Math.max(0, Math.trunc(v));
  // 显式行字段优先，其次 metadata 字段
  const adultExplicit = norm(item.adultCount) ?? norm(meta.adultCount);
  const childExplicit = norm(item.childCount) ?? norm(meta.childCount);
  const infantExplicit = norm(item.infantCount) ?? norm(meta.infantCount);
  const hasExplicit =
    adultExplicit != null || childExplicit != null || infantExplicit != null;

  let adultCount: number;
  let childCount: number;
  let infantCount: number;
  if (hasExplicit) {
    adultCount = adultExplicit ?? 0;
    childCount = childExplicit ?? 0;
    infantCount = infantExplicit ?? 0;
  } else {
    // 向后兼容：旧 pax（metadata.pax）或行 quantity → 全部当成成人
    adultCount = Math.max(0, Math.trunc(meta.pax ?? item.quantity ?? 0));
    childCount = 0;
    infantCount = 0;
  }
  const seatPax = adultCount + childCount;
  const headCount = adultCount + childCount + infantCount;
  const rooms = Math.ceil(seatPax / 2); // 每人 0.5 间；婴儿不占房（旧拼房口径，展示用）
  return { adultCount, childCount, infantCount, seatPax, headCount, rooms };
}

// ── 按房型容量算所需房间数（C-v2 核心）────────────────────────────────
/**
 * 赵姐口径："每个酒店房型可以 fit 几大人几小孩；选的人数一间房坐不下时，自动加房。"
 *
 *   roomsNeeded = max( ceil(成人 / maxAdults), ceil(占座儿童 / maxChildren), 1 )
 *
 * - 婴儿不占床 → 不参与计算。
 * - maxChildren=0 且有占座儿童时：把儿童并入成人维度 ceil((adult+child)/maxAdults)
 *   近似（避免除 0；lone-child packing edge case）。正常配置 maxChildren≥1 不会走到这里。
 * - 套餐没绑房型 / 容量缺失 → 回退默认 2大1小（等价旧 ceil(seatPax/2)-ish 行为）。
 * - 注意：单人入住（singleCount）是独立自愿加价项，**不**计入 roomsNeeded —— 容量驱动房间数，
 *   单人入住是另算的 opt-in 房差。此口径有意为之，已向 owner 标注。
 *
 * 导出供单测与 createOrder 共用。
 */
export const DEFAULT_ROOM_MAX_ADULTS = 2;
export const DEFAULT_ROOM_MAX_CHILDREN = 1;
export function computeRoomsNeeded(
  occupancy: Pick<BundleOccupancy, 'adultCount' | 'childCount'>,
  capacity: { maxAdults?: number | null; maxChildren?: number | null } | null,
): number {
  const maxAdults = Math.max(1, Math.trunc(capacity?.maxAdults ?? DEFAULT_ROOM_MAX_ADULTS));
  const maxChildrenRaw = Math.trunc(capacity?.maxChildren ?? DEFAULT_ROOM_MAX_CHILDREN);
  const adults = Math.max(0, occupancy.adultCount);
  const children = Math.max(0, occupancy.childCount);

  const adultRooms = Math.ceil(adults / maxAdults);
  // maxChildren=0 → 该房型不单独承载儿童；把儿童并入成人维度（lone-child packing edge case）。
  const childRooms =
    maxChildrenRaw > 0
      ? Math.ceil(children / maxChildrenRaw)
      : Math.ceil((adults + children) / maxAdults);
  return Math.max(adultRooms, childRooms, 1);
}

/**
 * 套餐升级加价权威重算（不信任客户端金额）。公式：
 *   nights = stamp 推导的入住晚数（无房型 → hotelNights ?? 1）
 *   legs   = bundle.legs（来回默认 2）
 *   单人入住房差 = singleCount × singleSupplementCnyPerNight × nights
 *   升舱商务加价 = businessCount × businessUpgradeCnyPerLeg × legs
 * singleCount / businessCount 缺省 0 → total=0 → 套餐价与旧版完全一致（向后兼容）。
 *
 * 导出仅供单测使用。
 */
export function computeBundleAddOn(
  bundle: {
    hotelNights: number | null;
    singleSupplementCnyPerNight: number;
    businessUpgradeCnyPerLeg: number;
    childSeatDiscountCnyPerPerson: number;
    infantPriceCny: number;
    legs: number;
  },
  hotelStamp: { hotelCheckIn: Date; hotelCheckOut: Date } | null,
  singleCount: number | undefined,
  businessCount: number | undefined,
  occupancy: BundleOccupancy,
): { total: number; hasAddOn: boolean; breakdown: BundleAddOnBreakdown } {
  const single = Math.max(0, Math.trunc(singleCount ?? 0));
  // businessCount 不能超过占座人数（成人 + 占座儿童）；婴儿不占座、不能升舱
  const business = Math.min(
    Math.max(0, Math.trunc(businessCount ?? 0)),
    occupancy.seatPax,
  );
  // 计费晚数：优先用盖章推导的真实入住区间，否则回退套餐默认晚数（≥1）
  const nights = hotelStamp
    ? Math.max(
        1,
        Math.round((hotelStamp.hotelCheckOut.getTime() - hotelStamp.hotelCheckIn.getTime()) / DAY_MS),
      )
    : Math.max(1, bundle.hotelNights ?? DEFAULT_BUNDLE_HOTEL_NIGHTS);
  const legs = Math.max(1, bundle.legs);
  const singleRate = Math.max(0, bundle.singleSupplementCnyPerNight);
  const businessRate = Math.max(0, bundle.businessUpgradeCnyPerLeg);
  const childDiscountRate = Math.max(0, bundle.childSeatDiscountCnyPerPerson);
  const infantRate = Math.max(0, bundle.infantPriceCny);

  const singleSupplementTotal = single * singleRate * nights;
  const businessUpgradeTotal = business * businessRate * legs;
  // 占座儿童机票按成人价减折扣 → 套餐行净减 childCount × 折扣
  const childSeatDiscountTotal = occupancy.childCount * childDiscountRate;
  // 不占座婴儿机票收婴儿价（不走经济舱全价）→ 套餐行净加 infantCount × 婴儿价
  const infantPriceTotal = occupancy.infantCount * infantRate;
  // 升级加价 + 婴儿价 − 儿童折扣（向上夹到 0，避免套餐行出现负总额）
  const total = Math.max(
    0,
    singleSupplementTotal + businessUpgradeTotal + infantPriceTotal - childSeatDiscountTotal,
  );

  return {
    total,
    // 任一占座升级或儿童/婴儿差价存在 → 视为有 add-on（落 metadata 供运营/财务查看）
    hasAddOn:
      single > 0 ||
      business > 0 ||
      childSeatDiscountTotal > 0 ||
      infantPriceTotal > 0,
    breakdown: {
      singleCount: single,
      businessCount: business,
      adultCount: occupancy.adultCount,
      childCount: occupancy.childCount,
      infantCount: occupancy.infantCount,
      seatPax: occupancy.seatPax,
      headCount: occupancy.headCount,
      rooms: occupancy.rooms,
      nights,
      legs,
      singleSupplementCnyPerNight: singleRate,
      businessUpgradeCnyPerLeg: businessRate,
      childSeatDiscountCnyPerPerson: childDiscountRate,
      infantPriceCny: infantRate,
      singleSupplementTotal,
      businessUpgradeTotal,
      childSeatDiscountTotal,
      infantPriceTotal,
      total,
    },
  };
}

/**
 * 出行人数校验口径（纯函数，与前台 CheckoutPage 的 effectivePax 同源）。
 *
 * 同一批出行人会出现在多条订单行里 —— 往返机票拆成去/回两条 FLIGHT 行（各 quantity=pax），
 * 套餐 / 签证 / 接送也都是「按人」的产品。所需出行人数应是「单程最大人数」，不是各行相加：
 *   - FLIGHT：取各行 quantity 的 MAX（往返同一批人，绝不两段相加）
 *   - BUNDLE：每行 pax 取自 metadata.pax（缺失回退 quantity），多份套餐相加
 *   - VISA / TRANSFER：每行 quantity 相加
 *   - required = max(maxFlightLegQty, bundlePax, visaQty, transferPax)
 * 任一维度为 0 时不约束（required 仍由其余维度决定）；全为 0（无按人产品）→ 返回 0，不校验。
 *
 * 导出供单测与 createOrder 共用。
 */
export function computeRequiredPassengerCount(items: OrderItemInput[]): number {
  let maxFlightLegQty = 0;
  let bundlePax = 0;
  let visaQty = 0;
  let transferPax = 0;

  for (const item of items) {
    if (item.kind === 'FLIGHT') {
      // 往返两段共享乘客 → 取最大单段人数，不累加
      maxFlightLegQty = Math.max(maxFlightLegQty, item.quantity);
    } else if (item.kind === 'BUNDLE') {
      // 套餐出行人数 = 占座模型 headCount（成人 + 占座儿童 + 不占座婴儿，都需护照）。
      // 婴儿不占座但是出行人：FLIGHT 行 quantity = seatPax（占座），required 校验按 headCount。
      // 向后兼容：无三计数时把旧 pax / 行 quantity 当成全成人 → headCount = 旧 pax，结论与旧版一致。
      const occupancy = resolveBundleOccupancy({
        adultCount: item.adultCount,
        childCount: item.childCount,
        infantCount: item.infantCount,
        quantity: item.quantity,
        metadata: item.metadata,
      });
      bundlePax += occupancy.headCount;
    } else if (item.kind === 'VISA') {
      visaQty += item.quantity;
    } else if (item.kind === 'TRANSFER') {
      transferPax += item.quantity;
    }
  }

  return Math.max(maxFlightLegQty, bundlePax, visaQty, transferPax);
}

/**
 * 套餐升舱「拆座」模型（纯函数，扣座/退座共用，最终防超售）。
 *
 * 一个航段（FLIGHT 行）下单 `quantity` 人，其中 `businessUpgradeCount` 人选了升舱商务：
 *   - 升舱的人占用真实商务舱座位：BUSINESS += min(businessUpgradeCount, quantity)
 *   - 其余的人留在本行原舱位：原舱 += quantity − 上述商务数
 * 净占座仍 = quantity（不超售商务舱、不持有幽灵经济舱座位）。
 * 只有经济舱航段（cabin === 'ECONOMY'）才会被拆；其他舱位 businessUpgradeCount 视为 0。
 * businessUpgradeCount 缺省/0 → economy=quantity、business=0，与旧版行为完全一致（向后兼容）。
 *
 * 导出仅供单测使用。
 */
export function computeBundleSeatSplit(
  cabin: import('@prisma/client').CabinClass,
  quantity: number,
  businessUpgradeCount: number | undefined,
): { sameCabin: number; business: number } {
  const upgrade =
    cabin === 'ECONOMY'
      ? Math.min(Math.max(0, Math.trunc(businessUpgradeCount ?? 0)), quantity)
      : 0;
  return { sameCabin: quantity - upgrade, business: upgrade };
}

function passengerToData(p: PassengerInput) {
  // 自动拆 fullName → lastName/firstName，如果客户端没传
  const [autoLast, ...rest] = (p.fullName || '').trim().split(/\s+/);
  const autoFirst = rest.join(' ');
  return {
    fullName: p.fullName,
    lastName: p.lastName ?? autoLast ?? null,
    firstName: p.firstName ?? autoFirst ?? null,
    title: p.title ?? null,
    gender: p.gender ?? null,
    documentType: p.documentType,
    documentNumber: p.documentNumber,
    dateOfBirth: new Date(p.dateOfBirth),
    placeOfBirth: p.placeOfBirth ?? null,
    nationality: p.nationality,
    passengerType: p.passengerType,
    passportIssueCountry: p.passportIssueCountry ?? null,
    passportExpiry: p.passportExpiry ? new Date(p.passportExpiry) : null,
    visaNumber: p.visaNumber ?? null,
    visaType: p.visaType ?? null,
    visaIssueDate: p.visaIssueDate ? new Date(p.visaIssueDate) : null,
    visaExpiry: p.visaExpiry ? new Date(p.visaExpiry) : null,
    visaPlaceOfIssue: p.visaPlaceOfIssue ?? null,
    visaCountryOfApplication: p.visaCountryOfApplication ?? null,
    addressType: p.addressType ?? null,
    addressDetails: p.addressDetails ?? null,
    addressCity: p.addressCity ?? null,
    addressState: p.addressState ?? null,
    addressCountry: p.addressCountry ?? null,
    addressZip: p.addressZip ?? null,
    mealPreference: p.mealPreference,
    needsWheelchair: p.needsWheelchair ?? false,
    needsInfantBassinet: p.needsInfantBassinet ?? false,
    bedPref: p.bedPref ?? null,
    passportPhotoUrl: p.passportPhotoUrl ?? null,
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

// ── 公开订单脱敏视图（A4）────────────────────────────────────────────
export interface MaskedOrderView {
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'NONE';
  createdAt: Date;
  total: string;
  items: Array<{
    kind: OrderItemKind;
    productName: string;
    quantity: number;
    amount: string;
    travelDate: string | null; // 出行/入住日期（仅日期，无时间）
  }>;
  passengers: Array<{ name: string }>; // 仅名（given name），姓氏脱敏
}

/**
 * 脱敏中文/英文姓名：只保留「名」，姓氏打码。
 *   "张三"   → "张*"     （中文：首字 + *）
 *   "李小明" → "李**"
 *   "WANG MEI" → "W** MEI"（拉丁：首字母 + ** + 其余）
 * 兜底：无法判断时保留首字符 + *。
 */
export function maskFamilyName(fullName: string): string {
  const name = (fullName ?? '').trim();
  if (!name) return '*';
  // 拉丁姓名（含空格）：第一段视为姓 → 首字母 + **，其余原样
  if (/\s/.test(name)) {
    const [family, ...rest] = name.split(/\s+/);
    const maskedFamily = family.length <= 1 ? `${family}*` : `${family[0]}${'*'.repeat(Math.min(family.length - 1, 2))}`;
    return [maskedFamily, ...rest].join(' ');
  }
  // 中文姓名：首字（姓）+ 其余打码
  if (name.length <= 1) return `${name}*`;
  return `${name[0]}${'*'.repeat(name.length - 1)}`;
}

type OrderForMasking = Prisma.OrderGetPayload<{
  include: {
    items: { include: { flightSchedule: { select: { departureTime: true } } } };
    passengers: { select: { fullName: true; firstName: true } };
    payments: { select: { status: true } };
  };
}>;

/** 把 order（含 items/passengers/payments）转脱敏视图，绝不带内部字段。 */
function maskOrderForPublic(order: OrderForMasking): MaskedOrderView {
  // 取最近一笔成功支付；否则取任一支付状态；都没有 → NONE
  const succeeded = order.payments.some((p) => p.status === 'SUCCEEDED');
  const latest = order.payments[order.payments.length - 1];
  const paymentStatus: MaskedOrderView['paymentStatus'] = succeeded
    ? 'SUCCEEDED'
    : latest
      ? (latest.status as MaskedOrderView['paymentStatus'])
      : 'NONE';

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus,
    createdAt: order.createdAt,
    total: order.total.toString(),
    items: order.items.map((it) => ({
      kind: it.kind,
      productName: it.description,
      quantity: it.quantity,
      amount: it.amount.toString(),
      travelDate: maskedItemTravelDate(it),
    })),
    passengers: order.passengers.map((p) => ({ name: maskFamilyName(p.fullName) })),
  };
}

/** 行的出行/入住日期（仅日期字符串）；HOTEL→入住日，FLIGHT→出发日，否则 null。 */
function maskedItemTravelDate(it: {
  hotelCheckIn: Date | null;
  flightSchedule: { departureTime: Date } | null;
}): string | null {
  if (it.hotelCheckIn) return it.hotelCheckIn.toISOString().slice(0, 10);
  if (it.flightSchedule) return it.flightSchedule.departureTime.toISOString().slice(0, 10);
  return null;
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
