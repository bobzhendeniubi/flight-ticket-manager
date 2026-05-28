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

export interface AdminScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  basePrice: string;
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
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  notes?: string;
  passengers: BatchOrderPassenger[];
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

export type OrderItemKind = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'INSURANCE' | 'FEE' | 'DISCOUNT';
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
  agent: { id: string; companyName: string | null; contactName: string } | null;
  user: { id: string; displayName: string | null; email: string | null };

  // 新增字段（5/20 反馈）
  notes?: string | null;
  internalNotes?: string | null;
  claimedById?: string | null;
  claimedAt?: string | null;
  claimedBy?: { id: string; displayName: string | null; email: string | null } | null;
  roomAssignment?: RoomAssignment | null;
  reminders?: OperationalReminder[];
  // 订单详情(getOrder)带出的收款记录（列表不含，避免 proof 数据膨胀）
  payments?: OrderPayment[];
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
  order?: { id: string; orderNumber: string; contactName: string; contactPhone: string; status: OrderStatus };
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
  costPriceVnd: string | null;
}

export interface Hotel {
  id: string;
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
  costPriceUsd: string | null;
  createdAt: string;
}

export interface BundleItemData {
  kind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';
  productName: string;
  qty: number;
  unitPrice: number;
}

export interface Bundle {
  id: string;
  name: string;
  tagline: string | null;
  emoji: string | null;
  photo: string | null;
  items: BundleItemData[];
  flightPax: number;
  groundDiscount: string;
  suitableFor: string | null;
  isActive: boolean;
  createdAt: string;
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

  // Agents
  listAgents: (token: string) => apiFetch<{ agents: AgentListItem[] }>('/agents/', { token }),
  createChildAgent: (token: string, body: CreateChildAgentInput, parentId?: string) =>
    apiFetch<{ user: { id: string; email: string | null }; agent: { id: string; tier: number } }>(
      parentId ? `/agents/children?parentId=${encodeURIComponent(parentId)}` : '/agents/children',
      { method: 'POST', token, body },
    ),

  // Orders
  listOrders: (token: string, query?: Record<string, string | number | undefined>) => {
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

  // 设置开票状态（ADMIN/STAFF）
  setInvoiceStatus: (token: string, id: string, invoiceStatus: InvoiceStatus) =>
    apiFetch<{ id: string; orderNumber: string; invoiceStatus: InvoiceStatus }>(
      `/orders/${id}/invoice-status`,
      { method: 'PATCH', token, body: { invoiceStatus } },
    ),

  // 人工确认收款（线下收款 → 标记已付 + 上传截图）ADMIN/STAFF
  confirmPayment: (
    token: string,
    body: { orderId: string; amount?: number; method: PaymentMethod; proofUrl?: string; note?: string },
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
  // 修改订单备注
  updateOrderNotes: (
    token: string,
    orderId: string,
    body: { notes?: string; internalNotes?: string },
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
  listFulfillmentByOrder: (token: string, orderId: string) =>
    apiFetch<{ tasks: FulfillmentTask[] }>(`/fulfillment-tasks/by-order/${orderId}`, { token }),
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

  // 汇率管理
  getExchangeRates: (token: string) =>
    apiFetch<{ rates: ExchangeRate[] }>('/finances/exchange-rates', { token }),
  upsertExchangeRate: (
    token: string,
    body: { currency: string; kind: string; rateToCny: number; note?: string },
  ) => apiFetch<{ rate: ExchangeRate }>('/finances/exchange-rates', { method: 'PUT', token, body }),

  // 产品成本编辑
  patchFlightScheduleCost: (
    token: string,
    id: string,
    body: Partial<{
      charterCostCny: number | null;
      ticketCostUsd: number | null;
      airportTaxDepUsd: number | null;
      airportTaxArrUsd: number | null;
    }>,
  ) => apiFetch<{ id: string }>(`/finances/cost/flight-schedule/${id}`, { method: 'PATCH', token, body }),
  patchHotelRoomTypeCost: (
    token: string,
    id: string,
    body: Partial<{ costPriceCny: number | null; costPriceVnd: number | null }>,
  ) => apiFetch<{ id: string }>(`/finances/cost/hotel-room-type/${id}`, { method: 'PATCH', token, body }),
  patchVisaCost: (
    token: string,
    id: string,
    body: Partial<{ costPriceCny: number | null; costPriceUsd: number | null }>,
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
};

export interface ExchangeRate {
  id: string;
  currency: string;
  kind: string;
  rateToCny: number;
  note: string | null;
  updatedAt: string;
}

// ── 财务模块类型（与 backend/src/modules/finances/finances.service.ts 对齐）──
export interface CategoryBreakdown {
  kind: string;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null;
  orderItemCount: number;
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
