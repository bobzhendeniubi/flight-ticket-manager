/**
 * 旅客页入口 —— 按角色分流：
 *   - ADMIN/STAFF → 旅客档案（TravelerProfilesView：全量订单按证件号聚合的常旅客画像）
 *   - AGENT       → 常用乘机人管理（SavedTravelersView：树内客户的 SavedPassenger，原有功能）
 */
import { useEffect, useMemo, useState } from 'react';
import { type MockTraveler } from '../lib/mockData';
import { exportToCSV } from '../lib/csvExport';
import { api, ApiError, type Traveler } from '../lib/api';
import { useAuth } from '../stores/auth';
import { TravelerProfilesView } from './TravelerProfilesView';

export function TravelersPage() {
  const user = useAuth((s) => s.user);
  if (user?.role === 'AGENT') return <SavedTravelersView />;
  return <TravelerProfilesView />;
}

function travelerApiToMock(t: Traveler): MockTraveler {
  return {
    id: t.id,
    fullName: t.fullName,
    passportNumber: t.documentNumber,
    dateOfBirth: typeof t.dateOfBirth === 'string' ? t.dateOfBirth.slice(0, 10) : t.dateOfBirth,
    nationality: t.nationality,
    phone: t.phone,
    customerIds: t.customer ? [t.customer.id] : [],
    tripCount: t.tripCount,
    lastTripAt: t.lastTripAt ? (typeof t.lastTripAt === 'string' ? t.lastTripAt.slice(0, 10) : t.lastTripAt) : null,
    notes: t.notes,
  };
}

