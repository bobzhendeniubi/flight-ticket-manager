/**
 * Prisma 枚举镜像（本包**不依赖** @prisma/client）
 *
 * 为什么镜像而不是直接 import：契约包要被两套 Vite 前端打进浏览器 bundle，而
 * @prisma/client 是带 native engine 的服务端包，进不了浏览器；前端也不该为了知道
 * 「订单有哪些状态」而装一份 Prisma。所以这里按 schema.prisma 抄一份纯字符串枚举，
 * 前后端共用同一份事实源。
 *
 * 漂移怎么防：后端 src/lib/prisma-enum-mirror.test.ts 逐个断言
 * Object.values(PrismaEnum) 与本文件同名镜像的值集合完全相等 —— schema.prisma 改了
 * 枚举而这里没跟，那条测试立刻红。**改枚举请先改 schema.prisma，再同步本文件。**
 *
 * 命名约定（每个枚举四件套）：
 *   · XXX_VALUES     值元组（as const），顺序与 schema.prisma 声明顺序一致
 *   · xxxSchema      z.enum(XXX_VALUES)，给请求体 / 查询参数用
 *   · const Xxx      { KEY: 'KEY' } 值对象，形状与 @prisma/client 生成的完全一致
 *   · type Xxx       字符串联合类型
 *
 * 后两件是刻意跟 Prisma 同名同形的：从本包 import OrderStatus 之后，
 * OrderStatus.CANCELLED（值）与 status: OrderStatus（类型）都照旧能写，
 * 搬 schema 的时候不用把值引用改成裸字符串。
 *
 * 本文件由 schema.prisma 机械抄写而来，不要在这里改口径。
 */
import { z } from 'zod';


export const USER_ROLE_VALUES = [
  'CUSTOMER',
  'AGENT',
  'STAFF',
  'ADMIN',
] as const;
export const userRoleSchema = z.enum(USER_ROLE_VALUES);
export const UserRole = {
  CUSTOMER: 'CUSTOMER',
  AGENT: 'AGENT',
  STAFF: 'STAFF',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof USER_ROLE_VALUES)[number];

export const DOCUMENT_TYPE_VALUES = [
  'ID_CARD',
  'PASSPORT',
] as const;
export const documentTypeSchema = z.enum(DOCUMENT_TYPE_VALUES);
export const DocumentType = {
  ID_CARD: 'ID_CARD',
  PASSPORT: 'PASSPORT',
} as const;
export type DocumentType = (typeof DOCUMENT_TYPE_VALUES)[number];

export const PASSENGER_TYPE_VALUES = [
  'ADULT',
  'CHILD',
  'INFANT',
] as const;
export const passengerTypeSchema = z.enum(PASSENGER_TYPE_VALUES);
export const PassengerType = {
  ADULT: 'ADULT',
  CHILD: 'CHILD',
  INFANT: 'INFANT',
} as const;
export type PassengerType = (typeof PASSENGER_TYPE_VALUES)[number];

export const GENDER_VALUES = [
  'M',
  'F',
  'X',
] as const;
export const genderSchema = z.enum(GENDER_VALUES);
export const Gender = {
  M: 'M',
  F: 'F',
  X: 'X',
} as const;
export type Gender = (typeof GENDER_VALUES)[number];

export const REMINDER_STATUS_VALUES = [
  'OPEN',
  'IN_PROGRESS',
  'DONE',
  'SKIPPED',
] as const;
export const reminderStatusSchema = z.enum(REMINDER_STATUS_VALUES);
export const ReminderStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
  SKIPPED: 'SKIPPED',
} as const;
export type ReminderStatus = (typeof REMINDER_STATUS_VALUES)[number];

export const REMINDER_PRIORITY_VALUES = [
  'LOW',
  'NORMAL',
  'HIGH',
  'CRITICAL',
] as const;
export const reminderPrioritySchema = z.enum(REMINDER_PRIORITY_VALUES);
export const ReminderPriority = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type ReminderPriority = (typeof REMINDER_PRIORITY_VALUES)[number];

export const STAFF_ROLE_VALUES = [
  'VISA_DESK',
  'TICKETING',
  'ROOM_CONTROL',
  'FINANCE',
  'OPERATIONS',
] as const;
export const staffRoleSchema = z.enum(STAFF_ROLE_VALUES);
export const StaffRole = {
  VISA_DESK: 'VISA_DESK',
  TICKETING: 'TICKETING',
  ROOM_CONTROL: 'ROOM_CONTROL',
  FINANCE: 'FINANCE',
  OPERATIONS: 'OPERATIONS',
} as const;
export type StaffRole = (typeof STAFF_ROLE_VALUES)[number];

