/**
 * 客户管理
 * - ADMIN/STAFF: 全部客户
 * - AGENT: 自己树内的客户（primaryAgentId ∈ 自己 + 后代）
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { CustomersService } from './customers.service.js';
import { listCustomersQuerySchema, updateCustomerBodySchema } from './customers.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import { ForbiddenError } from '../../lib/errors.js';

export const customerRoutes: FastifyPluginAsync = async (app) => {
  const service = new CustomersService();
  const pre = {
    preHandler: [
      app.authenticate,
      app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT),
    ],
  };

  /**
   * AGENT 访问时自动注入 agentTreeIds —— service 层强制过滤。
   * 返回 undefined 表示 ADMIN/STAFF（不限制）。
   */
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

  app.get('/', pre, async (req) => {
    const q = listCustomersQuerySchema.parse(req.query);
    const agentTreeIds = await resolveAgentScope(req);
    return service.list({ ...q, agentTreeIds });
  });

  app.get('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const agentTreeIds = await resolveAgentScope(req);
    const customer = await service.getById(id, agentTreeIds);
    return { customer };
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateCustomerBodySchema.parse(req.body);

    // AGENT 只能改自己树里的客户
    const agentTreeIds = await resolveAgentScope(req);
    const before = await service.getById(id, agentTreeIds);
    const customer = await service.update(id, body);

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_CUSTOMER',
      targetType: 'CUSTOMER',
      targetId: id,
      targetLabel: customer.displayName ?? customer.email ?? customer.phone ?? id,
      before: { displayName: before.displayName, email: before.email, phone: before.phone, tags: before.profile.tags, notes: before.profile.notes, idNumber: before.profile.idNumber },
      after: { displayName: customer.displayName, email: customer.email, phone: customer.phone, tags: customer.profile.tags, notes: customer.profile.notes, idNumber: customer.profile.idNumber },
    });

    return { customer };
  });
};
