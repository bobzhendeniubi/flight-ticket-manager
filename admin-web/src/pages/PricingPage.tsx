/**
 * 动态定价 — 拉真后端的 QH9588/QH9589 班次，叠加本地 mock 的等级倍率 + ML 需求。
 * 业务背景：澳门→岘港，定价基础是 FlightSeatClass.basePrice。
 *
 * 顶部 DateRankingCalendar = 真 API（/pricing/date-rankings），admin 可点单元格改等级；
 * 底部班次定价视图仍是 mock（per-flight 可视化），不写回 DB。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AdminFlight, type AdminSchedule } from '../lib/api';
import { DEFAULT_TIERS, generatePriceHistory } from '../lib/mockData';
import { airportLabel, formatLocalDate } from '../lib/airports';
import { useAuth } from '../stores/auth';

interface PricingSchedule {
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  date: string; // 出发本地日期
  basePrice: number; // 经济舱基础价
  currentMultiplier: number;
  currentTier: 'A' | 'B' | 'C' | 'D';
  loadFactor: number;
  mlDemand: number;
}

const TIER_MULT = { A: 1.5, B: 1.2, C: 1.0, D: 0.8 } as const;

/** 简单的 demo 等级规则：周末/周一为高峰，工作日为平峰 */
function pickTier(date: Date, offset: number): 'A' | 'B' | 'C' | 'D' {
  const dow = date.getDay(); // 0=Sun
  if (offset === 0 || offset === 7) return 'A'; // 模拟"今天/下周同一天"是节假日
  if (dow === 5 || dow === 0) return 'B';
  if (dow === 6 || dow === 1) return 'C';
  return 'D';
}

