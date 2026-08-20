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
  // 展示文本，原样印在海报上，不参与日期计算，故不做日期格式约束
  effectiveFrom: z.string().trim().max(30, '生效日期文案最多 30 字').optional(),
  baggageText: z.string().trim().max(40, '行李额文案最多 40 字').optional(),
  extraNote: z.string().trim().max(200, '补充要求最多 200 字').optional(),
});

export const listPostersQuerySchema = z.object({
  status: z.nativeEnum(MarketingPosterStatus).optional(),
  flightId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type CreateFlightRoutePosterBody = z.infer<typeof createFlightRoutePosterSchema>;
