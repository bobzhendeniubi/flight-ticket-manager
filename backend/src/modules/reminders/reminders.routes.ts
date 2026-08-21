/**
 * 操作部待办/特殊提醒 — ADMIN/STAFF only
 *
 * 用户场景（来自反馈）：
 *   - 签证组：客人很急、要先办批文、改期入境等场景，需要醒目待办，每天下班前清理
 *   - 票务组：往返航班拆开开票、需要批文+酒店单过海关
 *   - 仪表盘"我的待办"小窗口 + 详情页"加待办"按钮
 *
 * GET    /reminders          列表（含我的/未认领/来源过滤）
 * POST   /reminders          新建
 * POST   /reminders/generate 规则化自动生成（幂等，按 ruleKey 去重）
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
  draftMessageSchema,
  listRemindersQuerySchema,
  rankRemindersSchema,
  resolveReminderSchema,
  updateReminderSchema,
} from './reminders.schemas.js';
import { generateRuleReminders } from './reminders.rules.js';
import {
  buildDraftMessages,
  buildDraftHardFacts,
  buildRankMessages,
  callQwenText,
  configuredError,
  parseJsonContent,
  parseRankedResponse,
  renderDraftMessageTemplate,
  resolveQwenConfig,
  validateRankedReminders,
} from './reminders.ai.js';
import { NotFoundError, AppError } from '../../lib/errors.js';

const REMINDER_AI_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

const reminderAiSelect = {
  id: true,
  title: true,
  body: true,
  dueAt: true,
  priority: true,
  status: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      contactName: true,
      total: true,
      paidAmount: true,
      prepaymentOffset: true,
      adjustmentCny: true,
      _count: { select: { passengers: true } },
      items: {
        select: {
          kind: true,
          description: true,
          quantity: true,
          amount: true,
          hotelCheckIn: true,
          hotelCheckOut: true,
          flightSchedule: {
            select: {
              departureTime: true,
              departureTz: true,
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
            },
          },
        },
      },
    },
  },
} as const;

export const reminderRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = {
    preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)],
  };
  const aiRequireOps = {
    ...requireOps,
    config: { rateLimit: REMINDER_AI_RATE_LIMIT },
  };

  app.post('/rank', aiRequireOps, async (req) => {
    const body = rankRemindersSchema.parse(req.body);
    const reminders = await prisma.operationalReminder.findMany({
      where: { id: { in: body.ids } },
      select: reminderAiSelect,
    });
    const config = await resolveQwenConfig();
    if (!config) throw configuredError();

    const content = await callQwenText(buildRankMessages(reminders), config);
    const parsed = parseRankedResponse(parseJsonContent(content));
    return { ranked: validateRankedReminders(body.ids, parsed) };
  });

  app.get('/', requireOps, async (req) => {
    const q = listRemindersQuerySchema.parse(req.query);
    const where: Prisma.OperationalReminderWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.priority) where.priority = q.priority;
    if (q.orderId) where.orderId = q.orderId;
    if (q.mine) where.claimedById = req.user.sub;
    // 来源过滤：auto = 规则自动生成（ruleKey 非空）；manual = 手工创建
    if (q.source === 'auto') where.ruleKey = { not: null };
    else if (q.source === 'manual') where.ruleKey = null;

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

  // 规则化自动生成（催尾款/出行提醒/护照有效期/签证缺件）。
  // 幂等：同 ruleKey 只生成一次，重复调用返回 created=0。
  app.post('/generate', requireOps, async (req) => {
    const result = await generateRuleReminders(prisma, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'GENERATE_RULE_REMINDERS',
      targetType: 'SYSTEM',
      after: { created: result.created, skipped: result.skipped, byRule: result.byRule },
    });
    return result;
  });

  app.post('/:id/draft-message', aiRequireOps, async (req) => {
    const { id } = req.params as { id: string };
    const body = draftMessageSchema.parse(req.body);
    const reminder = await prisma.operationalReminder.findUnique({
      where: { id },
      select: reminderAiSelect,
    });
    if (!reminder) throw new NotFoundError('提醒不存在');

    const config = await resolveQwenConfig();
    if (!config) throw configuredError();

    const facts = buildDraftHardFacts(reminder);
    const messages = buildDraftMessages(reminder, body.audience);
    let lastValidationError: AppError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await callQwenText(messages, config);
      try {
        return { text: renderDraftMessageTemplate(content, facts) };
      } catch (error: unknown) {
        if (!(error instanceof AppError) || error.code !== 'AI_UNTRUSTED_TEMPLATE') {
          throw error;
        }
        lastValidationError = error;
      }
    }
    throw new AppError(
      `AI 话术模板两次均未通过安全校验：${lastValidationError?.message ?? '请稍后重试'}`,
      { statusCode: 502, code: 'AI_UNTRUSTED_TEMPLATE' },
    );
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
