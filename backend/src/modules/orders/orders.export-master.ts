/**
 * 全岗总表导出 —— 一行/乘客的「完整」运营台账（PRIMARY 综合导出）。
 *
 * 定位：把过去要靠多张表 + 线下手工台账拼出来的口径，一次性做全 —— 运营再也不会
 * 遇到「导出缺酒店名 / 缺结算 / 缺航段 / 缺分房」。与 orders.export-templates.ts 的
 * 《全岗可用》模板相比，本表把系统里真实存有的字段全部填满（护照签发日、分房情况、
 * 订单成本、单房差、退款金额等），而不是留空占位。
 *
 * 筛选：按出发日期区间（from/to → travelFrom/travelTo 口径，复用 buildOrderFilterWhere），
 * 与整班/全岗导出选单方式一致；同时排除草稿/已取消/超时/失败/退款申请中/已退款。
 *
 * 可选 role（all|ticketing|visa）：只隐藏与岗位无关的列，默认（不传）= 完整全岗表。
 * 无论 role 如何，都是同一份数据、同一个端点 —— role 仅做列可见性裁剪。
 *
 * 诚实口径：
 *   - 飞行次数 = 该乘客的常旅客历史飞行次数（按证件号归拢，只计去程已起飞的行程），
 *     取自 TravelerProfile.tripCount —— 是「这个人跟我们飞过几次」，与本单航段数无关，
 *     故同一订单不同乘客的飞行次数互不相同。匹配不到档案（新客/证件号对不上）→ 留空。
 *     该列读自档案快照表（值是上次重建时的，见 TravelerProfile.refreshedAt）；快照表一条
 *     都没有时（新环境 / 从没人开过档案页）会导致整列全部留空，导出会先同步做一次全量首建
 *     兜底。非空但过期的快照不归导出管——那由档案页自身访问时的后台重建负责刷新，导出不为
 *     此额外重建（全量重建太慢，不能挂在每次导出请求上）。
 *   - 在订未飞 = TravelerProfile.pendingTripCount（同一条快照重算链路回写，快照口径同飞行次数）。
 *   - 可用次数 = 飞行次数（已飞）− 已核销权益次数（TravelerBenefitRedemption 流水 sum，
 *     核销/冲正同一档案），可为负——核销后订单又被退改导致已飞回落时如实透出，不截断也不臆造。
 *     核销流水挂在合并链的主档案上，取值前已沿 mergedIntoId 解析到主档案。
 *   - 金额列（结算价/到账/尾款/单房差/签证/退款/订单成本）均为「每位出行人」均摊，
 *     与《全岗可用》模板同口径，避免按订单总额被误读为每人都付了全款。
 */
import ExcelJS from 'exceljs';
import { localDateISO } from '../../lib/flight-time.js';
import { businessDateTime } from '../../lib/business-time.js';
import type { DocumentType, PrismaClient } from '@prisma/client';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import type { BundleItemJson } from '../../lib/json-types.js';
import { docKey } from '../travelers/traveler-profiles.aggregate.js';
import { TravelerProfilesService } from '../travelers/traveler-profiles.service.js';
import { toAlpha3 } from './nationality.js';
import { parseRoomGroups, resolveExportHotelName } from './orders.export-room-allocation.js';
import { nameWithTitle, pnrName, VISA_REQUIREMENT_LABEL } from './orders.export-templates.js';
import { filterExportOrdersByDepartDate } from './orders.export-depart-filter.js';
import { appendHoldOrderSheet, loadHoldExportRows } from './orders.export-hold-orders.js';
import { buildOrderFilterWhere, GUEST_RECORDED_BY_LABEL } from './orders.service.js';
import { determineFlightLegs } from './ticketing-cap.js';

// ── 岗位视图 ──────────────────────────────────────────────────────────────
/** 岗位视图：all=完整全岗（默认）；ticketing=票务；visa=签证。仅裁列，不改数据/取数。*/
export type MasterExportRole = 'all' | 'ticketing' | 'visa';

export interface MasterExportQuery {
  /** 出发日期起（YYYY-MM-DD，含）*/
  from?: string;
  /** 出发日期止（YYYY-MM-DD，含）*/
  to?: string;
  /** 岗位视图，默认 all（完整全岗表）*/
  role?: MasterExportRole;
  /** 勾选导出：给了就只导这批订单（以 id 集合为准，忽略 from/to）。 */
  orderIds?: string[];
}

/** 运营口径：所有仍占座、应出行的订单；退款申请中的订单已释放库存。*/
const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

// ── 中文标签表 ──────────────────────────────────────────────────────────────
// 注：开票状态不再用这张表——旧字段 Order.invoiceStatus 是六态开票改造前的单一态字段，
// 改造后系统只写三布尔（outboundInvoiced/returnInvoiced/systemInvoiced），旧字段不再回写，
// 读它会让「去程已开」等新状态在这张表上恒显示"未开"（P2-15a）。开票状态改由
// orderToMasterRows 内联拼三布尔文案，与 orders.export-templates.ts 的 full 模板同口径。

const FULFILLMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '处理中',
  CONFIRMED: '已确认',
  CANCELLED: '已取消',
  FAILED: '失败',
};

// 注：订单级签证状态标签表（VISA_REQUIREMENT_LABEL）与三模板导出共用，见 orders.export-templates.ts。

const PASSENGER_TYPE_LABEL: Record<string, string> = {
  ADULT: '成人',
  CHILD: '儿童',
  INFANT: '婴儿',
};

