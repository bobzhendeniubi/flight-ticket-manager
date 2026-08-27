/**
 * 单笔录单 · 产品区块（机票 / 酒店 / 签证 / 接送）
 *
 * 一张订单可以挂多个产品区块 —— 「9/3–9/13 往返机票 + 只住一晚酒店」这类单不必再拆成两张订单。
 * 提交时各区块产出的订单行合并进同一个 POST /orders（后端 items 本就是多产品判别联合数组）。
 *
 * 套餐（BUNDLE）不在这里实现，且独占一张订单：套餐自带加项 / 指定酒店加价 / 升舱通道，
 * 与其它产品混挂会跟套餐盖章、批量优惠口径打架。区块类型枚举里保留 BUNDLE 只是为了让
 * 「当前这张单是套餐单」也能用同一个区块列表表达（字段仍由 SingleOrderModal 自己渲染）。
 *
 * 价格：区块只收集「产品引用 + 数量 / 日期」，金额一律由服务端权威重算。
 * HOTEL / VISA / TRANSFER 行带的 unitPrice 是给服务端做 ±1 元比对的产品现价占位，
 * 不是手填价口子（运营改不动它，改了会被服务端打回）。
 */
import { useEffect, useState } from 'react';
import {
  api,
  randomStarTierLabel,
  poolOptionValue,
  poolTierFromOptionValue,
  RANDOM_STAR_TIERS,
  type AdminFlight,
  type AdminSchedule,
  type CabinClass,
  type CreateOrderItemInput,
  type Hotel,
  type Transfer,
  type Visa,
} from '../lib/api';
import { NumberInput } from './NumberInput';
import { Icon, type IconName } from './Icon';
import { formatLocalTime } from '../lib/airports';

// ── 产品类型 ──────────────────────────────────────────────────────────
export type ProductBlockKind = 'FLIGHT' | 'HOTEL' | 'VISA' | 'TRANSFER' | 'BUNDLE';

/** 可以和别的产品混挂在同一张订单里的类型（套餐独占，不在此列）。 */
export const MIXABLE_BLOCK_KINDS = ['FLIGHT', 'HOTEL', 'VISA', 'TRANSFER'] as const;
export type MixableBlockKind = (typeof MIXABLE_BLOCK_KINDS)[number];

export const PRODUCT_BLOCK_TABS: Array<{ kind: ProductBlockKind; label: string; icon: IconName }> = [
  { kind: 'FLIGHT', label: '机票', icon: 'plane' },
  { kind: 'HOTEL', label: '酒店', icon: 'hotel' },
  { kind: 'VISA', label: '签证', icon: 'visa' },
  { kind: 'BUNDLE', label: '套餐', icon: 'gift' },
  { kind: 'TRANSFER', label: '接送', icon: 'car' },
];

export const PRODUCT_BLOCK_LABEL: Record<ProductBlockKind, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  VISA: '签证',
  TRANSFER: '接送',
  BUNDLE: '套餐',
};

/** FLIGHT / BUNDLE / VISA 必须填出行人；纯 HOTEL / TRANSFER 出行人选填。 */
export const BLOCK_PASSENGERS_REQUIRED: Record<ProductBlockKind, boolean> = {
  FLIGHT: true,
  BUNDLE: true,
  VISA: true,
  HOTEL: false,
  TRANSFER: false,
};

export const CABIN_ZH: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

/** 余位可能为负（超售口径不再钳 0），负数按「超售 N」展示，避免误读为可售。 */
export function cabinAvailText(available: number): string {
  if (available > 0) return `余 ${available}`;
  if (available === 0) return '售罄';
  return `超售 ${-available}`;
}

/** 入住→退房晚数；非正返回 0。 */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn);
  const b = new Date(checkOut);
  const diff = Math.round((b.getTime() - a.getTime()) / 86400_000);
  return diff > 0 ? diff : 0;
}

/**
 * 班次 departureTime 是 UTC ISO；departureTz 决定它属于哪一「天」。
 * 用 Intl parts 取本地年月日（en-CA → YYYY-MM-DD），跟 formatLocalDate 同口径，
 * 避免 UTC slice 跨日错位（08:40 vs 16:40 那类时区 bug 的根因）。
 */
