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
  CabinClass,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
  Prisma,
  ProductKind,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import type { ItineraryData } from '../../lib/itinerary-pdf.js';
import { PricingService } from '../pricing/pricing.service.js';
import type {
  BatchCreateOrdersBody,
  BatchPriceAdjustmentBody,
  BatchRescheduleBody,
  AddGroundItemBody,
  BatchPassengerInput,
  ChangeOrderBundleBody,
  CreateOrderBody,
  ListOrdersQuery,
  OrderItemInput,
  OrderPriceAdjustmentBody,
  CancelLegBody,
  CancelReturnLegBody,
  FlightLegSide,
  NoShowBody,
  RestoreReturnLegBody,
  VoidReturnLegBody,
  PublicOrderLookupQuery,
  QuoteOrderBody,
  SettlementPreview,
  RescheduleItemHotelBody,
  SelfUpdatePassengerBody,
  SplitRoomGroupBody,
  SwapItemHotelBody,
  UpdateItemSettlementPriceBody,
  UpdatePassengerTicketBody,
  UpdatePassengerVisaDatesBody,
} from './orders.schemas.js';
import { VisaRequirement } from '@prisma/client';
import type { BundleFlightLeg } from './service/create.js';
import type { ReturnReleasedSnapshot } from './service/leg-action-log.js';
import type {
  CancelLegAudit,
  CancelLegItemSnapshot,
  CancelLegItemView,
  CancelLegOrderSnapshot,
  CancelLegPreview,
  LegCancelPolicyFee,
  NoShowAudit,
  NoShowLegView,
  NoShowPreview,
  NoShowScope,
  RestoreReturnLegAudit,
  RestoreReturnLegPreview,
  RestoreSeatNeed,
  VoidReturnLegAudit,
  VoidReturnLegPreview,
} from './service/legs.js';
import type {
  SwapBeforeSnapshot,
  SwapRepriceQuote,
  SwapRepriceSkipReason,
} from './service/passengers.js';
import { type AgentStatsResult, type MaskedOrderView, serializeOrder } from './service/read.js';
import type { ReschedulePassengersResult } from './service/reschedule.js';
import type { OversellSeatDetail } from './service/seat-inventory.js';
import type {
  AutoDiscountSummary,
  DesignatedHotelStarGate,
  DesignatedHotelStarMismatchOverride,
  DuplicateCheckPassenger,
  DuplicatePassengerConflict,
  GuestRequester,
  OrderRequester,
  PricedOrderItem,
  SwapCalendarKey,
} from './service/shared.js';
import type {
  SplitAssessment,
  SplitCommissionAudit,
  SplitHotelItemView,
  SplitOrderInput,
  SplitOrderResult,
  SplitSourceOrder,
  SplitUpgradeItemView,
} from './service/split.js';
import * as readSvc from './service/read.js';
import * as statusSvc from './service/status.js';
import * as fundsLinksSvc from './service/funds-links.js';
import * as pricingAdjustSvc from './service/pricing-adjust.js';
import * as createSvc from './service/create.js';
import * as passengersSvc from './service/passengers.js';
import * as rescheduleSvc from './service/reschedule.js';
import * as hotelSvc from './service/hotel.js';
import * as splitSvc from './service/split.js';
import * as legsSvc from './service/legs.js';

