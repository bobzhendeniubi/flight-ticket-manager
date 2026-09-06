# orders.service.ts 拆分盘点（2026-09-06）

> 审查根因 R5（`docs/反馈存档/2026-09-05-效率审查-C-反馈模式与根因.md`）：orders 巨石 + 售后动作无统一内核。
> 本文是拆分前的机械盘点，作为拆分边界与「一个不少」的对账表。原则：**纯机械、行为零变化**。

- 文件：`backend/src/modules/orders/orders.service.ts`，25567 行；`OrderService` 类 1896–19766 行（17871 行）。
- 类方法 109 个（另有 `pricing` 属性 1 个），其中 private 42 个；`$transaction` 35 处（按方法计）。
- 类外顶层声明 307 个（函数 / 常量 / 类型），类前约 1900 行、类后约 5800 行。
- 现有单测 / 集成测试文件（拆分边界）：见 §3。

## 1. 方法清单（按目标子模块分组）

列：方法 · 行数 · `$transaction` 数 · 调用的本类方法（`this.xxx`）。private 方法标 `(priv)`。

### read（列表/详情/序列化/筛选） → `service/read.ts`

共 12 个方法，583 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `resolveListOrdersWhere` (priv) | 109 | 0 | `getDescendantAgentIds` |
| `listOrders` | 75 | 1 | `resolveListOrdersWhere` |
| `getAgentStats` | 51 | 0 | `resolveListOrdersWhere` |
| `getOrder` | 69 | 0 | `assertCanView`, `loadBundleVisaStayDays` |
| `listDeletedOrders` | 90 | 1 | — |
| `loadBundleVisaStayDays` (priv) | 28 | 0 | — |
| `lookupOrderPublic` | 28 | 0 | — |
| `lookupOrderForReceiptUpload` | 41 | 0 | — |
| `getOrderItineraryData` | 61 | 0 | `assertCanView` |
| `assertCanView` (priv) | 14 | 0 | `getDescendantAgentIds` |
| `resolveExportAgentScope` | 4 | 0 | `getDescendantAgentIds` |
| `getDescendantAgentIds` (priv) | 13 | 0 | — |

### status（状态机/软删/开票标记） → `service/status.ts`

共 13 个方法，1446 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `advanceOrderToPaidIfClearedWithinTx` | 27 | 0 | `_updateStatusWithinTx` |
| `softDeleteOrder` | 41 | 0 | — |
| `restoreOrder` | 17 | 0 | — |
| `updateStatus` | 72 | 1 | `_updateStatusWithinTx` |
| `batchUpdateStatus` | 48 | 0 | `updateStatus` |
| `setInvoiceFlags` | 133 | 1 | `updateStatus` |
| `batchSetInvoiceFlags` | 47 | 0 | `setInvoiceFlags` |
| `_updateStatusWithinTx` | 744 | 0 | `_computeRefundRatioByKind`, `assertCanTransition`, `assertRefundRejectionHotelCapacity` |
| `assertRefundRejectionHotelCapacity` (priv) | 79 | 0 | — |
| `_computeRefundRatioByKind` (priv) | 64 | 0 | — |
| `requestChange` | 44 | 1 | `_updateStatusWithinTx`, `assertCanView`, `getOrder` |
| `assertCanTransition` (priv) | 36 | 0 | `getDescendantAgentIds` |
| `requestCancellation` | 94 | 1 | `_updateStatusWithinTx`, `assertCanView` |

### funds-links（超收处置/余额抵扣/锁收款/换人退款） → `service/funds-links.ts`

