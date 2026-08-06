/**
 * 进单统计导出 · 单元测试（vitest）
 *
 * 只测纯函数的聚合口径（不连库）：
 *   - 出发日期取去程最早航段；纯地面单回落入住日；都无 → 「未设出发日」殿后
 *   - 产品/团期：套餐=编码+名称；非套餐机票=「机票 {航班号}」（多航段按出发时间升序去重拼接）；其它品类按品类
 *   - 「出发日期 × 产品/团期」分组：订单数计数、人数求和
 *   - 排序：日期升序（未设出发日排最后），同日期内产品名升序
 *   - 文件名把冒号（带时间窗口）换成短横
 * 取数 SQL（COUNTED_STATUSES / buildOrderFilterWhere）由集成环境验证，不在此 mock prisma 查询。
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-intake → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  aggregateIntakeRows,
  intakeDepartDate,
  intakeProductLabel,
  intakeExportFilename,
  type OrderForIntakeExport,
} from './orders.export-intake.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** 单个 FLIGHT 行：出发日字符串，或 { 出发日, 航班号 }。*/
type FlightLegOpt = string | { date: string; flightNumber?: string };

/** 造一张进单统计所需最小订单（只含 passengers + items 相关字段）。*/
function order(opts: {
  paxCount: number;
  flights?: FlightLegOpt[]; // 各 FLIGHT 行出发日（可选带航班号）
  hotelCheckIn?: string;
  bundle?: { code: string | null; name: string } | null;
  ground?: 'HOTEL' | 'VISA' | 'TRANSFER' | 'INSURANCE';
}): OrderForIntakeExport {
  const items: OrderForIntakeExport['items'] = [];
  for (const f of opts.flights ?? []) {
    const { date, flightNumber } = typeof f === 'string' ? { date: f, flightNumber: '' } : f;
    items.push({
      kind: 'FLIGHT',
      hotelCheckIn: null,
      // flight 关系在 schema 里非空（每个 FlightSchedule 必属一个 Flight）；「无航班号」用空串模拟
      // 数据缺口（而非 null），与生产代码里 `it.flightSchedule?.flight?.flightNumber` 的假值判断口径一致。
      flightSchedule: { departureTime: D(date), flight: { flightNumber: flightNumber ?? '' } },
      bundle: null,
    });
  }
  if (opts.bundle !== undefined) {
    items.push({
      kind: 'BUNDLE',
      hotelCheckIn: opts.hotelCheckIn ? D(opts.hotelCheckIn) : null,
      flightSchedule: null,
      bundle: opts.bundle,
    });
  } else if (opts.ground) {
    items.push({
      kind: opts.ground,
      hotelCheckIn: opts.hotelCheckIn ? D(opts.hotelCheckIn) : null,
      flightSchedule: null,
      bundle: null,
    });
  }
  return {
    passengers: Array.from({ length: opts.paxCount }, (_, i) => ({ id: `p${i}` })),
    items,
  } as unknown as OrderForIntakeExport;
}

describe('intakeDepartDate', () => {
  it('取去程最早航段出发日', () => {
    expect(intakeDepartDate(order({ paxCount: 1, flights: ['2026-07-22', '2026-07-20'] }))).toBe('2026-07-20');
  });

  it('纯地面单回落最早入住日', () => {
    expect(intakeDepartDate(order({ paxCount: 1, ground: 'HOTEL', hotelCheckIn: '2026-08-01' }))).toBe('2026-08-01');
  });

  it('无航段无入住日 → 空串（归到未设出发日）', () => {
    expect(intakeDepartDate(order({ paxCount: 1, ground: 'VISA' }))).toBe('');
  });
});

