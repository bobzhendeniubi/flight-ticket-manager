import { StarRating } from './StarRating';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

/**
 * 评价列表（对标 Klook/携程 单条评价卡）。
 * 头像首字母 + 脱敏昵称 + 星行 + 已预订/出行类型 chip + 正文 + 商家回复 + 相对时间。
 * loading → 骨架；空 → EmptyState。
 * 纯展示：reviews 走 props，不引 api。
 */
export interface ReviewItem {
  id: string;
  rating: number;
  title?: string;
  body: string;
  authorName: string;
  verified: boolean;
  tripType?: string;
  reply?: string;
  /** ISO-8601，如 "2026-05-01T08:00:00Z" */
  createdAt: string;
}

export interface ReviewListProps {
  reviews: ReviewItem[];
  loading?: boolean;
  emptyHint?: string;
}

const SKELETON_ROWS = 3;

/** 脱敏昵称：保留首字符，其余以 * 替代（如「王*生」「Wa***」）。 */
function maskName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '匿名用户';
  if (trimmed.length <= 1) return `${trimmed}*`;
  if (trimmed.length === 2) return `${trimmed[0]}*`;
  return `${trimmed[0]}${'*'.repeat(Math.min(3, trimmed.length - 2))}${trimmed[trimmed.length - 1]}`;
}

/** 相对时间（zh-CN）：今天 / N 天前 / N 个月前 / yyyy-mm-dd。 */
function relativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const diffMs = Date.now() - then.getTime();
  const day = 86_400_000;
  const days = Math.floor(diffMs / day);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return then.toISOString().slice(0, 10);
}

function ReviewSkeleton() {
  return (
    <div className="card animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="skeleton h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton h-2.5 w-16" />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-4/5" />
      </div>
    </div>
  );
}

export function ReviewList({ reviews, loading, emptyHint }: ReviewListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <ReviewSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <EmptyState
        icon="star"
        title="暂时还没有评价"
        hint={emptyHint ?? '成为第一个分享真实体验的人吧'}
      />
    );
  }

  return (
    <ul className="space-y-3">
      {reviews.map((r) => {
        const initial = (r.authorName.trim()[0] ?? '匿').toUpperCase();
        return (
          <li key={r.id} className="card">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-bold text-brand-700">
                  {initial}
                </span>
                <div>
                  <p className="text-sm font-bold text-ink">{maskName(r.authorName)}</p>
                  <StarRating value={r.rating} size="sm" />
                </div>
              </div>
              <time className="nums shrink-0 text-xs text-ink-muted" dateTime={r.createdAt}>
                {relativeTime(r.createdAt)}
              </time>
            </div>

            {(r.verified || r.tripType) && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {r.verified && (
                  <span className="badge-soft">
                    <Icon name="check" className="h-3 w-3" />
                    已预订
                  </span>
                )}
                {r.tripType && (
                  <span className="chip">
                    <Icon name="user" className="h-3 w-3" />
                    {r.tripType}
                  </span>
                )}
              </div>
            )}

            {r.title && <h4 className="mt-3 text-sm font-bold text-ink">{r.title}</h4>}
            <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-ink-soft">
              {r.body}
            </p>

            {r.reply && (
              <div className="mt-3 rounded-xl border border-brand-100 bg-brand-50/50 p-3">
                <p className="flex items-center gap-1.5 text-xs font-bold text-brand-700">
                  <Icon name="support" className="h-3.5 w-3.5" />
                  商家回复
                </p>
                <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-ink-soft">
                  {r.reply}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
