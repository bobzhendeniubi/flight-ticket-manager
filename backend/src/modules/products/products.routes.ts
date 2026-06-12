/**
 * 产品路由 — 公共 GET（客户浏览）+ 管理员写操作。
 *
 * GET 列表/详情  → 无需登录（含 ?active=1 只看上架的）
 * POST/PATCH/DELETE → ADMIN/STAFF
 *
 * 4 个子资源：/hotels, /transfers, /visas, /bundles
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service.js';
import { getHotelAvailability } from './hotel-availability.service.js';
import {
  createBundleBodySchema,
  createHotelBodySchema,
  createTransferBodySchema,
  createVisaBodySchema,
  hotelAvailabilityQuerySchema,
  updateBundleBodySchema,
  updateHotelBodySchema,
  updateTransferBodySchema,
  updateVisaBodySchema,
} from './products.schemas.js';

export const productRoutes: FastifyPluginAsync = async (app) => {
  const service = new ProductsService();
  const adminPre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  // ── 酒店余量（公开，前台套餐/酒店页用；只回档位不回原始数字）────
  app.get('/hotel-availability', async (req) => {
    const query = hotelAvailabilityQuerySchema.parse(req.query);
    return await getHotelAvailability(query);
  });

  // ── Hotels ─────────────────────────────────────────────────────
  app.get('/hotels', async (req) => {
    const { active } = req.query as { active?: string };
    return { hotels: await service.listHotels(active === '1' || active === 'true') };
  });

  app.get('/hotels/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { hotel: await service.getHotel(id) };
  });

  app.post('/hotels', adminPre, async (req, reply) => {
    const body = createHotelBodySchema.parse(req.body);
    return reply.status(201).send({ hotel: await service.createHotel(body) });
  });

  app.patch('/hotels/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateHotelBodySchema.parse(req.body);
    return { hotel: await service.updateHotel(id, body) };
  });

  app.delete('/hotels/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.deleteHotel(id) };
  });

  // ── Transfers ──────────────────────────────────────────────────
  app.get('/transfers', async (req) => {
    const { active } = req.query as { active?: string };
    return { transfers: await service.listTransfers(active === '1' || active === 'true') };
  });

  app.get('/transfers/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { transfer: await service.getTransfer(id) };
  });

  app.post('/transfers', adminPre, async (req, reply) => {
    const body = createTransferBodySchema.parse(req.body);
    return reply.status(201).send({ transfer: await service.createTransfer(body) });
  });

  app.patch('/transfers/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateTransferBodySchema.parse(req.body);
    return { transfer: await service.updateTransfer(id, body) };
  });

  app.delete('/transfers/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.deleteTransfer(id) };
  });

  // ── Visas ──────────────────────────────────────────────────────
  app.get('/visas', async (req) => {
    const { active } = req.query as { active?: string };
    return { visas: await service.listVisas(active === '1' || active === 'true') };
  });

  app.get('/visas/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { visa: await service.getVisa(id) };
  });

  app.post('/visas', adminPre, async (req, reply) => {
    const body = createVisaBodySchema.parse(req.body);
    return reply.status(201).send({ visa: await service.createVisa(body) });
  });

  app.patch('/visas/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateVisaBodySchema.parse(req.body);
    return { visa: await service.updateVisa(id, body) };
  });

  app.delete('/visas/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.deleteVisa(id) };
  });

  // ── Bundles ────────────────────────────────────────────────────
  app.get('/bundles', async (req) => {
    const { active } = req.query as { active?: string };
    return { bundles: await service.listBundles(active === '1' || active === 'true') };
  });

  app.get('/bundles/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { bundle: await service.getBundle(id) };
  });

  app.post('/bundles', adminPre, async (req, reply) => {
    const body = createBundleBodySchema.parse(req.body);
    return reply.status(201).send({ bundle: await service.createBundle(body) });
  });

  app.patch('/bundles/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateBundleBodySchema.parse(req.body);
    return { bundle: await service.updateBundle(id, body) };
  });

  app.delete('/bundles/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    return { result: await service.deleteBundle(id) };
  });
};
