/**
 * 存量「婴儿多占座」清查 / 回填脚本（婴儿不占座口径上线后的一次性对账）。
 *
 * 背景：机票行的占座数此前直接吃 `quantity`（含婴儿），纯机票单里的婴儿也被扣了 1 座
 *（公测反馈：婴儿单独一张单占了位）。新口径把占座数独立成 `metadata.seatQuantity`
 *（见 src/modules/orders/flight-seat-quantity.ts），历史行没有这个键 → 座位账回落 quantity，
 * 也就是继续多占。本脚本把这批单找出来，`--fix` 时补上 seatQuantity 并把多占的 sold 回减。
 *
 * 选单口径：占座态订单（SEAT_HOLDING_STATUSES，非回收站）里含 INFANT 乘客的单；
 * 逐条**活**机票行（有班次、非作废/取消航段残骸）比对：
 *   期望占座 = min(quantity, 非婴儿人数)（与建单同一公式 resolveFlightSeatQuantity）；
 *   当前占座 = flightSeatQuantity(行)（缺省 = quantity）；
 *   列出「seatQuantity 缺省」或「当前占座 > 期望占座」的行，多占座数 = 当前 − 期望。
 *
 * --fix 做什么（一张单一个事务）：
 *   · 每条候选行 metadata 补 seatQuantity（= 期望占座）与 infantCount；
 *   · 多占座数 > 0 且班次**尚未起飞**的行：按升舱拆分（businessUpgradeCount）逐舱
 *     releaseSeatFloored 回减 FlightSeatClass.sold —— 与状态机释放同一 helper、同一拆分口径；
 *   · 已起飞的班次只补键不回减 sold（座位已被真实消耗，与状态机「已飞航段不放座」同口径；
 *     补键是为了之后任何释放路径都不会再按 quantity 多放）；
 *   · 每张单落一条 CRITICAL 审计 INFANT_SEAT_BACKFILL（before/after 带逐行明细），可据此回溯。
 * 一个字都不动钱：unitPrice / amount / quantity 原样。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/scan-infant-seat-orders.ts                # dry-run 全量预览（只读）
 *   npx tsx scripts/scan-infant-seat-orders.ts --limit=20     # 只看前 20 张候选单
 *   npx tsx scripts/scan-infant-seat-orders.ts --fix          # 补键 + 回减多占的 sold
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
import {
  AuditSeverity,
  OrderItemKind,
  PassengerType,
  Prisma,
  type CabinClass,
} from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import { writeAuditWithinTx } from '../src/lib/audit.js';
import {
  SEAT_HOLDING_STATUSES,
  computeBundleSeatSplit,
  releaseSeatFloored,
} from '../src/modules/orders/orders.service.js';
import {
  flightSeatQuantity,
  hasExplicitFlightSeatQuantity,
  resolveFlightSeatQuantity,
  withFlightSeatMetadata,
} from '../src/modules/orders/flight-seat-quantity.js';
import { isTerminalLegItem } from '../src/modules/orders/split-move-strategies.js';

const LOG_PREFIX = '[scan-infant-seat-orders]';
const TX_TIMEOUT_MS = 30_000;
const TX_MAX_WAIT_MS = 15_000;

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

function readJsonObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** 一条需要处理的机票行（dry-run 打印 / --fix 落库共用同一份判定结果）。 */
interface SeatFinding {
  itemId: string;
  description: string;
  flightNumber: string | null;
  departureTime: Date | null;
  cabin: CabinClass;
  scheduleId: string;
  quantity: number;
  currentSeat: number;
  expectedSeat: number;
  excess: number;
  hadExplicitSeatQuantity: boolean;
  departed: boolean;
  businessUpgradeCount: number;
}

interface OrderFinding {
  orderId: string;
  orderNumber: string;
  status: string;
  passengerCount: number;
  infantCount: number;
  rows: SeatFinding[];
}

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  passengers: { select: { passengerType: true } },
  items: {
    where: { kind: OrderItemKind.FLIGHT },
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

function assessOrder(order: OrderRow, now: Date): OrderFinding | null {
  const infantCount = order.passengers.filter(
    (p) => p.passengerType === PassengerType.INFANT,
  ).length;
  if (infantCount === 0) return null;
  const nonInfantPax = Math.max(0, order.passengers.length - infantCount);
  const rows: SeatFinding[] = [];
  for (const item of order.items) {
    if (!item.flightScheduleId || !item.flightCabin) continue;
    const meta = readJsonObject(item.metadata);
    if (isTerminalLegItem(meta)) continue;
    const currentSeat = flightSeatQuantity(item);
    const expectedSeat = resolveFlightSeatQuantity(item.quantity, nonInfantPax);
    const hadExplicit = hasExplicitFlightSeatQuantity(item);
    if (hadExplicit && currentSeat <= expectedSeat) continue;
    const departureTime = item.flightSchedule?.departureTime ?? null;
    rows.push({
      itemId: item.id,
      description: item.description,
      flightNumber: item.flightSchedule?.flight?.flightNumber ?? null,
      departureTime,
      cabin: item.flightCabin,
      scheduleId: item.flightScheduleId,
      quantity: item.quantity,
      currentSeat,
      expectedSeat,
      excess: Math.max(0, currentSeat - expectedSeat),
      hadExplicitSeatQuantity: hadExplicit,
      departed: departureTime != null && departureTime.getTime() <= now.getTime(),
      businessUpgradeCount:
        typeof meta.businessUpgradeCount === 'number' ? meta.businessUpgradeCount : 0,
    });
  }
  if (rows.length === 0) return null;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    passengerCount: order.passengers.length,
    infantCount,
    rows,
  };
}

