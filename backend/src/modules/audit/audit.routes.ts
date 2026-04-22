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
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      logs: rows,
      pagination: { page: q.page, pageSize: q.pageSize, total },
    };
  });
};
