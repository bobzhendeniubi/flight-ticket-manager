/**
 * 收款对账台 · ADMIN/STAFF
 *
 * 客服/财务一处看所有进账，把「挂账/超额/认不出的钱」认领到订单或退款；
 * 还能配置统一收款码（收款渠道管理）。
 *
 * 数据源（backend receipts + payment-channels；契约见 admin-web/src/lib/api.ts）：
 *   GET  /receipts?status=&q=        - 进账列表（每条带 remainingCny + allocations[]）
 *   GET  /receipts/ledger            - 全部流水（进账 + 订单收款合并，时间倒序）
 *   POST /receipts                   - 登记新进账（后台手动录入）
 *   POST /receipts/:id/allocate      - 认领（金额分配到某订单，原子）
 *   POST /receipts/:id/allocations/:allocationId/reverse - 撤销认款（认领的逆操作，原子对称）
 *   POST /receipts/:id/refund        - 退款（剩余金额标记退款）
 *
 * 设计：Console 极简（靛蓝 Inter）；金额一律 NumberInput；变更前 confirm()；
 * 后端报错就地内联展示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  PAYMENT_METHOD_LABEL,
  RECEIPT_SOURCE_LABEL,
  RECEIPT_STATUS_LABEL,
  type LedgerEntry,
  type PaymentMethod,
  type Receipt,
  type ReceiptStatus,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { PaymentChannelsManager } from '../components/PaymentChannelsManager';
import { ProofImageViewer } from '../components/ProofImageViewer';
import { StatementReconciliation } from '../components/StatementReconciliation';
import { Icon } from '../components/Icon';
import { useConfirm } from '../components/ConfirmDialog';
import { useDialogA11y } from '../components/Modal';

// 收款方式选项（与订单收款一致）
const METHOD_OPTIONS: PaymentMethod[] = ['WECHAT_PAY', 'ALIPAY', 'BANK_CARD', 'AGENT_PREPAYMENT'];

// 进账截图最大 6MB（与后端 proofUrlSchema 对齐）
const MAX_PROOF_BYTES = 6 * 1024 * 1024;

// 顶部过滤页签（statement = 流水认款工作台：导入二维码流水 + 分房式拖拽配对）
type Tab = 'open' | 'statement' | 'allocated' | 'refunded' | 'ledger' | 'channels';

// 状态徽标 → Console badge
function statusBadge(status: ReceiptStatus): string {
  switch (status) {
    case 'OPEN':
      return 'badge-warning';
    case 'PARTIALLY_ALLOCATED':
      return 'badge-info';
    case 'ALLOCATED':
      return 'badge-success';
    case 'REFUNDED':
      return 'badge-neutral';
    default:
      return 'badge-neutral';
  }
}

function fmtCny(s: string | number | null | undefined): string {
  if (s == null) return '—';
  const n = typeof s === 'string' ? Number(s) : s;
  if (!Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

// 流水来源标签：进账来源映射成中文，其它（如订单收款的 source）原样回显
function ledgerSourceLabel(source: string): string {
  return (RECEIPT_SOURCE_LABEL as Record<string, string>)[source] ?? source;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// ── 主页面 ───────────────────────────────────────────────────────────────────
export function ReconciliationPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [tab, setTab] = useState<Tab>('open');
  const [q, setQ] = useState('');
  // 到账日期闭区间筛选（按流水交易日期 receivedAt，北京时；传后端）
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  // 加载进账列表（用于待认领/已认领/已退款 + KPI 计算）
  const loadReceipts = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    const params = {
      ...(q.trim() ? { q: q.trim() } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    };
    api
      .listReceipts(token, Object.keys(params).length ? params : undefined)
      .then((r) => setReceipts(r.receipts))
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : '加载进账失败'))
      .finally(() => setLoading(false));
  }, [token, q, from, to]);

  // 加载全部流水（仅在切到「全部流水」页签时拉）
  const loadLedger = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    api
      .getReceiptLedger(token)
      .then((r) => setLedger(r.entries))
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : '加载流水失败'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (tab === 'channels' || tab === 'statement') return; // 渠道管理/流水工作台自带加载
    if (tab === 'ledger') loadLedger();
    else loadReceipts();
  }, [tab, loadReceipts, loadLedger]);

  // KPI：挂账余额 = 未结进账剩余合计；今日进账 = 今日 receivedAt 金额合计；待认领笔数
  const kpi = useMemo(() => {
    let poolRemaining = 0;
    let todayIn = 0;
    let unclaimedCount = 0;
    for (const r of receipts) {
      const remaining = Number(r.remainingCny);
      if (r.status === 'OPEN' || r.status === 'PARTIALLY_ALLOCATED') {
        if (Number.isFinite(remaining)) poolRemaining += remaining;
        unclaimedCount += 1;
      }
      if (isToday(r.receivedAt)) {
        const amt = Number(r.amountCny);
        if (Number.isFinite(amt)) todayIn += amt;
      }
    }
    return { poolRemaining, todayIn, unclaimedCount };
  }, [receipts]);

  // 按页签过滤进账
  const filtered = useMemo(() => {
    switch (tab) {
      case 'open':
        return receipts.filter((r) => r.status === 'OPEN' || r.status === 'PARTIALLY_ALLOCATED');
      case 'allocated':
        return receipts.filter((r) => r.status === 'ALLOCATED');
      case 'refunded':
        return receipts.filter((r) => r.status === 'REFUNDED');
      default:
        return receipts;
    }
  }, [tab, receipts]);

  function onAfterMutation() {
    // 认领/退款后重拉，KPI 随之更新
    loadReceipts();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">收款对账台</h1>
          <p className="page-sub">
            一处看所有进账 · 把挂账 / 超额 / 认不出的钱认领到订单或退款 · 配置统一收款码
          </p>
        </div>
        {tab !== 'channels' && tab !== 'statement' && (
          <button type="button" className="btn-primary text-sm" onClick={() => setShowRegister(true)}>
            + 登记新进账
          </button>
        )}
      </header>

      {/* KPI 条 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="stat-card">
          <div className="stat-label">挂账余额（待认领剩余）</div>
          <div className="stat-value text-amber-700">{fmtCny(kpi.poolRemaining)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">今日进账</div>
          <div className="stat-value text-emerald-700">{fmtCny(kpi.todayIn)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">待认领笔数</div>
          <div className="stat-value">{kpi.unclaimedCount}</div>
        </div>
      </div>

      {/* 页签 */}
      <nav className="flex flex-wrap items-center gap-2">
        <TabBtn active={tab === 'open'} onClick={() => setTab('open')}>
          待认领
        </TabBtn>
        <TabBtn active={tab === 'statement'} onClick={() => setTab('statement')}>
          流水认款
        </TabBtn>
        <TabBtn active={tab === 'allocated'} onClick={() => setTab('allocated')}>
          已认领
        </TabBtn>
        <TabBtn active={tab === 'refunded'} onClick={() => setTab('refunded')}>
          已退款
        </TabBtn>
        <TabBtn active={tab === 'ledger'} onClick={() => setTab('ledger')}>
          全部流水
        </TabBtn>
        <TabBtn active={tab === 'channels'} onClick={() => setTab('channels')}>
          收款渠道
        </TabBtn>

        {tab !== 'channels' && tab !== 'ledger' && tab !== 'statement' && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {/* 到账日期区间（传后端，按 receivedAt） */}
            <input
              type="date"
              className="input w-36 py-1.5 text-sm"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="到账日期从"
            />
            <span className="text-xs text-ink-muted">~</span>
            <input
              type="date"
              className="input w-36 py-1.5 text-sm"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="到账日期到"
            />
            <input
              className="input py-1.5"
              placeholder="搜进账号 / 流水号 / 付款备注 / 订单提示"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') loadReceipts();
              }}
            />
          </div>
        )}
      </nav>

      {err && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

      {tab === 'channels' ? (
        <PaymentChannelsManager />
      ) : tab === 'statement' ? (
        <StatementReconciliation token={token} onMutated={loadReceipts} />
      ) : tab === 'ledger' ? (
        <LedgerTable rows={ledger} loading={loading} />
      ) : (
        <ReceiptTable
          rows={filtered}
          loading={loading}
          token={token}
          onAfterMutation={onAfterMutation}
        />
      )}

      {showRegister && (
        <RegisterReceiptModal
          token={token}
          onClose={() => setShowRegister(false)}
          onCreated={() => {
            setShowRegister(false);
            loadReceipts();
          }}
        />
      )}
    </div>
  );
}

