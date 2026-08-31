/**
 * 拆单弹窗（split PNR 售后逃生门；仅 ADMIN/STAFF 入口渲染）。
 *
 * 流程：勾选乘客 → 服务端预检（准入闸 + 每人份额）→ 有酒店行时填「随拆搬走的间数」
 * → 确认页（明说拆单不可撤销）→ 执行 → 成功页展示新单号。
 *
 * 权威在服务端：本组件不传任何金额（roomSplit 只传间数），份额/已收全部来自 preview 返回；
 * requestToken 在弹窗打开时生成一次（crypto.randomUUID），提交重试复用同一 token —— 网络超时
 * 后再点一次只会幂等回放，绝不二次拆。
 */
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
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

export function SplitOrderModal({ order, onClose, onSplitDone }: SplitOrderModalProps) {
  const token = useAuth((s) => s.tokens?.accessToken) ?? '';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SplitOrderPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [roomSplit, setRoomSplit] = useState<Record<string, string>>({});
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

  // 勾选变化 → 服务端预检（准入闸 + 份额）。序号防竞态：只认最后一次请求的返回。
  useEffect(() => {
    if (!token || selectedKey === '') {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const seq = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    api
      .splitOrderPreview(token, order.id, { passengerIds: selectedKey.split(',') })
      .then((r) => {
        if (previewSeqRef.current === seq) setPreview(r);
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
  }, [token, order.id, selectedKey]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // roomSplit 输入校验：0 ≤ x ≤ 该行房数，0.5 网格。返回错误列表（非空禁提交）。
  const roomSplitErrors: string[] = [];
  const roomSplitPayload: Array<{ itemId: string; roomsBilledToMove: number }> = [];
  for (const item of preview?.hotelItems ?? []) {
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

  const canProceed =
    !previewLoading &&
    preview != null &&
    preview.eligible &&
    selected.size >= 1 &&
    selected.size < passengers.length &&
    roomSplitErrors.length === 0;

  const submit = async () => {
    if (!token || !preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.splitOrder(token, order.id, {
        passengerIds: selectedIds,
        ...(roomSplitPayload.length > 0 ? { roomSplit: roomSplitPayload } : {}),
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
            {roomSplitPayload.length > 0 && (
              <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-ink-soft">
                随拆搬走的酒店间数：
                {roomSplitPayload
                  .map((r) => {
                    const item = preview.hotelItems.find((h) => h.itemId === r.itemId);
                    return `${item?.description ?? r.itemId} × ${r.roomsBilledToMove} 间`;
                  })
                  .join('；')}
              </div>
            )}
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

          {preview && preview.blockers.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <div className="text-xs font-semibold text-red-700">当前不能拆单：</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-red-700">
                {preview.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
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

          {preview && preview.hotelItems.length > 0 && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                随拆搬走的酒店间数（0.5 步进，留空/0 = 该行全留原单）
              </div>
              <ul className="mt-2 space-y-2">
                {preview.hotelItems.map((h) => (
                  <li key={h.itemId} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs" title={h.description}>
                      {h.description}
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
