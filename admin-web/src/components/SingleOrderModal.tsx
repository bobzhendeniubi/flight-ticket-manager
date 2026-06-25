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
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type AdminFlight,
  type AdminSchedule,
  type AgentListItem,
  type AiOcrPassportResult,
  type Bundle,
  type CabinClass,
  type CreateOrderInput,
  type CreateOrderItemInput,
  type Hotel,
  type OrderPassengerInput,
  type OrderSummary,
  type RoomGroup,
  type Transfer,
  type Visa,
  type VisaStatusInput,
  VISA_STATUS_LABEL,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from './NumberInput';
import { RoomingEditor, type RoomingPassenger } from './RoomingEditor';
import { type OcrResult } from '../lib/passportOcr';
import { formatLocalTime } from '../lib/airports';

// ── 产品类型 ──────────────────────────────────────────────────────────
type ProductKind = 'FLIGHT' | 'HOTEL' | 'VISA' | 'BUNDLE' | 'TRANSFER';

const KIND_TABS: Array<{ kind: ProductKind; label: string; icon: string }> = [
  { kind: 'FLIGHT', label: '机票', icon: '✈️' },
  { kind: 'HOTEL', label: '酒店', icon: '🏨' },
  { kind: 'VISA', label: '签证', icon: '🛂' },
  { kind: 'BUNDLE', label: '套餐', icon: '🎁' },
  { kind: 'TRANSFER', label: '接送', icon: '🚐' },
];

const CABIN_ZH: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

