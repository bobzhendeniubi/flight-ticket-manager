/**
 * 财务聚合服务 — ADMIN-only 业务财务核心计算
 *
 * 数据来源：
 *   - 收入：Order.total + OrderItem.amount（按 kind 分类）
 *   - 成本：OrderItem.totalCostCny（下单时锁定的成本快照）
 *   - 包机沉没成本：FlightSchedule.charterCostCny 与已售座位比对
 *
 * 关键概念：
 *   - 单座分摊成本 = charterCostCny / Σ(seatClasses[].capacity)
 *   - 已售座位成本 = soldSeats × 单座分摊成本
 *   - 空座沉没成本 = (totalSeats - soldSeats) × 单座分摊成本
 *   - 整航班毛利 = revenue - charterCostCny（整包机视角）
 *   - 仅已售部分毛利 = revenue - 已售座位成本（忽略空座）
 *
 * 老数据（cost 字段为 NULL）会被自动跳过统计，并在响应里标 missingCostItemCount。
 *
 * REFUNDED 订单：不计入按 OrderItem 展开的分品类收入/成本（COUNTED_STATUSES 里明确排除），
 * 但会按订单级"已收-已退净额"（paidAmount − 已完成退款）补一笔负项到
 * revenueBreakdown.refund / revenueCny，避免"先收后退"的订单整单从统计消失、长期对不平。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  findMatchedPeriod,
  loadPeriodsByFlightIds,
  resolveFlightItemCost,
  resolveScheduleCost,
} from './finances.cost.service.js';

export interface DateRange {
  /** ISO date 'YYYY-MM-DD'，包含 */
  from: string;
  /** ISO date 'YYYY-MM-DD'，包含 */
  to: string;
}

export interface CategoryBreakdown {
  kind: string;
  revenueCny: number;
  costCny: number;
  grossMarginCny: number;
  marginPct: number | null; // null = revenue 为 0
  orderItemCount: number;
}

/** 收入细分（财务口径；机场税收入按 pass-through = 对应 leg 机场税成本；refund 见下） */
export interface RevenueBreakdown {
  outboundFlight: number;     // 去程机票收入
  returnFlight: number;       // 返程机票收入
  outboundTax: number;        // 去程机场税收入（pass-through）
  returnTax: number;          // 返程机场税收入（pass-through）
  hotel: number;              // 房收入
  visa: number;               // 签证收入
  transfer: number;           // 车收入
  guide: number;              // 导游收入
  upgradeChange: number;      // 升舱+改期收入
  oversale: number;           // 超售收入
  uncategorized: number;      // 上面没归类的（FEE/DISCOUNT/INSURANCE/BUNDLE 等）
  /**
   * REFUNDED 订单的已收-已退净额，按订单一次性计入（该订单 createdAt 落在本区间内即计）。
   * = Σ(paidAmount − 已完成退款金额)，逐单累加。
   * 通常 ≥ 0（全额退款 = 0；退款时扣手续费/违约金留存 = 正数）；若出现负数，说明退款
   * 金额超过实收，属数据异常，建议核查（这里不做 clamp，保留真实数值便于发现问题）。
   * 修复点：REFUNDED 不在 COUNTED_STATUSES 里，之前这类订单的收入会整单从统计消失，
   * 导致 revenue 与实收长期对不平；现在按订单级净额补一笔，而不是让它蒸发。
   * 注意：这笔净额不参与上面的分品类明细（不逐 OrderItem 展开），也不计入 costCny/
   * costBreakdown（成本快照口径不变）——刻意的最小侵入取舍，避免打乱现有分品类成本结构。
   */
  refund: number;
  total: number;              // 总和
}

/** 成本细分（财务口径，15 项） */
export interface CostBreakdown {
  outboundCharter: number;    // 去程包机分摊（charter ÷ 总座 × paxCount）
  returnCharter: number;      // 返程包机分摊
  outboundTax: number;        // 去程机场税成本
  returnTax: number;          // 返程机场税成本
  peakSurcharge: number;      // 旺季附加（各 leg × paxCount）
  fuel: number;               // 燃油
  aircraftAdjust: number;     // 机型调整
  takeoffDiscount: number;    // 起降折扣（可负）
  hotel: number;              // 房费
  visa: number;               // 签证费
  transfer: number;           // 车费
  guideService: number;       // 导游服务费（OrderCostItem.GUIDE_SERVICE）
  compGift: number;           // 赠送费用
  handlingFee: number;        // 手续费（收款/汇款结算）
  operationFee: number;       // 操作费（OrderCostItem.OPERATION_FEE，每单固定计提）
  other: number;              // 其他
  total: number;              // 总和
}

