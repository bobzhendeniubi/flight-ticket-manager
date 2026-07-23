/**
 * 三模板筛选导出 — 与订单列表共用筛选条件（buildOrderFilterWhere），一行/乘客。
 *
 *   full      《全岗可用》56 列 — 运营/财务/签证全岗位通用台账（53 列旧模版 + 纯拼音名 + 签证公司 + 订单状态）
 *   ticketing 《票务专用》27 列 — 代理+备注 + 航司 PNR 提交 25 列（仅含机票的订单）
 *   visa      《签证专用》21 列 — 越南签证申请表抬头（含越文表头，含签证公司列）
 *
 * 注意：系统暂无数据的列（飞行次数/单房差/抵扣人员等）保留表头、内容留空，
 * 绝不编造数据 —— 这些列是线下手工台账的占位，等后续字段补齐再填。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderItemKind, OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import type { BundleItemJson } from '../../lib/json-types.js';
import { toAlpha3 } from './nationality.js';
import {
  passengerToRow,
  earliestFlightDeparture,
  derivePtcByAge,
  type PnrRow,
  PNR_COLUMNS,
} from './pnr-export.js';
import { buildOrderFilterWhere } from './orders.service.js';
import { filterExportOrdersByDepartDate } from './orders.export-depart-filter.js';
import { determineFlightLegs } from './ticketing-cap.js';
import { parseRoomGroups, resolveExportHotelInfo } from './orders.export-room-allocation.js';
import type { ExportTemplatesQuery } from './orders.schemas.js';

export type OrderExportTemplate = ExportTemplatesQuery['template'];

export const ORDER_TEMPLATE_LABEL: Record<OrderExportTemplate, string> = {
  full: '全岗可用',
  ticketing: '票务专用',
  visa: '签证专用',
};

/** 与财务导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入。*/
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

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  WECHAT_PAY: '微信',
  ALIPAY: '支付宝',
  BANK_CARD: '银行卡',
  AGENT_PREPAYMENT: '代理预存',
};

const FULFILLMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '处理中',
  CONFIRMED: '已确认',
  CANCELLED: '已取消',
  FAILED: '失败',
};

/** 订单级签证状态（录单时选择，与履约任务状态区分）。全岗总表导出（orders.export-master.ts）共用。*/
export const VISA_REQUIREMENT_LABEL: Record<string, string> = {
  NOT_NEEDED: '不需要',
  NEEDED: '需要',
  E_VISA: '电子签',
  HAS_VISA: '已签证',
};

// 注：《全岗可用》模版对齐旧系统口径 —— 乘客类型/性别/证件类型均按旧模版原样
// 输出枚举/代码（ADULT、M、P），不译中文。

/** 订单状态中文标签（数据岗反馈：《全岗可用》需增订单状态列用于筛选）。
 * 覆盖 OrderStatus 全部 13 值；未知值兜底原文。此处自建完整映射，
 * 不复用 orders.export.ts 的映射（那份缺项，且另有安排不改动）。*/
const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
  FAILED: '失败',
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

// ── 小工具（与 finances.export.ts 同款）──────────────────────────────────
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

function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  return `${fmtDate(d)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** YYYY-MM-DD HH:MM:SS（旧《全岗可用》模版录入时间/到账时间含秒）*/
function fmtDateTimeSec(d: Date | null | undefined): string {
  if (!d) return '';
  return `${fmtDateTime(d)}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

/** 证件类型代码（旧模版此列填 'P'=护照，与航司/PNR 同款单字母口径）*/
const DOCUMENT_TYPE_CODE: Record<string, string> = { PASSPORT: 'P', ID_CARD: 'I' };

