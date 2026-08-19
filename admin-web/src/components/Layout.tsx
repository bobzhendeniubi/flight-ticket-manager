import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { api, ApiError, AUTH_REFRESH_UNAVAILABLE_CODE } from '../lib/api';
import { ErrorBoundary } from './ErrorBoundary';

const ROLE_LABEL: Record<string, string> = {
  STAFF: '运营',
  ADMIN: '管理员',
  AGENT: '代理',
};

// roles: 允许访问该导航的角色集合
// section: 侧栏分组标题（用于视觉分组，不影响路由 / 角色过滤）
const NAV: Array<{
  to: string;
  label: string;
  roles: Array<'ADMIN' | 'STAFF' | 'AGENT'>;
  section: string;
}> = [
  { to: '/dashboard',       label: '仪表盘',      roles: ['ADMIN', 'STAFF'],          section: '概览' },
  { to: '/orders',          label: '订单管理',    roles: ['ADMIN', 'STAFF', 'AGENT'], section: '运营' },
  { to: '/flights',         label: '航班管理',    roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/seat-stats',      label: '座位统计',    roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/seat-allocation', label: '切位（包位）', roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/hotel-control',   label: '房控',        roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/visa-desk',       label: '签证台',      roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/reminders',       label: '提醒中心',    roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/fulfillment-board', label: '工单看板',  roles: ['ADMIN', 'STAFF'],          section: '运营' },
  { to: '/products',        label: '产品管理',    roles: ['ADMIN', 'STAFF'],          section: '产品' },
  { to: '/settlement-rates', label: '结算价日历',  roles: ['ADMIN', 'STAFF'],          section: '产品' },
  { to: '/settlement-discounts', label: '立减规则', roles: ['ADMIN', 'STAFF'],         section: '产品' },
  { to: '/cancellation-policies', label: '取消政策', roles: ['ADMIN', 'STAFF'],       section: '产品' },
  { to: '/agents',          label: '代理管理',    roles: ['ADMIN', 'STAFF', 'AGENT'], section: '客户' },
  { to: '/customers',       label: '散客管理',    roles: ['ADMIN', 'STAFF', 'AGENT'], section: '客户' },
  { to: '/travelers',       label: '旅客管理',    roles: ['ADMIN', 'STAFF', 'AGENT'], section: '客户' },
  { to: '/settlements',     label: '结算单',      roles: ['ADMIN', 'STAFF', 'AGENT'], section: '财务' },
  { to: '/agent-balance',   label: '余额与认款',  roles: ['ADMIN', 'STAFF', 'AGENT'], section: '财务' },
  { to: '/reconciliation',  label: '收款对账台',  roles: ['ADMIN', 'STAFF'],          section: '财务' },
  { to: '/finances',        label: '财务',        roles: ['ADMIN'],                   section: '财务' },
  { to: '/reports',         label: '经营报表',    roles: ['ADMIN'],                   section: '财务' },
  { to: '/audit-logs',      label: '审计日志',    roles: ['ADMIN', 'STAFF'],          section: '系统' },
  { to: '/settings/ai-ocr', label: 'AI 识别设置', roles: ['ADMIN'],                   section: '系统' },
  { to: '/settings/staff-roles', label: '岗位管理',    roles: ['ADMIN'],                   section: '系统' },
];

// 侧栏分组渲染顺序（NAV 里出现的 section 都在这里列一遍）
const SECTION_ORDER = ['概览', '运营', '产品', '客户', '财务', '系统'];

