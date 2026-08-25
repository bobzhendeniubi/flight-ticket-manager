import { useState } from 'react';
import type { DashboardWeeklyPoint } from '../../lib/api';

const VIEWBOX_WIDTH = 720;
const VIEWBOX_HEIGHT = 280;
const PLOT_LEFT = 58;
const PLOT_RIGHT = 16;
const PLOT_TOP = 24;
const PLOT_BOTTOM = 238;

function formatAxisRevenue(value: number): string {
  const thousands = value / 1000;
  const digits = thousands >= 10 || Number.isInteger(thousands) ? 0 : 1;
  return `¥${thousands.toFixed(digits).replace(/\.0$/, '')}k`;
}

function formatDateLabel(date: string): string {
  return date.length >= 10 ? date.slice(5, 10) : date;
}

function formatFullDate(date: string): string {
  return date.length >= 10 ? date.slice(0, 10) : date;
}

export function WeeklyRevenueChart({ data }: { data: DashboardWeeklyPoint[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (data.length === 0) {
    return <div className="flex h-64 items-center justify-center text-sm text-ink-muted">暂无数据</div>;
  }

  const points = data.map((point) => ({
    ...point,
    revenue: Number.isFinite(point.revenue) ? Math.max(0, point.revenue) : 0,
    orders: Number.isFinite(point.orders) ? Math.max(0, point.orders) : 0,
  }));
  const plotWidth = VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const maxRevenue = Math.max(...points.map((point) => point.revenue), 0);
  const revenueScaleMax = maxRevenue || 1;
  const maxOrders = Math.max(...points.map((point) => point.orders), 1);
  const averageRevenue = points.reduce((sum, point) => sum + point.revenue, 0) / points.length;
  const step = plotWidth / points.length;
  const barWidth = Math.min(step * 0.58, 64);
  const yTicks = maxRevenue === 0 ? [0] : [maxRevenue, maxRevenue / 2, 0];
  const pointX = (index: number) => PLOT_LEFT + step * (index + 0.5);
  const revenueY = (revenue: number) => PLOT_BOTTOM - (revenue / revenueScaleMax) * plotHeight;
  const ordersY = (orders: number) => PLOT_BOTTOM - (orders / maxOrders) * plotHeight;
  const orderLine = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${pointX(index)} ${ordersY(point.orders)}`)
    .join(' ');
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const tooltipLeft = activeIndex === null ? 50 : ((pointX(activeIndex) / VIEWBOX_WIDTH) * 100);
  const tooltipTransform = activeIndex === 0
    ? 'translateX(0)'
    : activeIndex === points.length - 1
      ? 'translateX(-100%)'
      : 'translateX(-50%)';

  const showPoint = (index: number) => setActiveIndex(index);

  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-end gap-4 text-xs text-ink-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-brand" />营收</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 bg-ink-soft" />订单量</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 border-t border-dashed border-amber-500" />日均</span>
      </div>
      <svg
        className="h-64 w-full overflow-visible"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        role="img"
        aria-label="近七天营收柱状图与订单量折线图"
      >
        {yTicks.map((tick, index) => {
          const y = PLOT_TOP + (plotHeight / 2) * index;
          return (
            <g key={tick}>
              <line x1={PLOT_LEFT} x2={VIEWBOX_WIDTH - PLOT_RIGHT} y1={y} y2={y} className="stroke-slate-200" strokeWidth="1" />
              <text x={PLOT_LEFT - 10} y={y + 4} textAnchor="end" className="fill-slate-400 text-[11px]">{formatAxisRevenue(tick)}</text>
            </g>
          );
        })}
        <line
          x1={PLOT_LEFT}
          x2={VIEWBOX_WIDTH - PLOT_RIGHT}
          y1={revenueY(averageRevenue)}
          y2={revenueY(averageRevenue)}
          className="stroke-amber-500"
          strokeDasharray="5 4"
          strokeWidth="1.5"
        />
        {points.map((point, index) => {
          const x = pointX(index);
          const height = point.revenue > 0 ? (point.revenue / revenueScaleMax) * plotHeight : 0;
          const y = PLOT_BOTTOM - height;
          return (
            <g
              key={point.date}
              role="button"
              tabIndex={0}
              aria-label={`${formatFullDate(point.date)}，营收 ¥${point.revenue.toLocaleString()}，${point.orders} 单`}
              onMouseEnter={() => showPoint(index)}
              onMouseLeave={() => setActiveIndex(null)}
              onFocus={() => showPoint(index)}
              onBlur={() => setActiveIndex(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') showPoint(index);
                if (event.key === 'Escape') setActiveIndex(null);
              }}
            >
              <rect x={x - barWidth / 2} y={y} width={barWidth} height={height} rx="4" className="fill-brand/75 transition-opacity hover:fill-brand" />
              <text x={x} y={PLOT_BOTTOM + 22} textAnchor="middle" className="fill-slate-500 text-[11px]">{formatDateLabel(point.date)}</text>
            </g>
          );
        })}
        {maxRevenue === 0 && (
          <text x={(PLOT_LEFT + VIEWBOX_WIDTH - PLOT_RIGHT) / 2} y={PLOT_TOP + plotHeight / 2} textAnchor="middle" className="fill-slate-400 text-[11px]">暂无营收</text>
        )}
        <path d={orderLine} fill="none" className="stroke-ink-soft" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => (
          <circle key={`${point.date}-orders`} cx={pointX(index)} cy={ordersY(point.orders)} r="3.5" className="fill-surface stroke-ink-soft" strokeWidth="2" pointerEvents="none" />
        ))}
        <line x1={PLOT_LEFT} x2={VIEWBOX_WIDTH - PLOT_RIGHT} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} className="stroke-slate-300" strokeWidth="1" />
      </svg>
      {activePoint && activeIndex !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-7 z-10 max-w-xs whitespace-normal break-words rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-ink shadow-pop"
          style={{ left: `${tooltipLeft}%`, transform: tooltipTransform }}
        >
          <div className="font-medium">{formatFullDate(activePoint.date)}</div>
          <div className="mt-1 nums text-ink-soft">¥{activePoint.revenue.toLocaleString()} · {activePoint.orders} 单</div>
        </div>
      )}
    </div>
  );
}
