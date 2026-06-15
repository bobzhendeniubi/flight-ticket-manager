import { Icon } from './Icon';

/**
 * 星级评分（暖琥珀实心星，对标 Klook/携程 评分行）。
 * 半星用 clip 实现：底层灰星 + 上层裁切的金星叠加。
 * 纯展示：value/count 走 props。
 */
export type StarSize = 'sm' | 'md' | 'lg';

export interface StarRatingProps {
  value: number;
  size?: StarSize;
  showValue?: boolean;
  count?: number;
}

const STAR_PX: Record<StarSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

const TEXT_PX: Record<StarSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
};

const MAX_STARS = 5;

export function StarRating({ value, size = 'md', showValue, count }: StarRatingProps) {
  const clamped = Math.max(0, Math.min(MAX_STARS, value));
  const px = STAR_PX[size];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${clamped} 星`}>
        {Array.from({ length: MAX_STARS }, (_, i) => {
          const fill = Math.max(0, Math.min(1, clamped - i)); // 0 / 0..1 / 1
          return (
            <span key={i} className={`relative inline-block ${px}`}>
              <Icon name="star" className={`${px} text-slate-200`} />
              {fill > 0 && (
                <span
                  className="absolute inset-0 overflow-hidden"
                  style={{ width: `${fill * 100}%` }}
                >
                  <Icon name="star" className={`${px} text-sun`} />
                </span>
              )}
            </span>
          );
        })}
      </span>
      {showValue && (
        <span className={`nums font-bold text-amber-700 ${TEXT_PX[size]}`}>
          {clamped.toFixed(1)}
        </span>
      )}
      {typeof count === 'number' && (
        <span className={`nums text-ink-muted ${TEXT_PX[size]}`}>({count})</span>
      )}
    </span>
  );
}
