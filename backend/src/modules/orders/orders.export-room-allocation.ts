/**
 * 分房表导出（成都格式）— 每个入住日期一个 sheet（名 'M-D'，如 '7-10'），
 * sheet 内按录入时间倒序（新录的单在最上，对齐旧系统导出；拼房关系看「房间号」列），一行/乘客。
 *
 * 行来源：占房订单行（OrderItem 带 hotelCheckIn，且 hotelRoomTypeId 与 randomStarTier 二者之一
 * 非空，含已盖章酒店明细的 BUNDLE 行）。「星级随机」买了但还没落到具体酒店的行（hotelRoomTypeId
 * 为空、randomStarTier 非空）同样上表 —— 行业 rooming list 口径：未落位也要上名单，酒店格与房型格
 * 标「X星随机（待落位）」，一眼与已落位行区分（早先 where 要求 hotelRoomTypeId 非空，把这类整类
 * 筛掉，运营侧表现为「酒店订单导不出来」）；
 * 按订单分组后，每位乘客 correlate 到「他实际占用的那条占房 item」
 * （见 correlateItem）—— 一位乘客恰好一行，不对订单每条占房 item 都遍历全部乘客
 * （同订单多条占房 item 时旧实现会做 item × 乘客笛卡尔积，产生重复行 + 张冠李戴的房型/酒店组合，
 * 已修复，回归覆盖见 orders.export-room-allocation.test.ts）。
 * hotelCheckIn 落在 [from, to] 即归入当日 sheet（同订单多条 item 入住日不同则分归不同 sheet）。
 * 酒店归属：房组带 orderItemId（split-room-group / 新版分房保存写入）时按 id 精确对行，
 * 酒店名/区间/余量以该行 FK 为准；无归属回退旧口径 —— 优先 roomGroups 的 hotelName
 * （人工分房结果），否则回落到 correlate 到的 item 上 hotelRoomType.hotel.name。
 *
 * 列序对齐旧系统（0713 房控反馈）：旧系统 16 列原序 + 当前系统特有 3 列（房间号/升级原因/
 * 当日余房）追加在末尾，见 COLUMNS。「飞行次数」列取常旅客档案快照（口径与全岗总表 /
 * 《全岗可用》完全一致，见 orders.export-trip-stats.ts）；仍暂无数据的列（升级原因）保留表头、
 * 内容留空；「酒店类型」列拼法（酒店名 · 房型名）口径缓办，维持现状不动。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderStatus, OrderItemKind } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import { getHotelNightlyRemaining } from '../hotel-control/hotel-control.service.js';
import { fmtDateDMYDash, pnrName } from './orders.export-templates.js';
import { flightCountCell, loadExportTripStats } from './orders.export-trip-stats.js';
import type { TripStatsMap } from './orders.export-trip-stats.js';
import { earliestFlightDepartureLocalDate } from './pnr-export.js';
import { localDateISO } from '../../lib/flight-time.js';
import { businessDateTimeSec } from '../../lib/business-time.js';

/** 分房口径：退款申请中的订单已释放占房，不进入分房表。*/
const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 导出最长跨度（天）— 超出直接 400，导出不做静默截断。*/
export const ROOM_ALLOCATION_MAX_DAYS = 14;

const GENDER_MF: Record<string, string> = { M: 'M', F: 'F' };

