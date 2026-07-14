/**
 * 班次开票上限 — 航司运营限制：同一包机班次上「按航段」的已开票乘客数
 * 不得超过 FlightSchedule.ticketingCap（默认 191 张）。
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
import { OrderItemKind, OrderStatus } from '@prisma/client';
import type { Prisma, PrismaClient } from '@prisma/client';
import { UnprocessableEntityError } from '../../lib/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 计入开票占额的订单状态：排除取消族（DRAFT/CANCELLED/PAYMENT_TIMEOUT/REFUNDED/FAILED）。
 * 与订单导出 / 房控销控板 / alerts 超上限提醒同口径（各模块各自本地维护一份，见
 * hotel-control.service.ts、finances.service.ts 等同名常量）。
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

/**
 * 某班次当前「按航段」已开票的乘客总数。
 * 逐订单判定该班次是本单的去程还是回程，再取对应布尔位（outboundInvoiced / returnInvoiced）；
 * 订单需软删未删且状态在 COUNTED_STATUSES 内——取消族订单不再占用开票额度。
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
      _count: { select: { passengers: true } },
      items: {
        where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        select: {
          flightScheduleId: true,
          flightSchedule: { select: { departureTime: true } },
        },
      },
    },
  });

  let total = 0;
  for (const o of orders) {
    const { outboundScheduleId, returnScheduleId } = determineFlightLegs(o.items);
    const invoiced =
      (scheduleId === outboundScheduleId && o.outboundInvoiced) ||
      (scheduleId === returnScheduleId && o.returnInvoiced);
    if (invoiced) total += o._count.passengers;
  }
  return total;
}

/**
 * 校验：把 passengerCount 位乘客在给定班次上翻成已开票后，涉及的每个班次是否仍在上限内。
 * 任一班次超限 → 抛 UnprocessableEntityError（HTTP 422）。
 * 调用方按「正在翻开的航段」传入对应班次 id（去程班次或回程班次）。
 */
export async function assertTicketingCap(
  db: Db,
  scheduleIds: string[],
  passengerCount: number,
): Promise<void> {
  for (const scheduleId of new Set(scheduleIds)) {
    const schedule = await db.flightSchedule.findUnique({
      where: { id: scheduleId },
      select: { ticketingCap: true },
    });
    // 班次已被删除（关联被 SetNull 前的窗口）→ 无上限可校验，跳过
    if (!schedule) continue;
    const issued = await countIssuedPassengers(db, scheduleId);
    if (issued + passengerCount > schedule.ticketingCap) {
      throw new UnprocessableEntityError(
        `该班次已开票 ${issued} 张，最多 ${schedule.ticketingCap} 张，无法继续开票`,
        { scheduleId, issued, ticketingCap: schedule.ticketingCap, requested: passengerCount },
      );
    }
  }
}
