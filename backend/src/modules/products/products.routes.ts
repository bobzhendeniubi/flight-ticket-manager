/**
 * 产品路由 — 公共 GET（客户浏览）+ 管理员写操作。
 *
 * GET 列表/详情  → 无需登录（含 ?active=1 只看上架的），但走 optionalAuthenticate 做「可选」身份解析：
 *   带有效 ADMIN/STAFF token → 序列化时下发 costPriceCny（内部结算成本）；
 *   匿名/游客/其他角色       → 响应里完全不含 costPriceCny 这个 key（见 isCostVisible + serializeHotel 等）。
 *   0702 后台反馈 6：修复前此接口不分角色一律下发成本价，任何人 curl 都能拿到进货价。
 * POST/PATCH/DELETE → ADMIN/STAFF（不变）
 *
 * 4 个子资源：/hotels, /transfers, /visas, /bundles
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service.js';
import { getHotelAvailability } from './hotel-availability.service.js';
import { getBundleSellableDates } from './bundle-availability.service.js';
import {
  bundleFlightRefQuerySchema,
  bundleSellableDatesQuerySchema,
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

/** req.user 由 optionalAuthenticate 在带有效 token 时设置；匿名/无效 token 时为 undefined。 */
function isCostVisible(req: FastifyRequest): boolean {
  const role = req.user?.role;
  return role === UserRole.ADMIN || role === UserRole.STAFF;
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  const service = new ProductsService();
  const adminPre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };
  // 公开 GET 但仍尝试解析身份（不 401）——只用来决定要不要下发 costPriceCny。
  const optionalAuthPre = { preHandler: [app.optionalAuthenticate] };

  // ── 酒店余量（公开，前台套餐/酒店页用；只回档位不回原始数字）────
  app.get('/hotel-availability', async (req) => {
    const query = hotelAvailabilityQuerySchema.parse(req.query);
    return await getHotelAvailability(query);
  });

  // ── 套餐可售日期（公开，前台套餐日历用；只回 sellable/reason/档位，不回原始数字）──
  //   from 必填，to 省略 = from + 59 天（默认 60 天窗口）；跨度封顶 90 天，倒序/超长 → 400。
  app.get('/bundles/:id/sellable-dates', async (req) => {
    const { id } = req.params as { id: string };
    const { from, to } = bundleSellableDatesQuerySchema.parse(req.query);
    return { dates: await getBundleSellableDates(id, from, to) };
  });

  // ── Hotels ─────────────────────────────────────────────────────
  app.get('/hotels', optionalAuthPre, async (req) => {
    const { active } = req.query as { active?: string };
    return { hotels: await service.listHotels(active === '1' || active === 'true', isCostVisible(req)) };
  });

  app.get('/hotels/:id', optionalAuthPre, async (req) => {
    const { id } = req.params as { id: string };
    return { hotel: await service.getHotel(id, isCostVisible(req)) };
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
  app.get('/transfers', optionalAuthPre, async (req) => {
    const { active } = req.query as { active?: string };
    return { transfers: await service.listTransfers(active === '1' || active === 'true', isCostVisible(req)) };
  });

  app.get('/transfers/:id', optionalAuthPre, async (req) => {
    const { id } = req.params as { id: string };
    return { transfer: await service.getTransfer(id, isCostVisible(req)) };
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
  app.get('/visas', optionalAuthPre, async (req) => {
    const { active } = req.query as { active?: string };
    return { visas: await service.listVisas(active === '1' || active === 'true', isCostVisible(req)) };
  });

  app.get('/visas/:id', optionalAuthPre, async (req) => {
    const { id } = req.params as { id: string };
    return { visa: await service.getVisa(id, isCostVisible(req)) };
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

  // 套餐机票参考价（ADMIN/STAFF）：按传入去/回程航班号取当前最低来回经济舱机票/人；
  // 两者都空 = 按套餐航线兜底。后台套餐表单据此按「本套餐自己的绑定」实时反推想卖价↔折扣%，
  // 保证向导预览起价与卡片同源。静态路径注册在 /bundles/:id 之前，避免被参数路由吃掉。
  app.get('/bundles/flight-ref', adminPre, async (req) => {
    const binding = bundleFlightRefQuerySchema.parse(req.query);
    return await service.getBundleFlightRef(binding);
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
