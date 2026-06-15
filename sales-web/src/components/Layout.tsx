import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';
import { MobilePreviewFrame } from './MobilePreviewFrame';
import { MobileBottomBar } from './MobileBottomBar';
import { AiAssistant } from './AiAssistant';
import { Icon } from './Icon';

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

// 管理后台已拆分到 admin-web (:5174)。前台不再展示后台入口。
// /admin/* 路由仍保留可访问（向后兼容旧链接），但不在 nav 中显示。

// 桌面端导航 pill：激活态用 brand-50 底 + brand-700 字（平滑高亮），默认态柔和悬停
const navPill = (isActive: boolean) =>
  `rounded-xl px-3.5 py-1.5 font-semibold transition-all duration-200 ${
    isActive
      ? 'bg-brand-50 text-brand-700 shadow-sm'
      : 'text-ink-soft hover:bg-brand-50/60 hover:text-brand-700'
  }`;

// 手机抽屉导航项：同一套激活语义，纵向块状
const drawerItem = (isActive: boolean) =>
  `block rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
    isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-brand-50/60 hover:text-brand-700'
  }`;

export function Layout() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 主导航：用 t() 而不是硬编码文字
  // 排序按运营确认：套餐是主推，排第一（套餐-机票-酒店-用车-签证）
  const frontNav = [
    { to: '/', label: t('nav.bundles'), exact: true },
    { to: '/flights', label: t('nav.flights') },
    { to: '/hotels', label: t('nav.hotels') },
    { to: '/transfers', label: t('nav.transfers') },
    { to: '/visas', label: t('nav.visas') },
  ];

  const isAgent = user?.role === 'AGENT';
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'STAFF';

  // ?preview=mobile → 把页面包进 375×812 的手机壳，模拟小程序 UI
  // 在电脑浏览器里开演示 / 录屏 / 给客户展示效果时很方便
  const mobilePreview = searchParams.get('preview') === 'mobile';
  if (mobilePreview) {
    return <MobilePreviewFrame />;
  }

  // 手机端汉堡菜单展开状态
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const closeMenu = () => setMobileMenuOpen(false);

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      {/* 顶部：品牌 + 前台导航 + 用户菜单 */}
      <header className="glass-header sticky top-0 z-40">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-2.5 md:gap-5 md:px-4 md:py-3">
          {/* 手机端：左侧汉堡按钮 */}
          <button
            type="button"
            className="md:hidden flex h-9 w-9 items-center justify-center rounded-xl border border-ink/10 bg-white/70 text-ink-soft shadow-card transition-all duration-200 hover:border-brand/40 hover:bg-brand-50/60 hover:text-brand-700 active:scale-95"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t('nav.menu')}
          >
            <Icon name="menu" className="h-5 w-5" />
          </button>

          <Link to="/" className="group flex items-center gap-2.5 truncate" aria-label="世途旅行">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-white shadow-lift transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-3"
              style={{ backgroundImage: 'linear-gradient(135deg, #2fb6cb 0%, #0e8aa0 60%, #0a6e80 100%)' }}
            >
              <Icon name="plane" className="h-5 w-5" />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-base md:text-lg font-extrabold tracking-tight text-ink transition-colors group-hover:text-brand-700">世途旅行</span>
              <span className="hidden md:block mt-0.5 text-[11px] font-medium text-ink-muted">海岛专线 · 一站式预订</span>
            </span>
          </Link>

          {/* 桌面端：主导航 */}
          <nav className="hidden md:flex items-center gap-1 text-sm">
            {frontNav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.exact}
                className={({ isActive }) => navPill(isActive)}
              >
                {n.label}
              </NavLink>
            ))}
            {isAgent && (
              <>
                <NavLink to="/team" className={({ isActive }) => navPill(isActive)}>
                  {t('nav.team')}
                </NavLink>
                <NavLink to="/my-commissions" className={({ isActive }) => navPill(isActive)}>
                  {t('nav.commissions')}
                </NavLink>
              </>
            )}
          </nav>

          {/* 右侧用户菜单：手机端只保留购物车，其他进汉堡 */}
          <nav className="flex items-center gap-2 md:gap-2.5 text-sm">
            <a
              href="/?preview=mobile"
              className="chip hidden md:inline-flex items-center gap-1.5 transition-colors hover:bg-brand-50 hover:text-brand-700"
              title="以移动端视口预览（小程序端测试）"
            >
              <Icon name="phone" className="h-3.5 w-3.5" />
              {t('nav.miniprogramPreview')}
            </a>
            <CartButton />
            {/* 桌面端：完整用户区 */}
            {user ? (
              <div className="hidden md:flex items-center gap-2">
                <span className="mx-1 h-5 w-px bg-ink/10" aria-hidden />
                <Link to="/orders" className="rounded-xl px-3 py-1.5 font-semibold text-ink-soft transition-all duration-200 hover:bg-brand-50/60 hover:text-brand-700">
                  {t('nav.myOrders')}
                </Link>
                <Link
                  to="/me"
                  className="flex items-center gap-2 rounded-xl py-1 pl-1 pr-2 text-ink-soft transition-all duration-200 hover:bg-brand-50/60 hover:text-brand-700"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-50 text-xs font-bold text-brand-700 ring-1 ring-brand-100">
                    {(user.displayName ?? user.email ?? '').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-[9rem] truncate font-semibold">{user.displayName ?? user.email}</span>
                  <span className="badge-soft">
                    {ROLE_LABEL[user.role] ?? user.role}
                  </span>
                </Link>
                <button
                  type="button"
                  className="btn-secondary text-sm py-1.5"
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  {t('nav.logout')}
                </button>
              </div>
            ) : (
              <div className="hidden md:flex items-center gap-3">
                <Link to="/login" className="btn-primary text-sm py-1.5">
                  {t('nav.login')}
                </Link>
              </div>
            )}
          </nav>
        </div>

        {/* 手机端：汉堡菜单抽屉 */}
        {mobileMenuOpen && (
          <div className="md:hidden fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm animate-fade-in" onClick={closeMenu}>
            <div
              className="absolute left-0 top-0 h-full w-72 max-w-[82vw] bg-surface shadow-pop flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3.5">
                <span className="flex items-center gap-2 font-extrabold text-ink">
                  <span
                    aria-hidden
                    className="flex h-7 w-7 items-center justify-center rounded-xl text-white shadow-card"
                    style={{ backgroundImage: 'linear-gradient(135deg, #2fb6cb 0%, #0e8aa0 60%, #0a6e80 100%)' }}
                  >
                    <Icon name="plane" className="h-4 w-4" />
                  </span>
                  世途旅行
                </span>
                <button
                  onClick={closeMenu}
                  className="flex h-8 w-8 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-brand-50/60 hover:text-brand-700 text-xl"
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-2 py-3">
                {/* 主导航 */}
                {frontNav.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.exact}
                    onClick={closeMenu}
                    className={({ isActive }) => drawerItem(isActive)}
                  >
                    {n.label}
                  </NavLink>
                ))}
                {isAgent && (
                  <>
                    <NavLink to="/team" onClick={closeMenu} className={({ isActive }) => drawerItem(isActive)}>
                      {t('nav.team')}
                    </NavLink>
                    <NavLink to="/my-commissions" onClick={closeMenu} className={({ isActive }) => drawerItem(isActive)}>
                      {t('nav.commissions')}
                    </NavLink>
                  </>
                )}

                <div className="my-2.5 border-t border-ink/10" />

                {/* 用户区 */}
                {user ? (
                  <>
                    <Link to="/orders" onClick={closeMenu} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-brand-50/60 hover:text-brand-700">
                      <Icon name="ticket" className="h-4 w-4 text-ink-muted" />
                      {t('nav.myOrders')}
                    </Link>
                    <Link to="/me" onClick={closeMenu} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-brand-50/60 hover:text-brand-700">
                      <Icon name="user" className="h-4 w-4 text-ink-muted" />
                      <span>{user.displayName ?? user.email}</span>
                      <span className="badge-soft">
                        {ROLE_LABEL[user.role] ?? user.role}
                      </span>
                    </Link>
                    <button
                      type="button"
                      className="w-full text-left block rounded-xl px-3 py-2.5 text-sm font-semibold text-deal transition-colors hover:bg-deal-light"
                      onClick={async () => {
                        closeMenu();
                        await logout();
                        navigate('/');
                      }}
                    >
                      {t('nav.logout')}
                    </button>
                  </>
                ) : (
                  <Link to="/login" onClick={closeMenu} className="mt-1 block">
                    <span className="btn-primary w-full text-sm">{t('nav.login')}</span>
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 管理员登录在前台时，显示提示去后台 */}
        {isAdmin && (
          <div className="border-t border-sun/25 bg-sun-light">
            <div className="mx-auto max-w-7xl px-4 py-2 text-xs text-amber-800 flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
                您是管理员/运营，前台仅供浏览。后台操作请到{' '}
                <a href="http://localhost:5174" className="font-semibold underline decoration-sun underline-offset-2 transition-colors hover:text-amber-900" target="_blank" rel="noreferrer">
                  http://localhost:5174
                </a>
              </span>
              <a href="http://localhost:5174" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-sun px-2.5 py-1 font-semibold text-white shadow-card transition-all duration-200 hover:brightness-105 hover:-translate-y-px active:scale-95">
                进入后台 <Icon name="arrowRight" className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        {/* 手机端底部留出 bottom bar 高度 + 页面操作条，避免内容被挡住 */}
        <div className="mx-auto w-full max-w-7xl px-4 pt-8 pb-32 md:pb-8">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-slate-200/70 bg-surface text-xs text-ink-muted">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-1 px-4 py-5 pb-20 sm:flex-row sm:items-center sm:justify-between md:pb-5">
          <span className="flex items-center gap-1.5 font-semibold text-ink-soft">
            <Icon name="plane" className="h-4 w-4 text-brand-600" />
            世途旅行
          </span>
          <span>海岛专线 · 一站式预订 · M2-M5 演示版 · © {new Date().getFullYear()}</span>
        </div>
      </footer>

      {/* 手机端底部导航：首页 / 套餐 / 购物车（带数量）/ 我的 */}
      <MobileBottomBar />

      <AddToCartToast />

      {/* 浮动 AI 助手 — 任何角色都看得到（admin 也能测试 demo）；
          下单时才跳登录 */}
      <AiAssistant />
    </div>
  );
}

/** 顶部购物车按钮 — 显示数量徽章，链到 /cart。
 *  手机端隐藏（入口在 MobileBottomBar，拇指可达），桌面端保留。 */
function CartButton() {
  const count = useCart((s) => s.items.reduce((sum, i) => sum + i.qty, 0));
  return (
    <Link
      to="/cart"
      className="relative hidden md:inline-flex items-center gap-1.5 rounded-xl border border-slate-200/70 bg-white/70 px-3 py-1.5 font-semibold text-ink-soft shadow-card transition-all duration-200 hover:border-brand/40 hover:bg-brand-50/60 hover:text-brand-700 active:scale-95"
    >
      <Icon name="cart" className="h-4 w-4" />
      <span className="hidden md:inline">购物车</span>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-deal px-1 text-[11px] font-bold text-white shadow-deal nums">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

/** 加入购物车的飘字提示（监听 ftm-cart-add 事件） */
function AddToCartToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (detail?.name) {
        setMsg(`已加入购物车：${detail.name}`);
        setTimeout(() => setMsg(null), 1800);
      }
    };
    window.addEventListener('ftm-cart-add', onAdd);
    return () => window.removeEventListener('ftm-cart-add', onAdd);
  }, []);
  if (!msg) return null;
  return (
    // 手机端抬高到 bottom bar 之上
    <div className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-50 inline-flex items-center gap-1.5 rounded-2xl bg-ink px-4 py-2.5 text-sm font-semibold text-white shadow-pop animate-fade-up">
      <Icon name="check" className="h-4 w-4 text-emerald-300" />
      {msg}
    </div>
  );
}
