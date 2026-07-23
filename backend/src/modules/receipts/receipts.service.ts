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
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { FUNDS_CREDIT_BLOCKED_STATUSES } from '../../lib/funds-guard.js';
import { writeAudit } from '../../lib/audit.js';
import { PaymentsService } from '../payments/payments.service.js';
import { earliestFlightDeparture } from '../orders/pnr-export.js';
import type {
  AllocateReceiptInput,
  ExportStatementQuery,
  ImportStatementInput,
  ListReceiptsQuery,
  RegisterReceiptInput,
} from './receipts.schemas.js';
import {
  parseStatementXlsx,
  buildStatementExportWorkbook,
  type StatementExportEntry,
} from './receipts.statement.js';

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
    externalTxnId: r.externalTxnId,
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

  // ════════════════════════════════════════════════════════════════════
  // 二维码流水导入：解析预览（不写库）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 解析收单平台流水 xlsx → 预览行 + 处置判定。
   * 行内判定（parseStatementXlsx）之外，再对照现库：已存在同 externalTxnId 的行
   * 标 dup_in_db 并附现有进账号/认款状态——重复导入天然幂等，已认过的行状态不丢。
   */
  async previewStatement(fileBase64: string) {
    const { rows, warnings } = await parseStatementXlsx(fileBase64);
    const okIds = rows.filter((r) => r.disposition === 'ok').map((r) => r.externalTxnId);
    const existing = okIds.length
      ? await prisma.receipt.findMany({
          where: { externalTxnId: { in: okIds } },
          select: { externalTxnId: true, receiptNo: true, status: true, amountCny: true },
        })
      : [];
    const byTxn = new Map(existing.map((e) => [e.externalTxnId as string, e]));

    const preview = rows.map((r) => {
      const dbHit = r.disposition === 'ok' ? byTxn.get(r.externalTxnId) : undefined;
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
    const seen = new Set<string>();
    const unique = input.rows.filter((r) =>
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
  async matchCandidates() {
    const orders = await prisma.order.findMany({
      where: {
        // 与收款资金闸同源（FUNDS_CREDIT_BLOCKED_STATUSES）：候选规则和入账内核
        // 用同一张状态名单，不会出现「工作台推荐了、点认款却被资金闸拒」的漂移；
        // 软删单（回收站）同样排除——入账内核会拒，不该出现在候选里。
        status: { notIn: FUNDS_CREDIT_BLOCKED_STATUSES },
        deletedAt: null,
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

    const orderIds = [...new Set(receipts.flatMap((r) => r.allocations.map((a) => a.orderId)))];
    const orders = orderIds.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNumber: true },
        })
      : [];
    const orderNoById = new Map(orders.map((o) => [o.id, o.orderNumber]));

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