/** dd/mm/yyyy（越南签证表出生日期格式）*/
function fmtDateDMYSlash(d: Date | null | undefined): string {
  if (!d) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** dd-mm-yyyy（越南签证表护照有效期格式；分房表生日/有效期同款）*/
export function fmtDateDMYDash(d: Date | null | undefined): string {
  if (!d) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

/**
 * 乘客姓名 LASTNAME/FIRSTNAME（与 orders.export.ts 同款拆分）。
 * 拆分字段里可能残留护照逗号格式（源 fullName "WEI, HAIYANG" 按空白拆名时逗号会留在姓里 →
 * "WEI," / "HAIYANG"），先剥掉逗号与首尾空白再拼，避免产出 "WEI,/HAIYANG"。
 * fullName 回退分支同样把首个 ", " 规范成 "/" 并去掉残留逗号。
 */
export function pnrName(p: { lastName: string | null; firstName: string | null; fullName: string }): string {
  const strip = (s: string): string => s.replace(/,/gu, '').trim();
  if (p.lastName && p.firstName) {
    return `${strip(p.lastName)}/${strip(p.firstName)}`.toUpperCase();
  }
  // 回退：护照逗号格式 "WEI, HAIYANG" → "WEI/HAIYANG"；无逗号（如中文名"李四"）原样返回
  return p.fullName.includes(',')
    ? p.fullName.replace(/\s*,\s*/u, '/').replace(/,/gu, '').trim()
    : p.fullName;
}

/**
 * 乘客姓名 + 称谓（如 "ZHAO/WEI MR"）—— 0711 反馈「订单导出缺 MR/MS」。
 * 称谓口径：
 *   - 已手录 Passenger.title（如运营手工补录过）→ 优先直接用，原样大写。
 *   - 否则按「出发日 − 出生日期」实足年龄派生（复用 pnr-export.ts 的 derivePtcByAge，
 *     不改该函数；固定传 'ADULT' 作为兜底口径 —— 生日缺失时按成人处理，与录入的
 *     passengerType 无关，对齐「无生日数据 → 按成人」的口径）：
 *       成人（年龄 ≥12 或无生日数据）：M→MR，F→MS；性别未知/X → 不加称谓。
 *       儿童（2–<12）/ 婴儿（<2）：M→MSTR，F→MISS；性别未知/X → 不加称谓。
 *   - 出发日：调用方应传订单首航段（最早 FLIGHT 行）出发日；传空（纯地面单等取不到
 *     航段出发日的场景）时按当前日期近似估算年龄 —— 口径近似，不代表真实出行日。
 * 输出：pnrName(p) 后面空格 + 称谓；无称谓时原样返回 pnrName(p)，不产出多余尾随空格。
 */
export function nameWithTitle(
  p: {
    lastName: string | null;
    firstName: string | null;
    fullName: string;
    title?: string | null;
    gender?: string | null;
    dateOfBirth?: Date | null;
  },
  departDate?: Date | null,
): string {
  const name = pnrName(p);
  const manualTitle = p.title?.trim().toUpperCase();
  const title = manualTitle || deriveTitleByAge(p.dateOfBirth ?? null, p.gender ?? null, departDate ?? null);
  return title ? `${name} ${title}` : name;
}

function deriveTitleByAge(dob: Date | null, gender: string | null, departDate: Date | null): string {
  // 出发日拿不到 → 用当前日期近似（见 nameWithTitle 顶部注释的口径说明）。
  const at = departDate ?? new Date();
  const ptc = derivePtcByAge(dob, at, 'ADULT');
  const isMinor = ptc === 'CHD' || ptc === 'INF';
  if (gender === 'M') return isMinor ? 'MSTR' : 'MR';
  if (gender === 'F') return isMinor ? 'MISS' : 'MS';
  return '';
}

// ── 取数 ────────────────────────────────────────────────────────────────
export type OrderForTemplateExport = Prisma.OrderGetPayload<{
  include: {
    agent: { select: { companyName: true } };
    user: { select: { displayName: true; email: true } };
    passengers: true;
    payments: true;
    refunds: true;
    items: {
      include: {
        flightSchedule: {
          include: {
            flight: { select: { flightNumber: true; originCode: true; destinationCode: true } };
          };
        };
        hotelRoomType: { select: { name: true; hotel: { select: { name: true; code: true } } } };
        visa: { select: { code: true; visaName: true; visaType: true; supplier: true } };
        transfer: { select: { code: true } };
        bundle: { select: { code: true; items: true } };
        fulfillmentTasks: { select: { type: true; status: true } };
      };
    };
  };
}>;

// ── 订单级共享派生（三个模板都用）─────────────────────────────────────────
interface OrderContext {
  paxCount: number;
  agency: string;
  notes: string;
  hotelInfo: string; // 酒店类型 = 酒店名 + 房型名
  hotelNames: string; // 酒店名称 = 各酒店名去重，' / ' 连接
  travelDates: string; // 'YYYY-MM-DD / YYYY-MM-DD'（单段只有一个日期）
  flightNumbers: string; // ' ⇌ ' 连接
  route: string; // 航线 origin→dest，多段 ' / ' 连接（去重）
  flightLegCount: number;
  cabinLabels: string;
  orderType: string;
  settlePerPax: number; // 结算价格 = total ÷ pax
  paidPerPax: number; // 到账金额 = paidAmount ÷ pax
  // 尾款 = max(0, total + adjustmentCny − paidAmount − prepaymentOffset) ÷ pax。含售后费（改期费/
  // 换人费等走 adjustmentCny，不在 total 里）与代理预付款抵扣（prepaymentOffset）——漏掉任一项都会让
  // 尾款偏大（售后费消失 P1-9/P2-15b、抵扣过的代理订单尾款虚高），口径与 reminders.rules.ts
  // computeBalance / reports.service.ts balanceOf 对齐。
  balancePerPax: number;
}

export function buildOrderContext(order: OrderForTemplateExport): OrderContext {
  const paxCount = Math.max(1, order.passengers.length);

  // 航班段（按出发时间排序）
  const legs = order.items
    .filter((it) => it.kind === 'FLIGHT' && it.flightSchedule)
    .map((it) => ({
      departureTime: it.flightSchedule!.departureTime,
      flightNumber: it.flightSchedule!.flight.flightNumber,
      route: `${it.flightSchedule!.flight.originCode} → ${it.flightSchedule!.flight.destinationCode}`,
      cabin: it.flightCabin,
    }))
    .sort((a, b) => a.departureTime.getTime() - b.departureTime.getTime());
  const travelDates =
    legs.length === 0
      ? ''
      : legs.length === 1
        ? fmtDate(legs[0].departureTime)
        : `${fmtDate(legs[0].departureTime)} / ${fmtDate(legs[legs.length - 1].departureTime)}`;
  const flightNumbers = legs.map((l) => l.flightNumber).join(' ⇌ ');
  const route = Array.from(new Set(legs.map((l) => l.route))).join(' / ');
  const cabinLabels = Array.from(
    new Set(legs.filter((l) => l.cabin).map((l) => CABIN_LABEL[l.cabin!] ?? l.cabin!)),
  ).join(' / ');

  // 订单类型：两段机票=往返票 / 一段=单程票 / 无机票按品类
  let orderType: string;
  if (legs.length >= 2) orderType = '往返票';
  else if (legs.length === 1) orderType = '单程票';
  else {
    const kind = (['BUNDLE', 'HOTEL', 'VISA', 'TRANSFER', 'INSURANCE'] as const).find((k) =>
      order.items.some((it) => it.kind === k),
    );
    orderType = kind ? ORDER_KIND_LABEL[kind] : '';
  }

  // 酒店类型 = 酒店名 + 房型名。任何「关联了酒店房型」的订单行都算（不限 kind）：
  // 套餐(BUNDLE)把房型盖在 BUNDLE 行上、无独立 HOTEL 行，只认 kind==='HOTEL' 会让
  // 套餐单的酒店列整列空白（0720 公测反馈：导出缺酒店信息）。Set 去重防同名重复。
  const hotelPartSet = new Set<string>();
  const hotelNameSet = new Set<string>();
  for (const it of order.items) {
    if (it.hotelRoomType) {
      hotelPartSet.add(`${it.hotelRoomType.hotel.name} ${it.hotelRoomType.name}`);
      hotelNameSet.add(it.hotelRoomType.hotel.name);
    }
  }
  const hotelNames = Array.from(hotelNameSet).join(' / ');

  // per-pax 均摊口径（结算/到账/尾款）：订单总额 ÷ 乘客数，与订单详情页按年龄段反推价格的
  // 另一套口径不同（P2-15c，待产品统一），此处不擅自改成年龄段口径——会改变现有导出数字。
  // 尾款口径与财务/提醒/报表对齐：应付 = total + adjustmentCny − prepaymentOffset（代理预付款抵扣）。
  const total = dec(order.total);
  const paid = dec(order.paidAmount);
  const adjustment = order.adjustmentCny ?? 0;
  const prepaymentOffset = dec(order.prepaymentOffset);

  return {
    paxCount,
    agency: order.agent?.companyName ?? '直客',
    notes: order.notes ?? '',
    hotelInfo: Array.from(hotelPartSet).join(' + '),
    hotelNames,
    travelDates,
    flightNumbers,
    route,
    flightLegCount: legs.length,
    cabinLabels,
    orderType,
    settlePerPax: round2(total / paxCount),
    paidPerPax: round2(paid / paxCount),
    balancePerPax: round2(Math.max(0, total + adjustment - paid - prepaymentOffset) / paxCount),
  };
}

// ── 模板一：《全岗可用》56 列（旧模版 53 列同名同序 + 「纯拼音名」+「签证公司」+「订单状态」）──────
// 头部两行：0..49 列为单行表头（纵向合并两行）；末尾「订单成本」为分组表头，
// 跨「成本类型/子类型/金额」三子列（横向合并首行）。系统暂无数据的列一律留空，绝不编造。
// 定金组四列（定金/到账金额/到账时间/到账渠道）已移除：系统无定金模型，四列恒空，
// 且现行模版本身已删除该组。收款一律走 paidAmount + 收款流水。
interface FullRow {
  seq: number;
  isOriginalOrder: string; // 是否是原订单 — 暂无对应字段，留空
  agency: string; // 代理机构
  notes: string; // 备注
  hotelInfo: string; // 酒店类型（酒店名 + 房型）
  chineseName: string; // 中文名称
  passengerName: string; // 乘客姓名 LAST/FIRST + 称谓（航司口径）
  cleanName: string; // 纯拼音名 LAST/FIRST（无 MR/MS 称谓）— 财务对数/名单匹配用
  flightCount: string; // 飞行次数 — 暂无数据，留空
  travelDates: string; // 出发(往返)日期
  flightNumbers: string; // 航班号
  orderType: string; // 订单类型
  settlePrice: number; // 结算价格（人均）
  settleReceived: number; // 结算价到账金额（人均）
  settleReceivedAt: string; // 结算价到账时间
  settleChannel: string; // 结算价到账渠道
  balanceDue: number; // 尾款金额（人均）
  singleRoomDiff: string; // 单房差 — 暂无数据，留空
  singleRoomDiffReceived: string; // 单房差到账金额 — 留空
  visaAmount: number; // 签证金额（人均）
  visaReceived: string; // 签证到账金额 — 留空
  offsetAmount: number; // 抵扣金额（人均）
  offsetReceived: string; // 抵扣到账金额 — 留空
  offsetPerson: string; // 抵扣人员 — 留空
  offsetOrder: string; // 抵扣订单 — 留空
  settled: string; // 是否清账
  refundAmount: number; // 退款金额（人均）
  refundAt: string; // 退款时间
  refundChannel: string; // 退款渠道 — 留空
  orderStatus: string; // 订单状态（中文标签，数据岗筛选用）— 与开票/签证状态列聚在一起
  invoiceStatusSys: string; // 系统开票状态（systemInvoiced：是/否）
  invoiceStatusManual: string; // 开票状态 — 按航段已开的组合文本（去程已开/回程已开），都未开则留空
  visaStatus: string; // 签证状态
  visaOption: string; // 签证选项（独立签证行产品名 + 套餐签证组件名）
  visaSupplier: string; // 签证公司（供应商）— 财务对账用，与《签证专用》同口径
  visaNote: string; // 签证备注 = 订单「签证备注」结构化栏（noteVisa）
  passportIssuePlace: string; // 护照签发地
  placeOfBirth: string; // 出生地
  orderNumber: string; // 订单编号
  cabin: string; // 舱位等级
  dateOfBirth: string; // 乘客生日 DD-MM-YYYY
  passengerType: string; // 乘客类型（旧模版原样枚举 ADULT/CHILD/INFANT）
  distribution: string; // 分销状态 — 暂无数据，留空
  gender: string; // 性别（旧模版原样 M/F）
  nationality: string; // 国籍 ISO alpha-3
  documentType: string; // 证件类型（P=护照）
  documentNumber: string; // 证件编号
  issueDate: string; // 签发日期 DD-MM-YYYY
  expiryDate: string; // 有效日期 DD-MM-YYYY
  infantWith: string; // 婴儿随行成员 — 留空
  recordedAt: string; // 录入时间 YYYY-MM-DD HH:MM:SS
  recordedBy: string; // 录入人员
  temp: string; // 临时 — 留空
  costType: string; // 订单成本·成本类型 — 留空
  costSubType: string; // 订单成本·子类型 — 留空
  costAmount: string; // 订单成本·金额 — 留空
}

export const FULL_COLUMNS: Array<{ header: string; key: keyof FullRow; width: number }> = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '是否是原订单', key: 'isOriginalOrder', width: 12 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '备注', key: 'notes', width: 22 },
  { header: '酒店类型', key: 'hotelInfo', width: 24 },
  { header: '中文名称', key: 'chineseName', width: 12 },
  { header: '乘客姓名', key: 'passengerName', width: 18 },
  { header: '纯拼音名', key: 'cleanName', width: 16 },
  { header: '飞行次数', key: 'flightCount', width: 8 },
  { header: '出发(往返)日期', key: 'travelDates', width: 24 },
  { header: '航班号', key: 'flightNumbers', width: 18 },
  { header: '订单类型', key: 'orderType', width: 10 },
  { header: '结算价格', key: 'settlePrice', width: 10 },
  { header: '结算价到账金额', key: 'settleReceived', width: 14 },
  { header: '结算价到账时间', key: 'settleReceivedAt', width: 18 },
  { header: '结算价到账渠道', key: 'settleChannel', width: 14 },
  { header: '尾款金额', key: 'balanceDue', width: 10 },
  { header: '单房差', key: 'singleRoomDiff', width: 8 },
  { header: '单房差到账金额', key: 'singleRoomDiffReceived', width: 14 },
  { header: '签证金额', key: 'visaAmount', width: 10 },
  { header: '签证到账金额', key: 'visaReceived', width: 12 },
  { header: '抵扣金额', key: 'offsetAmount', width: 10 },
  { header: '抵扣到账金额', key: 'offsetReceived', width: 12 },
  { header: '抵扣人员', key: 'offsetPerson', width: 10 },
  { header: '抵扣订单', key: 'offsetOrder', width: 12 },
  { header: '是否清账', key: 'settled', width: 8 },
  { header: '退款金额', key: 'refundAmount', width: 10 },
  { header: '退款时间', key: 'refundAt', width: 18 },
  { header: '退款渠道', key: 'refundChannel', width: 10 },
  { header: '订单状态', key: 'orderStatus', width: 10 },
  { header: '系统开票状态', key: 'invoiceStatusSys', width: 12 },
  { header: '开票状态', key: 'invoiceStatusManual', width: 10 },
  { header: '签证状态', key: 'visaStatus', width: 10 },
  { header: '签证选项', key: 'visaOption', width: 20 },
  { header: '签证公司', key: 'visaSupplier', width: 16 },
  { header: '签证备注', key: 'visaNote', width: 14 },
  { header: '护照签发地', key: 'passportIssuePlace', width: 10 },
  { header: '出生地', key: 'placeOfBirth', width: 10 },
  { header: '订单编号', key: 'orderNumber', width: 20 },
  { header: '舱位等级', key: 'cabin', width: 10 },
  { header: '乘客生日', key: 'dateOfBirth', width: 12 },
  { header: '乘客类型', key: 'passengerType', width: 8 },
  { header: '分销状态', key: 'distribution', width: 8 },
  { header: '性别', key: 'gender', width: 6 },
  { header: '国籍', key: 'nationality', width: 8 },
  { header: '证件类型', key: 'documentType', width: 8 },
  { header: '证件编号', key: 'documentNumber', width: 16 },
  { header: '签发日期', key: 'issueDate', width: 12 },
  { header: '有效日期', key: 'expiryDate', width: 12 },
  { header: '婴儿随行成员', key: 'infantWith', width: 12 },
  { header: '录入时间', key: 'recordedAt', width: 20 },
  { header: '录入人员', key: 'recordedBy', width: 14 },
  { header: '临时', key: 'temp', width: 8 },
  // 「订单成本」分组下的三子列（表头首行合并为「订单成本」，见 applyFullHeader）。
  { header: '成本类型', key: 'costType', width: 12 },
  { header: '子类型', key: 'costSubType', width: 12 },
  { header: '金额', key: 'costAmount', width: 10 },
];

