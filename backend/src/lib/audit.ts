/**
 * 审计日志助手 — 简单的 fire-and-forget 写入。
 *
 * 为避免事务污染，审计写入不参与业务事务；失败时静默记录到 console。
 * 用法：
 *   await writeAudit({ actor, action: 'UPDATE_PRICING', targetType: 'PRICING', ... });
 *
 * 触发点约定：在 service 层完成主操作后调用（成功才记录）。
 */
import { AuditSeverity, AuditTargetType, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export interface AuditActor {
  userId?: string;
  label?: string;      // email / displayName
  role?: UserRole | 'SYSTEM';
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;                 // 大写下划线：CREATE_AGENT / ADVANCE_ORDER_STATUS
  targetType: AuditTargetType;
  targetId?: string;
  targetLabel?: string;
  before?: unknown;
  after?: unknown;
  severity?: AuditSeverity;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: entry.actor.userId ?? null,
        actorLabel: entry.actor.label ?? null,
        actorRole: entry.actor.role ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        before: (entry.before ?? null) as Prisma.InputJsonValue,
        after: (entry.after ?? null) as Prisma.InputJsonValue,
        severity: entry.severity ?? AuditSeverity.INFO,
        ipAddress: entry.actor.ipAddress ?? null,
        userAgent: entry.actor.userAgent ?? null,
      },
    });
  } catch (err) {
    // 审计写失败不应影响主流程；只记日志
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write:', err, entry);
  }
}

/** 从 Fastify request 提取 actor 元数据 */
export function actorFromRequest(req: {
  user?: { sub: string; role: UserRole };
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}): AuditActor {
  return {
    userId: req.user?.sub,
    role: req.user?.role,
    ipAddress: req.ip,
    userAgent: Array.isArray(req.headers?.['user-agent'])
      ? req.headers['user-agent'][0]
      : (req.headers?.['user-agent'] as string | undefined),
  };
}
