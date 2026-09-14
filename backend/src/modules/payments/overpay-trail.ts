/**
 * 挂账去向（水单毛额 → 本单入账 → 转池 → 核销到哪几张单）—— 订单详情收款区的永久留痕。
 *
 * 背景（财务查账口径）：出纳拿水单对系统，一笔水单 2864 录进来，系统按应收把 2454 记进本单、
 * 410 自动拆进挂账池，之后 410 又被核销到另外三张单。订单页此前只显示本单净额 2454，
 * 拆分出去的 410 一旦核销完就从本单彻底消失，出纳对着水单永远对不上。
 *
 * 口径（2026-09-06 财务确认）：**已付金额不动**（改成毛额会让已付 > 应收，结清状态/应收报表/
 * 退款/催款全乱），改在收款行永久显示这笔水单的完整去向，核销后也一直留着。
 *
 * 三条数据线都在这里收拢：
 *   1) 手工收款超收拆分：Payment.gatewayPayload.overpaySplit 指向拆出的挂账进账；
 *   2) 「多付转挂账池」处置：负额对冲 Payment（source=overpay-disposal）新数据带 poolReceiptId；
 *   3) 兜底：凡 source=ORDER_OVERPAY 且 orderHintId=本单 的进账（含本单应收已满、整笔进池、
 *      没有 Payment 承接的情形，以及旧数据没埋 receiptId 的处置行），没被 1)/2) 认领的
 *      单列成 overpayReceipts，订单页照样能看到钱去了哪。
 *
 * 只给内部视角（ADMIN/STAFF）；代理/客户看不到挂账池，也不该看到别的订单号。
 */
import { Prisma, ReceiptSource, ReceiptStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { round2 } from '../../lib/commission-net.js';
import {
  OVERPAY_SPLIT_TXN_PREFIX,
  readOverpaySplitFromPayload,
  type OverpaySplitDetail,
} from './payments.service.js';

/** 挂账进账的一条核销去向（订单 / 占位单）。 */
export interface PoolAllocationTrail {
  /** 核销记录 id（排序稳定用：同一毫秒内连续核销靠它定序）。 */
  allocationId: string;
  kind: 'ORDER' | 'HOLD';
  /** 订单号 / 占位单号；查不到（已硬删）回落 null，前端显示 id 前 8 位。 */
  orderNumber: string | null;
  orderId: string | null;
  holdOrderId: string | null;
  amountCny: number;
  allocatedAt: Date;
}

/** 一笔挂账进账的完整去向：进了多少、还剩多少、核销到了谁、有没有退。 */
export interface PoolTrail {
  receiptId: string;
  receiptNo: string;
  /** 转入挂账池的金额（= Receipt.amountCny）。 */
  pooledAmount: number;
  receiptStatus: ReceiptStatus;
  /** 还挂在池子里没核销的余额；已退款行恒 0（与对账台同口径）。 */
  remainingCny: number;
  refundNote: string | null;
  receivedAt: Date;
  payerNote: string | null;
  allocations: PoolAllocationTrail[];
}

/** 收款行上挂的拆分去向：录入毛额 / 本单入账 / 转池 + 池子那笔的去向。 */
export interface OverpaySplitTrail extends OverpaySplitDetail {
  pool: PoolTrail | null;
}

type ReceiptRow = Prisma.ReceiptGetPayload<{ include: { allocations: true; holdAllocations: true } }>;

/** 从「多付转挂账池」处置行载荷里读它建的那笔进账 id（新数据才有；旧数据 null）。 */
function readDisposalPoolReceiptId(payload: Prisma.JsonValue | null): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.source !== 'overpay-disposal') return null;
  return typeof p.poolReceiptId === 'string' ? p.poolReceiptId : null;
}

