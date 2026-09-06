// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import { PASSENGER_SHARES_INCLUDE } from '../passenger-shares.js';
import {
  CabinClass,
  CommissionStatus,
  OrderItemKind,
  OrderLegFlag,
  OrderStatus,
  PassengerType,
  Prisma,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { randomInt } from 'node:crypto';
import { prisma } from '../../../db/prisma.js';
import { BadRequestError, NotFoundError, PriceChangedError } from '../../../lib/errors.js';
import { hasCapability, type Capability } from '../../../lib/capabilities.js';
import {
  composePassengerFullName,
  normalizePassengerFullName,
  splitPassengerFullName,
} from '../../../lib/passenger-name.js';
import { localHHMM, localDateISO } from '../../../lib/flight-time.js';
import { businessDateISO, startOfBusinessDayUtc } from '../../../lib/business-time.js';
import { deriveLegStatus } from '../orders.leg-status.js';
import {
  FULFILLMENT_TERMINATING_STATUSES as FULFILLMENT_TERMINATING_STATUSES_LIB,
  SEAT_HOLDING_STATUSES as SEAT_HOLDING_STATUSES_LIB,
  SEAT_RELEASING_STATUSES as SEAT_RELEASING_STATUSES_LIB,
} from '../../../lib/order-status-sets.js';
import { LEGACY_ROUTE_KEY } from '../../products/bundle-route.js';
import type {
  SettlementDiscountHit,
} from '../../settlement-discounts/settlement-discounts.service.js';
import { getHotelOversellCapRooms } from '../../hotel-control/hotel-control.service.js';
import { derivePtcByAge } from '../pnr-export.js';
import { determineFlightLegs } from '../ticketing-cap.js';
import type { FlightLegItem } from '../ticketing-cap.js';
import { PRICE_ADJUSTMENT_REASON_LABEL } from '../orders.schemas.js';
import type { PassengerInput, PriceAdjustmentReasonDisplay } from '../orders.schemas.js';
export const ORDER_STATUS_LABEL_ZH: Record<OrderStatus, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款申请中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期申请中',
  CHANGED: '已改期',
  FAILED: '出票失败',
};
export const zhStatus = (s: OrderStatus): string => ORDER_STATUS_LABEL_ZH[s] ?? s;

export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['PAID', 'PAYMENT_TIMEOUT', 'CANCELLED'],
  // CHANGE_REQUESTED：前台改签申请可在出票前（PAID/PROCESSING）就发起 —— 与 TICKETED 一致进入白名单
  PAID: ['PROCESSING', 'TICKETED', 'REFUND_REQUESTED', 'CHANGE_REQUESTED'],
  PROCESSING: ['TICKETED', 'FAILED', 'REFUND_REQUESTED', 'CHANGE_REQUESTED'],
  TICKETED: ['COMPLETED', 'CHANGE_REQUESTED', 'REFUND_REQUESTED'],
  COMPLETED: [], // 终态
  PAYMENT_TIMEOUT: ['PENDING_PAYMENT', 'CANCELLED'],
  CANCELLED: [], // 终态
  REFUND_REQUESTED: ['REFUNDED', 'PROCESSING'], // 被拒回退到 PROCESSING
  REFUNDED: [], // 终态
  // 改签申请可从 PAID/PROCESSING（出票前）发起，故驳回要能退回出票前流程，
  // 批准（CHANGED）后也要能继续走出票——否则未出票单被迫落"已出票"，或改签后卡死只能 force。
  CHANGE_REQUESTED: ['CHANGED', 'PAID', 'PROCESSING', 'TICKETED'], // 驳回→PAID/PROCESSING，批准→CHANGED，已出票改签→TICKETED
  CHANGED: ['PROCESSING', 'TICKETED', 'COMPLETED', 'REFUND_REQUESTED'], // 改签后继续出票流程或直接完结/退款
  FAILED: ['PROCESSING', 'REFUND_REQUESTED', 'CANCELLED'],
};

// ════════════════════════════════════════════════════════════════════════════
// 结算档次 ↔ 酒店星级：唯一权威映射
//
// 数据模型上这两件事分别记在两处，谁都不是对方的派生字段：
//   · 套餐档次 = Bundle.settlementTier（SettlementTier 枚举，结算价日历的取价键之一）；
//   · 酒店星级 = Hotel.starRating（纯 1..5 整数）+ Hotel.intlFiveStar（国际五星标记，
//     与 starRating=5 共用整数星级，另行报价 —— 口径见 schema.prisma 与 hotel-control.service.ts）。
// 「四星档的钱住三星店」这类交付降级此前系统完全不知情（只校验房型存在 + 在架），
// 故在此把两套口径钉成一份映射，录单指定酒店与售后换酒店共用，绝不各推各的。
// ════════════════════════════════════════════════════════════════════════════
export const SETTLEMENT_TIER_STAR_RATING: Record<SettlementTier, number> = {
  CITY_3STAR: 3,
  CITY_4STAR: 4,
  CITY_5STAR: 5,
  INTL_5STAR: 5,
};
export const SETTLEMENT_TIER_LABEL: Record<SettlementTier, string> = {
  CITY_3STAR: '市区三星',
  CITY_4STAR: '市区四星',
  CITY_5STAR: '市区五星',
  INTL_5STAR: '国际五星',
};

/** 酒店档案 → 结算档次；1/2 星等档次表里没有的星级返回 null（即「对不上任何档」）。 */
export function resolveHotelSettlementTier(hotel: {
  starRating?: number | null;
  intlFiveStar?: boolean | null;
}): SettlementTier | null {
  if (hotel.starRating == null) return null;
  if (hotel.intlFiveStar === true) return hotel.starRating === 5 ? 'INTL_5STAR' : null;
  if (hotel.starRating === 3) return 'CITY_3STAR';
  if (hotel.starRating === 4) return 'CITY_4STAR';
  if (hotel.starRating === 5) return 'CITY_5STAR';
  return null;
}

/**
 * 指定/换入酒店的星级是否与套餐档次不匹配。
 *
 * 保守口径（宁可多问一句，也不放行一次沉默的降级交付）：
 *   · 星级缺失（starRating 为空）→ 视为不匹配；
 *   · 1/2 星等映射不到任何档次的酒店 → 视为不匹配；
 *   · 国际五星与市区五星互为不同档（另行报价）→ 视为不匹配。
 * 「升级」（如三星档住五星店）同样算不匹配 —— 钱与货对不上就该有人签字，方向不改变这一点。
 */
export function isSettlementTierStarMismatch(
  tier: SettlementTier,
  hotel: { starRating?: number | null; intlFiveStar?: boolean | null },
): boolean {
  return resolveHotelSettlementTier(hotel) !== tier;
}

/** 星级不匹配放行（override）的留痕明细 —— 调用方据此写审计。 */
export interface DesignatedHotelStarMismatchOverride {
  bundleId: string;
  bundleName: string | null;
  /** 套餐档次（SettlementTier 枚举值）与其对应星级。 */
  bundleTier: SettlementTier;
  bundleTierStar: number;
  hotelRoomTypeId: string;
  hotelId: string;
  hotelName: string;
  hotelStarRating: number | null;
  hotelIntlFiveStar: boolean;
  reason: string;
}

/** 星级闸的调用上下文：role=null 视为对外身份（游客/客户），一律拒单。 */
export interface DesignatedHotelStarGate {
  role: UserRole | null;
  overrides: DesignatedHotelStarMismatchOverride[];
}

/** 星级不匹配的人眼文案（录单与换酒店共用一句，运营看到的提示不分叉）。 */
export function buildStarMismatchMessage(
  tier: SettlementTier,
  hotel: { starRating?: number | null },
): string {
  const hotelStar = hotel.starRating != null ? `${hotel.starRating}星` : '星级未标注';
  return (
    `该套餐为${SETTLEMENT_TIER_STAR_RATING[tier]}星档（${SETTLEMENT_TIER_LABEL[tier]}），` +
    `指定酒店为${hotelStar}；请改选对应档次套餐或联系运营`
  );
}

// 哪些状态视为"占用座位"（需要扣库存）/ 释放型 / 取消族终态：集合本体在 lib/order-status-sets.ts
// （全站唯一一份，审查根因 R2；对称性由 order-status-sets.test.ts 断言）。这里原名再导出，
// no-show-batch / ticket-batch / settlement-requests 等既有 import 路径不变；下面的口径注释保留原文。
export const SEAT_HOLDING_STATUSES: OrderStatus[] = SEAT_HOLDING_STATUSES_LIB;
export const SEAT_RELEASING_STATUSES: OrderStatus[] = SEAT_RELEASING_STATUSES_LIB;
export const FULFILLMENT_TERMINATING_STATUSES: OrderStatus[] = FULFILLMENT_TERMINATING_STATUSES_LIB;

