/**
 * 营销中心入参校验。
 */
import { z } from 'zod';
import { MarketingPosterStatus } from '@prisma/client';
import { POSTER_TEMPLATE_KEYS } from './marketing.templates.js';

export const createFlightRoutePosterSchema = z.object({
  title: z.string().trim().min(1, '请填写海报名称').max(60, '名称最多 60 字'),
  outboundScheduleId: z.string().min(1, '请选择去程班次'),
  returnScheduleId: z.string().min(1).optional(),
  templateKey: z.enum(POSTER_TEMPLATE_KEYS, { errorMap: () => ({ message: '请选择有效版式' }) }),
  headline: z.string().trim().max(20, '主标题最多 20 字').optional(),
  subtitle: z.string().trim().max(20, '副标题最多 20 字').default('黄金时刻·每天一班'),
  slogan: z.string().trim().max(30, '标语最多 30 字').optional(),
  highlights: z.array(z.string().trim().max(20, '卖点每条最多 20 字')).max(3, '卖点最多 3 条').default([
    '安全出行·严苛保障',
    '舒适日间·尊享旅程',
    '高标准飞行保障·贴心服务',
  ]),
  ctaLine1: z.string().trim().max(30, '底部文案最多 30 字').optional(),
  ctaLine2: z.string().trim().max(30, '底部文案最多 30 字').default('即刻预订，享黄金时刻优惠'),
  baggageText: z.string().trim().max(40, '行李额文案最多 40 字').optional(),
  // 旧版字段保留兼容已有调用；新版海报标题由去程日期自动生成，不再依赖它。
  effectiveFrom: z.string().trim().max(30, '生效日期文案最多 30 字').optional(),
  extraNote: z.string().trim().max(200, '补充要求最多 200 字').optional(),
});

export const listPostersQuerySchema = z.object({
  status: z.nativeEnum(MarketingPosterStatus).optional(),
  flightId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type CreateFlightRoutePosterBody = z.infer<typeof createFlightRoutePosterSchema>;
