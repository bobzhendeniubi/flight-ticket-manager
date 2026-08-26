/**
 * 占位单路由 — ADMIN/STAFF 管理无名单库存实体。
 * 建单与订单、锁位共享：capacity − sold − 未过期 ACTIVE 锁位 − 占位余座；收款与清算在本模块闭环。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest } from '../../lib/audit.js';
import { HoldOrderService } from './hold-orders.service.js';
import {
  allocateHoldInstallmentBodySchema,
  manualReceiptHoldInstallmentBodySchema,
  createHoldGroupBodySchema,
  createHoldOrderBodySchema,
  convertHoldOrderBodySchema,
  listHoldOrdersQuerySchema,
  previewHoldPlanBodySchema,
  previewConvertHoldOrderBodySchema,
  reduceHoldSeatsBodySchema,
  reverseHoldAllocationBodySchema,
  updateHoldInstallmentBodySchema,
  updateHoldOrderConfigBodySchema,
  updateHoldOrderInfoBodySchema,
  updateHoldOrderPriceBodySchema,
} from './hold-orders.schemas.js';

export const holdOrderRoutes: FastifyPluginAsync = async (app) => {
  const service = new HoldOrderService();
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };
  const adminOnly = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] };

  app.post('/', pre, async (req, reply) => {
    const body = createHoldOrderBodySchema.parse(req.body);
    const holdOrder = await service.create(body, req.user.sub, actorFromRequest(req));
    return reply.status(201).send({ holdOrder });
  });

  // 建团：一次为同一个团的多个航段建单（去程 / 回程 / 多段），落同一个团号，整团同一事务。
  app.post('/group', pre, async (req, reply) => {
    const body = createHoldGroupBodySchema.parse(req.body);
    const result = await service.createGroup(body, req.user.sub, actorFromRequest(req));
    return reply.code(201).send(result);
  });

  app.get('/', pre, async (req) => {
    const query = listHoldOrdersQuerySchema.parse(req.query);
    return { holdOrders: await service.list(query) };
  });

  app.get('/summary', pre, async (req) => {
    const query = listHoldOrdersQuerySchema.parse(req.query);
    return { summary: await service.summary(query) };
  });

  app.get('/config', pre, async () => ({ config: await service.getConfig() }));

  app.put('/config', adminOnly, async (req) => {
    const body = updateHoldOrderConfigBodySchema.parse(req.body);
    return { config: await service.updateConfig(body, actorFromRequest(req)) };
  });

  app.post('/preview-plan', pre, async (req) => {
    const body = previewHoldPlanBodySchema.parse(req.body);
    return { plan: await service.previewPlan(body) };
  });

  app.get('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { holdOrder: await service.getById(id) };
  });

  app.post('/:id/convert/preview', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = previewConvertHoldOrderBodySchema.parse(req.body);
    return { preview: await service.previewConversion(id, body) };
  });

  app.post('/:id/convert', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = convertHoldOrderBodySchema.parse(req.body);
    return { result: await service.convert(id, body, actorFromRequest(req)) };
  });

  app.post('/:id/release', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.release(id, actorFromRequest(req)) };
  });

  app.post('/:id/cancel', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.cancel(id, actorFromRequest(req)) };
  });

  app.post('/:id/installments/:installmentId/allocate', pre, async (req) => {
    const { id, installmentId } = req.params as { id: string; installmentId: string };
    const body = allocateHoldInstallmentBodySchema.parse(req.body);
    return { result: await service.allocateInstallment(id, installmentId, body, actorFromRequest(req)) };
  });

  // 手工到账：运营凭客户水单给某期直接录钱（建 OPS_CLAIM 进账并认到本期；财务事后核实）。
  app.post('/:id/installments/:installmentId/manual-receipt', pre, async (req) => {
    const { id, installmentId } = req.params as { id: string; installmentId: string };
    const body = manualReceiptHoldInstallmentBodySchema.parse(req.body);
    return { result: await service.manualReceiptInstallment(id, installmentId, body, { ...actorFromRequest(req), userId: req.user.sub }) };
  });

  app.post('/:id/installments/:installmentId/allocations/:allocationId/reverse', pre, async (req) => {
    const { id, installmentId, allocationId } = req.params as { id: string; installmentId: string; allocationId: string };
    const body = reverseHoldAllocationBodySchema.parse(req.body);
    return { result: await service.reverseInstallmentAllocation(id, installmentId, allocationId, body.reason, actorFromRequest(req)) };
  });

  app.patch('/:id/installments/:installmentId', pre, async (req) => {
    const { id, installmentId } = req.params as { id: string; installmentId: string };
    const body = updateHoldInstallmentBodySchema.parse(req.body);
    return { result: await service.updateInstallmentDueDate(id, installmentId, body, actorFromRequest(req)) };
  });

  app.post('/:id/reduce-seats/preview', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = reduceHoldSeatsBodySchema.parse(req.body);
    return { preview: await service.previewReduction(id, body) };
  });

  app.post('/:id/reduce-seats', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = reduceHoldSeatsBodySchema.parse(req.body);
    return { result: await service.reduceSeats(id, body, actorFromRequest(req)) };
  });

  app.post('/:id/retry-occupy', pre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.retryOccupy(id, actorFromRequest(req)) };
  });

  app.patch('/:id/price', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateHoldOrderPriceBodySchema.parse(req.body);
    return { result: await service.updatePrice(id, body, actorFromRequest(req)) };
  });

  // 改团名 / 备注：建单后临时信息补录或订正（票务反馈）。
  app.patch('/:id/info', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateHoldOrderInfoBodySchema.parse(req.body);
    return { result: await service.updateInfo(id, body, actorFromRequest(req)) };
  });
};
