/**
 * 收款对账台 / 挂账池服务（Receipts / Suspense pool）。
 *
 * 业务：公司用统一收款码收钱，财务在后台手动对账。
 *   - 登记进账（register）→ OPEN Receipt 进挂账池
 *   - 认领（allocate）→ 把进账的钱记到某订单（复用人工确认收款入账内核，原子）
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
  PaymentMethod,
  ReceiptSource,
  ReceiptStatus,
  UserRole,
  type Receipt,
  type ReceiptAllocation,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { PaymentsService } from '../payments/payments.service.js';
import type {
  AllocateReceiptInput,
  ListReceiptsQuery,
  RegisterReceiptInput,
} from './receipts.schemas.js';

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
    },
  });
}

type ReceiptWithAllocations = Receipt & { allocations: ReceiptAllocation[] };

/** 进账序列化（含 remaining + 认领明细汇总），字段名即前端读取口径。 */
export function serializeReceipt(r: ReceiptWithAllocations) {
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
    orderHintId: r.orderHintId,
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
    if (query.q) {
      where.OR = [
        { receiptNo: { contains: query.q, mode: 'insensitive' } },
        { payerNote: { contains: query.q, mode: 'insensitive' } },
        { orderHintId: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    const rows = await prisma.receipt.findMany({
      where,
      include: { allocations: true },
      orderBy: { receivedAt: 'desc' },
      take: 500,
    });
    return rows.map(serializeReceipt);
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
    return serializeReceipt({ ...receipt, allocations: [] });
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
        Array<{ id: string; receiptNo: string; amountCny: Prisma.Decimal; allocatedCny: Prisma.Decimal; method: PaymentMethod; status: ReceiptStatus; proofUrl: string | null }>
      >`SELECT id, "receiptNo", "amountCny", "allocatedCny", method, status, "proofUrl" FROM "Receipt" WHERE id = ${receiptId} FOR UPDATE`;
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

      // 复用人工确认收款入账内核（同一行锁/上限/累加/PAID 翻转口径）
      const credit = await this.paymentsService._creditOrderPaymentWithinTx(
        tx,
        input.orderId,
        {
          amount: apply,
          method: receipt.method,
          proofUrl: receipt.proofUrl,
          note: `对账认领 ${receipt.receiptNo}`,
        },
        actor,
        pendingFulfillmentTaskIds,
      );

      // 写认领明细
      await tx.receiptAllocation.create({
        data: {
          receiptId,
          orderId: input.orderId,
          amountCny: new Prisma.Decimal(apply),
          createdById: actor.userId,
        },
      });

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
}
