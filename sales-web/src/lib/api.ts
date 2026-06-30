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
  // 非 JSON 响应（如 nginx 的 HTML 502/404 页）不能直接 JSON.parse —— 否则抛
  // 裸 SyntaxError（不带 status），下游 401/404 处理会失效。容错为 undefined，
  // 由下面的 !res.ok 分支统一抛出带 status 的 ApiError。
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const errBody = (parsed as ApiErrorBody | undefined)?.error ?? {
      code: 'UNKNOWN',
      message: res.statusText || `HTTP ${res.status}`,
    };
    // ApiError.status 暴露 HTTP 状态码（结算/401/404 处理依赖它，见 H3）。
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

// ── 余位档位（服务端权威口径；买家只看档位，不展示精确余票数）──────────────
export type AvailabilityTier = 'AMPLE' | 'TIGHT' | 'LOW' | 'VERY_LOW' | 'SOLD_OUT';

// ── 酒店房量档位（公开端点只回档位不回原始数字，与六档余位同纪律）──────────
export type HotelAvailabilityTier = 'AMPLE' | 'TIGHT' | 'LOW' | 'SOLD_OUT';

export interface HotelAvailabilityResult {
  /** null = 该时段未配置包房（前台不展示房量，也不拦截销售） */
  tier: HotelAvailabilityTier | null;
  nights: number;
}

// ── 套餐可售日期（公开；按 航班+酒店库存 逐日算，可设 blackout 封盘）──────────
/** 某日不可售的原因：封盘 / 机位售罄 / 满房；可售时为 null。 */
export type SellableDateReason = 'BLACKOUT' | 'FLIGHT_SOLD_OUT' | 'HOTEL_SOLD_OUT' | null;

/** GET /products/bundles/:id/sellable-dates 的单日（只回档位，不回原始库存数字）。 */
export interface SellableDate {
  dateISO: string;
  sellable: boolean;
  reason: SellableDateReason;
  /** 当日去/回机位综合档位（null = 无班次/未配置；前端不据此造数字） */
  flightTier: AvailabilityTier | null;
  /** 当日房量档位（null = 未关联包房） */
  hotelTier: HotelAvailabilityTier | null;
}

export interface SellableDatesResult {
  dates: SellableDate[];
}

/** 行李规则（按 航班×舱等 配置；kg / 件数可分别为空，未配置整体为 null） */
export interface BaggagePolicyInfo {
  checkedKg: number | null;
  checkedPieces: number | null;
  carryOnKg: number | null;
  note: string | null;
}

