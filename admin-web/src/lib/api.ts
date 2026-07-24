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

/**
 * 重复乘客拦截错误的稳定 code（后端 DuplicatePassengerError）。前端按 code 判，
 * 绝不靠中文文案匹配。命中即弹「确认仍要录入」二次确认，确认后带 allowDuplicatePassengers 重试。
 */
export const DUPLICATE_PASSENGER_CODE = 'DUPLICATE_PASSENGER';

/**
 * 手工确认收款「同额软闸」的稳定 code（后端近 windowMinutes 分钟内同订单等额收款拦截）。
 * 前端按 code 判，命中即弹二次确认，确认后带 confirmDuplicate:true 重试。
 */
export const DUPLICATE_AMOUNT_CODE = 'DUPLICATE_AMOUNT';

/** 同额软闸 details 结构（后端保证：existingPaymentId + amount + windowMinutes）。 */
export interface DuplicateAmountDetails {
  existingPaymentId: string;
  amount: number;
  windowMinutes: number;
}

/** 从 DUPLICATE_AMOUNT 错误里取 details；非该错误 / 结构异常 → null。 */
export function duplicateAmountDetails(err: unknown): DuplicateAmountDetails | null {
  if (!(err instanceof ApiError) || err.code !== DUPLICATE_AMOUNT_CODE) return null;
  const d = err.details;
  if (!d || typeof d !== 'object') return null;
  const { existingPaymentId, amount, windowMinutes } = d as Record<string, unknown>;
  if (typeof amount !== 'number' || typeof windowMinutes !== 'number') return null;
  return {
    existingPaymentId: typeof existingPaymentId === 'string' ? existingPaymentId : '',
    amount,
    windowMinutes,
  };
}

/** 从 DUPLICATE_PASSENGER 错误的 details 里提取冲突订单号（去重）。非该错误 / 结构异常 → []。 */
export function duplicatePassengerConflictOrderNumbers(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.code !== DUPLICATE_PASSENGER_CODE) return [];
  const details = err.details;
  if (!details || typeof details !== 'object') return [];
  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) return [];
  const orderNumbers = new Set<string>();
  for (const c of conflicts) {
    const nums = (c as { orderNumbers?: unknown }).orderNumbers;
    if (Array.isArray(nums)) {
      for (const n of nums) if (typeof n === 'string') orderNumbers.add(n);
    }
  }
  return [...orderNumbers];
}

type ApiRequestInit = Omit<RequestInit, 'body'> & {
  body?: unknown;
  token?: string | null;
};

// ── Auth 续期桥：让请求层在 401 时静默换新 accessToken 并重试一次 ──────────────
// 由 auth store 注册，避免 api.ts ↔ store 循环依赖。
// 返回新的 accessToken；null = 续期失败（refresh token 失效），调用方放行 401 走登出。
type RefreshAccessTokenFn = () => Promise<string | null>;
let refreshAccessToken: RefreshAccessTokenFn | null = null;
export function registerAuthRefresh(fn: RefreshAccessTokenFn): void {
  refreshAccessToken = fn;
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  return apiFetchWithRetry<T>(path, init, true);
}

