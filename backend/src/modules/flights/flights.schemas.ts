import { z } from 'zod';
import { CabinClass } from '@prisma/client';

// ── 搜索 ──────────────────────────────────────────────────────────────────
export const flightSearchQuerySchema = z.object({
  origin: z.string().min(3).max(3).transform((v) => v.toUpperCase()).optional(),
  destination: z.string().min(3).max(3).transform((v) => v.toUpperCase()).optional(),
  // yyyy-mm-dd，表示出发本地日期（按 Asia/Shanghai 粗略匹配）
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cabin: z.nativeEnum(CabinClass).optional(),
  passengers: z.coerce.number().int().min(1).max(9).default(1),
});
export type FlightSearchQuery = z.infer<typeof flightSearchQuerySchema>;

// ── 航班维护 (admin) ──────────────────────────────────────────────────────
export const createFlightBodySchema = z.object({
  flightNumber: z.string().min(3).max(10).regex(/^[A-Z0-9]+$/i),
  originCode: z.string().min(3).max(3),
  destinationCode: z.string().min(3).max(3),
  aircraftType: z.string().min(1).max(20).optional(),
});
export type CreateFlightBody = z.infer<typeof createFlightBodySchema>;

export const createScheduleBodySchema = z.object({
  flightId: z.string().min(1),
  // ISO 字符串，本地时间带时区或 UTC
  departureTime: z.string().datetime(),
  arrivalTime: z.string().datetime(),
  departureTz: z.string().default('Asia/Shanghai'),
  arrivalTz: z.string().default('Asia/Shanghai'),
  // 班次开票上限（张）；缺省走 DB 默认 191
  ticketingCap: z.number().int().min(1).max(600).optional(),
  seatClasses: z
    .array(
      z.object({
        cabin: z.nativeEnum(CabinClass),
        capacity: z.number().int().min(1).max(600),
        basePrice: z.number().positive().max(1_000_000),
      }),
    )
    .min(1),
});
export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>;