export interface FlightSeatAvailability {
  seatClassId: string; // 锁位接口（POST /seat-locks）需要
  cabin: CabinClass;
  capacity: number;
  sold: number;
  locked: number;
  available: number;
  availabilityTier: AvailabilityTier;
  basePrice: string;
  dynamicPrice: string;
  dateRank: string;
  dateMultiplier: number;
  totalForQty: number;
  /** 行李额（未配置 = null / 老缓存可能缺字段，前端按"不展示"处理） */
  baggage?: BaggagePolicyInfo | null;
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

/**
 * 取消订单的退款报价
 * 后端 lib/cancellation.ts 的 CancellationQuote 镜像（保持字段同步）
 */
export interface RefundQuoteItem {
  itemId: string;
  kind: string;
  description: string;
  amount: number;
  hoursLeft: number | null;
  policyId: string | null;
  policyName: string;
  feePercent: number;
  feeAmount: number;
  refundAmount: number;
  reason: string;
  fulfilled: boolean;
}

export interface RefundQuote {
  orderId: string;
  orderNumber: string;
  paidAmount: number;
  totalFee: number;
  totalRefund: number;
  items: RefundQuoteItem[];
  cancellable: boolean;
  cancellableReason?: string;
}

// ── 锁位 ──────────────────────────────────────────────────────────────────
// 下单前临时占座：单次 ≤9 张 / 固定 10 分钟 / 到期自动回收；
// 下单时服务端自动消费本人锁位（前端无需改结算流程）。
export type SeatLockStatus = 'ACTIVE' | 'EXPIRED' | 'CONSUMED' | 'RELEASED';

/** POST /seat-locks 返回的锁位记录 */
export interface SeatLock {
  id: string;
  flightScheduleId: string;
  seatClassId: string;
  userId: string;
  qty: number;
  status: SeatLockStatus;
  expiresAt: string;
  createdAt: string;
}

/** GET /seat-locks/mine 的行（含航班号/起飞时间/舱等，倒计时以 expiresAt 为基准） */
export interface MySeatLock {
  id: string;
  flightScheduleId: string;
  seatClassId: string;
  flightNumber: string;
  departureTime: string;
  cabin: CabinClass;
  qty: number;
  expiresAt: string;
  createdAt: string;
}

// ── 候补 ──────────────────────────────────────────────────────────────────
// 舱位售罄时登记候补（单次 1-9 张 + 联系手机号）；座位释放后按先来先到通知。
export type WaitlistStatus = 'ACTIVE' | 'NOTIFIED' | 'FULFILLED' | 'CANCELLED';

/** POST /waitlist 返回的候补记录 */
export interface WaitlistEntry {
  id: string;
  flightScheduleId: string;
  seatClassId: string;
  userId: string;
  qty: number;
  contactPhone: string;
  status: WaitlistStatus;
  createdAt: string;
}

/** GET /waitlist/mine 的行（含航班号/起飞时间/舱等/状态） */
export interface MyWaitlistEntry {
  id: string;
  flightScheduleId: string;
  seatClassId: string;
  flightNumber: string;
  departureTime: string;
  cabin: CabinClass;
  qty: number;
  status: WaitlistStatus;
  createdAt: string;
}

/**
 * 游客（未登录）下单联系人。
 * 仅在 **未登录** 时随 POST /orders 一起发送；已登录时省略（后端用 token 关联用户）。
 */
export interface GuestContact {
  name: string;
  phone: string;
  email?: string;
}

export interface CreateOrderInput {
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  paymentMethod?: PaymentMethod;
  /** 游客下单联系人；只在未登录场景传，已登录请省略。 */
  guestContact?: GuestContact;
  items: Array<
    | {
        kind: 'FLIGHT';
        description: string;
        quantity: number;
        flightScheduleId: string;
        flightCabin: CabinClass;
        /**
         * 套餐机票腿标记：值 = 该机票腿所属套餐的 bundleId。
         * 套餐下单时两条机票腿（去/回）带此标，后端据此按该套餐 discountPct 对机票腿打折。
         * 单买机票不带此字段。
         */
        bundleId?: string;
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
        /**
         * 占座模型三计数（后端权威重算占座/出行人/拼房；缺省时回退旧 pax → 全成人）：
         *   adultCount  = 成人（≥1）—— 占座，机票收经济舱全价
         *   childCount  = 占座儿童 —— 占座，机票按成人价减 childSeatDiscountCnyPerPerson
         *   infantCount = 不占座婴儿 —— 不占座、不占房，机票收 infantPriceCny；仍需护照（出行人计入）
         */
        adultCount?: number;
        childCount?: number;
        infantCount?: number;
        /**
         * 可选升级 add-on（整数份数，后端权威重算；缺省 0 = 无升级，价格与旧版一致）：
         *   singleCount   = 选「一个人住酒店（单人入住）」的人数（退出拼房 → 每人单独一间）
         *   businessCount = 选「升级商务舱」的人数（≤ 占座人数 seatPax；占用真实商务舱库存；
         *                   business>0 时本单必须同时带经济舱 FLIGHT 行供后端拆座）
         */
        singleCount?: number;
        businessCount?: number;
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
    /**
     * 护照全采集字段（客源地分析）—— 仅在前台 OCR 命中 MRZ 时带出，手填不要求。
     * 镜像后端 passengerInputSchema：gender enum 'M'|'F'|'X'；passportExpiry/passportIssueCountry
     * 全 optional，空值请省略（不要发 '' —— passportExpiry 的 YYYY-MM-DD 正则会拒空串）。
     */
    gender?: 'M' | 'F' | 'X';
    passportExpiry?: string; // YYYY-MM-DD
    passportIssueCountry?: string; // ISO-2
    /**
     * 护照图片 data-URL（≤6MB，前端压缩后传）。
     * 有才传；游客下单同样支持。
     */
    passportPhotoUrl?: string;
    /**
     * 中文姓名（镜像后端 passengerInputSchema.chineseName）。
     * 前台本地 OCR 基本带不出中文名，有值才传；缺省省略。
     */
    chineseName?: string;
    /**
     * 护照签发日期 YYYY-MM-DD（镜像后端 passengerInputSchema.passportIssueDate）。
     * 仅在 OCR/手填时带出；有值才传，不发空串（后端正则 \d{4}-\d{2}-\d{2} 会拒空串）。
     */
    passportIssueDate?: string;
  }>;
  notes?: string;
  idempotencyKey?: string;
}

// ── Products ─────────────────────────────────────────────────────────────

/**
 * 产品评分聚合（后端 list/detail 现在按 item 一并返回）。
 *
 * 注意命名：历史上 Hotel 已有 `rating: string`（单值字符串）与 `reviewCount`，
 * 为了不破坏既有页面对这两个字段的消费，结构化的评分聚合统一放在
 * `productRating`（不与旧 `rating` 冲突）。Phase-3 详情页消费评分聚合时
 * 读 `productRating`（{average,count}），需要展示销量读 `soldCount`。
 * 全部 optional，老缓存/未配置时为 undefined，前端按"不展示"处理。
 */
export interface ProductRating {
  average: number;
  count: number;
}

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
  /** 评分聚合（结构化；旧 `rating: string` 仍保留兼容，新代码读这里） */
  productRating?: ProductRating;
  /** 累计销量（null/缺省 = 不展示） */
  soldCount?: number;
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
  productRating?: ProductRating;
  reviewCount?: number;
  soldCount?: number;
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
  productRating?: ProductRating;
  reviewCount?: number;
  soldCount?: number;
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
  /**
   * 整单折扣百分比（整数 0–100，后端序列化返回）。
   * 套餐总价 = (实时机票 + 地面 + 加项) × (1 − discountPct/100)。
   * 旧的固定让利金额 groundDiscount 已弃用（后端不再读取），前台一律用 discountPct。
   */
  discountPct: number;
  /** @deprecated 已弃用的固定让利金额；后端不再读取，前台改用 discountPct（整单 percent off）。 */
  groundDiscount: string;
  suitableFor: string | null;
  isActive: boolean;
  /**
   * 可选升级 add-on 报价（server-priced，后端返回为整数 number）：
   *   singleSupplementCnyPerNight = 一个人住酒店（单人入住）每人每晚加价
   *   businessUpgradeCnyPerLeg    = 升级商务舱每人每程加价（占用真实商务舱库存）
   *   legs                        = 计费航段数（来回默认 2）
   * 直接在前台 add-on 里卖（不走客服）；0/缺省 = 不加价（与旧版价格一致）。
   */
  singleSupplementCnyPerNight?: number | null;
  businessUpgradeCnyPerLeg?: number | null;
  legs?: number | null;
  /**
   * 占座模型报价（server-priced，后端返回为整数 number）：
   *   childSeatDiscountCnyPerPerson = 占座儿童每人比成人便宜多少（机票折扣）
   *   infantPriceCny                = 不占座婴儿每人机票价（不走经济舱全价）
   * 0/缺省 = 不优惠/不收婴儿价（与旧版价格一致）。
   */
  childSeatDiscountCnyPerPerson?: number | null;
  infantPriceCny?: number | null;
  /**
   * 套餐关联酒店房型（展示酒店名 + 房型名；null = 未关联）。
   * capacity/maxAdults/maxChildren 由后端 serializer 暴露（products.service serialize），
   * 供前台镜像 roomsNeeded 计算与展示（"每间最多 X 大 Y 小"）。全 optional，老缓存缺省按兜底处理。
   */
  hotelRoomType?: {
    id: string;
    name: string;
    hotelName: string;
    capacity?: number | null;
    maxAdults?: number | null;
    maxChildren?: number | null;
  } | null;
  /** 关联房型 id（实时房量查询用；null = 未关联，不查房量） */
  hotelRoomTypeId?: string | null;
  /** 套餐住宿晚数（回程日期 = 出发 + 晚数；null = 用前端默认晚数） */
  hotelNights?: number | null;
  /**
   * 封盘日期（管理员手动设的不可售日；逐日可售查询会标 reason='BLACKOUT'）。
   * 全 optional / 缺省 []，老缓存不带此字段时前端按"无封盘"处理。
   */
  blackoutDates?: Array<{ date: string; reason?: string | null }> | null;
  /**
   * 套餐默认出发日（管理员设的"最近可出发日"；null = 未设，前端回退 today+3）。
   * 前台据此初始化出发日期输入框（仍受可售区间约束）。
   */
  defaultDepartDate?: string | null;
  /** 评分聚合 + 销量（后端 list/detail 现按 item 返回；全 optional 不破坏老页面） */
  productRating?: ProductRating;
  reviewCount?: number;
  soldCount?: number;
}