const GENDER_LABEL: Record<string, string> = { M: '男', F: '女', X: '其他' };

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  PASSPORT: '护照',
  ID_CARD: '身份证',
};

const CABIN_LABEL: Record<string, string> = {
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
};

const ORDER_KIND_LABEL: Record<string, string> = {
  BUNDLE: '套餐',
  HOTEL: '酒店',
  VISA: '签证',
  TRANSFER: '接送',
  INSURANCE: '保险',
};

/** 订单成本类别（与 order-cost-items.service 同口径）。*/
const COST_CATEGORY_LABEL: Record<string, string> = {
  GUIDE_SERVICE: '导游服务费',
  COMP_GIFT: '赠送费用',
  HANDLING_FEE: '手续费',
  OPERATION_FEE: '操作费',
  OTHER: '其他',
};

// ── 小工具（与其它导出同款）────────────────────────────────────────────────
function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

// ── 一行（每位乘客）───────────────────────────────────────────────────────
export interface MasterRow {
  seq: number;
  agency: string;
  notes: string;
  hotelName: string; // 酒店中文名称（乘客行级）：优先分房组实际酒店（房控），回退订单项 hotelRoomType.hotel.name 去重
  chineseName: string;
  passengerName: string; // 拼音/PNR：LAST/FIRST + 称谓（航司口径）
  cleanName: string; // 纯拼音名 LAST/FIRST（无 MR/MS 称谓）— 财务对数/名单匹配用
  // 常旅客历史飞行次数（TravelerProfile.tripCount 快照）：按证件号归拢、只计去程已起飞的行程。
  // 每位乘客各不相同；匹配不到档案 → 留空。与本单航段数无关。
  flightCount: string;
  // 在订未飞（TravelerProfile.pendingTripCount 快照，同一条重算链路回写）：有去程航班且
  // 尚未起飞的有效订单数。匹配不到档案 → 留空，口径同飞行次数。
  pendingTripCount: string;
  // 可用次数 = 飞行次数（已飞）− 已核销权益次数（TravelerBenefitRedemption 流水 sum）。
  // 可为负——核销后订单又被退改导致已飞回落时如实透出。匹配不到档案 → 留空。
  availableTrips: string;
  travelDates: string; // 出发(往返)日期
  flightNumbers: string; // 航班号（去⇌回）
  orderType: string; // 往返票/单程票/品类
  cabin: string; // 舱位等级
  settlePrice: number; // 结算价格（人均）
  settlementDiscountAmount: number; // 立减金额（人均，订单立减快照行金额绝对值合计）
  balanceDue: number; // 尾款金额（人均）= max(0, total + adjustmentCny − paid − prepaymentOffset) / 人数，含售后调整与预付款抵扣
  settleReceived: number; // 已到账金额（人均）
  singleRoomDiff: number; // 单房差（人均）
  visaAmount: number; // 签证金额（人均）
  visaSupplier: string; // 签证公司（供应商/代办渠道，多签证去重逗号拼接）— 财务对账用，缺失留空
  visaStatus: string; // 签证状态（订单级 + 履约任务，取更具体者）
  invoiceStatus: string; // 开票状态：三布尔（去程/回程/系统）组合文案，'/' 连接；都未开 = "未开"
  settled: string; // 是否清账（结清）
  refundAmount: number; // 退款金额（人均，已完成退款）
  passportIssuePlace: string; // 护照签发地 ?? 颁发国
  placeOfBirth: string; // 出生地
  orderNumber: string;
  dateOfBirth: string; // 乘客生日
  passengerType: string; // 成人/儿童/婴儿
  gender: string;
  nationality: string; // ISO alpha-3
  documentType: string; // 证件类型
  documentNumber: string; // 证件编号
  issueDate: string; // 证件签发日（护照签发日期）
  expiryDate: string; // 证件有效期
  distribution: string; // 分房情况（房N·拼房 / 整间 / 未分房）
  orderCost: string; // 订单成本（类别 金额，多条 ' + ' 连接）
  recordedAt: string; // 录入时间
  recordedBy: string; // 录入人员
}

interface MasterColumn {
  header: string;
  key: keyof MasterRow;
  width: number;
  /** 表头批注（诚实口径说明），如飞行次数。*/
  note?: string;
  /** 属于哪些岗位视图；缺省 = 所有视图都显示。role 命中时保留该列。*/
  roles?: MasterExportRole[];
}

/**
 * 完整列定义（全岗序）。roles 缺省 = 通用列（任何视图都显示）。
 * ticketing（票务）与 visa（签证）视图各自额外保留对本岗有意义的列 —— 通用列始终在。
 */
