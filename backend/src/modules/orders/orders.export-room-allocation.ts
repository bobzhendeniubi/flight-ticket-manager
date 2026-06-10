/**
 * 分房表导出（成都格式）— 每个入住日期一个 sheet（名 'M-D'，如 '7-10'），
 * sheet 内按酒店分组（自然按酒店名排序，组间不插空行），一行/乘客。
 *
 * 行来源：占房订单行（OrderItem 带 hotelRoomTypeId + hotelCheckIn，含已盖章
 * 酒店明细的 BUNDLE 行）× 该订单全部乘客；hotelCheckIn 落在 [from, to] 即归入当日 sheet。
 * 酒店归属优先 order.roomAssignment.roomGroups 的 hotelName（人工分房结果），
 * 否则回落到行上 hotelRoomType.hotel.name。
 *
 * 暂无数据的列（飞行次数/签发日期/升级原因）保留表头、内容留空 —— 与三模板导出同约定。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import { fmtDateDMYDash, pnrName } from './orders.export-templates.js';

/** 与财务/订单导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入。*/
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

/** 导出最长跨度（天）— 超出直接 400，导出不做静默截断。*/
export const ROOM_ALLOCATION_MAX_DAYS = 14;

const GENDER_MF: Record<string, string> = { MALE: 'M', FEMALE: 'F' };

export interface RoomAllocationRow {
  seq: number;
  agency: string;
  hotelType: string;
  chineseName: string;
  pnrName: string;
  flightCount: string; // 系统暂无数据 — 留空
  travelDates: string; // 'YYYY-MM-DD / YYYY-MM-DD'
  dateOfBirth: string; // dd-mm-yyyy
  gender: string; // M / F
  documentNumber: string;
  issueDate: string; // 系统暂无数据 — 留空
  passportExpiry: string; // dd-mm-yyyy
  roomType: string;
  notes: string;
  upgradeReason: string; // 系统暂无数据 — 留空
}

const COLUMNS: Array<{ header: string; key: keyof RoomAllocationRow; width: number }> = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '酒店类型', key: 'hotelType', width: 26 },
  { header: '中文名称', key: 'chineseName', width: 12 },
  { header: '乘客姓名', key: 'pnrName', width: 20 },
  { header: '飞行次数', key: 'flightCount', width: 10 },
  { header: '出发(往返)日期', key: 'travelDates', width: 26 },
  { header: '乘客生日', key: 'dateOfBirth', width: 12 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '证件编号', key: 'documentNumber', width: 16 },
  { header: '签发日期', key: 'issueDate', width: 12 },
  { header: '有效日期', key: 'passportExpiry', width: 12 },
  { header: '房型', key: 'roomType', width: 14 },
  { header: '备注', key: 'notes', width: 24 },
  { header: '升级原因', key: 'upgradeReason', width: 12 },
];

