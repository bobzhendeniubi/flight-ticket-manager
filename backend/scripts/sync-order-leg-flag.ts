/**
 * 订单航段留痕物化列 `Order.legFlag` 的**幂等自愈**脚本。
 *
 * 背景：legFlag 是列表筛选与导出唯一能用的抓手（真源是 FLIGHT 行 metadata 里的
 * noShow / returnReleased / returnRestored / returnVoidedFinal / returnLegCancelled 快照，
 * Prisma 的 where 表达不了「关联行的 JSON 里某个键存在、且比另一个键新」）。
 * 写侧由 syncOrderLegFlag 在每一条落 no-show / 释放 / 恢复 / 取消航段 / 拆单 / 改期的事务内维护，
 * 但只要有一条写路径漏调（新增端点时最容易漏），这一列就会与快照悄悄分叉 ——
 * 列表按「回程已释放」筛不到，导出的「航段状态」列却写着已释放，同一张单两处对不上。
 *
 * 本脚本逐单调用线上那**同一个** syncOrderLegFlag 重算并写回，因此：
 *   · 口径零副本 —— 脚本里没有任何一行是派生逻辑的复制，重算结果就是写侧的结果；
 *   · 幂等 —— 没漂移的单会把同一个值再写一遍，反复跑安全；
 *   · 可先看 —— 默认 dry-run 只打印「哪些单会从 A 改成 B」，一行库都不写。
 *
 * 什么时候跑：
 *   · 20260903000000_add_order_leg_flag 迁移部署后各环境跑一次（迁移只回填了取消航段那一态）；
 *   · 怀疑列表筛选与导出对不上时，随时 dry-run 一次看有没有漂移。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/sync-order-leg-flag.ts                 # dry-run 全量预览（只读）
 *   npx tsx scripts/sync-order-leg-flag.ts --limit=20      # 只看前 20 张
 *   npx tsx scripts/sync-order-leg-flag.ts --apply         # 真正写回漂移的那些
 *
 * 参数：
 *   --apply     真正写库（不加 = dry-run，只读）
 *   --limit=N   只处理前 N 张候选单（按建单时间升序），用于试水
 *
 * 选单口径：**含至少一条 FLIGHT 行**的订单（其余订单的 legFlag 恒为 NONE，没有重算的必要）。
 * 回收站单（deletedAt 非空）一并处理：它们可能被恢复回来，物化列不该留着旧值。
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量（不硬编码、不额外读取连接串），
 * 与后端服务同一个 src/db/prisma.js 客户端。
 *
 * ⚠️ 线上怎么跑（scripts/ 既不被 build 编译、也不进 Docker 镜像）：
 *   本目录下的脚本不在镜像里，容器内直接 `npx tsx scripts/...` 找不到文件。做法是把源码拷进
 *   容器再用镜像自带的 tsx 跑（以实测环境 /opt/ftm 为例，测试环境把 ftm 换成 ftm-staging）：
 *     cd /opt/ftm
 *     docker cp backend/src     ftm-backend-1:/app/src
 *     docker cp backend/scripts ftm-backend-1:/app/scripts
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/sync-order-leg-flag.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/sync-order-leg-flag.ts --apply    # 核对无误再执行
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 */
import { OrderItemKind, type OrderLegFlag } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { syncOrderLegFlag } from '../src/modules/orders/orders.service.js';

const LOG_PREFIX = '[sync-order-leg-flag]';

/** 一张单一个事务：读 FLIGHT 行 → 派生 → 写回，中间不容并发插一脚。 */
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 15_000;

interface CliOptions {
  apply: boolean;
  limit?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const apply = argv.includes('--apply');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limitRaw = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
  if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
    throw new Error('--limit 必须是正整数');
  }
  return { apply, limit: limitRaw };
}

/**
 * 重算一张单的 legFlag。
 * dry-run 也走**同一个事务、同一个函数**，算完抛错回滚 —— 另写一份只读派生必然与写侧漂移，
 * 那样「预览到的」就不是「--apply 会写的」，脚本本身反倒成了新的口径分叉源。
 */
async function resolveLegFlag(orderId: string, apply: boolean): Promise<OrderLegFlag> {
  if (apply) {
    return prisma.$transaction((tx) => syncOrderLegFlag(tx, orderId), {
      timeout: TX_TIMEOUT_MS,
      maxWait: TX_MAX_WAIT_MS,
    });
  }
  const rollback = new Error('dry-run rollback');
  let derived: OrderLegFlag | null = null;
  try {
    await prisma.$transaction(
      async (tx) => {
        derived = await syncOrderLegFlag(tx, orderId);
        throw rollback;
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
    );
  } catch (err) {
    if (err !== rollback) throw err;
  }
  if (derived == null) throw new Error(`重算失败（未拿到派生值）：${orderId}`);
  return derived;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${apply ? '写库（--apply）' : 'dry-run（只读）'}`);

  const candidates = await prisma.order.findMany({
    where: { items: { some: { kind: OrderItemKind.FLIGHT } } },
    select: { id: true, orderNumber: true, legFlag: true },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  });
  console.log(`${LOG_PREFIX} 候选订单 ${candidates.length} 张（含机票行）`);

  let drifted = 0;
  let written = 0;
  for (const order of candidates) {
    const next = await resolveLegFlag(order.id, apply);
    if (next === order.legFlag) continue;
    drifted += 1;
    if (apply) written += 1;
    console.log(
      `${LOG_PREFIX} ${order.orderNumber}：${order.legFlag} → ${next}` +
        (apply ? '（已写回）' : '（dry-run，未写）'),
    );
  }

  console.log(
    `${LOG_PREFIX} 完成：漂移 ${drifted} 张，写回 ${written} 张` +
      (apply ? '' : '。确认无误后加 --apply 真正写回。'),
  );
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
