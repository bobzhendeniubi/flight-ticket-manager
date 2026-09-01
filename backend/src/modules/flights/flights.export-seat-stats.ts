/**
 * 销售控位表导出（座位统计页 · 余位/上座率）— 对齐老系统「销售控位统计」样表口径：
 *
 *   班期 | 航段 | 航班号 | 总机位(Y舱/C舱) | 总确定(Y/C) | 总预留(Y/C) | 总余位(Y/C) | 客座率
 *
 * 口径（与座位统计页同源，样表数字反推验证 (50+1+125+5)/183=0.989）：
 *   - Y舱 = 经济 + 超级经济；C舱 = 商务 + 头等（老表只有 Y/C 两档）
 *   - 总确定 = sold（已售）
 *   - 总预留 = locked + held（锁位 + 占位单压座——都占着但没进已售）
 *   - 总余位 = available = capacity − sold − locked − held（可为负 = 超售）
 *     ——预留并入 locked 后「机位 = 确定 + 预留 + 余位」恒成立，对表的人能加得平
 *   - 客座率 = (确定 + 预留) ÷ 机位（= 座位统计页「总占用率」口径，含占位），保留 3 位小数
 *   - 班期按出发地当地时区折算（红眼班次 UTC 停在前一天，直接切 UTC 会写早一天）
 *   - 航班号列为样表之外补充：多航班同航段同日时唯一能区分行的字段
 */
import ExcelJS from 'exceljs';
import { localDateISO } from '../../lib/flight-time.js';

/** listSchedulesInRange 单班次（导出所需子集）。*/
export interface SeatStatsScheduleInput {
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  /** ISO UTC 串 */
  departureTime: string;
  departureTz: string;
  seatClasses: Array<{
    cabin: string;
    capacity: number;
    sold: number;
    locked: number;
    held: number;
    available: number;
  }>;
}

export interface SeatStatsRow {
  date: string; // 班期 YYYY-MM-DD（出发地当地）
  leg: string; // 航段 「DAD — MFM」
  flightNumber: string;
  capY: number;
  capC: number;
  confirmedY: number;
  confirmedC: number;
  reservedY: number;
  reservedC: number;
  availableY: number;
  availableC: number;
  /** 客座率 =（确定+预留）/ 机位，3 位小数；机位为 0 → 0 */
  loadFactor: number;
}

const C_CABINS = new Set(['BUSINESS', 'FIRST']);

/** 班次 → 一行销售控位表（纯函数，单测锁口径）。*/
export function scheduleToSeatStatsRow(s: SeatStatsScheduleInput): SeatStatsRow {
  let capY = 0;
  let capC = 0;
  let confirmedY = 0;
  let confirmedC = 0;
  let reservedY = 0;
  let reservedC = 0;
  let availableY = 0;
  let availableC = 0;
  for (const c of s.seatClasses) {
    const isC = C_CABINS.has(c.cabin);
    const reserved = c.locked + c.held;
    if (isC) {
      capC += c.capacity;
      confirmedC += c.sold;
      reservedC += reserved;
      availableC += c.available;
    } else {
      capY += c.capacity;
      confirmedY += c.sold;
      reservedY += reserved;
      availableY += c.available;
    }
  }
  const cap = capY + capC;
  const occupied = confirmedY + confirmedC + reservedY + reservedC;
  const loadFactor = cap > 0 ? Math.round((occupied / cap) * 1000) / 1000 : 0;
  return {
    date: localDateISO(new Date(s.departureTime), s.departureTz),
    leg: `${s.originCode} — ${s.destinationCode}`,
    flightNumber: s.flightNumber,
    capY,
    capC,
    confirmedY,
    confirmedC,
    reservedY,
    reservedC,
    availableY,
    availableC,
    loadFactor,
  };
}

export function seatStatsExportFilename(from?: string, to?: string): string {
  const range = from || to ? `${from ?? '全部'}_${to ?? from ?? '全部'}` : '全部';
  return `销售控位表_${range}.xlsx`;
}

/** 两行合并表头（对齐老样表）：单列纵向合并两行；Y/C 双子列的分组横向合并首行。*/
export async function buildSeatStatsWorkbook(rows: SeatStatsRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citur Travel · 销售控位表导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('销售控位表');

  const GROUPS: Array<{ header: string; span: number }> = [
    { header: '班期', span: 1 },
    { header: '航段', span: 1 },
    { header: '航班号', span: 1 },
    { header: '总机位', span: 2 },
    { header: '总确定', span: 2 },
    { header: '总预留', span: 2 },
    { header: '总余位', span: 2 },
    { header: '客座率', span: 1 },
  ];
  const row1: string[] = [];
  const row2: string[] = [];
  for (const g of GROUPS) {
    if (g.span === 1) {
      row1.push(g.header);
      row2.push('');
    } else {
      row1.push(g.header, '');
      row2.push('Y舱', 'C舱');
    }
  }
  ws.addRow(row1);
  ws.addRow(row2);
  let col = 1;
  for (const g of GROUPS) {
    if (g.span === 1) {
      ws.mergeCells(1, col, 2, col); // 纵向合并两行
    } else {
      ws.mergeCells(1, col, 1, col + g.span - 1); // 分组标题横向合并
    }
    col += g.span;
  }
  for (const r of [ws.getRow(1), ws.getRow(2)]) {
    r.font = { bold: true };
    r.alignment = { vertical: 'middle', horizontal: 'center' };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  }
  ws.columns = [
    { width: 12 },
    { width: 14 },
    { width: 10 },
    { width: 8 },
    { width: 8 },
    { width: 8 },
    { width: 8 },
    { width: 8 },
    { width: 8 },
    { width: 8 },
    { width: 8 },
    { width: 9 },
  ];

  for (const r of rows) {
    ws.addRow([
      r.date,
      r.leg,
      r.flightNumber,
      r.capY,
      r.capC,
      r.confirmedY,
      r.confirmedC,
      r.reservedY,
      r.reservedC,
      r.availableY,
      r.availableC,
      r.loadFactor,
    ]);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
