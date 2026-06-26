/**
 * 三模板筛选导出 — 与订单列表共用筛选条件（buildOrderFilterWhere），一行/乘客。
 *
 *   full      《全岗可用》49 列 — 运营/财务/签证全岗位通用台账
 *   ticketing 《票务专用》27 列 — 代理+备注 + 航司 PNR 提交 25 列（仅含机票的订单）
 *   visa      《签证专用》20 列 — 越南签证申请表抬头（含越文表头）
 *
 * 注意：系统暂无数据的列（飞行次数/单房差/抵扣人员等）保留表头、内容留空，
 * 绝不编造数据 —— 这些列是线下手工台账的占位，等后续字段补齐再填。
 */
import ExcelJS from 'exceljs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { OrderItemKind, OrderStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { toAlpha3 } from './nationality.js';
import { passengerToRow, type PnrRow, PNR_COLUMNS } from './pnr-export.js';
import { buildOrderFilterWhere } from './orders.service.js';
import { parseRoomGroups } from './orders.export-room-allocation.js';
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

const INVOICE_STATUS_LABEL: Record<string, string> = {
  NONE: '未开',
  REQUESTED: '已要求',
  ISSUED: '已开',
};

const FULFILLMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '处理中',
  CONFIRMED: '已确认',
  CANCELLED: '已取消',
  FAILED: '失败',
};

// 订单状态中文（与 orders.export.ts STATUS_LABEL 同口径，含释放型状态全量）。
const ORDER_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  PAYMENT_TIMEOUT: '支付超时',
  FAILED: '失败',
  REFUND_REQUESTED: '退款中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期中',
  CHANGED: '已改期',
};

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

/** 乘客姓名 LASTNAME/FIRSTNAME（与 orders.export.ts 同款拆分）*/
export function pnrName(p: { lastName: string | null; firstName: string | null; fullName: string }): string {
  return p.lastName && p.firstName ? `${p.lastName}/${p.firstName}`.toUpperCase() : p.fullName;
}

// ── 取数 ────────────────────────────────────────────────────────────────
type OrderForTemplateExport = Prisma.OrderGetPayload<{
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
        visa: { select: { code: true; visaName: true; visaType: true } };
        transfer: { select: { code: true } };
        bundle: { select: { code: true } };
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
  travelDates: string; // 'YYYY-MM-DD / YYYY-MM-DD'（单段只有一个日期）
  flightNumbers: string; // ' ⇌ ' 连接
  route: string; // 航线 origin→dest，多段 ' / ' 连接（去重）
  flightLegCount: number;
  cabinLabels: string;
  orderType: string;
  settlePerPax: number; // 结算价格 = total ÷ pax
  paidPerPax: number; // 到账金额 = paidAmount ÷ pax
  balancePerPax: number; // 尾款 = max(0, total - paidAmount) ÷ pax
}

function buildOrderContext(order: OrderForTemplateExport): OrderContext {
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

  // 酒店类型 = 酒店名 + 房型名
  const hotelParts: string[] = [];
  for (const it of order.items) {
    if (it.kind === 'HOTEL' && it.hotelRoomType) {
      hotelParts.push(`${it.hotelRoomType.hotel.name} ${it.hotelRoomType.name}`);
    }
  }

  const total = dec(order.total);
  const paid = dec(order.paidAmount);

  return {
    paxCount,
    agency: order.agent?.companyName ?? '直客',
    notes: order.notes ?? '',
    hotelInfo: hotelParts.join(' + '),
    travelDates,
    flightNumbers,
    route,
    flightLegCount: legs.length,
    cabinLabels,
    orderType,
    settlePerPax: round2(total / paxCount),
    paidPerPax: round2(paid / paxCount),
    balancePerPax: round2(Math.max(0, total - paid) / paxCount),
  };
}

