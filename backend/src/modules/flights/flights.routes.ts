import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { StaffRole, UserRole } from '@prisma/client';
import {
  FlightService,
  serializeScheduleForAgent,
  toPublicPrice,
} from './flights.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { actorFromRequest } from '../../lib/audit.js';
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { priceQuerySchema } from '../pricing/pricing.schemas.js';
import {
  batchDeleteSchedulesBodySchema,
  batchUpdateCapacityBodySchema,
  batchUpdateScheduleTimesBodySchema,
  createFlightBodySchema,
  createScheduleBodySchema,
  flightSearchQuerySchema,
  updateFlightBodySchema,
  updateScheduleBodySchema,
  upsertBaggagePoliciesBodySchema,
} from './flights.schemas.js';

/**
 * 航班维护岗 = ADMIN，或 STAFF 里的「运营（未设岗）」与「票务岗」。
 * 建航班 / 加班次 / 改班次（价、容量、时刻、上下架）是运营与票务的日常活，不该每次都找管理员代劳；
 * 签证岗 / 房控 / 财务不碰航班库存，因此不在此列（他们仍可只读班次）。
 * 岗位逐请求从 User 表取回（authenticate 写进 req.staffRole），改岗后下一个请求即生效，不依赖 token 内容。
 * 判岗口径与 plugins/auth.ts 的 requireFinanceAccess 一致，只是放行的岗位不同。
 */
async function requireFlightMaintenance(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw new UnauthorizedError();
  const allowed =
    req.user.role === UserRole.ADMIN ||
    (req.user.role === UserRole.STAFF &&
      (req.staffRole == null || req.staffRole === StaffRole.TICKETING));
  if (!allowed) throw new ForbiddenError('需要运营或票务岗权限');
}

