/**
 * 美金汇率表 service —— 财务按「生效日」维护 USD→CNY 汇率。
 *
 * 口径（已拍板）：
 *   - 只填生效日，不填结束日：区间由**下一条的生效日**隐含，因此无空洞、无重叠。
 *     例：加「2026-08-05 起 7.16」→ 08-05 起一直用 7.16，直到出现更晚的一条。
 *   - 取数 = 「生效日 ≤ 目标日期的最新一条」；比最早一条还早的日期取不到（返回 null）。
 *   - 折算结果**当场固化**在业务单据上（签证任务的 visaFxRate / visaUnitCostCny）。
 *     之后改这张表**绝不追溯**已折算的旧单据——历史入账金额永远不因改汇率而变。
 *   - date-only 语义：生效日按 UTC 零点存/查（ymdToUtcDate），避免服务器本地时区挪日。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计（镜像成本周期 / 结算价日历风格）。
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';

/**
 * YMD（YYYY-MM-DD）→ UTC 零点 Date（@db.Date 存/查用）。
 * 用 Date.UTC 折日，避免服务器本地时区把日期挪前一天（date-only 只认年月日）。
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

export interface UsdFxRateDto {
  id: string;
  /** 生效日（YYYY-MM-DD）；该日起启用此汇率，直到出现更晚的一条 */
  effectiveFrom: string;
  /** USD→CNY 汇率 */
  rate: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

function serialize(row: {
  id: string;
  effectiveFrom: Date;
  rate: Prisma.Decimal | number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}): UsdFxRateDto {
  return {
    id: row.id,
    effectiveFrom: utcDateToYmd(row.effectiveFrom),
    rate: typeof row.rate === 'number' ? row.rate : Number(row.rate.toString()),
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 全量列表（条数天然很少），按生效日倒序 —— 最近生效的排最前，财务一眼看到"现在用哪个"。 */
export async function listUsdFxRates(client: PrismaClient = defaultPrisma): Promise<UsdFxRateDto[]> {
  const rows = await client.usdFxRate.findMany({ orderBy: { effectiveFrom: 'desc' } });
  return rows.map(serialize);
}

/**
 * 取某日生效的汇率 = 「生效日 ≤ date 的最新一条」。
 * 未维护任何更早记录 → null（调用方据此让用户手填，不臆造汇率）。
 *
 * @param date 目标日期 YMD（如签证任务的入账日 / 当天）
 */
export async function getUsdFxRate(
  date: string,
  client: PrismaClient = defaultPrisma,
): Promise<UsdFxRateDto | null> {
  const row = await client.usdFxRate.findFirst({
    where: { effectiveFrom: { lte: ymdToUtcDate(date) } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return row ? serialize(row) : null;
}

export interface UpsertUsdFxRateInput {
  effectiveFrom: string; // YMD
  rate: number; // > 0
  note?: string | null;
}

/**
 * 按生效日幂等 upsert：同一天重复提交只覆盖不新增（唯一键 effectiveFrom）。
 * updatedBy 记最近更新人（展示"谁改的"）。
 */
export async function upsertUsdFxRate(
  input: UpsertUsdFxRateInput,
  updatedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<UsdFxRateDto> {
  if (!(input.rate > 0)) {
    throw new BadRequestError('汇率需大于 0');
  }
  const effectiveFrom = ymdToUtcDate(input.effectiveFrom);
  const row = await client.usdFxRate.upsert({
    where: { effectiveFrom },
    create: {
      effectiveFrom,
      rate: input.rate,
      note: input.note ?? null,
      updatedBy,
    },
    update: {
      rate: input.rate,
      note: input.note ?? null,
      updatedBy,
    },
  });
  return serialize(row);
}
