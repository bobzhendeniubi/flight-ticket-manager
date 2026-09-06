// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  CabinClass,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  Prisma,
  SeatLockStatus,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  DuplicatePassengerError,
  NotFoundError,
} from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import {
  composePassengerFullName,
  normalizePassengerFullName,
  splitPassengerFullName,
} from '../../../lib/passenger-name.js';
import { resolveBundleNights } from '../../products/bundle-nights.js';
import { parseVisaExpressTiers, type VisaExpressTier } from '../../products/products.schemas.js';
import { localDate } from '../../finances/finances.cost.service.js';
import {
  computeBundleGroundCost,
  flightSnapshotKey,
  loadBundleComponentCosts,
  resolveFlightCostSnapshots,
} from './item-cost-snapshot.js';
import { getSettlementRate } from '../../settlement-rates/settlement-rates.service.js';
import { BUNDLE_ROUTE_SELECT, bundleRouteKey } from '../../products/bundle-route.js';
import { getFlightSettlementRate } from '../../settlement-rates/flight-settlement-rates.service.js';
import {
  resolveAgentSettlementDiscount,
  resolveRetailSettlementDiscount,
} from '../../settlement-discounts/settlement-discounts.service.js';
import {
  assertHotelPhysicalFit,
  assertRandomTierFit,
  randomStarTierLabel,
} from '../../hotel-control/hotel-control.service.js';
import {
  cityLabel,
  normalizeCityCode,
  RANDOM_TIER_LEGACY_CITY_CODE,
} from '../../hotel-control/hotel-city.js';
import { env } from '../../../config/env.js';
import { OPERATION_FEE_CNY_PER_ORDER } from '../order-cost-items.service.js';
import { derivePtcByAge, earliestFlightDeparture } from '../pnr-export.js';
import { assertNoVisaContradiction } from '../../fulfillment/visa-state.js';
import { resolveSelfVisaDeductCny } from '../../products/self-visa-deduct.js';
import { PRICE_ADJUSTMENT_CAP_CNY, PRICE_ADJUSTMENT_REASON_LABEL } from '../orders.schemas.js';
import { heldSeatsForCabin } from '../../hold-orders/held-seats.js';
import type {
  BatchCreateOrdersBody,
  BatchPassengerInput,
  CreateOrderBody,
  OrderItemInput,
  PassengerInput,
  PriceAdjustmentInput,
  QuoteOrderBody,
  SettlementPreview,
} from '../orders.schemas.js';
import {
  assertHotelStaysFitWithinTx,
  assertRandomTierStaysFitWithinTx,
  buildStayNightDates,
  computeBundleAddOn,
  computeBundleGroundTotal,
  computeBundleOperationFeeTotal,
  computeBundleRoomsCharged,
  computeRequiredPassengerCount,
  derivePerPaxBundleOptions,
  HOTEL_SOLD_OUT_MESSAGE,
  type HotelStayOversellRecord,
  type RandomTierOversellRecord,
  resolveBundleBusinessUpgradeInput,
  resolveBundleBusinessUpgradeRate,
  resolveBundleHotelStamp,
  resolveBundleOccupancy,
  resolveRandomTierNightlyCost,
  splitSettlementPriceAcrossLegs,
  toProspectiveOccupancy,
} from './bundle-pricing.js';
import { computeBundleSeatSplit, takeSeatWithinTx } from './seat-inventory.js';
import {
  actorCan,
  addDaysToYmd,
  assertDisplayedTotalMatches,
  type AutoDiscountSummary,
  buildPerPassengerSettlementItem,
  buildPriceAdjustmentItem,
  buildSettlementDiscountItem,
  buildSettlementTotalItem,
  buildStarMismatchMessage,
  CABIN_ZH_LABEL,
  type DesignatedHotelStarGate,
  type DesignatedHotelStarMismatchOverride,
  type DuplicateCheckPassenger,
  type DuplicatePassengerConflict,
  formatSlashMonthDay,
  generateOrderNumber,
  type GuestRequester,
  isGuestRequester,
  isSettlementTierStarMismatch,
  isStaffEnteredOrder,
  NEAR_EXPIRY_SURCHARGE_CNY,
  type OrderRequester,
  passengerToData,
  PASSPORT_EXPIRY_SURCHARGE_DAYS,
  PRICE_TOLERANCE_CNY,
  type PricedOrderItem,
  RANDOM_TIER_INTERNAL_NO_CAP,
  resolveCalendarPerPaxBasis,
  resolveHotelOversellCap,
  resolveOrderAgentId,
  RETAIL_PAYMENT_TIMEOUT_MS,
  round2,
  SEAT_HOLDING_STATUSES,
  SETTLEMENT_TIER_STAR_RATING,
  shouldApplyRetailSettlementDiscount,
  syncOrderHasReturnLeg,
  syncOrderLegFlag,
} from './shared.js';
import { persistPassengerShares } from './passenger-shares.js';
import { createVisaTaskAtCreation } from './visa-sync.js';
import type { OrderService } from '../orders.service.js';

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
export function sanitizeFlightItemMetadata(
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
export function resolveRequestedExpressTierLabel(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const raw = metadata?.expressTierLabel;
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  return label.length > 0 ? label : null;
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

export function parseBatchYmd(value: string | undefined): Date | null {
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
 * 拉丁姓名比对键：一律收敛成规范化后的 `LAST/FIRST`。
 *
 * 姓/名两栏优先（航司标准写法），没有才回落 fullName。两边都先拆再拼，
 * 所以 `ZHANG SAN`（空格）与 `ZHANG/SAN`（斜线）算同一个人 —— 录单时这两种写法都会出现，
 * 按原样比对必然漏掉一半。拆不出名的单名（`MADONNA`）保持原样，不编造分隔。
 * 中文写在姓名栏里（如 fullName='张三'）同样能得到键，不额外特判。
 */
export function latinPassengerNameKey(p: DuplicateCheckPassenger): string | null {
  const composed = composePassengerFullName(p.lastName, p.firstName);
  const base = composed ?? (p.fullName ? normalizePassengerFullName(p.fullName) : '');
  if (!base) return null;
  const { lastName, firstName } = splitPassengerFullName(base);
  return composePassengerFullName(lastName, firstName);
}

/** 中文姓名比对键：去掉全部空白后比较（「张 三」与「张三」是同一个人）。空 → null（不参与比对）。 */
export function chinesePassengerNameKey(value?: string | null): string | null {
  const s = (value ?? '').replace(/\s+/g, '');
  return s || null;
}

/** 强录留痕的一行订单备注（无冲突 → null，调用方据此决定加不加这一行）。 */
export function duplicateForceNoteFor(
  conflicts: DuplicatePassengerConflict[],
  reason: string,
): string | null {
  if (conflicts.length === 0) return null;
  const orderNumbers = [...new Set(conflicts.flatMap((c) => c.orderNumbers))];
  return `重复乘客强录：与订单 ${orderNumbers.join('、')} ${reason}`;
}

/**
 * 占位单转正专用的事务内机票建单内核。
 * 调用方必须先在同一事务里消费 HoldOrder 的余座；本方法只负责复用订单号、订单事件、
 * 乘客落库、操作费与订单 CAS 扣座，不自行开启嵌套事务，也不改变普通创单路径。
 */
export async function createHoldConversionOrderWithinTx(
  svc: OrderService,
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
  await syncOrderLegFlag(tx, order.id);
  // 普通创单在事务内的签证任务内核：转正订单也必须从创建时进入签证台，不能等到
  // 事务提交后补写，避免订单已可见但履约台漏任务。
  await createVisaTaskAtCreation(tx, order.id);
  // 按人份额落库（R1）：转正单一建好就有完整的一套份额，不等读侧回填。
  await persistPassengerShares(tx, order.id);
  return { order, duplicateConflicts: conflictList };
}

// ════════════════════════════════════════════════════════════════════
// 下单
// ════════════════════════════════════════════════════════════════════
export async function createOrder(svc: OrderService, body: CreateOrderBody, requester: OrderRequester | GuestRequester) {
  // 游客 vs 登录用户：拆出统一的归属信息（userId/agentId/锁位归属/事件 actor）
  const isGuest = isGuestRequester(requester);
  const ownerUserId: string | null = isGuest ? null : requester.userId;
  const guest = isGuest ? requester.guest : null;

  // 录单调价/加项 + 本单结算总价 + 机票团队议价结算价：默认仅 ADMIN/STAFF 录单可用。服务端按认证
  // 身份判权限（不信前端）——公开散客/客户携带这些字段直接 400，杜绝对外接口被绕过手工改价。
  // flightSettlementPriceCny 会短路机票动态定价（priceAndValidateItems），公开下单口必须与 /orders/batch
  // 一样收口，否则匿名游客可传 0 以零元买机票并真实扣座。
  //
  // 代理自助结算价（业务拍板）：代理对**自己名下**的单可以录单当场自填结算价，不必先下单再走议价申请。
  // 敢放开的前提是归属被服务端强制收敛：AGENT 的 agentId 由 resolveOrderAgentId 无视 body.agentId
  // 取本人，改的只可能是自家这一单的应收。只放开「结算总价 / 每人结算价」两个通道：
  //   · priceAdjustment 是运营的手工调价/加项通道（原因码语义、可与日历价叠加），仍仅 ADMIN/STAFF；
  //   · flightSettlementPriceCny 直接覆盖机票行单价、短路动态定价，代理可传 0 零元买票并真实扣座，
  //     绝不放开（与 /orders/batch 的 settlementPriceCny 同口径，那条批量通道也照旧只给运营）。
  if (
    body.priceAdjustment ||
    body.settlementTotalCny !== undefined ||
    body.perPassengerSettlementCny !== undefined ||
    body.flightSettlementPriceCny !== undefined
  ) {
    const role = isGuest ? undefined : requester.role;
    const isOps = role != null && actorCan({ role }, 'orders.price_adjust');
    const isAgentSelfSettlement =
      role === UserRole.AGENT &&
      !body.priceAdjustment &&
      body.flightSettlementPriceCny === undefined &&
      (body.settlementTotalCny !== undefined || body.perPassengerSettlementCny !== undefined);
    if (!isOps && !isAgentSelfSettlement) {
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

  // 签证矛盾组合硬闸：订单级「需要签证 / 电子签」+ 已录出行人全部自备签 → 拒绝落库。
  // 这种单不会生成签证任务（判定见 visa-need.ts 的 orderNeedsVisaTask），签证台看不见，
  // 到期漏送签。录单页的软提示拦不住（提示上线后仍有新单落进来），故收在服务端。
  // 空名单 / 部分自备签一律放行（豁免口径见 isVisaContradiction）。
  // 批量创单（batchCreateOrders）逐单调用本方法，一并受本闸约束。
  // 闸与文案在状态机模块只定义一份（建单 / 换人 / 改自备签 / 改订单签证状态四条写入路径共用）。
  assertNoVisaContradiction({ visaStatus: body.visaStatus, passengers: body.passengers });

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

  // 重复乘客校验：同班次「占座中」订单里已有同证件号乘客（或证件待补的同名乘客）→ 拒绝，
  // 防同人同航班重复占座
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
    (await svc.assertNoDuplicatePassengersOnFlights(
      flightScheduleIds,
      body.passengers,
      allowDuplicatePassengers,
    )) ?? [];

  // 重复乘客强录留痕：附加一行「重复乘客强录：与订单 XXX 同班次同证件号」到订单备注（可追溯）。
  // 两类命中分开写清楚 —— 财务/票务复核时「同证件号」与「对方证件待补、只是同名」
  // 要采取的动作完全不同（后者要去那张单补护照）。
  // 仅 allowDuplicatePassengers 放行且确有冲突时非空（其余情况 conflicts 恒为 []）。
  const duplicateNoteParts = [
    duplicateForceNoteFor(
      duplicateConflicts.filter((c) => c.documentNumber !== ''),
      '同班次同证件号',
    ),
    duplicateForceNoteFor(
      duplicateConflicts.filter((c) => c.documentNumber === ''),
      '同班次同名（对方证件待补）',
    ),
  ].filter((v): v is string => v !== null);
  const duplicateForceNote = duplicateNoteParts.length > 0 ? duplicateNoteParts.join(' · ') : null;
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
  // 具体酒店超售容忍：统一按内部录单身份解析；随机档另走需求池不闸单口径。
  const hotelOversellCapRooms = await resolveHotelOversellCap(requester);
  const pricedItems = await svc.priceAndValidateItems(
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
    await svc.applyRetailSettlementDiscount(body, pricedItems);
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
  await svc.applyPassportExpiryRule(body, pricedItems);

  // 出行人类型服务端权威派生（passengerToData）所需的「本单最早出发日」：与护照有效期规则
  // 同一口径（服务端查 DB，客户端改不了），事务外查一次，供下方写 Passenger 时使用。
  const authoritativeDepartureDate = await svc.resolveEarliestFlightDepartureDate(body.items);

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
    const calendar = await svc.resolveBundleSettlementCalendarTotal(
      body,
      pricedItems.filter((p) => p.kind === 'BUNDLE').map((p) => p.settlementAddOnCny ?? 0),
    );
    if (calendar) {
      // 只有没有任何手工价通道时才自动命中代理立减。手工优惠/团队议价/手动单价
      // 均视为整体替代，保留现有手工调整与日历价的收敛口径，不与规则叠加。
      const hasManualSettlementChannel =
        body.priceAdjustment !== undefined || body.flightSettlementPriceCny !== undefined;
      if (!hasManualSettlementChannel) {
        agentAutoDiscount = await svc.applyAgentSettlementDiscount(
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
      const flightCalendar = await svc.resolveFlightSettlementCalendarTotal(body);
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

  // ── 日历成交的「每人基准」（换人重算结算价用）─────────────────────────────
  // 从刚才那次取价的 audit.lines 里直接读，不再事后 ÷ 人数：加项 / 婴儿同价 / 单房差都揉在
  // 总价里，除法只是估算，而换人差价要拿它跟换人当天的日历价逐分相减（日历比日历）。
  // 只在「口径明确」时给值：套餐单必须恰好一条已配日历行（多行分不清这个人算哪一条），
  // 机票单取各航段每人价之和。取不到 → 不落这两个键，换人时退回保守分支。
  const calendarBasis = resolveCalendarPerPaxBasis(settlementCalendarAudit, agentAutoDiscount);

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
          calendarPerPaxCny: calendarBasis?.perPaxCny ?? null,
          calendarDiscountPerPaxCny: calendarBasis?.discountPerPaxCny ?? 0,
          // 建单到底减没减代理立减（手工价通道在场时一律没减，见上方 hasManualSettlementChannel）。
          // 换人重算按这一位决定今天减不减，两边同口径（复审 H3）。
          calendarDiscountApplied: calendarBasis?.discountApplied === true,
          // 这次取价用的是日历上的哪一格：改档 / 改期后换人据此不重算（PRICING_KEY_CHANGED）。
          calendarKey: calendarBasis?.key ?? null,
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
    // 内部录单把随机档当需求池：不设 cap，但仍返回缺口明细供审计；对外渠道保持硬闸。
    oversoldRandomTiers = await assertRandomTierStaysFitWithinTx(tx, pricedItems, {
      maxOversellRooms:
        hotelOversellCapRooms != null ? RANDOM_TIER_INTERNAL_NO_CAP : undefined,
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
    await syncOrderLegFlag(tx, created.id);

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

    // 按人份额落库（R1）：建单事务末尾落一遍，订单一出生就带完整的每人份额（每人结算价差额行已回填归属）。
    await persistPassengerShares(tx, created.id);

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
      const { cancelSeatLockExpiry } = await import('../../../queues/queue.js');
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
      const { scheduleSeatHoldRelease } = await import('../../../queues/queue.js');
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
        // 代理自助改价留痕：这一笔结算价是代理本人在自家单上填的（不经运营审批），
        // 财务复核时要能一眼把它与运营录入的结算价分开。运营录入不带此键。
        ...(requester.role === UserRole.AGENT ? { selfService: true } : {}),
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
    const hotelParts = oversoldHotelStays.map((r) => {
      const worst = r.violations.reduce((a, b) => (b.shortfall > a.shortfall ? b : a));
      return `${hotelNameById.get(r.hotelId) ?? r.hotelId} ${worst.date} 最大缺 ${worst.shortfall} 间`;
    });
    const randomTierParts = oversoldRandomTiers.map((r) => {
      const worst = r.violations.reduce((a, b) => (b.shortfall > a.shortfall ? b : a));
      return `随机档缺口（${cityLabel(r.cityCode)}${randomStarTierLabel(r.tier)} ${formatSlashMonthDay(worst.date)} 最大缺 ${worst.shortfall} 间，需向地接加房）`;
    });
    const auditParts = [
      ...(hotelParts.length > 0
        ? [`超售放行（${hotelParts.join('、')}，上限 ${hotelOversellCapRooms ?? env.HOTEL_MAX_OVERSELL_ROOMS} 间）`]
        : []),
      ...randomTierParts,
    ];
    await writeAudit({
      actor: { userId: requester.userId, role: requester.role },
      action: 'CREATE_ORDER_HOTEL_OVERSOLD',
      targetType: 'ORDER',
      targetId: order.id,
      targetLabel: `${order.orderNumber} ${auditParts.join('；')}`,
      after: {
        ...(oversoldHotelStays.length > 0
          ? { maxOversellRooms: hotelOversellCapRooms ?? env.HOTEL_MAX_OVERSELL_ROOMS }
          : {}),
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
          kind: 'RANDOM_TIER_SHORTFALL',
          tier: r.tier,
          cityCode: r.cityCode,
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
export async function quoteOrder(svc: OrderService, body: QuoteOrderBody, requester?: { role: UserRole | null }): Promise<{
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
  const priced = await svc.priceAndValidateItems(
    body.items,
    undefined,
    body.passengers,
    true,
    starGate,
    // 内部试算与 createOrder 同口径解析酒店 cap（含 AGENT）；随机档由需求池口径放行。
    await resolveHotelOversellCap(requester),
  );
  // 散客立减与结算价日历是两条独立规则链：先按每个套餐行命中 RETAIL，
  // 即使日历价未维护，quote 的商品总价也必须与 createOrder 保持一致。
  // 判定与 createOrder 共用同一个函数（此前 quote 只判 !agentId、createOrder 还要求无手工价通道，
  // 带手工调价时报价里有立减、实下单没有 —— 两个数字对不上）。
  if (shouldApplyRetailSettlementDiscount(body)) {
    await svc.applyRetailSettlementDiscount({ items: body.items }, priced);
  }

  let settlementPreview: SettlementPreview = null;
  try {
    const quoteCreateBody: Pick<CreateOrderBody, 'items'> = { items: body.items };
    const bundleCalendar = await svc.resolveBundleSettlementCalendarTotal(
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
        autoDiscount = await svc.applyAgentSettlementDiscount(
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
      const flightCalendar = await svc.resolveFlightSettlementCalendarTotal(quoteCreateBody);
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
export async function resolveEarliestFlightDepartureDate(svc: OrderService, items: OrderItemInput[]): Promise<Date | null> {
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

export async function applyPassportExpiryRule(
  svc: OrderService,
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
export async function applyAgentSettlementDiscount(
  svc: OrderService,
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
    // 航线随取价行一起来（同一把派生键）；没有航线的行本来就不会进日历取价，这里同样不匹配立减。
    const routeKey = typeof line.routeKey === 'string' && line.routeKey !== '' ? line.routeKey : null;
    const pax = Math.max(0, Math.trunc(Number(line.pax) || 0));
    if (!tier || !departDate || !routeKey || !Number.isInteger(nights) || pax <= 0) continue;
    const hit = await resolveAgentSettlementDiscount(agentId, routeKey, tier, nights, departDate);
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
export async function applyRetailSettlementDiscount(svc: OrderService, body: Pick<CreateOrderBody, 'items'>, pricedItems: PricedOrderItem[]): Promise<AutoDiscountSummary | null> {
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
    select: {
      id: true,
      name: true,
      settlementTier: true,
      settlementNights: true,
      ...BUNDLE_ROUTE_SELECT,
    },
  });
  const bundleById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  // 立减按航线隔离：配了档次/晚数但没绑航班的套餐派生不出航线 → 不匹配立减（不兜底到任何航线）。
  const configured = bundleItems.filter((item) => {
    const bundle = bundleById.get(item.bundleId);
    if (bundle?.settlementTier == null || bundle.settlementNights == null) return false;
    if (bundleRouteKey(bundle) != null) return true;
    // eslint-disable-next-line no-console
    console.warn('[settlement-discounts] 套餐未绑航班，无结算价：不匹配散客立减', {
      bundleId: bundle.id,
      bundleName: bundle.name,
    });
    return false;
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
    const routeKey = bundleRouteKey(bundle);
    if (!routeKey) continue; // configured 已滤掉，此处只为收窄类型
    const departDate = await svc.resolveBundleItemDepartureLocalDate(body, item);
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
      routeKey,
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
      routeKey,
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
export async function resolveBundleSettlementCalendarTotal(svc: OrderService, body: Pick<CreateOrderBody, 'items'>, bundleAddOnNetsCny: number[] = []): Promise<{ totalCny: number; audit: Record<string, unknown> } | null> {
  const bundleItems = body.items.filter(
    (it): it is Extract<OrderItemInput, { kind: 'BUNDLE' }> =>
      it.kind === 'BUNDLE' && !!it.bundleId,
  );
  if (bundleItems.length === 0) return null;

  const bundleIds = [...new Set(bundleItems.map((it) => it.bundleId))];
  const bundles = await prisma.bundle.findMany({
    where: { id: { in: bundleIds } },
    select: {
      id: true,
      name: true,
      settlementTier: true,
      settlementNights: true,
      ...BUNDLE_ROUTE_SELECT,
    },
  });
  const bundleById = new Map(bundles.map((b) => [b.id, b]));

  // 只处理「档次 + 晚数都配了 **且派生得出航线**」的套餐行；未配 → 现状不变（不进结算收敛）。
  // 配了档次/晚数却没绑航班 = 没有航线 = 无结算价：同样不取（绝不兜底到某条既有航线），只留日志。
  const configured = bundleItems.filter((it) => {
    const b = bundleById.get(it.bundleId);
    if (b?.settlementTier == null || b?.settlementNights == null) return false;
    if (bundleRouteKey(b) != null) return true;
    // eslint-disable-next-line no-console
    console.warn('[settlement-calendar] 套餐未绑航班，无结算价：不取日历价', {
      bundleId: b.id,
      bundleName: b.name,
    });
    return false;
  });
  if (configured.length === 0) return null;

  // 去程出发日期（最早 FLIGHT 航段的出发地本地日）。已配日历却无航段 → 无从取价，明确拒单。
  const departYmd = await svc.resolveDepartureLocalDate(body);
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
    const routeKey = bundleRouteKey(b);
    if (routeKey == null) continue; // configured 已滤掉没航线的行，此处只为收窄类型
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
    const rate = await getSettlementRate(routeKey, tier, nights, departYmd);
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
      // 航线随行留痕：立减匹配 / 换人定价键都从这里取同一把键
      routeKey,
      tier,
      nights,
      departDate: departYmd,
      pricePerPersonCny: rate.pricePerPersonCny,
      pax,
      addOnCny,
      lineTotalCny,
      // 人类可读留痕：「结算价日历自动取价：{航线} {档次}{晚数}晚 {日期} ¥X/人×N（加项 ±¥Y）」
      note: `结算价日历自动取价：${routeKey} ${tier} ${nights}晚 ${departYmd} ¥${rate.pricePerPersonCny}/人×${pax}${
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
export async function resolveFlightSettlementCalendarTotal(svc: OrderService, body: Pick<CreateOrderBody, 'items'>): Promise<
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
export async function resolveDepartureLocalDate(svc: OrderService, body: Pick<CreateOrderBody, 'items'>): Promise<string | null> {
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
export async function resolveAuthoritativeBundleGoDates(svc: OrderService, items: ReadonlyArray<OrderItemInput>): Promise<Map<string, string>> {
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
export async function resolveBundleItemDepartureLocalDate(
  svc: OrderService,
  body: Pick<CreateOrderBody, 'items'>,
  bundleItem: Extract<OrderItemInput, { kind: 'BUNDLE' }>,
): Promise<string | null> {
  const authoritative = (await svc.resolveAuthoritativeBundleGoDates(body.items)).get(
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
 * 同一个人不允许再次下单 —— 已取消/已退款/超时的订单不算占座，可重订。
 *
 * 「同一个人」有两把尺子，命中任一即算重复：
 *   ① 证件号相同（主口径，最可靠）。
 *   ② 对方是**证件待补**（documentNumber = ''，占位单只填姓名转正来的）且**姓名相同**。
 *      为什么必须有第二把：占位单转正只填了姓名，证件号落库是空串；护照到手后如果经办人
 *      没走补录、而是在同一班次重新建了一张带真护照号的新单，第一把尺子永远量不到
 *      （空串对不上任何真护照号），闸静默放行 —— 3 个人就占了 6 个座。
 *
 *   - allowDuplicate=false（默认；前台散客 / 未授权）：命中即抛 DuplicatePassengerError
 *     （code=DUPLICATE_PASSENGER，details.conflicts 带证件号/姓名 + 冲突订单号），拒绝下单。
 *   - allowDuplicate=true（仅 ADMIN/STAFF 后台录入，权限已在 createOrder 入口按身份收口）：
 *     命中不拦，返回冲突明细，由调用方写审计 + 订单备注留痕（客人重复订票且已付款场景）。
 *     两把尺子同权：证件待补的同名命中一样可强录、一样留痕。
 *
 * 无冲突恒返回 []（含无 FLIGHT 班次 / 无乘客的快速返回）。
 */
export async function assertNoDuplicatePassengersOnFlights(
  svc: OrderService,
  flightScheduleIds: string[],
  passengers: ReadonlyArray<DuplicateCheckPassenger>,
  allowDuplicate = false,
): Promise<DuplicatePassengerConflict[]> {
  if (flightScheduleIds.length === 0 || passengers.length === 0) return [];

  const documentNumbers = [
    ...new Set(passengers.map((p) => p.documentNumber?.trim()).filter((d): d is string => !!d)),
  ];

  // 一次查询取两类候选行：本次要下单的证件号 + 同班次所有「证件待补」乘客。
  // 拆成两次查会多打一次库，且两次之间的窗口里对方可能刚补完证件，反而更容易漏。
  const rows = await prisma.passenger.findMany({
    where: {
      OR: [
        ...(documentNumbers.length > 0 ? [{ documentNumber: { in: documentNumbers } }] : []),
        // 空串 = 占位单转正时只填了姓名、证件待补（见 createHoldConversionOrderWithinTx）。
        { documentNumber: '' },
      ],
      order: {
        status: { in: SEAT_HOLDING_STATUSES },
        items: { some: { flightScheduleId: { in: flightScheduleIds } } },
      },
    },
    select: {
      documentNumber: true,
      lastName: true,
      firstName: true,
      fullName: true,
      chineseName: true,
      order: { select: { orderNumber: true } },
    },
  });
  if (rows.length === 0) return [];

  // ── ① 证件号命中 ────────────────────────────────────────────────────────
  const requestedDocuments = new Set(documentNumbers);
  const orderNumbersByDoc = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.documentNumber || !requestedDocuments.has(r.documentNumber)) continue;
    const orderNumbers = orderNumbersByDoc.get(r.documentNumber) ?? new Set<string>();
    orderNumbers.add(r.order.orderNumber);
    orderNumbersByDoc.set(r.documentNumber, orderNumbers);
  }
  const docConflicts: DuplicatePassengerConflict[] = [...orderNumbersByDoc.entries()].map(
    ([documentNumber, orderNumbers]) => ({ documentNumber, orderNumbers: [...orderNumbers] }),
  );

  // ── ② 证件待补 + 同名命中 ───────────────────────────────────────────────
  const pendingRows = rows.filter((r) => !r.documentNumber);
  const orderNumbersByName = new Map<string, Set<string>>();
  for (const px of passengers) {
    const latin = latinPassengerNameKey(px);
    const chinese = chinesePassengerNameKey(px.chineseName);
    if (!latin && !chinese) continue;
    for (const row of pendingRows) {
      const rowLatin = latinPassengerNameKey(row);
      const rowChinese = chinesePassengerNameKey(row.chineseName);
      const hit =
        (latin != null && rowLatin != null && latin === rowLatin) ||
        (chinese != null && rowChinese != null && chinese === rowChinese);
      if (!hit) continue;
      const label = px.chineseName?.trim() || latin || chinese!;
      const orderNumbers = orderNumbersByName.get(label) ?? new Set<string>();
      orderNumbers.add(row.order.orderNumber);
      orderNumbersByName.set(label, orderNumbers);
    }
  }
  const nameConflicts: DuplicatePassengerConflict[] = [...orderNumbersByName.entries()].map(
    ([passengerName, orderNumbers]) => ({
      // 对方证件本来就是空的，如实回空串（前端/审计据此与证件号命中区分开）。
      documentNumber: '',
      passengerName,
      orderNumbers: [...orderNumbers],
    }),
  );

  const conflictList = [...docConflicts, ...nameConflicts];
  if (conflictList.length === 0) return [];

  // 授权强录 → 不拦，把明细交回调用方做审计 + 备注。
  if (allowDuplicate) return conflictList;

  const messages: string[] = [];
  if (docConflicts.length > 0) {
    const detail = docConflicts
      .map(({ documentNumber, orderNumbers }) => `${documentNumber}（订单 ${orderNumbers.join('、')}）`)
      .join('；');
    messages.push(`以下乘客证件号已在同航班的有效订单中，不能重复下单：${detail}`);
  }
  if (nameConflicts.length > 0) {
    const detail = nameConflicts
      .map(({ passengerName, orderNumbers }) => `${passengerName}（订单 ${orderNumbers.join('、')}）`)
      .join('；');
    messages.push(
      `以下乘客与同航班有效订单里的同名乘客重合：${detail}；` +
        '该订单存在证件待补的同名乘客，请到该订单补录护照而不是重新建单',
    );
  }
  throw new DuplicatePassengerError(messages.join('。'), { conflicts: conflictList });
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
export async function priceAndValidateItems(
  svc: OrderService,
  items: OrderItemInput[],
  flightSettlementPriceCny?: number,
  passengers?: ReadonlyArray<{
    visaExempt?: boolean;
    singleRoom?: boolean;
    gender?: 'M' | 'F' | 'X';
  }>,
  allowClientPricedGround = false,
  starGate?: DesignatedHotelStarGate,
  hotelOversellCapRooms?: number,
) {
  const priced: PricedOrderItem[] = [];

  // 套餐去程出发日的权威来源（A7）：同 bundle 的真实 FLIGHT 航段，客户端改不了。
  // 房控占房盖章（下方 resolveBundleHotelStamp）此前直接吃客户端自由字段 metadata.goDate，
  // 伪造的日期会把占房盖到错误的夜晚上（房控账实分叉）。有航段时一律用航段日覆盖。
  // 纯地面套餐（无同 bundle 航段）→ map 里没有该 bundleId，保持原 goDate 现状不变。
  const authoritativeBundleGoDates = await svc.resolveAuthoritativeBundleGoDates(items);

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
      const pricing = await svc.pricing.calculatePrice(
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
          // 单独随机行没有酒店也就没有城市 → 一律归存量默认城市（见 hotel-city.ts）。
          await assertRandomTierFit(
            { tier: item.randomStarTier, cityCode: RANDOM_TIER_LEGACY_CITY_CODE },
            stayNights,
            rooms,
            {
              maxOversellRooms:
                hotelOversellCapRooms != null ? RANDOM_TIER_INTERNAL_NO_CAP : undefined,
            },
          );
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
              // costPriceCny：套餐行地面成本快照的每间每晚成本（与 basePrice 成对，价/本同源）。
              costPriceCny: true,
              hotelId: true,
              // randomTierPlaceholder：套餐绑的可能是「随机N星」的占位酒店房型（历史形态）——
              //   此时房量闸要走随机档聚合闸而不是具体酒店闸（见下方库存校验小节）。
              // cityCode：随机档按城市圈定，套餐的城市 = 它绑的占位酒店的城市。
              hotel: { select: { isActive: true, randomTierPlaceholder: true, cityCode: true } },
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
        /** 每间每晚成本（产品未录成本 = null）：套餐行地面成本快照取指定房型这一份。*/
        costPriceCny: Prisma.Decimal | null;
        /** 非空 = 指到了随机档占位酒店（不是真房源）→ 房量闸走随机档聚合闸。*/
        randomTierPlaceholder: number | null;
        /** 星级闸比对用（占位酒店不参与本闸）。*/
        starRating: number | null;
        intlFiveStar: boolean;
        /** 随机档按城市圈定：指到占位酒店时，聚合闸的城市取该占位酒店的。*/
        cityCode: string;
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
            // 指定酒店优先：地面成本快照的每间每晚成本取指定房型的（住哪家就用哪家的成本）。
            costPriceCny: true,
            hotel: {
              select: {
                name: true,
                isActive: true,
                designationSurchargeCnyPerPerson: true,
                randomTierPlaceholder: true,
                starRating: true,
                intlFiveStar: true,
                cityCode: true,
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
          costPriceCny: rt.costPriceCny,
          randomTierPlaceholder: rt.hotel.randomTierPlaceholder,
          starRating: rt.hotel.starRating ?? null,
          intlFiveStar: rt.hotel.intlFiveStar === true,
          cityCode: rt.hotel.cityCode,
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
      // 随机档按城市圈定：城市 = 占位酒店（指定的或套餐绑定的）自己的 cityCode
      const fitPlaceholderCity = normalizeCityCode(
        designatedRoomType != null
          ? designatedRoomType.cityCode
          : bundle.hotelRoomType?.hotel.cityCode,
      );
      if (hotelStamp && fitHotelId) {
        const nightDates = buildStayNightDates(hotelStamp.hotelCheckIn, hotelStamp.hotelCheckOut);
        if (nightDates.length > 0) {
          // 带 cap = 内部录单：用默认的带数字文案（要看得见差多少间/超没超上限）；
          // 对外端点（豁免缺省）：中性话术，不暴露包房间数等内部库存数字。
          if (fitPlaceholderTier != null) {
            await assertRandomTierFit(
              { tier: fitPlaceholderTier, cityCode: fitPlaceholderCity },
              nightDates,
              rooms,
              {
                maxOversellRooms:
                  hotelOversellCapRooms != null ? RANDOM_TIER_INTERNAL_NO_CAP : undefined,
                buildMessage:
                  hotelOversellCapRooms != null
                    ? undefined
                    : () => '该出发日期酒店可用房量不足，请更换日期或联系客服',
              },
            );
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

      // ── 套餐行地面成本快照 ────────────────────────────────────────────────
      // 与售价侧 computeBundleGroundTotal 逐组件同构：HOTEL 按 晚数×每晚成本×rooms、
      // VISA 按 办签人数×每人成本、TRANSFER 按 qty×每份成本。三个数量口径（rooms /
      // visaHeadCount / qty）与售价侧同源，价与本走同一条分摊，毛利才对得上。
      //
      // 机票分量**不算在这行上**：套餐单里的机票是独立的 FLIGHT 行（带 bundleId），成本
      // 已由上面的机票快照落在那些行上，这里再加一遍就是双计。也绝不用「机票款=残差」
      // 反推（口径决议已否决：残差拆分只做展示报表，不驱动定价，更不该驱动成本）。
      //
      // 每间每晚成本取**实际要住的那家**：指定酒店优先，其次套餐绑定房型。这与售价侧
      // 「地面价不换成指定房型价、另收指定差价」的口径**刻意不同** —— 卖的是随机档的价，
      // 买的却是指定那家的房，成本必须记指定店的真实采购价，差额正是指定加价那笔收入。
      // 绑的是随机档占位酒店（不是真房源）时通常没录成本 → null → 整行留 NULL（还没落位，
      // 成本本就未知），等落位后由回填/人工补。
      const bundleHotelNightlyCostCny =
        designatedRoomType?.costPriceCny != null
          ? Number(designatedRoomType.costPriceCny)
          : bundle.hotelRoomType?.costPriceCny != null
            ? Number(bundle.hotelRoomType.costPriceCny)
            : null;
      const bundleComponentCosts = await loadBundleComponentCosts([bundle.items]);
      const bundleGroundCostCny = computeBundleGroundCost({
        components: bundle.items,
        hotelNightlyCostCny: bundleHotelNightlyCostCny,
        rooms,
        visaHeadCount,
        visaCostByIdCny: bundleComponentCosts.visaCostByIdCny,
        transferCostByIdCny: bundleComponentCosts.transferCostByIdCny,
      });

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
        // 地面成本快照（机票分量在 FLIGHT 行上，见上方口径）；任一组件成本取不到 → 整行 NULL。
        totalCostCny: bundleGroundCostCny ?? undefined,
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
    await svc.assertBusinessAvailabilityForBundle(legPlan);
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

  // ── 机票行成本快照（含套餐里的机票腿：它们就是带 bundleId 的 FLIGHT 行）──
  // 成本口径不动 —— resolveFlightItemCost 仍是唯一算法，这里只把它在下单时点的结果落成快照，
  // 与房/签/车三类行同一写法。算不出成本（班次 override 与周期都没填）→ 留 NULL，报表照旧「未知」。
  // 放在折扣之后：折扣只改售价、成本与售价无关，先后对结果无影响；摆这里只是要一个
  // 「priced 定型之后统一补成本」的明确位置。
  const flightCostRows = priced
    .filter((p) => p.kind === 'FLIGHT' && p.flightScheduleId)
    .map((p) => ({ flightScheduleId: p.flightScheduleId as string, quantity: p.quantity }));
  if (flightCostRows.length > 0) {
    const snapshots = await resolveFlightCostSnapshots(flightCostRows);
    for (const p of priced) {
      if (p.kind !== 'FLIGHT' || !p.flightScheduleId) continue;
      const snap = snapshots.get(flightSnapshotKey(p.flightScheduleId, p.quantity));
      if (!snap || snap.totalCostCny == null) continue;
      p.unitCostCny = snap.unitCostCny ?? undefined;
      p.totalCostCny = snap.totalCostCny;
    }
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
export async function assertBusinessAvailabilityForBundle(
  svc: OrderService,
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

/**
 * 批量散客建单：选一个航班班次 + 舱位，名单里每位乘客各成一单（FLIGHT × 1）。
 * 录入人即登录账号 —— 联系人/电话默认取登录用户（displayName / phone），
 * 「系统谁录的就找谁」；body 仍可显式传 contactName/contactPhone 覆盖（兼容旧前端）。
 * 逐单复用 createOrder（含动态定价 / 原子扣座 / 订单号），单条失败不影响其余，逐行返回结果。
 */
export async function batchCreateOrders(svc: OrderService, body: BatchCreateOrdersBody, requester: OrderRequester): Promise<{
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
    !actorCan(requester, 'orders.price_adjust')
  ) {
    throw new BadRequestError('无权手动录入结算单价');
  }
  if (hasDiscount && !actorCan(requester, 'orders.price_adjust')) {
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
  await svc.assertNoDuplicatePassengersOnFlights(
    dedupScheduleIds,
    body.passengers,
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
    const resolved = await svc.resolveBundleFlightLegs(
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

  // OTA 手工结算价的参考价预定价也必须与该批次建单共用内部酒店 cap，
  // 否则随机档缺口会在预定价阶段先被旧硬闸拦掉。
  const hotelOversellCapRoomsForManualPrice =
    body.manualUnitPriceCny !== undefined ? await resolveHotelOversellCap(requester) : undefined;

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
        const priced = await svc.priceAndValidateItems(
          batchItems,
          undefined,
          [passengerForOrder],
          true,
          undefined,
          hotelOversellCapRoomsForManualPrice,
        );
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

      const order = await svc.createOrder(
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
export async function resolveBundleFlightLegs(
  svc: OrderService,
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
  const goScheduleId = await svc.matchBundleScheduleByLocalDate(bundle.outboundFlightId, departDate);
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
    const retScheduleId = await svc.matchBundleScheduleByLocalDate(bundle.returnFlightId, returnDate);
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
export async function matchBundleScheduleByLocalDate(svc: OrderService, flightId: string, targetYmd: string): Promise<string | null> {
  const schedules = await prisma.flightSchedule.findMany({
    where: { flightId, isActive: true },
    select: { id: true, departureTime: true, departureTz: true },
    orderBy: { departureTime: 'asc' },
  });
  const match = schedules.find((s) => localDate(s.departureTime, s.departureTz) === targetYmd);
  return match?.id ?? null;
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
