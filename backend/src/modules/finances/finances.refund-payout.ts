/**
 * 退款「待打款」队列 + 实付登记
 *
 * 补的是退款链路上唯一没有系统痕迹的一步。现状：客人/代理申请取消 → 建 Refund(REQUESTED)；
 * 管理员把订单推到 REFUNDED → Refund 直接翻 COMPLETED（orders.service.ts 状态同步段）。
 * 到此为止系统认为「退款完成」，可**钱还在公司账上** —— 真正打回客人是财务在银行/微信里的
 * 手工动作。于是「核准了一直没打」和「同一笔打了两次」都只能靠线下表格发现。
 *
 * 本模块只做两件事，一件都不越界：
 *   1. 队列 —— status=COMPLETED 且 paidAt IS NULL，按核准时刻排账龄；
 *   2. 登记 —— 往那五列写一次「钱确实出去了」，重复标记直接 409 拒绝。
 *
 * 明确**不做**的事（越过任何一条都会动到钱）：
 *   · 不改 Refund.status，不碰退款状态机（REQUESTED→COMPLETED/REJECTED 仍只由订单状态驱动）；
 *   · 不改任何金额口径 —— 已收净额照旧只认 status=COMPLETED（lib/net-received.ts），
 *     登记打款不会让订单的已收/尾款动一分；
 *   · 不新建资金流水、不碰预存余额（余额回补在订单转 REFUNDED 时已经做过了）。
 *
 * 覆盖范围：换人退款（swapRefund）与普通取消退款走的是同一张 Refund 表，天然都在队列里；
 * 取消航段（cancel-leg）走的是直接改应收的路径、不建 Refund 行，因而不在本队列范围内 ——
 * 这是对现状的记录，不是本批要扩的口子。
 */
