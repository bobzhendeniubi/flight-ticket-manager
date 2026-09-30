/**
 * 标记已换人（换人主路径）弹窗 —— 列表「改状态…」里的「已换人…」与订单详情「标记已换人」共用。
 *
 * 口径（运营 2026-09 拍板）：原单只收换人费，多出的钱**不退现金**——代理单存入代理余额、
 * 直客单转入挂账池，运营再拿它抵新单尾款；收不够的照常当欠款催。座位：未飞航段当场释放，
 * 已飞航段不退座（全飞完要二次确认）。真正的算账在后端 POST /orders/:id/mark-swapped 一个事务里，
 * 这里只做预览与提交；预览用的净收款必须拿到已完成退款（详情补水），列表快照的 paidAmount 不能冒充。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type MarkSwappedAudit, type OrderStatus, type OrderSummary } from '../lib/api';
import { localYmd } from '../lib/airports';
import { Modal } from './Modal';

/** 可标记已换人的来源状态（与后端 SWAP_ELIGIBLE_STATUSES 同一份；后端是真源，这里只决定入口显隐）。 */
export const MARK_SWAPPED_ELIGIBLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'CHANGE_REQUESTED',
  'CHANGED',
]);

/** 业务时区（北京）的今天，用来判「出发日已过 = 已起飞」的提示；精确判定在后端（按班次时刻）。 */
const BUSINESS_TZ = 'Asia/Shanghai';

