/**
 * SHARED with sales-web/src/lib/api.ts — keep them in sync (admin-web subset).
 *
 * API base URL 通过构建时 env 注入：
 *   - 开发：默认 /api（vite-dev 代理到 http://localhost:4000）
 *   - 生产：VITE_API_BASE=https://api.citur.com（或 /api 走前端 nginx 反代）
 */
const API_BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined)?.trim() || '/api';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

type ApiRequestInit = Omit<RequestInit, 'body'> & {
  body?: unknown;
  token?: string | null;
};

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const errBody = (parsed as ApiErrorBody | undefined)?.error ?? {
      code: 'UNKNOWN',
      message: res.statusText,
    };
    throw new ApiError(res.status, errBody);
  }
  return parsed as T;
}

// ── 类型 ──────────────────────────────────────────────────────────────────

export type UserRole = 'CUSTOMER' | 'AGENT' | 'STAFF' | 'ADMIN';
export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';

export interface AuthUser {
  id: string;
  email: string | null;
  role: UserRole;
  displayName: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthResult {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface AdminFlight {
  id: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  aircraftType: string | null;
  isActive: boolean;
  scheduleCount: number;
  createdAt: string;
}

// 仓位阶梯一档：N 张以该价出售（int 张数 ≥1 / 价格 ≥0）。
// 按数组顺序由前往后出售（最便宜在前，卖满跳下一档）。
export interface FareBucket {
  quota: number;
  price: number;
}

export interface AdminScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  basePrice: string;
  // 仓位阶梯：有序数组（最便宜在前），自顶向下出售；
  // null / [] = 无阶梯（沿用旧的自动定价）。1..20 档。
  fareBuckets: FareBucket[] | null;
}

export interface AdminSchedule {
  id: string;
  flightId: string;
  departureTime: string;
  arrivalTime: string;
  departureTz: string;
  arrivalTz: string;
  isActive: boolean;
  seatClasses: AdminScheduleSeat[];
}

// ── 行李规则（航班 × 舱等）── 与 backend flights.service listBaggagePolicies 对齐
export interface FlightBaggagePolicy {
  id: string;
  flightId: string;
  cabin: CabinClass;
  /** 托运额度（kg/人）；null = 未配置 */
  checkedKg: number | null;
  /** 托运件数（件/人）；null = 未配置 */
  checkedPieces: number | null;
  /** 手提额度（kg/人）；null = 未配置 */
  carryOnKg: number | null;
  /** 补充说明（如"超件 ¥xx/件"） */
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PUT 整体替换 body 的单项；数组里未出现的舱等会被删除 */
export interface BaggagePolicyInput {
  cabin: CabinClass;
  checkedKg?: number | null;
  checkedPieces?: number | null;
  carryOnKg?: number | null;
  note?: string | null;
}

// ── 批量散客建单 ──
export interface BatchOrderPassenger {
  fullName: string;
  documentNumber: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality?: string;
}
export interface BatchCreateOrdersInput {
  flightScheduleId: string;
  flightCabin: CabinClass;
  description: string;
  /** 录入人由后端从登录账号自动盖章；前端不再采集/发送联系人。 */
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  notes?: string;
  passengers: BatchOrderPassenger[];
  /** 代为某代理批量录单（ADMIN/STAFF 用）。直客/无代理 = 不传。 */
  agentId?: string;
  /**
   * 团队结算价（每人 CNY，与代理谈定的整团一口价）。
   * 设置后覆盖动态定价：每位乘客按此价建单，不再走仓位阶梯/自动定价。
   */
  settlementPriceCny?: number;
  /** 团期备注（如「2026 春节团 7 日」），写入每单。 */
  groupNote?: string;
}

/** POST /orders/roster/parse 返回的一行（名单导入；字段可缺省，后续手录补全） */
export interface RosterParsedRow {
  name: string;
  passportNo?: string;
  dob?: string; // YYYY-MM-DD
  gender?: string;
}
export interface ParseRosterResult {
  rows: RosterParsedRow[];
  warnings: string[];
}
export interface BatchCreateOrdersResult {
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
}

// ── 单笔录单（按产品类型）—— 与 backend createOrderBodySchema / orderItemInputSchema 对齐 ──
// 所有行都带 description + quantity（int 1..20）；HOTEL/VISA/TRANSFER/BUNDLE 的 unitPrice 仅占位，
// 服务端会按产品权威重算价格（HOTEL/VISA/TRANSFER 后端定价；BUNDLE/FLIGHT 后端重算）。
export interface OrderPassengerInput {
  fullName: string;
  documentNumber: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality?: string; // ISO alpha-2，默认 CN
  passengerType?: PassengerType;
}

interface OrderItemBase {
  description: string;
  quantity: number;
  metadata?: Record<string, unknown>;
}
export type CreateOrderItemInput =
  | (OrderItemBase & { kind: 'FLIGHT'; flightScheduleId: string; flightCabin: CabinClass })
  | (OrderItemBase & { kind: 'HOTEL'; hotelRoomTypeId?: string; checkIn?: string; checkOut?: string; unitPrice: number })
  | (OrderItemBase & { kind: 'TRANSFER'; transferId?: string; unitPrice: number })
  | (OrderItemBase & { kind: 'VISA'; visaId?: string; unitPrice: number })
  | (OrderItemBase & {
      kind: 'BUNDLE';
      bundleId: string;
      unitPrice: number;
      singleCount?: number;
      businessCount?: number;
      adultCount?: number;
      childCount?: number;
      infantCount?: number;
    });

// 签证状态（录单/详情用）；后端 enum → 中文：
// NOT_NEEDED=不需要 / NEEDED=需要 / E_VISA=电子签(三个月多次) / HAS_VISA=已签证
export type VisaStatusInput = 'NOT_NEEDED' | 'NEEDED' | 'E_VISA' | 'HAS_VISA';

export const VISA_STATUS_LABEL: Record<VisaStatusInput, string> = {
  NOT_NEEDED: '不需要',
  NEEDED: '需要',
  E_VISA: '电子签(三个月多次)',
  HAS_VISA: '已签证',
};

/** 结构化备注（签证状态 + 酒店/签证/付款/特殊要求）；每段 ≤300 字 */
export interface OrderStructuredNotes {
  /** 签证状态 */
  visaStatus?: VisaStatusInput;
  /** 酒店情况 */
  noteHotel?: string;
  /** 签证情况 */
  noteVisa?: string;
  /** 付款情况 */
  notePayment?: string;
  /** 特殊要求 */
  noteSpecial?: string;
}

export interface CreateOrderInput extends OrderStructuredNotes {
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  paymentMethod?: PaymentMethod;
  items: CreateOrderItemInput[];
  passengers: OrderPassengerInput[];
  notes?: string;
  idempotencyKey?: string;
  /**
   * 代为某代理录单（ADMIN/STAFF 用）。直客/无代理 = 不传。
   * 注：服务端创单接口对 agentId 的归属支持为后端配套改动；本字段为前向兼容透传，
   * 服务端未启用时会被静默忽略（不报错）。
   */
  agentId?: string;
}

/**
 * 结算方式：
 * - PER_ORDER 逐单到账：每笔订单单独收尾款（默认）。
 * - MONTHLY 月结：订单尾款挂账，月末统一对账，不逐单催款。
 */
export type SettlementMode = 'PER_ORDER' | 'MONTHLY';

export const SETTLEMENT_MODE_LABEL: Record<SettlementMode, string> = {
  PER_ORDER: '逐单到账',
  MONTHLY: '月结',
};

export interface AgentListItem {
  id: string;
  userId: string;
  tier: number;
  parentAgentId: string | null;
  parent: { id: string; companyName: string | null; contactName: string; tier: number } | null;
  companyName: string | null;
  contactName: string;
  contactPhone: string;
  prepaymentBalance: string;
  /** 结算方式（逐单到账 / 月结）；后端默认 PER_ORDER */
  settlementMode: SettlementMode;
  isActive: boolean;
  notes: string | null;
  email: string | null;
  displayName: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  childCount: number;
  orderCount: number;
}

export interface CreateChildAgentInput {
  email: string;
  password: string;
  displayName: string;
  contactName: string;
  contactPhone: string;
  companyName?: string;
  prepaymentBalance?: number;
  notes?: string;
}

// ── Orders ────────────────────────────────────────────────────────────────
export type OrderStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'TICKETED'
  | 'COMPLETED'
  | 'PAYMENT_TIMEOUT'
  | 'CANCELLED'
  | 'REFUND_REQUESTED'
  | 'REFUNDED'
  | 'CHANGE_REQUESTED'
  | 'CHANGED'
  | 'FAILED';

export type OrderItemKind =
  | 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA'
  | 'BUNDLE' | 'INSURANCE' | 'FEE' | 'DISCOUNT'
  | 'GUIDE' | 'UPGRADE_CHANGE' | 'OVERSALE';
export type DocumentType = 'PASSPORT' | 'ID_CARD' | 'OTHER';
export type PassengerType = 'ADULT' | 'CHILD' | 'INFANT';
export type PaymentMethod = 'WECHAT_PAY' | 'ALIPAY' | 'BANK_CARD' | 'AGENT_PREPAYMENT';

export interface OrderItem {
  id: string;
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
  flightScheduleId: string | null;
  flightCabin: CabinClass | null;
  hotelRoomTypeId: string | null;
  hotelCheckIn: string | null;
  hotelCheckOut: string | null;
  transferId: string | null;
  visaId: string | null;
  metadata: unknown;
  createdAt: string;
  // 列表带出的履约任务（仅 type+status），用于派生「签证状态」「出票状态」
  fulfillmentTasks?: Array<{ type: string; status: FulfillmentStatus }>;
}

export interface OrderPassenger {
  id: string;
  fullName: string;
  lastName?: string | null;
  firstName?: string | null;
  title?: string | null;
  gender?: 'M' | 'F' | 'X' | null;
  documentType?: DocumentType;
  documentNumber?: string;
  dateOfBirth?: string;
  placeOfBirth?: string | null;
  nationality?: string;
  passengerType?: PassengerType;