// DRAFT 归类为"释放型"而非"既不占座也不释放"的中间地带（CRITICAL 修复）：
//   createOrder 唯一的建单路径（~389）永远显式写 status: PENDING_PAYMENT（扣座与建单同一事务原子发生），
//   从未有代码路径以 DRAFT 建单后才占座 —— 所以 DRAFT 状态本身从未持有真实库存。
//   若把 DRAFT 排除在 SEAT_HOLDING/SEAT_RELEASING 之外（旧版行为），admin force 可以拿它当"座位账
//   死区"套利：force H→DRAFT（宣称释放）不触发释放分支（因为 DRAFT 不在 RELEASING 集合，wasHolding
//   && isReleasing 为 false）→ sold 原地不动；再 force DRAFT→PAID 时 isNewHolding 为真、wasHolding 假
//   → 触发"非占座→占座"分支重新占座一次 → sold 又 +qty。反复横跳 H→DRAFT→PAID 每次 +qty，sold 无界
//   增长，单订单就能把某舱位账面"卖爆"（实际库存没变化，纯粹是账被做出来的）。
//   把 DRAFT 并入 SEAT_RELEASING（而不是单独拒绝 force 到 DRAFT）是安全的且对称：
//     H→DRAFT：wasHolding=true, isReleasing=true → 正常释放（座位真还给库存，账目诚实）
//     DRAFT→H：wasHolding=false, isNewHolding=true → 走"重新占座"分支，原子 CAS + 余位校验（与从
//              CANCELLED/PAYMENT_TIMEOUT 拉回占座完全同一套保护，不会超卖）
//     DRAFT→R（如 CANCELLED）：wasHolding=false → 释放→释放，短路不触碰库存（幂等，不会二次释放）
//（SEAT_RELEASING_STATUSES 本体见 lib/order-status-sets.ts，与上方一并再导出。）

// 订单落「取消族」终态 → 履约任务应被终态化（CANCELLED），而非仅靠列表查询过滤隐藏。
// 隐藏式过滤的问题：任务仍是 PENDING/IN_PROGRESS，force 把订单拉回占座态即"复活"，且统计口径数不到。
// 注意与 DRAFT 区分：DRAFT 虽在 SEAT_RELEASING_STATUSES 里（座位账口径），但不是取消族终态，
// 不应把履约任务一并终态化（force H→DRAFT→PAID 的座位来回搬移不涉及"订单被取消"语义）。
// 导出：路由层的签证矛盾硬闸要用同一份「不参与履约」口径判豁免，不另立一套。
//（FULFILLMENT_TERMINATING_STATUSES 本体见 lib/order-status-sets.ts = 释放型 − {DRAFT, REFUND_REQUESTED}，上方已再导出。）

// ── 代理自助改单窗口（下单当天）─────────────────────────────────────────
// 口径（运营负责人 + 老板 2026-09-04 拍板）：
//   代理录单出错的比例高、改起来又急，而运营本来就会拿群里的信息把每张代理单核对 2–3 遍，
//   所以**下单当天**（北京时间同一业务日）让代理自己改自家的单；**次日起**一律走改单申请审批。
//   自助口子只开给「不动钱」的四件事：航班班次纠错、订单级签证状态、换酒店、升舱。
// 为什么按业务日而不是「下单后 24 小时」：运营对单是按天做的（当天的单当天核），
//   跨天的单已经进了昨天那一轮核对与报表，再让代理静默改就对不上账了。
// 为什么改期走「纠错」语义（correction）而不是售后改期：纠错是「本来就该录成这样」，
//   不产生改期费、不撤立减、不推状态、不动任何金额 —— 代理自助永远不能动钱。
// 为什么「已签证」(HAS_VISA) 不在自助范围：那是签证岗见到签证页之后才敢盖的章，
//   代理自己说「已签证」会让这单从签证台的待送签队列里消失，直接漏送签。
export const AGENT_SELF_EDIT_STATUSES: OrderStatus[] = SEAT_HOLDING_STATUSES.filter(
  // 已出票 / 已完成：票面已经发出去了，改班次要动真票，必须走审批。
  (s) => s !== OrderStatus.TICKETED && s !== OrderStatus.COMPLETED,
);

/** 窗口关闭原因（面向界面的中文；前端直接展示，别在别处另写一套措辞）。 */
export const AGENT_SELF_EDIT_REASON = {
  NEXT_DAY: '下单当天可自助修改，次日起请提交改单申请',
  TICKETED: '已出票，请提交改单申请',
  INVOICED: '已开票，请提交改单申请',
  SETTLEMENT_LOCKED: '结算价已锁定',
  DELETED: '订单已在回收站，请联系运营',
} as const;

/** 代理自助改单窗口。until = 该业务日结束时刻（ISO），仅当订单是「今天下的」才有值。 */
export interface AgentSelfEditWindow {
  open: boolean;
  until: string | null;
  reason: string | null;
}

/** 一个业务日的长度：Asia/Shanghai 自 1991 年起无夏令时，+24h 就是当天结束，不必再走 Intl。 */
export const BUSINESS_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 纯函数：算某张单此刻还在不在「代理自助改单」窗口里。
 *
 * open = 下单业务日 == 今天（北京） 且 状态 ∈ 占座态 −{已出票, 已完成}
 *        且 三个开票位全未开 且 结算价未锁 且 不在回收站。
 * until = 下单当天时给出「今天 24:00（北京）」的 ISO，供界面倒计时；隔天的单为 null。
 *         注意 until 只表达「窗口本来到几点」，不代表 open —— 已出票/已锁价的当天单
 *         同样给 until，但 open=false，界面据 reason 说明为什么改不了。
 * reason = 关闭原因（open 时为 null）。硬性障碍（回收站/状态/开票/锁价）优先于「过了当天」，
 *         因为它们即使今天也改不了，先告诉代理真正的拦路石，别让他以为是时间问题。
 */
export function computeAgentSelfEditWindow(
  order: {
    createdAt: Date;
    status: OrderStatus;
    deletedAt?: Date | null;
    outboundInvoiced?: boolean | null;
    returnInvoiced?: boolean | null;
    systemInvoiced?: boolean | null;
    settlementLocked?: boolean | null;
  },
  now: Date = new Date(),
): AgentSelfEditWindow {
  const createdDay = businessDateISO(order.createdAt);
  const isSameBusinessDay = createdDay === businessDateISO(now);
  const until = isSameBusinessDay
    ? new Date(startOfBusinessDayUtc(order.createdAt).getTime() + BUSINESS_DAY_MS).toISOString()
    : null;

  const closed = (reason: string): AgentSelfEditWindow => ({ open: false, until, reason });

  if (order.deletedAt) return closed(AGENT_SELF_EDIT_REASON.DELETED);
  if (!AGENT_SELF_EDIT_STATUSES.includes(order.status)) {
    if (order.status === OrderStatus.TICKETED || order.status === OrderStatus.COMPLETED) {
      return closed(AGENT_SELF_EDIT_REASON.TICKETED);
    }
    return closed(`订单「${zhStatus(order.status)}」不可自助修改`);
  }
  if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
    return closed(AGENT_SELF_EDIT_REASON.INVOICED);
  }
  if (order.settlementLocked) return closed(AGENT_SELF_EDIT_REASON.SETTLEMENT_LOCKED);
  if (!isSameBusinessDay) return closed(AGENT_SELF_EDIT_REASON.NEXT_DAY);

  return { open: true, until, reason: null };
}

// ── 前台自助端点的状态闸 ────────────────────────────────────────────────
// 出行人护照资料自助补录：出票流程启动前（含处理中）可改；出票后锁定走客服。
export const SELF_EDITABLE_PASSENGER_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'PROCESSING'];
// 改签申请：已付款到已出票之间可申请。
export const CHANGE_REQUESTABLE_STATUSES: OrderStatus[] = ['PAID', 'PROCESSING', 'TICKETED'];
// 电子行程单下载：订单确认（付款）后即可（含改签中/已改签——旅客仍需凭行程单出行）。
export const ITINERARY_READY_STATUSES: OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGE_REQUESTED',
  'CHANGED',
];

// 服务端价格校验容差（CNY）：客户端提交金额与服务端权威重算金额相差超过此值则拒单（A3）
export const PRICE_TOLERANCE_CNY = 1.0;

// 护照有效期规则（相对出发日）— 反馈：签证岗
export const PASSPORT_EXPIRY_SURCHARGE_DAYS = 180; // 不足 6 个月加收附加费
export const NEAR_EXPIRY_SURCHARGE_CNY = 200; // 每位临期乘客附加费
// 升舱差价兜底（¥/程/座）：套餐 businessUpgradeCnyPerLeg=null（跟随航班）但两趟都没绑到航班时使用，
// 与 Flight.businessUpgradeCnyPerLeg 的 schema 默认值一致，绝不让升舱派生出 0/裸价。
export const DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG = 700;

/**
 * 「这张单是按日历上的哪一格成交的」= 定价键。
 *
 * 换人重算是「日历比日历」：只有**同一格**的今昔两个价相减，量出来的才是「日历动了多少」。
 * 而这张单在成交之后可能被改过档（套餐改档换了 bundleId → 档次/晚数变了）或改过期
 *（改期把出发日挪走了，行价按设计冻结、差额另有调价行收），此时「今天的这一格」已经不是
 * 「成交那一格」—— 再相减等于把改档/改期的价差当成日历浮动，对着已经收过一次的差额再收一次。
 * 因此基准戳里连定价键一起盖章，换人当天先比键：键变了就不重算（PRICING_KEY_CHANGED）。
 */
export type SwapCalendarKey =
  | {
      source: 'BUNDLE_SETTLEMENT_CALENDAR';
      /**
       * 套餐日历的四维键：航线 × 档次 × 晚数 × 去程出发本地日。
       * 航线加进键里，套餐换绑到别的航线（改档到另一条线的套餐）同样算「换了一格」，不按日历重算。
       */
      routeKey: string;
      tier: string;
      nights: number;
      departDate: string;
    }
  | {
      source: 'FLIGHT_SETTLEMENT_CALENDAR';
      /** 机票日历逐航段的键：航班号 × 该段出发地本地日（往返各一条）。 */
      legs: Array<{ flightNumber: string; departDate: string }>;
    };