共 9 个方法，765 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `_recordOverpayDisposalPayment` (priv) | 29 | 0 | — |
| `_latestInboundPaymentMethod` (priv) | 11 | 0 | — |
| `creditOverpayToAgent` | 102 | 1 | `_latestInboundPaymentMethod`, `_recordOverpayDisposalPayment` |
| `applyAgentBalanceToOrder` | 135 | 1 | `_updateStatusWithinTx` |
| `overpayToPool` | 77 | 1 | `_latestInboundPaymentMethod`, `_recordOverpayDisposalPayment` |
| `batchSetSettlementLock` | 60 | 1 | — |
| `batchSetPaymentsLock` | 86 | 1 | — |
| `swapRefund` | 196 | 1 | `_updateStatusWithinTx` |
| `updateSwapReplacementOrderNumber` | 69 | 1 | — |

### pricing-adjust（调价/结算价） → `service/pricing-adjust.ts`

共 4 个方法，539 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `updateItemSettlementPrice` | 213 | 1 | — |
| `batchAddPriceAdjustment` | 154 | 1 | `_addPriceAdjustmentWithinTx` |
| `addPriceAdjustment` | 57 | 1 | `_addPriceAdjustmentWithinTx` |
| `_addPriceAdjustmentWithinTx` | 115 | 0 | — |

### create（建单/报价/批量） → `service/create.ts`

共 18 个方法，2923 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `createHoldConversionOrderWithinTx` | 126 | 0 | — |
| `createOrder` | 837 | 1 | `applyAgentSettlementDiscount`, `applyPassportExpiryRule`, `applyRetailSettlementDiscount`, `assertNoDuplicatePassengersOnFlights`, `priceAndValidateItems`, `resolveBundleSettlementCalendarTotal`, `resolveEarliestFlightDepartureDate`, `resolveFlightSettlementCalendarTotal` |
| `quoteOrder` | 145 | 0 | `applyAgentSettlementDiscount`, `applyRetailSettlementDiscount`, `priceAndValidateItems`, `resolveBundleSettlementCalendarTotal`, `resolveFlightSettlementCalendarTotal` |
| `resolveEarliestFlightDepartureDate` (priv) | 11 | 0 | — |
| `applyPassportExpiryRule` (priv) | 41 | 0 | — |
| `applyAgentSettlementDiscount` (priv) | 40 | 0 | — |
| `applyRetailSettlementDiscount` (priv) | 129 | 0 | `resolveBundleItemDepartureLocalDate` |
| `resolveBundleSettlementCalendarTotal` (priv) | 101 | 0 | `resolveDepartureLocalDate` |
| `resolveFlightSettlementCalendarTotal` (priv) | 78 | 0 | — |
| `resolveDepartureLocalDate` (priv) | 20 | 0 | — |
| `resolveAuthoritativeBundleGoDates` (priv) | 35 | 0 | — |
| `resolveBundleItemDepartureLocalDate` (priv) | 17 | 0 | `resolveAuthoritativeBundleGoDates` |
| `assertNoDuplicatePassengersOnFlights` (priv) | 102 | 0 | — |
| `priceAndValidateItems` (priv) | 804 | 0 | `assertBusinessAvailabilityForBundle`, `resolveAuthoritativeBundleGoDates` |
| `assertBusinessAvailabilityForBundle` (priv) | 31 | 0 | — |
| `batchCreateOrders` | 318 | 0 | `assertNoDuplicatePassengersOnFlights`, `createOrder`, `priceAndValidateItems`, `resolveBundleFlightLegs` |
| `resolveBundleFlightLegs` (priv) | 76 | 0 | `matchBundleScheduleByLocalDate` |
| `matchBundleScheduleByLocalDate` (priv) | 12 | 0 | — |

### passengers（乘客纠错/换人/签证） → `service/passengers.ts`

