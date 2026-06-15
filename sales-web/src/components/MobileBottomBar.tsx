import { NavLink } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';
import { Icon, type IconName } from './Icon';

/**
 * 手机端底部导航条（≤768px 显示）— 首页 / 套餐 / 购物车（带数量）/ 我的。
 * 顶部购物车按钮在手机端隐藏，购物车入口收到这里（非技术用户拇指可达）。
 */
export function MobileBottomBar() {
  const count = useCart((s) => s.items.reduce((sum, i) => sum + i.qty, 0));
  const user = useAuth((s) => s.user);

  const tabs: Array<{ to: string; label: string; icon: IconName; exact: boolean; badge?: number }> = [
    // 套餐落地页即首页（运营要求默认首屏）
    { to: '/', label: '套餐', icon: 'package', exact: true },
    { to: '/flights', label: '机票', icon: 'plane', exact: false },
    { to: '/cart', label: '购物车', icon: 'cart', exact: false, badge: count },
    user
      ? { to: '/orders', label: '订单', icon: 'ticket', exact: false }
      : { to: '/login', label: '登录', icon: 'user', exact: false },
  ];

  return (
    <nav
      aria-label="底部导航"
      className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-brand-100/70 bg-surface/90 shadow-pop backdrop-blur-xl pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid grid-cols-4">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.exact}
            className={({ isActive }) =>
              `relative flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] transition-colors ${
                isActive
                  ? "text-brand-700 font-semibold after:absolute after:left-1/2 after:top-0 after:h-0.5 after:w-8 after:-translate-x-1/2 after:rounded-full after:bg-brand after:content-['']"
                  : 'text-ink-muted hover:text-ink-soft'
              }`
            }
          >
            <span className="relative leading-none">
              <Icon name={t.icon} className="h-5 w-5" />
              {'badge' in t && t.badge ? (
                <span className="absolute -right-3.5 -top-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-deal px-1 text-[10px] font-bold text-white shadow-deal nums">
                  {t.badge > 99 ? '99+' : t.badge}
                </span>
              ) : null}
            </span>
            <span>{t.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
