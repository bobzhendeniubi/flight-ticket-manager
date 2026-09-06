/**
 * 权限矩阵特征测试（characterization test）。
 *
 * 目的：把「现在每个（角色, 岗位）能进哪些端点」原样钉成快照，作为权限重构的安全网。
 * 这份测试不表达「应该怎样」，只记录「现在就是这样」——重构（把散落的 role 判断收敛成
 * 能力检查）期间，快照一格都不许变；真要改口径，必须单独一次提交、单独说明。
 *
 * 做法：注册全部路由模块（与 app.ts 同样的前缀），用 onRoute 抓下每条路由的 preHandler 链，
 * 然后对每个「主体」直接执行这条链——跳过 authenticate/optionalAuthenticate（它们要真 JWT 和
 * 真库），改为按主体直接注入 req.user / req.staffRole。抛错即拒绝，未抛即放行。
 * 因此这里测的是**真正的守卫函数**，而不是对守卫的重新描述：守卫行为一变，快照立刻变。
 *
 * 覆盖范围说明：本矩阵覆盖 preHandler 这一层（requireRole / requireFinanceAccess 及其它挂在
 * preHandler 上的守卫）。handler / service 内部的内联 403 判断不在这一层，由 capabilities.test.ts
 * 的内联闸表逐条对照兜底。
 */
import { describe, expect, it, vi } from 'vitest';
import { StaffRole, UserRole } from '@prisma/client';

// 路由模块只是被注册、不被调用（handler 永不执行），所以底层依赖给一个「怎么点都不炸」的
// 深层 Proxy 即可：任何属性都返回同样的 Proxy，被当函数调用时 resolve(null)。
const prismaMock = vi.hoisted(() => {
  const make = (): unknown =>
    new Proxy(function stub() {} as unknown as object, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined; // 别被 await 误当成 thenable
        return make();
      },
      apply: () => Promise.resolve(null),
    });
  return make();
});
vi.mock('../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../db/redis.js', () => ({ redis: prismaMock }));

import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from '../plugins/auth.js';
import { registerErrorHandler } from '../plugins/error-handler.js';

import { healthRoutes } from '../modules/health/health.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { userRoutes } from '../modules/users/users.routes.js';
import { flightRoutes } from '../modules/flights/flights.routes.js';
import { agentRoutes } from '../modules/agents/agents.routes.js';
import { agentStatementRoutes } from '../modules/agent-statements/agent-statements.routes.js';
import { orderRoutes } from '../modules/orders/orders.routes.js';
import { orderCostItemRoutes } from '../modules/orders/order-cost-items.routes.js';
import { seatLockRoutes } from '../modules/seat-locks/seat-locks.routes.js';
import { seatAllocationRoutes } from '../modules/seat-allocation/seat-allocation.routes.js';
import { holdOrderRoutes } from '../modules/hold-orders/hold-orders.routes.js';
import { waitlistRoutes } from '../modules/waitlist/waitlist.routes.js';
import { hotelControlRoutes } from '../modules/hotel-control/hotel-control.routes.js';
import { settlementRoutes } from '../modules/settlements/settlements.routes.js';
import { settlementRateRoutes } from '../modules/settlement-rates/settlement-rates.routes.js';
import { flightSettlementRateRoutes } from '../modules/settlement-rates/flight-settlement-rates.routes.js';
import { settlementDiscountRoutes } from '../modules/settlement-discounts/settlement-discounts.routes.js';
import { productRoutes } from '../modules/products/products.routes.js';
import { dashboardRoutes } from '../modules/dashboard/dashboard.routes.js';
import { auditRoutes } from '../modules/audit/audit.routes.js';
import { customerRoutes } from '../modules/customers/customers.routes.js';
import { travelerRoutes } from '../modules/travelers/travelers.routes.js';
import { fulfillmentRoutes } from '../modules/fulfillment/fulfillment.routes.js';
import { paymentRoutes } from '../modules/payments/payments.routes.js';
import { paymentChannelRoutes } from '../modules/payment-channels/payment-channels.routes.js';
import { agentRechargeRoutes } from '../modules/agent-recharges/agent-recharges.routes.js';
import { receiptRoutes } from '../modules/receipts/receipts.routes.js';
import { publicRoutes } from '../modules/public/public.routes.js';
import { cancellationRoutes } from '../modules/cancellation/cancellation.routes.js';
import { reminderRoutes } from '../modules/reminders/reminders.routes.js';
import { financesRoutes } from '../modules/finances/finances.routes.js';
import { aiRoutes } from '../modules/ai/ai.routes.js';
import { reviewRoutes, orderReviewRoutes } from '../modules/reviews/reviews.routes.js';
import {
  settlementRequestRoutes,
  orderSettlementRequestRoutes,
} from '../modules/settlement-requests/settlement-requests.routes.js';
import {
  bundleChangeRequestRoutes,
  orderBundleChangeRequestRoutes,
} from '../modules/bundle-change-requests/bundle-change-requests.routes.js';
import {
  orderChangeRequestRoutes,
  orderChangeRequestOrderRoutes,
} from '../modules/order-change-requests/order-change-requests.routes.js';
import { marketingRoutes } from '../modules/marketing/marketing.routes.js';
import { ocrRoutes } from '../modules/ocr/ocr.routes.js';
import { settingsRoutes } from '../modules/settings/settings.routes.js';
import { reportRoutes } from '../modules/reports/reports.routes.js';
import { legacyRoutes } from '../modules/legacy/legacy.routes.js';

