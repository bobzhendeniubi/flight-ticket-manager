/**
 * 应付账单对账视图 —— 「系统算出来的成本」对「供应商开过来的账单」，差多少摆在一起看。
 *
 * **全程只读**。它一个字都不改成本口径，也不改账单：成本仍旧由 finances.cost.service 那套
 * 解析算（班次 override → 成本周期 → 空），酒店仍旧按包房周期 × 房夜，签证仍旧按任务级
 * 人均成本。这里只是把同一段期次里的这些数捡出来加个总，跟账单金额并排放。
 *
 * 差额大不大由人判断，系统只负责标出来 —— 绝不「自动调平」，也不回写任何一侧。
 * 对不上通常是三种原因，界面上把它们分开说：
 *   ① 供应商账单本身开错（找对方核）
 *   ② 系统里成本没维护全（缺成本条数单列）
 *   ③ 产品没挂供应商，系统侧根本没捞到东西（提示去挂）
 *
 * 各类型的系统侧口径：
 *   航司   包机费（整班）+ 每人科目 × 期内已售人数；每人科目 = 机场税(出/到) + 燃油 +
 *          旺季 + 机型调整 + 起降折扣，与财务概览同一套解析
 *   酒店   该供应商名下酒店的包房周期 ∩ 期次 → 间数 × 房夜 × 切房单价
 *   签证   该供应商名下签证产品的订单 → 人均成本 × 需签人数（美金侧一并汇总，
 *          因为签证公司就是按美金开账单的）
 *   车队 / 其他  暂无系统侧口径（地面服务产品没有供应商外键），如实说明而不是硬凑一个数
 */
import { Prisma, SupplierType, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { localDateISO } from '../../lib/flight-time.js';
import {
  findMatchedPeriod,
  loadPeriodsByFlightIds,
  resolveScheduleCost,
} from '../finances/finances.cost.service.js';
import { visaItemCostCny } from '../finances/finances.service.js';
import { getSupplierInvoice, round2, type SupplierInvoiceDto } from './supplier-invoices.service.js';

/**
 * 计入统计的订单状态 —— 与 finances.service 的 COUNTED_STATUSES 逐字一致。
 * 故意复制而非复用：那份是财务概览的口径，这份是对账的口径，今天相同，
 * 但哪天概览要改（比如把「改期中」拆出去），对账不该被动跟着变。改动时两边一起看。
 */
const COUNTED_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'REFUND_REQUESTED',
  'CHANGE_REQUESTED',
  'CHANGED',
] as const;

/** 差额判级阈值。绝对值先于比例：小账单差一块钱不该被判成大差异。 */
const DIFF_MATCH_ABS = 1; // ≤¥1 视为对上（分位舍入的正常抖动）
const DIFF_MATCH_PCT = 0.005; // ≤0.5% 视为对上
const DIFF_MINOR_PCT = 0.05; // ≤5% 小差异，>5% 大差异

export type DiffLevel = 'MATCH' | 'MINOR' | 'MAJOR' | 'NO_BASIS';

/**
 * 差额判级（纯函数）。systemTotal 为 null = 这个类型没有系统侧口径，或期内一条都没捞到 ——
 * 那就不该假装「差了一整张账单」，直接标 NO_BASIS。
 */
export function diffLevel(systemTotalCny: number | null, invoiceCny: number): DiffLevel {
  if (systemTotalCny == null) return 'NO_BASIS';
  const diff = Math.abs(invoiceCny - systemTotalCny);
  if (diff <= DIFF_MATCH_ABS) return 'MATCH';
  const base = Math.max(Math.abs(invoiceCny), Math.abs(systemTotalCny));
  if (base === 0) return 'MATCH';
  const pct = diff / base;
  if (pct <= DIFF_MATCH_PCT) return 'MATCH';
  if (pct <= DIFF_MINOR_PCT) return 'MINOR';
  return 'MAJOR';
}

/**
 * 两个闭区间的重叠**夜数**（纯函数）。
 *
 * 房夜口径：包房周期的 dateFrom~dateTo 是「住哪些晚」的闭区间，一晚就是一天，
 * 所以重叠夜数 = 重叠天数（含两端），不是两端相减。不重叠返回 0。
 */
