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
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';
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
 * 清账/超收判定的一分钱容差：避免浮点误差把「恰好收满」误判成超收。
 * 与全局清账公式里的 0.001 同源，这里放宽到一分钱（金额均为两位小数），只有严格多收才拦。
 */
const OVERPAY_EPSILON_CNY = 0.01;
/** 同额防呆时间窗（毫秒）：同一订单近 10 分钟内的等额手工收款视为疑似重复录入。 */
const DUPLICATE_AMOUNT_WINDOW_MS = 10 * 60 * 1000;
/** 认款生成的 Payment 在旧数据中只能靠此备注前缀识别来源。 */
const RECONCILE_NOTE_PREFIX = '对账认领 ';

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 超收硬闸判定（纯函数）：本次到账是否会使订单「累计已付净额 + 预存抵扣」超过应收。
 *
 * 口径与全局清账公式（reports/reminders/serializeOrder/confirmManualPayment）一字对齐：
 *   应收（effectivePayable） = total + adjustmentCny（含改期费/换人费等售后调整行）
 *   累计已付净额             = paidAmount − 已完成退款（refundedTotal，Refund.status=COMPLETED 之和）
 *   预存抵扣（prepaymentOffset）视同已付
 * 收满（净额恰好等于应收，含一分钱容差）不算超收；仅严格超出才返回 true。
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
  const netEffectiveAfter =
    args.alreadyPaid + args.amount + args.prepaymentOffset - args.refundedTotal;
  return netEffectiveAfter > args.effectivePayable + OVERPAY_EPSILON_CNY;
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
        Math.abs(p.amount - candidateAmount) < OVERPAY_EPSILON_CNY,
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
    paymentId: string;
    paidAmount: number;
    total: number;
    fullyPaid: boolean;
    orderNumber: string;
    status: OrderStatus;
  }> {
    // 幂等回放：同一 idempotencyKey 已入账（双击/网络重试）→ 返回当时结果，绝不二次累计
    if (input.idempotencyKey) {
      const existing = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, orderId: true },
      });
      if (existing) {
        const o = await prisma.order.findUniqueOrThrow({
          where: { id: existing.orderId },
          select: { orderNumber: true, total: true, adjustmentCny: true, paidAmount: true, prepaymentOffset: true, status: true },
        });
        const t = Number(o.total);
        const p = Number(o.paidAmount);
        // 清账口径：fullyPaid = paidAmount + prepaymentOffset >= total + adjustmentCny
        //（与 reports/reminders/serializeOrder 全局清账公式一字一致，含改期费与预存抵扣）。
        const fullyPaid = p + Number(o.prepaymentOffset) + 0.001 >= t + o.adjustmentCny;
        return { ok: true, paymentId: existing.id, paidAmount: p, total: t, fullyPaid, orderNumber: o.orderNumber, status: o.status };
      }
    }

    const pendingFulfillmentTaskIds: string[] = [];
    let paymentId = '';
    let newPaid = 0;
    let total = 0;
    let fullyPaid = false;
    let orderNumber = '';
    let statusBefore: OrderStatus = OrderStatus.PENDING_PAYMENT;

    try {
      await prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁 + 事务内读余额：并发确认不会用旧快照双计 paidAmount
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderNumber: string; total: Prisma.Decimal; adjustmentCny: number; paidAmount: Prisma.Decimal; prepaymentOffset: Prisma.Decimal; status: OrderStatus; deletedAt: Date | null; paymentsLocked: boolean }>
      >`SELECT id, "orderNumber", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt", "paymentsLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
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
      const amount = input.amount ?? remaining;
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

      // ── 超收硬闸（散客/代理都拦）：本次到账不得使「累计已付净额 + 预存抵扣」超过应收。
      //    应收 = total + adjustmentCny（= 上方 effectivePayable）；净额 = paidAmount − 已完成退款；
      //    收满(等于应收)不拦，仅超出拦。多付不再从此路口进账——超出部分改走收款对账台挂账池登记；
      //    存量多付单仍用多付转余额/挂账池端点处置（那些端点保留不动）。
      const refundedRows = await tx.$queryRaw<Array<{ sum: Prisma.Decimal | null }>>`
        SELECT COALESCE(SUM(amount), 0) AS sum FROM "Refund" WHERE "orderId" = ${orderId} AND status = 'COMPLETED'
      `;
      const refundedTotal = Number(refundedRows[0]?.sum ?? 0);
      if (
        wouldOvercharge({ effectivePayable, alreadyPaid: already, prepaymentOffset, refundedTotal, amount })
      ) {
        throw new BadRequestError(
          '该订单已收满/本笔将超出应收，超出部分请在收款对账台登记挂账池',
        );
      }

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

      newPaid = already + amount;
      // 清账阈值：paidAmount + prepaymentOffset >= total + adjustmentCny 才算收齐（自动转 PAID）。
      // 有改期费的单要连费一起收齐才自动 PAID——与全局清账口径一致；force→PAID 走别的入口不受此影响。
      fullyPaid = newPaid + prepaymentOffset + 0.001 >= effectivePayable;
      orderNumber = order.orderNumber;
      statusBefore = order.status;

      const payment = await tx.payment.create({
        data: {
          orderId,
          method: input.method,
          amount: new Prisma.Decimal(amount),
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
          idempotencyKey: input.idempotencyKey ?? null,
          proofUrl: input.proofUrl ?? null,
          gatewayPayload: {
            manual: true,
            note: input.note ?? null,
            confirmedBy: actor.userId,
          } as Prisma.InputJsonValue,
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
          `人工确认收款（${input.method}，¥${amount.toFixed(2)}）`,
          pendingFulfillmentTaskIds,
        );
      }
      });
    } catch (e) {
      // 并发同 key 撞唯一索引（P2002）→ 另一请求已入账，走幂等回放
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

    return {
      ok: true,
      paymentId,
      paidAmount: newPaid,
      total,
      fullyPaid,
      orderNumber,
      status: fullyPaid ? OrderStatus.PAID : statusBefore,
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

      const commissionAgg = await tx.commissionRecord.aggregate({
        where: { orderId: order.id },
        _sum: { amount: true },
      });
      const commissionNet = round2(Number(commissionAgg._sum.amount ?? 0));
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
   * 等价于旧行为）。逐单幂等键 = `batch:{batchId}:{orderId}`，透传给 confirmManualPayment，
   * 复用它已有的唯一约束 + 回放逻辑——同一 batchId 重复提交（双击/网络重试/表单重发），
   * 同一 orderId 只入账一次，回放返回首次入账结果，绝不二次累计。
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
      paymentId?: string;
    }>;
  }> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new BadRequestError('批量到账列表不能为空');
    }
    if (input.items.length > MAX_BATCH_ITEMS) {
      throw new BadRequestError(`单次批量到账最多 ${MAX_BATCH_ITEMS} 笔订单`);
    }

    const results: Array<{
      orderId: string;
      ok: boolean;
      error?: string;
      paidAmount?: number;
      total?: number;
      status?: OrderStatus;
      paymentId?: string;
    }> = [];

    // 逐单串行处理：每单一个事务/行锁，一坏不连累其余（收集错误而非整体回滚）
    for (const item of input.items) {
      try {
        // 同一 batchId 下逐单幂等键固定为 batch:{batchId}:{orderId}，
        // 重复提交同一批次时 confirmManualPayment 会走回放分支，不会二次入账。
        const idempotencyKey = input.batchId ? `batch:${input.batchId}:${item.orderId}` : undefined;
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
