import { NavLink } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';

/**
 * 手机端底部导航条（≤768px 显示）— 首页 / 套餐 / 购物车（带数量）/ 我的。
 * 顶部购物车按钮在手机端隐藏，购物车入口收到这里（非技术用户拇指可达）。
 */
export function MobileBottomBar() {
  const count = useCart((s) => s.items.reduce((sum, i) => sum + i.qty, 0));
  const user = useAuth((s) => s.user);

  const tabs = [
    // 套餐落地页即首页（运营要求默认首屏）
    { to: '/', label: '套餐', emoji: '🎁', exact: true },
    { to: '/flights', label: '机票', emoji: '✈️', exact: false },
    { to: '/cart', label: '购物车', emoji: '🛒', exact: false, badge: count },
    user
      ? { to: '/orders', label: '订单', emoji: '📋', exact: false }
      : { to: '/login', label: '登录', emoji: '👤', exact: false },
  ];

  return (
    <nav
      aria-label="底部导航"
      className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid grid-cols-4">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.exact}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] ${
                isActive ? 'text-brand font-semibold' : 'text-slate-600'
              }`
            }
          >
            <span className="relative text-lg leading-none" aria-hidden>
              {t.emoji}
              {'badge' in t && t.badge ? (
                <span className="absolute -right-3.5 -top-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
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
