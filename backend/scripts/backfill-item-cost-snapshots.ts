/**
 * 机票行 / 套餐行成本快照回填（一次性脚本，可安全重跑）。
 *
 * 背景：这两类订单行的成本快照 2026-09-06 才开始落库，在那之前的单一律 NULL。
 * 经营报表与财务概览的毛利口径是「桶里有任何一行缺成本 → 报未知」，于是存量区间的毛利
 * 全是「—」。本脚本把现在算得出来的成本补进去。
 *
 * 口径与幂等一个字都在 src/modules/finances/finances.cost-backfill.ts 里，本文件只是它的命令行外壳
 * ——脚本里没有任何一行是成本算法的副本。那个模块同时被 ADMIN 端点
 * `POST /finances/cost-snapshots/backfill` 调用，两条入口跑的是同一份代码。
 *
 * 有一条限制请先看模块头：成本周期没有版本历史，回填算的是「按今天的周期定义 + 该航段出发日」
 * 得到的成本，不是下单那一刻的周期长什么样。周期没改过的航线两者一致。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/backfill-item-cost-snapshots.ts                      # dry-run 全量，只算不写
 *   npx tsx scripts/backfill-item-cost-snapshots.ts --limit=50           # 先看 50 行
 *   npx tsx scripts/backfill-item-cost-snapshots.ts --limit=50 --apply   # 试水写 50 行
 *   npx tsx scripts/backfill-item-cost-snapshots.ts --apply              # 全量写库
 *
 * 参数：
 *   --apply     真正写库（不加 = dry-run，只读）
 *   --limit=N   最多处理 N 行候选（按订单行 id 升序）
 *
 * 连接串走 Prisma 默认的 DATABASE_URL（不硬编码、不额外读取）：本地 = backend/.env，
 * 实测 / 测试环境 = 服务器上各自的 .env。
 */
import { writeAudit } from '../src/lib/audit.js';
import { prisma } from '../src/db/prisma.js';
import { backfillItemCostSnapshots } from '../src/modules/finances/finances.cost-backfill.js';

const LOG_PREFIX = '[backfill-item-cost-snapshots]';

function parseLimit(argv: readonly string[]): number | undefined {
  const raw = argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--limit 必须是正整数，收到 ${raw}`);
  }
  return n;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limit = parseLimit(process.argv);

  console.log(
    `${LOG_PREFIX} 开始：${apply ? '写库模式（--apply）' : 'dry-run（只算不写）'}` +
      (limit != null ? ` · 最多 ${limit} 行` : ' · 全量'),
  );

  const result = await backfillItemCostSnapshots({ limit, apply });

  console.log(
    `${LOG_PREFIX} 完成：扫描 ${result.scanned} 行 / 补上 ${result.filled} 行 / 跳过 ${result.skipped} 行` +
      `（机票 ${result.byKind.FLIGHT.filled}/${result.byKind.FLIGHT.scanned}、` +
      `套餐 ${result.byKind.BUNDLE.filled}/${result.byKind.BUNDLE.scanned}）` +
      (result.truncated ? ' · 达到 limit 提前收尾，还有候选行没扫到' : '') +
      (apply ? '' : '。确认无误后加 --apply 真正写回。'),
  );
  const reasons = Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    console.log(`${LOG_PREFIX} 跳过原因汇总：`);
    for (const [reason, count] of reasons) {
      console.log(`${LOG_PREFIX}   ${count} 行 · ${reason}`);
    }
  }

  // --apply 必留审计：这批数字会直接改变经营报表与财务概览上的毛利，事后要能回答
  // 「谁、什么时候、按什么口径补了多少行」。脚本的 stdout 留不住。
  if (apply && result.filled > 0) {
    await writeAudit({
      actor: { label: 'backfill-item-cost-snapshots', role: 'SYSTEM' },
      action: 'BACKFILL_ITEM_COST_SNAPSHOTS',
      targetType: 'SYSTEM',
      targetLabel: `订单行成本快照回填 · 补上 ${result.filled} 行`,
      after: {
        ...result,
        limit: limit ?? null,
        // 口径限制随审计一起留档，日后对数时不必翻代码。
        note: '成本周期无版本历史，回填按当前周期定义 + 航段出发日计算；套餐办签人数取当前乘客名单。',
      },
      severity: 'CRITICAL',
    });
  }
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