// ── 原样再导出：拆分前本文件导出的名字一个不少，调用方 import 路径不变 ──
export {
  ORDER_STATUS_LABEL_ZH,
  ALLOWED_TRANSITIONS,
  SETTLEMENT_TIER_STAR_RATING,
  SETTLEMENT_TIER_LABEL,
  resolveHotelSettlementTier,
  isSettlementTierStarMismatch,
  buildStarMismatchMessage,
  SEAT_HOLDING_STATUSES,
  SEAT_RELEASING_STATUSES,
  FULFILLMENT_TERMINATING_STATUSES,
  AGENT_SELF_EDIT_REASON,
  computeAgentSelfEditWindow,
  calendarKeyFingerprint,
  readCalendarKey,
  RANDOM_TIER_INTERNAL_NO_CAP,
  resolveHotelOversellCap,
  resolveOrderAgentId,
  addDaysToYmd,
  buildPriceAdjustmentItem,
  buildSettlementDiscountItem,
  buildSettlementTotalItem,
  resolveCalendarPerPaxBasis,
  buildPerPassengerSettlementItem,
  assertDisplayedTotalMatches,
  shouldApplyRetailSettlementDiscount,
  buildRoomSupplementItem,
  computeCabinUpgradeDiffCny,
  buildUpgradedCabinDescription,
  resolveRoomSupplementCost,
  computeSwapHotelCostSnapshot,
  computeGroundItemAmounts,
  resolveGroundItemUnitPrice,
  resolveHasReturnLeg,
  syncOrderHasReturnLeg,
  syncOrderLegFlag,
  passengerToData,
} from './service/shared.js';
export type {
  DesignatedHotelStarMismatchOverride,
  DesignatedHotelStarGate,
  AgentSelfEditWindow,
  SwapCalendarKey,
  OrderRequester,
  GuestRequester,
  RoomCostSource,
  DuplicateCheckPassenger,
  DuplicatePassengerConflict,
  OrderAdjustmentEntry,
} from './service/shared.js';
export {
  computeOversellDelta,
  computeDisplacedReserved,
  takeSeatWithinTx,
  releaseSeatFloored,
  releaseSeatStrictWithinTx,
  computeBundleSeatSplit,
} from './service/seat-inventory.js';
export type { OversellSeatDetail, DisplacedReservationDetail } from './service/seat-inventory.js';
export {
  buildStayNightDates,
  rewriteHotelStayDescription,
  HOTEL_SOLD_OUT_MESSAGE,
  assertRandomTierStaysFitWithinTx,
  assertHotelStaysFitWithinTx,
  splitSettlementPriceAcrossLegs,
  computeBundleGroundTotal,
  resolveBundleHotelStamp,
  resolveBundleOccupancy,
  DEFAULT_ROOM_MAX_ADULTS,
  DEFAULT_ROOM_MAX_CHILDREN,
  computeRoomsNeeded,
  toProspectiveOccupancy,
  computeBundleRoomsCharged,
  computeBundleOperationFeeTotal,
  derivePerPaxBundleOptions,
  resolveBundleBusinessUpgradeRate,
  resolveBundleBusinessUpgradeInput,
  computeBundleAddOn,
  computeRequiredPassengerCount,
} from './service/bundle-pricing.js';
export type {
  ProspectiveHotelStay,
  RandomTierOversellRecord,
  HotelStayOversellRecord,
  BundleAddOnBreakdown,
  BundleOccupancyInput,
  BundleOccupancy,
  BundleBusinessUpgradeSplit,
} from './service/bundle-pricing.js';
export type {
  ReleasedSeatEntry,
  ReturnReleasedSnapshot,
  LegActionType,
  LegActionLogEntry,
  LegActionTokenLookup,
  SplitOrchestrationSnapshot,
} from './service/leg-action-log.js';
export {
  MAX_PASSENGER_NAME_TERMS,
  splitSearchTerms,
  buildSearchTermClause,
  GUEST_RECORDED_BY_LABEL,
  applyExportAgentScope,
  withoutAgentHiddenFilters,
  buildOrderFilterWhere,
  deriveOrderDepartDate,
  filterOrderIdsByDepartDate,
  deriveOrderReturnDate,
  filterOrderIdsByReturnDate,
  filterOrderIdsByFlightDate,
  filterOrderIdsByLegFlightNumber,
  summarizeBundleItems,
  deriveBundlePerAgeUnitPrices,
  serializeOrder,
  orderSerializeRoleCtx,
  maskFamilyName,
} from './service/read.js';
export type {
  AgentStatsResult,
  OrderListFilters,
  BundleItemsSummary,
  BundlePerAgeUnitPrices,
  MaskedOrderView,
} from './service/read.js';
export { createCommissionsForOrder } from './service/commission.js';
export {
  resolveBundleFulfillmentTypes,
  createFulfillmentTasks,
  createVisaTaskAtCreation,
  evaluateOrderVisaTaskState,
  syncVisaTasksForOrder,
} from './service/visa-sync.js';
export type { OrderVisaTaskState, VisaTaskSyncResult } from './service/visa-sync.js';
export {
  deriveBatchBundlePassengerCounts,
  buildBatchItems,
  assertVisaPassengersHavePassportExpiry,
  assertAmountWithinTolerance,
} from './service/create.js';
export type { BundleFlightLeg, BatchBundlePassengerOptions } from './service/create.js';
export {
  normalizeDocumentNumber,
  normalizeCorrectionName,
  SWAP_FEE_OPTIONS_SETTING_KEY,
  DEFAULT_SWAP_FEE_OPTIONS_CNY,
  getSwapFeeOptions,
} from './service/passengers.js';
export type {
  SwapBeforeSnapshot,
  SwapRepriceSkipReason,
  SwapRepriceQuote,
} from './service/passengers.js';
export type { RescheduleOrderItemAudit, ReschedulePassengersResult } from './service/reschedule.js';
export {
  CHANGE_BUNDLE_ITEM_SELECT,
  assertOrderChangeBundleAllowed,
  resolveChangeableBundleRow,
  sumBundleChangeDiffCny,
  computeChangedBundleLine,
} from './service/hotel.js';
export { splitNoneUpdateToPrisma } from './service/split.js';
export type {
  SplitOrderInput,
  SplitOrderResult,
  SplitHotelItemView,
  SplitUpgradeItemView,
  SplitCommissionAudit,
} from './service/split.js';
export { voidReleasedReturnLegWithinTx } from './service/legs.js';
export type {
  CancelLegItemView,
  LegCancelPolicyFee,
  CancelLegPreview,
  CancelLegAudit,
  NoShowScope,
  NoShowLegView,
  NoShowPreview,
  NoShowAudit,
  RestoreReturnLegPreview,
  VoidReturnLegPreview,
  VoidReturnLegAudit,
  RestoreReturnLegAudit,
  CancelReturnLegItemView,
  ReturnLegCancelPolicyFee,
  CancelReturnLegPreview,
  CancelReturnLegAudit,
} from './service/legs.js';

export class OrderService {
  readonly pricing = new PricingService();
  createHoldConversionOrderWithinTx(
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
    return createSvc.createHoldConversionOrderWithinTx(this, tx, input);
  }

  advanceOrderToPaidIfClearedWithinTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    requester: OrderRequester,
    pendingFulfillmentTaskIds: string[],
  ): Promise<{ fullyPaid: boolean; status: OrderStatus }> {
    return statusSvc.advanceOrderToPaidIfClearedWithinTx(this, tx, orderId, requester, pendingFulfillmentTaskIds);
  }

  createOrder(body: CreateOrderBody, requester: OrderRequester | GuestRequester) {
    return createSvc.createOrder(this, body, requester);
  }

  quoteOrder(body: QuoteOrderBody, requester?: { role: UserRole | null }): Promise<{
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
    return createSvc.quoteOrder(this, body, requester);
  }

  resolveEarliestFlightDepartureDate(items: OrderItemInput[]): Promise<Date | null> {
    return createSvc.resolveEarliestFlightDepartureDate(this, items);
  }

  applyPassportExpiryRule(
    body: CreateOrderBody,
    pricedItems: Array<{ kind: OrderItemKind; description: string; quantity: number; unitPrice: number; amount: number; totalCostCny?: number }>,
  ): Promise<void> {
    return createSvc.applyPassportExpiryRule(this, body, pricedItems);
  }

  applyAgentSettlementDiscount(
    pricedItems: PricedOrderItem[],
    calendar: { totalCny: number; audit: Record<string, unknown> },
    agentId: string,
  ): Promise<AutoDiscountSummary | null> {
    return createSvc.applyAgentSettlementDiscount(this, pricedItems, calendar, agentId);
  }

  applyRetailSettlementDiscount(body: Pick<CreateOrderBody, 'items'>, pricedItems: PricedOrderItem[]): Promise<AutoDiscountSummary | null> {
    return createSvc.applyRetailSettlementDiscount(this, body, pricedItems);
  }

  resolveBundleSettlementCalendarTotal(body: Pick<CreateOrderBody, 'items'>, bundleAddOnNetsCny: number[] = []): Promise<{ totalCny: number; audit: Record<string, unknown> } | null> {
    return createSvc.resolveBundleSettlementCalendarTotal(this, body, bundleAddOnNetsCny);
  }

  resolveFlightSettlementCalendarTotal(body: Pick<CreateOrderBody, 'items'>): Promise<
    | { totalCny: number; audit: Record<string, unknown> }
    | { totalCny: null; skippedReason: string }
    | null
  > {
    return createSvc.resolveFlightSettlementCalendarTotal(this, body);
  }

  resolveDepartureLocalDate(body: Pick<CreateOrderBody, 'items'>): Promise<string | null> {
    return createSvc.resolveDepartureLocalDate(this, body);
  }

  resolveAuthoritativeBundleGoDates(items: ReadonlyArray<OrderItemInput>): Promise<Map<string, string>> {
    return createSvc.resolveAuthoritativeBundleGoDates(this, items);
  }

  resolveBundleItemDepartureLocalDate(
    body: Pick<CreateOrderBody, 'items'>,
    bundleItem: Extract<OrderItemInput, { kind: 'BUNDLE' }>,
  ): Promise<string | null> {
    return createSvc.resolveBundleItemDepartureLocalDate(this, body, bundleItem);
  }

  assertNoDuplicatePassengersOnFlights(
    flightScheduleIds: string[],
    passengers: ReadonlyArray<DuplicateCheckPassenger>,
    allowDuplicate = false,
  ): Promise<DuplicatePassengerConflict[]> {
    return createSvc.assertNoDuplicatePassengersOnFlights(this, flightScheduleIds, passengers, allowDuplicate);
  }

  priceAndValidateItems(
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
    return createSvc.priceAndValidateItems(this, items, flightSettlementPriceCny, passengers, allowClientPricedGround, starGate, hotelOversellCapRooms);
  }

  assertBusinessAvailabilityForBundle(legPlan: ReadonlyArray<{ leg: { flightScheduleId?: string }; businessCount: number }>): Promise<void> {
    return createSvc.assertBusinessAvailabilityForBundle(this, legPlan);
  }

  resolveListOrdersWhere(query: ListOrdersQuery, requester: OrderRequester): Promise<Prisma.OrderWhereInput> {
    return readSvc.resolveListOrdersWhere(this, query, requester);
  }

  listOrders(query: ListOrdersQuery, requester: OrderRequester) {
    return readSvc.listOrders(this, query, requester);
  }

  getAgentStats(query: ListOrdersQuery, requester: OrderRequester): Promise<AgentStatsResult> {
    return readSvc.getAgentStats(this, query, requester);
  }

  getOrder(id: string, requester: OrderRequester) {
    return readSvc.getOrder(this, id, requester);
  }

  softDeleteOrder(id: string, requester: OrderRequester) {
    return statusSvc.softDeleteOrder(this, id, requester);
  }

  listDeletedOrders(query: { page: number; pageSize: number; search?: string }, requester: OrderRequester) {
    return readSvc.listDeletedOrders(this, query, requester);
  }

  restoreOrder(id: string, requester: OrderRequester) {
    return statusSvc.restoreOrder(this, id, requester);
  }

  loadBundleVisaStayDays(items: ReadonlyArray<{ bundle?: { items: Prisma.JsonValue } | null }>): Promise<Map<string, number | null>> {
    return readSvc.loadBundleVisaStayDays(this, items);
  }

  _recordOverpayDisposalPayment(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      amountCny: number;
      method: PaymentMethod;
      disposal: 'AGENT_BALANCE' | 'RECEIPT_POOL';
      description: string;
    },
  ): Promise<void> {
    return fundsLinksSvc._recordOverpayDisposalPayment(this, tx, input);
  }

  _latestInboundPaymentMethod(tx: Prisma.TransactionClient, orderId: string): Promise<PaymentMethod> {
    return fundsLinksSvc._latestInboundPaymentMethod(this, tx, orderId);
  }

  creditOverpayToAgent(orderId: string, actor: { userId: string; role: UserRole }): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    agentId: string;
    creditedAmount: number;
    newPaidAmount: number;
    total: number;
    agentBalanceAfter: number;
  }> {
    return fundsLinksSvc.creditOverpayToAgent(this, orderId, actor);
  }

  applyAgentBalanceToOrder(orderId: string, amount: number, actor: { userId: string; role: UserRole }): Promise<{
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
    return fundsLinksSvc.applyAgentBalanceToOrder(this, orderId, amount, actor);
  }

  overpayToPool(orderId: string, actor: { userId: string; role: UserRole }): Promise<{
    ok: true;
    orderId: string;
    orderNumber: string;
    movedAmount: number;
    newPaidAmount: number;
    total: number;
    receiptId: string;
    receiptNo: string;
  }> {
    return fundsLinksSvc.overpayToPool(this, orderId, actor);
  }

  lookupOrderPublic(query: PublicOrderLookupQuery): Promise<MaskedOrderView | null> {
    return readSvc.lookupOrderPublic(this, query);
  }

  lookupOrderForReceiptUpload(orderNumber: string, lookupKey: string): Promise<{ orderId: string; balanceCny: number } | null> {
    return readSvc.lookupOrderForReceiptUpload(this, orderNumber, lookupKey);
  }

  updateStatus(
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason?: string,
    force?: boolean,
  ) {
    return statusSvc.updateStatus(this, id, toStatus, requester, reason, force);
  }

  batchUpdateStatus(
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
    return statusSvc.batchUpdateStatus(this, ids, toStatus, requester, reason, force);
  }

  batchCreateOrders(body: BatchCreateOrdersBody, requester: OrderRequester): Promise<{
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
    return createSvc.batchCreateOrders(this, body, requester);
  }

  resolveBundleFlightLegs(
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
    return createSvc.resolveBundleFlightLegs(this, bundleId, bundleDepartDate, bundleNightsOverride);
  }

  matchBundleScheduleByLocalDate(flightId: string, targetYmd: string): Promise<string | null> {
    return createSvc.matchBundleScheduleByLocalDate(this, flightId, targetYmd);
  }

  updateItemSettlementPrice(
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
    return pricingAdjustSvc.updateItemSettlementPrice(this, orderId, itemId, input, actor);
  }

  setInvoiceFlags(
    id: string,
    flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean },
  ): Promise<{
    id: string;
    orderNumber: string;
    outboundInvoiced: boolean;
    returnInvoiced: boolean;
    systemInvoiced: boolean;
  }> {
    return statusSvc.setInvoiceFlags(this, id, flags);
  }

  batchSetInvoiceFlags(
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
    return statusSvc.batchSetInvoiceFlags(this, ids, flags);
  }

  batchReschedule(input: BatchRescheduleBody, actor: { userId: string; role: UserRole }): Promise<{
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
    return rescheduleSvc.batchReschedule(this, input, actor);
  }

  batchSetSettlementLock(ids: string[], lock: boolean, userId: string): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      id: string;
      orderNumber: string;
      beforeLocked: boolean;
      settlementLockedAt: Date | null;
    }>;
  }> {
    return fundsLinksSvc.batchSetSettlementLock(this, ids, lock, userId);
  }

  batchSetPaymentsLock(orderIds: string[], locked: boolean, userId: string): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      orderId: string;
      orderNumber: string | null;
      ok: boolean;
      reason?: string;
      beforeLocked?: boolean;
      paymentsLockedAt?: Date | null;
    }>;
  }> {
    return fundsLinksSvc.batchSetPaymentsLock(this, orderIds, locked, userId);
  }

  batchAddPriceAdjustment(
    orderIds: string[],
    input: Omit<BatchPriceAdjustmentBody, 'orderIds'>,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    updated: number;
    skipped: number;
    results: Array<{
      orderId: string;
      orderNumber: string | null;
      ok: boolean;
      reason?: string;
      appliedAmountCny: number | null;
      /** PER_PAX 时的每人金额（PER_ORDER 为 null）——审计与回执要能还原「怎么乘出来的」。 */
      unitAmountCny: number | null;
      /** PER_PAX 时的占座人数（PER_ORDER 为 null）。 */
      seatPax: number | null;
      itemId?: string;
      before?: { subtotal: string; total: string };
      after?: { subtotal: string; total: string };
    }>;
  }> {
    return pricingAdjustSvc.batchAddPriceAdjustment(this, orderIds, input, actor);
  }

  _updateStatusWithinTx(
    tx: Prisma.TransactionClient,
    id: string,
    toStatus: OrderStatus,
    requester: OrderRequester,
    reason: string | undefined,
    newTaskIdsOut: string[],
    force?: boolean,
    releasedSeatClassIdsOut?: string[],
    invoiceCapWarningsOut?: string[],
  ) {
    return statusSvc._updateStatusWithinTx(this, tx, id, toStatus, requester, reason, newTaskIdsOut, force, releasedSeatClassIdsOut, invoiceCapWarningsOut);
  }

  assertRefundRejectionHotelCapacity(
    tx: Prisma.TransactionClient,
    items: ReadonlyArray<{
      kind: OrderItemKind;
      hotelRoomTypeId: string | null;
      randomStarTier: number | null;
      hotelCheckIn: Date | null;
      hotelCheckOut: Date | null;
    }>,
  ): Promise<void> {
    return statusSvc.assertRefundRejectionHotelCapacity(this, tx, items);
  }

  _computeRefundRatioByKind(tx: Prisma.TransactionClient, orderId: string, toStatus: OrderStatus): Promise<Map<ProductKind, number>> {
    return statusSvc._computeRefundRatioByKind(this, tx, orderId, toStatus);
  }

  selfUpdatePassenger(
    orderId: string,
    passengerId: string,
    input: SelfUpdatePassengerBody,
    requester: OrderRequester,
  ): Promise<{
    passenger: Record<string, unknown>;
    changedFields: string[];
    orderNumber: string;
  }> {
    return passengersSvc.selfUpdatePassenger(this, orderId, passengerId, input, requester);
  }

  assertBackfilledDocumentNotDuplicated(orderId: string, documentNumber: string, client: Prisma.TransactionClient = prisma): Promise<void> {
    return passengersSvc.assertBackfilledDocumentNotDuplicated(this, orderId, documentNumber, client);
  }

  updatePassengerVisaDates(
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
    return passengersSvc.updatePassengerVisaDates(this, orderId, passengerId, input, actor);
  }

  updatePassengerTicket(
    orderId: string,
    passengerId: string,
    input: UpdatePassengerTicketBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    passenger: Record<string, unknown>;
    orderNumber: string;
    passengerName: string;
    before: { pnr: string | null; eticketNumber: string | null };
    after: { pnr: string | null; eticketNumber: string | null };
    /** 本次真正变了值的字段（两个都没变时为空数组 —— 回填同一个号是幂等的，不是错误）。 */
    changedFields: Array<'pnr' | 'eticketNumber'>;
  }> {
    return passengersSvc.updatePassengerTicket(this, orderId, passengerId, input, actor);
  }

  requestChange(orderId: string, reason: string, requester: OrderRequester) {
    return statusSvc.requestChange(this, orderId, reason, requester);
  }

  getOrderItineraryData(orderId: string, requester: OrderRequester): Promise<{ orderNumber: string; itinerary: ItineraryData }> {
    return readSvc.getOrderItineraryData(this, orderId, requester);
  }

  assertCanView(order: { userId: string | null; agentId: string | null }, requester: OrderRequester) {
    return readSvc.assertCanView(this, order, requester);
  }

  assertCanTransition(
    order: { userId: string | null; agentId: string | null; status: OrderStatus },
    toStatus: OrderStatus,
    requester: OrderRequester,
  ) {
    return statusSvc.assertCanTransition(this, order, toStatus, requester);
  }

  resolveExportAgentScope(requester: OrderRequester): Promise<string[] | null> {
    return readSvc.resolveExportAgentScope(this, requester);
  }

  getDescendantAgentIds(agentId: string | undefined): Promise<string[]> {
    return readSvc.getDescendantAgentIds(this, agentId);
  }

  requestCancellation(id: string, reason: string | undefined, requester: OrderRequester) {
    return statusSvc.requestCancellation(this, id, reason, requester);
  }

  swapRefund(
    orderId: string,
    input: {
      swapFeeCny: number;
      replacementOrderNumber?: string;
      reason: string;
    },
    requester: OrderRequester,
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    netPaidCny: number;
    swapFeeCny: number;
    refundAmountCny: number;
    refundId: string;
  }> {
    return fundsLinksSvc.swapRefund(this, orderId, input, requester);
  }

  updateSwapReplacementOrderNumber(orderId: string, replacementOrderNumber: string | null, requester: OrderRequester): Promise<{
    order: ReturnType<typeof serializeOrder>;
    beforeReplacementOrderNumber: string | null;
    replacementOrderNumber: string | null;
  }> {
    return fundsLinksSvc.updateSwapReplacementOrderNumber(this, orderId, replacementOrderNumber, requester);
  }

  rescheduleOrderItem(
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
      /**
       * 内部专用旗子：**只**由 correctFlightSchedule 在过完「代理自助改单窗口」闸之后设置，
       * 用来绕过下面那句「仅运营/管理员可改期」。
       *
       * 为什么不是把那句闸整体放开：售后改期会收改期费、撤立减、推状态 —— 那是动钱的操作，
       * 代理永远碰不得。放开的只有纠错通道（correction=true，差价恒 0）这一条。
       * 请求体进不来这个字段：两条改期路由的 zod schema（z.object 默认剥未知键）都不含它。
       */
      selfServiceCorrection?: boolean;
      /**
       * 幂等键（按人改期的全员快路径传）：成功后在同一事务里往该航段行的 legActionLog
       * 追加一条 RESCHEDULE_ALL 流水，编排层下次拿同一个 token 重试时据此回放。
       *
       * 为什么 append 放在这里、而不是等它返回后另起一个事务补写：本方法整个是一个
       * `prisma.$transaction`，返回时座位与金额都已提交。事务外补写一旦失败（进程被杀、
       * 连接断开），就留下「钱已收、流水没留」的状态，下次重试认不出回放会再收一次差价。
       * 而且这一行的 metadata 正是本方法在改（flightChanged 标记），两处分开写必然互相覆盖。
       */
      requestToken?: string;
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
      /**
       * 原/新班次的**当地**出发日（YYYY-MM-DD，按各自 departureTz 折算；查不到班次为 null）。
       * 审计里光有 UTC 瞬间读不出「改到哪一天」——班次时刻存 UTC，港澳台/东南亚航线折下来常差一天。
       */
      fromDepartureLocal: string | null;
      toDepartureLocal: string | null;
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
    return rescheduleSvc.rescheduleOrderItem(this, orderId, input, actor);
  }

  upgradeOrderItemCabin(
    orderId: string,
    orderItemId: string,
    input: { note?: string },
    actor: { userId: string; role: UserRole; agentId?: string },
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
    return rescheduleSvc.upgradeOrderItemCabin(this, orderId, orderItemId, input, actor);
  }

  swapPassenger(
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
      // 新出行人的护照有效期 / 签发日（YYYY-MM-DD）：换人 = 录入一个新人的护照。
      // 证件号变化时旧人的这两项会被清空，本请求带的值即新人的值（缺有效期且本单按人出行 → 400）。
      passportExpiry?: string;
      passportIssueDate?: string;
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
    actor: { userId: string; role: UserRole; agentId?: string },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      passengerId: string;
      before: {
        fullName: string;
        documentNumber: string;
        /** 换人前的整单现场快照（供订单页「换人历史」还原换人那一刻的样子）。 */
        snapshot: SwapBeforeSnapshot;
      };
      after: {
        fullName: string;
        documentNumber: string;
        /** 换人重算结算价的结果（未跑重算 = null；跳过时 repriceSkipped 说明为什么）。 */
        reprice: {
          /** 差价基准 = 成交那天的日历每人价（换人费也一并回给审计，见 L10）。 */
          basisCny: number | null;
          oldShareCny: number;
          newSettlementCny: number | null;
          diffCny: number;
          feeCny: number;
          calendarSource: string | null;
          repriceSkipped: SwapRepriceSkipReason | null;
          itemId: string | null;
          itemAmountCny: number;
        } | null;
        /** 代理填的换人费不在配置档位里（运营复核时重点看这一笔）；运营/管理员不判。 */
        feeOffList?: boolean;
      };
      resetInvoice: boolean;
      resetVisa: boolean;
      visaTasksReset: number;
      feeCny: number;
      // 证件号变化触发的换人清洗：已清除旧出行人残留的生日/护照/签证/出生地信息
      clearedProfile: boolean;
    };
  }> {
    return passengersSvc.swapPassenger(this, orderId, passengerId, input, actor);
  }

  buildSwapBeforeSnapshot(
    tx: Prisma.TransactionClient,
    orderId: string,
    passengerId: string,
    passengerFacts: {
      chineseName: string | null;
      dateOfBirth: Date | null;
      passportExpiry: Date | null;
      visaExempt: boolean;
      visaStatus: VisaRequirement | null;
    },
  ): Promise<SwapBeforeSnapshot> {
    return passengersSvc.buildSwapBeforeSnapshot(this, tx, orderId, passengerId, passengerFacts);
  }

  resolveSwapRepriceQuote(db: Prisma.TransactionClient | typeof prisma, orderId: string, passengerId: string): Promise<SwapRepriceQuote> {
    return passengersSvc.resolveSwapRepriceQuote(this, db, orderId, passengerId);
  }

  resolveSwapRepriceBasis(
    db: Prisma.TransactionClient | typeof prisma,
    orderId: string,
    order: {
      passengers: ReadonlyArray<{ id: string }>;
      items: ReadonlyArray<{
        passengerId: string | null;
        metadata: Prisma.JsonValue | null;
        createdAt?: Date | null;
      }>;
      _count?: { splitsIn?: number; splitsOut?: number } | null;
    },
    passengerId: string,
  ): Promise<{
    basisCny: number | null;
    source: string | null;
    /** 基准里已经减过代理立减 → 换人当天也要减；false → 两边都不减（复审 H3）。 */
    discountApplied: boolean;
    /** 基准取自日历上的哪一格；换人当天先比这个键（见方法头）。取不到基准时为 null。 */
    key: SwapCalendarKey | null;
    note?: string;
  }> {
    return passengersSvc.resolveSwapRepriceBasis(this, db, orderId, order, passengerId);
  }

  swapPreview(
    orderId: string,
    passengerId: string,
    actor: { userId: string; role: UserRole; agentId?: string },
  ): Promise<{
    /** 差价基准 = 成交那天的日历每人价；null = 判不出（此时 repriceSkipped 必有值）。 */
    basisCny: number | null;
    oldShareCny: number;
    newSettlementCny: number | null;
    diffCny: number;
    calendarSource: string | null;
    settlementLocked: boolean;
    repriceSkipped?: SwapRepriceSkipReason;
    feeOptions: number[];
  }> {
    return passengersSvc.swapPreview(this, orderId, passengerId, actor);
  }

  assertPassengerEditScope(orderId: string, actor: { userId: string; role: UserRole; agentId?: string }): Promise<void> {
    return passengersSvc.assertPassengerEditScope(this, orderId, actor);
  }

  assertAgentSelfEditAllowed(orderId: string, actor: { userId: string; role: UserRole; agentId?: string }): Promise<void> {
    return passengersSvc.assertAgentSelfEditAllowed(this, orderId, actor);
  }

  correctFlightSchedule(
    orderId: string,
    itemId: string,
    newScheduleId: string,
    actor: { userId: string; role: UserRole; agentId?: string },
    options: { allowTicketed?: boolean } = {},
  ): ReturnType<OrderService['rescheduleOrderItem']> {
    return rescheduleSvc.correctFlightSchedule(this, orderId, itemId, newScheduleId, actor, options);
  }

  quoteFlightCorrectionDelta(itemId: string, newScheduleId: string): Promise<{ fromPrice: number; toPrice: number; deltaCny: number; sameFlight: boolean }> {
    return rescheduleSvc.quoteFlightCorrectionDelta(this, itemId, newScheduleId);
  }

  assertSelfServiceCorrectionIsFreeOfCharge(itemId: string, newScheduleId: string): Promise<void> {
    return rescheduleSvc.assertSelfServiceCorrectionIsFreeOfCharge(this, itemId, newScheduleId);
  }

  setOrderVisaStatus(
    orderId: string,
    visaStatus: VisaRequirement,
    actor: { userId: string; role: UserRole; agentId?: string },
    options: { withOrder?: boolean; noteData?: Prisma.OrderUpdateInput } = {},
  ): Promise<{
    order: ReturnType<typeof serializeOrder> | null;
    changed: boolean;
    before: VisaRequirement | null;
    after: VisaRequirement;
  }> {
    return passengersSvc.setOrderVisaStatus(this, orderId, visaStatus, actor, options);
  }

  correctPassenger(
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
      passportExpiry?: string;
      passportIssueDate?: string;
    },
    requester: OrderRequester,
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      passengerId: string;
      before: Record<string, string | null>;
      after: Record<string, string | null>;
      changedFields: string[];
    };
  }> {
    return passengersSvc.correctPassenger(this, orderId, passengerId, input, requester);
  }

  setPassengerVisaExempt(
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
    return passengersSvc.setPassengerVisaExempt(this, orderId, passengerId, input, actor);
  }

  swapItemHotel(
    orderId: string,
    itemId: string,
    input: SwapItemHotelBody,
    actor: { userId: string; role: UserRole; agentId?: string },
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
    return hotelSvc.swapItemHotel(this, orderId, itemId, input, actor);
  }

  splitHotelItemByRoomGroup(
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
    return hotelSvc.splitHotelItemByRoomGroup(this, orderId, itemId, input, actor);
  }

  rescheduleItemHotel(
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
    return hotelSvc.rescheduleItemHotel(this, orderId, itemId, input, actor);
  }

  changeOrderAgent(
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
    return hotelSvc.changeOrderAgent(this, orderId, input, actor);
  }

  addGroundItem(orderId: string, input: AddGroundItemBody, actor: { userId: string; role: UserRole }): Promise<{
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
    return hotelSvc.addGroundItem(this, orderId, input, actor);
  }

  addRoomSupplement(
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
    return hotelSvc.addRoomSupplement(this, orderId, input, actor);
  }

  addPriceAdjustment(
    orderId: string,
    input: OrderPriceAdjustmentBody,
    actor: { userId: string; role: UserRole },
    options?: { viaAgentSelfSettlement?: boolean },
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
    return pricingAdjustSvc.addPriceAdjustment(this, orderId, input, actor, options);
  }

  _addPriceAdjustmentWithinTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    input: OrderPriceAdjustmentBody,
    actor: { userId: string; role: UserRole },
    options?: { unitNote?: string },
  ) {
    return pricingAdjustSvc._addPriceAdjustmentWithinTx(this, tx, orderId, input, actor, options);
  }

  changeOrderBundle(orderId: string, input: ChangeOrderBundleBody, actor: { userId: string; role: UserRole }): Promise<{
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
    return hotelSvc.changeOrderBundle(this, orderId, input, actor);
  }

  assessOrderSplit(
    db: Prisma.TransactionClient,
    order: SplitSourceOrder,
    passengerIds: string[],
    options: { autoSplitRoomGroups?: boolean } = {},
  ): Promise<SplitAssessment> {
    return splitSvc.assessOrderSplit(this, db, order, passengerIds, options);
  }

  previewOrderSplit(
    orderId: string,
    body: { passengerIds: string[]; autoSplitRoomGroups?: boolean },
    actor: { userId: string; role: UserRole },
  ): Promise<{
    eligible: boolean;
    blockers: string[];
    warnings: string[];
    shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
    movedShareCny: number;
    movedPaidCny: number;
    movedAdjustmentCny: number;
    hotelItems: SplitHotelItemView[];
    upgradeItems: SplitUpgradeItemView[];
    commission: { mode: 'NONE' | 'SPLIT' | 'BLOCKED'; amountCny: number; reversalCny: number };
    roomGroupConflict: boolean;
  }> {
    return splitSvc.previewOrderSplit(this, orderId, body, actor);
  }

  splitOrder(orderId: string, input: SplitOrderInput, actor: { userId: string; role: UserRole }): Promise<SplitOrderResult> {
    return splitSvc.splitOrder(this, orderId, input, actor);
  }

  findSplitReplay(orderId: string, requestToken: string): Promise<SplitOrderResult | null> {
    return splitSvc.findSplitReplay(this, orderId, requestToken);
  }

  executeSplitWithinTx(
    tx: Prisma.TransactionClient,
    orderId: string,
    input: SplitOrderInput,
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
        /** 新单落库 total（份额 − 随拆分摊的售后费）——审计的 targetTotal 就取它。 */
        targetTotalCny: number;
        sourcePaidAfterCny: number;
        allShareRows: Array<{ passengerId: string; netCny: number; shareCny: number }>;
        passengerSummary: Array<{ id: string; name: string; moved: boolean }>;
        /** 佣金劈分明细（非空 → 事务外补一条 CRITICAL 审计 SPLIT_ORDER_COMMISSION）。 */
        commissionSplit: SplitCommissionAudit[];
        /**
         * 预存抵扣随拆搬移明细（非零 → 事务外补一条 CRITICAL 审计）。
         * 老的 PrepaymentTransaction(OFFSET) 流水仍按单指向源单，搬移只改订单侧的物化列，
         * 财务对账时要能一眼看到「这一单的抵扣被拆走了多少、去了哪张单」。
         */
        prepaymentOffsetSplit: { beforeCny: number; keptCny: number; movedCny: number } | null;
      }
  > {
    return splitSvc.executeSplitWithinTx(this, tx, orderId, input, actor, targetOrderNumber);
  }

  reschedulePassengers(
    orderId: string,
    input: {
      passengerIds: string[];
      orderItemId: string;
      newScheduleId: string;
      newCabin?: CabinClass;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
      roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
      requestToken: string;
    },
    actor: { userId: string; role: UserRole },
  ): Promise<ReschedulePassengersResult> {
    return rescheduleSvc.reschedulePassengers(this, orderId, input, actor);
  }

  _auditReschedulePassengers(
    result: ReschedulePassengersResult,
    actor: { userId: string; role: UserRole },
    movedPassengerIds: string[],
  ): Promise<void> {
    return rescheduleSvc._auditReschedulePassengers(this, result, actor, movedPassengerIds);
  }

  _assessCancelLeg(db: Prisma.TransactionClient, orderId: string, leg: FlightLegSide): Promise<{
    order: CancelLegOrderSnapshot;
    legItem: CancelLegItemSnapshot | null;
    blockers: string[];
    /** 全部非阻断提示（含只需知会、不需回执的那些），前端原样展示。 */
    warnings: string[];
    /**
     * 其中**需要运营勾「我已知悉」才放行执行**的那些（见闸 8）。
     * 与 warnings 分开是因为有些提示（如「乘客身上有票号但本段没有出票任务」）只是知会，
     * 硬要回执会让运营养成闭眼勾的习惯，真正要紧的那条反而被稀释。
     */
    ackWarnings: string[];
    /** 本段确认出票的记录数（>0 → 执行时给票务派撤名单/退票工单）。 */
    ticketedCount: number;
  }> {
    return legsSvc._assessCancelLeg(this, db, orderId, leg);
  }

  _quoteLegCancelFee(db: Prisma.TransactionClient, itemId: string, legAmountCny: number, at: Date): Promise<LegCancelPolicyFee | null> {
    return legsSvc._quoteLegCancelFee(this, db, itemId, legAmountCny, at);
  }

  _describeLeg(item: CancelLegItemSnapshot): CancelLegItemView {
    return legsSvc._describeLeg(this, item);
  }

  previewCancelLeg(orderId: string, leg: FlightLegSide, actor: { userId: string; role: UserRole }): Promise<CancelLegPreview> {
    return legsSvc.previewCancelLeg(this, orderId, leg, actor);
  }

  previewCancelReturnLeg(orderId: string, actor: { userId: string; role: UserRole }): Promise<CancelLegPreview> {
    return legsSvc.previewCancelReturnLeg(this, orderId, actor);
  }

  cancelLeg(orderId: string, input: CancelLegBody, actor: { userId: string; role: UserRole }): Promise<{ order: ReturnType<typeof serializeOrder>; audit: CancelLegAudit }> {
    return legsSvc.cancelLeg(this, orderId, input, actor);
  }

  cancelReturnLeg(orderId: string, input: CancelReturnLegBody, actor: { userId: string; role: UserRole }): Promise<{ order: ReturnType<typeof serializeOrder>; audit: CancelLegAudit }> {
    return legsSvc.cancelReturnLeg(this, orderId, input, actor);
  }

  _assessNoShow(
    db: Prisma.TransactionClient,
    orderId: string,
    passengerIds: string[] | undefined,
    releaseReturn = true,
  ): Promise<{
    order: CancelLegOrderSnapshot;
    outboundItem: CancelLegItemSnapshot | null;
    returnItem: CancelLegItemSnapshot | null;
    returnTicketedCount: number;
    blockers: string[];
    warnings: string[];
    scope: NoShowScope;
    alreadyNoShow: boolean;
    /**
     * 回程班次**已关柜**（releaseReturn=true 时同时会有一条 blocker）。
     * 字段名是历史契约（前端在用），口径已随闸 5b 改成关柜时刻，含「已起飞」这一段。
     */
    returnDeparted: boolean;
    /** true = 去程早标过 no-show、回程已恢复回来，本次只是「再释放一次回程」。 */
    isRerelease: boolean;
  }> {
    return legsSvc._assessNoShow(this, db, orderId, passengerIds, releaseReturn);
  }

  assessOrderSplitForNoShow(db: Prisma.TransactionClient, orderId: string, passengerIds: string[]): Promise<string[]> {
    return legsSvc.assessOrderSplitForNoShow(this, db, orderId, passengerIds);
  }

  _describeNoShowLeg(item: CancelLegItemSnapshot): NoShowLegView {
    return legsSvc._describeNoShowLeg(this, item);
  }

  previewNoShow(
    orderId: string,
    body: { passengerIds?: string[]; releaseReturn?: boolean },
    actor: { userId: string; role: UserRole },
  ): Promise<NoShowPreview> {
    return legsSvc.previewNoShow(this, orderId, body, actor);
  }

  markNoShow(orderId: string, input: NoShowBody, actor: { userId: string; role: UserRole }): Promise<{
    order: ReturnType<typeof serializeOrder>;
    targetOrderId: string;
    audit: NoShowAudit;
  }> {
    return legsSvc.markNoShow(this, orderId, input, actor);
  }

  _executeNoShow(
    targetOrderId: string,
    input: NoShowBody,
    actor: { userId: string; role: UserRole },
    split: { sourceOrderNumber: string; targetOrderNumber: string } | null,
  ): Promise<NoShowAudit> {
    return legsSvc._executeNoShow(this, targetOrderId, input, actor, split);
  }

  _assessRestoreReturnLeg(db: Prisma.TransactionClient, orderId: string): Promise<{
    order: CancelLegOrderSnapshot;
    releasedItem: CancelLegItemSnapshot | null;
    snapshot: ReturnReleasedSnapshot | null;
    /** 逐舱位的恢复需求（照释放时的快照回填，不重新按 quantity 推算）。 */
    seatNeeds: RestoreSeatNeed[];
    blockers: string[];
    available: number;
    /** 本次**新增**的超售座数（Σ increment，纯 sold vs capacity 口径）。 */
    oversellBy: number;
    /** 余位缺口（Σ max(0, 要占的座 − available)）——决定要不要运营二次确认，含锁位/占位口径。 */
    seatShortfall: number;
    /** 本次会挤掉几座他人软预留（Σ 逐舱 displacedReserved）——前端文案与 CRITICAL 审计用。 */
    reservedConflict: number;
    /** 恢复**之后**这些舱一共超出几座（Σ max(0, after)）——上限判定与风控看的是这个数。 */
    oversoldAfter: number;
    /** 逐舱三值（before/after/increment），供前端与审计逐舱对账。 */
    oversellDetail: OversellSeatDetail[];
    /** 原班次**已关柜**（字段名是历史契约，口径含「已起飞」这一段）。 */
    departed: boolean;
    scheduleId: string | null;
    /** 释放快照里逐舱张数之和 = 本次要恢复的总座数（预检展示口径，与实际占回数一致）。 */
    releasedSeatTotal: number;
  }> {
    return legsSvc._assessRestoreReturnLeg(this, db, orderId);
  }

  previewRestoreReturnLeg(orderId: string, actor: { userId: string; role: UserRole }): Promise<RestoreReturnLegPreview> {
    return legsSvc.previewRestoreReturnLeg(this, orderId, actor);
  }

  restoreReturnLeg(orderId: string, input: RestoreReturnLegBody, actor: { userId: string; role: UserRole }): Promise<{ order: ReturnType<typeof serializeOrder>; audit: RestoreReturnLegAudit }> {
    return legsSvc.restoreReturnLeg(this, orderId, input, actor);
  }

  previewVoidReturnLeg(orderId: string, actor: { userId: string; role: UserRole }): Promise<VoidReturnLegPreview> {
    return legsSvc.previewVoidReturnLeg(this, orderId, actor);
  }

  voidReturnLeg(orderId: string, input: VoidReturnLegBody, actor: { userId: string; role: UserRole }): Promise<{ order: ReturnType<typeof serializeOrder>; audit: VoidReturnLegAudit }> {
    return legsSvc.voidReturnLeg(this, orderId, input, actor);
  }

  _assessVoidReturnLeg(db: Prisma.TransactionClient, orderId: string): Promise<{
    order: CancelLegOrderSnapshot;
    item: CancelLegItemSnapshot | null;
    blockers: string[];
    departed: boolean;
    original: VoidReturnLegPreview['original'];
  }> {
    return legsSvc._assessVoidReturnLeg(this, db, orderId);
  }
}

/**
 * 内部留痕前缀（no-show / 释放 / 取消航段）与剥前缀函数**都住在 orders.leg-status.ts**：
 * 退款报价引擎 lib/cancellation.ts 也要剥前缀，而 lib 层 import 本文件会形成反向依赖。
 * 这里只做 re-export，让既有调用方（含单测）保持从本模块 import 不变。
 * 写成 `export … from`（而不是转发本文件顶部那个 import 绑定）：后者在 vitest 的
 * `vi.mock('./orders.service.js')` 局部 mock 下会变成一个指向未初始化局部绑定的 getter，
 * 测试一 spread importOriginal() 就 ReferenceError。
 */
export { stripInternalLegPrefix } from './orders.leg-status.js';

// 「价格调整」商品行按乘客分组：实现已抽成叶子模块 order-adjustment-lines.ts（lib/order-money 要用它，
// 而 lib 不能反向 import 本文件），这里原样 re-export，所有既有 import 路径与算法一字不变。
export { groupPassengerAdjustments, type AdjustmentLine } from './order-adjustment-lines.js';
