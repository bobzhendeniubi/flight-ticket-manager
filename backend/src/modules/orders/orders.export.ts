/**
 * 整班机订单导出 — 一行/乘客（ops 用，不含成本/毛利）。
 *
 * 用户场景：运营要按某个航班班次（scheduleId）拉所有订单的明细，
 * 用于全班机的乘客 / 房型 / 签证 / 接送清单核对。
 * 与 finances.export.ts 不同：财务向是按时间段 + 含成本/毛利；这个是按班次 + 纯订单字段。
 */
import ExcelJS from 'exceljs';
import { localDateISO } from '../../lib/flight-time.js';
import { businessDateTime } from '../../lib/business-time.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { toAlpha3 } from './nationality.js';
import { countIssuedPassengers, getScheduleSeatCapacity } from './ticketing-cap.js';
import {
  assignRoomNumbers,
  buildDailyRemainingLookup,
  correlateItem,
  describeRoomItem,
  formatRoomNo,
  isAttributedTo,
  parseRoomGroups,
  type RoomNumberEntry,
} from './orders.export-room-allocation.js';
import { nameWithTitle } from './orders.export-templates.js';
import { formatOrderLegStatus, isReturnCurrentlyReleased } from './orders.leg-status.js';

/**
 * 整班运营导出口径（SEAT_HOLDING）：所有「占座中」订单。
 * 排除：DRAFT / CANCELLED / PAYMENT_TIMEOUT / FAILED / REFUND_REQUESTED / REFUNDED。
 * 与房控/开票额度的运营库存口径一致，但查询维度不同（班次 vs 时间段）。
 */
const SEAT_HOLDING_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

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

const GENDER_LABEL: Record<string, string> = { M: '男', F: '女', X: '其他' };

interface OrderRow {
  orderNumber: string;
  status: string;
  agency: string;
  contactName: string;
  contactPhone: string;
  // 乘客
  chineseName: string;
  passportIssueDate: string;
  passportIssuePlace: string;
  placeOfBirth: string;
  pnrName: string;
  gender: string;
  dateOfBirth: string;
  documentNumber: string;
  nationality: string;
  passportExpiry: string;
  // 航班
  flightNumbers: string;
  departDate: string;
  /** 回程日期；回程座位已释放时写「已释放」（留空会被当成单程单，看不出座位已放回库存）。 */
  returnDate: string;
  /** 航段状态：去程未登机 / 回程座位已释放 / 回程已恢复（超售 N 座）/ 回程已作废；正常单留空。 */
  legStatus: string;
  route: string;
  // 产品
  bundleName: string;
  hotelName: string;
  hotelInfo: string;
  visaInfo: string;
  transferInfo: string;
  // 财务（无成本，只有客户付的金额）
  orderTotal: number;
  // 元信息
  recordedAt: string;
  notes: string;
  // 房控核对列（追加在列尾，口径对齐分房表导出，见 orders.export-room-allocation.ts）
  /** 房号：同分房组同号，半间/拼房标 (½)；未分房按性别+容量打包；无占房行留空。*/
  roomNo: string;
  /**
   * 该乘客入住日、其所在酒店当晚的销控余量（三态同分房表 dailyRemaining）：
   *   数字 = 正常余量（可能为负）；"未配" = 该晚无包房周期；
   *   "—" = 无法确定归属酒店（分房组酒店名与 FK 不一致）或无占房行。
   */
  dailyRemaining: string;
}

