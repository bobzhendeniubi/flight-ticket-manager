import { z } from 'zod';
import { SettlementMode } from '@prisma/client';

// ── 名单格式绑定（批量创单防呆）─────────────────────────────────────────────
// 代理惯用的粘贴名单格式，三选一（字符串常量，中性描述名）；null = 未登记。
export const ROSTER_FORMATS = [
  'COLON_MULTILINE_YMD', // 冒号多行 · 日期年-月-日
  'INLINE_NUMBERED', // 编号单行空格式
  'COLON_MULTILINE_DMY', // 冒号多行 · 日期日-月-年
] as const;
export type RosterFormat = (typeof ROSTER_FORMATS)[number];

// 识别词条：每条 trim、去空、去重；单条 ≤20 字符，最多 10 条。
const rosterKeywordsSchema = z
  .array(z.string().trim().max(20, '识别词条每条最多 20 字符'))
  .transform((arr) => [...new Set(arr.filter((k) => k.length > 0))])
  .refine((arr) => arr.length <= 10, { message: '识别词条最多 10 条' });

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
  // 名单格式绑定 + 识别词条（可选；词条全局查重在服务层）
  rosterFormat: z.enum(ROSTER_FORMATS).nullable().optional(),
  rosterKeywords: rosterKeywordsSchema.optional(),
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
    // 名单格式绑定：null = 清除登记；词条全局查重在服务层。
    rosterFormat: z.enum(ROSTER_FORMATS).nullable().optional(),
    rosterKeywords: rosterKeywordsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: '至少提供一个要修改的字段' });
export type UpdateAgentBody = z.infer<typeof updateAgentBodySchema>;

// 停用/启用代理登录。
export const setAgentStatusBodySchema = z.object({
  isActive: z.boolean(),
});
export type SetAgentStatusBody = z.infer<typeof setAgentStatusBodySchema>;