describe('intakeProductLabel', () => {
  it('套餐 = 编码 + 名称', () => {
    expect(
      intakeProductLabel(order({ paxCount: 1, flights: ['2026-07-20'], bundle: { code: 'DAD5', name: '岘港5日' } })),
    ).toBe('DAD5 岘港5日');
  });

  it('套餐无编码 → 只用名称', () => {
    expect(
      intakeProductLabel(order({ paxCount: 1, bundle: { code: null, name: '芽庄自由行' } })),
    ).toBe('芽庄自由行');
  });

  it('非套餐机票（无航班号）→ 机票', () => {
    expect(intakeProductLabel(order({ paxCount: 1, flights: ['2026-07-20'] }))).toBe('机票');
  });

  it('非套餐签证 → 签证', () => {
    expect(intakeProductLabel(order({ paxCount: 1, ground: 'VISA' }))).toBe('签证');
  });

  it('单程带航班号 → 「机票 {航班号}」', () => {
    expect(
      intakeProductLabel(order({ paxCount: 1, flights: [{ date: '2026-07-20', flightNumber: 'QH9589' }] })),
    ).toBe('机票 QH9589');
  });

  it('往返两段 → 按出发时间升序拼接两个航班号', () => {
    expect(
      intakeProductLabel(
        order({
          paxCount: 1,
          flights: [
            { date: '2026-07-25', flightNumber: 'QH9588' }, // 回程，出发更晚
            { date: '2026-07-20', flightNumber: 'QH9589' }, // 去程，出发更早
          ],
        }),
      ),
    ).toBe('机票 QH9589+QH9588');
  });

  it('多航段相同航班号去重（如经停同号）', () => {
    expect(
      intakeProductLabel(
        order({
          paxCount: 1,
          flights: [
            { date: '2026-07-20', flightNumber: 'QH9589' },
            { date: '2026-07-20', flightNumber: 'QH9589' },
          ],
        }),
      ),
    ).toBe('机票 QH9589');
  });

  it('套餐订单即使含航班行，标签仍是套餐编码+名称（不受航班号影响）', () => {
    expect(
      intakeProductLabel(
        order({
          paxCount: 1,
          flights: [{ date: '2026-07-20', flightNumber: 'QH9589' }],
          bundle: { code: 'DAD5', name: '岘港5日' },
        }),
      ),
    ).toBe('DAD5 岘港5日');
  });
});

describe('aggregateIntakeRows', () => {
  it('同「出发日期 × 产品」合并：订单数计数、人数求和', () => {
    const rows = aggregateIntakeRows([
      order({ paxCount: 2, flights: ['2026-07-20'], bundle: { code: 'DAD5', name: '岘港5日' } }),
      order({ paxCount: 3, flights: ['2026-07-20'], bundle: { code: 'DAD5', name: '岘港5日' } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ departDate: '2026-07-20', product: 'DAD5 岘港5日', orderCount: 2, paxCount: 5 });
  });

  it('同日期不同产品分成两组', () => {
    const rows = aggregateIntakeRows([
      order({ paxCount: 2, flights: ['2026-07-20'], bundle: { code: 'DAD5', name: '岘港5日' } }),
      order({ paxCount: 1, flights: ['2026-07-20'] }), // 机票
    ]);
    expect(rows).toHaveLength(2);
    // 同日期内按产品名升序：'DAD5 岘港5日' < '机票'（拉丁字母排在中文之前）
    expect(rows.map((r) => r.product)).toEqual(['DAD5 岘港5日', '机票']);
  });

  it('按出发日期升序，「未设出发日」殿后', () => {
    const rows = aggregateIntakeRows([
      order({ paxCount: 1, ground: 'VISA' }), // 未设出发日
      order({ paxCount: 1, flights: ['2026-07-25'] }),
      order({ paxCount: 1, flights: ['2026-07-20'] }),
    ]);
    expect(rows.map((r) => r.departDate)).toEqual(['2026-07-20', '2026-07-25', '']);
  });
});

describe('intakeExportFilename', () => {
  it('纯日期区间', () => {
    expect(intakeExportFilename('2026-07-20', '2026-07-21')).toBe('进单统计_2026-07-20_2026-07-21.xlsx');
  });

  it('带时间窗口把冒号换成短横', () => {
    expect(intakeExportFilename('2026-07-20T09:00', '2026-07-20T12:30')).toBe(
      '进单统计_2026-07-20T09-00_2026-07-20T12-30.xlsx',
    );
  });

  it('不传区间 → 全部', () => {
    expect(intakeExportFilename()).toBe('进单统计_全部.xlsx');
  });
});