/** 末尾「订单成本」分组表头及其覆盖的子列数（成本类型/子类型/金额）。*/
const FULL_COST_GROUP_HEADER = '订单成本';
const FULL_COST_GROUP_SPAN = 3;

export function orderToFullRows(order: OrderForTemplateExport, ctx: OrderContext): Omit<FullRow, 'seq'>[] {
  // 乘客姓名列称谓（MR/MS/MSTR/MISS）按订单去程（最早 FLIGHT 行出发时间）派生年龄。
  const departureDate = earliestFlightDeparture(order.items);

  // 最近一笔成功收款（到账时间/渠道）
  const succeeded = order.payments
    .filter((p) => p.status === 'SUCCEEDED' && p.paidAt)
    .sort((a, b) => b.paidAt!.getTime() - a.paidAt!.getTime());
  const lastPayment = succeeded[0];

  // 已完成退款：金额合计 + 最近处理时间
  const completedRefunds = order.refunds.filter((r) => r.status === 'COMPLETED');
  const refundTotal = completedRefunds.reduce((s, r) => s + dec(r.amount), 0);
  const lastRefundAt = completedRefunds
    .map((r) => r.processedAt)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // 签证：金额合计 / 选项（产品名）/ 状态。
  // 套餐(BUNDLE)含签证时没有独立 VISA 行：签证履约任务挂在 BUNDLE 行上、签证组件名
  // 在套餐定义 items JSON 里 —— 只认 VISA 行会让套餐单的签证状态/选项整列空白
  //（0720 公测反馈：导出缺签证信息）。选项补套餐签证组件名；任务跨全部行找；
  // 状态优先订单级录单签证状态 —— 与全岗总表（orders.export-master.ts）同口径。
  const visaItems = order.items.filter((it) => it.kind === 'VISA');
  const visaAmountOrder = visaItems.reduce((s, it) => s + dec(it.amount), 0);
  const bundleVisaNames = order.items.flatMap((it) => {
    if (it.kind !== 'BUNDLE' || !it.bundle) return [];
    const components = Array.isArray(it.bundle.items)
      ? (it.bundle.items as unknown as BundleItemJson[])
      : [];
    return components.filter((c) => c && c.kind === 'VISA').map((c) => c.productName);
  });
  const visaOption = [
    ...visaItems.map((it) => it.visa?.visaName ?? it.visa?.visaType ?? it.description),
    ...bundleVisaNames,
  ]
    .filter(Boolean)
    .join(' + ');
  const visaTask = order.items
    .flatMap((it) => it.fulfillmentTasks)
    .find((t) => t.type === 'VISA_APPLICATION');
  const visaStatus = order.visaStatus
    ? VISA_REQUIREMENT_LABEL[order.visaStatus] ?? order.visaStatus
    : visaTask
      ? FULFILLMENT_STATUS_LABEL[visaTask.status] ?? visaTask.status
      : '';

  // 是否清账：已付 + 预付款抵扣 ≥ 应付（total + adjustmentCny），与上面 ctx.balancePerPax 同口径。
  // 不含 adjustmentCny 会出现"尾款>0 但已清账"的自相矛盾（P2-15b 连带修）；漏 prepaymentOffset
  // 则用预付款抵扣过的代理订单会已结清却误显示未结清。
  const settled =
    dec(order.paidAmount) + dec(order.prepaymentOffset) >= dec(order.total) + (order.adjustmentCny ?? 0)
      ? '是'
      : '否';

  // 六态开票（去程/回程/系统）——「系统开票状态」列反映 systemInvoiced；
  // 「开票状态」列（原手工列）填按航段已开的组合文本：去程/回程分别判定，回程仅在存在回程班次时列出。
  const invoiceStatusSys = order.systemInvoiced ? '是' : '否';
  const { returnScheduleId } = determineFlightLegs(order.items);
  const invoicedLegs: string[] = [];
  if (order.outboundInvoiced) invoicedLegs.push('去程已开');
  if (returnScheduleId && order.returnInvoiced) invoicedLegs.push('回程已开');
  const invoiceStatusManual = invoicedLegs.join('/');

  // 备注列对标旧系统：结构化四栏 + 自由文本，再按乘客叠加其分房组（酒店/房型/组备注）。
  const baseNotes = [order.noteSpecial, order.noteHotel, order.noteVisa, order.notePayment, order.notes]
    .filter(Boolean)
    .join(' / ');
  const roomGroups = parseRoomGroups(order.roomAssignment);

  return order.passengers.map<Omit<FullRow, 'seq'>>((p) => {
    // 分房：本乘客所在组的「酒店名/房型/组备注」拼成一段（如"利国 郭针针//三星大床"由组备注承载）
    const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
    const groupInfo = group
      ? [group.hotelName, group.roomType, group.notes].filter(Boolean).join(' / ')
      : '';
    const notes = [baseNotes, groupInfo].filter(Boolean).join(' / ');

    return {
    isOriginalOrder: '',
    agency: ctx.agency,
    notes,
    // 酒店类型（乘客行级，0722 财务反馈）：优先该乘客分房组的酒店名+房型（房控排房结果，
    // 房型也跟房控），无分房组 → 回退订单项口径 ctx.hotelInfo（现状值），绝不留空。
    hotelInfo: resolveExportHotelInfo(group, ctx.hotelInfo),
    chineseName: p.chineseName ?? p.fullName,
    passengerName: nameWithTitle(p, departureDate),
    cleanName: pnrName(p),
    flightCount: '',
    travelDates: ctx.travelDates,
    flightNumbers: ctx.flightNumbers,
    orderType: ctx.orderType,
    settlePrice: ctx.settlePerPax,
    settleReceived: ctx.paidPerPax,
    settleReceivedAt: lastPayment ? fmtDateTimeSec(lastPayment.paidAt) : '',
    settleChannel: lastPayment ? PAYMENT_METHOD_LABEL[lastPayment.method] ?? lastPayment.method : '',
    balanceDue: ctx.balancePerPax,
    singleRoomDiff: '',
    singleRoomDiffReceived: '',
    visaAmount: round2(visaAmountOrder / ctx.paxCount),
    visaReceived: '',
    offsetAmount: round2(dec(order.prepaymentOffset) / ctx.paxCount),
    offsetReceived: '',
    offsetPerson: '',
    offsetOrder: '',
    settled,
    refundAmount: round2(refundTotal / ctx.paxCount),
    refundAt: fmtDateTimeSec(lastRefundAt),
    refundChannel: '',
    orderStatus: ORDER_STATUS_LABEL[order.status] ?? order.status,
    invoiceStatusSys,
    invoiceStatusManual,
    visaStatus,
    visaOption,
    visaSupplier: visaSupplierOf(order),
    visaNote: order.noteVisa ?? '',
    passportIssuePlace: p.passportIssuePlace ?? p.passportIssueCountry ?? '',
    placeOfBirth: p.placeOfBirth ?? '',
    orderNumber: order.orderNumber,
    cabin: ctx.cabinLabels,
    // 旧模版日期口径：生日/签发/有效期 = DD-MM-YYYY；录入时间含秒。
    dateOfBirth: fmtDateDMYDash(p.dateOfBirth),
    // 旧模版原样枚举（ADULT/CHILD/INFANT），不译中文。
    passengerType: p.passengerType,
    distribution: '',
    // 旧模版原样代码（M/F），不译中文。
    gender: p.gender ?? '',
    nationality: toAlpha3(p.nationality),
    documentType: DOCUMENT_TYPE_CODE[p.documentType] ?? p.documentType,
    documentNumber: p.documentNumber,
    issueDate: fmtDateDMYDash(p.passportIssueDate),
    expiryDate: fmtDateDMYDash(p.passportExpiry),
    infantWith: '',
    recordedAt: fmtDateTimeSec(order.createdAt),
    // 游客单 user=null：回退到游客联系人姓名
    recordedBy: order.user?.displayName ?? order.user?.email ?? order.guestName ?? '',
    temp: '',
    costType: '',
    costSubType: '',
    costAmount: '',
    };
  });
}

