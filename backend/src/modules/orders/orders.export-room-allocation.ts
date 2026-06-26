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

const GENDER_MF: Record<string, string> = { M: 'M', F: 'F' };

export interface RoomAllocationRow {
  seq: number;
  agency: string;
  hotelType: string;
  roomNo: string; // 房间号（同房同号；半间/拼房组标 "房N(½)"）
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
  { header: '房间号', key: 'roomNo', width: 10 },
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
export interface RoomGroup {
  id: string;
  hotelName: string;
  roomType: string;
  passengerIds: string[];
  notes?: string;
  /** 该组占房间数：0.5 = 半间/拼房（与他人合住一间），1 = 整间。缺省视为整间。*/
  roomFraction?: number;
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
export function parseRoomGroups(roomAssignment: unknown): RoomGroup[] {
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
      select: { name: true; bedType: true; capacity: true; hotel: { select: { name: true } } };
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

/** 单条乘客行的中间形态（带分房/容量信息，供分配房间号后再排序编号）。*/
interface RoomEntry {
  hotelName: string;
  /** 人工分房组 id；未分房为 null（同 id 同房间）。*/
  groupId: string | null;
  /** 半间/拼房组（roomFraction === 0.5）→ 房号标 (½)。*/
  isHalf: boolean;
  /** 该乘客所在房型容量（用于未分房乘客按容量打包；缺省 2）。*/
  capacity: number;
  /** 分配后的房间序号（per hotel；排序用）。*/
  roomOrder: number;
  row: Omit<RoomAllocationRow, 'seq' | 'roomNo'>;
}

/** 把整数房号转为展示串："房N"，半间组加 (½)。*/
function formatRoomNo(order: number, isHalf: boolean): string {
  return isHalf ? `房${order}(½)` : `房${order}`;
}

/**
 * 把占房订单行展开为按入住日期分 sheet 的行集合（纯函数，便于单测）。
 *
 * 行排序：按归属酒店名（roomGroup.hotelName 优先）zh-CN 排序，再按房间号 —— 同房乘客相邻。
 * 房间号分配（per 入住日期 × 酒店）：
 *   - 已分房：同一 roomGroup.id 共用一个房号（半间/拼房组房号标 "房N(½)"）。
 *   - 未分房：按房型容量顺序打包（每满一间开下一间），房号续在已分房之后。
 */
export function buildRoomAllocationSheets(items: RoomItemForExport[]): RoomAllocationSheet[] {
  // 先收集中间形态（未编房号/序号），按入住日期聚
  const byDate = new Map<string, RoomEntry[]>();

  for (const it of items) {
    if (!it.hotelCheckIn || !it.hotelRoomType) continue;
    const checkInStr = fmtDate(it.hotelCheckIn);
    const order = it.order;
    const roomGroups = parseRoomGroups(order.roomAssignment);
    const agency = order.agent?.companyName ?? '直客';
    // 房型容量（未分房乘客打包用）；fixture/缺数据回落 2 人/间
    const capacity = it.hotelRoomType.capacity && it.hotelRoomType.capacity > 0
      ? it.hotelRoomType.capacity
      : 2;

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
      const isHalf = !!group && group.roomFraction === 0.5;
      // 半间/拼房标记：roomFraction === 0.5 时在备注里点出（整间/缺省不标）
      const halfRoomNote = isHalf ? '半间/拼房' : '';
      const notes = [group?.notes, order.notes, halfRoomNote].filter(Boolean).join(' / ');

      const row: Omit<RoomAllocationRow, 'seq' | 'roomNo'> = {
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
      list.push({ hotelName, groupId: group?.id ?? null, isHalf, capacity, roomOrder: 0, row });
      byDate.set(checkInStr, list);
    }
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => {
      assignRoomNumbers(entries);
      // 按酒店名（zh-CN）→ 房间号排序：同房乘客相邻；再编 per-sheet 序号
      const sorted = [...entries].sort(
        (a, b) => a.hotelName.localeCompare(b.hotelName, 'zh-CN') || a.roomOrder - b.roomOrder,
      );
      return {
        name: sheetNameForDate(date),
        date,
        rows: sorted.map((e, i) => ({
          seq: i + 1,
          roomNo: formatRoomNo(e.roomOrder, e.isHalf),
          ...e.row,
        })),
      };
    });
}

/**
 * 给同一入住日期内的乘客分配房间号（per 酒店，按取数顺序）。就地写回 entry.roomOrder。
 *   - 已分房：同 groupId 共用一个房号（首次出现时分配）。
 *   - 未分房：按容量打包（每满 capacity 人开下一间），续在已分房之后。
 */
function assignRoomNumbers(entries: RoomEntry[]): void {
  // 每个酒店各自的分配状态
  const perHotel = new Map<
    string,
    { next: number; groupRoom: Map<string, number>; openRoom: number | null; openLeft: number }
  >();

  for (const e of entries) {
    let st = perHotel.get(e.hotelName);
    if (!st) {
      st = { next: 1, groupRoom: new Map(), openRoom: null, openLeft: 0 };
      perHotel.set(e.hotelName, st);
    }

    if (e.groupId) {
      // 已分房：同组复用房号；首次出现分配新号
      let room = st.groupRoom.get(e.groupId);
      if (room === undefined) {
        room = st.next++;
        st.groupRoom.set(e.groupId, room);
      }
      e.roomOrder = room;
    } else {
      // 未分房：按容量打包到当前开放房间；满则开新房
      if (st.openRoom === null || st.openLeft <= 0) {
        st.openRoom = st.next++;
        st.openLeft = e.capacity;
      }
      e.roomOrder = st.openRoom;
      st.openLeft -= 1;
    }
  }
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
        select: { name: true, bedType: true, capacity: true, hotel: { select: { name: true } } },
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
  wb.creator = '分房表导出';
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
