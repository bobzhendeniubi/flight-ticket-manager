/**
 * 收款对账台 · ADMIN/STAFF
 *
 * 运营 / 客服 / 财务共用：一处看所有进账，把「挂账 / 超收 / 认不出的钱」核销到订单或退回客户；
 * 还能配置统一收款码（收款渠道管理）。
 *
 * 挂账池口径（cash application）：收到的钱一律全额入账 —— 能核销的先核销到订单应收，
 * 核销不掉的余额留在池子里挂账、带账龄，任何岗位都可以认领处置，不必等某个人来批。
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
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  ApiError,
  PAYMENT_METHOD_LABEL,
  RECEIPT_SOURCE_LABEL,
  RECEIPT_STATUS_LABEL,
  type LedgerEntry,
  type OrderSummary,
  type PaymentMethod,
  type Receipt,
  type ReceiptStatus,
  type UnverifiedPaymentItem,
  type UnverifiedClaimItem,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { businessTzParts, formatDateTimeSecCn, formatInBusinessTz } from '../lib/datetime';
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

// 顶部过滤页签（statement = 流水认款工作台：导入二维码流水 + 分房式拖拽配对；
// unverified = 到账核实异常队列：人工录入的到账要逐笔对上流水才算核实）
type Tab = 'open' | 'statement' | 'unverified' | 'allocated' | 'refunded' | 'ledger' | 'channels';

// 手工到账超过 N 天还没核实 → 标红超期（须回头跟客户确认）
const UNVERIFIED_OVERDUE_DAYS = 3;

// 进账挂在池子里超过 N 天还没核销完 → 标红超期（账龄口径，与待核实同一把尺子）
const UNCLAIMED_OVERDUE_DAYS = 3;

/** 账龄（天）：从登记进池到现在，向下取整。 */
function ageDaysOf(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / (24 * 3600 * 1000));
}

/** 这条进账是否还挂在池子里（未认领 / 部分认领）——超期判定与 KPI 都按这个口径。 */
function isUnclaimed(status: ReceiptStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_ALLOCATED';
}

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

