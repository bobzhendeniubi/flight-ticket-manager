/**
 * 签证任务结构化成本「按签证公司汇率重算」一次性脚本。
 *
 * 背景：签证任务的人民币成本 visaUnitCostCny = visaUnitCostUsd × visaFxRate，汇率默认由汇率表带出。
 * 汇率表此前只有**一条全局行**，8/31 之后签证台带的都是它；而财务口径是**汇率按签证公司不同**
 * （各公司结算链路不同，同一天汇率不一样，变动由对方通知）。于是存量里一批已填美金成本的任务
 * 按错公司的汇率折了人民币，与账单对不上。本脚本按公司把汇率与人民币成本重算回来。
 *
 * 口径：
 *   - 公司 = 任务 visaSupplier 优先（填成金额的脏值不算），空则关联签证产品的 Visa.supplier。
 *   - 汇率 = 该公司在**任务建单业务日（北京时间）**的生效汇率，**只认公司自己的汇率行**，不回落通用行
 *     （通用行只是签证台手填时的兜底；拿它批量改钱等于把一家的汇率套到另一家头上）。
 *     公司没有专属汇率 → 进「回落通用 / 缺汇率」清单，不动。
 *   - 汇率与现值不同 → 改 visaFxRate 与 visaUnitCostCny（人民币由线上 resolveVisaUnitCost 折算，
 *     脚本不自己写乘法）；美金单价永远不动。
 *   - visaSupplier 是「31.5美金」这类填错格的金额 → 公司名改成产品供应商（既有回填脚本的目标 B 口径），
 *     再按该公司重算；关联不到产品的进「缺汇率」清单。
 *   - `--seed-rates` 按公司把财务口径的汇率行插进 FxRate（汇率名称 = 公司名、币种 USD，生效日 = --seed-from，同名同日已有则跳过）；
 *     dry-run 不插，但取数按「已插入」预演，报告与真跑一致。
 *
 * 幂等：改后汇率 = 公司汇率，重跑取到同一汇率 → 0 条待改。留档表 CREATE TABLE IF NOT EXISTS，重跑只追加。
 *
 * 默认 dry-run：只读库、只打印清单与 CSV。加 --apply 才写库，且 --apply 会：
 *   1) 先插种子汇率（若给了 --seed-rates），每条写审计 SEED_USD_FX_RATE；
 *   2) 建留档表 _bak_0909_visa_fx_recompute（任务 id + 改前四字段 + 改后三字段 + 取数公司 + 业务日）；
 *   3) 每条任务一个事务：写留档行 + update 任务（where 二次卡「美金与汇率仍是改前值」，期间被人改过就跳过）；
 *   4) 每条写一条 AuditLog（action = RECOMPUTE_VISA_TASK_FX，actor = 系统/脚本）。
 *
 * 用法（backend/ 目录下；公司名与汇率按财务口径填，示例值仅示意）：
 *   npx tsx scripts/recompute-visa-task-fx.ts                                              # dry-run（只按库里已有的公司汇率）
 *   npx tsx scripts/recompute-visa-task-fx.ts --seed-rates='甲公司=7.2,乙公司=7.0856' --seed-from=2026-01-01
 *                                                                                          # dry-run + 预演种子汇率
 *   npx tsx scripts/recompute-visa-task-fx.ts --seed-rates=... --seed-from=... --out=/tmp/签证汇率重算.csv
 *   npx tsx scripts/recompute-visa-task-fx.ts --seed-rates=... --seed-from=... --limit=1 --apply   # 试水一条
 *   npx tsx scripts/recompute-visa-task-fx.ts --seed-rates=... --seed-from=... --apply             # 真正写库
 *
 * 参数：
 *   --apply                 真正写库（不加 = dry-run，只读）
 *   --seed-rates=公司=汇率,…  按公司插种子汇率行（同公司同生效日已有则跳过）；须同时给 --seed-from
 *   --seed-from=YYYY-MM-DD  种子汇率的生效日
 *   --limit=N               只处理前 N 条候选任务（按创建时间升序），用于试水
 *   --out=路径               把逐条明细写成 CSV；**拒绝覆盖已存在的文件**。不传则 dry-run 时把 CSV 打到 stdout
 *
 * 连接串走 Prisma 默认的 DATABASE_URL（本地 = backend/.env）。线上怎么跑（scripts/ 不进镜像、要 docker cp
 * src + scripts 进容器再用镜像自带的 tsx 跑）见 backfill-visa-task-cost-from-notes.ts 头部说明，命令同形。
 *
 * 建议流程：先跑 backfill-visa-task-cost-from-notes.ts 把备注里的进价回填成结构化字段（它也按公司取汇率），
 *          再跑本脚本 dry-run + --out 交财务核对「公司 × 旧汇率 → 新汇率」的条数与人民币差额
 *          → --limit=1 --apply 试水 → --apply 全量 → 再 dry-run 复核（应为 0 条待改）。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { FulfillmentType, Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAudit } from '../src/lib/audit.js';
import { businessDateISO } from '../src/lib/business-time.js';
import { resolveVisaUnitCost } from '../src/modules/fulfillment/fulfillment.service.js';
import {
  AUDIT_FLUSH_WAIT_MS,
  GenericFallbackTally,
  RATE_EPSILON,
  SKIP_SAMPLE_LIMIT,
  SupplierFxResolver,
  TX_MAX_WAIT_MS,
  TX_TIMEOUT_MS,
  blankToNull,
  csvCell,
  decOrNull,
  fxSupplierForTask,
  parseSeedRates,
  parseYmd,
  sameNumber,
  seedSupplierRates,
  type SeedRate,
} from './lib/visa-fx-shared.js';

const LOG_PREFIX = '[recompute-visa-task-fx]';

/** 留档表名（一次性脚本约定：_bak_<日期>_<用途>，跑完留库供财务/后续追溯）。 */
const BACKUP_TABLE = '_bak_0909_visa_fx_recompute';

