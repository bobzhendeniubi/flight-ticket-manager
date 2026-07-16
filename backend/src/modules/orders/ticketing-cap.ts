/**
 * 班次开票上限 — 上限即库存：同一包机班次上「按航段」的已开票座位数
 * 不得超过该班次的真实座位库存 = Σ FlightSeatClass.capacity（各舱位容量之和）。
 *
 * 为什么是「派生」而不是一个可配置的数字：
 *   卖票一直按 FlightSeatClass 扣（每舱一条，sold/capacity 是权威），开票却曾另有一个
 *   FlightSchedule.ticketingCap = 191 的常量把关——两本账，从不对账，191 也无任何出处。
 *   现口径：**每个班次配置能卖多少张（多少商务舱 + 多少经济舱）即 inventory，开票上限就是它**。
 *   上限随舱位容量自动走，库存配置入口就是上限配置入口，不存在第二处要维护的数字。
 *
 * 计数口径 = 「占几个座」，而非「有几个人」：
 *   - **婴儿有票无座 → 不占库存 → 不计**（PassengerType.INFANT）。
 *   - **同一人（证件号）在同一班次的多张单上只占 1 个座 → 按 documentNumber 去重**。
 *     证件号为空/纯空白的乘客不塌成一个——按乘客 id 兜底，各自独立计数。
 *
 * 六态开票口径（不再按订单级 invoiceStatus=ISSUED 计）：
 *   某班次的已开票乘客数 = Σ(该班次作为订单去程 ? outboundInvoiced : returnInvoiced) 为真的
 *   **且订单状态在 COUNTED_STATUSES 内**的订单乘客数。
 *   即每个班次只被「它自己那段」的开票占额——去程班次看 outboundInvoiced，回程班次看 returnInvoiced；
 *   订单一旦落入取消族（CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED/DRAFT）即释放它占的开票额度，
 *   不再永久占用班次上限。与房控 alerts 的超上限提醒（hotel-control.service.ts getAlerts）同口径。
 *
 *   口径假设（供后续 review）：这里把 outboundInvoiced/returnInvoiced 当作「内部开票进度位」而非
 *   「航司侧已实际出票的不可撤销记录」——证据是 systemInvoiced 本身就不占开票额度。若之后业务口径
 *   变为「票已实际出给航司，订单即使取消额度也继续占」，则应改回不过滤订单状态，并在此处更新注释。
 *
 * 被两处复用：
 * - OrderService.setInvoiceFlags：把某航段翻成已开票前校验对应班次上限，超限抛 422
 * - orders.export.ts（整班机导出）：表头显示「已开票 N / 上限 M 张」
 */
import { OrderItemKind, OrderStatus, PassengerType } from '@prisma/client';
import type { Prisma, PrismaClient } from '@prisma/client';
import { BadRequestError, UnprocessableEntityError } from '../../lib/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 计入开票占额的订单状态：排除取消族（DRAFT/CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED）。
 * 与订单导出 / 房控销控板 / alerts 超上限提醒同口径（各模块各自本地维护一份，见
 * hotel-control.service.ts、finances.service.ts 等同名常量）。
 *
 * **本常量同时是「能否标开票」的闸**（见 assertOrderAllowsInvoicing）：
 * 「能标开票」⟺「占额度」——算额度与写标记复用这同一份状态集合，物理上不可能再分叉。
 * 改这里等于同时改两处口径，务必一起想清楚。
 */
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

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待付款',
  PAID: '已付款',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
  REFUND_REQUESTED: '退款申请中',
  CHANGE_REQUESTED: '改签申请中',
  CHANGED: '已改签',
  FAILED: '出票失败',
};

/** assertOrderAllowsInvoicing 入参：只需订单号（报错文案）、状态、软删标记。 */
export interface InvoicingGuardOrder {
  orderNumber: string;
  status: OrderStatus;
  deletedAt: Date | null;
}

