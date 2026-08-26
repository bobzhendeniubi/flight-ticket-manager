/**
 * 财务按航班维度 xlsx 导出 — 一行/班次
 *
 * 跟 finances.export.ts 的区别：
 *   - finances.export.ts：按时间段 + 一行/乘客 + 客单核对
 *   - finances.export-by-flight.ts：按航班出发日 + 一行/班次 + 整班 P&L
 *
 * 成本口径（统一 CNY，无汇率）：
 *   包机：FlightSchedule.charterCostCny ÷ totalSeats × soldSeats（已售座位占用）
 *   机场税/燃油/旺季/调整/折扣：cost.service.resolveScheduleCost 取生效值 × soldSeats
 *   房费/签证/车费/订单杂项：从落在该班次上的订单聚合 — 多腿订单按 legCount 平摊避免重复
 *
 * 行级派生：
 *   总成本(不含空座成本) = 上面汇总
 *   整班毛利            = 总收入 - 总成本
 *   单座成本             = charter ÷ totalSeats（财务口径；totalSeats=0 时 null）
 *   空座成本             = 单座成本 × (totalSeats - soldSeats)（不计入已售座位成本）
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

interface FlightRow {
  flightNumber: string;
  route: string;
  departDate: string;
  totalSeats: number;
  soldSeats: number;
  loadFactor: number; // 0..1
  flightRevenue: number;
  otherRevenue: number;
  totalRevenue: number;
  charterCost: number;
  airportTaxDepCost: number;
  airportTaxArrCost: number;
  fuelCost: number;
  peakSurchargeCost: number;
  aircraftAdjustCost: number;
  takeoffDiscountCost: number;
  hotelCost: number;
  visaCost: number;
  transferCost: number;
  miscOrderCost: number; // 订单 OrderCostItem 汇总（4 类合一）
  totalCost: number;
  grossMargin: number;
  perSeatCost: number | null;
  emptySeatCost: number | null;
}

const COLUMNS: Array<{ header: string; key: keyof FlightRow; width: number }> = [
  { header: '航班号', key: 'flightNumber', width: 12 },
  { header: '路线', key: 'route', width: 14 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '总座', key: 'totalSeats', width: 8 },
  { header: '已售', key: 'soldSeats', width: 8 },
  { header: '载客率', key: 'loadFactor', width: 10 },
  { header: '机票收入', key: 'flightRevenue', width: 12 },
  { header: '其他收入', key: 'otherRevenue', width: 12 },
  { header: '总收入', key: 'totalRevenue', width: 12 },
  { header: '包机成本', key: 'charterCost', width: 12 },
  { header: '机场税去', key: 'airportTaxDepCost', width: 12 },
  { header: '机场税回', key: 'airportTaxArrCost', width: 12 },
  { header: '燃油', key: 'fuelCost', width: 10 },
  { header: '旺季附加', key: 'peakSurchargeCost', width: 12 },
  { header: '机型调整', key: 'aircraftAdjustCost', width: 12 },
  { header: '起降折扣/机场补贴', key: 'takeoffDiscountCost', width: 14 },
  { header: '房费', key: 'hotelCost', width: 12 },
  { header: '签证费', key: 'visaCost', width: 12 },
  { header: '车费', key: 'transferCost', width: 12 },
  { header: '杂项成本', key: 'miscOrderCost', width: 12 },
  { header: '总成本(不含空座成本)', key: 'totalCost', width: 18 },
  { header: '整班毛利', key: 'grossMargin', width: 12 },
  { header: '单座成本(÷总座)', key: 'perSeatCost', width: 16 },
  { header: '空座成本', key: 'emptySeatCost', width: 12 },
];

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 一张订单可有多条 FLIGHT 腿（去程+回程）。按腿数把订单级商品成本/收入平摊到每条腿，
 * 避免在该腿对应班次的合计里重复计入同一份酒店/签证/车费/杂项。
 */
function countFlightLegs(items: Array<{ kind: string }>): number {
  return Math.max(1, items.filter((it) => it.kind === 'FLIGHT').length);
}

