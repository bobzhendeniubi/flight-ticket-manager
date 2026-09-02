/**
 * 拆单弹窗（split PNR 售后逃生门；仅 ADMIN/STAFF 入口渲染）。
 *
 * 流程：勾选乘客 → 服务端预检（准入闸 + 每人份额 + 住宿/升舱/佣金/房组四项口径）
 * → 填「随拆搬走的间数」「随拆走的升舱人数」→ 确认页（明说拆单不可撤销）→ 执行 → 成功页展示新单号。
 *
 * 权威在服务端：本组件不传任何金额（roomSplit 只传间数、upgradeSplit 只传份数），
 * 份额/已收/佣金全部来自 preview 返回；requestToken 在弹窗打开时生成一次（crypto.randomUUID），
 * 提交重试复用同一 token —— 网络超时后再点一次只会幂等回放，绝不二次拆。
 *
 * 老后端兼容：preview 的 kind / suggestedRoomsToMove / upgradeItems / commission / roomGroupConflict
 * 全部可选，缺省时 UI 退回旧行为（住宿输入框留空、不显示升舱区/佣金提示/房组勾选）。
 */
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  FLIGHT_LEG_ZH,
  type FlightLegSide,
  type OrderSummary,
  type SplitOrderExecResult,
  type SplitOrderPreviewResult,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Modal } from './Modal';

export interface SplitOrderModalProps {
  order: OrderSummary;
  onClose: () => void;
  /** 拆单成功后回调（父级刷新抽屉与列表）；弹窗自身停在成功页展示新单号。 */
  onSplitDone: (result: SplitOrderExecResult) => void;
}

