/**
 * 分房表导出（成都格式）— 每个入住日期一个 sheet（名 'M-D'，如 '7-10'），
 * sheet 内按酒店分组（自然按酒店名排序，组间不插空行），一行/乘客。
 *
 * 行来源：占房订单行（OrderItem 带 hotelRoomTypeId + hotelCheckIn，含已盖章
 * 酒店明细的 BUNDLE 行）；按订单分组后，每位乘客 correlate 到「他实际占用的那条占房 item」
 * （见 correlateItem）—— 一位乘客恰好一行，不对订单每条占房 item 都遍历全部乘客
 * （同订单多条占房 item 时旧实现会做 item × 乘客笛卡尔积，产生重复行 + 张冠李戴的房型/酒店组合，
 * 已修复，回归覆盖见 orders.export-room-allocation.test.ts）。
 * hotelCheckIn 落在 [from, to] 即归入当日 sheet（同订单多条 item 入住日不同则分归不同 sheet）。
 * 酒店归属优先 order.roomAssignment.roomGroups 的 hotelName（人工分房结果），
 * 否则回落到 correlate 到的 item 上 hotelRoomType.hotel.name。
 *
 * 暂无数据的列（飞行次数/签发日期/升级原因）保留表头、内容留空 —— 与三模板导出同约定。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus, OrderItemKind } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import { getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
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
  /**
   * 该乘客入住日、其所在酒店当晚的销控余量（与房控销控板/导出同口径）：
   *   数字字符串 = 正常余量（可能为负，真超卖）；
   *   "未配"     = 该晚没有任何包房周期覆盖（block=0），不是真超卖，先补配包房；
   *   "—"        = 分房组人工填的酒店名与本行 FK 关联酒店不一致，无法确定归属哪家酒店，绝不瞎标。
   */
  dailyRemaining: string;
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
  { header: '当日余房', key: 'dailyRemaining', width: 12 },
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
      select: {
        hotelId: true;
        name: true;
        bedType: true;
        capacity: true;
        hotel: { select: { name: true } };
      };
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
 * 「中文名称」列取值优先级：
 *   1. Passenger.chineseName（OCR 识别或手工填写），trim 后非空才采用；
 *   2. fullName 本身含中文（直客常直接把中文名录入 fullName）→ 用 fullName；
 *   3. 都不满足（多数国际票 fullName 是拼音，如 "YANG, MIAOMIAO"）→ 留空，
 *      让操作部一眼看出谁还没录中文名，而不是把拼音误当中文名展示。
 */
function resolveChineseName(p: { chineseName?: string | null; fullName: string }): string {
  const cn = p.chineseName?.trim();
  if (cn) return cn;
  if (/[一-鿿]/u.test(p.fullName)) return p.fullName;
  return '';
}

/** 占房 item 上 hotelCheckIn / hotelRoomType 均非空后的窄化类型（correlate 阶段用）。*/
type AllocatableItem = RoomItemForExport & {
  hotelCheckIn: NonNullable<RoomItemForExport['hotelCheckIn']>;
  hotelRoomType: NonNullable<RoomItemForExport['hotelRoomType']>;
};

function isAllocatable(it: RoomItemForExport): it is AllocatableItem {
  return it.hotelCheckIn != null && it.hotelRoomType != null;
}

/**
 * 把一位乘客 correlate 到「他实际占用的那条占房 item」——同订单可能有多条占房 item
 * （如两种房型 / 跨酒店），不能对每条 item 都遍历全部乘客（会产生重复行 + 张冠李戴，
 * 见本文件顶部 JSDoc 的回归说明）。
 *   - 单条 item 的订单：无歧义，直接用它（兼容未分房乘客的老口径——单房型订单里
 *     谁都在这一间/这一批房源里，不需要 roomGroup 也能归属）。
 *   - 多条 item 的订单：优先用 roomGroup.hotelName（+ roomType 更精确）匹配到对应 item；
 *     分房组酒店名在本单占房 item 里找不到匹配（人工填写与 FK 不同步）、或压根没分房——
 *     无法可靠 correlate，兜底用订单第一条占房 item（保证每位乘客恰好一行，不重复也不丢单；
 *     「归属哪家酒店」在此兜底下是尽力而为，dailyRemaining 会用「—」标出这种不确定性）。
 */