/** 《全岗可用》两行表头：0..N-4 单列纵向合并两行；末尾 3 列并入「订单成本」分组（首行横向合并）。*/
function applyFullHeader(ws: ExcelJS.Worksheet): void {
  const leafBeforeGroup = FULL_COLUMNS.length - FULL_COST_GROUP_SPAN;
  const row1 = ws.getRow(1);
  const row2 = ws.getRow(2);
  FULL_COLUMNS.forEach((c, i) => {
    const col = i + 1;
    // 非分组列：表头文字放首行（随后与第二行纵向合并）；分组子列：叶子表头放第二行。
    if (i < leafBeforeGroup) row1.getCell(col).value = c.header;
    else row2.getCell(col).value = c.header;
  });
  // 「订单成本」分组标题落在首行、覆盖三子列。
  row1.getCell(leafBeforeGroup + 1).value = FULL_COST_GROUP_HEADER;
  for (let col = 1; col <= leafBeforeGroup; col += 1) ws.mergeCells(1, col, 2, col);
  ws.mergeCells(1, leafBeforeGroup + 1, 1, FULL_COLUMNS.length);
  for (const r of [row1, row2]) {
    r.font = { bold: true };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    r.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }
}

// ── 模板二：《票务专用》27 列 = 代理 + 备注 + 航司 PNR 25 列 ───────────────
type TicketingRow = { agency: string; notes: string } & PnrRow;

