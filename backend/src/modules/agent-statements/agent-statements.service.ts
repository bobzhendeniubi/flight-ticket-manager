/**
 * 代理对账单 —— 「这个月我走的团、收了多少钱、还欠多少、拿多少返佣」一张表说清。
 *
 * 为什么单开一份而不是复用月度结算单（Settlement）：
 *   · Settlement 是**佣金**的账（GMV + 应付佣金），一个代理一期一个数，对不出「哪张单还欠尾款」；
 *   · Settlement 的归期口径是下单时间（见 settlements.service.ts computeSettlement 的自注
 *     「简化：用 createdAt」），而代理和我们对账时说的「9 月的团」指的是**9 月出发**的团。
 * 两者口径不同是有意的，本模块**不碰** Settlement 的任何生成逻辑：对账单是只读视图，
 * 表头写明「以出发日归月；月结口径以财务确认为准」，谁也不许拿它当结算依据去改佣金。
 *
 * 口径（逐条都能追到既有唯一实现，本文件不新造算法）：
 *   · 归月     —— 整单出发日 deriveOrderDepartDate（订单列表「出发日期」列同一函数：
 *                 最早航段当地出发日 → 最早酒店入住日 → 最早签证预计出行日），取前 7 位比月份。
 *                 三级都派生不出日期的单**不入表**（与列表日期筛选同一立场：无锚点不命中）。
 *   · 应收     —— total + adjustmentCny（售后费也是客人要付的钱，口径同 reminders/reports）。
 *   · 已收     —— netReceivedCny（lib/net-received.ts 唯一入口：已付 + 预存抵扣 − 已完成退款）。
 *   · 余额     —— 应收 − 已收，负数=多付，照实显示不钳零（对账要看得见多付）。
 *   · 每人结算价 —— perPaxSettlementByPassenger（per-pax-share.ts 差额模型，与订单详情页
 *                 「每人结算价」表、三模板导出、拆单搬钱同一份算法）。逐人不同时另给区间列。
 *   · 立减     —— 订单行 metadata.settlementDiscount 且未撤销的行金额绝对值合计
 *                 （口径同 orders.export-master.ts 的「立减金额」列）。**只展示、不改计提**：
 *                 立减是否进佣金基数至今未拍板（见 docs/口径决议.md 资金/返佣段）。
 *   · 佣金     —— CommissionRecord 净额，与 settlements.computeSettlement 同一净法：
 *                 ACCRUED 全额 + 尚未并入结算单的**负数**补偿记录（退款追回）。同期被翻状态的
 *                 ACCRUED→REVERSED（金额为正）不再减一次，否则重复冲销。
 *
 * 脱敏：本表所有列都是代理自家的账目与行程，**没有**成本、护照/证件、内部风控字段。
 * 列集合由 agent-statements.export.ts 的 STATEMENT_COLUMNS 单点定义，单测按
 * AGENT_HIDDEN_EXPORT_KEYS 逐 key 断言，防日后加列时把不该出岛的东西夹带进来。
 */
