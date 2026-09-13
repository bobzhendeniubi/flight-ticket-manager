/**
 * 存量「机票行占座数 ≠ 当前乘客类型」清查 / 回填脚本（婴儿不占座口径的一次性对账 + 漂移复查）。
 *
 * 背景：机票行的占座数此前直接吃 `quantity`（含婴儿），纯机票单里的婴儿也被扣了 1 座
 *（公测反馈：婴儿单独一张单占了位）。新口径把占座数独立成 `metadata.seatQuantity`
 *（见 src/modules/orders/flight-seat-quantity.ts），历史行没有这个键 → 座位账回落 quantity，
 * 也就是继续多占。
 *
 * 第二类漂移（运营反馈「换人 / 改生日把成人改成婴儿或反过来，机位数不会自动加减」）：
 * 建单盖过章之后，换人 / 订正改了乘客类型，盖章与 sold 都没跟着动 —— 婴儿改成人的单**少占**一座
 *（照旧能被别人卖掉），成人改婴儿的单多占一座。在线路径已由 resyncFlightSeatsWithinTx 收口，
 * 本脚本负责把收口之前漂过的存量找出来。
 *
 * 选单口径：占座态订单（SEAT_HOLDING_STATUSES，非回收站）里含活机票行的单，逐单按**当前**乘客
 * 类型跑与在线路径同一份纯函数 planFlightSeatResync：
 *   期望占座 = min(quantity, 非婴儿人数)（与建单同一公式 resolveFlightSeatQuantity）；
 *   当前占座 = flightSeatQuantity(行)（缺省 = quantity）；
 *   命中 = 任一活机票行「当前占座 ≠ 期望占座」或「盖章缺省 / 婴儿数盖章过期」，且
 *          （本单含婴儿 或 该行盖过章）—— 没盖过章又没有婴儿的老行不可能因婴儿口径漂移，不碰。
 *
 * --fix 做什么（一张单一个事务，Order 行 FOR UPDATE 后按锁后状态跑）：
 *   直接调 OrderService.resyncFlightSeatsWithinTx（与换人 / 订正在线路径**同一份**占放座逻辑）：
 *   · 每条候选行 metadata 重盖 seatQuantity（= 期望占座）与 infantCount；
 *   · 多占（Δ<0）且班次**尚未起飞**：按升舱拆分逐舱 releaseSeatFloored 回减 sold；
 *   · 少占（Δ>0）且尚未起飞：takeSeatWithinTx CAS 占回 —— 班次已售罄则该单整体回滚、打印出来
 *     交人工处理（改期 / 改单申请），绝不超售；
 *   · 已起飞的班次只重盖章不动 sold（座位已被真实消耗，与状态机「已飞航段不放座」同口径）；
 *   · 每张单落一条 FLIGHT_SEAT_RESYNC 审计（reason=backfill，before/after 带逐行明细），可据此回溯。
 * 一个字都不动钱：unitPrice / amount / quantity 原样。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/scan-infant-seat-orders.ts                # dry-run 全量预览（只读）
 *   npx tsx scripts/scan-infant-seat-orders.ts --limit=20     # 只看前 20 张候选单
 *   npx tsx scripts/scan-infant-seat-orders.ts --fix          # 重盖章 + 回减 / 占回 sold
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量，与后端服务同一个 src/db/prisma.js 客户端。
 *
 * ⚠️ 线上怎么跑（scripts/ 既不被 build 编译、也不进 Docker 镜像）：
 *   把源码拷进容器再用镜像自带的 tsx 跑（以实测环境 /opt/ftm 为例，测试环境把 ftm 换成 ftm-staging）：
 *     cd /opt/ftm
 *     docker cp backend/src     ftm-backend-1:/app/src
 *     docker cp backend/scripts ftm-backend-1:/app/scripts
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/scan-infant-seat-orders.ts            # 先 dry-run 存证
 *     docker compose --env-file .env.prod -p ftm exec backend \
 *       npx tsx scripts/scan-infant-seat-orders.ts --fix      # 核对无误再执行
 *   （docker compose 每个子命令都要带 --env-file 与 -p，否则报 PAYMENT_MODE is missing 或串到另一套环境。）
 */
