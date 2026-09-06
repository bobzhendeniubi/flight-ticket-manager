import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { OrdersPage } from './pages/OrdersPage';
import { FlightsPage } from './pages/FlightsPage';
import { SeatStatsPage } from './pages/SeatStatsPage';
import { SeatAllocationPage } from './pages/SeatAllocationPage';
import { HoldOrdersPage } from './pages/HoldOrdersPage';
import { ProductsPage } from './pages/ProductsPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentBalancePage } from './pages/AgentBalancePage';
import { CustomersPage } from './pages/CustomersPage';
import { TravelersPage } from './pages/TravelersPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { StaffRolesPage } from './pages/StaffRolesPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { SettlementsPage } from './pages/SettlementsPage';
import { SettlementRatesPage } from './pages/SettlementRatesPage';
import { SettlementDiscountsPage } from './pages/SettlementDiscountsPage';
import { CancellationPoliciesPage } from './pages/CancellationPoliciesPage';
import { FinancesPage } from './pages/FinancesPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { HotelControlPage } from './pages/HotelControlPage';
import { VisaDeskPage } from './pages/VisaDeskPage';
import { AiOcrSettingsPage } from './pages/AiOcrSettingsPage';
import { FeatureFlagsSettingsPage } from './pages/FeatureFlagsSettingsPage';
import { RemindersPage } from './pages/RemindersPage';
import { NoShowBatchPage } from './pages/NoShowBatchPage';
import { TicketBackfillPage } from './pages/TicketBackfillPage';
import { NoShowReportPage } from './pages/NoShowReportPage';
import { ReportsPage } from './pages/ReportsPage';
import { FulfillmentBoardPage } from './pages/FulfillmentBoardPage';
import { MarketingPage } from './pages/MarketingPage';
import { ExportCenterPage } from './pages/ExportCenterPage';
import { LegacyArchivePage } from './pages/LegacyArchivePage';
import { useAuth } from './stores/auth';
import { useCapabilities } from './hooks/useCapabilities';
import type { Capability } from './lib/capabilities';
import { isAccessTokenFresh } from './lib/token';
import { ConfirmProvider } from './components/ConfirmDialog';

function Protected({
  children,
  cap,
}: {
  children: React.ReactNode;
  /**
   * 进这个页面需要的能力。不填 = 只要登录（且不是客户）就能进。
   *
   * 口径与后端同源：能力清单由 /users/me 下发，与后端 requireCapability 用同一张表算
   * （见 backend/src/lib/capabilities.ts）。改造前这里是 adminOnly / financeRole 两个布尔，
   * 各自把「谁能进」在前端又拼了一遍，后端改口径这边不会跟着变——8/24 只改后端半边、
   * 运营那头按钮还是灰的，就是这么来的。
   *
   * 真正的数据保护始终在后端；这里只是别让人直接敲 URL 撞进一个 API 全 403 的空页。
   */
  cap?: Capability;
}) {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const { can, ready } = useCapabilities();

  if (!user || !tokens) return <Navigate to="/login" replace />;
  if (user.role === 'CUSTOMER') return <Navigate to="/login" replace />;

  // 登录瞬间能力清单还没从 /users/me 回来：先放行渲染，数据由后端闸兜底。
  // 乐观放行是有意的——悲观拦截会让每次登录/刷新都先闪一下重定向。
  // 与改造前「staffRole 还没回来就先放行」是同一条口径。
  if (!cap || !ready) return <>{children}</>;

  if (!can(cap)) {
    // 没这个能力就回各自的落地页，而不是甩一个空白报错页。
    return <Navigate to={user.role === 'AGENT' ? '/orders' : '/dashboard'} replace />;
  }
  return <>{children}</>;
}

