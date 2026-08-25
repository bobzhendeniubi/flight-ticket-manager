/**
 * 散客管理 — 所有下单的散客（含直销 + 代理归属）
 */
import { useEffect, useMemo, useState } from 'react';
import { type MockCustomer } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';
import { api, ApiError, type CustomerSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { useDialogA11y } from '../components/Modal';

function customerApiToMock(c: CustomerSummary): MockCustomer {
  return {
    id: c.id,
    name: c.displayName ?? c.email ?? c.phone ?? '未命名客户',
    phone: c.phone ?? '',
    email: c.email,
    idNumber: c.profile.idNumber,
    agentId: c.profile.primaryAgentId,
    agentName: c.profile.primaryAgent
      ? (c.profile.primaryAgent.companyName ?? c.profile.primaryAgent.contactName)
      : null,
    createdAt: c.createdAt,
    totalOrders: c.totalOrders,
    totalSpent: c.totalSpent,
    lastOrderAt: c.lastOrderAt,
    tags: c.profile.tags,
  };
}

export function CustomersPage() {
  const tokens = useAuth((s) => s.tokens);
  const [customers, setCustomers] = useState<MockCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [selected, setSelected] = useState<MockCustomer | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listCustomers(tokens.accessToken, { pageSize: 200 })
      .then((r) => { if (!cancelled) setCustomers(r.customers.map(customerApiToMock)); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken, reloadNonce]);

  const agentNames = useMemo(() => {
    const set = new Set<string>();
    customers.forEach((c) => { if (c.agentName) set.add(c.agentName); });
    return Array.from(set).sort();
  }, [customers]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    customers.forEach((c) => c.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [customers]);

  const filtered = useMemo(() => {
    return customers.filter((c) => {
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
  }, [customers, search, agentFilter, tagFilter]);

  const kpi = useMemo(() => ({
    total: customers.length,
    direct: customers.filter((c) => !c.agentName).length,
    viaAgent: customers.filter((c) => c.agentName).length,
    totalSpent: customers.reduce((s, c) => s + c.totalSpent, 0),
    vip: customers.filter((c) => c.tags.includes('VIP')).length,
  }), [customers]);

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
      {/* 页头 */}
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">散客管理</h1>
          <p className="page-sub">所有购买过产品的散客，按归属代理、标签等维度筛选</p>
        </div>
        <button className="btn-secondary" onClick={handleExport}><Icon name="download" /> 导出 CSV</button>
      </section>

      {error && (
        <section className="card border border-red-200 bg-red-50 flex items-center justify-between gap-3">
          <p className="text-sm text-red-700">加载散客数据失败：{error}</p>
          <button className="btn-secondary text-sm" onClick={() => setReloadNonce((n) => n + 1)}>重试</button>
        </section>
      )}

      {/* KPI */}
      <section className="grid gap-3 md:grid-cols-4">
        <Kpi label="总散客数" value={kpi.total.toString()} sub={`${kpi.vip} VIP`} />
        <Kpi label="直销散客" value={kpi.direct.toString()} sub="无代理归属" />
        <Kpi label="代理散客" value={kpi.viaAgent.toString()} sub="代理创建/归属" />
        <Kpi label="累计消费" value={`¥${(kpi.totalSpent / 1000).toFixed(1)}K`} sub="所有散客" />
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
            显示 {filtered.length} / {customers.length}
          </div>
        </div>
      </section>

      {/* 表格 */}
      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">散客</th>
                <th className="text-left">联系方式</th>
                <th className="text-left">归属</th>
                <th className="text-center">订单/消费</th>
                <th className="text-left">最后下单</th>
                <th className="text-left">标签</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button className="font-medium text-ink hover:text-brand" onClick={() => setSelected(c)}>{c.name}</button>
                    {c.idNumber && <div className="text-xs text-ink-muted">{c.idNumber}</div>}
                  </td>
                  <td className="text-xs">
                    <div>{c.phone}</div>
                    <div className="text-ink-muted">{c.email ?? '—'}</div>
                  </td>
                  <td className="text-xs">
                    {c.agentName ? (
                      <span className="badge-warning"><Icon name="handshake" /> {c.agentName}</span>
                    ) : (
                      <span className="badge-info"><Icon name="building" /> 直销</span>
                    )}
                  </td>
                  <td className="text-center">
                    <div className="font-semibold text-ink nums">{c.totalOrders}</div>
                    <div className="text-xs text-ink-muted nums">¥{c.totalSpent.toLocaleString()}</div>
                  </td>
                  <td className="text-xs text-ink-soft">
                    {c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString('zh-CN') : '—'}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {c.tags.map((t) => (
                        <span key={t} className={
                          t === 'VIP' ? 'badge-danger' :
                          t === '回头客' ? 'badge-success' :
                          t === '新客' ? 'badge-info' :
                          'badge-neutral'
                        }>{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="text-right">
                    <button className="text-xs font-medium text-brand hover:text-brand-dark" onClick={() => setSelected(c)}>详情</button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-muted">
                    {loading ? '加载中…' : '没有符合条件的散客'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <CustomerDrawer
          customer={selected}
          onClose={() => setSelected(null)}
          onSaved={(updated) => {
            setCustomers((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
            setSelected(updated);
          }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}

function CustomerDrawer({
  customer,
  onClose,
  onSaved,
}: {
  customer: MockCustomer;
  onClose: () => void;
  onSaved: (updated: MockCustomer) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const dialogRef = useDialogA11y(onClose);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: customer.name,
    phone: customer.phone,
    email: customer.email ?? '',
    idNumber: customer.idNumber ?? '',
    tags: customer.tags.join(', '),
    notes: '',
  });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!tokens?.accessToken) return;
    setSaving(true);
    setSaveError(null);
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await api.updateCustomer(tokens.accessToken, customer.id, {
        displayName: form.name,
        phone: form.phone,
        email: form.email || undefined,
        idNumber: form.idNumber || null,
        tags,
        notes: form.notes || null,
      });
      onSaved(customerApiToMock(res.customer));
      setSaved(true);
      setTimeout(() => { setEditing(false); setSaved(false); }, 1200);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const addTag = (tag: string) => {
    const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (!tags.includes(tag)) setForm({ ...form, tags: [...tags, tag].join(', ') });
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="散客详情" tabIndex={-1} className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 z-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">{customer.name}</h2>
            <div className="flex items-center gap-2">
              {!editing && (
                <button className="text-sm text-brand hover:text-brand-dark" onClick={() => setEditing(true)}><Icon name="edit" /> 编辑</button>
              )}
              <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose} aria-label="关闭散客详情"><Icon name="close" /></button>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {customer.tags.map((t) => (
              <span key={t} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{t}</span>
            ))}
          </div>
        </div>
        <div className="px-6 py-5 space-y-4 text-sm">
          {!editing ? (
            // ── 查看模式 ──
            <>
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
                  <Row label="销售渠道" value={customer.agentName ? <><Icon name="handshake" /> {customer.agentName}</> : <><Icon name="building" /> 直销</>} />
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
            </>
          ) : (
            // ── 编辑模式 ──
            <>
              <section className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-500 uppercase">编辑信息</h3>
                <div>
                  <label className="label text-xs">姓名 *</label>
                  <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <label className="label text-xs">手机 *</label>
                  <input className="input" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <label className="label text-xs">邮箱</label>
                  <input type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div>
                  <label className="label text-xs">证件号 / 护照号</label>
                  <input className="input" placeholder="如 MA1234567" value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
                </div>
                <div>
                  <label className="label text-xs">标签（逗号分隔）</label>
                  <input className="input" placeholder="如 VIP, 回头客" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
                  <div className="mt-1 flex flex-wrap gap-1">
                    {['VIP', '回头客', '新客', '蜜月', '商务', '黑名单'].map((t) => (
                      <button key={t} type="button" className="text-[10px] rounded bg-slate-100 px-2 py-0.5 hover:bg-slate-200" onClick={() => addTag(t)}>
                        + {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="label text-xs">备注 Notes</label>
                  <textarea className="input" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="内部备注，例如饮食偏好、特殊要求、投诉历史等" />
                </div>
              </section>

              {saved && (
                <div className="rounded bg-green-50 px-3 py-2 text-sm text-green-700">已保存</div>
              )}
              {saveError && (
                <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{saveError}</div>
              )}
              <section className="pt-3 border-t border-slate-200 flex gap-3">
                <button className="btn-secondary flex-1" onClick={() => setEditing(false)} disabled={saving}>取消</button>
                <button className="btn-primary flex-1" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存修改'}</button>
              </section>
            </>
          )}
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