import { Prisma, RefundStatus, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';

/** 打款渠道白名单。用字符串常量而非 Prisma enum：渠道会随收付款方式变，加一个不该要一次迁移。 */
export const REFUND_PAY_METHODS = ['BANK', 'WECHAT', 'ALIPAY', 'CASH', 'OTHER'] as const;
export type RefundPayMethod = (typeof REFUND_PAY_METHODS)[number];

export const REFUND_PAY_METHOD_LABEL: Record<RefundPayMethod, string> = {
  BANK: '银行转账',
  WECHAT: '微信',
  ALIPAY: '支付宝',
  CASH: '现金',
  OTHER: '其他',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 账龄告警阈值（天）：财务日常动线是每天清队列，超过一周还没打款基本就是漏了。 */
export const PAYOUT_OVERDUE_DAYS = 7;

export interface PendingPayoutRow {
  refundId: string;
  orderId: string;
  orderNumber: string;
  contactName: string;
  /** 归属代理显示名；直客为 null */
  agencyLabel: string | null;
  amountCny: number;
  reason: string | null;
  /** 申请日（Refund 建行时刻） */
  requestedAt: string;
  /** 核准日（订单推到已退款、Refund 翻 COMPLETED 的时刻）；老数据可能为空 */
  approvedAt: string | null;
  /** 账龄天数：从核准日算起（没有核准日则从申请日算），向下取整 */
  ageDays: number;
  /** 是否换人退款（与普通退票区分，财务打款时话术不同） */
  isSwapRefund: boolean;
}

export interface PendingPayoutResult {
  rows: PendingPayoutRow[];
  totalAmountCny: number;
  /** 账龄达到阈值的笔数 —— 卡片上要红一下，这是「核准了没人打」的典型信号 */
  overdueCount: number;
}

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ageInDays(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * 待打款队列：已核准（COMPLETED）但还没登记打款（paidAt IS NULL）的退款，账龄长的排前面。
 * 已删订单排除 —— 软删单不该再出现在任何工作队列里。
 */
export async function listPendingRefundPayouts(
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<PendingPayoutResult> {
  const refunds = await client.refund.findMany({
    where: {
      status: RefundStatus.COMPLETED,
      paidAt: null,
      order: { deletedAt: null },
    },
    select: {
      id: true,
      amount: true,
      reason: true,
      createdAt: true,
      processedAt: true,
      gatewayPayload: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          contactName: true,
          agent: { select: { companyName: true, contactName: true } },
        },
      },
    },
    // 核准早的排前面（账龄最长的先打）；核准日为空的老数据用建行时刻兜底排序。
    orderBy: [{ processedAt: 'asc' }, { createdAt: 'asc' }],
  });

  const rows: PendingPayoutRow[] = refunds.map((r) => {
    const payload = r.gatewayPayload;
    const isSwapRefund =
      payload != null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as { swapRefund?: unknown }).swapRefund === true;
    const anchor = r.processedAt ?? r.createdAt;
    return {
      refundId: r.id,
      orderId: r.order.id,
      orderNumber: r.order.orderNumber,
      contactName: r.order.contactName,
      agencyLabel: r.order.agent?.companyName ?? r.order.agent?.contactName ?? null,
      amountCny: round2(dec(r.amount)),
      reason: r.reason,
      requestedAt: r.createdAt.toISOString(),
      approvedAt: r.processedAt?.toISOString() ?? null,
      ageDays: ageInDays(anchor, now),
      isSwapRefund,
    };
  });

  return {
    rows,
    totalAmountCny: round2(rows.reduce((s, r) => s + r.amountCny, 0)),
    overdueCount: rows.filter((r) => r.ageDays >= PAYOUT_OVERDUE_DAYS).length,
  };
}

export interface MarkRefundPaidInput {
  orderId: string;
  refundId: string;
  /** 实际打款时间；缺省 = 此刻。允许回溯补录（财务常常是打完钱隔天才来登记）。 */
  paidAt?: Date;
  paidMethod: RefundPayMethod;
  paidTxnRef?: string | null;
  paidNote?: string | null;
  /** 登记人（内部账号 userId） */
  paidByUserId: string;
}

export interface MarkRefundPaidResult {
  refundId: string;
  orderNumber: string;
  amountCny: number;
  paidAt: string;
  paidMethod: RefundPayMethod;
  paidTxnRef: string | null;
  paidNote: string | null;
}

/**
 * 登记一笔退款已实际打款。
 *
 * 幂等口径：**重复标记直接拒绝**（409），不做「第二次静默成功」。
 * 理由：这一步对应的是真的往外打了一笔钱。若第二次点也返回成功，界面上看不出区别，
 * 「到底打了一次还是两次」就永远查不清 —— 宁可让人当场看到「这笔已在 X 时间由 Y 登记过」，
 * 再由人去核实是不是真打了两笔。改登记内容（填错渠道/流水号）应另走更正流程，不在此处覆盖。
 *
 * 状态闸：只有 COMPLETED 的退款能登记打款。REQUESTED/APPROVED/PROCESSING 意味着还没核准，
 * 钱本来就不该出去；REJECTED 是明确不退。fail-closed，绝不为了「先记上」而放行。
 */
export async function markRefundPaid(
  input: MarkRefundPaidInput,
  client: PrismaClient = defaultPrisma,
): Promise<MarkRefundPaidResult> {
  const paidAt = input.paidAt ?? new Date();
  // 允许 1 分钟的时钟宽容；再往后就是把年份/日期填错了，钱不可能在未来打出去。
  if (paidAt.getTime() > Date.now() + 60_000) {
    throw new BadRequestError('打款时间不能晚于当前时间');
  }

  return client.$transaction(async (tx) => {
    // FOR UPDATE 行锁：两个人同时点「标记已打款」时，后到的那个必须看到前一个已写入的 paidAt
    // 并被下面的幂等闸拒掉，而不是两条都通过、后写覆盖先写。
    const locked = await tx.$queryRaw<
      Array<{ id: string; status: RefundStatus; paidAt: Date | null; paidByUserId: string | null }>
    >`SELECT id, status, "paidAt", "paidByUserId" FROM "Refund"
        WHERE id = ${input.refundId} AND "orderId" = ${input.orderId} FOR UPDATE`;
    const row = locked[0];
    if (!row) throw new NotFoundError('退款记录不存在，或不属于这张订单');

    if (row.status !== RefundStatus.COMPLETED) {
      throw new BadRequestError('只有已核准（订单已转「已退款」）的退款才能登记打款');
    }
    if (row.paidAt) {
      throw new ConflictError('这笔退款已登记过打款，请先核实是否重复打款', {
        paidAt: row.paidAt.toISOString(),
        paidByUserId: row.paidByUserId,
      });
    }

    const updated = await tx.refund.update({
      where: { id: input.refundId },
      data: {
        paidAt,
        paidMethod: input.paidMethod,
        paidTxnRef: input.paidTxnRef?.trim() || null,
        paidNote: input.paidNote?.trim() || null,
        paidByUserId: input.paidByUserId,
      },
      select: {
        id: true,
        amount: true,
        paidAt: true,
        paidMethod: true,
        paidTxnRef: true,
        paidNote: true,
        order: { select: { orderNumber: true } },
      },
    });

    return {
      refundId: updated.id,
      orderNumber: updated.order.orderNumber,
      amountCny: round2(dec(updated.amount)),
      // 刚写进去的值，不可能为空；用入参兜底以免非空断言。
      paidAt: (updated.paidAt ?? paidAt).toISOString(),
      paidMethod: (updated.paidMethod ?? input.paidMethod) as RefundPayMethod,
      paidTxnRef: updated.paidTxnRef,
      paidNote: updated.paidNote,
    };
  });
}
