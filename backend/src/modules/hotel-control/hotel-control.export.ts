/**
 * 房态导出（xlsx）— 把销控矩阵（getBoard 输出）原样导出成表格，与页面上的矩阵一一对应：
 * 每家酒店 4 行（包房 / 用房(床位) / 物理房间 / 余量）× 日期列；酒店名 + 单价在前导列
 * （跨该酒店 4 行合并单元格，镜像页面 rowSpan=4 的视觉）。
 * 「余量」= 物理房间口径（block − physicalUsed，异性不能拼一间）；「用房(床位)」行才是床位口径。
 *
 * 「未配包房」语义（与销控矩阵页面 + 分房表导出「当日余房」列同一口径，见 hotel-control.service.ts
 * getHotelNightlyRemaining 的 JSDoc）：某晚 block=0 但 used>0，说明这晚根本没配包房周期，
 * 此时余量是个误导的负数（"超卖"假象）——余量行改渲染文本「未配包房」并用琥珀色高亮，
 * 不再输出裸负数；真正的超卖（block>0 且 physicalRemaining<0）保留红底高亮。
 * 矩阵下方追加图例区块解释这两种高亮的触发条件（只解释，不改变触发条件本身）。
 *
 * 密集矩阵可读性：每家酒店的 4 行按酒店交替加浅底色（banding），便于横向扫读时区分酒店边界；
 * 「未配包房」琥珀色 / 真超卖玫红色高亮覆盖在 banding 之上，优先级不变。
 *
 * 矩阵最后追加 3 行跨酒店当日汇总（当日包房/用房/余房累计）——运营一眼看总量，无需逐酒店心算；
 * 口径见 appendSummaryRows 注释（「未配包房」酒店当晚按 0 计入余房累计，不计入其误导性负数；
 * 真超卖仍按负值计入，因为那是需要实际协调加房的真实缺口）。
 */
import ExcelJS from 'exceljs';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { getBoard } from './hotel-control.service.js';
import type { HotelControlBoard } from './hotel-control.service.js';

const ROW_LABELS = ['包房', '用房(床位)', '物理房间', '余量'] as const;
type RowLabel = (typeof ROW_LABELS)[number];

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } } as const;
/** 未配包房：琥珀色（与前端 amber-200 系一致）。 */
const UNCONFIGURED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE68A' } } as const;
const UNCONFIGURED_FONT = { color: { argb: 'FF92400E' }, bold: true } as const;
/** 真超卖：玫红色（与前端 rose-600 系一致）。 */
const OVERSOLD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE11D48' } } as const;
const OVERSOLD_FONT = { color: { argb: 'FFFFFFFF' }, bold: true } as const;
/** 酒店交替底色（zebra banding）：偶数序（第 1/3/5…家）留白，奇数序（第 2/4/6…家）着浅灰——
 *  两两可辨即可，避免整表花哨；未配包房/超卖高亮仍覆盖在其上。 */