/**
 * 开票标记闸：订单是否允许把某个开票位翻成「已开」。
 *
 * 背景（系统审计）：算开票额度（countIssuedPassengers）明确排除取消族，写开票标记
 *（OrderService.setInvoiceFlags）却完全不看状态——同一个「取消族」，算额度排除、写标记不排除。
 * 结果：已取消/已退款/回收站里的单照样能标「去程已开」，标记进了库、上了导出、财务看得见，
 * 但对班次开票上限完全隐形（额度不认它）。批量入口逐单复用，一次 100 单放大。
 *
 * 口径：**挡 COUNTED_STATUSES 的补集** —— 「能标开票」⟺「占额度」，两处共用一个常量。
 * 只在「翻成已开」（false → true）时调用；翻回「未开」不挡——死单纠错撤销错标记应当允许，
 * 与资金入口闸「只挡进钱、不挡退钱」（funds-guard.ts）同构。
 * 软删单（deletedAt != null）一并挡：回收站里的单不进任何列表/导出/统计，标了没人看得见。
 */
export function assertOrderAllowsInvoicing(order: InvoicingGuardOrder): void {
  if (order.deletedAt) {
    throw new BadRequestError(
      `订单 ${order.orderNumber} 已在回收站，不能标记开票。请先恢复订单再操作。`,
    );
  }
  if (!COUNTED_STATUSES.includes(order.status)) {
    throw new BadRequestError(
      `订单 ${order.orderNumber} 当前状态为「${STATUS_LABEL[order.status]}」，不能标记开票。` +
        `该状态的订单不占班次开票额度，标了开票位也不会计入班次上限，且会让导出与财务口径失真。` +
        `如确需开票，请先将订单恢复到有效状态（如已付款/处理中）。`,
    );
  }
}

/** determineFlightLegs 入参：只需班次 id 与出发时刻。 */
export interface FlightLegItem {
  flightScheduleId: string | null;
  flightSchedule?: { departureTime: Date | string } | null;
}

/**
 * 订单去程/回程判定：FLIGHT 行按班次 departureTime 升序，第 1 段=去程、第 2 段=回程。
 * 单程只有去程（returnScheduleId=null）；>2 段的罕见情形只认前两段
 *（其余段不参与开票占额——六态模型只表达去程/回程两维）。
 * 缺 departureTime 或 flightScheduleId 的行跳过（排序需要可比较的时刻）。
 */
export function determineFlightLegs(items: ReadonlyArray<FlightLegItem>): {
  outboundScheduleId: string | null;
  returnScheduleId: string | null;
} {
  const legs = items
    .filter(
      (i): i is FlightLegItem & { flightScheduleId: string } =>
        i.flightScheduleId !== null &&
        i.flightSchedule != null &&
        i.flightSchedule.departureTime != null,
    )
    .map((i) => ({
      scheduleId: i.flightScheduleId,
      depart: new Date(i.flightSchedule!.departureTime).getTime(),
    }))
    .sort((a, b) => a.depart - b.depart);
  return {
    outboundScheduleId: legs[0]?.scheduleId ?? null,
    returnScheduleId: legs[1]?.scheduleId ?? null,
  };
}

/** 座位去重键入参：只需乘客 id / 证件号 / 乘客类型。 */
export interface SeatCountPassenger {
  id: string;
  documentNumber: string | null;
  passengerType: PassengerType;
}

/**
 * 乘客的「座位去重键」——同键即同一个座，跨订单只算一次。
 *
 * 证件号规范化：去首尾空白 + 转大写（同一本护照在两张单上大小写/空格不一致是常见脏数据，
 * 不规范化就去不掉重）。**空 / 纯空白证件号不参与去重**——回落 `id:` 前缀的乘客 id，
 * 保证 N 个没填证件号的人仍是 N 个座，而不是被塌成 1 个（那会把上限算松，放出超卖）。
 */
function seatKey(p: SeatCountPassenger): string {
  const doc = (p.documentNumber ?? '').trim().toUpperCase();
  return doc === '' ? `id:${p.id}` : `doc:${doc}`;
}

