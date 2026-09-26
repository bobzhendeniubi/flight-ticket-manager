/**
 * 存量图片回填内核：把三列（Passenger.passportPhotoUrl / Payment.proofUrl / Receipt.proofUrl）里
 * 仍是内联 data URL 的行逐行转成 blob 引用；`reverse` 模式反过来（回滚旧代码前用）。
 *
 * 调用方：
 *   - CLI  tools/backfill-image-blobs.ts（容器里 `node dist/tools/backfill-image-blobs.js`）
 *   - worker 每日兜底清扫（小 limit，只捞漏网行）
 *
 * 口径：
 *   - **默认 dry-run**：只解码 / 嗅探 / 算 sha、统计行数字节去重数，不写 blob、不改库。
 *   - 分批：按主键 keyset 游标（id > 上一批末尾，ORDER BY id LIMIT n）取「仍是待转形态」的行；
 *     转成功的行不再匹配前缀，所以**天然幂等、可断点续跑**——中断后重跑从头扫也只会处理剩下的。
 *   - 每行：先写 blob → 读回校验 sha → 再 CAS 条件更新（WHERE id = ? AND md5(列) = 旧值 md5；
 *     旧值动辄几百 KB，直接比 md5 省得把整列再传一遍）。CAS 0 行 = 期间有人改了这行 → 跳过，
 *     下次运行再看。
 *   - 转不了（非 base64 image / 魔数不对 / 超限）→ 跳过并点名 id，原值原样保留。
 *   - **永不删除 blob**，也不动 updatedAt（存储搬家不是业务变更）。
 *   - 只走 rawPrisma（不带图片出库钩子）：钩子会把读到的引用还原成 data URL、把写入的
 *     data URL 又转成引用，CAS 条件也会被改写，全部乱套。
 *   - 结束时提示 VACUUM FULL：UPDATE 只是把大值改成短值，旧 TOAST 块要 VACUUM FULL 才还给磁盘，
 *     那会锁表，交给运维在低峰手动跑，本模块不执行。
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { IMAGE_COLUMNS } from '../db/image-blob-extension.js';
import { rawPrisma } from '../db/prisma.js';
import { getBlobStore, sha256Hex, type BlobStore } from './blob-store.js';
import {
  BLOB_REF_PREFIX,
  decodeImageDataUrl,
  makeBlobRef,
  parseBlobRef,
  sniffImageMime,
  toImageDataUrl,
} from './image-ref.js';

export type ImageTable = 'Passenger' | 'Payment' | 'Receipt';
export const IMAGE_TABLES: readonly ImageTable[] = ['Passenger', 'Payment', 'Receipt'];

const DEFAULT_BATCH_SIZE = 50;

export interface BackfillOptions {
  /** true = 真写 blob + 改库；缺省 false = dry-run 只统计。 */
  apply?: boolean;
  /** true = 引用 → 内联（回滚前把库转回旧代码读得懂的形态）。 */
  reverse?: boolean;
  tables?: readonly ImageTable[];
  batchSize?: number;
  /** 本次最多处理多少行（所有表合计）；0 / 缺省 = 不限。 */
  limit?: number;
  /** 缺省 rawPrisma —— 必须是**不带**图片出库钩子的客户端。 */
  client?: PrismaClient;
  store?: BlobStore;
  log?: (line: string) => void;
  /** 测试钩子：每行 CAS 更新前调用（用来模拟并发改写触发 CAS 冲突）。 */
  beforeUpdate?: (row: { table: ImageTable; id: string }) => Promise<void>;
}

export interface TableBackfillStats {
  table: ImageTable;
  column: string;
  /** 取到的候选行 */
  scanned: number;
  /** 已转换（apply）/ 可转换（dry-run）的行 */
  converted: number;
  /** 这些行解码后的字节总和 */
  bytes: number;
  /** 新写的 blob 文件数 */
  blobsCreated: number;
  /** 命中已有 blob（含本轮前面已写过同一张图）的行数 = 去重数 */
  blobsDeduped: number;
  /** 转不了的行（非 image base64 / 魔数不对 / blob 缺失） */
  skippedUnconvertible: number;
  /** CAS 冲突跳过的行 */
  skippedConflict: number;
  /** 结束时表里仍是待转形态的行数 */
  remaining: number;
}

