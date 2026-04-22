import { z } from 'zod';
import { AuditSeverity, AuditTargetType } from '@prisma/client';

export const listAuditLogsQuerySchema = z.object({
  actorUserId: z.string().optional(),
  targetType: z.nativeEnum(AuditTargetType).optional(),
  targetId: z.string().optional(),
  action: z.string().max(80).optional(),
  severity: z.nativeEnum(AuditSeverity).optional(),
  search: z.string().max(120).optional(), // 模糊 actor/target label
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