async function apiFetchWithRetry<T>(
  path: string,
  init: ApiRequestInit,
  allowRefreshRetry: boolean,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  // access token 过期 → 用 refreshToken 静默换新，带新 token 重试一次（仅一次，避免死循环）。
  // 只对带 token 的请求生效；续期失败（返回 null）则放行原始 401，由上层走登出。
  if (res.status === 401 && init.token && allowRefreshRetry && refreshAccessToken) {
    const newToken = await refreshAccessToken();
    if (newToken && newToken !== init.token) {
      return apiFetchWithRetry<T>(path, { ...init, token: newToken }, false);
    }
  }

  const text = await res.text();
  // 容错解析：错误响应体未必是 JSON（如 nginx 的 413/502/504 是 HTML 错误页）。
  // 直接 JSON.parse 会抛不透明的 SyntaxError，把真实状态码淹没成"未知错误"。
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    const errBody = (parsed as ApiErrorBody | undefined)?.error ?? {
      code: res.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'UNKNOWN',
      message:
        res.status === 413
          ? '提交内容过大（通常是护照照片太大）；请减少出行人数、或移除部分护照照片后重试'
          : res.statusText || `请求失败（HTTP ${res.status}）`,
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
  // 后端权威口径：locked = 锁位占用，available = capacity − sold − locked（与前台一致）。
  locked: number;
  available: number;
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

// ── 跨日期区间班次（GET /flights/schedules?from=&to=）──
// 单次拉取一段日期内所有航班的班次（含每个班次航班号/航线/出发时间），
// 用于座位统计页（取代逐航班 listSchedules 的 N+1）。
export interface RangeScheduleSeat {
  id: string;
  cabin: CabinClass;
  capacity: number;
  sold: number;
  locked: number;
  // available = capacity − sold − locked（后端权威口径）。
  available: number;
  basePrice: string;
}

export interface RangeSchedule {
  id: string;
  flightId: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  /** ISO datetime 字符串 */
  departureTime: string;
  departureTz: string;
  seatClasses: RangeScheduleSeat[];
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
export type BatchProductType = 'FLIGHT_ONEWAY' | 'FLIGHT_ROUNDTRIP' | 'BUNDLE';

export interface BatchOrderPassenger {
  fullName: string;
  documentNumber: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality?: string;
  lastName?: string;
  firstName?: string;
  gender?: 'M' | 'F';
  /** 护照签发国（2 位国家码，如 CN）。OTA 名单「签发国」列解析而来。 */
  passportIssueCountry?: string;
  passportExpiry?: string;
  /** 该乘客个别备注（选填）：与整批备注合并写入该乘客订单。 */
  note?: string;
}
export interface BatchCreateOrdersInput {
  productType?: BatchProductType;
  // FLIGHT_ONEWAY / FLIGHT_ROUNDTRIP
  /** 向后兼容旧字段名；优先用 outboundScheduleId */
  flightScheduleId?: string;
  outboundScheduleId?: string;
  returnScheduleId?: string;
  flightCabin?: CabinClass;
  // BUNDLE
  bundleId?: string;
  bundleNights?: number;
  bundleSingleCount?: number;
  bundleBusinessCount?: number;
  /** 套餐出发日期（YYYY-MM-DD）；缺省回落套餐的 defaultDepartDate */
  bundleDepartDate?: string;
  adultCount?: number;
  childCount?: number;
  infantCount?: number;
  // 公共
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
   * 仅对 FLIGHT 行生效；BUNDLE 走套餐定价逻辑。
   */
  settlementPriceCny?: number;
  /**
   * OTA 线上单手动结算单价（每人 CNY）。仅 ADMIN/STAFF 生效。
   * 与 settlementPriceCny 互斥：不覆盖机票权威价，而是由后端算出系统权威价后追加一条差额调整行，
   * 把订单总额调到该手动结算价（系统价 / 差额可追溯、审计照记）。
   */
  manualUnitPriceCny?: number;
  /** 团期备注（如「2026 春节团 7 日」），写入每单。 */
  groupNote?: string;
  /**
   * 允许重复乘客强录（仅 ADMIN/STAFF 生效）。同班次同证件号本会整批拒（DUPLICATE_PASSENGER），
   * 运营二次确认后带 true 重试。透传给每张子单。
   */
  allowDuplicatePassengers?: boolean;
  /**
   * 批量幂等键（每次提交生成一个 UUID）：整批 HTTP 重试/双击时，后端为每张子单派生稳定幂等键
   * `batch:{batchId}:{index}`，同批重复提交每子单只建一次、不重复占座。
   */
  batchId?: string;
}

/** POST /orders/roster/parse 返回的一行（11 列新模版；字段可缺省，后续手录补全） */
export interface RosterParsedRow {
  /** 中文姓名（列1）或 PNR 全名兜底 */
  name: string;
  fullName?: string;
  lastName?: string;
  firstName?: string;
  passportNo?: string;    // 向后兼容旧字段名（= documentNumber）
  documentNumber?: string;
  dob?: string;           // 向后兼容旧字段名（= dateOfBirth），YYYY-MM-DD
  dateOfBirth?: string;   // YYYY-MM-DD
  gender?: string;        // 'M' | 'F'
  nationality?: string;
  documentType?: string;
  visaIssueDate?: string; // YYYY-MM-DD
  passportExpiry?: string; // YYYY-MM-DD
  infantCompanion?: string;
  remarks?: string;
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
  /** 性别（M/F/X；OCR 识别或手选，镜像后端 passengerInputSchema） */
  gender?: 'M' | 'F' | 'X';
  /** 护照图 data URL（OCR 识别后附带，后端持久化为 Passenger.passportPhotoUrl） */
  passportPhotoUrl?: string;
  /** 中文姓名（可选；OCR 能识别时带出） */
  chineseName?: string;
  /** 护照签发日期 YYYY-MM-DD（可选；OCR 能识别时带出） */
  passportIssueDate?: string;
  /** 护照签发地点（自由文本，城市/机关；可选；OCR 能识别时带出）。区别于 ISO-2 签发国。 */
  passportIssuePlace?: string;
  /** 护照有效期 YYYY-MM-DD（可选；OCR 能识别时带出） */
  passportExpiry?: string;
  /** 签证出签日 YYYY-MM-DD（可选） */
  visaIssueDate?: string;
  /** 签证生效日 YYYY-MM-DD（可选） */
  visaEffectiveDate?: string;
  /** 签证有效期 YYYY-MM-DD（可选） */
  visaExpiry?: string;
  /** 套餐乘客级选项：客人自备签证（无需送签；套餐价按人扣减 selfVisaDeductCny）。缺省 false。 */
  visaExempt?: boolean;
  /** 套餐乘客级选项：单住（不拼房，按人收单房差）。缺省 false = 拼房。 */
  singleRoom?: boolean;
}

interface OrderItemBase {
  description: string;
  quantity: number;
  metadata?: Record<string, unknown>;
}
export type CreateOrderItemInput =
  | (OrderItemBase & { kind: 'FLIGHT'; flightScheduleId: string; flightCabin: CabinClass })
  | (OrderItemBase & {
      kind: 'HOTEL';
      hotelRoomTypeId?: string;
      checkIn?: string;
      checkOut?: string;
      unitPrice: number;
      /** 计费间数（0.5 步进；分房半间用）；缺省 = 按数量/晚数推算 */
      roomsBilled?: number;
    })
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
      /** 客人自备签证：勾选后服务端扣减 selfVisaDeductCny */
      selfProvidedVisa?: boolean;
      /** 计费间数（0.5 步进；分房半间用）；缺省 = 按人数推算 */
      roomsBilled?: number;
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

// 录单调价/加项（仅 ADMIN/STAFF 录单）：在系统权威价上手工加减一笔金额 + 原因。
// 金额（CNY 整数）可正（加钱：补收杂费/变更改期费…）可负（减价/优惠）；服务端按认证身份判权限。
//
// 原因收窄为纯财务类：升舱/升级酒店/签证改多签曾在下拉里，但会造成运营隐形——升舱不占
// 套餐结构化商务舱库存、升级酒店不走「换酒店」（房控看不到）、改多签不换签证产品（签证岗
// 看不到）。新录入只允许下面四个财务口径值；旧三值仍保留在展示 label 映射里，避免历史订单行
// 的 reasonCode 找不到 label 而显示 undefined。
export type PriceAdjustmentReason = 'DISCOUNT' | 'MISC_FEE' | 'CHANGE' | 'OTHER';

// 可录入原因（下拉用）——与后端 priceAdjustmentSchema 的枚举保持一致。
export const PRICE_ADJUSTMENT_REASON_OPTIONS: PriceAdjustmentReason[] = [
  'DISCOUNT',
  'MISC_FEE',
  'CHANGE',
  'OTHER',
];

// 历史全集（含已下线、不再允许新录入的原因值）——仅用于展示旧订单行 label。
type PriceAdjustmentReasonLegacy = 'UPGRADE_CABIN' | 'UPGRADE_HOTEL' | 'VISA_MULTI';
// 专用端点产生、不在录单可选枚举里的原因（仅展示 label）。ROOM_DIFF 走订单详情「补收单房差」
// 专用通道（POST /orders/:id/room-supplement），不进录单调价下拉（PRICE_ADJUSTMENT_REASON_OPTIONS）。
// SETTLEMENT 由录单「本单结算总价」（settlementTotalCny）触发、服务端自动生成差额行——
// **只能系统生成**，同样不进人工调价下拉。
type PriceAdjustmentReasonEndpointOnly = 'ROOM_DIFF' | 'SETTLEMENT';
type PriceAdjustmentReasonDisplay =
  | PriceAdjustmentReason
  | PriceAdjustmentReasonLegacy
  | PriceAdjustmentReasonEndpointOnly;

export const PRICE_ADJUSTMENT_REASON_LABEL: Record<PriceAdjustmentReasonDisplay, string> = {
  DISCOUNT: '优惠',
  MISC_FEE: '补收杂费',
  CHANGE: '变更改期费',
  OTHER: '其它',
  UPGRADE_CABIN: '升舱',
  UPGRADE_HOTEL: '升级酒店',
  VISA_MULTI: '签证改多签',
  ROOM_DIFF: '补收单房差',
  SETTLEMENT: '代理结算价',
};

export interface PriceAdjustmentInput {
  amountCny: number;
  reasonCode: PriceAdjustmentReason;
  reasonText?: string;
}

// 录单前试算（系统价）。items 与 createOrder 同结构。
export interface QuoteOrderResult {
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
}

export interface CreateOrderInput extends OrderStructuredNotes {
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  paymentMethod?: PaymentMethod;
  items: CreateOrderItemInput[];
  passengers: OrderPassengerInput[];
  notes?: string;
  idempotencyKey?: string;
  /** 录单调价/加项（ADMIN/STAFF 录单专用；服务端按认证身份判权限） */
  priceAdjustment?: PriceAdjustmentInput;
  /**
   * 本单结算总价（CNY，≥0，最多两位小数；ADMIN/STAFF 录单专用，服务端按认证身份判权限）。
   * 代理单一口价场景：系统照此收钱——服务端按「结算价 − 权威合计」自动生成一条
   * reasonCode=SETTLEMENT 的差额调价行（不改任何明细行价格，原价/差额留痕可审计）。
   * 与 priceAdjustment 互斥（同时传服务端 400）。
   */
  settlementTotalCny?: number;
  /**
   * 代为某代理录单（ADMIN/STAFF 用）。直客/无代理 = 不传。
   * 注：服务端创单接口对 agentId 的归属支持为后端配套改动；本字段为前向兼容透传，
   * 服务端未启用时会被静默忽略（不报错）。
   */
  agentId?: string;
  /**
   * 允许重复乘客强录（仅 ADMIN/STAFF 生效）。客人重复订票且已付款场景：同班次同证件号本会
   * 被拦（错误 code=DUPLICATE_PASSENGER），运营二次确认后带 true 重试。服务端按认证身份判权限。
   */
  allowDuplicatePassengers?: boolean;
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

// ── 名单格式绑定（批量创单防呆）── 与 backend agents.schemas ROSTER_FORMATS 对齐
export type RosterFormat = 'COLON_MULTILINE_YMD' | 'INLINE_NUMBERED' | 'COLON_MULTILINE_DMY';

export const ROSTER_FORMAT_LABEL: Record<RosterFormat, string> = {
  COLON_MULTILINE_YMD: '冒号多行（年-月-日）',
  INLINE_NUMBERED: '编号单行',
  COLON_MULTILINE_DMY: '冒号多行（日-月-年）',
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
  /** 名单格式绑定：该代理惯用的粘贴名单格式；null = 未登记 */
  rosterFormat: RosterFormat | null;
  /** 识别词条（全局唯一，一词只归一家） */
  rosterKeywords: string[];
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
  // 不含 prepaymentBalance：建代理余额恒为 0，事后走认款通道（有流水+审计）产生。
  notes?: string;
  /** 名单格式绑定（可选） */
  rosterFormat?: RosterFormat | null;
  /** 识别词条（每条 ≤20 字，最多 10 条；服务端全局查重） */
  rosterKeywords?: string[];
}

/** PATCH /agents/:id 请求体：所有字段可选，至少传一个 */
export interface UpdateAgentInput {
  companyName?: string;
  contactName?: string;
  contactPhone?: string;
  email?: string;
  notes?: string;
  /** 名单格式绑定；null = 清除登记 */
  rosterFormat?: RosterFormat | null;
  /** 识别词条（每条 ≤20 字，最多 10 条；服务端全局查重） */
  rosterKeywords?: string[];
}

// ── 切位（包位）── 与 backend seat-allocation 模块对齐
export type SeatAllocationStatus = 'ACTIVE' | 'RECLAIMED';

export interface CreateSeatAllocationInput {
  flightScheduleId: string;
  cabin: CabinClass;
  agentId: string;
  /** 切给代理的座位数（≥1，绝不超过散客池余量） */
  seats: number;
  /** 约定单价（每人 CNY，整数）；null / 省略 = 按常规售价 */
  unitPriceCny?: number | null;
  /** 出发前多少天回收未售部分（默认 7；0..365） */
  reclaimDaysBefore?: number;
  notes?: string | null;
}

// 创建后端返回的原始切位记录（POST 响应）
export interface SeatAllocationRecord {
  id: string;
  flightScheduleId: string;
  cabin: CabinClass;
  agentId: string;
  seats: number;
  unitPriceCny: number | null;
  reclaimDaysBefore: number;
  status: SeatAllocationStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// 列表项（GET 响应）—— 含代理与班次冗余字段，供 UI 直接渲染
export interface SeatAllocationListItem {
  id: string;
  flightScheduleId: string;
  cabin: CabinClass;
  agentId: string;
  agent: { id: string; companyName: string | null; contactName: string; tier: number };
  seats: number;
  unitPriceCny: number | null;
  reclaimDaysBefore: number;
  status: SeatAllocationStatus;
  notes: string | null;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  departureTime: string;
  departureTz: string;
  /** 是否已过回收截止（仅 ACTIVE 有意义）；供 UI 高亮「可回收」 */
  expired: boolean;
  createdAt: string;
  updatedAt: string;
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

/** 收款方式中文标签（订单收款 / 进账对账共用） */
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  WECHAT_PAY: '微信',
  ALIPAY: '支付宝',
  BANK_CARD: '银行转账',
  AGENT_PREPAYMENT: '代理预付',
};

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
  /** 该行所属套餐 id（BUNDLE 行本身 + 其关联的 FLIGHT 腿都会带同一个 bundleId）；非套餐订单为 null */
  bundleId?: string | null;
  /** 计费房间数（支持 0.5 间拼房）；未联查/未盖章为 null */
  roomsBilled?: number | null;
  /** 按乘客调价（0722）：非空 = 本 priceAdjustment 差额行只作用于该乘客；NULL = 整单调价。 */
  passengerId?: string | null;
  metadata: unknown;
  createdAt: string;
  // 列表带出的履约任务（仅 type+status），用于派生「签证状态」「出票状态」
  fulfillmentTasks?: Array<{ type: string; status: FulfillmentStatus }>;

  // ── 行程单渲染字段（ADDITIVE；getOrder 联查后附加，未联查对应关系时为 null）──
  /** FLIGHT 行：航班号 */
  flightNumber?: string | null;
  /** FLIGHT 行：出发日期（YYYY-MM-DD） */
  departureDate?: string | null;
  /** FLIGHT 行：出发时间（HH:MM） */
  departureTime?: string | null;
  /** FLIGHT 行：到达时间（HH:MM） */
  arrivalTime?: string | null;
  /** FLIGHT 行：航线，如「MFM→DAD」 */
  route?: string | null;
  /** FLIGHT 行：舱位（与 flightCabin 同值，行程单展示用别名） */
  cabin?: CabinClass | null;
  /** HOTEL 行 / BUNDLE 行盖章酒店：房型名（区别于 hotelName 酒店名） */
  roomTypeName?: string | null;
  /** HOTEL 行 / BUNDLE 行盖章酒店：酒店中文名 */
  hotelName?: string | null;
  /** VISA 行（独立提交时）：签证名称 */
  visaName?: string | null;
  /** VISA 行：签证目的国 */
  visaCountry?: string | null;
  /** VISA 行：单次入境最多可停留天数 */
  visaStayDays?: number | null;
  /** TRANSFER 行（独立提交时）：接送产品名称 */
  transferProductName?: string | null;
  /** BUNDLE 行：套餐名 */
  bundleName?: string | null;
  /** BUNDLE 行：服务内容（每行一条，运营在套餐向导里填） */
  serviceNotes?: string | null;

  // ── 产品内容卡片 v2：套餐组件构成（来自套餐定义 bundle.items，非订单行；ADDITIVE）──
  // 套餐订单通常只有机票腿 + 一条 BUNDLE 地面行，没有独立的 VISA/TRANSFER 行——
  // 签证/接送信息要从套餐定义本身取，而不是（不存在的）订单行。
  /** BUNDLE 行：该套餐 items 里实际存在哪些组件类型；未联查/非 BUNDLE 行为 null */
  bundleKinds?: Array<'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA'> | null;
  /** BUNDLE 行：套餐定义里的接送组件列表（可能多条）；未联查/无接送组件为 null 或空数组 */
  bundleTransfers?: Array<{ name: string; qty: number }> | null;
  /** BUNDLE 行：套餐定义里的签证组件（第一条）；stayDays 由服务端按 visaId 查好；无签证组件为 null */
  bundleVisa?: { name: string; visaId: string; stayDays: number | null } | null;
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
  // 换人未提供新生日时后端置 null（见 Passenger.dateOfBirth 可空）；展示处用 ?? '—'
  dateOfBirth?: string | null;
  placeOfBirth?: string | null;
  nationality?: string;
  passengerType?: PassengerType;

  // 护照扩展
  /** 中文姓名（OCR 识别或手工填写） */
  chineseName?: string | null;
  passportIssueCountry?: string | null;
  /** 护照签发地点（自由文本，城市/机关；区别于 ISO-2 签发国） */
  passportIssuePlace?: string | null;
  passportExpiry?: string | null;

  // 签证（出签日/生效日/有效期由签证台在出签后补录，见 updatePassengerVisaDates）
  visaNumber?: string | null;
  visaType?: string | null;
  visaIssueDate?: string | null;
  visaEffectiveDate?: string | null;
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

  // 套餐乘客级选项（详情展示 badge 用；serializeOrder 全量 spread 标量自动带出）
  /** 客人自备签证（无需送签） */
  visaExempt?: boolean | null;
  /** 单住（不拼房，按人收单房差） */
  singleRoom?: boolean | null;
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
  /** 自动生成规则键（BALANCE_DUE / DEPARTURE_SOON / …）；null/缺失 = 手动创建 */
  ruleKey?: string | null;
}

// ── 经营报表（ADMIN-only）────────────────────────────────────────────────
export type SalesReportDim = 'kind' | 'channel' | 'agent';

export interface SalesReportRow {
  key: string;
  label: string;
  orderCount: number;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  /** 小数分数（0.3456 = 34.56%） */
  marginPct: number;
  missingCostItemCount: number;
}

export interface SalesReport {
  rows: SalesReportRow[];
  totals: SalesReportRow;
}

export type ReceivablesBucket = '0-7' | '8-30' | '31-60' | '61+';

export interface ReceivableRow {
  orderId: string;
  orderNumber: string;
  contactName: string;
  agentLabel: string;
  status: OrderStatus;
  totalCny: number;
  paidCny: number;
  balanceCny: number;
  ageDays: number;
  bucket: ReceivablesBucket;
}

export interface ReceivablesReport {
  rows: ReceivableRow[];
  summary: {
    totalBalanceCny: number;
    buckets: Record<ReceivablesBucket, { count: number; amountCny: number }>;
    /** rows 超过上限（500）被截断；汇总仍为全量 */
    truncated?: boolean;
  };
}

export interface AgentDebtRow {
  agentId: string;
  agentLabel: string;
  orderCount: number;
  outstandingCny: number;
  prepaymentBalanceCny: number;
}

export interface AgentDebtsReport {
  rows: AgentDebtRow[];
}

export interface RoomGroup {
  id: string;
  hotelName: string;
  roomType: string;
  passengerIds: string[];
  notes?: string;
  /** 占房间数：整间=1（缺省），拼房半间=0.5。例：7人3.5间。 */
  roomFraction?: number;
}

export interface RoomAssignment {
  roomGroups: RoomGroup[];
}

// ── 酒店房量档位（公开端点只回档位不回原始数字，与六档余位同纪律）──────────
export type HotelAvailabilityTier = 'AMPLE' | 'TIGHT' | 'LOW' | 'SOLD_OUT';

export interface HotelAvailabilityResult {
  /** null = 该时段未配置包房（不展示房量，也不拦截销售） */
  tier: HotelAvailabilityTier | null;
  nights: number;
}

export type InvoiceStatus = 'NONE' | 'REQUESTED' | 'ISSUED';

/** 六态开票的维度：去程 / 回程 / 系统。 */
export type InvoiceLeg = 'outbound' | 'return' | 'system';

/**
 * 售后费用流水（改期费 / 换人费 / 换酒店差价）。
 * 对应后端 orders.service.ts 的 OrderAdjustmentEntry（Order.adjustments JSON 列，
 * serializeOrder 原样透传，不做 Decimal 字符串化）：amountCny 是原始 number，
 * 日期字段是 at（ISO），没有 id / createdAt。
 */
export interface OrderAdjustment {
  type: 'RESCHEDULE_FEE' | 'SWAP_FEE' | string;
  label: string;
  amountCny: number;
  at: string; // ISO 时间
  by: string | null; // 操作人 userId
  note?: string;
}

/** 回收站行（GET /orders/deleted）：只带回收站表所需的最小字段。 */
export interface DeletedOrderSummary {
  id: string;
  orderNumber: string;
  customerName: string;
  total: string;
  currency: string;
  status: OrderStatus;
  deletedAt: string | null;
  /** 删除人（来自审计，可能缺失 → null） */
  deletedBy: string | null;
  /** 乘客姓名（中文名优先，缺失回退证件姓名） */
  passengerNames: string[];
  /** 出发日期 YYYY-MM-DD（去程航班，回退酒店入住日；均无 → null） */
  departDate: string | null;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  userId: string;
  agentId: string | null;
  status: OrderStatus;
  /**
   * 本单当前状态下的**合法流转**（状态机真源，由后端 serializeOrder 逐单下发）。
   * 前端**不要**再手抄一份状态机——抄的那份漂移过，把后端合法的流转当成「需管理员强制」，
   * 逼运营走 force 通道，正常操作被记成 FORCE_ORDER_STATUS + WARNING 审计，淹没真正的强制。
   * 旧后端/窄接口未下发时为 undefined，消费方按空集处理（宁可少给按钮，不可谎报合法）。
   */
  allowedTransitions?: OrderStatus[];
  invoiceStatus?: InvoiceStatus;
  // 六态开票（三个独立维度）：去程已开 / 回程已开 / 系统已开。缺省视为 false（未开）。
  outboundInvoiced?: boolean;
  returnInvoiced?: boolean;
  systemInvoiced?: boolean;
  currency: string;
  subtotal: string;
  total: string;
  paidAmount: string;
  /** 售后费用合计（改期费 + 换人费）；尾款 = total + adjustmentCny − paidAmount。后端未启用时缺省 */
  adjustmentCny?: number;
  /** 售后费用明细（改期费 / 换人费）；列表可能为空，详情带出 */
  adjustments?: OrderAdjustment[];
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  createdAt: string;
  updatedAt: string;
  // 出发日期（YYYY-MM-DD）：FLIGHT 最早班次当地出发日 → 回退最早酒店入住日 → null（列表列用）
  departDate?: string | null;
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
  settlementLocked?: boolean;

  // 出行人数（按 Passenger.passengerType 统计；套餐订单详情行程单「人数」板块用）
  adultCount?: number;
  childCount?: number;
  infantCount?: number;

  // 套餐订单按人头单价（由 order.total 反推，非套餐订单/查不到套餐定价配置时为 null；
  // 「产品内容」卡片 v2「人数」板块用；口径见 backend deriveBundlePerAgeUnitPrices）
  adultUnitPriceCny?: number | null;
  childUnitPriceCny?: number | null;
  infantUnitPriceCny?: number | null;
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
  /**
   * 六态开票筛选（组合式）：invoiceLeg = 维度（去程/回程/系统），invoiced = 已开/未开。
   * 二者需同时给出才生效。票务岗「出行日期=7/10 + 去程未开 → 导出」即 invoiceLeg=outbound & invoiced=false。
   */
  invoiceLeg?: InvoiceLeg;
  invoiced?: boolean;
  /**
   * 签证办理状态 — 与列表「签证」列徽标同源（VISA 行 VISA_APPLICATION 履约任务状态）。
   * signed=已签证（任务已确认）；unsigned=未签证（含 VISA 行但任务未确认）。无 VISA 行订单两者都不命中。
   */
  visaFulfillmentStatus?: 'signed' | 'unsigned';
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
  /** 精确按班次导出（整班·全岗用）；比 travelFrom/travelTo 精确，只导该班次订单。 */
  scheduleId?: string;
  flightNumber?: string;
  passengerName?: string;
  invoiceStatus?: InvoiceStatus;
  /** 六态开票筛选（组合式）；与 listOrders 同款，用于「筛选后导出」。 */
  invoiceLeg?: InvoiceLeg;
  invoiced?: boolean;
  /** 签证办理状态（signed/unsigned）；与 listOrders 同款，用于「筛选后导出」。 */
  visaFulfillmentStatus?: 'signed' | 'unsigned';
  /** 勾选导出：给了就只导这批订单（后端以 id 集合为准，忽略其余筛选）。 */
  orderIds?: string[];
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

// ── 旅客档案（TravelerProfile：按证件号聚合全量订单乘机人的常旅客画像）──

export interface TravelerProfileHotelStay {
  hotelName: string;
  roomType: string | null;
  checkIn: string | null; // YYYY-MM-DD
  checkOut: string | null;
  orderNumber: string;
}

export interface TravelerProfileCompanion {
  documentType: DocumentType;
  documentNumber: string;
  fullName: string;
  tripsTogether: number;
}

export interface TravelerProfile {
  id: string;
  /** 常旅客号（服务端已格式化，如 "CT-000123"） */
  travelerNo: string;
  /** 已并入的主档案 id；null = 正常档案。列表接口只返回未被合并的档案。 */
  mergedIntoId: string | null;
  documentType: DocumentType;
  documentNumber: string;
  fullName: string;
  chineseName: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  passportExpiry: string | null;
  tripCount: number;
  orderCount: number;
  firstTripAt: string | null;
  lastTripAt: string | null;
  nextTripAt: string | null;
  totalSpendCny: string; // 人均平摊口径，两位小数字符串
  prefCabin: string | null;
  prefBed: string | null;
  prefMeal: string | null;
  prefSingleRoom: boolean;
  needsWheelchair: boolean;
  hotelHistory: TravelerProfileHotelStay[];
  companions: TravelerProfileCompanion[];
  linkedUserId: string | null;
  notes: string | null;
  refreshedAt: string;
}

export interface TravelerProfileTrip {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  departAt: string | null;
  returnAt: string | null;
  route: string | null; // "MFM→DAD"
  flightNumbers: string[];
  cabin: string | null;
  hotels: TravelerProfileHotelStay[];
  paxCount: number;
  spendShareCny: number;
  flown: boolean;
}

export interface ListTravelerProfilesResult {
  profiles: TravelerProfile[];
  pagination: { page: number; pageSize: number; total: number };
  meta: { totalProfiles: number; totalTrips: number; refreshedAt: string | null };
}

/** 录单联想候选可整行回填的乘机人字段（后端提炼自最近一次乘机记录；整体可能为 null）。日期均为 ISO 字符串。 */
export interface TravelerProfileFillFields {
  lastName: string | null;
  firstName: string | null;
  title: string | null;
  gender: string | null; // 后端枚举，如 MALE / FEMALE
  chineseName: string | null;
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  nationality: string | null;
  documentType: DocumentType | null;
  documentNumber: string | null;
  passportIssueDate: string | null;
  passportIssueCountry: string | null;
  passportIssuePlace: string | null;
  passportExpiry: string | null;
  mealPreference: string | null;
  bedPref: string | null;
  needsWheelchair: boolean | null;
  needsInfantBassinet: boolean | null;
  passengerType: PassengerType | null;
}

/** 录单联想候选（GET /travelers/profiles/suggest；ADMIN/STAFF） */
export interface TravelerProfileSuggestion {
  id: string;
  travelerNo: string;
  fullName: string;
  chineseName: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  documentType: DocumentType;
  documentNumber: string;
  passportExpiry: string | null;
  tripCount: number;
  lastTripAt: string | null;
  prefCabin: string | null;
  prefBed: string | null;
  prefMeal: string | null;
  prefSingleRoom: boolean;
  needsWheelchair: boolean;
  fillFields: TravelerProfileFillFields | null;
}

/** 合并档案返回：profile/trips = 合并后实时重算的主档案；merged = 被并入的旧档案摘要 */
export interface MergeTravelerProfileResult {
  profile: TravelerProfile;
  trips: TravelerProfileTrip[];
  merged: {
    id: string;
    travelerNo: string;
    documentType: DocumentType;
    documentNumber: string;
    fullName: string;
  };
}

export type FulfillmentType = 'FLIGHT_TICKETING' | 'HOTEL_BOOKING' | 'VISA_APPLICATION' | 'TRANSFER_DISPATCH' | 'BUNDLE_COMPOSITE';
export type FulfillmentStatus = 'PENDING' | 'IN_PROGRESS' | 'CONFIRMED' | 'CANCELLED' | 'FAILED';

/** 乘客送签进度（按人送签用）——三档，与签证台任务状态语义对齐 */
export type VisaSubmissionStatus = 'PENDING' | 'IN_PROGRESS' | 'CONFIRMED';

/** 签证台乘客明细（仅 VISA_APPLICATION 任务后端附带）*/
export interface VisaTaskPassenger {
  id: string;
  fullName: string;
  documentNumber: string;
  /** 护照姓（LAST）；用于签证台按 姓/名 格式展示，缺失回退 fullName */
  lastName?: string | null;
  /** 护照名（FIRST） */
  firstName?: string | null;
  /** 中文名；护照拉丁名旁并列显示便于核对 */
  chineseName?: string | null;
  /** 性别 M/F/X；签证台展示性别徽标 */
  gender?: string | null;
  /** 护照图 URL；null = 未上传 */
  passportPhotoUrl: string | null;
  /** passportPhotoUrl 非空 → true；缺照时签证台标红用 */
  hasPhoto: boolean;
  /** 护照有效期（YYYY-MM-DD）；null = 未录入。签证台平铺展示 + 临期<6月标黄 */
  passportExpiry?: string | null;
  /** 按人送签进度；缺省（旧后端）视为 PENDING */
  visaSubmissionStatus?: VisaSubmissionStatus;
}

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
  order?: {
    id: string;
    orderNumber: string;
    contactName: string;
    contactPhone: string;
    status: OrderStatus;
    notes?: string | null;
    /** 出发时间（ISO）；纯签证单无航班 → null */
    departureTime?: string | null;
    /** 出发机场时区（IANA）；用于本地化出发日期 */
    departureTz?: string | null;
  };
  /** 签证产品名（含"…单次"/"…多次"）；非签证任务或缺失 → null */
  visaName?: string | null;
  /** 签证产品签发方式（结构化分类）；非签证任务/未设置/缺失 → null */
  visaIssuanceMethod?: VisaIssuanceMethod | null;
  /** 签证产品入境次数（结构化分类）；非签证任务/未设置/缺失 → null */
  visaEntryType?: VisaEntryType | null;
  /** 签发方式分类出处：PRODUCT=产品结构化标注 / ORDER_STATUS=录单回退；缺省=按 PRODUCT 处理 */
  visaIssuanceSource?: 'PRODUCT' | 'ORDER_STATUS' | null;
  /** 入境次数分类出处（同上）；入境次数无回退来源，有值即 PRODUCT */
  visaEntrySource?: 'PRODUCT' | 'ORDER_STATUS' | null;
  /** 仅 type=VISA_APPLICATION 时后端附带，其余任务类型无此字段 */
  passengers?: VisaTaskPassenger[];
  /** 签证人均成本·美金单价（仅签证任务；未设置=null）。签证公司按航班开美金账单 */
  visaUnitCostUsd?: number | null;
  /** 签证人均成本·折算汇率（USD→CNY；未设置=null） */
  visaFxRate?: number | null;
  /** 签证人均成本·人民币（入账权威；未设置=null → 财务回退产品主数据成本） */
  visaUnitCostCny?: number | null;
}

/** 设置/清空签证任务人均成本的入参（三字段独立可空；全 null=清空回退产品成本） */
export interface VisaTaskCostInput {
  visaUnitCostUsd?: number | null;
  visaFxRate?: number | null;
  visaUnitCostCny?: number | null;
}

/** GET /fulfillment-tasks 列表查询（与 backend listFulfillmentQuerySchema 对齐） */
export interface ListFulfillmentParams {
  orderId?: string;
  orderItemId?: string;
  type?: FulfillmentType;
  /** 单状态或逗号分隔多状态（后端 status:{in:[...]} 表达「待办」等）；省略=全部状态 */
  status?: FulfillmentStatus | string;
  assigneeUserId?: string;
  /** 备注文本筛选（不区分大小写子串匹配）；省略/空串 = 不筛 */
  notesQuery?: string;
  /** 签发方式筛选（签证台「签证类型」）；'NONE'=未标注 */
  issuanceMethod?: VisaIssuanceMethod | 'NONE';
  /** 出发日期单日筛选（YYYY-MM-DD，向后兼容；新前端用区间 from/to） */
  departureDate?: string;
  /** 出发日期区间起（YYYY-MM-DD，含） */
  departureDateFrom?: string;
  /** 出发日期区间止（YYYY-MM-DD，含） */
  departureDateTo?: string;
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
  /** D3 真实评价聚合（来自 Review 表，非旧手填 Decimal）；恒为对象，无评价时 {average:0,count:0} */
  rating: { average: number; count: number };
  /** 旧手填 Decimal 评分兜底字段（serializeHotel 里改名保留）；本页未使用它做展示 */
  ratingLegacy?: string | null;
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

/** 签证签发方式（结构化分类，替代靠产品名正则猜测） */
export type VisaIssuanceMethod = 'E_VISA' | 'STICKER' | 'ARRIVAL' | 'OTHER';
/** 签证入境次数 */
export type VisaEntryType = 'SINGLE' | 'MULTIPLE';

export interface Visa {
  id: string;
  /** 产品编号（服务端生成，如 V0001）；老数据可能为 null */
  code: string | null;
  destinationCountry: string;
  country: string | null;
  visaType: string;
  visaName: string | null;
  /** 签发方式（电子签/贴纸签/落地签/其他）；未设置（含旧数据未回填命中）= null */
  issuanceMethod: VisaIssuanceMethod | null;
  /** 入境次数（单次/多次）；未设置 = null */
  entryType: VisaEntryType | null;
  flag: string | null;
  processingDays: number;
  basePrice: string;
  expressSurcharge: string | null;
  validityMonths: number | null;
  /** 单次入境最多可停留天数（订单详情行程单「最多可停留 X 天」展示 + 推算生效/失效日期用）；未设置为 null */
  stayDays: number | null;
  highlight: string | null;
  requiredDocs: string[];
  isActive: boolean;
  costPriceCny: string | null;
  /** 签证公司/代办渠道名（财务对账用——核对某笔签证金额属于哪家供应商的账单）；未录为 null */
  supplier: string | null;
  createdAt: string;
}

export interface BundleItemData {
  kind: 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA';
  productName: string;
  qty: number;
  /** 服务端权威定价（HOTEL 已关联房型 / TRANSFER / VISA 均为产品价，只读展示；FLIGHT 恒为 0） */
  unitPrice: number;
  /** TRANSFER 组件关联的接送产品 id（服务端据此取 Transfer.basePrice 权威定价）；TRANSFER 行必填 */
  transferId?: string | null;
  /** VISA 组件关联的签证产品 id（服务端据此取 Visa.basePrice 权威定价）；VISA 行必填 */
  visaId?: string | null;
}

/** 套餐不可售日期（按出发日）；reason ≤60 字，最多 120 条 */
export interface BundleBlackoutDate {
  date: string; // YYYY-MM-DD
  reason?: string;
}

/** 套餐绑定的航班号引用（serializeBundle 联表返回）；按航班号绑定，买家选出发日后系统再匹配当天班次 */
export interface BundleFlightRef {
  id: string;
  flightNumber: string;
  originCode: string;
  destinationCode: string;
}

/**
 * `/products/bundles/flight-ref` 响应：给定去/回程航班绑定下，当前最低来回经济舱机票 / 人（CNY）。
 * null = 该绑定下查不到任何可估班次（起价里的机票项按 0 计）。后台套餐表单据此按「本套餐自己的绑定」
 * 实时取机票基数，反推想卖价↔折扣%，与套餐卡片起价同源。
 */
export interface BundleFlightRefPrice {
  flightRefRoundTripCny: number | null;
}

/**
 * 套餐写入体（create / update 共用；update 时字段可省略 = 不改）。
 * outboundFlightId / returnFlightId：航班号绑定 —— string=绑该 Flight.id，null=解绑（不指定）。
 */
export interface BundleWriteBody {
  name?: string;
  tagline?: string | null;
  /** 服务内容（订单详情行程单「服务内容」板块；每行一条，选填） */
  serviceNotes?: string | null;
  emoji?: string | null;
  items?: BundleItemData[];
  flightPax?: number;
  discountPct?: number;
  groundDiscount?: number;
  suitableFor?: string | null;
  hotelRoomTypeId?: string | null;
  hotelNights?: number | null;
  singleSupplementCnyPerNight?: number | null;
  businessUpgradeCnyPerLeg?: number | null;
  childSeatDiscountCnyPerPerson?: number | null;
  selfVisaDeductCny?: number | null;
  infantPriceCny?: number | null;
  /** 每人操作费（¥/人，整数，计入起价 + 下单按占座人头收）；null/省略 = 不改（DB 默认 ¥20） */
  operationFeeCny?: number | null;
  legs?: number | null;
  blackoutDates?: BundleBlackoutDate[];
  defaultDepartDate?: string | null;
  /** 绑定去程航班号：Flight.id 绑定；null 解绑；省略 = 不改 */
  outboundFlightId?: string | null;
  /** 绑定回程航班号：Flight.id 绑定；null 解绑；省略 = 不改 */
  returnFlightId?: string | null;
  /** 管理端可编辑排序值：数字小的排前面（列表 + 录单套餐下拉同口径）；留空排最后；省略 = 不改 */
  sortOrder?: number | null;
  isActive?: boolean;
}

export interface Bundle {
  id: string;
  /** 产品编号（服务端生成，如 B0001）；老数据可能为 null */
  code: string | null;
  name: string;
  tagline: string | null;
  /** 服务内容（订单详情行程单「服务内容」板块；每行一条，运营在向导里填；未设置为 null） */
  serviceNotes: string | null;
  emoji: string | null;
  photo: string | null;
  items: BundleItemData[];
  flightPax: number;
  /** 套餐折扣（百分比 0–100）：整个全包价 ×(1 − discountPct/100)。套餐唯一折扣口径。 */
  discountPct: number;
  /** 原价（含当前最低来回机票，CNY，整包/flightPax 均分口径）；admin-web 用它反推展示用机票价。估算锚点。 */
  originalAllInCny: number;
  /**
   * 起价 / 人（CNY）—— 唯一权威口径，1 人 · 半间房拼房：
   * = 来回机票/人 + 0.5×酒店房型整间夜价×晚数 + 接送合计 + 签证/人。
   * 后台「想卖的价格」↔折扣% 换算 + 套餐卡「¥X 起/人」展示均用此字段（与 originalAllInCny 是独立口径，互不派生）。
   */
  originalPerPaxCny: number;
  /** [已弃用] 旧固定 CNY 让利，被 discountPct 取代 */
  groundDiscount: string;
  suitableFor: string | null;
  /** 关联酒店房型 ID（房控板计入套餐占房）；null = 不关联 */
  hotelRoomTypeId: string | null;
  /** 关联房型晚数（1–30）；null = 不关联 */
  hotelNights: number | null;
  /** 展示用：服务端联表返回的房型名 + 酒店名 + 整间夜价；null = 不关联 */
  hotelRoomType: {
    id: string;
    name: string;
    hotelName: string;
    /** 房型整间夜价（¥/晚，服务端权威取价源，非半价）；起价里的 0.5 折算只在 originalPerPaxCny 内部生效 */
    nightlyPriceCny?: number;
  } | null;
  /** 绑定的去程航班号（按航班号绑定，不绑某一天班次）；null = 不指定，按最便宜航班 */
  outboundFlight: BundleFlightRef | null;
  /** 绑定的回程航班号；null = 不指定，按最便宜航班 */
  returnFlight: BundleFlightRef | null;
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
  /** 客人自备签证可扣减金额（CNY/单，整数，每张套餐减一次）；>0 时录单/前台显示"自备签证"勾选 */
  selfVisaDeductCny: number;
  /** 每人操作费（CNY/人，整数，DB 默认 ¥20）：计入起价/人，下单按占座人头收（卖价侧，非财务成本口径） */
  operationFeeCny: number;
  /** 按出发日的不可售日期（单套餐粒度）；缺省/空 = 不限制 */
  blackoutDates?: BundleBlackoutDate[];
  /** 前台默认出发日（不影响可售判定）；null = 无默认 */
  defaultDepartDate?: string | null;
  /** 管理端可编辑排序值：数字小的排前面（列表 + 录单套餐下拉同口径）；null = 排最后 */
  sortOrder: number | null;
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

/** GET /hotel-control/recent-changes — 近期用房变更（读审计流：调整分房/换酒店/补房差） */
export interface HotelRoomChangeEntry {
  id: string;
  action: string;
  actionLabel: string; // 人类可读中文
  orderId: string | null;
  orderNumber: string | null;
  actor: string | null; // 操作人
  summary: string; // 变更摘要（房数/酒店等关键字段）
  severity: string;
  at: string; // ISO8601
}
export interface HotelRecentRoomChanges {
  days: number;
  count: number;
  changes: HotelRoomChangeEntry[];
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

// ── 收款渠道 / 进账对账（收款对账台）─────────────────────────────────────
// 与 backend payment-channels + receipts 模块对齐（serializePaymentChannel / serializeReceipt）。

/** 收款渠道分组（仅在 PaymentChannel 上；Receipt 用 PaymentMethod） */
export type PaymentChannelKind = 'WECHAT' | 'ALIPAY' | 'BANK';

export const PAYMENT_CHANNEL_KIND_LABEL: Record<PaymentChannelKind, string> = {
  WECHAT: '微信',
  ALIPAY: '支付宝',
  BANK: '银行',
};

/** 收款渠道（admin GET/POST/PATCH 完整形态） */
export interface PaymentChannel {
  id: string;
  kind: string; // 'WECHAT' | 'ALIPAY' | 'BANK'（后端为 String，zod 校验枚举）
  label: string;
  qrImageUrl: string | null;
  accountText: string | null;
  note: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /payment-channels body（qrImageUrl 为 data:image/...;base64，≤6MB） */
export interface CreatePaymentChannelInput {
  kind: PaymentChannelKind;
  label: string;
  qrImageUrl?: string;
  accountText?: string;
  note?: string;
  isActive?: boolean;
  sortOrder?: number;
}

/** PATCH /payment-channels/:id body（任意子集，≥1 字段；可空字段传 null 清除） */
export interface UpdatePaymentChannelInput {
  kind?: PaymentChannelKind;
  label?: string;
  qrImageUrl?: string | null;
  accountText?: string | null;
  note?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

/** 进账状态：未认领 / 部分认领 / 已认领 / 已退款 */
export type ReceiptStatus = 'OPEN' | 'PARTIALLY_ALLOCATED' | 'ALLOCATED' | 'REFUNDED';
/** 进账来源：客户上传 / 后台录入 / 订单超额转入 / 二维码流水导入 */
export type ReceiptSource = 'CUSTOMER_UPLOAD' | 'STAFF_ENTRY' | 'ORDER_OVERPAY' | 'STATEMENT_IMPORT';

export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  OPEN: '待认领',
  PARTIALLY_ALLOCATED: '部分认领',
  ALLOCATED: '已认领',
  REFUNDED: '已退款',
};
export const RECEIPT_SOURCE_LABEL: Record<ReceiptSource, string> = {
  CUSTOMER_UPLOAD: '客户上传',
  STAFF_ENTRY: '后台录入',
  ORDER_OVERPAY: '订单超额',
  STATEMENT_IMPORT: '流水导入',
};

/** 流水预览行处置：ok=可导入；dup_in_db=库里已有；dup_in_file=文件内重复；skipped_status=非支付成功；invalid=解析失败 */
export type StatementPlatform = 'CMB_QR' | 'YISHOUBAO' | 'XINGYIFU';
export type StatementDisposition =
  | 'ok'
  | 'dup_in_db'
  | 'dup_in_file'
  | 'skipped_status'
  | 'skipped_type'
  | 'invalid';

/** 流水解析预览行（POST /receipts/statement/parse） */
export interface StatementPreviewRow {
  rowNumber: number;
  externalTxnId: string;
  receivedAt: string | null;
  amountCny: number | null;
  method: PaymentMethod;
  rawMethod: string;
  rawStatus: string;
  rawType: string;
  payerNote: string | null;
  disposition: StatementDisposition;
  /**
   * disposition=dup_in_db 时附现库进账号 + 认款状态（重复导入不丢已认状态的证明）；
   * amountMismatch=true 表示同流水号但金额与库中不一致（数据冲突，需人工核）。
   */
  existing: { receiptNo: string; status: ReceiptStatus; amountCny: string; amountMismatch: boolean } | null;
}

export interface StatementPreviewResult {
  rows: StatementPreviewRow[];
  warnings: string[];
  summary: {
    total: number;
    importable: number;
    dupInDb: number;
    dupInFile: number;
    skippedStatus: number;
    skippedType: number;
    invalid: number;
  };
}

/** 流水导入提交行（预览 ok 行原样回传） */
export interface StatementImportRow {
  externalTxnId: string;
  amountCny: number;
  method: PaymentMethod;
  receivedAt: string;
  payerNote?: string;
}

/** 认款工作台待收款订单候选（GET /receipts/match-candidates） */
export interface ReceiptMatchCandidate {
  orderId: string;
  orderNumber: string;
  contactName: string;
  agentName: string | null;
  status: OrderStatus;
  createdAt: string;
  totalPayable: number;
  paidAmount: number;
  balanceDue: number;
  /** 去程出发日期（YYYY-MM-DD；纯签证/酒店单回落入住日，都无则 null） */
  departureDate: string | null;
}

/** 单笔进账的认领分配（嵌在 Receipt.allocations[]；金额为 Decimal→string） */
export interface ReceiptAllocation {
  id: string;
  orderId: string;
  amountCny: string;
  createdById: string | null;
  createdAt: string;
}

/** 进账记录（serializeReceipt；所有金额 Decimal→string，remainingCny 为 toFixed(2)） */
export interface Receipt {
  id: string;
  receiptNo: string;
  amountCny: string;
  allocatedCny: string;
  remainingCny: string;
  method: PaymentMethod;
  proofUrl: string | null;
  payerNote: string | null;
  /** 收单平台交易流水号（流水导入的进账才有；唯一） */
  externalTxnId: string | null;
  orderHintId: string | null;
  receivedAt: string;
  source: ReceiptSource;
  status: ReceiptStatus;
  refundNote: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  allocations: ReceiptAllocation[];
}

/** GET /receipts 查询参数 */
export interface ListReceiptsParams {
  status?: ReceiptStatus;
  /** '1' = 只回未认完的（OPEN + 部分认款）——认款工作台专用 */
  unallocatedOnly?: '1';
  q?: string; // 匹配 receiptNo / payerNote / orderHintId / externalTxnId
  /** 到账日期闭区间（YYYY-MM-DD，按流水交易日期 receivedAt，北京时） */
  from?: string;
  to?: string;
}

/** GET /receipts/match-candidates 查询参数（日期按订单下单日期 createdAt） */
export interface ReceiptMatchCandidatesParams {
  from?: string;
  to?: string;
  /** 匹配 订单号 / 联系人 / 代理名（服务端过滤，跨全量候选） */
  q?: string;
}

/** POST /receipts body（后台登记新进账） */
export interface CreateReceiptInput {
  amountCny: number;
  method: PaymentMethod;
  proofUrl?: string;
  payerNote?: string;
  receivedAt?: string;
  orderHintId?: string;
}

/** 全部流水：进账 + 订单收款合并视图（GET /receipts/ledger） */
export interface LedgerEntry {
  kind: 'RECEIPT' | 'ORDER_PAYMENT';
  id: string;
  ref: string;
  amountCny: string;
  method: string;
  status: string;
  source: string;
  orderNo: string | null;
  at: string;
}

/** POST /receipts/:id/allocate 返回 */
export interface AllocateReceiptResult {
  ok: true;
  receiptId: string;
  receiptNo: string;
  allocatedAmount: number;
  remainingCny: string;
  receiptStatus: ReceiptStatus;
  order: {
    orderId: string;
    orderNumber: string;
    paidAmount: number;
    total: number;
    fullyPaid: boolean;
    status: OrderStatus;
    paymentId: string;
  };
}

/** POST /receipts/allocate-batch 单组入参（金额一对一吻合的建议组） */
export interface AllocateBatchItem {
  receiptId: string;
  orderId: string;
  amountCny: number;
}

/** POST /receipts/allocate-batch 单组结果（逐组独立事务，成败各自返回） */
export type AllocateBatchResultItem =
  | {
      ok: true;
      receiptId: string;
      orderId: string;
      receiptNo: string;
      orderNumber: string;
      allocatedAmount: number;
      receiptStatus: ReceiptStatus;
    }
  | { ok: false; receiptId: string; orderId: string; error: string };

/** POST /receipts/allocate-batch 返回 */
export interface AllocateBatchResult {
  ok: true;
  results: AllocateBatchResultItem[];
  summary: { total: number; succeeded: number; failed: number };
}

/** POST /orders/:id/overpay-to-pool 返回 */
export interface OverpayToPoolResult {
  ok: true;
  orderId: string;
  orderNumber: string;
  movedAmount: number;
  newPaidAmount: number;
  total: number;
  receiptId: string;
  receiptNo: string;
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
  // 跨日期区间拉取所有航班班次（座位统计用）。省略 from/to 则返回全部。
  listSchedulesInRange: (token: string, range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (range?.from) params.set('from', range.from);
    if (range?.to) params.set('to', range.to);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<{ schedules: RangeSchedule[] }>(`/flights/schedules${qs}`, { token });
  },
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
      /** 改时刻：ISO datetime 字符串（本地时间带时区或 UTC） */
      departureTime?: string;
      arrivalTime?: string;
      /** A11：已售班次改时刻的二次确认标志——首次调用被 400 拦下后，确认再带 true 重试。 */
      confirmSoldTimeChange?: boolean;
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
  // 批量删除班次（ADMIN/STAFF）：按出发日区间 [from, to]（本地日 YYYY-MM-DD），
  // flightId 省略=全部航班。后端逐条守 sold>0/有订单：已售班次跳过（不删），
  // 返回 { deleted, skipped: [{ scheduleId, reason }] }。
  batchDeleteSchedules: (
    token: string,
    body: { flightId?: string; from: string; to: string },
  ) =>
    apiFetch<{ result: { deleted: number; skipped: Array<{ scheduleId: string; reason: string }> } }>(
      '/flights/schedules/batch-delete',
      { method: 'POST', token, body },
    ),
  // 批量改容量（ADMIN）：scheduleIds 由前端按日期区间/星期几筛出（复用批量改价面板的
  // 班次选择范围），seatClasses 按 cabin 套用到每个命中班次。后端逐条守 capacity ≥ sold，
  // 命中守卫的班次跳过（不改），返回 { applied, skipped: [{ scheduleId, reason }] }。
  batchUpdateCapacity: (
    token: string,
    body: { scheduleIds: string[]; seatClasses: Array<{ cabin: CabinClass; capacity: number }> },
  ) =>
    apiFetch<{ result: { applied: number; skipped: Array<{ scheduleId: string; reason: string }> } }>(
      '/flights/schedules/batch-update-capacity',
      { method: 'POST', token, body },
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
  // 编辑代理基础联系信息（公司名/联系人/电话/邮箱/备注）；ADMIN/STAFF 可改任意代理，AGENT 只能改自己
  updateAgent: (token: string, id: string, body: UpdateAgentInput) =>
    apiFetch<{ agent: AgentListItem }>(`/agents/${id}`, { method: 'PATCH', token, body }),
  // 停用/启用代理登录；仅 ADMIN
  setAgentStatus: (token: string, id: string, isActive: boolean) =>
    apiFetch<{ agent: AgentListItem }>(`/agents/${id}/status`, {
      method: 'PATCH',
      token,
      body: { isActive },
    }),

  // 切位（包位）——从散客池划座给代理专卖，到期未售回散客池（ADMIN/STAFF）
  createSeatAllocation: (token: string, body: CreateSeatAllocationInput) =>
    apiFetch<{ allocation: SeatAllocationRecord }>('/seat-allocations/', {
      method: 'POST',
      token,
      body,
    }),
  listSeatAllocations: (
    token: string,
    filter?: { flightScheduleId?: string; agentId?: string },
  ) => {
    const params = new URLSearchParams();
    if (filter?.flightScheduleId) params.set('flightScheduleId', filter.flightScheduleId);
    if (filter?.agentId) params.set('agentId', filter.agentId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<{ allocations: SeatAllocationListItem[] }>(`/seat-allocations/${qs}`, { token });
  },
  reclaimSeatAllocation: (token: string, id: string) =>
    apiFetch<{ result: { id: string; status: SeatAllocationStatus } }>(
      `/seat-allocations/${id}/reclaim`,
      { method: 'POST', token },
    ),

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
  addGroundItem: (
    token: string,
    orderId: string,
    body:
      | {
          kind: 'VISA';
          visaId: string;
          quantity?: number;
          unitPriceCny?: number;
          note?: string;
        }
      | {
          kind: 'HOTEL';
          hotelRoomTypeId: string;
          nights: number;
          rooms: number;
          checkIn?: string;
          unitPriceCny?: number;
          note?: string;
        },
  ) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/items/ground`, {
      method: 'POST',
      token,
      body,
    }),
  updateOrderStatus: (token: string, id: string, toStatus: OrderStatus, reason?: string, force?: boolean) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${id}/status`, {
      method: 'PATCH',
      token,
      body: { toStatus, reason, force },
    }),
  // 软删订单（仅 ADMIN）：从所有列表/导出/统计里消失，数据保留可追溯，不影响座位账。
  // 后端守卫：仍占座的订单会 4xx（需先取消释放座位）。
  deleteOrder: (token: string, id: string) =>
    apiFetch<{ ok: true; id: string; deletedAt: string | null }>(`/orders/${id}`, {
      method: 'DELETE',
      token,
    }),
  // 回收站：列出已软删订单（仅 ADMIN）。删除人（deletedBy）来自审计，可能为 null。
  // search：模糊匹配订单号/联系人名/乘客姓名（含中文名），透传给后端 query 参数。
  listDeletedOrders: (token: string, query?: { page?: number; pageSize?: number; search?: string }) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
    }
    return apiFetch<{
      orders: DeletedOrderSummary[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/orders/deleted${qs.toString() ? '?' + qs.toString() : ''}`, { token });
  },
  // 从回收站恢复（仅 ADMIN）：deletedAt 置回 null，订单重新可见。软删/恢复都不触碰座位账。
  restoreOrder: (token: string, id: string) =>
    apiFetch<{ ok: true; id: string; deletedAt: string | null }>(`/orders/${id}/restore`, {
      method: 'POST',
      token,
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

  // 批量散客建单（支持单程/往返/套餐）：名单每位乘客一单
  batchCreateOrders: (token: string, body: BatchCreateOrdersInput) =>
    apiFetch<BatchCreateOrdersResult>('/orders/batch', { method: 'POST', token, body }),

  // 改结算价（ADMIN/STAFF）：仅对 FLIGHT 行生效；事务内重算 order.total
  // PATCH /orders/:orderId/items/:itemId/settlement-price
  updateItemSettlementPrice: (
    token: string,
    orderId: string,
    itemId: string,
    body: { unitPriceCny: number; reason?: string },
  ) =>
    apiFetch<{ order: OrderSummary; warning?: string | null }>(`/orders/${orderId}/items/${itemId}/settlement-price`, {
      method: 'PATCH',
      token,
      body,
    }),

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

  // 录单前试算「系统价」（只算不落库；ADMIN/STAFF）。items 与 createOrder 同结构。
  // passengers（可选）：套餐乘客级住宿/签证选项，让系统价随每人选择实时变化（缺省回落 item 级旧口径）。
  quoteOrder: (
    token: string,
    body: {
      items: CreateOrderItemInput[];
      passengers?: Array<{ visaExempt?: boolean; singleRoom?: boolean }>;
    },
  ) => apiFetch<QuoteOrderResult>('/orders/quote', { method: 'POST', token, body }),

  // 设置开票状态（ADMIN/STAFF）— 旧的订单级单值，兼容保留
  setInvoiceStatus: (token: string, id: string, invoiceStatus: InvoiceStatus) =>
    apiFetch<{ id: string; orderNumber: string; invoiceStatus: InvoiceStatus }>(
      `/orders/${id}/invoice-status`,
      { method: 'PATCH', token, body: { invoiceStatus } },
    ),

  // 设置六态开票的三个布尔位（ADMIN/STAFF）：去程/回程/系统 各自独立。
  // 翻某航段为已开时后端校验对应班次开票上限（超限 422）。
  setInvoiceFlags: (
    token: string,
    id: string,
    flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean },
  ) =>
    apiFetch<{
      id: string;
      orderNumber: string;
      outboundInvoiced: boolean;
      returnInvoiced: boolean;
      systemInvoiced: boolean;
    }>(`/orders/${id}/invoice-flags`, { method: 'PATCH', token, body: flags }),

  // 批量设置六态开票的三个布尔位（票务岗批量操作，ADMIN/STAFF）：逐单复用单条校验语义，
  // 单单失败（如超班次开票上限）不影响其余单；返回逐单结果 + 汇总，供前端展示成功/失败清单。
  batchInvoiceFlags: (
    token: string,
    orderIds: string[],
    flags: { outboundInvoiced?: boolean; returnInvoiced?: boolean; systemInvoiced?: boolean },
  ) =>
    apiFetch<{
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
    }>('/orders/batch-invoice-flags', { method: 'POST', token, body: { orderIds, flags } }),

  // 批量锁定/解锁结算价（ADMIN/STAFF）：不存在或已软删订单计入 skipped。
  batchSettlementLock: (token: string, orderIds: string[], lock: boolean) =>
    apiFetch<{ updated: number; skipped: number }>('/orders/batch/settlement-lock', {
      method: 'POST',
      token,
      body: { orderIds, lock },
    }),

  // 人工确认收款（线下收款 → 标记已付 + 上传截图）ADMIN/STAFF
  // 现已允许多付：amount 可超过尾款（paidAmount 可大于 total）。
  // 硬闸：净已收超应付（含 1 分容差）→ 400，message 直接展示。
  // 软闸：同订单近 windowMinutes 分钟内已有等额手工收款 → 409 code=DUPLICATE_AMOUNT；
  //       二次确认后带 confirmDuplicate:true 放行。
  confirmPayment: (
    token: string,
    body: {
      orderId: string;
      amount?: number;
      method: PaymentMethod;
      proofUrl?: string;
      note?: string;
      idempotencyKey?: string;
      confirmDuplicate?: boolean;
    },
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
  // batchId：调用方为「本次提交」生成的稳定幂等键（表单打开时生成一次，成功后换新）——
  // 同一 batchId 重复提交（双击/网络重试）同一订单不会二次入账。
  batchConfirmPayments: (
    token: string,
    body: {
      items: Array<{ orderId: string; amount: number; method?: PaymentMethod; proofUrl?: string; note?: string }>;
      sharedProofUrl?: string;
      batchId?: string;
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
      if (v === undefined || v === '') continue;
      // orderIds 以逗号分隔透传（后端两种风格都收）；其余标量直接 set。
      if (k === 'orderIds' && Array.isArray(v)) {
        if (v.length > 0) qs.set('orderIds', v.join(','));
        continue;
      }
      qs.set(k, String(v));
    }
    const res = await fetch(`${API_BASE}/orders/export-templates?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },
  // 全岗总表导出（PRIMARY 综合导出：一行/乘客，字段全）；ADMIN/STAFF only。
  // GET /orders/export/master?from&to&role — 按出发日期区间选单；缺省 = 全部。返回 Blob 直接下载。
  exportMaster: async (
    token: string,
    params?: { from?: string; to?: string; role?: 'all' | 'ticketing' | 'visa'; orderIds?: string[] },
  ): Promise<Blob> => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.role) qs.set('role', params.role);
    // 勾选导出：给了就只导这批订单（逗号分隔透传，后端以 id 集合为准）。
    if (params?.orderIds && params.orderIds.length > 0) qs.set('orderIds', params.orderIds.join(','));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await fetch(`${API_BASE}/orders/export/master${suffix}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },
  // 进单统计导出（公测反馈·票务）；ADMIN/STAFF only。
  // GET /orders/export/intake + listOrders 同款筛选（尤其 from/to 下单时间窗口，可带时间到分钟）。
  // 按「出发日期 × 产品/团期」聚合，返回 Blob 直接下载。
  exportIntake: async (token: string, params?: ListOrdersParams): Promise<Blob> => {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await fetch(`${API_BASE}/orders/export/intake${suffix}`, {
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
  // 套票分房（warnings：B10 金额分叉/混性别/多酒店行提示，弹给运营看，不阻断）
  updateRoomAssignment: (token: string, orderId: string, roomGroups: RoomGroup[]) =>
    apiFetch<{ ok: boolean; warnings?: string[] }>(`/orders/${orderId}/room-assignment`, {
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

  // ── 售后：改期 / 换人（ADMIN/STAFF）──────────────────────────────────
  // 改期：把某个 FLIGHT 订单项移到新班次（座位服务端搬移；新班次售罄则拒绝），
  // 可选改舱位 + 可选加「改期费」到订单。返回更新后的订单。
  rescheduleOrder: (
    token: string,
    orderId: string,
    body: {
      orderItemId: string;
      newScheduleId: string;
      newCabin?: CabinClass;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
    },
  ) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/reschedule`, {
      method: 'PATCH',
      token,
      body,
    }),
  // 换人/编辑出行人：改姓名/护照/生日/性别/国籍；可选重置开票(→NONE)/签证(→PENDING)；
  // 可选加「换人费」到订单。返回更新后的订单。
  updateOrderPassenger: (
    token: string,
    orderId: string,
    passengerId: string,
    body: {
      lastName?: string;
      firstName?: string;
      fullName?: string;
      /** 中文姓名（选填；下单时已支持，此处补录/编辑用同一字段） */
      chineseName?: string;
      documentNumber?: string;
      dateOfBirth?: string;
      gender?: 'M' | 'F' | 'X';
      nationality?: string;
      resetInvoice?: boolean;
      resetVisa?: boolean;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
    },
  ) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/passengers/${passengerId}`, {
      method: 'PATCH',
      token,
      body,
    }),

  // 换人后为新出行人补录护照资料（护照图/有效期/签发日/签发地/签发国）。
  // 走同一 PATCH /orders/:id/passengers/:passengerId 端点的「补录」通道（不含换人语义字段 →
  // 落在 SELF_UPDATE 分支，返回 { passenger }）：换人本身会清空旧人的护照资料，这一步再把
  // OCR 识别到的新人护照资料写回，不削弱换人的清除语义。ISO-2 国家码。
  supplementOrderPassengerPassport: (
    token: string,
    orderId: string,
    passengerId: string,
    body: {
      passportPhotoUrl?: string;
      passportExpiry?: string;
      passportIssueDate?: string;
      passportIssuePlace?: string;
      passportIssueCountry?: string;
    },
  ) =>
    apiFetch<{ passenger: unknown }>(`/orders/${orderId}/passengers/${passengerId}`, {
      method: 'PATCH',
      token,
      body,
    }),

  // 签证台：出签后补录出行人的 出签日/生效日/有效期（仅 ADMIN/STAFF）。
  // 这三项是签证岗出签后才拿得到的信息，录单时无法预先知道（票务岗反馈：录单时不需要，
  // 已从录单表单移除），改由签证台在出签后调用本端点补录。
  // YYYY-MM-DD 字符串写入该字段；null 清空该字段；未传的字段不动。
  updatePassengerVisaDates: (
    token: string,
    orderId: string,
    passengerId: string,
    body: {
      visaIssueDate?: string | null;
      visaEffectiveDate?: string | null;
      visaExpiry?: string | null;
    },
  ) =>
    apiFetch<{ passenger: { id: string } }>(
      `/orders/${orderId}/passengers/${passengerId}/visa-dates`,
      { method: 'PATCH', token, body },
    ),

  // 换酒店：把某条 HOTEL 行（或已盖章酒店的 BUNDLE 行）换到另一个房型/酒店。
  // 价格默认冻结（绝不按新房型 basePrice 重算 unitPrice/amount）；可选加/减「换酒店差价」
  // （feeCny 可负，0 会被拒绝——不调整价格请不要传该字段）。返回更新后的订单。
  swapItemHotel: (
    token: string,
    orderId: string,
    itemId: string,
    body: {
      newHotelRoomTypeId: string;
      feeCny?: number;
      feeLabel?: string;
      note?: string;
    },
  ) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/items/${itemId}/hotel`, {
      method: 'PATCH',
      token,
      body,
    }),

  // 更改订单归属代理（T5；ADMIN/STAFF）。agentId=null（或空串归一）= 转直客；任何状态都能改，留审计。
  // 财务不回溯（已发生的收款/代理余额抵扣/佣金按原归属，不回滚；变更后新产生的按新归属）。
  // 若订单曾用原代理预存余额抵扣，响应带非空 warning 提醒核对财务归属（不阻断）。
  changeOrderAgent: (
    token: string,
    orderId: string,
    body: { agentId: string | null; reason?: string },
  ) =>
    apiFetch<{ order: OrderSummary; warning: string | null }>(`/orders/${orderId}/agent`, {
      method: 'PATCH',
      token,
      body,
    }),

  // 事后补收单房差（ADMIN/STAFF）：金额 = perNightCny × nights；后端新增一条 FEE 行 + 重算 total
  // + 追加审计流水。仅含 BUNDLE/HOTEL 行的订单可用（纯机票单 400）。返回更新后的订单。
  addRoomSupplement: (
    token: string,
    orderId: string,
    body: {
      perNightCny: number;
      nights: number;
      note?: string;
      /** 幂等键：同 key 重试只入账一次（防双击/超时重发叠加多条 FEE 行）。 */
      idempotencyKey?: string;
      /** 转单住的乘客（A15 房控联动）：同事务标记 singleRoom + 重算套餐行计费房数。 */
      passengerId?: string;
    },
  ) =>
    apiFetch<{ order: OrderSummary; roomControl: string | null }>(`/orders/${orderId}/room-supplement`, {
      method: 'POST',
      token,
      body,
    }),

  // 事后调价（0722 公测反馈「按乘客调价」；ADMIN/STAFF）：在系统权威价上加减一笔差额 + 原因。
  //   passengerId 非空 = 只作用于该乘客的应收份额（金额明细逐人可解释）；空 = 整单调价（现行为不变）。
  //   走与录单调价同一路径：后端追加一条 priceAdjustment 差额行，金额进 total（订单总额 = 系统价 + Σ调整）。
  //   返回更新后的订单。
  addOrderPriceAdjustment: (
    token: string,
    orderId: string,
    body: {
      /** 整数 CNY，可正（补收）可负（优惠），非 0；|金额| ≤ 100000。 */
      amountCny: number;
      reasonCode: PriceAdjustmentReason;
      /** 「其它」原因必填说明。 */
      reasonText?: string;
      /** 指定乘客（属于本单）；不传 = 整单调价。 */
      passengerId?: string;
    },
  ) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${orderId}/price-adjustment`, {
      method: 'POST',
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
      /** auto = 规则自动生成（ruleKey 非空）；manual = 手动创建 */
      source?: 'auto' | 'manual';
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
  // 按规则批量生成今日提醒（催尾款/出行提醒/护照有效期/签证缺件…）；幂等，已存在的跳过
  generateReminders: (token: string) =>
    apiFetch<{ created: number; skipped: number; byRule: Record<string, number> }>(
      '/reminders/generate',
      { method: 'POST', token, body: {} },
    ),

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

  // 酒店房量档位（公开端点，只回档位不回原始数字，与六档余位同纪律）
  getHotelAvailability: (params: { hotelRoomTypeId: string; checkIn: string; checkOut: string }) => {
    const qs = new URLSearchParams(params);
    return apiFetch<HotelAvailabilityResult>(`/products/hotel-availability?${qs.toString()}`);
  },

  // Products — Hotels
  // token 选填：带 ADMIN/STAFF token 时后端会下发 costPriceCny（成本价，仅内部）；
  // 匿名/不传 token 时响应里完全不含这个 key（0702 反馈 6·成本泄漏修复，见 backend products.routes.ts isCostVisible）。
  listHotels: (activeOnly = false, token?: string | null) =>
    apiFetch<{ hotels: Hotel[] }>(`/products/hotels${activeOnly ? '?active=1' : ''}`, { token }),
  createHotel: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ hotel: Hotel }>('/products/hotels', { method: 'POST', token, body }),
  updateHotel: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ hotel: Hotel }>(`/products/hotels/${id}`, { method: 'PATCH', token, body }),
  deleteHotel: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/hotels/${id}`, { method: 'DELETE', token }),

  // Products — Transfers
  // token 选填：同 listHotels，带 ADMIN/STAFF token 才下发 costPriceCny。
  listTransfers: (activeOnly = false, token?: string | null) =>
    apiFetch<{ transfers: Transfer[] }>(`/products/transfers${activeOnly ? '?active=1' : ''}`, { token }),
  createTransfer: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ transfer: Transfer }>('/products/transfers', { method: 'POST', token, body }),
  updateTransfer: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ transfer: Transfer }>(`/products/transfers/${id}`, { method: 'PATCH', token, body }),
  deleteTransfer: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/transfers/${id}`, { method: 'DELETE', token }),

  // Products — Visas
  // token 选填：同 listHotels，带 ADMIN/STAFF token 才下发 costPriceCny。
  listVisas: (activeOnly = false, token?: string | null) =>
    apiFetch<{ visas: Visa[] }>(`/products/visas${activeOnly ? '?active=1' : ''}`, { token }),
  createVisa: (token: string, body: Record<string, unknown>) =>
    apiFetch<{ visa: Visa }>('/products/visas', { method: 'POST', token, body }),
  updateVisa: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ visa: Visa }>(`/products/visas/${id}`, { method: 'PATCH', token, body }),
  deleteVisa: (token: string, id: string) =>
    apiFetch<{ result: { id: string; isActive: boolean } }>(`/products/visas/${id}`, { method: 'DELETE', token }),

  // Products — Bundles
  listBundles: (activeOnly = false) =>
    apiFetch<{ bundles: Bundle[] }>(`/products/bundles${activeOnly ? '?active=1' : ''}`),
  // 套餐机票参考价（ADMIN/STAFF）：按去/回程航班号取当前最低来回经济舱机票/人；
  // 两者留空 = 按套餐航线兜底。空串按「未绑」处理（不带该 query 参数），与后端 schema 归一口径一致。
  getBundleFlightRef: (
    token: string,
    params: { outboundFlightId?: string | null; returnFlightId?: string | null },
  ) => {
    const qs = new URLSearchParams();
    if (params.outboundFlightId) qs.set('outboundFlightId', params.outboundFlightId);
    if (params.returnFlightId) qs.set('returnFlightId', params.returnFlightId);
    const q = qs.toString();
    return apiFetch<BundleFlightRefPrice>(`/products/bundles/flight-ref${q ? `?${q}` : ''}`, { token });
  },
  createBundle: (token: string, body: BundleWriteBody) =>
    apiFetch<{ bundle: Bundle }>('/products/bundles', { method: 'POST', token, body }),
  updateBundle: (token: string, id: string, body: BundleWriteBody) =>
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

  // Traveler Profiles（旅客档案：常旅客画像，ADMIN/STAFF）
  listTravelerProfiles: (token: string, query?: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return apiFetch<ListTravelerProfilesResult>(
      `/travelers/profiles${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },
  getTravelerProfile: (token: string, id: string) =>
    apiFetch<{ profile: TravelerProfile; trips: TravelerProfileTrip[] }>(
      `/travelers/profiles/${id}`,
      { token },
    ),
  updateTravelerProfileNotes: (token: string, id: string, notes: string | null) =>
    apiFetch<{ profile: TravelerProfile }>(`/travelers/profiles/${id}/notes`, {
      method: 'PATCH',
      token,
      body: { notes },
    }),
  rebuildTravelerProfiles: (token: string) =>
    apiFetch<{ result: { built: number; removed: number } }>('/travelers/profiles/rebuild', {
      method: 'POST',
      token,
      body: {},
    }),
  // 录单联想：按姓名/证件号联想常旅客档案（q<2 字符后端返回空；limit 默认 8）
  suggestTravelerProfiles: (
    token: string,
    q: string,
    limit?: number,
    opts?: { signal?: AbortSignal },
  ) => {
    const qs = new URLSearchParams({ q });
    if (limit !== undefined) qs.set('limit', String(limit));
    return apiFetch<{ suggestions: TravelerProfileSuggestion[] }>(
      `/travelers/profiles/suggest?${qs.toString()}`,
      { token, signal: opts?.signal },
    );
  },
  // 合并档案：把 id（被并方）并进 intoId（保留方）；被并号保留为旧证指针，操作不可撤销
  mergeTravelerProfile: (token: string, id: string, intoId: string) =>
    apiFetch<MergeTravelerProfileResult>(`/travelers/profiles/${id}/merge`, {
      method: 'POST',
      token,
      body: { intoId },
    }),

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
  // 按需拉取某订单乘客护照图（base64 data URL）——签证台展开某单时才取真图（列表已瘦身不带图）
  listPassengerPhotos: (token: string, orderId: string) =>
    apiFetch<{ photos: Array<{ id: string; passportPhotoUrl: string | null }> }>(
      `/fulfillment-tasks/by-order/${orderId}/passenger-photos`,
      { token },
    ),
  // 批量改履约任务状态（签证台批量标"已送签"等；逐条校验，部分失败返回 failures）
  batchUpdateFulfillmentStatus: (token: string, taskIds: string[], toStatus: FulfillmentStatus) =>
    apiFetch<BatchFulfillmentStatusResult>('/fulfillment-tasks/batch-status', {
      method: 'POST',
      token,
      body: { taskIds, toStatus },
    }),
  // 批量改履约任务备注（独立于批量改状态，不动 status；notes 允许空串 = 批量清空）
  batchUpdateFulfillmentNotes: (token: string, taskIds: string[], notes: string) =>
    apiFetch<BatchFulfillmentStatusResult>('/fulfillment-tasks/batch-notes', {
      method: 'POST',
      token,
      body: { taskIds, notes },
    }),
  updateFulfillmentTask: (token: string, id: string, body: Record<string, unknown>) =>
    apiFetch<{ task: FulfillmentTask }>(`/fulfillment-tasks/${id}`, { method: 'PATCH', token, body }),
  // 设置单个签证任务的人均成本（美金+汇率自动折 CNY，或直填 CNY；全 null=清空回退产品成本）
  setVisaTaskCost: (token: string, id: string, cost: VisaTaskCostInput) =>
    apiFetch<{ task: FulfillmentTask }>(`/fulfillment-tasks/${id}`, { method: 'PATCH', token, body: cost }),
  // 批量给选中订单的签证任务设同一人均单价（签证公司按航班统一单价是常态）
  batchSetVisaTaskCost: (token: string, taskIds: string[], cost: VisaTaskCostInput) =>
    apiFetch<BatchFulfillmentStatusResult>('/fulfillment-tasks/visa-cost/batch', {
      method: 'POST',
      token,
      body: { taskIds, ...cost },
    }),
  // 按人更新送签进度（单个）——部分送签用；后端改写乘客进度并重新派生任务状态
  updateVisaPassengerStatus: (token: string, passengerId: string, status: VisaSubmissionStatus) =>
    apiFetch<{ result: { passengerId: string; status: VisaSubmissionStatus; orderId: string | null } }>(
      `/fulfillment-tasks/visa-passengers/${passengerId}/status`,
      { method: 'PATCH', token, body: { status } },
    ),
  // 按人批量标记送签进度（部分送签核心入口；逐乘客校验，部分失败返回 failures）
  batchUpdateVisaPassengerStatus: (
    token: string,
    passengerIds: string[],
    toStatus: VisaSubmissionStatus,
  ) =>
    apiFetch<BatchFulfillmentStatusResult & { affectedOrderIds: string[] }>(
      '/fulfillment-tasks/visa-passengers/batch-status',
      { method: 'POST', token, body: { passengerIds, toStatus } },
    ),
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

  // 岗位管理（A20，仅 ADMIN）：内部账号列表 + 赋岗位（岗位决定导出裁剪，服务端强制）
  listStaff: (token: string) =>
    apiFetch<{ staff: StaffUser[] }>(`/users/staff`, { token }),
  setStaffRole: (token: string, userId: string, staffRole: StaffRole | null) =>
    apiFetch<{ ok: boolean; staffRole: StaffRole | null }>(`/users/${userId}/staff-role`, {
      method: 'PATCH',
      token,
      body: { staffRole },
    }),

  // 佣金规则（A1）：读=当前生效费率（每产品一条）；写=仅 ADMIN，追加新生效规则（历史保留）
  getCommissionRules: (token: string, agentId: string) =>
    apiFetch<{
      rules: Record<'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA', { rate: number; effectiveFrom: string } | null>;
    }>(`/agents/${agentId}/commission-rules`, { token }),
  setCommissionRules: (
    token: string,
    agentId: string,
    rates: Partial<Record<'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA', number>>,
  ) =>
    apiFetch<{ ok: boolean; rates: Record<string, number>; effectiveFrom: string }>(
      `/agents/${agentId}/commission-rules`,
      { method: 'PUT', token, body: { rates } },
    ),

  // Pricing — 日期等级 CRUD 已砍除（2026-07-17 审计 #19）：定价不消费其倍率、无后台页面调用，
  // 端点与 client 一并移除；DateRanking 表保留（getDateRank 只读路径仍在，查不到走 DOW 兜底）。

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
  getFinanceOrderPnlDetail: (token: string, orderId: string) =>
    apiFetch<OrderPnlDetail>(`/finances/orders/${encodeURIComponent(orderId)}/pnl-detail`, {
      token,
    }),
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
  setFlightScheduleCostLock: (token: string, id: string, lock: boolean) =>
    apiFetch<{
      id: string;
      costLocked: boolean;
      costLockedAt: string | null;
      costLockedBy: string | null;
    }>(`/finances/schedules/${id}/cost-lock`, { method: 'POST', token, body: { lock } }),

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

  // 班次成本明细（admin · 用于"航班成本"维护页；带单座成本与空座成本动态指标）
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

  // 财务对账 xlsx 按订单维度导出（一行一订单，订单毛利）
  downloadFinanceExportByOrder: async (
    token: string,
    range: { from: string; to: string },
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/finances/export-orders?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  // ── 经营报表（ADMIN-only）— 销售毛利 / 应收账龄 / 代理欠款 ────────────
  getSalesReport: (
    token: string,
    params: { from?: string; to?: string; dim: SalesReportDim },
  ) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    qs.set('dim', params.dim);
    return apiFetch<SalesReport>(`/reports/sales?${qs.toString()}`, { token });
  },
  getReceivablesReport: (token: string) =>
    apiFetch<ReceivablesReport>('/reports/receivables', { token }),
  getAgentDebtsReport: (token: string) =>
    apiFetch<AgentDebtsReport>('/reports/agent-debts', { token }),
  // 经营报表 xlsx 导出（Blob 直接下载）
  downloadReportsXlsx: async (
    token: string,
    range: { from: string; to: string },
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/reports/export?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
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

  // 近期用房变更（读审计流：订单侧改了分房/换酒店/补房差 → 房控可见性；倒序近 N 天，上限 100）
  getHotelRecentChanges: (token: string, days = 7) =>
    apiFetch<HotelRecentRoomChanges>(`/hotel-control/recent-changes?days=${days}`, { token }),

  // 分房表导出（成都格式：每入住日期一个 sheet；ADMIN/STAFF only）— Blob 直接下载
  //   · { from, to }    按入住日区间选（跨度上限 14 天）
  //   · { departDate }  按出发日选订单，导出其全部入住晚（后端 departDate 优先于 from/to）
  downloadRoomAllocation: async (
    token: string,
    params: { from: string; to: string } | { departDate: string },
  ): Promise<Blob> => {
    const qs =
      'departDate' in params
        ? `departDate=${encodeURIComponent(params.departDate)}`
        : `from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`;
    const res = await fetch(`${API_BASE}/orders/export-room-allocation?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  // 签证名单表（ADMIN/STAFF）：勾选订单合并成一张签证名单 xlsx（不含护照图）
  // 0713 签证岗反馈：原合并 zip 多一步解压不方便，拆成名单表 / 护照包分开下载
  downloadVisaRoster: async (token: string, orderIds: string[]): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/orders/visa-roster.xlsx`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds }),
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'XLSX_FAILED', message: await res.text() });
    return res.blob();
  },

  // 签证护照包（ADMIN/STAFF）：勾选订单的全部乘客护照图打包 zip（不含名单表）
  downloadVisaPassports: async (token: string, orderIds: string[]): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/orders/visa-passports.zip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds }),
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'ZIP_FAILED', message: await res.text() });
    return res.blob();
  },

  // ── 候补（ADMIN/STAFF）— 某班次候补名单（含用户联系方式，电话回访用）──
  listWaitlistBySchedule: (token: string, scheduleId: string) =>
    apiFetch<{ entries: WaitlistEntry[] }>(
      `/waitlist/?scheduleId=${encodeURIComponent(scheduleId)}`,
      { token },
    ),

  // ── 收款渠道管理（ADMIN/STAFF）── CRUD（统一收款码 + 账号信息）
  listPaymentChannels: (token: string) =>
    apiFetch<{ channels: PaymentChannel[] }>('/payment-channels', { token }),
  createPaymentChannel: (token: string, body: CreatePaymentChannelInput) =>
    apiFetch<{ channel: PaymentChannel }>('/payment-channels', { method: 'POST', token, body }),
  updatePaymentChannel: (token: string, id: string, body: UpdatePaymentChannelInput) =>
    apiFetch<{ channel: PaymentChannel }>(`/payment-channels/${id}`, { method: 'PATCH', token, body }),
  deletePaymentChannel: (token: string, id: string) =>
    apiFetch<{ ok: true; id: string }>(`/payment-channels/${id}`, { method: 'DELETE', token }),

  // ── 收款对账台（ADMIN/STAFF）── 进账列表 / 全部流水 / 登记 / 认领 / 退款
  // 进账列表：每条带 remainingCny + allocations[]
  listReceipts: (token: string, query?: ListReceiptsParams) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    return apiFetch<{ receipts: Receipt[] }>(
      `/receipts${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },
  // 全部流水：进账 + 订单收款合并，按时间倒序（只读）
  getReceiptLedger: (token: string) =>
    apiFetch<{ entries: LedgerEntry[] }>('/receipts/ledger', { token }),
  // 登记新进账（后台手动录入）→ 生成 OPEN 进账
  createReceipt: (token: string, body: CreateReceiptInput) =>
    apiFetch<{ receipt: Receipt }>('/receipts', { method: 'POST', token, body }),
  // 认领：把进账金额分配到某订单（原子；超额/已退款会被拒绝）
  allocateReceipt: (token: string, id: string, body: { orderId: string; amountCny: number }) =>
    apiFetch<AllocateReceiptResult>(`/receipts/${id}/allocate`, { method: 'POST', token, body }),
  // 批量认款：逐组独立事务复用认领内核，某组失败不影响其它组，逐组回结果
  allocateReceiptBatch: (token: string, items: AllocateBatchItem[]) =>
    apiFetch<AllocateBatchResult>('/receipts/allocate-batch', {
      method: 'POST',
      token,
      body: { items },
    }),
  // 退款：把进账剩余金额标记退款（不可再认领）
  refundReceipt: (token: string, id: string, note: string) =>
    apiFetch<{ ok: true; receiptId: string; receiptNo: string; refundedRemainingCny: string; status: 'REFUNDED' }>(
      `/receipts/${id}/refund`,
      { method: 'POST', token, body: { note } },
    ),

  // ── 二维码流水导入 + 认款工作台（ADMIN/STAFF）──
  // 解析收单平台流水 xlsx（base64）→ 预览行 + 处置判定（不写库）
  parseReceiptStatement: (token: string, platform: StatementPlatform, fileBase64: string) =>
    apiFetch<StatementPreviewResult>('/receipts/statement/parse', {
      method: 'POST',
      token,
      body: { platform, fileBase64 },
    }),
  // 流水入池：预览确认后提交；服务端按交易流水号唯一索引兜底去重（重复导入幂等）
  importReceiptStatement: (token: string, platform: StatementPlatform, rows: StatementImportRow[]) =>
    apiFetch<{ ok: true; requested: number; imported: number; skipped: number }>(
      '/receipts/statement/import',
      { method: 'POST', token, body: { platform, rows } },
    ),
  // 认款工作台：近 400 单里尾款 > 0 的待收款订单候选（最多 200）
  // 可选 from/to（按订单下单日期）+ q（订单号/联系人/代理名，服务端过滤）收窄
  getReceiptMatchCandidates: (token: string, query?: ReceiptMatchCandidatesParams) => {
    const qs = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    return apiFetch<{ orders: ReceiptMatchCandidate[] }>(
      `/receipts/match-candidates${qs.toString() ? '?' + qs.toString() : ''}`,
      { token },
    );
  },
  // 流水核对表导出（xlsx；含认款状态/认到订单/认款人列）。返回 Blob 直接下载。
  exportReceiptStatement: async (token: string, query?: { from?: string; to?: string }): Promise<Blob> => {
    const qs = new URLSearchParams();
    if (query?.from) qs.set('from', query.from);
    if (query?.to) qs.set('to', query.to);
    const res = await fetch(
      `${API_BASE}/receipts/statement/export${qs.toString() ? '?' + qs.toString() : ''}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  // ── 订单超额转挂账池（ADMIN/STAFF）──
  // 把订单多付（paidAmount−total）转入挂账池：生成一条 ORDER_OVERPAY 进账，订单回到刚好结清。
  overpayOrderToPool: (token: string, orderId: string) =>
    apiFetch<OverpayToPoolResult>(`/orders/${orderId}/overpay-to-pool`, {
      method: 'POST',
      token,
      body: {},
    }),

  // ── AI OCR 护照识别 (ADMIN|STAFF) ────────────────────────────────────────
  // POST /ocr/passport
  //   no key → { configured: false }
  //   ok     → { configured: true, engine, model, suggested: {...} }
  //   fail   → { configured: true, engine, model, error, suggested: null }
  ocrPassportAi: (token: string, imageDataUrl: string) =>
    apiFetch<AiOcrPassportResult>('/ocr/passport', {
      method: 'POST',
      token,
      body: { imageDataUrl },
    }),

  // ── AI OCR 设置（ADMIN only）────────────────────────────────────────────────
  getAiOcrConfig: (token: string) =>
    apiFetch<AiOcrConfig>('/settings/ai-ocr', { token }),
  updateAiOcrConfig: (token: string, body: AiOcrConfigInput) =>
    apiFetch<AiOcrConfig>('/settings/ai-ocr', { method: 'PUT', token, body }),
  testAiOcrConfig: (token: string) =>
    apiFetch<{ ok: boolean; message: string }>('/settings/ai-ocr/test', {
      method: 'POST',
      token,
      body: {},
    }),
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
/** 财务口径：收入细分（10 项 + 未分类 + 退款净额 + 总和） */
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
  /** REFUNDED 订单的已收-已退净额（先收后退的净退款额），逐单累加计入 total */
  refund: number;
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
  grossMarginCny: number | null; // A5：缺成本时 null（未知）
  marginPct: number | null;
  emptySeatSunkCostCny: number;
  netMarginCny: number | null; // A5：毛利未知时 null
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
  emptySeatCostCny: number | null;
  netMarginCny: number | null;
  grossOnSoldCny: number | null;
  /** 财务口径：包机费 ÷ 全部座位；包机或总座位为 0 时 null */
  perSeatCostCny: number | null;
}