export function overlapNights(
  aFrom: Date,
  aTo: Date,
  bFrom: Date | null,
  bTo: Date | null,
): number {
  if (!bFrom || !bTo) return 0;
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to = aTo < bTo ? aTo : bTo;
  if (from > to) return 0;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
}

export interface ReconcileLine {
  label: string;
  /** 数量（人数 / 间夜 / 单数），null = 该行不按量算（如整班包机费） */
  quantity: number | null;
  unit: string | null;
  amountCny: number;
  /** 展开说明（哪个班次 / 哪家酒店 / 哪张单） */
  detail: string | null;
}

export interface ReconcileSystemSide {
  basis: SupplierType;
  basisLabel: string;
  lines: ReconcileLine[];
  /** null = 该类型没有系统侧口径，或期内一条数据都没捞到 */
  totalCny: number | null;
  /** 原币合计（目前只有签证的美金侧有意义）；null = 不适用 */
  sourceCurrency: string | null;
  sourceAmount: number | null;
  /** 期内捞到但没成本可算的条数 —— 差额可能就出在这儿 */
  missingCostCount: number;
  /** 给财务看的口径说明与提示 */
  notes: string[];
}

export interface ReconcileResult {
  invoice: SupplierInvoiceDto;
  systemSide: ReconcileSystemSide;
  diff: {
    /** 账单 − 系统；正数 = 供应商要得比系统算的多 */
    amountCny: number | null;
    /** 占两者较大值的比例；null = 无口径 */
    pct: number | null;
    level: DiffLevel;
  };
}

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  return v == null ? null : dec(v);
}

function toDateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