export const AUDIT_SEVERITY_VALUES = [
  'INFO',
  'WARNING',
  'CRITICAL',
] as const;
export const auditSeveritySchema = z.enum(AUDIT_SEVERITY_VALUES);
export const AuditSeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
} as const;
export type AuditSeverity = (typeof AUDIT_SEVERITY_VALUES)[number];

export const AUDIT_TARGET_TYPE_VALUES = [
  'AGENT',
  'ORDER',
  'FLIGHT',
  'CUSTOMER',
  'TRAVELER',
  'PRICING',
  'COMMISSION',
  'SETTLEMENT',
  'PRODUCT',
  'AUTH',
  'MARKETING',
  'SYSTEM',
] as const;
export const auditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPE_VALUES);
export const AuditTargetType = {
  AGENT: 'AGENT',
  ORDER: 'ORDER',
  FLIGHT: 'FLIGHT',
  CUSTOMER: 'CUSTOMER',
  TRAVELER: 'TRAVELER',
  PRICING: 'PRICING',
  COMMISSION: 'COMMISSION',
  SETTLEMENT: 'SETTLEMENT',
  PRODUCT: 'PRODUCT',
  AUTH: 'AUTH',
  MARKETING: 'MARKETING',
  SYSTEM: 'SYSTEM',
} as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPE_VALUES)[number];

export const SETTLEMENT_MODE_VALUES = [
  'PER_ORDER',
  'MONTHLY',
] as const;
export const settlementModeSchema = z.enum(SETTLEMENT_MODE_VALUES);
export const SettlementMode = {
  PER_ORDER: 'PER_ORDER',
  MONTHLY: 'MONTHLY',
} as const;
export type SettlementMode = (typeof SETTLEMENT_MODE_VALUES)[number];

export const PREPAYMENT_TX_TYPE_VALUES = [
  'TOP_UP',
  'OFFSET',
  'ADJUSTMENT',
  'REFUND',
] as const;
export const prepaymentTxTypeSchema = z.enum(PREPAYMENT_TX_TYPE_VALUES);
export const PrepaymentTxType = {
  TOP_UP: 'TOP_UP',
  OFFSET: 'OFFSET',
  ADJUSTMENT: 'ADJUSTMENT',
  REFUND: 'REFUND',
} as const;
export type PrepaymentTxType = (typeof PREPAYMENT_TX_TYPE_VALUES)[number];

export const AGENT_RECHARGE_STATUS_VALUES = [
  'PENDING',
  'CONFIRMED',
  'REJECTED',
] as const;
export const agentRechargeStatusSchema = z.enum(AGENT_RECHARGE_STATUS_VALUES);
export const AgentRechargeStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
} as const;
export type AgentRechargeStatus = (typeof AGENT_RECHARGE_STATUS_VALUES)[number];

export const PRODUCT_KIND_VALUES = [
  'FLIGHT',
  'HOTEL',
  'TRANSFER',
  'VISA',
  'BUNDLE',
] as const;
export const productKindSchema = z.enum(PRODUCT_KIND_VALUES);
export const ProductKind = {
  FLIGHT: 'FLIGHT',
  HOTEL: 'HOTEL',
  TRANSFER: 'TRANSFER',
  VISA: 'VISA',
  BUNDLE: 'BUNDLE',
} as const;
export type ProductKind = (typeof PRODUCT_KIND_VALUES)[number];

export const COMMISSION_STATUS_VALUES = [
  'ACCRUED',
  'SETTLEMENT_REQUESTED',
  'SETTLED',
  'REVERSED',
] as const;
export const commissionStatusSchema = z.enum(COMMISSION_STATUS_VALUES);
export const CommissionStatus = {
  ACCRUED: 'ACCRUED',
  SETTLEMENT_REQUESTED: 'SETTLEMENT_REQUESTED',
  SETTLED: 'SETTLED',
  REVERSED: 'REVERSED',
} as const;
export type CommissionStatus = (typeof COMMISSION_STATUS_VALUES)[number];

export const SETTLEMENT_STATUS_VALUES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PAID',
  'VOIDED',
] as const;
export const settlementStatusSchema = z.enum(SETTLEMENT_STATUS_VALUES);
export const SettlementStatus = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  VOIDED: 'VOIDED',
} as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUS_VALUES)[number];

