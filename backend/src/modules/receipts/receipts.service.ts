/**
 * 收款对账台 / 挂账池服务（Receipts / Suspense pool）。
 *
 * 业务：公司用统一收款码收钱，财务在后台手动对账。
 *   - 登记进账（register）→ OPEN Receipt 进挂账池
 *   - 认领（allocate）→ 把进账的钱记到某订单（复用人工确认收款入账内核，原子）
 *   - 撤销认款（reverseAllocation）→ 认领的镜像：钱从订单撤回挂账池，留痕可追溯
 *   - 退款（refund）→ 把剩余未认领部分标 REFUNDED
 *   - 总账（ledger）→ 读时合并 Receipts + 近期订单 Payments，一处看所有进账
 *
 * 资金安全：
 *   - 认领是「全有或全无」：金额校验 + 订单入账 + 写 ReceiptAllocation + 扣减剩余 + 重算状态，
 *     全部在同一个 prisma.$transaction 里；任一步失败整体回滚，绝不出现资金分叉。
 *   - 不改既有 confirmManualPayment（逐单确认收款）一行——认领走它的「事务内」变体
 *     PaymentsService._creditOrderPaymentWithinTx，口径逐字一致。
 */
import {
  Prisma,
  OrderStatus,
  PaymentMethod,
  ReceiptSource,
  ReceiptStatus,
  UserRole,
  type Receipt,
  type ReceiptAllocation,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  FUNDS_CREDIT_BLOCKED_STATUSES,
  assertOrderAllowsFundsReversal,
  sumCompletedRefundsWithinTx,
} from '../../lib/funds-guard.js';
import { writeAudit } from '../../lib/audit.js';
import { PaymentsService } from '../payments/payments.service.js';
import { earliestFlightDeparture } from '../orders/pnr-export.js';
import type {
  AllocateBatchInput,
  AllocateReceiptInput,
  ExportStatementQuery,
  ImportStatementInput,
  ListReceiptsQuery,
  MatchCandidatesQuery,
  RegisterReceiptInput,
} from './receipts.schemas.js';
import {
  parseStatementXlsx,
  buildStatementExportWorkbook,
  statementStorageExternalTxnId,
  type StatementExportEntry,
  type StatementPlatform,
} from './receipts.statement.js';

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 把 YYYY-MM-DD 闭区间（北京时）换算成 Prisma DateTime 过滤条件。
 * 与流水核对表导出（exportStatement）同款边界：from 取当日 00:00:00，to 取当日 23:59:59.999。
 * 都为空 → undefined（调用方据此决定是否加过滤）。
 */