import { Prisma, UserRole, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { businessDateISO } from '../../lib/business-time.js';
// 订单金额单一口径（审查根因 R2）：应收 / 已收净额 / 人均 / 立减 / 每人份额全部从这里取。
// payableCny 起别名：本文件行内有同名局部变量（对账单行的字段名），避免遮蔽。
import {
  netReceivedCny,
  payableCny as payableOf,
  payablePerPaxCny,
  settlementDiscountTotalCny,
} from '../../lib/order-money.js';
import { PASSENGER_SHARES_INCLUDE, resolvePassengerShares, sharesAsMaps } from '../orders/passenger-shares.js';
import { attachPersistedShares } from '../orders/service/passenger-shares.js';
import { deriveOrderDepartDate, ORDER_STATUS_LABEL_ZH } from '../orders/orders.service.js';

/** 表头固定注脚：对账单是只读视图，别拿它当月结依据。 */
export const STATEMENT_NOTICE = '以出发日归月；月结口径以财务确认为准';

/** 粗窗口安全余量：出发时刻存 UTC，当地日与 UTC 日跨午夜会落到相邻日，两端各放宽一天。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM' */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

export interface AgentStatementRequester {
  userId: string;
  role: UserRole;
  /** AGENT 角色下登录人自己的代理 id；其它角色为 undefined */
  agentId?: string;
}

export interface AgentStatementRow {
  orderId: string;
  orderNumber: string;
  /** 归属代理显示名（本人单也照写公司名，导出给第三方看时不留空） */
  ownerAgentLabel: string;
  /** true = 这张单归对账单主体自己；false = 归下级代理 */
  ownedBySubject: boolean;
  /** 整单出发日 YYYY-MM-DD */
  departDate: string;
  /** 下单日 YYYY-MM-DD（北京时间） */
  orderDate: string;
  paxCount: number;
  /** 套餐名；无套餐时按订单包含的品类拼（机票/酒店/签证/接送…） */
  productSummary: string;
  payableCny: number;
  receivedCny: number;
  /** 应收 − 已收；负数 = 多付 */
  balanceCny: number;
  /** 每人结算价（人均口径 = 应收 ÷ 人数） */
  settlementPerPaxCny: number;
  /** 逐人价不同时给出区间文本「3,500.00 ~ 3,800.00」；一致时为空串 */
  settlementPerPaxRange: string;
  settlementDiscountCny: number;
  /** 归属代理在这张单上的佣金净额 */
  commissionOwnerCny: number;
  /** 对账单主体在这张单上拿到的佣金净额（自家单 = 上一列；下级单 = 上级分成） */
  commissionSubjectCny: number;
  statusLabel: string;
}

export interface AgentStatementTotals {
  orderCount: number;
  paxCount: number;
  payableCny: number;
  receivedCny: number;
  balanceCny: number;
  settlementDiscountCny: number;
  commissionOwnerCny: number;
  commissionSubjectCny: number;
}

/** 预存款段：期初 + 本月入账 − 本月出账 = 期末（恒等式，单测钉死）。 */
export interface AgentStatementPrepayment {
  openingCny: number;
  /** 本月入账：充值到账、多付回存、退款回补、正向调整 */
  topUpCny: number;
  /** 本月出账：抵扣订单尾款、负向调整（正数表示流出金额） */
  offsetCny: number;
  closingCny: number;
}

export interface AgentStatementAgent {
  id: string;
  companyName: string | null;
  contactName: string;
  tier: number;
}

export interface AgentStatement {
  month: string;
  agent: AgentStatementAgent;
  /** 纳入统计的代理 id（主体 + 全部下级） */
  scopeAgentIds: string[];
  rows: AgentStatementRow[];
  totals: AgentStatementTotals;
  prepayment: AgentStatementPrepayment;
  notice: string;
}

/**
 * 权限：AGENT 只能取自己或自己的下级；ADMIN/STAFF 任意；CUSTOMER 一律拒。
 * 与 settlements.list 的可见范围同一棵树（getDescendantAgentIds），不另造口径。
 * 返回主体代理的下辖 id 集合，顺带做「代理是否存在」的校验。
 */
export async function resolveStatementScope(
  agentId: string,
  requester: AgentStatementRequester,
  client: PrismaClient = defaultPrisma,
): Promise<string[]> {
  if (requester.role === UserRole.CUSTOMER) {
    throw new ForbiddenError('无权查看代理对账单');
  }
  if (requester.role === UserRole.AGENT) {
    if (!requester.agentId) throw new ForbiddenError('当前账号未绑定代理');
    const visible = await getDescendantAgentIds(requester.agentId);
    if (!visible.includes(agentId)) {
      // 不区分「不存在」与「不是你的下级」：否则可以拿 404/403 的差异探测别家代理 id 是否存在。
      throw new ForbiddenError('只能查看自己或下级代理的对账单');
    }
  }
  const agent = await client.agent.findUnique({ where: { id: agentId }, select: { id: true } });
  if (!agent) throw new NotFoundError('代理不存在');
  return getDescendantAgentIds(agentId);
}

/** 'YYYY-MM' → 粗召回窗口（UTC 月界两端各放宽一天）；精筛在内存里按当地出发日做。 */
function monthWindow(month: string): { coarseStart: Date; coarseEnd: Date } {
  const [y, m] = month.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const endUtc = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0));
  return {
    coarseStart: new Date(startUtc.getTime() - DAY_MS),
    coarseEnd: new Date(endUtc.getTime() + DAY_MS),
  };
}