export interface FinancesSummary {
  range: DateRange;
  /**
   * 总收入口径 = 已下单收入（OrderItem.amount，未扣税费；含 PENDING_PAYMENT，即"预期/已下单
   * 收入"口径，不是"已收款"口径——是否需要另开"只算实收"口径待确认，不擅自改，
   * 见 COUNTED_STATUSES 上方注释）+ REFUNDED 订单的已收-已退净额（revenueBreakdown.refund，
   * 避免"先收后退"的订单整单从收入消失）。
   * 与 costCny 的口径不对称：costCny 不含 REFUNDED 订单的成本快照（保持现有分品类成本
   * 结构不变，是刻意的最小侵入取舍）。
   */
  revenueCny: number;
  /** 已锁定成本总额 */
  costCny: number;
  /** revenue - cost；不包含空座沉没成本。
   *  A5（2026-07-17 收口）：missingCostItemCount>0 时为 null（「未知」）——
   *  与月度趋势同口径。此前概览把缺成本项跳过后照报数字毛利，同一页两种诚实度：
   *  月度说「未知」、首页 KPI 给一个虚高的精确数。缺成本的毛利就是未知，不装知道。 */
  grossMarginCny: number | null;
  /** grossMargin / revenue（毛利未知时同为 null） */
  marginPct: number | null;
  /** 含已售/未售座位推算的"应负担"包机沉没成本（仅 charterCostCny 已填的航班） */
  emptySeatSunkCostCny: number;
  /** 航班贡献毛利（财务定名，原"净利"）= grossMargin - emptySeatSunkCost；毛利未知时为 null */
  netMarginCny: number | null;
  /** 该区间内的订单数（不含 DRAFT / CANCELLED）；不含 REFUNDED（REFUNDED 订单只贡献
   *  revenueBreakdown.refund 这一笔净额，不计入这里的订单数） */
  orderCount: number;
  /** 该区间内 OrderItem 没填 cost 的条目数（用于提醒补录） */
  missingCostItemCount: number;
  /** 旧 UI 兼容：按 OrderItem.kind 粗分——不含 REFUNDED 订单的已收-已退净额（那笔净额只在
   *  revenueBreakdown.refund 里），故这里各行相加可能与 revenueCny 略有差异，是预期行为 */
  categories: CategoryBreakdown[];
  /** 新：按财务口径细分 */
  revenueBreakdown: RevenueBreakdown;
  costBreakdown: CostBreakdown;
}

export interface FlightPnlRow {
  scheduleId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departureTime: string; // ISO
  charterCostCny: number | null;
  totalSeats: number;
  soldSeats: number;
  loadPct: number; // 0..1
  revenueCny: number;
  /** 已售部分应分摊成本 = soldSeats × perSeatCost */
  soldSeatAllocCostCny: number | null;
  /** 财务口径：空座成本 = (totalSeats - soldSeats) × 单座成本 */
  emptySeatCostCny: number | null;
  /** 整包机航班贡献毛利（财务定名，原"净利"）= revenue - charterCost */
  netMarginCny: number | null;
  /** 已售部分毛利 = revenue - 已售分摊成本 */
  grossOnSoldCny: number | null;
  /** 财务口径：包机费 ÷ 全部座位；包机费缺失或总座位为 0 时 null */
  perSeatCostCny: number | null;
}

export interface OrderPnlRow {
  orderId: string;
  orderNumber: string;
  status: string;
  contactName: string;
  createdAt: string; // ISO
  totalCny: number; // Order.total
  costCny: number | null; // FLIGHT 按班次实时成本，其余为快照；NULL = 有条目缺失
  grossMarginCny: number | null;
  marginPct: number | null;
  itemCount: number;
  /** 有几条 OrderItem 没填成本 */
  missingCostItemCount: number;
}

/** 订单毛利明细 · 收入构成一行（逐 OrderItem，含调价行 FEE/DISCOUNT） */
export interface OrderPnlDetailIncomeRow {
  label: string;      // OrderItem.description（调价行本身已是可读文案）
  kind: string;       // OrderItemKind
  quantity: number;
  unitPriceCny: number;
  subtotalCny: number; // = OrderItem.amount
  /** 价格调整行（metadata.priceAdjustment=true，kind=FEE/DISCOUNT） */
  isAdjustment: boolean;
}

/** 订单毛利明细 · 成本构成一行（非机票为快照，机票为班次实时成本） */
export interface OrderPnlDetailCostRow {
  label: string;
  kind: string;
  quantity: number;
  /** 非机票为 OrderItem.totalCostCny 快照；机票为班次实时成本；null = 缺成本 */
  totalCostCny: number | null;
  /** FLIGHT 行成本来自班次实时口径 */
  isRealtime: boolean;
}

/** 订单毛利明细 · 杂项成本一行（逐 OrderCostItem） */
export interface OrderPnlDetailMiscRow {
  label: string;    // 类目中文名
  category: string; // OrderCostCategory
  amountCny: number;
  note: string | null;
}

/**
 * 单订单收支明细（下钻）。收入逐 OrderItem，FLIGHT 成本按班次实时计算，其他成本逐
 * OrderItem.totalCostCny 快照（与 getOrderPnl 同口径：缺任一件成本 → itemCostCny=null「未知」，
 * 不造 0）。另把订单杂项成本 OrderCostItem 逐条列出。
 *
 * 口径分层（刻意不合并，避免与「订单毛利」列表/导出对不上）：
 *   grossMarginCny         = totalCny − itemCostCny —— 与订单毛利 tab 行/按订单导出 **严格一致**（不含杂项）
 *   grossMarginWithMiscCny = totalCny − (itemCostCny + miscCostCny) —— 参考：把订单杂项成本也算进去的完整毛利
 */