/**
 * 某班次当前「按航段」已开票占用的**座位数**（非人头数）。
 *
 * 逐订单判定该班次是本单的去程还是回程，再取对应布尔位（outboundInvoiced / returnInvoiced）；
 * 订单需软删未删且状态在 COUNTED_STATUSES 内——取消族订单不再占用开票额度。
 * 命中的订单里，**婴儿不计**（有票无座），其余乘客按 seatKey 去重后取基数——
 * 同一人（同证件号）在本班次的多张已开票单上只占 1 个座。
 */
export async function countIssuedPassengers(db: Db, scheduleId: string): Promise<number> {
  const orders = await db.order.findMany({
    where: {
      deletedAt: null, // 排除已软删订单
      status: { in: COUNTED_STATUSES }, // 排除取消族：取消/退款/超时/失败/草稿不占开票额度
      items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: scheduleId } },
    },
    select: {
      outboundInvoiced: true,
      returnInvoiced: true,
      passengers: { select: { id: true, documentNumber: true, passengerType: true } },
      items: {
        where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        select: {
          flightScheduleId: true,
          flightSchedule: { select: { departureTime: true } },
        },
      },
    },
  });

  // 跨订单累积：一个 key = 一个座。Set 天然做掉「一人两单」的重复占额。
  const seats = new Set<string>();
  for (const o of orders) {
    const { outboundScheduleId, returnScheduleId } = determineFlightLegs(o.items);
    const invoiced =
      (scheduleId === outboundScheduleId && o.outboundInvoiced) ||
      (scheduleId === returnScheduleId && o.returnInvoiced);
    if (!invoiced) continue;
    for (const p of o.passengers) {
      if (p.passengerType === PassengerType.INFANT) continue; // 婴儿有票无座，不占库存
      seats.add(seatKey(p));
    }
  }
  return seats.size;
}

/**
 * 某班次的真实座位库存 = Σ 各舱位 capacity（商务 + 经济 + …）。
 *
 * 返回 null = **无上限可校验**，调用方跳过。两种情形：
 *   1. 班次已被删除（关联 SetNull 前的窗口）；
 *   2. 班次一个舱位都没配 —— 这种班次本来就卖不出任何座（扣座必须落到某条 FlightSeatClass），
 *      属配置未完成的退化态。此时返回 0 会把上限算成 0 从而卡死全部开票，宁可跳过不卡。
 */
export async function getScheduleSeatCapacity(db: Db, scheduleId: string): Promise<number | null> {
  const seatClasses = await db.flightSeatClass.findMany({
    where: { scheduleId },
    select: { capacity: true },
  });
  if (seatClasses.length === 0) return null;
  return seatClasses.reduce((sum, c) => sum + c.capacity, 0);
}

/**
 * 校验：把 passengerCount 位乘客在给定班次上翻成已开票后，涉及的每个班次是否仍在座位库存内。
 * 任一班次超限 → 抛 UnprocessableEntityError（HTTP 422）。
 * 调用方按「正在翻开的航段」传入对应班次 id（去程班次或回程班次）。
 *
 * 上限 = Σ 舱位 capacity（见 getScheduleSeatCapacity）。班次不存在 / 未配舱位 → 跳过。
 */
export async function assertTicketingCap(
  db: Db,
  scheduleIds: string[],
  passengerCount: number,
): Promise<void> {
  for (const scheduleId of new Set(scheduleIds)) {
    const seatCapacity = await getScheduleSeatCapacity(db, scheduleId);
    if (seatCapacity === null) continue; // 班次已删 / 未配舱位 → 无上限可校验
    const issued = await countIssuedPassengers(db, scheduleId);
    if (issued + passengerCount > seatCapacity) {
      throw new UnprocessableEntityError(
        `该班次已开票 ${issued} 张，座位库存共 ${seatCapacity} 张（各舱位容量之和），无法继续开票。` +
          `如需放宽，请先调整该班次的舱位容量。`,
        { scheduleId, issued, seatCapacity, requested: passengerCount },
      );
    }
  }
}
