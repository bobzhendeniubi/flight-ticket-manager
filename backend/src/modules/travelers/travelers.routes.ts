/**
 * 旅客管理
 * - ADMIN/STAFF: 全部旅客
 * - AGENT: 树里客户的旅客档案（根据 SavedPassenger.user.customerProfile.primaryAgentId 筛选）
 *
 * 基于 SavedPassenger 表，tripCount / lastTripAt 实时从 Passenger 聚合。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { TravelersService } from './travelers.service.js';
import { TravelerProfilesService } from './traveler-profiles.service.js';
import {
  createTravelerBodySchema,
  listTravelersQuerySchema,
  listTravelerProfilesQuerySchema,
  mergeTravelerProfileBodySchema,
  suggestTravelerProfilesQuerySchema,
  updateTravelerBodySchema,
  updateTravelerProfileNotesBodySchema,
} from './travelers.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

export const travelerRoutes: FastifyPluginAsync = async (app) => {
  const service = new TravelersService();
  const profilesService = new TravelerProfilesService();
  const pre = {
    preHandler: [
      app.authenticate,
      app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT),
    ],
  };
  // 旅客档案（跨订单聚合，含游客单乘机人与消费画像）—— 内部资产，不对 AGENT 开放
  const preStaff = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };

  // ── 旅客档案（TravelerProfile）——静态段 /profiles 先于参数段 /:id 注册 ──

  app.get('/profiles', preStaff, async (req) => {
    const q = listTravelerProfilesQuerySchema.parse(req.query);
    return profilesService.list(q);
  });

  // 录单联想：证件号/姓名前缀 或 中文名包含 → 档案摘要 + 最近乘机人快照（表单一键回填）
  app.get('/profiles/suggest', preStaff, async (req) => {
    const q = suggestTravelerProfilesQuerySchema.parse(req.query);
    const suggestions = await profilesService.suggest(q.q, q.limit);
    return { suggestions };
  });

  app.get('/profiles/:id', preStaff, async (req) => {
    const { id } = req.params as { id: string };
    return profilesService.getDetail(id);
  });

  app.patch('/profiles/:id/notes', preStaff, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateTravelerProfileNotesBodySchema.parse(req.body);
    const profile = await profilesService.updateNotes(id, body.notes);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_TRAVELER_PROFILE_NOTES',
      targetType: 'TRAVELER',
      targetId: profile.id,
      targetLabel: profile.fullName,
      after: { notes: body.notes },
    });
    return { profile };
  });

  // 档案合并（同人换证归一）：把 :id 并进 intoId；:id 保留为指针行，不做解除合并
  app.post('/profiles/:id/merge', preStaff, async (req) => {
    const { id } = req.params as { id: string };
    const body = mergeTravelerProfileBodySchema.parse(req.body);
    const result = await profilesService.merge(id, body.intoId);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'MERGE_TRAVELER_PROFILE',
      targetType: 'TRAVELER',
      targetId: result.profile.id,
      targetLabel: result.profile.fullName,
      severity: 'WARNING', // 不可解除的归一操作，留痕等级同删除
      before: { source: result.source, target: result.targetBefore },
      after: {
        travelerNo: result.profile.travelerNo,
        documentType: result.profile.documentType,
        documentNumber: result.profile.documentNumber,
        mergedTravelerNo: result.source.travelerNo,
        mergedDocumentNumber: result.source.documentNumber,
      },
    });
    return { profile: result.profile, trips: result.trips, merged: result.source };
  });

  app.post('/profiles/rebuild', preStaff, async (req) => {
    const result = await profilesService.rebuildAll();
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'REBUILD_TRAVELER_PROFILES',
      targetType: 'SYSTEM',
      targetId: 'traveler-profiles',
      targetLabel: '旅客档案全量重建',
      after: result,
    });
    return { result };
  });

  /** AGENT 自动作用域：返 agent id 树；非 AGENT 返 undefined */
  async function resolveAgentScope(
    req: { user: { sub: string; role: UserRole } },
  ): Promise<string[] | undefined> {
    if (req.user.role !== UserRole.AGENT) return undefined;
    const agent = await prisma.agent.findUnique({
      where: { userId: req.user.sub },
      select: { id: true },
    });
    if (!agent) throw new ForbiddenError('AGENT 账号没有关联 Agent 档案');
    return getDescendantAgentIds(agent.id);
  }

  /** AGENT: 验证 traveler 属于 tree 内客户；否则 404（防 id 枚举） */
  async function assertTravelerInScope(
    travelerId: string,
    agentTreeIds: string[] | undefined,
  ): Promise<void> {
    if (!agentTreeIds) return;
    const t = await prisma.savedPassenger.findUnique({
      where: { id: travelerId },
      select: { user: { select: { customerProfile: { select: { primaryAgentId: true } } } } },
    });
    const pid = t?.user.customerProfile?.primaryAgentId;
    if (!pid || !agentTreeIds.includes(pid)) throw new NotFoundError('旅客不存在');
  }

  app.get('/', pre, async (req) => {
    const q = listTravelersQuerySchema.parse(req.query);
    const agentTreeIds = await resolveAgentScope(req);
    return service.list({ ...q, agentTreeIds });
  });

  app.get('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const agentTreeIds = await resolveAgentScope(req);
    await assertTravelerInScope(id, agentTreeIds);
    const traveler = await service.getById(id);
    return { traveler };
  });

  app.post('/', pre, async (req, reply) => {
    const body = createTravelerBodySchema.parse(req.body);
    // AGENT 创建旅客时 —— 必须绑定到自己树内的客户 userId
    const agentTreeIds = await resolveAgentScope(req);
    if (agentTreeIds && body.userId) {
      const u = await prisma.user.findUnique({
        where: { id: body.userId },
        select: { customerProfile: { select: { primaryAgentId: true } } },
      });
      const pid = u?.customerProfile?.primaryAgentId;
      if (!pid || !agentTreeIds.includes(pid)) {
        throw new ForbiddenError('不能为你树外的客户创建旅客');
      }
    }
    const t = await service.create(body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_TRAVELER',
      targetType: 'TRAVELER',
      targetId: t.id,
      targetLabel: t.fullName,
      after: { fullName: t.fullName, documentNumber: t.documentNumber },
    });
    return reply.status(201).send({ traveler: t });
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateTravelerBodySchema.parse(req.body);
    const agentTreeIds = await resolveAgentScope(req);
    await assertTravelerInScope(id, agentTreeIds);
    const before = await service.getById(id);
    const t = await service.update(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_TRAVELER',
      targetType: 'TRAVELER',
      targetId: t.id,
      targetLabel: t.fullName,
      before: { fullName: before.fullName, documentNumber: before.documentNumber, phone: before.phone, notes: before.notes },
      after: { fullName: t.fullName, documentNumber: t.documentNumber, phone: t.phone, notes: t.notes },
    });
    return { traveler: t };
  });

  app.delete('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const agentTreeIds = await resolveAgentScope(req);
    await assertTravelerInScope(id, agentTreeIds);
    const before = await service.getById(id);
    await service.delete(id);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_TRAVELER',
      targetType: 'TRAVELER',
      targetId: id,
      targetLabel: before.fullName,
      severity: 'WARNING',
      before: { fullName: before.fullName, documentNumber: before.documentNumber },
    });
    return { result: { id } };
  });
};
