import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * 空状态（对标 Klook/携程 列表/搜索无结果）。
 * 居中友好图标 + 标题 + 提示 + 可选操作按钮。
 * 纯展示：内容与操作走 props（action 由调用方传入按钮/链接）。
 */
export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = 'search', title, hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand">
        <Icon name={icon} className="h-7 w-7" />
      </span>
      <div className="space-y-1">
        <h3 className="text-base font-bold text-ink">{title}</h3>
        {hint && <p className="mx-auto max-w-xs text-sm text-ink-soft">{hint}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