export const CABIN_CLASS_VALUES = [
  'ECONOMY',
  'PREMIUM_ECONOMY',
  'BUSINESS',
  'FIRST',
] as const;
export const cabinClassSchema = z.enum(CABIN_CLASS_VALUES);
export const CabinClass = {
  ECONOMY: 'ECONOMY',
  PREMIUM_ECONOMY: 'PREMIUM_ECONOMY',
  BUSINESS: 'BUSINESS',
  FIRST: 'FIRST',
} as const;
export type CabinClass = (typeof CABIN_CLASS_VALUES)[number];

export const SEAT_LOCK_STATUS_VALUES = [
  'ACTIVE',
  'EXPIRED',
  'CONSUMED',
  'RELEASED',
] as const;
export const seatLockStatusSchema = z.enum(SEAT_LOCK_STATUS_VALUES);
export const SeatLockStatus = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
} as const;
export type SeatLockStatus = (typeof SEAT_LOCK_STATUS_VALUES)[number];

export const SEAT_ALLOCATION_STATUS_VALUES = [
  'ACTIVE',
  'RECLAIMED',
] as const;
export const seatAllocationStatusSchema = z.enum(SEAT_ALLOCATION_STATUS_VALUES);
export const SeatAllocationStatus = {
  ACTIVE: 'ACTIVE',
  RECLAIMED: 'RECLAIMED',
} as const;
export type SeatAllocationStatus = (typeof SEAT_ALLOCATION_STATUS_VALUES)[number];

export const HOLD_ORDER_STATUS_VALUES = [
  'PENDING',
  'HOLDING',
  'OVERDUE',
  'FULLY_PAID',
  'CONVERTED',
  'RELEASED',
  'CANCELLED',
] as const;
export const holdOrderStatusSchema = z.enum(HOLD_ORDER_STATUS_VALUES);
export const HoldOrderStatus = {
  PENDING: 'PENDING',
  HOLDING: 'HOLDING',
  OVERDUE: 'OVERDUE',
  FULLY_PAID: 'FULLY_PAID',
  CONVERTED: 'CONVERTED',
  RELEASED: 'RELEASED',
  CANCELLED: 'CANCELLED',
} as const;
export type HoldOrderStatus = (typeof HOLD_ORDER_STATUS_VALUES)[number];

export const HOLD_OWNER_TYPE_VALUES = [
  'AGENT',
  'CUSTOMER',
] as const;
export const holdOwnerTypeSchema = z.enum(HOLD_OWNER_TYPE_VALUES);
export const HoldOwnerType = {
  AGENT: 'AGENT',
  CUSTOMER: 'CUSTOMER',
} as const;
export type HoldOwnerType = (typeof HOLD_OWNER_TYPE_VALUES)[number];

export const HOLD_INSTALLMENT_STATUS_VALUES = [
  'PENDING',
  'PAID',
] as const;
export const holdInstallmentStatusSchema = z.enum(HOLD_INSTALLMENT_STATUS_VALUES);
export const HoldInstallmentStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
} as const;
export type HoldInstallmentStatus = (typeof HOLD_INSTALLMENT_STATUS_VALUES)[number];

export const HOLD_AMOUNT_RULE_VALUES = [
  'PER_PERSON_FIXED',
  'REMAINDER',
] as const;
export const holdAmountRuleSchema = z.enum(HOLD_AMOUNT_RULE_VALUES);
export const HoldAmountRule = {
  PER_PERSON_FIXED: 'PER_PERSON_FIXED',
  REMAINDER: 'REMAINDER',
} as const;
export type HoldAmountRule = (typeof HOLD_AMOUNT_RULE_VALUES)[number];

export const HOLD_OVERDUE_ACTION_VALUES = [
  'REMIND_ONLY',
  'AUTO_RELEASE',
] as const;
export const holdOverdueActionSchema = z.enum(HOLD_OVERDUE_ACTION_VALUES);
export const HoldOverdueAction = {
  REMIND_ONLY: 'REMIND_ONLY',
  AUTO_RELEASE: 'AUTO_RELEASE',
} as const;
export type HoldOverdueAction = (typeof HOLD_OVERDUE_ACTION_VALUES)[number];

export const HOLD_OCCUPY_ON_VALUES = [
  'CREATE',
  'FULL_PAYMENT',
] as const;
export const holdOccupyOnSchema = z.enum(HOLD_OCCUPY_ON_VALUES);
export const HoldOccupyOn = {
  CREATE: 'CREATE',
  FULL_PAYMENT: 'FULL_PAYMENT',
} as const;
export type HoldOccupyOn = (typeof HOLD_OCCUPY_ON_VALUES)[number];