export interface OrderPnlDetail {
  orderId: string;
  orderNumber: string;
  status: string;
  contactName: string;
  agentName: string | null;
  /** 最早航段出发日期 'YYYY-MM-DD'；无航段则 null */
  departureDate: string | null;
  createdAt: string; // ISO
  income: {
    rows: OrderPnlDetailIncomeRow[];
    /** Σ 各行小计（= Σ OrderItem.amount，可能与 totalCny 略有差异，属既有口径） */
    itemsSumCny: number;
    /** = Order.total（getOrderPnl 权威收入口径） */
    totalCny: number;
  };
  cost: {
    itemRows: OrderPnlDetailCostRow[];
    miscRows: OrderPnlDetailMiscRow[];
    /** Σ 订单项成本（FLIGHT 实时、其他快照）；缺任一件 → null（getOrderPnl 口径） */
    itemCostCny: number | null;
    /** Σ OrderCostItem.amountCny */
    miscCostCny: number;
    /** itemCostCny==null ? null : itemCostCny + miscCostCny */
    totalWithMiscCny: number | null;
    missingCostItemCount: number;
  };
  /** = totalCny − itemCostCny；缺成本 → null。与订单毛利 tab 行严格一致（不含杂项） */
  grossMarginCny: number | null;
  marginPct: number | null;
  /** = totalCny − (itemCostCny + miscCostCny)；缺成本 → null。含杂项的完整毛利（参考） */
  grossMarginWithMiscCny: number | null;
}

const ORDER_COST_CATEGORY_LABEL: Record<string, string> = {
  GUIDE_SERVICE: '导游服务费',
  COMP_GIFT: '赠送费用',
  HANDLING_FEE: '手续费',
  OPERATION_FEE: '操作费',
  OTHER: '其他',
};

export interface MonthlyPoint {
  /** 'YYYY-MM' */
  month: string;
  revenueCny: number;
  costCny: number;
  /**
   * 毛利 = 收入 − 成本；缺任一件成本 → null（「未知」，非 0）。与 orderPnl 同口径：
   * 把缺成本当 0 会让毛利系统性虚高，一旦被信任上报就收不回；空毛利补了成本即恢复。
   * 成本快照上线前的历史月份多为 null，属预期。
   */
  grossMarginCny: number | null;
  /** 本月缺成本快照的订单项数（>0 时毛利为 null，供 UI 标「未知」）。 */
  missingCostItemCount: number;
  orderCount: number;
}

// 计入营收的订单状态：排除 DRAFT/CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED
//
// 口径待确认（不擅自改，标注）：这里含 PENDING_PAYMENT——未付款的订单也计入 revenueCny。
// 这大概率是有意的"预期/已下单收入"口径（下单即算，不等实际到账），而非"已收款"口径。
// 如果财务需要的是"只算实收"，需要另开一个单独的实收统计，不应直接从这个口径改，
// 否则会跟当前依赖它的报表/导出产生连锁变化。
//
// REFUNDED 不在这个列表里（明确排除，不是遗漏）：REFUNDED 订单不走下面按 OrderItem 展开
// 的分品类逻辑，而是在 getFinancesSummary 里单独查询、按订单级"已收-已退净额"补一笔负项
// 到 revenueBreakdown.refund（见该字段注释）——避免"先收后退"的订单整单从统计消失。
const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

function toDateOnlyUtc(s: string, endOfDay = false): Date {
  // 'YYYY-MM-DD' → UTC midnight (or 23:59:59.999)
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) throw new Error(`invalid date: ${s}`);
  return new Date(
    Date.UTC(
      y,
      m - 1,
      d,
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0,
    ),
  );
}

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Prisma.Decimal | number | null → number | null（保留 null 与 dec() 区分：dec 把 null 折 0） */
function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

/**
 * 单条签证 OrderItem 的成本（CNY）取值口径 —— 财务汇总（finances.service）与核对导出
 * （finances.export）共用同一函数，两处口径逐字一致。优先级：
 *   1) 该签证任务填了结构化人均成本 visaUnitCostCny → visaUnitCostCny × 需签乘客数
 *      （新口径：签证公司按航班开的实际按单成本，团价/加急价按单不同）
 *   2) 未填 → 回退录单成本快照 totalCostCny（若有；导出侧无快照则传 null 跳过）
 *   3) 再回退 → 签证产品主数据 costPriceCny × quantity（现行口径）
 *   均无 → 0（缺成本，由调用方另行计数，不在此静默吞掉）
 * 回退链完整保留，避免把"未填结构化成本"的存量单误算成 0。
 */
export function visaItemCostCny(input: {
  taskUnitCostCny: number | null;
  visaPax: number;
  snapshotCny: number | null;
  productCostPriceCny: number | null;
  quantity: number;
}): { cost: number; source: 'TASK' | 'SNAPSHOT' | 'PRODUCT' | 'NONE' } {
  if (input.taskUnitCostCny != null) {
    return { cost: input.taskUnitCostCny * input.visaPax, source: 'TASK' };
  }
  if (input.snapshotCny != null) return { cost: input.snapshotCny, source: 'SNAPSHOT' };
  if (input.productCostPriceCny != null) {
    return { cost: input.productCostPriceCny * input.quantity, source: 'PRODUCT' };
  }
  return { cost: 0, source: 'NONE' };
}

