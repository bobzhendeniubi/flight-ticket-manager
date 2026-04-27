/**
 * 后端 REST API 的轻量 fetch 封装。
 *
 * API base URL 可通过构建时 env 注入（Vite 约定 VITE_ 前缀）：
 *   - 开发：默认 /api（vite-dev 代理到 http://localhost:4000）
 *   - 生产：例如 VITE_API_BASE=https://api.citur.com 或保留 /api（前端 nginx 反代）
 *
 * 运行时 env 不可用（静态 HTML 已编译）；若要切域名必须重新构建镜像。
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

export interface FlightSeatAvailability {
  cabin: CabinClass;
  capacity: number;
  sold: number;
  available: number;
  basePrice: string;
  dynamicPrice: string;
  dateRank: string;
  dateMultiplier: number;
  totalForQty: number;
}

export interface SeatBreakdown {
  seatIndex: number;
  bucket: number;
  bucketMultiplier: number;
  unitPrice: number;
}

export interface PriceResult {
  scheduleId: string;
  cabin: CabinClass;
  qty: number;
  basePrice: number;
  dateRank: string;
  dateMultiplier: number;
  bucketSize: number;
  totalBuckets: number;
  currentBucket: number;
  currentBucketRemaining: number;
  perSeatBreakdown: SeatBreakdown[];
  totalPrice: number;
  averageUnitPrice: number;
}

export interface FlightSearchResult {
  scheduleId: string;
  flightId: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  aircraftType: string | null;
  departureTime: string;
  arrivalTime: string;
  departureTz: string;
  arrivalTz: string;
  durationMinutes: number;
  seatClasses: FlightSeatAvailability[];
  hasSpace: boolean;
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

export interface AgentListItem {
  id: string;
  userId: string;
  tier: number;
  parentAgentId: string | null;
  parent: {
    id: string;
    companyName: string | null;
    contactName: string;
    tier: number;
  } | null;
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
  paymentExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  passengers: OrderPassenger[];
  agent: { id: string; companyName: string | null; contactName: string } | null;
  user: { id: string; displayName: string | null; email: string | null };
}

export interface CreateOrderInput {
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  paymentMethod?: PaymentMethod;
  items: Array<
    | {
        kind: 'FLIGHT';
        description: string;
        quantity: number;
        flightScheduleId: string;
        flightCabin: CabinClass;
        metadata?: Record<string, unknown>;
      }
    | {
        kind: 'HOTEL';
        description: string;
        quantity: number;
        unitPrice: number;
        hotelRoomTypeId?: string;
        checkIn?: string;
        checkOut?: string;
        metadata?: Record<string, unknown>;
      }
    | {
        kind: 'TRANSFER';
        description: string;
        quantity: number;
        unitPrice: number;
        transferId?: string;
        metadata?: Record<string, unknown>;
      }
    | {
        kind: 'VISA';
        description: string;
        quantity: number;
        unitPrice: number;
        visaId?: string;
        metadata?: Record<string, unknown>;
      }
    | {
        kind: 'BUNDLE';
        description: string;
        quantity: number;
        unitPrice: number;
        bundleId: string;
        metadata?: Record<string, unknown>;
      }
  >;
  passengers: Array<{
    fullName: string;
    documentType?: DocumentType;
    documentNumber: string;
    dateOfBirth: string;
    nationality?: string;
    passengerType?: PassengerType;
  }>;
  notes?: string;
  idempotencyKey?: string;
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
}

export interface Visa {
  id: string;
  destinationCountry: string;
  country: string | null;
  visaType: string;
  visaName: string | null;
  flag: string | null;
  photo: string | null;
  processingDays: number;
  basePrice: string;
  expressSurcharge: string | null;
  validityMonths: number | null;
  highlight: string | null;
  requiredDocs: string[];
  isActive: boolean;
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
}

// ── Typed endpoints ───────────────────────────────────────────────────────

export const api = {
  // 认证
  register: (email: string, password: string, displayName?: string) =>
    apiFetch<AuthResult>('/auth/register', {
      method: 'POST',
      body: { email, password, displayName },
    }),
  login: (email: string, password: string) =>
    apiFetch<AuthResult>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  refresh: (refreshToken: string) =>
    apiFetch<{ tokens: AuthTokens }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    }),
  logout: (refreshToken: string) =>
    apiFetch<void>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    }),
  me: (token: string) =>
    apiFetch<{
      user: AuthUser & {
        phone: string | null;
        emailVerified: boolean;
        phoneVerified: boolean;
        createdAt: string;
        lastLoginAt: string | null;
      };
    }>('/users/me', { token }),

  // 航班搜索（公开）
  searchFlights: (params: {
    origin?: string;
    destination?: string;
    date?: string;
    cabin?: CabinClass;
    passengers?: number;
  }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return apiFetch<{ results: FlightSearchResult[] }>(`/flights/search?${qs.toString()}`);
  },

  // 动态定价查询（公开，不改 sold）
  getFlightPrice: (params: { scheduleId: string; cabin: CabinClass; qty: number }) => {
    const qs = new URLSearchParams({
      scheduleId: params.scheduleId,
      cabin: params.cabin,
      qty: String(params.qty),
    });
    return apiFetch<{ pricing: PriceResult }>(`/flights/price?${qs.toString()}`);
  },

  // 管理员航班
  listAllFlights: (token: string) =>
    apiFetch<{ flights: AdminFlight[] }>('/flights/', { token }),
  createFlight: (
    token: string,
    body: { flightNumber: string; originCode: string; destinationCode: string; aircraftType?: string },
  ) => apiFetch<{ flight: AdminFlight }>('/flights/', { method: 'POST', token, body }),
  toggleFlight: (token: string, flightId: string) =>
    apiFetch<{ flight: AdminFlight }>(`/flights/${flightId}/toggle`, { method: 'POST', token }),
  listSchedules: (token: string, flightId: string) =>
    apiFetch<{ schedules: unknown[] }>(`/flights/${flightId}/schedules`, { token }),
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
  ) => apiFetch<{ schedule: unknown }>('/flights/schedules', { method: 'POST', token, body }),

  // 代理
  listAgents: (token: string) =>
    apiFetch<{ agents: AgentListItem[] }>('/agents/', { token }),
  createChildAgent: (token: string, body: CreateChildAgentInput, parentId?: string) =>
    apiFetch<{ user: { id: string; email: string | null }; agent: { id: string; tier: number } }>(
      parentId ? `/agents/children?parentId=${encodeURIComponent(parentId)}` : '/agents/children',
      { method: 'POST', token, body },
    ),

  // 订单
  createOrder: (token: string, body: CreateOrderInput) =>
    apiFetch<{ order: OrderSummary }>('/orders/', { method: 'POST', token, body }),
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

  // 产品（公开）
  listHotels: () => apiFetch<{ hotels: Hotel[] }>('/products/hotels?active=1'),
  listTransfers: () => apiFetch<{ transfers: Transfer[] }>('/products/transfers?active=1'),
  listVisas: () => apiFetch<{ visas: Visa[] }>('/products/visas?active=1'),
  listBundles: () => apiFetch<{ bundles: Bundle[] }>('/products/bundles?active=1'),

  // AI 助手（公开 — 任何人可聊；下单时才要登录）
  aiChat: (body: { messages: AiChatMessage[]; userMessage: string }) =>
    apiFetch<AiChatResponse>('/ai/chat', { method: 'POST', body }),
};

// ── AI 助手类型 ─────────────────────────────────────────────
// OpenAI Chat Completions 消息形状（前端不解读，原样回传维持上下文）
// role: system | user | assistant | tool；content / tool_calls / tool_call_id 都可能有
export type AiChatMessage = Record<string, unknown>;

export interface AiProposalItem {
  kind: 'FLIGHT' | 'VISA';
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  detail: Record<string, unknown>;
  cartItem: {
    kind: string;
    productId: string;
    name: string;
    emoji?: string;
    unitPrice: number;
    qty: number;
    meta?: Record<string, unknown>;
  };
}

export interface AiProposal {
  kind: 'PROPOSAL';
  items: AiProposalItem[];
  totalPrice: number;
  summary: string;
  cartItems: Array<AiProposalItem['cartItem']>;
  note: string;
}

export interface AiChatResponse {
  reply: string;
  proposals: AiProposal[];
  messages: AiChatMessage[];
  debug: {
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
  };
  mocked: boolean;
}