export const SETTLEMENT_REQUEST_STATUS_VALUES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;
export const settlementRequestStatusSchema = z.enum(SETTLEMENT_REQUEST_STATUS_VALUES);
export const SettlementRequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type SettlementRequestStatus = (typeof SETTLEMENT_REQUEST_STATUS_VALUES)[number];

export const BUNDLE_CHANGE_REQUEST_STATUS_VALUES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;
export const bundleChangeRequestStatusSchema = z.enum(BUNDLE_CHANGE_REQUEST_STATUS_VALUES);
export const BundleChangeRequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type BundleChangeRequestStatus = (typeof BUNDLE_CHANGE_REQUEST_STATUS_VALUES)[number];

export const ORDER_CHANGE_KIND_VALUES = [
  'FLIGHT',
  'VISA',
  'HOTEL',
  'CABIN',
  'SPLIT',
  'CANCEL_LEG',
  'VISA_EXEMPT',
] as const;
export const orderChangeKindSchema = z.enum(ORDER_CHANGE_KIND_VALUES);
export const OrderChangeKind = {
  FLIGHT: 'FLIGHT',
  VISA: 'VISA',
  HOTEL: 'HOTEL',
  CABIN: 'CABIN',
  SPLIT: 'SPLIT',
  CANCEL_LEG: 'CANCEL_LEG',
  VISA_EXEMPT: 'VISA_EXEMPT',
} as const;
export type OrderChangeKind = (typeof ORDER_CHANGE_KIND_VALUES)[number];

export const ORDER_CHANGE_REQUEST_STATUS_VALUES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
] as const;
export const orderChangeRequestStatusSchema = z.enum(ORDER_CHANGE_REQUEST_STATUS_VALUES);
export const OrderChangeRequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type OrderChangeRequestStatus = (typeof ORDER_CHANGE_REQUEST_STATUS_VALUES)[number];

export const WAITLIST_STATUS_VALUES = [
  'ACTIVE',
  'NOTIFIED',
  'FULFILLED',
  'CANCELLED',
] as const;
export const waitlistStatusSchema = z.enum(WAITLIST_STATUS_VALUES);
export const WaitlistStatus = {
  ACTIVE: 'ACTIVE',
  NOTIFIED: 'NOTIFIED',
  FULFILLED: 'FULFILLED',
  CANCELLED: 'CANCELLED',
} as const;
export type WaitlistStatus = (typeof WAITLIST_STATUS_VALUES)[number];

export const VISA_ISSUANCE_METHOD_VALUES = [
  'E_VISA',
  'STICKER',
  'ARRIVAL',
  'OTHER',
] as const;
export const visaIssuanceMethodSchema = z.enum(VISA_ISSUANCE_METHOD_VALUES);
export const VisaIssuanceMethod = {
  E_VISA: 'E_VISA',
  STICKER: 'STICKER',
  ARRIVAL: 'ARRIVAL',
  OTHER: 'OTHER',
} as const;
export type VisaIssuanceMethod = (typeof VISA_ISSUANCE_METHOD_VALUES)[number];

export const VISA_ENTRY_TYPE_VALUES = [
  'SINGLE',
  'MULTIPLE',
] as const;
export const visaEntryTypeSchema = z.enum(VISA_ENTRY_TYPE_VALUES);
export const VisaEntryType = {
  SINGLE: 'SINGLE',
  MULTIPLE: 'MULTIPLE',
} as const;
export type VisaEntryType = (typeof VISA_ENTRY_TYPE_VALUES)[number];

export const VISA_SUBMISSION_STATUS_VALUES = [
  'PENDING',
  'IN_PROGRESS',
  'CONFIRMED',
] as const;
export const visaSubmissionStatusSchema = z.enum(VISA_SUBMISSION_STATUS_VALUES);
export const VisaSubmissionStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  CONFIRMED: 'CONFIRMED',
} as const;
export type VisaSubmissionStatus = (typeof VISA_SUBMISSION_STATUS_VALUES)[number];

export const SETTLEMENT_TIER_VALUES = [
  'CITY_3STAR',
  'CITY_4STAR',
  'CITY_5STAR',
  'INTL_5STAR',
] as const;
export const settlementTierSchema = z.enum(SETTLEMENT_TIER_VALUES);
export const SettlementTier = {
  CITY_3STAR: 'CITY_3STAR',
  CITY_4STAR: 'CITY_4STAR',
  CITY_5STAR: 'CITY_5STAR',
  INTL_5STAR: 'INTL_5STAR',
} as const;
export type SettlementTier = (typeof SETTLEMENT_TIER_VALUES)[number];