/** 批量把订单/占位单 id 换成单号（一次 IN 查询，不做 N+1）。 */
async function loadNumbers(receipts: ReceiptRow[]): Promise<{
  orderNoById: Map<string, string>;
  holdNoById: Map<string, string>;
}> {
  const orderIds = [...new Set(receipts.flatMap((r) => r.allocations.map((a) => a.orderId)))];
  const holdIds = [
    ...new Set(receipts.flatMap((r) => r.holdAllocations.filter((a) => !a.reversedAt).map((a) => a.holdOrderId))),
  ];
  const [orders, holds] = await Promise.all([
    orderIds.length
      ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } })
      : Promise.resolve([]),
    holdIds.length
      ? prisma.holdOrder.findMany({ where: { id: { in: holdIds } }, select: { id: true, holdNo: true } })
      : Promise.resolve([]),
  ]);
  return {
    orderNoById: new Map(orders.map((o) => [o.id, o.orderNumber])),
    holdNoById: new Map(holds.map((h) => [h.id, h.holdNo])),
  };
}

/** 单笔进账 → 去向留痕。allocations 按核销时间正序，占位单撤销过的行不算。 */
export function buildPoolTrail(
  r: ReceiptRow,
  orderNoById: ReadonlyMap<string, string>,
  holdNoById: ReadonlyMap<string, string>,
): PoolTrail {
  const allocations: PoolAllocationTrail[] = [
    ...r.allocations.map((a) => ({
      allocationId: a.id,
      kind: 'ORDER' as const,
      orderNumber: orderNoById.get(a.orderId) ?? null,
      orderId: a.orderId,
      holdOrderId: null,
      amountCny: round2(Number(a.amountCny)),
      allocatedAt: a.createdAt,
    })),
    ...r.holdAllocations
      .filter((a) => !a.reversedAt)
      .map((a) => ({
        allocationId: a.id,
        kind: 'HOLD' as const,
        orderNumber: holdNoById.get(a.holdOrderId) ?? null,
        orderId: null,
        holdOrderId: a.holdOrderId,
        amountCny: round2(Number(a.amountCny)),
        allocatedAt: a.createdAt,
      })),
  ].sort(
    (a, b) =>
      a.allocatedAt.getTime() - b.allocatedAt.getTime() || a.allocationId.localeCompare(b.allocationId),
  );
  const remaining =
    r.status === ReceiptStatus.REFUNDED ? 0 : round2(Number(r.amountCny) - Number(r.allocatedCny));
  return {
    receiptId: r.id,
    receiptNo: r.receiptNo,
    pooledAmount: round2(Number(r.amountCny)),
    receiptStatus: r.status,
    remainingCny: remaining,
    refundNote: r.refundNote,
    receivedAt: r.receivedAt,
    payerNote: r.payerNote,
    allocations,
  };
}

/** 订单详情要联查的收款字段（最小形状；serializeOrder 已把 gatewayPayload 剥掉，这里要原始行）。 */
export interface PaymentForTrail {
  id: string;
  gatewayPayload: Prisma.JsonValue | null;
}

/**
 * 给订单详情的收款记录挂上挂账去向。
 *
 * 返回：
 *   - splitByPaymentId：拆分收款行 → { 毛额 / 入账 / 转池 / 池子去向 }
 *   - disposalByPaymentId：多付转池对冲行 → 池子去向
 *   - overpayReceipts：本单源出、但没有任何收款行承接的挂账进账（整笔进池 / 旧处置行）
 *
 * 一次查本单所有 ORDER_OVERPAY 进账 + 载荷里指到的进账 id（并集），不逐笔打库。
 */
