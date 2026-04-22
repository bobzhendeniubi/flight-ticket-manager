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

// 审计失败计数器（给监控系统抓取 /metrics 用）
let auditWriteFailureCount = 0;
export function getAuditFailureCount(): number {
  return auditWriteFailureCount;
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
    // 审计写失败不应影响主流程；但必须留有迹可循：
    // 1) 结构化 JSON log 方便日志收集（Loki/CloudWatch 抓 level=error + type=audit_write_failed）
    // 2) 内存计数器 + /metrics 端点可读（未来接 Prometheus）
    // 3) CRITICAL 级审计（支付 / 结算 PAID）失败时抛到主流程让调用方决定
    auditWriteFailureCount++;
    const structured = {
      level: 'error',
      type: 'audit_write_failed',
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      severity: entry.severity ?? 'INFO',
      actorUserId: entry.actor.userId ?? null,
      error: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    };
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(structured));

    // 关键操作审计失败要上抛 — 调用方可选择重试或回滚
    if (entry.severity === AuditSeverity.CRITICAL) {
      throw err;
    }
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
