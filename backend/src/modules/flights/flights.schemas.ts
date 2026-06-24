import { z } from 'zod';
import { CabinClass } from '@prisma/client';
import { fareBucketsSchema } from '../pricing/pricing.schemas.js';

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
        // 仓位阶梯（可选）：[{quota,price}]，最便宜的在前；省略 / null / [] = 无阶梯
        fareBuckets: fareBucketsSchema.optional(),
      }),
    )
    .min(1),
});
export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>;

// ── 单班次编辑（月历库存视图：改价 / 改容量 / 停用启用 / 改时刻）────────────
// 全部可选，但至少给一个；seatClasses 内每条按 cabin 定位，basePrice/capacity 各自可选
export const updateScheduleBodySchema = z
  .object({
    isActive: z.boolean().optional(),
    // 航司改点：ISO datetime 字符串（本地时间带时区或 UTC）
    departureTime: z.string().datetime().optional(),
    arrivalTime: z.string().datetime().optional(),
    seatClasses: z
      .array(
        z.object({
          cabin: z.nativeEnum(CabinClass),
          basePrice: z.number().min(0).max(1_000_000).optional(),
          capacity: z.number().int().min(0).max(600).optional(),
          // 仓位阶梯（可选）：[{quota,price}] 设置阶梯；null / [] 清空阶梯（回退旧版自动定价）
          fareBuckets: fareBucketsSchema.optional(),
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
          // 价格 / 容量 / 仓位阶梯，至少改一项（fareBuckets:null 视为"清空阶梯"也算一项变更）
          if (
            item.basePrice === undefined &&
            item.capacity === undefined &&
            item.fareBuckets === undefined
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `舱等 ${item.cabin} 至少要改价格 / 容量 / 仓位阶梯之一`,
            });
          }
        }
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    const hasSeatChanges = body.seatClasses !== undefined && body.seatClasses.length > 0;
    const hasTimeChange = body.departureTime !== undefined || body.arrivalTime !== undefined;
    if (body.isActive === undefined && !hasSeatChanges && !hasTimeChange) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少要改一项（停用启用 / 价格 / 容量 / 时刻）' });
    }
  });
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>;
