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
  BundleChangeRequestStatus,
  ReminderStatus,
  CabinClass,
  CommissionStatus,
  OrderChangeKind,
  OrderChangeRequestStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  PaymentMethod,
  PaymentStatus,
  PrepaymentTxType,
  Prisma,
  ProductKind,
  RefundStatus,
  ReminderPriority,
  SettlementRequestStatus,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors.js';
import type { ItineraryData } from '../../lib/itinerary-pdf.js';
import { writeAudit, writeAuditWithinTx } from '../../lib/audit.js';
import { localHHMM, localDateISO } from '../../lib/flight-time.js';
import { checkinCloseAt, isCheckinClosed } from '../../lib/checkin-close.js';
import { businessDateISO, businessDateTime } from '../../lib/business-time.js';
import { orderNeedsVisaTask } from './visa-need.js';
import {
  isReturnCurrentlyReleased,
  stripInternalLegPrefix,
  LEG_CANCELLED_OUTBOUND_PREFIX,
  LEG_CANCELLED_RETURN_PREFIX,
  LEGACY_NO_SHOW_PREFIX,
  LEGACY_RETURN_RELEASED_PREFIX,
  NO_SHOW_PREFIX,
  RETURN_RELEASED_PREFIX,
} from './orders.leg-status.js';
import { computePerPaxShares, spreadableAdjustmentCny } from './per-pax-share.js';
import { groupPassengerAdjustments } from './order-adjustment-lines.js';
import { payableCny } from '../../lib/order-money.js';
import {
  deriveRoomsToMove,
  isTerminalLegItem,
  movedUnitsFor,
  occupancyOfPassengers,
  planItemMove,
  readUpgradeCount,
  resolveUpgradeToMove,
  roundHalfGrid,
  type SplitContext,
  type SplitItemView,
  type SplitMove,
  type SplitOccupancy,
  type SplitRowPatch,
} from './split-move-strategies.js';
import {
  assertOrderAcceptsFunds,
  assertOrderAllowsFundsDisposal,
  FUNDS_DISPOSE_BLOCKED_STATUSES,
  sumCompletedRefundsWithinTx,
} from '../../lib/funds-guard.js';
import { resolveBundleNights } from '../products/bundle-nights.js';
import { getSettlementRate } from '../settlement-rates/settlement-rates.service.js';
import { bundleRouteKey } from '../products/bundle-route.js';
import {
  resolveAgentSettlementDiscount,
} from '../settlement-discounts/settlement-discounts.service.js';
import {
  assertRandomTierFitWithinTx,
  checkHotelPhysicalFit,
  lockHotelBlockPeriodsWithinTx,
  randomStarTierLabel,
} from '../hotel-control/hotel-control.service.js';
import { RANDOM_TIER_LEGACY_CITY_CODE } from '../hotel-control/hotel-city.js';
import { env } from '../../config/env.js';
import { PricingService } from '../pricing/pricing.service.js';
import { OPERATION_FEE_CNY_PER_ORDER } from './order-cost-items.service.js';
import {
  DERIVABLE_TASK_STATUSES,
  ourVisaPassengersWhere,
  rederiveVisaTaskStatus,
} from '../fulfillment/visa-state.js';
import { syncOrderVisaCompletion } from '../fulfillment/visa-completion.js';
import { resolveSelfVisaDeductCny } from '../products/self-visa-deduct.js';
import { determineFlightLegItems } from './ticketing-cap.js';
import { PRICE_ADJUSTMENT_CAP_CNY } from './orders.schemas.js';
import { noShowReleasedReminderRuleKeys } from '../reminders/reminders.rules.js';
import { isFeatureEnabled } from '../../lib/feature-flags.js';
import { pushWecomMarkdown } from '../../lib/wecom-webhook.js';
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
  PriceAdjustmentReasonDisplay,
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
import { FulfillmentStatus, FulfillmentType, VisaRequirement } from '@prisma/client';
import {
  assertHotelStaysFitWithinTx,
  assertRandomTierStaysFitWithinTx,
  buildStayNightDates,
  type BundleAddOnBreakdown,
  type BundleBusinessUpgradeSplit,
  type BundleOccupancy,
  computeBundleAddOn,
  computeBundleGroundTotal,
  computeBundleOperationFeeTotal,
  computeBundleRoomsCharged,
  MAX_STAY_NIGHTS,
  type ProspectiveHotelStay,
  resolveBundleBusinessUpgradeRate,
  resolveBundleHotelStamp,
  resolveBundleOccupancy,
  rewriteHotelStayDescription,
  toProspectiveOccupancy,
} from './service/bundle-pricing.js';
import type { BundleFlightLeg } from './service/create.js';
import {
  appendLegActionLog,
  assertLegActionTokenReplay,
  assertNonEmptyPassengerSelection,
  cancelLegFingerprint,
  EMPTY_LEG_ACTION_FINGERPRINT,
  hasSeenLegActionToken,
  type LegActionLogEntry,
  noShowFingerprint,
  readJsonObject,
  type ReleasedSeatEntry,
  type ReturnReleasedSnapshot,
  type SplitOrchestrationSnapshot,
  tokenPayloadMismatchError,
} from './service/leg-action-log.js';
import type {
  SwapBeforeSnapshot,
  SwapRepriceQuote,
  SwapRepriceSkipReason,
} from './service/passengers.js';
import {
  type AgentStatsResult,
  deriveOrderDepartDate,
  type MaskedOrderView,
  orderSerializeRoleCtx,
  serializeOrder,
} from './service/read.js';
import type { ReschedulePassengersResult } from './service/reschedule.js';
import {
  cabinSeatStateWithinTx,
  computeBundleSeatSplit,
  computeDisplacedReserved,
  computeOversellDelta,
  type DisplacedReservationDetail,
  lockSeatClassWithinTx,
  type OversellSeatDetail,
  oversellSeatWithinTx,
  releaseSeatFloored,
  releaseSeatStrictWithinTx,
  takeSeatWithinTx,
} from './service/seat-inventory.js';
import {
  actorCan,
  addDaysToYmd,
  AGENT_SELF_EDIT_REASON,
  appendAdjustment,
  type AutoDiscountSummary,
  buildPriceAdjustmentItem,
  buildRoomSupplementItem,
  buildStarMismatchMessage,
  CABIN_ZH_LABEL,
  computeAgentSelfEditWindow,
  computeGroundItemAmounts,
  computeSwapHotelCostSnapshot,
  type DesignatedHotelStarGate,
  type DesignatedHotelStarMismatchOverride,
  type DuplicateCheckPassenger,
  type DuplicatePassengerConflict,
  formatDateOnly,
  formatMonthDay,
  generateOrderNumber,
  type GuestRequester,
  isSettlementTierStarMismatch,
  ORDER_FULL_INCLUDE,
  type OrderRequester,
  type PricedOrderItem,
  RANDOM_TIER_INTERNAL_NO_CAP,
  resolveGroundItemUnitPrice,
  resolveRoomSupplementCost,
  type RoomCostSource,
  round2,
  SEAT_HOLDING_STATUSES,
  SETTLEMENT_TIER_STAR_RATING,
  type SwapCalendarKey,
  syncOrderHasReturnLeg,
  syncOrderLegFlag,
  zhStatus,
} from './service/shared.js';
import {
  carryVisaTaskForSplit,
  createFulfillmentTasks,
  syncVisaTasksForOrder,
} from './service/visa-sync.js';
import * as readSvc from './service/read.js';
import * as statusSvc from './service/status.js';
import * as fundsLinksSvc from './service/funds-links.js';
import * as pricingAdjustSvc from './service/pricing-adjust.js';
import * as createSvc from './service/create.js';
import * as passengersSvc from './service/passengers.js';
import * as rescheduleSvc from './service/reschedule.js';

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

export class OrderService {
  readonly pricing = new PricingService();
  createHoldConversionOrderWithinTx(tx: Prisma.TransactionClient, input: {
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
    }) {
    return createSvc.createHoldConversionOrderWithinTx(this, tx, input);
  }

