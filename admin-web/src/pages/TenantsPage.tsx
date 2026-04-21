/**
 * 租户 / License 管理 — SaaS 核心
 *
 * 每家签约的旅行社 = 一个 Tenant，独立 license tier、配额、品牌、域名。
 */
import { useMemo, useState } from 'react';
import { MOCK_TENANTS, type MockTenant, type LicenseTier } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

const TIER_INFO: Record<LicenseTier, { label: string; price: number; color: string }> = {
  STANDARD: { label: '标准版', price: 18000, color: 'bg-slate-500' },
  PROFESSIONAL: { label: '专业版', price: 36000, color: 'bg-brand' },
  ENTERPRISE: { label: '旗舰版', price: 68000, color: 'bg-red-600' },
};

export function TenantsPage() {
  const [selected, setSelected] = useState<MockTenant | null>(null);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<'' | LicenseTier>('');

  const filtered = useMemo(() => {
    return MOCK_TENANTS.filter((t) => {
      if (search) {
        const q = search.toLowerCase();
        if (!t.companyName.toLowerCase().includes(q) &&
            !t.contactEmail.toLowerCase().includes(q) &&
            !t.contactName.toLowerCase().includes(q)) return false;
      }
      if (tierFilter && t.licenseTier !== tierFilter) return false;
      return true;
    });
  }, [search, tierFilter]);

  const kpi = useMemo(() => {
    const active = MOCK_TENANTS.filter((t) => t.isActive);
    const annualRevenue = active.reduce((s, t) => s + TIER_INFO[t.licenseTier].price, 0);
    const mrr = annualRevenue / 12;
    const totalOrders = active.reduce((s, t) => s + t.monthlyOrders, 0);
    return {
      total: MOCK_TENANTS.length,
      active: active.length,
      expiring: MOCK_TENANTS.filter((t) => {
        const daysToExpiry = (new Date(t.licenseEndDate).getTime() - Date.now()) / 86400000;
        return daysToExpiry < 30 && daysToExpiry > 0 && t.isActive;
      }).length,
      annualRevenue,
      mrr,
      totalOrders,
    };
  }, []);

  return (
    <div className="space-y-4">
      {/* KPI */}
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="签约租户" value={kpi.active + ' / ' + kpi.total} sub={`${kpi.expiring} 个 30 天内到期`} color="bg-brand" />
        <Kpi label="年 License 收入" value={`¥${(kpi.annualRevenue / 10000).toFixed(1)}万`} sub="仅算 active" color="bg-green-600" />
        <Kpi label="MRR" value={`¥${(kpi.mrr / 1000).toFixed(1)}K`} sub="月经常性收入" color="bg-indigo-500" />
        <Kpi label="本月总订单" value={kpi.totalOrders.toLocaleString()} sub="所有租户合计" color="bg-amber-500" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">新增租户</p>
          <button className="btn-primary text-sm mt-2" onClick={() => alert('创建新租户（demo）— 真环境走 POST /admin/tenants')}>+ 签约新客户</button>
        </div>
      </section>

      <section>
        <h1 className="text-2xl font-bold text-slate-900">租户 / License 管理</h1>
        <p className="mt-1 text-sm text-slate-600">
          每家签约世途旅行平台的旅行社 = 一个 Tenant。独立 license / 配额 / 品牌 / 域名 / 数据隔离。
        </p>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="label text-xs">搜索</label>
            <input className="input" placeholder="公司名 / 联系人 / 邮箱" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">License 档位</label>
            <select className="input" value={tierFilter} onChange={(e) => setTierFilter(e.target.value as '' | LicenseTier)}>
              <option value="">全部</option>
              <option value="STANDARD">标准版 ¥18K</option>
              <option value="PROFESSIONAL">专业版 ¥36K</option>
              <option value="ENTERPRISE">旗舰版 ¥68K</option>
            </select>
          </div>
          <button
            className="btn-secondary text-sm"
            onClick={() => exportToCSV('租户名单', filtered, [
              { key: 'companyName', label: '公司' },
              { key: 'licenseTier', label: 'License', format: (v) => TIER_INFO[v as LicenseTier].label },
              { key: 'contactName', label: '联系人' },
              { key: 'contactEmail', label: '邮箱' },
              { key: 'licenseStartDate', label: '起始' },
              { key: 'licenseEndDate', label: '到期' },
              { key: 'monthlyOrders', label: '本月订单' },
              { key: 'monthlyRevenue', label: '本月营收', format: (v) => `¥${Number(v).toLocaleString()}` },
              { key: 'isActive', label: '状态', format: (v) => v ? '在用' : '停用' },
            ])}
          >
            📥 导出 CSV
          </button>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {filtered.map((t) => {
          const daysToExpiry = Math.ceil((new Date(t.licenseEndDate).getTime() - Date.now()) / 86400000);
          const usagePct = (t.quotas.ordersUsedThisMonth / t.quotas.maxMonthlyOrders) * 100;
          return (
            <div key={t.id} className={`card cursor-pointer hover:shadow-md transition ${!t.isActive ? 'opacity-60' : ''}`} onClick={() => setSelected(t)}>
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-slate-900 truncate">{t.companyName}</h3>
                    {!t.isActive && <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-600">停用</span>}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    👤 {t.contactName} · 📧 {t.contactEmail}
                  </div>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs font-semibold text-white ${TIER_INFO[t.licenseTier].color}`}>
                  {TIER_INFO[t.licenseTier].label}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded bg-slate-50 p-2">
                  <div className="text-slate-500">License 到期</div>
                  <div className={`font-semibold ${daysToExpiry < 30 ? 'text-amber-700' : daysToExpiry < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                    {t.licenseEndDate.slice(0, 7)}
                  </div>
                  <div className="text-[10px] text-slate-400">{daysToExpiry > 0 ? `剩 ${daysToExpiry} 天` : '已到期'}</div>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <div className="text-slate-500">月订单</div>
                  <div className="font-semibold text-amber-600">{t.monthlyOrders.toLocaleString()}</div>
                  <div className="text-[10px] text-slate-400">¥{(t.monthlyRevenue / 10000).toFixed(1)}万 GMV</div>
                </div>
                <div className="rounded bg-slate-50 p-2">
                  <div className="text-slate-500">配额用量</div>
                  <div className={`font-semibold ${usagePct > 80 ? 'text-red-600' : 'text-green-700'}`}>
                    {usagePct.toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-slate-400">{t.quotas.ordersUsedThisMonth}/{t.quotas.maxMonthlyOrders}</div>
                </div>
              </div>

              <div className="mt-3">
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${usagePct > 80 ? 'bg-red-500' : usagePct > 60 ? 'bg-amber-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(100, usagePct)}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {selected && <TenantDrawer tenant={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function TenantDrawer({ tenant, onClose }: { tenant: MockTenant; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...tenant });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 z-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">{tenant.companyName}</h2>
            <div className="flex items-center gap-2">
              {!editing && <button className="text-sm text-brand" onClick={() => setEditing(true)}>✏️ 编辑</button>}
              <button className="text-slate-400 text-xl" onClick={onClose}>×</button>
            </div>
          </div>
          <span className={`mt-2 inline-block rounded px-2 py-0.5 text-xs font-semibold text-white ${TIER_INFO[tenant.licenseTier].color}`}>
            {TIER_INFO[tenant.licenseTier].label} · ¥{TIER_INFO[tenant.licenseTier].price.toLocaleString()}/年
          </span>
        </div>

        <div className="px-6 py-5 space-y-4 text-sm">
          {!editing ? (
            <>
              <Section title="联系信息">
                <Row label="公司名" value={tenant.companyName} />
                <Row label="联系人" value={tenant.contactName} />
                <Row label="电话" value={tenant.contactPhone} />
                <Row label="邮箱" value={tenant.contactEmail} />
              </Section>

              <Section title="License 状态">
                <Row label="档位" value={TIER_INFO[tenant.licenseTier].label} />
                <Row label="起始日期" value={tenant.licenseStartDate} />
                <Row label="到期日期" value={tenant.licenseEndDate} />
                <Row label="状态" value={tenant.isActive ? '✅ 在用' : '⏸ 停用'} />
              </Section>

              <Section title="用量配额（本月）">
                <QuotaBar label="管理员账号" used={tenant.quotas.adminUsed} max={tenant.quotas.maxAdmins} />
                <QuotaBar label="月订单数" used={tenant.quotas.ordersUsedThisMonth} max={tenant.quotas.maxMonthlyOrders} />
                <QuotaBar label="存储空间 GB" used={tenant.quotas.storageUsedGB} max={tenant.quotas.maxStorageGB} />
              </Section>

              <Section title="品牌定制">
                <Row label="主色" value={<span className="flex items-center gap-2"><span className="h-4 w-4 rounded" style={{ background: tenant.brand.primaryColor }} />{tenant.brand.primaryColor}</span>} />
                <Row label="域名" value={tenant.brand.domain ?? '（使用默认）'} />
              </Section>

              <Section title={`已启用功能（${tenant.features.length}）`}>
                <div className="flex flex-wrap gap-1">
                  {tenant.features.map((f) => (
                    <span key={f} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{f}</span>
                  ))}
                </div>
              </Section>

              <Section title="本月业务数据">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded bg-slate-50 p-3 text-center">
                    <div className="text-xs text-slate-500">订单</div>
                    <div className="text-2xl font-bold text-amber-600">{tenant.monthlyOrders.toLocaleString()}</div>
                  </div>
                  <div className="rounded bg-slate-50 p-3 text-center">
                    <div className="text-xs text-slate-500">GMV</div>
                    <div className="text-2xl font-bold text-green-600">¥{(tenant.monthlyRevenue / 10000).toFixed(1)}万</div>
                  </div>
                </div>
              </Section>

              <section className="pt-3 border-t border-slate-200 grid grid-cols-2 gap-2">
                <button className="btn-secondary text-sm" onClick={() => alert('续费 license 流程 (demo)')}>续费 License</button>
                <button className="btn-secondary text-sm" onClick={() => alert('升级档位流程 (demo)')}>升级 / 降级</button>
              </section>
            </>
          ) : (
            <>
              <Section title="编辑租户信息">
                <div className="space-y-2">
                  <div>
                    <label className="label text-xs">公司名 *</label>
                    <input className="input" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
                  </div>
                  <div>
                    <label className="label text-xs">License 档位</label>
                    <select className="input" value={form.licenseTier} onChange={(e) => setForm({ ...form, licenseTier: e.target.value as LicenseTier, features: [] })}>
                      <option value="STANDARD">标准版 ¥18K</option>
                      <option value="PROFESSIONAL">专业版 ¥36K</option>
                      <option value="ENTERPRISE">旗舰版 ¥68K</option>
                    </select>
                  </div>
                  <div>
                    <label className="label text-xs">到期日期</label>
                    <input type="date" className="input" value={form.licenseEndDate} onChange={(e) => setForm({ ...form, licenseEndDate: e.target.value })} />
                  </div>
                  <div>
                    <label className="label text-xs">品牌主色</label>
                    <input type="color" className="input h-10" value={form.brand.primaryColor} onChange={(e) => setForm({ ...form, brand: { ...form.brand, primaryColor: e.target.value } })} />
                  </div>
                  <div>
                    <label className="label text-xs">自定义域名</label>
                    <input className="input" placeholder="如 trips.example.com" value={form.brand.domain ?? ''} onChange={(e) => setForm({ ...form, brand: { ...form.brand, domain: e.target.value } })} />
                  </div>
                </div>
              </Section>

              <div className="pt-3 border-t border-slate-200 flex gap-2">
                <button className="btn-secondary flex-1" onClick={() => setEditing(false)}>取消</button>
                <button className="btn-primary flex-1" onClick={() => { alert('已保存（demo）'); setEditing(false); }}>保存</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">{title}</h3>
      {children}
    </section>
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

function QuotaBar({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max === 0 || max > 999999 ? 0 : Math.min(100, (used / max) * 100);
  const color = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-green-500';
  return (
    <div className="py-1 border-b border-slate-100">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-900">{used.toLocaleString()} / {max > 999999 ? '不限' : max.toLocaleString()}</span>
      </div>
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
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
