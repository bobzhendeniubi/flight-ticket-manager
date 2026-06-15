import { Icon, type IconName } from './Icon';

/**
 * 紧迫感小徽章（对标 Klook/携程「近期已订 / 仅剩少量」）。
 * 文案由调用方传入（text）——刻意不暴露精确库存数字，由上层决定档位措辞。
 * kind 决定配色/图标：hot=热卖(deal)、low=余量少(sun)、soldRecently=近期成交(brand)。
 * 纯展示。
 */
export type ScarcityKind = 'hot' | 'low' | 'soldRecently';

export interface ScarcityBadgeProps {
  kind: ScarcityKind;
  text: string;
}

const STYLE: Record<ScarcityKind, { className: string; icon: IconName }> = {
  hot: { className: 'bg-deal-light text-deal-dark', icon: 'sparkles' },
  low: { className: 'bg-sun-light text-amber-700', icon: 'clock' },
  soldRecently: { className: 'bg-brand-50 text-brand-700', icon: 'ticket' },
};

export function ScarcityBadge({ kind, text }: ScarcityBadgeProps) {
  const s = STYLE[kind];
  return (
    <span className={`badge ${s.className}`}>
      <Icon name={s.icon} className="h-3 w-3" />
      {text}
    </span>
  );
}