export function PricingPage() {
  const tokens = useAuth((s) => s.tokens);
  const [schedules, setSchedules] = useState<PricingSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [tiers, setTiers] = useState(DEFAULT_TIERS);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tokens) {
      setLoading(false);
      return;
    }
    try {
      const r = await api.listAllFlights(tokens.accessToken);
      const allSchedules: PricingSchedule[] = [];
      const now = Date.now();
      const horizon = now + 7 * 86400000; // 未来 7 天
      await Promise.all(
        r.flights.map(async (f: AdminFlight) => {
          const s = await api.listSchedules(tokens.accessToken, f.id);
          for (const sch of s.schedules as AdminSchedule[]) {
            const t = new Date(sch.departureTime).getTime();
            if (t < now || t > horizon) continue;
            const econ = sch.seatClasses.find((c) => c.cabin === 'ECONOMY');
            if (!econ) continue;
            const totalCap = sch.seatClasses.reduce((sum, c) => sum + c.capacity, 0);
            const totalSold = sch.seatClasses.reduce((sum, c) => sum + c.sold, 0);
            const offset = Math.round((t - now) / 86400000);
            const tier = pickTier(new Date(sch.departureTime), offset);
            allSchedules.push({
              id: sch.id,
              flightNumber: f.flightNumber,
              origin: f.originCode,
              dest: f.destinationCode,
              date: formatLocalDate(sch.departureTime, sch.departureTz),
              basePrice: Number(econ.basePrice),
              currentTier: tier,
              currentMultiplier: TIER_MULT[tier],
              loadFactor: totalCap > 0 ? totalSold / totalCap : 0,
              mlDemand: 1 + Math.sin(offset) * 0.15 + 0.05,
            });
          }
        }),
      );
      allSchedules.sort((a, b) => a.date.localeCompare(b.date));
      setSchedules(allSchedules);
      // 只在「还没选中」或「之前选中的不在新列表里」时，才回退到第一条
      setSelectedId((prev) => {
        if (allSchedules.length === 0) return '';
        if (prev && allSchedules.some((s) => s.id === prev)) return prev;
        return allSchedules[0].id;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tokens]);

  useEffect(() => {
    load();
  }, [load]);

  // 严格按 selectedId 找；找不到不要静默 fallback，避免左侧高亮和右侧详情不同步
  const selected = schedules.find((s) => s.id === selectedId) ?? null;
  const history = useMemo(
    () => (selected ? generatePriceHistory(selected.basePrice) : []),
    [selected],
  );

  if (error) return <div className="card border-red-200 bg-red-50 text-red-700">{error}</div>;
  if (loading) return <div className="card text-slate-500">加载中…</div>;
  if (schedules.length === 0) return <div className="card text-slate-500">未来 7 天没有班次</div>;
  if (!selected) {
    return (
      <div className="card text-slate-500">
        请从左侧列表选择一个班次查看定价配置
      </div>
    );
  }

  const finalPrice = Math.round(selected.basePrice * selected.currentMultiplier * selected.mlDemand);

  return (
    <div className="space-y-5">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">动态定价</h1>
        <p className="mt-1 text-sm text-slate-600">
          基于时段 / 上座率 / ML 需求预测的 ABCD 等级定价引擎。当前 demo 数据：QH9588/9589 未来 7 天班次。
        </p>
      </section>

      <DateRankingCalendar />


      <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* 班次列表 */}
        <div className="card p-0 overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium uppercase text-slate-500">
            未来 7 天班次（{schedules.length} 个）
          </div>
          <ul className="divide-y divide-slate-100 max-h-[560px] overflow-auto">
            {schedules.map((s) => {
              const isSel = s.id === selectedId;
              return (
                <li key={s.id}>
                  <button
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full px-4 py-3 text-left transition ${
                      isSel ? 'bg-brand/10' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-900">{s.flightNumber}</span>
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tierBadgeColor(s.currentTier)}`}>
                        {s.currentTier}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      {s.origin} → {s.dest}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-xs text-slate-500">
                      <span>{s.date}</span>
                      <span>上座率 {Math.round(s.loadFactor * 100)}%</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 右侧详情 */}
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  {selected.flightNumber} · {airportLabel(selected.origin)} → {airportLabel(selected.dest)}
                </h2>
                <p className="mt-0.5 text-sm text-slate-600">出发日期 {selected.date}</p>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">当前建议售价</div>
                <div className="text-3xl font-bold text-red-600">¥{finalPrice}</div>
                <div className="text-xs text-slate-500">基础价 ¥{selected.basePrice}</div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-4">
              <Metric
                label="当前等级"
                value={<span className={`rounded px-2 py-0.5 font-mono ${tierBadgeColor(selected.currentTier)}`}>{selected.currentTier}</span>}
                sub={`倍率 ×${selected.currentMultiplier.toFixed(2)}`}
              />
              <Metric
                label="上座率"
                value={`${Math.round(selected.loadFactor * 100)}%`}
                sub={selected.loadFactor > 0.7 ? '⚠ 接近满舱' : selected.loadFactor < 0.3 ? '空舱较多' : '运行正常'}
              />
              <Metric
                label="ML 需求预测"
                value={`×${selected.mlDemand.toFixed(3)}`}
                sub="Prophet 模型 · mock"
              />
              <Metric label="最终售价" value={`¥${finalPrice}`} sub="基础 × 等级 × 需求" />
            </div>
          </div>

          {/* ABCD 等级配置 */}
          <div className="card">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-900">ABCD 等级配置</h3>
              <button
                className="btn-primary text-sm"
                onClick={() => setSavedAt(new Date().toLocaleTimeString('zh-CN'))}
              >
                保存调整
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              拖动倍率调节各等级的加价幅度，保存后对后续班次立即生效。
            </p>
            <div className="mt-4 space-y-4">
              {tiers.map((t, idx) => (
                <div key={t.tier} className="grid grid-cols-[auto_1fr_auto] items-center gap-4">
                  <span className={`rounded px-2 py-1 text-sm font-bold ${tierBadgeColor(t.tier)}`}>{t.tier}</span>
                  <div>
                    <div className="font-medium text-slate-900">{t.label}</div>
                    <div className="text-xs text-slate-500">{t.description}</div>
                    <input
                      type="range"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={t.multiplier}
                      onChange={(e) => {
                        const next = [...tiers];
                        next[idx] = { ...t, multiplier: Number(e.target.value) };
                        setTiers(next);
                        setSavedAt(null);
                      }}
                      className="mt-2 w-full"
                    />
                  </div>
                  <div className="w-20 text-right">
                    <div className="text-lg font-bold text-slate-900">×{t.multiplier.toFixed(2)}</div>
                    <div className="text-xs text-slate-500">¥{Math.round(selected.basePrice * t.multiplier)}</div>
                  </div>
                </div>
              ))}
            </div>
            {savedAt && (
              <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
                ✅ 已保存（demo） · {savedAt}
              </div>
            )}
          </div>

          {/* 价格历史 */}
          <div className="card">
            <h3 className="font-semibold text-slate-900">近 14 天实际售价</h3>
            <p className="mt-1 text-xs text-slate-500">每个柱子代表一天的平均售价，颜色对应触发的等级。</p>
            <div className="mt-4 flex items-end gap-1 h-40">
              {history.map((h) => {
                const max = Math.max(...history.map((x) => x.price));
                return (
                  <div key={h.date} className="flex-1 flex flex-col items-center gap-1">
                    <div className="text-[10px] text-slate-500">{h.price}</div>
                    <div
                      className={`w-full rounded-t ${tierBarColor(h.tier)}`}
                      style={{ height: `${(h.price / max) * 80}%` }}
                      title={`${h.date} · ¥${h.price} · ${h.tier}`}
                    />
                    <div className="text-[9px] text-slate-500">{h.date.slice(5)}</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex gap-3 text-xs">
              {(['A', 'B', 'C', 'D'] as const).map((t) => (
                <span key={t} className="flex items-center gap-1">
                  <span className={`inline-block h-3 w-3 rounded ${tierBarColor(t)}`} />
                  {t} 等级
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

function tierBadgeColor(tier: 'A' | 'B' | 'C' | 'D') {
  switch (tier) {
    case 'A': return 'bg-red-100 text-red-700';
    case 'B': return 'bg-amber-100 text-amber-700';
    case 'C': return 'bg-blue-100 text-blue-700';
    case 'D': return 'bg-green-100 text-green-700';
  }
}

function tierBarColor(tier: 'A' | 'B' | 'C' | 'D') {
  switch (tier) {
    case 'A': return 'bg-red-400';
    case 'B': return 'bg-amber-400';
    case 'C': return 'bg-blue-400';
    case 'D': return 'bg-green-400';
  }
}

// ─────────────────────────────────────────────────────────────────
// DateRankingCalendar — 真 API 驱动的日期等级日历
//   - 显示从今天起 90 天（13 周 × 7 列 = ~90 个方块）
//   - 点单元格 → 弹小菜单改 A/B/C/D 或 reset-to-default
//   - DB override 有粗边框 + 小圆点标记
// ─────────────────────────────────────────────────────────────────

type Rank = 'A' | 'B' | 'C' | 'D';

interface RankingCell {
  date: string;
  rank: Rank;
  reason: string | null;
  isManual: boolean;
  source: 'db' | 'default';
}

const RANK_MULT: Record<Rank, number> = { A: 1.5, B: 1.2, C: 1.0, D: 0.8 };

function DateRankingCalendar() {
  const tokens = useAuth((s) => s.tokens);
  const [rows, setRows] = useState<RankingCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // YYYY-MM-DD being edited

  // 区间：今天 → 今天+90 天
  const { fromDate, toDate } = useMemo(() => {
    const f = new Date();
    f.setUTCHours(0, 0, 0, 0);
    const t = new Date(f.getTime() + 90 * 86400000);
    return {
      fromDate: f.toISOString().slice(0, 10),
      toDate: t.toISOString().slice(0, 10),
    };
  }, []);

  const load = useCallback(async () => {
    if (!tokens) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listDateRankings(tokens.accessToken, fromDate, toDate);
      setRows(r.rankings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tokens, fromDate, toDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const onOverride = async (date: string, rank: Rank) => {
    if (!tokens) return;
    try {
      await api.overrideDateRanking(tokens.accessToken, date, { rank });
      setEditing(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败');
    }
  };

  const onReset = async (date: string) => {
    if (!tokens) return;
    if (!confirm(`重置 ${date} 为默认（按星期几）？`)) return;
    try {
      await api.resetDateRanking(tokens.accessToken, date);
      setEditing(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : '重置失败');
    }
  };

  if (loading) return <div className="card text-slate-500">日期等级加载中…</div>;
  if (err) return <div className="card border-red-200 bg-red-50 text-red-700">{err}</div>;
  if (rows.length === 0) return null;

  // 按周分组显示：每行 7 个 = 一周
  const weeks: RankingCell[][] = [];
  for (let i = 0; i < rows.length; i += 7) weeks.push(rows.slice(i, i + 7));

  const manualCount = rows.filter((r) => r.isManual).length;

  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">日期等级日历（未来 90 天）</h2>
          <p className="mt-1 text-xs text-slate-500">
            点击任一单元格可手动覆盖当日等级。A×1.5 / B×1.2 / C×1.0 / D×0.8 —
            修改后前台 /flights/price 立即生效。
            <br />
            <span className="text-slate-400">
              共 {rows.length} 天，其中 {manualCount} 天被手动覆盖（有蓝色小点）。
            </span>
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <LegendDot rank="A" /> <LegendDot rank="B" /> <LegendDot rank="C" /> <LegendDot rank="D" />
        </div>
      </div>

      <div className="mt-4 space-y-1">
        {weeks.map((wk, wi) => (
          <div key={wi} className="grid grid-cols-7 gap-1">
            {wk.map((c) => (
              <RankCell
                key={c.date}
                cell={c}
                isEditing={editing === c.date}
                onClick={() => setEditing(editing === c.date ? null : c.date)}
                onPick={(rank) => onOverride(c.date, rank)}
                onReset={() => onReset(c.date)}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function RankCell({
  cell, isEditing, onClick, onPick, onReset,
}: {
  cell: RankingCell;
  isEditing: boolean;
  onClick: () => void;
  onPick: (rank: Rank) => void;
  onReset: () => void;
}) {
  const d = new Date(cell.date);
  const dayNum = d.getUTCDate();
  const dow = d.getUTCDay();
  const dowLabel = ['日', '一', '二', '三', '四', '五', '六'][dow];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left rounded p-1.5 text-xs transition
          ${tierBadgeColor(cell.rank)}
          ${cell.isManual ? 'ring-2 ring-slate-900/60' : 'ring-1 ring-transparent'}
          hover:scale-[1.02] hover:ring-slate-400`}
        title={`${cell.date} ${dowLabel} · ${cell.reason ?? ''}`}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] opacity-70">{dowLabel}</span>
          <span className="font-bold text-sm">{cell.rank}</span>
        </div>
        <div className="mt-0.5 flex items-end justify-between">
          <span className="text-[10px] font-semibold">{dayNum}</span>
          <span className="text-[9px] opacity-60">×{RANK_MULT[cell.rank]}</span>
        </div>
        {cell.isManual && (
          <span className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-blue-600" />
        )}
      </button>
      {isEditing && (
        <div
          className="absolute top-full left-0 z-10 mt-1 w-36 rounded-md border border-slate-300 bg-white p-1 text-xs shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1 text-slate-500 text-[10px]">
            改 {cell.date} 为：
          </div>
          {(['A', 'B', 'C', 'D'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onPick(r)}
              className={`block w-full text-left rounded px-2 py-1 hover:bg-slate-100
                ${cell.rank === r ? 'font-bold' : ''}`}
            >
              <span className={`inline-block w-5 rounded text-center ${tierBadgeColor(r)}`}>{r}</span>
              <span className="ml-2">×{RANK_MULT[r]}</span>
            </button>
          ))}
          {cell.isManual && (
            <>
              <hr className="my-1 border-slate-200" />
              <button
                type="button"
                onClick={onReset}
                className="block w-full text-left rounded px-2 py-1 text-red-600 hover:bg-red-50"
              >
                重置为默认
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LegendDot({ rank }: { rank: Rank }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-medium ${tierBadgeColor(rank)}`}>
      {rank} ×{RANK_MULT[rank]}
    </span>
  );
}

