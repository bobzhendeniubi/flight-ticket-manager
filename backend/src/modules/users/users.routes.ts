import type { FastifyPluginAsync } from 'fastify';
import { StaffRole, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        displayName: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    if (!user) throw new NotFoundError('User not found');
    return { user };
  });

  // ── A20 岗位细分（2026-07-20 拍板「全改」）────────────────────────────
  // 内部账号列表 + 赋岗位。岗位决定导出裁剪：专岗账号的全岗总表被强制裁到本岗模板
  //（见 orders.routes /export/master），改 query 参数也拿不到订单成本/结算价。
  const adminOnly = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] };

  // 列出内部账号（ADMIN + STAFF）及其岗位
  app.get('/staff', adminOnly, async () => {
    const staff = await prisma.user.findMany({
      where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        staffRole: true,
        lastLoginAt: true,
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return { staff };
  });

  // 赋/清岗位（仅 STAFF 可设；ADMIN 全能不设岗）。null = 通用运营（全模板）。
  app.patch('/:id/staff-role', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ staffRole: z.nativeEnum(StaffRole).nullable() })
      .parse(req.body);
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, displayName: true, email: true, staffRole: true },
    });
    if (!target) throw new NotFoundError('用户不存在');
    if (target.role !== UserRole.STAFF) {
      // ADMIN 不设岗（全能）；AGENT/CUSTOMER 没有内部岗位概念。
      return { error: '仅 STAFF 账号可设置岗位', staffRole: null };
    }
    const updated = await prisma.user.update({
      where: { id },
      data: { staffRole: body.staffRole },
      select: { id: true, staffRole: true },
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SET_STAFF_ROLE',
      targetType: 'AUTH', // 账号权限类动作（enum 无 USER，AUTH 最贴切）
      targetId: id,
      targetLabel: target.displayName ?? target.email ?? id,
      before: { staffRole: target.staffRole },
      after: { staffRole: body.staffRole },
      severity: 'WARNING', // 动权限=动可见面，留痕等级同费率
    });
    return { ok: true, staffRole: updated.staffRole };
  });
};