export interface RoomAllocationRow {
  seq: number;
  agency: string;
  notes: string;
  // 现状拼法：酒店名 · 房型名（口径缓办，维持不动）；未落位的星级随机行 = 「X星随机（待落位）」
  hotelType: string;
  chineseName: string;
  pnrName: string;
  /**
   * 飞行次数 = 该乘客的常旅客历史飞行次数（TravelerProfile.tripCount 快照，按证件号归拢、
   * 只计去程已起飞的行程）。与全岗总表 /《全岗可用》同一取数与渲染入口，同一位乘客在三张表里
   * 的数字必然相同；匹配不到档案（新客/证件号对不上）→ 留空，不臆造 0。见 orders.export-trip-stats.ts。
   */
  flightCount: string;
  travelDates: string; // 'YYYY-MM-DD / YYYY-MM-DD'
  settlePrice: number; // 结算价格（人均）：round2(order.total / 乘客数)
  dateOfBirth: string; // dd-mm-yyyy
  gender: string; // M / F
  documentNumber: string;
  issueDate: string; // dd-mm-yyyy（Passenger.passportIssueDate）
  passportExpiry: string; // dd-mm-yyyy
  enteredAt: string; // 录入时间 YYYY-MM-DD HH:MM:SS（Order.createdAt）
  roomType: string;
  roomNo: string; // 房间号（同房同号；半间/拼房组标 "房N(½)"）
  upgradeReason: string; // 系统暂无数据 — 留空
  /**
   * 该乘客入住日、其所在酒店当晚的销控余量（与房控销控板/导出同口径）：
   *   数字字符串 = 正常余量（可能为负，真超卖）；
   *   "未配"     = 该晚没有任何包房周期覆盖（block=0），不是真超卖，先补配包房；
   *   "—"        = 分房组人工填的酒店名与本行 FK 关联酒店不一致，无法确定归属哪家酒店，绝不瞎标。
   */
  dailyRemaining: string;
}

/**
 * 列序对齐旧系统（0713 房控反馈 W5）：前 16 列 = 旧系统原序；
 * 后 3 列（房间号/升级原因/当日余房）= 当前系统特有列，追加在旧表末位之后。
 * 导出为便于测试直接断言列序，无其他消费方引用。
 */
export const COLUMNS: Array<{ header: string; key: keyof RoomAllocationRow; width: number }> = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '备注', key: 'notes', width: 24 },
  { header: '酒店类型', key: 'hotelType', width: 26 },
  { header: '中文名称', key: 'chineseName', width: 12 },
  { header: '乘客姓名', key: 'pnrName', width: 20 },
  { header: '飞行次数', key: 'flightCount', width: 10 },
  { header: '出发(往返)日期', key: 'travelDates', width: 26 },
  { header: '结算价格', key: 'settlePrice', width: 12 },
  { header: '乘客生日', key: 'dateOfBirth', width: 12 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '证件编号', key: 'documentNumber', width: 16 },
  { header: '签发日期', key: 'issueDate', width: 12 },
  { header: '有效日期', key: 'passportExpiry', width: 12 },
  { header: '录入时间', key: 'enteredAt', width: 18 },
  { header: '房型', key: 'roomType', width: 14 },
  { header: '房间号', key: 'roomNo', width: 10 },
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
  /**
   * 房组归属的订单行 id（split-room-group / 新版分房保存写入）。带归属时该组的酒店/房型/
   * 区间/余量以归属行为准（correlateItem 按 id 精确对行）；缺省 = 旧数据，走文本匹配兜底。
   */
  orderItemId?: string;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Prisma.Decimal | number | null → number（与其它导出同款）。*/
function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

/** randomStarTier（星级随机档）→ 中文星级；枚举外的档次回落「N星」，绝不丢档次信息。*/
const STAR_TIER_CN: Record<number, string> = {
  2: '二星',
  3: '三星',
  4: '四星',
  5: '五星',
  6: '六星',
};

/** 未落位行的房型格文案（酒店都没定，房型无从谈起）。*/
export const PENDING_PLACEMENT_ROOM_TYPE = '待落位';

/**
 * 「星级随机」未落位行在各张导出表里的酒店格文案：`X星随机（待落位）`。
 * 口径唯一入口 —— 分房表的酒店分组名与《全岗可用》/《签证专用》的「酒店类型」列共用，
 * 两处文案必须一致，运营对表时才不会以为是两种东西。
 * tier 为空 → 返回空串（调用方自行决定回落，本函数不编造档次）。
 */
export function randomStarTierLabel(tier: number | null | undefined): string {
  if (tier == null) return '';
  return `${STAR_TIER_CN[tier] ?? `${tier}星`}随机（${PENDING_PLACEMENT_ROOM_TYPE}）`;
}

