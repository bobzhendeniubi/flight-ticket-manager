/**
 * 签证任务成本回填 / 汇率重算两个一次性脚本共用的取数与写库约定（不含业务判定）。
 *
 *   - 「汇率按签证公司不同」是财务口径：脚本取汇率一律**只认该公司自己的汇率行**
 *     （UsdFxRate.supplier = 公司名，trim 后精确匹配），**不回落通用行**——通用行是签证台手工设金额时
 *     的兜底，拿来批量改钱会把一家公司的汇率套到另一家头上。公司没有专属汇率 → 交清单，不动。
 *   - 公司名口径 = 任务 visaSupplier 优先（填成金额的脏值不算公司），空则该任务关联签证产品的 Visa.supplier。
 *   - `--seed-rates` 在 --apply 时先按公司把汇率行插进 UsdFxRate（同公司同生效日已有则跳过）；
 *     dry-run 时不写库，但取数会把种子当成「已经存在」来预演，报告与真跑一致。
 *   - 「美金 × 汇率 → 人民币」仍由线上 resolveVisaUnitCost 折算，这里不做乘法。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../src/db/prisma.js';
import { writeAudit } from '../../src/lib/audit.js';
import {
  getUsdFxRate,
  normalizeFxSupplier,
  utcDateToYmd,
  ymdToUtcDate,
  type UsdFxRateDto,
} from '../../src/modules/finances/finances.fx.service.js';
import { isAmountOnlySupplier } from '../../src/modules/fulfillment/visa-note-cost.js';

/** 每条任务一个事务（留档行 + update 原子）。 */
export const TX_TIMEOUT_MS = 20_000;
export const TX_MAX_WAIT_MS = 10_000;

/** 即发即忘的审计需要一点时间落库，收尾等一等（best-effort，与其它一次性脚本一致）。 */
export const AUDIT_FLUSH_WAIT_MS = 3_000;

/** 打印跳过样例的条数上限。 */
export const SKIP_SAMPLE_LIMIT = 20;

/** 汇率比对容差（Decimal(12,6) 口径，百万分之一以内视为同一汇率）。 */
export const RATE_EPSILON = 0.0000005;

/** Prisma.Decimal | null → number | null（与 fulfillment.service 的 decOrNull 同口径）。 */
export function decOrNull(v: Prisma.Decimal | null): number | null {
  return v == null ? null : Number(v.toString());
}

/** 空字符串 / 纯空白一律当「没填」。 */
export function blankToNull(s: string | null | undefined): string | null {
  return normalizeFxSupplier(s);
}

export function csvCell(v: string | number | null): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

/** 两个可空数值是否相同（都空也算相同）。 */
export function sameNumber(a: number | null, b: number | null, epsilon: number): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= epsilon;
}

// ── 种子汇率（--seed-rates / --seed-from）──────────────────────────────────────

export interface SeedRate {
  supplier: string;
  rate: number;
}

/** `--seed-rates='甲公司=7.2,乙公司=7.0856'` → [{ supplier, rate }]；公司名 trim，重复 / 非正数拒绝。 */
export function parseSeedRates(arg: string): SeedRate[] {
  const seeds: SeedRate[] = [];
  const seen = new Set<string>();
  for (const part of arg.split(',')) {
    if (part.trim() === '') continue;
    const m = /^\s*([^=]+?)\s*=\s*(\d+(?:\.\d+)?)\s*$/u.exec(part);
    if (!m) throw new Error(`--seed-rates 格式应为 公司=汇率[,公司=汇率]：${part}`);
    const supplier = normalizeFxSupplier(m[1]);
    const rate = Number(m[2]);
    if (supplier == null || isAmountOnlySupplier(supplier)) {
      throw new Error(`--seed-rates 公司名不合法：${part}`);
    }
    if (!(rate > 0)) throw new Error(`--seed-rates 汇率需大于 0：${part}`);
    if (seen.has(supplier)) throw new Error(`--seed-rates 公司重复：${supplier}`);
    seen.add(supplier);
    seeds.push({ supplier, rate });
  }
  if (seeds.length === 0) throw new Error('--seed-rates 为空');
  return seeds;
}

export function parseYmd(arg: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(arg)) throw new Error(`${flag} 需为 YYYY-MM-DD：${arg}`);
  ymdToUtcDate(arg); // 非法日期在这里抛
  return arg;
}

export interface SeedResult {
  inserted: SeedRate[];
  skipped: SeedRate[];
}

