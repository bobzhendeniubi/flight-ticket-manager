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

    // 事务：写订单 + 扣座位 + 写状态事件
    const order = await prisma.$transaction(async (tx) => {
      // 再次 double-check 余票（防并发）
      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT') continue;
        const sc = await tx.flightSeatClass.findFirstOrThrow({
          where: { scheduleId: p.flightScheduleId!, cabin: p.flightCabin! },
        });
        if (sc.capacity - sc.sold < p.quantity) {
          throw new ConflictError(
            `${p.flightCabin} 余票不足：需要 ${p.quantity} 张，仅剩 ${sc.capacity - sc.sold} 张`,
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

      // 扣座位
      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT') continue;
        await tx.flightSeatClass.updateMany({
          where: { scheduleId: p.flightScheduleId!, cabin: p.flightCabin! },
          data: { sold: { increment: p.quantity } },
        });
      }

      return created;
    });

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
        priced.push({
          kind: 'HOTEL',
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: Math.round(item.unitPrice * item.quantity),
          hotelRoomTypeId: item.hotelRoomTypeId,
          hotelCheckIn: item.checkIn ? new Date(item.checkIn) : undefined,
          hotelCheckOut: item.checkOut ? new Date(item.checkOut) : undefined,
          metadata: item.metadata,
        });
      } else if (item.kind === 'TRANSFER') {
        priced.push({
          kind: 'TRANSFER',
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: Math.round(item.unitPrice * item.quantity),
          transferId: item.transferId,
          metadata: item.metadata,
        });
      } else if (item.kind === 'VISA') {
        priced.push({
          kind: 'VISA',
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: Math.round(item.unitPrice * item.quantity),
          visaId: item.visaId,
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

    // RBAC 过滤
    if (requester.role === 'CUSTOMER') {
      where.userId = requester.userId;
    } else if (requester.role === 'AGENT') {
      // 本人 + 所有下级代理
      const descendantIds = await this.getDescendantAgentIds(requester.agentId);
      where.agentId = { in: descendantIds };
    }
    // ADMIN/STAFF: 无额外过滤

    if (query.status) where.status = query.status;
    if (query.agentId) where.agentId = query.agentId;
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
    const order = await prisma.order.findUnique({
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

    // 事务：写 Order + 写事件 + 按需调整库存
    const updated = await prisma.$transaction(async (tx) => {
      const wasHolding = SEAT_HOLDING_STATUSES.includes(order.status);
      const isReleasing = SEAT_RELEASING_STATUSES.includes(toStatus);

      // 如果从"占用"转到"释放"，退库存
      if (wasHolding && isReleasing) {
        for (const item of order.items) {
          if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
          await tx.flightSeatClass.updateMany({
            where: { scheduleId: item.flightScheduleId, cabin: item.flightCabin },
            data: { sold: { decrement: item.quantity } },
          });
        }
      }

      // PAID 时补 paidAmount + 自动生成 CommissionRecord（代理层级）
      const extraData: Prisma.OrderUpdateInput = {};
      if (toStatus === 'PAID') {
        extraData.paidAmount = order.total;
      }

      // 转到 PAID：创建佣金记录（若有代理）
      if (toStatus === 'PAID' && order.agentId) {
        await createCommissionsForOrder(tx, order.id, order.agentId);
      }

      // 从 PAID 走到释放态（CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED）：撤销佣金
      if (isReleasing && wasHolding && order.status !== 'PENDING_PAYMENT') {
        await tx.commissionRecord.updateMany({
          where: { orderId: order.id, status: CommissionStatus.ACCRUED },
          data: { status: CommissionStatus.REVERSED },
        });
      }

      return tx.order.update({
        where: { id },
        data: {
          status: toStatus,
          ...extraData,
          statusEvents: {
            create: {
              fromStatus: order.status,
              toStatus,
              actorUserId: requester.userId,
              reason,
            },
          },
        },
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
    });

    return serializeOrder(updated);
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
      // 客户只能取消待支付订单
      if (toStatus !== 'CANCELLED' || order.status !== 'PENDING_PAYMENT') {
        throw new ForbiddenError('客户仅可取消待支付订单');
      }
      return;
    }
    if (requester.role === 'AGENT') {
      const ids = await this.getDescendantAgentIds(requester.agentId);
      if (!order.agentId || !ids.includes(order.agentId)) {
        throw new ForbiddenError('无权操作该订单');
      }
      // 代理暂时不许改状态（未来可放开"确认出票"）
      throw new ForbiddenError('代理暂无状态流转权限，请联系运营');
    }
  }

  // 查自己 + 所有后代代理 id（递归 BFS）
  private async getDescendantAgentIds(agentId: string | undefined): Promise<string[]> {
    if (!agentId) return [];
    const ids = new Set<string>([agentId]);
    let frontier: string[] = [agentId];
    while (frontier.length) {
      const children = await prisma.agent.findMany({
        where: { parentAgentId: { in: frontier } },
        select: { id: true },
      });
      frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
      frontier.forEach((id) => ids.add(id));
    }
    return Array.from(ids);
  }
}

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
    const rules = await tx.commissionRule.findMany({
      where: {
        agentId: { in: chain.map((c) => c.agentId) },
        productKind,
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
      },
    });
    const rateByAgent = new Map<string, number>();
    for (const r of rules) {
      // 同一 agent 可能多条规则（不同 effectiveFrom），取最新的
      const existing = rateByAgent.get(r.agentId);
      if (existing === undefined || Number(r.rate) > existing) {
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
