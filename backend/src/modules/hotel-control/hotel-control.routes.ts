/**
 * 房控 API — ADMIN/STAFF only（酒店切房台账，代理/客户不可见）
 *
 * 路由：
 *   GET    /hotel-control/block-periods?hotelId=   包房周期列表（含酒店名）
 *   POST   /hotel-control/block-periods            新建周期
 *   PATCH  /hotel-control/block-periods/:id        改周期
 *   DELETE /hotel-control/block-periods/:id        删周期
 *   GET    /hotel-control/board?from&to            销控板（按酒店×日期：切/占/余）
 *   GET    /hotel-control/forward?from&to          远期视图（按日期跨酒店合计）
 *   GET    /hotel-control/random-tier-shortfall?from&to  每日加房清单（随机档缺口）
 *   GET    /hotel-control/alerts?days=14           提醒线（超卖加房/富余退房/班次超员）
 *   GET    /hotel-control/recent-changes?days=7    近期用房变更（读审计流：调整分房/换酒店/补房差）
 *   GET    /hotel-control/occupants?hotelId|randomStarTier&date  占房下钻（某酒店/某星级随机池某晚，谁占的）
 *   GET    /hotel-control/nightly-remaining?hotelRoomTypeId&checkIn&checkOut  当日余量（分房弹窗徽标）
 *   GET    /hotel-control/export?from&to           房态导出（xlsx，销控矩阵原样导出）
 *   GET    /hotel-control/passports.zip?hotelId&from&to     按酒店导出护照 zip
 *   POST   /hotel-control/passports-by-names.zip    按姓名批量导出护照 zip（body { names: string[], from?, to? } —— from/to 为出发地本地日区间）
 *   GET    /hotel-control/shared-rooms/workbench?(hotelId|randomStarTier|hotelRoomTypeId)&checkIn&checkOut  跨单分房工作台读模型
 *   PUT    /hotel-control/shared-rooms              跨单分房保存（新建/改动/解散共享房，见 §七）
 *   POST   /hotel-control/shared-rooms/:id/place    档次共享房整房落位
 *
 * 权限：除跨单分房三端点外一律 ADMIN/STAFF。跨单分房三端点 2026-09-21 起对 AGENT 开放自助
 * （只能拼自家含下级名下的单；含别家客人的房只读）——归属范围只从登录身份解析，见
 * resolveSharedRoomAgentScope，绝不从 query/body 读。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { buildHotelControlBoardWorkbook, hotelControlExportFilename } from './hotel-control.export.js';
import {
  buildHotelPassportsZip,
  buildPassportsByNamesZip,
  collectHotelPassportGroups,
  collectPassportGroupsByNames,
  hasAnyPassportPhoto,
  hotelPassportsZipFilename,
  passportsByNamesZipFilename,
} from './hotel-control.passports.js';
import {
  alertsQuerySchema,
  boardQuerySchema,
  createBlockPeriodBodySchema,
  hotelPassportsByNamesBodySchema,
  hotelPassportsQuerySchema,
  listBlockPeriodsQuerySchema,
  nightlyRemainingQuerySchema,
  occupantsQuerySchema,
  recentChangesQuerySchema,
  randomTierShortfallQuerySchema,
  updateBlockPeriodBodySchema,
  placeSharedRoomBodySchema,
} from './hotel-control.schemas.js';
import {
  createBlockPeriod,
  deleteBlockPeriod,
  getAlerts,
  getBlockPeriod,
  getBoard,
  getForward,
  getHotelOversellCapRooms,
  getNightlyRemainingForRoomType,
  getOccupyingOrders,
  getRecentRoomChanges,
  listBlockPeriods,
  randomPoolGroupKey,
  updateBlockPeriod,
  HOTEL_OVERSELL_CAP_MAX,
  HOTEL_OVERSELL_CAP_SETTING_KEY,
  OCCUPYING_ORDERS_DETAIL_NOTE,
} from './hotel-control.service.js';
import { getRandomTierShortfall } from './hotel-control.shortfall.js';
import {
  getSharedRoomWorkbench,
  saveSharedRooms,
  type SharedRoomAgentScope,
  type SharedRoomScope,
} from './hotel-control.shared-rooms.js';
import { placeSharedRoom } from './shared-room-placement.js';
import {
  sharedRoomWorkbenchQuerySchema,
  saveSharedRoomsBodySchema,
} from './hotel-control.schemas.js';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { AuditSeverity } from '@prisma/client';

export const hotelControlRoutes: FastifyPluginAsync = async (app) => {
  const requireStaff = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };
  // 跨单分房三端点专用（2026-09-21 代理自助拼房）；其余房控端点仍是 requireStaff。
  const requireOpsOrAgent = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)],
  };

  /**
   * 代理归属范围——**只从登录身份解析**：AGENT → 自己 + 全部下级代理 id（lib/agent-tree 递归 CTE，
   * 与订单列表 / 导出 / 客户管理同源）；ADMIN/STAFF → null（不设限）。绝不从 query/body 读任何
   * 归属字段；AGENT 账号没有关联 Agent 档案 → 403（fail-closed）。
   */
  async function resolveSharedRoomAgentScope(req: {
    user: { sub: string; role: UserRole };
  }): Promise<SharedRoomAgentScope> {
    if (req.user.role !== UserRole.AGENT) return null;
    const agent = await prisma.agent.findUnique({ where: { userId: req.user.sub }, select: { id: true } });
    if (!agent) throw new ForbiddenError('AGENT 账号没有关联 Agent 档案');
    return new Set(await getDescendantAgentIds(agent.id));
  }

  /**
   * 工作台作用域：hotelId / randomStarTier 直接用；hotelRoomTypeId 反查——真酒店房型 → 该酒店，
   * 占位酒店房型 → 该档次随机池（代理从订单详情的分房盒子就地打开工作台时只有行上的房型 id）。
   */
  async function resolveWorkbenchScope(q: {
    hotelId?: string;
    randomStarTier?: number;
    hotelRoomTypeId?: string;
  }): Promise<SharedRoomScope> {
    if (q.hotelId) return { hotelId: q.hotelId };
    if (q.randomStarTier != null) return { randomStarTier: q.randomStarTier };
    const roomType = await prisma.hotelRoomType.findUnique({
      where: { id: q.hotelRoomTypeId! },
      select: { hotelId: true, hotel: { select: { randomTierPlaceholder: true } } },
    });
    if (!roomType) throw new NotFoundError('房型不存在');
    return roomType.hotel.randomTierPlaceholder != null
      ? { randomStarTier: roomType.hotel.randomTierPlaceholder }
      : { hotelId: roomType.hotelId };
  }

  // ── 包房周期 CRUD ──────────────────────────────────────────────────────
  app.get('/block-periods', requireStaff, async (req) => {
    const q = listBlockPeriodsQuerySchema.parse(req.query);
    const periods = await listBlockPeriods({
      hotelId: q.hotelId,
      randomStarTier: q.randomStarTier,
    });
    return { periods };
  });

  app.post('/block-periods', requireStaff, async (req, reply) => {
    const body = createBlockPeriodBodySchema.parse(req.body);
    const period = await createBlockPeriod(body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_HOTEL_BLOCK_PERIOD',
      targetType: 'PRODUCT',
      // 池周期没有酒店 id，用池分组键留痕（可回溯是哪个星级池）
      targetId: period.hotelId ?? randomPoolGroupKey(period.randomStarTier ?? 0),
      targetLabel: `${period.hotelName} ${body.dateFrom}→${body.dateTo}`,
      after: body,
    });
    return reply.status(201).send({ period });
  });

  app.patch('/block-periods/:id', requireStaff, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateBlockPeriodBodySchema.parse(req.body);
    const period = await updateBlockPeriod(id, body, undefined, actorFromRequest(req));
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_HOTEL_BLOCK_PERIOD',
      targetType: 'PRODUCT',
      targetId: period.hotelId ?? randomPoolGroupKey(period.randomStarTier ?? 0),
      targetLabel: `${period.hotelName} ${period.dateFrom}→${period.dateTo}`,
      after: body,
    });
    return { period };
  });

  app.delete('/block-periods/:id', requireStaff, async (req) => {
    const { id } = req.params as { id: string };
    // 删除前先取快照：审计 before 必须能回答「删的是哪家酒店、哪段、几间」，
    // 否则事后只剩一个 id，无从追责。找不到就交给 deleteBlockPeriod 抛 404。
    const before = await getBlockPeriod(id);
    const result = await deleteBlockPeriod(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_HOTEL_BLOCK_PERIOD',
      targetType: 'PRODUCT',
      targetId: before?.hotelId ?? id,
      targetLabel: before ? `${before.hotelName} ${before.dateFrom}→${before.dateTo}` : 'block-period',
      before,
      after: null,
      severity: AuditSeverity.WARNING,
    });
    return result;
  });

  // ── 销控板 / 远期视图 ──────────────────────────────────────────────────
  app.get('/board', requireStaff, async (req) => {
    const q = boardQuerySchema.parse(req.query);
    return getBoard(q);
  });

  app.get('/forward', requireStaff, async (req) => {
    const q = boardQuerySchema.parse(req.query);
    return getForward(q);
  });

  // ── 每日加房清单（随机档缺口；与销控矩阵共用 getRandomTierAggregate）──────
  app.get('/random-tier-shortfall', requireStaff, async (req) => {
    const q = randomTierShortfallQuerySchema.parse(req.query);
    return getRandomTierShortfall(q.from, q.to);
  });

  // ── 提醒线（按需计算，无 cron）────────────────────────────────────────
  app.get('/alerts', requireStaff, async (req) => {
    const q = alertsQuerySchema.parse(req.query);
    return getAlerts(q.days);
  });

  // ── 超售容忍上限（运营可调）：销控售罄后内部录单最多允许打到负几间 ─────────
  // 房控/运营自己改，不用找开发；改动写 WARNING 审计可追溯。0 = 关掉超售口子。
  app.get('/oversell-cap', requireStaff, async () => {
    return { rooms: await getHotelOversellCapRooms(), max: HOTEL_OVERSELL_CAP_MAX };
  });

  app.put('/oversell-cap', requireStaff, async (req) => {
    const body = z
      .object({
        rooms: z
          .number()
          .int('超售上限必须是整数（间）')
          .min(0, '超售上限不能为负')
          .max(HOTEL_OVERSELL_CAP_MAX, `超售上限最多 ${HOTEL_OVERSELL_CAP_MAX} 间（再大请联系开发调整）`),
      })
      .parse(req.body);
    const before = await getHotelOversellCapRooms();
    await prisma.systemSetting.upsert({
      where: { key: HOTEL_OVERSELL_CAP_SETTING_KEY },
      create: {
        key: HOTEL_OVERSELL_CAP_SETTING_KEY,
        value: String(body.rooms),
        updatedById: req.user.sub,
      },
      update: { value: String(body.rooms), updatedById: req.user.sub },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_HOTEL_OVERSELL_CAP',
      targetType: 'PRODUCT',
      targetId: HOTEL_OVERSELL_CAP_SETTING_KEY,
      targetLabel: `酒店超售容忍上限 ${before} → ${body.rooms} 间`,
      before: { rooms: before },
      after: { rooms: body.rooms },
      severity: AuditSeverity.WARNING,
    });
    return { rooms: body.rooms, max: HOTEL_OVERSELL_CAP_MAX };
  });

  // ── 近期用房变更（读审计流；订单侧改了分房/换酒店/补房差 → 房控可见性）────
  app.get('/recent-changes', requireStaff, async (req) => {
    const q = recentChangesQuerySchema.parse(req.query);
    return getRecentRoomChanges(q.days);
  });

  // ── 占房下钻（某酒店/某星级随机池某晚，谁占的；销控矩阵余量格点击用）──────────
  app.get('/occupants', requireStaff, async (req) => {
    const q = occupantsQuerySchema.parse(req.query);
    const occupants = await getOccupyingOrders(
      q.hotelId ? { hotelId: q.hotelId } : { randomStarTier: q.randomStarTier! },
      q.date,
    );
    // detailNote：跨单分房下钻新增三列（sharedRoomCount / billedRoomFraction /
    // physicalRoomsDeduped）口径不同，不能跨单直接相加，见 OCCUPYING_ORDERS_DETAIL_NOTE。
    return { occupants, detailNote: OCCUPYING_ORDERS_DETAIL_NOTE };
  });

  // ── 当日余量（给定房型 + 入住区间；分房弹窗徽标用）───────────────────────
  app.get('/nightly-remaining', requireStaff, async (req) => {
    const q = nightlyRemainingQuerySchema.parse(req.query);
    return getNightlyRemainingForRoomType(q.hotelRoomTypeId, q.checkIn, q.checkOut);
  });

  // ── 房态导出（xlsx；销控矩阵原样导出，含「未配包房」标记）────────────────
  app.get('/export', requireStaff, async (req, reply) => {
    const q = boardQuerySchema.parse(req.query);
    const buf = await buildHotelControlBoardWorkbook(q);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'EXPORT_HOTEL_CONTROL_BOARD',
      targetType: 'PRODUCT',
      targetId: 'hotel-control-board',
      targetLabel: `房控导出 ${q.from}~${q.to}`,
      after: { from: q.from, to: q.to },
    });

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(hotelControlExportFilename(q.from, q.to))}"`,
      )
      .send(buf);
  });

  // ── 按酒店一键导出护照 zip（选酒店 + 入住日期区间；按订单分文件夹）────────
  app.get('/passports.zip', requireStaff, async (req, reply) => {
    const q = hotelPassportsQuerySchema.parse(req.query);
    const selection = await collectHotelPassportGroups(q);

    // 无命中订单 → 友好 400（避免下载到只有一个 README 的空 zip）
    if (selection.groups.length === 0) {
      return reply
        .status(400)
        .send({ error: '所选酒店在该入住日期区间内没有可导出的入住订单' });
    }
    // 全员都没上传护照图 → 400（没有可打包的护照）
    if (!hasAnyPassportPhoto(selection.groups)) {
      return reply
        .status(400)
        .send({ error: '所选区间内的入住客人均未上传护照图，暂无可打包的护照' });
    }

    const { buf, photoCount } = await buildHotelPassportsZip(selection, q);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DOWNLOAD_HOTEL_PASSPORTS',
      targetType: 'PRODUCT',
      targetId: q.hotelId,
      targetLabel: `${selection.hotelName ?? q.hotelId} ${q.from}~${q.to}`,
      after: { orderCount: selection.groups.length, photoCount },
    });

    return reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(
          hotelPassportsZipFilename(selection.hotelName, q.hotelId, q.from, q.to),
        )}"`,
      )
      .send(buf);
  });

  // ── 按姓名批量导出护照 zip（不限酒店，可选按出发日期过滤；按出发日期分文件夹、
  //    按姓名命名文件，未命中姓名写进 README）────
  app.post('/passports-by-names.zip', requireStaff, async (req, reply) => {
    const body = hotelPassportsByNamesBodySchema.parse(req.body);
    const hasRange = Boolean(body.from || body.to);
    const selection = await collectPassportGroupsByNames({
      names: body.names,
      from: body.from,
      to: body.to,
    });

    // 一个客人都没命中 → 友好 400（避免下载到只有一个 README 的空 zip）
    if (selection.groups.length === 0) {
      return reply.status(400).send({
        error: hasRange
          ? '所提供的姓名在该出发日期范围内未命中任何客人'
          : '所提供的姓名均未找到任何客人',
      });
    }
    // 命中的客人全都没上传护照图 → 400（没有可打包的护照）
    if (!hasAnyPassportPhoto(selection.groups)) {
      return reply
        .status(400)
        .send({ error: '命中的客人均未上传护照图，暂无可打包的护照' });
    }

    const { buf, photoCount } = await buildPassportsByNamesZip(selection, {
      from: body.from,
      to: body.to,
    });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DOWNLOAD_HOTEL_PASSPORTS_BY_NAMES',
      targetType: 'PRODUCT',
      targetId: 'passports-by-names',
      targetLabel: `按姓名导出护照 ${body.names.length} 个姓名${hasRange ? ` 出发${body.from ?? '不限'}~${body.to ?? '不限'}` : ''}`,
      after: {
        nameCount: body.names.length,
        from: body.from ?? null,
        to: body.to ?? null,
        orderCount: selection.groups.length,
        photoCount,
        notFoundCount: selection.notFoundNames.length,
      },
    });

    return reply
      .header('Content-Type', 'application/zip')
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(
          passportsByNamesZipFilename(body.names, { from: body.from, to: body.to }),
        )}"`,
      )
      .send(buf);
  });

  // ── 跨单分房工作台（§七）：ADMIN/STAFF 全量；AGENT 自助（2026-09-21）只看自家含下级的单，
  //    含别家客人的既有共享房整间 readOnly + 脱敏（service 侧按 agentScope 处理）────────────
  // 作用域 hotelId | randomStarTier | hotelRoomTypeId 三选一（schema refine 保证）：酒店房 vs 档次房。
  app.get('/shared-rooms/workbench', requireOpsOrAgent, async (req) => {
    const q = sharedRoomWorkbenchQuerySchema.parse(req.query);
    const [scope, agentScope] = await Promise.all([resolveWorkbenchScope(q), resolveSharedRoomAgentScope(req)]);
    return getSharedRoomWorkbench(scope, q.checkIn, q.checkOut, undefined, { agentScope });
  });

  app.put('/shared-rooms', requireOpsOrAgent, async (req) => {
    const body = saveSharedRoomsBodySchema.parse(req.body);
    const agentScope = await resolveSharedRoomAgentScope(req);
    const result = await saveSharedRooms(body, actorFromRequest(req), undefined, { agentScope });
    return result;
  });

  // ── 档次共享房整房落位：全部成员行一起落到同一家真实酒店同一房型，共享房原地转酒店房 ──
  // AGENT：房内成员必须全是自家的单（service 403），同档 / 星级 / 指定加价闸照旧。
  app.post('/shared-rooms/:id/place', requireOpsOrAgent, async (req) => {
    const { id } = req.params as { id: string };
    const body = placeSharedRoomBodySchema.parse(req.body);
    const agentScope = await resolveSharedRoomAgentScope(req);
    return placeSharedRoom(id, body, actorFromRequest(req), undefined, { agentScope });
  });
};