  // 护照扩展
  passportIssueCountry?: string | null;
  passportExpiry?: string | null;

  // 签证
  visaNumber?: string | null;
  visaType?: string | null;
  visaIssueDate?: string | null;
  visaExpiry?: string | null;
  visaPlaceOfIssue?: string | null;
  visaCountryOfApplication?: string | null;

  // 地址
  addressType?: string | null;
  addressDetails?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressCountry?: string | null;
  addressZip?: string | null;

  bedPref?: string | null;
  passportPhotoUrl?: string | null;
  pnr?: string | null;
  eticketNumber?: string | null;
}

export type ReminderStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED';
export type ReminderPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export interface OperationalReminder {
  id: string;
  orderId: string | null;
  title: string;
  body: string | null;
  dueAt: string | null;
  priority: ReminderPriority;
  status: ReminderStatus;
  attachmentUrl: string | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string | null; displayName: string | null };
  claimedBy: { id: string; email: string | null; displayName: string | null } | null;
  order?: { id: string; orderNumber: string; status: OrderStatus; contactName: string } | null;
}

export interface RoomGroup {
  id: string;
  hotelName: string;
  roomType: string;
  passengerIds: string[];
  notes?: string;
}

export interface RoomAssignment {
  roomGroups: RoomGroup[];
}

export type InvoiceStatus = 'NONE' | 'REQUESTED' | 'ISSUED';

export interface OrderSummary {
  id: string;
  orderNumber: string;
  userId: string;
  agentId: string | null;
  status: OrderStatus;
  invoiceStatus?: InvoiceStatus;
  currency: string;
  subtotal: string;
  total: string;
  paidAmount: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  passengers: OrderPassenger[];
  agent: {
    id: string;
    companyName: string | null;
    contactName: string;
    settlementMode: SettlementMode;
    prepaymentBalance: string;
  } | null;
  user: { id: string; displayName: string | null; email: string | null };

  // 新增字段（5/20 反馈）
  notes?: string | null;
  internalNotes?: string | null;

  // 签证状态 + 结构化备注（详情 getOrder 带出；列表可能为空）
  visaStatus?: VisaStatusInput | null;
  noteHotel?: string | null;
  noteVisa?: string | null;
  notePayment?: string | null;
  noteSpecial?: string | null;
  claimedById?: string | null;
  claimedAt?: string | null;
  claimedBy?: { id: string; displayName: string | null; email: string | null } | null;
  roomAssignment?: RoomAssignment | null;
  reminders?: OperationalReminder[];
  // 订单详情(getOrder)带出的收款记录（列表不含，避免 proof 数据膨胀）
  payments?: OrderPayment[];

