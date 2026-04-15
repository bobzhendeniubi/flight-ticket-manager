import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

const frontNav = [
  { to: '/', label: '机票', exact: true },
  { to: '/hotels', label: '酒店' },
  { to: '/transfers', label: '机场接送' },
  { to: '/visas', label: '签证' },
];

const adminNav = [
  { to: '/admin/dashboard', label: '仪表盘' },
  { to: '/admin/orders', label: '订单' },
  { to: '/admin/flights', label: '航班' },
  { to: '/admin/pricing', label: '定价' },
  { to: '/team', label: '代理' },
];

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

        {/* 管理员专用二级导航条 */}
        {isAdmin && (
          <div className="border-t border-slate-200 bg-slate-50">
            <div className="mx-auto max-w-7xl px-4 py-2">
              <nav className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-slate-400 mr-2">后台：</span>
                {adminNav.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    className={({ isActive }) =>
                      `px-3 py-1 rounded ${
                        isActive
                          ? 'bg-brand text-white'
                          : 'text-slate-600 hover:bg-white hover:text-brand'
                      }`
                    }
                  >
                    {n.label}
                  </NavLink>
                ))}
              </nav>
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
    </div>
  );
}