// ── 航司：包机费（整班）+ 每人科目 × 期内已售人数 ────────────────────────────
async function reconcileAirline(
  supplierId: string,
  from: Date,
  to: Date,
  flightScheduleId: string | null,
  client: PrismaClient,
): Promise<ReconcileSystemSide> {
  const notes: string[] = [];

  // 按班次开的账单只看那一班；按月 / 区间的看该供应商名下所有航班在期内的班次。
  // 出发日按出发地时区折，故先按 UTC 宽两天捞、再逐条按本地日过滤。
  const wideFrom = new Date(from.getTime() - 24 * 60 * 60 * 1000);
  const wideTo = new Date(to.getTime() + 2 * 24 * 60 * 60 * 1000);
  const schedules = await client.flightSchedule.findMany({
    where: flightScheduleId
      ? { id: flightScheduleId }
      : { flight: { supplierId }, departureTime: { gte: wideFrom, lte: wideTo } },
    select: {
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
      flight: { select: { flightNumber: true } },
      orderItems: {
        where: { kind: 'FLIGHT', order: { deletedAt: null, status: { in: [...COUNTED_STATUSES] } } },
        select: { quantity: true },
      },
    },
    orderBy: { departureTime: 'asc' },
  });

  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);
  const inWindow = schedules.filter((s) => {
    if (flightScheduleId) return true;
    const day = localDateISO(s.departureTime, s.departureTz);
    return day >= fromStr && day <= toStr;
  });

  if (inWindow.length === 0) {
    notes.push(
      flightScheduleId
        ? '账单指向的班次已不存在。'
        : '期内没找到挂在这家供应商名下的航班班次——多半是航班还没挂供应商（在供应商页把航班挂上即可）。',
    );
    return {
      basis: SupplierType.AIRLINE,
      basisLabel: '航司包机成本',
      lines: [],
      totalCny: null,
      sourceCurrency: null,
      sourceAmount: null,
      missingCostCount: 0,
      notes,
    };
  }

  const periodsMap = await loadPeriodsByFlightIds(
    Array.from(new Set(inWindow.map((s) => s.flightId))),
    client,
  );

  const lines: ReconcileLine[] = [];
  let total = 0;
  let missingCostCount = 0;
  let lockedCount = 0;

  for (const s of inWindow) {
    const matched = findMatchedPeriod(s, periodsMap.get(s.flightId) ?? []);
    const eff = resolveScheduleCost(s, matched);
    if (s.costLocked) lockedCount += 1;

    const pax = s.orderItems.reduce((sum, i) => sum + i.quantity, 0);
    const day = localDateISO(s.departureTime, s.departureTz);
    const tag = `${s.flight.flightNumber} · ${day}`;

    const allNull = [
      eff.charterCostCny,
      eff.airportTaxDepCny,
      eff.airportTaxArrCny,
      eff.fuelCostCny,
      eff.peakSurchargeCny,
      eff.aircraftAdjustCny,
      eff.takeoffDiscountCny,
    ].every((v) => v == null);
    if (allNull) {
      missingCostCount += 1;
      continue;
    }

    // 包机费是整班成本，不按人分摊 —— 航司就是按整班开账单的。
    // 这里刻意不用「÷总座×已售」那套分摊口径：那是算单张订单毛利用的，不是对账用的。
    if (eff.charterCostCny != null) {
      lines.push({
        label: '包机费（整班）',
        quantity: null,
        unit: null,
        amountCny: round2(eff.charterCostCny),
        detail: tag,
      });
      total += eff.charterCostCny;
    }

    const perPax: Array<[string, number | null]> = [
      ['机场税（出发）', eff.airportTaxDepCny],
      ['机场税（到达）', eff.airportTaxArrCny],
      ['燃油', eff.fuelCostCny],
      ['旺季附加', eff.peakSurchargeCny],
      ['机型调整', eff.aircraftAdjustCny],
      ['起降折扣', eff.takeoffDiscountCny],
    ];
    for (const [label, value] of perPax) {
      if (value == null || value === 0) continue;
      const amount = round2(value * pax);
      lines.push({
        label,
        quantity: pax,
        unit: '人',
        amountCny: amount,
        detail: `${tag} · ¥${value}/人`,
      });
      total += amount;
    }
  }

  notes.push(
    '人数口径 = 期内该班次上「计入统计」订单的机票行占座人数（含待支付，不含已取消 / 已退款 / 已删除）。',
  );
  notes.push('包机费按整班计，不按人分摊——航司就是按整班结的。');
  if (lockedCount > 0) {
    notes.push(`其中 ${lockedCount} 个班次成本已锁定，只取班次自身固化值，不回退成本周期。`);
  }
  if (missingCostCount > 0) {
    notes.push(`${missingCostCount} 个班次一项成本都没维护，未计入系统侧合计。`);
  }

  return {
    basis: SupplierType.AIRLINE,
    basisLabel: '航司包机成本',
    lines,
    totalCny: lines.length === 0 ? null : round2(total),
    sourceCurrency: null,
    sourceAmount: null,
    missingCostCount,
    notes,
  };
}