/** 计算财务概览（KPI + 按 OrderItem.kind 粗分 + 按财务口径细分） */
export async function getFinancesSummary(
  range: DateRange,
  client: PrismaClient = defaultPrisma,
): Promise<FinancesSummary> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  // ── 1) 拉订单 + items（含 flightSchedule 全成本字段、产品成本、座位）+ passengers 数 + costItems ──
  const orders = await client.order.findMany({
    where: { deletedAt: null, createdAt: { gte: from, lte: to }, status: { in: COUNTED_STATUSES } },
    select: {
      id: true,
      total: true,
      // 需签乘客数（非自备签）用于签证实际成本人均折算；paxCount 仍用全体乘客数
      passengers: { select: { id: true, visaExempt: true } },
      costItems: { select: { category: true, amountCny: true } },
      items: {
        select: {
          kind: true,
          amount: true,
          quantity: true,
          totalCostCny: true,
          hotelCheckIn: true,
          hotelCheckOut: true,
          flightSchedule: {
            select: {
              flightId: true,
              departureTime: true,
              departureTz: true,
              charterCostCny: true,
              airportTaxDepCny: true,
              airportTaxArrCny: true,
              fuelCostCny: true,
              peakSurchargeCny: true,
              aircraftAdjustCny: true,
              takeoffDiscountCny: true,
              seatClasses: { select: { capacity: true } },
            },
          },
          hotelRoomType: { select: { costPriceCny: true } },
          visa: { select: { costPriceCny: true } },
          transfer: { select: { costPriceCny: true } },
          // 签证任务的结构化实际成本（人均 CNY）；每个 VISA item 对应一条 VISA_APPLICATION 任务
          fulfillmentTasks: {
            where: { type: 'VISA_APPLICATION' },
            select: { visaUnitCostCny: true },
          },
        },
      },
    },
  });

  // ── 2) 批量拉相关航班的成本周期（用于 resolution） ──
  const flightIds = Array.from(
    new Set(
      orders.flatMap((o) => o.items.flatMap((i) => (i.flightSchedule ? [i.flightSchedule.flightId] : []))),
    ),
  );
  const periodsMap = await loadPeriodsByFlightIds(flightIds, client);

  // ── 3) 聚合 ──
  const categoryMap = new Map<string, CategoryBreakdown>();
  const rev: RevenueBreakdown = {
    outboundFlight: 0, returnFlight: 0, outboundTax: 0, returnTax: 0,
    hotel: 0, visa: 0, transfer: 0, guide: 0, upgradeChange: 0, oversale: 0,
    uncategorized: 0, refund: 0, total: 0,
  };
  const cost: CostBreakdown = {
    outboundCharter: 0, returnCharter: 0, outboundTax: 0, returnTax: 0,
    peakSurcharge: 0, fuel: 0, aircraftAdjust: 0, takeoffDiscount: 0,
    hotel: 0, visa: 0, transfer: 0,
    guideService: 0, compGift: 0, handlingFee: 0, operationFee: 0, other: 0, total: 0,
  };
  let revenueCny = 0;
  let costCny = 0;
  let missingCostItemCount = 0;

  for (const o of orders) {
    const paxCount = Math.max(1, o.passengers.length);
    // 需签乘客数（非自备签）—— 签证实际成本按此人均折算
    const visaPax = o.passengers.filter((p) => !p.visaExempt).length;

    // 旧粗粒度 categoryMap（兼容老 UI）+ 总收入/成本
    for (const item of o.items) {
      const amt = dec(item.amount);
      const c = item.totalCostCny == null ? null : dec(item.totalCostCny);
      revenueCny += amt;
      if (c != null) costCny += c;
      else missingCostItemCount += 1;

      const key = item.kind;
      const cur = categoryMap.get(key) ?? {
        kind: key, revenueCny: 0, costCny: 0, grossMarginCny: 0,
        marginPct: null, orderItemCount: 0,
      } as CategoryBreakdown;
      cur.revenueCny += amt;
      if (c != null) cur.costCny += c;
      cur.orderItemCount += 1;
      categoryMap.set(key, cur);
    }

    // 新细分（财务口径）
    // FLIGHT items: 按 departureTime 排序，第一段=去程，其余=返程
    const flightItems = o.items
      .filter((i) => i.kind === 'FLIGHT' && i.flightSchedule != null)
      .sort((a, b) =>
        a.flightSchedule!.departureTime.getTime() - b.flightSchedule!.departureTime.getTime(),
      );
    flightItems.forEach((it, idx) => {
      const sched = it.flightSchedule!;
      const isOutbound = idx === 0;
      const matched = findMatchedPeriod(sched, periodsMap.get(sched.flightId) ?? []);
      const eff = resolveScheduleCost(sched, matched);
      const totalSeats = sched.seatClasses.reduce((a, c) => a + c.capacity, 0);
      // 包机分摊（per pax）= charter ÷ 总座
      const perSeatCharter = eff.charterCostCny != null && totalSeats > 0
        ? eff.charterCostCny / totalSeats : 0;
      const taxDep = eff.airportTaxDepCny ?? 0;
      const taxArr = eff.airportTaxArrCny ?? 0;
      const fuel = eff.fuelCostCny ?? 0;
      const peak = eff.peakSurchargeCny ?? 0;
      const adj = eff.aircraftAdjustCny ?? 0;
      const disc = eff.takeoffDiscountCny ?? 0;

      // 该 leg 总成本各项 × paxCount
      const charterCost = perSeatCharter * paxCount;
      const taxCost = (taxDep + taxArr) * paxCount;
      if (isOutbound) {
        cost.outboundCharter += charterCost;
        cost.outboundTax += taxCost;
      } else {
        cost.returnCharter += charterCost;
        cost.returnTax += taxCost;
      }
      cost.peakSurcharge += peak * paxCount;
      cost.fuel += fuel * paxCount;
      cost.aircraftAdjust += adj * paxCount;
      cost.takeoffDiscount += disc * paxCount;

      // 收入：FLIGHT amount 按 leg 分（去程 / 返程）。机场税已含在票价 amt 里（无单独向客人收税的行），
      // 故把税从票款里"拆出来单列"，而非在 amt 之外再加一遍——否则 rev.total 会比顶部 KPI(revenueCny)
      // 恒多出机场税总额（细分合计对不上总收入）。拆分后 outboundFlight + outboundTax == amt。
      const amt = dec(it.amount);
      const taxRev = Math.min(taxCost, amt); // 税不应超过票价本身（异常配置兜底）
      if (isOutbound) {
        rev.outboundFlight += amt - taxRev;
        rev.outboundTax += taxRev;
      } else {
        rev.returnFlight += amt - taxRev;
        rev.returnTax += taxRev;
      }
    });

    // 非 FLIGHT items：按 kind 分到 hotel/visa/transfer/guide/upgradeChange/oversale/uncategorized
    for (const it of o.items) {
      if (it.kind === 'FLIGHT') continue;
      const amt = dec(it.amount);
      const cSnap = it.totalCostCny == null ? null : dec(it.totalCostCny);
      switch (it.kind) {
        case 'HOTEL': {
          rev.hotel += amt;
          // 优先用 snapshot；否则按 costPriceCny × nights × quantity 算
          if (cSnap != null) cost.hotel += cSnap;
          else if (it.hotelRoomType?.costPriceCny != null) {
            const perNight = dec(it.hotelRoomType.costPriceCny);
            let nights = 1;
            if (it.hotelCheckIn && it.hotelCheckOut) {
              nights = Math.max(1, Math.round(
                (it.hotelCheckOut.getTime() - it.hotelCheckIn.getTime()) / (1000 * 60 * 60 * 24),
              ));
            }
            cost.hotel += perNight * nights * it.quantity;
          }
          break;
        }
        case 'VISA': {
          rev.visa += amt;
          // 签证成本口径（与 finances.export 共用 visaItemCostCny）：
          // 任务结构化人均成本优先 → 录单快照 → 产品主数据；均无则 0（缺成本）。
          const taskCny = decOrNull(it.fulfillmentTasks?.[0]?.visaUnitCostCny);
          const { cost: visaCost } = visaItemCostCny({
            taskUnitCostCny: taskCny,
            visaPax,
            snapshotCny: cSnap,
            productCostPriceCny: it.visa?.costPriceCny != null ? dec(it.visa.costPriceCny) : null,
            quantity: it.quantity,
          });
          cost.visa += visaCost;
          break;
        }
        case 'TRANSFER': {
          rev.transfer += amt;
          if (cSnap != null) cost.transfer += cSnap;
          else if (it.transfer?.costPriceCny != null) cost.transfer += dec(it.transfer.costPriceCny) * it.quantity;
          break;
        }
        case 'GUIDE':
          rev.guide += amt;
          if (cSnap != null) cost.other += cSnap;
          break;
        case 'UPGRADE_CHANGE':
          rev.upgradeChange += amt;
          if (cSnap != null) cost.other += cSnap;
          break;
        case 'OVERSALE':
          rev.oversale += amt;
          if (cSnap != null) cost.other += cSnap;
          break;
        default:
          // BUNDLE / INSURANCE / FEE / DISCOUNT
          rev.uncategorized += amt;
          if (cSnap != null) cost.other += cSnap;
      }
    }

    // OrderCostItem 按 category 拆分
    for (const ci of o.costItems) {
      const a = dec(ci.amountCny);
      switch (ci.category) {
        case 'GUIDE_SERVICE': cost.guideService += a; break;
        case 'COMP_GIFT':     cost.compGift += a; break;
        case 'HANDLING_FEE':  cost.handlingFee += a; break;
        case 'OPERATION_FEE': cost.operationFee += a; break;
        case 'OTHER':         cost.other += a; break;
      }
    }
  }

  // ── 4) REFUNDED 订单：已收-已退净额，按订单一次性补一笔负项到 revenue（而非蒸发）──
  // 见 RevenueBreakdown.refund 的字段注释：REFUNDED 订单不在上面的 COUNTED_STATUSES 查询里，
  // 不逐 OrderItem 展开（不影响分品类明细/costCny/costBreakdown），只按订单级净额累加。
  const refundedOrders = await client.order.findMany({
    where: { deletedAt: null, createdAt: { gte: from, lte: to }, status: OrderStatus.REFUNDED },
    select: {
      paidAmount: true,
      refunds: { where: { status: 'COMPLETED' }, select: { amount: true } },
    },
  });
  let refundedNetCny = 0;
  for (const o of refundedOrders) {
    const refundedTotal = o.refunds.reduce((sum, r) => sum + dec(r.amount), 0);
    refundedNetCny += dec(o.paidAmount) - refundedTotal;
  }
  rev.refund += refundedNetCny;
  revenueCny += refundedNetCny;

  // 总计 + 四舍五入
  const round = (n: number): number => round2(n);
  for (const k of Object.keys(rev) as (keyof RevenueBreakdown)[]) rev[k] = round(rev[k]);
  for (const k of Object.keys(cost) as (keyof CostBreakdown)[]) cost[k] = round(cost[k]);
  rev.total = round(
    rev.outboundFlight + rev.returnFlight + rev.outboundTax + rev.returnTax +
    rev.hotel + rev.visa + rev.transfer + rev.guide + rev.upgradeChange + rev.oversale +
    rev.uncategorized + rev.refund,
  );
  cost.total = round(
    cost.outboundCharter + cost.returnCharter + cost.outboundTax + cost.returnTax +
    cost.peakSurcharge + cost.fuel + cost.aircraftAdjust + cost.takeoffDiscount +
    cost.hotel + cost.visa + cost.transfer +
    cost.guideService + cost.compGift + cost.handlingFee + cost.operationFee + cost.other,
  );

  // 空座沉没：仍用班次维度 + resolution（charter 可能来自 period）
  const schedulesInRange = await client.flightSchedule.findMany({
    where: { departureTime: { gte: from, lte: to } },
    select: {
      flightId: true,
      departureTime: true,
      departureTz: true,
      charterCostCny: true,
      airportTaxDepCny: true,
      airportTaxArrCny: true,
      fuelCostCny: true,
      peakSurchargeCny: true,
      aircraftAdjustCny: true,
      takeoffDiscountCny: true,
      seatClasses: { select: { capacity: true, sold: true } },
    },
  });
  const sunkFlightIds = Array.from(new Set(schedulesInRange.map((s) => s.flightId)));
  const sunkPeriodsMap = sunkFlightIds.length > 0
    ? await loadPeriodsByFlightIds(sunkFlightIds, client)
    : new Map();
  let emptySeatSunkCostCny = 0;
  for (const s of schedulesInRange) {
    const matched = findMatchedPeriod(s, sunkPeriodsMap.get(s.flightId) ?? []);
    const eff = resolveScheduleCost(s, matched);
    if (eff.charterCostCny == null) continue;
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    if (totalSeats === 0) continue;
    const perSeat = eff.charterCostCny / totalSeats;
    emptySeatSunkCostCny += (totalSeats - soldSeats) * perSeat;
  }

  const categories: CategoryBreakdown[] = Array.from(categoryMap.values())
    .map((c) => ({
      ...c,
      revenueCny: round(c.revenueCny),
      costCny: round(c.costCny),
      grossMarginCny: round(c.revenueCny - c.costCny),
      marginPct: c.revenueCny > 0 ? round((c.revenueCny - c.costCny) / c.revenueCny) : null,
    }))
    .sort((a, b) => b.revenueCny - a.revenueCny);

  // A5：有任何缺成本快照的订单项 → 总毛利/净利报「未知」（null），不给虚高数字。
  const marginKnown = missingCostItemCount === 0;
  const grossMarginCny = marginKnown ? round(revenueCny - costCny) : null;

  return {
    range,
    revenueCny: round(revenueCny),
    costCny: round(costCny),
    grossMarginCny,
    marginPct: grossMarginCny !== null && revenueCny > 0 ? round(grossMarginCny / revenueCny) : null,
    emptySeatSunkCostCny: round(emptySeatSunkCostCny),
    netMarginCny: grossMarginCny !== null ? round(grossMarginCny - emptySeatSunkCostCny) : null,
    orderCount: orders.length,
    missingCostItemCount,
    categories,
    revenueBreakdown: rev,
    costBreakdown: cost,
  };
}

