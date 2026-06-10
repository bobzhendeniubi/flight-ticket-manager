/**
 * 候补路由 — 舱位售罄/余票不足时登记候补，座位释放后按先来先到通知。
 *
 * POST   /waitlist          登记候补（任意登录用户；余票充足时拒绝）
 * GET    /waitlist/mine     我的候补（含航班号/起飞时间/舱等/状态）
 * GET    /waitlist?scheduleId=  某班次候补名单（ADMIN/STAFF，含用户联系方式）
 * DELETE /waitlist/:id      取消候补（本人或 ADMIN/STAFF）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { WaitlistService } from './waitlist.service.js';
import { createWaitlistBodySchema, listWaitlistQuerySchema } from './waitlist.schemas.js';

export const waitlistRoutes: FastifyPluginAsync = async (app) => {
  const service = new WaitlistService();

  // ── 登记候补 ────────────────────────────────────────────────────
  app.post(
    '/',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const body = createWaitlistBodySchema.parse(req.body);
      const entry = await service.createEntry(body, req.user.sub);
      return reply.status(201).send({ entry });
    },
  );

  // ── 我的候补 ────────────────────────────────────────────────────
  app.get(
    '/mine',
    { preHandler: [app.authenticate] },
    async (req) => {
      const entries = await service.listMyEntries(req.user.sub);
      return { entries };
    },
  );

  // ── 运营：某班次候补名单（电话回访用） ──────────────────────────
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const q = listWaitlistQuerySchema.parse(req.query);
      const entries = await service.listBySchedule(q.scheduleId);
      return { entries };
    },
  );

  // ── 取消候补 ────────────────────────────────────────────────────
  app.delete(
    '/:id',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const result = await service.cancelEntry(id, {
        userId: req.user.sub,
        role: req.user.role,
      });
      return { result };
    },
  );
};
