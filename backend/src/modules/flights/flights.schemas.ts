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

// ── 行李规则（航班 × 舱等；kg / 件数 / 手提都可单独留空）────────────────
export const baggagePolicyItemSchema = z.object({
  cabin: z.nativeEnum(CabinClass),
  checkedKg: z.number().int().min(0).max(999).nullable().optional(),
  checkedPieces: z.number().int().min(0).max(99).nullable().optional(),
  carryOnKg: z.number().int().min(0).max(99).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});
export type BaggagePolicyItem = z.infer<typeof baggagePolicyItemSchema>;

// PUT 整体替换：数组里没出现的舱等会被删除；同一舱等不可重复
export const upsertBaggagePoliciesBodySchema = z
  .array(baggagePolicyItemSchema)
  .max(4)
  .superRefine((items, ctx) => {
    const seen = new Set<CabinClass>();
    for (const item of items) {
      if (seen.has(item.cabin)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `舱等 ${item.cabin} 重复` });
      }
      seen.add(item.cabin);
    }
  });
export type UpsertBaggagePoliciesBody = z.infer<typeof upsertBaggagePoliciesBodySchema>;

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

// ── 单班次编辑（月历库存视图：改价 / 改容量 / 停用启用）────────────────────
// 全部可选，但至少给一个；seatClasses 内每条按 cabin 定位，basePrice/capacity 各自可选
export const updateScheduleBodySchema = z
  .object({
    isActive: z.boolean().optional(),
    seatClasses: z
      .array(
        z.object({
          cabin: z.nativeEnum(CabinClass),
          basePrice: z.number().min(0).max(1_000_000).optional(),
          capacity: z.number().int().min(0).max(600).optional(),
        }),
      )
      .max(4)
      .superRefine((items, ctx) => {
        const seen = new Set<CabinClass>();
        for (const item of items) {
          if (seen.has(item.cabin)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `舱等 ${item.cabin} 重复` });
          }
          seen.add(item.cabin);
          if (item.basePrice === undefined && item.capacity === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `舱等 ${item.cabin} 至少要改价格或容量之一`,
            });
          }
        }
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    const hasSeatChanges = body.seatClasses !== undefined && body.seatClasses.length > 0;
    if (body.isActive === undefined && !hasSeatChanges) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少要改一项（停用启用 / 价格 / 容量）' });
    }
  });
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>;
