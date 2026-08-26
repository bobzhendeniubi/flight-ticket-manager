/**
 * 单笔录单弹窗（按产品类型）—— 运营手工录一笔订单。
 *
 * 流程：选产品类型（机票 / 酒店 / 签证 / 套餐 / 接送）→ 填该类型字段
 *      → 选归属代理（或直客）→ 填出行人 + 备注 → 提交 POST /orders。
 *
 * 价格：表单只送产品引用 + 数量/占座，服务端按产品权威重算（HOTEL/VISA/TRANSFER 后端定价、
 *      BUNDLE/FLIGHT 后端重算），因此 HOTEL/VISA/TRANSFER/BUNDLE 行的 unitPrice 一律占位 0。
 *
 * 与「批量创单」并存：批量创单服务票务整班散客；本弹窗服务单笔多产品类型录单。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  duplicatePassengerConflictOrderNumbers,
  hotelControlOpsApi,
  randomStarTierLabel,
  poolOptionValue,
  poolTierFromOptionValue,
  RANDOM_STAR_TIERS,
  type AdminFlight,
  type AdminSchedule,
  type AgentListItem,
  type AiOcrPassportResult,
  type Bundle,
  type CabinClass,
  type CreateOrderInput,
  type CreateOrderItemInput,
  type Hotel,
  type HotelAvailabilityTier,
  type HotelNightlyRemainingResult,
  type OrderPassengerInput,
  type OrderSummary,
  type RoomGroup,
  type PriceAdjustmentReason,
  type QuoteOrderResult,
  type SettlementTier,
  type Transfer,
  type TravelerProfileSuggestion,
  type Visa,
  type VisaStatusInput,
  PRICE_ADJUSTMENT_REASON_LABEL,
  PRICE_ADJUSTMENT_REASON_OPTIONS,
  VISA_STATUS_LABEL,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from './NumberInput';
import { Icon, type IconName } from './Icon';
import { PassengerSuggestInput } from './PassengerSuggestInput';
import { ProofImageViewer } from './ProofImageViewer';
import { RoomingEditor, type RoomingPassenger } from './RoomingEditor';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';
import { useDialogA11y } from './Modal';
import { formatLocalTime } from '../lib/airports';
import { composePassengerFullName, normalizePassengerFullName } from '../lib/passengerName';

// ── 产品类型 ──────────────────────────────────────────────────────────
type ProductKind = 'FLIGHT' | 'HOTEL' | 'VISA' | 'BUNDLE' | 'TRANSFER';

const KIND_TABS: Array<{ kind: ProductKind; label: string; icon: IconName }> = [
  { kind: 'FLIGHT', label: '机票', icon: 'plane' },
  { kind: 'HOTEL', label: '酒店', icon: 'hotel' },
  { kind: 'VISA', label: '签证', icon: 'visa' },
  { kind: 'BUNDLE', label: '套餐', icon: 'gift' },
  { kind: 'TRANSFER', label: '接送', icon: 'car' },
];

const CABIN_ZH: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

// 结算价档次中文名（与 SettlementRatesPage / ProductsPage 同一份口径）。
const SETTLEMENT_TIER_ZH: Record<SettlementTier, string> = {
  CITY_3STAR: '市区三星',
  CITY_4STAR: '市区四星',
  CITY_5STAR: '市区五星',
  INTL_5STAR: '国际五星',
};

// 结算价档次 → 对应星级（用于套餐「指定酒店」星级错配提醒）。
// ⚠️ INTL_5STAR 与 CITY_5STAR 都对应 5 星——随机档只分 3/4/5 星，没有单独的「国际五星」随机档，
// 这是已知口径缺口，这里按 5 星比对，不发明新档次。
const SETTLEMENT_TIER_STAR: Record<SettlementTier, number> = {
  CITY_3STAR: 3,
  CITY_4STAR: 4,
  CITY_5STAR: 5,
  INTL_5STAR: 5,
};

// FLIGHT / BUNDLE / VISA 必须填出行人；纯 HOTEL / TRANSFER 出行人选填。
const PASSENGERS_REQUIRED: Record<ProductKind, boolean> = {
  FLIGHT: true,
  BUNDLE: true,
  VISA: true,
  HOTEL: false,
  TRANSFER: false,
};

// 签证状态默认值按产品类型派生（反馈：单机票/纯酒店/纯接送不可能需要签证台跟进）：
// 签证 / 套餐本身涉及签证 → 默认「需要」；机票 / 酒店 / 接送 → 默认「不需要」。
// 仅作为「未手动改过」时的跟随默认值，见 visaStatusTouchedRef。
const DEFAULT_VISA_STATUS: Record<ProductKind, VisaStatusInput> = {
  FLIGHT: 'NOT_NEEDED',
  HOTEL: 'NOT_NEEDED',
  TRANSFER: 'NOT_NEEDED',
  BUNDLE: 'NEEDED',
  VISA: 'NEEDED',
};

// 护照图上限（一单）：每张存库 base64 约 0.7–1MB，后端单次请求上限 25MB，留足余量取 20。
// 既在界面写明，也在「批量传护照 / 单张 OCR」两处强制；超出请分单录入。
const MAX_PHOTO_PASSENGERS = 20;
// 批量识别并发：一次最多同时打 3 张，避免 OCR 服务商按 key 限流（429）。
const BULK_OCR_CONCURRENCY = 3;

// ── 出行人行 ──────────────────────────────────────────────────────────
interface PassengerRow {
  fullName: string;
  documentNumber: string;
  dateOfBirth: string; // 原始输入，提交时解析为 ISO
  /** 中文姓名（可选；OCR 填写或手动输入） */
  chineseName?: string;
  /** 性别 M/F/X（可选；OCR 识别带出或手选，随乘客提交给后端） */
  gender?: 'M' | 'F' | 'X';
  /** 护照签发日期 YYYY-MM-DD（可选；OCR 填写或手动输入） */
  passportIssueDate?: string;
  /** 护照签发地点（自由文本，城市/机关；可选；OCR 填写或手动输入）。区别于 ISO-2 签发国。 */
  passportIssuePlace?: string;
  /** 护照有效期 YYYY-MM-DD（可选；OCR 填写或手动输入） */
  passportExpiry?: string;
  // 签证出签日/生效日/有效期不在此录入：这三项是签证岗出签后才拿得到的信息，录单时无法
  // 预先知道（票务岗反馈：录单时不需要），改由签证台在出签后补录（PATCH .../visa-dates）。
  /** 护照图 base64 data URL（OCR 识别后存入，随乘客一起提交给后端） */
  passportPhotoUrl?: string;
  // ── 套餐乘客级选项（购物车模式：每人各选自己的住宿方式 + 签证；价差全部系统算）──
  /** 客人自备签证（无需送签；套餐价按人扣减 selfVisaDeductCny）。缺省 false = 随套餐办签。 */
  visaExempt?: boolean;
  /** 单住（不拼房，按人收单房差）。缺省 false = 拼房。 */
  singleRoom?: boolean;
  /** OCR 识别进度 0-100；null = 未识别 */
  ocrPct?: number | null;
  /** OCR 识别阶段描述 */
  ocrStage?: string;
  /** OCR 引擎标签：'ai' | 'local' | 'ai-fallback' | null */
  ocrEngine?: 'ai' | 'local' | 'ai-fallback' | null;
  /** true = 本次识别失败，行下显示明确错误提示 */
  ocrFailed?: boolean;
  /** AI 识别时使用的模型名 */
  ocrModel?: string | null;
  /**
   * AI OCR 校验结果：需要人工核对的字段（field 为 PassengerRow 键名，reason 为提示文案）。
   * 仅 AI 识别路径（POST /ocr/passport 返回 verify）回填；用户手动改动某字段后会从此列表移除。
   */
  reviewFields?: Array<{ field: string; reason: string }>;
  /** 护照 MRZ（机读区）校验是否通过；false = 未通过，提示语气升级；undefined/null = 无 MRZ 信息（本地识别）。 */
  mrzValid?: boolean | null;
  /** 本地 Tesseract 兜底识别提示：精度有限，整行核对（AI 未配置或识别失败走本地时置位）。 */
  localOcrCaveat?: boolean;
}

/** OCR 校验字段名 → 中文标签（覆盖后端 verify.reviewFields 可能出现的全部字段名） */
const OCR_FIELD_LABELS: Record<string, string> = {
  fullName: '姓名',
  lastName: '姓',
  firstName: '名',
  chineseName: '中文姓名',
  documentNumber: '护照号',
  dateOfBirth: '出生日期',
  gender: '性别',
  nationality: '国籍',
  passportIssueCountry: '签发国',
  passportExpiry: '护照有效期',
  passportIssueDate: '护照签发日期',
  passportIssuePlace: '护照签发地点',
  placeOfBirth: '出生地',
};

/** 出行人表格里实际存在输入框、可高亮警示的字段（PassengerRow 键名）。 */
const OCR_HIGHLIGHTABLE_FIELDS = new Set([
  'fullName',
  'chineseName',
  'documentNumber',
  'dateOfBirth',
  'gender',
  'passportIssueDate',
  'passportIssuePlace',
  'passportExpiry',
]);

/** 该行是否有某字段的 AI 核对警示（表格里存在的字段才高亮，避免高亮不存在的输入框）。 */
function hasFieldReview(p: PassengerRow, field: string): boolean {
  if (!OCR_HIGHLIGHTABLE_FIELDS.has(field)) return false;
  return Boolean(p.reviewFields?.some((r) => r.field === field));
}

/** 出行人行下方的紧凑提示文案；无需提示返回 null。 */
function ocrReviewHint(p: PassengerRow): string | null {
  if (p.ocrFailed && p.ocrStage) return p.ocrStage;
  if (p.reviewFields && p.reviewFields.length > 0) {
    const prefix =
      p.mrzValid === false ? '护照机读区未能校验，请逐项核对：' : 'AI 识别建议人工核对：';
    const items = p.reviewFields.map(
      (r) => `${OCR_FIELD_LABELS[r.field] ?? r.field}（${r.reason}）`,
    );
    return `${prefix}${items.join('、')}`;
  }
  if (p.localOcrCaveat) {
    return '本地识别精度有限，请逐项核对';
  }
  return null;
}

const emptyPassenger = (): PassengerRow => ({ fullName: '', documentNumber: '', dateOfBirth: '' });

/** 宽松生日解析 → YYYY-MM-DD；接受 1990-01-01 / 1990/1/1 / 1990.1.1，非法返回 null。 */
function parseDob(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 入住→退房晚数；非正返回 0。 */
function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  const diff = Math.round((b.getTime() - a.getTime()) / 86400_000);
  return diff > 0 ? diff : 0;
}

// ── 套餐航段自动派生（去程/回程班次按出发日期匹配；时间按澳门时区显示）──────
// 套餐固定航线：去程 MFM→DAD（澳门→岘港），回程 DAD→MFM（岘港→澳门，QH9588）。
const BUNDLE_GO_ORIGIN = 'MFM';
const BUNDLE_GO_DEST = 'DAD';

/** 套餐未配置 hotelNights 且无 HOTEL 组件时的兜底晚数（与后端 bundle-nights.ts 一致）。 */
const DEFAULT_BUNDLE_NIGHTS = 1;

/** 同一航线上合并拉取多个航班班次时的并发上限，避免航班数多时一次性打爆 /flights/:id/schedules 触发限流（100/分钟）。 */
const SCHEDULE_FETCH_CONCURRENCY = 5;

/** 分批（限并发）拉取多个航班的班次并合并成一份列表；单个航班拉取失败不阻断其余航班。 */
async function fetchSchedulesMerged(
  token: string,
  flightIds: string[],
): Promise<AdminSchedule[]> {
  const merged: AdminSchedule[] = [];
  for (let i = 0; i < flightIds.length; i += SCHEDULE_FETCH_CONCURRENCY) {
    const batch = flightIds.slice(i, i + SCHEDULE_FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) => api.listSchedules(token, id).catch(() => ({ schedules: [] as AdminSchedule[] }))),
    );
    merged.push(...results.flatMap((r) => r.schedules));
  }
  return merged;
}

/** 从 Bundle.items 取第一个 HOTEL 组件的 qty（即真实住宿晚数）；找不到返回 null。 */
function firstHotelQty(items: ReadonlyArray<{ kind: string; qty: number }>): number | null {
  for (const it of items) {
    if (it.kind !== 'HOTEL') continue;
    if (typeof it.qty !== 'number' || !Number.isFinite(it.qty)) continue;
    const qty = Math.trunc(it.qty);
    if (qty >= 1) return qty;
  }
  return null;
}

/**
 * 套餐住宿晚数唯一权威口径（port of backend bundle-nights.resolveBundleNights）：
 *   hotelNights 显式配置 → 用之（≥1 保底）；否则第一个 HOTEL 组件 qty；再否则兜底。
 * 返回恒为整数且 ≥1。
 */
function resolveBundleNights(
  items: ReadonlyArray<{ kind: string; qty: number }>,
  hotelNights: number | null,
): number {
  const explicit =
    typeof hotelNights === 'number' && Number.isFinite(hotelNights) ? Math.trunc(hotelNights) : null;
  const raw = explicit ?? firstHotelQty(items) ?? DEFAULT_BUNDLE_NIGHTS;
  return Math.max(1, raw);
}

/**
 * 班次 departureTime 是 UTC ISO；departureTz 决定它属于哪一"天"。
 * 用 Intl parts 取本地年月日（en-CA → YYYY-MM-DD），跟 formatLocalDate 同口径，
 * 避免 UTC slice 跨日错位（08:40 vs 16:40 那类时区 bug 的根因）。
 */
function localYmd(iso: string, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(iso));
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** departDate（YYYY-MM-DD）+ 晚数 → 退房/回程日期（YYYY-MM-DD）。 */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** 余位可能为负（超售口径不再钳 0），负数按「超售 N」展示，避免误读为可售。 */
function cabinAvailText(available: number): string {
  if (available > 0) return `余 ${available}`;
  if (available === 0) return '售罄';
  return `超售 ${-available}`;
}

interface SingleOrderModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function SingleOrderModal({ onClose, onCreated }: SingleOrderModalProps) {
  const tokens = useAuth((s) => s.tokens);
  const dialogRef = useDialogA11y(onClose);
  const user = useAuth((s) => s.user);
  const token = tokens?.accessToken ?? '';
  const recorderLabel = user?.displayName || user?.email || '当前账号';

  const [kind, setKind] = useState<ProductKind>('FLIGHT');

  // 联系人（选填；缺省默认=录入人本人，后端缺联系人时也会回退到录入人）
  const [contactName, setContactName] = useState(recorderLabel);
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');

