/**
 * 电子行程单 PDF 生成器 — pdfkit
 *
 * 输入：订单 + 乘客 + PNR 数据
 * 输出：Buffer，供邮件附件 / HTTP 下载用
 *
 * 字体：pdfkit 默认字体不支持 CJK —— 生产需要嵌入中文 TTF（e.g. Noto Sans CJK）。
 * 当前实现用 ASCII 降级 + 原始中文字段（PDF 查看器装了中文字体就能显示，否则 □□）。
 * TODO: 接入 /fonts/NotoSansSC-Regular.otf 真正解决中文显示。
 *
 * 两档版式（客户可见文档，绝不能把未出票的单印成电子客票——PAID/PROCESSING 阶段 PNR/票号
 * 可能全空，此时若还打「Electronic Itinerary & E-Ticket」+ 教客户凭 PNR 去机场柜台，等于
 * 教客户拿一张不存在的票去登机）：
 *   - ticketed     ：本单乘客全员已有 e-ticket 号 → 保留电子客票版式（含登机指引）。
 *   - confirmation ：只要有一位乘客尚无 e-ticket 号 → 降级为「行程确认单」，去掉登机指引，
 *                    PNR / 票号列一律显示「出票后更新」（不印真实值，避免出票前的临时 PNR
 *                    被当成正式凭证）。
 * 判定只看 passengers[].eticketNumber，不看 order.status —— 状态口径可能滞后于真实出票
 * 进度，票号字段才是唯一真值。
 */
import PDFDocument from 'pdfkit';
import { businessDateTimeSec } from './business-time.js';
import { localDateTime } from './flight-time.js';

export interface ItineraryData {
  orderNumber: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  total: string;
  currency: string;
  /**
   * 售后费用（改期费/换人费等，CNY 整数）。应付 = total + adjustmentCny，与订单详情
   * 「应收」同口径（见 orders.service.ts / payments.service.ts 的 effectivePayable）。
   * 可选：未传时按 0 处理，兼容尚未补充此字段的旧调用点。
   */
  adjustmentCny?: number;
  createdAt: Date;
  flights: Array<{
    flightNumber: string;
    origin: string;
    destination: string;
    departureTime: Date;
    arrivalTime: Date;
    // 起降两地各自的 IANA 时区——时刻按航司口径印当地时间，跨时区航段两头不同
    departureTz: string;
    arrivalTz: string;
    cabin: string;
  }>;
  passengers: Array<{
    fullName: string;
    passportNumber: string;
    pnr: string | null;
    eticketNumber: string | null;
  }>;
}

export type ItineraryTier = 'ticketed' | 'confirmation';

/**
 * 判定本单应打哪一档版式：要求「全体乘客」都已有 e-ticket 号才算已出票；
 * 只要有一人缺票号（含尚无乘客的边界情形），一律降级为确认单档，避免半出票的单
 * 被印成看起来完整的电子客票。
 */
export function determineItineraryTier(passengers: ItineraryData['passengers']): ItineraryTier {
  const fullyTicketed = passengers.length > 0 && passengers.every((p) => !!p.eticketNumber);
  return fullyTicketed ? 'ticketed' : 'confirmation';
}

/** 标题文案（中英双语，跟随现有页面「English / 中文」的排版顺序）。 */
export function getItineraryTitle(tier: ItineraryTier): string {
  return tier === 'ticketed'
    ? 'Electronic Itinerary & E-Ticket'
    : 'Itinerary Confirmation / 行程确认单';
}

/** 确认单档的 PNR / 票号占位文案——不印真实值，避免出票前的临时数据被当正式凭证。 */
const PENDING_TICKET_TEXT = 'Pending / 出票后更新';