/** 按航班分组的 P&L 列表 */
export async function getFlightPnl(
  range: DateRange,
  limit = 100,
  client: PrismaClient = defaultPrisma,
): Promise<FlightPnlRow[]> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  const schedules = await client.flightSchedule.findMany({
    where: { departureTime: { gte: from, lte: to } },
    orderBy: { departureTime: 'desc' },
    take: limit,
    include: {
      flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
      seatClasses: { select: { capacity: true, sold: true } },
      orderItems: {
        where: {
          order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
        },
        select: { amount: true },
      },
    },
  });

  return schedules.map<FlightPnlRow>((s) => {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    const loadPct = totalSeats > 0 ? soldSeats / totalSeats : 0;
    const revenue = s.orderItems.reduce((a, i) => a + dec(i.amount), 0);
    const charter = s.charterCostCny == null ? null : dec(s.charterCostCny);
    const perSeat = charter != null && totalSeats > 0 ? charter / totalSeats : null;
    const soldAlloc = perSeat == null ? null : perSeat * soldSeats;
    const netMargin = charter == null ? null : revenue - charter;
    const grossOnSold = soldAlloc == null ? null : revenue - soldAlloc;
    // 财务口径：包机费÷全部座位，空座成本单列。
    const perSeatCost = perSeat;
    const emptySeatCost = perSeat == null ? null : perSeat * (totalSeats - soldSeats);
    return {
      scheduleId: s.id,
      flightNumber: s.flight.flightNumber,
      origin: s.flight.originCode,
      destination: s.flight.destinationCode,
      departureTime: s.departureTime.toISOString(),
      charterCostCny: charter == null ? null : round2(charter),
      totalSeats,
      soldSeats,
      loadPct: Math.round(loadPct * 10000) / 10000,
      revenueCny: round2(revenue),
      soldSeatAllocCostCny: soldAlloc == null ? null : round2(soldAlloc),
      emptySeatCostCny: emptySeatCost == null ? null : round2(emptySeatCost),
      netMarginCny: netMargin == null ? null : round2(netMargin),
      grossOnSoldCny: grossOnSold == null ? null : round2(grossOnSold),
      perSeatCostCny: perSeatCost == null ? null : round2(perSeatCost),
    };
  });
}

