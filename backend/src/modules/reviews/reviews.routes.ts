/**
 * 评价路由（D1）。
 *
 * GET  /reviews?productType=&productId=&page=&limit=   公开列表 + 汇总
 * POST /orders/:id/review                              订单后评价（登录可选）
 *
 * 注意：POST 走 /orders 前缀（在 app.ts 用 prefix:'/orders' 注册 orderReviewRoutes）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { ReviewsService } from './reviews.service.js';
import {
  createOrderReviewBodySchema,
  listReviewsQuerySchema,
} from './reviews.schemas.js';

const service = new ReviewsService();

// ── 公开评价列表（注册在 /reviews 前缀）──────────────────────────────
export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const query = listReviewsQuerySchema.parse(req.query);
    return service.listReviews(query);
  });
};

// ── 订单后提交评价（注册在 /orders 前缀）─────────────────────────────
export const orderReviewRoutes: FastifyPluginAsync = async (app) => {
  app.post('/:id/review', { preHandler: [app.optionalAuthenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createOrderReviewBodySchema.parse(req.body);
    const auth = req.user ? { userId: req.user.sub } : null;
    const result = await service.createOrderReview(id, body, auth);
    return reply.status(201).send(result);
  });
};
