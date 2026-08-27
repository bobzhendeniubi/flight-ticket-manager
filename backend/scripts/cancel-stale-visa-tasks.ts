/**
 * 存量「僵尸签证任务」清理（一次性脚本）。
 *
 * 背景：建签证任务的三条路径（建单 / 转 PAID / 补录地面项）历来**只补不删**。于是把订单改成
 * 「不需要签证」、或把乘客全部改成自备签之后，早先建的那条待处理任务还挂在签证台上——签证岗
 * 看到的是一条永远办不掉的「待处理」，点进去还是零乘客（签证台按 visaExempt=false 过滤乘客）。
 * 写侧已改成事件驱动同步（orders.service.ts 的 syncVisaTasksForOrder，改签证状态 / 改自备签时
 * 自动撤任务），但那只管**今后**发生的变更；本脚本负责把改造之前积下来的存量一次性扫干净。
 *
 * 口径不漂移：本脚本**不自己判断「要不要签证」**。
 *   - 预览：对每张候选单调用线上那一个 evaluateOrderVisaTaskState（只读，与写侧同一判定）。
 *   - 执行：调用线上那一个 syncVisaTasksForOrder。
 *   两者背后都是 visa-need.ts 的 orderNeedsVisaTask（订单级需签 或 商品级涉签，且至少一位乘客
 *   要我方代办）。脚本里没有任何一行是判定逻辑的副本，预览到的结论就是 --apply 依据的结论。
 *
 * 选单口径：存在**至少一条 PENDING（还没人动手）** VISA_APPLICATION 任务的订单，逐单重算，
 *   只留下「重算结果 = 不需要签证」的那些。
 *   - 只动 PENDING：IN_PROGRESS / CONFIRMED / FAILED 是签证岗已经在办、或已经出了结果的活，
 *     系统不得替他们撤（真要撤由签证岗自己判断）；CANCELLED 本就是终态。
 *   - 不限订单状态：取消族 / 回收站单上挂着的僵尸待处理任务同样该清（它们更没有办的必要）。
 *     需要只看有效单时用 --status=PAID,PROCESSING,... 自行收窄。
 *
 * 默认 dry-run：只打印清单（订单号 / 乘客数 / 任务 id），一行库都不写、一条审计都不发。
 * 加 --apply 才真正置 CANCELLED，并由 syncVisaTasksForOrder 写 VISA_TASK_AUTO_CANCELLED 审计（INFO）。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/cancel-stale-visa-tasks.ts                      # dry-run 全量预览
 *   npx tsx scripts/cancel-stale-visa-tasks.ts --limit=5            # 只看前 5 张
 *   npx tsx scripts/cancel-stale-visa-tasks.ts --limit=1 --apply    # 先真撤一张试水
 *   npx tsx scripts/cancel-stale-visa-tasks.ts --apply              # 真正执行
 *
 * 参数：
 *   --apply         真正写库（不加 = dry-run，只读）
 *   --limit=N       只处理前 N 张候选单（按建单时间升序），用于试水
 *   --status=A,B    只处理这些订单状态（逗号分隔，OrderStatus 枚举名）；不传 = 不限状态
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量（本脚本不硬编码、不额外读取连接串），
 * 与后端服务同一个 src/db/prisma.js 客户端。
 *
 * ⚠️ 线上怎么跑（scripts/ 既不被 build 编译、也不进 Docker 镜像）：
 *   本目录下的一次性脚本不在镜像里，容器内直接 `npx tsx scripts/...` 找不到文件。做法是把
 *   源码拷进容器再用镜像自带的 tsx 跑（以实测环境 /opt/ftm 为例，测试环境把 ftm 换成 ftm-staging）：
 *     cd /opt/ftm
 *     docker cp backend/src     ftm-backend-1:/app/src
 *     docker cp backend/scripts ftm-backend-1:/app/scripts
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/cancel-stale-visa-tasks.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/cancel-stale-visa-tasks.ts --apply    # 核对无误再执行
 *   （容器名以 `docker compose -p ftm ps` 实际输出为准；docker compose 每个子命令都要带
 *     --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 *
 * 建议流程：dry-run 存证并交签证岗核对 → --limit=1 --apply 试水核一张 → --apply 全量
 *          → 再 dry-run 复核（应为 0 条待清）。
 */