  // 出纳预期到账金额 + 锁定（仅 ADMIN/STAFF 看；AGENT 不看）
  // Decimal 在 JSON 里是 string；null 表示未设置
  expectedAmountCny?: string | null;
  expectedAmountLocked?: boolean;
}

/** listOrders 查询参数（与 backend listOrdersQuerySchema 对齐） */
export interface ListOrdersParams {
  status?: OrderStatus;
  agentId?: string;
  kind?: OrderItemKind;
  search?: string;
  from?: string; // 下单日期起 YYYY-MM-DD
  to?: string; // 下单日期止
  travelFrom?: string; // 出行日期起
  travelTo?: string; // 出行日期止
  claimedById?: string;
  unclaimedOnly?: string; // '1' = 只看未接单
  flightNumber?: string; // 订单含该航班号的 FLIGHT 行（不区分大小写）
  passengerName?: string; // 乘客姓名模糊匹配
  invoiceStatus?: InvoiceStatus;
  page?: number;
  pageSize?: number;
}

// ── 三模板筛选导出（全岗可用 / 票务专用 / 签证专用）──────────────────────
export type OrderExportTemplate = 'full' | 'ticketing' | 'visa';

/** GET /orders/export-templates 查询参数 = listOrders 同款筛选 + template */
export interface OrdersTemplateExportParams {
  template: OrderExportTemplate;
  status?: OrderStatus;
  agentId?: string;
  kind?: OrderItemKind;
  search?: string;
  from?: string;
  to?: string;
  travelFrom?: string;
  travelTo?: string;
  flightNumber?: string;
  passengerName?: string;
  invoiceStatus?: InvoiceStatus;
}

export interface OrderPayment {
  id: string;
  method: PaymentMethod;
  amount: string;
  status: string;
  proofUrl: string | null;
  paidAt: string | null;
  createdAt: string;
}

// ── Audit / Customers / Travelers / Fulfillment ──────────────────────────
export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AuditTargetType = 'AGENT' | 'ORDER' | 'FLIGHT' | 'CUSTOMER' | 'TRAVELER' | 'PRICING' | 'COMMISSION' | 'SETTLEMENT' | 'PRODUCT' | 'AUTH' | 'SYSTEM';

export interface AuditLog {
  id: string;
  actorUserId: string | null;
  actorLabel: string | null;
  actorRole: string | null;
  action: string;
  targetType: AuditTargetType;
  targetId: string | null;
  targetLabel: string | null;
  before: unknown;
  after: unknown;
  severity: AuditSeverity;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface CustomerSummary {
  id: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  profile: {
    idNumber: string | null;
    primaryAgentId: string | null;
    primaryAgent: { id: string; companyName: string | null; contactName: string; tier: number } | null;
    tags: string[];
    notes: string | null;
  };
  totalOrders: number;
  totalSpent: number;
  lastOrderAt: string | null;
}

export interface CustomerDetail extends CustomerSummary {
  recentOrders: Array<{ id: string; orderNumber: string; status: OrderStatus; total: string; createdAt: string; summary: string }>;
  travelers: Array<{ id: string; fullName: string; documentNumber: string; dateOfBirth: string; nationality: string; phone: string | null; notes: string | null }>;
}

export interface Traveler {
  id: string;
  userId: string;
  customer: { id: string; displayName: string | null; email: string | null; phone: string | null } | null;
  fullName: string;
  documentType: DocumentType;
  documentNumber: string;
  dateOfBirth: string;
  nationality: string;
  passengerType: PassengerType;
  phone: string | null;
  notes: string | null;
  tripCount: number;
  lastTripAt: string | null;
  createdAt: string;
}

export type FulfillmentType = 'FLIGHT_TICKETING' | 'HOTEL_BOOKING' | 'VISA_APPLICATION' | 'TRANSFER_DISPATCH' | 'BUNDLE_COMPOSITE';
export type FulfillmentStatus = 'PENDING' | 'IN_PROGRESS' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';

export interface FulfillmentTask {
  id: string;
  orderItemId: string;
  type: FulfillmentType;
  status: FulfillmentStatus;
  data: unknown;
  notes: string | null;
  attempts: number;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  updatedAt: string;
  item: { id: string; kind: OrderItemKind; description: string; quantity: number; orderId: string };
  order?: { id: string; orderNumber: string; contactName: string; contactPhone: string; status: OrderStatus; notes?: string | null };
}

/** GET /fulfillment-tasks 列表查询（与 backend listFulfillmentQuerySchema 对齐） */
export interface ListFulfillmentParams {
  orderId?: string;
  orderItemId?: string;
  type?: FulfillmentType;
  status?: FulfillmentStatus;
  assigneeUserId?: string;
  page?: number;
  pageSize?: number;
}

/** POST /fulfillment-tasks/batch-status 返回（部分失败带 failures 明细） */
export interface BatchFulfillmentStatusResult {
  successCount: number;
  failureCount: number;
  failures: Array<{ id: string; error: string }>;
}

// ── 候补（ADMIN/STAFF 某班次候补名单，电话回访用）─────────────────────────
export type WaitlistStatus = 'ACTIVE' | 'NOTIFIED' | 'FULFILLED' | 'CANCELLED';

export interface WaitlistEntry {
  id: string;
  seatClassId: string;
  cabin: CabinClass;
  qty: number;
  status: WaitlistStatus;
  contactPhone: string;
  user: { id: string; displayName: string | null; email: string | null; phone: string | null };
  createdAt: string;
}

// ── Products ─────────────────────────────────────────────────────────────
export interface HotelRoomType {
  id: string;
  hotelId: string;
  name: string;
  bedType: string | null;
  capacity: number;
  basePrice: string;
  priceMultiplier: string | null;
  costPriceCny: string | null;
  /** 可住大人数（后端默认 2） */
  maxAdults: number;
  /** 可加小孩数（后端默认 1） */
  maxChildren: number;
}

export interface Hotel {
  id: string;
  /** 产品编号（服务端生成，如 H0001）；老数据可能为 null */
  code: string | null;
  name: string;
  nameEn: string | null;
  cityCode: string;
  area: string | null;
  address: string;
  starRating: number;
  basePrice: string | null;
  rating: string | null;
  reviewCount: number | null;
  emoji: string | null;
  highlight: string | null;
  amenities: string[];
  photos: string[];
  isActive: boolean;
  roomTypes: HotelRoomType[];
  createdAt: string;
}

export interface Transfer {
  id: string;
  /** 产品编号（服务端生成，如 T0001）；老数据可能为 null */
  code: string | null;
  name: string;
  vehicleType: string;
  capacity: number;
  originArea: string;
  destArea: string;
  basePrice: string;
  features: string[];
  duration: string | null;
  emoji: string | null;
  photo: string | null;
  isActive: boolean;
  costPriceCny: string | null;
  createdAt: string;
}

export interface Visa {
  id: string;
  /** 产品编号（服务端生成，如 V0001）；老数据可能为 null */
  code: string | null;
  destinationCountry: string;
  country: string | null;
  visaType: string;
  visaName: string | null;
  flag: string | null;
  processingDays: number;
  basePrice: string;
  expressSurcharge: string | null;
  validityMonths: number | null;
  highlight: string | null;
  requiredDocs: string[];
  isActive: boolean;
  costPriceCny: string | null;
  createdAt: string;
}

export interface BundleItemData {
  kind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';
  productName: string;
  qty: number;
  unitPrice: number;
}

/** 套餐不可售日期（按出发日）；reason ≤60 字，最多 120 条 */
export interface BundleBlackoutDate {
  date: string; // YYYY-MM-DD
  reason?: string;
}

export interface Bundle {
  id: string;
  /** 产品编号（服务端生成，如 B0001）；老数据可能为 null */
  code: string | null;
  name: string;
  tagline: string | null;
  emoji: string | null;
  photo: string | null;
  items: BundleItemData[];
  flightPax: number;
  groundDiscount: string;
  suitableFor: string | null;
  /** 关联酒店房型 ID（房控板计入套餐占房）；null = 不关联 */
  hotelRoomTypeId: string | null;
  /** 关联房型晚数（1–30）；null = 不关联 */
  hotelNights: number | null;
  /** 展示用：服务端联表返回的房型名 + 酒店名；null = 不关联 */
  hotelRoomType: { id: string; name: string; hotelName: string } | null;
  /** 自愿升级：一个人住酒店（单人入住）每人每晚加价（CNY/晚，整数） */
  singleSupplementCnyPerNight: number;
  /** 自愿升级：升舱商务每人每航段加价（CNY/程，整数） */
  businessUpgradeCnyPerLeg: number;
  /** 占座儿童比成人每人便宜多少（CNY/人，整数，默认 30） */
  childSeatDiscountCnyPerPerson: number;
  /** 不占座婴儿每人价（CNY/人，整数，默认 0） */
  infantPriceCny: number;
  /** 计费航段数（来回 = 2，单程 = 1）；升舱加价 = businessUpgradeCnyPerLeg × legs × 人数 */
  legs: number;
  /** 按出发日的不可售日期（单套餐粒度）；缺省/空 = 不限制 */
  blackoutDates?: BundleBlackoutDate[];
  /** 前台默认出发日（不影响可售判定）；null = 无默认 */
  defaultDepartDate?: string | null;
  isActive: boolean;
  createdAt: string;
}

// ── 房控（酒店包房周期 + 销控板 / 远期视图）──────────────────────────────
// 与 backend/src/modules/hotel-control/hotel-control.service.ts 对齐
export interface HotelBlockPeriod {
  id: string;
  hotelId: string;
  hotelName: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD（闭区间）
  rooms: number;
  unitPrice: number | null; // 切房单价（CNY/间/晚）
  note: string | null;
  updatedAt: string;
}

export interface BlockPeriodWriteInput {
  hotelId: string;
  dateFrom: string;
  dateTo: string;
  rooms: number;
  unitPrice?: number | null;
  note?: string | null;
}

export interface HotelControlBoardHotel {
  hotelId: string;
  hotelName: string;
  /** 最新周期（dateFrom 最晚且有价）的切房单价；都没填则 null */
  unitPrice: number | null;
  rows: { block: number[]; used: number[]; remaining: number[] };
}

export interface HotelControlBoard {
  dates: string[];
  hotels: HotelControlBoardHotel[];
}

export interface HotelControlForward {
  dates: string[];
  held: number[]; // 切房合计（控房）
  occupied: number[]; // 占房合计（收客）
  remaining: number[]; // held - occupied（余房）
}

/** GET /hotel-control/alerts — 提醒线（超卖加房 / 富余退房 / 班次超开票上限） */
export interface HotelControlAlerts {
  /** 余量 < 0：占房超过包房，提醒加房 */
  oversold: Array<{
    hotelId: string;
    hotelName: string;
    date: string; // YYYY-MM-DD
    block: number;
    used: number;
    deficit: number; // used - block（正数）
  }>;
  /** 距今 3 天内仍有剩余包房：提示该退房 */
  surplusSoon: Array<{ hotelName: string; date: string; surplus: number }>;
  /** 出发在 30 天内、计入口径乘客数超过班次开票上限的班次 */
  overCapacitySchedules: Array<{
    flightNumber: string;
    departureDate: string; // YYYY-MM-DD
    paxCount: number;
  }>;
}

// ── Dashboard ─────────────────────────────────────────────────────────────
export interface DashboardKpi {
  todayRevenue: number;
  todayOrders: number;
  pendingOrders: number;
  activeAgents: number;
  monthRevenue: number;
  monthOrders: number;
  revenueChangePct: number;
  ordersChangePct: number;
  monthRevenueChangePct: number;
  asOf: string;
}

export interface DashboardWeeklyPoint { date: string; revenue: number; orders: number }
export interface DashboardTopAgent {
  agentId: string;
  companyName: string | null;
  contactName: string;
  tier: number;
  orderCount: number;
  revenue: number;
}

// ── Settlements ──────────────────────────────────────────────────────────
export type SettlementStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PAID' | 'VOIDED';

export interface SettlementSummary {
  id: string;
  period: string; // YYYY-MM
  agentId: string;
  orderCount: number;
  grossRevenue: string;
  commissionEarned: string;
  commissionPaidToChildren: string;
  netCommission: string;
  prepaymentOffset: string;
  payableToAgent: string;
  status: SettlementStatus;
  generatedAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  notes: string | null;
  agent: {
    id: string;
    companyName: string | null;
    contactName: string;
    tier: number;
    displayName: string | null;
    email: string | null;
  };
}

export interface SettlementCommissionRecord {
  id: string;
  productKind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';
  baseAmount: string;
  rate: string;
  amount: string;
  chainDepth: number;
  status: string;
  createdAt: string;
  order: { id: string; orderNumber: string; total: string };
}

export interface SettlementDetail extends SettlementSummary {
  commissions: SettlementCommissionRecord[];
}

export const api = {
  login: (email: string, password: string) =>
    apiFetch<AuthResult>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  logout: (refreshToken: string) =>
    apiFetch<void>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    }),
  refresh: (refreshToken: string) =>
    apiFetch<{ tokens: AuthTokens }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    }),
  me: (token: string) =>
    apiFetch<{ user: AuthUser & { phone: string | null; createdAt: string; lastLoginAt: string | null } }>('/users/me', { token }),

  // Flights
  listAllFlights: (token: string) =>
    apiFetch<{ flights: AdminFlight[] }>('/flights/', { token }),
  createFlight: (
    token: string,
    body: { flightNumber: string; originCode: string; destinationCode: string; aircraftType?: string },
  ) => apiFetch<{ flight: AdminFlight }>('/flights/', { method: 'POST', token, body }),
  toggleFlight: (token: string, flightId: string) =>
    apiFetch<{ flight: AdminFlight }>(`/flights/${flightId}/toggle`, { method: 'POST', token }),
  listSchedules: (token: string, flightId: string) =>
    apiFetch<{ schedules: AdminSchedule[] }>(`/flights/${flightId}/schedules`, { token }),
  createSchedule: (
    token: string,
    body: {
      flightId: string;
      departureTime: string;
      arrivalTime: string;
      departureTz?: string;
      arrivalTz?: string;
      seatClasses: Array<{ cabin: CabinClass; capacity: number; basePrice: number }>;
    },
  ) => apiFetch<{ schedule: AdminSchedule }>('/flights/schedules', { method: 'POST', token, body }),
  // 改单个班次：停用/启用 + 按舱等改价/改容量（后端守 capacity ≥ sold，否则 400）
  updateSchedule: (
    token: string,
    scheduleId: string,
    body: {
      isActive?: boolean;
      // fareBuckets：数组=设阶梯；null 或 [] = 清除阶梯（恢复自动定价）；
      // 单独传 fareBuckets 即为有效修改（无需同时传 basePrice/capacity）。
      seatClasses?: Array<{
        cabin: CabinClass;
        basePrice?: number;
        capacity?: number;
        fareBuckets?: FareBucket[] | null;
      }>;
    },
  ) =>
    apiFetch<{ schedule: AdminSchedule }>(`/flights/schedules/${scheduleId}`, {
      method: 'PATCH',
      token,
      body,
    }),
  // 删除班次（仅 ADMIN）。后端守 sold>0：有订单关联则拒绝/转停用，
  // result 可能是 { id, deleted: true } 或被停用的班次对象。
  deleteSchedule: (token: string, scheduleId: string) =>
    apiFetch<{ result: { id: string; deleted?: boolean } | AdminSchedule }>(
      `/flights/schedules/${scheduleId}`,
      { method: 'DELETE', token },
    ),
  // 行李规则（航班 × 舱等；ADMIN/STAFF 维护）
  getBaggagePolicies: (token: string, flightId: string) =>
    apiFetch<{ policies: FlightBaggagePolicy[] }>(`/flights/${flightId}/baggage-policies`, { token }),
  // PUT 整体替换：数组里未出现的舱等会被删除
  saveBaggagePolicies: (token: string, flightId: string, items: BaggagePolicyInput[]) =>
    apiFetch<{ policies: FlightBaggagePolicy[] }>(`/flights/${flightId}/baggage-policies`, {
      method: 'PUT',
      token,
      body: items,
    }),

  // Agents
  listAgents: (token: string) => apiFetch<{ agents: AgentListItem[] }>('/agents/', { token }),
  createChildAgent: (token: string, body: CreateChildAgentInput, parentId?: string) =>
    apiFetch<{ user: { id: string; email: string | null }; agent: { id: string; tier: number } }>(
      parentId ? `/agents/children?parentId=${encodeURIComponent(parentId)}` : '/agents/children',
      { method: 'POST', token, body },
    ),
  // 改代理结算方式（逐单到账 / 月结）；ADMIN only
  setAgentSettlementMode: (token: string, id: string, settlementMode: SettlementMode) =>
    apiFetch<{ agent: AgentListItem }>(`/agents/${id}/settlement-mode`, {
      method: 'PATCH',
      token,
      body: { settlementMode },
    }),

  // Orders
  listOrders: (token: string, query?: ListOrdersParams) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    return apiFetch<{
      orders: OrderSummary[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/orders/${qs.toString() ? '?' + qs.toString() : ''}`, { token });
  },
  getOrder: (token: string, id: string) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${id}`, { token }),
  updateOrderStatus: (token: string, id: string, toStatus: OrderStatus, reason?: string, force?: boolean) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${id}/status`, {
      method: 'PATCH',
      token,
      body: { toStatus, reason, force },
    }),
  batchUpdateOrderStatus: (
    token: string,
    ids: string[],
    toStatus: OrderStatus,
    reason?: string,
    force?: boolean,
  ) =>
    apiFetch<{
      successCount: number;
      failureCount: number;
      results: Array<{ id: string; success: boolean; orderNumber?: string; error?: string }>;
    }>(`/orders/batch-status`, {
      method: 'POST',
      token,
      body: { ids, toStatus, reason, force },
    }),

  // 批量散客建单：一个航班班次+舱位+共享联系人，名单每位乘客一单
  batchCreateOrders: (token: string, body: BatchCreateOrdersInput) =>
    apiFetch<BatchCreateOrdersResult>('/orders/batch', { method: 'POST', token, body }),

  // 下载名单模版（.xlsx：姓名/护照号/出生日期/性别）；ADMIN/STAFF only。返回 Blob 直接下载。
  downloadRosterTemplate: async (token: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/orders/roster/template`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'TEMPLATE_FAILED', message: await res.text() });
    return res.blob();
  },
  // 解析上传的名单 Excel（base64）→ 乘客行 + 警告（缺字段/格式问题）；ADMIN/STAFF only。
  parseRoster: (token: string, fileBase64: string) =>
    apiFetch<ParseRosterResult>('/orders/roster/parse', {
      method: 'POST',
      token,
      body: { fileBase64 },
    }),

  // 单笔录单（按产品类型 机票/酒店/签证/套餐/接送）。服务端按产品权威重算价格 + 校验余票。
  createOrder: (token: string, body: CreateOrderInput) =>
    apiFetch<{ order: OrderSummary }>('/orders/', { method: 'POST', token, body }),

  // 设置开票状态（ADMIN/STAFF）
  setInvoiceStatus: (token: string, id: string, invoiceStatus: InvoiceStatus) =>
    apiFetch<{ id: string; orderNumber: string; invoiceStatus: InvoiceStatus }>(
      `/orders/${id}/invoice-status`,
      { method: 'PATCH', token, body: { invoiceStatus } },
    ),

  // 人工确认收款（线下收款 → 标记已付 + 上传截图）ADMIN/STAFF
  // 现已允许多付：amount 可超过尾款（paidAmount 可大于 total）。
  confirmPayment: (
    token: string,
    body: { orderId: string; amount?: number; method: PaymentMethod; proofUrl?: string; note?: string; idempotencyKey?: string },
  ) =>
    apiFetch<{
      ok: true;
      paymentId: string;
      paidAmount: number;
      total: number;
      fullyPaid: boolean;
      orderNumber: string;
      status: OrderStatus;
    }>('/payments/manual-confirm', { method: 'POST', token, body }),

  // 批量到账（选多笔订单 → 逐单录入到账金额 + 共享水单）ADMIN/STAFF。
  // 逐单入账：单条失败不影响其它（每条返回 ok / error + 最新 paidAmount/status）。
  batchConfirmPayments: (
    token: string,
    body: {
      items: Array<{ orderId: string; amount: number; method?: PaymentMethod; proofUrl?: string; note?: string }>;
      sharedProofUrl?: string;
    },
  ) =>
    apiFetch<{
      results: Array<{
        orderId: string;
        ok: boolean;
        error?: string;
        paidAmount: number;
        status: OrderStatus;
      }>;
    }>('/payments/batch-confirm', { method: 'POST', token, body }),

  // ── 5/20 反馈新增 API ──────────────────────────────────────────────────
  // 一键导出 PNR Excel；返回 Blob 直接下载
  exportPnr: async (token: string, orderId: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/orders/${orderId}/pnr-export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },
  // 一键打包护照图片 zip
  downloadPassportsZip: async (token: string, orderId: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/orders/${orderId}/passport-photos.zip`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'ZIP_FAILED', message: await res.text() });
    return res.blob();
  },
  // 整班机订单导出（ADMIN/STAFF only；ops 用，不含成本）
  downloadOrdersBySchedule: async (token: string, scheduleId: string): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/orders/export-by-schedule?scheduleId=${encodeURIComponent(scheduleId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },
  // 三模板筛选导出（全岗可用/票务专用/签证专用；ADMIN/STAFF only）
  downloadOrdersTemplateExport: async (
    token: string,
    params: OrdersTemplateExportParams,
  ): Promise<Blob> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const res = await fetch(`${API_BASE}/orders/export-templates?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },
  // 把订单多付（paidAmount−total）转入其代理预存余额；订单回到刚好结清。ADMIN/STAFF
  creditOverpayToAgent: (token: string, orderId: string) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/credit-overpay-to-agent`, {
      method: 'POST',
      token,
      body: {},
    }),
  // 用代理预存余额抵订单尾款；覆盖则翻 PAID。amount ≤ 尾款 且 ≤ 代理余额。ADMIN/STAFF
  applyAgentBalance: (token: string, orderId: string, amount: number) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/apply-agent-balance`, {
      method: 'POST',
      token,
      body: { amount },
    }),
  // 认领订单（防漏单）
  claimOrder: (token: string, orderId: string) =>
    apiFetch<{ ok: boolean; claimedBy: { id: string; displayName: string | null; email: string | null } }>(
      `/orders/${orderId}/claim`,
      { method: 'POST', token, body: {} },
    ),
  // 套票分房
  updateRoomAssignment: (token: string, orderId: string, roomGroups: RoomGroup[]) =>
    apiFetch<{ ok: boolean }>(`/orders/${orderId}/room-assignment`, {
      method: 'PUT',
      token,
      body: { roomGroups },
    }),
  // 修改订单备注（自由备注 + 签证状态 + 结构化备注；任意子集）
  updateOrderNotes: (
    token: string,
    orderId: string,
    body: { notes?: string; internalNotes?: string } & OrderStructuredNotes,
  ) =>
    apiFetch<{ ok: boolean }>(`/orders/${orderId}/notes`, {
      method: 'PATCH',
      token,
      body,
    }),

  // ── 操作部待办 ───────────────────────────────────────────────────────
  listReminders: (
    token: string,
    query?: {
      status?: ReminderStatus;
      priority?: ReminderPriority;
      orderId?: string;
      mine?: boolean;
      page?: number;
      pageSize?: number;
    },
  ) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    return apiFetch<{
      reminders: OperationalReminder[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/reminders/${qs.toString() ? '?' + qs.toString() : ''}`, { token });
  },
  createReminder: (
    token: string,
    body: {
      orderId?: string;
      title: string;
      body?: string;
      dueAt?: string;
      priority?: ReminderPriority;
      attachmentUrl?: string;
    },
  ) =>
    apiFetch<{ reminder: OperationalReminder }>(`/reminders/`, {
      method: 'POST',
      token,
      body,
    }),
  updateReminder: (
    token: string,
    id: string,
    body: {
      title?: string;
      body?: string;
      dueAt?: string | null;
      priority?: ReminderPriority;
      attachmentUrl?: string | null;
    },
  ) =>
    apiFetch<{ reminder: OperationalReminder }>(`/reminders/${id}`, {
      method: 'PATCH',
      token,
      body,
    }),
  claimReminder: (token: string, id: string) =>
    apiFetch<{ reminder: OperationalReminder }>(`/reminders/${id}/claim`, {
      method: 'POST',
      token,
      body: {},
    }),
  releaseReminder: (token: string, id: string) =>
    apiFetch<{ reminder: OperationalReminder }>(`/reminders/${id}/release`, {
      method: 'POST',
      token,
      body: {},
    }),
  resolveReminder: (
    token: string,
    id: string,
    body: { status: 'DONE' | 'SKIPPED'; resolvedNote?: string },
  ) =>
    apiFetch<{ reminder: OperationalReminder }>(`/reminders/${id}/resolve`, {
      method: 'POST',
      token,
      body,
    }),

  // Settlements
  listSettlements: (token: string, query?: { period?: string; agentId?: string; status?: SettlementStatus; page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    return apiFetch<{
      settlements: SettlementSummary[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/settlements/${qs.toString() ? '?' + qs.toString() : ''}`, { token });
  },
  getSettlement: (token: string, id: string) =>
    apiFetch<{ settlement: SettlementDetail }>(`/settlements/${id}`, { token }),
  generateSettlements: (token: string, body: { period: string; agentId?: string; overwrite?: boolean }) =>
    apiFetch<{ period: string; generated: Array<{ agentId: string; settlementId: string; status: SettlementStatus; action: string }> }>(
      '/settlements/generate',
      { method: 'POST', token, body },
    ),
  updateSettlementStatus: (token: string, id: string, toStatus: SettlementStatus, notes?: string) =>
    apiFetch<{ settlement: SettlementDetail }>(`/settlements/${id}/status`, {
      method: 'PATCH',
      token,
      body: { toStatus, notes },
    }),

  // Products — Hotels
  listHotels: (activeOnly = false) =>
    apiFetch<{ hotels: Hotel[] }>(`/products/hotels${activeOnly ? '?active=1' : ''}`),
  createHotel: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ hotel: Hotel }>('/products/hotels', { method: 'POST', token, body }),
  updateHotel: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ hotel: Hotel }>(`/products/hotels/${id}`, { method: 'PATCH', token, body }),
  deleteHotel: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/hotels/${id}`, { method: 'DELETE', token }),

  // Products — Transfers
  listTransfers: (activeOnly = false) =>
    apiFetch<{ transfers: Transfer[] }>(`/products/transfers${activeOnly ? '?active=1' : ''}`),
  createTransfer: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ transfer: Transfer }>('/products/transfers', { method: 'POST', token, body }),
  updateTransfer: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ transfer: Transfer }>(`/products/transfers/${id}`, { method: 'PATCH', token, body }),
  deleteTransfer: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/transfers/${id}`, { method: 'DELETE', token }),

  // Products — Visas
  listVisas: (activeOnly = false) =>
    apiFetch<{ visas: Visa[] }>(`/products/visas${activeOnly ? '?active=1' : ''}`),
  createVisa: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ visa: Visa }>('/products/visas', { method: 'POST', token, body }),
  updateVisa: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ visa: Visa }>(`/products/visas/${id}`, { method: 'PATCH', token, body }),
  deleteVisa: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/visas/${id}`, { method: 'DELETE', token }),

  // Products — Bundles
  listBundles: (activeOnly = false) =>
    apiFetch<{ bundles: Bundle[] }>(`/products/bundles${activeOnly ? '?active=1' : ''}`),
  createBundle: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ bundle: Bundle }>('/products/bundles', { method: 'POST', token, body }),
  updateBundle: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ bundle: Bundle }>(`/products/bundles/${id}`, { method: 'PATCH', token, body }),
  deleteBundle: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/bundles/${id}`, { method: 'DELETE', token }),

  // Dashboard
  getDashboardKpi: (token: string) =>
    apiFetch<{ kpi: DashboardKpi }>('/dashboard/kpi', { token }),
  getDashboardWeekly: (token: string, days = 7) =>
    apiFetch<{ series: DashboardWeeklyPoint[] }>(`/dashboard/weekly?days=${days}`, { token }),
  getDashboardTopAgents: (token: string) =>
    apiFetch<{ agents: DashboardTopAgent[] }>('/dashboard/top-agents', { token }),

  // Audit
  listAuditLogs: (token: string, query?: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return apiFetch<{ logs: AuditLog[]; pagination: { page: number; pageSize: number; total: number } }>(
      `/audit-logs/${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },

  // Customers
  listCustomers: (token: string, query?: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return apiFetch<{ customers: CustomerSummary[]; pagination: { page: number; pageSize: number; total: number } }>(
      `/customers/${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },
  getCustomer: (token: string, id: string) =>
    apiFetch<{ customer: CustomerDetail }>(`/customers/${id}`, { token }),
  updateCustomer: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ customer: CustomerSummary }>(`/customers/${id}`, { method: 'PATCH', token, body }),

  // Travelers
  listTravelers: (token: string, query?: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return apiFetch<{ travelers: Traveler[]; pagination: { page: number; pageSize: number; total: number } }>(
      `/travelers/${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },
  createTraveler: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ traveler: Traveler }>('/travelers/', { method: 'POST', token, body }),
  updateTraveler: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ traveler: Traveler }>(`/travelers/${id}`, { method: 'PATCH', token, body }),
  deleteTraveler: (token: string, id: string) =>
    apiFetch<{ result: { id: string } }>(`/travelers/${id}`, { method: 'DELETE', token }),

  // Fulfillment
  listFulfillmentTasks: (token: string, query?: ListFulfillmentParams) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    return apiFetch<{
      tasks: FulfillmentTask[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/fulfillment-tasks/${qs.toString() ? '?' + qs.toString() : ''}`, { token });
  },
  listFulfillmentByOrder: (token: string, orderId: string) =>
    apiFetch<{ tasks: FulfillmentTask[] }>(`/fulfillment-tasks/by-order/${orderId}`, { token }),
  // 批量改履约任务状态（签证台批量标"已送签"等；逐条校验，部分失败返回 failures）
  batchUpdateFulfillmentStatus: (token: string, taskIds: string[], toStatus: FulfillmentStatus) =>
    apiFetch<BatchFulfillmentStatusResult>('/fulfillment-tasks/batch-status', {
      method: 'POST',
      token,
      body: { taskIds, toStatus },
    }),
  updateFulfillmentTask: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ task: FulfillmentTask }>(`/fulfillment-tasks/${id}`, { method: 'PATCH', token, body }),
  reissueFulfillmentTask: (token: string, id: string) =>
    apiFetch<{ task: FulfillmentTask }>(`/fulfillment-tasks/${id}/reissue`, { method: 'POST', token }),
  resendItineraryEmail: (token: string, orderId: string) =>
    apiFetch<{
      orderNumber: string;
      result:
        | { status: 'sent'; sentTo: string; messageId?: string }
        | { status: 'no_email' }
        | { status: 'not_all_ticketed'; ticketedCount: number; totalCount: number }
        | { status: 'smtp_disabled'; wouldSendTo: string }
        | { status: 'no_flights' };
    }>(`/fulfillment-tasks/by-order/${orderId}/resend-itinerary`, { method: 'POST', token }),

  // Pricing — 日期等级
  listDateRankings: (token: string, from: string, to: string) =>
    apiFetch<{
      rankings: Array<{
        date: string;
        rank: 'A' | 'B' | 'C' | 'D';
        reason: string | null;
        isManual: boolean;
        source: 'db' | 'default';
      }>;
    }>(`/pricing/date-rankings?from=${from}&to=${to}`, { token }),
  overrideDateRanking: (
    token: string,
    date: string,
    body: { rank: 'A' | 'B' | 'C' | 'D'; reason?: string },
  ) => apiFetch<{ ranking: unknown }>(`/pricing/date-rankings/${date}`, {
    method: 'PATCH', token, body,
  }),
  resetDateRanking: (token: string, date: string) =>
    apiFetch<{ ok: boolean }>(`/pricing/date-rankings/${date}`, { method: 'DELETE', token }),

  // Cancellation policies
  listCancellationPolicies: (token: string) =>
    apiFetch<{ policies: CancellationPolicy[] }>('/cancellation-policies/', { token }),
  createCancellationPolicy: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ policy: CancellationPolicy }>('/cancellation-policies/', {
      method: 'POST', token, body,
    }),
  updateCancellationPolicy: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ policy: CancellationPolicy }>(`/cancellation-policies/${id}`, {
      method: 'PATCH', token, body,
    }),
  deleteCancellationPolicy: (token: string, id: string) =>
    apiFetch<{ ok: boolean }>(`/cancellation-policies/${id}`, { method: 'DELETE', token }),

  // 财务模块（ADMIN-only）— 业务 P&L
  getFinanceSummary: (token: string, range: { from: string; to: string }) =>
    apiFetch<FinanceSummary>(
      `/finances/summary?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { token },
    ),
  getFinanceFlights: (token: string, range: { from: string; to: string }, limit = 100) =>
    apiFetch<{ range: { from: string; to: string }; rows: FlightPnlRow[] }>(
      `/finances/flights?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=${limit}`,
      { token },
    ),
  getFinanceOrders: (token: string, range: { from: string; to: string }, limit = 100) =>
    apiFetch<{ range: { from: string; to: string }; rows: OrderPnlRow[] }>(
      `/finances/orders?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=${limit}`,
      { token },
    ),
  getFinanceMonthly: (token: string, months = 6) =>
    apiFetch<{ months: number; points: MonthlyPoint[] }>(
      `/finances/monthly?months=${months}`,
      { token },
    ),

  // 产品成本编辑
  patchFlightScheduleCost: (
    token: string,
    id: string,
    body: Partial<{
      charterCostCny: number | null;
      airportTaxDepCny: number | null;
      airportTaxArrCny: number | null;
      fuelCostCny: number | null;
      peakSurchargeCny: number | null;
      aircraftAdjustCny: number | null;
      takeoffDiscountCny: number | null;
    }>,
  ) => apiFetch<{ id: string }>(`/finances/cost/flight-schedule/${id}`, { method: 'PATCH', token, body }),

  // 航班成本周期 CRUD
  listCostPeriods: (token: string, flightId?: string) => {
    const qs = flightId ? `?flightId=${encodeURIComponent(flightId)}` : '';
    return apiFetch<{ periods: CostPeriodDto[] }>(`/finances/cost/periods${qs}`, { token });
  },
  createCostPeriod: (token: string, body: CostPeriodWriteInput) =>
    apiFetch<{ period: CostPeriodDto }>('/finances/cost/periods', { method: 'POST', token, body }),
  updateCostPeriod: (
    token: string,
    id: string,
    body: Partial<Omit<CostPeriodWriteInput, 'flightId'>>,
  ) => apiFetch<{ period: CostPeriodDto }>(`/finances/cost/periods/${id}`, { method: 'PATCH', token, body }),
  deleteCostPeriod: (token: string, id: string) =>
    apiFetch<{ id: string }>(`/finances/cost/periods/${id}`, { method: 'DELETE', token }),

  // 订单杂项成本（OrderCostItem）CRUD
  listOrderCostItems: (token: string, orderId: string) =>
    apiFetch<{ items: OrderCostItem[] }>(`/orders/${orderId}/cost-items`, { token }),
  createOrderCostItem: (
    token: string,
    orderId: string,
    body: { category: OrderCostCategory; amountCny: number; note?: string | null },
  ) => apiFetch<{ item: OrderCostItem }>(`/orders/${orderId}/cost-items`, { method: 'POST', token, body }),
  updateOrderCostItem: (
    token: string,
    id: string,
    body: Partial<{ category: OrderCostCategory; amountCny: number; note: string | null }>,
  ) => apiFetch<{ item: OrderCostItem }>(`/orders/cost-items/${id}`, { method: 'PATCH', token, body }),
  deleteOrderCostItem: (token: string, id: string) =>
    apiFetch<{ id: string }>(`/orders/cost-items/${id}`, { method: 'DELETE', token }),

  // 订单预期到账金额 + 锁定（出纳）
  setExpectedAmount: (token: string, orderId: string, amountCny: number | null) =>
    apiFetch<{ id: string; expectedAmountCny: number | null; expectedAmountLocked: boolean }>(
      `/orders/${orderId}/expected-amount`,
      { method: 'PATCH', token, body: { amountCny } },
    ),
  lockExpectedAmount: (token: string, orderId: string, locked: boolean) =>
    apiFetch<{ id: string; expectedAmountCny: number | null; expectedAmountLocked: boolean }>(
      `/orders/${orderId}/expected-amount/lock`,
      { method: 'POST', token, body: { locked } },
    ),

  // 班次成本明细（admin · 用于"航班成本"维护页；带"单座(已售)成本"动态指标）
  listFinanceSchedules: (
    token: string,
    range?: { from?: string; to?: string },
  ) => {
    const qs = new URLSearchParams();
    if (range?.from) qs.set('from', range.from);
    if (range?.to) qs.set('to', range.to);
    return apiFetch<{ schedules: FinanceScheduleRow[] }>(
      `/finances/cost/schedules${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },
  patchHotelRoomTypeCost: (
    token: string,
    id: string,
    body: Partial<{ costPriceCny: number | null }>,
  ) => apiFetch<{ id: string }>(`/finances/cost/hotel-room-type/${id}`, { method: 'PATCH', token, body }),
  patchVisaCost: (
    token: string,
    id: string,
    body: Partial<{ costPriceCny: number | null }>,
  ) => apiFetch<{ id: string }>(`/finances/cost/visa/${id}`, { method: 'PATCH', token, body }),
  patchTransferCost: (
    token: string,
    id: string,
    body: Partial<{ costPriceCny: number | null }>,
  ) => apiFetch<{ id: string }>(`/finances/cost/transfer/${id}`, { method: 'PATCH', token, body }),

  // 财务核对 xlsx 导出（Blob 直接下载）
  downloadFinanceExport: async (
    token: string,
    range: { from: string; to: string },
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/finances/export?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  // 财务对账 xlsx 按航班维度导出（一行一个班次）
  downloadFinanceExportByFlight: async (
    token: string,
    range: { from: string; to: string },
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/finances/export-by-flight?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  // ── 房控（ADMIN/STAFF）— 包房周期 CRUD + 销控板 / 远期视图 ─────────────
  listBlockPeriods: (token: string, hotelId?: string) => {
    const qs = hotelId ? `?hotelId=${encodeURIComponent(hotelId)}` : '';
    return apiFetch<{ periods: HotelBlockPeriod[] }>(`/hotel-control/block-periods${qs}`, { token });
  },
  createBlockPeriod: (token: string, body: BlockPeriodWriteInput) =>
    apiFetch<{ period: HotelBlockPeriod }>('/hotel-control/block-periods', { method: 'POST', token, body }),
  updateBlockPeriod: (
    token: string,
    id: string,
    body: Partial<Omit<BlockPeriodWriteInput, 'hotelId'>>,
  ) => apiFetch<{ period: HotelBlockPeriod }>(`/hotel-control/block-periods/${id}`, { method: 'PATCH', token, body }),
  deleteBlockPeriod: (token: string, id: string) =>
    apiFetch<{ id: string }>(`/hotel-control/block-periods/${id}`, { method: 'DELETE', token }),
  getHotelBoard: (token: string, from: string, to: string) =>
    apiFetch<HotelControlBoard>(
      `/hotel-control/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { token },
    ),
  getHotelForward: (token: string, from: string, to: string) =>
    apiFetch<HotelControlForward>(
      `/hotel-control/forward?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { token },
    ),
  // 提醒线（超卖加房 / 富余退房 / 班次超开票上限；按需计算，无 cron）
  getHotelAlerts: (token: string, days = 14) =>
    apiFetch<HotelControlAlerts>(`/hotel-control/alerts?days=${days}`, { token }),

  // 分房表导出（成都格式：每入住日期一个 sheet；ADMIN/STAFF only）— Blob 直接下载
  downloadRoomAllocation: async (
    token: string,
    range: { from: string; to: string },
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/orders/export-room-allocation?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  // ── 候补（ADMIN/STAFF）— 某班次候补名单（含用户联系方式，电话回访用）──
  listWaitlistBySchedule: (token: string, scheduleId: string) =>
    apiFetch<{ entries: WaitlistEntry[] }>(
      `/waitlist/?scheduleId=${encodeURIComponent(scheduleId)}`,
      { token },
    ),
};

// ── 财务模块类型（与 backend/src/modules/finances/finances.service.ts 对齐）──
export interface CategoryBreakdown {
  kind: string;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null;
  orderItemCount: number;
}
/** 财务口径：收入细分（10 项 + 未分类 + 总和） */
export interface RevenueBreakdown {
  outboundFlight: number;
  returnFlight: number;
  outboundTax: number;
  returnTax: number;
  hotel: number;
  visa: number;
  transfer: number;
  guide: number;
  upgradeChange: number;
  oversale: number;
  uncategorized: number;
  total: number;
}
/** 财务口径：成本细分（16 项 + 总和） */
export interface CostBreakdown {
  outboundCharter: number;
  returnCharter: number;
  outboundTax: number;
  returnTax: number;
  peakSurcharge: number;
  fuel: number;
  aircraftAdjust: number;
  takeoffDiscount: number;
  hotel: number;
  visa: number;
  transfer: number;
  guideService: number;
  compGift: number;
  handlingFee: number;
  operationFee: number;
  other: number;
  total: number;
}
export interface FinanceSummary {
  range: { from: string; to: string };
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null;
  emptySeatSunkCostCny: number;
  netMarginCny: number;
  orderCount: number;
  missingCostItemCount: number;
  categories: CategoryBreakdown[];
  revenueBreakdown: RevenueBreakdown;
  costBreakdown: CostBreakdown;
}
export interface FlightPnlRow {
  scheduleId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string;
  charterCostCny: number | null;
  totalSeats: number;
  soldSeats: number;
  loadPct: number;
  revenueCny: number;
  soldSeatAllocCostCny: number | null;
  emptySeatSunkCostCny: number | null;
  netMarginCny: number | null;
  grossOnSoldCny: number | null;
  /** 单座(已售)成本 = charterCostCny ÷ soldSeats；charter 或 sold 为 0 时 null */
  perSoldSeatCostCny: number | null;
}

export type CostSource = 'override' | 'period' | 'none';

/**
 * 班次成本明细行（admin-only · 用于"航班成本"维护页）
 * 来自 GET /finances/cost/schedules
 * - charterCostCny / airportTax{Dep,Arr}Cny / fuelCostCny / peakSurchargeCny / aircraftAdjustCny / takeoffDiscountCny = 生效值（override → period → null）
 * - *Override = 班次自己存的（编辑框绑定）；*Period = 命中周期的默认（placeholder）；*Source = override/period/none
 */
export interface FinanceScheduleRow {
  scheduleId: string;
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string;
  // 生效（用于显示）
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  // 班次自己（"覆盖"）—— 编辑框绑这个
  charterCostCnyOverride: number | null;
  airportTaxDepCnyOverride: number | null;
  airportTaxArrCnyOverride: number | null;
  fuelCostCnyOverride: number | null;
  peakSurchargeCnyOverride: number | null;
  aircraftAdjustCnyOverride: number | null;
  takeoffDiscountCnyOverride: number | null;
  // 周期默认（placeholder 显示）
  charterCostCnyPeriod: number | null;
  airportTaxDepCnyPeriod: number | null;
  airportTaxArrCnyPeriod: number | null;
  fuelCostCnyPeriod: number | null;
  peakSurchargeCnyPeriod: number | null;
  aircraftAdjustCnyPeriod: number | null;
  takeoffDiscountCnyPeriod: number | null;
  // 来源
  charterCostCnySource: CostSource;
  airportTaxDepCnySource: CostSource;
  airportTaxArrCnySource: CostSource;
  fuelCostCnySource: CostSource;
  peakSurchargeCnySource: CostSource;
  aircraftAdjustCnySource: CostSource;
  takeoffDiscountCnySource: CostSource;
  // 命中周期信息
  matchedPeriodId: string | null;
  matchedPeriodFrom: string | null;
  matchedPeriodTo: string | null;
  // 座位
  totalSeats: number;
  soldSeats: number;
  /** 单座(已售)成本 = charterCostCny ÷ soldSeats；charter 或 sold 为 0 时 null */
  perSoldSeatCostCny: number | null;
}

/** 航班成本周期（按 (航班, 日期段) 定包机/机场税/4 个新成本字段） */
export interface CostPeriodDto {
  id: string;
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string;
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  note: string | null;
  updatedAt: string;
}
export interface CostPeriodWriteInput {
  flightId: string;
  effectiveFrom: string;
  effectiveTo: string;
  charterCostCny?: number | null;
  airportTaxDepCny?: number | null;
  airportTaxArrCny?: number | null;
  fuelCostCny?: number | null;
  peakSurchargeCny?: number | null;
  aircraftAdjustCny?: number | null;
  takeoffDiscountCny?: number | null;
  note?: string | null;
}

/** 订单杂项成本（财务录入） */
export type OrderCostCategory =
  | 'GUIDE_SERVICE'
  | 'COMP_GIFT'
  | 'HANDLING_FEE'
  | 'OPERATION_FEE'
  | 'OTHER';
export interface OrderCostItem {
  id: string;
  orderId: string;
  category: OrderCostCategory;
  amountCny: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OrderPnlRow {
  orderId: string;
  orderNumber: string;
  status: string;
  contactName: string;
  createdAt: string;
  totalCny: number;
  costCny: number | null;
  grossMarginCny: number | null;
  marginPct: number | null;
  itemCount: number;
  missingCostItemCount: number;
}
export interface MonthlyPoint {
  month: string;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  orderCount: number;
}

export type ProductKind = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'BUNDLE' | 'INSURANCE';

export interface CancellationTier {
  hoursBeforeDeparture: number;
  feePercent: number;
}

export interface CancellationPolicy {
  id: string;
  productKind: ProductKind;
  scope: string | null;
  name: string;
  tiers: CancellationTier[];
  isDefault: boolean;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