function correlateItem(
  group: RoomGroup | undefined,
  orderItems: readonly AllocatableItem[],
): AllocatableItem {
  if (orderItems.length === 1) return orderItems[0];
  if (group) {
    const exact = orderItems.find(
      (it) =>
        it.hotelRoomType.hotel.name === group.hotelName &&
        (!group.roomType ||
          it.hotelRoomType.name === group.roomType ||
          it.hotelRoomType.bedType === group.roomType),
    );
    if (exact) return exact;
    const byHotelOnly = orderItems.find((it) => it.hotelRoomType.hotel.name === group.hotelName);
    if (byHotelOnly) return byHotelOnly;
  }
  return orderItems[0];
}

/**
 * 把占房订单行展开为按入住日期分 sheet 的行集合（纯函数，便于单测）。
 *
 * 行排序：按归属酒店名（roomGroup.hotelName 优先）zh-CN 排序，再按房间号 —— 同房乘客相邻。
 * 房间号分配（per 入住日期 × 酒店）：
 *   - 已分房：同一 roomGroup.id 共用一个房号（半间/拼房组房号标 "房N(½)"）。
 *   - 未分房：按房型容量顺序打包（每满一间开下一间），房号续在已分房之后。
 *
 * 乘客 ↔ item correlate（见 correlateItem）：一位乘客恰好产出一行，不做 item × 乘客笛卡尔积。
 */