const COLUMNS: Array<{ header: string; key: keyof OrderRow; width: number }> = [
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '订单状态', key: 'status', width: 10 },
  { header: '代理', key: 'agency', width: 16 },
  { header: '联系人', key: 'contactName', width: 12 },
  { header: '联系电话', key: 'contactPhone', width: 14 },
  { header: '乘客中文名', key: 'chineseName', width: 14 },
  { header: '护照签发日期', key: 'passportIssueDate', width: 12 },
  { header: '护照签发地', key: 'passportIssuePlace', width: 10 },
  { header: '出生地', key: 'placeOfBirth', width: 10 },
  { header: 'PNR 姓名', key: 'pnrName', width: 20 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '出生日期', key: 'dateOfBirth', width: 12 },
  { header: '护照号', key: 'documentNumber', width: 16 },
  { header: '国籍', key: 'nationality', width: 8 },
  { header: '护照有效期', key: 'passportExpiry', width: 12 },
  { header: '航班号', key: 'flightNumbers', width: 12 },
  { header: '去程日期', key: 'departDate', width: 12 },
  { header: '回程日期', key: 'returnDate', width: 12 },
  { header: '航段状态', key: 'legStatus', width: 20 },
  { header: '路线', key: 'route', width: 14 },
  { header: '套餐', key: 'bundleName', width: 18 },
  { header: '酒店名称', key: 'hotelName', width: 20 },
  { header: '酒店房型', key: 'hotelInfo', width: 28 },
  { header: '签证', key: 'visaInfo', width: 20 },
  { header: '接送', key: 'transferInfo', width: 18 },
  { header: '客单金额(人均)', key: 'orderTotal', width: 14 },
  { header: '录入时间', key: 'recordedAt', width: 18 },
  { header: '备注', key: 'notes', width: 24 },
  // 房控「当天出发全员核对」两列（0825 房控需求）——只在列尾追加，不动前面列序
  { header: '房号', key: 'roomNo', width: 10 },
  { header: '当日余房', key: 'dailyRemaining', width: 12 },
];

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 航段出发日 YYYY-MM-DD，**按出发地当地时区**折算。
 * 班次 departureTime 存 UTC——当地凌晨起飞的红眼班次 UTC 还停在前一天，
 * 直接切 UTC 会把名单上的出发日期写早一天。tz 缺失时回退 UTC（口径同改动前）。
 */
function fmtDepartDate(d: Date | null | undefined, tz: string | null | undefined): string {
  if (!d) return '';
  return tz ? localDateISO(d, tz) : fmtDate(d);
}

type OrderForExport = Prisma.OrderGetPayload<{
  include: {
    agent: { select: { companyName: true; contactName: true } };
    passengers: true;
    items: {
      include: {
        flightSchedule: {
          include: {
            flight: { select: { flightNumber: true; originCode: true; destinationCode: true } };
          };
        };
        hotelRoomType: {
          select: {
            hotelId: true;
            name: true;
            bedType: true;
            capacity: true;
            hotel: { select: { name: true } };
          };
        };
        visa: { select: { visaName: true; visaType: true; country: true } };
        transfer: { select: { name: true } };
        bundle: { select: { name: true } };
      };
    };
  };
}>;

/**
 * 占房 item（口径同分房表 isAllocatable，不限 kind——含已盖章酒店明细的 BUNDLE 行，
 * 纯机票乘客不产生占房 item）：必须有入住日，且房源二选一非空 ——
 * 具体房型（已落位）**或**星级随机档（未落位，还没落到具体酒店）。
 * 早先只认 hotelRoomType 非空，把「星级随机」还没落店的行整类漏在本表之外。
 */
type OccupancyItem = OrderForExport['items'][number] & {
  hotelCheckIn: Date;
};

function isOccupancyItem(it: OrderForExport['items'][number]): it is OccupancyItem {
  return it.hotelCheckIn != null && (it.hotelRoomType != null || it.randomStarTier != null);
}

/** 乘客行「房号 / 当日余房」两列取值；无占房行的乘客不入 map（回落 空 / "—"）。*/
interface RoomColumnValues {
  roomNo: string;
  dailyRemaining: string;
}

const NO_HOTEL_ROOM_COLUMNS: RoomColumnValues = { roomNo: '', dailyRemaining: '—' };

