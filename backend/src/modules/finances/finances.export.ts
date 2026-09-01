/**
 * 财务核对明细 xlsx 导出 — 一行/乘客
 *
 * 成本口径（统一人民币，无汇率）：
 *   机票成本(RMB)  = 该班次包机总成本 ÷ 总座位数（单座分摊）— 每位乘客占 1 座
 *   机场税(RMB)    = airportTaxDepCny + airportTaxArrCny
 *   房费(RMB)      = hotel.costPriceCny
 *   车费(RMB)      = transfer.costPriceCny
 *   签证成本(RMB)  = visa.costPriceCny
 * 机票成本按"包机单座成本"算（与航班毛利视图一致）；酒店/车费/签证按订单总额 ÷ 人数 均摊。
 * 收入按 order.total ÷ 人数 均摊到每位乘客。
 *
 * 是否清账（settledStatus）口径：应收合计 = total + adjustmentCny（改期费/换人费等售后费用）；
 * 已收净额 = paidAmount + prepaymentOffset − Σ COMPLETED Refund（统一口径见 lib/net-received.ts）；
 * 清账 = 已收净额 ≥ 应收合计，不带"应收合计>0"前置——与 orders.export-master.ts /
 * orders.export-templates.ts / reports.service.ts 三处口径字字对齐，避免"改期费/换人费未收"
 * 被误标为已清账，也让零额单（免费单/全减免单，应收=已收=0）正常判"已清账"而非"未清账"。
 * 已完成退款必须扣：退款完成只翻 Refund 状态、不回冲 paidAmount，不扣就会把"先收后退"的
 * 订单一直标成已清账（钱其实已经退回客户了）。
 * 注：本导出的"收入"各列（flightRevenue/totalRevenue/客单收入 等）仍只按 order.total /
 * OrderItem.amount 计，不含 adjustmentCny——改期费/换人费目前没有独立的收入列，只在
 * settledStatus 这个应收口径里生效，这是已知的口径局限，不在本次改动范围内。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  findMatchedPeriod,
  loadPeriodsByFlightIds,
  resolveScheduleCost,
} from './finances.cost.service.js';
import { netReceivedCny, sumCompletedRefundCny } from '../../lib/net-received.js';
import { businessDateTime } from '../../lib/business-time.js';
// 签证成本口径与财务汇总共用同一函数，两处逐字一致（任务实际成本优先 → 产品主数据回退）
import { visaItemCostCny } from './finances.service.js';

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

const ORDER_KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  BUNDLE: '套餐',
  INSURANCE: '保险',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  REFUND_REQUESTED: '退款中',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
};

const REFUND_FAMILY_STATUSES: Set<OrderStatus> = new Set([
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.REFUNDED,
]);

interface FinanceRow {
  agency: string;
  orderNumber: string;
  chineseName: string;
  passengerName: string;
  departDate: string;
  returnDate: string;
  flightNumbers: string;
  orderType: string;
  paxCount: number;
  status: string;
  settledStatus: string;
  recordedAt: string;
  flightCostCny: number; // 机票成本(RMB) — 包机单座分摊
  airportTaxCny: number;
  peakSurchargeCny: number; // 旺季附加
  fuelCostCny: number; // 燃油
  aircraftAdjustCny: number; // 机型调整
  takeoffDiscountCny: number; // 起降折扣
  guideServiceCny: number; // 导游服务费（订单 costItems 分摊到人）
  otherOrderCostCny: number; // 杂项：赠送+手续费+操作费+其他汇总
  hotelName: string;
  hotelNights: number;
  hotelCostCny: number;
  transferCostCny: number;
  visaCostCny: number;
  unitCostTotal: number;
  unitRevenue: number;
  unitProfit: number;
  flightRevenue: number;
  hotelRevenue: number;
  visaRevenue: number;
  transferRevenue: number;
  totalRevenue: number;
  flightCost: number;
  hotelCost: number;
  visaCost: number;
  transferCost: number;
  totalCost: number;
  grossMargin: number;
  note: string;
  refundType: string;
  swapFeeCny: number | '';
  replacementOrderNumber: string;
}

const COLUMNS: Array<{ header: string; key: keyof FinanceRow; width: number }> = [
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '中文名称', key: 'chineseName', width: 12 },
  { header: '乘客姓名', key: 'passengerName', width: 18 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '返程日期', key: 'returnDate', width: 12 },
  { header: '航班号', key: 'flightNumbers', width: 14 },
  { header: '订单类型', key: 'orderType', width: 14 },
  { header: '人数', key: 'paxCount', width: 6 },
  { header: '订单状态', key: 'status', width: 10 },
  { header: '是否清账', key: 'settledStatus', width: 8 },
  { header: '录入时间', key: 'recordedAt', width: 18 },
  { header: '机票成本(RMB)', key: 'flightCostCny', width: 14 },
  { header: '机场税成本(RMB)', key: 'airportTaxCny', width: 14 },
  { header: '旺季附加(RMB)', key: 'peakSurchargeCny', width: 12 },
  { header: '燃油(RMB)', key: 'fuelCostCny', width: 12 },
  { header: '机型调整(RMB)', key: 'aircraftAdjustCny', width: 12 },
  { header: '起降折扣/机场补贴(RMB)', key: 'takeoffDiscountCny', width: 14 },
  { header: '导游服务费(RMB)', key: 'guideServiceCny', width: 14 },
  { header: '杂项(赠送+手续费+操作费+其他)(RMB)', key: 'otherOrderCostCny', width: 18 },
  { header: '入住酒店', key: 'hotelName', width: 18 },
  { header: '入住天数', key: 'hotelNights', width: 8 },
  { header: '房费(RMB)', key: 'hotelCostCny', width: 12 },
  { header: '车费(RMB)', key: 'transferCostCny', width: 12 },
  { header: '签证成本(RMB)', key: 'visaCostCny', width: 14 },
  { header: '客单成本合计', key: 'unitCostTotal', width: 14 },
  { header: '客单收入', key: 'unitRevenue', width: 12 },
  { header: '客单利润', key: 'unitProfit', width: 12 },
  { header: '机票收入', key: 'flightRevenue', width: 12 },
  { header: '酒店收入', key: 'hotelRevenue', width: 12 },
  { header: '签证收入', key: 'visaRevenue', width: 12 },
  { header: '车费收入', key: 'transferRevenue', width: 12 },
  { header: '总收入', key: 'totalRevenue', width: 12 },
  { header: '机票支出', key: 'flightCost', width: 12 },
  { header: '酒店支出', key: 'hotelCost', width: 12 },
  { header: '签证支出', key: 'visaCost', width: 12 },
  { header: '车费支出', key: 'transferCost', width: 12 },
  { header: '总成本', key: 'totalCost', width: 12 },
  { header: '毛利', key: 'grossMargin', width: 12 },
  { header: '备注', key: 'note', width: 20 },
  { header: '退款类型', key: 'refundType', width: 12 },
  { header: '换人费(元)', key: 'swapFeeCny', width: 12 },
  { header: '接手订单号', key: 'replacementOrderNumber', width: 20 },
];

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function refundType(status: OrderStatus, swapRefundedAt: Date | null): string {
  if (swapRefundedAt) return '换人退款';
  if (REFUND_FAMILY_STATUSES.has(status)) return '普通退款';
  return '';
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

type OrderForExport = Prisma.OrderGetPayload<{
  include: {
    agent: { select: { companyName: true; contactName: true } };
    passengers: true;
    costItems: { select: { category: true; amountCny: true } };
    refunds: { select: { amount: true } };
    items: {
      include: {
        flightSchedule: {
          include: {
            flight: { select: { flightNumber: true; originCode: true; destinationCode: true } };
            seatClasses: { select: { capacity: true } };
          };
        };
        hotelRoomType: { select: { name: true; costPriceCny: true } };
        visa: { select: { costPriceCny: true } };
        transfer: { select: { costPriceCny: true } };
        fulfillmentTasks: { select: { type: true; visaUnitCostCny: true } };
      };
    };
  };
}>;

type ScheduleForResolution = NonNullable<OrderForExport['items'][number]['flightSchedule']>;
type PeriodsMap = Awaited<ReturnType<typeof loadPeriodsByFlightIds>>;

/** 把一张订单展开成 N 行（每位乘客一行）*/
function orderToRows(order: OrderForExport, periodsMap: PeriodsMap): FinanceRow[] {
  const paxCount = Math.max(1, order.passengers.length);
  // 需签乘客数（非自备签）—— 签证实际成本按此人均折算
  const visaPax = order.passengers.filter((p) => !p.visaExempt).length;

  // ── 机票：包机单座分摊（charter / 总座位）+ 机场税 + 4 新成本字段，可能去程+回程多段 ──
  // 全部用 cost.service.resolveScheduleCost（override → period → null）取生效值
  let flightCostPerSeat = 0; // 每位乘客占 1 座的包机分摊成本
  let airportTaxCny = 0;
  let peakSurchargePerPax = 0;
  let fuelPerPax = 0;
  let aircraftAdjustPerPax = 0;
  let takeoffDiscountPerPax = 0;
  const flightNumbers: string[] = [];
  const departDates: Date[] = [];
  for (const it of order.items) {
    if (it.kind === 'FLIGHT' && it.flightSchedule) {
      const sched: ScheduleForResolution = it.flightSchedule;
      const totalSeats = sched.seatClasses.reduce((a, c) => a + c.capacity, 0);
      const periodsForFlight = periodsMap.get(sched.flightId) ?? [];
      const matched = findMatchedPeriod(sched, periodsForFlight);
      const eff = resolveScheduleCost(sched, matched);
      const charter = eff.charterCostCny ?? 0;
      if (totalSeats > 0 && charter > 0) {
        flightCostPerSeat += charter / totalSeats;
      }
      airportTaxCny += (eff.airportTaxDepCny ?? 0) + (eff.airportTaxArrCny ?? 0);
      peakSurchargePerPax += eff.peakSurchargeCny ?? 0;
      fuelPerPax += eff.fuelCostCny ?? 0;
      aircraftAdjustPerPax += eff.aircraftAdjustCny ?? 0;
      takeoffDiscountPerPax += eff.takeoffDiscountCny ?? 0;
      flightNumbers.push(sched.flight.flightNumber);
      departDates.push(sched.departureTime);
    }
  }
  departDates.sort((a, b) => a.getTime() - b.getTime());

  // ── 订单杂项成本（OrderCostItem）：按 category 汇总，再 ÷ paxCount 摊到人 ──
  let guideServiceCnyOrder = 0;
  let otherOrderCostCnyOrder = 0;
  for (const ci of order.costItems) {
    const amt = dec(ci.amountCny);
    if (ci.category === 'GUIDE_SERVICE') {
      guideServiceCnyOrder += amt;
    } else {
      // COMP_GIFT / HANDLING_FEE / OPERATION_FEE / OTHER 全部归到"杂项"
      otherOrderCostCnyOrder += amt;
    }
  }
  const guideServicePerPax = guideServiceCnyOrder / paxCount;
  const otherOrderCostPerPax = otherOrderCostCnyOrder / paxCount;

  // ── 酒店 ──
  let hotelCostCnyOrder = 0;
  let hotelName = '';
  let hotelNights = 0;
  for (const it of order.items) {
    if (it.kind !== 'HOTEL') continue;
    let nights = 1;
    if (it.hotelCheckIn && it.hotelCheckOut) {
      nights = Math.max(
        1,
        Math.round(
          (it.hotelCheckOut.getTime() - it.hotelCheckIn.getTime()) / (1000 * 60 * 60 * 24),
        ),
      );
    }
    // 快照优先：随机档（同星级聚合）行没有 hotelRoomTypeId，房型主数据取不到净房价，
    // 但建单时已把房费快照写进 totalCostCny。此前只认 hotelRoomType，随机档整行房费算 0，
    // 房费列凭空少一截、毛利凭空多一截——快照是这类行唯一的成本来源，必须先读。
    if (it.totalCostCny != null) {
      hotelCostCnyOrder += dec(it.totalCostCny);
    } else if (it.hotelRoomType?.costPriceCny != null) {
      hotelCostCnyOrder += dec(it.hotelRoomType.costPriceCny) * nights * it.quantity;
    }
    // 房型名：随机档还没落到具体酒店（hotelRoomTypeId 空 + randomStarTier 非空），
    // 标成「N 星随机（未落位）」，别让"入住酒店"列空着，看不出这行是哪种房
    hotelName =
      it.hotelRoomType?.name ??
      (it.randomStarTier != null ? `${it.randomStarTier}星随机（未落位）` : '');
    hotelNights = nights;
  }

  // ── 签证 / 车费 ──
  let visaCostCnyOrder = 0;
  let transferCostCnyOrder = 0;
  for (const it of order.items) {
    if (it.kind === 'VISA') {
      // 与 finances.service 共用 visaItemCostCny：任务实际成本(人均×需签数) 优先，否则回退产品主数据×数量。
      // 导出侧无 totalCostCny 快照 → snapshotCny 传 null（回退口径 = 产品主数据）。
      const taskCny = it.fulfillmentTasks?.[0]?.visaUnitCostCny;
      const { cost } = visaItemCostCny({
        taskUnitCostCny: taskCny == null ? null : dec(taskCny),
        visaPax,
        snapshotCny: null,
        productCostPriceCny: it.visa?.costPriceCny != null ? dec(it.visa.costPriceCny) : null,
        quantity: it.quantity,
      });
      visaCostCnyOrder += cost;
    }
    if (it.kind === 'TRANSFER' && it.transfer) {
      transferCostCnyOrder += dec(it.transfer.costPriceCny) * it.quantity;
    }
  }

  // ── 品类收入（按 OrderItem.amount 分类）──
  const revByKind: Record<string, number> = {};
  for (const it of order.items) {
    revByKind[it.kind] = (revByKind[it.kind] ?? 0) + dec(it.amount);
  }
  const flightRevenue = revByKind.FLIGHT ?? 0;
  const hotelRevenue = revByKind.HOTEL ?? 0;
  const visaRevenue = revByKind.VISA ?? 0;
  const transferRevenue = revByKind.TRANSFER ?? 0;
  const totalRevenue = dec(order.total);

  const kinds = Array.from(new Set(order.items.map((i) => ORDER_KIND_LABEL[i.kind] ?? i.kind)));
  const orderType = kinds.join('+');

  const agency = order.agent?.companyName ?? order.agent?.contactName ?? '直销';
  // 是否清账：应收合计 = total + adjustmentCny（改期费/换人费等售后费用，不改 total 本身，
  // 单独叠加在这笔调整字段上）；已收净额走 lib/net-received.ts 的统一口径
  // （paidAmount + prepaymentOffset − Σ COMPLETED Refund），与 reports.service.ts balanceOf 同源。
  const payableCny = round2(totalRevenue + (order.adjustmentCny ?? 0));
  const receivedCny = netReceivedCny(order, sumCompletedRefundCny(order.refunds));
  const settled = receivedCny >= payableCny ? '是' : '否';

  const hotelPerPax = hotelCostCnyOrder / paxCount;
  const transferPerPax = transferCostCnyOrder / paxCount;
  const visaCnyPerPax = visaCostCnyOrder / paxCount;
  const revenuePerPax = totalRevenue / paxCount;

  // 机票订单级合计：单座包机 + 机场税(段合计) + 4 项 per-pax 字段 + 订单杂项成本，全部 × paxCount
  // 注：peak/fuel/adj/disc 已是 per-pax 口径；guide/other 是订单级（再均摊回人）
  const flightPerPaxTotal =
    flightCostPerSeat +
    airportTaxCny +
    peakSurchargePerPax +
    fuelPerPax +
    aircraftAdjustPerPax +
    takeoffDiscountPerPax;
  const flightCostOrder =
    flightPerPaxTotal * paxCount + guideServiceCnyOrder + otherOrderCostCnyOrder;
  const totalCostOrder =
    flightCostOrder + hotelCostCnyOrder + transferCostCnyOrder + visaCostCnyOrder;

  const baseRows = order.passengers.map<FinanceRow>((p) => {
    const unitCostTotal =
      flightCostPerSeat +
      airportTaxCny +
      peakSurchargePerPax +
      fuelPerPax +
      aircraftAdjustPerPax +
      takeoffDiscountPerPax +
      guideServicePerPax +
      otherOrderCostPerPax +
      hotelPerPax +
      transferPerPax +
      visaCnyPerPax;
    return {
      agency,
      orderNumber: order.orderNumber,
      chineseName: p.fullName,
      passengerName:
        p.lastName && p.firstName ? `${p.lastName}/${p.firstName}`.toUpperCase() : p.fullName,
      departDate: fmtDate(departDates[0]),
      returnDate: departDates.length > 1 ? fmtDate(departDates[departDates.length - 1]) : '',
      flightNumbers: Array.from(new Set(flightNumbers)).join(' / '),
      orderType,
      paxCount,
      status: STATUS_LABEL[order.status] ?? order.status,
      settledStatus: settled,
      // 录入时间是「动作发生时刻」，按北京时间输出（容器 TZ 是 UTC，直接取 UTC 分量会少 8 小时）
      recordedAt: businessDateTime(order.createdAt),
      flightCostCny: round2(flightCostPerSeat),
      airportTaxCny: round2(airportTaxCny),
      peakSurchargeCny: round2(peakSurchargePerPax),
      fuelCostCny: round2(fuelPerPax),
      aircraftAdjustCny: round2(aircraftAdjustPerPax),
      takeoffDiscountCny: round2(takeoffDiscountPerPax),
      guideServiceCny: round2(guideServicePerPax),
      otherOrderCostCny: round2(otherOrderCostPerPax),
      hotelName,
      hotelNights,
      hotelCostCny: round2(hotelPerPax),
      transferCostCny: round2(transferPerPax),
      visaCostCny: round2(visaCnyPerPax),
      unitCostTotal: round2(unitCostTotal),
      unitRevenue: round2(revenuePerPax),
      unitProfit: round2(revenuePerPax - unitCostTotal),
      flightRevenue: 0,
      hotelRevenue: 0,
      visaRevenue: 0,
      transferRevenue: 0,
      totalRevenue: 0,
      flightCost: 0,
      hotelCost: 0,
      visaCost: 0,
      transferCost: 0,
      totalCost: 0,
      grossMargin: 0,
      note: order.notes ?? '',
      refundType: refundType(order.status, order.swapRefundedAt),
      swapFeeCny: order.swapFeeCny ?? '',
      replacementOrderNumber: order.swapReplacementOrderNumber ?? '',
    };
  });

  // 订单级合计只写在第一位乘客行，避免按乘客重复累加
  if (baseRows.length > 0) {
    baseRows[0] = {
      ...baseRows[0],
      flightRevenue: round2(flightRevenue),
      hotelRevenue: round2(hotelRevenue),
      visaRevenue: round2(visaRevenue),
      transferRevenue: round2(transferRevenue),
      totalRevenue: round2(totalRevenue),
      flightCost: round2(flightCostOrder),
      hotelCost: round2(hotelCostCnyOrder),
      visaCost: round2(visaCostCnyOrder),
      transferCost: round2(transferCostCnyOrder),
      totalCost: round2(totalCostOrder),
      grossMargin: round2(totalRevenue - totalCostOrder),
    };
  }

  return baseRows;
}

