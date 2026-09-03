import { z } from 'zod';
import { ReminderPriority, ReminderStatus } from '@prisma/client';

export const createReminderSchema = z.object({
  orderId: z.string().optional(),
  title: z.string().min(1).max(120),
  body: z.string().max(2000).optional(),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  priority: z.nativeEnum(ReminderPriority).default('NORMAL'),
  attachmentUrl: z.string().url().optional(),
});

export const updateReminderSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  body: z.string().max(2000).optional(),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.nativeEnum(ReminderPriority).optional(),
  attachmentUrl: z.string().url().nullable().optional(),
});

export const resolveReminderSchema = z.object({
  status: z.enum(['DONE', 'SKIPPED']),
  resolvedNote: z.string().max(500).optional(),
});

export const listRemindersQuerySchema = z.object({
  status: z.nativeEnum(ReminderStatus).optional(),
  priority: z.nativeEnum(ReminderPriority).optional(),
  orderId: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  // auto = 规则自动生成（ruleKey 非空）；manual = 手工创建（ruleKey 为空）
  source: z.enum(['auto', 'manual']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;
export type UpdateReminderInput = z.infer<typeof updateReminderSchema>;
export type ResolveReminderInput = z.infer<typeof resolveReminderSchema>;
export type ListRemindersQuery = z.infer<typeof listRemindersQuerySchema>;

// ── 出票工单角标（顶栏轮询）──────────────────────────────────────────────
// no-show 释放回程 / 恢复回程 / 航段作废三类动作会在同一事务里派 OperationalReminder
// 工单（复用本表，零迁移），ruleKey 固定前缀 + ":" + 行 id + ":" + 幂等 token。
// 票务只有去待办中心才看得到；这里给顶栏一个轻量端点做角标轮询，不建新表。
export const WORK_ORDER_RULE_KINDS = {
  NOSHOW_WITHDRAW: 'WITHDRAW',
  NOSHOW_RELIST: 'RELIST',
  LEG_CANCEL_WITHDRAW: 'LEG_CANCEL_WITHDRAW',
} as const;

export type WorkOrderKind = (typeof WORK_ORDER_RULE_KINDS)[keyof typeof WORK_ORDER_RULE_KINDS];

/** ruleKey → 工单类型；前缀不在上表内返回 null（查询已按前缀过滤，正常不会发生）。 */
export function deriveWorkOrderKind(ruleKey: string | null): WorkOrderKind | null {
  if (!ruleKey) return null;
  const prefix = ruleKey.split(':')[0];
  return (WORK_ORDER_RULE_KINDS as Record<string, WorkOrderKind | undefined>)[prefix] ?? null;
}

export const workOrderSummaryQuerySchema = z.object({
  // 只影响 items（返回 createdAt > since 的新增行）；open/inProgress 计数不受影响。
  since: z.string().datetime().optional(),
});

export type WorkOrderSummaryQuery = z.infer<typeof workOrderSummaryQuerySchema>;
