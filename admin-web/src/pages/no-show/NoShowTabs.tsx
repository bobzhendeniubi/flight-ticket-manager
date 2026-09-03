/**
 * no-show 模块的页签条（处理页 / 报表页共用）。
 * 两个页面是两条独立路由，页签只负责让它们看起来是一个模块。
 * 样式沿用产品/代理页的页签处理（-mb-px + border-b-2），不另起一套。
 */
import { NavLink } from 'react-router-dom';

const TABS: Array<{ to: string; label: string; end: boolean }> = [
  // end=true：/no-show/report 时不让「处理名单」也高亮
  { to: '/no-show', label: '处理名单', end: true },
  { to: '/no-show/report', label: '报表', end: false },
];

export function NoShowTabs() {
  return (
    <nav className="flex items-center gap-1 border-b border-slate-200" aria-label="no-show 模块">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `-mb-px border-b-2 px-4 py-2.5 text-sm transition ${
              isActive
                ? 'border-brand font-semibold text-brand'
                : 'border-transparent text-ink-soft hover:border-slate-300 hover:text-ink'
            }`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
