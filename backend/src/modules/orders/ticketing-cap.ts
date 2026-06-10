/**
 * 班次开票上限 — 航司运营限制：同一包机班次上 invoiceStatus=ISSUED 的乘客数
 * 不得超过 FlightSchedule.ticketingCap（默认 191 张）。
 *
 * 被两处复用：
 * - OrderService.setInvoiceStatus：转 ISSUED 前校验，超限抛 422
 * - orders.export.ts（整班机导出）：表头显示「已开票 N / 上限 M 张」
 */
import { InvoiceStatus, OrderItemKind } from '@prisma/client';
import type { Prisma, PrismaClient } from '@prisma/client';
import { UnprocessableEntityError } from '../../lib/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** 某班次当前已开票（ISSUED）订单上的乘客总数。 */
export async function countIssuedPassengers(db: Db, scheduleId: string): Promise<number> {
  return db.passenger.count({
    where: {
      order: {
        invoiceStatus: InvoiceStatus.ISSUED,
        items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: scheduleId } },
      },
    },
  });
}

/**
 * 校验：把 passengerCount 位乘客转为已开票后，涉及的每个班次是否仍在上限内。
 * 任一班次超限 → 抛 UnprocessableEntityError（HTTP 422）。
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