/** 'YYYY-MM' → 该月北京时间的 [起, 止) UTC 瞬间（预存流水按动作发生时刻归月，不放宽）。 */
function businessMonthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split('-').map(Number);
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
  return {
    start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - BEIJING_OFFSET_MS),
    end: new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0) - BEIJING_OFFSET_MS),
  };
}

const KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  VISA: '签证',
  TRANSFER: '接送',
  INSURANCE: '保险',
  BUNDLE: '套餐',
  FEE: '费用',
};

/** 套餐名优先；无套餐时按品类去重拼接。纯费用行不单独成名（避免整行只显示「费用」）。 */
function productSummary(
  items: ReadonlyArray<{ kind: string; bundle: { name: string } | null }>,
): string {
  const bundleNames = Array.from(
    new Set(items.map((it) => it.bundle?.name).filter((n): n is string => Boolean(n))),
  );
  if (bundleNames.length > 0) return bundleNames.join(' / ');
  const kinds = Array.from(new Set(items.map((it) => it.kind).filter((k) => k !== 'FEE')));
  return kinds.map((k) => KIND_LABEL[k] ?? k).join('+');
}

/**
 * 立减合计（订单口径）——「立减快照行」金额绝对值之和，已撤销的行不计。
 * 与 orders.export-master.ts 的「立减金额」列同一判据（那边再 ÷ 人数摊到每行乘客，
 * 本表一行一单故不摊）。改期/改归属会给行打 settlementDiscountRevoked，撤了就不该再算。
 */
function settlementDiscountCny(
  items: ReadonlyArray<{ amount: Prisma.Decimal | number | null; metadata: unknown }>,
): number {
  return round2(settlementDiscountTotalCny(items));
}

/** 佣金记录的最小形状（本模块只关心金额、状态、是否已并单）。 */
interface CommissionRecordShape {
  amount: Prisma.Decimal | number;
  status: string;
  settlementId: string | null;
}

/**
 * 佣金净额 —— 与 settlements.service.ts computeSettlement 同一净法，别在这里自创：
 *   · ACCRUED 记录全额计入；
 *   · 尚未并入结算单（settlementId=null）的**负数**补偿记录计入（退款按比例追回）；
 *   · 同期被翻状态的 ACCRUED→REVERSED（amount>0）**不减**——它们已因 status≠ACCRUED
 *     被排除在第一项之外，再取相反数减一次就是重复冲销。
 */
function netCommissionCny(records: ReadonlyArray<CommissionRecordShape>): number {
  let sum = 0;
  for (const r of records) {
    const amount = dec(r.amount);
    if (r.status === 'ACCRUED') sum += amount;
    else if (r.status === 'REVERSED' && r.settlementId === null && amount < 0) sum += amount;
  }
  return round2(sum);
}