import { OrderItemKind, Prisma, type OrderStatus } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { ConflictError } from '../src/lib/errors.js';
import { OrderService, SEAT_HOLDING_STATUSES } from '../src/modules/orders/orders.service.js';
import {
  planFlightSeatResync,
  type FlightSeatResyncPlan,
  type FlightSeatResyncRowPlan,
} from '../src/modules/orders/flight-seat-resync.js';

const LOG_PREFIX = '[scan-infant-seat-orders]';
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 15_000;
const PAGE_SIZE = 500;

interface CliOptions {
  fix: boolean;
  limit?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const fix = argv.includes('--fix');
  const limitArg = argv.find((a) => a.startsWith('--limit='));
  const limitRaw = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
  if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
    throw new Error('--limit 必须是正整数');
  }
  return { fix, limit: limitRaw };
}

interface OrderFinding {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  plan: FlightSeatResyncPlan;
  /** 需要写的行（与 resyncFlightSeatsWithinTx 会动的行同一份判定）。 */
  rows: FlightSeatResyncRowPlan[];
  /** 行 → 航班号（只用于打印）。 */
  flightNumberByItemId: Map<string, string | null>;
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  passengers: { select: { passengerType: true } },
  items: {
    where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
    select: {
      id: true,
      description: true,
      quantity: true,
      flightScheduleId: true,
      flightCabin: true,
      metadata: true,
      flightSchedule: {
        select: { departureTime: true, flight: { select: { flightNumber: true } } },
      },
    },
  },
} as const;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

/**
 * 与在线路径同一份纯函数算 Δ；命中条件多一层「本单含婴儿 或 该行盖过章」——
 * 没盖过章又没有婴儿的老行，占座数 = quantity 本就是对的，不因这次清查平白盖章 / 动账。
 */
function assessOrder(order: OrderRow, nowMs: number): OrderFinding | null {
  const plan = planFlightSeatResync(order.items, order.passengers, nowMs);
  if (!plan.changed) return null;
  const qualifies = plan.rows.some(
    (r) => r.needsWrite && (plan.infantCount > 0 || r.hadExplicitSeatQuantity),
  );
  if (!qualifies) return null;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    plan,
    rows: plan.rows.filter((r) => r.needsWrite),
    flightNumberByItemId: new Map(
      order.items.map((it) => [it.id, it.flightSchedule?.flight?.flightNumber ?? null]),
    ),
  };
}

function formatRow(finding: OrderFinding, row: FlightSeatResyncRowPlan): string {
  const flightNumber = finding.flightNumberByItemId.get(row.itemId) ?? '?';
  const flags: string[] = [];
  if (!row.hadExplicitSeatQuantity) flags.push('seatQuantity 缺省');
  if (row.delta === 0) flags.push('只重盖章');
  if (row.departed && row.delta !== 0) flags.push('已起飞，只盖章不动账');
  if (row.seatCappedByQuantity) flags.push('套餐腿被 quantity 夹住，座加不上');
  const deltaText =
    row.delta > 0
      ? `少占 ${row.delta}（要占回）`
      : row.delta < 0
        ? `多占 ${-row.delta}（要回减）`
        : 'Δ 0';
  return (
    `    ${flightNumber} ${row.description} ${row.cabin} · quantity ${row.quantity} · ` +
    `当前占 ${row.oldSeat} 座 → 应占 ${row.newSeat} 座 · ${deltaText}` +
    (flags.length > 0 ? `（${flags.join('；')}）` : '')
  );
}