function AgentLanding() {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  // AGENT 默认落地到订单页（没有 dashboard 权限）；ADMIN/STAFF 走 dashboard
  return <Navigate to={user.role === 'AGENT' ? '/orders' : '/dashboard'} replace />;
}


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
            <Protected cap="dashboard.view">
              <DashboardPage />
            </Protected>
          }
        />
        <Route
          path="/orders"
          element={
            <Protected cap="orders.read">
              <OrdersPage />
            </Protected>
          }
        />
        <Route
          path="/flights"
          element={
            <Protected cap="flights.admin_view">
              <FlightsPage />
            </Protected>
          }
        />
        <Route
          path="/seat-stats"
          element={
            <Protected cap="flights.seat_stats.view">
              <SeatStatsPage />
            </Protected>
          }
        />
        <Route
          path="/seat-allocation"
          element={
            <Protected cap="seat_allocation.manage">
              <SeatAllocationPage />
            </Protected>
          }
        />
        <Route
          path="/hold-orders"
          element={
            <Protected cap="hold_orders.manage">
              <HoldOrdersPage />
            </Protected>
          }
        />
        <Route
          path="/products"
          element={
            <Protected cap="products.write">
              <ProductsPage />
            </Protected>
          }
        />
        <Route
          path="/settlement-rates"
          element={
            <Protected cap="settlement_rates.write">
              <SettlementRatesPage />
            </Protected>
          }
        />
        <Route
          path="/settlement-discounts"
          element={
            <Protected cap="settlement_discounts.write">
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
            <Protected cap="agents.read">
              <AgentsPage />
            </Protected>
          }
        />
        <Route
          path="/customers"
          element={
            <Protected cap="customers.manage">
              <CustomersPage />
            </Protected>
          }
        />
        <Route
          path="/travelers"
          element={
            <Protected cap="travelers.manage">
              <TravelersPage />
            </Protected>
          }
        />
        <Route
          path="/cancellation-policies"
          element={
            <Protected cap="cancellation_policies.manage">
              <CancellationPoliciesPage />
            </Protected>
          }
        />
        <Route
          path="/audit-logs"
          element={
            <Protected cap="audit.read">
              <AuditLogsPage />
            </Protected>
          }
        />
        <Route
          path="/settlements"
          element={
            <Protected cap="settlements.read">
              <SettlementsPage />
            </Protected>
          }
        />
        <Route
          path="/agent-balance"
          element={
            <Protected cap="agent_recharges.submit">
              <AgentBalancePage />
            </Protected>
          }
        />
        <Route
          path="/finances"
          element={
            <Protected cap="finances.view">
              <FinancesPage />
            </Protected>
          }
        />
        <Route
          path="/reconciliation"
          element={
            <Protected cap="receipts.manage">
              <ReconciliationPage />
            </Protected>
          }
        />
        <Route
          path="/hotel-control"
          element={
            <Protected cap="hotel_control.view">
              <HotelControlPage />
            </Protected>
          }
        />
        <Route
          path="/visa-desk"
          element={
            <Protected cap="fulfillment.manage">
              <VisaDeskPage />
            </Protected>
          }
        />
        <Route
          path="/reminders"
          element={
            <Protected cap="reminders.manage">
              <RemindersPage />
            </Protected>
          }
        />
        {/* no-show 两页：处理名单（导航挂运营组）+ 报表（挂报表附近），都是 ADMIN/STAFF 专属 */}
        <Route
          path="/no-show/report"
          element={
            <Protected cap="orders.no_show">
              <NoShowReportPage />
            </Protected>
          }
        />
        <Route
          path="/no-show"
          element={
            <Protected cap="orders.no_show">
              <NoShowBatchPage />
            </Protected>
          }
        />
        {/* 票号批量回填：出票代理回名单后，票务岗整班灌真实 PNR/票号（单人改走订单详情乘客卡）。 */}
        <Route
          path="/ticket-backfill"
          element={
            <Protected cap="orders.passengers.write">
              <TicketBackfillPage />
            </Protected>
          }
        />
        <Route
          path="/fulfillment-board"
          element={
            <Protected cap="fulfillment.manage">
              <FulfillmentBoardPage />
            </Protected>
          }
        />
        <Route
          path="/marketing"
          element={
            <Protected cap="marketing.manage">
              <MarketingPage />
            </Protected>
          }
        />
        {/* 导出中心：全角色可进（含代理），页面内部按角色只列本人能用的导出；
            真正的权限闸在后端，前端只做导航 UX。 */}
        <Route
          path="/exports"
          element={
            <Protected cap="orders.export.shared">
              <ExportCenterPage />
            </Protected>
          }
        />
        <Route
          path="/reports"
          element={
            <Protected cap="reports.view">
              <ReportsPage />
            </Protected>
          }
        />
        <Route
          path="/legacy-archive"
          element={
            <Protected cap="legacy.read">
              <LegacyArchivePage />
            </Protected>
          }
        />
        <Route
          path="/settings/ai-ocr"
          element={
            <Protected cap="settings.ai_ocr.manage">
              <AiOcrSettingsPage />
            </Protected>
          }
        />
        <Route
          path="/settings/feature-flags"
          element={
            <Protected cap="feature_flags.read">
              <FeatureFlagsSettingsPage />
            </Protected>
          }
        />
        <Route
          path="/settings/staff-roles"
          element={
            <Protected cap="users.staff.manage">
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