// ── 模板一：《全岗可用》49 列 ─────────────────────────────────────────────
interface FullRow {
  seq: number;
  productCodes: string;
  agency: string;
  notes: string;
  hotelInfo: string;
  chineseName: string;
  passengerName: string;
  flightCount: string; // 暂无数据 — 留空
  travelDates: string;
  flightNumbers: string;
  route: string;
  orderType: string;
  status: string; // 订单状态中文
  contactName: string;
  contactPhone: string;
  settlePrice: number;
  settleReceived: number;
  settleReceivedAt: string;
  settleChannel: string;
  balanceDue: number;
  singleRoomDiff: string; // 暂无数据 — 留空
  singleRoomDiffReceived: string; // 暂无数据 — 留空
  visaAmount: number;
  visaReceived: string; // 暂无数据 — 留空
  offsetAmount: number;
  offsetReceived: string; // 暂无数据 — 留空
  offsetPerson: string; // 暂无数据 — 留空
  offsetOrder: string; // 暂无数据 — 留空
  settled: string;
  refundAmount: number;
  refundAt: string;
  refundChannel: string; // 暂无数据 — 留空
  invoiceStatusSys: string;
  invoiceStatusManual: string; // 线下手工列 — 留空
  visaStatus: string;
  visaOption: string;
  visaNote: string; // 暂无数据 — 留空
  passportIssuePlace: string;
  placeOfBirth: string;
  orderNumber: string;
  cabin: string;
  dateOfBirth: string;
  passengerType: string;
  distribution: string;
  gender: string;
  nationality: string;
  documentType: string;
  documentNumber: string;
  issueDate: string; // 暂无护照签发日期字段 — 留空
  expiryDate: string;
  infantWith: string; // 暂无数据 — 留空
  recordedAt: string;
  recordedBy: string;
}

const FULL_COLUMNS: Array<{ header: string; key: keyof FullRow; width: number }> = [
  { header: '序号', key: 'seq', width: 6 },
  { header: '产品编号', key: 'productCodes', width: 14 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '备注', key: 'notes', width: 20 },
  { header: '酒店类型', key: 'hotelInfo', width: 24 },
  { header: '中文名称', key: 'chineseName', width: 12 },
  { header: '乘客姓名', key: 'passengerName', width: 18 },
  { header: '飞行次数', key: 'flightCount', width: 8 },
  { header: '出发(往返)日期', key: 'travelDates', width: 24 },
  { header: '航班号', key: 'flightNumbers', width: 18 },
  { header: '航线', key: 'route', width: 14 },
  { header: '订单类型', key: 'orderType', width: 10 },
  { header: '订单状态', key: 'status', width: 10 },
  { header: '联系人', key: 'contactName', width: 12 },
  { header: '联系电话', key: 'contactPhone', width: 14 },
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
  { header: '系统开票状态', key: 'invoiceStatusSys', width: 12 },
  { header: '开票状态', key: 'invoiceStatusManual', width: 10 },
  { header: '签证状态', key: 'visaStatus', width: 10 },
  { header: '签证选项', key: 'visaOption', width: 20 },
  { header: '签证备注', key: 'visaNote', width: 14 },
  { header: '护照签发国', key: 'passportIssuePlace', width: 10 },
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
  { header: '录入时间', key: 'recordedAt', width: 18 },
  { header: '录入人员', key: 'recordedBy', width: 14 },
];

