/**
 * 房态导出（xlsx）— 把销控矩阵（getBoard 输出）原样导出成表格，与页面上的矩阵一一对应：
 * 每家酒店 4 行（包房 / 用房(床位) / 物理房间 / 余量）× 日期列；酒店名 + 单价在前导列
 * （跨该酒店 4 行合并单元格，镜像页面 rowSpan=4 的视觉）。
 *
 * 「未配包房」语义（与销控矩阵页面 + 分房表导出「当日余房」列同一口径，见 hotel-control.service.ts
 * getHotelNightlyRemaining 的 JSDoc）：某晚 block=0 但 used>0，说明这晚根本没配包房周期，
 * 此时 remaining = 0-used 是个具体误导的负数（"超卖"假象）——余量行改渲染文本「未配包房」
 * 并用琥珀色高亮，不再输出裸负数；真正的超卖（block>0 且 remaining<0）保留红底高亮。
 */
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { getBoard } from './hotel-control.service.js';

const ROW_LABELS = ['包房', '用房(床位)', '物理房间', '余量'] as const;
type RowLabel = (typeof ROW_LABELS)[number];

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } } as const;
/** 未配包房：琥珀色（与前端 amber-200 系一致）。 */
const UNCONFIGURED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } } as const;
const UNCONFIGURED_FONT = { color: { argb: 'FF92400E' }, bold: true } as const;
/** 真超卖：玫红色（与前端 rose-600 系一致）。 */
const OVERSOLD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE11D48' } } as const;
const OVERSOLD_FONT = { color: { argb: 'FFFFFFFF' }, bold: true } as const;

export async function buildHotelControlBoardWorkbook(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const board = await getBoard(range, client);

  const wb = new ExcelJS.Workbook();
  wb.creator = '房控导出';
  wb.created = new Date();
  const ws = wb.addWorksheet('销控矩阵');

  ws.columns = [
    { header: '酒店', width: 18 },
    { header: '单价(¥/间/晚)', width: 14 },
    { header: '指标', width: 12 },
    ...board.dates.map((d) => ({ header: d, width: 10 })),
  ];
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { ...HEADER_FILL };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  const seriesByLabel = (h: (typeof board.hotels)[number]): Record<RowLabel, number[]> => ({
    包房: h.rows.block,
    '用房(床位)': h.rows.used,
    物理房间: h.rows.physicalUsed,
    余量: h.rows.remaining,
  });

  let rowIdx = 2;
  for (const hotel of board.hotels) {
    const startRow = rowIdx;
    const series = seriesByLabel(hotel);
    for (const label of ROW_LABELS) {
      const values = series[label];
      const rowValues: Array<string | number> = [hotel.hotelName, hotel.unitPrice ?? '', label];
      for (let i = 0; i < board.dates.length; i++) {
        const block = hotel.rows.block[i];
        const used = hotel.rows.used[i];
        const unconfigured = label === '余量' && block === 0 && used > 0;
        // 数字列保持原生 number（Excel 可求和/排序）；仅「未配包房」这一特例落为说明性文本。
        rowValues.push(unconfigured ? '未配包房' : values[i]);
      }
      const row = ws.addRow(rowValues);
      if (label === '余量') {
        for (let i = 0; i < board.dates.length; i++) {
          const cell = row.getCell(4 + i);
          const block = hotel.rows.block[i];
          const used = hotel.rows.used[i];
          const remaining = hotel.rows.remaining[i];
          if (block === 0 && used > 0) {
            cell.fill = { ...UNCONFIGURED_FILL };
            cell.font = { ...UNCONFIGURED_FONT };
          } else if (remaining < 0) {
            cell.fill = { ...OVERSOLD_FILL };
            cell.font = { ...OVERSOLD_FONT };
          }
        }
      }
      rowIdx++;
    }
    // 酒店名 / 单价列跨该酒店 4 行合并，镜像页面矩阵 rowSpan=4 的视觉
    ws.mergeCells(startRow, 1, rowIdx - 1, 1);
    ws.mergeCells(startRow, 2, rowIdx - 1, 2);
    const mergedHotelCell = ws.getCell(startRow, 1);
    mergedHotelCell.alignment = { vertical: 'top', horizontal: 'left' };
  }

  if (board.hotels.length === 0) {
    ws.addRow(['（该区间无包房周期或占房订单）']);
  }

  // 冻结表头行 + 前 3 列（酒店/单价/指标），横向滚动日期列时保持可读——镜像页面 sticky 列
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** 文件名：`房控导出_{from}.xlsx`（单日）/ `房控导出_{from}_{to}.xlsx`（区间）。*/
export function hotelControlExportFilename(from: string, to: string): string {
  return from === to ? `房控导出_${from}.xlsx` : `房控导出_${from}_${to}.xlsx`;
}