export const SETTLEMENT_DISCOUNT_KIND_VALUES = [
  'AGENT',
  'AGENT_DEFAULT',
  'RETAIL',
] as const;
export const settlementDiscountKindSchema = z.enum(SETTLEMENT_DISCOUNT_KIND_VALUES);
export const SettlementDiscountKind = {
  AGENT: 'AGENT',
  AGENT_DEFAULT: 'AGENT_DEFAULT',
  RETAIL: 'RETAIL',
} as const;
export type SettlementDiscountKind = (typeof SETTLEMENT_DISCOUNT_KIND_VALUES)[number];

export const SUPPLIER_TYPE_VALUES = [
  'AIRLINE',
  'HOTEL',
  'VISA_AGENCY',
  'TRANSFER',
  'OTHER',
] as const;
export const supplierTypeSchema = z.enum(SUPPLIER_TYPE_VALUES);
export const SupplierType = {
  AIRLINE: 'AIRLINE',
  HOTEL: 'HOTEL',
  VISA_AGENCY: 'VISA_AGENCY',
  TRANSFER: 'TRANSFER',
  OTHER: 'OTHER',
} as const;
export type SupplierType = (typeof SUPPLIER_TYPE_VALUES)[number];

export const SUPPLIER_INVOICE_PERIOD_KIND_VALUES = [
  'FLIGHT_SCHEDULE',
  'MONTH',
  'CUSTOM',
] as const;
export const supplierInvoicePeriodKindSchema = z.enum(SUPPLIER_INVOICE_PERIOD_KIND_VALUES);
export const SupplierInvoicePeriodKind = {
  FLIGHT_SCHEDULE: 'FLIGHT_SCHEDULE',
  MONTH: 'MONTH',
  CUSTOM: 'CUSTOM',
} as const;
export type SupplierInvoicePeriodKind = (typeof SUPPLIER_INVOICE_PERIOD_KIND_VALUES)[number];

export const SUPPLIER_INVOICE_STATUS_VALUES = [
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_PAID',
  'PAID',
  'DISPUTED',
] as const;
export const supplierInvoiceStatusSchema = z.enum(SUPPLIER_INVOICE_STATUS_VALUES);
export const SupplierInvoiceStatus = {
  DRAFT: 'DRAFT',
  CONFIRMED: 'CONFIRMED',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  DISPUTED: 'DISPUTED',
} as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUS_VALUES)[number];

export const INVOICE_TYPE_VALUES = [
  'VAT_SPECIAL',
  'VAT_GENERAL',
  'RECEIPT',
] as const;
export const invoiceTypeSchema = z.enum(INVOICE_TYPE_VALUES);
export const InvoiceType = {
  VAT_SPECIAL: 'VAT_SPECIAL',
  VAT_GENERAL: 'VAT_GENERAL',
  RECEIPT: 'RECEIPT',
} as const;
export type InvoiceType = (typeof INVOICE_TYPE_VALUES)[number];

export const INVOICE_RECORD_STATUS_VALUES = [
  'REQUESTED',
  'ISSUED',
  'VOID',
] as const;
export const invoiceRecordStatusSchema = z.enum(INVOICE_RECORD_STATUS_VALUES);
export const InvoiceRecordStatus = {
  REQUESTED: 'REQUESTED',
  ISSUED: 'ISSUED',
  VOID: 'VOID',
} as const;
export type InvoiceRecordStatus = (typeof INVOICE_RECORD_STATUS_VALUES)[number];

export const PRODUCT_REVIEW_TYPE_VALUES = [
  'BUNDLE',
  'HOTEL',
  'TRANSFER',
  'VISA',
  'FLIGHT',
] as const;
export const productReviewTypeSchema = z.enum(PRODUCT_REVIEW_TYPE_VALUES);
export const ProductReviewType = {
  BUNDLE: 'BUNDLE',
  HOTEL: 'HOTEL',
  TRANSFER: 'TRANSFER',
  VISA: 'VISA',
  FLIGHT: 'FLIGHT',
} as const;
export type ProductReviewType = (typeof PRODUCT_REVIEW_TYPE_VALUES)[number];

export const ORDER_STATUS_VALUES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'PAYMENT_TIMEOUT',
  'CANCELLED',
  'REFUND_REQUESTED',
  'REFUNDED',
  'CHANGE_REQUESTED',
  'CHANGED',
  'FAILED',
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUS_VALUES);
export const OrderStatus = {
  DRAFT: 'DRAFT',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  PROCESSING: 'PROCESSING',
  TICKETED: 'TICKETED',
  COMPLETED: 'COMPLETED',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  CANCELLED: 'CANCELLED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUNDED: 'REFUNDED',
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  CHANGED: 'CHANGED',
  FAILED: 'FAILED',
} as const;
export type OrderStatus = (typeof ORDER_STATUS_VALUES)[number];