/** 拼房分配 JSON（Order.roomAssignment.roomGroups 的单组）。*/
interface RoomGroup {
  id: string;
  hotelName: string;
  roomType: string;
  passengerIds: string[];
  notes?: string;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function toDateOnly(s: string): Date {
  // 'YYYY-MM-DD' → UTC midnight，与 Prisma @db.Date 存取口径一致
  return new Date(`${s}T00:00:00.000Z`);
}

/** 'YYYY-MM-DD' → sheet 名 'M-D'（如 '2026-07-10' → '7-10'）。*/
function sheetNameForDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}-${Number(d)}`;
}

/** 防御式解析 roomAssignment JSON；形状不符直接当无分配处理。*/
function parseRoomGroups(roomAssignment: unknown): RoomGroup[] {
  if (roomAssignment == null || typeof roomAssignment !== 'object') return [];
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups)) return [];
  return groups.filter(
    (g): g is RoomGroup =>
      g != null &&
      typeof g === 'object' &&
      Array.isArray((g as { passengerIds?: unknown }).passengerIds),
  );
}

export type RoomItemForExport = Prisma.OrderItemGetPayload<{
  include: {
    hotelRoomType: {
      select: { name: true; bedType: true; hotel: { select: { name: true } } };
    };
    order: {
      include: {
        agent: { select: { companyName: true } };
        passengers: true;
        items: {
          select: {
            kind: true;
            flightSchedule: { select: { departureTime: true } };
          };
        };
      };
    };
  };
}>;

export interface RoomAllocationSheet {
  /** sheet 名 'M-D'，如 '7-10' */
  name: string;
  /** 入住日 YYYY-MM-DD（排序用） */
  date: string;
  rows: RoomAllocationRow[];
}

/**
 * 把占房订单行展开为按入住日期分 sheet 的行集合（纯函数，便于单测）。
 * 行排序：按归属酒店名（roomGroup.hotelName 优先）zh-CN 排序，组内保持取数顺序。
 */
export function buildRoomAllocationSheets(items: RoomItemForExport[]): RoomAllocationSheet[] {
  // 行先不带序号，按 (date, hotelName) 聚 → 排序后再编号
  const byDate = new Map<string, Array<{ hotelName: string; row: Omit<RoomAllocationRow, 'seq'> }>>();

  for (const it of items) {
    if (!it.hotelCheckIn || !it.hotelRoomType) continue;
    const checkInStr = fmtDate(it.hotelCheckIn);
    const order = it.order;
    const roomGroups = parseRoomGroups(order.roomAssignment);
    const agency = order.agent?.companyName ?? '直客';

    // 出发(往返)日期：订单全部 FLIGHT 行的出发日（去重升序）；无航班回落入住日
    const flightDates = Array.from(
      new Set(
        order.items
          .filter((x) => x.kind === 'FLIGHT' && x.flightSchedule)
          .map((x) => fmtDate(x.flightSchedule!.departureTime)),
      ),
    ).sort();
    const travelDates = flightDates.length > 0 ? flightDates.join(' / ') : checkInStr;

    for (const p of order.passengers) {
      const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
      const hotelName = group?.hotelName || it.hotelRoomType.hotel.name;
      // 分了房用 roomGroup 的房型（回落乘客床型偏好）；没分房回落行上房型床型
      const assignedRoomType = group ? group.roomType || p.bedPref || '' : '';
      const roomType = assignedRoomType || it.hotelRoomType.bedType || '';
      const notes = [group?.notes, order.notes].filter(Boolean).join(' / ');

      const row: Omit<RoomAllocationRow, 'seq'> = {
        agency,
        hotelType: `${hotelName} · ${it.hotelRoomType.name}`,
        chineseName: p.fullName,
        pnrName: pnrName(p),
        flightCount: '',
        travelDates,
        dateOfBirth: fmtDateDMYDash(p.dateOfBirth),
        gender: p.gender ? GENDER_MF[p.gender] ?? '' : '',
        documentNumber: p.documentNumber,
        issueDate: '',
        passportExpiry: fmtDateDMYDash(p.passportExpiry),
        roomType,
        notes,
        upgradeReason: '',
      };

      const list = byDate.get(checkInStr) ?? [];
      list.push({ hotelName, row });
      byDate.set(checkInStr, list);
    }
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => {
      // 按酒店名分组（稳定排序，组间无空行），再编 per-sheet 序号
      const sorted = [...entries].sort((a, b) => a.hotelName.localeCompare(b.hotelName, 'zh-CN'));
      return {
        name: sheetNameForDate(date),
        date,
        rows: sorted.map((e, i) => ({ seq: i + 1, ...e.row })),
      };
    });
}

/**
 * 构建分房表 xlsx。
 * @param range  入住日期范围 [from, to]（含两端，YYYY-MM-DD）；跨度超 14 天抛 400
 * @param client 可选注入用于测试；缺省取默认 prisma
 */
export async function buildRoomAllocationWorkbook(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  if (range.from > range.to) {
    throw new BadRequestError('起始日不能晚于结束日');
  }
  const fromD = toDateOnly(range.from);
  const toD = toDateOnly(range.to);
  const days = Math.floor((toD.getTime() - fromD.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (days > ROOM_ALLOCATION_MAX_DAYS) {
    throw new BadRequestError(`分房表导出跨度最多 ${ROOM_ALLOCATION_MAX_DAYS} 天`);
  }

  const items = (await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelCheckIn: { gte: fromD, lte: toD },
      order: { status: { in: COUNTED_STATUSES } },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      hotelRoomType: {
        select: { name: true, bedType: true, hotel: { select: { name: true } } },
      },
      order: {
        include: {
          agent: { select: { companyName: true } },
          passengers: true,
          items: {
            select: {
              kind: true,
              flightSchedule: { select: { departureTime: true } },
            },
          },
        },
      },
    },
  })) as RoomItemForExport[];

  const sheets = buildRoomAllocationSheets(items);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 分房表导出';
  wb.created = new Date();

  for (const sheet of sheets) {
    addSheet(wb, sheet.name, sheet.rows);
  }
  // 范围内没有任何占房数据 — 仍出一个带表头的空 sheet（无 sheet 的 xlsx 非法）
  if (sheets.length === 0) {
    addSheet(wb, '无数据', []);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function addSheet(wb: ExcelJS.Workbook, name: string, rows: RoomAllocationRow[]): void {
  const ws = wb.addWorksheet(name);
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) ws.addRow(r);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

/** 文件名：`分房表_{from}.xlsx`（单日）/ `分房表_{from}_{to}.xlsx`（区间）。*/
export function roomAllocationExportFilename(from: string, to: string): string {
  return from === to ? `分房表_${from}.xlsx` : `分房表_${from}_${to}.xlsx`;
}
