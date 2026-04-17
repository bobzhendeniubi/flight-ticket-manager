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
import { useAuth } from './stores/auth';

function Protected({ children }: { children: React.ReactNode }) {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  // 同时要求 user 和 tokens 都存在 — 防止有人篡改 localStorage 只伪造 user 而无 token
  if (!user || !tokens) return <Navigate to="/login" replace />;
  // 后台严格 ADMIN/STAFF
  if (user.role !== 'ADMIN' && user.role !== 'STAFF') {
    return <Navigate to="/login" replace />;
  }
  // 注意：前端路由保护是 UX 层面，真正的 RBAC 由后端 requireRole(ADMIN) 在 API 层兜底。
  // 即使有人篡改 localStorage 进入这些页面，他们调任何 API 都会被后端拒绝。
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route
          path="/dashboard"
          element={
            <Protected>
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
            <Protected>
              <FlightsPage />
            </Protected>
          }
        />
        <Route
          path="/seat-stats"
          element={
            <Protected>
              <SeatStatsPage />
            </Protected>
          }
        />
        <Route
          path="/seat-allocation"
          element={
            <Protected>
              <SeatAllocationPage />
            </Protected>
          }
        />
        <Route
          path="/products"
          element={
            <Protected>
              <ProductsPage />
            </Protected>
          }
        />
        <Route
          path="/pricing"
          element={
            <Protected>
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
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
