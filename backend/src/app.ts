import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { corsOrigins, env } from './config/env.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { authPlugin } from './plugins/auth.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { userRoutes } from './modules/users/users.routes.js';
import { flightRoutes } from './modules/flights/flights.routes.js';
import { agentRoutes } from './modules/agents/agents.routes.js';
import { orderRoutes } from './modules/orders/orders.routes.js';
import { orderCostItemRoutes } from './modules/orders/order-cost-items.routes.js';
import { seatLockRoutes } from './modules/seat-locks/seat-locks.routes.js';
import { seatAllocationRoutes } from './modules/seat-allocation/seat-allocation.routes.js';
import { holdOrderRoutes } from './modules/hold-orders/hold-orders.routes.js';
import { waitlistRoutes } from './modules/waitlist/waitlist.routes.js';
import { hotelControlRoutes } from './modules/hotel-control/hotel-control.routes.js';
import { settlementRoutes } from './modules/settlements/settlements.routes.js';
import { settlementRateRoutes } from './modules/settlement-rates/settlement-rates.routes.js';
import { flightSettlementRateRoutes } from './modules/settlement-rates/flight-settlement-rates.routes.js';
import { settlementDiscountRoutes } from './modules/settlement-discounts/settlement-discounts.routes.js';
import { productRoutes } from './modules/products/products.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { customerRoutes } from './modules/customers/customers.routes.js';
import { travelerRoutes } from './modules/travelers/travelers.routes.js';
import { fulfillmentRoutes } from './modules/fulfillment/fulfillment.routes.js';
import { paymentRoutes } from './modules/payments/payments.routes.js';
import { paymentChannelRoutes } from './modules/payment-channels/payment-channels.routes.js';
import { agentRechargeRoutes } from './modules/agent-recharges/agent-recharges.routes.js';
import { receiptRoutes } from './modules/receipts/receipts.routes.js';
import { publicRoutes } from './modules/public/public.routes.js';
import { cancellationRoutes } from './modules/cancellation/cancellation.routes.js';
import { reminderRoutes } from './modules/reminders/reminders.routes.js';
import { financesRoutes } from './modules/finances/finances.routes.js';
import { aiRoutes } from './modules/ai/ai.routes.js';
import { reviewRoutes, orderReviewRoutes } from './modules/reviews/reviews.routes.js';
import {
  settlementRequestRoutes,
  orderSettlementRequestRoutes,
} from './modules/settlement-requests/settlement-requests.routes.js';
import { marketingRoutes } from './modules/marketing/marketing.routes.js';
import { ocrRoutes } from './modules/ocr/ocr.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { legacyRoutes } from './modules/legacy/legacy.routes.js';
import { redis } from './db/redis.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // 收款凭证 / 收款码二维码以 data-URL（base64）形式上传，Zod 上限约 6MB；
    // Fastify 默认 bodyLimit 仅 1MB 会直接拒掉这类请求（公开上传 + 后台人工确认收款截图）。
    // 全局放宽到 8MB（> 6MB cap + JSON 包裹开销）；本应用整体 auth + 限流，全局放宽是安全的。
    bodyLimit: 8 * 1024 * 1024,
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    disableRequestLogging: false,
    // 只信任离我们最近的一跳反代（nginx）注入的 X-Forwarded-For；跳数必须与实际反代拓扑一致，
    // 否则 req.ip 可能仍取到客户端可伪造的值。此前是 `true`（信任整条 XFF 链），
    // 客户端随便追加一段自定义 XFF 就能让 req.ip 跟着变，从而绕过所有按 IP 限流
    // （登录爆破、订单号枚举）。若未来在 nginx 前再加一层反代/CDN，这里要同步改成对应跳数。
    trustProxy: 1,
  });

  // Core plugins
  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis,
    // 按路由模式（而非完整 URL）分桶：req.url 带 query string，之前用 req.url 会导致
    // 每个不同的 query 值（如 ?orderNumber=xxx）都落到不同的桶，等于绕过了限流。
    keyGenerator: (req) => `${req.ip}:${req.routeOptions?.url ?? req.url}`,
  });

  // Auth decorators
  await app.register(authPlugin);

  // Error handler
  registerErrorHandler(app);

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(flightRoutes, { prefix: '/flights' });
  await app.register(agentRoutes, { prefix: '/agents' });
  await app.register(orderRoutes, { prefix: '/orders' });
  await app.register(orderReviewRoutes, { prefix: '/orders' });
  await app.register(orderSettlementRequestRoutes, { prefix: '/orders' });
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

  // Root
  app.get('/', async () => ({
    name: 'flight-ticket-manager-backend',
    version: '0.1.0',
    env: env.NODE_ENV,
  }));

  return app;
}