export const VISA_REQUIREMENT_VALUES = [
  'NOT_NEEDED',
  'NEEDED',
  'E_VISA',
  'HAS_VISA',
] as const;
export const visaRequirementSchema = z.enum(VISA_REQUIREMENT_VALUES);
export const VisaRequirement = {
  NOT_NEEDED: 'NOT_NEEDED',
  NEEDED: 'NEEDED',
  E_VISA: 'E_VISA',
  HAS_VISA: 'HAS_VISA',
} as const;
export type VisaRequirement = (typeof VISA_REQUIREMENT_VALUES)[number];

export const ORDER_ITEM_KIND_VALUES = [
  'FLIGHT',
  'HOTEL',
  'TRANSFER',
  'VISA',
  'BUNDLE',
  'INSURANCE',
  'FEE',
  'DISCOUNT',
  'GUIDE',
  'UPGRADE_CHANGE',
  'OVERSALE',
] as const;
export const orderItemKindSchema = z.enum(ORDER_ITEM_KIND_VALUES);
export const OrderItemKind = {
  FLIGHT: 'FLIGHT',
  HOTEL: 'HOTEL',
  TRANSFER: 'TRANSFER',
  VISA: 'VISA',
  BUNDLE: 'BUNDLE',
  INSURANCE: 'INSURANCE',
  FEE: 'FEE',
  DISCOUNT: 'DISCOUNT',
  GUIDE: 'GUIDE',
  UPGRADE_CHANGE: 'UPGRADE_CHANGE',
  OVERSALE: 'OVERSALE',
} as const;
export type OrderItemKind = (typeof ORDER_ITEM_KIND_VALUES)[number];

export const INVOICE_STATUS_VALUES = [
  'NONE',
  'REQUESTED',
  'ISSUED',
] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUS_VALUES);
export const InvoiceStatus = {
  NONE: 'NONE',
  REQUESTED: 'REQUESTED',
  ISSUED: 'ISSUED',
} as const;
export type InvoiceStatus = (typeof INVOICE_STATUS_VALUES)[number];

export const ORDER_LEG_FLAG_VALUES = [
  'NONE',
  'NO_SHOW',
  'RETURN_RELEASED',
  'RETURN_RESTORED',
  'RETURN_VOIDED',
  'OUTBOUND_VOIDED',
] as const;
export const orderLegFlagSchema = z.enum(ORDER_LEG_FLAG_VALUES);
export const OrderLegFlag = {
  NONE: 'NONE',
  NO_SHOW: 'NO_SHOW',
  RETURN_RELEASED: 'RETURN_RELEASED',
  RETURN_RESTORED: 'RETURN_RESTORED',
  RETURN_VOIDED: 'RETURN_VOIDED',
  OUTBOUND_VOIDED: 'OUTBOUND_VOIDED',
} as const;
export type OrderLegFlag = (typeof ORDER_LEG_FLAG_VALUES)[number];

export const ORDER_COST_CATEGORY_VALUES = [
  'GUIDE_SERVICE',
  'COMP_GIFT',
  'HANDLING_FEE',
  'OPERATION_FEE',
  'OTHER',
] as const;
export const orderCostCategorySchema = z.enum(ORDER_COST_CATEGORY_VALUES);
export const OrderCostCategory = {
  GUIDE_SERVICE: 'GUIDE_SERVICE',
  COMP_GIFT: 'COMP_GIFT',
  HANDLING_FEE: 'HANDLING_FEE',
  OPERATION_FEE: 'OPERATION_FEE',
  OTHER: 'OTHER',
} as const;
export type OrderCostCategory = (typeof ORDER_COST_CATEGORY_VALUES)[number];

export const FULFILLMENT_TYPE_VALUES = [
  'FLIGHT_TICKETING',
  'HOTEL_BOOKING',
  'VISA_APPLICATION',
  'TRANSFER_DISPATCH',
  'BUNDLE_COMPOSITE',
] as const;
export const fulfillmentTypeSchema = z.enum(FULFILLMENT_TYPE_VALUES);
export const FulfillmentType = {
  FLIGHT_TICKETING: 'FLIGHT_TICKETING',
  HOTEL_BOOKING: 'HOTEL_BOOKING',
  VISA_APPLICATION: 'VISA_APPLICATION',
  TRANSFER_DISPATCH: 'TRANSFER_DISPATCH',
  BUNDLE_COMPOSITE: 'BUNDLE_COMPOSITE',
} as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPE_VALUES)[number];

