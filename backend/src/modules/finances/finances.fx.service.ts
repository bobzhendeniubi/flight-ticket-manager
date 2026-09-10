/**
 * 汇率表 service —— 财务按「汇率名称 × 币种 × 生效日」维护一张命名清单。
 *
 * 口径（已拍板）：
 *   - **汇率跟供应商合同走，不按业务类别**：各供应商结算链路不同，同一天不同供应商汇率不一样，
 *     所以一个供应商一条汇率名称，各自维护自己的一串生效日。名称如「某签证公司」「酒店越南盾」「车队越南盾」。
 *   - **两种币种、两种记法（按财务习惯）**：
 *       USD 行：rate = 1 美金折多少人民币（如 7.2）        → CNY = 美金 × rate
 *       VND 行：rate = 多少越南盾折 1 人民币（如 3740）      → CNY = 越南盾 ÷ rate
 *     两种记法在 toCny() 一处统一，调用方不自己乘除。
 *   - 只填生效日，不填结束日：区间由**同名称同币种下一条的生效日**隐含，因此无空洞、无重叠。
 *   - 取数 = 先取该名称「生效日 ≤ 目标日期的最新一条」；该名称一条可用记录都没有时回落**同币种通用行**
 *     （name 为空）；通用行也没有 → null。名称 trim 后精确匹配。
 *     调用方拿到的 DTO 带 name：为 null 即表示这次是回落到通用行（前端据此给提示）。
 *   - 折算结果**当场固化**在业务单据上（签证任务的 visaFxRate / visaUnitCostCny；酒店行的 unitCostCny + metadata.costSource）。
 *     之后改这张表**绝不追溯**已折算的旧单据——历史入账金额永远不因改汇率而变。
 *   - date-only 语义：生效日按 UTC 零点存/查（ymdToUtcDate），避免服务器本地时区挪日。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计（镜像成本周期 / 结算价日历风格）。
 */
