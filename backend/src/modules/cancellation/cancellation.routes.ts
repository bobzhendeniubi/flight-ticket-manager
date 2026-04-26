/**
 * 取消政策 CRUD（ADMIN/STAFF）
 *
 * 让客服在后台直接调费率阶梯，改完前台 /refund-quote 立即生效。
 *
 * GET    /cancellation-policies
 * POST   /cancellation-policies                  body: { productKind, name, tiers, scope?, isDefault?, notes? }
 * PATCH  /cancellation-policies/:id              body: 任意字段
 * DELETE /cancellation-policies/:id              （isDefault 不可删，要先标为非默认）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { validateTiers } from '../../lib/cancellation.js';

const tierSchema = z.object({
  hoursBeforeDeparture: z.number(),
  feePercent: z.number().min(0).max(100),
});

const createBodySchema = z.object({
  productKind: z.nativeEnum(OrderItemKind),
  name: z.string().min(1).max(120),
  tiers: z.array(tierSchema).min(1),
  scope: z.string().optional(), // null/undefined = 默认策略；非空 = 针对特定 entity
  isDefault: z.boolean().optional().default(false),
  notes: z.string().max(500).optional(),
});

const updateBodySchema = createBodySchema.partial();

export const cancellationRoutes: FastifyPluginAsync = async (app) => {
  const pre = {
    preHandler: [
      app.authenticate,
      app.requireRole(UserRole.ADMIN, UserRole.STAFF),
    ],
  };

  app.get('/', pre, async () => {
    const policies = await prisma.cancellationPolicy.findMany({
      orderBy: [{ productKind: 'asc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return { policies };
  });

  app.post('/', pre, async (req, reply) => {
    const body = createBodySchema.parse(req.body);

    // 校验 tiers + 规范化（按 hoursBeforeDeparture 降序，-1 排末尾）
    const v = validateTiers(body.tiers);
    if (!v.ok) throw new BadRequestError(`tiers 无效：${v.error}`);
    const normalizedTiers = v.normalized!;

    // 同 kind+scope 唯一（scope null → '__DEFAULT__' 占位）
    const scopeKey = body.scope ?? '__DEFAULT__';
    const conflict = await prisma.cancellationPolicy.findUnique({
      where: { productKind_scope: { productKind: body.productKind, scope: scopeKey } },
    });
    if (conflict) {
      throw new BadRequestError(
        `${body.productKind} 已有 ${body.scope ? `针对 ${body.scope} 的` : '默认'}策略，请改用 PATCH 更新`,
      );
    }

    // 同 kind 只允许一条 isDefault；clear-then-create 必须在一个 tx 里，
    // 否则两个 admin 并发"设默认"可能都成功（migration 还加了 partial unique index 双保险）
    const policy = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.cancellationPolicy.updateMany({
          where: { productKind: body.productKind, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.cancellationPolicy.create({
        data: {
          productKind: body.productKind,
          scope: scopeKey,
          name: body.name,
          tiers: normalizedTiers as unknown as Prisma.InputJsonValue,
          isDefault: body.isDefault ?? false,
          notes: body.notes ?? null,
        },
      });
    });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_CANCELLATION_POLICY',
      targetType: 'PRICING',
      targetId: policy.id,
      targetLabel: `${policy.productKind} · ${policy.name}`,
      after: { tiers: body.tiers, isDefault: policy.isDefault },
      severity: 'WARNING',
    });

    return reply.status(201).send({ policy });
  });

  app.patch('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = updateBodySchema.parse(req.body);

    const existing = await prisma.cancellationPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('取消政策不存在');

    let normalizedTiers: unknown = undefined;
    if (body.tiers) {
      const v = validateTiers(body.tiers);
      if (!v.ok) throw new BadRequestError(`tiers 无效：${v.error}`);
      normalizedTiers = v.normalized;
    }

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.tiers !== undefined) data.tiers = normalizedTiers;
    if (body.isDefault !== undefined) data.isDefault = body.isDefault;
    if (body.notes !== undefined) data.notes = body.notes ?? null;
    if (body.scope !== undefined) data.scope = body.scope ?? '__DEFAULT__';

    // tx：clear other defaults + update self 必须原子（防并发都成默认）
    const policy = await prisma.$transaction(async (tx) => {
      if (body.isDefault === true && !existing.isDefault) {
        await tx.cancellationPolicy.updateMany({
          where: { productKind: existing.productKind, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.cancellationPolicy.update({ where: { id }, data });
    });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_CANCELLATION_POLICY',
      targetType: 'PRICING',
      targetId: policy.id,
      targetLabel: `${policy.productKind} · ${policy.name}`,
      before: { tiers: existing.tiers, isDefault: existing.isDefault, name: existing.name },
      after: { tiers: policy.tiers, isDefault: policy.isDefault, name: policy.name },
      severity: 'WARNING',
    });

    return { policy };
  });

  app.delete('/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.cancellationPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('取消政策不存在');
    if (existing.isDefault) {
      throw new BadRequestError('默认策略不可删除（先把另一条标记为默认，再删此条）');
    }

    await prisma.cancellationPolicy.delete({ where: { id } });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_CANCELLATION_POLICY',
      targetType: 'PRICING',
      targetId: id,
      targetLabel: `${existing.productKind} · ${existing.name}`,
      before: { tiers: existing.tiers, isDefault: existing.isDefault },
      severity: 'WARNING',
    });

    return { ok: true };
  });
};