/**
 * 计算每位乘客的「房号 / 当日余房」（房控「当天出发全员核对」用，口径对齐分房表导出）：
 *   - 乘客 ↔ 占房 item 关联复用 correlateItem（分房组酒店/房型匹配，兜底第一条占房行）；
 *   - 房号编号维度 = 酒店 × 入住日（同分房表 per-sheet per-hotel），本导出内自洽：
 *     已分房同 roomGroup 同号（半间标 (½)），未分房按性别+房型容量打包（assignRoomNumbers，
 *     跨订单同酒店同入住日一起打包，与分房表同口径）；
 *   - 当日余房三态照搬分房表：数字 / "未配"（该晚无包房周期）/ "—"（分房组人工填的酒店名
 *     与 FK 关联酒店不一致，归属不确定，绝不瞎标）。
 * 返回 passengerId → 两列取值（乘客只属于一张订单，passengerId 全局唯一）。
 */
function computeRoomColumns(
  orders: readonly OrderForExport[],
  remainingLookup: Map<string, string>,
): Map<string, RoomColumnValues> {
  interface Entry extends RoomNumberEntry {
    passengerId: string;
    dailyRemaining: string;
  }
  // 按入住日聚（编号维度：酒店 × 入住日；assignRoomNumbers 内部按酒店维护状态）
  const byDate = new Map<string, Entry[]>();

  for (const order of orders) {
    const occupancy = order.items.filter(isOccupancyItem);
    if (occupancy.length === 0) continue;
    const roomGroups = parseRoomGroups(order.roomAssignment);

    for (const p of order.passengers) {
      const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
      const it = correlateItem(group, occupancy);
      // 归属精确命中（房组 orderItemId == 该行，口径同分房表导出）：酒店名/余量以该行 FK 为准
      const attributed = isAttributedTo(group, it);
      // 已落位 = FK 酒店/房型；未落位（星级随机档）= 「X星随机（待落位）」，容量回落 2 人/间
      const placement = describeRoomItem(it);
      const checkInStr = fmtDate(it.hotelCheckIn);
      const fkHotelName = placement.hotelName;
      const hotelName =
        attributed && !placement.pending ? fkHotelName : group?.hotelName || fkHotelName;
      const capacity = placement.capacity && placement.capacity > 0 ? placement.capacity : 2;

      // 三态口径同分房表：人工分房酒店名与 FK 关联酒店不一致 → 归属不确定，"—"；
      // 归属精确命中时归属本就确定，人工文本过期与否不影响可信，照常取数。
      // 未落位随机档没有具体酒店（hotelId 为 null）→ 同样 "—"：还没定店，谈不上哪家的余量。
      const hotelNameTrusted = attributed || !group?.hotelName || group.hotelName === fkHotelName;
      const dailyRemaining =
        hotelNameTrusted && placement.hotelId
          ? remainingLookup.get(`${placement.hotelId}|${checkInStr}`) ?? '—'
          : '—';

      const list = byDate.get(checkInStr) ?? [];
      list.push({
        passengerId: p.id,
        hotelName,
        groupId: group?.id ?? null,
        isHalf: !!group && group.roomFraction === 0.5,
        capacity,
        gender: p.gender ?? null,
        roomOrder: 0,
        dailyRemaining,
      });
      byDate.set(checkInStr, list);
    }
  }

  const result = new Map<string, RoomColumnValues>();
  for (const entries of byDate.values()) {
    assignRoomNumbers(entries);
    for (const e of entries) {
      result.set(e.passengerId, {
        roomNo: formatRoomNo(e.roomOrder, e.isHalf),
        dailyRemaining: e.dailyRemaining,
      });
    }
  }
  return result;
}

