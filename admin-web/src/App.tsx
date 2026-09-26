import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { lazyPage, whenIdle } from './components/LazyPage';
// 登录页保持同步加载：未登录时的首屏、体积很小，懒加载反而多一次往返、多闪一下「加载中」。
import { LoginPage } from './pages/LoginPage';
import { useAuth } from './stores/auth';
import { isAccessTokenFresh } from './lib/token';
import { ConfirmProvider } from './components/ConfirmDialog';

// 其余页面按路由懒加载：各自打成独立文件，进哪个页面才下载哪个（失败兜底见 components/LazyPage）。
// 订单页同样懒加载——它一个就占原先整包的四分之一，放进入口会让每次发版都整块重下；
// 改为有会话后空闲预取（见下方 App 里的 whenIdle），从仪表盘点进订单基本不用等。
const DashboardPage = lazyPage(() => import('./pages/DashboardPage').then((m) => m.DashboardPage));
const OrdersPage = lazyPage(() => import('./pages/OrdersPage').then((m) => m.OrdersPage));
const FlightsPage = lazyPage(() => import('./pages/FlightsPage').then((m) => m.FlightsPage));
const SeatStatsPage = lazyPage(() => import('./pages/SeatStatsPage').then((m) => m.SeatStatsPage));
const SeatAllocationPage = lazyPage(() => import('./pages/SeatAllocationPage').then((m) => m.SeatAllocationPage));
const HoldOrdersPage = lazyPage(() => import('./pages/HoldOrdersPage').then((m) => m.HoldOrdersPage));
const ProductsPage = lazyPage(() => import('./pages/ProductsPage').then((m) => m.ProductsPage));
const AgentsPage = lazyPage(() => import('./pages/AgentsPage').then((m) => m.AgentsPage));
const AgentBalancePage = lazyPage(() => import('./pages/AgentBalancePage').then((m) => m.AgentBalancePage));
const CustomersPage = lazyPage(() => import('./pages/CustomersPage').then((m) => m.CustomersPage));
const TravelersPage = lazyPage(() => import('./pages/TravelersPage').then((m) => m.TravelersPage));
const AuditLogsPage = lazyPage(() => import('./pages/AuditLogsPage').then((m) => m.AuditLogsPage));
const StaffRolesPage = lazyPage(() => import('./pages/StaffRolesPage').then((m) => m.StaffRolesPage));
const ChangePasswordPage = lazyPage(() => import('./pages/ChangePasswordPage').then((m) => m.ChangePasswordPage));
const SettlementsPage = lazyPage(() => import('./pages/SettlementsPage').then((m) => m.SettlementsPage));
const SettlementRatesPage = lazyPage(() => import('./pages/SettlementRatesPage').then((m) => m.SettlementRatesPage));
const SettlementDiscountsPage = lazyPage(() =>
  import('./pages/SettlementDiscountsPage').then((m) => m.SettlementDiscountsPage),
);
const CancellationPoliciesPage = lazyPage(() =>
  import('./pages/CancellationPoliciesPage').then((m) => m.CancellationPoliciesPage),
);
const FinancesPage = lazyPage(() => import('./pages/FinancesPage').then((m) => m.FinancesPage));
const ReconciliationPage = lazyPage(() => import('./pages/ReconciliationPage').then((m) => m.ReconciliationPage));
const HotelControlPage = lazyPage(() => import('./pages/HotelControlPage').then((m) => m.HotelControlPage));
const VisaDeskPage = lazyPage(() => import('./pages/VisaDeskPage').then((m) => m.VisaDeskPage));
const AiOcrSettingsPage = lazyPage(() => import('./pages/AiOcrSettingsPage').then((m) => m.AiOcrSettingsPage));
const RemindersPage = lazyPage(() => import('./pages/RemindersPage').then((m) => m.RemindersPage));
const NoShowBatchPage = lazyPage(() => import('./pages/NoShowBatchPage').then((m) => m.NoShowBatchPage));
const NoShowReportPage = lazyPage(() => import('./pages/NoShowReportPage').then((m) => m.NoShowReportPage));
const ReportsPage = lazyPage(() => import('./pages/ReportsPage').then((m) => m.ReportsPage));
const FulfillmentBoardPage = lazyPage(() => import('./pages/FulfillmentBoardPage').then((m) => m.FulfillmentBoardPage));
const MarketingPage = lazyPage(() => import('./pages/MarketingPage').then((m) => m.MarketingPage));
const LegacyArchivePage = lazyPage(() => import('./pages/LegacyArchivePage').then((m) => m.LegacyArchivePage));

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
  financeRole = false,
}: {
  children: React.ReactNode;
  /** 只允许 ADMIN/STAFF；AGENT 重定向到自己的 landing 页 */
  adminOnly?: boolean;
  /**
   * 仅 ADMIN 或 STAFF+FINANCE（与 Layout 菜单的 financeRole 同口径）。
   * 数据保护仍在后端 requireFinanceAccess —— 这里只是让非财务岗 STAFF 直接敲 URL 时
   * 被路由级重定向回 landing，而不是渲染出一个 API 全 403 的报错空页。
   */
  financeRole?: boolean;
}) {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  if (!user || !tokens) return <Navigate to="/login" replace />;
  if (user.role === 'CUSTOMER') return <Navigate to="/login" replace />;

  // AGENT 禁入 admin-only 页 —— 落到默认 landing (/orders)
  if (adminOnly && user.role === 'AGENT') {
    return <Navigate to="/orders" replace />;
  }
  if (financeRole) {
    if (user.role === 'AGENT') return <Navigate to="/orders" replace />;
    // 登录瞬间 user 可能还没带 staffRole（等 /users/me 返回）：先放行渲染，数据由后端闸兜底；
    // staffRole 已知且不是财务岗才重定向，避免误伤刷新/首登场景。
    const denied = user.role === 'STAFF' && user.staffRole != null && user.staffRole !== 'FINANCE';
    if (denied) return <Navigate to="/dashboard" replace />;
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
// 每分钟体检一次，只有当 access token 进入「临期窗」（见 lib/token 的 REFRESH_SKEW_MS）才续期。
// 好处：刚登录 / token 还新时不做无谓轮换 —— 避免多标签/重复挂载并发轮换撞后端一次性轮换判定；
// 真正过期的那一刻由 apiFetch 的 401 静默续期兜底。
// 临期判断（isAccessTokenFresh）与 stores/auth.ts refreshSession 共用同一套 exp 解析口径。
const SESSION_CHECK_INTERVAL_MS = 60 * 1000;

export function App() {
  const hasSession = useAuth((s) => Boolean(s.tokens?.refreshToken));
  const refreshSession = useAuth((s) => s.refreshSession);

  useEffect(() => {
    if (!hasSession) return;

    // 只在临期时续期：新 token 不动，避免无谓（且可能并发）的刷新。
    const maybeRefresh = () => {
      if (!isAccessTokenFresh(useAuth.getState().tokens?.accessToken)) {
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

  // 订单页是绝大多数人的落地页：有会话后（含刚登录成功）趁空闲先把它的代码下好，
  // 从仪表盘点进订单不用再等下载。已经在订单页时与路由共用同一次下载，不会重复请求。
  useEffect(() => {
    if (!hasSession) return;
    return whenIdle(OrdersPage.preload);
  }, [hasSession]);

  return (
    <ConfirmProvider>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route
          path="/change-password"
          element={
            <Protected>
              <ChangePasswordPage />
            </Protected>
          }
        />
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
          path="/hold-orders"
          element={
            <Protected adminOnly>
              <HoldOrdersPage />
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
          path="/settlement-rates"
          element={
            <Protected adminOnly>
              <SettlementRatesPage />
            </Protected>
          }
        />
        <Route
          path="/settlement-discounts"
          element={
            <Protected adminOnly>
              <SettlementDiscountsPage />
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
            <Protected adminOnly financeRole>
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
          path="/reminders"
          element={
            <Protected adminOnly>
              <RemindersPage />
            </Protected>
          }
        />
        {/* no-show 两页：处理名单（导航挂运营组）+ 报表（挂报表附近），都是 ADMIN/STAFF 专属 */}
        <Route
          path="/no-show/report"
          element={
            <Protected adminOnly>
              <NoShowReportPage />
            </Protected>
          }
        />
        <Route
          path="/no-show"
          element={
            <Protected adminOnly>
              <NoShowBatchPage />
            </Protected>
          }
        />
        <Route
          path="/fulfillment-board"
          element={
            <Protected adminOnly>
              <FulfillmentBoardPage />
            </Protected>
          }
        />
        <Route
          path="/marketing"
          element={
            <Protected adminOnly>
              <MarketingPage />
            </Protected>
          }
        />
        <Route
          path="/reports"
          element={
            <Protected adminOnly financeRole>
              <ReportsPage />
            </Protected>
          }
        />
        <Route
          path="/legacy-archive"
          element={
            <Protected adminOnly>
              <LegacyArchivePage />
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
        <Route
          path="/settings/staff-roles"
          element={
            <Protected adminOnly>
              <StaffRolesPage />
            </Protected>
          }
        />
      </Route>
      <Route path="*" element={<AgentLanding />} />
      </Routes>
    </ConfirmProvider>
  );
}
