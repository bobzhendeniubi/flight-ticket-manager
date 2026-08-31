/**
 * 支付服务 —— 对订单创建 Payment 记录 + 对接网关 + 回调后自动转 Order 为 PAID。
 *
 * 关键流程：
 *   1. 客户点支付 → POST /payments → 创建 Payment(PENDING) + 调 adapter 生成付款链接
 *   2. 客户扫码/跳转 → 第三方完成扣款
 *   3. 第三方回调 → /payments/webhook/:provider → 验签 → 标 SUCCEEDED
 *   4. SUCCEEDED 时自动：Order → PAID（走 orders.service 同一套状态机，生成佣金/履约任务）
 *
 * 失败 / 超时：
 *   - 回调校验失败：不改 Payment 状态，返回 400
 *   - 金额不匹配：标记 FAILED，审计告警
 *   - 订单已 CANCELLED：标记 REFUNDED（资金原路退回）
 */
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  ReceiptSource,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import { getPaymentAdapter } from './payment-adapters.js';
import { OrderService } from '../orders/orders.service.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import {
  assertOrderAcceptsFunds,
  assertOrderAllowsFundsReversal,
  sumCompletedRefundsWithinTx,
} from '../../lib/funds-guard.js';
import { writeAudit } from '../../lib/audit.js';
import { outstandingCommissionNetWithinTx, round2 } from '../../lib/commission-net.js';
// 超收拆分要在同一事务里建挂账进账。receipts.service 反向 import 本模块的 PaymentsService，
// 构成模块环——但两侧都只在「方法体 / 类字段初始化」里用到对方，且 createOpenReceiptWithinTx 是
// 函数声明（ESM 实例化阶段即提升可用），故静态 import 安全，与 orders.service 的用法一致。
import { createOpenReceiptWithinTx } from '../receipts/receipts.service.js';

export interface PaymentRequester {
  userId: string;
  role: string;
  /** 当前登录代理的 agentId（如果是 AGENT） */
  agentId?: string;
  /** 系统操作（支付回调）vs 真实用户 */
  actorType?: 'USER' | 'SYSTEM';
}

/** 防手误上限：单笔到账金额不得超过订单总额的该倍数（允许正常多付，仅拦截录入事故）。 */
const MAX_OVERPAY_MULTIPLE = 10;
/** 防手误绝对上限（元）：即便订单总额很小，也允许单笔到账到此金额（覆盖小额订单的合理多付）。 */
const MAX_SINGLE_PAYMENT_CNY = 1_000_000;
/** 批量到账单次最多处理的订单数。 */
const MAX_BATCH_ITEMS = 100;
/**
 * 「两笔金额算不算同一个数」的容差（元）：只用于同额防呆、幂等指纹这类**等值判定**，
 * 不参与超收判定——超收一律按「分」的整数比较，多收一分也是多收。
 */
const AMOUNT_MATCH_EPSILON_CNY = 0.01;
/** 同额防呆时间窗（毫秒）：同一订单近 10 分钟内的等额手工收款视为疑似重复录入。 */
const DUPLICATE_AMOUNT_WINDOW_MS = 10 * 60 * 1000;
/** 认款生成的 Payment 在旧数据中只能靠此备注前缀识别来源。 */
const RECONCILE_NOTE_PREFIX = '对账认领 ';

/**
 * 元 → 分（整数）。金额判定一律换算到分再比大小：
 * 两位小数的钱在 double 里存不精确（0.1+0.2 ≠ 0.3），直接比会把「恰好收满」误判成超收；
 * 折成分的整数后既没有浮点毛刺、也不需要任何容差，多收一分就是多收一分。
 * 入参已由接口层限死两位小数，这里的 round 只抹平浮点毛刺，不会凭空增减半分。
 */
function toCents(n: number): number {
  return Math.round(n * 100);
}

/** 分（整数）→ 元。 */
function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * 超收硬闸判定（纯函数）：本次到账是否会使订单「累计已付净额 + 预存抵扣」超过应收。
 *
 * 口径与全局清账公式（reports/reminders/serializeOrder/confirmManualPayment）一字对齐：
 *   应收（effectivePayable） = total + adjustmentCny（含改期费/换人费等售后调整行）
 *   累计已付净额             = paidAmount − 已完成退款（refundedTotal，Refund.status=COMPLETED 之和）
 *   预存抵扣（prepaymentOffset）视同已付
 * 收满（净额恰好等于应收）不算超收；严格超出——哪怕只多一分——才返回 true。
 *
 * 为什么不留容差：金额一律折成「分」的整数比较，浮点毛刺已在换算时抹平，不需要容差；
 * 留一分钱容差等于允许每笔精确多收 ¥0.01 静静记进订单，账面多付、挂账池也看不到这笔钱。
 *
 * 退款为何要减：退款完成不减 paidAmount（只翻 Refund 状态），已退出去的钱腾出的额度应可再收，
 * 故净额 = paidAmount − refundedTotal（与 softDeleteOrder 的 netReceived 同一净额口径）。
 */
export function wouldOvercharge(args: {
  effectivePayable: number;
  alreadyPaid: number;
  prepaymentOffset: number;
  refundedTotal: number;
  amount: number;
}): boolean {
  const netEffectiveAfterCents =
    toCents(args.alreadyPaid) +
    toCents(args.amount) +
    toCents(args.prepaymentOffset) -
    toCents(args.refundedTotal);
  return netEffectiveAfterCents > toCents(args.effectivePayable);
}

/**
 * 超收拆分（纯函数）：把一笔到账按「应收部分 / 超出部分」拆成两半。
 *
 * 行业口径（cash application）：收款全额入账 → 先自动核销本单应收 → 核销不掉的余额转挂账池待核销。
 *   可核销额度 creditable = 应收 − 已付净额（paidAmount − 已完成退款） − 预存抵扣，下限 0
 *   creditAmount = min(amount, creditable)   → 记进订单 paidAmount（正常收款）
 *   poolAmount   = amount − creditAmount     → 建 ORDER_OVERPAY 挂账进账（OPEN，待核销）
 *
 * 边界：
 *   - 恰好收满（含折算到分后归零的浮点毛刺）→ wouldOvercharge 为 false → 整笔进订单。
 *   - 只多一分也拆：拆出 ¥0.01 进挂账池，好过让它悄悄记成订单多付。
 *   - 应收已为 0（已收满 / 预存已抵完）→ creditable = 0 → 整笔进池。
 * 全程按「分」的整数算，两半之和恒等于 amount（守恒），钱不会在拆分里消失。
 */
export function splitOverpayment(args: {
  effectivePayable: number;
  alreadyPaid: number;
  prepaymentOffset: number;
  refundedTotal: number;
  amount: number;
}): { creditAmount: number; poolAmount: number } {
  // 没超出应收 → 不拆，整笔正常入账。
  if (!wouldOvercharge(args)) {
    return { creditAmount: round2(args.amount), poolAmount: 0 };
  }
  const amountCents = toCents(args.amount);
  const creditableCents = Math.max(
    0,
    toCents(args.effectivePayable) -
      (toCents(args.alreadyPaid) - toCents(args.refundedTotal)) -
      toCents(args.prepaymentOffset),
  );
  const creditCents = Math.min(amountCents, creditableCents);
  // poolAmount 由 amountCents 减出来（不独立取整），保证 credit + pool ≡ amount。
  return { creditAmount: fromCents(creditCents), poolAmount: fromCents(amountCents - creditCents) };
}

/**
 * 超收拆分出的挂账进账，把幂等键写进 Receipt.externalTxnId（与流水导入共用同一把唯一索引）。
 *
 * 为什么必须有：拆分后若「应收已为 0、整笔进池」，本次到账不会生成任何 Payment 记录，
 * idempotencyKey 就没有载体——重复提交（双击 / 批量重发）会建出第二笔挂账进账。
 * 挂到 externalTxnId 上后，同 key 重提会撞唯一索引，由 confirmManualPayment 顶部的回放分支接住。
 * 前缀与收单平台真实流水号不可能相同，不会污染流水导入的去重。
 */
const OVERPAY_SPLIT_TXN_PREFIX = 'MANUAL-OVERPAY:';
export function overpaySplitExternalTxnId(idempotencyKey: string): string {
  return `${OVERPAY_SPLIT_TXN_PREFIX}${idempotencyKey}`;
}