// ── 结算 / 佣金 ────────────────────────────────────────────────────────────
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

// ── 评价 / 评论 ─────────────────────────────────────────────────────────────
export type ReviewProductType = 'BUNDLE' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'FLIGHT';

/** 单条评价（对标 Klook/携程 评论；后端 GET /reviews 的 item） */
export interface Review {
  id: string;
  productType: ReviewProductType;
  productId: string;
  rating: number;
  title?: string;
  body: string;
  authorName: string;
  verified: boolean;
  tripType?: string;
  /** 商家回复（null/缺省 = 未回复） */
  reply?: string | null;
  orderId?: string | null;
  createdAt: string;
}

/** 评分聚合（GET /reviews 的 summary 字段） */
export interface ReviewSummary {
  average: number;
  count: number;
  /** 5/4/3/2/1 星各自条数 */
  distribution: Record<'5' | '4' | '3' | '2' | '1', number>;
}

/** GET /reviews 返回（分页 + 聚合） */
export interface ReviewListResult {
  items: Review[];
  total: number;
  page: number;
  limit: number;
  summary: ReviewSummary;
}

/** POST /orders/:id/review 入参 */
export interface CreateReviewInput {
  rating: number;
  body: string;
  title?: string;
  tripType?: string;
  /** 评指定产品时传；省略 = 评该订单里的全部产品 */
  productType?: ReviewProductType;
  /** HOTEL 时 productId = hotelRoomTypeId */
  productId?: string;
  /** 游客凭订单号+手机号评价（未登录时）；已登录用 token */
  orderNumber?: string;
  phone?: string;
}

