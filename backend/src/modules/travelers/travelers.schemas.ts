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