/** 按订单分组的 P&L 列表 */
export async function getOrderPnl(
  range: DateRange,
  limit = 100,
  client: PrismaClient = defaultPrisma,
): Promise<OrderPnlRow[]> {
  const from = toDateOnlyUtc(range.from);
  const to = toDateOnlyUtc(range.to, true);

  const orders = await client.order.findMany({
    where: {
      deletedAt: null,
      createdAt: { gte: from, lte: to },
      status: { in: COUNTED_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      contactName: true,
      total: true,
      createdAt: true,
      items: {
        select: {
          kind: true,
          quantity: true,
          totalCostCny: true,
          flightScheduleId: true,
        },
      },
    },
  });

  // 订单集合内的班次和周期各批量查询一次，避免按订单/订单项 N+1。
  const flightScheduleIds = Array.from(
    new Set(
      orders.flatMap((order) =>
        order.items
          .filter((item) => item.kind === 'FLIGHT' && item.flightScheduleId != null)
          .map((item) => item.flightScheduleId as string),
      ),
    ),
  );
  const schedules =
    flightScheduleIds.length === 0
      ? []
      : await client.flightSchedule.findMany({
          where: { id: { in: flightScheduleIds } },
          select: {
            id: true,
            flightId: true,
            departureTime: true,
            departureTz: true,
            charterCostCny: true,
            airportTaxDepCny: true,
            airportTaxArrCny: true,
            fuelCostCny: true,
            peakSurchargeCny: true,
            aircraftAdjustCny: true,
            takeoffDiscountCny: true,
            seatClasses: { select: { capacity: true } },
          },
        });
  const schedulesMap = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const periodsMap = await loadPeriodsByFlightIds(
    Array.from(new Set(schedules.map((schedule) => schedule.flightId))),
    client,
  );

  return orders.map<OrderPnlRow>((o) => {
    let costSum = 0;
    let missing = 0;
    for (const it of o.items) {
      const cost =
        it.kind === 'FLIGHT'
          ? (() => {
              const schedule = it.flightScheduleId
                ? schedulesMap.get(it.flightScheduleId)
                : undefined;
              return schedule == null
                ? null
                : resolveFlightItemCost(
                    schedule,
                    periodsMap.get(schedule.flightId) ?? [],
                    it.quantity,
                  );
            })()
          : it.totalCostCny == null
            ? null
            : dec(it.totalCostCny);
      if (cost == null) missing += 1;
      else costSum += cost;
    }
    const hasFullCost = missing === 0;
    const total = dec(o.total);
    const cost = hasFullCost ? costSum : null;
    const margin = cost == null ? null : total - cost;
    const marginPct = margin == null || total === 0 ? null : margin / total;
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      contactName: o.contactName,
      createdAt: o.createdAt.toISOString(),
      totalCny: round2(total),
      costCny: cost == null ? null : round2(cost),
      grossMarginCny: margin == null ? null : round2(margin),
      marginPct: marginPct == null ? null : Math.round(marginPct * 10000) / 10000,
      itemCount: o.items.length,
      missingCostItemCount: missing,
    };
  });
}