// ── 订单查询（公开脱敏）─────────────────────────────────────────────────────
/** GET /orders/lookup 返回的脱敏订单项 */
export interface MaskedOrderItem {
  kind: OrderItemKind;
  productName: string;
  quantity: number;
  amount: string;
  /** 出行日期（ISO 字符串）；不适用时 null */
  travelDate: string | null;
}

/** GET /orders/lookup 返回的脱敏订单（无需登录，订单号 + 手机号或邮箱即可查） */
export interface MaskedOrder {
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: string;
  createdAt: string;
  total: string;
  items: MaskedOrderItem[];
  passengers: Array<{ name: string }>;
}

// ── 收款方式 / 付款凭证（公开）─────────────────────────────────────────────
/**
 * 公开收款渠道（GET /public/payment-channels，只回启用中的）。
 * 后端 serializePublicPaymentChannel：丢掉 isActive/sortOrder/时间戳，只回展示所需字段。
 *   kind：'WECHAT' | 'ALIPAY' | 'BANK'（渠道分组，与 PaymentMethod 不同）
 *   qrImageUrl：收款码图（data:image/...;base64 或外链）；null = 仅文字账户
 *   accountText：账户/收款信息文字（如银行卡号、户名）；null = 无
 *   note：补充说明（如"备注请填订单号"）；null = 无
 */
export type PaymentChannelKind = 'WECHAT' | 'ALIPAY' | 'BANK';

export interface PublicPaymentChannel {
  id: string;
  kind: PaymentChannelKind;
  label: string;
  qrImageUrl: string | null;
  accountText: string | null;
  note: string | null;
}

