/**
 * 结算价日历 service — 运营维护「出发日期 × 晚数 × 酒店档次」的每人同业结算价（CNY）。
 *
 * 口径：
 *   - date-only 匹配：SettlementRate.departDate 是 @db.Date；YMD 字符串统一按 UTC 零点折成 Date
 *     再存/查（ymdToUtcDate），避免本地时区把日期挪前一天。读回同样按 UTC 口径 slice YMD。
 *   - 唯一键 (tier, nights, departDate)：一个组合一个每人价；批量 upsert 以此幂等，重复提交只覆盖不新增。
 *   - getSettlementRate 供代理下单自动取价复用（orders.service）——只查不改，命中返回价、未维护返回 null。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计（镜像 hotel-control / finances 成本周期风格）。
 */
import { SettlementTier, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import type { ListRatesQuery, RateEntry } from './settlement-rates.schemas.js';

/**
 * YMD（YYYY-MM-DD）→ UTC 零点 Date（@db.Date 存/查用）。
 * 用 Date.UTC 折日，避免服务器本地时区把日期挪前一天（date-only 语义只认年月日）。
 * 非法输入抛 BadRequestError（调用方均来自已通过 zod dateStr 校验的入参，此处是最后一道防御）。
 */
export function ymdToUtcDate(ymd: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(ymd);
  if (!m) throw new BadRequestError(`非法日期：${ymd}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`非法日期：${ymd}`);
  return d;
}

/** @db.Date 读回 Date → YMD（UTC 口径，与 ymdToUtcDate 对称，绝不经本地时区跨天）。 */
export function utcDateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SettlementRateDto {
  id: string;
  tier: SettlementTier;
  nights: number;
  departDate: string; // YMD
  pricePerPersonCny: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

function serialize(row: {
  id: string;
  tier: SettlementTier;
  nights: number;
  departDate: Date;
  pricePerPersonCny: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}): SettlementRateDto {
  return {
    id: row.id,
    tier: row.tier,
    nights: row.nights,
    departDate: utcDateToYmd(row.departDate),
    pricePerPersonCny: row.pricePerPersonCny,
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 网格查询：按出发日期区间（含端点）+ 可选晚数/档次筛选，供 admin 结算价日历页渲染。
 * 排序：日期 → 晚数 → 档次（稳定顺序，前端按此铺网格）。
 */
export async function listRates(
  q: ListRatesQuery,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto[]> {
  if (q.from > q.to) {
    throw new BadRequestError('起始日期不能晚于结束日期');
  }
  const rows = await client.settlementRate.findMany({
    where: {
      departDate: { gte: ymdToUtcDate(q.from), lte: ymdToUtcDate(q.to) },
      ...(q.nights != null ? { nights: q.nights } : {}),
      ...(q.tier != null ? { tier: q.tier } : {}),
    },
    orderBy: [{ departDate: 'asc' }, { nights: 'asc' }, { tier: 'asc' }],
  });
  return rows.map(serialize);
}

/**
 * 批量 upsert（网格整批保存 / Excel 粘贴块）：每格按 (tier, nights, departDate) 幂等 upsert。
 * 事务包裹——整批同成同败，避免半保存造成网格与库不一致。updatedBy 记最近更新人（展示"谁改的"）。
 */
export async function upsertRates(
  rates: RateEntry[],
  updatedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto[]> {
  const rows = await client.$transaction(
    rates.map((r) =>
      client.settlementRate.upsert({
        where: {
          tier_nights_departDate: {
            tier: r.tier,
            nights: r.nights,
            departDate: ymdToUtcDate(r.departDate),
          },
        },
        create: {
          tier: r.tier,
          nights: r.nights,
          departDate: ymdToUtcDate(r.departDate),
          pricePerPersonCny: r.pricePerPersonCny,
          note: r.note ?? null,
          updatedBy,
        },
        update: {
          pricePerPersonCny: r.pricePerPersonCny,
          note: r.note ?? null,
          updatedBy,
        },
      }),
    ),
  );
  return rows.map(serialize);
}

/** 删除一格（网格清空某单元格）。返回被删行（供审计留痕），不存在返回 null。 */
export async function deleteRate(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto | null> {
  const existing = await client.settlementRate.findUnique({ where: { id } });
  if (!existing) return null;
  await client.settlementRate.delete({ where: { id } });
  return serialize(existing);
}

/**
 * 查价函数（代理下单自动取价 / 网格单格回显复用）：按 (tier, nights, 出发日期) 命中当日每人结算价。
 *   - departDate 为 YMD 字符串（调用方已按班次本地出发日折算），内部按 UTC date-only 匹配。
 *   - 命中返回每人价（+ 元数据），未维护返回 null（调用方据此拒单 / 显示空格）。
 */
export async function getSettlementRate(
  tier: SettlementTier,
  nights: number,
  departDate: string,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto | null> {
  const row = await client.settlementRate.findUnique({
    where: {
      tier_nights_departDate: {
        tier,
        nights,
        departDate: ymdToUtcDate(departDate),
      },
    },
  });
  return row ? serialize(row) : null;
}
