/**
 * 存量图片回填 CLI —— 把库里内联的护照照片 / 收款凭证（data URL）搬进 blob 存储，库里只留引用。
 *
 * 放在 src/tools 下是为了能被 `tsc -p tsconfig.build.json` 编进 dist、随镜像发布
 * （backend/scripts/ 不编译、不进镜像，线上跑不了）。
 *
 * 用法（容器内，backend 容器已挂 BLOB_DIR 卷）：
 *   docker exec ftm-backend-prod node dist/tools/backfill-image-blobs.js                 # dry-run：只统计
 *   docker exec ftm-backend-prod node dist/tools/backfill-image-blobs.js --apply         # 真转
 *   docker exec ftm-backend-prod node dist/tools/backfill-image-blobs.js --apply --table=Payment,Receipt --limit=200
 *   docker exec ftm-backend-prod node dist/tools/backfill-image-blobs.js --apply --reverse   # 回滚前：引用 → 内联
 *
 * 参数：
 *   --apply            真写 blob + 改库（缺省 dry-run）
 *   --reverse          引用 → 内联（回滚旧代码前用；blob 缺失的行会跳过并点名）
 *   --table=A,B        只处理这些表（Passenger / Payment / Receipt，缺省全部）
 *   --batch=N          每批行数（缺省 50）
 *   --limit=N          本次最多处理 N 行（缺省不限；可分多次跑，天然断点续跑）
 *
 * 退出码：0 正常；1 参数错 / 中途异常（已处理的行不回滚——每行都是独立 CAS，重跑即可续）。
 * 结束时会提示要 VACUUM FULL 哪几张表，请在低峰手动执行，本工具不执行。
 */
import { blobDir } from '../config/env.js';
import { disconnectPrisma } from '../db/prisma.js';
import { probeBlobDir } from '../lib/blob-store.js';
import {
  backfillImageBlobs,
  formatBackfillSummary,
  IMAGE_TABLES,
  type ImageTable,
} from '../lib/image-blob-backfill.js';

interface CliArgs {
  apply: boolean;
  reverse: boolean;
  tables: ImageTable[];
  batchSize: number;
  limit: number;
  help: boolean;
}

function usage(): string {
  return [
    '用法: node dist/tools/backfill-image-blobs.js [--apply] [--reverse] [--table=Passenger,Payment,Receipt] [--batch=50] [--limit=N]',
    '  缺省 dry-run 只统计；--apply 才写 blob + 改库；--reverse 把引用转回内联（回滚前用）。',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { apply: false, reverse: false, tables: [...IMAGE_TABLES], batchSize: 50, limit: 0, help: false };
  for (const raw of argv) {
    const [key, value] = raw.includes('=') ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    switch (key) {
      case '--apply':
        args.apply = true;
        break;
      case '--reverse':
        args.reverse = true;
        break;
      case '--table': {
        const wanted = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const bad = wanted.filter((t) => !IMAGE_TABLES.includes(t as ImageTable));
        if (wanted.length === 0 || bad.length > 0) {
          throw new Error(`--table 只接受 ${IMAGE_TABLES.join(' / ')}，收到: ${value ?? ''}`);
        }
        args.tables = wanted as ImageTable[];
        break;
      }
      case '--batch': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--batch 必须是正整数，收到: ${value ?? ''}`);
        args.batchSize = n;
        break;
      }
      case '--limit': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--limit 必须是非负整数，收到: ${value ?? ''}`);
        args.limit = n;
        break;
      }
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`未知参数 ${raw}\n${usage()}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return 0;
  }

  // eslint-disable-next-line no-console
  console.log(`BLOB_DIR = ${blobDir}`);
  if (args.apply) {
    const problem = await probeBlobDir();
    if (problem) {
      // eslint-disable-next-line no-console
      console.error(`✗ blob 目录不可写，拒绝 apply：${problem}`);
      return 1;
    }
  }

  try {
    const result = await backfillImageBlobs({
      apply: args.apply,
      reverse: args.reverse,
      tables: args.tables,
      batchSize: args.batchSize,
      limit: args.limit,
    });
    // eslint-disable-next-line no-console
    console.log(formatBackfillSummary(result));
    if (!args.apply) {
      // eslint-disable-next-line no-console
      console.log('（dry-run：未写 blob、未改库。确认数字后加 --apply 真跑。）');
    }
    return 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('✗ 回填中断（已完成的行不回滚，修好问题后直接重跑即可续）:', err);
    return 1;
  } finally {
    await disconnectPrisma();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
