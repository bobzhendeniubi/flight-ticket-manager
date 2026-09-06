/**
 * 退款「待打款」队列 —— 财务页的一个页签。
 *
 * 它回答的问题是：**哪些退款已经核准，但钱还没真的打出去。**
 * 订单转「已退款」时退款记录就翻成已核准了，可真正把钱退给客人是财务在银行/微信里的手工动作。
 * 此前这一步没有任何系统痕迹，于是「核准了一直没打」（客人来催才发现）和「同一笔打了两次」
 * 都只能靠线下表格发现。
 *
 * 登记只写打款痕迹（时间/渠道/流水号/备注/登记人），**不改退款状态、不动订单的已收与尾款**。
 * 重复登记后端直接拒（409）——真打了两笔和手滑点两次必须分得清。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  REFUND_PAY_METHOD_LABEL,
  type MarkRefundPaidInput,
  type PendingRefundPayoutResult,
  type PendingRefundPayoutRow,
  type RefundPayMethod,
} from '../lib/api';
import { formatDateTimeCn } from '../lib/datetime';
import { useAuth } from '../stores/auth';
import { Icon } from './Icon';
import { Modal } from './Modal';

const PAY_METHODS: RefundPayMethod[] = ['BANK', 'WECHAT', 'ALIPAY', 'CASH', 'OTHER'];

/** 与后端 PAYOUT_OVERDUE_DAYS 同一个数：超过一周还没打款基本就是漏了。 */
const OVERDUE_DAYS = 7;

