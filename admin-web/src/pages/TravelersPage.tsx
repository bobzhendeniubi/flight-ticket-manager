/**
 * 旅客管理 — 所有订单里出现的出行人（去重）
 * 关键 query: 姓名 + 生日（核实身份常用组合）
 */
import { useMemo, useState } from 'react';
import { MOCK_TRAVELERS, MOCK_CUSTOMERS, type MockTraveler } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';

export function TravelersPage() {
  const [nameQuery, setNameQuery] = useState('');
  const [birthdayQuery, setBirthdayQuery] = useState('');
  const [nationalityFilter, setNationalityFilter] = useState('');
  const [ageRange, setAgeRange] = useState<'' | 'child' | 'adult' | 'senior'>('');
  const [selected, setSelected] = useState<MockTraveler | null>(null);

  const nationalities = useMemo(() => {
    const set = new Set<string>();
    MOCK_TRAVELERS.forEach((t) => set.add(t.nationality));
    return Array.from(set).sort();
  }, []);

  const today = new Date();
  const calcAge = (dob: string): number => {
    const d = new Date(dob);
    let age = today.getFullYear() - d.getFullYear();
    const m = today.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
    return age;
  };

  const filtered = useMemo(() => {
    return MOCK_TRAVELERS.filter((t) => {
      if (nameQuery) {
        const q = nameQuery.toLowerCase();
        if (!t.fullName.toLowerCase().includes(q)) return false;
      }
      if (birthdayQuery && t.dateOfBirth !== birthdayQuery) return false;
      if (nationalityFilter && t.nationality !== nationalityFilter) return false;
      if (ageRange) {
        const age = calcAge(t.dateOfBirth);
        if (ageRange === 'child' && age >= 12) return false;
        if (ageRange === 'adult' && (age < 12 || age >= 60)) return false;
        if (ageRange === 'senior' && age < 60) return false;
      }
      return true;
    });
  }, [nameQuery, birthdayQuery, nationalityFilter, ageRange]);

  const kpi = useMemo(() => {
    const ages = MOCK_TRAVELERS.map((t) => calcAge(t.dateOfBirth));
    return {
      total: MOCK_TRAVELERS.length,
      children: ages.filter((a) => a < 12).length,
      adults: ages.filter((a) => a >= 12 && a < 60).length,
      seniors: ages.filter((a) => a >= 60).length,
      totalTrips: MOCK_TRAVELERS.reduce((s, t) => s + t.tripCount, 0),
    };
  }, []);

  const handleExport = () => {
    exportToCSV('旅客名单', filtered, [
      { key: 'fullName', label: '姓名（护照拼音）' },
      { key: 'passportNumber', label: '护照号' },
      { key: 'dateOfBirth', label: '生日' },
      { key: 'nationality', label: '国籍' },
      { key: 'phone', label: '电话', format: (v) => String(v ?? '') },
      { key: 'tripCount', label: '出行次数' },
      { key: 'lastTripAt', label: '最近出行', format: (v) => String(v ?? '—') },
      { key: 'customerIds', label: '关联客户数', format: (v) => String((v as string[]).length) },
      { key: 'notes', label: '备注', format: (v) => String(v ?? '') },
    ]);
  };

  return (
    <div className="space-y-4">
      {/* KPI */}
      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="总旅客数" value={kpi.total.toString()} sub="从订单提取去重" color="bg-brand" />
        <Kpi label="儿童 &lt;12" value={kpi.children.toString()} sub="需监护人" color="bg-pink-500" />
        <Kpi label="成人 12-59" value={kpi.adults.toString()} sub="主力出行" color="bg-indigo-500" />
        <Kpi label="老人 ≥60" value={kpi.seniors.toString()} sub="需关注健康" color="bg-amber-500" />
        <div className="card p-3 flex flex-col justify-between">
          <p className="text-xs font-medium uppercase text-slate-500">导出</p>
          <button className="btn-primary text-sm mt-2" onClick={handleExport}>📥 导出 CSV</button>
        </div>
      </section>

      <section>
        <h1 className="text-2xl font-bold text-slate-900">旅客管理</h1>
        <p className="mt-1 text-sm text-slate-600">
          从所有订单自动提取的出行人档案。用<strong>姓名 + 生日</strong>精确查找客户（身份核实常用）。
        </p>
      </section>

      {/* 过滤器 */}
      <section className="card">
        <div className="grid gap-3 md:grid-cols-5">
          <div className="md:col-span-2">
            <label className="label text-xs">姓名搜索（拼音/中文）</label>
            <input
              className="input"
              placeholder="如 CHAN / 陈文豪 / LEE"
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">生日（精确）</label>
            <input type="date" className="input" value={birthdayQuery} onChange={(e) => setBirthdayQuery(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">国籍</label>
            <select className="input" value={nationalityFilter} onChange={(e) => setNationalityFilter(e.target.value)}>
              <option value="">全部</option>
              {nationalities.map((n) => (
                <option key={n} value={n}>{n === 'MO' ? '中国澳门' : n === 'HK' ? '中国香港' : n === 'CN' ? '中国' : n === 'TW' ? '中国台湾' : n}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">年龄段</label>
            <select className="input" value={ageRange} onChange={(e) => setAgeRange(e.target.value as '' | 'child' | 'adult' | 'senior')}>
              <option value="">全部</option>
              <option value="child">儿童 &lt;12</option>
              <option value="adult">成人 12-59</option>
              <option value="senior">老人 ≥60</option>
            </select>
          </div>
        </div>
        {(nameQuery || birthdayQuery || nationalityFilter || ageRange) && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>找到 {filtered.length} 位旅客</span>
            <button
              className="text-brand hover:text-brand-dark"
              onClick={() => { setNameQuery(''); setBirthdayQuery(''); setNationalityFilter(''); setAgeRange(''); }}
            >
              清除过滤
            </button>
          </div>
        )}
      </section>

      {/* 表格 */}
      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">姓名</th>
                <th className="px-4 py-3 text-left">护照号</th>
                <th className="px-4 py-3 text-left">生日 / 年龄</th>
                <th className="px-4 py-3 text-center">国籍</th>
                <th className="px-4 py-3 text-left">电话</th>
                <th className="px-4 py-3 text-center">出行次数</th>
                <th className="px-4 py-3 text-left">最近出行</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((t) => {
                const age = calcAge(t.dateOfBirth);
                return (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <button className="font-medium text-slate-900 hover:text-brand" onClick={() => setSelected(t)}>
                        {t.fullName}
                      </button>
                      {t.notes && <div className="text-xs text-slate-400">{t.notes}</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{t.passportNumber}</td>
                    <td className="px-4 py-3 text-xs">
                      <div>{t.dateOfBirth}</div>
                      <div className="text-slate-400">
                        {age < 12 ? `${age} 岁 · 儿童` : age >= 60 ? `${age} 岁 · 老人` : `${age} 岁 · 成人`}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{t.nationality}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{t.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="font-semibold text-indigo-600">{t.tripCount}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{t.lastTripAt ?? '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button className="text-xs text-brand hover:text-brand-dark" onClick={() => setSelected(t)}>详情</button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">没有符合条件的旅客</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && <TravelerDrawer traveler={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <span className={`h-8 w-1 rounded ${color}`}></span>
        <p className="text-xs font-medium uppercase text-slate-500" dangerouslySetInnerHTML={{ __html: label }} />
      </div>
      <p className="mt-1.5 text-2xl font-bold text-slate-900">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{sub}</p>
    </div>
  );
}

function TravelerDrawer({ traveler, onClose }: { traveler: MockTraveler; onClose: () => void }) {
  const customers = traveler.customerIds
    .map((id) => MOCK_CUSTOMERS.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{traveler.fullName}</h2>
          <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
        </div>
        <div className="px-6 py-5 space-y-4 text-sm">
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">身份信息</h3>
            <dl className="space-y-1">
              <Row label="护照拼音姓名" value={traveler.fullName} />
              <Row label="护照号" value={<span className="font-mono">{traveler.passportNumber}</span>} />
              <Row label="生日" value={traveler.dateOfBirth} />
              <Row label="国籍" value={traveler.nationality} />
              <Row label="电话" value={traveler.phone ?? '—'} />
            </dl>
          </section>
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">出行历史</h3>
            <div className="rounded bg-slate-50 p-3 text-center">
              <div className="text-xs text-slate-500">累计出行次数</div>
              <div className="text-3xl font-bold text-indigo-600 mt-1">{traveler.tripCount}</div>
              <div className="text-xs text-slate-500 mt-1">
                最近: {traveler.lastTripAt ?? '—'}
              </div>
            </div>
          </section>
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">关联客户（下单人）</h3>
            <ul className="space-y-1.5">
              {customers.map((c) => (
                <li key={c.id} className="rounded border border-slate-200 p-2 flex items-center justify-between text-xs">
                  <div>
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-slate-500">{c.phone}</div>
                  </div>
                  {c.agentName && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">🤝</span>}
                </li>
              ))}
            </ul>
          </section>
          {traveler.notes && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">备注</h3>
              <p className="text-sm text-slate-700">{traveler.notes}</p>
            </section>
          )}
          <section className="pt-3 border-t border-slate-200">
            <button className="btn-secondary w-full text-sm" onClick={() => alert('跳转订单列表 (demo) - 真环境过滤 passengerId=' + traveler.id)}>
              查看该旅客所有行程 →
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