export async function loadOrderOverpayTrails(
  orderId: string,
  payments: ReadonlyArray<PaymentForTrail>,
): Promise<{
  splitByPaymentId: Map<string, OverpaySplitTrail>;
  disposalByPaymentId: Map<string, PoolTrail>;
  overpayReceipts: PoolTrail[];
}> {
  const splitByPaymentId = new Map<string, OverpaySplitTrail>();
  const disposalByPaymentId = new Map<string, PoolTrail>();

  const splitDetails = new Map<string, OverpaySplitDetail>();
  const disposalReceiptIds = new Map<string, string>();
  for (const p of payments) {
    const split = readOverpaySplitFromPayload(p.gatewayPayload);
    if (split) splitDetails.set(p.id, split);
    const disposalReceiptId = readDisposalPoolReceiptId(p.gatewayPayload);
    if (disposalReceiptId) disposalReceiptIds.set(p.id, disposalReceiptId);
  }
  const referencedIds = [
    ...new Set([...splitDetails.values()].map((s) => s.receiptId).concat([...disposalReceiptIds.values()])),
  ];

  const receipts = await prisma.receipt.findMany({
    where: {
      OR: [
        { source: ReceiptSource.ORDER_OVERPAY, orderHintId: orderId },
        ...(referencedIds.length ? [{ id: { in: referencedIds } }] : []),
      ],
    },
    include: {
      allocations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      holdAllocations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  if (receipts.length === 0) {
    // 载荷里有拆分明细、进账却查不到（理论上只可能是被硬删）：仍把毛额/入账/转池摆出来，池子去向为空。
    for (const [paymentId, detail] of splitDetails) splitByPaymentId.set(paymentId, { ...detail, pool: null });
    return { splitByPaymentId, disposalByPaymentId, overpayReceipts: [] };
  }

  const { orderNoById, holdNoById } = await loadNumbers(receipts);
  const trailById = new Map(receipts.map((r) => [r.id, buildPoolTrail(r, orderNoById, holdNoById)]));
  const claimed = new Set<string>();

  for (const [paymentId, detail] of splitDetails) {
    const pool = trailById.get(detail.receiptId) ?? null;
    if (pool) claimed.add(pool.receiptId);
    splitByPaymentId.set(paymentId, { ...detail, pool });
  }
  for (const [paymentId, receiptId] of disposalReceiptIds) {
    const pool = trailById.get(receiptId);
    if (!pool) continue;
    claimed.add(receiptId);
    disposalByPaymentId.set(paymentId, pool);
  }
  const overpayReceipts = receipts
    .filter((r) => r.source === ReceiptSource.ORDER_OVERPAY && r.orderHintId === orderId && !claimed.has(r.id))
    .map((r) => trailById.get(r.id))
    .filter((t): t is PoolTrail => Boolean(t));

  return { splitByPaymentId, disposalByPaymentId, overpayReceipts };
}

/**
 * 流水核对表用：按进账反查「这笔池子钱是哪张水单拆出来的」。
 * 只有超收拆分建的进账才有对应 Payment（载荷 overpaySplit.receiptId 指回来）；
 * 整笔进池 / 多付处置的进账没有拆分明细，毛额即进账额。
 *
 * 查法：拆分进账的 externalTxnId = 'MANUAL-OVERPAY:' + 源收款的 idempotencyKey（唯一索引），
 * 先走这条索引路径；极少数没带幂等键的旧进账再按 JSON 路径兜底（Payment 表全扫，只扫剩余那几笔）。
 */
export async function loadSplitOriginsByReceiptId(
  receipts: ReadonlyArray<{ id: string; externalTxnId: string | null }>,
): Promise<Map<string, { orderId: string; detail: OverpaySplitDetail }>> {
  const out = new Map<string, { orderId: string; detail: OverpaySplitDetail }>();
  if (receipts.length === 0) return out;
  const wanted = new Set(receipts.map((r) => r.id));
  const collect = (rows: Array<{ orderId: string; gatewayPayload: Prisma.JsonValue | null }>) => {
    for (const row of rows) {
      const detail = readOverpaySplitFromPayload(row.gatewayPayload);
      if (detail && wanted.has(detail.receiptId)) out.set(detail.receiptId, { orderId: row.orderId, detail });
    }
  };

  const keys = receipts
    .map((r) => r.externalTxnId)
    .filter((t): t is string => typeof t === 'string' && t.startsWith(OVERPAY_SPLIT_TXN_PREFIX))
    .map((t) => t.slice(OVERPAY_SPLIT_TXN_PREFIX.length));
  if (keys.length > 0) {
    collect(
      await prisma.payment.findMany({
        where: { idempotencyKey: { in: [...new Set(keys)] } },
        select: { orderId: true, gatewayPayload: true },
      }),
    );
  }

  const remaining = receipts.map((r) => r.id).filter((id) => !out.has(id));
  if (remaining.length > 0) {
    // JSON 路径过滤 Prisma 只支持单值 equals；一条 SQL、一个数组绑定参数走 ANY。
    collect(
      await prisma.$queryRaw<Array<{ orderId: string; gatewayPayload: Prisma.JsonValue }>>`
        SELECT "orderId", "gatewayPayload"
        FROM "Payment"
        WHERE "gatewayPayload"->'overpaySplit'->>'receiptId' = ANY(${remaining}::text[])
      `,
    );
  }
  return out;
}