// FLIGHT / BUNDLE / VISA 必须填出行人；纯 HOTEL / TRANSFER 出行人选填。
const PASSENGERS_REQUIRED: Record<ProductKind, boolean> = {
  FLIGHT: true,
  BUNDLE: true,
  VISA: true,
  HOTEL: false,
  TRANSFER: false,
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
  /** 护照签发日期 YYYY-MM-DD（可选；OCR 填写或手动输入） */
  passportIssueDate?: string;
  /** 护照图 base64 data URL（OCR 识别后存入，随乘客一起提交给后端） */
  passportPhotoUrl?: string;
  /** OCR 识别进度 0-100；null = 未识别 */
  ocrPct?: number | null;
  /** OCR 识别阶段描述 */
  ocrStage?: string;
  /** OCR 引擎标签：'ai' | 'local' | 'ai-fallback' | null */
  ocrEngine?: 'ai' | 'local' | 'ai-fallback' | null;
  /** AI 识别时使用的模型名 */
  ocrModel?: string | null;
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

interface SingleOrderModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function SingleOrderModal({ onClose, onCreated }: SingleOrderModalProps) {
  const tokens = useAuth((s) => s.tokens);
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
  const [visaStatus, setVisaStatus] = useState<VisaStatusInput>('NEEDED');
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

  // ── 机票 ──
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [flightId, setFlightId] = useState('');
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [scheduleId, setScheduleId] = useState('');
  const [cabin, setCabin] = useState<CabinClass | ''>('');

  // ── 酒店 ──
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [hotelId, setHotelId] = useState('');
  const [roomTypeId, setRoomTypeId] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [rooms, setRooms] = useState<number | null>(1);

  // ── 签证 ──
  const [visas, setVisas] = useState<Visa[]>([]);
  const [visaId, setVisaId] = useState('');
  const [visaQty, setVisaQty] = useState<number | null>(1);

  // ── 套餐 ──
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [bundleId, setBundleId] = useState('');
  const [departDate, setDepartDate] = useState('');
  const [adultCount, setAdultCount] = useState<number | null>(1);
  const [childCount, setChildCount] = useState<number | null>(0);
  const [infantCount, setInfantCount] = useState<number | null>(0);
  // 单人入住（单房差）和商务舱升级，范围 0..(成人+儿童)
  const [singleCount, setSingleCount] = useState<number | null>(0);
  const [businessCount, setBusinessCount] = useState<number | null>(0);
  // 客人自备签证（套餐含签证时可勾选；勾选后服务端扣减 bundle.selfVisaDeductCny）
  const [selfProvidedVisa, setSelfProvidedVisa] = useState(false);
  // 套餐机票航段：不再手选，按「出发日期」自动派生。
  // 预拉两个方向的全部班次池，再按本地日期匹配去程（MFM→DAD）/回程（DAD→MFM）。
  const [bundleGoSchedulePool, setBundleGoSchedulePool] = useState<AdminSchedule[]>([]);
  const [bundleRetSchedulePool, setBundleRetSchedulePool] = useState<AdminSchedule[]>([]);

  // ── 接送 ──
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [transferId, setTransferId] = useState('');
  const [transferDate, setTransferDate] = useState('');
  const [transferQty, setTransferQty] = useState<number | null>(1);

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

  // 套餐机票航段：选了套餐 + 航班列表就绪后，预拉两个方向（去程 MFM→DAD / 回程 DAD→MFM）
  // 的全部班次池；后续按「出发日期」本地日期匹配派生具体班次。
  useEffect(() => {
    if (!token || kind !== 'BUNDLE' || !bundleId || flights.length === 0) {
      setBundleGoSchedulePool([]);
      setBundleRetSchedulePool([]);
      return;
    }
    const goFlight = flights.find(
      (f) => f.isActive && f.originCode === BUNDLE_GO_ORIGIN && f.destinationCode === BUNDLE_GO_DEST,
    );
    const retFlight = flights.find(
      (f) => f.isActive && f.originCode === BUNDLE_GO_DEST && f.destinationCode === BUNDLE_GO_ORIGIN,
    );
    if (goFlight) {
      api
        .listSchedules(token, goFlight.id)
        .then((r) => setBundleGoSchedulePool(r.schedules))
        .catch(() => setErr('去程班次加载失败'));
    } else {
      setBundleGoSchedulePool([]);
    }
    if (retFlight) {
      api
        .listSchedules(token, retFlight.id)
        .then((r) => setBundleRetSchedulePool(r.schedules))
        .catch(() => setErr('回程班次加载失败'));
    } else {
      setBundleRetSchedulePool([]);
    }
  }, [token, kind, bundleId, flights]);

  // 酒店列表
  useEffect(() => {
    if (kind !== 'HOTEL' || hotels.length > 0) return;
    api.listHotels(true).then((r) => setHotels(r.hotels)).catch(() => setErr('酒店列表加载失败'));
  }, [kind, hotels.length]);

  // 签证列表
  useEffect(() => {
    if (kind !== 'VISA' || visas.length > 0) return;
    api.listVisas(true).then((r) => setVisas(r.visas)).catch(() => setErr('签证列表加载失败'));
  }, [kind, visas.length]);

  // 套餐列表
  useEffect(() => {
    if (kind !== 'BUNDLE' || bundles.length > 0) return;
    api.listBundles(true).then((r) => setBundles(r.bundles)).catch(() => setErr('套餐列表加载失败'));
  }, [kind, bundles.length]);

  // 接送列表
  useEffect(() => {
    if (kind !== 'TRANSFER' || transfers.length > 0) return;
    api.listTransfers(true).then((r) => setTransfers(r.transfers)).catch(() => setErr('接送列表加载失败'));
  }, [kind, transfers.length]);

  const flight = flights.find((f) => f.id === flightId);
  const schedule = schedules.find((s) => s.id === scheduleId);
  const cabinOptions = schedule?.seatClasses ?? [];
  const hotel = hotels.find((h) => h.id === hotelId);
  const roomType = hotel?.roomTypes.find((rt) => rt.id === roomTypeId);
  const visa = visas.find((v) => v.id === visaId);
  const bundle = bundles.find((b) => b.id === bundleId);
  const transfer = transfers.find((t) => t.id === transferId);

  // 套餐航段自动派生：出发日期 → 去程班次（MFM→DAD，本地日期 == departDate）；
  // 晚数 → 回程日期 → 回程班次（DAD→MFM，本地日期 == returnDate）。仅往返套餐(legs≥2)派生回程。
  const bundleLegs = useMemo(() => {
    if (!bundle || !departDate) {
      return { go: null as AdminSchedule | null, ret: null as AdminSchedule | null, returnDate: '' };
    }
    const go =
      bundleGoSchedulePool
        .filter((s) => s.isActive && localYmd(s.departureTime, s.departureTz) === departDate)
        .sort((a, b) => a.departureTime.localeCompare(b.departureTime))[0] ?? null;
    const isRoundTrip = (bundle.legs ?? 2) >= 2;
    const nights = resolveBundleNights(bundle.items, bundle.hotelNights);
    const returnDate = isRoundTrip ? addDays(departDate, nights) : '';
    const ret = isRoundTrip
      ? bundleRetSchedulePool
          .filter((s) => s.isActive && localYmd(s.departureTime, s.departureTz) === returnDate)
          .sort((a, b) => a.departureTime.localeCompare(b.departureTime))[0] ?? null
      : null;
    return { go, ret, returnDate };
  }, [bundle, departDate, bundleGoSchedulePool, bundleRetSchedulePool]);

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

  function setPassenger(i: number, patch: Partial<PassengerRow>): void {
    setPassengers((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      passengersRef.current = next; // 即时同步 ref：并发 OCR 的上限计数读最新值
      return next;
    });
  }
  function addPassenger(): void {
    setPassengers((prev) => {
      const next = [...prev, emptyPassenger()];
      passengersRef.current = next;
      return next;
    });
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
      const toAppend = Array.from({ length: appendCount }, () => emptyPassenger());
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
   *   1. 先尝试后端 AI 识别（POST /ocr/passport）。
   *      configured:true 且 suggested 有结果 → 用 AI 结果（含 chineseName/passportIssueDate），
   *      显示绿色标签「AI识别 · {model}」。
   *   2. AI 未配置（configured:false）→ 直接本地 Tesseract，灰色标签「本地识别(tesseract)」。
   *   3. AI 配了但 suggested 为 null / 有 error → 回退本地 Tesseract，
   *      黄色标签「AI失败已回退本地」。
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
    setPassenger(idx, { ocrPct: 0, ocrStage: '加载中…', ocrEngine: null, ocrModel: null });

    // ── 1. 存库图压缩 ──
    let dataUrl = '';
    try {
      const { passportPhotoToDataUrl } = await import('../lib/passportOcr');
      dataUrl = await passportPhotoToDataUrl(file);
    } catch {
      dataUrl = '';
    }
    if (dataUrl) setPassenger(idx, { passportPhotoUrl: dataUrl });

    // ── 2. 尝试 AI 识别 ──
    if (token) {
      try {
        setPassenger(idx, { ocrPct: 20, ocrStage: 'AI 识别中…' });

        // 把压缩后（或原始）图片转成 data URL 发给后端
        const imageDataUrl = dataUrl || await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取失败'));
          reader.onerror = () => reject(new Error('读取失败'));
          reader.readAsDataURL(file);
        });

        const aiRes: AiOcrPassportResult = await api.ocrPassportAi(token, imageDataUrl);

        if (!aiRes.configured) {
          // 未配置 AI，直接走本地
          await runLocalOcr(idx, file, 'local');
          return;
        }

        // AI 有结果
        if (aiRes.suggested) {
          const s = aiRes.suggested;
          const patch: Partial<PassengerRow> = {
            ocrPct: 100,
            ocrStage: '识别完成',
            ocrEngine: 'ai',
            ocrModel: aiRes.model ?? null,
          };
          if (s.fullName) patch.fullName = s.fullName;
          if (s.documentNumber) patch.documentNumber = s.documentNumber;
          if (s.dateOfBirth) patch.dateOfBirth = s.dateOfBirth;
          if (s.chineseName) patch.chineseName = s.chineseName;
          if (s.passportIssueDate) patch.passportIssueDate = s.passportIssueDate;
          setPassenger(idx, patch);
          return;
        }

        // AI 配了但识别失败 → 回退本地
        await runLocalOcr(idx, file, 'ai-fallback');
        return;
      } catch {
        // 网络/后端异常 → 回退本地
        await runLocalOcr(idx, file, 'ai-fallback');
        return;
      }
    }

    // 无 token（不应出现，保险兜底）→ 本地
    await runLocalOcr(idx, file, 'local');
  }

  /** 本地 Tesseract 识别（备用路径） */
  async function runLocalOcr(idx: number, file: File, engine: 'local' | 'ai-fallback'): Promise<void> {
    try {
      const { ocrPassport } = await import('../lib/passportOcr');
      const result: OcrResult = await ocrPassport(file, (pct, stage) => {
        setPassenger(idx, { ocrPct: 20 + Math.round(pct * 0.8), ocrStage: stage });
      });

      const s = result.suggested;
      const patch: Partial<PassengerRow> = {
        ocrPct: 100,
        ocrStage: result.success ? '识别完成' : '识别不完整，请核对',
        ocrEngine: engine,
        ocrModel: null,
      };
      if (s.fullName) patch.fullName = s.fullName;
      if (s.passportNumber) patch.documentNumber = s.passportNumber;
      if (s.dateOfBirth) patch.dateOfBirth = s.dateOfBirth;
      setPassenger(idx, patch);
    } catch {
      setPassenger(idx, { ocrPct: null, ocrStage: undefined, ocrEngine: null, ocrModel: null });
    }
  }

  /** 构建当前产品类型的订单行；缺字段返回 { error }。 */
  function buildItem():
    | { item: CreateOrderItemInput }
    | { items: CreateOrderItemInput[] }
    | { error: string } {
    if (kind === 'FLIGHT') {
      if (!scheduleId || !cabin) return { error: '请选择航班班次和舱位' };
      const departDateStr = schedule ? schedule.departureTime.slice(0, 10) : '';
      const description =
        `${flight?.flightNumber ?? ''} ${flight?.originCode ?? ''}→${flight?.destinationCode ?? ''} ${departDateStr} ${CABIN_ZH[cabin] ?? cabin}`.trim();
      return {
        item: {
          kind: 'FLIGHT',
          description,
          quantity: Math.max(1, validPassengers.length || 1),
          flightScheduleId: scheduleId,
          flightCabin: cabin,
        },
      };
    }
    if (kind === 'HOTEL') {
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
      const description = `${visa?.visaName ?? visa?.visaType ?? '签证'}（${visa?.destinationCountry ?? ''}）× ${qty}份`;
      // 单价送签证当前 basePrice（不含加急；v1 不开加急选项）；服务端按 basePrice 校验（±1 元）。
      return {
        item: { kind: 'VISA', description, quantity: qty, visaId, unitPrice: Number(visa?.basePrice ?? 0) },
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
      const singles = Math.min(Math.max(0, singleCount ?? 0), maxSingleBusiness);
      const businesses = Math.min(Math.max(0, businessCount ?? 0), maxSingleBusiness);
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
      const descParts = [
        `${bundle?.name ?? '套餐'}`,
        departDate ? `${departDate}出发` : null,
        `${adults}成人${children ? `/${children}儿童` : ''}${infants ? `/${infants}婴儿` : ''}`,
        singles > 0 ? `单住×${singles}` : null,
        businesses > 0 ? `商务×${businesses}` : null,
        selfProvidedVisa ? '自备签证' : null,
      ].filter(Boolean).join(' · ');
      const bundleLine = {
        kind: 'BUNDLE' as const,
        description: descParts,
        quantity: 1,
        bundleId,
        unitPrice: 0, // 服务端权威重算（仅地面部分，机票走上面的 FLIGHT 行）
        adultCount: adults,
        childCount: children,
        infantCount: infants,
        singleCount: singles,
        businessCount: businesses,
        ...(selfProvidedVisa ? { selfProvidedVisa: true } : {}),
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

    const passengerPayload: OrderPassengerInput[] = validPassengers.map((p) => ({
      fullName: p.fullName.trim(),
      documentNumber: p.documentNumber.trim(),
      dateOfBirth: parseDob(p.dateOfBirth) ?? '',
      nationality: 'CN',
      ...(p.passportPhotoUrl ? { passportPhotoUrl: p.passportPhotoUrl } : {}),
      ...(p.chineseName?.trim() ? { chineseName: p.chineseName.trim() } : {}),
      ...(p.passportIssueDate?.trim() ? { passportIssueDate: p.passportIssueDate.trim() } : {}),
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
    };

    setSubmitting(true);
    try {
      const res = await api.createOrder(token, body);
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

  async function handleRoomingSave(groups: RoomGroup[]): Promise<void> {
    if (!createdOrder) return;
    await api.updateRoomAssignment(token, createdOrder.id, groups);
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
    setSelfProvidedVisa(false);
  }

  const inputCls = 'mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">录单（按产品类型 · 单笔）</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        {okOrderNumber ? (
          <div className="space-y-4 p-5">
            <div className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              ✓ 录单成功 · 订单号 <b className="font-mono">{okOrderNumber}</b>
              {roomingSaved && <span className="ml-2 text-emerald-700">· 分房已保存</span>}
            </div>

            {/* 录单后分房：进入分房编辑器 */}
            {showRooming && roomingPassengers.length > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-4">
                <RoomingEditor
                  passengers={roomingPassengers}
                  initial={createdOrder?.roomAssignment?.roomGroups}
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

            <div className="flex justify-end gap-2">
              {showRooming && (
                <button className="btn-ghost text-sm" onClick={() => setShowRooming(false)}>
                  跳过（稍后在房控页分）
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
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 各类型字段 */}
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
              {kind === 'FLIGHT' && (
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-xs text-slate-500">
                    航班
                    <select className={inputCls} value={flightId} onChange={(e) => { setFlightId(e.target.value); setScheduleId(''); setCabin(''); }}>
                      <option value="">选择航班…</option>
                      {flights.map((f) => (
                        <option key={f.id} value={f.id}>{f.flightNumber} {f.originCode}→{f.destinationCode}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    班次（出发 · 当地时间）
                    <select className={inputCls} value={scheduleId} onChange={(e) => { setScheduleId(e.target.value); setCabin(''); }} disabled={!flightId}>
                      <option value="">选择班次…</option>
                      {schedules.map((s) => (
                        <option key={s.id} value={s.id}>
                          {localYmd(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    舱位
                    <select className={inputCls} value={cabin} onChange={(e) => setCabin(e.target.value as CabinClass)} disabled={!scheduleId}>
                      <option value="">选择舱位…</option>
                      {cabinOptions.map((c) => (
                        <option key={c.id} value={c.cabin}>
                          {CABIN_ZH[c.cabin] ?? c.cabin}（余 {Math.max(0, c.available)}）¥{Number(c.basePrice).toFixed(0)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="md:col-span-3 text-[11px] text-slate-400">数量按下方有效出行人数自动计（每人 1 张）。</p>
                </div>
              )}

              {kind === 'HOTEL' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500">
                    酒店
                    <select className={inputCls} value={hotelId} onChange={(e) => { setHotelId(e.target.value); setRoomTypeId(''); }}>
                      <option value="">选择酒店…</option>
                      {hotels.map((h) => (
                        <option key={h.id} value={h.id}>{h.name}（{h.cityCode}）</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-500">
                    房型
                    <select className={inputCls} value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} disabled={!hotelId}>
                      <option value="">选择房型…</option>
                      {(hotel?.roomTypes ?? []).map((rt) => (
                        <option key={rt.id} value={rt.id}>{rt.name} ¥{Number(rt.basePrice).toFixed(0)}/晚</option>
                      ))}
                    </select>
                  </label>
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
                    {checkIn && checkOut && nightsBetween(checkIn, checkOut) > 0
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
                  <p className="md:col-span-2 text-[11px] text-slate-400">签证含送签材料，下方每位出行人需填护照有效期（详情页补录）。份数应与出行人数一致。</p>
                </div>
              )}

              {kind === 'BUNDLE' && (
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs text-slate-500 md:col-span-2">
                    套餐
                    <select className={inputCls} value={bundleId} onChange={(e) => setBundleId(e.target.value)}>
                      <option value="">选择套餐…</option>
                      {bundles.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
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
                        {/* 去程 */}
                        {bundleLegs.go ? (
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
                            ⚠ {departDate} 没有匹配的去程班次（{BUNDLE_GO_ORIGIN}→{BUNDLE_GO_DEST}），请换日期或先建班次
                          </div>
                        )}
                        {/* 回程（仅往返套餐） */}
                        {(bundle.legs ?? 2) >= 2 &&
                          (bundleLegs.ret ? (
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
                              ⚠ 回程日期 {bundleLegs.returnDate} 没有匹配的回程班次（{BUNDLE_GO_DEST}→{BUNDLE_GO_ORIGIN}），请核对套餐晚数/排班
                            </div>
                          ))}
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
                  {/* 单人入住（单房差）与商务舱升级 — 与前台同口径 */}
                  <label className="text-xs text-slate-500">
                    单人入住人数（单房差）
                    <NumberInput
                      className={inputCls}
                      value={singleCount}
                      onChange={setSingleCount}
                      integerOnly
                      min={0}
                      max={Math.max(0, (adultCount ?? 0) + (childCount ?? 0))}
                      placeholder="0"
                    />
                    <span className="mt-0.5 block text-[11px] text-slate-400">最多 {(adultCount ?? 0) + (childCount ?? 0)} 人</span>
                  </label>
                  <label className="text-xs text-slate-500">
                    商务舱升级人数
                    <NumberInput
                      className={inputCls}
                      value={businessCount}
                      onChange={setBusinessCount}
                      integerOnly
                      min={0}
                      max={Math.max(0, (adultCount ?? 0) + (childCount ?? 0))}
                      placeholder="0"
                    />
                    <span className="mt-0.5 block text-[11px] text-slate-400">最多 {(adultCount ?? 0) + (childCount ?? 0)} 人</span>
                  </label>
                  {/* 客人自备签证：仅当套餐配置了可扣减金额时显示 */}
                  {bundle && bundle.selfVisaDeductCny > 0 && (
                    <label className="md:col-span-2 flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                        checked={selfProvidedVisa}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setSelfProvidedVisa(next);
                          // 勾选时把订单级签证状态同步为「不需要」，与套餐价扣减口径一致；取消勾选不强行回写。
                          if (next) setVisaStatus('NOT_NEEDED');
                        }}
                      />
                      客人自备签证（−¥{bundle.selfVisaDeductCny}/单）
                    </label>
                  )}
                  <p className="md:col-span-2 text-[11px] text-slate-400">
                    成人 + 儿童 + 婴儿都是出行人（都需护照，下方逐位填）。机票/房/价格由系统按套餐权威重算。
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
                    onChange={(e) => setVisaStatus(e.target.value as VisaStatusInput)}
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
              <p className="mt-2 text-[11px] text-slate-400">机票 / 套餐默认「需要」签证；不涉及签证可选「不需要」。</p>
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
                    {bulkOcr ? `识别中 ${bulkOcr.done}/${bulkOcr.total}…` : `📷 批量传护照（≤${MAX_PHOTO_PASSENGERS}）`}
                  </button>
                  <button className="text-sm text-brand hover:text-brand-dark" onClick={addPassenger} type="button">＋ 加一位</button>
                </div>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-normal">姓名</th>
                      <th className="px-2 py-1.5 text-left font-normal">护照号</th>
                      <th className="px-2 py-1.5 text-left font-normal">出生日期</th>
                      <th className="px-2 py-1.5 text-left font-normal">中文姓名</th>
                      <th className="px-2 py-1.5 text-left font-normal">护照签发日期</th>
                      <th className="px-2 py-1.5 text-left font-normal">护照图</th>
                      <th className="px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {passengers.map((p, i) => {
                      const dobTouched = p.dateOfBirth.trim().length > 0;
                      const dobBad = dobTouched && parseDob(p.dateOfBirth) === null;
                      const issueTouched = (p.passportIssueDate ?? '').trim().length > 0;
                      const issueBad = issueTouched && parseDob(p.passportIssueDate ?? '') === null;
                      const isOcring = p.ocrPct !== null && p.ocrPct !== undefined && p.ocrPct < 100;
                      return (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-2 py-1">
                            <input className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={p.fullName} onChange={(e) => setPassenger(i, { fullName: e.target.value })} />
                          </td>
                          <td className="px-2 py-1">
                            <input className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm" value={p.documentNumber} onChange={(e) => setPassenger(i, { documentNumber: e.target.value })} />
                          </td>
                          <td className="px-2 py-1 align-top">
                            <input
                              type="text"
                              inputMode="numeric"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${dobBad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
                              placeholder="YYYY-MM-DD"
                              value={p.dateOfBirth}
                              onChange={(e) => setPassenger(i, { dateOfBirth: e.target.value })}
                            />
                            {dobBad && <span className="mt-0.5 block text-[11px] text-rose-500">格式如 1990-01-01</span>}
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="text"
                              className="w-full rounded border border-slate-300 px-1.5 py-1 text-sm"
                              placeholder="中文姓名（选填）"
                              value={p.chineseName ?? ''}
                              onChange={(e) => setPassenger(i, { chineseName: e.target.value })}
                            />
                          </td>
                          <td className="px-2 py-1 align-top">
                            <input
                              type="text"
                              inputMode="numeric"
                              className={`w-full rounded border px-1.5 py-1 text-sm ${issueBad ? 'border-rose-400 bg-rose-50' : 'border-slate-300'}`}
                              placeholder="YYYY-MM-DD（选填）"
                              value={p.passportIssueDate ?? ''}
                              onChange={(e) => setPassenger(i, { passportIssueDate: e.target.value })}
                            />
                            {issueBad && <span className="mt-0.5 block text-[11px] text-rose-500">格式如 2018-01-01</span>}
                          </td>
                          <td className="px-2 py-1 align-top">
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
                                  <a href={p.passportPhotoUrl} target="_blank" rel="noreferrer">
                                    <img src={p.passportPhotoUrl} alt="护照" className="h-7 w-10 rounded object-cover ring-1 ring-slate-200" />
                                  </a>
                                  <button
                                    type="button"
                                    className="text-[10px] text-slate-400 hover:text-rose-500"
                                    onClick={() => setPassenger(i, { passportPhotoUrl: undefined, ocrPct: null, ocrStage: undefined, ocrEngine: null, ocrModel: null })}
                                    title="移除图片"
                                  >✕</button>
                                </div>
                                {/* OCR 引擎标签 */}
                                {p.ocrEngine === 'ai' && (
                                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                                    AI识别{p.ocrModel ? ` · ${p.ocrModel}` : ''}
                                  </span>
                                )}
                                {p.ocrEngine === 'local' && (
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                                    本地识别(tesseract)
                                  </span>
                                )}
                                {p.ocrEngine === 'ai-fallback' && (
                                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                                    AI失败已回退本地
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
                          <td className="px-2 py-1 text-right">
                            <button className="text-xs text-slate-400 hover:text-rose-600" onClick={() => removePassenger(i)} disabled={passengers.length <= 1} type="button">删</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                📷「批量传护照」可一次多选，自动逐张识别并生成出行人；护照图最多 {MAX_PHOTO_PASSENGERS} 张/单，超出请分单录入。识别后请核对<span className="text-slate-500">中文名 / 签发日期</span>。
              </p>
              {!passengersRequired && (
                <p className="mt-1 text-[11px] text-slate-400">纯酒店/接送可不填出行人；留空时系统用联系人占位一位出行人。</p>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 pt-3">
              <span className="text-xs text-slate-500">价格由系统按所选产品权威计算，无需手填金额。</span>
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
