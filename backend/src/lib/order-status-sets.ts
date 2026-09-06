/**
 * 订单状态集合 —— 全站唯一一份（审查根因 R2）。
 *
 * 背景：同一个「哪些状态算有效 / 占座 / 已付款」在 14 个文件里各抄了一份（8/26 审计时 12 份，
 * 到 9/5 仍在长），靠人肉保持对称。任何一处漏改，症状就是「这张表有这单、那张表没有」。
 * 本文件把它们合成一处；各集合之间的既有约定由 order-status-sets.test.ts 用断言钉死。
 *
 * ⚠️ 这里合并的是**逐字相同**的副本。原本就不同的集合各自保留、各取其名，绝不抹平：
 *   · COUNTED_STATUSES（财务/报表/履约）**含** REFUND_REQUESTED —— 退款申请中钱还在公司账上，
 *     收入/成本/履约任务都要照常计；
 *   · INVENTORY_COUNTED_STATUSES（房控/开票额度/导出/进单统计）**不含** REFUND_REQUESTED ——
 *     退款申请那一刻座位与房已释放（见 SEAT_RELEASING_STATUSES），库存口径不能再数它。
 *   两者的差恰好就是 {REFUND_REQUESTED}，测试里有断言。
 *   · 「已付款」有三个集合（PAID_LIKE / PAID / AGENT_STATS_PAID），互相差 1–2 个状态，
 *     这是现状，已登记待拍板（docs/口径决议.md「待拍板 · 金额口径冲突」），本文件只命名不合并。
 *
 * 数组元素顺序**逐字沿用各处原定义**（Prisma `in:` 不关心顺序，但 where 子句快照/日志要字节一致）。
 * 类型故意用可变的 OrderStatus[]（与各处原定义一致）：Prisma where 的 `in:` 只收可变数组，
 * 30 多个调用点不必逐个 spread。约定：只读不改；测试里断言没人在运行时动过它们。
 *
 * 全部 13 个状态：DRAFT PENDING_PAYMENT PAID PROCESSING TICKETED COMPLETED PAYMENT_TIMEOUT
 * CANCELLED REFUND_REQUESTED REFUNDED CHANGE_REQUESTED CHANGED FAILED
 *
 * 不在本文件里的状态集合（各有各的语义，不是副本）：
 *   · lib/funds-guard.ts FUNDS_CREDIT_BLOCKED_STATUSES —— 资金入账闸（= 释放型 − FAILED），写侧口径；
 *   · modules/reminders/reminders.rules.ts 各规则的扫描集合 —— 按提醒规则各自裁剪；
 *   · modules/travelers/traveler-profiles.aggregate.ts UNPAID_STATUSES —— 「已消费」口径的补集；
 *   · modules/supplier-payables/supplier-payables.reconcile.ts COUNTED_STATUSES —— 该文件明确
 *     写了「故意复制而非复用」（对账口径不随财务概览被动变），且不在本批范围；
 *   · modules/hold-orders/held-seats.ts SEAT_HOLDING_STATUSES —— 是 HoldOrderStatus，另一个枚举。
 */
import { OrderStatus } from '@prisma/client';

/** 全部订单状态（枚举值序），供对称性断言与补集运算。 */
export const ALL_ORDER_STATUSES: OrderStatus[] = Object.values(OrderStatus);

/**
 * 占座 / 占房状态（库存口径）。
 * 建单即 PENDING_PAYMENT 占座；改签中 / 已改签仍占；COMPLETED 已飞但账面仍算这班的人。
 * 与 SEAT_RELEASING_STATUSES 互补（并集 = 全部、交集 = 空），是座位账不漏不重的前提
 *（口径决议 2026-08「座位口径」：SEAT_HOLDING/RELEASING_STATUSES 必须对称）。
 */
export const SEAT_HOLDING_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/**
 * 释放型状态（座位 / 房已还回库存）。
 * DRAFT 归这边而不是「既不占也不放」（否则 force H→DRAFT→PAID 反复横跳可把 sold 做爆，
 * 见 orders.service 状态机注释）；REFUND_REQUESTED 在申请那一刻即释放。
 */
export const SEAT_RELEASING_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.PAYMENT_TIMEOUT,
  OrderStatus.REFUNDED,
  OrderStatus.FAILED,
  OrderStatus.DRAFT,
  OrderStatus.REFUND_REQUESTED,
];

/**
 * 库存口径的「有效订单」= 占座集合（同一份数组，故意不拷贝：两者就是一回事）。
 * 房控销控 / 分房表 / 开票额度 / 三模板与全岗总表选单 / 进单统计 / 签证名单 / 整班导出共用：
 * 「进导出」⟺「占库存」，退款申请中已释放，不再出现在任何岗位手上。
 */
export const INVENTORY_COUNTED_STATUSES: OrderStatus[] = SEAT_HOLDING_STATUSES;

/**
 * 财务 / 报表 / 履约口径的「有效订单」= 库存口径 + REFUND_REQUESTED。
 * 退款申请中的单钱还在账上、履约任务（尤其签证）也还要盯，收入/成本/任务列表照常计；
 * REFUNDED 明确排除（财务概览对它按订单级「已收−已退净额」单独补一笔负项）。
 * 元素顺序沿用 finances.service / reports.service / fulfillment.service 的原定义。
 */
export const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/**
 * 取消族终态：履约任务应被终态化（CANCELLED）、开票额度回收。
 * = 释放型 − {DRAFT, REFUND_REQUESTED}：草稿不是「被取消」，退款申请中还可能驳回拉回。
 * 名字沿用 orders.service 原导出名（路由层签证矛盾硬闸也用它判豁免）。
 */
export const FULFILLMENT_TERMINATING_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.PAYMENT_TIMEOUT,
  OrderStatus.FAILED,
];

/** 退款族（申请中 + 已退）：财务导出「退款类型」列判「普通退款」用。 */
export const REFUND_FAMILY_STATUSES: OrderStatus[] = [
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.REFUNDED,
];

/**
 * 已付款族（仪表盘营收 / 日趋势 / 活跃代理）= 占座集合 − PENDING_PAYMENT。
 * 改签中 / 已改签的钱已经收了，照常算营收。
 */
export const PAID_LIKE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/**
 * 已付款（不含改签对）：客户档案「已消费」聚合 / 结算单 GMV 选单用。
 * ⚠️ 与 PAID_LIKE_STATUSES 的差 = {CHANGE_REQUESTED, CHANGED}——同一个「已付款」在仪表盘与
 * 客户档案 / 结算单里是两个集合。这是现状，已登记待拍板，本文件只把它们各自命名，不合并。
 */
export const PAID_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
];

/**
 * 代理成交额（GET /orders/agent-stats）用的「已付款」：又少了 PROCESSING。
 * 沿用列表卡片此前的前端算法逐字一致的口径；与上面两个「已付款」集合的差异同样已登记待拍板。
 */
export const AGENT_STATS_PAID_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
];

/**
 * 应收口径的进行中状态（应收账龄 / 代理欠款）= 占座集合 − COMPLETED。
 * 已完成的单不再催款（有尾款也当坏账单独处理，不进账龄）。
 */
export const RECEIVABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 状态是否在集合内；入参放宽到 string（路由层 / 导出行的 status 常是 string）。 */
export function statusIn(set: readonly OrderStatus[], status: string | OrderStatus): boolean {
  return (set as readonly string[]).includes(status);
}
