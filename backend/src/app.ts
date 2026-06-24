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
import { waitlistRoutes } from './modules/waitlist/waitlist.routes.js';
import { hotelControlRoutes } from './modules/hotel-control/hotel-control.routes.js';
import { settlementRoutes } from './modules/settlements/settlements.routes.js';
import { productRoutes } from './modules/products/products.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { customerRoutes } from './modules/customers/customers.routes.js';
import { travelerRoutes } from './modules/travelers/travelers.routes.js';
import { fulfillmentRoutes } from './modules/fulfillment/fulfillment.routes.js';
import { paymentRoutes } from './modules/payments/payments.routes.js';
import { paymentChannelRoutes } from './modules/payment-channels/payment-channels.routes.js';
import { receiptRoutes } from './modules/receipts/receipts.routes.js';
import { publicRoutes } from './modules/public/public.routes.js';
import { pricingRoutes } from './modules/pricing/pricing.routes.js';
import { cancellationRoutes } from './modules/cancellation/cancellation.routes.js';
import { reminderRoutes } from './modules/reminders/reminders.routes.js';
import { financesRoutes } from './modules/finances/finances.routes.js';
import { aiRoutes } from './modules/ai/ai.routes.js';
import { reviewRoutes, orderReviewRoutes } from './modules/reviews/reviews.routes.js';
import { ocrRoutes } from './modules/ocr/ocr.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
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
    trustProxy: true,
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
    keyGenerator: (req) => `${req.ip}:${req.url}`,
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
  await app.register(orderCostItemRoutes, { prefix: '/orders' });
  await app.register(seatLockRoutes, { prefix: '/seat-locks' });
  await app.register(waitlistRoutes, { prefix: '/waitlist' });
  await app.register(hotelControlRoutes, { prefix: '/hotel-control' });
  await app.register(settlementRoutes, { prefix: '/settlements' });
  await app.register(productRoutes, { prefix: '/products' });
  await app.register(dashboardRoutes, { prefix: '/dashboard' });
  await app.register(auditRoutes, { prefix: '/audit-logs' });
  await app.register(customerRoutes, { prefix: '/customers' });
  await app.register(travelerRoutes, { prefix: '/travelers' });
  await app.register(fulfillmentRoutes, { prefix: '/fulfillment-tasks' });
  await app.register(paymentRoutes, { prefix: '/payments' });
  await app.register(paymentChannelRoutes, { prefix: '/payment-channels' });
  await app.register(receiptRoutes, { prefix: '/receipts' });
  await app.register(publicRoutes, { prefix: '/public' });
  await app.register(pricingRoutes, { prefix: '/pricing' });
  await app.register(cancellationRoutes, { prefix: '/cancellation-policies' });
  await app.register(reminderRoutes, { prefix: '/reminders' });
  await app.register(financesRoutes, { prefix: '/finances' });
  await app.register(aiRoutes, { prefix: '/ai' });
  await app.register(reviewRoutes, { prefix: '/reviews' });
  await app.register(ocrRoutes, { prefix: '/ocr' });
  await app.register(settingsRoutes, { prefix: '/settings' });

  // Root
  app.get('/', async () => ({
    name: 'flight-ticket-manager-backend',
    version: '0.1.0',
    env: env.NODE_ENV,
  }));

  return app;
}
