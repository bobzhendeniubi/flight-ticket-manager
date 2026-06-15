import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { DetailSkeleton } from './components/LoadingSkeleton';
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './stores/auth';
import type { UserRole } from './lib/api';

// 路由级代码分割（G1）：每个页面单独 chunk，按需加载，缩小首屏 bundle。
// Layout 不 lazy（外壳要立即渲染）；LoginPage 保持 eager（独立全屏入口）。
const HomePage = lazy(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage })));
const ProfilePage = lazy(() => import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const TeamPage = lazy(() => import('./pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const MyCommissionsPage = lazy(() =>
  import('./pages/MyCommissionsPage').then((m) => ({ default: m.MyCommissionsPage })),
);
const HotelsPage = lazy(() => import('./pages/HotelsPage').then((m) => ({ default: m.HotelsPage })));
const TransfersPage = lazy(() =>
  import('./pages/TransfersPage').then((m) => ({ default: m.TransfersPage })),
);
const VisasPage = lazy(() => import('./pages/VisasPage').then((m) => ({ default: m.VisasPage })));
const BundlesPage = lazy(() =>
  import('./pages/BundlesPage').then((m) => ({ default: m.BundlesPage })),
);
const CartPage = lazy(() => import('./pages/CartPage').then((m) => ({ default: m.CartPage })));
const CheckoutPage = lazy(() =>
  import('./pages/CheckoutPage').then((m) => ({ default: m.CheckoutPage })),
);
const MyOrdersPage = lazy(() =>
  import('./pages/MyOrdersPage').then((m) => ({ default: m.MyOrdersPage })),
);
const AdminFlightsPage = lazy(() =>
  import('./pages/AdminFlightsPage').then((m) => ({ default: m.AdminFlightsPage })),
);
const AdminDashboardPage = lazy(() =>
  import('./pages/admin/DashboardPage').then((m) => ({ default: m.AdminDashboardPage })),
);
const AdminOrdersPage = lazy(() =>
  import('./pages/admin/OrdersPage').then((m) => ({ default: m.AdminOrdersPage })),
);
const AdminPricingPage = lazy(() =>
  import('./pages/admin/PricingPage').then((m) => ({ default: m.AdminPricingPage })),
);

// 新增公开页（详情/搜索/帮助/查单/404）—— 默认导出，直接 lazy。
const BundleDetailPage = lazy(() => import('./pages/BundleDetailPage'));
const HotelDetailPage = lazy(() => import('./pages/HotelDetailPage'));
const TransferDetailPage = lazy(() => import('./pages/TransferDetailPage'));
const VisaDetailPage = lazy(() => import('./pages/VisaDetailPage'));
const FlightDetailPage = lazy(() => import('./pages/FlightDetailPage'));
const SearchResultsPage = lazy(() => import('./pages/SearchResultsPage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const ContactPage = lazy(() => import('./pages/ContactPage'));
const LookupOrderPage = lazy(() => import('./pages/LookupOrderPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

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

/** /bundles → /：保留 ?kw= 等查询参数的兼容跳转 */
function BundlesRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/', search }} replace />;
}

/** 懒加载路由的加载兜底（居中骨架，避免切页白屏） */
function RouteFallback() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <DetailSkeleton />
    </div>
  );
}

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
    <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* 登录是独立全屏页（沉浸式海岛 split），不套前台外壳 */}
          <Route path="login" element={<LoginPage />} />
          <Route element={<Layout />}>
            {/* 前台 — 所有人可见。套餐落地页是首页（运营要求：套餐主推、默认首屏） */}
            <Route index element={<BundlesPage />} />
            <Route path="flights" element={<HomePage />} />
            {/* 旧链接 /bundles → 落地页，保持向后兼容（保留 ?kw= 等查询参数） */}
            <Route path="bundles" element={<BundlesRedirect />} />
            <Route path="hotels" element={<HotelsPage />} />
            <Route path="transfers" element={<TransfersPage />} />
            <Route path="visas" element={<VisasPage />} />
            <Route path="cart" element={<CartPage />} />
            <Route path="checkout" element={<CheckoutPage />} />

            {/* 产品详情（卡片点进来）+ 搜索 + 内容页 + 公开查单 */}
            <Route path="bundles/:id" element={<BundleDetailPage />} />
            <Route path="hotels/:id" element={<HotelDetailPage />} />
            <Route path="transfers/:id" element={<TransferDetailPage />} />
            <Route path="visas/:id" element={<VisaDetailPage />} />
            <Route path="flights/:id" element={<FlightDetailPage />} />
            <Route path="search" element={<SearchResultsPage />} />
            <Route path="help" element={<HelpPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="contact" element={<ContactPage />} />
            <Route path="lookup" element={<LookupOrderPage />} />

            {/* 认证（login 已提到外层全屏路由） */}
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

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
