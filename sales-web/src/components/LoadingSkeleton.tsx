/**
 * 加载骨架屏（对标 Klook/携程 占位态）。
 * 用全局 .skeleton 类（带 shimmer），三种常用形态：
 * - CardSkeleton：单张产品卡（图 + 标题 + 价格）
 * - ListSkeleton：N 行列表行骨架
 * - DetailSkeleton：详情页（主图 + 标题块 + 段落）
 * 纯展示，无 props 数据依赖。
 */

const DEFAULT_ROWS = 3;

export function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-surface shadow-card">
      <div className="skeleton aspect-[4/3] w-full rounded-none" />
      <div className="space-y-2.5 p-4">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
        <div className="flex items-center justify-between pt-1">
          <div className="skeleton h-5 w-20" />
          <div className="skeleton h-8 w-16 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export interface ListSkeletonProps {
  rows?: number;
}

export function ListSkeleton({ rows = DEFAULT_ROWS }: ListSkeletonProps) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-surface p-3 shadow-card"
        >
          <div className="skeleton h-16 w-20 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-2/3" />
            <div className="skeleton h-3 w-1/3" />
          </div>
          <div className="skeleton h-6 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="space-y-5">
      <div className="skeleton aspect-[16/9] w-full" />
      <div className="space-y-3">
        <div className="skeleton h-7 w-3/4" />
        <div className="skeleton h-4 w-1/2" />
      </div>
      <div className="space-y-2.5">
        <div className="skeleton h-3.5 w-full" />
        <div className="skeleton h-3.5 w-full" />
        <div className="skeleton h-3.5 w-5/6" />
        <div className="skeleton h-3.5 w-2/3" />
      </div>
    </div>
  );
}