共 14 个方法，2422 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `selfUpdatePassenger` | 64 | 0 | `assertBackfilledDocumentNotDuplicated`, `assertCanView` |
| `assertBackfilledDocumentNotDuplicated` (priv) | 37 | 0 | — |
| `updatePassengerVisaDates` | 63 | 0 | — |
| `updatePassengerTicket` | 69 | 0 | — |
| `swapPassenger` | 748 | 1 | `assertPassengerEditScope`, `buildSwapBeforeSnapshot`, `resolveSwapRepriceQuote` |
| `buildSwapBeforeSnapshot` (priv) | 109 | 0 | — |
| `resolveSwapRepriceQuote` (priv) | 288 | 0 | `resolveSwapRepriceBasis` |
| `resolveSwapRepriceBasis` (priv) | 143 | 0 | — |
| `swapPreview` | 60 | 0 | `assertPassengerEditScope`, `resolveSwapRepriceQuote` |
| `assertPassengerEditScope` (priv) | 15 | 0 | `assertCanView` |
| `assertAgentSelfEditAllowed` | 33 | 0 | `assertCanView` |
| `setOrderVisaStatus` | 63 | 1 | — |
| `correctPassenger` | 332 | 1 | `assertBackfilledDocumentNotDuplicated`, `assertCanView` |
| `setPassengerVisaExempt` | 398 | 1 | — |

### reschedule（改期/升舱/纠错） → `service/reschedule.ts`

共 8 个方法，1569 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `batchReschedule` | 116 | 0 | `rescheduleOrderItem` |
| `rescheduleOrderItem` | 717 | 1 | `_updateStatusWithinTx` |
| `upgradeOrderItemCabin` | 269 | 1 | `assertAgentSelfEditAllowed` |
| `correctFlightSchedule` | 28 | 0 | `assertAgentSelfEditAllowed`, `assertSelfServiceCorrectionIsFreeOfCharge`, `rescheduleOrderItem` |
| `quoteFlightCorrectionDelta` | 36 | 0 | — |
| `assertSelfServiceCorrectionIsFreeOfCharge` (priv) | 14 | 0 | `quoteFlightCorrectionDelta` |
| `reschedulePassengers` | 356 | 0 | `_auditReschedulePassengers`, `rescheduleOrderItem`, `splitOrder` |
| `_auditReschedulePassengers` (priv) | 33 | 0 | — |

### hotel（换酒店/分房/改档/改代理/加项） → `service/hotel.ts`

共 7 个方法，2263 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `swapItemHotel` | 518 | 1 | `assertAgentSelfEditAllowed`, `loadBundleVisaStayDays` |
| `splitHotelItemByRoomGroup` | 248 | 1 | — |
| `rescheduleItemHotel` | 245 | 1 | — |
| `changeOrderAgent` | 297 | 1 | — |
| `addGroundItem` | 249 | 1 | — |
| `addRoomSupplement` | 261 | 1 | — |
| `changeOrderBundle` | 445 | 1 | — |

### split（拆单） → `service/split.ts`

共 5 个方法，1737 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `assessOrderSplit` (priv) | 535 | 0 | — |
| `previewOrderSplit` | 39 | 0 | `assessOrderSplit` |
| `splitOrder` | 138 | 1 | `executeSplitWithinTx`, `findSplitReplay` |
| `findSplitReplay` (priv) | 23 | 0 | — |
| `executeSplitWithinTx` (priv) | 1002 | 0 | `advanceOrderToPaidIfClearedWithinTx`, `assessOrderSplit` |

### legs（取消航段/no-show/恢复/作废回程） → `service/legs.ts`

共 19 个方法，2292 行。