export async function buildFinanceExportByFlightWorkbook(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const [y1, m1, d1] = range.from.split('-').map((x) => parseInt(x, 10));
  const [y2, m2, d2] = range.to.split('-').map((x) => parseInt(x, 10));
  const fromD = new Date(Date.UTC(y1, m1 - 1, d1, 0, 0, 0, 0));
  const toD = new Date(Date.UTC(y2, m2 - 1, d2, 23, 59, 59, 999));

  // 1) 拉范围内所有班次（含座位）
  const schedules = await client.flightSchedule.findMany({
    where: { departureTime: { gte: fromD, lte: toD } },
    orderBy: { departureTime: 'asc' },
    include: {
      flight: { select: { id: true, flightNumber: true, originCode: true, destinationCode: true } },
      seatClasses: { select: { capacity: true, sold: true } },
    },
  });

  if (schedules.length === 0) {
    return renderWorkbook([]);
  }

  const scheduleIds = schedules.map((s) => s.id);

  // 2) 找出落在这些班次上的所有 FLIGHT items，拿到 orderId 集合
  const flightItems = await client.orderItem.findMany({
    where: {
      flightScheduleId: { in: scheduleIds },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: { orderId: true, flightScheduleId: true },
  });
  const orderIdsSet = new Set(flightItems.map((it) => it.orderId));
  const orderIds = Array.from(orderIdsSet);

  // 3) 完整加载这些订单 + items + costItems + 乘客数
  const orders =
    orderIds.length === 0
      ? []
      : await client.order.findMany({
          where: { id: { in: orderIds } },
          include: {
            passengers: { select: { id: true, visaExempt: true } },
            costItems: { select: { category: true, amountCny: true } },
            items: {
              include: {
                hotelRoomType: { select: { costPriceCny: true } },
                visa: { select: { costPriceCny: true } },
                transfer: { select: { costPriceCny: true } },
                fulfillmentTasks: {
                  where: { type: 'VISA_APPLICATION' },
                  select: { visaUnitCostCny: true },
                },
              },
            },
          },
        });
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // 4) 周期预加载（航班维度的成本生效解析）
  const flightIds = Array.from(new Set(schedules.map((s) => s.flight.id)));
  const periodsMap = await loadPeriodsByFlightIds(flightIds, client);

  // 5) 每个班次聚合
  const rows: FlightRow[] = schedules.map<FlightRow>((s) => {
    const totalSeats = s.seatClasses.reduce((a, c) => a + c.capacity, 0);
    const soldSeats = s.seatClasses.reduce((a, c) => a + c.sold, 0);
    const periodsForFlight = periodsMap.get(s.flight.id) ?? [];
    const matched = findMatchedPeriod(s, periodsForFlight);
    const eff = resolveScheduleCost(s, matched);

    // 包机成本：单座 × 已售；空座成本单列。
    // 财务口径：包机费÷全部座位，空座成本单列。
    const charterPerSeat =
      eff.charterCostCny != null && totalSeats > 0 ? eff.charterCostCny / totalSeats : null;
    const charterCost = (charterPerSeat ?? 0) * soldSeats;
    const emptySeatCost =
      charterPerSeat == null ? null : charterPerSeat * (totalSeats - soldSeats);

    // 其余 per-pax 字段：× 已售座位（座位 = 占用乘客数）
    const airportTaxDepCost = (eff.airportTaxDepCny ?? 0) * soldSeats;
    const airportTaxArrCost = (eff.airportTaxArrCny ?? 0) * soldSeats;
    const fuelCost = (eff.fuelCostCny ?? 0) * soldSeats;
    const peakSurchargeCost = (eff.peakSurchargeCny ?? 0) * soldSeats;
    const aircraftAdjustCost = (eff.aircraftAdjustCny ?? 0) * soldSeats;
    const takeoffDiscountCost = (eff.takeoffDiscountCny ?? 0) * soldSeats;

    // 落在该班次上的订单：聚合机票/其他收入 + 商品成本/杂项成本（按 legCount 摊）
    const ordersOnThisSchedule = Array.from(
      new Set(
        flightItems
          .filter((it) => it.flightScheduleId === s.id)
          .map((it) => it.orderId),
      ),
    );

    let flightRevenue = 0;
    let otherRevenue = 0;
    let hotelCost = 0;
    let visaCost = 0;
    let transferCost = 0;
    let miscOrderCost = 0;
    for (const oid of ordersOnThisSchedule) {
      const o = orderById.get(oid);
      if (!o) continue;
      const legCount = countFlightLegs(o.items);
      // 按 kind 算收入；FLIGHT 收入按腿数平摊（一张往返机票分给两条腿）
      let flightRevOrder = 0;
      let otherRevOrder = 0;
      for (const it of o.items) {
        const amt = dec(it.amount);
        if (it.kind === 'FLIGHT') {
          flightRevOrder += amt / legCount;
        } else {
          otherRevOrder += amt / legCount;
        }
      }
      flightRevenue += flightRevOrder;
      otherRevenue += otherRevOrder;

      // 商品成本：按腿数平摊
      let hotelOrder = 0;
      let visaOrder = 0;
      let transferOrder = 0;
      for (const it of o.items) {
        if (it.kind === 'HOTEL') {
          // 快照优先：随机档（同星级聚合）行没有 hotelRoomTypeId，取不到房型净房价，但建单时
          // 已把房费快照写进 totalCostCny。此前只认 hotelRoomType，随机档行房费整条算 0，
          // 整班毛利凭空虚高——快照是这类行唯一的成本来源，必须先读。
          if (it.totalCostCny != null) {
            hotelOrder += dec(it.totalCostCny);
          } else if (it.hotelRoomType?.costPriceCny != null) {
            let nights = 1;
            if (it.hotelCheckIn && it.hotelCheckOut) {
              nights = Math.max(
                1,
                Math.round(
                  (it.hotelCheckOut.getTime() - it.hotelCheckIn.getTime()) /
                    (1000 * 60 * 60 * 24),
                ),
              );
            }
            hotelOrder += dec(it.hotelRoomType.costPriceCny) * nights * it.quantity;
          }
        } else if (it.kind === 'VISA') {
          // 签证成本与汇总/按乘客导出同口径（visaItemCostCny）：任务实际人均成本 × 需签乘客数
          // 优先 → 录单快照 → 产品主数据。签证公司按航班开账单，此表是对账主战场，口径必须一致。
          const taskCny = it.fulfillmentTasks?.[0]?.visaUnitCostCny;
          const visaPax = o.passengers.filter((p) => !p.visaExempt).length;
          const { cost } = visaItemCostCny({
            taskUnitCostCny: taskCny == null ? null : dec(taskCny),
            visaPax,
            snapshotCny: it.totalCostCny != null ? dec(it.totalCostCny) : null,
            productCostPriceCny: it.visa?.costPriceCny != null ? dec(it.visa.costPriceCny) : null,
            quantity: it.quantity,
          });
          visaOrder += cost;
        } else if (it.kind === 'TRANSFER' && it.transfer) {
          transferOrder += dec(it.transfer.costPriceCny) * it.quantity;
        }
      }
      hotelCost += hotelOrder / legCount;
      visaCost += visaOrder / legCount;
      transferCost += transferOrder / legCount;

      // 杂项（OrderCostItem 5 类合一，含每单固定操作费）：按腿数平摊
      let miscOrder = 0;
      for (const ci of o.costItems) {
        miscOrder += dec(ci.amountCny);
      }
      miscOrderCost += miscOrder / legCount;
    }

    const totalRevenue = flightRevenue + otherRevenue;
    const totalCost =
      charterCost +
      airportTaxDepCost +
      airportTaxArrCost +
      fuelCost +
      peakSurchargeCost +
      aircraftAdjustCost +
      takeoffDiscountCost +
      hotelCost +
      visaCost +
      transferCost +
      miscOrderCost;
    const grossMargin = totalRevenue - totalCost;
    return {
      flightNumber: s.flight.flightNumber,
      route: `${s.flight.originCode}→${s.flight.destinationCode}`,
      departDate: fmtDate(s.departureTime),
      totalSeats,
      soldSeats,
      loadFactor: totalSeats > 0 ? round2(soldSeats / totalSeats) : 0,
      flightRevenue: round2(flightRevenue),
      otherRevenue: round2(otherRevenue),
      totalRevenue: round2(totalRevenue),
      charterCost: round2(charterCost),
      airportTaxDepCost: round2(airportTaxDepCost),
      airportTaxArrCost: round2(airportTaxArrCost),
      fuelCost: round2(fuelCost),
      peakSurchargeCost: round2(peakSurchargeCost),
      aircraftAdjustCost: round2(aircraftAdjustCost),
      takeoffDiscountCost: round2(takeoffDiscountCost),
      hotelCost: round2(hotelCost),
      visaCost: round2(visaCost),
      transferCost: round2(transferCost),
      miscOrderCost: round2(miscOrderCost),
      totalCost: round2(totalCost),
      grossMargin: round2(grossMargin),
      perSeatCost: charterPerSeat == null ? null : round2(charterPerSeat),
      emptySeatCost: emptySeatCost == null ? null : round2(emptySeatCost),
    };
  });

  return renderWorkbook(rows);
}

async function renderWorkbook(rows: FlightRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 财务按航班导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('财务按航班 P&L');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) ws.addRow(r);

  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function financeExportByFlightFilename(range: { from: string; to: string }): string {
  return `按航班_${range.from}_${range.to}.xlsx`;
}
