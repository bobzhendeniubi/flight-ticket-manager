/**
 * 散客管理 — 所有下单的散客（含直销 + 代理归属）
 */
import { useMemo, useState } from 'react';
import { MOCK_CUSTOMERS, type MockCustomer } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

export function CustomersPage() {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [selected, setSelected] = useState<MockCustomer | null>(null);

  const agentNames = useMemo(() => {
    const set = new Set<string>();
    MOCK_CUSTOMERS.forEach((c) => { if (c.agentName) set.add(c.agentName); });
    return Array.from(set).sort();
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    MOCK_CUSTOMERS.forEach((c) => c.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, []);

  const filtered = useMemo(() => {
    return MOCK_CUSTOMERS.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.phone.includes(q) && !(c.email?.toLowerCase().includes(q) ?? false)) return false;
      }
      if (agentFilter === 'direct' && c.agentName) return false;
      if (agentFilter === 'agent' && !c.agentName) return false;
      if (agentFilter !== '' && agentFilter !== 'direct' && agentFilter !== 'agent' && c.agentName !== agentFilter) return false;
      if (tagFilter && !c.tags.includes(tagFilter)) return false;
      return true;
    });
  }, [search, agentFilter, tagFilter]);

  const kpi = useMemo(() => ({
    total: MOCK_CUSTOMERS.length,
    direct: MOCK_CUSTOMERS.filter((c) => !c.agentName).length,
    viaAgent: MOCK_CUSTOMERS.filter((c) => c.agentName).length,
    totalSpent: MOCK_CUSTOMERS.reduce((s, c) => s + c.totalSpent, 0),
    vip: MOCK_CUSTOMERS.filter((c) => c.tags.includes('VIP')).length,
  }), []);

  const handleExport = () => {
    exportToCSV('散客名单', filtered, [
      { key: 'name', label: '姓名' },
      { key: 'phone', label: '手机' },
      { key: 'email', label: '邮箱', format: (v) => String(v ?? '') },
      { key: 'idNumber', label: '证件号', format: (v) => String(v ?? '') },
      { key: 'agentName', label: '归属代理', format: (v) => String(v ?? '直销') },
      { key: 'totalOrders', label: '订单数' },
      { key: 'totalSpent', label: '累计消费', format: (v) => `¥${Number(v).toLocaleString()}` },
      { key: 'lastOrderAt', label: '最后下单', format: (v) => v ? new Date(String(v)).toLocaleDateString('zh-CN') : '—' },
      { key: 'tags', label: '标签', format: (v) => (v as string[]).join('·') },
      { key: 'createdAt', label: '注册时间', format: (v) => new Date(String(v)).toLocaleDateString('zh-CN') },
    ]);
  };

  return (
    <div className="space-y-4">
      {/* KPI */}
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="总散客数" value={kpi.total.toString()} sub={`${kpi.vip} VIP`} color="bg-brand" />
        <Kpi label="直销散客" value={kpi.direct.toString()} sub="无代理归属" color="bg-indigo-500" />
        <Kpi label="代理散客" value={kpi.viaAgent.toString()} sub="代理创建/归属" color="bg-amber-500" />
        <Kpi label="累计消费" value={`¥${(kpi.totalSpent / 1000).toFixed(1)}K`} sub="所有散客" color="bg-green-600" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">导出</p>
          <button className="btn-primary text-sm mt-2" onClick={handleExport}>📥 导出 CSV</button>
        </div>
      </section>

      <section>
        <h1 className="text-2xl font-bold text-slate-900">散客管理</h1>
        <p className="mt-1 text-sm text-slate-600">所有购买过产品的散客，按归属代理、标签等维度筛选</p>
      </section>

      {/* 过滤器 */}
      <section className="card">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="label text-xs">搜索</label>
            <input className="input" placeholder="姓名 / 电话 / 邮箱" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">归属</label>
            <select className="input" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
              <option value="">全部</option>
              <option value="direct">🏢 直销散客</option>
              <option value="agent">🤝 代理散客</option>
              <optgroup label="按代理">
                {agentNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </optgroup>
            </select>
          </div>
          <div>
            <label className="label text-xs">标签</label>
            <select className="input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="">全部标签</option>
              {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="flex items-end text-sm text-slate-500">
            显示 {filtered.length} / {MOCK_CUSTOMERS.length}
          </div>
        </div>
      </section>

      {/* 表格 */}
      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">散客</th>
                <th className="px-4 py-3 text-left">联系方式</th>
                <th className="px-4 py-3 text-left">归属</th>
                <th className="px-4 py-3 text-center">订单/消费</th>
                <th className="px-4 py-3 text-left">最后下单</th>
                <th className="px-4 py-3 text-left">标签</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <button className="font-medium text-slate-900 hover:text-brand" onClick={() => setSelected(c)}>{c.name}</button>
                    {c.idNumber && <div className="text-xs text-slate-400">{c.idNumber}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div>{c.phone}</div>
                    <div className="text-slate-400">{c.email ?? '—'}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {c.agentName ? (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-700">🤝 {c.agentName}</span>
                    ) : (
                      <span className="rounded bg-indigo-100 px-2 py-0.5 text-indigo-700">🏢 直销</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="font-semibold text-amber-600">{c.totalOrders}</div>
                    <div className="text-xs text-slate-500">¥{c.totalSpent.toLocaleString()}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString('zh-CN') : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <span key={t} className={`rounded px-1.5 py-0.5 text-[10px] ${
                          t === 'VIP' ? 'bg-red-100 text-red-700' :
                          t === '回头客' ? 'bg-green-100 text-green-700' :
                          t === '新客' ? 'bg-blue-100 text-blue-700' :
                          t === '蜜月' ? 'bg-pink-100 text-pink-700' :
                          'bg-slate-100 text-slate-600'
                        }`}>{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button className="text-xs text-brand hover:text-brand-dark" onClick={() => setSelected(c)}>详情</button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">没有符合条件的散客</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && <CustomerDrawer customer={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <span className={`h-8 w-1 rounded ${color}`}></span>
        <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
      </div>
      <p className="mt-1.5 text-2xl font-bold text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function CustomerDrawer({ customer, onClose }: { customer: MockCustomer; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">{customer.name}</h2>
            <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {customer.tags.map((t) => (
              <span key={t} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{t}</span>
            ))}
          </div>
        </div>
        <div className="px-6 py-5 space-y-4 text-sm">
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">联系方式</h3>
            <dl className="space-y-1">
              <Row label="姓名" value={customer.name} />
              <Row label="手机" value={customer.phone} />
              <Row label="邮箱" value={customer.email ?? '—'} />
              <Row label="证件号" value={customer.idNumber ?? '—'} />
            </dl>
          </section>
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">归属</h3>
            <dl className="space-y-1">
              <Row label="销售渠道" value={customer.agentName ? `🤝 ${customer.agentName}` : '🏢 直销'} />
              <Row label="注册时间" value={new Date(customer.createdAt).toLocaleString('zh-CN')} />
            </dl>
          </section>
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">消费统计</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded bg-slate-50 p-3 text-center">
                <div className="text-xs text-slate-500">总订单</div>
                <div className="text-2xl font-bold text-amber-600">{customer.totalOrders}</div>
              </div>
              <div className="rounded bg-slate-50 p-3 text-center">
                <div className="text-xs text-slate-500">累计消费</div>
                <div className="text-2xl font-bold text-green-600">¥{customer.totalSpent.toLocaleString()}</div>
              </div>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              最近下单: {customer.lastOrderAt ? new Date(customer.lastOrderAt).toLocaleString('zh-CN') : '—'}
            </div>
          </section>
          <section className="pt-3 border-t border-slate-200">
            <button className="btn-secondary w-full text-sm" onClick={() => alert('跳转订单列表 (demo) - 真环境过滤 customerId=' + customer.id)}>
              查看该散客所有订单 →
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 border-b border-slate-100">
      <dt className="text-slate-500 text-xs">{label}</dt>
      <dd className="text-right text-slate-900">{value}</dd>
    </div>
  );
}
