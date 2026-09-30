import { OrderStatus, Prisma, PrepaymentTxType, RefundStatus } from '@prisma/client';

import { sumCompletedRefundsWithinTx } from '../../lib/funds-guard.js';
import { netReceivedCny } from '../../lib/net-received.js';

/**
 * 已付款族订单「钱已撤干净」时的直接取消（运营需求：撤销了到账还是取消不了）。
 *
 * 背景：状态机里 CANCELLED 只能从待支付/超时/失败进入，已付款族（已支付 / 处理中 / 出票完成 /
 * 改期申请中 / 已改期）只能走「退款申请中」——那是给「钱在单上、要退出去」设计的通道。
 * 可「撤销到账」刻意不改订单状态（见 payments.service reverseManualPayment），于是钱撤光的单
 * 仍停在已支付：走退款通道没钱可退（退款申请要有应退额），直接取消又被状态机拦下，只能找管理员强制。
 *
 * 口径（已拍板）：已付款族订单**当且仅当**
 *   1. 本单净收款 ≤ 0（已收净额 = paidAmount + prepaymentOffset − 已完成退款，唯一口径见 lib/net-received）；
 *   2. 没有进行中的退款（Refund 处于 REQUESTED / APPROVED / PROCESSING）；
 *   3. 代理预存余额抵扣已全部退回余额（PrepaymentTransaction 流水：|Σ OFFSET| − Σ REFUND ≤ 0）——
 *      抵扣额当时已累加进 paidAmount，正常情况下第 1 条就拦住了；这里按流水再兜一道，
 *      防「多付转出 + 撤销现金到账」把 paidAmount 压到 0 而余额抵扣还挂着：此时直接取消，
 *      代理那笔余额就再也回不来了（取消不回补余额，只有批准退款才回补）。
 * 三条全满足才允许运营/管理员不带强制地改为「已取消」。只要还有一分钱挂在单上就不放行，提示走退款/换人。
 *
 * 取消的副作用与既有取消路径完全同一条（_updateStatusWithinTx 的 CANCELLED 分支）：
 * 释放未起飞航段座位、房控占房随状态释放、履约任务终态化、佣金整单冲销、权益核销冲正、审计。
 */
export const PAID_FAMILY_DIRECT_CANCEL_FROM: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 进行中（未完结）的退款状态：钱还没退完、也没被驳回。 */
export const OPEN_REFUND_STATUSES: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.APPROVED,
  RefundStatus.PROCESSING,
];

type MoneyLike = Prisma.Decimal | number | null | undefined;

export interface PaidDirectCancelFacts {
  status: OrderStatus;
  paidAmount: MoneyLike;
  prepaymentOffset?: MoneyLike;
  /** 已完成退款合计（Refund.status=COMPLETED） */
  completedRefundsCny: number;
  /** 进行中退款条数（OPEN_REFUND_STATUSES） */
  openRefundCount: number;
  /** 代理预存余额抵扣尚未退回的额度 = |Σ OFFSET| − Σ REFUND（流水口径） */
  balanceOffsetOutstandingCny: number;
}

export type PaidDirectCancelVerdict = { ok: true } | { ok: false; reason: string };

const EPSILON = 0.001;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isPaidFamilyDirectCancelSource(status: OrderStatus): boolean {
  return PAID_FAMILY_DIRECT_CANCEL_FROM.includes(status);
}

/** 纯判定：给定本单的钱口径事实，能不能直接取消；不能就给出面向运营的中文原因。 */
export function assessPaidDirectCancel(facts: PaidDirectCancelFacts): PaidDirectCancelVerdict {
  if (!isPaidFamilyDirectCancelSource(facts.status)) {
    return { ok: false, reason: '当前状态不适用「钱已撤干净直接取消」' };
  }
  if (facts.openRefundCount > 0) {
    return {
      ok: false,
      reason:
        `本单有 ${facts.openRefundCount} 条进行中的退款申请，不能直接取消。` +
        '请先由财务批准或驳回退款申请，再处理订单。',
    };
  }
  const net = netReceivedCny(facts, facts.completedRefundsCny);
  if (net > EPSILON) {
    return {
      ok: false,
      reason:
        `本单还有净收款 ¥${net.toFixed(2)} 挂在单上，不能直接取消——钱要走退款：` +
        '请用「取消订单」发起退款申请（或走换人退款）；若是到账录错了，先撤销到账再取消。',
    };
  }
  const outstanding = round2(facts.balanceOffsetOutstandingCny);
  if (outstanding > EPSILON) {
    return {
      ok: false,
      reason:
        `本单用代理预存余额抵扣的 ¥${outstanding.toFixed(2)} 尚未退回余额，直接取消这笔余额就回不来了。` +
        '请先由财务结清或冲回该笔余额抵扣，再取消。',
    };
  }
  return { ok: true };
}

type DirectCancelDb = Pick<Prisma.TransactionClient, 'refund' | 'prepaymentTransaction'>;

/** 按流水算余额抵扣未退回额：|Σ OFFSET| − Σ REFUND（与批准退款时的回补口径同源）。 */
function outstandingFromLedger(rows: ReadonlyArray<{ type: PrepaymentTxType; amount: MoneyLike }>): number {
  let offsetGross = 0;
  let restored = 0;
  for (const row of rows) {
    const amount = row.amount == null ? 0 : Number(row.amount.toString());
    if (row.type === PrepaymentTxType.OFFSET) offsetGross += Math.abs(amount);
    else if (row.type === PrepaymentTxType.REFUND) restored += amount;
  }
  return Math.max(0, round2(offsetGross - restored));
}

