/**
 * 美金汇率表 service —— 财务按「签证公司 × 生效日」维护 USD→CNY 汇率。
 *
 * 口径（已拍板）：
 *   - **汇率按签证公司不同**（财务口径）：各签证公司结算链路不同（有的美金直折，有的经第三方货币
 *     链式折算），同一天不同公司汇率不一样，所以每家公司各维护自己的一串生效日。
 *   - 只填生效日，不填结束日：区间由**同公司下一条的生效日**隐含，因此无空洞、无重叠。
 *     例：某公司加「2026-08-05 起 7.16」→ 该公司 08-05 起一直用 7.16，直到出现更晚的一条。
 *   - 取数 = 先取该公司「生效日 ≤ 目标日期的最新一条」；该公司一条可用记录都没有时回落**通用行**
 *     （supplier 为空）；通用行也没有 → null。公司名 trim 后精确匹配。
 *     调用方拿到的 DTO 带 supplier：为 null 即表示这次是回落到通用行（前端据此给提示）。
 *   - 折算结果**当场固化**在业务单据上（签证任务的 visaFxRate / visaUnitCostCny）。
 *     之后改这张表**绝不追溯**已折算的旧单据——历史入账金额永远不因改汇率而变。
 *   - date-only 语义：生效日按 UTC 零点存/查（ymdToUtcDate），避免服务器本地时区挪日。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计（镜像成本周期 / 结算价日历风格）。
 */
import { FulfillmentType, type PrismaClient, type Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import { isAmountOnlySupplier } from '../fulfillment/visa-note-cost.js';

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

/**
 * 签证公司名归一化：trim；空串 / 纯空白 / undefined 一律视为「通用行」（null）。
 * 与任务 visaSupplier 的落库口径一致（fulfillment.service 同样 trim + 空串→null）。
 */
export function normalizeFxSupplier(supplier: string | null | undefined): string | null {
  const trimmed = supplier?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export interface UsdFxRateDto {
  id: string;
  /** 签证公司；null = 通用/缺省行（只在该公司没有汇率时兜底） */
  supplier: string | null;
  /** 生效日（YYYY-MM-DD）；该日起启用此汇率，直到同公司出现更晚的一条 */
  effectiveFrom: string;
  /** USD→CNY 汇率 */
  rate: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

function serialize(row: {
  id: string;
  supplier: string | null;
  effectiveFrom: Date;
  rate: Prisma.Decimal | number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}): UsdFxRateDto {
  return {
    id: row.id,
    supplier: row.supplier,
    effectiveFrom: utcDateToYmd(row.effectiveFrom),
    rate: typeof row.rate === 'number' ? row.rate : Number(row.rate.toString()),
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 全量列表（条数天然很少）：先按签证公司（通用行排最后，它只是兜底），同公司内按生效日倒序 ——
 * 最近生效的排最前，财务一眼看到"每家现在用哪个"。
 */
export async function listUsdFxRates(client: PrismaClient = defaultPrisma): Promise<UsdFxRateDto[]> {
  const rows = await client.usdFxRate.findMany({
    orderBy: [{ supplier: { sort: 'asc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
  });
  return rows.map(serialize);
}

/**
 * 取某公司某日生效的汇率：
 *   1) supplier 非空 → 该公司「生效日 ≤ date 的最新一条」；
 *   2) 没有（或 supplier 为空）→ 通用行（supplier null）「生效日 ≤ date 的最新一条」；
 *   3) 都没有 → null（调用方据此让用户手填，不臆造汇率）。
 * 返回 DTO 的 supplier 字段告诉调用方命中的是公司行还是通用行。
 *
 * @param date 目标日期 YMD（如签证任务的入账日 / 当天）
 * @param supplier 签证公司名（trim 后精确匹配）；空 = 只看通用行
 */
export async function getUsdFxRate(
  date: string,
  supplier: string | null | undefined,
  client: PrismaClient = defaultPrisma,
): Promise<UsdFxRateDto | null> {
  const lte = ymdToUtcDate(date);
  const name = normalizeFxSupplier(supplier);
  if (name != null) {
    const own = await client.usdFxRate.findFirst({
      where: { supplier: name, effectiveFrom: { lte } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (own) return serialize(own);
  }
  const generic = await client.usdFxRate.findFirst({
    where: { supplier: null, effectiveFrom: { lte } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return generic ? serialize(generic) : null;
}

export interface UpsertUsdFxRateInput {
  /** 签证公司；空 / 空白 = 通用行 */
  supplier?: string | null;
  effectiveFrom: string; // YMD
  rate: number; // > 0
  note?: string | null;
}

/**
 * 按「签证公司 × 生效日」幂等 upsert：同公司同一天重复提交只覆盖不新增。
 * 通用行（supplier null）不能走 Prisma 复合唯一键的 upsert（复合键不接受 null），
 * 且 Postgres 多个 NULL 不互撞唯一约束——所以这里统一先查后写，通用行的「同日只一条」由此保证。
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
  const supplier = normalizeFxSupplier(input.supplier);
  if (supplier != null && isAmountOnlySupplier(supplier)) {
    throw new BadRequestError('签证公司请填公司名称，不是金额');
  }
  const note = normalizeFxSupplier(input.note);
  const existing = await client.usdFxRate.findFirst({
    where: { supplier, effectiveFrom },
    select: { id: true },
  });
  const row = existing
    ? await client.usdFxRate.update({
        where: { id: existing.id },
        data: { rate: input.rate, note, updatedBy },
      })
    : await client.usdFxRate.create({
        data: { supplier, effectiveFrom, rate: input.rate, note, updatedBy },
      });
  return serialize(row);
}

/**
 * 汇率表「签证公司」输入的候选名单 = 签证产品主数据 Visa.supplier ∪ 签证任务 visaSupplier，
 * 去重 + trim；填成金额的脏值（「31.5美金」）不当公司名。财务维护汇率时从这里选，
 * 名字与任务上的公司名同一套，签证台才对得上（精确匹配）。
 */
export async function listFxSupplierOptions(client: PrismaClient = defaultPrisma): Promise<string[]> {
  const [products, tasks] = await Promise.all([
    client.visa.findMany({
      where: { supplier: { not: null } },
      select: { supplier: true },
      distinct: ['supplier'],
    }),
    client.fulfillmentTask.findMany({
      where: { type: FulfillmentType.VISA_APPLICATION, visaSupplier: { not: null } },
      select: { visaSupplier: true },
      distinct: ['visaSupplier'],
    }),
  ]);
  const names = new Set<string>();
  for (const s of [...products.map((p) => p.supplier), ...tasks.map((t) => t.visaSupplier)]) {
    const name = normalizeFxSupplier(s);
    if (name != null && !isAmountOnlySupplier(name)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}