const MASTER_COLUMNS: MasterColumn[] = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '备注', key: 'notes', width: 22 },
  { header: '酒店中文名称', key: 'hotelName', width: 20, roles: ['all', 'visa'] },
  { header: '乘客中文名', key: 'chineseName', width: 12 },
  { header: '乘客拼音名', key: 'passengerName', width: 18 },
  { header: '纯拼音名', key: 'cleanName', width: 16 },
  {
    header: '飞行次数',
    key: 'flightCount',
    width: 8,
    note:
      '常旅客历史飞行次数：按证件号归拢，只计去程已起飞的行程（不是本单航段数）。\n' +
      '匹配不到旅客档案（新客/证件号对不上）留空。\n' +
      '数据为旅客档案快照，非导出时实时重算。',
    roles: ['all', 'ticketing'],
  },
  {
    header: '在订未飞',
    key: 'pendingTripCount',
    width: 10,
    note:
      '已下单但去程尚未起飞的有效订单数（快照口径同飞行次数）。\n' +
      '匹配不到旅客档案（新客/证件号对不上）留空。\n' +
      '数据为旅客档案快照，非导出时实时重算。',
    roles: ['all', 'ticketing'],
  },
  {
    header: '可用次数',
    key: 'availableTrips',
    width: 10,
    note:
      '= 已飞次数 − 已核销权益次数；负数=核销后订单退改导致已飞回落，请到旅客档案页核对。\n' +
      '匹配不到旅客档案（新客/证件号对不上）留空。\n' +
      '数据为旅客档案快照，非导出时实时重算。',
    roles: ['all', 'ticketing'],
  },
  { header: '出发(往返)日期', key: 'travelDates', width: 24 },
  { header: '航班号', key: 'flightNumbers', width: 18, roles: ['all', 'ticketing'] },
  { header: '订单类型', key: 'orderType', width: 10 },
  { header: '舱位等级', key: 'cabin', width: 10, roles: ['all', 'ticketing'] },
  { header: '结算价格', key: 'settlePrice', width: 10, roles: ['all'] },
  {
    header: '立减金额',
    key: 'settlementDiscountAmount',
    width: 10,
    note: '订单中立减快照行金额绝对值合计，按乘客人数均摊。',
    roles: ['all'],
  },
  { header: '尾款金额', key: 'balanceDue', width: 10, roles: ['all'] },
  { header: '已到账金额', key: 'settleReceived', width: 12, roles: ['all'] },
  { header: '单房差', key: 'singleRoomDiff', width: 8, roles: ['all'] },
  { header: '签证金额', key: 'visaAmount', width: 10, roles: ['all', 'visa'] },
  { header: '签证公司', key: 'visaSupplier', width: 16, roles: ['all', 'visa'] },
  { header: '签证状态', key: 'visaStatus', width: 10, roles: ['all', 'visa'] },
  { header: '开票状态', key: 'invoiceStatus', width: 10, roles: ['all'] },
  { header: '是否清账', key: 'settled', width: 8, roles: ['all'] },
  { header: '退款金额', key: 'refundAmount', width: 10, roles: ['all'] },
  { header: '护照签发地', key: 'passportIssuePlace', width: 12, roles: ['all', 'visa'] },
  { header: '出生地', key: 'placeOfBirth', width: 10, roles: ['all', 'visa'] },
  { header: '订单编号', key: 'orderNumber', width: 20 },
  { header: '乘客生日', key: 'dateOfBirth', width: 12 },
  { header: '乘客类型', key: 'passengerType', width: 8 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '国籍', key: 'nationality', width: 8 },
  { header: '证件类型', key: 'documentType', width: 8, roles: ['all', 'ticketing', 'visa'] },
  { header: '证件编号', key: 'documentNumber', width: 16, roles: ['all', 'ticketing', 'visa'] },
  { header: '证件签发日', key: 'issueDate', width: 12, roles: ['all', 'visa'] },
  { header: '证件有效期', key: 'expiryDate', width: 12, roles: ['all', 'ticketing', 'visa'] },
  { header: '分房情况', key: 'distribution', width: 16, roles: ['all'] },
  { header: '订单成本', key: 'orderCost', width: 24, roles: ['all'] },
  { header: '录入时间', key: 'recordedAt', width: 18 },
  { header: '录入人员', key: 'recordedBy', width: 14 },
];

/** 按岗位视图筛出可见列（role=all/缺省 → 全部；否则保留 roles 命中或未限定 role 的列）。*/
export function visibleColumns(role: MasterExportRole): MasterColumn[] {
  if (role === 'all') return MASTER_COLUMNS;
  return MASTER_COLUMNS.filter((c) => !c.roles || c.roles.includes(role));
}

// ── 取数形态 ────────────────────────────────────────────────────────────────
/** Prisma include（取数 + 测试类型共享）。*/
export const MASTER_EXPORT_INCLUDE = {
  agent: { select: { companyName: true } },
  user: { select: { displayName: true, email: true } },
  passengers: true,
  payments: true,
  refunds: true,
  costItems: true,
  items: {
    include: {
      flightSchedule: {
        include: {
          flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
        },
      },
      hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
      visa: { select: { visaName: true, visaType: true, supplier: true } },
      // 套餐(BUNDLE)行关联的套餐定义：取 items JSON 以捞出签证组件的挂牌价（qty×unitPrice）。
      bundle: { select: { items: true } },
      fulfillmentTasks: { select: { type: true, status: true } },
    },
  },
} satisfies Prisma.OrderInclude;

export type OrderForMasterExport = Prisma.OrderGetPayload<{ include: typeof MASTER_EXPORT_INCLUDE }>;

// ── 常旅客历史飞行次数 / 在订未飞 / 可用次数（TravelerProfile 快照 + 权益核销台账）──────
/** 一位旅客的三项快照口径数字：飞行次数（已飞）/ 在订未飞 / 可用次数（已飞−已核销，可为负）。*/
export interface TripStats {
  tripCount: number;
  pendingTripCount: number;
  availableTrips: number;
}

/** docKey(证件类型|证件号) → 该旅客的三项快照数字。渲染纯函数只认这张 Map，不碰 DB。*/
export type TripStatsMap = Map<string, TripStats>;

