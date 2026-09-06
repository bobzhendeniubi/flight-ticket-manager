/**
 * 订单行成本快照 —— FLIGHT / BUNDLE 两类行的成本落库口径。
 *
 * ## 为什么要快照
 * 房 / 签 / 车三类行建单时就把成本写进 `OrderItem.totalCostCny`（见 service/create.ts），
 * 机票行与套餐行此前恒 NULL。而经营报表与财务概览的毛利口径是
 * 「桶里有任何一行缺成本 → 毛利报未知」——只要单子里有机票，毛利就永远是「—」。
 * 把下单时**算得出来**的成本落成快照，这两处才有数可看。
 *
 * ## 口径（不改成本算法，只是把结果落库）
 * - 机票行：`finances.cost.service.resolveFlightItemCost` 是唯一算法（override → 周期 → null），
 *   本模块只负责批量取班次 + 周期喂给它，一个数都不自己算。
 * - 套餐行：按 `Bundle.items` 的**组件**逐条求和，与售价侧 `computeBundleGroundTotal` 同构
 *   （HOTEL 按 晚数×每晚成本×房数、VISA 按 办签人数×每人成本、其余按 qty×成本）。
 *   套餐里的机票分量**不算在套餐行上**——同一张单里机票是独立的 FLIGHT 行（带 bundleId），
 *   成本已由上一条落在那些行上，套餐行再加一遍就是双计。
 *   绝不用「机票款 = 全包价 − 地面价」这类残差拆分（口径决议已否决：只做展示报表、不驱动定价，
 *   更不该驱动成本）。
 * - 任一组件的成本取不到（产品没录成本 / 班次与周期都没填）→ 整行留 NULL。
 *   半个成本比没有成本更坏：报表会拿部分成本算出一个虚高又精确的毛利。NULL 才会如实进
 *   missingCostItemCount，页面照旧显示「未知」。
 *
 * ## 快照语义
 * 落库之后**不追溯**：事后改成本周期 / 改产品成本价，历史订单行的快照原地不动
 * （与房 / 签 / 车完全一致）。财务概览另有一份按当前周期实时重算的成本细分
 * （finances.service 的 costBreakdown），两份数各有各的用途，页面上分别标了「快照 / 实时」。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../../db/prisma.js';
import {
  loadPeriodsByFlightIds,
  resolveFlightItemCost,
  type PeriodInputs,
} from '../../finances/finances.cost.service.js';

/** 本模块只用读操作，事务内外都能跑（建单在事务外算、改期在事务内算）。 */
type CostClient = PrismaClient | Prisma.TransactionClient;

/** `resolveFlightItemCost` 需要的班次形状（Prisma select 出来的最小集合）。 */
export const FLIGHT_COST_SCHEDULE_SELECT = {
  id: true,
  flightId: true,
  departureTime: true,
  departureTz: true,
  costLocked: true,
  charterCostCny: true,
  airportTaxDepCny: true,
  airportTaxArrCny: true,
  fuelCostCny: true,
  peakSurchargeCny: true,
  aircraftAdjustCny: true,
  takeoffDiscountCny: true,
  seatClasses: { select: { capacity: true } },
} as const;

interface FlightCostSchedule {
  id: string;
  flightId: string;
  departureTime: Date;
  departureTz: string;
  costLocked: boolean;
  charterCostCny: Prisma.Decimal | null;
  airportTaxDepCny: Prisma.Decimal | null;
  airportTaxArrCny: Prisma.Decimal | null;
  fuelCostCny: Prisma.Decimal | null;
  peakSurchargeCny: Prisma.Decimal | null;
  aircraftAdjustCny: Prisma.Decimal | null;
  takeoffDiscountCny: Prisma.Decimal | null;
  seatClasses: Array<{ capacity: number }>;
}

/** 一行机票的成本快照结果：`totalCostCny` 为 null = 这条算不出成本（缺成本口径）。 */
export interface FlightCostSnapshot {
  unitCostCny: number | null;
  totalCostCny: number | null;
}

const NO_COST: FlightCostSnapshot = { unitCostCny: null, totalCostCny: null };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function snapshotOf(
  schedule: FlightCostSchedule,
  periods: PeriodInputs[],
  quantity: number,
): FlightCostSnapshot {
  const total = resolveFlightItemCost(schedule, periods, quantity);
  if (total == null) return NO_COST;
  // unitCostCny = 每座成本，由总额反推 —— 保证 total = unit × quantity 的口径与房/签/车一致。
  return { unitCostCny: quantity > 0 ? round2(total / quantity) : null, totalCostCny: total };
}

/** `resolveFlightCostSnapshots` 返回 Map 的键：班次 + 人数（同班次不同人数的腿不能互相覆盖）。 */
export function flightSnapshotKey(flightScheduleId: string, quantity: number): string {
  return `${flightScheduleId}#${quantity}`;
}