/**
 * 单订单收支明细（下钻）。
 * 成本口径与 getOrderPnl 完全一致：FLIGHT 行按班次实时成本，其他 OrderItem 读成本快照，
 * 缺任一件 → itemCostCny=null。
 * 额外把订单杂项成本 OrderCostItem 逐条列出（分层单列，不并入与列表严格一致的 grossMarginCny）。
 * 订单不存在 / 已软删 → null（路由据此回 404）。
 */
export async function getOrderPnlDetail(
  orderId: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrderPnlDetail | null> {
  const order = await client.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      contactName: true,
      total: true,
      createdAt: true,
      agent: { select: { companyName: true, contactName: true } },
      costItems: {
        select: { category: true, amountCny: true, note: true },
        orderBy: { createdAt: 'asc' },
      },
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          kind: true,
          description: true,
          quantity: true,
          unitPrice: true,
          amount: true,
          totalCostCny: true,
          metadata: true,
          flightSchedule: {
            select: {
              flightId: true,
              departureTime: true,
              departureTz: true,
              charterCostCny: true,
              airportTaxDepCny: true,
              airportTaxArrCny: true,
              fuelCostCny: true,
              peakSurchargeCny: true,
              aircraftAdjustCny: true,
              takeoffDiscountCny: true,
              seatClasses: { select: { capacity: true } },
            },
          },
        },
      },
    },
  });
  if (!order) return null;

  // ── 收入构成：逐 OrderItem（调价行 kind=FEE/DISCOUNT + metadata.priceAdjustment=true）──
  const incomeRows = order.items.map<OrderPnlDetailIncomeRow>((it) => {
    const meta = (it.metadata ?? null) as { priceAdjustment?: unknown } | null;
    return {
      label: it.description,
      kind: it.kind,
      quantity: it.quantity,
      unitPriceCny: round2(dec(it.unitPrice)),
      subtotalCny: round2(dec(it.amount)),
      isAdjustment: meta?.priceAdjustment === true,
    };
  });
  const itemsSum = order.items.reduce((a, it) => a + dec(it.amount), 0);

  // ── 成本构成：FLIGHT 按班次实时成本，其他行读 totalCostCny（缺任一件 → 全单未知）──
  const flightIds = Array.from(
    new Set(
      order.items.flatMap((item) =>
        item.kind === 'FLIGHT' && item.flightSchedule ? [item.flightSchedule.flightId] : [],
      ),
    ),
  );
  const periodsMap = await loadPeriodsByFlightIds(flightIds, client);
  let itemCostSum = 0;
  let missing = 0;
  const costItemRows = order.items.map<OrderPnlDetailCostRow>((it) => {
    const c =
      it.kind === 'FLIGHT'
        ? it.flightSchedule == null
          ? null
          : resolveFlightItemCost(
              it.flightSchedule,
              periodsMap.get(it.flightSchedule.flightId) ?? [],
              it.quantity,
            )
        : it.totalCostCny == null
          ? null
          : dec(it.totalCostCny);
    if (c == null) missing += 1;
    else itemCostSum += c;
    return {
      label: it.description,
      kind: it.kind,
      quantity: it.quantity,
      totalCostCny: c == null ? null : round2(c),
      isRealtime: it.kind === 'FLIGHT',
    };
  });
  const itemCostCny = missing === 0 ? round2(itemCostSum) : null;

  // ── 杂项成本：逐 OrderCostItem ──
  const miscRows = order.costItems.map<OrderPnlDetailMiscRow>((ci) => ({
    label: ORDER_COST_CATEGORY_LABEL[ci.category] ?? ci.category,
    category: ci.category,
    amountCny: round2(dec(ci.amountCny)),
    note: ci.note ?? null,
  }));
  const miscCostCny = round2(order.costItems.reduce((a, ci) => a + dec(ci.amountCny), 0));

  const totalCny = round2(dec(order.total));
  const grossMarginCny = itemCostCny == null ? null : round2(totalCny - itemCostCny);
  const marginPct =
    grossMarginCny == null || totalCny === 0
      ? null
      : Math.round((grossMarginCny / totalCny) * 10000) / 10000;
  const totalWithMiscCny = itemCostCny == null ? null : round2(itemCostCny + miscCostCny);
  const grossMarginWithMiscCny =
    totalWithMiscCny == null ? null : round2(totalCny - totalWithMiscCny);

  // ── 出发日期：最早 FLIGHT 航段（UTC 日期）──
  const departureTimes = order.items
    .map((it) => it.flightSchedule?.departureTime)
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime());
  const departureDate =
    departureTimes.length > 0 ? departureTimes[0].toISOString().slice(0, 10) : null;

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    contactName: order.contactName,
    agentName: order.agent?.companyName ?? order.agent?.contactName ?? null,
    departureDate,
    createdAt: order.createdAt.toISOString(),
    income: { rows: incomeRows, itemsSumCny: round2(itemsSum), totalCny },
    cost: {
      itemRows: costItemRows,
      miscRows,
      itemCostCny,
      miscCostCny,
      totalWithMiscCny,
      missingCostItemCount: missing,
    },
    grossMarginCny,
    marginPct,
    grossMarginWithMiscCny,
  };
}

