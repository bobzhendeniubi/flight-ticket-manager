/**
 * 行程单邮件 — 订单所有 FLIGHT 都出票后汇总发一封
 *
 * 放在 lib/ 而非 queues/worker.ts，是因为 worker.ts 有顶层 `new Worker(...)` 会在 import 时
 * 启动真 BullMQ worker；API 主进程调用这里不应该拉起 worker 实例。
 *
 * 幂等策略：检查订单下每个 FLIGHT item 的 fulfillmentTask 都 CONFIRMED 才发；
 * 否则等下一个 FLIGHT task 完成时再触发。
 */
import { FulfillmentStatus, FulfillmentType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { renderItineraryPdf } from './itinerary-pdf.js';
import { localDateTime } from './flight-time.js';
import { sendMail } from './mailer.js';

/**
 * 返回语义化结果，让调用方（worker 自动触发 / admin 手动 resend）可以上报给 UI / 审计。
 *   sent          : 真发了邮件
 *   no_email      : 订单没填联系邮箱
 *   not_all_ticketed : 多段航班订单里还有没出完的票（等下次 ticketing 完再自动发）
 *   smtp_disabled : SMTP 未配置 —— **生产若意外漏配会静默丢邮件，调用方应告警**
 *   no_flights    : 订单没有 FLIGHT item（地面产品订单无需行程单）
 */
export type ItineraryResult =
  | { status: 'sent'; sentTo: string; messageId?: string }
  | { status: 'no_email' }
  | { status: 'not_all_ticketed'; ticketedCount: number; totalCount: number }
  | { status: 'smtp_disabled'; wouldSendTo: string }
  | { status: 'no_flights' };

export async function sendItineraryEmail(orderId: string): Promise<ItineraryResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          flightSchedule: { include: { flight: true } },
          fulfillmentTasks: true,
        },
      },
      passengers: true,
    },
  });
  if (!order) return { status: 'no_email' }; // 订单不存在当作没邮箱处理（不该发生）
  if (!order.contactEmail) {
    // eslint-disable-next-line no-console
    console.log(`[mailer] order ${order.orderNumber} has no contact email — skip itinerary`);
    return { status: 'no_email' };
  }

  // 仅当所有 FLIGHT item 的 ticketing task 都 CONFIRMED 才发
  const flightItems = order.items.filter((i) => i.kind === 'FLIGHT');
  if (flightItems.length === 0) return { status: 'no_flights' };
  const ticketedCount = flightItems.filter((i) =>
    i.fulfillmentTasks.some(
      (t) =>
        t.type === FulfillmentType.FLIGHT_TICKETING && t.status === FulfillmentStatus.CONFIRMED,
    ),
  ).length;
  if (ticketedCount < flightItems.length) {
    return {
      status: 'not_all_ticketed',
      ticketedCount,
      totalCount: flightItems.length,
    };
  }

  // 组装 PDF 数据
  const flights = flightItems
    .filter((i) => i.flightSchedule)
    .map((i) => ({
      flightNumber: i.flightSchedule!.flight.flightNumber,
      origin: i.flightSchedule!.flight.originCode,
      destination: i.flightSchedule!.flight.destinationCode,
      departureTime: i.flightSchedule!.departureTime,
      arrivalTime: i.flightSchedule!.arrivalTime,
      departureTz: i.flightSchedule!.departureTz,
      arrivalTz: i.flightSchedule!.arrivalTz,
      cabin: i.flightCabin ?? 'ECONOMY',
    }));

  const pdf = await renderItineraryPdf({
    orderNumber: order.orderNumber,
    contactName: order.contactName,
    contactPhone: order.contactPhone,
    contactEmail: order.contactEmail,
    total: order.total.toFixed(2),
    // 应付含售后调整（改期费/换人费）——与下载版行程单同口径
    adjustmentCny: Number(order.adjustmentCny ?? 0),
    currency: order.currency,
    createdAt: order.createdAt,
    flights,
    passengers: order.passengers.map((p) => ({
      fullName: p.fullName,
      passportNumber: p.documentNumber,
      pnr: p.pnr,
      eticketNumber: p.eticketNumber,
    })),
  });

  const mailResult = await sendMail({
    to: order.contactEmail,
    // 前台品牌：椰岛假期 / Coco Holiday（客户可见邮件不露出法律主体）
    subject: `【椰岛假期】您的电子行程单 · ${order.orderNumber}`,
    text: `您好 ${order.contactName}，\n\n附件是您订单 ${order.orderNumber} 的电子行程单。请凭 PNR + 护照原件在机场柜台办理登机手续。\n\n如有疑问请联系椰岛假期客服。\n\n—— 椰岛假期 Coco Holiday`,
    html: `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <h2 style="color:#1e40af">您的电子行程单</h2>
        <p>您好 ${order.contactName}，</p>
        <p>您订单 <strong>${order.orderNumber}</strong> 已出票成功。请下载附件 PDF，凭 PNR + 护照原件在机场柜台办理登机手续。</p>
        <table style="border-collapse:collapse;margin-top:12px">
          ${flights.map((f) => `
            <tr>
              <td style="padding:6px 12px;border:1px solid #e2e8f0">${f.flightNumber}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0">${f.origin} → ${f.destination}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0">${localDateTime(f.departureTime, f.departureTz)}</td>
            </tr>
          `).join('')}
        </table>
        <p style="margin-top:8px;color:#94a3b8;font-size:12px">以上时刻均为当地时间。</p>
        <p style="margin-top:20px;color:#64748b;font-size:13px">
          如有疑问请联系椰岛假期客服。
        </p>
      </div>
    `,
    attachments: [{
      filename: `itinerary-${order.orderNumber}.pdf`,
      content: pdf,
      contentType: 'application/pdf',
    }],
  });

  if (mailResult.skipped) {
    return { status: 'smtp_disabled', wouldSendTo: order.contactEmail };
  }
  return {
    status: 'sent',
    sentTo: order.contactEmail,
    messageId: mailResult.messageId,
  };
}
