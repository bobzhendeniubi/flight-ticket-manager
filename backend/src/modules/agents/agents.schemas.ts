import { z } from 'zod';
import { SettlementMode } from '@prisma/client';

export const setSettlementModeBodySchema = z.object({
  settlementMode: z.nativeEnum(SettlementMode),
});
export type SetSettlementModeBody = z.infer<typeof setSettlementModeBodySchema>;

export const createChildAgentBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100),
  contactName: z.string().min(1).max(50),
  contactPhone: z.string().min(6).max(30),
  companyName: z.string().max(100).optional(),
  prepaymentBalance: z.number().min(0).max(10_000_000).default(0),
  notes: z.string().max(500).optional(),
});
export type CreateChildAgentBody = z.infer<typeof createChildAgentBodySchema>;