export const FULFILLMENT_STATUS_VALUES = [
  'PENDING',
  'IN_PROGRESS',
  'CONFIRMED',
  'CANCELLED',
  'FAILED',
] as const;
export const fulfillmentStatusSchema = z.enum(FULFILLMENT_STATUS_VALUES);
export const FulfillmentStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUS_VALUES)[number];

export const PAYMENT_METHOD_VALUES = [
  'WECHAT_PAY',
  'ALIPAY',
  'BANK_CARD',
  'AGENT_PREPAYMENT',
] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHOD_VALUES);
export const PaymentMethod = {
  WECHAT_PAY: 'WECHAT_PAY',
  ALIPAY: 'ALIPAY',
  BANK_CARD: 'BANK_CARD',
  AGENT_PREPAYMENT: 'AGENT_PREPAYMENT',
} as const;
export type PaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];

export const PAYMENT_STATUS_VALUES = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUS_VALUES);
export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS_VALUES)[number];

export const RECEIPT_STATUS_VALUES = [
  'OPEN',
  'PARTIALLY_ALLOCATED',
  'ALLOCATED',
  'REFUNDED',
] as const;
export const receiptStatusSchema = z.enum(RECEIPT_STATUS_VALUES);
export const ReceiptStatus = {
  OPEN: 'OPEN',
  PARTIALLY_ALLOCATED: 'PARTIALLY_ALLOCATED',
  ALLOCATED: 'ALLOCATED',
  REFUNDED: 'REFUNDED',
} as const;
export type ReceiptStatus = (typeof RECEIPT_STATUS_VALUES)[number];

export const RECEIPT_SOURCE_VALUES = [
  'CUSTOMER_UPLOAD',
  'STAFF_ENTRY',
  'ORDER_OVERPAY',
  'STATEMENT_IMPORT',
  'OPS_CLAIM',
] as const;
export const receiptSourceSchema = z.enum(RECEIPT_SOURCE_VALUES);
export const ReceiptSource = {
  CUSTOMER_UPLOAD: 'CUSTOMER_UPLOAD',
  STAFF_ENTRY: 'STAFF_ENTRY',
  ORDER_OVERPAY: 'ORDER_OVERPAY',
  STATEMENT_IMPORT: 'STATEMENT_IMPORT',
  OPS_CLAIM: 'OPS_CLAIM',
} as const;
export type ReceiptSource = (typeof RECEIPT_SOURCE_VALUES)[number];

export const REFUND_STATUS_VALUES = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'REJECTED',
] as const;
export const refundStatusSchema = z.enum(REFUND_STATUS_VALUES);
export const RefundStatus = {
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
} as const;
export type RefundStatus = (typeof REFUND_STATUS_VALUES)[number];

export const NOTIFICATION_CHANNEL_VALUES = [
  'SMS',
  'EMAIL',
  'WECHAT',
] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNEL_VALUES);
export const NotificationChannel = {
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WECHAT: 'WECHAT',
} as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export const NOTIFICATION_STATUS_VALUES = [
  'QUEUED',
  'SENT',
  'FAILED',
  'RETRYING',
] as const;
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUS_VALUES);
export const NotificationStatus = {
  QUEUED: 'QUEUED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
} as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUS_VALUES)[number];

export const MARKETING_POSTER_KIND_VALUES = [
  'FLIGHT_ROUTE',
  'CUSTOM',
] as const;
export const marketingPosterKindSchema = z.enum(MARKETING_POSTER_KIND_VALUES);
export const MarketingPosterKind = {
  FLIGHT_ROUTE: 'FLIGHT_ROUTE',
  CUSTOM: 'CUSTOM',
} as const;
export type MarketingPosterKind = (typeof MARKETING_POSTER_KIND_VALUES)[number];

export const MARKETING_POSTER_STATUS_VALUES = [
  'GENERATING',
  'READY',
  'NEEDS_REVIEW',
  'FAILED',
] as const;
export const marketingPosterStatusSchema = z.enum(MARKETING_POSTER_STATUS_VALUES);
export const MarketingPosterStatus = {
  GENERATING: 'GENERATING',
  READY: 'READY',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  FAILED: 'FAILED',
} as const;
export type MarketingPosterStatus = (typeof MARKETING_POSTER_STATUS_VALUES)[number];

/**
 * 全部镜像的索引表（枚举名 → 值元组）。漂移测试遍历它逐个与 @prisma/client 对账；
 * 新增枚举只要按上面三件套加进本文件、索引表补一行，测试就自动覆盖到。
 */
