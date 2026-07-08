/**
 * 换酒店 —— 共享弹窗（HotelControlPage 占房下钻 + OrdersPage 金额明细 共用）。
 *
 * 定价哲学（owner 批准 A+B）：价格默认冻结——客人已付的钱不变，换酒店只改「住哪」，
 * 绝不按目标房型的挂牌价重算 unitPrice/amount。差价是可选的人工调整（可正可负，与改期费
 * 同一机制），不填就是纯换房不改价。
 *
 * 两种进入方式：
 *   - item：已知具体订单行（OrdersPage 金额明细「换酒店」按钮，行本身已在页面上下文里）。
 *   - locateHint：只知道「目标酒店 + 该行入住/退房日期」（HotelControlPage 占房下钻——
 *     GET /hotel-control/occupants 的 DTO 不带 orderItemId），组件内部拉整单详情，
 *     按「酒店 + 入住/退房日期」反查具体是哪一行；命中多条则列出来让操作员选。
 *
 * 确认前用 GET /hotel-control/nightly-remaining 预览目标酒店逐晚余量（同酒店换房型时
 * 后端会跳过余量校验——房量净不变，预览也没有意义，故跳过展示）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  hotelControlOpsApi,
  type Hotel,
  type HotelNightlyRemainingResult,
  type OrderItemKind,
  type OrderSummary,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from './NumberInput';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';

export interface HotelSwapItemHint {
  id: string;
  kind: OrderItemKind;
  hotelRoomTypeId: string | null;
  hotelCheckIn: string | null;
  hotelCheckOut: string | null;
  roomsBilled?: number | null;
  quantity: number;
  hotelName?: string | null;
  roomTypeName?: string | null;
}

export interface HotelSwapModalProps {
  orderId: string;
  /** 已知具体订单行时直接传（OrdersPage 金额明细入口）。 */
  item?: HotelSwapItemHint;
  /** 只知道「目标酒店 + 该行入住/退房日期」时传（HotelControlPage 占房下钻入口）。 */
  locateHint?: { hotelId: string; checkIn: string; checkOut: string };
  onClose: () => void;
  /** 换酒店成功后回传更新后的整单；关闭 + 刷新由调用方决定。 */
  onSwapped: (order: OrderSummary) => void;
}

/** 'YYYY-MM-DDTHH:mm:ss.sssZ' → 'YYYY-MM-DD'（防御式截断；已是纯日期时原样返回）。 */
function dateOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.slice(0, 10);
}

