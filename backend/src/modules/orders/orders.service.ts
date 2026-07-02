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
  PrepaymentTxType,
  Prisma,
  ProductKind,
  ReceiptSource,
  SeatLockStatus,
  UserRole,
  VisaRequirement,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { resolveBundleNights } from '../products/bundle-nights.js';
import { getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { createOpenReceiptWithinTx } from '../receipts/receipts.service.js';
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
  UpdateItemSettlementPriceBody,
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

// 护照有效期规则（相对出发日）— 反馈：签证岗
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

/**
 * 解析订单的代理归属（登录用户）。佣金链路在订单转 PAID 时按 order.agentId 计算，
 * 因此 ADMIN/STAFF 代下单显式归属的代理，会与该代理本人下单产生完全相同的佣金链。
 *
 *   - AGENT：只能归属自己（忽略 body.agentId，代理不能替他人记单）。
 *   - ADMIN / STAFF：可显式传 body.agentId 归属某代理；先校验存在且 isActive，
 *     否则 404（不存在）/ 400（已停用）。不传则记为直客（null）。
 *   - 其他角色（如 CUSTOMER 自助下单）：无代理归属 → null。
 *
 * 导出供单测复用。
 */
export async function resolveOrderAgentId(
  requester: OrderRequester,
  bodyAgentId: string | undefined,
): Promise<string | null> {
  if (requester.role === 'AGENT') {
    return requester.agentId ?? null;
  }

  if (requester.role === 'ADMIN' || requester.role === 'STAFF') {
    if (!bodyAgentId) return null;
    const agent = await prisma.agent.findUnique({
      where: { id: bodyAgentId },
      select: { id: true, isActive: true },
    });
    if (!agent) {
      throw new NotFoundError(`指定的代理不存在：${bodyAgentId}`);
    }
    if (!agent.isActive) {
      throw new BadRequestError('指定的代理已停用，无法归属订单');
    }
    return agent.id;
  }

  return null;
}

/**
 * 批量散客建单：按 productType 构造每张子单的 items（与具体出行人无关，整批共用一份）。
 * 导出供单测复用。
 *   FLIGHT_ONEWAY    → [FLIGHT(outbound)]
 *   FLIGHT_ROUNDTRIP → [FLIGHT(outbound 去程), FLIGHT(return 返程)]，均同舱位
 *   BUNDLE           → [BUNDLE(bundleId, +单人入住/升舱份数, +goDate/returnDate metadata)]
 *                      复用 createOrder 的 BUNDLE 分支：服务端重算套餐价 + 盖酒店房型/入住日期
 *                      → 房控/销控自动计入套餐占房（这是「销控酒店不减」的修复点）。
 *
 * 缺省/旧调用（只传 flightScheduleId、productType 缺省）按 FLIGHT_ONEWAY 处理（向后兼容）。
 * 校验由 batchCreateOrdersBodySchema.superRefine 完成（outbound/cabin/return/bundleId 必填），
 * 此处仅做断言式兜底（理论上不会触发）。
 */
export function buildBatchItems(
  body: BatchCreateOrdersBody,
  productType: BatchCreateOrdersBody['productType'],
  outbound: string | undefined,
  bundleDates: { goDate?: string; returnDate?: string } = {},
): OrderItemInput[] {
  if (productType === 'BUNDLE') {
    if (!body.bundleId) throw new BadRequestError('BUNDLE 类型必须提供 bundleId');
    const metadata: Record<string, unknown> = {};
    if (bundleDates.goDate) metadata.goDate = bundleDates.goDate;
    if (bundleDates.returnDate) metadata.returnDate = bundleDates.returnDate;
    return [
      {
        kind: 'BUNDLE',
        description: body.description,
        quantity: 1,
        bundleId: body.bundleId,
        // unitPrice 由服务端权威重算（createOrder BUNDLE 分支忽略前端传值，0 仅占位）
        unitPrice: 0,
        // 可选升级 add-on 份数（缺省 0 = 无升级）
        singleCount: body.bundleSingleCount ?? 0,
        businessCount: body.bundleBusinessCount ?? 0,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    ];
  }

  if (!outbound) {
    throw new BadRequestError('FLIGHT 类型必须提供 outboundScheduleId（或 flightScheduleId）');
  }
  if (!body.flightCabin) {
    throw new BadRequestError('FLIGHT 类型必须提供 flightCabin');
  }

  if (productType === 'FLIGHT_ROUNDTRIP') {
    if (!body.returnScheduleId) {
      throw new BadRequestError('FLIGHT_ROUNDTRIP 必须提供 returnScheduleId');
    }
    // 每位出行人 2 条 FLIGHT 行（去程 + 返程），createOrder 据此对两个班次各做一次原子扣座。
    return [
      {
        kind: 'FLIGHT',
        description: `${body.description} 去程`,
        quantity: 1,
        flightScheduleId: outbound,
        flightCabin: body.flightCabin,
      },
      {
        kind: 'FLIGHT',
        description: `${body.description} 返程`,
        quantity: 1,
        flightScheduleId: body.returnScheduleId,
        flightCabin: body.flightCabin,
      },
    ];
  }

  // FLIGHT_ONEWAY（含旧调用兜底）
  return [
    {
      kind: 'FLIGHT',
      description: body.description,
      quantity: 1,
      flightScheduleId: outbound,
      flightCabin: body.flightCabin,
    },
  ];
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

    // 联系人默认=录入人，电话选填（Order.contactName/contactPhone 为非空列，必须落具体值）：
    //   - 登录用户缺省时用登录账号兜底（与 batchCreateOrders 同口径）。
    //   - 游客缺省时用 guestContact 兜底（游客联系人路由层已断言存在）。
    const trimmedName = body.contactName?.trim();
    const trimmedPhone = body.contactPhone?.trim();
    let contactName = trimmedName || guest?.name || '系统录入';
    let contactPhone = trimmedPhone || guest?.phone || '-';
    // 仅当登录用户且联系人/电话有缺省时，才查录入人兜底 —— 两项都已填则跳过这次 DB 查询。
    if (!isGuest && (!trimmedName || !trimmedPhone)) {
      const recorder = await prisma.user.findUnique({
        where: { id: requester.userId },
        select: { displayName: true, email: true, phone: true },
      });
      contactName = trimmedName || recorder?.displayName || recorder?.email || '系统录入';
      contactPhone = trimmedPhone || recorder?.phone || '-';
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
    // body.flightSettlementPriceCny 存在 → 团队议价结算价覆盖机票价（鉴权在路由/批量层完成）。
    const pricedItems = await this.priceAndValidateItems(
      body.items,
      body.flightSettlementPriceCny,
    );

    // 签证订单规则：含 VISA 行时每位出行人必须填写护照有效期（送签材料必填）
    assertVisaPassengersHavePassportExpiry(body.items, body.passengers);

    // 护照有效期规则（相对出发日）：<90 天禁止下单；不足 6 个月每人 +200 临期附加费
    await this.applyPassportExpiryRule(body, pricedItems);

    const subtotal = pricedItems.reduce((sum, p) => sum + p.amount, 0);
    const total = subtotal; // 目前没有 taxes / discount，直接等于 subtotal

    // 代理归属判定：
    //   游客 / 直客 → null；AGENT 自助 → 自己的 agentId（忽略 body.agentId）；
    //   ADMIN·STAFF 录单 → 可显式归属 body.agentId（校验存在且在用），否则 null。
    const agentId = isGuest
      ? null
      : await resolveOrderAgentId(requester, body.agentId);

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
          contactName,
          contactPhone,
          contactEmail: body.contactEmail,
          paymentExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 分钟后超时
          idempotencyKey: body.idempotencyKey,
          notes: body.notes,
          // 订单级签证状态 + 结构化备注四栏（可选；不传则留空，与旧行为一致）
          visaStatus: body.visaStatus ?? null,
          noteHotel: body.noteHotel ?? null,
          noteVisa: body.noteVisa ?? null,
          notePayment: body.notePayment ?? null,
          noteSpecial: body.noteSpecial ?? null,
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
              // 计费房间数（支持 0.5 间）：套餐/酒店行解析后落库，供房控读取。
              roomsBilled: p.roomsBilled != null ? new Prisma.Decimal(p.roomsBilled) : null,
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

    // 事务成功后：下单即建签证任务（best-effort）——让「录进去但还没付款」的需签证单也进签证台。
    // 放在订单事务外，签证任务建失败也不回滚订单（PAID 时会再补建，幂等）。其余岗位任务仍留到 PAID。
    try {
      await createVisaTaskAtCreation(prisma, order.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to create visa task at order creation for', order.id, err);
    }

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
   * 护照有效期业务规则（反馈：签证岗）。仅对有出发日的订单（含 FLIGHT）生效，
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

  /**
   * @param flightSettlementPriceCny 团队议价结算价（CNY/人）。设置时覆盖 FLIGHT 行的
   *   动态价：unitPrice = 结算价，amount = 结算价 × quantity。仅改价格，绝不动
   *   quantity / flightScheduleId / flightCabin —— 扣座（CAS）仍按 quantity 执行。
   *   缺省 → 走动态定价（旧行为）。
   */
  private async priceAndValidateItems(
    items: OrderItemInput[],
    flightSettlementPriceCny?: number,
  ) {
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
      // 解析后的计费房间数（支持 0.5 间）。落到 OrderItem.roomsBilled 供房控读取。
      roomsBilled?: number;
      metadata?: Record<string, unknown>;
    }> = [];

    // 本单所有 BUNDLE 行选「升舱商务」的总人数（多份套餐叠加）。
    // 循环结束后分摊到本单的经济舱 FLIGHT 航段：每段占用 businessUpgradeCount 个真实商务舱座位。
    let bundleBusinessUpgradeCount = 0;

    // 套餐折扣（bundleId → discountPct 0..100）：循环里从 DB 读，循环后对该套餐的
    // BUNDLE 行 + 关联 FLIGHT 腿逐行 ×(1−pct/100)，使「整个全包价打折」且各行金额诚实
    // （航班行=折后机票收入，财务航班毛利不假高）。pct 只从 DB 取，不信前端。
    const bundleDiscountPct = new Map<string, number>();

    for (const item of items) {
      if (item.kind === 'FLIGHT') {
        // 团队议价结算价：整批以谈定的每人结算价覆盖动态/目录机票价。
        // 仅改价格，扣座 quantity / 班次 / 舱位完全不变（CAS 仍按 quantity 执行）。
        if (flightSettlementPriceCny !== undefined) {
          priced.push({
            kind: 'FLIGHT',
            description: item.description,
            quantity: item.quantity,
            unitPrice: flightSettlementPriceCny,
            amount: Math.round(flightSettlementPriceCny * item.quantity),
            flightScheduleId: item.flightScheduleId,
            flightCabin: item.flightCabin,
            bundleId: item.bundleId,
            metadata: {
              ...(item.metadata ?? {}),
              // 审计：标记本行价格来自团队议价结算价（非动态价）
              priceOverride: 'TEAM_SETTLEMENT',
              settlementPriceCny: flightSettlementPriceCny,
            },
          });
          continue;
        }
        // 动态定价重算 — 这是唯一权威价格源（无议价结算价时）
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
          bundleId: item.bundleId,
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
        // 计费房间数（支持 0.5 间）：录单方显式传 roomsBilled 时按其缩放，缺省 1（与旧版一致）。
        // 单独 HOTEL 行无套餐占座模型，故不走 computeRoomsNeeded（那是套餐容量口径）。
        const rooms = item.roomsBilled ?? 1;
        if (item.hotelRoomTypeId) {
          const rt = await prisma.hotelRoomType.findUnique({
            where: { id: item.hotelRoomTypeId },
            select: { basePrice: true, hotel: { select: { isActive: true } } },
          });
          if (!rt) throw new NotFoundError(`酒店房型 ${item.hotelRoomTypeId} 不存在`);
          if (!rt.hotel.isActive) throw new BadRequestError('酒店已下架');
          unitPrice = Number(rt.basePrice);
          // A3：拒绝偏离服务端权威价超容差的提交（仅有产品 id 时校验，无 id 走信任旧路径）。
          // 0.5 间：金额随 roomsBilled 缩放，容差按同一房间数口径比较，避免误判价格变动。
          assertAmountWithinTolerance('酒店', item.unitPrice, unitPrice, item.quantity * rooms);
        }
        priced.push({
          kind: 'HOTEL',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          // 单独 HOTEL 行：unitPrice×qty×rooms（rooms 缺省 1 → 与旧版一致）。
          amount: Math.round(unitPrice * item.quantity * rooms),
          hotelRoomTypeId: item.hotelRoomTypeId,
          hotelCheckIn: item.checkIn ? new Date(item.checkIn) : undefined,
          hotelCheckOut: item.checkOut ? new Date(item.checkOut) : undefined,
          roomsBilled: rooms,
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
            // 套餐折扣（%）：整个全包价(机票+地面+加项) × (1 − discountPct/100)；下方逐行打折
            discountPct: true,
            isActive: true,
            hotelRoomTypeId: true,
            hotelNights: true,
            // 可选升级加价费率（server-priced，按产品可配置）+ 航段数
            singleSupplementCnyPerNight: true,
            businessUpgradeCnyPerLeg: true,
            // 占座儿童折扣 / 婴儿价（server-priced，按产品可配置）
            childSeatDiscountCnyPerPerson: true,
            infantPriceCny: true,
            // 自备签证减免（出行人自行办妥签证时从套餐行扣减；server-priced）
            selfVisaDeductCny: true,
            legs: true,
            // 关联房型容量 → 算 roomsNeeded（自动加房，套餐酒店部分按房价 ×rooms 收费）
            // basePrice：套餐酒店行的权威每间每晚价（服务端重算，不信 items JSON 里的 unitPrice —
            //   历史上 items 里的 HOTEL.unitPrice 可能是占位/过时的畸低值，导致套餐酒店部分只算出几元）。
            // hotelId：出发日期房量库存校验（无房不让下单）。
            hotelRoomType: {
              select: {
                maxAdults: true,
                maxChildren: true,
                basePrice: true,
                hotelId: true,
                hotel: { select: { isActive: true } },
              },
            },
          },
        });
        if (!bundle) throw new NotFoundError(`套餐 ${item.bundleId} 不存在`);
        if (!bundle.isActive) throw new BadRequestError('套餐已下架');
        // 套餐绑定的酒店房型若其酒店已下架 → 拒单（与单独 HOTEL 行同口径，防止经套餐绕过下架酒店）。
        if (bundle.hotelRoomType && !bundle.hotelRoomType.hotel.isActive) {
          throw new BadRequestError('酒店已下架');
        }
        // 记下该套餐折扣（%），循环后对本套餐的 BUNDLE 行 + 关联 FLIGHT 腿逐行打折。
        if (item.bundleId) bundleDiscountPct.set(item.bundleId, bundle.discountPct ?? 0);
        // 住宿晚数：单一权威口径（hotelNights ?? 首个 HOTEL 组件 qty ?? 默认）。
        // 一次解析，喂给酒店盖章 + 升级 add-on，保证回程日期 / 单人入住房差 / HOTEL 地面价口径一致。
        const nights = resolveBundleNights(bundle.items, bundle.hotelNights);
        // 占座模型归一化（成人 / 占座儿童 / 不占座婴儿；向后兼容旧 pax → 全成人）。
        // 先算占座，再据房型容量推 roomsNeeded（酒店地面部分按房间数缩放）。
        const occupancy = resolveBundleOccupancy({
          adultCount: item.adultCount,
          childCount: item.childCount,
          infantCount: item.infantCount,
          quantity: item.quantity,
          metadata: item.metadata,
        });
        // 计费房间数（server-authoritative，钱路径权威计算）：
        //   · 容量口径 physicalRooms = computeRoomsNeeded（选的人数一间坐不下自动加房）：
        //       max( ceil(成人/maxAdults), ceil(占座儿童/maxChildren), 1 )；缺房型回退默认 2大1小。
        //   · 单人拼房 0.5 间：绑了套餐房型 且 1 成人 0 儿童（婴儿不占房）且非独住（singleCount=0）
        //       → 只按 0.5 间收（床位口径）；独住（singleCount≥1）照旧整间 + 单人入住房差。
        //   · 客户端 roomsBilled 只能上调不能下压（max(client, roomsCharged)）——防止把多人单伪造成 0.5 间。
        // 单一权威口径由 computeBundleRoomsCharged 提供（单测与本分支共用，避免漂移）。
        const rooms = computeBundleRoomsCharged({
          occupancy,
          capacity: bundle.hotelRoomType,
          hotelRoomTypeId: bundle.hotelRoomTypeId,
          singleCount: item.singleCount,
          clientRoomsBilled: item.roomsBilled,
        });

        // 酒店行的权威每间每晚价：套餐绑了房型 → 用 HotelRoomType.basePrice（服务端重算），
        // 绝不信任 bundle.items JSON 里的 HOTEL.unitPrice（历史上可能是占位/过时的畸低值，
        // 会把套餐酒店部分算成几元 → 整单总价崩塌）。未绑房型的老套餐才回退到 JSON 里的 unitPrice。
        const linkedHotelNightlyPrice =
          bundle.hotelRoomTypeId && bundle.hotelRoomType
            ? Number(bundle.hotelRoomType.basePrice)
            : null;

        // 地面部分价（机票部分留给 FLIGHT item 单独动态定价）：
        //   HOTEL 行（qty=晚数）按 每间每晚价×qty×rooms 收费 → 套餐价随房间数涨；
        //     每间每晚价 = linkedHotelNightlyPrice（权威）优先，回退 JSON 里的 unitPrice。
        //   非 HOTEL 地面行（TRANSFER/VISA 等）固定 unitPrice×qty×1（不随房间数变）。
        //   bundleGround = Σ(HOTEL×rooms) + Σ(其它非机票)。折扣不在此扣 —— 改由循环后的
        //   percent-off 后处理对「机票腿 + 套餐行」整体 ×(1−discountPct/100)（旧的固定 groundDiscount 已弃用）。
        const bundleItems = (bundle.items as Array<{ kind: string; qty: number; unitPrice: number }>) ?? [];
        const groundTotal = bundleItems
          .filter((b) => b.kind !== 'FLIGHT')
          .reduce((s, b) => {
            if (b.kind === 'HOTEL') {
              const nightlyPrice = linkedHotelNightlyPrice ?? b.unitPrice;
              return s + b.qty * nightlyPrice * rooms;
            }
            return s + b.qty * b.unitPrice;
          }, 0);
        const bundleUnitPrice = Math.max(0, Math.round(groundTotal));
        // 套餐关联酒店 → 把房型+入住日期盖到订单行（房控板自动计入套餐占房）。
        // metadata 缺失/异常时只是不盖章，绝不阻断下单。
        const hotelStamp = resolveBundleHotelStamp(bundle, item.metadata, nights);

        // ── 出发日期房量库存校验（房量不足不让下单）──────────────────────────
        // 套餐绑了房型 + 能推出入住区间（有 goDate 盖章）时，校验整段每一晚都有足够余房。
        // 口径与房控/前台可售日期完全一致（getHotelNightlyRemaining）：
        //   hasBlock=false（该酒店没配任何包房周期，即未做库存管控）→ 不拦截（与既有 E2E 一致）；
        //   逐晚判定：block[i] > 0（该晚确被包房周期管控）且 remaining[i] < rooms（余房不够本单所需房间数）→ 抛错。
        //     · 只看被周期覆盖的晚（block[i] > 0）：未被任何周期覆盖的晚（block[i] === 0）视为未管控，不据此拦截。
        //     · 与本单所需房间数 rooms 比较（多大人可能需 2+ 间）：只要够 1 间就放行会导致超卖。
        // 无盖章（缺 goDate）→ 无从确定入住日期，不在此拦截（沿用既有"缺 goDate 不盖章"的宽松口径）。
        if (hotelStamp && bundle.hotelRoomType) {
          const nightDates = buildStayNightDates(hotelStamp.hotelCheckIn, hotelStamp.hotelCheckOut);
          if (nightDates.length > 0) {
            const { remaining, hasBlock, block } = await getHotelNightlyRemaining(
              bundle.hotelRoomType.hotelId,
              nightDates,
            );
            if (hasBlock && remaining.some((r, i) => block[i] > 0 && r < rooms)) {
              throw new BadRequestError('该出发日期酒店可用房量不足，请更换日期或联系客服');
            }
          }
        }

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
          nights,
          item.selfProvidedVisa,
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
          // 解析后的计费房间数（支持 0.5 间）落到 OrderItem.roomsBilled，供房控读取。
          roomsBilled: rooms,
          // 把升级选择 + 重算明细 + roomsNeeded 落到订单行 metadata，供运营/财务查看
          //（admin 内部仍可叫"单房差/升舱"；roomsNeeded 解释酒店部分为何按房价 ×rooms 收费）
          metadata: addOn.hasAddOn || rooms > 1
            ? { ...(item.metadata ?? {}), roomsNeeded: rooms, addOns: addOn.breakdown }
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

    // ── 套餐折扣（percent off）：整个全包价 ×(1−pct/100) ──
    // 逐行对该套餐的 BUNDLE 行 + 关联 FLIGHT 腿打折，使 Σ(行金额) = 全包价×(1−pct)，且各行金额诚实：
    //   航班行 = 折后机票收入（财务航班毛利按折后算，不假高）；套餐行 = 折后地面+加项。
    // 扣座/锁位/查重均按 quantity（不受金额影响）。pct 仅来自 DB（不信前端）。折扣在升舱拆座之后做，不动 quantity。
    for (const p of priced) {
      if (p.kind !== 'BUNDLE' && p.kind !== 'FLIGHT') continue;
      const pct = p.bundleId ? bundleDiscountPct.get(p.bundleId) ?? 0 : 0;
      if (pct <= 0) continue;
      const factor = (100 - pct) / 100;
      p.amount = Math.round(p.amount * factor);
      p.unitPrice = Math.round(p.unitPrice * factor);
      p.metadata = { ...(p.metadata ?? {}), bundleDiscountPct: pct };
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
          agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
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
        // 联查酒店中文名（HOTEL 行 或 BUNDLE 行盖章的 hotelRoomTypeId 均可命中）：
        // 套餐订单没有独立的 HOTEL 行，酒店只盖章在 BUNDLE 行的 hotelRoomTypeId 上，
        // 这里联查出真实酒店名供 serializeOrder 落到 item.hotelName（分房弹窗/详情页据此取名）。
        items: { include: { hotelRoomType: { select: { hotel: { select: { name: true } } } } } },
        passengers: true, // 含护照/签证/地址全部新字段
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
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
  // 代理余额账户 —— 多付存入 / 用余额抵尾款
  // （取代「跨人抵扣」：多付不再直接抵给别的客户，而是进代理自己的预存余额账户；
  //  少付从同一余额顶。ADMIN/STAFF 操作，全程事务安全 + 审计 + 余额不为负。）
  // ════════════════════════════════════════════════════════════════════

  /**
   * 多付存入代理余额。订单有代理且 paidAmount > total（多付）时：
   *   一个事务里：order.paidAmount 回压到 total（消掉多付），代理 prepaymentBalance += 多付额，
   *   写一条 PrepaymentTransaction（TOP_UP，钱进余额）+ 关联 orderId。
   * 无代理 / 无多付 → 拒绝。
   */
  async creditOverpayToAgent(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    creditedAmount: number;
    newPaidAmount: number;
    total: number;
    agentBalanceAfter: number;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可将多付存入代理余额');
    }

    return prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁：事务内读最新 paidAmount/total，避免与并发到账/抵扣用旧快照
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          agentId: string | null;
          total: Prisma.Decimal;
          paidAmount: Prisma.Decimal;
        }>
      >`SELECT id, "orderNumber", "agentId", total, "paidAmount" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      if (!order.agentId) throw new BadRequestError('该订单无归属代理，无法存入代理余额');

      const total = Number(order.total);
      const paid = Number(order.paidAmount);
      const overpay = round2(paid - total);
      if (overpay <= 0) {
        throw new BadRequestError('该订单没有多付金额（paidAmount ≤ total），无可存入余额');
      }

      // 代理余额行锁 + 事务内累加（与 settlements PAID 抵扣同一并发安全口径）
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${order.agentId} FOR UPDATE
      `;
      if (!agentRows[0]) throw new NotFoundError('代理不存在');
      const balanceAfter = round2(Number(agentRows[0].prepaymentBalance) + overpay);

      await tx.agent.update({
        where: { id: order.agentId },
        data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
      });
      // 多付回压：订单 paidAmount 降回 total（订单恰好结清，不再显示多付）
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(total) },
      });
      await tx.prepaymentTransaction.create({
        data: {
          agentId: order.agentId,
          amount: new Prisma.Decimal(overpay), // 正数 = 入账
          balanceAfter: new Prisma.Decimal(balanceAfter),
          type: PrepaymentTxType.TOP_UP,
          orderId,
          description: `订单 ${order.orderNumber} 多付转存代理余额`,
          createdById: actor.userId,
        },
      });

      return {
        ok: true as const,
        orderId,
        orderNumber: order.orderNumber,
        agentId: order.agentId,
        creditedAmount: overpay,
        newPaidAmount: total,
        total,
        agentBalanceAfter: balanceAfter,
      };
    });
  }

  /**
   * 用代理余额抵订单尾款。订单有代理、代理余额 ≥ amount、amount ≤ 尾款（total − paidAmount，须 > 0）时：
   *   一个事务里：代理 prepaymentBalance -= amount，order.paidAmount += amount，
   *   写一条 PrepaymentTransaction（OFFSET，余额用在订单上）+ 关联 orderId；
   *   若抵扣后已全额覆盖且订单仍在 PENDING_PAYMENT，复用 _updateStatusWithinTx 推 PAID
   *   （同走佣金 / 履约任务生成那一套）。
   * 无代理 / 超抵（amount > 尾款）/ 余额不足 → 拒绝；余额不会为负。
   */
  async applyAgentBalanceToOrder(
    orderId: string,
    amount: number,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    appliedAmount: number;
    newPaidAmount: number;
    total: number;
    fullyPaid: boolean;
    status: OrderStatus;
    agentBalanceAfter: number;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可用代理余额抵尾款');
    }
    const apply = round2(amount);
    if (apply <= 0) throw new BadRequestError('抵扣金额必须大于 0');

    const pendingFulfillmentTaskIds: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      // 订单行锁 + 事务内读最新尾款
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          agentId: string | null;
          total: Prisma.Decimal;
          paidAmount: Prisma.Decimal;
          status: OrderStatus;
        }>
      >`SELECT id, "orderNumber", "agentId", total, "paidAmount", status FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      if (!order.agentId) throw new BadRequestError('该订单无归属代理，无法用代理余额抵扣');

      const total = Number(order.total);
      const paid = Number(order.paidAmount);
      const remaining = round2(total - paid);
      if (remaining <= 0) throw new BadRequestError('该订单无尾款（已结清或多付），无需抵扣');
      if (apply > remaining + 0.001) {
        throw new BadRequestError(
          `抵扣金额 ¥${apply.toFixed(2)} 超过尾款 ¥${remaining.toFixed(2)}，已拒绝`,
        );
      }

      // 代理余额行锁：余额不足直接拒，绝不透支为负
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${order.agentId} FOR UPDATE
      `;
      if (!agentRows[0]) throw new NotFoundError('代理不存在');
      const balance = Number(agentRows[0].prepaymentBalance);
      if (apply > balance + 0.001) {
        throw new BadRequestError(
          `代理余额 ¥${balance.toFixed(2)} 不足以抵扣 ¥${apply.toFixed(2)}，已拒绝`,
        );
      }
      const balanceAfter = round2(balance - apply);
      const newPaid = round2(paid + apply);
      const fullyPaid = newPaid + 0.001 >= total;

      await tx.agent.update({
        where: { id: order.agentId },
        data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(newPaid) },
      });
      await tx.prepaymentTransaction.create({
        data: {
          agentId: order.agentId,
          amount: new Prisma.Decimal(-apply), // 负数 = 余额扣减（用在订单上）
          balanceAfter: new Prisma.Decimal(balanceAfter),
          type: PrepaymentTxType.OFFSET,
          orderId,
          description: `订单 ${order.orderNumber} 代理余额抵尾款`,
          createdById: actor.userId,
        },
      });

      // 抵满 + 仍待支付 → 复用 PAID 流转（含佣金 / 履约任务）
      let finalStatus: OrderStatus = order.status;
      if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
        await this._updateStatusWithinTx(
          tx,
          orderId,
          OrderStatus.PAID,
          { userId: actor.userId, role: actor.role, actorType: 'USER' },
          `代理余额抵尾款（¥${apply.toFixed(2)}）结清`,
          pendingFulfillmentTaskIds,
        );
        finalStatus = OrderStatus.PAID;
      }

      return {
        ok: true as const,
        orderId,
        orderNumber: order.orderNumber,
        agentId: order.agentId,
        appliedAmount: apply,
        newPaidAmount: newPaid,
        total,
        fullyPaid,
        status: finalStatus,
        agentBalanceAfter: balanceAfter,
      };
    });

    // 事务外 enqueue fulfillment（与 confirmManualPayment 一致）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[orders] failed to enqueue fulfillment task:', e);
        });
      }
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════════
  // 订单超额 → 挂账池（游客版「存代理余额」；对账时再认领/退款）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 把订单的多付额转入挂账池。适用于任意订单（游客 OR 代理）——
   * 这是「超额放挂账池」的答案，对应代理单的 creditOverpayToAgent。
   *   一个事务里：订单行锁 → 多付 = paidAmount − total（> 0 才放行）→ paidAmount 回压到 total →
   *   建一笔 OPEN Receipt（source=ORDER_OVERPAY，金额=多付额，method 取最近一笔 Payment 否则 WECHAT_PAY，
   *   payerNote='订单超额 '+orderNo，orderHintId=orderId）。
   * 无多付（paidAmount ≤ total）→ 拒绝。原子。
   */
  async overpayToPool(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    movedAmount: number;
    newPaidAmount: number;
    total: number;
    receiptId: string;
    receiptNo: string;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可将订单超额转入挂账池');
    }

    return prisma.$transaction(async (tx) => {
      // 订单行锁 + 事务内读最新 paidAmount/total（与并发到账/抵扣同一并发安全口径）
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderNumber: string; total: Prisma.Decimal; paidAmount: Prisma.Decimal }>
      >`SELECT id, "orderNumber", total, "paidAmount" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');

      const total = Number(order.total);
      const paid = Number(order.paidAmount);
      const overpay = round2(paid - total);
      if (overpay <= 0) {
        throw new BadRequestError('该订单没有多付金额（paidAmount ≤ total），无可转入挂账池');
      }

      // method 兜底：取最近一笔 Payment 的 method，否则 WECHAT_PAY
      const latestPayment = await tx.payment.findFirst({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
        select: { method: true },
      });
      const method = latestPayment?.method ?? PaymentMethod.WECHAT_PAY;

      // 多付回压：订单 paidAmount 降回 total（订单恰好结清，不再显示多付）
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(total) },
      });

      // 建一笔 OPEN 进账（挂账池），来源标记订单超额
      const receipt = await createOpenReceiptWithinTx(tx, {
        amountCny: overpay,
        method,
        source: ReceiptSource.ORDER_OVERPAY,
        payerNote: `订单超额 ${order.orderNumber}`,
        orderHintId: orderId,
        createdById: actor.userId,
      });

      return {
        ok: true as const,
        orderId,
        orderNumber: order.orderNumber,
        movedAmount: overpay,
        newPaidAmount: total,
        total,
        receiptId: receipt.id,
        receiptNo: receipt.receiptNo,
      };
    });
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

  /**
   * 客户上传付款凭证用的轻量校验 —— 与公开订单查询同一套防枚举门禁。
   *   orderNo + lookupKey 必须命中（lookupKey 任一匹配：手机号 / 邮箱 / 订单联系人姓氏）。
   * 命中返回订单 id + 应付尾款（amountCny 缺省时用作进账额）；不命中返回 null（路由 → 拒绝）。
   * 只读，绝不入账。
   */
  async lookupOrderForReceiptUpload(
    orderNumber: string,
    lookupKey: string,
  ): Promise<{ orderId: string; balanceCny: number } | null> {
    const order = await prisma.order.findUnique({
      where: { orderNumber },
      include: { user: { select: { phone: true, email: true } } },
    });
    if (!order) return null;

    const key = lookupKey.trim();
    if (!key) return null;
    const keyLower = key.toLowerCase();

    const phones = [order.guestPhone, order.contactPhone, order.user?.phone]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim());
    const emails = [order.guestEmail, order.contactEmail, order.user?.email]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase());
    // 姓氏匹配：联系人 / 游客姓名首段（与公开查单同口径），忽略大小写。
    // 只取首段（拉丁名首词 / 中文整名），不再接受单字符首字匹配——
    // 单字符的猜测空间太小，会削弱公开上传的第二因子强度。
    const names = [order.contactName, order.guestName]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim());
    const lastNames = names.flatMap((n) => {
      const segs = n.split(/\s+/).filter(Boolean);
      return segs.length > 0 ? [segs[0].toLowerCase()] : [];
    });

    const matched =
      phones.includes(key) || emails.includes(keyLower) || lastNames.includes(keyLower);
    if (!matched) return null;

    const balanceCny = round2(Number(order.total) + (order.adjustmentCny ?? 0) - Number(order.paidAmount));
    return { orderId: order.id, balanceCny: Math.max(0, balanceCny) };
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
   * 批量散客建单：选一个航班班次 + 舱位，名单里每位乘客各成一单（FLIGHT × 1）。
   * 录入人即登录账号 —— 联系人/电话默认取登录用户（displayName / phone），
   * 「系统谁录的就找谁」；body 仍可显式传 contactName/contactPhone 覆盖（兼容旧前端）。
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
    // 录入人 = 登录账号：查登录用户名作为联系人兜底（body 未传时用）。
    // Order.contactName/contactPhone 是非空列，createOrder 又要求 min(1)，故需落具体值。
    const recorder = await prisma.user.findUnique({
      where: { id: requester.userId },
      select: { displayName: true, email: true, phone: true },
    });
    const contactName = body.contactName ?? recorder?.displayName ?? recorder?.email ?? '系统录入';
    const contactPhone = body.contactPhone ?? recorder?.phone ?? '-';

    // 团期备注：写入每张子单的 notes（与既有 notes 合并）+ noteSpecial（结构化「特殊」栏）。
    const mergedNotes = [body.notes, body.groupNote].filter(Boolean).join(' · ') || undefined;
    const mergedNoteSpecial = [body.noteSpecial, body.groupNote].filter(Boolean).join(' · ') || undefined;

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
    // 产品类型分支（B5）：FLIGHT_ONEWAY/ROUNDTRIP 走班次扣座 + 同航班查重；
    // BUNDLE 的机票航段在 createOrder 内部派生（前台拆 FLIGHT 行），这里跳过基于班次的查重。
    // 向后兼容：缺省/旧调用（只传 flightScheduleId）= FLIGHT_ONEWAY。
    const productType = body.productType ?? 'FLIGHT_ONEWAY';
    const outbound = body.outboundScheduleId ?? body.flightScheduleId;
    // 同航班重复乘客查重：单程 [outbound]；往返 [outbound, return]；BUNDLE 不参与（无班次）。
    // filter(Boolean) 防止把 undefined 传进查重（assertNoDuplicate... 空数组直接 return）。
    const dedupScheduleIds =
      productType === 'BUNDLE'
        ? []
        : ([outbound, productType === 'FLIGHT_ROUNDTRIP' ? body.returnScheduleId : undefined].filter(
            (id): id is string => Boolean(id),
          ) as string[]);
    await this.assertNoDuplicatePassengersOnFlights(
      dedupScheduleIds,
      body.passengers.map((px) => px.documentNumber),
    );

    // BUNDLE：房控/销控要计入套餐占房，需把酒店房型 + 入住日期盖到订单行。
    // 入住日期靠 BUNDLE 行 metadata.goDate（resolveBundleHotelStamp 无 goDate 则不盖章）。
    // 批量录单 body 不带行程日期 → 用套餐自身的 defaultDepartDate 推 goDate，
    // returnDate 由 goDate + nights（bundleNights ?? hotelNights）推算（缺 defaultDepartDate 则不盖章，不阻断建单）。
    let bundleDates: { goDate?: string; returnDate?: string } = {};
    if (productType === 'BUNDLE' && body.bundleId) {
      const b = await prisma.bundle.findUnique({
        where: { id: body.bundleId },
        select: { defaultDepartDate: true, hotelNights: true },
      });
      const goDate = b?.defaultDepartDate ?? undefined;
      if (goDate) {
        const nights = Math.max(1, Math.trunc(body.bundleNights ?? b?.hotelNights ?? 1));
        const checkIn = new Date(goDate);
        const returnDate = Number.isNaN(checkIn.getTime())
          ? undefined
          : new Date(checkIn.getTime() + nights * 86_400_000).toISOString().slice(0, 10);
        bundleDates = { goDate, returnDate };
      }
    }

    // 按 productType 构造每张子单的 items（每位出行人都用同一份；与乘客无关，循环外算一次）。
    //   FLIGHT_ONEWAY   → 1 条 FLIGHT（outbound）
    //   FLIGHT_ROUNDTRIP→ 2 条 FLIGHT（去程 outbound + 返程 return），均同舱位
    //   BUNDLE          → 1 条 BUNDLE（复用 createOrder 的 BUNDLE 分支：服务端重算套餐价 +
    //                      盖酒店房型/入住日期到订单行 → 房控/销控自动计入套餐占房）
    const batchItems: OrderItemInput[] = buildBatchItems(body, productType, outbound, bundleDates);

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
            contactName,
            contactPhone,
            contactEmail: body.contactEmail,
            paymentMethod: body.paymentMethod,
            // 团期备注合并进每张子单 notes
            notes: mergedNotes,
            // 签证状态 + 结构化备注四栏（整批共用，写入每张子单）
            visaStatus: body.visaStatus,
            noteHotel: body.noteHotel,
            noteVisa: body.noteVisa,
            notePayment: body.notePayment,
            // 团期备注同时写入结构化「特殊」栏
            noteSpecial: mergedNoteSpecial,
            // 整批归属代理（ADMIN/STAFF 录单）；AGENT 自助仍归属本人。
            agentId: body.agentId,
            // 团队议价结算价（CNY/人）覆盖机票动态价；仅 ADMIN/STAFF（路由层已断言）。
            // 仅作用于 FLIGHT 行；BUNDLE 走 createOrder 的 server-priced 套餐定价，此值对其无效。
            flightSettlementPriceCny: body.settlementPriceCny,
            items: batchItems,
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
   * B4 改结算价（路由层限 ADMIN/STAFF）：建单后订正某条 FLIGHT 行的每张结算价。
   * 仅允许 kind=FLIGHT；事务内把 item.unitPrice 设为新价、amount=round2(unitPrice×quantity)，
   * 再用所有订单行重算 order.subtotal/total（taxesAndFees/discountTotal 不动）。
   *
   * 这是「基础价订正」，不走 adjustmentCny（那是售后费用，改期费/换人费才用）。
   * 尾款（serializeOrder 的 balanceDue = total + adjustmentCny − paidAmount）随 total 自然更新。
   * 不动 quantity / flightScheduleId / flightCabin / 库存（扣座与本订正无关）。
   * 返回 serializeOrder（含审计用的 before/after，由路由层 writeAudit 落库）。
   */
  async updateItemSettlementPrice(
    orderId: string,
    itemId: string,
    input: UpdateItemSettlementPriceBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: { unitPrice: string; amount: string; subtotal: string; total: string };
      after: { unitPrice: string; amount: string; subtotal: string; total: string };
      reason?: string;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可改结算价');
    }
    const unitPriceCny = input.unitPriceCny;

    const scratch = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          subtotal: true,
          total: true,
          items: {
            select: { id: true, kind: true, quantity: true, unitPrice: true, amount: true },
          },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      const target = order.items.find((it) => it.id === itemId);
      if (!target) {
        throw new NotFoundError('订单项不存在或不属于该订单');
      }
      if (target.kind !== OrderItemKind.FLIGHT) {
        throw new BadRequestError('只能对机票行（FLIGHT）改结算价');
      }

      const beforeUnitPrice = target.unitPrice.toString();
      const beforeAmount = target.amount.toString();
      const newAmount = round2(unitPriceCny * target.quantity);

      await tx.orderItem.update({
        where: { id: itemId },
        data: {
          unitPrice: new Prisma.Decimal(unitPriceCny),
          amount: new Prisma.Decimal(newAmount),
        },
      });

      // 用所有订单行（含本次新 amount）重算 subtotal/total。
      const newSubtotal = order.items.reduce(
        (sum, it) => sum + (it.id === itemId ? newAmount : Number(it.amount.toString())),
        0,
      );
      const newTotal = round2(newSubtotal); // 当前无 taxes/discount，total = subtotal

      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(round2(newSubtotal)),
          total: new Prisma.Decimal(newTotal),
        },
        select: { subtotal: true, total: true },
      });

      return {
        orderNumber: order.orderNumber,
        beforeUnitPrice,
        beforeAmount,
        beforeSubtotal: order.subtotal.toString(),
        beforeTotal: order.total.toString(),
        afterUnitPrice: unitPriceCny,
        afterAmount: newAmount,
        afterSubtotal: updated.subtotal.toString(),
        afterTotal: updated.total.toString(),
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      order: serializeOrder(finalOrder),
      audit: {
        orderNumber: scratch.orderNumber,
        orderItemId: itemId,
        before: {
          unitPrice: scratch.beforeUnitPrice,
          amount: scratch.beforeAmount,
          subtotal: scratch.beforeSubtotal,
          total: scratch.beforeTotal,
        },
        after: {
          unitPrice: String(scratch.afterUnitPrice),
          amount: String(scratch.afterAmount),
          subtotal: scratch.afterSubtotal,
          total: scratch.afterTotal,
        },
        reason: input.reason,
      },
    };
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
    // 转 PAID 时确保 paidAmount 至少等于 total（全额已付）。但若已记录多付（paidAmount > total，
    // 如线下到账金额高于结算价），不能回压到 total —— 取两者较大值，保留多付记录（尾款=total−paidAmount 为负）。
    if (toStatus === 'PAID') {
      extraData.paidAmount = order.paidAmount.greaterThan(order.total) ? order.paidAmount : order.total;
    }

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
      // 退款/取消时按比例冲销佣金（保证会计恒等：座位退了，已退的那部分佣金不能继续欠代理）。
      //
      // 冲销口径（按实退金额比例，分 ProductKind）：
      //   - 仅在「批准退款」(REFUNDED) 时按比例冲销：读本次推进的 Refund 快照
      //     gatewayPayload.quoteSnapshot.items[]，按 productKind 聚合
      //     refundRatio = Σ退款额 / Σ(退款额+退改费)（= Σ退款额 / Σ该类已付金额），
      //     clamp 到 [0,1]。平台留存的退改费对应的那部分佣金保留（不冲销）。
      //   - 其余「释放型」流转（CANCELLED / PAYMENT_TIMEOUT / FAILED）以及无法解析快照的
      //     旧退款 → 整单全额冲销（ratio=1，旧行为不变，绝不少冲）。
      //
      // 两类记录分别处理，以免破坏「已结算快照」：
      //   - ACCRUED（尚未进结算单）：
      //       · 全额（ratio>=1）→ 直接置 REVERSED（旧行为，期内净额自然归零）。
      //       · 部分（0<ratio<1）→ 原 ACCRUED 保留全额 + 新建一条「负数补偿记录」
      //         （amount/baseAmount 取负 × ratio、REVERSED、settlementId=null）；
      //         结算时 earned(+全额) 与补偿(−比例额) 相抵，净 = 原额 ×(1−ratio)，
      //         留存退改费对应的佣金可见可对账。
      //   - SETTLED（代理已在某张结算单里被结过账）：历史快照是冻结的，绝不回改；
      //     新建一条「负数补偿记录」（amount/baseAmount = −原额 × ratio、REVERSED、
      //     settlementId=null），让下一期结算把这笔负数净掉（跨期反冲），既追回多付
      //     又不污染上一张已支付结算单。负数 + REVERSED + settlementId=null 即是
      //     补偿记录的自识别标志（schema 无 note/source 列，故不另加列）。
      const refundRatioByKind = await this._computeRefundRatioByKind(tx, id, toStatus);

      const liveRecords = await tx.commissionRecord.findMany({
        where: {
          orderId: order.id,
          status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] },
        },
      });

      for (const rec of liveRecords) {
        const ratio = refundRatioByKind.get(rec.productKind) ?? 0;
        if (ratio <= 0) continue; // 该 ProductKind 未退（快照里没有）→ 不冲销

        if (ratio >= 1) {
          if (rec.status === CommissionStatus.ACCRUED) {
            // 全额 + 尚未结算 → 翻状态（旧行为，最省记录）
            await tx.commissionRecord.update({
              where: { id: rec.id },
              data: { status: CommissionStatus.REVERSED },
            });
            continue;
          }
          // 全额 + 已结算 → 负数补偿记录（M1-A 跨期反冲，整额）
          await tx.commissionRecord.create({
            data: {
              agentId: rec.agentId,
              orderId: rec.orderId,
              productKind: rec.productKind,
              baseAmount: rec.baseAmount.negated(),
              rate: rec.rate,
              amount: rec.amount.negated(),
              chainDepth: rec.chainDepth,
              status: CommissionStatus.REVERSED,
              settlementId: null,
            },
          });
          continue;
        }

        // 0 < ratio < 1 → 按比例：负数补偿记录（ACCRUED 与 SETTLED 同样处理；
        // ACCRUED 原记录保留全额，靠补偿记录净掉退款部分，留存退改费佣金不动）。
        const ratioDec = new Prisma.Decimal(ratio);
        const clawBase = round2Decimal(rec.baseAmount.mul(ratioDec));
        const clawAmount = round2Decimal(rec.amount.mul(ratioDec));
        if (clawAmount.lessThanOrEqualTo(0)) continue; // 防御：四舍五入后无金额可冲

        await tx.commissionRecord.create({
          data: {
            agentId: rec.agentId,
            orderId: rec.orderId,
            productKind: rec.productKind,
            baseAmount: clawBase.negated(),
            rate: rec.rate,
            amount: clawAmount.negated(),
            chainDepth: rec.chainDepth,
            status: CommissionStatus.REVERSED,
            settlementId: null,
          },
        });
      }
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
        agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
        user: { select: { id: true, displayName: true, email: true } },
      },
    });
  }

  /**
   * 计算「本次释放型流转应冲销多少佣金」的比例（按 ProductKind）。
   *
   * 规则：
   *   - 非 REFUNDED（CANCELLED / PAYMENT_TIMEOUT / FAILED 等）→ 整单全额冲销：
   *     所有 ProductKind 一律返回 ratio=1（取消语义不变，不按比例）。
   *   - REFUNDED（批准退款）→ 按「实退金额」比例分类冲销：
   *     读本次被推进的 Refund（status=REQUESTED，下一步会被翻 COMPLETED）的
   *     gatewayPayload.quoteSnapshot.items[]，按 item.kind 聚合
   *       refundedByKind = Σ refundAmount
   *       revenueByKind  = Σ (refundAmount + feeAmount)   // = 该类已付金额
   *       ratio[kind]    = clamp(refundedByKind / revenueByKind, 0, 1)
   *     未出现在快照里的 ProductKind → Map 无键 → 调用方按 0 处理（不冲销）。
   *   - 无可解析快照（旧退款 / 脏数据）→ 退回整单全额冲销（所有键缺失但返回哨兵：
   *     这里用 fullReversalAllKinds=true 表示"对任何 kind 都 ratio=1"，绝不少冲）。
   *
   * 返回一个 Map<ProductKind, number>；为简化调用方，缺省键即 0。
   * 当需要"对所有 kind 都全额冲销"时，预填全部 4 个 ProductKind 为 1。
   */
  private async _computeRefundRatioByKind(
    tx: Prisma.TransactionClient,
    orderId: string,
    toStatus: OrderStatus,
  ): Promise<Map<ProductKind, number>> {
    const ALL_PRODUCT_KINDS: ProductKind[] = [
      ProductKind.FLIGHT,
      ProductKind.HOTEL,
      ProductKind.TRANSFER,
      ProductKind.VISA,
    ];
    const fullReversal = (): Map<ProductKind, number> =>
      new Map(ALL_PRODUCT_KINDS.map((k) => [k, 1] as const));

    // 非批准退款的释放（取消 / 超时 / 失败）→ 整单全额冲销，语义不变。
    if (toStatus !== 'REFUNDED') return fullReversal();

    // 读本次推进的 Refund（与下方 Refund 状态同步同一批：status=REQUESTED）。
    const pendingRefunds = await tx.refund.findMany({
      where: { orderId, status: 'REQUESTED' },
      select: { gatewayPayload: true },
    });

    const refundedByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();
    let parsedAnyItem = false;

    for (const r of pendingRefunds) {
      // gatewayPayload 是未知 JSON —— 防御式解析，任何不符合预期的形状都跳过。
      const payload = r.gatewayPayload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const snapshot = (payload as Record<string, unknown>).quoteSnapshot;
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
      const items = (snapshot as Record<string, unknown>).items;
      if (!Array.isArray(items)) continue;

      for (const raw of items) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const it = raw as Record<string, unknown>;
        const kind = typeof it.kind === 'string' ? it.kind : null;
        const feeAmount = Number(it.feeAmount);
        const refundAmount = Number(it.refundAmount);
        if (!kind || !Number.isFinite(feeAmount) || !Number.isFinite(refundAmount)) continue;
        parsedAnyItem = true;
        refundedByKind.set(kind, (refundedByKind.get(kind) ?? 0) + refundAmount);
        revenueByKind.set(kind, (revenueByKind.get(kind) ?? 0) + refundAmount + feeAmount);
      }
    }

    // 无任何可解析快照项（旧退款 / 脏数据）→ 退回整单全额冲销，绝不少冲。
    if (!parsedAnyItem) return fullReversal();

    const ratioByKind = new Map<ProductKind, number>();
    for (const kindStr of revenueByKind.keys()) {
      // 只接受合法 ProductKind 字符串；其他（如 BUNDLE / INSURANCE）无佣金记录，忽略。
      if (!ALL_PRODUCT_KINDS.includes(kindStr as ProductKind)) continue;
      const revenue = revenueByKind.get(kindStr) ?? 0;
      const refunded = refundedByKind.get(kindStr) ?? 0;
      const ratio = revenue > 0 ? Math.min(1, Math.max(0, refunded / revenue)) : 0;
      ratioByKind.set(kindStr as ProductKind, ratio);
    }
    return ratioByKind;
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

  // ════════════════════════════════════════════════════════════════════
  // 售后改单：改期（reschedule）/ 换人（passenger swap）
  // 订单创建后原本不可改（只能取消重建）；这两个端点补「就地改」能力。
  // 全程 ADMIN/STAFF（路由层断言）、事务安全、审计。
  // 钱与库存口径：
  //   - 改期不重算机票基础价（doc：只加改期费）；尾款用 total + adjustmentCny − paidAmount。
  //   - 座位「先放旧、再原子拿新」：拿新失败则整事务回滚，旧座不会被放掉（无泄漏、无超售）。
  // ════════════════════════════════════════════════════════════════════

  /**
   * 改期：把订单里某条 FLIGHT 行就地改到新班次/新舱位，并（可选）加改期费。
   *
   * body：{ orderItemId, newScheduleId, newCabin?, feeCny?, feeLabel?, note? }
   *   - orderItemId 必须属于本订单且 kind=FLIGHT，且有原班次/原舱位。
   *   - newCabin 缺省则沿用原舱位。
   *
   * 单事务内：
   *   1. 释放旧座（旧班次+旧舱位 sold −= quantity）
   *   2. 原子拿新座（新班次+新舱位 CAS：sold + qty + 他人锁位 ≤ capacity）
   *      —— 新班次售罄则抛错，事务回滚 → 旧座保持原样（不泄漏）。
   *   3. 更新该行 flightScheduleId/flightCabin（amount/quantity 不变，机票基础价不重算）。
   *   4. feeCny>0 → order.adjustmentCny += feeCny，并 push 一条 adjustments 流水（RESCHEDULE_FEE）。
   *   5. 当前若处于 CHANGE_REQUESTED（状态机允许 → CHANGED）则推进到 CHANGED；其余状态保持不变。
   *
   * 返回更新后的订单（serializeOrder）。
   */
  async rescheduleOrderItem(
    orderId: string,
    input: {
      orderItemId: string;
      newScheduleId: string;
      newCabin?: import('@prisma/client').CabinClass;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      fromScheduleId: string;
      fromCabin: import('@prisma/client').CabinClass;
      fromDeparture: Date | null;
      toScheduleId: string;
      toCabin: import('@prisma/client').CabinClass;
      toDeparture: Date | null;
      feeCny: number;
      statusChanged: boolean;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可改期');
    }
    const feeCny = Math.max(0, Math.trunc(input.feeCny ?? 0));

    const scratch = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, adjustmentCny: true, adjustments: true },
      });
      if (!order) throw new NotFoundError('订单不存在');

      const item = await tx.orderItem.findUnique({
        where: { id: input.orderItemId },
        select: {
          id: true,
          orderId: true,
          kind: true,
          quantity: true,
          flightScheduleId: true,
          flightCabin: true,
          metadata: true,
        },
      });
      if (!item || item.orderId !== orderId) {
        throw new NotFoundError('订单项不存在或不属于该订单');
      }
      if (item.kind !== OrderItemKind.FLIGHT || !item.flightScheduleId || !item.flightCabin) {
        throw new BadRequestError('只能对机票行（FLIGHT）改期');
      }

      const oldScheduleId = item.flightScheduleId;
      const oldCabin = item.flightCabin;
      const newScheduleId = input.newScheduleId;
      const newCabin = input.newCabin ?? oldCabin;

      // 无变化（同班次同舱位）→ 不做座位搬移，避免无意义的放/拿
      const sameSeat = oldScheduleId === newScheduleId && oldCabin === newCabin;

      // 新班次必须存在且有该舱位（友好报错；最终防超售仍靠下面的原子 CAS）
      const newSeatClass = await tx.flightSeatClass.findFirst({
        where: { scheduleId: newScheduleId, cabin: newCabin },
        select: { id: true },
      });
      if (!newSeatClass) {
        throw new BadRequestError('目标班次不存在该舱位，无法改期');
      }

      // 套餐升舱拆座：该行下单时可能把 businessUpgradeCount 个座拆到了商务舱。
      // 改期同样按原拆分「先放旧、再拿新」，否则商务/经济会错位泄漏。
      const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
      const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;

      if (!sameSeat) {
        // ── 1. 释放旧座（按原拆分各退各舱）──
        const oldSplit = computeBundleSeatSplit(oldCabin, item.quantity, rawUpgrade);
        await releaseSeatWithinTx(tx, oldScheduleId, 'BUSINESS', oldSplit.business);
        await releaseSeatWithinTx(tx, oldScheduleId, oldCabin, oldSplit.sameCabin);

        // ── 2. 原子拿新座（同款 CAS；售罄 → 抛错，整事务回滚，旧座不会真被放掉）──
        // 拆座只对经济舱行成立；新舱位非经济舱则 split.business=0，全额拿新原舱。
        const newSplit = computeBundleSeatSplit(newCabin, item.quantity, rawUpgrade);
        await takeSeatWithinTx(tx, newScheduleId, 'BUSINESS', newSplit.business, null);
        await takeSeatWithinTx(tx, newScheduleId, newCabin, newSplit.sameCabin, null);
      }

      // ── 3. 更新订单行的班次/舱位（amount/quantity 不变：机票基础价不重算）──
      await tx.orderItem.update({
        where: { id: item.id },
        data: { flightScheduleId: newScheduleId, flightCabin: newCabin },
      });

      // ── 4. 加改期费（adjustmentCny + adjustments 流水）──
      if (feeCny > 0) {
        const log = appendAdjustment(order.adjustments, {
          type: 'RESCHEDULE_FEE',
          label: input.feeLabel || '改期费',
          amountCny: feeCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
        });
        await tx.order.update({
          where: { id: orderId },
          data: { adjustmentCny: order.adjustmentCny + feeCny, adjustments: log },
        });
      }

      // ── 5. 仅在状态机允许时推进到 CHANGED（不破坏状态机）──
      let statusChanged = false;
      if (
        order.status !== OrderStatus.CHANGED &&
        ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.CHANGED)
      ) {
        await this._updateStatusWithinTx(
          tx,
          orderId,
          OrderStatus.CHANGED,
          { userId: actor.userId, role: actor.role, actorType: 'USER' },
          input.note ? `改期（${input.note}）` : '改期',
          [], // 改期不产生履约任务
        );
        statusChanged = true;
      }

      // 把审计需要的「原/新」明细返回到 tx 外（出发时间另查）。
      // 直接 return 而非写模块级单例，避免并发改期互相覆盖。
      return { oldScheduleId, oldCabin, newScheduleId, newCabin, statusChanged };
    });

    // 审计明细：原/新出发时间（事务外查，避免污染事务）
    const [fromSched, toSched, finalOrder] = await Promise.all([
      prisma.flightSchedule.findUnique({
        where: { id: scratch.oldScheduleId },
        select: { departureTime: true },
      }),
      prisma.flightSchedule.findUnique({
        where: { id: scratch.newScheduleId },
        select: { departureTime: true },
      }),
      prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_FULL_INCLUDE }),
    ]);

    return {
      order: serializeOrder(finalOrder),
      audit: {
        orderNumber: finalOrder.orderNumber,
        orderItemId: input.orderItemId,
        fromScheduleId: scratch.oldScheduleId,
        fromCabin: scratch.oldCabin,
        fromDeparture: fromSched?.departureTime ?? null,
        toScheduleId: scratch.newScheduleId,
        toCabin: scratch.newCabin,
        toDeparture: toSched?.departureTime ?? null,
        feeCny,
        statusChanged: scratch.statusChanged,
      },
    };
  }

  /**
   * 换人：把订单里某位出行人就地换成新人（改身份字段），并按需重置开票/签证状态、加换人费。
   *
   * body：{ lastName?, firstName?, fullName?, documentNumber?, dateOfBirth?, gender?,
   *         nationality?, resetInvoice?, resetVisa?, feeCny?, feeLabel?, note? }
   *
   * 单事务内：
   *   1. 更新该乘客的身份字段（仅传入的字段；fullName/姓名拆分与下单口径一致）。
   *   2. resetInvoice → order.invoiceStatus = NONE（新出行人需重新开票）。
   *   3. resetVisa → 该订单所有 VISA 履约任务回到 PENDING（新出行人需重新送签）。
   *   4. feeCny>0 → order.adjustmentCny += feeCny + adjustments 流水（SWAP_FEE）。
   *
   * 返回更新后的订单（serializeOrder）+ 审计用的原/新身份。
   */
  async swapPassenger(
    orderId: string,
    passengerId: string,
    input: {
      lastName?: string;
      firstName?: string;
      fullName?: string;
      documentNumber?: string;
      dateOfBirth?: string;
      gender?: import('@prisma/client').Gender;
      nationality?: string;
      resetInvoice?: boolean;
      resetVisa?: boolean;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      passengerId: string;
      before: { fullName: string; documentNumber: string };
      after: { fullName: string; documentNumber: string };
      resetInvoice: boolean;
      resetVisa: boolean;
      visaTasksReset: number;
      feeCny: number;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可换人');
    }
    const feeCny = Math.max(0, Math.trunc(input.feeCny ?? 0));

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, adjustmentCny: true, adjustments: true },
      });
      if (!order) throw new NotFoundError('订单不存在');

      const passenger = await tx.passenger.findUnique({
        where: { id: passengerId },
        select: { id: true, orderId: true, fullName: true, documentNumber: true },
      });
      if (!passenger || passenger.orderId !== orderId) {
        throw new NotFoundError('出行人不存在或不属于该订单');
      }
      const beforeIdentity = {
        fullName: passenger.fullName,
        documentNumber: passenger.documentNumber,
      };

      // ── 1. 更新身份字段（仅传入的字段；fullName 时按下单口径自动拆姓/名兜底）──
      const data: Prisma.PassengerUpdateInput = {};
      if (input.fullName !== undefined) {
        data.fullName = input.fullName;
        // 客户端没显式给 lastName/firstName 时，用 fullName 自动拆（与 passengerToData 同口径）
        if (input.lastName === undefined || input.firstName === undefined) {
          const [autoLast, ...rest] = input.fullName.trim().split(/\s+/);
          if (input.lastName === undefined) data.lastName = autoLast ?? null;
          if (input.firstName === undefined) data.firstName = rest.join(' ') || null;
        }
      }
      if (input.lastName !== undefined) data.lastName = input.lastName;
      if (input.firstName !== undefined) data.firstName = input.firstName;
      if (input.documentNumber !== undefined) data.documentNumber = input.documentNumber;
      if (input.dateOfBirth !== undefined) data.dateOfBirth = new Date(input.dateOfBirth);
      if (input.gender !== undefined) data.gender = input.gender;
      if (input.nationality !== undefined) data.nationality = input.nationality;
      await tx.passenger.update({ where: { id: passengerId }, data });

      // ── 2. resetInvoice → 开票状态回 NONE（新出行人重开票）──
      if (input.resetInvoice) {
        await tx.order.update({
          where: { id: orderId },
          data: { invoiceStatus: InvoiceStatus.NONE },
        });
      }

      // ── 3. resetVisa → 该订单所有 VISA 履约任务回 PENDING（新出行人重新送签）──
      let visaTasksReset = 0;
      if (input.resetVisa) {
        const reset = await tx.fulfillmentTask.updateMany({
          where: {
            type: FulfillmentType.VISA_APPLICATION,
            orderItem: { orderId },
            status: { not: FulfillmentStatus.PENDING },
          },
          data: {
            status: FulfillmentStatus.PENDING,
            startedAt: null,
            completedAt: null,
            failureReason: null,
          },
        });
        visaTasksReset = reset.count;
      }

      // ── 4. 加换人费（adjustmentCny + adjustments 流水）──
      if (feeCny > 0) {
        const log = appendAdjustment(order.adjustments, {
          type: 'SWAP_FEE',
          label: input.feeLabel || '换人费',
          amountCny: feeCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
        });
        await tx.order.update({
          where: { id: orderId },
          data: { adjustmentCny: order.adjustmentCny + feeCny, adjustments: log },
        });
      }

      const afterPassenger = await tx.passenger.findUniqueOrThrow({
        where: { id: passengerId },
        select: { fullName: true, documentNumber: true },
      });

      return { beforeIdentity, afterIdentity: afterPassenger, visaTasksReset };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      order: serializeOrder(finalOrder),
      audit: {
        orderNumber: finalOrder.orderNumber,
        passengerId,
        before: result.beforeIdentity,
        after: {
          fullName: result.afterIdentity.fullName,
          documentNumber: result.afterIdentity.documentNumber,
        },
        resetInvoice: Boolean(input.resetInvoice),
        resetVisa: Boolean(input.resetVisa),
        visaTasksReset: result.visaTasksReset,
        feeCny,
      },
    };
  }
}

// 完整 include 给 serializeOrder 用
const ORDER_FULL_INCLUDE = {
  items: true,
  passengers: true,
  payments: true,
  refunds: true,
  statusEvents: { orderBy: { createdAt: 'asc' } },
  agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
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
> & {
  /** 精确按班次过滤（整班·全岗导出用）；比 travelFrom/travelTo 更准，不受 ±1 天放宽影响。 */
  scheduleId?: string;
};

/**
 * 把列表/导出共用的筛选参数转成 Prisma where。
 * listOrders 与 orders.export-templates.ts 三模板导出共用，避免两处过滤逻辑漂移。
 * 注意：不含 RBAC（userId/可见代理集合）、claimedById/unclaimedOnly、分页 —— 由调用方叠加。
 */
export function buildOrderFilterWhere(query: OrderListFilters): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};
  // 多个 items 维度的筛选必须用 AND 叠加（每个 { items: { some } } 各自独立成立），
  // 否则直接赋值 where.items 会互相覆盖 —— 历史上 kind 与 travelFrom/travelTo 同时传时
  // 后者会清掉前者，造成漏单（结构性根因）。统一往 andClauses 里推。
  const andClauses: Prisma.OrderWhereInput[] = [];

  if (query.status) where.status = query.status;
  if (query.agentId) where.agentId = query.agentId;
  if (query.kind) andClauses.push({ items: { some: { kind: query.kind } } });
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(`${query.from}T00:00:00Z`) } : {}),
      ...(query.to ? { lte: new Date(`${query.to}T23:59:59Z`) } : {}),
    };
  }
  // 按出行日期筛选 — 跨 OrderItem 多种字段
  // FLIGHT: 取 schedule.departureTime；HOTEL: hotelCheckIn；其他暂时用 createdAt 兜底。
  // 出行日期存的是 UTC 时刻，而筛选用的是本地（出发地 +8）日期；UTC 与本地跨午夜会落到相邻日，
  // 直接按 [from 00:00Z, to 23:59Z] 卡会漏掉边界单。故把窗口各向外放宽一天做安全余量
  //（宁可多召回、不漏单 —— 与财务按出发地时区分桶同源的容忍口径）。
  if (query.travelFrom || query.travelTo) {
    const start = query.travelFrom
      ? new Date(new Date(`${query.travelFrom}T00:00:00Z`).getTime() - DAY_MS)
      : undefined;
    const end = query.travelTo
      ? new Date(new Date(`${query.travelTo}T23:59:59Z`).getTime() + DAY_MS)
      : undefined;
    andClauses.push({
      items: {
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
      },
    });
  }
  // 精确按班次：订单需含该班次的 FLIGHT 行。整班·全岗导出专用——比 travelFrom/travelTo 精确，
  // 不受出行日期窗口 ±1 天放宽影响，保证只导该班次当天的订单。
  if (query.scheduleId) {
    andClauses.push({ items: { some: { flightScheduleId: query.scheduleId } } });
  }
  if (query.invoiceStatus) where.invoiceStatus = query.invoiceStatus;
  // 航班号筛选 — 订单需含该航班号的 FLIGHT 行（同样走 AND 叠加，可与 kind/出行日期组合）
  if (query.flightNumber) {
    andClauses.push({
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
    });
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

  // 把所有 items 维度的子句一次性 AND 起来（kind / 出行日期 / 航班号可任意组合，互不覆盖）
  if (andClauses.length > 0) where.AND = andClauses;

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

/**
 * 套餐关联了酒店房型时，从订单行 metadata（goDate/returnDate）推导入住/退房日期。
 * - returnDate 合法且晚于 goDate → 用 returnDate 做退房日
 * - 否则按 goDate + nights 推退房日（nights 由 resolveBundleNights 解析的单一权威晚数，调用方传入）
 * - 套餐没关联房型、或 goDate 缺失/非法 → 返回 null（不盖章，下单照常）
 *
 * 导出仅供单测使用。
 */
/**
 * 把住宿区间 [checkIn, checkOut)（半开）展开为逐晚 YYYY-MM-DD（UTC date-only）。
 * 供套餐下单时的酒店房量库存校验用（口径与 getHotelNightlyRemaining / 房控完全一致）。
 * 防御：checkOut <= checkIn 或跨度异常大 → 返回空数组（调用方按"无从校验"跳过，不阻断下单）。
 */
const MAX_STAY_NIGHTS = 60;
export function buildStayNightDates(checkIn: Date, checkOut: Date): string[] {
  const startMs = checkIn.getTime();
  const endMs = checkOut.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const nights = Math.round((endMs - startMs) / DAY_MS);
  if (nights < 1 || nights > MAX_STAY_NIGHTS) return [];
  return Array.from({ length: nights }, (_, i) =>
    new Date(startMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

export function resolveBundleHotelStamp(
  bundle: { hotelRoomTypeId: string | null },
  metadata: Record<string, unknown> | undefined,
  nights: number,
): { hotelRoomTypeId: string; hotelCheckIn: Date; hotelCheckOut: Date } | null {
  if (!bundle.hotelRoomTypeId) return null;
  const meta = bundleItemMetadataSchema.parse(metadata ?? {});
  if (!meta.goDate) return null;
  const checkIn = new Date(meta.goDate);
  if (Number.isNaN(checkIn.getTime())) return null;
  const safeNights = Math.max(1, Math.trunc(nights));
  const returnDate = meta.returnDate ? new Date(meta.returnDate) : null;
  const checkOut =
    returnDate && !Number.isNaN(returnDate.getTime()) && returnDate.getTime() > checkIn.getTime()
      ? returnDate
      : new Date(checkIn.getTime() + safeNights * DAY_MS);
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
  // 占座模型（业务需求）：成人 / 占座儿童 / 不占座婴儿
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
  selfProvidedVisa: boolean; // 是否自备签证（自行办妥签证）
  selfVisaDeductCny: number; // 该套餐配置的自备签证减免/单
  singleSupplementTotal: number; // = singleCount × rate × nights
  businessUpgradeTotal: number; // = businessCount × rate × legs
  childSeatDiscountTotal: number; // = childCount × childSeatDiscountCnyPerPerson（机票折扣，负向计入套餐行）
  infantPriceTotal: number; // = infantCount × infantPriceCny（婴儿机票价，正向计入套餐行）
  selfVisaDeductTotal: number; // = selfProvidedVisa ? selfVisaDeductCny : 0（自备签证减免，负向计入套餐行）
  total: number; // 升级加价 + 婴儿价 − 儿童折扣 − 自备签证减免 的净额（计入套餐行总额）
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
 * 业务口径："每个酒店房型可以 fit 几大人几小孩；选的人数一间房坐不下时，自动加房。"
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

// ── 套餐酒店计费房间数（server-authoritative；含单人拼房 0.5 间口径）──────────
/**
 * 计算套餐酒店部分应计费的房间数（钱路径，权威计算，不轻信客户端）。
 *
 * 业务口径：一个人报套餐（1 成人 / 0 儿童，婴儿不占房）且**不**独住时，愿意拼房共用一间，
 * 只按 0.5 间收费（床位口径）；独住（singleCount ≥ 1）则照旧收整间 + 单人入住房差。
 * 2 人及以上、或含占座儿童 → 沿用 computeRoomsNeeded 的容量口径（不变）。
 *
 *   isSoloSharing = 绑了套餐房型 且 adultCount===1 且 childCount===0 且 singleCount(缺省0)===0
 *   roomsCharged  = isSoloSharing ? 0.5 : physicalRooms(容量推算)
 *
 * 仅对绑定套餐房型（hotelRoomTypeId 存在）生效；未绑房型的老套餐不走 0.5 口径。
 *
 * server-authoritative：客户端传的 roomsBilled 只能「上调」不能「下压」——最终取
 * max(clientRooms, roomsCharged)。这样单人拼房单不会被 2 人单伪造成 0.5 间少付钱，
 * 同时保留「录单方主动多开房」等向上调整的向后兼容能力。
 *
 * 导出供单测与 createOrder BUNDLE 分支共用（同一份权威口径，避免漂移）。
 */
export function computeBundleRoomsCharged(params: {
  occupancy: Pick<BundleOccupancy, 'adultCount' | 'childCount'>;
  capacity: { maxAdults?: number | null; maxChildren?: number | null } | null;
  hotelRoomTypeId: string | null;
  singleCount: number | undefined;
  clientRoomsBilled: number | undefined;
}): number {
  const { occupancy, capacity, hotelRoomTypeId, singleCount, clientRoomsBilled } = params;
  const physicalRooms = computeRoomsNeeded(occupancy, capacity);
  const isSoloSharing =
    hotelRoomTypeId != null &&
    occupancy.adultCount === 1 &&
    occupancy.childCount === 0 &&
    (singleCount ?? 0) === 0;
  const roomsCharged = isSoloSharing ? 0.5 : physicalRooms;
  // 权威下限：客户端只能上调、不能下压（防止把多人单伪造成 0.5 间）。
  if (clientRoomsBilled != null) {
    return Math.max(clientRoomsBilled, roomsCharged);
  }
  return roomsCharged;
}

/**
 * 套餐升级加价权威重算（不信任客户端金额）。公式：
 *   nights = stamp 推导的入住晚数（无房型 → hotelNights ?? 1）
 *   legs   = bundle.legs（来回默认 2）
 *   单人入住房差 = singleCount × singleSupplementCnyPerNight × nights
 *   升舱商务加价 = businessCount × businessUpgradeCnyPerLeg × legs
 *   自备签证减免 = selfProvidedVisa ? selfVisaDeductCny : 0（自行办妥签证，从套餐行扣减）
 * singleCount / businessCount 缺省 0、selfProvidedVisa 缺省 false → total=0 → 套餐价与旧版完全一致（向后兼容）。
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
    selfVisaDeductCny: number;
    legs: number;
  },
  hotelStamp: { hotelCheckIn: Date; hotelCheckOut: Date } | null,
  singleCount: number | undefined,
  businessCount: number | undefined,
  occupancy: BundleOccupancy,
  /** 调用方按 resolveBundleNights 解析的单一权威晚数（无盖章时的回退口径）。 */
  resolvedNights: number,
  /** 自备签证（出行人自行办妥签证）→ 从套餐行扣减 selfVisaDeductCny。缺省 false。 */
  selfProvidedVisa?: boolean,
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
    : Math.max(1, resolvedNights);
  const legs = Math.max(1, bundle.legs);
  const singleRate = Math.max(0, bundle.singleSupplementCnyPerNight);
  const businessRate = Math.max(0, bundle.businessUpgradeCnyPerLeg);
  const childDiscountRate = Math.max(0, bundle.childSeatDiscountCnyPerPerson);
  const infantRate = Math.max(0, bundle.infantPriceCny);
  const selfVisaRate = Math.max(0, bundle.selfVisaDeductCny);
  const selfVisa = selfProvidedVisa === true;

  const singleSupplementTotal = single * singleRate * nights;
  const businessUpgradeTotal = business * businessRate * legs;
  // 占座儿童机票按成人价减折扣 → 套餐行净减 childCount × 折扣
  const childSeatDiscountTotal = occupancy.childCount * childDiscountRate;
  // 不占座婴儿机票收婴儿价（不走经济舱全价）→ 套餐行净加 infantCount × 婴儿价
  const infantPriceTotal = occupancy.infantCount * infantRate;
  // 自备签证：出行人自行办妥签证 → 套餐行净减该套餐配置的自备签证减免
  const selfVisaDeductTotal = selfVisa ? selfVisaRate : 0;
  // 升级加价 + 婴儿价 − 儿童折扣 − 自备签证减免（向上夹到 0，避免套餐行出现负总额）
  const total = Math.max(
    0,
    singleSupplementTotal +
      businessUpgradeTotal +
      infantPriceTotal -
      childSeatDiscountTotal -
      selfVisaDeductTotal,
  );

  return {
    total,
    // 任一占座升级或儿童/婴儿差价 / 自备签证减免存在 → 视为有 add-on（落 metadata 供运营/财务查看）
    hasAddOn:
      single > 0 ||
      business > 0 ||
      childSeatDiscountTotal > 0 ||
      infantPriceTotal > 0 ||
      selfVisaDeductTotal > 0,
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
      selfProvidedVisa: selfVisa,
      selfVisaDeductCny: selfVisaRate,
      singleSupplementTotal,
      businessUpgradeTotal,
      childSeatDiscountTotal,
      infantPriceTotal,
      selfVisaDeductTotal,
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

// ── 售后改单：座位搬移 + 费用流水（事务内复用 createOrder/状态机的同款口径）──

/**
 * 事务内原子「拿座」（CAS，最终防超售）—— 与 createOrder 的 decrementSeat 同款保证。
 *   UPDATE ... SET sold = sold + qty WHERE sold + qty + 他人ACTIVE锁位 ≤ capacity
 * affected ≠ 1（售罄/并发抢占/无此舱位）→ 抛 ConflictError，调用方的事务随之回滚。
 *
 * @param excludeUserId 排除其本人锁位不挡自己（下单场景用）；改期由运营操作 → 传 null（所有他人锁位都占余票）。
 */
async function takeSeatWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
  excludeUserId: string | null,
): Promise<void> {
  if (qty <= 0) return;
  const lockedAgg = await tx.seatLock.aggregate({
    _sum: { qty: true },
    where: {
      seatClass: { scheduleId, cabin },
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
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
    const sc = await tx.flightSeatClass.findFirst({
      where: { scheduleId, cabin },
      select: { capacity: true, sold: true },
    });
    const available = sc ? Math.max(0, sc.capacity - sc.sold - lockedByOthers) : 0;
    throw new ConflictError(
      `${cabin} 余票不足：需要 ${qty} 张，仅剩 ${available} 张（改期目标班次售罄/并发抢占）`,
    );
  }
}

/**
 * 事务内「放座」—— 与状态机 releaseSeat 同款（sold -= qty，无下限保护交由调用约束保证）。
 */
async function releaseSeatWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  await tx.flightSeatClass.updateMany({
    where: { scheduleId, cabin },
    data: { sold: { decrement: qty } },
  });
}

/** 一条售后费用流水（写入 Order.adjustments）。 */
export interface OrderAdjustmentEntry {
  type: 'RESCHEDULE_FEE' | 'SWAP_FEE' | string;
  label: string;
  amountCny: number;
  at: string; // ISO 时间
  by: string | null; // 操作人 userId
  note?: string;
}

/**
 * 不可变地把一条流水追加到 Order.adjustments（JSON 数组）。
 * 旧值非数组（脏数据/旧空默认）时按空数组处理，绝不抛错。
 */
function appendAdjustment(
  existing: Prisma.JsonValue | null | undefined,
  entry: OrderAdjustmentEntry,
): Prisma.InputJsonValue {
  const arr = Array.isArray(existing) ? (existing as Prisma.JsonArray) : [];
  return [...arr, entry as unknown as Prisma.InputJsonValue];
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
    chineseName: p.chineseName ?? null,
    passportIssueDate: p.passportIssueDate ? new Date(p.passportIssueDate) : null,
    passportIssueCountry: p.passportIssueCountry ?? null,
    passportIssuePlace: p.passportIssuePlace ?? null,
    passportExpiry: p.passportExpiry ? new Date(p.passportExpiry) : null,
    visaNumber: p.visaNumber ?? null,
    visaType: p.visaType ?? null,
    visaIssueDate: p.visaIssueDate ? new Date(p.visaIssueDate) : null,
    visaEffectiveDate: p.visaEffectiveDate ? new Date(p.visaEffectiveDate) : null,
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
  // 售后费用（改期费/换人费等）累计额（CNY，整数）。Prisma 直接返回 number。
  adjustmentCny: number;
  items: Array<{ unitPrice: Prisma.Decimal; amount: Prisma.Decimal } & Record<string, unknown>>;
  // 可选嵌套代理（含余额 Decimal + 结算模式）；不同 include 下可能不带或带 null
  agent?: ({ prepaymentBalance?: Prisma.Decimal | null } & Record<string, unknown>) | null;
}

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 用 Prisma.Decimal 做钱算术（避免 float 漂移），结果四舍五入到 2 位小数。
// ROUND_HALF_UP 与文件其余处（round2 的 Math.round）一致。
function round2Decimal(d: Prisma.Decimal): Prisma.Decimal {
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function serializeOrder<T extends OrderLike>(order: T) {
  // 售后费用叠加后的口径：
  //   effectivePayable = total + adjustmentCny（客户实际应付）
  //   balanceDue       = effectivePayable − paidAmount（尾款；负数表示多付）
  // 不改 total/subtotal（机票基础价不重算），只在结清口径上暴露派生值，前端统一用此尾款。
  const adjustmentCny = order.adjustmentCny ?? 0;
  const totalNum = Number(order.total.toString());
  const paidNum = Number(order.paidAmount.toString());
  const effectivePayable = round2(totalNum + adjustmentCny);
  const balanceDue = round2(effectivePayable - paidNum);
  return {
    ...order,
    subtotal: order.subtotal.toString(),
    taxesAndFees: order.taxesAndFees.toString(),
    discountTotal: order.discountTotal.toString(),
    total: order.total.toString(),
    paidAmount: order.paidAmount.toString(),
    prepaymentOffset: order.prepaymentOffset.toString(),
    // 售后费用派生口径（前端用 effectivePayable / balanceDue 取代「total − paidAmount」）
    adjustmentCny,
    effectivePayable: effectivePayable.toString(),
    balanceDue: balanceDue.toString(),
    // 暴露代理结算模式 + 余额（前端据 settlementMode=MONTHLY 把订单显示成「月结」而非「欠款」）
    agent:
      order.agent == null
        ? order.agent
        : {
            ...order.agent,
            prepaymentBalance:
              order.agent.prepaymentBalance == null
                ? null
                : order.agent.prepaymentBalance.toString(),
          },
    items: order.items.map((i) => ({
      ...i,
      unitPrice: i.unitPrice.toString(),
      amount: i.amount.toString(),
      // 权威酒店中文名：HOTEL 行或 BUNDLE 行（盖章 hotelRoomTypeId）联查 hotelRoomType.hotel.name 均可命中。
      // 不是所有调用方的 items include 都联查了 hotelRoomType（如 listOrders 用 items: true）——
      // 这里用可选链读取，未联查时安全落 null，不强行断言非空。
      hotelName:
        (i as { hotelRoomType?: { hotel?: { name?: string | null } | null } | null }).hotelRoomType
          ?.hotel?.name ?? null,
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

// 非套餐订单项：一行 → 一个对应岗任务。
const KIND_TO_FULFILLMENT_TYPE: Partial<Record<OrderItemKind, FulfillmentType>> = {
  FLIGHT: FulfillmentType.FLIGHT_TICKETING,
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
};

// 套餐组件 kind（Bundle.items[].kind，见 products.schemas bundleItemSchema）→ 对应岗任务。
// 注意：FLIGHT 组件不在此列 —— 套餐下单已单独落 FLIGHT 订单项（FLIGHT_TICKETING 由那行生成），
//       从套餐再生成会与之重复，故套餐只 fan-out 地面（酒店/签证/接送）组件。
const BUNDLE_COMPONENT_KIND_TO_TYPE: Record<string, FulfillmentType | undefined> = {
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
};

/**
 * 解析套餐订单项需要生成哪些「地面岗」任务类型。
 * 通过订单项的 bundleId 反查 Bundle.items JSON，取其组件 kind 集合映射到 FulfillmentType。
 * 解析不到（bundleId 缺失 / 套餐被删 / items 畸形）时优雅降级：
 *   至少回退一个 HOTEL_BOOKING（套餐基本必含酒店），保证酒店岗能看到该套餐单。
 */
async function resolveBundleFulfillmentTypes(
  tx: Prisma.TransactionClient,
  bundleId: string | null,
): Promise<FulfillmentType[]> {
  const FALLBACK = [FulfillmentType.HOTEL_BOOKING];
  if (!bundleId) return FALLBACK;
  const bundle = await tx.bundle.findUnique({
    where: { id: bundleId },
    select: { items: true },
  });
  if (!bundle) return FALLBACK;
  const components = Array.isArray(bundle.items)
    ? (bundle.items as Array<{ kind?: unknown }>)
    : [];
  // 去重保序：同一类组件（如两段接送）只开一个对应岗任务。
  const types = new Set<FulfillmentType>();
  for (const c of components) {
    if (typeof c?.kind !== 'string') continue;
    const type = BUNDLE_COMPONENT_KIND_TO_TYPE[c.kind];
    if (type) types.add(type);
  }
  return types.size > 0 ? [...types] : FALLBACK;
}

/**
 * PAID 时为订单的每个订单项生成 fulfillment 任务。
 *
 * - 非套餐项（FLIGHT/HOTEL/VISA/TRANSFER）：一行 → 一个对应岗任务。
 * - 套餐项（BUNDLE）：反查套餐组件，fan-out 成 per-component 地面岗任务
 *   （HOTEL→HOTEL_BOOKING / VISA→VISA_APPLICATION / TRANSFER→TRANSFER_DISPATCH），
 *   不再生成单一 BUNDLE_COMPOSITE 占位任务 —— 否则签证岗/酒店岗/地面岗看不到套餐单。
 *   （FLIGHT 组件由套餐另落的 FLIGHT 订单项生成，避免重复。）
 *
 * 幂等：按「该订单项已存在的任务类型集合」判定，只补缺失的类型。
 *   首次运行会一次性建齐所有需要的类型；重跑不会重复建（即便套餐含多类型，
 *   旧的 `fulfillmentTasks.length > 0` 单值守卫会漏建剩余类型，故改为按类型去重）。
 */
async function createFulfillmentTasks(tx: Prisma.TransactionClient, orderId: string): Promise<string[]> {
  // 订单级签证状态：visaStatus='NEEDED' 的订单即便没有 VISA 行/套餐签证组件，
  // 也要进签证台（让签证岗看见）。NOT_NEEDED/HAS_VISA/E_VISA 不开任务。
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true },
  });
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { type: true } },
    },
  });
  const newTaskIds: string[] = [];
  // 全单是否已（含本次新建）存在签证任务 —— 用于订单级「需要签证」去重，避免重复建。
  let hasVisaTask = items.some((item) =>
    item.fulfillmentTasks.some((t) => t.type === FulfillmentType.VISA_APPLICATION),
  );
  for (const item of items) {
    // 该订单项需要的任务类型集合
    const desiredTypes =
      item.kind === OrderItemKind.BUNDLE
        ? await resolveBundleFulfillmentTypes(tx, item.bundleId)
        : (() => {
            const t = KIND_TO_FULFILLMENT_TYPE[item.kind];
            return t ? [t] : [];
          })();
    if (desiredTypes.length === 0) continue;

    // 幂等：跳过已存在的类型，只补缺失的（支持套餐多类型的部分补建）
    const existingTypes = new Set(item.fulfillmentTasks.map((t) => t.type));
    for (const type of desiredTypes) {
      if (existingTypes.has(type)) continue;
      const task = await tx.fulfillmentTask.create({
        data: {
          orderItemId: item.id,
          type,
          status: FulfillmentStatus.PENDING,
        },
      });
      newTaskIds.push(task.id);
      if (type === FulfillmentType.VISA_APPLICATION) hasVisaTask = true;
    }
  }

  // 订单级「需要签证」：visaStatus='NEEDED' 且本单全程没有任何签证任务（VISA 行 / 套餐签证组件
  // 都没产生）→ 补一条 VISA_APPLICATION，挂到首个订单项（FulfillmentTask 仅有 orderItemId 外键，
  // 无 Order 直挂）。已有签证任务则跳过，保证重跑 PAID 不重复建（幂等）。
  if (order?.visaStatus === 'NEEDED' && !hasVisaTask && items.length > 0) {
    const task = await tx.fulfillmentTask.create({
      data: {
        orderItemId: items[0].id,
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.PENDING,
      },
    });
    newTaskIds.push(task.id);
  }
  return newTaskIds;
}

/**
 * 下单（CREATE）时即建签证任务 —— 让「录进去但还没付款」的需签证单也能进签证台。
 *
 * 背景：完整履约任务（机票/酒店/接送/签证）在 PAID 时才由 createFulfillmentTasks 生成，
 * 于是未付款订单一个任务都没有，签证台（读 VISA_APPLICATION 任务）看不到要送签的单。
 * 这里只在下单时**提前补签证那一项**，其余岗位任务仍留到 PAID。
 *
 * 「需要签证」判定（任一成立，与 PAID 路径一致）：
 *   - 订单级 visaStatus = NEEDED
 *   - 含 VISA 订单项
 *   - 含 BUNDLE 订单项，且该套餐组件含 VISA
 *
 * 任务锚点与 PAID 路径保持一致（VISA 项 → 该项；含签证套餐 → 该套餐项；
 * 否则订单级需签 → 首个订单项），并按「已存在 VISA 任务即跳过」幂等：
 * PAID 时 createFulfillmentTasks 按订单项的已有任务类型去重，能识别这条早建任务而不重复建。
 */
async function createVisaTaskAtCreation(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<string[]> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true },
  });
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { type: true } },
    },
  });
  if (items.length === 0) return [];

  // 幂等：已存在任意签证任务 → 不重复建
  const alreadyHasVisaTask = items.some((item) =>
    item.fulfillmentTasks.some((t) => t.type === FulfillmentType.VISA_APPLICATION),
  );
  if (alreadyHasVisaTask) return [];

  // 锚点选择（与 PAID 路径一致）：优先 VISA 项 → 含签证套餐项 → 订单级需签时首个订单项
  let anchorItemId: string | null = null;
  const visaItem = items.find((item) => item.kind === OrderItemKind.VISA);
  if (visaItem) {
    anchorItemId = visaItem.id;
  } else {
    for (const item of items) {
      if (item.kind !== OrderItemKind.BUNDLE) continue;
      const types = await resolveBundleFulfillmentTypes(tx, item.bundleId);
      if (types.includes(FulfillmentType.VISA_APPLICATION)) {
        anchorItemId = item.id;
        break;
      }
    }
  }
  // 订单级「需要签证」兜底：挂到首个订单项。判定与 PAID 路径（createFulfillmentTasks）
  // 完全一致——仅 visaStatus='NEEDED'（E_VISA/电子签按既有口径不开签证台任务），
  // 保证两条路径触发条件相同、重跑 PAID 幂等、不产生不对称的兜底缺口。
  if (!anchorItemId && order?.visaStatus === VisaRequirement.NEEDED) {
    anchorItemId = items[0].id;
  }
  if (!anchorItemId) return [];

  const task = await tx.fulfillmentTask.create({
    data: {
      orderItemId: anchorItemId,
      type: FulfillmentType.VISA_APPLICATION,
      status: FulfillmentStatus.PENDING,
    },
  });
  return [task.id];
}

export { createFulfillmentTasks, resolveBundleFulfillmentTypes, createVisaTaskAtCreation };

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