type Guard = (req: unknown, reply: unknown) => unknown;

interface CapturedRoute {
  method: string;
  url: string;
  preHandlers: Guard[];
}

/** 被测主体：角色 × 岗位。staffRole=null 即「运营/通用岗」，是既有约定，必须原样保留。 */
const PRINCIPALS: Array<{ label: string; role: UserRole | null; staffRole: StaffRole | null }> = [
  { label: 'ADMIN', role: UserRole.ADMIN, staffRole: null },
  { label: 'STAFF:运营', role: UserRole.STAFF, staffRole: null },
  { label: 'STAFF:VISA_DESK', role: UserRole.STAFF, staffRole: StaffRole.VISA_DESK },
  { label: 'STAFF:TICKETING', role: UserRole.STAFF, staffRole: StaffRole.TICKETING },
  { label: 'STAFF:ROOM_CONTROL', role: UserRole.STAFF, staffRole: StaffRole.ROOM_CONTROL },
  { label: 'STAFF:FINANCE', role: UserRole.STAFF, staffRole: StaffRole.FINANCE },
  { label: 'AGENT', role: UserRole.AGENT, staffRole: null },
  { label: 'CUSTOMER', role: UserRole.CUSTOMER, staffRole: null },
  { label: 'ANON', role: null, staffRole: null },
];

async function buildRouteTable(): Promise<{ app: FastifyInstance; routes: CapturedRoute[] }> {
  const app = Fastify({ logger: false });
  const routes: CapturedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const raw = route.preHandler;
    const pre = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Guard[];
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routes.push({ method, url: route.url, preHandlers: pre });
    }
  });

  await app.register(authPlugin);
  registerErrorHandler(app);

  // 与 app.ts 保持同样的注册顺序与前缀。
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(flightRoutes, { prefix: '/flights' });
  await app.register(agentRoutes, { prefix: '/agents' });
  await app.register(agentStatementRoutes, { prefix: '/agents' });
  await app.register(orderRoutes, { prefix: '/orders' });
  await app.register(orderReviewRoutes, { prefix: '/orders' });
  await app.register(orderSettlementRequestRoutes, { prefix: '/orders' });
  await app.register(orderBundleChangeRequestRoutes, { prefix: '/orders' });
  await app.register(orderChangeRequestOrderRoutes, { prefix: '/orders' });
  await app.register(orderCostItemRoutes, { prefix: '/orders' });
  await app.register(seatLockRoutes, { prefix: '/seat-locks' });
  await app.register(seatAllocationRoutes, { prefix: '/seat-allocations' });
  await app.register(holdOrderRoutes, { prefix: '/hold-orders' });
  await app.register(waitlistRoutes, { prefix: '/waitlist' });
  await app.register(hotelControlRoutes, { prefix: '/hotel-control' });
  await app.register(settlementRoutes, { prefix: '/settlements' });
  await app.register(settlementRateRoutes, { prefix: '/settlement-rates' });
  await app.register(settlementDiscountRoutes, { prefix: '/settlement-discounts' });
  await app.register(settlementRequestRoutes, { prefix: '/settlement-requests' });
  await app.register(bundleChangeRequestRoutes, { prefix: '/bundle-change-requests' });
  await app.register(orderChangeRequestRoutes, { prefix: '/order-change-requests' });
  await app.register(flightSettlementRateRoutes, { prefix: '/flight-settlement-rates' });
  await app.register(productRoutes, { prefix: '/products' });
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.register(auditRoutes, { prefix: '/audit-logs' });
  await app.register(customerRoutes, { prefix: '/customers' });
  await app.register(travelerRoutes, { prefix: '/travelers' });
  await app.register(fulfillmentRoutes, { prefix: '/fulfillment-tasks' });
  await app.register(paymentRoutes, { prefix: '/payments' });
  await app.register(paymentChannelRoutes, { prefix: '/payment-channels' });
  await app.register(agentRechargeRoutes, { prefix: '/agent-recharges' });
  await app.register(receiptRoutes, { prefix: '/receipts' });
  await app.register(publicRoutes, { prefix: '/public' });
  await app.register(cancellationRoutes, { prefix: '/cancellation-policies' });
  await app.register(reminderRoutes, { prefix: '/reminders' });
  await app.register(financesRoutes, { prefix: '/finances' });
  await app.register(aiRoutes, { prefix: '/ai' });
  await app.register(reviewRoutes, { prefix: '/reviews' });
  await app.register(ocrRoutes, { prefix: '/ocr' });
  await app.register(marketingRoutes, { prefix: '/marketing' });
  await app.register(settingsRoutes, { prefix: '/settings' });
  await app.register(reportRoutes, { prefix: '/reports' });
  await app.register(legacyRoutes, { prefix: '/legacy' });

  await app.ready();
  return { app, routes };
}

