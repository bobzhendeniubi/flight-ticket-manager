/**
 * 存量订单行成本快照回填 —— 只填 NULL，不动任何已有的数。
 *
 * 机票行 / 套餐行的成本快照是 2026-09-06 才开始落库的（见 orders/service/item-cost-snapshot.ts）。
 * 在那之前的单这两类行恒 NULL，于是经营报表与财务概览里凡是沾着这些单的桶，毛利一律「未知」。
 * 本模块把**现在算得出来的**成本补进去，让存量区间的毛利也有数可看。
 *
 * ## 口径（一个数都不自己算）
 * - 机票行：`resolveFlightItemCost`（唯一算法），按该航段班次的出发日匹配成本周期。
 * - 套餐行：`computeBundleGroundCost`（与建单同一个函数），按套餐 items 的组件求和。
 *
 * ## 一条要说清楚的限制
 * 成本周期没有版本历史 —— 库里只有「当前的周期定义」。所以回填算出来的是
 * **按今天的周期定义、匹配该航段出发日**得到的成本，不是「下单那一刻周期长什么样」。
 * 周期建好之后没被改过的航线，两者是同一个数；中途调过周期的航线，回填值会是调整后的口径。
 * 这一点绕不开（要绕开得先给周期加版本表），故如实写在这里，也写进审计的 after 里。
 * 新单不受影响：新单在建单那一刻就把快照落下来了，事后改周期不追溯。
 *
 * 同理，套餐行的「办签人数」用的是**当前**乘客名单（非自备签的人数）——换人 / 加减人之后
 * 这个数会与下单那天不同。这是回填的固有误差，不是算法分歧。
 *
 * ## 幂等
 * 只挑 `totalCostCny IS NULL` 的行，算得出来才写；写的时候 where 里再夹一次 `totalCostCny: null`，
 * 并发下别的流程刚填过这行时本次落空，绝不覆盖。算不出来的行原样留 NULL（算不出 = 成本真未知），
 * 绝不写 0 让毛利虚高。脚本与端点都可安全重跑。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  computeBundleGroundCost,
  flightSnapshotKey,
  loadBundleComponentCosts,
  resolveFlightCostSnapshots,
} from '../orders/service/item-cost-snapshot.js';

/** 每批处理的订单行数（一批一个事务，失败只回滚这一批）。 */
const BATCH_SIZE = 200;

export interface CostSnapshotBackfillResult {
  /** 扫过的候选行数（kind ∈ {FLIGHT, BUNDLE} 且 totalCostCny 为 NULL）。 */
  scanned: number;
  /** 真正写进快照的行数（dryRun 时 = 本来会写的行数）。 */
  filled: number;
  /** 算不出成本、原样留 NULL 的行数。 */
  skipped: number;
  /** 跳过原因 → 条数（给运营看「还差什么才能补上」）。 */
  skipReasons: Record<string, number>;
  byKind: {
    FLIGHT: { scanned: number; filled: number };
    BUNDLE: { scanned: number; filled: number };
  };
  /** true = 只算不写。 */
  dryRun: boolean;
  /** 达到 limit 提前收尾（还有候选行没扫到）。 */
  truncated: boolean;
}

interface BackfillItemRow {
  id: string;
  kind: string;
  quantity: number;
  flightScheduleId: string | null;
  roomsBilled: Prisma.Decimal | null;
  hotelRoomType: { costPriceCny: Prisma.Decimal | null } | null;
  bundle: { items: Prisma.JsonValue } | null;
  order: { passengers: Array<{ visaExempt: boolean }> };
}

interface PendingWrite {
  id: string;
  kind: 'FLIGHT' | 'BUNDLE';
  unitCostCny: number | null;
  totalCostCny: number;
}

function emptyResult(dryRun: boolean): CostSnapshotBackfillResult {
  return {
    scanned: 0,
    filled: 0,
    skipped: 0,
    skipReasons: {},
    byKind: { FLIGHT: { scanned: 0, filled: 0 }, BUNDLE: { scanned: 0, filled: 0 } },
    dryRun,
    truncated: false,
  };
}

function note(result: CostSnapshotBackfillResult, reason: string): void {
  result.skipped += 1;
  result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1;
}

/**
 * 回填候选行的成本快照。
 *
 * @param opts.limit 最多处理多少行（不传 = 全量）。用于试水：先跑小批看结果再全量。
 * @param opts.apply true 才写库；false（缺省）只算不写，返回的数就是会写进去的数。
 */