/**
 * 批量算多条机票行的成本快照。
 *
 * 一次取齐班次 + 周期（两条查询，与行数无关），避免建单时逐行打库。
 * 班次查不到（脏 id）→ 该行不出现在返回的 Map 里，调用方按缺成本处理。
 */
export async function resolveFlightCostSnapshots(
  rows: ReadonlyArray<{ flightScheduleId: string; quantity: number }>,
  client: CostClient = defaultPrisma,
): Promise<Map<string, FlightCostSnapshot>> {
  const scheduleIds = Array.from(new Set(rows.map((r) => r.flightScheduleId)));
  if (scheduleIds.length === 0) return new Map();

  const schedules = (await client.flightSchedule.findMany({
    where: { id: { in: scheduleIds } },
    select: FLIGHT_COST_SCHEDULE_SELECT,
  })) as FlightCostSchedule[];
  if (schedules.length === 0) return new Map();

  const periodsMap = await loadPeriodsByFlightIds(
    Array.from(new Set(schedules.map((s) => s.flightId))),
    client as PrismaClient,
  );

  const byScheduleId = new Map(schedules.map((s) => [s.id, s]));
  const out = new Map<string, FlightCostSnapshot>();
  for (const row of rows) {
    const schedule = byScheduleId.get(row.flightScheduleId);
    if (!schedule) continue;
    out.set(
      flightSnapshotKey(row.flightScheduleId, row.quantity),
      snapshotOf(schedule, periodsMap.get(schedule.flightId) ?? [], row.quantity),
    );
  }
  return out;
}

/** 单条机票行的成本快照（改期换班次后重算用；批量场景请走 resolveFlightCostSnapshots）。 */
export async function resolveOneFlightCostSnapshot(
  flightScheduleId: string,
  quantity: number,
  client: CostClient = defaultPrisma,
): Promise<FlightCostSnapshot> {
  const map = await resolveFlightCostSnapshots([{ flightScheduleId, quantity }], client);
  return map.get(flightSnapshotKey(flightScheduleId, quantity)) ?? NO_COST;
}

// ── 套餐行（地面组件求和）────────────────────────────────────────────────────

/** 套餐地面成本求和需要的各组件成本价（缺 = 该组件成本未知）。 */
export interface BundleGroundCostInputs {
  /** Bundle.items（JSON）；非数组按空处理，绝不因脏数据抛错（与售价侧同口径）。 */
  components: unknown;
  /** 每间每晚成本（指定酒店优先，其次套餐绑定房型）；产品未录成本 = null。 */
  hotelNightlyCostCny: number | null;
  /** 计费房间数（支持 0.5 间），与售价侧 computeBundleGroundTotal 同一个 rooms。 */
  rooms: number;
  /** 办签人数 = 出行总人数 − 自备签人数，与售价侧同一个数。 */
  visaHeadCount: number;
  /** visaId → 每人送签成本（不含加急，与单独 VISA 行口径一致）；未录成本的产品不进这张表。 */
  visaCostByIdCny: ReadonlyMap<string, number>;
  /** transferId → 每份成本；未录成本的产品不进这张表。 */
  transferCostByIdCny: ReadonlyMap<string, number>;
}

/**
 * 套餐行的地面成本合计（不含机票分量——那是同单里独立 FLIGHT 行的事，见文件头口径）。
 *
 * 返回 null = 有组件的成本取不到（产品没录成本 / 组件没挂产品 id），整行按缺成本处理。
 * FLIGHT 组件一律跳过：它在 items 里只有描述、unitPrice 恒 0，成本落在 FLIGHT 行上。
 */
export function computeBundleGroundCost(input: BundleGroundCostInputs): number | null {
  const components = Array.isArray(input.components)
    ? (input.components as Array<{
        kind?: string;
        qty?: unknown;
        visaId?: unknown;
        transferId?: unknown;
      }>)
    : [];

  let total = 0;
  for (const c of components) {
    if (!c || typeof c.kind !== 'string' || c.kind === 'FLIGHT') continue;
    const qty = Number(c.qty) || 0;

    if (c.kind === 'HOTEL') {
      // 售价侧：qty(晚数) × 每晚价 × rooms。成本同构，只是把价换成成本。
      if (input.hotelNightlyCostCny == null) return null;
      total += qty * input.hotelNightlyCostCny * input.rooms;
      continue;
    }
    if (c.kind === 'VISA') {
      // 售价侧：办签人数 × 每人价（模板 qty 不参与）。成本同口径按人。
      const visaId = typeof c.visaId === 'string' ? c.visaId : null;
      const unit = visaId ? input.visaCostByIdCny.get(visaId) : undefined;
      if (unit == null) return null;
      total += input.visaHeadCount * unit;
      continue;
    }
    if (c.kind === 'TRANSFER') {
      const transferId = typeof c.transferId === 'string' ? c.transferId : null;
      const unit = transferId ? input.transferCostByIdCny.get(transferId) : undefined;
      if (unit == null) return null;
      total += qty * unit;
      continue;
    }
    // 认不出的组件类型（未来新增品类）：成本未知，整行按缺成本处理，绝不静默当 0。
    return null;
  }

  return Math.max(0, Math.round(total));
}

