/**
 * 旅客档案（常旅客画像）—— ADMIN/STAFF 视图。
 *
 * 数据源 = TravelerProfile 快照（按证件号聚合全量订单乘机人，含游客单）：
 * 飞过几次、什么时候飞、人均消费、住过什么酒店、床型/餐食/轮椅等偏好、同行人。
 * 详情抽屉实时从订单重算（永远准确）；列表快照过期由后端自动后台重建。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type ListTravelerProfilesResult,
  type TravelerProfile,
  type TravelerProfileSuggestion,
  type TravelerProfileTrip,
} from '../lib/api';
import { exportToCSV } from '../lib/csvExport';
import { useAuth } from '../stores/auth';

const CABIN_LABELS: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '高端经济',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

const BED_LABELS: Record<string, string> = {
  SINGLE: '单人间',
  DOUBLE: '大床',
  TWIN: '双床',
  SHARE_OK: '可拼房',
};

const DOC_LABELS: Record<string, string> = {
  PASSPORT: '护照',
  ID_CARD: '身份证',
  TRAVEL_PERMIT: '通行证',
  OTHER: '其他',
};

/** 护照临期阈值：不足 180 天标警示（多数目的地要求 6 个月有效期） */
const PASSPORT_EXPIRY_WARN_DAYS = 180;

const PAGE_SIZE = 100;

type SortKey = 'lastTripAt' | 'nextTripAt' | 'tripCount' | 'totalSpendCny';

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

function fmtCny(v: string | number): string {
  const n = typeof v === 'string' ? Number(v) : v;
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}