function roundCny(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 提交成功后弹给运营的结果摘要（列表入口与抽屉入口共用一句话，别各写一套）。 */
export function markSwappedSummary(audit: MarkSwappedAudit): string {
  const legLabel = (l: { itemLabel: string; flightNumber: string }) => l.flightNumber || l.itemLabel;
  const lines = [
    `${audit.orderNumber} 已标记为「已换人」。`,
    `换人费 ¥${audit.swapFeeCny.toLocaleString()}（原应收 ¥${audit.beforePayableCny.toLocaleString()}，净收 ¥${audit.netPaidCny.toLocaleString()}）。`,
  ];
  if (audit.disposal?.kind === 'AGENT_BALANCE') {
    lines.push(
      `多出 ¥${audit.disposal.amountCny.toLocaleString()} 已存入代理余额（余额现为 ¥${audit.disposal.agentBalanceAfter.toLocaleString()}），录新单后可用「用代理余额抵尾款」。`,
    );
  } else if (audit.disposal?.kind === 'RECEIPT_POOL') {
    lines.push(
      `多出 ¥${audit.disposal.amountCny.toLocaleString()} 已转入挂账池（进账 ${audit.disposal.receiptNo}），到收款对账台认领给新单。`,
    );
  }
  if (audit.outstandingCny > 0) lines.push(`尚欠 ¥${audit.outstandingCny.toLocaleString()}，留在本单照常收款。`);
  if (audit.releasedLegs.length > 0) lines.push(`已释放座位：${audit.releasedLegs.map(legLabel).join('、')}。`);
  if (audit.flownLegs.length > 0) lines.push(`已起飞、未退座：${audit.flownLegs.map(legLabel).join('、')}。`);
  return lines.join('\n');
}

/** 换人后钱的去向：代理单进代理余额，直客单进挂账池。 */
function disposalTarget(order: OrderSummary): string {
  if (order.agent) {
    const name = order.agent.companyName ?? order.agent.contactName ?? '';
    return `代理余额${name ? `（${name}）` : ''}`;
  }
  return '挂账池（收款对账台待认领）';
}

export interface MarkSwappedModalProps {
  open: boolean;
  /** 目标订单：可以是列表行快照；弹窗打开后会自己补水拿退款记录与代理。 */
  order: OrderSummary | null;
  token: string;
  onClose: () => void;
  /** 提交成功：返回更新后的整单与结果明细（调用方据此刷新列表/抽屉并弹结果）。 */
  onDone: (updated: OrderSummary, audit: MarkSwappedAudit) => void;
}

export function MarkSwappedModal({ open, order, token, onClose, onDone }: MarkSwappedModalProps) {
  const [hydrated, setHydrated] = useState<OrderSummary | null>(null);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const [feeInput, setFeeInput] = useState('');
  const [feeOptions, setFeeOptions] = useState<number[]>([]);
  const [replacementOrderNumber, setReplacementOrderNumber] = useState('');
  const [note, setNote] = useState('');
  const [flownAcknowledged, setFlownAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开即补水：净收款要扣已完成退款，代理名与航段出发日也只有详情才带全。
  useEffect(() => {
    if (!open || !order || !token) return;
    let cancelled = false;
    setHydrated(null);
    setHydrateError(null);
    setFeeInput('');
    setReplacementOrderNumber('');
    setNote('');
    setFlownAcknowledged(false);
    setError(null);
    void api
      .getOrder(token, order.id)
      .then((res) => {
        if (!cancelled) setHydrated(res.order);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHydrateError(e instanceof ApiError ? e.message : '订单详情加载失败，请重试');
      });
    void api
      .getSwapFeeOptions(token)
      .then((res) => {
        if (!cancelled) setFeeOptions(res.options);
      })
      .catch(() => {
        // 标准档只是快捷填入，取不到就手填，不阻塞流程。
      });
    return () => {
      cancelled = true;
    };
  }, [open, order, token]);

  const o = hydrated ?? order;

  // 净收款 = 已付 − 已完成退款 + 预存抵扣（与后端 markSwapped 的清账口径一字一致）。
  const netPaidCny = useMemo(() => {
    if (!hydrated || !hydrated.refunds) return null;
    const paid = Number(hydrated.paidAmount);
    if (!Number.isFinite(paid)) return null;
    const completedRefunds = hydrated.refunds.reduce((sum, r) => {
      if (r.status !== 'COMPLETED') return sum;
      const amount = Number(r.amount);
      return Number.isFinite(amount) ? sum + amount : sum;
    }, 0);
    const prepaid = Number(hydrated.prepaymentOffset) || 0;
    return roundCny(paid - completedRefunds + prepaid);
  }, [hydrated]);

  // 应收（清账口径）= total + 售后费；后端下发 effectivePayable 优先。
  const payableCny = useMemo(() => {
    if (!o) return null;
    const backend = Number(o.effectivePayable);
    if (Number.isFinite(backend)) return roundCny(backend);
    return roundCny((Number(o.total) || 0) + (Number(o.adjustmentCny) || 0));
  }, [o]);

  // 出发日早于今天（北京）的航段按已起飞提示；同日的由后端按班次时刻判。
  const legs = useMemo(() => {
    if (!hydrated) return { flown: [] as string[], upcoming: [] as string[], total: 0 };
    const today = localYmd(new Date().toISOString(), BUSINESS_TZ);
    const flown: string[] = [];
    const upcoming: string[] = [];
    for (const it of hydrated.items ?? []) {
      if (it.kind !== 'FLIGHT' || !it.flightScheduleId) continue;
      const label = `${it.flightNumber ?? ''} ${it.departureDate ?? ''}`.trim() || it.description;
      if (it.departureDate && it.departureDate < today) flown.push(label);
      else upcoming.push(label);
    }
    return { flown, upcoming, total: flown.length + upcoming.length };
  }, [hydrated]);
  const allFlown = legs.total > 0 && legs.upcoming.length === 0;

  const fee = feeInput.trim() === '' ? null : Number(feeInput);
  const feeValid = fee !== null && Number.isInteger(fee) && fee >= 0;
  const overpay = feeValid && netPaidCny !== null ? Math.max(0, roundCny(netPaidCny - fee)) : null;
  const outstanding = feeValid && netPaidCny !== null ? Math.max(0, roundCny(fee - netPaidCny)) : null;

  const disabledReason = !o
    ? '未选择订单'
    : !MARK_SWAPPED_ELIGIBLE_STATUSES.has(o.status)
      ? '当前订单状态不可标记已换人'
      : hydrateError
        ? hydrateError
        : !hydrated || netPaidCny === null
          ? '详情尚未加载完成，无法计算净收款'
          : allFlown && !flownAcknowledged
            ? '所有航段均已起飞，请先勾选确认'
            : null;

  const submit = async (): Promise<void> => {
    if (!o || submitting || disabledReason) return;
    if (!feeValid || fee === null) {
      setError('换人费必须填写为大于等于 0 的整数 CNY');
      return;
    }
    const target = disposalTarget(o);
    const lines = [
      `将 ${o.orderNumber} 标记为「已换人」？`,
      `应收 ¥${payableCny?.toLocaleString() ?? '—'} → 换人费 ¥${fee.toLocaleString()}；已收 ¥${netPaidCny?.toLocaleString() ?? '—'}。`,
      overpay && overpay > 0 ? `多出 ¥${overpay.toLocaleString()} 将存入${target}。` : '',
      outstanding && outstanding > 0 ? `还需收 ¥${outstanding.toLocaleString()}（欠款留在本单）。` : '',
      legs.flown.length > 0 ? `已起飞航段不退座：${legs.flown.join('、')}。` : '',
      '未飞航段座位当场释放，代理佣金整单冲销；本期不支持撤销。',
    ].filter(Boolean);
    if (!window.confirm(lines.join('\n'))) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.markSwapped(token, o.id, {
        swapFeeCny: fee,
        replacementOrderNumber: replacementOrderNumber.trim() || undefined,
        note: note.trim() || undefined,
      });
      onDone(res.order, res.audit);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={o ? `标记已换人 · ${o.orderNumber}` : '标记已换人'}
      size="md"
      footer={(
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting || disabledReason !== null || !feeValid}
            title={disabledReason ?? undefined}
            onClick={() => void submit()}
          >
            {submitting ? '提交中…' : '标记已换人'}
          </button>
        </div>
      )}
    >
      <div className="space-y-4 px-5 py-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          <div>本单应收收敛为换人费，多出的钱不退现金：{o ? `存入${disposalTarget(o)}` : '存入代理余额或挂账池'}，可抵新单尾款。</div>
          <div>未飞航段座位当场释放；已起飞航段不退座。出票/送签/订房任务同取消口径终态化。</div>
          <div>代理佣金整单冲销（换人费不计佣）。换人费收不够的部分留在本单当欠款，照常收款。</div>
          <div>接手订单号选填，只作记录；这笔钱不会直接转到那张单上。</div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">换人费（元）</span>
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            className="input w-full"
            value={feeInput}
            onChange={(e) => {
              setFeeInput(e.target.value);
              setError(null);
            }}
            placeholder="请输入整数金额，0 = 一分不收"
          />
          {feeOptions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {feeOptions.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`rounded-md border px-2 py-0.5 text-xs ${
                    fee === opt ? 'border-brand bg-brand-50 text-brand-dark' : 'border-slate-200 text-ink-soft hover:bg-slate-50'
                  }`}
                  onClick={() => {
                    setFeeInput(String(opt));
                    setError(null);
                  }}
                >
                  ¥{opt}
                </button>
              ))}
            </div>
          )}
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">接手订单号（选填）</span>
          <input
            type="text"
            maxLength={64}
            className="input w-full"
            value={replacementOrderNumber}
            onChange={(e) => {
              setReplacementOrderNumber(e.target.value);
              setError(null);
            }}
            placeholder="新单还没录可留空，之后再补"
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">备注（选填）</span>
          <textarea
            rows={2}
            maxLength={500}
            className="input w-full resize-y"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：客人临时有事，位子让给同行的人"
          />
        </label>

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-ink-muted">应收 → 换人费</span>
            <span className="nums font-medium text-ink">
              ¥{payableCny?.toLocaleString() ?? '—'} → ¥{feeValid && fee !== null ? fee.toLocaleString() : '—'}
            </span>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-ink-muted">已收（净收款）</span>
            <span className="nums font-medium text-ink">¥{netPaidCny?.toLocaleString() ?? '—'}</span>
          </div>
          {overpay !== null && overpay > 0 && o && (
            <div className="mt-1 flex justify-between gap-3 border-t border-slate-200 pt-1 font-medium">
              <span className="text-ink-muted">多出 → {disposalTarget(o)}</span>
              <span className="nums text-emerald-700">¥{overpay.toLocaleString()}</span>
            </div>
          )}
          {outstanding !== null && outstanding > 0 && (
            <div className="mt-1 flex justify-between gap-3 border-t border-slate-200 pt-1 font-medium">
              <span className="text-ink-muted">还需收</span>
              <span className="nums text-red-600">¥{outstanding.toLocaleString()}</span>
            </div>
          )}
          {overpay === 0 && outstanding === 0 && (
            <div className="mt-1 text-right text-xs font-medium text-emerald-700">换人费恰好等于已收，本单结清</div>
          )}
        </div>

        {legs.flown.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-ink-soft">
            <div>已起飞航段（不退座）：{legs.flown.join('、')}</div>
            {legs.upcoming.length > 0 && <div>将释放座位：{legs.upcoming.join('、')}</div>}
            {allFlown && (
              <label className="mt-1.5 flex items-center gap-2 text-amber-800">
                <input
                  type="checkbox"
                  checked={flownAcknowledged}
                  onChange={(e) => setFlownAcknowledged(e.target.checked)}
                />
                所有航段均已起飞，本次不会释放任何座位，仍要标记已换人
              </label>
            )}
          </div>
        )}

        {(error || hydrateError) && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error ?? hydrateError}
          </div>
        )}
      </div>
    </Modal>
  );
}