interface CliOptions {
  apply: boolean;
  seeds: SeedRate[];
  seedFrom: string | null;
  limit?: number;
  out?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { apply: false, seeds: [], seedFrom: null };
  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    const seeds = /^--seed-rates=(.+)$/u.exec(arg);
    if (seeds) {
      opts.seeds = parseSeedRates(seeds[1]);
      continue;
    }
    const seedFrom = /^--seed-from=(.+)$/u.exec(arg);
    if (seedFrom) {
      opts.seedFrom = parseYmd(seedFrom[1], '--seed-from');
      continue;
    }
    const limit = /^--limit=(\d+)$/u.exec(arg);
    if (limit) {
      opts.limit = Number(limit[1]);
      continue;
    }
    const out = /^--out=(.+)$/u.exec(arg);
    if (out) {
      opts.out = out[1];
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  if ((opts.seeds.length > 0) !== (opts.seedFrom != null)) {
    throw new Error('--seed-rates 与 --seed-from 需同时给');
  }
  return opts;
}

/** 一条待重算任务（dry-run 打印 / CSV / --apply 写库共用同一份数据）。 */
interface PlannedRow {
  taskId: string;
  orderId: string;
  orderNumber: string;
  businessDate: string;
  /** 取汇率用的公司名 + 来源 */
  supplier: string;
  supplierSource: 'TASK' | 'PRODUCT';
  usd: number;
  beforeRate: number | null;
  beforeCny: number | null;
  beforeSupplier: string | null;
  afterRate: number;
  afterCny: number;
  afterSupplier: string | null;
  rateSource: 'FX_TABLE' | 'SEED';
  rateEffectiveFrom: string;
}

/** 不动、只列清单的一条。 */
interface ReviewRow {
  taskId: string;
  orderNumber: string;
  reason: string;
  supplier: string | null;
  usd: number | null;
  beforeRate: number | null;
  beforeCny: number | null;
  beforeSupplier: string | null;
}

function buildCsv(planned: readonly PlannedRow[], review: readonly ReviewRow[]): string {
  const lines: string[] = [];
  lines.push(
    [
      '类别',
      '任务id',
      '订单号',
      '任务创建日(北京)',
      '取数公司（汇率名称）',
      '公司来源',
      '美金',
      '原汇率',
      '原人民币',
      '原签证公司',
      '新汇率',
      '新人民币',
      '新签证公司',
      '人民币差额',
      '汇率来源',
      '说明',
    ]
      .map(csvCell)
      .join(','),
  );
  for (const r of planned) {
    lines.push(
      [
        '待重算',
        r.taskId,
        r.orderNumber,
        r.businessDate,
        r.supplier,
        r.supplierSource === 'TASK' ? '任务签证公司' : '产品供应商',
        r.usd,
        r.beforeRate,
        r.beforeCny,
        r.beforeSupplier,
        r.afterRate,
        r.afterCny,
        r.afterSupplier,
        Math.round((r.afterCny - (r.beforeCny ?? 0)) * 100) / 100,
        r.rateSource === 'SEED' ? `种子汇率（${r.rateEffectiveFrom} 起）` : `汇率表（${r.rateEffectiveFrom} 起）`,
        r.afterSupplier !== r.beforeSupplier ? '公司名格填成了金额，改为产品供应商' : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  for (const r of review) {
    lines.push(
      [
        '不动/待核对',
        r.taskId,
        r.orderNumber,
        '',
        r.supplier,
        '',
        r.usd,
        r.beforeRate,
        r.beforeCny,
        r.beforeSupplier,
        '',
        '',
        '',
        '',
        '',
        r.reason,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

async function ensureBackupTable(): Promise<void> {
  // 表名是本文件里的常量字面量（非外部输入），故用 Unsafe 变体拼常量名；数据行走参数化写入。
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${BACKUP_TABLE}" (
      "taskId"         text NOT NULL,
      "orderId"        text,
      "orderNumber"    text,
      "businessDate"   text,
      "supplierUsed"   text,
      "usd"            numeric(10,2),
      "beforeRate"     numeric(12,6),
      "beforeCny"      numeric(10,2),
      "beforeSupplier" text,
      "afterRate"      numeric(12,6),
      "afterCny"       numeric(10,2),
      "afterSupplier"  text,
      "rateSource"     text,
      "recomputedAt"   timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function writeBackupRow(tx: Prisma.TransactionClient, row: PlannedRow): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "${BACKUP_TABLE}"
       ("taskId","orderId","orderNumber","businessDate","supplierUsed","usd",
        "beforeRate","beforeCny","beforeSupplier","afterRate","afterCny","afterSupplier","rateSource")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    row.taskId,
    row.orderId,
    row.orderNumber,
    row.businessDate,
    row.supplier,
    row.usd,
    row.beforeRate,
    row.beforeCny,
    row.beforeSupplier,
    row.afterRate,
    row.afterCny,
    row.afterSupplier,
    row.rateSource,
  );
}

async function applyRows(planned: readonly PlannedRow[]): Promise<{
  appliedCount: number;
  failures: Array<{ taskId: string; message: string }>;
}> {
  const failures: Array<{ taskId: string; message: string }> = [];
  let appliedCount = 0;
  await ensureBackupTable();
  for (const row of planned) {
    try {
      await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          await writeBackupRow(tx, row);
          // 二次卡「美金与汇率仍是改前值」：期间被签证岗改过就原样跳过，脚本不覆盖人工录入。
          const updated = await tx.fulfillmentTask.updateMany({
            where: { id: row.taskId, visaUnitCostUsd: row.usd, visaFxRate: row.beforeRate },
            data: {
              visaFxRate: row.afterRate,
              visaUnitCostCny: row.afterCny,
              ...(row.afterSupplier !== row.beforeSupplier ? { visaSupplier: row.afterSupplier } : {}),
            },
          });
          if (updated.count === 0) throw new Error('SKIP_CONCURRENT_EDIT');
        },
        { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'SKIP_CONCURRENT_EDIT') {
        // eslint-disable-next-line no-console
        console.log(`  ${row.orderNumber} / ${row.taskId} → 期间已被人工改过，跳过`);
        continue;
      }
      failures.push({ taskId: row.taskId, message });
      continue;
    }
    appliedCount++;
    void writeAudit({
      actor: { label: LOG_PREFIX, role: 'SYSTEM' },
      action: 'RECOMPUTE_VISA_TASK_FX',
      targetType: 'ORDER',
      targetId: row.orderId,
      targetLabel: `${row.orderNumber} / VISA_APPLICATION`,
      before: {
        visaUnitCostUsd: row.usd,
        visaFxRate: row.beforeRate,
        visaUnitCostCny: row.beforeCny,
        visaSupplier: row.beforeSupplier,
      },
      after: {
        visaUnitCostUsd: row.usd,
        visaFxRate: row.afterRate,
        visaUnitCostCny: row.afterCny,
        visaSupplier: row.afterSupplier,
        supplierUsed: row.supplier,
        supplierSource: row.supplierSource,
        businessDate: row.businessDate,
        rateSource: row.rateSource,
        rateEffectiveFrom: row.rateEffectiveFrom,
      },
    });
  }
  return { appliedCount, failures };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.out && existsSync(opts.out)) {
    throw new Error(`--out 指向的文件已存在，拒绝覆盖: ${opts.out}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 模式: ${opts.apply ? '--apply（会写库）' : 'dry-run（只读）'}` +
      (opts.seeds.length
        ? ` | 种子汇率 ${opts.seedFrom} 起：${opts.seeds.map((s) => `${s.supplier}=${s.rate}`).join('，')}`
        : ''),
  );

  if (opts.seeds.length > 0 && opts.seedFrom) {
    await seedSupplierRates(opts.seeds, opts.seedFrom, opts.apply, LOG_PREFIX);
  }

  const tasks = await prisma.fulfillmentTask.findMany({
    where: { type: FulfillmentType.VISA_APPLICATION, visaUnitCostUsd: { not: null } },
    select: {
      id: true,
      createdAt: true,
      visaUnitCostUsd: true,
      visaFxRate: true,
      visaUnitCostCny: true,
      visaSupplier: true,
      orderItem: {
        select: {
          visa: { select: { supplier: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`${LOG_PREFIX} 已填美金成本的签证任务 ${tasks.length} 条`);

  const fx = new SupplierFxResolver(opts.seeds, opts.seedFrom);
  const genericTally = new GenericFallbackTally();
  const planned: PlannedRow[] = [];
  const genericOnly: ReviewRow[] = [];
  const missingRate: ReviewRow[] = [];
  let unchanged = 0;

  for (const t of tasks) {
    const usd = decOrNull(t.visaUnitCostUsd);
    if (usd == null) continue; // where 已过滤，仅为类型收窄
    const beforeRate = decOrNull(t.visaFxRate);
    const beforeCny = decOrNull(t.visaUnitCostCny);
    const beforeSupplier = blankToNull(t.visaSupplier);
    const businessDate = businessDateISO(t.createdAt);
    const who = fxSupplierForTask(t);
    const base = {
      taskId: t.id,
      orderNumber: t.orderItem.order.orderNumber,
      supplier: who.supplier,
      usd,
      beforeRate,
      beforeCny,
      beforeSupplier,
    };

    const res = await fx.resolve(businessDate, who.supplier);
    if (res.kind === 'NONE') {
      missingRate.push({
        ...base,
        reason:
          who.source === 'NONE'
            ? who.supplierIsAmount
              ? '公司名格填成了金额且关联不到签证产品，无法确定公司'
              : '任务与产品都没有签证公司，无法确定公司'
            : `「${who.supplier}」在 ${businessDate} 无专属汇率（通用行也没有）`,
      });
      continue;
    }
    if (res.kind === 'GENERIC_ONLY') {
      genericTally.add(res);
      genericOnly.push({
        ...base,
        reason:
          who.source === 'NONE'
            ? `没有签证公司，线上只会回落到通用行 ${res.generic.rate}（${res.generic.effectiveFrom} 起）；不按通用行改钱`
            : `「${who.supplier}」无专属汇率，线上只会回落到通用行 ${res.generic.rate}（${res.generic.effectiveFrom} 起）；不按通用行改钱`,
      });
      continue;
    }

    // 公司名格填成了金额 → 改成产品供应商（此时 who.source 必为 PRODUCT）
    const afterSupplier = who.supplierIsAmount ? who.supplier : beforeSupplier;
    const rateSame = sameNumber(beforeRate, res.rate, RATE_EPSILON);
    if (rateSame && afterSupplier === beforeSupplier) {
      unchanged++;
      continue;
    }
    const resolved = resolveVisaUnitCost({ visaUnitCostUsd: usd, visaFxRate: res.rate });
    if (resolved.cny == null) {
      missingRate.push({ ...base, reason: `折算失败（美金 ${usd} × 汇率 ${res.rate}）` });
      continue;
    }
    planned.push({
      taskId: t.id,
      orderId: t.orderItem.order.id,
      orderNumber: t.orderItem.order.orderNumber,
      businessDate,
      supplier: res.supplier,
      supplierSource: who.source === 'TASK' ? 'TASK' : 'PRODUCT',
      usd,
      beforeRate,
      beforeCny,
      beforeSupplier,
      afterRate: res.rate,
      afterCny: resolved.cny,
      afterSupplier,
      rateSource: res.source,
      rateEffectiveFrom: res.effectiveFrom,
    });
  }

  // ── 写库（--apply）──
  let appliedCount = 0;
  let failures: Array<{ taskId: string; message: string }> = [];
  if (opts.apply && planned.length > 0) {
    ({ appliedCount, failures } = await applyRows(planned));
  }

  // ── 汇总：按公司 × 旧汇率 → 新汇率 的条数与人民币差额合计 ──
  interface Impact {
    count: number;
    cnyDelta: number;
  }
  const impact = new Map<string, Impact>();
  for (const r of planned) {
    const key = `${r.supplier} | ${r.beforeRate ?? '（空）'} → ${r.afterRate}`;
    const cur = impact.get(key) ?? { count: 0, cnyDelta: 0 };
    impact.set(key, {
      count: cur.count + 1,
      cnyDelta: cur.cnyDelta + (r.afterCny - (r.beforeCny ?? 0)),
    });
  }
  const totalDelta = planned.reduce((sum, r) => sum + (r.afterCny - (r.beforeCny ?? 0)), 0);
  const supplierFixCount = planned.filter((r) => r.afterSupplier !== r.beforeSupplier).length;

  /* eslint-disable no-console */
  console.log('');
  console.log(`${LOG_PREFIX} ── 汇总 ──`);
  console.log(
    `  待重算 ${planned.length} 条` +
      `（其中公司名格填成金额、顺带改为产品供应商 ${supplierFixCount} 条）` +
      (opts.apply ? ` | 实际写库 ${appliedCount} 条` : ''),
  );
  console.log(`  汇率已一致无需改 ${unchanged} 条`);
  console.log(`  公司无专属汇率、只会回落通用行（不动） ${genericOnly.length} 条`);
  console.log(`  缺汇率（不动） ${missingRate.length} 条`);

  console.log('');
  console.log('  按「公司 × 旧汇率 → 新汇率」的影响（人民币差额 = Σ 新人民币 − 旧人民币，正数 = 成本上调）：');
  if (impact.size === 0) console.log('    （无）');
  for (const [key, v] of [...impact.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${key} | ${v.count} 条 | 人民币差额 ${v.cnyDelta >= 0 ? '+' : ''}${v.cnyDelta.toFixed(2)}`);
  }
  console.log(`    合计 ${planned.length} 条 | 人民币差额 ${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(2)}`);

  if (genericOnly.length > 0) {
    console.log('');
    console.log(`  回落通用行清单（前 ${SKIP_SAMPLE_LIMIT} 条）：`);
    for (const r of genericOnly.slice(0, SKIP_SAMPLE_LIMIT)) {
      console.log(`    ${r.orderNumber} / ${r.taskId} | ${r.reason} | 现 $${r.usd} × ${r.beforeRate ?? '-'}`);
    }
  }
  if (missingRate.length > 0) {
    console.log('');
    console.log(`  缺汇率清单（前 ${SKIP_SAMPLE_LIMIT} 条）：`);
    for (const r of missingRate.slice(0, SKIP_SAMPLE_LIMIT)) {
      console.log(`    ${r.orderNumber} / ${r.taskId} | ${r.reason} | 现 $${r.usd} × ${r.beforeRate ?? '-'}`);
    }
  }

  await genericTally.report(LOG_PREFIX);

  const csv = buildCsv(planned, [...genericOnly, ...missingRate]);
  if (opts.out) {
    writeFileSync(opts.out, `﻿${csv}\n`, 'utf8');
    console.log('');
    console.log(`${LOG_PREFIX} 明细 CSV 已写入 ${opts.out}`);
  } else if (!opts.apply) {
    console.log('');
    console.log(`${LOG_PREFIX} ── 明细 CSV（可加 --out=路径 写成文件）──`);
    console.log(csv);
  }

  console.log('');
  console.log(
    `${LOG_PREFIX} 完成` +
      (opts.apply
        ? `（已写库 ${appliedCount} 条，改前值留档在 ${BACKUP_TABLE}）`
        : '（dry-run，未写库；加 --apply 真正执行）'),
  );
  if (failures.length > 0) {
    console.error(`${LOG_PREFIX} ${failures.length} 条任务写库失败（各自事务已回滚）:`);
    for (const f of failures) console.error(`  ${f.taskId}: ${f.message}`);
    process.exitCode = 1;
  }
  /* eslint-enable no-console */

  if (opts.apply && (appliedCount > 0 || opts.seeds.length > 0)) {
    await new Promise((resolve) => setTimeout(resolve, AUDIT_FLUSH_WAIT_MS));
  }
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} 致命错误:`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