/** POST /public/orders/upload-receipt 入参（订单号 + lookupKey 校验，同公开查单）。 */
export interface UploadOrderReceiptInput {
  /** 订单号（3–40）。 */
  orderNo: string;
  /** 查单凭据：下单手机号 / 邮箱 / 联系人姓氏（与公开查单同口径）。 */
  lookupKey: string;
  /** 本次付款金额（选填，>0 且 ≤1e8）；不填则由财务对账时核定。 */
  amountCny?: number;
  /** 付款方式（选填）。 */
  method?: PaymentMethod;
  /** 付款凭证图（必填，data:image/...;base64，≤6MB）。 */
  proofUrl: string;
}

/** POST /public/orders/upload-receipt 返回（201）。 */
export interface UploadOrderReceiptResult {
  ok: true;
  receiptId: string;
  receiptNo: string;
  amountCny: string;
  status: 'OPEN';
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
  // POST /orders 现在登录可选：未登录传 token=null + body.guestContact；
  // apiFetch 在 token 为 null/空时不带 Authorization 头，不抛错。
  createOrder: (token: string | null, body: CreateOrderInput) =>
    apiFetch<{ order: OrderSummary }>('/orders/', { method: 'POST', token, body }),
  /**
   * 公开查单（无需登录）：订单号 + 手机号或邮箱（二选一）。
   * 命中返回脱敏订单；无匹配后端回 HTTP 404（apiFetch 抛 ApiError，status=404）。
   */
  lookupOrder: (params: { orderNumber: string; phone?: string; email?: string }) => {
    const qs = new URLSearchParams();
    qs.set('orderNumber', params.orderNumber);
    if (params.phone) qs.set('phone', params.phone);
    if (params.email) qs.set('email', params.email);
    return apiFetch<{ order: MaskedOrder }>(`/orders/lookup?${qs.toString()}`);
  },

  // ── 收款方式 / 付款凭证（公开，无需登录）──────────────────────────────────
  /** 公开收款渠道：买家下单后看到的统一收款码 / 账户（只回启用中的）。 */
  getPublicPaymentChannels: () =>
    apiFetch<{ channels: PublicPaymentChannel[] }>('/public/payment-channels'),
  /**
   * 公开上传付款凭证：凭「订单号 + lookupKey（手机号/邮箱/姓氏）」校验后建一条待对账凭证。
   * lookupKey 不匹配后端回 404（apiFetch 抛 ApiError，status=404）；按 IP 限流 10 次/分钟。
   * 注意：上传仅是"认领"，订单到账由财务人工核对后才入账（前端不据此改订单状态）。
   */
  uploadOrderReceipt: (input: UploadOrderReceiptInput) =>
    apiFetch<UploadOrderReceiptResult>('/public/orders/upload-receipt', {
      method: 'POST',
      body: input,
    }),
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
  /** 取消报价：起飞前几小时×费率，看一眼能退多少 */
  getRefundQuote: (token: string, id: string) =>
    apiFetch<{ quote: RefundQuote }>(`/orders/${id}/refund-quote`, { token }),
  /** 客户/代理 主动申请取消 → 进退款审核流 */
  cancelOrder: (token: string, id: string, reason?: string) =>
    apiFetch<{ order: OrderSummary; quote: RefundQuote; isNew: boolean }>(
      `/orders/${id}/cancel`,
      { method: 'POST', token, body: { reason } },
    ),

  // 锁位 — 下单前临时占座（单次 ≤9 张 / 固定 10 分钟 / 到期自动回收）
  createSeatLock: (
    token: string,
    body: { flightScheduleId: string; seatClassId: string; qty: number },
  ) => apiFetch<{ lock: SeatLock }>('/seat-locks/', { method: 'POST', token, body }),
  listMyLocks: (token: string) =>
    apiFetch<{ locks: MySeatLock[] }>('/seat-locks/mine', { token }),
  releaseSeatLock: (token: string, id: string) =>
    apiFetch<{ result: { id: string; status: SeatLockStatus } }>(`/seat-locks/${id}`, {
      method: 'DELETE',
      token,
    }),