/** 快照新鲜度：本次导出用到的档案里最旧的一条重建时间（null = 一条都没匹配上）。*/
export interface TripCountLookup {
  tripStats: TripStatsMap;
  /** 表头批注用：让读表的人知道这几列是快照、有多旧。*/
  oldestRefreshedAt: Date | null;
}

/** mergedIntoId 指针链解析用的最小行。*/
interface ProfileRef {
  id: string;
  documentType: DocumentType;
  documentNumber: string;
  tripCount: number;
  pendingTripCount: number;
  refreshedAt: Date;
  mergedIntoId: string | null;
}

/** 合并链最大跟随跳数：merge() 禁止并入指针行 → 数据上不该有链；给足冗余并防脏数据死循环。*/
const MAX_MERGE_HOPS = 4;

/**
 * 拉取本次导出全部乘客的常旅客档案 → docKey → { 飞行次数, 在订未飞, 可用次数 }。
 *
 * 无 N+1：先按 (证件类型,证件号) 组合一次 findMany（走 @@unique([documentType, documentNumber])），
 * 再对「命中的档案是指针行（mergedIntoId 非空）」的情况按 id 批量补拉主档案 —— 每一跳一条查询，
 * 实践中最多一跳（合并时禁止把档案并入指针行，链深恒为 1）。之后再加一条 groupBy 取回全部命中
 * 主档案的已核销次数合计（可用次数 = 飞行次数 − 已核销）。几百位乘客也只有 2~3 条查询。
 *
 * mergedIntoId：合并过的档案 tripCount/pendingTripCount 累积在主档案上，指针行留的是合并前的
 * 残值 —— 直读源档案会少算；核销流水（TravelerBenefitRedemption）同理只挂在主档案上。命中
 * 指针行时沿链跟随到主档案取值（防环：记录已访问 id）。客人报旧护照号下的单，也能因此拿到
 * 归一后的真实数字。
 */
export async function loadTripCountMap(
  passengers: readonly { documentType: DocumentType; documentNumber: string }[],
  client: PrismaClient = defaultPrisma,
): Promise<TripCountLookup> {
  const select = {
    id: true,
    documentType: true,
    documentNumber: true,
    tripCount: true,
    pendingTripCount: true,
    refreshedAt: true,
    mergedIntoId: true,
  } as const;

  // 证件对去重（同一旅客在多张订单里重复出现 → 只查一次）
  const pairByKey = new Map<string, { documentType: DocumentType; documentNumber: string }>();
  for (const p of passengers) {
    if (!p.documentNumber) continue; // 证件号缺失 → 无从匹配，留空
    pairByKey.set(docKey(p.documentType, p.documentNumber), {
      documentType: p.documentType,
      documentNumber: p.documentNumber,
    });
  }
  if (pairByKey.size === 0) return { tripStats: new Map(), oldestRefreshedAt: null };

  // SQL 侧与内存侧 docKey 同口径归一（trim + 忽略大小写）：档案列存的是乘客行原始写法，
  // 精确匹配会让大小写/空格变体在查询层就漏掉，后面的 docKey 归一根本没机会兜住。
  const matched = (await client.travelerProfile.findMany({
    where: {
      OR: [...pairByKey.values()].map((p) => ({
        documentType: p.documentType,
        documentNumber: { equals: p.documentNumber.trim(), mode: Prisma.QueryMode.insensitive },
      })),
    },
    select,
  })) as ProfileRef[];

  // 指针行 → 批量补拉主档案（按 id in，逐跳；命中即停）
  const byId = new Map<string, ProfileRef>(matched.map((r) => [r.id, r]));
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const wanted = [...byId.values()]
      .map((r) => r.mergedIntoId)
      .filter((id): id is string => id !== null && !byId.has(id));
    if (wanted.length === 0) break;
    const masters = (await client.travelerProfile.findMany({
      where: { id: { in: [...new Set(wanted)] } },
      select,
    })) as ProfileRef[];
    if (masters.length === 0) break; // 断链（主档案被删）→ 停在当前行，用其残值而非空
    for (const m of masters) byId.set(m.id, m);
  }

  // 已核销次数合计（可用次数 = 飞行次数 − 已核销）：一次 groupBy 覆盖全部命中的主档案，
  // 与 traveler-benefits.service.ts 的 loadRedeemedTripsByProfile 同口径，
  // 此处不复用该函数——它内部固定读默认 prisma，本函数需支持注入 client 以便单测。
  const masterIds = new Set<string>();
  for (const row of matched) masterIds.add(resolveMaster(row, byId).id);
  let redeemedByProfile = new Map<string, number>();
  if (masterIds.size > 0) {
    // Prisma 5 的 groupBy 条件泛型在注入 PrismaClient 时会把可选 orderBy 推成错误的
    // 必填交集；这里固定本查询的参数/结果形状，保留编译期字段约束又避免污染业务调用。
    const groupByRedemptions = client.travelerBenefitRedemption.groupBy as unknown as (args: {
      by: ['profileId'];
      where: { profileId: { in: string[] } };
      orderBy: { profileId: 'asc' };
      _sum: { tripsUsed: true };
    }) => Promise<{ profileId: string; _sum: { tripsUsed: number | null } }[]>;
    const redemptionGroups = await groupByRedemptions({
      by: ['profileId'],
      where: { profileId: { in: [...masterIds] } },
      orderBy: { profileId: 'asc' },
      _sum: { tripsUsed: true },
    });
    redeemedByProfile = new Map(redemptionGroups.map((g) => [g.profileId, g._sum.tripsUsed ?? 0]));
  }

  const tripStats: TripStatsMap = new Map();
  let oldestRefreshedAt: Date | null = null;
  for (const row of matched) {
    const master = resolveMaster(row, byId);
    const redeemedTrips = redeemedByProfile.get(master.id) ?? 0;
    tripStats.set(docKey(row.documentType, row.documentNumber), {
      tripCount: master.tripCount,
      pendingTripCount: master.pendingTripCount,
      availableTrips: master.tripCount - redeemedTrips,
    });
    if (!oldestRefreshedAt || master.refreshedAt < oldestRefreshedAt) {
      oldestRefreshedAt = master.refreshedAt;
    }
  }
  return { tripStats, oldestRefreshedAt };
}