/**
 * 定价键 → 可直接比较的指纹字符串；null → null（判不出键，调用方一律 fail-closed）。
 * 机票多航段按「航班号@出发日」排序后拼，行顺序变化不当作键变（同一组航段就是同一格）。
 */
export function calendarKeyFingerprint(key: SwapCalendarKey | null | undefined): string | null {
  if (!key) return null;
  if (key.source === 'BUNDLE_SETTLEMENT_CALENDAR') {
    return `BUNDLE|${key.routeKey}|${key.tier}|${key.nights}|${key.departDate}`;
  }
  const legs = key.legs
    .map((leg) => `${leg.flightNumber}@${leg.departDate}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `FLIGHT|${legs.join(',')}`;
}

/**
 * 落库的 JSON（基准戳 metadata.calendarKey / 上一次换人行的 calendarDetail.calendarKey）→ 定价键。
 * 形状不完整一律 null（缺一维就比不出键有没有变，宁可不重算）。
 */
export function readCalendarKey(raw: unknown): SwapCalendarKey | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  if (obj.source === 'BUNDLE_SETTLEMENT_CALENDAR') {
    const tier = str(obj.tier);
    const departDate = str(obj.departDate);
    const nights = typeof obj.nights === 'number' && Number.isFinite(obj.nights) ? obj.nights : null;
    if (tier == null || departDate == null || nights == null) return null;
    // 航线这一维是本批（结算价日历加航线）才盖进键里的。更早落库的键没有它——那时系统只有
    // 澳门-岘港一条线，迁移也把日历存量行统一回填成 MFM-DAD；这里对存量键做同一个回填读法，
    // 才不会让所有老单在换人当天一律撞 PRICING_KEY_CHANGED。⚠ 仅限回读**已落库**的键，
    // 取价侧派生不到航线绝不用它兜底。
    const routeKey = str(obj.routeKey) ?? LEGACY_ROUTE_KEY;
    return { source: 'BUNDLE_SETTLEMENT_CALENDAR', routeKey, tier, nights, departDate };
  }
  if (obj.source === 'FLIGHT_SETTLEMENT_CALENDAR') {
    if (!Array.isArray(obj.legs) || obj.legs.length === 0) return null;
    const legs: Array<{ flightNumber: string; departDate: string }> = [];
    for (const item of obj.legs) {
      if (item == null || typeof item !== 'object') return null;
      const leg = item as Record<string, unknown>;
      const flightNumber = str(leg.flightNumber);
      const departDate = str(leg.departDate);
      if (flightNumber == null || departDate == null) return null;
      legs.push({ flightNumber, departDate });
    }
    return { source: 'FLIGHT_SETTLEMENT_CALENDAR', legs };
  }
  return null;
}

/**
 * 基准那一格 vs 换人当天这一格：一样 → null（可以继续按日历重算）；
 * 不一样（含基准没记键）→ 一份带两把键的明细，调用方据此落 PRICING_KEY_CHANGED 并留痕。
 */
export function keyChangedDetail(
  basisKey: SwapCalendarKey | null,
  todayKey: SwapCalendarKey,
): Record<string, unknown> | null {
  const basisFp = calendarKeyFingerprint(basisKey);
  const todayFp = calendarKeyFingerprint(todayKey);
  if (basisFp != null && basisFp === todayFp) return null;
  return {
    note: '本单成交后改过档 / 改过期，定价键已变，不按日历重算',
    basisKey,
    todayKey,
  };
}

export interface OrderRequester {
  userId: string;
  role: UserRole;
  /** 当前登录代理的 agentId（如果是 AGENT） */
  agentId?: string;
  /** 显式区分系统操作（支付回调 / cron）与真实用户，而非靠 userId 字符串前缀 */
  actorType?: 'USER' | 'SYSTEM';
}

/**
 * 游客下单上下文（免登录，A1）。createOrder 收到 guest 时：
 * userId=null、agentId=null、无佣金/结算（等同直客无代理单）。
 */
export interface GuestRequester {
  guest: { name: string; phone: string; email?: string };
}

export type CapRequester = { role: UserRole | null } | GuestRequester;

export function isGuestRequester(r: CapRequester): r is GuestRequester {
  return 'guest' in r;
}

/** 前台散客单的支付超时（未支付即自动释放机位的时长）。 */
export const RETAIL_PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

/** 后台/代理录入身份：这些认证角色录的单默认「肯定要飞」，不设支付超时。 */
export const STAFF_ENTRY_ROLES: readonly UserRole[] = [UserRole.AGENT, UserRole.STAFF, UserRole.ADMIN];

/**
 * 内部录单的随机档口径：随机档是需求池，不用具体酒店的超售上限闸单；
 * 缺口由房控审计、每日加房清单和提醒引擎接手。具体酒店仍使用原 cap。
 */
export const RANDOM_TIER_INTERNAL_NO_CAP = Number.POSITIVE_INFINITY;

/**
 * 支付超时口径（0708 业务定）：机位是否会因未支付被自动退回，只看**服务端认证身份**。
 *   - 后台/代理录入（AGENT / STAFF / ADMIN，含批量建单）→ true：不设支付超时（paymentExpiresAt=null），
 *     机位永不自动释放。这类订单默认「肯定要飞」、多为 T+1 线下结算；要退机位必须由运营手动取消/改状态。
 *   - 前台散客（匿名游客 / 登录 CUSTOMER）→ false：保留 30 分钟未支付自动释放，防匿名占坑锁库存。
 * 用角色允许名单（而非「非 CUSTOMER」）判定：未知/新增角色默认按散客处理（保留超时），是更安全的兜底。
 * 绝不信任 body 里的字段——POST /orders 是 optionalAuthenticate 公开可达，身份必须来自 JWT / 游客上下文。
 */
export function isStaffEnteredOrder(requester: CapRequester): boolean {
  if (isGuestRequester(requester)) return false;
  return requester.role != null && STAFF_ENTRY_ROLES.includes(requester.role);
}

/**
 * 统一解析内部录单的酒店超售 cap。
 * AGENT、STAFF、ADMIN 都属于内部录单；游客/CUSTOMER/未登录不传 cap，保持对外硬闸。
 * quote、createOrder 和批量手工价预定价必须共用这一处身份口径。
 */
export async function resolveHotelOversellCap(
  requester?: CapRequester,
): Promise<number | undefined> {
  if (!requester || !isStaffEnteredOrder(requester)) return undefined;
  return getHotelOversellCapRooms();
}

/**
 * 解析订单的代理归属（登录用户）。佣金链路在订单转 PAID 时按 order.agentId 计算，
 * 因此 ADMIN/STAFF 代下单显式归属的代理，会与该代理本人下单产生完全相同的佣金链。
 *
 *   - AGENT：只能归属自己（忽略 body.agentId，代理不能替他人记单）。
 *   - ADMIN / STAFF：可显式传 body.agentId 归属某代理；先校验存在且 isActive，
 *     否则 404（不存在）/ 400（已停用）。不传则记为直客（null）。
 *   - 其他角色（如 CUSTOMER 自助下单）：无代理归属 → null。
 *
 * 导出供单测复用。
 */
export async function resolveOrderAgentId(
  requester: OrderRequester,
  bodyAgentId: string | undefined,
): Promise<string | null> {
  if (requester.role === 'AGENT') {
    return requester.agentId ?? null;
  }

  if (requester.role === 'ADMIN' || requester.role === 'STAFF') {
    if (!bodyAgentId) return null;
    const agent = await prisma.agent.findUnique({
      where: { id: bodyAgentId },
      select: { id: true, isActive: true },
    });
    if (!agent) {
      throw new NotFoundError(`指定的代理不存在：${bodyAgentId}`);
    }
    if (!agent.isActive) {
      throw new BadRequestError('指定的代理已停用，无法归属订单');
    }
    return agent.id;
  }

  return null;
}

/**
 * YYYY-MM-DD + 天数 → YYYY-MM-DD（纯函数，UTC 历法推算，避免时区跨日错位）。
 * 用于套餐回程/退房日期 = 出发日期 + 住宿晚数。非法输入原样返回（调用方另有兜底）。
 */
export function addDaysToYmd(ymd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dt.getTime())) return ymd;
  dt.setUTCDate(dt.getUTCDate() + Math.trunc(days));
  return dt.toISOString().slice(0, 10);
}

/**
 * 录单调价/加项 → 一条独立 OrderItem 定价行（计入 subtotal/total）。
 *   - 金额可正可负（整数 CNY）：正=加钱（补收杂费/变更改期费…），负=减价（优惠/让利）。
 *   - kind 复用现有枚举：正 → FEE、负 → DISCOUNT，让财务分类诚实（不新增枚举/迁移）。
 *   - 描述可读（详情页自然显示），如「价格调整：补收杂费（+¥700）」/「价格调整：优惠（−¥200）」。
 *   - metadata 打标 priceAdjustment=true + reasonCode/reasonText，供审计与后续识别。
 *   - adj.reasonCode 类型收窄为纯财务四类（DISCOUNT/MISC_FEE/CHANGE/OTHER）；label 查表用
 *     PRICE_ADJUSTMENT_REASON_LABEL（覆盖历史三个已下线原因值，避免旧订单行 label 缺失）。
 * 导出供单测复用。
 */
export function buildPriceAdjustmentItem(adj: {
  amountCny: number;
  /**
   * 人工可录入的四类 + 专用端点自己产生的 endpoint-only 原因码（ROOM_DIFF / SETTLEMENT /
   * RETURN_LEG_CANCEL_FEE …）。收窄仍然发生在**入口**：面向 HTTP 的 priceAdjustmentSchema /
   * orderPriceAdjustmentBodySchema 只认四类，运营下拉里永远看不到 endpoint-only 的码。
   */
  reasonCode: PriceAdjustmentReasonDisplay;
  reasonText?: string;
  /**
   * 单价口径注记（批量按人调价专用，如「每人 ¥700 × 2 人」）。
   * 落库金额是乘出来的合计，光看「+¥1400」事后没人还原得出「每人多少 × 几个人」——
   * 财务对账、客人问「这笔怎么来的」都要靠这一句。单单调价不传 → 描述一字不变。
   */
  unitNote?: string;
}): {
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  totalCostCny: number;
  metadata: Record<string, unknown>;
} {
  const label = PRICE_ADJUSTMENT_REASON_LABEL[adj.reasonCode];
  const reasonText = adj.reasonText?.trim() || undefined;
  const signed = `${adj.amountCny > 0 ? '+' : '−'}¥${Math.abs(adj.amountCny)}`;
  const suffix = reasonText ? `：${reasonText}` : '';
  // 单价注记紧跟合计金额，说明这笔钱是怎么乘出来的；不传即整单口径，描述与此前逐字一致。
  const unitNote = adj.unitNote?.trim() ? `（${adj.unitNote.trim()}）` : '';
  return {
    kind: adj.amountCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
    description: `价格调整：${label}（${signed}）${unitNote}${suffix}`,
    quantity: 1,
    unitPrice: adj.amountCny,
    amount: adj.amountCny,
    // 纯价格调整行无成本侧（优惠/补收杂费/调价都不产生采购成本）→ 显式落 0，不留 NULL。
    // 留 NULL 会被毛利明细当「缺成本」，把整单毛利拖成「未知」，污染财务视图。
    totalCostCny: 0,
    metadata: {
      priceAdjustment: true,
      reasonCode: adj.reasonCode,
      reasonText: reasonText ?? null,
    },
  };
}

/**
 * 规则命中的固定立减行：金额、规则类型和每人金额都写入 metadata 快照。
 * 订单展示/售后只认这份快照，不因运营之后修改规则而漂移。
 */
export function buildSettlementDiscountItem(input: {
  hit: SettlementDiscountHit;
  pax: number;
  bundleId?: string | null;
}): {
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  totalCostCny: number;
  metadata: Record<string, unknown>;
} {
  const totalCny = input.hit.discountPerPersonCny * input.pax;
  return {
    kind: OrderItemKind.DISCOUNT,
    description: `同业立减 ¥${input.hit.discountPerPersonCny}/人 × ${input.pax}人`,
    quantity: 1,
    unitPrice: -totalCny,
    amount: -totalCny,
    totalCostCny: 0,
    metadata: {
      priceAdjustment: true,
      reasonCode: 'DISCOUNT',
      settlementDiscount: true,
      ruleId: input.hit.ruleId,
      ruleKind: input.hit.kind,
      discountPerPersonCny: input.hit.discountPerPersonCny,
      pax: input.pax,
      bundleId: input.bundleId ?? null,
    },
  };
}

/**
 * 本单结算总价 → 一条系统生成的 SETTLEMENT 差额行（计入 subtotal/total）。
 *   - 业务：代理单与代理谈定整单一口价（结算价），系统照此收钱；服务端权威定价不破坏——
 *     **绝不改各明细行价格**，只按「结算价 − 权威合计」追加一条差额行（原价/差额/原因留痕可审计）。
 *   - diffCny 可正可负（最多两位小数）：正 → FEE、负 → DISCOUNT（与录单调价同口径，财务分类诚实）。
 *   - 描述可读，如「价格调整：代理结算价（−¥5684）」；金额为 0 的场景由调用方跳过（不生成行）。
 *   - metadata 打标 priceAdjustment=true + reasonCode='SETTLEMENT'（只能系统生成，不在人工下拉里）
 *     + settlementPrice=true + 权威合计/结算价快照，供审计与对账识别。
 * 导出供单测复用。
 */
export function buildSettlementTotalItem(input: {
  diffCny: number;
  authoritativeTotalCny: number;
  settlementTotalCny: number;
  /**
   * 建单当天的**日历每人价**（未减代理立减）与**每人立减**。
   * 只有「结算价日历自动取价」这条路会带；手工结算总价 / 每人结算价一律不带。
   *
   * 为什么要单独落这两个数（换人重算结算价 2026-09 拍板）：日历取价此前只把整单总价写进
   * settlementTotalCny，事后没人还原得出「当时每人是按哪个日历价成交的」——
   * 加项、单房差、婴儿同价都揉在总价里，÷ 人数只是估算。换人时要拿它跟**换人当天**的日历价
   * 比差额（日历比日历，见 resolveSwapRepriceQuote），估算不够用。纯加字段、不改任何金额，
   * 存量单读不到就退回保守分支（NOT_CALENDAR_PRICED，只收换人费不动结算价）。
   */
  calendarPerPaxCny?: number | null;
  calendarDiscountPerPaxCny?: number | null;
  /**
   * 建单**当时是否真的减了代理立减**（复审 H3）。
   *
   * 建单侧只有在「没有任何手工价通道」时才自动命中立减（见 createOrder 的
   * hasManualSettlementChannel）；换人侧却无条件再算一次今天的立减 —— 两边不对称，
   * 手工价单会被平白多减一次立减，或者反过来把立减当成日历涨价再收一遍。
   * 因此把「建单到底减没减」这一位随基准戳一起盖章：换人时按这一位决定要不要减今天的立减，
   * 保证减法两边同口径（基准减了 → 今天也减；基准没减 → 今天也不减）。
   */
  calendarDiscountApplied?: boolean;
  /**
   * 建单那次取价用的**日历定价键**（档次×晚数×出发日 / 逐航段航班号×出发日，见 SwapCalendarKey）。
   *
   * 光有每人价还不够：这张单成交之后可能被改档（换 bundleId → 档次晚数变了）或改期（出发日挪了），
   * 那时「今天的日历价」查的已经是另一格 —— 拿它跟成交那格的价相减，就把改档/改期的价差
   * 当成日历浮动又收了一遍（改档/改期本身早就各自落过差额行）。把键一起盖章，换人当天先比键。
   * 与 calendarPerPaxCny 同生共死：取价口径明确（能算出每人价）才有键，缺一不给。
   */
  calendarKey?: SwapCalendarKey | null;
}): {
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  totalCostCny: number;
  metadata: Record<string, unknown>;
} {
  const signed = `${input.diffCny > 0 ? '+' : '−'}¥${Math.abs(input.diffCny)}`;
  return {
    kind: input.diffCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
    description: `价格调整：${PRICE_ADJUSTMENT_REASON_LABEL.SETTLEMENT}（${signed}）`,
    quantity: 1,
    unitPrice: input.diffCny,
    amount: input.diffCny,
    // 结算价差额行是纯价格调整（把整单收敛到谈定价），无成本侧 → 显式落 0，不留 NULL。
    totalCostCny: 0,
    metadata: {
      priceAdjustment: true,
      reasonCode: 'SETTLEMENT',
      settlementPrice: true,
      authoritativeTotalCny: input.authoritativeTotalCny,
      settlementTotalCny: input.settlementTotalCny,
      // 日历成交的每人基准（见入参注释）；手工结算价不带这几个键。
      ...(input.calendarPerPaxCny != null
        ? {
            calendarPerPaxCny: input.calendarPerPaxCny,
            calendarDiscountPerPaxCny: input.calendarDiscountPerPaxCny ?? 0,
            calendarDiscountApplied: input.calendarDiscountApplied === true,
            // 定价键（改档/改期后换人据此 fail-closed，见入参注释）。
            ...(input.calendarKey ? { calendarKey: input.calendarKey } : {}),
          }
        : {}),
    },
  };
}

/**
 * 结算价日历取价审计 → 建单当天的「每人日历基准」（换人重算结算价的差价基准）。
 *
 * 只认口径明确的两种形状，其余一律返回 null（宁可不落基准，也不落一个估算出来的数）：
 *   · 套餐日历（source=SETTLEMENT_CALENDAR）：**恰好一条** lines 时取该行 pricePerPersonCny；
 *     多条行分不清换下去的这个人算哪一条（换人重算本身也在这一步跳过，见 resolveSwapRepriceQuote）。
 *   · 机票日历（source=FLIGHT_SETTLEMENT_CALENDAR）：Σ 各航段 pricePerPersonCny（往返各查各的价）。
 * 每人立减取自动立减命中的 perPersonCny（恰好一条命中时才认，同理由）。
 *
 * 返回的是**未减立减的裸日历价 + 每人立减**两个数，与 resolveSwapRepriceQuote 换人当天的取法
 * 逐项对齐：基准 = perPaxCny − discountPerPaxCny。
 * 第三个数 discountApplied =「这一单当时到底减没减立减」（复审 H3）：建单侧只在没有任何手工价
 * 通道时才自动命中立减，换人侧必须照着这一位决定今天减不减，否则同一笔立减会被多减/多收一次。
 * 第四项 key =「这次取的是日历上的哪一格」（档次×晚数×出发日 / 逐航段航班号×出发日）：
 * 改档 / 改期之后那一格已经换人了，换人当天先比键，键变了就不重算（PRICING_KEY_CHANGED）。
 * 键这一维读不出来 → 整份基准返回 null（只有价没有键的基准戳，换人时照样用不了）。
 *
 * 两处调用共用这一份口径：① 建单当场（autoDiscount = 本次命中的立减）；
 * ② 存量单换人时从建单审计里回读（autoDiscount = 审计 blob 里的 autoDiscount 快照，
 *    建单只在真减了立减时才写这个键，见 createOrder 的 settlementCalendarAudit 组装）。
 */
export function resolveCalendarPerPaxBasis(
  calendarAudit: Record<string, unknown> | null,
  autoDiscount: AutoDiscountSummary | null,
): {
  perPaxCny: number;
  discountPerPaxCny: number;
  discountApplied: boolean;
  /** 这次取价用的是日历上的哪一格（换人当天先比这个键，见 SwapCalendarKey）。 */
  key: SwapCalendarKey;
} | null {
  if (!calendarAudit) return null;
  const lines = Array.isArray(calendarAudit.lines)
    ? (calendarAudit.lines as Array<Record<string, unknown>>)
    : [];
  if (lines.length === 0) return null;
  const perPax = (line: Record<string, unknown>): number | null => {
    const v = line.pricePerPersonCny;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  };
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  let perPaxCny: number | null = null;
  // 定价键与每人价同生共死：键这一维缺了就整份基准不给 —— 只有价没有键，换人当天照样
  // fail-closed，落一个用不上的基准戳反而让人以为「这单能重算」。
  let key: SwapCalendarKey | null = null;
  if (calendarAudit.source === 'SETTLEMENT_CALENDAR') {
    if (lines.length !== 1) return null;
    perPaxCny = perPax(lines[0]);
    const tier = str(lines[0].tier);
    const departDate = str(lines[0].departDate) ?? str(calendarAudit.departDate);
    const nights =
      typeof lines[0].nights === 'number' && Number.isFinite(lines[0].nights)
        ? (lines[0].nights as number)
        : null;
    if (tier != null && nights != null && departDate != null) {
      // 本批之前的取价审计行没有 routeKey（当时只有一条线）：按迁移同一口径读成 MFM-DAD。
      // 新单的审计行一律带 routeKey（resolveBundleSettlementCalendarTotal 派生不到就不取价）。
      const routeKey = str(lines[0].routeKey) ?? LEGACY_ROUTE_KEY;
      key = { source: 'BUNDLE_SETTLEMENT_CALENDAR', routeKey, tier, nights, departDate };
    }
  } else if (calendarAudit.source === 'FLIGHT_SETTLEMENT_CALENDAR') {
    let sum = 0;
    const legs: Array<{ flightNumber: string; departDate: string }> = [];
    for (const line of lines) {
      const v = perPax(line);
      if (v == null) return null;
      sum = round2(sum + v);
      const flightNumber = str(line.flightNumber);
      const departDate = str(line.departDate);
      if (flightNumber == null || departDate == null) return null;
      legs.push({ flightNumber, departDate });
    }
    perPaxCny = sum;
    key = { source: 'FLIGHT_SETTLEMENT_CALENDAR', legs };
  }
  if (perPaxCny == null || !(perPaxCny > 0) || key == null) return null;
  const hits = autoDiscount?.hits ?? [];
  // 立减命中多条 = 多条套餐行，上面已经拦掉；这里只可能是 0 或 1 条。
  const discountPerPaxCny = hits.length === 1 ? round2(hits[0].perPersonCny) : 0;
  // 「减没减」看的是有没有命中行，不是金额是否为正：¥0 的立减规则也算减过（今天照样要减）。
  return { perPaxCny, discountPerPaxCny, discountApplied: hits.length > 0, key };
}

/**
 * 每人结算价 → 该乘客名下的 SETTLEMENT 差额行（计入 subtotal/total，事务内回填 passengerId）。
 *   - 业务（票务反馈）：同单多人结算价不同，录单逐人填价。落库仍走差额模型，不是手填价：
 *     服务端取「min(每人结算价) × 人数」走整单 SETTLEMENT 收敛，本行只挂「该人价 − min」的
 *     非负差额（=0 的乘客不生成行），订单详情「每人结算价」表按既有派生口径还原逐人价。
 *   - metadata 打标同整单 SETTLEMENT（priceAdjustment + reasonCode='SETTLEMENT' + settlementPrice）
 *     外加 perPassenger=true + 该人结算价/基准价快照 + perPaxIndex（乘客在提交数组中的序号，
 *     事务内据此把行挂到对应 passengerId 上）。
 * 导出供单测复用。
 */
export function buildPerPassengerSettlementItem(input: {
  diffCny: number;
  settlementPerPaxCny: number;
  basePerPaxCny: number;
  perPaxIndex: number;
}): {
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  totalCostCny: number;
  metadata: Record<string, unknown>;
} {
  return {
    kind: OrderItemKind.FEE,
    description: `价格调整：${PRICE_ADJUSTMENT_REASON_LABEL.SETTLEMENT}（+¥${input.diffCny}）`,
    quantity: 1,
    unitPrice: input.diffCny,
    amount: input.diffCny,
    // 与整单 SETTLEMENT 行同口径：纯价格收敛，无成本侧 → 显式落 0。
    totalCostCny: 0,
    metadata: {
      priceAdjustment: true,
      reasonCode: 'SETTLEMENT',
      settlementPrice: true,
      perPassenger: true,
      settlementPerPaxCny: input.settlementPerPaxCny,
      basePerPaxCny: input.basePerPaxCny,
      perPaxIndex: input.perPaxIndex,
    },
  };
}

/**
 * 前台展示价兜底校验（S1）：expectedTotalCny 存在且与「服务端权威商品价」偏差 > 容差（PRICE_TOLERANCE_CNY，
 * 1 元，容忍逐行取整）→ 抛 PRICE_CHANGED（前台提示刷新重下，绝不静默按新价多收）。
 * 缺省（admin/批量/quote 不带 expectedTotalCny）→ 直接返回，跳过比对（录单路径不受影响）。
 * 导出供单测（匹配通过 / 偏差拒单 / 不传跳过）与 createOrder 共用同一口径，避免漂移。
 */
export function assertDisplayedTotalMatches(
  productTotalCny: number,
  expectedTotalCny?: number | null,
): void {
  if (expectedTotalCny == null) return;
  if (Math.abs(productTotalCny - expectedTotalCny) > PRICE_TOLERANCE_CNY) {
    throw new PriceChangedError();
  }
}

/**
 * 是否给本单自动加散客 RETAIL 立减。**下单（createOrder）与试算（quoteOrder）必须同一口径**，
 * 否则录单页看到的系统价里有立减、真下单时却没有（或反过来），运营对着两个数字无从判断。
 *
 * 口径：
 *   · 有归属代理 → 不加（代理走 AGENT 立减那条链）。createOrder 传的是 resolveOrderAgentId
 *     解析后的权威 agentId，不是 body 里那个原始值。
 *   · 任一「手工价通道」在场 → 不加：手工优惠/团队议价/手填结算总价都视为整体替代方案，
 *     再叠自动立减就是双重砸价（与代理侧 hasManualSettlementChannel 判定同哲学）。
 *
 * 入参用可选字段而非具体 Body 类型：quote 的请求体目前还不带这三个手工通道字段（缺省 undefined
 * ⇒ 与今天行为一致），等它带上时两边自动一起收紧，不会再分叉。
 */
export function shouldApplyRetailSettlementDiscount(input: {
  agentId?: string | null;
  priceAdjustment?: unknown;
  settlementTotalCny?: number | null;
  perPassengerSettlementCny?: number[] | null;
  flightSettlementPriceCny?: number | null;
}): boolean {
  if (input.agentId) return false;
  return (
    input.priceAdjustment === undefined &&
    input.settlementTotalCny === undefined &&
    input.perPassengerSettlementCny === undefined &&
    input.flightSettlementPriceCny === undefined
  );
}

/**
 * 事后补收单房差 → 一条 FEE 定价行（计入 subtotal/total）。
 *   - 金额 = perNightCny × nights（都为正整数 CNY；校验由 roomSupplementBodySchema 完成）。
 *   - 描述可读「补收单房差 ¥X/晚 × N晚」（备注不拼进描述，另落 metadata.note 与审计流水 note）。
 *   - metadata 打标 priceAdjustment=true + reasonCode='ROOM_DIFF' + perNightCny/nights，
 *     便于识别与后续对账；label 展示走 PRICE_ADJUSTMENT_REASON_LABEL['ROOM_DIFF']。
 * 导出供单测复用（金额计算 / 描述 / metadata）。
 */
export function buildRoomSupplementItem(input: {
  perNightCny: number;
  nights: number;
  note?: string;
}): {
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  metadata: Record<string, unknown>;
} {
  const amount = input.perNightCny * input.nights;
  const note = input.note?.trim() || undefined;
  return {
    kind: OrderItemKind.FEE,
    description: `补收单房差 ¥${input.perNightCny}/晚 × ${input.nights}晚`,
    quantity: 1,
    unitPrice: amount,
    amount,
    metadata: {
      priceAdjustment: true,
      reasonCode: 'ROOM_DIFF',
      perNightCny: input.perNightCny,
      nights: input.nights,
      note: note ?? null,
    },
  };
}

// ── 售后升舱（经济舱 → 商务舱）辅助 ────────────────────────────────────────
/** 舱位中文名（升舱拒绝文案 / 描述快照刷新用）。 */
export const CABIN_ZH_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

/**
 * 升舱差价（CNY，整数）= 每人每航段差价 × 该行人数。
 * 一条 FLIGHT 行 = 一个航段，故不再乘航段数（往返是两条行，各自升舱各自计价）。
 * 纯函数，导出供单测复用。
 */
export function computeCabinUpgradeDiffCny(upgradeCnyPerLeg: number, quantity: number): number {
  return Math.max(0, Math.trunc(upgradeCnyPerLeg)) * Math.max(0, Math.trunc(quantity));
}

/**
 * 升舱后刷新订单行的描述快照。
 *
 * description 是建单时写死的文本（列表/详情/导出都直接显示它），不刷新的话升完舱仍写着「经济舱」。
 * 口径：把描述里的「经济舱」（含「超级/高端/豪华经济舱」写法，整体吃掉前缀，不留「超级商务舱」）
 * 替换为「商务舱」；一处都替换不到（描述里本来就没写舱位）则在末尾追加「 · 商务舱」，
 * 保证结果里一定看得见新舱位。
 * 纯函数，导出供单测复用。
 */
export const ECONOMY_CABIN_TEXT_RE = /(?:超级|高端|豪华)?经济舱/g;
export function buildUpgradedCabinDescription(description: string): string {
  if (ECONOMY_CABIN_TEXT_RE.test(description)) {
    // 带 /g 的正则有 lastIndex 状态，test 后必须归零，否则下次调用会从中途开始匹配。
    ECONOMY_CABIN_TEXT_RE.lastIndex = 0;
    return description.replace(ECONOMY_CABIN_TEXT_RE, '商务舱');
  }
  ECONOMY_CABIN_TEXT_RE.lastIndex = 0;
  if (description.includes('商务舱')) return description;
  return `${description} · 商务舱`;
}

/** 补房差/换酒店成本口径：每晚成本取值来源（供 metadata.costSource 与审计留痕）。 */
export type RoomCostSource = 'ITEM_SNAPSHOT' | 'PRODUCT' | 'ZERO';

/**
 * 补收单房差 FEE 行的成本口径（毛利真账）：新增计费房数 × 每晚成本 × 晚数。
 *   - 新增计费房数 addedRooms = 新旧 roomsBilled 之差（≤0 = 本次只收差价不增房 → 成本 0）。
 *   - 晚数 nights 与建行描述「¥X/晚 × N晚」的 N 同源（都来自补收入参）。
 *   - 每晚成本三级回退：① 该单酒店/套餐行下单时的成本快照 unitCostCny（每间每晚）
 *     → ② 现行房型产品 costPriceCny → ③ 都没有 = 0（如实报 0，不虚构成本）。
 *   - costSource 记来源；addedRooms≤0 或无任何成本数据 → 'ZERO'。
 * 纯函数，导出供单测复用（三级回退 + 增房差 + 无增房归零）。
 */
export function resolveRoomSupplementCost(input: {
  /** 订单行下单时的每间每晚成本快照（HOTEL 行有；BUNDLE 行建单未快照 → null）。 */
  snapshotUnitCostCny?: number | null;
  /** 现行房型产品成本价（回退口径）。 */
  productCostPriceCny?: number | null;
  nights: number;
  addedRooms: number;
}): { totalCostCny: number; costSource: RoomCostSource } {
  if (input.addedRooms <= 0) return { totalCostCny: 0, costSource: 'ZERO' };
  let perNight: number;
  let costSource: RoomCostSource;
  if (input.snapshotUnitCostCny != null) {
    perNight = input.snapshotUnitCostCny;
    costSource = 'ITEM_SNAPSHOT';
  } else if (input.productCostPriceCny != null) {
    perNight = input.productCostPriceCny;
    costSource = 'PRODUCT';
  } else {
    perNight = 0;
    costSource = 'ZERO';
  }
  return {
    totalCostCny: Math.round(perNight * input.nights * input.addedRooms),
    costSource,
  };
}

/**
 * 换酒店后 HOTEL 行成本重打快照（毛利真账）：按新房型成本价重算，口径对齐建单时的
 * HOTEL 行快照公式（unitCostCny = 每间每晚成本；totalCostCny = 每间每晚 × 晚数 × 房数）。
 *   - 新房型未录成本价（costPriceCny 为 NULL）→ 两栏都写 null（真缺数据，如实报缺，不落 0 虚高）。
 *   - BUNDLE 行不走本函数（其 quantity≠晚数、totalCostCny 是整包地面成本）——
 *     换酒店时按住宿那一项的差额挪，见 item-cost-snapshot.computeSwapBundleCostSnapshot。
 * 纯函数，导出供单测复用（重算 + null 语义）。
 */
export function computeSwapHotelCostSnapshot(input: {
  newCostPriceCny?: number | null;
  /** 晚数（HOTEL 行 quantity）。 */
  nights: number;
  /** 计费房数（roomsBilled，支持 0.5 间）。 */
  rooms: number;
}): { unitCostCny: number | null; totalCostCny: number | null } {
  if (input.newCostPriceCny == null) return { unitCostCny: null, totalCostCny: null };
  return {
    unitCostCny: input.newCostPriceCny,
    totalCostCny: Math.round(input.newCostPriceCny * input.nights * input.rooms),
  };
}

/**
 * 订单详情补录 HOTEL/VISA 的收入与成本快照公式。
 * 售价（unitPriceCny）和成本（costPriceCny）是两条独立数据流：售价可以被运营手改，
 * 成本始终按产品成本快照计算；产品没有成本时两项成本都保持 null。
 */
export function computeGroundItemAmounts(input: {
  kind: 'VISA' | 'HOTEL';
  unitPriceCny: number;
  quantity: number;
  rooms?: number;
  costPriceCny: number | null;
}): { amount: number; unitCostCny: number | null; totalCostCny: number | null } {
  const multiplier = input.kind === 'HOTEL' ? (input.rooms ?? 1) : 1;
  const amount = Math.round(input.unitPriceCny * input.quantity * multiplier);
  if (input.costPriceCny == null) {
    return { amount, unitCostCny: null, totalCostCny: null };
  }
  return {
    amount,
    unitCostCny: input.costPriceCny,
    totalCostCny: Math.round(input.costPriceCny * input.quantity * multiplier),
  };
}

/** 录入默认价：有成本就带出成本；无成本必须由录入人显式填写售价。 */
export function resolveGroundItemUnitPrice(input: {
  requestedUnitPriceCny?: number;
  costPriceCny: number | null;
  label: string;
}): number {
  if (input.requestedUnitPriceCny != null) return input.requestedUnitPriceCny;
  if (input.costPriceCny == null) {
    throw new BadRequestError(`该${input.label}产品没有成本价，请手动填写售价`);
  }
  return input.costPriceCny;
}

/**
 * 判定「本单是否有回程航段」——纯函数，与 determineFlightLegs 同一口径
 *（带班次的 FLIGHT 行按 departureTime 升序，存在第 2 段 = 有回程）。
 * 抽出来是为了让物化列 Order.hasReturnLeg 的写入口径可单测，不必起库。
 */
export function resolveHasReturnLeg(items: ReadonlyArray<FlightLegItem>): boolean {
  return determineFlightLegs(items).returnScheduleId !== null;
}

/**
 * 把 Order.hasReturnLeg 物化列同步到当前订单行的真实结构。
 *
 * **必须在同一事务内调用**，且调用点要覆盖所有「增删 FLIGHT 行 / 改 flightScheduleId」的写路径
 * —— 列一旦与订单行脱钩，「回程未开」筛选与单程/往返筛选就会静默给错清单（漏单比多单更糟）。
 * 幂等：重复调用只是把同一个值再写一遍，可安全用作自愈。
 */
export async function syncOrderHasReturnLeg(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<boolean> {
  const items = await tx.orderItem.findMany({
    where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
    select: {
      flightScheduleId: true,
      flightSchedule: { select: { departureTime: true, departureTz: true } },
    },
  });
  const hasReturnLeg = resolveHasReturnLeg(items);
  await tx.order.update({ where: { id: orderId }, data: { hasReturnLeg } });
  return hasReturnLeg;
}

/**
 * 把 Order.legFlag 物化列同步到 FLIGHT 行 metadata 的真实状态。
 *
 * 真源永远是行上的快照（noShow / returnReleased / returnRestored / returnVoidedFinal）；
 * 本列只是为了让列表筛选与导出**筛得出来** —— Prisma 的 where 表达不了「关联行的 JSON 里
 * 某个键存在、且它的 at 比另一个键的 at 新」，不物化就只能把全表拉进内存现算。
 *
 * 派生**完全委托** orders.leg-status 的 deriveLegStatus —— 导出列「航段状态」用的就是它，
 * 两边各写一套判断迟早会漂移（本列曾经漏了「取消航段」这一态：取消回程后 legFlag 停在 NONE / NO_SHOW，
 * 导出列却已经写着「回程已作废」，同一张单在筛选和导出里对不上）。
 *
 * 单行状态 → 物化列的映射（优先级同 deriveLegStatus：作废 > 已释放 > 已恢复 > 去程未登机）：
 *   去程已作废      → OUTBOUND_VOIDED   终局（取消航段取消的是去程）
 *   回程已作废      → RETURN_VOIDED     终局（起飞后作废 returnVoidedFinal，或取消航段取消回程）
 *   回程座位已释放  → RETURN_RELEASED   可恢复（班次为空 + 释放晚于最近一次恢复）
 *   回程已恢复      → RETURN_RESTORED   释放过、已恢复回原班次
 *   去程未登机      → NO_SHOW           去程标过 no-show，但回程没被释放（单程单/未勾释放）
 *   一条都没有      → NONE
 *
 * **必须与 syncOrderHasReturnLeg 成对调用**（同一事务、同一批写路径）：两列都是从同一批
 * FLIGHT 行派生的，只同步一个就会出现「列表按回程已释放筛得到、按往返筛不到」这种自相矛盾。
 * 幂等：重复调用只是把同一个值再写一遍，可安全用作自愈。
 */
export async function syncOrderLegFlag(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderLegFlag> {
  const items = await tx.orderItem.findMany({
    where: { orderId, kind: OrderItemKind.FLIGHT },
    select: { kind: true, flightScheduleId: true, metadata: true },
  });
  const statuses = new Set(items.map((it) => deriveLegStatus(it)).filter((v) => v != null));

  let legFlag: OrderLegFlag = OrderLegFlag.NONE;
  if (statuses.has('去程已作废')) {
    // 去程作废优先于回程作废：两段都取消过的单，最要紧的事实是「去程没了」（整趟行程不成立）。
    legFlag = OrderLegFlag.OUTBOUND_VOIDED;
  } else if (statuses.has('回程已作废')) {
    legFlag = OrderLegFlag.RETURN_VOIDED;
  } else if (statuses.has('回程座位已释放')) {
    legFlag = OrderLegFlag.RETURN_RELEASED;
  } else if (statuses.has('回程已恢复')) {
    legFlag = OrderLegFlag.RETURN_RESTORED;
  } else if (statuses.has('去程未登机')) {
    legFlag = OrderLegFlag.NO_SHOW;
  }

  await tx.order.update({ where: { id: orderId }, data: { legFlag } });
  return legFlag;
}

export type PricedOrderItem = {
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  flightScheduleId?: string;
  flightCabin?: import('@prisma/client').CabinClass;
  businessUpgradeCount?: number;
  hotelRoomTypeId?: string;
  randomStarTier?: number;
  hotelCheckIn?: Date;
  hotelCheckOut?: Date;
  transferId?: string;
  visaId?: string;
  /** 签证预计出行日期（VISA 行专用，可空）：纯签证单的出发日锚点，见 deriveOrderDepartDate 第三级回退。 */
  visaIntendedDate?: Date;
  bundleId?: string;
  roomsBilled?: number;
  settlementAddOnCny?: number;
  unitCostCny?: number;
  totalCostCny?: number;
  metadata?: Record<string, unknown>;
};

export type AutoDiscountSummary = {
  hits: Array<{
    ruleId: string;
    kind: SettlementDiscountHit['kind'];
    perPersonCny: number;
    pax: number;
  }>;
  pax: number;
  totalCny: number;
};

// ── 重复乘客校验：入参 / 出参形状 + 姓名比对键 ────────────────────────────────

/** 参与同班次重复校验的一位乘客（建单入参与库里既有行共用这一份形状）。 */
export interface DuplicateCheckPassenger {
  documentNumber?: string | null;
  lastName?: string | null;
  firstName?: string | null;
  fullName?: string | null;
  chineseName?: string | null;
}

/** 一条重复命中。documentNumber 为空串 = 对方证件待补、按姓名命中（passengerName 才是那个键）。 */
export interface DuplicatePassengerConflict {
  documentNumber: string;
  orderNumbers: string[];
  /** 仅「证件待补 + 同名」命中时有值：命中的那位乘客姓名（展示/审计用）。 */
  passengerName?: string;
}

/**
 * 这张**存量**订单建单时那次「结算价日历自动取价」的审计快照（换人重算差价基准的最后一条来源）。
 *
 * 2026-09 之前建的单，SETTLEMENT 行上只有整单结算总价，没有基准戳，光看这一行分不出
 *「日历自动取的价」和「运营手填的结算总价 / 团队议价」—— 后者不是日历成交，日历动没动
 * 跟它一分钱关系都没有，拿日历去「纠正」它就是无中生有地多收/少收。
 * 唯一留在库里的判据是建单时那条 APPLY_SETTLEMENT_TOTAL 审计的 after.settlementCalendar
 *（日历取价时非空、手工价时为 null，见 createOrder 的结算价审计段），它里面存的是
 * `{ source, departDate, lines:[{ pricePerPersonCny, pax, … }], autoDiscount? }` ——
 * **每人价原样躺在 lines 上**，不需要拿总价去除人数。
 *
 * 复审 H1/H2 之后本函数从「返回 true/false」改成「把这个 blob 原样交出来」：
 * 旧口径用它当一道闸、再拿 settlementTotalCny ÷ 占座人数派生基准，而那个总价里揉着
 * 单房差 / 升舱 / 婴儿价 / 儿童折扣 / 指定酒店加价 / 自备签减免，除出来的根本不是日历每人价。
 * 现在直接跑 resolveCalendarPerPaxBasis 读 lines，与建单当场盖章走的是同一份口径。
 *
 * 读不到（审计表没铺 / 查询失败 / 没有这条记录）一律返回 null —— 判不出就不重算，
 * 只收换人费。宁可少做一次自动重算，也不能按猜出来的基准改钱。
 */
/**
 * 本单**已计提**（含已结算）的佣金合计（CNY）；一条都没有 → null。
 *
 * 佣金在订单转 PAID 时按当时的价格基数一次性计提，之后任何改价都不重算 —— 所以每一条会动
 * total 的路（改结算价 / 改归属 / 换人重算）都得先问一句「这单计提过没有」，有就留一条
 * SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION 的 WARNING，让财务自己决定要不要人工调整。
 * 三处共用这一份读法，免得各写各的口径（状态集合漏一个就少留一条审计）。
 *
 * 单测常只 mock 用得到的 delegate：**delegate 压根不在**（没铺 commissionRecord）或一条记录都没有
 * → null（当「没计提」）。但**查询本身失败不吞**：往上抛。
 * 这条路上的三个调用方（改结算价 / 改归属 / 换人重算）都在事务里，且都要靠这个数决定留不留
 * 「佣金基数已漂移」的 WARNING —— 把查询异常吞成 null，等于在真出错时静默宣布「本单没计提过佣金」，
 * 该留的审计不留，财务事后对不上账也翻不出是哪一步动的。原本的改结算价路径就是直接查、
 * 出错整事务回滚（响亮失败），抽成公共函数不能顺手把这份响亮改没了。
 */
export async function sumAccruedCommissionCny(
  client: Prisma.TransactionClient | typeof prisma,
  orderId: string,
): Promise<number | null> {
  const delegate = (
    client as unknown as {
      commissionRecord?: {
        findMany?: (args: unknown) => Promise<Array<{ amount: unknown }>>;
      };
    }
  ).commissionRecord;
  if (!delegate || typeof delegate.findMany !== 'function') return null;
  // 查询异常不吞（见方法头）：抛出去让调用方的事务整体回滚，别把「读失败」说成「没计提」。
  const rows = await delegate.findMany({
    where: { orderId, status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] } },
    select: { amount: true },
  });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return round2(rows.reduce((sum, c) => sum + Number(String(c.amount ?? 0)), 0));
}

/**
 * service 层内联闸的唯一入口，与路由层的 requireCapability / can() 同一张表。
 *
 * actor 只带 role —— service 的调用签名里没有岗位，也不需要：这里用到的能力受众全是
 * 「管理员 / 内部员工 / 代理」这三档，不看岗位。真正看岗位的两档（财务、航班维护）
 * 在路由层的 requireCapability 上就判完了，进不到这里。
 */
export function actorCan(actor: { role: UserRole }, cap: Capability): boolean {
  return hasCapability({ role: actor.role }, cap);
}

// 完整 include 给 serializeOrder 用
export const ORDER_FULL_INCLUDE = {
  items: true,
  passengers: true,
  // 按人份额（R1）：写路径返回的订单 DTO 直接带库里刚落的一套，前端不用再自算
  passengerShares: PASSENGER_SHARES_INCLUDE,
  payments: true,
  refunds: true,
  statusEvents: { orderBy: { createdAt: 'asc' } },
  agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
  user: { select: { id: true, displayName: true, email: true } },
} as const;

// ── 套餐酒店盖章 ─────────────────────────────────────────────────────
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 一条售后费用流水（写入 Order.adjustments）。 */
export interface OrderAdjustmentEntry {
  type:
    | 'RESCHEDULE_FEE'
    | 'SWAP_FEE'
    | 'SWAP_PRICE_DIFF'
    | 'SWAP_VISA_DEDUCT_REVERSAL'
    | 'PRICE_ADJUSTMENT'
    | string;
  label: string;
  amountCny: number;
  at: string; // ISO 时间
  by: string | null; // 操作人 userId
  note?: string;
  /** 关联出行人（SWAP_VISA_DEDUCT_REVERSAL 幂等去重、PRICE_ADJUSTMENT 按乘客调价用；整单调价为空）。 */
  passengerId?: string;
  /**
   * 被换下去的那位出行人姓名 / 证件号（SWAP_FEE / SWAP_PRICE_DIFF 专用）。
   * 这个人换完就不在乘客名单里了，passengerId 指向的那条记录已经是**新客**——
   * 只有这两项还能回答「这笔钱是谁产生的」。
   */
  passengerName?: string;
  passengerDocument?: string;
  /**
   * true = 这笔钱不参与每人均摊（换人费 / 换人差价：记在被换下去的人头上）。
   * 口径与实现见 per-pax-share.ts 的 spreadableAdjustmentCny —— 钱仍在 adjustmentCny 里
   * （应收/尾款一分不少），只是不摊到留守同行人与新客的每人结算价上。
   */
  excludeFromPerPax?: boolean;
  /** 调价原因码（仅 PRICE_ADJUSTMENT 流水带；财务四类 DISCOUNT/MISC_FEE/CHANGE/OTHER）。 */
  reasonCode?: string;
}

/**
 * 不可变地把一条流水追加到 Order.adjustments（JSON 数组）。
 * 旧值非数组（脏数据/旧空默认）时按空数组处理，绝不抛错。
 */
export function appendAdjustment(
  existing: Prisma.JsonValue | null | undefined,
  entry: OrderAdjustmentEntry,
): Prisma.InputJsonValue {
  const arr = Array.isArray(existing) ? (existing as Prisma.JsonArray) : [];
  return [...arr, entry as unknown as Prisma.InputJsonValue];
}

/**
 * PTC 码（ADT/CHD/INF，derivePtcByAge 的返回值）→ 建单落库用的系统枚举
 * （ADULT/CHILD/INFANT）。年龄阈值判断已在 derivePtcByAge 里做过，这里只做码值转换。
 */
export function ptcToPassengerType(ptc: string): PassengerType {
  const map: Record<string, PassengerType> = {
    ADT: PassengerType.ADULT,
    CHD: PassengerType.CHILD,
    INF: PassengerType.INFANT,
  };
  return map[ptc] ?? PassengerType.ADULT;
}

// 导出供单测验证乘客字段落库映射（含 0713 反馈批新增 visaExempt/singleRoom）。
export function passengerToData(
  p: PassengerInput,
  // 服务端权威派生 passengerType 所需的「本单最早出发日」（见下方 passengerType 计算注释）。
  // 省略该参数 = 维持旧行为（不派生，原样落客户端传值）——占位单转正等其它调用点无需改动。
  opts?: { authoritativeDepartureDate?: Date | null },
) {
  // 自动拆 fullName → lastName/firstName，如果客户端没传（斜线优先，见 splitPassengerFullName）
  const { lastName: autoLast, firstName: autoFirst } = splitPassengerFullName(p.fullName);
  // 拆名截断兜底（0831 公测反馈：LAM/MENG IEONG 入库成 LAM+MENG）：名单解析入口可能产出
  // 「全名是全的、拆名却截断」的组合——散行解析吃不满多词名，录单员手动改全名时解析残留的
  // 隐藏拆名没跟着改。只纠**截断**（拆名拼回去是全名的前缀但更短）→ 按全名重拆；
  // 显式传入的、与全名整体不同的姓/名维持优先（既有口径，见 orders.service.test.ts）。
  // 中文全名不带斜线不受影响（orders.import「中文姓名 + 拉丁 PNR 拆名」组合照旧放行）。
  const composedProvided =
    p.lastName || p.firstName ? composePassengerFullName(p.lastName, p.firstName) : null;
  const normalizedFull = normalizePassengerFullName(p.fullName);
  const trustProvidedSplit = !(
    p.fullName.includes('/') &&
    composedProvided !== null &&
    composedProvided !== normalizedFull &&
    normalizedFull.startsWith(composedProvided)
  );
  const dateOfBirth = new Date(p.dateOfBirth);
  const hasValidDob = Boolean(p.dateOfBirth) && !Number.isNaN(dateOfBirth.getTime());
  // 乘客类型服务端权威派生（覆盖客户端传值）：入口层（前台下单页/批量导入解析层）已尽量按
  // 「出生日期 + 出发日」派生 passengerType，这里是权威兜底 —— 凡是乘客带出生日期、且本单能
  // 定出最早出发日（机票行/套餐行）时，用 derivePtcByAge 重算并覆盖，堵住入口漏派生或被篡改的口子
  // （如成人生日误传/篡改成 INFANT）。无出生日期或订单定不出出发日（纯地面单）→ 保留客户端传值/默认。
  const passengerType =
    hasValidDob && opts?.authoritativeDepartureDate
      ? ptcToPassengerType(derivePtcByAge(dateOfBirth, opts.authoritativeDepartureDate, p.passengerType))
      : p.passengerType;
  return {
    fullName: p.fullName,
    lastName: trustProvidedSplit ? (p.lastName ?? (autoLast || null)) : autoLast || null,
    firstName: trustProvidedSplit ? (p.firstName ?? (autoFirst || null)) : autoFirst || null,
    title: p.title ?? null,
    gender: p.gender ?? null,
    documentType: p.documentType,
    documentNumber: p.documentNumber,
    dateOfBirth,
    placeOfBirth: p.placeOfBirth ?? null,
    nationality: p.nationality,
    passengerType,
    chineseName: p.chineseName ?? null,
    passportIssueDate: p.passportIssueDate ? new Date(p.passportIssueDate) : null,
    passportIssueCountry: p.passportIssueCountry ?? null,
    passportIssuePlace: p.passportIssuePlace ?? null,
    passportExpiry: p.passportExpiry ? new Date(p.passportExpiry) : null,
    pnr: p.pnr ?? null, // 订座编码：录单带入（共用编码=多行同值）；出票回填会覆盖
    visaNumber: p.visaNumber ?? null,
    visaType: p.visaType ?? null,
    visaIssueDate: p.visaIssueDate ? new Date(p.visaIssueDate) : null,
    visaEffectiveDate: p.visaEffectiveDate ? new Date(p.visaEffectiveDate) : null,
    visaExpiry: p.visaExpiry ? new Date(p.visaExpiry) : null,
    visaPlaceOfIssue: p.visaPlaceOfIssue ?? null,
    visaCountryOfApplication: p.visaCountryOfApplication ?? null,
    addressType: p.addressType ?? null,
    addressDetails: p.addressDetails ?? null,
    addressCity: p.addressCity ?? null,
    addressState: p.addressState ?? null,
    addressCountry: p.addressCountry ?? null,
    addressZip: p.addressZip ?? null,
    mealPreference: p.mealPreference,
    needsWheelchair: p.needsWheelchair ?? false,
    needsInfantBassinet: p.needsInfantBassinet ?? false,
    bedPref: p.bedPref ?? null,
    passportPhotoUrl: p.passportPhotoUrl ?? null,
    // 套餐乘客级选项（购物车模式）：缺省 false = 随套餐办签 + 拼房（与旧行为一致）。
    visaExempt: p.visaExempt ?? false,
    singleRoom: p.singleRoom ?? false,
  };
}

/**
 * FTMYYYYMMDD + 5 位随机 — 每天 10 万空间，撞号概率极低。
 * 真撞了也只会在 $transaction 里 P2002 抛出，上层可以重试；MVP 阶段不做自动重试。
 */
export async function generateOrderNumber(): Promise<string> {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const suffix = String(randomInt(10000, 99999));
  return `FTM${yyyy}${mm}${dd}${suffix}`;
}

/** M月D日（本地展示用；departureDate 等按 UTC 零点解析的 date-only 字段沿用同一口径）。 */
export function formatMonthDay(d: Date): string {
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/** YYYY-MM-DD → M/D（随机档缺口审计使用紧凑日期）。 */
export function formatSlashMonthDay(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/**
 * 航班时刻 HH:MM（24 小时制，**按班次自己的当地时区**折算）。
 * 班次 departureTime/arrivalTime 存 UTC，当地时区另存在 departureTz/arrivalTz——
 * 直接取 UTC 分量会少 8 小时（澳门/北京）或 7 小时（越南），订单详情、前台「我的订单」、
 * 行程单 PDF/邮件全线显示错误时刻。tz 缺失（未联查）时回退 UTC 分量，行为与改动前一致。
 */
export function formatHHMM(d: Date, tz?: string | null): string {
  if (tz) return localHHMM(d, tz);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * YYYY-MM-DD。传入 tz 时按当地日折算（当地凌晨起飞的班次 UTC 还停在前一天，
 * 不折算会把出发日期写早一天）；不传沿用 UTC 日（date-only 字段本就存 UTC 零点）。
 */
export function formatDateOnly(d: Date, tz?: string | null): string {
  if (tz) return localDateISO(d, tz);
  return d.toISOString().slice(0, 10);
}

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 用 Prisma.Decimal 做钱算术（避免 float 漂移），结果四舍五入到 2 位小数。
// ROUND_HALF_UP 与文件其余处（round2 的 Math.round）一致。
export function round2Decimal(d: Prisma.Decimal): Prisma.Decimal {
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
