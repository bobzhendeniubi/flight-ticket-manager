/**
 * 营销中心 · 海报 —— ADMIN/STAFF only
 *
 * GET    /marketing/templates          可选版式
 * GET    /marketing/posters            海报列表（**不含图**，只返元信息）
 * GET    /marketing/posters/:id        海报详情（含图 + 渲染元信息 + 三条文案）
 * POST   /marketing/posters/flight-route  生成航线海报（同步，可能耗时 1-3 分钟）
 * DELETE /marketing/posters/:id        删除
 *
 * ⚠️ 生成接口耗时长（最多 3 轮出图，每轮约 30-60s，极端情况数分钟）。
 * 当前预发布环境使用 Caddy，reverse_proxy 默认没有响应超时，可直接使用。
 * 若将来改用 nginx 或在前面加了其它网关，需要相应放宽读超时。
 *
 * 列表为什么不返图：一张 1080×1440 的 PNG 转 data URL 约 3MB，20 条就是 60MB，
 * 列表接口会直接被撑爆。前端列表只显示名称/状态/时间，点进详情才拉图。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AuditTargetType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { POSTER_TEMPLATES } from './marketing.templates.js';
import {
  createFlightRoutePosterSchema,
  listPostersQuerySchema,
} from './marketing.schemas.js';
import { MarketingInputError } from './marketing.facts.js';
import { createFlightRoutePoster, MarketingConfigError } from './marketing.service.js';

export const marketingRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };

  app.get('/templates', requireOps, async () => ({ templates: POSTER_TEMPLATES }));

  app.get('/posters', requireOps, async (req) => {
    const q = listPostersQuerySchema.parse(req.query);
    const where: Prisma.MarketingPosterWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.flightId) where.flightId = q.flightId;

    const [rows, total] = await prisma.$transaction([
      prisma.marketingPoster.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        // 显式列白名单：imageDataUrl 绝不进列表
        select: {
          id: true,
          kind: true,
          status: true,
          title: true,
          flightId: true,
          templateKey: true,
          attempts: true,
          createdAt: true,
          createdBy: { select: { id: true, displayName: true } },
        },
      }),
      prisma.marketingPoster.count({ where }),
    ]);

    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  });

  app.get<{ Params: { id: string } }>('/posters/:id', requireOps, async (req, reply) => {
    const row = await prisma.marketingPoster.findUnique({
      where: { id: req.params.id },
      include: { createdBy: { select: { id: true, displayName: true } } },
    });
    if (!row) return reply.notFound('海报不存在');
    return row;
  });

  app.post(
    '/posters/flight-route',
    requireOps,
    async (req, reply) => {
      const body = createFlightRoutePosterSchema.parse(req.body);

      try {
        const poster = await createFlightRoutePoster({
          ...body,
          createdById: req.user.sub,
        });

        await writeAudit({
          actor: actorFromRequest(req),
          action: 'CREATE_MARKETING_POSTER',
          targetType: AuditTargetType.MARKETING,
          targetId: poster.id,
          targetLabel: poster.title,
          after: { status: poster.status, attempts: poster.attempts },
        });

        return poster;
      } catch (err) {
        if (err instanceof MarketingConfigError) {
          return reply.status(400).send({
            error: { code: 'AI_NOT_CONFIGURED', message: err.message },
          });
        }
        if (err instanceof MarketingInputError) {
          return reply.status(400).send({
            error: { code: 'INVALID_MARKETING_INPUT', message: err.message },
          });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/posters/:id', requireOps, async (req, reply) => {
    const row = await prisma.marketingPoster.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true },
    });
    if (!row) return reply.notFound('海报不存在');

    await prisma.marketingPoster.delete({ where: { id: row.id } });
    await writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_MARKETING_POSTER',
      targetType: AuditTargetType.MARKETING,
      targetId: row.id,
      targetLabel: row.title,
    });

    return { ok: true };
  });
};