function orderToFullRows(order: OrderForTemplateExport, ctx: OrderContext): Omit<FullRow, 'seq'>[] {
  // 产品编号：去重后的酒店/签证/接送/套餐编号
  const codes = Array.from(
    new Set(
      order.items
        .map((it) => it.hotelRoomType?.hotel.code ?? it.visa?.code ?? it.transfer?.code ?? it.bundle?.code)
        .filter((c): c is string => Boolean(c)),
    ),
  );

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

  // 签证：金额合计 / 选项（产品名）/ 履约状态
  const visaItems = order.items.filter((it) => it.kind === 'VISA');
  const visaAmountOrder = visaItems.reduce((s, it) => s + dec(it.amount), 0);
  const visaOption = visaItems
    .map((it) => it.visa?.visaName ?? it.visa?.visaType ?? it.description)
    .join(' + ');
  const visaTask = visaItems
    .flatMap((it) => it.fulfillmentTasks)
    .find((t) => t.type === 'VISA_APPLICATION');

  const settled = dec(order.paidAmount) >= dec(order.total) ? '是' : '否';

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
    productCodes: codes.join(' / '),
    agency: ctx.agency,
    notes,
    hotelInfo: ctx.hotelInfo,
    chineseName: p.chineseName ?? p.fullName,
    passengerName: pnrName(p),
    flightCount: '',
    travelDates: ctx.travelDates,
    flightNumbers: ctx.flightNumbers,
    route: ctx.route,
    orderType: ctx.orderType,
    status: ORDER_STATUS_LABEL[order.status] ?? order.status,
    contactName: order.contactName,
    contactPhone: order.contactPhone,
    settlePrice: ctx.settlePerPax,
    settleReceived: ctx.paidPerPax,
    settleReceivedAt: lastPayment ? fmtDateTime(lastPayment.paidAt) : '',
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
    refundAt: fmtDateTime(lastRefundAt),
    refundChannel: '',
    invoiceStatusSys: INVOICE_STATUS_LABEL[order.invoiceStatus] ?? order.invoiceStatus,
    invoiceStatusManual: '',
    visaStatus: visaTask ? FULFILLMENT_STATUS_LABEL[visaTask.status] ?? visaTask.status : '',
    visaOption,
    visaNote: '',
    passportIssuePlace: p.passportIssueCountry ?? '',
    placeOfBirth: p.placeOfBirth ?? '',
    orderNumber: order.orderNumber,
    cabin: ctx.cabinLabels,
    dateOfBirth: fmtDate(p.dateOfBirth),
    passengerType: PASSENGER_TYPE_LABEL[p.passengerType] ?? p.passengerType,
    distribution: order.agent ? '代理' : '直客',
    gender: p.gender ? GENDER_LABEL[p.gender] ?? p.gender : '',
    nationality: toAlpha3(p.nationality),
    documentType: DOCUMENT_TYPE_LABEL[p.documentType] ?? p.documentType,
    documentNumber: p.documentNumber,
    issueDate: fmtDate(p.passportIssueDate),
    expiryDate: fmtDate(p.passportExpiry),
    infantWith: '',
    recordedAt: fmtDateTime(order.createdAt),
    // 游客单 user=null：回退到游客联系人姓名
    recordedBy: order.user?.displayName ?? order.user?.email ?? order.guestName ?? '',
    };
  });
}

// ── 模板二：《票务专用》27 列 = 代理 + 备注 + 航司 PNR 25 列 ───────────────
type TicketingRow = { agency: string; notes: string } & PnrRow;

const TICKETING_COLUMNS: Array<{ header: string; key: keyof TicketingRow; width: number }> = [
  { header: '代理', key: 'agency', width: 16 },
  { header: '备注', key: 'notes', width: 20 },
  ...PNR_COLUMNS.map((c) => ({ header: c.header, key: c.key as keyof TicketingRow, width: 18 })),
];

function orderToTicketingRows(order: OrderForTemplateExport, ctx: OrderContext): TicketingRow[] {
  return order.passengers.map<TicketingRow>((p) => ({
    agency: ctx.agency,
    notes: ctx.notes,
    ...passengerToRow(p),
  }));
}

// ── 模板三：《签证专用》20 列（含越文表头）───────────────────────────────
interface VisaRow {
  stt: number;
  agency: string;
  notes: string;
  hotelInfo: string;
  visaNote: string; // 暂无数据 — 留空
  settlePrice: number;
  paidAmount: number;
  balanceDue: number;
  chineseName: string;
  name: string;
  dateOfBirth: string;
  gender: string;
  nationalityNow: string;
  nationalityOrigin: string;
  occupation: string; // 暂无数据 — 留空
  workplace: string; // 暂无数据 — 留空
  passportNumber: string;
  issueDate: string; // 暂无数据 — 留空
  expiryDate: string;
  departDate: string;
}

