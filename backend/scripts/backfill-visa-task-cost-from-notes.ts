/**
 * 签证任务人均进价「备注 → 结构化字段」一次性回填。
 *
 * 背景：签证任务有结构化成本字段（visaUnitCostUsd / visaFxRate / visaUnitCostCny + visaSupplier）
 * 之前，进价一直靠签证岗手写在 notes 里，写法约定俗成是「<签证公司><金额>美金」
 * （「斯玛特31.5美金」「林总54美金」）。这批存量备注文本读不进任何报表：成本报表、毛利、
 * 供应商对账全都取结构化字段，于是这些单的签证成本一律回落产品主数据估算，与实际账单对不上。
 * 本脚本把能确定读出来的那部分一次性折算入账，读不确定的一条都不猜、只列清单交人工。
 *
 * 口径不漂移：
 *   - 「这条备注能不能读出金额」由 src/modules/fulfillment/visa-note-cost.ts 的
 *     parseVisaNoteCost 判定（纯函数 + 单测），脚本里没有第二份解析规则。
 *   - 「美金 + 汇率 → 人民币」由线上那一个 resolveVisaUnitCost 折算（签证台手工填成本走的同一函数），
 *     脚本不自己写乘法与四舍五入。
 *   - 汇率取「任务创建当天（北京时间）生效的汇率」，即 finances 的 getUsdFxRate（生效日 ≤ 当天的最新一条）。
 *     取不到且未给 --fallback-rate → 该条跳过并进「缺汇率」清单，绝不臆造汇率。
 *     ⚠️ 汇率表若只维护了近期几条，8 月及更早的任务大概率取不到，需要财务先补历史生效日，
 *        或用 --fallback-rate 明确指定一个统一口径（会原样固化到每条 visaFxRate 上）。
 *
 * 处理两类目标（互斥，同一条任务只会命中其一）：
 *   目标 A —— visaUnitCostCny 为空、且备注能解析出「公司 + 美金」：
 *              写 visaUnitCostUsd / visaFxRate / visaUnitCostCny；
 *              visaSupplier 为空、或被填成了金额（见目标 B）时写入备注里解析出的公司名，
 *              已经是正经公司名的**不覆盖**。
 *   目标 B —— visaSupplier 被填成了金额（如「31.5美金」，填错格），且成本三字段里
 *              visaUnitCostCny 与 visaUnitCostUsd 都为空：把该金额当人均美金进价走同样折算；
 *              公司名换成该任务对应签证产品的 Visa.supplier；关联不到签证产品（套餐行无 visaId）
 *              时把公司名留空并计入报告，避免把金额继续留在公司名格里。
 *
 * 一律不改、只列清单（交财务核对）：
 *   - 已填结构化成本、但备注里的金额与已填美金对不上的任务；
 *   - 已填人民币成本、却没有美金口径可与备注核对的任务；
 *   - 备注读不出确定金额的任务（「斯玛特35+65美金」「斯玛特免费取消」「自备签证*7 …」等）。
 *
 * 幂等：命中条件都以「目标字段还是空」为前提，回填过的任务下次扫描自然落选，可安全重跑
 *      （重跑应输出 0 条待回填）。留档表用 CREATE TABLE IF NOT EXISTS，重跑只追加不重建。
 *
 * 默认 dry-run：只读库、只打印清单与 CSV，一行都不写。加 --apply 才写库，且 --apply 会：
 *   1) 先建留档表 _bak_0908_visa_cost_backfill（任务 id + 改前四字段 + 改后四字段 + 来源备注）；
 *   2) 每条任务一个事务：写留档行 + update 任务（原子，中途失败不留半条）；
 *   3) 每条写一条 AuditLog（action = BACKFILL_VISA_TASK_COST，actor = 系统/脚本）。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/backfill-visa-task-cost-from-notes.ts                        # dry-run 全量预览
 *   npx tsx scripts/backfill-visa-task-cost-from-notes.ts --out=/tmp/签证进价回填.csv  # 预览 + 导 CSV 给财务
 *   npx tsx scripts/backfill-visa-task-cost-from-notes.ts --fallback-rate=6.7344 # 无当日汇率时统一按此折算
 *   npx tsx scripts/backfill-visa-task-cost-from-notes.ts --limit=1 --apply      # 先真回填一条试水
 *   npx tsx scripts/backfill-visa-task-cost-from-notes.ts --apply                # 真正写库
 *
 * 参数：
 *   --apply              真正写库（不加 = dry-run，只读）
 *   --fallback-rate=N    任务创建当天取不到生效汇率时用这个汇率（> 0）；不传 = 不折算、进「缺汇率」清单
 *   --limit=N            只处理前 N 条候选任务（按创建时间升序），用于试水
 *   --out=路径            把逐条明细写成 CSV；**拒绝覆盖已存在的文件**。不传则 dry-run 时把 CSV 打到 stdout
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量（本脚本不硬编码、不额外读取连接串），
 * 与后端服务同一个 src/db/prisma.js 客户端。本地 = backend/.env 的 DATABASE_URL。
 *
 * ⚠️ 线上怎么跑（scripts/ 既不被 build 编译、也不进 Docker 镜像）：
 *   本目录下的一次性脚本不在镜像里，容器内直接 `npx tsx scripts/...` 找不到文件。做法是把
 *   源码拷进容器再用镜像自带的 tsx 跑（以实测环境 /opt/ftm 为例，测试环境把 ftm 换成 ftm-staging）：
 *     cd /opt/ftm
 *     docker cp backend/src     ftm-backend-1:/app/src
 *     docker cp backend/scripts ftm-backend-1:/app/scripts
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-visa-task-cost-from-notes.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-visa-task-cost-from-notes.ts --apply    # 核对无误再执行
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 *
 * 建议流程：dry-run + --out 导 CSV 交财务核对汇率口径 → --limit=1 --apply 试水核一条
 *          → --apply 全量 → 再 dry-run 复核（应为 0 条待回填）。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { FulfillmentType, Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAudit } from '../src/lib/audit.js';
import { businessDateISO } from '../src/lib/business-time.js';
import { getUsdFxRate } from '../src/modules/finances/finances.fx.service.js';
import { resolveVisaUnitCost } from '../src/modules/fulfillment/fulfillment.service.js';
import {
  isAmountOnlySupplier,
  parseAmountOnlySupplier,
  parseVisaNoteCost,
} from '../src/modules/fulfillment/visa-note-cost.js';

const LOG_PREFIX = '[backfill-visa-task-cost-from-notes]';

/** 留档表名（一次性脚本约定：_bak_<日期>_<用途>，跑完留库供财务/后续追溯）。 */
const BACKUP_TABLE = '_bak_0908_visa_cost_backfill';