export const TICKETING_COLUMNS: Array<{ header: string; key: keyof TicketingRow; width: number }> = [
  { header: '代理', key: 'agency', width: 16 },
  { header: '备注', key: 'notes', width: 20 },
  ...PNR_COLUMNS.map((c) => ({ header: c.header, key: c.key as keyof TicketingRow, width: 18 })),
];

export function orderToTicketingRows(order: OrderForTemplateExport, ctx: OrderContext): TicketingRow[] {
  // PTC 按「出发日 − 出生日期」自动推算 —— 取订单 FLIGHT 行里最早的出发时间（去程）。
  const departureDate = earliestFlightDeparture(order.items);
  return order.passengers.map<TicketingRow>((p) => ({
    agency: ctx.agency,
    notes: ctx.notes,
    ...passengerToRow(p, departureDate),
  }));
}

// ── 模板三：《签证专用》21 列（含越文表头）───────────────────────────────
export interface VisaRow {
  stt: number;
  agency: string;
  notes: string;
  hotelInfo: string;
  visaNote: string; // 暂无数据 — 留空
  settlePrice: number;
  paidAmount: number;
  balanceDue: number;
  visaSupplier: string; // 签证公司（供应商/代办渠道）— 财务对账用，多签证去重逗号拼接，缺失留空
  chineseName: string;
  name: string;
  dateOfBirth: string;
  gender: string;
  nationalityNow: string;
  nationalityOrigin: string;
  occupation: string; // 暂无数据 — 留空
  workplace: string; // 暂无数据 — 留空
  passportNumber: string;
  issueDate: string; // Passenger.passportIssueDate（dd-mm-yyyy），缺失留空
  expiryDate: string;
  departDate: string;
}

