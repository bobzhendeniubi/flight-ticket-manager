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
import { CustomersPage } from './pages/CustomersPage';
import { TravelersPage } from './pages/TravelersPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SettlementsPage } from './pages/SettlementsPage';
import { CancellationPoliciesPage } from './pages/CancellationPoliciesPage';
import { FinancesPage } from './pages/FinancesPage';
import { HotelControlPage } from './pages/HotelControlPage';
import { VisaDeskPage } from './pages/VisaDeskPage';
import { useAuth } from './stores/auth';

// AGENT 可访问的页面集合（其他页面默认 ADMIN/STAFF 专属）
// 真实 RBAC 仍由后端 requireRole 兜底 —— 前端只做导航 UX
const AGENT_ALLOWED_PATHS = new Set([
  '/orders',
  '/customers',
  '/travelers',
  '/agents',
  '/settlements',
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

// access token TTL=1h；提前到 50 分钟续期，避免后台闲置掉登录
const REFRESH_INTERVAL_MS = 50 * 60 * 1000;

export function App() {
  const hasSession = useAuth((s) => Boolean(s.tokens?.refreshToken));
  const refreshSession = useAuth((s) => s.refreshSession);

  useEffect(() => {
    if (!hasSession) return;
    void refreshSession();
    const id = setInterval(() => void refreshSession(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
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
          path="/finances"
          element={
            <Protected adminOnly>
              <FinancesPage />
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
      </Route>
      <Route path="*" element={<AgentLanding />} />
    </Routes>
  );
}
