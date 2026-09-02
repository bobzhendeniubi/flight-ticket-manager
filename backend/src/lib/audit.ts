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

/**
 * AuditEntry → auditLog.create 的 data（writeAudit 与 writeAuditWithinTx 共用同一份字段映射，
 * 避免「事务内写的审计」和「事后写的审计」字段口径慢慢分叉）。
 */
function toAuditCreateData(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  return {
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
  };
}

/**
 * **事务内**写审计：与业务写入同一个事务，一起成功、一起回滚。
 *
 * 与 writeAudit 的取舍：writeAudit 是 fire-and-forget（写失败不拖垮主流程），适合「事情已经做完了、
 * 审计只是留痕」的绝大多数场景；本函数适合**审计本身就是放行条件**的动作 —— 典型是超售放行：
 * 座位真的被卖穿了，如果审计没写成而占座写成了，事后就查不出是谁放的行。这种要么都成、要么都不成。
 *
 * 调用方必须已经在 prisma.$transaction 里，并把 tx 传进来；失败会直接上抛，让整个事务回滚。
 */
export async function writeAuditWithinTx(
  tx: Prisma.TransactionClient,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({ data: toAuditCreateData(entry) });
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: toAuditCreateData(entry) });
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