async function fixOrder(
  finding: OrderFinding,
): Promise<{ rows: number; seatDelta: number } | null> {
  const service = new OrderService();
  return prisma.$transaction(
    async (tx) => {
      // 与换人 / 订正入口同一把 Order 行锁；状态按锁后现势重读（dry-run 到 --fix 之间可能已取消）。
      const locked = await tx.$queryRaw<Array<{ status: OrderStatus; deletedAt: Date | null }>>`
        SELECT status, "deletedAt" FROM "Order" WHERE id = ${finding.orderId} FOR UPDATE
      `;
      const current = locked[0];
      if (!current || current.deletedAt) return null;
      return service.resyncFlightSeatsWithinTx(tx, {
        orderId: finding.orderId,
        orderStatus: current.status,
        reason: 'backfill',
        passengerId: null,
        actor: { label: 'scan-infant-seat-orders', role: 'SYSTEM' },
      });
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
  );
}

/** 分页捞占座态且含活机票行的单（在内存里判定，避免对 JSON 键做数据库过滤）。 */
async function* iterateCandidateOrders(): AsyncGenerator<OrderRow> {
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.order.findMany({
      where: {
        deletedAt: null,
        status: { in: SEAT_HOLDING_STATUSES },
        items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } },
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: ORDER_SELECT,
    });
    for (const order of page) yield order;
    if (page.length < PAGE_SIZE) return;
    cursor = page[page.length - 1].id;
  }
}

async function main(): Promise<void> {
  const { fix, limit } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${fix ? '写库（--fix）' : 'dry-run（只读）'}`);

  const nowMs = Date.now();
  const findings: OrderFinding[] = [];
  let scanned = 0;
  for await (const order of iterateCandidateOrders()) {
    scanned += 1;
    const finding = assessOrder(order, nowMs);
    if (!finding) continue;
    findings.push(finding);
    if (limit && findings.length >= limit) break;
  }
  console.log(
    `${LOG_PREFIX} 已扫占座态机票单：${scanned} 张${limit ? `（候选达 --limit=${limit} 后停止）` : ''}`,
  );

  let over = 0;
  let under = 0;
  let overReleasable = 0;
  let underRetakeable = 0;
  for (const f of findings) {
    console.log(
      `${LOG_PREFIX} ${f.orderNumber}（${f.status}，${f.plan.passengerCount} 人 · 婴儿 ${f.plan.infantCount}）`,
    );
    for (const row of f.rows) {
      console.log(formatRow(f, row));
      if (row.delta < 0) {
        over += -row.delta;
        if (!row.departed) overReleasable += -row.delta;
      } else if (row.delta > 0) {
        under += row.delta;
        if (!row.departed) underRetakeable += row.delta;
      }
    }
  }
  console.log(
    `${LOG_PREFIX} 需处理：${findings.length} 张单 / ${findings.reduce((n, f) => n + f.rows.length, 0)} 条机票行 · ` +
      `多占合计 ${over} 座（未起飞可回减 ${overReleasable}）· ` +
      `少占合计 ${under} 座（未起飞要占回 ${underRetakeable}，售罄则该单回滚待人工）`,
  );
  if (!fix) {
    console.log(`${LOG_PREFIX} dry-run 结束：一行库都没写；确认无误后加 --fix 执行。`);
    return;
  }

  let fixed = 0;
  const soldOut: string[] = [];
  for (const f of findings) {
    try {
      const result = await fixOrder(f);
      if (!result) {
        console.log(`${LOG_PREFIX} 跳过 ${f.orderNumber}（锁后已无需处理 / 已进回收站）`);
        continue;
      }
      fixed += 1;
      const signed = `${result.seatDelta >= 0 ? '+' : ''}${result.seatDelta}`;
      console.log(
        `${LOG_PREFIX} 已回填 ${f.orderNumber}：${result.rows} 条机票行，座位账净变化 ${signed}`,
      );
    } catch (err) {
      if (err instanceof ConflictError) {
        soldOut.push(f.orderNumber);
        console.error(
          `${LOG_PREFIX} ${f.orderNumber} 占回失败（已回滚该单，待人工改期 / 改单申请）：${err.message}`,
        );
        continue;
      }
      console.error(`${LOG_PREFIX} 回填 ${f.orderNumber} 失败（已回滚该单）：`, err);
    }
  }
  console.log(`${LOG_PREFIX} 完成：${fixed}/${findings.length} 张单已回填。`);
  if (soldOut.length > 0) {
    console.log(`${LOG_PREFIX} 售罄待人工（${soldOut.length}）：${soldOut.join('、')}`);
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