/**
 * 按公司插种子汇率行（生效日 = seedFrom）。同公司同生效日已有 → 跳过（不覆盖财务手工维护的值）。
 * dry-run 只判定会插哪些、不写库。--apply 每插一条写一条审计（SEED_USD_FX_RATE）。
 */
export async function seedSupplierRates(
  seeds: readonly SeedRate[],
  seedFrom: string,
  apply: boolean,
  logPrefix: string,
): Promise<SeedResult> {
  const effectiveFrom = ymdToUtcDate(seedFrom);
  const inserted: SeedRate[] = [];
  const skipped: SeedRate[] = [];
  for (const seed of seeds) {
    const existing = await prisma.usdFxRate.findFirst({
      where: { supplier: seed.supplier, effectiveFrom },
      select: { id: true, rate: true },
    });
    if (existing) {
      skipped.push(seed);
      // eslint-disable-next-line no-console
      console.log(
        `${logPrefix} 种子汇率 ${seed.supplier} ${seedFrom} 起已存在（${existing.rate.toString()}），跳过`,
      );
      continue;
    }
    inserted.push(seed);
    if (!apply) {
      // eslint-disable-next-line no-console
      console.log(`${logPrefix} [dry-run] 将插入种子汇率 ${seed.supplier} ${seedFrom} 起 ${seed.rate}`);
      continue;
    }
    const row = await prisma.usdFxRate.create({
      data: {
        supplier: seed.supplier,
        effectiveFrom,
        rate: seed.rate,
        note: '脚本按财务口径按公司初始化',
        updatedBy: null,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`${logPrefix} 已插入种子汇率 ${seed.supplier} ${seedFrom} 起 ${seed.rate}`);
    void writeAudit({
      actor: { label: logPrefix, role: 'SYSTEM' },
      action: 'SEED_USD_FX_RATE',
      targetType: 'SYSTEM',
      targetId: row.id,
      targetLabel: `美金汇率 ${seed.supplier} ${seedFrom} 起 ${seed.rate}`,
      after: { supplier: seed.supplier, effectiveFrom: seedFrom, rate: seed.rate },
    });
  }
  return { inserted, skipped };
}

// ── 任务的汇率取数公司 ───────────────────────────────────────────────────────────

export interface TaskSupplierInput {
  visaSupplier: string | null;
  orderItem: { visa: { supplier: string | null } | null };
}

export interface TaskSupplier {
  /** 用来取汇率的公司名；null = 任务与产品都没有可用公司名 */
  supplier: string | null;
  /** TASK = 任务自己填的；PRODUCT = 回退产品默认供应商；NONE = 两处都没有 */
  source: 'TASK' | 'PRODUCT' | 'NONE';
  /** 任务 visaSupplier 是「31.5美金」这类填错格的金额 → 需要把公司名修成产品供应商 */
  supplierIsAmount: boolean;
}

/** 任务 visaSupplier 优先（金额型脏值不算），空则产品 Visa.supplier。 */
export function fxSupplierForTask(t: TaskSupplierInput): TaskSupplier {
  const own = blankToNull(t.visaSupplier);
  const supplierIsAmount = isAmountOnlySupplier(own);
  if (own != null && !supplierIsAmount) return { supplier: own, source: 'TASK', supplierIsAmount };
  const product = blankToNull(t.orderItem.visa?.supplier ?? null);
  if (product != null) return { supplier: product, source: 'PRODUCT', supplierIsAmount };
  return { supplier: null, source: 'NONE', supplierIsAmount };
}

// ── 按公司取汇率（只认公司行 + 种子预演 + 缓存）────────────────────────────────

export type FxResolution =
  /** 命中该公司自己的汇率行（或 dry-run 里预演的种子行） */
  | { kind: 'SUPPLIER'; supplier: string; rate: number; effectiveFrom: string; source: 'FX_TABLE' | 'SEED' }
  /** 该公司没有专属汇率，线上签证台会回落到这条通用行 —— 脚本不动，只报 */
  | { kind: 'GENERIC_ONLY'; supplier: string | null; generic: UsdFxRateDto }
  /** 公司行、通用行都没有 → 缺汇率 */
  | { kind: 'NONE'; supplier: string | null };

/**
 * 按（公司 × 业务日）取汇率，按键缓存（几百条任务集中在少数几天 / 两三家公司）。
 * 种子预演：dry-run 时种子行还没进库，这里把它当成「生效日 = seedFrom 的公司行」参与比较，
 * 与库里同公司的行按生效日取最新（同日库里的赢——--apply 时种子对已有行是跳过的）。
 */
export class SupplierFxResolver {
  private readonly cache = new Map<string, FxResolution>();
  private readonly seedBySupplier = new Map<string, number>();

  constructor(seeds: readonly SeedRate[], private readonly seedFrom: string | null) {
    for (const s of seeds) this.seedBySupplier.set(s.supplier, s.rate);
  }

  async resolve(businessDate: string, supplier: string | null): Promise<FxResolution> {
    const key = `${supplier ?? ''}|${businessDate}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const resolved = await this.lookup(businessDate, supplier);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async lookup(businessDate: string, supplier: string | null): Promise<FxResolution> {
    const row = await getUsdFxRate(businessDate, supplier, prisma);
    const dbOwn = row && row.supplier != null ? row : null;
    const seedRate = supplier != null ? this.seedBySupplier.get(supplier) : undefined;
    const seedApplies =
      supplier != null && seedRate != null && this.seedFrom != null && this.seedFrom <= businessDate;

    if (seedApplies && (dbOwn == null || dbOwn.effectiveFrom < this.seedFrom!)) {
      return {
        kind: 'SUPPLIER',
        supplier,
        rate: seedRate,
        effectiveFrom: this.seedFrom!,
        source: 'SEED',
      };
    }
    if (dbOwn) {
      return {
        kind: 'SUPPLIER',
        supplier: dbOwn.supplier as string,
        rate: dbOwn.rate,
        effectiveFrom: dbOwn.effectiveFrom,
        source: 'FX_TABLE',
      };
    }
    if (row) return { kind: 'GENERIC_ONLY', supplier, generic: row };
    return { kind: 'NONE', supplier };
  }
}

// ── 通用行报告（财务确认用途 / 要不要删）────────────────────────────────────────

export interface GenericRowTally {
  row: UsdFxRateDto;
  /** 仍会回落到这条通用行的任务数（公司为空 / 未知公司） */
  fallbackTasks: number;
  noSupplierTasks: number;
  unknownSuppliers: Map<string, number>;
}

/** 汇总「哪些任务仍会回落到通用行」，按通用行分组；供两个脚本共用同一段报告。 */
export class GenericFallbackTally {
  private readonly byRowId = new Map<string, GenericRowTally>();

  add(res: Extract<FxResolution, { kind: 'GENERIC_ONLY' }>): void {
    const entry = this.byRowId.get(res.generic.id) ?? {
      row: res.generic,
      fallbackTasks: 0,
      noSupplierTasks: 0,
      unknownSuppliers: new Map<string, number>(),
    };
    entry.fallbackTasks++;
    if (res.supplier == null) entry.noSupplierTasks++;
    else entry.unknownSuppliers.set(res.supplier, (entry.unknownSuppliers.get(res.supplier) ?? 0) + 1);
    this.byRowId.set(res.generic.id, entry);
  }

  /** 库里全部通用行（含没人回落的），与命中次数合并；财务据此判断每条通用行的用途。 */
  async report(logPrefix: string): Promise<void> {
    const rows = await prisma.usdFxRate.findMany({
      where: { supplier: null },
      orderBy: { effectiveFrom: 'desc' },
    });
    /* eslint-disable no-console */
    console.log('');
    console.log(`${logPrefix} ── 通用汇率行（supplier 为空）核对 ──`);
    if (rows.length === 0) {
      console.log('  库里没有通用行。');
      return;
    }
    for (const r of rows) {
      const tally = this.byRowId.get(r.id);
      const unknown = tally
        ? [...tally.unknownSuppliers.entries()].map(([name, n]) => `${name}×${n}`).join('、')
        : '';
      console.log(
        `  ${utcDateToYmd(r.effectiveFrom)} 起 ${r.rate.toString()}` +
          (r.note ? `（${r.note}）` : '') +
          ` | 仍会回落到它的任务 ${tally?.fallbackTasks ?? 0} 条` +
          (tally
            ? `（公司为空 ${tally.noSupplierTasks} 条；无专属汇率的公司：${unknown || '无'}）`
            : ''),
      );
    }
    console.log(
      '  ⚠️ 通用行只在签证台手工设金额且该公司没有专属汇率时兜底；本脚本从不用它改钱。' +
        '请财务确认这条通用行是什么用途、要不要删（删了之后上面这些任务在签证台就得手填汇率）。',
    );
    /* eslint-enable no-console */
  }
}
