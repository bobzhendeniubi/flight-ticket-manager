/**
 * 电子行程单 PDF 生成器 — pdfkit
 *
 * 输入：订单 + 乘客 + PNR 数据
 * 输出：Buffer，供邮件附件 / HTTP 下载用
 *
 * 字体：pdfkit 默认字体不支持 CJK —— 生产需要嵌入中文 TTF（e.g. Noto Sans CJK）。
 * 当前实现用 ASCII 降级 + 原始中文字段（PDF 查看器装了中文字体就能显示，否则 □□）。
 * TODO: 接入 /fonts/NotoSansSC-Regular.otf 真正解决中文显示。
 */
import PDFDocument from 'pdfkit';
import { localDateTime } from './flight-time.js';

export interface ItineraryData {
  orderNumber: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  total: string;
  currency: string;
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

/**
 * 异步生成 PDF buffer。
 * 渲染 3 段：
 *   1. 标题 + 订单号 + 生成时间
 *   2. 航段（每个 flight 一块）
 *   3. 乘客表格（姓名 / 护照号 / PNR / e-ticket）
 */
export async function renderItineraryPdf(data: ItineraryData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── 标题 ────────────────────────────────────────
      // 前台品牌：椰岛假期 / Coco Holiday（世途/Citur 仅法律主体，客户可见文档绝不露出）
      doc.fontSize(20).text('Coco Holiday / 椰岛假期', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(14).fillColor('#475569').text('Electronic Itinerary & E-Ticket', { align: 'center' });
      doc.moveDown(1);

      // ── 订单信息 ────────────────────────────────────
      doc.fontSize(10).fillColor('#000');
      doc.text(`Order Number / 订单号:  ${data.orderNumber}`);
      doc.text(`Issued At / 开票时间:  ${data.createdAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
      doc.text(`Contact / 联系人:  ${data.contactName}  ·  ${data.contactPhone}${data.contactEmail ? '  ·  ' + data.contactEmail : ''}`);
      doc.text(`Total / 应付:  ${data.currency} ${data.total}`);
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
           .text(p.pnr ?? '—', undefined, undefined, { width: 75, continued: true })
           .text(p.eticketNumber ?? '—');
        doc.moveDown(0.3);
      }
      doc.moveDown(1);

      // ── 脚注 ────────────────────────────────────────
      doc.fontSize(8).fillColor('#94a3b8');
      doc.text(
        'This is a computer-generated document. 本行程单为电子凭证，请凭 PNR + 护照原件在机场柜台办理登机。',
        { align: 'center' },
      );
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