export function localYmd(iso: string, tz: string): string {
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

/** ymd（YYYY-MM-DD）+ 天数 → 新日期（YYYY-MM-DD）。 */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ── 区块状态 ──────────────────────────────────────────────────────────

/**
 * 一个产品区块的表单值。字段按类型分组但存在同一个扁平对象里（只用当前 kind 的那组），
 * 换类型时整块重建（createProductBlock），不会带入上一类型的残留选择。
 */
export interface ProductBlock {
  /** React key + 子组件重挂标识；换类型会换新 id，好让内部班次列表等派生态一并复位。 */
  id: string;
  kind: ProductBlockKind;

  // ── FLIGHT ──
  tripType: 'ONEWAY' | 'ROUNDTRIP';
  flightId: string;
  flightDate: string;
  scheduleId: string;
  /** 选中班次的当地起飞日（YYYY-MM-DD）。落在区块状态里，让订单行描述不依赖异步班次列表。 */
  scheduleDate: string;
  cabin: CabinClass | '';
  returnFlightId: string;
  returnDate: string;
  returnScheduleId: string;
  returnScheduleDate: string;
  returnCabin: CabinClass | '';

  // ── HOTEL ──
  hotelId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  rooms: number | null;
  poolNightlyPrice: number | null;

  // ── VISA ──
  visaId: string;
  visaQty: number | null;
  visaExpressTierLabel: string;

  // ── TRANSFER ──
  transferId: string;
  transferDate: string;
  transferQty: number | null;
}

let blockSeq = 0;
function nextBlockId(): string {
  blockSeq += 1;
  return `pb-${Date.now().toString(36)}-${blockSeq}`;
}

export function createProductBlock(kind: ProductBlockKind): ProductBlock {
  return {
    id: nextBlockId(),
    kind,
    tripType: 'ONEWAY',
    flightId: '',
    flightDate: '',
    scheduleId: '',
    scheduleDate: '',
    cabin: '',
    returnFlightId: '',
    returnDate: '',
    returnScheduleId: '',
    returnScheduleDate: '',
    returnCabin: '',
    hotelId: '',
    roomTypeId: '',
    checkIn: '',
    checkOut: '',
    rooms: 1,
    poolNightlyPrice: null,
    visaId: '',
    visaQty: 1,
    visaExpressTierLabel: '',
    transferId: '',
    transferDate: '',
    transferQty: 1,
  };
}

// ── 区块 → 订单行 ─────────────────────────────────────────────────────

export interface ProductBlockBuildContext {
  flights: readonly AdminFlight[];
  hotels: readonly Hotel[];
  visas: readonly Visa[];
  transfers: readonly Transfer[];
  /** 机票行人数 = 本单有效出行人数（往返共用同一批出行人，人数不翻倍）。 */
  seatPax: number;
}

export type BuildBlockResult = { items: CreateOrderItemInput[] } | { error: string };

/**
 * 把一个区块转成订单行；缺字段返回 { error }。
 * 套餐区块不走这里（字段与定价都由 SingleOrderModal 的套餐分支负责）。
 */
export function buildProductBlockItems(
  block: ProductBlock,
  ctx: ProductBlockBuildContext,
): BuildBlockResult {
  if (block.kind === 'FLIGHT') return buildFlightItems(block, ctx);
  if (block.kind === 'HOTEL') return buildHotelItems(block, ctx);
  if (block.kind === 'VISA') return buildVisaItems(block, ctx);
  if (block.kind === 'TRANSFER') return buildTransferItems(block, ctx);
  return { error: '套餐区块不在此处生成订单行' };
}

function buildFlightItems(block: ProductBlock, ctx: ProductBlockBuildContext): BuildBlockResult {
  if (!block.scheduleId || !block.cabin) {
    return {
      error: block.tripType === 'ROUNDTRIP' ? '请选择出港航班班次和舱位' : '请选择航班班次和舱位',
    };
  }
  // 往返同一批出行人 → 每条 FLIGHT 行的 quantity 都 = 出行人数（不翻倍）；
  // FLIGHT 行不带单价，服务端按班次舱位权威定价。
  const seatPax = Math.max(1, ctx.seatPax || 1);
  const flight = ctx.flights.find((f) => f.id === block.flightId);
  const outLabel = block.tripType === 'ROUNDTRIP' ? '去程 ' : '';
  const outboundLine: CreateOrderItemInput = {
    kind: 'FLIGHT',
    description:
      `${outLabel}${flight?.flightNumber ?? ''} ${flight?.originCode ?? ''}→${flight?.destinationCode ?? ''} ${block.scheduleDate} ${CABIN_ZH[block.cabin] ?? block.cabin}`.trim(),
    quantity: seatPax,
    flightScheduleId: block.scheduleId,
    flightCabin: block.cabin,
  };
  if (block.tripType === 'ONEWAY') return { items: [outboundLine] };

  if (!block.returnScheduleId || !block.returnCabin) {
    return { error: '往返需选择回程航班班次和舱位' };
  }
  const returnFlight = ctx.flights.find((f) => f.id === block.returnFlightId);
  const returnLine: CreateOrderItemInput = {
    kind: 'FLIGHT',
    description:
      `回程 ${returnFlight?.flightNumber ?? ''} ${returnFlight?.originCode ?? ''}→${returnFlight?.destinationCode ?? ''} ${block.returnScheduleDate} ${CABIN_ZH[block.returnCabin] ?? block.returnCabin}`.trim(),
    quantity: seatPax,
    flightScheduleId: block.returnScheduleId,
    flightCabin: block.returnCabin,
  };
  return { items: [outboundLine, returnLine] };
}

function buildHotelItems(block: ProductBlock, ctx: ProductBlockBuildContext): BuildBlockResult {
  const poolTier = poolTierFromOptionValue(block.hotelId);
  // ── 星级随机池行：不选酒店/房型，占池库存，之后由房控落到具体酒店 ──
  if (poolTier != null) {
    if (!block.checkIn || !block.checkOut) return { error: '请填写入住和退房日期' };
    const poolNights = nightsBetween(block.checkIn, block.checkOut);
    if (poolNights < 1) return { error: '退房日期需晚于入住日期' };
    if (block.poolNightlyPrice == null || block.poolNightlyPrice <= 0) {
      return { error: `请填写${randomStarTierLabel(poolTier)}的每间每晚售价` };
    }
    const poolRoomQty = Math.max(1, block.rooms ?? 1);
    return {
      items: [
        {
          kind: 'HOTEL',
          description: `${randomStarTierLabel(poolTier)} · ${block.checkIn}~${block.checkOut} · ${poolNights}晚 × ${poolRoomQty}间`,
          // qty = 晚数（与具体酒店行同构）；金额 = 每间每晚价 × 晚数 × 间数。
          // 池行显式送 roomsBilled，让「收多少钱」「占几间池库存」是同一个数，不靠 metadata 反推。
          quantity: poolNights,
          randomStarTier: poolTier,
          checkIn: block.checkIn,
          checkOut: block.checkOut,
          unitPrice: block.poolNightlyPrice,
          roomsBilled: poolRoomQty,
          metadata: { rooms: poolRoomQty },
        },
      ],
    };
  }

  if (!block.roomTypeId) return { error: '请选择酒店和房型' };
  if (!block.checkIn || !block.checkOut) return { error: '请填写入住和退房日期' };
  const nights = nightsBetween(block.checkIn, block.checkOut);
  if (nights < 1) return { error: '退房日期需晚于入住日期' };
  const roomQty = Math.max(1, block.rooms ?? 1);
  const hotel = ctx.hotels.find((h) => h.id === block.hotelId);
  const roomType = hotel?.roomTypes.find((rt) => rt.id === block.roomTypeId);
  return {
    items: [
      {
        kind: 'HOTEL',
        description: `${hotel?.name ?? '酒店'} · ${roomType?.name ?? '房型'} · ${block.checkIn}~${block.checkOut} · ${nights}晚 × ${roomQty}间`,
        // qty = 晚数；服务端按「房型每晚 basePrice × 晚数」校验（±1 元）。
        // 单价送房型当前每晚价（服务端会比对，不一致则拒），房间数透传 metadata 供房控/分房参考。
        quantity: nights,
        hotelRoomTypeId: block.roomTypeId,
        checkIn: block.checkIn,
        checkOut: block.checkOut,
        unitPrice: Number(roomType?.basePrice ?? 0),
        metadata: { rooms: roomQty },
      },
    ],
  };
}

function buildVisaItems(block: ProductBlock, ctx: ProductBlockBuildContext): BuildBlockResult {
  if (!block.visaId) return { error: '请选择签证产品' };
  const qty = Math.max(1, block.visaQty ?? 1);
  const visa = ctx.visas.find((v) => v.id === block.visaId);
  // 加急档（运营在产品上配的零工/一工/二工…）：选中的档名随行 metadata 上送，
  // 加价金额一律由服务端按产品档位表查出（这里带上单价只是为了通过 ±1 元容差校验）。
  const tier = (visa?.expressTiers ?? []).find((t) => t.label === block.visaExpressTierLabel);
  return {
    items: [
      {
        kind: 'VISA',
        description:
          `${visa?.visaName ?? visa?.visaType ?? '签证'}（${visa?.destinationCountry ?? ''}）× ${qty}份` +
          (tier ? ` · 加急${tier.label}` : ''),
        quantity: qty,
        visaId: block.visaId,
        unitPrice: Number(visa?.basePrice ?? 0) + (tier?.surchargeCny ?? 0),
        ...(tier ? { metadata: { expressTierLabel: tier.label } } : {}),
      },
    ],
  };
}

function buildTransferItems(block: ProductBlock, ctx: ProductBlockBuildContext): BuildBlockResult {
  // 单价送接送当前 basePrice；服务端按 basePrice × qty 校验（±1 元）。
  if (!block.transferId) return { error: '请选择接送产品' };
  const qty = Math.max(1, block.transferQty ?? 1);
  const transfer = ctx.transfers.find((t) => t.id === block.transferId);
  return {
    items: [
      {
        kind: 'TRANSFER',
        description: `${transfer?.name ?? '接送'}${block.transferDate ? ` · ${block.transferDate}` : ''} × ${qty}`,
        quantity: qty,
        transferId: block.transferId,
        unitPrice: Number(transfer?.basePrice ?? 0),
        ...(block.transferDate ? { metadata: { date: block.transferDate } } : {}),
      },
    ],
  };
}

// ── 区块字段 UI ───────────────────────────────────────────────────────

export interface ProductBlockFieldsProps {
  block: ProductBlock;
  onPatch: (patch: Partial<ProductBlock>) => void;
  token: string;
  flights: readonly AdminFlight[];
  hotels: readonly Hotel[];
  visas: readonly Visa[];
  transfers: readonly Transfer[];
  /** 班次加载失败等非阻断错误回传给弹窗顶部统一展示；须传稳定引用（如 setState）。 */
  onLoadError: (message: string) => void;
  inputCls: string;
  /** 机票行数量按此计（本单有效出行人数），仅用于提示文案。 */
  seatPax: number;
}

export function ProductBlockFields({
  block,
  onPatch,
  token,
  flights,
  hotels,
  visas,
  transfers,
  onLoadError,
  inputCls,
  seatPax,
}: ProductBlockFieldsProps) {
  // 本区块自己的班次列表（每个机票区块各选各的航班，互不干扰）
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [returnSchedules, setReturnSchedules] = useState<AdminSchedule[]>([]);

  const flightId = block.kind === 'FLIGHT' ? block.flightId : '';
  const returnFlightId =
    block.kind === 'FLIGHT' && block.tripType === 'ROUNDTRIP' ? block.returnFlightId : '';

  useEffect(() => {
    if (!token || !flightId) {
      setSchedules([]);
      return;
    }
    let cancelled = false;
    api
      .listSchedules(token, flightId)
      .then((r) => {
        if (!cancelled) setSchedules(r.schedules);
      })
      .catch(() => onLoadError('班次加载失败'));
    return () => {
      cancelled = true;
    };
  }, [token, flightId, onLoadError]);

  useEffect(() => {
    if (!token || !returnFlightId) {
      setReturnSchedules([]);
      return;
    }
    let cancelled = false;
    api
      .listSchedules(token, returnFlightId)
      .then((r) => {
        if (!cancelled) setReturnSchedules(r.schedules);
      })
      .catch(() => onLoadError('回程班次加载失败'));
    return () => {
      cancelled = true;
    };
  }, [token, returnFlightId, onLoadError]);

  if (block.kind === 'FLIGHT') {
    const schedulesForDate = block.flightDate
      ? schedules.filter((s) => localYmd(s.departureTime, s.departureTz) === block.flightDate)
      : schedules;
    const returnSchedulesForDate = block.returnDate
      ? returnSchedules.filter((s) => localYmd(s.departureTime, s.departureTz) === block.returnDate)
      : returnSchedules;
    const cabinOptions = schedules.find((s) => s.id === block.scheduleId)?.seatClasses ?? [];
    const returnCabinOptions =
      returnSchedules.find((s) => s.id === block.returnScheduleId)?.seatClasses ?? [];

    /** 选中班次时一并存下当地起飞日，订单行描述据此拼（不依赖异步班次列表在不在手上）。 */
    const pickSchedule = (id: string, list: AdminSchedule[], isReturn: boolean): void => {
      const s = list.find((x) => x.id === id);
      const ymd = s ? localYmd(s.departureTime, s.departureTz) : '';
      onPatch(
        isReturn
          ? { returnScheduleId: id, returnScheduleDate: ymd, returnCabin: '' }
          : { scheduleId: id, scheduleDate: ymd, cabin: '' },
      );
    };

    return (
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
                  block.tripType === val
                    ? 'border-brand bg-brand-50 text-brand ring-1 ring-brand/20'
                    : 'border-slate-200 text-ink-soft hover:border-slate-300 hover:bg-slate-50'
                }`}
                onClick={() => onPatch({ tripType: val })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 出港航段 */}
        <div className="rounded-md border border-slate-200 bg-white/70 p-3">
          <div className="mb-2 text-xs font-medium text-slate-600">
            {block.tripType === 'ROUNDTRIP' ? '出港航班' : '航班'}
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-xs text-slate-500">
              航班
              <select
                className={inputCls}
                value={block.flightId}
                onChange={(e) =>
                  onPatch({
                    flightId: e.target.value,
                    scheduleId: '',
                    scheduleDate: '',
                    cabin: '',
                    flightDate: '',
                  })
                }
              >
                <option value="">选择航班…</option>
                {flights.map((f) => (
                  <option key={f.id} value={f.id}>{f.flightNumber} {f.originCode}→{f.destinationCode}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500">
              起飞日期（可手输）
              <input
                type="date"
                className={inputCls}
                value={block.flightDate}
                onChange={(e) => onPatch({ flightDate: e.target.value, scheduleId: '', scheduleDate: '', cabin: '' })}
                disabled={!block.flightId}
              />
            </label>
            <label className="text-xs text-slate-500">
              班次（出发 · 当地时间）
              <select
                className={inputCls}
                value={block.scheduleId}
                onChange={(e) => pickSchedule(e.target.value, schedules, false)}
                disabled={!block.flightId}
              >
                <option value="">{block.flightDate ? '选择当日班次…' : '选择班次…'}</option>
                {schedulesForDate.map((s) => (
                  <option key={s.id} value={s.id}>
                    {localYmd(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                  </option>
                ))}
              </select>
              {block.flightId && block.flightDate && schedulesForDate.length === 0 && (
                <span className="mt-1 block text-[11px] text-amber-600">该日期无班次，请换个日期或清空日期查看全部。</span>
              )}
            </label>
            <label className="text-xs text-slate-500">
              舱位
              <select
                className={inputCls}
                value={block.cabin}
                onChange={(e) => onPatch({ cabin: e.target.value as CabinClass })}
                disabled={!block.scheduleId}
              >
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
        {block.tripType === 'ROUNDTRIP' && (
          <div className="rounded-md border border-slate-200 bg-white/70 p-3">
            <div className="mb-2 text-xs font-medium text-slate-600">回程航班</div>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="text-xs text-slate-500">
                航班
                <select
                  className={inputCls}
                  value={block.returnFlightId}
                  onChange={(e) =>
                    onPatch({
                      returnFlightId: e.target.value,
                      returnScheduleId: '',
                      returnScheduleDate: '',
                      returnCabin: '',
                      returnDate: '',
                    })
                  }
                >
                  <option value="">选择航班…</option>
                  {flights.map((f) => (
                    <option key={f.id} value={f.id}>{f.flightNumber} {f.originCode}→{f.destinationCode}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                起飞日期（可手输）
                <input
                  type="date"
                  className={inputCls}
                  value={block.returnDate}
                  onChange={(e) =>
                    onPatch({ returnDate: e.target.value, returnScheduleId: '', returnScheduleDate: '', returnCabin: '' })
                  }
                  disabled={!block.returnFlightId}
                />
              </label>
              <label className="text-xs text-slate-500">
                班次（出发 · 当地时间）
                <select
                  className={inputCls}
                  value={block.returnScheduleId}
                  onChange={(e) => pickSchedule(e.target.value, returnSchedules, true)}
                  disabled={!block.returnFlightId}
                >
                  <option value="">{block.returnDate ? '选择当日班次…' : '选择班次…'}</option>
                  {returnSchedulesForDate.map((s) => (
                    <option key={s.id} value={s.id}>
                      {localYmd(s.departureTime, s.departureTz)} {formatLocalTime(s.departureTime, s.departureTz)}
                    </option>
                  ))}
                </select>
                {block.returnFlightId && block.returnDate && returnSchedulesForDate.length === 0 && (
                  <span className="mt-1 block text-[11px] text-amber-600">该日期无班次，请换个日期或清空日期查看全部。</span>
                )}
              </label>
              <label className="text-xs text-slate-500">
                舱位
                <select
                  className={inputCls}
                  value={block.returnCabin}
                  onChange={(e) => onPatch({ returnCabin: e.target.value as CabinClass })}
                  disabled={!block.returnScheduleId}
                >
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

        <p className="text-[11px] text-slate-400">
          数量按下方有效出行人数自动计（每人 1 张{block.tripType === 'ROUNDTRIP' ? '，去程/回程各一张' : ''}）
          {seatPax > 0 ? ` · 当前 ${seatPax} 人` : ''}。
        </p>
      </div>
    );
  }

  if (block.kind === 'HOTEL') {
    const poolTier = poolTierFromOptionValue(block.hotelId);
    const hotel = hotels.find((h) => h.id === block.hotelId);
    const nights = block.checkIn && block.checkOut ? nightsBetween(block.checkIn, block.checkOut) : 0;
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-500">
          酒店
          <select
            className={inputCls}
            value={block.hotelId}
            onChange={(e) => onPatch({ hotelId: e.target.value, roomTypeId: '' })}
          >
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
            <select
              className={inputCls}
              value={block.roomTypeId}
              onChange={(e) => onPatch({ roomTypeId: e.target.value })}
              disabled={!block.hotelId}
            >
              <option value="">选择房型…</option>
              {(hotel?.roomTypes ?? []).map((rt) => (
                <option key={rt.id} value={rt.id}>{rt.name} ¥{Number(rt.basePrice).toFixed(0)}/晚</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="text-xs text-slate-500">
            每间每晚售价(¥)
            <NumberInput
              className={inputCls}
              value={block.poolNightlyPrice}
              onChange={(v) => onPatch({ poolNightlyPrice: v })}
              min={0}
              placeholder="按谈定的随机价填"
            />
          </label>
        )}
        <label className="text-xs text-slate-500">
          入住日期
          <input
            type="date"
            className={inputCls}
            value={block.checkIn}
            max={block.checkOut || undefined}
            onChange={(e) => onPatch({ checkIn: e.target.value })}
          />
        </label>
        <label className="text-xs text-slate-500">
          退房日期
          <input
            type="date"
            className={inputCls}
            value={block.checkOut}
            min={block.checkIn || undefined}
            onChange={(e) => onPatch({ checkOut: e.target.value })}
          />
        </label>
        <label className="text-xs text-slate-500">
          间数
          <NumberInput
            className={inputCls}
            value={block.rooms}
            onChange={(v) => onPatch({ rooms: v })}
            integerOnly
            min={1}
            placeholder="1"
          />
        </label>
        <div className="self-end pb-1 text-xs text-slate-400">
          {poolTier != null
            ? `${nights > 0 ? `共 ${nights} 晚 · ` : ''}占${poolTier} 星酒店的合计余量 · 同星级余量不足会被系统拦下`
            : nights > 0
              ? `共 ${nights} 晚 · 价格由系统按房型重算`
              : '价格由系统按房型重算'}
        </div>
      </div>
    );
  }

  if (block.kind === 'VISA') {
    const visa = visas.find((v) => v.id === block.visaId);
    // 该签证产品配置的加急档位（未配 = 空数组 → 不显示加急下拉，行为与扩展前一致）。
    const visaExpressTiers = visa?.expressTiers ?? [];
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs text-slate-500">
          签证产品
          <select
            className={inputCls}
            value={block.visaId}
            // 换签证产品 → 清掉上一个产品的加急档选择（各产品档位表不同，档名残留会被服务端拒单）。
            onChange={(e) => onPatch({ visaId: e.target.value, visaExpressTierLabel: '' })}
          >
            <option value="">选择签证…</option>
            {visas.map((v) => (
              <option key={v.id} value={v.id}>{v.visaName ?? v.visaType}（{v.destinationCountry}）¥{Number(v.basePrice).toFixed(0)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          份数
          <NumberInput
            className={inputCls}
            value={block.visaQty}
            onChange={(v) => onPatch({ visaQty: v })}
            integerOnly
            min={1}
            placeholder="1"
          />
        </label>
        {/* 加急档位：仅当该签证产品配了档位表才出现（未配 = 沿用不加急口径，界面不变）。
            只选档名，加价由系统按产品配置算——运营改档价，录单这里自动跟着走。 */}
        {visaExpressTiers.length > 0 && (
          <label className="text-xs text-slate-500 md:col-span-2">
            加急档位
            <select
              className={inputCls}
              value={block.visaExpressTierLabel}
              onChange={(e) => onPatch({ visaExpressTierLabel: e.target.value })}
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
    );
  }

  if (block.kind === 'TRANSFER') {
    return (
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs text-slate-500 md:col-span-2">
          接送产品
          <select
            className={inputCls}
            value={block.transferId}
            onChange={(e) => onPatch({ transferId: e.target.value })}
          >
            <option value="">选择接送…</option>
            {transfers.map((t) => (
              <option key={t.id} value={t.id}>{t.name}（{t.originArea}→{t.destArea}）¥{Number(t.basePrice).toFixed(0)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          数量
          <NumberInput
            className={inputCls}
            value={block.transferQty}
            onChange={(v) => onPatch({ transferQty: v })}
            integerOnly
            min={1}
            placeholder="1"
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-3">
          用车日期
          <input
            type="date"
            className={inputCls}
            value={block.transferDate}
            onChange={(e) => onPatch({ transferDate: e.target.value })}
          />
        </label>
      </div>
    );
  }

  // BUNDLE：字段由 SingleOrderModal 自己渲染（套餐与出行人表深度耦合）。
  return null;
}

export interface ProductBlockCardProps extends ProductBlockFieldsProps {
  /** 区块序号（从 1 起，界面用）。 */
  index: number;
  onChangeKind: (kind: MixableBlockKind) => void;
  onRemove: () => void;
}

/** 第二个及之后的产品区块：自带「类型下拉 + 删除」标题条。 */
export function ProductBlockCard({ index, onChangeKind, onRemove, ...fieldsProps }: ProductBlockCardProps) {
  const { block, inputCls } = fieldsProps;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-600">产品 {index}</span>
          <select
            className={`${inputCls} mt-0 w-auto`}
            value={block.kind}
            onChange={(e) => onChangeKind(e.target.value as MixableBlockKind)}
            aria-label={`产品 ${index} 的类型`}
          >
            {MIXABLE_BLOCK_KINDS.map((k) => (
              <option key={k} value={k}>{PRODUCT_BLOCK_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-ghost text-xs text-rose-600 hover:text-rose-700"
          onClick={onRemove}
        >
          <Icon name="close" size={12} /> 删除本产品
        </button>
      </div>
      <ProductBlockFields {...fieldsProps} />
    </div>
  );
}