/** 把一张订单展开成 N 行（每位乘客一行）— 不含成本/毛利。*/
function orderToRows(
  order: OrderForExport,
  roomColumns: Map<string, RoomColumnValues>,
): OrderRow[] {
  // ── 航班信息（可能去程+回程多段）──
  // 按起飞时间升序排序后再拼路线/航班号串：订单行是录入顺序，
  // 回程先录时不排序会导致路线串倒序（如 "回程 → 去程"）。
  interface FlightLeg {
    departureTime: Date;
    departureTz: string | null;
    flightNumber: string;
    route: string;
  }
  const legs: FlightLeg[] = [];
  for (const it of order.items) {
    if (it.kind === 'FLIGHT' && it.flightSchedule) {
      legs.push({
        departureTime: it.flightSchedule.departureTime,
        departureTz: it.flightSchedule.departureTz ?? null,
        flightNumber: it.flightSchedule.flight.flightNumber,
        route: `${it.flightSchedule.flight.originCode} → ${it.flightSchedule.flight.destinationCode}`,
      });
    }
  }
  legs.sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());

  // ── 酒店：房型 + 入住起止（含每行所属酒店名，供 per-passenger 人工分房回落）──
  // 同一房型名（如多团共用 "明月"）不再混淆 —— 优先用人工分房组里的酒店名，
  // 缺失才回落到行上酒店名 + 房型名（与分房表导出口径一致）。
  // 未落位的「星级随机」行（无 FK 房型，只有 randomStarTier）同样出现在这两列，
  // 显示「X星随机（待落位）」——房源已卖出、只是还没落到具体酒店，不能整行消失。
  const hotelRooms: Array<{
    hotelName: string;
    roomType: string;
    range: string;
    pending: boolean;
  }> = [];
  for (const it of order.items) {
    if (it.kind === 'HOTEL' && (it.hotelRoomType || it.randomStarTier != null)) {
      const range =
        it.hotelCheckIn && it.hotelCheckOut
          ? ` (${fmtDate(it.hotelCheckIn)} ~ ${fmtDate(it.hotelCheckOut)})`
          : '';
      const placement = describeRoomItem(it);
      hotelRooms.push({
        hotelName: placement.hotelName,
        roomType: placement.roomTypeName,
        range,
        pending: placement.pending,
      });
    }
  }
  const roomGroups = parseRoomGroups(order.roomAssignment);

  // ── 签证：优先 visaName，回落 visaType；附带国家 ──
  const visaParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'VISA' && it.visa) {
      const name = it.visa.visaName ?? it.visa.visaType;
      const country = it.visa.country ? ` · ${it.visa.country}` : '';
      visaParts.push(`${name}${country}`);
    }
  }

  // ── 接送 ──
  const transferParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'TRANSFER' && it.transfer) {
      transferParts.push(it.transfer.name);
    }
  }

  // ── 套餐 ──
  const bundleParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'BUNDLE' && it.bundle) {
      bundleParts.push(it.bundle.name);
    }
  }

  // 公司名可能是空串（历史空名代理）：`??` 不认 ''，须 trim + `||` 兜底到联系人名。
  const agency = order.agent?.companyName?.trim() || order.agent?.contactName?.trim() || '直销';
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const flightStr = Array.from(new Set(legs.map((l) => l.flightNumber))).join(' / ');
  const routeStr = Array.from(new Set(legs.map((l) => l.route))).join(' / ');
  // 去程 = 最早航段；回程 = 最末航段（单程留空；两段以上取最末段）
  const departStr = fmtDepartDate(legs[0]?.departureTime, legs[0]?.departureTz);
  // 回程座位已释放的行没有班次，进不了 legs —— 只按 legs 算会让这类往返单显示成单程（回程列空白）。
  // 写「已释放」而不是留空：整班表是票务点人头的表，「这单本来有回程、现在座位放回库存了」
  // 必须一眼看得见。
  const returnReleased = order.items.some((it) => isReturnCurrentlyReleased(it));
  const returnStr = returnReleased
    ? '已释放'
    : legs.length >= 2
      ? fmtDepartDate(legs[legs.length - 1]?.departureTime, legs[legs.length - 1]?.departureTz)
      : '';
  const legStatus = formatOrderLegStatus(order.items);
  // 客单金额(人均) = 订单总额 ÷ 乘客数（每行写人均，避免按总额误读为每人都付了全款）
  const orderTotal = dec(order.total) / Math.max(1, order.passengers.length);
  // 录入时间是「动作发生时刻」，按北京时间输出（容器 TZ 是 UTC，直接取 UTC 分量会少 8 小时）
  const recordedAt = businessDateTime(order.createdAt);

  return order.passengers.map<OrderRow>((p) => {
    // 称谓统一 MR/MS（不分年龄，0723 票务口径）；去程日期仅供其他年龄派生场景沿用签名。
    const pnrName = nameWithTitle(p, legs[0]?.departureTime ?? null);

    // 每行酒店名优先用该订单项自带的酒店名（多酒店行程才不会被并成一个酒店）；
    // 仅当订单项没带酒店名时，才回退到该乘客的人工分房组酒店名。
    const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
    const groupHotelName = group?.hotelName?.trim() || '';
    // 每段的展示酒店名：已落位取订单项自带酒店名；未落位随机档没有具体酒店，
    // 此时房控若已人工排房（分房组填了酒店名）以房控为准，否则才显示「X星随机（待落位）」。
    const resolveHotelName = (r: (typeof hotelRooms)[number]): string =>
      r.pending ? groupHotelName || r.hotelName : r.hotelName || groupHotelName;
    // 酒店名称（去重）
    const hotelNames = Array.from(
      new Set(hotelRooms.map(resolveHotelName).filter(Boolean)),
    ).join(' / ');
    const hotelInfo = hotelRooms
      .map((r) => {
        const hotelName = resolveHotelName(r);
        // 未落位且房控也没排房：「X星随机（待落位）」本身已说明酒店与房型都未定，
        // 不再拼「· 待落位」（口径同分房表）。
        if (r.pending && !groupHotelName) return `${hotelName}${r.range}`;
        const prefix = hotelName ? `${hotelName} · ` : '';
        return `${prefix}${r.roomType}${r.range}`;
      })
      .join(' + ');

    return {
      orderNumber: order.orderNumber,
      status: statusLabel,
      agency,
      contactName: order.contactName,
      contactPhone: order.contactPhone,
      chineseName: p.chineseName ?? p.fullName,
      passportIssueDate: fmtDate(p.passportIssueDate),
      passportIssuePlace: p.passportIssuePlace ?? p.passportIssueCountry ?? '',
      placeOfBirth: p.placeOfBirth ?? '',
      pnrName,
      gender: p.gender ? GENDER_LABEL[p.gender] ?? p.gender : '',
      dateOfBirth: fmtDate(p.dateOfBirth),
      documentNumber: p.documentNumber,
      nationality: toAlpha3(p.nationality),
      passportExpiry: fmtDate(p.passportExpiry),
      flightNumbers: flightStr,
      departDate: departStr,
      returnDate: returnStr,
      legStatus,
      route: routeStr,
      bundleName: bundleParts.join(' + '),
      hotelName: hotelNames,
      hotelInfo,
      visaInfo: visaParts.join(' + '),
      transferInfo: transferParts.join(' + '),
      orderTotal,
      recordedAt,
      notes: order.notes ?? '',
      ...(roomColumns.get(p.id) ?? NO_HOTEL_ROOM_COLUMNS),
    };
  });
}

