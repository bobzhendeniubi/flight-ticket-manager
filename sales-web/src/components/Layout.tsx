import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';
import { MobilePreviewFrame } from './MobilePreviewFrame';
import { AiAssistant } from './AiAssistant';

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

// 管理后台已拆分到 admin-web (:5174)。前台不再展示后台入口。
// /admin/* 路由仍保留可访问（向后兼容旧链接），但不在 nav 中显示。

export function Layout() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 主导航：用 t() 而不是硬编码文字
  const frontNav = [
    { to: '/', label: t('nav.flights'), exact: true },
    { to: '/hotels', label: t('nav.hotels') },
    { to: '/transfers', label: t('nav.transfers') },
    { to: '/visas', label: t('nav.visas') },
    { to: '/bundles', label: t('nav.bundles') },
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
    <div className="min-h-screen flex flex-col">
      {/* 顶部：品牌 + 前台导航 + 用户菜单 */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-3 md:gap-4 md:px-4">
          {/* 手机端：左侧汉堡按钮 */}
          <button
            type="button"
            className="md:hidden flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-slate-700"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t('nav.menu')}
          >
            <span className="text-lg">☰</span>
          </button>

          <Link to="/" className="flex items-center gap-2 text-base md:text-lg font-semibold text-slate-900 truncate">
            <span aria-hidden className="text-brand">✈︎</span>
            <span>世途旅行</span>
          </Link>

          {/* 桌面端：主导航 */}
          <nav className="hidden md:flex items-center gap-1 text-sm">
            {frontNav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.exact}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md ${
                    isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
            {isAgent && (
              <>
                <NavLink
                  to="/team"
                  className={({ isActive }) =>
                    `px-3 py-1.5 rounded-md ${
                      isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'
                    }`
                  }
                >
                  {t('nav.team')}
                </NavLink>
                <NavLink
                  to="/my-commissions"
                  className={({ isActive }) =>
                    `px-3 py-1.5 rounded-md ${
                      isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'
                    }`
                  }
                >
                  {t('nav.commissions')}
                </NavLink>
              </>
            )}
          </nav>

          {/* 右侧用户菜单：手机端只保留购物车，其他进汉堡 */}
          <nav className="flex items-center gap-2 md:gap-3 text-sm">
            <a
              href="/?preview=mobile"
              className="hidden md:inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 hover:border-brand hover:text-brand"
              title="以移动端视口预览（小程序端测试）"
            >
              {t('nav.miniprogramPreview')}
            </a>
            <CartButton />
            {/* 桌面端：完整用户区 */}
            {user ? (
              <div className="hidden md:flex items-center gap-3">
                <Link to="/orders" className="text-sm text-slate-700 hover:text-brand">
                  {t('nav.myOrders')}
                </Link>
                <Link to="/me" className="flex items-center gap-2 text-slate-700 hover:text-brand">
                  <span>{user.displayName ?? user.email}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
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
          <div className="md:hidden fixed inset-0 z-50 bg-black/40" onClick={closeMenu}>
            <div
              className="absolute left-0 top-0 h-full w-72 max-w-[80vw] bg-white shadow-xl flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <span className="font-semibold">{t('nav.menu')}</span>
                <button onClick={closeMenu} className="text-slate-400 hover:text-slate-700 text-xl" aria-label="关闭">×</button>
              </div>
              <div className="flex-1 overflow-y-auto py-2">
                {/* 主导航 */}
                {frontNav.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.exact}
                    onClick={closeMenu}
                    className={({ isActive }) =>
                      `block px-4 py-3 text-sm border-l-4 ${
                        isActive ? 'border-brand bg-brand/5 text-brand font-semibold' : 'border-transparent text-slate-700 hover:bg-slate-50'
                      }`
                    }
                  >
                    {n.label}
                  </NavLink>
                ))}
                {isAgent && (
                  <>
                    <NavLink
                      to="/team"
                      onClick={closeMenu}
                      className={({ isActive }) =>
                        `block px-4 py-3 text-sm border-l-4 ${
                          isActive ? 'border-brand bg-brand/5 text-brand font-semibold' : 'border-transparent text-slate-700 hover:bg-slate-50'
                        }`
                      }
                    >
                      {t('nav.team')}
                    </NavLink>
                    <NavLink
                      to="/my-commissions"
                      onClick={closeMenu}
                      className={({ isActive }) =>
                        `block px-4 py-3 text-sm border-l-4 ${
                          isActive ? 'border-brand bg-brand/5 text-brand font-semibold' : 'border-transparent text-slate-700 hover:bg-slate-50'
                        }`
                      }
                    >
                      {t('nav.commissions')}
                    </NavLink>
                  </>
                )}

                <div className="my-2 border-t border-slate-100" />

                {/* 用户区 */}
                {user ? (
                  <>
                    <Link to="/orders" onClick={closeMenu} className="block px-4 py-3 text-sm text-slate-700 hover:bg-slate-50">
                      📋 {t('nav.myOrders')}
                    </Link>
                    <Link to="/me" onClick={closeMenu} className="block px-4 py-3 text-sm text-slate-700 hover:bg-slate-50">
                      👤 {user.displayName ?? user.email}
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                        {ROLE_LABEL[user.role] ?? user.role}
                      </span>
                    </Link>
                    <button
                      type="button"
                      className="w-full text-left block px-4 py-3 text-sm text-rose-700 hover:bg-rose-50"
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
                  <>
                    <Link to="/login" onClick={closeMenu} className="block px-4 py-3 text-sm font-semibold text-brand hover:bg-brand/5">
                      {t('nav.login')}
                    </Link>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 管理员登录在前台时，显示提示去后台 */}
        {isAdmin && (
          <div className="border-t border-slate-200 bg-amber-50">
            <div className="mx-auto max-w-7xl px-4 py-2 text-xs text-amber-800 flex items-center justify-between">
              <span>
                ⓘ 您是管理员/运营，前台仅供浏览。后台操作请到{' '}
                <a href="http://localhost:5174" className="font-semibold underline" target="_blank" rel="noreferrer">
                  http://localhost:5174
                </a>
              </span>
              <a href="http://localhost:5174" target="_blank" rel="noreferrer" className="rounded bg-amber-600 px-2 py-1 text-white hover:bg-amber-700">
                进入后台 →
              </a>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl px-4 py-8">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white text-xs text-slate-500">
        <div className="mx-auto max-w-7xl px-4 py-4">
          世途旅行 · M2-M5 演示版 · © {new Date().getFullYear()}
        </div>
      </footer>

      <AddToCartToast />

      {/* 浮动 AI 助手 — 任何角色都看得到（admin 也能测试 demo）；
          下单时才跳登录 */}
      <AiAssistant />
    </div>
  );
}

/** 顶部购物车按钮 — 显示数量徽章，链到 /cart */
function CartButton() {
  const count = useCart((s) => s.items.reduce((sum, i) => sum + i.qty, 0));
  return (
    <Link
      to="/cart"
      className="relative inline-flex items-center gap-1 rounded-md border border-slate-200 px-3 py-1.5 text-slate-700 hover:border-brand hover:text-brand"
    >
      <span aria-hidden>🛒</span>
      <span className="hidden md:inline">购物车</span>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
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
        setMsg(`✅ 已加入购物车：${detail.name}`);
        setTimeout(() => setMsg(null), 1800);
      }
    };
    window.addEventListener('ftm-cart-add', onAdd);
    return () => window.removeEventListener('ftm-cart-add', onAdd);
  }, []);
  if (!msg) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 rounded-md bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
      {msg}
    </div>
  );
}
