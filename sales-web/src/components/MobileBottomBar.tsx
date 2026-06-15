import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';
import { Icon, type IconName } from './Icon';
import { Modal } from './Modal';

/**
 * 手机端底部导航条（≤768px 显示）— 套餐 / 机票 / 购物车（带数量）/ 我的 / 更多。
 * 顶部购物车按钮在手机端隐藏，购物车入口收到这里（非技术用户拇指可达）。
 *
 * E3：原来只有 4 个一级 tab（套餐/机票/购物车/订单），酒店/接送/签证 在手机端没入口。
 * 加第 5 个「更多」tab，点开一个底部弹层（复用 Modal），里面放 酒店/接送/签证/查订单/帮助，
 * 既不挤占主 tab，又让全部品类可被发现。5 列在 390px 下排得开（每列约 78px）。
 */

interface BarTab {
  to: string;
  label: string;
  icon: IconName;
  exact: boolean;
  badge?: number;
}

interface MoreLink {
  to: string;
  label: string;
  icon: IconName;
  desc: string;
}

const MORE_LINKS: MoreLink[] = [
  { to: '/hotels', label: '酒店', icon: 'hotel', desc: '海景 / 市区精选酒店' },
  { to: '/transfers', label: '接送机', icon: 'car', desc: '澳门 ⇌ 机场专车接送' },
  { to: '/visas', label: '签证', icon: 'visa', desc: '越南签证代办' },
  { to: '/lookup', label: '查订单', icon: 'search', desc: '免登录凭订单号查询' },
  { to: '/help', label: '帮助中心', icon: 'support', desc: '常见问题 / 退改 / 联系客服' },
];

export function MobileBottomBar() {
  const count = useCart((s) => s.items.reduce((sum, i) => sum + i.qty, 0));
  const user = useAuth((s) => s.user);
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);

  // 「更多」里的任一品类页处于激活态时，「更多」tab 也点亮（让用户知道当前在哪儿）。
  const isMoreActive = MORE_LINKS.some((l) => location.pathname.startsWith(l.to));

  const tabs: BarTab[] = [
    // 套餐落地页即首页（运营要求默认首屏）
    { to: '/', label: '套餐', icon: 'package', exact: true },
    { to: '/flights', label: '机票', icon: 'plane', exact: false },
    { to: '/cart', label: '购物车', icon: 'cart', exact: false, badge: count },
    user
      ? { to: '/orders', label: '订单', icon: 'ticket', exact: false }
      : { to: '/login', label: '登录', icon: 'user', exact: false },
  ];

  const tabBase =
    'relative flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] transition-colors';
  const activeTab =
    "text-brand-700 font-semibold after:absolute after:left-1/2 after:top-0 after:h-0.5 after:w-8 after:-translate-x-1/2 after:rounded-full after:bg-brand after:content-['']";
  const idleTab = 'text-ink-muted hover:text-ink-soft';

  return (
    <>
      <nav
        aria-label="底部导航"
        className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-brand-100/70 bg-surface/90 shadow-pop backdrop-blur-xl pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-5">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.exact}
              className={({ isActive }) => `${tabBase} ${isActive ? activeTab : idleTab}`}
            >
              <span className="relative leading-none">
                <Icon name={t.icon} className="h-5 w-5" />
                {t.badge ? (
                  <span className="absolute -right-3.5 -top-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-deal px-1 text-[10px] font-bold text-white shadow-deal nums">
                    {t.badge > 99 ? '99+' : t.badge}
                  </span>
                ) : null}
              </span>
              <span className="text-[10px] sm:text-[11px]">{t.label}</span>
            </NavLink>
          ))}

          {/* 第 5 个 tab：更多 —— 打开底部弹层，发现酒店/接送/签证/查订单/帮助 */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={`${tabBase} ${isMoreActive ? activeTab : idleTab}`}
          >
            <span className="leading-none">
              <Icon name="menu" className="h-5 w-5" />
            </span>
            <span className="text-[10px] sm:text-[11px]">更多</span>
          </button>
        </div>
      </nav>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="更多服务" size="sm">
        <ul className="divide-y divide-slate-200/70">
          {MORE_LINKS.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                onClick={() => setMoreOpen(false)}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-brand-50/60"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                  <Icon name={link.icon} className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-ink">{link.label}</span>
                  <span className="block truncate text-xs text-ink-soft">{link.desc}</span>
                </span>
                <Icon name="arrowRight" className="h-4 w-4 shrink-0 text-ink-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