/** 金额区间文本；上下界相等时返回空串（逐人价一致的单不必占这一列）。 */
function rangeLabel(values: readonly number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (Math.round(min * 100) === Math.round(max * 100)) return '';
  const fmt = (n: number): string =>
    n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${fmt(min)} ~ ${fmt(max)}`;
}

/** 订单联查的最小字段集：只取对账要用的，成本/证件一律不查（查了就迟早会被写进列）。 */
const STATEMENT_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  agentId: true,
  status: true,
  total: true,
  paidAmount: true,
  prepaymentOffset: true,
  adjustmentCny: true,
  adjustments: true,
  createdAt: true,
  passengers: { select: { id: true } },
  // 按人份额（R1）：每人结算价先读库
  passengerShares: PASSENGER_SHARES_INCLUDE,
  refunds: { where: { status: 'COMPLETED' as const }, select: { amount: true } },
  items: {
    select: {
      id: true,
      kind: true,
      amount: true,
      description: true,
      passengerId: true,
      metadata: true,
      hotelCheckIn: true,
      visaIntendedDate: true,
      bundle: { select: { name: true } },
      flightSchedule: { select: { departureTime: true, departureTz: true } },
    },
  },
} satisfies Prisma.OrderSelect;

export interface BuildAgentStatementInput {
  agentId: string;
  /** 'YYYY-MM' */
  month: string;
  /** 已由 resolveStatementScope 校验过的下辖代理 id 集合 */
  scopeAgentIds: string[];
}

export async function buildAgentStatement(
  input: BuildAgentStatementInput,
  client: PrismaClient = defaultPrisma,
): Promise<AgentStatement> {
  const { agentId, month, scopeAgentIds } = input;
  if (!MONTH_RE.test(month)) throw new BadRequestError('月份格式应为 YYYY-MM');

  const agent = await client.agent.findUnique({
    where: { id: agentId },
    select: { id: true, companyName: true, contactName: true, tier: true },
  });
  if (!agent) throw new NotFoundError('代理不存在');

  const agentLabels = new Map<string, string>();
  const scopeAgents = await client.agent.findMany({
    where: { id: { in: scopeAgentIds } },
    select: { id: true, companyName: true, contactName: true },
  });
  for (const a of scopeAgents) agentLabels.set(a.id, a.companyName ?? a.contactName);

  // ── 粗召回：本月（±1 天）有任一日期锚点的订单 ──
  // 三个锚点与 deriveOrderDepartDate 的三级回退一一对应；一个锚点都没有的单派生不出出发日，
  // 本来也不该入表（无锚点不命中），所以粗窗口不为它们开豁免口子。
  const { coarseStart, coarseEnd } = monthWindow(month);
  const withinWindow = { gte: coarseStart, lte: coarseEnd };
  const orders = await client.order.findMany({
    where: {
      agentId: { in: scopeAgentIds },
      deletedAt: null,
      // DRAFT = 还没成单的半成品，不进对账；其余状态（含取消/退款族）照实入表并显示状态——
      // 退款单的钱确实动过，从对账单里抹掉反而对不上账。
      status: { not: 'DRAFT' },
      items: {
        some: {
          OR: [
            { flightSchedule: { departureTime: withinWindow } },
            { hotelCheckIn: withinWindow },
            { visaIntendedDate: withinWindow },
          ],
        },
      },
    },
    select: STATEMENT_ORDER_SELECT,
    orderBy: { orderNumber: 'asc' },
  });

  // ── 精筛：按整单出发日的当地年月 ──
  // 按人份额 lazy 回填（R1）：老单顺手落一遍再读回来（失败不影响对账单，照旧派生）。
  const inMonth = await attachPersistedShares(
    orders.filter((o) => deriveOrderDepartDate(o.items)?.slice(0, 7) === month),
    client,
  );

  // ── 佣金：一次查完本批订单在 scope 内的全部记录，按 (orderId, agentId) 归拢 ──
  const commissionByOrderAgent = new Map<string, CommissionRecordShape[]>();
  if (inMonth.length > 0) {
    const records = await client.commissionRecord.findMany({
      where: { orderId: { in: inMonth.map((o) => o.id) }, agentId: { in: scopeAgentIds } },
      select: { orderId: true, agentId: true, amount: true, status: true, settlementId: true },
    });
    for (const r of records) {
      const key = `${r.orderId}::${r.agentId}`;
      const bucket = commissionByOrderAgent.get(key);
      if (bucket) bucket.push(r);
      else commissionByOrderAgent.set(key, [r]);
    }
  }
  const commissionOf = (orderId: string, ownerId: string | null): number =>
    ownerId ? netCommissionCny(commissionByOrderAgent.get(`${orderId}::${ownerId}`) ?? []) : 0;

  const rows: AgentStatementRow[] = inMonth.map((o) => {
    // 应收 / 已收净额 / 每人份额全部走 lib/order-money（审查根因 R2），本文件不自己算钱。
    const payableCny = payableOf(o);
    const receivedCny = netReceivedCny(o, o.refunds);
    // 每人结算价先读库（写路径落的事实），老单没有才派生 —— resolvePassengerShares 一处决定。
    const shares = sharesAsMaps(resolvePassengerShares(o)).settlement;
    const paxCount = o.passengers.length;
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      ownerAgentLabel: (o.agentId && agentLabels.get(o.agentId)) ?? '—',
      ownedBySubject: o.agentId === agentId,
      departDate: deriveOrderDepartDate(o.items) ?? '',
      orderDate: businessDateISO(o.createdAt),
      paxCount,
      productSummary: productSummary(o.items),
      payableCny,
      receivedCny,
      // 不钳零：负数就是客人多付了，对账单必须让它显形，否则多付的钱在表上凭空消失。
      balanceCny: round2(payableCny - receivedCny),
      // 人均口径 = 应收 ÷ 人数（Σ 每人份额恒等于应收，见 per-pax-share.ts）；
      // 逐人不同时由 settlementPerPaxRange 补出真实区间，不拿一个平均数糊弄过去。
      // ⚠️ 这是「应收 ÷ 人数」（换人费也摊），与导出兜底的「可摊应收 ÷ 人数」（换人费不摊）
      // 是两个数——lib/order-money 里各自命名（payablePerPaxCny vs settlePerPaxFallbackCny），
      // 冲突已登记待拍板，此处只改调不统一。
      settlementPerPaxCny: paxCount > 0 ? payablePerPaxCny(o, paxCount) : 0,
      settlementPerPaxRange: rangeLabel([...shares.values()]),
      settlementDiscountCny: settlementDiscountCny(o.items),
      commissionOwnerCny: commissionOf(o.id, o.agentId),
      commissionSubjectCny: commissionOf(o.id, agentId),
      statusLabel: ORDER_STATUS_LABEL_ZH[o.status] ?? o.status,
    };
  });

  const totals = rows.reduce<AgentStatementTotals>(
    (acc, r) => ({
      orderCount: acc.orderCount + 1,
      paxCount: acc.paxCount + r.paxCount,
      payableCny: round2(acc.payableCny + r.payableCny),
      receivedCny: round2(acc.receivedCny + r.receivedCny),
      balanceCny: round2(acc.balanceCny + r.balanceCny),
      settlementDiscountCny: round2(acc.settlementDiscountCny + r.settlementDiscountCny),
      commissionOwnerCny: round2(acc.commissionOwnerCny + r.commissionOwnerCny),
      commissionSubjectCny: round2(acc.commissionSubjectCny + r.commissionSubjectCny),
    }),
    {
      orderCount: 0,
      paxCount: 0,
      payableCny: 0,
      receivedCny: 0,
      balanceCny: 0,
      settlementDiscountCny: 0,
      commissionOwnerCny: 0,
      commissionSubjectCny: 0,
    },
  );

  const prepayment = await buildPrepaymentSection(agentId, month, client);

  return { month, agent, scopeAgentIds, rows, totals, prepayment, notice: STATEMENT_NOTICE };
}

/**
 * 预存款段（只算**主体代理自己**，不含下级）：余额是一家一个池子，下级的余额是下级的钱。
 *
 * 期初 = 本月第一笔流水之前的余额，用那笔的 balanceAfter − amount 反推，而不是去查
 * 「上月最后一笔的 balanceAfter」—— 后者在流水有缺口时（历史补录、跨库迁移）会给出对不上的数，
 * 反推则与本月这批流水自洽，恒等式 期初 + 入账 − 出账 = 期末 永远成立。
 * 本月无流水时回落「本月之前最后一笔的 balanceAfter」，再没有就是 0（从没充过值）。
 */
async function buildPrepaymentSection(
  agentId: string,
  month: string,
  client: PrismaClient,
): Promise<AgentStatementPrepayment> {
  const { start, end } = businessMonthBounds(month);
  const txs = await client.prepaymentTransaction.findMany({
    where: { agentId, createdAt: { gte: start, lt: end } },
    select: { amount: true, balanceAfter: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (txs.length === 0) {
    const last = await client.prepaymentTransaction.findFirst({
      where: { agentId, createdAt: { lt: start } },
      select: { balanceAfter: true },
      orderBy: { createdAt: 'desc' },
    });
    const carried = round2(dec(last?.balanceAfter));
    return { openingCny: carried, topUpCny: 0, offsetCny: 0, closingCny: carried };
  }

  const first = txs[0];
  const openingCny = round2(dec(first.balanceAfter) - dec(first.amount));
  let topUpCny = 0;
  let offsetCny = 0;
  for (const t of txs) {
    const amount = dec(t.amount);
    if (amount >= 0) topUpCny += amount;
    else offsetCny += -amount;
  }
  return {
    openingCny,
    topUpCny: round2(topUpCny),
    offsetCny: round2(offsetCny),
    closingCny: round2(dec(txs[txs.length - 1].balanceAfter)),
  };
}