export const VISA_COLUMNS: Array<{ header: string; key: keyof VisaRow; width: number }> = [
  { header: 'STT', key: 'stt', width: 6 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '备注信息', key: 'notes', width: 20 },
  { header: '酒店类型', key: 'hotelInfo', width: 24 },
  { header: '签证备注', key: 'visaNote', width: 14 },
  { header: '结算价格', key: 'settlePrice', width: 10 },
  { header: '到账金额', key: 'paidAmount', width: 10 },
  { header: '尾款金额', key: 'balanceDue', width: 10 },
  { header: '签证公司', key: 'visaSupplier', width: 16 },
  { header: '中文姓名', key: 'chineseName', width: 12 },
  { header: 'Họ và tên (*)\n姓名', key: 'name', width: 20 },
  { header: 'Ngày, tháng, năm sinh (*)\n出生日期', key: 'dateOfBirth', width: 16 },
  { header: 'Giới tính (*)\n性别', key: 'gender', width: 8 },
  { header: 'Quốc tịch hiện nay (*)', key: 'nationalityNow', width: 12 },
  { header: 'Quốc tịch gốc', key: 'nationalityOrigin', width: 12 },
  { header: 'Nghề nghiệp (*)\n职业', key: 'occupation', width: 12 },
  { header: 'Nơi làm việc\n工作地址', key: 'workplace', width: 16 },
  { header: 'Số hộ chiếu (*)\n护照号', key: 'passportNumber', width: 16 },
  { header: '签发日期', key: 'issueDate', width: 12 },
  { header: '有效日期', key: 'expiryDate', width: 12 },
  { header: '出发日期', key: 'departDate', width: 24 },
];

