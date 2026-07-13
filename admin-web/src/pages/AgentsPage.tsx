/**
 * 代理管理 — 支持树形/表格切换、多维过滤、佣金设置、创建散客。
 */
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, SETTLEMENT_MODE_LABEL, type AgentListItem, type CreateChildAgentInput, type CustomerSummary, type SettlementMode, type UpdateAgentInput } from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';

const TIER_LABEL = ['', '1级·总代', '2级·区代', '3级·门店', '4级', '5级'];
const TIER_COLOR = ['', 'bg-red-100 text-red-700', 'bg-amber-100 text-amber-700', 'bg-blue-100 text-blue-700', 'bg-slate-100 text-slate-600', 'bg-slate-100 text-slate-600'];

type ViewMode = 'table' | 'tree';
type SortKey = 'tier' | 'balance' | 'orders' | 'children' | 'createdAt';

export function AgentsPage() {
  const tokens = useAuth((s) => s.tokens);
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'STAFF';

  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [parentForAdmin, setParentForAdmin] = useState<string>('');

  // 视图 + 过滤
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [search, setSearch] = useState('');
  const [filterTier, setFilterTier] = useState<'' | '1' | '2' | '3' | '4' | '5'>('');
  const [filterStatus, setFilterStatus] = useState<'' | 'active' | 'inactive'>('');
  const [filterBalance, setFilterBalance] = useState<'' | 'low' | 'mid' | 'high'>('');
  const [sortKey, setSortKey] = useState<SortKey>('tier');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // 选中的代理 (用于详情面板)
  const [selected, setSelected] = useState<AgentListItem | null>(null);

  const reload = useCallback(async () => {
    if (!tokens) return;
    try {
      const res = await api.listAgents(tokens.accessToken);
      setAgents(res.agents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载代理列表失败');
    }
  }, [tokens]);

  useEffect(() => { reload(); }, [reload]);

  // ── 过滤 + 排序 ──
  const filtered = useMemo(() => {
    if (!agents) return [];
    let list = agents.slice();
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        (a.companyName?.toLowerCase().includes(q) ?? false) ||
        a.contactName.toLowerCase().includes(q) ||
        (a.email?.toLowerCase().includes(q) ?? false) ||
        a.contactPhone.includes(q),
      );
    }
    if (filterTier) list = list.filter((a) => a.tier === Number(filterTier));
    if (filterStatus === 'active') list = list.filter((a) => a.isActive);
    if (filterStatus === 'inactive') list = list.filter((a) => !a.isActive);
    if (filterBalance === 'low') list = list.filter((a) => Number(a.prepaymentBalance) < 5000);
    if (filterBalance === 'mid') list = list.filter((a) => Number(a.prepaymentBalance) >= 5000 && Number(a.prepaymentBalance) < 50000);
    if (filterBalance === 'high') list = list.filter((a) => Number(a.prepaymentBalance) >= 50000);

    list.sort((a, b) => {
      const mult = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'tier': return (a.tier - b.tier) * mult;
        case 'balance': return (Number(a.prepaymentBalance) - Number(b.prepaymentBalance)) * mult;
        case 'orders': return (a.orderCount - b.orderCount) * mult;
        case 'children': return (a.childCount - b.childCount) * mult;
        case 'createdAt': return a.createdAt.localeCompare(b.createdAt) * mult;
      }
    });
    return list;
  }, [agents, search, filterTier, filterStatus, filterBalance, sortKey, sortDir]);

  // ── 汇总 KPI ──
  const kpi = useMemo(() => {
    const all = agents ?? [];
    return {
      total: all.length,
      active: all.filter((a) => a.isActive).length,
      totalBalance: all.reduce((s, a) => s + Number(a.prepaymentBalance), 0),
      totalOrders: all.reduce((s, a) => s + a.orderCount, 0),
      byTier: [1, 2, 3, 4, 5].map((t) => all.filter((a) => a.tier === t).length),
    };
  }, [agents]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  if (error) return <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>;
  if (!agents) return <div className="card text-ink-muted">加载中…</div>;

  return (
    <div className="space-y-4">
      {/* 页头 */}
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">代理管理</h1>
          <p className="page-sub">树形 / 表格视图，多维过滤、佣金设置、创建散客。</p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => { setParentForAdmin(''); setShowForm(true); }}
        >
          + 新建代理
        </button>
      </section>

      {/* KPI 顶栏 */}
      <section className="grid gap-3 md:grid-cols-4">
        <KpiCard label="总代理数" value={kpi.total.toString()} sub={`${kpi.active} 在用 / ${kpi.total - kpi.active} 停用`} />
        <KpiCard label="总预付余额" value={`¥${(kpi.totalBalance / 1000).toFixed(1)}K`} sub={`平均 ¥${kpi.total > 0 ? Math.round(kpi.totalBalance / kpi.total).toLocaleString() : 0}`} />
        <KpiCard label="总订单数" value={kpi.totalOrders.toString()} sub="累计所有代理" />
        <KpiCard label="1/2/3 级" value={`${kpi.byTier[0]}/${kpi.byTier[1]}/${kpi.byTier[2]}`} sub="层级分布" />
      </section>

      {/* 过滤器 + 视图切换 */}
      <section className="card">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="label text-xs">搜索</label>
            <input
              className="input"
              placeholder="公司名 / 联系人 / 邮箱 / 电话"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">层级</label>
            <select className="input" value={filterTier} onChange={(e) => setFilterTier(e.target.value as '' | '1' | '2' | '3' | '4' | '5')}>
              <option value="">全部层级</option>
              <option value="1">1级·总代</option>
              <option value="2">2级·区代</option>
              <option value="3">3级·门店</option>
              <option value="4">4级</option>
              <option value="5">5级</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">状态</label>
            <select className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as '' | 'active' | 'inactive')}>
              <option value="">全部</option>
              <option value="active">✅ 在用</option>
              <option value="inactive">⏸ 停用</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">余额档</label>
            <select className="input" value={filterBalance} onChange={(e) => setFilterBalance(e.target.value as '' | 'low' | 'mid' | 'high')}>
              <option value="">全部</option>
              <option value="low">低 &lt;¥5K</option>
              <option value="mid">中 ¥5K-50K</option>
              <option value="high">高 ≥¥50K</option>
            </select>
          </div>
          <div>
            <label className="label text-xs">排序</label>
            <div className="flex gap-1">
              <select className="input" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                <option value="tier">层级</option>
                <option value="balance">余额</option>
                <option value="orders">订单量</option>
                <option value="children">下级数</option>
                <option value="createdAt">注册时间</option>
              </select>
              <button
                type="button"
                className="btn-secondary text-sm px-3"
                onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                title={sortDir === 'asc' ? '升序' : '降序'}
              >
                {sortDir === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
          <div>
            <label className="label text-xs">视图</label>
            <div className="flex rounded-md border border-slate-300 overflow-hidden text-sm">
              <button
                type="button"
                className={`px-3 py-1.5 ${viewMode === 'table' ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                onClick={() => setViewMode('table')}
              >
                表格
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 ${viewMode === 'tree' ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                onClick={() => setViewMode('tree')}
              >
                树形
              </button>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
          <span>显示 {filtered.length} / {agents.length} 个代理</span>
          {(search || filterTier || filterStatus || filterBalance) && (
            <button
              className="text-brand hover:text-brand-dark"
              onClick={() => { setSearch(''); setFilterTier(''); setFilterStatus(''); setFilterBalance(''); }}
            >
              清除过滤
            </button>
          )}
        </div>
      </section>

      {/* 创建代理表单 */}
      {showForm && (
        <CreateAgentForm
          onCancel={() => setShowForm(false)}
          onCreated={async () => { setShowForm(false); await reload(); }}
          agents={agents}
          isAdmin={isAdmin}
          initialParentId={parentForAdmin}
        />
      )}

      {/* 主视图 */}
      {viewMode === 'table' ? (
        <AgentTableView
          agents={filtered}
          onSelectAgent={setSelected}
          onAddChild={(id) => { setParentForAdmin(id); setShowForm(true); }}
          canAddChildOf={(a) => {
            if (isAdmin) return a.tier < 5;
            return a.userId === user?.id && a.tier < 5;
          }}
        />
      ) : (
        <section className="space-y-3">
          {tree.length === 0 ? (
            <div className="card text-slate-500">没有符合条件的代理</div>
          ) : (
            <ul className="space-y-3">
              {tree.map((node) => (
                <AgentTreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  onAddChild={(id) => { setParentForAdmin(id); setShowForm(true); }}
                  onSelectAgent={setSelected}
                  canAddChildOf={(a) => {
                    if (isAdmin) return a.tier < 5;
                    return a.userId === user?.id && a.tier < 5;
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 代理详情抽屉 */}
      {selected && (
        <AgentDetailDrawer
          agent={selected}
          isAdmin={isAdmin}
          onClose={() => setSelected(null)}
          onChanged={async (updated) => {
            setSelected(updated);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 表格视图
// ═══════════════════════════════════════════════════════════════
function AgentTableView({
  agents,
  onSelectAgent,
  onAddChild,
  canAddChildOf,
}: {
  agents: AgentListItem[];
  onSelectAgent: (a: AgentListItem) => void;
  onAddChild: (id: string) => void;
  canAddChildOf: (a: AgentListItem) => boolean;
}) {
  return (
    <section className="card p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th className="text-left">层级</th>
              <th className="text-left">代理</th>
              <th className="text-left">联系方式</th>
              <th className="text-center">下级/订单</th>
              <th className="text-right">预付余额</th>
              <th className="text-center">状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${TIER_COLOR[a.tier]}`}>
                    {TIER_LABEL[a.tier] ?? `${a.tier}级`}
                  </span>
                </td>
                <td>
                  <button className="font-medium text-ink hover:text-brand" onClick={() => onSelectAgent(a)}>
                    {a.companyName || a.contactName}
                  </button>
                  <div className="text-xs text-ink-muted">
                    {a.contactName}
                    {a.parent && <span className="ml-2 text-ink-muted">↑ {a.parent.companyName ?? a.parent.contactName}</span>}
                  </div>
                  <div className="mt-0.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${a.settlementMode === 'MONTHLY' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                      {SETTLEMENT_MODE_LABEL[a.settlementMode]}
                    </span>
                  </div>
                </td>
                <td className="text-xs">
                  <div>{a.contactPhone}</div>
                  <div className="text-ink-muted">{a.email ?? '—'}</div>
                </td>
                <td className="text-center">
                  <div className="text-sm">
                    <span className="font-semibold text-ink">{a.childCount}</span>
                    <span className="text-ink-muted"> / </span>
                    <span className="font-semibold text-ink">{a.orderCount}</span>
                  </div>
                  <div className="text-[10px] text-ink-muted">下级 / 订单</div>
                </td>
                <td className="text-right">
                  <div className={`font-semibold nums ${Number(a.prepaymentBalance) < 1000 ? 'text-rose-600' : 'text-emerald-700'}`}>
                    ¥{Number(a.prepaymentBalance).toLocaleString()}
                  </div>
                </td>
                <td className="text-center">
                  {a.isActive ? (
                    <span className="badge-success">在用</span>
                  ) : (
                    <span className="badge-neutral">停用</span>
                  )}
                </td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-2 text-xs font-medium">
                    <button className="text-brand hover:text-brand-dark" onClick={() => onSelectAgent(a)}>详情</button>
                    {canAddChildOf(a) && (
                      <button className="text-brand hover:text-brand-dark" onClick={() => onAddChild(a.id)}>+ 下级</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-ink-muted">没有符合条件的代理</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
// 代理详情抽屉（点名字展开看）
// ═══════════════════════════════════════════════════════════════
function AgentDetailDrawer({
  agent,
  isAdmin,
  onClose,
  onChanged,
}: {
  agent: AgentListItem;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: (updated: AgentListItem) => void | Promise<void>;
}) {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const [tab, setTab] = useState<'info' | 'commission' | 'balance' | 'customers'>('info');
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  // AGENT 只能编辑自己的信息；ADMIN/STAFF 可编辑任意代理（与后端 updateAgent 权限口径一致）
  const canEditInfo = isAdmin || agent.userId === user?.id;

  const toggleStatus = async () => {
    if (!tokens || statusSaving) return;
    const next = !agent.isActive;
    const label = agent.companyName || agent.contactName;
    const msg = next
      ? `确认启用「${label}」？启用后该代理可重新登录。`
      : `确认停用「${label}」？停用后该代理账号将无法登录（下级代理不受影响，如需一并处理请逐个停用）。`;
    if (!window.confirm(msg)) return;
    setStatusSaving(true);
    setStatusErr(null);
    try {
      const res = await api.setAgentStatus(tokens.accessToken, agent.id, next);
      await onChanged(res.agent);
    } catch (e) {
      setStatusErr(e instanceof ApiError ? e.message : '修改状态失败');
    } finally {
      setStatusSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{agent.companyName || agent.contactName}</h2>
              <div className="mt-1 flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TIER_COLOR[agent.tier]}`}>
                  {TIER_LABEL[agent.tier]}
                </span>
                <span className="text-xs text-slate-500">{agent.contactName} · {agent.contactPhone}</span>
                {!agent.isActive && <span className="badge-neutral">已停用</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <button
                  type="button"
                  className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${
                    agent.isActive
                      ? 'border-rose-200 text-rose-600 hover:bg-rose-50'
                      : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                  }`}
                  disabled={statusSaving}
                  onClick={toggleStatus}
                >
                  {statusSaving ? '处理中…' : agent.isActive ? '停用' : '启用'}
                </button>
              )}
              <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
            </div>
          </div>
          {statusErr && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{statusErr}</div>}
          <nav className="mt-3 flex gap-1 border-b border-slate-200 -mb-4">
            {[
              { k: 'info', label: '基本信息' },
              { k: 'commission', label: '佣金规则' },
              { k: 'balance', label: '余额调整' },
              { k: 'customers', label: '散客管理' },
            ].map((t) => (
              <button
                key={t.k}
                className={`px-3 py-2 text-sm border-b-2 ${tab === t.k ? 'border-brand text-brand font-medium' : 'border-transparent text-slate-600 hover:text-brand'}`}
                onClick={() => setTab(t.k as 'info' | 'commission' | 'balance' | 'customers')}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="px-6 py-5 space-y-4">
          {tab === 'info' && <InfoTab agent={agent} isAdmin={isAdmin} canEdit={canEditInfo} onChanged={onChanged} />}
          {tab === 'commission' && <CommissionTab agent={agent} />}
          {tab === 'balance' && <BalanceTab agent={agent} />}
          {tab === 'customers' && <CustomersTab agent={agent} />}
        </div>
      </div>
    </div>
  );
}

function InfoTab({
  agent,
  isAdmin,
  canEdit,
  onChanged,
}: {
  agent: AgentListItem;
  isAdmin: boolean;
  canEdit: boolean;
  onChanged: (updated: AgentListItem) => void | Promise<void>;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    companyName: agent.companyName ?? '',
    contactName: agent.contactName,
    contactPhone: agent.contactPhone,
    email: agent.email ?? '',
    notes: agent.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startEdit = () => {
    setForm({
      companyName: agent.companyName ?? '',
      contactName: agent.contactName,
      contactPhone: agent.contactPhone,
      email: agent.email ?? '',
      notes: agent.notes ?? '',
    });
    setErr(null);
    setEditing(true);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const body: UpdateAgentInput = {};
      if (form.companyName !== (agent.companyName ?? '')) body.companyName = form.companyName;
      if (form.contactName !== agent.contactName) body.contactName = form.contactName;
      if (form.contactPhone !== agent.contactPhone) body.contactPhone = form.contactPhone;
      if (form.email !== (agent.email ?? '')) body.email = form.email;
      if (form.notes !== (agent.notes ?? '')) body.notes = form.notes;
      if (Object.keys(body).length === 0) {
        setEditing(false);
        return;
      }
      const res = await api.updateAgent(tokens.accessToken, agent.id, body);
      await onChanged(res.agent);
      setEditing(false);
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SettlementModeCard agent={agent} isAdmin={isAdmin} onChanged={onChanged} />

      {canEdit && !editing && (
        <div className="flex justify-end">
          <button type="button" className="text-xs font-medium text-brand hover:text-brand-dark" onClick={startEdit}>
            ✎ 编辑信息
          </button>
        </div>
      )}

      {editing ? (
        <form className="space-y-3 rounded-md border border-brand/30 bg-brand-50/40 p-3" onSubmit={onSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label text-xs">公司名</label>
              <input className="input" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
            </div>
            <div>
              <label className="label text-xs">联系人 *</label>
              <input required className="input" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            </div>
            <div>
              <label className="label text-xs">电话 *</label>
              <input required className="input" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </div>
            <div>
              <label className="label text-xs">邮箱</label>
              <input type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label text-xs">备注</label>
            <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {err && <div className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary text-xs px-3 py-1.5"
              onClick={() => { setEditing(false); setErr(null); }}
            >
              取消
            </button>
            <button type="submit" className="btn-primary text-xs px-3 py-1.5" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      ) : (
        <dl className="space-y-2 text-sm">
          <Row label="公司名" value={agent.companyName ?? '—'} />
          <Row label="联系人" value={agent.contactName} />
          <Row label="电话" value={agent.contactPhone} />
          <Row label="邮箱" value={agent.email ?? '—'} />
          <Row label="层级" value={TIER_LABEL[agent.tier]} />
          <Row label="预存余额" value={<span className="font-semibold text-emerald-700">¥{Number(agent.prepaymentBalance).toLocaleString()}</span>} />
          <Row label="上级" value={agent.parent ? (agent.parent.companyName ?? agent.parent.contactName) : '无（顶级）'} />
          <Row label="下级数" value={agent.childCount.toString()} />
          <Row label="订单数" value={agent.orderCount.toString()} />
          <Row label="状态" value={agent.isActive ? '✅ 在用' : '⏸ 停用'} />
          <Row label="注册时间" value={new Date(agent.createdAt).toLocaleString('zh-CN')} />
          <Row label="上次登录" value={agent.lastLoginAt ? new Date(agent.lastLoginAt).toLocaleString('zh-CN') : '从未登录'} />
          {agent.notes && <Row label="备注" value={agent.notes} />}
        </dl>
      )}
    </div>
  );
}

// 结算方式卡片：展示 逐单到账 / 月结；ADMIN 可切换（调 setAgentSettlementMode）。
function SettlementModeCard({
  agent,
  isAdmin,
  onChanged,
}: {
  agent: AgentListItem;
  isAdmin: boolean;
  onChanged: (updated: AgentListItem) => void | Promise<void>;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isMonthly = agent.settlementMode === 'MONTHLY';

  const change = async (next: SettlementMode) => {
    if (!tokens || next === agent.settlementMode || saving) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await api.setAgentSettlementMode(tokens.accessToken, agent.id, next);
      await onChanged(res.agent);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '修改结算方式失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`rounded-md border p-3 ${isMonthly ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">结算方式</div>
          <div className={`mt-0.5 text-sm font-semibold ${isMonthly ? 'text-blue-700' : 'text-slate-700'}`}>
            {isMonthly ? '🗓 月结' : '💳 逐单到账'}
          </div>
        </div>
        {isAdmin ? (
          <select
            className="input text-sm w-32"
            value={agent.settlementMode}
            disabled={saving}
            onChange={(e) => change(e.target.value as SettlementMode)}
          >
            <option value="PER_ORDER">{SETTLEMENT_MODE_LABEL.PER_ORDER}</option>
            <option value="MONTHLY">{SETTLEMENT_MODE_LABEL.MONTHLY}</option>
          </select>
        ) : (
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${isMonthly ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-600'}`}>
            {SETTLEMENT_MODE_LABEL[agent.settlementMode]}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">
        {isMonthly ? '订单尾款挂账，月末统一对账，不逐单催款。' : '每笔订单单独收尾款。'}
      </p>
      {err && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{err}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 佣金规则
// ───────────────────────────────────────────────────────────────
// 后端 CommissionRule 模型（按 agentId + productKind 存费率）已存在并驱动实际结算，
// 但目前没有管理端 API 读取/编辑它。此 tab 在该 API 上线前只做诚实占位，
// 不展示编造的费率表或下级列表。
// ═══════════════════════════════════════════════════════════════

function CommissionTab({ agent }: { agent: AgentListItem }) {
  const parentLabel = agent.tier === 1 ? '平台（世途旅行）' : `${agent.tier - 1} 级代理`;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
        佣金规则查看/编辑暂未开通此管理端入口。本级佣金率由「{parentLabel}」在系统中配置并用于实际结算，
        如需调整请走线下流程，待 GET/PATCH /agents/:id/commission-rules 接口上线后在此处提供。
      </div>
      <div className="rounded-md bg-slate-50 border border-slate-200 p-3 text-xs text-slate-500">
        下级数：{agent.childCount}（下级各自的佣金规则同样暂无管理端入口，此处不展示）
      </div>
    </div>
  );
}

function BalanceTab({ agent }: { agent: AgentListItem }) {
  const current = Number(agent.prepaymentBalance);

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-slate-50 p-4">
        <div className="text-xs text-slate-500">当前预付余额</div>
        <div className={`text-3xl font-bold mt-1 ${current < 1000 ? 'text-red-600' : 'text-green-700'}`}>
          ¥{current.toLocaleString()}
        </div>
      </div>

      <div className="rounded-md border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm text-ink-soft">
        认款审核（确认到账 / 驳回）与线下对账手动调整已迁移到「余额与认款」页，避免功能重复。
      </div>
      <Link to="/agent-balance" className="btn-primary inline-flex text-sm">
        前往「余额与认款」
      </Link>
    </div>
  );
}

function CustomersTab({ agent }: { agent: AgentListItem }) {
  const tokens = useAuth((s) => s.tokens);
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tokens) return;
    let cancelled = false;
    setCustomers(null);
    setError(null);
    api.listCustomers(tokens.accessToken, { agentId: agent.id })
      .then((res) => { if (!cancelled) setCustomers(res.customers); })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : '加载散客列表失败'); });
    return () => { cancelled = true; };
  }, [tokens, agent.id]);

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
        💡 <strong>散客账号</strong>下单后可归属到此代理，散客购买时佣金归属此代理
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
        由代理直接创建散客账号暂未开通；散客需先在前台自行注册，再由客服在「散客管理」页设置归属代理。
      </div>

      <div>
        <h3 className="text-sm font-medium text-slate-700">
          已归属散客{customers ? ` (${customers.length})` : ''}
        </h3>
        {error && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">{error}</div>}
        {!error && customers === null && <div className="mt-2 text-xs text-slate-500">加载中…</div>}
        {customers && customers.length === 0 && (
          <div className="mt-2 text-xs text-slate-500">暂无归属此代理的散客</div>
        )}
        {customers && customers.length > 0 && (
          <ul className="mt-2 space-y-2">
            {customers.map((c) => (
              <li key={c.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-slate-900">{c.displayName ?? '（未命名）'}</div>
                    <div className="text-xs text-slate-500">{c.phone ?? c.email ?? '—'}</div>
                  </div>
                  <div className="text-right text-xs">
                    <div>{c.totalOrders} 笔订单</div>
                    <div className="text-slate-500">累计 ¥{c.totalSpent.toLocaleString()}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-slate-100">
      <dt className="text-slate-500 text-xs">{label}</dt>
      <dd className="text-right text-slate-900">{value}</dd>
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 树形视图节点
// ═══════════════════════════════════════════════════════════════
interface AgentNodeData extends AgentListItem {
  children: AgentNodeData[];
}

function buildTree(flat: AgentListItem[]): AgentNodeData[] {
  const byId = new Map<string, AgentNodeData>();
  flat.forEach((a) => byId.set(a.id, { ...a, children: [] }));
  const roots: AgentNodeData[] = [];
  byId.forEach((node) => {
    if (node.parentAgentId && byId.has(node.parentAgentId)) {
      byId.get(node.parentAgentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function AgentTreeNode({
  node, depth, onAddChild, onSelectAgent, canAddChildOf,
}: {
  node: AgentNodeData; depth: number;
  onAddChild: (parentId: string) => void;
  onSelectAgent: (a: AgentListItem) => void;
  canAddChildOf: (a: AgentListItem) => boolean;
}) {
  return (
    <li>
      <div className="card flex flex-wrap items-start justify-between gap-3" style={{ marginLeft: depth * 24 }}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${TIER_COLOR[node.tier]}`}>
              {TIER_LABEL[node.tier]}
            </span>
            <h3 className="text-lg font-semibold text-ink">
              {node.companyName || node.contactName}
            </h3>
            {!node.isActive && <span className="badge-neutral">已停用</span>}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            <span className="mr-3">👤 {node.contactName}</span>
            <span className="mr-3">📞 {node.contactPhone}</span>
            <span>📧 {node.email ?? '—'}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            下级 <strong className="text-indigo-600">{node.childCount}</strong> · 订单 <strong className="text-amber-600">{node.orderCount}</strong> · 余额 <strong className={Number(node.prepaymentBalance) < 1000 ? 'text-red-600' : 'text-green-700'}>¥{Number(node.prepaymentBalance).toLocaleString()}</strong>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => onSelectAgent(node)}>详情</button>
          {canAddChildOf(node) && (
            <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => onAddChild(node.id)}>+ 添加下级</button>
          )}
        </div>
      </div>
      {node.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {node.children.map((c) => (
            <AgentTreeNode key={c.id} node={c} depth={depth + 1} onAddChild={onAddChild} onSelectAgent={onSelectAgent} canAddChildOf={canAddChildOf} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ═══════════════════════════════════════════════════════════════
// 创建代理表单
// ═══════════════════════════════════════════════════════════════
function CreateAgentForm({
  onCancel, onCreated, agents, isAdmin, initialParentId,
}: {
  onCancel: () => void; onCreated: () => void;
  agents: AgentListItem[]; isAdmin: boolean; initialParentId?: string;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [parentId, setParentId] = useState(initialParentId ?? '');
  const [form, setForm] = useState<Omit<CreateChildAgentInput, 'prepaymentBalance'>>({
    email: '', password: '', displayName: '', contactName: '', contactPhone: '',
    companyName: '', notes: '',
  });
  const [prepaymentBalance, setPrepaymentBalance] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parentOptions = useMemo(() => agents.filter((a) => a.isActive && a.tier < 5), [agents]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tokens) return;
    setSubmitting(true); setErr(null);
    try {
      await api.createChildAgent(
        tokens.accessToken,
        { ...form, prepaymentBalance: prepaymentBalance ?? 0 },
        parentId || undefined,
      );
      onCreated();
    } catch (error) {
      setErr(error instanceof ApiError ? error.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card border-brand/30">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">新建代理</h2>
        <button type="button" className="text-sm text-slate-500 hover:text-slate-700" onClick={onCancel}>取消</button>
      </div>
      <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={onSubmit}>
        {isAdmin && (
          <div className="md:col-span-2">
            <label className="label">上级代理</label>
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">（不选 = 创建 1 级代理）</option>
              {parentOptions.map((a) => (
                <option key={a.id} value={a.id}>[{a.tier}级] {a.companyName || a.contactName} — {a.email}</option>
              ))}
            </select>
          </div>
        )}
        <div><label className="label">登录邮箱 *</label><input type="email" required className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label">初始密码 *（≥8位）</label><input type="text" required minLength={8} className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        <div><label className="label">显示昵称 *</label><input required className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
        <div><label className="label">公司名</label><input className="input" value={form.companyName ?? ''} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></div>
        <div><label className="label">联系人 *</label><input required className="input" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></div>
        <div><label className="label">联系电话 *</label><input required className="input" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></div>
        <div><label className="label">初始预付余额（¥）</label><NumberInput min={0} className="input" value={prepaymentBalance} onChange={(n) => setPrepaymentBalance(n)} /></div>
        <div><label className="label">备注</label><input className="input" value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        {err && <div className="md:col-span-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="md:col-span-2 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary" disabled={submitting}>{submitting ? '创建中…' : '创建代理'}</button>
        </div>
      </form>
    </section>
  );
}