const VISA_COLUMNS: Array<{ header: string; key: keyof VisaRow; width: number }> = [
  { header: 'STT', key: 'stt', width: 6 },
  { header: '代理机构', key: 'agency', width: 16 },
  { header: '备注信息', key: 'notes', width: 20 },
  { header: '酒店类型', key: 'hotelInfo', width: 24 },
  { header: '签证备注', key: 'visaNote', width: 14 },
  { header: '结算价格', key: 'settlePrice', width: 10 },
  { header: '到账金额', key: 'paidAmount', width: 10 },
  { header: '尾款金额', key: 'balanceDue', width: 10 },
  { header: '中文姓名', key: 'chineseName', width: 12 },
  { header: 'Họ và tên (*)\n姓名', key: 'name', width: 20 },
  { header: 'Ngày, tháng, năm sinh (*)\n出生日期', key: 'dateOfBirth', width: 16 },
  { header: 'Giới tính (*)', key: 'gender', width: 8 },
  { header: 'Quốc tịch hiện nay (*)', key: 'nationalityNow', width: 12 },
  { header: 'Quốc tịch gốc', key: 'nationalityOrigin', width: 12 },
  { header: 'Nghề nghiệp (*)\n职业', key: 'occupation', width: 12 },
  { header: 'Nơi làm việc\n工作地址', key: 'workplace', width: 16 },
  { header: 'Số hộ chiếu (*)\n护照号', key: 'passportNumber', width: 16 },
  { header: '签发日期', key: 'issueDate', width: 12 },
  { header: '有效日期', key: 'expiryDate', width: 12 },
  { header: '出发日期', key: 'departDate', width: 24 },
];

function orderToVisaRows(order: OrderForTemplateExport, ctx: OrderContext): Omit<VisaRow, 'stt'>[] {
  return order.passengers.map<Omit<VisaRow, 'stt'>>((p) => ({
    agency: ctx.agency,
    notes: ctx.notes,
    hotelInfo: ctx.hotelInfo,
    visaNote: '',
    settlePrice: ctx.settlePerPax,
    paidAmount: ctx.paidPerPax,
    balanceDue: ctx.balancePerPax,
    chineseName: p.fullName,
    name: pnrName(p),
    dateOfBirth: fmtDateDMYSlash(p.dateOfBirth),
    gender: p.gender ?? '',
    nationalityNow: toAlpha3(p.nationality),
    nationalityOrigin: toAlpha3(p.nationality),
    occupation: '',
    workplace: '',
    passportNumber: p.documentNumber,
    issueDate: '',
    expiryDate: fmtDateDMYDash(p.passportExpiry),
    departDate: ctx.travelDates,
  }));
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

  const orders = (await client.order.findMany({
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
            include: { flight: { select: { flightNumber: true } } },
          },
          hotelRoomType: { select: { name: true, hotel: { select: { name: true, code: true } } } },
          visa: { select: { code: true, visaName: true, visaType: true } },
          transfer: { select: { code: true } },
          bundle: { select: { code: true } },
          fulfillmentTasks: { select: { type: true, status: true } },
        },
      },
    },
  })) as OrderForTemplateExport[];

  const wb = new ExcelJS.Workbook();
  wb.creator = `Citur Travel · 订单导出（${ORDER_TEMPLATE_LABEL[query.template]}）`;
  wb.created = new Date();
  const ws = wb.addWorksheet(ORDER_TEMPLATE_LABEL[query.template]);

  if (query.template === 'full') {
    ws.columns = FULL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  } else if (query.template === 'ticketing') {
    ws.columns = TICKETING_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  } else {
    ws.columns = VISA_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  }

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

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

  ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 文件名：`订单导出_{模板名}_{今天}.xlsx`，如 `订单导出_全岗可用_2026-06-10.xlsx` */
export function orderTemplateExportFilename(template: OrderExportTemplate): string {
  const today = fmtDate(new Date());
  return `订单导出_${ORDER_TEMPLATE_LABEL[template]}_${today}.xlsx`;
}