/** 'YYYY-MM-DD' → 'M/D'（预览徽标紧凑展示）。 */
function shortDate(s: string): string {
  const [, m, d] = s.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 每间每晚价格标签（SearchSelect priceLabel，不含 ¥ 符号）。 */
function nightlyPriceLabel(basePrice: string): string {
  const n = Math.round(Number(basePrice));
  return Number.isFinite(n) ? String(n) : basePrice;
}

export function HotelSwapModal({ orderId, item, locateHint, onClose, onSwapped }: HotelSwapModalProps) {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [hotels, setHotels] = useState<Hotel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 定位具体订单行（仅 locateHint 入口需要；item 入口直接已知）──
  const [resolvedItem, setResolvedItem] = useState<HotelSwapItemHint | null>(item ?? null);
  const [candidates, setCandidates] = useState<HotelSwapItemHint[] | null>(null); // 命中 >1 条时给操作员选
  const [locating, setLocating] = useState(Boolean(locateHint && !item));

  const [newRoomTypeId, setNewRoomTypeId] = useState('');
  const [feeCny, setFeeCny] = useState<number | null>(null);
  const [feeNote, setFeeNote] = useState('');

  const [preview, setPreview] = useState<HotelNightlyRemainingResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── 加载在架酒店 + 房型（换到的目标选项 + 定位/展示用元数据）──
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .listHotels(true, token)
      .then((r) => {
        if (!cancelled) setHotels(r.hotels);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : '酒店列表加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // hotelRoomTypeId → {hotelId, hotelName, roomTypeName, basePrice}（定位 / 同酒店判断 / 展示共用）
  const roomTypeMeta = useMemo(() => {
    const m = new Map<string, { hotelId: string; hotelName: string; roomTypeName: string; basePrice: string }>();
    for (const h of hotels ?? []) {
      for (const rt of h.roomTypes) {
        m.set(rt.id, { hotelId: h.id, hotelName: h.name, roomTypeName: rt.name, basePrice: rt.basePrice });
      }
    }
    return m;
  }, [hotels]);

  // ── locateHint 入口：拉整单详情，按「目标酒店 + 入住/退房日期」反查具体行 ──
  useEffect(() => {
    if (item || !locateHint || !token || !hotels) return;
    let cancelled = false;
    setLocating(true);
    api
      .getOrder(token, orderId)
      .then((r) => {
        if (cancelled) return;
        const matches = (r.order.items ?? []).filter((it) => {
          const isHotelRow = it.kind === 'HOTEL' || (it.kind === 'BUNDLE' && Boolean(it.hotelRoomTypeId));
          if (!isHotelRow || !it.hotelRoomTypeId) return false;
          const meta = roomTypeMeta.get(it.hotelRoomTypeId);
          if (!meta || meta.hotelId !== locateHint.hotelId) return false;
          return (
            dateOnly(it.hotelCheckIn) === locateHint.checkIn && dateOnly(it.hotelCheckOut) === locateHint.checkOut
          );
        });
        const toHint = (it: (typeof matches)[number]): HotelSwapItemHint => ({
          id: it.id,
          kind: it.kind,
          hotelRoomTypeId: it.hotelRoomTypeId,
          hotelCheckIn: it.hotelCheckIn,
          hotelCheckOut: it.hotelCheckOut,
          roomsBilled: it.roomsBilled,
          quantity: it.quantity,
          hotelName: it.hotelName,
          roomTypeName: it.roomTypeName,
        });
        if (matches.length === 1) {
          setResolvedItem(toHint(matches[0]));
        } else if (matches.length > 1) {
          setCandidates(matches.map(toHint));
        } else {
          setErr('未能在该订单中定位到对应的酒店行，请改用订单详情页操作');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '订单详情加载失败');
      })
      .finally(() => {
        if (!cancelled) setLocating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item, locateHint, token, orderId, hotels, roomTypeMeta]);

  const sourceMeta = resolvedItem?.hotelRoomTypeId ? roomTypeMeta.get(resolvedItem.hotelRoomTypeId) : undefined;
  const destMeta = newRoomTypeId ? roomTypeMeta.get(newRoomTypeId) : undefined;
  const isSameHotel = Boolean(sourceMeta && destMeta && sourceMeta.hotelId === destMeta.hotelId);

  const roomTypeOptions: SearchSelectOption[] = useMemo(() => {
    const opts: SearchSelectOption[] = [];
    for (const h of hotels ?? []) {
      for (const rt of h.roomTypes) {
        if (rt.id === resolvedItem?.hotelRoomTypeId) continue; // 排除当前房型：选它=无意义换房，后端也会拒
        opts.push({ id: rt.id, label: `${h.name} · ${rt.name}`, priceLabel: nightlyPriceLabel(rt.basePrice) });
      }
    }
    return opts;
  }, [hotels, resolvedItem?.hotelRoomTypeId]);

  const checkIn = dateOnly(resolvedItem?.hotelCheckIn);
  const checkOut = dateOnly(resolvedItem?.hotelCheckOut);

  // ── 逐晚余量预览（仅跨酒店才需要；同酒店换房型后端跳过校验，预览没有意义）──
  useEffect(() => {
    setPreview(null);
    if (!token || !newRoomTypeId || isSameHotel || !checkIn || !checkOut) return;
    let cancelled = false;
    setPreviewLoading(true);
    hotelControlOpsApi
      .getNightlyRemaining(token, { hotelRoomTypeId: newRoomTypeId, checkIn, checkOut })
      .then((r) => {
        if (!cancelled) setPreview(r);
      })
      .catch(() => {
        /* 预览失败不阻断——确认时后端仍会做一次权威校验 */
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, newRoomTypeId, isSameHotel, checkIn, checkOut]);

  async function submit(): Promise<void> {
    if (!token || !resolvedItem || !newRoomTypeId || submitting) return;
    setErr(null);
    setSubmitting(true);
    try {
      const hasFee = feeCny != null && feeCny !== 0;
      const res = await api.swapItemHotel(token, orderId, resolvedItem.id, {
        newHotelRoomTypeId: newRoomTypeId,
        feeCny: hasFee ? (feeCny as number) : undefined,
        feeLabel: hasFee ? '换酒店差价' : undefined,
        note: feeNote.trim() || undefined,
      });
      onSwapped(res.order);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '换酒店失败');
    } finally {
      setSubmitting(false);
    }
  }

  const nights =
    checkIn && checkOut
      ? Math.max(
          1,
          Math.round(
            (new Date(`${checkOut}T00:00:00.000Z`).getTime() - new Date(`${checkIn}T00:00:00.000Z`).getTime()) /
              86_400_000,
          ),
        )
      : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold text-ink">换酒店</h2>
          <button type="button" className="text-slate-400 hover:text-slate-700" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="rounded-lg bg-brand-50 px-3 py-2.5 text-xs leading-relaxed text-brand-700">
            客人价格不变，仅更换入住酒店；如需向客人加收/退差价再填写下方金额。
          </div>

          {loadError && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{loadError}</div>}

          {locating ? (
            <div className="py-4 text-center text-sm text-ink-muted">定位订单行中…</div>
          ) : candidates && candidates.length > 1 ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-muted">该订单在此酒店当晚有多条占房行，请选择要换的一条：</p>
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-xs hover:border-brand hover:bg-brand-50"
                  onClick={() => {
                    setResolvedItem(c);
                    setCandidates(null);
                  }}
                >
                  {c.hotelName ?? roomTypeMeta.get(c.hotelRoomTypeId ?? '')?.hotelName ?? '—'} ·{' '}
                  {c.roomTypeName ?? roomTypeMeta.get(c.hotelRoomTypeId ?? '')?.roomTypeName ?? '—'} ·{' '}
                  {dateOnly(c.hotelCheckIn)}~{dateOnly(c.hotelCheckOut)}
                </button>
              ))}
            </div>
          ) : !resolvedItem ? (
            !err && <div className="py-4 text-center text-sm text-ink-muted">加载中…</div>
          ) : (
            <>
              <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs text-ink-soft">
                当前：
                <span className="font-medium text-ink">
                  {resolvedItem.hotelName ?? sourceMeta?.hotelName ?? '—'} ·{' '}
                  {resolvedItem.roomTypeName ?? sourceMeta?.roomTypeName ?? '—'}
                </span>
                {checkIn && checkOut && (
                  <>
                    {' '}
                    · {checkIn}~{checkOut}
                    {nights ? ` · ${nights}晚` : ''}
                  </>
                )}
                {resolvedItem.roomsBilled != null && <> × {resolvedItem.roomsBilled}间</>}
              </div>

              <label className="block">
                <span className="label">换到（酒店 · 房型）</span>
                <SearchSelect
                  options={roomTypeOptions}
                  value={newRoomTypeId || null}
                  onChange={setNewRoomTypeId}
                  placeholder={hotels ? '搜索目标酒店 / 房型…' : '加载中…'}
                  disabled={!hotels}
                  className="mt-1"
                />
              </label>

              {newRoomTypeId && isSameHotel && (
                <div className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700">
                  同酒店换房型，房量净不变，不受当前余量限制。
                </div>
              )}

              {newRoomTypeId && !isSameHotel && (
                <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                  <div className="text-xs font-medium text-ink-muted">目标酒店逐晚余量预览</div>
                  {previewLoading ? (
                    <div className="mt-1.5 text-xs text-ink-muted">加载中…</div>
                  ) : preview && preview.dates.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {preview.dates.map((d, i) => {
                        const untracked = !preview.hasBlock || preview.block[i] === 0;
                        const remaining = preview.remaining[i];
                        const cls = untracked
                          ? 'bg-amber-100 text-amber-800'
                          : remaining < 0
                            ? 'bg-rose-600 text-white'
                            : remaining === 0
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700';
                        return (
                          <span key={d} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`} title={d}>
                            {shortDate(d)} {untracked ? '未配包房' : `余${remaining}`}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-1.5 text-xs text-ink-muted">无入住区间数据，无法预览（确认时仍会校验）</div>
                  )}
                </div>
              )}

              <details className="rounded-lg border border-slate-200">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink">
                  加/减价（选填）
                </summary>
                <div className="space-y-2 border-t border-slate-100 p-3">
                  <label className="block">
                    <span className="label">金额（¥，可负数=减价；留空=不调整）</span>
                    <NumberInput
                      value={feeCny}
                      onChange={setFeeCny}
                      integerOnly
                      allowNegative
                      placeholder="如 200，减价填 -200"
                      className="input mt-1"
                    />
                  </label>
                  <label className="block">
                    <span className="label">备注（选填）</span>
                    <input
                      className="input mt-1"
                      value={feeNote}
                      onChange={(e) => setFeeNote(e.target.value)}
                      placeholder="如：升级至海景房"
                    />
                  </label>
                </div>
              </details>
            </>
          )}

          {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              className="btn-primary flex-1"
              onClick={submit}
              disabled={submitting || !resolvedItem || !newRoomTypeId}
            >
              {submitting ? '换酒店中…' : '确认换酒店'}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