export async function buildFinanceExportWorkbook(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const [y1, m1, d1] = range.from.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = range.to.split('-').map((x) => parseInt(x, 10));
  const fromD = new Date(Date.UTC(y1, m1 - 1, d1, 0, 0, 0, 0));
  const toD = new Date(Date.UTC(y2, m2 - 1, d2, 23, 59, 59, 999));

  const orders = (await client.order.findMany({
    where: { deletedAt: null, createdAt: { gte: fromD, lte: toD }, status: { in: COUNTED_STATUSES } },
    orderBy: { createdAt: 'asc' },
    include: {
      agent: { select: { companyName: true, contactName: true } },
      passengers: true,
      costItems: { select: { category: true, amountCny: true } },
      // 清账口径要扣已完成退款——只取 COMPLETED，在途退款钱还没出去，扣了会误判成已退完
      refunds: { where: { status: 'COMPLETED' }, select: { amount: true } },
      items: {
        include: {
          flightSchedule: {
            include: {
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
              seatClasses: { select: { capacity: true } },
            },
          },
          hotelRoomType: { select: { name: true, costPriceCny: true } },
          visa: { select: { costPriceCny: true } },
          transfer: { select: { costPriceCny: true } },
          // 签证任务结构化实际成本（人均 CNY）；每个 VISA item 对应一条 VISA_APPLICATION 任务
          fulfillmentTasks: { where: { type: 'VISA_APPLICATION' }, select: { type: true, visaUnitCostCny: true } },
        },
      },
    },
  })) as OrderForExport[];

  // 批量预加载所有相关航班的周期，避免每张订单 N+1
  const flightIds = Array.from(
    new Set(
      orders.flatMap((o) =>
        o.items
          .filter((it) => it.kind === 'FLIGHT' && it.flightSchedule)
          .map((it) => it.flightSchedule!.flightId),
      ),
    ),
  );
  const periodsMap = await loadPeriodsByFlightIds(flightIds, client);

  const rows: FinanceRow[] = [];
  for (const o of orders) {
    if (o.passengers.length === 0) continue;
    rows.push(...orderToRows(o, periodsMap));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 财务核对导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('财务核对收入明细');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) ws.addRow(r);

  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function financeExportFilename(range: { from: string; to: string }): string {
  return `财务核对_${range.from}_${range.to}.xlsx`;
}
