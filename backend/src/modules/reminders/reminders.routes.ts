/**
 * 操作部待办/特殊提醒 — ADMIN/STAFF only
 *
 * 用户场景（来自反馈）：
 *   - 签证组：客人很急、要先办批文、改期入境等场景，需要醒目待办，每天下班前清理
 *   - 票务组：往返航班拆开开票、需要批文+酒店单过海关
 *   - 仪表盘"我的待办"小窗口 + 详情页"加待办"按钮
 *
 * GET    /reminders          列表（含我的/未认领过滤）
 * POST   /reminders          新建
 * PATCH  /reminders/:id      编辑（标题/正文/dueAt/priority）
 * POST   /reminders/:id/claim     认领（设 claimedById = 自己）
 * POST   /reminders/:id/release   释放（claimedById → null）
 * POST   /reminders/:id/resolve   完成 / 跳过
 */
import type { FastifyPluginAsync } from 'fastify';
import { Prisma, ReminderStatus, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  createReminderSchema,
  listRemindersQuerySchema,
  resolveReminderSchema,
  updateReminderSchema,
} from './reminders.schemas.js';

export const reminderRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };

  app.get('/', requireOps, async (req) => {
    const q = listRemindersQuerySchema.parse(req.query);
    const where: Prisma.OperationalReminderWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.priority) where.priority = q.priority;
    if (q.orderId) where.orderId = q.orderId;
    if (q.mine) where.claimedById = req.user.sub;

    const [rows, total] = await prisma.$transaction([
      prisma.operationalReminder.findMany({
        where,
        orderBy: [
          { status: 'asc' },
          { priority: 'desc' },
          { dueAt: 'asc' },
          { createdAt: 'desc' },
        ],
        include: {
          createdBy: { select: { id: true, email: true, displayName: true } },
          claimedBy: { select: { id: true, email: true, displayName: true } },
          order: { select: { id: true, orderNumber: true, status: true, contactName: true } },
        },
        take: q.pageSize,
        skip: (q.page - 1) * q.pageSize,
      }),
      prisma.operationalReminder.count({ where }),
    ]);

    return { reminders: rows, pagination: { page: q.page, pageSize: q.pageSize, total } };
  });

  app.post('/', requireOps, async (req) => {
    const body = createReminderSchema.parse(req.body);
    const created = await prisma.operationalReminder.create({
      data: {
        orderId: body.orderId,
        createdById: req.user.sub,
        title: body.title,
        body: body.body,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        priority: body.priority,
        attachmentUrl: body.attachmentUrl,
      },
      include: {
        createdBy: { select: { id: true, email: true, displayName: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_REMINDER',
      targetType: 'SYSTEM',
      targetId: created.id,
      targetLabel: created.title,
      after: { priority: body.priority, dueAt: body.dueAt, orderId: body.orderId },
    });
    return { reminder: created };
  });

  app.patch('/:id', requireOps, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateReminderSchema.parse(req.body);
    const before = await prisma.operationalReminder.findUnique({ where: { id } });
    if (!before) return reply.status(404).send({ error: '提醒不存在' });
    const updated = await prisma.operationalReminder.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.body !== undefined && { body: body.body }),
        ...(body.dueAt !== undefined && { dueAt: body.dueAt ? new Date(body.dueAt) : null }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.attachmentUrl !== undefined && { attachmentUrl: body.attachmentUrl }),
      },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_REMINDER',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: updated.title,
      before,
      after: body,
    });
    return { reminder: updated };
  });

  app.post('/:id/claim', requireOps, async (req) => {
    const { id } = req.params as { id: string };
    const updated = await prisma.operationalReminder.update({
      where: { id },
      data: { claimedById: req.user.sub, status: ReminderStatus.IN_PROGRESS },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CLAIM_REMINDER',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: updated.title,
    });
    return { reminder: updated };
  });

  app.post('/:id/release', requireOps, async (req) => {
    const { id } = req.params as { id: string };
    const updated = await prisma.operationalReminder.update({
      where: { id },
      data: { claimedById: null, status: ReminderStatus.OPEN },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RELEASE_REMINDER',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: updated.title,
    });
    return { reminder: updated };
  });

  app.post('/:id/resolve', requireOps, async (req) => {
    const { id } = req.params as { id: string };
    const body = resolveReminderSchema.parse(req.body);
    const updated = await prisma.operationalReminder.update({
      where: { id },
      data: {
        status: body.status === 'DONE' ? ReminderStatus.DONE : ReminderStatus.SKIPPED,
        resolvedAt: new Date(),
        resolvedNote: body.resolvedNote,
      },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RESOLVE_REMINDER',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: updated.title,
      after: { status: body.status, note: body.resolvedNote },
    });
    return { reminder: updated };
  });
};