| 方法 | 行 | tx | 调用本类方法 |
|---|---:|---:|---|
| `_assessCancelLeg` (priv) | 175 | 0 | — |
| `_quoteLegCancelFee` (priv) | 26 | 0 | — |
| `_describeLeg` (priv) | 13 | 0 | — |
| `previewCancelLeg` | 44 | 0 | `_assessCancelLeg`, `_describeLeg`, `_quoteLegCancelFee` |
| `previewCancelReturnLeg` | 6 | 0 | `previewCancelLeg` |
| `cancelLeg` | 405 | 1 | `_assessCancelLeg`, `_quoteLegCancelFee` |
| `cancelReturnLeg` | 7 | 0 | `cancelLeg` |
| `_assessNoShow` (priv) | 225 | 0 | `assessOrderSplitForNoShow` |
| `assessOrderSplitForNoShow` (priv) | 14 | 0 | `assessOrderSplit` |
| `_describeNoShowLeg` (priv) | 11 | 0 | — |
| `previewNoShow` | 41 | 0 | `_assessNoShow`, `_describeNoShowLeg` |
| `markNoShow` | 176 | 0 | `_assessNoShow`, `_executeNoShow`, `splitOrder` |
| `_executeNoShow` (priv) | 314 | 1 | `_assessNoShow` |
| `_assessRestoreReturnLeg` (priv) | 145 | 0 | — |
| `previewRestoreReturnLeg` | 70 | 0 | `_assessRestoreReturnLeg` |
| `restoreReturnLeg` | 449 | 1 | `_assessRestoreReturnLeg` |
| `previewVoidReturnLeg` | 15 | 0 | `_assessVoidReturnLeg` |
| `voidReturnLeg` | 66 | 1 | `_assessVoidReturnLeg` |
| `_assessVoidReturnLeg` (priv) | 90 | 0 | — |

## 2. 类外顶层声明归属

只列非类型声明（函数 / 常量）；类型 / 接口随其使用方进同一模块。