/**
 * 沿 mergedIntoId 链解析到主档案。
 * 与 travelers/traveler-profiles.service.ts 的 resolveMasterRef 同款口径（该函数为模块私有、
 * 未导出，本文件不改 travelers/ 故就近实现）：断链（主档案被删）/ 环（脏数据）时停在当前行，
 * 不抛错不死循环 —— 脏数据只会让这一条取到残值，不拖垮整表导出。
 */
function resolveMaster(start: ProfileRef, byId: Map<string, ProfileRef>): ProfileRef {
  let current = start;
  const seen = new Set<string>([current.id]);
  while (current.mergedIntoId) {
    const next = byId.get(current.mergedIntoId);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/**
 * 空表首建兜底：若本次导出确实有乘客、但快照表一条记录都没有（新环境 / 从没人开过档案页），
 * 直接读 loadTripCountMap 只会拿到空 Map → 整列留空。这里同步做一次全量重建把表填起来。
 *
 * 只处理「空表」这一种情况——非空但过期的快照不归导出管，那是档案页自身访问时
 * （traveler-profiles.service.ts 的 ensureFresh）负责的后台刷新；导出依旧不为过期快照
 * 触发重建（全量重建太慢，不能挂在每次导出请求上，见文件头部口径说明）。
 *
 * rebuild 参数化：便于单测在不真正跑全量重建的前提下断言「空表触发/非空不触发」。
 */
export async function bootstrapTripCountProfilesIfEmpty(
  passengerCount: number,
  client: PrismaClient,
  rebuild: () => Promise<unknown>,
): Promise<void> {
  if (passengerCount === 0) return;
  const existing = await client.travelerProfile.count();
  if (existing > 0) return;
  await rebuild();
}

// ── 订单 → 每位乘客一行 ─────────────────────────────────────────────────────
/**
 * 把一张订单展开成 N 行（每位乘客一行），字段尽量填满系统真实存有的数据。
 * 纯函数（不碰 DB），便于单测；金额均为「每位出行人」均摊。
 */
export function orderToMasterRows(
  order: OrderForMasterExport,
  tripStats: TripStatsMap = new Map(),
): Omit<MasterRow, 'seq'>[] {
  const paxCount = Math.max(1, order.passengers.length);

  // ── 航段（按出发时间排序）──
  const legs = order.items
    .filter((it) => it.kind === 'FLIGHT' && it.flightSchedule)
    .map((it) => ({
      departureTime: it.flightSchedule!.departureTime,
      departureTz: it.flightSchedule!.departureTz ?? null,
      flightNumber: it.flightSchedule!.flight.flightNumber,
      cabin: it.flightCabin,
    }))
    .sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());

  const travelDates =
    legs.length === 0
      ? ''
      : legs.length === 1
        ? fmtDepartDate(legs[0].departureTime, legs[0].departureTz)
        : `${fmtDepartDate(legs[0].departureTime, legs[0].departureTz)} / ${fmtDepartDate(
            legs[legs.length - 1].departureTime,
            legs[legs.length - 1].departureTz,
          )}`;
  const flightNumbers = legs.map((l) => l.flightNumber).join(' ⇌ ');
  const cabinLabels = Array.from(
    new Set(legs.filter((l) => l.cabin).map((l) => CABIN_LABEL[l.cabin!] ?? l.cabin!)),
  ).join(' / ');

  // ── 订单类型：两段及以上=往返票 / 一段=单程票 / 无机票按品类 ──
  let orderType: string;
  if (legs.length >= 2) orderType = '往返票';
  else if (legs.length === 1) orderType = '单程票';
  else {
    const kind = (['BUNDLE', 'HOTEL', 'VISA', 'TRANSFER', 'INSURANCE'] as const).find((k) =>
      order.items.some((it) => it.kind === k),
    );
    orderType = kind ? ORDER_KIND_LABEL[kind] : '';
  }

  // ── 酒店中文名（订单项口径，去重）──
  // 作为「酒店中文名称」列的**回退**值（0722 财务反馈）：乘客没有分房记录时用它，保持现状。
  // 任何"关联了酒店房型"的订单行都算（不限 kind）：套餐(BUNDLE)把房型盖在 BUNDLE 行上、
  // 无独立 HOTEL 行，若只认 kind==='HOTEL' 会漏掉套餐单的酒店名。Set 去重防同名重复计。
  const hotelNamesFallback = Array.from(
    new Set(
      order.items
        .filter((it) => it.hotelRoomType)
        .map((it) => it.hotelRoomType!.hotel.name)
        .filter(Boolean),
    ),
  ).join(' / ');

  // ── 金额口径（均摊到人）──
  // per-pax 采用「订单总额÷乘客数」均摊，与详情页按年龄段反推的另一套口径不同（P2-15c，
  // 待产品统一口径，此处不擅自改成年龄段——会改变现有导出数字）。
  const total = dec(order.total);
  const paid = dec(order.paidAmount);
  // 售后费（改期费/换人费等）走 adjustmentCny，不在 total 里；代理预付款抵扣走 prepaymentOffset。
  // 尾款/是否清账都要把两者算进「应付」，否则售后费从表上直接消失（P1-9），且用预付款抵扣过的
  // 代理订单会尾款偏大、已结清误显示未结清。口径与 reminders.rules.ts computeBalance /
  // reports.service.ts balanceOf 对齐：应付 = total + adjustmentCny − prepaymentOffset。
  const adjustment = order.adjustmentCny ?? 0;
  const prepaymentOffset = dec(order.prepaymentOffset);
  const settlePerPax = round2(total / paxCount);
  const settlementDiscountTotal = order.items.reduce((sum, item) => {
    const metadata = item.metadata;
    if (
      metadata == null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      (metadata as { settlementDiscount?: unknown }).settlementDiscount !== true ||
      (metadata as { settlementDiscountRevoked?: unknown }).settlementDiscountRevoked === true
    ) {
      return sum;
    }
    return sum + Math.abs(dec(item.amount));
  }, 0);
  const settlementDiscountPerPax = round2(settlementDiscountTotal / paxCount);
  const paidPerPax = round2(paid / paxCount);
  const balancePerPax = round2(Math.max(0, total + adjustment - paid - prepaymentOffset) / paxCount);
  const settled = paid + prepaymentOffset >= total + adjustment ? '是' : '否';

  // ── 签证：金额 + 状态 ──
  // 独立 VISA 行的实收金额（客人单买签证时的口径）。
  const visaItems = order.items.filter((it) => it.kind === 'VISA');
  const visaAmountStandalone = visaItems.reduce((s, it) => s + dec(it.amount), 0);
  // 套餐(BUNDLE)行：签证费并入折后套餐价、订单行不单列，但套餐定义 items JSON 里仍有
  // 签证组件的挂牌价。此处取套餐定义中 VISA 组件的挂牌价（qty×unitPrice）补上，
  // 让套餐单的签证金额不再显示 0。口径说明：客人付的是折后套餐总价，本列反映的是
  // 套餐里签证部分的「挂牌价」（list price），仅供运营核对签证分摊，非实收拆分额。
  const visaAmountBundle = order.items.reduce((s, it) => {
    if (it.kind !== 'BUNDLE') return s;
    // B14 快照优先（2026-07-20）：新单下单时把签证挂牌价快照进行 metadata.visaListSnapshotCny
    //（含 0 = 当时不含签证组件），历史导出钉死在下单时点，不再随套餐改价漂移。
    // 老单（无快照字段）回退现行定义反推——行为与旧版一致，仅供核对，非实收拆分。
    const meta = (it.metadata ?? null) as { visaListSnapshotCny?: unknown } | null;
    if (meta && typeof meta.visaListSnapshotCny === 'number') {
      return s + meta.visaListSnapshotCny;
    }
    if (!it.bundle) return s;
    const components = Array.isArray(it.bundle.items)
      ? (it.bundle.items as unknown as BundleItemJson[])
      : [];
    const bundleVisa = components
      .filter((c) => c && c.kind === 'VISA')
      .reduce((acc, c) => acc + (Number(c.qty) || 0) * (Number(c.unitPrice) || 0), 0);
    return s + bundleVisa;
  }, 0);
  const visaAmountOrder = visaAmountStandalone + visaAmountBundle;
  // 状态：订单级签证状态优先，回落到任意订单行的签证履约任务。
  // 不限 kind —— 套餐(BUNDLE)含签证时 VISA_APPLICATION 任务挂在 BUNDLE 行上（无独立 VISA 行），
  // 只从 VISA 行找会让套餐含签证单的签证状态漏显；跨全部行找可覆盖套餐单。
  const visaTask = order.items
    .flatMap((it) => it.fulfillmentTasks)
    .find((t) => t.type === 'VISA_APPLICATION');
  const visaStatus = order.visaStatus
    ? VISA_REQUIREMENT_LABEL[order.visaStatus] ?? order.visaStatus
    : visaTask
      ? FULFILLMENT_STATUS_LABEL[visaTask.status] ?? visaTask.status
      : '';
  // 签证公司（财务反馈：需清晰核对某笔签证金额属于哪家供应商）：取独立 VISA 行关联产品的 supplier，
  // 多签证产品去重后逗号拼接；无 supplier 留空。套餐内签证组件无独立供应商字段，故只认 VISA 行。
  const visaSupplier = Array.from(
    new Set(
      order.items
        .filter((it) => it.kind === 'VISA' && it.visa?.supplier)
        .map((it) => it.visa!.supplier!),
    ),
  ).join(', ');

  // ── 单房差：从酒店/套餐行 metadata.singleRoomDiff 汇总（系统若无该字段 → 0）──
  const singleRoomDiffOrder = order.items.reduce((s, it) => {
    const meta = (it.metadata ?? null) as { singleRoomDiff?: unknown } | null;
    const v = meta && typeof meta.singleRoomDiff === 'number' ? meta.singleRoomDiff : 0;
    return s + v;
  }, 0);

  // ── 退款：已完成退款金额合计 ──
  const refundTotal = order.refunds
    .filter((r) => r.status === 'COMPLETED')
    .reduce((s, r) => s + dec(r.amount), 0);

  // ── 订单成本（OrderCostItem）：类别 金额，多条 ' + ' 连接 ──
  const orderCost = order.costItems
    .map((c) => `${COST_CATEGORY_LABEL[c.category] ?? c.category} ${round2(dec(c.amountCny))}`)
    .join(' + ');

  // ── 备注：结构化四栏 + 自由文本 ──
  const baseNotes = [
    order.noteSpecial,
    order.noteHotel,
    order.noteVisa,
    order.notePayment,
    order.notes,
  ]
    .filter(Boolean)
    .join(' / ');

  const agency = order.agent?.companyName ?? '直客';
  // 开票状态（P2-15a）：六态开票只写三布尔（outboundInvoiced/returnInvoiced/systemInvoiced），
  // 旧字段 order.invoiceStatus 不再回写 → 读旧字段会让已开票订单恒显示"未开"。改读三布尔，
  // 文案与 orders.export-templates.ts 的 full 模板（invoiceStatusSys/invoiceStatusManual，
  // 见该文件 448-455 行）同口径，三态合并进一列：去程已开/回程已开/系统已开（'/' 连接）。
  const { returnScheduleId } = determineFlightLegs(order.items);
  const invoicedParts: string[] = [];
  if (order.outboundInvoiced) invoicedParts.push('去程已开');
  if (returnScheduleId && order.returnInvoiced) invoicedParts.push('回程已开');
  if (order.systemInvoiced) invoicedParts.push('系统已开');
  const invoiceStatus = invoicedParts.length > 0 ? invoicedParts.join('/') : '未开';
  // 录入时间是「动作发生时刻」，按北京时间输出（容器 TZ 是 UTC，直接取 UTC 分量会少 8 小时）
  const recordedAt = businessDateTime(order.createdAt);
  // 游客单（user=null）没有录单账号 → 统一记「散客」，不拿客人自己的名字冒充录入人。
  const recordedBy = order.user?.displayName ?? order.user?.email ?? GUEST_RECORDED_BY_LABEL;
  const roomGroups = parseRoomGroups(order.roomAssignment);
  // 有酒店 = 任何订单行关联了酒店房型（不限 kind）。套餐(BUNDLE)把房型盖在 BUNDLE 行上，
  // 只认 kind==='HOTEL' 会让套餐单永远不显示"未分房"。分房情况据此对未分房乘客回落"未分房"。
  const hasHotel = order.items.some((it) => it.hotelRoomTypeId);

  // 分房情况（每位乘客各算）：分了房 → "房N·拼房/整间"；未分房但有酒店 → "未分房"；无酒店 → ""
  let roomSeq = 0;
  const groupRoomNo = new Map<string, number>();

  return order.passengers.map<Omit<MasterRow, 'seq'>>((p) => {
    const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
    let distribution: string;
    if (group) {
      let no = groupRoomNo.get(group.id);
      if (no === undefined) {
        no = ++roomSeq;
        groupRoomNo.set(group.id, no);
      }
      const share = group.roomFraction === 0.5 ? '拼房' : '整间';
      distribution = `房${no}·${share}`;
    } else {
      distribution = hasHotel ? '未分房' : '';
    }

    // 备注叠加乘客分房组备注（酒店/房型/组备注）
    const groupInfo = group
      ? [group.hotelName, group.roomType, group.notes].filter(Boolean).join(' / ')
      : '';
    const notes = [baseNotes, groupInfo].filter(Boolean).join(' / ');

    // 飞行次数 / 在订未飞 / 可用次数：按本乘客证件号取常旅客档案的快照（每人各不相同）。
    // 匹配不到档案（新客/证件号对不上）→ 三项都留空，不臆造 0（0 会被读成"从没飞过"的结论）。
    const stats = p.documentNumber
      ? tripStats.get(docKey(p.documentType, p.documentNumber))
      : undefined;

    return {
      agency,
      notes,
      // 酒店中文名称（乘客行级，0722 财务反馈）：优先该乘客分房组的实际酒店（房控排房结果），
      // 无分房组 → 回退订单项口径 hotelNamesFallback（现状值），绝不留空。
      hotelName: resolveExportHotelName(group, hotelNamesFallback),
      chineseName: p.chineseName ?? p.fullName,
      // 称谓统一 MR/MS（不分年龄，0723 票务口径）；出发日仅供其他年龄派生场景沿用签名。
      passengerName: nameWithTitle(p, legs[0]?.departureTime ?? null),
      cleanName: pnrName(p),
      flightCount: stats === undefined ? '' : String(stats.tripCount),
      pendingTripCount: stats === undefined ? '' : String(stats.pendingTripCount),
      availableTrips: stats === undefined ? '' : String(stats.availableTrips),
      travelDates,
      flightNumbers,
      orderType,
      cabin: cabinLabels,
      settlePrice: settlePerPax,
      settlementDiscountAmount: settlementDiscountPerPax,
      balanceDue: balancePerPax,
      settleReceived: paidPerPax,
      singleRoomDiff: round2(singleRoomDiffOrder / paxCount),
      visaAmount: round2(visaAmountOrder / paxCount),
      visaSupplier,
      visaStatus,
      invoiceStatus,
      settled,
      refundAmount: round2(refundTotal / paxCount),
      passportIssuePlace: p.passportIssuePlace ?? p.passportIssueCountry ?? '',
      placeOfBirth: p.placeOfBirth ?? '',
      orderNumber: order.orderNumber,
      dateOfBirth: fmtDate(p.dateOfBirth),
      passengerType: PASSENGER_TYPE_LABEL[p.passengerType] ?? p.passengerType,
      gender: p.gender ? GENDER_LABEL[p.gender] ?? p.gender : '',
      nationality: toAlpha3(p.nationality),
      documentType: DOCUMENT_TYPE_LABEL[p.documentType] ?? p.documentType,
      documentNumber: p.documentNumber,
      issueDate: fmtDate(p.passportIssueDate),
      expiryDate: fmtDate(p.passportExpiry),
      distribution,
      orderCost,
      recordedAt,
      recordedBy,
    };
  });
}

/**
 * 构建全岗总表 xlsx（一个 worksheet，一行/乘客）。
 * @param query  { from, to, role }：出发日期区间 + 岗位视图
 * @param client 可选注入用于测试；缺省取默认 prisma
 */
export async function buildMasterExportWorkbook(
  query: MasterExportQuery,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const role: MasterExportRole = query.role ?? 'all';

  // 按出发日期区间选单：复用 buildOrderFilterWhere 的 travelFrom/travelTo 口径，
  // 再强制排除释放型状态。与整班/全岗导出选单方式一致。
  // 勾选导出：orderIds 给了就以 id 集合为准（buildOrderFilterWhere 内部忽略 from/to）。
  const where = buildOrderFilterWhere({
    travelFrom: query.from,
    travelTo: query.to,
    orderIds: query.orderIds,
  } as Parameters<typeof buildOrderFilterWhere>[0]);
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  and.push({ status: { in: COUNTED_STATUSES } });
  where.AND = and;

  const fetched = (await client.order.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: MASTER_EXPORT_INCLUDE,
  })) as OrderForMasterExport[];

  // 出发日期精确细筛（0722 财务反馈）：取数 where 的 travelFrom/travelTo（=from/to）故意宽召回
  // （±1 天 + 命中任意航段/入住日），会把返程日或邻日落在窗口内、但整单出发日不在区间的往返单
  // 也捞进来。这里按整单「出发日」（= 列表「出发日期」列同口径）二次过滤到 [from, to]。
  // 勾选导出（orderIds）：用户勾了哪些就导哪些，from/to 已被 buildOrderFilterWhere 忽略，不再二次筛。
  const orders =
    query.orderIds && query.orderIds.length > 0
      ? fetched
      : filterExportOrdersByDepartDate(fetched, query.from, query.to);

  // 飞行次数/在订未飞/可用次数：一次性拉回本次导出所有乘客的常旅客档案（无 N+1；几百行
  // 也只有 2~3 条查询，见 loadTripCountMap 头部注释）。快照表空表兜底：新环境/从没人开过
  // 档案页时表是空的，直读会让三列全部留空，故先同步首建一次；非空但过期的情况不管——
  // 刻意不为过期快照触发重建（全量重建太慢，不能挂在导出请求上），读到的是上次重建的快照，
  // 快照时间随表头批注一起标出，让读表的人知道这几列有多旧。
  const allPassengers = orders.flatMap((o) => o.passengers);
  await bootstrapTripCountProfilesIfEmpty(allPassengers.length, client, () =>
    new TravelerProfilesService().rebuildAll(),
  );
  const { tripStats, oldestRefreshedAt } = await loadTripCountMap(allPassengers, client);

  const cols = visibleColumns(role);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 全岗总表导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('全岗总表');
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  // 表头批注（诚实口径说明）。飞行次数/在订未飞/可用次数三列额外标出快照时间 ——
  // 都读自旅客档案快照表（+ 可用次数还叠了核销台账现读，但档案侧仍是快照），
  // 导出不重建，所以要让读表的人看到这批数字是什么时候算的。
  const SNAPSHOT_COLUMN_KEYS: ReadonlySet<keyof MasterRow> = new Set([
    'flightCount',
    'pendingTripCount',
    'availableTrips',
  ]);
  cols.forEach((c, i) => {
    if (!c.note) return;
    const note =
      SNAPSHOT_COLUMN_KEYS.has(c.key) && oldestRefreshedAt
        ? `${c.note}\n档案快照时间：${businessDateTime(oldestRefreshedAt)}（北京时间）`
        : c.note;
    ws.getRow(1).getCell(i + 1).note = note;
  });

  let seq = 0;
  for (const order of orders) {
    if (order.passengers.length === 0) continue;
    for (const row of orderToMasterRows(order, tripStats)) {
      seq += 1;
      // key-based addRow 只取可见列对应的 key，多余字段忽略 —— role 裁列天然生效
      ws.addRow({ seq, ...row });
    }
  }

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  // 「占位单」表：占位单不是订单（无名单、无订单号），任何按订单口径导出的表都看不见它，
  // 而收工时要逐条核对当天「留了哪几个团、几号的、多少座」恰恰只能看这张表。
  // 勾选导出（orderIds）是「导我勾的这几张订单」，不是按日期盘一天，故不附占位单表。
  if (!query.orderIds || query.orderIds.length === 0) {
    appendHoldOrderSheet(wb, await loadHoldExportRows(query.from, query.to, client));
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 文件名：`全岗总表_{from}_{to}.xlsx`（缺省日期用「全部」）。*/
export function masterExportFilename(from?: string, to?: string): string {
  const a = from ?? '全部';
  const b = to ?? from ?? '全部';
  return `全岗总表_${a}_${b}.xlsx`;
}
