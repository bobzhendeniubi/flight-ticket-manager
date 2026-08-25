/**
 * 全岗总表的「占位单」表 —— 把无名单库存实体一起导出来对账。
 *
 * 为什么占位单进导出：占位单不是订单（没有乘客名单、没有订单号，转正后才生成订单），
 * 所以按订单口径导出的任何一张表都看不见它。可是当天「留了哪几个团、几号的、多少座」
 * 恰恰要在收工时逐条核对是否漏留 / 留错 —— 只能靠这张表。
 *
 * 口径：
 *   - 选单按**出发日期**（起飞地当地日，与总表主表的出发日期列同口径），不是建单日期。
 *   - 只导仍占座或仍在流程里的状态；已释放 / 已取消的不进表（座位早已回池，不是当天要盯的）。
 *   - 「当前占座」= seats − 已转正 − 已减员，与库存聚合口径逐字一致。
 *   - 「已收」= 未撤销的认款分配合计。
 */
import ExcelJS from 'exceljs';
import { HoldOrderStatus, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { localDateISO, localHHMM } from '../../lib/flight-time.js';
import { HOLD_STATUS_LABEL } from '../hold-orders/hold-status.js';

/** 仍需要盯的状态：占座中 / 逾期 / 全款待转正 / 切位待生效。已释放、已取消、已转正不进表。 */
const EXPORTED_HOLD_STATUSES: HoldOrderStatus[] = [
  HoldOrderStatus.PENDING,
  HoldOrderStatus.HOLDING,
  HoldOrderStatus.OVERDUE,
  HoldOrderStatus.FULLY_PAID,
];

const CABIN_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

export interface HoldExportRow {
  departDate: string;
  departTime: string;
  flightNumber: string;
  route: string;
  groupRef: string;
  groupName: string;
  owner: string;
  ownerType: string;
  cabin: string;
  holdNo: string;
  seats: number;
  converted: number;
  cancelled: number;
  occupying: number;
  perSeatPriceCny: number;
  status: string;
  receivedCny: number;
  createdAt: string;
  notes: string;
}

const COLUMNS: Array<{ header: string; key: keyof HoldExportRow | 'seq'; width: number; note?: string }> = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '出发日期', key: 'departDate', width: 12, note: '起飞地当地日，与主表「出发日期」同口径' },
  { header: '起飞时刻', key: 'departTime', width: 10 },
  { header: '航班号', key: 'flightNumber', width: 10 },
  { header: '航线', key: 'route', width: 12 },
  { header: '团号', key: 'groupRef', width: 16, note: '同一个团的去程 / 回程共用一个团号；团号为空的是加团号之前建的老占位单' },
  { header: '团名', key: 'groupName', width: 18 },
  { header: '归属', key: 'owner', width: 20 },
  { header: '归属类型', key: 'ownerType', width: 10 },
  { header: '舱位', key: 'cabin', width: 10 },
  { header: '占位单号', key: 'holdNo', width: 16 },
  { header: '占位数', key: 'seats', width: 8 },
  { header: '已转正', key: 'converted', width: 8 },
  { header: '已减员', key: 'cancelled', width: 8 },
  { header: '当前占座', key: 'occupying', width: 10, note: '占位数 − 已转正 − 已减员，等于这张单此刻还压着多少公共库存' },
  { header: '锁价(元/人)', key: 'perSeatPriceCny', width: 12 },
  { header: '状态', key: 'status', width: 12 },
  { header: '已收(元)', key: 'receivedCny', width: 12, note: '未撤销的认款分配合计' },
  { header: '建单时间', key: 'createdAt', width: 18 },
  { header: '备注', key: 'notes', width: 24 },
];

function fmtDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * 取出发日期区间内的占位单。区间按起飞地当地日折算：先用权威 SQL（双段 AT TIME ZONE）
 * 解出命中的班次，再按班次取单——不用 UTC 窗口猜，避免跨时区边界漏单。
 */
export async function loadHoldExportRows(
  from: string | undefined,
  to: string | undefined,
  client: PrismaClient = defaultPrisma,
): Promise<HoldExportRow[]> {
  const fromParam = from ?? null;
  const toParam = to ?? null;
  const scheduleRows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM "FlightSchedule" s
    WHERE (${fromParam}::text IS NULL OR (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date >= ${fromParam}::date)
      AND (${toParam}::text IS NULL OR (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date <= ${toParam}::date)
  `;
  const scheduleIds = scheduleRows.map((row) => row.id);
  if (scheduleIds.length === 0) return [];

  const holds = await client.holdOrder.findMany({
    where: { flightScheduleId: { in: scheduleIds }, status: { in: EXPORTED_HOLD_STATUSES } },
    include: {
      seatClass: { select: { cabin: true } },
      agent: { select: { companyName: true, contactName: true } },
      installments: { select: { allocations: { select: { amountCny: true, reversedAt: true } } } },
      flightSchedule: {
        select: {
          departureTime: true,
          departureTz: true,
          flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
        },
      },
    },
    orderBy: [{ flightSchedule: { departureTime: 'asc' } }, { createdAt: 'asc' }],
  });

  return holds.map((hold) => {
    const schedule = hold.flightSchedule;
    const received = hold.installments.reduce(
      (sum, installment) =>
        sum + installment.allocations.reduce((inner, a) => inner + (a.reversedAt ? 0 : Number(a.amountCny)), 0),
      0,
    );
    return {
      departDate: localDateISO(schedule.departureTime, schedule.departureTz),
      departTime: localHHMM(schedule.departureTime, schedule.departureTz),
      flightNumber: schedule.flight.flightNumber,
      route: `${schedule.flight.originCode}→${schedule.flight.destinationCode}`,
      groupRef: hold.groupRef ?? '',
      groupName: hold.groupName ?? '',
      owner: hold.agent?.companyName?.trim() || hold.agent?.contactName || hold.groupName || '直客',
      ownerType: hold.ownerType === 'AGENT' ? '代理' : '直客',
      cabin: CABIN_LABEL[hold.seatClass.cabin] ?? hold.seatClass.cabin,
      holdNo: hold.holdNo,
      seats: hold.seats,
      converted: hold.seatsConverted,
      cancelled: hold.seatsCancelled,
      occupying: hold.seats - hold.seatsConverted - hold.seatsCancelled,
      perSeatPriceCny: hold.perSeatPriceCny,
      status: HOLD_STATUS_LABEL[hold.status] ?? hold.status,
      receivedCny: received,
      createdAt: fmtDateTime(hold.createdAt),
      notes: hold.notes ?? '',
    };
  });
}

/** 把占位单表挂进工作簿；没有数据也建表并写一行说明，避免读表的人误以为导出漏了。 */
export function appendHoldOrderSheet(wb: ExcelJS.Workbook, rows: HoldExportRow[]): void {
  const ws = wb.addWorksheet('占位单');
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  COLUMNS.forEach((c, i) => {
    if (c.note) ws.getRow(1).getCell(i + 1).note = c.note;
  });

  if (rows.length === 0) {
    ws.addRow({ seq: '', departDate: '该区间没有仍占座的占位单' });
  } else {
    rows.forEach((row, index) => ws.addRow({ seq: index + 1, ...row }));
  }
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
}
