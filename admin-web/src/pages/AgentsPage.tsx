/**
 * 代理管理 — 支持树形/表格切换、多维过滤、佣金设置、创建散客。
 */
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AgentListItem, type CreateChildAgentInput } from '../lib/api';
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
  const [showCustomerForm, setShowCustomerForm] = useState<AgentListItem | null>(null);

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

      {/* 创建散客表单 */}
      {showCustomerForm && (
        <CreateCustomerForm
          agent={showCustomerForm}
          onCancel={() => setShowCustomerForm(null)}
          onCreated={() => setShowCustomerForm(null)}
        />
      )}

      {/* 主视图 */}
      {viewMode === 'table' ? (
        <AgentTableView
          agents={filtered}
          onSelectAgent={setSelected}
          onAddChild={(id) => { setParentForAdmin(id); setShowForm(true); }}
          onCreateCustomer={(a) => setShowCustomerForm(a)}
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
                  onCreateCustomer={(a) => setShowCustomerForm(a)}
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
      {selected && <AgentDetailDrawer agent={selected} onClose={() => setSelected(null)} />}
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
  onCreateCustomer,
  canAddChildOf,
}: {
  agents: AgentListItem[];
  onSelectAgent: (a: AgentListItem) => void;
  onAddChild: (id: string) => void;
  onCreateCustomer: (a: AgentListItem) => void;
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
                    <button className="text-brand hover:text-brand-dark" onClick={() => onCreateCustomer(a)}>+ 散客</button>
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
function AgentDetailDrawer({ agent, onClose }: { agent: AgentListItem; onClose: () => void }) {
  const [tab, setTab] = useState<'info' | 'commission' | 'balance' | 'customers'>('info');

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
              </div>
            </div>
            <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
          </div>
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
          {tab === 'info' && <InfoTab agent={agent} />}
          {tab === 'commission' && <CommissionTab agent={agent} />}
          {tab === 'balance' && <BalanceTab agent={agent} />}
          {tab === 'customers' && <CustomersTab agent={agent} />}
        </div>
      </div>
    </div>
  );
}

function InfoTab({ agent }: { agent: AgentListItem }) {
  return (
    <dl className="space-y-2 text-sm">
      <Row label="公司名" value={agent.companyName ?? '—'} />
      <Row label="联系人" value={agent.contactName} />
      <Row label="电话" value={agent.contactPhone} />
      <Row label="邮箱" value={agent.email ?? '—'} />
      <Row label="层级" value={TIER_LABEL[agent.tier]} />
      <Row label="上级" value={agent.parent ? (agent.parent.companyName ?? agent.parent.contactName) : '无（顶级）'} />
      <Row label="下级数" value={agent.childCount.toString()} />
      <Row label="订单数" value={agent.orderCount.toString()} />
      <Row label="状态" value={agent.isActive ? '✅ 在用' : '⏸ 停用'} />
      <Row label="注册时间" value={new Date(agent.createdAt).toLocaleString('zh-CN')} />
      <Row label="上次登录" value={agent.lastLoginAt ? new Date(agent.lastLoginAt).toLocaleString('zh-CN') : '从未登录'} />
      {agent.notes && <Row label="备注" value={agent.notes} />}
    </dl>
  );
}

// ═══════════════════════════════════════════════════════════════
// 佣金模型（嵌套切分）
// ───────────────────────────────────────────────────────────────
// Admin 给 1 级代理设佣金率（如机票 10%，即每订单抽 10% 给 1 级）
// 1 级再从这 10% 里切部分给 2 级（如 40% of 10% = 4%）
// 2 级再切部分给 3 级（如 30% of 4% = 1.2%）
// 规则：每级的「本级实际佣金率」= 从上级继承的率 × (1 - 给下级分成比例)
//      下级只能从父级分下来的池子里再切，不能超过父级
// ═══════════════════════════════════════════════════════════════

type ProductKey = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'BUNDLE';
type RateMap = Record<ProductKey, number>;

// 父级给本级的率（按 tier 和产品类型）— Demo 用本地 mock，真实接 API
const PARENT_RATES: Record<number, RateMap> = {
  1: { FLIGHT: 10, HOTEL: 8, TRANSFER: 15, VISA: 12, BUNDLE: 10 }, // admin → 1级
  2: { FLIGHT: 4, HOTEL: 3.2, TRANSFER: 6, VISA: 4.8, BUNDLE: 4 }, // 1级 → 2级
  3: { FLIGHT: 1.2, HOTEL: 0.96, TRANSFER: 1.8, VISA: 1.44, BUNDLE: 1.2 }, // 2级 → 3级
  4: { FLIGHT: 0, HOTEL: 0, TRANSFER: 0, VISA: 0, BUNDLE: 0 },
  5: { FLIGHT: 0, HOTEL: 0, TRANSFER: 0, VISA: 0, BUNDLE: 0 },
};

const PRODUCT_LABEL: Record<ProductKey, string> = {
  FLIGHT: '✈️ 机票', HOTEL: '🏨 酒店', TRANSFER: '🚐 地面服务', VISA: '🛂 签证', BUNDLE: '🎁 套餐',
};

function CommissionTab({ agent }: { agent: AgentListItem }) {
  // 本级从父级继承的最高率（上限）
  const parentRate = PARENT_RATES[agent.tier] ?? PARENT_RATES[1];
  const parentLabel = agent.tier === 1 ? '平台（世途旅行）' : `${agent.tier - 1} 级代理`;

  // 从 API 拉本代理的所有下级 — demo 用 mock 子代理（真实环境 api.listAgents 过滤 parentAgentId）
  const mockChildren = agent.childCount > 0
    ? [
        { id: 'child1', name: agent.tier === 1 ? '澳门欢乐旅行社' : '下级代理 A', orderCount: 24 },
        { id: 'child2', name: agent.tier === 1 ? '港澳威尼斯门店' : '下级代理 B', orderCount: 12 },
      ].slice(0, agent.childCount)
    : [];

  // 每个下级每个产品的分成率（%，相对于父级拿到的）
  const [childRates, setChildRates] = useState<Record<string, { FLIGHT: number; HOTEL: number; TRANSFER: number; VISA: number; BUNDLE: number }>>(() => {
    const init: Record<string, { FLIGHT: number; HOTEL: number; TRANSFER: number; VISA: number; BUNDLE: number }> = {};
    mockChildren.forEach((c, i) => {
      // 不同下级默认不同 rate — 演示"可以给每个下级不同费率"
      init[c.id] = i === 0
        ? { FLIGHT: 40, HOTEL: 40, TRANSFER: 30, VISA: 40, BUNDLE: 40 }
        : { FLIGHT: 35, HOTEL: 35, TRANSFER: 25, VISA: 35, BUNDLE: 35 };
    });
    return init;
  });
  const [saved, setSaved] = useState(false);

  const isLeaf = agent.tier >= 5 || mockChildren.length === 0;

  const updateChildRate = (childId: string, product: keyof typeof parentRate, value: number) => {
    setChildRates((prev) => ({
      ...prev,
      [childId]: { ...prev[childId], [product]: value },
    }));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-800 space-y-1">
        <div>💡 <strong>嵌套佣金 · 每个下级独立 rate</strong></div>
        <div>1. <strong>{parentLabel}</strong> 给本级定佣金率（上限）</div>
        <div>2. 本级可以给<strong className="text-amber-700">每个下级</strong>定不同的分成 %</div>
        <div>3. 下级率 = 本级率 × 分成% · <strong className="text-red-600">不能超过本级</strong></div>
      </div>

      {/* 父级给本级的率（只读） */}
      <div>
        <h3 className="text-sm font-medium text-slate-700 mb-2">
          本级继承自「{parentLabel}」的佣金率（上限）
        </h3>
        <div className="rounded-md bg-slate-50 p-3 grid grid-cols-5 gap-2 text-xs">
          {(Object.entries(parentRate) as [string, number][]).map(([k, v]) => (
            <div key={k} className="text-center">
              <div className="text-slate-500">{PRODUCT_LABEL[k as keyof typeof PRODUCT_LABEL]}</div>
              <div className="mt-0.5 font-semibold text-indigo-700">{v.toFixed(2)}%</div>
            </div>
          ))}
        </div>
      </div>

      {/* 每个下级的分成率 */}
      {!isLeaf ? (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-slate-700">
            给 {agent.tier + 1} 级下级的分成率（{mockChildren.length} 个下级）
          </h3>
          {mockChildren.map((child) => {
            const rates = childRates[child.id];
            if (!rates) return null;
            return (
              <div key={child.id} className="rounded-md border-2 border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="font-semibold text-slate-900">🤝 {child.name}</span>
                    <span className="ml-2 text-xs text-slate-500">{child.orderCount} 单</span>
                  </div>
                  <span className="text-xs text-amber-700">独立费率配置</span>
                </div>
                <div className="space-y-1.5">
                  {(Object.entries(rates) as [keyof typeof parentRate, number][]).map(([k, v]) => {
                    const parentOfThis = parentRate[k] ?? 0;
                    const childActual = parentOfThis * v / 100;
                    const selfKeep = parentOfThis - childActual;
                    return (
                      <div key={k} className="grid grid-cols-[4rem_1fr_5rem] items-center gap-3 text-xs">
                        <span className="text-slate-600">{PRODUCT_LABEL[k]}</span>
                        <div>
                          <input
                            type="range" min={0} max={100} step={5}
                            value={v}
                            onChange={(e) => updateChildRate(child.id, k, Number(e.target.value))}
                            className="w-full"
                          />
                          <div className="text-[10px] text-slate-500">
                            本级 {parentOfThis.toFixed(2)}% · 下级得 <strong className="text-amber-700">{childActual.toFixed(2)}%</strong> · 自留 <strong className="text-green-700">{selfKeep.toFixed(2)}%</strong>
                          </div>
                        </div>
                        <span className="text-right font-semibold text-amber-700 tabular-nums">{v}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md bg-slate-50 border border-slate-200 p-3 text-xs text-slate-500">
          {agent.tier >= 5 ? '本级为末级代理' : '该代理暂无下级'}，全部佣金归本级
        </div>
      )}

      {/* 级联示例（机票） */}
      <div className="rounded-md bg-slate-50 p-3 space-y-1.5 text-xs">
        <div className="font-semibold text-slate-700 mb-1">💰 示例：机票 ¥1,000 订单的佣金分配</div>
        {(() => {
          const order = 1000;
          const flightPoolPct = 10;
          const pool = order * flightPoolPct / 100;
          return (
            <div className="space-y-0.5 font-mono text-slate-600">
              <div>订单 ¥{order} → 佣金池 <strong className="text-brand">¥{pool}</strong>（{flightPoolPct}%）</div>
              {mockChildren.length > 0 && childRates[mockChildren[0].id] && (
                <>
                  <div className="ml-4">├ 本级（{agent.companyName || TIER_LABEL[agent.tier]}）留</div>
                  <div className="ml-8 text-green-700">
                    ¥{(pool * (100 - childRates[mockChildren[0].id].FLIGHT) / 100).toFixed(2)}（{(flightPoolPct * (100 - childRates[mockChildren[0].id].FLIGHT) / 100).toFixed(1)}%）
                  </div>
                  <div className="ml-4">└ 下级 {mockChildren[0].name} 得</div>
                  <div className="ml-8 text-amber-700">
                    ¥{(pool * childRates[mockChildren[0].id].FLIGHT / 100).toFixed(2)}（{(flightPoolPct * childRates[mockChildren[0].id].FLIGHT / 100).toFixed(1)}%）
                  </div>
                </>
              )}
            </div>
          );
        })()}
      </div>

      {saved ? (
        <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">✅ 已保存每个下级的分成规则（demo）</div>
      ) : (
        <button className="btn-primary w-full" onClick={() => { setSaved(true); setTimeout(() => setSaved(false), 2000); }}>
          保存 {mockChildren.length} 个下级的分成规则
        </button>
      )}
    </div>
  );
}

function BalanceTab({ agent }: { agent: AgentListItem }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [action, setAction] = useState<'TOP_UP' | 'DEDUCT'>('TOP_UP');
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const current = Number(agent.prepaymentBalance);
  const amt = amount ?? 0;
  const newBalance = current + (action === 'TOP_UP' ? Math.abs(amt) : -Math.abs(amt));

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-slate-50 p-4">
        <div className="text-xs text-slate-500">当前预付余额</div>
        <div className={`text-3xl font-bold mt-1 ${current < 1000 ? 'text-red-600' : 'text-green-700'}`}>
          ¥{current.toLocaleString()}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className={`rounded-md border-2 p-3 text-center ${action === 'TOP_UP' ? 'border-green-500 bg-green-50' : 'border-slate-200'}`}
          onClick={() => setAction('TOP_UP')}
        >
          <div className="text-2xl">💰</div>
          <div className="mt-1 text-sm font-medium">充值 (+)</div>
        </button>
        <button
          className={`rounded-md border-2 p-3 text-center ${action === 'DEDUCT' ? 'border-red-500 bg-red-50' : 'border-slate-200'}`}
          onClick={() => setAction('DEDUCT')}
        >
          <div className="text-2xl">💸</div>
          <div className="mt-1 text-sm font-medium">扣款 (−)</div>
        </button>
      </div>

      <div>
        <label className="label text-xs">金额 (¥)</label>
        <NumberInput min={0} step={0.01} className="input" value={amount} onChange={(n) => setAmount(n)} />
      </div>
      <div>
        <label className="label text-xs">备注（可选）</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：月度对账充值 / 退款" />
      </div>

      {amt > 0 && (
        <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-600">调整后余额</span>
            <span className={`font-bold ${newBalance < 0 ? 'text-red-600' : 'text-green-700'}`}>¥{newBalance.toLocaleString()}</span>
          </div>
          {newBalance < 0 && <div className="mt-1 text-xs text-red-600">⚠ 扣款后余额为负，确认无误？</div>}
        </div>
      )}

      {saved ? (
        <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">✅ 余额已调整（demo）</div>
      ) : (
        <button className="btn-primary w-full" disabled={amt <= 0} onClick={() => { setSaved(true); setTimeout(() => setSaved(false), 2000); }}>
          确认{action === 'TOP_UP' ? '充值' : '扣款'} ¥{Math.abs(amt).toFixed(2)}
        </button>
      )}
    </div>
  );
}

function CustomersTab({ agent }: { agent: AgentListItem }) {
  const [showForm, setShowForm] = useState(false);
  // Mock 散客数据
  const mockCustomers = [
    { id: 'c1', name: '陈小姐', phone: '+853 6211 ****', orders: 3, totalSpent: 18560 },
    { id: 'c2', name: '王先生', phone: '+853 6588 ****', orders: 1, totalSpent: 5280 },
    { id: 'c3', name: '黄太太', phone: '+852 9123 ****', orders: 5, totalSpent: 42100 },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
        💡 <strong>散客账号</strong>由此代理创建，散客购买时佣金自动归属此代理
      </div>

      <button className="btn-primary w-full text-sm" onClick={() => setShowForm(true)}>
        + 为 {agent.companyName ?? agent.contactName} 创建散客
      </button>

      <div>
        <h3 className="text-sm font-medium text-slate-700">已有散客 ({mockCustomers.length})</h3>
        <ul className="mt-2 space-y-2">
          {mockCustomers.map((c) => (
            <li key={c.id} className="rounded-md border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-slate-900">{c.name}</div>
                  <div className="text-xs text-slate-500">{c.phone}</div>
                </div>
                <div className="text-right text-xs">
                  <div>{c.orders} 笔订单</div>
                  <div className="text-slate-500">累计 ¥{c.totalSpent.toLocaleString()}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {showForm && (
        <div className="rounded-md border border-brand/30 bg-white p-3 space-y-2">
          <h4 className="text-sm font-medium">创建新散客</h4>
          <input className="input text-sm" placeholder="姓名" />
          <input className="input text-sm" placeholder="手机号（选填）" />
          <input className="input text-sm" placeholder="邮箱（选填）" />
          <div className="flex gap-2">
            <button className="btn-secondary text-sm flex-1" onClick={() => setShowForm(false)}>取消</button>
            <button className="btn-primary text-sm flex-1" onClick={() => { alert('散客已创建（demo）'); setShowForm(false); }}>创建</button>
          </div>
        </div>
      )}
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
  node, depth, onAddChild, onCreateCustomer, canAddChildOf,
}: {
  node: AgentNodeData; depth: number;
  onAddChild: (parentId: string) => void;
  onCreateCustomer: (a: AgentListItem) => void;
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
          {canAddChildOf(node) && (
            <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => onAddChild(node.id)}>+ 添加下级</button>
          )}
          <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => onCreateCustomer(node)}>+ 创建散客</button>
        </div>
      </div>
      {node.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {node.children.map((c) => (
            <AgentTreeNode key={c.id} node={c} depth={depth + 1} onAddChild={onAddChild} onCreateCustomer={onCreateCustomer} canAddChildOf={canAddChildOf} />
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

// ═══════════════════════════════════════════════════════════════
// 创建散客表单
// ═══════════════════════════════════════════════════════════════
function CreateCustomerForm({ agent, onCancel, onCreated }: { agent: AgentListItem; onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [saved, setSaved] = useState(false);

  return (
    <section className="card border-brand/30">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">为 {agent.companyName ?? agent.contactName} 创建散客</h2>
        <button type="button" className="text-sm text-slate-500 hover:text-slate-700" onClick={onCancel}>取消</button>
      </div>
      <p className="mt-1 text-xs text-slate-500">散客下单时佣金自动归属此代理</p>

      <form
        className="mt-4 grid gap-3 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(true);
          setTimeout(() => { setSaved(false); onCreated(); }, 1500);
        }}
      >
        <div><label className="label">散客姓名 *</label><input required className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label">手机号</label><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div><label className="label">邮箱</label><input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></div>

        {saved && (
          <div className="md:col-span-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
            ✅ 散客 <strong>{name}</strong> 已创建（demo）· 其订单佣金将归属 {agent.companyName ?? agent.contactName}
          </div>
        )}

        <div className="md:col-span-3 flex justify-end gap-3">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary">创建散客</button>
        </div>
      </form>
    </section>
  );
}
