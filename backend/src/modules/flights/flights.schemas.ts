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

// ── 航班级编辑（升舱差价单一配置源 + 商务舱价格联动开关）────────────────────
// 两字段都 optional：只传要改的字段（PATCH 语义）。差价 0–1,000,000 的非负整数。
export const updateFlightBodySchema = z
  .object({
    businessUpgradeCnyPerLeg: z.number().int().nonnegative().max(1_000_000).optional(),
    businessPriceLinked: z.boolean().optional(),
  })
  .refine((b) => b.businessUpgradeCnyPerLeg !== undefined || b.businessPriceLinked !== undefined, {
    message: '至少提供一个可编辑字段',
  });
export type UpdateFlightBody = z.infer<typeof updateFlightBodySchema>;

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
  // 开票上限不在此处配置：上限 = 下面 seatClasses 各舱位 capacity 之和。
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

// ── 批量删除班次（按出发日区间；已售班次自动跳过）────────────────────────
// from/to 为出发地当地(UTC+8)日期 YYYY-MM-DD（闭区间）；flightId 可选（省略=全部航班）。
// 语义：区间内每个无销售的班次硬删，已售/有订单关联的跳过并回报，绝不误删已卖班次。
export const batchDeleteSchedulesBodySchema = z
  .object({
    flightId: z.string().min(1).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'from 格式应为 YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'to 格式应为 YYYY-MM-DD'),
  })
  .superRefine((body, ctx) => {
    if (body.to < body.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '结束日期不能早于开始日期' });
    }
  });
export type BatchDeleteSchedulesBody = z.infer<typeof batchDeleteSchedulesBodySchema>;

// ── 批量改容量（按 scheduleId 列表；镜像批量删除的响应形状）────────────────
// scheduleIds 由前端按"日期区间 + 星期几"筛出（复用批量改价面板已有的班次选择范围）；
// seatClasses 每条 {cabin, capacity} 套用到每个命中班次的对应舱位——该班次没有此舱位
// 则这一项静默跳过；容量低于该班次已售张数则整条班次跳过（不改），回报 skipped。
export const batchUpdateCapacityBodySchema = z.object({
  scheduleIds: z.array(z.string().min(1)).min(1).max(2000),
  seatClasses: z
    .array(
      z.object({
        cabin: z.nativeEnum(CabinClass),
        capacity: z.number().int().min(0).max(600),
      }),
    )
    .min(1)
    .max(4)
    .superRefine((items, ctx) => {
      const seen = new Set<CabinClass>();
      for (const item of items) {
        if (seen.has(item.cabin)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `舱等 ${item.cabin} 重复` });
        }
        seen.add(item.cabin);
      }
    }),
});
export type BatchUpdateCapacityBody = z.infer<typeof batchUpdateCapacityBodySchema>;

// ── 批量改时刻（按 scheduleId 列表；航司整段改点）──────────────────────────
// 运营填的是**当地钟点**（"这批班次改成当地 16:40 起飞 / 17:35 到达"），不是 UTC——
// 每个班次按自己的 departureTz/arrivalTz 折回 UTC 落库，各班次的当地出发日保持不变。
// arrivalNextDay：到达跨零点（当地次日）时勾上，到达日 = 出发当地日 + 1。
// confirmSoldTimeChange：与单班次改时刻同一道闸——批次里有已售班次时必须显式确认，
// 因为改点影响存量订单的客人通知 / 签证时点 / 酒店入住 / 已提交航司的名单。
const LOCAL_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const batchUpdateScheduleTimesBodySchema = z.object({
  scheduleIds: z.array(z.string().min(1)).min(1).max(2000),
  departureLocalTime: z.string().regex(LOCAL_HHMM, '出发时刻请填 HH:mm（24 小时制）'),
  arrivalLocalTime: z.string().regex(LOCAL_HHMM, '到达时刻请填 HH:mm（24 小时制）'),
  arrivalNextDay: z.boolean().default(false),
  confirmSoldTimeChange: z.boolean().optional(),
});
export type BatchUpdateScheduleTimesBody = z.infer<typeof batchUpdateScheduleTimesBodySchema>;

// ── 单班次编辑（月历库存视图：改价 / 改容量 / 停用启用 / 改时刻）────────────
// 全部可选，但至少给一个；seatClasses 内每条按 cabin 定位，basePrice/capacity 各自可选
export const updateScheduleBodySchema = z
  .object({
    isActive: z.boolean().optional(),
    // 航司改点：ISO datetime 字符串（本地时间带时区或 UTC）
    departureTime: z.string().datetime().optional(),
    arrivalTime: z.string().datetime().optional(),
    // A11 二次确认：已售班次改时刻影响存量订单（客人通知/签证/酒店/已导名单），
    // 必须显式带上此标志才放行；缺省 false → 已售班次改点被 400 拦下并回报影响面。
    confirmSoldTimeChange: z.boolean().optional(),
    // 关柜提前分钟数（选填）：起飞前多少分钟关闭值机柜台，是 no-show 判定的时间锚点。
    // null = 清空 = 回落系统默认（见 lib/checkin-close.ts）；不传 = 不改这一项。
    // 上限 24 小时：再大就不是关柜而是填错了（比如把秒当成分钟填进来）。
    checkinCloseMinutes: z.number().int().min(0).max(1440).nullable().optional(),
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
    // 关柜分钟数单独改也算一项变更（null 是「清空回默认」，同样是有效变更）
    const hasCheckinCloseChange = body.checkinCloseMinutes !== undefined;
    if (
      body.isActive === undefined &&
      !hasSeatChanges &&
      !hasTimeChange &&
      !hasCheckinCloseChange
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '至少要改一项（停用启用 / 价格 / 容量 / 时刻 / 关柜提前分钟数）',
      });
    }
  });
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>;