export const PRISMA_ENUM_MIRRORS = {
  UserRole: USER_ROLE_VALUES,
  DocumentType: DOCUMENT_TYPE_VALUES,
  PassengerType: PASSENGER_TYPE_VALUES,
  Gender: GENDER_VALUES,
  ReminderStatus: REMINDER_STATUS_VALUES,
  ReminderPriority: REMINDER_PRIORITY_VALUES,
  StaffRole: STAFF_ROLE_VALUES,
  AuditSeverity: AUDIT_SEVERITY_VALUES,
  AuditTargetType: AUDIT_TARGET_TYPE_VALUES,
  SettlementMode: SETTLEMENT_MODE_VALUES,
  PrepaymentTxType: PREPAYMENT_TX_TYPE_VALUES,
  AgentRechargeStatus: AGENT_RECHARGE_STATUS_VALUES,
  ProductKind: PRODUCT_KIND_VALUES,
  CommissionStatus: COMMISSION_STATUS_VALUES,
  SettlementStatus: SETTLEMENT_STATUS_VALUES,
  CabinClass: CABIN_CLASS_VALUES,
  SeatLockStatus: SEAT_LOCK_STATUS_VALUES,
  SeatAllocationStatus: SEAT_ALLOCATION_STATUS_VALUES,
  HoldOrderStatus: HOLD_ORDER_STATUS_VALUES,
  HoldOwnerType: HOLD_OWNER_TYPE_VALUES,
  HoldInstallmentStatus: HOLD_INSTALLMENT_STATUS_VALUES,
  HoldAmountRule: HOLD_AMOUNT_RULE_VALUES,
  HoldOverdueAction: HOLD_OVERDUE_ACTION_VALUES,
  HoldOccupyOn: HOLD_OCCUPY_ON_VALUES,
  SettlementRequestStatus: SETTLEMENT_REQUEST_STATUS_VALUES,
  BundleChangeRequestStatus: BUNDLE_CHANGE_REQUEST_STATUS_VALUES,
  OrderChangeKind: ORDER_CHANGE_KIND_VALUES,
  OrderChangeRequestStatus: ORDER_CHANGE_REQUEST_STATUS_VALUES,
  WaitlistStatus: WAITLIST_STATUS_VALUES,
  VisaIssuanceMethod: VISA_ISSUANCE_METHOD_VALUES,
  VisaEntryType: VISA_ENTRY_TYPE_VALUES,
  VisaSubmissionStatus: VISA_SUBMISSION_STATUS_VALUES,
  SettlementTier: SETTLEMENT_TIER_VALUES,
  SettlementDiscountKind: SETTLEMENT_DISCOUNT_KIND_VALUES,
  SupplierType: SUPPLIER_TYPE_VALUES,
  SupplierInvoicePeriodKind: SUPPLIER_INVOICE_PERIOD_KIND_VALUES,
  SupplierInvoiceStatus: SUPPLIER_INVOICE_STATUS_VALUES,
  InvoiceType: INVOICE_TYPE_VALUES,
  InvoiceRecordStatus: INVOICE_RECORD_STATUS_VALUES,
  ProductReviewType: PRODUCT_REVIEW_TYPE_VALUES,
  OrderStatus: ORDER_STATUS_VALUES,
  VisaRequirement: VISA_REQUIREMENT_VALUES,
  OrderItemKind: ORDER_ITEM_KIND_VALUES,
  InvoiceStatus: INVOICE_STATUS_VALUES,
  OrderLegFlag: ORDER_LEG_FLAG_VALUES,
  OrderCostCategory: ORDER_COST_CATEGORY_VALUES,
  FulfillmentType: FULFILLMENT_TYPE_VALUES,
  FulfillmentStatus: FULFILLMENT_STATUS_VALUES,
  PaymentMethod: PAYMENT_METHOD_VALUES,
  PaymentStatus: PAYMENT_STATUS_VALUES,
  ReceiptStatus: RECEIPT_STATUS_VALUES,
  ReceiptSource: RECEIPT_SOURCE_VALUES,
  RefundStatus: REFUND_STATUS_VALUES,
  NotificationChannel: NOTIFICATION_CHANNEL_VALUES,
  NotificationStatus: NOTIFICATION_STATUS_VALUES,
  MarketingPosterKind: MARKETING_POSTER_KIND_VALUES,
  MarketingPosterStatus: MARKETING_POSTER_STATUS_VALUES,
} as const satisfies Record<string, readonly string[]>;
