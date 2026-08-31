/**
 * 订单服务 — 下单 / 列表 / 详情 / 状态流转。
 *
 * 核心逻辑：
 * 1. 下单事务：乘客=机票张数校验 → 查班次余票 → 动态定价重算 → 写 Order+Item+Passenger → 扣减 sold
 * 2. 状态机：DRAFT → PENDING_PAYMENT → PAID → PROCESSING → TICKETED → COMPLETED
 *    分支：PENDING_PAYMENT → CANCELLED；PAID → REFUND_REQUESTED → REFUNDED
 * 3. RBAC：
 *    - ADMIN/STAFF：全部订单 + 全部状态转移
 *    - AGENT：仅看本人 + 下级代理的订单；仅允许 DRAFT → PENDING_PAYMENT
 *    - CUSTOMER：仅本人订单；仅允许取消 PENDING_PAYMENT
 * 4. 幂等：idempotencyKey 存在则直接返回已有订单（保护客户端重试）
 */
import {
  AuditSeverity,
  AuditTargetType,
  CabinClass,
  CommissionStatus,
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
  PaymentStatus,
  PrepaymentTxType,
  Prisma,
  ProductKind,
  ReceiptSource,
  RefundStatus,
  SeatLockStatus,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  DuplicatePassengerError,
  ForbiddenError,
  NotFoundError,
  PriceChangedError,
  UnprocessableEntityError,
} from '../../lib/errors.js';
import type { ItineraryData } from '../../lib/itinerary-pdf.js';
import { writeAudit } from '../../lib/audit.js';
import { splitPassengerFullName } from '../../lib/passenger-name.js';
import { localHHMM, localDateISO, localToUtc } from '../../lib/flight-time.js';
import { BUSINESS_TZ } from '../../lib/business-time.js';
import {
  orderNeedsVisaTask,
  orderVisaStatusRequiresVisa,
} from './visa-need.js';
import { computePerPaxShares } from './per-pax-share.js';
import {
  assertOrderAcceptsFunds,
  assertOrderAllowsFundsDisposal,
  FUNDS_DISPOSE_BLOCKED_STATUSES,
  sumCompletedRefundsWithinTx,
} from '../../lib/funds-guard.js';
import { resolveBundleNights } from '../products/bundle-nights.js';
import { parseVisaExpressTiers, type VisaExpressTier } from '../products/products.schemas.js';
import { localDate } from '../finances/finances.cost.service.js';
import { getSettlementRate } from '../settlement-rates/settlement-rates.service.js';
import { getFlightSettlementRate } from '../settlement-rates/flight-settlement-rates.service.js';
import {
  resolveAgentSettlementDiscount,
  resolveRetailSettlementDiscount,
  type SettlementDiscountHit,
} from '../settlement-discounts/settlement-discounts.service.js';
import {
  assertHotelPhysicalFit,
  assertHotelPhysicalFitWithinTx,
  assertRandomTierFit,
  assertRandomTierFitWithinTx,
  checkHotelPhysicalFit,
  getHotelNightlyRemaining,
  getHotelOversellCapRooms,
  getRandomTierAggregate,
  lockHotelBlockPeriodsWithinTx,
  randomStarTierLabel,
  type PhysicalFitViolation,
  type ProspectiveOccupancy,
  type RandomTierFitViolation,
} from '../hotel-control/hotel-control.service.js';
import { env } from '../../config/env.js';
import { PricingService } from '../pricing/pricing.service.js';
import { createOpenReceiptWithinTx } from '../receipts/receipts.service.js';
import { OPERATION_FEE_CNY_PER_ORDER } from './order-cost-items.service.js';
import { bundleItemMetadataSchema } from './orders.schemas.js';
import { derivePtcByAge, earliestFlightDeparture } from './pnr-export.js';
// 按人送签的任务级状态派生（纯函数）：与签证台同一口径。依赖方向安全——
// fulfillment.service 只 import prisma/errors/自身 schemas，不回头 import orders 模块，无环。
import { deriveVisaTaskStatus } from '../fulfillment/fulfillment.service.js';
import { syncOrderVisaCompletion } from '../fulfillment/visa-completion.js';
import { resolveSelfVisaDeductCny } from '../products/self-visa-deduct.js';
import {
  assertOrderAllowsInvoicing,
  assertTicketingCap,
  countsTowardTicketingCap,
  determineFlightLegs,
  determineFlightLegItems,
} from './ticketing-cap.js';
import type { FlightLegItem } from './ticketing-cap.js';
import { PRICE_ADJUSTMENT_CAP_CNY, PRICE_ADJUSTMENT_REASON_LABEL } from './orders.schemas.js';
import { heldSeatsForCabin } from '../hold-orders/held-seats.js';
import type {
  BatchCreateOrdersBody,
  BatchRescheduleBody,
  AddGroundItemBody,
  BatchPassengerInput,
  ChangeOrderBundleBody,
  CreateOrderBody,
  ListOrdersQuery,
  OrderItemInput,
  OrderPriceAdjustmentBody,
  PassengerInput,
  PriceAdjustmentInput,
  PublicOrderLookupQuery,
  QuoteOrderBody,
  SettlementPreview,
  RescheduleItemHotelBody,
  SelfUpdatePassengerBody,
  SplitRoomGroupBody,
  SwapItemHotelBody,
  UpdateItemSettlementPriceBody,
  UpdatePassengerVisaDatesBody,
} from './orders.schemas.js';

// ── 状态机：允许的转移 ──────────────────────────────────────────────────
// 本表是状态机的**唯一真源**：前端不再手抄一份，而是消费 serializeOrder 逐单下发的
// allowedTransitions（见本文件末 serializeOrder）。改这里 = 前后台同时生效，抄不错、漂移不了。

// 状态中文名（与 admin-web 列表叫法一致）：面向用户的报错一律用中文，不透出枚举名。
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
const zhStatus = (s: OrderStatus): string => ORDER_STATUS_LABEL_ZH[s] ?? s;

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

// 哪些状态视为"占用座位"（需要扣库存）
export const SEAT_HOLDING_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGE_REQUESTED',
  'CHANGED',
];

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
export const SEAT_RELEASING_STATUSES: OrderStatus[] = [
  'CANCELLED',
  'PAYMENT_TIMEOUT',
  'REFUNDED',
  'FAILED',
  'DRAFT',
  'REFUND_REQUESTED',
];

// 订单落「取消族」终态 → 履约任务应被终态化（CANCELLED），而非仅靠列表查询过滤隐藏。
// 隐藏式过滤的问题：任务仍是 PENDING/IN_PROGRESS，force 把订单拉回占座态即"复活"，且统计口径数不到。
// 注意与 DRAFT 区分：DRAFT 虽在 SEAT_RELEASING_STATUSES 里（座位账口径），但不是取消族终态，
// 不应把履约任务一并终态化（force H→DRAFT→PAID 的座位来回搬移不涉及"订单被取消"语义）。
const FULFILLMENT_TERMINATING_STATUSES: OrderStatus[] = [
  'CANCELLED',
  'REFUNDED',
  'PAYMENT_TIMEOUT',
  'FAILED',
];

// ── 前台自助端点的状态闸 ────────────────────────────────────────────────
// 出行人护照资料自助补录：出票流程启动前（含处理中）可改；出票后锁定走客服。
const SELF_EDITABLE_PASSENGER_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAID', 'PROCESSING'];
// 改签申请：已付款到已出票之间可申请。
const CHANGE_REQUESTABLE_STATUSES: OrderStatus[] = ['PAID', 'PROCESSING', 'TICKETED'];
// 电子行程单下载：订单确认（付款）后即可（含改签中/已改签——旅客仍需凭行程单出行）。
const ITINERARY_READY_STATUSES: OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGE_REQUESTED',
  'CHANGED',
];

// 服务端价格校验容差（CNY）：客户端提交金额与服务端权威重算金额相差超过此值则拒单（A3）
const PRICE_TOLERANCE_CNY = 1.0;

// 护照有效期规则（相对出发日）— 反馈：签证岗
const PASSPORT_EXPIRY_SURCHARGE_DAYS = 180; // 不足 6 个月加收附加费
const NEAR_EXPIRY_SURCHARGE_CNY = 200; // 每位临期乘客附加费
// 升舱差价兜底（¥/程/座）：套餐 businessUpgradeCnyPerLeg=null（跟随航班）但两趟都没绑到航班时使用，
// 与 Flight.businessUpgradeCnyPerLeg 的 schema 默认值一致，绝不让升舱派生出 0/裸价。
const DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG = 700;

/**
 * 剥离 FLIGHT 行 metadata 里客户端可能伪造的 businessUpgradeCount（HIGH 修复）。
 *
 * 这个字段只应该由「套餐升舱」内部派生路径写入（见 priceAndValidateItems 里
 * `leg.metadata = { ...leg.metadata, businessUpgradeCount: bundleBusinessUpgradeCount }` 那段——
 * 它在算完真实升舱人数后整体覆盖，不受本函数影响）。POST /orders 用 optionalAuthenticate
 * （匿名可达），flightItemSchema.metadata 是 `z.record(z.unknown())` 完全开放透传；建单本身虽然
 * 不读 metadata.businessUpgradeCount 来决定扣座（扣座用的是 priced 数组自己的类型化字段，套餐路径
 * 才会赋值），但会把客户端塞进来的 metadata 原样落库。取消/超时释放（~2072）和 admin force 重新
 * 占座（~2126）读的正是这条落库的 metadata.businessUpgradeCount 来做「套餐升舱拆座」镜像还原——
 * 一个伪造了 businessUpgradeCount 的普通机票行，因此能在退座时把从未真正占用过的 BUSINESS 舱
 * sold 减成负数（且永久卡在负数，见下方 releaseSeatFloored 的第二层防线）。
 * 建单时无条件剥掉这个键，之后套餐路径再按真实升舱人数重新写入 —— 客户端永远无法自己塞值进去。
 */
function sanitizeFlightItemMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const { businessUpgradeCount: _ignoredClientValue, ...rest } = metadata;
  return rest;
}

/**
 * 从 VISA 行 metadata 里取客户端选择的加急档名（`expressTierLabel`）。
 *
 * 客户端只传**档名**，加价金额一律由服务端按产品的 expressTiers 查表得出（钱路径服务端权威）。
 * 非字符串 / 空白 → 视为未选档（回落旧的 express 布尔口径）。档名对不上时由调用处显式拒单。
 */
function resolveRequestedExpressTierLabel(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const raw = metadata?.expressTierLabel;
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  return label.length > 0 ? label : null;
}

// ── 类型 ────────────────────────────────────────────────────────────────
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

function isGuestRequester(r: OrderRequester | GuestRequester): r is GuestRequester {
  return 'guest' in r;
}

/** 前台散客单的支付超时（未支付即自动释放机位的时长）。 */
const RETAIL_PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

/** 后台/代理录入身份：这些认证角色录的单默认「肯定要飞」，不设支付超时。 */
const STAFF_ENTRY_ROLES: readonly UserRole[] = [UserRole.AGENT, UserRole.STAFF, UserRole.ADMIN];

/**
 * 支付超时口径（0708 业务定）：机位是否会因未支付被自动退回，只看**服务端认证身份**。
 *   - 后台/代理录入（AGENT / STAFF / ADMIN，含批量建单）→ true：不设支付超时（paymentExpiresAt=null），
 *     机位永不自动释放。这类订单默认「肯定要飞」、多为 T+1 线下结算；要退机位必须由运营手动取消/改状态。
 *   - 前台散客（匿名游客 / 登录 CUSTOMER）→ false：保留 30 分钟未支付自动释放，防匿名占坑锁库存。
 * 用角色允许名单（而非「非 CUSTOMER」）判定：未知/新增角色默认按散客处理（保留超时），是更安全的兜底。
 * 绝不信任 body 里的字段——POST /orders 是 optionalAuthenticate 公开可达，身份必须来自 JWT / 游客上下文。
 */
function isStaffEnteredOrder(requester: OrderRequester | GuestRequester): boolean {
  if (isGuestRequester(requester)) return false;
  return STAFF_ENTRY_ROLES.includes(requester.role);
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
 * 批量套餐子单派生的机票航段（服务端按套餐绑定航班 + 出发日期匹配当日班次得到）。
 * 每条对应一个真实班次 scheduleId + 中文段标（去程/回程），注入子单 FLIGHT 行让其真正扣座。
 */
export interface BundleFlightLeg {
  scheduleId: string;
  label: string; // 「去程」/「回程」
}

/** 批量套餐单一乘客的行级选项与按出发日推导的人群计数。 */
export interface BatchBundlePassengerOptions {
  singleRoom?: boolean;
  businessUpgrade?: boolean;
  designatedHotelRoomTypeId?: string;
  /** 星级不匹配放行原因（该乘客指定酒店与套餐档次对不上时必填，口径同单笔录单）。 */
  designatedHotelStarMismatchReason?: string;
  adultCount: number;
  childCount: number;
  infantCount: number;
}

function parseBatchYmd(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/**
 * 批量套餐按乘客生日相对套餐出发日推导三计数。
 * 复用票务导出的实足年龄/PTC 口径；生日缺失或日期不可用按成人处理。
 */
export function deriveBatchBundlePassengerCounts(
  dateOfBirth: string | undefined,
  bundleDepartDate: string | undefined,
): Pick<BatchBundlePassengerOptions, 'adultCount' | 'childCount' | 'infantCount'> {
  const ptc = derivePtcByAge(parseBatchYmd(dateOfBirth), parseBatchYmd(bundleDepartDate), 'ADULT');
  return {
    adultCount: ptc === 'ADT' ? 1 : 0,
    childCount: ptc === 'CHD' ? 1 : 0,
    infantCount: ptc === 'INF' ? 1 : 0,
  };
}

/**
 * 批量散客建单：按 productType 构造每张子单的 items；BUNDLE 行级选项由调用方逐人传入。
 * 导出供单测复用。
 *   FLIGHT_ONEWAY    → [FLIGHT(outbound)]
 *   FLIGHT_ROUNDTRIP → [FLIGHT(outbound 去程), FLIGHT(return 返程)]，均同舱位
 *   BUNDLE           → [FLIGHT(去程[, 回程]), BUNDLE(bundleId, +单人入住/升舱份数, +goDate/returnDate metadata)]
 *                      机票航段行（bundleFlightLegs，服务端按套餐绑定航班 + 出发日期匹配当日班次得到）在前 +
 *                      地面套餐行在后 —— 与前台商城 / 单笔录单同结构：FLIGHT 行走 createOrder 既有的权威定价 +
 *                      原子扣座（机票座位对上、进票务）；BUNDLE 行只算地面 + 盖酒店房型/入住日期（房控/销控计入
 *                      套餐占房）。这是「批量套餐单零座位、房控看不到」的修复点（P0-4）。
 *                      机票腿打上 bundleId → createOrder 据套餐 discountPct 对其打折（与前台商城同源，
 *                      财务航班毛利按折后算不假高）。占座人数 = 该子单乘客数（批量每子单 1 位 → quantity=1）。
 *
 * 缺省/旧调用（只传 flightScheduleId、productType 缺省）按 FLIGHT_ONEWAY 处理（向后兼容）。
 * 校验由 batchCreateOrdersBodySchema.superRefine 完成（outbound/cabin/return/bundleId 必填），
 * 此处仅做断言式兜底（理论上不会触发）。
 */
export function buildBatchItems(
  body: BatchCreateOrdersBody,
  productType: BatchCreateOrdersBody['productType'],
  outbound: string | undefined,
  bundleDates: { goDate?: string; returnDate?: string } = {},
  bundleFlightLegs: readonly BundleFlightLeg[] = [],
  bundlePassengerOptions: BatchBundlePassengerOptions = {
    adultCount: 1,
    childCount: 0,
    infantCount: 0,
  },
): OrderItemInput[] {
  if (productType === 'BUNDLE') {
    if (!body.bundleId) throw new BadRequestError('BUNDLE 类型必须提供 bundleId');
    const metadata: Record<string, unknown> = {};
    if (bundleDates.goDate) metadata.goDate = bundleDates.goDate;
    if (bundleDates.returnDate) metadata.returnDate = bundleDates.returnDate;
    // 机票航段行（去程[+回程]）：每子单 1 位出行人 → quantity=1（一座）。舱位固定经济舱（套餐机票口径）。
    // bundleId 打标 → createOrder 按套餐 discountPct 对机票腿打折（与前台商城同源）。
    const flightLegs: OrderItemInput[] = bundleFlightLegs.map((leg) => ({
      kind: 'FLIGHT',
      description: `${body.description} · ${leg.label}`,
      quantity: 1,
      flightScheduleId: leg.scheduleId,
      flightCabin: CabinClass.ECONOMY,
      bundleId: body.bundleId,
    }));
    return [
      ...flightLegs,
      {
        kind: 'BUNDLE',
        description: body.description,
        quantity: 1,
        bundleId: body.bundleId,
        // unitPrice 由服务端权威重算（createOrder BUNDLE 分支忽略前端传值，0 仅占位）
        unitPrice: 0,
        // 可选升级 add-on 份数：批量每张子单只使用本行乘客的勾选结果。
        singleCount: bundlePassengerOptions.singleRoom === true ? 1 : 0,
        businessCount: bundlePassengerOptions.businessUpgrade === true ? 1 : 0,
        // 批量每张子单只有一位乘客，三计数按该乘客生日相对套餐出发日推导。
        adultCount: bundlePassengerOptions.adultCount,
        childCount: bundlePassengerOptions.childCount,
        infantCount: bundlePassengerOptions.infantCount,
        ...(bundlePassengerOptions.designatedHotelRoomTypeId
          ? { designatedHotelRoomTypeId: bundlePassengerOptions.designatedHotelRoomTypeId }
          : {}),
        ...(bundlePassengerOptions.designatedHotelStarMismatchReason
          ? {
              designatedHotelStarMismatchReason:
                bundlePassengerOptions.designatedHotelStarMismatchReason,
            }
          : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    ];
  }

  if (!outbound) {
    throw new BadRequestError('FLIGHT 类型必须提供 outboundScheduleId（或 flightScheduleId）');
  }
  if (!body.flightCabin) {
    throw new BadRequestError('FLIGHT 类型必须提供 flightCabin');
  }

  if (productType === 'FLIGHT_ROUNDTRIP') {
    if (!body.returnScheduleId) {
      throw new BadRequestError('FLIGHT_ROUNDTRIP 必须提供 returnScheduleId');
    }
    // 每位出行人 2 条 FLIGHT 行（去程 + 返程），createOrder 据此对两个班次各做一次原子扣座。
    return [
      {
        kind: 'FLIGHT',
        description: `${body.description} 去程`,
        quantity: 1,
        flightScheduleId: outbound,
        flightCabin: body.flightCabin,
      },
      {
        kind: 'FLIGHT',
        description: `${body.description} 返程`,
        quantity: 1,
        flightScheduleId: body.returnScheduleId,
        flightCabin: body.flightCabin,
      },
    ];
  }

  // FLIGHT_ONEWAY（含旧调用兜底）
  return [
    {
      kind: 'FLIGHT',
      description: body.description,
      quantity: 1,
      flightScheduleId: outbound,
      flightCabin: body.flightCabin,
    },
  ];
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
export function buildPriceAdjustmentItem(adj: PriceAdjustmentInput): {
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
  return {
    kind: adj.amountCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
    description: `价格调整：${label}（${signed}）${suffix}`,
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
    },
  };
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
const CABIN_ZH_LABEL: Record<string, string> = {
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
const ECONOMY_CABIN_TEXT_RE = /(?:超级|高端|豪华)?经济舱/g;
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
 *   - BUNDLE 行不适用（建单时未快照酒店成本，且其 quantity≠晚数、totalCostCny 覆盖整包）——
 *     由调用方跳过，本函数只服务 HOTEL 行。
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

type PricedOrderItem = {
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

type AutoDiscountSummary = {
  hits: Array<{
    ruleId: string;
    kind: SettlementDiscountHit['kind'];
    perPersonCny: number;
    pax: number;
  }>;
  pax: number;
  totalCny: number;
};

type RescheduleCommittedContext = {
  orderItemId: string;
  oldScheduleId: string;
  oldCabin: import('@prisma/client').CabinClass;
  newScheduleId: string;
  newCabin: import('@prisma/client').CabinClass;
  statusChanged: boolean;
};

const rescheduleCommittedContexts = new WeakMap<object, RescheduleCommittedContext>();

function rescheduleCommittedContext(err: unknown): RescheduleCommittedContext | null {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return null;
  return rescheduleCommittedContexts.get(err) ?? null;
}

export class OrderService {
  private readonly pricing = new PricingService();

  /**
   * 占位单转正专用的事务内机票建单内核。
   * 调用方必须先在同一事务里消费 HoldOrder 的余座；本方法只负责复用订单号、订单事件、
   * 乘客落库、操作费与订单 CAS 扣座，不自行开启嵌套事务，也不改变普通创单路径。
   */
  async createHoldConversionOrderWithinTx(
    tx: Prisma.TransactionClient,
    input: {
      holdOrderId: string;
      holdNo: string;
      flightScheduleId: string;
      cabin: CabinClass;
      quantity: number;
      unitPriceCny: number;
      passengers: BatchPassengerInput[];
      contactName?: string;
      contactPhone?: string;
      agentId?: string | null;
      actorUserId: string | null;
      allowDuplicatePassengers?: boolean;
    },
  ) {
    if (input.quantity !== input.passengers.length) {
      throw new BadRequestError(`订单需要 ${input.quantity} 位出行人，当前填了 ${input.passengers.length} 位`);
    }

    const seenDocuments = new Set<string>();
    const duplicateDocuments = new Set<string>();
    for (const passenger of input.passengers) {
      if (seenDocuments.has(passenger.documentNumber)) duplicateDocuments.add(passenger.documentNumber);
      seenDocuments.add(passenger.documentNumber);
    }
    if (duplicateDocuments.size > 0) {
      throw new BadRequestError(`名单内证件号重复：${[...duplicateDocuments].join('、')}`);
    }

    const allowDuplicate = input.allowDuplicatePassengers === true;
    const conflicts = await tx.passenger.findMany({
      where: {
        documentNumber: { in: [...new Set(input.passengers.map((p) => p.documentNumber))] },
        order: {
          status: { in: SEAT_HOLDING_STATUSES },
          items: { some: { flightScheduleId: input.flightScheduleId } },
        },
      },
      select: { documentNumber: true, order: { select: { orderNumber: true } } },
    });
    const conflictsByDocument = new Map<string, Set<string>>();
    for (const conflict of conflicts) {
      const orderNumbers = conflictsByDocument.get(conflict.documentNumber) ?? new Set<string>();
      orderNumbers.add(conflict.order.orderNumber);
      conflictsByDocument.set(conflict.documentNumber, orderNumbers);
    }
    const conflictList = [...conflictsByDocument.entries()].map(([documentNumber, orderNumbers]) => ({
      documentNumber,
      orderNumbers: [...orderNumbers],
    }));
    if (conflictList.length > 0 && !allowDuplicate) {
      const detail = conflictList
        .map((item) => `${item.documentNumber}（订单 ${item.orderNumbers.join('、')}）`)
        .join('；');
      throw new DuplicatePassengerError(`以下乘客证件号已在同航班的有效订单中，不能重复下单：${detail}`, { conflicts: conflictList });
    }

    const orderNumber = await generateOrderNumber();
    const contactName = input.contactName?.trim() || '系统录入';
    const contactPhone = input.contactPhone?.trim() || '-';
    const duplicateNote = conflictList.length > 0
      ? `重复乘客强录：与订单 ${[...new Set(conflictList.flatMap((item) => item.orderNumbers))].join('、')} 同班次同证件号`
      : null;
    const order = await tx.order.create({
      data: {
        orderNumber,
        userId: null,
        agentId: input.agentId ?? null,
        sourceHoldOrderId: input.holdOrderId,
        status: OrderStatus.PENDING_PAYMENT,
        currency: 'CNY',
        subtotal: new Prisma.Decimal(input.quantity * input.unitPriceCny),
        total: new Prisma.Decimal(input.quantity * input.unitPriceCny),
        contactName,
        contactPhone,
        notes: [
          `占位单 ${input.holdNo} 转正`,
          duplicateNote,
        ].filter(Boolean).join(' · '),
        items: {
          create: {
            kind: OrderItemKind.FLIGHT,
            description: `${input.holdNo} 转正机票`,
            quantity: input.quantity,
            unitPrice: new Prisma.Decimal(input.unitPriceCny),
            amount: new Prisma.Decimal(input.quantity * input.unitPriceCny),
            flightScheduleId: input.flightScheduleId,
            flightCabin: input.cabin,
          },
        },
        passengers: {
          create: input.passengers.map((passenger) => passengerToData(passenger)),
        },
        statusEvents: {
          create: {
            fromStatus: null,
            toStatus: OrderStatus.PENDING_PAYMENT,
            actorUserId: input.actorUserId,
            reason: `占位单 ${input.holdNo} 名单转正创建订单`,
          },
        },
      },
      include: { items: true, passengers: true, statusEvents: true },
    });

    await tx.orderCostItem.create({
      data: {
        orderId: order.id,
        category: 'OPERATION_FEE',
        amountCny: new Prisma.Decimal(OPERATION_FEE_CNY_PER_ORDER),
        note: '系统自动计提（每单固定操作费）',
      },
    });

    // HoldOrder.seatsConverted 已先于此调用增加，heldSeatsForCabin 已扣除本次消费的占位余座。
    // CAS 失败说明库存账本不变量被破坏，直接抛错让整个转正事务回滚。
    await takeSeatWithinTx(tx, input.flightScheduleId, input.cabin, input.quantity, null);
    await syncOrderHasReturnLeg(tx, order.id);
    // 普通创单在事务内的签证任务内核：转正订单也必须从创建时进入签证台，不能等到
    // 事务提交后补写，避免订单已可见但履约台漏任务。
    await createVisaTaskAtCreation(tx, order.id);
    return { order, duplicateConflicts: conflictList };
  }

  /**
   * 转正专用的正常收款状态收口。调用方无论是否实际生成结转 Payment 都必须调用：
   * carryCny=0 的零价订单同样按 effectivePayable <= paidAmount 推进 PAID。
   */
  async advanceOrderToPaidIfClearedWithinTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    requester: OrderRequester,
    pendingFulfillmentTaskIds: string[],
  ): Promise<{ fullyPaid: boolean; status: OrderStatus }> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true, total: true, adjustmentCny: true, paidAmount: true, prepaymentOffset: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    const effectivePayable = Number(order.total) + order.adjustmentCny;
    const paid = Number(order.paidAmount) + Number(order.prepaymentOffset);
    const fullyPaid = paid + 0.001 >= effectivePayable;
    if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
      await this._updateStatusWithinTx(
        tx,
        orderId,
        OrderStatus.PAID,
        requester,
        '占位单结转后订单已结清',
        pendingFulfillmentTaskIds,
      );
      return { fullyPaid: true, status: OrderStatus.PAID };
    }
    return { fullyPaid, status: order.status };
  }

  // ════════════════════════════════════════════════════════════════════
  // 下单
  // ════════════════════════════════════════════════════════════════════
  async createOrder(body: CreateOrderBody, requester: OrderRequester | GuestRequester) {
    // 游客 vs 登录用户：拆出统一的归属信息（userId/agentId/锁位归属/事件 actor）
    const isGuest = isGuestRequester(requester);
    const ownerUserId: string | null = isGuest ? null : requester.userId;
    const guest = isGuest ? requester.guest : null;

    // 录单调价/加项 + 本单结算总价 + 机票团队议价结算价：仅 ADMIN/STAFF 录单可用。服务端按认证身份
    // 判权限（不信前端）——公开散客/客户/代理携带这些字段直接 400，杜绝对外接口被绕过手工改价。
    // flightSettlementPriceCny 会短路机票动态定价（priceAndValidateItems），公开下单口必须与 /orders/batch
    // 一样收口，否则匿名游客可传 0 以零元买机票并真实扣座。
    if (
      body.priceAdjustment ||
      body.settlementTotalCny !== undefined ||
      body.perPassengerSettlementCny !== undefined ||
      body.flightSettlementPriceCny !== undefined
    ) {
      const role = isGuest ? undefined : requester.role;
      if (role !== UserRole.ADMIN && role !== UserRole.STAFF) {
        throw new BadRequestError('无权调整订单价格');
      }
      // 两个改价通道互斥：结算总价本身就是「把总额收敛到一个数」，再叠加手工调价会双重砸价。
      if (body.priceAdjustment && body.settlementTotalCny !== undefined) {
        throw new BadRequestError('「本单结算总价」与「价格调整」不能同时填写（两者互斥，避免双重调价）');
      }
      // 每人结算价与整单结算总价/手工调价同为「把应收收敛到谈定价」的通道，两两互斥；
      // 数组必须与 passengers 一一对应（同序等长），否则钱会挂错人。
      if (body.perPassengerSettlementCny !== undefined) {
        if (body.settlementTotalCny !== undefined) {
          throw new BadRequestError('「每人结算价」与「本单结算总价」不能同时填写（两者互斥）');
        }
        if (body.priceAdjustment) {
          throw new BadRequestError('「每人结算价」与「价格调整」不能同时填写（两者互斥，避免双重调价）');
        }
        if (body.perPassengerSettlementCny.length !== body.passengers.length) {
          throw new BadRequestError(
            `每人结算价需与出行人一一对应：应填 ${body.passengers.length} 项，实收 ${body.perPassengerSettlementCny.length} 项`,
          );
        }
      }
    }

    // 重复乘客强录：同上口径，仅 ADMIN/STAFF 后台录入生效。服务端按认证身份判权限（不信前端）——
    // 散客/客户/AGENT 携带此 flag 一律无效（照旧拦），杜绝公开接口绕过同班次同证件号占座校验。
    const requesterRole = isGuest ? undefined : requester.role;
    const allowDuplicatePassengers =
      body.allowDuplicatePassengers === true &&
      (requesterRole === UserRole.ADMIN || requesterRole === UserRole.STAFF);

    // 支付超时（见 isStaffEnteredOrder 注释）：后台/代理录入 → null（机位永不自动退，靠运营手动释放）；
    // 前台散客（匿名/登录 CUSTOMER）→ now+30min（未支付自动释放机位，防匿名占坑锁库存）。
    const paymentExpiresAt: Date | null = isStaffEnteredOrder(requester)
      ? null
      : new Date(Date.now() + RETAIL_PAYMENT_TIMEOUT_MS);
    // 幂等：提前查 key 是否已存在
    if (body.idempotencyKey) {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey: body.idempotencyKey },
        include: { items: true, passengers: true },
      });
      if (existing) return existing;
    }

    // 联系人默认=录入人，电话选填（Order.contactName/contactPhone 为非空列，必须落具体值）：
    //   - 登录用户缺省时用登录账号兜底（与 batchCreateOrders 同口径）。
    //   - 游客缺省时用 guestContact 兜底（游客联系人路由层已断言存在）。
    const trimmedName = body.contactName?.trim();
    const trimmedPhone = body.contactPhone?.trim();
    let contactName = trimmedName || guest?.name || '系统录入';
    let contactPhone = trimmedPhone || guest?.phone || '-';
    // 仅当登录用户且联系人/电话有缺省时，才查录入人兜底 —— 两项都已填则跳过这次 DB 查询。
    if (!isGuest && (!trimmedName || !trimmedPhone)) {
      const recorder = await prisma.user.findUnique({
        where: { id: requester.userId },
        select: { displayName: true, email: true, phone: true },
      });
      contactName = trimmedName || recorder?.displayName || recorder?.email || '系统录入';
      contactPhone = trimmedPhone || recorder?.phone || '-';
    }

    // 出行人数校验（与前台 effectivePax 同口径）。
    // 关键：往返机票是「同一批人」，会拆成去/回两条 FLIGHT 行（各 quantity=pax）。
    // 所需出行人按「单程最大人数」算，取各 FLIGHT 行 quantity 的 MAX，绝不两段相加 ——
    // 否则 2 人往返会被错误要求 4 本护照（公测反馈）。
    // 签证/接送/套餐也都是「按人」的产品（同一批出行人），同样取 MAX 不取 SUM：
    //   required = max( max(FLIGHT 行 quantity), Σ(BUNDLE pax), Σ(VISA qty), Σ(TRANSFER qty) )
    // 镜像前台 CheckoutPage 的 effectivePax 计算，保证两端结论一致。
    const requiredPax = computeRequiredPassengerCount(body.items);
    if (requiredPax > 0 && requiredPax !== body.passengers.length) {
      throw new BadRequestError(
        `本次行程共需 ${requiredPax} 位出行人，当前填了 ${body.passengers.length} 位`,
      );
    }

    // 护照有效期必填（业务拍板，2026-07）：后台（ADMIN/STAFF）新建订单且含按人产品
    // （机票/套餐/签证——出行人必填的产品类型）时，每位出行人必须带护照有效期。
    // 批量/OTA 入单在 schema 层同口径拦截（passengerInputWithRequiredExpirySchema）。
    // 不含 AGENT/散客/游客：前台与小程序下单页不采集该字段，有自助补录通道可事后补；
    // 存量订单编辑走更新/补录路径（selfUpdate/换人），不经过本方法，不受影响。
    // 纯酒店/接送单的占位出行人（documentNumber='N/A'）不在此列（无按人产品行）。
    if (requesterRole === UserRole.ADMIN || requesterRole === UserRole.STAFF) {
      const hasPerPersonTravelItem = body.items.some(
        (it) => it.kind === 'FLIGHT' || it.kind === 'BUNDLE' || it.kind === 'VISA',
      );
      if (hasPerPersonTravelItem) {
        const missingExpiryRows = body.passengers
          .map((p, idx) => (p.passportExpiry ? null : idx + 1))
          .filter((n): n is number => n !== null);
        if (missingExpiryRows.length > 0) {
          throw new BadRequestError(
            `护照有效期必填：第 ${missingExpiryRows.join('、')} 位出行人未填写`,
          );
        }
      }
    }

    // 重复乘客校验：同班次「占座中」订单里已有同证件号乘客 → 拒绝，防同人同航班重复占座
    const flightScheduleIds = [
      ...new Set(
        body.items
          .filter((i): i is Extract<OrderItemInput, { kind: 'FLIGHT' }> => i.kind === 'FLIGHT')
          .map((i) => i.flightScheduleId),
      ),
    ];
    // allowDuplicatePassengers（ADMIN/STAFF 已在上方按身份收口）为真时不拦，返回冲突明细供审计 + 备注留痕；
    // 否则命中即抛 DuplicatePassengerError（code=DUPLICATE_PASSENGER）。无冲突恒返回 []。
    // `?? []`：payment-timeout 等既有测试把此私有方法 mock 成 resolve(undefined)，防 .length 读空。
    const duplicateConflicts =
      (await this.assertNoDuplicatePassengersOnFlights(
        flightScheduleIds,
        body.passengers.map((px) => px.documentNumber),
        allowDuplicatePassengers,
      )) ?? [];

    // 重复乘客强录留痕：附加一行「重复乘客强录：与订单 XXX 同班次同证件号」到订单备注（可追溯）。
    // 仅 allowDuplicatePassengers 放行且确有冲突时非空（其余情况 conflicts 恒为 []）。
    const duplicateForceNote =
      duplicateConflicts.length > 0
        ? `重复乘客强录：与订单 ${[
            ...new Set(duplicateConflicts.flatMap((c) => c.orderNumbers)),
          ].join('、')} 同班次同证件号`
        : null;
    const finalNotes = duplicateForceNote
      ? [body.notes, duplicateForceNote].filter(Boolean).join(' · ')
      : body.notes;

    // 代理归属判定提前到权威定价之前：散客 RETAIL 立减必须在套餐 percent-off
    // 后、expectedTotalCny 校验前加入定价结果；代理单则跳过 RETAIL 规则。
    const agentId = isGuest
      ? null
      : await resolveOrderAgentId(requester, body.agentId);

    // 先查所有 FLIGHT item 对应的 FlightSeatClass + 计算动态价（在事务外查，避免长事务）
    // body.flightSettlementPriceCny 存在 → 团队议价结算价覆盖机票价（鉴权在路由/批量层完成）。
    // 指定酒店星级不匹配的放行留痕（ADMIN/STAFF 带原因放行时才有内容）→ 建单成功后写审计。
    const starMismatchOverrides: DesignatedHotelStarMismatchOverride[] = [];
    // 酒店限额内超售豁免：仅内部 ADMIN/STAFF 录单（销控售罄后当天临时加房是常态业务，
    // 缺口 ≤ 上限放行并写 WARNING 审计）；前台散客/代理下单缺省 = 硬闸。
    const hotelOversellCapRooms = isStaffEnteredOrder(requester)
      ? await getHotelOversellCapRooms()
      : undefined;
    const pricedItems = await this.priceAndValidateItems(
      body.items,
      body.flightSettlementPriceCny,
      // 套餐乘客级住宿/签证选项：从下单乘客数组派生每人差异定价（优先级见 priceAndValidateItems）。
      body.passengers,
      // 仅后台/代理录单可用「无产品 id 的自定义价地面行」；对外角色（游客/CUSTOMER）一律走系统产品价。
      isStaffEnteredOrder(requester),
      // 星级闸按认证身份判权限（不信前端）：游客无角色 → null，与 AGENT/CUSTOMER 同样硬拒。
      { role: requesterRole ?? null, overrides: starMismatchOverrides },
      hotelOversellCapRooms,
    );

    // 散客 RETAIL 立减判定与 quote 共用 shouldApplyRetailSettlementDiscount，两边不会再分叉。
    if (shouldApplyRetailSettlementDiscount({ ...body, agentId })) {
      await this.applyRetailSettlementDiscount(body, pricedItems);
    }

    // ── 前台展示价兜底校验（S1）：下单前比对「前台展示总价」与「服务端权威商品价」──────────────
    // 基准取 pricedItems 逐行金额之和 —— **在护照临期附加费 / 录单调价之前**：这两项前台展示时并不知道
    //   （临期费依下单时护照有效期派生），不该计入比对，否则会误伤正常单。
    // expectedTotalCny 为可选，仅前台散客结账带（admin/批量/quote 不带 → assertDisplayedTotalMatches 内部跳过，
    // 不影响录单路径）。偏差 > 容差（1 元，容忍逐行取整误差）→ 抛 PRICE_CHANGED，让前台提示刷新重下，
    // 绝不静默按新价多收（典型：套餐机票展示 ¥0，下单拆腿按真实机票价实扣）。
    assertDisplayedTotalMatches(
      pricedItems.reduce((sum, p) => sum + p.amount, 0),
      body.expectedTotalCny,
    );

    // 签证订单规则：含 VISA 行时每位出行人必须填写护照有效期（送签材料必填）
    assertVisaPassengersHavePassportExpiry(body.items, body.passengers);

    // 护照有效期规则（相对出发日）：<90 天禁止下单；不足 6 个月每人 +200 临期附加费
    await this.applyPassportExpiryRule(body, pricedItems);

    // 出行人类型服务端权威派生（passengerToData）所需的「本单最早出发日」：与护照有效期规则
    // 同一口径（服务端查 DB，客户端改不了），事务外查一次，供下方写 Passenger 时使用。
    const authoritativeDepartureDate = await this.resolveEarliestFlightDepartureDate(body.items);

    // 录单调价/加项（权限已在上方按认证身份校验）：追加一条独立定价行，计入 subtotal/total。
    if (body.priceAdjustment) {
      pricedItems.push(buildPriceAdjustmentItem(body.priceAdjustment));
    }

    // 每人结算价（权限/互斥/与 passengers 等长已在入口断言）：差额模型分解，不手填任何行价。
    // 取 min(每人价) 为基准：逐人挂「该人价 − min」的非负 SETTLEMENT 差额行（=0 不生成；
    // passengerId 于事务内回填），整单再按「Σ每人价」走下方既有 SETTLEMENT 收敛。
    // 派生口径（订单详情「每人结算价」表）恰好还原所填值：
    //   基准每人 = (total − Σ按乘客净额)/人数 = min；每人价 = min + (该人价 − min)。
    let perPaxSettlementTotalCny: number | undefined;
    if (body.perPassengerSettlementCny !== undefined) {
      const prices = body.perPassengerSettlementCny;
      const minCny = Math.min(...prices);
      let diffSumCny = 0;
      prices.forEach((priceCny, i) => {
        const diffCny = Math.round((priceCny - minCny) * 100) / 100;
        if (diffCny === 0) return;
        if (diffCny > PRICE_ADJUSTMENT_CAP_CNY) {
          throw new BadRequestError(
            `第 ${i + 1} 位出行人结算价与最低每人价差额 ¥${diffCny} 超出调价上限（±¥${PRICE_ADJUSTMENT_CAP_CNY}），请复核`,
          );
        }
        diffSumCny = Math.round((diffSumCny + diffCny) * 100) / 100;
        pricedItems.push(
          buildPerPassengerSettlementItem({
            diffCny,
            settlementPerPaxCny: priceCny,
            basePerPaxCny: minCny,
            perPaxIndex: i,
          }),
        );
      });
      perPaxSettlementTotalCny = Math.round((minCny * prices.length + diffSumCny) * 100) / 100;
    }

    // 结算价日历自动取价（已拍板 B）：代理单 + 套餐已配日历键（档次+晚数）→ 按去程出发日期查每人结算价，
    // 结算总价 = 每人价 × 乘客数，喂给下方既有「结算总价 → SETTLEMENT 差额行」机制落价（服务端权威定价）。
    //   · 手工 settlementTotalCny（ADMIN/STAFF 通道，已在入口鉴权）优先，日历不覆盖。
    //   · 已配日历的套餐当日无价 → resolveBundleSettlementCalendarTotal 内抛 400 拒单。
    //   · 未配日历的套餐 / 非代理单 → 返回 null，现状不变（不进结算收敛）。
    // 说明：与 0723「结算价锁」不冲突——锁只在核对后写保护改价，日历只在创建时定价，两者时序不重叠。
    // 每人结算价在场时其合计即本单结算总价（与 settlementTotalCny 互斥，入口已断言）。
    let effectiveSettlementTotalCny = body.settlementTotalCny ?? perPaxSettlementTotalCny;
    let settlementCalendarAudit: Record<string, unknown> | null = null;
    // 机票结算价日历**明确放弃**自动取价的原因（如含非经济舱航段）；null = 没发生这回事。
    // 只留痕不拒单：本单照常按动态价成交，同业价交给人工结算价通道。
    let flightCalendarSkippedReason: string | null = null;
    // 批量「优惠 ¥/人」是独立的可叠加调整：只有服务端批量优惠路径注入的结构化标记
    // 才允许日历价与调整行叠加；普通 DISCOUNT 调价保持既有语义。
    const stackableCalendarAdjustment = body.priceAdjustment?.stackWithSettlementCalendar === true;
    let agentAutoDiscount: AutoDiscountSummary | null = null;
    if (effectiveSettlementTotalCny === undefined && agentId) {
      // BUNDLE 行加项净额（与 body.items 的 BUNDLE 行同序）：日历价 + 加项 才是本单结算价，
      // 否则升舱/单房差/指定酒店加价会被下方 SETTLEMENT 差额行收敛吞掉。
      const calendar = await this.resolveBundleSettlementCalendarTotal(
        body,
        pricedItems.filter((p) => p.kind === 'BUNDLE').map((p) => p.settlementAddOnCny ?? 0),
      );
      if (calendar) {
        // 只有没有任何手工价通道时才自动命中代理立减。手工优惠/团队议价/手动单价
        // 均视为整体替代，保留现有手工调整与日历价的收敛口径，不与规则叠加。
        const hasManualSettlementChannel =
          body.priceAdjustment !== undefined || body.flightSettlementPriceCny !== undefined;
        if (!hasManualSettlementChannel) {
          agentAutoDiscount = await this.applyAgentSettlementDiscount(
            pricedItems,
            calendar,
            agentId,
          );
        }
        effectiveSettlementTotalCny =
          calendar.totalCny - (agentAutoDiscount?.totalCny ?? 0) +
          (stackableCalendarAdjustment ? body.priceAdjustment?.amountCny ?? 0 : 0);
        settlementCalendarAudit = calendar.audit;
        if (agentAutoDiscount) {
          settlementCalendarAudit = {
            ...settlementCalendarAudit,
            autoDiscount: agentAutoDiscount,
          };
        }
      } else if (
        // 机票结算价日历（纯机票代理单）：套餐日历没接管时才轮到它。
        // 任一「手工价通道」在场一律不介入——手工价与日历价二选一，叠加会双重砸价：
        //   · priceAdjustment：批量的「OTA 结算单价」就是走这条（差额调价行）。
        //   · flightSettlementPriceCny：批量的「结算价/人（团队议价）」，已直接覆盖机票行单价。
        (body.priceAdjustment === undefined || stackableCalendarAdjustment) &&
        body.flightSettlementPriceCny === undefined
      ) {
        const flightCalendar = await this.resolveFlightSettlementCalendarTotal(body);
        if (flightCalendar && flightCalendar.totalCny !== null) {
          effectiveSettlementTotalCny =
            flightCalendar.totalCny + (stackableCalendarAdjustment ? body.priceAdjustment?.amountCny ?? 0 : 0);
          settlementCalendarAudit = flightCalendar.audit;
        } else if (flightCalendar) {
          // 明确放弃自动取价（如含非经济舱航段）：不收敛价格（现状 = 动态定价），
          // 但把原因留痕，免得事后没人说得清「这单为什么没走日历价」。
          flightCalendarSkippedReason = flightCalendar.skippedReason;
        }
      }
    }

    const calendarDiscountCny = stackableCalendarAdjustment
      ? Math.max(0, -(body.priceAdjustment?.amountCny ?? 0))
      : 0;
    if (settlementCalendarAudit && calendarDiscountCny > 0) {
      settlementCalendarAudit = { ...settlementCalendarAudit, discountCny: calendarDiscountCny };
    }

    if (agentAutoDiscount && effectiveSettlementTotalCny !== undefined && effectiveSettlementTotalCny <= 0) {
      throw new BadRequestError('立减规则叠加后结算价异常（≤0），请检查立减规则配置');
    }
    if (effectiveSettlementTotalCny !== undefined && effectiveSettlementTotalCny < 0) {
      throw new BadRequestError('优惠金额超过订单应收，请核对');
    }

    // 本单结算总价（权限/与 priceAdjustment 的互斥已在入口断言；代理单可由上方日历自动填充）：
    // 按「结算价 − 权威合计」自动生成一条 SETTLEMENT 差额行，把 total 收敛到结算价。权威合计取此刻
    // pricedItems 之和（含护照临期附加费等系统费行）——结算价语义是「本单最终收多少钱」。
    // 绝不改各明细行价格；diff=0 不生成行（系统价即结算价）；|diff| 超调价上限 → 400。
    let settlementAuthoritativeTotalCny: number | null = null;
    let settlementDiffCny: number | null = null;
    if (effectiveSettlementTotalCny !== undefined) {
      const authoritativeTotalCny = pricedItems.reduce((sum, p) => sum + p.amount, 0);
      // 两位小数取整：结算价最多两位小数（schema 已校验），差额对齐到分，避免浮点尾差。
      const diffCny =
        Math.round((effectiveSettlementTotalCny - authoritativeTotalCny) * 100) / 100;
      if (Math.abs(diffCny) > PRICE_ADJUSTMENT_CAP_CNY) {
        throw new BadRequestError(
          `结算总价与系统价（¥${authoritativeTotalCny}）差额 ¥${Math.abs(diffCny)} 超出调价上限（±¥${PRICE_ADJUSTMENT_CAP_CNY}），请复核结算价`,
        );
      }
      if (diffCny !== 0) {
        pricedItems.push(
          buildSettlementTotalItem({
            diffCny,
            authoritativeTotalCny,
            settlementTotalCny: effectiveSettlementTotalCny,
          }),
        );
      }
      settlementAuthoritativeTotalCny = authoritativeTotalCny;
      settlementDiffCny = diffCny;
    }

    const subtotal = pricedItems.reduce((sum, p) => sum + p.amount, 0);
    const total = subtotal; // 目前没有 taxes / discount，直接等于 subtotal
    if (total < 0) {
      throw new BadRequestError('优惠金额超过订单应收，请核对');
    }

    // 生成订单号（有极小概率撞 unique，重试 3 次）
    const orderNumber = await generateOrderNumber();

    // 事务：原子扣座位（CAS 防超卖）→ 写订单 → 写事件 → 消费本人锁位
    // 事务提交后要移除已消费锁位的到期任务（jobId seatlock:<id>），先收集 id
    const consumedLockIds: string[] = [];
    // 建单事务里被限额容忍的酒店超卖明细（仅内部录单可能非空）→ 事务提交后写 WARNING 审计。
    let oversoldHotelStays: HotelStayOversellRecord[] = [];
    let oversoldRandomTiers: RandomTierOversellRecord[] = [];
    const order = await prisma.$transaction(async (tx) => {
      // 用 updateMany 的 where 条件做原子"检查+扣减"一步到位，避免 TOCTOU
      // where: `sold + qty + lockedByOthers + heldQty <= capacity` 等价于
      // 可售余量 `capacity - sold - 未过期锁位 - 占位余座 >= qty`
      // 但 Prisma raw 不支持这种 cross-column where；用上述加法条件需要
      // SQL 函数，改用 raw SQL 保证原子性。
      // 原子扣座（CAS 防超卖）。一行经济舱 FLIGHT 在套餐升舱时会拆成两笔：
      //   ECONOMY  sold += quantity − businessUpgradeCount（剩下没升舱的人）
      //   BUSINESS sold += businessUpgradeCount（升舱的人，占用真实商务舱座位）
      // 净占座仍 = quantity，不超售商务舱、不持有幽灵经济舱座位。businessUpgradeCount=0 → 行为与旧版完全一致。
      const decrementSeat = async (
        scheduleId: string,
        cabin: import('@prisma/client').CabinClass,
        qty: number,
      ): Promise<void> => {
        if (qty <= 0) return;
        if (typeof tx.$queryRaw === 'function') {
          await tx.$queryRaw`
            SELECT id FROM "FlightSeatClass"
            WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
            FOR UPDATE
          `;
        }
        // 锁位语义：他人的 ACTIVE 未过期锁位占用余票（下单人自己的锁位不挡自己下单）
        const lockedAgg = await tx.seatLock.aggregate({
          _sum: { qty: true },
          where: {
            seatClass: { scheduleId, cabin },
            // 游客无锁位归属 → 所有他人 ACTIVE 锁位都占用余票
            ...(ownerUserId ? { userId: { not: ownerUserId } } : {}),
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
        });
        const lockedByOthers = lockedAgg._sum.qty ?? 0;
        const heldQty = await heldSeatsForCabin(tx, scheduleId, cabin);
        const affected = await tx.$executeRaw`
          UPDATE "FlightSeatClass"
          SET sold = sold + ${qty}, "updatedAt" = NOW()
          WHERE "scheduleId" = ${scheduleId}
            AND cabin = ${cabin}::"CabinClass"
            AND sold + ${qty} + ${lockedByOthers} + ${heldQty} <= capacity
        `;
        if (affected !== 1) {
          // 查当前库存给更友好的错误消息
          const sc = await tx.flightSeatClass.findFirst({
            where: { scheduleId, cabin },
            select: { capacity: true, sold: true },
          });
          const available = sc
            ? Math.max(0, sc.capacity - sc.sold - lockedByOthers - heldQty)
            : 0;
          throw new ConflictError(
            `${cabin} 余票不足：需要 ${qty} 张，仅剩 ${available} 张（并发抢占）`,
          );
        }
      };

      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT' || !p.flightScheduleId || !p.flightCabin) continue;
        const split = computeBundleSeatSplit(p.flightCabin, p.quantity, p.businessUpgradeCount);
        // 升舱的人占商务舱真实座位
        await decrementSeat(p.flightScheduleId, 'BUSINESS', split.business);
        // 其余人占本行原舱位（经济舱减掉升舱人数；非经济舱行 split.business=0，等于全额扣原舱）
        await decrementSeat(p.flightScheduleId, p.flightCabin, split.sameCabin);
      }

      // ── 酒店房量闸（CRITICAL 修复）：与扣座 CAS 对称的「防超卖」原子闸 ──────────
      // 座位有 CAS 防超卖，房量此前只有 BUNDLE 分支在**事务外**做了一次只读前瞻判定，
      // 单独 HOTEL 行（指定房型）更是一道闸都没有 —— 售罄后照样落库占房，销控板变负，
      // 只在事后超卖提醒里报警。这里在写 OrderItem 的**同一个事务**里，先锁目标酒店该区间的
      // 包房周期行再判定：判定与落库之间没有窗口，两笔并发下单抢最后一间只会成一笔。
      // （priceAndValidateItems 里那道事务外的判定保留为「友好预检」：它能在长事务开始前就
      //  拒掉明显售罄的单，也服务于 quote 试算；权威判定以这里为准。）
      // 未落位随机档行（无房型 / 占位酒店房型）不走这里，它们由下面那道随机档聚合闸把关。
      // 内部录单（hotelOversellCapRooms 非空）：限额内超售放行，明细收进 oversold* 供事务后
      // 写 WARNING 审计；超上限用带数字文案拒（运营要看得见差多少间）。对外端点仍中性话术硬闸。
      oversoldHotelStays = await assertHotelStaysFitWithinTx(tx, pricedItems, body.passengers, {
        maxOversellRooms: hotelOversellCapRooms,
        buildMessage:
          hotelOversellCapRooms != null ? undefined : () => HOTEL_SOLD_OUT_MESSAGE,
      });

      // ── 随机档聚合余量闸（同一事务、同一把锁语义）────────────────────────────
      // 与上面那道真酒店闸互补：未落位的随机档行占的是「同星级酒店合计余量」。
      // priceAndValidateItems 里那两处事务外判定同样保留为友好预检（也服务于 quote 试算），
      // 权威判定以这里为准 —— 先锁该档次全部真酒店的包房周期行，判定与落库之间不留窗口。
      oversoldRandomTiers = await assertRandomTierStaysFitWithinTx(tx, pricedItems, {
        maxOversellRooms: hotelOversellCapRooms,
        buildMessage:
          hotelOversellCapRooms != null ? undefined : () => HOTEL_SOLD_OUT_MESSAGE,
      });

      // 初始状态直接 PENDING_PAYMENT（MVP 阶段没有 DRAFT 保存流）
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: ownerUserId,
          agentId,
          // 游客下单：存联系人，供公开订单查询匹配 + 履约联系
          guestName: guest?.name ?? null,
          guestPhone: guest?.phone ?? null,
          guestEmail: guest?.email ?? null,
          status: OrderStatus.PENDING_PAYMENT,
          currency: 'CNY',
          subtotal: new Prisma.Decimal(subtotal),
          total: new Prisma.Decimal(total),
          contactName,
          contactPhone,
          contactEmail: body.contactEmail,
          paymentExpiresAt, // 前台散客=now+30min；后台/代理录入=null（不限时）
          idempotencyKey: body.idempotencyKey,
          notes: finalNotes,
          // 订单级签证状态 + 结构化备注四栏（可选；不传则留空，与旧行为一致）
          visaStatus: body.visaStatus ?? null,
          noteHotel: body.noteHotel ?? null,
          noteVisa: body.noteVisa ?? null,
          notePayment: body.notePayment ?? null,
          noteSpecial: body.noteSpecial ?? null,
          items: {
            create: pricedItems.map((p) => ({
              kind: p.kind,
              description: p.description,
              quantity: p.quantity,
              unitPrice: new Prisma.Decimal(p.unitPrice),
              amount: new Prisma.Decimal(p.amount),
              flightScheduleId: p.flightScheduleId ?? null,
              flightCabin: p.flightCabin ?? null,
              hotelRoomTypeId: p.hotelRoomTypeId ?? null,
              // 未落位随机单占房行（未落具体酒店）；落位后由换酒店流程改写并清空本列
              randomStarTier: p.randomStarTier ?? null,
              hotelCheckIn: p.hotelCheckIn ?? null,
              hotelCheckOut: p.hotelCheckOut ?? null,
              transferId: p.transferId ?? null,
              visaId: p.visaId ?? null,
              // 签证预计出行日期：纯签证单的出发日锚点（非 VISA 行恒 null）
              visaIntendedDate: p.visaIntendedDate ?? null,
              bundleId: p.bundleId ?? null,
              // 计费房间数（支持 0.5 间）：套餐/酒店行解析后落库，供房控读取。
              roomsBilled: p.roomsBilled != null ? new Prisma.Decimal(p.roomsBilled) : null,
              // 产品类成本快照（房/签/车）：NULL = 产品未录成本或 FLIGHT 行（机票走班次重算）。
              unitCostCny: p.unitCostCny != null ? new Prisma.Decimal(p.unitCostCny) : null,
              totalCostCny: p.totalCostCny != null ? new Prisma.Decimal(p.totalCostCny) : null,
              metadata: (p.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
            })),
          },
          passengers: {
            create: body.passengers.map((px) => passengerToData(px, { authoritativeDepartureDate })),
          },
          statusEvents: {
            create: {
              fromStatus: null,
              toStatus: OrderStatus.PENDING_PAYMENT,
              actorUserId: ownerUserId, // 游客下单 → null（系统/匿名）
              reason: isGuest ? '游客下单创建' : '订单创建',
            },
          },
        },
        include: { items: true, passengers: true, statusEvents: true },
      });

      // 操作费自动计提（财务定：订单录入/服务人员费，每单固定 ¥20）
      // 注意：操作费 ≠ 手续费（手续费=收款二维码/国际清算行结算手续费，仍走 HANDLING_FEE）
      await tx.orderCostItem.create({
        data: {
          orderId: created.id,
          category: 'OPERATION_FEE',
          amountCny: new Prisma.Decimal(OPERATION_FEE_CNY_PER_ORDER),
          note: '系统自动计提（每单固定操作费）',
        },
      });

      // 消费下单人自己的锁位：FLIGHT 行对应舱位上本人的 ACTIVE 未过期锁位 → CONSUMED
      // （座位已通过 sold 扣减真实占用，锁位完成使命；过期任务提交后再移除）
      // 游客无锁位归属 → 跳过整段
      for (const p of pricedItems) {
        if (p.kind !== 'FLIGHT' || !ownerUserId) continue;
        const myLocks = await tx.seatLock.findMany({
          where: {
            seatClass: { scheduleId: p.flightScheduleId!, cabin: p.flightCabin! },
            userId: ownerUserId,
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (myLocks.length === 0) continue;
        const lockIds = myLocks.map((l) => l.id);
        await tx.seatLock.updateMany({
          where: { id: { in: lockIds } },
          data: { status: SeatLockStatus.CONSUMED, consumedOrderId: created.id },
        });
        consumedLockIds.push(...lockIds);
      }

      // 物化列 hasReturnLeg：建单是 FLIGHT 行唯一的产生点（单笔录单 / 前台商城 / 批量建单
      // 都经此），故在同一事务内按订单行真实结构落列，单程单落 false、往返单落 true。
      await syncOrderHasReturnLeg(tx, created.id);

      // 每人结算价差额行 → 回填 passengerId（嵌套 create 建行时乘客 id 尚不存在）。
      // 提交数组与 body.passengers 同序；落库乘客按「fullName|documentNumber」多重集与输入
      // 双射匹配（嵌套 create 每个输入恰好落一行；重名重证件的两人可互换，不影响金额归属）。
      if (body.perPassengerSettlementCny !== undefined) {
        const idQueueByKey = new Map<string, string[]>();
        for (const px of created.passengers) {
          const key = `${px.fullName}|${px.documentNumber}`;
          const queue = idQueueByKey.get(key);
          if (queue) queue.push(px.id);
          else idQueueByKey.set(key, [px.id]);
        }
        const passengerIdByIndex = body.passengers.map(
          (px) => idQueueByKey.get(`${px.fullName}|${px.documentNumber}`)?.shift() ?? null,
        );
        for (const it of created.items) {
          const meta = it.metadata as Record<string, unknown> | null;
          const idx =
            meta && meta.perPassenger === true && typeof meta.perPaxIndex === 'number'
              ? meta.perPaxIndex
              : null;
          if (idx === null) continue;
          const pid = passengerIdByIndex[idx] ?? null;
          if (!pid) continue; // 理论不可达：乘客与差额行同源自同一提交数组
          await tx.orderItem.update({ where: { id: it.id }, data: { passengerId: pid } });
          it.passengerId = pid; // 同步内存副本，创建响应即带归属，无需重查
        }
      }

      // 座位已在订单 create 之前原子扣减；此处无需再动库存
      return created;
    });

    // 事务成功后：下单即建签证任务（best-effort）——让「录进去但还没付款」的需签证单也进签证台。
    // 放在订单事务外，签证任务建失败也不回滚订单（PAID 时会再补建，幂等）。其余岗位任务仍留到 PAID。
    try {
      await createVisaTaskAtCreation(prisma, order.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to create visa task at order creation for', order.id, err);
    }

    // 事务成功后：移除已消费锁位的到期任务（best-effort；worker 端幂等）
    if (consumedLockIds.length > 0) {
      try {
        const { cancelSeatLockExpiry } = await import('../../queues/queue.js');
        await Promise.all(consumedLockIds.map((lockId) => cancelSeatLockExpiry(lockId)));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to cancel seat-lock expiry jobs for', order.id, err);
      }
    }

    // 事务成功后：排队 seat-hold 自动释放任务（订单未在 paymentExpiresAt 内支付则取消）。
    // 后台/代理录入单 paymentExpiresAt=null → 不入队：机位永不自动退，只能由运营手动释放。
    if (order.paymentExpiresAt) {
      const holdMs = Math.max(0, order.paymentExpiresAt.getTime() - Date.now());
      try {
        const { scheduleSeatHoldRelease } = await import('../../queues/queue.js');
        await scheduleSeatHoldRelease(order.id, holdMs);
      } catch (err) {
        // 排队失败不阻塞下单 —— 但记录到日志，值班可能要手动兜底
        // eslint-disable-next-line no-console
        console.error('[orders] failed to schedule seat-hold release for', order.id, err);
      }
    }

    // 录单调价/加项审计（原价 / 调整额 / 原因 / 操作人）。权限已在入口断言 → 此处必为 ADMIN/STAFF。
    // await（非 fire-and-forget）：调价是财务敏感动作，落审计后再返回，便于对账与追责。
    if (body.priceAdjustment && !isGuest) {
      const { amountCny, reasonCode, reasonText } = body.priceAdjustment;
      const adjustedTotal = Number(order.total);
      await writeAudit({
        actor: { userId: requester.userId, role: requester.role },
        action: 'ADJUST_ORDER_PRICE',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        before: { total: (adjustedTotal - amountCny).toString() },
        after: {
          total: adjustedTotal.toString(),
          amountCny,
          reasonCode,
          reasonLabel: PRICE_ADJUSTMENT_REASON_LABEL[reasonCode],
          reasonText: reasonText?.trim() || null,
        },
      });
    }

    // 本单结算总价审计（权威合计 / 结算价 / 差额 / 操作人 / 取价来源）。权限已在入口断言。
    // 来源二选一：手工结算价（ADMIN/STAFF 通道）或结算价日历自动取价（代理单，settlementCalendarAudit 非空）。
    // WARNING 级：整单收款额被收敛到结算价，是需要留痕复核的财务动作。
    // diff=0（未生成差额行、总额未变）通常不写审计，避免无操作的 WARNING 噪音；
    // 但命中自动立减时仍留一条日历审计，确保规则快照命中可追溯。
    // await（非 fire-and-forget）：与录单调价同口径，落审计后再返回，便于对账与追责。
    if (
      settlementDiffCny !== null &&
      // 每人结算价通道：整单差额恰为 0 也要留痕——逐人差额行已经改变了每个人的应收份额。
      (settlementDiffCny !== 0 ||
        agentAutoDiscount !== null ||
        body.perPassengerSettlementCny !== undefined) &&
      !isGuest
    ) {
      await writeAudit({
        actor: { userId: requester.userId, role: requester.role },
        action: 'APPLY_SETTLEMENT_TOTAL',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        before: { total: settlementAuthoritativeTotalCny?.toString() ?? null },
        after: {
          total: Number(order.total).toString(),
          settlementTotalCny: effectiveSettlementTotalCny,
          diffCny: settlementDiffCny,
          reasonCode: 'SETTLEMENT',
          reasonLabel: PRICE_ADJUSTMENT_REASON_LABEL.SETTLEMENT,
          // 每人结算价通道留痕（与 passengers 同序的逐人价）；整单结算总价/日历取价时为 null。
          perPassengerSettlementCny: body.perPassengerSettlementCny ?? null,
          // 结算价日历自动取价来源留痕（档次/晚数/出发日期/每人价/人数）；手工结算价时为 null。
          settlementCalendar: settlementCalendarAudit,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    // 机票结算价日历放弃自动取价的留痕（含非经济舱航段等）：本单没有自动同业价，
    // 需要运营/财务补人工结算价，否则这单按动态价成交、同业口径缺一块。
    // WARNING 级：是要有人接手处理的缺口，不是日常噪音。
    if (flightCalendarSkippedReason && !isGuest) {
      await writeAudit({
        actor: { userId: requester.userId, role: requester.role },
        action: 'FLIGHT_SETTLEMENT_CALENDAR_SKIPPED',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: { reason: flightCalendarSkippedReason },
        severity: AuditSeverity.WARNING,
      });
    }

    // 重复乘客强录审计（证件号 + 冲突订单号 + 操作人）。权限已在入口按身份收口 → 此处必为 ADMIN/STAFF。
    // WARNING 级：越过同班次占座校验是需要留痕复核的动作。!isGuest 让 TS 收窄到 OrderRequester。
    if (duplicateConflicts.length > 0 && !isGuest) {
      await writeAudit({
        actor: { userId: requester.userId, role: requester.role },
        action: 'FORCE_DUPLICATE_PASSENGERS',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: { conflicts: duplicateConflicts },
        severity: AuditSeverity.WARNING,
      });
    }

    // 指定酒店星级不匹配放行留痕（套餐档次 / 酒店星级 / 原因 / 操作人）。
    // 权限已在星级闸内按角色收口 → 走到这里必为 ADMIN/STAFF。
    // WARNING 级：客人付的是 A 档的钱、住的是 B 档的店，是需要有人复核的交付偏差。
    for (const override of starMismatchOverrides) {
      if (isGuest) break;
      await writeAudit({
        actor: { userId: requester.userId, role: requester.role },
        action: 'DESIGNATED_HOTEL_STAR_MISMATCH_OVERRIDE',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: order.orderNumber,
        after: override,
        severity: AuditSeverity.WARNING,
      });
    }

    // 酒店限额内超售放行留痕（哪家/哪档、哪几晚、缺口几间 + 操作人）。仅内部录单可能非空
    // （豁免按 isStaffEnteredOrder 收口 → 走到这里必为 ADMIN/STAFF）。
    // WARNING 级：销控已是负数，需要有人当天去向酒店加房——与机票容量超售审计同哲学。
    // await（非 fire-and-forget）：与上面各财务敏感审计同口径，落审计后再返回。
    if ((oversoldHotelStays.length > 0 || oversoldRandomTiers.length > 0) && !isGuest) {
      const hotelNameById = new Map<string, string>();
      if (oversoldHotelStays.length > 0) {
        const hotels = await prisma.hotel.findMany({
          where: { id: { in: oversoldHotelStays.map((r) => r.hotelId) } },
          select: { id: true, name: true },
        });
        for (const h of hotels) hotelNameById.set(h.id, h.name);
      }
      const parts = [
        ...oversoldHotelStays.map((r) => {
          const worst = r.violations.reduce((a, b) => (b.shortfall > a.shortfall ? b : a));
          return `${hotelNameById.get(r.hotelId) ?? r.hotelId} ${worst.date} 起缺 ${worst.shortfall} 间`;
        }),
        ...oversoldRandomTiers.map((r) => {
          const worst = r.violations.reduce((a, b) => (b.shortfall > a.shortfall ? b : a));
          return `${randomStarTierLabel(r.tier)} ${worst.date} 起缺 ${worst.shortfall} 间`;
        }),
      ];
      await writeAudit({
        actor: { userId: requester.userId, role: requester.role },
        action: 'CREATE_ORDER_HOTEL_OVERSOLD',
        targetType: 'ORDER',
        targetId: order.id,
        targetLabel: `${order.orderNumber} 超售放行（${parts.join('、')}，上限 ${hotelOversellCapRooms ?? env.HOTEL_MAX_OVERSELL_ROOMS} 间）`,
        after: {
          maxOversellRooms: hotelOversellCapRooms ?? env.HOTEL_MAX_OVERSELL_ROOMS,
          hotels: oversoldHotelStays.map((r) => ({
            hotelId: r.hotelId,
            hotelName: hotelNameById.get(r.hotelId) ?? null,
            nights: r.violations.map((v) => ({
              date: v.date,
              block: v.block,
              physicalUsed: v.physicalUsed,
              shortfall: v.shortfall,
            })),
          })),
          randomTiers: oversoldRandomTiers.map((r) => ({
            tier: r.tier,
            nights: r.violations.map((v) => ({
              date: v.date,
              remaining: v.remaining,
              rooms: v.rooms,
              shortfall: v.shortfall,
            })),
          })),
        },
        severity: AuditSeverity.WARNING,
      });
    }

    return order;
  }

  /**
   * 录单前试算（quote）：复用权威定价 priceAndValidateItems，只算不落库、不扣座。
   * 返回各行明细 + subtotal/total（CNY），供录单页在提交前展示「系统价」。
   *
   * @param requester 试算发起人的身份（只用角色）。给了才启用「指定酒店星级闸」，口径与
   *   createOrder 同一处判定、同一句文案：
   *     · AGENT / CUSTOMER / 游客（role=null）→ 与提交时一样当场拒（此前报价成功、提交才 400，
   *       代理选完不匹配的酒店、拿到一个根本下不了的价）；
   *     · ADMIN / STAFF → 不拦（他们的越档放行是允许的，放行原因在**提交**时才收，
   *       试算阶段不该逼着填原因，否则运营连看一眼差价都做不到）。
   *   不传 requester = 内部预算 / 纯算价路径，不判（行为与本次收紧前一致）。
   */
  async quoteOrder(
    // priceAdjustment / settlementTotalCny / flightSettlementPriceCny 已随 quoteOrderBodySchema
    // 暴露（形状与 createOrderBodySchema 对应字段一致）——立减判定与 createOrder 共用同一函数，
    // 录单页填了手工价通道字段后随试算一起发送，两边判定同步收紧。
    body: QuoteOrderBody,
    requester?: { role: UserRole | null },
  ): Promise<{
    currency: string;
    subtotal: number;
    total: number;
    items: Array<{
      kind: OrderItemKind;
      description: string;
      quantity: number;
      unitPrice: number;
      amount: number;
    }>;
    settlementPreview: SettlementPreview;
  }> {
    // 星级闸只对「提交时会被硬拒」的身份启用（AGENT/CUSTOMER/游客），让报价与提交给出同一答案；
    // ADMIN/STAFF 传 undefined = 不判，试算阶段不索要放行原因（原因在 createOrder 收）。
    const isOperator =
      requester?.role === UserRole.ADMIN || requester?.role === UserRole.STAFF;
    const starGate: DesignatedHotelStarGate | undefined =
      requester && !isOperator ? { role: requester.role, overrides: [] } : undefined;
    // 试算带上乘客级住宿/签证选项（缺省则回落 item 级旧口径），使系统价随每人选择实时变化。
    // 允许自由行手录价试算（quote 仅 ADMIN/STAFF/AGENT 路由可达）。
    const priced = await this.priceAndValidateItems(
      body.items,
      undefined,
      body.passengers,
      true,
      starGate,
      // 内部 ADMIN/STAFF 试算与 createOrder 同口径吃限额内超售豁免（否则录单弹窗试算
      // 先被友好预检拒掉，实下单反而能成）；AGENT 试算仍硬闸。
      isOperator ? await getHotelOversellCapRooms() : undefined,
    );
    // 散客立减与结算价日历是两条独立规则链：先按每个套餐行命中 RETAIL，
    // 即使日历价未维护，quote 的商品总价也必须与 createOrder 保持一致。
    // 判定与 createOrder 共用同一个函数（此前 quote 只判 !agentId、createOrder 还要求无手工价通道，
    // 带手工调价时报价里有立减、实下单没有 —— 两个数字对不上）。
    if (shouldApplyRetailSettlementDiscount(body)) {
      await this.applyRetailSettlementDiscount({ items: body.items }, priced);
    }

    let settlementPreview: SettlementPreview = null;
    try {
      const quoteCreateBody: Pick<CreateOrderBody, 'items'> = { items: body.items };
      const bundleCalendar = await this.resolveBundleSettlementCalendarTotal(
        quoteCreateBody,
        priced.filter((p) => p.kind === 'BUNDLE').map((p) => p.settlementAddOnCny ?? 0),
      );
      if (bundleCalendar) {
        let autoDiscount: AutoDiscountSummary | null = null;
        // 手工价通道（与 createOrder 的 hasManualSettlementChannel 同口径）：priceAdjustment /
        // settlementTotalCny / flightSettlementPriceCny 任一在场 → 视为整体替代方案，跳过自动立减
        // 注入。此前这里只判 body.agentId，没有这道闸——运营填了手工结算价/优惠后，试算仍显示一笔
        // 代理自动立减，真下单时（createOrder 已收紧）却不生效，两个数字对不上。
        const hasManualSettlementChannel =
          body.priceAdjustment !== undefined ||
          body.settlementTotalCny !== undefined ||
          body.flightSettlementPriceCny !== undefined;
        if (body.agentId && !hasManualSettlementChannel) {
          autoDiscount = await this.applyAgentSettlementDiscount(
            priced,
            bundleCalendar,
            body.agentId,
          );
        }
        const auditLines = Array.isArray(bundleCalendar.audit.lines)
          ? bundleCalendar.audit.lines
          : [];
        settlementPreview = {
          ok: true,
          source: 'GROUND',
          totalCny: bundleCalendar.totalCny - (autoDiscount?.totalCny ?? 0),
          departDate:
            typeof bundleCalendar.audit.departDate === 'string'
              ? bundleCalendar.audit.departDate
              : undefined,
          lines: [
            ...auditLines.map((line) => ({
              pricePerPersonCny: Number(line.pricePerPersonCny ?? 0),
              pax: Number(line.pax ?? 0),
              ...(Number(line.addOnCny ?? 0) !== 0 ? { addOnCny: Number(line.addOnCny) } : {}),
              note: String(line.note ?? ''),
            })),
            ...(autoDiscount
              ? autoDiscount.hits.map((hit) => ({
                  pricePerPersonCny: -hit.perPersonCny,
                  pax: hit.pax,
                  note: '同业立减',
                }))
              : []),
          ],
          ...(autoDiscount
            ? {
                autoDiscount: {
                  hits: autoDiscount.hits,
                  pax: autoDiscount.pax,
                  totalCny: autoDiscount.totalCny,
                },
              }
            : {}),
        };
      } else {
        const flightCalendar = await this.resolveFlightSettlementCalendarTotal(quoteCreateBody);
        if (flightCalendar && flightCalendar.totalCny === null) {
          // 明确放弃自动取价（含非经济舱航段等）→ 试算里直接把原因摆给录单人，
          // 免得看到「没有同业价」以为是日历没维护、跑去配一格根本不会被用到的价。
          settlementPreview = { ok: false, reason: flightCalendar.skippedReason };
        } else if (flightCalendar) {
          const auditLines = Array.isArray(flightCalendar.audit.lines)
            ? flightCalendar.audit.lines
            : [];
          settlementPreview = {
            ok: true,
            source: 'FLIGHT',
            totalCny: flightCalendar.totalCny,
            lines: auditLines.map((line) => ({
              pricePerPersonCny: Number(line.pricePerPersonCny ?? 0),
              pax: Number(line.pax ?? 0),
              note: String(line.note ?? ''),
            })),
          };
        }
      }
    } catch (error) {
      if (error instanceof BadRequestError) {
        settlementPreview = { ok: false, reason: error.message };
      } else {
        console.error('[orders] settlement calendar quote failed', error);
        settlementPreview = null;
      }
    }

    const items = priced.map((p) => ({
      kind: p.kind,
      description: p.description,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      amount: p.amount,
    }));
    const subtotal = items.reduce((sum, p) => sum + p.amount, 0);
    return { currency: 'CNY', subtotal, total: subtotal, items, settlementPreview };
  }

  // ════════════════════════════════════════════════════════════════════
  // 定价 + 校验（事务外，节省行锁时间）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 护照有效期业务规则（反馈：签证岗）。仅对有出发日的订单（含 FLIGHT）生效，
   * 且只检查填了 passportExpiry 的乘客（OCR/手填得到）。
   *   - 距出发日不足 6 个月（180 天）→ 每位 +200 临期附加费（FEE 行）
   * 通过 push 到 pricedItems 让附加费自然进入 subtotal/total/items。
   * 不足 90 天不再拒单（业务口径：临期护照也可开票）——录单端只做提示，由录入人自行确认。
   */
  /**
   * 本单最早 FLIGHT 行出发时间（服务端权威来源，直接查 DB，客户端改不了）。
   * 无 FLIGHT 行（纯地面单）或班次查无 → null。供护照有效期规则、出行人类型服务端权威派生
   * （passengerToData）共用同一口径的出发日。
   */
  private async resolveEarliestFlightDepartureDate(items: OrderItemInput[]): Promise<Date | null> {
    const scheduleIds = items
      .filter((i): i is Extract<OrderItemInput, { kind: 'FLIGHT' }> => i.kind === 'FLIGHT')
      .map((i) => i.flightScheduleId);
    if (scheduleIds.length === 0) return null;
    const scheds = await prisma.flightSchedule.findMany({
      where: { id: { in: scheduleIds } },
      select: { departureTime: true },
    });
    return earliestFlightDeparture(scheds.map((s) => ({ kind: 'FLIGHT', flightSchedule: s })));
  }

  private async applyPassportExpiryRule(
    body: CreateOrderBody,
    pricedItems: Array<{ kind: OrderItemKind; description: string; quantity: number; unitPrice: number; amount: number; totalCostCny?: number }>,
  ): Promise<void> {
    const scheduleIds = body.items
      .filter((i): i is Extract<OrderItemInput, { kind: 'FLIGHT' }> => i.kind === 'FLIGHT')
      .map((i) => i.flightScheduleId);
    if (scheduleIds.length === 0) return; // 无航班 → 无出发日 → 跳过

    const scheds = await prisma.flightSchedule.findMany({
      where: { id: { in: scheduleIds } },
      select: { departureTime: true },
    });
    if (scheds.length === 0) return;
    // 取最早出发日做基准（行程第一段）
    const departure = scheds.reduce<Date>(
      (min, s) => (s.departureTime < min ? s.departureTime : min),
      scheds[0].departureTime,
    );

    const DAY = 24 * 60 * 60 * 1000;
    let surchargeCount = 0;
    for (const px of body.passengers) {
      if (!px.passportExpiry) continue; // 没填有效期 → 无法判定，跳过
      const expiry = new Date(px.passportExpiry);
      const days = Math.floor((expiry.getTime() - departure.getTime()) / DAY);
      if (days < PASSPORT_EXPIRY_SURCHARGE_DAYS) surchargeCount += 1;
    }

    if (surchargeCount > 0) {
      pricedItems.push({
        kind: 'FEE',
        description: `护照临期附加费（有效期不足 6 个月，${surchargeCount} 人）`,
        quantity: surchargeCount,
        unitPrice: NEAR_EXPIRY_SURCHARGE_CNY,
        amount: NEAR_EXPIRY_SURCHARGE_CNY * surchargeCount,
        // 纯附加费行，无采购成本 → 显式落 0，不留 NULL（避免拖累毛利明细报「缺成本」）。
        totalCostCny: 0,
      });
    }
  }

  /**
   * 把代理套餐地面日历命中的固定立减写成独立 DISCOUNT 行。
   * 立减行随后参与结算总价收敛，因此「日历价 − 立减」与订单总额保持同一口径。
   */
  private async applyAgentSettlementDiscount(
    pricedItems: PricedOrderItem[],
    calendar: { totalCny: number; audit: Record<string, unknown> },
    agentId: string,
  ): Promise<AutoDiscountSummary | null> {
    const lines = Array.isArray(calendar.audit.lines)
      ? (calendar.audit.lines as Array<Record<string, unknown>>)
      : [];
    const hits: AutoDiscountSummary['hits'] = [];
    let totalCny = 0;
    let totalPax = 0;
    for (const line of lines) {
      const tier = line.tier as SettlementTier | undefined;
      const nights = Number(line.nights);
      const departDate = typeof line.departDate === 'string' ? line.departDate : null;
      const pax = Math.max(0, Math.trunc(Number(line.pax) || 0));
      if (!tier || !departDate || !Number.isInteger(nights) || pax <= 0) continue;
      const hit = await resolveAgentSettlementDiscount(agentId, tier, nights, departDate);
      if (!hit) continue;
      const bundleId = typeof line.bundleId === 'string' ? line.bundleId : null;
      const item = buildSettlementDiscountItem({ hit, pax, bundleId });
      pricedItems.push(item);
      hits.push({
        ruleId: hit.ruleId,
        kind: hit.kind,
        perPersonCny: hit.discountPerPersonCny,
        pax,
      });
      totalCny += hit.discountPerPersonCny * pax;
      totalPax += pax;
    }
    if (hits.length === 0) return null;
    return {
      hits,
      pax: totalPax,
      totalCny,
    };
  }

  /**
   * 散客套餐在套餐 percent-off 后命中 RETAIL 立减。
   * 该方法只接受已经完成套餐权威定价和 percent-off 的 pricedItems，确保顺序固定。
   *
   * 立减叠加后若把散客价压到**同业结算价以下** → 拒单（渠道价格倒挂：散客比代理还便宜，
   * 代理会转头去前台自己下单）。取不到同业价（该档次/晚数/出发日未配日历）时维持放行 ——
   * 没有基准就不做判断，避免误伤未配日历的正常单。
   */
  private async applyRetailSettlementDiscount(
    body: Pick<CreateOrderBody, 'items'>,
    pricedItems: PricedOrderItem[],
  ): Promise<AutoDiscountSummary | null> {
    if (
      typeof (prisma as unknown as { bundle?: { findMany?: unknown } }).bundle?.findMany !==
      'function'
    ) {
      return null;
    }
    const bundleItems = body.items.filter(
      (item): item is Extract<OrderItemInput, { kind: 'BUNDLE' }> =>
        item.kind === 'BUNDLE' && Boolean(item.bundleId),
    );
    if (bundleItems.length === 0) return null;

    const bundles = await prisma.bundle.findMany({
      where: { id: { in: [...new Set(bundleItems.map((item) => item.bundleId))] } },
      select: { id: true, name: true, settlementTier: true, settlementNights: true },
    });
    const bundleById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
    const configured = bundleItems.filter((item) => {
      const bundle = bundleById.get(item.bundleId);
      return bundle?.settlementTier != null && bundle.settlementNights != null;
    });
    if (configured.length === 0) return null;

    const hits: AutoDiscountSummary['hits'] = [];
    let totalCny = 0;
    let totalPax = 0;
    let sameIndustryCalendarTotal = 0;
    const hitBundleIds: string[] = [];
    const hitRuleIds: string[] = [];

    for (const item of configured) {
      const bundle = bundleById.get(item.bundleId);
      if (!bundle?.settlementTier || bundle.settlementNights == null) continue;
      const departDate = await this.resolveBundleItemDepartureLocalDate(body, item);
      if (!departDate) continue;
      const pax = resolveBundleOccupancy({
        adultCount: item.adultCount,
        childCount: item.childCount,
        infantCount: item.infantCount,
        quantity: item.quantity,
        metadata: item.metadata,
      }).headCount;
      if (pax <= 0) continue;
      const hit = await resolveRetailSettlementDiscount(
        bundle.settlementTier as SettlementTier,
        bundle.settlementNights,
        departDate,
      );
      if (!hit) continue;
      pricedItems.push(buildSettlementDiscountItem({ hit, pax, bundleId: bundle.id }));
      hits.push({
        ruleId: hit.ruleId,
        kind: hit.kind,
        perPersonCny: hit.discountPerPersonCny,
        pax,
      });
      totalCny += hit.discountPerPersonCny * pax;
      totalPax += pax;
      hitBundleIds.push(bundle.id);
      hitRuleIds.push(hit.ruleId);

      // 同业价基准：命中立减的这几张套餐按同一（档次×晚数×出发日）取同业结算价，
      // 累加成本单的「同业价合计」，供下方击穿闸比对。取不到价的行不进基准（宁可不判）。
      const rate = await getSettlementRate(
        bundle.settlementTier as SettlementTier,
        bundle.settlementNights,
        departDate,
      );
      if (rate) sameIndustryCalendarTotal += rate.pricePerPersonCny * pax;
    }
    if (hits.length === 0) return null;

    const afterTotal = pricedItems.reduce((sum, item) => sum + item.amount, 0);
    if (afterTotal <= 0) {
      // eslint-disable-next-line no-console
      console.error('[orders] retail settlement discount made order total non-positive', {
        bundleIds: hitBundleIds,
        ruleIds: hitRuleIds,
        totalCny: afterTotal,
      });
      throw new BadRequestError('优惠叠加后金额异常，请联系客服');
    }
    // ── 渠道价格倒挂闸：散客价不得低于同业结算价 ────────────────────────────
    // 旧口径只打一条 warn 就放行 —— 日志没人盯，倒挂的单照常成交：同一份货散客比代理便宜，
    // 代理只要发现就会绕开自己的账号到前台下单，同业价体系当场作废。改为硬拒。
    // 只在「同业价取得到（sameIndustryCalendarTotal > 0）且确实被击穿」时触发；
    // 取不到价（未配日历）→ 无基准可比，维持放行，不误伤。
    if (sameIndustryCalendarTotal > 0 && afterTotal < sameIndustryCalendarTotal) {
      // eslint-disable-next-line no-console
      console.error('[orders] retail settlement discount is below settlement calendar price', {
        bundleIds: hitBundleIds,
        ruleIds: hitRuleIds,
        orderTotalCny: afterTotal,
        settlementCalendarCny: sameIndustryCalendarTotal,
      });
      // 文案不带同业价数字：这条闸在前台散客下单路径上也会触发，内部结算价不该回给客人。
      throw new BadRequestError(
        '本单优惠后的价格低于同业结算价，不能按此价成交（散客价不得低于同业价）。' +
          '请调整立减规则，或联系客服走人工通道。',
      );
    }
    return {
      hits,
      pax: totalPax,
      totalCny,
    };
  }

  /**
   * 结算价日历取价（已拍板 B）：代理套餐单按去程出发日期 × 档次 × 晚数取每人结算价，返回结算总价。
   * 仅当本单存在「已配日历键（settlementTier + settlementNights 都非空）」的套餐时才参与：
   *   · 结算总价 = Σ(每张已配套餐：每人价 × 该套餐乘客数)。
   *     乘客数取套餐占座模型 headCount（成人 + 占座儿童 + 不占座婴儿，全部同价）。
   *     ⚠ 婴儿计入人数且暂按每人同价——是否单列婴儿价待运营确认（见任务遗留项）。
   *   · 去程出发日期 = 本单最早 FLIGHT 航段的出发地本地日（localDate，与班次日期口径一致）。
   *   · 命中日历返回价；已配日历但当日无价 → 抛 400「该出发日期的结算价未维护，请联系运营」。
   * 无已配日历套餐 → 返回 null（现状不变，不进结算收敛）。调用方（createOrder）仅在代理单 +
   * 无手工 settlementTotalCny 时调用，故此处不重复判身份。
   */
  private async resolveBundleSettlementCalendarTotal(
    body: Pick<CreateOrderBody, 'items'>,
    // 与 body.items 里 BUNDLE 行同序一一对应的加项净额（升舱/单房差/婴儿价/儿童折扣/自备签减免/
    // 指定酒店加价，未打折；来自 priceAndValidateItems 的 settlementAddOnCny）。
    // 日历价是「基础随机套餐」的每人同业价，加项按报价口径叠加其上——此前日历价裸收敛会把
    // 加项全部吞掉（代理日历单升舱等于白升），据此修正。
    bundleAddOnNetsCny: number[] = [],
  ): Promise<{ totalCny: number; audit: Record<string, unknown> } | null> {
    const bundleItems = body.items.filter(
      (it): it is Extract<OrderItemInput, { kind: 'BUNDLE' }> =>
        it.kind === 'BUNDLE' && !!it.bundleId,
    );
    if (bundleItems.length === 0) return null;

    const bundleIds = [...new Set(bundleItems.map((it) => it.bundleId))];
    const bundles = await prisma.bundle.findMany({
      where: { id: { in: bundleIds } },
      select: { id: true, name: true, settlementTier: true, settlementNights: true },
    });
    const bundleById = new Map(bundles.map((b) => [b.id, b]));

    // 只处理「档次 + 晚数都配了」的套餐行；未配 → 现状不变（不进结算收敛）。
    const configured = bundleItems.filter((it) => {
      const b = bundleById.get(it.bundleId);
      return b?.settlementTier != null && b?.settlementNights != null;
    });
    if (configured.length === 0) return null;

    // 去程出发日期（最早 FLIGHT 航段的出发地本地日）。已配日历却无航段 → 无从取价，明确拒单。
    const departYmd = await this.resolveDepartureLocalDate(body);
    if (!departYmd) {
      throw new BadRequestError(
        '该套餐已配置结算价日历，但本单无机票航段，无法确定出发日期取价。请确认所选出发日期有可用班次后重试。',
      );
    }

    let totalCny = 0;
    const lines: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < bundleItems.length; idx++) {
      const it = bundleItems[idx];
      const b = bundleById.get(it.bundleId);
      // 未配日历键的套餐行不参与日历取价（现状不变）；带索引遍历保证加项净额与行一一对应。
      if (b?.settlementTier == null || b.settlementNights == null) continue;
      const tier = b.settlementTier as SettlementTier;
      const nights = b.settlementNights;
      // 乘客数：套餐占座模型 headCount（成人 + 占座儿童 + 婴儿），与录单其它按人口径同源。
      const pax = resolveBundleOccupancy({
        adultCount: it.adultCount,
        childCount: it.childCount,
        infantCount: it.infantCount,
        quantity: it.quantity,
        metadata: it.metadata,
      }).headCount;
      const rate = await getSettlementRate(tier, nights, departYmd);
      if (!rate) {
        throw new BadRequestError('该出发日期的结算价未维护，请联系运营');
      }
      // 加项净额叠加在日历价之上（可为负：儿童折扣/自备签减免按报价口径同样从同业价里减）。
      const addOnCny = round2(bundleAddOnNetsCny[idx] ?? 0);
      const lineTotalCny = round2(rate.pricePerPersonCny * pax + addOnCny);
      totalCny = round2(totalCny + lineTotalCny);
      lines.push({
        bundleId: b.id,
        bundleName: b.name,
        tier,
        nights,
        departDate: departYmd,
        pricePerPersonCny: rate.pricePerPersonCny,
        pax,
        addOnCny,
        lineTotalCny,
        // 人类可读留痕：「结算价日历自动取价：{档次}{晚数}晚 {日期} ¥X/人×N（加项 ±¥Y）」
        note: `结算价日历自动取价：${tier} ${nights}晚 ${departYmd} ¥${rate.pricePerPersonCny}/人×${pax}${
          addOnCny !== 0 ? `，加项 ${addOnCny > 0 ? '+' : '−'}¥${Math.abs(addOnCny)}` : ''
        }`,
      });
    }

    return {
      totalCny,
      audit: { source: 'SETTLEMENT_CALENDAR', departDate: departYmd, lines },
    };
  }

  /**
   * 机票结算价日历取价（A1/E2）：代理的**纯机票单**按每条航段「航班号 × 出发地本地日」
   * 在机票结算价日历取每人价，返回结算总价，喂给既有「结算总价 → SETTLEMENT 差额行」机制落价。
   *
   * 口径（与套餐版对齐，但更保守——不拒单，只在把握十足时才接管）：
   *   · 结算总价 = Σ(每条 FLIGHT 行：每人价 × 该行人数 quantity)。往返 = 去/回两行各查各的价。
   *   · 出发日期 = **该航段自己**班次的出发地本地日（localDate），不是整单去程日——
   *     回程航班在报价表里是独立一列、按回程当天的价，用去程日会取错格。
   *   · **全命中才参与**：任一航段查不到班次/航班号/当日无价 → 直接返回 null 放弃自动取价，
   *     走现状（动态定价），绝不做半单收敛。宁可不取，也别把只算了一条腿的价当整单结算价。
   *   · 含 BUNDLE 行的单一律不参与：套餐单的机票航段是套餐的一部分，用机票价收敛整单会把
   *     地面部分白送。套餐走上面的地面结算价日历，两张表各管各的。
   *   · **含非经济舱航段的单一律不参与**：机票结算价日历的键是「航班号 × 出发日」，没有舱位这一维
   *     （见 FlightSettlementRate）。商务舱/头等/超经的行拿这张表取价，取到的是**经济舱**同业价，
   *     再被 SETTLEMENT 差额行把整单砸到经济舱价 —— 一单少收整个舱位差。宁可不取：整单返回 null
   *     （附 skippedReason），走人工结算价通道（手填结算总价 / 团队议价）。
   *     日历加舱位维度是独立的 schema 迁移议题，不在此处顺手改。
   * 调用方（createOrder）仅在「代理单 + 无手工结算价 + 套餐日历未接管」时调用，故此处不重复判身份。
   *
   * 返回 `{ totalCny: null, skippedReason }` = 明确放弃取价并带上人类可读原因（quote 用它显示
   * 「为什么没有自动价」）；返回 `null` = 本单压根不适用这张表（非纯机票单等），静默走现状。
   */
  private async resolveFlightSettlementCalendarTotal(
    body: Pick<CreateOrderBody, 'items'>,
  ): Promise<
    | { totalCny: number; audit: Record<string, unknown> }
    | { totalCny: null; skippedReason: string }
    | null
  > {
    // 含套餐行 → 不是纯机票单，交回套餐日历/现状处理。
    if (body.items.some((it) => it.kind === 'BUNDLE')) return null;

    const flightItems = body.items.filter(
      (it): it is Extract<OrderItemInput, { kind: 'FLIGHT' }> => it.kind === 'FLIGHT',
    );
    if (flightItems.length === 0) return null;

    // 非经济舱航段（含超经/商务/头等）→ 整单放弃自动取价。缺省视为经济舱：schema 里 FLIGHT 行的
    // flightCabin 必填，null/undefined 只可能来自历史/内部构造，按最保守的既有口径（经济舱）处理。
    const nonEconomyCabins = [
      ...new Set(
        flightItems
          .map((it) => it.flightCabin)
          .filter((cabin): cabin is CabinClass => cabin != null && cabin !== CabinClass.ECONOMY),
      ),
    ];
    if (nonEconomyCabins.length > 0) {
      return {
        totalCny: null,
        skippedReason: `本单含非经济舱航段（${nonEconomyCabins
          .map((cabin) => CABIN_ZH_LABEL[cabin] ?? cabin)
          .join('、')}），机票结算价日历不分舱位、按此取价会按经济舱价收敛整单。` +
          '本单同业价请人工设置（手填结算总价 / 团队议价）。',
      };
    }

    const scheduleIds = [...new Set(flightItems.map((it) => it.flightScheduleId))];
    const scheds = await prisma.flightSchedule.findMany({
      where: { id: { in: scheduleIds } },
      select: {
        id: true,
        departureTime: true,
        departureTz: true,
        flight: { select: { flightNumber: true } },
      },
    });
    const schedById = new Map(scheds.map((s) => [s.id, s]));

    let totalCny = 0;
    const lines: Array<Record<string, unknown>> = [];
    for (const it of flightItems) {
      const sched = schedById.get(it.flightScheduleId);
      // 班次查不到（理论上定价环节已校验过）→ 放弃自动取价，不猜。
      if (!sched) return null;
      const flightNumber = sched.flight.flightNumber;
      const departYmd = localDate(sched.departureTime, sched.departureTz);
      const rate = await getFlightSettlementRate(flightNumber, departYmd);
      // 该航班当日未维护结算价 → 整单放弃自动取价（不做半单收敛）。
      if (!rate) return null;
      const pax = it.quantity;
      const lineTotalCny = rate.pricePerPersonCny * pax;
      totalCny += lineTotalCny;
      lines.push({
        flightScheduleId: it.flightScheduleId,
        flightNumber,
        cabin: it.flightCabin,
        departDate: departYmd,
        pricePerPersonCny: rate.pricePerPersonCny,
        pax,
        lineTotalCny,
        // 人类可读留痕：「机票结算价日历自动取价：QH9589 2026-08-10 ¥1000/人×2」
        note: `机票结算价日历自动取价：${flightNumber} ${departYmd} ¥${rate.pricePerPersonCny}/人×${pax}`,
      });
    }

    return {
      totalCny,
      audit: { source: 'FLIGHT_SETTLEMENT_CALENDAR', lines },
    };
  }

  /**
   * 去程出发地本地日（YYYY-MM-DD）：取本单所有 FLIGHT 航段里最早 departureTime 的班次，
   * 按其出发地时区折成本地日（localDate，与航班/班次日期展示口径一致）。无 FLIGHT 航段 → null。
   */
  private async resolveDepartureLocalDate(body: Pick<CreateOrderBody, 'items'>): Promise<string | null> {
    const scheduleIds = [
      ...new Set(
        body.items
          .filter((i): i is Extract<OrderItemInput, { kind: 'FLIGHT' }> => i.kind === 'FLIGHT')
          .map((i) => i.flightScheduleId),
      ),
    ];
    if (scheduleIds.length === 0) return null;
    const scheds = await prisma.flightSchedule.findMany({
      where: { id: { in: scheduleIds } },
      select: { departureTime: true, departureTz: true },
    });
    if (scheds.length === 0) return null;
    const earliest = scheds.reduce(
      (min, s) => (s.departureTime < min.departureTime ? s : min),
      scheds[0],
    );
    return localDate(earliest.departureTime, earliest.departureTz);
  }

  /**
   * 同 bundleId 的真实 FLIGHT 航段 → 该套餐的**权威**去程出发本地日（bundleId → YYYY-MM-DD）。
   *
   * 为什么必须以航段为准（A7 套利口径修正）：
   * 订单行 metadata.goDate 是**客户端可控**的自由字段，此前只做 /^\d{4}-\d{2}-\d{2}$/ 正则校验，
   * 从不与真实航段核对，却同时是三件事的取价/盖章依据：结算价日历取价、散客立减规则命中、
   * 房控占房盖章。于是散客只要把 goDate 改到一个有立减/低价的日期、并同步下调 expectedTotalCny，
   * 前后端同源校验就一路通过 —— 白拿立减，且占房被盖到伪造日期上（房控账实分叉）。
   *
   * 修正：有同 bundle 航段时一律以「最早出发航段的出发地本地日」为权威日期，goDate 只当展示提示。
   * 航段是服务端按 flightScheduleId 查库得到的，客户端改不了。
   * 纯地面套餐（本单没有同 bundle 的 FLIGHT 行）没有航段可依，仍回落 goDate —— 见调用处说明。
   */
  private async resolveAuthoritativeBundleGoDates(
    items: ReadonlyArray<OrderItemInput>,
  ): Promise<Map<string, string>> {
    const scheduleIdsByBundle = new Map<string, Set<string>>();
    for (const item of items) {
      if (item.kind !== 'FLIGHT' || !item.bundleId || !item.flightScheduleId) continue;
      const set = scheduleIdsByBundle.get(item.bundleId) ?? new Set<string>();
      set.add(item.flightScheduleId);
      scheduleIdsByBundle.set(item.bundleId, set);
    }
    if (scheduleIdsByBundle.size === 0) return new Map();

    const allScheduleIds = [
      ...new Set([...scheduleIdsByBundle.values()].flatMap((set) => [...set])),
    ];
    const schedules = await prisma.flightSchedule.findMany({
      where: { id: { in: allScheduleIds } },
      select: { id: true, departureTime: true, departureTz: true },
    });
    const scheduleById = new Map(schedules.map((s) => [s.id, s]));

    const result = new Map<string, string>();
    for (const [bundleId, ids] of scheduleIdsByBundle) {
      const rows = [...ids]
        .map((sid) => scheduleById.get(sid))
        .filter((s): s is (typeof schedules)[number] => s != null);
      if (rows.length === 0) continue;
      const earliest = rows.reduce(
        (min, s) => (s.departureTime < min.departureTime ? s : min),
        rows[0],
      );
      result.set(bundleId, localDate(earliest.departureTime, earliest.departureTz));
    }
    return result;
  }

  /**
   * 解析单个 BUNDLE 行自己的去程出发本地日（供结算价日历 / 立减规则取价）。
   *
   * 口径（A7 修正后）：
   *   1. 同 bundleId 的真实 FLIGHT 航段（最早出发）本地日 —— 权威，客户端改不了；
   *   2. 本单没有同 bundle 航段（纯地面套餐）时才回落该行的 goDate。
   * 绝不扫描整单的其它航段，避免多套餐 / 散票串日期。
   *
   * 修正前是反的（goDate 优先），导致 goDate 这个客户端自由字段直接决定结算价与立减命中。
   */
  private async resolveBundleItemDepartureLocalDate(
    body: Pick<CreateOrderBody, 'items'>,
    bundleItem: Extract<OrderItemInput, { kind: 'BUNDLE' }>,
  ): Promise<string | null> {
    const authoritative = (await this.resolveAuthoritativeBundleGoDates(body.items)).get(
      bundleItem.bundleId,
    );
    if (authoritative) return authoritative;

    // 纯地面套餐：无航段可依，只能用行内 goDate（仍做格式校验）。
    // 这条路径没有机票，本身也不进机票结算价日历；地面套餐的日期套利面远小于机票+立减。
    const goDate = bundleItem.metadata?.goDate;
    if (typeof goDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(goDate)) {
      return goDate;
    }
    return null;
  }

  /**
   * 重复乘客校验：同一航班班次的「占座中」订单（SEAT_HOLDING_STATUSES）里，
   * 同证件号乘客不允许再次下单 —— 已取消/已退款/超时的订单不算占座，可重订。
   *
   *   - allowDuplicate=false（默认；前台散客 / 未授权）：命中即抛 DuplicatePassengerError
   *     （code=DUPLICATE_PASSENGER，details.conflicts 带证件号 + 冲突订单号），拒绝下单。
   *   - allowDuplicate=true（仅 ADMIN/STAFF 后台录入，权限已在 createOrder 入口按身份收口）：
   *     命中不拦，返回冲突明细，由调用方写审计 + 订单备注留痕（客人重复订票且已付款场景）。
   *
   * 无冲突恒返回 []（含无 FLIGHT 班次 / 无乘客的快速返回）。
   */
  private async assertNoDuplicatePassengersOnFlights(
    flightScheduleIds: string[],
    documentNumbers: string[],
    allowDuplicate = false,
  ): Promise<Array<{ documentNumber: string; orderNumbers: string[] }>> {
    if (flightScheduleIds.length === 0 || documentNumbers.length === 0) return [];

    const conflicts = await prisma.passenger.findMany({
      where: {
        documentNumber: { in: [...new Set(documentNumbers)] },
        order: {
          status: { in: SEAT_HOLDING_STATUSES },
          items: { some: { flightScheduleId: { in: flightScheduleIds } } },
        },
      },
      select: {
        documentNumber: true,
        order: { select: { orderNumber: true } },
      },
    });
    if (conflicts.length === 0) return [];

    const orderNumbersByDoc = new Map<string, Set<string>>();
    for (const c of conflicts) {
      const orderNumbers = orderNumbersByDoc.get(c.documentNumber) ?? new Set<string>();
      orderNumbers.add(c.order.orderNumber);
      orderNumbersByDoc.set(c.documentNumber, orderNumbers);
    }
    const conflictList = [...orderNumbersByDoc.entries()].map(([documentNumber, orderNumbers]) => ({
      documentNumber,
      orderNumbers: [...orderNumbers],
    }));

    // 授权强录 → 不拦，把明细交回调用方做审计 + 备注。
    if (allowDuplicate) return conflictList;

    const detail = conflictList
      .map(({ documentNumber, orderNumbers }) => `${documentNumber}（订单 ${orderNumbers.join('、')}）`)
      .join('；');
    throw new DuplicatePassengerError(
      `以下乘客证件号已在同航班的有效订单中，不能重复下单：${detail}`,
      { conflicts: conflictList },
    );
  }

  /**
   * @param flightSettlementPriceCny 团队议价结算价（CNY/人）。设置时覆盖 FLIGHT 行的
   *   动态价：unitPrice = 结算价，amount = 结算价 × quantity。仅改价格，绝不动
   *   quantity / flightScheduleId / flightCabin —— 扣座（CAS）仍按 quantity 执行。
   *   缺省 → 走动态定价（旧行为）。
   * @param passengers 套餐乘客级住宿/签证选项（visaExempt / singleRoom 两维派生套餐定价）
   *   + gender（只用于酒店物理房间前瞻闸的拼房配对判定，不参与定价）。
   *   优先级（BUNDLE 分支，两维各自独立判定）：任一乘客显式提供了对应布尔字段时，以乘客级勾选
   *   人数为权威；否则回落 item 级旧聚合口径（bundleItem.selfProvidedVisa 布尔 / singleCount）。
   *   缺省（老客户端不传 passengers）→ 全部回落旧口径，定价与扩展前完全一致；性别缺省按
   *   保守口径 'U'（未知 → 独占一间），与房控 pickSoloGender 一致。
   */
  private async priceAndValidateItems(
    items: OrderItemInput[],
    flightSettlementPriceCny?: number,
    passengers?: ReadonlyArray<{
      visaExempt?: boolean;
      singleRoom?: boolean;
      gender?: 'M' | 'F' | 'X';
    }>,
    // 是否允许「无产品 id 的地面行按前端传入价格成交」。仅后台/代理录单（自由行手录）为 true；
    // 对外角色（游客 / CUSTOMER）为 false —— 否则公开 POST /orders 可提交 1 元酒店行，
    // 且 expectedTotalCny 兜底以这个被信任的价为基准，形同虚设。
    allowClientPricedGround = false,
    // 指定酒店星级闸的上下文（缺省 = 不判，供纯试算/内部预算路径使用）：
    //   传了才启用「套餐档次 ↔ 指定酒店星级」校验，AGENT/CUSTOMER/游客不匹配即拒单，
    //   ADMIN/STAFF 须带非空放行原因，放行明细推进 overrides 供调用方写审计。
    starGate?: DesignatedHotelStarGate,
    // 酒店限额内超售豁免（间）：仅内部 ADMIN/STAFF 录单/试算传入（销控售罄后仍可录单，
    // 当天临时向酒店加房是常态业务）。缺省 = 硬闸——前台散客/代理必须缺省。
    // 这里只影响**事务外友好预检**；权威判定与 WARNING 审计在建单事务内（createOrder）。
    hotelOversellCapRooms?: number,
  ) {
    const priced: PricedOrderItem[] = [];

    // 套餐去程出发日的权威来源（A7）：同 bundle 的真实 FLIGHT 航段，客户端改不了。
    // 房控占房盖章（下方 resolveBundleHotelStamp）此前直接吃客户端自由字段 metadata.goDate，
    // 伪造的日期会把占房盖到错误的夜晚上（房控账实分叉）。有航段时一律用航段日覆盖。
    // 纯地面套餐（无同 bundle 航段）→ map 里没有该 bundleId，保持原 goDate 现状不变。
    const authoritativeBundleGoDates = await this.resolveAuthoritativeBundleGoDates(items);

    // 本单所有 BUNDLE 行选「升舱商务」的总人数（多份套餐叠加），去程 / 回程各自一份 ——
    // 同一批客人可以只升去程、或去回程升的人数不同。循环结束后按航段落到对应 FLIGHT 行：
    // 第一条经济舱航段 = 去程，其余（回程）取回程人数；每段各占用自己那一份真实商务舱座位。
    let bundleBusinessUpgradeOutbound = 0;
    let bundleBusinessUpgradeReturn = 0;
    // 本单是否有 BUNDLE 行显式用了分程口径（决定下方「回程升舱却没有回程航段」是否硬拒）。
    let hasSplitBusinessUpgradeInput = false;

    // 套餐折扣（bundleId → discountPct 0..100）：循环里从 DB 读，循环后对该套餐的
    // BUNDLE 行 + 关联 FLIGHT 腿逐行 ×(1−pct/100)，使「整个全包价打折」且各行金额诚实
    // （航班行=折后机票收入，财务航班毛利不假高）。pct 只从 DB 取，不信前端。
    const bundleDiscountPct = new Map<string, number>();

    // ── 团队议价结算价的航段分摊（A9 每人翻倍收口）────────────────────────
    // settlementPriceCny 的语义（UI 文案与 schema 注释均如此）是「每位出行人**整程**价」，
    // 但此前是逐 FLIGHT 行各写满价：往返单有两条航段行 → 每人被收两遍。
    //   算例：填 3600、往返、2 人 → 每单 total 7200、两单实收 14400，运营意图是 7200。
    //   （留空走结算价日历反而正确，因为日历是「去程价 + 回程价求和 = 每人整程价」。）
    // 修法：把整程价按航段分摊，各段之和恰好等于整程价 —— 与日历口径一致。
    // 保留逐行覆盖机制（而非改走 SETTLEMENT 差额行）：metadata.priceOverride='TEAM_SETTLEMENT'
    // 是后台「价格来源」列与审计的既有依据，议价价也不该依赖动态定价成功与调价上限。
    const flightLegShares =
      flightSettlementPriceCny === undefined
        ? []
        : splitSettlementPriceAcrossLegs(
            flightSettlementPriceCny,
            items.filter((it) => it.kind === 'FLIGHT').length,
          );
    let flightLegIndex = 0;

    for (const item of items) {
      if (item.kind === 'FLIGHT') {
        // 团队议价结算价：整批以谈定的每人结算价覆盖动态/目录机票价。
        // 仅改价格，扣座 quantity / 班次 / 舱位完全不变（CAS 仍按 quantity 执行）。
        if (flightSettlementPriceCny !== undefined) {
          // 本航段分摊到的每人价（各段之和 = 每人整程议价，见 flightLegShares 处注释）
          const legShareCny = flightLegShares[flightLegIndex] ?? flightSettlementPriceCny;
          const legIndex = flightLegIndex;
          flightLegIndex += 1;
          priced.push({
            kind: 'FLIGHT',
            description: item.description,
            quantity: item.quantity,
            unitPrice: legShareCny,
            amount: round2(legShareCny * item.quantity),
            flightScheduleId: item.flightScheduleId,
            flightCabin: item.flightCabin,
            bundleId: item.bundleId,
            metadata: {
              ...sanitizeFlightItemMetadata(item.metadata),
              // 审计：标记本行价格来自团队议价结算价（非动态价）
              priceOverride: 'TEAM_SETTLEMENT',
              // 谈定的**每人整程**议价（不随航段拆分变化，供后台/导出显示原始口径）
              settlementPriceCny: flightSettlementPriceCny,
              // 本行分摊：第几段 / 共几段 / 本段每人价（金额可追溯，避免"钱从哪来"说不清）
              settlementLegIndex: legIndex,
              settlementLegCount: flightLegShares.length,
              settlementLegShareCny: legShareCny,
            },
          });
          continue;
        }
        // 动态定价重算 — 这是唯一权威价格源（无议价结算价时）
        const pricing = await this.pricing.calculatePrice(
          item.flightScheduleId,
          item.flightCabin,
          item.quantity,
        );
        priced.push({
          kind: 'FLIGHT',
          description: item.description,
          quantity: item.quantity,
          unitPrice: pricing.averageUnitPrice,
          amount: pricing.totalPrice,
          flightScheduleId: item.flightScheduleId,
          flightCabin: item.flightCabin,
          bundleId: item.bundleId,
          metadata: {
            ...sanitizeFlightItemMetadata(item.metadata),
            dateRank: pricing.dateRank,
            dateMultiplier: pricing.dateMultiplier,
            perSeatBreakdown: pricing.perSeatBreakdown,
          },
        });
      } else if (item.kind === 'HOTEL') {
        // 服务端权威定价：有 hotelRoomTypeId 就从 DB 查，不信任前端 unitPrice
        let unitPrice = item.unitPrice;
        // 计费房间数（支持 0.5 间）：录单方显式传 roomsBilled 时按其缩放，缺省 1（与旧版一致）。
        // 单独 HOTEL 行无套餐占座模型，故不走 computeRoomsNeeded（那是套餐容量口径）。
        const rooms = item.roomsBilled ?? 1;
        // 成本快照（每间每晚）：仅有产品 id 时可从 DB 取；无 id 的自由行手录成本未知 → 留空。
        let hotelUnitCost: number | undefined;
        // ── 星级随机档行（三星随机 / 四星随机）：不指定酒店，占同星级酒店的合计余量 ──
        // 校验放这里而不是 zod：orderItemInputSchema 是 discriminatedUnion，不接受 ZodEffects。
        if (item.randomStarTier != null) {
          if (item.hotelRoomTypeId) {
            throw new BadRequestError('酒店行不能同时指定具体房型和星级随机档');
          }
          if (!item.checkIn || !item.checkOut) {
            throw new BadRequestError('星级随机档房行必须填写入住/退房日期（余量按晚扣减）');
          }
          // 随机档行没有房型可查价 —— 走与「无产品 id 的地面行」完全相同的权威口径：
          // 仅后台/代理录单可手录售价，对外角色一律拒（否则公开下单能提交 1 元随机档房行）。
          if (!allowClientPricedGround) {
            throw new BadRequestError('星级随机档房行仅支持后台/代理录单');
          }
          // 成本快照（每间每晚）：服务端从 DB 取同星级酒店当晚的切房单价，不信前端。
          hotelUnitCost = await resolveRandomTierNightlyCost(item.randomStarTier, item.checkIn);
          // 可售判定（**事务外友好预检**）：同星级酒店合计余量够不够本次这几间。
          // 它能在长事务开始前拒掉明显售罄的单，也服务于 quote 试算；但只读、无锁，
          // 并发抢最后一间时两笔会双双通过 —— 权威判定在建单事务内的
          // assertRandomTierStaysFitWithinTx（带 FOR UPDATE 行锁）。
          // 该档次整段无任何同星级包房周期 → 视为未管控，不拦截（房控哲学：未配包房 ≠ 售罄）。
          const stayNights = buildStayNightDates(new Date(item.checkIn), new Date(item.checkOut));
          if (stayNights.length > 0) {
            // 这条分支必为后台录单（上面已按 allowClientPricedGround 拒掉对外角色）→ 直接吃豁免。
            await assertRandomTierFit(item.randomStarTier, stayNights, rooms, {
              maxOversellRooms: hotelOversellCapRooms,
            });
          }
        }
        if (item.hotelRoomTypeId) {
          const rt = await prisma.hotelRoomType.findUnique({
            where: { id: item.hotelRoomTypeId },
            select: { basePrice: true, costPriceCny: true, hotel: { select: { isActive: true } } },
          });
          if (!rt) throw new NotFoundError(`酒店房型 ${item.hotelRoomTypeId} 不存在`);
          if (!rt.hotel.isActive) throw new BadRequestError('酒店已下架');
          unitPrice = Number(rt.basePrice);
          // 成本快照（每间每晚）：产品未录成本 → undefined → 毛利「未知」，不落 0 虚高。
          hotelUnitCost = rt.costPriceCny != null ? Number(rt.costPriceCny) : undefined;
          // A3：拒绝偏离服务端权威价超容差的提交（仅有产品 id 时校验，无 id 走信任旧路径）。
          // 0.5 间：金额随 roomsBilled 缩放，容差按同一房间数口径比较，避免误判价格变动。
          assertAmountWithinTolerance('酒店', item.unitPrice, unitPrice, item.quantity * rooms);
        } else if (!allowClientPricedGround) {
          // 无产品 id = 按前端传入价成交。仅后台/代理手录自由行允许；对外角色一律拒。
          throw new BadRequestError('酒店行必须选择系统内的酒店房型，不能自定义价格');
        }
        priced.push({
          kind: 'HOTEL',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          // 单独 HOTEL 行：unitPrice×qty×rooms（rooms 缺省 1 → 与旧版一致）。
          amount: Math.round(unitPrice * item.quantity * rooms),
          hotelRoomTypeId: item.hotelRoomTypeId,
          randomStarTier: item.randomStarTier,
          hotelCheckIn: item.checkIn ? new Date(item.checkIn) : undefined,
          hotelCheckOut: item.checkOut ? new Date(item.checkOut) : undefined,
          roomsBilled: rooms,
          unitCostCny: hotelUnitCost,
          // 总成本与 amount 同口径缩放（×qty×rooms），保证毛利 = amount − totalCostCny 诚实。
          totalCostCny:
            hotelUnitCost != null ? Math.round(hotelUnitCost * item.quantity * rooms) : undefined,
          metadata: item.metadata,
        });
      } else if (item.kind === 'TRANSFER') {
        let unitPrice = item.unitPrice;
        let transferUnitCost: number | undefined;
        if (item.transferId) {
          const t = await prisma.transfer.findUnique({
            where: { id: item.transferId },
            select: { basePrice: true, costPriceCny: true, isActive: true },
          });
          if (!t) throw new NotFoundError(`接送产品 ${item.transferId} 不存在`);
          if (!t.isActive) throw new BadRequestError('接送产品已下架');
          unitPrice = Number(t.basePrice);
          transferUnitCost = t.costPriceCny != null ? Number(t.costPriceCny) : undefined;
          assertAmountWithinTolerance('接送', item.unitPrice, unitPrice, item.quantity);
        } else if (!allowClientPricedGround) {
          throw new BadRequestError('接送行必须选择系统内的接送产品，不能自定义价格');
        }
        priced.push({
          kind: 'TRANSFER',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          amount: Math.round(unitPrice * item.quantity),
          transferId: item.transferId,
          unitCostCny: transferUnitCost,
          totalCostCny:
            transferUnitCost != null ? Math.round(transferUnitCost * item.quantity) : undefined,
          metadata: item.metadata,
        });
      } else if (item.kind === 'VISA') {
        let unitPrice = item.unitPrice;
        let visaUnitCost: number | undefined;
        // 命中的加急档（快照进订单行 metadata，供审计/明细展示；未选档 → undefined）。
        let visaExpressTier: VisaExpressTier | undefined;
        if (item.visaId) {
          const v = await prisma.visa.findUnique({
            where: { id: item.visaId },
            select: {
              basePrice: true,
              expressSurcharge: true,
              expressTiers: true,
              costPriceCny: true,
              isActive: true,
            },
          });
          if (!v) throw new NotFoundError(`签证产品 ${item.visaId} 不存在`);
          if (!v.isActive) throw new BadRequestError('签证产品已下架');
          const baseUnitPrice = Number(v.basePrice);
          // 加急分档优先（运营在产品上自配零工/一工/二工…）：客户端只传档名，金额一律服务端查表。
          // 档名对不上（产品改了档位表 / 伪造档名）→ 显式拒单，绝不静默按不加急成交。
          const requestedTierLabel = resolveRequestedExpressTierLabel(item.metadata);
          if (requestedTierLabel) {
            const tiers = parseVisaExpressTiers(v.expressTiers);
            visaExpressTier = tiers.find((t) => t.label === requestedTierLabel);
            if (!visaExpressTier) {
              throw new BadRequestError(
                `该签证产品没有「${requestedTierLabel}」加急档（档位可能已被调整），请重新选择加急档位`,
              );
            }
            unitPrice = baseUnitPrice + visaExpressTier.surchargeCny;
          } else {
            // 未选分档 → 旧的单值加急口径（未配分档的产品仍按 expressSurcharge 走），行为不变。
            const express = Boolean(item.metadata?.express);
            unitPrice = express && v.expressSurcharge
              ? baseUnitPrice + Number(v.expressSurcharge)
              : baseUnitPrice;
          }
          // 成本快照 = 送签成本（costPriceCny），不含加急费：加急是纯毛利（卖的是速度，
          // 送签成本不变），系统尚无独立加急成本字段。加急成本口径待后续单独接入。
          visaUnitCost = v.costPriceCny != null ? Number(v.costPriceCny) : undefined;
          assertAmountWithinTolerance('签证', item.unitPrice, unitPrice, item.quantity);
        } else if (!allowClientPricedGround) {
          throw new BadRequestError('签证行必须选择系统内的签证产品，不能自定义价格');
        }
        priced.push({
          kind: 'VISA',
          description: item.description,
          quantity: item.quantity,
          unitPrice,
          amount: Math.round(unitPrice * item.quantity),
          visaId: item.visaId,
          // 预计出行日期（可空）：纯签证单的出发日锚点。与 hotelCheckIn 同款解析——
          // 'YYYY-MM-DD' → UTC 零点，落 @db.Date 列不会被时区推前/推后一天。
          visaIntendedDate: item.visaIntendedDate ? new Date(item.visaIntendedDate) : undefined,
          unitCostCny: visaUnitCost,
          totalCostCny:
            visaUnitCost != null ? Math.round(visaUnitCost * item.quantity) : undefined,
          // 加急档快照（档名 + 工作日 + 服务端权威加价）：运营改档位表后，历史订单仍解释得清这笔钱。
          // 未选档 → 原样透传 item.metadata（含 undefined），落库形态与扩展前一致。
          metadata: visaExpressTier
            ? { ...(item.metadata ?? {}), expressTier: visaExpressTier }
            : item.metadata,
        });
      } else if (item.kind === 'BUNDLE') {
        // BUNDLE：服务端重算套餐价（items 从 DB 取 + groundDiscount）
        const bundle = await prisma.bundle.findUnique({
          where: { id: item.bundleId },
          select: {
            name: true,
            // 结算档次：指定酒店星级闸的比对基准（唯一权威映射见 SETTLEMENT_TIER_STAR_RATING）。
            settlementTier: true,
            items: true,
            groundDiscount: true,
            // 套餐折扣（%）：整个全包价(机票+地面+加项) × (1 − discountPct/100)；下方逐行打折
            discountPct: true,
            isActive: true,
            hotelRoomTypeId: true,
            hotelNights: true,
            // 可选升级加价费率（server-priced，按产品可配置）+ 航段数
            singleSupplementCnyPerNight: true,
            // 升舱差价：null = 「跟随航班」→ 取绑定航班 Flight.businessUpgradeCnyPerLeg（下方解析）；
            //           非 null = 套餐自有覆盖（含 0）。
            businessUpgradeCnyPerLeg: true,
            outboundFlight: { select: { businessUpgradeCnyPerLeg: true } },
            returnFlight: { select: { businessUpgradeCnyPerLeg: true } },
            // 占座儿童折扣 / 婴儿价（server-priced，按产品可配置）
            childSeatDiscountCnyPerPerson: true,
            infantPriceCny: true,
            // 自备签证减免（出行人自行办妥签证时从套餐行扣减；server-priced）
            selfVisaDeductCny: true,
            // 每人操作费（server-priced，从 DB 读，不信客户端）：下单按占座人数收，计入套餐地面金额。
            operationFeeCny: true,
            legs: true,
            // 关联房型容量 → 算 roomsNeeded（自动加房，套餐酒店部分按房价 ×rooms 收费）
            // basePrice：套餐酒店行的权威每间每晚价（服务端重算，不信 items JSON 里的 unitPrice —
            //   历史上 items 里的 HOTEL.unitPrice 可能是占位/过时的畸低值，导致套餐酒店部分只算出几元）。
            // hotelId：出发日期房量库存校验（无房不让下单）。
            hotelRoomType: {
              select: {
                maxAdults: true,
                maxChildren: true,
                basePrice: true,
                hotelId: true,
                // randomTierPlaceholder：套餐绑的可能是「随机N星」的占位酒店房型（历史形态）——
                //   此时房量闸要走随机档聚合闸而不是具体酒店闸（见下方库存校验小节）。
                hotel: { select: { isActive: true, randomTierPlaceholder: true } },
              },
            },
          },
        });
        if (!bundle) throw new NotFoundError(`套餐 ${item.bundleId} 不存在`);
        if (!bundle.isActive) throw new BadRequestError('套餐已下架');
        // 套餐绑定的酒店房型若其酒店已下架 → 拒单（与单独 HOTEL 行同口径，防止经套餐绕过下架酒店）。
        if (bundle.hotelRoomType && !bundle.hotelRoomType.hotel.isActive) {
          throw new BadRequestError('酒店已下架');
        }
        // ── 座位账诚实收口：套餐含机票组件 → 本单必须带对应机票航段行 ────────────────
        // 套餐定义（bundle.items）里含 FLIGHT 组件时，本单却没有对应的机票航段（FLIGHT 行）→
        // 会落一张「无航段、不占座、出行日期无从派生」的套餐单：签证台/订单列表/详情/导出都推不出
        // 出发日期，且机位从未被占（座位账少了一笔）。机票航段本应由建单方（前台购物车 / 单笔录单 /
        // 批量创单）按出发日期匹配当日班次后随 items 一并提交；这里做最后一道防御性断言——匹配不到
        // 班次 / 建单方漏发航段时**明确拒单**，绝不静默落无航段套餐单。
        //   合法路径都会带机票航段：批量创单与前台购物车给航段打 bundleId 标；单笔录单发不带标的航段。
        //   故判定 = 本单存在 FLIGHT 行且（打了本套餐的标 或 未打任何套餐标）。
        //   航段真正扣座沿用既有 decrementSeat 链路（占/放对称），本断言不新增任何占座/放座逻辑。
        const bundleComponentList = Array.isArray(bundle.items)
          ? (bundle.items as Array<{ kind?: string }>)
          : [];
        const bundleHasFlightComponent = bundleComponentList.some((c) => c?.kind === 'FLIGHT');
        if (bundleHasFlightComponent) {
          const hasMatchingFlightLeg = items.some(
            (it) =>
              it.kind === 'FLIGHT' && (it.bundleId === item.bundleId || it.bundleId == null),
          );
          if (!hasMatchingFlightLeg) {
            throw new BadRequestError(
              '该套餐含机票，但本单未匹配到对应的机票航段，无法占座、也无从确定出发日期。' +
                '请确认该套餐所选出发日期有可用班次后重试（如反复出现，请检查套餐的航班绑定与当日排班）。',
            );
          }
        }
        // 记下该套餐折扣（%），循环后对本套餐的 BUNDLE 行 + 关联 FLIGHT 腿逐行打折。
        if (item.bundleId) bundleDiscountPct.set(item.bundleId, bundle.discountPct ?? 0);
        // 住宿晚数：单一权威口径（hotelNights ?? 首个 HOTEL 组件 qty ?? 默认）。
        // 一次解析，喂给酒店盖章 + 升级 add-on，保证回程日期 / 单人入住房差 / HOTEL 地面价口径一致。
        const nights = resolveBundleNights(bundle.items, bundle.hotelNights);
        // 占座模型归一化（成人 / 占座儿童 / 不占座婴儿；向后兼容旧 pax → 全成人）。
        // 先算占座，再据房型容量推 roomsNeeded（酒店地面部分按房间数缩放）。
        const occupancy = resolveBundleOccupancy({
          adultCount: item.adultCount,
          childCount: item.childCount,
          infantCount: item.infantCount,
          quantity: item.quantity,
          metadata: item.metadata,
        });

        // ── 指定酒店（0805 反馈）：套餐按「星级随机」报价，客人点名要住某家酒店 ──
        // 传了 designatedHotelRoomTypeId（且不同于套餐绑定房型）→ 占房/盖章/容量切到指定房型，
        // 并按该酒店配置的「指定酒店加价 ¥/人」× 占座人数加收（server-priced，不信客户端金额）。
        // 地面价不换成指定房型价——业务口径是「随机报价基础上加收指定差价」，套餐地面价保持不变。
        let designatedRoomType: {
          id: string;
          hotelId: string;
          maxAdults: number;
          maxChildren: number;
          hotelName: string;
          designationSurchargeCnyPerPerson: number;
          /** 非空 = 指到了随机档占位酒店（不是真房源）→ 房量闸走随机档聚合闸。*/
          randomTierPlaceholder: number | null;
          /** 星级闸比对用（占位酒店不参与本闸）。*/
          starRating: number | null;
          intlFiveStar: boolean;
        } | null = null;
        if (
          item.designatedHotelRoomTypeId &&
          item.designatedHotelRoomTypeId !== bundle.hotelRoomTypeId
        ) {
          const rt = await prisma.hotelRoomType.findUnique({
            where: { id: item.designatedHotelRoomTypeId },
            select: {
              id: true,
              hotelId: true,
              maxAdults: true,
              maxChildren: true,
              hotel: {
                select: {
                  name: true,
                  isActive: true,
                  designationSurchargeCnyPerPerson: true,
                  randomTierPlaceholder: true,
                  starRating: true,
                  intlFiveStar: true,
                },
              },
            },
          });
          if (!rt) throw new NotFoundError(`酒店房型 ${item.designatedHotelRoomTypeId} 不存在`);
          if (!rt.hotel.isActive) throw new BadRequestError('指定的酒店已下架');
          designatedRoomType = {
            id: rt.id,
            hotelId: rt.hotelId,
            maxAdults: rt.maxAdults,
            maxChildren: rt.maxChildren,
            hotelName: rt.hotel.name,
            designationSurchargeCnyPerPerson: rt.hotel.designationSurchargeCnyPerPerson,
            randomTierPlaceholder: rt.hotel.randomTierPlaceholder,
            starRating: rt.hotel.starRating ?? null,
            intlFiveStar: rt.hotel.intlFiveStar === true,
          };
        }

        // ── 星级不匹配闸（block-with-override）────────────────────────────────
        // 此前只校验「房型存在 + 酒店在架」，价格却全程按 bundle.settlementTier 收 ——
        // 「四星档的钱住三星店」系统完全不知情。现在把两套口径对上：
        //   · AGENT / CUSTOMER / 游客 → 直接拒单（对外身份没有越权定价的口子）；
        //   · ADMIN / STAFF → 必须带非空放行原因才过，放行写 WARNING 审计（谁放的、为什么放）。
        // 不适用的两种情形（无基准可比，不是「放行」而是「本就不该判」）：
        //   · 套餐没配 settlementTier（不走结算价日历的老套餐）；
        //   · 指到的是随机档**占位酒店**（不是真房源，业务上等同未落位随机单）。
        if (
          starGate &&
          designatedRoomType &&
          designatedRoomType.randomTierPlaceholder == null &&
          bundle.settlementTier != null &&
          isSettlementTierStarMismatch(bundle.settlementTier, designatedRoomType)
        ) {
          const tier = bundle.settlementTier;
          const isOperator =
            starGate.role === UserRole.ADMIN || starGate.role === UserRole.STAFF;
          const reason = item.designatedHotelStarMismatchReason?.trim();
          if (!isOperator) {
            throw new BadRequestError(buildStarMismatchMessage(tier, designatedRoomType));
          }
          if (!reason) {
            throw new BadRequestError(
              `${buildStarMismatchMessage(tier, designatedRoomType)}。` +
                '如确需按此酒店成交，请填写放行原因（将留档备查）。',
            );
          }
          starGate.overrides.push({
            bundleId: item.bundleId,
            bundleName: bundle.name ?? null,
            bundleTier: tier,
            bundleTierStar: SETTLEMENT_TIER_STAR_RATING[tier],
            hotelRoomTypeId: designatedRoomType.id,
            hotelId: designatedRoomType.hotelId,
            hotelName: designatedRoomType.hotelName,
            hotelStarRating: designatedRoomType.starRating,
            hotelIntlFiveStar: designatedRoomType.intlFiveStar,
            reason,
          });
        }

        // ── 乘客级「住宿方式 + 签证」派生（0713 反馈批：购物车模式，每人各选自己的码）──
        // 单一权威口径由 derivePerPaxBundleOptions 提供（纯函数，单测共用，避免漂移）：
        //   任一乘客显式提供对应布尔 → 以乘客级勾选人数为权威；否则回落 item 级旧聚合口径。
        const { selfProvidedVisaCount, singleCount: derivedSingleCount } =
          derivePerPaxBundleOptions(item, passengers);

        // 计费房间数（server-authoritative，钱路径权威计算）：
        //   · 容量口径 physicalRooms = computeRoomsNeeded（选的人数一间坐不下自动加房）：
        //       max( ceil(成人/maxAdults), ceil(占座儿童/maxChildren), 1 )；缺房型回退默认 2大1小。
        //   · 单人拼房 0.5 间：绑了套餐房型 且 1 成人 0 儿童（婴儿不占房）且非独住（singleCount=0）
        //       → 只按 0.5 间收（床位口径）；独住（singleCount≥1）照旧整间 + 单人入住房差。
        //   · 客户端 roomsBilled 只能上调不能下压（max(client, roomsCharged)）——防止把多人单伪造成 0.5 间。
        // 单一权威口径由 computeBundleRoomsCharged 提供（单测与本分支共用，避免漂移）。
        const rooms = computeBundleRoomsCharged({
          occupancy,
          // 指定酒店时容量/间数按指定房型算（几大几小一间装不装得下是指定房型的属性）。
          capacity: designatedRoomType ?? bundle.hotelRoomType,
          hotelRoomTypeId: designatedRoomType?.id ?? bundle.hotelRoomTypeId,
          // 单住派生：任一乘客勾了 singleRoom → 该单不是「独自拼房 0.5 间」，按整间收 + 单房差。
          singleCount: derivedSingleCount,
          clientRoomsBilled: item.roomsBilled,
        });

        // 酒店行的权威每间每晚价：套餐绑了房型 → 用 HotelRoomType.basePrice（服务端重算），
        // 绝不信任 bundle.items JSON 里的 HOTEL.unitPrice（历史上可能是占位/过时的畸低值，
        // 会把套餐酒店部分算成几元 → 整单总价崩塌）。未绑房型的老套餐才回退到 JSON 里的 unitPrice。
        const linkedHotelNightlyPrice =
          bundle.hotelRoomTypeId && bundle.hotelRoomType
            ? Number(bundle.hotelRoomType.basePrice)
            : null;

        // 地面部分价（机票部分留给 FLIGHT item 单独动态定价）：
        //   HOTEL 行（qty=晚数）按 每间每晚价×qty×rooms 收费 → 套餐价随房间数涨；
        //     每间每晚价 = linkedHotelNightlyPrice（权威）优先，回退 JSON 里的 unitPrice。
        //   非 HOTEL 地面行（TRANSFER/VISA 等）固定 unitPrice×qty×1（不随房间数变）。
        //   bundleGround = Σ(HOTEL×rooms) + Σ(其它非机票)。折扣不在此扣 —— 改由循环后的
        //   percent-off 后处理对「机票腿 + 套餐行」整体 ×(1−discountPct/100)（旧的固定 groundDiscount 已弃用）。
        // 签证按「办签人数」收费（S2）：办签人数 = 出行总人数(headCount，含婴儿，都需护照/签证)
        //   − 自备签人数（自行办妥签证的乘客）。headCount 基数与 computeBundleAddOn 里 selfProvidedVisaCount
        //   的夹逼基数（occupancy.headCount，含婴儿）完全一致，两处同源不漂移。夹到 ≥0（自备签人数超过出行人
        //   时不出现负份）。修复前 VISA 行按模板静态 qty×unitPrice 收（2 成人只收 1 份）→ 真少收。
        const visaHeadCount = Math.max(0, occupancy.headCount - selfProvidedVisaCount);
        const bundleUnitPrice = computeBundleGroundTotal({
          components: bundle.items,
          linkedHotelNightlyPrice,
          rooms,
          visaHeadCount,
        });
        // 套餐关联酒店 → 把房型+入住日期盖到订单行（房控板自动计入套餐占房）。
        // metadata 缺失/异常时只是不盖章，绝不阻断下单。
        // 出发日以真实航段为准（A7）：有同 bundle 航段时覆盖客户端传来的 goDate，
        // 否则伪造的 goDate 会把占房盖到错误的夜晚。无航段（纯地面套餐）时原样沿用。
        const stampGoDate = item.bundleId
          ? authoritativeBundleGoDates.get(item.bundleId)
          : undefined;
        const stampMetadata = stampGoDate
          ? { ...(item.metadata ?? {}), goDate: stampGoDate }
          : item.metadata;
        const hotelStamp = resolveBundleHotelStamp(
          // 指定酒店 → 盖指定房型的章（房控/销控板按指定酒店计占房）；否则按套餐绑定房型现状。
          { hotelRoomTypeId: designatedRoomType?.id ?? bundle.hotelRoomTypeId },
          stampMetadata,
          nights,
        );

        // ── 出发日期房量库存校验（房量不足不让下单）──────────────────────────
        // 套餐绑了房型 + 能推出入住区间（有 goDate 盖章）时，校验整段每一晚都装得下本单。
        //
        // 口径 = **物理房间**（真实整间数），与房控销控板看板 / 房态导出完全一致，不是床位口径：
        //   床位口径（block − Σ roomsBilled）把「一位男拼房客 + 一位女拼房客」算成 1 间，
        //   但异性不能拼一间、物理上要 2 间 —— 床位口径永远看不见性别这一维，会放行超卖。
        //   （看板已是物理口径；卖货再用床位口径就会出现「看板显示 8、系统还敢卖第 9 间」。）
        //
        // 前瞻闸（assertHotelPhysicalFit）：把本单要新增的占房塞进当晚的性别桶里**重算**物理间数，
        // 而不是拿存量余量硬比 —— 因为一个新拼房客的物理增量是 0 还是 1，取决于当晚有没有
        // 可配对的同性落单，存量数字里看不出来。
        //   hasBlock=false（该酒店没配任何包房周期，即未做库存管控）→ 不拦截（与既有 E2E 一致）；
        //   block[i] === 0（该晚未被任何周期覆盖）→ 视为未管控，不据此拦截。
        // 无盖章（缺 goDate）→ 无从确定入住日期，不在此拦截（沿用既有"缺 goDate 不盖章"的宽松口径）。
        // 指定酒店 → 库存前瞻闸打到指定酒店头上（占的是指定店的房，不是套餐绑定店/占位店）。
        //
        // 例外 —— 房型挂在**随机档占位酒店**上（randomTierPlaceholder 非空）：那不是真房源，
        // 对它跑具体酒店闸等于拿一份假库存放行/拦截。这种单业务上就是「买了 N 星随机、还没落位」，
        // 故改走随机档聚合闸 assertRandomTierFit（Σ同星级真酒店余量 − 未落位占用，与销控板同公式）。
        // 同上：这里是事务外友好预检（只读无锁，也服务于 quote 试算），
        // 权威判定在建单事务内的 assertRandomTierStaysFitWithinTx。
        // 聚合闸是床位口径而非物理口径：随机单还没落到任何一家酒店，拼房能不能配对要等落位
        // 那一刻由该店当晚性别桶决定，落位走换酒店流程、那里已有物理口径前瞻闸把关。
        const fitHotelId = designatedRoomType?.hotelId ?? bundle.hotelRoomType?.hotelId ?? null;
        const fitPlaceholderTier =
          designatedRoomType != null
            ? designatedRoomType.randomTierPlaceholder
            : (bundle.hotelRoomType?.hotel.randomTierPlaceholder ?? null);
        if (hotelStamp && fitHotelId) {
          const nightDates = buildStayNightDates(hotelStamp.hotelCheckIn, hotelStamp.hotelCheckOut);
          if (nightDates.length > 0) {
            // 带豁免 = 内部 ADMIN/STAFF 录单：用默认的带数字文案（要看得见差多少间/超没超上限）；
            // 对外端点（豁免缺省）：中性话术，不暴露包房间数等内部库存数字。
            if (fitPlaceholderTier != null) {
              await assertRandomTierFit(fitPlaceholderTier, nightDates, rooms, {
                maxOversellRooms: hotelOversellCapRooms,
                buildMessage:
                  hotelOversellCapRooms != null
                    ? undefined
                    : () => '该出发日期酒店可用房量不足，请更换日期或联系客服',
              });
            } else {
              await assertHotelPhysicalFit(
                fitHotelId,
                nightDates,
                toProspectiveOccupancy(rooms, passengers),
                {
                  maxOversellRooms: hotelOversellCapRooms,
                  buildMessage:
                    hotelOversellCapRooms != null
                      ? undefined
                      : () => '该出发日期酒店可用房量不足，请更换日期或联系客服',
                },
              );
            }
          }
        }

        // 可选升级 add-on（server-priced，权威重算；缺省 0 → 与旧版价格完全一致）：
        //   单人入住房差 = singleCount × singleSupplementCnyPerNight × nights
        //   升舱商务加价 = (去程升舱人数 + 回程升舱人数) × businessUpgradeCnyPerLeg
        //     （旧整程入参 businessCount → 沿用 businessCount × businessUpgradeCnyPerLeg × legs，结果等价）
        //     —— 这是客户升舱的「总加价」（不是在全价商务票之上再加 ¥700）。客户机票仍按经济舱套餐价收，
        //        差价由商家补贴；升舱只占用真实商务舱库存（不超售），见下方按经济舱航段拆座逻辑。
        // 升舱差价单一配置源：套餐 businessUpgradeCnyPerLeg=null → 「跟随航班」，按该套餐绑定航班
        //   （去程优先、回程次之）的 Flight.businessUpgradeCnyPerLeg 取每程差价（往返同程对称，× legs）；
        //   两趟都没绑到航班时兜底 DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG，绝不派生出 0/裸价。
        //   非 null → 套餐自有覆盖（含 0 = 显式不提供升舱），行为不变。
        const effectiveBusinessUpgradeCnyPerLeg = resolveBundleBusinessUpgradeRate(bundle);
        // 自备签减免单一配置源（与升舱同构）：套餐 selfVisaDeductCny=null → 跟随签证组件产品价
        //   （Visa.basePrice 合计）；非 null → 套餐自有覆盖（含 0 = 显式不减）。
        //   解析后的数落进订单行快照，下游改档/改自备签仍读快照，口径不变。
        const effectiveSelfVisaDeductCny = await resolveSelfVisaDeductCny(bundle);
        const businessUpgradeInput = resolveBundleBusinessUpgradeInput(item);
        // 本单是否有 BUNDLE 行用了分程口径 —— 只有分程口径才启用「回程升舱却没有回程航段」的硬闸，
        // 旧整程入参一律沿用扩展前的宽松行为（回程那份人数无处落座时不拒单），历史调用零回归。
        if (typeof businessUpgradeInput === 'object' && businessUpgradeInput !== null) {
          hasSplitBusinessUpgradeInput = true;
        }
        const addOn = computeBundleAddOn(
          {
            ...bundle,
            businessUpgradeCnyPerLeg: effectiveBusinessUpgradeCnyPerLeg,
            selfVisaDeductCny: effectiveSelfVisaDeductCny,
          },
          hotelStamp,
          derivedSingleCount,
          // 升舱口径：分程字段任一显式提供 → 去/回程各算；都省略 → 回落旧整程 businessCount。
          businessUpgradeInput,
          occupancy,
          nights,
          selfProvidedVisaCount,
        );
        // 累计本单去/回程各自的升舱人数（多份套餐叠加），下方循环结束后分摊到对应经济舱航段并预检商务舱余位。
        // 注意：breakdown 里的两个分程人数都已夹到占座人数（seatPax）上限，婴儿不计入。
        bundleBusinessUpgradeOutbound += addOn.breakdown.businessCountOutbound;
        bundleBusinessUpgradeReturn += addOn.breakdown.businessCountReturn;

        // 指定酒店加价（server-priced）：该酒店配置的每人差价 × 占座人数（婴儿不占床不收）。
        // 费率从 DB 读并夹到非负整数；未指定 → 0，价格与现状完全一致。
        const designationSurchargeRate = designatedRoomType
          ? Math.max(
              0,
              Math.trunc(Number(designatedRoomType.designationSurchargeCnyPerPerson) || 0),
            )
          : 0;
        const designationSurchargeTotal = designationSurchargeRate * occupancy.seatPax;

        // 每人操作费（server-authoritative，从 DB 读的 operationFeeCny，绝不信客户端）：
        //   操作费 = operationFeeCny × 占座人数 seatPax（成人 + 占座儿童）。
        //   婴儿不收操作费——与「婴儿按 infantPriceCny（默认 0/免费）计价、该价即婴儿全价」的惯例一致，
        //   不在婴儿价之上再叠加操作费。计入套餐地面金额（随折扣一并 percent-off，与 起价 把操作费
        //   计入 originalPerPaxCny 原价、再按 discountPct 打折的口径一致）。
        const operationFeeTotal = computeBundleOperationFeeTotal(
          bundle.operationFeeCny,
          occupancy.seatPax,
        );

        // B14 签证挂牌价快照（2026-07-20 拍板「应该改」）：套餐内签证金额此前由导出时从
        // 套餐**现行**定义反推（qty×unitPrice）——运营改套餐价，历史订单导出跟着变。
        // 下单时把 VISA 组件挂牌价合计快照进行 metadata，历史导出从此钉死在下单时点。
        // （自备签减免与此无关：减免额是套餐配置 selfVisaDeductCny，本就与挂牌价解耦。）
        const bundleComponents = Array.isArray(bundle.items)
          ? (bundle.items as Array<{ kind?: string; qty?: unknown; unitPrice?: unknown }>)
          : [];
        const visaListSnapshotCny = bundleComponents
          .filter((c) => c && c.kind === 'VISA')
          .reduce((acc, c) => acc + (Number(c.qty) || 0) * (Number(c.unitPrice) || 0), 0);

        priced.push({
          kind: 'BUNDLE',
          description: item.description,
          quantity: item.quantity,
          unitPrice: bundleUnitPrice,
          // 升级加价 + 指定酒店加价 + 每人操作费加在套餐行总额上（不摊进 unitPrice，保持基础单价语义不变）。
          // addOn.total 可为负（自备签/儿童折扣减免）——非负保护在此行金额层统一夹到 0：
          //   减免先正常抵扣套餐地面价 + 操作费，只有减免大于地面总价的极端场景才夹到 0（不出现负行金额）。
          // 折扣（percent-off）在此之后另行处理，顺序不变。
          amount: Math.max(
            0,
            bundleUnitPrice * item.quantity +
              addOn.total +
              designationSurchargeTotal +
              operationFeeTotal,
          ),
          bundleId: item.bundleId,
          hotelRoomTypeId: hotelStamp?.hotelRoomTypeId,
          hotelCheckIn: hotelStamp?.hotelCheckIn,
          hotelCheckOut: hotelStamp?.hotelCheckOut,
          // 解析后的计费房间数（支持 0.5 间）落到 OrderItem.roomsBilled，供房控读取。
          roomsBilled: rooms,
          // 加项净额（含指定酒店加价，未打折）：结算价日历取价时叠加在日历价之上（报价口径）。
          settlementAddOnCny: addOn.total + designationSurchargeTotal,
          // 把升级选择 + 重算明细 + roomsNeeded + 操作费 + 指定酒店 + 签证挂牌价快照落到订单行 metadata。
          //（admin 内部仍可叫"单房差/升舱"；roomsNeeded 解释酒店部分为何按房价 ×rooms 收费）。
          metadata: {
            ...(item.metadata ?? {}),
            ...(addOn.hasAddOn || rooms > 1 ? { roomsNeeded: rooms, addOns: addOn.breakdown } : {}),
            // 指定酒店留痕（运营/财务解释这单为什么比随机价贵）：店名/费率/人数/小计。对外脱敏剥离。
            ...(designatedRoomType
              ? {
                  designatedHotel: {
                    hotelRoomTypeId: designatedRoomType.id,
                    hotelId: designatedRoomType.hotelId,
                    hotelName: designatedRoomType.hotelName,
                    surchargeCnyPerPerson: designationSurchargeRate,
                    pax: occupancy.seatPax,
                    totalCny: designationSurchargeTotal,
                  },
                }
              : {}),
            ...(operationFeeTotal > 0
              ? {
                  operationFee: {
                    perPaxCny: Math.max(0, Math.trunc(bundle.operationFeeCny)),
                    pax: occupancy.seatPax,
                    totalCny: operationFeeTotal,
                  },
                }
              : {}),
            // 快照恒写（含 0）：0 也是有效事实（该套餐当时不含签证组件），导出据此不再回读现行定义。
            visaListSnapshotCny,
          },
        });
      }
    }

    // ── 套餐升舱占座：把各程升舱人数的座位从经济舱航段「拆」到真实商务舱库存 ──
    // 套餐本身不绑班次（bundle.items 里的 FLIGHT 组件只有描述、无 scheduleId），故升舱要占用的
    // 真实座位来自本单的经济舱 FLIGHT 行（前台套餐订单的往返机票就是这些经济舱航段）。
    // 客户机票仍按经济舱收费（FLIGHT 行 amount 不变）；升舱只改变扣座的舱位分布：
    //   每个经济舱航段：BUSINESS sold += 本段升舱人数，ECONOMY sold += quantity − 本段升舱人数。
    // 净占座仍 = quantity（不持有幽灵经济舱座位、不超售商务舱）。
    //
    // 分程：第一条经济舱航段 = 去程，其余 = 回程（与 items 数组顺序同源——去程行永远排在回程行之前，
    // 单笔录单 / 前台商城 / 批量建单三条派生路径都是「去程在前、回程在后」地推 FLIGHT 行）。
    // 每段各自落自己的 metadata.businessUpgradeCount；取消/超时释放与 admin force 重新占座都读
    // **每行自己**落库的这个数做镜像还原（见 computeBundleSeatSplit 调用处），故占/释天然逐行对称。
    if (bundleBusinessUpgradeOutbound > 0 || bundleBusinessUpgradeReturn > 0) {
      const economyLegs = priced.filter(
        (p) => p.kind === 'FLIGHT' && p.flightCabin === 'ECONOMY',
      );
      if (economyLegs.length === 0) {
        // 没有可升舱的经济舱航段 → 无从占用真实商务舱座位（套餐本身不绑班次）。
        throw new BadRequestError('商务舱余位不足，无法升舱');
      }
      const legPlan = economyLegs.map((leg, idx) => ({
        leg,
        businessCount: idx === 0 ? bundleBusinessUpgradeOutbound : bundleBusinessUpgradeReturn,
      }));
      // 分程口径下，回程有人升舱却没有第二条经济舱航段 → 那份钱收了、座却无处占（钱/座对不上），
      // fail-closed 拒单而不是静默吞掉。旧整程入参不走这个闸（沿用扩展前行为，历史调用零回归）。
      if (hasSplitBusinessUpgradeInput && bundleBusinessUpgradeReturn > 0 && economyLegs.length < 2) {
        throw new BadRequestError('本单没有回程航段，无法为回程升舱，请把回程升舱人数改回 0');
      }
      // 每段经济舱座位数必须 ≥ 本段升舱人数（不能把比本段乘客还多的人升舱）。
      for (const { leg, businessCount } of legPlan) {
        if (leg.quantity < businessCount) {
          throw new BadRequestError('商务舱余位不足，无法升舱');
        }
      }
      // 逐段按本段人数预检真实商务舱余位（事务前友好预检，真正扣减由事务里的原子 CAS 完成，最终防超售）。
      await this.assertBusinessAvailabilityForBundle(legPlan);
      // 标记每个经济舱航段要拆多少座到商务舱，并落到订单行 metadata（取消退座时按此还原拆座）。
      // 本段 0 人也如实落 0：与「无升舱」等价（computeBundleSeatSplit 视 0 为不拆），但把
      // 「这条腿没人升舱」写成显式事实，排障时不必猜是漏写还是真的 0。
      for (const { leg, businessCount } of legPlan) {
        leg.businessUpgradeCount = businessCount;
        leg.metadata = { ...(leg.metadata ?? {}), businessUpgradeCount: businessCount };
      }
    }

    // ── 套餐折扣（percent off）：整个全包价 ×(1−pct/100) ──
    // 逐行对该套餐的 BUNDLE 行 + 关联 FLIGHT 腿打折，使 Σ(行金额) = 全包价×(1−pct)，且各行金额诚实：
    //   航班行 = 折后机票收入（财务航班毛利按折后算，不假高）；套餐行 = 折后地面+加项。
    // 扣座/锁位/查重均按 quantity（不受金额影响）。pct 仅来自 DB（不信前端）。折扣在升舱拆座之后做，不动 quantity。
    for (const p of priced) {
      if (p.kind !== 'BUNDLE' && p.kind !== 'FLIGHT') continue;
      const pct = p.bundleId ? bundleDiscountPct.get(p.bundleId) ?? 0 : 0;
      if (pct <= 0) continue;
      const factor = (100 - pct) / 100;
      p.amount = Math.round(p.amount * factor);
      p.unitPrice = Math.round(p.unitPrice * factor);
      p.metadata = { ...(p.metadata ?? {}), bundleDiscountPct: pct };
    }

    return priced;
  }

  /**
   * 升舱占座预检（套餐升级商务舱时调用）。
   *
   * 套餐升舱的正确模型：客户机票仍按经济舱套餐价收，¥700/程 是升舱的「总加价」（不是在全价商务票上再加）；
   * 升舱要占用的真实商务舱座位来自本单的经济舱 FLIGHT 航段（套餐本身不绑班次）。
   * 这里**逐段按该段自己的升舱人数**（去程/回程可以不同）按六档余位口径
   * （available = capacity − sold − 他人 ACTIVE 锁位 − 占位余座）预检对应班次的商务舱余位：
   *   - 该段班次没有商务舱舱位 / 商务舱余位 < 本段升舱人数 → 拒单（"商务舱余位不足，无法升舱"）
   *   - 本段升舱人数 = 0（如只升去程时的回程腿）→ 不占商务舱，跳过（不能因该班次没开商务舱就拒单）
   * 真正的扣减（ECONOMY 减本段人数、BUSINESS 加本段人数）由事务里的原子 CAS 完成，最终防超售；
   * 此处只做事务前的友好预检。
   */
  private async assertBusinessAvailabilityForBundle(
    legPlan: ReadonlyArray<{ leg: { flightScheduleId?: string }; businessCount: number }>,
  ): Promise<void> {
    const now = new Date();
    for (const { leg, businessCount } of legPlan) {
      if (!leg.flightScheduleId) continue;
      // 本段没人升舱 → 不占用该班次的商务舱，无需（也不该）校验它有没有商务舱位。
      if (businessCount <= 0) continue;
      const sc = await prisma.flightSeatClass.findFirst({
        where: { scheduleId: leg.flightScheduleId, cabin: 'BUSINESS' },
        select: { capacity: true, sold: true },
      });
      if (!sc) {
        throw new BadRequestError('商务舱余位不足，无法升舱');
      }
      const lockedAgg = await prisma.seatLock.aggregate({
        _sum: { qty: true },
        where: {
          seatClass: { scheduleId: leg.flightScheduleId, cabin: 'BUSINESS' },
          status: SeatLockStatus.ACTIVE,
          expiresAt: { gt: now },
        },
      });
      const locked = lockedAgg._sum.qty ?? 0;
      const held = await heldSeatsForCabin(prisma, leg.flightScheduleId, CabinClass.BUSINESS);
      const available = Math.max(0, sc.capacity - sc.sold - locked - held);
      if (available < businessCount) {
        throw new BadRequestError('商务舱余位不足，无法升舱');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 列表
  // ════════════════════════════════════════════════════════════════════
  async listOrders(query: ListOrdersQuery, requester: OrderRequester) {
    const where = buildOrderFilterWhere(query);

    // RBAC 过滤 — 先建基准可见集合，再按 query 过滤（但 query.agentId 不能覆盖可见集合）
    if (requester.role === 'CUSTOMER') {
      where.userId = requester.userId;
    } else if (requester.role === 'AGENT') {
      const visibleAgentIds = await this.getDescendantAgentIds(requester.agentId);
      if (query.agentId) {
        // agentId 过滤 — 必须在可见集合内才生效，否则 403（防横向越权）
        if (!visibleAgentIds.includes(query.agentId)) {
          throw new ForbiddenError('无权查看该代理的订单');
        }
        // where.agentId 已由 buildOrderFilterWhere 设为 query.agentId
      } else {
        where.agentId = { in: visibleAgentIds };
      }
    }
    // ADMIN/STAFF: 无额外过滤；query.agentId（如有）已由 buildOrderFilterWhere 设置

    if (query.claimedById) where.claimedById = query.claimedById;
    if (query.unclaimedOnly) where.claimedById = null;

    // 出行日期 / 返程日期精确细筛（两段式）：buildOrderFilterWhere 的 travelFrom/travelTo、
    // returnFrom/returnTo 都只做 ±1 天粗窗口（防 UTC/本地日边界漏单），会把「去程 7/10、回程
    // 7/11」这类整单出发日/返程日在窗口外的往返单也粗召回。
    // 这里在分页/计数之前，先按粗窗口 + 全部筛选 + RBAC 圈出候选订单的最早/回程航段与酒店时间
    //（只取必要字段），在 JS 里按整单出发日（deriveOrderDepartDate）与整单返程日
    //（deriveOrderReturnDate）精确判定，再把命中 id 作为 id in (...) 并回 where —— 保证分页
    // take/skip 与总数都在精确过滤之后计算，且「列表所见 = 筛选所得」。两个筛选可同时给出，
    // 精确结果取交集。orderIds 勾选导出不走 listOrders，此处无需考虑。
    if (query.travelFrom || query.travelTo || query.returnFrom || query.returnTo) {
      const candidates = await prisma.order.findMany({
        where,
        select: {
          id: true,
          items: {
            select: {
              hotelCheckIn: true,
              // 纯签证单的第三级日期锚点：漏了这个字段，deriveOrderDepartDate 在精筛时
              // 拿不到签证预计出行日期 → 派生 null → 整单被丢，DB 召回白做。
              visaIntendedDate: true,
              // 回程精筛（deriveOrderReturnDate → determineFlightLegItems）按 departureTime
              // 升序取第 2 段，需要 flightScheduleId 才能判定该行是不是「带班次的 FLIGHT 行」。
              flightScheduleId: true,
              flightSchedule: { select: { departureTime: true, departureTz: true } },
            },
          },
        },
      });
      let preciseIds = candidates.map((c) => c.id);
      if (query.travelFrom || query.travelTo) {
        preciseIds = filterOrderIdsByDepartDate(candidates, query.travelFrom, query.travelTo);
      }
      if (query.returnFrom || query.returnTo) {
        const returnMatched = new Set(
          filterOrderIdsByReturnDate(candidates, query.returnFrom, query.returnTo),
        );
        preciseIds = preciseIds.filter((id) => returnMatched.has(id));
      }
      where.id = { in: preciseIds };
    }

    const [rows, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        include: {
          // 带上 fulfillment 任务(类型+状态)，前端据此派生「签证状态」列；
          // 再联查班次出发时间（轻量 select），用于派生订单级「出发日期」列（deriveOrderDepartDate）。
          items: {
            include: {
              fulfillmentTasks: { select: { type: true, status: true } },
              // 联查航班号（flight.flightNumber）——列表「出发日期」列旁的往返航班号展示要用它；
              // 此前只 select 了 departureTime/departureTz，序列化里的 flightNumber 恒为 null，
              // 前端 deriveFlightLegs 只能退化用正则从 description 里捞第一个航班号，往返单两条腿
              // 共用同一段批量建单 description，于是去程/回程两行都显示成了去程号（对比 getOrder，
              // 3618-3627 行早就带了这个 select）。
              flightSchedule: {
                select: {
                  departureTime: true,
                  departureTz: true,
                  flight: { select: { flightNumber: true } },
                },
              },
            },
          },
          // 列表乘客窄 select：身份字段之外补齐每人子行的徽标位（自备签/单住/送签进度）
          // 与票号（pnr/eticketNumber）、子行身份补充（生日/国籍/护照有效期），
          // 仍不带护照照片等重字段。
          passengers: {
            select: {
              id: true,
              fullName: true,
              chineseName: true,
              gender: true,
              documentNumber: true,
              dateOfBirth: true,
              nationality: true,
              passportExpiry: true,
              visaExempt: true,
              singleRoom: true,
              visaSubmissionStatus: true,
              pnr: true,
              eticketNumber: true,
            },
          },
          agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
          user: { select: { id: true, displayName: true, email: true } },
          claimedBy: { select: { id: true, displayName: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    // 对外脱敏口径按请求者角色一次算好（列表所有行同角色），AGENT/CUSTOMER 剥离内部字段 + 逐项拆价。
    const serializeCtx = orderSerializeRoleCtx(requester.role);
    return {
      // 显式包一层箭头函数——serializeOrder 现在带一个可选的第二参数（ctx），直接把它当
      // Array.map 回调传会让 map 的 index 顶进 ctx 位置（number 不是合法 ctx，TS 会报错，
      // 运行时也会把 index 当 ctx.visaStayDaysById 用，产生诡异行为）。listOrders 未联查
      // bundle.items，没有 visaStayDaysById 可传，这里只传 order + 角色脱敏口径，用默认空表。
      orders: rows.map((order) => serializeOrder(order, serializeCtx)),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 详情
  // ════════════════════════════════════════════════════════════════════
  async getOrder(id: string, requester: OrderRequester) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        // 联查行程单渲染所需的产品信息（套餐订单「产品内容」板块用；不新增客户端往返）：
        //   hotelRoomType → 房型名 + 酒店中文名（HOTEL 行 或 BUNDLE 行盖章的 hotelRoomTypeId 均可命中；
        //     套餐订单没有独立的 HOTEL 行，酒店只盖章在 BUNDLE 行的 hotelRoomTypeId 上）。
        //   flightSchedule → 出发/到达时间 + 航班号/起降地（FLIGHT 行、含套餐关联的经济舱腿）。
        //   visa → 签证名/国家/单次最多停留天数（VISA 行 或 套餐通过 items JSON 描述，行本身仅在
        //     客户端提交独立 VISA 行时才带 visaId；套餐纯地面签证组件走 bundle.items 文本描述，见 serializeOrder）。
        //   transfer → 接送产品名。
        //   bundle → 套餐名 + 服务内容 + 组件明细（items）+ 按人定价配置 + 关联房型（BUNDLE 行「产品内容」卡片 v2 用）。
        //     不按 isActive 过滤 —— 套餐下架/软删后历史订单仍需正确渲染（Bundle? 关系本身是普通 FK join，
        //     不会因为关联行的其它字段值而不联查；isActive 只在下单校验时拦截新购，不影响历史订单读取）。
        items: {
          include: {
            hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
            flightSchedule: {
              select: {
                departureTime: true,
                arrivalTime: true,
                // 当地时区：行程单/订单详情的时刻必须按它折算，否则显示的是 UTC 分量
                departureTz: true,
                arrivalTz: true,
                flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
              },
            },
            visa: { select: { visaName: true, country: true, destinationCountry: true, stayDays: true } },
            transfer: { select: { name: true } },
            bundle: {
              select: {
                name: true,
                serviceNotes: true,
                items: true,
                infantPriceCny: true,
                childSeatDiscountCnyPerPerson: true,
                hotelRoomTypeId: true,
                hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
              },
            },
          },
        },
        passengers: true, // 含护照/签证/地址全部新字段
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
        user: { select: { id: true, displayName: true, email: true } },
        claimedBy: { select: { id: true, displayName: true, email: true } },
        reminders: {
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
          include: { createdBy: { select: { id: true, displayName: true } } },
        },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);
    // 套餐 VISA 组件的「最多可停留天数」不在 bundle.items JSON 里（那只存 visaId），需按 visaId 批量查
    // Visa.stayDays（best-effort：查询失败/无签证组件时给空表，itineraryFieldsForItem 照常降级为 null）。
    const visaStayDaysById = await this.loadBundleVisaStayDays(order.items);
    // 按角色一次算好脱敏口径：ADMIN/STAFF 看全量（含护照大图）；AGENT/CUSTOMER 剥离内部字段 + 逐项拆价
    // （护照大图同口径剥离——响应瘦身 + 少暴露 PII，与既有 includePassportPhotos 行为一致）。
    return serializeOrder(order, {
      visaStayDaysById,
      ...orderSerializeRoleCtx(requester.role),
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // 软删除（仅 ADMIN）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 软删除订单：置 deletedAt，使订单从所有列表/导出/统计里消失，但整行数据保留可追溯。
   *
   * 前置守卫（CRITICAL）：只允许删「已释放座位」的订单——status ∈ SEAT_RELEASING_STATUSES
   *   (CANCELLED / PAYMENT_TIMEOUT / REFUNDED / FAILED / DRAFT)。仍占座的订单
   *   (SEAT_HOLDING_STATUSES) 拒删，提示先取消释放座位——绝不在删除里偷偷做释放
   *   （否则绕过状态机的座位账扣减，会把 sold 账做坏）。删除本身不触碰任何库存/座位账。
   *
   * 净收款守卫（CRITICAL）：状态守卫通过后，再查「净收款」= 已确认收款(order.paidAmount，
   *   增量维护的权威字段，覆盖人工确认收款/挂账认领/代理余额抵扣等全部入账路径) − 已完成退款
   *   (Refund.status=COMPLETED 之和；REQUESTED/APPROVED/PROCESSING/REJECTED 都不算——钱还在
   *   公司手上，没退出去)。净收款 > 0 → 拒删，防止「已取消但钱没退完」的订单被删掉后从所有
   *   列表消失、退款义务没人追。净收款 ≤ 0（零收款或已退平）才放行。
   *
   * 仅 ADMIN 可删（STAFF 不行）；返回删除前后的最小快照供路由层写审计。
   */
  async softDeleteOrder(id: string, requester: OrderRequester) {
    if (requester.role !== UserRole.ADMIN && requester.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅内部员工可删除订单');
    }
    // 只找未删的订单（已删的再次删 → 视为不存在，幂等）
    const order = await prisma.order.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paidAmount: true,
        refunds: { where: { status: 'COMPLETED' }, select: { amount: true } },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');

    if (SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError('该订单仍占用座位，请先取消订单释放座位，再删除');
    }
    // 双重保险：只有释放型状态才允许删（与守卫语义对称，防未来新增状态漏网）
    if (!SEAT_RELEASING_STATUSES.includes(order.status)) {
      throw new BadRequestError('该订单当前状态不允许删除');
    }

    const refundedTotal = order.refunds.reduce((sum, r) => sum + Number(r.amount), 0);
    const netReceived = round2(Number(order.paidAmount) - refundedTotal);
    if (netReceived > 0) {
      throw new BadRequestError(
        `该订单尚有已收款 ¥${netReceived.toFixed(2)} 未退，请先完成退款再删除`,
      );
    }

    const before = { id: order.id, orderNumber: order.orderNumber, status: order.status };
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { deletedAt: new Date() },
      select: { id: true, orderNumber: true, status: true, deletedAt: true },
    });
    return { before, after: updated };
  }

  // ════════════════════════════════════════════════════════════════════
  // 回收站：列出已软删订单 + 恢复（ADMIN + STAFF）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 回收站列表：分页列出 deletedAt 非空的订单（按删除时间倒序）。
   *
   * 删除人（deletedBy）从 SOFT_DELETE_ORDER 审计取——每单取最近一条，关联 actor
   * 拿 displayName/email。审计写入是 fire-and-forget，可能缺失；取不到就置 null，不硬凑。
   * status 未被软删改动，故这里直接就是删除前的原状态。
   *
   * 仅 ADMIN 可看（与删除权限对称，STAFF 不行）。
   */
  async listDeletedOrders(
    query: { page: number; pageSize: number; search?: string },
    requester: OrderRequester,
  ) {
    if (requester.role !== UserRole.ADMIN && requester.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅内部员工可查看回收站');
    }
    const where: Prisma.OrderWhereInput = { deletedAt: { not: null } };
    // 搜索：与主列表同口径，复用 splitSearchTerms + buildSearchTermClause——
    // 分词（空格/英文逗号/中文逗号/顿号，上限 5 词）后词间 AND，每词 OR 匹配
    // 订单号/联系人/电话/备注六栏/乘客中英文名+护照号。回收站无自有可搜字段
    // （deletedBy 来自审计表另查，不在 Order 上），故字段集与主列表完全一致。
    // 只在分词非空时叠加 AND，避免默认路径的 where 形状变化（单测断言精确匹配）。
    if (query.search) {
      const termClauses = splitSearchTerms(query.search).map(buildSearchTermClause);
      if (termClauses.length > 0) where.AND = termClauses;
    }
    const [rows, total] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          contactName: true,
          total: true,
          currency: true,
          status: true,
          deletedAt: true,
          // 只取姓名字段（不整对象）：回收站行展示用，供运营按乘客名找回误删单。
          passengers: { select: { fullName: true, chineseName: true } },
          // 派生「出发日期」列所需的最小字段（deriveOrderDepartDate 同口径，= 订单列表「出发日期」列）：
          // FLIGHT 行取班次出发时间、酒店行取入住日；恢复误删单前先看清是哪个团期。
          items: {
            select: {
              hotelCheckIn: true,
              flightSchedule: { select: { departureTime: true, departureTz: true } },
            },
          },
        },
        orderBy: { deletedAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.order.count({ where }),
    ]);

    // 每单最近一条 SOFT_DELETE_ORDER 审计 → 删除人标签（缓存 actorLabel 优先，
    // 回退到关联 actor 的 displayName/email）。desc 排序后每单首条即最近。
    const orderIds = rows.map((o) => o.id);
    const deletedByMap = new Map<string, string>();
    if (orderIds.length > 0) {
      const audits = await prisma.auditLog.findMany({
        where: {
          action: 'SOFT_DELETE_ORDER',
          targetType: AuditTargetType.ORDER,
          targetId: { in: orderIds },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          targetId: true,
          actorLabel: true,
          actor: { select: { displayName: true, email: true } },
        },
      });
      for (const a of audits) {
        if (!a.targetId || deletedByMap.has(a.targetId)) continue;
        const label = a.actorLabel ?? a.actor?.displayName ?? a.actor?.email ?? null;
        if (label) deletedByMap.set(a.targetId, label);
      }
    }

    return {
      orders: rows.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customerName: o.contactName,
        total: o.total.toString(),
        currency: o.currency,
        status: o.status,
        deletedAt: o.deletedAt,
        deletedBy: deletedByMap.get(o.id) ?? null,
        // 原出发日期（去程最早航段当地出发日 → 回退最早酒店入住日 → null；与订单列表「出发日期」同口径）：
        // 恢复误删单前先辨清是哪个团期。items 缺失（形状漂移）时安全落空为 null。
        departDate: deriveOrderDepartDate(o.items ?? []),
        // 乘客姓名（中文名优先，缺失回退证件姓名）：回收站行展示 + 前端搜索命中辅助定位。
        passengerNames: o.passengers.map((p) => p.chineseName?.trim() || p.fullName),
      })),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  /**
   * 恢复软删订单：deletedAt 置回 null，订单重新出现在所有列表/导出/统计。
   *
   * 不占座依据（CRITICAL）：软删本身从不改 status（见 softDeleteOrder），且只有
   * 已释放座位的订单（SEAT_RELEASING_STATUSES：CANCELLED/PAYMENT_TIMEOUT/REFUNDED/
   * FAILED/DRAFT）才被允许删除。因此凡在回收站里的订单，其状态都是释放型——恢复只是
   * 清 deletedAt 让它重新可见，绝不会凭空占座（不触碰任何库存/座位账），与删除对称。
   *
   * 仅 ADMIN 可恢复；返回 before/after 最小快照供路由层写审计。
   * 未删 / 不存在的订单 → NotFound（findFirst 只匹配 deletedAt 非空，幂等）。
   */
  async restoreOrder(id: string, requester: OrderRequester) {
    if (requester.role !== UserRole.ADMIN && requester.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅内部员工可恢复订单');
    }
    const order = await prisma.order.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { id: true, orderNumber: true, status: true, deletedAt: true },
    });
    if (!order) throw new NotFoundError('回收站中无此订单');

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { deletedAt: null },
      select: { id: true, orderNumber: true, status: true, deletedAt: true },
    });
    return { before: order, after: updated };
  }

  /**
   * 批量解析本单所有 BUNDLE 行关联套餐的 VISA 组件 stayDays（订单详情「产品内容」卡片「签证」板块用）。
   * bundle.items JSON 里的 VISA 组件只带 visaId（见 bundleItemSchema），stayDays 要另查 Visa 表。
   * 一次 findMany 覆盖本单所有套餐的所有 VISA 组件，避免逐行 N+1。查询失败不阻断订单详情渲染。
   */
  private async loadBundleVisaStayDays(
    items: ReadonlyArray<{ bundle?: { items: Prisma.JsonValue } | null }>,
  ): Promise<Map<string, number | null>> {
    const visaIds = new Set<string>();
    for (const i of items) {
      const bundleItems = i.bundle?.items;
      if (!Array.isArray(bundleItems)) continue;
      for (const b of bundleItems) {
        if (b == null || typeof b !== 'object') continue;
        const rec = b as { kind?: unknown; visaId?: unknown };
        if (rec.kind === 'VISA' && typeof rec.visaId === 'string' && rec.visaId) {
          visaIds.add(rec.visaId);
        }
      }
    }
    if (visaIds.size === 0) return new Map();
    try {
      const visas = await prisma.visa.findMany({
        where: { id: { in: [...visaIds] } },
        select: { id: true, stayDays: true },
      });
      return new Map(visas.map((v) => [v.id, v.stayDays]));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[orders] failed to load bundle visa stayDays for', [...visaIds], err);
      return new Map();
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // 代理余额账户 —— 多付存入 / 用余额抵尾款
  // （取代「跨人抵扣」：多付不再直接抵给别的客户，而是进代理自己的预存余额账户；
  //  少付从同一余额顶。ADMIN/STAFF 操作，全程事务安全 + 审计 + 余额不为负。）
  // ════════════════════════════════════════════════════════════════════

  /**
   * 多付处置的 Payment 台账对冲行（R6：堵死「处置后再进 PAID 把多付灌回」的造币循环）。
   *
   * 病灶：多付处置只把钱从 order.paidAmount 移走，Payment 台账里那几笔 SUCCEEDED 原封不动。
   * 而 _updateStatusWithinTx 的 PAID 分支会按台账 SUCCEEDED 合计把 paidAmount 抬回去
   * （`if (paymentsSum > currentPaid) paidAmount = paymentsSum`，用于网关回调补记）。
   * 于是订单每再进一次 PAID（如 CHANGE_REQUESTED→PAID 驳回改签，合法路径、无需 force），
   * 多付就凭空复活一次，可无限循环每轮白造一笔钱。
   *
   * 修法：处置的同时在台账登记等额流出——一条**负金额 SUCCEEDED** Payment。
   * 这样 SUCCEEDED 合计随之下降，PAID 分支的重写条件自然恒为假，而补记逻辑本身完好保留
   * （真有迟到的网关回调补记时仍然生效）。
   *
   * 为什么是「负金额 SUCCEEDED」而不是别的状态：
   *   · 只有 SUCCEEDED 进「实收」合计，要抵扣就必须同在 SUCCEEDED 里，否则合计纹丝不动；
   *   · paidAt 留空 → 导出的「最近一笔成功收款」（按 paidAt 过滤排序）不会把对冲行误当收款；
   *   · gatewayPayload.source='overpay-disposal' 是自识别标志，与认款行（source='reconciliation'）
   *     互不相干，不会被冲销/查重/认款回溯等路径误认。
   *   · 金额为负 → 手工收款查重（按等额匹配）、认款冲销（按 allocationId/等额匹配）天然不命中。
   */
  private async _recordOverpayDisposalPayment(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      amountCny: number;
      method: PaymentMethod;
      disposal: 'AGENT_BALANCE' | 'RECEIPT_POOL';
      description: string;
    },
  ): Promise<void> {
    await tx.payment.create({
      data: {
        orderId: input.orderId,
        method: input.method,
        amount: new Prisma.Decimal(-round2(input.amountCny)),
        status: PaymentStatus.SUCCEEDED,
        paidAt: null,
        // 多付处置是内部记账（负额），不是新钱进账，创建即视同已核实，不进待核实队列。
        verifiedAt: new Date(),
        gatewayPayload: {
          source: 'overpay-disposal',
          disposal: input.disposal,
          amountCny: round2(input.amountCny),
          disposedAt: new Date().toISOString(),
          note: input.description,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * 取最近一笔**真实收款**的支付方式（对冲行金额为负，必须排除，否则一路取到自己身上）。
   */
  private async _latestInboundPaymentMethod(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<PaymentMethod> {
    const latest = await tx.payment.findFirst({
      where: { orderId, amount: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      select: { method: true },
    });
    return latest?.method ?? PaymentMethod.WECHAT_PAY;
  }

  /**
   * 多付存入代理余额。订单有代理且 paidAmount > total（多付）时：
   *   一个事务里：order.paidAmount 回压到 total（消掉多付），代理 prepaymentBalance += 多付额，
   *   写一条 PrepaymentTransaction（TOP_UP，钱进余额）+ 一条负金额对冲 Payment（见
   *   _recordOverpayDisposalPayment）+ 关联 orderId。
   * 无代理 / 无多付 → 拒绝。
   */
  async creditOverpayToAgent(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    creditedAmount: number;
    newPaidAmount: number;
    total: number;
    agentBalanceAfter: number;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可将多付存入代理余额');
    }

    return prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁：事务内读最新 paidAmount/total，避免与并发到账/抵扣用旧快照
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          agentId: string | null;
          total: Prisma.Decimal;
          adjustmentCny: number;
          paidAmount: Prisma.Decimal;
          prepaymentOffset: Prisma.Decimal;
          status: OrderStatus;
          deletedAt: Date | null;
        }>
      >`SELECT id, "orderNumber", "agentId", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      // 资金处置闸：死单/软删单不许再动钱（避免账实分叉）
      assertOrderAllowsFundsDisposal(order, '将多付存入代理余额');
      if (!order.agentId) throw new BadRequestError('该订单无归属代理，无法存入代理余额');

      const total = Number(order.total);
      const paid = Number(order.paidAmount);
      // 已完成退款必须先从 paidAmount 里扣掉再算多付：退款完成不减 paidAmount（REFUNDED 只翻 Refund 状态），
      // 不扣就会把同一笔多付「先退给客户、再转存代理余额」取两次（公司净损失）。
      const refunded = await sumCompletedRefundsWithinTx(tx, orderId);
      // 多付 = 清账口径下的负尾款（含改期费/预存抵扣），与 serializeOrder.balanceDue<0 一字一致：
      //   overpay = (paidAmount − 已退款) + prepaymentOffset − (total + adjustmentCny)
      // 不能只按 paid−total，否则有改期费的单会把「还没收齐的改期费」误当多付存进代理余额。
      const clearingPoint = round2(total + order.adjustmentCny - Number(order.prepaymentOffset));
      const overpay = round2(paid - refunded - clearingPoint);
      if (overpay <= 0) {
        throw new BadRequestError('该订单没有多付金额（已付款扣除已退款 ≤ 应付），无可存入余额');
      }

      // 代理余额行锁 + 事务内累加（与 settlements PAID 抵扣同一并发安全口径）
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${order.agentId} FOR UPDATE
      `;
      if (!agentRows[0]) throw new NotFoundError('代理不存在');
      const balanceAfter = round2(Number(agentRows[0].prepaymentBalance) + overpay);

      await tx.agent.update({
        where: { id: order.agentId },
        data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
      });
      // 多付回压：paidAmount 只扣掉本次转存的 overpay（无退款时等于降回清账点，与旧行为一致）。
      // 不直接写 clearingPoint：那样会把「已退款但仍留在 paidAmount 里」的部分也一并抹掉，
      // 与系统其它处（退款不减 paidAmount）的口径冲突。
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(round2(paid - overpay)) },
      });
      await tx.prepaymentTransaction.create({
        data: {
          agentId: order.agentId,
          amount: new Prisma.Decimal(overpay), // 正数 = 入账
          balanceAfter: new Prisma.Decimal(balanceAfter),
          type: PrepaymentTxType.TOP_UP,
          orderId,
          description: `订单 ${order.orderNumber} 多付转存代理余额`,
          createdById: actor.userId,
        },
      });
      // R6：台账同步登记等额流出，否则订单再进一次 PAID 就会按 SUCCEEDED 合计把多付灌回（造币循环）。
      await this._recordOverpayDisposalPayment(tx, {
        orderId,
        amountCny: overpay,
        method: await this._latestInboundPaymentMethod(tx, orderId),
        disposal: 'AGENT_BALANCE',
        description: `订单 ${order.orderNumber} 多付转存代理余额`,
      });

      return {
        ok: true as const,
        orderId,
        orderNumber: order.orderNumber,
        agentId: order.agentId,
        creditedAmount: overpay,
        newPaidAmount: round2(paid - overpay),
        total,
        agentBalanceAfter: balanceAfter,
      };
    });
  }

  /**
   * 用代理余额抵订单尾款。订单有代理、代理余额 ≥ amount、amount ≤ 尾款（total − paidAmount，须 > 0）时：
   *   一个事务里：代理 prepaymentBalance -= amount，order.paidAmount += amount，
   *   写一条 PrepaymentTransaction（OFFSET，余额用在订单上）+ 关联 orderId；
   *   若抵扣后已全额覆盖且订单仍在 PENDING_PAYMENT，复用 _updateStatusWithinTx 推 PAID
   *   （同走佣金 / 履约任务生成那一套）。
   * 无代理 / 超抵（amount > 尾款）/ 余额不足 → 拒绝；余额不会为负。
   */
  async applyAgentBalanceToOrder(
    orderId: string,
    amount: number,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    appliedAmount: number;
    newPaidAmount: number;
    total: number;
    fullyPaid: boolean;
    status: OrderStatus;
    agentBalanceAfter: number;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可用代理余额抵尾款');
    }
    const apply = round2(amount);
    if (apply <= 0) throw new BadRequestError('抵扣金额必须大于 0');

    const pendingFulfillmentTaskIds: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      // 订单行锁 + 事务内读最新尾款
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          agentId: string | null;
          total: Prisma.Decimal;
          adjustmentCny: number;
          paidAmount: Prisma.Decimal;
          prepaymentOffset: Prisma.Decimal;
          status: OrderStatus;
          deletedAt: Date | null;
        }>
      >`SELECT id, "orderNumber", "agentId", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      // 资金闸：用代理余额抵扣 = 往订单里灌钱，死单/软删单一律拒绝（否则钱进死单无出口）。
      assertOrderAcceptsFunds(order);
      if (!order.agentId) throw new BadRequestError('该订单无归属代理，无法用代理余额抵扣');

      const total = Number(order.total);
      const paid = Number(order.paidAmount);
      // 尾款 = 清账口径（含改期费与预存抵扣），与 serializeOrder.balanceDue 一字一致——
      // 不能只按 total−paid，否则有改期费的单会误判"已结清"、代理余额抵扣被拒或抵不到位。
      const effectivePayable = round2(total + order.adjustmentCny);
      const prepaymentOffset = Number(order.prepaymentOffset);
      const remaining = round2(effectivePayable - paid - prepaymentOffset);
      if (remaining <= 0) throw new BadRequestError('该订单无尾款（已结清或多付），无需抵扣');
      if (apply > remaining + 0.001) {
        throw new BadRequestError(
          `抵扣金额 ¥${apply.toFixed(2)} 超过尾款 ¥${remaining.toFixed(2)}，已拒绝`,
        );
      }

      // 代理余额行锁：余额不足直接拒，绝不透支为负
      const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
        SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${order.agentId} FOR UPDATE
      `;
      if (!agentRows[0]) throw new NotFoundError('代理不存在');
      const balance = Number(agentRows[0].prepaymentBalance);
      if (apply > balance + 0.001) {
        throw new BadRequestError(
          `代理余额 ¥${balance.toFixed(2)} 不足以抵扣 ¥${apply.toFixed(2)}，已拒绝`,
        );
      }
      const balanceAfter = round2(balance - apply);
      const newPaid = round2(paid + apply);
      // 清账阈值：paidAmount + prepaymentOffset >= total + adjustmentCny 才算收齐（自动转 PAID）。
      const fullyPaid = round2(newPaid + prepaymentOffset) + 0.001 >= effectivePayable;

      await tx.agent.update({
        where: { id: order.agentId },
        data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(newPaid) },
      });
      await tx.prepaymentTransaction.create({
        data: {
          agentId: order.agentId,
          amount: new Prisma.Decimal(-apply), // 负数 = 余额扣减（用在订单上）
          balanceAfter: new Prisma.Decimal(balanceAfter),
          type: PrepaymentTxType.OFFSET,
          orderId,
          description: `订单 ${order.orderNumber} 代理余额抵尾款`,
          createdById: actor.userId,
        },
      });

      // 抵满 + 仍待支付 → 复用 PAID 流转（含佣金 / 履约任务）
      let finalStatus: OrderStatus = order.status;
      if (fullyPaid && order.status === OrderStatus.PENDING_PAYMENT) {
        await this._updateStatusWithinTx(
          tx,
          orderId,
          OrderStatus.PAID,
          { userId: actor.userId, role: actor.role, actorType: 'USER' },
          `代理余额抵尾款（¥${apply.toFixed(2)}）结清`,
          pendingFulfillmentTaskIds,
        );
        finalStatus = OrderStatus.PAID;
      }

      return {
        ok: true as const,
        orderId,
        orderNumber: order.orderNumber,
        agentId: order.agentId,
        appliedAmount: apply,
        newPaidAmount: newPaid,
        total,
        fullyPaid,
        status: finalStatus,
        agentBalanceAfter: balanceAfter,
      };
    });

    // 事务外 enqueue fulfillment（与 confirmManualPayment 一致）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[orders] failed to enqueue fulfillment task:', e);
        });
      }
    }

    return result;
  }

  // ════════════════════════════════════════════════════════════════════
  // 订单超额 → 挂账池（游客版「存代理余额」；对账时再认领/退款）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 把订单的多付额转入挂账池。适用于任意订单（游客 OR 代理）——
   * 这是「超额放挂账池」的答案，对应代理单的 creditOverpayToAgent。
   *   一个事务里：订单行锁 → 多付 = paidAmount − total（> 0 才放行）→ paidAmount 回压到 total →
   *   建一笔 OPEN Receipt（source=ORDER_OVERPAY，金额=多付额，method 取最近一笔 Payment 否则 WECHAT_PAY，
   *   payerNote='订单超额 '+orderNo，orderHintId=orderId）。
   * 无多付（paidAmount ≤ total）→ 拒绝。原子。
   */
  async overpayToPool(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    movedAmount: number;
    newPaidAmount: number;
    total: number;
    receiptId: string;
    receiptNo: string;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可将订单超额转入挂账池');
    }

    return prisma.$transaction(async (tx) => {
      // 订单行锁 + 事务内读最新 paidAmount/total（与并发到账/抵扣同一并发安全口径）
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderNumber: string; total: Prisma.Decimal; adjustmentCny: number; paidAmount: Prisma.Decimal; prepaymentOffset: Prisma.Decimal; status: OrderStatus; deletedAt: Date | null }>
      >`SELECT id, "orderNumber", total, "adjustmentCny", "paidAmount", "prepaymentOffset", status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      // 资金处置闸：死单/软删单不许再动钱。
      assertOrderAllowsFundsDisposal(order, '将多付转入挂账池');

      const total = Number(order.total);
      const paid = Number(order.paidAmount);
      // 已完成退款先扣（同 creditOverpayToAgent 口径），避免多付被退款+转挂账池取两次。
      const refunded = await sumCompletedRefundsWithinTx(tx, orderId);
      // 多付 = 清账口径下的负尾款（含改期费/预存抵扣），与 creditOverpayToAgent / serializeOrder.balanceDue<0 一字一致。
      const clearingPoint = round2(total + order.adjustmentCny - Number(order.prepaymentOffset));
      const overpay = round2(paid - refunded - clearingPoint);
      if (overpay <= 0) {
        throw new BadRequestError('该订单没有多付金额（已付款扣除已退款 ≤ 应付），无可转入挂账池');
      }

      // method 兜底：取最近一笔**真实收款**的 method（排除负金额对冲行），否则 WECHAT_PAY
      const method = await this._latestInboundPaymentMethod(tx, orderId);

      // 多付回压：paidAmount 只扣掉本次转出的 overpay（无退款时等于降回清账点，与旧行为一致）。
      await tx.order.update({
        where: { id: orderId },
        data: { paidAmount: new Prisma.Decimal(round2(paid - overpay)) },
      });
      // R6：台账同步登记等额流出，否则订单再进一次 PAID 就会按 SUCCEEDED 合计把多付灌回（造币循环）。
      await this._recordOverpayDisposalPayment(tx, {
        orderId,
        amountCny: overpay,
        method,
        disposal: 'RECEIPT_POOL',
        description: `订单 ${order.orderNumber} 多付转入挂账池`,
      });

      // 建一笔 OPEN 进账（挂账池），来源标记订单超额
      const receipt = await createOpenReceiptWithinTx(tx, {
        amountCny: overpay,
        method,
        source: ReceiptSource.ORDER_OVERPAY,
        payerNote: `订单超额 ${order.orderNumber}`,
        orderHintId: orderId,
        createdById: actor.userId,
      });

      return {
        ok: true as const,
        orderId,
        orderNumber: order.orderNumber,
        movedAmount: overpay,
        newPaidAmount: round2(paid - overpay),
        total,
        receiptId: receipt.id,
        receiptNo: receipt.receiptNo,
      };
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // 公开订单查询（A4，免登录）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 用 orderNumber + (phone 或 email) 匹配订单，命中返回脱敏视图，否则返回 null。
   * 匹配范围：订单游客联系人(guestPhone/guestEmail/contactPhone/contactEmail) 或
   * 归属用户(user.phone/user.email)。任一字段命中即可。
   * 安全：永不泄露内部备注/成本/代理/expectedAmount/PII；不命中统一返回 null（路由 → 404）。
   */
  async lookupOrderPublic(query: PublicOrderLookupQuery): Promise<MaskedOrderView | null> {
    const order = await prisma.order.findUnique({
      where: { orderNumber: query.orderNumber },
      include: {
        items: { include: { flightSchedule: { select: { departureTime: true, departureTz: true } } } },
        passengers: { select: { fullName: true, firstName: true } },
        payments: { select: { status: true } },
        user: { select: { phone: true, email: true } },
      },
    });
    if (!order) return null;

    // 联系方式匹配（phone / email 任一）。比对时去空白；电话忽略大小写无意义但邮箱忽略大小写。
    const phone = query.phone?.trim();
    const email = query.email?.trim().toLowerCase();
    const orderPhones = [order.guestPhone, order.contactPhone, order.user?.phone]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim());
    const orderEmails = [order.guestEmail, order.contactEmail, order.user?.email]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase());

    const phoneMatch = phone ? orderPhones.includes(phone) : false;
    const emailMatch = email ? orderEmails.includes(email) : false;
    if (!phoneMatch && !emailMatch) return null;

    return maskOrderForPublic(order);
  }

  /**
   * 客户上传付款凭证用的轻量校验 —— 与公开订单查询同一套防枚举门禁。
   *   orderNo + lookupKey 必须命中（lookupKey 任一匹配：手机号 / 邮箱 / 订单联系人姓氏）。
   * 命中返回订单 id + 应付尾款（amountCny 缺省时用作进账额）；不命中返回 null（路由 → 拒绝）。
   * 只读，绝不入账。
   */
  async lookupOrderForReceiptUpload(
    orderNumber: string,
    lookupKey: string,
  ): Promise<{ orderId: string; balanceCny: number } | null> {
    const order = await prisma.order.findUnique({
      where: { orderNumber },
      include: { user: { select: { phone: true, email: true } } },
    });
    if (!order) return null;

    const key = lookupKey.trim();
    if (!key) return null;
    const keyLower = key.toLowerCase();

    const phones = [order.guestPhone, order.contactPhone, order.user?.phone]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim());
    const emails = [order.guestEmail, order.contactEmail, order.user?.email]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim().toLowerCase());
    // 姓氏匹配：联系人 / 游客姓名首段（与公开查单同口径），忽略大小写。
    // 只取首段（拉丁名首词 / 中文整名），不再接受单字符首字匹配——
    // 单字符的猜测空间太小，会削弱公开上传的第二因子强度。
    const names = [order.contactName, order.guestName]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.trim());
    const lastNames = names.flatMap((n) => {
      const segs = n.split(/\s+/).filter(Boolean);
      return segs.length > 0 ? [segs[0].toLowerCase()] : [];
    });

    const matched =
      phones.includes(key) || emails.includes(keyLower) || lastNames.includes(keyLower);
    if (!matched) return null;

    // 清账口径：total + adjustmentCny − paidAmount − prepaymentOffset（与 serializeOrder.balanceDue 一字一致）。
    const balanceCny = round2(
      Number(order.total) + (order.adjustmentCny ?? 0) - Number(order.paidAmount) - Number(order.prepaymentOffset),
    );
    return { orderId: order.id, balanceCny: Math.max(0, balanceCny) };
  }

  // ════════════════════════════════════════════════════════════════════
  // 状态流转
  // ════════════════════════════════════════════════════════════════════
  async updateStatus(
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason?: string,
    force?: boolean,
  ) {
    // 收集事务里创建的任务 id，提交后再入队（避免 worker 在 tx 提交前查不到）
    const pendingFulfillmentTaskIds: string[] = [];
    // 收集释放座位的舱位 id，提交后排队候补检查
    const releasedSeatClassIds: string[] = [];
    // 取消族恢复时被自动清除的开票标记提示（超出班次开票额度 → 清标记，要求票务台重开）
    const invoiceCapWarnings: string[] = [];

    const updated = await prisma.$transaction(async (tx) => {
      return this._updateStatusWithinTx(
        tx,
        id,
        toStatus,
        requester,
        reason,
        pendingFulfillmentTaskIds,
        force,
        releasedSeatClassIds,
        invoiceCapWarnings,
      );
    });

    // 事务提交后 enqueue fulfillment jobs（若有）
    if (pendingFulfillmentTaskIds.length > 0 && process.env.ENABLE_AUTO_FULFILLMENT === 'true') {
      const { fulfillmentQueue } = await import('../../queues/queue.js');
      for (const taskId of pendingFulfillmentTaskIds) {
        // 确定性 jobId = taskId 做去重，防重复 enqueue
        void fulfillmentQueue.add('auto-fulfill', { taskId }, { jobId: taskId, delay: 1000 }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[orders] failed to enqueue fulfillment task:', e);
        });
      }
    }

    // 终态（PAID / CANCELLED / PAYMENT_TIMEOUT）都不再需要 seat-hold 兜底
    if (toStatus === 'PAID' || toStatus === 'CANCELLED' || toStatus === 'PAYMENT_TIMEOUT') {
      try {
        const { cancelSeatHoldRelease } = await import('../../queues/queue.js');
        await cancelSeatHoldRelease(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to cancel seat-hold job for', id, err);
      }
    }

    // 释放了座位 → 排队候补检查（best-effort，失败不阻塞状态流转）
    if (releasedSeatClassIds.length > 0) {
      try {
        const { enqueueWaitlistCheck } = await import('../../queues/queue.js');
        await Promise.all(
          [...new Set(releasedSeatClassIds)].map((seatClassId) => enqueueWaitlistCheck(seatClassId)),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to enqueue waitlist-check for', id, err);
      }
    }

    // 对外脱敏按请求者角色：AGENT/CUSTOMER 自助改状态的返回也剥离内部字段（getOrder/listOrders 同口径）。
    // invoiceCapWarnings 只在「取消族恢复把开票标记清掉了」时出现，附在订单上带回给操作者
    //（没清就没有这个键，前端不必处理空数组）。
    const serialized = serializeOrder(updated, orderSerializeRoleCtx(requester.role));
    return invoiceCapWarnings.length > 0
      ? { ...serialized, invoiceCapWarnings: [...new Set(invoiceCapWarnings)] }
      : serialized;
  }

  /**
   * 批量状态流转（ADMIN/STAFF 后台用）。
   * 每个 id 独立 transaction，partial failure 不回滚成功项；返回 per-id 结果。
   */
  async batchUpdateStatus(
    ids: string[],
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason?: string,
    force?: boolean,
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{
      id: string;
      success: boolean;
      orderNumber?: string;
      error?: string;
      /** 取消族恢复时被自动清除的开票标记提示（需票务台重开），无则不出现。 */
      warnings?: string[];
    }>;
  }> {
    const results: Array<{
      id: string;
      success: boolean;
      orderNumber?: string;
      error?: string;
      warnings?: string[];
    }> = [];
    let successCount = 0;
    let failureCount = 0;
    for (const id of ids) {
      try {
        const order = await this.updateStatus(id, toStatus, requester, reason, force);
        // 逐单把「开票标记被清掉」的提示带回：批量恢复时这类单往往混在几十条里，
        // 不逐条回显就等于悄悄改了数据。
        const warnings = (order as { invoiceCapWarnings?: string[] }).invoiceCapWarnings;
        results.push({
          id,
          success: true,
          orderNumber: order.orderNumber,
          ...(warnings && warnings.length > 0 ? { warnings } : {}),
        });
        successCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        results.push({ id, success: false, error: message });
        failureCount += 1;
      }
    }
    return { successCount, failureCount, results };
  }

  /**
   * 批量散客建单：选一个航班班次 + 舱位，名单里每位乘客各成一单（FLIGHT × 1）。
   * 录入人即登录账号 —— 联系人/电话默认取登录用户（displayName / phone），
   * 「系统谁录的就找谁」；body 仍可显式传 contactName/contactPhone 覆盖（兼容旧前端）。
   * 逐单复用 createOrder（含动态定价 / 原子扣座 / 订单号），单条失败不影响其余，逐行返回结果。
   */
  async batchCreateOrders(
    body: BatchCreateOrdersBody,
    requester: OrderRequester,
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{
      index: number;
      passengerName: string;
      success: boolean;
      orderId?: string;
      orderNumber?: string;
      error?: string;
    }>;
  }> {
    const hasDiscount = body.discountPerPersonCny !== undefined && body.discountPerPersonCny > 0;
    if (body.discountPerPersonCny !== undefined && body.discountPerPersonCny > 20_000) {
      throw new BadRequestError('单人优惠不能超过 ¥20000');
    }
    if (body.manualUnitPriceCny !== undefined && hasDiscount) {
      throw new BadRequestError('优惠与手动结算单价二选一');
    }
    if (body.settlementPriceCny !== undefined && hasDiscount) {
      throw new BadRequestError('优惠与团队议价结算价二选一');
    }
    // OTA 手动结算单价权限（服务端按认证身份判，不信前端；与 createOrder 的 priceAdjustment 同口径）：
    // 仅 ADMIN/STAFF 可用，散客/AGENT 携带一律 400。放在最顶端（早于任何 prisma 调用）→ 未触库即拒。
    if (
      body.manualUnitPriceCny !== undefined &&
      requester.role !== UserRole.ADMIN &&
      requester.role !== UserRole.STAFF
    ) {
      throw new BadRequestError('无权手动录入结算单价');
    }
    if (
      hasDiscount &&
      requester.role !== UserRole.ADMIN &&
      requester.role !== UserRole.STAFF
    ) {
      throw new BadRequestError('无权录入优惠');
    }

    // R7 批量重试幂等：整批共享一个 batchId（前端每次提交生成；缺省则后端生成一个同批共享）。
    // 每张子单据此派生稳定幂等键 `batch:{batchId}:{index}`，透传给 createOrder 复用其幂等回放——
    // 整批 HTTP 重试/双击时同批重复提交，每子单只建一次、绝不重复建单/双占座（尤其 BUNDLE 批、
    // allowDuplicate 批无查重兜底时）。前端传 batchId 才能跨请求重试防重；后端兜底只防同一请求内。
    const batchId = body.batchId ?? `bc-${randomUUID()}`;

    // 联系人口径（B9，2026-07-17）：批量单是「每人一单」，子单联系人默认落**该单乘客本人**——
    // 「联系人」列回答的是「航变/接送/售后该找哪个客人」，不是「谁录的单」（录入人在审计里）。
    // 显式传 body.contactName 仍最优先（真有统一领队联系人时用）；录入人只作最后兜底。
    // Order.contactName/contactPhone 是非空列，createOrder 又要求 min(1)，故需落具体值。
    const recorder = await prisma.user.findUnique({
      where: { id: requester.userId },
      select: { displayName: true, email: true, phone: true },
    });
    const recorderName = recorder?.displayName ?? recorder?.email ?? '系统录入';
    const contactPhone = body.contactPhone ?? recorder?.phone ?? '-';

    // 团期备注：写入每张子单的 notes（与既有 notes 合并）+ noteSpecial（结构化「特殊」栏）。
    const mergedNotes = [body.notes, body.groupNote].filter(Boolean).join(' · ') || undefined;
    const mergedNoteSpecial = [body.noteSpecial, body.groupNote].filter(Boolean).join(' · ') || undefined;

    // 重复乘客校验（整批先查，命中则整批拒绝，不产生部分建单）：
    // 1) 名单内证件号重复；2) 与同班次「占座中」订单的乘客证件号重复
    const seenDocs = new Set<string>();
    const dupInBatch = new Set<string>();
    for (const px of body.passengers) {
      if (seenDocs.has(px.documentNumber)) dupInBatch.add(px.documentNumber);
      seenDocs.add(px.documentNumber);
    }
    if (dupInBatch.size > 0) {
      throw new BadRequestError(`名单内证件号重复：${[...dupInBatch].join('、')}`);
    }
    // 产品类型分支（B5）：FLIGHT_ONEWAY/ROUNDTRIP 走班次扣座 + 同航班查重；
    // BUNDLE 的机票航段在 createOrder 内部派生（前台拆 FLIGHT 行），这里跳过基于班次的查重。
    // 向后兼容：缺省/旧调用（只传 flightScheduleId）= FLIGHT_ONEWAY。
    const productType = body.productType ?? 'FLIGHT_ONEWAY';
    const outbound = body.outboundScheduleId ?? body.flightScheduleId;
    // 同航班重复乘客查重：单程 [outbound]；往返 [outbound, return]；BUNDLE 不参与（无班次）。
    // filter(Boolean) 防止把 undefined 传进查重（assertNoDuplicate... 空数组直接 return）。
    const dedupScheduleIds =
      productType === 'BUNDLE'
        ? []
        : ([outbound, productType === 'FLIGHT_ROUNDTRIP' ? body.returnScheduleId : undefined].filter(
            (id): id is string => Boolean(id),
          ) as string[]);
    // 重复乘客强录：仅 ADMIN/STAFF 生效（AGENT 携带此 flag 无效，整批照旧拦）。
    // 放行时整批预检不抛，改由逐单 createOrder 各自查重 + 审计 + 备注留痕（透传同一 flag）。
    const allowDuplicatePassengers =
      body.allowDuplicatePassengers === true &&
      (requester.role === UserRole.ADMIN || requester.role === UserRole.STAFF);
    await this.assertNoDuplicatePassengersOnFlights(
      dedupScheduleIds,
      body.passengers.map((px) => px.documentNumber),
      allowDuplicatePassengers,
    );

    // BUNDLE（P0-4）：批量套餐子单要像前台商城/单笔录单一样拆出机票航段行才会真正扣座 + 进票务，
    // 且房控/销控要计入套餐占房（盖酒店房型 + 入住日期）。二者都需要一个「出发日期」：
    //   出发日期 = body.bundleDepartDate（批量弹窗输入，优先）→ 回落 bundle.defaultDepartDate。
    // 据出发日期匹配套餐绑定航班的当日班次，得到去/回程 FLIGHT 行（bundleFlightLegs）+ 房控盖章日期（bundleDates）。
    // 优雅失败（不阻断整批）：套餐未绑航班 / 当日无班次 / 出发日期缺失 → 记 bundleLegResolutionError，
    //   由下方逐单循环让每张子单以该原因失败（座位账诚实：宁可整批失败也不落零座位套餐单）。
    let bundleDates: { goDate?: string; returnDate?: string } = {};
    let bundleFlightLegs: BundleFlightLeg[] = [];
    let bundleBusinessUpgradeCnyPerLeg: number | null | undefined;
    let bundleLegResolutionError: string | null = null;
    if (productType === 'BUNDLE' && body.bundleId) {
      const resolved = await this.resolveBundleFlightLegs(
        body.bundleId,
        body.bundleDepartDate,
        body.bundleNights,
      );
      if (!resolved.ok) {
        bundleLegResolutionError = resolved.error;
      } else {
        bundleFlightLegs = resolved.legs;
        bundleDates = resolved.dates;
        bundleBusinessUpgradeCnyPerLeg = resolved.businessUpgradeCnyPerLeg;
      }
    }

    // 先按每张子单真实出行人数复核优惠总额，再进入逐单 createOrder，避免前几张已建单后
    // 才发现后续乘客的优惠超过调价上限。BUNDLE 口径与日历取价一致：成人+儿童+婴儿。
    if (hasDiscount && !bundleLegResolutionError) {
      for (const passenger of body.passengers) {
        const ageCounts =
          productType === 'BUNDLE'
            ? deriveBatchBundlePassengerCounts(passenger.dateOfBirth, bundleDates.goDate)
            : { adultCount: 1, childCount: 0, infantCount: 0 };
        const travelPax =
          productType === 'BUNDLE'
            ? resolveBundleOccupancy({ ...ageCounts, quantity: 1 }).headCount
            : 1;
        const discountCny = body.discountPerPersonCny! * travelPax;
        if (discountCny > PRICE_ADJUSTMENT_CAP_CNY) {
          throw new BadRequestError('优惠金额超过调整上限，请核对优惠金额');
        }
      }
    }

    // 按 productType 构造非套餐子单的 items（机票项与乘客无关，循环外算一次）。
    // BUNDLE 的地面行包含单住/升舱/年龄计数，必须在逐人循环内按本行乘客构造。
    //   FLIGHT_ONEWAY   → 1 条 FLIGHT（outbound）
    //   FLIGHT_ROUNDTRIP→ 2 条 FLIGHT（去程 outbound + 返程 return），均同舱位
    //   BUNDLE          → 去/回程 FLIGHT 航段行（扣座 + 进票务）+ 1 条地面 BUNDLE 行（服务端重算地面价 +
    //                      盖酒店房型/入住日期到订单行 → 房控/销控自动计入套餐占房）。
    // 套餐航段解析失败时 bundleFlightLegs 为空、构造结果只含地面行 —— 但循环不会用它（下方逐单短路失败），
    // 故此处不因空航段抛错（保持纯函数「按输入拼装」语义）。
    const commonBatchItems: OrderItemInput[] | undefined =
      productType === 'BUNDLE'
        ? undefined
        : buildBatchItems(body, productType, outbound, bundleDates, bundleFlightLegs);

    const results: Array<{
      index: number;
      passengerName: string;
      success: boolean;
      orderId?: string;
      orderNumber?: string;
      error?: string;
    }> = [];
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < body.passengers.length; i++) {
      const passenger = body.passengers[i];
      // 套餐航段解析失败（未绑航班 / 当日无班次 / 缺出发日期）→ 每张子单以该原因失败（不阻断整批、
      // 不落零座位套餐单）。原因整批一致（套餐 + 出发日期是整批共享的），逐单回报便于前端按行展示。
      if (bundleLegResolutionError) {
        results.push({
          index: i,
          passengerName: passenger.fullName,
          success: false,
          error: bundleLegResolutionError,
        });
        failureCount += 1;
        continue;
      }
      try {
        const isBundle = productType === 'BUNDLE';
        const ageCounts = isBundle
          ? deriveBatchBundlePassengerCounts(passenger.dateOfBirth, bundleDates.goDate)
          : { adultCount: 1, childCount: 0, infantCount: 0 };
        if (isBundle && ageCounts.infantCount === 1) {
          throw new BadRequestError('婴儿不占座不占房，请在单笔录单中与同行成人同单录入');
        }
        if (isBundle && passenger.businessUpgrade === true && bundleBusinessUpgradeCnyPerLeg === 0) {
          throw new BadRequestError('该套餐不提供升舱');
        }
        const passengerForOrder = isBundle
          ? {
              ...passenger,
              passengerType:
                ageCounts.adultCount === 1
                  ? PassengerType.ADULT
                  : ageCounts.childCount === 1
                    ? PassengerType.CHILD
                    : PassengerType.INFANT,
            }
          : passenger;
        const batchItems =
          commonBatchItems ??
          buildBatchItems(body, productType, outbound, bundleDates, bundleFlightLegs, {
            ...ageCounts,
            singleRoom: passenger.singleRoom,
            businessUpgrade: passenger.businessUpgrade,
            designatedHotelRoomTypeId: passenger.designatedHotelRoomTypeId,
            designatedHotelStarMismatchReason: passenger.designatedHotelStarMismatchReason,
          });

        // OTA 手动结算价按每张子单的实际权威价计算；BUNDLE 的生日/行级选项可能使各子单系统价不同。
        let manualPriceAdjustment: PriceAdjustmentInput | undefined;
        if (body.manualUnitPriceCny !== undefined) {
          const priced = await this.priceAndValidateItems(batchItems, undefined, [passengerForOrder], true);
          const systemTotal = priced.reduce((sum, p) => sum + p.amount, 0);
          if (systemTotal > 0 && body.manualUnitPriceCny < systemTotal * 0.1) {
            throw new BadRequestError(
              `OTA 结算单价 ¥${body.manualUnitPriceCny}/人 低于系统参考价 ¥${Math.round(systemTotal)} 的 10%，` +
                '疑似录入错误已拒绝。如确为特批价，请先调整产品定价或联系管理员走结算价通道。',
            );
          }
          const diff = Math.round(body.manualUnitPriceCny - systemTotal);
          if (diff !== 0) {
            const pct = systemTotal > 0 ? Math.round((body.manualUnitPriceCny / systemTotal) * 100) : null;
            manualPriceAdjustment = {
              amountCny: diff,
              reasonCode: diff > 0 ? 'MISC_FEE' : 'DISCOUNT',
              reasonText:
                `OTA 结算价 ¥${body.manualUnitPriceCny}/人` +
                (pct !== null && (pct < 50 || pct > 200) ? `（系统参考价 ¥${Math.round(systemTotal)} 的 ${pct}%，请复核）` : ''),
            };
          }
        }

        // 批量优惠按每张子单的真实出行人数生成独立 DISCOUNT 调整行。
        // BUNDLE 口径取 headCount（成人 + 儿童 + 婴儿），与结算价日历一致；非套餐批量每张子单一位乘客。
        let discountAdjustment: PriceAdjustmentInput | undefined;
        if (hasDiscount) {
          const bundleItem = batchItems.find(
            (item): item is Extract<OrderItemInput, { kind: 'BUNDLE' }> => item.kind === 'BUNDLE',
          );
          const travelPax = bundleItem
            ? resolveBundleOccupancy(bundleItem).headCount
            : 1;
          const discountCny = body.discountPerPersonCny! * travelPax;
          if (discountCny > PRICE_ADJUSTMENT_CAP_CNY) {
            throw new BadRequestError('优惠金额超过调整上限，请核对优惠金额');
          }
          discountAdjustment = {
            amountCny: -discountCny,
            reasonCode: 'DISCOUNT',
            reasonText: `同业优惠 ¥${body.discountPerPersonCny}/人×${travelPax}`,
            stackWithSettlementCalendar: true,
          };
        }

        const order = await this.createOrder(
          {
            // 联系人=本单乘客（body 显式传联系人则整批统一用它；录入人仅兜底）。
            contactName: body.contactName ?? passenger.fullName ?? recorderName,
            contactPhone,
            contactEmail: body.contactEmail,
            paymentMethod: body.paymentMethod,
            // 该乘客个别备注（选填）叠加整批备注，合并写入本人订单 notes；无个别备注则只落整批备注。
            notes: [passenger.note, mergedNotes].filter(Boolean).join(' · ') || undefined,
            // 签证状态 + 结构化备注四栏（整批共用，写入每张子单）
            visaStatus: body.visaStatus,
            noteHotel: body.noteHotel,
            noteVisa: body.noteVisa,
            notePayment: body.notePayment,
            // 团期备注同时写入结构化「特殊」栏
            noteSpecial: mergedNoteSpecial,
            // 整批归属代理（ADMIN/STAFF 录单）；AGENT 自助仍归属本人。
            agentId: body.agentId,
            // 团队议价结算价（CNY/人）覆盖机票动态价；仅 ADMIN/STAFF（路由层已断言）。
            // 仅作用于 FLIGHT 行；BUNDLE 走 createOrder 的 server-priced 套餐定价，此值对其无效。
            flightSettlementPriceCny: body.settlementPriceCny,
            // OTA 手动结算单价 → 差额调整行（每单一致；createOrder 再按身份复核权限 + 审计落库）。
            priceAdjustment: manualPriceAdjustment ?? discountAdjustment,
            // 透传重复乘客强录 flag（createOrder 内再按身份收口 + 逐单审计/备注留痕）。
            allowDuplicatePassengers,
            // R7：稳定幂等键 `batch:{batchId}:{index}` → createOrder 幂等回放（整批重试每子单只建一次）。
            idempotencyKey: `batch:${batchId}:${i}`,
            items: batchItems,
            passengers: [passengerForOrder],
          },
          requester,
        );
        results.push({
          index: i,
          passengerName: passenger.fullName,
          success: true,
          orderId: order.id,
          orderNumber: order.orderNumber,
        });
        successCount += 1;
      } catch (err) {
        results.push({
          index: i,
          passengerName: passenger.fullName,
          success: false,
          error: err instanceof Error ? err.message : '未知错误',
        });
        failureCount += 1;
      }
    }

    return { successCount, failureCount, results };
  }

  /**
   * 批量套餐子单的机票航段解析（P0-4）：按套餐绑定航班 + 出发日期匹配当日班次，
   * 返回去/回程 FLIGHT 航段（供注入子单 items 真正扣座）+ 房控盖章日期。
   *
   * 口径（后端版，按套餐绑定航班的实际航线，不硬编码具体航线）：
   *   - 出发日期 depart = bundleDepartDate（批量弹窗输入，优先）→ 回落 bundle.defaultDepartDate。缺失 → 优雅失败。
   *   - 去程：套餐必须绑定 outboundFlightId（Flight = 航班号）；在其班次池里挑「本地出发日 == depart」的班次
   *     （按 departureTime 升序取当日最早一班；本地日期按班次 departureTz 算，与前台可售日期同口径）。无匹配 → 优雅失败。
   *   - 回程（往返套餐 legs≥2）：returnDate = depart + 住宿晚数（resolveBundleNights，与酒店退房日同源）；
   *     套餐必须绑定 returnFlightId，在其班次池里挑「本地出发日 == returnDate」的班次。无匹配 → 优雅失败。
   *   - 房控盖章：goDate = depart；returnDate（退房日）= depart + 晚数（无论单程/往返都据此盖酒店退房章）。
   *
   * 只读（findMany），不落库、不扣座；真正的扣座 + 盖章由逐单 createOrder 的既有链路完成。
   * 返回 { error } 表示优雅失败（调用方逐单以该原因失败，不阻断整批）；成功则返回 { legs, dates }。
   */
  private async resolveBundleFlightLegs(
    bundleId: string,
    bundleDepartDate: string | undefined,
    bundleNightsOverride: number | undefined,
  ): Promise<
    | { ok: false; error: string }
    | {
        ok: true;
        legs: BundleFlightLeg[];
        dates: { goDate?: string; returnDate?: string };
        businessUpgradeCnyPerLeg: number | null;
      }
  > {
    const bundle = await prisma.bundle.findUnique({
      where: { id: bundleId },
      select: {
        defaultDepartDate: true,
        hotelNights: true,
        items: true,
        legs: true,
        businessUpgradeCnyPerLeg: true,
        outboundFlightId: true,
        returnFlightId: true,
      },
    });
    if (!bundle) {
      return { ok: false, error: `套餐 ${bundleId} 不存在` };
    }

    const departDate = bundleDepartDate ?? bundle.defaultDepartDate ?? undefined;
    if (!departDate) {
      return {
        ok: false,
        error: '套餐缺少出发日期：请在批量弹窗填写「出发日期」，或为该套餐配置默认出发日期',
      };
    }
    if (!bundle.outboundFlightId) {
      return { ok: false, error: '套餐未绑定航班，无法自动匹配机票航段并占座' };
    }

    const nights = Math.max(1, Math.trunc(bundleNightsOverride ?? resolveBundleNights(bundle.items, bundle.hotelNights)));
    const isRoundTrip = (bundle.legs ?? 2) >= 2;
    // 退房/回程日期 = 出发日 + 晚数（单程套餐也据此盖酒店退房章）。
    const returnDate = addDaysToYmd(departDate, nights);

    // 去程班次：套餐绑定航班号的班次池里，挑本地出发日 == departDate 的当日最早一班。
    const goScheduleId = await this.matchBundleScheduleByLocalDate(bundle.outboundFlightId, departDate);
    if (!goScheduleId) {
      return {
        ok: false,
        error: `所选出发日期 ${departDate} 没有匹配的去程班次，请更换日期或先在航班里建当日班次`,
      };
    }
    const legs: BundleFlightLeg[] = [{ scheduleId: goScheduleId, label: '去程' }];

    if (isRoundTrip) {
      if (!bundle.returnFlightId) {
        return { ok: false, error: '往返套餐未绑定回程航班，无法自动匹配回程班次并占座' };
      }
      const retScheduleId = await this.matchBundleScheduleByLocalDate(bundle.returnFlightId, returnDate);
      if (!retScheduleId) {
        return {
          ok: false,
          error: `回程日期 ${returnDate} 没有匹配的回程班次，请核对套餐晚数/排班`,
        };
      }
      legs.push({ scheduleId: retScheduleId, label: '回程' });
    }

    return {
      ok: true,
      legs,
      dates: { goDate: departDate, returnDate },
      businessUpgradeCnyPerLeg: bundle.businessUpgradeCnyPerLeg,
    };
  }

  /**
   * 在某航班号（Flight）的班次池里挑「本地出发日 == 目标日期」的班次 id（当日最早一班）。
   * 本地日期按班次自身 departureTz 计算（与前台可售日期 / SingleOrderModal 同口径），
   * 绝不用 UTC slice（会跨日错位）。只取 isActive 班次；无匹配返回 null（调用方优雅失败）。
   */
  private async matchBundleScheduleByLocalDate(
    flightId: string,
    targetYmd: string,
  ): Promise<string | null> {
    const schedules = await prisma.flightSchedule.findMany({
      where: { flightId, isActive: true },
      select: { id: true, departureTime: true, departureTz: true },
      orderBy: { departureTime: 'asc' },
    });
    const match = schedules.find((s) => localDate(s.departureTime, s.departureTz) === targetYmd);
    return match?.id ?? null;
  }

  /**
   * B4 改结算价（路由层限 ADMIN/STAFF）：建单后订正某条 FLIGHT / HOTEL 行的结算价。
   * 仅允许 kind ∈ {FLIGHT, HOTEL}；事务内把 item.unitPrice 设为新价、按该 kind 的计价口径
   * 重算 amount，再用所有订单行重算 order.subtotal/total（taxesAndFees/discountTotal 不动）。
   *
   * 计价口径（与建单一致，见 computeGroundItemAmounts）：
   *   - FLIGHT：unitPrice = 每张票价，amount = unitPrice × quantity（quantity=张数）。
   *   - HOTEL ：unitPrice = 每间每晚价，amount = unitPrice × quantity × roomsBilled
   *             （quantity=晚数，roomsBilled 可为 0.5 拼房；缺省按 1 间）。
   *             漏乘房数会让多间/拼房的单订酒店单直接算错金额，故必须带上这个乘数。
   *
   * 这是「基础价订正」，不走 adjustmentCny（那是售后费用，改期费/换人费才用）。
   * 尾款（serializeOrder 的 balanceDue = total + adjustmentCny − paidAmount − prepaymentOffset）随 total 自然更新。
   * 不动 quantity / flightScheduleId / flightCabin / 库存（扣座与本订正无关）。
   * 返回 serializeOrder（含审计用的 before/after，由路由层 writeAudit 落库）。
   */
  async updateItemSettlementPrice(
    orderId: string,
    itemId: string,
    input: UpdateItemSettlementPriceBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    /** B12：已付款单改价的资金后果提示（多付/新尾款）+ 已计提佣金提示；均无后果时 null。*/
    warning: string | null;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: { unitPrice: string; amount: string; subtotal: string; total: string };
      after: { unitPrice: string; amount: string; subtotal: string; total: string };
      reason?: string;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可改结算价');
    }
    const unitPriceCny = input.unitPriceCny;

    const scratch = await prisma.$transaction(async (tx) => {
      // FOR UPDATE 行锁：改结算价要「读所有 items → 重算 subtotal/total → 写回 Order」，
      // 无锁时两个并发请求改同一单的**不同 item**，会各自从自己的陈旧 items 快照重算，
      // 后写者覆盖前写者 → order.total 丢掉一个 item 的改价，而 orderItem.amount 两条都已落库
      // → total ≠ Σ items（而 total 正是取消手续费/应退额的基数）。
      // 与多付转存 / 挂账池 / 到账入账（均先对 Order 行 FOR UPDATE）同一把锁，天然互斥。
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          status: OrderStatus;
          deletedAt: Date | null;
          subtotal: Prisma.Decimal;
          total: Prisma.Decimal;
          paidAmount: Prisma.Decimal;
          outboundInvoiced: boolean;
          returnInvoiced: boolean;
          systemInvoiced: boolean;
          settlementLocked: boolean;
        }>
      >`SELECT id, "orderNumber", status, "deletedAt", subtotal, total, "paidAmount", "outboundInvoiced", "returnInvoiced", "systemInvoiced", "settlementLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = rows[0];
      if (!order) throw new NotFoundError('订单不存在');
      if (order.settlementLocked) {
        throw new ConflictError('结算价已锁定，请先解锁再修改');
      }
      // 资金处置闸：结算价直接改 item.amount 与 order.total（也是取消手续费基数），
      // 死单/软删单不许改——否则可在退款前偷偷抬价操纵应退额，或改回收站单的应收。
      assertOrderAllowsFundsDisposal(order, '修改结算价');
      // 开票闸（B12）：任一维度已开票后改结算价，发票金额与订单金额必然脱钩——
      // 发票是已交付下游的凭证，改价必须先冲开票状态（票务台改回未开）、改完价再重开。
      if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
        throw new BadRequestError(
          '该订单已有开票记录（去程/回程/系统任一已开），改结算价会使发票与订单金额不一致。' +
            '请先在票务台把对应开票状态改回「未开」，改价后再重新开票。',
        );
      }

      // 锁**之后**才读 items：锁之前读到的快照可能已被并发改价写脏，拿它重算等于锁了个寂寞。
      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: {
          id: true,
          kind: true,
          quantity: true,
          unitPrice: true,
          amount: true,
          // HOTEL 行的 amount 乘数（每间每晚价 × 晚数 × 房数）；FLIGHT 行为 null，不参与计算。
          roomsBilled: true,
        },
      });
      const target = items.find((it) => it.id === itemId);
      if (!target) {
        throw new NotFoundError('订单项不存在或不属于该订单');
      }
      if (target.kind !== OrderItemKind.FLIGHT && target.kind !== OrderItemKind.HOTEL) {
        throw new BadRequestError('只能对机票行（FLIGHT）或酒店行（HOTEL）改结算价');
      }

      const beforeUnitPrice = target.unitPrice.toString();
      const beforeAmount = target.amount.toString();
      // 房数乘数：仅 HOTEL 行有（roomsBilled 可为 0.5 拼房，缺省按 1 间——与建单同口径）。
      const roomsMultiplier =
        target.kind === OrderItemKind.HOTEL && target.roomsBilled != null
          ? Number(target.roomsBilled.toString())
          : 1;
      const newAmount = round2(unitPriceCny * target.quantity * roomsMultiplier);

      await tx.orderItem.update({
        where: { id: itemId },
        data: {
          unitPrice: new Prisma.Decimal(unitPriceCny),
          amount: new Prisma.Decimal(newAmount),
        },
      });

      // 锁内从库**重新聚合**最新 items 算 subtotal/total —— 不用锁之前那份内存快照。
      // 本次 orderItem.update 已落在同一事务里，故聚合结果天然含新 amount；
      // 同时也吃到了「本事务拿到锁之前、其它事务已提交」的所有改动（并发改另一行 / 补房差新增 FEE 行），
      // 不会像旧的内存快照 reduce 那样把它们算回旧值再写回去（后写覆盖前写）。
      const sumAgg = await tx.orderItem.aggregate({
        where: { orderId },
        _sum: { amount: true },
      });
      const newSubtotal = Number((sumAgg._sum.amount ?? new Prisma.Decimal(0)).toString());
      const newTotal = round2(newSubtotal); // 当前无 taxes/discount，total = subtotal

      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(round2(newSubtotal)),
          total: new Prisma.Decimal(newTotal),
        },
        select: { subtotal: true, total: true },
      });

      // 佣金后果提示：佣金在订单转 PAID 时按当时的价格基数一次性计提，改结算价**不重算佣金**，
      // 且计提幂等键按（订单, productKind）不区分状态 —— 补提也会被判成"已提过"而永久锁死。
      // 本次只做可见性：把「已计提多少」明明白白摆到操作者面前 + 留一条 WARNING 审计，
      // 让财务自己决定要不要人工调整。真正的重算/幂等键收口是独立议题，不在此处顺手改。
      const accruedCommissions = await tx.commissionRecord.findMany({
        where: {
          orderId,
          status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] },
        },
        select: { amount: true },
      });
      const accruedCommissionCny = round2(
        accruedCommissions.reduce((s, c) => s + Number(c.amount.toString()), 0),
      );
      const commissionWarning =
        accruedCommissions.length > 0
          ? `本单已计提佣金 ¥${accruedCommissionCny}，价格基数已变更，请财务确认是否调整。`
          : null;

      // 已付资金后果（B12）：改价后 total 变、paidAmount 不变 —— 把差额算清楚交给运营处置，
      // 不再让「total ≠ 已收」静默存在。多付走既有多付处置（转余额/挂账/退款），欠款去催收。
      const paid = Number(order.paidAmount.toString());
      let warning: string | null = null;
      if (paid > 0) {
        const gap = round2(newTotal - paid);
        if (gap < 0) {
          warning =
            `该单已收 ¥${paid}，改价后应收 ¥${newTotal}，形成多付 ¥${Math.abs(gap)}。` +
            '请在订单资金区做多付处置（转代理余额 / 转挂账池 / 退款）。';
        } else if (gap > 0 && (order.status === OrderStatus.PAID || order.status === OrderStatus.PROCESSING || order.status === OrderStatus.TICKETED || order.status === OrderStatus.COMPLETED)) {
          warning =
            `该单状态为已付款族（${zhStatus(order.status)}）但改价后新增尾款 ¥${gap}（已收 ¥${paid} / 应收 ¥${newTotal}）。` +
            '请补收该差额或确认本次改价金额无误。';
        }
      }
      // 佣金提示与资金提示并列返回：两件事互不覆盖（可能同时成立）。
      warning = [warning, commissionWarning].filter(Boolean).join(' ') || null;

      return {
        orderNumber: order.orderNumber,
        beforeUnitPrice,
        beforeAmount,
        beforeSubtotal: order.subtotal.toString(),
        beforeTotal: order.total.toString(),
        afterUnitPrice: unitPriceCny,
        afterAmount: newAmount,
        afterSubtotal: updated.subtotal.toString(),
        afterTotal: updated.total.toString(),
        warning,
        accruedCommissionCny: accruedCommissions.length > 0 ? accruedCommissionCny : null,
      };
    });

    // 改价撞上已计提佣金 → 单独留一条 WARNING 审计（路由层那条改价审计是 INFO 级，
    // 淹没在日常改价里翻不出来）。await 而非 fire-and-forget：与录单调价/结算总价同口径，
    // 佣金基数漂移是财务要复核的事，落审计后再返回。
    if (scratch.accruedCommissionCny !== null) {
      await writeAudit({
        actor: { userId: actor.userId, role: actor.role },
        action: 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION',
        targetType: 'ORDER',
        targetId: orderId,
        targetLabel: scratch.orderNumber,
        before: { total: scratch.beforeTotal, accruedCommissionCny: scratch.accruedCommissionCny },
        after: {
          total: scratch.afterTotal,
          orderItemId: itemId,
          // 佣金不随改价重算，这条审计就是「基数已变、佣金没动」的留痕。
          commissionRecalculated: false,
          reason: input.reason ?? null,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      // 对外脱敏：改结算价的返回也按操作者角色脱敏（ADMIN/STAFF 全量，其余剥离内部字段 + 逐项拆价）。
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      warning: scratch.warning,
      audit: {
        orderNumber: scratch.orderNumber,
        orderItemId: itemId,
        before: {
          unitPrice: scratch.beforeUnitPrice,
          amount: scratch.beforeAmount,
          subtotal: scratch.beforeSubtotal,
          total: scratch.beforeTotal,
        },
        after: {
          unitPrice: String(scratch.afterUnitPrice),
          amount: String(scratch.afterAmount),
          subtotal: scratch.afterSubtotal,
          total: scratch.afterTotal,
        },
        reason: input.reason,
      },
    };
  }

  // 旧的「订单级开票状态」写入口（setInvoiceStatus / PATCH /orders/:id/invoice-status）已删除
  // （0716 H11b）：它是六态开票改造前的遗留，与现口径是两本账 ——
  //   · 不走 assertOrderAllowsInvoicing（取消族/回收站单照样能标开票）；
  //   · 写进的 Order.invoiceStatus 现在无人读：开票额度（ticketing-cap）、导出、财务口径
  //     全部改看三个布尔位（outboundInvoiced / returnInvoiced / systemInvoiced）。
  // 唯一写入口是 setInvoiceFlags（PATCH /orders/:id/invoice-flags）。数据列 invoiceStatus 保留
  //（存量数据 + 换人 resetInvoice 仍会把它归零），只是不再有单独的写接口。

  /**
   * 设置六态开票的三个布尔位（路由层限 ADMIN/STAFF）：去程 / 回程 / 系统 各自独立。
   *
   * 两道闸，都只在「从未开翻成已开」（false → true）时生效（翻回未开 / 无变化一律放行——
   * 死单纠错撤销错标记应当允许）：
   *   1. 订单状态闸（assertOrderAllowsInvoicing）：取消族（DRAFT/CANCELLED/PAYMENT_TIMEOUT/
   *      REFUNDED/FAILED）与软删单不许标开票 → 400。口径「能标开票」⟺「占额度」，
   *      与算额度复用同一份 COUNTED_STATUSES，两处不可能分叉。三个位都过这道闸。
   *   2. 班次开票上限（assertTicketingCap）：只校验正在翻开的那个航段对应的班次 → 超限 422。
   *      systemInvoiced 不占班次额度、不校验（但仍过状态闸）。
   *
   * 去程/回程班次由订单 FLIGHT 行按 departureTime 升序判定（determineFlightLegs）。
   * 校验 + 更新同包一个事务，缩小并发开票越限窗口。
   */
  async setInvoiceFlags(
    id: string,
    flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean },
  ): Promise<{
    id: string;
    orderNumber: string;
    outboundInvoiced: boolean;
    returnInvoiced: boolean;
    systemInvoiced: boolean;
  }> {
    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          orderNumber: true,
          status: true,
          deletedAt: true,
          outboundInvoiced: true,
          returnInvoiced: true,
          systemInvoiced: true,
          passengers: { select: { passengerType: true } },
          items: {
            where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            select: {
              flightScheduleId: true,
              flightSchedule: { select: { departureTime: true, departureTz: true } },
            },
          },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // 本单要占的开票**座位**数：婴儿有票无座，不占库存 —— 必须与计数侧
      //（countIssuedPassengers 同样跳过 INFANT）严格同口径。此前这里传的是含婴儿的总人数，
      // 于是每个带婴儿的订单都比它实际占的座多算一个，班次快满时会把合法开票误判成超限。
      const seatPassengerCount = order.passengers.filter(
        (p) => p.passengerType !== PassengerType.INFANT,
      ).length;

      // 开票标记状态闸：只挡「翻成已开」（false → true）——取消族/软删单不占班次额度，
      // 标了开票位对 191 上限完全隐形，却会进导出、让财务口径失真（见 assertOrderAllowsInvoicing）。
      // 翻回「未开」不挡：死单纠错撤销错标记应当允许（与资金闸「只挡进钱不挡退钱」同构）。
      const turningAnyFlagOn =
        (flags.outboundInvoiced === true && !order.outboundInvoiced) ||
        (flags.returnInvoiced === true && !order.returnInvoiced) ||
        (flags.systemInvoiced === true && !order.systemInvoiced);
      if (turningAnyFlagOn) assertOrderAllowsInvoicing(order);

      const { outboundScheduleId, returnScheduleId } = determineFlightLegs(order.items);

      // 去程：从 false → true 且有去程班次时校验该班次上限
      if (flags.outboundInvoiced === true && !order.outboundInvoiced && outboundScheduleId) {
        await assertTicketingCap(tx, [outboundScheduleId], seatPassengerCount);
      }
      // 回程：从 false → true 且有回程班次时校验该班次上限
      if (flags.returnInvoiced === true && !order.returnInvoiced && returnScheduleId) {
        await assertTicketingCap(tx, [returnScheduleId], seatPassengerCount);
      }

      return tx.order.update({
        where: { id },
        data: {
          ...(flags.outboundInvoiced !== undefined && { outboundInvoiced: flags.outboundInvoiced }),
          ...(flags.returnInvoiced !== undefined && { returnInvoiced: flags.returnInvoiced }),
          ...(flags.systemInvoiced !== undefined && { systemInvoiced: flags.systemInvoiced }),
        },
        select: {
          id: true,
          orderNumber: true,
          outboundInvoiced: true,
          returnInvoiced: true,
          systemInvoiced: true,
        },
      });
    });

    // ── TICKETED 派生·反向自动（2026-07-20 拍板「合一」）：航段标记翻齐 → 订单自动推进 ──
    // 票务台标完最后一段，订单从 PROCESSING 自动进「出票完成」，运营不用再手动改一次状态。
    // 只在 PROCESSING 时推（PAID 还没进处理、其它状态不该被开票动作牵着走）；
    // 推进失败绝不回滚开票标记（标记是事实，状态推进只是跟随），静默放过。
    try {
      const after = await prisma.order.findUnique({
        where: { id },
        select: {
          status: true,
          outboundInvoiced: true,
          returnInvoiced: true,
          items: {
            where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            select: { flightScheduleId: true },
          },
        },
      });
      if (after && after.status === OrderStatus.PROCESSING) {
        const legCount = new Set(after.items.map((it) => it.flightScheduleId)).size;
        const legsDone =
          legCount >= 1 &&
          after.outboundInvoiced &&
          (legCount < 2 || after.returnInvoiced);
        if (legsDone) {
          await this.updateStatus(
            id,
            OrderStatus.TICKETED,
            // 系统调用者的两个标识都给全（缺一不可，且互为兜底）：
            //   · actorType:'SYSTEM' —— _updateStatusWithinTx 判定系统调用者的**显式**依据；
            //   · userId 前缀 'system-' —— 同一处判定的字符串兜底口径（连字符，不是冒号）。
            // 判定为系统调用者后，OrderStatusEvent.actorUserId 才会写 null。写成非系统调用者
            // 会拿这个假 userId 去撞 actorUserId → User(id) 外键，P2003 回滚整个推进事务，
            // 而下方 catch 又把异常吞掉 —— 功能会静默失效（用户完全看不见）。
            { userId: 'system-auto-ticketed', role: UserRole.ADMIN, actorType: 'SYSTEM' },
            '航段开票标记齐全，自动推进「出票完成」（TICKETED 派生口径）',
          );
        }
      }
    } catch (err) {
      // 自动推进失败不影响开票标记本身（如并发状态变化），故不回滚、不抛出；
      // 但必须留痕 —— 静默吞掉会让「标齐后订单会自动推进」这句承诺失效而无人察觉。
      // eslint-disable-next-line no-console
      console.error('[orders] failed to auto-advance order to TICKETED for', id, err);
    }

    return updated;
  }

  /**
   * 批量设置六态开票的三个布尔位（票务岗批量操作，ADMIN/STAFF）。
   * 逐单复用 setInvoiceFlags（保持其班次开票上限校验语义不变），每单独立事务，
   * 单单失败（如超班次开票上限）不影响其余单；逐单结果 + 汇总一并返回，
   * 供路由层逐单写审计、前端展示成功/失败清单（失败列出订单号+原因）。
   */
  async batchSetInvoiceFlags(
    ids: string[],
    flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean },
  ): Promise<{
    succeeded: number;
    failed: number;
    results: Array<{
      id: string;
      orderNumber?: string;
      ok: boolean;
      error?: string;
      outboundInvoiced?: boolean;
      returnInvoiced?: boolean;
      systemInvoiced?: boolean;
    }>;
  }> {
    const results: Array<{
      id: string;
      orderNumber?: string;
      ok: boolean;
      error?: string;
      outboundInvoiced?: boolean;
      returnInvoiced?: boolean;
      systemInvoiced?: boolean;
    }> = [];
    let succeeded = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const order = await this.setInvoiceFlags(id, flags);
        results.push({
          id,
          orderNumber: order.orderNumber,
          ok: true,
          outboundInvoiced: order.outboundInvoiced,
          returnInvoiced: order.returnInvoiced,
          systemInvoiced: order.systemInvoiced,
        });
        succeeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        results.push({ id, ok: false, error: message });
        failed += 1;
      }
    }
    return { succeeded, failed, results };
  }

  /**
   * 批量改航班（录入纠错，ADMIN/STAFF）。
   * 航段按订单 FLIGHT 行的班次 departureTime 升序解析，逐单复用单条改期事务；
   * 不传 feeCny / feeLabel，且已出票/已完成订单默认拦截，避免账面班次与真实机票分叉。
   * 每单独立捕获错误，单个班次售罄只影响当前订单。
   */
  async batchReschedule(
    input: BatchRescheduleBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    succeeded: number;
    failed: number;
    results: Array<{
      id: string;
      orderNumber?: string;
      ok: boolean;
      error?: string;
      notice?: string;
      audit?: {
        orderNumber: string;
        orderItemId: string;
        fromScheduleId: string;
        fromCabin: import('@prisma/client').CabinClass;
        fromDeparture: Date | null;
        toScheduleId: string;
        toCabin: import('@prisma/client').CabinClass;
        toDeparture: Date | null;
        feeCny: number;
        statusChanged: boolean;
      };
    }>;
  }> {
    const results: Array<{
      id: string;
      orderNumber?: string;
      ok: boolean;
      error?: string;
      notice?: string;
      audit?: {
        orderNumber: string;
        orderItemId: string;
        fromScheduleId: string;
        fromCabin: import('@prisma/client').CabinClass;
        fromDeparture: Date | null;
        toScheduleId: string;
        toCabin: import('@prisma/client').CabinClass;
        toDeparture: Date | null;
        feeCny: number;
        statusChanged: boolean;
      };
    }> = [];
    let succeeded = 0;
    let failed = 0;

    for (const id of input.orderIds) {
      try {
        const { order, audit } = await this.rescheduleOrderItem(
          id,
          {
            leg: input.leg,
            newScheduleId: input.newScheduleId,
            note: input.note,
            guard: { forbidTicketed: !input.allowTicketed, correction: true },
          },
          actor,
        );
        const orderNumber = (order as unknown as { orderNumber?: string }).orderNumber;
        results.push({ id, orderNumber, ok: true, audit });
        succeeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        const context = rescheduleCommittedContext(err);
        let recovered = false;
        if (context) {
          try {
            const currentItem = await prisma.orderItem.findUnique({
              where: { id: context.orderItemId },
              select: {
                orderId: true,
                flightScheduleId: true,
                flightCabin: true,
                order: { select: { orderNumber: true } },
              },
            });
            if (
              currentItem?.orderId === id &&
              currentItem.flightScheduleId === input.newScheduleId
            ) {
              results.push({
                id,
                orderNumber: currentItem.order.orderNumber,
                ok: true,
                notice: '已生效（回包异常）',
                audit: {
                  orderNumber: currentItem.order.orderNumber,
                  orderItemId: context.orderItemId,
                  fromScheduleId: context.oldScheduleId,
                  fromCabin: context.oldCabin,
                  fromDeparture: null,
                  toScheduleId: context.newScheduleId,
                  toCabin: currentItem.flightCabin ?? context.newCabin,
                  toDeparture: null,
                  feeCny: 0,
                  statusChanged: context.statusChanged,
                },
              });
              succeeded += 1;
              recovered = true;
            }
          } catch {
            // 回读失败时按失败返回；原始事务外异常仍保留在 error 中。
          }
        }
        if (!recovered) {
          results.push({ id, ok: false, error: message });
          failed += 1;
        }
      }
    }

    return { succeeded, failed, results };
  }

  /**
   * 批量锁定/解锁订单结算价。不存在或已软删订单不更新并计入 skipped；
   * 每个有效订单独立更新，便于路由层按成功订单逐条写审计。
   */
  async batchSetSettlementLock(
    ids: string[],
    lock: boolean,
    userId: string,
  ): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      id: string;
      orderNumber: string;
      beforeLocked: boolean;
      settlementLockedAt: Date | null;
    }>;
  }> {
    const activeOrders = await prisma.order.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, orderNumber: true, settlementLocked: true },
    });
    const activeById = new Map(activeOrders.map((order) => [order.id, order]));
    const results: Array<{
      id: string;
      orderNumber: string;
      beforeLocked: boolean;
      settlementLockedAt: Date | null;
    }> = [];

    for (const id of ids) {
      const order = activeById.get(id);
      if (!order) continue;
      const settlementLockedAt = lock ? new Date() : null;
      await prisma.order.update({
        where: { id },
        data: {
          settlementLocked: lock,
          settlementLockedAt,
          settlementLockedBy: lock ? userId : null,
        },
      });
      results.push({
        id,
        orderNumber: order.orderNumber,
        beforeLocked: order.settlementLocked,
        settlementLockedAt,
      });
    }

    return { updated: results.length, skipped: ids.length - results.length, results };
  }

  /**
   * 事务内执行状态流转 —— 供 payments.handleCallback 等外部事务复用。
   * 调用方负责包 $transaction 且提交后 enqueue newTaskIdsOut 里的任务。
   */
  async _updateStatusWithinTx(
    tx: Prisma.TransactionClient,
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason: string | undefined,
    newTaskIdsOut: string[],
    force?: boolean,
    releasedSeatClassIdsOut?: string[],
    /**
     * 取消族恢复时被自动清除的开票标记警示语（见下方「取消族恢复：复检班次开票额度」）。
     * 调用方给了数组就能把提示带回给操作者；不给也照样复检、照样清标记（只是没人看见提示）。
     */
    invoiceCapWarningsOut?: string[],
  ) {
    const order = await tx.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    // 软删单（回收站）不设防的破口：findUnique 无 deletedAt 过滤时，ADMIN 可对回收站单
    // force→PAID 造"隐形占座单"（订单显示已支付并重新占座，却从所有列表/统计里消失）。
    // 状态流转入口一律拒绝已软删订单——要操作请先 restoreOrder 恢复。软删本身从不改 status
    // （见 softDeleteOrder），所以这里绝不会误伤任何正常流转。
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可做状态流转；如需操作请先恢复');
    }
    await this.assertCanTransition(order, toStatus, requester);

    const allowed = ALLOWED_TRANSITIONS[order.status];
    // ADMIN 可用 force=true 跳过状态机；其他角色或非 force 调用走标准检查
    const isAdminForce = force === true && requester.role === 'ADMIN';
    if (!allowed.includes(toStatus) && !isAdminForce) {
      // 高频误操作单独给指引：已收款的单不能一键取消——钱账要走退款通道，申请后机位立即释放。
      const cancelPaidHint =
        toStatus === 'CANCELLED' && allowed.includes('REFUND_REQUESTED')
          ? '。已收款订单不能直接取消：请改为「退款申请中」，提交申请后机位立即释放，财务处理完成后订单关闭'
          : '';
      throw new BadRequestError(
        `不允许从「${zhStatus(order.status)}」转移到「${zhStatus(toStatus)}」` +
          `（当前可转：${allowed.map(zhStatus).join('、') || '无'}）${cancelPaidHint}`,
      );
    }

    // ── TICKETED 派生闸（2026-07-20 拍板「合一」）：订单级「出票完成」不再是第二本账——
    // 它是航段开票标记的派生：有航段的单，去程（及往返单的回程）标记没打齐就不许推进。
    // 唯一真源在票务台的航段标记；标记翻齐会自动推进（见 setInvoiceFlags 尾部），
    // 这里的手动推进只在标记已齐时放行。纯地面单（无航段）无票可出，放行不拦。
    // ADMIN force 可跳过（应急通道，审计照记）。
    if (toStatus === OrderStatus.TICKETED && !isAdminForce) {
      const inv = await tx.order.findUnique({
        where: { id },
        select: {
          outboundInvoiced: true,
          returnInvoiced: true,
          items: {
            where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            select: { flightScheduleId: true },
          },
        },
      });
      const legCount = new Set((inv?.items ?? []).map((it) => it.flightScheduleId)).size;
      if (legCount >= 1 && !inv?.outboundInvoiced) {
        throw new BadRequestError(
          '去程尚未标记开票，不能推进到「出票完成」。请先在票务台标记去程已开票——标齐后订单会自动推进。',
        );
      }
      if (legCount >= 2 && !inv?.returnInvoiced) {
        throw new BadRequestError(
          '回程尚未标记开票，不能推进到「出票完成」。请先在票务台标记回程已开票——标齐后订单会自动推进。',
        );
      }
    }

    // ── REFUND_REQUESTED 账目闸（与下方 →REFUNDED 的账目闸对称）────────────────────
    // 状态机把 PAID/PROCESSING/TICKETED/CHANGED/FAILED → REFUND_REQUESTED 全部放行且零校验，
    // 于是「退款申请中」可以是一张**没有任何 Refund 记录**的空壳：座位当场释放、订单从所有
    // 有效口径里消失，却既没有应退报价、也没有可批准的对象 —— 下一步 →REFUNDED 被账目闸拦死，
    // 退回 PROCESSING 又要重新抢座位，这单就此卡住，实收与佣金两头挂着谁也对不平。
    // 口径：进 REFUND_REQUESTED 必须已有一条**未终结**的 Refund（REQUESTED/APPROVED/PROCESSING）。
    // 唯一正门是 POST /orders/:id/cancel —— 它先按取消策略算出应退报价、建 Refund，再推本状态。
    // **admin force 同样拦**：与 →REFUNDED 一致，这是账目完整性，force 是用来跳状态机的，不是跳账的。
    if (toStatus === OrderStatus.REFUND_REQUESTED) {
      const pendingRefundCount = await tx.refund.count({
        where: {
          orderId: id,
          status: {
            in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING],
          },
        },
      });
      if (!(pendingRefundCount > 0)) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 还没有待处理的退款申请，不能直接置为「退款申请中」——` +
            `那会让订单座位当场释放却没有任何应退金额可批准，最终既退不出去也回不来。` +
            `请改用订单详情页的「取消订单」：系统会按取消策略算出应退明细并生成退款申请，` +
            `再由财务批准退款。`,
        );
      }
    }

    // ── CHANGED 派生闸（与上方 TICKETED 派生闸同构）─────────────────────────────
    // 「已改期」不是一个可以手点的标签，而是**改期动作真的发生过**的派生：改期端点
    //（rescheduleOrderItem）搬完座位后会在被改的 FLIGHT 行 metadata 上落 flightChanged 标记，
    // 并在同一事务里推进本状态。手动 CHANGE_REQUESTED→CHANGED 若不校验，就会出现「订单写着
    // 已改期、航段还是原班次」——旅客照原班次出行、客服照新状态答复，且改期费/立减补差全部落空。
    // ADMIN force 可跳过（应急通道，审计照记；也用于放行改期标记出现之前的存量单）。
    if (toStatus === OrderStatus.CHANGED && !isAdminForce) {
      const flightRows = await tx.orderItem.findMany({
        where: { orderId: id, kind: OrderItemKind.FLIGHT },
        select: { metadata: true },
      });
      const hasFlightChangedMark = flightRows.some((row) => {
        const meta = row.metadata;
        if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return false;
        return (meta as Record<string, unknown>).flightChanged != null;
      });
      if (!hasFlightChangedMark) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 没有任何航段被改期过，不能置为「已改期」——` +
            `否则状态说已改、航段还是原班次，旅客会按原航班出行。` +
            `请先用订单详情页的「改期」把航段改到新班次（改完订单会自动进入「已改期」）。`,
        );
      }
    }

    const wasHolding = SEAT_HOLDING_STATUSES.includes(order.status);
    const isReleasing = SEAT_RELEASING_STATUSES.includes(toStatus);
    // 与 isReleasing 对称：目标状态是否落入"占座中"集合 —— 下面「非占座 → 占座」重新占座分支要用。
    // 覆盖 force 路径（如 PAYMENT_TIMEOUT →(force) PAID）：座位释放时已经还库存，
    // 拉回占座状态若不重新扣座，会出现"状态已占座、库存却没扣"的幽灵持有，导致超卖。
    const isNewHolding = SEAT_HOLDING_STATUSES.includes(toStatus);

    // 硬规则（即使 admin force 也不许）：已退款（REFUNDED）是终态，不允许"复活"回占座/已支付状态。
    // 强转虽已修佣金幂等 + 重新占座，但 Refund 记录会永久停在 COMPLETED、订单却回到 PAID，
    // 收款/退款账目对不上；要重开须走正规重新下单，而非把退款单强拉回有效状态。
    if (order.status === 'REFUNDED' && isNewHolding) {
      throw new BadRequestError(
        '订单已退款（终态），不能强制拉回占座/已支付状态；如需重开请重新下单',
      );
    }

    const isSystemActor = requester.actorType === 'SYSTEM' || requester.userId.startsWith('system-');

    // ── 批准退款前：锁单重校应退额（资金守恒断言）────────────────────────────
    // 下方「Refund 状态同步」会把本单所有 REQUESTED Refund 一次性 updateMany 成 COMPLETED，
    // 按的是**创建退款申请那一刻的 amount 快照**：既不重读 paidAmount、也不重新报价。
    // 若在「申请退款」与「批准退款」之间 paidAmount 被压低（典型：多付被转存代理余额/挂账池），
    // 快照就会大于实收 —— 照付即净流出 > 净流入（收 1500 付 2000）。
    // Order 行锁救不了：Refund 行从没被锁，完成时也没有任何复核。
    //
    // 这里加的是「退出去的钱不能多过收进来的钱」这条守恒断言：
    //   Σ(已完成退款) + Σ(本次将完成的 REQUESTED 退款) ≤ 当前 paidAmount
    // 已完成退款必须计入：退款完成不减 paidAmount（只翻 Refund 状态），
    // 不计入就会「分两次各退一半额度」把同一笔钱退两遍。
    //
    // 按**合计**而非逐条校验：updateMany 一次翻全部 REQUESTED，逐条看各自都可能 ≤ paidAmount，
    // 合计却超收（如 paid 1000、两条各 600）—— 逐条校验会放行，合计校验才拦得住。
    //
    // 为什么只断言、不在此处重新报价：报价是「申请那一刻对客户做出的承诺」，退改费按起飞前时长分档，
    // 批准晚了就重算会让客户平白少拿钱 —— 那是业务口径变更，需拍板，不该混进堵漏。
    // 断言则是客观的资金守恒，无需任何业务口径输入，且覆盖所有压低 paidAmount 的路径（不止多付转存）。
    // 触发时 fail-closed：抛错回滚，Refund 留在 REQUESTED 等人工按最新口径重新报价，绝不擅自少退。
    // 转 REFUNDED 时需要在事务后半段回补的代理预存余额（口径见下方注释）。null = 无需回补。
    let prepaymentRestore: { agentId: string; amountCny: number } | null = null;
    if (toStatus === 'REFUNDED') {
      // FOR UPDATE 行锁：与多付转存/挂账池/到账入账（均先对 Order 行 FOR UPDATE）串行——
      // 并发的多付处置要么排在本事务前（paidAmount 已降低 → 本断言拦下），
      // 要么排在后（订单已 REFUNDED → 处置闸拦下）。两头都堵死，无窗口可钻。
      const lockedRows = await tx.$queryRaw<Array<{ paidAmount: Prisma.Decimal }>>`
        SELECT "paidAmount" FROM "Order" WHERE id = ${id} FOR UPDATE
      `;
      const paidAmount = lockedRows[0]?.paidAmount ?? order.paidAmount;

      // ── 账目完整性闸：落 REFUNDED 必须有对应的 Refund 记录 ────────────────
      // 下方「Refund 状态同步」用的是 updateMany(status: REQUESTED)：若这张单从未走过
      // cancel 退款流程（典型：直接 PATCH status FAILED→REFUND_REQUESTED→REFUNDED，
      // 每一步都在状态机白名单里、无需 force），updateMany 影响 0 行，订单照样落 REFUNDED。
      // 后果是这笔钱被永久卡死：实收原封挂在单上、佣金却按全额冲销，而撤销认款 / 转挂账池 /
      // 软删全被资金闸封死（REFUNDED 在三道闸里都是黑名单），谁也对不平。
      // 所以一律要求先有 Refund（REQUESTED 或 COMPLETED）——**admin force 同样拦**：
      // 这是账目完整性，不是流程便利性，force 是用来跳状态机的，不是用来跳账的。
      const refundRecordCount = await tx.refund.count({
        where: { orderId: id, status: { in: [RefundStatus.REQUESTED, RefundStatus.COMPLETED] } },
      });
      if (refundRecordCount === 0) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 没有任何退款记录，不能置为「已退款」——` +
            `否则实收会永久挂在单上、既退不出去也冲销不掉（已退款是终态，三道资金闸全部封死）。` +
            `请改走退款流程：POST /orders/${id}/cancel 生成退款申请（含应退报价），再批准退款。`,
        );
      }

      const pendingAgg = await tx.refund.aggregate({
        where: { orderId: id, status: RefundStatus.REQUESTED },
        _sum: { amount: true },
      });
      const pendingSum = pendingAgg._sum.amount ?? new Prisma.Decimal(0);
      const completedSum = new Prisma.Decimal(await sumCompletedRefundsWithinTx(tx, id));
      const totalRefundOut = completedSum.add(pendingSum);
      const paidNum = round2(Number(paidAmount.toString()));
      const totalRefundOutCny = round2(Number(totalRefundOut.toString()));

      // ── 本单的预存余额抵扣额：按 PrepaymentTransaction 流水现算 ─────────────
      // 绝不读 Order.prepaymentOffset：那一列没有任何生产代码写入（恒为 0），照它算出来的
      // 「余额部分」恒为 0 —— 预存抵付过的单退款时余额永远回不来（钱在系统里凭空消失）。
      // 唯一真源是流水：applyAgentBalanceToOrder 每次抵扣写一条 OFFSET（负数），
      // 本分支每次回补写一条 REFUND（正数）。
      //   已抵扣毛额 offsetGross     = |Σ OFFSET.amount|
      //   已回补     alreadyRestored = Σ REFUND.amount（幂等基准：分批批准退款不重复回补）
      // 关键口径：抵扣当时已经把金额累加进 order.paidAmount（见 applyAgentBalanceToOrder），
      // 所以 paidAmount 是「现金 + 余额抵扣」的合计，不是纯现金 ——
      //   · 资金守恒基数就是 paidAmount 本身，绝不能再把 offsetGross 加一次（等于凭空放宽退款上限）；
      //   · 真·现金 realCash = max(0, paidAmount − offsetGross)，做现金/余额拆分时用它当现金侧上限。
      // realCash 按**毛额**而非净额算：回补不减 paidAmount，用净额会让已回补的部分在下一次
      // 分批批准时摇身变成「现金」，同一笔钱退两遍。
      // 无归属代理的单直接跳过查询：applyAgentBalanceToOrder 硬要求 order.agentId 才能抵扣，
      // 而有 OFFSET 时改归属被硬阻断（见 changeOrderAgent）—— agentId 为空 ⇒ 必然没有 OFFSET 流水。
      const balanceLedger = order.agentId
        ? await tx.prepaymentTransaction.findMany({
            where: {
              orderId: id,
              type: { in: [PrepaymentTxType.OFFSET, PrepaymentTxType.REFUND] },
            },
            select: { agentId: true, amount: true, type: true },
          })
        : [];
      const offsetRows = balanceLedger.filter((r) => r.type === PrepaymentTxType.OFFSET);
      const offsetGrossCny = round2(
        offsetRows.reduce((s, r) => s + Math.abs(Number(r.amount.toString())), 0),
      );
      const alreadyRestoredCny = round2(
        balanceLedger
          .filter((r) => r.type === PrepaymentTxType.REFUND)
          .reduce((s, r) => s + Number(r.amount.toString()), 0),
      );
      const realCashCny = Math.max(0, round2(paidNum - offsetGrossCny));

      if (totalRefundOutCny > paidNum + 0.001) {
        throw new BadRequestError(
          `订单 ${order.orderNumber} 应退合计 ¥${totalRefundOutCny.toFixed(2)} 已超过实收 ¥${paidNum.toFixed(2)}` +
            `（现金 ¥${realCashCny.toFixed(2)} + 预存余额抵扣 ¥${offsetGrossCny.toFixed(2)}），` +
            `不能批准退款（退出去的钱不能多过收进来的钱）。` +
            `常见原因：申请退款后多付已被转存代理余额或挂账池，或此前已退过款。` +
            `请财务核对实收与已退金额后，驳回本次申请并按最新口径重新发起。`,
        );
      }

      // ── 预存余额回补（PrepaymentTxType.REFUND，此前是从未被写入的死枚举）────
      // 拆分口径与 lib/cancellation.ts 的 splitRefundBetweenCashAndBalance 同源
      //（现金优先：改期费先从现金里消耗，应退先退现金、退不下的部分回余额）；
      // 差别只在这里的「现金」是扣掉余额抵扣后的 realCash，而那边收到的 paidAmount 是合计值。
      // 这里刻意内联而不是 import：orders.service.test.ts 用 vi.mock 整体替换了
      // '../../lib/cancellation.js'，静态引用会在该测试里变成 undefined。改这段务必同步改那边。
      const adjustmentCny = round2(Number(order.adjustmentCny ?? 0));
      const cashCapacityCny = Math.max(0, round2(realCashCny - adjustmentCny));
      const refundToCashCny = round2(Math.min(totalRefundOutCny, cashCapacityCny));
      // 这是**累计**应回补额（不是本次增量）：夹在 offsetGross 以内，绝不回补超过当初抵扣掉的余额。
      const refundToBalanceCny = round2(
        Math.min(offsetGrossCny, Math.max(0, round2(totalRefundOutCny - refundToCashCny))),
      );
      const restoreNowCny = round2(refundToBalanceCny - alreadyRestoredCny);
      if (restoreNowCny > 0) {
        // 回补对象取流水上的代理，而不是 order.agentId：抵扣掉的是当时那个代理账户的钱。
        // 有 OFFSET 时改归属已被硬阻断（见 changeOrderAgent），正常不会分叉；真分叉了就
        // fail-closed 交人工 —— 把 A 的钱补给 B 是比「补不上」更坏的错误。
        const restoreAgentIds = [...new Set(offsetRows.map((r) => r.agentId))];
        if (restoreAgentIds.length > 1) {
          throw new BadRequestError(
            `订单 ${order.orderNumber} 的预存余额抵扣涉及多个代理账户，无法自动回补余额。` +
              `请财务先手工冲回各代理的抵扣流水，再批准本次退款。`,
          );
        }
        prepaymentRestore = { agentId: restoreAgentIds[0], amountCny: restoreNowCny };
      }
    }

    // ── 原子 CAS：where 附加当前状态，防并发重复转移（如两个支付回调同时来）──
    const extraData: Record<string, unknown> = { status: toStatus };
    // 转 PAID 不再"因为转成 PAID 这个动作本身"就把 paidAmount 抬到 total（旧口径 = 隐式收款：
    // STAFF/ADMIN 经 PATCH status 把订单 PENDING_PAYMENT→PAID 即"已收全款"，实收与流水永久对不上）。
    // 新口径：paidAmount 只反映**真实到账证据**，取以下两者的较大值，绝不凭空补满额——
    //   1. 调用方已累加进 order.paidAmount 的到账（人工确认 / 挂账认领 / 代理余额抵扣；其中余额抵扣
    //      走 prepaymentTransaction，不进 Payment 台账，故必须认 order.paidAmount）。
    //   2. Payment 台账里 SUCCEEDED 合计（支付网关回调此刻已在同一事务把本笔 Payment 置 SUCCEEDED，
    //      但没有累加 order.paidAmount —— 靠这里按台账把 paidAmount 抬到实收，同时天然保留多付）。
    // 无任何证据（如 admin force→PAID 但没有收款流水）→ 保留 order.paidAmount 原值：订单可显示 PAID，
    // 但尾款/应收余额如实 > 0（财务报表可见"标记已付但未收齐"），绝不伪造已收。若确需"标记已付且无流水"，
    // 应做成显式的、带审计与警示的独立操作，不混进普通状态流转（本次不实现）。
    if (toStatus === 'PAID') {
      // R5（lost update 收口）：聚合 SUCCEEDED Payment 之前先对本 Order 行 FOR UPDATE，
      // 与人工确认 / 挂账认领 / 代理余额抵扣（均先对 Order 行 FOR UPDATE 后累加 paidAmount）串行——
      // 事务内读到最新 paidAmount（而非本函数开头 findUnique 的无锁旧快照），避免"读旧快照 → 写
      // paidAmount"覆盖并发到账。行锁一直持到本事务提交。
      const lockedRows = await tx.$queryRaw<Array<{ paidAmount: Prisma.Decimal }>>`
        SELECT "paidAmount" FROM "Order" WHERE id = ${id} FOR UPDATE
      `;
      const currentPaidNum = Number((lockedRows[0]?.paidAmount ?? order.paidAmount).toString());
      const paymentsAgg = await tx.payment.aggregate({
        _sum: { amount: true },
        where: { orderId: id, status: PaymentStatus.SUCCEEDED },
      });
      const paymentsSumNum = Number((paymentsAgg._sum.amount ?? new Prisma.Decimal(0)).toString());
      if (paymentsSumNum > currentPaidNum) {
        extraData.paidAmount = new Prisma.Decimal(paymentsSumNum);
      }
      // else：不写 paidAmount（保留已记录的到账，含多付与"无证据"两种情形）。
    }

    const casResult = await tx.order.updateMany({
      where: { id, status: order.status },
      data: extraData,
    });
    if (casResult.count !== 1) {
      throw new ConflictError(`订单状态已被并发修改（期望「${zhStatus(order.status)}」，请重试）`);
    }

    await tx.orderStatusEvent.create({
      data: {
        orderId: id,
        fromStatus: order.status,
        toStatus,
        actorUserId: isSystemActor ? null : requester.userId,
        reason,
      },
    });

    if (wasHolding && isReleasing) {
      const releaseSeat = async (
        scheduleId: string,
        cabin: import('@prisma/client').CabinClass,
        qty: number,
      ): Promise<void> => {
        if (qty <= 0) return;
        await releaseSeatFloored(tx, scheduleId, cabin, qty);
        // 收集释放座位的舱位 id —— 调用方提交事务后排队候补检查
        if (releasedSeatClassIdsOut) {
          const sc = await tx.flightSeatClass.findFirst({
            where: { scheduleId, cabin },
            select: { id: true },
          });
          if (sc) releasedSeatClassIdsOut.push(sc.id);
        }
      };

      for (const item of order.items) {
        if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
        // 套餐升舱拆座的镜像还原：经济舱行下单时拆了 businessUpgradeCount 个座到商务舱，
        // 退座时也要按同一拆分各退各舱（否则会少退商务舱、多退经济舱）。
        const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
        const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
        const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
        await releaseSeat(item.flightScheduleId, 'BUSINESS', split.business);
        await releaseSeat(item.flightScheduleId, item.flightCabin, split.sameCabin);
      }
    } else if (!wasHolding && isNewHolding) {
      // 驳回退款申请会同时恢复酒店/套餐占房。订单状态 CAS 已在上面完成，
      // 因而同一事务里的房控查询会把本单重新计入；任一受管控晚变成负余量就整单回滚，
      // 避免只回座位却静默恢复成超售房单。
      if (order.status === OrderStatus.REFUND_REQUESTED && toStatus === OrderStatus.PROCESSING) {
        await this.assertRefundRejectionHotelCapacity(tx, order.items);
      }

      // 释放分支的镜像：订单从「非占座」状态被拉回「占座中」状态（主要是 admin force 路径，
      // 如 PAYMENT_TIMEOUT/CANCELLED/FAILED →(force) PAID/PROCESSING）—— 座位早已在释放时
      // 还给库存，这里必须重新占座，否则订单变成"幽灵持有"：状态显示占座，FlightSeatClass.sold
      // 却没有对应扣减，余票会被超卖。用与 createOrder 完全相同的原子 CAS（含他人 ACTIVE 锁位口径
      // + 套餐升舱拆座），任何一段余位不足就整单抛错，事务回滚，订单状态不落地（不会出现"半占座"）。
      const retakeSeat = async (
        scheduleId: string,
        cabin: import('@prisma/client').CabinClass,
        qty: number,
        itemLabel: string,
      ): Promise<void> => {
        if (qty <= 0) return;
        if (typeof tx.$queryRaw === 'function') {
          await tx.$queryRaw`
            SELECT id FROM "FlightSeatClass"
            WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
            FOR UPDATE
          `;
        }
        // 锁位语义与下单/改期时一致：他人的 ACTIVE 未过期锁位占用余票（订单本人的锁位不挡自己；
        // 游客单 order.userId=null → 不排除任何人，所有 ACTIVE 锁位都占余票）
        const lockedAgg = await tx.seatLock.aggregate({
          _sum: { qty: true },
          where: {
            seatClass: { scheduleId, cabin },
            ...(order.userId ? { userId: { not: order.userId } } : {}),
            status: SeatLockStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
        });
        const lockedByOthers = lockedAgg._sum.qty ?? 0;
        const heldQty = await heldSeatsForCabin(tx, scheduleId, cabin);
        const affected = await tx.$executeRaw`
          UPDATE "FlightSeatClass"
          SET sold = sold + ${qty}, "updatedAt" = NOW()
          WHERE "scheduleId" = ${scheduleId}
            AND cabin = ${cabin}::"CabinClass"
            AND sold + ${qty} + ${lockedByOthers} + ${heldQty} <= capacity
        `;
        if (affected !== 1) {
          const sc = await tx.flightSeatClass.findFirst({
            where: { scheduleId, cabin },
            select: { capacity: true, sold: true },
          });
          const available = sc
            ? Math.max(0, sc.capacity - sc.sold - lockedByOthers - heldQty)
            : 0;
          if (order.status === OrderStatus.REFUND_REQUESTED && toStatus === OrderStatus.PROCESSING) {
            throw new BadRequestError(
              `座位已被售出，无法驳回退款申请，请协调换班次或继续退款。${itemLabel}需要${qty}个座位，当前仅剩${available}个。`,
            );
          }
          throw new BadRequestError(
            `恢复为持有座位状态需重新占座：${itemLabel}（${CABIN_ZH_LABEL[cabin] ?? '当前舱位'}）余位不足，无法转换：需要 ${qty} 张，仅剩 ${available} 张`,
          );
        }
      };

      for (const item of order.items) {
        if (item.kind !== 'FLIGHT' || !item.flightScheduleId || !item.flightCabin) continue;
        // 套餐升舱拆座：与下单/释放同一口径，按 businessUpgradeCount 分拆两舱各自占座
        // （否则会少占商务舱、多占经济舱，或漏占其中一段）。
        const meta = (item.metadata ?? {}) as { businessUpgradeCount?: unknown };
        const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
        const split = computeBundleSeatSplit(item.flightCabin, item.quantity, rawUpgrade);
        await retakeSeat(item.flightScheduleId, 'BUSINESS', split.business, item.description);
        await retakeSeat(item.flightScheduleId, item.flightCabin, split.sameCabin, item.description);
      }
    }

    // ── 取消族恢复：复检班次开票额度（0716 H11）────────────────────────────────
    // 开票额度只统计 COUNTED_STATUSES 的订单（见 ticketing-cap.ts）。订单落取消族时它占的
    // 开票额度当场释放，那份额度随即可能被别的单开走；此后 force 把这张单拉回计数态，
    // 它带着的开票标记会**凭空补回来**，班次瞬间越过座位库存上限，而全流程无一处会察觉
    //（写标记的闸只在标记翻开时跑，状态流转从不看开票位）。
    // 口径：本单已在上方 CAS 成新状态、因而已计入 countIssuedPassengers，故按「新增 0 人」复检
    //（issued 已含本单）。超限则清掉该航段的开票标记 + 回警示语，让票务台按最新额度重新标 ——
    // 宁可要求重开，也不留一个把班次撑爆的隐形标记。
    if (!countsTowardTicketingCap(order.status) && countsTowardTicketingCap(toStatus)) {
      const inv = await tx.order.findUnique({
        where: { id },
        select: {
          outboundInvoiced: true,
          returnInvoiced: true,
          items: {
            where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            select: {
              flightScheduleId: true,
              flightSchedule: { select: { departureTime: true } },
            },
          },
        },
      });
      if (inv && (inv.outboundInvoiced || inv.returnInvoiced)) {
        const { outboundScheduleId, returnScheduleId } = determineFlightLegs(inv.items);
        const legsToRecheck: Array<{
          scheduleId: string;
          field: 'outboundInvoiced' | 'returnInvoiced';
          label: string;
        }> = [];
        if (inv.outboundInvoiced && outboundScheduleId) {
          legsToRecheck.push({
            scheduleId: outboundScheduleId,
            field: 'outboundInvoiced',
            label: '去程',
          });
        }
        if (inv.returnInvoiced && returnScheduleId) {
          legsToRecheck.push({
            scheduleId: returnScheduleId,
            field: 'returnInvoiced',
            label: '回程',
          });
        }
        const clearedFlags: Partial<Record<'outboundInvoiced' | 'returnInvoiced', boolean>> = {};
        for (const leg of legsToRecheck) {
          try {
            await assertTicketingCap(tx, [leg.scheduleId], 0);
          } catch (err) {
            if (!(err instanceof UnprocessableEntityError)) throw err;
            clearedFlags[leg.field] = false;
            invoiceCapWarningsOut?.push(
              `订单 ${order.orderNumber} 恢复为「${zhStatus(toStatus)}」后，${leg.label}班次的开票额度已被占满，` +
                `已自动清除该航段的开票标记（${err.message}）。请票务台核对后重新标记开票。`,
            );
          }
        }
        if (Object.keys(clearedFlags).length > 0) {
          await tx.order.update({ where: { id }, data: clearedFlags });
        }
      }
    }

    if (toStatus === 'PAID') {
      // R4（双通道到账账目分叉收口）：订单转 PAID 后，把该订单其它仍 PENDING 的 Payment 作废——
      // 否则它们的回调后续到达仍会被标 SUCCEEDED，而此刻已过了 PAID 分支的聚合点，那笔钱在
      // paidAmount 上"消失"、多付不可见（无 creditOverpayToAgent/overpayToPool 处置入口）。
      // 枚举无 CANCELLED/SUPERSEDED，用 FAILED + gatewayPayload.supersededByPaid 标记作废：
      //   · 常见情形（客户只真付了一笔，其余 PENDING 是弃单/多次尝试）→ 作废即清理，其回调被拒。
      //   · 若被作废的那笔后来真收到网关回调（客户确实又付了一次）→ handleCallback 认此标记，
      //     把金额计入 paidAmount 形成可见多付（point 3），绝不让真实到账消失。
      // 幂等：只动 PENDING（本次驱动 PAID 的那笔在调用方已置 SUCCEEDED，天然被排除，不会误伤）。
      await tx.payment.updateMany({
        where: { orderId: order.id, status: PaymentStatus.PENDING },
        data: {
          status: PaymentStatus.FAILED,
          gatewayPayload: {
            supersededByPaid: true,
            supersededAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      if (order.agentId) {
        // 带上 orderNumber：零计提审计要能让人凭订单号直接查（函数内部再查一次会多一次事务内往返）。
        await createCommissionsForOrder(tx, order.id, order.agentId, order.orderNumber);
      }
      const newIds = await createFulfillmentTasks(tx, order.id);
      newTaskIdsOut.push(...newIds);
    }

    // REFUND_REQUESTED 只是先释放库存，不代表退款已批准：此时不能冲销佣金，
    // 否则驳回退款回到 PROCESSING 后无法恢复佣金。REFUND_REQUESTED → REFUNDED
    // 虽然座位账是「释放 → 释放」，仍需在真正批准退款时执行原有佣金冲销。
    const shouldReverseCommissions =
      isReleasing &&
      toStatus !== OrderStatus.REFUND_REQUESTED &&
      order.status !== OrderStatus.PENDING_PAYMENT &&
      (wasHolding || order.status === OrderStatus.REFUND_REQUESTED);
    if (shouldReverseCommissions) {
      // 退款/取消时按比例冲销佣金（保证会计恒等：座位退了，已退的那部分佣金不能继续欠代理）。
      //
      // 冲销口径（按实退金额比例，分 ProductKind）：
      //   - 仅在「批准退款」(REFUNDED) 时按比例冲销：读本次推进的 Refund 快照
      //     gatewayPayload.quoteSnapshot.items[]，按 productKind 聚合
      //     refundRatio = Σ退款额 / Σ(退款额+退改费)（= Σ退款额 / Σ该类已付金额），
      //     clamp 到 [0,1]。平台留存的退改费对应的那部分佣金保留（不冲销）。
      //   - 其余「释放型」流转（CANCELLED / PAYMENT_TIMEOUT / FAILED）以及无法解析快照的
      //     旧退款 → 整单全额冲销（ratio=1，旧行为不变，绝不少冲）。
      //
      // 两类记录分别处理，以免破坏「已结算快照」：
      //   - ACCRUED（尚未进结算单）：
      //       · 全额（ratio>=1）→ 直接置 REVERSED（旧行为，期内净额自然归零）。
      //       · 部分（0<ratio<1）→ 原 ACCRUED 保留全额 + 新建一条「负数补偿记录」
      //         （amount/baseAmount 取负 × ratio、REVERSED、settlementId=null）；
      //         结算时 earned(+全额) 与补偿(−比例额) 相抵，净 = 原额 ×(1−ratio)，
      //         留存退改费对应的佣金可见可对账。
      //   - SETTLED（代理已在某张结算单里被结过账）：历史快照是冻结的，绝不回改；
      //     新建一条「负数补偿记录」（amount/baseAmount = −原额 × ratio、REVERSED、
      //     settlementId=null），让下一期结算把这笔负数净掉（跨期反冲），既追回多付
      //     又不污染上一张已支付结算单。负数 + REVERSED + settlementId=null 即是
      //     补偿记录的自识别标志（schema 无 note/source 列，故不另加列）。
      const refundRatioByKind = await this._computeRefundRatioByKind(tx, id, toStatus);

      const liveRecords = await tx.commissionRecord.findMany({
        where: {
          orderId: order.id,
          status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] },
        },
      });

      for (const rec of liveRecords) {
        const ratio = refundRatioByKind.get(rec.productKind) ?? 0;
        if (ratio <= 0) continue; // 该 ProductKind 未退（快照里没有）→ 不冲销

        if (ratio >= 1) {
          if (rec.status === CommissionStatus.ACCRUED) {
            // 全额 + 尚未结算 → 翻状态（旧行为，最省记录）
            await tx.commissionRecord.update({
              where: { id: rec.id },
              data: { status: CommissionStatus.REVERSED },
            });
            continue;
          }
          // 全额 + 已结算 → 负数补偿记录（M1-A 跨期反冲，整额）
          await tx.commissionRecord.create({
            data: {
              agentId: rec.agentId,
              orderId: rec.orderId,
              productKind: rec.productKind,
              baseAmount: rec.baseAmount.negated(),
              rate: rec.rate,
              amount: rec.amount.negated(),
              chainDepth: rec.chainDepth,
              status: CommissionStatus.REVERSED,
              settlementId: null,
            },
          });
          continue;
        }

        // 0 < ratio < 1 → 按比例：负数补偿记录（ACCRUED 与 SETTLED 同样处理；
        // ACCRUED 原记录保留全额，靠补偿记录净掉退款部分，留存退改费佣金不动）。
        const ratioDec = new Prisma.Decimal(ratio);
        const clawBase = round2Decimal(rec.baseAmount.mul(ratioDec));
        const clawAmount = round2Decimal(rec.amount.mul(ratioDec));
        if (clawAmount.lessThanOrEqualTo(0)) continue; // 防御：四舍五入后无金额可冲

        await tx.commissionRecord.create({
          data: {
            agentId: rec.agentId,
            orderId: rec.orderId,
            productKind: rec.productKind,
            baseAmount: clawBase.negated(),
            rate: rec.rate,
            amount: clawAmount.negated(),
            chainDepth: rec.chainDepth,
            status: CommissionStatus.REVERSED,
            settlementId: null,
          },
        });
      }
    }

    // 同步 Refund 状态：当订单走到终态 / 退款被拒回退时，关联的 REQUESTED Refund 应该相应推进，
    // 绝不能让它永久停在 REQUESTED。
    //   REFUNDED                       → Refund.COMPLETED + processedAt（管理员批准退款）
    //   CANCELLED                      → Refund.REJECTED（管理员拒绝退款，订单回滚到取消但不退）
    //   REFUND_REQUESTED → 其它态       → Refund.REJECTED（退款被拒回退，典型是 →PROCESSING）
    // （这是给 admin PATCH /orders/:id/status 兜底；前面 requestCancellation 创建的 Refund
    //  停在 REQUESTED 等待这一步推进）
    if (toStatus === 'REFUNDED') {
      await tx.refund.updateMany({
        where: { orderId: id, status: 'REQUESTED' },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });

      // 预存余额回补：客户当初用代理余额抵付的那部分，退款完成时必须原路退回余额账户，
      // 否则这笔钱在系统里凭空消失（余额侧扣过一笔 OFFSET，却永远收不回来）。
      // 金额已在本函数前半段按「现金优先」口径算好并做过幂等去重（见 prepaymentRestore 处注释）。
      // 锁序与 applyAgentBalanceToOrder 一致（先 Order 后 Agent，两处都 FOR UPDATE）→ 不会死锁。
      if (prepaymentRestore) {
        const agentRows = await tx.$queryRaw<Array<{ prepaymentBalance: Prisma.Decimal }>>`
          SELECT "prepaymentBalance" FROM "Agent" WHERE id = ${prepaymentRestore.agentId} FOR UPDATE
        `;
        if (agentRows[0]) {
          const balanceAfter = round2(
            Number(agentRows[0].prepaymentBalance.toString()) + prepaymentRestore.amountCny,
          );
          await tx.agent.update({
            where: { id: prepaymentRestore.agentId },
            data: { prepaymentBalance: new Prisma.Decimal(balanceAfter) },
          });
          await tx.prepaymentTransaction.create({
            data: {
              agentId: prepaymentRestore.agentId,
              amount: new Prisma.Decimal(prepaymentRestore.amountCny), // 正数 = 退回余额
              balanceAfter: new Prisma.Decimal(balanceAfter),
              type: PrepaymentTxType.REFUND,
              orderId: id,
              description: `订单 ${order.orderNumber} 退款：余额抵扣部分 ¥${prepaymentRestore.amountCny.toFixed(2)} 退回预存余额`,
              createdById: requester.userId,
            },
          });
        }
      }
    } else if (toStatus === 'CANCELLED') {
      await tx.refund.updateMany({
        where: { orderId: id, status: 'REQUESTED' },
        data: { status: 'REJECTED', processedAt: new Date() },
      });
    } else if (order.status === 'REFUND_REQUESTED') {
      // 退款申请被拒 → 订单从 REFUND_REQUESTED 退回其它态（状态机允许 →PROCESSING；admin force 也可能
      // 拉到别处）。若不把停在 REQUESTED 的 Refund 置 REJECTED，会永久卡死：
      //   · requestCancellation 的幂等分支（order.refunds status=REQUESTED）会一直命中陈旧 Refund，
      //     客户再也无法发起新的取消申请；
      //   · 未来真退款时又会用这条陈旧快照算佣金冲销比例，账目错乱。
      await tx.refund.updateMany({
        where: { orderId: id, status: 'REQUESTED' },
        data: { status: 'REJECTED', processedAt: new Date() },
      });
    }

    // 履约任务终态化（取消族）：订单落 CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED 时，把该订单
    // 仍 PENDING/IN_PROGRESS 的履约任务一并置 CANCELLED（同事务）。否则任务只被列表查询过滤隐藏、
    // 仍是活动态：force 把订单拉回占座态即"复活"，且统计口径数不到已取消。
    //   · 与 resetVisa（换人重开签证任务，把 VISA 任务 PENDING 化）语义不冲突：那是"重开"，这里是"终态化"。
    //   · worker 已跳过 CONFIRMED/CANCELLED 任务，故即便 ENABLE_AUTO_FULFILLMENT 已入队 job，转 CANCELLED 后被跳过。
    if (FULFILLMENT_TERMINATING_STATUSES.includes(toStatus)) {
      await tx.fulfillmentTask.updateMany({
        where: {
          orderItem: { orderId: id },
          status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
        },
        data: { status: FulfillmentStatus.CANCELLED, completedAt: new Date() },
      });
    }

    return tx.order.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        passengers: true,
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
        user: { select: { id: true, displayName: true, email: true } },
      },
    });
  }

  /**
   * 驳回退款申请前校验本单 HOTEL/BUNDLE 行的逐晚房量。
   *
   * 这里复用 hotel-availability / bundle-availability 的床位余量口径：
   *   - 具体酒店：getHotelNightlyRemaining（酒店级包房周期 + 有效订单占房）；
   *   - 随机档/占位酒店：getRandomTierAggregate（同星级真酒店合计 − 未落位占用）。
   * 订单状态已在本事务内 CAS 为 PROCESSING，所以当前订单已经被计入 used；只需检查
   * 受管控夜晚是否出现负余量。未配置包房周期的日期按既有口径不拦截。
   */
  private async assertRefundRejectionHotelCapacity(
    tx: Prisma.TransactionClient,
    items: ReadonlyArray<{
      kind: OrderItemKind;
      hotelRoomTypeId: string | null;
      randomStarTier: number | null;
      hotelCheckIn: Date | null;
      hotelCheckOut: Date | null;
    }>,
  ): Promise<void> {
    const hotelRows = items.filter(
      (item) =>
        (item.kind === OrderItemKind.HOTEL || item.kind === OrderItemKind.BUNDLE) &&
        item.hotelCheckIn &&
        item.hotelCheckOut,
    );
    if (hotelRows.length === 0) return;

    const roomTypeIds = [
      ...new Set(
        hotelRows
          .map((item) => item.hotelRoomTypeId)
          .filter((id): id is string => id != null),
      ),
    ];
    const roomTypes =
      roomTypeIds.length > 0
        ? await tx.hotelRoomType.findMany({
            where: { id: { in: roomTypeIds } },
            select: {
              id: true,
              hotelId: true,
              hotel: { select: { randomTierPlaceholder: true } },
            },
          })
        : [];
    const roomTypeById = new Map(roomTypes.map((roomType) => [roomType.id, roomType]));

    const shortage = (result: { remaining: number[]; block: number[]; hasBlock: boolean }): boolean =>
      result.hasBlock &&
      result.remaining.some((remaining, index) => (result.block[index] ?? 0) > 0 && remaining < 0);

    const checked = new Set<string>();
    for (const item of hotelRows) {
      const nightDates = buildStayNightDates(item.hotelCheckIn!, item.hotelCheckOut!);
      if (nightDates.length === 0) continue;

      let scopeKey: string;
      let result: { remaining: number[]; block: number[]; hasBlock: boolean };
      const roomType = item.hotelRoomTypeId ? roomTypeById.get(item.hotelRoomTypeId) : undefined;
      const randomTier = item.randomStarTier ?? roomType?.hotel.randomTierPlaceholder ?? null;
      if (randomTier != null) {
        scopeKey = `random:${randomTier}:${nightDates.join(',')}`;
        if (checked.has(scopeKey)) continue;
        checked.add(scopeKey);
        const aggregate = await getRandomTierAggregate(randomTier, nightDates, {}, tx);
        result = aggregate;
      } else if (roomType) {
        scopeKey = `hotel:${roomType.hotelId}:${nightDates.join(',')}`;
        if (checked.has(scopeKey)) continue;
        checked.add(scopeKey);
        result = await getHotelNightlyRemaining(roomType.hotelId, nightDates, tx);
      } else {
        // 异常历史行没有可解析的房型/随机档作用域；保持既有宽松口径，不臆造库存来源。
        continue;
      }

      if (shortage(result)) {
        throw new BadRequestError('房量已被售出，无法驳回退款申请，请协调换房或继续退款');
      }
    }
  }

  /**
   * 计算「本次释放型流转应冲销多少佣金」的比例（按 ProductKind）。
   *
   * 规则：
   *   - 非 REFUNDED（CANCELLED / PAYMENT_TIMEOUT / FAILED 等）→ 整单全额冲销：
   *     所有 ProductKind 一律返回 ratio=1（取消语义不变，不按比例）。
   *   - REFUNDED（批准退款）→ 按「实退金额」比例分类冲销：
   *     读本次被推进的 Refund（status=REQUESTED，下一步会被翻 COMPLETED）的
   *     gatewayPayload.quoteSnapshot.items[]，按 item.kind 聚合
   *       refundedByKind = Σ refundAmount
   *       revenueByKind  = Σ (refundAmount + feeAmount)   // = 该类已付金额
   *       ratio[kind]    = clamp(refundedByKind / revenueByKind, 0, 1)
   *     未出现在快照里的 ProductKind → Map 无键 → 调用方按 0 处理（不冲销）。
   *   - 无可解析快照（旧退款 / 脏数据）→ 退回整单全额冲销（所有键缺失但返回哨兵：
   *     这里用 fullReversalAllKinds=true 表示"对任何 kind 都 ratio=1"，绝不少冲）。
   *
   * 返回一个 Map<ProductKind, number>；为简化调用方，缺省键即 0。
   * 当需要"对所有 kind 都全额冲销"时，预填全部 ProductKind 为 1。
   *
   * ⚠️ 不变式：ALL_PRODUCT_KINDS 必须覆盖**所有会被计提的** ProductKind
   * （即 ORDER_ITEM_KIND_TO_PRODUCT_KIND 的全部值域）。少一个 kind，该类佣金
   * 就只进不出——退款/取消时 ratio 取不到值按 0 处理，静默不冲销，代理白拿。
   */
  private async _computeRefundRatioByKind(
    tx: Prisma.TransactionClient,
    orderId: string,
    toStatus: OrderStatus,
  ): Promise<Map<ProductKind, number>> {
    const ALL_PRODUCT_KINDS: ProductKind[] = [
      ProductKind.FLIGHT,
      ProductKind.HOTEL,
      ProductKind.TRANSFER,
      ProductKind.VISA,
      ProductKind.BUNDLE,
    ];
    const fullReversal = (): Map<ProductKind, number> =>
      new Map(ALL_PRODUCT_KINDS.map((k) => [k, 1] as const));

    // 非批准退款的释放（取消 / 超时 / 失败）→ 整单全额冲销，语义不变。
    if (toStatus !== 'REFUNDED') return fullReversal();

    // 读本次推进的 Refund（与下方 Refund 状态同步同一批：status=REQUESTED）。
    const pendingRefunds = await tx.refund.findMany({
      where: { orderId, status: 'REQUESTED' },
      select: { gatewayPayload: true },
    });

    const refundedByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();
    let parsedAnyItem = false;

    for (const r of pendingRefunds) {
      // gatewayPayload 是未知 JSON —— 防御式解析，任何不符合预期的形状都跳过。
      const payload = r.gatewayPayload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const snapshot = (payload as Record<string, unknown>).quoteSnapshot;
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
      const items = (snapshot as Record<string, unknown>).items;
      if (!Array.isArray(items)) continue;

      for (const raw of items) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const it = raw as Record<string, unknown>;
        const kind = typeof it.kind === 'string' ? it.kind : null;
        const feeAmount = Number(it.feeAmount);
        const refundAmount = Number(it.refundAmount);
        if (!kind || !Number.isFinite(feeAmount) || !Number.isFinite(refundAmount)) continue;
        parsedAnyItem = true;
        refundedByKind.set(kind, (refundedByKind.get(kind) ?? 0) + refundAmount);
        revenueByKind.set(kind, (revenueByKind.get(kind) ?? 0) + refundAmount + feeAmount);
      }
    }

    // 无任何可解析快照项（旧退款 / 脏数据）→ 退回整单全额冲销，绝不少冲。
    if (!parsedAnyItem) return fullReversal();

    const ratioByKind = new Map<ProductKind, number>();
    for (const kindStr of revenueByKind.keys()) {
      // 只接受合法 ProductKind 字符串；其他（如 INSURANCE / FEE / DISCOUNT）无佣金记录，忽略。
      if (!ALL_PRODUCT_KINDS.includes(kindStr as ProductKind)) continue;
      const revenue = revenueByKind.get(kindStr) ?? 0;
      const refunded = refundedByKind.get(kindStr) ?? 0;
      const ratio = revenue > 0 ? Math.min(1, Math.max(0, refunded / revenue)) : 0;
      ratioByKind.set(kindStr as ProductKind, ratio);
    }
    return ratioByKind;
  }

  // ════════════════════════════════════════════════════════════════════
  // 前台自助（客户/代理侧）：护照资料补录 / 改签申请 / 电子行程单
  // ════════════════════════════════════════════════════════════════════

  /**
   * 出行人护照资料自助补录（前台客户本人 / 代理树内订单）。
   *
   * 规则：
   *   - 归属校验与 getOrder 同口径（assertCanView：客户仅本人单、代理仅自己+下级）。
   *   - 状态闸：仅 PENDING_PAYMENT / PAID / PROCESSING 可改；出票后锁定 → 409 ORDER_LOCKED。
   *   - 不允许改 fullName（换人请联系客服）——schema 层已拦，service 只接白名单字段。
   *   - passengerId 必须属于该订单，否则 404。
   *
   * 返回更新后的出行人（与 getOrder 详情同款序列化：剥离 passportPhotoUrl 大图，
   * 以 hasPassportPhoto 布尔代替）+ 改动字段名列表（审计用，绝不含字段值——PII 红线）。
   */
  async selfUpdatePassenger(
    orderId: string,
    passengerId: string,
    input: SelfUpdatePassengerBody,
    requester: OrderRequester,
  ): Promise<{
    passenger: Record<string, unknown>;
    changedFields: string[];
    orderNumber: string;
  }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, userId: true, agentId: true, orderNumber: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);

    if (!SELF_EDITABLE_PASSENGER_STATUSES.includes(order.status)) {
      throw new AppError('当前订单状态不可修改出行人资料，请联系客服', {
        statusCode: 409,
        code: 'ORDER_LOCKED',
      });
    }

    const passenger = await prisma.passenger.findUnique({
      where: { id: passengerId },
      select: { id: true, orderId: true },
    });
    if (!passenger || passenger.orderId !== orderId) {
      throw new NotFoundError('出行人不存在或不属于该订单');
    }

    // 仅映射传入字段（与 swapPassenger 同款「undefined 即不动」口径）；日期字符串 → Date。
    const data: Prisma.PassengerUpdateInput = {};
    const changedFields: string[] = [];
    if (input.chineseName !== undefined) { data.chineseName = input.chineseName; changedFields.push('chineseName'); }
    if (input.gender !== undefined) { data.gender = input.gender; changedFields.push('gender'); }
    if (input.documentNumber !== undefined) { data.documentNumber = input.documentNumber; changedFields.push('documentNumber'); }
    if (input.dateOfBirth !== undefined) { data.dateOfBirth = new Date(input.dateOfBirth); changedFields.push('dateOfBirth'); }
    if (input.nationality !== undefined) { data.nationality = input.nationality; changedFields.push('nationality'); }
    if (input.passportExpiry !== undefined) { data.passportExpiry = new Date(input.passportExpiry); changedFields.push('passportExpiry'); }
    if (input.passportIssueDate !== undefined) { data.passportIssueDate = new Date(input.passportIssueDate); changedFields.push('passportIssueDate'); }
    if (input.passportIssueCountry !== undefined) { data.passportIssueCountry = input.passportIssueCountry; changedFields.push('passportIssueCountry'); }
    if (input.passportIssuePlace !== undefined) { data.passportIssuePlace = input.passportIssuePlace; changedFields.push('passportIssuePlace'); }
    if (input.passportPhotoUrl !== undefined) { data.passportPhotoUrl = input.passportPhotoUrl; changedFields.push('passportPhotoUrl'); }

    const updated = await prisma.passenger.update({ where: { id: passengerId }, data });
    return {
      passenger: serializePassengerRecord(updated as unknown as Record<string, unknown>),
      changedFields,
      orderNumber: order.orderNumber,
    };
  }

  /**
   * 签证台：出签后补录出行人的 出签日/生效日/有效期（仅 ADMIN/STAFF）。
   *
   * 规则：
   *   - 这三项是签证岗出签后才拿得到的信息，录单时无法预先知道（票务岗反馈：录单时不需要），
   *     已从录单表单移除；改由签证台在出签后走本方法补录。
   *   - passengerId 必须属于该订单，否则 404。
   *   - 字段值为 YYYY-MM-DD 字符串写入；null 清空该字段；undefined（未传）不动。
   *   - 无状态闸——出签后各订单状态（PAID/PROCESSING/TICKETED…）都可能需要补录/更正，不比照
   *     selfUpdatePassenger 的 SELF_EDITABLE_PASSENGER_STATUSES 限制（那是前台自助补护照资料的口径）。
   *
   * 返回更新后的出行人（同 selfUpdatePassenger 序列化口径）+ before/after（审计用）。
   */
  async updatePassengerVisaDates(
    orderId: string,
    passengerId: string,
    input: UpdatePassengerVisaDatesBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    passenger: Record<string, unknown>;
    orderNumber: string;
    before: { visaIssueDate: string | null; visaEffectiveDate: string | null; visaExpiry: string | null };
    after: { visaIssueDate: string | null; visaEffectiveDate: string | null; visaExpiry: string | null };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可录入签证日期');
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true },
    });
    if (!order) throw new NotFoundError('订单不存在');

    const passenger = await prisma.passenger.findUnique({
      where: { id: passengerId },
      select: {
        id: true,
        orderId: true,
        visaIssueDate: true,
        visaEffectiveDate: true,
        visaExpiry: true,
      },
    });
    if (!passenger || passenger.orderId !== orderId) {
      throw new NotFoundError('出行人不存在或不属于该订单');
    }

    const toYmd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
    const before = {
      visaIssueDate: toYmd(passenger.visaIssueDate),
      visaEffectiveDate: toYmd(passenger.visaEffectiveDate),
      visaExpiry: toYmd(passenger.visaExpiry),
    };

    const toDateOrNull = (v: string | null | undefined): Date | null | undefined =>
      v === undefined ? undefined : v === null ? null : new Date(v);
    const data: Prisma.PassengerUpdateInput = {};
    if (input.visaIssueDate !== undefined) data.visaIssueDate = toDateOrNull(input.visaIssueDate);
    if (input.visaEffectiveDate !== undefined) data.visaEffectiveDate = toDateOrNull(input.visaEffectiveDate);
    if (input.visaExpiry !== undefined) data.visaExpiry = toDateOrNull(input.visaExpiry);

    const updated = await prisma.passenger.update({ where: { id: passengerId }, data });
    const after = {
      visaIssueDate: toYmd(updated.visaIssueDate),
      visaEffectiveDate: toYmd(updated.visaEffectiveDate),
      visaExpiry: toYmd(updated.visaExpiry),
    };

    return {
      passenger: serializePassengerRecord(updated as unknown as Record<string, unknown>),
      orderNumber: order.orderNumber,
      before,
      after,
    };
  }

  /**
   * 改签申请（前台客户本人 / 代理树内订单）。
   *
   * 规则：
   *   - 状态闸：仅 PAID / PROCESSING / TICKETED 可申请；否则 409 ORDER_NOT_CHANGEABLE。
   *   - 幂等：已是 CHANGE_REQUESTED 直接返回当前订单（200，不重复建提醒）。
   *   - 事务内：走 _updateStatusWithinTx（记 OrderStatusEvent、并发 CAS 保护）+
   *     创建 OperationalReminder（HIGH 优先级，运营待办台接单跟进）。
   */
  // 返回类型交给推断：serializeOrder 是泛型，显式写 ReturnType<typeof serializeOrder> 会
  // 塌缩到 OrderLike 约束（丢失 id/orderNumber 等具体字段），路由层审计取不到订单号。
  async requestChange(orderId: string, reason: string, requester: OrderRequester) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, userId: true, agentId: true, orderNumber: true },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);

    // 幂等：重复点「申请改签」不报错、不重复建提醒，返回当前订单。
    if (order.status === OrderStatus.CHANGE_REQUESTED) {
      return { order: await this.getOrder(orderId, requester), idempotent: true };
    }
    if (!CHANGE_REQUESTABLE_STATUSES.includes(order.status)) {
      throw new AppError('当前订单状态不可申请改签', {
        statusCode: 409,
        code: 'ORDER_NOT_CHANGEABLE',
      });
    }

    // CHANGE_REQUESTED 与来源状态同属占座集合：无座位/佣金/履约副作用，无需事务后处理。
    const pendingTaskIds: string[] = [];
    const updated = await prisma.$transaction(async (tx) => {
      const u = await this._updateStatusWithinTx(
        tx,
        orderId,
        OrderStatus.CHANGE_REQUESTED,
        requester,
        reason,
        pendingTaskIds,
      );
      await tx.operationalReminder.create({
        data: {
          orderId,
          createdById: requester.userId,
          title: `【改签申请】${order.orderNumber}`,
          body: reason,
          priority: 'HIGH',
        },
      });
      return u;
    });
    // 申请改签是 AGENT/CUSTOMER 自助动作，返回订单同样按角色脱敏（不回传内部备注/逐项拆价等）。
    return { order: serializeOrder(updated, orderSerializeRoleCtx(requester.role)), idempotent: false };
  }

  /**
   * 电子行程单数据（前台客户下载 PDF 用；归属校验同 getOrder）。
   *
   * 状态闸：订单确认（付款）后才可下载 —— PAID / PROCESSING / TICKETED / COMPLETED /
   * CHANGE_REQUESTED / CHANGED；否则 409 ITINERARY_NOT_READY。
   * 无 FLIGHT 行（纯地面产品单）→ 409 NO_FLIGHT_ITEMS（与行程单邮件 no_flights 语义对齐）。
   */
  async getOrderItineraryData(
    orderId: string,
    requester: OrderRequester,
  ): Promise<{ orderNumber: string; itinerary: ItineraryData }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { flightSchedule: { include: { flight: true } } } },
        passengers: true,
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);

    if (!ITINERARY_READY_STATUSES.includes(order.status)) {
      throw new AppError('订单确认后可下载行程单', {
        statusCode: 409,
        code: 'ITINERARY_NOT_READY',
      });
    }

    const flightItems = order.items.filter((i) => i.kind === 'FLIGHT' && i.flightSchedule);
    if (flightItems.length === 0) {
      throw new AppError('该订单暂不支持生成行程单', {
        statusCode: 409,
        code: 'NO_FLIGHT_ITEMS',
      });
    }

    return {
      orderNumber: order.orderNumber,
      itinerary: {
        orderNumber: order.orderNumber,
        contactName: order.contactName,
        contactPhone: order.contactPhone,
        contactEmail: order.contactEmail,
        total: order.total.toFixed(2),
        // 应付 = total + adjustmentCny（改期费/换人费等售后调整），与订单详情「应收」/
        // effectivePayable 同口径 —— 行程单金额不能漏掉这块（itinerary-pdf.ts 里用它算应付）。
        adjustmentCny: Number(order.adjustmentCny ?? 0),
        currency: order.currency,
        createdAt: order.createdAt,
        flights: flightItems.map((i) => ({
          flightNumber: i.flightSchedule!.flight.flightNumber,
          origin: i.flightSchedule!.flight.originCode,
          destination: i.flightSchedule!.flight.destinationCode,
          departureTime: i.flightSchedule!.departureTime,
          arrivalTime: i.flightSchedule!.arrivalTime,
          departureTz: i.flightSchedule!.departureTz,
          arrivalTz: i.flightSchedule!.arrivalTz,
          cabin: i.flightCabin ?? 'ECONOMY',
        })),
        passengers: order.passengers.map((p) => ({
          fullName: p.fullName,
          passportNumber: p.documentNumber,
          pnr: p.pnr,
          eticketNumber: p.eticketNumber,
        })),
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 权限校验
  // ════════════════════════════════════════════════════════════════════
  private async assertCanView(order: { userId: string | null; agentId: string | null }, requester: OrderRequester) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'CUSTOMER') {
      // 游客单（userId=null）无登录归属 → 普通客户不可通过此路径查看（走公开 lookup）
      if (!order.userId || order.userId !== requester.userId) throw new ForbiddenError('无权查看该订单');
      return;
    }
    if (requester.role === 'AGENT') {
      const ids = await this.getDescendantAgentIds(requester.agentId);
      if (!order.agentId || !ids.includes(order.agentId)) {
        throw new ForbiddenError('无权查看该订单');
      }
    }
  }

  private async assertCanTransition(
    order: { userId: string | null; agentId: string | null; status: OrderStatus },
    toStatus: OrderStatus,
    requester: OrderRequester,
  ) {
    if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
    if (requester.role === 'CUSTOMER') {
      if (!order.userId || order.userId !== requester.userId) throw new ForbiddenError('无权操作该订单');
      // 客户允许的状态流转：
      //   1. PENDING_PAYMENT → CANCELLED （直接取消未支付订单）
      //   2. PAID / PROCESSING / TICKETED → REFUND_REQUESTED （申请取消已支付订单）
      //   3. PAID / PROCESSING / TICKETED → CHANGE_REQUESTED （前台自助改签申请）
      const allowed =
        (toStatus === 'CANCELLED' && order.status === 'PENDING_PAYMENT') ||
        ((toStatus === 'REFUND_REQUESTED' || toStatus === 'CHANGE_REQUESTED') &&
          (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED'));
      if (!allowed) {
        throw new ForbiddenError(
          `客户不可将订单「${zhStatus(order.status)}」改为「${zhStatus(toStatus)}」（仅允许取消待支付订单 / 申请已支付订单退款或改签）`,
        );
      }
      return;
    }
    if (requester.role === 'AGENT') {
      const ids = await this.getDescendantAgentIds(requester.agentId);
      if (!order.agentId || !ids.includes(order.agentId)) {
        throw new ForbiddenError('无权操作该订单');
      }
      // 代理替自己树内客户申请退款 / 改签
      if ((toStatus === 'REFUND_REQUESTED' || toStatus === 'CHANGE_REQUESTED') &&
          (order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED')) {
        return;
      }
      throw new ForbiddenError('代理仅可代客户申请取消或改签（其他状态流转请联系运营）');
    }
  }

  // 查自己 + 所有后代代理 id — 用 PostgreSQL 递归 CTE 一次查完
  // 之前是按层 BFS 每层一次 findMany，代理树深就会放大 N 倍
  private async getDescendantAgentIds(agentId: string | undefined): Promise<string[]> {
    if (!agentId) return [];
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE agent_tree AS (
        SELECT id FROM "Agent" WHERE id = ${agentId}
        UNION ALL
        SELECT a.id FROM "Agent" a
        INNER JOIN agent_tree t ON a."parentAgentId" = t.id
      )
      SELECT id FROM agent_tree
    `;
    return rows.map((r) => r.id);
  }

  // ════════════════════════════════════════════════════════════════════
  // 取消订单（客户/代理 主动申请）
  // ════════════════════════════════════════════════════════════════════
  /**
   * 申请取消订单：
   *   1. 算 cancellation quote
   *   2. 创建 Refund 行（amount=应退）；状态 REQUESTED 等管理员审批
   *   3. Order 状态 → REFUND_REQUESTED + 写 OrderStatusEvent
   *   4. （注意：这里不真退款 / 不冲销佣金；机位在进入退款申请中时立即释放，等 admin approve 后再完成退款账务）
   *
   * 失败场景：
   *   - 订单状态不可取消 → BadRequestError
   *   - 已存在 REQUESTED 状态的 Refund → 返回那条（幂等）
   */
  async requestCancellation(
    id: string,
    reason: string | undefined,
    requester: OrderRequester,
  ) {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { refunds: { where: { status: 'REQUESTED' }, take: 1 } },
    });
    if (!order) throw new NotFoundError('订单不存在');
    await this.assertCanView(order, requester);

    // 已有 pending 退款 → 幂等返回（先于可取消性判断，避免再点报错）
    if (order.refunds.length > 0) {
      const { computeCancellationQuote } = await import('../../lib/cancellation.js');
      const existing = order.refunds[0];
      const updated = await prisma.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_FULL_INCLUDE,
      });
      // 始终重算最新 quote（不用 snapshot），保证客户端拿到的 shape 一致 + 费率最新
      // 历史 snapshot 留在 refund.gatewayPayload.quoteSnapshot 供审计追溯
      const quote = await computeCancellationQuote(id);
      return { order: serializeOrder(updated, orderSerializeRoleCtx(requester.role)), refund: existing, quote, isNew: false };
    }

    // 计算 quote（包含可取消性判断）
    const { computeCancellationQuote } = await import('../../lib/cancellation.js');
    const quote = await computeCancellationQuote(id);
    if (!quote.cancellable) {
      throw new BadRequestError(quote.cancellableReason ?? '订单不可取消');
    }

    // 事务：创建 Refund + 流转 Order 状态
    const releasedSeatClassIds: string[] = [];
    const result = await prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: {
          orderId: id,
          amount: new Prisma.Decimal(quote.totalRefund),
          reason: reason ?? null,
          status: 'REQUESTED',
          gatewayPayload: {
            quoteSnapshot: {
              totalFee: quote.totalFee,
              totalRefund: quote.totalRefund,
              items: quote.items.map((i) => ({
                itemId: i.itemId,
                kind: i.kind,
                feePercent: i.feePercent,
                feeAmount: i.feeAmount,
                refundAmount: i.refundAmount,
                reason: i.reason,
              })),
            },
          } as Prisma.InputJsonValue,
        },
      });

      const taskIds: string[] = [];
      await this._updateStatusWithinTx(
        tx,
        id,
        OrderStatus.REFUND_REQUESTED,
        requester,
        reason ?? `申请取消（应退 ¥${quote.totalRefund}）`,
        taskIds,
        false,
        releasedSeatClassIds,
      );

      return { refund };
    });

    // 事务提交后再通知候补，避免 worker 在座位释放提交前读到旧 sold。
    if (releasedSeatClassIds.length > 0) {
      try {
        const { enqueueWaitlistCheck } = await import('../../queues/queue.js');
        await Promise.all(
          [...new Set(releasedSeatClassIds)].map((seatClassId) => enqueueWaitlistCheck(seatClassId)),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[orders] failed to enqueue waitlist-check for', id, err);
      }
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: ORDER_FULL_INCLUDE,
    });
    // 申请取消是 AGENT/CUSTOMER 自助动作，返回订单按角色脱敏（与幂等分支同口径）。
    return { order: serializeOrder(finalOrder, orderSerializeRoleCtx(requester.role)), refund: result.refund, quote, isNew: true };
  }

  // ════════════════════════════════════════════════════════════════════
  // 售后改单：改期（reschedule）/ 换人（passenger swap）
  // 订单创建后原本不可改（只能取消重建）；这两个端点补「就地改」能力。
  // 全程 ADMIN/STAFF（路由层断言）、事务安全、审计。
  // 钱与库存口径：
  //   - 改期不重算机票基础价（doc：只加改期费）；尾款用 total + adjustmentCny − paidAmount − prepaymentOffset。
  //   - 座位「先放旧、再原子拿新」：拿新失败则整事务回滚，旧座不会被放掉（无泄漏、无超售）。
  // ════════════════════════════════════════════════════════════════════

  /**
   * 改期：把订单里某条 FLIGHT 行就地改到新班次/新舱位，并（可选）加改期费。
   *
   * body：{ orderItemId, newScheduleId, newCabin?, feeCny?, feeLabel?, note? }
   *   - orderItemId 必须属于本订单且 kind=FLIGHT，且有原班次/原舱位。
   *   - newCabin 缺省则沿用原舱位。
   *
   * 单事务内：
   *   1. 释放旧座（旧班次+旧舱位 sold −= quantity）
   *   2. 原子拿新座（新班次+新舱位 CAS：sold + qty + 他人锁位 + 占位余座 ≤ capacity）
   *      —— 新班次售罄则抛错，事务回滚 → 旧座保持原样（不泄漏）。
   *   3. 更新该行 flightScheduleId/flightCabin（amount/quantity 不变，机票基础价不重算）。
   *   3b. **换了班次即作废原票**：清空本单乘客的 pnr / eticketNumber，并把被改那一段的
   *       开票标记（去程 outboundInvoiced / 回程 returnInvoiced）翻回未开 —— 改期后旧票号
   *       必然作废，留着会让票务台以为已出票、导出与班次开票额度也照旧占着。
   *   4. 撤销未撤销的立减快照行并按原金额补差；feeCny≠0 另 push 一条 RESCHEDULE_FEE 流水
   *      （**差价可正可负**：同「换酒店差价 / 酒店改期差价」口径，改到便宜班次要能退差）。
   *   5. 当前若处于 CHANGE_REQUESTED（状态机允许 → CHANGED）则推进到 CHANGED；其余状态保持不变。
   *
   * 返回更新后的订单（serializeOrder）。
   */
  async rescheduleOrderItem(
    orderId: string,
    input: {
      orderItemId?: string;
      /** 批量改期内部入口：在订单行锁内按真实航段定位订单行。 */
      leg?: 'OUTBOUND' | 'RETURN';
      newScheduleId: string;
      newCabin?: import('@prisma/client').CabinClass;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
      /** 仅批量入口使用；省略时保持单条改期路由原有行为。 */
      guard?: { forbidTicketed?: boolean; correction?: boolean };
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      fromScheduleId: string;
      fromCabin: import('@prisma/client').CabinClass;
      fromDeparture: Date | null;
      toScheduleId: string;
      toCabin: import('@prisma/client').CabinClass;
      toDeparture: Date | null;
      feeCny: number;
      statusChanged: boolean;
      /** 随出发日平移自动同步的酒店行（未平移/无酒店行 = 空数组），日期为 YYYY-MM-DD。 */
      hotelDateSync: Array<{
        orderItemId: string;
        fromCheckIn: string;
        toCheckIn: string;
        fromCheckOut: string | null;
        toCheckOut: string | null;
      }>;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可改期');
    }
    // 改期差价可正可负（与换酒店差价 / 酒店改期差价同一 adjustmentCny 机制）：改到更便宜的班次
    // 本来就该退客人钱，旧版 Math.max(0, …) 把负数钳成 0，运营只能另开收款单反向操作。
    // 上限仍由 schema 的 ±POST_SALE_FEE_CAP_CNY 把关。
    const feeCny = Math.trunc(input.feeCny ?? 0);

    const scratch = await prisma.$transaction(async (tx) => {
      // R2 并发串行（与超时 worker 配对）：先对本订单 Order 行 FOR UPDATE，再往下读 items / 搬座位。
      // 超时 worker（queues/worker.ts）释放座位时也先对同一 Order 行 FOR UPDATE 后才事务内读 items——
      // 两处抢同一把行锁 → 改期与超时释放严格串行：谁先拿锁谁先提交，另一方拿锁后读到已提交的最新
      // 状态/items（改期已换舱则 worker 读新舱、或状态已 CHANGED 而跳过释放；worker 先超时则改期读到
      // PAYMENT_TIMEOUT 被下方占座守卫拒绝）。杜绝旧版无共同串行点导致的「旧舱双放 + 新舱幽灵持有」交错。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, deletedAt: true, adjustmentCny: true, adjustments: true },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // 占座状态守卫（HIGH）：改期要"放旧座 + 拿新座"，只有当订单当前**真的持有座位**时才成立。
      // 旧代码读了 order.status 却从不校验：对 CANCELLED/REFUNDED/软删单改期会——
      //   · 二次释放旧座（旧座早已释放，再放会把 sold 打成负数并永久卡账）；
      //   · 拿一份新座却挂在死单上永不释放（幽灵持有 → 超卖）。
      // 因此入口硬性要求：deletedAt=null 且 status ∈ 占座态，否则拒绝改期。
      if (order.deletedAt) {
        throw new BadRequestError('订单在回收站（已软删），不可改期；如需操作请先恢复');
      }
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可改期：仅占座中的有效订单可改期（已取消/已退款/超时订单请勿改期）`,
        );
      }

      if (
        input.guard?.forbidTicketed &&
        (order.status === OrderStatus.TICKETED || order.status === OrderStatus.COMPLETED)
      ) {
        throw new BadRequestError('订单已出票/已完成，需勾选「同时修改已出票订单」后才能改');
      }

      const itemSelect = {
        id: true,
        orderId: true,
        kind: true,
        quantity: true,
        bundleId: true,
        flightScheduleId: true,
        flightCabin: true,
        metadata: true,
        flightSchedule: { select: { departureTime: true, departureTz: true } },
      } as const;
      const item = input.orderItemId
        ? await tx.orderItem.findUnique({ where: { id: input.orderItemId }, select: itemSelect })
        : await (() => {
            if (!input.leg) return Promise.resolve(null);
            return tx.orderItem.findMany({
              where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
              select: itemSelect,
              orderBy: [{ flightSchedule: { departureTime: 'asc' } }, { id: 'asc' }],
            }).then((items) => {
              const legs = determineFlightLegItems(items);
              return input.leg === 'OUTBOUND' ? legs.outbound : legs.return;
            });
          })();
      if (!item || item.orderId !== orderId) {
        if (input.leg) {
          throw new BadRequestError(input.leg === 'RETURN' ? '本单没有回程航段' : '本单没有去程航段');
        }
        throw new NotFoundError('订单项不存在或不属于该订单');
      }
      if (item.kind !== OrderItemKind.FLIGHT || !item.flightScheduleId || !item.flightCabin) {
        throw new BadRequestError('只能对机票行（FLIGHT）改期');
      }

      const oldScheduleId = item.flightScheduleId;
      const oldCabin = item.flightCabin;
      const newScheduleId = input.newScheduleId;

      // ── 改期不许改舱（HIGH 修复：免费升舱后门）────────────────────────────
      // 改期端点只搬班次、不重算金额：amount/quantity 明写「不变」，feeCny 是手填的且可为 0，
      // 也不会生成 UPGRADE_CHANGE 行。若同时放开改舱，就等于「经济舱搬进商务舱、座位真的搬走、
      // 一分差价不收、账面无痕」—— 单笔漏收整笔升舱差价。
      // 升舱有独立端点（POST /orders/:id/items/:itemId/upgrade-cabin）：目标舱固定、差价由服务端
      // 按航班升舱差价源 × 人数权威计算、请求体不接受任何金额。职责收敛到那里，这里一律拒绝改舱。
      // 同舱改期（不传 newCabin，或传的就是原舱）是正常路径，不受影响。
      if (input.newCabin !== undefined && input.newCabin !== oldCabin) {
        throw new BadRequestError(
          '改期不能同时更改舱位：改期只搬班次、不重算差价。如需升舱请走「升舱」操作（差价由系统按航班差价源×人数自动计算）。',
        );
      }
      // 过闸后必然等于 oldCabin；保留原表达式，日后若放开改舱也只需改上面那道闸。
      const newCabin = input.newCabin ?? oldCabin;

      // 无变化（同班次同舱位）→ 不做座位搬移，避免无意义的放/拿
      const sameSeat = oldScheduleId === newScheduleId && oldCabin === newCabin;

      if (input.guard?.correction && !sameSeat && item.bundleId) {
        const discountRows = await tx.orderItem.findMany({
          where: { orderId, kind: OrderItemKind.DISCOUNT },
          select: { metadata: true },
        });
        const hasActiveSettlementDiscount = discountRows.some((discountRow) => {
          const rawMetadata = discountRow.metadata;
          const metadata =
            rawMetadata != null && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
              ? (rawMetadata as Record<string, unknown>)
              : {};
          return metadata.settlementDiscount === true && metadata.settlementDiscountRevoked !== true;
        });
        if (hasActiveSettlementDiscount) {
          throw new BadRequestError('本单含套餐立减，批量纠错会产生补差金额，请走单条改期逐单确认');
        }
      }

      // 新班次必须存在且有该舱位（友好报错；最终防超售仍靠下面的原子 CAS）
      const newSeatClass = await tx.flightSeatClass.findFirst({
        where: { scheduleId: newScheduleId, cabin: newCabin },
        select: { id: true },
      });
      if (!newSeatClass) {
        throw new BadRequestError('目标班次不存在该舱位，无法改期');
      }

      // 套餐升舱拆座：该行下单时可能把 businessUpgradeCount 个座拆到了商务舱。
      // 改期同样按原拆分「先放旧、再拿新」，否则商务/经济会错位泄漏。
      const meta = (item.metadata ?? {}) as Record<string, unknown> & { businessUpgradeCount?: unknown };
      const rawUpgrade = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;

      if (!sameSeat) {
        // ── 1. 释放旧座（按原拆分各退各舱）──
        // 用**有下限**版本 releaseSeatFloored（sold = GREATEST(0, sold − qty)），与状态机释放分支同口径：
        // 即便 businessUpgradeCount 被伪造导致想释放一个从未真正占用的舱位，也不会把 sold 打成负数卡账。
        const oldSplit = computeBundleSeatSplit(oldCabin, item.quantity, rawUpgrade);
        await releaseSeatFloored(tx, oldScheduleId, 'BUSINESS', oldSplit.business);
        await releaseSeatFloored(tx, oldScheduleId, oldCabin, oldSplit.sameCabin);

        // ── 2. 原子拿新座（同款 CAS；售罄 → 抛错，整事务回滚，旧座不会真被放掉）──
        // 拆座只对经济舱行成立；新舱位非经济舱则 split.business=0，全额拿新原舱。
        const newSplit = computeBundleSeatSplit(newCabin, item.quantity, rawUpgrade);
        await takeSeatWithinTx(tx, newScheduleId, 'BUSINESS', newSplit.business, null);
        await takeSeatWithinTx(tx, newScheduleId, newCabin, newSplit.sameCabin, null);
      }

      // 航变标记：仅当班次真的换了（换到另一趟班次）才在该行 metadata 打「航变」标，
      // 供后台（代理）与前台（直客）看见——同班次仅改舱位不算航变，不打标。
      // 记录原班次号/原起飞时间，前端可醒目标红并悬浮显示「原 XX 航班 原起飞 → 新起飞」。
      const scheduleChanged = oldScheduleId !== newScheduleId;
      let flightChangedMeta: Record<string, unknown> | null = null;
      if (scheduleChanged) {
        const oldSchedInfo = await tx.flightSchedule.findUnique({
          where: { id: oldScheduleId },
          select: {
            departureTime: true,
            departureTz: true,
            flight: { select: { flightNumber: true } },
          },
        });
        flightChangedMeta = {
          at: new Date().toISOString(),
          fromScheduleId: oldScheduleId,
          fromFlightNumber: oldSchedInfo?.flight?.flightNumber ?? null,
          fromDeparture: oldSchedInfo?.departureTime?.toISOString() ?? null,
          // 原班次出发地时区：航变提示要按它显示原起飞时刻。
          // 本次改动之前盖的旧标记没有这个字段，前端会回退到浏览器时区（见各自注释）。
          fromDepartureTz: oldSchedInfo?.departureTz ?? null,
          toScheduleId: newScheduleId,
        };
      }

      // ── 3. 更新订单行的班次/舱位（amount/quantity 不变：机票基础价不重算）──
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          flightScheduleId: newScheduleId,
          flightCabin: newCabin,
          // 换班次 → 落「航变」标记（保留该行原有 metadata，如套餐升舱拆座计数）
          ...(flightChangedMeta
            ? { metadata: { ...meta, flightChanged: flightChangedMeta } as Prisma.InputJsonValue }
            : {}),
        },
      });

      // 物化列 hasReturnLeg 自愈：改期只换班次、不增删航段，航段条数恒定，本调用理论上是个
      // 恒等写。仍然保留 —— 它把「改过期的单」顺手校准回真实结构（含迁移前的存量脏值），
      // 且未来若改期扩展成能加/删航段，维护点已经在这里，不会漏。
      await syncOrderHasReturnLeg(tx, orderId);

      // ── 3b. 换班次即作废原票：清票号 + 翻回被改航段的开票标记 ────────────────────
      // 旧代码只搬座位、不动票务字段，于是改完期订单上仍挂着**原航班的** PNR / 票号，
      // 开票位也仍是「已开」——票务台看不出要重开，导出发给客人的还是作废票号，
      // 而那份开票额度还占着新班次的座位库存（额度按航段算，班次已经换人了）。
      // 只在真的换了班次时做（同班次改舱/无变化不动票）；纠错批量入口（correction）同样适用——
      // 那正是「录错班次」的场景，原票号更不该留。
      // 幂等：updateMany + 定值写，重复改期不会出问题。
      const hotelDateSync: Array<{
        orderItemId: string;
        fromCheckIn: string;
        toCheckIn: string;
        fromCheckOut: string | null;
        toCheckOut: string | null;
      }> = [];
      if (scheduleChanged) {
        await tx.passenger.updateMany({
          where: { orderId },
          data: { pnr: null, eticketNumber: null },
        });

        // 被改的是去程还是回程：按**改期前**的航段顺序判定（此刻订单行已写成新班次，
        // 再按 departureTime 排序可能已经换位），故用行 id 与改期前那份排序结果比对。
        const legItemsBefore = await tx.orderItem.findMany({
          where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: {
            id: true,
            flightScheduleId: true,
            flightSchedule: { select: { departureTime: true, departureTz: true } },
          },
        });
        const rowsBefore = legItemsBefore.map((row) =>
          row.id === item.id
            ? { ...row, flightScheduleId: oldScheduleId, flightSchedule: item.flightSchedule }
            : row,
        );
        const legsBefore = determineFlightLegItems(rowsBefore);
        const invoiceReset =
          legsBefore.return?.id === item.id
            ? { returnInvoiced: false }
            : legsBefore.outbound?.id === item.id
              ? { outboundInvoiced: false }
              : null;
        if (invoiceReset) {
          await tx.order.update({ where: { id: orderId }, data: invoiceReset });
        }

        // ── 3c. 酒店入住日期随出发日平移（0830 公测反馈）────────────────────────
        // 改期只搬机票行，酒店行的 hotelCheckIn/hotelCheckOut 原地不动 → 分房表按入住日
        // 归 sheet，客人仍挂在旧日期下（导旧日期有他、导新日期没他）。口径：整单「最早航段
        // 的出发地当地日」平移了 N 天（≠0），同单全部占房行的入住/离店同步平移 N 天——
        // 晚数不变、行价/间数一律冻结（与酒店改期的甲案同哲学，晚数没变也无差价可谈）。
        // 只改回程不动最早出发日 → 不平移（离店是否顺延涉及晚数与差价，留给「酒店改期」人工办）。
        // 新日期房量装不下 → 抛错整事务回滚，改期不成立（先协调房再改）。
        // 纠错入口（correction）同样适用：录错班次连带盖错的入住日期一并归位。
        const earliestLocalDate = (
          rows: Array<{ flightSchedule: { departureTime: Date; departureTz?: string | null } | null }>,
        ): string | null => {
          const days = rows
            .filter((r) => r.flightSchedule?.departureTime)
            .map((r) => localDateISO(r.flightSchedule!.departureTime, r.flightSchedule!.departureTz));
          return days.length > 0 ? days.sort()[0] : null;
        };
        const departBefore = earliestLocalDate(rowsBefore);
        const departAfter = earliestLocalDate(legItemsBefore);
        const deltaDays =
          departBefore && departAfter
            ? Math.round(
                (new Date(`${departAfter}T00:00:00.000Z`).getTime() -
                  new Date(`${departBefore}T00:00:00.000Z`).getTime()) /
                  (24 * 60 * 60 * 1000),
              )
            : 0;
        if (deltaDays !== 0) {
          const hotelRows = (
            await tx.orderItem.findMany({
              where: {
                orderId,
                hotelCheckIn: { not: null },
                OR: [{ hotelRoomTypeId: { not: null } }, { randomStarTier: { not: null } }],
              },
              select: {
                id: true,
                description: true,
                hotelRoomTypeId: true,
                randomStarTier: true,
                hotelCheckIn: true,
                hotelCheckOut: true,
                roomsBilled: true,
              },
            })
          ) // 防御性复筛（与 where 同条件）：单测 mock 的 findMany 不认 where，会把机票行也吐回来
            .filter((r) => r.hotelCheckIn && (r.hotelRoomTypeId || r.randomStarTier != null));
          if (hotelRows.length > 0) {
            const shiftDay = (d: Date): Date => new Date(d.getTime() + deltaDays * 24 * 60 * 60 * 1000);
            const shifted = hotelRows.map((row) => ({
              row,
              newCheckIn: shiftDay(row.hotelCheckIn!),
              newCheckOut: row.hotelCheckOut ? shiftDay(row.hotelCheckOut) : null,
            }));
            // 新区间房量闸（与建单/改档同一对闸，自带同酒店/同档归并防「各判各的」漏判）：
            // excludeOrderId 排除本单现占房 = 先释放旧区间，再按新区间前瞻判定。
            const prospectiveStays = shifted.map((s) => ({
              hotelRoomTypeId: s.row.hotelRoomTypeId,
              hotelCheckIn: s.newCheckIn,
              hotelCheckOut: s.newCheckOut,
              roomsBilled: s.row.roomsBilled == null ? null : Number(s.row.roomsBilled.toString()),
              randomStarTier: s.row.randomStarTier,
            }));
            const orderPassengers = await tx.passenger.findMany({
              where: { orderId },
              select: { gender: true },
            });
            try {
              await assertHotelStaysFitWithinTx(
                tx,
                prospectiveStays,
                orderPassengers.map((p) => ({ gender: p.gender ?? undefined })),
                { excludeOrderId: orderId },
              );
              await assertRandomTierStaysFitWithinTx(tx, prospectiveStays, {
                excludeOrderId: orderId,
              });
            } catch (err) {
              if (err instanceof BadRequestError) {
                throw new BadRequestError(
                  `改期需同步酒店入住日期（随出发日平移 ${deltaDays > 0 ? '+' : ''}${deltaDays} 天），新日期房量不足，本次改期已整体取消：${err.message}`,
                );
              }
              throw err;
            }
            for (const s of shifted) {
              const nights = s.newCheckOut
                ? buildStayNightDates(s.newCheckIn, s.newCheckOut).length
                : 0;
              await tx.orderItem.update({
                where: { id: s.row.id },
                data: {
                  hotelCheckIn: s.newCheckIn,
                  ...(s.newCheckOut ? { hotelCheckOut: s.newCheckOut } : {}),
                  // description 里的日期/晚数段就地改写（自由文本无该段则原样保留）
                  ...(s.newCheckOut && nights > 0
                    ? {
                        description: rewriteHotelStayDescription(s.row.description, {
                          checkIn: formatDateOnly(s.newCheckIn),
                          checkOut: formatDateOnly(s.newCheckOut),
                          nights,
                        }),
                      }
                    : {}),
                },
              });
              hotelDateSync.push({
                orderItemId: s.row.id,
                fromCheckIn: formatDateOnly(s.row.hotelCheckIn!),
                toCheckIn: formatDateOnly(s.newCheckIn),
                fromCheckOut: s.row.hotelCheckOut ? formatDateOnly(s.row.hotelCheckOut) : null,
                toCheckOut: s.newCheckOut ? formatDateOnly(s.newCheckOut) : null,
              });
            }
          }
        }
      }

      // ── 4. 改期立减取消补差 + 手填改期费（两笔分别留流水）──
      // 改期后原立减不随新日期重新命中：只撤销订单上尚未撤销的快照行，
      // 并把等额补差记入 adjustmentCny。行级 revoked 标记保证同单二次改期幂等。
      let adjustmentDelta = input.guard?.correction ? 0 : feeCny;
      let adjustmentLog = order.adjustments;
      if (!sameSeat && !input.guard?.correction) {
        // 立减只挂在套餐地面价上：纯机票行改期与立减无关。
        if (item.bundleId) {
          const discountRows =
            (await tx.orderItem.findMany({
              where: { orderId, kind: OrderItemKind.DISCOUNT },
              select: { id: true, amount: true, metadata: true },
            })) ?? [];
          for (const discountRow of discountRows) {
            const rawMetadata = discountRow.metadata;
            const metadata =
              rawMetadata != null && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
                ? (rawMetadata as Record<string, unknown>)
                : {};
            if (metadata.settlementDiscount !== true || metadata.settlementDiscountRevoked === true) {
              continue;
            }
            const discountBundleId =
              typeof metadata.bundleId === 'string' ? metadata.bundleId : null;
            if (discountBundleId && discountBundleId !== item.bundleId) continue;
            if (!discountBundleId) {
              // eslint-disable-next-line no-console
              console.warn('[orders] settlement discount row missing bundleId snapshot; revoking defensively', {
                orderId,
                orderItemId: discountRow.id,
                targetBundleId: item.bundleId,
              });
            }
            const amountCny = Math.abs(Number(discountRow.amount) || 0);
            await tx.orderItem.update({
              where: { id: discountRow.id },
              data: {
                metadata: { ...metadata, settlementDiscountRevoked: true } as Prisma.InputJsonValue,
              },
            });
            if (amountCny <= 0) continue;
            adjustmentDelta += amountCny;
            adjustmentLog = appendAdjustment(adjustmentLog, {
              type: 'RESCHEDULE_DISCOUNT_REVOKE',
              label: `改期立减取消补差 ¥${amountCny}`,
              amountCny,
              at: new Date().toISOString(),
              by: actor.userId,
            }) as unknown as Prisma.JsonValue;
          }
        }
      }
      // feeCny 可正可负（改到贵班次补差 / 改到便宜班次退差），故判 !== 0 而不是 > 0。
      // 默认名从「改期费」改为「改期差价」——它现在两个方向都用。
      if (feeCny !== 0 && !input.guard?.correction) {
        adjustmentLog = appendAdjustment(adjustmentLog, {
          type: 'RESCHEDULE_FEE',
          label: input.feeLabel || '改期差价',
          amountCny: feeCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
        }) as unknown as Prisma.JsonValue;
      }
      // 负差价把 adjustmentCny 往下压（应付随之减少）——不夹 0，与换酒店差价 / 酒店改期差价
      // 完全同一口径（那两处也是直接 order.adjustmentCny + feeCny）。夹 0 会让「改到便宜班次
      // 退差」在合计为负时悄悄吞掉一部分，客人对不上账。
      if (adjustmentDelta !== 0) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            adjustmentCny: order.adjustmentCny + adjustmentDelta,
            adjustments: adjustmentLog as unknown as Prisma.InputJsonValue,
          },
        });
      }

      // ── 5. 仅在状态机允许时推进到 CHANGED（不破坏状态机）──
      // 追加 scheduleChanged 条件：「已改期」是航段真的换过的派生（_updateStatusWithinTx 的
      // CHANGED 派生闸认的就是本函数落的 flightChanged 标记）。只收差价、不换班次的调用
      // 没有航变可言，也没落标记 —— 不推状态，否则会撞上自家的闸、把整笔改期回滚掉，
      // 运营只会看到一句「请先用改期把航段改到新班次」的自相矛盾报错。
      let statusChanged = false;
      if (
        scheduleChanged &&
        !input.guard?.correction &&
        order.status !== OrderStatus.CHANGED &&
        ALLOWED_TRANSITIONS[order.status].includes(OrderStatus.CHANGED)
      ) {
        await this._updateStatusWithinTx(
          tx,
          orderId,
          OrderStatus.CHANGED,
          { userId: actor.userId, role: actor.role, actorType: 'USER' },
          input.note ? `改期（${input.note}）` : '改期',
          [], // 改期不产生履约任务
        );
        statusChanged = true;
      }

      // 把审计需要的「原/新」明细返回到 tx 外（出发时间另查）。
      // 直接 return 而非写模块级单例，避免并发改期互相覆盖。
      return {
        orderItemId: item.id,
        oldScheduleId,
        oldCabin,
        newScheduleId,
        newCabin,
        statusChanged,
        hotelDateSync,
      };
    });

    try {
      // 审计明细：原/新出发时间（事务外查，避免污染事务）
      const [fromSched, toSched, finalOrder] = await Promise.all([
        prisma.flightSchedule.findUnique({
          where: { id: scratch.oldScheduleId },
          select: { departureTime: true },
        }),
        prisma.flightSchedule.findUnique({
          where: { id: scratch.newScheduleId },
          select: { departureTime: true },
        }),
        prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_FULL_INCLUDE }),
      ]);

      return {
        // 对外脱敏：改期（AGENT/CUSTOMER 侧也有入口）的返回按操作者角色脱敏。
        order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
        audit: {
          orderNumber: finalOrder.orderNumber,
          orderItemId: scratch.orderItemId,
          fromScheduleId: scratch.oldScheduleId,
          fromCabin: scratch.oldCabin,
          fromDeparture: fromSched?.departureTime ?? null,
          toScheduleId: scratch.newScheduleId,
          toCabin: scratch.newCabin,
          toDeparture: toSched?.departureTime ?? null,
          feeCny,
          statusChanged: scratch.statusChanged,
          hotelDateSync: scratch.hotelDateSync,
        },
      };
    } catch (err) {
      // 事务已经提交；为批量入口保留定位上下文，允许它回读确认实际已生效。
      if (err && (typeof err === 'object' || typeof err === 'function')) {
        rescheduleCommittedContexts.set(err, scratch);
      }
      throw err;
    }
  }

  /**
   * 售后升舱：把订单里某条**经济舱**机票行就地升到商务舱，并按单一差价源自动计费。
   *
   * 与「改期」的分工：改期解决**航变/换班次**（可顺带改舱位、差价手填进改期费）；本方法解决
   * **纯升舱**——不换班次、不手填金额，差价由服务端按 `Flight.businessUpgradeCnyPerLeg`
   * （¥/程/座，与建单加购升舱同一个配置源）× 该行人数权威计算，客户端传不进金额。
   *
   * 单事务内：
   *   1. Order 行 FOR UPDATE（与改期/超时释放/到账入账同一把行锁，座位与金额都要串行）。
   *   2. 守卫：资金闸（回收站/已取消/已退款/超时单拒绝）+ 收款复核锁 + 占座态 + 行合法性。
   *   3. 座位对称搬移：ECONOMY 放座（floored）→ BUSINESS 原子 CAS 扣座；商务舱不足 → 抛错整事务回滚。
   *   4. 该行 flightCabin→BUSINESS，description 刷新舱位字样（快照文本，避免列表仍显示「经济舱」）。
   *   5. 新增一条 kind=UPGRADE_CHANGE 行（升舱收入科目），amount = 差价；重算 order.subtotal/total。
   *   6. **订单状态不动**（升舱不是改签，不推 CHANGED）。
   *
   * 套餐单（该行带 bundleId / 建单时已拆过商务舱座）本次不支持：套餐升舱有自己的份数与拆座模型，
   * 走这里会把两套口径搅在一起。返回 400 引导人工处理。
   */
  async upgradeOrderItemCabin(
    orderId: string,
    orderItemId: string,
    input: { note?: string },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      upgradeItemId: string;
      scheduleId: string;
      fromCabin: CabinClass;
      toCabin: CabinClass;
      quantity: number;
      upgradeCnyPerLeg: number;
      diffCny: number;
      subtotalBefore: number;
      subtotalAfter: number;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可升舱');
    }

    const scratch = await prisma.$transaction(async (tx) => {
      // 与改期/补录地面项同一把 Order 行锁：座位搬移 + 订单总额重算都要与并发写严格串行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          paymentsLocked: true,
          subtotal: true,
          total: true,
          items: { select: { amount: true } },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // 资金闸：升舱会抬 total，与补录地面项/调价同源守卫——回收站单、已取消/已退款/超时/草稿单一律拒绝。
      assertOrderAcceptsFunds(order);
      // 收款复核锁：金额要变，锁定态下拒绝（与人工录收款同口径，解锁需审计留痕）。
      if (order.paymentsLocked) {
        throw new ConflictError('收款已锁定（财务复核完成），请先解锁再升舱');
      }
      // 占座态守卫：升舱要「放经济舱座 + 拿商务舱座」，只有订单当前真的持有座位时才成立。
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可升舱：仅占座中的有效订单可升舱`,
        );
      }

      const item = await tx.orderItem.findUnique({
        where: { id: orderItemId },
        select: {
          id: true,
          orderId: true,
          kind: true,
          description: true,
          quantity: true,
          flightScheduleId: true,
          flightCabin: true,
          bundleId: true,
          metadata: true,
        },
      });
      if (!item || item.orderId !== orderId) {
        throw new NotFoundError('订单项不存在或不属于该订单');
      }
      if (item.kind !== OrderItemKind.FLIGHT || !item.flightScheduleId || !item.flightCabin) {
        throw new BadRequestError('只能对机票行（FLIGHT）升舱');
      }
      // 套餐机票腿：升舱份数/拆座由套餐加购模型管，售后升舱本次不覆盖。
      const meta = (item.metadata ?? {}) as Record<string, unknown> & { businessUpgradeCount?: unknown };
      const bundleUpgradeCount = typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
      if (item.bundleId || bundleUpgradeCount > 0) {
        throw new BadRequestError('套餐订单的机票行暂不支持一键升舱，请联系技术处理');
      }
      if (item.flightCabin !== CabinClass.ECONOMY) {
        throw new BadRequestError(
          `该行当前是${CABIN_ZH_LABEL[item.flightCabin] ?? item.flightCabin}，只有经济舱行可升舱到商务舱`,
        );
      }

      // 差价源：服务端权威取价（客户端传不进金额）。
      const schedule = await tx.flightSchedule.findUnique({
        where: { id: item.flightScheduleId },
        select: { id: true, flight: { select: { businessUpgradeCnyPerLeg: true } } },
      });
      const upgradeCnyPerLeg = schedule?.flight?.businessUpgradeCnyPerLeg ?? 0;
      if (upgradeCnyPerLeg <= 0) {
        throw new BadRequestError('该航班未配置商务舱差价，请先在航班管理维护');
      }
      const quantity = item.quantity;
      const diffCny = computeCabinUpgradeDiffCny(upgradeCnyPerLeg, quantity);

      // ── 座位对称搬移（同事务原子；任一步失败整单回滚，绝不出现「经济舱放了、商务舱没拿到」）──
      // 放座用 floored 版本（与状态机释放同口径，不会把 sold 打成负数）；拿座用 CAS（最终防超售）。
      await releaseSeatFloored(tx, item.flightScheduleId, CabinClass.ECONOMY, quantity);
      try {
        await takeSeatWithinTx(tx, item.flightScheduleId, CabinClass.BUSINESS, quantity, null);
      } catch (e) {
        // takeSeatWithinTx 的文案面向改期场景（「改期目标班次售罄」），这里换成升舱语境
        // ——错误类型不变（仍是 409），余位数字重新取一次，运营看到的就是本班次商务舱实况。
        if (e instanceof ConflictError) {
          const [businessSeat, lockedAgg] = await Promise.all([
            tx.flightSeatClass.findFirst({
              where: { scheduleId: item.flightScheduleId, cabin: CabinClass.BUSINESS },
              select: { capacity: true, sold: true },
            }),
            // 余位口径与 CAS 一致：他人未过期的 ACTIVE 锁位同样占着位子，不能算作「还剩」。
            tx.seatLock.aggregate({
              _sum: { qty: true },
              where: {
                seatClass: { scheduleId: item.flightScheduleId, cabin: CabinClass.BUSINESS },
                status: SeatLockStatus.ACTIVE,
                expiresAt: { gt: new Date() },
              },
            }),
          ]);
          const locked = lockedAgg._sum.qty ?? 0;
          const held = await heldSeatsForCabin(tx, item.flightScheduleId, CabinClass.BUSINESS);
          const remain = businessSeat
            ? Math.max(0, businessSeat.capacity - businessSeat.sold - locked - held)
            : 0;
          throw new ConflictError(
            `商务舱余位不足：升舱需要 ${quantity} 座，该班次商务舱仅剩 ${remain} 座`,
          );
        }
        throw e;
      }

      // ── 该行就地改舱 + 刷新描述快照（不改 amount：机票基础价不重算，差价单独成行）──
      const newDescription = buildUpgradedCabinDescription(item.description);
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          flightCabin: CabinClass.BUSINESS,
          description: newDescription,
          metadata: {
            ...meta,
            cabinUpgrade: {
              at: new Date().toISOString(),
              by: actor.userId,
              fromCabin: CabinClass.ECONOMY,
              toCabin: CabinClass.BUSINESS,
              upgradeCnyPerLeg,
              quantity,
              diffCny,
              note: input.note ?? null,
            },
          } as Prisma.InputJsonValue,
        },
      });

      // ── 差价成一条独立收入行（科目 UPGRADE_CHANGE = 升舱/改期收入）──
      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: OrderItemKind.UPGRADE_CHANGE,
          description: `升舱商务 ×${quantity}人`,
          quantity,
          unitPrice: new Prisma.Decimal(upgradeCnyPerLeg),
          amount: new Prisma.Decimal(diffCny),
          metadata: {
            source: 'CABIN_UPGRADE',
            sourceItemId: item.id,
            flightScheduleId: item.flightScheduleId,
            fromCabin: CabinClass.ECONOMY,
            toCabin: CabinClass.BUSINESS,
            upgradeCnyPerLeg,
            note: input.note ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      // ── 订单总额：与补录地面项同一口径（重算商品行合计，不走 adjustmentCny）──
      const subtotalBefore = round2(
        order.items.reduce((sum, row) => sum + Number(row.amount.toString()), 0),
      );
      const subtotalAfter = round2(subtotalBefore + diffCny);
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(subtotalAfter),
          total: new Prisma.Decimal(subtotalAfter),
        },
      });

      // 订单状态刻意不动：升舱不是改签，推 CHANGED 会污染改签流程与状态统计。
      return {
        orderNumber: order.orderNumber,
        orderItemId: item.id,
        upgradeItemId: created.id,
        scheduleId: item.flightScheduleId,
        fromCabin: CabinClass.ECONOMY,
        toCabin: CabinClass.BUSINESS,
        quantity,
        upgradeCnyPerLeg,
        diffCny,
        subtotalBefore,
        subtotalAfter,
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: scratch,
    };
  }

  /**
   * 换人：把订单里某位出行人就地换成新人（改身份字段），并按需重置开票/签证状态、加换人费。
   *
   * body：{ lastName?, firstName?, fullName?, documentNumber?, dateOfBirth?, gender?,
   *         nationality?, resetInvoice?, resetVisa?, feeCny?, feeLabel?, note? }
   *
   * 单事务内：
   *   1. 更新该乘客的身份字段（仅传入的字段；fullName/姓名拆分与下单口径一致）。
   *   2. resetInvoice → order.invoiceStatus = NONE（新出行人需重新开票）。
   *   3. resetVisa → 该订单所有 VISA 履约任务回到 PENDING（新出行人需重新送签）。
   *   4. feeCny>0 → order.adjustmentCny += feeCny + adjustments 流水（SWAP_FEE）。
   *
   * 返回更新后的订单（serializeOrder）+ 审计用的原/新身份。
   */
  async swapPassenger(
    orderId: string,
    passengerId: string,
    input: {
      lastName?: string;
      firstName?: string;
      fullName?: string;
      chineseName?: string;
      documentNumber?: string;
      dateOfBirth?: string;
      gender?: import('@prisma/client').Gender;
      nationality?: string;
      // title/passengerType/visaExempt/singleRoom 已由 swapPassengerBodySchema 暴露透传；
      // 真换人时用它们作为「显式新值」覆盖默认清洗值（前向兼容：不传则保持既有清洗行为）。
      title?: string;
      passengerType?: PassengerType;
      visaExempt?: boolean;
      singleRoom?: boolean;
      resetInvoice?: boolean;
      resetVisa?: boolean;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      passengerId: string;
      before: { fullName: string; documentNumber: string };
      after: { fullName: string; documentNumber: string };
      resetInvoice: boolean;
      resetVisa: boolean;
      visaTasksReset: number;
      feeCny: number;
      // 证件号变化触发的换人清洗：已清除旧出行人残留的生日/护照/签证/出生地信息
      clearedProfile: boolean;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可换人');
    }
    const feeCny = Math.max(0, Math.trunc(input.feeCny ?? 0));

    const result = await prisma.$transaction(async (tx) => {
      // Order 行锁（与改期 rescheduleOrderItem / worker 超时释放 / 到账入账同一把 FOR UPDATE 行锁）：
      // 换人要读-改-写 adjustmentCny/adjustments，无锁会与并发改期/换人 lost-update（一方覆盖另一方的流水）。
      const orderRows = await tx.$queryRaw<
        Array<{
          id: string;
          adjustmentCny: number;
          adjustments: Prisma.JsonValue;
          status: OrderStatus;
          deletedAt: Date | null;
        }>
      >`SELECT id, "adjustmentCny", adjustments, status, "deletedAt" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = orderRows[0];
      if (!order) throw new NotFoundError('订单不存在');

      // ── 有效订单守卫（HIGH 修复）：与改期 / 升舱同款双闸 ────────────────────
      // 换人不只是改个名字：它会通过 feeCny 往 adjustmentCny 里加收换人费，还会重置开票位与签证任务。
      // 在已取消 / 已退款 / 超时 / 回收站单上换人 → 这些死单会凭空长出一笔「欠款」并重新进应收报表，
      // 已结清的退款单账面被改写。所以入口硬性要求：deletedAt=null 且 status ∈ 占座态。
      // 读的是刚 FOR UPDATE 锁住的那一行，与并发状态流转严格串行（不会读到过期快照）。
      if (order.deletedAt) {
        throw new BadRequestError('订单在回收站（已软删），不可换人；如需操作请先恢复');
      }
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可换人：仅占座中的有效订单可换人（已取消/已退款/超时订单请勿换人）`,
        );
      }

      const passenger = await tx.passenger.findUnique({
        where: { id: passengerId },
        // visaExempt：换人价回滚要读旧客的自备签状态（true→false 时把减免加回来，见下方 1d）。
        // passengerType：出生日期变化时权威重派生的回退口径（见下方 1b2）——同一人只是改错生日
        // 时，不该把已有的儿童/婴儿类型误判丢回默认成人。
        select: {
          id: true,
          orderId: true,
          fullName: true,
          documentNumber: true,
          visaExempt: true,
          passengerType: true,
        },
      });
      if (!passenger || passenger.orderId !== orderId) {
        throw new NotFoundError('出行人不存在或不属于该订单');
      }
      const beforeIdentity = {
        fullName: passenger.fullName,
        documentNumber: passenger.documentNumber,
      };

      // ── 1. 更新身份字段（仅传入的字段；fullName 时按下单口径自动拆姓/名兜底）──
      const data: Prisma.PassengerUpdateInput = {};
      if (input.fullName !== undefined) {
        data.fullName = input.fullName;
        // 客户端没显式给 lastName/firstName 时，用 fullName 自动拆（与 passengerToData 同口径）
        if (input.lastName === undefined || input.firstName === undefined) {
          const { lastName: autoLast, firstName: autoFirst } = splitPassengerFullName(
            input.fullName,
          );
          if (input.lastName === undefined) data.lastName = autoLast || null;
          if (input.firstName === undefined) data.firstName = autoFirst || null;
        }
      }
      if (input.lastName !== undefined) data.lastName = input.lastName;
      if (input.firstName !== undefined) data.firstName = input.firstName;
      if (input.chineseName !== undefined) data.chineseName = input.chineseName;
      if (input.documentNumber !== undefined) data.documentNumber = input.documentNumber;
      if (input.dateOfBirth !== undefined) data.dateOfBirth = new Date(input.dateOfBirth);
      if (input.gender !== undefined) data.gender = input.gender;
      if (input.nationality !== undefined) data.nationality = input.nationality;
      if (input.title !== undefined) data.title = input.title;
      if (input.passengerType !== undefined) data.passengerType = input.passengerType;
      if (input.visaExempt !== undefined) data.visaExempt = input.visaExempt;
      if (input.singleRoom !== undefined) data.singleRoom = input.singleRoom;

      // ── 1b. 换人检测：证件号变化 = 真换人（非改错别字）→ 清除旧出行人残留的
      //        生日 / 护照 / 签证 / 出生地 / 票号 / 乘客级选项，避免新出行人套用前一个人的证件与状态。
      //        「除非请求同时提供了新值」：上面已按 input 赋过新值的字段（chineseName / gender /
      //        dateOfBirth / title / passengerType / visaExempt / singleRoom）保留新值；本请求没带的一律清洗。
      //        证件号没变（改拼写）不触发。
      const newDocument = input.documentNumber?.trim();
      const documentChanged =
        newDocument !== undefined && newDocument !== '' && newDocument !== passenger.documentNumber;
      if (documentChanged) {
        // 表单可编辑但本次没填 → 显式置空（不残留前一个人的值）
        if (data.chineseName === undefined) data.chineseName = null;
        if (data.gender === undefined) data.gender = null;
        // 生日随人走：带了新值即用新值（上面已赋），否则置空——列已改为可空
        // （migration 20260708140000_passenger_dob_nullable），彻底解决换人残留旧生日。
        if (data.dateOfBirth === undefined) data.dateOfBirth = null;
        data.placeOfBirth = null;
        // 护照证件信息随人走
        data.passportPhotoUrl = null;
        data.passportIssueDate = null;
        data.passportIssueCountry = null;
        data.passportIssuePlace = null;
        data.passportExpiry = null;
        // 已签发签证信息随人走
        data.visaNumber = null;
        data.visaType = null;
        data.visaIssueDate = null;
        data.visaEffectiveDate = null;
        data.visaExpiry = null;
        data.visaPlaceOfIssue = null;
        data.visaCountryOfApplication = null;
        // 航司票号随人走：旧人的 PNR / 电子票号绝不能留给新人（否则行程单/出票照印旧票号）。
        data.pnr = null;
        data.eticketNumber = null;
        // 乘客级选项回落安全默认（未显式带新值时）：
        //   · visaExempt=false → 新人默认「随套餐办签」，不会被签证台漏掉（旧人自备签的 true 绝不继承）。
        //   · singleRoom=false → 新人默认「拼房」（业务默认；房控按新人重新分房）。
        //   · title=null / passengerType=ADULT（schema 默认）→ 敬称/乘客类型随人走，不继承旧人。
        if (data.visaExempt === undefined) data.visaExempt = false;
        if (data.singleRoom === undefined) data.singleRoom = false;
        if (data.title === undefined) data.title = null;
        if (data.passengerType === undefined) data.passengerType = PassengerType.ADULT;
        // 说明：nationality 是必填非空列，无法「置空」；请求带了新值即用新值（上面已赋），
        // 未带时只能保留旧值（不猜默认国籍——猜错会污染出票/签证）。彻底根治需 schema 层在真换人时
        // 强制 nationality，留待拥有 orders.schemas.ts 的下一棒收口。
      }

      // ── 1b2. 出行人类型服务端权威派生（覆盖客户端传值）：出生日期变化（改错别字或真换人都算）时，
      //        若订单能定出最早出发日（机票行），按「出发日 − 出生日期」用 derivePtcByAge 重算
      //        passengerType 并覆盖 —— 与建单（createOrder → passengerToData）同一口径的权威兜底，
      //        入口层已尽量派生，这里是权威兜底，堵住换人/改生日时手选类型不跟着改的口子。
      //        无新出生日期（本次未改）或订单定不出出发日 → 保留上面已赋的值（客户端传值 / 换人默认）。
      if (data.dateOfBirth !== undefined && data.dateOfBirth !== null) {
        const flightItems = await tx.orderItem.findMany({
          where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: { flightSchedule: { select: { departureTime: true } } },
        });
        const departureDate = earliestFlightDeparture(
          flightItems.map((it) => ({ kind: 'FLIGHT', flightSchedule: it.flightSchedule })),
        );
        if (departureDate) {
          // 回退口径：本次显式给的新值 > 已有的旧值（同一人订正生日不该丢类型）> 兜底成人。
          const fallbackPassengerType =
            (data.passengerType as PassengerType | undefined) ??
            input.passengerType ??
            passenger.passengerType ??
            PassengerType.ADULT;
          data.passengerType = ptcToPassengerType(
            derivePtcByAge(data.dateOfBirth as Date, departureDate, fallbackPassengerType),
          );
        }
      }

      // ── 1c. 重复证件号校验（与 createOrder 同口径，swap 之前缺失）：真换人时，换入的证件号
      //        不得已存在于「同航班班次的占座中订单」里（否则同一人同班次被重复占座/出票）。
      if (documentChanged) {
        const flightItems = await tx.orderItem.findMany({
          where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
          select: { flightScheduleId: true },
        });
        const scheduleIds = flightItems
          .map((i) => i.flightScheduleId)
          .filter((sid): sid is string => sid !== null);
        if (scheduleIds.length > 0) {
          const dup = await tx.passenger.findFirst({
            where: {
              documentNumber: newDocument,
              id: { not: passengerId }, // 排除被换的这条本身
              order: {
                status: { in: SEAT_HOLDING_STATUSES },
                deletedAt: null,
                items: { some: { flightScheduleId: { in: scheduleIds } } },
              },
            },
            select: { order: { select: { orderNumber: true } } },
          });
          if (dup) {
            throw new DuplicatePassengerError(
              `换入的证件号 ${newDocument} 已在同航班的有效订单（${dup.order.orderNumber}）中，不能重复换入`,
              { conflicts: [{ documentNumber: newDocument, orderNumbers: [dup.order.orderNumber] }] },
            );
          }
        }
      }

      await tx.passenger.update({ where: { id: passengerId }, data });

      // ── 1d. 换人价回滚（自备签 true→false 时把旧客的自备签减免加回来）──────────────────
      // 证件变更会把 visaExempt 强制回落 false（新客进签证台随团办签，见上方 1b），但订单 BUNDLE 行
      // 仍扣着旧客的自备签减免 selfVisaDeductTotal → 新客要送签、钱却少收。这里按「每人自备签减免」把
      // 减免精确撤销（正向 adjustmentCny → effectivePayable/尾款自然回升），与改期费/换人费同款结构化留痕。
      // 选型：不重算整条 BUNDLE 行金额（重算含房晚/升舱/占座多输入、风险高），只回滚这笔每人减免——
      //   自洽且最小侵入；减免本就是按人计（每人一次 selfVisaDeductCny），撤一人即加回一份。
      // 只处理 true→false（少收的钱路径）；false→true（新客改自备签）不在此自动打折，避免误减，
      //   需要时走显式重定价。
      const oldVisaExempt = passenger.visaExempt === true;
      const newVisaExempt = data.visaExempt !== undefined ? data.visaExempt === true : oldVisaExempt;
      // 幂等：同一乘客的自备签减免只冲一次。多次换人 true→false→true→false 会反复命中 true→false，
      // 若不去重会每次都把减免加回来 → 过冲多收。检查 order.adjustments 是否已有该乘客的
      // SWAP_VISA_DEDUCT_REVERSAL（下方入账时按 passengerId 留痕），有则本次不再冲。
      const priorAdjustments = Array.isArray(order.adjustments)
        ? (order.adjustments as unknown as OrderAdjustmentEntry[])
        : [];
      const alreadyReversedForPassenger = priorAdjustments.some(
        (e) => e?.type === 'SWAP_VISA_DEDUCT_REVERSAL' && e?.passengerId === passengerId,
      );
      let visaDeductReversalCny = 0;
      if (oldVisaExempt && !newVisaExempt && !alreadyReversedForPassenger) {
        const bundleItems = await tx.orderItem.findMany({
          where: { orderId, kind: OrderItemKind.BUNDLE },
          select: { metadata: true },
        });
        for (const bi of bundleItems) {
          const addOns = (
            bi.metadata as {
              addOns?: { selfProvidedVisaCount?: unknown; selfVisaDeductCny?: unknown };
            } | null
          )?.addOns;
          const count = typeof addOns?.selfProvidedVisaCount === 'number' ? addOns.selfProvidedVisaCount : 0;
          const rate = typeof addOns?.selfVisaDeductCny === 'number' ? addOns.selfVisaDeductCny : 0;
          // 只对「确实按自备签给过减免」的套餐行回滚一份每人减免（count>0 且 rate>0）。
          if (count > 0 && rate > 0) {
            visaDeductReversalCny += Math.max(0, Math.trunc(rate));
          }
        }
      }

      // ── 2. resetInvoice → 开票状态回 NONE + 三维开票位（去/回/系统）一并清零（新出行人重开票）──
      if (input.resetInvoice) {
        await tx.order.update({
          where: { id: orderId },
          data: {
            invoiceStatus: InvoiceStatus.NONE,
            outboundInvoiced: false,
            returnInvoiced: false,
            systemInvoiced: false,
          },
        });
      }

      // ── 3. resetVisa → 该订单 VISA 履约任务回 PENDING（新出行人重新送签）──
      //   只重置活动态（IN_PROGRESS/CONFIRMED/FAILED）→ PENDING；绝不碰 CANCELLED。
      //   CANCELLED 是取消族订单终态化任务（见 _updateStatusWithinTx P2-16）留下的终态记录——
      //   若把它一并 PENDING 化，会「复活」已取消订单的履约任务（看板凭空冒出可执行任务、统计口径错乱）。
      //   与 A2 一致：CANCELLED 永远冻结为终态，任何"重开/复活"路径都不得触碰。
      let visaTasksReset = 0;
      if (input.resetVisa) {
        const reset = await tx.fulfillmentTask.updateMany({
          where: {
            type: FulfillmentType.VISA_APPLICATION,
            orderItem: { orderId },
            status: { notIn: [FulfillmentStatus.PENDING, FulfillmentStatus.CANCELLED] },
          },
          data: {
            status: FulfillmentStatus.PENDING,
            startedAt: null,
            completedAt: null,
            failureReason: null,
          },
        });
        visaTasksReset = reset.count;
      }

      // ── 3b. 自备签变更 → 签证任务事件驱动同步（条10）────────────────────────
      // 换人通道是「乘客级自备签」在存量订单上的唯一写入口（改自备签的 PATCH 会被
      // resolvePassengerPatchChannel 判成换人语义、走到这里；证件号变化的真换人也会把
      // visaExempt 强制回落 false）。旧行为只补不删：全员改成自备签之后，那条 PENDING
      // 签证任务还挂在签证台上永远办不掉；反过来最后一位自备签客人换成随团办签时，
      // 又没人给他补任务。这里按权威口径重算一次，把任务对齐到最新需求。
      // 只在自备签真的变了时才跑——没变就没有新事件，不给每次换人平白加几次查询。
      if (oldVisaExempt !== newVisaExempt) {
        await syncVisaTasksForOrder(tx, orderId, { userId: actor.userId, role: actor.role });
      }

      // ── 4. 售后费用流水：换人价回滚（SWAP_VISA_DEDUCT_REVERSAL）+ 换人费（SWAP_FEE）合并写一次 ──
      // 两项都进 adjustmentCny，合并成一次 order.update（避免先后两写彼此覆盖 adjustments 数组）。
      const swapAdjustments: OrderAdjustmentEntry[] = [];
      if (visaDeductReversalCny > 0) {
        swapAdjustments.push({
          type: 'SWAP_VISA_DEDUCT_REVERSAL',
          label: '撤销自备签减免（换人转随团办签）',
          amountCny: visaDeductReversalCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
          passengerId, // 幂等去重锚点：同一乘客只冲一次
        });
      }
      if (feeCny > 0) {
        swapAdjustments.push({
          type: 'SWAP_FEE',
          label: input.feeLabel || '换人费',
          amountCny: feeCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
        });
      }
      if (swapAdjustments.length > 0) {
        const existingArr = Array.isArray(order.adjustments)
          ? (order.adjustments as Prisma.JsonArray)
          : [];
        const log = [
          ...existingArr,
          ...(swapAdjustments as unknown as Prisma.JsonArray),
        ] as Prisma.InputJsonValue;
        const delta = swapAdjustments.reduce((s, e) => s + e.amountCny, 0);
        await tx.order.update({
          where: { id: orderId },
          data: { adjustmentCny: order.adjustmentCny + delta, adjustments: log },
        });
      }

      const afterPassenger = await tx.passenger.findUniqueOrThrow({
        where: { id: passengerId },
        select: { fullName: true, documentNumber: true },
      });

      return { beforeIdentity, afterIdentity: afterPassenger, visaTasksReset, clearedProfile: documentChanged };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      // 对外脱敏：换人的返回按操作者角色脱敏（ADMIN/STAFF 全量，其余剥离内部字段 + 逐项拆价）。
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: {
        orderNumber: finalOrder.orderNumber,
        passengerId,
        before: result.beforeIdentity,
        after: {
          fullName: result.afterIdentity.fullName,
          documentNumber: result.afterIdentity.documentNumber,
        },
        resetInvoice: Boolean(input.resetInvoice),
        resetVisa: Boolean(input.resetVisa),
        visaTasksReset: result.visaTasksReset,
        feeCny,
        clearedProfile: result.clearedProfile,
      },
    };
  }

  /**
   * 建单后按人改自备签（专用端点，不复用换人通道）。
   *
   * 为什么不走换人通道：swapPassenger 的 visaExempt 透传语义有洞——false→true 不减钱、
   * true→false 走 SWAP_VISA_DEDUCT_REVERSAL 调整行且按乘客一次性幂等（反复切换会少收）、
   * BUNDLE 行 metadata.addOns 快照永不更新（套餐改档读快照会算错差额）、不碰送签进度、
   * 审计记成换人。本方法把「同一个人改办签方式」做成对称、可逆、快照同步的专用动作：
   *
   *   · 钱**不走调整行**，走「行重算」：对唯一含自备签减免的 BUNDLE 行，以翻转后的乘客现势
   *     重算 addOns breakdown 与行金额 —— 其余维度（晚数/间数/单住/升舱/儿童婴儿）一律沿用
   *     原快照口径，绝不重读现价配置；总额变化必须恰等于 ±selfVisaDeductCny（建单快照费率）×1，
   *     对不上即抛错回滚（fail-closed，交人工走调价通道）。
   *   · 两个方向都把该乘客 visaSubmissionStatus 置回 PENDING（true→false 防旧 CONFIRMED 复活
   *     污染任务派生；false→true 本就应为 PENDING，写了幂等）。
   *   · 任务联动：syncVisaTasksForOrder 对齐任务的有无，再按「按人送签」口径重派生任务状态
   *     （仅动 PENDING/IN_PROGRESS；CONFIRMED/FAILED/CANCELLED 不碰）。
   *
   * 守卫（依序）：占座态 + 未软删 → 幂等短路 → false→true 需送签进度仍为 PENDING（已在办理
   * 则批文成本已发生）→ 换人通道补过钱的乘客拒绝（防两套钱法叠加双计）→ 有钱语义时
   * 结算锁 / 开票闸 / 多条钱行拒绝。非 BUNDLE 单（纯机票/签证单等）纯改标记，不动钱。
   */
  async setPassengerVisaExempt(
    orderId: string,
    passengerId: string,
    input: {
      visaExempt: boolean;
      note?: string;
      /** 送签已在办理时的人为确认：退多少（0=不退）+ 原因。见 orders.schemas 同名字段注释。 */
      submittedOverride?: { refundCny: number; reason: string };
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    warning: string | null;
    /** 幂等短路（目标值与现值相同）：不写审计、不动钱。 */
    idempotent: boolean;
    /** 幂等短路时为 null（路由层据此跳过审计）。 */
    audit: {
      orderNumber: string;
      passengerId: string;
      before: { visaExempt: boolean; visaSubmissionStatus: string };
      after: { visaExempt: boolean; visaSubmissionStatus: string };
      /** 本次应收变化（CNY；非 BUNDLE 单恒 0）。 */
      totalDeltaCny: number;
      /** 已送签人为确认路径：实退客人金额（其余路径 null）。 */
      refundCny: number | null;
      /** 已送签人为确认路径：批文成本留存金额（其余路径 0）。 */
      retainCny: number;
    } | null;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可改乘客自备签');
    }

    const scratch = await prisma.$transaction(async (tx) => {
      // Order 行锁（与换人/改结算价同一把 FOR UPDATE）：翻转要读-改-写 BUNDLE 行金额与
      // subtotal/total，无锁会与并发改价/换人 lost-update。
      const orderRows = await tx.$queryRaw<
        Array<{
          id: string;
          orderNumber: string;
          status: OrderStatus;
          deletedAt: Date | null;
          adjustments: Prisma.JsonValue;
          adjustmentCny: number;
          settlementLocked: boolean;
          outboundInvoiced: boolean;
          returnInvoiced: boolean;
          systemInvoiced: boolean;
        }>
      >`SELECT id, "orderNumber", status, "deletedAt", adjustments, "adjustmentCny", "settlementLocked", "outboundInvoiced", "returnInvoiced", "systemInvoiced" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = orderRows[0];
      if (!order) throw new NotFoundError('订单不存在');

      // ── 1. 有效订单守卫（与换人同款双闸）──────────────────────────────
      if (order.deletedAt) {
        throw new BadRequestError('订单在回收站（已软删），不可改自备签；如需操作请先恢复');
      }
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可改自备签：仅占座中的有效订单可改（已取消/已退款/超时订单请勿改）`,
        );
      }

      const passenger = await tx.passenger.findUnique({
        where: { id: passengerId },
        select: {
          id: true,
          orderId: true,
          visaExempt: true,
          visaSubmissionStatus: true,
        },
      });
      if (!passenger || passenger.orderId !== orderId) {
        throw new NotFoundError('出行人不存在或不属于该订单');
      }

      // ── 2. 幂等短路：目标值与现值相同 → no-op（不写审计不动钱）──────────
      if (passenger.visaExempt === input.visaExempt) {
        return { noop: true as const };
      }
      const before = {
        visaExempt: passenger.visaExempt,
        visaSubmissionStatus: passenger.visaSubmissionStatus as string,
      };

      // ── 3. false→true 门槛：送签已在办理（材料准备/已送签）→ 人为确认（签证岗 0830 口径）──
      // 不硬拦也不自动退：批文成本已发生，退不退/退多少由操作人当场定（默认 0）。缺确认参数时
      // 抛带 [NEED_CONFIRM_SUBMITTED] 标记的冲突错，前端据此弹退费确认框后重试。
      const submittedInProcess =
        input.visaExempt && passenger.visaSubmissionStatus !== VisaSubmissionStatus.PENDING;
      if (submittedInProcess && !input.submittedOverride) {
        throw new ConflictError(
          '[NEED_CONFIRM_SUBMITTED] 该乘客送签已在办理（材料准备/已送签），批文成本已发生。' +
            '请确认退费金额（0 = 不退）与原因后重试。',
        );
      }

      // ── 4. 历史冲突闸（fail-closed）：换人通道时代已给该乘客补过自备签减免的钱 ──
      // 两套钱法（调整行 vs 行重算）叠加会双计，这里直接拒，交人工核对。
      const priorAdjustments = Array.isArray(order.adjustments)
        ? (order.adjustments as unknown as OrderAdjustmentEntry[])
        : [];
      const hasSwapReversal = priorAdjustments.some(
        (e) => e?.type === 'SWAP_VISA_DEDUCT_REVERSAL' && e?.passengerId === passengerId,
      );
      if (hasSwapReversal) {
        throw new ConflictError(
          '该乘客此前经换人通道调整过自备签减免，请人工核对后走调价通道处理',
        );
      }

      // ── 5. 钱（仅 BUNDLE 行有钱的语义）：预检 → 翻标记 → 行重算 ────────────
      const bundleItems = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.BUNDLE },
        select: { id: true, quantity: true, amount: true, metadata: true },
      });
      const readAddOnSnapshot = (raw: unknown): Partial<BundleAddOnBreakdown> | null => {
        const meta =
          raw != null && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
        const addOns = meta?.addOns;
        return addOns != null && typeof addOns === 'object' && !Array.isArray(addOns)
          ? (addOns as Partial<BundleAddOnBreakdown>)
          : null;
      };
      const snapshotRate = (raw: unknown): number => {
        const s = readAddOnSnapshot(raw);
        return Math.max(0, Math.trunc(Number(s?.selfVisaDeductCny ?? 0) || 0));
      };
      // 有钱语义的行：建单快照里配了自备签减免费率（>0）。费率=0 或无快照 → 纯改标记。
      const moneyLines = bundleItems.filter((it) => snapshotRate(it.metadata) > 0);
      if (moneyLines.length > 0) {
        if (order.settlementLocked) {
          throw new ConflictError('结算价已锁定，改自备签会变更套餐应收，请先解锁结算价再操作');
        }
        // 开票闸（与改结算价同口径）：发票是已交付下游的凭证，改价必须先冲开票状态再改。
        if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
          throw new ConflictError(
            '该订单已有开票记录（去程/回程/系统任一已开），改自备签会使发票与订单金额不一致。' +
              '请先在票务台把对应开票状态改回「未开」，改完后如需可重新开票。',
          );
        }
        if (moneyLines.length > 1) {
          throw new ConflictError(
            '本单存在多条含自备签减免的套餐行，系统无法自动分摊差额，请人工核对后走调价通道处理',
          );
        }
      }
      // 已送签人为确认 + 本单没有减免费率行：翻标记本就不动钱，没有"从减免里退"的来源。
      if (
        submittedInProcess &&
        input.submittedOverride &&
        moneyLines.length === 0 &&
        input.submittedOverride.refundCny > 0
      ) {
        throw new ConflictError(
          '本单套餐未配自备签减免费率，改自备签不产生退费；如需退款请走收款/调价通道',
        );
      }

      // ── 6. 写乘客标记；两个方向都把送签进度置回待处理 ─────────────────────
      // true→false：防旧 CONFIRMED 复活污染任务派生（人已换办签方式，进度从头来）；
      // false→true：门槛已保证本就是 PENDING，写入幂等。
      await tx.passenger.update({
        where: { id: passengerId },
        data: {
          visaExempt: input.visaExempt,
          visaSubmissionStatus: VisaSubmissionStatus.PENDING,
        },
      });

      // ── 5b. 行重算（唯一钱行）：以翻转后的乘客现势重算自备签人数，其余维度沿用原快照 ──
      let totalDeltaCny = 0;
      // 已送签人为确认的钱结果（仅 submittedOverride 路径有值）：客人实退 / 批文成本留存。
      let refundCnyApplied: number | null = null;
      let retainCny = 0;
      if (moneyLines.length === 1) {
        const line = moneyLines[0];
        const snapshot = readAddOnSnapshot(line.metadata)!;
        const rate = snapshotRate(line.metadata);
        const num = (v: unknown): number => Number(v ?? 0) || 0;
        const intNN = (v: unknown): number => Math.max(0, Math.trunc(num(v)));
        // 占座三计数从快照回放（缺失时回落行 quantity 的旧口径，与改档同源）。
        const occupancy = resolveBundleOccupancy(
          snapshot.adultCount != null || snapshot.childCount != null || snapshot.infantCount != null
            ? {
                adultCount: intNN(snapshot.adultCount),
                childCount: intNN(snapshot.childCount),
                infantCount: intNN(snapshot.infantCount),
                quantity: line.quantity,
              }
            : { quantity: line.quantity },
        );
        const resolvedNights = Math.max(1, Math.trunc(num(snapshot.nights) || 1));
        const bundleCfg = {
          hotelNights: resolvedNights,
          singleSupplementCnyPerNight: intNN(snapshot.singleSupplementCnyPerNight),
          businessUpgradeCnyPerLeg: intNN(snapshot.businessUpgradeCnyPerLeg),
          childSeatDiscountCnyPerPerson: intNN(snapshot.childSeatDiscountCnyPerPerson),
          infantPriceCny: intNN(snapshot.infantPriceCny),
          selfVisaDeductCny: rate,
          legs: Math.max(1, Math.trunc(num(snapshot.legs) || 1)),
        };
        const singleCount = intNN(snapshot.singleCount);
        const businessSplit: BundleBusinessUpgradeSplit = {
          outbound: intNN(snapshot.businessCountOutbound),
          return: intNN(snapshot.businessCountReturn),
        };
        const oldCount = intNN(snapshot.selfProvidedVisaCount);
        // 翻转后的乘客现势 → 权威自备签人数（与录单 priceAndValidateItems 同一纯函数）。
        const paxNow = await tx.passenger.findMany({
          where: { orderId },
          select: { visaExempt: true },
        });
        const { selfProvidedVisaCount: newCount } = derivePerPaxBundleOptions({}, paxNow);

        // hotelStamp 传 null、晚数用快照 nights：绝不重读现价配置/现房型，重算只反映
        // 「自备签人数变了」这一件事。
        const oldAddOn = computeBundleAddOn(
          bundleCfg, null, singleCount, businessSplit, occupancy, resolvedNights, oldCount,
        );
        const newAddOn = computeBundleAddOn(
          bundleCfg, null, singleCount, businessSplit, occupancy, resolvedNights, newCount,
        );
        totalDeltaCny = round2(newAddOn.total - oldAddOn.total);

        // 守恒断言：翻一个人 = 恰好一份快照费率。对不上（快照与乘客现势漂移、clamp 生效等）
        // 说明这单的钱不能自动算，抛错回滚交人工。
        const expectedDelta = input.visaExempt ? -rate : rate;
        if (totalDeltaCny !== expectedDelta) {
          throw new ConflictError(
            `自备签减免重算与建单快照不符（重算差额 ¥${totalDeltaCny}，应为 ¥${expectedDelta}），` +
              '请人工核对该单套餐快照后走调价通道处理',
          );
        }

        const oldAmount = Number(line.amount.toString());
        const newAmount = round2(oldAmount + totalDeltaCny);
        if (newAmount < 0) {
          throw new ConflictError('重算后套餐行金额为负，请人工核对后走调价通道处理');
        }
        const lineMeta = (line.metadata ?? {}) as Record<string, unknown>;
        await tx.orderItem.update({
          where: { id: line.id },
          data: {
            amount: new Prisma.Decimal(newAmount),
            // 快照同步：套餐改档等下游读 metadata.addOns.selfProvidedVisaCount，必须跟上现势。
            metadata: {
              ...lineMeta,
              addOns: newAddOn.breakdown,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        // 锁内重新聚合最新 items 算 subtotal/total（与改结算价同款，天然吃到并发已提交的改动）。
        const sumAgg = await tx.orderItem.aggregate({ where: { orderId }, _sum: { amount: true } });
        const newSubtotal = round2(
          Number((sumAgg._sum.amount ?? new Prisma.Decimal(0)).toString()),
        );
        await tx.order.update({
          where: { id: orderId },
          data: {
            subtotal: new Prisma.Decimal(newSubtotal),
            total: new Prisma.Decimal(newSubtotal),
          },
        });

        // ── 5c. 已送签人为确认的钱收口：行重算已把整份减免退了（−rate），实际只该退 refund，
        // 差额（rate−refund）作为「批文成本留存」补回应收（adjustments 流水，财务可见可查）。
        // 净效果 = 应收只降 refund。refund 超过费率直接拒（不是静默钳位——填错要看得见）。
        if (submittedInProcess && input.submittedOverride) {
          const refund = Math.trunc(input.submittedOverride.refundCny);
          if (refund > rate) {
            throw new ConflictError(`退费金额不能超过该单自备签减免费率 ¥${rate}`);
          }
          refundCnyApplied = refund;
          retainCny = rate - refund;
          if (retainCny > 0) {
            const log = appendAdjustment(order.adjustments, {
              type: 'VISA_SUBMITTED_COST_RETAIN',
              label: '已送签批文成本留存（改自备签少退）',
              amountCny: retainCny,
              at: new Date().toISOString(),
              by: actor.userId,
              note: input.submittedOverride.reason,
              passengerId,
            });
            await tx.order.update({
              where: { id: orderId },
              data: { adjustmentCny: order.adjustmentCny + retainCny, adjustments: log },
            });
          }
        }
      }

      // ── 7. 任务联动：先对齐任务的有无（补建/撤 PENDING），再按人重派生任务状态 ──
      await syncVisaTasksForOrder(tx, orderId, { userId: actor.userId, role: actor.role });

      const nonExempt = await tx.passenger.findMany({
        where: { orderId, visaExempt: false },
        select: { visaSubmissionStatus: true },
      });
      let warning: string | null = null;
      if (nonExempt.length > 0) {
        // 重派生范围：仅 PENDING/IN_PROGRESS（CONFIRMED/FAILED/CANCELLED 不动——已出结果
        // 或已终态的任务不被系统悄悄改写）。
        const derived = deriveVisaTaskStatus(nonExempt.map((p) => p.visaSubmissionStatus));
        await tx.fulfillmentTask.updateMany({
          where: {
            orderItem: { orderId },
            type: FulfillmentType.VISA_APPLICATION,
            status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
          },
          data: {
            status: derived,
            completedAt: derived === FulfillmentStatus.CONFIRMED ? new Date() : null,
          },
        });
      } else {
        // ── 8. 全员自备签但仍有非 PENDING 的签证任务（sync 按设计只撤 PENDING）→ 警示 ──
        const stuckTasks = await tx.fulfillmentTask.count({
          where: {
            orderItem: { orderId },
            type: FulfillmentType.VISA_APPLICATION,
            status: { in: [FulfillmentStatus.IN_PROGRESS, FulfillmentStatus.CONFIRMED] },
          },
        });
        if (stuckTasks > 0) {
          warning =
            '本单乘客现已全部自备签，但仍有正在办理/已办结的签证任务未撤销（系统只自动撤「待处理」的任务），请签证岗人工处置该任务及相关费用。';
        }
      }

      return {
        noop: false as const,
        orderNumber: order.orderNumber,
        before,
        totalDeltaCny,
        refundCnyApplied,
        retainCny,
        warning,
      };
    });

    // 办结派生对齐：进度被重置回待处理后，若订单的「已签证」是系统办结写的要对称撤销
    // （录单手选的已签证没有办结审计，不受影响）。放在事务外，与派生模块的调用点约定一致。
    if (!scratch.noop) {
      await syncOrderVisaCompletion(orderId, { userId: actor.userId, role: actor.role });
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    const serialized = serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role));

    if (scratch.noop) {
      return { order: serialized, warning: null, idempotent: true, audit: null };
    }
    return {
      order: serialized,
      warning: scratch.warning,
      idempotent: false,
      audit: {
        orderNumber: scratch.orderNumber,
        passengerId,
        before: scratch.before,
        after: { visaExempt: input.visaExempt, visaSubmissionStatus: VisaSubmissionStatus.PENDING },
        totalDeltaCny: scratch.totalDeltaCny,
        // 已送签人为确认（非该路径时为 null/0）：实退给客人 / 批文成本留存
        refundCny: scratch.refundCnyApplied,
        retainCny: scratch.retainCny,
      },
    };
  }

  /**
   * 换酒店：把订单里某条 HOTEL 行（或已盖章酒店的 BUNDLE 行）就地换到另一个房型/酒店，
   * 并（可选）加/减「换酒店差价」。
   *
   * 定价哲学（owner 批准 A+B）：价格默认冻结——客户已付的钱不变，换酒店只改「住哪」，
   * 绝不用新房型的 basePrice 重算 unitPrice/amount。差价是可选的人工调整，走与改期费/
   * 换人费相同的 adjustmentCny 机制，不填就是纯换房不改价。
   *
   * body：{ newHotelRoomTypeId, feeCny?, feeLabel?, note? }
   *   - orderItemId 必须属于本订单且 kind=HOTEL，或 kind=BUNDLE 且已盖章 hotelRoomTypeId。
   *   - newHotelRoomTypeId 必须存在、其酒店在架；与当前房型相同 → 400（无意义换房）。
   *
   * 「落位」（未落位随机单 → 具体酒店）走的是同一条通道：kind=HOTEL、无房型、randomStarTier
   * 非空的行（客人买的是「N 星随机」），本次把它落到具体酒店 —— 写 hotelRoomTypeId + 清
   * randomStarTier，占用从「未落位」转到该酒店。随机档余量 = 同星级酒店余量合计 − 未落位占用，
   * 故这一转：该酒店用房 +1、未落位占用 −1 ⇒ **随机档合计不变**（对账恒等）。此时：
   *   - 目标酒店星级（Hotel.starRating）不得低于随机档档次（降级交付 → 400；同级/升级放行）；
   *   - 目标酒店逐晚余量必须校验（落位就是往该酒店新增占房，没有"同酒店净不变"的豁免）；
   *   - 审计 before.hotelName = 档次名（「三星随机」），摘要渲染成「换酒店 三星随机 → XX酒店·房型」。
   *
   * 逐晚余量校验（仅当换到不同酒店时才做——同酒店换房型净房量不变，不受本单自身占用影响）：
   *   - block[i] > 0（该晚被房控周期管控）且 remaining[i] < 本行房间数 → 拒单，列出不足的夜晚。
   *   - block[i] === 0，或整段查询范围内一条周期都没有（hasBlock=false）→ 放行，计入
   *     untrackedNights（房控哲学：未配包房 = 未管控，不能拿来判"售罄"）。
   *
   * 单事务内：
   *   1. 更新该行 hotelRoomTypeId（HOTEL 行按创建期同款格式重建 description；BUNDLE 行的
   *      description 本就不含酒店名——由 serializer 实时联查 hotelRoomTypeId 得到，不用重建）。
   *      amount/unitPrice/quantity/hotelCheckIn/hotelCheckOut/roomsBilled 一律不动（冻结）。
   *   2. feeCny≠0 → order.adjustmentCny += feeCny，并 push 一条 adjustments 流水（HOTEL_SWAP_FEE）。
   *   3. Order.roomAssignment.roomGroups 里属于本行的组 → 改成新酒店名+新房型名：优先按
   *      orderItemId == 本行精确匹配（split-room-group / 分房保存写入的归属），无归属组回退
   *      (hotelName, roomType) 二元组匹配（人工填的其它酒店名不动——可能是老单据手填值，
   *      不该被这次换酒店误伤）。
   *
   * 返回值联查与 getOrder 同款富 include（hotelRoomType/bundle.hotelRoomType 等），确保响应
   * 里的 hotelName/roomTypeName 立即正确，调用方不用再刷一次详情。
   */
  async swapItemHotel(
    orderId: string,
    itemId: string,
    input: SwapItemHotelBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: {
        hotelRoomTypeId: string | null;
        hotelName: string | null;
        roomTypeName: string | null;
        unitCostCny: number | null;
        totalCostCny: number | null;
      };
      after: {
        hotelRoomTypeId: string;
        hotelName: string;
        roomTypeName: string;
        unitCostCny: number | null;
        totalCostCny: number | null;
      };
      feeCny: number;
      untrackedNights: string[];
      /** 非空 = 本次换酒店越过了「套餐档次 ↔ 酒店星级」闸（调用方据此另写一条 WARNING 审计）。 */
      starMismatchOverride: DesignatedHotelStarMismatchOverride | null;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可换酒店');
    }
    const feeCny = Math.trunc(input.feeCny ?? 0);

    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        orderId: true,
        kind: true,
        description: true,
        quantity: true,
        hotelRoomTypeId: true,
        randomStarTier: true,
        // BUNDLE 行的套餐归属：换入酒店的星级要与该套餐的结算档次比对（星级不匹配闸）。
        bundleId: true,
        hotelCheckIn: true,
        hotelCheckOut: true,
        roomsBilled: true,
        // 换酒店前的成本快照（审计 before / 保留 BUNDLE 行原值不动的依据）。
        unitCostCny: true,
        totalCostCny: true,
      },
    });
    if (!item || item.orderId !== orderId) {
      throw new NotFoundError('订单项不存在或不属于该订单');
    }
    // 「落位」：未落位随机单（kind=HOTEL、无房型、randomStarTier 非空）走同一条换酒店通道 ——
    // 落到具体酒店。占用随之从「未落位」转到该酒店（写 hotelRoomTypeId + 清 randomStarTier）。
    const isRandomPoolRow = item.kind === OrderItemKind.HOTEL && item.randomStarTier != null;
    const isHotelRow =
      item.kind === OrderItemKind.HOTEL ||
      (item.kind === OrderItemKind.BUNDLE && item.hotelRoomTypeId != null);
    if (!isHotelRow || (!item.hotelRoomTypeId && !isRandomPoolRow)) {
      throw new BadRequestError('该行不含酒店，无法换酒店');
    }
    if (item.hotelRoomTypeId && item.hotelRoomTypeId === input.newHotelRoomTypeId) {
      throw new BadRequestError('目标房型与当前房型相同，无需更换');
    }

    const [oldRoomType, newRoomType] = await Promise.all([
      item.hotelRoomTypeId
        ? prisma.hotelRoomType.findUnique({
            where: { id: item.hotelRoomTypeId },
            select: {
              id: true,
              name: true,
              hotelId: true,
              // randomTierPlaceholder：原房型可能挂在随机档「占位酒店」上（伪落位行）——
              //   这种行业务上等同未落位随机单，落位时同样要吃「不许降级交付」的星级约束。
              hotel: { select: { name: true, randomTierPlaceholder: true } },
            },
          })
        : Promise.resolve(null),
      prisma.hotelRoomType.findUnique({
        where: { id: input.newHotelRoomTypeId },
        select: {
          id: true,
          name: true,
          hotelId: true,
          // 新房型成本价 → 重打 HOTEL 行成本快照（每间每晚 × 晚数 × 房数）。
          costPriceCny: true,
          hotel: {
            select: {
              name: true,
              isActive: true,
              starRating: true,
              // 星级不匹配闸：国际五星与市区五星是两个档（另行报价），要分得开；
              // 占位酒店不是真房源，不参与本闸。
              intlFiveStar: true,
              randomTierPlaceholder: true,
            },
          },
        },
      }),
    ]);
    if (!newRoomType) throw new NotFoundError(`酒店房型 ${input.newHotelRoomTypeId} 不存在`);
    if (!newRoomType.hotel.isActive) throw new BadRequestError('酒店已下架');
    if (!isRandomPoolRow && !oldRoomType) {
      throw new NotFoundError('原酒店房型数据异常，无法换酒店');
    }
    // 随机单落位的星级约束：客人买的是「N 星随机」，落到低于该星级的酒店等于降级交付 ——
    // 拒绝；同级或更高（升级）放行。星级分类直接取酒店档案 Hotel.starRating。
    //
    // 两种「未落位」形态同吃这条约束（档次来源不同，语义完全一样）：
    //   a) 正规随机单 —— 档次取本行 randomStarTier；
    //   b) 伪落位行（房型挂在随机档占位酒店上）—— 档次取该占位酒店的 randomTierPlaceholder。
    const pendingTier = isRandomPoolRow
      ? item.randomStarTier!
      : (oldRoomType?.hotel.randomTierPlaceholder ?? null);
    if (pendingTier != null && newRoomType.hotel.starRating < pendingTier) {
      throw new BadRequestError(
        `${randomStarTierLabel(pendingTier)}只能落到 ${pendingTier} 星及以上的酒店（所选酒店为 ${newRoomType.hotel.starRating} 星）`,
      );
    }

    // ── 套餐行的星级不匹配闸（口径与录单指定酒店同一份映射，见 SETTLEMENT_TIER_STAR_RATING）──
    // 套餐行的钱是按 Bundle.settlementTier 收的；售后把住宿换到别的档次而系统不知情，
    // 就等于「四星档的钱住三星店」从售后口子溜进来。本端点只有 ADMIN/STAFF 可达，
    // 故没有硬拒分支 —— 一律「必须写明原因才放行」，放行写 WARNING 审计。
    // 已落位低星的存量单不追溯：本闸只在**本次换入**的酒店上判定。
    let starMismatchOverride: DesignatedHotelStarMismatchOverride | null = null;
    if (item.kind === OrderItemKind.BUNDLE && item.bundleId && newRoomType.hotel.randomTierPlaceholder == null) {
      const swapBundle = await prisma.bundle.findUnique({
        where: { id: item.bundleId },
        select: { id: true, name: true, settlementTier: true },
      });
      if (
        swapBundle?.settlementTier != null &&
        isSettlementTierStarMismatch(swapBundle.settlementTier, newRoomType.hotel)
      ) {
        const reason = input.designatedHotelStarMismatchReason?.trim();
        if (!reason) {
          throw new BadRequestError(
            `${buildStarMismatchMessage(swapBundle.settlementTier, newRoomType.hotel)}。` +
              '如确需换到该酒店，请填写放行原因（将留档备查）。',
          );
        }
        starMismatchOverride = {
          bundleId: swapBundle.id,
          bundleName: swapBundle.name ?? null,
          bundleTier: swapBundle.settlementTier,
          bundleTierStar: SETTLEMENT_TIER_STAR_RATING[swapBundle.settlementTier],
          hotelRoomTypeId: newRoomType.id,
          hotelId: newRoomType.hotelId,
          hotelName: newRoomType.hotel.name,
          hotelStarRating: newRoomType.hotel.starRating ?? null,
          hotelIntlFiveStar: newRoomType.hotel.intlFiveStar === true,
          reason,
        };
      }
    }

    // ── 逐晚余量校验（仅跨酒店换房时才需要；同酒店换房型净房量不变，不受本单占用影响）──
    const roomsBilled = item.roomsBilled != null ? Number(item.roomsBilled) : 1;

    // ── HOTEL 行成本重打快照（Task B）：按新房型成本价 × 晚数(quantity) × 房数(roomsBilled)，
    // 口径对齐建单时的 HOTEL 行快照公式。新房型无成本价 → null（真缺数据，如实报缺）。
    // BUNDLE 行不重算（建单时未快照酒店成本，其 quantity≠晚数、totalCostCny 覆盖整包）→ 原值不动。
    const swapCost =
      item.kind === OrderItemKind.HOTEL
        ? computeSwapHotelCostSnapshot({
            newCostPriceCny:
              newRoomType.costPriceCny != null ? Number(newRoomType.costPriceCny.toString()) : null,
            nights: item.quantity,
            rooms: roomsBilled,
          })
        : null;
    // 换酒店前后的成本快照（审计留痕）。BUNDLE 行 after === before（不动）。
    const beforeUnitCostCny = item.unitCostCny != null ? Number(item.unitCostCny.toString()) : null;
    const beforeTotalCostCny = item.totalCostCny != null ? Number(item.totalCostCny.toString()) : null;
    const afterUnitCostCny = swapCost ? swapCost.unitCostCny : beforeUnitCostCny;
    const afterTotalCostCny = swapCost ? swapCost.totalCostCny : beforeTotalCostCny;
    const nightDates =
      item.hotelCheckIn && item.hotelCheckOut
        ? buildStayNightDates(item.hotelCheckIn, item.hotelCheckOut)
        : [];
    // 是否需要校验目标酒店房量：随机单落位一律要校验（落位就是往目标酒店新增占房）；
    // 具体酒店行只在跨酒店时校验（同酒店换房型净房量不变）。真正的判定在事务内做（见下方）。
    const needsHotelFitCheck =
      (isRandomPoolRow || oldRoomType!.hotelId !== newRoomType.hotelId) && nightDates.length > 0;

    // ── HOTEL 行按创建期同款格式重建 description；BUNDLE 行不含酒店名，不用重建 ──
    let newDescription = item.description;
    if (item.kind === OrderItemKind.HOTEL && item.hotelCheckIn && item.hotelCheckOut) {
      const roomsLabel = Number.isInteger(roomsBilled) ? String(roomsBilled) : roomsBilled.toFixed(1);
      // 晚数以住宿区间为准（nightDates 就是 [checkIn, checkOut) 逐晚展开），不用 item.quantity ——
      // quantity 是**计价乘数**，酒店改期按「行价冻结」不动它，改完期后它可能已不等于真实晚数；
      // 拿它重建描述会把旧晚数又写回去。区间异常（nightDates 为空）时才回退到 quantity。
      const nightsLabel = nightDates.length > 0 ? nightDates.length : item.quantity;
      newDescription =
        `${newRoomType.hotel.name} · ${newRoomType.name} · ` +
        `${formatDateOnly(item.hotelCheckIn)}~${formatDateOnly(item.hotelCheckOut)} · ` +
        `${nightsLabel}晚 × ${roomsLabel}间`;
    }

    const scratch = await prisma.$transaction(async (tx) => {
      // Order 行锁（HIGH 修复）：换酒店要读-改-写 adjustmentCny/adjustments（差价流水），
      // 与换人/改期/到账入账是同一份读-改-写。此前这里是全库唯一不加订单行锁的写路径 ——
      // 并发的「换酒店 +¥300」与「换人费 +¥500」会互相覆盖（lost update，少收一笔）。
      // 现在与其余写路径一律先 FOR UPDATE，同一订单上的资金调整严格串行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          adjustmentCny: true,
          adjustments: true,
          roomAssignment: true,
          total: true,
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // ── 有效订单守卫（HIGH 修复）：与改期 / 升舱同款双闸 ────────────────────
      // 换酒店会往目标酒店新增占房、并通过 feeCny 改 adjustmentCny（客户应付）。在已取消 /
      // 已退款 / 超时 / 回收站单上换酒店 → 死单凭空占住真实房量，且长出一笔并不存在的「欠款」。
      // 读的是刚 FOR UPDATE 锁住的那一行，与并发状态流转严格串行。
      if (order.deletedAt) {
        throw new BadRequestError('订单在回收站（已软删），不可换酒店；如需操作请先恢复');
      }
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可换酒店：仅占座中的有效订单可换酒店（已取消/已退款/超时订单请勿换酒店）`,
        );
      }

      // ── 0b. 目标酒店逐晚房量前瞻闸（事务内互斥版）────────────────────────────
      // 物理房间口径（口径同下单闸 / 销控板看板）：把本单要挪进目标酒店的占房塞进目标酒店当晚的
      // 性别桶里重算物理间数 —— 床位口径看不见「异性不能拼一间」这一维。
      // 必须在事务内、且先锁目标酒店该区间的包房周期行：判定与占房落库（下方第 1 步写
      // hotelRoomTypeId）之间不能有窗口，否则两笔并发换酒店会各自读到「还剩 1 间」的旧快照双双通过。
      // excludeOrderItemIds（行级排除）：只排本次要挪走的这一行 —— 它当前挂在原酒店，理论上
      // 不该被目标酒店的占房查询选中，显式排除是防御同酒店异常数据被算两遍。同单**另一条行**
      // 在目标酒店的占用是真实存量，必须照常计入（旧版 excludeOrderId 把整单排掉 → 放行超卖）。
      // 拼房单（roomsBilled=0.5）要按性别配对判定 → 取本单出行人性别（口径同房控 pickSoloGender）。
      let untrackedNights: string[] = [];
      if (needsHotelFitCheck) {
        await lockHotelBlockPeriodsWithinTx(tx, newRoomType.hotelId, nightDates);
        const swapPassengers = await tx.passenger.findMany({
          where: { orderId },
          select: { gender: true },
        });
        const fit = await checkHotelPhysicalFit(
          newRoomType.hotelId,
          nightDates,
          toProspectiveOccupancy(
            roomsBilled,
            swapPassengers.map((p) => ({ gender: p.gender ?? undefined })),
          ),
          { excludeOrderItemIds: [item.id] },
          tx,
        );
        if (fit.hasBlock) {
          untrackedNights = nightDates.filter((_, i) => fit.block[i] === 0);
          if (fit.violations.length > 0) {
            const detail = fit.violations
              .map(
                (v) =>
                  `目标酒店 ${formatMonthDay(new Date(`${v.date}T00:00:00.000Z`))}实际房间不足（包房 ${v.block} 间，换过去后需 ${v.physicalUsed} 间）`,
              )
              .join('；');
            throw new BadRequestError(detail);
          }
        } else {
          // 整段查询范围内一条包房周期都没有 → 全部夜晚视为未管控（房控哲学：未配包房≠售罄）
          untrackedNights = [...nightDates];
        }
      }

      // ── 0. 减价不能把应付冲成负数（HIGH 修复）──
      // 减价（feeCny<0）是合法操作（"我方缺房挪客不变价"里客人主动少收），但没有下限就能把
      // effectivePayable（= total + adjustmentCny，客户实际应付）冲到任意负数，系统账面上就
      // 变成"欠客户钱"，而这笔"欠款"并非真实退款（没有对应的 Refund/退款流水）。
      // 只挡「减到应付为负」这一种；加价（feeCny>0）不受限（已有 schema 层 ±10 万绝对上限）。
      if (feeCny < 0) {
        const currentPayable = round2(Number(order.total.toString()) + order.adjustmentCny);
        const newPayable = round2(currentPayable + feeCny);
        if (newPayable < 0) {
          throw new BadRequestError('减价金额不能超过当前应付（最多减到应付为 0）');
        }
      }

      // ── 1. 更新订单行（只换房型引用 + 重建 description；金额/数量/日期/间数一律冻结）──
      // 成本快照按新房型重打（仅 HOTEL 行；售价/金额一个字不动，只改成本侧的毛利真账）。
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          hotelRoomTypeId: newRoomType.id,
          // 随机单落位：清空随机档标记 —— 占用从「未落位」转到该酒店，随机档合计不变
          randomStarTier: null,
          description: newDescription,
          ...(swapCost
            ? {
                unitCostCny:
                  swapCost.unitCostCny != null ? new Prisma.Decimal(swapCost.unitCostCny) : null,
                totalCostCny:
                  swapCost.totalCostCny != null ? new Prisma.Decimal(swapCost.totalCostCny) : null,
              }
            : {}),
        },
      });

      // ── 2. 可选换酒店差价（adjustmentCny + adjustments 流水，与改期费同机制）──
      if (feeCny !== 0) {
        const log = appendAdjustment(order.adjustments, {
          type: 'HOTEL_SWAP_FEE',
          label: input.feeLabel || '换酒店差价',
          amountCny: feeCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
        });
        await tx.order.update({
          where: { id: orderId },
          data: { adjustmentCny: order.adjustmentCny + feeCny, adjustments: log },
        });
      }

      // ── 3. 分房表里属于本行的组 → 改名到新酒店+新房型（HIGH 修复 + 归属精确匹配）──
      // 优先按 orderItemId == 本行精确匹配（split-room-group / 分房保存写入的归属字段）——
      // 这是数据模型上百分百的"这组人就是这一行的客人"，跨酒店/同酒店多行都不会误伤。
      // 无任何组归属到本行时回退旧口径：(hotelName, roomType) 二元组匹配 —— 一个订单有 2 条
      // HOTEL 行都住"同一家酒店"（不同房型/不同批客人）时，只换其中一行，二元组比单凭酒店名
      // 更贴近"这条订单行"的身份；已归属到**其它行**的组绝不参与二元组匹配（名字撞上也不改）。
      // 同时把 roomType 也一并改写到新房型名（旧版只改 hotelName，遗留一个在目标酒店根本
      // 不存在的旧房型名，分房表看着货不对板）。
      // 随机单落位（无 oldRoomType）没有「旧酒店名」可匹配 → 只走 orderItemId 精确匹配，
      // 绝不拿 undefined 去比对分房组的 hotelName（那会把所有没填酒店名的组一并误改）。
      const roomAssignmentRaw = order.roomAssignment;
      if (roomAssignmentRaw && typeof roomAssignmentRaw === 'object' && !Array.isArray(roomAssignmentRaw)) {
        const groups = (roomAssignmentRaw as { roomGroups?: unknown }).roomGroups;
        if (Array.isArray(groups)) {
          const groupItemId = (g: unknown): string | null => {
            if (g == null || typeof g !== 'object') return null;
            const v = (g as { orderItemId?: unknown }).orderItemId;
            return typeof v === 'string' && v.length > 0 ? v : null;
          };
          const hasOwnAttribution = groups.some((g) => groupItemId(g) === item.id);
          let changed = false;
          const newGroups = groups.map((g) => {
            if (g == null || typeof g !== 'object') return g;
            const attributedTo = groupItemId(g);
            const matched = hasOwnAttribution
              ? attributedTo === item.id
              : oldRoomType != null &&
                attributedTo == null &&
                (g as { hotelName?: unknown }).hotelName === oldRoomType.hotel.name &&
                (g as { roomType?: unknown }).roomType === oldRoomType.name;
            if (matched) {
              changed = true;
              return {
                ...(g as Record<string, unknown>),
                hotelName: newRoomType.hotel.name,
                roomType: newRoomType.name,
              };
            }
            return g;
          });
          if (changed) {
            await tx.order.update({
              where: { id: orderId },
              data: {
                roomAssignment: {
                  ...(roomAssignmentRaw as Record<string, unknown>),
                  roomGroups: newGroups,
                } as Prisma.InputJsonValue,
              },
            });
          }
        }
      }

      return { orderNumber: order.orderNumber, untrackedNights };
    });

    // ── 返回值：与 getOrder 同款富联查，确保 hotelName/roomTypeName 立即正确 ──
    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: {
          include: {
            hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
            flightSchedule: {
              select: {
                departureTime: true,
                arrivalTime: true,
                // 当地时区：行程单/订单详情的时刻必须按它折算，否则显示的是 UTC 分量
                departureTz: true,
                arrivalTz: true,
                flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
              },
            },
            visa: { select: { visaName: true, country: true, destinationCountry: true, stayDays: true } },
            transfer: { select: { name: true } },
            bundle: {
              select: {
                name: true,
                serviceNotes: true,
                items: true,
                infantPriceCny: true,
                childSeatDiscountCnyPerPerson: true,
                hotelRoomTypeId: true,
                hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
              },
            },
          },
        },
        passengers: true,
        payments: true,
        refunds: true,
        statusEvents: { orderBy: { createdAt: 'asc' } },
        agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
        user: { select: { id: true, displayName: true, email: true } },
        claimedBy: { select: { id: true, displayName: true, email: true } },
        reminders: {
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
          include: { createdBy: { select: { id: true, displayName: true } } },
        },
      },
    });
    const visaStayDaysById = await this.loadBundleVisaStayDays(finalOrder.items);

    return {
      // 对外脱敏：换酒店（AGENT/CUSTOMER 侧也有入口）的返回按操作者角色脱敏。
      order: serializeOrder(finalOrder, { visaStayDaysById, ...orderSerializeRoleCtx(actor.role) }),
      audit: {
        orderNumber: scratch.orderNumber,
        orderItemId: item.id,
        before: {
          hotelRoomTypeId: item.hotelRoomTypeId,
          // 随机单落位：before 没有真实酒店 → 写档次名（「三星随机」），
          // 审计摘要自然渲染成「换酒店 三星随机 → XX酒店·XX房型」
          hotelName: oldRoomType
            ? oldRoomType.hotel.name
            : randomStarTierLabel(item.randomStarTier ?? 0),
          roomTypeName: oldRoomType ? oldRoomType.name : null,
          unitCostCny: beforeUnitCostCny,
          totalCostCny: beforeTotalCostCny,
        },
        after: {
          hotelRoomTypeId: newRoomType.id,
          hotelName: newRoomType.hotel.name,
          roomTypeName: newRoomType.name,
          unitCostCny: afterUnitCostCny,
          totalCostCny: afterTotalCostCny,
        },
        feeCny,
        untrackedNights: scratch.untrackedNights,
        starMismatchOverride,
      },
    };
  }

  /**
   * 按房组拆分酒店行：把分房表（Order.roomAssignment）里的一个房组，从某条 HOTEL 行
   * 拆成一条独立的 HOTEL 行 —— 「按房组换酒店」的前置步骤：拆完对新行用现成的
   * 「换酒店」按钮（swapItemHotel）即可，只挪这一组人，不动同行其他房组。
   *
   * 钱的哲学（与换酒店「价格冻结」同一套）：**拆行只拆库存归属，不拆应收** ——
   * 新行 amount = 0，源行 amount 一个字不动 → order.subtotal/total 拆前后恒等；
   * 换酒店产生的差价照旧走换酒店端点的 feeCny（adjustmentCny 机制）。
   * 成本侧走真账：totalCostCny 按拆出间数比例从源行挪到新行（Σ 成本守恒），
   * unitCostCny 快照原样复制。
   *
   * 库存对称铁律：源行 roomsBilled -= 拆出数、新行 roomsBilled = 拆出数，Σ 恒等 ——
   * 房控占用由 (hotelRoomTypeId|randomStarTier, hotelCheckIn/Out, roomsBilled) 派生，
   * 本操作绝不隐式增减占用。事务尾对 Σ roomsBilled / Σ totalCostCny / order.total
   * 各做一次守恒断言，不平整体回滚。
   *
   * 房组归属：目标房组的 orderItemId 写成新行 id；本单其余**无归属**的房组顺手回填为
   * 源行 id —— 本单从此每组有归属，房控的归属过滤（expandAssignedPhysicalByDate）即刻生效。
   *
   * 守卫：仅 ADMIN/STAFF；订单占座态且未软删；itemId 必须是本单 kind=HOTEL 行
   * （BUNDLE 行 400 —— 套餐行的钱覆盖整包、无法按间拆成本，请先经「补录房费」加独立
   * 酒店行再拆）；房组必须存在且未归属到其它行；拆出数（roomFraction，缺省 1）与
   * 源行剩余数都必须是 0.5 的整数倍且 > 0（等于源行全额 → 无需拆分，直接换酒店）。
   */
  async splitHotelItemByRoomGroup(
    orderId: string,
    itemId: string,
    input: SplitRoomGroupBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      fromItemId: string;
      newItemId: string;
      roomGroupId: string;
      before: { fromRoomsBilled: number; fromTotalCostCny: number | null };
      after: {
        fromRoomsBilled: number;
        newRoomsBilled: number;
        fromTotalCostCny: number | null;
        newTotalCostCny: number | null;
      };
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可拆分房组');
    }

    const scratch = await prisma.$transaction(async (tx) => {
      // Order 行锁：与换酒店/补房差同款 —— 拆行要读-改-写 roomsBilled/roomAssignment，
      // 与并发的分房保存 / 换酒店 / 状态流转严格串行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          roomAssignment: true,
          total: true,
        },
      });
      if (!order) throw new NotFoundError('订单不存在');
      if (order.deletedAt) {
        throw new BadRequestError('订单在回收站（已软删），不可拆分房组；如需操作请先恢复');
      }
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可拆分房组：仅占座中的有效订单可操作`,
        );
      }

      const item = await tx.orderItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          orderId: true,
          kind: true,
          description: true,
          quantity: true,
          unitPrice: true,
          unitCostCny: true,
          totalCostCny: true,
          hotelRoomTypeId: true,
          randomStarTier: true,
          hotelCheckIn: true,
          hotelCheckOut: true,
          roomsBilled: true,
        },
      });
      if (!item || item.orderId !== orderId) {
        throw new NotFoundError('订单项不存在或不属于该订单');
      }
      if (item.kind === OrderItemKind.BUNDLE) {
        throw new BadRequestError(
          '套餐行不能直接拆分房组：请先经「补录房费」补一条独立酒店行，再对该行拆分/换酒店',
        );
      }
      if (item.kind !== OrderItemKind.HOTEL) {
        throw new BadRequestError('该行不是酒店行，无法拆分房组');
      }

      // ── 分房表 & 目标房组（防御式解析，形状不符按缺失处理）──
      const raw = order.roomAssignment;
      const rawGroups =
        raw != null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as { roomGroups?: unknown }).roomGroups
          : null;
      if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
        throw new BadRequestError('本单尚无分房表，请先在分房里保存房组，再按房组拆分');
      }
      const target = rawGroups.find(
        (g) => g != null && typeof g === 'object' && (g as { id?: unknown }).id === input.roomGroupId,
      ) as Record<string, unknown> | undefined;
      if (!target) {
        throw new BadRequestError('分房表中不存在该房组，请刷新分房后重试');
      }
      const targetAttribution = target.orderItemId;
      if (
        typeof targetAttribution === 'string' &&
        targetAttribution.length > 0 &&
        targetAttribution !== itemId
      ) {
        throw new BadRequestError('该房组已归属其它订单行，不能从本行拆出');
      }

      // ── 数量守卫（0.5 网格；Σ roomsBilled 守恒的前提）──
      const movedRaw = target.roomFraction == null ? 1 : Number(target.roomFraction);
      if (!Number.isFinite(movedRaw) || movedRaw <= 0) {
        throw new BadRequestError('房组间数（roomFraction）无效，请先修正分房表');
      }
      const movedHalf = Math.round(movedRaw * 2);
      if (movedHalf <= 0 || Math.abs(movedRaw * 2 - movedHalf) > 1e-9) {
        throw new BadRequestError('房组间数必须是 0.5 的整数倍');
      }
      const srcRooms = item.roomsBilled != null ? Number(item.roomsBilled) : null;
      if (srcRooms == null || srcRooms <= 0) {
        throw new BadRequestError('源行未记录计费房数（roomsBilled），请先保存分房表再拆分');
      }
      const srcHalf = Math.round(srcRooms * 2);
      if (Math.abs(srcRooms * 2 - srcHalf) > 1e-9) {
        throw new BadRequestError('源行计费房数不是 0.5 的整数倍，请先核对分房表');
      }
      if (movedHalf === srcHalf) {
        throw new BadRequestError('该房组已占满源行全部房数，无需拆分 —— 直接对源行换酒店即可');
      }
      if (movedHalf > srcHalf) {
        throw new BadRequestError('该房组间数超过源行计费房数，无法拆分，请先核对分房表');
      }
      const moved = movedHalf / 2;
      const remaining = (srcHalf - movedHalf) / 2; // > 0（movedHalf < srcHalf）

      // ── 成本按间数比例挪（Σ 守恒）；钱（amount）全留源行 ──
      const srcTotalCost = item.totalCostCny != null ? Number(item.totalCostCny.toString()) : null;
      const movedCost = srcTotalCost == null ? null : round2((srcTotalCost * movedHalf) / srcHalf);
      const keptCost = srcTotalCost == null || movedCost == null ? null : round2(srcTotalCost - movedCost);

      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: OrderItemKind.HOTEL,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          // 拆行只拆库存归属不拆应收：新行 0 元，源行 amount 不动 → subtotal/total 恒等
          amount: new Prisma.Decimal(0),
          unitCostCny: item.unitCostCny,
          totalCostCny: movedCost == null ? null : new Prisma.Decimal(movedCost),
          hotelRoomTypeId: item.hotelRoomTypeId,
          randomStarTier: item.randomStarTier,
          hotelCheckIn: item.hotelCheckIn,
          hotelCheckOut: item.hotelCheckOut,
          roomsBilled: new Prisma.Decimal(moved),
          idempotencyKey: null,
          metadata: {
            splitRoomGroup: {
              fromItemId: item.id,
              roomGroupId: input.roomGroupId,
              at: new Date().toISOString(),
            },
            ...(input.note ? { note: input.note } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          roomsBilled: new Prisma.Decimal(remaining),
          totalCostCny: keptCost == null ? null : new Prisma.Decimal(keptCost),
        },
      });

      // ── 房组归属：目标组指到新行；其余无归属组回填为源行（本单从此每组有归属）──
      const newGroups = rawGroups.map((g) => {
        if (g == null || typeof g !== 'object') return g;
        const rec = g as Record<string, unknown>;
        if (rec.id === input.roomGroupId) return { ...rec, orderItemId: created.id };
        const existing = rec.orderItemId;
        if (typeof existing === 'string' && existing.length > 0) return rec;
        return { ...rec, orderItemId: item.id };
      });
      await tx.order.update({
        where: { id: orderId },
        data: {
          roomAssignment: {
            ...(raw as Record<string, unknown>),
            roomGroups: newGroups,
          } as Prisma.InputJsonValue,
        },
      });

      // ── 守恒断言（不平整体回滚）：Σ roomsBilled、Σ totalCostCny、order.total 拆前后一致 ──
      const [afterSrc, afterNew, afterOrder] = await Promise.all([
        tx.orderItem.findUniqueOrThrow({
          where: { id: item.id },
          select: { roomsBilled: true, totalCostCny: true },
        }),
        tx.orderItem.findUniqueOrThrow({
          where: { id: created.id },
          select: { roomsBilled: true, totalCostCny: true },
        }),
        tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
      ]);
      const halfOf = (v: Prisma.Decimal | null): number =>
        v == null ? 0 : Math.round(Number(v.toString()) * 2);
      const centsOf = (v: Prisma.Decimal | null): number =>
        v == null ? 0 : Math.round(Number(v.toString()) * 100);
      if (halfOf(afterSrc.roomsBilled) + halfOf(afterNew.roomsBilled) !== srcHalf) {
        throw new Error('拆分守恒校验未通过（Σ roomsBilled 与拆前不符），已回滚');
      }
      const costBeforeCents = srcTotalCost == null ? 0 : Math.round(srcTotalCost * 100);
      if (centsOf(afterSrc.totalCostCny) + centsOf(afterNew.totalCostCny) !== costBeforeCents) {
        throw new Error('拆分守恒校验未通过（Σ totalCostCny 与拆前不符），已回滚');
      }
      if (afterOrder.total.toString() !== order.total.toString()) {
        throw new Error('拆分守恒校验未通过（order.total 被改动），已回滚');
      }

      return {
        orderNumber: order.orderNumber,
        fromItemId: item.id,
        newItemId: created.id,
        roomGroupId: input.roomGroupId,
        before: { fromRoomsBilled: srcRooms, fromTotalCostCny: srcTotalCost },
        after: {
          fromRoomsBilled: remaining,
          newRoomsBilled: moved,
          fromTotalCostCny: keptCost,
          newTotalCostCny: movedCost,
        },
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: scratch,
    };
  }

  /**
   * 酒店改期：把某条 HOTEL 行的入住/退房日期整体挪到新区间。
   *
   * 与「换酒店」是一对姊妹能力：换酒店改的是「住哪」，改期改的是「住哪几晚」。房控占房本就
   * 由订单行的 (hotelRoomTypeId, hotelCheckIn, hotelCheckOut, roomsBilled) 派生 —— 改写日期
   * 这一步本身就等于「释放旧区间 + 占用新区间」，两件事在同一条 UPDATE 里原子完成，中间不存在
   * 「旧的放了、新的还没占」的窗口；新区间余量不足则整事务回滚，旧区间的占房分毫未动。
   *
   * body：{ newCheckIn, newCheckOut, feeCny?, feeLabel?, note? }
   *   - itemId 必须属于本订单且 kind=HOTEL（BUNDLE 行的住宿日期由套餐行程决定，不从这里单独挪）。
   *   - newCheckOut 必须晚于 newCheckIn；跨度超出住宿上限（见 buildStayNightDates）→ 拒绝。
   *   - 新旧区间完全相同 → 400（无意义改期）。
   *
   * 定价哲学（甲案，与换酒店的"价格默认冻结"同一套）：
   *   **行价与数量一个字不动** —— unitPrice / amount / quantity(晚数计价乘数) / roomsBilled 全部冻结，
   *   绝不因晚数变化自动加钱或退钱。晚数变了要收/退的差额，由 feeCny 走售后费行
   *   （adjustmentCny + adjustments 流水，label 缺省「酒店改期差价」），与改期费/换人费/换酒店差价
   *   同一机制，计入订单应收。这样「系统自动算的钱」和「人工确认的钱」始终泾渭分明。
   *
   * 房控库存（新区间必须装得下，否则整体拒绝）：
   *   - 具体酒店行（有 hotelRoomTypeId）：先锁目标酒店该区间的包房周期行（并发互斥的唯一正解），
   *     再走物理房间口径前瞻闸。`excludeOrderId` 排除本单自身占房 —— 对同酒店改期而言，这正是
   *     「先释放旧区间」的效果（本单在该酒店的其它 HOTEL 行也会被一并排除，属已知口径；
   *     换酒店已升级为行级排除 excludeOrderItemIds，改期后续可跟进）。
   *   - 未落位随机档行（randomStarTier 非空、无房型）：走随机档聚合余量闸（Σ同星级真酒店余量 −
   *     未落位占用），口径与下单/落位一致。
   *
   * description 里的日期段与晚数段按新区间就地改写（其余部分原样保留，见 rewriteHotelStayDescription）。
   */
  async rescheduleItemHotel(
    orderId: string,
    itemId: string,
    input: RescheduleItemHotelBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: { checkIn: string; checkOut: string; nights: number };
      after: { checkIn: string; checkOut: string; nights: number };
      feeCny: number;
      untrackedNights: string[];
    };
  }> {
    // 权限口径与机票改期/换酒店完全一致（路由层也断言一次，双闸）。
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可改酒店入住日期');
    }
    const feeCny = Math.trunc(input.feeCny ?? 0);

    // ── 新区间解析与校验（date-only：与建单/房控同款 UTC 零点口径）──
    // 逐字回读 ISO 日期：`2026-02-31` 这类不存在的日期会被 Date 悄悄顺延到 3 月，回读能揪出来。
    const newCheckIn = new Date(`${input.newCheckIn}T00:00:00.000Z`);
    const newCheckOut = new Date(`${input.newCheckOut}T00:00:00.000Z`);
    if (
      Number.isNaN(newCheckIn.getTime()) ||
      newCheckIn.toISOString().slice(0, 10) !== input.newCheckIn
    ) {
      throw new BadRequestError('入住日期无效');
    }
    if (
      Number.isNaN(newCheckOut.getTime()) ||
      newCheckOut.toISOString().slice(0, 10) !== input.newCheckOut
    ) {
      throw new BadRequestError('退房日期无效');
    }
    if (newCheckOut.getTime() <= newCheckIn.getTime()) {
      throw new BadRequestError('退房日期必须晚于入住日期');
    }
    const nightDates = buildStayNightDates(newCheckIn, newCheckOut);
    if (nightDates.length === 0) {
      throw new BadRequestError(`住宿区间过长（最多 ${MAX_STAY_NIGHTS} 晚），请核对入住/退房日期`);
    }
    const newNights = nightDates.length;

    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        orderId: true,
        kind: true,
        description: true,
        hotelRoomTypeId: true,
        randomStarTier: true,
        hotelCheckIn: true,
        hotelCheckOut: true,
        roomsBilled: true,
      },
    });
    if (!item || item.orderId !== orderId) {
      throw new NotFoundError('订单项不存在或不属于该订单');
    }
    // BUNDLE 行的住宿日期跟着套餐行程走（由去/回程日期盖章），单独挪它会与航段脱钩 —— 一律拒绝。
    if (item.kind !== OrderItemKind.HOTEL) {
      throw new BadRequestError('只能对酒店行（HOTEL）改期');
    }
    if (!item.hotelCheckIn || !item.hotelCheckOut) {
      throw new BadRequestError('该酒店行没有入住/退房日期，无法改期');
    }
    if (!item.hotelRoomTypeId && item.randomStarTier == null) {
      throw new BadRequestError('该行不含酒店，无法改期');
    }
    const beforeCheckIn = formatDateOnly(item.hotelCheckIn);
    const beforeCheckOut = formatDateOnly(item.hotelCheckOut);
    if (beforeCheckIn === input.newCheckIn && beforeCheckOut === input.newCheckOut) {
      throw new BadRequestError('新入住/退房日期与当前相同，无需改期');
    }
    const beforeNights = buildStayNightDates(item.hotelCheckIn, item.hotelCheckOut).length;

    const roomsBilled = item.roomsBilled != null ? Number(item.roomsBilled.toString()) : 1;
    // 具体酒店行要按酒店维度锁包房周期 + 判物理余量；随机档行没有落到酒店，走聚合闸。
    const roomType = item.hotelRoomTypeId
      ? await prisma.hotelRoomType.findUnique({
          where: { id: item.hotelRoomTypeId },
          select: { id: true, hotelId: true },
        })
      : null;
    if (item.hotelRoomTypeId && !roomType) {
      throw new NotFoundError('酒店房型数据异常，无法改期');
    }

    const newDescription = rewriteHotelStayDescription(item.description, {
      checkIn: input.newCheckIn,
      checkOut: input.newCheckOut,
      nights: newNights,
    });

    const scratch = await prisma.$transaction(async (tx) => {
      // Order 行锁：与换酒店/机票改期/换人/到账入账同一把锁 —— adjustmentCny 是读-改-写，
      // 无锁并发会互相覆盖（少收一笔）。同时也让状态流转与本次改期严格串行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          adjustmentCny: true,
          adjustments: true,
          total: true,
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // ── 有效订单双闸（与换酒店同款）──
      // 改期会把占房挪到新区间、并可能通过 feeCny 改客户应付。死单/回收站单上改期 →
      // 死单凭空占住真实房量，且长出一笔并不存在的「欠款」。
      if (order.deletedAt) {
        throw new BadRequestError('订单在回收站（已软删），不可改期；如需操作请先恢复');
      }
      if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
        throw new BadRequestError(
          `订单当前状态（${zhStatus(order.status)}）不可改期：仅占座中的有效订单可改期（已取消/已退款/超时订单请勿改期）`,
        );
      }

      // ── 新区间余量闸（事务内互斥版）──
      let untrackedNights: string[] = [];
      if (roomType) {
        // 先锁目标区间的包房周期行，判定与下方写日期落库之间不留窗口，
        // 否则两笔并发改期会各自读到「还剩 1 间」的旧快照双双通过。
        await lockHotelBlockPeriodsWithinTx(tx, roomType.hotelId, nightDates);
        const orderPassengers = await tx.passenger.findMany({
          where: { orderId },
          select: { gender: true },
        });
        const fit = await checkHotelPhysicalFit(
          roomType.hotelId,
          nightDates,
          toProspectiveOccupancy(
            roomsBilled,
            orderPassengers.map((p) => ({ gender: p.gender ?? undefined })),
          ),
          // 排除本单自身占房 = 「先释放旧区间」；随后把本行房量按新区间加回去（prospective）。
          { excludeOrderId: orderId },
          tx,
        );
        if (fit.hasBlock) {
          untrackedNights = nightDates.filter((_, i) => fit.block[i] === 0);
          if (fit.violations.length > 0) {
            const detail = fit.violations
              .map(
                (v) =>
                  `${formatMonthDay(new Date(`${v.date}T00:00:00.000Z`))}实际房间不足（包房 ${v.block} 间，改到新日期后需 ${v.physicalUsed} 间）`,
              )
              .join('；');
            throw new BadRequestError(detail);
          }
        } else {
          // 整段没有任何包房周期 → 未纳入管控（房控哲学：未配包房 ≠ 售罄）
          untrackedNights = [...nightDates];
        }
      } else {
        // 未落位随机档行：按同星级聚合余量判定（口径同下单/落位）。
        // 用带锁版：此前虽已在事务内、传了 tx，但没有 FOR UPDATE —— 只读判定挡不住并发，
        // 两笔改期同时挤进同一档次的最后一间会双双通过。带锁版先锁该档次全部真酒店在该
        // 区间的包房周期行，与下方写新日期落库同事务，判定与落库之间不留窗口。
        await assertRandomTierFitWithinTx(tx, item.randomStarTier!, nightDates, roomsBilled, {
          excludeOrderId: orderId,
        });
      }

      // ── 减价不能把应付冲成负数（与换酒店同一道闸）──
      // 减价是合法操作，但没有下限就能把 effectivePayable（total + adjustmentCny）冲成负数，
      // 账面上凭空「欠客户钱」，而这笔欠款并没有对应的退款流水。
      if (feeCny < 0) {
        const currentPayable = round2(Number(order.total.toString()) + order.adjustmentCny);
        if (round2(currentPayable + feeCny) < 0) {
          throw new BadRequestError('减价金额不能超过当前应付（最多减到应付为 0）');
        }
      }

      // ── 1. 改写住宿区间 + description（金额/数量/间数/房型一律冻结）──
      // 这一条 UPDATE 同时完成「释放旧区间」与「占用新区间」：房控占房完全由这几个字段派生。
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          hotelCheckIn: newCheckIn,
          hotelCheckOut: newCheckOut,
          description: newDescription,
        },
      });

      // ── 2. 可选酒店改期差价（与改期费/换酒店差价同一 adjustmentCny 机制）──
      if (feeCny !== 0) {
        const log = appendAdjustment(order.adjustments, {
          type: 'HOTEL_RESCHEDULE_FEE',
          label: input.feeLabel || '酒店改期差价',
          amountCny: feeCny,
          at: new Date().toISOString(),
          by: actor.userId,
          note: input.note,
        });
        await tx.order.update({
          where: { id: orderId },
          data: { adjustmentCny: order.adjustmentCny + feeCny, adjustments: log },
        });
      }

      return { orderNumber: order.orderNumber, untrackedNights };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      // 对外脱敏：按操作者角色脱敏（ADMIN/STAFF 全量，其余剥离内部字段 + 逐项拆价）。
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: {
        orderNumber: scratch.orderNumber,
        orderItemId: item.id,
        before: { checkIn: beforeCheckIn, checkOut: beforeCheckOut, nights: beforeNights },
        after: { checkIn: input.newCheckIn, checkOut: input.newCheckOut, nights: newNights },
        feeCny,
        untrackedNights: scratch.untrackedNights,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // T5：更改订单归属代理（硬守卫 + 留审计）
  // 全程 ADMIN/STAFF（路由层 + 服务层双断言）。
  //
  // 财务口径（不回溯）：改归属绝不回滚任何已发生的资金账 —— 已收的款、已用原代理预存余额抵扣、
  // 已计提的佣金流水，一律按「事发时」的归属保留，不因本次改归属而重算或退回；本次变更只影响
  // 变更之后新产生的佣金/结算按新归属计。回收站单、已退款单、曾用原代理预存余额抵扣的订单拒绝，
  // 目标代理必须存在且在用；warning 字段保留为空以维持 API 形状。
  // ════════════════════════════════════════════════════════════════════
  async changeOrderAgent(
    orderId: string,
    input: { agentId: string | null; reason?: string },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    warning: string | null;
    audit: {
      orderNumber: string;
      before: { agentId: string | null; agentName: string | null };
      after: { agentId: string | null; agentName: string | null };
      reason?: string;
      usedAgentBalance: boolean;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可更改订单归属代理');
    }
    const newAgentId = input.agentId ?? null;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, agentId: true, status: true, deletedAt: true },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // 状态/软删守卫（A16）：回收站单与已退款单不该再改归属——
    //   · 回收站单（deletedAt≠null）：已软删隐身，改归属只会在恢复后制造一个归属被人动过的幽灵单。
    //   · 已退款单（REFUNDED，终态）：钱已结清，改代理无业务意义，只会污染报表归属。
    // 此前 select 连 status/deletedAt 都不取，这两类单都能被静默改归属。
    if (order.deletedAt) {
      throw new BadRequestError('回收站订单不能更改归属代理，请先恢复订单');
    }
    if (order.status === OrderStatus.REFUNDED) {
      throw new BadRequestError('已退款订单不能更改归属代理');
    }

    const oldAgentId = order.agentId;
    if (oldAgentId === newAgentId) {
      throw new BadRequestError('归属代理未变化');
    }

    // 目标代理校验（转直客 newAgentId=null 时跳过）：必须存在且在用，与建单归属同口径。
    let newAgentName: string | null = null;
    if (newAgentId) {
      const agent = await prisma.agent.findUnique({
        where: { id: newAgentId },
        select: { id: true, isActive: true, companyName: true, contactName: true },
      });
      if (!agent) throw new NotFoundError(`指定的代理不存在：${newAgentId}`);
      if (!agent.isActive) throw new BadRequestError('指定的代理已停用，无法归属订单');
      newAgentName = agent.companyName ?? agent.contactName;
    }

    // 旧代理名（审计/展示用；代理已被删/查不到时安全落 null）。
    let oldAgentName: string | null = null;
    if (oldAgentId) {
      const old = await prisma.agent.findUnique({
        where: { id: oldAgentId },
        select: { companyName: true, contactName: true },
      });
      oldAgentName = old ? old.companyName ?? old.contactName : null;
    }

    // 资金纠缠阻断（A16b，2026-07-17 拍板：有余额纠缠时阻断、强制先结清）：
    // 该订单若曾用（原代理）预存余额抵扣（applyAgentBalanceToOrder 挂 PrepaymentTransaction(OFFSET)），
    // 改归属后「多付转余额」会按新 agentId 入账 —— 原代理 A 的钱会变成新代理 B 的余额。
    // 旧口径只给警告不阻断；现改为硬阻断：先由财务把原代理的抵扣结清/冲回，再改归属。
    const balanceOffset = await prisma.prepaymentTransaction.findFirst({
      where: { orderId, type: PrepaymentTxType.OFFSET },
      select: { id: true },
    });
    if (balanceOffset != null) {
      throw new BadRequestError(
        '该订单曾用原代理预存余额抵扣，直接改归属会把原代理的钱记到新归属名下。' +
          '请先由财务结清/冲回该笔余额抵扣，再更改归属代理。',
      );
    }
    const usedAgentBalance = false; // 走到这里必然无 OFFSET（保留字段以稳定 API 形状）

    // ── 价格纠缠拆解（改归属最小安全动作）────────────────────────────────────
    // 旧口径只改 agentId：原代理 A 的立减 DISCOUNT 行、按 A 谈定的结算价差额行原样留给 B，
    // 而佣金之后按 B 的费率计提 —— 一单同时挂着两家代理的价格口径，谁也说不清这单该收多少。
    // 本次处置分两半：
    //   · 立减行（规则命中的 DISCOUNT，metadata.ruleId 有值）= 按 A 的规则库算出来的，
    //     对 B 无效 → **撤销并重算 subtotal/total**，让应收回到未打折的口径，由运营按 B 重新核价。
    //   · 结算价差额行（metadata.settlementPrice）= 人工与 A 谈定的一口价，撤销它等于替运营
    //     做价格决定 → **不自动动**，只在 warning 里点名，让运营自己决定改不改。
    const scratch = await prisma.$transaction(async (tx) => {
      // 与改结算价/补房差同一把锁：重算 subtotal/total 要「读 items → 聚合 → 写回 Order」，
      // 无锁时并发改价会各自从陈旧快照重算、后写覆盖前写。
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          subtotal: Prisma.Decimal;
          total: Prisma.Decimal;
          paidAmount: Prisma.Decimal;
          settlementLocked: boolean;
        }>
      >`SELECT id, subtotal, total, "paidAmount", "settlementLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const lockedOrder = locked[0];
      // 上面已按 id 查到过订单；锁的时候没了 = 并发删单，别拿半份数据继续算钱。
      if (!lockedOrder) throw new NotFoundError('订单不存在');

      // 锁之后才读行：锁之前那份快照可能已被并发改价写脏。
      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { id: true, kind: true, description: true, amount: true, metadata: true },
      });

      const readMetadata = (raw: unknown): Record<string, unknown> =>
        raw != null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};

      // 待撤销的立减行：规则命中（有 ruleId 快照）且尚未撤销的 DISCOUNT 行。
      // 手工 DISCOUNT 调价行没有 ruleId，不在此列 —— 那是运营自己填的，不随代理走。
      const revocableRows = items.filter((row) => {
        if (row.kind !== OrderItemKind.DISCOUNT) return false;
        const metadata = readMetadata(row.metadata);
        return (
          metadata.settlementDiscount === true &&
          metadata.settlementDiscountRevoked !== true &&
          typeof metadata.ruleId === 'string'
        );
      });

      // 结算价差额行（不自动动，只点名）：金额为 0 的不提，没什么可说的。
      const settlementRows = items.filter((row) => {
        const metadata = readMetadata(row.metadata);
        return metadata.settlementPrice === true && Number(row.amount) !== 0;
      });

      // 资金处置闸：撤立减会改 order.total（也是取消手续费/应退额的基数），取消族/超时/
      // 退款审批中的单一律不动金额 —— 否则能在批准退款前悄悄抬高应退额。
      // 但**改归属本身仍放行**（报表归属订正是这类单的正当需求），只是把没撤的立减在 warning 里点名。
      const canAdjustMoney = !FUNDS_DISPOSE_BLOCKED_STATUSES.includes(order.status);

      // 结算价锁：本次要改的正是订单金额，锁的语义（核对后禁止改价）在这里同样成立。
      // 没有立减行要撤 → 不改金额 → 与旧口径一样放行，不给日常改归属平添拒绝。
      if (revocableRows.length > 0 && canAdjustMoney && lockedOrder.settlementLocked) {
        throw new ConflictError(
          '该订单结算价已锁定，而本次改归属需要撤销原代理的立减行（会改动应收）。请先解锁结算价再改归属。',
        );
      }

      const revoked: Array<{ description: string; amountCny: number }> = [];
      for (const row of canAdjustMoney ? revocableRows : []) {
        const metadata = readMetadata(row.metadata);
        const amountCny = Math.abs(Number(row.amount) || 0);
        await tx.orderItem.update({
          where: { id: row.id },
          data: {
            // 撤销 = 金额归零 + 打撤销标记，**不删行**：这条立减发生过，留着可查
            // （与改期撤立减同一套 settlementDiscountRevoked 标记，行级幂等）。
            unitPrice: new Prisma.Decimal(0),
            amount: new Prisma.Decimal(0),
            description: row.description.startsWith('（已撤销）')
              ? row.description
              : `（已撤销）${row.description}`,
            metadata: {
              ...metadata,
              settlementDiscountRevoked: true,
              revokedReason: 'AGENT_CHANGED',
              revokedAt: new Date().toISOString(),
              revokedBy: actor.userId,
              revokedAmountCny: amountCny,
            } as Prisma.InputJsonValue,
          },
        });
        revoked.push({ description: row.description, amountCny });
      }

      // 从库里重新聚合最新 items 算 subtotal/total（上面的 update 已落在同一事务内）。
      // 无立减行可撤时跳过：金额没变，不必平白写一次 Order。
      let newTotalCny: number | null = null;
      if (revoked.length > 0) {
        const sumAgg = await tx.orderItem.aggregate({ where: { orderId }, _sum: { amount: true } });
        const newSubtotal = round2(
          Number((sumAgg._sum.amount ?? new Prisma.Decimal(0)).toString()),
        );
        newTotalCny = newSubtotal; // 当前无 taxes/discount，total = subtotal
        await tx.order.update({
          where: { id: orderId },
          data: {
            agentId: newAgentId,
            subtotal: new Prisma.Decimal(newSubtotal),
            total: new Prisma.Decimal(newTotalCny),
          },
        });
      } else {
        await tx.order.update({ where: { id: orderId }, data: { agentId: newAgentId } });
      }

      // 已计提佣金：按**事发时**的归属和费率提的，改归属不回溯重算（见本方法头部财务口径）。
      const accruedCommissions = await tx.commissionRecord.findMany({
        where: { orderId, status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] } },
        select: { amount: true },
      });
      const accruedCommissionCny = round2(
        accruedCommissions.reduce((s, c) => s + Number(c.amount.toString()), 0),
      );

      return {
        revoked,
        revokedTotalCny: round2(revoked.reduce((s, r) => s + r.amountCny, 0)),
        // 状态不允许动金额时没撤成的立减（只报，不动）。
        skippedDiscountCount: canAdjustMoney ? 0 : revocableRows.length,
        skippedDiscountTotalCny: canAdjustMoney
          ? 0
          : round2(
              revocableRows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0),
            ),
        settlementRowCount: settlementRows.length,
        settlementRowTotalCny: round2(
          settlementRows.reduce((s, r) => s + Number(r.amount), 0),
        ),
        beforeTotalCny: round2(Number(lockedOrder.total.toString())),
        newTotalCny,
        paidAmountCny: round2(Number(lockedOrder.paidAmount.toString())),
        accruedCommissionCny: accruedCommissions.length > 0 ? accruedCommissionCny : null,
      };
    });

    // 撤销立减留一条 WARNING 审计：应收被系统改动过，财务/运营要能翻得出来。
    if (scratch.revoked.length > 0) {
      await writeAudit({
        actor: { userId: actor.userId, role: actor.role },
        action: 'AGENT_CHANGED_DISCOUNT_REVOKED',
        targetType: 'ORDER',
        targetId: orderId,
        targetLabel: order.orderNumber,
        before: { total: scratch.beforeTotalCny, agentId: oldAgentId },
        after: {
          total: scratch.newTotalCny,
          agentId: newAgentId,
          revokedCny: scratch.revokedTotalCny,
          revokedRows: scratch.revoked,
          reason: input.reason ?? null,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    // warning：把「系统替你动了什么 / 还有什么等你决定」一次讲清，别让运营事后才发现金额变了。
    const warningParts: string[] = [];
    if (scratch.revoked.length > 0) {
      warningParts.push(
        `已撤销原代理口径的立减 ${scratch.revoked.length} 条（合计 ¥${scratch.revokedTotalCny}），` +
          `订单应收由 ¥${scratch.beforeTotalCny} 调整为 ¥${scratch.newTotalCny}。请按新代理口径重新核价。`,
      );
    }
    if (scratch.skippedDiscountCount > 0) {
      warningParts.push(
        `该订单当前状态（${zhStatus(order.status)}）不允许改动金额，` +
          `原代理口径的立减 ${scratch.skippedDiscountCount} 条（合计 ¥${scratch.skippedDiscountTotalCny}）未撤销，请人工核对处理。`,
      );
    }
    if (scratch.settlementRowCount > 0) {
      warningParts.push(
        `本单还有 ${scratch.settlementRowCount} 条结算价差额行（合计 ¥${scratch.settlementRowTotalCny}），` +
          '是按原代理谈定的一口价，系统未自动改动 —— 请确认新代理是否沿用该结算价。',
      );
    }
    if (scratch.newTotalCny !== null && scratch.paidAmountCny > scratch.newTotalCny) {
      warningParts.push(
        `该单已收 ¥${scratch.paidAmountCny}，调整后应收 ¥${scratch.newTotalCny}，` +
          `形成多付 ¥${round2(scratch.paidAmountCny - scratch.newTotalCny)}。` +
          '请在订单资金区做多付处置（转代理余额 / 转挂账池 / 退款）。',
      );
    }
    if (scratch.accruedCommissionCny !== null) {
      warningParts.push(
        `本单已计提佣金 ¥${scratch.accruedCommissionCny}（按原归属与当时费率），改归属不回溯重算，请财务确认是否调整。`,
      );
    }
    const warning = warningParts.length > 0 ? warningParts.join(' ') : null;

    return {
      // 显式按角色推导序列化口径（本入口已断言 ADMIN/STAFF → 保留护照大图，与改归属前的返回一致）。
      // serializeOrder 的护照大图缺省是 fail-closed，不显式传 ctx 会静默剥掉后台需要的缩略图。
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      warning,
      audit: {
        orderNumber: order.orderNumber,
        before: { agentId: oldAgentId, agentName: oldAgentName },
        after: { agentId: newAgentId, agentName: newAgentName },
        reason: input.reason,
        usedAgentBalance,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 事后补收单房差（ADMIN/STAFF）
  // 建单后按「每晚金额 × 晚数」补收单房差：单事务内新增一条 FEE 调整行 + 重算 order.subtotal/total
  // + 追加 order.adjustments 审计流水（参考改期费的 appendAdjustment 模式）。
  //
  // 钱口径：金额随新 FEE 行进入 subtotal/total（应付/尾款自然增加）——不走 adjustmentCny（那是
  // 改期费/换人费的机制），避免与本行重复计钱。order.adjustments 只作审计流水（不参与金额合计）。
  // 仅含 BUNDLE/HOTEL 行的订单可用（纯机票单无住宿 → 400）。
  // ════════════════════════════════════════════════════════════════════
  /**
   * 订单详情补录一条结构化 HOTEL/VISA 行。
   * 产品只负责提供当前成本与展示名称；落库后的收入单价和成本快照互不回写。
   */
  async addGroundItem(
    orderId: string,
    input: AddGroundItemBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      itemId: string;
      kind: 'VISA' | 'HOTEL';
      productId: string;
      amountCny: number;
      unitPriceCny: number;
      unitCostCny: number | null;
      totalCostCny: number | null;
      visaTaskCreated: boolean;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可补录签证或房费');
    }

    const scratch = await prisma.$transaction(async (tx) => {
      // 与补房差/调价相同：锁订单后再读取行，避免并发补录丢失订单总额更新。
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          visaStatus: true,
          subtotal: true,
          total: true,
          items: { select: { amount: true } },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');
      // 资金闸与其他改 total 通道同源：已退款/超时/草稿/已取消/回收站单一律拒绝，
      // 防止终态订单的历史金额被追加地面项改写。
      assertOrderAcceptsFunds(order);

      let productName: string;
      let costPriceCny: number | null;
      let unitPriceCny: number;
      let quantity: number;
      let rooms: number | undefined;
      let description: string;
      let hotelCheckIn: Date | null = null;
      let hotelCheckOut: Date | null = null;
      // 签证行的「预计出行日期」锚点（可空）：纯签证单派生整单出发日的第三级回退，
      // 与建单路径落的是同一列，按出发日期区间导出才捞得到后补的签证单。
      let visaIntendedDate: Date | null = null;
      let visaTaskCreated = false;

      if (input.kind === 'VISA') {
        const visa = await tx.visa.findUnique({
          where: { id: input.visaId },
          select: {
            id: true,
            visaName: true,
            visaType: true,
            country: true,
            destinationCountry: true,
            costPriceCny: true,
            isActive: true,
          },
        });
        if (!visa) throw new NotFoundError(`签证产品 ${input.visaId} 不存在`);
        if (!visa.isActive) throw new BadRequestError('签证产品已下架');
        productName = visa.visaName ?? visa.visaType ?? visa.country ?? visa.destinationCountry;
        costPriceCny = visa.costPriceCny == null ? null : Number(visa.costPriceCny);
        unitPriceCny = resolveGroundItemUnitPrice({
          requestedUnitPriceCny: input.unitPriceCny,
          costPriceCny,
          label: '签证',
        });
        quantity = input.quantity ?? (await tx.passenger.count({ where: { orderId } }));
        if (quantity < 1) throw new BadRequestError('该订单没有乘客，无法按人数补录签证');
        description = `${productName} × ${quantity}人`;
        // @db.Date 列：按 UTC 零点写入（与建单路径、hotelCheckIn 同款），不折时区。
        if (input.visaIntendedDate) {
          visaIntendedDate = new Date(`${input.visaIntendedDate}T00:00:00.000Z`);
          if (
            Number.isNaN(visaIntendedDate.getTime()) ||
            visaIntendedDate.toISOString().slice(0, 10) !== input.visaIntendedDate
          ) {
            throw new BadRequestError('预计出行日期无效');
          }
        }
      } else {
        const roomType = await tx.hotelRoomType.findUnique({
          where: { id: input.hotelRoomTypeId },
          select: {
            id: true,
            name: true,
            costPriceCny: true,
            hotel: { select: { name: true, isActive: true } },
          },
        });
        if (!roomType) throw new NotFoundError(`酒店房型 ${input.hotelRoomTypeId} 不存在`);
        if (!roomType.hotel.isActive) throw new BadRequestError('酒店已下架');
        productName = `${roomType.hotel.name} ${roomType.name}`;
        costPriceCny = roomType.costPriceCny == null ? null : Number(roomType.costPriceCny);
        unitPriceCny = resolveGroundItemUnitPrice({
          requestedUnitPriceCny: input.unitPriceCny,
          costPriceCny,
          label: '酒店房型',
        });
        quantity = input.nights;
        rooms = input.rooms;
        const roomsLabel = Number.isInteger(rooms) ? String(rooms) : rooms.toFixed(1);
        description = `${productName} × ${quantity}晚 × ${roomsLabel}间`;
        if (input.checkIn) {
          hotelCheckIn = new Date(`${input.checkIn}T00:00:00.000Z`);
          hotelCheckOut = new Date(`${addDaysToYmd(input.checkIn, quantity)}T00:00:00.000Z`);
          if (
            Number.isNaN(hotelCheckIn.getTime()) ||
            Number.isNaN(hotelCheckOut.getTime()) ||
            hotelCheckIn.toISOString().slice(0, 10) !== input.checkIn
          ) {
            throw new BadRequestError('入住日期无效');
          }
        }
      }

      // ── 酒店房量闸（CRITICAL 修复，与建单同一把闸）───────────────────────────
      // 补录房费与建单一样是「往真实酒店新增占房」，此前同样一道闸都没有：售罄后照样补录，
      // 销控板直接变负。本调用已在事务内并持有 Order 行锁，这里再锁目标酒店该区间的包房周期行
      // 后判定，与下方 orderItem.create 落库同一事务，判定与落库之间没有窗口。
      // 无入住日期（未填 checkIn）→ 无从判定占的是哪几晚，与既有「不盖日期就不进房控」口径一致，跳过。
      // 后台补录：房量不足要让运营看得见差多少间，故用默认的带数字文案（不套对外中性话术）。
      if (input.kind === 'HOTEL' && hotelCheckIn && hotelCheckOut) {
        const orderPassengers = await tx.passenger.findMany({
          where: { orderId },
          select: { gender: true },
        });
        await assertHotelStaysFitWithinTx(
          tx,
          [
            {
              hotelRoomTypeId: input.hotelRoomTypeId,
              hotelCheckIn,
              hotelCheckOut,
              roomsBilled: rooms,
            },
          ],
          orderPassengers.map((p) => ({ gender: p.gender ?? undefined })),
          // 不传 excludeOrderId：本单在该酒店**已有**的占房是真实存量，补录是在它之上再加一笔，
          // 排除本单等于把自己已占的房当成空房，会放行超卖。
        );
      }

      const priced = computeGroundItemAmounts({
        kind: input.kind,
        unitPriceCny,
        quantity,
        rooms,
        costPriceCny,
      });
      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: input.kind === 'VISA' ? OrderItemKind.VISA : OrderItemKind.HOTEL,
          description,
          quantity,
          unitPrice: new Prisma.Decimal(unitPriceCny),
          amount: new Prisma.Decimal(priced.amount),
          unitCostCny: priced.unitCostCny == null ? null : new Prisma.Decimal(priced.unitCostCny),
          totalCostCny: priced.totalCostCny == null ? null : new Prisma.Decimal(priced.totalCostCny),
          hotelRoomTypeId: input.kind === 'HOTEL' ? input.hotelRoomTypeId : null,
          hotelCheckIn,
          hotelCheckOut,
          visaId: input.kind === 'VISA' ? input.visaId : null,
          visaIntendedDate,
          roomsBilled: input.kind === 'HOTEL' ? new Prisma.Decimal(rooms!) : null,
          metadata: {
            source: 'ORDER_GROUND_ITEM',
            note: input.note ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      // 新增 VISA 行按建单时相同的乘客级口径补建任务；任务挂在新行上，默认 PENDING。
      if (input.kind === 'VISA') {
        const passengers = await tx.passenger.findMany({
          where: { orderId },
          select: { visaExempt: true },
        });
        if (
          orderNeedsVisaTask({
            visaStatus: order.visaStatus,
            hasVisaScope: true,
            passengers,
          })
        ) {
          await tx.fulfillmentTask.create({
            data: {
              orderItemId: created.id,
              type: FulfillmentType.VISA_APPLICATION,
              status: FulfillmentStatus.PENDING,
            },
          });
          visaTaskCreated = true;
        }
      }

      // 已过 PAID 履约生成点的订单（非待付款）：幂等补建新行的履约任务——
      // 否则付款后补录的房费行没有 HOTEL_BOOKING 任务，履约视图看不见它。
      // createFulfillmentTasks 按 item×类型跳过已有活动任务，VISA 分支刚建的任务不会重复。
      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        await createFulfillmentTasks(tx, orderId);
      }

      const newSubtotal = round2(
        order.items.reduce((sum, item) => sum + Number(item.amount.toString()), 0) + priced.amount,
      );
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newSubtotal),
        },
      });

      return {
        orderNumber: order.orderNumber,
        itemId: created.id,
        kind: input.kind,
        productId: input.kind === 'VISA' ? input.visaId : input.hotelRoomTypeId,
        amountCny: priced.amount,
        unitPriceCny,
        unitCostCny: priced.unitCostCny,
        totalCostCny: priced.totalCostCny,
        visaTaskCreated,
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: scratch,
    };
  }

  async addRoomSupplement(
    orderId: string,
    input: {
      perNightCny: number;
      nights: number;
      note?: string;
      idempotencyKey?: string;
      passengerId?: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      itemId: string;
      perNightCny: number;
      nights: number;
      amountCny: number;
      before: { subtotal: string; total: string };
      after: { subtotal: string; total: string };
      note?: string;
      /** A15 房控联动结果说明（未传 passengerId / 幂等回放时为 null）。*/
      roomControl: string | null;
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可补收单房差');
    }
    const { perNightCny, nights } = input;
    const amount = perNightCny * nights;
    const row = buildRoomSupplementItem(input);

    const scratch = await prisma.$transaction(async (tx) => {
      // 行锁：先锁住订单行，串行化并发补房差。否则两个并发请求各读旧 items、各加一条 FEE、
      // 各按「旧合计 + 一次房差」写 total → 丢失更新（两条 FEE 行，但 total 只含一条）。
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      // 幂等回放：同 idempotencyKey 已入账（双击/超时重发）→ 直接返回当时结果，绝不二次追加 FEE。
      if (input.idempotencyKey) {
        const dup = await tx.orderItem.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true, orderId: true },
        });
        if (dup) {
          if (dup.orderId !== orderId) {
            throw new BadRequestError('幂等键已用于其它订单，不能复用');
          }
          const cur = await tx.order.findUniqueOrThrow({
            where: { id: orderId },
            select: { orderNumber: true, subtotal: true, total: true },
          });
          // 回放：金额不变（before === after），审计流水不重复追加。
          return {
            orderNumber: cur.orderNumber,
            itemId: dup.id,
            beforeSubtotal: cur.subtotal.toString(),
            beforeTotal: cur.total.toString(),
            afterSubtotal: cur.subtotal.toString(),
            afterTotal: cur.total.toString(),
            roomControl: null, // 回放：首次调用已完成房控联动，不重复
          };
        }
      }

      // items 在 FOR UPDATE 之后读取 → 看到的是已提交状态（含前一并发请求刚落的 FEE 行），
      // 据此重聚合 total，杜绝「基于锁前陈旧快照重算」的错账。
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          subtotal: true,
          total: true,
          adjustments: true,
          items: { select: { id: true, kind: true, amount: true } },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');
      // 资金闸：补房差新增 FEE 行并抬高 order.total —— total 正是应退额与取消手续费的计算基数。
      // 已取消/已退款/支付超时/草稿/回收站的单若还能补收，等于给死单凭空加应收：
      // 已退款单被抬高 total 后可再算出一笔"应退"，形成二次退款。
      assertOrderAcceptsFunds(order);

      // 仅含 BUNDLE/HOTEL 行的订单可补收单房差（纯机票单无住宿 → 拒绝）。
      const hasStay = order.items.some(
        (it) => it.kind === OrderItemKind.HOTEL || it.kind === OrderItemKind.BUNDLE,
      );
      if (!hasStay) {
        throw new BadRequestError('该订单不含酒店/套餐行，无法补收单房差');
      }

      // ── 0. 房控联动（A15，2026-07-17 拍板：带 passengerId 的编辑住宿通道）────────────
      // 收钱的同时把「谁转单住」落到库存侧：Passenger.singleRoom=true + 套餐行 roomsBilled
      // 按权威公式重算。房控销控板/分房/超卖提醒全是派生账（每次现查订单），这两个字段
      // 一更新即自动跟上 —— 房量不够时提醒线会自动亮「该加房」，无需在此另设闸。
      let roomControl: string | null = null;
      // 补房差 FEE 行的成本口径（毛利真账）：默认 0（无增房 = 只收差价不产生房成本）。
      // 仅在套餐行计费房数真正上调（新增房间）时，按每晚成本 × 晚数 × 新增房数落实成本。
      let feeTotalCostCny = 0;
      let feeCostSource: RoomCostSource = 'ZERO';
      if (input.passengerId) {
        const pax = await tx.passenger.findUnique({
          where: { id: input.passengerId },
          select: { id: true, orderId: true, fullName: true, singleRoom: true },
        });
        if (!pax || pax.orderId !== orderId) {
          throw new BadRequestError('指定的乘客不存在或不属于本订单');
        }
        if (pax.singleRoom) {
          throw new BadRequestError(`乘客 ${pax.fullName} 已是单人入住，请勿重复补收单房差`);
        }
        await tx.passenger.update({
          where: { id: pax.id },
          data: { singleRoom: true },
        });
        roomControl = `乘客 ${pax.fullName} 已标记单人入住`;

        // 套餐行：按权威公式重算计费房数（独住者各占一间；只升不降，防误缩）。
        // 纯 HOTEL 行的房数由运营在分房里直接管理，这里只落 singleRoom 标记。
        const bundleItem = await tx.orderItem.findFirst({
          where: { orderId, kind: OrderItemKind.BUNDLE },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            metadata: true,
            roomsBilled: true,
            // 下单时的每间每晚成本快照（BUNDLE 行建单未快照 → null，回退现行房型成本价）。
            unitCostCny: true,
            bundle: {
              select: {
                hotelRoomTypeId: true,
                hotelRoomType: { select: { maxAdults: true, maxChildren: true, costPriceCny: true } },
              },
            },
          },
        });
        if (bundleItem?.bundle) {
          const newSingleCount = await tx.passenger.count({
            where: { orderId, singleRoom: true },
          });
          const occupancy = resolveBundleOccupancy({
            metadata: (bundleItem.metadata ?? {}) as Record<string, unknown>,
          });
          const roomsCharged = computeBundleRoomsCharged({
            occupancy,
            capacity: bundleItem.bundle.hotelRoomType,
            hotelRoomTypeId: bundleItem.bundle.hotelRoomTypeId,
            singleCount: newSingleCount,
            clientRoomsBilled: undefined,
          });
          const before = bundleItem.roomsBilled == null ? null : Number(bundleItem.roomsBilled.toString());
          if (before == null || roomsCharged > before) {
            await tx.orderItem.update({
              where: { id: bundleItem.id },
              data: { roomsBilled: new Prisma.Decimal(roomsCharged) },
            });
            // 新增计费房数 = 新旧 roomsBilled 之差（旧值未设时保守取 0，基线未知不虚构成本）。
            // 每晚成本三级回退：套餐行下单快照 → 现行房型成本价 → 0。晚数与描述里的 N 同源。
            const addedRooms = before == null ? 0 : Math.max(0, roomsCharged - before);
            const resolvedCost = resolveRoomSupplementCost({
              snapshotUnitCostCny:
                bundleItem.unitCostCny != null ? Number(bundleItem.unitCostCny.toString()) : null,
              productCostPriceCny:
                bundleItem.bundle.hotelRoomType?.costPriceCny != null
                  ? Number(bundleItem.bundle.hotelRoomType.costPriceCny.toString())
                  : null,
              nights,
              addedRooms,
            });
            feeTotalCostCny = resolvedCost.totalCostCny;
            feeCostSource = resolvedCost.costSource;
            roomControl += `；套餐行计费房数 ${before ?? '未设'} → ${roomsCharged}（房控/分房自动跟进）`;
          } else {
            roomControl += `；计费房数维持 ${before}（权威重算 ${roomsCharged} 未超过现值，只升不降）`;
          }
        } else {
          roomControl += '；本单为酒店行订单，房数请在分房面板调整（单住标记已生效）';
        }
      }

      // ── 1. 新增一条 FEE 调整行（描述含 ¥X/晚 × N晚，metadata 记 perNightCny/nights + costSource）──
      // 成本口径（Task A）：新增计费房数 × 每晚成本 × 晚数，随行落 totalCostCny（毛利真账）。
      // 无增房或无成本数据 → 0，costSource='ZERO'。原酒店/套餐行的成本快照一个字不动。
      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: OrderItemKind.FEE,
          description: row.description,
          quantity: 1,
          unitPrice: new Prisma.Decimal(row.unitPrice),
          amount: new Prisma.Decimal(row.amount),
          totalCostCny: new Prisma.Decimal(feeTotalCostCny),
          metadata: { ...row.metadata, costSource: feeCostSource } as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      // ── 2. 用所有既有行 + 新行重算 subtotal/total（当前无 taxes/discount，total = subtotal）──
      const newSubtotal = round2(
        order.items.reduce((sum, it) => sum + Number(it.amount.toString()), 0) + amount,
      );
      const newTotal = newSubtotal;

      // ── 3. 审计流水（appendAdjustment；仅记录用，钱走上面的 total，不进 adjustmentCny）──
      const log = appendAdjustment(order.adjustments, {
        type: 'ROOM_SUPPLEMENT',
        label: row.description,
        amountCny: amount,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newTotal),
          adjustments: log,
        },
      });

      return {
        orderNumber: order.orderNumber,
        itemId: created.id,
        beforeSubtotal: order.subtotal.toString(),
        beforeTotal: order.total.toString(),
        afterSubtotal: newSubtotal.toString(),
        afterTotal: newTotal.toString(),
        roomControl,
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      // 显式按角色推导序列化口径（本入口已断言 ADMIN/STAFF → 保留护照大图，与补收前的返回一致）。
      // serializeOrder 的护照大图缺省是 fail-closed，不显式传 ctx 会静默剥掉后台需要的缩略图。
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: {
        orderNumber: scratch.orderNumber,
        itemId: scratch.itemId,
        perNightCny,
        nights,
        amountCny: amount,
        before: { subtotal: scratch.beforeSubtotal, total: scratch.beforeTotal },
        after: { subtotal: scratch.afterSubtotal, total: scratch.afterTotal },
        note: input.note,
        roomControl: scratch.roomControl,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 事后调价（POST /orders/:id/price-adjustment · 0722 公测反馈「按乘客调价」）
  //
  // 一张多人订单内，给「整单」或「指定乘客」挂一笔结算价差额（正=补收、负=优惠）+原因，走
  // 与录单调价完全同一路径：追加一条独立 priceAdjustment OrderItem（kind FEE/DISCOUNT），
  // 金额随该行进入 subtotal/total（订单总额 = 系统价 + Σ调整）。passengerId 非空 = 只作用于
  // 该乘客的应收份额（金额明细逐人可解释）；空 = 整单调价（现行为不变）。
  //
  // 服务端权威定价底线：绝不改任何既有明细行价格，只加差额行 + 审计留痕（reasonCode/经手/时间）。
  // 资金闸：assertOrderAcceptsFunds —— 已取消/已退款/超时/草稿单不许再抬/降 total（防二次退款）。
  // 并发：FOR UPDATE 锁订单行后再读 items 重算 total（与补房差同款，杜绝丢失更新）。
  // ════════════════════════════════════════════════════════════════════
  async addPriceAdjustment(
    orderId: string,
    input: OrderPriceAdjustmentBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      itemId: string;
      amountCny: number;
      reasonCode: string;
      passengerId: string | null;
      passengerName: string | null;
      before: { subtotal: string; total: string };
      after: { subtotal: string; total: string };
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可调整订单价格');
    }
    const { amountCny, reasonCode, reasonText } = input;
    const row = buildPriceAdjustmentItem({ amountCny, reasonCode, reasonText });

    const scratch = await prisma.$transaction(async (tx) => {
      // 行锁：先锁订单行串行化并发调价，避免两个并发请求各读旧 items、各加一条差额行、
      // 各按「旧合计 + 一次差额」写 total → 丢失更新（两条行，total 只含一条）。
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          subtotal: true,
          total: true,
          adjustments: true,
          items: { select: { id: true, amount: true } },
        },
      });
      if (!order) throw new NotFoundError('订单不存在');
      // 资金闸：调价新增/降低差额行会改 order.total —— total 是应退额与取消手续费的计算基数。
      // 死单（已取消/已退款/支付超时/草稿）若还能调价，等于凭空改动死单应收，可被算出二次退款。
      assertOrderAcceptsFunds(order);

      // passengerId 归属校验：非空必须属于本单，否则 400（不接受跨单/不存在的乘客）。
      let passengerName: string | null = null;
      if (input.passengerId) {
        const pax = await tx.passenger.findUnique({
          where: { id: input.passengerId },
          select: { id: true, orderId: true, fullName: true },
        });
        if (!pax || pax.orderId !== orderId) {
          throw new BadRequestError('指定的乘客不存在或不属于本订单');
        }
        passengerName = pax.fullName;
      }

      // ── 1. 追加一条 priceAdjustment 差额行（passengerId 非空 = 该乘客名下；空 = 整单）──
      // 纯价格调整行（优惠/补收/调价）无采购成本 → totalCostCny 显式落 0（row 已带 0），不留 NULL。
      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: row.kind,
          description: row.description,
          quantity: 1,
          unitPrice: new Prisma.Decimal(row.unitPrice),
          amount: new Prisma.Decimal(row.amount),
          totalCostCny: new Prisma.Decimal(row.totalCostCny),
          metadata: row.metadata as Prisma.InputJsonValue,
          passengerId: input.passengerId ?? null,
        },
      });

      // ── 2. 用所有既有行 + 新行重算 subtotal/total（当前无 taxes/discount，total = subtotal）──
      const newSubtotal = round2(
        order.items.reduce((sum, it) => sum + Number(it.amount.toString()), 0) + amountCny,
      );
      const newTotal = newSubtotal;

      // ── 3. 审计流水（appendAdjustment；仅记录用，钱走上面的 total，不进 adjustmentCny）──
      const log = appendAdjustment(order.adjustments, {
        type: 'PRICE_ADJUSTMENT',
        label: row.description,
        amountCny,
        at: new Date().toISOString(),
        by: actor.userId,
        reasonCode,
        note: reasonText?.trim() || undefined,
        ...(input.passengerId ? { passengerId: input.passengerId } : {}),
      });

      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newTotal),
          adjustments: log,
        },
      });

      return {
        orderNumber: order.orderNumber,
        itemId: created.id,
        passengerName,
        beforeSubtotal: order.subtotal.toString(),
        beforeTotal: order.total.toString(),
        afterSubtotal: newSubtotal.toString(),
        afterTotal: newTotal.toString(),
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: {
        orderNumber: scratch.orderNumber,
        itemId: scratch.itemId,
        amountCny,
        reasonCode,
        passengerId: input.passengerId ?? null,
        passengerName: scratch.passengerName,
        before: { subtotal: scratch.beforeSubtotal, total: scratch.beforeTotal },
        after: { subtotal: scratch.afterSubtotal, total: scratch.afterTotal },
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 售后改单：套餐改档（POST /orders/:id/change-bundle · ADMIN/STAFF）
  //
  // 行业口径 = amendment：**改档 → 按新档重新计价 → 差价入账 → 审计**。
  // 数据模型上「档次」不是套餐的一个可改字段，而是另一条 Bundle 记录
  // （settlementTier / settlementNights 都挂在 Bundle 上），所以改档 = 把订单的 BUNDLE 行换绑。
  // 此前系统没有这个动作：运营只能「换酒店 + 手工调价」拼出来，钱与货各改各的、对不上账。
  //
  // 定价哲学（与换酒店 / 酒店改期同一套）：**行价冻结 + 差额入账**。
  //   · BUNDLE 行只换绑（bundleId / 行描述 / 随档次派生的住宿区间与间数），金额一个字不动；
  //   · 「新应收 − 原应收」落一条 bundleChange 差额行（正=补收、负=优惠），
  //     订单 subtotal/total 按 Σ items 收敛；
  //   · **已收款项一分不动** —— 尾款/多收自然浮动（应付 = total + adjustmentCny，收款账不参与）。
  //
  // 新应收的两条取价通道（与录单完全同源，不另起炉灶）：
  //   a) 代理单 + 新套餐配了结算价日历键（档次 + 晚数）→ 走结算价日历：
  //      每人价（新档 × 新晚数 × 本单去程出发日）× 人数 + 加项净额 − 命中的代理立减；
  //      取不到当日价 → 拒单（口径同录单：宁可不改，也不按错价成交）。
  //   b) 其余 → 本地权威价管道：新套餐地面价 + 加项 + 操作费，再按新套餐 discountPct 打折；
  //      新应收 = 原应收 + （新套餐行价 − 旧套餐行价）。
  //
  // 硬边界（改档不碰的东西）：
  //   · 机票行 / 班次 / 座位一律不动 —— 改档不改航班，绝不在此触碰任何占座链路；
  //   · 升舱行若与旧套餐档次绑定，同样保持不动（响应 warnings 提示人工复核）；
  //   · 指定酒店及其加价随本次改档清除（新档的酒店要重新指定，响应 warnings 提示）。
  // ════════════════════════════════════════════════════════════════════
  async changeOrderBundle(
    orderId: string,
    input: ChangeOrderBundleBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: {
        bundleId: string;
        bundleName: string | null;
        settlementTier: SettlementTier | null;
        settlementNights: number | null;
        total: string;
      };
      after: {
        bundleId: string;
        bundleName: string | null;
        settlementTier: SettlementTier | null;
        settlementNights: number | null;
        total: string;
      };
      diffCny: number;
      diffItemId: string | null;
      pricingSource: 'SETTLEMENT_CALENDAR' | 'BUNDLE_PRICE';
      note: string | null;
      warnings: string[];
    };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可更改套餐档次');
    }
    const note = input.note?.trim() || null;

    // ── 0. 事务外只读预检（只为「明显不该改的单别开事务」快速失败）───────────
    // 这里读到的一切都只是**预检**：状态、明细、总额都可能在开事务前被并发操作改掉。
    // 权威判定（状态 / 落位 / 计价 / 房量）一律在下面的行锁内、基于锁后重读的快照重做一遍，
    // 锁外算出来的钱一分都不落库 —— 否则改档窗口期内的并发调价会被差额行静默抵消。
    const preview = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        items: { select: CHANGE_BUNDLE_ITEM_SELECT },
      },
    });
    if (!preview) throw new NotFoundError('订单不存在');
    assertOrderChangeBundleAllowed(preview);
    const previewPick = resolveChangeableBundleRow(preview.items, input.bundleId);

    const newBundle = await prisma.bundle.findUnique({
      where: { id: input.bundleId },
      select: CHANGE_BUNDLE_PRICING_SELECT,
    });
    if (!newBundle) throw new NotFoundError(`套餐 ${input.bundleId} 不存在`);
    if (!newBundle.isActive) throw new BadRequestError('目标套餐已下架');
    const oldBundle = await prisma.bundle.findUnique({
      where: { id: previewPick.bundleId },
      select: { id: true, name: true, settlementTier: true, settlementNights: true },
    });

    // ── 1. 事务：锁 → 重读 → 计价 → 房量闸 → 换绑 + 差额行 + 总额收敛 + 签证任务对齐 ──
    const scratch = await prisma.$transaction(async (tx) => {
      // 行锁：与换酒店/换人/调价同一份读-改-写（total / 差额行），必须串行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      const locked = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          deletedAt: true,
          agentId: true,
          subtotal: true,
          total: true,
          adjustments: true,
          items: { select: CHANGE_BUNDLE_ITEM_SELECT },
        },
      });
      if (!locked) throw new NotFoundError('订单不存在');
      // 锁后复检（读的是刚 FOR UPDATE 的那一行，与并发状态流转严格串行）。
      assertOrderAcceptsFunds(locked);
      assertOrderChangeBundleAllowed(locked);
      // 明细同样锁后重挑：并发可能已经改过档、已落位、或加了第二条套餐行。
      const { row: bundleRow, bundleId: fromBundleId } = resolveChangeableBundleRow(
        locked.items,
        input.bundleId,
      );
      // CAS：锁前预检看到的那条行若已被并发操作换掉，本次就是在另一张套餐上做决定 → 让调用方重试。
      if (bundleRow.id !== previewPick.row.id || fromBundleId !== previewPick.bundleId) {
        throw new ConflictError('该订单的套餐行已被其他操作更改，请刷新后重试');
      }

      // ── 计价输入：一律沿用**锁内快照**里已盖章的数，保证差额只反映「档次变了」这一件事 ──
      // 优先级：行 metadata.addOns（下单时的权威重算快照，含三计数 / 单住 / 分程升舱 / 自备签人数）
      //        → metadata / quantity 的旧口径回落（老单没有 addOns 快照时）。
      const rowMetadata = (bundleRow.metadata ?? {}) as Record<string, unknown>;
      const addOnSnapshot = rowMetadata.addOns as Partial<BundleAddOnBreakdown> | undefined;
      const occupancy =
        addOnSnapshot && typeof addOnSnapshot.adultCount === 'number'
          ? resolveBundleOccupancy({
              adultCount: addOnSnapshot.adultCount,
              childCount: addOnSnapshot.childCount ?? 0,
              infantCount: addOnSnapshot.infantCount ?? 0,
              quantity: bundleRow.quantity,
            })
          : resolveBundleOccupancy({ quantity: bundleRow.quantity, metadata: rowMetadata });
      const singleCount = Math.max(0, Math.trunc(Number(addOnSnapshot?.singleCount ?? 0) || 0));
      const selfProvidedVisaCount = Math.max(
        0,
        Math.trunc(Number(addOnSnapshot?.selfProvidedVisaCount ?? 0) || 0),
      );
      const businessSplit: BundleBusinessUpgradeSplit = {
        outbound: Math.max(0, Math.trunc(Number(addOnSnapshot?.businessCountOutbound ?? 0) || 0)),
        return: Math.max(0, Math.trunc(Number(addOnSnapshot?.businessCountReturn ?? 0) || 0)),
      };

      // 出发日：整单口径（最早航段的出发地当地日 → 酒店入住日 → 签证预计出行日），与列表列同源。
      const departYmd = deriveOrderDepartDate(
        locked.items as unknown as Array<Record<string, unknown>>,
      );

      // 自备签减免单一配置源：null = 跟随签证组件产品价（与录单计价同一解析，改档不例外）。
      const changedSelfVisaDeductCny = await resolveSelfVisaDeductCny(newBundle, tx);
      const priced = computeChangedBundleLine({
        bundle: { ...newBundle, selfVisaDeductCny: changedSelfVisaDeductCny },
        occupancy,
        singleCount,
        businessSplit,
        selfProvidedVisaCount,
        quantity: bundleRow.quantity,
        goDate: departYmd,
      });

      // ── 新应收 ───────────────────────────────────────────────────────────
      // 旧档的**有效金额** = 冻结的套餐行金额 + 历次改档差额行合计。
      // 行价冻结意味着套餐行金额永远停在首次录单那一刻，只看它当基线会让第二次改档
      // 把上一次的差额再算一遍（A→B 留 +200 后，B→C 会按 A 的价算成 C−A，凭空多收 200）。
      // 把既有差额行加回来，基线才是「这条套餐行现在实际贡献了多少应收」，
      // 于是任意次改档后的总额恒等于「按当前档从头录单」的应收。
      const frozenBundleAmountCny = Number(bundleRow.amount.toString());
      const priorBundleChangeCny = sumBundleChangeDiffCny(locked.items);
      const effectiveOldBundleCny = round2(frozenBundleAmountCny + priorBundleChangeCny);
      // 总额基准取锁内值：并发调价改动的那部分留在总额里往前带，绝不被差额行抵消掉。
      const lockedTotalCny = Number(locked.total.toString());
      let pricingSource: 'SETTLEMENT_CALENDAR' | 'BUNDLE_PRICE' = 'BUNDLE_PRICE';
      let newTotalCny = round2(lockedTotalCny + (priced.amount - effectiveOldBundleCny));
      if (
        locked.agentId &&
        newBundle.settlementTier != null &&
        newBundle.settlementNights != null
      ) {
        if (!departYmd) {
          throw new BadRequestError(
            '目标套餐已配置结算价日历，但本单无法确定出发日期取价，请先补全航段或联系运营',
          );
        }
        const rate = await getSettlementRate(
          newBundle.settlementTier,
          newBundle.settlementNights,
          departYmd,
        );
        if (!rate) {
          throw new BadRequestError('该出发日期在目标档次下的结算价未维护，请联系运营');
        }
        // 日历价是「基础随机套餐」的每人同业价，加项按报价口径叠加其上（与录单 resolveBundleSettlementCalendarTotal
        // 完全同一公式）。指定酒店加价已随改档清除，故此处加项净额只有 addOn.total。
        let calendarTotal = round2(
          rate.pricePerPersonCny * occupancy.headCount + priced.settlementAddOnCny,
        );
        const discountHit = await resolveAgentSettlementDiscount(
          locked.agentId,
          newBundle.settlementTier,
          newBundle.settlementNights,
          departYmd,
        );
        if (discountHit) {
          calendarTotal = round2(
            calendarTotal - discountHit.discountPerPersonCny * occupancy.headCount,
          );
        }
        if (calendarTotal <= 0) {
          throw new BadRequestError('按目标档次取价后的结算价异常（≤0），请检查结算价日历与立减规则');
        }
        // 日历通道是**绝对**口径：日历价就是「本单最终收多少钱」（与录单的结算价收敛完全同源），
        // 因此天然与改档次数无关，重复改档不会叠加差额。
        pricingSource = 'SETTLEMENT_CALENDAR';
        newTotalCny = calendarTotal;
      }

      const diffCny = round2(newTotalCny - lockedTotalCny);
      if (Math.abs(diffCny) > PRICE_ADJUSTMENT_CAP_CNY) {
        throw new BadRequestError(
          `改档差额 ¥${Math.abs(diffCny)} 超出调价上限（±¥${PRICE_ADJUSTMENT_CAP_CNY}），请复核目标套餐与结算价`,
        );
      }

      // 人工复核提示（不阻断，随响应回给运营）。
      const warnings: string[] = [];
      if (rowMetadata.designatedHotel) {
        warnings.push('原「指定酒店」及其加价已随本次改档清除，请按新档次重新指定酒店');
      }
      if ((businessSplit.outbound ?? 0) > 0 || (businessSplit.return ?? 0) > 0) {
        warnings.push('本单含升舱，升舱行与占座一律未改动，请人工复核升舱差价是否仍适用新档次');
      }
      if (!priced.hotelStamp && newBundle.hotelRoomTypeId) {
        warnings.push('未能推导出新的住宿区间（缺出发日期），住宿日期未盖章，请人工补录');
      }

      // ── 1a. 房量闸（与录单同款，事务内带行锁）──────────────────────────────
      // 改档会把套餐行的占房整体换成新档的房型/区间/间数 —— 那是一笔真真切切的新增占房，
      // 此前一道闸都没有：新档满房照样落库，销控板直接变负。
      // 判定口径 = 「先释放本单现有占房，再把改档后的整单占房加回去」：
      //   · excludeOrderId 排除本单在库的旧占房；
      //   · prospective 里既有换绑后的套餐行，也有本单其余占房行（被 exclude 排掉了，必须补回来），
      //     否则等于把自己已占的房当成空房，会放行超卖。
      // 两道闸互补：真酒店走物理房间闸，未落位随机档走同星级聚合闸，各自跳过不归自己管的行。
      // 补回来的那几行都是未落位行（真酒店行早被上面的已落位闸拒在门外），按床位口径合计，
      // 与它们留在库里被算作存量占房时的口径一致。
      const prospectiveStays: ProspectiveHotelStay[] = [
        {
          hotelRoomTypeId: priced.hotelStamp?.hotelRoomTypeId ?? null,
          hotelCheckIn: priced.hotelStamp?.hotelCheckIn ?? null,
          hotelCheckOut: priced.hotelStamp?.hotelCheckOut ?? null,
          roomsBilled: priced.rooms,
        },
        ...locked.items
          .filter((it) => it.id !== bundleRow.id)
          .map((it) => ({
            hotelRoomTypeId: it.hotelRoomTypeId,
            hotelCheckIn: it.hotelCheckIn,
            hotelCheckOut: it.hotelCheckOut,
            roomsBilled: it.roomsBilled == null ? null : Number(it.roomsBilled.toString()),
            randomStarTier: it.randomStarTier,
          })),
      ];
      const orderPassengers = await tx.passenger.findMany({
        where: { orderId },
        select: { gender: true },
      });
      const passengerGenders = orderPassengers.map((p) => ({ gender: p.gender ?? undefined }));
      // 后台端点 → 用默认的带数字文案（运营要看得见差多少间），不套对外中性话术。
      await assertHotelStaysFitWithinTx(tx, prospectiveStays, passengerGenders, {
        excludeOrderId: orderId,
      });
      await assertRandomTierStaysFitWithinTx(tx, prospectiveStays, { excludeOrderId: orderId });

      // 1b. 套餐行换绑（金额冻结；只改「买的是哪张套餐」与随档次派生的住宿字段）。
      //     指定酒店留痕从 metadata 里摘掉 —— 那是旧档次下的选择，新档要重新指定。
      const {
        designatedHotel: _clearedDesignatedHotel,
        ...metadataWithoutDesignated
      } = rowMetadata as Record<string, unknown> & { designatedHotel?: unknown };
      await tx.orderItem.update({
        where: { id: bundleRow.id },
        data: {
          bundleId: newBundle.id,
          description: newBundle.name,
          // 未落位随机档：房型跟着新套餐走（新套餐没绑房型 → 清空，等房控落位）。
          hotelRoomTypeId: priced.hotelStamp?.hotelRoomTypeId ?? null,
          hotelCheckIn: priced.hotelStamp?.hotelCheckIn ?? null,
          hotelCheckOut: priced.hotelStamp?.hotelCheckOut ?? null,
          // 房控是派生账：新档的容量/晚数变了，占房必须跟着变，否则销控板与真账分叉。
          roomsBilled: new Prisma.Decimal(priced.rooms),
          metadata: {
            ...metadataWithoutDesignated,
            roomsNeeded: priced.rooms,
            addOns: priced.addOn.breakdown,
            // 改档留痕（旧档 → 新档、取价来源、差额、原因）：这一行为什么现在长这样，看它就够了。
            bundleChange: {
              fromBundleId,
              fromBundleName: oldBundle?.name ?? null,
              fromSettlementTier: oldBundle?.settlementTier ?? null,
              fromSettlementNights: oldBundle?.settlementNights ?? null,
              toBundleId: newBundle.id,
              toBundleName: newBundle.name,
              toSettlementTier: newBundle.settlementTier ?? null,
              toSettlementNights: newBundle.settlementNights ?? null,
              pricingSource,
              diffCny,
              reasonText: note,
              at: new Date().toISOString(),
              by: actor.userId,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // 1c. 差额行（正=补收 FEE、负=优惠 DISCOUNT）。差额为 0 时不建行（改档本身仍留审计）。
      let diffItemId: string | null = null;
      if (diffCny !== 0) {
        const signed = `${diffCny > 0 ? '+' : '−'}¥${Math.abs(diffCny)}`;
        const created = await tx.orderItem.create({
          data: {
            orderId,
            kind: diffCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
            description:
              `套餐改档差额：${oldBundle?.name ?? '原套餐'} → ${newBundle.name}（${signed}）` +
              (note ? `：${note}` : ''),
            quantity: 1,
            unitPrice: new Prisma.Decimal(diffCny),
            amount: new Prisma.Decimal(diffCny),
            // 纯价格调整行无采购成本 → 显式落 0（口径同 buildPriceAdjustmentItem），不留 NULL 污染毛利。
            totalCostCny: new Prisma.Decimal(0),
            metadata: {
              // priceAdjustment 标：让「按乘客/整单调整明细」等既有展示口径认得这一行。
              priceAdjustment: true,
              // bundleChange: true 是**差额行的身份标**：下一次改档要靠它把历次差额加回基线。
              bundleChange: true,
              reasonCode: 'SETTLEMENT',
              reasonText: note,
              fromBundleId,
              toBundleId: newBundle.id,
              pricingSource,
            } as Prisma.InputJsonValue,
          },
        });
        diffItemId = created.id;
      }

      // 1d. 总额收敛：subtotal/total = Σ 所有行金额（含刚换绑的套餐行与差额行）。
      //     已收款一分不动 —— 尾款/多收由「应付 − 已收」自然浮动。
      const sumAfter = await tx.orderItem.aggregate({
        where: { orderId },
        _sum: { amount: true },
      });
      const newSubtotal = round2(Number(sumAfter._sum.amount?.toString() ?? '0'));
      const log = appendAdjustment(locked.adjustments, {
        type: 'BUNDLE_CHANGE',
        label: `套餐改档：${oldBundle?.name ?? '原套餐'} → ${newBundle.name}`,
        amountCny: diffCny,
        at: new Date().toISOString(),
        by: actor.userId,
        reasonCode: 'SETTLEMENT',
        ...(note ? { note } : {}),
      });
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newSubtotal),
          adjustments: log,
        },
      });

      // 1e. 签证任务对齐：含签证套餐 ↔ 不含签证套餐互改后，任务必须跟着增撤。
      //     任务是需求的派生物 —— 不同步的话，要么签证台上挂着一条永远办不掉的「待处理」，
      //     要么整单漏掉本该办的签证。放在换绑之后调用，它读到的就是新档。
      const visaSync = await syncVisaTasksForOrder(tx, orderId, {
        userId: actor.userId,
        role: actor.role,
      });
      if (visaSync.cancelledTaskIds.length > 0) {
        warnings.push('新档次不涉及签证，本单原「待处理」签证任务已自动撤销');
      }
      if (visaSync.createdTaskIds.length > 0) {
        warnings.push('新档次含签证，已自动补建一条「待处理」签证任务');
      }

      return {
        orderNumber: locked.orderNumber,
        beforeTotal: locked.total.toString(),
        afterTotal: newSubtotal.toString(),
        diffCny,
        diffItemId,
        pricingSource,
        warnings,
      };
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });

    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit: {
        orderNumber: scratch.orderNumber,
        orderItemId: previewPick.row.id,
        before: {
          bundleId: previewPick.bundleId,
          bundleName: oldBundle?.name ?? null,
          settlementTier: oldBundle?.settlementTier ?? null,
          settlementNights: oldBundle?.settlementNights ?? null,
          total: scratch.beforeTotal,
        },
        after: {
          bundleId: newBundle.id,
          bundleName: newBundle.name,
          settlementTier: newBundle.settlementTier ?? null,
          settlementNights: newBundle.settlementNights ?? null,
          total: scratch.afterTotal,
        },
        diffCny: scratch.diffCny,
        diffItemId: scratch.diffItemId,
        pricingSource: scratch.pricingSource,
        note,
        warnings: scratch.warnings,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // 拆单 v1（split PNR 售后逃生门）：把选中乘客从源订单拆出成新订单。
  //
  // 顶层哲学（改本区代码前先读三遍）：
  //   1. 拆单是搬钱不是算钱：unitPrice 全冻结，只动 quantity 与显式差额行 ——
  //      任何「重新定价」都不属于拆单；
  //   2. 绝不动库存：座位 sold 一分不动（拆前拆后逐班次舱位 Σquantity 恒等，
  //      两单加起来占的还是同一批座位）；
  //   3. fail-closed：任何守恒断言（total / paidAmount / 座位数量）不平即抛错，
  //      整个事务回滚，宁可拆不成也不能拆出一笔对不上的账。
  // ════════════════════════════════════════════════════════════════════

  /**
   * 拆单准入闸 + 每人份额评估（preview 与 execute 共用同一口径，避免预检放行、执行另算）。
   * 只读不写；blockers 为空 = 可拆。
   */
  private async assessOrderSplit(
    db: Prisma.TransactionClient,
    order: SplitSourceOrder,
    passengerIds: string[],
  ): Promise<SplitAssessment> {
    const blockers: string[] = [];

    // ── 闸 1-3：存活 / 占座中 / 资金处置闸（前两条通过才跑处置闸，避免同因重复报）──
    if (order.deletedAt) {
      blockers.push('订单已在回收站，不能拆单。请先恢复订单。');
    } else if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      blockers.push(`订单当前状态（${zhStatus(order.status)}）不可拆单：仅占座中的有效订单可拆。`);
    } else {
      try {
        assertOrderAllowsFundsDisposal(order, '拆单');
      } catch (err) {
        blockers.push(err instanceof Error ? err.message : '订单当前状态不允许拆单。');
      }
    }

    // ── 闸 4-5：结算价锁 / 收款复核锁 ──
    if (order.settlementLocked) {
      blockers.push('该订单结算价已锁定，拆单会改动两侧应收。请先解锁结算价再拆单。');
    }
    if (order.paymentsLocked) {
      blockers.push('该订单收款已复核锁定，拆单会转移已收款。请先解锁收款再拆单。');
    }

    // ── 闸 6：开票闸（与改结算价同因：发票金额与订单金额不能脱钩）──
    if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
      blockers.push(
        '该订单已有开票记录（去程/回程/系统任一已开），拆单会使发票与订单金额不一致。' +
          '请先在票务台把对应开票状态改回「未开」，拆单后再重新开票。',
      );
    }

    // ── 闸 7：已计提/已结算佣金（含结算申请中——佣金还挂在本单金额上，拆了两本账对不上）──
    const commissionAgg = await db.commissionRecord.aggregate({
      where: {
        orderId: order.id,
        status: {
          in: [
            CommissionStatus.ACCRUED,
            CommissionStatus.SETTLEMENT_REQUESTED,
            CommissionStatus.SETTLED,
          ],
        },
      },
      _sum: { amount: true },
    });
    const commissionCny = round2(Number(commissionAgg._sum.amount ?? 0));
    if (commissionCny !== 0) {
      blockers.push(
        `该订单已计提佣金 ¥${commissionCny}，拆单会使佣金与订单金额脱钩。请先由财务冲销/处理佣金再拆单。`,
      );
    }

    // ── 闸 8：进行中的退款 ──
    const inflightRefunds = await db.refund.count({
      where: {
        orderId: order.id,
        status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING] },
      },
    });
    if (inflightRefunds > 0) {
      blockers.push('该订单有进行中的退款，请先完成或驳回退款流程再拆单。');
    }

    // ── 闸 9：售后费用未结清（adjustmentCny 是整单口径，拆开就分不清谁欠的）──
    if (order.adjustmentCny !== 0) {
      blockers.push(
        `该订单有售后费用 ¥${order.adjustmentCny}（改期费/换人费等），请先结清或冲销售后费用再拆单。`,
      );
    }

    // ── 闸 10：套餐单不支持 ──
    if (order.items.some((it) => it.kind === OrderItemKind.BUNDLE)) {
      blockers.push('套餐订单暂不支持拆单：请改用按人办签证 / 拆房组等既有售后操作。');
    }

    // ── 闸 11：升舱行（拆散升舱镜像会让退座还错舱位）──
    const hasUpgrade = order.items.some((it) => {
      if (it.kind !== OrderItemKind.FLIGHT) return false;
      const md = readJsonObject(it.metadata);
      const n = Number(md.businessUpgradeCount ?? 0);
      return Number.isFinite(n) && n > 0;
    });
    if (hasUpgrade) {
      blockers.push('订单含升舱商务的机票行，请先撤销升舱再拆单。');
    }

    // ── 闸 12：已出票（确认出票任务 / 任一乘客有 PNR 或票号）→ 走改签，不走拆单 ──
    const confirmedTicketing = await db.fulfillmentTask.count({
      where: {
        orderItem: { orderId: order.id },
        type: FulfillmentType.FLIGHT_TICKETING,
        status: FulfillmentStatus.CONFIRMED,
      },
    });
    const ticketedPax = order.passengers.some(
      (p) => (p.pnr && p.pnr.trim() !== '') || (p.eticketNumber && p.eticketNumber.trim() !== ''),
    );
    if (confirmedTicketing > 0 || ticketedPax) {
      blockers.push('订单已有确认出票记录（或乘客已有 PNR/票号）。已出票请走改签流程，不能拆单。');
    }

    // ── 闸 13：已结清单 v1 拒绝 ──
    const preTotalCny = round2(Number(order.total));
    const prePaidCny = round2(Number(order.paidAmount));
    if (prePaidCny >= round2(preTotalCny + order.adjustmentCny)) {
      blockers.push('该订单已结清（已收 ≥ 应收），拆单 v1 暂不支持已结清订单。');
    }

    // ── 闸 14：拆出人数 1 ≤ k < 全员，且全部属于本单 ──
    const allPaxIds = order.passengers.map((p) => p.id);
    const allPaxIdSet = new Set(allPaxIds);
    const movedIdSet = new Set(passengerIds);
    if (movedIdSet.size !== passengerIds.length) {
      blockers.push('拆出乘客列表中有重复项，请刷新后重试。');
    }
    const unknownIds = passengerIds.filter((id) => !allPaxIdSet.has(id));
    if (unknownIds.length > 0) {
      blockers.push('所选乘客不属于本订单（可能已被换人/拆走），请刷新后重试。');
    }
    if (unknownIds.length === 0 && movedIdSet.size >= allPaxIds.length) {
      blockers.push('拆出乘客数需少于全员：至少留 1 位乘客在原订单（整单转移请走改归属/改备注）。');
    }

    // ── 闸 15：同房组闸（一个房间不能一半在这单一半在那单）──
    const roomGroups = readRoomGroups(order.roomAssignment);
    for (const group of roomGroups) {
      const groupPax = group.passengerIds;
      if (groupPax.length === 0) continue;
      const movedInGroup = groupPax.filter((id) => movedIdSet.has(id));
      if (movedInGroup.length > 0 && movedInGroup.length < groupPax.length) {
        const label = group.label ?? '未命名房组';
        blockers.push(
          `房组「${label}」同时包含拆出与留下的乘客，请先在分房里把他们分到不同房组再拆单。`,
        );
      }
    }

    // ── 每人份额（权威口径：per-pax-share 端口 + groupPassengerAdjustments 净额）──
    const { byPassenger } = groupPassengerAdjustments(
      order.items.map((it) => ({
        id: it.id,
        amount: Number(it.amount),
        description: it.description,
        passengerId: it.passengerId,
        metadata: it.metadata,
      })),
    );
    const netByPassenger = new Map<string, number>(
      Object.entries(byPassenger).map(([pid, bucket]) => [pid, bucket.netCny]),
    );
    const shareResult = computePerPaxShares({
      totalCny: preTotalCny,
      adjustmentCny: order.adjustmentCny,
      passengerIds: allPaxIds,
      netByPassenger,
    });
    const shareByPax = new Map(shareResult.rows.map((r) => [r.passengerId, r.shareCny]));
    const paxNameById = new Map(
      order.passengers.map((p) => [p.id, p.chineseName?.trim() || p.fullName]),
    );

    // movedShare 用分累加（份额本身逐分精确，round2 只防浮点尾数）。
    const movedShareCny = round2(
      passengerIds.reduce((sum, pid) => sum + (shareByPax.get(pid) ?? 0), 0),
    );
    // movedPaid = min(movedShare, 已收 − 已完成退款)，不为负 —— 只搬真的还在账上的钱。
    const completedRefundsCny = await sumCompletedRefundsWithinTx(db, order.id);
    const movedPaidCny = Math.max(
      0,
      Math.min(movedShareCny, round2(prePaidCny - completedRefundsCny)),
    );

    return {
      blockers,
      shares: passengerIds
        .filter((pid) => allPaxIdSet.has(pid))
        .map((pid) => ({
          passengerId: pid,
          fullName: paxNameById.get(pid) ?? pid,
          shareCny: shareByPax.get(pid) ?? 0,
        })),
      allShareRows: shareResult.rows,
      movedShareCny,
      movedPaidCny,
      preTotalCny,
      prePaidCny,
      hotelItems: order.items
        .filter((it) => it.kind === OrderItemKind.HOTEL)
        .map((it) => ({
          itemId: it.id,
          description: it.description,
          roomsBilled: it.roomsBilled != null ? Number(it.roomsBilled) : null,
        })),
      movedIdSet,
    };
  }

  /**
   * 拆单预检（只读）：POST /orders/:id/split-preview。
   * 跑全部准入闸 + 份额计算，一次性返回全部不满足的闸（blockers），供运营在弹窗里逐条看。
   */
  async previewOrderSplit(
    orderId: string,
    body: { passengerIds: string[] },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    eligible: boolean;
    blockers: string[];
    shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
    movedShareCny: number;
    movedPaidCny: number;
    hotelItems: Array<{ itemId: string; description: string; roomsBilled: number | null }>;
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可拆单');
    }
    const order = await loadOrderForSplit(prisma, orderId);
    if (!order) throw new NotFoundError('订单不存在');
    const assessment = await this.assessOrderSplit(prisma, order, body.passengerIds);
    return {
      eligible: assessment.blockers.length === 0,
      blockers: assessment.blockers,
      shares: assessment.shares,
      movedShareCny: assessment.movedShareCny,
      movedPaidCny: assessment.movedPaidCny,
      hotelItems: assessment.hotelItems,
    };
  }

  /**
   * 执行拆单：POST /orders/:id/split。
   *
   * 事务内流程：锁源单（FOR UPDATE）→ 幂等回放检查 → 重跑准入闸 → 建新单（不定价不扣座）
   * → 按行搬/拆（FLIGHT/VISA/TRANSFER 按人数、HOTEL 按显式 roomSplit、按人调整行跟人走）
   * → 物理移乘客 → 两侧各一条 SPLIT 平账行 → 搬已收款（承接 Payment）→ 履约任务/回程列同步
   * → 守恒断言（total / paidAmount / 逐班次舱位 Σquantity）→ OrderSplitRecord 落库。
   * 幂等：同 (sourceOrderId, requestToken) 重试只回放既有结果，绝不二次拆。
   */
  async splitOrder(
    orderId: string,
    input: {
      passengerIds: string[];
      roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
      note?: string;
      requestToken: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<SplitOrderResult> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可拆单');
    }

    // 幂等快路径：同 (源单, token) 已拆过 → 直接回放，不进事务。
    const replay = await this.findSplitReplay(orderId, input.requestToken);
    if (replay) return replay;

    // 订单号撞号（P2002）重试环 ≤3 次：Postgres 里语句失败会废掉整个事务，
    // 所以重试必须在事务外整体重来（每轮换一个新订单号），不能在事务内捕获后继续。
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const targetOrderNumber = await generateOrderNumber();
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          return this.executeSplitWithinTx(tx, orderId, input, actor, targetOrderNumber);
        });
        if (outcome.kind === 'replayed') return outcome.result;

        // 审计（事务外，与全站 writeAudit 口径一致）：两条 SPLIT_ORDER，各挂一侧订单。
        const auditBefore = {
          total: outcome.preTotalCny,
          paidAmount: outcome.prePaidCny,
          passengers: outcome.passengerSummary,
          perPaxRows: outcome.allShareRows,
        };
        const auditAfter = {
          sourceOrderNumber: outcome.result.sourceOrderNumber,
          targetOrderNumber: outcome.result.targetOrderNumber,
          sourceTotal: outcome.sourceTotalAfterCny,
          targetTotal: outcome.result.movedShareCny,
          sourcePaid: outcome.sourcePaidAfterCny,
          targetPaid: outcome.result.movedPaidCny,
          movedPassengerIds: input.passengerIds,
          note: input.note ?? null,
        };
        await writeAudit({
          actor: { userId: actor.userId, role: actor.role },
          action: 'SPLIT_ORDER',
          targetType: AuditTargetType.ORDER,
          targetId: outcome.result.sourceOrderId,
          targetLabel: outcome.result.sourceOrderNumber,
          before: auditBefore,
          after: auditAfter,
          severity: AuditSeverity.CRITICAL,
        });
        await writeAudit({
          actor: { userId: actor.userId, role: actor.role },
          action: 'SPLIT_ORDER',
          targetType: AuditTargetType.ORDER,
          targetId: outcome.result.targetOrderId,
          targetLabel: outcome.result.targetOrderNumber,
          before: auditBefore,
          after: auditAfter,
          severity: AuditSeverity.CRITICAL,
        });
        return outcome.result;
      } catch (err) {
        if (isUniqueViolation(err, 'orderNumber')) {
          lastError = err;
          continue; // 订单号撞号：换号重来
        }
        if (isUniqueViolation(err, 'requestToken') || isUniqueViolation(err, 'sourceOrderId')) {
          // 并发同 token 双击：另一请求已拆完 → 回放
          const raced = await this.findSplitReplay(orderId, input.requestToken);
          if (raced) return raced;
        }
        throw err;
      }
    }
    throw lastError ?? new ConflictError('订单号生成连续撞号，请稍后重试');
  }

  /** 幂等回放：查 (sourceOrderId, requestToken) 既有拆单流水，命中则还原响应。 */
  private async findSplitReplay(
    orderId: string,
    requestToken: string,
  ): Promise<SplitOrderResult | null> {
    const prior = await prisma.orderSplitRecord.findUnique({
      where: { sourceOrderId_requestToken: { sourceOrderId: orderId, requestToken } },
      include: {
        sourceOrder: { select: { orderNumber: true } },
        targetOrder: { select: { orderNumber: true } },
      },
    });
    if (!prior) return null;
    return {
      sourceOrderId: prior.sourceOrderId,
      sourceOrderNumber: prior.sourceOrder.orderNumber,
      targetOrderId: prior.targetOrderId,
      targetOrderNumber: prior.targetOrder.orderNumber,
      movedShareCny: round2(Number(prior.movedShareCny)),
      movedPaidCny: round2(Number(prior.movedPaidCny)),
      passengerCount: prior.passengerCount,
      replayed: true,
    };
  }

  /** 拆单事务内核（只在 splitOrder 的 $transaction 里调用）。 */
  private async executeSplitWithinTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    input: {
      passengerIds: string[];
      roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
      note?: string;
      requestToken: string;
    },
    actor: { userId: string; role: UserRole },
    targetOrderNumber: string,
  ): Promise<
    | { kind: 'replayed'; result: SplitOrderResult }
    | {
        kind: 'done';
        result: SplitOrderResult;
        preTotalCny: number;
        prePaidCny: number;
        sourceTotalAfterCny: number;
        sourcePaidAfterCny: number;
        allShareRows: Array<{ passengerId: string; netCny: number; shareCny: number }>;
        passengerSummary: Array<{ id: string; name: string; moved: boolean }>;
      }
  > {
    // ── 0. 锁源单行（与改结算价/认款同一把锁），锁内幂等复查 ──
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('订单不存在');
    const priorInTx = await tx.orderSplitRecord.findUnique({
      where: {
        sourceOrderId_requestToken: { sourceOrderId: orderId, requestToken: input.requestToken },
      },
      include: {
        sourceOrder: { select: { orderNumber: true } },
        targetOrder: { select: { orderNumber: true } },
      },
    });
    if (priorInTx) {
      return {
        kind: 'replayed',
        result: {
          sourceOrderId: priorInTx.sourceOrderId,
          sourceOrderNumber: priorInTx.sourceOrder.orderNumber,
          targetOrderId: priorInTx.targetOrderId,
          targetOrderNumber: priorInTx.targetOrder.orderNumber,
          movedShareCny: round2(Number(priorInTx.movedShareCny)),
          movedPaidCny: round2(Number(priorInTx.movedPaidCny)),
          passengerCount: priorInTx.passengerCount,
          replayed: true,
        },
      };
    }

    // ── 1. 锁后读权威快照 + 重跑全部准入闸（fail-closed：预检放过的这里也要再拦一次）──
    const order = await loadOrderForSplit(tx, orderId);
    if (!order) throw new NotFoundError('订单不存在');
    const assessment = await this.assessOrderSplit(tx, order, input.passengerIds);
    if (assessment.blockers.length > 0) {
      throw new BadRequestError(`当前不能拆单：\n${assessment.blockers.join('\n')}`);
    }
    const movedIdSet = assessment.movedIdSet;
    const k = movedIdSet.size;
    const { movedShareCny, movedPaidCny, preTotalCny, prePaidCny } = assessment;

    // ── 2. roomSplit 显式校验（0.5 网格由 schema 保证；这里校验行归属与上限）──
    const roomSplitByItem = new Map<string, number>();
    for (const entry of input.roomSplit ?? []) {
      if (roomSplitByItem.has(entry.itemId)) {
        throw new BadRequestError('roomSplit 中同一酒店行出现多次，请合并为一条');
      }
      const item = order.items.find((it) => it.id === entry.itemId);
      if (!item || item.kind !== OrderItemKind.HOTEL) {
        throw new BadRequestError('roomSplit 指向的订单行不存在或不是酒店行，请刷新后重试');
      }
      const srcRooms = item.roomsBilled != null ? Number(item.roomsBilled) : null;
      if (srcRooms == null || srcRooms <= 0) {
        throw new BadRequestError(
          `酒店行「${item.description}」未记录计费房数（roomsBilled），请先保存分房表再拆分`,
        );
      }
      if (entry.roomsBilledToMove > srcRooms) {
        throw new BadRequestError(
          `酒店行「${item.description}」随拆搬走的间数（${entry.roomsBilledToMove}）超过该行计费房数（${srcRooms}）`,
        );
      }
      roomSplitByItem.set(entry.itemId, entry.roomsBilledToMove);
    }

    // ── 3. 建新单：抄转正建单的事务内建单法，但**不重新定价不扣座**（行是搬/拆来的）──
    const nowIso = new Date().toISOString();
    const target = await tx.order.create({
      data: {
        orderNumber: targetOrderNumber,
        userId: order.userId,
        agentId: order.agentId,
        guestName: order.guestName,
        guestPhone: order.guestPhone,
        guestEmail: order.guestEmail,
        status: order.status,
        currency: order.currency,
        // 占位金额：行搬完后统一按 movedShare 收敛（见步骤 7）。
        subtotal: new Prisma.Decimal(0),
        total: new Prisma.Decimal(0),
        contactName: order.contactName,
        contactPhone: order.contactPhone,
        contactEmail: order.contactEmail,
        visaStatus: order.visaStatus,
        claimedById: order.claimedById,
        claimedAt: order.claimedAt,
        notes: [`由订单 ${order.orderNumber} 拆分创建`, order.notes?.trim() || null]
          .filter(Boolean)
          .join(' · '),
        noteHotel: order.noteHotel,
        noteVisa: order.noteVisa,
        notePayment: order.notePayment,
        noteSpecial: order.noteSpecial,
        expectedAmountCny: null,
        idempotencyKey: null,
        statusEvents: {
          create: {
            fromStatus: null,
            toStatus: order.status,
            actorUserId: actor.userId,
            reason: `由订单 ${order.orderNumber} 拆分创建（拆出 ${k} 人）`,
          },
        },
      },
      select: { id: true, orderNumber: true },
    });

    // ── 4. 按行搬/拆（unitPrice 全冻结）──
    // 拆前逐班次舱位数量账（守恒断言基准）。
    const preFlightQty = sumFlightQuantities(
      order.items.map((it) => ({
        kind: it.kind,
        flightScheduleId: it.flightScheduleId,
        flightCabin: it.flightCabin,
        quantity: it.quantity,
      })),
    );
    const fullyMovedItemIds = new Set<string>();
    const splitItemIdMap = new Map<string, string>(); // 源行 id → 新单对应行 id（拆分行）
    for (const item of order.items) {
      const md = readJsonObject(item.metadata);
      // 按人调整行跟人走；整单调整行（passengerId=null）全留源单。
      if (md.priceAdjustment === true) {
        if (item.passengerId && movedIdSet.has(item.passengerId)) {
          await tx.orderItem.update({ where: { id: item.id }, data: { orderId: target.id } });
          fullyMovedItemIds.add(item.id);
        }
        continue;
      }
      if (
        item.kind === OrderItemKind.FLIGHT ||
        item.kind === OrderItemKind.VISA ||
        item.kind === OrderItemKind.TRANSFER
      ) {
        // quantity 是人数：拆出 min(quantity, k) 件。quantity ≤ k → 整行搬走。
        const moveQty = Math.min(item.quantity, k);
        if (moveQty <= 0) continue;
        if (moveQty >= item.quantity) {
          await tx.orderItem.update({ where: { id: item.id }, data: { orderId: target.id } });
          fullyMovedItemIds.add(item.id);
          continue;
        }
        const keepQty = item.quantity - moveQty;
        const unitPrice = Number(item.unitPrice);
        const srcCost = item.totalCostCny != null ? Number(item.totalCostCny) : null;
        const movedCost = srcCost == null ? null : round2((srcCost * moveQty) / item.quantity);
        const keptCost = srcCost == null || movedCost == null ? null : round2(srcCost - movedCost);
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            quantity: keepQty,
            amount: new Prisma.Decimal(round2(unitPrice * keepQty)),
            totalCostCny: keptCost == null ? null : new Prisma.Decimal(keptCost),
          },
        });
        const createdRow = await tx.orderItem.create({
          data: {
            orderId: target.id,
            kind: item.kind,
            description: item.description,
            quantity: moveQty,
            unitPrice: item.unitPrice,
            amount: new Prisma.Decimal(round2(unitPrice * moveQty)),
            unitCostCny: item.unitCostCny,
            totalCostCny: movedCost == null ? null : new Prisma.Decimal(movedCost),
            flightScheduleId: item.flightScheduleId,
            flightCabin: item.flightCabin,
            transferId: item.transferId,
            visaId: item.visaId,
            visaIntendedDate: item.visaIntendedDate,
            metadata: { ...md, splitFromItemId: item.id } as Prisma.InputJsonValue,
            idempotencyKey: null,
          },
          select: { id: true },
        });
        splitItemIdMap.set(item.id, createdRow.id);
        continue;
      }
      if (item.kind === OrderItemKind.HOTEL) {
        // 只按显式 roomSplit 拆；无 roomSplit → 酒店行全留源单。
        const moveRooms = roomSplitByItem.get(item.id);
        if (moveRooms == null) continue;
        const srcRooms = Number(item.roomsBilled); // 步骤 2 已保证非空 > 0
        const srcHalf = Math.round(srcRooms * 2);
        const moveHalf = Math.round(moveRooms * 2);
        if (moveHalf >= srcHalf) {
          await tx.orderItem.update({ where: { id: item.id }, data: { orderId: target.id } });
          fullyMovedItemIds.add(item.id);
          continue;
        }
        const srcAmount = Number(item.amount);
        const movedAmount = round2((srcAmount * moveHalf) / srcHalf);
        const srcCost = item.totalCostCny != null ? Number(item.totalCostCny) : null;
        const movedCost = srcCost == null ? null : round2((srcCost * moveHalf) / srcHalf);
        const keptCost = srcCost == null || movedCost == null ? null : round2(srcCost - movedCost);
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            roomsBilled: new Prisma.Decimal((srcHalf - moveHalf) / 2),
            amount: new Prisma.Decimal(round2(srcAmount - movedAmount)),
            totalCostCny: keptCost == null ? null : new Prisma.Decimal(keptCost),
          },
        });
        const createdRow = await tx.orderItem.create({
          data: {
            orderId: target.id,
            kind: OrderItemKind.HOTEL,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            amount: new Prisma.Decimal(movedAmount),
            unitCostCny: item.unitCostCny,
            totalCostCny: movedCost == null ? null : new Prisma.Decimal(movedCost),
            hotelRoomTypeId: item.hotelRoomTypeId,
            randomStarTier: item.randomStarTier,
            hotelCheckIn: item.hotelCheckIn,
            hotelCheckOut: item.hotelCheckOut,
            roomsBilled: new Prisma.Decimal(moveHalf / 2),
            metadata: { ...md, splitFromItemId: item.id } as Prisma.InputJsonValue,
            idempotencyKey: null,
          },
          select: { id: true },
        });
        splitItemIdMap.set(item.id, createdRow.id);
        continue;
      }
      // 其余行（FEE/DISCOUNT 非调整行等）全留源单：份额差由 SPLIT 平账行收敛。
    }

    // ── 5. 物理移乘客（保 id，护照图/送签进度全跟走）──
    const movedPax = await tx.passenger.updateMany({
      where: { id: { in: [...movedIdSet] }, orderId },
      data: { orderId: target.id },
    });
    if (movedPax.count !== k) {
      throw new Error(`拆单守恒断言失败：应移 ${k} 位乘客，实际移动 ${movedPax.count} 位（已回滚）`);
    }

    // ── 6. 分房表：拆出乘客所在房组整组搬到新单（同房组闸已保证组内全员同侧）──
    const rawRoomAssignment = order.roomAssignment;
    const roomGroups = readRoomGroups(rawRoomAssignment);
    let sourceRoomAssignmentUpdate: Prisma.InputJsonValue | undefined;
    let targetRoomAssignment: Prisma.InputJsonValue | undefined;
    if (roomGroups.length > 0) {
      const movedGroups: Record<string, unknown>[] = [];
      const keptGroups: Record<string, unknown>[] = [];
      for (const group of roomGroups) {
        const isMoved =
          group.passengerIds.length > 0 && group.passengerIds.every((id) => movedIdSet.has(id));
        if (!isMoved) {
          keptGroups.push(group.raw);
          continue;
        }
        // 房组归属行重定位：整行搬走 → 保留；被拆 → 指到新单对应行；指向留守行 → 搬不干净，400。
        const attributedTo =
          typeof group.raw.orderItemId === 'string' && group.raw.orderItemId.length > 0
            ? group.raw.orderItemId
            : null;
        if (attributedTo == null || fullyMovedItemIds.has(attributedTo)) {
          movedGroups.push(group.raw);
        } else if (splitItemIdMap.has(attributedTo)) {
          movedGroups.push({ ...group.raw, orderItemId: splitItemIdMap.get(attributedTo) });
        } else {
          throw new BadRequestError(
            `房组「${group.label ?? '未命名房组'}」挂在留在原订单的酒店行上。` +
              '请在 roomSplit 里把该行的对应间数一并拆走，或先在分房里调整房组归属。',
          );
        }
      }
      if (movedGroups.length > 0) {
        const base = readJsonObject(rawRoomAssignment);
        sourceRoomAssignmentUpdate = { ...base, roomGroups: keptGroups } as Prisma.InputJsonValue;
        targetRoomAssignment = { roomGroups: movedGroups } as Prisma.InputJsonValue;
      }
    }

    // ── 7. 平账行：两边各一条 SPLIT 差额行，把两侧 total 收敛到份额口径 ──
    //   新单 total == movedShare；源单 total == 拆前 total − movedShare。
    //   正 → FEE、负 → DISCOUNT（与 buildSettlementTotalItem 同口径）；差额为 0 不生成行。
    const targetAgg = await tx.orderItem.aggregate({
      where: { orderId: target.id },
      _sum: { amount: true },
    });
    const targetItemsSum = round2(Number(targetAgg._sum.amount ?? 0));
    await createSplitBalanceItem(tx, {
      orderId: target.id,
      diffCny: round2(movedShareCny - targetItemsSum),
      itemsSumCny: targetItemsSum,
      shareCny: movedShareCny,
      splitFrom: order.orderNumber,
      splitTo: target.orderNumber,
    });
    const sourceTotalAfterCny = round2(preTotalCny - movedShareCny);
    const sourceAgg = await tx.orderItem.aggregate({
      where: { orderId },
      _sum: { amount: true },
    });
    const sourceItemsSum = round2(Number(sourceAgg._sum.amount ?? 0));
    await createSplitBalanceItem(tx, {
      orderId,
      diffCny: round2(sourceTotalAfterCny - sourceItemsSum),
      itemsSumCny: sourceItemsSum,
      shareCny: sourceTotalAfterCny,
      splitFrom: order.orderNumber,
      splitTo: target.orderNumber,
    });

    // ── 8. 钱：两侧金额收口 + SPLIT_OUT/SPLIT_IN 流水（仅记录，不动 adjustmentCny）──
    const sourcePaidAfterCny = round2(prePaidCny - movedPaidCny);
    const sourceLog = appendAdjustment(order.adjustments, {
      type: 'SPLIT_OUT',
      label: `拆单：拆出 ${k} 人至订单 ${target.orderNumber}`,
      amountCny: -movedShareCny,
      at: nowIso,
      by: actor.userId,
      note: [`随拆转移已收 ¥${movedPaidCny}`, input.note?.trim() || null]
        .filter(Boolean)
        .join('；'),
    });
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: new Prisma.Decimal(sourceTotalAfterCny),
        total: new Prisma.Decimal(sourceTotalAfterCny),
        paidAmount: new Prisma.Decimal(sourcePaidAfterCny),
        adjustments: sourceLog,
        ...(sourceRoomAssignmentUpdate !== undefined
          ? { roomAssignment: sourceRoomAssignmentUpdate }
          : {}),
        statusEvents: {
          create: {
            fromStatus: order.status,
            toStatus: order.status,
            actorUserId: actor.userId,
            reason: `拆单：拆出 ${k} 人至订单 ${target.orderNumber}`,
          },
        },
      },
    });
    const targetLog = appendAdjustment(null, {
      type: 'SPLIT_IN',
      label: `由订单 ${order.orderNumber} 拆分创建（承接 ${k} 人份额）`,
      amountCny: movedShareCny,
      at: nowIso,
      by: actor.userId,
      note: [`承接已收 ¥${movedPaidCny}`, input.note?.trim() || null].filter(Boolean).join('；'),
    });
    await tx.order.update({
      where: { id: target.id },
      data: {
        subtotal: new Prisma.Decimal(movedShareCny),
        total: new Prisma.Decimal(movedShareCny),
        paidAmount: new Prisma.Decimal(movedPaidCny),
        adjustments: targetLog,
        ...(targetRoomAssignment !== undefined ? { roomAssignment: targetRoomAssignment } : {}),
      },
    });

    // 承接 Payment：movedPaid > 0 才建。核实状态继承来源——源单全部成功收款均已核实才算核实，
    // 钱没被财务对过流水，不因搬到新单就洗白（与占位单结转同哲学）。
    if (movedPaidCny > 0) {
      const sourcePayments = await tx.payment.findMany({
        where: { orderId, status: PaymentStatus.SUCCEEDED },
        select: { verifiedAt: true },
      });
      const allVerified =
        sourcePayments.length > 0 && sourcePayments.every((p) => p.verifiedAt != null);
      await tx.payment.create({
        data: {
          orderId: target.id,
          method: PaymentMethod.BANK_CARD,
          amount: new Prisma.Decimal(movedPaidCny),
          status: PaymentStatus.SUCCEEDED,
          transactionId: null,
          idempotencyKey: `split:${order.id}:${input.requestToken}`,
          paidAt: new Date(),
          verifiedAt: allVerified ? new Date() : null,
          gatewayPayload: {
            splitFrom: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              movedCny: movedPaidCny,
              at: nowIso,
              by: actor.userId,
            },
            manual: false,
          } as Prisma.InputJsonValue,
        },
      });
    }

    // ── 9. 履约：新单建自己的 PENDING 任务（源单任务留在原行，随行归属自然走）──
    const newTaskIds = await createFulfillmentTasks(tx, target.id);
    if (newTaskIds.length > 0) {
      await tx.fulfillmentTask.updateMany({
        where: { id: { in: newTaskIds } },
        data: { notes: `由订单 ${order.orderNumber} 拆分创建` },
      });
    }
    await syncVisaTasksForOrder(tx, target.id, { userId: actor.userId, role: actor.role });
    await syncOrderHasReturnLeg(tx, orderId);
    await syncOrderHasReturnLeg(tx, target.id);

    // ── 10. 新单操作费（与转正建单同口径：每单固定操作费）──
    await tx.orderCostItem.create({
      data: {
        orderId: target.id,
        category: 'OPERATION_FEE',
        amountCny: new Prisma.Decimal(OPERATION_FEE_CNY_PER_ORDER),
        note: '系统自动计提（每单固定操作费）',
      },
    });

    // ── 11. 守恒断言（不平整体回滚；宁可拆不成也不能拆出对不上的账）──
    const [sourceAfter, targetAfter] = await Promise.all([
      tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { total: true, paidAmount: true },
      }),
      tx.order.findUniqueOrThrow({
        where: { id: target.id },
        select: { total: true, paidAmount: true },
      }),
    ]);
    const EPS = 0.005;
    const totalAfter = Number(sourceAfter.total) + Number(targetAfter.total);
    if (Math.abs(totalAfter - preTotalCny) > EPS) {
      throw new Error(
        `拆单守恒断言失败：拆前 total ¥${preTotalCny}，拆后两单合计 ¥${round2(totalAfter)}（已回滚）`,
      );
    }
    const paidAfter = Number(sourceAfter.paidAmount) + Number(targetAfter.paidAmount);
    if (Math.abs(paidAfter - prePaidCny) > EPS) {
      throw new Error(
        `拆单守恒断言失败：拆前 paidAmount ¥${prePaidCny}，拆后两单合计 ¥${round2(paidAfter)}（已回滚）`,
      );
    }
    const flightRowsAfter = await tx.orderItem.findMany({
      where: { orderId: { in: [orderId, target.id] }, kind: OrderItemKind.FLIGHT },
      select: { kind: true, flightScheduleId: true, flightCabin: true, quantity: true },
    });
    const postFlightQty = sumFlightQuantities(flightRowsAfter);
    for (const [key, preQty] of preFlightQty) {
      if ((postFlightQty.get(key) ?? 0) !== preQty) {
        throw new Error(
          `拆单守恒断言失败：班次舱位 ${key} 拆前 ${preQty} 座、拆后 ${postFlightQty.get(key) ?? 0} 座（已回滚）`,
        );
      }
    }
    for (const key of postFlightQty.keys()) {
      if (!preFlightQty.has(key)) {
        throw new Error(`拆单守恒断言失败：拆后凭空出现班次舱位 ${key}（已回滚）`);
      }
    }

    // ── 12. 拆单流水落库（快照存全员份额，事后复算依据）──
    await tx.orderSplitRecord.create({
      data: {
        sourceOrderId: orderId,
        targetOrderId: target.id,
        passengerCount: k,
        movedShareCny: new Prisma.Decimal(movedShareCny),
        movedPaidCny: new Prisma.Decimal(movedPaidCny),
        snapshot: {
          rows: assessment.allShareRows,
          movedPassengerIds: [...movedIdSet],
          preTotalCny,
          prePaidCny,
          movedShareCny,
          movedPaidCny,
          roomSplit: input.roomSplit ?? null,
        } as Prisma.InputJsonValue,
        requestToken: input.requestToken,
        createdById: actor.userId,
      },
    });

    // ── 13. 新单若已被承接款清账（PENDING_PAYMENT 且已收 ≥ 应收）→ 按既有口径推 PAID。
    //   其余状态/未结清不自动推进：拆后各自走既有支付/状态流转。
    await this.advanceOrderToPaidIfClearedWithinTx(
      tx,
      target.id,
      { userId: actor.userId, role: actor.role, actorType: 'USER' },
      newTaskIds,
    );

    return {
      kind: 'done',
      result: {
        sourceOrderId: orderId,
        sourceOrderNumber: order.orderNumber,
        targetOrderId: target.id,
        targetOrderNumber: target.orderNumber,
        movedShareCny,
        movedPaidCny,
        passengerCount: k,
        replayed: false,
      },
      preTotalCny,
      prePaidCny,
      sourceTotalAfterCny,
      sourcePaidAfterCny,
      allShareRows: assessment.allShareRows,
      passengerSummary: order.passengers.map((p) => ({
        id: p.id,
        name: p.chineseName?.trim() || p.fullName,
        moved: movedIdSet.has(p.id),
      })),
    };
  }
}

// ── 拆单 v1 · 模块级辅助（类型 / 加载 / 纯函数）─────────────────────────────

/** 拆单执行/回放的统一响应形状。 */
export interface SplitOrderResult {
  sourceOrderId: string;
  sourceOrderNumber: string;
  targetOrderId: string;
  targetOrderNumber: string;
  movedShareCny: number;
  movedPaidCny: number;
  passengerCount: number;
  /** true = 幂等回放（同 requestToken 已拆过，本次未做任何写入）。 */
  replayed: boolean;
}

/** assessOrderSplit 的评估结果（preview 直接透出其中展示字段）。 */
interface SplitAssessment {
  blockers: string[];
  shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
  allShareRows: Array<{ passengerId: string; netCny: number; shareCny: number }>;
  movedShareCny: number;
  movedPaidCny: number;
  preTotalCny: number;
  prePaidCny: number;
  hotelItems: Array<{ itemId: string; description: string; roomsBilled: number | null }>;
  movedIdSet: Set<string>;
}

/** 拆单要读的源单快照（预检与事务内共用同一份 loader，杜绝两处字段漂移）。 */
async function loadOrderForSplit(db: Prisma.TransactionClient, orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      // 乘客不带 orderBy：与 ORDER_FULL_INCLUDE（详情页每人结算价表的数据源）同口径，
      // 保证「余数兜最后一位」兜到的与前端展示的是同一位乘客。
      passengers: {
        select: {
          id: true,
          fullName: true,
          chineseName: true,
          pnr: true,
          eticketNumber: true,
        },
      },
    },
  });
}
type SplitSourceOrder = NonNullable<Awaited<ReturnType<typeof loadOrderForSplit>>>;

/** 防御式读 JSON 对象（形状不符按空对象处理）。 */
function readJsonObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 防御式解析分房表房组（形状不符按无分房处理）；label 供人话文案。 */
function readRoomGroups(
  roomAssignment: unknown,
): Array<{ raw: Record<string, unknown>; passengerIds: string[]; label: string | null }> {
  const groups = readJsonObject(roomAssignment).roomGroups;
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g): g is Record<string, unknown> => g != null && typeof g === 'object' && !Array.isArray(g))
    .map((g) => {
      const ids = Array.isArray(g.passengerIds)
        ? g.passengerIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      const hotelName = typeof g.hotelName === 'string' && g.hotelName ? g.hotelName : null;
      const roomType = typeof g.roomType === 'string' && g.roomType ? g.roomType : null;
      const label = [hotelName, roomType].filter(Boolean).join(' · ') || null;
      return { raw: g, passengerIds: ids, label };
    });
}

/** 逐班次舱位数量账（拆单座位守恒断言用）：key = `${scheduleId}|${cabin}` → Σquantity。 */
function sumFlightQuantities(
  items: ReadonlyArray<{
    kind: OrderItemKind;
    flightScheduleId: string | null;
    flightCabin: import('@prisma/client').CabinClass | null;
    quantity: number;
  }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== OrderItemKind.FLIGHT || !it.flightScheduleId) continue;
    const key = `${it.flightScheduleId}|${it.flightCabin ?? 'NONE'}`;
    map.set(key, (map.get(key) ?? 0) + it.quantity);
  }
  return map;
}

/**
 * 拆单平账行：使该侧 total 收敛到份额口径（正 → FEE、负 → DISCOUNT，
 * 与 buildSettlementTotalItem 同一正负口径）；差额为 0 不生成行。
 */
async function createSplitBalanceItem(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    diffCny: number;
    itemsSumCny: number;
    shareCny: number;
    splitFrom: string;
    splitTo: string;
  },
): Promise<void> {
  if (input.diffCny === 0) return;
  const signed = `${input.diffCny > 0 ? '+' : '−'}¥${Math.abs(input.diffCny)}`;
  await tx.orderItem.create({
    data: {
      orderId: input.orderId,
      kind: input.diffCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
      description: `价格调整：拆单平账（${signed}）`,
      quantity: 1,
      unitPrice: new Prisma.Decimal(input.diffCny),
      amount: new Prisma.Decimal(input.diffCny),
      // 平账行是纯份额收敛（把行拆分的取整尾差与非人数行的份额补齐），无成本侧 → 显式落 0。
      totalCostCny: new Prisma.Decimal(0),
      metadata: {
        priceAdjustment: true,
        reasonCode: 'SPLIT',
        splitFrom: input.splitFrom,
        splitTo: input.splitTo,
        shareCny: input.shareCny,
        itemsSumCny: input.itemsSumCny,
      } as Prisma.InputJsonValue,
    },
  });
}

/** Prisma P2002（唯一约束冲突）且目标字段命中 fieldHint。 */
function isUniqueViolation(err: unknown, fieldHint: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(fieldHint));
  if (typeof target === 'string') return target.includes(fieldHint);
  return false;
}

/**
 * 改档要读的订单明细字段。锁外预检与锁内权威判定**共用同一份 select** ——
 * 两处各写一套，迟早出现「预检按 A 组字段放行、锁内按 B 组字段算钱」的漂移。
 * 覆盖四件事：挑套餐行、判已落位、算出发日、算旧档有效金额与占房。
 */
const CHANGE_BUNDLE_ITEM_SELECT = {
  id: true,
  kind: true,
  quantity: true,
  amount: true,
  bundleId: true,
  hotelRoomTypeId: true,
  hotelCheckIn: true,
  hotelCheckOut: true,
  roomsBilled: true,
  randomStarTier: true,
  visaIntendedDate: true,
  metadata: true,
  // 「已落位」判定：房型挂在随机档占位酒店上 = 还没落位（业务上仍是随机档）。
  hotelRoomType: { select: { hotel: { select: { name: true, randomTierPlaceholder: true } } } },
  // 整单出发日派生（deriveOrderDepartDate 同口径，按出发地当地日折算）。
  flightSchedule: { select: { departureTime: true, departureTz: true } },
} as const;

/** resolveChangeableBundleRow 认得的最小订单项形状（真实入参是上面 select 出来的行）。 */
interface ChangeBundleCandidateRow {
  id: string;
  kind: OrderItemKind;
  bundleId: string | null;
  hotelRoomTypeId: string | null;
  hotelRoomType?: { hotel: { randomTierPlaceholder: number | null } } | null;
}

/**
 * 「这单现在还能不能改档」的状态闸。锁外预检与锁内复检共用。
 * 状态集合与换酒店 / 酒店改期同一份：改档会改应收（长出/减掉一笔差额），
 * 在已取消 / 已退款 / 超时 / 草稿单上做，等于给死单凭空改账、能被算出二次退款。
 */
function assertOrderChangeBundleAllowed(order: {
  status: OrderStatus;
  deletedAt: Date | null;
}): void {
  if (order.deletedAt) {
    throw new BadRequestError('订单在回收站（已软删），不可改档；如需操作请先恢复');
  }
  if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
    throw new BadRequestError(
      `订单当前状态（${zhStatus(order.status)}）不可改档：仅占座中的有效订单可改档（已取消/已退款/超时订单请勿改档）`,
    );
  }
}

/**
 * 从订单明细里挑出「唯一那条可改档的套餐行」，顺手把不该改的情况一次性拒掉：
 * 无套餐行 / 多条套餐行 / 未关联产品 / 与目标同档 / 酒店已落位。
 *
 * 已落位 = 住宿已盖章到**真实**酒店（房型所属酒店不是随机档占位酒店）。此时改档会让
 * 「客人已经确定住哪」与「新档次该住哪」直接打架 —— 住宿要先走换酒店流程处理掉，
 * 改档只负责钱与档次。未落位（仍是随机档占位）或无酒店组件才允许。
 *
 * 锁外预检与锁内权威判定共用本函数：并发可能在这两次之间把单改成任一种「不该改」，
 * 两处各写一套判定必然漂移。
 */
function resolveChangeableBundleRow<T extends ChangeBundleCandidateRow>(
  items: readonly T[],
  targetBundleId: string,
): { row: T; bundleId: string } {
  const bundleRows = items.filter((it) => it.kind === OrderItemKind.BUNDLE);
  if (bundleRows.length === 0) {
    throw new BadRequestError('本单不含套餐行，无法改档');
  }
  if (bundleRows.length > 1) {
    // 多套餐单改档「改哪一张」无从判定，且差额口径会分叉 —— 明确拒绝，不猜。
    throw new BadRequestError('本单含多条套餐行，暂不支持自动改档，请联系技术处理');
  }
  const row = bundleRows[0];
  if (!row.bundleId) {
    throw new BadRequestError('该套餐行未关联套餐产品，无法改档');
  }
  if (row.bundleId === targetBundleId) {
    throw new BadRequestError('目标套餐与当前套餐相同，无需改档');
  }
  const isSettledRow = (candidate: ChangeBundleCandidateRow): boolean =>
    candidate.hotelRoomTypeId != null &&
    candidate.hotelRoomType?.hotel.randomTierPlaceholder == null;
  const settled =
    (isSettledRow(row) ? row : null) ??
    items.find((it) => it.kind === OrderItemKind.HOTEL && isSettledRow(it)) ??
    null;
  if (settled) {
    throw new BadRequestError('本单酒店已落位，请先通过换酒店功能处理住宿再改档');
  }
  return { row, bundleId: row.bundleId };
}

/**
 * 历次「套餐改档差额行」的合计（CNY，正=补收、负=优惠）。
 *
 * 用途：套餐行行价冻结（永远停在首次录单那一刻），所以「这条套餐行现在实际贡献了多少应收」
 * = 冻结金额 + 本函数。第二次改档必须拿这个数当旧档基线，否则会把上一次的差额再算一遍。
 *
 * 只认差额行：差额行是 FEE/DISCOUNT 且 `metadata.bundleChange === true`；
 * 套餐行自己的 `metadata.bundleChange` 是一个留痕**对象**（不是 true），故连 kind 一起卡，
 * 两者绝不会互相认错。导出供单测使用。
 */
export function sumBundleChangeDiffCny(
  items: ReadonlyArray<{ kind: OrderItemKind; amount: Prisma.Decimal | number; metadata: unknown }>,
): number {
  const total = items.reduce((sum, it) => {
    if (it.kind !== OrderItemKind.FEE && it.kind !== OrderItemKind.DISCOUNT) return sum;
    const meta = it.metadata as { bundleChange?: unknown } | null;
    if (meta?.bundleChange !== true) return sum;
    return sum + Number(it.amount.toString());
  }, 0);
  return round2(total);
}

/**
 * 改档重新计价所需的套餐字段（与录单 priceAndValidateItems 的 BUNDLE 分支同一组，
 * 少一个字段就会出现「录单算出一个价、改档算出另一个价」的漂移）。
 */
const CHANGE_BUNDLE_PRICING_SELECT = {
  id: true,
  name: true,
  isActive: true,
  items: true,
  discountPct: true,
  hotelRoomTypeId: true,
  hotelNights: true,
  singleSupplementCnyPerNight: true,
  businessUpgradeCnyPerLeg: true,
  outboundFlight: { select: { businessUpgradeCnyPerLeg: true } },
  returnFlight: { select: { businessUpgradeCnyPerLeg: true } },
  childSeatDiscountCnyPerPerson: true,
  infantPriceCny: true,
  selfVisaDeductCny: true,
  operationFeeCny: true,
  legs: true,
  settlementTier: true,
  settlementNights: true,
  hotelRoomType: { select: { maxAdults: true, maxChildren: true, basePrice: true, hotelId: true } },
} as const;

/**
 * 套餐改档后的行价重算 —— 与录单 BUNDLE 分支共用同一批权威纯函数
 * （resolveBundleNights / computeBundleRoomsCharged / computeBundleGroundTotal /
 *   resolveBundleHotelStamp / computeBundleAddOn / computeBundleOperationFeeTotal），
 * 只是把「客户端传来的行输入」换成「原单已盖章的快照」。
 *
 * 与录单唯一的口径差异：**指定酒店加价恒为 0** —— 指定酒店随改档清除（新档要重新指定），
 * 这一点在 changeOrderBundle 的响应 warnings 里明确告知运营。
 *
 * 导出供单测使用。
 */
export function computeChangedBundleLine(input: {
  bundle: {
    items: unknown;
    discountPct: number | null;
    hotelRoomTypeId: string | null;
    hotelNights: number | null;
    singleSupplementCnyPerNight: number;
    businessUpgradeCnyPerLeg: number | null;
    outboundFlight?: { businessUpgradeCnyPerLeg: number } | null;
    returnFlight?: { businessUpgradeCnyPerLeg: number } | null;
    childSeatDiscountCnyPerPerson: number;
    infantPriceCny: number;
    selfVisaDeductCny: number;
    operationFeeCny: number;
    legs: number;
    hotelRoomType?: { maxAdults: number; maxChildren: number; basePrice: Prisma.Decimal | number } | null;
  };
  occupancy: BundleOccupancy;
  singleCount: number;
  businessSplit: BundleBusinessUpgradeSplit;
  selfProvidedVisaCount: number;
  quantity: number;
  /** 出发日（YYYY-MM-DD）；缺失 → 不盖住宿区间的章。 */
  goDate: string | null;
}): {
  /** 打折后的套餐行金额（CNY，整数，≥0）。 */
  amount: number;
  /** 打折后的套餐行单价（地面价口径）。 */
  unitPrice: number;
  rooms: number;
  nights: number;
  hotelStamp: { hotelRoomTypeId: string; hotelCheckIn: Date; hotelCheckOut: Date } | null;
  addOn: ReturnType<typeof computeBundleAddOn>;
  /** 加项净额（未打折）：结算价日历取价时叠加在日历价之上。 */
  settlementAddOnCny: number;
} {
  const { bundle, occupancy, singleCount, businessSplit, selfProvidedVisaCount, quantity } = input;
  const nights = resolveBundleNights(bundle.items, bundle.hotelNights);
  const rooms = computeBundleRoomsCharged({
    occupancy,
    capacity: bundle.hotelRoomType ?? null,
    hotelRoomTypeId: bundle.hotelRoomTypeId,
    singleCount,
    // 改档不接受客户端间数：新档的容量口径由新套餐房型决定，一律服务端重算。
    clientRoomsBilled: undefined,
  });
  const linkedHotelNightlyPrice =
    bundle.hotelRoomTypeId && bundle.hotelRoomType
      ? Number(bundle.hotelRoomType.basePrice.toString())
      : null;
  const visaHeadCount = Math.max(0, occupancy.headCount - selfProvidedVisaCount);
  const groundUnitPrice = computeBundleGroundTotal({
    components: bundle.items,
    linkedHotelNightlyPrice,
    rooms,
    visaHeadCount,
  });
  const hotelStamp = resolveBundleHotelStamp(
    { hotelRoomTypeId: bundle.hotelRoomTypeId },
    input.goDate ? { goDate: input.goDate } : undefined,
    nights,
  );
  const addOn = computeBundleAddOn(
    { ...bundle, businessUpgradeCnyPerLeg: resolveBundleBusinessUpgradeRate(bundle) },
    hotelStamp,
    singleCount,
    businessSplit,
    occupancy,
    nights,
    selfProvidedVisaCount,
  );
  const operationFeeTotal = computeBundleOperationFeeTotal(bundle.operationFeeCny, occupancy.seatPax);
  // 非负保护与录单同一层：减免（自备签/儿童折扣）先抵扣地面价 + 操作费，极端情况才夹到 0。
  let amount = Math.max(0, groundUnitPrice * quantity + addOn.total + operationFeeTotal);
  let unitPrice = groundUnitPrice;
  const pct = bundle.discountPct ?? 0;
  if (pct > 0) {
    const factor = (100 - pct) / 100;
    amount = Math.round(amount * factor);
    unitPrice = Math.round(unitPrice * factor);
  }
  return {
    amount,
    unitPrice,
    rooms,
    nights,
    hotelStamp,
    addOn,
    settlementAddOnCny: addOn.total,
  };
}

// 完整 include 给 serializeOrder 用
const ORDER_FULL_INCLUDE = {
  items: true,
  passengers: true,
  payments: true,
  refunds: true,
  statusEvents: { orderBy: { createdAt: 'asc' } },
  agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
  user: { select: { id: true, displayName: true, email: true } },
} as const;

// ── Helpers ────────────────────────────────────────────────────────────

/** listOrders / 三模板导出共用的筛选字段（不含 RBAC / 接单 / 分页）。 */
export type OrderListFilters = Pick<
  ListOrdersQuery,
  | 'status'
  | 'agentId'
  | 'kind'
  | 'search'
  | 'from'
  | 'to'
  | 'travelFrom'
  | 'travelTo'
  | 'returnFrom'
  | 'returnTo'
  | 'flightNumber'
  | 'passengerName'
  | 'recordedBy'
  | 'invoiceStatus'
  | 'invoiceLeg'
  | 'invoiced'
  | 'visaFulfillmentStatus'
  | 'visaRequirement'
  | 'tripType'
> & {
  /** 精确按班次过滤（整班·全岗导出用）；比 travelFrom/travelTo 更准，不受 ±1 天放宽影响。 */
  scheduleId?: string;
  /**
   * 勾选导出：给了非空数组就「只导这批订单」——以 id 集合为准，忽略其余筛选条件
   *（COUNTED_STATUSES 保护仍由各导出入口叠加）。仅导出路径设置，listOrders 不用。
   */
  orderIds?: string[];
};

/**
 * 下单时间（createdAt）筛选边界解析（公测反馈：需精确到几点几分统计当日进单）。
 * - 纯日期 YYYY-MM-DD：保持历史口径不变 —— from → 当日 00:00:00Z（gte）；to → 当日 23:59:59Z（lte）。
 * - 带时间 YYYY-MM-DDTHH:mm[:ss]（datetime-local 口径）：按录单人所见的北京时（+08:00）墙钟时刻精确
 *   卡界。列表「下单时间」列用浏览器本地时区（北京 +8）渲染 createdAt，故按 +08:00 解释输入才与所见
 *   一致；若按 UTC 解释会整体偏 8 小时。缺秒补 :00。
 */
const BUSINESS_UTC_OFFSET = '+08:00';
function resolveCreatedAtBoundary(value: string, edge: 'from' | 'to'): Date {
  if (value.includes('T')) {
    const withSeconds = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    return new Date(`${withSeconds}${BUSINESS_UTC_OFFSET}`);
  }
  return edge === 'from'
    ? new Date(`${value}T00:00:00Z`)
    : new Date(`${value}T23:59:59Z`);
}

// ── 搜索分词（多词 AND 匹配）────────────────────────────────────────
// 分隔符：空格（含全角/换行）、英文逗号、中文逗号、顿号 —— 覆盖录单员常见的姓名串写法。
const SEARCH_TERM_SEPARATORS = /[\s,，、]+/;
// 词数上限（query.search 专用）：词间 AND 语义——每个词都会展开成一组跨表 OR 子查询，
// 词数不设限会被超长输入拖垮查询，故这里保持 5 不动。
const MAX_SEARCH_TERMS = 5;
// 乘客姓名筛选专用上限（运营反馈：一次要贴一整团几十人的名单，5 个卡得太死）。
// 词间是 OR、且只在 passengers 一张表上 contains（不像 search 要跨表展开 AND），
// 放宽到 50 代价可控，覆盖绝大多数团组名单规模。
export const MAX_PASSENGER_NAME_TERMS = 50;

/**
 * 输入串 → 规整后的词列表（trim、去空词、截断到上限）。导出供单测使用。
 * @param limit 词数上限，默认 MAX_SEARCH_TERMS（5，query.search / recordedBy 用）；
 *   乘客姓名筛选传 MAX_PASSENGER_NAME_TERMS（50）。
 */
export function splitSearchTerms(search: string, limit: number = MAX_SEARCH_TERMS): string[] {
  return search
    .split(SEARCH_TERM_SEPARATORS)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, limit);
}

/**
 * 单个搜索词 → OR 匹配块。字段口径：
 * - 订单号 / 联系人 / 联系电话（历史字段，保持原语义）；
 * - 乘客中/英文名（公测反馈：搜索框要能按乘客姓名搜到订单）；
 * - 乘客护照号 documentNumber（运营需求：按证件号定位订单）；
 * - 订单级备注六栏 notes/internalNotes/noteHotel/noteVisa/notePayment/noteSpecial；
 * - 订单项名称 OrderItem.description（公测反馈：搜产品名/酒店名/签证名要能搜到订单）——
 *   运营记得住「客人买的是哪个产品」的次数，不比记得住订单号少；此前搜索只认订单号/人/备注，
 *   按产品名搜一律空手而归。与乘客子查询同构（items.some.description），词间 AND 语义不变。
 * 导出：主列表与回收站（listDeletedOrders）共用本口径，另供单测断言 where 形状。
 */
export function buildSearchTermClause(term: string): Prisma.OrderWhereInput {
  return {
    OR: [
      { orderNumber: { contains: term, mode: 'insensitive' } },
      { contactName: { contains: term, mode: 'insensitive' } },
      { contactPhone: { contains: term } },
      { notes: { contains: term, mode: 'insensitive' } },
      { internalNotes: { contains: term, mode: 'insensitive' } },
      { noteHotel: { contains: term, mode: 'insensitive' } },
      { noteVisa: { contains: term, mode: 'insensitive' } },
      { notePayment: { contains: term, mode: 'insensitive' } },
      { noteSpecial: { contains: term, mode: 'insensitive' } },
      {
        passengers: {
          some: {
            OR: [
              { fullName: { contains: term, mode: 'insensitive' } },
              { chineseName: { contains: term, mode: 'insensitive' } },
              { documentNumber: { contains: term, mode: 'insensitive' } },
            ],
          },
        },
      },
      // 产品名（航段/酒店/签证/套餐的行描述）——任一订单项命中即命中该订单。
      { items: { some: { description: { contains: term, mode: 'insensitive' } } } },
    ],
  };
}

/**
 * 游客单（userId=null，前台自助下单无录单账号）在「录入人员」口径下的统一标签。
 * 列表筛选与各导出的「录入人员」列共用本常量，避免两处各写各的字面量漂移。
 */
export const GUEST_RECORDED_BY_LABEL = '散客';

/**
 * 把列表/导出共用的筛选参数转成 Prisma where。
 * listOrders 与 orders.export-templates.ts 三模板导出共用，避免两处过滤逻辑漂移。
 * 注意：不含 RBAC（userId/可见代理集合）、claimedById/unclaimedOnly、分页 —— 由调用方叠加。
 *
 * @param options.includeAnchorless 仅导出路径传 true —— 出行日期筛选时把「一个日期锚点都没有
 *   **的签证单**」也召回（详见下方 travelFrom/travelTo 分支；空单/接送单/资料不全的机酒单
 *   不在豁免之列）。列表路径保持默认 false。
 */
export function buildOrderFilterWhere(
  query: OrderListFilters,
  options?: { includeAnchorless?: boolean },
): Prisma.OrderWhereInput {
  // 勾选导出：给了 orderIds 就以「勾选的 id 集合」为准，忽略其余筛选条件
  //（导出=用户勾了哪些就导哪些；不计数状态的 COUNTED_STATUSES 保护由各导出入口叠加）。
  // deletedAt: null —— 已软删的订单即便被显式勾中也不导出（从所有列表/导出里消失）。
  if (query.orderIds && query.orderIds.length > 0) {
    return { id: { in: query.orderIds }, deletedAt: null };
  }
  // 软删除排除：listOrders 与所有复用本 where 的导出（三模板 / 全岗总表）统一排除已删订单。
  // listOrders 会展示全部状态（含 CANCELLED/REFUNDED 等释放型），是唯一会「看见」已删订单的口径，
  // 故必须在此挂 deletedAt: null（各导出另叠 COUNTED_STATUSES，本就不含释放型，此处为对齐兜底）。
  const where: Prisma.OrderWhereInput = { deletedAt: null };
  // 多个 items 维度的筛选必须用 AND 叠加（每个 { items: { some } } 各自独立成立），
  // 否则直接赋值 where.items 会互相覆盖 —— 历史上 kind 与 travelFrom/travelTo 同时传时
  // 后者会清掉前者，造成漏单（结构性根因）。统一往 andClauses 里推。
  const andClauses: Prisma.OrderWhereInput[] = [];

  if (query.status) where.status = query.status;
  if (query.agentId) where.agentId = query.agentId;
  if (query.kind) andClauses.push({ items: { some: { kind: query.kind } } });
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: resolveCreatedAtBoundary(query.from, 'from') } : {}),
      ...(query.to ? { lte: resolveCreatedAtBoundary(query.to, 'to') } : {}),
    };
  }
  // 按出行日期筛选 — 跨 OrderItem 多种字段
  // FLIGHT: 取 schedule.departureTime；HOTEL: hotelCheckIn；其他暂时用 createdAt 兜底。
  // 出行日期存的是 UTC 时刻，而筛选用的是本地（出发地 +8）日期；UTC 与本地跨午夜会落到相邻日，
  // 直接按 [from 00:00Z, to 23:59Z] 卡会漏掉边界单。故把窗口各向外放宽一天做安全余量
  //（宁可多召回、不漏单 —— 与财务按出发地时区分桶同源的容忍口径）。
  if (query.travelFrom || query.travelTo) {
    const start = query.travelFrom
      ? new Date(new Date(`${query.travelFrom}T00:00:00Z`).getTime() - DAY_MS)
      : undefined;
    const end = query.travelTo
      ? new Date(new Date(`${query.travelTo}T23:59:59Z`).getTime() + DAY_MS)
      : undefined;
    const withinWindow = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {}),
    };
    const anchoredInWindow: Prisma.OrderWhereInput = {
      items: {
        some: {
          OR: [
            { flightSchedule: { departureTime: withinWindow } },
            { hotelCheckIn: withinWindow },
            // 签证行的「预计出行日期」—— 纯签证单（无航班、无住宿）唯一的日期锚点。
            // 缺了这一支，填了预计出行日期的签证单照样取不回来，
            // 与「出发日期」列的派生口径（deriveOrderDepartDate 第三级回退）也对不上。
            { visaIntendedDate: withinWindow },
          ],
        },
      },
    };
    // ── 无锚点**签证单**：仅导出路径召回 ────────────────────────────────────
    // 「锚点」= 能派生出整单出发日的字段，三选一：航段出发时间 / 酒店入住日 / 签证预计出行日期。
    // 一条锚点都没有的单（典型：还没填预计出行日期的纯签证单）在上面的 some 里必然落空。
    //   导出 —— 要召回：导出是「把这批单交出去办事」，静默漏掉等于签证岗整批看不到自己的单；
    //     召回后由 orders.export-depart-filter.ts 的内存过滤按同一口径兜底保留。
    //   列表 —— 不召回：列表的日期筛选是「找某天走的单」，无日期单若无条件保留就会出现在
    //     每一个日期区间里，筛选失效（口径详见 filterOrderIdsByDepartDate 注释）。
    //
    // 例外只给签证单（收窄，P1-7）：这条豁免的**理由**是「签证业务本身没有航班和住宿，
    // 没填预计出行日期就彻底无处归日」——只有涉签的单才配得上它。此前只判「一个日期锚点都没有」，
    // 于是空单、纯接送单、资料还没录全的机酒单也跟着被塞进每一个指定日期的导出里。
    // 涉签判定与签证任务锚点同源（VISA 行 → 含签证组件的 BUNDLE 行）：
    //   · VISA 行：items.some.kind = VISA；
    //   · 含签证组件的套餐行：Bundle.items（JSON 数组）含 { kind: 'VISA' } 组件，
    //     用 array_contains 走 Postgres jsonb 包含（部分匹配：组件的其余字段不影响命中）。
    const anchorlessVisaOnly: Prisma.OrderWhereInput = {
      AND: [
        {
          items: {
            none: {
              OR: [
                { flightScheduleId: { not: null } },
                { hotelCheckIn: { not: null } },
                { visaIntendedDate: { not: null } },
              ],
            },
          },
        },
        {
          items: {
            some: {
              OR: [
                { kind: OrderItemKind.VISA },
                {
                  kind: OrderItemKind.BUNDLE,
                  bundle: { items: { array_contains: [{ kind: 'VISA' }] } },
                },
              ],
            },
          },
        },
      ],
    };
    andClauses.push(
      options?.includeAnchorless ? { OR: [anchoredInWindow, anchorlessVisaOnly] } : anchoredInWindow,
    );
  }
  // 按返程日期筛选 — 两段式的 DB 粗窗口（精筛在 listOrders 里用 filterOrderIdsByReturnDate）。
  // 与出发日期同一套 ±1 天安全余量口径；但只看 FLIGHT 行的班次出发时间——返程日期没有酒店/签证
  // 兜底（只对「确实买了回程机票」的单有意义），粗窗口只需保证真正的回程腿落在窗口内的订单
  // 被召回即可，允许多召回去程腿恰好落在窗口内的单（JS 精筛会按 determineFlightLegItems 的
  // 第 2 段口径把它们筛掉）。
  if (query.returnFrom || query.returnTo) {
    const start = query.returnFrom
      ? new Date(new Date(`${query.returnFrom}T00:00:00Z`).getTime() - DAY_MS)
      : undefined;
    const end = query.returnTo
      ? new Date(new Date(`${query.returnTo}T23:59:59Z`).getTime() + DAY_MS)
      : undefined;
    andClauses.push({
      items: {
        some: {
          kind: OrderItemKind.FLIGHT,
          flightSchedule: {
            departureTime: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {}),
            },
          },
        },
      },
    });
  }
  // 精确按班次：订单需含该班次的 FLIGHT 行。整班·全岗导出专用——比 travelFrom/travelTo 精确，
  // 不受出行日期窗口 ±1 天放宽影响，保证只导该班次当天的订单。
  if (query.scheduleId) {
    andClauses.push({ items: { some: { flightScheduleId: query.scheduleId } } });
  }
  if (query.invoiceStatus) where.invoiceStatus = query.invoiceStatus;
  // 六态开票筛选（组合式）：invoiceLeg 指航段/系统维度，invoiced 指该维度已开(true)/未开(false)。
  // 二者需同时给出才生效——这正是票务岗「出行日期=7/10 + 去程未开 → 导出」的筛选路径。
  //   outbound → outboundInvoiced；return → returnInvoiced；system → systemInvoiced。
  if (query.invoiceLeg && query.invoiced !== undefined) {
    const col = (
      { outbound: 'outboundInvoiced', return: 'returnInvoiced', system: 'systemInvoiced' } as const
    )[query.invoiceLeg];
    where[col] = query.invoiced;
    // ── 航段守卫（B7）：航段维度只该捞「真有航段可开」的单 ──────────────────
    // outboundInvoiced / returnInvoiced 缺省就是 false，所以没有航段的单（酒店单/签证单）
    // 天然命中「未开」，会被一起捞进票务岗的开票清单 —— 它们根本没有票可开。
    // 三个渲染层（export-master / export-templates / 列表徽标）都按 determineFlightLegs 做了
    // 结构判定，唯独查询层裸奔：这是遗漏，不是设计。
    //   · outbound / return：要求本单至少有一条带班次的 FLIGHT 行。
    //   · system：**不加**守卫 —— 系统开票是订单维度、不是航段维度，酒店单/签证单本来就要
    //     系统开票，给它加守卫会错杀（假阴性比假阳性更糟：清单里少了单 = 真活丢了）。
    if (query.invoiceLeg === 'outbound' || query.invoiceLeg === 'return') {
      andClauses.push({
        items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } },
      });
    }
    // ── 单程单守卫：回程维度加挂物化列 hasReturnLeg ────────────────────────
    // 上面的航段守卫只能排除「一条航段都没有」的单，排不掉**单程单**——单程单有去程、无回程，
    // returnInvoiced 恒为 false，天然命中「回程未开」，但它压根没有回程票可开。
    // 判定回程要 determineFlightLegs（FLIGHT 行按 departureTime 升序取第 2 段），Prisma where
    // 表达不了「关联行 ≥ 2 条」，故物化成 Order.hasReturnLeg（建单/改期写路径同步维护）。
    // 导出路径的内存二次过滤（orders.export-trip-filter.ts 的 excludeOnewayFromReturnLegExport）
    // 保留不动，作为物化列失准时的双保险。
    if (query.invoiceLeg === 'return') {
      andClauses.push({ hasReturnLeg: true });
    }
  }
  // 行程类型筛选（单程/往返）—— 同样走物化列。
  //   roundtrip：有回程航段。
  //   oneway   ：无回程航段，且**必须有航段**（否则酒店单/签证单会被当成「单程」捞出来）。
  // 走 andClauses 而不是直接赋值 where.hasReturnLeg：与上面的回程守卫互不覆盖，
  // 「单程 + 回程未开」这种自相矛盾的组合会诚实地返回空集，而不是让某一边静默失效。
  if (query.tripType === 'roundtrip') {
    andClauses.push({ hasReturnLeg: true });
  } else if (query.tripType === 'oneway') {
    andClauses.push({ hasReturnLeg: false });
    andClauses.push({
      items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } },
    });
  }
  // 签证办理状态筛选 — 与列表「签证」列徽标同源（签证办理履约任务 VISA_APPLICATION 的状态）。
  //   signed  ：订单存在「已确认(CONFIRMED)」的签证办理任务 = 已签证。
  //   unsigned：订单存在签证办理任务、但无任何「已确认」的（待处理/处理中/取消/失败）= 未签证。
  // 按履约任务判定、不限 item kind —— 签证任务常挂在 BUNDLE 行或首个订单项上（套餐订单没有
  // 独立 VISA 行），若强求 kind=VISA 会漏掉套餐签证单（signed/unsigned 双 0）。
  // 无任何签证办理任务的订单两者都不命中（列表徽标显示「—」），与徽标口径一致、不制造第三口径。
  // 走 andClauses 叠加，可与 kind / 出行日期 / 航班号等 items 维度组合而不互相覆盖。
  const HAS_VISA_TASK: Prisma.OrderWhereInput = {
    items: {
      some: {
        fulfillmentTasks: { some: { type: FulfillmentType.VISA_APPLICATION } },
      },
    },
  };
  const VISA_APPLICATION_CONFIRMED: Prisma.OrderWhereInput = {
    items: {
      some: {
        fulfillmentTasks: {
          some: { type: FulfillmentType.VISA_APPLICATION, status: FulfillmentStatus.CONFIRMED },
        },
      },
    },
  };
  if (query.visaFulfillmentStatus === 'signed') {
    andClauses.push(VISA_APPLICATION_CONFIRMED);
  } else if (query.visaFulfillmentStatus === 'unsigned') {
    andClauses.push({
      AND: [HAS_VISA_TASK, { NOT: VISA_APPLICATION_CONFIRMED }],
    });
  }
  // 签证录单要求筛选 — 这是订单级 Order.visaStatus 维度，与上面的履约办理进度互不替代。
  if (query.visaRequirement) {
    andClauses.push({ visaStatus: query.visaRequirement });
  }
  // 航班号筛选 — 订单需含该航班号的 FLIGHT 行（同样走 AND 叠加，可与 kind/出行日期组合）
  if (query.flightNumber) {
    andClauses.push({
      items: {
        some: {
          kind: OrderItemKind.FLIGHT,
          flightSchedule: {
            flight: {
              flightNumber: { equals: query.flightNumber, mode: 'insensitive' },
            },
          },
        },
      },
    });
  }
  // 乘客姓名筛选（词内 OR）：拼音 fullName 与中文名 chineseName 任一命中即可（公测反馈：中文名搜不到）。
  // 多词间同样 OR（运营需求：姓名框填多个人名要把这些人的订单都列出来——"列出这些乘客的订单"而非
  // "同一订单里凑齐这些乘客"，故不复用 query.search 的词间 AND 语义）；任一乘客命中任一词即命中该订单。
  // 单词输入退化为原语义（fullName/chineseName 任一命中该词）。
  // 词数上限用 MAX_PASSENGER_NAME_TERMS（50）而非 search 的 5——运营反馈：一次要贴一整团
  // 几十人的名单，5 个名字卡不住整团人数；这里只在 passengers 一张表上 contains，代价可控。
  if (query.passengerName) {
    const terms = splitSearchTerms(query.passengerName, MAX_PASSENGER_NAME_TERMS);
    where.passengers = {
      some: {
        OR: terms.flatMap((term) => [
          { fullName: { contains: term, mode: 'insensitive' } },
          { chineseName: { contains: term, mode: 'insensitive' } },
        ]),
      },
    };
  }
  // 录入人员筛选（词间 OR）：匹配下单账号的显示名 / 邮箱 —— 与总表导出「录入人员」列同源，
  // 保证「列表筛到的 = 导出那列写的」。
  // 游客单（userId=null）没有录单账号，整类归到 GUEST_RECORDED_BY_LABEL（散客）：搜「散客」
  // 把这批单全捞出来，而不是拿客人自己的名字冒充录入人。
  // 走 andClauses 叠加，可与产品类型 / 出行日期 / 航班号等维度组合而不互相覆盖。
  if (query.recordedBy) {
    const terms = splitSearchTerms(query.recordedBy);
    andClauses.push({
      OR: terms.flatMap((term) => [
        { user: { displayName: { contains: term, mode: 'insensitive' as const } } },
        { user: { email: { contains: term, mode: 'insensitive' as const } } },
        // 「散客」是固定标签、不是库里的字段：词命中标签本身才把整批游客单纳入（含前缀输入「散」）。
        ...(GUEST_RECORDED_BY_LABEL.includes(term) ? [{ userId: null }] : []),
      ]),
    });
  }
  // 多词分词 AND 搜索（运营需求：一次输入多位乘客姓名要能定位同一订单）。
  // 每个词各自生成一个 OR 匹配块（订单号/联系人/电话/乘客名/护照号/各类备注），
  // 词与词之间 AND —— 两个词分别命中同单的两位乘客时该订单命中；单词输入 = 原语义 + 新增字段。
  // 走 andClauses 叠加，与 kind / 出行日期 / 航班号等维度组合互不覆盖。
  if (query.search) {
    for (const term of splitSearchTerms(query.search)) {
      andClauses.push(buildSearchTermClause(term));
    }
  }

  // 把所有 items 维度的子句一次性 AND 起来（kind / 出行日期 / 航班号可任意组合，互不覆盖）
  if (andClauses.length > 0) where.AND = andClauses;

  return where;
}

// ── 签证订单：护照有效期必填 ─────────────────────────────────────────
/**
 * items 含 VISA 行时，每位出行人都必须填写护照有效期（送签材料必填，
 * 缺失会导致使馆退件）。不含 VISA 行的订单不受此规则约束。
 *
 * 导出供 createOrder 调用 + 单测使用。
 */
export function assertVisaPassengersHavePassportExpiry(
  items: ReadonlyArray<Pick<OrderItemInput, 'kind'>>,
  passengers: ReadonlyArray<Pick<PassengerInput, 'passportExpiry'>>,
): void {
  const hasVisaItem = items.some((i) => i.kind === 'VISA');
  if (!hasVisaItem) return;
  const hasMissingExpiry = passengers.some((px) => !px.passportExpiry);
  if (hasMissingExpiry) {
    throw new BadRequestError('签证订单每位出行人需填写护照有效期');
  }
}

// ── 服务端价格校验（A3）─────────────────────────────────────────────
/**
 * 比对客户端提交的「单价 × 数量」与服务端权威「单价 × 数量」。
 * 偏差超过 PRICE_TOLERANCE_CNY（1.00 元）则抛 400，拒绝下单。
 * 用于 HOTEL/VISA/TRANSFER —— FLIGHT/BUNDLE 走各自动态重算，不需此通用比对。
 * 导出仅供单测使用。
 */
export function assertAmountWithinTolerance(
  label: string,
  clientUnitPrice: number,
  serverUnitPrice: number,
  quantity: number,
): void {
  const clientAmount = clientUnitPrice * quantity;
  const serverAmount = serverUnitPrice * quantity;
  if (Math.abs(clientAmount - serverAmount) > PRICE_TOLERANCE_CNY) {
    throw new BadRequestError(
      `${label}价格已变动（提交 ¥${clientAmount.toFixed(2)}，当前 ¥${serverAmount.toFixed(2)}），请刷新后重试`,
    );
  }
}

// ── 套餐酒店盖章 ─────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 套餐关联了酒店房型时，从订单行 metadata（goDate/returnDate）推导入住/退房日期。
 * - returnDate 合法且晚于 goDate → 用 returnDate 做退房日
 * - 否则按 goDate + nights 推退房日（nights 由 resolveBundleNights 解析的单一权威晚数，调用方传入）
 * - 套餐没关联房型、或 goDate 缺失/非法 → 返回 null（不盖章，下单照常）
 *
 * 导出仅供单测使用。
 */
/**
 * 把住宿区间 [checkIn, checkOut)（半开）展开为逐晚 YYYY-MM-DD（UTC date-only）。
 * 供套餐下单时的酒店房量库存校验用（口径与 getHotelNightlyRemaining / 房控完全一致）。
 * 防御：checkOut <= checkIn 或跨度异常大 → 返回空数组（调用方按"无从校验"跳过，不阻断下单）。
 */
const MAX_STAY_NIGHTS = 60;
export function buildStayNightDates(checkIn: Date, checkOut: Date): string[] {
  const startMs = checkIn.getTime();
  const endMs = checkOut.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const nights = Math.round((endMs - startMs) / DAY_MS);
  if (nights < 1 || nights > MAX_STAY_NIGHTS) return [];
  return Array.from({ length: nights }, (_, i) =>
    new Date(startMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * 把 HOTEL 行 description 里的「日期段」与「晚数段」就地改写成新住宿区间，其余部分原样保留。
 *
 * 为什么用就地改写而不是整条重建：HOTEL 行的 description 历史上有多种形态 ——
 *   · 建单/换酒店：`酒店名 · 房型 · 2026-09-01~2026-09-04 · 3晚 × 1间`
 *   · 后台补录房费：`酒店名 · 房型 × 3晚 × 1间`（没有日期段）
 *   · 更老的存量单：可能是运营手填的自由文本
 * 整条重建会把手填信息冲掉，也会强行给本来没有日期段的行硬塞一段。就地改写只动确实存在的
 * 那两段，其余（酒店名/房型/间数/手填备注）一个字不碰。
 *
 * 只替换第一处匹配：日期段与晚数段在这些格式里都只出现一次，全局替换反而会误伤备注里的日期。
 * 两段都不存在（纯自由文本）→ 原样返回，不报错（描述只是展示，不是权威数据；权威在
 * hotelCheckIn/hotelCheckOut 字段上）。
 *
 * 导出仅供单测使用。
 */
export function rewriteHotelStayDescription(
  description: string,
  stay: { checkIn: string; checkOut: string; nights: number },
): string {
  return description
    .replace(/\d{4}-\d{2}-\d{2}\s*~\s*\d{4}-\d{2}-\d{2}/, `${stay.checkIn}~${stay.checkOut}`)
    .replace(/\d+(?:\.\d+)?\s*晚/, `${stay.nights}晚`);
}

// ── 事务内酒店房量闸（新增真实占房的写路径统一入口）─────────────────────────
/** 对外端点的中性话术：不把包房间数/余量这些内部库存数字回给客人。*/
export const HOTEL_SOLD_OUT_MESSAGE = '该出发日期酒店可用房量不足，请更换日期或联系客服';

/** 一条「本次打算落库」的酒店占房（口径同 OrderItem 的占房四件套）。*/
export interface ProspectiveHotelStay {
  hotelRoomTypeId?: string | null;
  hotelCheckIn?: Date | null;
  hotelCheckOut?: Date | null;
  /** 计费房间数（床位/计费口径，可为 0.5 拼房）；缺省 1，与房控 itemRoomCount 的兜底一致。*/
  roomsBilled?: number | null;
  /** 未落位随机档行的档次（3/4）；具体酒店行为空。*/
  randomStarTier?: number | null;
}

/**
 * 事务内**随机档**余量闸：把本次要落库的「未落位随机档占房」按「档次 × 住宿区间」归并，
 * 逐组过一遍带行锁的聚合闸（assertRandomTierFitWithinTx）。装不下就抛 BadRequestError、整事务回滚。
 *
 * 与 assertHotelStaysFitWithinTx 是互斥的两半（合起来覆盖全部占房）：
 *   · 那一半管**真酒店的真房量**（物理房间口径 + 性别桶）；
 *   · 这一半管**还没落位的随机档**（同星级聚合的床位口径）—— 随机单没落到任何一家酒店，
 *     拼房能否配对要等落位那一刻由该店当晚性别桶决定，落位走换酒店流程、那里有物理闸把关。
 *
 * 两类行都归到这里（它们占的是同一份聚合余量，必须合并计数）：
 *   · 单独 HOTEL 行的 `randomStarTier`（后台直接录「三星随机」）；
 *   · 房型挂在**随机档占位酒店**上的行（套餐绑定占位房型）—— 占位酒店不是真房源，
 *     tier 取该酒店的 `randomTierPlaceholder`。
 *
 * 为什么必须事务内 + 行锁：聚合闸本身是只读判定，两笔并发单抢同星级最后一间会各自读到
 * 「还剩 1 间」的旧快照双双通过。带锁版先把该档次全部真酒店在该区间的包房周期行
 * `SELECT … FOR UPDATE`，后到的事务要等前一个提交后重新取快照，才真正互斥。
 * 调用方必须在 `prisma.$transaction` 内调用，且本次占房在**同一事务**里落库。
 *
 * 归并同样是必需的：同一单两条随机档行各判一次会双双通过（它们都还没落库、彼此看不见）。
 * 加锁顺序按归并键排序，避免并发事务以不同顺序锁同一批档次造成死锁。
 */
/** 建单事务闸容忍的随机档超卖明细（按档次归并后逐组）。*/
export interface RandomTierOversellRecord {
  tier: number;
  violations: RandomTierFitViolation[];
}

export async function assertRandomTierStaysFitWithinTx(
  tx: Prisma.TransactionClient,
  stays: ReadonlyArray<ProspectiveHotelStay>,
  opts: { excludeOrderId?: string; maxOversellRooms?: number; buildMessage?: () => string } = {},
): Promise<RandomTierOversellRecord[]> {
  const dated = stays.filter(
    (s): s is ProspectiveHotelStay & { hotelCheckIn: Date; hotelCheckOut: Date } =>
      Boolean(s.hotelCheckIn && s.hotelCheckOut),
  );
  if (dated.length === 0) return [];

  // 占位酒店房型 → 档次：只对「有房型 id 且无显式 randomStarTier」的行查一次库。
  const placeholderLookupIds = [
    ...new Set(
      dated
        .filter((s) => s.randomStarTier == null && s.hotelRoomTypeId)
        .map((s) => s.hotelRoomTypeId as string),
    ),
  ];
  const placeholderTierByRoomTypeId = new Map<string, number>();
  if (placeholderLookupIds.length > 0) {
    const roomTypes = await tx.hotelRoomType.findMany({
      where: { id: { in: placeholderLookupIds } },
      select: { id: true, hotel: { select: { randomTierPlaceholder: true } } },
    });
    for (const rt of roomTypes) {
      if (rt.hotel.randomTierPlaceholder != null) {
        placeholderTierByRoomTypeId.set(rt.id, rt.hotel.randomTierPlaceholder);
      }
    }
  }

  type TierGroup = { tier: number; nightDates: string[]; rooms: number };
  const groups = new Map<string, TierGroup>();
  for (const stay of dated) {
    const tier =
      stay.randomStarTier ??
      (stay.hotelRoomTypeId ? placeholderTierByRoomTypeId.get(stay.hotelRoomTypeId) : undefined);
    // 具体酒店的真房型 → 不归这道闸管（走 assertHotelStaysFitWithinTx）。
    if (tier == null) continue;
    const nightDates = buildStayNightDates(stay.hotelCheckIn, stay.hotelCheckOut);
    // 空 = 区间非法/超长（buildStayNightDates 的防御）→ 无从校验，与既有口径一致不阻断。
    if (nightDates.length === 0) continue;
    // 首尾夜唯一确定整段（逐晚连续），可安全用作归并键。
    const key = `${tier}|${nightDates[0]}|${nightDates[nightDates.length - 1]}`;
    const rooms = stay.roomsBilled ?? 1;
    const existing = groups.get(key);
    if (existing) {
      existing.rooms = round2(existing.rooms + rooms);
    } else {
      groups.set(key, { tier, nightDates, rooms });
    }
  }

  const tolerated: RandomTierOversellRecord[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const violations = await assertRandomTierFitWithinTx(
      tx,
      group.tier,
      group.nightDates,
      group.rooms,
      opts,
    );
    if (violations.length > 0) tolerated.push({ tier: group.tier, violations });
  }
  return tolerated;
}

/**
 * 事务内酒店房量闸：把本次要落库的占房按「酒店 × 住宿区间」归并，逐组过一遍**带行锁**的
 * 物理房间前瞻闸（assertHotelPhysicalFitWithinTx）。装不下就抛 BadRequestError，整事务回滚。
 *
 * 为什么必须是事务内 + 行锁：前瞻闸本身是「查一遍 + 纯内存推算」的只读判定，两个请求同时抢
 * 最后 1 间会各自读到「还剩 1 间」的旧快照双双通过。带锁版先把该酒店该区间的包房周期行
 * `SELECT … FOR UPDATE`，后到的事务要等前一个提交后重新取快照，才真正互斥。
 *
 * 调用方必须满足（否则锁白加）：
 *   1. 在 `prisma.$transaction(async (tx) => { … })` 里调用，把同一个 `tx` 传进来；
 *   2. 本次占房（OrderItem 的 hotelRoomTypeId + hotelCheckIn/hotelCheckOut/roomsBilled）
 *      必须在**同一个事务**里写入 —— 行锁随事务提交才释放；
 *   3. 隔离级别用默认的 READ COMMITTED 即可。
 *
 * 归并口径：同一酒店、同一住宿区间的多条行合并成一笔前瞻占房（整间数相加、拼房客性别桶合并）。
 * 逐行各判一次会让「同单两条行各抢最后一间」双双通过 —— 它们都还没落库，彼此看不见对方。
 * 加锁顺序按归并键排序，避免并发事务以不同顺序锁同一批酒店造成死锁。
 *
 * 跳过两类行（都不是「真酒店的真房量」，不该拿具体酒店的库存去判）：
 *   · 房型查不到 —— 上游各自有 NotFoundError 负责报错，这里不抢它的活；
 *   · 房型挂在**随机档占位酒店**上（randomTierPlaceholder 非空）—— 那不是真房源，
 *     这类行走随机档聚合闸（assertRandomTierFit），与本闸互斥不重叠。
 */
/** 建单事务闸容忍的具体酒店超卖明细（按酒店×区间归并后逐组）。*/
export interface HotelStayOversellRecord {
  hotelId: string;
  violations: PhysicalFitViolation[];
}

export async function assertHotelStaysFitWithinTx(
  tx: Prisma.TransactionClient,
  stays: ReadonlyArray<ProspectiveHotelStay>,
  passengers: ReadonlyArray<{ gender?: 'M' | 'F' | 'X' }> | undefined,
  opts: { excludeOrderId?: string; maxOversellRooms?: number; buildMessage?: () => string } = {},
): Promise<HotelStayOversellRecord[]> {
  const rows = stays.filter(
    (s): s is ProspectiveHotelStay & {
      hotelRoomTypeId: string;
      hotelCheckIn: Date;
      hotelCheckOut: Date;
    } => Boolean(s.hotelRoomTypeId && s.hotelCheckIn && s.hotelCheckOut),
  );
  if (rows.length === 0) return [];

  const roomTypes = await tx.hotelRoomType.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.hotelRoomTypeId))] } },
    select: { id: true, hotelId: true, hotel: { select: { randomTierPlaceholder: true } } },
  });
  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt]));

  type FitGroup = {
    hotelId: string;
    nightDates: string[];
    wholeRooms: number;
    solos: Array<'M' | 'F' | 'U'>;
  };
  const groups = new Map<string, FitGroup>();
  for (const row of rows) {
    const roomType = roomTypeById.get(row.hotelRoomTypeId);
    if (!roomType || roomType.hotel.randomTierPlaceholder != null) continue;
    const nightDates = buildStayNightDates(row.hotelCheckIn, row.hotelCheckOut);
    // 空 = 区间非法/超长（buildStayNightDates 的防御）→ 无从校验，与既有口径一致不阻断。
    if (nightDates.length === 0) continue;
    // 首尾夜唯一确定整段（逐晚连续），可安全用作归并键。
    const key = `${roomType.hotelId}|${nightDates[0]}|${nightDates[nightDates.length - 1]}`;
    const prospective = toProspectiveOccupancy(row.roomsBilled ?? 1, passengers);
    const existing = groups.get(key);
    if (existing) {
      existing.wholeRooms += prospective.wholeRooms;
      existing.solos.push(...prospective.solos);
    } else {
      groups.set(key, {
        hotelId: roomType.hotelId,
        nightDates,
        wholeRooms: prospective.wholeRooms,
        solos: [...prospective.solos],
      });
    }
  }

  const tolerated: HotelStayOversellRecord[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const violations = await assertHotelPhysicalFitWithinTx(
      tx,
      group.hotelId,
      group.nightDates,
      { wholeRooms: group.wholeRooms, solos: group.solos },
      {
        excludeOrderId: opts.excludeOrderId,
        maxOversellRooms: opts.maxOversellRooms,
        // 不传 → 用 assertHotelPhysicalFit 自带的带数字文案（后台录单要看得见差多少间）；
        // 对外可达的端点（前台下单）显式传中性话术，别把包房间数回给客人。
        buildMessage: opts.buildMessage,
      },
    );
    if (violations.length > 0) tolerated.push({ hotelId: group.hotelId, violations });
  }
  return tolerated;
}

/**
 * 星级随机档行的成本快照来源：取**同星级酒店**覆盖入住首晚的包房周期切房单价（CNY/间/晚）里
 * 的最高价。随机档行没有具体房型可查价，切房单价就是我们付给酒店的真实每间每晚成本
 * —— 与具体酒店行取 HotelRoomType.costPriceCny 语义一致（都是成本侧，售价另说）。
 *
 * 为什么取**最高**而不是平均/最低：这单最终会被房控落到该星级里的**某一家**酒店，落到哪家
 * 下单这一刻并不知道。取最高 = 最坏情况成本，毛利宁可报低不报高（与「产品未录成本就留空、
 * 绝不落 0 虚高」同一取向）。同一家酒店有多条周期覆盖该晚时，取其有价周期中 dateFrom 最晚
 * 的一条（"最新一次切房的价"，与销控板 unitPrice 展示口径一致）。
 *
 * 该星级一家酒店都没切房 / 都没填价 → undefined（毛利显示「未知」，不落 0 虚高）。
 * 注：不读存量的随机档池周期 —— 随机档已改为同星级酒店的派生聚合，那份数据只留作审计。
 */
async function resolveRandomTierNightlyCost(
  randomStarTier: number,
  checkIn: string,
): Promise<number | undefined> {
  const d = new Date(`${checkIn}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  const periods = await prisma.hotelBlockPeriod.findMany({
    where: {
      // 与 hotel-control 的档次口径同源：星级命中、排除国际五星与占位酒店
      // （占位酒店不是真房源，它名下的切房单价不是任何真实成本）。
      hotel: { starRating: randomStarTier, intlFiveStar: false, randomTierPlaceholder: null },
      dateFrom: { lte: d },
      dateTo: { gte: d },
      unitPrice: { not: null },
    },
    orderBy: { dateFrom: 'desc' },
    select: { hotelId: true, unitPrice: true },
  });
  // 每家酒店只认其最新一条有价周期（findMany 已按 dateFrom 倒序 → 首次见到的即最新）
  const latestByHotel = new Map<string, number>();
  for (const p of periods) {
    if (!p.hotelId || p.unitPrice == null || latestByHotel.has(p.hotelId)) continue;
    const price = Number(p.unitPrice.toString());
    if (Number.isFinite(price)) latestByHotel.set(p.hotelId, price);
  }
  if (latestByHotel.size === 0) return undefined;
  return Math.max(...latestByHotel.values());
}

/**
 * 团队议价结算价按航段分摊（A9）。
 *
 * `settlementPriceCny` 是「每位出行人**整程**价」，不是「每人每段价」。往返单有两条 FLIGHT 行，
 * 逐行各写满价会把每人收两遍（填 3600 往返 → 每人实收 7200）。这里把整程价切成各段的每人价，
 * **各段之和恰好等于整程价**（按分为单位分配，除不尽的余数全部给第一段），
 * 与结算价日历「去程价 + 回程价求和 = 每人整程价」的口径一致。
 *
 * legCount ≤ 1（单程 / 无航段）→ 原样返回整程价，行为与修正前完全一致。
 * 导出供单测直接断言金额。
 */
export function splitSettlementPriceAcrossLegs(
  pricePerPersonCny: number,
  legCount: number,
): number[] {
  if (!Number.isFinite(pricePerPersonCny) || legCount <= 0) return [];
  if (legCount === 1) return [round2(pricePerPersonCny)];
  const totalCents = Math.round(pricePerPersonCny * 100);
  const baseCents = Math.floor(totalCents / legCount);
  const remainderCents = totalCents - baseCents * legCount;
  return Array.from({ length: legCount }, (_, i) =>
    // 余数全给第一段：合计精确等于整程价，且不会出现「每段都多一分」的累积漂移。
    ((i === 0 ? baseCents + remainderCents : baseCents) / 100),
  );
}

/**
 * 套餐「地面部分」权威价（CNY，整数，≥0）—— 录单与售后改档共用的单一口径。
 *
 *   HOTEL 组件（qty=晚数）  = 每间每晚价 × qty × rooms  → 套餐价随房间数涨；
 *     每间每晚价 = linkedHotelNightlyPrice（套餐绑定房型的 basePrice，服务端权威）优先，
 *     回退 components JSON 里的 unitPrice（未绑房型的老套餐才会走到）。
 *     绝不无条件信任 JSON 里的 unitPrice：历史上那可能是占位/过时的畸低值，
 *     会把套餐酒店部分算成几元、整单总价崩塌。
 *   VISA 组件           = 每份单价 × 办签人数（visaHeadCount，已扣自备签人数）。
 *   TRANSFER 等其它组件  = qty × unitPrice（整车/整趟计价，不随人数缩放）。
 *   FLIGHT 组件不计      = 机票由 FLIGHT 行单独动态定价。
 *
 * 套餐折扣（percent-off）不在此扣 —— 由调用方在行金额层统一处理。
 */
export function computeBundleGroundTotal(input: {
  /** Bundle.items（JSON）；非数组一律按空处理，绝不因脏数据抛错。 */
  components: unknown;
  linkedHotelNightlyPrice: number | null;
  rooms: number;
  visaHeadCount: number;
}): number {
  const components = Array.isArray(input.components)
    ? (input.components as Array<{ kind: string; qty: number; unitPrice: number }>)
    : [];
  const groundTotal = components
    .filter((b) => b && b.kind !== 'FLIGHT')
    .reduce((s, b) => {
      if (b.kind === 'HOTEL') {
        const nightlyPrice = input.linkedHotelNightlyPrice ?? b.unitPrice;
        return s + b.qty * nightlyPrice * input.rooms;
      }
      if (b.kind === 'VISA') {
        // 每份签证单价（unitPrice 写入时已由 products.service 覆盖为 Visa.basePrice/人）× 办签人数。
        return s + input.visaHeadCount * b.unitPrice;
      }
      // TRANSFER 等：固定 qty×unitPrice（整车/整趟计价，按趟不按人头，不随人数缩放）。
      return s + b.qty * b.unitPrice;
    }, 0);
  return Math.max(0, Math.round(groundTotal));
}

export function resolveBundleHotelStamp(
  bundle: { hotelRoomTypeId: string | null },
  metadata: Record<string, unknown> | undefined,
  nights: number,
): { hotelRoomTypeId: string; hotelCheckIn: Date; hotelCheckOut: Date } | null {
  if (!bundle.hotelRoomTypeId) return null;
  const meta = bundleItemMetadataSchema.parse(metadata ?? {});
  if (!meta.goDate) return null;
  const checkIn = new Date(meta.goDate);
  if (Number.isNaN(checkIn.getTime())) return null;
  const safeNights = Math.max(1, Math.trunc(nights));
  const returnDate = meta.returnDate ? new Date(meta.returnDate) : null;
  const checkOut =
    returnDate && !Number.isNaN(returnDate.getTime()) && returnDate.getTime() > checkIn.getTime()
      ? returnDate
      : new Date(checkIn.getTime() + safeNights * DAY_MS);
  return {
    hotelRoomTypeId: bundle.hotelRoomTypeId,
    hotelCheckIn: checkIn,
    hotelCheckOut: checkOut,
  };
}

// ── 套餐可选升级 add-on 重算（server-priced）─────────────────────────
/** 写到订单行 metadata.addOns 的升级重算明细（金额单位 CNY，整数）。 */
export interface BundleAddOnBreakdown {
  singleCount: number; // 选「一个人住酒店（单人入住）」的人数
  /**
   * 选「升舱商务」的人数（整程口径，= max(去程, 回程)）。
   * 旧字段保留供既有展示/导出读取；真正的每程人数看下面两个分程字段。
   */
  businessCount: number;
  businessCountOutbound: number; // 去程升舱人数（占去程班次的真实商务舱座位）
  businessCountReturn: number; // 回程升舱人数（单程套餐 legs=1 时恒为 0）
  // 占座模型（业务需求）：成人 / 占座儿童 / 不占座婴儿
  adultCount: number; // 成人数（占座、占房）
  childCount: number; // 占座儿童数（占座、占房；机票按成人价减折扣）
  infantCount: number; // 不占座婴儿数（不占座、不占房；按婴儿价收）
  seatPax: number; // 占座人数 = adultCount + childCount（拼房按此计房；businessCount ≤ seatPax）
  headCount: number; // 全部出行人 = adultCount + childCount + infantCount（都需护照）
  rooms: number; // 拼房间数 = ceil(seatPax / 2)（婴儿不占房）
  nights: number; // 计费晚数（用于单人入住房差）
  legs: number; // 计费航段数（用于升舱商务）
  singleSupplementCnyPerNight: number; // 该套餐配置的单人入住房差/晚
  businessUpgradeCnyPerLeg: number; // 该套餐配置的升舱/航段
  childSeatDiscountCnyPerPerson: number; // 该套餐配置的占座儿童折扣/人
  infantPriceCny: number; // 该套餐配置的婴儿价/人
  selfProvidedVisaCount: number; // 自备签证（自行办妥签证）人数：乘客级勾选数 / 旧整单布尔 → 1
  selfProvidedVisa: boolean; // 是否有自备签证乘客（= selfProvidedVisaCount > 0；向后兼容展示用）
  selfVisaDeductCny: number; // 该套餐配置的自备签证减免/人
  singleSupplementTotal: number; // = singleCount × rate × nights
  // 分程口径 = (去程人数 + 回程人数) × rate；旧整程口径 = businessCount × rate × legs
  businessUpgradeTotal: number;
  childSeatDiscountTotal: number; // = childCount × childSeatDiscountCnyPerPerson（机票折扣，负向计入套餐行）
  infantPriceTotal: number; // = infantCount × infantPriceCny（婴儿机票价，正向计入套餐行）
  selfVisaDeductTotal: number; // = selfProvidedVisaCount × selfVisaDeductCny（自备签证减免，负向计入套餐行）
  total: number; // 升级加价 + 婴儿价 − 儿童折扣 − 自备签证减免 的净额（计入套餐行总额）
}

/**
 * 套餐占座模型归一化（纯函数，向后兼容）。
 * 优先用订单行显式三计数；缺省时用 metadata.adultCount/childCount/infantCount；
 * 若三者都没有，则把旧的 pax（metadata.pax）或行 quantity 视为 adultCount（child/infant = 0），
 * 保证旧客户端/旧订单的占座 + 定价与扩展前完全一致。
 *
 * 导出供单测与 createOrder 共用。
 */
export interface BundleOccupancyInput {
  adultCount?: number;
  childCount?: number;
  infantCount?: number;
  quantity?: number;
  metadata?: Record<string, unknown>;
}
export interface BundleOccupancy {
  adultCount: number;
  childCount: number;
  infantCount: number;
  seatPax: number; // adult + child（占座）
  headCount: number; // adult + child + infant（出行人）
  rooms: number; // ceil(seatPax / 2)
}
export function resolveBundleOccupancy(item: BundleOccupancyInput): BundleOccupancy {
  const meta = bundleItemMetadataSchema.parse(item.metadata ?? {});
  const norm = (v: number | undefined): number | undefined =>
    v == null ? undefined : Math.max(0, Math.trunc(v));
  // 显式行字段优先，其次 metadata 字段
  const adultExplicit = norm(item.adultCount) ?? norm(meta.adultCount);
  const childExplicit = norm(item.childCount) ?? norm(meta.childCount);
  const infantExplicit = norm(item.infantCount) ?? norm(meta.infantCount);
  const hasExplicit =
    adultExplicit != null || childExplicit != null || infantExplicit != null;

  let adultCount: number;
  let childCount: number;
  let infantCount: number;
  if (hasExplicit) {
    adultCount = adultExplicit ?? 0;
    childCount = childExplicit ?? 0;
    infantCount = infantExplicit ?? 0;
  } else {
    // 向后兼容：旧 pax（metadata.pax）或行 quantity → 全部当成成人
    adultCount = Math.max(0, Math.trunc(meta.pax ?? item.quantity ?? 0));
    childCount = 0;
    infantCount = 0;
  }
  const seatPax = adultCount + childCount;
  const headCount = adultCount + childCount + infantCount;
  const rooms = Math.ceil(seatPax / 2); // 每人 0.5 间；婴儿不占房（旧拼房口径，展示用）
  return { adultCount, childCount, infantCount, seatPax, headCount, rooms };
}

// ── 按房型容量算所需房间数（C-v2 核心）────────────────────────────────
/**
 * 业务口径："每个酒店房型可以 fit 几大人几小孩；选的人数一间房坐不下时，自动加房。"
 * 外加："选了单人入住的人，每人自己独占一间"——独住的人不跟别人挤，也不占别人的床位。
 *
 *   soloRooms   = clamp(singleCount, 0, 成人数)          // 独住者每人 1 间
 *   sharedAdults= 成人数 − soloRooms                      // 其余成人才参与拼间
 *   roomsNeeded = max( soloRooms + max( ceil(sharedAdults / maxAdults),
 *                                       ceil(占座儿童 / maxChildren) ), 1 )
 *
 * - 婴儿不占床 → 不参与计算。
 * - maxChildren=0 且有占座儿童时：把儿童并入成人维度 ceil((sharedAdults+child)/maxAdults)
 *   近似（避免除 0；lone-child packing edge case）。正常配置 maxChildren≥1 不会走到这里。
 * - 套餐没绑房型 / 容量缺失 → 回退默认 2大1小（等价旧 ceil(seatPax/2)-ish 行为）。
 * - singleCount 缺省 0 → 结果与加入该维度之前完全一致（老调用方零影响）。
 *
 * 口径变更记录（原口径：singleCount **不**计入 roomsNeeded，仅作为独立自愿加价项）：
 *   原口径下「2 位成人都勾单人入住」= 1 间 —— 但两个人各自独住物理上就是要 2 间，
 *   房量校验会据此少算、导致超卖，且这个 roomsNeeded 正是喂给物理房间前瞻闸的整间数输入，
 *   输入错了闸再准也白搭。故按「独住者各占一间」修正。
 *   单人入住房差（singleSupplementCnyPerNight × singleCount × nights）仍是**独立**加价项，
 *   由 computeBundleAddOn 另算，与本函数的间数互不重复计价。
 *   仅对新单生效：不回填存量单的 roomsBilled / total。
 *
 * 导出供单测与 createOrder 共用。
 */
export const DEFAULT_ROOM_MAX_ADULTS = 2;
export const DEFAULT_ROOM_MAX_CHILDREN = 1;
export function computeRoomsNeeded(
  occupancy: Pick<BundleOccupancy, 'adultCount' | 'childCount'>,
  capacity: { maxAdults?: number | null; maxChildren?: number | null } | null,
  singleCount = 0,
): number {
  const maxAdults = Math.max(1, Math.trunc(capacity?.maxAdults ?? DEFAULT_ROOM_MAX_ADULTS));
  const maxChildrenRaw = Math.trunc(capacity?.maxChildren ?? DEFAULT_ROOM_MAX_CHILDREN);
  const adults = Math.max(0, occupancy.adultCount);
  const children = Math.max(0, occupancy.childCount);
  // 独住人数夹到 [0, 成人数]：单人入住是成人维度的选项，不能超过成人数、也不能为负。
  const soloRooms = Math.min(Math.max(0, Math.trunc(singleCount)), adults);
  const sharedAdults = adults - soloRooms;

  const adultRooms = Math.ceil(sharedAdults / maxAdults);
  // maxChildren=0 → 该房型不单独承载儿童；把儿童并入成人维度（lone-child packing edge case）。
  const childRooms =
    maxChildrenRaw > 0
      ? Math.ceil(children / maxChildrenRaw)
      : Math.ceil((sharedAdults + children) / maxAdults);
  // 独住间与「其余人拼出来的间」相加；整单至少 1 间（0 成人 0 儿童的兜底，与旧口径一致）。
  return Math.max(soloRooms + Math.max(adultRooms, childRooms), 1);
}

// ── 物理房间前瞻闸的输入翻译（床位/计费口径 → 物理口径）─────────────────────
/**
 * 把「本单酒店部分要新增的占房」翻译成物理房间前瞻闸的输入（ProspectiveOccupancy）。
 *
 *   roomsCharged === 0.5（单人拼房；床位/计费口径的半间）→ 1 位拼房客，按性别进桶配对；
 *   其余                                                → 整间数（向上取整防御脏小数），不进拼房桶。
 *
 * 性别口径与房控 pickSoloGender 严格一致（下单后这一单就是被那套口径数进销控板的，
 * 两边必须同一口径，否则闸放行的单会在看板上变成超卖）：
 *   取第一位性别为 M/F 的出行人；X / 未填 / 无出行人 → 'U' —— 保守口径每人独占 1 间，
 *   即「拼单性别未知就把它单独出来」，不参与自动配对。
 *
 * 导出供单测与 createOrder 共用。
 */
export function toProspectiveOccupancy(
  roomsCharged: number,
  passengers: ReadonlyArray<{ gender?: 'M' | 'F' | 'X' }> | undefined,
): ProspectiveOccupancy {
  if (roomsCharged === 0.5) {
    const explicit = passengers?.find((p) => p.gender === 'M' || p.gender === 'F')?.gender;
    return { wholeRooms: 0, solos: [explicit === 'M' || explicit === 'F' ? explicit : 'U'] };
  }
  return { wholeRooms: Math.max(0, Math.ceil(roomsCharged)), solos: [] };
}

// ── 套餐酒店计费房间数（server-authoritative；含单人拼房 0.5 间口径）──────────
/**
 * 计算套餐酒店部分应计费的房间数（钱路径，权威计算，不轻信客户端）。
 *
 * 业务口径：一个人报套餐（1 成人 / 0 儿童，婴儿不占房）且**不**独住时，愿意拼房共用一间，
 * 只按 0.5 间收费（床位口径）；独住（singleCount ≥ 1）则照旧收整间 + 单人入住房差。
 * 2 人及以上、或含占座儿童 → 沿用 computeRoomsNeeded 的容量口径（不变）。
 *
 *   isSoloSharing = 绑了套餐房型 且 adultCount===1 且 childCount===0 且 singleCount(缺省0)===0
 *   roomsCharged  = isSoloSharing ? 0.5 : physicalRooms(容量推算)
 *
 * 仅对绑定套餐房型（hotelRoomTypeId 存在）生效；未绑房型的老套餐不走 0.5 口径。
 *
 * server-authoritative：客户端传的 roomsBilled 只能「上调」不能「下压」——最终取
 * max(clientRooms, roomsCharged)。这样单人拼房单不会被 2 人单伪造成 0.5 间少付钱，
 * 同时保留「录单方主动多开房」等向上调整的向后兼容能力。
 *
 * 导出供单测与 createOrder BUNDLE 分支共用（同一份权威口径，避免漂移）。
 */
export function computeBundleRoomsCharged(params: {
  occupancy: Pick<BundleOccupancy, 'adultCount' | 'childCount'>;
  capacity: { maxAdults?: number | null; maxChildren?: number | null } | null;
  hotelRoomTypeId: string | null;
  singleCount: number | undefined;
  clientRoomsBilled: number | undefined;
}): number {
  const { occupancy, capacity, hotelRoomTypeId, singleCount, clientRoomsBilled } = params;
  // singleCount 传进容量口径：独住者各占一间（见 computeRoomsNeeded 的口径变更记录）。
  // 不会与下方 isSoloSharing 重复加间——isSoloSharing 恒要求 singleCount===0。
  const physicalRooms = computeRoomsNeeded(occupancy, capacity, singleCount);
  const isSoloSharing =
    hotelRoomTypeId != null &&
    occupancy.adultCount === 1 &&
    occupancy.childCount === 0 &&
    (singleCount ?? 0) === 0;
  const roomsCharged = isSoloSharing ? 0.5 : physicalRooms;
  // 权威下限：客户端只能上调、不能下压（防止把多人单伪造成 0.5 间）。
  if (clientRoomsBilled != null) {
    return Math.max(clientRoomsBilled, roomsCharged);
  }
  return roomsCharged;
}

/**
 * 套餐升级加价权威重算（不信任客户端金额）。公式：
 *   nights = stamp 推导的入住晚数（无房型 → hotelNights ?? 1）
 *   legs   = bundle.legs（来回默认 2）
 *   单人入住房差 = singleCount × singleSupplementCnyPerNight × nights
 *   升舱商务加价 = 分程口径（去程人数 + 回程人数）× businessUpgradeCnyPerLeg
 *                 旧整程口径（businessCount 为数字）沿用 businessCount × businessUpgradeCnyPerLeg × legs
 *   自备签证减免 = selfProvidedVisaCount × selfVisaDeductCny（自行办妥签证的人数，从套餐行扣减）
 * singleCount / businessCount / selfProvidedVisaCount 缺省 0 → total=0 → 套餐价与旧版完全一致（向后兼容）。
 *
 * 升舱分程（去程/回程可以升不同人数）：第 4 个参数传对象 `{ outbound, return }` 即分程口径；
 * 传数字/缺省 = 旧整程口径（每程同人数，× legs），公式原样保留，历史入参重算结果一分不差。
 * 单程套餐（legs=1）下回程人数恒按 0 处理 —— 没有回程航段可占座，也就不该收回程升舱费。
 *
 * selfProvidedVisaCount 语义（两种模式，调用处 priceAndValidateItems 决定 count）：
 *   · 旧整单口径：录单勾「客人自备签证」布尔 true → count=1（整单减一次 −selfVisaDeductCny）。
 *   · 新乘客级：同一订单各乘客各选 → count=勾「自备签」的人数（每人减一次）。
 * count 夹到 [0, headCount]（自备签是按人的，最多全体出行人）。
 *
 * 导出仅供单测使用。
 */
/**
 * 套餐每人操作费总额（服务端权威，不信客户端）。
 *   操作费 = max(0, trunc(operationFeeCny)) × seatPax（占座人数：成人 + 占座儿童；婴儿不收）
 * operationFeeCny 由 Bundle.operationFeeCny 提供（DB @default(20)，运营可在套餐向导改）；
 * 负值/小数夹到非负整数。计入套餐地面金额，随 discountPct 一并 percent-off，与起价把操作费
 * 计入 originalPerPaxCny 原价再打折的口径一致。导出仅供单测使用。
 */
export function computeBundleOperationFeeTotal(operationFeeCny: number, seatPax: number): number {
  // Number(x)||0 兜底：DB 有 @default(20) 保证非空，但防御旧数据/未选字段导致的 undefined→NaN。
  const perPax = Math.max(0, Math.trunc(Number(operationFeeCny) || 0));
  const pax = Math.max(0, Math.trunc(Number(seatPax) || 0));
  return perPax * pax;
}

/**
 * 套餐乘客级「住宿方式 + 签证」派生（纯函数，向后兼容）。
 *
 * 购物车模式：同一订单每人各选自己的住宿方式（拼房/单住）与签证（随套餐/自备签），价差全部系统算。
 * 优先级（两维各自独立判定，互不干扰）：
 *   · 自备签：passengers 里任一乘客显式提供 visaExempt（true/false 均算「提供」）→ 以勾 true 的人数为权威；
 *            否则回落 item.selfProvidedVisa 布尔（旧整单口径 true → 记 1 次，整单减一次）。
 *   · 单住：  passengers 里任一乘客显式提供 singleRoom → 以勾 true 的人数为权威；
 *            否则回落 item.singleCount（旧 item 级聚合口径）。
 * passengers 缺省（老客户端不传）→ 全部回落旧口径，定价与扩展前完全一致。
 *
 * 导出供单测与 createOrder/quoteOrder 的 priceAndValidateItems BUNDLE 分支共用。
 */
export function derivePerPaxBundleOptions(
  item: { selfProvidedVisa?: boolean; singleCount?: number },
  passengers: ReadonlyArray<{ visaExempt?: boolean; singleRoom?: boolean }> | undefined,
): { selfProvidedVisaCount: number; singleCount: number | undefined } {
  const paxVisaProvided = passengers?.some((px) => px.visaExempt !== undefined) ?? false;
  const paxSingleProvided = passengers?.some((px) => px.singleRoom !== undefined) ?? false;
  const selfProvidedVisaCount = paxVisaProvided
    ? (passengers?.filter((px) => px.visaExempt === true).length ?? 0)
    : (item.selfProvidedVisa === true ? 1 : 0);
  const singleCount = paxSingleProvided
    ? (passengers?.filter((px) => px.singleRoom === true).length ?? 0)
    : item.singleCount;
  return { selfProvidedVisaCount, singleCount };
}

/**
 * 套餐升舱差价单一配置源解析（¥/程/座；纯函数，导出供单测与 createOrder/quoteOrder 共用）。
 *   · 套餐 businessUpgradeCnyPerLeg 非 null（含 0）→ 套餐自有覆盖，直接用。
 *   · null =「跟随航班」→ 取该套餐绑定航班的每程差价：去程优先、回程次之
 *     （往返同程对称，computeBundleAddOn 再 × legs 得总加价）。
 *   · 两趟都没绑到航班（或未 include）→ 兜底 DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG，绝不派生出 0/裸价。
 */
export function resolveBundleBusinessUpgradeRate(bundle: {
  businessUpgradeCnyPerLeg: number | null;
  outboundFlight?: { businessUpgradeCnyPerLeg: number } | null;
  returnFlight?: { businessUpgradeCnyPerLeg: number } | null;
}): number {
  return (
    bundle.businessUpgradeCnyPerLeg ??
    bundle.outboundFlight?.businessUpgradeCnyPerLeg ??
    bundle.returnFlight?.businessUpgradeCnyPerLeg ??
    DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG
  );
}

/** 升舱分程人数（去程 / 回程各自的升舱人数）。 */
export interface BundleBusinessUpgradeSplit {
  outbound?: number;
  return?: number;
}

/**
 * BUNDLE 行入参 → computeBundleAddOn 的升舱口径（纯函数，导出供单测与定价分支共用）。
 *   · 分程字段任一显式提供（含 0）→ 分程口径 `{ outbound, return }`；
 *   · 两者都省略 → 回落旧的整程 businessCount（数字/undefined），定价与扩展前完全一致。
 * 「显式 0」必须走分程分支：只升去程（回程 0）正是本次要支持的场景，落到旧口径会按两程都升收钱。
 */
export function resolveBundleBusinessUpgradeInput(item: {
  businessCount?: number;
  businessCountOutbound?: number;
  businessCountReturn?: number;
}): number | BundleBusinessUpgradeSplit | undefined {
  if (item.businessCountOutbound !== undefined || item.businessCountReturn !== undefined) {
    return { outbound: item.businessCountOutbound, return: item.businessCountReturn };
  }
  return item.businessCount;
}

export function computeBundleAddOn(
  bundle: {
    hotelNights: number | null;
    singleSupplementCnyPerNight: number;
    businessUpgradeCnyPerLeg: number;
    childSeatDiscountCnyPerPerson: number;
    infantPriceCny: number;
    selfVisaDeductCny: number;
    legs: number;
  },
  hotelStamp: { hotelCheckIn: Date; hotelCheckOut: Date } | null,
  singleCount: number | undefined,
  /**
   * 升舱人数。数字/缺省 = 旧整程口径（每程同人数，× legs 计价）；
   * 对象 = 分程口径（去程 / 回程各自的人数，合计 × 每程差价）。
   */
  businessCount: number | BundleBusinessUpgradeSplit | undefined,
  occupancy: BundleOccupancy,
  /** 调用方按 resolveBundleNights 解析的单一权威晚数（无盖章时的回退口径）。 */
  resolvedNights: number,
  /**
   * 自备签证（出行人自行办妥签证）人数 → 每人从套餐行扣减 selfVisaDeductCny。缺省 0。
   * 旧整单布尔口径由调用处归一化为 count（true → 1）；新乘客级口径为勾选人数。
   */
  selfProvidedVisaCount?: number,
): { total: number; hasAddOn: boolean; breakdown: BundleAddOnBreakdown } {
  const single = Math.max(0, Math.trunc(singleCount ?? 0));
  // 自备签人数：夹到 [0, headCount]（按人减免，最多全体出行人）。旧整单布尔已在调用处归一化为 0/1。
  const selfVisaCount = Math.min(
    Math.max(0, Math.trunc(selfProvidedVisaCount ?? 0)),
    occupancy.headCount,
  );
  // 计费晚数：优先用盖章推导的真实入住区间，否则回退套餐默认晚数（≥1）
  const nights = hotelStamp
    ? Math.max(
        1,
        Math.round((hotelStamp.hotelCheckOut.getTime() - hotelStamp.hotelCheckIn.getTime()) / DAY_MS),
      )
    : Math.max(1, resolvedNights);
  const legs = Math.max(1, bundle.legs);
  const singleRate = Math.max(0, bundle.singleSupplementCnyPerNight);
  const businessRate = Math.max(0, bundle.businessUpgradeCnyPerLeg);
  const childDiscountRate = Math.max(0, bundle.childSeatDiscountCnyPerPerson);
  const infantRate = Math.max(0, bundle.infantPriceCny);
  const selfVisaRate = Math.max(0, bundle.selfVisaDeductCny);

  // 升舱人数：两种口径共用同一个夹逼（≤ 占座人数；婴儿不占座、不能升舱）。
  //   · 分程口径（对象）：去/回程各自夹逼，总加价 = (去 + 回) × 每程差价；
  //     单程套餐 legs=1 → 回程恒 0（没有回程航段可占座，也不该收回程升舱费）。
  //   · 整程口径（数字/缺省）：**原公式一字不动**（人数 × 每程差价 × legs），历史入参重算结果一分不差；
  //     分程字段按「每程同人数」派生，供占座拆分与明细文案使用（legs=1 时回程仍为 0）。
  const clampSeat = (n: number | undefined): number =>
    Math.min(Math.max(0, Math.trunc(n ?? 0)), occupancy.seatPax);
  const isSplitInput = typeof businessCount === 'object' && businessCount !== null;
  const businessOutbound = clampSeat(isSplitInput ? businessCount.outbound : businessCount);
  const businessReturn =
    legs >= 2 ? clampSeat(isSplitInput ? businessCount.return : businessCount) : 0;
  // 旧展示字段（整程口径的「升舱人数」）：取两程较大值 —— 旧入参两程同值时与旧版完全一致。
  const business = Math.max(businessOutbound, businessReturn);

  const singleSupplementTotal = single * singleRate * nights;
  const businessUpgradeTotal = isSplitInput
    ? (businessOutbound + businessReturn) * businessRate
    : business * businessRate * legs;
  // 占座儿童机票按成人价减折扣 → 套餐行净减 childCount × 折扣
  const childSeatDiscountTotal = occupancy.childCount * childDiscountRate;
  // 不占座婴儿机票收婴儿价（不走经济舱全价）→ 套餐行净加 infantCount × 婴儿价
  const infantPriceTotal = occupancy.infantCount * infantRate;
  // 自备签证：自行办妥签证的人数 × 每人减免（乘客级各减一次；旧整单口径 count=1 即整单减一次）
  const selfVisaDeductTotal = selfVisaCount * selfVisaRate;
  // 升级加价 + 婴儿价 − 儿童折扣 − 自备签证减免。
  // 加项净额**允许为负**：自备签/儿童折扣可以大于其它加价，甚至在无任何其它加价时单独存在。
  // 绝不在此「加项净额」层夹到 0——否则减免只能抵扣其它加价、无加价时一分不减（把套餐行整体价算高）。
  // 非负保护下沉到 BUNDLE 行金额层（unitPrice×qty + total + 操作费）再统一夹到 0，减免可正常抵扣套餐地面价。
  const total =
    singleSupplementTotal +
    businessUpgradeTotal +
    infantPriceTotal -
    childSeatDiscountTotal -
    selfVisaDeductTotal;

  return {
    total,
    // 任一占座升级或儿童/婴儿差价 / 自备签证减免存在 → 视为有 add-on（落 metadata 供运营/财务查看）
    hasAddOn:
      single > 0 ||
      business > 0 ||
      childSeatDiscountTotal > 0 ||
      infantPriceTotal > 0 ||
      selfVisaDeductTotal > 0,
    breakdown: {
      singleCount: single,
      businessCount: business,
      businessCountOutbound: businessOutbound,
      businessCountReturn: businessReturn,
      adultCount: occupancy.adultCount,
      childCount: occupancy.childCount,
      infantCount: occupancy.infantCount,
      seatPax: occupancy.seatPax,
      headCount: occupancy.headCount,
      rooms: occupancy.rooms,
      nights,
      legs,
      singleSupplementCnyPerNight: singleRate,
      businessUpgradeCnyPerLeg: businessRate,
      childSeatDiscountCnyPerPerson: childDiscountRate,
      infantPriceCny: infantRate,
      selfProvidedVisaCount: selfVisaCount,
      selfProvidedVisa: selfVisaCount > 0,
      selfVisaDeductCny: selfVisaRate,
      singleSupplementTotal,
      businessUpgradeTotal,
      childSeatDiscountTotal,
      infantPriceTotal,
      selfVisaDeductTotal,
      total,
    },
  };
}

/**
 * 出行人数校验口径（纯函数，与前台 CheckoutPage 的 effectivePax 同源）。
 *
 * 同一批出行人会出现在多条订单行里 —— 往返机票拆成去/回两条 FLIGHT 行（各 quantity=pax），
 * 套餐 / 签证 / 接送也都是「按人」的产品。所需出行人数应是「单程最大人数」，不是各行相加：
 *   - FLIGHT：取各行 quantity 的 MAX（往返同一批人，绝不两段相加）
 *   - BUNDLE：每行 pax 取自 metadata.pax（缺失回退 quantity），多份套餐相加
 *   - VISA / TRANSFER：每行 quantity 相加
 *   - required = max(maxFlightLegQty, bundlePax, visaQty, transferPax)
 * 任一维度为 0 时不约束（required 仍由其余维度决定）；全为 0（无按人产品）→ 返回 0，不校验。
 *
 * 导出供单测与 createOrder 共用。
 */
export function computeRequiredPassengerCount(items: OrderItemInput[]): number {
  let maxFlightLegQty = 0;
  let bundlePax = 0;
  let visaQty = 0;
  let transferPax = 0;

  for (const item of items) {
    if (item.kind === 'FLIGHT') {
      // 往返两段共享乘客 → 取最大单段人数，不累加
      maxFlightLegQty = Math.max(maxFlightLegQty, item.quantity);
    } else if (item.kind === 'BUNDLE') {
      // 套餐出行人数 = 占座模型 headCount（成人 + 占座儿童 + 不占座婴儿，都需护照）。
      // 婴儿不占座但是出行人：FLIGHT 行 quantity = seatPax（占座），required 校验按 headCount。
      // 向后兼容：无三计数时把旧 pax / 行 quantity 当成全成人 → headCount = 旧 pax，结论与旧版一致。
      const occupancy = resolveBundleOccupancy({
        adultCount: item.adultCount,
        childCount: item.childCount,
        infantCount: item.infantCount,
        quantity: item.quantity,
        metadata: item.metadata,
      });
      bundlePax += occupancy.headCount;
    } else if (item.kind === 'VISA') {
      visaQty += item.quantity;
    } else if (item.kind === 'TRANSFER') {
      transferPax += item.quantity;
    }
  }

  return Math.max(maxFlightLegQty, bundlePax, visaQty, transferPax);
}

// ── 售后改单：座位搬移 + 费用流水（事务内复用 createOrder/状态机的同款口径）──

/**
 * 事务内原子「拿座」（CAS，最终防超售）—— 与 createOrder 的 decrementSeat 同款保证。
 *   UPDATE ... SET sold = sold + qty
 *   WHERE sold + qty + 他人ACTIVE锁位 + 占位余座 ≤ capacity
 * affected ≠ 1（售罄/并发抢占/无此舱位）→ 抛 ConflictError，调用方的事务随之回滚。
 *
 * @param excludeUserId 排除其本人锁位不挡自己（下单场景用）；改期由运营操作 → 传 null（所有他人锁位都占余票）。
 */
export async function takeSeatWithinTx(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
  excludeUserId: string | null,
): Promise<void> {
  if (qty <= 0) return;
  if (typeof tx.$queryRaw === 'function') {
    await tx.$queryRaw`
      SELECT id FROM "FlightSeatClass"
      WHERE "scheduleId" = ${scheduleId} AND cabin = ${cabin}::"CabinClass"
      FOR UPDATE
    `;
  }
  const lockedAgg = await tx.seatLock.aggregate({
    _sum: { qty: true },
    where: {
      seatClass: { scheduleId, cabin },
      ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
      status: SeatLockStatus.ACTIVE,
      expiresAt: { gt: new Date() },
    },
  });
  const lockedByOthers = lockedAgg._sum.qty ?? 0;
  const heldQty = await heldSeatsForCabin(tx, scheduleId, cabin);
  const affected = await tx.$executeRaw`
    UPDATE "FlightSeatClass"
    SET sold = sold + ${qty}, "updatedAt" = NOW()
    WHERE "scheduleId" = ${scheduleId}
      AND cabin = ${cabin}::"CabinClass"
      AND sold + ${qty} + ${lockedByOthers} + ${heldQty} <= capacity
  `;
  if (affected !== 1) {
    const sc = await tx.flightSeatClass.findFirst({
      where: { scheduleId, cabin },
      select: { capacity: true, sold: true },
    });
    const available = sc
      ? Math.max(0, sc.capacity - sc.sold - lockedByOthers - heldQty)
      : 0;
    throw new ConflictError(
      `${cabin} 余票不足：需要 ${qty} 张，仅剩 ${available} 张（改期目标班次售罄/并发抢占）`,
    );
  }
}

/**
 * 释放座位——下限钳制在 0（HIGH 修复第二层防线）。
 *
 * `sold = GREATEST(0, sold - qty)`（原子 SQL）取代普通 `decrement`：即便 businessUpgradeCount
 * 被伪造导致某个分支想释放一个从未真正占用过的舱位（见 sanitizeFlightItemMetadata 的注释——那是
 * 第一层防线，从源头不让伪造值落库），这里也不会把 sold 打成负数并永久卡住（旧版 decrement 没有
 * 下限，负数会一直累积，直到人工去 DB 手动修）。
 *
 * 供状态机释放分支（_updateStatusWithinTx）和 30 分钟超时 worker（queues/worker.ts）复用——两处
 * 都要按 computeBundleSeatSplit 拆分释放，口径必须一致。
 */
export async function releaseSeatFloored(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  cabin: import('@prisma/client').CabinClass,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  await tx.$executeRaw`
    UPDATE "FlightSeatClass"
    SET sold = GREATEST(0, sold - ${qty}), "updatedAt" = NOW()
    WHERE "scheduleId" = ${scheduleId}
      AND cabin = ${cabin}::"CabinClass"
  `;
}

/** 一条售后费用流水（写入 Order.adjustments）。 */
export interface OrderAdjustmentEntry {
  type: 'RESCHEDULE_FEE' | 'SWAP_FEE' | 'SWAP_VISA_DEDUCT_REVERSAL' | 'PRICE_ADJUSTMENT' | string;
  label: string;
  amountCny: number;
  at: string; // ISO 时间
  by: string | null; // 操作人 userId
  note?: string;
  /** 关联出行人（SWAP_VISA_DEDUCT_REVERSAL 幂等去重、PRICE_ADJUSTMENT 按乘客调价用；整单调价为空）。 */
  passengerId?: string;
  /** 调价原因码（仅 PRICE_ADJUSTMENT 流水带；财务四类 DISCOUNT/MISC_FEE/CHANGE/OTHER）。 */
  reasonCode?: string;
}

/**
 * 按乘客把「价格调整」商品行分组（0722 公测反馈「金额明细逐人可解释」）。纯函数、导出供单测。
 *
 * 只认 metadata.priceAdjustment === true 的行（录单调价 / 事后调价 / 结算价差额 / 补房差都打了这个标）；
 * 其它商品行（机票/酒店/套餐基础价）一律忽略。按行的 passengerId 分桶：
 *   - byPassenger[pid] = 该乘客名下所有调整行 + 净额（Σamount，可正可负）；
 *   - wholeOrder       = passengerId 为空的整单调整行 + 净额（现行为不变）。
 * 「订单总额 = 系统价 + Σ调整」是既有口径（这些行本就计入 subtotal/total）；本函数只做展示层分组，
 * 不改任何金额，故与整单调价同一真值（把每行金额如实归到某乘客或整单）。
 */
export interface AdjustmentLine {
  itemId: string;
  amountCny: number;
  reasonCode: string | null;
  description: string;
  passengerId: string | null;
}
export function groupPassengerAdjustments(
  items: ReadonlyArray<{
    id: string;
    amount: number;
    description: string;
    passengerId?: string | null;
    metadata?: unknown;
  }>,
): {
  byPassenger: Record<string, { lines: AdjustmentLine[]; netCny: number }>;
  wholeOrder: { lines: AdjustmentLine[]; netCny: number };
} {
  const byPassenger: Record<string, { lines: AdjustmentLine[]; netCny: number }> = {};
  const wholeOrder = { lines: [] as AdjustmentLine[], netCny: 0 };
  for (const it of items) {
    const md = it.metadata;
    const isAdjust =
      md != null && typeof md === 'object' && (md as { priceAdjustment?: unknown }).priceAdjustment === true;
    if (!isAdjust) continue;
    const reasonCode =
      md != null && typeof md === 'object' && typeof (md as { reasonCode?: unknown }).reasonCode === 'string'
        ? ((md as { reasonCode: string }).reasonCode)
        : null;
    const line: AdjustmentLine = {
      itemId: it.id,
      amountCny: it.amount,
      reasonCode,
      description: it.description,
      passengerId: it.passengerId ?? null,
    };
    if (line.passengerId) {
      const bucket = byPassenger[line.passengerId] ?? { lines: [], netCny: 0 };
      bucket.lines.push(line);
      bucket.netCny = round2(bucket.netCny + line.amountCny);
      byPassenger[line.passengerId] = bucket;
    } else {
      wholeOrder.lines.push(line);
      wholeOrder.netCny = round2(wholeOrder.netCny + line.amountCny);
    }
  }
  return { byPassenger, wholeOrder };
}

/**
 * 不可变地把一条流水追加到 Order.adjustments（JSON 数组）。
 * 旧值非数组（脏数据/旧空默认）时按空数组处理，绝不抛错。
 */
function appendAdjustment(
  existing: Prisma.JsonValue | null | undefined,
  entry: OrderAdjustmentEntry,
): Prisma.InputJsonValue {
  const arr = Array.isArray(existing) ? (existing as Prisma.JsonArray) : [];
  return [...arr, entry as unknown as Prisma.InputJsonValue];
}

/**
 * 套餐升舱「拆座」模型（纯函数，扣座/退座共用，最终防超售）。
 *
 * 一个航段（FLIGHT 行）下单 `quantity` 人，其中 `businessUpgradeCount` 人选了升舱商务：
 *   - 升舱的人占用真实商务舱座位：BUSINESS += min(businessUpgradeCount, quantity)
 *   - 其余的人留在本行原舱位：原舱 += quantity − 上述商务数
 * 净占座仍 = quantity（不超售商务舱、不持有幽灵经济舱座位）。
 * 只有经济舱航段（cabin === 'ECONOMY'）才会被拆；其他舱位 businessUpgradeCount 视为 0。
 * businessUpgradeCount 缺省/0 → economy=quantity、business=0，与旧版行为完全一致（向后兼容）。
 *
 * 导出仅供单测使用。
 */
export function computeBundleSeatSplit(
  cabin: import('@prisma/client').CabinClass,
  quantity: number,
  businessUpgradeCount: number | undefined,
): { sameCabin: number; business: number } {
  const upgrade =
    cabin === 'ECONOMY'
      ? Math.min(Math.max(0, Math.trunc(businessUpgradeCount ?? 0)), quantity)
      : 0;
  return { sameCabin: quantity - upgrade, business: upgrade };
}

/**
 * PTC 码（ADT/CHD/INF，derivePtcByAge 的返回值）→ 建单落库用的系统枚举
 * （ADULT/CHILD/INFANT）。年龄阈值判断已在 derivePtcByAge 里做过，这里只做码值转换。
 */
function ptcToPassengerType(ptc: string): PassengerType {
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
    lastName: p.lastName ?? (autoLast || null),
    firstName: p.firstName ?? (autoFirst || null),
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
async function generateOrderNumber(): Promise<string> {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const suffix = String(randomInt(10000, 99999));
  return `FTM${yyyy}${mm}${dd}${suffix}`;
}

// 注意：list() 和 get() 的 passengers select 不同，所以 serialize 用宽松类型
// 只处理我们关心的 Decimal 字段 → string。其他字段原样透传。
interface OrderLike {
  // 状态：serializeOrder 据此下发 allowedTransitions（状态机真源，前端不再手抄）。
  status: OrderStatus;
  subtotal: Prisma.Decimal;
  taxesAndFees: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
  // 售后费用（改期费/换人费等）累计额（CNY，整数）。Prisma 直接返回 number。
  adjustmentCny: number;
  items: Array<{ unitPrice: Prisma.Decimal; amount: Prisma.Decimal } & Record<string, unknown>>;
  // 可选嵌套代理（含余额 Decimal + 结算模式）；不同 include 下可能不带或带 null
  agent?: ({ prepaymentBalance?: Prisma.Decimal | null } & Record<string, unknown>) | null;
  // ── 对外脱敏（redactForExternal）会剥离的内部字段（均可选：不同 include/select 下形状不同）──
  //   内部备注 + 结构化四栏备注 + 出纳期望到账 + 售后审计流水 + 接单运营 + 运营待办。
  //   声明为可选是为了让 serializeOrder 能安全读取并按角色覆盖（listOrders/getOrder 都联查了这些）。
  internalNotes?: string | null;
  noteHotel?: string | null;
  noteVisa?: string | null;
  notePayment?: string | null;
  noteSpecial?: string | null;
  expectedAmountCny?: Prisma.Decimal | null;
  expectedAmountLocked?: boolean;
  settlementLocked?: boolean;
  settlementLockedAt?: Date | null;
  settlementLockedBy?: string | null;
  // 收款复核锁（出纳/财务对账后写保护）：锁定后禁止人工录新收款。
  paymentsLocked?: boolean;
  paymentsLockedAt?: Date | null;
  paymentsLockedBy?: string | null;
  // 收款记录（ORDER_FULL_INCLUDE 下 payments: true 时联查）；不同 include 下可能不带。
  // gatewayPayload 是内部原始载荷，serializeOrder 只透出安全字段 + 认款标注，绝不整段外泄。
  payments?: Array<{
    id: string;
    method: PaymentMethod;
    amount: Prisma.Decimal;
    status: PaymentStatus;
    proofUrl?: string | null;
    paidAt?: Date | null;
    verifiedAt?: Date | null;
    createdAt: Date;
    gatewayPayload?: Prisma.JsonValue;
  }>;
  adjustments?: Prisma.JsonValue;
  claimedById?: string | null;
  claimedBy?: Record<string, unknown> | null;
  reminders?: Array<Record<string, unknown>>;
  // 出行人（用于套餐行程单「人数」——按 passengerType 计数；不同 include 下 select 形状不同，
  // 如 listOrders 只 select id/fullName，无 passengerType 字段，故用 Record<string, unknown> 兜底，
  // 与本接口 items/agent 的处理方式一致）。
  passengers?: Array<Record<string, unknown>>;
}

/** M月D日（本地展示用；departureDate 等按 UTC 零点解析的 date-only 字段沿用同一口径）。 */
function formatMonthDay(d: Date): string {
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/**
 * 航班时刻 HH:MM（24 小时制，**按班次自己的当地时区**折算）。
 * 班次 departureTime/arrivalTime 存 UTC，当地时区另存在 departureTz/arrivalTz——
 * 直接取 UTC 分量会少 8 小时（澳门/北京）或 7 小时（越南），订单详情、前台「我的订单」、
 * 行程单 PDF/邮件全线显示错误时刻。tz 缺失（未联查）时回退 UTC 分量，行为与改动前一致。
 */
function formatHHMM(d: Date, tz?: string | null): string {
  if (tz) return localHHMM(d, tz);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * YYYY-MM-DD。传入 tz 时按当地日折算（当地凌晨起飞的班次 UTC 还停在前一天，
 * 不折算会把出发日期写早一天）；不传沿用 UTC 日（date-only 字段本就存 UTC 零点）。
 */
function formatDateOnly(d: Date, tz?: string | null): string {
  if (tz) return localDateISO(d, tz);
  return d.toISOString().slice(0, 10);
}

/**
 * 订单「出发日期」派生（列表列展示用；YYYY-MM-DD 或 null）。
 * 口径（三级回退，依次取第一个有值的）：
 *   1. 本单 FLIGHT 行里最早班次的当地出发日；
 *   2. 无航班的纯地面单 → 最早的酒店入住日；
 *   3. 既无航班也无酒店（纯签证单）→ 最早 VISA 行的「预计出行日期」visaIntendedDate。
 * 三级都没有 → null（前端显示「—」）。
 *
 * 第三级的由来（反馈：签证岗）：签证业务必有「预计出行日期」这个业务锚点，只是从前没有字段可落，
 * 于是纯签证单永远派生不出出发日、被带出发日期区间的导出静默漏掉。字段可空 —— 老数据和行程
 * 未定的单仍回落 null，行为与扩展前一致。
 *
 * 依赖已联查的行数据，不另发查询；未联查 flightSchedule（如扁平 items:true）时航班部分
 * 安全落空，按后两级回退。
 */
// 注：导出在文件末尾的 `export { createCommissionsForOrder, deriveOrderDepartDate }` 统一给出。
function deriveOrderDepartDate(items: ReadonlyArray<Record<string, unknown>>): string | null {
  let earliestFlight: Date | null = null;
  // 最早那段航班的出发地时区——出发日要按它折，不是按 UTC（当地凌晨起飞的红眼班次
  // UTC 还停在前一天，按 UTC 算会把出发日期写早一天）。未联查 tz 时为 null → 回退 UTC。
  let earliestFlightTz: string | null = null;
  let earliestHotel: Date | null = null;
  let earliestVisa: Date | null = null;
  for (const i of items) {
    const schedule = i.flightSchedule as
      | { departureTime?: Date | string; departureTz?: string | null }
      | null
      | undefined;
    if (schedule?.departureTime) {
      const d = new Date(schedule.departureTime);
      if (!Number.isNaN(d.getTime()) && (earliestFlight === null || d < earliestFlight)) {
        earliestFlight = d;
        earliestFlightTz = schedule.departureTz ?? null;
      }
    }
    const checkIn = i.hotelCheckIn as Date | string | null | undefined;
    if (checkIn) {
      const d = new Date(checkIn);
      if (!Number.isNaN(d.getTime()) && (earliestHotel === null || d < earliestHotel)) {
        earliestHotel = d;
      }
    }
    // 签证行的「预计出行日期」——第三级回退用；只有前两级都落空时才会被采纳。
    const visaDate = i.visaIntendedDate as Date | string | null | undefined;
    if (visaDate) {
      const d = new Date(visaDate);
      if (!Number.isNaN(d.getTime()) && (earliestVisa === null || d < earliestVisa)) {
        earliestVisa = d;
      }
    }
  }
  // 航班优先按出发地当地日；回退到酒店入住日 / 签证预计出行日时用 UTC
  // （两者都是 @db.Date，存的就是 UTC 零点，再折时区反而会漂一天）
  if (earliestFlight) return formatDateOnly(earliestFlight, earliestFlightTz);
  if (earliestHotel) return formatDateOnly(earliestHotel);
  return earliestVisa ? formatDateOnly(earliestVisa) : null;
}

/**
 * 出行日期精确细筛：把「粗窗口候选订单」按整单出发日（deriveOrderDepartDate 同口径）精确
 * 过滤到 [travelFrom, travelTo] 内，返回命中的订单 id。
 * 口径复用 deriveOrderDepartDate（列表「出发日期」列同一函数）——保证「列表所见 = 筛选所得」。
 *   无出发日（航班/酒店/签证预计出行日三级全空）→ **不命中**；
 *   YYYY-MM-DD 字符串按字典序即日期序，可直接比较。
 * 两端半闭区间含边界（travelFrom/travelTo 各自可选）。导出供 listOrders 调用 + 单测。
 *
 * ⚠️ 与导出侧口径**故意不同**，别顺手统一：
 *   本函数（列表筛选）—— 无锚点单**排除**。列表的日期筛选是「找某天走的单」，一张没有任何
 *     日期的单若无条件保留，就会出现在**每一个**日期区间的结果里，等于筛选失效。
 *   filterExportOrdersByDepartDate（导出，见 orders.export-depart-filter.ts）—— 无锚点的
 *     **签证单**保留。导出是「把这批单交出去办事」，宁可多带一张也不能让签证岗的单整批消失；
 *     且与签证台看板（fulfillment.service 对纯签证单的保护）口径一致。豁免只给涉签单：
 *     空单/接送单/资料不全的机酒单没有「无处归日」这个理由，导出侧同样剔除。
 */
export function filterOrderIdsByDepartDate(
  candidates: ReadonlyArray<{ id: string; items: ReadonlyArray<Record<string, unknown>> }>,
  travelFrom?: string,
  travelTo?: string,
): string[] {
  const result: string[] = [];
  for (const o of candidates) {
    const departDate = deriveOrderDepartDate(o.items);
    if (departDate === null) continue;
    if (travelFrom && departDate < travelFrom) continue;
    if (travelTo && departDate > travelTo) continue;
    result.push(o.id);
  }
  return result;
}

/** deriveOrderReturnDate / filterOrderIdsByReturnDate 入参：determineFlightLegItems 的最小字段集，外加 departureTz。 */
interface ReturnLegItem extends FlightLegItem {
  flightSchedule?: { departureTime: Date | string; departureTz?: string | null } | null;
}

/**
 * 订单「返程日期」派生（返程日期筛选用；YYYY-MM-DD 或 null）。
 * 口径与 deriveOrderDepartDate 同源但只认回程航段、无兜底：
 *   带班次的 FLIGHT 行按 departureTime 升序，第 2 段 = 回程（与 determineFlightLegItems /
 *   Order.hasReturnLeg 物化列同一判定），当地日期按该腿 departureTz 折算。
 * 单程单 / 纯地面单没有回程腿 → null —— **不像出发日期那样回落酒店入住日或签证预计出行日**：
 * 返程日期只对「确实买了回程机票」的订单有意义，没有回程票就没有「无处归日」这回事。
 */
export function deriveOrderReturnDate(items: ReadonlyArray<ReturnLegItem>): string | null {
  const { return: returnItem } = determineFlightLegItems(items);
  const schedule = returnItem?.flightSchedule;
  if (!schedule?.departureTime) return null;
  const d = new Date(schedule.departureTime);
  if (Number.isNaN(d.getTime())) return null;
  return formatDateOnly(d, schedule.departureTz ?? null);
}

/**
 * 返程日期精确细筛：把「粗窗口候选订单」（buildOrderFilterWhere 的 returnFrom/returnTo 分支，
 * 按 FLIGHT 行 departureTime ±1 天粗召回）按整单返程日（deriveOrderReturnDate 同口径）精确过滤到
 * [returnFrom, returnTo] 内，返回命中的订单 id。两端半闭区间含边界（returnFrom/returnTo 各自可选）。
 * 无回程腿的单（单程/纯地面/纯签证单）→ **不命中**：与出发日期筛选的「无锚点不命中」同一立场
 * ——筛选是「找某天回的单」，没有回程票的单填了返程筛选就该被筛掉，不该无条件出现在每个区间里。
 * 导出供 listOrders 调用 + 单测。
 */
export function filterOrderIdsByReturnDate(
  candidates: ReadonlyArray<{ id: string; items: ReadonlyArray<ReturnLegItem> }>,
  returnFrom?: string,
  returnTo?: string,
): string[] {
  const result: string[] = [];
  for (const o of candidates) {
    const returnDate = deriveOrderReturnDate(o.items);
    if (returnDate === null) continue;
    if (returnFrom && returnDate < returnFrom) continue;
    if (returnTo && returnDate > returnTo) continue;
    result.push(o.id);
  }
  return result;
}

/** Prisma.Decimal | null | undefined → number | null（JSON 序列化前统一转换，未联查/未盖章时安全落 null）。 */
function decimalOrNull(d: Prisma.Decimal | null | undefined): number | null {
  return d == null ? null : Number(d);
}

/** 套餐组件明细里的一条（Bundle.items JSON 元素；与 bundleItemSchema 对齐）。 */
interface BundleItemEntry {
  kind?: unknown;
  productName?: unknown;
  qty?: unknown;
  transferId?: unknown;
  visaId?: unknown;
}

/**
 * BUNDLE 行「产品内容」卡片 v2 用的套餐组件派生字段（纯函数，供单测复用）：
 *   bundleKinds  — 该套餐 items 里实际存在哪些组件类型（FLIGHT/HOTEL/TRANSFER/VISA），
 *                  用于拼「往返机票+酒店+签证+接送机服务」这类产品名称。
 *   transfers    — TRANSFER 组件列表 [{name, qty(趟)}]（一个套餐可能配多条接送）。
 *   visa         — 第一个 VISA 组件 {name, stayDays}；name 用 productName（运营在套餐向导里填的
 *                  展示名，如「越南 E-visa 30 天 × 2 人」），productName 缺失时兜底为字面量「签证」；
 *                  stayDays 从 visaStayDaysById（按 visaId 查好的 Visa.stayDays）取，查不到落 null。
 * 容错：items 非数组/元素非对象/字段类型不对 → 跳过该条，不抛错（老数据/畸形 JSON 不阻断渲染）。
 */
export interface BundleItemsSummary {
  bundleKinds: Array<'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA'>;
  transfers: Array<{ name: string; qty: number }>;
  visa: { name: string; visaId: string; stayDays: number | null } | null;
}
export function summarizeBundleItems(
  bundleItems: unknown,
  visaStayDaysById: ReadonlyMap<string, number | null> = new Map(),
): BundleItemsSummary {
  const empty: BundleItemsSummary = { bundleKinds: [], transfers: [], visa: null };
  if (!Array.isArray(bundleItems)) return empty;

  const kindSet = new Set<string>();
  const transfers: Array<{ name: string; qty: number }> = [];
  let visa: BundleItemsSummary['visa'] = null;

  for (const raw of bundleItems as BundleItemEntry[]) {
    if (raw == null || typeof raw !== 'object') continue;
    const kind = raw.kind;
    if (kind !== 'FLIGHT' && kind !== 'HOTEL' && kind !== 'TRANSFER' && kind !== 'VISA') continue;
    kindSet.add(kind);
    const name = typeof raw.productName === 'string' && raw.productName.trim() ? raw.productName.trim() : null;
    if (kind === 'TRANSFER') {
      const qty = typeof raw.qty === 'number' && Number.isFinite(raw.qty) ? Math.trunc(raw.qty) : 1;
      transfers.push({ name: name ?? '接送服务', qty: Math.max(1, qty) });
    } else if (kind === 'VISA' && !visa) {
      // 只取第一个 VISA 组件（套餐目前按单一目的地/单一签证产品设计，多签证组件不是既有用例）
      const visaId = typeof raw.visaId === 'string' && raw.visaId ? raw.visaId : null;
      visa = {
        name: name ?? '签证',
        visaId: visaId ?? '',
        stayDays: visaId ? visaStayDaysById.get(visaId) ?? null : null,
      };
    }
  }

  return {
    bundleKinds: [...kindSet] as BundleItemsSummary['bundleKinds'],
    transfers,
    visa,
  };
}

/**
 * 单条订单行的行程单渲染字段（套餐订单详情「产品内容」板块用；ADDITIVE，不改/不删既有字段）。
 * FLIGHT 行 → 航班号/出发日期时间/到达时间/航线/舱位（来自 flightSchedule include）；
 * BUNDLE 行 → 套餐名/服务内容/组件构成/接送/签证（来自 bundle include，签证/接送来自套餐定义
 *   而非订单行——套餐订单通常只有机票腿 + 一条 BUNDLE 地面行，没有独立 VISA/TRANSFER 行）；
 * 三者关联的 VISA/TRANSFER 独立行（客户端提交时才会有）→ 签证/接送产品名称（保留，向后兼容）。
 * 未联查对应关系时（如 listOrders 用扁平 items:true）安全落 null，不强行断言非空。
 *
 * @param visaStayDaysById BUNDLE 行的 VISA 组件 stayDays 查询结果（getOrder 事先批量查好传入；
 *   其余调用方未传时用空表——套餐签证板块的 stayDays 会是 null，不影响其余字段。
 */
function itineraryFieldsForItem(
  i: Record<string, unknown>,
  visaStayDaysById: ReadonlyMap<string, number | null> = new Map(),
): Record<string, unknown> {
  const flightSchedule = i.flightSchedule as
    | {
        departureTime?: Date | string;
        arrivalTime?: Date | string;
        // 当地时区：未联查时为 undefined，格式化会安全回退 UTC 分量（口径同改动前）。
        departureTz?: string | null;
        arrivalTz?: string | null;
        flight?: { flightNumber?: string; originCode?: string; destinationCode?: string } | null;
      }
    | null
    | undefined;
  const hotelRoomType = i.hotelRoomType as { name?: string | null } | null | undefined;
  const visa = i.visa as
    | { visaName?: string | null; country?: string | null; destinationCountry?: string | null; stayDays?: number | null }
    | null
    | undefined;
  const transfer = i.transfer as { name?: string | null } | null | undefined;
  const bundle = i.bundle as
    | {
        name?: string | null;
        serviceNotes?: string | null;
        items?: unknown;
        hotelRoomType?: { name?: string | null; hotel?: { name?: string | null } | null } | null;
      }
    | null
    | undefined;

  const departureTime = flightSchedule?.departureTime ? new Date(flightSchedule.departureTime) : null;
  const arrivalTime = flightSchedule?.arrivalTime ? new Date(flightSchedule.arrivalTime) : null;
  const bundleSummary = bundle ? summarizeBundleItems(bundle.items, visaStayDaysById) : null;

  return {
    // ── FLIGHT 行（含套餐关联的经济舱腿）──
    flightNumber: flightSchedule?.flight?.flightNumber ?? null,
    // 出发日/时刻按出发地时区折算；到达时刻按到达地时区（跨时区航段两头不同）。
    departureDate: departureTime ? formatDateOnly(departureTime, flightSchedule?.departureTz) : null,
    departureTime: departureTime ? formatHHMM(departureTime, flightSchedule?.departureTz) : null,
    arrivalTime: arrivalTime ? formatHHMM(arrivalTime, flightSchedule?.arrivalTz) : null,
    route:
      flightSchedule?.flight?.originCode && flightSchedule?.flight?.destinationCode
        ? `${flightSchedule.flight.originCode}→${flightSchedule.flight.destinationCode}`
        : null,
    cabin: (i.flightCabin as string | null | undefined) ?? null,
    // ── HOTEL 行 / BUNDLE 行盖章的酒店房型 ──
    roomTypeName: hotelRoomType?.name ?? null,
    // ── VISA 行（独立提交时）──
    visaName: visa?.visaName ?? null,
    visaCountry: visa?.country ?? visa?.destinationCountry ?? null,
    visaStayDays: visa?.stayDays ?? null,
    // ── TRANSFER 行（独立提交时）──
    transferProductName: transfer?.name ?? null,
    // ── BUNDLE 行 ──
    bundleName: bundle?.name ?? null,
    serviceNotes: bundle?.serviceNotes ?? null,
    // 套餐组件构成（该套餐 items 里实际有哪些类型）——「产品名称」自动拼装用
    bundleKinds: bundleSummary?.bundleKinds ?? null,
    // 套餐定义里的接送组件（来自套餐，不是订单行——套餐订单通常没有独立 TRANSFER 行）
    bundleTransfers: bundleSummary?.transfers ?? null,
    // 套餐定义里的签证组件（来自套餐，不是订单行；stayDays 由调用方批量查好传入）
    bundleVisa: bundleSummary?.visa ?? null,
    // 套餐关联房型的兜底酒店名/房型名——订单行自身未盖章 hotelRoomTypeId 时（老订单常见），
    // 从套餐定义本身的关联房型回落，而不是整段留空。
    bundleHotelName: bundle?.hotelRoomType?.hotel?.name ?? null,
    bundleRoomTypeName: bundle?.hotelRoomType?.name ?? null,
  };
}

/** 金额保留 2 位小数（CNY，避免浮点累计误差）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 用 Prisma.Decimal 做钱算术（避免 float 漂移），结果四舍五入到 2 位小数。
// ROUND_HALF_UP 与文件其余处（round2 的 Math.round）一致。
function round2Decimal(d: Prisma.Decimal): Prisma.Decimal {
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * 订单级「按人头单价」派生（套餐订单详情「产品内容」卡片「人数」板块用）。
 * 由真实成交金额反推，不臆造数字——起点是 order.total（服务端权威重算后的实付总额，
 * 已含套餐折扣/升级加价等一切调整），按套餐的婴儿价/占座儿童折扣往回摊：
 *
 *   infantUnitPriceCny = bundle.infantPriceCny（套餐配置的婴儿价，直接展示，不参与摊分）
 *   childDiscount      = bundle.childSeatDiscountCnyPerPerson（占座儿童比成人价低多少）
 *   adultUnitPriceCny  = round( (total − infantCount×infantPrice + childCount×childDiscount)
 *                                 / max(1, adultCount+childCount) )
 *     —— 先把婴儿价从总额里减掉（婴儿不占座，价格与成人/儿童均摊池无关），
 *        儿童比成人少收的部分加回去（还原「儿童按成人价打折」之前的等效成人价基数），
 *        再按占座人数（成人+儿童）均摊，得到「等效成人单价」。
 *   childUnitPriceCny  = adultUnitPriceCny − childDiscount
 *
 * 仅在本单含 BUNDLE 行且能解析出该行关联套餐的定价配置时返回；非套餐订单 / 套餐已被删除
 * 查不到定价配置时返回 null（调用方按需省略该板块，不臆造）。
 */
export interface BundlePerAgeUnitPrices {
  infantUnitPriceCny: number;
  childUnitPriceCny: number;
  adultUnitPriceCny: number;
}
export function deriveBundlePerAgeUnitPrices(
  totalCny: number,
  counts: { adultCount: number; childCount: number; infantCount: number },
  bundlePricing: { infantPriceCny: number; childSeatDiscountCnyPerPerson: number },
): BundlePerAgeUnitPrices {
  const { adultCount, childCount, infantCount } = counts;
  const infantUnitPriceCny = bundlePricing.infantPriceCny;
  const childDiscount = bundlePricing.childSeatDiscountCnyPerPerson;
  const seatPax = Math.max(1, adultCount + childCount);
  const adultUnitPriceCny = round2(
    (totalCny - infantCount * infantUnitPriceCny + childCount * childDiscount) / seatPax,
  );
  const childUnitPriceCny = round2(adultUnitPriceCny - childDiscount);
  return { infantUnitPriceCny, childUnitPriceCny, adultUnitPriceCny };
}

/**
 * 从订单行数组里找第一条 BUNDLE 行关联的套餐定价配置（infantPriceCny / childSeatDiscountCnyPerPerson）。
 * 未联查 bundle（如 listOrders 用扁平 items:true）或本单无 BUNDLE 行 / 套餐已被删除 → 返回 null。
 */
function findBundlePricingConfig(
  items: ReadonlyArray<Record<string, unknown>>,
): { infantPriceCny: number; childSeatDiscountCnyPerPerson: number } | null {
  for (const i of items) {
    if (i.kind !== 'BUNDLE') continue;
    const bundle = i.bundle as
      | { infantPriceCny?: number | null; childSeatDiscountCnyPerPerson?: number | null }
      | null
      | undefined;
    if (!bundle) continue;
    return {
      infantPriceCny: bundle.infantPriceCny ?? 0,
      childSeatDiscountCnyPerPerson: bundle.childSeatDiscountCnyPerPerson ?? 0,
    };
  }
  return null;
}

/**
 * 详情/自助补录共用的出行人序列化：默认剥离 passportPhotoUrl 大图（data-URL 可达 MB 级，
 * 会把订单详情响应撑爆，且是证件级敏感数据），以 hasPassportPhoto 布尔代替。
 * keepPhotoUrl=true 时才保留大图（后台订单详情的护照缩略图直接读该字段，剥掉会瞎）。
 * 窄 select（如 listOrders 只带 id/fullName）不含该字段 → 原样透传，不硬加布尔。
 */
function serializePassengerRecord<P extends Record<string, unknown>>(
  p: P,
  opts: { keepPhotoUrl?: boolean } = {},
): Record<string, unknown> {
  if (!('passportPhotoUrl' in p)) return p;
  const hasPassportPhoto = p.passportPhotoUrl != null;
  if (opts.keepPhotoUrl) return { ...p, hasPassportPhoto };
  const { passportPhotoUrl: _stripped, ...rest } = p;
  return { ...rest, hasPassportPhoto };
}

/**
 * 对外脱敏（A15）会从订单行 metadata 剥离的「我方内部计价明细」键。
 * item.unitPrice / item.amount 已在 serializeOrder 里对外剥离，但 metadata 里还藏着逐座 / 逐加项的
 * 计价拆解（如 perSeatBreakdown[].unitPrice、addOns 的各项费率与小计、operationFee、折扣百分比）——
 * 代理凭此能反推我方成本与加价。对外角色一律剥掉这些**计价键**，保留非价格业务键
 *（goDate/returnDate/roomsNeeded/hotelNights/pax/adultCount/childCount/infantCount/selfProvidedVisa…
 * 代理要凭此替客人办事）。采用「剥离已知计价键」黑名单：新增业务键默认保留、不会被误删。
 */
const REDACTED_ITEM_METADATA_KEYS: readonly string[] = [
  'perSeatBreakdown', // FLIGHT 逐座定价阶梯（含 unitPrice/bucket，能反推实时销量与档位价）
  'addOns', // BUNDLE 升级重算明细（含单房差/升舱/儿童折扣/婴儿价/自备签费率与各项小计、total）
  'designatedHotel', // BUNDLE 指定酒店加价明细（每人费率/小计，能反推我方与酒店的差价口径）
  'operationFee', // BUNDLE 每人操作费（perPaxCny/totalCny）
  'bundleDiscountPct', // BUNDLE 套餐折扣百分比
  'perNightCny', // 补收单房差每晚价（售后调价行）
  'expressTier', // VISA 加急档快照（含该档 surchargeCny，能反推我方加急加价口径）
  'unitPrice', // 任何行级单价明细
];

/**
 * 对外脱敏：从订单行 metadata 剥离计价键，保留非价格业务键。
 * metadata 为空 / 非对象 → 原样返回（不强行造对象）。
 */
function redactItemMetadataForExternal(metadata: unknown): unknown {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (REDACTED_ITEM_METADATA_KEYS.includes(key)) continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * 收款记录序列化：只透出安全字段 + 认款来源标注，绝不外泄 gatewayPayload 其余内容
 *（内部 confirmedBy / 原始网关载荷等一律不下发）。
 *
 * 认款标注（reconciled）判定：
 *   1) 新数据：gatewayPayload.source === 'reconciliation' → 直接取 receiptNo / externalTxnId。
 *   2) 旧数据兼容：gatewayPayload.note 以「对账认领 」开头 → 视为认款，并从 note 提取 receiptNo。
 * 其余（手工确认 / 网关到账）reconciled=false，前端标为「手工确认」。
 */
const RECONCILE_NOTE_PREFIX = '对账认领 ';
function serializePaymentRecord(p: NonNullable<OrderLike['payments']>[number]): {
  id: string;
  method: PaymentMethod;
  amount: string;
  status: PaymentStatus;
  proofUrl: string | null;
  paidAt: Date | null;
  createdAt: Date;
  reconciled: boolean;
  receiptNo: string | null;
  externalTxnId: string | null;
  verified: boolean;
  verifiedAt: Date | null;
} {
  const payload =
    p.gatewayPayload && typeof p.gatewayPayload === 'object' && !Array.isArray(p.gatewayPayload)
      ? (p.gatewayPayload as Record<string, unknown>)
      : null;
  let reconciled = false;
  let receiptNo: string | null = null;
  let externalTxnId: string | null = null;
  if (payload) {
    if (payload.source === 'reconciliation') {
      reconciled = true;
      receiptNo = typeof payload.receiptNo === 'string' ? payload.receiptNo : null;
      externalTxnId = typeof payload.externalTxnId === 'string' ? payload.externalTxnId : null;
    } else if (typeof payload.note === 'string' && payload.note.startsWith(RECONCILE_NOTE_PREFIX)) {
      // 旧数据：来源信息只留在 note 里，尽力提取进账单号，无流水号。
      reconciled = true;
      receiptNo = payload.note.slice(RECONCILE_NOTE_PREFIX.length).trim() || null;
    }
  }
  return {
    id: p.id,
    method: p.method,
    amount: p.amount.toString(),
    status: p.status,
    proofUrl: p.proofUrl ?? null,
    paidAt: p.paidAt ?? null,
    createdAt: p.createdAt,
    reconciled,
    receiptNo,
    externalTxnId,
    // 到账双状态：财务核过流水才算 verified（认款/网关创建即核实；人工录入待财务核实）。
    verified: p.verifiedAt != null,
    verifiedAt: p.verifiedAt ?? null,
  };
}

// 导出供单测直接验证脱敏口径（redactForExternal）；运行时仍由本模块内部各读取/流转处调用。
export function serializeOrder<T extends OrderLike>(
  order: T,
  ctx: {
    visaStayDaysById?: ReadonlyMap<string, number | null>;
    /**
     * 后台（ADMIN/STAFF）详情需要护照大图渲染缩略图；客户/代理侧剥离瘦身。
     * **缺省剥离（fail-closed）**：不传 ctx / 不显式置 true 的调用方一律拿不到 passportPhotoUrl，
     * 只拿到 hasPassportPhoto 布尔。要大图必须显式传 includePassportPhotos: true
     *（通常经 orderSerializeRoleCtx(role) 按角色推导，不要手写 true）。
     * 口径理由：护照大图是证件级敏感数据，新写的调用方漏传 ctx 时应当「少给」而非「多给」。
     */
    includePassportPhotos?: boolean;
    /**
     * 对外脱敏（A15）：AGENT / CUSTOMER 视角只该看到 产品名 / 航班号 / 接待服务标准 / 自己的结算价（订单总价）。
     * 置 true 时剥离「我方内部口径」——内部备注、结构化四栏、出纳期望到账、售后审计流水、接单运营、运营待办、
     * 代理预存余额、以及逐项拆价（item.unitPrice / item.amount）。缺省 false（ADMIN/STAFF 看全量，兼容既有调用方）。
     */
    redactForExternal?: boolean;
  } = {},
) {
  const visaStayDaysById = ctx.visaStayDaysById ?? new Map<string, number | null>();
  // 对外脱敏开关：仅当显式传 true（AGENT/CUSTOMER 上下文）才剥离内部字段；缺省保留全量。
  const redact = ctx.redactForExternal === true;
  // 售后费用叠加后的口径（与 reports.service / reminders.rules / 财务导出全局清账公式一字一致）：
  //   effectivePayable = total + adjustmentCny（客户应付；含改期费/换人费等售后调整）
  //   balanceDue       = effectivePayable − paidAmount − prepaymentOffset（尾款；负数表示多付）
  //     · prepaymentOffset（代理预存抵扣）视同已付，必须一并扣减，否则详情尾款与报表/提醒/导出对不平。
  // 不改 total/subtotal（机票基础价不重算），只在结清口径上暴露派生值，前端统一用此尾款。
  const adjustmentCny = order.adjustmentCny ?? 0;
  const totalNum = Number(order.total.toString());
  const paidNum = Number(order.paidAmount.toString());
  const prepaymentOffsetNum = Number(order.prepaymentOffset.toString());
  const effectivePayable = round2(totalNum + adjustmentCny);
  const balanceDue = round2(effectivePayable - paidNum - prepaymentOffsetNum);
  // 按 passengerType 统计人数（订单详情行程单「人数」板块用；未 include passengers/无 passengerType
  // 字段时安全落 0，不强行断言——如 listOrders 的 passengers select 只带 id/fullName）。
  const passengerTypeOf = (p: Record<string, unknown>): string =>
    (p.passengerType as string | null | undefined) ?? 'ADULT';
  const adultCount = order.passengers?.filter((p) => passengerTypeOf(p) === 'ADULT').length ?? 0;
  const childCount = order.passengers?.filter((p) => passengerTypeOf(p) === 'CHILD').length ?? 0;
  const infantCount = order.passengers?.filter((p) => passengerTypeOf(p) === 'INFANT').length ?? 0;
  // 套餐订单按人头单价（仅本单含 BUNDLE 行且联查到套餐定价配置时才有；见 deriveBundlePerAgeUnitPrices）。
  const bundlePricing = findBundlePricingConfig(order.items);
  const perAgePrices = bundlePricing
    ? deriveBundlePerAgeUnitPrices(totalNum, { adultCount, childCount, infantCount }, bundlePricing)
    : null;
  return {
    ...order,
    subtotal: order.subtotal.toString(),
    taxesAndFees: order.taxesAndFees.toString(),
    discountTotal: order.discountTotal.toString(),
    total: order.total.toString(),
    paidAmount: order.paidAmount.toString(),
    prepaymentOffset: order.prepaymentOffset.toString(),
    // 售后费用派生口径（前端用 effectivePayable / balanceDue 取代「total − paidAmount」）
    adjustmentCny,
    effectivePayable: effectivePayable.toString(),
    balanceDue: balanceDue.toString(),
    // 订单「出发日期」（列表列用；FLIGHT 最早班次当地出发日 → 回退最早酒店入住日 → null）
    departDate: deriveOrderDepartDate(order.items),
    // ── 状态机元数据（N8）：本单当前状态下的合法流转，直接取自后端权威 ALLOWED_TRANSITIONS。
    //    前端抽屉据此渲染「标准流转」按钮与「管理员强制」清单，不再自己抄一份状态机——
    //    抄的那份曾漂移（PAID/PROCESSING 少了 CHANGE_REQUESTED 等），把合法流转逼进 force 通道，
    //    污染成 FORCE_ORDER_STATUS + WARNING 审计记录，真正该警觉的强制被淹没。
    //    逐单下发（而非单独的 meta 接口）：天然跟随本单 status，不存在「元数据与单状态不同步」的窗口。
    allowedTransitions: ALLOWED_TRANSITIONS[order.status] ?? [],
    // 出行人数（按 Passenger.passengerType 统计；套餐行程单「人数：成人 X · 儿童 X · 婴儿 X」用）
    adultCount,
    childCount,
    infantCount,
    // 套餐订单按人头单价（由 total 反推，非套餐订单/查不到套餐定价配置时为 null）。
    // 内部均摊口径，仅 ADMIN/STAFF 可见：客户/代理端页面不渲染它，响应体也不该带（redact 时置 null）。
    infantUnitPriceCny: redact ? null : (perAgePrices?.infantUnitPriceCny ?? null),
    childUnitPriceCny: redact ? null : (perAgePrices?.childUnitPriceCny ?? null),
    adultUnitPriceCny: redact ? null : (perAgePrices?.adultUnitPriceCny ?? null),
    // ── 对外脱敏（redact）：内部备注 / 结构化四栏 / 出纳期望到账 / 售后审计流水 / 接单运营 / 运营待办一律不下发。
    //    这些键都来自上面的 ...order 展开，这里放在其后按角色覆盖：置 undefined 时 JSON.stringify 会自动省略该键。
    //    保留订单级金额（total/subtotal/paidAmount/effectivePayable/balanceDue = 该角色自己的结算价）与出行人证件
    //    （代理要凭此替客人办事）；只剥离「我方内部口径」，不影响 ADMIN/STAFF（redact=false 时原样透传）。
    internalNotes: redact ? undefined : order.internalNotes,
    noteHotel: redact ? undefined : order.noteHotel,
    noteVisa: redact ? undefined : order.noteVisa,
    notePayment: redact ? undefined : order.notePayment,
    noteSpecial: redact ? undefined : order.noteSpecial,
    expectedAmountCny: redact ? undefined : order.expectedAmountCny,
    expectedAmountLocked: redact ? undefined : order.expectedAmountLocked,
    settlementLocked: order.settlementLocked ?? false,
    // 锁定时间/操作人仅内部可见（对代理 redact），条件透传保持与 Prisma payload 类型兼容
    settlementLockedAt: redact ? undefined : (order.settlementLockedAt ?? null),
    settlementLockedBy: redact ? undefined : (order.settlementLockedBy ?? null),
    // 收款复核锁：锁状态是内部收款区功能，对外角色（AGENT/CUSTOMER）一律不下发（收款区本就不对外）。
    paymentsLocked: redact ? undefined : (order.paymentsLocked ?? false),
    paymentsLockedAt: redact ? undefined : (order.paymentsLockedAt ?? null),
    paymentsLockedBy: redact ? undefined : (order.paymentsLockedBy ?? null),
    // 收款记录：显式重映射，只透出安全字段 + 认款标注（reconciled/receiptNo/externalTxnId），
    // 剥掉 gatewayPayload 原始载荷（confirmedBy 等内部字段绝不外泄）。未联查 payments 时不加此键。
    ...(Array.isArray(order.payments)
      ? {
          payments: order.payments.map(serializePaymentRecord),
          // 未经财务核实的已收金额（正额 SUCCEEDED 且 verifiedAt 为空之和）。
          // 出票/推进终态前的界面提示据此显示「这单 ¥xxx 到账未经财务核实」；仅内部可见。
          ...(redact
            ? {}
            : {
                unverifiedPaidCny: round2(
                  order.payments
                    .filter((p) => p.status === PaymentStatus.SUCCEEDED && !p.verifiedAt && Number(p.amount) > 0)
                    .reduce((sum, p) => sum + Number(p.amount), 0),
                ),
              }),
        }
      : {}),
    adjustments: redact ? undefined : order.adjustments,
    claimedById: redact ? undefined : order.claimedById,
    claimedBy: redact ? undefined : order.claimedBy,
    reminders: redact ? [] : order.reminders,
    // 出行人：客户/代理侧剥离 passportPhotoUrl 大图（详情响应瘦身），以 hasPassportPhoto
    // 布尔代替；后台详情保留大图（订单抽屉护照缩略图依赖）。窄 select 无该字段时原样透传。
    passengers: (order.passengers ?? []).map((p) =>
      serializePassengerRecord(p, { keepPhotoUrl: ctx.includePassportPhotos === true }),
    ),
    // 暴露代理结算模式 + 余额（前端据 settlementMode=MONTHLY 把订单显示成「月结」而非「欠款」）
    agent:
      order.agent == null
        ? order.agent
        : {
            ...order.agent,
            // 对外脱敏：代理预存余额是我方内部结算口径，AGENT/CUSTOMER 不下发（保留结算模式等非金额字段）。
            prepaymentBalance: redact
              ? undefined
              : order.agent.prepaymentBalance == null
                ? null
                : order.agent.prepaymentBalance.toString(),
          },
    items: order.items.map((i) => {
      const bundleFallback = i.bundle as
        | { hotelRoomType?: { name?: string | null; hotel?: { name?: string | null } | null } | null }
        | null
        | undefined;
      // 权威酒店中文名：HOTEL 行或 BUNDLE 行（盖章 hotelRoomTypeId）联查 hotelRoomType.hotel.name 均可命中。
      // 不是所有调用方的 items include 都联查了 hotelRoomType（如 listOrders 用 items: true）——
      // 这里用可选链读取，未联查时安全落 null，不强行断言非空。
      // 订单行自身未盖章 hotelRoomTypeId 时（老订单常见，见 CLAUDE 里记录的"套餐没盖房型"数据问题），
      // 回落到套餐定义自己关联的房型，而不是整段留空。
      const ownHotelName =
        (i as { hotelRoomType?: { hotel?: { name?: string | null } | null } | null }).hotelRoomType
          ?.hotel?.name ?? null;
      const ownRoomTypeName =
        (i as { hotelRoomType?: { name?: string | null } | null }).hotelRoomType?.name ?? null;
      return {
        ...i,
        // 对外脱敏：逐项拆价（单价/小计）是我方内部口径，AGENT/CUSTOMER 只看订单总价，不下发行级金额。
        //   保留 kind / description / quantity / 行程信息（航班号、出发日期等）等非价格字段。
        unitPrice: redact ? undefined : i.unitPrice.toString(),
        amount: redact ? undefined : i.amount.toString(),
        // 对外脱敏：**我方真实进价**。这两个字段之前随 `...i` 整行展开一起下发了——
        // CUSTOMER/AGENT 调 GET /orders 就能在浏览器 Network 面板里逐行看到我们的成本，
        // 拿它和自己付的钱一减就是我方毛利。比行级售价泄露严重得多，必须一并抹掉。
        unitCostCny: redact ? undefined : (i as { unitCostCny?: unknown }).unitCostCny,
        totalCostCny: redact ? undefined : (i as { totalCostCny?: unknown }).totalCostCny,
        // 对外脱敏：metadata 里的计价明细（perSeatBreakdown[].unitPrice、addOns、operationFee、
        //   bundleDiscountPct…）同样是我方内部口径——剥离计价键，保留非价格业务键（内部角色原样透传）。
        ...(redact
          ? { metadata: redactItemMetadataForExternal((i as { metadata?: unknown }).metadata) }
          : {}),
        // 未落位随机单还没落到具体酒店 → 用档次名（「四星随机」）当酒店名，让各处「住哪」
        // 一栏如实显示"买的是随机、待落位"，而不是空白（落位后本列被清空，自然回到真实酒店名）。
        hotelName:
          ownHotelName ??
          bundleFallback?.hotelRoomType?.hotel?.name ??
          ((i as { randomStarTier?: number | null }).randomStarTier != null
            ? randomStarTierLabel((i as { randomStarTier?: number | null }).randomStarTier!)
            : null),
        // 计费房间数（Decimal → number；未联查/未盖章时为 null，原样透出不强行转换）。
        roomsBilled: decimalOrNull((i as { roomsBilled?: Prisma.Decimal | null }).roomsBilled),
        // 行程单渲染字段（ADDITIVE；见 itineraryFieldsForItem 注释——未联查对应关系时安全落 null）。
        ...itineraryFieldsForItem(i, visaStayDaysById),
        // itineraryFieldsForItem 已经算了 roomTypeName（HOTEL/BUNDLE 行自身盖章的房型名）；
        // 这里只在它为空时才用套餐兜底房型名覆盖，放在展开之后确保生效（避免被 spread 顺序覆盖）。
        roomTypeName: ownRoomTypeName ?? bundleFallback?.hotelRoomType?.name ?? null,
      };
    }),
  };
}

/**
 * 按请求者角色推导 serializeOrder 的对外脱敏口径（A15）。
 *   - 内部角色（ADMIN / STAFF）：看全量（含护照大图、内部备注、逐项拆价、代理余额…）。
 *   - 对外角色（AGENT / CUSTOMER）：只看 产品名 / 航班号 / 接待服务标准 / 自己的结算价（订单总价），
 *     其余「我方内部口径」一律剥离（见 serializeOrder 的 redactForExternal）。
 * 供订单读取/流转的各调用处统一复用，避免各处重复写角色判断。
 */
export function orderSerializeRoleCtx(role: UserRole): {
  includePassportPhotos: boolean;
  redactForExternal: boolean;
} {
  const isInternal = role === UserRole.ADMIN || role === UserRole.STAFF;
  return { includePassportPhotos: isInternal, redactForExternal: !isInternal };
}

// ── 公开订单脱敏视图（A4）────────────────────────────────────────────
export interface MaskedOrderView {
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'NONE';
  createdAt: Date;
  total: string;
  items: Array<{
    kind: OrderItemKind;
    productName: string;
    quantity: number;
    amount: string;
    travelDate: string | null; // 出行/入住日期（仅日期，无时间）
    flightChanged: boolean; // 该航段是否发生过航变改班（前台标红提示「留意新起飞时间」）
  }>;
  passengers: Array<{ name: string }>; // 仅名（given name），姓氏脱敏
}

/**
 * 脱敏中文/英文姓名：只保留「名」，姓氏打码。
 *   "张三"   → "张*"     （中文：首字 + *）
 *   "李小明" → "李**"
 *   "WANG MEI" → "W** MEI"（拉丁：首字母 + ** + 其余）
 * 兜底：无法判断时保留首字符 + *。
 */
export function maskFamilyName(fullName: string): string {
  const name = (fullName ?? '').trim();
  if (!name) return '*';
  // 拉丁姓名（含空格）：第一段视为姓 → 首字母 + **，其余原样
  if (/\s/.test(name)) {
    const [family, ...rest] = name.split(/\s+/);
    const maskedFamily = family.length <= 1 ? `${family}*` : `${family[0]}${'*'.repeat(Math.min(family.length - 1, 2))}`;
    return [maskedFamily, ...rest].join(' ');
  }
  // 中文姓名：首字（姓）+ 其余打码
  if (name.length <= 1) return `${name}*`;
  return `${name[0]}${'*'.repeat(name.length - 1)}`;
}

type OrderForMasking = Prisma.OrderGetPayload<{
  include: {
    items: { include: { flightSchedule: { select: { departureTime: true, departureTz: true } } } };
    passengers: { select: { fullName: true; firstName: true } };
    payments: { select: { status: true } };
  };
}>;

/** 把 order（含 items/passengers/payments）转脱敏视图，绝不带内部字段。 */
function maskOrderForPublic(order: OrderForMasking): MaskedOrderView {
  // 取最近一笔成功支付；否则取任一支付状态；都没有 → NONE
  const succeeded = order.payments.some((p) => p.status === 'SUCCEEDED');
  const latest = order.payments[order.payments.length - 1];
  const paymentStatus: MaskedOrderView['paymentStatus'] = succeeded
    ? 'SUCCEEDED'
    : latest
      ? (latest.status as MaskedOrderView['paymentStatus'])
      : 'NONE';

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus,
    createdAt: order.createdAt,
    total: order.total.toString(),
    items: order.items.map((it) => ({
      kind: it.kind,
      productName: it.description,
      quantity: it.quantity,
      amount: it.amount.toString(),
      travelDate: maskedItemTravelDate(it),
      // 仅暴露「是否航变」这个客户可见事实布尔，不带任何内部班次 id/明细（脱敏口径）。
      flightChanged: hasFlightChanged((it as { metadata?: unknown }).metadata),
    })),
    passengers: order.passengers.map((p) => ({ name: maskFamilyName(p.fullName) })),
  };
}

/** 该订单行是否带「航变」标记（rescheduleOrderItem 换班次时落在 metadata.flightChanged）。 */
function hasFlightChanged(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const mark = (metadata as { flightChanged?: unknown }).flightChanged;
  return Boolean(mark) && typeof mark === 'object';
}

/** 行的出行/入住日期（仅日期字符串）；HOTEL→入住日，FLIGHT→出发日，否则 null。 */
function maskedItemTravelDate(it: {
  hotelCheckIn: Date | null;
  flightSchedule: { departureTime: Date; departureTz?: string | null } | null;
}): string | null {
  if (it.hotelCheckIn) return it.hotelCheckIn.toISOString().slice(0, 10);
  // 航班出发日按出发地当地日折算；未联查 tz 时回退 UTC 日（口径同改动前）
  if (it.flightSchedule) {
    return formatDateOnly(it.flightSchedule.departureTime, it.flightSchedule.departureTz);
  }
  return null;
}

// 避免 PaymentMethod 未使用告警（未来接支付时会用到）
void PaymentMethod;

// ── Fulfillment 任务生成（PAID 时触发） ─────────────────────────
import { FulfillmentStatus, FulfillmentType, VisaSubmissionStatus, type VisaRequirement } from '@prisma/client';

// 非套餐订单项：一行 → 一个对应岗任务。
const KIND_TO_FULFILLMENT_TYPE: Partial<Record<OrderItemKind, FulfillmentType>> = {
  FLIGHT: FulfillmentType.FLIGHT_TICKETING,
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
};

// 套餐组件 kind（Bundle.items[].kind，见 products.schemas bundleItemSchema）→ 对应岗任务。
// 注意：FLIGHT 组件不在此列 —— 套餐下单已单独落 FLIGHT 订单项（FLIGHT_TICKETING 由那行生成），
//       从套餐再生成会与之重复，故套餐只 fan-out 地面（酒店/签证/接送）组件。
const BUNDLE_COMPONENT_KIND_TO_TYPE: Record<string, FulfillmentType | undefined> = {
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
};

/**
 * 解析套餐订单项需要生成哪些「地面岗」任务类型。
 * 通过订单项的 bundleId 反查 Bundle.items JSON，取其组件 kind 集合映射到 FulfillmentType。
 * 解析不到（bundleId 缺失 / 套餐被删 / items 畸形）时优雅降级：
 *   至少回退一个 HOTEL_BOOKING（套餐基本必含酒店），保证酒店岗能看到该套餐单。
 */
async function resolveBundleFulfillmentTypes(
  tx: Prisma.TransactionClient,
  bundleId: string | null,
): Promise<FulfillmentType[]> {
  const FALLBACK = [FulfillmentType.HOTEL_BOOKING];
  if (!bundleId) return FALLBACK;
  const bundle = await tx.bundle.findUnique({
    where: { id: bundleId },
    select: { items: true },
  });
  if (!bundle) return FALLBACK;
  const components = Array.isArray(bundle.items)
    ? (bundle.items as Array<{ kind?: unknown }>)
    : [];
  // 去重保序：同一类组件（如两段接送）只开一个对应岗任务。
  const types = new Set<FulfillmentType>();
  for (const c of components) {
    if (typeof c?.kind !== 'string') continue;
    const type = BUNDLE_COMPONENT_KIND_TO_TYPE[c.kind];
    if (type) types.add(type);
  }
  return types.size > 0 ? [...types] : FALLBACK;
}

/**
 * PAID 时为订单的每个订单项生成 fulfillment 任务。
 *
 * - 非套餐项（FLIGHT/HOTEL/VISA/TRANSFER）：一行 → 一个对应岗任务。
 * - 套餐项（BUNDLE）：反查套餐组件，fan-out 成 per-component 地面岗任务
 *   （HOTEL→HOTEL_BOOKING / VISA→VISA_APPLICATION / TRANSFER→TRANSFER_DISPATCH），
 *   不再生成单一 BUNDLE_COMPOSITE 占位任务 —— 否则签证岗/酒店岗/地面岗看不到套餐单。
 *   （FLIGHT 组件由套餐另落的 FLIGHT 订单项生成，避免重复。）
 *
 * 幂等：按「该订单项已存在的任务类型集合」判定，只补缺失的类型。
 *   首次运行会一次性建齐所有需要的类型；重跑不会重复建（即便套餐含多类型，
 *   旧的 `fulfillmentTasks.length > 0` 单值守卫会漏建剩余类型，故改为按类型去重）。
 */
async function createFulfillmentTasks(tx: Prisma.TransactionClient, orderId: string): Promise<string[]> {
  // 订单级签证状态：visaStatus=NEEDED / E_VISA（电子签·三个月多次，同样需要送签办理）
  // 的订单即便没有 VISA 行/套餐签证组件，也要进签证台（让签证岗看见并按类型筛选）。
  // NOT_NEEDED/HAS_VISA 不开任务。
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true },
  });
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { type: true, status: true } },
    },
  });
  const newTaskIds: string[] = [];
  // 去重口径按「(type, 非终态)」：CANCELLED 任务视为不存在，其余（PENDING/IN_PROGRESS/CONFIRMED/FAILED）
  // 都算已存在、不重复建。据此 force 取消族 → PAID 复活时：被 P2-16 终态化成 CANCELLED 的任务不再挡路，
  // 缺失的活动任务会重建成 PENDING（订单看板有可执行任务）；CONFIRMED/FAILED 等仍活着的不会被重复建。
  //   与 A1（resetVisa 绝不碰 CANCELLED）一致：CANCELLED 永远冻结为终态，只当历史记录、不复活。
  const isActiveTask = (s: FulfillmentStatus): boolean => s !== FulfillmentStatus.CANCELLED;
  // 全单是否已（含本次新建）存在「活动」签证任务 —— 用于订单级「需要签证」去重，避免重复建。
  let hasVisaTask = items.some((item) =>
    item.fulfillmentTasks.some(
      (t) => t.type === FulfillmentType.VISA_APPLICATION && isActiveTask(t.status),
    ),
  );
  // 乘客级一票否决：全员自备签 → 本单不建签证任务（判定见 visa-need.ts）。
  // 签证台按 visaExempt=false 过滤乘客，全员自备签时任务点进去是零乘客的空壳。
  // 懒查 + 记忆：只有真要建签证任务时才回表，不给「与签证无关的单」平白加一次查询。
  let paxForVisa: Array<{ visaExempt: boolean }> | null = null;
  const loadPaxForVisa = async (): Promise<Array<{ visaExempt: boolean }>> => {
    if (paxForVisa === null) {
      paxForVisa = await tx.passenger.findMany({
        where: { orderId },
        select: { visaExempt: true },
      });
    }
    return paxForVisa;
  };
  for (const item of items) {
    // 该订单项需要的任务类型集合
    const desiredTypes =
      item.kind === OrderItemKind.BUNDLE
        ? await resolveBundleFulfillmentTypes(tx, item.bundleId)
        : (() => {
            const t = KIND_TO_FULFILLMENT_TYPE[item.kind];
            return t ? [t] : [];
          })();
    if (desiredTypes.length === 0) continue;

    // 幂等：跳过已有「活动」任务的类型，只补缺失的（含被取消后复活时重建 PENDING；支持套餐多类型部分补建）
    const existingTypes = new Set(
      item.fulfillmentTasks.filter((t) => isActiveTask(t.status)).map((t) => t.type),
    );
    for (const type of desiredTypes) {
      if (existingTypes.has(type)) continue;
      // 商品级涉签（VISA 行 / 含签证组件套餐）也要过订单级与乘客级这两关：
      // 判定整条交给 orderNeedsVisaTask（visa-need.ts 的单一口径），别在这里手抄半条——
      // 录单选了「不需要签证」的单，商品级涉签压不过订单级的一票否决。
      if (
        type === FulfillmentType.VISA_APPLICATION &&
        !orderNeedsVisaTask({
          visaStatus: order?.visaStatus,
          hasVisaScope: true, // 走到这里说明本行商品级确已涉签
          passengers: await loadPaxForVisa(),
        })
      ) {
        continue;
      }
      const task = await tx.fulfillmentTask.create({
        data: {
          orderItemId: item.id,
          type,
          status: FulfillmentStatus.PENDING,
        },
      });
      newTaskIds.push(task.id);
      if (type === FulfillmentType.VISA_APPLICATION) hasVisaTask = true;
    }
  }

  // 订单级「需要签证」：本单需签且全程没有任何签证任务（VISA 行 / 套餐签证组件都没产生）
  // → 补一条 VISA_APPLICATION，挂到首个订单项（FulfillmentTask 仅有 orderItemId 外键，
  // 无 Order 直挂）。已有签证任务则跳过，保证重跑 PAID 不重复建（幂等）。
  // `orderVisaStatusRequiresVisa` 只作「能否省掉回表」的廉价前置筛：订单级都不需签就不必查乘客。
  // 真正的判定权威始终是 orderNeedsVisaTask（三根轴收口在那里）。
  if (
    !hasVisaTask &&
    items.length > 0 &&
    orderVisaStatusRequiresVisa(order?.visaStatus) &&
    orderNeedsVisaTask({
      visaStatus: order?.visaStatus,
      passengers: await loadPaxForVisa(),
    })
  ) {
    const task = await tx.fulfillmentTask.create({
      data: {
        orderItemId: items[0].id,
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.PENDING,
      },
    });
    newTaskIds.push(task.id);
  }
  return newTaskIds;
}

/**
 * 签证任务锚点解析 —— 回答两件事：「本单商品级涉不涉签」+「签证任务该挂在哪一行」。
 *
 * FulfillmentTask 只有 orderItemId 外键、没有 Order 直挂，所以订单级需签的单也得找一行挂着。
 * 优先级（建单路径与事件驱动同步共用，保证同一单永远挑同一行，不会挂出两条锚点不同的任务）：
 *   1. VISA 订单项；
 *   2. 含签证组件的 BUNDLE 订单项；
 *   3. 订单级 visaStatus 需签时的首个订单项（兜底）。
 *
 * `hasVisaScope` 只表示**商品级**涉签（前两级命中）——订单级那根轴由调用方把 visaStatus
 * 一并交给 orderNeedsVisaTask 判定，两根轴不在此处提前合流，免得口径糊在一起。
 */
async function resolveVisaTaskAnchor(
  tx: Prisma.TransactionClient,
  items: ReadonlyArray<{ id: string; kind: OrderItemKind; bundleId: string | null }>,
  visaStatus: VisaRequirement | null | undefined,
): Promise<{ anchorItemId: string | null; hasVisaScope: boolean }> {
  if (items.length === 0) return { anchorItemId: null, hasVisaScope: false };
  const visaItem = items.find((item) => item.kind === OrderItemKind.VISA);
  if (visaItem) return { anchorItemId: visaItem.id, hasVisaScope: true };
  for (const item of items) {
    if (item.kind !== OrderItemKind.BUNDLE) continue;
    const types = await resolveBundleFulfillmentTypes(tx, item.bundleId);
    if (types.includes(FulfillmentType.VISA_APPLICATION)) {
      return { anchorItemId: item.id, hasVisaScope: true };
    }
  }
  if (orderVisaStatusRequiresVisa(visaStatus)) {
    return { anchorItemId: items[0].id, hasVisaScope: false };
  }
  return { anchorItemId: null, hasVisaScope: false };
}

/**
 * 下单（CREATE）时即建签证任务 —— 让「录进去但还没付款」的需签证单也能进签证台。
 *
 * 背景：完整履约任务（机票/酒店/接送/签证）在 PAID 时才由 createFulfillmentTasks 生成，
 * 于是未付款订单一个任务都没有，签证台（读 VISA_APPLICATION 任务）看不到要送签的单。
 * 这里只在下单时**提前补签证那一项**，其余岗位任务仍留到 PAID。
 *
 * 「需要签证」判定（任一成立，与 PAID 路径一致）：
 *   - 订单级 visaStatus = NEEDED / E_VISA
 *   - 含 VISA 订单项
 *   - 含 BUNDLE 订单项，且该套餐组件含 VISA
 * 但订单级 visaStatus = NOT_NEEDED / HAS_VISA 一票否决以上三条（口径见 visa-need.ts 的
 * orderNeedsVisaTask）：录单明说「不需要签证」或「已签证」的单，含签证组件的套餐也不建任务，
 * 不再依赖录单弹窗的前端联动。
 *
 * 任务锚点与 PAID 路径保持一致（VISA 项 → 该项；含签证套餐 → 该套餐项；
 * 否则订单级需签 → 首个订单项），并按「已存在 VISA 任务即跳过」幂等：
 * PAID 时 createFulfillmentTasks 按订单项的已有任务类型去重，能识别这条早建任务而不重复建。
 */
async function createVisaTaskAtCreation(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<string[]> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true },
  });
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { type: true } },
    },
  });
  if (items.length === 0) return [];

  // 幂等：已存在任意签证任务 → 不重复建
  const alreadyHasVisaTask = items.some((item) =>
    item.fulfillmentTasks.some((t) => t.type === FulfillmentType.VISA_APPLICATION),
  );
  if (alreadyHasVisaTask) return [];

  // 锚点选择（与 PAID 路径一致）：优先 VISA 项 → 含签证套餐项 → 订单级需签时首个订单项
  const { anchorItemId } = await resolveVisaTaskAnchor(tx, items, order?.visaStatus);
  if (!anchorItemId) return [];

  // 乘客级一票否决：全员自备签 → 不建（与 PAID 路径同一判定）。
  // 放在锚点选定之后：与签证无关的单在上面就 return 了，不必平白查一次乘客。
  const paxForVisa = await tx.passenger.findMany({
    where: { orderId },
    select: { visaExempt: true },
  });
  if (
    !orderNeedsVisaTask({
      visaStatus: order?.visaStatus,
      hasVisaScope: true, // 走到这里说明锚点已选中 → 本单商品级/订单级确已涉签
      passengers: paxForVisa,
    })
  ) {
    return [];
  }

  const task = await tx.fulfillmentTask.create({
    data: {
      orderItemId: anchorItemId,
      type: FulfillmentType.VISA_APPLICATION,
      status: FulfillmentStatus.PENDING,
    },
  });
  return [task.id];
}

/** 某订单「签证任务该是什么样」的只读快照（判定 + 现状），见 evaluateOrderVisaTaskState。 */
export interface OrderVisaTaskState {
  orderNumber: string;
  visaStatus: VisaRequirement | null;
  /** 订单状态（判定时要看：取消族终态一律判「不需要任务」）。 */
  status: OrderStatus;
  /** 软删时间戳（非 null = 已进回收站，同样判「不需要任务」）。 */
  deletedAt: Date | null;
  /**
   * 本单是否已「不参与履约」——取消族终态（FULFILLMENT_TERMINATING_STATUSES）或已软删。
   * 为真时 needed 恒 false，与订单状态流转时把履约任务终态化的口径同源，不另立一套。
   */
  inactive: boolean;
  /** 权威判定（visa-need.ts 的 orderNeedsVisaTask）：本单还要不要我方代办签证。 */
  needed: boolean;
  /** 需要建任务时该挂的订单项；null = 无处可挂（如空订单项的单）。 */
  anchorItemId: string | null;
  passengerCount: number;
  /** 本单现存的全部签证任务（含各自状态，CANCELLED 也在内）。 */
  visaTasks: Array<{ id: string; status: FulfillmentStatus }>;
}

/**
 * 只读重算「本单的签证任务该是什么样」—— 判定与现状一并返回，一行库都不写。
 *
 * syncVisaTasksForOrder（写侧）与存量清理脚本的 dry-run 共用本函数：
 * 预览看到的判定，就是 --apply 会依据的那个判定，两边不会各算一套。
 * 订单不存在 → null。
 *
 * 「不参与履约」的两类单一律判 needed=false，不看签证口径（P1-6）：
 *   · 取消族终态（FULFILLMENT_TERMINATING_STATUSES：CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED）——
 *     订单流转到这些状态时履约任务已被一并终态化，若这里还按签证口径判「需要」，
 *     一次改备注（改订单级签证状态）就会给已取消的单凭空补出一条 PENDING，签证台上冒出
 *     根本不用办的活。DRAFT 不在此列：它只是座位账口径上的释放型，不是「订单被取消」。
 *   · 已软删（deletedAt≠null，回收站单）—— 全站列表/导出都已让它消失，签证台更不该看见。
 * 反向也成立：这两类单里残留的 PENDING 任务，会被写侧按 needed=false 顺手撤掉（正确的清理）。
 */
async function evaluateOrderVisaTaskState(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderVisaTaskState | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true, orderNumber: true, status: true, deletedAt: true },
  });
  if (!order) return null;
  // deletedAt 用 Boolean 判空（null/undefined 一并当「未删」）：Date 对象恒为真值，
  // 调用方少 select 一个字段时按「未删」保守放行，不会把正常单误判成回收站单。
  const inactive =
    Boolean(order.deletedAt) || FULFILLMENT_TERMINATING_STATUSES.includes(order.status);

  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { id: true, type: true, status: true } },
    },
  });
  const passengers = await tx.passenger.findMany({
    where: { orderId },
    select: { visaExempt: true },
  });
  const { anchorItemId, hasVisaScope } = await resolveVisaTaskAnchor(tx, items, order.visaStatus);
  return {
    orderNumber: order.orderNumber,
    visaStatus: order.visaStatus,
    status: order.status,
    deletedAt: order.deletedAt,
    inactive,
    needed:
      !inactive && orderNeedsVisaTask({ visaStatus: order.visaStatus, hasVisaScope, passengers }),
    anchorItemId,
    passengerCount: passengers.length,
    visaTasks: items.flatMap((item) =>
      item.fulfillmentTasks
        .filter((t) => t.type === FulfillmentType.VISA_APPLICATION)
        .map((t) => ({ id: t.id, status: t.status })),
    ),
  };
}

/** syncVisaTasksForOrder 的执行结果（供调用方审计/回显，脚本按此打印清单）。 */
export interface VisaTaskSyncResult {
  /** 重算后的权威判定：本单还要不要我方代办签证。 */
  needed: boolean;
  /** 本次被自动撤销（PENDING → CANCELLED）的签证任务 id。 */
  cancelledTaskIds: string[];
  /** 本次被自动补建（PENDING）的签证任务 id。 */
  createdTaskIds: string[];
}

/**
 * 签证任务事件驱动同步 —— 「需求变了，任务跟着变」。
 *
 * 背景：建任务的三条路径（建单 createVisaTaskAtCreation / PAID createFulfillmentTasks /
 * 补录地面项 addGroundItem）全是**只补不删**。于是把订单改成「不需要签证」、或把乘客全部
 * 改成自备签之后，早先建的那条 PENDING 任务还挂在签证台上，签证岗看到的是一条永远办不掉的
 * 「待处理」——点进去还是零乘客（签证台按 visaExempt=false 过滤乘客展示）。
 *
 * 本函数按 visa-need.ts 的权威口径（orderNeedsVisaTask：订单级需签 或 商品级涉签，且至少
 * 一位乘客要我方代办）重算，并把任务对齐到这个结论：
 *   - 不需要 → 该单**仅 PENDING（还没人动手）**的签证任务置 CANCELLED；
 *     IN_PROGRESS / CONFIRMED / FAILED 一律不碰（已经在办、或已出结果的活不能被系统悄悄抹掉，
 *     要撤得由签证岗自己判断）；CANCELLED 本就是终态，同样不碰。
 *   - 需要但一条「活动」任务都没有 → 按与建单同一套锚点逻辑补建一条 PENDING。
 *
 * 幂等：结论与现状一致时零写入；重复调用不会重复建、也不会把同一条任务撤两次
 *（updateMany 的 where 二次卡 status=PENDING，与并发的签证岗接单严格串行）。
 *
 * 事务：接受 tx（挂接点都在各自事务内调用，判定与写入之间没有窗口）。审计走全局 prisma
 * 的 fire-and-forget（与本文件其它审计同款），**不进业务事务**——事务回滚时审计不回滚，
 * 宁可多一条「系统撤了任务」的记录，也不要主流程被审计写入拖挂。
 */
async function syncVisaTasksForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  actor?: { userId?: string; label?: string; role?: UserRole | 'SYSTEM' },
): Promise<VisaTaskSyncResult> {
  const empty: VisaTaskSyncResult = { needed: false, cancelledTaskIds: [], createdTaskIds: [] };
  const state = await evaluateOrderVisaTaskState(tx, orderId);
  if (!state) return empty;
  const { needed, anchorItemId, visaTasks, passengerCount } = state;

  if (!needed) {
    const pendingIds = visaTasks
      .filter((t) => t.status === FulfillmentStatus.PENDING)
      .map((t) => t.id);
    if (pendingIds.length === 0) return { ...empty, needed: false };
    await tx.fulfillmentTask.updateMany({
      // where 再卡一次 PENDING：判定与写入之间若有签证岗并发接单（PENDING→IN_PROGRESS），
      // 这条 update 自然落空，绝不把「已经在办」的活撤掉。
      where: { id: { in: pendingIds }, status: FulfillmentStatus.PENDING },
      data: { status: FulfillmentStatus.CANCELLED },
    });
    void writeAudit({
      actor: { role: 'SYSTEM', ...actor },
      action: 'VISA_TASK_AUTO_CANCELLED',
      targetType: AuditTargetType.ORDER,
      targetId: orderId,
      targetLabel: state.orderNumber,
      after: {
        reason: '订单已不需要我方代办签证（订单级签证状态改为不需要 / 全员自备签）',
        taskIds: pendingIds,
        visaStatus: state.visaStatus,
        passengerCount,
      },
      severity: AuditSeverity.INFO,
    });
    return { needed: false, cancelledTaskIds: pendingIds, createdTaskIds: [] };
  }

  // 需要签证：已有任一「活动」任务（非 CANCELLED）就什么都不做——幂等，且不与
  // 签证岗手上正在办的那条抢。CANCELLED 视为不存在（可能正是上一轮本函数撤的），
  // 需求改回来时按锚点重新补建一条 PENDING，而不是去复活终态任务。
  const hasActiveVisaTask = visaTasks.some((t) => t.status !== FulfillmentStatus.CANCELLED);
  if (hasActiveVisaTask || !anchorItemId) return { ...empty, needed: true };

  // 补建前贴身再查一次「活动任务」（同事务内 re-check）：上面那次读发生在整段判定的开头，
  // 期间的并发同步（两个请求同时改签证状态 / 改备注与换人并发）可能已经补建过一条。
  // 库上没有唯一约束（迁移成本大），这道 re-check 把「都读到无任务 → 各建一条」的窗口
  // 收到最小；调用方另把撤/建整段放进一个 $transaction，进一步缩短窗口。
  const activeNow = await tx.fulfillmentTask.findFirst({
    where: {
      type: FulfillmentType.VISA_APPLICATION,
      status: { not: FulfillmentStatus.CANCELLED },
      orderItem: { orderId },
    },
    select: { id: true },
  });
  if (activeNow) return { ...empty, needed: true };

  const task = await tx.fulfillmentTask.create({
    data: {
      orderItemId: anchorItemId,
      type: FulfillmentType.VISA_APPLICATION,
      status: FulfillmentStatus.PENDING,
    },
  });
  void writeAudit({
    actor: { role: 'SYSTEM', ...actor },
    action: 'VISA_TASK_AUTO_RECREATED',
    targetType: AuditTargetType.ORDER,
    targetId: orderId,
    targetLabel: state.orderNumber,
    after: {
      reason: '订单重新需要我方代办签证，已补建待处理签证任务',
      taskIds: [task.id],
      visaStatus: state.visaStatus,
      passengerCount,
    },
    severity: AuditSeverity.INFO,
  });
  return { needed: true, cancelledTaskIds: [], createdTaskIds: [task.id] };
}

export {
  createFulfillmentTasks,
  resolveBundleFulfillmentTypes,
  createVisaTaskAtCreation,
  evaluateOrderVisaTaskState,
  syncVisaTasksForOrder,
};

// ════════════════════════════════════════════════════════════════════
// 佣金链路计算 — 当订单转 PAID 时调用，为卖家代理 + 所有上级代理创建 CommissionRecord
//
// 级联模型（child rate ≤ parent rate 不变式）：
//   - 卖家代理（链底）拿: seller.rate × baseAmount
//   - 卖家上级拿: (parent.rate - seller.rate) × baseAmount（即 spread）
//   - 再上级拿: (grandparent.rate - parent.rate) × baseAmount
//   - ...一直走到根代理或没规则的代理
//
// 如果某代理对该 productKind 没有 CommissionRule，视作 rate=0（父级会继续"吃"这部分）。
// 每条 OrderItem 单独走一次链路（因为 productKind 可能不同）。
// ════════════════════════════════════════════════════════════════════
// BUNDLE 是独立一档费率，不复用 FLIGHT 档：套餐单会拆成 FLIGHT 腿（机票收入）+ BUNDLE 行
// （地面+加项收入），两行金额相加即全包价、互不重叠，故两者同时计提不构成重复计佣。
// 计佣基数就是 BUNDLE 行自身的 amount，不去拆套餐的组件。
const ORDER_ITEM_KIND_TO_PRODUCT_KIND: Partial<Record<OrderItemKind, ProductKind>> = {
  FLIGHT: ProductKind.FLIGHT,
  HOTEL: ProductKind.HOTEL,
  TRANSFER: ProductKind.TRANSFER,
  VISA: ProductKind.VISA,
  BUNDLE: ProductKind.BUNDLE,
};

async function createCommissionsForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  sellerAgentId: string,
  orderNumber?: string | null,
  // 唯一的行为开关，只为「一次性补提脚本的 dry-run」而存在（见文件末尾的导出说明）：
  // dry-run 会把本函数整段跑在一个**最后回滚掉的事务**里，用回滚后作废的写入换取
  // 「与线上计提逐分钱一致」的预览。但第 4 步的零计提审计走的是全局 prisma（不在 tx 里），
  // 回滚不掉——dry-run 会往审计表里刷一批 COMMISSION_ACCRUAL_EMPTY 的幽灵记录，
  // 财务翻审计日志时会以为真发生过计提。故 dry-run 传 false 把它闭掉。
  // 线上调用方不传 = undefined ≠ false → 行为与改动前完全一致（--apply 同样照常落审计）。
  options?: { emitEmptyAccrualAudit?: boolean },
) {
  // 0. 幂等：粒度是 **(订单, productKind)**，不是「这单有没有任意一条记录」。
  // _updateStatusWithinTx 只在 toStatus==='PAID' 时调用本函数，正常状态机每单只会经过一次
  // PENDING_PAYMENT→PAID，所以只会跑一次。唯一能让同一订单二次触达 PAID 的路径是 admin force
  // （如误操作 force CANCELLED→PAID"复活"一张已释放单）——没有这层幂等保护就会对同一笔订单重复
  // 计佣（下面按链路逐级 create 一遍 CommissionRecord，两次共 2N 条，代理端看见的应得佣金翻倍）。
  // 这个必须防的场景，per-productKind 粒度一样防得住：已建过记录的那一档会被跳过。
  //
  // 为什么从「整单」收细到「按档」：套餐单付款时机票腿命中 FLIGHT 费率建了记录、BUNDLE 档没配
  // 费率建不出记录，整单粒度的闸会把这张单**永久锁死**——将来费率配齐了也不敢跑补提脚本，
  // 一跑就把机票那部分重复计提。按档判定后补提可安全重跑：只补缺的档，已有的档原样跳过。
  //
  // 仍然不区分 status（ACCRUED/REVERSED/SETTLED 都算"这一档已生成过"）：
  //   · 冲销（退款/取消）走的是「原记录翻 REVERSED / 另建负数补偿记录」，钱账已经平了；
  //     若这里把 REVERSED 当作"没跑过"，force 复活一张退过款的单就会在负数记录之上再计一遍
  //     正数，代理凭空多拿一份——这正是原闸要防的事故，语义必须原样保留。
  //   · 补提脚本要补的是「从来没建过记录」的档，那种档在这张表里一条都没有（任何 status 都没有），
  //     所以不区分 status 不会挡住补提。
  const accruedKindRows = await tx.commissionRecord.findMany({
    where: { orderId },
    select: { productKind: true },
    distinct: ['productKind'],
  });
  const accruedKinds = new Set<ProductKind>(accruedKindRows.map((r) => r.productKind));

  // 1. 拉订单项
  // 必须联查班次的 departureTime/departureTz：下面要用 deriveOrderDepartDate 派生「整单出发日」
  // 作为费率比对基准，而该函数是「依赖已联查的行数据、不另发查询」的——扁平 findMany 拿不到
  // flightSchedule，航班部分会静默落空退化成只看 hotelCheckIn（纯机票单直接派生出 null），
  // 费率就比错了且没有任何报错。select 只取这两列，对事务的额外开销可忽略。
  const items = await tx.orderItem.findMany({
    where: { orderId },
    include: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
  });
  if (items.length === 0) return;

  // 1.2 幂等闸的另一半：本单还有哪些档没计提过。
  // 全部档都已计提过（且确实有计提过的档）→ 什么都不用做，提前 return，连代理链路都不必解析。
  // 「一个可计提档都没有」（如纯保险单）不在此列 —— 那种单要一路走到底，落零计提审计（见 4）。
  const pendingKinds = new Set<ProductKind>();
  for (const item of items) {
    const pk = ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind];
    if (pk && !accruedKinds.has(pk)) pendingKinds.add(pk);
  }
  if (pendingKinds.size === 0 && accruedKinds.size > 0) return;

  // 1.5 费率比对基准 = 本单「出发日」，不是计提当刻（new Date()）。
  // 口径（财务）：佣金按出发日算——例如「2026-09-01 及以后起飞的订单才开始计佣金」，靠给规则配
  //   effectiveFrom=2026-09-01 落地；8/30 起飞的单即使今天下单、今天付款也不该吃到这档费率。
  //   反过来，今天付款、9 月才飞的单要按 9 月那档算——这正是改成比出发日的意义。
  // 整单出发日复用 deriveOrderDepartDate（订单列表「出发日期」列同一函数），不另写一套取最早的
  //   逻辑：取最早航段的当地出发日，无航段回退最早入住日。往返单按去程（最早）判，
  //   例如去程 8/30、回程 9/2 → 算 8/30 → 不计——保证「列表所见 = 计佣所依」。
  // 改签不追溯是有意为之：佣金只在本函数唯一触达点计提一次并写死，事后改签把出发日改了也不重算。
  //   佣金一旦入账即为代理的既得应收，不能被后续行程变更翻旧账；函数开头的幂等闸保证只算一次。
  const departDate = deriveOrderDepartDate(items);
  // 比的是「出发日这一整天」而不是当天零点：effectiveFrom 存的是规则保存那一刻的完整时间戳
  //   （运营下午改费率就是当天 15:xx，不是零点），拿零点去比会让规则在自己生效当天匹配不上，
  //   白差一天。语义 = 规则的生效区间与出发日这一天有交集（两端含边界）。
  // 出发日为 null（既无航段也无酒店的单，如纯保险/纯手工费单）→ 回退到计提当刻，保持改动前的
  //   行为；绝不因为派生不出出发日就静默跳过计提，那会让代理凭空少一笔应收。
  //
  // 日窗口一律按**公司业务日（上海）**锚定，不用 UTC：财务说的「9 月 1 日起飞开始算返佣」
  //   指的是北京时间的 9 月 1 日。按 UTC 锚会把北京时间 9/1 凌晨 0–8 点起飞的航班算成 8/31，
  //   在 9/1 这条硬分界线上凭空吃掉一批单的佣金。
  // 关键不变式：**此处锚点必须与 PUT /agents/:id/commission-rules 写 effectiveFrom 的锚点一致**
  //   （那边同样是 localToUtc(日期,'00:00',BUSINESS_TZ)）。两边一致时该比较等价于纯日期字符串
  //   比较，无时区歧义；任一边改回 UTC 零点都会系统性差一天。
  const rateBasisStart = departDate ? localToUtc(departDate, '00:00', BUSINESS_TZ) : new Date();
  // 出发日当天 23:59:59.999（上海）= 次日零点减 1 毫秒，不留 23:59:00~23:59:59 的缝。
  const rateBasisEnd = departDate
    ? new Date(rateBasisStart.getTime() + 24 * 60 * 60 * 1000 - 1)
    : rateBasisStart;

  // 2. 算链路（seller → parent → grandparent ...）
  const chain: Array<{ agentId: string; depth: number }> = [];
  let cur: string | null = sellerAgentId;
  let depth = 0;
  while (cur) {
    chain.push({ agentId: cur, depth });
    const parentRow: { parentAgentId: string | null } | null = await tx.agent.findUnique({
      where: { id: cur },
      select: { parentAgentId: true },
    });
    cur = parentRow?.parentAgentId ?? null;
    depth++;
    if (depth > 10) break; // 防御：层级超 10 级直接断
  }

  // 2.5 折扣分摊：计佣基数是「实际收到的钱」，不是订单行毛额。
  //
  // 口径（财务已拍板）：返佣按实收算，折扣要从计佣基数里扣掉。DISCOUNT 行（同业立减、录单
  // 让利、代理结算价负差…金额本身为负）不在 ORDER_ITEM_KIND_TO_PRODUCT_KIND 里，逐行毛额
  // 计提时被 `if (!productKind) continue` 跳过 —— 折扣完全没扣，代理单会系统性多付。
  //
  // 算法（折扣按可计提行的毛额比例分摊）：
  //   可计提毛额 G = Σ(映射表里有 productKind 的行 amount)
  //   折扣总额   D = Σ(DISCOUNT 行 amount)     // 本身为负
  //   可计提净额 N = max(0, G + D)
  //   每行计佣基数 = 行 amount × (N / G)
  // 例：BUNDLE 450 + FLIGHT 800 + FLIGHT 1000 + DISCOUNT −1032
  //     → G=2250、D=−1032、N=1218、ratio=0.541333…
  //     → 243.60 / 433.07 / 541.33，合计 1218.00 = 订单实收。
  //
  // 只摊到「可计提行」上，不摊给 FEE/INSURANCE/GUIDE/UPGRADE_CHANGE/OVERSALE：
  //   · FEE 是机建燃油等代收代付（转手交航司，本就不打折），把它算进分母会稀释比例、
  //     让计佣基数虚高，等于折扣没扣干净；
  //   · 其余几类另有口径且本来就不计佣，进分母同样只会把基数抬高。
  //   把它们排除在分母外 = 折扣全额由可计提行承担，这是对代理最保守（绝不多付）的口径。
  //
  // ⚠️ 下面这处不对称是**财务明确拍板保留的，不是遗漏，复审时不要"顺手修好"**：
  //   结算价与系统标价的差额按正负走两个不同的行类型（见 buildSettlementTotalItem）——
  //     谈定价 **低于** 标价 → 落 DISCOUNT（负）→ **扣减**计佣基数；
  //     谈定价 **高于** 标价 → 落 FEE（正）  → **不加**计佣基数。
  //   即「少收的要减佣、多收的不加佣」，两头都对我方有利、永远少付不多付。
  //   严格按「按实收算」本该把后者也加进基数，财务权衡后选择维持现状（连同机建燃油一并不计）。
  //   真要改，得先按 metadata.reasonCode 给 FEE 行分语义（SETTLEMENT / MISC_FEE / ROOM_DIFF …），
  //   因为 FEE 这个枚举被多种含义复用，整体放开会把代收代付也算进去。
  //
  // G ≤ 0（整单只有折扣行 / 没有任何可计提行）→ ratio=0 → 所有基数为 0 → 不建任何记录，
  //   并落零计提审计（见 4）。绝不用负基数或 1 兜底 —— 那会算出负佣金或按毛额多付。
  let grossCommissionable = 0;
  let discountTotal = 0;
  for (const item of items) {
    if (ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind]) {
      grossCommissionable += Number(item.amount);
    } else if (item.kind === OrderItemKind.DISCOUNT) {
      discountTotal += Number(item.amount);
    }
  }
  grossCommissionable = round2(grossCommissionable);
  discountTotal = round2(discountTotal);
  // N 先 round2 再相除：G/D 都是 2 位小数金额，先规整能消掉浮点累加的尾巴（如 …0000001）。
  const netCommissionable = Math.max(0, round2(grossCommissionable + discountTotal));
  const discountRatio = grossCommissionable > 0 ? netCommissionable / grossCommissionable : 0;

  // 3. 为每个 item 按 productKind 生成 records
  let createdCount = 0;
  for (const item of items) {
    const productKind = ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind];
    // 映射表里没有的订单行 kind 不参与计提，当前为：
    //   INSURANCE / FEE（机建燃油）/ DISCOUNT / GUIDE / UPGRADE_CHANGE / OVERSALE。
    // 改 OrderItemKind 时记得回来核一遍这份名单，别让新 kind 静默漏计（BUNDLE 就是这么漏的）。
    // DISCOUNT 在这里照旧跳过 —— 它不是"一档产品"，而是通过上面的 ratio 摊进各可计提行的基数。
    if (!productKind) continue;
    // 幂等（按档）：这一档已经有记录了 → 跳过，连费率都不必查。
    if (accruedKinds.has(productKind)) continue;

    // 计佣基数 = 行毛额 × 折扣分摊比例（无折扣时 ratio=1，等于毛额，存量语义不变）。
    // 逐行 round2：每行误差 ≤ 0.005 元，Σ基数 与 N 的偏差上界 = 0.005 × 可计提行数
    //   （常见 2–5 行 → ≤ 2.5 分），且佣金金额还要再乘费率，落到钱上远小于 1 分，无可见漂移。
    const baseAmount = round2(Number(item.amount) * discountRatio);
    // 基数为 0（折扣吃光全单，或行本身就是 0 元赠品）→ 不建记录：0 元佣金记录只会污染结算单。
    if (baseAmount <= 0) continue;

    // 取链路上每个代理对该 productKind 的 rate（在本单出发日当天生效的那档，见 1.5 的口径说明）
    // 按 effectiveFrom DESC 排序，每个 agent 取第一条 = 出发日当天最新生效的规则
    // （之前是"取最大 rate"，降档后还按高佣跑，是 bug）
    const rules = await tx.commissionRule.findMany({
      where: {
        agentId: { in: chain.map((c) => c.agentId) },
        productKind,
        effectiveFrom: { lte: rateBasisEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: rateBasisStart } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    const rateByAgent = new Map<string, number>();
    for (const r of rules) {
      if (!rateByAgent.has(r.agentId)) {
        rateByAgent.set(r.agentId, Number(r.rate));
      }
    }

    // 沿着链路从底向上，每个代理拿 (自己 rate - 下级 rate) × baseAmount（基数已是净额）
    let lowerRate = 0; // 下级代理的 rate（seller 的 "下级" 是 0，表示没有）
    for (let i = 0; i < chain.length; i++) {
      const { agentId, depth: d } = chain[i];
      const thisRate = rateByAgent.get(agentId) ?? 0;
      // 不变式：child rate ≤ parent rate — 若违反，spread 为负，跳过
      const netRate = thisRate - lowerRate;
      if (netRate > 0.00005) {
        const amt = Math.round(baseAmount * netRate * 100) / 100;
        await tx.commissionRecord.create({
          data: {
            agentId,
            orderId,
            productKind,
            baseAmount: new Prisma.Decimal(baseAmount),
            rate: new Prisma.Decimal(netRate),
            amount: new Prisma.Decimal(amt),
            chainDepth: d,
            status: CommissionStatus.ACCRUED,
          },
        });
        createdCount++;
      }
      // 下一轮循环：上一级代理看本级作为"下级"
      if (thisRate > lowerRate) lowerRate = thisRate;
    }
  }

  // 4. 零计提可见性：代理单走完整条链路，一条 CommissionRecord 都没建。
  // 旧实现在这里静默返回——零日志、零审计、零告警，财务事后无从发现「这单为什么没佣金」。
  // 最常见的原因是费率没配（新代理 / 新产品档），其次是折扣把可计提净额吃光。落一条 WARNING
  // 审计，把查证需要的信息一次带全：订单号、卖家代理与整条链路、出发日（费率比对基准）、
  // 涉及的 productKind、以及毛额/折扣/净额三个数。
  //
  // 事务边界：writeAudit 走的是全局 prisma（不是本函数的 tx），所以审计写入既不进业务事务、
  // 也不会因为业务事务回滚而丢/留；severity=WARNING 时它内部 catch 住所有异常只打 console
  // （只有 CRITICAL 才上抛），故审计失败绝不会影响计提本身。用 void 不 await，不让审计的
  // 网络往返把事务多按住一个 RTT。
  if (createdCount === 0 && options?.emitEmptyAccrualAudit !== false) {
    void writeAudit({
      actor: { role: 'SYSTEM' },
      action: 'COMMISSION_ACCRUAL_EMPTY',
      targetType: AuditTargetType.COMMISSION,
      targetId: orderId,
      targetLabel: orderNumber ?? orderId,
      severity: AuditSeverity.WARNING,
      after: {
        orderId,
        orderNumber: orderNumber ?? null,
        sellerAgentId,
        agentChain: chain.map((c) => c.agentId),
        departDate,
        productKinds: [...pendingKinds],
        grossCommissionableCny: grossCommissionable,
        discountCny: discountTotal,
        netCommissionableCny: netCommissionable,
      },
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 一次性补提脚本（scripts/backfill-agent-commissions.ts）复用出口。
//
// 为什么必须导出、而不是让脚本自己算一遍：计提口径是「按出发日取费率 + 折扣按毛额比例分摊
// 出净额基数 + 沿代理链取差额费率」三件事的组合，任何一处重写都会与本函数漂移，补出来的钱
// 就和系统自己算的对不上——钱路径上这种漂移是不可接受的。脚本因此**整段调用本函数**
// （dry-run 时跑在一个最后回滚的事务里），产出的记录逐分钱都是线上那段代码算的。
//
// deriveOrderDepartDate 一并导出只为报表：明细里给财务看的「出发日」必须就是上面 1.5 用作
// 费率比对基准的那一个日期，另写一份取最早日期的逻辑同样会漂。
// ────────────────────────────────────────────────────────────────────────────
export { createCommissionsForOrder, deriveOrderDepartDate };
