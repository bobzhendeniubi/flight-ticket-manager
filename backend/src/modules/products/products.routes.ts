/**
 * 产品路由 — 公共 GET（客户浏览）+ 管理员写操作。
 *
 * 产品 CRUD 必须留痕：本次运营事故中普通酒店与随机档占位酒店被误建同名、改绑套餐并下架占位项，
 * 导致房控合计和录单受影响；如果新建、修改、下架没有 before/after 审计，就无法还原变更链路。
 *
 * GET 列表/详情  → 无需登录（含 ?active=1 只看上架的），但走 optionalAuthenticate 做「可选」身份解析：
 *   不带 Authorization 头     → 游客 200，响应里完全不含 costPriceCny 这个 key；
 *   带有效 ADMIN/STAFF token → 序列化时下发 costPriceCny（内部结算成本）；
 *   带有效的其他角色 token    → 同游客，不含 costPriceCny（见 isCostVisible + serializeHotel 等）；
 *   带了但无效/过期的 token   → 401（由 optionalAuthenticate 抛出），客户端续期后自动重试。
 *     ——不再静默降级为游客：否则运营 token 一过期，成本价会整片消失且永不自愈。
 *   0702 后台反馈 6：修复前此接口不分角色一律下发成本价，任何人 curl 都能拿到进货价。
 * POST/PATCH/DELETE → ADMIN/STAFF（不变）
 *
 * 4 个子资源：/hotels, /transfers, /visas, /bundles
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { ProductsService } from './products.service.js';
import { getHotelAvailability } from './hotel-availability.service.js';
import { getBundleSellableDates } from './bundle-availability.service.js';
import {
  bundleAuditSnapshot,
  hotelAuditSnapshot,
  productAuditSeverity,
  transferAuditSnapshot,
  visaAuditSnapshot,
} from './products.audit.js';
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

/** req.user 由 optionalAuthenticate 在带有效 token 时设置；不带 token（游客）时为 undefined。
 *  带了但无效/过期的 token 走不到这里 —— optionalAuthenticate 已经抛 401。 */
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
    const hotel = await service.createHotel(body);
    const after = hotelAuditSnapshot(hotel);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_HOTEL',
      targetType: 'PRODUCT',
      targetId: hotel.id,
      targetLabel: String(after.name ?? hotel.id),
      after,
      severity: productAuditSeverity({ resource: 'HOTEL', operation: 'CREATE', after }),
    });
    return reply.status(201).send({ hotel });
  });

  app.patch('/hotels/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateHotelBodySchema.parse(req.body);
    const before = hotelAuditSnapshot(await service.getHotel(id, true));
    const hotel = await service.updateHotel(id, body);
    const after = hotelAuditSnapshot(hotel);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_HOTEL',
      targetType: 'PRODUCT',
      targetId: hotel.id,
      targetLabel: hotel.name,
      before,
      after,
      severity: productAuditSeverity({ resource: 'HOTEL', operation: 'UPDATE', before, after }),
    });
    return { hotel };
  });

  app.delete('/hotels/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const before = hotelAuditSnapshot(await service.getHotel(id, true));
    const result = await service.deleteHotel(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_HOTEL',
      targetType: 'PRODUCT',
      targetId: result.id,
      targetLabel: String(before.name ?? result.id),
      before,
      after: result,
      severity: productAuditSeverity({ resource: 'HOTEL', operation: 'DELETE', before, after: result }),
    });
    return { result };
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
    const transfer = await service.createTransfer(body);
    const after = transferAuditSnapshot(transfer);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_TRANSFER',
      targetType: 'PRODUCT',
      targetId: transfer.id,
      targetLabel: String(after.name ?? transfer.id),
      after,
      severity: productAuditSeverity({ resource: 'TRANSFER', operation: 'CREATE', after }),
    });
    return reply.status(201).send({ transfer });
  });

  app.patch('/transfers/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateTransferBodySchema.parse(req.body);
    const before = transferAuditSnapshot(await service.getTransfer(id, true));
    const transfer = await service.updateTransfer(id, body);
    const after = transferAuditSnapshot(transfer);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_TRANSFER',
      targetType: 'PRODUCT',
      targetId: transfer.id,
      targetLabel: transfer.name,
      before,
      after,
      severity: productAuditSeverity({ resource: 'TRANSFER', operation: 'UPDATE', before, after }),
    });
    return { transfer };
  });

  app.delete('/transfers/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const before = transferAuditSnapshot(await service.getTransfer(id, true));
    const result = await service.deleteTransfer(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_TRANSFER',
      targetType: 'PRODUCT',
      targetId: result.id,
      targetLabel: String(before.name ?? result.id),
      before,
      after: result,
      severity: productAuditSeverity({ resource: 'TRANSFER', operation: 'DELETE', before, after: result }),
    });
    return { result };
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
    const visa = await service.createVisa(body);
    const after = visaAuditSnapshot(visa);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_VISA',
      targetType: 'PRODUCT',
      targetId: visa.id,
      targetLabel: String(after.name ?? visa.id),
      after,
      severity: productAuditSeverity({ resource: 'VISA', operation: 'CREATE', after }),
    });
    return reply.status(201).send({ visa });
  });

  app.patch('/visas/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateVisaBodySchema.parse(req.body);
    const before = visaAuditSnapshot(await service.getVisa(id, true));
    const visa = await service.updateVisa(id, body);
    const after = visaAuditSnapshot(visa);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_VISA',
      targetType: 'PRODUCT',
      targetId: visa.id,
      targetLabel: String(after.name ?? visa.id),
      before,
      after,
      severity: productAuditSeverity({ resource: 'VISA', operation: 'UPDATE', before, after }),
    });
    return { visa };
  });

  app.delete('/visas/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const before = visaAuditSnapshot(await service.getVisa(id, true));
    const result = await service.deleteVisa(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_VISA',
      targetType: 'PRODUCT',
      targetId: result.id,
      targetLabel: String(before.name ?? result.id),
      before,
      after: result,
      severity: productAuditSeverity({ resource: 'VISA', operation: 'DELETE', before, after: result }),
    });
    return { result };
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
    const bundle = await service.createBundle(body);
    const after = bundleAuditSnapshot(bundle);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_BUNDLE',
      targetType: 'PRODUCT',
      targetId: bundle.id,
      targetLabel: String(after.name ?? bundle.id),
      after,
      severity: productAuditSeverity({ resource: 'BUNDLE', operation: 'CREATE', after }),
    });
    return reply.status(201).send({ bundle });
  });

  app.patch('/bundles/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateBundleBodySchema.parse(req.body);
    const before = bundleAuditSnapshot(await service.getBundle(id));
    const bundle = await service.updateBundle(id, body);
    const after = bundleAuditSnapshot(bundle);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_BUNDLE',
      targetType: 'PRODUCT',
      targetId: bundle.id,
      targetLabel: bundle.name,
      before,
      after,
      severity: productAuditSeverity({ resource: 'BUNDLE', operation: 'UPDATE', before, after }),
    });
    return { bundle };
  });

  app.delete('/bundles/:id', adminPre, async (req) => {
    const { id } = req.params as { id: string };
    const before = bundleAuditSnapshot(await service.getBundle(id));
    const result = await service.deleteBundle(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_BUNDLE',
      targetType: 'PRODUCT',
      targetId: result.id,
      targetLabel: String(before.name ?? result.id),
      before,
      after: result,
      severity: productAuditSeverity({ resource: 'BUNDLE', operation: 'DELETE', before, after: result }),
    });
    return { result };
  });
};