function beijingDayRange(
  from?: string,
  to?: string,
): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00+08:00`) } : {}),
    ...(to ? { lte: new Date(`${to}T23:59:59.999+08:00`) } : {}),
  };
}

/**
 * YYYY-MM-DD（UTC date-only，与订单导出的 fmtDate 同口径）。
 * @db.Date 过 JSON 会变成完整 ISO 串，这里在后端就切成纯日期，前端直接用。
 */
function fmtDateOnly(d: Date | null | undefined): string | null {
  if (!d) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 订单最早入住日（纯签证/酒店等无航段单的出发日回落）；无 → null。*/
function earliestHotelCheckIn(
  items: Array<{ hotelCheckIn?: Date | null }>,
): Date | null {
  const dates = items
    .map((it) => it.hotelCheckIn)
    .filter((d): d is Date => Boolean(d));
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (d < min ? d : min));
}

/** 订单去程出发日期（最早 FLIGHT 行出发时间；无航段回落最早入住日；都无 → null）。*/
function orderDepartDate(
  items: Array<{
    kind: string;
    flightSchedule?: { departureTime: Date } | null;
    hotelCheckIn?: Date | null;
  }>,
): string | null {
  const flight = earliestFlightDeparture(items);
  if (flight) return fmtDateOnly(flight);
  return fmtDateOnly(earliestHotelCheckIn(items));
}

/**
 * 生成进账编号：RCP + UTC 日期 + 12 位高熵随机十六进制。
 *
 * 熵足够大（16^12 ≈ 2.8e14/天），唯一冲突概率天文级小，因此无需在事务内重试换号
 * （事务内重试在 P2002 后会污染已中止的 PG 事务，反而产生迷惑性报错）。
 */
export async function generateReceiptNo(): Promise<string> {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(6).toString('hex').toUpperCase(); // 12 位十六进制
  return `RCP${yyyy}${mm}${dd}${suffix}`;
}

/** 在调用方事务内建一笔 OPEN 进账（供 register / 订单超额转挂账池 / 客户上传复用）。 */
export async function createOpenReceiptWithinTx(
  tx: Prisma.TransactionClient,
  data: {
    amountCny: number;
    method: PaymentMethod;
    source: ReceiptSource;
    proofUrl?: string | null;
    payerNote?: string | null;
    orderHintId?: string | null;
    receivedAt?: Date;
    createdById?: string | null;
    externalTxnId?: string | null;
  },
): Promise<Receipt> {
  // receiptNo 在调用前一次性生成（12 位高熵随机，撞唯一索引概率天文级小）。
  // 不在事务内重试换号：本函数运行在调用方拥有的事务里，P2002 一旦发生 PG 事务已中止，
  // 续写只会抛迷惑性错误；让极罕见的冲突直接以干净错误冒泡、由外层事务整体回滚即可。
  const receiptNo = await generateReceiptNo();
  return tx.receipt.create({
    data: {
      receiptNo,
      amountCny: new Prisma.Decimal(round2(data.amountCny)),
      allocatedCny: new Prisma.Decimal(0),
      method: data.method,
      source: data.source,
      status: ReceiptStatus.OPEN,
      proofUrl: data.proofUrl ?? null,
      payerNote: data.payerNote ?? null,
      orderHintId: data.orderHintId ?? null,
      receivedAt: data.receivedAt ?? new Date(),
      createdById: data.createdById ?? null,
      externalTxnId: data.externalTxnId ?? null,
    },
  });
}

/** 认领入账时写进 Payment.note 的前缀（旧数据只有它可作来源线索）。 */
const RECONCILE_NOTE_PREFIX = '对账认领 ';

/**
 * 找回「这笔认领当初入账生成的那一笔收款」——撤销认款的定位环节。
 *
 *   1) 新数据：gatewayPayload.allocationId 精确命中，一一对应，零歧义。
 *   2) 历史数据（认领时还没写 allocationId）：同订单 + SUCCEEDED + 金额相等 + 来源是同一张进账
 *      （gatewayPayload.receiptNo，或旧 note「对账认领 RCP…」），且**本身不带 allocationId**
 *      （带的属于另一条明确的认领，绝不误冲）。多条候选取入账时间最接近认领时间的一笔——
 *      同进账同订单同金额的多笔在账面上完全等价，冲哪一笔结果相同。
 *
 * 找不到 → null，调用方拒绝撤销。宁可拒绝也不硬扣订单已付。
 */
async function findAllocationPaymentWithinTx(
  tx: Prisma.TransactionClient,
  key: {
    allocationId: string;
    orderId: string;
    receiptNo: string;
    amount: number;
    allocatedAt: Date;
  },
): Promise<{ id: string; gatewayPayload: Prisma.JsonValue | null } | null> {
  const exact = await tx.payment.findFirst({
    where: {
      orderId: key.orderId,
      status: 'SUCCEEDED',
      gatewayPayload: { path: ['allocationId'], equals: key.allocationId },
    },
    select: { id: true, gatewayPayload: true },
  });
  if (exact) return exact;

  // 兜底：金额 + 进账流水号匹配（历史认款）
  const candidates = await tx.payment.findMany({
    where: {
      orderId: key.orderId,
      status: 'SUCCEEDED',
      amount: new Prisma.Decimal(key.amount),
    },
    select: { id: true, gatewayPayload: true, createdAt: true },
  });
  const matched = candidates.filter((p) => {
    const payload =
      p.gatewayPayload && typeof p.gatewayPayload === 'object' && !Array.isArray(p.gatewayPayload)
        ? (p.gatewayPayload as Record<string, unknown>)
        : null;
    if (!payload) return false;
    // 已绑定到某条认领的收款不参与兜底匹配（那是别人的钱，只能被它自己的认领撤销）
    if (typeof payload.allocationId === 'string') return false;
    if (payload.source === 'reconciliation' && payload.receiptNo === key.receiptNo) return true;
    return (
      typeof payload.note === 'string' &&
      payload.note.startsWith(RECONCILE_NOTE_PREFIX) &&
      payload.note.slice(RECONCILE_NOTE_PREFIX.length).trim() === key.receiptNo
    );
  });
  if (matched.length === 0) return null;
  const nearest = matched.reduce((best, p) =>
    Math.abs(p.createdAt.getTime() - key.allocatedAt.getTime()) <
    Math.abs(best.createdAt.getTime() - key.allocatedAt.getTime())
      ? p
      : best,
  );
  return { id: nearest.id, gatewayPayload: nearest.gatewayPayload };
}

type ReceiptWithAllocations = Receipt & { allocations: ReceiptAllocation[] };

/**
 * 批量把订单 id 换成订单号（ReceiptAllocation / orderHintId 都只存 id，无 Prisma relation）。
 * 一次 IN 查询，不做 N+1；空数组直接返回空表，不打库。
 */
export async function loadOrderNumbers(
  orderIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(orderIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const orders = await prisma.order.findMany({
    where: { id: { in: ids } },
    select: { id: true, orderNumber: true },
  });
  return new Map(orders.map((o) => [o.id, o.orderNumber]));
}

/**
 * 进账序列化（含 remaining + 认领明细汇总），字段名即前端读取口径。
 * orderNoById：订单 id→订单号映射（调用方批量查好传进来）。查不到 → null，
 * 前端回落显示 id 前 8 位。财务要的是订单号，光给 id 前 8 位对不上单。
 */
export function serializeReceipt(
  r: ReceiptWithAllocations,
  orderNoById?: ReadonlyMap<string, string>,
) {
  const amount = Number(r.amountCny);
  const allocated = Number(r.allocatedCny);
  return {
    id: r.id,
    receiptNo: r.receiptNo,
    amountCny: r.amountCny.toString(),
    allocatedCny: r.allocatedCny.toString(),
    remainingCny: round2(amount - allocated).toFixed(2),
    method: r.method,
    proofUrl: r.proofUrl,
    payerNote: r.payerNote,
    externalTxnId: r.externalTxnId,
    orderHintId: r.orderHintId,
    hintOrderNumber: r.orderHintId ? (orderNoById?.get(r.orderHintId) ?? null) : null,
    receivedAt: r.receivedAt,
    source: r.source,
    status: r.status,
    refundNote: r.refundNote,
    createdById: r.createdById,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    allocations: (r.allocations ?? []).map((a) => ({
      id: a.id,
      orderId: a.orderId,
      orderNumber: orderNoById?.get(a.orderId) ?? null,
      amountCny: a.amountCny.toString(),
      createdById: a.createdById,
      createdAt: a.createdAt,
    })),
  };
}

export class ReceiptsService {
  private readonly paymentsService = new PaymentsService();

  // ════════════════════════════════════════════════════════════════════
  // 挂账池列表
  // ════════════════════════════════════════════════════════════════════
  async list(query: ListReceiptsQuery) {
    const where: Prisma.ReceiptWhereInput = {};
    if (query.status) where.status = query.status;
    // 认款工作台专用：只回未认完的，避免 take 500 被已认款记录占满挤出旧 OPEN 流水
    if (query.unallocatedOnly === '1') {
      where.status = { in: [ReceiptStatus.OPEN, ReceiptStatus.PARTIALLY_ALLOCATED] };
    }
    if (query.q) {
      where.OR = [
        { receiptNo: { contains: query.q, mode: 'insensitive' } },
        { payerNote: { contains: query.q, mode: 'insensitive' } },
        { orderHintId: { contains: query.q, mode: 'insensitive' } },
        { externalTxnId: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    // 疑似归属订单精确筛（订单详情「本单待认领」提示专用；与 q 的模糊匹配不同，这里是等值）
    if (query.orderHintId) where.orderHintId = query.orderHintId;
    // 到账日期闭区间（按流水交易日期字段 receivedAt，北京时）
    const receivedRange = beijingDayRange(query.from, query.to);
    if (receivedRange) where.receivedAt = receivedRange;
    const rows = await prisma.receipt.findMany({
      where,
      include: { allocations: true },
      orderBy: { receivedAt: 'desc' },
      take: 500,
    });
    // 认领明细 + 疑似归属订单一次批量换成订单号（不做 N+1）
    const orderNoById = await loadOrderNumbers([
      ...rows.flatMap((r) => r.allocations.map((a) => a.orderId)),
      ...rows.map((r) => r.orderHintId),
    ]);
    return rows.map((r) => serializeReceipt(r, orderNoById));
  }

  // ════════════════════════════════════════════════════════════════════
  // 总账（读时合并 Receipts + 近期订单 Payments）— 一处看所有进账，无写入
  // ════════════════════════════════════════════════════════════════════
  async ledger() {
    const RECENT_LIMIT = 300;
    const [receipts, payments] = await Promise.all([
      prisma.receipt.findMany({ orderBy: { receivedAt: 'desc' }, take: RECENT_LIMIT }),
      prisma.payment.findMany({
        where: { status: 'SUCCEEDED' },
        include: { order: { select: { orderNumber: true } } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_LIMIT,
      }),
    ]);

    const receiptEntries = receipts.map((r) => ({
      kind: 'RECEIPT' as const,
      id: r.id,
      ref: r.receiptNo,
      amountCny: r.amountCny.toString(),
      method: r.method,
      status: r.status as string,
      source: r.source as string,
      orderNo: null as string | null,
      at: r.receivedAt,
    }));
    const paymentEntries = payments.map((p) => ({
      kind: 'ORDER_PAYMENT' as const,
      id: p.id,
      ref: p.id,
      amountCny: p.amount.toString(),
      method: p.method,
      status: p.status as string,
      source: 'ORDER_PAYMENT',
      orderNo: p.order?.orderNumber ?? null,
      at: p.paidAt ?? p.createdAt,
    }));

    const entries = [...receiptEntries, ...paymentEntries].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    return { entries };
  }

  // ════════════════════════════════════════════════════════════════════
  // 登记新进账（财务后台）→ OPEN Receipt
  // ════════════════════════════════════════════════════════════════════
  async register(input: RegisterReceiptInput, actor: { userId: string; role: UserRole }) {
    const receipt = await prisma.$transaction((tx) =>
      createOpenReceiptWithinTx(tx, {
        amountCny: input.amountCny,
        method: input.method,
        source: ReceiptSource.STAFF_ENTRY,
        proofUrl: input.proofUrl ?? null,
        payerNote: input.payerNote ?? null,
        orderHintId: input.orderHintId ?? null,
        receivedAt: input.receivedAt,
        createdById: actor.userId,
      }),
    );
    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'REGISTER_RECEIPT',
      targetType: 'SYSTEM',
      targetId: receipt.id,
      targetLabel: receipt.receiptNo,
      after: { amountCny: receipt.amountCny.toString(), method: receipt.method, source: receipt.source },
      severity: 'WARNING',
    });
    const orderNoById = await loadOrderNumbers([receipt.orderHintId]);
    return serializeReceipt({ ...receipt, allocations: [] }, orderNoById);
  }

  // ════════════════════════════════════════════════════════════════════
  // 认领进账到订单（原子，全有或全无）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 把一笔进账的 amountCny 认领到 orderId：
   *   一个事务里：进账行锁 → 校验 amount ≤ remaining → 复用人工确认收款入账内核给订单加钱
   *   （Order.paidAmount + 全额自动翻 PAID + 状态事件）→ 写 ReceiptAllocation →
   *   receipt.allocatedCny += amount → 重算 status（OPEN→PARTIALLY_ALLOCATED→ALLOCATED）。
   * 任一步失败整体回滚。超额（amount > remaining）/ 订单不存在 → 拒绝。
   */
  async allocate(
    receiptId: string,
    input: AllocateReceiptInput,
    actor: { userId: string; role: UserRole },
  ) {
    const apply = round2(input.amountCny);
    if (apply <= 0) throw new BadRequestError('认领金额必须大于 0');

    const pendingFulfillmentTaskIds: string[] = [];

    const result = await prisma.$transaction(async (tx) => {
      // 进账行锁 + 事务内读最新 allocated（防并发重复认领把同一笔钱认两次）
      const rows = await tx.$queryRaw<
        Array<{ id: string; receiptNo: string; amountCny: Prisma.Decimal; allocatedCny: Prisma.Decimal; method: PaymentMethod; status: ReceiptStatus; proofUrl: string | null; externalTxnId: string | null }>
      >`SELECT id, "receiptNo", "amountCny", "allocatedCny", method, status, "proofUrl", "externalTxnId" FROM "Receipt" WHERE id = ${receiptId} FOR UPDATE`;
      const receipt = rows[0];
      if (!receipt) throw new NotFoundError('进账不存在');
      if (receipt.status === ReceiptStatus.REFUNDED) {
        throw new BadRequestError('该进账已退款，无法认领');
      }

      const amount = Number(receipt.amountCny);
      const allocated = Number(receipt.allocatedCny);
      const remaining = round2(amount - allocated);
      if (remaining <= 0) throw new BadRequestError('该进账已全部认领，无可认领余额');
      if (apply > remaining + 0.001) {
        throw new BadRequestError(
          `认领金额 ¥${apply.toFixed(2)} 超过进账剩余 ¥${remaining.toFixed(2)}，已拒绝`,
        );
      }

      // 先写认领明细、再入账：这样收款记录的 gatewayPayload 能带上 allocationId，
      // 「一笔认领 ↔ 一笔收款」一一对应，撤销时精确定位、不靠金额猜。
      // 两步同在本事务内，入账失败整体回滚，先写不会留下孤儿认领行。
      const allocation = await tx.receiptAllocation.create({
        data: {
          receiptId,
          orderId: input.orderId,
          amountCny: new Prisma.Decimal(apply),
          createdById: actor.userId,
        },
      });

      // 复用人工确认收款入账内核（同一行锁/上限/累加/PAID 翻转口径）
      const credit = await this.paymentsService._creditOrderPaymentWithinTx(
        tx,
        input.orderId,
        {
          amount: apply,
          method: receipt.method,
          proofUrl: receipt.proofUrl,
          note: `对账认领 ${receipt.receiptNo}`,
          // 结构化认款来源：把进账流水号一并写进收款记录（保留 note 兼容旧数据），
          // 订单序列化据此标注该行为「已认款 · 流水…」。
          reconciliation: {
            receiptNo: receipt.receiptNo,
            externalTxnId: receipt.externalTxnId,
            allocationId: allocation.id,
          },
        },
        actor,
        pendingFulfillmentTaskIds,
      );

      // 扣减剩余 + 重算状态
      const newAllocated = round2(allocated + apply);
      const newRemaining = round2(amount - newAllocated);
      const newStatus =
        newRemaining <= 0
          ? ReceiptStatus.ALLOCATED
          : ReceiptStatus.PARTIALLY_ALLOCATED;
      await tx.receipt.update({
        where: { id: receiptId },
        data: { allocatedCny: new Prisma.Decimal(newAllocated), status: newStatus },
      });

      return {
        receiptNo: receipt.receiptNo,
        allocatedAmount: apply,
        newAllocatedCny: newAllocated,
        remainingCny: newRemaining,
        receiptStatus: newStatus,
        order: credit,
      };
    });

    // 事务外 enqueue fulfillment（与 confirmManualPayment 同口径）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[receipts] failed to enqueue fulfillment task:', e);
        });
      }
    }

    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'ALLOCATE_RECEIPT',
      targetType: 'ORDER',
      targetId: input.orderId,
      targetLabel: result.order.orderNumber,
      after: {
        receiptNo: result.receiptNo,
        allocatedAmount: result.allocatedAmount,
        orderPaidAmount: result.order.paidAmount,
        orderFullyPaid: result.order.fullyPaid,
        orderStatus: result.order.status,
        receiptStatus: result.receiptStatus,
      },
      severity: 'CRITICAL',
    });

    return {
      ok: true as const,
      receiptId,
      receiptNo: result.receiptNo,
      allocatedAmount: result.allocatedAmount,
      remainingCny: result.remainingCny.toFixed(2),
      receiptStatus: result.receiptStatus,
      order: {
        orderId: input.orderId,
        orderNumber: result.order.orderNumber,
        paidAmount: result.order.paidAmount,
        total: result.order.total,
        fullyPaid: result.order.fullyPaid,
        status: result.order.status,
        paymentId: result.order.paymentId,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 批量认款（自动配对建议一键执行）— 纯编排，不改单笔语义
  // ════════════════════════════════════════════════════════════════════
  /**
   * 逐组复用 allocate 内核：每组一次独立事务 + 独立审计，全套校验（行锁/超额/退款拒绝）
   * 一字不动。某组失败（订单不存在/超额/并发已认完…）只记该组错误，不影响其它组——
   * 逐组回结果，前端据此提示「成功 N 组、失败 M 组（原因）」。
   * 不做任意流水↔订单的批量绑定：调用方只把「金额一对一吻合的建议组」传进来。
   */
  async allocateBatch(items: AllocateBatchInput['items'], actor: { userId: string; role: UserRole }) {
    const results: Array<
      | {
          ok: true;
          receiptId: string;
          orderId: string;
          receiptNo: string;
          orderNumber: string;
          allocatedAmount: number;
          receiptStatus: ReceiptStatus;
        }
      | { ok: false; receiptId: string; orderId: string; error: string }
    > = [];

    for (const item of items) {
      try {
        const r = await this.allocate(
          item.receiptId,
          { orderId: item.orderId, amountCny: item.amountCny },
          actor,
        );
        results.push({
          ok: true,
          receiptId: item.receiptId,
          orderId: item.orderId,
          receiptNo: r.receiptNo,
          orderNumber: r.order.orderNumber,
          allocatedAmount: r.allocatedAmount,
          receiptStatus: r.receiptStatus,
        });
      } catch (e: unknown) {
        results.push({
          ok: false,
          receiptId: item.receiptId,
          orderId: item.orderId,
          error: e instanceof Error ? e.message : '认款失败',
        });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return {
      ok: true as const,
      results,
      summary: { total: results.length, succeeded, failed: results.length - succeeded },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 撤销认款（认领的逆操作，原子、对称、留痕）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 把一笔已认领的钱从订单上撤回挂账池 —— allocate 的镜像。
   *
   * 一个事务里：进账行锁 → 取认领明细 → 订单行锁 + 撤销专用资金闸 → 定位当初入账生成的那笔收款
   * → 收款 CAS 冲销（SUCCEEDED→REFUNDED，幂等）→ 订单 paidAmount 减回 → 删认领明细
   * → 进账 allocatedCny 减回 + 状态重算（OPEN / PARTIALLY_ALLOCATED）。任一步失败整体回滚。
   *
   * 拒绝（宁可拒绝，也不出脏账）：
   *   - 进账已退款（REFUNDED）：剩余部分已按退款口径处置，再塞钱回来对不上退款金额。
   *   - 订单在撤销专用资金闸内（回收站 / 已退款 / 退款申请中）；取消族放行，
   *     因为撤销只是把钱退回挂账池，不减少公司总资金。
   *   - 订单收款已锁定（paymentsLocked）：财务复核已完成，先解锁再撤。
   *   - 找不到当初那笔收款 / 收款已不是 SUCCEEDED（已撤过）：无法对称回退 → 拒绝（重复撤销天然被此闸挡住）。
   *   - 撤销后订单已付会变负，或低于该单已完成退款额（账面倒挂）。
   *
   * 不动的东西（撤销只回退资金，不回退履约）：订单状态、佣金、履约任务保持原样。
   * 若撤销后订单由「已结清」变回「有尾款」，返回 warning 告知，由财务据实跟进
   *（与改期费加价后 PAID 单重新出现尾款是同一种既有状态，不是新脏账）。
   */
  async reverseAllocation(
    receiptId: string,
    allocationId: string,
    actor: { userId: string; role: UserRole },
  ) {
    const result = await prisma.$transaction(async (tx) => {
      // 进账行锁：与 allocate / refund 同一把锁，撤销与并发认领串行
      const rows = await tx.$queryRaw<
        Array<{ id: string; receiptNo: string; amountCny: Prisma.Decimal; allocatedCny: Prisma.Decimal; status: ReceiptStatus }>
      >`SELECT id, "receiptNo", "amountCny", "allocatedCny", status FROM "Receipt" WHERE id = ${receiptId} FOR UPDATE`;
      const receipt = rows[0];
      if (!receipt) throw new NotFoundError('进账不存在');
      if (receipt.status === ReceiptStatus.REFUNDED) {
        throw new BadRequestError(
          `进账 ${receipt.receiptNo} 已标记退款，剩余部分按退款口径处置过了，不能再撤销认款（撤回的钱与已退金额会对不上）。请人工核对后处理。`,
        );
      }

      const allocation = await tx.receiptAllocation.findUnique({ where: { id: allocationId } });
      // 已撤销的认领明细会被删除，重复撤销落在这里 → 幂等拒绝
      if (!allocation || allocation.receiptId !== receiptId) {
        throw new NotFoundError('认款记录不存在或已撤销');
      }
      const amount = round2(Number(allocation.amountCny));

      // 订单行锁 + 事务内读最新 paidAmount（与人工收款/认领/抵扣同一并发安全口径）
      const orderRows = await tx.$queryRaw<
        Array<{ id: string; orderNumber: string; total: Prisma.Decimal; adjustmentCny: number; paidAmount: Prisma.Decimal; prepaymentOffset: Prisma.Decimal; status: OrderStatus; deletedAt: Date | null; paymentsLocked: boolean }>
      >`SELECT id, "orderNumber", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt", "paymentsLocked" FROM "Order" WHERE id = ${allocation.orderId} FOR UPDATE`;
      const order = orderRows[0];
      if (!order) throw new NotFoundError('该认款对应的订单不存在');
      // 撤销专用闸：取消族放行，因为撤销只是把钱退回挂账池，不减少公司总资金。
      assertOrderAllowsFundsReversal(order, '撤销认款');
      if (order.paymentsLocked) {
        throw new ConflictError(
          `订单 ${order.orderNumber} 收款已锁定（财务复核完成），请先在订单收款区解锁再撤销认款`,
        );
      }

      // 定位当初入账生成的那笔收款；找不到 → 拒绝（不猜、不硬扣）
      const payment = await findAllocationPaymentWithinTx(tx, {
        allocationId,
        orderId: allocation.orderId,
        receiptNo: receipt.receiptNo,
        amount,
        allocatedAt: allocation.createdAt,
      });
      if (!payment) {
        throw new BadRequestError(
          `找不到本次认款在订单 ${order.orderNumber} 上生成的收款记录（可能已被撤销或人工调整过），无法对称撤销。请财务核对订单收款明细后处理。`,
        );
      }

      const paid = Number(order.paidAmount);
      const newPaid = round2(paid - amount);
      if (newPaid < -0.001) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 当前已付 ¥${paid.toFixed(2)}，不足以撤销本笔认款 ¥${amount.toFixed(2)}（撤销后会变负），已拒绝。`,
        );
      }
      // 已完成退款倒挂闸：撤销后「已付」不得低于「已退给客户」，否则账面上退出去的比收进来的多。
      const refundedTotal = await sumCompletedRefundsWithinTx(tx, order.id);
      if (refundedTotal > 0 && newPaid + 0.001 < refundedTotal) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 已完成退款 ¥${refundedTotal.toFixed(2)}，撤销本笔认款后已付将降到 ¥${Math.max(0, newPaid).toFixed(2)}，低于已退金额（账目倒挂），已拒绝。请先处理退款再撤销认款。`,
        );
      }

      // 已计提佣金闸：认款入账会把订单推到 PAID 并计提整条代理链佣金；撤销认款只减 paidAmount、
      // 不回退佣金，冲销后佣金会挂在一张已无实收依据的订单上照常结算。与 reverseManualPayment 同口径：
      // 净佣金 > 0（尚未冲销）即拒绝，请走退款流程让佣金按比例冲销。
      const commissionAgg = await tx.commissionRecord.aggregate({
        where: { orderId: order.id },
        _sum: { amount: true },
      });
      const commissionNet = round2(Number(commissionAgg._sum.amount ?? 0));
      if (commissionNet > 0.001) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 已计提代理佣金 ¥${commissionNet.toFixed(2)}（尚未冲销），` +
            `冲销认款会让佣金失去依据。请联系财务按退款流程处理。`,
        );
      }

      // 收款冲销：CAS 只动 SUCCEEDED —— 并发重复撤销/已被别处冲销过 → count≠1 直接拒绝。
      // 用 REFUNDED（枚举内唯一表示「这笔钱不再算这张单的实收」的终态）；总账只统计 SUCCEEDED，
      // 冲销后自然从订单实收与总账里退出，原始载荷 + 撤销痕迹一并留在 gatewayPayload 里可追溯。
      const basePayload =
        payment.gatewayPayload && typeof payment.gatewayPayload === 'object' && !Array.isArray(payment.gatewayPayload)
          ? (payment.gatewayPayload as Record<string, unknown>)
          : {};
      const cas = await tx.payment.updateMany({
        where: { id: payment.id, status: 'SUCCEEDED' },
        data: {
          status: 'REFUNDED',
          gatewayPayload: {
            ...basePayload,
            reversed: true,
            reversedAt: new Date().toISOString(),
            reversedBy: actor.userId,
            reversedAllocationId: allocationId,
            reversedReceiptNo: receipt.receiptNo,
          } as Prisma.InputJsonValue,
        },
      });
      if (cas.count !== 1) {
        throw new ConflictError('该笔认款已被撤销或状态已变更，请刷新后重试');
      }

      await tx.order.update({
        where: { id: order.id },
        data: { paidAmount: new Prisma.Decimal(Math.max(0, newPaid)) },
      });
      await tx.receiptAllocation.delete({ where: { id: allocationId } });

      // 进账剩余额回补 + 状态重算（与 allocate 的加法完全对称）
      const newAllocated = Math.max(0, round2(Number(receipt.allocatedCny) - amount));
      const newStatus =
        newAllocated <= 0.001 ? ReceiptStatus.OPEN : ReceiptStatus.PARTIALLY_ALLOCATED;
      await tx.receipt.update({
        where: { id: receiptId },
        data: { allocatedCny: new Prisma.Decimal(newAllocated), status: newStatus },
      });

      // 清账口径（与 serializeOrder.balanceDue / 收款内核一字一致）
      const effectivePayable = round2(Number(order.total) + order.adjustmentCny);
      const prepaymentOffset = Number(order.prepaymentOffset);
      const wasFullyPaid = paid + prepaymentOffset + 0.001 >= effectivePayable;
      const stillFullyPaid = newPaid + prepaymentOffset + 0.001 >= effectivePayable;

      return {
        receiptNo: receipt.receiptNo,
        reversedAmount: amount,
        newAllocatedCny: newAllocated,
        remainingCny: round2(Number(receipt.amountCny) - newAllocated),
        receiptStatus: newStatus,
        paymentId: payment.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        orderPaidAmount: Math.max(0, newPaid),
        orderBalanceDue: round2(effectivePayable - newPaid - prepaymentOffset),
        wasFullyPaid,
        stillFullyPaid,
      };
    });

    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'REVERSE_RECEIPT_ALLOCATION',
      targetType: 'ORDER',
      targetId: result.orderId,
      targetLabel: result.orderNumber,
      after: {
        receiptId,
        allocationId,
        receiptNo: result.receiptNo,
        reversedAmount: result.reversedAmount,
        paymentId: result.paymentId,
        orderPaidAmount: result.orderPaidAmount,
        orderBalanceDue: result.orderBalanceDue,
        orderStatus: result.orderStatus,
        receiptStatus: result.receiptStatus,
        wasFullyPaid: result.wasFullyPaid,
        stillFullyPaid: result.stillFullyPaid,
      },
      severity: 'CRITICAL',
    });

    return {
      ok: true as const,
      receiptId,
      allocationId,
      receiptNo: result.receiptNo,
      reversedAmount: result.reversedAmount,
      remainingCny: result.remainingCny.toFixed(2),
      receiptStatus: result.receiptStatus,
      order: {
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        paidAmount: result.orderPaidAmount,
        balanceDue: result.orderBalanceDue,
        status: result.orderStatus,
        stillFullyPaid: result.stillFullyPaid,
      },
      // 撤销只回退资金，不回退订单状态/佣金/履约。由「已结清」变回「有尾款」时明说，让财务跟进。
      warning:
        result.wasFullyPaid && !result.stillFullyPaid
          ? `订单 ${result.orderNumber} 撤销后重新产生尾款 ¥${result.orderBalanceDue.toFixed(2)}，订单状态仍为原状态（佣金与履约任务不回退），请据实跟进收款。`
          : null,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 退款剩余未认领部分（已认领部分留在各自订单上）
  // ════════════════════════════════════════════════════════════════════
  async refund(receiptId: string, note: string, actor: { userId: string; role: UserRole }) {
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; receiptNo: string; amountCny: Prisma.Decimal; allocatedCny: Prisma.Decimal; status: ReceiptStatus }>
      >`SELECT id, "receiptNo", "amountCny", "allocatedCny", status FROM "Receipt" WHERE id = ${receiptId} FOR UPDATE`;
      const receipt = rows[0];
      if (!receipt) throw new NotFoundError('进账不存在');
      if (receipt.status === ReceiptStatus.REFUNDED) {
        throw new BadRequestError('该进账已退款');
      }
      const remaining = round2(Number(receipt.amountCny) - Number(receipt.allocatedCny));
      if (remaining <= 0) {
        throw new BadRequestError('该进账无剩余未认领部分，无可退款');
      }
      await tx.receipt.update({
        where: { id: receiptId },
        data: { status: ReceiptStatus.REFUNDED, refundNote: note },
      });
      return { receiptNo: receipt.receiptNo, refundedRemaining: remaining };
    });

    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'REFUND_RECEIPT',
      targetType: 'SYSTEM',
      targetId: receiptId,
      targetLabel: result.receiptNo,
      after: { refundedRemaining: result.refundedRemaining, note },
      severity: 'CRITICAL',
    });

    return {
      ok: true as const,
      receiptId,
      receiptNo: result.receiptNo,
      refundedRemainingCny: result.refundedRemaining.toFixed(2),
      status: ReceiptStatus.REFUNDED,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 客户上传付款凭证（公开，已通过订单门禁）→ 仅「声明」，不入账
  // ════════════════════════════════════════════════════════════════════
  /**
   * 客户在前台上传付款凭证：建一笔 OPEN Receipt（source=CUSTOMER_UPLOAD，orderHintId=命中订单），
   * 仅作为「声明」进挂账池——绝不直接给订单加钱（必须由财务在对账台认领后才入账）。
   * 调用前路由层已用 orderNo + lookupKey 校验过门禁。
   */
  async customerUpload(input: {
    orderId: string;
    amountCny: number;
    method: PaymentMethod;
    proofUrl: string;
    payerNote?: string | null;
  }) {
    const receipt = await prisma.$transaction((tx) =>
      createOpenReceiptWithinTx(tx, {
        amountCny: input.amountCny,
        method: input.method,
        source: ReceiptSource.CUSTOMER_UPLOAD,
        proofUrl: input.proofUrl,
        payerNote: input.payerNote ?? null,
        orderHintId: input.orderId,
        createdById: null, // 客户上传，无后台账号
      }),
    );
    void writeAudit({
      actor: { role: 'SYSTEM', label: 'public:receipt-upload' },
      action: 'CUSTOMER_UPLOAD_RECEIPT',
      targetType: 'ORDER',
      targetId: input.orderId,
      targetLabel: receipt.receiptNo,
      after: {
        receiptNo: receipt.receiptNo,
        amountCny: receipt.amountCny.toString(),
        method: receipt.method,
      },
      severity: 'WARNING',
    });
    // 只回执轻量信息：是「声明」未入账，不回任何订单内部字段
    return {
      ok: true as const,
      receiptId: receipt.id,
      receiptNo: receipt.receiptNo,
      amountCny: receipt.amountCny.toString(),
      status: receipt.status,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 二维码流水导入：解析预览（不写库）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 解析收单平台流水 xlsx → 预览行 + 处置判定。
   * 行内判定（parseStatementXlsx）之外，再对照现库：已存在同 externalTxnId 的行
   * 标 dup_in_db 并附现有进账号/认款状态——重复导入天然幂等，已认过的行状态不丢。
   */
  async previewStatement(fileBase64: string, platform: StatementPlatform = 'CMB_QR') {
    const { rows, warnings } = await parseStatementXlsx(fileBase64, platform);
    const okIds = rows
      .filter((r) => r.disposition === 'ok')
      .map((r) => statementStorageExternalTxnId(platform, r.externalTxnId));
    const existing = okIds.length
      ? await prisma.receipt.findMany({
          where: { externalTxnId: { in: okIds } },
          select: { externalTxnId: true, receiptNo: true, status: true, amountCny: true },
        })
      : [];
    const byTxn = new Map(existing.map((e) => [e.externalTxnId as string, e]));

    const preview = rows.map((r) => {
      const storageTxnId = statementStorageExternalTxnId(platform, r.externalTxnId);
      const dbHit = r.disposition === 'ok' ? byTxn.get(storageTxnId) : undefined;
      // 同流水号但金额与库中不一致 = 数据冲突（平台改单/人为改表），必须显式亮出来，
      // 不能只报「已存在」让财务误以为无事发生（审计发现#3）
      const amountMismatch =
        dbHit != null &&
        r.amountCny != null &&
        Math.abs(Number(dbHit.amountCny) - r.amountCny) >= 0.005;
      return {
        rowNumber: r.rowNumber,
        externalTxnId: r.externalTxnId,
        receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
        amountCny: r.amountCny,
        method: r.method,
        rawMethod: r.rawMethod,
        rawStatus: r.rawStatus,
        payerNote: r.payerNote,
        disposition: dbHit ? ('dup_in_db' as const) : r.disposition,
        existing: dbHit
          ? {
              receiptNo: dbHit.receiptNo,
              status: dbHit.status,
              amountCny: dbHit.amountCny.toString(),
              amountMismatch,
            }
          : null,
      };
    });

    const count = (d: string) => preview.filter((r) => r.disposition === d).length;
    return {
      rows: preview,
      warnings,
      summary: {
        total: preview.length,
        importable: count('ok'),
        dupInDb: count('dup_in_db'),
        dupInFile: count('dup_in_file'),
        skippedStatus: count('skipped_status'),
        skippedType: count('skipped_type'),
        invalid: count('invalid'),
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 二维码流水导入：入库（createMany + skipDuplicates，流水号唯一索引兜底）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 把预览确认后的流水行入池（source=STATEMENT_IMPORT，status=OPEN）。
   * 防重三层：请求内去重 → 预查现库剔除 → createMany skipDuplicates 靠
   * externalTxnId 唯一索引兜底（并发导入也绝不重复入池）。
   */
  async importStatement(input: ImportStatementInput, actor: { userId: string; role: UserRole }) {
    const rowsWithStorageIds = input.rows.map((r) => ({
      ...r,
      externalTxnId: statementStorageExternalTxnId(input.platform, r.externalTxnId),
    }));
    const seen = new Set<string>();
    const unique = rowsWithStorageIds.filter((r) =>
      seen.has(r.externalTxnId) ? false : (seen.add(r.externalTxnId), true),
    );

    const existing = await prisma.receipt.findMany({
      where: { externalTxnId: { in: unique.map((r) => r.externalTxnId) } },
      select: { externalTxnId: true },
    });
    const existingSet = new Set(existing.map((e) => e.externalTxnId));
    const fresh = unique.filter((r) => !existingSet.has(r.externalTxnId));

    const data = await Promise.all(
      fresh.map(async (r) => ({
        receiptNo: await generateReceiptNo(),
        amountCny: new Prisma.Decimal(round2(r.amountCny)),
        allocatedCny: new Prisma.Decimal(0),
        method: r.method,
        source: ReceiptSource.STATEMENT_IMPORT,
        status: ReceiptStatus.OPEN,
        payerNote: r.payerNote ?? null,
        externalTxnId: r.externalTxnId,
        receivedAt: r.receivedAt,
        createdById: actor.userId,
      })),
    );
    const created = data.length
      ? await prisma.receipt.createMany({ data, skipDuplicates: true })
      : { count: 0 };

    void writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'IMPORT_RECEIPT_STATEMENT',
      targetType: 'SYSTEM',
      targetId: 'receipt-statement-import',
      targetLabel: '二维码流水导入',
      after: { requested: input.rows.length, imported: created.count },
      severity: 'WARNING',
    });

    return {
      ok: true as const,
      requested: input.rows.length,
      imported: created.count,
      skipped: input.rows.length - created.count,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 认款工作台：待收款订单候选（近 400 单里尾款 > 0 的，最多回 200）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 尾款 = total + adjustmentCny − paidAmount − prepaymentOffset（与
   * serializeOrder.balanceDue 一字一致）；排除草稿/取消/已退/超时单。
   * 只回轻量字段供工作台配对展示，不含乘客明细。
   */
  async matchCandidates(query: MatchCandidatesQuery = {}) {
    // 下单日期闭区间（createdAt，北京时）+ 关键词（订单号 / 联系人 / 代理名）服务端过滤：
    // 都在 take 400 之前收窄，关键词命中不再受「近 400 单」窗口限制（财务反馈的「搜不到旧单」）。
    const createdRange = beijingDayRange(query.from, query.to);
    const q = query.q?.trim();
    const orders = await prisma.order.findMany({
      where: {
        // 与收款资金闸同源（FUNDS_CREDIT_BLOCKED_STATUSES）：候选规则和入账内核
        // 用同一张状态名单，不会出现「工作台推荐了、点认款却被资金闸拒」的漂移；
        // 软删单（回收站）同样排除——入账内核会拒，不该出现在候选里。
        status: { notIn: FUNDS_CREDIT_BLOCKED_STATUSES },
        deletedAt: null,
        ...(createdRange ? { createdAt: createdRange } : {}),
        ...(q
          ? {
              OR: [
                { orderNumber: { contains: q, mode: 'insensitive' } },
                { contactName: { contains: q, mode: 'insensitive' } },
                { agent: { companyName: { contains: q, mode: 'insensitive' } } },
                { agent: { contactName: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        orderNumber: true,
        contactName: true,
        status: true,
        createdAt: true,
        total: true,
        paidAmount: true,
        prepaymentOffset: true,
        adjustmentCny: true,
        agent: { select: { companyName: true, contactName: true } },
        // 出发日期展示用：去程 = 最早 FLIGHT 行出发时间，纯签证/酒店单回落最早入住日。
        items: {
          select: {
            kind: true,
            hotelCheckIn: true,
            flightSchedule: { select: { departureTime: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 400,
    });

    const out: Array<{
      orderId: string;
      orderNumber: string;
      contactName: string;
      agentName: string | null;
      status: OrderStatus;
      createdAt: Date;
      totalPayable: number;
      paidAmount: number;
      balanceDue: number;
      departureDate: string | null;
    }> = [];
    for (const o of orders) {
      const totalPayable = round2(Number(o.total) + (o.adjustmentCny ?? 0));
      const balanceDue = round2(
        totalPayable - Number(o.paidAmount) - Number(o.prepaymentOffset),
      );
      if (balanceDue <= 0.005) continue;
      out.push({
        orderId: o.id,
        orderNumber: o.orderNumber,
        contactName: o.contactName,
        agentName: o.agent ? o.agent.companyName || o.agent.contactName : null,
        status: o.status,
        createdAt: o.createdAt,
        totalPayable,
        paidAmount: Number(o.paidAmount),
        balanceDue,
        departureDate: orderDepartDate(o.items),
      });
      if (out.length >= 200) break;
    }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════
  // 流水核对表导出（进账 + 认款标识，替代财务线下勾表）
  // ════════════════════════════════════════════════════════════════════
  async exportStatement(query: ExportStatementQuery) {
    const where: Prisma.ReceiptWhereInput = {};
    if (query.from || query.to) {
      where.receivedAt = {
        ...(query.from ? { gte: new Date(`${query.from}T00:00:00+08:00`) } : {}),
        ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999+08:00`) } : {}),
      };
    }
    // 全量分页读取：绝不静默截断——核对表少一行，财务就会把那笔钱当作不存在（审计发现#4）。
    // 单页 1000 条循环取完；上限 50000 条纯属防失控（远超当前业务量），触顶报错而非截断。
    const EXPORT_PAGE = 1000;
    const EXPORT_HARD_CAP = 50_000;
    type ReceiptWithAllocs = Prisma.ReceiptGetPayload<{ include: { allocations: true } }>;
    const receipts: ReceiptWithAllocs[] = [];
    for (;;) {
      const page = await prisma.receipt.findMany({
        where,
        include: { allocations: true },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: receipts.length,
        take: EXPORT_PAGE,
      });
      receipts.push(...page);
      if (page.length < EXPORT_PAGE) break;
      if (receipts.length >= EXPORT_HARD_CAP) {
        throw new BadRequestError(
          `导出条数超过 ${EXPORT_HARD_CAP} 上限，请用「从/到」缩小日期区间后再导`,
        );
      }
    }

    const orderNoById = await loadOrderNumbers(
      receipts.flatMap((r) => r.allocations.map((a) => a.orderId)),
    );

    const userIds = [
      ...new Set(
        receipts.flatMap((r) => r.allocations.map((a) => a.createdById)).filter(Boolean),
      ),
    ] as string[];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, email: true },
        })
      : [];
    const nameById = new Map(
      users.map((u) => [u.id, u.displayName || u.email || u.id.slice(0, 8)]),
    );

    const METHOD_LABEL: Record<PaymentMethod, string> = {
      WECHAT_PAY: '微信',
      ALIPAY: '支付宝',
      BANK_CARD: '银行卡',
      AGENT_PREPAYMENT: '代理预存',
    };
    const SOURCE_LABEL: Record<ReceiptSource, string> = {
      CUSTOMER_UPLOAD: '客户上传',
      STAFF_ENTRY: '后台登记',
      ORDER_OVERPAY: '订单多付',
      STATEMENT_IMPORT: '流水导入',
    };
    const STATUS_LABEL: Record<ReceiptStatus, string> = {
      OPEN: '未认款',
      PARTIALLY_ALLOCATED: '部分认款',
      ALLOCATED: '已认款',
      REFUNDED: '已退款',
    };

    const entries: StatementExportEntry[] = receipts.map((r) => {
      const allocs = [...r.allocations].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const allocationsText = allocs
        .map(
          (a) =>
            `${orderNoById.get(a.orderId) ?? a.orderId.slice(0, 8)} ¥${Number(a.amountCny).toFixed(2)}`,
        )
        .join('；');
      const allocatorNames = [
        ...new Set(
          allocs
            .map((a) => (a.createdById ? nameById.get(a.createdById) : null))
            .filter(Boolean),
        ),
      ].join('、');
      const amount = Number(r.amountCny);
      const allocated = Number(r.allocatedCny);
      return {
        receivedAt: r.receivedAt,
        externalTxnId: r.externalTxnId,
        receiptNo: r.receiptNo,
        amountCny: amount,
        methodLabel: METHOD_LABEL[r.method],
        sourceLabel: SOURCE_LABEL[r.source],
        statusLabel: STATUS_LABEL[r.status],
        allocatedCny: allocated,
        remainingCny: round2(amount - allocated),
        allocationsText,
        lastAllocatedAt: allocs.length > 0 ? allocs[allocs.length - 1].createdAt : null,
        allocatorNames,
        payerNote: r.payerNote,
        refundNote: r.refundNote,
      };
    });

    return buildStatementExportWorkbook(entries);
  }
}