export async function backfillItemCostSnapshots(
  opts: { limit?: number; apply?: boolean } = {},
  client: PrismaClient = defaultPrisma,
): Promise<CostSnapshotBackfillResult> {
  const apply = opts.apply === true;
  const result = emptyResult(!apply);
  const limit = opts.limit != null && opts.limit > 0 ? Math.floor(opts.limit) : null;

  // 游标按 id 递增翻页：算不出成本的行会一直留在候选集里，不带游标会在同一批上原地打转。
  let cursorId: string | null = null;
  for (;;) {
    const remaining = limit == null ? BATCH_SIZE : Math.min(BATCH_SIZE, limit - result.scanned);
    if (remaining <= 0) {
      result.truncated = true;
      break;
    }

    const batch = (await client.orderItem.findMany({
      where: {
        totalCostCny: null,
        kind: { in: ['FLIGHT', 'BUNDLE'] },
        // 软删除的订单不进任何统计，也就不必补它们的成本。
        order: { deletedAt: null },
      },
      orderBy: { id: 'asc' },
      take: remaining,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        kind: true,
        quantity: true,
        flightScheduleId: true,
        roomsBilled: true,
        hotelRoomType: { select: { costPriceCny: true } },
        bundle: { select: { items: true } },
        order: { select: { passengers: { select: { visaExempt: true } } } },
      },
    })) as BackfillItemRow[];

    if (batch.length === 0) break;
    cursorId = batch[batch.length - 1].id;
    result.scanned += batch.length;

    // ── 机票行：一次取齐班次 + 成本周期 ──
    const flightRows = batch.filter((r) => r.kind === 'FLIGHT');
    result.byKind.FLIGHT.scanned += flightRows.length;
    const flightSnapshots = await resolveFlightCostSnapshots(
      flightRows
        .filter((r) => r.flightScheduleId)
        .map((r) => ({ flightScheduleId: r.flightScheduleId as string, quantity: r.quantity })),
      client,
    );

    // ── 套餐行：一次取齐组件挂的签证 / 用车产品成本价 ──
    const bundleRows = batch.filter((r) => r.kind === 'BUNDLE');
    result.byKind.BUNDLE.scanned += bundleRows.length;
    const bundleComponentCosts = await loadBundleComponentCosts(
      bundleRows.map((r) => r.bundle?.items ?? null),
      client,
    );

    const writes: PendingWrite[] = [];

    for (const row of flightRows) {
      if (!row.flightScheduleId) {
        note(result, '机票行没有班次（航段已取消 / 老数据）');
        continue;
      }
      const snap = flightSnapshots.get(flightSnapshotKey(row.flightScheduleId, row.quantity));
      if (!snap) {
        note(result, '机票行绑的班次已不存在');
        continue;
      }
      if (snap.totalCostCny == null) {
        note(result, '该班次成本未录：班次自身与成本周期都是空的');
        continue;
      }
      writes.push({
        id: row.id,
        kind: 'FLIGHT',
        unitCostCny: snap.unitCostCny,
        totalCostCny: snap.totalCostCny,
      });
    }

    for (const row of bundleRows) {
      if (!row.bundle) {
        note(result, '套餐行没挂套餐产品（老数据）');
        continue;
      }
      // 办签人数 = 非自备签的乘客数，与建单口径同源（出行总人数 − 自备签人数）。
      const visaHeadCount = row.order.passengers.filter((p) => !p.visaExempt).length;
      const total = computeBundleGroundCost({
        components: row.bundle.items,
        hotelNightlyCostCny:
          row.hotelRoomType?.costPriceCny != null
            ? Number(row.hotelRoomType.costPriceCny.toString())
            : null,
        rooms: row.roomsBilled != null ? Number(row.roomsBilled.toString()) : 1,
        visaHeadCount,
        visaCostByIdCny: bundleComponentCosts.visaCostByIdCny,
        transferCostByIdCny: bundleComponentCosts.transferCostByIdCny,
      });
      if (total == null) {
        note(result, '套餐组件成本不全：住宿/签证/用车里有产品没录成本价');
        continue;
      }
      // 套餐行建单时不写 unitCostCny（整包成本没有「每件」这个口径），回填同样不写。
      writes.push({ id: row.id, kind: 'BUNDLE', unitCostCny: null, totalCostCny: total });
    }

    result.filled += writes.length;
    result.byKind.FLIGHT.filled += writes.filter((w) => w.kind === 'FLIGHT').length;
    result.byKind.BUNDLE.filled += writes.filter((w) => w.kind === 'BUNDLE').length;

    if (apply && writes.length > 0) {
      await client.$transaction(
        writes.map((w) =>
          // updateMany 而不是 update：where 里要能夹 `totalCostCny: null`（幂等的最后一道保险，
          // 并发下别的流程刚填过这行时本次落空，绝不覆盖）。update 的 where 只吃唯一键。
          client.orderItem.updateMany({
            where: { id: w.id, totalCostCny: null },
            data: {
              ...(w.unitCostCny != null
                ? { unitCostCny: new Prisma.Decimal(w.unitCostCny) }
                : {}),
              totalCostCny: new Prisma.Decimal(w.totalCostCny),
            },
          }),
        ),
      );
    }
  }

  return result;
}