  advanceOrderToPaidIfClearedWithinTx(tx: Prisma.TransactionClient, orderId: string, requester: OrderRequester, pendingFulfillmentTaskIds: string[]): Promise<{ fullyPaid: boolean; status: OrderStatus }> {
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

  applyPassportExpiryRule(body: CreateOrderBody, pricedItems: Array<{ kind: OrderItemKind; description: string; quantity: number; unitPrice: number; amount: number; totalCostCny?: number }>): Promise<void> {
    return createSvc.applyPassportExpiryRule(this, body, pricedItems);
  }

  applyAgentSettlementDiscount(pricedItems: PricedOrderItem[], calendar: { totalCny: number; audit: Record<string, unknown> }, agentId: string): Promise<AutoDiscountSummary | null> {
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

  resolveBundleItemDepartureLocalDate(body: Pick<CreateOrderBody, 'items'>, bundleItem: Extract<OrderItemInput, { kind: 'BUNDLE' }>): Promise<string | null> {
    return createSvc.resolveBundleItemDepartureLocalDate(this, body, bundleItem);
  }

  assertNoDuplicatePassengersOnFlights(flightScheduleIds: string[], passengers: ReadonlyArray<DuplicateCheckPassenger>, allowDuplicate = false): Promise<DuplicatePassengerConflict[]> {
    return createSvc.assertNoDuplicatePassengersOnFlights(this, flightScheduleIds, passengers, allowDuplicate);
  }

  priceAndValidateItems(items: OrderItemInput[], flightSettlementPriceCny?: number, passengers?: ReadonlyArray<{
      visaExempt?: boolean;
      singleRoom?: boolean;
      gender?: 'M' | 'F' | 'X';
    }>, allowClientPricedGround = false, starGate?: DesignatedHotelStarGate, hotelOversellCapRooms?: number) {
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

  _recordOverpayDisposalPayment(tx: Prisma.TransactionClient, input: {
      orderId: string;
      amountCny: number;
      method: PaymentMethod;
      disposal: 'AGENT_BALANCE' | 'RECEIPT_POOL';
      description: string;
    }): Promise<void> {
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

  updateStatus(id: string, toStatus: OrderStatus, requester: OrderRequester, reason?: string, force?: boolean) {
    return statusSvc.updateStatus(this, id, toStatus, requester, reason, force);
  }

  batchUpdateStatus(ids: string[], toStatus: OrderStatus, requester: OrderRequester, reason?: string, force?: boolean): Promise<{
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

  resolveBundleFlightLegs(bundleId: string, bundleDepartDate: string | undefined, bundleNightsOverride: number | undefined): Promise<
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

  updateItemSettlementPrice(orderId: string, itemId: string, input: UpdateItemSettlementPriceBody, actor: { userId: string; role: UserRole }): Promise<{
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

  setInvoiceFlags(id: string, flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean }): Promise<{
    id: string;
    orderNumber: string;
    outboundInvoiced: boolean;
    returnInvoiced: boolean;
    systemInvoiced: boolean;
  }> {
    return statusSvc.setInvoiceFlags(this, id, flags);
  }

  batchSetInvoiceFlags(ids: string[], flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean }): Promise<{
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

  batchAddPriceAdjustment(orderIds: string[], input: Omit<BatchPriceAdjustmentBody, 'orderIds'>, actor: { userId: string; role: UserRole }): Promise<{
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

  _updateStatusWithinTx(tx: Prisma.TransactionClient, id: string, toStatus: OrderStatus, requester: OrderRequester, reason: string | undefined, newTaskIdsOut: string[], force?: boolean, releasedSeatClassIdsOut?: string[], invoiceCapWarningsOut?: string[]) {
    return statusSvc._updateStatusWithinTx(this, tx, id, toStatus, requester, reason, newTaskIdsOut, force, releasedSeatClassIdsOut, invoiceCapWarningsOut);
  }

  assertRefundRejectionHotelCapacity(tx: Prisma.TransactionClient, items: ReadonlyArray<{
      kind: OrderItemKind;
      hotelRoomTypeId: string | null;
      randomStarTier: number | null;
      hotelCheckIn: Date | null;
      hotelCheckOut: Date | null;
    }>): Promise<void> {
    return statusSvc.assertRefundRejectionHotelCapacity(this, tx, items);
  }

  _computeRefundRatioByKind(tx: Prisma.TransactionClient, orderId: string, toStatus: OrderStatus): Promise<Map<ProductKind, number>> {
    return statusSvc._computeRefundRatioByKind(this, tx, orderId, toStatus);
  }

  selfUpdatePassenger(orderId: string, passengerId: string, input: SelfUpdatePassengerBody, requester: OrderRequester): Promise<{
    passenger: Record<string, unknown>;
    changedFields: string[];
    orderNumber: string;
  }> {
    return passengersSvc.selfUpdatePassenger(this, orderId, passengerId, input, requester);
  }

  assertBackfilledDocumentNotDuplicated(orderId: string, documentNumber: string, client: Prisma.TransactionClient = prisma): Promise<void> {
    return passengersSvc.assertBackfilledDocumentNotDuplicated(this, orderId, documentNumber, client);
  }

  updatePassengerVisaDates(orderId: string, passengerId: string, input: UpdatePassengerVisaDatesBody, actor: { userId: string; role: UserRole }): Promise<{
    passenger: Record<string, unknown>;
    orderNumber: string;
    before: { visaIssueDate: string | null; visaEffectiveDate: string | null; visaExpiry: string | null };
    after: { visaIssueDate: string | null; visaEffectiveDate: string | null; visaExpiry: string | null };
  }> {
    return passengersSvc.updatePassengerVisaDates(this, orderId, passengerId, input, actor);
  }

  updatePassengerTicket(orderId: string, passengerId: string, input: UpdatePassengerTicketBody, actor: { userId: string; role: UserRole }): Promise<{
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

  assertCanTransition(order: { userId: string | null; agentId: string | null; status: OrderStatus }, toStatus: OrderStatus, requester: OrderRequester) {
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

  swapRefund(orderId: string, input: {
      swapFeeCny: number;
      replacementOrderNumber?: string;
      reason: string;
    }, requester: OrderRequester): Promise<{
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

  rescheduleOrderItem(orderId: string, input: {
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
    }, actor: { userId: string; role: UserRole }): Promise<{
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

  upgradeOrderItemCabin(orderId: string, orderItemId: string, input: { note?: string }, actor: { userId: string; role: UserRole; agentId?: string }): Promise<{
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

  swapPassenger(orderId: string, passengerId: string, input: {
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
    }, actor: { userId: string; role: UserRole; agentId?: string }): Promise<{
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

  buildSwapBeforeSnapshot(tx: Prisma.TransactionClient, orderId: string, passengerId: string, passengerFacts: {
      chineseName: string | null;
      dateOfBirth: Date | null;
      passportExpiry: Date | null;
      visaExempt: boolean;
      visaStatus: VisaRequirement | null;
    }): Promise<SwapBeforeSnapshot> {
    return passengersSvc.buildSwapBeforeSnapshot(this, tx, orderId, passengerId, passengerFacts);
  }

  resolveSwapRepriceQuote(db: Prisma.TransactionClient | typeof prisma, orderId: string, passengerId: string): Promise<SwapRepriceQuote> {
    return passengersSvc.resolveSwapRepriceQuote(this, db, orderId, passengerId);
  }

  resolveSwapRepriceBasis(db: Prisma.TransactionClient | typeof prisma, orderId: string, order: {
      passengers: ReadonlyArray<{ id: string }>;
      items: ReadonlyArray<{
        passengerId: string | null;
        metadata: Prisma.JsonValue | null;
        createdAt?: Date | null;
      }>;
      _count?: { splitsIn?: number; splitsOut?: number } | null;
    }, passengerId: string): Promise<{
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

  swapPreview(orderId: string, passengerId: string, actor: { userId: string; role: UserRole; agentId?: string }): Promise<{
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

  correctFlightSchedule(orderId: string, itemId: string, newScheduleId: string, actor: { userId: string; role: UserRole; agentId?: string }, options: { allowTicketed?: boolean } = {}): ReturnType<OrderService['rescheduleOrderItem']> {
    return rescheduleSvc.correctFlightSchedule(this, orderId, itemId, newScheduleId, actor, options);
  }

  quoteFlightCorrectionDelta(itemId: string, newScheduleId: string): Promise<{ fromPrice: number; toPrice: number; deltaCny: number; sameFlight: boolean }> {
    return rescheduleSvc.quoteFlightCorrectionDelta(this, itemId, newScheduleId);
  }

  assertSelfServiceCorrectionIsFreeOfCharge(itemId: string, newScheduleId: string): Promise<void> {
    return rescheduleSvc.assertSelfServiceCorrectionIsFreeOfCharge(this, itemId, newScheduleId);
  }

  setOrderVisaStatus(orderId: string, visaStatus: VisaRequirement, actor: { userId: string; role: UserRole; agentId?: string }, options: { withOrder?: boolean; noteData?: Prisma.OrderUpdateInput } = {}): Promise<{
    order: ReturnType<typeof serializeOrder> | null;
    changed: boolean;
    before: VisaRequirement | null;
    after: VisaRequirement;
  }> {
    return passengersSvc.setOrderVisaStatus(this, orderId, visaStatus, actor, options);
  }

  correctPassenger(orderId: string, passengerId: string, input: {
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
    }, requester: OrderRequester): Promise<{
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

  setPassengerVisaExempt(orderId: string, passengerId: string, input: {
      visaExempt: boolean;
      note?: string;
      /** 送签已在办理时的人为确认：退多少（0=不退）+ 原因。见 orders.schemas 同名字段注释。 */
      submittedOverride?: { refundCny: number; reason: string };
    }, actor: { userId: string; role: UserRole }): Promise<{
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
    // 代理自助换酒店（下单当天、自家单）：过窗口闸后放行；客户与过期窗口一律 403。
    const isSelfService = actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF;
    if (isSelfService) {
      await this.assertAgentSelfEditAllowed(orderId, actor);
    }
    // 自助通道差价恒 0（请求里填了也不认）：代理自助只改「住哪」，动钱一律走运营。
    const feeCny = isSelfService ? 0 : Math.trunc(input.feeCny ?? 0);

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
              // starRating：自助换酒店的同星级闸要拿它跟目标酒店比（见下方）。
              hotel: { select: { name: true, starRating: true, randomTierPlaceholder: true } },
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

    // ── 自助换酒店只许「同星级」（HIGH 修复）──────────────────────────────────
    // 差价被强制归 0 的前提是「换的是同一档住宿」。不比星级的话，自助通道就是一条免费升星的路：
    // 三星换五星，房量真的占过去、成本真的抬上去，我方一分钱收不到；反过来降星则是悄悄降级
    // 交付，客人买的档次没兑现，事后只能靠客诉才发现。
    // 现势星级来源：具体酒店行看当前酒店（含挂在占位酒店上的伪落位行）；未落位随机行看它买的档次。
    // 取不到现势星级（数据异常）一律按不符处理 —— 自助口子上宁可少放行。
    if (isSelfService) {
      const currentStar = isRandomPoolRow
        ? item.randomStarTier
        : (oldRoomType?.hotel.starRating ?? null);
      if (currentStar == null || newRoomType.hotel.starRating !== currentStar) {
        throw new BadRequestError('当日自助只能换同星级酒店，升降星请提交改单申请');
      }
    }

    // ── 套餐行的星级不匹配闸（口径与录单指定酒店同一份映射，见 SETTLEMENT_TIER_STAR_RATING）──
    // 套餐行的钱是按 Bundle.settlementTier 收的；售后把住宿换到别的档次而系统不知情，
    // 就等于「四星档的钱住三星店」从售后口子溜进来。两档口径，与录单指定酒店那道闸完全一致：
    //   · 运营（ADMIN/STAFF）→ 必须写明放行原因才过，放行写 WARNING 审计（谁放的、为什么放）；
    //   · 代理自助 → **硬拒**，没有放行原因这个口子。放行是「明知档次不符仍按此成交」的定价决定，
    //     代理自己填一行原因就能把四星档的单落到三星店，等于把定价权从我方手里拿走；
    //     真有这种需求走运营。请求体里带了 designatedHotelStarMismatchReason 也一律不认。
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
        // 代理自助：硬拒，放行原因一概不认（越权定价的口子对外身份一律不开）。
        if (isSelfService) {
          throw new BadRequestError(
            `${buildStarMismatchMessage(swapBundle.settlementTier, newRoomType.hotel)}。` +
              '套餐档次与酒店星级不符，请联系运营处理。',
          );
        }
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
          // 自助窗口的锁内复查要用（口径同入口 assertAgentSelfEditAllowed）。
          createdAt: true,
          outboundInvoiced: true,
          returnInvoiced: true,
          systemInvoiced: true,
          settlementLocked: true,
        },
      });
      if (!order) throw new NotFoundError('订单不存在');

      // ── 自助窗口锁内复查（L3）───────────────────────────────────────────────
      // 入口那次判定是锁外快照：从判完到拿锁之间订单可能已出票/已开票/已锁结算价，或者
      // 跨过了北京业务日 24:00。拿刚锁住的这一行重跑同一份纯函数，报错文案也是同一句。
      if (actor.role === UserRole.AGENT) {
        const window = computeAgentSelfEditWindow(order);
        if (!window.open) {
          throw new ForbiddenError(window.reason ?? AGENT_SELF_EDIT_REASON.NEXT_DAY);
        }
      }

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
            hotelRoomType: {
              select: { name: true, hotel: { select: { name: true, randomTierPlaceholder: true } } },
            },
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
    if (!actorCan(actor, 'orders.hotel.write')) {
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
      // 套餐行同样可拆房组（0902 放开）：套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上，
      // 「拆行不拆应收」的金额口径对它一字不差地成立 —— 新行 0 元、源行 amount 不动，
      // 只把 roomsBilled 与成本按间数挪过去。新行落 kind=HOTEL（不是第二条 BUNDLE 行）：
      // 多一条套餐行会让改档（resolveChangeableBundleRow）与拆单的套餐行数闸一起失灵。
      if (item.kind !== OrderItemKind.HOTEL && item.kind !== OrderItemKind.BUNDLE) {
        throw new BadRequestError('该行不是住宿行，无法拆分房组');
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

      // 套餐行拆出来的住宿行：单价必须一并归 0（钱全留在套餐行上）。
      // 照抄套餐行的 unitPrice（整包一口价）会得到一条「单价 ¥12800 / 金额 ¥0」的行 ——
      // 运营看不懂，任何按 unitPrice × quantity 复算金额的地方都会把它算成一笔没入账的钱。
      // 描述加后缀点明它是从哪儿拆出来的（新行 kind=HOTEL，不带套餐名会以为是另买的酒店）。
      const isFromBundle = item.kind === OrderItemKind.BUNDLE;
      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: OrderItemKind.HOTEL,
          description: isFromBundle ? `${item.description}（拆出住宿）` : item.description,
          quantity: item.quantity,
          unitPrice: isFromBundle ? new Prisma.Decimal(0) : item.unitPrice,
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
    if (!actorCan(actor, 'orders.hotel.write')) {
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
        // 单独随机行没有酒店也就没有城市 → 存量默认城市（见 hotel-city.ts）。
        await assertRandomTierFitWithinTx(
          tx,
          { tier: item.randomStarTier!, cityCode: RANDOM_TIER_LEGACY_CITY_CODE },
          nightDates,
          roomsBilled,
          {
            excludeOrderId: orderId,
            maxOversellRooms: RANDOM_TIER_INTERNAL_NO_CAP,
          },
        );
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
    if (!actorCan(actor, 'orders.agent.write')) {
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
    if (!actorCan(actor, 'orders.add_ground_item')) {
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
    if (!actorCan(actor, 'orders.hotel.write')) {
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
          // 挂到转单住的那位乘客：这行带 priceAdjustment=true，不挂人会被每人结算价
          //（groupPassengerAdjustments）当整单调价摊给全员；导出「单房差」列也按它归属到人。
          // 未指定乘客（老入口/整单补收）→ null，仍走整单口径。
          passengerId: input.passengerId ?? null,
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
  addPriceAdjustment(orderId: string, input: OrderPriceAdjustmentBody, actor: { userId: string; role: UserRole }, options?: { viaAgentSelfSettlement?: boolean }): Promise<{
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

  _addPriceAdjustmentWithinTx(tx: Prisma.TransactionClient, orderId: string, input: OrderPriceAdjustmentBody, actor: { userId: string; role: UserRole }, options?: { unitNote?: string }) {
    return pricingAdjustSvc._addPriceAdjustmentWithinTx(this, tx, orderId, input, actor, options);
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
    if (!actorCan(actor, 'orders.change_bundle')) {
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
      // 人工复核提示（不阻断，随响应回给运营）。
      const warnings: string[] = [];
      // 目标套餐的航线从其绑定航班派生（bundle-route.ts 唯一入口）：配了日历键却没绑航班 = 没有航线，
      // 不取日历价（绝不兜底到某条既有航线），本次按套餐价计并提示运营——与录单侧「不取、不报错」同口径。
      const newBundleRouteKey = bundleRouteKey(newBundle);
      if (
        locked.agentId &&
        newBundle.settlementTier != null &&
        newBundle.settlementNights != null &&
        newBundleRouteKey == null
      ) {
        warnings.push(
          '目标套餐已配置结算价日历但未绑定航班，无法确定航线取价：本次按套餐价计，请核对后手工调价，或先给套餐绑定航班再改档',
        );
      }
      if (
        locked.agentId &&
        newBundle.settlementTier != null &&
        newBundle.settlementNights != null &&
        newBundleRouteKey != null
      ) {
        if (!departYmd) {
          throw new BadRequestError(
            '目标套餐已配置结算价日历，但本单无法确定出发日期取价，请先补全航段或联系运营',
          );
        }
        const rate = await getSettlementRate(
          newBundleRouteKey,
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
          newBundleRouteKey,
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
      if (rowMetadata.designatedHotel) {
        warnings.push('原「指定酒店」及其加价已随本次改档清除，请按新档次重新指定酒店');
      }
      if ((businessSplit.outbound ?? 0) > 0 || (businessSplit.return ?? 0) > 0) {
        warnings.push('本单含升舱，升舱行与占座一律未改动，请人工复核升舱差价是否仍适用新档次');
      }
      if (!priced.hotelStamp && newBundle.hotelRoomTypeId) {
        warnings.push('未能推导出新的住宿区间（缺出发日期），住宿日期未盖章，请人工补录');
      }
      // 房量变化提示：改档按新档次的容量重算 roomsBilled（priced.rooms 按人头算整间），
      // 拆单/分房留下的半间会被这一步抹平 —— 房控板上的占用会跟着跳，房控得知道为什么。
      const roomsBeforeChange = bundleRow.roomsBilled == null ? null : Number(bundleRow.roomsBilled);
      if (roomsBeforeChange != null && Math.abs(roomsBeforeChange - priced.rooms) > 1e-9) {
        warnings.push(
          `本单套餐行占房由 ${roomsBeforeChange} 间改为 ${priced.rooms} 间（按新档次容量重算，` +
            '拆单/分房留下的半间会被抹平）：请知会房控核对该酒店该日期的房量。',
        );
      }
      // 改档只换套餐档次与钱，不碰航段事实：去程真没飞就是没飞，标记原样留着。
      if (
        locked.items.some(
          (it) =>
            it.kind === OrderItemKind.FLIGHT &&
            readJsonObject(readJsonObject(it.metadata).noShow).at != null,
        )
      ) {
        warnings.push('本单去程已标记 no-show，改档不改变这一事实：该标记与回程座位状态原样保留');
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
      await assertRandomTierStaysFitWithinTx(tx, prospectiveStays, {
        excludeOrderId: orderId,
        maxOversellRooms: RANDOM_TIER_INTERNAL_NO_CAP,
      });

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
   * 只读不写；blockers 为空 = 可拆。warnings 是**非阻断**提示，只给运营看，不影响可拆判定。
   */
  private async assessOrderSplit(
    db: Prisma.TransactionClient,
    order: SplitSourceOrder,
    passengerIds: string[],
    options: { autoSplitRoomGroups?: boolean } = {},
  ): Promise<SplitAssessment> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const autoSplitRoomGroups = options.autoSplitRoomGroups === true;

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

    // ── 闸 4-5（已放开）：两把锁**跟随**到新单，不再拒拆 ────────────────────────
    // 旧口径拒拆锁定单，于是「财务锁完价、客人 no-show」就彻底没路可走（no-show 按人拆单是
    // 唯一通道）。锁本身是「别再动这单的钱」的意思，拆单不改单价、只按每人份额搬钱 ——
    // 真正的风险不是拆，而是**拆完新单没锁**：新单 create 此前根本不写这两组字段，
    // 等于静默解锁，谁都能去新单上改结算价/撤认款。现口径：新单继承两把锁与
    // LockedAt/LockedBy（见执行段建新单），两侧同锁，谁也别想借拆单绕开复核。
    if (order.settlementLocked || order.paymentsLocked) {
      warnings.push(
        '本单已锁定（结算价 / 收款复核）：拆出的新单会**继承同样的锁**，' +
          '如需改动两侧金额请先各自解锁。',
      );
    }

    // ── 闸 6（已放开）：开票位随人搬家，不再拦已开票的单 ──────────────────────
    // 旧口径把三个开票位当成「发票金额与订单金额挂钩」而拒拆。但六态开票（去程/回程/系统）
    // 是**给航司出票 / 系统出票的进度标记，不是发票**（口径见 ticketing-cap.ts 顶部注释与
    // 财务岗操作手册的开票一节）：它记的是「这一段票开没开」，不承载金额。
    // 现口径：拆单时把三个位原样复制给新单、源单保持不变 —— 拆出去的人本来就已出票，
    // 新单当然也是已出票态。班次开票额度按「被标记订单的乘客数」算，拆前 n 人一份、
    // 拆后 (n−k) + k 仍是 n 人，额度不增不减（执行段有守恒断言兜底，见步骤 11）。

    // ── 闸 7：佣金分档 ──────────────────────────────────────────────────────
    // no-show / 按人改期发生时，佣金**必然还是 ACCRUED**（代理飞完 7 天后才申请结算），
    // 一律拒拆等于把这两条售后路全堵死。故按状态分档：
    //   · ACCRUED 且未挂结算单 → 随拆按份额劈成两条（rate / chainDepth 原样，Σ amount 恒等，
    //     执行段落 CRITICAL 审计 SPLIT_ORDER_COMMISSION）；
    //   · SETTLEMENT_REQUESTED / SETTLED（或已挂 settlementId）→ 钱已经进了结算单，
    //     拆开两侧就与结算单对不上 —— 保留拒绝，请财务先处理。
    const commissionRows = await db.commissionRecord.findMany({
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
      select: { id: true, amount: true, status: true, settlementId: true },
    });
    const commissionCny = round2(
      commissionRows.reduce((sum, r) => sum + Number(r.amount), 0),
    );
    const commissionSettling = commissionRows.filter(
      (r) => r.status !== CommissionStatus.ACCRUED || r.settlementId != null,
    );
    // 负数 REVERSED 补偿行（退款/部分冲销产生、尚未并入结算单）同样挂在本单上：
    // 结算引擎按 settlementId=null 扫它们去追回多付的佣金。整块留在源单，
    // 拆出去那部分的追回就永远算在源单头上 —— 与两侧份额对不上，故按同一比例一并劈。
    const reversalRows = await db.commissionRecord.findMany({
      where: {
        orderId: order.id,
        status: CommissionStatus.REVERSED,
        settlementId: null,
        amount: { lt: 0 },
      },
      select: { id: true, amount: true },
    });
    const commissionReversalCny = round2(
      reversalRows.reduce((sum, r) => sum + Number(r.amount), 0),
    );
    let commissionMode: 'NONE' | 'SPLIT' | 'BLOCKED' = 'NONE';
    if (commissionSettling.length > 0) {
      commissionMode = 'BLOCKED';
      blockers.push('本单佣金已进结算流程，请财务先处理后再拆。');
    } else if (commissionRows.length > 0 || reversalRows.length > 0) {
      commissionMode = 'SPLIT';
      if (commissionRows.length > 0) {
        warnings.push(
          `本单已计提佣金 ¥${commissionCny}（尚未进结算）：拆单会把它按两侧份额劈成两条，合计不变。`,
        );
      }
      if (reversalRows.length > 0) {
        warnings.push(
          `本单有待追回的佣金冲销 ¥${commissionReversalCny}（尚未进结算）：拆单会按两侧份额劈开，合计不变。`,
        );
      }
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

    // 可摊售后费（= adjustmentCny − 换人费/换人差价等 excludeFromPerPax 条目）：
    // 闸 9 的提示语与下方的份额/分摊计算共用这一个数，两处分别算会漂。
    const spreadableAdjCny = spreadableAdjustmentCny(order);

    // ── 闸 9（已放开）：售后费用按份额随拆分摊 ────────────────────────────────
    // 旧口径拒拆带售后费的单（「整单口径，拆开就分不清谁欠的」）。改期费本就是按人产生的钱，
    // 均摊到每人份额里再随人搬走，比把整笔留在源单更诚实：
    //   两侧 Σ adjustmentCny 恒等（执行段有断言），应收也恒等 —— 见执行段的份额收敛。
    // 例外：换人费 / 换人差价（excludeFromPerPax）挂在**已经不在这张单上**的被换人头上，
    // 不进任何在册乘客的份额，也就不随拆 —— 整条留在源单（换人是在源单上发生的）。
    if (order.adjustmentCny !== 0) {
      const excludedCny = round2(order.adjustmentCny - spreadableAdjCny);
      warnings.push(
        excludedCny !== 0
          ? `本单有售后费用 ¥${order.adjustmentCny}，其中 ¥${excludedCny} 是换人费/换人差价` +
              `（记在被换下去的人头上）不随拆、整条留在本单；其余 ¥${spreadableAdjCny} 按两侧份额分摊，合计不变。`
          : `本单有售后费用 ¥${order.adjustmentCny}（改期费等）：拆单会按两侧份额分摊，合计不变。`,
      );
    }

    // ── 闸 10：套餐行数量 & 改档申请 ─────────────────────────────────────────
    // 套餐单已支持拆单（见 split-move-strategies 的 moveBundle）。仍要拦两种情况：
    //   · 多条套餐行 —— 「拆哪一张、人数快照按谁重建」无从判定（与 resolveChangeableBundleRow
    //     的多套餐行口径一字不差，不猜）；
    //   · 有待确认的改档申请 —— 申请里冻的是「拆之前这张单」的人数与档次，拆完再确认执行，
    //     差额会按已经不存在的人数算。
    const bundleRows = order.items.filter((it) => it.kind === OrderItemKind.BUNDLE);
    if (bundleRows.length > 1) {
      blockers.push('本单含多条套餐行，暂不支持拆单，请联系技术处理。');
    }
    // 改档申请闸**不按有没有套餐行分档**：申请是挂在订单上的（BundleChangeRequest.orderId），
    // 套餐行可能在提交申请之后被改掉/拆走，「没套餐行 = 不可能有待确认申请」并不成立。
    // 一律查一次，代价是一条 count。
    const pendingBundleChange = await db.bundleChangeRequest.count({
      where: { orderId: order.id, status: BundleChangeRequestStatus.PENDING },
    });
    if (pendingBundleChange > 0) {
      blockers.push('本单有待确认的套餐改档申请，请先确认或驳回该申请再拆单。');
    }
    // 议价申请（SettlementRequest）同理：申请里冻的是「拆之前这张单」的应收，
    // 拆完再确认执行，差额会按已经不存在的应收算 —— 先处理完再拆。
    const pendingSettlementRequest = await db.settlementRequest.count({
      where: { orderId: order.id, status: SettlementRequestStatus.PENDING },
    });
    if (pendingSettlementRequest > 0) {
      blockers.push('本单有待处理的议价申请，请先处理后再拆。');
    }
    // 改单申请（OrderChangeRequest）同理：申请里冻的是「拆之前这张单」的那一行
    //（itemId / 航段 / 房型 / 升舱补差按当时人数算），拆完那一行可能已经搬到新单上、
    // 或者人数已经变了，再确认执行就是按已经不存在的行改单 —— 先处理完再拆。
    //
    // ⚠ kind=SPLIT 的申请**排除在外**，两个理由：
    //   1. 这条闸拦的是「冻了某一行」的申请，而拆单申请冻的是乘客名单，没有 itemId；
    //      名单还成不成立由拆单自己判（「所选乘客不属于本订单，请刷新后重试」），
    //      不需要这条闸代劳。
    //   2. 更要紧的是：运营从队列里确认一条拆单申请时，那条申请自己还挂在 PENDING ——
    //      不排除就等于「拆单申请永远拆不动」，它每次都把自己算成阻拦自己的那一条。
    //      一单一类只能有一条待处理（部分唯一索引兜底），所以这里最多只漏掉自己这一条。
    const pendingOrderChangeRequest = await db.orderChangeRequest.count({
      where: {
        orderId: order.id,
        status: OrderChangeRequestStatus.PENDING,
        kind: { not: OrderChangeKind.SPLIT },
      },
    });
    if (pendingOrderChangeRequest > 0) {
      blockers.push('本单有待处理的改单申请，请先确认执行或驳回后再拆单。');
    }

    // ── 闸 10c：用过代理预存余额抵扣的单不许拆（口径同改归属的资金纠缠阻断）───────
    // 预存抵扣的真源是 PrepaymentTransaction(OFFSET) 流水，它**按 orderId 挂在源单上**
    //（Order.prepaymentOffset 那一列没有任何生产代码写入，恒为 0，指望不上）。
    // 拆单只搬 paidAmount，流水一条都搬不走 —— 新单退款时按 orderId 查不到任何 OFFSET，
    // 会把「本来是从余额里扣的钱」当成真现金全额退出去，等于凭空多退一笔。
    // 最小安全动作：先由财务把这笔抵扣结清/冲回，再拆。
    const splitBalanceOffset = await db.prepaymentTransaction.findFirst({
      where: { orderId: order.id, type: PrepaymentTxType.OFFSET },
      select: { id: true },
    });
    if (splitBalanceOffset != null) {
      blockers.push(
        '该单有预存余额抵扣记录，拆分后新单退款会按现金全额退出，请先由财务结清或冲回后再拆。',
      );
    }

    // ── 闸 11（已放开）：升舱行随拆按人劈开 ──────────────────────────────────
    // 旧口径拒拆含升舱的单。但升舱镜像账（metadata.businessUpgradeCount）本来就是逐行落库、
    // 逐行对称释放的，拆的时候把它按人劈到两侧即可 —— 执行段有「逐班次 Σ min(升舱位, 座位数)
    // 拆前后相等」的守恒断言兜底。未显式给 upgradeSplit 时按占座人头自动派生
    //（升舱行清单在下面算完两侧人数后一并产出，供预检回显）。

    // ── 闸 11b：回程座位当前处于「已释放」态 ─────────────────────────────────────
    // 释放快照（returnReleased.releasedSeats）记的是「这一行在**这张单上**放了几座」，
    // 而它是不可继承的（见 NON_INHERITABLE_ITEM_METADATA_KEYS）：拆完之后
    //   · 新单：回程行没有释放快照，「恢复回程」按钮无从下手，那几座回不来；
    //   · 源单：快照还记着按拆前人数放掉的座数，恢复时会照旧数占回来 —— 人已经少了一批，
    //     占回的座数却没变，座位账凭空多出一截。
    // 两边人数与释放快照必然对不上，且没有任何路径会自己纠正。先恢复、或确认这段就此作废再拆。
    if (order.items.some((it) => isReturnCurrentlyReleased(it))) {
      blockers.push(
        '本单回程座位当前处于「已释放」态，拆单会让释放快照与两侧人数对不上；' +
          '请先「恢复回程」或确认作废后再拆。',
      );
    }

    // ── 闸 12（已放开）：已出票单同样可拆，票务状态随人搬家 ────────────────────
    // 旧口径拒拆已出票单、让运营「走改签流程」，可**已出票的多人单恰恰是最需要单独改期的**：
    // 三人一单已出票，只给一位客人改航班，除了拆单没有别的路（一单一行程是全站硬约束）。
    // 航司标准做法 Divide PNR 本来就是对已出票 PNR 做的：票跟着人走，拆完再对那个人改签重出票。
    // 现口径同此 ——
    //   · 乘客整行物理搬到新单，pnr / eticketNumber 原样跟着走（步骤 5 只改 orderId）；
    //   · 开票位复制给新单（闸 6 注释）；FLIGHT_TICKETING 履约任务镜像源单状态（步骤 9）；
    //   · 之后对新单改期会走 rescheduleOrderItem 的「换班次即作废原票」（清新单乘客票号 +
    //     翻回新单被改航段的开票位），源单留守乘客的票与开票位一概不受影响。
    // 只作为**非阻断提示**回给运营，让人知道拆完之后票务台要重开票。
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
    if (
      confirmedTicketing > 0 ||
      ticketedPax ||
      order.outboundInvoiced ||
      order.returnInvoiced ||
      order.systemInvoiced
    ) {
      warnings.push(
        '本单已出票：拆出的乘客票务状态（PNR/票号、开票位、出票任务）随人转到新单；' +
          '之后对新单改期会作废该乘客的票，需票务台重开。',
      );
    }

    // ── 非阻断提示：源单去程已标 no-show ──────────────────────────────────────
    // no-show / 释放 / 恢复的快照是「这一行在源单上发生过什么」，跨单继承会把幂等 token 与
    // 放座明细一起带走（见 NON_INHERITABLE_ITEM_METADATA_KEYS），所以执行段一律剔除。
    // 于是新单在系统里是「没标过 no-show」的干净单 —— 这件事得先告诉运营，别以为标记会跟着人走。
    const sourceNoShow = order.items.some(
      (it) =>
        it.kind === OrderItemKind.FLIGHT &&
        readJsonObject(readJsonObject(it.metadata).noShow).at != null,
    );
    if (sourceNoShow) {
      warnings.push(
        '源单去程已标 no-show，拆出的新单不会自动带标记：如果拆出去的这几位客人也没登机，' +
          '请到新单上再标一次 no-show。',
      );
    }

    // ── 闸 13（已放开）：已结清单同样可拆 ────────────────────────────────────
    // v1 一律拒绝「已收 ≥ 应收」的单，于是三人单付清后想单独给一个人改期就彻底没路可走
    //（拆单是按人改期的唯一通道）。复核搬款口径后放开：
    //   · movedPaid = max(0, min(movedShare, 已收 − 已完成退款))：已结清单必然
    //     movedPaid == movedShare（份额 ≤ 应收 ≤ 已收），
    //     → 新单 paid == total（结清）、源单 paid−movedShare == total−movedShare（仍结清）；
    //   · 两条守恒断言（total / paidAmount 拆前后合计相等）与座位数量断言恒成立；
    //   · 既不产生负应收，也不制造多收：多付单（已收 > 应收）只搬份额，多出来的钱留在源单原处。
    // 真正会对不上的是「已结清 + 代理单 → 佣金早已计提」，那由闸 7（已计提佣金）独立拦着，
    // 与本闸无关，放开本闸不会放过它。开票（闸 6）、退款（闸 8）、售后费（闸 9）同理各拦各的。
    const preTotalCny = round2(Number(order.total));
    const prePaidCny = round2(Number(order.paidAmount));

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

    // ── 闸 15：同房组闸（一个房间不能一半在这单一半在那单）────────────────────
    // 手工拆单**保留**这道闸：运营自己在分房里把人分开，比系统替他猜怎么劈更靠谱。
    // no-show / 按人改期编排（autoSplitRoomGroups=true）则自动把混合房组按人劈成两个半组
    //（同酒店同房型同日期，房控把两个半间配回一间，房量不变）—— 那两条路径上运营
    // 根本没有「先去改分房」的机会，闸在那里只会变成死路。
    const roomGroups = readRoomGroups(order.roomAssignment);
    let roomGroupConflict = false;
    for (const group of roomGroups) {
      const groupPax = group.passengerIds;
      if (groupPax.length === 0) continue;
      const movedInGroup = groupPax.filter((id) => movedIdSet.has(id));
      if (movedInGroup.length > 0 && movedInGroup.length < groupPax.length) {
        roomGroupConflict = true;
        const label = group.label ?? '未命名房组';
        if (!autoSplitRoomGroups) {
          blockers.push(
            `房组「${label}」同时包含拆出与留下的乘客，请先在分房里把他们分到不同房组再拆单。`,
          );
          continue;
        }
        // 脏数据闸：0.5 间的房组里住着 2 位以上客人 —— 劈半后必有一侧落到 0 间却还住着人，
        // 房控从此少算一间。这是分房表本身填错了，系统不替它猜。
        const rawFraction = group.raw.roomFraction == null ? 1 : Number(group.raw.roomFraction);
        const groupHalves = Number.isFinite(rawFraction) ? Math.round(rawFraction * 2) : 2;
        if (groupHalves < 2 && groupPax.length >= 2) {
          blockers.push(
            `房组「${label}」记着 ${rawFraction} 间却住了 ${groupPax.length} 位客人（分房表数据有误）：` +
              '拆开后会有一侧住着人却占 0 间房。请先在分房里把这一组的间数改对，或拆成两个房组，再拆单。',
          );
        }
      }
    }

    // ── 闸 16：住宿行计费房数必须落在 0.5 网格上 ─────────────────────────────
    // 历史脏数据（如 roomsBilled=1.3）拆开后两侧都不是 0.5 的整数倍，房控与分房表从此对不上，
    // 且守恒断言用「半间」整数比会把小数尾巴静默抹掉。宁可先修数据再拆。
    for (const it of order.items) {
      if (it.roomsBilled == null) continue;
      const rooms = Number(it.roomsBilled);
      if (!Number.isFinite(rooms) || Math.abs(rooms * 2 - Math.round(rooms * 2)) > 1e-9) {
        blockers.push(
          `住宿行「${it.description}」的计费房数（${rooms}）不是 0.5 的整数倍，无法按半间拆分。` +
            '请先在分房/换酒店里把这一行的间数改成 0.5 的整数倍再拆单。',
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
      // 可摊售后费：换人费/换人差价（excludeFromPerPax）记在被换下去的人头上，不进任何在册乘客
      // 的份额 —— 拆单是「按每人份额搬钱」，把不属于任何人的钱摊进去会让两侧都拿到不该拿的数。
      // 这类钱整条留在源单（换人是在源单上发生的），见下方 movedAdjustmentCny。
      adjustmentCny: spreadableAdjCny,
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

    // ── 两侧人数解析（套餐行人数快照重建 / 房数派生的唯一权威口径）──
    const movedPassengers = order.passengers.filter((p) => movedIdSet.has(p.id));
    const keptPassengers = order.passengers.filter((p) => !movedIdSet.has(p.id));
    const movedOccupancy = occupancyOfPassengers(movedPassengers);
    const keptOccupancy = occupancyOfPassengers(keptPassengers);
    const occupancy = {
      movedOccupancy,
      keptOccupancy,
      movedSingleCount: movedPassengers.filter((p) => p.singleRoom).length,
      keptSingleCount: keptPassengers.filter((p) => p.singleRoom).length,
      movedSelfVisaCount: movedPassengers.filter((p) => p.visaExempt).length,
      keptSelfVisaCount: keptPassengers.filter((p) => p.visaExempt).length,
    };
    // 只拆出儿童/婴儿：套餐钱按**占座**比劈（婴儿不占座 → 一分钱不随拆走），
    // 拆出来的新单会是一张「有人没钱」的单。这不是错，但运营得知道自己在做什么。
    if (movedPassengers.length > 0 && movedOccupancy.adultCount === 0) {
      warnings.push(
        movedOccupancy.seatPax === 0
          ? '本次只拆出婴儿（不占座）：套餐款按占座人头分摊，新单应收为 0，成本按人头比例随拆。请确认这是你要的结果。'
          : '本次拆出的乘客里没有成人：套餐款按占座人头分摊，新单金额可能与直觉不同，请复核。',
      );
    }

    // ── 售后费按份额分摊 → 新单 total（应收 = total + adjustment，两者都不能重复计）──
    const payableCny = shareResult.payableCny;
    // 份额比夹到 [0,1]：按人调价可以把某几位的份额压成负数或超过整单应收
    //（净额是运营手填的），比值一旦越界，售后费/佣金按它分摊就会劈出「一侧为负、
    // 另一侧超过原值」的账。夹住比值，两侧「kept = 原 − moved」的 Σ 恒等仍然成立。
    const shareRatio = Math.min(
      1,
      Math.max(
        0,
        payableCny !== 0
          ? movedShareCny / payableCny
          : allPaxIds.length > 0
            ? movedIdSet.size / allPaxIds.length
            : 0,
      ),
    );
    // adjustmentCny 是**整数元**列（Order.adjustmentCny Int）：按份额取整分摊，
    // 留守侧取「原值 − 拆出侧」，两侧仍是整数且 Σ 恒等。
    //
    // 只摊**可摊**的那部分（spreadableAdjustmentCny）：换人费与换人差价挂在一个已经不在这张单上
    // 的人头上，excludeFromPerPax 已经把它们踢出了每人份额；分摊时若还按整数 adjustmentCny 劈，
    // 就会把这笔「谁都不属于」的钱按份额比塞进新单，新单凭空多一笔应收、源单少一笔 ——
    // 而被换下去的那个人是在**源单**上被换的，这笔钱本来就该整条留在源单。
    // 留守侧仍取「原值 − 拆出侧」，两侧 Σ adjustmentCny 恒等（执行段有断言）不受影响。
    const movedAdjustmentCny = Math.round(spreadableAdjCny * shareRatio);
    const targetTotalCny = round2(movedShareCny - movedAdjustmentCny);

    // ── 闸 17：按人调价把份额算成负数 / 超出整单应收 → 拒拆 ─────────────────────
    // computePerPaxShares 只保证 Σ 份额 == 应收，单个人的份额是运营手填的调价净额直接
    // 加出来的，可以为负、也可以大过整单应收。拿这种份额去搬钱，拆出来就是
    //「新单 1250、源单 −250」这种账 —— 守恒断言只看两侧之和，一分不差地放行。
    // 这里不静默夹逼：夹了 Σ 就不守恒，等于系统背着运营改了钱。宁可拒拆，
    // 让运营先把那一行调价改对。预检与执行段跑的是同一份闸（fail-closed）。
    const SHARE_EPS = 0.005;
    const negativeShareLabels = order.passengers
      .filter((p) => (shareByPax.get(p.id) ?? 0) < -SHARE_EPS)
      .map((p) => `${paxNameById.get(p.id) ?? p.id} ¥${round2(shareByPax.get(p.id) ?? 0)}`);
    if (negativeShareLabels.length > 0) {
      blockers.push(
        `按乘客调价后有人的份额为负（${negativeShareLabels.join('、')}）：` +
          '拆单只搬钱不改钱，负份额会把一侧订单金额拆成负数。请先调整该乘客的调价行再拆单。',
      );
    }
    // 两种触发原因分两句：运营看到的第一件事应该是「哪儿不对」，而不是一串数字里自己找。
    // ① 拆出份额本身就超过整单应收；② 拆完两侧里有一侧算出来是负数。
    const keptShareCny = round2(payableCny - movedShareCny);
    if (movedShareCny > payableCny + SHARE_EPS) {
      blockers.push(
        `按乘客调价后拆出份额超出整单应收（拆出 ¥${movedShareCny}，整单应收 ¥${payableCny}）：` +
          '拆单只搬钱不改钱，搬不出比整单还多的钱。请先调整相关乘客的调价行再拆单。',
      );
    }
    // targetTotalCny = 份额 − 分摊的售后费，是新单**基础总额**，不是应收（应收还要再加回
    // 新单自己的 adjustmentCny）。叫错名字会让运营拿它去对尾款，怎么对都对不上。
    if (keptShareCny < -SHARE_EPS || targetTotalCny < -SHARE_EPS) {
      blockers.push(
        `按乘客调价后拆完有一侧基础金额为负（新单基础总额 ¥${targetTotalCny} / 留守 ¥${keptShareCny}）：` +
          '负金额订单没有业务含义。请先调整相关乘客的调价行再拆单。',
      );
    }

    // ── 预存抵扣（Order.prepaymentOffset）随拆按份额搬 ────────────────────────
    // 这一列进「清账/尾款/已收净额」的每一条公式（应付 = total + adjustmentCny − paidAmount
    // − prepaymentOffset）。整块留在源单：源单 total 变小、抵扣没变 → 看起来多付；
    // 新单一分抵扣都没有 → 看起来欠款。两张单的尾款加起来不等于拆前那笔钱。
    // 现口径：按同一个份额比劈，留守侧取「原值 − 拆出侧」，Σ 恒等（执行段有断言）。
    // 注：这一列**没有生产代码写入**（恒为 0，见 orders.service 的预存抵扣注释），
    // 只有历史遗留数据才非零；老的 PrepaymentTransaction(OFFSET) 流水仍按单指向源单，
    // 故非零时执行段补一条 CRITICAL 审计留痕，供财务对账。
    const prePrepaymentOffsetCny = round2(Number(order.prepaymentOffset));
    const movedPrepaymentOffsetCny =
      prePrepaymentOffsetCny === 0 ? 0 : round2(prePrepaymentOffsetCny * shareRatio);

    // ── 建议间数 / 建议升舱位（预检回显 + 编排路径的自动派生，同一套口径）──
    const suggestCtx = buildSplitSuggestionContext({
      movedIdSet,
      totalPax: allPaxIds.length,
      occupancy,
    });
    const stayRows = order.items.filter(
      (it) =>
        (it.kind === OrderItemKind.HOTEL || it.kind === OrderItemKind.BUNDLE) &&
        (it.roomsBilled != null || it.hotelRoomTypeId != null),
    );

    return {
      blockers,
      warnings,
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
      payableCny,
      movedAdjustmentCny,
      targetTotalCny,
      prePrepaymentOffsetCny,
      movedPrepaymentOffsetCny,
      /** 本单挂着预存余额抵扣流水吗（闸 10c 已据此拒拆；执行段留作防御性审计条件）。 */
      hasPrepaymentOffsetTxn: splitBalanceOffset != null,
      hotelItems: stayRows.map((it) => {
        const rooms = it.roomsBilled != null ? Number(it.roomsBilled) : null;
        const isBundleStay = it.kind === OrderItemKind.BUNDLE;
        return {
          itemId: it.id,
          // 套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上 —— 前缀点明，别让运营以为选错了行。
          description: isBundleStay ? `套餐住宿 · ${it.description}` : it.description,
          roomsBilled: rooms,
          suggestedRoomsToMove:
            rooms != null && rooms > 0 ? deriveRoomsToMove(rooms, suggestCtx) : null,
          isBundleStay,
        };
      }),
      upgradeItems: collectSplitUpgradeItems(order.items, suggestCtx),
      commission: {
        mode: commissionMode,
        amountCny: commissionCny,
        reversalCny: commissionReversalCny,
      },
      roomGroupConflict,
      movedIdSet,
      occupancy,
    };
  }

  /**
   * 拆单预检（只读）：POST /orders/:id/split-preview。
   * 跑全部准入闸 + 份额计算，一次性返回全部不满足的闸（blockers），供运营在弹窗里逐条看。
   */
  async previewOrderSplit(
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
    if (!actorCan(actor, 'orders.split')) {
      throw new ForbiddenError('仅运营/管理员可拆单');
    }
    const order = await loadOrderForSplit(prisma, orderId);
    if (!order) throw new NotFoundError('订单不存在');
    const assessment = await this.assessOrderSplit(prisma, order, body.passengerIds, {
      autoSplitRoomGroups: body.autoSplitRoomGroups,
    });
    return {
      eligible: assessment.blockers.length === 0,
      blockers: assessment.blockers,
      warnings: assessment.warnings,
      shares: assessment.shares,
      movedShareCny: assessment.movedShareCny,
      movedPaidCny: assessment.movedPaidCny,
      movedAdjustmentCny: assessment.movedAdjustmentCny,
      hotelItems: assessment.hotelItems,
      upgradeItems: assessment.upgradeItems,
      commission: assessment.commission,
      roomGroupConflict: assessment.roomGroupConflict,
    };
  }

  /**
   * 执行拆单：POST /orders/:id/split。
   *
   * 事务内流程：锁源单（FOR UPDATE）→ 幂等回放检查 → 重跑准入闸 → 建新单（不定价不扣座）
   * → 按行搬/拆（FLIGHT/VISA/TRANSFER 按人数、HOTEL 按显式 roomSplit、按人调整行跟人走）
   * → 物理移乘客（PNR/票号随行）→ 两侧各一条 SPLIT 平账行 → 搬已收款（承接 Payment）
   * → 履约任务/出票任务镜像/回程列同步
   * → 守恒断言（total / paidAmount / 逐班次舱位 Σquantity / 各开票维度的乘客数）
   * → OrderSplitRecord 落库。
   * 幂等：同 (sourceOrderId, requestToken) 重试只回放既有结果，绝不二次拆。
   */
  async splitOrder(
    orderId: string,
    input: SplitOrderInput,
    actor: { userId: string; role: UserRole },
  ): Promise<SplitOrderResult> {
    if (!actorCan(actor, 'orders.split')) {
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
          // 新单**落库的 total**（= 份额 − 随拆分摊的售后费），与 sourceTotal 同口径。
          // 从前这里写的是份额 movedShareCny：有售后费的单两者不等，
          // 一条审计里两侧却按两种口径记，财务照着对账永远差一个售后费。
          targetTotal: outcome.targetTotalCny,
          // 份额单独留一个字段（只增不删，读审计的前端 auditFormat 不受影响）。
          movedShareCny: outcome.result.movedShareCny,
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
        // 佣金被劈开过 → 单独一条 CRITICAL 审计：财务日后对账时，「这条佣金怎么变成两条的」
        // 得有一处说得清（rate / chainDepth 未变、Σ amount 未变，只是分配到了两张单）。
        if (outcome.commissionSplit.length > 0) {
          await writeAudit({
            actor: { userId: actor.userId, role: actor.role },
            action: 'SPLIT_ORDER_COMMISSION',
            targetType: AuditTargetType.ORDER,
            targetId: outcome.result.sourceOrderId,
            targetLabel: outcome.result.sourceOrderNumber,
            before: {
              records: outcome.commissionSplit.map((c) => ({
                commissionId: c.commissionId,
                agentId: c.agentId,
                amountCny: c.beforeAmountCny,
                rate: c.rate,
                chainDepth: c.chainDepth,
              })),
            },
            after: {
              targetOrderNumber: outcome.result.targetOrderNumber,
              records: outcome.commissionSplit,
            },
            severity: AuditSeverity.CRITICAL,
          });
        }
        // 预存抵扣被搬走过 → 单独一条 CRITICAL 审计：预存流水（PrepaymentTransaction）
        // 仍按单指向源单，订单侧的抵扣列却已分到两张单，财务对账时得有一处说得清。
        if (outcome.prepaymentOffsetSplit) {
          await writeAudit({
            actor: { userId: actor.userId, role: actor.role },
            action: 'SPLIT_ORDER_PREPAYMENT_OFFSET',
            targetType: AuditTargetType.ORDER,
            targetId: outcome.result.sourceOrderId,
            targetLabel: outcome.result.sourceOrderNumber,
            before: { prepaymentOffsetCny: outcome.prepaymentOffsetSplit.beforeCny },
            after: {
              targetOrderNumber: outcome.result.targetOrderNumber,
              sourcePrepaymentOffsetCny: outcome.prepaymentOffsetSplit.keptCny,
              targetPrepaymentOffsetCny: outcome.prepaymentOffsetSplit.movedCny,
              note: '预存抵扣按份额随拆搬移；预存流水仍按单挂在源单，请财务据本条对账',
            },
            severity: AuditSeverity.CRITICAL,
          });
        }
        // 订单级办结派生对齐（两侧各一次，事务外，与其它写送签进度的路径同一调用点约定）：
        // 名单一分为二后「非自备签乘客是否全部已送签」两侧各自重算——拆出去的两位已送签的人
        // 在新单上就该自动办结；源单若是派生办结写的已签证、剩下的人还没送出去则对称回退。
        // 幂等，重复调用零副作用。
        await syncOrderVisaCompletion(outcome.result.sourceOrderId, {
          userId: actor.userId,
          role: actor.role,
        });
        await syncOrderVisaCompletion(outcome.result.targetOrderId, {
          userId: actor.userId,
          role: actor.role,
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
    const autoSplitRoomGroups = input.autoSplitRoomGroups === true;
    const assessment = await this.assessOrderSplit(tx, order, input.passengerIds, {
      autoSplitRoomGroups,
    });
    if (assessment.blockers.length > 0) {
      throw new BadRequestError(`当前不能拆单：\n${assessment.blockers.join('\n')}`);
    }
    const movedIdSet = assessment.movedIdSet;
    const k = movedIdSet.size;
    const {
      movedShareCny,
      movedPaidCny,
      preTotalCny,
      prePaidCny,
      movedAdjustmentCny,
      targetTotalCny,
      prePrepaymentOffsetCny,
      movedPrepaymentOffsetCny,
    } = assessment;
    const keptPrepaymentOffsetCny = round2(prePrepaymentOffsetCny - movedPrepaymentOffsetCny);

    // ── 2. 显式指令校验（0.5 网格 / 整数由 schema 保证；这里校验行归属与上限）──
    // 2a. roomSplit：酒店行**与套餐住宿行**都收（套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上）。
    const roomSplitByItem = new Map<string, number>();
    for (const entry of input.roomSplit ?? []) {
      if (roomSplitByItem.has(entry.itemId)) {
        throw new BadRequestError('roomSplit 中同一住宿行出现多次，请合并为一条');
      }
      const item = order.items.find((it) => it.id === entry.itemId);
      if (!item || (item.kind !== OrderItemKind.HOTEL && item.kind !== OrderItemKind.BUNDLE)) {
        throw new BadRequestError('roomSplit 指向的订单行不存在或不是住宿行，请刷新后重试');
      }
      const srcRooms = item.roomsBilled != null ? Number(item.roomsBilled) : null;
      if (srcRooms == null || srcRooms <= 0) {
        throw new BadRequestError(
          `住宿行「${item.description}」未记录计费房数（roomsBilled），请先保存分房表再拆分`,
        );
      }
      // 套餐住宿行的上限比酒店行少半间：套餐行永远是「劈成两条」（两侧都还有人、
      // 都还挂着自己的套餐），把间数全搬走会留下一条住着人却占 0 间房的套餐行。
      // 独立酒店行没有这个约束 —— 它可以整行搬走（moveHotel 的 WHOLE 分支）。
      const capRooms = item.kind === OrderItemKind.BUNDLE ? round2(srcRooms - 0.5) : srcRooms;
      if (entry.roomsBilledToMove > capRooms) {
        throw new BadRequestError(
          item.kind === OrderItemKind.BUNDLE
            ? `套餐住宿行「${item.description}」随拆搬走的间数（${entry.roomsBilledToMove}）超过上限：` +
              `该行计费 ${srcRooms} 间且两侧都还有客人，最多搬走 ${capRooms} 间。`
            : `住宿行「${item.description}」随拆搬走的间数（${entry.roomsBilledToMove}）超过该行计费房数（${srcRooms}）`,
        );
      }
      // 显式 0 = 「这一行整块留在源单」，与「缺省（不给这一行）」语义不同：
      // 缺省才走自动派生（编排路径），显式 0 是运营/编排的明确指令，必须照办。
      roomSplitByItem.set(entry.itemId, roundHalfGrid(entry.roomsBilledToMove));
    }

    // 2b. upgradeSplit：**一行一腿**（entry.toMove 直接给这一行搬几个升舱位）。
    //     旧形状（outboundToMove / returnToMove 两个字段一起发）继续兼容：按该行实际归属的
    //     航段取对应字段。航段判定走 determineFlightLegItems（按班次出发时刻），不再数下标 ——
    //     拆过一次的单里行序会变，数下标会把去程认成回程。
    //     未给的行不是「不搬升舱」，而是「按占座人头自动派生」—— 编排路径（no-show / 按人改期）
    //     根本不知道该填几个，硬要显式只会把它们逼进死路。
    const upgradeSplitByItem = new Map<string, number>();
    const { flightRows, returnItemId } = resolveSplitFlightLegs(order.items);
    // 升舱校验与升舱汇总共用同一份上下文：两个 Map 是**引用**传进去的，
    // 下面循环里往 upgradeSplitByItem 塞的值，2c 汇总时照样读得到。
    const preUpgradeCtx = buildSplitContext({
      movedIdSet,
      totalPax: order.passengers.length,
      occupancy: assessment.occupancy,
      roomSplitByItem,
      upgradeSplitByItem,
      autoDeriveRooms: autoSplitRoomGroups,
      movedUpgradeOutbound: 0,
      movedUpgradeReturn: 0,
      keptUpgradeOutbound: 0,
      keptUpgradeReturn: 0,
      splitPairToken: input.requestToken,
    });
    for (const entry of input.upgradeSplit ?? []) {
      if (upgradeSplitByItem.has(entry.itemId)) {
        throw new BadRequestError('upgradeSplit 中同一机票行出现多次，请合并为一条');
      }
      const item = flightRows.find((it) => it.id === entry.itemId);
      if (!item) {
        throw new BadRequestError('upgradeSplit 指向的订单行不存在或不是机票行，请刷新后重试');
      }
      const view = toSplitItemView(item);
      const count = readUpgradeCount(view.metadata);
      const legacyToMove = item.id === returnItemId ? entry.returnToMove : entry.outboundToMove;
      const toMove = Math.trunc(Number(entry.toMove ?? legacyToMove ?? 0));
      if (!Number.isFinite(toMove) || toMove < 0 || toMove > count) {
        throw new BadRequestError(
          `机票行「${item.description}」随拆搬走的升舱位（${toMove}）超出该行升舱人数（${count}）`,
        );
      }
      // 机票行的 quantity 是**占座数**（婴儿不占座），故两侧座位数按占座人头算 ——
      // 与 moveFlightLike 落库时用的是同一个 movedUnitsFor，校验与落库不会各算各的。
      const moveQty = movedUnitsFor(view, preUpgradeCtx);
      const keepQty = view.quantity - moveQty;
      if (toMove > moveQty || count - toMove > keepQty) {
        throw new BadRequestError(
          `机票行「${item.description}」的升舱位拆分与两侧座位数对不上：` +
            `拆出 ${moveQty} 座最多带 ${moveQty} 个升舱位，留守 ${keepQty} 座最多留 ${keepQty} 个。`,
        );
      }
      upgradeSplitByItem.set(entry.itemId, toMove);
    }

    // 2c. 升舱两侧分程汇总（套餐行 addOns 重建要用）：先按各机票行算出搬几个，再按航段归并。
    let movedUpgradeOutbound = 0;
    let movedUpgradeReturn = 0;
    let keptUpgradeOutbound = 0;
    let keptUpgradeReturn = 0;
    flightRows.forEach((item) => {
      const view = toSplitItemView(item);
      const count = readUpgradeCount(view.metadata);
      if (count <= 0) return;
      // 终态残骸行（回程过期作废 / 取消航段）整块留源单（planItemMove 判 NONE），
      // 升舱位自然一个不搬 —— 这里必须与落库口径一致，否则汇总会算出源单不存在的账。
      if (isTerminalLegItem(view.metadata)) {
        keptUpgradeOutbound += item.id === returnItemId ? 0 : count;
        keptUpgradeReturn += item.id === returnItemId ? count : 0;
        return;
      }
      const moveQty = movedUnitsFor(view, preUpgradeCtx);
      const keepQty = view.quantity - moveQty;
      const moved = moveQty >= view.quantity ? count : resolveUpgradeToMove(view, preUpgradeCtx, moveQty, keepQty);
      // 无班次的行（no-show 释放后 flightScheduleId 置空）归去程：它本就是去程行的残骸。
      if (item.id !== returnItemId) {
        movedUpgradeOutbound += moved;
        keptUpgradeOutbound += count - moved;
      } else {
        movedUpgradeReturn += moved;
        keptUpgradeReturn += count - moved;
      }
    });
    const splitCtx = buildSplitContext({
      movedIdSet,
      totalPax: order.passengers.length,
      occupancy: assessment.occupancy,
      roomSplitByItem,
      upgradeSplitByItem,
      // 编排路径（no-show / 按人改期）不传 roomSplit，房数一律按人头自动派生；
      // 手工拆单不自动派生（酒店行没填间数就整块留源单，与 v1 行为一致）。
      autoDeriveRooms: autoSplitRoomGroups,
      movedUpgradeOutbound,
      movedUpgradeReturn,
      keptUpgradeOutbound,
      keptUpgradeReturn,
      // 住宿行被劈成两个半间时，两侧写同一个配对键 —— 房控据此把跨单的两个半间配回一间。
      splitPairToken: input.requestToken,
    });

    // ── 3. 建新单：抄转正建单的事务内建单法，但**不重新定价不扣座**（行是搬/拆来的）──
    const nowIso = new Date().toISOString();
    const target = await tx.order.create({
      data: {
        orderNumber: targetOrderNumber,
        // 下单时刻原样继承源单（与下面佣金记录同口径）：财务/毛利报表按 order.createdAt 圈期，
        // 用默认的「now」会把一张 8 月的单拆出一张 9 月的新单 —— 8 月少算一半、9 月凭空多一半。
        // 拆单是同一笔业务的一分为二，不是新成交。updatedAt 照旧落当刻。
        createdAt: order.createdAt,
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
        // 开票位随人搬家（闸 6 已放开）：拆出去的人与留守的人票态相同，新单复制源单三个位、
        // 源单原样不动。班次开票额度按「被标记订单的乘客数」算，拆前后合计恒等（步骤 11 有断言）。
        outboundInvoiced: order.outboundInvoiced,
        returnInvoiced: order.returnInvoiced,
        systemInvoiced: order.systemInvoiced,
        // 两把锁跟随（闸 4-5 已放开）：源单锁着，新单也锁着。不写这两组字段 = 静默解锁，
        // 谁都能借「先拆一刀」绕开财务的结算价锁与收款复核锁。
        settlementLocked: order.settlementLocked,
        settlementLockedAt: order.settlementLockedAt,
        settlementLockedBy: order.settlementLockedBy,
        paymentsLocked: order.paymentsLocked,
        paymentsLockedAt: order.paymentsLockedAt,
        paymentsLockedBy: order.paymentsLockedBy,
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

    // ── 4. 按行搬/拆（unitPrice 全冻结；口径全在 split-move-strategies，内核只管落库）──
    // 拆前逐班次舱位数量账 + 升舱位账 + 房数账 + 成本账（守恒断言基准）。
    const preFlightQty = sumFlightQuantities(
      order.items.map((it) => ({
        kind: it.kind,
        flightScheduleId: it.flightScheduleId,
        flightCabin: it.flightCabin,
        quantity: it.quantity,
      })),
    );
    const preUpgradeQty = sumFlightUpgradeCounts(order.items);
    const preRoomsHalf = sumRoomsBilledHalves(order.items);
    const preCostCents = sumTotalCostCents(order.items);
    const fullyMovedItemIds = new Set<string>();
    const splitItemIdMap = new Map<string, string>(); // 源行 id → 新单对应行 id（拆分行）
    // 逐行的搬移决策留档：步骤 11 的「有占座人就必须有航段行」断言直接读它，不再回查数据库。
    const movePlans: Array<{ item: SplitItemView; plan: SplitMove }> = [];
    for (const item of order.items) {
      const view = toSplitItemView(item);
      const plan = planItemMove(view, splitCtx);
      movePlans.push({ item: view, plan });
      if (plan.mode === 'NONE') {
        // 「不动」也可能带一个就地补丁（目前只有：源单 no-show 名单裁掉被拆走的人）。
        // 走**只出 metadata 的硬白名单**，不走通用的 splitPatchToPrisma —— 后者能写数量/
        // 金额/成本/房数，而「不动的行不许动财务字段」正是守恒断言成立的前提，
        // 这个前提得由内核自己保证，不能只靠生产者自觉（类型上的 Pick 拦不住多带字段的变量）。
        const noneData = plan.update ? splitNoneUpdateToPrisma(plan.update) : null;
        if (noneData) {
          await tx.orderItem.update({ where: { id: item.id }, data: noneData });
        }
        continue;
      }
      if (plan.mode === 'WHOLE') {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { orderId: target.id, ...splitPatchToPrisma(plan.update) },
        });
        fullyMovedItemIds.add(item.id);
        continue;
      }
      // SPLIT：源行就地改字段，新单建一条对应行（其余列原样复制，unitPrice 冻结）。
      await tx.orderItem.update({
        where: { id: item.id },
        data: splitPatchToPrisma(plan.keep),
      });
      const createdRow = await tx.orderItem.create({
        data: {
          orderId: target.id,
          kind: item.kind,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          amount: item.amount,
          unitCostCny: item.unitCostCny,
          totalCostCny: item.totalCostCny,
          flightScheduleId: item.flightScheduleId,
          flightCabin: item.flightCabin,
          transferId: item.transferId,
          visaId: item.visaId,
          visaIntendedDate: item.visaIntendedDate,
          // 套餐/酒店行的住宿盖章原样跟走：两张单同酒店同房型同日期，房控把两个半间配回一间。
          hotelRoomTypeId: item.hotelRoomTypeId,
          randomStarTier: item.randomStarTier,
          hotelCheckIn: item.hotelCheckIn,
          hotelCheckOut: item.hotelCheckOut,
          roomsBilled: item.roomsBilled,
          // 既有 bug 修复：新建行此前不复制 bundleId —— 拆出来的套餐/机票行与套餐产品脱钩，
          // 新单改档（resolveChangeableBundleRow 要求 bundleId 非空）与套餐口径的佣金分类全失灵。
          bundleId: item.bundleId,
          idempotencyKey: null,
          ...splitPatchToPrisma(plan.move),
        },
        select: { id: true },
      });
      splitItemIdMap.set(item.id, createdRow.id);
    }

    // ── 5. 物理移乘客（保 id，护照图/送签进度全跟走）──
    const movedPax = await tx.passenger.updateMany({
      where: { id: { in: [...movedIdSet] }, orderId },
      data: { orderId: target.id },
    });
    if (movedPax.count !== k) {
      throw new Error(`拆单守恒断言失败：应移 ${k} 位乘客，实际移动 ${movedPax.count} 位（已回滚）`);
    }

    // ── 6. 分房表：拆出乘客所在房组整组搬到新单 ────────────────────────────────
    // 混合房组（一半走一半留）：手工拆单已被闸 15 拒在门外；编排路径（autoSplitRoomGroups）
    // 在这里按人劈成两个半组 —— 同酒店、同房型、同日期，两组 roomFraction 之和恒等于原组，
    // 房控把两个半间配回一间，房量分毫不动。
    const rawRoomAssignment = order.roomAssignment;
    const roomGroups = readRoomGroups(rawRoomAssignment).flatMap((group) => {
      if (group.passengerIds.length === 0) return [group];
      const movedInGroup = group.passengerIds.filter((id) => movedIdSet.has(id));
      if (movedInGroup.length === 0 || movedInGroup.length === group.passengerIds.length) {
        return [group];
      }
      const halves = splitMixedRoomGroup(group, movedIdSet, input.requestToken);
      return [
        { ...group, raw: halves.kept, passengerIds: group.passengerIds.filter((id) => !movedIdSet.has(id)) },
        { ...group, raw: halves.moved, passengerIds: movedInGroup },
      ];
    });
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
    //   份额（movedShare）是**应收**口径 = total + adjustmentCny，故先把随拆分摊的售后费
    //   （movedAdjustment）从份额里摘出来，剩下的才是新单的 total —— 否则售后费会被算两遍
    //   （一遍在 total 里、一遍在 adjustmentCny 里），客人凭空多欠一笔。
    //   新单 total == movedShare − movedAdjustment；源单 total == 拆前 total − 新单 total。
    //   正 → FEE、负 → DISCOUNT（与 buildSettlementTotalItem 同口径）；差额为 0 不生成行。
    const targetAgg = await tx.orderItem.aggregate({
      where: { orderId: target.id },
      _sum: { amount: true },
    });
    const targetItemsSum = round2(Number(targetAgg._sum.amount ?? 0));
    await createSplitBalanceItem(tx, {
      orderId: target.id,
      diffCny: round2(targetTotalCny - targetItemsSum),
      itemsSumCny: targetItemsSum,
      shareCny: targetTotalCny,
      splitFrom: order.orderNumber,
      splitTo: target.orderNumber,
    });
    const sourceTotalAfterCny = round2(preTotalCny - targetTotalCny);
    const keptAdjustmentCny = order.adjustmentCny - movedAdjustmentCny;
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
        // 售后费按份额随拆分摊（闸 9 已放开）：两侧 Σ adjustmentCny 恒等，见步骤 11 断言。
        adjustmentCny: keptAdjustmentCny,
        // 预存抵扣同样按份额随拆搬（历史遗留列，现行系统恒为 0）：Σ 恒等，见步骤 11 断言。
        ...(prePrepaymentOffsetCny !== 0
          ? { prepaymentOffset: new Prisma.Decimal(keptPrepaymentOffsetCny) }
          : {}),
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
        subtotal: new Prisma.Decimal(targetTotalCny),
        total: new Prisma.Decimal(targetTotalCny),
        paidAmount: new Prisma.Decimal(movedPaidCny),
        adjustmentCny: movedAdjustmentCny,
        ...(prePrepaymentOffsetCny !== 0
          ? { prepaymentOffset: new Prisma.Decimal(movedPrepaymentOffsetCny) }
          : {}),
        adjustments: targetLog,
        ...(targetRoomAssignment !== undefined ? { roomAssignment: targetRoomAssignment } : {}),
      },
    });

    // 承接 Payment：movedPaid > 0 才建。核实状态继承来源——源单全部成功收款均已核实才算核实，
    // 钱没被财务对过流水，不因搬到新单就洗白（与占位单结转同哲学）。
    //
    // 成对落两条：新单一条**正额**承接行，源单一条**等额负额**对冲行。
    // 少了源单那条会造币：拆单只减 order.paidAmount，源单台账一行没动，于是源单下一次进 PAID
    // （_updateStatusWithinTx 的 `if (paymentsSum > currentPaid) paidAmount = paymentsSum`，
    // 本是给迟到的网关回调补记用的）就会把随拆转走的 movedPaid 重新灌回源单——同一笔钱在
    // 两张单上各算一次。对冲行的字段与口径与「多付处置」对冲行
    //（_recordOverpayDisposalPayment）逐字一致，不另起一套。
    if (movedPaidCny > 0) {
      const sourcePayments = await tx.payment.findMany({
        // 只看真实进账：对冲行金额为负、创建即视同已核实，算进来会把「财务还没对过流水」
        // 的账洗白（多次拆单时尤甚）。
        where: { orderId, status: PaymentStatus.SUCCEEDED, amount: { gt: 0 } },
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
      await tx.payment.create({
        data: {
          orderId,
          // 与配对的承接行同一支付方式，两条一眼看得出是一对（对冲行不是新钱进账，
          // 方式本身不承载业务含义）。
          method: PaymentMethod.BANK_CARD,
          amount: new Prisma.Decimal(-movedPaidCny),
          status: PaymentStatus.SUCCEEDED,
          transactionId: null,
          idempotencyKey: `split-out:${order.id}:${input.requestToken}`,
          // paidAt 留空 → 导出的「最近一笔成功收款」（按 paidAt 过滤排序）不会把对冲行误当收款。
          paidAt: null,
          // 内部记账（负额），不是新钱进账，创建即视同已核实，不进待核实队列。
          verifiedAt: new Date(),
          gatewayPayload: {
            source: 'split-transfer',
            targetOrderId: target.id,
            targetOrderNumber: target.orderNumber,
            requestToken: input.requestToken,
            amountCny: movedPaidCny,
            splitAt: nowIso,
            by: actor.userId,
            manual: false,
            // 收款区徽标：复用既有「已转出至 X」标注（serializePaymentRecord 已认这两个字段），
            // 不为拆单另造一个 label。
            transferredOut: true,
            transferredToOrderNumber: target.orderNumber,
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
    // 9b. 履约任务镜像（票务/签证/房/车的进度随人搬家，闸 12 已放开）：
    //   整行搬走的行连着它的任务一起过户（任务只挂 orderItemId），本来就带着原状态；
    //   被拆的行在新单上是**新建行**，createFulfillmentTasks 给它开的是 PENDING ——
    //   源单那段明明已确认出票 / 已送签 / 已订房，新单却一水儿「待处理」，各岗位会当成
    //   新活重办一遍。故把同类型任务的状态与业务字段从源行任务镜像过来（源单任务不动）。
    if (newTaskIds.length > 0 && splitItemIdMap.size > 0) {
      await mirrorTicketingTasksForSplit(tx, {
        newTaskIds,
        // 新单拆分行 → 源单对应行（splitItemIdMap 的反向索引）
        sourceItemIdByTargetItemId: new Map(
          [...splitItemIdMap.entries()].map(([sourceItemId, targetItemId]) => [
            targetItemId,
            sourceItemId,
          ]),
        ),
        splitNote: `由订单 ${order.orderNumber} 拆分创建`,
      });
    }
    await syncVisaTasksForOrder(tx, target.id, { userId: actor.userId, role: actor.role });
    // 9c. 签证任务承接：源单已办结（订单级已签证 + 乘客已送签）时新单复制的是「已签证」，
    //   建任务口径把它当客人自带签证而不建任务，9b 也就没得镜像 —— 拆出去的人从签证台消失。
    //   这里按「源单有活的签证任务 + 新单有非自备签乘客 + 新单还没有」补一条镜像任务。
    await carryVisaTaskForSplit(tx, {
      sourceOrderId: orderId,
      targetOrderId: target.id,
      targetOrderNumber: target.orderNumber,
      sourceOrderNumber: order.orderNumber,
      splitItemIdMap,
      splitNote: `由订单 ${order.orderNumber} 拆分创建`,
      actor: { userId: actor.userId, role: actor.role },
    });
    // 9d. 签证任务状态按**两侧各自的乘客**重派生（拆单审计 #5）：9b/9c 只把源任务的旧聚合状态
    //   原样镜像给新单，可任务级状态 = 该单非自备签乘客送签进度的最低档 —— 名单一分为二，
    //   两侧的最低档都可能变（两位已送签的人拆出去，新单该是「已送签」、源单剩下的人才是「待处理」）。
    //   送签进度随人搬家（乘客保 id 整行移动），这里只按各自名单把任务级状态派生回来；
    //   touch 用签证台同一口径（三档都可改写，CANCELLED/FAILED 永不复活）。
    //   一侧再没有要我方送签的人（全员自备签 / 全搬走）→ 不碰它的任务（无人可派生，留给任务有无同步）。
    for (const sideOrderId of [orderId, target.id]) {
      const ours = await tx.passenger.findMany({
        where: ourVisaPassengersWhere(sideOrderId),
        select: { visaSubmissionStatus: true },
      });
      if (ours.length === 0) continue;
      await rederiveVisaTaskStatus(tx, sideOrderId, {
        touch: DERIVABLE_TASK_STATUSES,
        statuses: ours.map((p) => p.visaSubmissionStatus),
      });
    }
    await syncOrderHasReturnLeg(tx, orderId);
    await syncOrderLegFlag(tx, orderId);
    await syncOrderHasReturnLeg(tx, target.id);
    await syncOrderLegFlag(tx, target.id);

    // ── 10. 新单操作费（与转正建单同口径：每单固定操作费）──
    await tx.orderCostItem.create({
      data: {
        orderId: target.id,
        category: 'OPERATION_FEE',
        amountCny: new Prisma.Decimal(OPERATION_FEE_CNY_PER_ORDER),
        note: '系统自动计提（每单固定操作费）',
      },
    });

    // ── 10b. 佣金劈分（闸 7 的 SPLIT 档：ACCRUED 且未挂结算单）─────────────────
    // 按两侧应收份额劈成两条：rate / chainDepth / productKind 原样（费率是与代理谈定的，
    // 不因拆单变），baseAmount 与 amount 同比例，留守侧取「原值 − 拆出侧」→ Σ 恒等。
    // 事务外补一条 CRITICAL 审计（SPLIT_ORDER_COMMISSION）：谁在什么时候把哪条佣金劈成了几条。
    const commissionSplit: SplitCommissionAudit[] = [];
    if (assessment.commission.mode === 'SPLIT') {
      const splittable = await tx.commissionRecord.findMany({
        where: {
          orderId,
          settlementId: null,
          OR: [
            { status: CommissionStatus.ACCRUED },
            // 负数 REVERSED 补偿行（退款/部分冲销的追回）也是「挂在这张单上、还没进结算单」
            // 的钱，同样按份额随拆走一半，否则拆出去那部分的追回永远算在源单头上。
            { status: CommissionStatus.REVERSED, amount: { lt: 0 } },
          ],
        },
        select: {
          id: true,
          agentId: true,
          productKind: true,
          baseAmount: true,
          rate: true,
          amount: true,
          chainDepth: true,
          status: true,
          createdAt: true,
        },
      });
      const commissionRatio =
        assessment.payableCny !== 0
          ? Math.min(1, Math.max(0, movedShareCny / assessment.payableCny))
          : order.passengers.length > 0
            ? k / order.passengers.length
            : 0;
      for (const rec of splittable) {
        const beforeAmount = round2(Number(rec.amount));
        const beforeBase = round2(Number(rec.baseAmount));
        const movedAmount = round2(beforeAmount * commissionRatio);
        const keptAmount = round2(beforeAmount - movedAmount);
        const movedBase = round2(beforeBase * commissionRatio);
        const keptBase = round2(beforeBase - movedBase);
        if (movedAmount === 0 && movedBase === 0) continue; // 劈出来是 0 → 不建空记录
        const created = await tx.commissionRecord.create({
          data: {
            agentId: rec.agentId,
            orderId: target.id,
            productKind: rec.productKind,
            baseAmount: new Prisma.Decimal(movedBase),
            rate: rec.rate,
            amount: new Prisma.Decimal(movedAmount),
            status: rec.status,
            chainDepth: rec.chainDepth,
            // 结算期次按 createdAt 划（settlements 的 generate 按 createdAt 圈本期 ACCRUED）：
            // 用默认的「now」会把一条 8 月计提的佣金劈出一条 9 月的记录，
            // 8 月那张结算单从此少了一半、9 月凭空多出一半。计提时刻原样继承。
            createdAt: rec.createdAt,
          },
          select: { id: true },
        });
        await tx.commissionRecord.update({
          where: { id: rec.id },
          data: {
            baseAmount: new Prisma.Decimal(keptBase),
            amount: new Prisma.Decimal(keptAmount),
          },
        });
        commissionSplit.push({
          commissionId: rec.id,
          agentId: rec.agentId,
          beforeAmountCny: beforeAmount,
          keptAmountCny: keptAmount,
          movedAmountCny: movedAmount,
          movedCommissionId: created.id,
          rate: Number(rec.rate),
          chainDepth: rec.chainDepth,
        });
      }
    }

    // ── 11. 守恒断言（不平整体回滚；宁可拆不成也不能拆出对不上的账）──
    const conservationSelect = {
      total: true,
      paidAmount: true,
      adjustmentCny: true,
      prepaymentOffset: true,
      outboundInvoiced: true,
      returnInvoiced: true,
      systemInvoiced: true,
      _count: { select: { passengers: true } },
    } as const;
    const [sourceAfter, targetAfter] = await Promise.all([
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: conservationSelect }),
      tx.order.findUniqueOrThrow({ where: { id: target.id }, select: conservationSelect }),
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
    // 出票人数守恒（开票位随人搬家的兜底，与座位守恒同哲学）：某个开票维度上
    // 「被标记订单的乘客数」拆前后合计必须相等 —— 班次开票上限正是按这个数算的
    //（ticketing-cap.ts 的 countIssuedPassengers = Σ 被标记订单的乘客数），
    // 拆单一旦把它放大，就等于凭空多发一份开票额度、可能超发座位。
    const INVOICE_FLAGS = ['outboundInvoiced', 'returnInvoiced', 'systemInvoiced'] as const;
    const prePaxCount = order.passengers.length;
    for (const flag of INVOICE_FLAGS) {
      const before = order[flag] ? prePaxCount : 0;
      const after =
        (sourceAfter[flag] ? sourceAfter._count.passengers : 0) +
        (targetAfter[flag] ? targetAfter._count.passengers : 0);
      if (before !== after) {
        throw new Error(
          `拆单守恒断言失败：开票维度 ${flag} 拆前 ${before} 人、拆后两单合计 ${after} 人（已回滚）`,
        );
      }
    }
    // 售后费守恒（闸 9 放开后新增）：两侧 Σ adjustmentCny 必须等于拆前，
    // 否则「应收 = total + adjustmentCny」在两张单上加起来就不是拆前那笔钱。
    const adjustmentAfter = sourceAfter.adjustmentCny + targetAfter.adjustmentCny;
    if (adjustmentAfter !== order.adjustmentCny) {
      throw new Error(
        `拆单守恒断言失败：拆前售后费 ¥${order.adjustmentCny}，拆后两单合计 ¥${adjustmentAfter}（已回滚）`,
      );
    }
    // 预存抵扣守恒：它进「应付 − 已付」的每一条公式，两侧 Σ 必须等于拆前，
    // 否则两张单的尾款加起来不再等于拆前那笔钱。
    const prepaymentOffsetAfter =
      Number(sourceAfter.prepaymentOffset) + Number(targetAfter.prepaymentOffset);
    if (Math.abs(prepaymentOffsetAfter - prePrepaymentOffsetCny) > EPS) {
      throw new Error(
        `拆单守恒断言失败：拆前预存抵扣 ¥${prePrepaymentOffsetCny}，` +
          `拆后两单合计 ¥${round2(prepaymentOffsetAfter)}（已回滚）`,
      );
    }
    const itemsAfter = await tx.orderItem.findMany({
      where: { orderId: { in: [orderId, target.id] } },
      select: {
        kind: true,
        flightScheduleId: true,
        flightCabin: true,
        quantity: true,
        metadata: true,
        roomsBilled: true,
        totalCostCny: true,
      },
    });
    // ── 「有占座人就必须有航段行」（fail-closed）─────────────────────────────────
    //
    // 座位守恒只保证两侧 Σ 相等，它拦不住「整行搬到一侧、另一侧一座不剩」：
    // 2 大 1 婴的单拆「一位大人 + 婴儿」时，旧口径拿人头数 2 与机票行 quantity 2（占座数）比，
    // 判成整行搬走 —— 源单剩着一位客人却连一条航段行都没有，Σ 照样相等，账却已经错了。
    //
    // 两个刻意的豁免：
    //   · 终态残骸行（作废 / 取消航段）不计入 —— 它本来就整块留源单（planItemMove 判 NONE）；
    //   · **拆前就不齐**的单不管（活航段座位数 < 全员占座人数）：那是历史脏数据，
    //     拆单既不是成因也修不了它，拿这条断言拦住只会把这批单永久锁死。
    const liveFlightSeats = (items: ReadonlyArray<SplitConservationRow>): number =>
      items.reduce(
        (sum, it) =>
          it.kind === OrderItemKind.FLIGHT && !isTerminalLegItem(readJsonObject(it.metadata))
            ? sum + (it.quantity ?? 0)
            : sum,
        0,
      );
    const preLiveFlightSeats = liveFlightSeats(order.items);
    if (preLiveFlightSeats >= splitCtx.totalSeatPax && splitCtx.totalSeatPax > 0) {
      // 两侧各自的活航段座位数直接由**本次的搬移决策**推出（movePlans 在步骤 4 逐行记下），
      // 不再回查数据库：决策就是落库依据，二者必然一致，多一次往返反而多一个漂移点。
      let keptSeats = 0;
      let movedSeats = 0;
      for (const { item, plan } of movePlans) {
        if (item.kind !== OrderItemKind.FLIGHT || isTerminalLegItem(item.metadata)) continue;
        if (plan.mode === 'NONE') keptSeats += item.quantity;
        else if (plan.mode === 'WHOLE') movedSeats += item.quantity;
        else {
          keptSeats += plan.keep.quantity ?? item.quantity;
          movedSeats += plan.move.quantity ?? 0;
        }
      }
      const sides = [
        { label: '留守', seatPax: splitCtx.keptOccupancy.seatPax, seats: keptSeats },
        { label: '拆出', seatPax: splitCtx.movedOccupancy.seatPax, seats: movedSeats },
      ];
      for (const side of sides) {
        if (side.seatPax > 0 && side.seats <= 0) {
          throw new Error(
            `拆单守恒断言失败：${side.label}侧还有 ${side.seatPax} 位占座客人，` +
              '却一条有效航段行都没有（已回滚）',
          );
        }
      }
    }
    const postFlightQty = sumFlightQuantities(itemsAfter);
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
    // 升舱位守恒（套餐单拆分新增）：升舱位对应真实商务舱库存，逐班次舱位 Σ 拆前后必须相等。
    const postUpgradeQty = sumFlightUpgradeCounts(itemsAfter);
    for (const key of new Set([...preUpgradeQty.keys(), ...postUpgradeQty.keys()])) {
      const before = preUpgradeQty.get(key) ?? 0;
      const after = postUpgradeQty.get(key) ?? 0;
      if (before !== after) {
        throw new Error(
          `拆单守恒断言失败：班次舱位 ${key} 升舱位拆前 ${before} 个、拆后 ${after} 个（已回滚）`,
        );
      }
    }
    // 房量守恒（套餐住宿行随拆按半间劈开后必查）：Σ roomsBilled 一分不能多、一分不能少，
    // 否则房控板会凭空多出/少掉房间。以「半间」整数比，避开 0.5 的浮点尾数。
    const postRoomsHalf = sumRoomsBilledHalves(itemsAfter);
    if (postRoomsHalf !== preRoomsHalf) {
      throw new Error(
        `拆单守恒断言失败：Σ 计费房数拆前 ${preRoomsHalf / 2} 间、拆后 ${postRoomsHalf / 2} 间（已回滚）`,
      );
    }
    // 成本守恒：拆单只搬成本不改成本，Σ totalCostCny 拆前后必须相等（毛利报表的底账）。
    const postCostCents = sumTotalCostCents(itemsAfter);
    if (postCostCents !== preCostCents) {
      throw new Error(
        `拆单守恒断言失败：Σ 成本拆前 ¥${preCostCents / 100}、拆后 ¥${postCostCents / 100}（已回滚）`,
      );
    }
    // 佣金守恒：劈分只改分配不改金额，两单 Σ amount 必须等于拆前。
    if (assessment.commission.mode === 'SPLIT') {
      const postCommission = await tx.commissionRecord.aggregate({
        where: {
          orderId: { in: [orderId, target.id] },
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
      const postCommissionCny = round2(Number(postCommission._sum.amount ?? 0));
      if (Math.abs(postCommissionCny - assessment.commission.amountCny) > EPS) {
        throw new Error(
          `拆单守恒断言失败：拆前佣金 ¥${assessment.commission.amountCny}、` +
            `拆后两单合计 ¥${postCommissionCny}（已回滚）`,
        );
      }
      // 待追回的负数补偿行同理：劈开只改分配不改金额，两单 Σ 必须等于拆前。
      const postReversal = await tx.commissionRecord.aggregate({
        where: {
          orderId: { in: [orderId, target.id] },
          status: CommissionStatus.REVERSED,
          settlementId: null,
          amount: { lt: 0 },
        },
        _sum: { amount: true },
      });
      const postReversalCny = round2(Number(postReversal._sum.amount ?? 0));
      if (Math.abs(postReversalCny - assessment.commission.reversalCny) > EPS) {
        throw new Error(
          `拆单守恒断言失败：拆前佣金冲销 ¥${assessment.commission.reversalCny}、` +
            `拆后两单合计 ¥${postReversalCny}（已回滚）`,
        );
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
          // 编排入参留档（只增字段）：按人改期的同 token 回放据此比对，见 reschedulePassengers。
          orchestration: input.orchestration ?? null,
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
      targetTotalCny,
      sourcePaidAfterCny,
      allShareRows: assessment.allShareRows,
      passengerSummary: order.passengers.map((p) => ({
        id: p.id,
        name: p.chineseName?.trim() || p.fullName,
        moved: movedIdSet.has(p.id),
      })),
      commissionSplit,
      // 审计条件看的是**预存流水**（PrepaymentTransaction(OFFSET)）而不是 Order.prepaymentOffset
      // 那一列 —— 那一列没有任何生产代码写入、恒为 0，照它判等于这条审计永远不会触发。
      // 闸 10c 已在准入段把有流水的单拒在门外，这里留作最后一道防御：万一有路径绕过闸，
      // 至少财务能从审计里看到「这单的预存抵扣被拆过」。
      prepaymentOffsetSplit:
        prePrepaymentOffsetCny !== 0 || assessment.hasPrepaymentOffsetTxn
          ? {
              beforeCny: prePrepaymentOffsetCny,
              keptCny: keptPrepaymentOffsetCny,
              movedCny: movedPrepaymentOffsetCny,
            }
          : null,
    };
  }
  reschedulePassengers(orderId: string, input: {
      passengerIds: string[];
      orderItemId: string;
      newScheduleId: string;
      newCabin?: CabinClass;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
      roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
      requestToken: string;
    }, actor: { userId: string; role: UserRole }): Promise<ReschedulePassengersResult> {
    return rescheduleSvc.reschedulePassengers(this, orderId, input, actor);
  }

  _auditReschedulePassengers(result: ReschedulePassengersResult, actor: { userId: string; role: UserRole }, movedPassengerIds: string[]): Promise<void> {
    return rescheduleSvc._auditReschedulePassengers(this, result, actor, movedPassengerIds);
  }

  // ════════════════════════════════════════════════════════════════════
  // 取消航段（partial cancellation）：POST /orders/:id/cancel-leg
  //
  // 运营诉求：往返单（含套餐单）的客人只飞其中一段 —— 要让「系统里只剩单程，另一段放回给
  // 系统继续销售」。两个方向都要：
  //   leg=RETURN   只飞去程、回程不要了 → 单去程单（老路径 /cancel-return-leg 同义）；
  //   leg=OUTBOUND 去程 noshow 没飞、只留回程 → 单回程单。
  // 按航司/包机行业标准的「取消航段」办：
  //   · 被取消那一段的座位当场放回库存（按下单时的升舱拆座镜像各退各舱），可立即重卖；
  //   · 订单变单程（hasReturnLeg 物化列同步为 false，该段票务任务终态化）；
  //   · 手续费按取消政策对**被取消那一行**报价（运营可手工覆盖，但必须写原因、记 CRITICAL 审计）；
  //   · 应收降下来即止 —— **本端点不打款**：降完 total 后的多收由既有「多付转预存款 /
  //     转挂账池 / 退款」流程处置，退多少钱不由这里决定。
  //
  // 部分乘客只飞一段 → 运营先用拆单把人拆出去、再对新单取消航段（本端点不做拆人）。
  //
  // 被取消的行「作废保留」而不物理删（行业惯例：已取消航段要留痕，原班次/原金额快照是事后
  // 对账与申诉的唯一依据）。实现口径：
  //   amount/unitPrice/成本归零 + flightScheduleId 置空 + metadata 落 returnLegCancelled 快照
  //   （键名沿用，快照里带 leg 说明取消的是哪一段；老数据无 leg 一律按 RETURN 读）。
  //   全站「有效航段」的判定统一是 **flightScheduleId 非空**（determineFlightLegItems、
  //   syncOrderHasReturnLeg、ticketing-cap、各导出、护照包、房控、履约筛选皆然），
  //   置空即退出座位/开票/回程列统计，与物理删等效而多了留痕。
  //
  // ⚠ 取消去程的一个非对称点：全站「去程/回程」是**位置判定**（有效航段按出发时刻排序，
  // 第 1 段=去程）。取消去程后只剩一段，那一段就地变成「去程」。开票六态是挂在
  // outboundInvoiced/returnInvoiced 两个位上的，所以取消去程时必须把开票位跟着搬家：
  // outboundInvoiced ← returnInvoiced、returnInvoiced ← false。不搬的话，那一段明明开过票，
  // 却因为改判成「去程」而去读空的 outboundInvoiced —— 出票上限会漏计（可能超发）、
  // 导出显示「完全未开」、还会掉进「去程未开」的票务待办里。见下方步骤 9。
  // ════════════════════════════════════════════════════════════════════

  /** 取消航段的准入评估（preview 与 execute 共用同一口径，杜绝预检放行、执行另算）。 */
  private async _assessCancelLeg(
    db: Prisma.TransactionClient,
    orderId: string,
    leg: FlightLegSide,
  ): Promise<{
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
    const order = await loadOrderForLegCancel(db, orderId);
    if (!order) throw new NotFoundError('订单不存在');

    const legZh = LEG_ZH[leg];
    const blockers: string[] = [];
    const warnings: string[] = [];
    const ackWarnings: string[] = [];

    // ── 闸 1-3：存活 / 占座中 / 资金处置闸 ──────────────────────────────────
    // 前两条通过才跑处置闸（同因不重复报）。取消航段会改 total（应收下降），语义上属于
    // 「处置订单资金」，与拆单/改结算价同一把闸：退款审批中、取消族终态、回收站单一律拒绝。
    if (order.deletedAt) {
      blockers.push(`订单在回收站（已软删），不能取消${legZh}；如需操作请先恢复订单。`);
    } else if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      blockers.push(
        `订单当前状态（${zhStatus(order.status)}）不可取消${legZh}：仅占座中的有效订单可操作` +
          `（已取消/已退款/支付超时的单不再持有座位，再放一次会把库存账打乱）。`,
      );
    } else {
      try {
        assertOrderAllowsFundsDisposal(order, `取消${legZh}`);
      } catch (err) {
        blockers.push(err instanceof Error ? err.message : `订单当前状态不允许取消${legZh}。`);
      }
    }

    // ── 闸 4：本单必须真的是往返（两段有效航段）────────────────────────────
    // 「有效航段」= flightScheduleId 非空且班次有出发时刻，与 determineFlightLegItems 同源。
    const legRows = order.items.filter(
      (it) =>
        it.kind === OrderItemKind.FLIGHT &&
        it.flightScheduleId != null &&
        it.flightSchedule?.departureTime != null,
    );
    const legs = determineFlightLegItems(legRows);
    const targetRow = leg === 'RETURN' ? legs.return : legs.outbound;
    if (legRows.length < 2 || !targetRow) {
      blockers.push(
        leg === 'RETURN'
          ? '本单是单程（没有回程航段），无需取消回程。'
          : '本单是单程（只有一段航段）：取消唯一一段等于取消整单，请走取消订单流程。',
      );
    }
    if (legRows.length > 2) {
      // 六态开票模型只表达去程/回程两维，三段以上单的「哪一段是去程/回程」没有权威口径，
      // 猜错就会放错座、清错开票位。宁可不做，交人工按航段逐条处理。
      blockers.push(
        `本单有 ${legRows.length} 段航段（超过去程+回程两段），系统无法自动判定航段方向，` +
          `请人工逐段处理或先拆单。`,
      );
    }

    // ── 闸 5-6：结算价锁 / 收款复核锁（都会被本操作改动的应收挡住）──
    if (order.settlementLocked) {
      blockers.push(`该订单结算价已锁定，取消${legZh}会改动应收。请先解锁结算价再操作。`);
    }
    if (order.paymentsLocked) {
      blockers.push(`该订单收款已复核锁定，取消${legZh}会改动应收。请先解锁收款再操作。`);
    }

    // ── 闸 7：被取消那一段已开票（发票金额与订单金额不能脱钩）──
    // 只挡「本段」的开票位：取消去程时回程可以是已开票的，那张票对应的行程还在飞，
    // 它的开票位会在执行时随航段改判一起搬到 outboundInvoiced（见步骤 9）。
    const legInvoiced = leg === 'RETURN' ? order.returnInvoiced : order.outboundInvoiced;
    if (legInvoiced) {
      blockers.push(
        `${legZh}已开票，请先在票务台把${legZh}开票状态改回「未开」，取消${legZh}后再按新金额重开。`,
      );
    }

    // ── 闸 8（已从硬闸改为「提示 + 二次确认」）：本段已出票 ──────────────────────
    // 旧口径 fail-closed 拒绝已出票的段、让运营「走改签/退票流程」。但真实业务里
    // 「客人不飞了、这一段作废、座位放回去重卖」本来就要发生，硬拦只会逼运营去别处
    // 手改状态绕过，账反而更乱。现口径：照做，但
    //   · 预检把它列进 warnings（requiresAcknowledgement=true），前端弹二次确认；
    //   · 未带 acknowledgeWarnings 提交 → 400 ACKNOWLEDGEMENT_REQUIRED；
    //   · 执行时在同一事务里给票务派一条「撤名单/退票」工单，善后由票务台按工单跟进。
    //
    // ⚠ 判定只认**航段级**的确认出票记录（FulfillmentTask.orderItemId = 被取消的这一行）。
    // 旧实现还 or 了一条整单级的 `order.passengers.some(pnr || eticket)` —— 那是订单维度的，
    // 去程出了票就会把回程一并判成「已出票」，回程明明一张票都没开也被挡住。已删除。
    const confirmedTicketing = targetRow
      ? await db.fulfillmentTask.count({
          where: {
            orderItemId: targetRow.id,
            type: FulfillmentType.FLIGHT_TICKETING,
            status: FulfillmentStatus.CONFIRMED,
          },
        })
      : 0;
    if (confirmedTicketing > 0) {
      const ticketedWarning =
        `${legZh}已出票（该段有 ${confirmedTicketing} 条确认出票记录）。` +
        `取消后系统会给票务派一条撤名单/退票工单，请确认已知悉。`;
      warnings.push(ticketedWarning);
      ackWarnings.push(ticketedWarning);
    }
    // 航段级任务没有 CONFIRMED、但本单乘客身上已经挂了 PNR/票号 → 至少提醒一句。
    // 判定本身仍只信航段级（订单级会把去程的票算到回程头上，见上面那段），
    // 但「这单已经出过票了」是客观事实，不该完全不提；只作提示，不进 requiresAcknowledgement。
    if (
      confirmedTicketing === 0 &&
      order.passengers.some(
        (p) => (p.pnr && p.pnr.trim() !== '') || (p.eticketNumber && p.eticketNumber.trim() !== ''),
      )
    ) {
      warnings.push(
        `本单乘客已有 PNR/票号（但${legZh}没有已确认的出票任务记录）：` +
          `请先确认这一段的票到底出没出，再决定要不要走取消。`,
      );
    }

    // ── 闸 9：进行中的退款（应退额是按申请当刻的报价快照算的，改应收会把它算错）──
    const inflightRefunds = await db.refund.count({
      where: {
        orderId: order.id,
        status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING] },
      },
    });
    if (inflightRefunds > 0) {
      blockers.push(`该订单有进行中的退款，请先完成或驳回退款流程再取消${legZh}。`);
    }

    // ── 闸 10：这一段已经飞了 —— 飞过的航段不存在「取消」这回事 ─────────────────
    // 取消航段 = 把座位放回库存 + 按取消政策退钱。对一段**已经起飞**的航段做这件事，
    // 等于把一个早已被消耗掉的座位重新放出去卖（凭空多卖一座），同时按退改政策退了钱。
    // 客人没登机是 no-show：钱不退、成本照付、只有回程座位可以放回来 —— 走 no-show 端点。
    const targetDepartAt = targetRow?.flightSchedule?.departureTime ?? null;
    if (targetRow && targetDepartAt && targetDepartAt.getTime() <= Date.now()) {
      const sched = targetRow.flightSchedule;
      const localWhen = `${localDateISO(targetDepartAt, sched?.departureTz)} ${localHHMM(targetDepartAt, sched?.departureTz)}`;
      blockers.push(
        `${legZh}已起飞（当地时间 ${localWhen} 出发），不能取消航段；` +
          '客人没登机请走「标记 no-show」处理（钱不动，回程座位可释放回库存）。',
      );
    }

    // ── 闸 11：这一段已被标 no-show —— 钱已经明确不退，不能再从取消通道退一次 ──────
    // no-show 的口径是「钱与成本一分不动」。若还能对同一段走取消航段，就会按退改政策
    // 把应收降下来、生成多收 → 走退款流程真金白银退出去，与 no-show 的口径直接打架。
    if (targetRow && readJsonObject(readJsonObject(targetRow.metadata).noShow).at != null) {
      blockers.push(
        `${legZh}已标记 no-show（客人未登机，按口径钱款不动），不能再走取消航段；` +
          '如需处置钱款请循退款/多收流程另行决定。',
      );
    }

    return {
      order,
      legItem: targetRow ?? null,
      blockers,
      warnings,
      ackWarnings,
      ticketedCount: confirmedTicketing,
    };
  }

  /**
   * 被取消航段行的取消手续费报价（政策口径）。
   *
   * 复用 lib/cancellation 的按行报价入口 quoteCancellationForItem，绝不另写一份费率算法。
   * 动态 import 与本文件既有的 computeCancellationQuote 调用同因：两个单测文件用
   * vi.mock('../../lib/cancellation.js') 做了部分工厂，静态引用在那里会变成 undefined。
   *
   * 金额取整到元（调价行是整数 CNY 口径），并夹到 [0, 该航段行金额]：
   * 取消一段航段收的手续费不可能比这段本身还贵。
   */
  private async _quoteLegCancelFee(
    db: Prisma.TransactionClient,
    itemId: string,
    legAmountCny: number,
    at: Date,
  ): Promise<LegCancelPolicyFee | null> {
    const { quoteCancellationForItem } = await import('../../lib/cancellation.js');
    const full = await db.orderItem.findUnique({
      where: { id: itemId },
      include: {
        flightSchedule: { select: { departureTime: true } },
        fulfillmentTasks: { select: { status: true, type: true } },
      },
    });
    if (!full) return null;
    const quote = await quoteCancellationForItem(full, at, db);
    return {
      policyName: quote.policyName,
      feePercent: quote.feePercent,
      feeAmountCny: Math.min(
        Math.max(0, Math.round(quote.feeAmount)),
        Math.max(0, Math.round(legAmountCny)),
      ),
      hoursLeft: quote.hoursLeft,
    };
  }

  /** 航段行 → 预检/审计用的可读快照。 */
  private _describeLeg(item: CancelLegItemSnapshot): CancelLegItemView {
    const sched = item.flightSchedule;
    return {
      orderItemId: item.id,
      description: item.description,
      flightNumber: sched?.flight?.flightNumber ?? null,
      // 出发日按出发地时区折算成当地日（全站口径；naive timestamp 直接切串会差 8 小时）。
      departDate: sched?.departureTime ? localDateISO(sched.departureTime, sched.departureTz) : null,
      cabin: item.flightCabin,
      quantity: item.quantity,
      amountCny: round2(Number(item.amount)),
    };
  }

  /**
   * 取消航段 · 预检（只读）：POST /orders/:id/cancel-leg/preview。
   *
   * 一次性返回**全部**不满足的闸（blockers），而不是命中第一条就停 —— 运营要在一个弹窗里
   * 看完所有待清障项，而不是修一条试一次。
   */
  async previewCancelLeg(
    orderId: string,
    leg: FlightLegSide,
    actor: { userId: string; role: UserRole },
  ): Promise<CancelLegPreview> {
    if (!actorCan(actor, 'orders.cancel_leg')) {
      throw new ForbiddenError(`仅运营/管理员可取消${LEG_ZH[leg]}`);
    }
    const { order, legItem, blockers, warnings, ackWarnings } = await this._assessCancelLeg(
      prisma,
      orderId,
      leg,
    );

    const currentTotalCny = round2(Number(order.total));
    const paidAmountCny = round2(Number(order.paidAmount));
    const legAmountCny = legItem ? round2(Number(legItem.amount)) : 0;

    // 有 blocker 也照报价：运营要先看到「清障后大约收多少手续费、应收降多少」再决定做不做。
    const policyFee = legItem
      ? await this._quoteLegCancelFee(prisma, legItem.id, legAmountCny, new Date())
      : null;

    const netReductionCny = legItem ? round2(legAmountCny - (policyFee?.feeAmountCny ?? 0)) : 0;
    const totalAfterCny = round2(currentTotalCny - netReductionCny);
    // 手动填退款金额的前端上限：退多少都不能超过该段本身的钱，也不能把本单应收退成负数。
    const maxRefundCny = legItem ? Math.min(Math.round(legAmountCny), currentTotalCny) : 0;

    return {
      leg,
      eligible: blockers.length === 0,
      blockers,
      warnings,
      // 只有「需回执」的那一档才逼二次确认（ackWarnings）；其余提示照常展示但不拦提交。
      requiresAcknowledgement: ackWarnings.length > 0,
      returnItem: legItem ? this._describeLeg(legItem) : null,
      policyFee,
      netReductionCny,
      maxRefundCny,
      currentTotalCny,
      paidAmountCny,
      overpayAfterCny: round2(Math.max(0, paidAmountCny - totalAfterCny)),
    };
  }

  /** 老路径 POST /orders/:id/cancel-return-leg/preview 的别名（leg 固定 RETURN）。 */
  async previewCancelReturnLeg(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<CancelLegPreview> {
    return this.previewCancelLeg(orderId, 'RETURN', actor);
  }

  /**
   * 取消航段 · 执行：POST /orders/:id/cancel-leg。
   *
   * 单事务内：锁订单行（FOR UPDATE，与改期/超时 worker 抢同一把锁 → 座位账严格串行）
   *   → 幂等回放检查 → 重跑全部准入闸 → 放该段座位（复用 releaseSeatFloored +
   *   computeBundleSeatSplit，与改期「释放旧座」逐行同镜像）→ 该航段行作废保留
   *   → 该段履约任务终态化 → hasReturnLeg 同步 → 手续费调价行 → 开票位随航段改判搬家
   *   → 重算 subtotal/total。
   *
   * 幂等：同 (订单, requestToken) 重试只回放既有结果 —— 标记写在被取消行的
   * metadata.returnLegCancelled 里，与作废动作同一次写入、同一事务，不可能出现
   * 「座放了、标记没落」。座位因此**只会被放一次**。
   */
  async cancelLeg(
    orderId: string,
    input: CancelLegBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{ order: ReturnType<typeof serializeOrder>; audit: CancelLegAudit }> {
    const leg = input.leg;
    const legZh = LEG_ZH[leg];
    if (!actorCan(actor, 'orders.cancel_leg')) {
      throw new ForbiddenError(`仅运营/管理员可取消${legZh}`);
    }

    const audit = await prisma.$transaction(async (tx) => {
      // 与 rescheduleOrderItem / 超时 worker 同一把行锁：谁先拿锁谁先提交，杜绝
      // 「改期正在搬这条行」与「本端点正在放这条行的座」交错导致的双放 / 幽灵持有。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      // ── 0. 幂等回放：同 token 已取消过 → 原样回放，绝不二次放座 / 二次收手续费 ──
      // 打标键 returnLegCancelled 去程/回程共用（老数据兼容），所以两个方向的重放都命中这里。
      const flightRows = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT },
        select: { id: true, metadata: true },
      });
      const tokenLookup = hasSeenLegActionToken(flightRows, input.requestToken);
      const replayRow = flightRows.find(
        (row) =>
          readJsonObject(readJsonObject(row.metadata).returnLegCancelled).requestToken ===
          input.requestToken,
      );
      if (tokenLookup.seen || replayRow) {
        // 动作类型 + 入参指纹都要对得上：同一个 token 先取消了回程、又拿来取消去程（或去标
        // no-show），按 token 命中就回放会让运营看到「取消成功」而实际上什么都没发生 ——
        // 那一段还占着座、这一次的手续费也没收。老快照没有指纹一律拒（fail-closed）。
        assertLegActionTokenReplay(tokenLookup, ['CANCEL_LEG'], cancelLegFingerprint(input));
        if (!replayRow) {
          // 类型/指纹都对上了却找不到作废快照 —— 说明这个 token 的留痕已经被拆单/改期搬走，
          // 回放不出真实结果，只能让运营换个新请求编号重来。
          throw tokenPayloadMismatchError({ reason: 'SNAPSHOT_MISSING', priorType: tokenLookup.type });
        }
        const snap = readJsonObject(readJsonObject(replayRow.metadata).returnLegCancelled);
        const current = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { orderNumber: true, total: true, paidAmount: true },
        });
        const totalAfter = round2(Number(current.total));
        const originalAmountCny = Number(snap.originalAmountCny ?? 0);
        const feeCny = Number(snap.feeCny ?? 0);
        return {
          orderNumber: current.orderNumber,
          // 老快照没有 leg 字段（本端点原先只做回程）→ 按 RETURN 读，语义与当时一致。
          leg: (snap.leg === 'OUTBOUND' ? 'OUTBOUND' : 'RETURN') as FlightLegSide,
          returnItemId: replayRow.id,
          feeItemId: null,
          workOrderReminderId:
            typeof snap.workOrderReminderId === 'string' ? snap.workOrderReminderId : null,
          workOrderTitle: typeof snap.workOrderTitle === 'string' ? snap.workOrderTitle : null,
          releasedSeats: Array.isArray(snap.releasedSeats)
            ? (snap.releasedSeats as CancelLegAudit['releasedSeats'])
            : [],
          originalAmountCny,
          feeCny,
          feeMode: (snap.feeMode === 'MANUAL' ? 'MANUAL' : 'POLICY') as 'POLICY' | 'MANUAL',
          policyName: typeof snap.policyName === 'string' ? snap.policyName : null,
          netReductionCny: round2(originalAmountCny - feeCny),
          totalBefore: Number(snap.totalBeforeCny ?? totalAfter),
          totalAfter,
          overpayAfterCny: round2(Math.max(0, Number(current.paidAmount) - totalAfter)),
          replayed: true,
        };
      }

      // ── 1. 重跑准入闸（预检放行到执行之间世界可能已经变了）──
      const { order, legItem, blockers, ackWarnings, ticketedCount } = await this._assessCancelLeg(
        tx,
        orderId,
        leg,
      );
      if (blockers.length > 0 || !legItem) {
        throw new BadRequestError(blockers.join('；') || `本单没有可取消的${legZh}航段。`);
      }

      // ── 1b. 非阻断提示必须带「我已知悉」回执 ──────────────────────────────
      // 稳定 code 给前端判：收到就弹二次确认（把 details.warnings 原文列出来），
      // 确认后带 acknowledgeWarnings=true 重提。不靠中文文案匹配。
      if (ackWarnings.length > 0 && input.acknowledgeWarnings !== true) {
        throw new AppError(ackWarnings.join('；'), {
          statusCode: 400,
          code: 'ACKNOWLEDGEMENT_REQUIRED',
          details: { warnings: ackWarnings },
        });
      }

      const legAmountCny = round2(Number(legItem.amount));
      const totalBeforeCny = round2(Number(order.total));
      const legAmountRounded = Math.round(legAmountCny);

      // ── 2. 手续费 / 退款：服务端权威定价 ──────────────────────────────────
      // POLICY = 按取消政策对该航段行报价；MANUAL = 运营手工填「退给客人多少钱」
      // （manualRefundCny，退款视角；老字段 manualFeeCny 仍兼容，都给时以退款金额为准）。
      // 两档都必须满足：0 ≤ 退款 ≤ min(该航段行金额, 本单当前应收) —— 退款不能把
      // 本单应收退成负数，也不能比这段本身的钱还多。请求体里其它任何金额一律不认。
      const now = new Date();
      const policyFee = await this._quoteLegCancelFee(tx, legItem.id, legAmountCny, now);
      const maxRefundCny = Math.min(legAmountRounded, totalBeforeCny);
      let feeCny: number;
      if (input.feeMode === 'MANUAL') {
        const refundCny =
          input.manualRefundCny != null
            ? Math.trunc(input.manualRefundCny)
            : legAmountRounded - Math.trunc(input.manualFeeCny ?? 0);
        if (refundCny < 0 || refundCny > maxRefundCny) {
          throw new BadRequestError(
            `退款金额 ¥${refundCny} 不在允许范围内：退款不能超过本单当前应收 ¥${totalBeforeCny}，` +
              `也不能超过${legZh}航段金额 ¥${legAmountRounded}。`,
          );
        }
        feeCny = legAmountRounded - refundCny;
      } else {
        feeCny = policyFee?.feeAmountCny ?? 0;
      }
      const netReductionCny = round2(legAmountCny - feeCny);
      // POLICY 档理论上不会触发（_quoteLegCancelFee 已把 feeAmountCny 夹到 [0, 该行金额]），
      // 但该行金额本身可能大于本单当前应收（如同单已有其它调价把 total 压低过）——
      // 命中即拒，指路手动填退款金额，绝不让 total 落库为负。
      if (netReductionCny > totalBeforeCny) {
        throw new BadRequestError(
          `按取消政策退款 ¥${netReductionCny} 超过本单当前应收 ¥${totalBeforeCny}：` +
            `请改用「手动填退款金额」，把退款金额压到 ¥${totalBeforeCny} 以内。`,
        );
      }

      // ── 3. 放该段座位（按下单时的升舱拆座镜像各退各舱，与改期「释放旧座」同一 helper）──
      // 只在事务内、只对占座态订单（闸 2 已断言）、只放一次（闸 0 幂等）——座位账三条对称约束。
      const releasedSeats: CancelLegAudit['releasedSeats'] = [];
      const legScheduleId = legItem.flightScheduleId;
      const legCabin = legItem.flightCabin;
      if (legScheduleId && legCabin) {
        const meta = readJsonObject(legItem.metadata);
        const rawUpgrade =
          typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
        const split = computeBundleSeatSplit(legCabin, legItem.quantity, rawUpgrade);
        await releaseSeatFloored(tx, legScheduleId, 'BUSINESS', split.business);
        await releaseSeatFloored(tx, legScheduleId, legCabin, split.sameCabin);
        if (split.business > 0) {
          releasedSeats.push({
            scheduleId: legScheduleId,
            cabin: 'BUSINESS',
            quantity: split.business,
          });
        }
        if (split.sameCabin > 0) {
          releasedSeats.push({
            scheduleId: legScheduleId,
            cabin: legCabin,
            quantity: split.sameCabin,
          });
        }
      }

      // ── 3b. 本段已出票 → 同一事务给票务派「撤名单/退票」工单 ────────────────
      // 与作废动作同事务：不可能出现「段作废了、工单没派出去」。
      // 工单 id 进下面的作废快照，幂等回放时原样读回（不会重复派单）。
      let workOrderReminderId: string | null = null;
      let workOrderTitle: string | null = null;
      if (ticketedCount > 0) {
        workOrderTitle = buildTicketWorkOrderTitle('撤名单/退票', order.orderNumber, legZh, legItem);
        workOrderReminderId = await createTicketWorkOrder(tx, {
          orderId,
          createdById: actor.userId,
          ruleKey: `LEG_CANCEL_WITHDRAW:${legItem.id}:${input.requestToken}`,
          title: workOrderTitle,
          body:
            `订单 ${order.orderNumber} 的${legZh}已取消，该段座位已放回库存。` +
            `该段有 ${ticketedCount} 条确认出票记录，请到航司/出票渠道撤名单或办理退票，` +
            `完成后把本条标记为已处理。` +
            (input.note?.trim() ? `\n操作备注：${input.note.trim()}` : ''),
          at: now,
        });
      }

      // ── 4. 该航段行「作废保留」：金额/成本归零 + 班次置空 + 快照落 metadata ──────
      // 不物理删行：已取消航段要留痕（原班次、原金额、谁在什么时候按什么政策取消的）。
      // flightScheduleId 置空 = 全站「有效航段」判定的统一口径，置空即退出座位/开票/回程列统计。
      // quantity 保持不变（留痕这段原本几个人），金额已归零故不影响任何合计。
      // 成本一并归零：座位已还回库存，这段不再产生采购成本；留着会让本单毛利凭空变负。
      const preservedMeta = readJsonObject(legItem.metadata);
      const cancelPrefix = LEG_CANCELLED_PREFIX[leg];
      const cancelSnapshot = {
        at: now.toISOString(),
        byUserId: actor.userId,
        requestToken: input.requestToken,
        leg,
        originalDescription: legItem.description,
        originalAmountCny: legAmountCny,
        originalScheduleId: legScheduleId,
        originalCabin: legCabin,
        feeCny,
        // 退给客人的金额（= 该航段行金额 − feeCny，与 netReductionCny 同一个数，
        // 换个名字落痕方便直接按「退了多少钱」核对，不用再心算）。
        refundCny: netReductionCny,
        feeMode: input.feeMode,
        overrideReason: input.overrideReason?.trim() || null,
        note: input.note?.trim() || null,
        policyName: policyFee?.policyName ?? null,
        policySnapshot: policyFee,
        releasedSeats,
        ticketedAtCancel: ticketedCount,
        workOrderReminderId,
        workOrderTitle,
        totalBeforeCny,
        totalAfterCny: round2(totalBeforeCny - netReductionCny),
      };
      await tx.orderItem.update({
        where: { id: legItem.id },
        data: {
          description: legItem.description.startsWith(cancelPrefix)
            ? legItem.description
            : `${cancelPrefix}${legItem.description}`,
          flightScheduleId: null,
          unitPrice: new Prisma.Decimal(0),
          amount: new Prisma.Decimal(0),
          unitCostCny: new Prisma.Decimal(0),
          totalCostCny: new Prisma.Decimal(0),
          metadata: {
            ...preservedMeta,
            returnLegCancelled: cancelSnapshot,
            // 取消航段也进 legActionLog（append-only）：回放守闸认的是这条流水上的
            // 动作类型与入参指纹，光有 returnLegCancelled 快照分不出「这个 token 当初干了什么」。
            legActionLog: appendLegActionLog(preservedMeta, {
              type: 'CANCEL_LEG',
              requestToken: input.requestToken,
              at: now.toISOString(),
              byUserId: actor.userId,
              seats: releasedSeats.reduce((n, r) => n + r.quantity, 0),
              fingerprint: cancelLegFingerprint(input),
            }),
          } as Prisma.InputJsonValue,
        },
      });

      // ── 5. 该段履约任务终态化（口径同订单落取消族：只动仍活着的任务，幂等）──
      // 已 CONFIRMED 的出票任务**不动**：票在航司那边是真实存在的，把记录改掉等于抹掉
      // 「这段出过票」的事实。撤名单/退票由下面派出去的工单驱动票务台处理。
      await tx.fulfillmentTask.updateMany({
        where: {
          orderItemId: legItem.id,
          status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
        },
        data: { status: FulfillmentStatus.CANCELLED, completedAt: now },
      });

      // ── 6. 物化列 hasReturnLeg 同步（此刻只剩一段有效航段 → 必然回落 false）──
      await syncOrderHasReturnLeg(tx, orderId);
      await syncOrderLegFlag(tx, orderId);

      // ── 7. 手续费调价行（endpoint-only 原因码；费为 0 就不留空行）──────────────
      // 走与录单调价/事后调价完全同一条路径：一条独立 FEE 行进 subtotal/total，
      // 不去动 adjustmentCny（那是改期费/换人费的整单口径，与调价行是两套账，混用会双记）。
      let feeItemId: string | null = null;
      if (feeCny > 0) {
        // 覆盖原因是内部口径（航司特批/议价等），只落 metadata 快照与审计，不进行描述——
        // 行描述会出现在客户可见的导出/行程单里，内部原因不外露。
        const reasonText =
          input.feeMode === 'MANUAL' ? '手工核定' : (policyFee?.policyName ?? '按取消政策');
        const row = buildPriceAdjustmentItem({
          amountCny: feeCny,
          reasonCode: LEG_CANCEL_FEE_REASON[leg],
          reasonText,
        });
        const created = await tx.orderItem.create({
          data: {
            orderId,
            kind: row.kind,
            description: row.description,
            quantity: 1,
            unitPrice: new Prisma.Decimal(row.unitPrice),
            amount: new Prisma.Decimal(row.amount),
            totalCostCny: new Prisma.Decimal(row.totalCostCny),
            metadata: {
              ...row.metadata,
              returnLegCancelFee: true,
              cancelledLeg: leg,
              returnItemId: legItem.id,
              feeMode: input.feeMode,
            } as Prisma.InputJsonValue,
          },
        });
        feeItemId = created.id;
      }

      // ── 8. 重算 subtotal/total（口径同事后调价：Σ 全部行金额；当前 total = subtotal）──
      // 该航段行已归零、手续费行已入账，故等价于「旧合计 − 该行金额 + 手续费」。
      const newSubtotal = round2(
        order.items.reduce((sum, it) => sum + Number(it.amount), 0) - legAmountCny + feeCny,
      );

      // ── 9. 开票位随航段改判搬家 ────────────────────────────────────────────
      // 取消回程：回程没了 → returnInvoiced 必须是「未开」（闸 7 已保证 false，这里自愈式定值写）。
      // 取消去程：剩下那一段就地变成「去程」（位置判定），它原来的开票位挂在 returnInvoiced 上，
      //   必须搬到 outboundInvoiced，否则出票上限漏计（可能超发）、导出显示完全未开、
      //   还会掉进「去程未开」的票务待办。闸 7 已保证 outboundInvoiced=false，不会覆盖掉信息。
      const invoiceFlags =
        leg === 'RETURN'
          ? { returnInvoiced: false }
          : { outboundInvoiced: order.returnInvoiced, returnInvoiced: false };

      const log = appendAdjustment(order.adjustments, {
        type: leg === 'RETURN' ? 'RETURN_LEG_CANCEL' : 'OUTBOUND_LEG_CANCEL',
        label: `取消${legZh}${feeCny > 0 ? `（手续费 ¥${feeCny}）` : '（不收手续费）'}`,
        // 本流水只作留痕：钱走 total（手续费调价行），不进 adjustmentCny，避免同一笔费双记。
        amountCny: 0,
        at: now.toISOString(),
        by: actor.userId,
        note: input.note?.trim() || input.overrideReason?.trim() || undefined,
      });
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newSubtotal),
          ...invoiceFlags,
          adjustments: log,
        },
      });

      // ── 10. 手工覆盖政策报价的 CRITICAL 审计 —— **必须与改金额同一事务** ──────────
      //
      // 手工手续费是人为改动金额，审计不是「做完了顺手留个痕」，它就是这一步的放行条件：
      // 路由层的 writeAudit 是 fire-and-forget（异步、失败只打日志），落不落库不由这个事务
      // 决定 —— 进程在响应写回前挂掉，钱改了而「谁按什么理由改的」一条都查不到。
      // 所以 MANUAL 这一档改在事务内写，要么都成、要么都回滚；POLICY 那档是服务端权威报价，
      // 仍由路由层记 WARNING。
      if (input.feeMode === 'MANUAL') {
        await writeAuditWithinTx(tx, {
          actor: { userId: actor.userId, role: actor.role },
          action: leg === 'OUTBOUND' ? 'CANCEL_OUTBOUND_LEG' : 'CANCEL_RETURN_LEG',
          targetType: AuditTargetType.ORDER,
          targetId: orderId,
          targetLabel:
            `${order.orderNumber} · 取消${legZh}（手工手续费 ¥${feeCny}，` +
            `政策报价 ¥${policyFee?.feeAmountCny ?? 0}）`,
          before: {
            returnItemId: legItem.id,
            originalAmountCny: legAmountCny,
            totalCny: totalBeforeCny,
          },
          after: {
            leg,
            feeMode: input.feeMode,
            manualFeeCny: feeCny,
            refundCny: netReductionCny,
            overrideReason: input.overrideReason?.trim() || null,
            policyName: policyFee?.policyName ?? null,
            policyFeeCny: policyFee?.feeAmountCny ?? null,
            note: input.note?.trim() || null,
            releasedSeats,
            workOrderReminderId,
            netReductionCny,
            totalBefore: totalBeforeCny,
            totalAfter: newSubtotal,
            replayed: false,
          },
          severity: AuditSeverity.CRITICAL,
        });
      }

      const paidAmountCny = round2(Number(order.paidAmount));
      return {
        orderNumber: order.orderNumber,
        leg,
        returnItemId: legItem.id,
        feeItemId,
        workOrderReminderId,
        workOrderTitle,
        releasedSeats,
        originalAmountCny: legAmountCny,
        feeCny,
        feeMode: input.feeMode,
        policyName: policyFee?.policyName ?? null,
        netReductionCny,
        totalBefore: totalBeforeCny,
        totalAfter: newSubtotal,
        overpayAfterCny: round2(Math.max(0, paidAmountCny - newSubtotal)),
        replayed: false,
      };
    });

    // 事务已提交：这里才 fire-and-forget 推企业微信，绝不在事务内发 HTTP。
    // replayed=true（幂等回放）不重复推——工单在上一次真实执行时已经推过了。
    if (!audit.replayed && audit.workOrderReminderId) {
      void notifyWorkOrderCreatedToWecom(audit.orderNumber, audit.workOrderTitle);
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      audit,
    };
  }

  /** 老路径 POST /orders/:id/cancel-return-leg 的别名（leg 固定 RETURN）。 */
  async cancelReturnLeg(
    orderId: string,
    input: CancelReturnLegBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{ order: ReturnType<typeof serializeOrder>; audit: CancelLegAudit }> {
    return this.cancelLeg(orderId, { ...input, leg: 'RETURN' }, actor);
  }

  // ════════════════════════════════════════════════════════════════════
  // 去程 no-show + 回程释放 / 恢复
  //
  // 业务原样（航司每天发 no-show 名单，票务照单处理）：
  //   · 客人没登机 → 去程标 no-show：**钱不动**（不退款、不改应收）、**成本不动**
  //     （座位已经飞掉了，采购成本照付）。只在订单行上打一个可查的标。
  //   · 回程座位释放回库存，可以继续卖 —— 同样**钱不动**：这是公司把空出来的座位收回，
  //     不是客人退票。收了多少还是多少，退不退由既有多收/退款流程另行决定。
  //   · 之后代理来说「这位客人还要回程」→ 票务恢复回原班次：有座直接占，没座允许超售
  //     （包机位本来就按 no-show 率放量），前端二次确认、后端 CRITICAL 审计。
  //     系统不设任何通知时限或门槛，能不能恢复只看余位与班次是否已起飞。
  //
  // ⚠ 与「取消航段」的界线（两个端点，别混）：
  //   取消回程 = 客人主动退这一段 → 按取消政策收手续费、应收下降、多收走退款流程（钱要动）；
  //   no-show 释放 = 客人没来、公司放座重卖 → **一个金额字段都不写**
  //     （unitPrice / amount / unitCostCny / totalCostCny / subtotal / total 全不动），
  //     开票位也不动（钱没变，发票就不该变）。
  //
  // 座位账对称：释放时把逐舱位的张数快照进 metadata.returnReleased.releasedSeats，
  // 恢复时**照快照回填**，不重新按 quantity 推算 —— 放几座就恢复几座，升舱拆座镜像原样还原。
  //
  // 一单只有部分人 no-show：先按所选乘客拆单（票随人走）、再对拆出的新单标记，
  // 与「按人改期」同一条 Split PNR 编排。套餐单目前被拆单闸 10 挡住 → 返回结构化 409。
  // ════════════════════════════════════════════════════════════════════

  /** no-show 的准入评估（preview 与 execute 共用同一口径，杜绝预检放行、执行另算）。 */
  private async _assessNoShow(
    db: Prisma.TransactionClient,
    orderId: string,
    passengerIds: string[] | undefined,
    /** 本次是否同时释放回程座位（默认 true，与 noShowBodySchema 的缺省一致）。 */
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
    const order = await loadOrderForLegCancel(db, orderId);
    if (!order) throw new NotFoundError('订单不存在');

    const blockers: string[] = [];
    const warnings: string[] = [];

    // ── 闸 1-2：存活 / 占座中 ────────────────────────────────────────────────
    // **不跑资金处置闸、不看结算价锁/收款复核锁/开票位**：本操作一分钱不动，
    // 那几把闸管的都是「会改应收」的动作，套在这里只会白挡运营。
    if (order.deletedAt) {
      blockers.push('订单在回收站（已软删），不能标记 no-show；如需操作请先恢复订单。');
    } else if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      blockers.push(
        `订单当前状态（${zhStatus(order.status)}）不能标记 no-show：` +
          '仅占座中的有效订单可操作（已取消/已退款/支付超时的单不再持有座位）。',
      );
    }

    // ── 闸 3：必须有去程航段（有效航段 = flightScheduleId 非空，与全站同口径）──
    const legRows = order.items.filter(
      (it) =>
        it.kind === OrderItemKind.FLIGHT &&
        it.flightScheduleId != null &&
        it.flightSchedule?.departureTime != null,
    );
    const legs = determineFlightLegItems(legRows);
    const outboundItem = legs.outbound ?? null;
    const returnItem = legs.return ?? null;
    if (!outboundItem) {
      blockers.push('本单没有可标记的去程航段（航段未录入班次，或已被取消/释放）。');
    }
    if (legRows.length > 2) {
      // 与取消航段同因：三段以上单的去程/回程没有权威口径，猜错会放错座。
      blockers.push(
        `本单有 ${legRows.length} 段航段（超过去程+回程两段），系统无法自动判定航段方向，` +
          '请人工逐段处理或先拆单。',
      );
    }

    // ── 闸 4：去程必须**已经关柜**（柜台一关，人就上不去了）──────────────────────
    // 锚点是关柜时刻，不是起飞时刻：航司名单按关柜出，票务不必再干等那 45 分钟
    //（关柜提前分钟数按班次取，没配走系统默认，见 lib/checkin-close.ts）。
    // departureTime / 关柜时刻都是真 UTC 瞬间（departureTz 只用于展示折算），直接与当前时刻比。
    const departAt = outboundItem?.flightSchedule?.departureTime ?? null;
    const outboundCloseAt = departAt
      ? checkinCloseAt(departAt, outboundItem?.flightSchedule?.checkinCloseMinutes)
      : null;
    if (outboundItem && outboundCloseAt && outboundCloseAt.getTime() > Date.now()) {
      const sched = outboundItem.flightSchedule;
      const localWhen = `${localDateISO(outboundCloseAt, sched?.departureTz)} ${localHHMM(outboundCloseAt, sched?.departureTz)}`;
      blockers.push(
        `去程航班尚未关柜（当地时间 ${localWhen} 关柜），未关柜不能标记 no-show。` +
          '客人临时不飞请走取消航段/取消订单流程。',
      );
    }

    // ── 闸 5：回程当前不得处于「已释放态」（不是「标过就永远不能再标」）─────────────
    //
    // 释放 → 恢复 → 再释放，在业务上完全正常：客人 no-show 后代理说要保留回程（恢复），
    // 结果人还是没来（再释放）。旧口径只看「去程标过 no-show 没有」，标过就一律拒 ——
    // 恢复回来的那份座位从此再也放不掉，只能人工改库存。
    // 现口径只拦真正冲突的那一种：**回程座位此刻还躺在已释放态**，再放一次会把 sold 打穿。
    const alreadyNoShow =
      outboundItem != null && readJsonObject(readJsonObject(outboundItem.metadata).noShow).at != null;
    const releaseState = resolveReturnReleaseState(order.items);
    if (releaseState.releasedNow) {
      blockers.push(
        `本单回程座位当前已释放（${releaseState.releasedAt ? businessDateTime(releaseState.releasedAt) : '时间未知'}），` +
          '不能重复释放；如需把座位重新占回原班次，请点「恢复回程」。',
      );
    } else if (alreadyNoShow && !returnItem) {
      // 去程标过、又没有可释放的回程 → 本次执行什么都不会发生，如实拒掉而不是空跑一趟。
      const at = readJsonObject(readJsonObject(outboundItem!.metadata).noShow).at;
      blockers.push(
        `本单去程已标记 no-show（${typeof at === 'string' ? businessDateTime(new Date(at)) : '时间未知'}），` +
          '且当前没有可释放的回程航段，无需重复标记。',
      );
    }
    // 去程早标过、回程已恢复回来 → 本次只做「再释放一次回程」：首个 no-show 快照保留不覆盖。
    const isRerelease = alreadyNoShow && !releaseState.releasedNow && returnItem != null;
    if (isRerelease && releaseReturn) {
      warnings.push(
        '本单去程此前已标记 no-show、回程已恢复过一次：本次只会再释放一次回程座位，' +
          '首次 no-show 的时间与操作人记录保持不变。',
      );
    } else if (isRerelease && !releaseReturn) {
      // 去程标过、又不释放回程 → 执行段一个字段都不会写，如实拒掉而不是空跑一趟。
      blockers.push(
        '本单去程已标记 no-show，本次又未勾选「同时释放回程」，没有任何可执行的动作；' +
          '如需再释放一次回程座位请勾选它。',
      );
    }

    // ── 闸 5b：回程班次已关柜 —— 关柜后的座位放回库存是凭空多卖 ────────────────────
    // 锚点与闸 4 同源，都是关柜时刻（见 lib/checkin-close.ts）：柜台一关，这个座位就再没人
    // 值得了机 —— 放回库存等于把一个卖不出去的座位当可卖余位再卖一次。
    // 只在勾了「同时释放回程」时阻断；只想留个 no-show 记录（releaseReturn=false）照常放行。
    const returnDepartAt = returnItem?.flightSchedule?.departureTime ?? null;
    const returnCloseAt = returnDepartAt
      ? checkinCloseAt(returnDepartAt, returnItem?.flightSchedule?.checkinCloseMinutes)
      : null;
    // 字段名沿用 returnDeparted（前端契约未改），语义已是「已关柜」（含已起飞）。
    const returnDeparted = returnCloseAt != null && returnCloseAt.getTime() <= Date.now();
    if (returnDeparted && releaseReturn && returnItem) {
      const sched = returnItem.flightSchedule;
      const localWhen =
        returnCloseAt != null
          ? `${localDateISO(returnCloseAt, sched?.departureTz)} ${localHHMM(returnCloseAt, sched?.departureTz)}`
          : '时间未知';
      blockers.push(
        `回程航班已关柜（当地时间 ${localWhen} 关柜），座位不再释放 ——` +
          '关柜后放回库存的座位没人能值机，等于凭空多卖；' +
          '如只需记录 no-show 请取消勾选「同时释放回程」。',
      );
    }

    // ── 闸 5b2：回程行缺舱位信息 —— 放不了座就一步都别走 ────────────────────────
    // 放座是按舱位做的（releaseSeatStrictWithinTx 要 scheduleId + cabin）。舱位为空时旧写法
    // 静默跳过放座那一段，却照常把这一行的班次置空、落 returnReleased 快照 ——
    // 结果是「座位一个没放回库存，系统却认为已经释放了」：这一班从此少卖 N 座，
    // 而后来点「恢复回程」还会照空快照占回来。fail-closed：拦在门口，让运营先把舱位补上。
    if (releaseReturn && returnItem?.flightScheduleId && !returnItem.flightCabin) {
      blockers.push(
        '回程航段缺舱位信息，无法释放座位；请先在订单里补全该航段的舱位等级后重试，' +
          '或取消勾选「同时释放回程」只记录 no-show。',
      );
    }

    // ── 闸 5c：进行中的退款（与取消航段闸 9 同款）──────────────────────────────
    // 本操作虽不动钱，却会把回程座位放掉、把出票任务终态化 —— 退款报价快照是按
    //「申请那一刻这单还有哪些航段」算的，边审批边抽掉一段，批下来的金额就对不上了。
    const noShowInflightRefunds = await db.refund.count({
      where: {
        orderId: order.id,
        status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING] },
      },
    });
    if (noShowInflightRefunds > 0) {
      blockers.push('该订单有进行中的退款，请先完成或驳回退款流程再标记 no-show。');
    }

    // ── 闸 6：勾选范围 —— 部分乘客须先拆单（票随人走）────────────────────────
    const allPaxIds = new Set(order.passengers.map((p) => p.id));
    const picked = passengerIds ? [...new Set(passengerIds)] : null;
    let scope: NoShowScope = 'WHOLE';
    if (picked && picked.length > 0) {
      const unknown = picked.filter((id) => !allPaxIds.has(id));
      if (unknown.length > 0) {
        blockers.push('所选乘客不属于本订单（可能已被换人/拆走），请刷新后重试。');
      } else if (picked.length < allPaxIds.size) {
        scope = 'SPLIT_REQUIRED';
        warnings.push(
          `本次只标记 ${picked.length}/${allPaxIds.size} 位乘客：系统会先按所选乘客拆出新单` +
            '（票随人走），再对新单标记 no-show / 释放回程。',
        );
        // 拆单的闸并到同一份 blockers 里，让运营在一个弹窗看完所有待清障项。
        const splitAssessment = await this.assessOrderSplitForNoShow(db, orderId, picked);
        blockers.push(...splitAssessment);
      }
    }

    // ── 回程状态：出票 / 开票位（都只是提示，不阻断）────────────────────────────
    const returnTicketedCount = returnItem
      ? await db.fulfillmentTask.count({
          where: {
            orderItemId: returnItem.id,
            type: FulfillmentType.FLIGHT_TICKETING,
            status: FulfillmentStatus.CONFIRMED,
          },
        })
      : 0;
    if (returnItem && returnTicketedCount > 0) {
      warnings.push(
        `回程已出票（该段有 ${returnTicketedCount} 条确认出票记录）。释放座位后系统会给票务派一条` +
          '撤名单/退票工单，请确认已知悉。',
      );
    }
    if (returnItem && order.returnInvoiced && releaseReturn) {
      // 释放座位会把回程开票位清成「未开」（口径同取消航段：座位没了，开票进度标记不能留着占额度）。
      // 钱一分没动，清的只是进度标记；恢复回程时不会自动翻回来。
      warnings.push(
        '回程当前标记为「已开票」：释放座位会把这个开票位清成未开（钱与发票本身不受影响）。' +
          '之后若恢复回程并重新出票，请票务台重新标一次。',
      );
    }
    if (!returnItem) {
      warnings.push('本单没有回程航段（单程单），本次只给去程打 no-show 标，没有座位可释放。');
    }

    return {
      order,
      outboundItem,
      returnItem,
      returnTicketedCount,
      blockers,
      warnings,
      scope,
      alreadyNoShow,
      returnDeparted,
      isRerelease,
    };
  }

  /**
   * 借拆单预检拿到「这单能不能按人拆」的人话闸（只取 blockers，不重复算份额展示）。
   * 单独包一层是为了让 _assessNoShow 不必知道拆单的 loader 与快照形状。
   */
  private async assessOrderSplitForNoShow(
    db: Prisma.TransactionClient,
    orderId: string,
    passengerIds: string[],
  ): Promise<string[]> {
    const source = await loadOrderForSplit(db, orderId);
    if (!source) return ['订单不存在，无法拆单。'];
    // 编排路径会自动把混合房组按人劈成两个半组 —— 预检口径必须与执行一致，
    // 否则运营会在弹窗里看到一条「请先去分房里把他们分开」的死路闸。
    const assessment = await this.assessOrderSplit(db, source, passengerIds, {
      autoSplitRoomGroups: true,
    });
    return assessment.blockers;
  }

  /** 航段行 → no-show 预检用的可读快照（不含金额：本操作与钱无关）。 */
  private _describeNoShowLeg(item: CancelLegItemSnapshot): NoShowLegView {
    const sched = item.flightSchedule;
    return {
      orderItemId: item.id,
      description: item.description,
      flightNumber: sched?.flight?.flightNumber ?? null,
      departDate: sched?.departureTime ? localDateISO(sched.departureTime, sched.departureTz) : null,
      cabin: item.flightCabin,
      quantity: item.quantity,
    };
  }

  /**
   * no-show · 预检（只读）：POST /orders/:id/no-show/preview。
   * 一次性返回全部不满足的闸（blockers）+ 全部提示（warnings），供运营在一个弹窗看完。
   */
  async previewNoShow(
    orderId: string,
    body: { passengerIds?: string[]; releaseReturn?: boolean },
    actor: { userId: string; role: UserRole },
  ): Promise<NoShowPreview> {
    if (!actorCan(actor, 'orders.no_show')) {
      throw new ForbiddenError('仅运营/管理员可标记 no-show');
    }
    assertNonEmptyPassengerSelection(body.passengerIds);
    // releaseReturn 缺省 true（与执行体同缺省）：前端把「同时释放回程」勾选框的状态带进来，
    // 预检才能如实回「回程已起飞 → 不能释放」这条闸，而不是执行时才蹦出来。
    const assessed = await this._assessNoShow(
      prisma,
      orderId,
      body.passengerIds,
      body.releaseReturn ?? true,
    );
    return {
      eligible: assessed.blockers.length === 0,
      blockers: assessed.blockers,
      warnings: assessed.warnings,
      scope: assessed.scope,
      outboundItem: assessed.outboundItem
        ? this._describeNoShowLeg(assessed.outboundItem)
        : null,
      returnItem: assessed.returnItem
        ? {
            ...this._describeNoShowLeg(assessed.returnItem),
            ticketed: assessed.returnTicketedCount > 0,
          }
        : null,
      passengers: assessed.order.passengers.map((p) => ({
        id: p.id,
        fullName: p.fullName,
        chineseName: p.chineseName,
      })),
      alreadyNoShow: assessed.alreadyNoShow,
      returnDeparted: assessed.returnDeparted,
      isRerelease: assessed.isRerelease,
    };
  }

  /**
   * no-show · 执行：POST /orders/:id/no-show。
   *
   * 部分乘客 → 照「按人改期」的编排：先 splitOrder 拆出新单，再对新单执行标记
   * （两步不套一个事务，理由同 reschedulePassengers：两套行锁硬嵌会绞死）。
   * 拆成了但标记失败 → 不回滚拆单（新单本身是合法订单），回 409 让运营到新单重试。
   */
  async markNoShow(
    orderId: string,
    input: NoShowBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{
    order: ReturnType<typeof serializeOrder>;
    targetOrderId: string;
    audit: NoShowAudit;
  }> {
    if (!actorCan(actor, 'orders.no_show')) {
      throw new ForbiddenError('仅运营/管理员可标记 no-show');
    }
    // schema 已经把 `[]` 挡在门外；这里再挡一次是给绕过 schema 的内部调用兜底 ——
    // 空数组一旦被当成「整单」放行，就是给全单的人打标、放全单的回程座位。
    assertNonEmptyPassengerSelection(input.passengerIds);

    // ── 1. 判定是否需要先拆单 ───────────────────────────────────────────────
    //
    // ⚠ 判定只有一条正路：**「勾的就是本单全员」才算整单**，其余一律走拆单。
    // 曾经的写法是 `picked.length < 当前单人数` —— 重试时人数已经变了（上一轮已经把这几位
    // 拆走），同一批 id 在源单上就成了「≥ 全员」，于是被判成整单，直接对**留守的人**打标、
    // 把他们的回程座位放掉。登了机的客人凭空丢座，账还对得上，最难查。
    // 现口径与 reschedulePassengers 同构：勾了人且不是全员 → 无条件 splitOrder
    //（它自带 (sourceOrderId, requestToken) 幂等回放，重试只会回放上一轮拆出的那张单）。
    // picked 里有人已经不在源单上（正是重试的特征）→ 同样交给 splitOrder：它的闸 14
    //「所选乘客不属于本订单」会先挡住，或直接命中回放，绝不会误判成整单。
    const head = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNumber: true, passengers: { select: { id: true } } },
    });
    if (!head) throw new NotFoundError('订单不存在');
    const picked = input.passengerIds ? [...new Set(input.passengerIds)] : null;
    const sourcePaxIds = new Set(head.passengers.map((p) => p.id));
    // picked === null（压根没传）才是整单；空数组已在上面被断言拒掉，这里不再兜成整单。
    const isWholeOrder =
      picked == null ||
      (picked.every((id) => sourcePaxIds.has(id)) && picked.length === sourcePaxIds.size);
    const needsSplit = !isWholeOrder;

    if (!needsSplit) {
      const audit = await this._executeNoShow(orderId, input, actor, null);
      // _executeNoShow 内部的事务已提交，这里才 fire-and-forget 推企业微信。
      if (!audit.replayed && audit.workOrderReminderId) {
        void notifyWorkOrderCreatedToWecom(audit.orderNumber, audit.workOrderTitle);
      }
      const finalOrder = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: ORDER_FULL_INCLUDE,
      });
      return {
        order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
        targetOrderId: orderId,
        audit,
      };
    }

    // ── 1b. 拆单**之前**先过一遍订单级 no-show 闸（fail-closed）──────────────────
    //
    // ⚠ 拆单不可回滚（新单是一张合法订单，撤不掉）。所以凡是「跟选了谁无关、这单本来就不能标
    // no-show」的原因 —— 回收站单 / 非占座状态 / 有进行中的退款 / 三段以上无法判方向 /
    // 去程还没起飞 / 回程当前已处于已释放态 / 回程已起飞却勾了释放 —— 必须在拆单前就拦下，
    // 否则运营会得到「单已经拆了，但标不了」这种收不回来的半成品：新单凭空多出来一张，
    // 原单人数被拆走一批，而客人一个都没标上。
    // 传 passengerIds=undefined 只跑订单级闸；与所选乘客相关的闸（不属于本单 / 拆单本身能不能拆）
    // 仍留在拆后由 splitOrder 与 _executeNoShow 各自把关，不在这里重复。
    const preSplitAssessed = await this._assessNoShow(
      prisma,
      orderId,
      undefined,
      input.releaseReturn,
    );
    if (preSplitAssessed.blockers.length > 0) {
      throw new BadRequestError(preSplitAssessed.blockers.join('；'));
    }

    // ── 2. 部分乘客：直接执行拆单（幂等，服务端权威算钱）────────────────────────
    //
    // 这里**不再先跑一遍 previewOrderSplit**：重试时这批人已经不在源单上了，预检的闸 14
    //（「所选乘客不属于本订单」）会先把请求判死，永远走不到 splitOrder 的幂等回放，
    // 于是同一个 token 第二次调用直接 409 —— 明明第一次已经拆成并标好了。
    // 现在把判定权整个交给 splitOrder：能回放就回放，真被闸挡住它自己会抛，映射成同一个
    // 409 SPLIT_BLOCKED（前端一条路处理，无需区分「预检挡下」还是「执行挡下」）。
    // ── 2a. 拆单回放的入参比对（与 _executeNoShow 的 releaseReturn 比对同一道理）────
    // splitOrder 的幂等键是 (源单, requestToken)，命中就原样回放上一轮拆出的那张单。
    // 若这次勾的是**另一批乘客**，回放会静默返回上一轮的新单、再去给那批人标 no-show ——
    // 本次真正勾选的客人一个都没被处理，运营却看到成功。对不上就 409，让前端换新请求编号。
    const priorSplit = await prisma.orderSplitRecord.findUnique({
      where: { sourceOrderId_requestToken: { sourceOrderId: orderId, requestToken: input.requestToken } },
      select: { snapshot: true },
    });
    if (priorSplit) {
      const priorIdsRaw = readJsonObject(priorSplit.snapshot).movedPassengerIds;
      const priorIds = Array.isArray(priorIdsRaw)
        ? priorIdsRaw.filter((v): v is string => typeof v === 'string').sort()
        : null;
      const currentIds = [...picked!].sort();
      // 老记录没留 movedPassengerIds → 无从比对，按老行为回放（fail-open）。
      // 比对用排序后的 JSON 而不是拼接字符串：拼接得挑一个不可能出现在 id 里的分隔符，
      // 此前用的是真 NUL 字节 —— 源码里夹一个 0x00 会被各类工具（diff / 搜索 / 剪贴板）静默吐掉。
      if (priorIds && JSON.stringify(priorIds) !== JSON.stringify(currentIds)) {
        throw tokenPayloadMismatchError({
          field: 'passengerIds',
          priorCount: priorIds.length,
          currentCount: currentIds.length,
        });
      }
    }

    let split: SplitOrderResult;
    try {
      split = await this.splitOrder(
        orderId,
        {
          passengerIds: picked!,
          note: input.note,
          requestToken: input.requestToken,
          // 房数 / 升舱位不由本编排指定：no-show 只知道「谁没来」，间数与升舱位按人头
          // 自动派生（同一份 deriveRoomsToMove / resolveUpgradeToMove，与预检回显同源）。
          autoSplitRoomGroups: true,
        },
        actor,
      );
    } catch (err) {
      // 拆单被闸挡下（套餐单/已计提佣金/有售后费…）或并发改单 → 统一 409 SPLIT_BLOCKED。
      // blockers 是 splitOrder 把全部不满足的闸用「；」拼起来的那串，这里拆回数组给前端逐条列。
      const reason = err instanceof Error ? err.message : '未知错误';
      const blockers = reason.split('；').filter((s) => s.trim() !== '');
      throw new AppError(`拆单未成功，无法只给部分乘客标记 no-show：${reason}`, {
        statusCode: 409,
        code: 'SPLIT_BLOCKED',
        details: { blockers: blockers.length > 0 ? blockers : [reason] },
      });
    }

    // ── 3. 对新单执行标记 ───────────────────────────────────────────────────
    let audit: NoShowAudit;
    try {
      audit = await this._executeNoShow(
        split.targetOrderId,
        input,
        actor,
        { sourceOrderNumber: split.sourceOrderNumber, targetOrderNumber: split.targetOrderNumber },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : '未知错误';
      throw new AppError(
        `已拆出新订单 ${split.targetOrderNumber}（${split.passengerCount} 人），` +
          `但对新单标记 no-show 未成功：${reason}。拆单不会回滚，请到该单上重试。`,
        {
          statusCode: 409,
          code: 'SPLIT_DONE_NOSHOW_FAILED',
          details: {
            newOrderId: split.targetOrderId,
            newOrderNumber: split.targetOrderNumber,
            passengerCount: split.passengerCount,
            reason,
          },
        },
      );
    }

    // _executeNoShow 内部的事务已提交，这里才 fire-and-forget 推企业微信。
    if (!audit.replayed && audit.workOrderReminderId) {
      void notifyWorkOrderCreatedToWecom(audit.orderNumber, audit.workOrderTitle);
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: split.targetOrderId },
      include: ORDER_FULL_INCLUDE,
    });
    return {
      order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
      targetOrderId: split.targetOrderId,
      audit,
    };
  }

  /**
   * 单事务执行标记：锁订单行 → 幂等回放 → 重跑闸 → 去程打标 → 回程放座+置空 →
   * 任务处理 / 工单 → hasReturnLeg 同步 → adjustments 留痕。
   *
   * ⚠ 金额四字段（unitPrice / amount / unitCostCny / totalCostCny）与 subtotal / total
   * 在本方法内**一个都不写**。改这里前先读上面「与取消航段的界线」。
   */
  private async _executeNoShow(
    targetOrderId: string,
    input: NoShowBody,
    actor: { userId: string; role: UserRole },
    split: { sourceOrderNumber: string; targetOrderNumber: string } | null,
  ): Promise<NoShowAudit> {
    return prisma.$transaction(async (tx) => {
      // 与改期 / 取消航段 / 超时 worker 同一把行锁 → 座位账严格串行。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${targetOrderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      // ── 0. 幂等回放：同 token 已标记过 → 原样回放，绝不二次放座、二次派工单 ──
      const flightRows = await tx.orderItem.findMany({
        where: { orderId: targetOrderId, kind: OrderItemKind.FLIGHT },
        select: { id: true, metadata: true },
      });
      // 认 token 的口径是「这张单的任一航段行**见过**这个 token」（含 legActionLog 与各 history）——
      // 只查当前快照上那一个 token 会漏掉「释放→恢复→再释放→再恢复」中间几轮被覆盖掉的 token，
      // 那几轮的延迟重试就会绕过回放二次放座。详见 collectLegActionTokens 的注释。
      const tokenLookup = hasSeenLegActionToken(flightRows, input.requestToken);
      if (tokenLookup.seen) {
        // ⚠ 回放前先比对**动作类型 + 关键入参**：同一个 token 换一份请求体（弹窗里改了
        //「同时释放回程」的勾选又点重试）、甚至拿去调另一个端点都是可能的。只按 token 命中
        // 就回成功，会让运营以为这次的勾选生效了 —— 实际上座位早按上一次的勾选处置完了，
        // 两边认知从此分叉且审计里看不出来。老数据没有指纹一律拒（fail-closed）。
        assertLegActionTokenReplay(
          tokenLookup,
          ['NO_SHOW', 'RELEASE'],
          noShowFingerprint(input),
        );
        // 回放一律回**当前状态**（不是当初那一轮的快照）：调用方要的是「这单现在是什么样」，
        // 而中间几轮的快照早已不代表现状。单号同样读真值（整单回放时 split 为 null，
        // 原来的 `split?.targetOrderNumber ?? ''` 会让审计与响应里的单号变成空串）。
        const current = await tx.order.findUniqueOrThrow({
          where: { id: targetOrderId },
          select: { orderNumber: true },
        });
        const markedOutboundRow =
          flightRows.find((row) => readJsonObject(row.metadata).noShow != null) ?? null;
        const releasedRow =
          flightRows.find((row) => readJsonObject(row.metadata).returnReleased != null) ?? null;
        const noShowSnap = readJsonObject(readJsonObject(markedOutboundRow?.metadata).noShow);
        // 有回程释放留痕就以它为准（它才是座位账的真值），否则回落到去程 noShow 快照里的下游结果。
        const snap = releasedRow
          ? readJsonObject(readJsonObject(releasedRow.metadata).returnReleased)
          : noShowSnap;
        return {
          orderNumber: current.orderNumber,
          outboundItemId: markedOutboundRow?.id ?? '',
          returnItemId:
            releasedRow?.id ??
            (typeof noShowSnap.returnItemId === 'string' ? noShowSnap.returnItemId : null),
          releasedSeats: Array.isArray(snap.releasedSeats)
            ? (snap.releasedSeats as NoShowAudit['releasedSeats'])
            : [],
          workOrderReminderId:
            typeof snap.workOrderReminderId === 'string' ? snap.workOrderReminderId : null,
          workOrderTitle: typeof snap.workOrderTitle === 'string' ? snap.workOrderTitle : null,
          split,
          replayed: true,
        } satisfies NoShowAudit;
      }

      // ── 1. 重跑准入闸（此刻订单里就是该被标记的那批人 → 不再传 passengerIds）──
      const { order, outboundItem, returnItem, returnTicketedCount, blockers, isRerelease } =
        await this._assessNoShow(tx, targetOrderId, undefined, input.releaseReturn);
      if (blockers.length > 0 || !outboundItem) {
        throw new BadRequestError(blockers.join('；') || '本单没有可标记 no-show 的去程航段。');
      }

      const now = new Date();
      const note = input.note?.trim() || null;
      const passengerIdList = order.passengers.map((p) => p.id);

      // ── 2. 回程处置（先做：工单 id / 放座明细要写进去程的 no-show 快照供回放）──
      const releasedSeats: NoShowAudit['releasedSeats'] = [];
      let workOrderReminderId: string | null = null;
      let workOrderTitle: string | null = null;
      const willRelease = input.releaseReturn && returnItem != null;
      // 本次动作的 legActionLog 条目：只落一条，落在**这次真正被改写的那一行**上
      //（释放 → 回程行；不释放/单程单 → 去程行）。回放扫的是全部航段行，落哪一行都找得到。
      const legAction = (): LegActionLogEntry => ({
        type: isRerelease ? 'RELEASE' : 'NO_SHOW',
        requestToken: input.requestToken,
        at: now.toISOString(),
        byUserId: actor.userId,
        seats: releasedSeats.reduce((n, r) => n + r.quantity, 0),
        // 关键入参指纹：同 token 换一份请求体重发时，回放守闸靠它认出「不是同一个请求」。
        fingerprint: noShowFingerprint(input),
      });

      if (willRelease && returnItem) {
        // 2a. 放座：按下单时的升舱拆座镜像各退各舱（与取消航段第 3 步同一 helper）。
        const retScheduleId = returnItem.flightScheduleId;
        const retCabin = returnItem.flightCabin;
        // fail-closed：有班次却没舱位 = 放不了座。旧写法在这里静默跳过放座、却照常置空班次
        // 并落释放快照 —— 座位一个没回库存，系统却认为释放过了（闸 5b2 已在准入段拦过一次，
        // 这里是并发改行的兜底：宁可整单回滚，也不留一条对不上账的「假释放」）。
        if (retScheduleId && !retCabin) {
          throw new BadRequestError(
            '回程航段缺舱位信息，无法释放座位；请先补全该航段的舱位等级后重试。',
          );
        }
        if (retScheduleId && retCabin) {
          const meta = readJsonObject(returnItem.metadata);
          const rawUpgrade =
            typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0;
          const seatSplit = computeBundleSeatSplit(retCabin, returnItem.quantity, rawUpgrade);
          // 严格版释放（放不出就整单回滚）：释放量与写进快照的 releasedSeats 必须恒等，
          // 否则恢复回程会照快照多占回来 —— 见 releaseSeatStrictWithinTx 的注释。
          await releaseSeatStrictWithinTx(tx, retScheduleId, 'BUSINESS', seatSplit.business);
          await releaseSeatStrictWithinTx(tx, retScheduleId, retCabin, seatSplit.sameCabin);
          if (seatSplit.business > 0) {
            releasedSeats.push({
              scheduleId: retScheduleId,
              cabin: 'BUSINESS',
              quantity: seatSplit.business,
            });
          }
          if (seatSplit.sameCabin > 0) {
            releasedSeats.push({
              scheduleId: retScheduleId,
              cabin: retCabin,
              quantity: seatSplit.sameCabin,
            });
          }
        }

        // 2b. 出票任务：未出票的关掉；已出票的**不动**，另派撤名单/退票工单。
        //     已 CONFIRMED 的记录是「票在航司那边真实存在」的事实，抹掉它等于丢账。
        if (returnTicketedCount > 0) {
          workOrderTitle = buildTicketWorkOrderTitle('撤名单/退票', order.orderNumber, '回程', returnItem);
          workOrderReminderId = await createTicketWorkOrder(tx, {
            orderId: targetOrderId,
            createdById: actor.userId,
            ruleKey: `NOSHOW_WITHDRAW:${returnItem.id}:${input.requestToken}`,
            title: workOrderTitle,
            body:
              `订单 ${order.orderNumber} 的客人去程 no-show，回程座位已释放回库存可继续销售。` +
              `该段有 ${returnTicketedCount} 条确认出票记录，请到航司/出票渠道撤名单或办理退票，` +
              '完成后把本条标记为已处理。（本操作不涉及退款，钱款处置另循财务流程。）' +
              (note ? `\n操作备注：${note}` : ''),
            at: now,
          });
        } else {
          await tx.fulfillmentTask.updateMany({
            where: {
              orderItemId: returnItem.id,
              type: FulfillmentType.FLIGHT_TICKETING,
              status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
            },
            data: { status: FulfillmentStatus.CANCELLED, completedAt: now },
          });
        }

        // 2c. 回程行「释放留痕」：班次置空（= 退出全站有效航段判定）+ 描述前缀 + 快照。
        //     金额与成本一律不动 —— 钱不动是本操作的第一口径。
        //     voidedAt 预留给「回程起飞后自动作废」的后续 job：它只需给这个快照补
        //     returnVoidedFinal，恢复端点见到即拒绝，不必再动表结构。
        const retMeta = readJsonObject(returnItem.metadata);
        // 释放→恢复→再释放可以反复发生：新快照覆盖 returnReleased（恢复端点只认最新那份），
        // 上一轮的整份快照压进 history，历史一条不丢。
        const priorRelease = readJsonObject(retMeta.returnReleased);
        const priorHistory = Array.isArray(priorRelease.history) ? priorRelease.history : [];
        const { history: _droppedHistory, ...priorWithoutHistory } = priorRelease;
        const releaseSnapshot = {
          at: now.toISOString(),
          byUserId: actor.userId,
          requestToken: input.requestToken,
          reason: 'NO_SHOW_OUTBOUND',
          originalDescription: stripReturnReleasedPrefix(returnItem.description),
          originalScheduleId: returnItem.flightScheduleId,
          originalCabin: returnItem.flightCabin,
          releasedSeats,
          ticketedAtRelease: returnTicketedCount,
          // 释放当时回程是不是「已开票」态 —— 下面第 4 步会把它清成未开（钱不动，清的只是进度标记），
          // 而恢复回程**不会自动翻回来**。记进快照，恢复预检才能如实提醒票务台重新标一次。
          // 老快照没有这个键 → 恢复预检读到 undefined，按「不确定」不提示（fail-open）。
          returnInvoicedAtRelease: order.returnInvoiced === true,
          workOrderReminderId,
          workOrderTitle,
          note,
          history: priorRelease.at != null ? [...priorHistory, priorWithoutHistory] : priorHistory,
        };
        await tx.orderItem.update({
          where: { id: returnItem.id },
          data: {
            description: `${RETURN_RELEASED_PREFIX}${stripReturnReleasedPrefix(returnItem.description)}`,
            flightScheduleId: null,
            metadata: {
              ...retMeta,
              returnReleased: releaseSnapshot,
              legActionLog: appendLegActionLog(retMeta, legAction()),
            } as Prisma.InputJsonValue,
          },
        });
      }

      // ── 3. 去程打 no-show 标（班次**不置空**：这段是真飞了的，得留在航段统计里）──
      const outMeta = readJsonObject(outboundItem.metadata);
      const noShowSnapshot = {
        at: now.toISOString(),
        byUserId: actor.userId,
        requestToken: input.requestToken,
        leg: 'OUTBOUND',
        source: 'MANUAL',
        // 航司 no-show 名单的日期锚点：按去程出发地当地日折算（同全站出发日口径）。
        listDate: outboundItem.flightSchedule?.departureTime
          ? localDateISO(
              outboundItem.flightSchedule.departureTime,
              outboundItem.flightSchedule.departureTz,
            )
          : null,
        passengerIds: passengerIdList,
        note,
        // 回放要用的下游结果（放在去程快照里，回放只读一行）。
        returnItemId: willRelease && returnItem ? returnItem.id : null,
        returnReleased: willRelease,
        releasedSeats,
        workOrderReminderId,
        workOrderTitle,
      };
      // 「再释放一次回程」不重写 noShow 快照：首次 no-show 的时间/操作人是事实，覆盖掉就查不回来了。
      // 只往 releaseHistory 追加一条本次释放的记录（快照形状与首刷同构，供事后逐次对账）。
      const priorNoShow = readJsonObject(outMeta.noShow);
      const priorReleaseHistory = Array.isArray(priorNoShow.releaseHistory)
        ? priorNoShow.releaseHistory
        : [];
      const nextNoShowMeta = isRerelease
        ? {
            ...priorNoShow,
            releaseHistory: [
              ...priorReleaseHistory,
              {
                at: now.toISOString(),
                byUserId: actor.userId,
                requestToken: input.requestToken,
                returnItemId: willRelease && returnItem ? returnItem.id : null,
                releasedSeats,
                workOrderReminderId,
                workOrderTitle,
                note,
              },
            ],
          }
        : noShowSnapshot;
      await tx.orderItem.update({
        where: { id: outboundItem.id },
        data: {
          // 先剥掉新旧两种写法再加前缀：老数据带半角旧前缀时不能叠成「【去程未登机】[去程 no-show] …」。
          description: `${NO_SHOW_PREFIX}${stripNoShowPrefix(outboundItem.description)}`,
          metadata: {
            ...outMeta,
            noShow: nextNoShowMeta,
            // 没释放回程（单程单 / 未勾选）时本次动作没有别的行可落，token 记在去程行上，
            // 否则这一轮的重试永远扫不到 token，会被当成新请求重跑一遍。
            ...(willRelease ? {} : { legActionLog: appendLegActionLog(outMeta, legAction()) }),
          } as Prisma.InputJsonValue,
        },
      });

      // ── 4. 物化列同步 + 开票位归零 + 留痕流水（金额恒 0：本操作不动钱）──
      await syncOrderHasReturnLeg(tx, targetOrderId);
      await syncOrderLegFlag(tx, targetOrderId);

      // 回程座位放掉了 → 回程开票位必须跟着清（口径同取消航段步骤 9）。
      // 不清的话那个「已开票」的位子会变成幽灵：班次开票额度按被标记订单的乘客数算，
      // 这一段明明没人飞了却还占着额度，恢复回程时会把班次开票上限撑爆。
      // 钱一分没动，所以清的只是**进度标记**，不是发票本身 —— 恢复时不自动翻回，由票务台重标。
      if (willRelease) {
        await tx.order.update({ where: { id: targetOrderId }, data: { returnInvoiced: false } });
      }

      // 再释放：去程 no-show 早已留过痕，本次只补一条释放流水，不再重复记一条 no-show。
      let log: Prisma.JsonValue = order.adjustments;
      if (!isRerelease) {
        log = appendAdjustment(log, {
          type: 'NO_SHOW_OUTBOUND',
          label: '去程 no-show（钱款不动）',
          amountCny: 0,
          at: now.toISOString(),
          by: actor.userId,
          note: note ?? undefined,
        }) as Prisma.JsonValue;
      }
      if (willRelease) {
        log = appendAdjustment(log as Prisma.JsonValue, {
          type: 'RETURN_LEG_RELEASED',
          label: `回程座位释放回库存（${releasedSeats.reduce((n, r) => n + r.quantity, 0)} 座，钱款不动）`,
          amountCny: 0,
          at: now.toISOString(),
          by: actor.userId,
          note: note ?? undefined,
        }) as Prisma.JsonValue;
      }
      await tx.order.update({
        where: { id: targetOrderId },
        data: { adjustments: log as Prisma.InputJsonValue },
      });

      return {
        orderNumber: order.orderNumber,
        outboundItemId: outboundItem.id,
        returnItemId: willRelease && returnItem ? returnItem.id : null,
        releasedSeats,
        workOrderReminderId,
        workOrderTitle,
        split,
        replayed: false,
      } satisfies NoShowAudit;
    });
  }

  /** 恢复回程的准入评估（preview 与 execute 共用）。 */
  private async _assessRestoreReturnLeg(
    db: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{
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
    const order = await loadOrderForLegCancel(db, orderId);
    if (!order) throw new NotFoundError('订单不存在');

    const blockers: string[] = [];
    if (order.deletedAt) {
      blockers.push('订单在回收站（已软删），不能恢复回程；如需操作请先恢复订单。');
    } else if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      blockers.push(
        `订单当前状态（${zhStatus(order.status)}）不能恢复回程：仅占座中的有效订单可操作。`,
      );
    }

    // 「当前是不是还处于已释放态」走统一口径（resolveReturnReleaseState）：
    // 恢复时 returnReleased 快照是**保留不删**的，只看它存在就会把「释放过、后来已恢复」
    // 误判成「现在还释放着」，于是再点一次恢复会照快照重新占一遍座（凭空多占）。
    const releaseState = resolveReturnReleaseState(order.items);
    const releasedItem = releaseState.item;
    const snapshot = releasedItem
      ? (readJsonObject(readJsonObject(releasedItem.metadata).returnReleased) as ReturnReleasedSnapshot)
      : null;

    if (!releasedItem || !snapshot) {
      blockers.push('本单没有被 no-show 释放的回程航段，无需恢复。');
    } else if (readJsonObject(releasedItem.metadata).returnLegCancelled != null) {
      // 取消航段是**按取消政策收过手续费、应收已经降下来**的资金动作，与 no-show 释放不是一回事。
      // 恢复它等于把一段已经退掉的行程凭空占回来：座位有了、钱却早按取消结清了。
      blockers.push(
        '该回程已按取消政策取消，不能恢复；如需重新安排回程，请按新价录一段回程航段。',
      );
    } else if (releaseState.voidedFinal) {
      blockers.push('该回程已过期作废（原班次已飞完），无法恢复。');
    } else if (releasedItem.flightScheduleId != null) {
      blockers.push('该回程当前已占着班次，无需恢复。');
    } else if (!releaseState.releasedNow) {
      blockers.push('该回程已恢复过，当前不处于「已释放」状态，无需再次恢复。');
    }

    const scheduleId = typeof snapshot?.originalScheduleId === 'string' ? snapshot.originalScheduleId : null;
    const releasedSeats = Array.isArray(snapshot?.releasedSeats)
      ? (snapshot!.releasedSeats as Array<{ cabin: CabinClass; quantity: number }>)
      : [];

    let departed = false;
    const seatNeeds: RestoreSeatNeed[] = [];
    if (releasedItem && snapshot && blockers.length === 0) {
      if (!scheduleId) {
        blockers.push('释放快照里没有原班次，无法自动恢复，请人工重录回程航段。');
      } else if (releasedSeats.length === 0) {
        // 「放几座就恢复几座」全靠这份逐舱明细。明细为空（老快照 / 释放时该行没有班次或舱位）
        // 时继续往下走，会一座都不占地把行写回班次 —— 订单显示回程回来了，FlightSeatClass.sold
        // 却没有对应扣减，成了幽灵持有：这几个人的座位在余位里被算成可卖，直接超卖。
        // 与其静默占 0 座，不如在这里拒掉，让票务人工重录一段回程（金额不动，只补航段）。
        blockers.push('释放快照里没有座位明细，无法自动恢复，请人工重录回程航段。');
      } else {
        const schedule = await db.flightSchedule.findUnique({
          where: { id: scheduleId },
          // checkinCloseMinutes：恢复的时间锚点同样是关柜时刻（见 lib/checkin-close.ts）。
          select: { id: true, departureTime: true, checkinCloseMinutes: true },
        });
        if (!schedule) {
          blockers.push('原班次已不存在（可能已被删除），无法恢复，请人工重录回程航段。');
        } else if (isCheckinClosed(schedule.departureTime, schedule.checkinCloseMinutes)) {
          // 恢复 = 把座位重新占回原班次。柜台已关，占回来的人也上不去这班飞机 ——
          // 占的是一个交付不了的座位，还把这一舱的余位平白吃掉一份。
          departed = true;
          blockers.push('原班次已关柜，无法恢复；关柜后占回的座位没人能值机。');
        } else {
          for (const need of releasedSeats) {
            const seatState = await cabinSeatStateWithinTx(db, scheduleId, need.cabin);
            if (seatState == null) {
              blockers.push(`原班次已没有 ${need.cabin} 舱位配置，无法恢复，请先在航班维护里补齐。`);
              continue;
            }
            seatNeeds.push({ cabin: need.cabin, quantity: need.quantity, ...seatState });
          }
        }
      }
    }

    // 增量 / 累计两个数各司其职（见 computeOversellDelta）；available 取各舱位余位的最小值
    //（前端只展示一个数）。上限判定用**累计**：班次已经被卖穿到上限之外时，再放行 1 座也是加码。
    const { detail: oversellDetail, oversellBy, oversoldAfter } = computeOversellDelta(seatNeeds);
    const available = seatNeeds.length > 0 ? Math.min(...seatNeeds.map((s) => s.available)) : 0;
    // 「要不要运营二次确认」看的是**余位缺口**（available 口径，含他人锁位与占位单余座），
    // 不是超售座数：一班还有物理空位、只是被别人锁位占满时，硬抢过来同样要有人拍板 ——
    // 虽然 sold 没超 capacity（oversellBy=0，不触上限），但抢的确实是别人锁着的位子。
    const seatShortfall = seatNeeds.reduce(
      (n, s) => n + Math.max(0, s.quantity - s.available),
      0,
    );
    // 缺口里由**他人软预留**兜着的那部分（锁位 / 占位单余座）：硬占等于把别人锁着的位子抢走。
    // 与 oversellBy 是两个数：一班还有物理空位、只是被锁满时 oversellBy=0 而这里 > 0。
    const reservedConflict = seatNeeds.reduce((n, s) => n + computeDisplacedReserved(s), 0);
    const maxOversell = env.FLIGHT_NOSHOW_MAX_OVERSELL_SEATS;
    if (oversoldAfter > maxOversell) {
      blockers.push(
        `超售将超过上限 ${maxOversell} 座（恢复后该班这些舱累计超出 ${oversoldAfter} 座，` +
          `本次新增 ${oversellBy} 座）。请先向航司加位、或联系管理员调整上限后再恢复。`,
      );
    }

    return {
      order,
      releasedItem,
      snapshot,
      seatNeeds,
      blockers,
      available,
      oversellBy,
      seatShortfall,
      reservedConflict,
      oversoldAfter,
      oversellDetail,
      departed,
      scheduleId,
      releasedSeatTotal: releasedSeats.reduce((n, s) => n + (Number(s.quantity) || 0), 0),
    };
  }

  /** 恢复回程 · 预检（只读）：POST /orders/:id/restore-return-leg/preview。 */
  async previewRestoreReturnLeg(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<RestoreReturnLegPreview> {
    if (!actorCan(actor, 'orders.cancel_leg')) {
      throw new ForbiddenError('仅运营/管理员可恢复回程');
    }
    const assessed = await this._assessRestoreReturnLeg(prisma, orderId);
    const item = assessed.releasedItem;
    // ── 非阻断提示：恢复之后票务台还要动手做的事 ───────────────────────────────
    // 这两件事系统都不会自己补回来，不提示的话就成了「恢复完了以为没事了」的静默缺口。
    const warnings: string[] = [];
    if (assessed.snapshot?.returnInvoicedAtRelease === true) {
      warnings.push(
        '释放时已把回程开票位清成未开（钱与发票不受影响，清的只是进度标记）。' +
          '恢复并重新出票后请票务台重新标一次「已开票」。',
      );
    }
    if (Number(assessed.snapshot?.ticketedAtRelease ?? 0) > 0) {
      warnings.push(
        '释放时该段已出票、给票务派过撤名单/退票工单：恢复后会再派一条「重新上名单」工单，' +
          '请票务台核对该段名单与票的最新状态。',
      );
    }
    const schedule =
      assessed.scheduleId != null
        ? await prisma.flightSchedule.findUnique({
            where: { id: assessed.scheduleId },
            select: {
              departureTime: true,
              departureTz: true,
              flight: { select: { flightNumber: true } },
            },
          })
        : null;
    return {
      eligible: assessed.blockers.length === 0,
      blockers: assessed.blockers,
      warnings,
      original:
        item && assessed.scheduleId
          ? {
              orderItemId: item.id,
              flightNumber: schedule?.flight?.flightNumber ?? null,
              departDate: schedule?.departureTime
                ? localDateISO(schedule.departureTime, schedule.departureTz)
                : null,
              cabin: item.flightCabin,
              // 座数取释放快照里逐舱张数之和，而不是行 quantity —— 升舱拆座时两者不等
              //（3 人行里 1 人升商务 → 放的是「经济 2 + 商务 1」，回占也是这 3 座）。
              // 用 quantity 展示会与实际占回数对不上，运营核余位时白吵一架。
              quantity: assessed.releasedSeatTotal,
              scheduleId: assessed.scheduleId,
            }
          : null,
      available: assessed.available,
      // 口径是**余位缺口**而不是超售座数：被别人锁位/占位单占满时 sold 没超 capacity
      //（oversellBy=0、不触上限），但抢的是别人锁着的位子，同样要运营点头。
      // 前端据此决定要不要带 allowOversell；「超售 N 座」的措辞另看 oversellBy。
      needsOversell: assessed.seatShortfall > 0,
      // 本次会占用他人临时锁位/占位的座数。前端据此在二次确认里说清「将占用他人临时锁位/占位 N 座」——
      // 只报「超售 N 座」会让运营以为没超售就零风险，而被抢的那张锁位单下一秒下单就会失败。
      reservedConflict: assessed.reservedConflict,
      oversellBy: assessed.oversellBy,
      oversoldAfter: assessed.oversoldAfter,
      oversellDetail: assessed.oversellDetail,
      maxOversell: env.FLIGHT_NOSHOW_MAX_OVERSELL_SEATS,
      departed: assessed.departed,
    };
  }

  /**
   * 恢复回程 · 执行：POST /orders/:id/restore-return-leg。
   *
   * 有座 → takeSeatWithinTx（CAS 防超售）；没座且 allowOversell → FOR UPDATE 后直加 sold
   * （余位变负 = 超售，全站余位本来就不夹 0）；没座且未确认 → 409 让前端弹二次确认。
   * 座位数照释放快照回填，放几座恢复几座。
   */
  async restoreReturnLeg(
    orderId: string,
    input: RestoreReturnLegBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{ order: ReturnType<typeof serializeOrder>; audit: RestoreReturnLegAudit }> {
    if (!actorCan(actor, 'orders.cancel_leg')) {
      throw new ForbiddenError('仅运营/管理员可恢复回程');
    }

    const audit = await prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      // ── 0. 幂等回放：同 token 已恢复过 → 原样回放，绝不二次占座 ──
      const flightRows = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT },
        select: { id: true, metadata: true },
      });
      // 与 no-show 同一套口径：认「这张单的任一航段行**见过**这个 token」，不是只认当前快照上那一个。
      // 只认当前快照会漏掉「释放→恢复→再释放→再恢复」中被顶掉的中间几轮 token，
      // 那几轮的延迟重试会绕过回放二次占座（returnRestored 是覆盖写，连 history 都没有）。
      const tokenLookup = hasSeenLegActionToken(flightRows, input.requestToken);
      if (tokenLookup.seen) {
        // ⚠ 本端点**不比对 allowOversell**（指纹里刻意不含它）：allowOversell 只是「没座时
        // 要不要继续」的确认位，它不改变恢复的结果 —— 座位照释放快照原样占回来，占几座只由
        // 快照决定。两次请求这个位不同，落库结果完全一致，拦下来只会让运营看到一条莫名其妙的报错。
        // 但**动作类型**必须是 RESTORE：这个 token 若是取消航段/no-show 用过的，回放会静默
        // 回一个「恢复成功」，而这单根本没被恢复过。老数据没指纹一律拒（fail-closed）。
        assertLegActionTokenReplay(tokenLookup, ['RESTORE'], EMPTY_LEG_ACTION_FINGERPRINT);
        // 回放一律回**当前状态**：中间某一轮的快照早已不代表这单现在的样子。
        const restoredRow =
          flightRows.find((row) => readJsonObject(row.metadata).returnRestored != null) ?? null;
        const snap = readJsonObject(readJsonObject(restoredRow?.metadata).returnRestored);
        const current = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { orderNumber: true },
        });
        return {
          orderNumber: current.orderNumber,
          returnItemId: restoredRow?.id ?? '',
          scheduleId: typeof snap.toScheduleId === 'string' ? snap.toScheduleId : '',
          cabin: (typeof snap.cabin === 'string' ? snap.cabin : null) as CabinClass | null,
          quantity: typeof snap.seats === 'number' ? snap.seats : 0,
          oversold: snap.oversold === true,
          oversoldBy: typeof snap.oversoldBy === 'number' ? snap.oversoldBy : 0,
          scheduleOversoldAfter:
            typeof snap.scheduleOversoldAfter === 'number' ? snap.scheduleOversoldAfter : 0,
          flightNumber: typeof snap.flightNumber === 'string' ? snap.flightNumber : null,
          departDate: typeof snap.departDate === 'string' ? snap.departDate : null,
          // 重放不重新派工单（createTicketWorkOrder 按 ruleKey 幂等，重放这条分支根本不会
          // 跑到第 6 步），这两个字段在重放场景没有对应历史值可读，且下面调用方只在
          // !replayed 时才用它们决定推不推企业微信——重放恒为 null 不影响任何判断。
          workOrderReminderId: null,
          workOrderTitle: null,
          replayed: true,
        } satisfies RestoreReturnLegAudit;
      }

      // ── 1. 重跑准入闸 ──
      const assessed = await this._assessRestoreReturnLeg(tx, orderId);
      const item = assessed.releasedItem;
      const scheduleId = assessed.scheduleId;
      if (assessed.blockers.length > 0 || !item || !scheduleId) {
        throw new BadRequestError(assessed.blockers.join('；') || '本单没有可恢复的回程航段。');
      }

      // ── 2. 没座必须先确认（稳定 code，前端据此弹二次确认，不靠中文文案匹配）──
      // 判据是**余位缺口**（含他人锁位与占位单余座），不是超售座数：口径同预检 needsOversell。
      if (assessed.seatShortfall > 0 && input.allowOversell !== true) {
        throw new AppError(
          `原班次余位不足：还差 ${assessed.seatShortfall} 座。确认后可继续恢复。`,
          {
            statusCode: 409,
            code: 'OVERSELL_CONFIRMATION_REQUIRED',
            details: {
              available: assessed.available,
              oversellBy: assessed.oversellBy,
              oversoldAfter: assessed.oversoldAfter,
            },
          },
        );
      }

      // ── 3. 锁舱位行 → 锁内重算缺口与上限 → 占座 ─────────────────────────────
      //
      // ⚠ 上限判定必须在**拿到舱位行锁之后**重算：闸里那份余位是锁外读的，从预检到这里的
      // 几十毫秒内并发下单可以把余位吃穿。旧写法拿锁前判上限、拿锁后无条件 `sold += qty`，
      // 于是「上限 5 座」在并发下会被突破到任意深度 —— 上限形同虚设。
      // 这里先把本次要动的每个舱位行 FOR UPDATE 锁住（与 oversellSeatWithinTx 同一把锁），
      // 再重读 capacity/sold/locked/held 算真实缺口，超限就地 409 回滚。
      const lockedNeeds: RestoreSeatNeed[] = [];
      for (const need of assessed.seatNeeds) {
        await lockSeatClassWithinTx(tx, scheduleId, need.cabin);
        const seatState = await cabinSeatStateWithinTx(tx, scheduleId, need.cabin);
        if (seatState == null) {
          throw new ConflictError(`原班次的 ${need.cabin} 舱位不存在，无法恢复回程座位。`);
        }
        lockedNeeds.push({ cabin: need.cabin, quantity: need.quantity, ...seatState });
      }
      // 增量（本次多卖几座）与累计（恢复后一共超几座）分开算，口径见 computeOversellDelta。
      const {
        detail: oversellDetail,
        oversellBy: lockedOversellBy,
        oversoldAfter: lockedOversoldAfter,
      } = computeOversellDelta(lockedNeeds);
      const maxOversell = env.FLIGHT_NOSHOW_MAX_OVERSELL_SEATS;
      // 上限比的是**累计**：班次早被别的动作卖穿到上限之外时，再放行 1 座也是继续加码。
      if (lockedOversoldAfter > maxOversell) {
        throw new AppError(
          `原班次余位在本次操作期间被占用：恢复后该班这些舱将累计超出 ${lockedOversoldAfter} 座` +
            `（本次新增 ${lockedOversellBy} 座），已超过上限 ${maxOversell} 座。` +
            '请先向航司加位、或联系管理员调整上限后重试。',
          {
            statusCode: 409,
            code: 'OVERSELL_LIMIT_EXCEEDED',
            details: {
              oversellBy: lockedOversellBy,
              oversoldAfter: lockedOversoldAfter,
              maxOversell,
            },
          },
        );
      }
      // 锁前有座、锁后变没座 → 同样要拿到运营确认才继续（fail-closed，不静默抢座）。
      const lockedShortfall = lockedNeeds.reduce(
        (n, need) => n + Math.max(0, need.quantity - need.available),
        0,
      );
      if (lockedShortfall > 0 && input.allowOversell !== true) {
        throw new AppError(
          `原班次余位不足：还差 ${lockedShortfall} 座。确认后可继续恢复。`,
          {
            statusCode: 409,
            code: 'OVERSELL_CONFIRMATION_REQUIRED',
            details: {
              available: Math.min(...lockedNeeds.map((s) => s.available)),
              oversellBy: lockedOversellBy,
              oversoldAfter: lockedOversoldAfter,
            },
          },
        );
      }

      // ── 占座三档（每一档的留痕责任都不一样，绝不能合并成「有座 CAS / 没座直加」两档）──
      //   (a) available ≥ quantity  —— 真有富余位：走 CAS 占座，零留痕。
      //   (b) 缺口全部或部分来自**他人软预留**（锁位 / 占位单余座）而 sold + qty ≤ capacity ——
      //       物理上不超售，但抢的是别人锁着的位子：仍需 allowOversell 确认（上面已闸），
      //       走直加，并且**必须**记 CRITICAL 审计。旧写法这里 oversellBy = 0，于是既没有
      //       二次确认之外的任何留痕、也不进风控视野 —— 对面那张锁位单下单失败时查无此案。
      //   (c) sold + quantity > capacity —— 真·物理超售：既有的 RESTORE_RETURN_LEG_OVERSOLD
      //       CRITICAL 审计，after 里同时带上被挤掉的软预留。
      // 上限判定始终只看物理累计 oversoldAfter（软预留不是卖出去的座，见 computeOversellDelta）。
      const displacedDetail: DisplacedReservationDetail[] = lockedNeeds.map((need, idx) => ({
        cabin: need.cabin,
        quantity: need.quantity,
        displacedReserved: computeDisplacedReserved(need),
        physicalIncrement: oversellDetail[idx]?.increment ?? 0,
      }));
      const displacedReservedTotal = displacedDetail.reduce((n, d) => n + d.displacedReserved, 0);

      for (const need of lockedNeeds) {
        if (need.available >= need.quantity) {
          await takeSeatWithinTx(tx, scheduleId, need.cabin, need.quantity, null);
        } else {
          // (b) 与 (c) 落到同一句直加：CAS 在这里必然失败（余位不够），差别只在留痕等级。
          await oversellSeatWithinTx(tx, scheduleId, need.cabin, need.quantity);
        }
      }
      const totalSeats = lockedNeeds.reduce((n, s) => n + s.quantity, 0);
      const oversellBy = lockedOversellBy;
      // 占完之后这些舱一共超了几座（累计，多舱求和）。数值直接取锁内算好的 after —— 舱位行已被
      // FOR UPDATE 锁住、本事务是唯一写者，`after = before + quantity` 就是真值；再查一次库
      // 反而要与刚写下的 sold 重新对齐，多一次往返还多一处漂移点。
      const scheduleOversoldAfter = lockedOversoldAfter;
      const restoredSchedule = await tx.flightSchedule.findUnique({
        where: { id: scheduleId },
        select: {
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true } },
        },
      });
      const restoredFlightNumber = restoredSchedule?.flight?.flightNumber ?? null;
      const restoredDepartDate = restoredSchedule?.departureTime
        ? localDateISO(restoredSchedule.departureTime, restoredSchedule.departureTz)
        : null;

      const now = new Date();
      const note = input.note?.trim() || null;

      // ── 4. 回程行写回班次 + 去掉释放前缀 + 落 returnRestored 快照 ────────────
      // returnReleased **保留不删**：释放→恢复可以反复发生，历史全留着才查得清。
      const meta = readJsonObject(item.metadata);
      const restoredSnapshot = {
        at: now.toISOString(),
        byUserId: actor.userId,
        requestToken: input.requestToken,
        toScheduleId: scheduleId,
        cabin: item.flightCabin,
        seats: totalSeats,
        // 逐舱三值（before/after/increment）：事后要能逐舱复盘「这次到底给哪个舱加了几座超售」。
        seatDetail: oversellDetail,
        // 本次挤掉了几座他人软预留（逐舱 + 合计）：物理没超售的那一档，全部真相都在这里。
        displacedReserved: displacedReservedTotal,
        displacedDetail,
        oversold: oversellBy > 0,
        /** 本次**新增**的超售座数。 */
        oversoldBy: oversellBy,
        // 恢复后这些舱的累计超售座数（0 = 没超）；审计与风控看的是这个数，不是本次增量。
        scheduleOversoldAfter,
        flightNumber: restoredFlightNumber,
        departDate: restoredDepartDate,
        note,
      };
      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          description: stripReturnReleasedPrefix(item.description),
          flightScheduleId: scheduleId,
          metadata: {
            ...meta,
            returnRestored: restoredSnapshot,
            legActionLog: appendLegActionLog(meta, {
              type: 'RESTORE',
              requestToken: input.requestToken,
              at: now.toISOString(),
              byUserId: actor.userId,
              seats: totalSeats,
              oversold: oversellBy > 0,
              // 超售座数与挤掉的软预留**逐轮**记在流水里：returnRestored 快照是覆盖写，
              // 一行反复释放→恢复几轮之后只剩最后一轮，报表照快照统计会把中间几轮全漏掉。
              oversoldBy: oversellBy,
              displacedReserved: displacedReservedTotal,
              // 恢复的结果只由释放快照决定，请求体里没有能改结果的字段 → 恒定空指纹。
              fingerprint: EMPTY_LEG_ACTION_FINGERPRINT,
            }),
          } as Prisma.InputJsonValue,
        },
      });

      // ── 4b. 超售放行的 CRITICAL 审计 —— **必须与占座同一事务** ────────────────
      //
      // 超售不是「做完了顺手留个痕」，审计本身就是放行条件：座位真的被卖穿了，
      // 审计要是没写成而占座写成了，事后根本查不出是谁放的行、放了几座。
      // 路由层的 writeAudit 是 fire-and-forget（异步、失败只打日志），落不落库不由这个事务决定；
      // 所以超售这一条改在事务内写，要么都成、要么都回滚。非超售的普通恢复仍由路由层记 WARNING。
      if (oversellBy > 0) {
        const cabinsZh = oversellDetail
          .map((d) => CABIN_ZH_LABEL[d.cabin] ?? d.cabin)
          .join('/');
        await writeAuditWithinTx(tx, {
          actor: { userId: actor.userId, role: actor.role },
          action: 'RESTORE_RETURN_LEG_OVERSOLD',
          targetType: AuditTargetType.ORDER,
          targetId: orderId,
          // 一眼看出「是哪一班、这班被卖穿了多少座、本次加了几座、上限多少」，不必再去翻班次。
          targetLabel:
            `${assessed.order.orderNumber} · 超售放行（${restoredFlightNumber ?? '航班未知'} ` +
            `${restoredDepartDate ?? '日期未知'} ${cabinsZh} 超出 ${scheduleOversoldAfter} 座` +
            `（本次 +${oversellBy}，上限 ${maxOversell}））`,
          after: {
            returnItemId: item.id,
            scheduleId,
            flightNumber: restoredFlightNumber,
            departDate: restoredDepartDate,
            cabin: item.flightCabin,
            quantity: totalSeats,
            oversold: true,
            /** 本次新增的超售座数。 */
            oversoldBy: oversellBy,
            /** 恢复后这些舱的累计超售座数。 */
            scheduleOversoldAfter,
            maxOversell,
            /** 逐舱 before/after/increment，事后逐舱对账用。 */
            seatDetail: oversellDetail,
            /** 这次超售里有几座是从他人锁位/占位单手里抢来的（逐舱明细见 displacedDetail）。 */
            displacedReserved: displacedReservedTotal,
            displacedDetail,
            note,
            replayed: false,
          },
          severity: AuditSeverity.CRITICAL,
        });
      } else if (displacedReservedTotal > 0) {
        // ── 4c. 物理没超售、但挤掉了他人软预留 —— 同样 CRITICAL，同样**必须与占座同一事务** ──
        //
        // 这一档旧写法完全没有留痕：sold 没超 capacity，超售审计不触发，运营那边只看到一句
        //「余位不足，确认后继续」就点了确认。对面那张 ACTIVE 锁位 / 占位单的座位被悄悄抢走，
        // 等他们下单失败来问，审计里查不到任何一条记录说明是谁、什么时候、抢了几座。
        // 锁位/占位记录本身**不动**（不撤销、不改状态）：它们该怎么过期就怎么过期，
        // 这里只如实记下「这一次恢复占用了它们预留的位子」。
        const cabinsZh = displacedDetail
          .filter((d) => d.displacedReserved > 0)
          .map((d) => `${CABIN_ZH_LABEL[d.cabin] ?? d.cabin} ${d.displacedReserved} 座`)
          .join('、');
        await writeAuditWithinTx(tx, {
          actor: { userId: actor.userId, role: actor.role },
          action: 'RESTORE_RETURN_LEG_DISPLACED_RESERVATION',
          targetType: AuditTargetType.ORDER,
          targetId: orderId,
          targetLabel:
            `${assessed.order.orderNumber} · 占用他人临时锁位/占位（` +
            `${restoredFlightNumber ?? '航班未知'} ${restoredDepartDate ?? '日期未知'} ${cabinsZh}）`,
          after: {
            returnItemId: item.id,
            scheduleId,
            flightNumber: restoredFlightNumber,
            departDate: restoredDepartDate,
            cabin: item.flightCabin,
            quantity: totalSeats,
            /** 挤掉的软预留座数（他人 ACTIVE 锁位 + 占位单余座）。 */
            displacedReserved: displacedReservedTotal,
            /** 逐舱 quantity / displacedReserved / physicalIncrement。 */
            displacedDetail,
            /** 物理超售为 0 —— 这一档的风险不在超售，而在抢了别人预留的位子。 */
            oversold: false,
            oversoldBy: 0,
            scheduleOversoldAfter,
            note,
            replayed: false,
          },
          severity: AuditSeverity.CRITICAL,
        });
      }

      // ── 5. 出票任务复活：之前被关掉的重开为 PENDING；一条都没有才新建 ──────────
      // createTasksForOrder 见「已有任何任务就跳过」，CANCELLED 也算已有 → 不能靠它复活。
      const reopened = await tx.fulfillmentTask.updateMany({
        where: {
          orderItemId: item.id,
          type: FulfillmentType.FLIGHT_TICKETING,
          status: FulfillmentStatus.CANCELLED,
        },
        data: { status: FulfillmentStatus.PENDING, completedAt: null },
      });
      if (reopened.count === 0) {
        const existing = await tx.fulfillmentTask.count({
          where: { orderItemId: item.id, type: FulfillmentType.FLIGHT_TICKETING },
        });
        if (existing === 0) {
          await tx.fulfillmentTask.create({
            data: {
              orderItemId: item.id,
              type: FulfillmentType.FLIGHT_TICKETING,
              status: FulfillmentStatus.PENDING,
            },
          });
        }
      }

      // ── 6. 释放时已出票（派过撤名单工单）→ 再派一条「重新上名单」工单 ──────────
      const ticketedAtRelease = Number(assessed.snapshot?.ticketedAtRelease ?? 0);
      let relistWorkOrderReminderId: string | null = null;
      let relistWorkOrderTitle: string | null = null;
      if (ticketedAtRelease > 0) {
        relistWorkOrderTitle = buildTicketWorkOrderTitle('重新上名单', assessed.order.orderNumber, '回程', item);
        relistWorkOrderReminderId = await createTicketWorkOrder(tx, {
          orderId,
          createdById: actor.userId,
          ruleKey: `NOSHOW_RELIST:${item.id}:${input.requestToken}`,
          title: relistWorkOrderTitle,
          body:
            `订单 ${assessed.order.orderNumber} 的回程已恢复到原班次` +
            `（${totalSeats} 座${oversellBy > 0 ? `，其中 ${oversellBy} 座为超售` : ''}）。` +
            '此前因 no-show 释放时曾派过撤名单/退票工单，请核对该段名单与票的最新状态，' +
            '需要重新上名单/重新出票的请一并处理。' +
            (note ? `\n操作备注：${note}` : ''),
          at: now,
        });
      }

      // ── 6b. 待办收口：这一行的「回程已释放」提醒 + 未处理的撤名单工单 ──────────────
      //
      // 不收口的后果与作废那条一模一样：待办永远催下去，运营还会照旧条去点「恢复回程」，
      // 而这一段已经恢复完了。写法照 voidReleasedReturnLegWithinTx，只是结论换成「已恢复」。
      const releasedAtIso = readJsonObject(meta.returnReleased).at;
      if (typeof releasedAtIso === 'string' && releasedAtIso !== '') {
        await tx.operationalReminder.updateMany({
          where: {
            ruleKey: { in: noShowReleasedReminderRuleKeys(item.id, releasedAtIso) },
            status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] },
          },
          data: {
            status: ReminderStatus.DONE,
            resolvedAt: now,
            resolvedNote: '回程已恢复到原班次，本条收口。',
          },
        });
      }
      // 释放时派的「撤名单/退票」工单若还没人处理，这一刀已经作废了 —— 名单不用撤了，
      // 要办的是上面步骤 6 新派的「重新上名单」。置 SKIPPED 而不是 DONE：这活并没有做完，
      // 只是被本次恢复接手了，报表上不该记成一条已完成的工单。
      await tx.operationalReminder.updateMany({
        where: {
          ruleKey: { startsWith: `NOSHOW_WITHDRAW:${item.id}:` },
          status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] },
        },
        data: {
          status: ReminderStatus.SKIPPED,
          resolvedAt: now,
          resolvedNote: '已由本次恢复接手，改派重新上名单。',
        },
      });

      // ── 7. 物化列同步 + 留痕流水（金额恒 0）──
      await syncOrderHasReturnLeg(tx, orderId);
      await syncOrderLegFlag(tx, orderId);
      const log = appendAdjustment(assessed.order.adjustments, {
        type: 'RETURN_LEG_RESTORED',
        label:
          `回程恢复到原班次（${totalSeats} 座` +
          `${oversellBy > 0 ? `，超售 ${oversellBy} 座` : ''}，钱款不动）`,
        amountCny: 0,
        at: now.toISOString(),
        by: actor.userId,
        note: note ?? undefined,
      });
      await tx.order.update({ where: { id: orderId }, data: { adjustments: log } });

      return {
        orderNumber: assessed.order.orderNumber,
        returnItemId: item.id,
        scheduleId,
        cabin: item.flightCabin,
        quantity: totalSeats,
        oversold: oversellBy > 0,
        oversoldBy: oversellBy,
        scheduleOversoldAfter,
        flightNumber: restoredFlightNumber,
        departDate: restoredDepartDate,
        workOrderReminderId: relistWorkOrderReminderId,
        workOrderTitle: relistWorkOrderTitle,
        replayed: false,
      } satisfies RestoreReturnLegAudit;
    });

    // 事务已提交：这里才 fire-and-forget 推企业微信，绝不在事务内发 HTTP。
    if (!audit.replayed && audit.workOrderReminderId) {
      void notifyWorkOrderCreatedToWecom(audit.orderNumber, audit.workOrderTitle);
    }

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return { order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)), audit };
  }

  // ── 回程起飞后作废（终态收口）────────────────────────────────────────────────
  //
  // 「已释放」不是终态：去程 no-show 把回程座位放回库存后，这一行会一直停在已释放态等人处置。
  // 客人要飞就点「恢复回程」；不飞的话，原班次飞走那一刻恢复窗口就关了，而这一行还挂在单上 ——
  // 提醒规则会一直催（起飞后换成「请确认作废」那一条），没有终态就永远催不完。
  //
  // 作废**只是打一个终态标**：不动座位（早在释放时就还回库存了）、不动一分钱
  //（no-show 全程钱不动，要退钱走退款流程）、不动开票位。它唯一的作用是让这一行走到头。
  // 起飞前不许作废：那时候「恢复回程」还走得通，作废等于把客人的回程凭空抹掉。

  /** 回程起飞后作废 · 预检（只读）：POST /orders/:id/void-return-leg/preview。 */
  async previewVoidReturnLeg(
    orderId: string,
    actor: { userId: string; role: UserRole },
  ): Promise<VoidReturnLegPreview> {
    if (!actorCan(actor, 'orders.cancel_leg')) {
      throw new ForbiddenError('仅运营/管理员可作废回程');
    }
    const assessed = await this._assessVoidReturnLeg(prisma, orderId);
    return {
      eligible: assessed.blockers.length === 0,
      blockers: assessed.blockers,
      departed: assessed.departed,
      original: assessed.original,
    };
  }

  /** 回程起飞后作废 · 执行：POST /orders/:id/void-return-leg。 */
  async voidReturnLeg(
    orderId: string,
    input: VoidReturnLegBody,
    actor: { userId: string; role: UserRole },
  ): Promise<{ order: ReturnType<typeof serializeOrder>; audit: VoidReturnLegAudit }> {
    if (!actorCan(actor, 'orders.cancel_leg')) {
      throw new ForbiddenError('仅运营/管理员可作废回程');
    }

    const audit = await prisma.$transaction(async (tx) => {
      // 与 no-show / 恢复 / 取消航段同一把行锁：这几条路径都在改同一批 FLIGHT 行的快照。
      const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
      `;
      if (lockRows.length === 0) throw new NotFoundError('订单不存在');

      // ── 0. 幂等回放（口径同恢复回程：认 token + 动作类型 + 入参指纹）──
      const flightRows = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT },
        select: { id: true, metadata: true },
      });
      const tokenLookup = hasSeenLegActionToken(flightRows, input.requestToken);
      if (tokenLookup.seen) {
        assertLegActionTokenReplay(tokenLookup, ['VOID'], EMPTY_LEG_ACTION_FINGERPRINT);
        const voidedRow =
          flightRows.find((row) => readJsonObject(row.metadata).returnVoidedFinal != null) ?? null;
        const current = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { orderNumber: true },
        });
        return {
          orderNumber: current.orderNumber,
          returnItemId: voidedRow?.id ?? '',
          replayed: true,
        } satisfies VoidReturnLegAudit;
      }

      // ── 1. 重跑准入闸 ──
      const assessed = await this._assessVoidReturnLeg(tx, orderId);
      if (assessed.blockers.length > 0 || !assessed.item) {
        throw new BadRequestError(assessed.blockers.join('；') || '本单没有可作废的回程航段。');
      }

      await voidReleasedReturnLegWithinTx(tx, {
        orderId,
        item: assessed.item,
        adjustments: assessed.order.adjustments,
        at: new Date(),
        byUserId: actor.userId,
        requestToken: input.requestToken,
        note: input.note?.trim() || null,
      });

      return {
        orderNumber: assessed.order.orderNumber,
        returnItemId: assessed.item.id,
        replayed: false,
      } satisfies VoidReturnLegAudit;
    });

    const finalOrder = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_FULL_INCLUDE,
    });
    return { order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)), audit };
  }

  /** 回程作废的准入评估（preview 与 execute 共用）。 */
  private async _assessVoidReturnLeg(
    db: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{
    order: CancelLegOrderSnapshot;
    item: CancelLegItemSnapshot | null;
    blockers: string[];
    departed: boolean;
    original: VoidReturnLegPreview['original'];
  }> {
    const order = await loadOrderForLegCancel(db, orderId);
    if (!order) throw new NotFoundError('订单不存在');

    const blockers: string[] = [];
    if (order.deletedAt) {
      blockers.push('订单在回收站（已软删），不能作废回程；如需操作请先恢复订单。');
    }
    // 订单状态**不设闸**：作废既不动座位也不动钱，只是给一行已经释放掉的航段打终态标。
    // 拿状态卡住只会制造死路 —— 已取消/已完结的单上照样可能挂着一行没人收口的「已释放」。

    const releaseState = resolveReturnReleaseState(order.items);
    const item = releaseState.item;
    const snapshot = item
      ? (readJsonObject(readJsonObject(item.metadata).returnReleased) as ReturnReleasedSnapshot)
      : null;
    if (!item || !snapshot) {
      blockers.push('本单没有被 no-show 释放的回程航段，无需作废。');
    } else if (releaseState.voidedFinal) {
      blockers.push('该回程已作废，无需重复操作。');
    } else if (!releaseState.releasedNow) {
      blockers.push('该回程当前不处于「已释放」状态（可能已恢复到班次），不能作废。');
    }

    const scheduleId =
      typeof snapshot?.originalScheduleId === 'string' ? snapshot.originalScheduleId : null;
    let departed = false;
    let original: VoidReturnLegPreview['original'] = null;
    if (item && snapshot && blockers.length === 0) {
      const schedule = scheduleId
        ? await db.flightSchedule.findUnique({
            where: { id: scheduleId },
            select: {
              departureTime: true,
              departureTz: true,
              // 只用于文案分支（关柜后 / 关柜前给的下一步不一样）；作废判定本身仍按起飞时刻。
              checkinCloseMinutes: true,
              flight: { select: { flightNumber: true } },
            },
          })
        : null;
      if (schedule && scheduleId) {
        // 作废的锚点仍是**起飞时刻**，不是关柜：作废是「飞机走了、这段确实消耗掉了」的事实动作，
        // 而关柜到起飞之间飞机还没走（延误/换班次都可能让它最终没走成），此时打终态就把话说早了。
        // 关柜与起飞之间那段窗口：恢复回程（闸按关柜）已经关了、释放座位（闸 5b 按关柜）也关了，
        // 这一段只能原地等到起飞——文案要把这个状态讲清楚，不能让运营以为还有别的路可走。
        departed = schedule.departureTime.getTime() <= Date.now();
        if (!departed) {
          blockers.push(
            isCheckinClosed(schedule.departureTime, schedule.checkinCloseMinutes)
              ? '回程已关柜但尚未起飞：此时既不能恢复回程、也不能再释放座位，请等起飞后再作废' +
                '（起飞满 2 小时系统会自动作废）。'
              : '回程未起飞，请用恢复回程或等待起飞后作废。',
          );
        }
        original = {
          orderItemId: item.id,
          flightNumber: schedule.flight?.flightNumber ?? null,
          departDate: localDateISO(schedule.departureTime, schedule.departureTz),
          cabin: item.flightCabin,
          quantity: item.quantity,
          scheduleId,
        };
      } else {
        // 原班次已被删除 / 快照没留班次 id：恢复回程同样走不通（那边直接给 blocker），
        // 这一行再不放行作废就永远收不了口。放行，但 departed 如实回 false（判不出来）。
        original = scheduleId
          ? {
              orderItemId: item.id,
              flightNumber: null,
              departDate: null,
              cabin: item.flightCabin,
              quantity: item.quantity,
              scheduleId,
            }
          : null;
      }
    }

    return { order, item, blockers, departed, original };
  }}

// ── 取消航段：常量 + 订单快照加载 + 对外契约类型 ────────────────────────────────

/** 航段方向的中文名（闸文案/按钮/流水 label 共用一套，避免两处各写各的）。 */
const LEG_ZH: Record<FlightLegSide, string> = { OUTBOUND: '去程', RETURN: '回程' };

/**
 * 被取消的航段行在描述前打的留痕前缀（幂等：已带前缀不再叠加）。
 * 字面量本体在 orders.leg-status.ts（对外脱敏要剥掉它们，两处各写一份必然漂移）。
 */
const LEG_CANCELLED_PREFIX: Record<FlightLegSide, string> = {
  OUTBOUND: LEG_CANCELLED_OUTBOUND_PREFIX,
  RETURN: LEG_CANCELLED_RETURN_PREFIX,
};

/** 手续费调价行的 endpoint-only 原因码（去程/回程各一个，行 label 直接说清取消的是哪段）。 */
const LEG_CANCEL_FEE_REASON: Record<FlightLegSide, PriceAdjustmentReasonDisplay> = {
  OUTBOUND: 'OUTBOUND_LEG_CANCEL_FEE',
  RETURN: 'RETURN_LEG_CANCEL_FEE',
};

/** 取消航段准入评估要读的订单快照（select 与类型同源，改一处即改两处）。 */
async function loadOrderForLegCancel(db: Prisma.TransactionClient, orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      deletedAt: true,
      subtotal: true,
      total: true,
      paidAmount: true,
      adjustmentCny: true,
      adjustments: true,
      outboundInvoiced: true,
      returnInvoiced: true,
      systemInvoiced: true,
      settlementLocked: true,
      paymentsLocked: true,
      items: {
        select: {
          id: true,
          kind: true,
          description: true,
          quantity: true,
          amount: true,
          flightCabin: true,
          flightScheduleId: true,
          metadata: true,
          flightSchedule: {
            select: {
              departureTime: true,
              departureTz: true,
              // 关柜提前分钟数（null = 走系统默认）：no-show 判定的时间锚点，见 lib/checkin-close.ts。
              checkinCloseMinutes: true,
              flight: { select: { flightNumber: true } },
            },
          },
        },
      },
      // id/姓名供 no-show 预检回乘客名单；pnr/票号留给其它读者（取消航段闸 8 已不再用整单级票号）。
      passengers: {
        select: { id: true, fullName: true, chineseName: true, pnr: true, eticketNumber: true },
      },
    },
  });
}
type CancelLegOrderSnapshot = NonNullable<Awaited<ReturnType<typeof loadOrderForLegCancel>>>;
type CancelLegItemSnapshot = CancelLegOrderSnapshot['items'][number];

/** 航段行的可读快照（预检展示 / 审计留痕）。 */
export interface CancelLegItemView {
  orderItemId: string;
  description: string;
  flightNumber: string | null;
  /** 出发地当地日 YYYY-MM-DD（按班次 departureTz 折算）。 */
  departDate: string | null;
  cabin: CabinClass | null;
  quantity: number;
  amountCny: number;
}

/** 取消政策对该航段行的报价（POLICY 模式直接采用；MANUAL 模式仍返回，供运营对照）。 */
export interface LegCancelPolicyFee {
  policyName: string;
  feePercent: number;
  /** 已取整到元并夹到 [0, 该航段行金额]。 */
  feeAmountCny: number;
  /** 距该段起飞小时数；null = 无参考时间。 */
  hoursLeft: number | null;
}

/** POST /orders/:id/cancel-leg/preview 的响应契约。 */
export interface CancelLegPreview {
  /** 本次预检的航段方向（老路径 /cancel-return-leg/preview 恒为 RETURN）。 */
  leg: FlightLegSide;
  eligible: boolean;
  /** 全部不满足的闸（人话逐条），空数组 = 可取消。 */
  blockers: string[];
  /**
   * 非阻断提示（不影响 eligible）。目前只有一条：本段已出票 —— 取消照做，
   * 但系统会给票务派撤名单/退票工单，需运营先确认已知悉。
   */
  warnings: string[];
  /** = warnings.length > 0：前端据此弹二次确认，确认后提交带 acknowledgeWarnings=true。 */
  requiresAcknowledgement: boolean;
  /** 待取消的那一段航段行（字段名沿用 returnItem，去程/回程共用；方向看上面的 leg）。 */
  returnItem: CancelLegItemView | null;
  policyFee: LegCancelPolicyFee | null;
  /** 应收下降额 = 该航段行金额 − 手续费。 */
  netReductionCny: number;
  /**
   * 手动填退款金额的上限 = min(该航段行金额, 本单当前应收)。前端用它给退款输入框
   * 设上限提示；服务端在执行时按同一口径再校验一次（权威判定不在前端）。
   */
  maxRefundCny: number;
  currentTotalCny: number;
  paidAmountCny: number;
  /** 取消后的多收额 = max(0, 已收 − 取消后应收)；由既有多收/退款流程处置，本端点不打款。 */
  overpayAfterCny: number;
}

/** 取消航段的审计明细（路由据此记 CANCEL_RETURN_LEG / CANCEL_OUTBOUND_LEG）。 */
export interface CancelLegAudit {
  orderNumber: string;
  /** 被取消的航段方向。 */
  leg: FlightLegSide;
  /** 被作废保留的那条航段行 id（字段名沿用 returnItemId，去程/回程共用）。 */
  returnItemId: string;
  /** 生成的手续费调价行 id；手续费为 0 或幂等回放时为 null。 */
  feeItemId: string | null;
  /** 本段已出票时给票务派的「撤名单/退票」工单 id；未出票为 null。 */
  workOrderReminderId: string | null;
  /** 上面那条工单的标题（企业微信即时推送用，跟 workOrderReminderId 同步为 null）。 */
  workOrderTitle: string | null;
  releasedSeats: Array<{ scheduleId: string; cabin: CabinClass; quantity: number }>;
  originalAmountCny: number;
  feeCny: number;
  feeMode: 'POLICY' | 'MANUAL';
  policyName: string | null;
  netReductionCny: number;
  totalBefore: number;
  totalAfter: number;
  overpayAfterCny: number;
  /** true = 同 requestToken 重试，本次没有任何写入（座位不会被二次释放）。 */
  replayed: boolean;
}

// ── 去程 no-show / 回程释放 · 恢复：常量 + 辅助 + 对外契约类型 ─────────────────

/**
 * 内部留痕前缀（no-show / 释放 / 取消航段）与剥前缀函数**都住在 orders.leg-status.ts**：
 * 退款报价引擎 lib/cancellation.ts 也要剥前缀，而 lib 层 import 本文件会形成反向依赖。
 * 这里只做 re-export，让既有调用方（含单测）保持从本模块 import 不变。
 * 写成 `export … from`（而不是转发本文件顶部那个 import 绑定）：后者在 vitest 的
 * `vi.mock('./orders.service.js')` 局部 mock 下会变成一个指向未初始化局部绑定的 getter，
 * 测试一 spread importOriginal() 就 ReferenceError。
 */
export { stripInternalLegPrefix } from './orders.leg-status.js';

/** 快照里的 ISO 时间字符串 → Date；缺失/不合法一律 null（防御式读，快照字段都可能缺）。 */
function readSnapshotDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * 回程行「此刻是不是处于已释放态」的**唯一**判定口径（no-show 闸 5 与恢复回程闸共用）。
 *
 * 不能只看「有没有 returnReleased 快照」—— 恢复回程时那份快照是**保留不删**的
 *（释放→恢复可以反复发生，历史全留着才查得清），只看存在与否会把「释放过、后来已恢复」
 * 误判成「现在还释放着」：再标一次 no-show 会被闸挡、恢复回程又会重复占座。
 * 真口径要两条同时成立：
 *   1) 最后一次动作是释放 —— returnReleased.at 比 returnRestored.at 新（没恢复过则恒成立）；
 *   2) 该行 flightScheduleId 为空 —— 全站「有效航段」判定，座位确实不在班次上。
 */
function resolveReturnReleaseState<
  T extends { kind: OrderItemKind; flightScheduleId: string | null; metadata: unknown },
>(
  items: readonly T[],
): {
  item: T | null;
  releasedNow: boolean;
  releasedAt: Date | null;
  restoredAt: Date | null;
  voidedFinal: boolean;
} {
  const row =
    items.find(
      (it) =>
        it.kind === OrderItemKind.FLIGHT &&
        readJsonObject(readJsonObject(it.metadata).returnReleased).at != null,
    ) ?? null;
  if (!row) {
    return { item: null, releasedNow: false, releasedAt: null, restoredAt: null, voidedFinal: false };
  }
  const meta = readJsonObject(row.metadata);
  const releasedAt = readSnapshotDate(readJsonObject(meta.returnReleased).at);
  const restoredAt = readSnapshotDate(readJsonObject(meta.returnRestored).at);
  const voidedFinal = meta.returnVoidedFinal != null;
  // 「当前处于已释放态」只有一份口径（orders.leg-status.ts，导出/提醒/legFlag 同用），这里不再另算。
  const releasedNow = isReturnCurrentlyReleased(row);
  return { item: row, releasedNow, releasedAt, restoredAt, voidedFinal };
}

/** 标 no-show 前剥掉已有的「未登机」前缀（新旧两种写法都认），保证重复标记/再次释放不叠前缀。 */
function stripNoShowPrefix(description: string): string {
  for (const prefix of [NO_SHOW_PREFIX, LEGACY_NO_SHOW_PREFIX]) {
    if (description.startsWith(prefix)) return description.slice(prefix.length);
  }
  return description;
}

/** 恢复回程时剥掉「已释放」前缀（新旧两种写法都认，只剥一层）。 */
function stripReturnReleasedPrefix(description: string): string {
  for (const prefix of [RETURN_RELEASED_PREFIX, LEGACY_RETURN_RELEASED_PREFIX]) {
    if (description.startsWith(prefix)) return description.slice(prefix.length);
  }
  return description;
}

/** 本次 no-show 的作用范围：整单 / 需要先按人拆单。 */
export type NoShowScope = 'WHOLE' | 'SPLIT_REQUIRED';

/** 航段行 → no-show 预检用的可读快照（**不含金额**：本操作与钱无关）。 */
export interface NoShowLegView {
  orderItemId: string;
  description: string;
  flightNumber: string | null;
  /** 出发地当地日 YYYY-MM-DD（按班次 departureTz 折算）。 */
  departDate: string | null;
  cabin: CabinClass | null;
  quantity: number;
}

/** POST /orders/:id/no-show/preview 的响应契约。 */
export interface NoShowPreview {
  eligible: boolean;
  /** 全部不满足的闸（人话逐条），空数组 = 可标记。 */
  blockers: string[];
  /** 非阻断提示（已出票 / 已开票 / 需拆单 / 单程单等），不影响 eligible。 */
  warnings: string[];
  scope: NoShowScope;
  outboundItem: NoShowLegView | null;
  /** 单程单为 null；ticketed=true 表示该段有确认出票记录，释放后会派撤名单/退票工单。 */
  returnItem: (NoShowLegView & { ticketed: boolean }) | null;
  passengers: Array<{ id: string; fullName: string; chineseName: string | null }>;
  alreadyNoShow: boolean;
  /**
   * 回程班次已起飞。勾了「同时释放回程」时同时会有一条 blocker（起飞后的座位放回库存 = 凭空多卖）；
   * 只想留 no-show 记录（releaseReturn=false）不受影响。
   */
  returnDeparted: boolean;
  /** true = 去程早标过 no-show、回程已恢复回来，本次只是「再释放一次回程」（首个快照不覆盖）。 */
  isRerelease: boolean;
}

/** POST /orders/:id/no-show 的审计明细（路由据此记 MARK_NO_SHOW）。 */
export interface NoShowAudit {
  /** 实际被操作的那张单的单号（拆过则是新单号）。 */
  orderNumber: string;
  outboundItemId: string;
  /** 释放掉的回程行 id；未释放 / 单程单为 null。 */
  returnItemId: string | null;
  releasedSeats: ReleasedSeatEntry[];
  /** 回程已出票时给票务派的「撤名单/退票」工单 id。 */
  workOrderReminderId: string | null;
  /** 上面那条工单的标题（企业微信即时推送用，跟 workOrderReminderId 同步为 null）。 */
  workOrderTitle: string | null;
  /** 走了拆单时的两侧单号；整单标记为 null。 */
  split: { sourceOrderNumber: string; targetOrderNumber: string } | null;
  /** true = 同 requestToken 重试，本次没有任何写入（座位不会被二次释放）。 */
  replayed: boolean;
}

/** POST /orders/:id/restore-return-leg/preview 的响应契约。 */
export interface RestoreReturnLegPreview {
  eligible: boolean;
  blockers: string[];
  /**
   * 非阻断提示：恢复之后**票务台还要动手做的事**（开票位重标、重新上名单工单），不影响 eligible。
   * 系统不会自己补这两件事，不提示就成了静默缺口 —— 口径同 no-show 预检的 warnings。
   */
  warnings: string[];
  original: {
    orderItemId: string;
    flightNumber: string | null;
    departDate: string | null;
    cabin: CabinClass | null;
    quantity: number;
    scheduleId: string;
  } | null;
  /** 原班次该舱当前余位（capacity − sold − 他人锁位 − 占位余座）。**可为负**（全站余位不夹 0）。 */
  available: number;
  /**
   * 余位不够、需要运营二次确认（提交时必须带 allowOversell）。
   * 口径是**余位缺口**（含他人锁位与占位单余座），不是超售座数 —— 被锁位占满时这里为 true
   * 而 oversellBy 可能是 0（sold 没超 capacity）。「超售 N 座」的措辞只看 oversellBy。
   */
  needsOversell: boolean;
  /**
   * 本次会**挤掉几座他人软预留**（他人 ACTIVE 锁位 + 占位单余座）。
   * 与 oversellBy 是两个不同的数：班次还有物理空位、只是被锁位/占位占满时，
   * oversellBy = 0 而这里 > 0 —— 前端文案要说「将占用他人临时锁位/占位 N 座」。
   */
  reservedConflict: number;
  /** 本次**新增**的超售座数（Σ 逐舱 increment）——「这一次会多卖几座」。 */
  oversellBy: number;
  /** 恢复**之后**这些舱一共超出几座（Σ max(0, after)）——上限判定与风控看的是这个数。 */
  oversoldAfter: number;
  /** 逐舱三值（before/after/increment），前端要逐舱展示时用。 */
  oversellDetail: OversellSeatDetail[];
  maxOversell: number;
  /** 原班次**已关柜**（同时会有一条 blocker）。字段名是历史契约，口径含「已起飞」这一段。 */
  departed: boolean;
}

/** POST /orders/:id/void-return-leg/preview 的响应契约。 */
export interface VoidReturnLegPreview {
  eligible: boolean;
  /** 全部不满足的闸（人话逐条），空数组 = 可作废。 */
  blockers: string[];
  /** 原回程班次已起飞（作废的前提；判不出来时为 false）。 */
  departed: boolean;
  /** 要被作废的那一段（原班次信息取自释放快照）。 */
  original: {
    orderItemId: string;
    flightNumber: string | null;
    departDate: string | null;
    cabin: CabinClass | null;
    quantity: number;
    scheduleId: string;
  } | null;
}

/** POST /orders/:id/void-return-leg 的审计明细。 */
export interface VoidReturnLegAudit {
  orderNumber: string;
  returnItemId: string;
  replayed: boolean;
}

/**
 * 回程「起飞后作废」的落库动作 —— **人工端点与后台 job 共用同一份实现**。
 *
 * 做四件事，一件不多：
 *   1. 行 metadata 落 returnVoidedFinal 终态快照 + legActionLog 追一条 VOID；
 *   2. hasReturnLeg / legFlag 两个物化列成对同步（deriveLegStatus 见到 returnVoidedFinal
 *      即判「回程已作废」，legFlag 落 RETURN_VOIDED，列表与导出这才对得上）；
 *   3. adjustments 追一条 0 元留痕（作废不动钱，写 0 是为了让流水上看得见这一步）；
 *   4. 把这一行的两条「回程已释放」提醒（原 key 与起飞后换的 :DEPARTED）关掉并写明原因 ——
 *      不关的话待办永远催下去，运营还会照旧条去点「恢复回程」。
 *
 * **一个字都不写钱**：unitPrice / amount / unitCostCny / totalCostCny 与 subtotal / total
 * 全不动，座位也不动（早在释放那一步就还回库存了）。要退钱走既有退款流程。
 */
export async function voidReleasedReturnLegWithinTx(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    item: { id: string; metadata: unknown };
    adjustments: Prisma.JsonValue | null | undefined;
    at: Date;
    /** 人工作废 = 操作人 id；后台 job 传 'SYSTEM'。 */
    byUserId: string;
    /** 人工作废的幂等键；job 不带（改带 jobId）。 */
    requestToken?: string;
    /** 后台 job 的批次标识（进快照，便于把一批自动作废归到同一次扫描）。 */
    jobId?: string;
    note?: string | null;
  },
): Promise<void> {
  const meta = readJsonObject(input.item.metadata);
  const atIso = input.at.toISOString();
  const bySystem = input.requestToken == null;
  const voidedSnapshot: Record<string, unknown> = {
    at: atIso,
    byUserId: input.byUserId,
    note: input.note ?? null,
  };
  if (input.requestToken != null) voidedSnapshot.requestToken = input.requestToken;
  if (input.jobId != null) voidedSnapshot.jobId = input.jobId;

  await tx.orderItem.update({
    where: { id: input.item.id },
    data: {
      metadata: {
        ...meta,
        returnVoidedFinal: voidedSnapshot,
        legActionLog: appendLegActionLog(meta, {
          type: 'VOID',
          // job 没有请求编号，用批次标识占位：legActionLog 的 token 必须非空，
          // 且这个形状永远不会与前端生成的 uuid 撞车。
          requestToken: input.requestToken ?? `job:${input.jobId ?? atIso}`,
          at: atIso,
          byUserId: input.byUserId,
          fingerprint: EMPTY_LEG_ACTION_FINGERPRINT,
        }),
      } as Prisma.InputJsonValue,
    },
  });

  await syncOrderHasReturnLeg(tx, input.orderId);
  await syncOrderLegFlag(tx, input.orderId);

  const log = appendAdjustment(input.adjustments, {
    type: 'RETURN_LEG_VOIDED',
    label: '回程已过期作废（原班次已起飞，座位早已释放，钱款不动）',
    amountCny: 0,
    at: atIso,
    by: input.byUserId,
    note: input.note ?? undefined,
  });
  await tx.order.update({ where: { id: input.orderId }, data: { adjustments: log } });

  // 这一行的两条「回程已释放」待办一起收口（原 key + 起飞后那条 :DEPARTED）。
  const releasedAt = readJsonObject(meta.returnReleased).at;
  if (typeof releasedAt === 'string' && releasedAt !== '') {
    await tx.operationalReminder.updateMany({
      where: {
        ruleKey: { in: noShowReleasedReminderRuleKeys(input.item.id, releasedAt) },
        status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] },
      },
      data: {
        status: ReminderStatus.DONE,
        resolvedAt: input.at,
        resolvedNote:
          (bySystem ? '回程原班次已起飞，系统自动作废收口。' : '回程已人工确认作废收口。') +
          (input.note ? `备注：${input.note}` : ''),
      },
    });
  }
}

/** POST /orders/:id/restore-return-leg 的审计明细。 */
export interface RestoreReturnLegAudit {
  orderNumber: string;
  returnItemId: string;
  scheduleId: string;
  cabin: CabinClass | null;
  /** 本次恢复的总座数（升舱拆座时是各舱之和；逐舱明细在 metadata.returnRestored.seatDetail）。 */
  quantity: number;
  oversold: boolean;
  /** 本次超售的座数（增量）。 */
  oversoldBy: number;
  /**
   * 恢复**之后**该班该舱的累计超售座数（sold − capacity 的正数；0 = 未超。锁位/占位不算超售）。
   * 风控看的是这个数：第 3 次各超 1 座和第 1 次超 3 座，风险完全不同，只记增量看不出班次被卖到哪了。
   */
  scheduleOversoldAfter: number;
  /** 原班次航班号 / 出发地当地出发日（审计 targetLabel 直接说清是哪一班，不必再去翻 scheduleId）。 */
  flightNumber: string | null;
  departDate: string | null;
  /** 释放时已出票 → 本次恢复顺带派的「重新上名单」工单 id；未派为 null。 */
  workOrderReminderId: string | null;
  /** 上面那条工单的标题（企业微信即时推送用，跟 workOrderReminderId 同步为 null）。 */
  workOrderTitle: string | null;
  replayed: boolean;
}

/**
 * 恢复回程时某一舱位的「要占几座 + 该舱现状」。
 * capacity/sold 供超售口径（computeOversellDelta），available 供「走 CAS 占座还是超售直加」的分支 ——
 * 两个口径分工见 cabinSeatStateWithinTx 的注释，绝不能互相替代。
 */
type RestoreSeatNeed = {
  cabin: CabinClass;
  quantity: number;
  capacity: number;
  sold: number;
  available: number;
  /** 该舱当前的软预留（他人 ACTIVE 锁位 + 占位单余座）——硬占时会被挤掉的那部分。 */
  reserved: number;
};

/** 工单标题：「撤名单/退票：单号 · 回程 QH9588 2026-09-10 · 2 人」。 */
function buildTicketWorkOrderTitle(
  action: string,
  orderNumber: string,
  legZh: string,
  item: CancelLegItemSnapshot,
): string {
  const sched = item.flightSchedule;
  const flightNo = sched?.flight?.flightNumber ?? '航班未知';
  const day = sched?.departureTime ? localDateISO(sched.departureTime, sched.departureTz) : '日期未知';
  return `${action}：${orderNumber} · ${legZh} ${flightNo} ${day} · ${item.quantity} 人`;
}

/**
 * 在**当前事务内**给票务派一条待办工单（复用既有 OperationalReminder 表，零迁移）。
 *
 * 幂等靠 ruleKey 唯一索引：先查后建（订单行已被 FOR UPDATE 锁住，同单不会并发到这里）。
 * 不用 create+catch(P2002)：Postgres 里语句失败会废掉整个事务，业务写入会被一并回滚。
 */
async function createTicketWorkOrder(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    createdById: string;
    ruleKey: string;
    title: string;
    body: string;
    at: Date;
  },
): Promise<string | null> {
  const existing = await tx.operationalReminder.findUnique({
    where: { ruleKey: input.ruleKey },
    select: { id: true },
  });
  if (existing) return existing.id;
  // dueAt 是 @db.Date：按业务日（上海）取当天零点 UTC，与提醒引擎落库口径一致。
  const created = await tx.operationalReminder.create({
    data: {
      orderId: input.orderId,
      createdById: input.createdById,
      title: input.title,
      body: input.body,
      dueAt: new Date(`${businessDateISO(input.at)}T00:00:00Z`),
      priority: ReminderPriority.HIGH,
      ruleKey: input.ruleKey,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * 撤名单/退票、重新上名单三类工单创建后即时推一条企业微信通知——受 REMINDER_WEBHOOK_PUSH
 * feature flag 控制（关或未配置 WECOM_WEBHOOK_URL 都是 no-op），且必须由调用方在
 * **事务提交之后**以 `void notifyWorkOrderCreatedToWecom(...)` 的方式 fire-and-forget 调用：
 * 本函数自己不开事务、不参与调用方的事务，pushWecomMarkdown 内部的 HTTP 请求绝不会发生在
 * 一个尚未提交的数据库事务里。title 为 null（未真正派出工单）时直接跳过。
 */
async function notifyWorkOrderCreatedToWecom(orderNumber: string, title: string | null): Promise<void> {
  if (!title) return;
  if (!(await isFeatureEnabled(prisma, 'REMINDER_WEBHOOK_PUSH'))) return;
  await pushWecomMarkdown(`### 新工单\n订单 ${orderNumber}\n${title}`, 'work-order-created');
}

/** 老名字的兼容别名（老路径 /cancel-return-leg 的调用方仍按这些名字引用）。 */
export type CancelReturnLegItemView = CancelLegItemView;
export type ReturnLegCancelPolicyFee = LegCancelPolicyFee;
export type CancelReturnLegPreview = CancelLegPreview;
export type CancelReturnLegAudit = CancelLegAudit;

// ── 拆单 v1 · 模块级辅助（类型 / 加载 / 纯函数）─────────────────────────────

/** 拆单执行入参（路由 schema 与两条编排路径共用同一形状）。 */
export interface SplitOrderInput {
  passengerIds: string[];
  /** 显式指定某条酒店 / 套餐住宿行随拆搬走几间（0.5 网格）。 */
  roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
  /**
   * 显式指定某条机票行随拆搬走几个升舱位。新形状 = 一行一腿（toMove）；
   * outboundToMove / returnToMove 是旧形状，服务端按该行归属的航段取对应字段。
   */
  upgradeSplit?: Array<{
    itemId: string;
    toMove?: number;
    outboundToMove?: number;
    returnToMove?: number;
  }>;
  /**
   * 混合房组自动劈半（no-show / 按人改期编排传 true）。手工拆单默认 false：
   * 同房组闸照旧拒拆，让运营自己先在分房里把人分开。
   */
  autoSplitRoomGroups?: boolean;
  note?: string;
  /**
   * 编排上下文留档（按人改期传：目标航段行 / 目标班次 / 目标舱位 / 改期差价 / 每行搬几间房）。
   * 拆单本身不读它，只原样写进 OrderSplitRecord.snapshot.orchestration ——
   * 编排层拿同一个 requestToken 回放时据此比对入参：换了班次、换了费用或换了房数还沿用
   * 同一个 token，必须判 409，而不是静默回放上一轮拆出的那张单。
   */
  orchestration?: SplitOrchestrationSnapshot;
  requestToken: string;
}

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
  /** 非阻断提示（如「本单已出票，票随人走」），只影响弹窗文案，不影响 eligible。 */
  warnings: string[];
  shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
  allShareRows: Array<{ passengerId: string; netCny: number; shareCny: number }>;
  movedShareCny: number;
  movedPaidCny: number;
  preTotalCny: number;
  prePaidCny: number;
  /** 应收总额 = total + adjustmentCny（份额的分母，Σ shares 恒等于它）。 */
  payableCny: number;
  /** 随拆转移的售后费用（改期费/换人费等按份额分摊的那一份）。 */
  movedAdjustmentCny: number;
  /** 新单 total = movedShare − movedAdjustment（售后费不重复计入应收）。 */
  targetTotalCny: number;
  /** 拆前的预存抵扣（Order.prepaymentOffset，历史遗留列，现行系统恒为 0）。 */
  prePrepaymentOffsetCny: number;
  /** 随拆搬到新单的预存抵扣（按份额比；留守 = 拆前 − 本值）。 */
  movedPrepaymentOffsetCny: number;
  /**
   * 本单挂着预存余额抵扣流水（PrepaymentTransaction(OFFSET)）吗。
   * 闸 10c 据此拒拆；执行段拿它当审计触发条件（那时已被闸拦下，纯属防御）。
   */
  hasPrepaymentOffsetTxn: boolean;
  hotelItems: SplitHotelItemView[];
  upgradeItems: SplitUpgradeItemView[];
  /**
   * 佣金处置：NONE=无佣金；SPLIT=按份额劈两条；BLOCKED=已进结算流程，拒拆。
   * reversalCny = 待追回的负数 REVERSED 补偿合计（≤0，尚未并入结算单），同样随拆按份额劈。
   */
  commission: { mode: 'NONE' | 'SPLIT' | 'BLOCKED'; amountCny: number; reversalCny: number };
  /** 有房组同时含拆出与留下的乘客（手工拆单 = 闸 15 拒拆；编排路径 = 自动劈半组）。 */
  roomGroupConflict: boolean;
  movedIdSet: Set<string>;
  /** 两侧人数/单住/自备签/升舱的解析结果（执行段直接拿去建 SplitContext）。 */
  occupancy: {
    movedOccupancy: SplitOccupancy;
    keptOccupancy: SplitOccupancy;
    movedSingleCount: number;
    keptSingleCount: number;
    movedSelfVisaCount: number;
    keptSelfVisaCount: number;
  };
}

/** 预检回给前端的酒店/套餐住宿行（运营据此填 roomSplit）。 */
export interface SplitHotelItemView {
  itemId: string;
  description: string;
  roomsBilled: number | null;
  /** 服务端按人头派生的建议间数（前端预填；不传 roomSplit 时编排路径也用这个数）。 */
  suggestedRoomsToMove: number | null;
  /** true = 这是套餐行自带的住宿盖章（套餐单没有独立 HOTEL 行）。 */
  isBundleStay: boolean;
}

/** 预检回给前端的升舱行（运营据此填 upgradeSplit）。 */
export interface SplitUpgradeItemView {
  itemId: string;
  leg: 'OUTBOUND' | 'RETURN';
  businessUpgradeCount: number;
  suggestedToMove: number;
  /** 这一行随拆搬走的座位数（= 该行升舱位的上限，前端据此夹输入框）。 */
  movedSeatPax: number;
  /** 这一行留在源单的座位数（= 留守侧升舱位的上限）。 */
  keptSeatPax: number;
}

/** 拆单要读的源单快照（预检与事务内共用同一份 loader，杜绝两处字段漂移）。 */
async function loadOrderForSplit(db: Prisma.TransactionClient, orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      // orderBy + 班次时刻：升舱位的去程/回程归属靠 determineFlightLegItems 判定
      //（不能靠数组下标 —— Prisma 无 orderBy 时行序不保证，被 UPDATE 过的行还会跑到最后，
      // 于是「第一条 FLIGHT 行 = 去程」在拆过一次的单上会认错腿，升舱位归错航段）。
      items: {
        orderBy: { createdAt: 'asc' },
        include: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
      },
      // 乘客不带 orderBy：与 ORDER_FULL_INCLUDE（详情页每人结算价表的数据源）同口径，
      // 保证「余数兜最后一位」兜到的与前端展示的是同一位乘客。
      passengers: {
        select: {
          id: true,
          fullName: true,
          chineseName: true,
          pnr: true,
          eticketNumber: true,
          // 套餐单拆分要按乘客现势重建人数快照（addOns）：
          //   passengerType → 成人/占座儿童/不占座婴儿；singleRoom → 单住间数；
          //   visaExempt → 自备签减免人数。
          // 分房混合房组劈半**不看性别**：两个半组写同一个 splitPairKey，房控据此配回一间。
          passengerType: true,
          visaExempt: true,
          singleRoom: true,
        },
      },
    },
  });
}
type SplitSourceOrder = NonNullable<Awaited<ReturnType<typeof loadOrderForSplit>>>;

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

/** 订单行 → 策略层认得的最小形状（Decimal / JSON 都在这里归一化，策略层只见普通数字）。 */
function toSplitItemView(item: SplitSourceOrder['items'][number]): SplitItemView {
  return {
    id: item.id,
    kind: item.kind,
    description: item.description,
    quantity: item.quantity,
    unitPrice: Number(item.unitPrice),
    amount: Number(item.amount),
    totalCostCny: item.totalCostCny != null ? Number(item.totalCostCny) : null,
    roomsBilled: item.roomsBilled != null ? Number(item.roomsBilled) : null,
    passengerId: item.passengerId,
    metadata: readJsonObject(item.metadata),
  };
}

/** 策略层补丁 → Prisma 落库形状（数字转 Decimal；只带真正要改的列）。 */
interface SplitPatchData {
  description?: string;
  quantity?: number;
  amount?: Prisma.Decimal;
  totalCostCny?: Prisma.Decimal | null;
  roomsBilled?: Prisma.Decimal | null;
  metadata?: Prisma.InputJsonValue;
}
/**
 * 「不动」决策（SplitMove.NONE）的落库形状 —— **硬白名单，只出 metadata**。
 *
 * 类型上 NONE 的 update 已经收成 `Pick<SplitRowPatch, 'metadata'>`，但 TypeScript 的结构类型
 * 挡不住一个多带了字段的变量被赋进来；而通用的 splitPatchToPrisma 能写数量/金额/成本/房数。
 * 「不动的行不许动财务字段」是拆单守恒断言成立的前提，这个前提必须由内核自己兜住，
 * 不能只靠生产者（split-move-strategies 里的各条策略）自觉。
 *
 * 返回 null = 补丁里没有 metadata，这一行一个字都不用改（连一次空写都省掉）。
 */
export function splitNoneUpdateToPrisma(
  update: Pick<SplitRowPatch, 'metadata'>,
): { metadata: Prisma.InputJsonValue } | null {
  if (update.metadata === undefined) return null;
  return { metadata: update.metadata as Prisma.InputJsonValue };
}

function splitPatchToPrisma(patch: SplitRowPatch): SplitPatchData {
  const data: SplitPatchData = {};
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.quantity !== undefined) data.quantity = patch.quantity;
  if (patch.amount !== undefined) data.amount = new Prisma.Decimal(patch.amount);
  if (patch.totalCostCny !== undefined) {
    data.totalCostCny = patch.totalCostCny == null ? null : new Prisma.Decimal(patch.totalCostCny);
  }
  if (patch.roomsBilled !== undefined) {
    data.roomsBilled = patch.roomsBilled == null ? null : new Prisma.Decimal(patch.roomsBilled);
  }
  if (patch.metadata !== undefined) data.metadata = patch.metadata as Prisma.InputJsonValue;
  return data;
}

/** 守恒断言用的行形状（拆前读 loadOrderForSplit、拆后读两单 findMany，字段一致）。 */
interface SplitConservationRow {
  kind: OrderItemKind;
  flightScheduleId?: string | null;
  flightCabin?: import('@prisma/client').CabinClass | null;
  quantity?: number;
  metadata?: unknown;
  roomsBilled?: Prisma.Decimal | number | null;
  totalCostCny?: Prisma.Decimal | number | null;
}

/**
 * 逐班次舱位的**升舱位**账：key = `${scheduleId}|${cabin}` → Σ min(升舱人数, 该行座位数)。
 * 升舱位对应的是真实商务舱库存，拆单一旦把它放大就等于凭空占了商务舱座。
 */
function sumFlightUpgradeCounts(items: ReadonlyArray<SplitConservationRow>): Map<string, number> {
  const map = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== OrderItemKind.FLIGHT || !it.flightScheduleId) continue;
    const count = readUpgradeCount(readJsonObject(it.metadata));
    if (count <= 0) continue;
    const key = `${it.flightScheduleId}|${it.flightCabin ?? 'NONE'}`;
    map.set(key, (map.get(key) ?? 0) + Math.min(count, it.quantity ?? 0));
  }
  return map;
}

/** Σ roomsBilled（以「半间」为整数单位，避免 0.5 的浮点尾数）。 */
function sumRoomsBilledHalves(items: ReadonlyArray<SplitConservationRow>): number {
  return items.reduce(
    (sum, it) => sum + (it.roomsBilled == null ? 0 : Math.round(Number(it.roomsBilled) * 2)),
    0,
  );
}

/** Σ totalCostCny（以「分」为整数单位）。 */
function sumTotalCostCents(items: ReadonlyArray<SplitConservationRow>): number {
  return items.reduce(
    (sum, it) => sum + (it.totalCostCny == null ? 0 : Math.round(Number(it.totalCostCny) * 100)),
    0,
  );
}

/** 佣金劈分的审计明细（事务外写 CRITICAL 审计用）。 */
export interface SplitCommissionAudit {
  commissionId: string;
  agentId: string;
  beforeAmountCny: number;
  keptAmountCny: number;
  movedAmountCny: number;
  movedCommissionId: string | null;
  rate: number;
  chainDepth: number;
}

/** 两侧人数解析结果（assessOrderSplit 产出，执行段与预检建议共用）。 */
interface SplitOccupancyPair {
  movedOccupancy: SplitOccupancy;
  keptOccupancy: SplitOccupancy;
  movedSingleCount: number;
  keptSingleCount: number;
  movedSelfVisaCount: number;
  keptSelfVisaCount: number;
}

/**
 * 「建议值」用的上下文：无任何显式指令、允许自动派生。预检回显的 suggestedRoomsToMove /
 * suggestedToMove 与编排路径（不传 roomSplit/upgradeSplit）实际落库的数**同一函数算出来**，
 * 不存在「预检显示 0.5、执行搬了 1」的漂移。
 */
function buildSplitSuggestionContext(input: {
  movedIdSet: Set<string>;
  totalPax: number;
  occupancy: SplitOccupancyPair;
}): SplitContext {
  return buildSplitContext({
    ...input,
    roomSplitByItem: new Map(),
    upgradeSplitByItem: new Map(),
    autoDeriveRooms: true,
    movedUpgradeOutbound: 0,
    movedUpgradeReturn: 0,
    keptUpgradeOutbound: 0,
    keptUpgradeReturn: 0,
    // 预检不落库 → 不写住宿行配对键（那是执行段的事）。
    splitPairToken: '',
  });
}

/** 拆单上下文装配（唯一入口，保证预检与执行看到同一套人数口径）。 */
function buildSplitContext(input: {
  movedIdSet: Set<string>;
  totalPax: number;
  occupancy: SplitOccupancyPair;
  roomSplitByItem: Map<string, number>;
  upgradeSplitByItem: Map<string, number>;
  autoDeriveRooms: boolean;
  movedUpgradeOutbound: number;
  movedUpgradeReturn: number;
  keptUpgradeOutbound: number;
  keptUpgradeReturn: number;
  /** 住宿行劈半时两侧共用的配对键令牌（= requestToken）；预检建议上下文传空串。 */
  splitPairToken: string;
}): SplitContext {
  const { occupancy } = input;
  return {
    movedIdSet: input.movedIdSet,
    k: input.movedIdSet.size,
    totalPax: input.totalPax,
    movedSeatPax: occupancy.movedOccupancy.seatPax,
    totalSeatPax: occupancy.movedOccupancy.seatPax + occupancy.keptOccupancy.seatPax,
    movedOccupancy: occupancy.movedOccupancy,
    keptOccupancy: occupancy.keptOccupancy,
    movedSingleCount: occupancy.movedSingleCount,
    keptSingleCount: occupancy.keptSingleCount,
    movedSelfVisaCount: occupancy.movedSelfVisaCount,
    keptSelfVisaCount: occupancy.keptSelfVisaCount,
    roomSplitByItem: input.roomSplitByItem,
    upgradeSplitByItem: input.upgradeSplitByItem,
    movedUpgradeOutbound: input.movedUpgradeOutbound,
    movedUpgradeReturn: input.movedUpgradeReturn,
    keptUpgradeOutbound: input.keptUpgradeOutbound,
    keptUpgradeReturn: input.keptUpgradeReturn,
    autoDeriveRooms: input.autoDeriveRooms,
    splitPairToken: input.splitPairToken,
  };
}

/**
 * 拆单的航段归属：**按班次出发时刻**判去程/回程（determineFlightLegItems，全站唯一口径）。
 *
 * 不用「items 数组第一条 FLIGHT 行 = 去程」：Prisma 无 orderBy 时行序不保证，且被 UPDATE
 * 过的行（拆过一次 / 改过期）会跑到结果集末尾 —— 那条规则在拆过一次的单上会把去程认成回程，
 * 升舱位整块归错航段。无班次的行（no-show 释放后 flightScheduleId 置空）不归任何一腿，
 * 升舱汇总时按去程处理（它本来就是去程行被释放后的残骸）。
 */
function resolveSplitFlightLegs(items: SplitSourceOrder['items']): {
  flightRows: SplitSourceOrder['items'];
  returnItemId: string | null;
} {
  const flightRows = items.filter((it) => it.kind === OrderItemKind.FLIGHT);
  const legs = determineFlightLegItems(flightRows);
  return { flightRows, returnItemId: legs.return?.id ?? null };
}

/** 带升舱位的机票行清单（预检回显 + 分程归属）。 */
function collectSplitUpgradeItems(
  items: SplitSourceOrder['items'],
  ctx: SplitContext,
): SplitUpgradeItemView[] {
  const { flightRows, returnItemId } = resolveSplitFlightLegs(items);
  const out: SplitUpgradeItemView[] = [];
  flightRows.forEach((item) => {
    const view = toSplitItemView(item);
    const count = readUpgradeCount(view.metadata);
    if (count <= 0) return;
    // 终态残骸行不随拆（planItemMove 判 NONE），预检也不该把它列进「可拆升舱位」。
    if (isTerminalLegItem(view.metadata)) return;
    // 机票行两侧座位数按**占座人头**算（婴儿不占座），与落库同一个 movedUnitsFor。
    const moveQty = movedUnitsFor(view, ctx);
    const keepQty = view.quantity - moveQty;
    out.push({
      itemId: view.id,
      leg: view.id === returnItemId ? 'RETURN' : 'OUTBOUND',
      businessUpgradeCount: count,
      suggestedToMove: resolveUpgradeToMove(view, ctx, moveQty, keepQty),
      movedSeatPax: moveQty,
      keptSeatPax: keepQty,
    });
  });
  return out;
}

/**
 * 混合房组自动劈半（仅 no-show / 按人改期编排路径）：一个房组同时含拆出与留下的乘客时，
 * 按人头把它劈成两个房组 —— 同酒店、同房型、同日期，各自 roomFraction 按 0.5 网格分，
 * 两组之和恒等于原组（房控把两个半间配回一间，房量分毫不动）。
 *
 * 返回 { kept, moved }：留守组进源单分房表、拆出组进新单分房表。
 */
function splitMixedRoomGroup(
  group: { raw: Record<string, unknown>; passengerIds: string[] },
  movedIdSet: ReadonlySet<string>,
  pairToken: string,
): { kept: Record<string, unknown>; moved: Record<string, unknown> } {
  const movedIds = group.passengerIds.filter((id) => movedIdSet.has(id));
  const keptIds = group.passengerIds.filter((id) => !movedIdSet.has(id));
  const rawFraction = group.raw.roomFraction == null ? 1 : Number(group.raw.roomFraction);
  const srcHalf = Math.max(1, Math.round((Number.isFinite(rawFraction) ? rawFraction : 1) * 2));
  let movedHalf = Math.round((srcHalf * movedIds.length) / group.passengerIds.length);
  movedHalf = Math.min(Math.max(movedHalf, 1), Math.max(1, srcHalf - 1));
  const keptHalf = srcHalf - movedHalf;
  // 房组 id 缺省时**不能**回落成固定字符串：一张单里两个无 id 的房组同时被劈开，
  // 两对半组会共用同一个 `group:<token>` 配对键，房控按 key 归并时会把四个半组
  // 错配成两间（甚至把 A 组的半间与 B 组的半间配成一间）。改用房组内乘客 id 排序后拼成的
  // 稳定派生值：同一房组每次算出来都一样，不同房组必然不同。
  const baseId =
    typeof group.raw.id === 'string' && group.raw.id
      ? group.raw.id
      : `pax:${[...group.passengerIds].sort().join('|')}`;
  // 配对键：两个半组写同一个 key，房控按 key 把它们配回一间（不看性别 —— 夫妻拼房
  // 被拆开后正是「一男一女各半间」，按性别配对会算成两间）。
  const splitPairKey = `${baseId}:${pairToken}`;
  return {
    kept: { ...group.raw, passengerIds: keptIds, roomFraction: keptHalf / 2, splitPairKey },
    moved: {
      ...group.raw,
      id: `${baseId}-split`,
      passengerIds: movedIds,
      roomFraction: movedHalf / 2,
      splitPairKey,
    },
  };
}

/**
 * 拆单履约任务镜像：把新单拆分行的履约任务对齐到源单对应行的**同类型**任务状态。
 *
 * 只对**被拆的行**做（整行搬走的行连任务一起过户，状态本来就没丢）；只镜像岗位关心的字段
 * （状态 / data / 备注 / 起止时间），不动源单任务。
 * 源行若没有活动的同类型任务（只有 CANCELLED 或压根没有）则不动新任务，让它维持 PENDING。
 *
 * 覆盖出票 / 签证 / 酒店 / 接送四类：拆之前签证已送签、房已订、车已派，拆出来的新单却
 * 一水儿的「待处理」，各岗位会当成新活重办一遍（签证岗为此报过重复送签）。
 * BUNDLE_COMPOSITE 不镜像 —— 它只是「这条套餐行要拆成哪几个子任务」的容器，无岗位语义。
 */
const SPLIT_MIRRORED_TASK_TYPES = [
  FulfillmentType.FLIGHT_TICKETING,
  FulfillmentType.VISA_APPLICATION,
  FulfillmentType.HOTEL_BOOKING,
  FulfillmentType.TRANSFER_DISPATCH,
] as const;

async function mirrorTicketingTasksForSplit(
  tx: Prisma.TransactionClient,
  input: {
    newTaskIds: string[];
    /** 新单拆分行 id → 源单对应行 id */
    sourceItemIdByTargetItemId: Map<string, string>;
    /** 新任务备注里保留的拆单来源标注 */
    splitNote: string;
  },
): Promise<void> {
  const newTasks = await tx.fulfillmentTask.findMany({
    where: { id: { in: input.newTaskIds }, type: { in: [...SPLIT_MIRRORED_TASK_TYPES] } },
    select: { id: true, orderItemId: true, type: true },
  });
  const pairs = newTasks
    .map((task) => ({
      taskId: task.id,
      type: task.type,
      sourceItemId: input.sourceItemIdByTargetItemId.get(task.orderItemId),
    }))
    .filter(
      (p): p is { taskId: string; type: FulfillmentType; sourceItemId: string } =>
        p.sourceItemId != null,
    );
  if (pairs.length === 0) return;

  const sourceTasks = await tx.fulfillmentTask.findMany({
    where: {
      orderItemId: { in: [...new Set(pairs.map((p) => p.sourceItemId))] },
      type: { in: [...SPLIT_MIRRORED_TASK_TYPES] },
      status: { not: FulfillmentStatus.CANCELLED },
    },
    select: {
      orderItemId: true,
      type: true,
      status: true,
      data: true,
      notes: true,
      startedAt: true,
      completedAt: true,
      // 签证任务的成本三字段 + 签证公司是**人均**口径：签证行按人头劈开，新单那份人均成本与源单同值，
      // 不镜像过去财务在新单上就对不出这笔签证费属于哪家（与 9c 承接口径一致）。
      visaUnitCostUsd: true,
      visaFxRate: true,
      visaUnitCostCny: true,
      visaSupplier: true,
    },
  });
  // 按 (源行, 类型) 索引：一条行上可能同时挂着出票与签证任务，只按行取会串类型。
  const sourceByKey = new Map(sourceTasks.map((t) => [`${t.orderItemId}|${t.type}`, t]));
  for (const pair of pairs) {
    const source = sourceByKey.get(`${pair.sourceItemId}|${pair.type}`);
    if (!source) continue;
    await tx.fulfillmentTask.update({
      where: { id: pair.taskId },
      data: {
        status: source.status,
        data: source.data === null ? Prisma.DbNull : (source.data as Prisma.InputJsonValue),
        notes: [source.notes?.trim() || null, input.splitNote].filter(Boolean).join(' · '),
        startedAt: source.startedAt,
        completedAt: source.completedAt,
        ...(pair.type === FulfillmentType.VISA_APPLICATION
          ? {
              visaUnitCostUsd: source.visaUnitCostUsd,
              visaFxRate: source.visaFxRate,
              visaUnitCostCny: source.visaUnitCostCny,
              visaSupplier: source.visaSupplier,
            }
          : {}),
      },
    });
  }
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
export const CHANGE_BUNDLE_ITEM_SELECT = {
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
export function assertOrderChangeBundleAllowed(order: {
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
export function resolveChangeableBundleRow<T extends ChangeBundleCandidateRow>(
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
  // 起降地一并取出：改档按目标套餐派生航线取结算价日历（bundle-route.ts）
  outboundFlight: {
    select: { businessUpgradeCnyPerLeg: true, originCode: true, destinationCode: true },
  },
  returnFlight: {
    select: { businessUpgradeCnyPerLeg: true, originCode: true, destinationCode: true },
  },
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

// 「价格调整」商品行按乘客分组：实现已抽成叶子模块 order-adjustment-lines.ts（lib/order-money 要用它，
// 而 lib 不能反向 import 本文件），这里原样 re-export，所有既有 import 路径与算法一字不变。
export { groupPassengerAdjustments, type AdjustmentLine } from './order-adjustment-lines.js';