/**
 * 构建按班次的整班机订单导出 xlsx。
 * @param scheduleId 班次 ID（来自 FlightSchedule.id）
 * @param client    可选注入用于测试；缺省取默认 prisma
 */
export async function buildOrdersBySchedule(
  scheduleId: string,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  // 开票进度（座位库存指示）：已开票座位数 vs 该班次座位库存（Σ 舱位 capacity）。
  // seatCapacity 为 null = 班次已删 / 未配舱位 → 无上限可显示，跳过该行（见 getScheduleSeatCapacity）。
  const [seatCapacity, issuedCount] = await Promise.all([
    getScheduleSeatCapacity(client, scheduleId),
    countIssuedPassengers(client, scheduleId),
  ]);

  // 运营口径：包含所有「占座中」订单（见 SEAT_HOLDING_STATUSES）。
  // 关联条件：任意订单行 flightScheduleId = scheduleId（不限 kind），
  // 避免漏掉批量导入单 / 改期后仍在本班次的单 / 含套餐行但无独立 FLIGHT 行的单。
  const orders = (await client.order.findMany({
    where: {
      deletedAt: null, // 排除已软删订单
      status: { in: SEAT_HOLDING_STATUSES },
      items: {
        some: {
          flightScheduleId: scheduleId,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      agent: { select: { companyName: true, contactName: true } },
      passengers: true,
      items: {
        include: {
          flightSchedule: {
            include: {
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
            },
          },
          hotelRoomType: {
            select: {
              hotelId: true,
              name: true,
              bedType: true,
              capacity: true,
              hotel: { select: { name: true } },
            },
          },
          visa: { select: { visaName: true, visaType: true, country: true } },
          transfer: { select: { name: true } },
          bundle: { select: { name: true } },
        },
      },
    },
  })) as OrderForExport[];

  // 房号 / 当日余房两列（口径对齐分房表导出）：先按全部占房行批量取各酒店当晚余量，
  // 再跨订单统一分配房号（同酒店同入住日一起编号/打包）。
  const occupancyItems = orders.flatMap((o) => o.items.filter(isOccupancyItem));
  const remainingLookup = await buildDailyRemainingLookup(occupancyItems, client);
  const roomColumns = computeRoomColumns(orders, remainingLookup);

  const rows: OrderRow[] = [];
  for (const o of orders) {
    if (o.passengers.length === 0) continue;
    rows.push(...orderToRows(o, roomColumns));
  }

  // 本班实际乘客数 = 所有 SEAT_HOLDING 订单的乘客行数（即已展开的 rows 数量）
  const totalPassengers = rows.length;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 整班机订单导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('班机订单明细');

  // ── 顶部汇总区（先手写汇总行，再设列宽，再追加数据行）──
  // ExcelJS 的 insertRow+mergeCells 连续调用同一行号有 bug（"Cannot merge already merged cells"）。
  // 绕过方式：先写汇总行（不依赖 ws.columns），再配列定义，再追加数据行。
  // 最终布局：
  //   - 班次有座位库存：row1=开票进度，row2=乘客数，row3=表头，row4+=数据
  //   - 班次已删 / 未配舱位：row1=乘客数，row2=表头，row3+=数据

  let headerRowNumber = 1;

  if (seatCapacity !== null) {
    const cap = seatCapacity;
    const r1 = ws.addRow([`开票进度：已开票 ${issuedCount} / 上限 ${cap} 张`]);
    ws.mergeCells(r1.number, 1, r1.number, COLUMNS.length);
    r1.font = {
      bold: true,
      color: { argb: issuedCount >= cap ? 'FFCC0000' : 'FF555555' },
    };
    headerRowNumber++;
  }

  const r2 = ws.addRow([
    `本班实际乘客数：${totalPassengers} 人（含待支付/处理中/已完成等占座订单）`,
  ]);
  ws.mergeCells(r2.number, 1, r2.number, COLUMNS.length);
  r2.font = { bold: true, color: { argb: 'FF1A5276' } };
  headerRowNumber++;

  // 表头行（手动写，列宽通过 ws.getColumn 单独设置）
  const headerRow = ws.addRow(COLUMNS.map((c) => c.header));
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // 设置列宽 + key（列宽通过 column index 设置，不影响已有行）
  COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width;
    col.key = c.key;
  });

  // 数据行（key-based addRow 在设好 key 之后仍然可用）
  for (const r of rows) ws.addRow(r);

  const frozenRows = headerRowNumber; // 冻结所有汇总行+表头

  // 冻结指示行+表头 + 订单号列，便于横向滚动核对
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: frozenRows }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 文件名：`订单明细_{flightNumber}_{departureDate}.xlsx`
 * 例：`订单明细_ZJ8888_2026-06-10.xlsx`
 */
export function ordersExportFilename(
  _scheduleId: string,
  flightInfo: { flightNumber: string; departureDate: string },
): string {
  return `订单明细_${flightInfo.flightNumber}_${flightInfo.departureDate}.xlsx`;
}
