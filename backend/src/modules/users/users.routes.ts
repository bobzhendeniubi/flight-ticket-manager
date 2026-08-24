import type { FastifyPluginAsync } from 'fastify';
import { Prisma, StaffRole, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { AuthService } from '../auth/auth.service.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

/** 与 auth.service 的登出/全撤销口径一致：打到过去，避开 refresh 并发宽限窗。 */
function expireImmediately(): Date {
  return new Date(Date.now() - 1000);
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  const authService = new AuthService(app);

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        staffRole: true,
        displayName: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
        lastLoginAt: true,
        disabledAt: true,
        mustChangePassword: true,
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
        disabledAt: true,
        mustChangePassword: true,
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return { staff };
  });

  app.post('/staff', adminOnly, async (req, reply) => {
    const body = z
      .object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(128),
        displayName: z.string().min(1).max(100),
        role: z.enum(['ADMIN', 'STAFF']),
        staffRole: z.nativeEnum(StaffRole).nullable().optional(),
      })
      .parse(req.body);

    const user = await authService.createInternalUser({
      ...body,
      role: body.role === 'ADMIN' ? UserRole.ADMIN : UserRole.STAFF,
    });
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_STAFF_USER',
      targetType: 'AUTH',
      targetId: user.id,
      targetLabel: user.displayName ?? user.email ?? user.id,
      after: { role: user.role, staffRole: user.staffRole },
      severity: 'WARNING',
    });
    return reply.status(201).send({ user });
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

  app.patch('/:id/disabled', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ disabled: z.boolean() }).parse(req.body);
    if (body.disabled && id === req.user.sub) throw new BadRequestError('不能停用自己的账号');

    let target: {
      id: string;
      role: UserRole;
      email: string | null;
      displayName: string | null;
      disabledAt: Date | null;
    };
    let updated: { disabledAt: Date | null };
    try {
      ({ target, updated } = await prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: { id },
          select: {
            id: true,
            role: true,
            email: true,
            displayName: true,
            disabledAt: true,
          },
        });
        if (!target) throw new NotFoundError('用户不存在');

        // 可用管理员计数与状态更新必须在同一 Serializable 事务内，避免最后一个管理员的 TOCTOU。
        if (target.role === UserRole.ADMIN && body.disabled && target.disabledAt === null) {
          const availableAdmins = await tx.user.count({
            where: {
              role: UserRole.ADMIN,
              disabledAt: null,
              id: { not: id },
            },
          });
          if (availableAdmins === 0) {
            throw new BadRequestError('至少保留一个可用的管理员账号');
          }
        }

        const disabledAt = body.disabled ? new Date() : null;
        const user = await tx.user.update({
          where: { id },
          data: body.disabled
            ? { disabledAt, authVersion: { increment: 1 } }
            : { disabledAt },
          select: { disabledAt: true },
        });
        if (body.disabled) {
          await tx.refreshToken.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date(), expiresAt: expireImmediately() },
          });
        }
        return { target, updated: user };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new BadRequestError('操作冲突，请重试');
      }
      throw error;
    }

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SET_USER_DISABLED',
      targetType: 'AUTH',
      targetId: id,
      targetLabel: target.displayName ?? target.email ?? id,
      before: { disabledAt: target.disabledAt },
      after: { disabledAt: updated.disabledAt },
      severity: 'WARNING',
    });
    return { ok: true, disabledAt: updated.disabledAt };
  });

  app.post('/:id/reset-password', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ newPassword: z.string().min(8).max(128) }).parse(req.body);
    if (id === req.user.sub) throw new BadRequestError('不能重置自己的密码，请使用「修改密码」');
    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, displayName: true, mustChangePassword: true },
    });
    if (!target) throw new NotFoundError('用户不存在');

    await authService.adminResetPassword(id, body.newPassword);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RESET_USER_PASSWORD',
      targetType: 'AUTH',
      targetId: id,
      targetLabel: target.displayName ?? target.email ?? id,
      before: { mustChangePassword: target.mustChangePassword },
      after: { mustChangePassword: true },
      severity: 'WARNING',
    });
    return { ok: true };
  });
};
