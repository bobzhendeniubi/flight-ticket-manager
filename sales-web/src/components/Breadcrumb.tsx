import { Link } from 'react-router-dom';
import { Icon } from './Icon';

/**
 * 面包屑（对标 Klook/携程 详情页路径导航，利于 SEO 与回溯）。
 * 有 to 的项渲染 <Link>，分隔符用 arrowRight 图标，末项为当前页（aria-current）。
 * 唯一允许的路由副作用：Link 跳转（来自 props 的 to）。
 */
export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="面包屑" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-ink-soft">
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          return (
            <li key={`${item.label}-${idx}`} className="flex items-center gap-1">
              {item.to && !isLast ? (
                <Link
                  to={item.to}
                  className="rounded-md px-1 py-0.5 transition-colors hover:text-brand-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={isLast ? 'max-w-[12rem] truncate font-semibold text-ink' : 'px-1'}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && (
                <Icon name="arrowRight" className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
