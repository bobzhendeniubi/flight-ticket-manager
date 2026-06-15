import { StarRating } from './StarRating';

/**
 * 评分概览（大平均分 + 星 + 每档占比条，对标 Klook/携程 评价区头部）。
 * 条宽用内联 style 的百分比（占比 = 该档数 / 总数）。
 * 纯展示：average / count / distribution 走 props。
 */
export type StarBucket = '5' | '4' | '3' | '2' | '1';

export interface RatingSummaryProps {
  average: number;
  count: number;
  distribution: Record<StarBucket, number>;
}

const BUCKETS: StarBucket[] = ['5', '4', '3', '2', '1'];

export function RatingSummary({ average, count, distribution }: RatingSummaryProps) {
  const total = BUCKETS.reduce((sum, b) => sum + (distribution[b] || 0), 0);

  return (
    <div className="card flex flex-col gap-5 sm:flex-row sm:items-center">
      {/* 大平均分 */}
      <div className="flex shrink-0 flex-col items-center justify-center gap-1 sm:w-36 sm:border-r sm:border-slate-200/80 sm:pr-6">
        <div className="nums text-5xl font-extrabold leading-none text-ink">
          {average.toFixed(1)}
        </div>
        <StarRating value={average} size="md" />
        <p className="nums text-xs text-ink-muted">{count} 条真实评价</p>
      </div>

      {/* 占比条 */}
      <div className="flex flex-1 flex-col gap-1.5">
        {BUCKETS.map((b) => {
          const n = distribution[b] || 0;
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          return (
            <div key={b} className="flex items-center gap-2.5 text-xs">
              <span className="nums w-6 shrink-0 text-right font-semibold text-ink-soft">
                {b} 星
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-sun transition-[width] duration-500 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="nums w-8 shrink-0 text-ink-muted">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