import { FulfillmentStatus, FulfillmentType, OrderStatus, type Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import {
  evaluateOrderVisaTaskState,
  syncVisaTasksForOrder,
} from '../src/modules/orders/orders.service.js';

const LOG_PREFIX = '[cancel-stale-visa-tasks]';

/** 每张订单一个事务（读-改-写要原子；与并发的签证岗接单靠 updateMany 的 status 二次卡串行）。 */
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 15_000;

/**
 * --apply 收尾等待：VISA_TASK_AUTO_CANCELLED 审计在 syncVisaTasksForOrder 里是 `void writeAudit(...)`
 * 即发即忘的，脚本一 disconnect 就可能把还在飞的审计写请求掐掉。收尾多等一会儿让它们落库——
 * 审计本身 best-effort（失败只打 console，不影响清理），这里只是尽量，不做强保证。
 */
const AUDIT_FLUSH_WAIT_MS = 3_000;

interface CliOptions {
  apply: boolean;
  limit?: number;
  statuses?: OrderStatus[];
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    const limit = /^--limit=(\d+)$/u.exec(arg);
    if (limit) {
      opts.limit = Number(limit[1]);
      continue;
    }
    const status = /^--status=(.+)$/u.exec(arg);
    if (status) {
      const names = status[1]
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const valid = Object.values(OrderStatus) as string[];
      const bad = names.filter((n) => !valid.includes(n));
      if (bad.length > 0) {
        throw new Error(`--status 含未知订单状态: ${bad.join(', ')}（可选：${valid.join(', ')}）`);
      }
      opts.statuses = names as OrderStatus[];
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return opts;
}

/** 一条待清理记录（dry-run 打印 / --apply 执行结果字段一致，便于前后对照）。 */
interface StaleRow {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  visaStatus: string;
  passengerCount: number;
  taskIds: string[];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // 候选：存在至少一条 PENDING 签证任务的订单。是不是「僵尸」由逐单重算判定，这里只做粗筛。
  const candidates = await prisma.order.findMany({
    where: {
      ...(opts.statuses ? { status: { in: opts.statuses } } : {}),
      items: {
        some: {
          fulfillmentTasks: {
            some: { type: FulfillmentType.VISA_APPLICATION, status: FulfillmentStatus.PENDING },
          },
        },
      },
    },
    select: { id: true, orderNumber: true, status: true },
    orderBy: { createdAt: 'asc' },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 候选订单 ${candidates.length} 张（含待处理签证任务）` +
      (opts.apply ? ' | 模式: --apply（会写库）' : ' | 模式: dry-run（只读）'),
  );

  const stale: StaleRow[] = [];
  const errors: Array<{ orderNumber: string; message: string }> = [];
  let cancelledTaskCount = 0;

  for (const order of candidates) {
    try {
      // 先只读判定：不需要签证的才进入清理名单（dry-run 到此为止，不写库、不发审计）。
      const state = await evaluateOrderVisaTaskState(prisma, order.id);
      if (!state || state.needed) continue;
      const pendingIds = state.visaTasks
        .filter((t) => t.status === FulfillmentStatus.PENDING)
        .map((t) => t.id);
      if (pendingIds.length === 0) continue;

      const row: StaleRow = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        visaStatus: state.visaStatus ?? '（未填）',
        passengerCount: state.passengerCount,
        taskIds: pendingIds,
      };

      if (opts.apply) {
        // 复用线上同步函数：事务内重算 + 撤销 + 审计，与写侧完全同一条路径。
        const result = await prisma.$transaction(
          (tx: Prisma.TransactionClient) =>
            syncVisaTasksForOrder(tx, order.id, { label: LOG_PREFIX, role: 'SYSTEM' }),
          { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
        );
        // 期间被签证岗接单（PENDING→IN_PROGRESS）或已被别处撤掉 → 什么都没动，不计入清单。
        if (result.cancelledTaskIds.length === 0) continue;
        row.taskIds = result.cancelledTaskIds;
      }

      stale.push(row);
      cancelledTaskCount += row.taskIds.length;
      // eslint-disable-next-line no-console
      console.log(
        `  ${row.orderNumber} | 状态 ${row.orderStatus} | 签证状态 ${row.visaStatus}` +
          ` | 乘客 ${row.passengerCount} 人 | 任务 ${row.taskIds.join(', ')}` +
          (opts.apply ? ' → 已撤销' : ' → 待撤销'),
      );
    } catch (err: unknown) {
      errors.push({
        orderNumber: order.orderNumber,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 完成：命中僵尸单 ${stale.length} 张 / 任务 ${cancelledTaskCount} 条` +
      ` | 失败 ${errors.length} 张` +
      (opts.apply ? '（已写库）' : '（dry-run，未写库；加 --apply 真正执行）'),
  );

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} ${errors.length} 张订单处理失败（各自事务已回滚）:`);
    for (const e of errors) {
      // eslint-disable-next-line no-console
      console.error(`  ${e.orderNumber}: ${e.message}`);
    }
    process.exitCode = 1;
  }

  if (opts.apply && stale.length > 0) {
    // 让即发即忘的审计有机会落库（见 AUDIT_FLUSH_WAIT_MS 说明）。
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