  // 归属代理（ADMIN/STAFF 代为录单）；'' = 直客/无代理
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentId, setAgentId] = useState('');

  const [notes, setNotes] = useState('');
  // 签证状态 + 结构化备注（酒店/签证/付款/特殊要求）
  // 默认值按当前产品类型派生（见 DEFAULT_VISA_STATUS）；用户手动改过下拉后，
  // 由 visaStatusTouchedRef 记住，kind 再切换也不会覆盖用户的手动选择。
  const [visaStatus, setVisaStatus] = useState<VisaStatusInput>(() => DEFAULT_VISA_STATUS[kind]);
  const visaStatusTouchedRef = useRef(false);
  const [noteHotel, setNoteHotel] = useState('');
  const [noteVisa, setNoteVisa] = useState('');
  const [notePayment, setNotePayment] = useState('');
  const [noteSpecial, setNoteSpecial] = useState('');
  const [passengers, setPassengers] = useState<PassengerRow[]>([emptyPassenger()]);
  // 最新乘客快照（ref）：批量并发 OCR 时，handleOcrFile 的「护照图上限」要读实时状态，
  // 不能用渲染闭包里的 passengers（并发 worker 之间会读到陈旧值，导致少计/超计）。
  const passengersRef = useRef<PassengerRow[]>(passengers);
  useEffect(() => {
    passengersRef.current = passengers;
  }, [passengers]);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okOrderNumber, setOkOrderNumber] = useState<string | null>(null);
  // 录单成功的订单（含 id + 出行人）→ 录单后分房用；null = 未创建/已跳过
  const [createdOrder, setCreatedOrder] = useState<OrderSummary | null>(null);
  // 是否进入「录单后分房」步骤（默认进；可跳过稍后在房控页分）
  const [showRooming, setShowRooming] = useState(false);
  const [roomingSaved, setRoomingSaved] = useState(false);

  // 每位乘客一个隐藏 file input（OCR）；用 index 区分
  const ocrInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  // 批量护照：一个多选 file input + 总进度（{done,total}；null = 未在跑）
  const bulkOcrInputRef = useRef<HTMLInputElement | null>(null);
  const [bulkOcr, setBulkOcr] = useState<{ done: number; total: number } | null>(null);

  // 幂等键：同一次提交（含双击/重试）只入账一次；成功后换新键
  const makeIdemKey = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `so-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const [idemKey, setIdemKey] = useState(makeIdemKey);

  // ── 系统价试算（quote）+ 录单调价/加项 ────────────────────────────────
  // 系统价：填完产品/人数后向后端 /orders/quote 试算权威价（只算不落库），提交前展示。
  const [quoteTotal, setQuoteTotal] = useState<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [settlementPreview, setSettlementPreview] = useState<QuoteOrderResult['settlementPreview']>(null);
  // 调价：金额（CNY，整数，可正可负）+ 原因（下拉）+ 其它说明。空/0 = 不调整（不发该字段）。
  const [adjustAmount, setAdjustAmount] = useState<number | null>(null);
  const [adjustReason, setAdjustReason] = useState<PriceAdjustmentReason>('DISCOUNT');
  const [adjustText, setAdjustText] = useState('');
  // 本单结算总价（仅 ADMIN/STAFF 可见；提交为 settlementTotalCny）：代理单一口价，系统照此收钱。
  // 服务端按「结算价 − 权威合计」自动生成一条「代理结算价」（SETTLEMENT）差额行——不改任何
  // 明细行价格，原价/差额留痕可审计。与下方手工「调整金额」互斥（服务端 400，前端也阻断提交）。
  const [settlementPrice, setSettlementPrice] = useState<number | null>(null);

  // ── 机票 ──
  // 单程 / 往返：往返时出港 + 回程各生成一条 FLIGHT 行（同一批出行人，人数不翻倍）。
  const [flightTripType, setFlightTripType] = useState<'ONEWAY' | 'ROUNDTRIP'>('ONEWAY');
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [flightId, setFlightId] = useState('');
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [cabin, setCabin] = useState<CabinClass | ''>('');
  // 出港「起飞日期（可手输）」：先选/手输日期，再从当日班次里挑，避免班次下拉过长。留空=全部班次。
  const [flightDate, setFlightDate] = useState('');
  // 回程航段（仅往返）：可与出港不同航班/日期/舱位，各自生成一条 FLIGHT 行。
  const [returnFlightId, setReturnFlightId] = useState('');
  const [returnSchedules, setReturnSchedules] = useState<AdminSchedule[]>([]);
  const [returnScheduleId, setReturnScheduleId] = useState('');
  const [returnCabin, setReturnCabin] = useState<CabinClass | ''>('');
  const [returnDate, setReturnDate] = useState('');

  // ── 酒店 ──
  // hotelId 也可以是星级随机池的哨兵值（见 poolOptionValue）——客人买「N 星随机」，
  // 下单时不指定酒店，占房控的星级随机池库存，之后由房控落到具体酒店。
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelId, setHotelId] = useState('');
  const [roomTypeId, setRoomTypeId] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [rooms, setRooms] = useState<number | null>(1);
  // 星级随机池行没有房型可查价 → 运营手录每间每晚售价（与「无产品 id 的地面行」同一条既有口径）
  const [poolNightlyPrice, setPoolNightlyPrice] = useState<number | null>(null);

  // ── 签证 ──
  const [visas, setVisas] = useState<Visa[]>([]);
  const [visaId, setVisaId] = useState('');
  const [visaQty, setVisaQty] = useState<number | null>(1);
  // 加急档名（'' = 不加急）。只存档名，加价金额一律服务端按产品的加急档位表查出。
  const [visaExpressTierLabel, setVisaExpressTierLabel] = useState('');

  // ── 套餐 ──
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [bundleId, setBundleId] = useState('');
  const [departDate, setDepartDate] = useState('');
  const [adultCount, setAdultCount] = useState<number | null>(1);
  const [childCount, setChildCount] = useState<number | null>(0);
  const [infantCount, setInfantCount] = useState<number | null>(0);
  // 商务舱升级人数，去程 / 回程各一份，各自范围 0..(成人+儿童)。
  // 拆两程的原因：同一批客人常常只升去程（回程留经济舱），或去回程升的人数不同 ——
  // 旧的单值口径按「两程同人数」收钱，只升去程的单会多收一程。单程套餐只显示去程。
  // 单住 / 自备签已改为「乘客级」（购物车模式，每人各选，见出行人表的两列）——不再有整单聚合状态。
  const [businessCountOutbound, setBusinessCountOutbound] = useState<number | null>(0);
  const [businessCountReturn, setBusinessCountReturn] = useState<number | null>(0);
  // 指定酒店（0805）：套餐按「星级随机」报价，客人点名住某店 → 选该店 + 房型，服务端按该店
  // 配置的「指定酒店加价 ¥/人」×占座人数加收；'' = 不指定（走套餐绑定房型/随机现状）。
  const [designatedHotelId, setDesignatedHotelId] = useState('');
  const [designatedRoomTypeId, setDesignatedRoomTypeId] = useState('');
  // 套餐机票航段：优先按套餐绑定的航班号；未绑定且同路线仅一个在飞航班时自动派生；
  // 未绑定且同路线有多个在飞航班时，由运营手选航班号（下方两个状态）。
  // 均先预拉两个方向的全部班次池，再按航班号 + 本地出发日期匹配去程（MFM→DAD）/回程（DAD→MFM）。
  const [bundleGoSchedulePool, setBundleGoSchedulePool] = useState<AdminSchedule[]>([]);
  const [bundleRetSchedulePool, setBundleRetSchedulePool] = useState<AdminSchedule[]>([]);
  // 运营手选的去程/回程航班号（仅「未绑定 + 多个候选航班」场景需要；空 = 未选）。
  const [bundleGoFlightId, setBundleGoFlightId] = useState('');
  const [bundleRetFlightId, setBundleRetFlightId] = useState('');

  // ── 接送 ──
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [transferId, setTransferId] = useState('');
  const [transferDate, setTransferDate] = useState('');
  const [transferQty, setTransferQty] = useState<number | null>(1);

  // 切换产品类型时，若用户没手动改过签证状态下拉，自动跟随新 kind 的默认值
  // （如从「套餐」切到「机票」，未手动改过则从「需要」自动回落到「不需要」）；
  // 一旦用户手动改过下拉，touched 记住这次选择，后续再切 kind 也不会覆盖。
  // 注：乘客级「自备签」是逐位定价项，不再联动订单级签证状态——部分乘客自备签不代表整单不需要送签。
  useEffect(() => {
    if (visaStatusTouchedRef.current) return;
    setVisaStatus(DEFAULT_VISA_STATUS[kind]);
  }, [kind]);

  // 代理列表（ADMIN/STAFF/AGENT 都能拉自己可见的代理；用于归属选择）
  useEffect(() => {
    if (!token) return;
    api
      .listAgents(token)
      .then((r) => setAgents(r.agents))
      .catch(() => undefined); // 无代理可选不致命
  }, [token]);

  // 机票/套餐：航班列表（机票 tab 与套餐机票航段共用）
  useEffect(() => {
    if (!token || (kind !== 'FLIGHT' && kind !== 'BUNDLE') || flights.length > 0) return;
    api.listAllFlights(token).then((r) => setFlights(r.flights)).catch(() => setErr('航班列表加载失败'));
  }, [token, kind, flights.length]);

  // 机票：选航班后拉班次
  useEffect(() => {
    if (!token || !flightId) {
      setSchedules([]);
      setScheduleId('');
      return;
    }
    api.listSchedules(token, flightId).then((r) => setSchedules(r.schedules)).catch(() => setErr('班次加载失败'));
  }, [token, flightId]);

  // 机票（往返）：选回程航班后拉回程班次
  useEffect(() => {
    if (!token || !returnFlightId) {
      setReturnSchedules([]);
      setReturnScheduleId('');
      return;
    }
    api.listSchedules(token, returnFlightId).then((r) => setReturnSchedules(r.schedules)).catch(() => setErr('回程班次加载失败'));
  }, [token, returnFlightId]);

  // 套餐机票航段：选了套餐 + 航班列表就绪后，预拉两个方向（去程 MFM→DAD / 回程 DAD→MFM）
  // 的全部班次池；后续按「出发日期」本地日期匹配派生具体班次。
  // 注意：同一航线上可能有多家航空公司的在飞航班，必须合并所有匹配航班的班次，
  // 不能只取第一条命中航班——否则该航线上其余航空公司的班次会被漏查，
  // 出现"某月份明明有班次却提示没有匹配班次"的假阴性（取决于航班列表返回顺序）。
  useEffect(() => {
    if (!token || kind !== 'BUNDLE' || !bundleId || flights.length === 0) {
      setBundleGoSchedulePool([]);
      setBundleRetSchedulePool([]);
      return;
    }
    const goFlights = flights.filter(
      (f) => f.isActive && f.originCode === BUNDLE_GO_ORIGIN && f.destinationCode === BUNDLE_GO_DEST,
    );
    const retFlights = flights.filter(
      (f) => f.isActive && f.originCode === BUNDLE_GO_DEST && f.destinationCode === BUNDLE_GO_ORIGIN,
    );
    if (goFlights.length > 0) {
      fetchSchedulesMerged(token, goFlights.map((f) => f.id))
        .then(setBundleGoSchedulePool)
        .catch(() => setErr('去程班次加载失败'));
    } else {
      setBundleGoSchedulePool([]);
    }
    if (retFlights.length > 0) {
      fetchSchedulesMerged(token, retFlights.map((f) => f.id))
        .then(setBundleRetSchedulePool)
        .catch(() => setErr('回程班次加载失败'));
    } else {
      setBundleRetSchedulePool([]);
    }
  }, [token, kind, bundleId, flights]);

  // 切换套餐后清空运营手选的航班号：不同套餐的绑定/候选航班不同，避免带入上一套餐的选择。
  useEffect(() => {
    setBundleGoFlightId('');
    setBundleRetFlightId('');
  }, [bundleId]);

  // 酒店列表
  useEffect(() => {
    // 套餐 tab 也要酒店列表：指定酒店下拉（0805）。
    if ((kind !== 'HOTEL' && kind !== 'BUNDLE') || hotels.length > 0) return;
    api.listHotels(false).then((r) => setHotels(r.hotels)).catch(() => setErr('酒店列表加载失败'));
  }, [kind, hotels.length]);

  // 签证列表
  useEffect(() => {
    if (kind !== 'VISA' || visas.length > 0) return;
    api.listVisas(false).then((r) => setVisas(r.visas)).catch(() => setErr('签证列表加载失败'));
  }, [kind, visas.length]);

  // 套餐列表
  useEffect(() => {
    if (kind !== 'BUNDLE' || bundles.length > 0) return;
    api.listBundles(false).then((r) => setBundles(r.bundles)).catch(() => setErr('套餐列表加载失败'));
  }, [kind, bundles.length]);

  // 接送列表
  useEffect(() => {
    if (kind !== 'TRANSFER' || transfers.length > 0) return;
    api.listTransfers(false).then((r) => setTransfers(r.transfers)).catch(() => setErr('接送列表加载失败'));
  }, [kind, transfers.length]);

  const flight = flights.find((f) => f.id === flightId);
  const schedule = schedules.find((s) => s.id === scheduleId);
  const cabinOptions = schedule?.seatClasses ?? [];
  const returnFlight = flights.find((f) => f.id === returnFlightId);
  const returnSchedule = returnSchedules.find((s) => s.id === returnScheduleId);
  const returnCabinOptions = returnSchedule?.seatClasses ?? [];
  // 按「起飞日期」过滤班次（本地日期与下拉展示口径一致：localYmd）；日期留空则显示全部。
  const schedulesForDate = useMemo(
    () => (flightDate ? schedules.filter((s) => localYmd(s.departureTime, s.departureTz) === flightDate) : schedules),
    [schedules, flightDate],
  );
  const returnSchedulesForDate = useMemo(
    () => (returnDate ? returnSchedules.filter((s) => localYmd(s.departureTime, s.departureTz) === returnDate) : returnSchedules),
    [returnSchedules, returnDate],
  );
  const hotel = hotels.find((h) => h.id === hotelId);
  const roomType = hotel?.roomTypes.find((rt) => rt.id === roomTypeId);
  /** 当前酒店下拉选中的是星级随机池时的档次；选的是真实酒店 → null。 */
  const poolTier = poolTierFromOptionValue(hotelId);
  const visa = visas.find((v) => v.id === visaId);
  // 该签证产品配置的加急档位（未配 = 空数组 → 不显示加急下拉，行为与扩展前一致）。
  const visaExpressTiers = visa?.expressTiers ?? [];
  const bundle = bundles.find((b) => b.id === bundleId);

  // 套餐「指定酒店」下拉分组：真实酒店 / 星级随机档占位酒店（randomTierPlaceholder != null）。
  // 占位酒店不从列表里删——服务端显式支持指到占位酒店（房量闸走随机档聚合闸），删了会弄坏
  // 存量落位流程；这里只做分组 + 选中时提醒，见下方 designatedHotelIsPlaceholder。
  const bundleRealHotels = useMemo(() => hotels.filter((h) => h.randomTierPlaceholder == null), [hotels]);
  const bundlePlaceholderHotels = useMemo(() => hotels.filter((h) => h.randomTierPlaceholder != null), [hotels]);
  const designatedHotel = hotels.find((h) => h.id === designatedHotelId);
  const designatedHotelIsPlaceholder = designatedHotel?.randomTierPlaceholder != null;
  // 套餐结算档次对应的星级（CITY_3STAR→3 / CITY_4STAR→4 / CITY_5STAR→5 / INTL_5STAR→5）；
  // 套餐不走结算价日历（settlementTier 为空）时为 null，不显示档次、也不比对星级。
  const bundleSettlementStar = bundle?.settlementTier ? SETTLEMENT_TIER_STAR[bundle.settlementTier] : null;
  // 指定了真实酒店（非占位）且星级与套餐档次不一致 → 非阻断提醒，不拦提交。
  const designatedHotelStarMismatch =
    !designatedHotelIsPlaceholder &&
    designatedHotel != null &&
    bundleSettlementStar != null &&
    designatedHotel.starRating !== bundleSettlementStar;

  // 换签证产品 → 清掉上一个产品的加急档选择（各产品档位表不同，档名残留会被服务端拒单）。
  useEffect(() => {
    setVisaExpressTierLabel('');
  }, [visaId]);

  const transfer = transfers.find((t) => t.id === transferId);

  // 套餐 SearchSelect 选项：label 有编号时带 `[code] name`，方便按编号搜；
  // priceLabel 用折后起价/人 = originalPerPaxCny ×(1−discountPct/100)，与套餐页卡片「¥X 起/人」
  // 口径一致（原价 originalPerPaxCny 本身不是「起价」，起价已经折过）。
  const bundleSelectOptions: SearchSelectOption[] = useMemo(
    () =>
      bundles.map((b) => ({
        id: b.id,
        label: b.code ? `[${b.code}] ${b.name}` : b.name,
        priceLabel: String(Math.round((b.originalPerPaxCny ?? 0) * (1 - (b.discountPct ?? 0) / 100))),
      })),
    [bundles],
  );

  // 套餐是否往返（legs≥2）：决定要不要派生回程航段。
  const bundleIsRoundTrip = (bundle?.legs ?? 2) >= 2;

  // 同路线在飞候选航班（去程 MFM→DAD / 回程 DAD→MFM）：用于「未绑定航班号」时判断是否需运营手选。
  const bundleGoFlights = useMemo(
    () =>
      kind === 'BUNDLE'
        ? flights.filter(
            (f) => f.isActive && f.originCode === BUNDLE_GO_ORIGIN && f.destinationCode === BUNDLE_GO_DEST,
          )
        : [],
    [kind, flights],
  );
  const bundleRetFlights = useMemo(
    () =>
      kind === 'BUNDLE'
        ? flights.filter(
            (f) => f.isActive && f.originCode === BUNDLE_GO_DEST && f.destinationCode === BUNDLE_GO_ORIGIN,
          )
        : [],
    [kind, flights],
  );

  // 该套餐去程/回程是否需要运营手选航班号：未绑定 + 同路线有 ≥2 个在飞航班时才需要。
  const bundleGoNeedsPick = !!bundle && !bundle.outboundFlight && bundleGoFlights.length >= 2;
  const bundleRetNeedsPick =
    !!bundle && bundleIsRoundTrip && !bundle.returnFlight && bundleRetFlights.length >= 2;

  // 去程/回程最终采用的航班号 id（唯一权威口径）：
  //   ① 套餐已绑定航班号 → 用绑定（忽略同路线其它航班）；
  //   ② 未绑定且仅一个候选 → 自动用该候选（不打扰运营）；
  //   ③ 未绑定且多个候选 → 用运营手选（未选则 null，界面提示先选）；
  //   ④ 无候选 → null（下方派生为空 → 提示无匹配班次）。
  const bundleGoFlightIdResolved = useMemo<string | null>(() => {
    if (!bundle) return null;
    if (bundle.outboundFlight) return bundle.outboundFlight.id;
    if (bundleGoFlights.length === 1) return bundleGoFlights[0].id;
    if (bundleGoFlights.length >= 2) return bundleGoFlightId || null;
    return null;
  }, [bundle, bundleGoFlights, bundleGoFlightId]);
  const bundleRetFlightIdResolved = useMemo<string | null>(() => {
    if (!bundle || !bundleIsRoundTrip) return null;
    if (bundle.returnFlight) return bundle.returnFlight.id;
    if (bundleRetFlights.length === 1) return bundleRetFlights[0].id;
    if (bundleRetFlights.length >= 2) return bundleRetFlightId || null;
    return null;
  }, [bundle, bundleIsRoundTrip, bundleRetFlights, bundleRetFlightId]);

  // 套餐航段自动派生：出发日期 → 去程班次（已定航班号 + 本地日期 == departDate）；
  // 晚数 → 回程日期 → 回程班次（已定航班号 + 本地日期 == returnDate）。仅往返套餐派生回程。
  // 关键：只在池子里挑 flightId == 已定航班号 的班次，绝不盲取同路线第一班。
  const bundleLegs = useMemo(() => {
    if (!bundle || !departDate) {
      return { go: null as AdminSchedule | null, ret: null as AdminSchedule | null, returnDate: '' };
    }
    const go = bundleGoFlightIdResolved
      ? bundleGoSchedulePool
          .filter(
            (s) =>
              s.isActive &&
              s.flightId === bundleGoFlightIdResolved &&
              localYmd(s.departureTime, s.departureTz) === departDate,
          )
          .sort((a, b) => a.departureTime.localeCompare(b.departureTime))[0] ?? null
      : null;
    const nights = resolveBundleNights(bundle.items, bundle.hotelNights);
    const returnDate = bundleIsRoundTrip ? addDays(departDate, nights) : '';
    const ret =
      bundleIsRoundTrip && bundleRetFlightIdResolved
        ? bundleRetSchedulePool
            .filter(
              (s) =>
                s.isActive &&
                s.flightId === bundleRetFlightIdResolved &&
                localYmd(s.departureTime, s.departureTz) === returnDate,
            )
            .sort((a, b) => a.departureTime.localeCompare(b.departureTime))[0] ?? null
        : null;
    return { go, ret, returnDate };
  }, [
    bundle,
    departDate,
    bundleIsRoundTrip,
    bundleGoSchedulePool,
    bundleRetSchedulePool,
    bundleGoFlightIdResolved,
    bundleRetFlightIdResolved,
  ]);

  const filteredAgents = useMemo(() => {
    const q = agentSearch.trim().toLowerCase();
    if (!q) return agents.slice(0, 50);
    return agents
      .filter(
        (a) =>
          (a.companyName?.toLowerCase().includes(q) ?? false) ||
          a.contactName.toLowerCase().includes(q) ||
          a.contactPhone.includes(q) ||
          (a.email?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 50);
  }, [agents, agentSearch]);

  const passengersRequired = PASSENGERS_REQUIRED[kind];
  const validPassengers = passengers.filter(
    (p) => p.fullName.trim() && p.documentNumber.trim() && parseDob(p.dateOfBirth),
  );

  // ── 套餐乘客级「住宿方式 + 签证」（购物车模式）──
  // 住宿列：套餐单都显示；签证列：仅当所选套餐配了自备签减免额（selfVisaDeductCny>0）才显示
  //   （否则自备签不产生价差，展示无意义，与旧整单勾选框的显示条件一致）。
  const showRoomingCol = kind === 'BUNDLE';
  const showVisaExemptCol = kind === 'BUNDLE' && (bundle?.selfVisaDeductCny ?? 0) > 0;
  // 出行人表格总列数（姓名/护照号/出生日期/中文姓名/性别/签发日期/签发地点/有效期/护照图/操作 10 列 +
  //   可选的住宿/签证列）；AI 核对提示行需要 colSpan 撑满整行。
  const passengerColCount = 10 + (showRoomingCol ? 1 : 0) + (showVisaExemptCol ? 1 : 0);
  // 派生勾选人数（驱动系统价试算重算 + 描述/明细展示）：以行标记为准。
  const singleRoomCount = passengers.filter((p) => p.singleRoom).length;
  const visaExemptCount = passengers.filter((p) => p.visaExempt).length;
  // 每人构成小字用的费率（展示口径，与后端 computeBundleAddOn 一致）：
  //   单房差/人 = singleSupplementCnyPerNight × 套餐晚数；自备签减免/人 = selfVisaDeductCny。
  const bundleNightsForHint = bundle ? resolveBundleNights(bundle.items, bundle.hotelNights) : 0;
  const singleSupplementPerPax = bundle ? (bundle.singleSupplementCnyPerNight ?? 0) * bundleNightsForHint : 0;
  const selfVisaDeductPerPax = bundle?.selfVisaDeductCny ?? 0;

  // 整单签证「不需要」→ 出行人自备签的单向联动开关（仅套餐单 + 签证列在显示时才生效）。
  // 单向：只在选中「不需要」时把现有/新增出行人批量置为自备签；订单级改回其它值不做任何反向还原，
  // 不动用户已经逐位调整过的选择（公测反馈：整单选了不需要还要逐个人再选一遍）。
  const autoVisaExemptForBundle = kind === 'BUNDLE' && showVisaExemptCol && visaStatus === 'NOT_NEEDED';

  // 调价有效性：金额为非 0 整数即视为「要调价」；「其它」原因必须补说明。
  const adjustIsInteger = adjustAmount !== null && Number.isInteger(adjustAmount) && adjustAmount !== 0;
  const adjustNeedsText = adjustReason === 'OTHER' && adjustText.trim().length === 0;
  const hasValidAdjustment = adjustIsInteger && !adjustNeedsText;
  const adjustError = adjustIsInteger && adjustNeedsText ? '选择「其它」时请填写调整原因说明' : null;

  // ── 本单结算总价（仅 ADMIN/STAFF）──
  const isStaffUser = user?.role === 'ADMIN' || user?.role === 'STAFF';
  // 代理录单：只看结算价（业务拍板）。系统价/调价/手工结算总价是运营概念，对代理隐藏；
  // quote 接口对 AGENT 已在服务端强制归属自家，结算价预览无需先选归属代理。
  const isAgentUser = user?.role === 'AGENT';
  // 代理头部金额：结算价日历命中 → 日历合计；日历缺价 → 不给数（下方黄条提示）；
  // 无日历接管（纯酒店/签证/未配日历）→ 权威价即应付结算额。
  const agentHeaderTotal =
    settlementPreview?.ok === true
      ? settlementPreview.totalCny
      : settlementPreview?.ok === false
        ? null
        : quoteTotal;
  // 差额上限（镜像后端 PRICE_ADJUSTMENT_CAP_CNY）：超出直接前端阻断，省一次必败的提交。
  const SETTLEMENT_DIFF_CAP_CNY = 100_000;
  // 差额 = 结算价 − 系统价（表单当前试算值；对齐到分，避免浮点尾差）。系统价不可用时为 null。
  const settlementDiff =
    settlementPrice !== null && quoteTotal !== null
      ? Math.round((settlementPrice - quoteTotal) * 100) / 100
      : null;
  const settlementError =
    settlementPrice === null
      ? null
      : Number(settlementPrice.toFixed(2)) !== settlementPrice
        ? '结算总价最多两位小数'
        : settlementDiff !== null && Math.abs(settlementDiff) > SETTLEMENT_DIFF_CAP_CNY
          ? `结算总价与系统价差额超出调价上限（±¥${SETTLEMENT_DIFF_CAP_CNY.toLocaleString('zh-CN')}），请复核`
          : null;
  // 与手工调价互斥（服务端也会 400）：两个改价通道同时填会双重砸价，前端先拦。
  const settlementConflict =
    settlementPrice !== null && adjustIsInteger
      ? '「本单结算总价」与「调整金额」不能同时填写（两者互斥）；请清空其中一个'
      : null;

  function setPassenger(i: number, patch: Partial<PassengerRow>): void {
    setPassengers((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      passengersRef.current = next; // 即时同步 ref：并发 OCR 的上限计数读最新值
      return next;
    });
  }
  /** 用户手动改动某字段后清除该字段的 AI 核对警示（该字段既已人工看过，警示已完成使命）。 */
  function clearReviewField(i: number, field: string): void {
    setPassengers((prev) => {
      const row = prev[i];
      if (!row?.reviewFields?.some((r) => r.field === field)) return prev;
      const next = prev.map((r, idx) =>
        idx === i ? { ...r, reviewFields: r.reviewFields!.filter((rf) => rf.field !== field) } : r,
      );
      passengersRef.current = next;
      return next;
    });
  }
  function addPassenger(): void {
    setPassengers((prev) => {
      // 整单「不需要签证」联动生效时，新增行默认也是自备签（与已有行一致，用户仍可逐位改回）。
      const row = autoVisaExemptForBundle ? { ...emptyPassenger(), visaExempt: true } : emptyPassenger();
      const next = [...prev, row];
      passengersRef.current = next;
      return next;
    });
  }

  /**
   * 常旅客联想点选 → 整行回填：优先用 fillFields（最近一次乘机人明细），
   * 为 null 时退回档案摘要字段。日期统一转 YYYY-MM-DD；性别 MALE→M / FEMALE→F，
   * 其他/空不覆盖。不动该行已有的 visaExempt/singleRoom 勾选和 OCR 相关字段。
   */
  function applyProfileSuggestion(i: number, s: TravelerProfileSuggestion): void {
    const ymd = (iso: string | null | undefined): string | undefined =>
      iso ? iso.slice(0, 10) : undefined;
    const mapGender = (g: string | null | undefined): 'M' | 'F' | undefined =>
      g === 'MALE' ? 'M' : g === 'FEMALE' ? 'F' : undefined;

    const f = s.fillFields;
    const patch: Partial<PassengerRow> = {};

    // 姓/名都有时按 LAST/FIRST 斜线拼接（与后端 composePassengerFullName 同规则），
    // 而非早前的空格 join——避免联想回填出 "ZHANG SAN" 这类无法区分姓名边界的格式。
    const composedName = f ? composePassengerFullName(f.lastName, f.firstName) : null;
    patch.fullName = composedName || normalizePassengerFullName(s.fullName);
    patch.documentNumber = f?.documentNumber || s.documentNumber;
    clearReviewField(i, 'fullName');

    const dob = ymd(f?.dateOfBirth ?? s.dateOfBirth);
    if (dob) patch.dateOfBirth = dob;
    const chineseName = f?.chineseName ?? s.chineseName;
    if (chineseName) patch.chineseName = chineseName;
    const gender = mapGender(f?.gender ?? s.gender);
    if (gender) patch.gender = gender;
    const issueDate = ymd(f?.passportIssueDate);
    if (issueDate) patch.passportIssueDate = issueDate;
    if (f?.passportIssuePlace) patch.passportIssuePlace = f.passportIssuePlace;
    const expiry = ymd(f?.passportExpiry ?? s.passportExpiry);
    if (expiry) patch.passportExpiry = expiry;

    setPassenger(i, patch);
  }
  function removePassenger(i: number): void {
    setPassengers((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, idx) => idx !== i);
      passengersRef.current = next;
      return next;
    });
  }

  /**
   * 批量护照：一次多选 → 逐张识别（一次跑 BULK_OCR_CONCURRENCY 张）→ 自动生成出行人行。
   *
   * 顺序保证（修排版乱序 bug）：只复用「表尾」连续的空白行，其余追加到末尾——
   * 这样上传顺序 == 行顺序，不会把照片塞进中间已填行之间打乱排版。
   * 受 MAX_PHOTO_PASSENGERS 上限约束（超出截断 + 提示）。
   */
  async function handleBulkOcrFiles(files: File[]): Promise<void> {
    if (bulkOcr) return; // 已在跑，忽略重复触发
    if (files.length === 0) return;

    const current = passengersRef.current;
    const withPhoto = current.filter((p) => p.passportPhotoUrl).length;
    const slots = Math.max(0, MAX_PHOTO_PASSENGERS - withPhoto);
    if (slots === 0) {
      setErr(`护照图最多 ${MAX_PHOTO_PASSENGERS} 张/单，已达上限；更多请分单录入`);
      return;
    }
    const accepted = files.slice(0, slots);
    setErr(
      accepted.length < files.length
        ? `一单护照图上限 ${MAX_PHOTO_PASSENGERS} 张，本次已取前 ${accepted.length} 张，其余请分单录入`
        : null,
    );

    // 表尾连续空白行（无姓名/护照号/照片）的起点：只复用末尾这段，保持顺序不被打乱。
    const isPristine = (p: PassengerRow): boolean =>
      !p.fullName.trim() && !p.documentNumber.trim() && !p.passportPhotoUrl;
    let trailingStart = current.length;
    while (trailingStart > 0 && isPristine(current[trailingStart - 1])) trailingStart--;
    const trailingEmptyCount = current.length - trailingStart;

    // 前 trailingEmptyCount 张复用表尾空白行，剩下的追加到末尾——行顺序严格 == 上传顺序。
    const targetIndices: number[] = [];
    let appendCount = 0;
    for (let k = 0; k < accepted.length; k++) {
      if (k < trailingEmptyCount) targetIndices.push(trailingStart + k);
      else targetIndices.push(current.length + appendCount++);
    }
    if (appendCount > 0) {
      // 整单「不需要签证」联动生效时，批量识别新增的行同样默认自备签（与手动加一位同口径）。
      const toAppend = Array.from({ length: appendCount }, () =>
        autoVisaExemptForBundle ? { ...emptyPassenger(), visaExempt: true } : emptyPassenger(),
      );
      setPassengers((prev) => [...prev, ...toAppend]);
      // ref 同步前置：并发 worker 会立即按这些末尾索引写入，别等 effect 回灌。
      passengersRef.current = [...current, ...toAppend];
    }

    // 并发池：最多 BULK_OCR_CONCURRENCY 个 worker 取任务，复用单张 handleOcrFile。
    setBulkOcr({ done: 0, total: accepted.length });
    let cursor = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (cursor < accepted.length) {
        const k = cursor++;
        try {
          await handleOcrFile(targetIndices[k], accepted[k]);
        } catch {
          /* 单张失败不阻断其余；handleOcrFile 内部已回退/容错 */
        }
        done++;
        setBulkOcr({ done, total: accepted.length });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BULK_OCR_CONCURRENCY, accepted.length) }, () => worker()),
    );
    setBulkOcr(null);
  }

  /**
   * 护照 OCR：点按钮 → 触发隐藏 file input → 读取图片 → 识别 → 自动填表
   *
   * 策略：
   *   只走后端 AI 识别（POST /ocr/passport）。成功时回填 AI 结果并显示模型；未登录、未配置、
   *   识别失败或请求异常时写入明确错误，不回填乘客字段。图片仍压缩保存，方便人工核录。
   *
   * 图片压缩：存库图先缩到长边 ≤1600 + JPEG ≤~700KB，OCR 识别用原始 File。
   */
  async function handleOcrFile(idx: number, file: File): Promise<void> {
    // 写死上限：一单护照图最多 MAX_PHOTO_PASSENGERS 张（受后端单次请求大小所限）。
    // 仅在「该行原本没图」且已达上限时拦截（重新识别已有图不增加张数）。
    // 用 ref 读最新乘客快照，避免批量并发时读到陈旧的渲染闭包（漏计/超计）。
    const snapshot = passengersRef.current;
    const alreadyHasPhoto = Boolean(snapshot[idx]?.passportPhotoUrl);
    if (!alreadyHasPhoto && snapshot.filter((p) => p.passportPhotoUrl).length >= MAX_PHOTO_PASSENGERS) {
      setErr(`护照图最多 ${MAX_PHOTO_PASSENGERS} 张/单，已达上限；更多请分单录入`);
      return;
    }
    setPassenger(idx, {
      ocrPct: 0,
      ocrStage: '加载中…',
      ocrEngine: null,
      ocrModel: null,
      ocrFailed: false,
    });

    // ── 1. 存库图压缩 ──
    let dataUrl = '';
    try {
      const { passportPhotoToDataUrl } = await import('../lib/passportOcr');
      dataUrl = await passportPhotoToDataUrl(file);
    } catch {
      dataUrl = '';
    }
    if (dataUrl) setPassenger(idx, { passportPhotoUrl: dataUrl });

    const setOcrFailure = (stage: string) => {
      setPassenger(idx, {
        ocrPct: null,
        ocrStage: stage,
        ocrEngine: null,
        ocrModel: null,
        ocrFailed: true,
        reviewFields: undefined,
        mrzValid: null,
        localOcrCaveat: false,
      });
    };

    // ── 2. 无 token（不应出现，保险兜底）→ 明确报错 ──
    if (!token) {
      setOcrFailure('登录态缺失，无法识别，请重新登录');
      return;
    }

    // ── 3. AI 识别 ──
    try {
      setPassenger(idx, { ocrPct: 20, ocrStage: 'AI 识别中…' });
      const imageDataUrl = dataUrl || await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取失败'));
        reader.onerror = () => reject(new Error('读取失败'));
        reader.readAsDataURL(file);
      });
      const aiRes: AiOcrPassportResult = await api.ocrPassportAi(token, imageDataUrl);

      if (!aiRes.configured) {
        setOcrFailure('AI 识别未配置：请在「设置 → AI 识别」配置密钥后重试');
        return;
      }

      if (aiRes.suggested) {
        const s = aiRes.suggested;
        const patch: Partial<PassengerRow> = {
          ocrPct: 100,
          ocrStage: '识别完成',
          ocrEngine: 'ai',
          ocrFailed: false,
          ocrModel: aiRes.model ?? null,
          // 后端 verify 直接带回需人工核对的字段列表 + MRZ 校验结果，整行展示提示。
          reviewFields: aiRes.verify?.reviewFields ?? undefined,
          mrzValid: aiRes.verify?.mrzValid ?? null,
          localOcrCaveat: false,
        };
        if (s.fullName) patch.fullName = normalizePassengerFullName(s.fullName);
        if (s.documentNumber) patch.documentNumber = s.documentNumber;
        if (s.dateOfBirth) patch.dateOfBirth = s.dateOfBirth;
        if (s.gender) patch.gender = s.gender;
        if (s.chineseName) patch.chineseName = s.chineseName;
        if (s.passportIssueDate) patch.passportIssueDate = s.passportIssueDate;
        if (s.passportIssuePlace) patch.passportIssuePlace = s.passportIssuePlace;
        if (s.passportExpiry) patch.passportExpiry = s.passportExpiry;
        setPassenger(idx, patch);
        return;
      }

      setOcrFailure(`AI 识别失败：${aiRes.error ?? '请重试或手动填写'}`);
    } catch {
      setOcrFailure('AI 识别失败：网络或服务异常，请重试');
    }
  }

  /** 构建当前产品类型的订单行；缺字段返回 { error }。 */
  function buildItem():
    | { item: CreateOrderItemInput }
    | { items: CreateOrderItemInput[] }
    | { error: string } {
    if (kind === 'FLIGHT') {
      if (!scheduleId || !cabin) {
        return { error: flightTripType === 'ROUNDTRIP' ? '请选择出港航班班次和舱位' : '请选择航班班次和舱位' };
      }
      // 往返同一批出行人 → 每条 FLIGHT 行的 quantity 都 = 出行人数（不翻倍）；
      // unitPrice 占位 0，服务端按班次舱位权威重算（与套餐/批量创单同约定）。
      const seatPax = Math.max(1, validPassengers.length || 1);
      const outDateStr = schedule ? localYmd(schedule.departureTime, schedule.departureTz) : '';
      const outLabel = flightTripType === 'ROUNDTRIP' ? '去程 ' : '';
      const outboundLine = {
        kind: 'FLIGHT' as const,
        description:
          `${outLabel}${flight?.flightNumber ?? ''} ${flight?.originCode ?? ''}→${flight?.destinationCode ?? ''} ${outDateStr} ${CABIN_ZH[cabin] ?? cabin}`.trim(),
        quantity: seatPax,
        flightScheduleId: scheduleId,
        flightCabin: cabin,
      };
      if (flightTripType === 'ONEWAY') {
        return { item: outboundLine };
      }
      // 往返：回程再生成一条 FLIGHT 行（可与出港不同航班/日期/舱位）。
      if (!returnScheduleId || !returnCabin) return { error: '往返需选择回程航班班次和舱位' };
      const retDateStr = returnSchedule ? localYmd(returnSchedule.departureTime, returnSchedule.departureTz) : '';
      const returnLine = {
        kind: 'FLIGHT' as const,
        description:
          `回程 ${returnFlight?.flightNumber ?? ''} ${returnFlight?.originCode ?? ''}→${returnFlight?.destinationCode ?? ''} ${retDateStr} ${CABIN_ZH[returnCabin] ?? returnCabin}`.trim(),
        quantity: seatPax,
        flightScheduleId: returnScheduleId,
        flightCabin: returnCabin,
      };
      return { items: [outboundLine, returnLine] };
    }
    if (kind === 'HOTEL') {
      // ── 星级随机池行：不选酒店/房型，占池库存，之后由房控落到具体酒店 ──
      if (poolTier != null) {
        if (!checkIn || !checkOut) return { error: '请填写入住和退房日期' };
        const poolNights = nightsBetween(checkIn, checkOut);
        if (poolNights < 1) return { error: '退房日期需晚于入住日期' };
        if (poolNightlyPrice == null || poolNightlyPrice <= 0) {
          return { error: `请填写${randomStarTierLabel(poolTier)}的每间每晚售价` };
        }
        const poolRoomQty = Math.max(1, rooms ?? 1);
        return {
          item: {
            kind: 'HOTEL',
            description: `${randomStarTierLabel(poolTier)} · ${checkIn}~${checkOut} · ${poolNights}晚 × ${poolRoomQty}间`,
            // qty = 晚数（与具体酒店行同构）；金额 = 每间每晚价 × 晚数 × 间数。
            // 池行显式送 roomsBilled，让「收多少钱」「占几间池库存」是同一个数，不靠 metadata 反推。
            quantity: poolNights,
            randomStarTier: poolTier,
            checkIn,
            checkOut,
            unitPrice: poolNightlyPrice,
            roomsBilled: poolRoomQty,
            metadata: { rooms: poolRoomQty },
          },
        };
      }
      if (!roomTypeId) return { error: '请选择酒店和房型' };
      if (!checkIn || !checkOut) return { error: '请填写入住和退房日期' };
      const nights = nightsBetween(checkIn, checkOut);
      if (nights < 1) return { error: '退房日期需晚于入住日期' };
      const roomQty = Math.max(1, rooms ?? 1);
      const description =
        `${hotel?.name ?? '酒店'} · ${roomType?.name ?? '房型'} · ${checkIn}~${checkOut} · ${nights}晚 × ${roomQty}间`;
      return {
        item: {
          kind: 'HOTEL',
          description,
          // qty = 晚数；服务端按「房型每晚 basePrice × 晚数」校验（±1 元）。
          // 单价送房型当前每晚价（服务端会比对，不一致则拒），房间数透传 metadata 供房控/分房参考。
          quantity: nights,
          hotelRoomTypeId: roomTypeId,
          checkIn,
          checkOut,
          unitPrice: Number(roomType?.basePrice ?? 0),
          metadata: { rooms: roomQty },
        },
      };
    }
    if (kind === 'VISA') {
      if (!visaId) return { error: '请选择签证产品' };
      const qty = Math.max(1, visaQty ?? 1);
      // 加急档（运营在产品上配的零工/一工/二工…）：选中的档名随行 metadata 上送，
      // 加价金额一律由服务端按产品档位表查出（这里带上单价只是为了通过 ±1 元容差校验）。
      const tier = visaExpressTiers.find((t) => t.label === visaExpressTierLabel);
      const description =
        `${visa?.visaName ?? visa?.visaType ?? '签证'}（${visa?.destinationCountry ?? ''}）× ${qty}份` +
        (tier ? ` · 加急${tier.label}` : '');
      const unitPrice = Number(visa?.basePrice ?? 0) + (tier?.surchargeCny ?? 0);
      return {
        item: {
          kind: 'VISA',
          description,
          quantity: qty,
          visaId,
          unitPrice,
          ...(tier ? { metadata: { expressTierLabel: tier.label } } : {}),
        },
      };
    }
    if (kind === 'BUNDLE') {
      if (!bundleId) return { error: '请选择套餐' };
      const adults = Math.max(0, adultCount ?? 0);
      const children = Math.max(0, childCount ?? 0);
      const infants = Math.max(0, infantCount ?? 0);
      if (adults + children < 1) return { error: '套餐至少需 1 位占座出行人（成人或儿童）' };
      // 出行人需与人数完全一致（成人+儿童+婴儿），否则服务端拒收（婴儿不占座但也是出行人）。
      const headCount = adults + children + infants;
      if (validPassengers.length !== headCount) {
        return {
          error: `套餐出行人数需与人数一致：应填 ${headCount} 位（${adults}成人+${children}儿童+${infants}婴儿），当前 ${validPassengers.length} 位有效`,
        };
      }
      // 出发日期必填：航段按它自动派生（匹配去程/回程班次本地日期）。
      if (!departDate) return { error: '请选择套餐「出发日期」（用于自动匹配机票航段并扣座）' };
      // 去程航段必须派生成功，否则该出发日无对应去程班次 → 不能扣座/进票务待办。
      if (!bundleLegs.go) {
        return { error: `所选出发日期 ${departDate} 没有匹配的去程班次（${BUNDLE_GO_ORIGIN}→${BUNDLE_GO_DEST}），请换日期或先在航班里建班次` };
      }
      // 往返套餐必须派生出回程；缺回程班次说明回程日期那天没排班。
      const isRoundTrip = (bundle?.legs ?? 2) >= 2;
      if (isRoundTrip && !bundleLegs.ret) {
        return { error: `回程日期 ${bundleLegs.returnDate} 没有匹配的回程班次（${BUNDLE_GO_DEST}→${BUNDLE_GO_ORIGIN}），请核对套餐晚数/排班` };
      }
      const maxSingleBusiness = adults + children;
      // 单住 / 自备签为乘客级派生（购物车模式：每人各选，见出行人表两列）——从行标记统计人数。
      // 权威定价由后端按 passengers 数组的 singleRoom/visaExempt 重算；此处仅用于描述/明细展示。
      const singles = validPassengers.filter((p) => p.singleRoom).length;
      const visaExempts = validPassengers.filter((p) => p.visaExempt).length;
      // 升舱分程：去/回程各自夹到占座人数；单程套餐没有回程航段 → 回程恒 0（服务端同样按 0 处理）。
      const businessesOutbound = Math.min(Math.max(0, businessCountOutbound ?? 0), maxSingleBusiness);
      const businessesReturn = isRoundTrip
        ? Math.min(Math.max(0, businessCountReturn ?? 0), maxSingleBusiness)
        : 0;
      // 机票航段：去程 +（往返套餐）回程；占座人数 = 成人 + 儿童（婴儿不占座），舱位固定经济舱。
      const seatPax = Math.max(1, adults + children);
      // 同时派发去程 + 回程两条 FLIGHT 行：后端对每条 FLIGHT 行都扣座，这是「回程没扣」的根因修复。
      const derivedLegs: Array<{ sched: AdminSchedule; label: string }> = [
        { sched: bundleLegs.go, label: '去程（经济舱）' },
      ];
      if (isRoundTrip && bundleLegs.ret) {
        derivedLegs.push({ sched: bundleLegs.ret, label: '回程（经济舱）' });
      }
      const flightLines = derivedLegs.map(({ sched, label }) => ({
        kind: 'FLIGHT' as const,
        description: `${bundle?.name ?? '套餐'} · ${label}`,
        quantity: seatPax,
        flightScheduleId: sched.id,
        flightCabin: 'ECONOMY' as CabinClass,
      }));
      // goDate 决定套餐酒店入住日（缺则后端 createOrder 不盖酒店章 → 房控不计套餐占房）。
      const goDate = departDate;
      const metadata: Record<string, unknown> = { adultCount: adults, childCount: children, infantCount: infants };
      if (goDate) metadata.goDate = goDate;
      // 指定酒店（可选）：选了酒店必须选到房型，服务端按房型切占房并加收该店指定加价。
      const designatedHotel = designatedHotelId ? hotels.find((h) => h.id === designatedHotelId) : undefined;
      if (designatedHotelId && !designatedRoomTypeId) {
        return { error: '已选择指定酒店，请选择房型（或改回「随机（不指定酒店）」）' };
      }
      const descParts = [
        `${bundle?.name ?? '套餐'}`,
        departDate ? `${departDate}出发` : null,
        `${adults}成人${children ? `/${children}儿童` : ''}${infants ? `/${infants}婴儿` : ''}`,
        designatedHotel ? `指定${designatedHotel.name}` : null,
        singles > 0 ? `单住×${singles}` : null,
        // 升舱按程分开写清楚（只升去程 / 两程人数不同都要一眼看得出，别再写成一个笼统的「商务×N」）
        businessesOutbound > 0 ? `去程升舱×${businessesOutbound}` : null,
        businessesReturn > 0 ? `回程升舱×${businessesReturn}` : null,
        visaExempts > 0 ? `自备签×${visaExempts}` : null,
      ].filter(Boolean).join(' · ');
      // 单住 / 自备签不再落 item 级聚合字段（singleCount/selfProvidedVisa）——
      // 后端从 passengers 数组的 singleRoom/visaExempt 逐位派生权威定价（购物车模式）。
      const bundleLine = {
        kind: 'BUNDLE' as const,
        description: descParts,
        quantity: 1,
        bundleId,
        unitPrice: 0, // 服务端权威重算（仅地面部分，机票走上面的 FLIGHT 行）
        adultCount: adults,
        childCount: children,
        infantCount: infants,
        // 升舱分程：两个字段一起传（含 0），服务端据此各程分别定价 + 各程分别占商务舱座位。
        businessCountOutbound: businessesOutbound,
        businessCountReturn: businessesReturn,
        // 指定酒店：服务端据此切占房/盖章并按该店「指定酒店加价 ¥/人」×占座人数加收。
        ...(designatedRoomTypeId ? { designatedHotelRoomTypeId: designatedRoomTypeId } : {}),
        metadata,
      };
      // 机票航段在前 + 地面套餐行在后：与前台商城同结构，服务端按航段扣座、套餐行只算地面。
      return { items: [...flightLines, bundleLine] };
    }
    // TRANSFER —— 单价送接送当前 basePrice；服务端按 basePrice × qty 校验（±1 元）。
    if (!transferId) return { error: '请选择接送产品' };
    const qty = Math.max(1, transferQty ?? 1);
    const description = `${transfer?.name ?? '接送'}${transferDate ? ` · ${transferDate}` : ''} × ${qty}`;
    const metadata = transferDate ? { date: transferDate } : undefined;
    return {
      item: { kind: 'TRANSFER', description, quantity: qty, transferId, unitPrice: Number(transfer?.basePrice ?? 0), metadata },
    };
  }

  // 系统价试算：产品/人数变化后（去抖 400ms）向后端 /orders/quote 拿权威价。
  // buildItem() 返回 error（选择不完整）时清空系统价，不打后端。调价金额不参与试算——
  // 系统价是「未调整前」的权威价，最终应付 = 系统价 + 调整额（下方界面单独展示）。
  useEffect(() => {
    if (!token) {
      setQuoteTotal(null);
      setSettlementPreview(null);
      setQuoteErr(null);
      return;
    }
    const built = buildItem();
    if ('error' in built) {
      setQuoteTotal(null);
      setSettlementPreview(null);
      setQuoteErr(null);
      return;
    }
    const items = 'items' in built ? built.items : [built.item];
    // 套餐乘客级住宿/签证选项：让系统价随每人「拼房/单住 · 随套餐/自备签」选择实时变化。
    // 仅套餐单发送（其余产品与乘客级选项无关，后端也只在 BUNDLE 分支读取）。
    const quotePassengers =
      kind === 'BUNDLE'
        ? validPassengers.map((p) => ({ visaExempt: !!p.visaExempt, singleRoom: !!p.singleRoom }))
        : undefined;
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      api
        .quoteOrder(token, {
          items,
          ...(quotePassengers ? { passengers: quotePassengers } : {}),
          ...(agentId ? { agentId } : {}),
        })
        .then((r) => {
          if (cancelled) return;
          setQuoteTotal(r.total);
          setSettlementPreview(r.settlementPreview);
          setQuoteErr(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setQuoteTotal(null);
          setSettlementPreview(null);
          setQuoteErr(e instanceof ApiError ? e.message : '系统价试算失败');
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // buildItem 读取下列定价相关状态；变化即重新试算（依赖数组显式列出，避免陈旧闭包）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    token, kind, flightTripType, scheduleId, cabin, returnScheduleId, returnCabin,
    roomTypeId, rooms, visaId, visaQty, visaExpressTierLabel, bundleId, departDate,
    adultCount, childCount, infantCount, businessCountOutbound, businessCountReturn,
    // 指定酒店变化 → 重新试算（指定加价计入系统价）。
    designatedRoomTypeId,
    // 乘客级单住/自备签勾选数变化 → 重新试算系统价（购物车模式）。
    singleRoomCount, visaExemptCount,
    transferId, transferQty, validPassengers.length,
    agentId,
  ]);

  // 注：结算总价不再回填「调整金额」——settlementTotalCny 直接提交给服务端，由服务端按
  // 权威价自动生成差额行（前端只做预览），两个通道互斥。

  async function submit(): Promise<void> {
    if (!token || submitting) return;
    setErr(null);

    // 联系人现为选填：后端会回退到登录的录入人。这里不再硬性拦截。
    const built = buildItem();
    if ('error' in built) {
      setErr(built.error);
      return;
    }
    // 套餐返回多行（机票航段 + 地面套餐）；其余类型返回单行。
    const orderItems = 'items' in built ? built.items : [built.item];

    if (passengersRequired && validPassengers.length === 0) {
      setErr('该产品类型需至少一位完整出行人（姓名 + 护照号 + 出生日期）');
      return;
    }

    // 性别必填（业务口径）：任何已填姓名+护照号的出行人行，性别必须是 M/F 才能提交
    // （X/未选都算未定性别，阻断提交；仅前端校验，不改后端 schema）。
    const genderMissingRows = passengers
      .map((p, idx) => ({ ...p, rowNumber: idx + 1 }))
      .filter((p) => p.fullName.trim() && p.documentNumber.trim() && p.gender !== 'M' && p.gender !== 'F');
    if (genderMissingRows.length > 0) {
      setErr(`第 ${genderMissingRows.map((p) => p.rowNumber).join('、')} 位出行人未选择性别，请完善后再提交`);
      return;
    }

    // 护照有效期必填（业务口径，与后端创建路径校验同口径）：机票/套餐/签证单（出行人必填的
    // 产品类型）的每位已填出行人必须有合法有效期；纯酒店/接送出行人选填，不拦。
    if (passengersRequired) {
      const expiryMissingRows = passengers
        .map((p, idx) => ({ ...p, rowNumber: idx + 1 }))
        .filter(
          (p) =>
            p.fullName.trim() &&
            p.documentNumber.trim() &&
            parseDob(p.passportExpiry ?? '') === null,
        );
      if (expiryMissingRows.length > 0) {
        setErr(
          `第 ${expiryMissingRows.map((p) => p.rowNumber).join('、')} 位出行人护照有效期未填写或格式不正确（必填），请完善后再提交`,
        );
        return;
      }
    }

    // 护照签发日期（选填）：填了但解析不了 → 与有效期同款拦截提交，不静默丢弃脏数据。
    // 不限定 passengersRequired——该字段在任意产品类型下都选填，一旦填了就要合法。
    const issueDateInvalidRows = passengers
      .map((p, idx) => ({ ...p, rowNumber: idx + 1 }))
      .filter(
        (p) =>
          p.fullName.trim() &&
          p.documentNumber.trim() &&
          (p.passportIssueDate ?? '').trim() &&
          parseDob(p.passportIssueDate ?? '') === null,
      );
    if (issueDateInvalidRows.length > 0) {
      setErr(
        `第 ${issueDateInvalidRows.map((p) => p.rowNumber).join('、')} 位出行人护照签发日期格式不正确，请修正后再提交`,
      );
      return;
    }

    if (adjustError) {
      setErr(adjustError);
      return;
    }

    // 本单结算总价：格式/上限错误或与手工调价同时填 → 阻断提交（镜像服务端校验，先给可读提示）
    if (settlementError) {
      setErr(settlementError);
      return;
    }
    if (settlementConflict) {
      setErr(settlementConflict);
      return;
    }

    const passengerPayload: OrderPassengerInput[] = validPassengers.map((p) => ({
      fullName: p.fullName.trim(),
      documentNumber: p.documentNumber.trim(),
      dateOfBirth: parseDob(p.dateOfBirth) ?? '',
      nationality: 'CN',
      ...(p.gender ? { gender: p.gender } : {}),
      ...(p.passportPhotoUrl ? { passportPhotoUrl: p.passportPhotoUrl } : {}),
      ...(p.chineseName?.trim() ? { chineseName: p.chineseName.trim() } : {}),
      // 签发日期/有效期一律先过 parseDob 规范化（补零成 YYYY-MM-DD）再发，与 dateOfBirth 同口径，
      // 避免前端宽松格式（2033-8-24）放行、后端 zod 严格格式（^\d{4}-\d{2}-\d{2}$）打回。
      // 非空但解析失败的行已在上方前置校验拦截，此处 parseDob 对已通过校验的值必定非 null；
      // ?? 兜底仅为类型收窄，不改变已校验数据的行为。
      ...(p.passportIssueDate?.trim() ? { passportIssueDate: parseDob(p.passportIssueDate) ?? p.passportIssueDate.trim() } : {}),
      ...(p.passportIssuePlace?.trim() ? { passportIssuePlace: p.passportIssuePlace.trim() } : {}),
      ...(p.passportExpiry?.trim() ? { passportExpiry: parseDob(p.passportExpiry) ?? p.passportExpiry.trim() } : {}),
      // 签证出签日/生效日/有效期不在录单时采集：改由签证台在出签后补录（见 PassengerRow 类型定义注释）。
      // 套餐乘客级选项（购物车模式）：仅套餐单显式发送；后端据此逐位派生权威定价 + 签证台过滤。
      ...(kind === 'BUNDLE' ? { visaExempt: !!p.visaExempt, singleRoom: !!p.singleRoom } : {}),
    }));
    // 纯酒店/接送且未填出行人：后端 passengers 至少 1 条，用联系人（或录入人）占位一位出行人。
    if (passengerPayload.length === 0) {
      passengerPayload.push({
        fullName: contactName.trim() || recorderLabel,
        documentNumber: 'N/A',
        dateOfBirth: '1990-01-01',
        nationality: 'CN',
      });
    }

    const body: CreateOrderInput = {
      contactName: contactName.trim() || undefined,
      contactPhone: contactPhone.trim() || undefined,
      contactEmail: contactEmail.trim() || undefined,
      items: orderItems,
      passengers: passengerPayload,
      notes: notes.trim() || undefined,
      visaStatus,
      noteHotel: noteHotel.trim() || undefined,
      noteVisa: noteVisa.trim() || undefined,
      notePayment: notePayment.trim() || undefined,
      noteSpecial: noteSpecial.trim() || undefined,
      idempotencyKey: idemKey,
      ...(agentId ? { agentId } : {}),
      ...(hasValidAdjustment
        ? {
            priceAdjustment: {
              amountCny: adjustAmount as number,
              reasonCode: adjustReason,
              ...(adjustText.trim() ? { reasonText: adjustText.trim() } : {}),
            },
          }
        : {}),
      // 本单结算总价（仅 ADMIN/STAFF；与 priceAdjustment 互斥，上方已阻断同时填写）：
      // 服务端按「结算价 − 权威合计」自动生成「代理结算价」差额行，系统照此收钱。
      ...(isStaffUser && settlementPrice !== null ? { settlementTotalCny: settlementPrice } : {}),
    };

    setSubmitting(true);
    try {
      let res;
      try {
        res = await api.createOrder(token, body);
      } catch (e: unknown) {
        // 重复乘客：后端稳定 code=DUPLICATE_PASSENGER（不靠中文文案匹配）。
        // 客人重复订票且已付款场景：二次确认后带 allowDuplicatePassengers 强录一次。
        if (e instanceof ApiError && e.code === 'DUPLICATE_PASSENGER') {
          const orderNos = duplicatePassengerConflictOrderNumbers(e);
          const msg = orderNos.length
            ? `该乘客与订单 ${orderNos.join('、')} 同班次重复。确认仍要录入吗？（客人重复订票、已付款场景）`
            : '该乘客与已有订单同班次重复。确认仍要录入吗？（客人重复订票、已付款场景）';
          if (!window.confirm(msg)) {
            setSubmitting(false);
            return;
          }
          res = await api.createOrder(token, { ...body, allowDuplicatePassengers: true });
        } else {
          throw e;
        }
      }
      setOkOrderNumber(res.order.orderNumber);
      setCreatedOrder(res.order);
      setRoomingSaved(false);
      setShowRooming(false);
      setIdemKey(makeIdemKey());
      onCreated();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '录单失败');
    } finally {
      setSubmitting(false);
    }
  }

  // 切换产品类型时清掉上一类型的报错（保留已填联系人/出行人/备注）
  function switchKind(next: ProductKind): void {
    setKind(next);
    setErr(null);
  }

  // ── 录单后分房 ─────────────────────────────────────────────────────────
  // 创建响应已带 order.passengers（含 id + fullName + chineseName + gender），无需再拉详情。
  // 占位出行人（纯酒店/接送用联系人占位，documentNumber='N/A'）不进分房池。
  const roomingPassengers: RoomingPassenger[] = useMemo(() => {
    if (!createdOrder?.passengers) return [];
    return createdOrder.passengers
      .filter((p) => p.documentNumber !== 'N/A')
      .map((p) => ({
        id: p.id,
        name: p.fullName,
        gender: p.gender ?? null,
      }));
  }, [createdOrder]);

  // 分房页要显示的酒店信息：套餐（BUNDLE）订单没有独立 HOTEL 行——酒店由服务端盖章在
  // BUNDLE 行的 hotelRoomTypeId/hotelCheckIn/hotelCheckOut 上，酒店中文名则落在
  // item.hotelName（后端联查 hotelRoomType.hotel.name，任意 kind 命中即可，不再局限于 HOTEL 行）。
  // description 形如「酒店名 · 房型 · 入住~退房 · N晚 × M间」，取 ' · ' 前段作 hotelName 兜底。
  const roomingHotel = useMemo(() => {
    const items = (createdOrder?.items ?? []) as Array<{
      kind?: string;
      description: string;
      hotelName?: string | null;
      hotelRoomTypeId?: string;
      hotelCheckIn?: string;
      hotelCheckOut?: string;
    }>;
    const hotelItem = items.find((it) => it.hotelName || it.kind === 'HOTEL');
    if (!hotelItem) return null;
    const hotelName = hotelItem.hotelName?.trim() || hotelItem.description.split(' · ')[0]?.trim() || '';
    return {
      hotelName,
      hotelRoomTypeId: hotelItem.hotelRoomTypeId,
      checkIn: hotelItem.hotelCheckIn,
      checkOut: hotelItem.hotelCheckOut,
    };
  }, [createdOrder]);

  // 房量档位（只回档位不回原始数字，与六档余位同纪律）；null = 未配置/查询失败 → 不展示。
  const [hotelTier, setHotelTier] = useState<HotelAvailabilityTier | null>(null);
  useEffect(() => {
    const rt = roomingHotel?.hotelRoomTypeId;
    const ci = roomingHotel?.checkIn;
    const co = roomingHotel?.checkOut;
    if (!showRooming || !rt || !ci || !co) {
      setHotelTier(null);
      return;
    }
    let cancelled = false;
    api
      .getHotelAvailability({ hotelRoomTypeId: rt, checkIn: ci, checkOut: co })
      .then((r) => {
        if (!cancelled) setHotelTier(r.tier);
      })
      .catch(() => {
        // 查询失败按「无数据」处理：不展示房量档位、不阻断分房（不造假）
        if (!cancelled) setHotelTier(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showRooming, roomingHotel]);

  // 当日余房（分房弹窗徽标；ADMIN/STAFF 直显数字，与上面 hotelTier 只显档位的公开端点不同纪律）。
  const [nightlyRemaining, setNightlyRemaining] = useState<HotelNightlyRemainingResult | null>(null);
  useEffect(() => {
    const rt = roomingHotel?.hotelRoomTypeId;
    const ci = roomingHotel?.checkIn;
    const co = roomingHotel?.checkOut;
    if (!showRooming || !rt || !ci || !co) {
      setNightlyRemaining(null);
      return;
    }
    let cancelled = false;
    hotelControlOpsApi
      .getNightlyRemaining(token, { hotelRoomTypeId: rt, checkIn: ci, checkOut: co })
      .then((r) => {
        if (!cancelled) setNightlyRemaining(r);
      })
      .catch(() => {
        // 查询失败按「无数据」处理：不展示徽标、不阻断分房（不造假）
        if (!cancelled) setNightlyRemaining(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showRooming, roomingHotel, token]);

  async function handleRoomingSave(groups: RoomGroup[]): Promise<void> {
    if (!createdOrder) return;
    // 录单→OCR→分房这一整段可能开很久，渲染时闭包捕获的 token 可能已被后台续期换掉而过期
    // （报「Invalid or expired access token」）。保存时改从 store 现取最新 accessToken。
    const freshToken = useAuth.getState().tokens?.accessToken ?? token;
    await api.updateRoomAssignment(freshToken, createdOrder.id, groups);
    setRoomingSaved(true);
    setShowRooming(false);
  }

  // 「再录一单」/ 关闭后复位录单态（含分房步骤）
  function resetForNextOrder(): void {
    setOkOrderNumber(null);
    setCreatedOrder(null);
    setShowRooming(false);
    setRoomingSaved(false);
    setPassengers([emptyPassenger()]);
    setNotes('');
    setVisaStatus('NEEDED');
    setNoteHotel('');
    setNoteVisa('');
    setNotePayment('');
    setNoteSpecial('');
    // 单住 / 自备签是乘客级标记，随 setPassengers([emptyPassenger()]) 一并复位（无独立状态）。
    // 清掉上一单的调价（避免误带到下一单）；系统价随产品状态复位后由 effect 自动重算。
    setAdjustAmount(null);
    setAdjustReason('DISCOUNT');
    setAdjustText('');
  }

  const inputCls = 'mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="录单" tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl xl:max-w-[1400px]">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">录单（按产品类型 · 单笔）</h2>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="关闭录单弹窗"><Icon name="close" /></button>
        </div>

        {okOrderNumber ? (
          <div className="space-y-4 p-5">
            <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <Icon name="check" size={14} /> 录单成功 · 订单号 <b className="font-mono">{okOrderNumber}</b>
              {roomingSaved && <span className="ml-2 text-emerald-700">· 分房已保存</span>}
            </div>

            {/* 录单后分房：进入分房编辑器 */}
            {showRooming && roomingPassengers.length > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-4">
                <RoomingEditor
                  passengers={roomingPassengers}
                  initial={createdOrder?.roomAssignment?.roomGroups}
                  hotelName={roomingHotel?.hotelName}
                  hotelTier={hotelTier}
                  hotelRoomTypeId={roomingHotel?.hotelRoomTypeId}
                  checkIn={roomingHotel?.checkIn}
                  checkOut={roomingHotel?.checkOut}
                  nightlyRemaining={nightlyRemaining}
                  onSave={handleRoomingSave}
                  onClose={() => setShowRooming(false)}
                />
              </div>
            ) : (
              // 分房入口（仅当订单有真实出行人时提示）
              roomingPassengers.length > 0 && !roomingSaved && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand/20 bg-brand-50 px-4 py-3">
                  <div className="text-sm text-ink">
                    需要分房吗？把出行人拖进房间，决定谁和谁一起住（{roomingPassengers.length} 人）。
                  </div>
                  <button className="btn-primary text-sm" onClick={() => setShowRooming(true)}>
                    分房
                  </button>
                </div>
              )
            )}

            {/* 没分房也不丢：任何时候都能到「房控页」按订单再分。入口文案说明清楚。 */}
            {roomingPassengers.length > 0 && !roomingSaved && (
              <p className="text-xs text-ink-muted">
                现在不分也没关系 —— 之后可到「房控页」按订单随时补分房。
              </p>
            )}

            <div className="flex justify-end gap-2">
              {showRooming && (
                <button className="btn-ghost text-sm" onClick={() => setShowRooming(false)}>
                  稍后再分（去「房控页」分房）
                </button>
              )}
              <button className="btn-secondary text-sm" onClick={resetForNextOrder}>
                再录一单
              </button>
              <button className="btn-primary text-sm" onClick={onClose}>完成</button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            {err && <div className="rounded-md bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}

            {/* 产品类型选择 */}
            <div>
              <span className="text-xs text-slate-500">产品类型</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {KIND_TABS.map((t) => (
                  <button
                    key={t.kind}
                    type="button"
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                      kind === t.kind
                        ? 'border-brand bg-brand-50 text-brand ring-1 ring-brand/20'
                        : 'border-slate-200 text-ink-soft hover:border-slate-300 hover:bg-slate-50'
                    }`}
                    onClick={() => switchKind(t.kind)}
                  >
                    <Icon name={t.icon} /> {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 各类型字段 */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              {kind === 'FLIGHT' && (
                <div className="space-y-3">
                  {/* 单程 / 往返切换 */}
                  <div>
                    <span className="text-xs text-slate-500">行程类型</span>
                    <div className="mt-1 flex gap-2">
                      {([['ONEWAY', '单程'], ['ROUNDTRIP', '往返']] as const).map(([val, label]) => (
                        <button
                          key={val}
                          type="button"
                          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                            flightTripType === val
                              ? 'border-brand bg-brand-50 text-brand ring-1 ring-brand/20'
                              : 'border-slate-200 text-ink-soft hover:border-slate-300 hover:bg-slate-50'
                          }`}
                          onClick={() => { setFlightTripType(val); setErr(null); }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 出港航段 */}
                  <div className="rounded-md border border-slate-200 bg-white/70 p-3">
                    <div className="mb-2 text-xs font-medium text-slate-600">
                      {flightTripType === 'ROUNDTRIP' ? '出港航班' : '航班'}
                    </div>
                    <div className="grid gap-3 md:grid-cols-4">
                      <label className="text-xs text-slate-500">
                        航班
                        <select className={inputCls} value={flightId} onChange={(e) => { setFlightId(e.target.value); setScheduleId(''); setCabin(''); setFlightDate(''); }}>
                          <option value="">选择航班…</option>
                          {flights.map((f) => (
                            <option key={f.id} value={f.id}>{f.flightNumber} {f.originCode}→{f.destinationCode}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-slate-500">
                        起飞日期（可手输）
                        <input type="date" className={inputCls} value={flightDate} onChange={(e) => { setFlightDate(e.target.value); setScheduleId(''); setCabin(''); }} disabled={!flightId} />
                      </label>
                      <label className="text-xs text-slate-500">
                        班次（出发 · 当地时间）
                        <select className={inputCls} value={scheduleId} onChange={(e) => { setScheduleId(e.target.value); setCabin(''); }} disabled={!flightId}>
                          <option value="">{flightDate ? '选择当日班次…' : '选择班次…'}</option>
                          {schedulesForDate.map((s) => (
                            <option key={s.id} value={s.id}>
                              {localYmd(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                            </option>
                          ))}
                        </select>
                        {flightId && flightDate && schedulesForDate.length === 0 && (
                          <span className="mt-1 block text-[11px] text-amber-600">该日期无班次，请换个日期或清空日期查看全部。</span>
                        )}
                      </label>
                      <label className="text-xs text-slate-500">
                        舱位
                        <select className={inputCls} value={cabin} onChange={(e) => setCabin(e.target.value as CabinClass)} disabled={!scheduleId}>
                          <option value="">选择舱位…</option>
                          {cabinOptions.map((c) => (
                            <option key={c.id} value={c.cabin}>
                              {CABIN_ZH[c.cabin] ?? c.cabin}（{cabinAvailText(c.available)}）¥{Number(c.basePrice).toFixed(0)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

                  {/* 回程航段（仅往返） */}
                  {flightTripType === 'ROUNDTRIP' && (
                    <div className="rounded-md border border-slate-200 bg-white/70 p-3">
                      <div className="mb-2 text-xs font-medium text-slate-600">回程航班</div>
                      <div className="grid gap-3 md:grid-cols-4">
                        <label className="text-xs text-slate-500">
                          航班
                          <select className={inputCls} value={returnFlightId} onChange={(e) => { setReturnFlightId(e.target.value); setReturnScheduleId(''); setReturnCabin(''); setReturnDate(''); }}>
                            <option value="">选择航班…</option>
                            {flights.map((f) => (
                              <option key={f.id} value={f.id}>{f.flightNumber} {f.originCode}→{f.destinationCode}</option>
                            ))}
                          </select>
                        </label>
                        <label className="text-xs text-slate-500">
                          起飞日期（可手输）
                          <input type="date" className={inputCls} value={returnDate} onChange={(e) => { setReturnDate(e.target.value); setReturnScheduleId(''); setReturnCabin(''); }} disabled={!returnFlightId} />
                        </label>
                        <label className="text-xs text-slate-500">
                          班次（出发 · 当地时间）
                          <select className={inputCls} value={returnScheduleId} onChange={(e) => { setReturnScheduleId(e.target.value); setReturnCabin(''); }} disabled={!returnFlightId}>
                            <option value="">{returnDate ? '选择当日班次…' : '选择班次…'}</option>
                            {returnSchedulesForDate.map((s) => (
                              <option key={s.id} value={s.id}>
                                {localYmd(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                              </option>
                            ))}
                          </select>
                          {returnFlightId && returnDate && returnSchedulesForDate.length === 0 && (
                            <span className="mt-1 block text-[11px] text-amber-600">该日期无班次，请换个日期或清空日期查看全部。</span>
                          )}
                        </label>
                        <label className="text-xs text-slate-500">
                          舱位
                          <select className={inputCls} value={returnCabin} onChange={(e) => setReturnCabin(e.target.value as CabinClass)} disabled={!returnScheduleId}>
                            <option value="">选择舱位…</option>
                            {returnCabinOptions.map((c) => (
                              <option key={c.id} value={c.cabin}>
                                {CABIN_ZH[c.cabin] ?? c.cabin}（{cabinAvailText(c.available)}）¥{Number(c.basePrice).toFixed(0)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="mt-1.5 text-[11px] text-slate-400">回程与出港可以是不同航班/日期，往返共用同一批出行人（人数不翻倍）。</p>
                    </div>
                  )}

                  <p className="text-[11px] text-slate-400">数量按下方有效出行人数自动计（每人 1 张{flightTripType === 'ROUNDTRIP' ? '，去程/回程各一张' : ''}）。</p>
                </div>
              )}

              {kind === 'HOTEL' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500">
                    酒店
                    <select className={inputCls} value={hotelId} onChange={(e) => { setHotelId(e.target.value); setRoomTypeId(''); }}>
                      <option value="">选择酒店…</option>
                      {/* 星级随机档：客人只认星级、不指定酒店，占同星级酒店的合计余量，之后由房控落位 */}
                      <optgroup label="星级随机（不指定酒店，之后由房控落位）">
                        {RANDOM_STAR_TIERS.map((tier) => (
                          <option key={tier} value={poolOptionValue(tier)}>{randomStarTierLabel(tier)}</option>
                        ))}
                      </optgroup>
                      <optgroup label="具体酒店">
                        {hotels.map((h) => (
                          <option key={h.id} value={h.id}>{h.name}（{h.cityCode}）</option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                  {poolTier == null ? (
                    <label className="text-xs text-slate-500">
                      房型
                      <select className={inputCls} value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} disabled={!hotelId}>
                        <option value="">选择房型…</option>
                        {(hotel?.roomTypes ?? []).map((rt) => (
                          <option key={rt.id} value={rt.id}>{rt.name} ¥{Number(rt.basePrice).toFixed(0)}/晚</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="text-xs text-slate-500">
                      每间每晚售价(¥)
                      <NumberInput className={inputCls} value={poolNightlyPrice} onChange={setPoolNightlyPrice} min={0} placeholder="按谈定的随机价填" />
                    </label>
                  )}
                  <label className="text-xs text-slate-500">
                    入住日期
                    <input type="date" className={inputCls} value={checkIn} max={checkOut || undefined} onChange={(e) => setCheckIn(e.target.value)} />
                  </label>
                  <label className="text-xs text-slate-500">
                    退房日期
                    <input type="date" className={inputCls} value={checkOut} min={checkIn || undefined} onChange={(e) => setCheckOut(e.target.value)} />
                  </label>
                  <label className="text-xs text-slate-500">
                    间数
                    <NumberInput className={inputCls} value={rooms} onChange={setRooms} integerOnly min={1} placeholder="1" />
                  </label>
                  <div className="text-xs text-slate-400 self-end pb-1">
                    {poolTier != null
                      ? `${checkIn && checkOut && nightsBetween(checkIn, checkOut) > 0 ? `共 ${nightsBetween(checkIn, checkOut)} 晚 · ` : ''}占${poolTier} 星酒店的合计余量 · 同星级余量不足会被系统拦下`
                      : checkIn && checkOut && nightsBetween(checkIn, checkOut) > 0
                        ? `共 ${nightsBetween(checkIn, checkOut)} 晚 · 价格由系统按房型重算`
                        : '价格由系统按房型重算'}
                  </div>
                </div>
              )}

              {kind === 'VISA' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500">
                    签证产品
                    <select className={inputCls} value={visaId} onChange={(e) => setVisaId(e.target.value)}>
                      <option value="">选择签证…</option>
                      {visas.map((v) => (
                        <option key={v.id} value={v.id}>{v.visaName ?? v.visaType}（{v.destinationCountry}）¥{Number(v.basePrice).toFixed(0)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    份数
                    <NumberInput className={inputCls} value={visaQty} onChange={setVisaQty} integerOnly min={1} placeholder="1" />
                  </label>
                  {/* 加急档位：仅当该签证产品配了档位表才出现（未配 = 沿用不加急口径，界面不变）。
                      只选档名，加价由系统按产品配置算——运营改档价，录单这里自动跟着走。 */}
                  {visaExpressTiers.length > 0 && (
                    <label className="text-xs text-slate-500 md:col-span-2">
                      加急档位
                      <select
                        className={inputCls}
                        value={visaExpressTierLabel}
                        onChange={(e) => setVisaExpressTierLabel(e.target.value)}
                      >
                        <option value="">不加急（{visa?.processingDays ?? '—'} 个工作日出签）</option>
                        {visaExpressTiers.map((t) => (
                          <option key={t.label} value={t.label}>
                            {t.label} · {t.workDays} 个工作日 · +¥{t.surchargeCny.toLocaleString()}/份
                          </option>
                        ))}
                      </select>
                      <span className="mt-0.5 block text-[11px] text-slate-400">
                        加急费按份收，金额由系统按产品配置算（档位在 产品管理 › 签证 里维护）
                      </span>
                    </label>
                  )}
                  <p className="md:col-span-2 text-[11px] text-slate-400">签证含送签材料，下方每位出行人须填写护照有效期（必填）。份数应与出行人数一致。</p>
                </div>
              )}

              {kind === 'BUNDLE' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500 md:col-span-2">
                    套餐
                    <SearchSelect
                      className="mt-1"
                      options={bundleSelectOptions}
                      value={bundleId || null}
                      onChange={setBundleId}
                      placeholder="搜索套餐（编号 / 名称）…"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    出发日期
                    <input type="date" className={inputCls} value={departDate} onChange={(e) => setDepartDate(e.target.value)} />
                  </label>
                  {/* 机票航段：按「出发日期」自动派生去程（MFM→DAD）+ 回程（DAD→MFM），扣两段座位。只读展示。 */}
                  <div className="md:col-span-2 grid gap-2 rounded-md bg-white/70 p-2.5 ring-1 ring-slate-200">
                    <p className="text-[11px] text-slate-500">
                      机票航段 · 按出发日期自动匹配去程/回程班次（时间为当地时间），下单时扣减两段座位并进票务待办
                    </p>
                    {!bundle || !departDate ? (
                      <p className="text-[11px] text-slate-400">选择套餐和出发日期后自动派生航段…</p>
                    ) : (
                      <>
                        {/* 去程航班号手选：套餐未绑定航班号且该路线有多个在飞航班时，必须由运营指定，避免默认取第一班 */}
                        {bundleGoNeedsPick && (
                          <label className="text-[11px] text-slate-500">
                            去程航班号（该路线有多个航班，请选择）
                            <select
                              className={inputCls}
                              value={bundleGoFlightId}
                              onChange={(e) => setBundleGoFlightId(e.target.value)}
                            >
                              <option value="">选择去程航班…</option>
                              {bundleGoFlights.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.flightNumber} {f.originCode}→{f.destinationCode}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        {/* 去程班次状态 */}
                        {bundleGoNeedsPick && !bundleGoFlightId ? (
                          <div className="text-[11px] text-amber-600">
                            该路线有多个航班号，请先选择去程航班号
                          </div>
                        ) : bundleLegs.go ? (
                          <div className="flex items-center gap-2 text-xs text-slate-700">
                            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand">去程</span>
                            <span className="font-medium">{BUNDLE_GO_ORIGIN}→{BUNDLE_GO_DEST}</span>
                            <span className="text-slate-500">
                              {localYmd(bundleLegs.go.departureTime, bundleLegs.go.departureTz)}{' '}
                              {formatLocalTime(bundleLegs.go.departureTime, bundleLegs.go.departureTz)}
                            </span>
                          </div>
                        ) : (
                          <div className="text-[11px] text-rose-600">
                            <Icon name="alert" /> {departDate} 没有匹配的去程班次（{BUNDLE_GO_ORIGIN}→{BUNDLE_GO_DEST}），请换日期或先建班次
                          </div>
                        )}
                        {/* 回程（仅往返套餐） */}
                        {bundleIsRoundTrip && (
                          <>
                            {/* 回程航班号手选：同去程逻辑 */}
                            {bundleRetNeedsPick && (
                              <label className="text-[11px] text-slate-500">
                                回程航班号（该路线有多个航班，请选择）
                                <select
                                  className={inputCls}
                                  value={bundleRetFlightId}
                                  onChange={(e) => setBundleRetFlightId(e.target.value)}
                                >
                                  <option value="">选择回程航班…</option>
                                  {bundleRetFlights.map((f) => (
                                    <option key={f.id} value={f.id}>
                                      {f.flightNumber} {f.originCode}→{f.destinationCode}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                            {bundleRetNeedsPick && !bundleRetFlightId ? (
                              <div className="text-[11px] text-amber-600">
                                该路线有多个航班号，请先选择回程航班号
                              </div>
                            ) : bundleLegs.ret ? (
                              <div className="flex items-center gap-2 text-xs text-slate-700">
                                <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand">回程</span>
                                <span className="font-medium">{BUNDLE_GO_DEST}→{BUNDLE_GO_ORIGIN}</span>
                                <span className="text-slate-500">
                                  {localYmd(bundleLegs.ret.departureTime, bundleLegs.ret.departureTz)}{' '}
                                  {formatLocalTime(bundleLegs.ret.departureTime, bundleLegs.ret.departureTz)}
                                </span>
                              </div>
                            ) : (
                              <div className="text-[11px] text-rose-600">
                                <Icon name="alert" /> 回程日期 {bundleLegs.returnDate} 没有匹配的回程班次（{BUNDLE_GO_DEST}→{BUNDLE_GO_ORIGIN}），请核对套餐晚数/排班
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-xs text-slate-500">
                      成人
                      <NumberInput className={inputCls} value={adultCount} onChange={setAdultCount} integerOnly min={0} placeholder="1" />
                    </label>
                    <label className="text-xs text-slate-500">
                      儿童（占座）
                      <NumberInput className={inputCls} value={childCount} onChange={setChildCount} integerOnly min={0} placeholder="0" />
                    </label>
                    <label className="text-xs text-slate-500">
                      婴儿（不占座）
                      <NumberInput className={inputCls} value={infantCount} onChange={setInfantCount} integerOnly min={0} placeholder="0" />
                    </label>
                  </div>
                  {/* 商务舱升级：去程 / 回程分开填 —— 只升去程、或两程升的人数不同都很常见，
                      合成一个数字会按「两程都升」收钱。单程套餐（legs=1）只显示去程。
                      单住 / 自备签已改为「逐位选择」，见下方出行人表两列。 */}
                  <div className={`grid gap-2 md:col-span-2 ${(bundle?.legs ?? 2) >= 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    <label className="text-xs text-slate-500">
                      去程升舱人数
                      <NumberInput
                        className={inputCls}
                        value={businessCountOutbound}
                        onChange={setBusinessCountOutbound}
                        integerOnly
                        min={0}
                        max={Math.max(0, (adultCount ?? 0) + (childCount ?? 0))}
                        placeholder="0"
                      />
                      <span className="mt-0.5 block text-[11px] text-slate-400">最多 {(adultCount ?? 0) + (childCount ?? 0)} 人</span>
                    </label>
                    {(bundle?.legs ?? 2) >= 2 && (
                      <label className="text-xs text-slate-500">
                        回程升舱人数
                        <NumberInput
                          className={inputCls}
                          value={businessCountReturn}
                          onChange={setBusinessCountReturn}
                          integerOnly
                          min={0}
                          max={Math.max(0, (adultCount ?? 0) + (childCount ?? 0))}
                          placeholder="0"
                        />
                        <span className="mt-0.5 block text-[11px] text-slate-400">只升去程就把这里留 0</span>
                      </label>
                    )}
                  </div>
                  {/* 指定酒店（0805）：不指定 = 随机（现状）；指定 → 占该店房 + 按该店配置的每人加价收 */}
                  <div className="grid grid-cols-2 gap-2 md:col-span-2">
                    {bundle?.settlementTier && (
                      <p className="col-span-2 text-[11px] text-slate-500">
                        本套餐档次：{SETTLEMENT_TIER_ZH[bundle.settlementTier]}
                        {bundle.settlementNights != null ? ` · ${bundle.settlementNights} 晚` : ''}
                      </p>
                    )}
                    <label className="text-xs text-slate-500">
                      酒店（不选 = 随机）
                      <select
                        className={inputCls}
                        value={designatedHotelId}
                        onChange={(e) => {
                          const id = e.target.value;
                          setDesignatedHotelId(id);
                          // 换店自动选首个房型（多数店只有一个房型，免一次点击）；清空则回随机。
                          const h = hotels.find((x) => x.id === id);
                          setDesignatedRoomTypeId(h?.roomTypes[0]?.id ?? '');
                        }}
                      >
                        <option value="">随机（不指定酒店）</option>
                        <optgroup label="具体酒店">
                          {bundleRealHotels.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.name}（{'★'.repeat(h.starRating)}
                              {h.designationSurchargeCnyPerPerson > 0 ? ` · 指定+¥${h.designationSurchargeCnyPerPerson}/人` : ''}）
                            </option>
                          ))}
                        </optgroup>
                        {/* 星级随机档占位记录（randomTierPlaceholder != null）：不是真酒店，不删/不 disabled——
                            服务端显式支持指到占位酒店（房量闸走随机档聚合闸）；套餐要走随机档应把上面留空。 */}
                        {bundlePlaceholderHotels.length > 0 && (
                          <optgroup label="星级随机档占位（不是真实酒店，走随机档请留空）">
                            {bundlePlaceholderHotels.map((h) => (
                              <option key={h.id} value={h.id}>
                                {h.name}（{'★'.repeat(h.starRating)} · 占位，非真实酒店）
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </label>
                    {designatedHotelId && (
                      <label className="text-xs text-slate-500">
                        房型
                        <select className={inputCls} value={designatedRoomTypeId} onChange={(e) => setDesignatedRoomTypeId(e.target.value)}>
                          <option value="">选择房型…</option>
                          {hotels.find((h) => h.id === designatedHotelId)?.roomTypes.map((rt) => (
                            <option key={rt.id} value={rt.id}>{rt.name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {designatedHotelId && (() => {
                      const h = hotels.find((x) => x.id === designatedHotelId);
                      const rate = h?.designationSurchargeCnyPerPerson ?? 0;
                      const pax = Math.max(0, (adultCount ?? 0) + (childCount ?? 0));
                      return (
                        <p className="col-span-2 text-[11px] text-slate-500">
                          {rate > 0
                            ? `指定酒店加价 ¥${rate}/人 × ${pax} 人（占座人数）= ¥${rate * pax}，已计入下方系统价试算。`
                            : '该酒店未配置「指定酒店加价」（按 ¥0 计）；如需加价请先到 产品 · 酒店 里配置。'}
                        </p>
                      );
                    })()}
                    {designatedHotelIsPlaceholder && (
                      <p className="col-span-2 text-[11px] text-amber-600">
                        「{designatedHotel?.name}」是星级随机档的占位记录，不是真实酒店，不会真的落到这家店。套餐要走随机档，请把上面的「酒店」清空（选「随机（不指定酒店）」）。
                      </p>
                    )}
                    {designatedHotelStarMismatch && bundle?.settlementTier && (
                      <p className="col-span-2 text-[11px] text-amber-600">
                        「{designatedHotel?.name}」是{designatedHotel?.starRating}星，与本套餐档次「{SETTLEMENT_TIER_ZH[bundle.settlementTier]}」（{bundleSettlementStar}星）不一致，确认是否选错酒店。
                      </p>
                    )}
                  </div>
                  <p className="md:col-span-2 text-[11px] text-slate-400">
                    成人 + 儿童 + 婴儿都是出行人（都需护照，下方逐位填）。
                    <span className="text-slate-500">住宿（拼房/单住）与签证（随套餐/自备签）在下方出行人表里每人各选</span>，
                    机票/房/价格由系统按套餐权威重算。
                  </p>
                </div>
              )}

              {kind === 'TRANSFER' && (
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-xs text-slate-500 md:col-span-2">
                    接送产品
                    <select className={inputCls} value={transferId} onChange={(e) => setTransferId(e.target.value)}>
                      <option value="">选择接送…</option>
                      {transfers.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}（{t.originArea}→{t.destArea}）¥{Number(t.basePrice).toFixed(0)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    数量
                    <NumberInput className={inputCls} value={transferQty} onChange={setTransferQty} integerOnly min={1} placeholder="1" />
                  </label>
                  <label className="text-xs text-slate-500 md:col-span-3">
                    用车日期
                    <input type="date" className={inputCls} value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
                  </label>
                </div>
              )}
            </div>

            {/* 联系人（选填；默认=录入人本人，可改） */}
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs text-slate-500">
                联系人姓名（默认本人）
                <input className={inputCls} value={contactName} onChange={(e) => setContactName(e.target.value)} />
              </label>
              <label className="text-xs text-slate-500">
                联系电话（选填）
                <input className={inputCls} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              </label>
              <label className="text-xs text-slate-500">
                联系邮箱（选填）
                <input className={inputCls} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
              </label>
            </div>

            {/* 归属代理 + 录入人 + 备注 */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="text-xs text-slate-500">
                {isAgentUser ? (
                  <>
                    订单归属
                    {/* 服务端对 AGENT 强制归属本代理（resolveOrderAgentId 无视前端选择），
                        给下拉只会造成「以为能替子代理记单」的错觉，这里直接展示事实。 */}
                    <div className="mt-1 flex h-[34px] items-center rounded-md bg-slate-50 px-2.5 text-sm text-slate-700">
                      本代理
                      <span className="ml-2 text-xs text-slate-400">（系统自动归属）</span>
                    </div>
                  </>
                ) : (
                  <>
                    归属代理（代为录单；直客留空）
                    <input
                      className={inputCls}
                      placeholder="搜索代理：公司名 / 联系人 / 电话"
                      value={agentSearch}
                      onChange={(e) => setAgentSearch(e.target.value)}
                    />
                    <select className={`${inputCls} mt-2`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                      <option value="">— 无代理 / 直客 —</option>
                      {filteredAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.companyName ? `${a.companyName} · ` : ''}{a.contactName}（{a.contactPhone}）
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              <div className="text-xs text-slate-500">
                录入人
                <div className="mt-1 flex h-[34px] items-center rounded-md bg-slate-50 px-2.5 text-sm text-slate-700">
                  {recorderLabel}
                  <span className="ml-2 text-xs text-slate-400">（系统自动记录）</span>
                </div>
                <label className="mt-2 block text-xs text-slate-500">
                  备注（选填，写入订单）
                  <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
              </div>
            </div>

            {/* 签证状态 + 结构化备注（酒店 / 签证 / 付款 / 特殊要求） */}
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs text-slate-500">
                  签证状态
                  <select
                    className={inputCls}
                    value={visaStatus}
                    onChange={(e) => {
                      visaStatusTouchedRef.current = true;
                      const next = e.target.value as VisaStatusInput;
                      setVisaStatus(next);
                      // 单向联动（公测反馈：整单选了不需要还要逐个人再选一遍）：改成「不需要」时，
                      // 若当前是套餐单且签证列在显示，把现有出行人一次性批量置为自备签；
                      // 改回其它值不做任何反向还原，不动用户已经逐位调整过的选择。
                      if (next === 'NOT_NEEDED' && kind === 'BUNDLE' && showVisaExemptCol) {
                        setPassengers((prev) => {
                          const updated = prev.map((r) => ({ ...r, visaExempt: true }));
                          passengersRef.current = updated;
                          return updated;
                        });
                      }
                    }}
                  >
                    {(Object.keys(VISA_STATUS_LABEL) as VisaStatusInput[]).map((v) => (
                      <option key={v} value={v}>{VISA_STATUS_LABEL[v]}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-500">
                  酒店情况（选填）
                  <input className={inputCls} value={noteHotel} maxLength={300} onChange={(e) => setNoteHotel(e.target.value)} />
                </label>
                <label className="text-xs text-slate-500">
                  签证情况（选填）
                  <input className={inputCls} value={noteVisa} maxLength={300} onChange={(e) => setNoteVisa(e.target.value)} />
                </label>
                <label className="text-xs text-slate-500">
                  付款情况（选填）
                  <input className={inputCls} value={notePayment} maxLength={300} onChange={(e) => setNotePayment(e.target.value)} />
                </label>
                <label className="text-xs text-slate-500 md:col-span-2">
                  特殊要求（选填）
                  <input className={inputCls} value={noteSpecial} maxLength={300} onChange={(e) => setNoteSpecial(e.target.value)} />
                </label>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                默认按产品类型：签证 / 套餐默认「需要」，机票 / 酒店 / 接送默认「不需要」；切换产品类型后若未手动改过本下拉会自动跟随新默认值，手动选过则不再自动改。
              </p>
              {showVisaExemptCol && (
                <p className="mt-1 text-[11px] text-slate-400">
                  选「不需要」会把当前及新增出行人自动设为「自备签」（下方出行人表可逐位改回「随套餐」）；
                  反向不联动——单个乘客选自备签不会改变本订单级签证状态，自备签乘客不进签证台、套餐价按人扣减。
                </p>
              )}
            </div>

            {/* 出行人 */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">
                  出行人{passengersRequired ? <span className="text-rose-500"> *</span> : '（选填）'} · 共 {validPassengers.length} 位有效
                </span>
                <div className="flex items-center gap-3">
                  {/* 批量传护照：多选 → 逐张识别（并发 3）→ 自动生成出行人行 */}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    ref={bulkOcrInputRef}
                    onChange={(e) => {
                      // 先把 FileList 复制成数组：下一行 e.target.value='' 会清空 e.target.files，
                      // 若仍持有原 FileList 引用，其 length 立即变 0 → 批量识别"没反应/没放"。
                      const fs = e.target.files ? Array.from(e.target.files) : [];
                      e.target.value = '';
                      if (fs.length) void handleBulkOcrFiles(fs);
                    }}
                  />
                  <button
                    type="button"
                    className="text-sm text-brand hover:text-brand-dark disabled:opacity-50"
                    onClick={() => bulkOcrInputRef.current?.click()}
                    disabled={bulkOcr !== null}
                    title={`一次多选护照照片自动识别，最多 ${MAX_PHOTO_PASSENGERS} 张/单`}
                  >
                    {bulkOcr ? `识别中 ${bulkOcr.done}/${bulkOcr.total}…` : <><Icon name="camera" /> 批量传护照（≤{MAX_PHOTO_PASSENGERS}）</>}
                  </button>
                  <button className="text-sm text-brand hover:text-brand-dark" onClick={addPassenger} type="button">＋ 加一位</button>
                </div>
              </div>
              {autoVisaExemptForBundle && (
                <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  整单不需要签证 → 已按每位自备签计价（每人 −¥{selfVisaDeductPerPax.toLocaleString('zh-CN')}），可逐位改回
                </p>
              )}
              <div className="scrollbar-visible max-h-[28rem] overflow-x-auto overflow-y-auto rounded-md border border-slate-200">
                {/* 列宽用固定 min-width 直接标在每个 th/td 上（不用 col min-width——部分浏览器
                    的 auto-layout 表格不认 <col> 上的 min-width，只认 width，等于没生效）。
                    日期列需完整显示 YYYY-MM-DD 不被截断成「2026-」，姓名类列需够宽可读；
                    表格允许超过容器宽度，靠外层 overflow-x-auto 横向滚动兜底，不挤压/不截断任何一列。 */}
                <table className="min-w-max text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="min-w-[140px] whitespace-nowrap px-2 py-1.5 text-left font-normal">姓名</th>
                      {showRoomingCol && <th className="min-w-[150px] whitespace-nowrap px-2 py-1.5 text-left font-normal">住宿</th>}
                      {showVisaExemptCol && <th className="min-w-[120px] whitespace-nowrap px-2 py-1.5 text-left font-normal">签证</th>}
                      <th className="min-w-[140px] whitespace-nowrap px-2 py-1.5 text-left font-normal">护照号</th>
                      <th className="min-w-[120px] whitespace-nowrap px-2 py-1.5 text-left font-normal">出生日期</th>
                      <th className="min-w-[140px] whitespace-nowrap px-2 py-1.5 text-left font-normal">中文姓名</th>
                      <th className="min-w-[90px] whitespace-nowrap px-2 py-1.5 text-left font-normal">
                        性别<span className="text-rose-500"> *</span>
                      </th>
                      <th className="min-w-[120px] whitespace-nowrap px-2 py-1.5 text-left font-normal">护照签发日期</th>
                      <th className="min-w-[160px] whitespace-nowrap px-2 py-1.5 text-left font-normal">护照签发地点</th>
                      <th className="min-w-[120px] whitespace-nowrap px-2 py-1.5 text-left font-normal">
                        护照有效期{passengersRequired && <span className="text-rose-500"> *必填</span>}
                      </th>
                      {/* 签证出签日/生效日/有效期不在此处录入：这三项是签证岗出签后才拿得到的信息，
                          录单时无法预先知道（票务岗反馈：录单时不需要），改由签证台在出签后补录。 */}
                      <th className="min-w-[110px] whitespace-nowrap px-2 py-1.5 text-left font-normal">护照图</th>
                      <th className="min-w-[40px] px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {passengers.map((p, i) => {
                      const dobTouched = p.dateOfBirth.trim().length > 0;
                      const dobBad = dobTouched && parseDob(p.dateOfBirth) === null;
                      const issueTouched = (p.passportIssueDate ?? '').trim().length > 0;
                      const issueBad = issueTouched && parseDob(p.passportIssueDate ?? '') === null;
                      const ppExpiryTouched = (p.passportExpiry ?? '').trim().length > 0;
                      const ppExpiryBad = ppExpiryTouched && parseDob(p.passportExpiry ?? '') === null;
                      const isOcring = p.ocrPct !== null && p.ocrPct !== undefined && p.ocrPct < 100;
                      const reviewHint = ocrReviewHint(p);
                      return (
                        <Fragment key={i}>
                        <tr className="border-t border-slate-100">
                          <td
                            className="min-w-[140px] px-2 py-1 align-top"
                            onBlur={() => {
                              // 姓名脏格式（如 `ZHENG,/QINQIN`）在此边界统一规范化，避免污染导出名单。
                              const normalized = normalizePassengerFullName(p.fullName);
                              if (normalized !== p.fullName) setPassenger(i, { fullName: normalized });
                            }}
                          >
                            {/* 姓名联想：≥2 字符调常旅客 suggest，点选整行回填（AGENT 无联想） */}
                            <PassengerSuggestInput
                              className={`w-full rounded border px-1.5 py-1 text-sm ${hasFieldReview(p, 'fullName') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              value={p.fullName}
                              onChange={(v) => {
                                setPassenger(i, { fullName: v });
                                clearReviewField(i, 'fullName');
                              }}
                              onPick={(s) => applyProfileSuggestion(i, s)}
                            />
                          </td>
                          {/* 套餐乘客级：住宿方式（拼房默认/单住）+ 本人构成小字（能算则显示） */}
                          {showRoomingCol && (
                            <td className="min-w-[150px] px-2 py-1 align-top">
                              <select
                                className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm"
                                value={p.singleRoom ? 'single' : 'share'}
                                onChange={(e) => setPassenger(i, { singleRoom: e.target.value === 'single' })}
                              >
                                <option value="share">拼房</option>
                                <option value="single">单住</option>
                              </select>
                              {(() => {
                                const parts: string[] = ['套餐价'];
                                if (p.singleRoom && singleSupplementPerPax > 0) parts.push(`+单房差¥${singleSupplementPerPax.toLocaleString('zh-CN')}`);
                                if (p.visaExempt && selfVisaDeductPerPax > 0) parts.push(`−自备签¥${selfVisaDeductPerPax.toLocaleString('zh-CN')}`);
                                return parts.length > 1 ? (
                                  <span className="mt-0.5 block whitespace-nowrap text-[11px] text-slate-400">本人构成：{parts.join(' ')}</span>
                                ) : null;
                              })()}
                            </td>
                          )}
                          {/* 套餐乘客级：签证（随套餐默认/自备签）——仅套餐配了自备签减免额时显示 */}
                          {showVisaExemptCol && (
                            <td className="min-w-[120px] px-2 py-1 align-top">
                              <select
                                className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm"
                                value={p.visaExempt ? 'self' : 'bundle'}
                                onChange={(e) => setPassenger(i, { visaExempt: e.target.value === 'self' })}
                              >
                                <option value="bundle">随套餐</option>
                                <option value="self">自备签</option>
                              </select>
                            </td>
                          )}
                          <td className="min-w-[140px] px-2 py-1 align-top">
                            {/* 证件号联想：与姓名共用同一联想组件与整行回填 */}
                            <PassengerSuggestInput
                              className={`w-full rounded border px-1.5 py-1 text-sm ${hasFieldReview(p, 'documentNumber') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              value={p.documentNumber}
                              onChange={(v) => {
                                setPassenger(i, { documentNumber: v });
                                clearReviewField(i, 'documentNumber');
                              }}
                              onPick={(s) => applyProfileSuggestion(i, s)}
                            />
                          </td>
                          <td className="min-w-[120px] px-2 py-1 align-top">
                            <input
                              type="text"
                              inputMode="numeric"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${dobBad ? 'border-rose-400 bg-rose-50' : hasFieldReview(p, 'dateOfBirth') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              placeholder="YYYY-MM-DD"
                              value={p.dateOfBirth}
                              onChange={(e) => {
                                setPassenger(i, { dateOfBirth: e.target.value });
                                clearReviewField(i, 'dateOfBirth');
                              }}
                              onBlur={() => {
                                // 失焦即规范化显示值（如 2033/8/24 → 2033-08-24），让录入人看到即将提交的真实格式。
                                const normalized = parseDob(p.dateOfBirth);
                                if (normalized && normalized !== p.dateOfBirth) setPassenger(i, { dateOfBirth: normalized });
                              }}
                            />
                            {dobBad && <span className="mt-0.5 block whitespace-nowrap text-[11px] text-rose-500">格式如 1990-01-01</span>}
                          </td>
                          <td className="min-w-[140px] px-2 py-1 align-top">
                            <input
                              type="text"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${hasFieldReview(p, 'chineseName') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              placeholder="中文姓名（选填）"
                              value={p.chineseName ?? ''}
                              onChange={(e) => {
                                setPassenger(i, { chineseName: e.target.value });
                                clearReviewField(i, 'chineseName');
                              }}
                            />
                          </td>
                          <td className="min-w-[90px] px-2 py-1 align-top">
                            <select
                              className={`w-full rounded border px-1.5 py-1 text-sm ${hasFieldReview(p, 'gender') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              value={p.gender ?? ''}
                              onChange={(e) => {
                                setPassenger(i, { gender: (e.target.value || undefined) as 'M' | 'F' | 'X' | undefined });
                                clearReviewField(i, 'gender');
                              }}
                            >
                              <option value="">未选</option>
                              <option value="M">男 (M)</option>
                              <option value="F">女 (F)</option>
                              <option value="X">其他 (X)</option>
                            </select>
                          </td>
                          <td className="min-w-[120px] px-2 py-1 align-top">
                            <input
                              type="text"
                              inputMode="numeric"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${issueBad ? 'border-rose-400 bg-rose-50' : hasFieldReview(p, 'passportIssueDate') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              placeholder="YYYY-MM-DD（选填）"
                              value={p.passportIssueDate ?? ''}
                              onChange={(e) => {
                                setPassenger(i, { passportIssueDate: e.target.value });
                                clearReviewField(i, 'passportIssueDate');
                              }}
                              onBlur={() => {
                                const normalized = parseDob(p.passportIssueDate ?? '');
                                if (normalized && normalized !== p.passportIssueDate) setPassenger(i, { passportIssueDate: normalized });
                              }}
                            />
                            {issueBad && <span className="mt-0.5 block whitespace-nowrap text-[11px] text-rose-500">格式如 2018-01-01</span>}
                          </td>
                          <td className="min-w-[160px] px-2 py-1 align-top">
                            <input
                              type="text"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${hasFieldReview(p, 'passportIssuePlace') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              placeholder="如 广东省广州市（选填）"
                              value={p.passportIssuePlace ?? ''}
                              onChange={(e) => {
                                setPassenger(i, { passportIssuePlace: e.target.value });
                                clearReviewField(i, 'passportIssuePlace');
                              }}
                            />
                          </td>
                          <td className="min-w-[120px] px-2 py-1 align-top">
                            <input
                              type="text"
                              inputMode="numeric"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${ppExpiryBad ? 'border-rose-400 bg-rose-50' : hasFieldReview(p, 'passportExpiry') ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              placeholder="YYYY-MM-DD（选填）"
                              value={p.passportExpiry ?? ''}
                              onChange={(e) => {
                                setPassenger(i, { passportExpiry: e.target.value });
                                clearReviewField(i, 'passportExpiry');
                              }}
                              onBlur={() => {
                                const normalized = parseDob(p.passportExpiry ?? '');
                                if (normalized && normalized !== p.passportExpiry) setPassenger(i, { passportExpiry: normalized });
                              }}
                            />
                            {ppExpiryBad && <span className="mt-0.5 block whitespace-nowrap text-[11px] text-rose-500">格式如 2030-01-01</span>}
                          </td>
                          {/* 签证出签日/生效日/有效期不在此处录入：改由签证台在出签后补录（见表头注释） */}
                          <td className="min-w-[110px] px-2 py-1 align-top">
                            {/* 隐藏 file input */}
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              ref={(el) => { ocrInputRefs.current[i] = el; }}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                if (f) void handleOcrFile(i, f);
                              }}
                            />
                            {isOcring ? (
                              <div className="space-y-0.5">
                                <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200">
                                  <div
                                    className="h-full rounded-full bg-brand transition-all"
                                    style={{ width: `${p.ocrPct ?? 0}%` }}
                                  />
                                </div>
                                <span className="block text-[10px] text-slate-400 truncate max-w-[5rem]">{p.ocrStage}</span>
                              </div>
                            ) : p.passportPhotoUrl ? (
                              <div className="flex flex-col items-start gap-1">
                                <div className="flex items-center gap-1">
                                  <ProofImageViewer
                                    src={p.passportPhotoUrl}
                                    alt="护照"
                                    thumbClassName="h-7 w-10 rounded object-cover ring-1 ring-slate-200"
                                  />
                                  <button
                                    type="button"
                                    className="btn-ghost-danger px-1 py-0.5 text-[10px]"
                                    onClick={() => setPassenger(i, { passportPhotoUrl: undefined, ocrPct: null, ocrStage: undefined, ocrEngine: null, ocrModel: null, ocrFailed: false, reviewFields: undefined, mrzValid: null, localOcrCaveat: false })}
                                    title="移除图片"
                                  ><Icon name="close" /></button>
                                </div>
                                {/* OCR 引擎标签：max-w-full + truncate，长模型名不撑宽列；完整名进 title */}
                                {p.ocrEngine === 'ai' && (
                                  <span
                                    className="block max-w-full truncate rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-emerald-700 ring-1 ring-emerald-200"
                                    title={p.ocrModel ? `AI识别 · ${p.ocrModel}` : 'AI识别'}
                                  >
                                    AI识别{p.ocrModel ? ` · ${p.ocrModel}` : ''}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:border-brand hover:text-brand"
                                onClick={() => ocrInputRefs.current[i]?.click()}
                              >
                                OCR
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right align-top">
                            <button className="btn-ghost-danger px-1 py-0.5 text-xs" onClick={() => removePassenger(i)} disabled={passengers.length <= 1} type="button" aria-label={`删除第 ${i + 1} 位乘客`}><Icon name="trash" /></button>
                          </td>
                        </tr>
                        {reviewHint && (
                          <tr className="border-t-0">
                            <td colSpan={passengerColCount} className={`${p.ocrFailed ? 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200' : 'bg-amber-50 text-amber-700'} px-2 py-1 text-[11px]`}>
                              <Icon name="alert" /> {reviewHint}
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                <Icon name="camera" />「批量传护照」可一次多选，自动逐张识别并生成出行人；护照图最多 {MAX_PHOTO_PASSENGERS} 张/单，超出请分单录入。识别有需人工核对的字段时会在对应行下方标黄提示。
              </p>
              {!passengersRequired && (
                <p className="mt-1 text-[11px] text-slate-400">纯酒店/接送可不填出行人；留空时系统用联系人占位一位出行人。</p>
              )}
            </div>

            {/* 系统价（服务端权威试算）+ 录单调价/加项 */}
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">{isAgentUser ? '结算价' : '系统价（权威）'}</span>
                <span className="text-sm font-semibold text-slate-900">
                  {quoting
                    ? '试算中…'
                    : (isAgentUser ? agentHeaderTotal : quoteTotal) !== null
                      ? `¥${(isAgentUser ? agentHeaderTotal : quoteTotal)!.toLocaleString('zh-CN')}`
                      : '—'}
                </span>
              </div>
              {quoteErr && <p className="mt-1 text-[11px] text-rose-500">{quoteErr}</p>}
              {(agentId || isAgentUser) && settlementPrice === null && settlementPreview?.ok === true && (
                <div className="mt-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-800">
                  {(() => {
                    const autoDiscount = settlementPreview.autoDiscount;
                    const baseLines = settlementPreview.lines.filter((line) => line.note !== '同业立减');
                    const baseTotal = settlementPreview.totalCny + (autoDiscount?.totalCny ?? 0);
                    return (
                      <>
                        <div className="font-semibold">
                          结算价（日历）{baseLines.map((line, index) => (
                            <span key={`${line.note}-${index}`}>
                              {index > 0 ? ' + ' : ' '}
                              ¥{line.pricePerPersonCny.toLocaleString('zh-CN')}/人 × {line.pax}人
                              {line.addOnCny !== undefined && (
                                <>（加项 {line.addOnCny >= 0 ? '+' : '−'}¥{Math.abs(line.addOnCny).toLocaleString('zh-CN')}）</>
                              )}
                            </span>
                          ))}
                          {' = '}¥{baseTotal.toLocaleString('zh-CN')}
                        </div>
                        {autoDiscount?.hits.map((hit) => (
                          <div key={hit.ruleId} className="mt-0.5 font-medium text-emerald-700">
                            − 同业立减 ¥{hit.perPersonCny.toLocaleString('zh-CN')}/人 × {hit.pax}人
                          </div>
                        ))}
                        {autoDiscount && (
                          <div className="mt-0.5 font-semibold text-brand-900">
                            合计 ¥{settlementPreview.totalCny.toLocaleString('zh-CN')}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <div className="mt-0.5 text-[11px] text-brand-700">提交后订单总额按此收敛</div>
                </div>
              )}
              {(agentId || isAgentUser) && settlementPrice === null && settlementPreview?.ok === false && (
                <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  {settlementPreview.reason}——提交将被拒，{isAgentUser ? '请联系运营维护结算价' : '请先维护结算价日历'}
                </p>
              )}
              {agentId && settlementPrice !== null && (
                <p className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                  已填手工结算价，结算价日历不生效
                </p>
              )}
              {quoteTotal === null && !quoting && !quoteErr && (
                <p className="mt-1 text-[11px] text-slate-400">
                  {isAgentUser ? '填完产品与人数后自动试算结算价。' : '填完产品与人数后自动按系统权威价试算。'}
                </p>
              )}

              {isStaffUser && <div className="mt-3 border-t border-slate-100 pt-3">
                <div className="mb-1.5 text-xs font-medium text-slate-600">
                  价格调整（选填）— 优惠 / 补收杂费 / 变更改期费
                </div>
                <p className="mb-1.5 text-[11px] text-slate-400">
                  升舱/单人入住请用套餐加购选项（占真实库存）；换酒店走订单详情「换酒店」；签证改多签请更换签证产品——这些操作不要走调价，否则相关岗位看不到。
                </p>
                {isStaffUser && (
                  <>
                    <label className="mb-2 block text-xs text-slate-500">
                      本单结算总价（¥，选填：与代理谈定的一口价，系统照此收钱）
                      <NumberInput
                        className={inputCls}
                        value={settlementPrice}
                        onChange={setSettlementPrice}
                        placeholder={quoteTotal !== null ? `如 ${Math.round(quoteTotal)}` : '如 1500'}
                      />
                    </label>
                    {settlementPrice !== null && !settlementError && (
                      <div className="mb-1.5 flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5">
                        <span className="text-xs text-slate-500">结算价预览</span>
                        <span className="text-xs font-medium text-slate-700">
                          {settlementDiff !== null && quoteTotal !== null
                            ? `系统价 ¥${quoteTotal.toLocaleString('zh-CN')} · 结算价 ¥${settlementPrice.toLocaleString('zh-CN')} · 差额 ${settlementDiff >= 0 ? '+' : '−'}¥${Math.abs(settlementDiff).toLocaleString('zh-CN')}`
                            : `结算价 ¥${settlementPrice.toLocaleString('zh-CN')}（系统价试算中/不可用，差额以提交后服务端权威价为准）`}
                        </span>
                      </div>
                    )}
                    {settlementError && <p className="mb-1.5 text-[11px] text-rose-500">{settlementError}</p>}
                    {settlementConflict && <p className="mb-1.5 text-[11px] text-rose-500">{settlementConflict}</p>}
                    <p className="mb-1.5 text-[11px] text-slate-400">
                      填写后系统按「结算价 − 系统价」自动生成一条「代理结算价」调价行（不改明细行价格，留痕可审计）；与下方「调整金额」互斥，二选一。
                    </p>
                  </>
                )}
                <div className="grid gap-2 md:grid-cols-3">
                  <label className="text-xs text-slate-500">
                    调整金额（¥，可负=优惠）
                    <NumberInput
                      className={inputCls}
                      value={adjustAmount}
                      onChange={setAdjustAmount}
                      integerOnly
                      allowNegative
                      placeholder="如 700 或 -200"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    原因
                    <select
                      className={inputCls}
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value as PriceAdjustmentReason)}
                    >
                      {PRICE_ADJUSTMENT_REASON_OPTIONS.map((r) => (
                        <option key={r} value={r}>{PRICE_ADJUSTMENT_REASON_LABEL[r]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    说明{adjustReason === 'OTHER' ? <span className="text-rose-500"> *</span> : '（选填）'}
                    <input
                      className={inputCls}
                      value={adjustText}
                      maxLength={200}
                      onChange={(e) => setAdjustText(e.target.value)}
                      placeholder={adjustReason === 'OTHER' ? '必填：说明调整原因' : '可补充说明'}
                    />
                  </label>
                </div>
                {adjustError && <p className="mt-1 text-[11px] text-rose-500">{adjustError}</p>}
                {hasValidAdjustment && quoteTotal !== null && (
                  <div className="mt-2 flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5">
                    <span className="text-xs text-slate-500">调整后应付</span>
                    <span className="text-sm font-semibold text-slate-900">
                      ¥{(quoteTotal + (adjustAmount ?? 0)).toLocaleString('zh-CN')}
                      <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                        （系统价 {(adjustAmount ?? 0) > 0 ? '+' : '−'}¥{Math.abs(adjustAmount ?? 0).toLocaleString('zh-CN')}）
                      </span>
                    </span>
                  </div>
                )}
                <p className="mt-1.5 text-[11px] text-slate-400">
                  调价只在系统权威价上加减一笔并留审计记录；不会改动机票/酒店等基础项的权威价。
                </p>
              </div>}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <span className="text-xs text-slate-500">
                {isAgentUser
                  ? '结算价由系统按协议价自动计算；价格有疑问请联系运营。'
                  : '价格由系统按所选产品权威计算；如有优惠/加项请用上方「价格调整」。'}
              </span>
              <div className="flex gap-2">
                <button className="btn-secondary text-sm" onClick={onClose} type="button">取消</button>
                <button className="btn-primary text-sm disabled:opacity-50" onClick={submit} disabled={submitting} type="button">
                  {submitting ? '提交中…' : '提交录单'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