export interface BackfillResult {
  mode: 'dry-run' | 'apply';
  direction: 'forward' | 'reverse';
  tables: TableBackfillStats[];
  /** 所有表合计处理（scanned）行数 */
  processed: number;
  /** apply 且真改了行时给出的 VACUUM FULL 提示（低峰手动执行），否则 null */
  vacuumHint: string | null;
}

interface ColumnTarget {
  table: ImageTable;
  column: string;
}

function columnTargets(tables: readonly ImageTable[]): ColumnTarget[] {
  return tables.flatMap((table) => (IMAGE_COLUMNS[table] ?? []).map((column) => ({ table, column })));
}

/** 转换计划：新值 + （正向时）待写的字节。 */
interface ConversionPlan {
  newValue: string;
  bytes: Buffer | null;
  sha256: string | null;
}

function planForward(value: string): ConversionPlan | null {
  const decoded = decodeImageDataUrl(value);
  if (!decoded) return null;
  const mime = sniffImageMime(decoded.bytes);
  if (!mime) return null;
  const sha256 = sha256Hex(decoded.bytes);
  return { newValue: makeBlobRef(sha256, mime), bytes: decoded.bytes, sha256 };
}

async function planReverse(value: string, store: BlobStore): Promise<ConversionPlan | null> {
  const ref = parseBlobRef(value);
  if (!ref) return null;
  const bytes = await store.get(ref.sha256);
  if (!bytes) return null;
  return { newValue: toImageDataUrl(bytes, ref.mime), bytes: null, sha256: null };
}

