import { Icon } from './Icon';

/**
 * 退改保障小徽章（对标 Klook/携程「免费取消」绿标）。
 * 默认「出发前 7 天免费取消」，文案可被 text 覆盖。
 * 纯展示。
 */
export interface RefundBadgeProps {
  text?: string;
}

export function RefundBadge({ text = '出发前 7 天免费取消' }: RefundBadgeProps) {
  return (
    <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-700">
      <Icon name="shield" className="h-3 w-3" />
      {text}
    </span>
  );
}
