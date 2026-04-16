import { z } from 'zod';
import { CabinClass } from '@prisma/client';

export const priceQuerySchema = z.object({
  scheduleId: z.string().min(1),
  cabin: z.nativeEnum(CabinClass),
  qty: z.coerce.number().int().min(1).max(9).default(1),
});
export type PriceQuery = z.infer<typeof priceQuerySchema>;
