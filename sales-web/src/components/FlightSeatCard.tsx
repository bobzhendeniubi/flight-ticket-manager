/**
 * FlightSeatCard — 单个舱位卡（价格 / 余位档位 / 行李额 / 加购 / 锁位 / 候补）。
 * 从 HomePage.tsx 原样抽出（文件 <800 行规则）；逻辑零改动。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type AvailabilityTier, type FlightSearchResult } from '../lib/api';
import { CABIN_LABEL, formatLocalDate, formatLocalTime } from '../lib/airports';
import { formatBaggage } from '../lib/baggage';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';

// ─────────────────────────────────────────────────────────────────
// 余位档位徽章 — 买家只看档位不看精确余票数（档位口径由服务端
// computeAvailabilityTier 统一；available/capacity 仍在 payload 里，
// 但仅用于禁用/上限等内部逻辑，绝不渲染给买家）。
// ─────────────────────────────────────────────────────────────────
const TIER_LABEL: Record<AvailabilityTier, string> = {
  AMPLE: '余位充足',
  TIGHT: '余位紧张',
  LOW: '余位少量',
  VERY_LOW: '余位极少量',
  SOLD_OUT: '已售罄',
};
const TIER_CLASS: Record<AvailabilityTier, string> = {
  AMPLE: 'bg-emerald-100 text-emerald-700',
  TIGHT: 'bg-sky-100 text-sky-700',
  LOW: 'bg-amber-100 text-amber-800',
  VERY_LOW: 'bg-orange-100 text-orange-700',
  SOLD_OUT: 'bg-slate-100 text-rose-600',
};

export function FlightSeatCard({
  flight,
  cabin,
  passengers,
  isLoggedIn,
}: {
  flight: FlightSearchResult;
  cabin: FlightSearchResult['seatClasses'][number];
  passengers: number;
  isLoggedIn: boolean;
}) {
  const add = useCart((s) => s.add);
  const token = useAuth((s) => s.tokens?.accessToken ?? '');
  const enough = cabin.available >= passengers;
  const soldOut = cabin.availabilityTier === 'SOLD_OUT' || cabin.available <= 0;

  // ── 锁位（下单前临时占座：单次 ≤9 张 / 固定 10 分钟 / 到期自动回收） ──
  const maxLockQty = Math.min(9, cabin.available);
  const [lockOpen, setLockOpen] = useState(false);
  const [lockQty, setLockQty] = useState(1);
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [activeLock, setActiveLock] = useState<{ qty: number; expiresAt: string } | null>(null);

  const confirmLock = async () => {
    // seatClassId 是新加字段 —— 老缓存/异常数据可能缺失，缺了直接提示而不是打 API
    if (!cabin.seatClassId) {
      setLockError('该舱位暂不支持锁位');
      return;
    }
    setLocking(true);
    setLockError(null);
    try {
      const r = await api.createSeatLock(token, {
        flightScheduleId: flight.scheduleId,
        seatClassId: cabin.seatClassId,
        qty: lockQty,
      });
      // 同卡片多次锁 → 累计张数，倒计时以最新一次锁位为基准
      setActiveLock((prev) => ({ qty: (prev?.qty ?? 0) + r.lock.qty, expiresAt: r.lock.expiresAt }));
      setLockOpen(false);
    } catch (err) {
      // 409（同舱超 9 张 / 余票不足）等 → 原样展示服务端 message
      setLockError(err instanceof ApiError ? err.message : '锁位失败，请稍后再试');
    } finally {
      setLocking(false);
    }
  };

  // ── 候补登记（售罄时替代锁位：1-9 张 + 手机号，有位运营按先来先到通知） ──
  const [wlOpen, setWlOpen] = useState(false);
  const [wlQty, setWlQty] = useState(1);
  const [wlPhone, setWlPhone] = useState('');
  const [wlSubmitting, setWlSubmitting] = useState(false);
  const [wlError, setWlError] = useState<string | null>(null);
  const [wlDone, setWlDone] = useState(false);

  const submitWaitlist = async () => {
    // seatClassId 老缓存/异常数据可能缺失 —— 缺了直接提示而不是打 API（同锁位）
    if (!cabin.seatClassId) {
      setWlError('该舱位暂不支持候补');
      return;
    }
    if (!wlPhone.trim()) {
      setWlError('请填写联系手机号');
      return;
    }
    setWlSubmitting(true);
    setWlError(null);
    try {
      await api.createWaitlist(token, {
        flightScheduleId: flight.scheduleId,
        seatClassId: cabin.seatClassId,
        qty: wlQty,
        contactPhone: wlPhone.trim(),
      });
      setWlDone(true);
      setWlOpen(false);
    } catch (err) {
      // 409（重复登记）/ 400（余票充足）等 → 原样展示服务端 message
      setWlError(err instanceof ApiError ? err.message : '候补登记失败，请稍后再试');
    } finally {
      setWlSubmitting(false);
    }
  };

  return (
    <div
      className={`rounded-xl border px-3 py-2.5 text-sm transition-colors ${
        enough ? 'border-slate-200 bg-white hover:border-brand/30' : 'border-slate-100 bg-canvas text-ink-muted'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-ink">{CABIN_LABEL[cabin.cabin] ?? cabin.cabin}</span>
        <div className="flex items-baseline gap-1 text-right">
          {Number(cabin.dynamicPrice) !== Number(cabin.basePrice) && (
            <span className="price-old">¥{Number(cabin.basePrice).toFixed(0)}</span>
          )}
          <span className="price text-base">¥{Number(cabin.dynamicPrice).toFixed(0)}</span>
        </div>
      </div>
      {/* 买家只看档位徽章 —— 精确余票数（available/capacity）仅内部用于禁用逻辑 */}
      <div className="mt-1">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TIER_CLASS[cabin.availabilityTier]}`}
        >
          {TIER_LABEL[cabin.availabilityTier]}
        </span>
      </div>
      {/* 行李额（按 航班×舱等 配置；未配置不显示；note 直接展示一行，超长截断 + title 悬停看全文） */}
      {cabin.baggage && formatBaggage(cabin.baggage) && (
        <div
          className="mt-1.5 text-[11px] leading-snug text-ink-soft"
          title={cabin.baggage.note ?? undefined}
        >
          🧳 {formatBaggage(cabin.baggage)}
          {cabin.baggage.note && (
            <div className="max-w-[30ch] truncate text-[10px] text-ink-muted" title={cabin.baggage.note}>
              {cabin.baggage.note}
            </div>
          )}
        </div>
      )}
      <div className="mt-2.5 flex gap-1.5">
      <button
        className="btn-deal flex-1 text-xs py-1.5"
        disabled={!enough}
        onClick={() => {
          // 使用 totalForQty 精确总价（服务端 per-seat 累加），避免 round(avg)*qty 造成 1-2 元舍入差
          add({
            kind: 'FLIGHT',
            productId: flight.scheduleId,
            name: `${flight.flightNumber} ${flight.originCode}→${flight.destinationCode} · ${CABIN_LABEL[cabin.cabin]} × ${passengers}`,
            description: `${formatLocalDate(flight.departureTime, flight.departureTz)} ${formatLocalTime(flight.departureTime, flight.departureTz)}`,
            emoji: '✈️',
            unitPrice: cabin.totalForQty,
            qty: 1, // 用 qty=1 + unitPrice=totalForQty 保证精确金额
            meta: {
              departureTime: flight.departureTime,
              cabin: cabin.cabin,
              passengers,
              // dateRank 是内部字段，不放进 cart meta（之前 CartPage 曾把它显示给客户）
              basePrice: Number(cabin.basePrice),
              totalForQty: cabin.totalForQty,
            },
          });
        }}
      >
        {soldOut ? '已售罄' : enough ? `+ 加购 ${passengers} 张` : '余票不足'}
      </button>
      {isLoggedIn && !soldOut && (
        <button
          type="button"
          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={maxLockQty < 1}
          title="先占座 10 分钟，收齐乘客姓名再下单"
          onClick={() => {
            setLockError(null);
            setLockQty(Math.min(Math.max(1, passengers), maxLockQty));
            setLockOpen((v) => !v);
          }}
        >
          🔒 锁位
        </button>
      )}
      {isLoggedIn && soldOut && !wlDone && (
        <button
          type="button"
          className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100"
          title="留下手机号，座位释放后按先来先到通知"
          onClick={() => {
            setWlError(null);
            setWlQty(Math.min(Math.max(1, passengers), 9));
            setWlOpen((v) => !v);
          }}
        >
          🕐 候补登记
        </button>
      )}
      </div>
      {/* 未登录 + 余位极少/售罄 → 提示登录后可锁位/候补（只给提示链接，不渲染实际按钮） */}
      {!isLoggedIn &&
        (cabin.availabilityTier === 'VERY_LOW' || cabin.availabilityTier === 'SOLD_OUT') && (
          <Link to="/login" className="mt-1.5 block text-xs text-brand hover:text-brand-dark">
            登录后可锁位/候补 →
          </Link>
        )}
      {isLoggedIn && lockOpen && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-amber-200 bg-amber-50/60 p-2">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>锁定张数 · 10 分钟 · 最多可锁 {maxLockQty} 张</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="减少锁定张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={lockQty <= 1}
                onClick={() => setLockQty((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="w-5 text-center font-semibold tabular-nums text-slate-800">{lockQty}</span>
              <button
                type="button"
                aria-label="增加锁定张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={lockQty >= maxLockQty}
                onClick={() => setLockQty((q) => Math.min(maxLockQty, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          {lockError && <div className="text-xs text-red-600">{lockError}</div>}
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex-1 rounded-md bg-amber-500 px-2 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              disabled={locking}
              onClick={confirmLock}
            >
              {locking ? '锁定中…' : `确认锁 ${lockQty} 张`}
            </button>
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              disabled={locking}
              onClick={() => setLockOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {isLoggedIn && soldOut && wlOpen && !wlDone && (
        <div className="mt-1.5 space-y-1.5 rounded-md border border-sky-200 bg-sky-50/60 p-2">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>候补张数 · 1-9 张</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="减少候补张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={wlQty <= 1}
                onClick={() => setWlQty((q) => Math.max(1, q - 1))}
              >
                −
              </button>
              <span className="w-5 text-center font-semibold tabular-nums text-slate-800">{wlQty}</span>
              <button
                type="button"
                aria-label="增加候补张数"
                className="h-5 w-5 rounded border border-slate-300 bg-white leading-none text-slate-600 disabled:opacity-40"
                disabled={wlQty >= 9}
                onClick={() => setWlQty((q) => Math.min(9, q + 1))}
              >
                +
              </button>
            </div>
          </div>
          <input
            type="tel"
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 placeholder:text-slate-400"
            placeholder="联系手机号（有位通知你）"
            value={wlPhone}
            maxLength={32}
            onChange={(e) => setWlPhone(e.target.value)}
          />
          {wlError && <div className="text-xs text-red-600">{wlError}</div>}
          <div className="flex gap-1.5">
            <button
              type="button"
              className="flex-1 rounded-md bg-sky-500 px-2 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
              disabled={wlSubmitting}
              onClick={submitWaitlist}
            >
              {wlSubmitting ? '提交中…' : `登记候补 ${wlQty} 张`}
            </button>
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              disabled={wlSubmitting}
              onClick={() => setWlOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {wlDone && (
        <div className="mt-1.5 rounded-md bg-sky-100 px-2 py-1 text-center text-xs font-medium text-sky-800">
          ✓ 已登记候补，有位会通知你
        </div>
      )}
      {activeLock && (
        <SeatLockChip
          qty={activeLock.qty}
          expiresAt={activeLock.expiresAt}
          onExpire={() => setActiveLock(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// SeatLockChip — 卡片上的锁位倒计时（mm:ss）。
// 计时方式同 CheckoutPage 的 HoldCountdown：1s setInterval + useEffect 清理。
// 倒计时归零 → onExpire 让父组件收起 chip（座位已由服务端自动回收）。
// ─────────────────────────────────────────────────────────────────
function SeatLockChip({
  qty,
  expiresAt,
  onExpire,
}: {
  qty: number;
  expiresAt: string;
  onExpire: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const leftMs = Math.max(0, new Date(expiresAt).getTime() - now);
  useEffect(() => {
    if (leftMs === 0) onExpire();
  }, [leftMs, onExpire]);
  if (leftMs === 0) return null;
  const mm = Math.floor(leftMs / 60000);
  const ss = Math.floor((leftMs % 60000) / 1000);
  return (
    <div className="mt-1.5 flex items-center justify-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
      🔒 已锁{qty}张{' '}
      <strong className="font-mono tabular-nums">
        {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
      </strong>
    </div>
  );
}