// ── 酒店：包房周期 ∩ 期次 → 间数 × 房夜 × 切房单价 ──────────────────────────
async function reconcileHotel(
  supplierId: string,
  from: Date,
  to: Date,
  client: PrismaClient,
): Promise<ReconcileSystemSide> {
  const notes: string[] = [];
  const periods = await client.hotelBlockPeriod.findMany({
    where: { hotel: { supplierId }, dateFrom: { lte: to }, dateTo: { gte: from } },
    select: {
      id: true,
      dateFrom: true,
      dateTo: true,
      rooms: true,
      unitPrice: true,
      hotel: { select: { name: true, randomTierPlaceholder: true } },
    },
    orderBy: { dateFrom: 'asc' },
  });

  const lines: ReconcileLine[] = [];
  let total = 0;
  let missingCostCount = 0;
  let placeholderSkipped = 0;

  for (const p of periods) {
    // 随机档占位酒店在房控口径里「不是酒店」，名下周期不计任何余量；
    // 对账同理不能拿它的周期去跟真金白银的账单比。
    if (p.hotel?.randomTierPlaceholder != null) {
      placeholderSkipped += 1;
      continue;
    }
    const nights = overlapNights(from, to, p.dateFrom, p.dateTo);
    if (nights === 0) continue;
    const unit = decOrNull(p.unitPrice);
    if (unit == null) {
      missingCostCount += 1;
      continue;
    }
    const amount = round2(p.rooms * nights * unit);
    const pFrom = p.dateFrom.toISOString().slice(0, 10);
    const pTo = p.dateTo.toISOString().slice(0, 10);
    lines.push({
      label: p.hotel?.name ?? '（酒店已删除）',
      quantity: p.rooms * nights,
      unit: '间夜',
      amountCny: amount,
      detail: `${pFrom}~${pTo} · ${p.rooms} 间 × ${nights} 晚 × ¥${unit}`,
    });
    total += amount;
  }

  notes.push('房夜口径 = 包房周期与账单期次的重叠天数（闭区间，一天算一晚）× 切房间数 × 切房单价。');
  notes.push('这是**切了多少房**的口径，不是**卖掉多少房**——供应商按切房量结账，空房也要付。');
  if (placeholderSkipped > 0) {
    notes.push(`跳过 ${placeholderSkipped} 条随机档占位酒店的周期（房控口径里它们不是真酒店）。`);
  }
  if (missingCostCount > 0) {
    notes.push(`${missingCostCount} 条包房周期没填切房单价，未计入系统侧合计。`);
  }
  if (periods.length === 0) {
    notes.push('期内没找到挂在这家供应商名下的酒店包房周期——多半是酒店还没挂供应商。');
  }

  return {
    basis: SupplierType.HOTEL,
    basisLabel: '酒店包房成本',
    lines,
    totalCny: lines.length === 0 ? null : round2(total),
    sourceCurrency: null,
    sourceAmount: null,
    missingCostCount,
    notes,
  };
}

// ── 签证：人均成本 × 需签人数（美金侧一并汇总）──────────────────────────────
const VISA_LINE_CAP = 200;

