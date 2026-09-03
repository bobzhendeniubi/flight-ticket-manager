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
  | 'REFUNDED'
  | 'CHANGE_REQUESTED'
  | 'CHANGED'
  | 'FAILED';

/** 与后端 Prisma PaymentMethod 枚举对齐（backend/prisma/schema.prisma）；此前 CREDIT_CARD/PREPAYMENT 与后端不符，从未真正同步过 */
export type PaymentMethod =
  | 'WECHAT_PAY'
  | 'ALIPAY'
  | 'BANK_CARD'
  | 'AGENT_PREPAYMENT';

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
  /** 公开接口已不返回精确容量/已售（防爬取实时销量）；保留可选仅为兼容老缓存 */
  capacity?: number;
  sold?: number;
  /** 公开口径余位：≤9 真实值，>9 封顶报 9（服务端契约） */
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
/**
 * 对外中性航段状态（镜像后端 orders.leg-status.ts 的 PublicLegStatus）。
 * 去程/回程被改动后（未登机、取消航段、回程暂无班次）后端只给这个中性枚举，
 * 不下发任何内部动作口径；买家口吻的文案统一放在 lib/legStatus.ts。
 */
export type PublicLegStatus =
  | 'RETURN_PENDING_REARRANGE'
  | 'RETURN_CANCELLED'
  | 'OUTBOUND_CANCELLED'
  | 'OUTBOUND_NOT_BOARDED';

export interface OrderItem {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
  /** FLIGHT 行：航班号（详情接口联查后才有；暂无班次时为 null） */
  flightNumber?: string | null;
  /** FLIGHT 行：出发日期 YYYY-MM-DD（同上） */
  departureDate?: string | null;
  /** 对外中性航段状态；无状态时不带该键，文案见 lib/legStatus.ts */
  publicLegStatus?: PublicLegStatus;
}

export interface OrderPassenger {
  id: string;
  fullName: string;
  documentNumber: string;
  pnr: string | null;
  eticketNumber: string | null;
}

// ── 取消订单 quote ───────────────────────────────────────────
export interface CancellationItemQuote {
  itemId: string;
  kind: string;
  description: string;
  amount: number;
  hoursLeft: number | null;
  policyName: string;
  feePercent: number;
  feeAmount: number;
  refundAmount: number;
  reason: string;
  fulfilled: boolean;
}

export interface CancellationQuote {
  orderId: string;
  orderNumber: string;
  paidAmount: number;
  totalFee: number;
  totalRefund: number;
  items: CancellationItemQuote[];
  cancellable: boolean;
  cancellableReason?: string;
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
