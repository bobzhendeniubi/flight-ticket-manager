/**
 * 后端 API 响应类型 — 和 sales-web/src/lib/api.ts 保持同步。
 *
 * 维护规则：后端改字段 → sales-web 类型改 → 这里跟着改。
 * 未来考虑抽到 packages/shared/，小程序 + 两个 web 共享。
 */

// ── 基础 ───────────────────────────────────────────────────
export type CabinClass = 'ECONOMY' | 'BUSINESS' | 'FIRST' | 'PREMIUM_ECONOMY';

export type OrderStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'TICKETED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'PAYMENT_TIMEOUT'
  | 'REFUND_REQUESTED'
  | 'REFUNDED';

export type PaymentMethod =
  | 'WECHAT_PAY'
  | 'ALIPAY'
  | 'CREDIT_CARD'
  | 'PREPAYMENT';

// ── 认证 ───────────────────────────────────────────────────
export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: 'CUSTOMER' | 'AGENT' | 'STAFF' | 'ADMIN';
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

// ── 航班 ───────────────────────────────────────────────────
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

// ── 订单 ───────────────────────────────────────────────────
export interface OrderItem {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface OrderPassenger {
  id: string;
  fullName: string;
  documentNumber: string;
  pnr: string | null;
  eticketNumber: string | null;
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
}