- **shared**（822 行）：`ORDER_STATUS_LABEL_ZH`*, `zhStatus`, `ALLOWED_TRANSITIONS`*, `SETTLEMENT_TIER_STAR_RATING`*, `SETTLEMENT_TIER_LABEL`*, `resolveHotelSettlementTier`*, `isSettlementTierStarMismatch`*, `buildStarMismatchMessage`*, `SEAT_HOLDING_STATUSES`*, `SEAT_RELEASING_STATUSES`*, `FULFILLMENT_TERMINATING_STATUSES`*, `AGENT_SELF_EDIT_STATUSES`, `AGENT_SELF_EDIT_REASON`*, `BUSINESS_DAY_MS`, `computeAgentSelfEditWindow`*, `SELF_EDITABLE_PASSENGER_STATUSES`, `CHANGE_REQUESTABLE_STATUSES`, `ITINERARY_READY_STATUSES`, `PRICE_TOLERANCE_CNY`, `PASSPORT_EXPIRY_SURCHARGE_DAYS`, `NEAR_EXPIRY_SURCHARGE_CNY`, `DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG`, `calendarKeyFingerprint`*, `readCalendarKey`*, `keyChangedDetail`, `isGuestRequester`, `RETAIL_PAYMENT_TIMEOUT_MS`, `STAFF_ENTRY_ROLES`, `RANDOM_TIER_INTERNAL_NO_CAP`*, `isStaffEnteredOrder`, `resolveHotelOversellCap`*, `resolveOrderAgentId`*, `addDaysToYmd`*, `buildPriceAdjustmentItem`*, `buildSettlementDiscountItem`*, `buildSettlementTotalItem`*, `resolveCalendarPerPaxBasis`*, `buildPerPassengerSettlementItem`*, `assertDisplayedTotalMatches`*, `shouldApplyRetailSettlementDiscount`*, `buildRoomSupplementItem`*, `CABIN_ZH_LABEL`, `computeCabinUpgradeDiffCny`*, `ECONOMY_CABIN_TEXT_RE`, `buildUpgradedCabinDescription`*, `resolveRoomSupplementCost`*, `computeSwapHotelCostSnapshot`*, `computeGroundItemAmounts`*, `resolveGroundItemUnitPrice`*, `resolveHasReturnLeg`*, `syncOrderHasReturnLeg`*, `syncOrderLegFlag`*, `sumAccruedCommissionCny`, `actorCan`, `ORDER_FULL_INCLUDE`, `DAY_MS`, `appendAdjustment`, `ptcToPassengerType`, `passengerToData`*, `generateOrderNumber`, `formatMonthDay`, `formatSlashMonthDay`, `formatHHMM`, `formatDateOnly`, `round2`, `round2Decimal`
- **seat-inventory**（198 行）：`computeOversellDelta`*, `computeDisplacedReserved`*, `cabinSeatStateWithinTx`, `lockSeatClassWithinTx`, `oversellSeatWithinTx`, `takeSeatWithinTx`*, `isLegAlreadyFlown`, `assertLegNotFlownForReschedule`, `releaseSeatFloored`*, `releaseSeatStrictWithinTx`*, `computeBundleSeatSplit`*
- **bundle-pricing**（538 行）：`MAX_STAY_NIGHTS`, `buildStayNightDates`*, `rewriteHotelStayDescription`*, `HOTEL_SOLD_OUT_MESSAGE`*, `assertRandomTierStaysFitWithinTx`*, `assertHotelStaysFitWithinTx`*, `resolveRandomTierNightlyCost`, `splitSettlementPriceAcrossLegs`*, `computeBundleGroundTotal`*, `resolveBundleHotelStamp`*, `resolveBundleOccupancy`*, `DEFAULT_ROOM_MAX_ADULTS`*, `DEFAULT_ROOM_MAX_CHILDREN`*, `computeRoomsNeeded`*, `toProspectiveOccupancy`*, `computeBundleRoomsCharged`*, `computeBundleOperationFeeTotal`*, `derivePerPaxBundleOptions`*, `resolveBundleBusinessUpgradeRate`*, `resolveBundleBusinessUpgradeInput`*, `computeBundleAddOn`*, `computeRequiredPassengerCount`*
- **leg-action-log**（197 行）：`legActionFingerprint`, `noShowFingerprint`, `cancelLegFingerprint`, `rescheduleAllFingerprint`, `EMPTY_LEG_ACTION_FINGERPRINT`, `readLegActionLog`, `LEG_SNAPSHOT_ACTION_TYPE`, `collectLegActionEntries`, `hasSeenLegActionToken`, `assertLegActionTokenReplay`, `appendLegActionLog`, `ORCHESTRATION_DERIVED_KEYS`, `orchestrationFingerprint`, `readOrchestrationLeg`, `reschedulePassengersOrchestration`, `tokenPayloadMismatchError`, `rescheduleTokenInFlightError`, `assertNonEmptyPassengerSelection`, `readJsonObject`
- **read**（1106 行）：`AGENT_STATS_UNKNOWN_AGENT_LABEL`, `BUSINESS_UTC_OFFSET`, `resolveCreatedAtBoundary`, `SEARCH_TERM_SEPARATORS`, `MAX_SEARCH_TERMS`, `MAX_PASSENGER_NAME_TERMS`*, `splitSearchTerms`*, `buildSearchTermClause`*, `GUEST_RECORDED_BY_LABEL`*, `applyExportAgentScope`*, `withoutAgentHiddenFilters`*, `buildOrderFilterWhere`*, `deriveOrderDepartDate`, `filterOrderIdsByDepartDate`*, `deriveOrderReturnDate`*, `filterOrderIdsByReturnDate`*, `filterOrderIdsByFlightDate`*, `filterOrderIdsByLegFlightNumber`*, `decimalOrNull`, `summarizeBundleItems`*, `itineraryFieldsForItem`, `deriveBundlePerAgeUnitPrices`*, `findBundlePricingConfig`, `serializePassengerRecord`, `REDACTED_ITEM_METADATA_KEYS`, `redactItemMetadataForExternal`, `RECONCILE_NOTE_PREFIX`, `serializePaymentRecord`, `serializeRefundRecord`, `serializeOrder`*, `orderSerializeRoleCtx`*, `maskFamilyName`*, `maskOrderForPublic`, `hasFlightChanged`, `maskedItemTravelDate`
- **commission**（253 行）：`ORDER_ITEM_KIND_TO_PRODUCT_KIND`, `createCommissionsForOrder`
- **visa-sync**（459 行）：`carryVisaTaskForSplit`, `KIND_TO_FULFILLMENT_TYPE`, `BUNDLE_COMPONENT_KIND_TO_TYPE`, `resolveBundleFulfillmentTypes`, `createFulfillmentTasks`, `resolveVisaTaskAnchor`, `createVisaTaskAtCreation`, `evaluateOrderVisaTaskState`, `syncVisaTasksForOrder`
- **create**（174 行）：`sanitizeFlightItemMetadata`, `resolveRequestedExpressTierLabel`, `parseBatchYmd`, `deriveBatchBundlePassengerCounts`*, `buildBatchItems`*, `latinPassengerNameKey`, `chinesePassengerNameKey`, `duplicateForceNoteFor`, `assertVisaPassengersHavePassportExpiry`*, `assertAmountWithinTolerance`*
- **passengers**（82 行）：`CORRECTABLE_IDENTITY_FIELDS`, `CORRECTION_NAME_FIELDS`, `CORRECTION_NAME_MAX_EDIT_DISTANCE`, `normalizeDocumentNumber`*, `normalizeCorrectionName`*, `SWAP_FEE_OPTIONS_SETTING_KEY`*, `DEFAULT_SWAP_FEE_OPTIONS_CNY`*, `getSwapFeeOptions`*, `readOrderSettlementCalendarAudit`
- **reschedule**（8 行）：`rescheduleCommittedContexts`, `rescheduleCommittedContext`, `RELEASED_LEG_NO_SCHEDULE_HINT`
- **hotel**（190 行）：`CHANGE_BUNDLE_ITEM_SELECT`*, `assertOrderChangeBundleAllowed`*, `resolveChangeableBundleRow`*, `sumBundleChangeDiffCny`*, `CHANGE_BUNDLE_PRICING_SELECT`, `computeChangedBundleLine`*
- **split**（365 行）：`loadOrderForSplit`, `readRoomGroups`, `sumFlightQuantities`, `toSplitItemView`, `splitNoneUpdateToPrisma`*, `splitPatchToPrisma`, `sumFlightUpgradeCounts`, `sumRoomsBilledHalves`, `sumTotalCostCents`, `buildSplitSuggestionContext`, `buildSplitContext`, `resolveSplitFlightLegs`, `collectSplitUpgradeItems`, `splitMixedRoomGroup`, `SPLIT_MIRRORED_TASK_TYPES`, `mirrorTicketingTasksForSplit`, `createSplitBalanceItem`, `isUniqueViolation`
- **legs**（224 行）：`LEG_ZH`, `LEG_CANCELLED_PREFIX`, `LEG_CANCEL_FEE_REASON`, `loadOrderForLegCancel`, `readSnapshotDate`, `resolveReturnReleaseState`, `stripNoShowPrefix`, `stripReturnReleasedPrefix`, `voidReleasedReturnLegWithinTx`*, `buildTicketWorkOrderTitle`, `createTicketWorkOrder`, `notifyWorkOrderCreatedToWecom`

