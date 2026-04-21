import { z } from 'zod';
import { SettlementStatus } from '@prisma/client';

// Period: YYYY-MM
const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

export const generateSettlementsBodySchema = z.object({
  period: z.string().regex(periodRegex, '格式应为 YYYY-MM'),
  agentId: z.string().optional(), // 指定某代理；不传则全部代理
  overwrite: z.boolean().default(false), // true = 覆盖已有（DRAFT/PENDING_APPROVAL 可覆盖，APPROVED/PAID 跳过）
});
export type GenerateSettlementsBody = z.infer<typeof generateSettlementsBodySchema>;

export const listSettlementsQuerySchema = z.object({
  period: z.string().regex(periodRegex).optional(),
  agentId: z.string().optional(),
  status: z.nativeEnum(SettlementStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSettlementsQuery = z.infer<typeof listSettlementsQuerySchema>;

export const updateSettlementStatusBodySchema = z.object({
  toStatus: z.nativeEnum(SettlementStatus),
  notes: z.string().max(500).optional(),
});
export type UpdateSettlementStatusBody = z.infer<typeof updateSettlementStatusBodySchema>;