  // 候补 — 舱位售罄时登记（1-9 张 + 手机号），座位释放后按先来先到通知
  createWaitlist: (
    token: string,
    body: { flightScheduleId: string; seatClassId: string; qty: number; contactPhone: string },
  ) => apiFetch<{ entry: WaitlistEntry }>('/waitlist/', { method: 'POST', token, body }),
  listMyWaitlist: (token: string) =>
    apiFetch<{ entries: MyWaitlistEntry[] }>('/waitlist/mine', { token }),
  cancelWaitlist: (token: string, id: string) =>
    apiFetch<{ result: { id: string; status: WaitlistStatus } }>(`/waitlist/${id}`, {
      method: 'DELETE',
      token,
    }),

  // 产品（公开）
  listHotels: () => apiFetch<{ hotels: Hotel[] }>('/products/hotels?active=1'),
  listTransfers: () => apiFetch<{ transfers: Transfer[] }>('/products/transfers?active=1'),
  listVisas: () => apiFetch<{ visas: Visa[] }>('/products/visas?active=1'),
  listBundles: () => apiFetch<{ bundles: Bundle[] }>('/products/bundles?active=1'),

  // 酒店房量档位（公开；[checkIn, checkOut) 半开区间，只回档位不回数字）
  getHotelAvailability: (params: { hotelRoomTypeId: string; checkIn: string; checkOut: string }) => {
    const qs = new URLSearchParams(params);
    return apiFetch<HotelAvailabilityResult>(`/products/hotel-availability?${qs.toString()}`);
  },

  // 套餐可售日期（公开；按 航班+酒店库存 逐日算，可设 blackout 封盘）。
  // to 可省（后端默认 from+59 天）；区间 ≤90 天。只回档位与 sellable/reason，不回原始数字。
  getBundleSellableDates: (bundleId: string, from: string, to?: string) => {
    const qs = new URLSearchParams({ from });
    if (to) qs.set('to', to);
    return apiFetch<SellableDatesResult>(
      `/products/bundles/${encodeURIComponent(bundleId)}/sellable-dates?${qs.toString()}`,
    );
  },

  // 结算 / 佣金 — 代理在自己的 dashboard 看分成
  // 后端 RBAC：AGENT 看自己 + 下级；ADMIN/STAFF 看全部
  listSettlements: (
    token: string,
    query?: { period?: string; agentId?: string; status?: SettlementStatus; page?: number; pageSize?: number },
  ) => {
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

  // 评价（公开读；写需订单关联）
  /** GET /reviews — 某产品的评价列表 + 评分聚合（分页） */
  listReviews: (params: {
    productType: string;
    productId: string;
    page?: number;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    qs.set('productType', params.productType);
    qs.set('productId', params.productId);
    if (params.page !== undefined) qs.set('page', String(params.page));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    return apiFetch<ReviewListResult>(`/reviews?${qs.toString()}`);
  },
  /**
   * POST /orders/:id/review — 对已完成订单写评价。
   * 已登录传 token；游客评价可省 token，用 body.orderNumber + body.phone 验证。
   * 返回 201 + 创建的评价数组（评整单时一次可创建多条）。
   */
  createReview: (orderId: string, body: CreateReviewInput, token?: string | null) =>
    apiFetch<{ created: Review[] }>(`/orders/${orderId}/review`, {
      method: 'POST',
      token: token ?? undefined,
      body,
    }),

  // AI 助手（公开 — 任何人可聊；下单时才要登录）
  aiChat: (body: { messages: AiChatMessage[]; userMessage: string }) =>
    apiFetch<AiChatResponse>('/ai/chat', { method: 'POST', body }),
};

// ── AI 助手类型 ─────────────────────────────────────────────
// OpenAI Chat Completions 消息形状（前端不解读，原样回传维持上下文）
// role: system | user | assistant | tool；content / tool_calls / tool_call_id 都可能有
export type AiChatMessage = Record<string, unknown>;

export type AiProposalItemKind = 'FLIGHT' | 'VISA' | 'HOTEL' | 'TRANSFER' | 'BUNDLE';

export interface AiProposalItem {
  kind: AiProposalItemKind;
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
