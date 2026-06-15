/**
 * 评价模块 schema（D1）。
 *
 * - 列表查询：?productType=&productId=&page=&limit=（公开）
 * - 订单后提交：POST /orders/:id/review（登录可选；游客需 orderNumber+phone）
 */
import { z } from 'zod';
import { ProductReviewType } from '@prisma/client';

// ── 列表查询 ─────────────────────────────────────────────────────────────
export const listReviewsQuerySchema = z.object({
  productType: z.nativeEnum(ProductReviewType),
  productId: z.string().min(1).max(80),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

// ── 订单后提交评价 ───────────────────────────────────────────────────────
// 登录用户：仅需评分 + 正文（订单归属由 token 校验）。
// 游客：另需 orderNumber + phone 与订单匹配（防越权评价他人订单）。
export const createOrderReviewBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().max(120).optional(),
  body: z.string().min(1).max(2000),
  tripType: z.string().max(40).optional(),
  // 评价针对订单里的哪个产品；缺省时对订单里全部可评产品各建一条
  productType: z.nativeEnum(ProductReviewType).optional(),
  productId: z.string().min(1).max(80).optional(),
  // 游客校验（免登录提交时必填）
  orderNumber: z.string().min(3).max(40).optional(),
  phone: z.string().min(3).max(40).optional(),
});
export type CreateOrderReviewBody = z.infer<typeof createOrderReviewBodySchema>;