/** 一笔到账被拆分后的明细（返回体 + Payment.gatewayPayload.overpaySplit 同形状）。 */
export interface OverpaySplitDetail {
  /** 本次录入的到账全额（= creditedAmount + pooledAmount）。 */
  receivedAmount: number;
  /** 核销进本订单的部分（0 表示本单应收已满，整笔进池）。 */
  creditedAmount: number;
  /** 转入挂账池待核销的部分（恒 > 0，否则整个 overpaySplit 为 null）。 */
  pooledAmount: number;
  /** 挂账进账 id。 */
  receiptId: string;
  /** 挂账进账号（RCP…），运营照着到对账台找这笔钱。 */
  receiptNo: string;
}

/** 从 Payment.gatewayPayload 还原拆分明细（幂等回放用）；不是拆分单则 null。 */
function readOverpaySplitFromPayload(payload: Prisma.JsonValue | null): OverpaySplitDetail | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).overpaySplit;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.receiptId !== 'string' || typeof d.receiptNo !== 'string') return null;
  return {
    receivedAmount: Number(d.receivedAmount ?? 0),
    creditedAmount: Number(d.creditedAmount ?? 0),
    pooledAmount: Number(d.pooledAmount ?? 0),
    receiptId: d.receiptId,
    receiptNo: d.receiptNo,
  };
}

/** 手工收款记录（供同额防呆判定的最小形状）。 */
export interface ManualPaymentLike {
  id: string;
  amount: number;
  createdAt: Date;
}

/**
 * 同额防呆判定（纯函数）：候选到账在「近 windowMs 毫秒」内是否已有等额的手工收款记录。
 * 命中返回该记录 id，未命中返回 null。传入的 existing 应已过滤为「本订单的 SUCCEEDED 手工收款」。
 */
export function findDuplicateManualPayment(
  candidateAmount: number,
  existing: ManualPaymentLike[],
  now: Date,
  windowMs: number = DUPLICATE_AMOUNT_WINDOW_MS,
): ManualPaymentLike | null {
  const cutoff = now.getTime() - windowMs;
  return (
    existing.find(
      (p) =>
        p.createdAt.getTime() >= cutoff &&
        Math.abs(p.amount - candidateAmount) < AMOUNT_MATCH_EPSILON_CNY,
    ) ?? null
  );
}

/**
 * 同额防呆软闸命中错误：稳定 code=DUPLICATE_AMOUNT（前端据此弹二次确认，不靠中文文案匹配）。
 * 请求体带 confirmDuplicate:true 放行。details 带命中的已有收款 id 与时间窗，供前端组织确认文案。
 */
export class DuplicatePaymentAmountError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 409, code: 'DUPLICATE_AMOUNT', details });
    this.name = 'DuplicatePaymentAmountError';
  }
}

/**
 * 幂等键被另一笔请求用过（订单/金额/方式对不上）：稳定 code=IDEMPOTENCY_KEY_MISMATCH。
 * 这时绝不能按「重放」返回成功——那笔钱根本没入账，调用方却以为收了。
 */
export class IdempotencyKeyMismatchError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 409, code: 'IDEMPOTENCY_KEY_MISMATCH', details });
    this.name = 'IdempotencyKeyMismatchError';
  }
}

/**
 * 幂等回放前的请求指纹校验（纯函数）：本次请求和当初用这把 key 入账的那笔是不是同一件事。
 *
 * 为什么必须校：幂等回放分支只按 key 找记录，不看请求内容——key 撞了（前端复用、批量里同一
 * 订单出现两行、人手填的 key）就会把「另一笔真到账」当成重放，返回 ok 却一分钱没记，钱凭空消失。
 *
 * 口径：
 *   - 订单不同 → 一定是撞键，拒。
 *   - 方式不同 → 拒（同一笔钱不会既是转账又是刷卡）。
 *   - 金额不同（折分后不相等）→ 拒；requestedAmount 省略（按尾款自动取数）时无从比对，跳过金额这项。
 *   - originalAmount 传「当初录入的到账全额」（拆分单取 overpaySplit.receivedAmount），
 *     不是记进订单的那半，否则超收拆分过的单重放会被自己误判成不一致。
 * 返回不一致的原因（可直接进错误文案），一致返回 null。
 */
export function idempotentReplayMismatch(args: {
  requestedOrderId: string;
  requestedAmount?: number;
  requestedMethod: PaymentMethod;
  originalOrderId: string;
  originalAmount: number;
  originalMethod: PaymentMethod;
}): string | null {
  if (args.requestedOrderId !== args.originalOrderId) {
    return '该幂等键已用于另一张订单的收款';
  }
  if (args.requestedMethod !== args.originalMethod) {
    return `该幂等键当初记的是 ${args.originalMethod} 收款，本次是 ${args.requestedMethod}`;
  }
  // 按分整数比对：浮点差值判 epsilon 会把 1000.01−1000=0.00999… 误判成「同额重放」，
  // 差一分的新请求被假成功吞掉——与超收拆分同款口径，统一走 toCents。
  if (args.requestedAmount !== undefined && toCents(args.requestedAmount) !== toCents(args.originalAmount)) {
    return `该幂等键当初记的是 ¥${args.originalAmount.toFixed(2)}，本次是 ¥${args.requestedAmount.toFixed(2)}`;
  }
  return null;
}

/**
 * 批量到账的逐单幂等键（纯函数）：同一 batchId 重复提交时，第 n 行永远拿到同一把 key。
 *
 * 为什么不能只用 `batch:{batchId}:{orderId}`：同一批次允许同一张订单出现多行
 * （一张单收两笔、两种收款方式、两张水单），此时第二行会撞上第一行的 key，
 * 被幂等回放当成重放——返回成功却一分钱没入账，钱就这么"收"没了。
 * 这里给同一订单的第 2 行起加 `#n` 后缀，各行各有各的 key；第 1 行仍是老格式，
 * 部署前后同一 batchId 的重放不受影响。
 * 不传 batchId → 全部 undefined（不做批量去重，等价于旧行为）。
 */
export function buildBatchIdempotencyKeys(
  batchId: string | undefined,
  orderIds: readonly string[],
): Array<string | undefined> {
  if (!batchId) return orderIds.map(() => undefined);
  const occurrence = new Map<string, number>();
  return orderIds.map((orderId) => {
    const nth = occurrence.get(orderId) ?? 0;
    occurrence.set(orderId, nth + 1);
    return `batch:${batchId}:${orderId}${nth > 0 ? `#${nth}` : ''}`;
  });
}

/**
 * 该 Payment 是否为「订单转 PAID 时被作废的兄弟单」（FAILED + gatewayPayload.supersededByPaid）。
 * 用于区分「作废兜底」与「金额不匹配失败」：仅前者在真收到网关回调时被复活成可见多付（R4 point 3）。
 */
function isSupersededByPaidPayload(payload: Prisma.JsonValue | null | undefined): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).supersededByPaid === true
  );
}

export class PaymentsService {
  private readonly orderService = new OrderService();

  /**
   * 创建支付：订单必须是 PENDING_PAYMENT 状态；同一订单已有活跃 Payment 会被复用（幂等）。
   */
  async createPayment(
    body: { orderId: string; method: PaymentMethod; returnUrl?: string },
    requester: PaymentRequester,
    baseUrl: string,
  ) {
    const order = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!order) throw new NotFoundError('订单不存在');

    // 权限：客户只能付自己的单；代理只能付自己+下级的单；ADMIN/STAFF 全部
    if (requester.role === 'CUSTOMER' && order.userId !== requester.userId) {
      throw new ForbiddenError('无权支付该订单');
    }
    if (requester.role === 'AGENT') {
      if (!order.agentId) throw new ForbiddenError('无权支付该订单（非代理单）');
      const descendantIds = await getDescendantAgentIds(requester.agentId);
      if (!descendantIds.includes(order.agentId)) {
        throw new ForbiddenError('无权支付该订单');
      }
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestError(`订单状态 ${order.status}，无法发起支付`);
    }

    // 幂等：找当前活跃 Payment
    const existing = await prisma.payment.findFirst({
      where: { orderId: order.id, status: PaymentStatus.PENDING, method: body.method },
      orderBy: { createdAt: 'desc' },
    });

    const adapter = getPaymentAdapter(body.method);