function formatRow(row: SeatFinding): string {
  const when = row.departureTime ? row.departureTime.toISOString().slice(0, 10) : '未知日期';
  const flag = row.hadExplicitSeatQuantity ? '' : '（seatQuantity 缺省）';
  const departed = row.departed ? '（已起飞，只补键不回减）' : '';
  return (
    `    ${row.flightNumber ?? '?'} ${when} ${row.cabin} · quantity ${row.quantity} · ` +
    `当前占 ${row.currentSeat} 座 → 应占 ${row.expectedSeat} 座 · 多占 ${row.excess}${flag}${departed}`
  );
}

/** 逐舱回减多占的 sold：按升舱拆分分别算「当前」与「期望」两份拆分，差额各退各舱。 */
async function releaseExcess(tx: Prisma.TransactionClient, row: SeatFinding): Promise<void> {
  const current = computeBundleSeatSplit(row.cabin, row.currentSeat, row.businessUpgradeCount);
  const expected = computeBundleSeatSplit(row.cabin, row.expectedSeat, row.businessUpgradeCount);
  await releaseSeatFloored(tx, row.scheduleId, 'BUSINESS', current.business - expected.business);
  await releaseSeatFloored(tx, row.scheduleId, row.cabin, current.sameCabin - expected.sameCabin);
}

async function fixOrder(finding: OrderFinding): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${finding.orderId} FOR UPDATE`;
      for (const row of finding.rows) {
        const existing = await tx.orderItem.findUnique({
          where: { id: row.itemId },
          select: { metadata: true },
        });
        const metadata = withFlightSeatMetadata(readJsonObject(existing?.metadata), {
          seatQuantity: row.expectedSeat,
          infantCount: finding.infantCount,
        });
        await tx.orderItem.update({
          where: { id: row.itemId },
          data: { metadata: metadata as Prisma.InputJsonValue },
        });
        if (row.excess > 0 && !row.departed) {
          await releaseExcess(tx, row);
        }
      }
      await writeAuditWithinTx(tx, {
        actor: { label: 'scan-infant-seat-orders', role: 'SYSTEM' },
        action: 'INFANT_SEAT_BACKFILL',
        targetType: 'ORDER',
        targetId: finding.orderId,
        targetLabel: `${finding.orderNumber} · 婴儿不占座回填 · ${finding.rows.length} 条机票行`,
        severity: AuditSeverity.CRITICAL,
        before: {
          rows: finding.rows.map((r) => ({
            itemId: r.itemId,
            seatQuantity: r.hadExplicitSeatQuantity ? r.currentSeat : null,
            quantity: r.quantity,
          })),
        },
        after: {
          passengerCount: finding.passengerCount,
          infantCount: finding.infantCount,
          rows: finding.rows.map((r) => ({
            itemId: r.itemId,
            scheduleId: r.scheduleId,
            cabin: r.cabin,
            seatQuantity: r.expectedSeat,
            soldReleased: r.departed ? 0 : r.excess,
            departed: r.departed,
          })),
        },
      });
    },
    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
  );
}

async function main(): Promise<void> {
  const { fix, limit } = parseArgs(process.argv.slice(2));
  console.log(`${LOG_PREFIX} 模式：${fix ? '写库（--fix）' : 'dry-run（只读）'}`);

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { in: SEAT_HOLDING_STATUSES },
      passengers: { some: { passengerType: PassengerType.INFANT } },
      items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } },
    },
    orderBy: { createdAt: 'asc' },
    ...(limit ? { take: limit } : {}),
    select: ORDER_SELECT,
  });
  console.log(`${LOG_PREFIX} 占座态且含婴儿的机票单：${orders.length} 张`);

  const now = new Date();
  const findings = orders
    .map((o) => assessOrder(o, now))
    .filter((f): f is OrderFinding => f != null);
  let totalExcess = 0;
  let releasable = 0;
  for (const f of findings) {
    console.log(
      `${LOG_PREFIX} ${f.orderNumber}（${f.status}，${f.passengerCount} 人 · 婴儿 ${f.infantCount}）`,
    );
    for (const row of f.rows) {
      console.log(formatRow(row));
      totalExcess += row.excess;
      if (!row.departed) releasable += row.excess;
    }
  }
  console.log(
    `${LOG_PREFIX} 需处理：${findings.length} 张单 / ${findings.reduce((n, f) => n + f.rows.length, 0)} 条机票行 · ` +
      `多占合计 ${totalExcess} 座（其中未起飞可回减 ${releasable} 座）`,
  );
  if (!fix) {
    console.log(`${LOG_PREFIX} dry-run 结束：一行库都没写；确认无误后加 --fix 执行。`);
    return;
  }

  let fixed = 0;
  for (const f of findings) {
    try {
      await fixOrder(f);
      fixed += 1;
      console.log(`${LOG_PREFIX} 已回填 ${f.orderNumber}`);
    } catch (err) {
      console.error(`${LOG_PREFIX} 回填 ${f.orderNumber} 失败（已回滚该单）：`, err);
    }
  }
  console.log(`${LOG_PREFIX} 完成：${fixed}/${findings.length} 张单已回填。`);
}

main()
  .catch((err) => {
    console.error(`${LOG_PREFIX} 失败：`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