function md5Hex(value: string): string {
  // 列值是 ASCII（base64 / 引用），Node 的 utf8 字节与 Postgres md5(text) 的服务端编码字节一致
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/** 一次运行的共享状态：剩余预算 + 本轮已见过的 sha（跨表去重计数，dry-run 与 apply 口径一致）。 */
interface RunState {
  remaining: number;
  seenSha: Set<string>;
}

async function backfillTable(
  target: ColumnTarget,
  opts: Required<Pick<BackfillOptions, 'apply' | 'reverse' | 'batchSize' | 'client' | 'store' | 'log'>> &
    Pick<BackfillOptions, 'beforeUpdate'>,
  run: RunState,
): Promise<TableBackfillStats> {
  const stats: TableBackfillStats = {
    table: target.table,
    column: target.column,
    scanned: 0,
    converted: 0,
    bytes: 0,
    blobsCreated: 0,
    blobsDeduped: 0,
    skippedUnconvertible: 0,
    skippedConflict: 0,
    remaining: 0,
  };
  // 表名 / 列名来自固定白名单（IMAGE_COLUMNS），不是外部输入
  const tbl = Prisma.raw(`"${target.table}"`);
  const col = Prisma.raw(`"${target.column}"`);
  const pendingPrefix = opts.reverse ? `${BLOB_REF_PREFIX}%` : 'data:%';
  const { seenSha } = run;
  let lastId = '';

  while (run.remaining > 0) {
    const take = Math.min(opts.batchSize, run.remaining);
    const rows = await opts.client.$queryRaw<Array<{ id: string; value: string }>>`
      SELECT id, ${col} AS value FROM ${tbl}
      WHERE id > ${lastId} AND ${col} LIKE ${pendingPrefix}
      ORDER BY id
      LIMIT ${take}
    `;
    if (rows.length === 0) break;

    for (const row of rows) {
      // 无论成败都推进游标：转成功的行不再匹配前缀，失败的行下次运行再看
      lastId = row.id;
      run.remaining -= 1;
      stats.scanned += 1;

      const plan = opts.reverse ? await planReverse(row.value, opts.store) : planForward(row.value);
      if (!plan) {
        stats.skippedUnconvertible += 1;
        opts.log(
          `  ✗ ${target.table}.${target.column} id=${row.id} 转不了（${
            opts.reverse ? 'blob 缺失或引用非法' : '非 image base64 / 魔数不是 JPEG/PNG/WEBP/GIF / 超限'
          }），原值保留`,
        );
        continue;
      }

      if (plan.bytes && plan.sha256) {
        stats.bytes += plan.bytes.byteLength;
        const dedupe = seenSha.has(plan.sha256) || (await opts.store.exists(plan.sha256));
        if (opts.apply) {
          const { created } = await opts.store.put(plan.bytes);
          // 读回校验：写进去的必须能原样读出来，sha 对不上说明磁盘 / 卷有问题，立刻停
          const back = await opts.store.get(plan.sha256);
          if (!back || sha256Hex(back) !== plan.sha256) {
            throw new Error(`blob 读回校验失败: sha256=${plan.sha256}（${target.table} id=${row.id}）`);
          }
          if (created) stats.blobsCreated += 1;
          else stats.blobsDeduped += 1;
        } else if (dedupe) {
          stats.blobsDeduped += 1;
        } else {
          stats.blobsCreated += 1;
        }
        seenSha.add(plan.sha256);
      }

      if (!opts.apply) {
        stats.converted += 1;
        continue;
      }

      if (opts.beforeUpdate) await opts.beforeUpdate({ table: target.table, id: row.id });
      const oldMd5 = md5Hex(row.value);
      const updated = await opts.client.$executeRaw`
        UPDATE ${tbl} SET ${col} = ${plan.newValue}
        WHERE id = ${row.id} AND md5(${col}) = ${oldMd5}
      `;
      if (updated === 1) {
        stats.converted += 1;
      } else {
        stats.skippedConflict += 1;
        opts.log(`  ↷ ${target.table}.${target.column} id=${row.id} 期间被改写，跳过（下次运行再看）`);
      }
    }
  }

  const [{ n }] = await opts.client.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} LIKE ${pendingPrefix}
  `;
  stats.remaining = n;
  return stats;
}

export async function backfillImageBlobs(options: BackfillOptions = {}): Promise<BackfillResult> {
  const apply = options.apply ?? false;
  const reverse = options.reverse ?? false;
  const tables = options.tables ?? IMAGE_TABLES;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const client = options.client ?? rawPrisma;
  const store = options.store ?? getBlobStore();
  // eslint-disable-next-line no-console
  const log = options.log ?? ((line: string) => console.log(line));
  const run: RunState = {
    remaining: options.limit && options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY,
    seenSha: new Set<string>(),
  };

  const results: TableBackfillStats[] = [];
  for (const target of columnTargets(tables)) {
    if (run.remaining <= 0) break;
    log(`▶ ${apply ? 'apply' : 'dry-run'} ${reverse ? '引用→内联' : '内联→引用'} ${target.table}.${target.column}`);
    const stats = await backfillTable(
      target,
      { apply, reverse, batchSize, client, store, log, beforeUpdate: options.beforeUpdate },
      run,
    );
    results.push(stats);
  }

  const processed = results.reduce((sum, s) => sum + s.scanned, 0);
  const changedTables = results.filter((s) => apply && s.converted > 0).map((s) => `"${s.table}"`);
  const vacuumHint =
    changedTables.length > 0
      ? `已改写的行留下的旧 TOAST 空间要低峰手动回收：VACUUM FULL ${changedTables.join(', ')};（会锁表，几分钟到十几分钟）`
      : null;

  return {
    mode: apply ? 'apply' : 'dry-run',
    direction: reverse ? 'reverse' : 'forward',
    tables: results,
    processed,
    vacuumHint,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 人读的汇总（CLI / worker 日志共用）。 */
export function formatBackfillSummary(result: BackfillResult): string {
  const lines = [
    `═══ 图片回填 ${result.mode} · ${result.direction === 'reverse' ? '引用→内联（回滚）' : '内联→引用'} ═══`,
  ];
  for (const s of result.tables) {
    lines.push(
      `${s.table}.${s.column}: 扫描 ${s.scanned} 行 · ${result.mode === 'apply' ? '已转' : '可转'} ${s.converted} 行 · ` +
        `${fmtBytes(s.bytes)} · 新 blob ${s.blobsCreated} · 去重 ${s.blobsDeduped} · ` +
        `跳过(转不了) ${s.skippedUnconvertible} · 跳过(CAS 冲突) ${s.skippedConflict} · 剩余待转 ${s.remaining}`,
    );
  }
  lines.push(`合计处理 ${result.processed} 行`);
  if (result.vacuumHint) lines.push(`⚠ ${result.vacuumHint}`);
  return lines.join('\n');
}