    let payment;
    if (existing) {
      payment = existing;
    } else {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          method: body.method,
          amount: order.total,
          status: PaymentStatus.PENDING,
        },
      });
    }

    // 调 adapter 生成支付 URL
    const result = await adapter.createPayment({
      paymentId: payment.id,
      orderNumber: order.orderNumber,
      amountYuan: Number(order.total),
      title: `世途旅行 订单 ${order.orderNumber}`,
      notifyUrl: `${baseUrl}/payments/webhook/${adapterSlug(body.method)}`,
      returnUrl: body.returnUrl,
    });

    // 把 transactionId / 原始响应存下来
    if (result.transactionId) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          transactionId: result.transactionId,
          gatewayPayload: (result.raw ?? null) as Prisma.InputJsonValue,
        },
      });
    }

    return {
      paymentId: payment.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      method: body.method,
      amount: order.total.toString(),
      status: payment.status,
      paymentUrl: result.paymentUrl,
      needsPolling: result.needsPolling,
      transactionId: result.transactionId ?? null,
    };
  }

  /**
   * 处理网关回调（验签后）→ 标 Payment 为 SUCCEEDED → Order 转 PAID。
   * verifyCallback 内容由 adapter 完成；这里只处理业务后续。
   */
  async handleCallback(
    method: PaymentMethod,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<{ ok: true; paymentId: string; orderId: string } | { ok: false; reason: string }> {
    const adapter = getPaymentAdapter(method);
    const verification = adapter.verifyCallback(headers, body);
    if (!verification.valid) {
      return { ok: false, reason: verification.reason ?? 'invalid signature' };
    }
    if (!verification.paymentId) {
      return { ok: false, reason: 'no paymentId in callback' };
    }

    const payment = await prisma.payment.findUnique({
      where: { id: verification.paymentId },
      include: { order: true },
    });
    if (!payment) {
      return { ok: false, reason: 'payment not found' };
    }

    // 幂等：已处理的回调直接返回成功（第三方会重试）
    if (payment.status === PaymentStatus.SUCCEEDED) {
      return { ok: true, paymentId: payment.id, orderId: payment.orderId };
    }

    // R4（point 3）：被「订单转 PAID 时作废兄弟 Payment」标记（FAILED + supersededByPaid）作废的那笔，
    // 若之后真收到网关回调（客户确实又付了一次）→ 不当作普通 FAILED 拒掉，而是复活成 SUCCEEDED 并把
    // 金额计入 paidAmount 形成可见多付（下方事务处理）。据此判定这笔是否可继续处理。
    const wasSupersededByPaid =
      payment.status === PaymentStatus.FAILED && isSupersededByPaidPayload(payment.gatewayPayload);
    if (payment.status !== PaymentStatus.PENDING && !wasSupersededByPaid) {
      return { ok: false, reason: `payment already ${payment.status}` };
    }

    // 金额校验（不匹配直接拒，不落 FAILED —— 外部可能重试）
    if (verification.amountYuan !== undefined && Math.abs(Number(payment.amount) - verification.amountYuan) > 0.01) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue },
      });
      return { ok: false, reason: `amount mismatch (expected ${payment.amount}, got ${verification.amountYuan})` };
    }

    // 订单已 CANCELLED/PAYMENT_TIMEOUT：这笔钱进来时订单已死（取消/超时），资金原路退回，标 REFUNDED。
    // 「已死订单的迟到款标 REFUNDED」是正确口径——订单已取消，钱该退。
    // 并发/幂等：用 CAS（where id + 回调进来时读到的原状态 payment.status）改状态，押住 payment 原始状态，
    // 只让一个并发回调胜出，绝不覆盖已被别的通道改过的 payment。count=0（已被并发抢改）仍抛 ConflictError：
    // 结果一致（钱都会退回），网关重试也幂等。与下方 superseded 复活路径不冲突——superseded 复活只在
    // 事务内对「活订单」生效，这里订单已是取消/超时态，不会误入复活分支。
    if (payment.order.status === OrderStatus.CANCELLED || payment.order.status === OrderStatus.PAYMENT_TIMEOUT) {
      await prisma.payment.updateMany({
        where: { id: payment.id, status: payment.status },
        data: {
          status: PaymentStatus.REFUNDED,
          paidAt: new Date(),
          gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue,
        },
      });
      throw new ConflictError(`订单已 ${payment.order.status}，资金将原路退回`);
    }

    // ── 原子事务：Payment SUCCEEDED + Order PAID/多付 + 佣金 + 履约任务 一起成功或一起回滚 ──
    const pendingFulfillmentTaskIds: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Payment → SUCCEEDED (CAS 防并发)。where 用回调进来时的原状态（PENDING，或被作废的
        //    FAILED-superseded），确保同一笔并发回调只有一个胜出、绝不二次入账。
        const casPayment = await tx.payment.updateMany({
          where: { id: payment.id, status: payment.status },
          data: {
            status: PaymentStatus.SUCCEEDED,
            paidAt: verification.paidAt ?? new Date(),
            // 网关验签通过 = 收单机构确认真钱到账，创建即已核实（不进待核实队列）。
            verifiedAt: new Date(),
            transactionId: verification.transactionId ?? payment.transactionId,
            gatewayPayload: (verification.rawPayload ?? null) as Prisma.InputJsonValue,
          },
        });
        if (casPayment.count !== 1) {
          throw new ConflictError('payment status changed during callback');
        }

        // 2. 对 Order 行 FOR UPDATE 并事务内复核最新状态（回调进来到此刻订单可能已被别的通道推 PAID）。
        //    与 _updateStatusWithinTx / confirmManualPayment / 余额抵扣共用同一把行锁，串行、防旧快照。
        const rows = await tx.$queryRaw<
          Array<{ status: OrderStatus; paidAmount: Prisma.Decimal }>
        >`SELECT status, "paidAmount" FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE`;
        const o = rows[0];
        if (!o) throw new NotFoundError('订单不存在');

        if (o.status === OrderStatus.PENDING_PAYMENT) {
          // 正常路径：订单仍待支付 → 推 PAID。PAID 分支按台账聚合 SUCCEEDED（含本笔）抬 paidAmount，
          // 并作废其它 PENDING 兄弟（本笔已 SUCCEEDED，天然被排除）。
          await this.orderService._updateStatusWithinTx(
            tx,
            payment.orderId,
            OrderStatus.PAID,
            { userId: 'system-payment-gateway', role: 'ADMIN', actorType: 'SYSTEM' },
            `支付成功（${method}，txId=${verification.transactionId}）`,
            pendingFulfillmentTaskIds,
          );
        } else if (
          o.status === OrderStatus.CANCELLED ||
          o.status === OrderStatus.PAYMENT_TIMEOUT ||
          o.status === OrderStatus.REFUNDED
        ) {
          // 拿锁后发现订单已进入释放/退款态（回调与取消/超时竞态）→ 回滚，让网关重试后走上面的退款分支。
          throw new ConflictError(`订单已 ${o.status}，资金将原路退回`);
        } else {
          // 订单已 PAID / 其它持有态（迟到回调、兄弟 Payment、或被作废后又真到账）→ 本笔是真实到账，
          // 直接累加进 paidAmount 形成可见多付（paidAmount > total），走既有 creditOverpayToAgent /
          // overpayToPool 处置入口。绝不只标 SUCCEEDED 让钱在 paidAmount 上"消失"。
          // 幂等：本笔 Payment 已 CAS 成 SUCCEEDED，回调重试会在函数顶端 SUCCEEDED 短路，绝不二次累加。
          const newPaid = Number(o.paidAmount.toString()) + Number(payment.amount.toString());
          await tx.order.update({
            where: { id: payment.orderId },
            data: { paidAmount: new Prisma.Decimal(newPaid) },
          });
        }
      });
    } catch (e) {
      // 事务回滚：Payment 仍 PENDING，不会出现"已扣款但订单未推进"的状态分叉
      // eslint-disable-next-line no-console
      console.error('[payments] atomic callback transaction failed:', e);
      throw e; // 让网关看到 5xx 以便重试；或上游视情况兜底
    }

    // 事务外 enqueue fulfillment（jobId 用 taskId 做去重）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[payments] failed to enqueue fulfillment task:', e);
        });
      }
    }

    return { ok: true, paymentId: payment.id, orderId: payment.orderId };
  }

  /**
   * 人工确认收款（线下收款 → 后台标记）。ADMIN/STAFF 用。
   * 建 Payment(SUCCEEDED, proofUrl) → 累加 paidAmount → 全额则 Order→PAID
   * （同一事务，复用 _updateStatusWithinTx 生成佣金/履约任务）。
   *
   * 超收拆分（cash application 口径）：到账金额超过本单应收时**不再拒收**——
   * 同一事务内拆成两笔：应收部分正常核销进订单，超出部分建一笔 ORDER_OVERPAY 挂账进账（OPEN），
   * 留在挂账池等运营/财务认领到别的单或退回客户。应收已为 0 时整笔进池（不生成 Payment）。
   * 拆分明细在返回体 overpaySplit 里，并写审计（订单入账 X / 转池 Y）。
   *
   * 注意：对账台「认领进账到订单」的入账内核 _creditOrderPaymentWithinTx 不走这条拆分路径——
   * 那里钱本来就躺在池子里，超认必须继续拒绝（认到应收为止，余额留在池里），别把这里的拆分抄过去。
   */
  async confirmManualPayment(
    orderId: string,
    input: {
      amount?: number;
      method: PaymentMethod;
      proofUrl?: string;
      note?: string;
      idempotencyKey?: string;
      /** 同额防呆软闸放行：前端二次确认后带 true，跳过「近 10 分钟等额手工收款」拦截（超收硬闸仍生效）。 */
      confirmDuplicate?: boolean;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    /** 核销进订单的那笔收款 id；应收已为 0、整笔进池时为 null（本次没有任何钱记到订单上）。 */
    paymentId: string | null;
    paidAmount: number;
    total: number;
    fullyPaid: boolean;
    orderNumber: string;
    status: OrderStatus;
    /** 超收拆分明细；未触发拆分（全额都核销进订单）时为 null。 */
    overpaySplit: OverpaySplitDetail | null;
  }> {
    // 幂等回放：同一 idempotencyKey 已入账（双击/网络重试）→ 返回当时结果，绝不二次累计。
    // 回放前先比请求指纹（订单/金额/方式）：key 撞了就是两笔不同的钱，必须报错而不是假装收过。
    if (input.idempotencyKey) {
      const existing = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, orderId: true, amount: true, method: true, gatewayPayload: true },
      });
      if (existing) {
        const existingSplit = readOverpaySplitFromPayload(existing.gatewayPayload);
        const mismatch = idempotentReplayMismatch({
          requestedOrderId: orderId,
          requestedAmount: input.amount,
          requestedMethod: input.method,
          originalOrderId: existing.orderId,
          // 拆分单的 Payment.amount 只是核销进订单的那半，指纹要比「当初录入的到账全额」。
          originalAmount: existingSplit?.receivedAmount ?? Number(existing.amount),
          originalMethod: existing.method,
        });
        if (mismatch) {
          throw new IdempotencyKeyMismatchError(
            `${mismatch}，这笔钱没有入账。请换一个幂等键重试，或核对是否录错了单/金额。`,
            { idempotencyKey: input.idempotencyKey, existingPaymentId: existing.id, reason: mismatch },
          );
        }
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: existing.orderId },
          select: { orderNumber: true, total: true, adjustmentCny: true, paidAmount: true, prepaymentOffset: true, status: true },
        });
        const t = Number(o.total);
        const p = Number(o.paidAmount);
        // 清账口径：fullyPaid = paidAmount + prepaymentOffset >= total + adjustmentCny
        //（与 reports/reminders/serializeOrder 全局清账公式一字一致，含改期费与预存抵扣）。
        const fullyPaid = p + Number(o.prepaymentOffset) + 0.001 >= t + o.adjustmentCny;
        return {
          ok: true,
          paymentId: existing.id,
          paidAmount: p,
          total: t,
          fullyPaid,
          orderNumber: o.orderNumber,
          status: o.status,
          // 首次入账时把拆分明细写进了 gatewayPayload，回放时原样还原（前端两次看到同一个进账号）。
          overpaySplit: existingSplit,
        };
      }
      // 「应收已为 0、整笔进池」的回放：那次没有生成 Payment，幂等键挂在挂账进账的 externalTxnId 上。
      // 少了这一支，同 key 重提会再建一笔挂账进账（池子里凭空多一笔钱），且事务里撞唯一索引后
      // 下方 P2002 分支会递归重试、永远找不到 Payment → 死循环。
      const pooled = await prisma.receipt.findUnique({
        where: { externalTxnId: overpaySplitExternalTxnId(input.idempotencyKey) },
        select: { id: true, receiptNo: true, amountCny: true, orderHintId: true, method: true },
      });
      if (pooled?.orderHintId) {
        // 整笔进池时录入全额 = 进账金额，指纹同样要比（撞键的另一笔钱不能被当成重放吞掉）。
        const pooledMismatch = idempotentReplayMismatch({
          requestedOrderId: orderId,
          requestedAmount: input.amount,
          requestedMethod: input.method,
          originalOrderId: pooled.orderHintId,
          originalAmount: Number(pooled.amountCny),
          originalMethod: pooled.method,
        });
        if (pooledMismatch) {
          throw new IdempotencyKeyMismatchError(
            `${pooledMismatch}，这笔钱没有入账。请换一个幂等键重试，或核对是否录错了单/金额。`,
            { idempotencyKey: input.idempotencyKey, existingReceiptNo: pooled.receiptNo, reason: pooledMismatch },
          );
        }
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: pooled.orderHintId },
          select: { orderNumber: true, total: true, adjustmentCny: true, paidAmount: true, prepaymentOffset: true, status: true },
        });
        const t = Number(o.total);
        const p = Number(o.paidAmount);
        const fullyPaid = p + Number(o.prepaymentOffset) + 0.001 >= t + o.adjustmentCny;
        const pooledAmount = Number(pooled.amountCny);
        return {
          ok: true,
          paymentId: null,
          paidAmount: p,
          total: t,
          fullyPaid,
          orderNumber: o.orderNumber,
          status: o.status,
          overpaySplit: {
            receivedAmount: pooledAmount,
            creditedAmount: 0,
            pooledAmount,
            receiptId: pooled.id,
            receiptNo: pooled.receiptNo,
          },
        };
      }
    }

    const pendingFulfillmentTaskIds: string[] = [];
    let paymentId: string | null = null;
    let newPaid = 0;
    let total = 0;
    let fullyPaid = false;
    let orderNumber = '';
    let statusBefore: OrderStatus = OrderStatus.PENDING_PAYMENT;
    let creditedAmount = 0;
    let overpaySplit: OverpaySplitDetail | null = null;

    try {
      await prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁 + 事务内读余额：并发确认不会用旧快照双计 paidAmount
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderNumber: string; contactName: string | null; total: Prisma.Decimal; adjustmentCny: number; paidAmount: Prisma.Decimal; prepaymentOffset: Prisma.Decimal; status: OrderStatus; deletedAt: Date | null; paymentsLocked: boolean }>
      >`SELECT id, "orderNumber", "contactName", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt", "paymentsLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      // 资金闸：已取消/已退款/支付超时/草稿/回收站的单一律拒绝入账——
      // 钱记到死单上没有任何出口，且软删单不进任何统计，实收与报表会永久对不平。
      assertOrderAcceptsFunds(order);
      // 收款复核锁（准入开关，非金额校验）：财务/出纳复核无误后锁定本单收款，
      // 锁定态下拒绝一切「人工录入」收款（本方法 = 人工确认；批量确认逐单复用本方法，一并受阻）。
      // 口径边界：此锁只拦人工录入。网关 webhook / 线上支付回调（handleCallback）与对账认款
      // （receipts.allocate → _creditOrderPaymentWithinTx）都不走此路径——真钱已到账必须落库，绝不拦。
      if (order.paymentsLocked) {
        throw new ConflictError('收款已锁定（财务复核完成），请先解锁再录收款');
      }

      total = Number(order.total);
      const already = Number(order.paidAmount);
      // 清账口径（与 reports/reminders/serializeOrder 全局公式一字一致）：
      //   应付 = total + adjustmentCny（含改期费/换人费等售后调整）
      //   尾款 = 应付 − paidAmount − prepaymentOffset（预存抵扣视同已付）
      // 默认收款金额取尾款：有改期费的单，默认要连费一起收齐才不再有尾款（否则报表仍挂应收）。
      const effectivePayable = total + order.adjustmentCny;
      const prepaymentOffset = Number(order.prepaymentOffset);
      const remaining = Math.max(0, effectivePayable - already - prepaymentOffset);
      // 归一到分：接口层已拒收超两位小数的录入，这里只抹掉尾款相减留下的浮点毛刺，
      // 保证「拆分两半之和 ≡ 到账全额」与落库金额都干净。
      const amount = round2(input.amount ?? remaining);
      if (amount <= 0) throw new BadRequestError('收款金额必须大于 0');
      // 允许多付：到账金额可超过应收余额（结算价≠到账金额时常见），paidAmount 据此可超 total，
      // 尾款 = total − paidAmount 变负即为「多付」，后续抵扣/代理余额依赖该记录。
      // 仅设一个防手误的上限：单笔到账不得超过订单总额的 MAX_OVERPAY_MULTIPLE 倍，
      // 且不超过绝对上限 MAX_SINGLE_PAYMENT_CNY，避免少打一位/多打几位的录入事故。
      const fatFingerCap = Math.max(total * MAX_OVERPAY_MULTIPLE, MAX_SINGLE_PAYMENT_CNY);
      if (amount > fatFingerCap + 0.001) {
        throw new BadRequestError(
          `收款金额 ¥${amount.toFixed(2)} 异常偏高（订单总额 ¥${total.toFixed(2)}），疑似录入错误，已拒绝。如确需大额到账请分笔录入或核对金额。`,
        );
      }

      // ── 超收拆分（不再拒收）：收款按全额入账，先自动核销本单应收，核销不掉的转挂账池。
      //    应收 = total + adjustmentCny（= 上方 effectivePayable）；净额 = paidAmount − 已完成退款；
      //    creditAmount 记进订单 paidAmount，poolAmount 建 ORDER_OVERPAY 挂账进账（下方同事务内落库）。
      //    收满 / 一分钱容差内 → 不拆，整笔正常入账；应收已为 0 → creditAmount=0，整笔进池。
      const refundedRows = await tx.$queryRaw<Array<{ sum: Prisma.Decimal | null }>>`
        SELECT COALESCE(SUM(amount), 0) AS sum FROM "Refund" WHERE "orderId" = ${orderId} AND status = 'COMPLETED'
      `;
      const refundedTotal = Number(refundedRows[0]?.sum ?? 0);
      const split = splitOverpayment({
        effectivePayable,
        alreadyPaid: already,
        prepaymentOffset,
        refundedTotal,
        amount,
      });

      // ── 同额防呆软闸（confirmDuplicate 放行；两闸叠加时超收优先，故排在超收之后）：
      //    同一订单近 10 分钟内已有等额的 SUCCEEDED 手工收款记录 → 疑似把同一笔到账录了两次 → 409。
      //    仅拦手工收款（gatewayPayload.manual=true），网关到账不参与该判定。
      if (!input.confirmDuplicate) {
        const cutoff = new Date(Date.now() - DUPLICATE_AMOUNT_WINDOW_MS);
        const recentManual = await tx.payment.findMany({
          where: {
            orderId,
            status: PaymentStatus.SUCCEEDED,
            createdAt: { gte: cutoff },
            gatewayPayload: { path: ['manual'], equals: true },
          },
          select: { id: true, amount: true, createdAt: true },
        });
        const dup = findDuplicateManualPayment(
          amount,
          recentManual.map((p) => ({ id: p.id, amount: Number(p.amount), createdAt: p.createdAt })),
          new Date(),
        );
        if (dup) {
          throw new DuplicatePaymentAmountError(
            `该订单近 10 分钟内已有一笔等额收款 ¥${amount.toFixed(2)}，疑似重复录入。确认这是另一笔真实到账再提交。`,
            { existingPaymentId: dup.id, amount, windowMinutes: DUPLICATE_AMOUNT_WINDOW_MS / 60000 },
          );
        }
      }

      creditedAmount = split.creditAmount;
      newPaid = round2(already + creditedAmount);
      // 清账阈值：paidAmount + prepaymentOffset >= total + adjustmentCny 才算收齐（自动转 PAID）。
      // 有改期费的单要连费一起收齐才自动 PAID——与全局清账口径一致；force→PAID 走别的入口不受此影响。
      fullyPaid = newPaid + prepaymentOffset + 0.001 >= effectivePayable;
      orderNumber = order.orderNumber;
      statusBefore = order.status;

      // ① 超出应收的部分先落挂账池：先建才拿得到进账号，好一并写进收款记录的拆分留痕。
      //    这笔钱是 OPEN（未认领）——它不算这张单已收到的钱，要运营/财务在对账台认领或退回客户。
      if (split.poolAmount > 0) {
        const receipt = await createOpenReceiptWithinTx(tx, {
          amountCny: split.poolAmount,
          method: input.method,
          source: ReceiptSource.ORDER_OVERPAY,
          proofUrl: input.proofUrl ?? null,
          payerNote:
            `超收自动拆分 · 订单 ${order.orderNumber}` +
            (order.contactName ? ` · 付款人 ${order.contactName}` : ''),
          orderHintId: orderId,
          createdById: actor.userId,
          // 幂等载体：整笔进池时没有 Payment 承接 idempotencyKey，靠这把唯一索引防重复建池。
          externalTxnId: input.idempotencyKey
            ? overpaySplitExternalTxnId(input.idempotencyKey)
            : null,
        });
        overpaySplit = {
          receivedAmount: round2(amount),
          creditedAmount,
          pooledAmount: split.poolAmount,
          receiptId: receipt.id,
          receiptNo: receipt.receiptNo,
        };
      }

      // ② 应收部分正常核销进订单。creditedAmount 为 0（本单应收已满）时整笔都进了池，
      //    这里不建 Payment、不动 paidAmount——订单账面一分不变，才不会凭空多付。
      if (creditedAmount > 0) {
        const payment = await tx.payment.create({
          data: {
            orderId,
            method: input.method,
            amount: new Prisma.Decimal(creditedAmount),
            status: PaymentStatus.SUCCEEDED,
            paidAt: new Date(),
            idempotencyKey: input.idempotencyKey ?? null,
            proofUrl: input.proofUrl ?? null,
            gatewayPayload: {
              manual: true,
              note: input.note ?? null,
              confirmedBy: actor.userId,
              // 拆分留痕：这笔收款金额小于运营录入的到账全额时，据此说明差额去了哪张进账。
              ...(overpaySplit ? { overpaySplit } : {}),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        paymentId = payment.id;
        await tx.order.update({
          where: { id: orderId },
          data: { paidAmount: new Prisma.Decimal(newPaid) },
        });
        if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
          await this.orderService._updateStatusWithinTx(
            tx,
            orderId,
            OrderStatus.PAID,
            { userId: actor.userId, role: actor.role, actorType: 'USER' },
            `人工确认收款（${input.method}，¥${creditedAmount.toFixed(2)}）`,
            pendingFulfillmentTaskIds,
          );
        }
      }
      });
    } catch (e) {
      // 并发同 key 撞唯一索引（P2002）→ 另一请求已入账，走幂等回放（回放前的指纹校验同样生效：
      // 并发的是同一件事就返回那一笔，是撞键的另一笔钱则抛 IDEMPOTENCY_KEY_MISMATCH，不假装收过）
      if (input.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.confirmManualPayment(orderId, input, actor);
      }
      throw e;
    }

    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[payments] failed to enqueue fulfillment task:', e);
        });
      }
    }

    // 拆分留痕：审计单独记一条，把「录入全额 / 订单入账 / 转池」三个数和进账号写清楚——
    // 路由层的 CONFIRM_MANUAL_PAYMENT 只记运营录入的金额，对不上账时要靠这条还原钱去了哪。
    // overpaySplit 只在上面的 $transaction 回调里赋值。TS 的控制流分析不跟进闭包写入，
    // 会认定它仍是初始化时的 null（再判真就成 never）。这里显式断回声明类型，运行时语义不变。
    const splitDetail = overpaySplit as OverpaySplitDetail | null;
    if (splitDetail) {
      void writeAudit({
        actor: { userId: actor.userId, role: actor.role },
        action: 'SPLIT_OVERPAY_TO_POOL',
        targetType: 'ORDER',
        targetId: orderId,
        targetLabel: orderNumber,
        after: {
          receivedAmount: splitDetail.receivedAmount,
          creditedToOrder: splitDetail.creditedAmount,
          movedToPool: splitDetail.pooledAmount,
          receiptNo: splitDetail.receiptNo,
          receiptId: splitDetail.receiptId,
          paymentId,
          method: input.method,
          orderPaidAmount: newPaid,
        },
        severity: 'WARNING',
      });
    }

    return {
      ok: true,
      paymentId,
      paidAmount: newPaid,
      total,
      fullyPaid,
      orderNumber,
      // creditedAmount 为 0 时本次没往订单里记钱，状态自然不会被本次推进。
      status: creditedAmount > 0 && fullyPaid ? OrderStatus.PAID : statusBefore,
      overpaySplit: splitDetail,
    };
  }

  /**
   * 冲销一笔纯手工确认收款（录入错误/重复录入）。
   *
   * 这是人工确认收款的逆操作：只在收款复核锁未开启、且订单不在退款义务窗口时，
   * 将 Payment 以 CAS 方式标记 REFUNDED，并从订单 paidAmount 减回。对账认款必须走
   * receipts.reverseAllocation，否则不会同步回补 Receipt/ReceiptAllocation。
   * 订单状态、佣金和履约任务不回退。
   */
  async reverseManualPayment(
    paymentId: string,
    input: { reason: string },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    paymentId: string;
    reversedAmount: number;
    order: {
      orderId: string;
      orderNumber: string;
      paidAmount: number;
      balanceDue: number;
      status: OrderStatus;
      stillFullyPaid: boolean;
    };
    warning: string | null;
  }> {
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw new NotFoundError('收款记录不存在');

      const holdConversion = await tx.holdConversionRecord.findFirst({
        where: { paymentId },
        select: { holdOrder: { select: { holdNo: true } } },
      });
      if (holdConversion) {
        throw new ConflictError(
          `这笔收款是占位单 ${holdConversion.holdOrder.holdNo} 的结转款，需回占位单侧处理，不能直接撤销。`,
        );
      }

      // 认款生成的收款同样带 manual=true；必须额外排除 reconciliation，避免挂账池对不平。
      const payload =
        payment.gatewayPayload &&
        typeof payment.gatewayPayload === 'object' &&
        !Array.isArray(payment.gatewayPayload)
          ? (payment.gatewayPayload as Record<string, unknown>)
          : null;
      const isManual = payload?.manual === true;
      const isReconciliation =
        (payload !== null &&
          [
            'source',
            'receiptNo',
            'externalTxnId',
            'allocationId',
            'receiptAllocationId',
          ].some((field) => Object.prototype.hasOwnProperty.call(payload, field))) ||
        String(payload?.note).trim().startsWith(RECONCILE_NOTE_PREFIX);
      if (!isManual) {
        throw new BadRequestError('该笔收款不是人工确认收款（可能来自线上支付网关），不能在此撤销。');
      }
      if (isReconciliation) {
        throw new BadRequestError(
          '该笔收款来自收款对账台的认款，请到收款对账台撤销该笔认款——那条路径会同时把钱退回挂账池。',
        );
      }
      if (payment.status !== PaymentStatus.SUCCEEDED) {
        throw new ConflictError(
          '该笔收款当前不是已入账状态（可能已被撤销），无法撤销。请刷新后确认。',
        );
      }

      // 订单行锁 + 事务内读最新 paidAmount，与 confirmManualPayment / reverseAllocation 一致。
      const orderRows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          total: Prisma.Decimal;
          adjustmentCny: number;
          paidAmount: Prisma.Decimal;
          prepaymentOffset: Prisma.Decimal;
          status: OrderStatus;
          deletedAt: Date | null;
          paymentsLocked: boolean;
        }>
      >`SELECT id, "orderNumber", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt", "paymentsLocked" FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE`;
      const order = orderRows[0];
      if (!order) throw new NotFoundError('该收款对应的订单不存在');
      assertOrderAllowsFundsReversal(order, '撤销收款');
      if (order.paymentsLocked) {
        throw new ConflictError(
          `订单 ${order.orderNumber} 收款已锁定（财务复核完成），请先在订单收款区解锁再撤销该笔收款`,
        );
      }

      const amount = round2(Number(payment.amount));
      const paid = Number(order.paidAmount);
      const newPaid = round2(paid - amount);
      if (newPaid < -0.001) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 当前已付 ¥${paid.toFixed(2)}，不足以撤销本笔收款 ¥${amount.toFixed(2)}（撤销后会变负），已拒绝。`,
        );
      }

      const refundedTotal = await sumCompletedRefundsWithinTx(tx, order.id);
      if (refundedTotal > 0 && newPaid + 0.001 < refundedTotal) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 已完成退款 ¥${refundedTotal.toFixed(2)}，撤销本笔收款后已付将降到 ¥${Math.max(0, newPaid).toFixed(2)}，低于已退金额（账目倒挂），已拒绝。请先处理退款再撤销收款。`,
        );
      }

      const commissionNet = await outstandingCommissionNetWithinTx(tx, order.id);
      if (commissionNet > 0.001) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 已计提代理佣金 ¥${commissionNet.toFixed(2)}（尚未冲销），` +
            `冲销收款会让佣金失去依据。请联系财务按退款流程处理。`,
        );
      }

      const basePayload = payload ?? {};
      const cas = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.SUCCEEDED },
        data: {
          status: PaymentStatus.REFUNDED,
          gatewayPayload: {
            ...basePayload,
            reversed: true,
            reversedAt: new Date().toISOString(),
            reversedBy: actor.userId,
            reversedReason: input.reason,
          } as Prisma.InputJsonValue,
        },
      });
      if (cas.count !== 1) {
        throw new ConflictError('该笔收款已被撤销或状态已变更，请刷新后重试');
      }

      await tx.order.update({
        where: { id: order.id },
        data: { paidAmount: new Prisma.Decimal(Math.max(0, newPaid)) },
      });

      const effectivePayable = round2(Number(order.total) + order.adjustmentCny);
      const prepaymentOffset = Number(order.prepaymentOffset);
      const wasFullyPaid = paid + prepaymentOffset + 0.001 >= effectivePayable;
      const stillFullyPaid = newPaid + prepaymentOffset + 0.001 >= effectivePayable;
      const balanceDue = round2(effectivePayable - newPaid - prepaymentOffset);

      return {
        paymentId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        paidAmountBefore: paid,
        reversedAmount: amount,
        orderPaidAmount: Math.max(0, newPaid),
        orderBalanceDue: balanceDue,
        wasFullyPaid,
        stillFullyPaid,
      };
    });

    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'REVERSE_MANUAL_PAYMENT',
      targetType: 'ORDER',
      targetId: result.orderId,
      targetLabel: result.orderNumber,
      before: { paidAmount: result.paidAmountBefore },
      after: {
        paymentId: result.paymentId,
        reversedAmount: result.reversedAmount,
        reason: input.reason,
        orderPaidAmount: result.orderPaidAmount,
        orderBalanceDue: result.orderBalanceDue,
        orderStatus: result.orderStatus,
        wasFullyPaid: result.wasFullyPaid,
        stillFullyPaid: result.stillFullyPaid,
      },
      severity: 'CRITICAL',
    });

    return {
      ok: true as const,
      paymentId: result.paymentId,
      reversedAmount: result.reversedAmount,
      order: {
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        paidAmount: result.orderPaidAmount,
        balanceDue: result.orderBalanceDue,
        status: result.orderStatus,
        stillFullyPaid: result.stillFullyPaid,
      },
      warning:
        result.wasFullyPaid && !result.stillFullyPaid
          ? `订单 ${result.orderNumber} 撤销后重新产生尾款 ¥${result.orderBalanceDue.toFixed(2)}，订单状态仍为原状态（佣金与履约任务不回退），请据实跟进收款。`
          : null,
    };
  }

  /**
   * 财务核实一笔人工录入的收款（到账双状态的第二段）。
   *
   * 人工确认收款（含批量到账）只是「业务已收」——运营/客服凭客户水单录的账；财务在银行/收单
   * 后台对到这笔钱后点核实，落 verifiedAt/verifiedById，从待核实队列消失。
   * 防呆：录入人不能核实自己录的账（ADMIN 除外——小团队里管理员常一人多岗）。
   */
  async verifyManualPayment(
    paymentId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<{ ok: true; paymentId: string; orderNumber: string; verifiedAt: Date }> {
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { order: { select: { orderNumber: true } } },
      });
      if (!payment) throw new NotFoundError('收款记录不存在');
      if (payment.status !== PaymentStatus.SUCCEEDED) {
        throw new ConflictError('该笔收款不是已入账状态（可能已被撤销），无需核实。');
      }
      if (payment.verifiedAt) {
        throw new ConflictError('该笔收款已经核实过了，请刷新列表。');
      }
      const payload =
        payment.gatewayPayload &&
        typeof payment.gatewayPayload === 'object' &&
        !Array.isArray(payment.gatewayPayload)
          ? (payment.gatewayPayload as Record<string, unknown>)
          : null;
      if (
        actor.role !== UserRole.ADMIN &&
        typeof payload?.confirmedBy === 'string' &&
        payload.confirmedBy === actor.userId
      ) {
        throw new ConflictError('不能核实自己录入的到账，请由财务或其他同事核实。');
      }
      const verifiedAt = new Date();
      await tx.payment.update({
        where: { id: paymentId },
        data: { verifiedAt, verifiedById: actor.userId },
      });
      return { paymentId, orderNumber: payment.order.orderNumber, amount: Number(payment.amount), verifiedAt };
    });

    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'VERIFY_MANUAL_PAYMENT',
      targetType: 'ORDER',
      targetId: paymentId,
      targetLabel: result.orderNumber,
      after: { paymentId, amountCny: result.amount, verifiedAt: result.verifiedAt.toISOString() },
      severity: 'INFO',
    });

    return { ok: true as const, paymentId, orderNumber: result.orderNumber, verifiedAt: result.verifiedAt };
  }

  /**
   * 待财务核实的订单收款清单（异常队列数据源）。
   *
   * 口径：SUCCEEDED、正额、verifiedAt 为空。历史数据在迁移时已回填视同核实；认款/网关/内部
   * 处置记录创建即核实——所以剩下的恰好是「人工录入后财务还没对上流水」的账。
   */
  async listUnverifiedPayments(): Promise<
    Array<{
      id: string;
      orderId: string;
      orderNumber: string;
      agentName: string | null;
      contactName: string | null;
      amountCny: number;
      method: PaymentMethod;
      note: string | null;
      proofUrl: string | null;
      confirmedByName: string | null;
      paidAt: Date | null;
      createdAt: Date;
    }>
  > {
    const payments = await prisma.payment.findMany({
      where: { status: PaymentStatus.SUCCEEDED, verifiedAt: null, amount: { gt: 0 } },
      orderBy: { createdAt: 'asc' },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            contactName: true,
            agent: { select: { companyName: true } },
          },
        },
      },
    });
    // 录入人名字批量查一次（confirmedBy 埋在 gatewayPayload 里，没外键）。
    const userIds = new Set<string>();
    const payloadOf = (p: (typeof payments)[number]): Record<string, unknown> | null =>
      p.gatewayPayload && typeof p.gatewayPayload === 'object' && !Array.isArray(p.gatewayPayload)
        ? (p.gatewayPayload as Record<string, unknown>)
        : null;
    for (const p of payments) {
      const confirmedBy = payloadOf(p)?.confirmedBy;
      if (typeof confirmedBy === 'string') userIds.add(confirmedBy);
    }
    const users = userIds.size
      ? await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true, email: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName || u.email]));
    return payments.map((p) => {
      const payload = payloadOf(p);
      const confirmedBy = typeof payload?.confirmedBy === 'string' ? payload.confirmedBy : null;
      return {
        id: p.id,
        orderId: p.order.id,
        orderNumber: p.order.orderNumber,
        agentName: p.order.agent?.companyName ?? null,
        contactName: p.order.contactName ?? null,
        amountCny: Number(p.amount),
        method: p.method,
        note: typeof payload?.note === 'string' ? payload.note : null,
        proofUrl: p.proofUrl ?? null,
        confirmedByName: confirmedBy ? (nameById.get(confirmedBy) ?? null) : null,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      };
    });
  }

  /**
   * 在调用方事务内给订单入账 —— confirmManualPayment 入账内核的「事务内」变体。
   *
   * 收款对账台「认领进账到订单」复用此函数：因为认领必须和
   * （扣减进账剩余额 + 写 ReceiptAllocation + 重算 Receipt 状态）在同一个原子事务里完成，
   * 全成功或全回滚——不能出现「订单加了钱但进账没记认领」的资金分叉。
   *
   * 与 confirmManualPayment 的入账口径逐字一致（同一行锁读余额 + 同一防手误上限
   * + 同一超收硬闸 + 同一 paidAmount 累加 + 同一全额自动翻 PAID + 同一 _updateStatusWithinTx
   * 生成佣金/履约）。差异仅在事务边界：这里不自己开事务，由调用方 tx 统筹；履约任务 id 通过
   * pendingFulfillmentTaskIds 回传，调用方在事务提交后入队。
   *
   * 唯一**刻意**的口径差异：不判 `paymentsLocked` 复核锁。锁只拦「人工录入」；本内核服务的是
   * 对账认款——真钱已经到公司账上，必须如实落库，绝不因复核锁把到账丢掉（见 confirmManualPayment
   * 上方的口径边界注释）。别给这里补锁；要补对称性请改撤销侧。
   *
   * 注意：此函数本身不写审计——调用方（对账认领）按自己的口径写审计。
   */
  async _creditOrderPaymentWithinTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    input: {
      amount: number;
      method: PaymentMethod;
      proofUrl?: string | null;
      note?: string | null;
      // 对账认款来源标注（仅 receipts.allocate 传）：把「这笔收款来自对账认领的进账」结构化写进
      // gatewayPayload，供订单序列化透出 reconciled/receiptNo/externalTxnId 只读标注（收款列表徽标用）。
      //
      // allocationId 是**撤销认款的定位键**：撤销时靠它一一对应地找回「本次认款生成的就是这一笔收款」，
      // 不靠金额猜。调用方（receipts.allocate）先建 ReceiptAllocation 再入账，故恒可拿到 id；
      // 历史数据无此键，撤销侧按 receiptNo + 金额兜底匹配。
      reconciliation?: { receiptNo: string; externalTxnId?: string | null; allocationId?: string };
      /**
       * 财务核实标记（到账双状态）：true = 创建即已核实（对账认款——财务亲手认的；或结转来源
       * 全部已核实），false = 待财务核实（占位单结转款里含未核实的运营水单登记）。
       * 必传——每个调用方都要自己决定这笔钱算不算核实过，不给默认值以免新调用方无脑漏标。
       */
      verified: boolean;
    },
    actor: { userId: string; role: UserRole },
    pendingFulfillmentTaskIds: string[],
  ): Promise<{
    paymentId: string;
    paidAmount: number;
    total: number;
    fullyPaid: boolean;
    orderNumber: string;
    status: OrderStatus;
  }> {
    // FOR UPDATE 行锁 + 事务内读余额：与 confirmManualPayment 完全一致的并发安全口径
    const rows = await tx.$queryRaw<
      Array<{ id: string; orderNumber: string; total: Prisma.Decimal; adjustmentCny: number; paidAmount: Prisma.Decimal; prepaymentOffset: Prisma.Decimal; status: OrderStatus; deletedAt: Date | null }>
    >`SELECT id, "orderNumber", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new NotFoundError('订单不存在');
    // 资金闸（与 confirmManualPayment 同一处实现）：死单/回收站单不许入账
    assertOrderAcceptsFunds(order);

    const total = Number(order.total);
    const already = Number(order.paidAmount);
    const amount = input.amount;
    if (amount <= 0) throw new BadRequestError('收款金额必须大于 0');
    // 与 confirmManualPayment 同一防手误上限
    const fatFingerCap = Math.max(total * MAX_OVERPAY_MULTIPLE, MAX_SINGLE_PAYMENT_CNY);
    if (amount > fatFingerCap + 0.001) {
      throw new BadRequestError(
        `收款金额 ¥${amount.toFixed(2)} 异常偏高（订单总额 ¥${total.toFixed(2)}），疑似录入错误，已拒绝。如确需大额到账请分笔录入或核对金额。`,
      );
    }
    // 清账口径（与 confirmManualPayment 一字一致）：paidAmount + prepaymentOffset >= total + adjustmentCny
    const effectivePayable = total + order.adjustmentCny;
    const prepaymentOffset = Number(order.prepaymentOffset);

    // ── 超收硬闸（与 confirmManualPayment 同一判定函数、同一口径）────────────────
    // 少了这一闸，认款就是一条能把 paidAmount 无限抬到应收之上的旁路：把一笔大额流水
    // 反复认到同一张小额订单上，订单账面凭空多付，而多付会继续喂给多付转余额/退款等下游，
    // 造成真实资金损失。收满不拦，仅严格超出才拦。
    // 认款场景下钱本来就躺在挂账池里：拒绝这一笔不会丢钱——只认到应收余额为止，
    // 剩下的留在池子里按挂账处置（退回客户 / 认到别的单），这正是挂账池存在的意义。
    const refundedTotal = await sumCompletedRefundsWithinTx(tx, orderId);
    if (wouldOvercharge({ effectivePayable, alreadyPaid: already, prepaymentOffset, refundedTotal, amount })) {
      const creditable = round2(
        Math.max(0, effectivePayable - (already - refundedTotal) - prepaymentOffset),
      );
      throw new BadRequestError(
        `订单 ${order.orderNumber} 应收 ¥${round2(effectivePayable).toFixed(2)}、已收净额 ` +
          `¥${round2(already - refundedTotal).toFixed(2)}，本笔 ¥${round2(amount).toFixed(2)} 会超出应收。` +
          `最多只能认领 ¥${creditable.toFixed(2)}，超出部分请留在挂账池另行处置。`,
      );
    }

    const newPaid = already + amount;
    const fullyPaid = newPaid + prepaymentOffset + 0.001 >= effectivePayable;

    const payment = await tx.payment.create({
      data: {
        orderId,
        method: input.method,
        amount: new Prisma.Decimal(amount),
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
        verifiedAt: input.verified ? new Date() : null,
        verifiedById: input.verified ? actor.userId : null,
        proofUrl: input.proofUrl ?? null,
        gatewayPayload: {
          manual: true,
          note: input.note ?? null,
          confirmedBy: actor.userId,
          // 结构化认款来源（仅对账认领时带）：保留上面的 note 不破坏，额外透出可机读的三元组，
          // 订单序列化据此把这行收款标注为「已认款 · 流水{externalTxnId 或 receiptNo}」。
          ...(input.reconciliation
            ? {
                source: 'reconciliation',
                receiptNo: input.reconciliation.receiptNo,
                externalTxnId: input.reconciliation.externalTxnId ?? null,
                // 撤销认款的定位键（一笔认领 ↔ 一笔收款）；老数据为 undefined，撤销侧有兜底匹配。
                ...(input.reconciliation.allocationId
                  ? { allocationId: input.reconciliation.allocationId }
                  : {}),
              }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { paidAmount: new Prisma.Decimal(newPaid) },
    });
    if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
      await this.orderService._updateStatusWithinTx(
        tx,
        orderId,
        OrderStatus.PAID,
        { userId: actor.userId, role: actor.role, actorType: 'USER' },
        `人工确认收款（${input.method}，¥${amount.toFixed(2)}）`,
        pendingFulfillmentTaskIds,
      );
    }

    return {
      paymentId: payment.id,
      paidAmount: newPaid,
      total,
      fullyPaid,
      orderNumber: order.orderNumber,
      status: fullyPaid ? OrderStatus.PAID : order.status,
    };
  }

  /**
   * 批量确认收款 —— 选多个订单一次性到账。ADMIN/STAFF 用。
   * 逐单复用 confirmManualPayment（每单独立行锁 + 幂等 + 审计），互不影响：
   * 某一单失败（订单不存在/金额异常等）不会中断其余订单，结果逐单收集返回。
   * sharedProofUrl 作为没有单独 proofUrl 的订单的回退凭证（如一张合并转账截图）。
   *
   * 幂等：整批共用一个 batchId（前端表单打开时生成一次，成功后换新；不传则不做批量去重，
   * 等价于旧行为）。逐行幂等键 = `batch:{batchId}:{orderId}`（同一订单的第 2 行起带 `#n`
   * 后缀，见 buildBatchIdempotencyKeys），透传给 confirmManualPayment，复用它已有的唯一约束
   * + 回放逻辑——同一 batchId 重复提交（双击/网络重试/表单重发），每一行只入账一次，
   * 回放返回首次入账结果，绝不二次累计，也绝不把同单的第二行当成第一行的重放吞掉。
   *
   * 超收同样走拆分（逐单复用 confirmManualPayment 的口径）：某一单录多了不再整条失败，
   * 应收部分照常核销、超出部分进挂账池，逐条结果里带 overpaySplit 供前端提示。
   *
   */
  async batchConfirmManualPayment(
    input: {
      items: Array<{
        orderId: string;
        amount: number;
        method?: PaymentMethod;
        proofUrl?: string;
        note?: string;
      }>;
      sharedProofUrl?: string;
      batchId?: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    results: Array<{
      orderId: string;
      ok: boolean;
      error?: string;
      paidAmount?: number;
      total?: number;
      status?: OrderStatus;
      paymentId?: string | null;
      /** 该单触发超收拆分时带上（应收部分已核销，超出部分已进挂账池）；未拆分为 null。 */
      overpaySplit?: OverpaySplitDetail | null;
    }>;
  }> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestError('批量到账列表不能为空');
    }
    if (input.items.length > MAX_BATCH_ITEMS) {
      throw new BadRequestError(`单次批量到账最多 ${MAX_BATCH_ITEMS} 笔订单`);
    }
    // 逐行幂等键一次性算好：同一张订单在批次里出现多行时各行各有各的 key（见
    // buildBatchIdempotencyKeys），否则第二行会撞上第一行的 key 被当成重放静默吞掉。
    const idempotencyKeys = buildBatchIdempotencyKeys(
      input.batchId,
      input.items.map((i) => i.orderId),
    );

    const results: Array<{
      orderId: string;
      ok: boolean;
      error?: string;
      paidAmount?: number;
      total?: number;
      status?: OrderStatus;
      paymentId?: string | null;
      /** 该单触发超收拆分时带上（应收部分已核销，超出部分已进挂账池）；未拆分为 null。 */
      overpaySplit?: OverpaySplitDetail | null;
    }> = [];

    // 逐单串行处理：每单一个事务/行锁，一坏不连累其余（收集错误而非整体回滚）
    for (const [index, item] of input.items.entries()) {
      try {
        // 重复提交同一批次时同一行拿到同一把 key，confirmManualPayment 走回放分支不会二次入账；
        // 回放前还会比请求指纹（订单/金额/方式），撞键的另一笔钱会报 409 而不是被当成收过。
        const idempotencyKey = idempotencyKeys[index];
        const result = await this.confirmManualPayment(
          item.orderId,
          {
            amount: item.amount,
            method: item.method ?? PaymentMethod.BANK_CARD,
            proofUrl: item.proofUrl ?? input.sharedProofUrl,
            note: item.note,
            idempotencyKey,
            // 批量到账跳过「同额防呆」软闸：整批共用 batchId 已做重复提交去重，且逐单是运营核对过的清单；
            // 同额防呆是给单笔交互录入防双击用的。超收硬闸不受此影响，批量到账同样会拦超收。
            confirmDuplicate: true,
          },
          actor,
        );
        results.push({
          orderId: item.orderId,
          ok: true,
          paidAmount: result.paidAmount,
          total: result.total,
          status: result.status,
          paymentId: result.paymentId,
          overpaySplit: result.overpaySplit,
        });
      } catch (e) {
        results.push({
          orderId: item.orderId,
          ok: false,
          error: e instanceof Error ? e.message : '到账失败',
        });
      }
    }

    return { results };
  }

  /**
   * 微信小程序 JSAPI 支付 — 生成 wx.requestPayment 所需参数。
   *
   * 和 createPayment(method=WECHAT_PAY) 的区别：Native 走 transactions_native → 扫码
   * 这里走 transactions_jsapi → 返回 prepay_id + 签名后的客户端参数
   *
   * 开发模式（无 WECHAT_APPID 或 user 没 openid）：
   *   - 返回 mock 参数，前端在 DevTools 里 wx.requestPayment 会失败但不会崩
   *   - 本机测试走 sandbox webhook 强推 PAID
   */
  async createMiniappPayment(
    body: { orderId: string },
    requester: PaymentRequester,
    baseUrl: string,
  ): Promise<{
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
    paySign: string;
  }> {
    const order = await prisma.order.findUnique({ where: { id: body.orderId } });
    if (!order) throw new NotFoundError('订单不存在');

    // 只有订单本人 / 代理链上层 / staff 可付
    if (requester.role === 'CUSTOMER' && order.userId !== requester.userId) {
      throw new ForbiddenError('无权支付该订单');
    }
    if (requester.role === 'AGENT') {
      if (!order.agentId) throw new ForbiddenError('无权支付该订单');
      const descendantIds = await getDescendantAgentIds(requester.agentId);
      if (!descendantIds.includes(order.agentId)) {
        throw new ForbiddenError('无权支付该订单');
      }
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestError(`订单状态 ${order.status}，无法发起支付`);
    }

    // 需要用户的 openid（wx.login 注册时写入）。游客单（userId=null）无微信归属，
    // 不能走小程序 JSAPI 支付（游客付款走其他通道）。
    if (!order.userId) {
      throw new BadRequestError('游客订单不支持小程序 JSAPI 支付，请走收款码或登录后支付');
    }
    const user = await prisma.user.findUnique({ where: { id: order.userId } });
    const openid = user?.wechatOpenId;
    if (!openid) {
      throw new BadRequestError('该用户未绑定微信 openid，不能走小程序 JSAPI 支付');
    }

    // 幂等：同订单已有 PENDING wx 支付就复用
    let payment = await prisma.payment.findFirst({
      where: { orderId: order.id, status: PaymentStatus.PENDING, method: PaymentMethod.WECHAT_PAY },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          method: PaymentMethod.WECHAT_PAY,
          amount: order.total,
          status: PaymentStatus.PENDING,
        },
      });
    }

    const { createMiniappJsapiPayment } = await import('./payment-adapters.js');
    return createMiniappJsapiPayment({
      paymentId: payment.id,
      orderNumber: order.orderNumber,
      amountYuan: Number(order.total),
      title: `世途旅行 订单 ${order.orderNumber}`,
      notifyUrl: `${baseUrl}/payments/webhook/wechat`,
      openid,
    });
  }
}

// getDescendantAgentIds — 已抽到 lib/agent-tree.ts

function adapterSlug(method: PaymentMethod): string {
  switch (method) {
    case PaymentMethod.WECHAT_PAY: return 'wechat';
    case PaymentMethod.ALIPAY: return 'alipay';
    case PaymentMethod.BANK_CARD: return 'bankcard';
    case PaymentMethod.AGENT_PREPAYMENT: return 'prepayment';
  }
}
