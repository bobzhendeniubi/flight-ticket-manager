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