export const flightRoutes: FastifyPluginAsync = async (app) => {
  const service = new FlightService();
  const pricingService = new PricingService();

  // ── 公共搜索 ──
  app.get('/search', async (req) => {
    const q = flightSearchQuerySchema.parse(req.query);
    const results = await service.search(q);
    return { query: q, results };
  });

  // ── 动态定价查询（公共，未鉴权） ──
  // 响应必须走 toPublicPrice 白名单——不要用 `...pricing` 展开：PriceResult 带内部字段
  // （dateRank 内部日期等级、dateMultiplier 恒 1、精确 currentBucketRemaining、绝对 seatIndex），
  // 展开会把它们连同将来 PriceResult 新增的任何字段一起发给匿名调用方。
  // 这条路由只有公开形态，没有需要内部字段的带权变体。
  app.get('/price', async (req) => {
    const q = priceQuerySchema.parse(req.query);
    const pricing = await pricingService.calculatePrice(q.scheduleId, q.cabin, q.qty);
    return { pricing: toPublicPrice(pricing) };
  });

  // ── 管理员航班 CRUD ──
  // 列表：ADMIN/STAFF/AGENT 都可读（代理批量创单要选航班；AdminFlight 不含成本字段，安全）
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async () => {
      const flights = await service.listFlights();
      return { flights };
    },
  );

  // 新建航班：航班维护岗（ADMIN / 运营 / 票务岗）都可建线。
  app.post(
    '/',
    { preHandler: [app.authenticate, requireFlightMaintenance] },
    async (req, reply) => {
      const body = createFlightBodySchema.parse(req.body);
      const flight = await service.createFlight(body);
      return reply.status(201).send({ flight });
    },
  );

  // 整线停售 / 恢复：一次影响该航线全部班次，前台立刻不可售 —— 仅 ADMIN。
  app.post(
    '/:flightId/toggle',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const flight = await service.deactivateFlight(flightId);
      return { flight };
    },
  );

  // 航班级编辑：升舱差价（¥/程/座，单一配置源）+ 商务舱价格联动开关。
  // 定价敏感（一改影响整条航线所有班次的商务舱成交价），不随航班维护岗放开 —— 仅 ADMIN。
  app.patch(
    '/:flightId',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const body = updateFlightBodySchema.parse(req.body);
      const flight = await service.updateFlight(flightId, body);
      return { flight };
    },
  );

  app.get(
    '/:flightId/schedules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const schedules = await service.listSchedules(flightId);
      // 代理可读班次（批量创单需要），但不可见成本字段 —— 走白名单序列化防泄露毛利
      // （黑名单式逐字段剥离在 FlightSchedule 新增成本字段时会漏改，见 serializeScheduleForAgent 注释）
      if (req.user.role === UserRole.AGENT) {
        return { schedules: schedules.map(serializeScheduleForAgent) };
      }
      return { schedules };
    },
  );

  // ── 座位统计：按出发日区间列出所有航班的班次（含 available/locked，一次取数，免 N+1）──
  app.get(
    '/schedules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const q = z
        .object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'from 格式应为 YYYY-MM-DD').optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'to 格式应为 YYYY-MM-DD').optional(),
        })
        .parse(req.query);
      const schedules = await service.listSchedulesInRange(q);
      return { schedules };
    },
  );

  // ── 行李规则（航班 × 舱等；ADMIN/STAFF 维护）──
  app.get(
    '/:flightId/baggage-policies',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const policies = await service.listBaggagePolicies(flightId);
      return { policies };
    },
  );

  // PUT 整体替换：body 是 [{cabin, checkedKg, checkedPieces, carryOnKg, note}]；未出现的舱等删除
  app.put(
    '/:flightId/baggage-policies',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { flightId } = req.params as { flightId: string };
      const items = upsertBaggagePoliciesBodySchema.parse(req.body);
      const policies = await service.upsertBaggagePolicies(flightId, items);
      return { policies };
    },
  );

  // 新增班次（前端「+ 新班次」与「批量加班次」都走这一条，后者按日期逐条调用）。
  // 航班维护岗（ADMIN / 运营 / 票务岗）都可加班次。
  app.post(
    '/schedules',
    { preHandler: [app.authenticate, requireFlightMaintenance] },
    async (req, reply) => {
      const body = createScheduleBodySchema.parse(req.body);
      const schedule = await service.createSchedule(body);
      return reply.status(201).send({ schedule });
    },
  );

  // 开票上限已无独立端点：上限 = 该班次座位库存（Σ 舱位 capacity），
  // 改上限 = 改舱位容量，走下面的单班次编辑（PATCH /schedules/:scheduleId）。

  // 单班次编辑（月历库存视图：改价 / 改容量 / 停用启用 / 改时刻）。
  // 航班维护岗（ADMIN / 运营 / 票务岗）可改；签证岗 / 房控 / 财务只读，不再能改班次。
  app.patch(
    '/schedules/:scheduleId',
    { preHandler: [app.authenticate, requireFlightMaintenance] },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const body = updateScheduleBodySchema.parse(req.body);
      const schedule = await service.updateSchedule(scheduleId, body, actorFromRequest(req));
      return { schedule };
    },
  );

  // 批量删除班次（按出发日区间；已售班次自动跳过）。仅 ADMIN —— 与单删同权限，
  // 删除不可恢复，爆炸半径比「加/改班次」大一档，因此不随航班维护岗一起放开；操作写审计留痕。
  // body: { flightId?, from, to }（from/to 为出发地当地日 YYYY-MM-DD）。
  // 返回 { deleted, skipped: [{ scheduleId, reason }] }，已售/有订单的班次不会被删。
  app.post(
    '/schedules/batch-delete',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const body = batchDeleteSchedulesBodySchema.parse(req.body);
      const result = await service.batchDeleteSchedules(body, actorFromRequest(req));
      return { result };
    },
  );

  // 批量改容量（按 scheduleId 列表）。容量可以压到已售之下（航司减配/换机型），
  // 这类舱位照改并在 oversold 里点名，销售侧照旧按 CAS 拒卖。
  // 仅 ADMIN —— 与批量删除同权限口径：一次把整月班次的库存改成超售的爆炸半径太大，
  // 单班次改容量则随航班维护岗放开（见 PATCH /schedules/:scheduleId）；操作写审计留痕。
  // body: { scheduleIds, seatClasses: [{cabin, capacity}] }
  // 返回 { applied, skipped: [{ scheduleId, reason }], oversold: [{ scheduleId, cabin, sold, capacity, oversoldBy }] }。
  app.post(
    '/schedules/batch-update-capacity',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const body = batchUpdateCapacityBodySchema.parse(req.body);
      const result = await service.batchUpdateCapacity(body, actorFromRequest(req));
      return { result };
    },
  );

  // 批量改时刻（按 scheduleId 列表）。运营填**当地钟点** HH:mm，各班次按自己的时区折回 UTC，
  // 当地出发日保持不变。批次里有已售班次时必须带 confirmSoldTimeChange，否则 400 回报影响面。
  // 航班维护岗（ADMIN / 运营 / 票务岗）都可改点 —— 航司改点是票务日常，且已售批次有确认闸兜底；
  // 操作写审计留痕。
  // body: { scheduleIds, departureLocalTime, arrivalLocalTime, arrivalNextDay?, confirmSoldTimeChange? }
  // 返回 { applied, skipped: [{ scheduleId, reason }], soldSchedules, soldSeats }。
  app.post(
    '/schedules/batch-update-times',
    { preHandler: [app.authenticate, requireFlightMaintenance] },
    async (req) => {
      const body = batchUpdateScheduleTimesBodySchema.parse(req.body);
      const result = await service.batchUpdateScheduleTimes(body, actorFromRequest(req));
      return { result };
    },
  );

  // 单班次删除：不可恢复，与批量删除同权限口径 —— 仅 ADMIN。
  app.delete(
    '/schedules/:scheduleId',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { scheduleId } = req.params as { scheduleId: string };
      const result = await service.deleteSchedule(scheduleId);
      return { result };
    },
  );
};
