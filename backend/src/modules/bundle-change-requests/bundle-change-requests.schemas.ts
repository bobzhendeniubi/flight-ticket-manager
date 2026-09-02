/**
 * 套餐改档申请 · 入参校验。
 *
 * 代理只能提交目标套餐和申请说明，订单改档与重新计价必须等运营确认。
 */
import { BundleChangeRequestStatus } from '@prisma/client';
import { z } from 'zod';

export const createBundleChangeRequestBodySchema = z.object({
  bundleId: z.string().min(1),
  note: z.string().max(200, '申请说明最多 200 字').optional(),
});
export type CreateBundleChangeRequestBody = z.infer<typeof createBundleChangeRequestBodySchema>;

export const decideBundleChangeRequestBodySchema = z.object({
  note: z.string().max(200, '备注最多 200 字').optional(),
});
export type DecideBundleChangeRequestBody = z.infer<typeof decideBundleChangeRequestBodySchema>;

export const listBundleChangeRequestsQuerySchema = z.object({
  status: z.nativeEnum(BundleChangeRequestStatus).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListBundleChangeRequestsQuery = z.infer<typeof listBundleChangeRequestsQuerySchema>;
