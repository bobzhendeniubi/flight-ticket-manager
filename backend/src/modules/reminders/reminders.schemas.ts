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