// 签证公司（财务反馈：需清晰核对某笔签证金额属于哪家供应商）：取订单 VISA 行关联产品的 supplier，
// 多签证产品去重后逗号拼接；无 supplier 留空。仅认独立 VISA 行——套餐内签证组件无独立供应商字段。
// 《全岗可用》与《签证专用》共用取数点。
export function visaSupplierOf(order: OrderForTemplateExport): string {
  return Array.from(
    new Set(
      order.items
        .filter((it) => it.kind === 'VISA' && it.visa?.supplier)
        .map((it) => it.visa!.supplier!),
    ),
  ).join(', ');
}

export function orderToVisaRows(order: OrderForTemplateExport, ctx: OrderContext): Omit<VisaRow, 'stt'>[] {
  const visaSupplier = visaSupplierOf(order);
  // 分房组（0722 财务反馈）：酒店类型列按乘客所在分房组的实际酒店取，与《全岗可用》同口径。
  const roomGroups = parseRoomGroups(order.roomAssignment);
  // 自备签乘客（visaExempt=true）不进送签名单：客人已自行办妥签证，无需送签——与签证台
  // 同口径（backend/src/modules/fulfillment/fulfillment.service.ts 的 listByOrder 同样过滤
  // passengers 时排除 visaExempt=true）。此函数是「签证专用」模板导出 + 签证批量合并名单
  // （orders.export-visa-bundle.ts）共用的唯一取数点，这里过滤即两处一起生效（P1-13）。
  // 金额仍按订单全部乘客均摊（ctx.paxCount 不受影响）——只影响谁出现在名单里。
  return order.passengers
    .filter((p) => p.visaExempt !== true)
    .map<Omit<VisaRow, 'stt'>>((p) => {
    const group = roomGroups.find((g) => g.passengerIds.includes(p.id));
    return {
    agency: ctx.agency,
    notes: ctx.notes,
    // 酒店类型（乘客行级，0722 财务反馈）：优先该乘客分房组的酒店名+房型（房控），
    // 无分房组 → 回退订单项口径 ctx.hotelInfo（现状值），绝不留空。
    hotelInfo: resolveExportHotelInfo(group, ctx.hotelInfo),
    visaNote: '',
    settlePrice: ctx.settlePerPax,
    paidAmount: ctx.paidPerPax,
    balanceDue: ctx.balancePerPax,
    visaSupplier,
    // 与《全岗可用》模板一致：优先中文名，缺失才回退 fullName（避免中文名列显示成英文名）
    chineseName: p.chineseName ?? p.fullName,
    // 签证名单姓名列只填纯拼音名 LAST/FIRST（签证岗反馈：英文名不需要带性别称谓——
    // 本表另有独立「性别」列 Giới tính，无需在姓名里体现 MR/MS）。
    name: pnrName(p),
    dateOfBirth: fmtDateDMYSlash(p.dateOfBirth),
    gender: p.gender ?? '',
    nationalityNow: toAlpha3(p.nationality),
    nationalityOrigin: toAlpha3(p.nationality),
    occupation: '',
    workplace: '',
    passportNumber: p.documentNumber,
    issueDate: fmtDateDMYDash(p.passportIssueDate),
    expiryDate: fmtDateDMYDash(p.passportExpiry),
    departDate: ctx.travelDates,
    };
  });
}