export type CostSource = 'override' | 'period' | 'none';

/** 内部岗位（A20）：null=通用运营。专岗账号的全岗总表导出被服务端强制裁到本岗模板。 */
export type StaffRole = 'VISA_DESK' | 'TICKETING' | 'ROOM_CONTROL';
export interface StaffUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: 'ADMIN' | 'STAFF';
  staffRole: StaffRole | null;
  lastLoginAt: string | null;
}

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
  originCode: string;
  destinationCode: string;
  origin: string;
  destination: string;
  departureTime: string;
  /** 出发地时区的当地出发日 YYYY-MM-DD（配对同录按它判定同一天） */
  localDepartureDate: string;
  // 生效（用于显示）
  charterCostCny: number | null;
  airportTaxDepCny: number | null;
  airportTaxArrCny: number | null;
  fuelCostCny: number | null;
  peakSurchargeCny: number | null;
  aircraftAdjustCny: number | null;
  takeoffDiscountCny: number | null;
  costLocked: boolean;
  costLockedAt: string | null;
  costLockedBy: string | null;
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
  /** 财务口径：包机费 ÷ 全部座位；包机或总座位为 0 时 null */
  perSeatCostCny: number | null;
  /** 财务口径：单座成本 × 未售座位数；包机或总座位为 0 时 null */
  emptySeatCostCny: number | null;
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
  /** A2 汇率四元组（选填）：包机原币种/原币金额/汇率/折算日 —— 审计留痕，CNY 仍是入账口径 */
  charterSourceCurrency?: string | null;
  charterSourceAmount?: number | null;
  charterFxRate?: number | null;
  charterFxDate?: string | null;
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
// 单订单收支明细（下钻）— 与 backend/finances.service.ts OrderPnlDetail 对齐
export interface OrderPnlDetailIncomeRow {
  label: string;
  kind: string;
  quantity: number;
  unitPriceCny: number;
  subtotalCny: number;
  isAdjustment: boolean;
}
export interface OrderPnlDetailCostRow {
  label: string;
  kind: string;
  quantity: number;
  totalCostCny: number | null;
  /** FLIGHT 行成本按班次实时口径计算 */
  isRealtime: boolean;
}
export interface OrderPnlDetailMiscRow {
  label: string;
  category: string;
  amountCny: number;
  note: string | null;
}
export interface OrderPnlDetail {
  orderId: string;
  orderNumber: string;
  status: string;
  contactName: string;
  agentName: string | null;
  departureDate: string | null;
  createdAt: string;
  income: {
    rows: OrderPnlDetailIncomeRow[];
    itemsSumCny: number;
    totalCny: number;
  };
  cost: {
    itemRows: OrderPnlDetailCostRow[];
    miscRows: OrderPnlDetailMiscRow[];
    itemCostCny: number | null;
    miscCostCny: number;
    totalWithMiscCny: number | null;
    missingCostItemCount: number;
  };
  // 与订单毛利 tab 行严格一致（不含杂项）
  grossMarginCny: number | null;
  marginPct: number | null;
  // 含杂项成本的完整毛利（参考）
  grossMarginWithMiscCny: number | null;
}
export interface MonthlyPoint {
  month: string;
  revenueCny: number;
  costCny: number;
  // 缺任一件成本 → null（未知，非 0）。成本快照上线前的历史月份多为 null。
  grossMarginCny: number | null;
  missingCostItemCount: number;
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

// ── AI OCR 类型（护照识别 + 设置）────────────────────────────────────────────

/** 后端返回的 AI 识别字段（与 backend POST /ocr/passport suggested 对齐） */
export interface AiOcrSuggested {
  lastName?: string;
  firstName?: string;
  fullName?: string;
  /** 中文姓名（可选字段，OCR 能识别时带出） */
  chineseName?: string;
  documentNumber?: string;
  dateOfBirth?: string;       // YYYY-MM-DD
  gender?: 'M' | 'F' | 'X';
  /** ISO-3 国籍（后端返回三字母）*/
  nationality?: string;
  /** ISO-3 签发国 */
  passportIssueCountry?: string;
  /** 护照签发地点（自由文本，城市/机关；区别于 ISO-2 签发国） */
  passportIssuePlace?: string;
  passportExpiry?: string;    // YYYY-MM-DD
  /** 护照签发日期（可选字段）*/
  passportIssueDate?: string; // YYYY-MM-DD
  placeOfBirth?: string;
}

/** OCR 字段人工核对提示（field 对应 AiOcrSuggested 键名，reason 为中文提示文案） */
export interface AiOcrReviewField {
  field: string;
  reason: string;
}

/** POST /ocr/passport 响应 */
export type AiOcrPassportResult =
  | { configured: false }
  | {
      configured: true;
      engine: 'qwen';
      model: string;
      suggested: AiOcrSuggested | null;
      error?: string;
      /** MRZ 校验 + 需人工核对字段（票务岗反馈：护照反光致目视区误读时提示二次核对） */
      verify?: {
        mrzValid: boolean;
        reviewFields: AiOcrReviewField[];
      };
    };

/** GET /settings/ai-ocr 响应（PUT 同形） */
export interface AiOcrConfig {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  enabled: boolean;
  /** true = DB 里有 key */
  apiKeySet: boolean;
  /** 脱敏后的 key 前缀 + 后缀（如 "sk-1****4567"）；未配置时 null */
  apiKeyMasked: string | null;
}

/** PUT /settings/ai-ocr body */
export interface AiOcrConfigInput {
  /** 空/缺省 = 保留现有 key；非空 = 更新 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

// ── 代理认款 / 收款码绑代理 ──────────────────────────────────────────────
// 与 backend agent-recharges 模块对齐（AgentRechargesService 序列化形态）+
// payment-channels 模块新增的 agentId/agentName 字段（专属代理收款码）。
// 独立导出（不塞进上面 `api` 对象），避免与并发编辑该文件中段的改动冲突；
// 调用方按 `agentRechargeApi.xxx(token, ...)` 使用，风格与 `api.xxx(token, ...)` 一致。

/** 代理认款状态：待审核 / 已确认到账 / 已驳回 */
export type AgentRechargeStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED';

export const AGENT_RECHARGE_STATUS_LABEL: Record<AgentRechargeStatus, string> = {
  PENDING: '待审核',
  CONFIRMED: '已确认',
  REJECTED: '已驳回',
};

/** 认款申请（serializeRechargeRequest；金额 Decimal→string） */
export interface AgentRechargeRequest {
  id: string;
  agentId: string;
  /** 列表接口附带展示用（公司名优先，否则联系人名）；提交接口的回包可能没有这个字段 */
  agentName?: string;
  amountCny: string;
  confirmedAmountCny: string | null;
  proofImages: string[];
  note: string | null;
  status: AgentRechargeStatus;
  reviewNote: string | null;
  submittedByUserId: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  prepaymentTxId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /agent-recharges body */
export interface CreateAgentRechargeInput {
  /** ADMIN/STAFF 代提交时必填；AGENT 自己提交时忽略（服务端按登录身份解析） */
  agentId?: string;
  amountCny: number;
  note?: string;
  /** 1-3 张，data:image/...;base64（前端上传前先压缩） */
  proofImages: string[];
}

/** GET /agent-recharges 查询参数 */
export interface ListAgentRechargesParams {
  status?: AgentRechargeStatus;
  /** 仅 ADMIN/STAFF 生效；AGENT 传了也会被服务端忽略/校验 */
  agentId?: string;
  page?: number;
  pageSize?: number;
}

/** PATCH /agent-recharges/:id/confirm body */
export interface ConfirmAgentRechargeInput {
  /** 缺省 = 按申报金额（amountCny）全额入账 */
  confirmedAmountCny?: number;
  reviewNote?: string;
}

/** PATCH /agent-recharges/:id/reject body */
export interface RejectAgentRechargeInput {
  reviewNote: string;
}

/** POST /agent-recharges/manual-adjust body（线下对账修正用） */
export interface ManualBalanceAdjustmentInput {
  agentId: string;
  /** 正数 = 加余额，负数 = 扣余额（扣减后不得为负，由服务端校验） */
  amount: number;
  reason: string;
}

/** GET /agent-recharges/my-channels 响应（AGENT 专用：应付款到哪个渠道） */
export interface MyPaymentChannelsResult {
  channels: PaymentChannel[];
  /** DEDICATED = 该代理的专属收款码；COMPANY = 退回公司统一码（无专属码时） */
  source: 'DEDICATED' | 'COMPANY';
}

/**
 * PaymentChannel 的扩展形态：补上 payment-channels 模块新增的 agentId/agentName
 * （不改原 `PaymentChannel` 接口——那是本文件中段的既有导出，另一并发改动可能同时在改）。
 */
export type PaymentChannelWithAgent = PaymentChannel & {
  agentId: string | null;
  agentName: string | null;
};

/** CreatePaymentChannelInput / UpdatePaymentChannelInput 的 agentId 扩展（同上，独立叠加不改原类型）。 */
export type CreatePaymentChannelWithAgentInput = CreatePaymentChannelInput & { agentId?: string };
export type UpdatePaymentChannelWithAgentInput = UpdatePaymentChannelInput & { agentId?: string | null };

export const agentRechargeApi = {
  /** 提交认款申请（AGENT 为自己；ADMIN/STAFF 需在 body 里指定 agentId） */
  createAgentRecharge: (token: string, body: CreateAgentRechargeInput) =>
    apiFetch<{ request: AgentRechargeRequest }>('/agent-recharges', { method: 'POST', token, body }),

  /** 列表：ADMIN/STAFF 全部可见（可过滤）；AGENT 仅自己 + 下级 */
  listAgentRecharges: (token: string, params?: ListAgentRechargesParams) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.agentId) qs.set('agentId', params.agentId);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{
      requests: AgentRechargeRequest[];
      pagination: { page: number; pageSize: number; total: number };
    }>(`/agent-recharges${suffix}`, { token });
  },

