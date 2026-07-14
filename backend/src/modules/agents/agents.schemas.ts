import { z } from 'zod';
import { SettlementMode } from '@prisma/client';

export const setSettlementModeBodySchema = z.object({
  settlementMode: z.nativeEnum(SettlementMode),
});
export type SetSettlementModeBody = z.infer<typeof setSettlementModeBodySchema>;

// 建代理不接受初始余额：余额恒为 0，只能事后经认款通道（agent-recharges 的
// confirm/manualAdjust）流水化产生，每次变动必有 PrepaymentTransaction + 审计。
// 详见 createChildAgent() 服务层注释与 schema.prisma 的 AgentRechargeRequest 口径。
export const createChildAgentBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100),
  contactName: z.string().min(1).max(50),
  contactPhone: z.string().min(6).max(30),
  companyName: z.string().max(100).optional(),
  notes: z.string().max(500).optional(),
});
export type CreateChildAgentBody = z.infer<typeof createChildAgentBodySchema>;

// 编辑代理基础联系信息。所有字段可选（PATCH 语义，只改传入的字段），
// 但至少要传一个，否则前端多半是误触。email 落在 User 表（唯一），其余落在 Agent 表。
export const updateAgentBodySchema = z
  .object({
    companyName: z.string().trim().max(100).optional(),
    contactName: z.string().trim().min(1).max(50).optional(),
    contactPhone: z.string().trim().min(6).max(30).optional(),
    email: z.string().trim().email().max(255).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: '至少提供一个要修改的字段' });
export type UpdateAgentBody = z.infer<typeof updateAgentBodySchema>;

// 停用/启用代理登录。
export const setAgentStatusBodySchema = z.object({
  isActive: z.boolean(),
});
export type SetAgentStatusBody = z.infer<typeof setAgentStatusBodySchema>;
