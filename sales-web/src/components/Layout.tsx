import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

const frontNav = [
  { to: '/', label: '机票', exact: true },
  { to: '/hotels', label: '酒店' },
  { to: '/transfers', label: '接送' },
  { to: '/visas', label: '签证' },
  { to: '/bundles', label: '套餐' },
];

// 管理后台已拆分到 admin-web (:5174)。前台不再展示后台入口。
// /admin/* 路由仍保留可访问（向后兼容旧链接），但不在 nav 中显示。

export function Layout() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  const isAgent = user?.role === 'AGENT';
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'STAFF';

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶部：品牌 + 前台导航 + 用户菜单 */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <span aria-hidden className="text-brand">✈︎</span>
            <span>机票管家</span>
          </Link>

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
              <NavLink
                to="/team"
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md ${
                    isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'
                  }`
                }
              >
                我的团队
              </NavLink>
            )}
          </nav>

          <nav className="flex items-center gap-3 text-sm">
            <CartButton />
            {user ? (
              <>
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
                  退出
                </button>
              </>
            ) : (
              <>
                <Link to="/login" className="text-slate-700 hover:text-brand">
                  登录
                </Link>
                <Link to="/register" className="btn-primary text-sm py-1.5">
                  注册账号
                </Link>
              </>
            )}
          </nav>
        </div>

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
          机票管家 · M2-M5 演示版 · © {new Date().getFullYear()}
        </div>
      </footer>

      <AddToCartToast />
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