export function Layout() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();

  // 仅用于 <1024px 的侧栏抽屉开合（纯展示用的 chrome 状态）
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  // 点击"当前所在页"的菜单项时 react-router 不会触发导航（路径未变），
  // 页面组件也就不会重挂、不会重新拉数。这里用一个自增 tick 强制 Outlet
  // 重挂，让点击菜单始终有"刷新页面"的效果。
  const [refreshTick, setRefreshTick] = useState(0);

  /**
   * 启动时向后端验证 token 是否真有效 + 角色是否对得上。
   * 解决"篡改 localStorage 伪造身份进后台壳"的攻击场景。
   * - me() 被判会话失效（api 层放行出来的 401/403）→ logout + 跳登录
   * - 后端返回的角色是 CUSTOMER（不该进后台）→ 同样登出
   * - 其它错误（续期暂时不可用 / 网络抖动 / 5xx）→ 静默忽略，绝不登出
   *
   * ⚠️ 依赖数组用 userId + hasToken 这两个稳定标量，不用 tokens 对象：
   * 每次静默续期都会换出一个新的 tokens 对象，若直接依赖它，这个体检会随每轮轮换重跑一次
   * （运营开着后台一整天 ≈ 十几次无谓的 /users/me）。真正需要复验的是「换人登录了」或
   * 「会话从无到有」，这两件事 userId / hasToken 都能表达。
   */
  const userId = user?.id ?? null;
  const hasToken = Boolean(tokens?.accessToken);
  useEffect(() => {
    if (!userId || !hasToken) return;
    let cancelled = false;
    // 取当下最新的令牌（刻意不进依赖数组）：轮换后重跑不是目的，但真跑起来时必须用最新那枚。
    const accessToken = useAuth.getState().tokens?.accessToken;
    if (!accessToken) return;

    api.me(accessToken)
      .then((res) => {
        if (cancelled) return;
        // 后台允许 ADMIN/STAFF/AGENT；CUSTOMER 踢出
        if (res.user.role === 'CUSTOMER') {
          logout().then(() => navigate('/login', { replace: true }));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 只认「会话确凿失效」：api 层已经把可恢复的失败（并发轮换竞争 / 网络抖动 / 刷新口 5xx）
        // 翻译成 AUTH_REFRESH_UNAVAILABLE 而不是 401，所以能走到这里的 401/403 才是真该重登录。
        // 其余一律静默 —— 一次瞬时故障不该把正在编辑的运营弹回登录页。
        const isSessionDead =
          err instanceof ApiError &&
          err.code !== AUTH_REFRESH_UNAVAILABLE_CODE &&
          (err.status === 401 || err.status === 403);
        if (isSessionDead) {
          logout().then(() => navigate('/login', { replace: true }));
        }
      });
    return () => { cancelled = true; };
  }, [userId, hasToken, logout, navigate]);

  // 切路由时收起抽屉（移动端）
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  const visibleNav = user
    ? NAV.filter((n) => n.roles.includes(user.role as 'ADMIN' | 'STAFF' | 'AGENT'))
    : [];

  // 当前页标题（用于内容区顶栏的上下文）
  const currentLabel = visibleNav.find((n) => location.pathname.startsWith(n.to))?.label ?? '';

  const homeTo = user?.role === 'AGENT' ? '/orders' : '/dashboard';

  // 品牌锁定区（侧栏头部复用）
  const brandLockup = (
    <Link to={homeTo} className="flex items-center gap-2.5" onClick={closeDrawer}>
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white"
      >
        世
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight text-ink">世途旅行</span>
        <span className="text-[11px] font-medium text-ink-muted">
          {user?.role === 'AGENT' ? '代理控制台' : '运营控制台'}
        </span>
      </span>
    </Link>
  );

  // 侧栏导航主体（桌面固定栏 / 移动抽屉共用）
  const sidebarNav = (
    <nav className="flex-1 overflow-y-auto px-3 py-4">
      {SECTION_ORDER.map((section) => {
        const items = visibleNav.filter((n) => n.section === section);
        if (items.length === 0) return null;
        return (
          <div key={section} className="mb-5 last:mb-0">
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              {section}
            </p>
            <ul className="space-y-0.5">
              {items.map((n) => (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    onClick={() => {
                      closeDrawer();
                      // 已经在这个页面上再点一次同一项：路径不变，路由不会
                      // 重新导航，主动 +1 触发下方 Outlet 重挂刷新数据。
                      if (location.pathname.startsWith(n.to)) {
                        setRefreshTick((t) => t + 1);
                      }
                    }}
                    className={({ isActive }) =>
                      `relative flex items-center rounded-lg px-3 py-2 text-sm font-medium transition ${
                        isActive
                          ? 'bg-brand-50 font-semibold text-brand-700 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-brand'
                          : 'text-ink-soft hover:bg-slate-50 hover:text-ink'
                      }`
                    }
                  >
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* ── 桌面端：固定左侧栏（≥1024px） ─────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-slate-200 bg-surface lg:flex">
        <div className="flex h-14 items-center border-b border-slate-200 px-4">
          {brandLockup}
        </div>
        {sidebarNav}
        {user ? (
          <div className="border-t border-slate-200 p-3">
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                {(user.displayName ?? user.email ?? '?').slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{user.displayName ?? user.email}</p>
                <p className="text-[11px] text-ink-muted">{ROLE_LABEL[user.role] ?? user.role}</p>
              </div>
            </div>
          </div>
        ) : null}
      </aside>

      {/* ── 移动端：抽屉（<1024px） ───────────────────────────── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/40 animate-fade-in" onClick={closeDrawer} aria-hidden />
          <div className="absolute inset-y-0 left-0 flex w-[232px] max-w-[80vw] flex-col bg-surface shadow-pop">
            <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
              {brandLockup}
              <button
                type="button"
                onClick={closeDrawer}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-ink-muted transition hover:bg-slate-100 hover:text-ink"
                aria-label="关闭菜单"
              >
                ×
              </button>
            </div>
            {sidebarNav}
          </div>
        </div>
      )}

      {/* ── 内容区（桌面端给侧栏让出 232px） ──────────────────── */}
      <div className="flex min-h-screen flex-col lg:pl-[232px]">
        {/* 内容区顶栏：左侧汉堡 + 页面上下文，右侧用户菜单 / 退出 */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-surface/90 px-4 backdrop-blur md:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-ink-soft transition hover:bg-slate-50 hover:text-ink lg:hidden"
            aria-label="打开菜单"
          >
            <span className="text-base">☰</span>
          </button>

          <div className="min-w-0 flex-1">
            {currentLabel && (
              <span className="truncate text-sm font-semibold text-ink">{currentLabel}</span>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm">
            {user ? (
              <>
                <span className="hidden items-center gap-2 sm:flex">
                  <span className="font-medium text-ink-soft">{user.displayName ?? user.email}</span>
                  <span className="badge-neutral">{ROLE_LABEL[user.role] ?? user.role}</span>
                </span>
                <button
                  type="button"
                  className="btn-secondary py-1.5"
                  onClick={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  退出
                </button>
              </>
            ) : (
              <span className="text-ink-muted">未登录</span>
            )}
          </div>
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-6 lg:px-8">
            <ErrorBoundary resetKey={`${location.pathname}#${refreshTick}`}>
              <Outlet key={`${location.pathname}#${refreshTick}`} />
            </ErrorBoundary>
          </div>
        </main>

        <footer className="border-t border-slate-200 bg-surface text-xs text-ink-muted">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-6 lg:px-8">
            <span>世途旅行后台 · © {new Date().getFullYear()}</span>
            <span>前台入口：<a className="text-brand hover:text-brand-dark" href="https://store.citurtravel.com" target="_blank" rel="noreferrer">store.citurtravel.com</a></span>
          </div>
        </footer>
      </div>
    </div>
  );
}
