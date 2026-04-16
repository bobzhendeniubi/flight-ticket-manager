import { useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { api, ApiError } from '../lib/api';

const ROLE_LABEL: Record<string, string> = {
  STAFF: '运营',
  ADMIN: '管理员',
};

const NAV = [
  { to: '/dashboard', label: '仪表盘' },
  { to: '/orders', label: '订单管理' },
  { to: '/flights', label: '航班管理' },
  { to: '/seat-stats', label: '座位统计' },
  { to: '/seat-allocation', label: '切位（包位）' },
  { to: '/products', label: '产品管理' },
  { to: '/pricing', label: '动态定价' },
  { to: '/agents', label: '代理管理' },
];

export function Layout() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();

  /**
   * 启动时向后端验证 token 是否真有效 + 角色是否对得上。
   * 解决"篡改 localStorage 伪造身份进后台壳"的攻击场景。
   * - 如果 me() 失败（token 不真/过期）→ logout + 跳登录
   * - 如果后端返回的角色不是 ADMIN/STAFF（不一致）→ 同样登出
   */
  useEffect(() => {
    if (!tokens || !user) return;
    let cancelled = false;
    api.me(tokens.accessToken)
      .then((res) => {
        if (cancelled) return;
        if (res.user.role !== 'ADMIN' && res.user.role !== 'STAFF') {
          logout().then(() => navigate('/login', { replace: true }));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          logout().then(() => navigate('/login', { replace: true }));
        }
      });
    return () => { cancelled = true; };
  }, [tokens, user, logout, navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-100">
      {/* 顶部品牌 + 用户 */}
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-3">
          <Link to="/dashboard" className="flex items-center gap-2 text-lg font-semibold">
            <span aria-hidden className="text-brand">⚙</span>
            <span>世途旅行 · 后台</span>
            <span className="ml-2 rounded bg-brand/20 px-2 py-0.5 text-xs text-brand">运营端</span>
          </Link>
          <div className="flex items-center gap-3 text-sm">
            {user ? (
              <>
                <span className="text-slate-300">
                  {user.displayName ?? user.email}
                  <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-xs">
                    {ROLE_LABEL[user.role] ?? user.role}
                  </span>
                </span>
                <button
                  type="button"
                  className="rounded bg-slate-700 px-3 py-1.5 hover:bg-slate-600"
                  onClick={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  退出
                </button>
              </>
            ) : (
              <span className="text-slate-400">未登录</span>
            )}
          </div>
        </div>
      </header>

      {user && (
        <nav className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-[1400px] px-5">
            <ul className="flex flex-wrap gap-1 text-sm">
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    className={({ isActive }) =>
                      `inline-block px-4 py-3 border-b-2 transition ${
                        isActive
                          ? 'border-brand text-brand font-medium'
                          : 'border-transparent text-slate-600 hover:text-brand hover:border-brand/30'
                      }`
                    }
                  >
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      )}

      <main className="flex-1">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-6">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white text-xs text-slate-500">
        <div className="mx-auto max-w-[1400px] px-5 py-3 flex justify-between">
          <span>世途旅行后台 · M2-M5 演示版 · © {new Date().getFullYear()}</span>
          <span className="text-slate-400">前台入口：http://localhost:5173</span>
        </div>
      </footer>
    </div>
  );
}
