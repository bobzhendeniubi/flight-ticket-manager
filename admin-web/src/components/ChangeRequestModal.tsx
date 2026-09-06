/**
 * 提交改单申请（代理自助窗口关闭后的入口）——OrdersPage 详情抽屉「今天内可自助修改」提示旁的
 * 「提交改单申请」按钮打开。四种申请类型（FLIGHT/VISA/HOTEL/CABIN）复用 wave 3 已有的选择器：
 *   · FLIGHT：选目标机票行 + 选新班次（与 RescheduleForm「纠错改航班」同一套航班/班次二级下拉）
 *   · VISA：三档单选（与 OrderDrawer 订单级签证状态口径一致，少「已签证」这一已完成态）
 *   · HOTEL：选目标住宿行 + 选换到的酒店/房型（与 HotelSwapModal 同一套酒店房型 SearchSelect）
 *   · CABIN：选目标经济舱机票行即可，无需其它字段（升舱目标恒为商务舱）
 * 扩展三类（SPLIT/CANCEL_LEG/VISA_EXEMPT）挂在后端 flag AGENT_CHANGE_REQUEST_EXTRA_KINDS
 * 后面：能不能提以 GET /order-change-requests/kinds 的返回为准，前端不猜、也不拿
 * /settings/feature-flags 当判据（那条路只对运营开放，代理读不到）。它们的表单在
 * ChangeRequestExtraFields 里，提交前会先跑一次只读预检把不满足的条件摆出来。
 *
 * 提交后不会立即改动订单——我们在「改单申请」队列里确认执行，本组件只落一条 PENDING 申请。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  orderChangeRequestsApi,
  type ChangeRequestVisaStatus,
  type Hotel,
  type OrderChangeRequest,
  type OrderChangeRequestKind,
  type OrderChangeRequestPayload,
  type OrderChangeRequestPreview,
  type OrderItem,
  type OrderSummary,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Modal } from './Modal';
import { SearchSelect, type SearchSelectOption } from './SearchSelect';
import {
  CHANGE_REQUEST_VISA_STATUS_OPTIONS,
  ORDER_CHANGE_REQUEST_KIND_LABEL,
  isExtraOrderChangeKind,
  scheduleLabel,
  useChangeRequestFlightSchedules,
} from './orderChangeRequestShared';
import {
  bookedFlightItems,
  CancelLegPicker,
  ChangeRequestPreviewCard,
  SplitPassengerPicker,
  VisaExemptPicker,
} from './ChangeRequestExtraFields';

/** flag 关着（或 /kinds 请求失败）时的兜底：只放基础四类，绝不猜着放行扩展项。 */
const BASE_KINDS: OrderChangeRequestKind[] = ['FLIGHT', 'VISA', 'HOTEL', 'CABIN'];

function isHotelItem(item: OrderItem): boolean {
  return item.kind === 'HOTEL' || (item.kind === 'BUNDLE' && Boolean(item.hotelRoomTypeId));
}

function isEconomyFlightItem(item: OrderItem): boolean {
  return item.kind === 'FLIGHT' && item.flightCabin === 'ECONOMY' && !item.bundleId;
}

function itemPickerLabel(item: OrderItem): string {
  if (item.kind === 'FLIGHT') {
    const route = item.route ? `${item.route} · ` : '';
    const when = item.departureDate ? `${item.departureDate}${item.departureTime ? ` ${item.departureTime}` : ''}` : '';
    return `${route}${item.flightNumber ?? item.description}${when ? ` · ${when}` : ''}`;
  }
  if (item.kind === 'HOTEL' || item.kind === 'BUNDLE') {
    const stay = item.hotelCheckIn && item.hotelCheckOut ? ` · ${item.hotelCheckIn.slice(0, 10)}~${item.hotelCheckOut.slice(0, 10)}` : '';
    return `${item.hotelName ?? item.description}${item.roomTypeName ? ` · ${item.roomTypeName}` : ''}${stay}`;
  }
  return item.description;
}

export interface ChangeRequestModalProps {
  orderId: string;
  order: OrderSummary;
  onClose: () => void;
  /** 提交成功后回传新建的申请（调用方用于刷新「本单待处理申请」列表）。 */
  onCreated: (request: OrderChangeRequest) => void;
}