/** 占房行的酒店/房型呈现口径（已落位取 FK 房型，未落位取星级随机档）。*/
export interface RoomItemPlacement {
  /** 酒店分组名：已落位 = FK 酒店名；未落位 = 「X星随机（待落位）」。*/
  hotelName: string;
  /** 房型名：已落位 = FK 房型名；未落位 = 「待落位」。*/
  roomTypeName: string;
  /** FK 房型床型（未落位为 null）。*/
  bedType: string | null;
  /** FK 房型容量（未落位为 null → 打包按缺省 2 人/间）。*/
  capacity: number | null;
  /** FK 酒店 id（未落位为 null → 当日余房无从算起，标「—」）。*/
  hotelId: string | null;
  /** true = 星级随机档还没落到具体酒店。*/
  pending: boolean;
}

/** 占房行 → 酒店/房型呈现（已落位 / 未落位两态的唯一判定入口）。*/
export function describeRoomItem(it: {
  hotelRoomType: {
    hotelId?: string | null;
    name: string;
    bedType: string | null;
    capacity?: number | null;
    hotel: { name: string };
  } | null;
  randomStarTier?: number | null;
}): RoomItemPlacement {
  if (it.hotelRoomType) {
    return {
      hotelName: it.hotelRoomType.hotel.name,
      roomTypeName: it.hotelRoomType.name,
      bedType: it.hotelRoomType.bedType,
      capacity: it.hotelRoomType.capacity ?? null,
      hotelId: it.hotelRoomType.hotelId ?? null,
      pending: false,
    };
  }
  return {
    hotelName: randomStarTierLabel(it.randomStarTier),
    roomTypeName: PENDING_PLACEMENT_ROOM_TYPE,
    bedType: null,
    capacity: null,
    hotelId: null,
    pending: true,
  };
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

/**
 * 导出「酒店中文名称」列（乘客行级）取数（0722 财务反馈：导出酒店名与房控实际数据相连，
 * 省去人工匹配客户入住酒店的步骤）。优先级：
 *   1. 该乘客所在分房组的实际酒店 group.hotelName —— 房控人工排房结果（可能是自由文本），
 *      原样返回、不做匹配清洗（房控换过酒店时，导出跟房控走）；
 *   2. 无分房组 / 分房组没填酒店名 → 回退订单项酒店口径 fallbackHotelName（录单时选的房型所属
 *      酒店，现状值），绝不留空。
 * group.hotelName 仅用 trim 判空（判它到底填没填），采用时用原值。
 */
export function resolveExportHotelName(
  group: RoomGroup | undefined,
  fallbackHotelName: string,
): string {
  const fromRoomControl = group?.hotelName;
  return fromRoomControl && fromRoomControl.trim() ? fromRoomControl : fallbackHotelName;
}

/**
 * 导出「酒店类型」列（= 酒店名 + 房型，乘客行级）取数。与 resolveExportHotelName 同一优先级，
 * 但本列含房型：乘客在分房组内时，酒店名与房型**都**取分房组的（group.hotelName + group.roomType，
 * 房控排房结果，原样不清洗；组内房型为空则只出酒店名）；无分房组 / 分房组没填酒店名 → 回退订单项
 * 口径 fallbackHotelInfo（现状「酒店名 房型名」拼串），绝不留空。
 */
export function resolveExportHotelInfo(
  group: RoomGroup | undefined,
  fallbackHotelInfo: string,
): string {
  const hotelName = group?.hotelName;
  if (!hotelName || !hotelName.trim()) return fallbackHotelInfo;
  return [hotelName, group?.roomType].filter((s): s is string => !!s && !!s.trim()).join(' ');
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
            flightSchedule: { select: { departureTime: true, departureTz: true } };
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
 * assignRoomNumbers 所需的最小形状（导出供整班机订单导出复用同一套房号分配口径，
 * 见 orders.export.ts 的「房号」列）。
 */
export interface RoomNumberEntry {
  hotelName: string;
  /** 人工分房组 id；未分房为 null（同 id 同房间）。*/
  groupId: string | null;
  /** 半间/拼房组（roomFraction === 0.5）→ 房号标 (½)。*/
  isHalf: boolean;
  /** 该乘客所在房型容量（用于未分房乘客按容量打包；缺省 2）。*/
  capacity: number;
  /**
   * 乘客性别原值（Passenger.gender：'M' / 'F' / 'X' / null）——未人工分房时
   * assignRoomNumbers 按此分组打包，异性不拼同房号（口径同房控物理房间：
   * hotel-control.service.ts computePhysicalUsed 的"异性不能拼一间"）。
   */
  gender: string | null;
  /** 分配后的房间序号（per hotel；排序用）。*/
  roomOrder: number;
}

/** 单条乘客行的中间形态（带分房/容量信息，供分配房间号后再排序编号）。*/
interface RoomEntry extends RoomNumberEntry {
  row: Omit<RoomAllocationRow, 'seq' | 'roomNo'>;
}

/** 把整数房号转为展示串："房N"，半间组加 (½)。*/
export function formatRoomNo(order: number, isHalf: boolean): string {
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

/** 占房 item 上 hotelCheckIn 非空后的窄化类型（correlate 阶段用）。*/
type AllocatableItem = RoomItemForExport & {
  hotelCheckIn: NonNullable<RoomItemForExport['hotelCheckIn']>;
};

/**
 * 上表判定：必须有入住日（否则归不到任何 sheet），房源二选一非空 ——
 * 具体房型（已落位）或星级随机档（未落位，rooming list 口径照样上名单）。
 */
function isAllocatable(it: RoomItemForExport): it is AllocatableItem {
  return it.hotelCheckIn != null && (it.hotelRoomType != null || it.randomStarTier != null);
}

/**
 * correlateItem 所需的最小形状（导出供整班机订单导出复用同一套乘客 ↔ 占房 item 关联口径）。
 */
export interface CorrelatableRoomItem {
  /** 订单行 id（可选）：房组带 orderItemId 归属时按它精确对行；调用方不带 id 则归属匹配不命中，走文本兜底。*/
  id?: string;
  /** 未落位的星级随机行没有 FK 房型 —— 允许为空，此时按酒店名/房型匹配一律不命中，走兜底。*/
  hotelRoomType: { name: string; bedType: string | null; hotel: { name: string } } | null;
}

/**
 * 把一位乘客 correlate 到「他实际占用的那条占房 item」——同订单可能有多条占房 item
 * （如两种房型 / 跨酒店），不能对每条 item 都遍历全部乘客（会产生重复行 + 张冠李戴，
 * 见本文件顶部 JSDoc 的回归说明）。
 *   - 房组带 orderItemId 归属（split-room-group / 新版分房保存写入）：按 id 精确对行——
 *     数据模型上百分百的「这组人就是这一行的客人」，跨酒店/同酒店多行都不串；
 *     id 在本单占房 item 里找不到（行已被删等异常数据）→ 落回下面的文本匹配兜底。
 *   - 单条 item 的订单：无歧义，直接用它（兼容未分房乘客的老口径——单房型订单里
 *     谁都在这一间/这一批房源里，不需要 roomGroup 也能归属）。
 *   - 多条 item 的订单：优先用 roomGroup.hotelName（+ roomType 更精确）匹配到对应 item；
 *     分房组酒店名在本单占房 item 里找不到匹配（人工填写与 FK 不同步）、或压根没分房——
 *     无法可靠 correlate，兜底用订单第一条占房 item（保证每位乘客恰好一行，不重复也不丢单；
 *     「归属哪家酒店」在此兜底下是尽力而为，dailyRemaining 会用「—」标出这种不确定性）。
 */
export function correlateItem<T extends CorrelatableRoomItem>(
  group: RoomGroup | undefined,
  orderItems: readonly T[],
): T {
  if (group?.orderItemId) {
    const byId = orderItems.find((it) => it.id === group.orderItemId);
    if (byId) return byId;
  }
  if (orderItems.length === 1) return orderItems[0];
  if (group) {
    const exact = orderItems.find(
      (it) =>
        it.hotelRoomType?.hotel.name === group.hotelName &&
        (!group.roomType ||
          it.hotelRoomType.name === group.roomType ||
          it.hotelRoomType.bedType === group.roomType),
    );
    if (exact) return exact;
    const byHotelOnly = orderItems.find((it) => it.hotelRoomType?.hotel.name === group.hotelName);
    if (byHotelOnly) return byHotelOnly;
  }
  return orderItems[0];
}

/**
 * correlateItem 是否按 orderItemId 归属**精确**命中了该 item。命中 = 该行就是这组人的行，
 * 展示（酒店名）与余量归属（dailyRemaining）以行上 FK 为准，分房组的 hotelName 文本
 * （可能是换酒店前的旧名/手误）不再参与「归属可信」判定。分房表导出与整班机导出共用。
 */
export function isAttributedTo(
  group: RoomGroup | undefined,
  item: CorrelatableRoomItem,
): boolean {
  return !!group?.orderItemId && group.orderItemId === item.id;
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
 *
 * tripStats：「飞行次数」列的档案快照（由 loadExportTripStats 批量拉好后传入——本函数是纯函数，
 * 绝不在行循环里逐个查库）。缺省空 Map = 该列全部留空。
 */
export function buildRoomAllocationSheets(
  items: RoomItemForExport[],
  remainingLookup: Map<string, string> = new Map(),
  tripStats: TripStatsMap = new Map(),
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

    // 结算价格（人均）：订单总价 / 乘客数，与 orders.export-master.ts 的 settlePerPax 同口径；
    // 除零保护 —— 乘客数至少按 1 算，避免空乘客订单除以 0。
    const paxCount = Math.max(1, order.passengers.length);
    const settlePrice = round2(dec(order.total) / paxCount);
    // 录入时间是「动作发生时刻」，按北京时间输出（容器 TZ 是 UTC，直接取 UTC 分量会少 8 小时）
    const enteredAt = businessDateTimeSec(order.createdAt);

    // 出发(往返)日期：订单全部 FLIGHT 行的出发日（去重升序）；无航班回落各自入住日
    const flightDates = Array.from(
      new Set(
        order.items
          .filter((x) => x.kind === 'FLIGHT' && x.flightSchedule)
          // 出发地当地日（与班次日历 / 出发日筛选同口径）
          .map((x) =>
            localDateISO(x.flightSchedule!.departureTime, x.flightSchedule!.departureTz),
          ),
      ),
    ).sort();

    for (const p of order.passengers) {
      const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
      const it = correlateItem(group, orderItems);
      // 归属精确命中（房组 orderItemId == 该行）：酒店名/区间/余量以该行为准——
      // 分房组的 hotelName 文本可能是换酒店前的旧名，不再压过行上 FK。
      const attributed = isAttributedTo(group, it);
      // 已落位 = FK 酒店/房型；未落位（星级随机档）= 「X星随机（待落位）」+ 房型「待落位」
      const placement = describeRoomItem(it);
      const checkInStr = fmtDate(it.hotelCheckIn);
      const fkHotelName = placement.hotelName;
      const hotelName =
        attributed && !placement.pending ? fkHotelName : group?.hotelName || fkHotelName;
      // 未落位行仍按分房组酒店名归组（房控已人工排房时以房控为准），只有回落到随机档名时才算待落位
      const pendingPlacement = placement.pending && !group?.hotelName;
      // 房型容量（未分房乘客打包用）；fixture/缺数据/未落位随机档回落 2 人/间
      const capacity = placement.capacity && placement.capacity > 0 ? placement.capacity : 2;
      const travelDates = flightDates.length > 0 ? flightDates.join(' / ') : checkInStr;

      // 分了房用 roomGroup 的房型（回落乘客床型偏好）；没分房回落 correlate 到的 item 房型床型；
      // 未落位随机档两者都没有 → 标「待落位」，绝不留空让人误以为是普通房型缺数据
      const assignedRoomType = group ? group.roomType || p.bedPref || '' : '';
      const roomType =
        assignedRoomType ||
        placement.bedType ||
        (placement.pending ? PENDING_PLACEMENT_ROOM_TYPE : '');
      const isHalf = !!group && group.roomFraction === 0.5;
      // 半间/拼房标记：roomFraction === 0.5 时在备注里点出（整间/缺省不标）
      const halfRoomNote = isHalf ? '半间/拼房' : '';
      const notes = [group?.notes, order.notes, halfRoomNote].filter(Boolean).join(' / ');

      // 当日余房：分房组人工填的酒店名与 correlate 到的 item FK 关联酒店不一致时，
      // 无法确定该按哪家酒店的余量算——绝不瞎标，直接 "—"（见文件顶部 JSDoc 归属优先级说明）。
      // 归属精确命中（orderItemId）时归属本就确定，人工文本过期与否不影响可信，照常取数。
      // 未落位随机档没有具体酒店（hotelId 为 null）→ 同样 "—"：还没定店，谈不上哪家的余量。
      const hotelNameTrusted = attributed || !group?.hotelName || group.hotelName === fkHotelName;
      const dailyRemaining =
        hotelNameTrusted && placement.hotelId
          ? (remainingLookup.get(`${placement.hotelId}|${checkInStr}`) ?? '—')
          : '—';

      const row: Omit<RoomAllocationRow, 'seq' | 'roomNo'> = {
        agency,
        notes,
        // 未落位：「X星随机（待落位）」本身已说明酒店与房型都未定，不再拼「· 待落位」
        hotelType: pendingPlacement ? hotelName : `${hotelName} · ${placement.roomTypeName}`,
        chineseName: resolveChineseName(p),
        pnrName: pnrName(p),
        flightCount: flightCountCell(p, tripStats),
        travelDates,
        settlePrice,
        dateOfBirth: fmtDateDMYDash(p.dateOfBirth),
        gender: p.gender ? GENDER_MF[p.gender] ?? '' : '',
        documentNumber: p.documentNumber,
        issueDate: fmtDateDMYDash(p.passportIssueDate),
        passportExpiry: fmtDateDMYDash(p.passportExpiry),
        enteredAt,
        roomType,
        upgradeReason: '',
        dailyRemaining,
      };

      const list = byDate.get(checkInStr) ?? [];
      list.push({
        hotelName,
        groupId: group?.id ?? null,
        isHalf,
        capacity,
        gender: p.gender ?? null,
        roomOrder: 0,
        row,
      });
      byDate.set(checkInStr, list);
    }
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => {
      assignRoomNumbers(entries);
      // 行序 = 录入时间倒序（0830 公测反馈，对齐旧系统导出：新录的单在最上面）。
      // enteredAt 是 'YYYY-MM-DD HH:mm:ss' 定长格式，字符串比较即时间比较。
      // 同一订单的乘客 enteredAt 相同 → 自然相邻；并列再按酒店名（zh-CN）→ 房间号兜底定序。
      // 拼房关系不再靠行相邻表达，看「房间号」列（assignRoomNumbers 的编号口径不变）。
      const sorted = [...entries].sort(
        (a, b) =>
          b.row.enteredAt.localeCompare(a.row.enteredAt) ||
          a.hotelName.localeCompare(b.hotelName, 'zh-CN') ||
          a.roomOrder - b.roomOrder,
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

/** 未分房乘客打包分组键：M/F 各自一组，其余（X / 未知）不与任何人拼房，各自单间。*/
type PackGenderKey = 'M' | 'F' | 'U';

function packGenderKeyOf(gender: string | null): PackGenderKey {
  return gender === 'M' ? 'M' : gender === 'F' ? 'F' : 'U';
}

/**
 * 给同一入住日期内的乘客分配房间号（per 酒店，按取数顺序）。就地写回 entry.roomOrder。
 *   - 已分房：同 groupId 共用一个房号（首次出现时分配）——人工分房结果不受性别分组影响。
 *   - 未分房：按性别分组分别打包——M 一组、F 一组各自按容量打包（每满 capacity 人开下一间），
 *     性别未知/X 保守视同"潜在异性"，各自单间不与任何人拼房；异性不能拼同一物理房间，
 *     口径与销控物理房间一致（见 hotel-control.service.ts computePhysicalUsed 的 JSDoc）。
 *     未分房房号续在已分房之后。
 * 导出供整班机订单导出（orders.export.ts）复用——同一套打包口径，不各自实现。
 */
export function assignRoomNumbers(entries: RoomNumberEntry[]): void {
  // 每个酒店各自的分配状态；未分房乘客按性别分组各自维护「当前开放房间」
  const perHotel = new Map<
    string,
    {
      next: number;
      groupRoom: Map<string, number>;
      openRoomByGender: Map<PackGenderKey, { room: number; left: number }>;
    }
  >();

  for (const e of entries) {
    let st = perHotel.get(e.hotelName);
    if (!st) {
      st = { next: 1, groupRoom: new Map(), openRoomByGender: new Map() };
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
      continue;
    }

    const genderKey = packGenderKeyOf(e.gender);
    if (genderKey === 'U') {
      // 性别未知/X：不与任何人拼房，各自单间
      e.roomOrder = st.next++;
      continue;
    }

    // 未分房（性别已知）：按容量打包到该性别当前开放房间；满则开新房
    let open = st.openRoomByGender.get(genderKey);
    if (!open || open.left <= 0) {
      open = { room: st.next++, left: e.capacity };
    }
    e.roomOrder = open.room;
    open.left -= 1;
    st.openRoomByGender.set(genderKey, open);
  }
}

/** buildDailyRemainingLookup 入参的最小形状（RoomItemForExport 与整班机导出占房行都满足）。*/
export interface RemainingLookupItem {
  hotelRoomType: { hotelId: string } | null;
  hotelCheckIn: Date | null;
}

/**
 * 「当日余房」列取数：按 (hotelId, 入住日) 去重后批量查——同一酒店的多个入住日合并成一次
 * getHotelNightlyRemaining 调用（内部一次 findMany 拉全部周期/占房行），而不是每个 (hotel,date)
 * 各查一次，减少导出跨度内（≤14 天，ROOM_ALLOCATION_MAX_DAYS）的查库次数。
 * 返回 `${hotelId}|${YYYY-MM-DD}` → 展示串（数字 / "未配" block=0 未覆盖 / 缺省未收录）。
 * 入参形状放宽为最小结构（RemainingLookupItem）——整班机订单导出（orders.export.ts）的
 * 占房行 include 形状不同，但同样满足此结构，直接复用本函数（口径唯一入口，不各自查询）。
 */
export async function buildDailyRemainingLookup(
  items: readonly RemainingLookupItem[],
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
      const { physicalRemaining, block, hasBlock } = await getHotelNightlyRemaining(
        hotelId,
        dates,
        client,
      );
      return { hotelId, dates, physicalRemaining, block, hasBlock };
    }),
  );

  const lookup = new Map<string, string>();
  for (const { hotelId, dates, physicalRemaining, block, hasBlock } of perHotel) {
    dates.forEach((date, i) => {
      const key = `${hotelId}|${date}`;
      if (!hasBlock || block[i] === 0) {
        lookup.set(key, '未配');
      } else {
        // 物理房间口径（与销控板/房态导出同口径）——不用床位口径 remaining，
        // 否则"男+女各半间"这类拼房会出现 8.5 这种物理上不存在的半间余量。
        lookup.set(key, String(physicalRemaining[i]));
      }
    });
  }
  return lookup;
}

/**
 * 「这是一条占房行」的 where 判定（区间口径 / 出发日口径 / 出发日回落分支三处共用）：
 * 具体房型（已落位）**或**星级随机档（未落位）二选一非空。
 * 早先只认 hotelRoomTypeId 非空，把「星级随机」还没落店的行整类筛掉 —— 运营侧表现为
 * 「酒店订单不能在分房表里导出来」。行业 rooming list 口径是未落位也要上名单。
 */
const OCCUPYING_ITEM_OR = [
  { hotelRoomTypeId: { not: null } },
  { randomStarTier: { not: null } },
] satisfies Prisma.OrderItemWhereInput[];

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
          flightSchedule: { select: { departureTime: true, departureTz: true } },
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
      // 已落位 or 未落位随机档；入住日区间条件对两者一视同仁
      OR: OCCUPYING_ITEM_OR,
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
 * 「该日出发」判定与 sheet 上「出发(往返)日期」列同口径（都用**出发地当地日**）：
 *   - 主口径：订单任一 FLIGHT 行所在班次的当地出发日 == departDate。
 *     departureTime 存的是 UTC 时间戳，当地日与 UTC 日最多差一天（澳门 +8 / 越南 +7 的
 *     当地凌晨班次，UTC 还停在前一天），所以取数窗口按 ±1 天放宽召回，
 *     再交给 filterRoomItemsByDepartDate 按当地日精确判定 —— 窗口只负责别漏，不负责准。
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
  // 航班召回窗口按 ±1 天放宽：当地日 ↔ UTC 日最多差一天，窄窗口会把当地凌晨起飞的
  // 班次整单漏掉（后面的当地日精筛保证不会多召回错误的单）。
  const recallStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
  const recallEnd = new Date(dayEnd.getTime() + 24 * 60 * 60 * 1000);
  const fetched = (await client.orderItem.findMany({
    where: {
      // 已落位 or 未落位随机档（出发日口径不按入住日切区间，要导整段入住晚）
      OR: OCCUPYING_ITEM_OR,
      order: {
        deletedAt: null, // 排除已软删订单
        status: { in: COUNTED_STATUSES },
        OR: [
          {
            items: {
              some: {
                kind: OrderItemKind.FLIGHT,
                flightSchedule: { departureTime: { gte: recallStart, lt: recallEnd } },
              },
            },
          },
          {
            AND: [
              { items: { none: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } } },
              { items: { some: { OR: OCCUPYING_ITEM_OR, hotelCheckIn: dayStart } } },
            ],
          },
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
    include: ROOM_ITEM_INCLUDE,
  })) as RoomItemForExport[];
  return filterRoomItemsByDepartDate(fetched, departDate);
}

/**
 * 出发日精确细筛（0722 房控反馈）：取数 where 的主口径用 `items.some.kind=FLIGHT` 命中**任意**
 * 航段落在该 UTC 日 —— 会把「去程 21 号、回程 22 号」这类整单出发日不在该日的往返单也召回
 * （返程段落在该日），且窗口按 ±1 天放宽后还会多召回相邻日的单。这里按整单「出发日」=
 * 最早 FLIGHT 行的**出发地当地日**（earliestFlightDepartureLocalDate，与 sheet
 * 「出发(往返)日期」列同口径）二次过滤：
 *   - 含航班的订单：最早航段当地出发日须 === departDate，否则剔除（去程 21/回程 22 被排除）；
 *   - 无任何 FLIGHT 行的订单（纯酒店/未挂班次套餐）：返回 null，
 *     由取数回落分支（hotelCheckIn === 该日）已精确命中，此处一律放行、不动其回落口径。
 * 纯函数（按 item.order.items 判定），导出调用 + 单测复用。
 */
export function filterRoomItemsByDepartDate(
  items: RoomItemForExport[],
  departDate: string,
): RoomItemForExport[] {
  return items.filter((it) => {
    const earliest = earliestFlightDepartureLocalDate(it.order.items);
    return earliest === null || earliest === departDate;
  });
}

/** 把占房 item 集合渲染成分房表 xlsx（区间/出发日两口径共用的收尾）。*/
async function buildWorkbookFromItems(
  items: RoomItemForExport[],
  client: PrismaClient,
): Promise<Buffer> {
  const remainingLookup = await buildDailyRemainingLookup(items, client);
  // 飞行次数：一次性批量拉回本次导出全部乘客的档案快照（无 N+1，见 orders.export-trip-stats.ts），
  // 与全岗总表 /《全岗可用》同一入口 → 同一位乘客在三张表里的数字必然相同。
  // 同一订单跨多条占房 item 时乘客会重复出现，loadExportTripStats 内部按证件对去重，不重复查。
  const { tripStats } = await loadExportTripStats(
    items.flatMap((it) => it.order.passengers),
    client,
  );
  const sheets = buildRoomAllocationSheets(items, remainingLookup, tripStats);

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

/** 全表字体/行高（0830 公测反馈）：对齐旧系统导出的 Arial 10 号、行高 25、整表居中。*/
const SHEET_FONT = { name: 'Arial', size: 10 } as const;
const SHEET_ROW_HEIGHT = 25;

function addSheet(wb: ExcelJS.Workbook, name: string, rows: RoomAllocationRow[]): void {
  const ws = wb.addWorksheet(name);
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { ...SHEET_FONT, bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };

  for (const r of rows) ws.addRow(r);
  // 逐行盖字体/行高/居中（表头行 font 已带 bold，跳过重盖以免丢加粗）
  ws.eachRow((row, rowNumber) => {
    row.height = SHEET_ROW_HEIGHT;
    if (rowNumber > 1) row.font = { ...SHEET_FONT };
    row.alignment = { vertical: 'middle', horizontal: 'center' };
  });
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