const fmtCny = (n: number): string =>
  `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

const paxName = (p: { fullName: string; chineseName?: string | null }): string =>
  p.chineseName?.trim() || p.fullName;

/** 升舱输入框的键：一条机票行去/回两段各一个框，故按 (行, 航段) 唯一。 */
const upgradeKey = (itemId: string, leg: FlightLegSide): string => `${itemId}:${leg}`;

/** 套餐住宿行的描述带「套餐住宿 · 」前缀，行内另有同名标签，去掉前缀免得读两遍（认不出就原样显示）。 */
const stripBundleHotelPrefix = (description: string): string =>
  description.replace(/^套餐住宿\s*·\s*/, '');

/** 把服务端的建议间数灌进输入框（运营可改）；老后端不给建议值时留空 = 0 = 全留原单。 */
const suggestedRoomInputs = (p: SplitOrderPreviewResult): Record<string, string> =>
  Object.fromEntries(
    p.hotelItems
      .filter((h) => (h.suggestedRoomsToMove ?? 0) > 0)
      .map((h) => [h.itemId, String(h.suggestedRoomsToMove)]),
  );

/** 同上：建议升舱份数灌进输入框。 */
const suggestedUpgradeInputs = (p: SplitOrderPreviewResult): Record<string, string> =>
  Object.fromEntries(
    (p.upgradeItems ?? [])
      .filter((u) => u.suggestedToMove > 0)
      .map((u) => [upgradeKey(u.itemId, u.leg), String(u.suggestedToMove)]),
  );

export function SplitOrderModal({ order, onClose, onSplitDone }: SplitOrderModalProps) {
  const token = useAuth((s) => s.tokens?.accessToken) ?? '';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SplitOrderPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [roomSplit, setRoomSplit] = useState<Record<string, string>>({});
  const [upgradeInputs, setUpgradeInputs] = useState<Record<string, string>>({});
  const [autoSplitRoomGroups, setAutoSplitRoomGroups] = useState(false);
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<'form' | 'confirm' | 'done'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<SplitOrderExecResult | null>(null);
  // 幂等键：整个弹窗生命周期只生成一次 —— 提交超时后重试复用同 token，服务端只回放不二次拆。
  const requestTokenRef = useRef<string>(crypto.randomUUID());
  const previewSeqRef = useRef(0);

  const selectedIds = [...selected];
  const selectedKey = selectedIds.slice().sort().join(',');
  const passengers = order.passengers ?? [];

  // 勾选变化 → 服务端预检（准入闸 + 份额 + 建议值）。序号防竞态：只认最后一次请求的返回。
  // 建议间数/份数随勾选人数变，所以每次预检回来都按最新建议重灌输入框。
  useEffect(() => {
    if (!token || selectedKey === '') {
      setPreview(null);
      setPreviewError(null);
      setRoomSplit({});
      setUpgradeInputs({});
      setAutoSplitRoomGroups(false);
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    api
      // 预检把「自动劈房组」开关一并带上：勾了之后服务端不再报同房组闸，blockers 才是真实的剩余拦截。
      .splitOrderPreview(token, order.id, {
        passengerIds: selectedKey.split(','),
        ...(autoSplitRoomGroups ? { autoSplitRoomGroups: true } : {}),
      })
      .then((r) => {
        if (previewSeqRef.current !== seq) return;
        setPreview(r);
        setRoomSplit(suggestedRoomInputs(r));
        setUpgradeInputs(suggestedUpgradeInputs(r));
        if (!r.roomGroupConflict) setAutoSplitRoomGroups(false);
      })
      .catch((e) => {
        if (previewSeqRef.current === seq) {
          setPreview(null);
          setPreviewError(e instanceof ApiError ? e.message : '预检失败，请重试');
        }
      })
      .finally(() => {
        if (previewSeqRef.current === seq) setPreviewLoading(false);
      });
    // autoSplitRoomGroups 进依赖：勾/取消「自动劈房组」要重新预检，拿服务端真实的剩余拦截。
  }, [token, order.id, selectedKey, autoSplitRoomGroups]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 住宿行含单订酒店行与盖了住宿的套餐行（套餐没有独立 HOTEL 行，酒店盖在 BUNDLE 行上）。
  const hotelItems = preview?.hotelItems ?? [];
  const upgradeItems = preview?.upgradeItems ?? [];
  const movedPaxCount = preview?.shares.length ?? 0;

  // roomSplit 输入校验：0 ≤ x ≤ 该行房数，0.5 网格。返回错误列表（非空禁提交）。
  const roomSplitErrors: string[] = [];
  const roomSplitPayload: Array<{ itemId: string; roomsBilledToMove: number }> = [];
  for (const item of hotelItems) {
    const raw = roomSplit[item.itemId]?.trim();
    if (!raw) continue; // 留空 = 0 = 该行全留原单
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      roomSplitErrors.push(`「${item.description}」的间数无效`);
      continue;
    }
    if (n === 0) continue;
    if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) {
      roomSplitErrors.push(`「${item.description}」的间数必须是 0.5 的整数倍`);
      continue;
    }
    if (item.roomsBilled != null && n > item.roomsBilled) {
      roomSplitErrors.push(
        `「${item.description}」的间数不能超过该行计费房数（${item.roomsBilled}）`,
      );
      continue;
    }
    roomSplitPayload.push({ itemId: item.itemId, roomsBilledToMove: n });
  }

  // 升舱输入校验：整数，既不能超过该段现有升舱份数，也不能超过拆出的人数。
  const upgradeErrors: string[] = [];
  const upgradeMoved: Array<{ itemId: string; leg: FlightLegSide; count: number }> = [];
  for (const u of upgradeItems) {
    const legZh = FLIGHT_LEG_ZH[u.leg];
    const raw = upgradeInputs[upgradeKey(u.itemId, u.leg)]?.trim();
    if (!raw) continue; // 留空 = 0 = 该段升舱全留原单
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      upgradeErrors.push(`${legZh}的升舱人数必须是 0 或正整数`);
      continue;
    }
    if (n === 0) continue;
    if (n > u.businessUpgradeCount) {
      upgradeErrors.push(`${legZh}的升舱人数不能超过本段现有份数（${u.businessUpgradeCount}）`);
      continue;
    }
    if (n > movedPaxCount) {
      upgradeErrors.push(`${legZh}的升舱人数不能超过拆出的人数（${movedPaxCount}）`);
      continue;
    }
    upgradeMoved.push({ itemId: u.itemId, leg: u.leg, count: n });
  }
  // 请求体按行合并两段：后端一条机票行收一个 { outboundToMove, returnToMove }。
  const upgradeSplitPayload = [...new Set(upgradeMoved.map((m) => m.itemId))].map((itemId) => ({
    itemId,
    outboundToMove:
      upgradeMoved.find((m) => m.itemId === itemId && m.leg === 'OUTBOUND')?.count ?? 0,
    returnToMove: upgradeMoved.find((m) => m.itemId === itemId && m.leg === 'RETURN')?.count ?? 0,
  }));

  // 房组冲突：勾了「自动劈房组」就由服务端按人劈开，这一条闸不再拦（认关键词「房组」）；
  // 其余闸一条不放，剩下任何一条拦截都仍然禁提交。老后端不返回该字段 → 行为与从前完全一致。
  const conflictOptIn = Boolean(preview?.roomGroupConflict) && autoSplitRoomGroups;
  const activeBlockers = conflictOptIn
    ? (preview?.blockers ?? []).filter((b) => !b.includes('房组'))
    : (preview?.blockers ?? []);
  const commissionBlocked = preview?.commission?.mode === 'BLOCKED';

  const canProceed =
    !previewLoading &&
    preview != null &&
    (preview.eligible || (conflictOptIn && activeBlockers.length === 0)) &&
    !commissionBlocked &&
    selected.size >= 1 &&
    selected.size < passengers.length &&
    roomSplitErrors.length === 0 &&
    upgradeErrors.length === 0;

  // 确认页三项口径（房数/升舱/佣金）用同一套文案，避免两处写法漂移。
  const roomSplitSummary =
    roomSplitPayload.length > 0
      ? roomSplitPayload
          .map((r) => {
            const item = hotelItems.find((h) => h.itemId === r.itemId);
            return `${item?.description ?? r.itemId} × ${r.roomsBilledToMove} 间`;
          })
          .join('；')
      : '不搬（住宿全留原单）';
  const upgradeSummary =
    upgradeMoved.length > 0
      ? upgradeMoved.map((m) => `${FLIGHT_LEG_ZH[m.leg]} ${m.count} 人`).join('；')
      : '不搬（升舱全留原单）';
  const commissionSummary =
    preview?.commission == null
      ? null
      : preview.commission.mode === 'SPLIT'
        ? `${fmtCny(preview.commission.amountCny)} 已计提未结算，按份额分到两张单（记关键审计）`
        : preview.commission.mode === 'BLOCKED'
          ? '当前状态不允许拆单，请先在佣金台处理'
          : '无需处理';

  const submit = async () => {
    if (!token || !preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.splitOrder(token, order.id, {
        passengerIds: selectedIds,
        ...(roomSplitPayload.length > 0 ? { roomSplit: roomSplitPayload } : {}),
        ...(upgradeSplitPayload.length > 0 ? { upgradeSplit: upgradeSplitPayload } : {}),
        ...(conflictOptIn ? { autoSplitRoomGroups: true } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        requestToken: requestTokenRef.current,
      });
      setResult(res);
      setPhase('done');
      onSplitDone(res);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : '拆单失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`拆单 · ${order.orderNumber}`} size="lg">
      {phase === 'done' && result ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            <div className="font-semibold">拆单完成</div>
            <div className="mt-1">
              已拆出 {result.passengerCount} 位乘客至新订单{' '}
              <span className="nums font-semibold">{result.targetOrderNumber}</span>
              {result.replayed && '（本次为幂等回放，此前已拆过）'}
            </div>
            <div className="mt-1 text-xs">
              新单应收 {fmtCny(result.movedShareCny)} · 承接已收 {fmtCny(result.movedPaidCny)}
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>
      ) : phase === 'confirm' && preview ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">
            <span className="font-semibold">拆单不可撤销。</span>
            确认后将把下列乘客连同其份额与已收款拆出为新订单，原订单金额随之减少。
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              拆出乘客（{preview.shares.length} 人）
            </div>
            <ul className="mt-1.5 space-y-1">
              {preview.shares.map((s) => (
                <li key={s.passengerId} className="flex justify-between">
                  <span>{s.fullName}</span>
                  <span className="nums">{fmtCny(s.shareCny)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 font-medium">
              <span>新单应收合计</span>
              <span className="nums">{fmtCny(preview.movedShareCny)}</span>
            </div>
            <div className="flex justify-between text-xs text-ink-soft">
              <span>随拆转移的已收款</span>
              <span className="nums">{fmtCny(preview.movedPaidCny)}</span>
            </div>
            <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-ink-soft">
              {hotelItems.length > 0 && <div>随拆搬走的住宿间数：{roomSplitSummary}</div>}
              {upgradeItems.length > 0 && <div>随拆走的升舱人数：{upgradeSummary}</div>}
              {commissionSummary && <div>佣金：{commissionSummary}</div>}
              {conflictOptIn && <div>同房组的人：按人劈成两个半组（房控后续会配回一间）</div>}
            </div>
          </div>
          {submitError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {submitError}
            </div>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-ink-soft hover:bg-slate-50"
              onClick={() => setPhase('form')}
              disabled={submitting}
            >
              返回修改
            </button>
            <button
              type="button"
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              onClick={() => void submit()}
              disabled={submitting}
            >
              {submitting ? '拆单中…' : '确认拆单（不可撤销）'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-ink-muted">
            勾选要拆出的乘客（至少留 1 位在原订单）。份额按订单详情「每人结算价」同一口径计算，
            座位与库存不受影响。
          </p>
          <ul className="space-y-1">
            {passengers.map((p) => {
              const share = preview?.shares.find((s) => s.passengerId === p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                      <span>{paxName(p)}</span>
                    </span>
                    {share && <span className="nums text-ink-soft">{fmtCny(share.shareCny)}</span>}
                  </label>
                </li>
              );
            })}
          </ul>

          {previewLoading && <div className="text-xs text-ink-muted">预检中…</div>}
          {previewError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {previewError}
            </div>
          )}

          {preview && activeBlockers.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-xs font-semibold text-red-700">当前不能拆单：</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-red-700">
                {activeBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {preview?.roomGroupConflict && (
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={autoSplitRoomGroups}
                onChange={(e) => setAutoSplitRoomGroups(e.target.checked)}
              />
              <span>
                <span className="font-semibold">拆出的人和留在原单的人同住一个房组。</span>
                勾选＝自动把同房组按人劈成两个半组（同酒店、同房型、同日期，房控后续会配回一间）；
                不勾就先去分房表把他们分开，再回来拆单。
              </span>
            </label>
          )}

          {preview?.commission && preview.commission.mode !== 'NONE' && (
            <div
              className={
                preview.commission.mode === 'BLOCKED'
                  ? 'rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700'
                  : 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800'
              }
            >
              {preview.commission.mode === 'BLOCKED' ? (
                <>
                  <span className="font-semibold">本单佣金当前状态不允许拆单。</span>
                  请先在佣金台把这 {fmtCny(preview.commission.amountCny)}{' '}
                  佣金处理掉（结算或撤销计提），再回来拆。
                </>
              ) : (
                <>
                  本单佣金 {fmtCny(preview.commission.amountCny)}{' '}
                  已计提未结算，将按份额分到两张单（记关键审计）。
                </>
              )}
            </div>
          )}

          {preview && preview.eligible && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="flex justify-between font-medium">
                <span>新单应收合计</span>
                <span className="nums">{fmtCny(preview.movedShareCny)}</span>
              </div>
              <div className="flex justify-between text-xs text-ink-soft">
                <span>随拆转移的已收款</span>
                <span className="nums">{fmtCny(preview.movedPaidCny)}</span>
              </div>
            </div>
          )}

          {hotelItems.length > 0 && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                随拆搬走的住宿间数（0.5 步进，留空/0 = 该行全留原单）
              </div>
              <ul className="mt-2 space-y-2">
                {hotelItems.map((h) => (
                  <li key={h.itemId} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs" title={h.description}>
                      {(h.isBundleStay || h.kind === 'BUNDLE') && (
                        <span className="mr-1 rounded bg-indigo-50 px-1 py-0.5 text-[10px] font-medium text-indigo-700">
                          套餐住宿
                        </span>
                      )}
                      {h.isBundleStay || h.kind === 'BUNDLE' ? stripBundleHotelPrefix(h.description) : h.description}
                      {h.roomsBilled != null && (
                        <span className="text-ink-muted">（现 {h.roomsBilled} 间）</span>
                      )}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={h.roomsBilled ?? undefined}
                      step={0.5}
                      value={roomSplit[h.itemId] ?? ''}
                      onChange={(e) =>
                        setRoomSplit((prev) => ({ ...prev, [h.itemId]: e.target.value }))
                      }
                      className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-sm"
                      placeholder="0"
                    />
                  </li>
                ))}
              </ul>
              {roomSplitErrors.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-red-700">
                  {roomSplitErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {upgradeItems.length > 0 && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                随拆走的升舱人数（整数，留空/0 = 该段升舱全留原单）
              </div>
              <ul className="mt-2 space-y-2">
                {upgradeItems.map((u) => (
                  <li
                    key={upgradeKey(u.itemId, u.leg)}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {FLIGHT_LEG_ZH[u.leg]}商务舱升舱
                      <span className="text-ink-muted">（现 {u.businessUpgradeCount} 人）</span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={Math.min(u.businessUpgradeCount, movedPaxCount)}
                      step={1}
                      value={upgradeInputs[upgradeKey(u.itemId, u.leg)] ?? ''}
                      onChange={(e) =>
                        setUpgradeInputs((prev) => ({
                          ...prev,
                          [upgradeKey(u.itemId, u.leg)]: e.target.value,
                        }))
                      }
                      className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-sm"
                      placeholder="0"
                    />
                  </li>
                ))}
              </ul>
              {upgradeErrors.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-red-700">
                  {upgradeErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div>
            <label className="text-xs text-ink-muted" htmlFor="split-order-note">
              备注（可选，随拆单流水留档）
            </label>
            <input
              id="split-order-note"
              type="text"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm"
              placeholder="如：客人分开出行，按人拆单"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-ink-soft hover:bg-slate-50"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              onClick={() => setPhase('confirm')}
              disabled={!canProceed}
            >
              下一步：确认拆单
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
