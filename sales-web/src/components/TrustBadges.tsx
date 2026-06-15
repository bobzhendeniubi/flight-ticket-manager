import { Icon, type IconName } from './Icon';

/**
 * 信任标识条（对标 Klook/携程 结算页/卡片的安心保障）。
 * variant='checkout' 横排大尺寸（结算页底部）；'card' 紧凑两列（产品卡内）。
 * 纯展示，无 props 数据依赖，克制不喧宾夺主。
 */
export interface TrustBadgesProps {
  variant?: 'checkout' | 'card';
}

interface TrustCue {
  icon: IconName;
  label: string;
}

const CUES: TrustCue[] = [
  { icon: 'shield', label: '安全支付 · 信息加密' },
  { icon: 'check', label: '出发前 7 天可退' },
  { icon: 'support', label: '7×24 中文客服' },
  { icon: 'visa', label: '正规持牌经营' },
];

export function TrustBadges({ variant = 'checkout' }: TrustBadgesProps) {
  if (variant === 'card') {
    return (
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-ink-soft">
        {CUES.map((c) => (
          <li key={c.label} className="flex items-center gap-1.5">
            <Icon name={c.icon} className="h-3.5 w-3.5 shrink-0 text-brand" />
            <span className="truncate">{c.label}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5 rounded-2xl border border-slate-200/80 bg-canvas px-4 py-3">
      {CUES.map((c) => (
        <li key={c.label} className="flex items-center gap-2 text-sm font-medium text-ink-soft">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand">
            <Icon name={c.icon} className="h-4 w-4" />
          </span>
          {c.label}
        </li>
      ))}
    </ul>
  );
}