/** 一次取齐套餐组件挂的签证 / 接送产品成本价（未录成本的产品不进表）。 */
export async function loadBundleComponentCosts(
  componentsList: ReadonlyArray<unknown>,
  client: CostClient = defaultPrisma,
): Promise<{
  visaCostByIdCny: Map<string, number>;
  transferCostByIdCny: Map<string, number>;
}> {
  const visaIds = new Set<string>();
  const transferIds = new Set<string>();
  for (const components of componentsList) {
    if (!Array.isArray(components)) continue;
    for (const c of components as Array<{ kind?: string; visaId?: unknown; transferId?: unknown }>) {
      if (!c) continue;
      if (c.kind === 'VISA' && typeof c.visaId === 'string') visaIds.add(c.visaId);
      if (c.kind === 'TRANSFER' && typeof c.transferId === 'string') transferIds.add(c.transferId);
    }
  }

  const [visas, transfers] = await Promise.all([
    visaIds.size > 0
      ? client.visa.findMany({
          where: { id: { in: [...visaIds] } },
          select: { id: true, costPriceCny: true },
        })
      : Promise.resolve([]),
    transferIds.size > 0
      ? client.transfer.findMany({
          where: { id: { in: [...transferIds] } },
          select: { id: true, costPriceCny: true },
        })
      : Promise.resolve([]),
  ]);

  const visaCostByIdCny = new Map<string, number>();
  for (const v of visas) {
    if (v.costPriceCny != null) visaCostByIdCny.set(v.id, Number(v.costPriceCny.toString()));
  }
  const transferCostByIdCny = new Map<string, number>();
  for (const t of transfers) {
    if (t.costPriceCny != null) transferCostByIdCny.set(t.id, Number(t.costPriceCny.toString()));
  }
  return { visaCostByIdCny, transferCostByIdCny };
}

/**
 * 套餐组件里的住宿晚数合计（HOTEL 组件的 qty 之和；没有 HOTEL 组件 = 0）。
 *
 * 与 `computeBundleGroundCost` 的 HOTEL 分支同一个 qty —— 换酒店时要按这个晚数把旧店成本
 * 减出来、新店成本加回去，取别处的晚数（比如盖章区间的日历天数）会与建单时那一项对不上。
 */
export function bundleHotelNightsOf(components: unknown): number {
  if (!Array.isArray(components)) return 0;
  return (components as Array<{ kind?: string; qty?: unknown }>).reduce(
    (sum, c) => (c && c.kind === 'HOTEL' ? sum + (Number(c.qty) || 0) : sum),
    0,
  );
}

/**
 * 换酒店后 BUNDLE 行的成本快照（只调整住宿那一项，其余组件原样不动）。
 *
 * 套餐行的快照是整包地面成本（住宿 + 签证 + 用车），换酒店只换了住宿那一项，所以按**差额**
 * 挪：`before + (新每晚成本 − 旧每晚成本) × 晚数 × 房数`。整包重算做不到 —— 换酒店流程手上
 * 没有办签人数等建单时的口径参数，硬算会把另外几项算错。
 *
 * 三种「算不出来」一律返回 null（= 该行成本未知），绝不留一个换店前的旧数字装作还准：
 *   · before 为 null（建单时就没算出整包成本）—— 差额没有基数可加；
 *   · 新房型没录成本价 —— 换完之后是真不知道；
 *   · 旧房型没录成本价 / 晚数为 0 —— 减不出旧店那一项，差额无从谈起。
 */
export function computeSwapBundleCostSnapshot(input: {
  /** 换店前的整包地面成本快照（OrderItem.totalCostCny）。 */
  beforeTotalCostCny: number | null;
  oldCostPriceCny: number | null;
  newCostPriceCny: number | null;
  /** 套餐 HOTEL 组件的晚数合计（见 bundleHotelNightsOf）。 */
  nights: number;
  /** 计费房数（roomsBilled，支持 0.5 间）。 */
  rooms: number;
}): number | null {
  const { beforeTotalCostCny, oldCostPriceCny, newCostPriceCny, nights, rooms } = input;
  if (beforeTotalCostCny == null) return null;
  if (newCostPriceCny == null || oldCostPriceCny == null) return null;
  if (nights <= 0 || rooms <= 0) return null;
  const delta = (newCostPriceCny - oldCostPriceCny) * nights * rooms;
  return Math.max(0, Math.round(beforeTotalCostCny + delta));
}
