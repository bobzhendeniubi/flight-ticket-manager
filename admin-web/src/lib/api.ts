/**
 * SHARED with sales-web/src/lib/api.ts — keep them in sync (admin-web subset).
 * 后端 REST API 封装。所有端点都在 /api 下，由 vite-dev 代理到 :4000。
 */
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

  const res = await fetch(`/api${path}`, {
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
}

export interface OrderPassenger {
  id: string;
  fullName: string;
  documentType?: DocumentType;
  documentNumber?: string;
  dateOfBirth?: string;
  nationality?: string;
  passengerType?: PassengerType;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  userId: string;
  agentId: string | null;
  status: OrderStatus;
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
  updateOrderStatus: (token: string, id: string, toStatus: OrderStatus, reason?: string) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${id}/status`, {
      method: 'PATCH',
      token,
      body: { toStatus, reason },
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
};
