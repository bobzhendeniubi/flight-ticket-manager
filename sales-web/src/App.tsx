import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { ProfilePage } from './pages/ProfilePage';
import { TeamPage } from './pages/TeamPage';
import { MyCommissionsPage } from './pages/MyCommissionsPage';
import { HotelsPage } from './pages/HotelsPage';
import { TransfersPage } from './pages/TransfersPage';
import { VisasPage } from './pages/VisasPage';
import { BundlesPage } from './pages/BundlesPage';
import { CartPage } from './pages/CartPage';
import { CheckoutPage } from './pages/CheckoutPage';
import { MyOrdersPage } from './pages/MyOrdersPage';
import { AdminFlightsPage } from './pages/AdminFlightsPage';
import { AdminDashboardPage } from './pages/admin/DashboardPage';
import { AdminOrdersPage } from './pages/admin/OrdersPage';
import { AdminPricingPage } from './pages/admin/PricingPage';
import { useAuth } from './stores/auth';
import type { UserRole } from './lib/api';

function Protected({
  children,
  roles,
}: {
  children: React.ReactNode;
  roles?: UserRole[];
}) {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

// access token TTL=1h；提前到 50 分钟续期，避免闲置掉登录
const REFRESH_INTERVAL_MS = 50 * 60 * 1000;

export function App() {
  const hasSession = useAuth((s) => Boolean(s.tokens?.refreshToken));
  const refreshSession = useAuth((s) => s.refreshSession);

  useEffect(() => {
    if (!hasSession) return;
    // 刷新进页面（重载/久置回来）先续一次，再定时续
    void refreshSession();
    const id = setInterval(() => void refreshSession(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasSession, refreshSession]);

  return (
    <Routes>
      <Route element={<Layout />}>
        {/* 前台 — 所有人可见 */}
        <Route index element={<HomePage />} />
        <Route path="hotels" element={<HotelsPage />} />
        <Route path="transfers" element={<TransfersPage />} />
        <Route path="visas" element={<VisasPage />} />
        <Route path="bundles" element={<BundlesPage />} />
        <Route path="cart" element={<CartPage />} />
        <Route path="checkout" element={<CheckoutPage />} />

        {/* 认证 */}
        <Route path="login" element={<LoginPage />} />
        {/* 注册由销售代理后台为客户开通，前台不再开放自助注册 */}
        <Route path="register" element={<Navigate to="/login" replace />} />
        <Route
          path="me"
          element={
            <Protected>
              <ProfilePage />
            </Protected>
          }
        />
        <Route
          path="orders"
          element={
            <Protected>
              <MyOrdersPage />
            </Protected>
          }
        />

        {/* 代理 */}
        <Route
          path="team"
          element={
            <Protected roles={['AGENT', 'ADMIN', 'STAFF']}>
              <TeamPage />
            </Protected>
          }
        />
        <Route
          path="my-commissions"
          element={
            <Protected roles={['AGENT', 'ADMIN', 'STAFF']}>
              <MyCommissionsPage />
            </Protected>
          }
        />

        {/* 后台 admin */}
        <Route
          path="admin/dashboard"
          element={
            <Protected roles={['ADMIN', 'STAFF']}>
              <AdminDashboardPage />
            </Protected>
          }
        />
        <Route
          path="admin/orders"
          element={
            <Protected roles={['ADMIN', 'STAFF']}>
              <AdminOrdersPage />
            </Protected>
          }
        />
        <Route
          path="admin/flights"
          element={
            <Protected roles={['ADMIN', 'STAFF']}>
              <AdminFlightsPage />
            </Protected>
          }
        />
        <Route
          path="admin/pricing"
          element={
            <Protected roles={['ADMIN', 'STAFF']}>
              <AdminPricingPage />
            </Protected>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
