/**
 * 换酒店成本重打快照 · 纯函数单测（vitest，不依赖真 DB）
 *
 * 覆盖 computeSwapHotelCostSnapshot：
 *   1. 新房型有成本价 → 每间每晚 × 晚数 × 房数（口径对齐建单时的 HOTEL 行快照公式）。
 *   2. 新房型无成本价 → unitCostCny/totalCostCny 均为 null（真缺数据，如实报缺，不落 0 虚高）。
 *   3. 0.5 间（拼房口径）× 成本 × 晚数，四舍五入。
 *
 * 售价冻结、BUNDLE 行不重算、审计 before/after 等全链路 → 见 orders.hotel-swap.integration.test.ts。
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));
import { computeSwapHotelCostSnapshot } from './orders.service.js';
import { resolveHotelStayUnitCostCny } from '../finances/hotel-cost.service.js';

describe('computeSwapHotelCostSnapshot · 换酒店后 HOTEL 行成本重打快照', () => {
  it('新房型有成本价 → 每间每晚 × 晚数 × 房数', () => {
    const snap = computeSwapHotelCostSnapshot({ newCostPriceCny: 500, nights: 3, rooms: 2 });
    expect(snap).toEqual({ unitCostCny: 500, totalCostCny: 3000 });
  });

  it('新房型无成本价（null）→ 两栏都 null（真缺数据，如实报缺）', () => {
    const snap = computeSwapHotelCostSnapshot({ newCostPriceCny: null, nights: 3, rooms: 2 });
    expect(snap).toEqual({ unitCostCny: null, totalCostCny: null });
  });

  it('newCostPriceCny=0 是有效成本（不等同于缺失）→ totalCostCny=0，unitCostCny=0', () => {
    const snap = computeSwapHotelCostSnapshot({ newCostPriceCny: 0, nights: 4, rooms: 1 });
    expect(snap).toEqual({ unitCostCny: 0, totalCostCny: 0 });
  });

  it('0.5 间（拼房口径）× 每间每晚 × 晚数，四舍五入', () => {
    const snap = computeSwapHotelCostSnapshot({ newCostPriceCny: 333, nights: 3, rooms: 0.5 });
    // 333 × 3 × 0.5 = 499.5 → round → 500
    expect(snap).toEqual({ unitCostCny: 333, totalCostCny: 500 });
  });

  it('新房型净房价按日期区间浮动：每间每晚取入住期内的平均值，总成本 = 逐晚合计 × 房数', () => {
    // 换酒店接线口径：newCostPriceCny = resolveHotelStayUnitCostCny(新房型区间, 缺省价, 本行入住区间)
    const unit = resolveHotelStayUnitCostCny({
      periods: [{ effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900 }],
      baseCostCny: 400,
      checkIn: new Date('2026-09-30T00:00:00.000Z'),
      checkOut: new Date('2026-10-03T00:00:00.000Z'),
    });
    // 09-30(400) + 10-01(900) + 10-02(900) = 2200 ÷ 3 = 733.33
    expect(unit).toBe(733.33);
    const snap = computeSwapHotelCostSnapshot({ newCostPriceCny: unit, nights: 3, rooms: 2 });
    // 733.33 × 3 × 2 = 4399.98 → round → 4400（= 逐晚合计 2200 × 2 间）
    expect(snap).toEqual({ unitCostCny: 733.33, totalCostCny: 4400 });
  });

  it('新房型无缺省价且区间没覆盖全部住宿 → 平均每晚 null → 快照两栏 null（不落 0）', () => {
    const unit = resolveHotelStayUnitCostCny({
      periods: [{ effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900 }],
      baseCostCny: null,
      checkIn: new Date('2026-09-30T00:00:00.000Z'),
      checkOut: new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(unit).toBeNull();
    expect(computeSwapHotelCostSnapshot({ newCostPriceCny: unit, nights: 3, rooms: 2 })).toEqual({
      unitCostCny: null,
      totalCostCny: null,
    });
  });
});
