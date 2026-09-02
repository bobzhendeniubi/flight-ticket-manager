import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  RANDOM_STAR_TIERS,
  randomStarTierLabel,
  type RandomStarTier,
  type RandomTierShortfall,
  type RandomTierShortfallDay,
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

function downloadCsv(data: RandomTierShortfall): void {
  const lines = [
    ['日期', '档次', '已确认包房', '已落位', '未落位', '缺口', '需向地接加房'],
    ...data.days.flatMap((day) =>
      day.tiers.map((tier) => [
        day.date,
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
  link.download = `随机档加房清单_${data.from}_${data.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function tierForDay(day: RandomTierShortfallDay, tier: RandomStarTier): RandomTierShortfallTier | null {
  return day.tiers.find((item) => item.tier === tier) ?? null;
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

  const orderedDays = useMemo(() => {
    if (!data) return [];
    return [...data.days].sort((a, b) => {
      if (a.date === today) return -1;
      if (b.date === today) return 1;
      return a.date.localeCompare(b.date);
    });
  }, [data, today]);

  const invalidRange = Boolean(from && to && from > to);

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">每日加房清单（随机档缺口）</h2>
          <p className="mt-1 max-w-5xl text-xs leading-5 text-ink-muted">
            包房只记地接已确认的房量；缺口 = 已占用 − 已确认包房，就是当天要向地接加的间数。地接确认后请到「包房周期」给真酒店切房，不要给随机档加库存。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
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
            onClick={() => { if (data) downloadCsv(data); }}
            disabled={!data || loading || invalidRange}
          >
            导出 CSV
          </button>
        </div>
      </div>

      {invalidRange && <div className="text-sm text-rose-600">起始日不能晚于截止日</div>}
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {loading && <div className="text-sm text-ink-muted">加载每日加房清单…</div>}
      {!loading && !error && data && (
        <div className="overflow-x-auto">
          <table className="min-w-[62rem] border-collapse text-sm nums">
            <thead className="text-xs text-ink-muted">
              <tr className="border-b border-slate-200">
                <th rowSpan={2} className="sticky left-0 z-10 min-w-[6.5rem] bg-white px-2 py-2 text-left font-medium">日期</th>
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
              {orderedDays.map((day) => (
                <tr key={day.date} className={day.date === today ? 'border-b border-sky-200 bg-sky-50' : 'border-b border-slate-100'}>
                  <td className="sticky left-0 z-10 bg-inherit px-2 py-2 text-left font-medium text-ink">
                    {day.date}{day.date === today && <span className="ml-1 text-[10px] text-brand">今天</span>}
                  </td>
                  {RANDOM_STAR_TIERS.flatMap((tier) => {
                    const row = tierForDay(day, tier);
                    if (!row) {
                      return [
                        <td key={`${tier}-empty-block`} className="border-l border-slate-100 px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-used`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-pending`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-shortfall`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                        <td key={`${tier}-empty-request`} className="px-2 py-2 text-right text-ink-muted">—</td>,
                      ];
                    }
                    const occupied = row.hotelUsed + row.pendingUsed;
                    return [
                      <td key={`${tier}-block`} className="border-l border-slate-100 px-2 py-2 text-right">
                        {row.hasBlock ? displayValue(row.block) : <span className="text-ink-muted">未切房</span>}
                      </td>,
                      <td key={`${tier}-used`} className="px-2 py-2 text-right text-ink-soft">{displayValue(occupied)}</td>,
                      <td key={`${tier}-pending`} className="px-2 py-2 text-right text-ink-soft">{displayValue(row.pendingUsed)}</td>,
                      <td key={`${tier}-shortfall`} className={`px-2 py-2 text-right ${cellClass(row.shortfall)}`}>{displayValue(row.shortfall)}</td>,
                      <td key={`${tier}-request`} className={`px-2 py-2 text-right ${cellClass(row.shortfall)}`}>{displayValue(row.roomsToRequest)}</td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !error && data && orderedDays.length === 0 && (
        <div className="text-sm text-ink-muted">该区间暂无数据</div>
      )}
    </section>
  );
}