const HOTEL_BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } } as const;
/** 跨酒店当日汇总行底色（浅靛蓝，呼应后台 Console 设计系统主色）。 */
const SUMMARY_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } } as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

  const lastCol = 3 + board.dates.length;
  const seriesByLabel = (h: (typeof board.hotels)[number]): Record<RowLabel, number[]> => ({
    包房: h.rows.block,
    '用房(床位)': h.rows.used,
    物理房间: h.rows.physicalUsed,
    // 余量 = 物理房间口径（block − physicalUsed）；「用房(床位)」行才是床位口径
    余量: h.rows.physicalRemaining,
  });

  let rowIdx = 2;
  board.hotels.forEach((hotel, hotelIdx) => {
    const startRow = rowIdx;
    const series = seriesByLabel(hotel);
    // 每家酒店 4 行交替底色，隔行区分酒店边界；「未配包房」/超卖高亮覆盖在其上（下方单独 set）
    const band = hotelIdx % 2 === 1 ? HOTEL_BAND_FILL : null;
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
      if (band) {
        for (let col = 1; col <= lastCol; col++) row.getCell(col).fill = { ...band };
      }
      if (label === '余量') {
        for (let i = 0; i < board.dates.length; i++) {
          const cell = row.getCell(4 + i);
          const block = hotel.rows.block[i];
          const used = hotel.rows.used[i];
          // 余量行为物理口径 → 真超卖判定用物理余量（block − physicalUsed）
          const remaining = hotel.rows.physicalRemaining[i];
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
  });

  if (board.hotels.length === 0) {
    ws.addRow(['（该区间无包房周期或占房订单）']);
  } else {
    appendSummaryRows(ws, board, lastCol);
    appendLegend(ws, lastCol);
  }

  // 冻结表头行 + 前 3 列（酒店/单价/指标），横向滚动日期列时保持可读——镜像页面 sticky 列
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * 矩阵下方追加 3 行跨酒店当日汇总：当日包房累计 / 当日用房累计 / 当日余房累计。
 *   包房累计(d) = Σ 各酒店 block(d)；用房累计(d) = Σ 各酒店 used(d)——与远期视图 getForward 的
 *   held/occupied 同口径（此处直接在内存里对已取回的 board.hotels 求和，不再重复查库）。
 *
 *   余房累计(d) = Σ 各酒店 physicalRemaining(d)（物理房间口径，与「余量」行一致），但「未配包房」
 *   （block=0 且 used>0）的酒店当晚按 0 计入——这晚根本没有房控在管，不该把它的误导性负数计进
 *   「总缺口」，否则会让运营误以为系统性超卖，实际只是那家酒店那晚没配周期（见文件顶部「未配包房」
 *   语义）。真超卖（block>0 且 physicalRemaining<0）仍按负值计入，因为那才是需要实际协调加房的真实
 *   缺口——这样「当日余房累计」才对容量规划有意义（不被未配置的酒店拉低）。
 */
function appendSummaryRows(ws: ExcelJS.Worksheet, board: HotelControlBoard, lastCol: number): void {
  const heldTotal = board.dates.map((_, i) =>
    board.hotels.reduce((sum, h) => sum + h.rows.block[i], 0),
  );
  const usedTotal = board.dates.map((_, i) =>
    round2(board.hotels.reduce((sum, h) => sum + h.rows.used[i], 0)),
  );
  const remainingTotal = board.dates.map((_, i) =>
    round2(
      board.hotels.reduce((sum, h) => {
        const unconfigured = h.rows.block[i] === 0 && h.rows.used[i] > 0;
        // 余房口径与「余量」行一致 = 物理余量（block − physicalUsed）
        return sum + (unconfigured ? 0 : h.rows.physicalRemaining[i]);
      }, 0),
    ),
  );

  const rows: Array<{ label: string; values: number[] }> = [
    { label: '当日包房累计', values: heldTotal },
    { label: '当日用房累计', values: usedTotal },
    { label: '当日余房累计', values: remainingTotal },
  ];
  for (const { label, values } of rows) {
    const row = ws.addRow(['', '', label, ...values]);
    row.font = { bold: true };
    for (let col = 1; col <= lastCol; col++) row.getCell(col).fill = { ...SUMMARY_FILL };
  }
}

/**
 * 矩阵最下方追加图例：解释「未配包房」/「超卖」两种高亮的触发条件（运营反馈看不懂
 * 「未配包房」为何只在部分日期/酒店出现）+「当日余房累计」的口径说明，只解释不改变判定逻辑。
 */
function appendLegend(ws: ExcelJS.Worksheet, lastCol: number): void {
  ws.addRow([]);
  const title = ws.addRow(['图例']);
  title.font = { bold: true };

  const entries: Array<{
    fill: typeof UNCONFIGURED_FILL | typeof OVERSOLD_FILL;
    font: typeof UNCONFIGURED_FONT | typeof OVERSOLD_FONT;
    text: string;
  }> = [
    {
      fill: UNCONFIGURED_FILL,
      font: UNCONFIGURED_FONT,
      text:
        '未配包房 = 该晚有客占房，但未设置包房周期（未纳入控房），并非超卖；如需控房请在房控页为该酒店设置包房周期。' +
        '仅在「有占房且未配周期」的酒店当晚出现，故只见于部分日期/酒店。',
    },
    {
      fill: OVERSOLD_FILL,
      font: OVERSOLD_FONT,
      text: '超卖 = 该晚包房周期已设置但占房数超过包房数，需尽快加房或协调换房。',
    },
  ];
  for (const { fill, font, text } of entries) {
    const row = ws.addRow(['', text]);
    const swatch = row.getCell(1);
    swatch.fill = { ...fill };
    swatch.font = { ...font };
    ws.mergeCells(row.number, 2, row.number, Math.max(2, lastCol));
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }

  const note = ws.addRow([
    '',
    '「当日余房累计」= 各酒店当晚余量之和；未配包房的酒店当晚按 0 计入（不纳入管控范围，不计入其误导性负数），' +
      '避免虚增系统性缺口假象；真超卖仍按负值计入合计。',
  ]);
  ws.mergeCells(note.number, 2, note.number, Math.max(2, lastCol));
  note.getCell(2).alignment = { wrapText: true, vertical: 'top' };
}

/** 文件名：`房控导出_{from}.xlsx`（单日）/ `房控导出_{from}_{to}.xlsx`（区间）。*/
export function hotelControlExportFilename(from: string, to: string): string {
  return from === to ? `房控导出_${from}.xlsx` : `房控导出_${from}_${to}.xlsx`;
}