/** 表格里 PNR / 票号单元格的显示值：确认单档一律占位，已出票档才印真实值（缺失时用 —）。 */
export function ticketCellText(value: string | null, tier: ItineraryTier): string {
  if (tier === 'confirmation') return PENDING_TICKET_TEXT;
  return value ?? '—';
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 应付金额 = total + adjustmentCny（改期费/换人费等售后调整），与订单详情「应收」/
 * effectivePayable 同口径——不能只印裸 total，否则改期费/换人费会在客户凭证上凭空消失。
 */
export function computeEffectivePayable(total: string, adjustmentCny = 0): string {
  return round2(Number(total) + adjustmentCny).toFixed(2);
}

/**
 * 异步生成 PDF buffer。
 * 渲染 3 段：
 *   1. 标题 + 订单号 + （已出票档）生成时间
 *   2. 航段（每个 flight 一块）
 *   3. 乘客表格（姓名 / 护照号 / PNR / e-ticket）
 */
export async function renderItineraryPdf(data: ItineraryData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const tier = determineItineraryTier(data.passengers);
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── 标题 ────────────────────────────────────────
      // 前台品牌：椰岛假期 / Coco Holiday（世途/Citur 仅法律主体，客户可见文档绝不露出）
      doc.fontSize(20).text('Coco Holiday / 椰岛假期', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(14).fillColor('#475569').text(getItineraryTitle(tier), { align: 'center' });
      doc.moveDown(1);

      // ── 订单信息 ────────────────────────────────────
      doc.fontSize(10).fillColor('#000');
      doc.text(`Order Number / 订单号:  ${data.orderNumber}`);
      // 「开票时间」只在已出票档显示，且印的是 PDF 生成时间而非真实出票时间（系统目前没有
      // 独立的 invoicedAt 字段）——如实标注为「生成时间」，不冒充开票时间。
      if (tier === 'ticketed') {
        const generatedAt = businessDateTimeSec(new Date());
        doc.text(`Generated At / 生成时间:  ${generatedAt}（北京时间，文档生成时间，非出票时间）`);
      }
      doc.text(`Contact / 联系人:  ${data.contactName}  ·  ${data.contactPhone}${data.contactEmail ? '  ·  ' + data.contactEmail : ''}`);
      doc.text(`Total / 应付:  ${data.currency} ${computeEffectivePayable(data.total, data.adjustmentCny ?? 0)}`);
      doc.moveDown(0.8);

      // ── 航段 ────────────────────────────────────────
      doc.fontSize(13).fillColor('#1e40af').text('Flight Segments / 航段');
      doc.moveTo(50, doc.y + 3).lineTo(545, doc.y + 3).stroke();
      doc.moveDown(0.5);

      for (const f of data.flights) {
        doc.fontSize(12).fillColor('#000').text(
          `${f.flightNumber}   ${f.origin}  →  ${f.destination}   [${f.cabin}]`,
        );
        // 航司口径：行程单上的时刻一律印**机场当地时间**（不是 UTC）。
        const dep = localDateTime(f.departureTime, f.departureTz);
        const arr = localDateTime(f.arrivalTime, f.arrivalTz);
        doc.fontSize(10).fillColor('#475569').text(
          `   Dep: ${dep}   →   Arr: ${arr}`,
        );
        doc.moveDown(0.4);
      }
      doc.fontSize(8).fillColor('#94a3b8').text(
        'All times are local to the respective airport. / 以上时刻均为当地时间。',
      );
      doc.moveDown(0.5);

      // ── 乘客表 ───────────────────────────────────────
      doc.fontSize(13).fillColor('#1e40af').text('Passengers / 乘客');
      doc.moveTo(50, doc.y + 3).lineTo(545, doc.y + 3).stroke();
      doc.moveDown(0.5);

      // 表头
      const colX = { name: 50, passport: 190, pnr: 340, eticket: 420 };
      doc.fontSize(10).fillColor('#64748b');
      doc.text('Name', colX.name, doc.y, { continued: true })
         .text('Passport', colX.passport - colX.name, undefined, { continued: true })
         .text('PNR', colX.pnr - colX.passport, undefined, { continued: true })
         .text('E-Ticket', colX.eticket - colX.pnr);
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cbd5e1').stroke();
      doc.moveDown(0.2);

      for (const p of data.passengers) {
        doc.fontSize(10).fillColor('#000');
        doc.text(p.fullName, colX.name, doc.y, { width: 135, continued: true })
           .text(p.passportNumber, undefined, undefined, { width: 145, continued: true })
           .text(ticketCellText(p.pnr, tier), undefined, undefined, { width: 75, continued: true })
           .text(ticketCellText(p.eticketNumber, tier));
        doc.moveDown(0.3);
      }
      doc.moveDown(1);

      // ── 脚注 ────────────────────────────────────────
      doc.fontSize(8).fillColor('#94a3b8');
      if (tier === 'ticketed') {
        doc.text(
          'This is a computer-generated document. 本行程单为电子凭证，请凭 PNR + 护照原件在机场柜台办理登机。',
          { align: 'center' },
        );
      } else {
        // 未出票档：不能教客户拿这份单去登机——票号还没出，机场柜台核不到。
        doc.text(
          'This is a computer-generated confirmation, not a valid travel document. ' +
          '本单为预订确认单，出票后将更新为正式电子行程单及客票号，请以出票后信息为准，暂不可凭本单办理登机。',
          { align: 'center' },
        );
      }
      doc.text(
        'For assistance, please contact Coco Holiday customer service. 如有疑问请联系椰岛假期客服。',
        { align: 'center' },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