`*` = 拆分前已 `export`，拆分后由 facade 原名再导出（`export { … } from './service/<group>.js'`）。

## 3. 测试文件边界（拆分依据）

| 子模块 | 主要测试文件（`backend/src/modules/orders/`） |
|---|---|
| create | orders.service.test.ts（createOrder / quoteOrder / batchCreateOrders）、orders.duplicate-passenger、orders.bundle-tier-guard、orders.bundle-flight-guard、orders.batch-*、orders.random-star-pool、orders.per-pax-settlement、orders.settlement-total、orders.settlement-preview、orders.flight-settlement-calendar、orders.visa-contradiction、orders.hold-conversion-cas |
| read | orders.list-channel、orders.serialize-redaction、orders.agent-stats、orders.search-visa-anchor-filter、orders.export-*（buildOrderFilterWhere 调用方） |
| status | orders.status-seats、orders.status-transitions-contract、orders.status-account-guards、orders.soft-delete、orders.recycle-bin、orders.batch-invoice-flags、orders.payment-timeout、orders.post-sale-guards |
| funds-links | orders.agent-balance.integration、orders.funds-window.integration、orders.money-guards、orders.settlement-lock、orders.batch-finance、orders.swap-refund(+integration)、orders.prepayment-refund.integration |
| passengers | orders.self-service、orders.agent-self-edit、orders.swap-reprice、orders.visa-dates、orders.visa-exempt-toggle、orders.visa-not-needed、orders.ticket-entry、orders.order-edit.integration |
| split | orders.split、orders.split-bundle.integration、orders.split-visa.integration、orders.split-room-group、split-move-strategies、split-pair-backfill |
| reschedule | orders.reschedule-passengers、orders.batch-reschedule、orders.cabin-upgrade、orders.agent-self-edit-reschedule、orders.hotel-reschedule |
| legs | orders.cancel-return-leg、orders.no-show、orders.no-show.integration、orders.no-show-void、orders.leg-status、no-show-batch（调用方） |
| hotel | orders.hotel-swap(+integration)、orders.hotel-swap-cost、orders.hotel-inventory-guard、orders.hotel-inventory-concurrency.integration、orders.room-supplement(+integration)、orders.agent-change(+integration)、orders.split-room-group |
| pricing-adjust | orders.price-adjustment(+integration)、orders.passenger-adjustment(+integration)、orders.batch-manual-price、orders.settlement-lock、orders.batch-settlement.integration |
| commission | orders.commission-bundle-kind、orders.commission-depart-rate、orders.commission-discount-net-base |
| visa-sync | orders.visa-task-sync、orders.split-visa.integration |