/** 每条任务一个事务（留档行 + update 原子）。 */
const TX_TIMEOUT_MS = 20_000;
const TX_MAX_WAIT_MS = 10_000;

/** 即发即忘的审计需要一点时间落库，收尾等一等（best-effort，与其它一次性脚本一致）。 */
const AUDIT_FLUSH_WAIT_MS = 3_000;

/** 打印跳过样例的条数上限。 */
const SKIP_SAMPLE_LIMIT = 20;

/** 金额比对容差（两位小数口径，半分以内视为同一笔）。 */
const AMOUNT_EPSILON = 0.005;

interface CliOptions {
  apply: boolean;
  fallbackRate?: number;
  limit?: number;
  out?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    const rate = /^--fallback-rate=(\d+(?:\.\d+)?)$/u.exec(arg);
    if (rate) {
      const value = Number(rate[1]);
      if (!(value > 0)) throw new Error('--fallback-rate 需大于 0');
      opts.fallbackRate = value;
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
  return opts;
}

/** Prisma.Decimal | null → number | null（与 fulfillment.service 的 decOrNull 同口径）。 */
function decOrNull(v: Prisma.Decimal | null): number | null {
  return v == null ? null : Number(v.toString());
}

/** 空字符串 / 纯空白一律当「没填」。 */
function blankToNull(s: string | null): string | null {
  const trimmed = s?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

type RowKind = 'NOTE' | 'SUPPLIER_FIELD';

/** 一条待回填任务（dry-run 打印 / CSV / --apply 写库共用同一份数据）。 */
interface PlannedRow {
  taskId: string;
  orderId: string;
  orderNumber: string;
  /** 命中的目标：NOTE = 目标 A（备注解析）；SUPPLIER_FIELD = 目标 B（公司名格填成了金额） */
  kind: RowKind;
  createdAtBusinessDate: string;
  sourceNotes: string;
  beforeUsd: number | null;
  beforeRate: number | null;
  beforeCny: number | null;
  beforeSupplier: string | null;
  afterUsd: number;
  afterRate: number;
  afterCny: number;
  afterSupplier: string | null;
  /** 汇率来源：库里当天生效汇率 / --fallback-rate */
  rateSource: 'FX_TABLE' | 'FALLBACK';
  /** 目标 B 关联不到签证产品（套餐行无 visaId）→ 公司名只能留空 */
  supplierUnresolved: boolean;
}

/** 不回填、只列清单的一条。 */
interface ReviewRow {
  taskId: string;
  orderNumber: string;
  reason: string;
  notes: string;
  beforeUsd: number | null;
  beforeRate: number | null;
  beforeCny: number | null;
  beforeSupplier: string | null;
  /** 备注里读出来的金额（读不出为 null） */
  noteUsd: number | null;
}

/** 汇率按业务日缓存：431 条任务大多集中在少数几天，避免逐条查库。 */
class FxRateCache {
  private readonly cache = new Map<string, number | null>();

  async get(businessDate: string): Promise<number | null> {
    const hit = this.cache.get(businessDate);
    if (hit !== undefined) return hit;
    const row = await getUsdFxRate(businessDate, prisma);
    const rate = row ? row.rate : null;
    this.cache.set(businessDate, rate);
    return rate;
  }
}

function csvCell(v: string | number | null): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

function buildCsv(planned: readonly PlannedRow[], review: readonly ReviewRow[]): string {
  const lines: string[] = [];
  lines.push(
    [
      '类别',
      '任务id',
      '订单号',
      '来源',
      '任务创建日(北京)',
      '原美金',
      '原汇率',
      '原人民币',
      '原签证公司',
      '新美金',
      '新汇率',
      '新人民币',
      '新签证公司',
      '汇率来源',
      '备注原文',
      '说明',
    ]
      .map(csvCell)
      .join(','),
  );
  for (const r of planned) {
    lines.push(
      [
        '待回填',
        r.taskId,
        r.orderNumber,
        r.kind === 'NOTE' ? '备注解析' : '公司名格填成金额',
        r.createdAtBusinessDate,
        r.beforeUsd,
        r.beforeRate,
        r.beforeCny,
        r.beforeSupplier,
        r.afterUsd,
        r.afterRate,
        r.afterCny,
        r.afterSupplier,
        r.rateSource === 'FX_TABLE' ? '当日生效汇率' : 'fallback-rate',
        r.sourceNotes,
        r.supplierUnresolved ? '关联不到签证产品，公司名留空待人工补' : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  for (const r of review) {
    lines.push(
      [
        '待人工核对',
        r.taskId,
        r.orderNumber,
        '',
        '',
        r.beforeUsd,
        r.beforeRate,
        r.beforeCny,
        r.beforeSupplier,
        r.noteUsd,
        '',
        '',
        '',
        '',
        r.notes,
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
      "source"         text,
      "sourceNotes"    text,
      "beforeUsd"      numeric(10,2),
      "beforeRate"     numeric(12,6),
      "beforeCny"      numeric(10,2),
      "beforeSupplier" text,
      "afterUsd"       numeric(10,2),
      "afterRate"      numeric(12,6),
      "afterCny"       numeric(10,2),
      "afterSupplier"  text,
      "backfilledAt"   timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function writeBackupRow(tx: Prisma.TransactionClient, row: PlannedRow): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "${BACKUP_TABLE}"
       ("taskId","orderId","orderNumber","source","sourceNotes",
        "beforeUsd","beforeRate","beforeCny","beforeSupplier",
        "afterUsd","afterRate","afterCny","afterSupplier")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    row.taskId,
    row.orderId,
    row.orderNumber,
    row.kind,
    row.sourceNotes,
    row.beforeUsd,
    row.beforeRate,
    row.beforeCny,
    row.beforeSupplier,
    row.afterUsd,
    row.afterRate,
    row.afterCny,
    row.afterSupplier,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.out && existsSync(opts.out)) {
    throw new Error(`--out 指向的文件已存在，拒绝覆盖: ${opts.out}`);
  }

  const tasks = await prisma.fulfillmentTask.findMany({
    where: { type: FulfillmentType.VISA_APPLICATION },
    select: {
      id: true,
      notes: true,
      createdAt: true,
      visaUnitCostUsd: true,
      visaFxRate: true,
      visaUnitCostCny: true,
      visaSupplier: true,
      orderItem: {
        select: {
          visaId: true,
          visa: { select: { supplier: true } },
          order: { select: { id: true, orderNumber: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 签证任务 ${tasks.length} 条` +
      (opts.apply ? ' | 模式: --apply（会写库）' : ' | 模式: dry-run（只读）') +
      (opts.fallbackRate ? ` | 无当日汇率时按 ${opts.fallbackRate} 折算` : ''),
  );

  const fx = new FxRateCache();
  const planned: PlannedRow[] = [];
  const review: ReviewRow[] = [];
  const missingRate: ReviewRow[] = [];
  const skipped: ReviewRow[] = [];
  let alreadyFilled = 0;

  for (const t of tasks) {
    const orderId = t.orderItem.order.id;
    const orderNumber = t.orderItem.order.orderNumber;
    const notes = t.notes ?? '';
    const beforeUsd = decOrNull(t.visaUnitCostUsd);
    const beforeRate = decOrNull(t.visaFxRate);
    const beforeCny = decOrNull(t.visaUnitCostCny);
    const beforeSupplier = blankToNull(t.visaSupplier);
    const parsed = parseVisaNoteCost(t.notes);
    const supplierIsAmount = isAmountOnlySupplier(t.visaSupplier);
    const base = {
      taskId: t.id,
      orderNumber,
      notes,
      beforeUsd,
      beforeRate,
      beforeCny,
      beforeSupplier,
      noteUsd: parsed?.usd ?? null,
    };

    // 已填结构化成本：一律不改，只判断要不要交人工核对。
    if (beforeCny != null) {
      if (parsed && beforeUsd != null && Math.abs(beforeUsd - parsed.usd) > AMOUNT_EPSILON) {
        review.push({ ...base, reason: '备注金额与已填美金成本不一致' });
      } else if (parsed && beforeUsd == null) {
        review.push({ ...base, reason: '已填人民币成本但无美金口径，无法与备注核对' });
      } else {
        alreadyFilled++;
      }
      continue;
    }

    // 目标 A：备注能解析出「公司 + 美金」。
    // 已填美金却与备注对不上 → 不改，交人工（不能因为人民币是空的就用备注覆盖已录的美金）。
    let usd: number | null = null;
    let kind: RowKind = 'NOTE';
    let supplierFromSource: string | null = null;
    let supplierUnresolved = false;

    if (parsed) {
      if (beforeUsd != null && Math.abs(beforeUsd - parsed.usd) > AMOUNT_EPSILON) {
        review.push({ ...base, reason: '备注金额与已填美金成本不一致' });
        continue;
      }
      usd = parsed.usd;
      kind = 'NOTE';
      supplierFromSource = parsed.supplier;
    } else if (supplierIsAmount && beforeUsd == null) {
      // 目标 B：公司名格被填成了金额，且成本三字段里美金/人民币都空。
      usd = parseAmountOnlySupplier(t.visaSupplier);
      kind = 'SUPPLIER_FIELD';
      // 公司名换成该任务对应签证产品的默认供应商；套餐行无 visaId → 留空，计入报告。
      supplierFromSource = blankToNull(t.orderItem.visa?.supplier ?? null);
      supplierUnresolved = supplierFromSource == null;
    }

    if (usd == null) {
      skipped.push({ ...base, reason: parsed ? '已有美金成本，无需回填' : '备注读不出确定金额' });
      continue;
    }

    const businessDate = businessDateISO(t.createdAt);
    const tableRate = await fx.get(businessDate);
    const rate = tableRate ?? opts.fallbackRate ?? null;
    if (rate == null) {
      missingRate.push({ ...base, reason: `任务创建日 ${businessDate} 无生效汇率` });
      continue;
    }

    const resolved = resolveVisaUnitCost({ visaUnitCostUsd: usd, visaFxRate: rate });
    if (resolved.cny == null) {
      missingRate.push({ ...base, reason: `折算失败（美金 ${usd} × 汇率 ${rate}）` });
      continue;
    }

    // 公司名：空着、或被填成了金额时才写；已经是正经公司名的绝不覆盖。
    const shouldWriteSupplier = beforeSupplier == null || supplierIsAmount;
    planned.push({
      taskId: t.id,
      orderId,
      orderNumber,
      kind,
      createdAtBusinessDate: businessDate,
      sourceNotes: notes,
      beforeUsd,
      beforeRate,
      beforeCny,
      beforeSupplier,
      afterUsd: usd,
      afterRate: rate,
      afterCny: resolved.cny,
      afterSupplier: shouldWriteSupplier ? supplierFromSource : beforeSupplier,
      rateSource: tableRate != null ? 'FX_TABLE' : 'FALLBACK',
      supplierUnresolved: shouldWriteSupplier && supplierUnresolved,
    });
  }

  // ── 写库（--apply）──
  const failures: Array<{ taskId: string; message: string }> = [];
  let appliedCount = 0;
  if (opts.apply && planned.length > 0) {
    await ensureBackupTable();
    for (const row of planned) {
      try {
        await prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            await writeBackupRow(tx, row);
            // 二次卡「人民币成本仍为空」：期间被签证岗手工填过就原样跳过，脚本不覆盖人工录入。
            const updated = await tx.fulfillmentTask.updateMany({
              where: { id: row.taskId, visaUnitCostCny: null },
              data: {
                visaUnitCostUsd: row.afterUsd,
                visaFxRate: row.afterRate,
                visaUnitCostCny: row.afterCny,
                ...(row.afterSupplier !== row.beforeSupplier
                  ? { visaSupplier: row.afterSupplier }
                  : {}),
              },
            });
            if (updated.count === 0) {
              throw new Error('SKIP_CONCURRENT_EDIT');
            }
          },
          { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'SKIP_CONCURRENT_EDIT') {
          // eslint-disable-next-line no-console
          console.log(`  ${row.orderNumber} / ${row.taskId} → 期间已被人工填过，跳过`);
          continue;
        }
        failures.push({ taskId: row.taskId, message });
        continue;
      }
      appliedCount++;
      void writeAudit({
        actor: { label: LOG_PREFIX, role: 'SYSTEM' },
        action: 'BACKFILL_VISA_TASK_COST',
        targetType: 'ORDER',
        targetId: row.orderId,
        targetLabel: `${row.orderNumber} / VISA_APPLICATION`,
        before: {
          visaUnitCostUsd: row.beforeUsd,
          visaFxRate: row.beforeRate,
          visaUnitCostCny: row.beforeCny,
          visaSupplier: row.beforeSupplier,
        },
        after: {
          visaUnitCostUsd: row.afterUsd,
          visaFxRate: row.afterRate,
          visaUnitCostCny: row.afterCny,
          visaSupplier: row.afterSupplier,
          source: row.kind === 'NOTE' ? 'notes' : 'visaSupplier',
          sourceNotes: row.sourceNotes,
          rateSource: row.rateSource,
        },
      });
    }
  }

  // ── 汇总 ──
  const distribution = new Map<string, number>();
  for (const r of planned) {
    const key = `${r.afterSupplier ?? '（公司名未知）'} ${r.afterUsd}美金`;
    distribution.set(key, (distribution.get(key) ?? 0) + 1);
  }
  const fallbackCount = planned.filter((r) => r.rateSource === 'FALLBACK').length;
  const supplierUnresolvedCount = planned.filter((r) => r.supplierUnresolved).length;

  /* eslint-disable no-console */
  console.log('');
  console.log(`${LOG_PREFIX} ── 汇总 ──`);
  console.log(
    `  命中待回填 ${planned.length} 条` +
      `（备注解析 ${planned.filter((r) => r.kind === 'NOTE').length} 条 / ` +
      `公司名格填成金额 ${planned.filter((r) => r.kind === 'SUPPLIER_FIELD').length} 条）` +
      (opts.apply ? ` | 实际写库 ${appliedCount} 条` : ''),
  );
  console.log(`  其中用 --fallback-rate 折算 ${fallbackCount} 条`);
  console.log(`  其中关联不到签证产品、公司名留空 ${supplierUnresolvedCount} 条`);
  console.log(`  已填成本无需处理 ${alreadyFilled} 条`);
  console.log(`  缺汇率跳过 ${missingRate.length} 条`);
  console.log(`  不一致 / 待人工核对 ${review.length} 条`);
  console.log(`  备注读不出金额跳过 ${skipped.length} 条`);

  console.log('');
  console.log('  按「公司 × 金额」分布：');
  for (const [key, count] of [...distribution.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${key} | ${count} 条`);
  }

  if (missingRate.length > 0) {
    console.log('');
    console.log(`  缺汇率清单（前 ${SKIP_SAMPLE_LIMIT} 条）：`);
    for (const r of missingRate.slice(0, SKIP_SAMPLE_LIMIT)) {
      console.log(`    ${r.orderNumber} / ${r.taskId} | ${r.reason} | 备注「${r.notes}」`);
    }
  }

  if (review.length > 0) {
    console.log('');
    console.log('  不一致 / 待人工核对清单（全量）：');
    for (const r of review) {
      console.log(
        `    ${r.orderNumber} / ${r.taskId} | ${r.reason}` +
          ` | 已填 $${r.beforeUsd ?? '-'} × ${r.beforeRate ?? '-'} = ¥${r.beforeCny ?? '-'}` +
          ` | 备注 $${r.noteUsd ?? '-'}「${r.notes}」`,
      );
    }
  }

  if (skipped.length > 0) {
    console.log('');
    console.log(`  读不出金额的跳过样例（前 ${SKIP_SAMPLE_LIMIT} 条）：`);
    for (const r of skipped.slice(0, SKIP_SAMPLE_LIMIT)) {
      console.log(`    ${r.orderNumber} / ${r.taskId} | 备注「${r.notes}」`);
    }
  }

  const csv = buildCsv(planned, [...review, ...missingRate, ...skipped]);
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
    for (const f of failures) {
      console.error(`  ${f.taskId}: ${f.message}`);
    }
    process.exitCode = 1;
  }
  /* eslint-enable no-console */

  if (opts.apply && appliedCount > 0) {
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