async function reconcileVisa(
  supplierId: string,
  from: Date,
  to: Date,
  client: PrismaClient,
): Promise<ReconcileSystemSide> {
  const notes: string[] = [];
  // 期次锚点用订单创建日：签证任务本身没有稳定的业务日期（送签日只在完成后才有），
  // 而签证公司的月结账单就是按「这个月送了哪些单」开的。
  const items = await client.orderItem.findMany({
    where: {
      kind: 'VISA',
      visa: { supplierId },
      order: {
        deletedAt: null,
        status: { in: [...COUNTED_STATUSES] },
        createdAt: { gte: from, lte: new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) },
      },
    },
    select: {
      id: true,
      quantity: true,
      totalCostCny: true,
      visa: { select: { costPriceCny: true } },
      order: { select: { orderNumber: true, passengers: { select: { visaExempt: true } } } },
      fulfillmentTasks: {
        where: { type: 'VISA_APPLICATION' },
        select: { visaUnitCostCny: true, visaUnitCostUsd: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const lines: ReconcileLine[] = [];
  let total = 0;
  let usdTotal = 0;
  let usdCount = 0;
  let missingCostCount = 0;
  let overflowAmount = 0;
  let overflowCount = 0;

  for (const it of items) {
    const visaPax = it.order.passengers.filter((p) => !p.visaExempt).length;
    const task = it.fulfillmentTasks[0];
    const { cost, source } = visaItemCostCny({
      taskUnitCostCny: decOrNull(task?.visaUnitCostCny),
      visaPax,
      snapshotCny: decOrNull(it.totalCostCny),
      productCostPriceCny: decOrNull(it.visa?.costPriceCny),
      quantity: it.quantity,
    });
    if (source === 'NONE') {
      missingCostCount += 1;
      continue;
    }
    const usdUnit = decOrNull(task?.visaUnitCostUsd);
    if (usdUnit != null) {
      usdTotal += usdUnit * visaPax;
      usdCount += 1;
    }
    total += cost;

    if (lines.length < VISA_LINE_CAP) {
      lines.push({
        label: it.order.orderNumber,
        quantity: visaPax || it.quantity,
        unit: '人',
        amountCny: round2(cost),
        detail: usdUnit == null ? `成本来源：${source}` : `$${usdUnit}/人 · 成本来源：${source}`,
      });
    } else {
      overflowAmount += cost;
      overflowCount += 1;
    }
  }

  if (overflowCount > 0) {
    lines.push({
      label: `其余 ${overflowCount} 张订单合计`,
      quantity: null,
      unit: null,
      amountCny: round2(overflowAmount),
      detail: `明细过多，只逐条列出前 ${VISA_LINE_CAP} 张`,
    });
  }

  notes.push(
    '期次锚点 = 订单创建日（签证公司月结账单就是按「这个月送了哪些单」开的）；人数 = 非自备签乘客数。',
  );
  notes.push('人均成本回退链：签证任务实填 → 录单成本快照 → 签证产品主数据（与财务概览同一套）。');
  if (usdCount > 0) {
    notes.push(`其中 ${usdCount} 张单填了美金人均成本，美金侧合计一并列在上方。`);
  }
  if (missingCostCount > 0) {
    notes.push(`${missingCostCount} 张单三级回退都取不到成本，未计入系统侧合计。`);
  }
  if (items.length === 0) {
    notes.push('期内没找到挂在这家供应商名下的签证订单——多半是签证产品还没挂供应商。');
  }

  return {
    basis: SupplierType.VISA_AGENCY,
    basisLabel: '签证代办成本',
    lines,
    totalCny: lines.length === 0 ? null : round2(total),
    sourceCurrency: usdCount > 0 ? 'USD' : null,
    sourceAmount: usdCount > 0 ? round2(usdTotal) : null,
    missingCostCount,
    notes,
  };
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

/**
 * 对一张应付账单做对账。只读，不写任何表。
 *
 * 期次窗口取账单归一后的 periodFrom~periodTo（三种期次建单时都已派生填上）。
 * 两端为空的账单直接返回「无口径」，而不是拿一个默认区间去凑数。
 */
export async function reconcileSupplierInvoice(
  invoiceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ReconcileResult> {
  const invoice = await getSupplierInvoice(invoiceId, client);
  const supplier = await client.supplier.findUniqueOrThrow({
    where: { id: invoice.supplierId },
    select: { id: true, type: true },
  });

  let systemSide: ReconcileSystemSide;
  if (!invoice.periodFrom || !invoice.periodTo) {
    systemSide = {
      basis: supplier.type,
      basisLabel: '—',
      lines: [],
      totalCny: null,
      sourceCurrency: null,
      sourceAmount: null,
      missingCostCount: 0,
      notes: ['这张账单没有期次起止日期，无法圈定系统侧成本范围。'],
    };
  } else {
    const from = toDateOnly(invoice.periodFrom);
    const to = toDateOnly(invoice.periodTo);
    if (supplier.type === SupplierType.AIRLINE) {
      systemSide = await reconcileAirline(supplier.id, from, to, invoice.flightScheduleId, client);
    } else if (supplier.type === SupplierType.HOTEL) {
      systemSide = await reconcileHotel(supplier.id, from, to, client);
    } else if (supplier.type === SupplierType.VISA_AGENCY) {
      systemSide = await reconcileVisa(supplier.id, from, to, client);
    } else {
      systemSide = {
        basis: supplier.type,
        basisLabel: '暂无系统侧口径',
        lines: [],
        totalCny: null,
        sourceCurrency: null,
        sourceAmount: null,
        missingCostCount: 0,
        notes: [
          '车队 / 其他类供应商目前没有可归属的系统侧成本（地面服务产品还没有供应商外键）。',
          '这类账单请按明细行人工核对；把明细行挂到具体订单上，至少能查到这笔钱花在哪张单。',
        ],
      };
    }
  }

  const level = diffLevel(systemSide.totalCny, invoice.amountCny);
  const diffAmount =
    systemSide.totalCny == null ? null : round2(invoice.amountCny - systemSide.totalCny);
  let pct: number | null = null;
  if (systemSide.totalCny != null && diffAmount != null) {
    const base = Math.max(Math.abs(invoice.amountCny), Math.abs(systemSide.totalCny));
    pct = base === 0 ? 0 : Math.round((diffAmount / base) * 10000) / 10000;
  }

  return { invoice, systemSide, diff: { amountCny: diffAmount, pct, level } };
}