// ── 页签按钮（与 FinancesPage TabBtn 同风格） ────────────────────────────────
function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3.5 py-1.5 text-sm font-medium transition ${
        active
          ? 'border-brand bg-brand text-white'
          : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

// ── 进账表（待认领 / 已认领 / 已退款） ───────────────────────────────────────
function ReceiptTable({
  rows,
  loading,
  token,
  onAfterMutation,
}: {
  rows: Receipt[];
  loading: boolean;
  token: string;
  onAfterMutation: () => void;
}) {
  return (
    <div className="card p-0">
      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th>进账号</th>
              <th className="text-right">金额</th>
              <th className="text-right">剩余</th>
              <th>方式</th>
              <th>付款人 / 备注</th>
              <th>来源</th>
              <th>截图</th>
              <th>状态</th>
              <th>时间</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="py-6 text-center text-sm text-ink-muted">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-6 text-center text-sm text-ink-muted">
                  暂无进账。
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((r) => (
                <ReceiptRow key={r.id} receipt={r} token={token} onAfterMutation={onAfterMutation} />
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReceiptRow({
  receipt,
  token,
  onAfterMutation,
}: {
  receipt: Receipt;
  token: string;
  onAfterMutation: () => void;
}) {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
  const [action, setAction] = useState<'none' | 'allocate' | 'refund'>('none');
  // 撤销认款：一次只撤一笔（reversingId = 正在撤的那条明细 id），错误/提示就地展示
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [reverseErr, setReverseErr] = useState<string | null>(null);
  const [reverseWarning, setReverseWarning] = useState<string | null>(null);
  const remaining = Number(receipt.remainingCny);
  const canMutate = receipt.status === 'OPEN' || receipt.status === 'PARTIALLY_ALLOCATED';

  /**
   * 撤销一笔认款：钱从订单撤回本进账的剩余额，可再认给别的订单。
   * 二次确认带订单号 + 金额（撤错单就是资金事故）；后端拒绝原因（收款已锁定 / 死单 /
   * 进账已退款 / 账目倒挂）原样展示，不改写成笼统文案。
   */
  async function reverse(a: Receipt['allocations'][number]): Promise<void> {
    if (!token || reversingId || confirmLockRef.current) return;
    const orderLabel = a.orderNumber ?? a.orderId.slice(0, 8);
    confirmLockRef.current = true;
    if (!(await confirm({
      title: `确认撤销订单 ${orderLabel} 的这笔认款 ¥${Number(a.amountCny).toLocaleString()}？`,
      body:
        `撤销后：该订单已付金额减回、这笔收款记录冲销，钱回到进账 ${receipt.receiptNo} 的剩余额里待重新认领。\n` +
        '注意：订单状态、佣金与履约任务不会回退。',
      tone: 'danger',
    }))) {
      confirmLockRef.current = false;
      return;
    }
    setReverseErr(null);
    setReverseWarning(null);
    setReversingId(a.id);
    try {
      const res = await api.reverseReceiptAllocation(token, receipt.id, a.id);
      if (res.warning) setReverseWarning(res.warning);
      onAfterMutation();
    } catch (e: unknown) {
      setReverseErr(e instanceof ApiError ? e.message : '撤销认款失败');
    } finally {
      setReversingId(null);
      confirmLockRef.current = false;
    }
  }

  return (
    <>
      <tr>
        <td className="font-mono text-xs text-ink">{receipt.receiptNo}</td>
        <td className="nums text-right text-ink">{fmtCny(receipt.amountCny)}</td>
        <td className="nums text-right font-medium text-amber-700">{fmtCny(receipt.remainingCny)}</td>
        <td>{PAYMENT_METHOD_LABEL[receipt.method] ?? receipt.method}</td>
        <td className="max-w-[200px] truncate" title={receipt.payerNote ?? ''}>
          {receipt.payerNote || '—'}
          {receipt.orderHintId && (
            <span className="ml-1 text-xs text-ink-muted" title={`订单 id ${receipt.orderHintId}`}>
              （提示订单 {receipt.hintOrderNumber ?? receipt.orderHintId.slice(0, 8)}）
            </span>
          )}
        </td>
        <td>
          <span className="badge-neutral">{RECEIPT_SOURCE_LABEL[receipt.source] ?? receipt.source}</span>
        </td>
        <td>
          {receipt.proofUrl ? (
            <ProofImageViewer
              src={receipt.proofUrl}
              alt={`${receipt.receiptNo} 截图`}
              thumbClassName="h-9 w-9 rounded border border-slate-200 object-cover"
            />
          ) : (
            <span className="text-xs text-ink-muted">—</span>
          )}
        </td>
        <td>
          <span className={statusBadge(receipt.status)}>{RECEIPT_STATUS_LABEL[receipt.status]}</span>
        </td>
        <td className="whitespace-nowrap text-xs text-ink-muted">{fmtDateTime(receipt.receivedAt)}</td>
        <td className="text-right">
          {canMutate ? (
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                className="btn-secondary px-2.5 py-1 text-xs"
                onClick={() => setAction(action === 'allocate' ? 'none' : 'allocate')}
              >
                认领
              </button>
              <button
                type="button"
                className="btn-ghost px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50"
                onClick={() => setAction(action === 'refund' ? 'none' : 'refund')}
              >
                退款
              </button>
            </div>
          ) : (
            <span className="text-xs text-ink-muted">
              {receipt.status === 'REFUNDED' && receipt.refundNote ? `已退款：${receipt.refundNote}` : '—'}
            </span>
          )}
        </td>
      </tr>

      {/* 已认领明细（展开行）+ 逐笔撤销 */}
      {receipt.allocations.length > 0 && (
        <tr>
          <td colSpan={10} className="bg-slate-50/60 !py-2 text-xs text-ink-soft">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
              <span>已认领：</span>
              {receipt.allocations.map((a) => (
                <span key={a.id} className="ml-1 inline-flex items-center gap-1">
                  {/* 订单号（财务照着核对账）；服务端 join 不到才回落 id 前 8 位，title 恒为完整 id */}
                  <span className="font-mono text-ink-muted" title={`订单 id ${a.orderId}`}>
                    {a.orderNumber ?? a.orderId.slice(0, 8)}
                  </span>
                  <span className="font-medium text-emerald-700">{fmtCny(a.amountCny)}</span>
                  {/* 撤销：把这笔钱从订单撤回挂账池（认领的逆操作，可再认给别的订单） */}
                  {receipt.status !== 'REFUNDED' && (
                    <button
                      type="button"
                      className="btn-ghost-danger px-1.5 py-0.5 text-xs disabled:opacity-50"
                      disabled={reversingId !== null}
                      onClick={() => void reverse(a)}
                      title="撤销这笔认款：钱回到挂账池待重新认领"
                    >
                      {reversingId === a.id ? '撤销中…' : '撤销'}
                    </button>
                  )}
                </span>
              ))}
            </div>
            {reverseErr && (
              <div className="mt-1.5 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
                {reverseErr}
              </div>
            )}
            {reverseWarning && (
              <div className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                {reverseWarning}
              </div>
            )}
          </td>
        </tr>
      )}

      {/* 认领表单 */}
      {action === 'allocate' && (
        <tr>
          <td colSpan={10} className="bg-brand-50/40 !py-3">
            <AllocateForm
              token={token}
              receiptId={receipt.id}
              remaining={Number.isFinite(remaining) ? remaining : 0}
              onDone={() => {
                setAction('none');
                onAfterMutation();
              }}
              onCancel={() => setAction('none')}
            />
          </td>
        </tr>
      )}

      {/* 退款表单 */}
      {action === 'refund' && (
        <tr>
          <td colSpan={10} className="bg-rose-50/40 !py-3">
            <RefundForm
              token={token}
              receiptId={receipt.id}
              remaining={Number.isFinite(remaining) ? remaining : 0}
              onDone={() => {
                setAction('none');
                onAfterMutation();
              }}
              onCancel={() => setAction('none')}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── 认领：按订单号搜订单 + 金额（默认 = 剩余） ───────────────────────────────
function AllocateForm({
  token,
  receiptId,
  remaining,
  onDone,
  onCancel,
}: {
  token: string;
  receiptId: string;
  remaining: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [orderNo, setOrderNo] = useState('');
  const [matchedOrderId, setMatchedOrderId] = useState<string | null>(null);
  const [matchedLabel, setMatchedLabel] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState<number | null>(remaining > 0 ? remaining : null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 按订单号搜出 orderId（认领需要订单内部 id）
  async function search() {
    const term = orderNo.trim();
    if (!term || searching) return;
    setErr(null);
    setSearching(true);
    setMatchedOrderId(null);
    setMatchedLabel(null);
    try {
      const r = await api.listOrders(token, { search: term, pageSize: 5 });
      const exact = r.orders.find((o) => o.orderNumber.toLowerCase() === term.toLowerCase());
      const pick = exact ?? r.orders[0];
      if (!pick) {
        setErr('没找到匹配的订单，请核对订单号');
        return;
      }
      setMatchedOrderId(pick.id);
      const due = Math.round((Number(pick.total) - Number(pick.paidAmount)) * 100) / 100;
      setMatchedLabel(
        `${pick.orderNumber} · ${pick.contactName} · 应收 ¥${Number(pick.total).toLocaleString()} · 尾款 ¥${due.toLocaleString()}`,
      );
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '查订单失败');
    } finally {
      setSearching(false);
    }
  }

  async function submit() {
    if (!matchedOrderId || submitting) return;
    const amt = amount ?? 0;
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('认领金额需为正数');
      return;
    }
    if (amt > remaining + 1e-6) {
      setErr(`认领金额不能超过剩余 ¥${remaining.toLocaleString()}`);
      return;
    }
    if (!window.confirm(`确认把 ¥${amt.toLocaleString()} 认领到订单 ${matchedLabel ?? matchedOrderId}？`)) return;
    setErr(null);
    setSubmitting(true);
    try {
      await api.allocateReceipt(token, receiptId, { orderId: matchedOrderId, amountCny: amt });
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '认领失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-ink">认领到订单（剩余 ¥{remaining.toLocaleString()}）</div>
      {err && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-soft">
          订单号
          <div className="mt-1 flex gap-1.5">
            <input
              className="input w-48 py-1.5"
              placeholder="如 ORD20260619..."
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') search();
              }}
            />
            <button
              type="button"
              className="btn-secondary px-2.5 py-1.5 text-xs disabled:opacity-50"
              onClick={search}
              disabled={searching || !orderNo.trim()}
            >
              {searching ? '查找中…' : '查找'}
            </button>
          </div>
        </label>
        <label className="text-xs text-ink-soft">
          认领金额
          <NumberInput
            step={0.01}
            min={0}
            max={remaining}
            className="input mt-1 w-32 py-1.5 nums"
            value={amount}
            onChange={(n) => setAmount(n)}
            placeholder={`默认 ¥${remaining}`}
          />
        </label>
        <button
          type="button"
          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
          onClick={submit}
          disabled={submitting || !matchedOrderId}
        >
          {submitting ? '认领中…' : '确认认领'}
        </button>
        <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onCancel}>
          取消
        </button>
      </div>
      {matchedLabel && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          <Icon name="check" /> {matchedLabel}
        </div>
      )}
    </div>
  );
}

// ── 退款：必填备注 ───────────────────────────────────────────────────────────
function RefundForm({
  token,
  receiptId,
  remaining,
  onDone,
  onCancel,
}: {
  token: string;
  receiptId: string;
  remaining: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const n = note.trim();
    if (!n) {
      setErr('请填写退款备注');
      return;
    }
    if (submitting || confirmLockRef.current) return;
    confirmLockRef.current = true;
    if (!(await confirm({
      title: `确认把剩余 ¥${remaining.toLocaleString()} 标记退款？`,
      body: '退款后不可再认领。',
      tone: 'danger',
    }))) {
      confirmLockRef.current = false;
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      await api.refundReceipt(token, receiptId, n);
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '退款失败');
    } finally {
      setSubmitting(false);
      confirmLockRef.current = false;
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-ink">退款（剩余 ¥{remaining.toLocaleString()}）</div>
      {err && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-xs text-ink-soft">
          退款备注（必填）
          <input
            className="input mt-1 py-1.5"
            placeholder="如：重复付款 / 客户取消，原路退回"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
        </label>
        <button
          type="button"
          className="btn-danger px-3 py-1.5 text-xs disabled:opacity-50"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? '退款中…' : '确认退款'}
        </button>
        <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// ── 全部流水（进账 + 订单收款，只读） ────────────────────────────────────────
function LedgerTable({ rows, loading }: { rows: LedgerEntry[]; loading: boolean }) {
  return (
    <div className="card p-0">
      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th>类型</th>
              <th>单号</th>
              <th className="text-right">金额</th>
              <th>方式</th>
              <th>来源</th>
              <th>关联订单</th>
              <th>状态</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-sm text-ink-muted">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-sm text-ink-muted">
                  暂无流水。
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((e) => (
                <tr key={`${e.kind}-${e.id}`}>
                  <td>
                    <span className={e.kind === 'RECEIPT' ? 'badge-info' : 'badge-neutral'}>
                      {e.kind === 'RECEIPT' ? '进账' : '订单收款'}
                    </span>
                  </td>
                  <td className="font-mono text-xs text-ink">{e.ref}</td>
                  <td className="nums text-right text-ink">{fmtCny(e.amountCny)}</td>
                  <td>{PAYMENT_METHOD_LABEL[e.method as PaymentMethod] ?? e.method}</td>
                  <td className="text-ink-soft">{ledgerSourceLabel(e.source)}</td>
                  <td className="text-ink-soft">{e.orderNo ?? '—'}</td>
                  <td className="text-ink-soft">{e.status}</td>
                  <td className="whitespace-nowrap text-xs text-ink-muted">{fmtDateTime(e.at)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 登记新进账（后台手动录入）弹窗 ─────────────────────────────────────────────
function RegisterReceiptModal({
  token,
  onClose,
  onCreated,
}: {
  token: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const dialogRef = useDialogA11y(onClose);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('WECHAT_PAY');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [payerNote, setPayerNote] = useState('');
  const [orderHintId, setOrderHintId] = useState('');
  const [receivedAt, setReceivedAt] = useState(''); // 空 = 后端默认 now
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_PROOF_BYTES) {
      setErr('截图过大（>6MB），请压缩后再传');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setProofUrl(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(f);
  }

  async function submit() {
    if (submitting) return;
    const amt = amount ?? 0;
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('金额需为正数');
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      await api.createReceipt(token, {
        amountCny: amt,
        method,
        proofUrl: proofUrl ?? undefined,
        payerNote: payerNote.trim() || undefined,
        orderHintId: orderHintId.trim() || undefined,
        receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
      });
      onCreated();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '登记失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="登记新进账" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative z-10 w-full max-w-lg rounded-xl bg-surface p-5 shadow-pop">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-semibold text-ink">登记新进账</h2>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-ink-muted hover:bg-slate-100 hover:text-ink"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        {err && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {err}
          </div>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">金额（CNY）</span>
            <NumberInput
              step={0.01}
              min={0}
              className="input nums"
              value={amount}
              onChange={(n) => setAmount(n)}
              placeholder="0.00"
            />
          </label>
          <label className="block">
            <span className="label">收款方式</span>
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            >
              {METHOD_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </label>

          <label className="block sm:col-span-2">
            <span className="label">付款人备注（选填）</span>
            <input
              className="input"
              value={payerNote}
              onChange={(e) => setPayerNote(e.target.value)}
              placeholder="如：王先生 / 微信转账尾号 1234"
              maxLength={500}
            />
          </label>

          <label className="block">
            <span className="label">订单提示号（选填）</span>
            <input
              className="input"
              value={orderHintId}
              onChange={(e) => setOrderHintId(e.target.value)}
              placeholder="客户自报的订单号，便于认领"
              maxLength={64}
            />
          </label>
          <label className="block">
            <span className="label">到账时间（选填，默认现在）</span>
            <input
              type="datetime-local"
              className="input"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
            />
          </label>

          <div className="block sm:col-span-2">
            <span className="label">收款截图（≤6MB，选填）</span>
            <div className="mt-1 flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-ink-soft hover:bg-slate-50">
                <Icon name="camera" /> 上传图片
                <input type="file" accept="image/*" className="hidden" onChange={onFile} />
              </label>
              {proofUrl && (
                <>
                  <img
                    src={proofUrl}
                    alt="截图预览"
                    className="h-12 w-12 rounded border border-slate-300 object-cover"
                  />
                  <button
                    type="button"
                    className="btn-ghost-danger text-xs"
                    onClick={() => setProofUrl(null)}
                  >
                    移除
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-secondary text-sm" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary text-sm disabled:opacity-50"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? '登记中…' : '登记进账'}
          </button>
        </div>
      </div>
    </div>
  );
}