function calcAge(dobIso: string | null): number | null {
  if (!dobIso) return null;
  const d = new Date(dobIso);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function passportExpiryDays(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function TravelerProfilesView() {
  const tokens = useAuth((s) => s.tokens);
  const [data, setData] = useState<ListTravelerProfilesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [repeatOnly, setRepeatOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('lastTripAt');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, repeatOnly, sort]);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listTravelerProfiles(tokens.accessToken, {
        search: debouncedSearch || undefined,
        sort,
        order: 'desc',
        minTrips: repeatOnly ? 2 : undefined,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tokens?.accessToken, debouncedSearch, repeatOnly, sort, page, reloadNonce]);

  const profiles = data?.profiles ?? [];
  const total = data?.pagination.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const kpi = useMemo(
    () => ({
      totalProfiles: data?.meta.totalProfiles ?? 0,
      totalTrips: data?.meta.totalTrips ?? 0,
      refreshedAt: data?.meta.refreshedAt ?? null,
    }),
    [data],
  );

  const handleRebuild = async () => {
    if (!tokens?.accessToken || rebuilding) return;
    setRebuilding(true);
    try {
      await api.rebuildTravelerProfiles(tokens.accessToken);
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '重建失败');
    } finally {
      setRebuilding(false);
    }
  };

  const handleExport = () => {
    exportToCSV('旅客档案', profiles, [
      { key: 'travelerNo', label: '常旅客号' },
      { key: 'fullName', label: '姓名' },
      { key: 'chineseName', label: '中文名', format: (v) => String(v ?? '') },
      { key: 'documentNumber', label: '证件号' },
      { key: 'dateOfBirth', label: '生日', format: (v) => (v ? String(v).slice(0, 10) : '') },
      { key: 'tripCount', label: '飞行次数' },
      { key: 'orderCount', label: '订单数' },
      { key: 'firstTripAt', label: '首次出行', format: (v) => (v ? String(v).slice(0, 10) : '') },
      { key: 'lastTripAt', label: '最近出行', format: (v) => (v ? String(v).slice(0, 10) : '') },
      { key: 'nextTripAt', label: '下次出行', format: (v) => (v ? String(v).slice(0, 10) : '') },
      { key: 'totalSpendCny', label: '累计消费(人均)' },
      { key: 'prefBed', label: '床型偏好', format: (v) => (v ? BED_LABELS[String(v)] ?? String(v) : '') },
      { key: 'prefMeal', label: '餐食偏好', format: (v) => String(v ?? '') },
      { key: 'notes', label: '备注', format: (v) => String(v ?? '') },
    ]);
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">旅客档案</h1>
          <p className="page-sub">
            全量订单乘机人按<strong>证件号</strong>归拢的常旅客画像：飞行次数、消费、酒店与偏好。
            {kpi.refreshedAt && (
              <span className="ml-2 text-xs text-ink-muted">
                数据截至 {new Date(kpi.refreshedAt).toLocaleString('zh-CN')}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={handleExport}>📥 导出 CSV</button>
          <button className="btn-secondary" onClick={handleRebuild} disabled={rebuilding}>
            {rebuilding ? '重建中…' : '🔄 重建档案'}
          </button>
        </div>
      </section>

      {error && (
        <section className="card border border-red-200 bg-red-50 flex items-center justify-between gap-3">
          <p className="text-sm text-red-700">{error}</p>
          <button className="btn-secondary text-sm" onClick={() => setReloadNonce((n) => n + 1)}>重试</button>
        </section>
      )}

      <section className="grid gap-3 md:grid-cols-3">
        <Kpi label="旅客总数" value={kpi.totalProfiles.toLocaleString()} sub="全量订单去重（含游客单）" />
        <Kpi label="累计飞行人次" value={kpi.totalTrips.toLocaleString()} sub="已起飞行程 × 人" />
        <Kpi
          label="当前筛选"
          value={total.toLocaleString()}
          sub={repeatOnly ? '飞过 ≥2 次的回头客' : '全部旅客'}
        />
      </section>

      <section className="card">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label text-xs">搜索（姓名 / 中文名 / 证件号）</label>
            <input
              className="input"
              placeholder="如 CHAN / 陈文豪 / E1234"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-xs">排序</label>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="lastTripAt">最近出行</option>
              <option value="nextTripAt">下次出行</option>
              <option value="tripCount">飞行次数</option>
              <option value="totalSpendCny">累计消费</option>
            </select>
          </div>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-sm text-ink-soft cursor-pointer">
              <input
                type="checkbox"
                checked={repeatOnly}
                onChange={(e) => setRepeatOnly(e.target.checked)}
              />
              只看回头客（≥2 次）
            </label>
          </div>
        </div>
      </section>

      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">常旅客号</th>
                <th className="text-left">姓名</th>
                <th className="text-left">证件</th>
                <th className="text-left">生日 / 年龄</th>
                <th className="text-center">飞行次数</th>
                <th className="text-left">最近出行</th>
                <th className="text-left">下次出行</th>
                <th className="text-right">累计消费(人均)</th>
                <th className="text-left">偏好</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const age = calcAge(p.dateOfBirth);
                const expDays = passportExpiryDays(p.passportExpiry);
                return (
                  <tr key={p.id}>
                    <td className="font-mono text-xs text-ink-soft whitespace-nowrap">{p.travelerNo}</td>
                    <td>
                      <button
                        className="font-medium text-ink hover:text-brand"
                        onClick={() => setSelectedId(p.id)}
                      >
                        {p.fullName}
                      </button>
                      {p.chineseName && <div className="text-xs text-ink-muted">{p.chineseName}</div>}
                      {p.notes && <div className="text-xs text-amber-600 truncate max-w-[16rem]">📝 {p.notes}</div>}
                    </td>
                    <td className="text-xs">
                      <span className="badge-neutral mr-1">{DOC_LABELS[p.documentType] ?? p.documentType}</span>
                      <span className="font-mono text-ink-soft">{p.documentNumber}</span>
                      {expDays !== null && expDays < PASSPORT_EXPIRY_WARN_DAYS && (
                        <div className={expDays < 0 ? 'text-red-600' : 'text-amber-600'}>
                          {expDays < 0 ? '⚠️ 护照已过期' : `⚠️ 护照 ${expDays} 天后到期`}
                        </div>
                      )}
                    </td>
                    <td className="text-xs">
                      <div>{fmtDate(p.dateOfBirth)}</div>
                      {age !== null && <div className="text-ink-muted">{age} 岁</div>}
                    </td>
                    <td className="text-center">
                      <span className="font-semibold text-ink nums">{p.tripCount}</span>
                      {p.tripCount >= 2 && (
                        <div className="text-[10px] text-emerald-600 font-medium">回头客</div>
                      )}
                    </td>
                    <td className="text-xs text-ink-soft">{fmtDate(p.lastTripAt)}</td>
                    <td className="text-xs">
                      {p.nextTripAt ? (
                        <span className="text-brand font-medium">{fmtDate(p.nextTripAt)}</span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="text-right text-xs font-medium nums">{fmtCny(p.totalSpendCny)}</td>
                    <td className="text-xs text-ink-soft">
                      <PrefBadges profile={p} />
                    </td>
                    <td className="text-right">
                      <button
                        className="text-xs font-medium text-brand hover:text-brand-dark"
                        onClick={() => setSelectedId(p.id)}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                );
              })}
              {profiles.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-ink-muted">
                    {loading ? '加载中…（首次访问会自动从历史订单建档）' : '没有符合条件的旅客'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-ink-soft">
            <span>
              第 {page} / {pageCount} 页 · 共 {total} 人
            </span>
            <div className="flex gap-2">
              <button className="btn-secondary text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <button
                className="btn-secondary text-xs"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </section>

      {selectedId && (
        <ProfileDrawer
          profileId={selectedId}
          onClose={() => setSelectedId(null)}
          onMerged={() => {
            setSelectedId(null);
            setReloadNonce((n) => n + 1);
          }}
          onSearchCompanion={(doc) => {
            setSelectedId(null);
            setSearch(doc);
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

function PrefBadges({ profile }: { profile: TravelerProfile }) {
  const badges: string[] = [];
  if (profile.prefCabin && profile.prefCabin !== 'ECONOMY') {
    badges.push(CABIN_LABELS[profile.prefCabin] ?? profile.prefCabin);
  }
  if (profile.prefBed) badges.push(BED_LABELS[profile.prefBed] ?? profile.prefBed);
  if (profile.prefMeal) badges.push(profile.prefMeal);
  if (profile.prefSingleRoom) badges.push('单住');
  if (profile.needsWheelchair) badges.push('♿ 轮椅');
  if (badges.length === 0) return <span className="text-ink-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span key={b} className="badge-neutral">{b}</span>
      ))}
    </span>
  );
}

function ProfileDrawer({
  profileId,
  onClose,
  onMerged,
  onSearchCompanion,
}: {
  profileId: string;
  onClose: () => void;
  /** 合并成功后回调（父组件关抽屉 + 刷新列表） */
  onMerged: () => void;
  onSearchCompanion: (documentNumber: string) => void;
}) {
  const tokens = useAuth((s) => s.tokens);
  const [profile, setProfile] = useState<TravelerProfile | null>(null);
  const [trips, setTrips] = useState<TravelerProfileTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);

  useEffect(() => {
    if (!tokens?.accessToken) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTravelerProfile(tokens.accessToken, profileId)
      .then((r) => {
        if (cancelled) return;
        setProfile(r.profile);
        setTrips(r.trips);
        setNotesDraft(r.profile.notes ?? '');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tokens?.accessToken, profileId]);

  const saveNotes = async () => {
    if (!tokens?.accessToken || !profile) return;
    setSavingNotes(true);
    try {
      const r = await api.updateTravelerProfileNotes(
        tokens.accessToken,
        profile.id,
        notesDraft.trim() || null,
      );
      setProfile(r.profile);
      setNotesSaved(true);
      window.setTimeout(() => setNotesSaved(false), 1500);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSavingNotes(false);
    }
  };

  const expDays = passportExpiryDays(profile?.passportExpiry ?? null);
  const age = calcAge(profile?.dateOfBirth ?? null);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-auto bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              {profile?.fullName ?? '加载中…'}
              {profile?.chineseName && (
                <span className="ml-2 text-sm font-normal text-slate-500">{profile.chineseName}</span>
              )}
              {profile && (
                <span className="badge-neutral ml-2 align-middle font-mono text-xs font-normal">
                  {profile.travelerNo}
                </span>
              )}
            </h2>
            {profile && profile.tripCount >= 2 && (
              <span className="text-xs font-medium text-emerald-600">回头客 · 飞过 {profile.tripCount} 次</span>
            )}
          </div>
          <button className="text-xl text-slate-400 hover:text-slate-700" onClick={onClose}>×</button>
        </div>

        <div className="space-y-4 px-6 py-5 text-sm">
          {error && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {loading && <div className="py-8 text-center text-ink-muted">正在从订单实时汇总…</div>}

          {profile && !loading && (
            <>
              {/* 出行统计 */}
              <section className="grid grid-cols-3 gap-2">
                <MiniStat label="已飞行程" value={String(profile.tripCount)} />
                <MiniStat label="有效订单" value={String(profile.orderCount)} />
                <MiniStat label="累计消费(人均)" value={fmtCny(profile.totalSpendCny)} />
                <MiniStat label="首次出行" value={fmtDate(profile.firstTripAt)} />
                <MiniStat label="最近出行" value={fmtDate(profile.lastTripAt)} />
                <MiniStat label="下次出行" value={fmtDate(profile.nextTripAt)} highlight={Boolean(profile.nextTripAt)} />
              </section>

              {/* 身份信息 */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">身份信息</h3>
                <dl className="space-y-1">
                  <Row
                    label="证件"
                    value={
                      <span>
                        <span className="badge-neutral mr-1">{DOC_LABELS[profile.documentType] ?? profile.documentType}</span>
                        <span className="font-mono">{profile.documentNumber}</span>
                      </span>
                    }
                  />
                  <Row label="性别" value={profile.gender === 'MALE' ? '男' : profile.gender === 'FEMALE' ? '女' : '—'} />
                  <Row label="生日" value={`${fmtDate(profile.dateOfBirth)}${age !== null ? ` · ${age} 岁` : ''}`} />
                  <Row label="国籍" value={profile.nationality ?? '—'} />
                  <Row
                    label="护照有效期"
                    value={
                      profile.passportExpiry ? (
                        <span
                          className={
                            expDays !== null && expDays < PASSPORT_EXPIRY_WARN_DAYS
                              ? expDays < 0
                                ? 'text-red-600 font-medium'
                                : 'text-amber-600 font-medium'
                              : ''
                          }
                        >
                          {fmtDate(profile.passportExpiry)}
                          {expDays !== null && expDays >= 0 && expDays < PASSPORT_EXPIRY_WARN_DAYS && ` （${expDays} 天后到期）`}
                          {expDays !== null && expDays < 0 && ' （已过期）'}
                        </span>
                      ) : (
                        '—'
                      )
                    }
                  />
                </dl>
              </section>

              {/* 偏好 */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">偏好</h3>
                <dl className="space-y-1">
                  <Row label="舱位" value={profile.prefCabin ? CABIN_LABELS[profile.prefCabin] ?? profile.prefCabin : '—'} />
                  <Row label="床型" value={profile.prefBed ? BED_LABELS[profile.prefBed] ?? profile.prefBed : '—'} />
                  <Row label="餐食" value={profile.prefMeal ?? '—'} />
                  <Row label="住宿" value={profile.prefSingleRoom ? '单住（不拼房）' : '可拼房'} />
                  {profile.needsWheelchair && <Row label="特殊需求" value="♿ 需要轮椅" />}
                </dl>
              </section>

              {/* 出行记录 */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">
                  出行记录（{trips.length} 单）
                </h3>
                <ul className="space-y-2">
                  {trips.map((t) => (
                    <li key={t.orderId} className="rounded border border-slate-200 p-2.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-900">
                          {t.departAt ? fmtDate(t.departAt) : '（无航班）'}
                          {t.route && <span className="ml-2 font-mono text-brand">{t.route}</span>}
                          {t.returnAt && <span className="ml-1 text-slate-400">～{fmtDate(t.returnAt)}</span>}
                        </span>
                        <span className={t.flown ? 'badge-neutral' : 'text-brand font-medium'}>
                          {t.departAt ? (t.flown ? '已飞' : '待出行') : '—'}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-slate-500">
                        {t.flightNumbers.length > 0 && <span>✈️ {t.flightNumbers.join(' / ')}</span>}
                        {t.cabin && <span>{CABIN_LABELS[t.cabin] ?? t.cabin}</span>}
                        <span>同行 {t.paxCount} 人</span>
                        <span>人均 {fmtCny(t.spendShareCny)}</span>
                      </div>
                      {t.hotels.map((h, i) => (
                        <div key={i} className="mt-1 text-slate-500">
                          🏨 {h.hotelName}
                          {h.roomType && ` · ${h.roomType}`}
                          {h.checkIn && ` · ${h.checkIn}${h.checkOut ? `→${h.checkOut}` : ''}`}
                        </div>
                      ))}
                      <div className="mt-1">
                        <Link
                          className="text-brand hover:text-brand-dark"
                          to={`/orders?q=${encodeURIComponent(t.orderNumber)}`}
                        >
                          {t.orderNumber} →
                        </Link>
                      </div>
                    </li>
                  ))}
                  {trips.length === 0 && <li className="text-ink-muted">暂无有效订单</li>}
                </ul>
              </section>

              {/* 同行人 */}
              {profile.companions.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">常同行</h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {profile.companions.map((c) => (
                      <li key={`${c.documentType}|${c.documentNumber}`}>
                        <button
                          className="badge-neutral hover:text-brand"
                          title={`共同出行 ${c.tripsTogether} 单 · 点击查看`}
                          onClick={() => onSearchCompanion(c.documentNumber)}
                        >
                          {c.fullName} ×{c.tripsTogether}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* 备注 */}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">运营备注</h3>
                <textarea
                  className="input"
                  rows={3}
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  placeholder="例如：素食 / 晕机 / 只住高层 / 服务提示（重建档案不会覆盖）"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button className="btn-primary text-xs" onClick={saveNotes} disabled={savingNotes}>
                    {savingNotes ? '保存中…' : '保存备注'}
                  </button>
                  {notesSaved && <span className="text-xs text-emerald-600">已保存</span>}
                </div>
              </section>

              {/* 合并档案（换发新护照等场景：把本档案并入新证件档案） */}
              <MergeSection profile={profile} onMerged={onMerged} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 合并目标联想的 debounce 间隔 */
const MERGE_SUGGEST_DEBOUNCE_MS = 300;
/** 合并目标联想触发的最小查询长度（与后端 suggest 口径一致） */
const MERGE_SUGGEST_MIN_QUERY = 2;

/**
 * 合并档案（折叠次要区块）：搜索联想目标档案 → 选中 → 红字确认 → 调 merge 接口。
 * 方向：当前抽屉这份是被并入方（旧证），选中的目标是保留方（新证）。
 */
function MergeSection({ profile, onMerged }: { profile: TravelerProfile; onMerged: () => void }) {
  const tokens = useAuth((s) => s.tokens);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<TravelerProfileSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<TravelerProfileSuggestion | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // 请求竞态防护：旧响应不覆盖新输入的结果
  const seqRef = useRef(0);

  useEffect(() => {
    if (!expanded || !tokens?.accessToken) return;
    const q = query.trim();
    if (q.length < MERGE_SUGGEST_MIN_QUERY) {
      setCandidates([]);
      setSearching(false);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .suggestTravelerProfiles(tokens.accessToken, q)
        .then((r) => {
          if (seq !== seqRef.current) return;
          // 不能选自己（自并后端也会 400，前端直接不给选项）
          setCandidates(r.suggestions.filter((s) => s.id !== profile.id));
        })
        .catch(() => {
          if (seq === seqRef.current) setCandidates([]);
        })
        .finally(() => {
          if (seq === seqRef.current) setSearching(false);
        });
    }, MERGE_SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [expanded, query, tokens?.accessToken, profile.id]);

  const confirmMerge = async () => {
    if (!tokens?.accessToken || !target || merging) return;
    setMerging(true);
    setMergeError(null);
    try {
      await api.mergeTravelerProfile(tokens.accessToken, profile.id, target.id);
      onMerged();
    } catch (e) {
      // 409（已被合并/目标是指针行）、400（自并）等：把后端 message 原样展示
      setMergeError(e instanceof ApiError ? e.message : '合并失败');
    } finally {
      setMerging(false);
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">合并档案</h3>
      {!expanded ? (
        <button className="btn-secondary text-xs" onClick={() => setExpanded(true)}>
          合并到其他档案…
        </button>
      ) : (
        <div className="space-y-2 rounded border border-slate-200 p-3">
          <p className="text-xs text-ink-muted">
            适用于换发新护照等场景：把本档案（旧证）并入另一份档案，出行记录合并统计。
          </p>
          <input
            className="input text-sm"
            placeholder="搜索目标档案（姓名 / 中文名 / 证件号，≥2 字符）"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTarget(null);
              setMergeError(null);
            }}
          />
          {searching && <p className="text-xs text-ink-muted">搜索中…</p>}
          {!target && candidates.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-auto">
              {candidates.map((s) => (
                <li key={s.id}>
                  <button
                    className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-left text-xs hover:border-brand hover:bg-slate-50"
                    onClick={() => {
                      setTarget(s);
                      setMergeError(null);
                    }}
                  >
                    <span className="font-mono text-brand">{s.travelerNo}</span>
                    <span className="ml-2 font-medium text-slate-900">{s.fullName}</span>
                    {s.chineseName && <span className="ml-1 text-slate-500">（{s.chineseName}）</span>}
                    <span className="mt-0.5 block text-slate-500">
                      {DOC_LABELS[s.documentType] ?? s.documentType}{' '}
                      <span className="font-mono">{s.documentNumber}</span> · 飞过 {s.tripCount} 次
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!target && !searching && query.trim().length >= MERGE_SUGGEST_MIN_QUERY && candidates.length === 0 && (
            <p className="text-xs text-ink-muted">没有可选的目标档案</p>
          )}
          {target && (
            <div className="space-y-2 rounded border border-red-200 bg-red-50 p-3">
              <p className="text-xs font-medium text-red-700">
                将把 {profile.travelerNo} 并入 {target.travelerNo}（{target.fullName} ·{' '}
                {DOC_LABELS[target.documentType] ?? target.documentType} {target.documentNumber}），
                当前号变为旧证指针，操作不可撤销。
              </p>
              <div className="flex items-center gap-2">
                <button
                  className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  onClick={confirmMerge}
                  disabled={merging}
                >
                  {merging ? '合并中…' : '确认合并'}
                </button>
                <button className="btn-secondary text-xs" onClick={() => setTarget(null)} disabled={merging}>
                  重新选择
                </button>
              </div>
            </div>
          )}
          {mergeError && <p className="text-xs text-red-600">{mergeError}</p>}
          <button
            className="text-xs text-ink-muted hover:text-ink"
            onClick={() => {
              setExpanded(false);
              setQuery('');
              setTarget(null);
              setCandidates([]);
              setMergeError(null);
            }}
          >
            收起
          </button>
        </div>
      )}
    </section>
  );
}

function MiniStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded bg-slate-50 p-2 text-center">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold nums ${highlight ? 'text-brand' : 'text-slate-900'}`}>{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{value}</dd>
    </div>
  );
}