/** 到账时刻，固定北京时间（原先用 getHours 等取浏览器时区，境外看会跟导出差几小时）。 */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatInBusinessTz(d, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// 流水来源标签：进账来源映射成中文，其它（如订单收款的 source）原样回显
function ledgerSourceLabel(source: string): string {
  return (RECEIPT_SOURCE_LABEL as Record<string, string>)[source] ?? source;
}

/**
 * 「今日进账」的今日 = **北京时间的今天**，跟这张表里展示的到账时刻同一口径。
 * 若按浏览器时区判断，境外同事会看到某笔款明明写着今天、却没算进今日合计。
 */
function isToday(iso: string): boolean {
  const day = businessTzParts(iso);
  const today = businessTzParts(new Date());
  if (!day || !today) return false;
  return day.year === today.year && day.month === today.month && day.day === today.day;
}

// ── 主页面 ───────────────────────────────────────────────────────────────────
export function ReconciliationPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [tab, setTab] = useState<Tab>('open');
  // 订单详情收款区「去收款对账台核销」带过来的订单号（?order=…）；只用于提示 + 预填核销表单。
  const [pageSearchParams] = useSearchParams();
  const deepLinkOrderNo = pageSearchParams.get('order')?.trim() ?? '';
  const [q, setQ] = useState('');
  // 到账日期闭区间筛选（按流水交易日期 receivedAt，北京时；传后端）
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [unverifiedPayments, setUnverifiedPayments] = useState<UnverifiedPaymentItem[]>([]);
  const [unverifiedClaims, setUnverifiedClaims] = useState<UnverifiedClaimItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  // 加载进账列表（用于待核销/已核销/已退款 + KPI 计算）
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

  // 加载待核实队列（订单人工收款 + 占位单手工到账，两路并行）
  const loadUnverified = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setErr(null);
    Promise.all([api.listUnverifiedPayments(token), api.listUnverifiedClaims(token)])
      .then(([p, c]) => { setUnverifiedPayments(p.items); setUnverifiedClaims(c.items); })
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : '加载待核实清单失败'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (tab === 'channels' || tab === 'statement') return; // 渠道管理/流水工作台自带加载
    if (tab === 'ledger') loadLedger();
    else if (tab === 'unverified') loadUnverified();
    else loadReceipts();
  }, [tab, loadReceipts, loadLedger, loadUnverified]);

  // 页签角标要在任何页签下都可见 → 进页面就拉一次待核实计数
  useEffect(() => {
    if (!token) return;
    Promise.all([api.listUnverifiedPayments(token), api.listUnverifiedClaims(token)])
      .then(([p, c]) => { setUnverifiedPayments(p.items); setUnverifiedClaims(c.items); })
      .catch(() => { /* 角标计数拉不到不阻断主流程，切到该页签时会再拉并报错 */ });
  }, [token]);

  const unverifiedCount = unverifiedPayments.length + unverifiedClaims.length;
  const unverifiedOverdue = useMemo(() => {
    const cutoff = Date.now() - UNVERIFIED_OVERDUE_DAYS * 24 * 3600 * 1000;
    return (
      unverifiedPayments.filter((p) => new Date(p.createdAt).getTime() < cutoff).length +
      unverifiedClaims.filter((c) => new Date(c.createdAt).getTime() < cutoff).length
    );
  }, [unverifiedPayments, unverifiedClaims]);

  // KPI：挂账余额 = 未结进账剩余合计；今日进账 = 今日 receivedAt 金额合计；
  //      待核销笔数 + 其中账龄超 UNCLAIMED_OVERDUE_DAYS 天的笔数（钱在池子里躺久了要盯）
  const kpi = useMemo(() => {
    let poolRemaining = 0;
    let todayIn = 0;
    let unclaimedCount = 0;
    let unclaimedOverdueCount = 0;
    for (const r of receipts) {
      const remaining = Number(r.remainingCny);
      if (isUnclaimed(r.status)) {
        if (Number.isFinite(remaining)) poolRemaining += remaining;
        unclaimedCount += 1;
        // 账龄按登记进池时间算（createdAt），与行内标红同一口径
        if (ageDaysOf(r.createdAt) >= UNCLAIMED_OVERDUE_DAYS) unclaimedOverdueCount += 1;
      }
      if (isToday(r.receivedAt)) {
        const amt = Number(r.amountCny);
        if (Number.isFinite(amt)) todayIn += amt;
      }
    }
    return { poolRemaining, todayIn, unclaimedCount, unclaimedOverdueCount };
  }, [receipts]);

  // 按页签过滤进账
  const filtered = useMemo(() => {
    switch (tab) {
      case 'open':
        return receipts.filter((r) => isUnclaimed(r.status));
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
            一处看所有进账 · 把挂账 / 超收 / 认不出的钱核销到订单或退回客户 · 配置统一收款码
          </p>
        </div>
        {tab !== 'channels' && tab !== 'statement' && (
          <button type="button" className="btn-primary text-sm" onClick={() => setShowRegister(true)}>
            + 登记新进账
          </button>
        )}
      </header>

      {/* 深链承接：从订单详情收款区跳过来时带 ?order=<订单号>，摆出来说明这趟是来核销哪张单的
          （展开某笔待核销进账后，核销表单的订单搜索框已按它预填）。 */}
      {deepLinkOrderNo && (
        <div className="rounded-lg border border-brand/30 bg-brand-50 px-3 py-2 text-sm text-ink-soft">
          <Icon name="wallet" /> 来自订单 <span className="font-mono font-medium text-ink">{deepLinkOrderNo}</span>
          ：展开下方待核销进账，核销表单已预填该订单号。
        </div>
      )}

      {/* KPI 条 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="stat-card">
          <div className="stat-label">挂账余额（待核销剩余）</div>
          <div className="stat-value text-amber-700">{fmtCny(kpi.poolRemaining)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">今日进账</div>
          <div className="stat-value text-emerald-700">{fmtCny(kpi.todayIn)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">待核销笔数</div>
          <div className="stat-value">
            {kpi.unclaimedCount}
            {kpi.unclaimedOverdueCount > 0 && (
              <span className="ml-2 align-middle text-sm font-semibold text-rose-700">
                其中超 {UNCLAIMED_OVERDUE_DAYS} 天 {kpi.unclaimedOverdueCount} 笔
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 页签 */}
      <nav className="flex flex-wrap items-center gap-2">
        <TabBtn active={tab === 'open'} onClick={() => setTab('open')}>
          待核销
        </TabBtn>
        <TabBtn active={tab === 'statement'} onClick={() => setTab('statement')}>
          流水认款
        </TabBtn>
        <TabBtn active={tab === 'unverified'} onClick={() => setTab('unverified')}>
          待核实{unverifiedCount > 0 ? `（${unverifiedCount}${unverifiedOverdue > 0 ? `，${unverifiedOverdue} 超期` : ''}）` : ''}
        </TabBtn>
        <TabBtn active={tab === 'allocated'} onClick={() => setTab('allocated')}>
          已核销
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

        {tab !== 'channels' && tab !== 'ledger' && tab !== 'statement' && tab !== 'unverified' && (
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
      ) : tab === 'unverified' ? (
        <UnverifiedQueue
          payments={unverifiedPayments}
          claims={unverifiedClaims}
          loading={loading}
          token={token}
          onAfterMutation={loadUnverified}
        />
      ) : tab === 'ledger' ? (
        <LedgerTable rows={ledger} loading={loading} />
      ) : (
        <ReceiptTable
          rows={filtered}
          loading={loading}
          token={token}
          showPoolHint={tab === 'open'}
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

// ── 待核实队列（到账双状态：业务已收 → 已对上流水）─────────────────────────
// 数据 = 订单人工收款（含批量到账/占位单结转未核实款）+ 占位单手工到账（运营水单登记）。
// 超期（> UNVERIFIED_OVERDUE_DAYS 天）标红置顶：对不到流水的钱，必须回头找客户确认。
function UnverifiedQueue({
  payments,
  claims,
  loading,
  token,
  onAfterMutation,
}: {
  payments: UnverifiedPaymentItem[];
  claims: UnverifiedClaimItem[];
  loading: boolean;
  token: string;
  onAfterMutation: () => void;
}) {
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const ageDays = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
  type Row = {
    key: string;
    kind: 'ORDER' | 'HOLD';
    label: string;
    detail: string;
    amountCny: number;
    method: PaymentMethod;
    note: string | null;
    proofUrl: string | null;
    byName: string | null;
    createdAt: string;
  };
  const rows: Row[] = [
    ...payments.map((p): Row => ({
      key: `pay:${p.id}`,
      kind: 'ORDER',
      label: p.orderNumber,
      detail: p.agentName ?? p.contactName ?? '',
      amountCny: p.amountCny,
      method: p.method,
      note: p.note,
      proofUrl: p.proofUrl,
      byName: p.confirmedByName,
      createdAt: p.createdAt,
    })),
    ...claims.map((c): Row => ({
      key: `claim:${c.id}`,
      kind: 'HOLD',
      label: c.holdNo ?? c.receiptNo,
      detail: [c.groupName, c.installmentLabel].filter(Boolean).join(' · '),
      amountCny: c.amountCny,
      method: c.method,
      note: c.note,
      proofUrl: c.proofUrl,
      byName: c.createdByName,
      createdAt: c.createdAt,
    })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const verify = async (row: Row) => {
    setRowErr(null);
    const id = row.key.split(':')[1];
    if (row.kind === 'ORDER') {
      const ok = await confirm({
        title: `核实到账 · ${row.label}`,
        body: `确认已在银行/收单后台对到这笔 ¥${row.amountCny.toLocaleString()}？核实后本单出票提示解除。`,
        confirmText: '已对到流水，核实',
      });
      if (!ok) return;
      setBusyId(row.key);
      try { await api.verifyPayment(token, id); onAfterMutation(); } catch (e) { setRowErr(e instanceof ApiError ? e.message : '核实失败'); } finally { setBusyId(null); }
    } else {
      // 占位单手工到账：可顺手补收单平台交易流水号（写 externalTxnId，同号流水此后导入自动去重）
      const txn = window.prompt(`核实占位单到账 ¥${row.amountCny.toLocaleString()}。\n可填收单平台交易流水号（选填，填了以后同号流水导入会自动去重）：`, '');
      if (txn === null) return;
      setBusyId(row.key);
      try { await api.verifyClaimReceipt(token, id, txn.trim() || undefined); onAfterMutation(); } catch (e) { setRowErr(e instanceof ApiError ? e.message : '核实失败'); } finally { setBusyId(null); }
    }
  };

  if (loading) return <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-ink-muted">加载中…</div>;
  if (rows.length === 0) {
    return <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-ink-muted">没有待核实的到账——所有人工录入的钱都已对过流水。</div>;
  }
  return (
    <div className="space-y-2">
      {rowErr && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{rowErr}</div>}
      <p className="text-xs text-ink-muted">
        这些是凭客户水单录入、还没在银行/收单后台对到流水的钱。谁手上有流水就谁去核对，逐笔核对无误后点「核实」；超过 {UNVERIFIED_OVERDUE_DAYS} 天仍对不到的标红——请回头找客户确认是否真的转了。录入人不能核实自己录的账（管理员除外）。
      </p>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-ink-muted">
              <th className="px-3 py-2">类型</th>
              <th className="px-3 py-2">单号</th>
              <th className="px-3 py-2">归属</th>
              <th className="px-3 py-2 text-right">金额</th>
              <th className="px-3 py-2">方式</th>
              <th className="px-3 py-2">录入人</th>
              <th className="px-3 py-2">录入时间</th>
              <th className="px-3 py-2">账龄</th>
              <th className="px-3 py-2">水单</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const days = ageDays(row.createdAt);
              const overdue = days >= UNVERIFIED_OVERDUE_DAYS;
              return (
                <tr key={row.key} className={`border-b border-slate-100 last:border-0 ${overdue ? 'bg-rose-50/60' : ''}`}>
                  <td className="px-3 py-2"><span className={row.kind === 'ORDER' ? 'badge-info' : 'badge-warning'}>{row.kind === 'ORDER' ? '订单收款' : '占位单到账'}</span></td>
                  <td className="px-3 py-2 font-mono text-xs">{row.label}</td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{row.detail || '—'}</td>
                  <td className="px-3 py-2 text-right font-medium">¥{row.amountCny.toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">{PAYMENT_METHOD_LABEL[row.method] ?? row.method}</td>
                  <td className="px-3 py-2 text-xs">{row.byName ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{formatDateTimeSecCn(row.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">{overdue ? <span className="font-semibold text-rose-700">{days} 天 · 超期</span> : `${days} 天`}</td>
                  <td className="px-3 py-2">{row.proofUrl ? <ProofImageViewer src={row.proofUrl} alt="水单截图" /> : <span className="text-xs text-ink-muted">无</span>}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={busyId === row.key} onClick={() => void verify(row)}>
                      {busyId === row.key ? '核实中…' : '核实'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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

// 订单号格式（generateOrderNumber：FTM + 年月日 + 序号，如 FTM2026070800005）；
// 备注里出现的订单号一律长这样，用来从「超收自动拆分」这类备注文本里抠出完整单号。
const ORDER_NUMBER_RE = /FTM[A-Z0-9]+/g;

/**
 * 从进账备注 + 疑似归属订单号里抠出「完整订单号」集合（去重，保序）。
 * 备注里的号（如「超收自动拆分 · 订单 FTM2026XXXXXXXX」）与服务端 join 出的 hintOrderNumber
 * 经常指向同一张单——只在这里去重一次，调用方不用各自记一遍谁包含谁。
 */
function extractPayerNoteOrderNumbers(
  payerNote: string | null | undefined,
  hintOrderNumber: string | null | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (no: string) => {
    if (!seen.has(no)) {
      seen.add(no);
      found.push(no);
    }
  };
  if (payerNote) {
    for (const m of payerNote.match(ORDER_NUMBER_RE) ?? []) push(m);
  }
  if (hintOrderNumber) push(hintOrderNumber);
  return found;
}

/**
 * 复制到剪贴板，带兼容兜底：非安全上下文 / 权限被拒时 navigator.clipboard 会抛错或干脆不存在，
 * 退化到隐藏 textarea + execCommand（老浏览器 / http 内网访问的常见坑）。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限不可用时走下面的兼容分支
    }
  }
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

/** 订单号 chip：完整号可见、可点复制、可跳订单页——备注截断后唯独订单号不能跟着糊。 */
function OrderNumberChip({ orderNumber }: { orderNumber: string }) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function handleCopy() {
    const ok = await copyToClipboard(orderNumber);
    setFeedback(ok ? 'copied' : 'failed');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), 1500);
  }

  return (
    <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-ink">
      <Link to={`/orders?q=${encodeURIComponent(orderNumber)}`} className="hover:underline" title="跳转到订单页">
        {orderNumber}
      </Link>
      <button
        type="button"
        className="text-ink-muted hover:text-ink"
        onClick={() => void handleCopy()}
        title="复制订单号"
      >
        <Icon name={feedback === 'copied' ? 'check' : 'clipboard'} size={12} />
      </button>
      {feedback === 'copied' && <span className="text-emerald-700">已复制</span>}
      {feedback === 'failed' && <span className="text-rose-700">复制失败</span>}
    </span>
  );
}

/**
 * 「付款人 / 备注」列：订单号单独摘出来渲染成不参与 truncate 的 chip（可见全、可复制、可跳转），
 * 备注正文仍然截断 + title 展全；orderHintId 查不到 hintOrderNumber（如原单已删）时没有真实单号
 * 可复制/跳转，退回旧的纯文本提示。
 */
function PayerNoteCell({ receipt }: { receipt: Receipt }) {
  const orderNumbers = extractPayerNoteOrderNumbers(receipt.payerNote, receipt.hintOrderNumber);
  const rawHintOnly = receipt.orderHintId && !receipt.hintOrderNumber ? receipt.orderHintId : null;
  const hasText = Boolean(receipt.payerNote) || Boolean(rawHintOnly);
  return (
    <div className="flex flex-col gap-1">
      {orderNumbers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {orderNumbers.map((no) => (
            <OrderNumberChip key={no} orderNumber={no} />
          ))}
        </div>
      )}
      {hasText ? (
        <div className="max-w-[200px] truncate text-xs text-ink-muted" title={receipt.payerNote ?? ''}>
          {receipt.payerNote}
          {rawHintOnly && (
            <span title={`订单 id ${rawHintOnly}`}>（提示订单 {rawHintOnly.slice(0, 8)}）</span>
          )}
        </div>
      ) : (
        orderNumbers.length === 0 && <span className="text-xs text-ink-muted">—</span>
      )}
    </div>
  );
}

// ── 进账表（待核销 / 已核销 / 已退款） ───────────────────────────────────────
function ReceiptTable({
  rows,
  loading,
  token,
  showPoolHint = false,
  onAfterMutation,
}: {
  rows: Receipt[];
  loading: boolean;
  token: string;
  /** 待核销页签才提示挂账池口径（已核销 / 已退款页签不需要）。 */
  showPoolHint?: boolean;
  onAfterMutation: () => void;
}) {
  return (
    <div className="card p-0">
      {showPoolHint && (
        <p className="border-b border-slate-200 px-4 py-2.5 text-xs text-ink-muted">
          池子里的钱有两个来路：手工「登记新进账」，以及订单页录收款时超出该单尾款、被自动拆出来的部分
          （来源显示「订单超额」，备注里带原订单号）。逐笔核销到订单或退回客户；账龄超{' '}
          {UNCLAIMED_OVERDUE_DAYS} 天仍没处置完的整行标红——钱挂太久对不上账，谁看到谁跟进。
        </p>
      )}
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
              <th>账龄</th>
              <th>时间</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={11} className="py-6 text-center text-sm text-ink-muted">
                  加载中…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={11} className="py-6 text-center text-sm text-ink-muted">
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
  const canMutate = isUnclaimed(receipt.status);
  // 账龄：钱在池子里躺了几天。还没核销完且超过 UNCLAIMED_OVERDUE_DAYS 天 → 整行标红，
  // 与「待核实」队列同一把尺子：挂太久的钱要么赶紧核销到订单，要么退回客户。
  const ageDays = ageDaysOf(receipt.createdAt);
  const overdue = canMutate && ageDays >= UNCLAIMED_OVERDUE_DAYS;

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
        `撤销后：该订单已付金额减回、这笔收款记录冲销，钱回到进账 ${receipt.receiptNo} 的剩余额里待重新核销。\n` +
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
      <tr className={overdue ? 'bg-rose-50/60' : undefined}>
        <td className="font-mono text-xs text-ink">{receipt.receiptNo}</td>
        <td className="nums text-right text-ink">{fmtCny(receipt.amountCny)}</td>
        <td className="nums text-right font-medium text-amber-700">{fmtCny(receipt.remainingCny)}</td>
        <td>{PAYMENT_METHOD_LABEL[receipt.method] ?? receipt.method}</td>
        <td className="max-w-[240px]">
          <PayerNoteCell receipt={receipt} />
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
        <td className="whitespace-nowrap text-xs">
          {canMutate ? (
            overdue ? (
              <span className="font-semibold text-rose-700">{ageDays} 天 · 超期</span>
            ) : (
              <span className="text-ink-muted">{ageDays} 天</span>
            )
          ) : (
            <span className="text-ink-muted">—</span>
          )}
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
                核销
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
          <td colSpan={11} className="bg-slate-50/60 !py-2 text-xs text-ink-soft">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
              <span>已核销：</span>
              {receipt.allocations.map((a) => (
                <span key={a.id} className="ml-1 inline-flex items-center gap-1">
                  {/* 订单号（照着核对账）；服务端 join 不到才回落 id 前 8 位，title 恒为完整 id */}
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
                      title="撤销这笔认款：钱回到挂账池待重新核销"
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
          <td colSpan={11} className="bg-brand-50/40 !py-3">
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
          <td colSpan={11} className="bg-rose-50/40 !py-3">
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

/**
 * 应收 / 尾款：后端权威口径 balanceDue（= effectivePayable − paidAmount − prepaymentOffset）。
 * 不要在前端自己按「total − paidAmount」算——那样会漏掉售后调整行与代理预存抵扣，同一张单
 * 在订单页和这里会显示两个不一样的尾款。旧后端没下发 balanceDue 时才回落到应付减已付。
 */
function orderBalanceInfo(order: OrderSummary): { payable: number; due: number } {
  const payable =
    order.effectivePayable != null
      ? Number(order.effectivePayable)
      : Number(order.total) + (order.adjustmentCny ?? 0);
  const due =
    order.balanceDue != null
      ? Number(order.balanceDue)
      : Math.round((payable - Number(order.paidAmount) - Number(order.prepaymentOffset ?? 0)) * 100) / 100;
  return { payable, due };
}

/**
 * 乘客姓名（中文名优先，缺失回退证件姓名），多人用「、」连——与后端回收站列表
 * （orders.service.ts serializeDeletedOrder）同一口径，只是这里没有现成的 passengerNames
 * 字段（那是 DeletedOrderSummary 专属），改用 listOrders 已联查的 passengers[] 自己拼。
 */
function orderPassengerNamesLabel(order: OrderSummary): string {
  return order.passengers.map((p) => p.chineseName?.trim() || p.fullName).join('、');
}

/** 认领候选订单摘要行（搜索结果单条命中，或候选列表里一条）共用的文案。 */
function formatOrderMatchLabel(order: OrderSummary): string {
  const { payable, due } = orderBalanceInfo(order);
  return (
    `${order.orderNumber} · ${order.contactName} · 应收 ¥${payable.toLocaleString()} · ` +
    (due < 0 ? `已多收 ¥${Math.abs(due).toLocaleString()}` : `尾款 ¥${due.toLocaleString()}`)
  );
}

// ── 认领：按订单号 / 乘客姓名搜订单 + 金额（默认 = 剩余） ───────────────────────
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
  // 深链承接：订单详情收款区「去收款对账台核销」跳过来时带 ?order=<订单号>，
  // 这里预填订单搜索框，省得财务再手抄一遍单号（只填不自动提交，认款仍需人工点搜索+确认）。
  const [searchParams] = useSearchParams();
  const [orderNo, setOrderNo] = useState(() => searchParams.get('order')?.trim() ?? '');
  const [matchedOrderId, setMatchedOrderId] = useState<string | null>(null);
  const [matchedLabel, setMatchedLabel] = useState<string | null>(null);
  // 多命中（比如按姓名搜到好几张单）→ 摆出来让人点选，绝不替客户猜是哪一单——这是钱的操作。
  const [candidates, setCandidates] = useState<OrderSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [amount, setAmount] = useState<number | null>(remaining > 0 ? remaining : null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function selectOrder(pick: OrderSummary) {
    setMatchedOrderId(pick.id);
    setMatchedLabel(formatOrderMatchLabel(pick));
    setCandidates([]);
    setErr(null);
  }

  // 按订单号 / 乘客姓名搜出 orderId（认领需要订单内部 id）。
  // 后端 search 本就支持乘客中英文名/护照号/联系人（buildSearchTermClause），
  // 精确单号命中才直接选中；否则一律摆出候选列表让人点，不再悄悄摘 orders[0]——
  // 按姓名搜到同名多单时静默选错单，核销的可是真金白银。
  async function search() {
    const term = orderNo.trim();
    if (!term || searching) return;
    setErr(null);
    setSearching(true);
    setMatchedOrderId(null);
    setMatchedLabel(null);
    setCandidates([]);
    try {
      const r = await api.listOrders(token, { search: term, pageSize: 8 });
      const exact = r.orders.find((o) => o.orderNumber.toLowerCase() === term.toLowerCase());
      if (exact) {
        selectOrder(exact);
        return;
      }
      if (r.orders.length === 0) {
        setErr('没找到匹配的订单，请核对订单号或乘客姓名');
        return;
      }
      if (r.orders.length === 1) {
        selectOrder(r.orders[0]);
        return;
      }
      setCandidates(r.orders);
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
      setErr('核销金额需为正数');
      return;
    }
    if (amt > remaining + 1e-6) {
      setErr(`核销金额不能超过本笔剩余 ¥${remaining.toLocaleString()}`);
      return;
    }
    if (!window.confirm(`确认把 ¥${amt.toLocaleString()} 核销到订单 ${matchedLabel ?? matchedOrderId}？`)) return;
    setErr(null);
    setSubmitting(true);
    try {
      await api.allocateReceipt(token, receiptId, { orderId: matchedOrderId, amountCny: amt });
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '核销失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-ink">核销到订单（本笔剩余 ¥{remaining.toLocaleString()}）</div>
      <p className="text-xs text-ink-muted">
        只能核销到订单尾款为止；核销不完的余额留在池子里继续挂账，可以再核销给别的订单，或退回客户。
        订单页那边直接录收款时则相反：超过尾款的部分会自动拆出来进这个池子。
      </p>
      {err && <div className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-soft">
          订单号 / 乘客姓名
          <div className="mt-1 flex gap-1.5">
            <input
              className="input w-56 py-1.5"
              placeholder="订单号或乘客姓名"
              value={orderNo}
              onChange={(e) => {
                setOrderNo(e.target.value);
                // 改了搜索词，之前选中的/候选的都作废，别让人对着旧结果误点确认核销。
                if (matchedOrderId || candidates.length > 0) {
                  setMatchedOrderId(null);
                  setMatchedLabel(null);
                  setCandidates([]);
                }
              }}
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
          核销金额
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
          {submitting ? '核销中…' : '确认核销'}
        </button>
        <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onCancel}>
          取消
        </button>
      </div>
      {candidates.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-2 py-1 text-xs text-ink-muted">
            找到 {candidates.length} 张匹配订单，请核对后点选：
          </div>
          <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto">
            {candidates.map((o) => {
              const { due } = orderBalanceInfo(o);
              const names = orderPassengerNamesLabel(o);
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left text-xs hover:bg-brand-50"
                    onClick={() => selectOrder(o)}
                  >
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span className="font-mono text-ink">{o.orderNumber}</span>
                      <span className="text-ink-soft">{o.contactName}</span>
                    </span>
                    <span className="text-ink-muted">
                      {names || '（未录乘客）'} ·{' '}
                      {due < 0
                        ? `已多收 ¥${Math.abs(due).toLocaleString()}`
                        : `尾款 ¥${due.toLocaleString()}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
      body: '退款后不可再核销。',
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
          <div>
            <h2 className="text-base font-semibold text-ink">登记新进账</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              把一笔收到但还没归属订单的钱记进挂账池。登记后是「待核销」，带账龄，
              谁有空谁都可以核销到订单或退回客户。
            </p>
          </div>
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
              placeholder="客户自报的订单号，便于核销"
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
