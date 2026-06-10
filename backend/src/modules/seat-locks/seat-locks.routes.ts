/**
 * 锁位路由 — 下单前临时占座（单次 ≤9 张 / 固定 10 分钟 / 到期自动回收）。
 *
 * POST   /seat-locks        创建锁位（任意登录用户）
 * GET    /seat-locks/mine   我的 ACTIVE 锁位（含航班号/起飞时间/舱等/倒计时基准）
 * DELETE /seat-locks/:id    释放锁位（本人或 ADMIN/STAFF）
 */
import type { FastifyPluginAsync } from 'fastify';
import { SeatLockService } from './seat-locks.service.js';
import { createSeatLockBodySchema } from './seat-locks.schemas.js';

export const seatLockRoutes: FastifyPluginAsync = async (app) => {
  const service = new SeatLockService();

  // ── 创建锁位 ────────────────────────────────────────────────────
  app.post(
    '/',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const body = createSeatLockBodySchema.parse(req.body);
      const lock = await service.createLock(body, req.user.sub);
      return reply.status(201).send({ lock });
    },
  );

  // ── 我的锁位 ────────────────────────────────────────────────────
  app.get(
    '/mine',
    { preHandler: [app.authenticate] },
    async (req) => {
      const locks = await service.listMyLocks(req.user.sub);
      return { locks };
    },
  );

  // ── 释放锁位 ────────────────────────────────────────────────────
  app.delete(
    '/:id',
    { preHandler: [app.authenticate] },
    async (req) => {
      const { id } = req.params as { id: string };
      const result = await service.releaseLock(id, {
        userId: req.user.sub,
        role: req.user.role,
      });
      return { result };
    },
  );
};