## 4. 拆分手法（与第二阶段 A 一致：抽成叶子模块 + 原位 re-export）

1. `orders.service.ts` 保留为 **facade**：`OrderService` 类每个方法签名不变，方法体变成一行转调 `groupSvc.method(this, …)`；类外所有原本 `export` 的名字由 facade `export { … } from './service/<group>.js'` 原名再导出。routes / 其它模块 / 测试的 import 路径一个不改。
2. 方法体搬到 `service/<group>.ts` 时写成 `export function method(svc: OrderService, …)`，体内 `this.xxx` 一律改 `svc.xxx`——跨组调用仍走 facade 实例，所以单测里 `vi.spyOn(service, 'rescheduleOrderItem')` 一类 spy 行为不变（`reschedulePassengers` 内部调 `svc.rescheduleOrderItem` 会命中 spy，与拆分前 `this.rescheduleOrderItem` 一致）。
3. 原 `private` 方法为让子模块通过 `svc.` 调用而去掉 `private` 修饰（运行时无差异；测试本来就用 `(service as any)._xxx`）。
4. 子模块之间：常量 / 类型 / 纯函数进 `shared.ts`（无兄弟依赖的叶子）；`seat-inventory`（座位 CAS）、`bundle-pricing`（套餐占用 / 房数 / 酒店库存闸）、`leg-action-log`（航段动作留痕 / 幂等 token）三个叶子只依赖 shared；业务组只 `import type { OrderService }`（类型导入，运行时无环）。
5. 动态 `import('../../queues/queue.js')` 因目录深一层改成 `'../../../…'`，其余一字不动。
6. 抽取顺序按依赖：叶子（shared / seat-inventory / bundle-pricing / leg-action-log）→ read → commission → visa-sync → status → funds-links → pricing-adjust → create → passengers → reschedule → hotel → split → legs；每抽一组跑一次全量单测再 commit。
7. 拆完再加 `service/order-mutation.ts` 内核（行锁 / 幂等 / 审计进事务 / 守恒断言），先接拆单 / no-show / 取消航段 / 恢复回程 / 作废回程 / 换人 / 按人改期七条；其它写路径留清单不动。
