import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

export function Layout() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  const isAgent = user?.role === 'AGENT';
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'STAFF';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <span aria-hidden className="text-brand">✈︎</span>
            <span>机票管家</span>
          </Link>

          <nav className="hidden md:flex items-center gap-1 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md ${isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'}`
              }
            >
              搜索航班
            </NavLink>
            {(isAgent || isAdmin) && (
              <NavLink
                to="/team"
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md ${isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'}`
                }
              >
                {isAdmin ? '代理管理' : '我的团队'}
              </NavLink>
            )}
            {isAdmin && (
              <NavLink
                to="/admin/flights"
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md ${isActive ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:text-brand'}`
                }
              >
                航班管理
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
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white text-xs text-slate-500">
        <div className="mx-auto max-w-6xl px-4 py-4">
          机票管家 · M2 迭代 · © {new Date().getFullYear()}
        </div>
      </footer>
    </div>
  );
}