/**
 * 单单判定（状态流转事务内用）。调用方须先对 Order 行 FOR UPDATE 并传入锁内读到的 paidAmount，
 * 与人工收款 / 认款 / 余额抵扣（都先锁 Order 行再累加 paidAmount）串行，不会读到旧快照放行。
 */
export async function assessPaidDirectCancelWithinTx(
  tx: DirectCancelDb,
  order: { id: string; status: OrderStatus; paidAmount: MoneyLike; prepaymentOffset?: MoneyLike },
): Promise<PaidDirectCancelVerdict> {
  const [completedRefundsCny, openRefundCount, ledger] = await Promise.all([
    sumCompletedRefundsWithinTx(tx as Prisma.TransactionClient, order.id),
    tx.refund.count({ where: { orderId: order.id, status: { in: [...OPEN_REFUND_STATUSES] } } }),
    tx.prepaymentTransaction.findMany({
      where: {
        orderId: order.id,
        type: { in: [PrepaymentTxType.OFFSET, PrepaymentTxType.REFUND] },
      },
      select: { type: true, amount: true },
    }),
  ]);
  return assessPaidDirectCancel({
    status: order.status,
    paidAmount: order.paidAmount,
    prepaymentOffset: order.prepaymentOffset,
    completedRefundsCny,
    openRefundCount,
    balanceOffsetOutstandingCny: outstandingFromLedger(ledger),
  });
}

/** 批量判定的入参：订单若已联查了 refunds（详情 include 全量），直接用，不再发退款聚合。 */
export interface PaidDirectCancelCandidate {
  id: string;
  status: OrderStatus;
  paidAmount: MoneyLike;
  prepaymentOffset?: MoneyLike;
  refunds?: ReadonlyArray<{ status: RefundStatus; amount: MoneyLike }>;
}

/**
 * 批量判定（列表 / 详情下发 allowedTransitions 用）：返回可直接取消的订单 id 集合。
 *
 * 性能：列表一次最多 200 行，这里最多两条查询、且只在需要时才发：
 *   · 只看已付款族的行，没有就零查询；
 *   · 退款：已联查 refunds 的行（详情）直接用；其余按 (orderId, status) 聚合一条
 *    （Refund.orderId 有索引，已付款族的单几乎都没有退款行）；
 *   · 余额抵扣流水只查「净收款已 ≤ 0 且无进行中退款」的幸存行（通常一行都没有 → 不发）。
 */
export async function findPaidDirectCancelEligibleIds(
  db: DirectCancelDb,
  orders: ReadonlyArray<PaidDirectCancelCandidate>,
): Promise<Set<string>> {
  const eligible = new Set<string>();
  const candidates = orders.filter((o) => isPaidFamilyDirectCancelSource(o.status));
  if (candidates.length === 0) return eligible;

  const completedByOrder = new Map<string, number>();
  const openCountByOrder = new Map<string, number>();
  const addRefund = (orderId: string, status: RefundStatus, amount: number, count: number): void => {
    if (status === RefundStatus.COMPLETED) {
      completedByOrder.set(orderId, round2((completedByOrder.get(orderId) ?? 0) + amount));
    } else if (OPEN_REFUND_STATUSES.includes(status)) {
      openCountByOrder.set(orderId, (openCountByOrder.get(orderId) ?? 0) + count);
    }
  };
  const toNum = (v: MoneyLike): number => (v == null ? 0 : Number(v.toString()));

  for (const o of candidates) {
    for (const r of o.refunds ?? []) addRefund(o.id, r.status, toNum(r.amount), 1);
  }
  const needRefundQuery = candidates.filter((o) => o.refunds === undefined).map((o) => o.id);
  if (needRefundQuery.length > 0) {
    const refundGroups = await db.refund.groupBy({
      by: ['orderId', 'status'],
      where: {
        orderId: { in: needRefundQuery },
        status: { in: [RefundStatus.COMPLETED, ...OPEN_REFUND_STATUSES] },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    for (const g of refundGroups) addRefund(g.orderId, g.status, toNum(g._sum.amount), g._count._all);
  }

  // 先按退款口径筛（余额抵扣未退回额置 0 占位），幸存者再查流水复核。
  const survivors = candidates.filter(
    (o) =>
      assessPaidDirectCancel({
        status: o.status,
        paidAmount: o.paidAmount,
        prepaymentOffset: o.prepaymentOffset,
        completedRefundsCny: completedByOrder.get(o.id) ?? 0,
        openRefundCount: openCountByOrder.get(o.id) ?? 0,
        balanceOffsetOutstandingCny: 0,
      }).ok,
  );
  if (survivors.length === 0) return eligible;

  const ledgerRows = await db.prepaymentTransaction.findMany({
    where: {
      orderId: { in: survivors.map((o) => o.id) },
      type: { in: [PrepaymentTxType.OFFSET, PrepaymentTxType.REFUND] },
    },
    select: { orderId: true, type: true, amount: true },
  });
  const ledgerByOrder = new Map<string, Array<{ type: PrepaymentTxType; amount: MoneyLike }>>();
  for (const row of ledgerRows) {
    if (!row.orderId) continue;
    const list = ledgerByOrder.get(row.orderId) ?? [];
    ledgerByOrder.set(row.orderId, [...list, { type: row.type, amount: row.amount }]);
  }
  for (const o of survivors) {
    if (outstandingFromLedger(ledgerByOrder.get(o.id) ?? []) <= EPSILON) eligible.add(o.id);
  }
  return eligible;
}
