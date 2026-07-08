/**
 * 房态导出（xlsx）· 单元测试（vitest）
 *
 * 注入 fake PrismaClient（getBoard 内部支持 client 参数），构建 workbook 后用 ExcelJS 读回校验
 * 表头/冻结视图/矩阵形状，重点覆盖「未配包房」（block=0 且 used>0）渲染为文本标记而非裸负数、
 * 真超卖（block>0 且 remaining<0）仍是数字这两种口径。getBoard 本身的口径已在
 * hotel-control.service.test.ts 覆盖，这里只测导出层的映射/样式。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { buildHotelControlBoardWorkbook, hotelControlExportFilename } from './hotel-control.export.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const todayStr = new Date().toISOString().slice(0, 10);
const todayMs = new Date(`${todayStr}T00:00:00.000Z`).getTime();
const day = (n: number): Date => new Date(todayMs + n * DAY_MS);
const dayStr = (n: number): string => day(n).toISOString().slice(0, 10);

function boardClient(orderItems: unknown[], periods: unknown[]): PrismaClient {
  return {
    hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue(periods) },
    orderItem: { findMany: vi.fn().mockResolvedValue(orderItems) },
  } as unknown as PrismaClient;
}

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

describe('buildHotelControlBoardWorkbook', () => {
  it('矩阵形状：每家酒店 4 行（包房/用房/物理房间/余量）× 日期列；表头 + 冻结视图', async () => {
    const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } };
    const client = boardClient(
      [
        // D0：block=0（无周期覆盖）但 used=1 → 「未配包房」
        { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, ...rt },
        // D1：block=2、used=3 → 真超卖 remaining=-1
        { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
        { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
        { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
      ],
      [
        // 周期只覆盖 D1..D2（D0 不在范围内 → D0 block=0）
        { hotelId: 'h1', dateFrom: day(1), dateTo: day(2), rooms: 2, unitPrice: 150, hotel: { name: '美溪海滩酒店' } },
      ],
    );

    const buf = await buildHotelControlBoardWorkbook({ from: dayStr(0), to: dayStr(2) }, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('销控矩阵');
    expect(ws).toBeTruthy();

    // 表头：酒店/单价/指标 + 3 个日期列
    const header = ws!.getRow(1).values as unknown[];
    expect(header.slice(1, 4)).toEqual(['酒店', '单价(¥/间/晚)', '指标']);
    expect(header.slice(4)).toEqual([dayStr(0), dayStr(1), dayStr(2)]);

    // 冻结表头行 + 前 3 列（镜像页面 sticky 列）—— 读回后 ExcelJS 会补上其余默认视图属性，只断言关心的三项
    expect(ws!.views?.[0]).toMatchObject({ state: 'frozen', xSplit: 3, ySplit: 1 });

    // 4 行：包房/用房/物理房间/余量（数据行从第 2 行起）
    expect(ws!.getRow(2).getCell(3).value).toBe('包房');
    expect(ws!.getRow(3).getCell(3).value).toBe('用房(床位)');
    expect(ws!.getRow(4).getCell(3).value).toBe('物理房间');
    expect(ws!.getRow(5).getCell(3).value).toBe('余量');

    // 酒店名 / 单价列跨 4 行合并
    expect(ws!.getCell(2, 1).value).toBe('美溪海滩酒店');
    expect(ws!.getCell(2, 2).value).toBe(150);
  });

  it('「未配包房」渲染文本标记（非裸负数）；真超卖仍是数字并高亮', async () => {
    const rt = { hotelRoomType: { hotelId: 'h1', hotel: { name: '美溪海滩酒店' } } };
    const client = boardClient(
      [
        { hotelCheckIn: day(0), hotelCheckOut: day(1), roomsBilled: 1, ...rt },
        { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
        { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
        { hotelCheckIn: day(1), hotelCheckOut: day(2), roomsBilled: 1, ...rt },
      ],
      [{ hotelId: 'h1', dateFrom: day(1), dateTo: day(2), rooms: 2, unitPrice: 150, hotel: { name: '美溪海滩酒店' } }],
    );

    const buf = await buildHotelControlBoardWorkbook({ from: dayStr(0), to: dayStr(2) }, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('销控矩阵')!;

    // 余量行 = 第 5 行；日期列从第 4 列起（D0=col4, D1=col5, D2=col6）
    const remainingRow = ws.getRow(5);
    expect(remainingRow.getCell(4).value).toBe('未配包房'); // D0: block=0, used=1
    expect(remainingRow.getCell(4).fill).toMatchObject({ fgColor: { argb: 'FFFDE68A' } });

    expect(remainingRow.getCell(5).value).toBe(-1); // D1: block=2, used=3 → 真超卖，数字保留
    expect(remainingRow.getCell(5).fill).toMatchObject({ fgColor: { argb: 'FFE11D48' } });

    expect(remainingRow.getCell(6).value).toBe(2); // D2: block=2, used=0 → 正常余量，无高亮
    expect(remainingRow.getCell(6).fill).toBeUndefined();
  });

  it('该区间无包房周期/占房订单 → 仍出带说明行的合法 xlsx（不抛错）', async () => {
    const client = boardClient([], []);
    const buf = await buildHotelControlBoardWorkbook({ from: dayStr(0), to: dayStr(1) }, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('销控矩阵');
    expect(ws).toBeTruthy();
    expect(String(ws!.getRow(2).getCell(1).value)).toContain('无');
    // 无酒店数据时不追加汇总/图例（没有可汇总/可解释的矩阵）
    expect(ws!.rowCount).toBe(2);
  });

  it('多酒店：交替底色 banding + 汇总 3 行 + 图例', async () => {
    // 单日矩阵，两家酒店，zh-CN 排序 海景酒店(索引0,无底色) 排在 山景酒店(索引1,浅灰底) 前面
    const client = boardClient(
      [
        // 海景酒店：block=3 用房=1 → 余量=2（正常，无高亮）
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          hotelRoomType: { hotelId: 'hA', hotel: { name: '海景酒店' } },
        },
        // 山景酒店：无周期（block=0）但用房=2 → 「未配包房」
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          hotelRoomType: { hotelId: 'hB', hotel: { name: '山景酒店' } },
        },
        {
          hotelCheckIn: day(0),
          hotelCheckOut: day(1),
          roomsBilled: 1,
          hotelRoomType: { hotelId: 'hB', hotel: { name: '山景酒店' } },
        },
      ],
      [{ hotelId: 'hA', dateFrom: day(0), dateTo: day(0), rooms: 3, unitPrice: 100, hotel: { name: '海景酒店' } }],
    );

    const buf = await buildHotelControlBoardWorkbook({ from: dayStr(0), to: dayStr(0) }, client);
    const wb = await loadWorkbook(buf);
    const ws = wb.getWorksheet('销控矩阵')!;

    // 海景酒店（第一家，索引0）：4 行在 2-5，无 banding（默认留白）
    expect(ws.getRow(2).getCell(3).value).toBe('包房');
    expect(ws.getRow(2).getCell(4).fill).toBeUndefined();
    expect(ws.getCell(2, 1).value).toBe('海景酒店');

    // 山景酒店（第二家，索引1）：4 行在 6-9，非高亮单元格带浅灰 banding
    expect(ws.getRow(6).getCell(3).value).toBe('包房');
    expect(ws.getRow(6).getCell(4).fill).toMatchObject({ fgColor: { argb: 'FFF3F4F6' } });
    // 酒店名合并单元格（列1，行6=startRow）同样带 banding
    expect(ws.getCell(6, 1).fill).toMatchObject({ fgColor: { argb: 'FFF3F4F6' } });
    // 山景酒店余量行（第 9 行）：未配包房高亮覆盖在 banding 之上
    expect(ws.getRow(9).getCell(4).value).toBe('未配包房');
    expect(ws.getRow(9).getCell(4).fill).toMatchObject({ fgColor: { argb: 'FFFDE68A' } });

    // 3 行跨酒店汇总紧跟在最后一家酒店之后（第 10-12 行）
    expect(ws.getRow(10).getCell(3).value).toBe('当日包房累计');
    expect(ws.getRow(10).getCell(4).value).toBe(3); // 海景 block=3 + 山景 block=0
    expect(ws.getRow(10).font).toMatchObject({ bold: true });

    expect(ws.getRow(11).getCell(3).value).toBe('当日用房累计');
    // 人工核对：海景 used=1 + 山景 used=2 = 3（与两家酒店「用房(床位)」行手工相加一致）
    expect(ws.getRow(11).getCell(4).value).toBe(3);

    expect(ws.getRow(12).getCell(3).value).toBe('当日余房累计');
    // 海景 remaining=2（正常）+ 山景「未配包房」按 0 计入（不计其误导性 -2）= 2
    expect(ws.getRow(12).getCell(4).value).toBe(2);

    // 图例：标题 + 未配包房说明 + 超卖说明 + 余房累计口径说明
    expect(ws.getRow(14).getCell(1).value).toBe('图例');
    expect(String(ws.getRow(15).getCell(2).value)).toContain('未配包房 = 该晚有客占房');
    expect(ws.getRow(15).getCell(1).fill).toMatchObject({ fgColor: { argb: 'FFFDE68A' } });
    expect(String(ws.getRow(16).getCell(2).value)).toContain('超卖 = 该晚包房周期已设置');
    expect(String(ws.getRow(17).getCell(2).value)).toContain('当日余房累计');
    expect(String(ws.getRow(17).getCell(2).value)).toContain('按 0 计入');
  });
});

describe('hotelControlExportFilename', () => {
  it('单日 / 区间两种文件名', () => {
    expect(hotelControlExportFilename('2026-07-10', '2026-07-10')).toBe('房控导出_2026-07-10.xlsx');
    expect(hotelControlExportFilename('2026-07-10', '2026-07-12')).toBe(
      '房控导出_2026-07-10_2026-07-12.xlsx',
    );
  });
});