/**
 * 对一条路由跑一个主体的守卫链。
 * authenticate / optionalAuthenticate 要真 JWT + 真库，这里按语义替身：
 * · authenticate         → 匿名一律 401（记 deny），已登录直接放行到下一环；
 * · optionalAuthenticate → 匿名也放行（游客路由），不影响后续角色守卫。
 */
async function verdictFor(
  app: FastifyInstance,
  route: CapturedRoute,
  principal: (typeof PRINCIPALS)[number],
): Promise<'allow' | 'deny'> {
  const req = {
    user:
      principal.role == null
        ? undefined
        : { sub: `u-${principal.role}`, role: principal.role, ver: 0 },
    staffRole: principal.staffRole,
    routeOptions: { url: route.url },
    headers: {},
  };
  const reply: Record<string, unknown> = {};
  reply.code = () => reply;
  reply.send = () => reply;
  reply.header = () => reply;

  for (const guard of route.preHandlers) {
    if (guard === (app.authenticate as unknown as Guard)) {
      if (principal.role == null) return 'deny'; // 401
      continue;
    }
    if (guard === (app.optionalAuthenticate as unknown as Guard)) continue;
    try {
      await guard(req, reply);
    } catch {
      return 'deny';
    }
  }
  return 'allow';
}

describe('权限矩阵（角色 × 岗位 → 端点放行）', () => {
  it('全部受保护端点的放行结果与快照一致', async () => {
    const { app, routes } = await buildRouteTable();

    // 只记录「带守卫」的端点：完全公开的路由（无任何 preHandler）不进矩阵。
    const guarded = routes.filter((r) => r.preHandlers.length > 0);

    const lines: string[] = [];
    for (const route of guarded) {
      const verdicts: string[] = [];
      for (const principal of PRINCIPALS) {
        verdicts.push(`${principal.label}=${await verdictFor(app, route, principal)}`);
      }
      lines.push(`${route.method.padEnd(6)} ${route.url} | ${verdicts.join(' ')}`);
    }
    lines.sort();

    await app.close();

    expect(lines.length).toBeGreaterThan(100);
    expect(lines.join('\n')).toMatchSnapshot();
  });

  it('矩阵覆盖了所有关键路由前缀（防止漏注册某个模块）', async () => {
    const { app, routes } = await buildRouteTable();
    const prefixes = new Set(routes.map((r) => r.url.split('/')[1] ?? ''));
    await app.close();
    // 抽查关键前缀，漏注册会让整块权限静默脱离矩阵覆盖。
    for (const p of ['orders', 'payments', 'finances', 'flights', 'users', 'settings']) {
      expect(prefixes).toContain(p);
    }
  });
});
