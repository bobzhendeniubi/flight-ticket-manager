/**
 * 按人份额（OrderPassengerShare）**一次性回填**脚本 —— 审查根因 R1 上线后跑一次。
 *
 * 背景：上线前的存量订单没有份额行；读侧（详情 / 导出 / 对账单）会对老单 lazy 回填，但那是「谁读到谁回填」，
 * 导出几百张老单时第一次会慢，且从未被读过的单永远缺行。本脚本把活单一次性补齐。
 *
 * 口径不漂移（最关键的一条）：本脚本**不自己算份额**。它对每张缺行的单调用线上那一个写点
 * `service/passenger-shares.persistPassengerShares`（经 backfillPassengerShares），由它去调 lib/order-money 的
 * perPax* 算法、做 Σ 每人结算价 + 不摊条目 = 应收 的守恒断言、每人 upsert 一行。脚本里没有任何一行是算法副本。
 *
 * 选单口径：活单（deletedAt 为空）里「有乘客却缺**当前算法版本**份额行」的，按建单时间升序；
 * 每张单一个独立短事务（Order 行 FOR UPDATE NOWAIT）：撞锁（正在被改的单）/ 守恒失败的单跳过并计数，
 * 不中断整体；重跑会再把它们挑出来。幂等：已有完整份额的单不会被选中；重跑零副作用。
 *
 * ⚠ 一个字都不动订单本身：只写 OrderPassengerShare 表；total / adjustmentCny / 行金额原样。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/backfill-passenger-shares.ts                 # 分批回填直到 remaining = 0（默认每批 500）
 *   npx tsx scripts/backfill-passenger-shares.ts --batch=200     # 每批 200 张
 *   npx tsx scripts/backfill-passenger-shares.ts --limit=50      # 只跑一批 50 张试水（不循环）
 *   npx tsx scripts/backfill-passenger-shares.ts --dry-run       # 只报告缺行的活单数，不写
 *
 * 参数：
 *   --dry-run     只统计，不写库
 *   --batch=N     每批张数（默认 500，上限 5000）
 *   --limit=N     只跑一批、最多 N 张（试水）；不传 = 循环到 remaining 为 0
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量，与后端服务同一个 src/db/prisma.js 客户端。
 *
 * ⚠️ 线上怎么跑（scripts/ 既不被 build 编译、也不进 Docker 镜像）：
 *   本目录下的脚本不在镜像里，容器内直接 `npx tsx scripts/...` 找不到文件。做法是把源码拷进
 *   容器再用镜像自带的 tsx 跑（以实测环境 /opt/ftm 为例，测试环境把 ftm 换成 ftm-staging）：
 *     cd /opt/ftm
 *     docker cp backend/src     ftm-backend-1:/app/src
 *     docker cp backend/scripts ftm-backend-1:/app/scripts
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-passenger-shares.ts --dry-run   # 先看缺多少
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/backfill-passenger-shares.ts             # 真正回填
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 *   不想进容器的话，同一内核也挂在 ADMIN 端点 POST /orders/passenger-shares/backfill?limit=500，
 *   反复调到返回 remaining = 0 即可。
 */
import { prisma } from '../src/db/prisma.js';
import {
  backfillPassengerShares,
  countOrdersMissingShares,
} from '../src/modules/orders/service/passenger-shares.js';
import { PASSENGER_SHARE_ALGO_VERSION } from '../src/modules/orders/passenger-shares.js';

const LOG_PREFIX = '[backfill-passenger-shares]';

function parseArgs(argv: string[]): { dryRun: boolean; batch: number; limit: number | null } {
  let dryRun = false;
  let batch = 500;
  let limit: number | null = null;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--batch=')) batch = Math.max(1, Math.min(5000, Number(arg.slice('--batch='.length)) || 500));
    else if (arg.startsWith('--limit=')) limit = Math.max(1, Number(arg.slice('--limit='.length)) || 1);
    else {
      console.error(`${LOG_PREFIX} 未知参数：${arg}`);
      process.exit(2);
    }
  }
  return { dryRun, batch, limit };
}

async function main(): Promise<void> {
  const { dryRun, batch, limit } = parseArgs(process.argv.slice(2));
  console.log(
    `${LOG_PREFIX} 算法版本 ${PASSENGER_SHARE_ALGO_VERSION}；${
      dryRun ? 'dry-run（只统计）' : limit ? `试水一批（≤ ${limit} 张）` : `循环回填（每批 ${batch} 张）`
    }`,
  );

  const missingBefore = await countOrdersMissingShares(prisma);
  console.log(`${LOG_PREFIX} 缺份额行的活单：${missingBefore} 张`);
  if (dryRun || missingBefore === 0) return;

  const totals = { scanned: 0, persisted: 0, locked: 0, failed: 0 };
  let round = 0;
  for (;;) {
    round += 1;
    const res = await backfillPassengerShares({
      limit: limit ?? batch,
      client: prisma,
      onProgress: (done, total) => {
        if (done === total || done % 50 === 0) {
          process.stdout.write(`${LOG_PREFIX} 第 ${round} 批 ${done}/${total}\r`);
        }
      },
    });
    process.stdout.write('\n');
    totals.scanned += res.scanned;
    totals.persisted += res.persisted;
    totals.locked += res.locked;
    totals.failed += res.failed;
    console.log(
      `${LOG_PREFIX} 第 ${round} 批：扫 ${res.scanned}，落 ${res.persisted}，撞锁 ${res.locked}，失败 ${res.failed}；仍缺 ${res.remaining}`,
    );
    // 试水模式只跑一批；循环模式在「本批一张都没落」时停（剩下的全是撞锁 / 失败，重跑再来），避免空转。
    if (limit !== null || res.remaining === 0 || res.persisted === 0) break;
  }
  console.log(
    `${LOG_PREFIX} 完成：共扫 ${totals.scanned}，落 ${totals.persisted}，撞锁 ${totals.locked}，失败 ${totals.failed}` +
      (totals.locked + totals.failed > 0 ? '（撞锁 / 失败的单请稍后重跑本脚本；失败原因见上方 warn 日志）' : ''),
  );
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
