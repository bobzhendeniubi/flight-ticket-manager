import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { OrdersPage } from './pages/OrdersPage';
import { FlightsPage } from './pages/FlightsPage';
import { SeatStatsPage } from './pages/SeatStatsPage';
import { SeatAllocationPage } from './pages/SeatAllocationPage';
import { ProductsPage } from './pages/ProductsPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentBalancePage } from './pages/AgentBalancePage';
import { CustomersPage } from './pages/CustomersPage';
import { TravelersPage } from './pages/TravelersPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SettlementsPage } from './pages/SettlementsPage';
import { CancellationPoliciesPage } from './pages/CancellationPoliciesPage';
import { FinancesPage } from './pages/FinancesPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { HotelControlPage } from './pages/HotelControlPage';
import { VisaDeskPage } from './pages/VisaDeskPage';
import { AiOcrSettingsPage } from './pages/AiOcrSettingsPage';
import { useAuth } from './stores/auth';

// AGENT 可访问的页面集合（其他页面默认 ADMIN/STAFF 专属）
// 真实 RBAC 仍由后端 requireRole 兜底 —— 前端只做导航 UX
const AGENT_ALLOWED_PATHS = new Set([
  '/orders',
  '/customers',
  '/travelers',
  '/agents',
  '/settlements',
  '/agent-balance',
]);

function Protected({
  children,
  adminOnly = false,
}: {
  children: React.ReactNode;
  /** 只允许 ADMIN/STAFF；AGENT 重定向到自己的 landing 页 */
  adminOnly?: boolean;
}) {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  if (!user || !tokens) return <Navigate to="/login" replace />;
  if (user.role === 'CUSTOMER') return <Navigate to="/login" replace />;

  // AGENT 禁入 admin-only 页 —— 落到默认 landing (/orders)
  if (adminOnly && user.role === 'AGENT') {
    return <Navigate to="/orders" replace />;
  }
  return <>{children}</>;
}

function AgentLanding() {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  // AGENT 默认落地到订单页（没有 dashboard 权限）；ADMIN/STAFF 走 dashboard
  return <Navigate to={user.role === 'AGENT' ? '/orders' : '/dashboard'} replace />;
}

void AGENT_ALLOWED_PATHS; // 将来可用于中间件白名单，目前通过 adminOnly 显式标注

// 会话保活策略（对任意 access token TTL 都稳健）：
// 每分钟体检一次，只有当 access token 进入「临期窗」（剩余 ≤ REFRESH_SKEW_MS）才续期。
// 好处：刚登录 / token 还新时不做无谓轮换 —— 避免多标签/重复挂载并发轮换撞后端一次性轮换判定；
// 真正过期的那一刻由 apiFetch 的 401 静默续期兜底。
const SESSION_CHECK_INTERVAL_MS = 60 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 解析 JWT 的 exp（毫秒时间戳）；解析失败/无 exp 返回 null（当作临期，交由续期兜底）。 */
function getAccessTokenExpMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function App() {
  const hasSession = useAuth((s) => Boolean(s.tokens?.refreshToken));
  const refreshSession = useAuth((s) => s.refreshSession);

  useEffect(() => {
    if (!hasSession) return;

    // 只在临期时续期：新 token 不动，避免无谓（且可能并发）的刷新。
    const maybeRefresh = () => {
      const expMs = getAccessTokenExpMs(useAuth.getState().tokens?.accessToken);
      if (expMs === null || expMs - Date.now() <= REFRESH_SKEW_MS) {
        void refreshSession();
      }
    };

    maybeRefresh();
    const id = window.setInterval(maybeRefresh, SESSION_CHECK_INTERVAL_MS);

    // 后台标签的 setInterval 会被浏览器节流：切回前台时先从存储同步（兄弟标签可能已轮换出新 token），
    // 再体检续期，避免拿着过期 token 继续请求。
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void Promise.resolve(useAuth.persist?.rehydrate?.()).then(maybeRefresh);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasSession, refreshSession]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route
          path="/dashboard"
          element={
            <Protected adminOnly>
              <DashboardPage />
            </Protected>
          }
        />
        <Route
          path="/orders"
          element={
            <Protected>
              <OrdersPage />
            </Protected>
          }
        />
        <Route
          path="/flights"
          element={
            <Protected adminOnly>
              <FlightsPage />
            </Protected>
          }
        />
        <Route
          path="/seat-stats"
          element={
            <Protected adminOnly>
              <SeatStatsPage />
            </Protected>
          }
        />
        <Route
          path="/seat-allocation"
          element={
            <Protected adminOnly>
              <SeatAllocationPage />
            </Protected>
          }
        />
        <Route
          path="/products"
          element={
            <Protected adminOnly>
              <ProductsPage />
            </Protected>
          }
        />
        {/* 动态定价页已退役：定价改由航班月历的「仓位阶梯」承载。
            旧 /pricing 链接重定向到航班管理，避免书签/历史 404。 */}
        <Route path="/pricing" element={<Navigate to="/flights" replace />} />
        <Route
          path="/agents"
          element={
            <Protected>
              <AgentsPage />
            </Protected>
          }
        />
        <Route
          path="/customers"
          element={
            <Protected>
              <CustomersPage />
            </Protected>
          }
        />
        <Route
          path="/travelers"
          element={
            <Protected>
              <TravelersPage />
            </Protected>
          }
        />
        <Route
          path="/cancellation-policies"
          element={
            <Protected adminOnly>
              <CancellationPoliciesPage />
            </Protected>
          }
        />
        <Route
          path="/audit-logs"
          element={
            <Protected adminOnly>
              <AuditLogsPage />
            </Protected>
          }
        />
        <Route
          path="/settlements"
          element={
            <Protected>
              <SettlementsPage />
            </Protected>
          }
        />
        <Route
          path="/agent-balance"
          element={
            <Protected>
              <AgentBalancePage />
            </Protected>
          }
        />
        <Route
          path="/finances"
          element={
            <Protected adminOnly>
              <FinancesPage />
            </Protected>
          }
        />
        <Route
          path="/reconciliation"
          element={
            <Protected adminOnly>
              <ReconciliationPage />
            </Protected>
          }
        />
        <Route
          path="/hotel-control"
          element={
            <Protected adminOnly>
              <HotelControlPage />
            </Protected>
          }
        />
        <Route
          path="/visa-desk"
          element={
            <Protected adminOnly>
              <VisaDeskPage />
            </Protected>
          }
        />
        <Route
          path="/settings/ai-ocr"
          element={
            <Protected adminOnly>
              <AiOcrSettingsPage />
            </Protected>
          }
        />
      </Route>
      <Route path="*" element={<AgentLanding />} />
    </Routes>
  );
}
