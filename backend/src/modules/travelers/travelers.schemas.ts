import { z } from 'zod';
import { DocumentType, PassengerType } from '@prisma/client';

export const listTravelersQuerySchema = z.object({
  search: z.string().max(120).optional(),       // 姓名/护照号
  userId: z.string().optional(),                 // 关联某客户
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListTravelersQuery = z.infer<typeof listTravelersQuerySchema>;

export const createTravelerBodySchema = z.object({
  userId: z.string(),
  fullName: z.string().min(1).max(120),
  documentType: z.nativeEnum(DocumentType).default('PASSPORT'),
  documentNumber: z.string().min(3).max(40),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nationality: z.string().length(2).default('CN'),
  passengerType: z.nativeEnum(PassengerType).default('ADULT'),
  phone: z.string().max(40).optional(),
  notes: z.string().max(500).optional(),
});
export type CreateTravelerBody = z.infer<typeof createTravelerBodySchema>;

export const updateTravelerBodySchema = createTravelerBodySchema.partial().omit({ userId: true });
export type UpdateTravelerBody = z.infer<typeof updateTravelerBodySchema>;

// ── 旅客档案（TravelerProfile，按证件号聚合的常旅客画像）──

export const listTravelerProfilesQuerySchema = z.object({
  search: z.string().max(120).optional(), // 姓名/中文名/证件号
  sort: z.enum(['lastTripAt', 'nextTripAt', 'tripCount', 'totalSpendCny']).default('lastTripAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  minTrips: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListTravelerProfilesQuery = z.infer<typeof listTravelerProfilesQuerySchema>;

export const updateTravelerProfileNotesBodySchema = z.object({
  notes: z.string().max(1000).nullable(),
});
export type UpdateTravelerProfileNotesBody = z.infer<typeof updateTravelerProfileNotesBodySchema>;

// 录单联想：q trim 后不足 2 字符由 service 直接返回空数组（不报错，输入中的正常态）
export const suggestTravelerProfilesQuerySchema = z.object({
  q: z.string().max(120).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type SuggestTravelerProfilesQuery = z.infer<typeof suggestTravelerProfilesQuerySchema>;

// 批量查常旅客次数（按证件号，订单详情抽屉用）：1~100 条，documentNumber trim 后不得为空
const lookupTravelerDocumentSchema = z.object({
  documentType: z.nativeEnum(DocumentType),
  documentNumber: z.string().trim().min(1),
});
export const lookupTravelerProfilesBodySchema = z.object({
  documents: z.array(lookupTravelerDocumentSchema).min(1).max(100),
});
export type LookupTravelerProfilesBody = z.infer<typeof lookupTravelerProfilesBodySchema>;

// 档案合并：把 :id 并进 intoId（同人换证归一，不做解除合并）
export const mergeTravelerProfileBodySchema = z.object({
  intoId: z.string().min(1),
});
export type MergeTravelerProfileBody = z.infer<typeof mergeTravelerProfileBodySchema>;

// ── 权益核销台账（append-only，只增不改不删）──

// 核销：tripsUsed 必须是正整数（扣减可用次数）；负数条目只能由冲正接口产生
export const createRedemptionBodySchema = z.object({
  tripsUsed: z.coerce.number().int().min(1).max(999),
  benefit: z.string().trim().min(1).max(200),
  note: z.string().max(500).optional(),
});
export type CreateRedemptionBody = z.infer<typeof createRedemptionBodySchema>;

// 冲正：只带一个说明；补回的次数与权益内容都从被冲正的原条目照抄
export const reverseRedemptionBodySchema = z.object({
  note: z.string().max(500).nullable().optional(),
});
export type ReverseRedemptionBody = z.infer<typeof reverseRedemptionBodySchema>;