import { FulfillmentType, type PrismaClient, type Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import { isAmountOnlySupplier } from '../fulfillment/visa-note-cost.js';

/** 汇率表支持的币种（zod 与服务层共用同一份）。 */
export const FX_CURRENCIES = ['USD', 'VND'] as const;
export type FxCurrency = (typeof FX_CURRENCIES)[number];

/** 汇率名称建议项（非签证类，跟地接合同走）；财务可自由输入别的名称。 */
export const FX_NAME_SUGGESTIONS: Readonly<Record<FxCurrency, readonly string[]>> = {
  USD: [],
  VND: ['酒店越南盾', '车队越南盾'],
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 原币金额 → 人民币（两位小数），两种记法在此统一：
 *   USD：amount × rate（1 美金 = rate 人民币）
 *   VND：amount ÷ rate（rate 越南盾 = 1 人民币）；rate ≤ 0 无法折算 → null
 * 金额非有限数 → null。纯函数，签证折算与酒店逐晚折算都走它。
 */
export function toCny(amount: number, currency: FxCurrency, rate: number): number | null {
  if (!Number.isFinite(amount) || !Number.isFinite(rate)) return null;
  if (currency === 'USD') return round2(amount * rate);
  if (!(rate > 0)) return null;
  return round2(amount / rate);
}

/** 是否合法币种（运行时收窄，供 DB 读回的 String 列用）。 */
export function isFxCurrency(v: unknown): v is FxCurrency {
  return typeof v === 'string' && (FX_CURRENCIES as readonly string[]).includes(v);
}

function assertFxCurrency(v: unknown): FxCurrency {
  if (!isFxCurrency(v)) throw new BadRequestError(`币种只支持 ${FX_CURRENCIES.join(' / ')}`);
  return v;
}

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
 * 汇率名称归一化：trim；空串 / 纯空白 / undefined 一律视为「通用行」（null）。
 * 与任务 visaSupplier 的落库口径一致（fulfillment.service 同样 trim + 空串→null）。
 */
export function normalizeFxName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** @deprecated 旧名，等价 normalizeFxName（签证脚本仍在用）。 */
export const normalizeFxSupplier = normalizeFxName;

export interface FxRateDto {
  id: string;
  /** 汇率名称（签证公司名 / 「酒店越南盾」…）；null = 该币种通用/缺省行（只在该名称没有汇率时兜底） */
  name: string | null;
  currency: FxCurrency;
  /** 生效日（YYYY-MM-DD）；该日起启用此汇率，直到同名称同币种出现更晚的一条 */
  effectiveFrom: string;
  /** 汇率：USD 行 = 1 美金折多少人民币；VND 行 = 多少越南盾折 1 人民币 */
  rate: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

/** @deprecated 旧名，等价 FxRateDto（签证脚本仍在用）。 */
export type UsdFxRateDto = FxRateDto;

/** DB 行（select 至少含这些列）。 */
export interface FxRateRow {
  id: string;
  name: string | null;
  currency: string;
  effectiveFrom: Date;
  rate: Prisma.Decimal | number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

function serialize(row: FxRateRow): FxRateDto {
  return {
    id: row.id,
    name: row.name,
    currency: assertFxCurrency(row.currency),
    effectiveFrom: utcDateToYmd(row.effectiveFrom),
    rate: typeof row.rate === 'number' ? row.rate : Number(row.rate.toString()),
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 全量列表（条数天然很少）：先按币种、再按汇率名称（通用行排最后，它只是兜底），同名称内按生效日倒序 ——
 * 最近生效的排最前，财务一眼看到"每家现在用哪个"。
 */
export async function listFxRates(client: PrismaClient = defaultPrisma): Promise<FxRateDto[]> {
  const rows = await client.fxRate.findMany({
    orderBy: [{ currency: 'asc' }, { name: { sort: 'asc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
  });
  return rows.map(serialize);
}

export interface GetFxRateInput {
  /** 目标日期 YMD（如签证任务的入账日 / 酒店当晚） */
  date: string;
  currency: FxCurrency;
  /** 汇率名称（trim 后精确匹配）；空 = 只看该币种通用行 */
  name?: string | null;
}

/**
 * 取某名称某日生效的汇率：
 *   1) name 非空 → 该名称 + 币种「生效日 ≤ date 的最新一条」；
 *   2) 没有（或 name 为空）→ 同币种通用行（name null）「生效日 ≤ date 的最新一条」；
 *   3) 都没有 → null（调用方据此让用户手填，不臆造汇率）。
 * 返回 DTO 的 name 字段告诉调用方命中的是名称行还是通用行。
 */
export async function getFxRate(
  input: GetFxRateInput,
  client: PrismaClient = defaultPrisma,
): Promise<FxRateDto | null> {
  const lte = ymdToUtcDate(input.date);
  const name = normalizeFxName(input.name);
  const currency = assertFxCurrency(input.currency);
  if (name != null) {
    const own = await client.fxRate.findFirst({
      where: { name, currency, effectiveFrom: { lte } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (own) return serialize(own);
  }
  const generic = await client.fxRate.findFirst({
    where: { name: null, currency, effectiveFrom: { lte } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return generic ? serialize(generic) : null;
}

/**
 * USD 包装（签证链路 / 脚本沿用旧签名）：等价 getFxRate({ date, currency: 'USD', name: supplier })。
 * @param supplier 签证公司名（trim 后精确匹配）；空 = 只看 USD 通用行
 */
export async function getUsdFxRate(
  date: string,
  supplier: string | null | undefined,
  client: PrismaClient = defaultPrisma,
): Promise<FxRateDto | null> {
  return getFxRate({ date, currency: 'USD', name: supplier }, client);
}

/**
 * 某币种在目标日「每个名称各取生效中的一条」（含通用行），供前端下拉「选用哪条汇率」：
 * 按名称分组后各取 ≤date 最新一条；通用行排最后。名称有行但都晚于目标日 → 不列（当日不生效）。
 */
export async function listEffectiveFxRates(
  input: { date: string; currency: FxCurrency },
  client: PrismaClient = defaultPrisma,
): Promise<FxRateDto[]> {
  const lte = ymdToUtcDate(input.date);
  const currency = assertFxCurrency(input.currency);
  const rows = await client.fxRate.findMany({
    where: { currency, effectiveFrom: { lte } },
    orderBy: [{ name: { sort: 'asc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
  });
  const seen = new Set<string>();
  const out: FxRateDto[] = [];
  for (const r of rows) {
    const key = r.name ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(serialize(r));
  }
  return out;
}

// ── 内存版取数（酒店逐晚折算：一次 load 进 Map，别按晚查库）──────────────────

/** Map<name（通用行 = ''）, 该名称按生效日倒序的行> */
export type FxRateMap = Map<string, FxRateDto[]>;

/** 把一批 DTO 按名称分组（通用行 key = ''），组内生效日倒序。纯函数，单测与 loadFxRatesByCurrency 共用。 */
export function groupFxRatesByName(rates: ReadonlyArray<FxRateDto>): FxRateMap {
  const map: FxRateMap = new Map();
  for (const r of rates) {
    const key = r.name ?? '';
    const list = map.get(key) ?? [];
    map.set(key, [...list, r]);
  }
  for (const [key, list] of map) {
    map.set(
      key,
      [...list].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0)),
    );
  }
  return map;
}

/** 一次拉某币种全部汇率行（VND 行总量很小）并按名称分组。 */
export async function loadFxRatesByCurrency(
  currency: FxCurrency,
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<FxRateMap> {
  const rows = await client.fxRate.findMany({
    where: { currency: assertFxCurrency(currency) },
    orderBy: [{ name: { sort: 'asc', nulls: 'last' } }, { effectiveFrom: 'desc' }],
  });
  return groupFxRatesByName(rows.map(serialize));
}

/**
 * 内存版 getFxRate：先名称行 ≤date 最新一条，没有回落通用行（''），都没有 → null。
 * 与 getFxRate 同口径（名称 trim 精确匹配；生效日 ≤ 目标日）。
 */
export function resolveFxRateInMap(map: FxRateMap, date: string, name: string | null | undefined): FxRateDto | null {
  const ymd = date.slice(0, 10);
  const pick = (key: string): FxRateDto | null => {
    const list = map.get(key);
    if (!list) return null;
    for (const r of list) if (r.effectiveFrom <= ymd) return r;
    return null;
  };
  const own = normalizeFxName(name);
  return (own != null ? pick(own) : null) ?? pick('');
}

// ── 写 ───────────────────────────────────────────────────────────────────────

export interface UpsertFxRateInput {
  /** 汇率名称；空 / 空白 = 该币种通用行 */
  name?: string | null;
  currency: FxCurrency;
  effectiveFrom: string; // YMD
  rate: number; // > 0
  note?: string | null;
}

/**
 * 按「名称 × 币种 × 生效日」幂等 upsert：同键重复提交只覆盖不新增。
 * 通用行（name null）不能走 Prisma 复合唯一键的 upsert（复合键不接受 null），
 * 且 Postgres 多个 NULL 不互撞唯一约束——所以这里统一先查后写，通用行的「同日只一条」由此保证。
 * updatedBy 记最近更新人（展示"谁改的"）。
 */
export async function upsertFxRate(
  input: UpsertFxRateInput,
  updatedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<FxRateDto> {
  if (!(input.rate > 0)) {
    throw new BadRequestError('汇率需大于 0');
  }
  const currency = assertFxCurrency(input.currency);
  const effectiveFrom = ymdToUtcDate(input.effectiveFrom);
  const name = normalizeFxName(input.name);
  if (name != null && isAmountOnlySupplier(name)) {
    throw new BadRequestError('汇率名称请填供应商名称，不是金额');
  }
  const note = normalizeFxName(input.note);
  const existing = await client.fxRate.findFirst({
    where: { name, currency, effectiveFrom },
    select: { id: true },
  });
  const row = existing
    ? await client.fxRate.update({
        where: { id: existing.id },
        data: { rate: input.rate, note, updatedBy },
      })
    : await client.fxRate.create({
        data: { name, currency, effectiveFrom, rate: input.rate, note, updatedBy },
      });
  return serialize(row);
}

/**
 * USD 包装（旧签名）：supplier 即汇率名称。
 * @deprecated 新代码走 upsertFxRate。
 */
export async function upsertUsdFxRate(
  input: { supplier?: string | null; effectiveFrom: string; rate: number; note?: string | null },
  updatedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<FxRateDto> {
  return upsertFxRate(
    { name: input.supplier, currency: 'USD', effectiveFrom: input.effectiveFrom, rate: input.rate, note: input.note },
    updatedBy,
    client,
  );
}

// ── 名称候选 ──────────────────────────────────────────────────────────────────

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
    const name = normalizeFxName(s);
    if (name != null && !isAmountOnlySupplier(name)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 汇率名称候选（按币种）：USD = 签证供应商候选；VND = 「酒店越南盾」「车队越南盾」建议项。
 * 两边都并上汇率表里已有的同币种名称（财务自由输入过的名字下次还能选到）。
 */
export async function listFxNameOptions(
  client: PrismaClient = defaultPrisma,
): Promise<Record<FxCurrency, string[]>> {
  const [suppliers, existing] = await Promise.all([
    listFxSupplierOptions(client),
    client.fxRate.findMany({
      where: { name: { not: null } },
      select: { name: true, currency: true },
      distinct: ['name', 'currency'],
    }),
  ]);
  const byCurrency: Record<FxCurrency, Set<string>> = {
    USD: new Set([...FX_NAME_SUGGESTIONS.USD, ...suppliers]),
    VND: new Set(FX_NAME_SUGGESTIONS.VND),
  };
  for (const r of existing) {
    if (!isFxCurrency(r.currency) || r.name == null) continue;
    byCurrency[r.currency].add(r.name);
  }
  return {
    USD: [...byCurrency.USD].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    VND: [...byCurrency.VND].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
  };
}
