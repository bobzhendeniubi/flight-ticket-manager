import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  RANDOM_STAR_TIERS,
  randomStarTierLabel,
  type RandomStarTier,
  type RandomTierShortfall,
  type RandomTierShortfallTier,
} from '../../lib/api';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatNumber(value: number): string {
  if (Object.is(value, -0) || Number.isInteger(value)) return String(Math.round(value));
  return value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

function escapeCsv(value: string | number): string {
  return `"${String(value).replace(/"/gu, '""')}"`;
}

/** 一行 = 日期 × 城市；列 = 档次 × 5 项指标（随机档按城市圈定，两城同档是两个池子）。 */
interface CityDayRow {
  date: string;
  cityCode: string;
  cityLabel: string;
  tiers: RandomTierShortfallTier[];
}

function buildRows(data: RandomTierShortfall, cityFilter: string): CityDayRow[] {
  const rows: CityDayRow[] = [];
  for (const day of data.days) {
    for (const city of data.cities) {
      if (cityFilter && city.cityCode !== cityFilter) continue;
      const tiers = day.tiers.filter((t) => t.cityCode === city.cityCode);
      if (tiers.length === 0) continue;
      rows.push({ date: day.date, cityCode: city.cityCode, cityLabel: city.cityLabel, tiers });
    }
  }
  return rows;
}

function downloadCsv(rows: CityDayRow[], from: string, to: string, cityFilter: string): void {
  const lines = [
    ['日期', '城市', '档次', '已确认包房', '已落位', '未落位', '缺口', '需向地接加房'],
    ...rows.flatMap((row) =>
      row.tiers.map((tier) => [
        row.date,
        `${row.cityLabel}（${row.cityCode}）`,
        tier.label,
        tier.block,
        tier.hotelUsed,
        tier.pendingUsed,
        tier.shortfall,
        tier.roomsToRequest,
      ]),
    ),
  ].map((row) => row.map(escapeCsv).join(','));
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `随机档加房清单_${from}_${to}${cityFilter ? `_${cityFilter}` : ''}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function tierForRow(row: CityDayRow, tier: RandomStarTier): RandomTierShortfallTier | null {
  return row.tiers.find((item) => item.tier === tier) ?? null;
}

function displayValue(value: number): string {
  return formatNumber(value);
}

function cellClass(shortfall: number): string {
  return shortfall > 0 ? 'bg-rose-100 font-semibold text-rose-700' : 'text-ink-soft';
}

export function RandomTierShortfallPanel({ token }: { token: string }) {
  const today = useMemo(() => todayStr(), []);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(() => addDays(today, 13));
  // 城市筛选：'' = 全部城市。清单总是整份拉回来（含全部城市），筛选在本地做，
  // 城市下拉才能一直列出所有城市而不是只剩当前选中的那个。
  const [cityFilter, setCityFilter] = useState('');
  const [data, setData] = useState<RandomTierShortfall | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    if (!token || !from || !to || from > to) {
      setLoading(false);
      return () => controller.abort();
    }

    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      api
        .getRandomTierShortfall(token, from, to, controller.signal)
        .then((result) => {
          if (requestId === requestIdRef.current && !controller.signal.aborted) setData(result);
        })
        .catch((err: unknown) => {
          if (requestId !== requestIdRef.current || controller.signal.aborted) return;
          setError(err instanceof ApiError ? err.message : '随机档缺口加载失败');
        })
        .finally(() => {
          if (requestId === requestIdRef.current && !controller.signal.aborted) setLoading(false);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [from, to, token]);

  const orderedRows = useMemo(() => {
    if (!data) return [];
    // 今天置顶，其余按日期；同一天内按后端城市顺序（主营地在前）
    const cityIndex = new Map(data.cities.map((c, i) => [c.cityCode, i]));
    return buildRows(data, cityFilter).sort((a, b) => {
      if (a.date !== b.date) {
        if (a.date === today) return -1;
        if (b.date === today) return 1;
        return a.date.localeCompare(b.date);
      }
      return (cityIndex.get(a.cityCode) ?? 0) - (cityIndex.get(b.cityCode) ?? 0);
    });
  }, [data, cityFilter, today]);

  const invalidRange = Boolean(from && to && from > to);
  const multiCity = (data?.cities.length ?? 0) > 1;

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">每日加房清单（随机档缺口）</h2>
          <p className="mt-1 max-w-5xl text-xs leading-5 text-ink-muted">
            包房只记地接已确认的房量；缺口 = 已占用 − 已确认包房，就是当天要向地接加的间数。
            随机档按<strong>城市 × 星级</strong>圈定：清单按城市分条，岘港的缺口只能在岘港加房，别在别的城市加。
            地接确认后请到「包房周期」给<strong>该城市</strong>的真酒店切房，不要给随机档加库存。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">城市</label>
            <select className="input" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
              <option value="">全部城市</option>
              {(data?.cities ?? []).map((c) => (
                <option key={c.cityCode} value={c.cityCode}>
                  {c.cityLabel}（{c.cityCode}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">起始</label>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">截止</label>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button
            type="button"
            className="btn-primary px-3 py-2 text-xs"
            onClick={() => { if (data) downloadCsv(orderedRows, data.from, data.to, cityFilter); }}
            disabled={!data || loading || invalidRange}
          >
            导出 CSV
          </button>
        </div>
      </div>

      {invalidRange && <div className="text-sm text-rose-600">起始日不能晚于结束日</div>}
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {loading && <div className="text-sm text-ink-muted">加载每日加房清单…</div>}
      {!loading && !error && data && (
        <div className="overflow-x-auto">
          <table className="min-w-[68rem] border-collapse text-sm nums">
            <thead className="text-xs text-ink-muted">
              <tr className="border-b border-slate-200">
                <th rowSpan={2} className="sticky left-0 z-10 min-w-[6.5rem] bg-white px-2 py-2 text-left font-medium">日期</th>
                <th rowSpan={2} className="sticky left-[6.5rem] z-10 min-w-[6rem] bg-white px-2 py-2 text-left font-medium">城市</th>
                {RANDOM_STAR_TIERS.map((tier) => (
                  <th key={tier} colSpan={5} className="border-l border-slate-200 px-2 py-2 text-center font-semibold text-ink">
                    {randomStarTierLabel(tier)}
                  </th>
                ))}
              </tr>
              <tr className="border-b border-slate-200">
                {RANDOM_STAR_TIERS.flatMap((tier) => [
                  <th key={`${tier}-block`} className="border-l border-slate-200 px-2 py-1 text-right font-medium">已确认包房</th>,
                  <th key={`${tier}-used`} className="px-2 py-1 text-right font-medium">已占用（已落位+未落位）</th>,
                  <th key={`${tier}-pending`} className="px-2 py-1 text-right font-medium">未落位</th>,
                  <th key={`${tier}-shortfall`} className="px-2 py-1 text-right font-medium">缺口</th>,
                  <th key={`${tier}-request`} className="px-2 py-1 text-right font-medium">需向地接加房</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {orderedRows.map((row) => (
                <tr
                  key={`${row.date}-${row.cityCode}`}
                  className={row.date === today ? 'border-b border-sky-200 bg-sky-50' : 'border-b border-slate-100'}
                >
                  <td className="sticky left-0 z-10 bg-inherit px-2 py-2 text-left font-medium text-ink">
                    {row.date}{row.date === today && <span className="ml-1 text-[10px] text-brand">今天</span>}
                  </td>
                  <td className="sticky left-[6.5rem] z-10 bg-inherit px-2 py-2 text-left text-ink">
                    {row.cityLabel}
                    <span className="ml-1 text-[10px] text-ink-muted">{row.cityCode}</span>
                  </td>
                  {RANDOM_STAR_TIERS.flatMap((tier) => {
                    const cell = tierForRow(row, tier);
                    if (!cell) {
                      return [
                        <td key={`${tier}-empty-block`} className="border-l border-slate-100 px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-used`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-pending`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-shortfall`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-request`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                      ];
                    }
                    const occupied = cell.hotelUsed + cell.pendingUsed;
                    return [
                      <td key={`${tier}-block`} className="border-l border-slate-100 px-2 py-2 text-right">
                        {cell.hasBlock ? displayValue(cell.block) : <span className="text-ink-muted">未切房</span>}
                      </td>,
                      <td key={`${tier}-used`} className="px-2 py-2 text-right text-ink-soft">{displayValue(occupied)}</td>,
                      <td key={`${tier}-pending`} className="px-2 py-2 text-right text-ink-soft">{displayValue(cell.pendingUsed)}</td>,
                      <td key={`${tier}-shortfall`} className={`px-2 py-2 text-right ${cellClass(cell.shortfall)}`}>{displayValue(cell.shortfall)}</td>,
                      <td key={`${tier}-request`} className={`px-2 py-2 text-right ${cellClass(cell.shortfall)}`}>{displayValue(cell.roomsToRequest)}</td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {multiCity && !cityFilter && (
            <p className="mt-2 text-xs text-ink-muted">同一天有多个城市时各占一行；「—」= 该城市没有这一档的真酒店、也没有未落位的随机单。</p>
          )}
        </div>
      )}
      {!loading && !error && data && orderedRows.length === 0 && (
        <div className="text-sm text-ink-muted">该区间暂无数据</div>
      )}
    </section>
  );
}