export function buildRoomAllocationSheets(
  items: RoomItemForExport[],
  remainingLookup: Map<string, string> = new Map(),
): RoomAllocationSheet[] {
  // 先按订单分组占房 item（同订单可能有多条，需要整单一起 correlate 乘客归属）
  const itemsByOrder = new Map<string, AllocatableItem[]>();
  for (const it of items) {
    if (!isAllocatable(it)) continue;
    const list = itemsByOrder.get(it.orderId) ?? [];
    list.push(it);
    itemsByOrder.set(it.orderId, list);
  }

  // 中间形态（未编房号/序号），按入住日期聚
  const byDate = new Map<string, RoomEntry[]>();

  for (const orderItems of itemsByOrder.values()) {
    const order = orderItems[0].order;
    const roomGroups = parseRoomGroups(order.roomAssignment);
    const agency = order.agent?.companyName ?? '直客';

    // 出发(往返)日期：订单全部 FLIGHT 行的出发日（去重升序）；无航班回落各自入住日
    const flightDates = Array.from(
      new Set(
        order.items
          .filter((x) => x.kind === 'FLIGHT' && x.flightSchedule)
          .map((x) => fmtDate(x.flightSchedule!.departureTime)),
      ),
    ).sort();

    for (const p of order.passengers) {
      const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
      const it = correlateItem(group, orderItems);
      const checkInStr = fmtDate(it.hotelCheckIn);
      const fkHotelName = it.hotelRoomType.hotel.name;
      const hotelName = group?.hotelName || fkHotelName;
      // 房型容量（未分房乘客打包用）；fixture/缺数据回落 2 人/间
      const capacity =
        it.hotelRoomType.capacity && it.hotelRoomType.capacity > 0 ? it.hotelRoomType.capacity : 2;
      const travelDates = flightDates.length > 0 ? flightDates.join(' / ') : checkInStr;

      // 分了房用 roomGroup 的房型（回落乘客床型偏好）；没分房回落 correlate 到的 item 房型床型
      const assignedRoomType = group ? group.roomType || p.bedPref || '' : '';
      const roomType = assignedRoomType || it.hotelRoomType.bedType || '';
      const isHalf = !!group && group.roomFraction === 0.5;
      // 半间/拼房标记：roomFraction === 0.5 时在备注里点出（整间/缺省不标）
      const halfRoomNote = isHalf ? '半间/拼房' : '';
      const notes = [group?.notes, order.notes, halfRoomNote].filter(Boolean).join(' / ');

      // 当日余房：分房组人工填的酒店名与 correlate 到的 item FK 关联酒店不一致时，
      // 无法确定该按哪家酒店的余量算——绝不瞎标，直接 "—"（见文件顶部 JSDoc 归属优先级说明）。
      const hotelNameTrusted = !group?.hotelName || group.hotelName === fkHotelName;
      const dailyRemaining =
        hotelNameTrusted && it.hotelRoomType.hotelId
          ? (remainingLookup.get(`${it.hotelRoomType.hotelId}|${checkInStr}`) ?? '—')
          : '—';

      const row: Omit<RoomAllocationRow, 'seq' | 'roomNo'> = {
        agency,
        hotelType: `${hotelName} · ${it.hotelRoomType.name}`,
        chineseName: resolveChineseName(p),
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
        dailyRemaining,
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
 * 「当日余房」列取数：按 (hotelId, 入住日) 去重后批量查——同一酒店的多个入住日合并成一次
 * getHotelNightlyRemaining 调用（内部一次 findMany 拉全部周期/占房行），而不是每个 (hotel,date)
 * 各查一次，减少导出跨度内（≤14 天，ROOM_ALLOCATION_MAX_DAYS）的查库次数。
 * 返回 `${hotelId}|${YYYY-MM-DD}` → 展示串（数字 / "未配" block=0 未覆盖 / 缺省未收录）。
 */
async function buildDailyRemainingLookup(
  items: RoomItemForExport[],
  client: PrismaClient,
): Promise<Map<string, string>> {
  const datesByHotel = new Map<string, Set<string>>();
  for (const it of items) {
    const hotelId = it.hotelRoomType?.hotelId;
    if (!hotelId || !it.hotelCheckIn) continue;
    const set = datesByHotel.get(hotelId) ?? new Set<string>();
    set.add(fmtDate(it.hotelCheckIn));
    datesByHotel.set(hotelId, set);
  }

  const perHotel = await Promise.all(
    Array.from(datesByHotel.entries()).map(async ([hotelId, dateSet]) => {
      const dates = Array.from(dateSet).sort();
      const { remaining, block, hasBlock } = await getHotelNightlyRemaining(hotelId, dates, client);
      return { hotelId, dates, remaining, block, hasBlock };
    }),
  );

  const lookup = new Map<string, string>();
  for (const { hotelId, dates, remaining, block, hasBlock } of perHotel) {
    dates.forEach((date, i) => {
      const key = `${hotelId}|${date}`;
      if (!hasBlock || block[i] === 0) {
        lookup.set(key, '未配');
      } else {
        lookup.set(key, String(remaining[i]));
      }
    });
  }
  return lookup;
}

/** 占房 item 取数的统一 include（区间口径 / 按出发日口径共用，保证行映射字段一致）。*/
const ROOM_ITEM_INCLUDE = {
  hotelRoomType: {
    select: {
      hotelId: true,
      name: true,
      bedType: true,
      capacity: true,
      hotel: { select: { name: true } },
    },
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
} satisfies Prisma.OrderItemInclude;

/** 按入住日 [from, to] 选占房 item（旧口径：sheet 覆盖的入住日就是选中的入住日）。*/
async function queryRoomItemsByCheckInRange(
  from: string,
  to: string,
  client: PrismaClient,
): Promise<RoomItemForExport[]> {
  if (from > to) {
    throw new BadRequestError('起始日不能晚于结束日');
  }
  const fromD = toDateOnly(from);
  const toD = toDateOnly(to);
  const days = Math.floor((toD.getTime() - fromD.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (days > ROOM_ALLOCATION_MAX_DAYS) {
    throw new BadRequestError(`分房表导出跨度最多 ${ROOM_ALLOCATION_MAX_DAYS} 天`);
  }
  return (await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelCheckIn: { gte: fromD, lte: toD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    orderBy: { createdAt: 'asc' },
    include: ROOM_ITEM_INCLUDE,
  })) as RoomItemForExport[];
}

/**
 * 按「出发日」选占房 item（新口径）：先选出该日出发的订单，再导出这些订单的**全部**入住晚
 * （不再按入住日切范围）——一张订单跨几晚就产出几个 sheet 上的行。
 *
 * 「该日出发」判定与 sheet 上「出发(往返)日期」列同口径（都用 UTC 日历日，见 fmtDate）：
 *   - 主口径：订单任一 FLIGHT 行所在班次 departureTime 落在该 UTC 日（[dayStart, 次日) 半开区间；
 *     departureTime 是含时刻的 UTC 时间戳）。
 *   - 回落：订单**没有任何**挂了班次的 FLIGHT 行（纯酒店/未挂班次的套餐）时，按其占房 item 的
 *     hotelCheckIn == 该日选中（套餐酒店盖章 hotelCheckIn 通常 = 出发日）。这与行映射里
 *     travelDates「有航班用航班日、否则回落入住日」的回落规则一致。
 */
async function queryRoomItemsByDepartDate(
  departDate: string,
  client: PrismaClient,
): Promise<RoomItemForExport[]> {
  const dayStart = toDateOnly(departDate);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return (await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      order: {
        deletedAt: null, // 排除已软删订单
        status: { in: COUNTED_STATUSES },
        OR: [
          {
            items: {
              some: {
                kind: OrderItemKind.FLIGHT,
                flightSchedule: { departureTime: { gte: dayStart, lt: dayEnd } },
              },
            },
          },
          {
            AND: [
              { items: { none: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } } },
              { items: { some: { hotelRoomTypeId: { not: null }, hotelCheckIn: dayStart } } },
            ],
          },
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
    include: ROOM_ITEM_INCLUDE,
  })) as RoomItemForExport[];
}

/** 把占房 item 集合渲染成分房表 xlsx（区间/出发日两口径共用的收尾）。*/
async function buildWorkbookFromItems(
  items: RoomItemForExport[],
  client: PrismaClient,
): Promise<Buffer> {
  const remainingLookup = await buildDailyRemainingLookup(items, client);
  const sheets = buildRoomAllocationSheets(items, remainingLookup);

  const wb = new ExcelJS.Workbook();
  wb.creator = '分房表导出';
  wb.created = new Date();

  for (const sheet of sheets) {
    addSheet(wb, sheet.name, sheet.rows);
  }
  // 没有任何占房数据 — 仍出一个带表头的空 sheet（无 sheet 的 xlsx 非法）
  if (sheets.length === 0) {
    addSheet(wb, '无数据', []);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 构建分房表 xlsx。两种选单口径二选一：
 * @param params `{ from, to }` 入住日区间（含两端，YYYY-MM-DD；跨度超 14 天抛 400）；
 *               或 `{ departDate }` 按出发日选订单、导出其全部入住晚（YYYY-MM-DD）。
 * @param client 可选注入用于测试；缺省取默认 prisma
 */
export async function buildRoomAllocationWorkbook(
  params: { from: string; to: string } | { departDate: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const items =
    'departDate' in params
      ? await queryRoomItemsByDepartDate(params.departDate, client)
      : await queryRoomItemsByCheckInRange(params.from, params.to, client);
  return buildWorkbookFromItems(items, client);
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

/** 文件名（按出发日口径）：`分房表_出发{departDate}.xlsx`。*/
export function roomAllocationExportFilenameByDepart(departDate: string): string {
  return `分房表_出发${departDate}.xlsx`;
}