function SavedTravelersView() {
  const tokens = useAuth((s) => s.tokens);
  const [travelers, setTravelers] = useState<MockTraveler[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nameQuery, setNameQuery] = useState('');
  const [birthdayQuery, setBirthdayQuery] = useState('');
  const [nationalityFilter, setNationalityFilter] = useState('');
  const [ageRange, setAgeRange] = useState<'' | 'child' | 'adult' | 'senior'>('');
  const [selected, setSelected] = useState<MockTraveler | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listTravelers(tokens.accessToken, { pageSize: 500 })
      .then((r) => { if (!cancelled) setTravelers(r.travelers.map(travelerApiToMock)); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tokens?.accessToken, reloadNonce]);

  const nationalities = useMemo(() => {
    const set = new Set<string>();
    travelers.forEach((t) => set.add(t.nationality));
    return Array.from(set).sort();
  }, [travelers]);

  const today = new Date();
  const calcAge = (dob: string): number => {
    const d = new Date(dob);
    let age = today.getFullYear() - d.getFullYear();
    const m = today.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
    return age;
  };

  const filtered = useMemo(() => {
    return travelers.filter((t) => {
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
  }, [travelers, nameQuery, birthdayQuery, nationalityFilter, ageRange]);

  const kpi = useMemo(() => {
    const ages = travelers.map((t) => calcAge(t.dateOfBirth));
    return {
      total: travelers.length,
      children: ages.filter((a) => a < 12).length,
      adults: ages.filter((a) => a >= 12 && a < 60).length,
      seniors: ages.filter((a) => a >= 60).length,
      totalTrips: travelers.reduce((s, t) => s + t.tripCount, 0),
    };
  }, [travelers]);

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
      {/* 页头 */}
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">旅客管理</h1>
          <p className="page-sub">
            从所有订单自动提取的出行人档案。用<strong>姓名 + 生日</strong>精确查找客户（身份核实常用）。
          </p>
        </div>
        <button className="btn-secondary" onClick={handleExport}>📥 导出 CSV</button>
      </section>

      {error && (
        <section className="card border border-red-200 bg-red-50 flex items-center justify-between gap-3">
          <p className="text-sm text-red-700">加载旅客数据失败：{error}</p>
          <button className="btn-secondary text-sm" onClick={() => setReloadNonce((n) => n + 1)}>重试</button>
        </section>
      )}

      {/* KPI */}
      <section className="grid gap-3 md:grid-cols-4">
        <Kpi label="总旅客数" value={kpi.total.toString()} sub="从订单提取去重" />
        <Kpi label="儿童 &lt;12" value={kpi.children.toString()} sub="需监护人" />
        <Kpi label="成人 12-59" value={kpi.adults.toString()} sub="主力出行" />
        <Kpi label="老人 ≥60" value={kpi.seniors.toString()} sub="需关注健康" />
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
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">姓名</th>
                <th className="text-left">护照号</th>
                <th className="text-left">生日 / 年龄</th>
                <th className="text-center">国籍</th>
                <th className="text-left">电话</th>
                <th className="text-center">出行次数</th>
                <th className="text-left">最近出行</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const age = calcAge(t.dateOfBirth);
                return (
                  <tr key={t.id}>
                    <td>
                      <button className="font-medium text-ink hover:text-brand" onClick={() => setSelected(t)}>
                        {t.fullName}
                      </button>
                      {t.notes && <div className="text-xs text-ink-muted">{t.notes}</div>}
                    </td>
                    <td className="font-mono text-xs text-ink-soft">{t.passportNumber}</td>
                    <td className="text-xs">
                      <div>{t.dateOfBirth}</div>
                      <div className="text-ink-muted">
                        {age < 12 ? `${age} 岁 · 儿童` : age >= 60 ? `${age} 岁 · 老人` : `${age} 岁 · 成人`}
                      </div>
                    </td>
                    <td className="text-center">
                      <span className="badge-neutral">{t.nationality}</span>
                    </td>
                    <td className="text-xs text-ink-soft">{t.phone ?? '—'}</td>
                    <td className="text-center">
                      <span className="font-semibold text-ink nums">{t.tripCount}</span>
                    </td>
                    <td className="text-xs text-ink-soft">{t.lastTripAt ?? '—'}</td>
                    <td className="text-right">
                      <button className="text-xs font-medium text-brand hover:text-brand-dark" onClick={() => setSelected(t)}>详情</button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-ink-muted">
                    {loading ? '加载中…' : '没有符合条件的旅客'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <TravelerDrawer
          traveler={selected}
          onClose={() => setSelected(null)}
          onSaved={(updated) => {
            setTravelers((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
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
      <p className="stat-label" dangerouslySetInnerHTML={{ __html: label }} />
      <p className="stat-value">{value}</p>
      <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>
    </div>
  );
}

function TravelerDrawer({
  traveler,
  onClose,
  onSaved,
}: {
  traveler: MockTraveler;
  onClose: () => void;
  onSaved: (updated: MockTraveler) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    fullName: traveler.fullName,
    passportNumber: traveler.passportNumber,
    dateOfBirth: traveler.dateOfBirth,
    nationality: traveler.nationality,
    phone: traveler.phone ?? '',
    notes: traveler.notes ?? '',
  });
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!tokens?.accessToken) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.updateTraveler(tokens.accessToken, traveler.id, {
        fullName: form.fullName,
        documentNumber: form.passportNumber,
        dateOfBirth: form.dateOfBirth,
        nationality: form.nationality,
        phone: form.phone || undefined,
        notes: form.notes || undefined,
      });
      onSaved(travelerApiToMock(res.traveler));
      setSaved(true);
      setTimeout(() => { setEditing(false); setSaved(false); }, 1200);
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  // customerIds 仍保留（后端适配时会填 1 个 user id），UI 展示"已关联 N 位客户"即可
  const customers = traveler.customerIds.map((id) => ({ id, name: '客户 #' + id.slice(0, 8) }));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold text-slate-900">{traveler.fullName}</h2>
          <div className="flex items-center gap-2">
            {!editing && (
              <button className="text-sm text-brand hover:text-brand-dark" onClick={() => setEditing(true)}>✏️ 编辑</button>
            )}
            <button className="text-slate-400 hover:text-slate-700 text-xl" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4 text-sm">
          {!editing ? (
            <>
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
                      </div>
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
            </>
          ) : (
            <>
              <section className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-500 uppercase">编辑旅客档案</h3>
                <div>
                  <label className="label text-xs">护照拼音姓名 *（与护照一致）</label>
                  <input required className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                </div>
                <div>
                  <label className="label text-xs">护照号 *</label>
                  <input required className="input font-mono" value={form.passportNumber} onChange={(e) => setForm({ ...form, passportNumber: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label text-xs">生日 *</label>
                    <input type="date" required className="input" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} />
                  </div>
                  <div>
                    <label className="label text-xs">国籍</label>
                    <select className="input" value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })}>
                      <option value="MO">MO 澳门</option>
                      <option value="HK">HK 香港</option>
                      <option value="CN">CN 中国</option>
                      <option value="TW">TW 台湾</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label text-xs">电话</label>
                  <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div>
                  <label className="label text-xs">备注 Notes</label>
                  <textarea className="input" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="例如：VIP 客户 / 需要儿童安全座椅 / 素食要求" />
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
