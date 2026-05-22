import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { OrdersPage } from './pages/OrdersPage';
import { FlightsPage } from './pages/FlightsPage';
import { SeatStatsPage } from './pages/SeatStatsPage';
import { SeatAllocationPage } from './pages/SeatAllocationPage';
import { ProductsPage } from './pages/ProductsPage';
import { PricingPage } from './pages/PricingPage';
import { AgentsPage } from './pages/AgentsPage';
import { CustomersPage } from './pages/CustomersPage';
import { TravelersPage } from './pages/TravelersPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { SettlementsPage } from './pages/SettlementsPage';
import { CancellationPoliciesPage } from './pages/CancellationPoliciesPage';
import { FinancesPage } from './pages/FinancesPage';
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

export function App() {
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
        <Route
          path="/pricing"
          element={
            <Protected adminOnly>
              <PricingPage />
            </Protected>
          }
        />
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
      </Route>
      <Route path="*" element={<AgentLanding />} />
    </Routes>
  );
}