  /** AGENT 专用：查询应付款到哪个收款渠道（专属码优先，否则公司码） */
  myPaymentChannels: (token: string) =>
    apiFetch<MyPaymentChannelsResult>('/agent-recharges/my-channels', { token }),

  /** 确认到账（ADMIN/STAFF） */
  confirmAgentRecharge: (token: string, id: string, body: ConfirmAgentRechargeInput) =>
    apiFetch<{ request: AgentRechargeRequest; agentBalanceAfter: number }>(
      `/agent-recharges/${id}/confirm`,
      { method: 'PATCH', token, body },
    ),

  /** 驳回（ADMIN/STAFF，reviewNote 必填） */
  rejectAgentRecharge: (token: string, id: string, body: RejectAgentRechargeInput) =>
    apiFetch<{ request: AgentRechargeRequest }>(`/agent-recharges/${id}/reject`, {
      method: 'PATCH',
      token,
      body,
    }),

  /** 手动调整代理余额（ADMIN/STAFF，线下对账修正；负向调整不能击穿 0） */
  manualAdjustAgentBalance: (token: string, body: ManualBalanceAdjustmentInput) =>
    apiFetch<{ ok: true; agentId: string; amount: number; balanceAfter: number; transactionId: string }>(
      '/agent-recharges/manual-adjust',
      { method: 'POST', token, body },
    ),
};

// ── 房控导出 / 占房 / 余房（ADMIN/STAFF）── 独立命名空间，不改动上方既有 `api` /
// `agentRechargeApi` 对象字面量（并发改动风险，同 PaymentChannelWithAgent 一带的写法）。
// 对应 backend/src/modules/hotel-control/* 新增端点：
//   GET /hotel-control/export?from&to          房态导出（xlsx，销控矩阵原样导出，含「未配包房」标记）
//   GET /hotel-control/occupants?hotelId&date   占房下钻（某酒店某晚，谁占的）
//   GET /hotel-control/nightly-remaining?hotelRoomTypeId&checkIn&checkOut  当日余量（分房弹窗徽标）

/** GET /hotel-control/occupants 单条 —— 某酒店某晚的占房订单明细。 */
export interface HotelOccupant {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  contactName: string;
  passengerCount: number;
  /** 该订单出行人姓名（中文名优先，无则回落护照姓名；占位联系人不列）——房控核对分房用 */
  passengerNames: string[];
  /** 该占房行的间数（与销控板「用房」同口径） */
  rooms: number;
  checkIn: string; // YYYY-MM-DD（该行入住日）
  checkOut: string; // YYYY-MM-DD（该行退房日）
  agentName: string; // 无代理 = '直客'
}

/** GET /hotel-control/nightly-remaining —— 入住区间逐晚余量（原始数组，未汇总；由调用方按需汇总展示）。 */
export interface HotelNightlyRemainingResult {
  dates: string[]; // YYYY-MM-DD，[checkIn, checkOut) 逐晚
  remaining: number[]; // 与 dates 一一对应；block=0 的晚也会给出（=-used，调用方应据 block 判断是否可信）
  block: number[]; // 该晚包房周期覆盖的间数；0 = 未配置
  hasBlock: boolean; // false = 整段查询范围内一条包房周期都没有（remaining/block 为空数组）
}

export const hotelControlOpsApi = {
  /** 房态导出（xlsx）—— 销控矩阵原样导出；ADMIN/STAFF only。 */
  downloadBoardExport: async (token: string, range: { from: string; to: string }): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/hotel-control/export?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'EXPORT_FAILED', message: await res.text() });
    return res.blob();
  },

  /** 按酒店导出护照 zip：选酒店 + 入住日期区间，打包该酒店该期间入住客人的护照图；ADMIN/STAFF only。 */
  downloadHotelPassportsZip: async (
    token: string,
    params: { hotelId: string; from: string; to: string },
  ): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/hotel-control/passports.zip?hotelId=${encodeURIComponent(params.hotelId)}&from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new ApiError(res.status, { code: 'ZIP_FAILED', message: await res.text() });
    return res.blob();
  },

  /**
   * 按姓名批量导出护照 zip：不限酒店，按乘客姓名列表打包命中客人的护照图；
   * 可选 from/to 按出发日期（出发地本地日）过滤，zip 按出发日期分文件夹、按姓名命名文件；
   * ADMIN/STAFF only。
   */
  downloadHotelPassportsByNamesZip: async (
    token: string,
    params: { names: string[]; from?: string; to?: string },
  ): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/hotel-control/passports-by-names.zip`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // JSON.stringify 会丢弃 undefined 键 → 未填的日期不随请求发送
      body: JSON.stringify({ names: params.names, from: params.from, to: params.to }),
    });
    if (!res.ok) throw new ApiError(res.status, { code: 'ZIP_FAILED', message: await res.text() });
    return res.blob();
  },

  /** 占房下钻：某酒店某晚是谁占的（销控矩阵余量格点击用）。 */
  getHotelOccupants: (token: string, params: { hotelId: string; date: string }) =>
    apiFetch<{ occupants: HotelOccupant[] }>(
      `/hotel-control/occupants?hotelId=${encodeURIComponent(params.hotelId)}&date=${encodeURIComponent(params.date)}`,
      { token },
    ),

  /** 当日余房：给定房型 + 入住区间，逐晚余量（分房弹窗徽标用；ADMIN/STAFF 回原始数字，与公开端点的档位口径不同）。 */
  getNightlyRemaining: (
    token: string,
    params: { hotelRoomTypeId: string; checkIn: string; checkOut: string },
  ) =>
    apiFetch<HotelNightlyRemainingResult>(
      `/hotel-control/nightly-remaining?hotelRoomTypeId=${encodeURIComponent(params.hotelRoomTypeId)}&checkIn=${encodeURIComponent(params.checkIn)}&checkOut=${encodeURIComponent(params.checkOut)}`,
      { token },
    ),
};
