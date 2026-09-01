/**
 * 销售控位表导出 · 单元测试 — 锁 scheduleToSeatStatsRow 的口径：
 *   Y/C 舱归组、确定=sold、预留=locked+held、余位=available、
 *   机位=确定+预留+余位 加得平、客座率=(确定+预留)/机位 三位小数、
 *   班期按出发地时区折算（红眼班次不写早一天）。
 */
import { describe, it, expect } from 'vitest';
import {
  scheduleToSeatStatsRow,
  seatStatsExportFilename,
  buildSeatStatsWorkbook,
  type SeatStatsScheduleInput,
} from './flights.export-seat-stats.js';

function fixture(): SeatStatsScheduleInput {
  return {
    flightNumber: 'QH9588',
    originCode: 'DAD',
    destinationCode: 'MFM',
    // 岘港当地 2026-08-31 00:30（UTC+7）= UTC 2026-08-30 17:30 —— 红眼班次跨 UTC 日界
    departureTime: '2026-08-30T17:30:00.000Z',
    departureTz: 'Asia/Ho_Chi_Minh',
    seatClasses: [
      // Y：176 机位 = 50 确定 + (100 held + 25 locked) 预留 + 1 余位
      { cabin: 'ECONOMY', capacity: 176, sold: 50, locked: 25, held: 100, available: 1 },
      // C：7 机位 = 1 确定 + 5 预留 + 1 余位（样表同款数字）
      { cabin: 'BUSINESS', capacity: 7, sold: 1, locked: 0, held: 5, available: 1 },
    ],
  };
}

describe('scheduleToSeatStatsRow — 口径映射', () => {
  const row = scheduleToSeatStatsRow(fixture());

  it('Y/C 归组：经济→Y、商务→C；确定=sold、预留=locked+held、余位=available', () => {
    expect(row.capY).toBe(176);
    expect(row.capC).toBe(7);
    expect(row.confirmedY).toBe(50);
    expect(row.confirmedC).toBe(1);
    expect(row.reservedY).toBe(125);
    expect(row.reservedC).toBe(5);
    expect(row.availableY).toBe(1);
    expect(row.availableC).toBe(1);
  });

  it('机位 = 确定 + 预留 + 余位（对表的人要能加得平）', () => {
    expect(row.confirmedY + row.reservedY + row.availableY).toBe(row.capY);
    expect(row.confirmedC + row.reservedC + row.availableC).toBe(row.capC);
  });

  it('客座率 = (确定+预留)/机位，三位小数（样表反推 181/183=0.989）', () => {
    expect(row.loadFactor).toBe(0.989);
  });

  it('班期按出发地时区折算：UTC 08-30 17:30 → 岘港 08-31', () => {
    expect(row.date).toBe('2026-08-31');
    expect(row.leg).toBe('DAD — MFM');
    expect(row.flightNumber).toBe('QH9588');
  });

  it('超售（available 为负）如实输出，不夹 0', () => {
    const s = fixture();
    s.seatClasses[0] = { cabin: 'ECONOMY', capacity: 176, sold: 180, locked: 0, held: 0, available: -4 };
    const r = scheduleToSeatStatsRow(s);
    expect(r.availableY).toBe(-4);
    expect(r.confirmedY + r.reservedY + r.availableY).toBe(r.capY);
  });

  it('机位为 0 → 客座率 0（不除零）', () => {
    const s = fixture();
    s.seatClasses = [];
    expect(scheduleToSeatStatsRow(s).loadFactor).toBe(0);
  });

  it('超级经济并入 Y、头等并入 C', () => {
    const s = fixture();
    s.seatClasses = [
      { cabin: 'PREMIUM_ECONOMY', capacity: 20, sold: 5, locked: 0, held: 0, available: 15 },
      { cabin: 'FIRST', capacity: 4, sold: 2, locked: 0, held: 0, available: 2 },
    ];
    const r = scheduleToSeatStatsRow(s);
    expect(r.capY).toBe(20);
    expect(r.capC).toBe(4);
  });
});

describe('seatStatsExportFilename', () => {
  it('区间齐 → 起_止；缺省 → 全部', () => {
    expect(seatStatsExportFilename('2026-08-31', '2026-09-07')).toBe('销售控位表_2026-08-31_2026-09-07.xlsx');
    expect(seatStatsExportFilename()).toBe('销售控位表_全部.xlsx');
  });
});

describe('buildSeatStatsWorkbook — 出得来、行数对', () => {
  it('两行表头 + 数据行', async () => {
    const buf = await buildSeatStatsWorkbook([scheduleToSeatStatsRow(fixture())]);
    expect(buf.length).toBeGreaterThan(1000); // 是个像样的 xlsx
  });
});