function fmtCny(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function RefundPayoutQueue() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';
  const [data, setData] = useState<PendingRefundPayoutResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<PendingRefundPayoutRow | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    try {
      setData(await api.listPendingRefundPayouts(token));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '加载待打款队列失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="待打款笔数" value={String(data?.rows.length ?? 0)} sub="已核准但未登记打款" />
        <StatCard label="待打款金额" value={fmtCny(data?.totalAmountCny ?? 0)} sub="按退款单金额合计" />
        <StatCard
          label={`账龄 ≥${OVERDUE_DAYS} 天`}
          value={String(data?.overdueCount ?? 0)}
          sub="核准后迟迟没打款的笔数"
          tone={(data?.overdueCount ?? 0) > 0 ? 'warn' : undefined}
        />
      </div>

      <div className="rounded-md border border-slate-200 bg-white">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">待打款退款</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              这里的退款系统里已核准，钱还要财务在银行/微信里手工打出去。打完回来点「标记已打款」，
              只记打款痕迹，不改退款状态、不动订单的已收与尾款。
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary shrink-0 text-xs px-3 py-1.5"
            onClick={() => void reload()}
          >
            刷新
          </button>
        </header>

        {err && <div className="mx-4 my-3 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">订单号</th>
                <th className="px-4 py-2.5 text-left font-semibold">客户 / 代理</th>
                <th className="px-4 py-2.5 text-right font-semibold">应退金额</th>
                <th className="px-4 py-2.5 text-left font-semibold">申请日</th>
                <th className="px-4 py-2.5 text-left font-semibold">核准日</th>
                <th className="px-4 py-2.5 text-right font-semibold">账龄</th>
                <th className="px-4 py-2.5 text-left font-semibold">类型</th>
                <th className="px-4 py-2.5 text-right font-semibold">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading && (data?.rows.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    队列已清空 —— 没有等着打款的退款
                  </td>
                </tr>
              )}
              {data?.rows.map((r) => (
                <tr key={r.refundId} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{r.orderNumber}</td>
                  <td className="px-4 py-2.5">
                    <div className="text-slate-800">{r.contactName}</div>
                    <div className="text-xs text-slate-500">{r.agencyLabel ?? '直客'}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold text-slate-900">
                    {fmtCny(r.amountCny)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">{formatDateTimeCn(r.requestedAt)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {r.approvedAt ? formatDateTimeCn(r.approvedAt) : '—'}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right text-xs font-semibold ${
                      r.ageDays >= OVERDUE_DAYS ? 'text-rose-600' : 'text-slate-600'
                    }`}
                  >
                    {r.ageDays} 天
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {r.isSwapRefund ? '换人退款' : '取消退款'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      className="btn-primary text-xs px-2.5 py-1.5"
                      onClick={() => setTarget(r)}
                    >
                      标记已打款
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {target && (
        <MarkPaidModal
          row={target}
          onClose={() => setTarget(null)}
          onDone={async () => {
            setTarget(null);
            await reload();
          }}
        />
      )}
    </section>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn';
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        tone === 'warn' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone === 'warn' ? 'text-amber-800' : 'text-slate-900'}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

/**
 * 标记已打款弹窗。
 *
 * 金额刻意**不给填**：退多少由退款单定死，在这里开一个金额输入框就等于绕过退款核准去付款。
 * 打款时间可回溯（打完钱隔天才来登记是常态），未来时刻由后端拒。
 */
function MarkPaidModal({
  row,
  onClose,
  onDone,
}: {
  row: PendingRefundPayoutRow;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [paidMethod, setPaidMethod] = useState<RefundPayMethod>('BANK');
  const [paidAtLocal, setPaidAtLocal] = useState<string>(() => toLocalInputValue(new Date()));
  const [paidTxnRef, setPaidTxnRef] = useState('');
  const [paidNote, setPaidNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!tokens || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const body: MarkRefundPaidInput = {
        paidMethod,
        // datetime-local 拿到的是本机墙钟，转成带时区的 ISO 交给后端，别让服务器按 UTC 猜。
        paidAt: new Date(paidAtLocal).toISOString(),
        paidTxnRef: paidTxnRef.trim() || undefined,
        paidNote: paidNote.trim() || undefined,
      };
      await api.markRefundPaid(tokens.accessToken, row.orderId, row.refundId, body);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '登记失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="标记已打款"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? '登记中…' : '确认已打款'}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-slate-600">{row.orderNumber}</span>
            <span className="text-lg font-bold text-slate-900">{fmtCny(row.amountCny)}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {row.contactName} · {row.agencyLabel ?? '直客'} ·{' '}
            {row.isSwapRefund ? '换人退款' : '取消退款'}
          </div>
          {row.reason && <div className="mt-1 text-xs text-slate-500">原因：{row.reason}</div>}
        </div>

        <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Icon name="alert" />
          <span>
            这一步只登记「钱已经打出去了」，不会改退款状态、也不会动订单的已收与尾款。
            重复登记会被拒绝——请先确认这笔是不是已经打过。
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label text-xs" htmlFor="payout-method">
              打款渠道 *
            </label>
            <select
              id="payout-method"
              className="input"
              value={paidMethod}
              onChange={(e) => setPaidMethod(e.target.value as RefundPayMethod)}
            >
              {PAY_METHODS.map((m) => (
                <option key={m} value={m}>
                  {REFUND_PAY_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs" htmlFor="payout-at">
              打款时间 *
            </label>
            <input
              id="payout-at"
              type="datetime-local"
              className="input"
              value={paidAtLocal}
              onChange={(e) => setPaidAtLocal(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="label text-xs" htmlFor="payout-ref">
            流水号 / 凭据号
          </label>
          <input
            id="payout-ref"
            className="input"
            placeholder="银行流水号、微信支付单号等，便于日后核对"
            value={paidTxnRef}
            onChange={(e) => setPaidTxnRef(e.target.value)}
          />
        </div>

        <div>
          <label className="label text-xs" htmlFor="payout-note">
            备注
          </label>
          <input
            id="payout-note"
            className="input"
            placeholder="如：分两笔退，本条为第二笔"
            value={paidNote}
            onChange={(e) => setPaidNote(e.target.value)}
          />
        </div>

        {err && <div className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</div>}
      </div>
    </Modal>
  );
}

/** Date → `<input type="datetime-local">` 的值（本机墙钟，分钟精度）。 */
function toLocalInputValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