export function ChangeRequestModal({ orderId, order, onClose, onCreated }: ChangeRequestModalProps) {
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';

  const flightItems = useMemo(() => (order.items ?? []).filter((it) => it.kind === 'FLIGHT'), [order.items]);
  const hotelItems = useMemo(() => (order.items ?? []).filter(isHotelItem), [order.items]);
  const cabinItems = useMemo(() => (order.items ?? []).filter(isEconomyFlightItem), [order.items]);

  const passengers = useMemo(() => order.passengers ?? [], [order.passengers]);
  const legItems = useMemo(() => bookedFlightItems(order), [order]);

  // 服务端说了算：flag 关着时这里回的就是基础四类，扩展项连出现的机会都没有。
  const [serverKinds, setServerKinds] = useState<OrderChangeRequestKind[]>(BASE_KINDS);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    orderChangeRequestsApi
      .getOrderChangeRequestKinds(token)
      .then((r) => { if (!cancelled) setServerKinds(r.kinds); })
      // 拿不到就按「没开」处理（fail-closed）：宁可少一个入口，也别摆一个点了就 403 的按钮。
      .catch(() => { if (!cancelled) setServerKinds(BASE_KINDS); });
    return () => { cancelled = true; };
  }, [token]);

  const availableKinds = useMemo(() => {
    const allowed = new Set(serverKinds);
    const kinds: OrderChangeRequestKind[] = [];
    if (flightItems.length > 0) kinds.push('FLIGHT');
    kinds.push('VISA'); // 签证状态是订单级字段，恒可申请
    if (hotelItems.length > 0) kinds.push('HOTEL');
    if (cabinItems.length > 0) kinds.push('CABIN');
    // 扩展三类：服务端放行 + 本单形状撑得住这个动作，两个条件都满足才出现。
    if (allowed.has('SPLIT') && passengers.length > 1) kinds.push('SPLIT');
    if (allowed.has('CANCEL_LEG') && legItems.length > 1) kinds.push('CANCEL_LEG');
    if (allowed.has('VISA_EXEMPT') && passengers.length > 0) kinds.push('VISA_EXEMPT');
    return kinds;
  }, [
    serverKinds,
    flightItems.length,
    hotelItems.length,
    cabinItems.length,
    passengers.length,
    legItems.length,
  ]);

  const [kind, setKind] = useState<OrderChangeRequestKind>(availableKinds[0] ?? 'VISA');

  // FLIGHT：目标行 + 选新航班/班次
  const [flightTargetItemId, setFlightTargetItemId] = useState(flightItems[0]?.id ?? '');
  const [flightId, setFlightId] = useState('');
  const [newScheduleId, setNewScheduleId] = useState('');
  const { flights, schedules, loadingSchedules, error: flightOptionsError } = useChangeRequestFlightSchedules(
    token,
    flightId,
    kind === 'FLIGHT',
  );

  // VISA：三档单选
  const [toVisaStatus, setToVisaStatus] = useState<ChangeRequestVisaStatus>('NEEDED');

  // HOTEL：目标行 + 换到的酒店房型
  const [hotelTargetItemId, setHotelTargetItemId] = useState(hotelItems[0]?.id ?? '');
  const [hotels, setHotels] = useState<Hotel[] | null>(null);
  const [hotelsError, setHotelsError] = useState<string | null>(null);
  const [toHotelRoomTypeId, setToHotelRoomTypeId] = useState('');
  useEffect(() => {
    if (kind !== 'HOTEL' || !token || hotels !== null) return;
    let cancelled = false;
    api
      .listHotels(true, token)
      .then((r) => { if (!cancelled) setHotels(r.hotels); })
      .catch((e: unknown) => { if (!cancelled) setHotelsError(e instanceof ApiError ? e.message : '酒店列表加载失败'); });
    return () => { cancelled = true; };
  }, [kind, token, hotels]);
  const currentHotelRoomTypeId = hotelItems.find((it) => it.id === hotelTargetItemId)?.hotelRoomTypeId ?? null;
  const hotelRoomTypeOptions: SearchSelectOption[] = useMemo(() => {
    const opts: SearchSelectOption[] = [];
    for (const h of hotels ?? []) {
      for (const rt of h.roomTypes) {
        if (rt.id === currentHotelRoomTypeId) continue;
        opts.push({ id: rt.id, label: `${h.name} · ${rt.name}`, priceLabel: '' });
      }
    }
    return opts;
  }, [hotels, currentHotelRoomTypeId]);

  // CABIN：目标行（多为 1 条，>1 条时才展示选择）
  const [cabinTargetItemId, setCabinTargetItemId] = useState(cabinItems[0]?.id ?? '');

  // 扩展三类的表单状态
  const [splitPassengerIds, setSplitPassengerIds] = useState<string[]>([]);
  const [cancelLegSide, setCancelLegSide] = useState<'OUTBOUND' | 'RETURN'>('RETURN');
  const [visaExemptPassengerId, setVisaExemptPassengerId] = useState(passengers[0]?.id ?? '');
  const [visaExemptTarget, setVisaExemptTarget] = useState(true);

  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<OrderChangeRequest | null>(null);

  const payload: OrderChangeRequestPayload | null = useMemo(() => {
    if (kind === 'FLIGHT') {
      return flightTargetItemId && newScheduleId ? { itemId: flightTargetItemId, newScheduleId } : null;
    }
    if (kind === 'VISA') {
      return { toVisaStatus };
    }
    if (kind === 'HOTEL') {
      return hotelTargetItemId && toHotelRoomTypeId ? { itemId: hotelTargetItemId, toHotelRoomTypeId } : null;
    }
    if (kind === 'SPLIT') {
      return splitPassengerIds.length > 0 ? { passengerIds: splitPassengerIds } : null;
    }
    if (kind === 'CANCEL_LEG') {
      return { leg: cancelLegSide };
    }
    if (kind === 'VISA_EXEMPT') {
      return visaExemptPassengerId
        ? { passengerId: visaExemptPassengerId, visaExempt: visaExemptTarget }
        : null;
    }
    // CABIN
    return cabinTargetItemId ? { itemId: cabinTargetItemId, toCabin: 'BUSINESS' } : null;
  }, [
    kind,
    flightTargetItemId,
    newScheduleId,
    toVisaStatus,
    hotelTargetItemId,
    toHotelRoomTypeId,
    cabinTargetItemId,
    splitPassengerIds,
    cancelLegSide,
    visaExemptPassengerId,
    visaExemptTarget,
  ]);

  // ── 扩展三类的只读预检：选什么就核对什么，不满足的条件当场摆出来 ────────────────
  const [preview, setPreview] = useState<OrderChangeRequestPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // payload 每次渲染都是新对象，直接进依赖会死循环；按内容做键。
  const previewKey =
    isExtraOrderChangeKind(kind) && payload ? JSON.stringify({ kind, payload }) : '';
  useEffect(() => {
    if (!token || !previewKey) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const { kind: k, payload: pl } = JSON.parse(previewKey) as {
      kind: OrderChangeRequestKind;
      payload: OrderChangeRequestPayload;
    };
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    orderChangeRequestsApi
      .previewOrderChangeRequest(token, orderId, { kind: k, payload: pl })
      .then((r) => { if (!cancelled) setPreview(r); })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(e instanceof ApiError ? e.message : '核对失败');
      })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [token, orderId, previewKey]);

  // 预检明确说不行 → 不让提交。预检**没跑成**（网络错）不拦：服务端提交时还会再判一次，
  // 拦在这里只会让人对着一个点不动的按钮干瞪眼。
  const blockedByPreview = isExtraOrderChangeKind(kind) && preview != null && !preview.eligible;

  const submit = async (): Promise<void> => {
    if (!token || !payload || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const result = await orderChangeRequestsApi.createOrderChangeRequest(token, orderId, {
        kind,
        payload,
        note: note.trim() || undefined,
      });
      setCreated(result.request);
      onCreated(result.request);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="提交改单申请"
      size="md"
      footer={
        created ? (
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>关闭</button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={submitting} onClick={onClose}>取消</button>
            <button
              type="button"
              className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={submitting || !payload || previewLoading || blockedByPreview}
              onClick={() => void submit()}
            >
              {submitting ? '提交中…' : '提交申请'}
            </button>
          </div>
        )
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        {created ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            已提交，等待运营确认。运营执行前订单不会有任何改动，可在下方「改单申请」列表里查看进度。
          </div>
        ) : (
          <>
            <div className="rounded-lg bg-brand-50 px-3 py-2.5 text-xs leading-relaxed text-brand-700">
              提交后订单不会立即改变，运营确认执行后才会真正生效。
            </div>

            <label className="block">
              <span className="label">申请类型</span>
              <select
                className="input mt-1 w-full"
                value={kind}
                onChange={(e) => setKind(e.target.value as OrderChangeRequestKind)}
                disabled={submitting}
              >
                {availableKinds.map((k) => (
                  <option key={k} value={k}>{ORDER_CHANGE_REQUEST_KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>

            {kind === 'FLIGHT' && (
              <>
                {flightItems.length === 0 ? (
                  <div className="text-xs text-rose-600">本单没有可改航班的机票行。</div>
                ) : (
                  <>
                    {flightItems.length > 1 && (
                      <label className="block">
                        <span className="label">要改的机票行</span>
                        <select
                          className="input mt-1 w-full"
                          value={flightTargetItemId}
                          onChange={(e) => setFlightTargetItemId(e.target.value)}
                          disabled={submitting}
                        >
                          {flightItems.map((it) => (
                            <option key={it.id} value={it.id}>{itemPickerLabel(it)}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="block">
                      <span className="label">选航班</span>
                      <select
                        className="input mt-1 w-full"
                        value={flightId}
                        onChange={(e) => { setFlightId(e.target.value); setNewScheduleId(''); }}
                        disabled={submitting}
                      >
                        <option value="">选择航班…</option>
                        {flights.map((f) => (
                          <option key={f.id} value={f.id}>{f.flightNumber} · {f.originCode}→{f.destinationCode}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="label">新班次{loadingSchedules && '（加载中…）'}</span>
                      <select
                        className="input mt-1 w-full disabled:bg-slate-100"
                        value={newScheduleId}
                        onChange={(e) => setNewScheduleId(e.target.value)}
                        disabled={!flightId || loadingSchedules || submitting}
                      >
                        <option value="">选择班次…</option>
                        {schedules.map((s) => (
                          <option key={s.id} value={s.id}>{scheduleLabel(s)}</option>
                        ))}
                      </select>
                    </label>
                    {flightOptionsError && <div className="text-xs text-rose-600">{flightOptionsError}</div>}
                  </>
                )}
              </>
            )}

            {kind === 'VISA' && (
              <label className="block">
                <span className="label">目标签证状态</span>
                <select
                  className="input mt-1 w-full"
                  value={toVisaStatus}
                  onChange={(e) => setToVisaStatus(e.target.value as ChangeRequestVisaStatus)}
                  disabled={submitting}
                >
                  {CHANGE_REQUEST_VISA_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            )}

            {kind === 'HOTEL' && (
              <>
                {hotelItems.length === 0 ? (
                  <div className="text-xs text-rose-600">本单没有可换的住宿行。</div>
                ) : (
                  <>
                    {hotelItems.length > 1 && (
                      <label className="block">
                        <span className="label">要换的住宿行</span>
                        <select
                          className="input mt-1 w-full"
                          value={hotelTargetItemId}
                          onChange={(e) => { setHotelTargetItemId(e.target.value); setToHotelRoomTypeId(''); }}
                          disabled={submitting}
                        >
                          {hotelItems.map((it) => (
                            <option key={it.id} value={it.id}>{itemPickerLabel(it)}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="block">
                      <span className="label">换到（酒店 · 房型）</span>
                      <SearchSelect
                        options={hotelRoomTypeOptions}
                        value={toHotelRoomTypeId || null}
                        onChange={setToHotelRoomTypeId}
                        placeholder={hotels ? '搜索目标酒店 / 房型…' : '加载中…'}
                        disabled={!hotels || submitting}
                        className="mt-1"
                      />
                    </label>
                    {hotelsError && <div className="text-xs text-rose-600">{hotelsError}</div>}
                  </>
                )}
              </>
            )}

            {kind === 'CABIN' && (
              <>
                {cabinItems.length === 0 ? (
                  <div className="text-xs text-rose-600">本单没有可升舱的经济舱机票行。</div>
                ) : (
                  <>
                    {cabinItems.length > 1 && (
                      <label className="block">
                        <span className="label">要升舱的机票行</span>
                        <select
                          className="input mt-1 w-full"
                          value={cabinTargetItemId}
                          onChange={(e) => setCabinTargetItemId(e.target.value)}
                          disabled={submitting}
                        >
                          {cabinItems.map((it) => (
                            <option key={it.id} value={it.id}>{itemPickerLabel(it)}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <div className="rounded-lg bg-indigo-50/70 px-3 py-2.5 text-xs leading-relaxed text-indigo-900">
                      升为商务舱，差价由服务端按航班配置自动计算，无需手填；运营确认执行后生效。
                    </div>
                  </>
                )}
              </>
            )}

            {kind === 'SPLIT' && (
              <SplitPassengerPicker
                passengers={passengers}
                selectedIds={splitPassengerIds}
                onToggle={(id) =>
                  setSplitPassengerIds((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                  )
                }
                preview={preview}
                disabled={submitting}
              />
            )}

            {kind === 'CANCEL_LEG' && (
              <CancelLegPicker
                value={cancelLegSide}
                onChange={setCancelLegSide}
                disabled={submitting}
              />
            )}

            {kind === 'VISA_EXEMPT' && (
              <VisaExemptPicker
                passengers={passengers}
                passengerId={visaExemptPassengerId}
                onPassengerChange={setVisaExemptPassengerId}
                visaExempt={visaExemptTarget}
                onVisaExemptChange={setVisaExemptTarget}
                disabled={submitting}
              />
            )}

            {isExtraOrderChangeKind(kind) && (
              <ChangeRequestPreviewCard
                loading={previewLoading}
                preview={preview}
                error={previewError}
              />
            )}

            <label className="block">
              <span className="label">备注（选填）</span>
              <input
                className="input mt-1 w-full"
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                placeholder="给运营的补充说明"
                disabled={submitting}
              />
            </label>

            {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
