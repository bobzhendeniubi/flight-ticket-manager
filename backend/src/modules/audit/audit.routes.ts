/**
 * 审计日志查询 API（ADMIN/STAFF 专用）
 *
 * GET /audit-logs  按 actor/target/严重度/时间范围过滤 + 分页
 */
import type { FastifyPluginAsync } from 'fastify';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { listAuditLogsQuerySchema } from './audit.schemas.js';

export const auditRoutes: FastifyPluginAsync = async (app) => {
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  app.get('/', pre, async (req) => {
    const q = listAuditLogsQuerySchema.parse(req.query);
    const where: Prisma.AuditLogWhereInput = {};
    if (q.actorUserId) where.actorUserId = q.actorUserId;
    if (q.targetType) where.targetType = q.targetType;
    if (q.targetId) where.targetId = q.targetId;
    if (q.action) where.action = { contains: q.action, mode: 'insensitive' };
    if (q.severity) where.severity = q.severity;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(q.to ? { lte: new Date(`${q.to}T23:59:59Z`) } : {}),
      };
    }
    if (q.search) {
      where.OR = [
        { actorLabel: { contains: q.search, mode: 'insensitive' } },
        { targetLabel: { contains: q.search, mode: 'insensitive' } },
        { action: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: q.pageSize,
        skip: (q.page - 1) * q.pageSize,
        include: { actor: { select: { displayName: true, email: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    // actorLabel 是写入时缓存的快照，很多写入路径压根没填（见 lib/audit.ts actorFromRequest
    // 不设 label）；这里回退到关联账号的 displayName/email，账号已删/系统任务时才落 null
    // （前端兜底显示"系统"）。响应字段形状不变（仍叫 actorLabel），前端零改动即受益。
    const logs = rows.map(({ actor, ...log }) => ({
      ...log,
      actorLabel: log.actorLabel ?? actor?.displayName ?? actor?.email ?? null,
    }));

    return {
      logs,
      pagination: { page: q.page, pageSize: q.pageSize, total },
    };
  });
};