// ── 主入口 ──────────────────────────────────────────────────────────────
export async function buildOrderTemplateExportWorkbook(
  query: ExportTemplatesQuery,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  // 与列表完全一致的筛选 + 强制排除不计数状态（已取消/超时/失败等）
  const where = buildOrderFilterWhere(query);
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  and.push({ status: { in: COUNTED_STATUSES } });
  // 票务模板只导出含机票的订单
  if (query.template === 'ticketing') {
    and.push({ items: { some: { kind: OrderItemKind.FLIGHT } } });
  }
  where.AND = and;

  const fetched = (await client.order.findMany({
    where,
    // 名单按录入倒序（最新录入在最上），对标旧系统
    orderBy: { createdAt: 'desc' },
    include: {
      agent: { select: { companyName: true } },
      user: { select: { displayName: true, email: true } },
      passengers: true,
      payments: true,
      refunds: true,
      items: {
        include: {
          flightSchedule: {
            include: { flight: { select: { flightNumber: true, originCode: true, destinationCode: true } } },
          },
          hotelRoomType: { select: { name: true, hotel: { select: { name: true, code: true } } } },
          visa: { select: { code: true, visaName: true, visaType: true, supplier: true } },
          transfer: { select: { code: true } },
          bundle: { select: { code: true, items: true } },
          fulfillmentTasks: { select: { type: true, status: true } },
        },
      },
    },
  })) as OrderForTemplateExport[];

  // 出发日期精确细筛（0722 财务反馈）：取数 where 的 travelFrom/travelTo 故意宽召回
  // （±1 天 + 命中任意航段/入住日），会把返程日或邻日落在窗口内、但整单出发日不在区间的往返单
  // 也捞进来。这里按整单「出发日」（= 列表「出发日期」列同口径）二次过滤到 [travelFrom, travelTo]。
  //   - scheduleId（整班·全岗精确导出）：取数已按班次精确圈定，出发日细筛不适用，原样放行；
  //   - orderIds（勾选导出）：用户勾了哪些就导哪些，travelFrom/travelTo 已被忽略，不再二次筛。
  const orders =
    query.scheduleId || (query.orderIds && query.orderIds.length > 0)
      ? fetched
      : filterExportOrdersByDepartDate(fetched, query.travelFrom, query.travelTo);

  const wb = new ExcelJS.Workbook();
  wb.creator = `Citur Travel · 订单导出（${ORDER_TEMPLATE_LABEL[query.template]}）`;
  wb.created = new Date();
  const ws = wb.addWorksheet(ORDER_TEMPLATE_LABEL[query.template]);

  // full 用两行表头（末列「订单成本」分组）；ticketing/visa 单行表头。
  if (query.template === 'full') {
    // 只设列 key/宽度，表头由 applyFullHeader 手工写两行（含合并）。
    ws.columns = FULL_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
    applyFullHeader(ws);
  } else if (query.template === 'ticketing') {
    // 《票务专用》对齐航司 PNR 原版样例的朴素样式（票务反馈「改成原版，表格看起来简洁一些」）：
    // 列名/列序/日期格式（DDMonYY）本就与样例一致，此处只去掉加粗/底色/居中换行等装饰 ——
    // 样例表头为默认字体、无填充、无居中换行，故这里不给表头设任何样式。
    ws.columns = TICKETING_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  } else {
    ws.columns = VISA_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  }

  let seq = 0;
  for (const order of orders) {
    if (order.passengers.length === 0) continue;
    const ctx = buildOrderContext(order);
    if (query.template === 'full') {
      for (const row of orderToFullRows(order, ctx)) {
        seq += 1;
        ws.addRow({ seq, ...row });
      }
    } else if (query.template === 'ticketing') {
      for (const row of orderToTicketingRows(order, ctx)) {
        ws.addRow(row);
      }
    } else {
      for (const row of orderToVisaRows(order, ctx)) {
        seq += 1;
        ws.addRow({ stt: seq, ...row });
      }
    }
  }

  // full 两行表头 → 冻结 2 行；其余单行表头 → 冻结 1 行。
  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: query.template === 'full' ? 2 : 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 文件名：`订单导出_{模板名}_{今天}.xlsx`，如 `订单导出_全岗可用_2026-06-10.xlsx` */
export function orderTemplateExportFilename(template: OrderExportTemplate): string {
  const today = fmtDate(new Date());
  return `订单导出_${ORDER_TEMPLATE_LABEL[template]}_${today}.xlsx`;
}