/** 月度趋势（最近 N 个月） */
export async function getMonthlyTrend(
  months: number,
  client: PrismaClient = defaultPrisma,
): Promise<MonthlyPoint[]> {
  const n = Math.max(1, Math.min(36, Math.floor(months)));
  const now = new Date();
  const points: MonthlyPoint[] = [];

  for (let i = n - 1; i >= 0; i--) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const monthKey = `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`;

    const orders = await client.order.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: monthStart, lt: monthEnd },
        status: { in: COUNTED_STATUSES },
      },
      select: { items: { select: { amount: true, totalCostCny: true } } },
    });

    let revenue = 0;
    let cost = 0;
    let missingCostItemCount = 0;
    for (const o of orders) {
      for (const it of o.items) {
        revenue += dec(it.amount);
        if (it.totalCostCny != null) cost += dec(it.totalCostCny);
        else missingCostItemCount += 1;
      }
    }

    // 缺任一件成本 → 毛利 null（未知），不把缺失当 0 造成系统性虚高。
    const grossMarginCny = missingCostItemCount === 0 ? round2(revenue - cost) : null;
    points.push({
      month: monthKey,
      revenueCny: round2(revenue),
      costCny: round2(cost),
      grossMarginCny,
      missingCostItemCount,
      orderCount: orders.length,
    });
  }

  return points;
}
