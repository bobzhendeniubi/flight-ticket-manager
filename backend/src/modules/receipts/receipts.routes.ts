/**
 * 收款对账台 / 挂账池路由（ADMIN/STAFF）。
 *
 * 注册前缀 /receipts：
 *   GET  /receipts?status=&q=     挂账池列表（含 remaining + 认领明细）
 *   GET  /receipts/ledger         总账（合并 Receipts + 近期订单 Payments）
 *   POST /receipts                登记新进账（OPEN）
 *   POST /receipts/:id/allocate   认领到订单（原子）
 *   POST /receipts/:id/refund     退款剩余未认领部分
 *
 * 审计在 service 层按资金口径写（REGISTER/ALLOCATE/REFUND_RECEIPT）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { ReceiptsService } from './receipts.service.js';
import {
  allocateReceiptSchema,
  listReceiptsQuerySchema,
  refundReceiptSchema,
  registerReceiptSchema,
} from './receipts.schemas.js';

export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const service = new ReceiptsService();
  const requireAdminOrStaff = app.requireRole(UserRole.ADMIN, UserRole.STAFF);

  // ── 挂账池列表 ───────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const query = listReceiptsQuerySchema.parse(req.query);
    const receipts = await service.list(query);
    return { receipts };
  });

  // ── 总账（合并时间线，只读） ──────────────────────────
  app.get('/ledger', { preHandler: [app.authenticate, requireAdminOrStaff] }, async () => {
    return service.ledger();
  });

  // ── 登记新进账 ───────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req, reply) => {
    const body = registerReceiptSchema.parse(req.body);
    const receipt = await service.register(body, { userId: req.user.sub, role: req.user.role });
    return reply.status(201).send({ receipt });
  });

  // ── 认领到订单（原子） ───────────────────────────────
  app.post('/:id/allocate', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = allocateReceiptSchema.parse(req.body);
    return service.allocate(id, body, { userId: req.user.sub, role: req.user.role });
  });

  // ── 退款剩余未认领部分 ───────────────────────────────
  app.post('/:id/refund', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = refundReceiptSchema.parse(req.body);
    return service.refund(id, body.note, { userId: req.user.sub, role: req.user.role });
  });
};
