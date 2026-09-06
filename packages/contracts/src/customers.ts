import { z } from 'zod';

export const listCustomersQuerySchema = z.object({
  search: z.string().max(120).optional(),       // 姓名/电话/邮箱
  agentId: z.string().optional(),
  tag: z.string().max(50).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

export const updateCustomerBodySchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  phone: z.string().min(5).max(40).optional(),
  email: z.string().email().optional(),
  idNumber: z.string().max(40).optional().nullable(),
  primaryAgentId: z.string().optional().nullable(),
  tags: z.array(z.string().max(50)).optional(),
  notes: z.string().max(1000).optional().nullable(),
});
export type UpdateCustomerBody = z.infer<typeof updateCustomerBodySchema>;
