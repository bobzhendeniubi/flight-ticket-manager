/**
 * PricingService.calculatePrice · 商务舱价格联动经济舱（航班级单一配置源）单测。
 *
 * 覆盖：联动关（现状不变）/ 联动开（经济舱固定底价 + 差价）/ 联动开（经济舱仓位阶梯现价 + 差价）/
 *      经济舱缺价回退（无经济舱舱位、经济舱现价 ≤0）/ 联动开但请求的是经济舱（不受影响）。
 *
 * prisma 被 mock：flightSeatClass.findFirst 按 where.cabin 返回对应舱位；dateRanking.findUnique 返回 null（走 DOW 兜底）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  flightSeatClass: { findFirst: vi.fn() },
  dateRanking: { findUnique: vi.fn() },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { PricingService } from './pricing.service.js';

const SCHEDULE_ID = 'sched-1';

interface SeatClassStub {
  cabin: 'ECONOMY' | 'BUSINESS';
  capacity: number;
  sold: number;
  basePrice: number;
  fareBuckets?: Array<{ quota: number; price: number }> | null;
}

// 组一个「按 where.cabin 返回对应舱位」的 findFirst mock。
// businessPriceLinked / businessUpgradeCnyPerLeg 挂在 schedule.flight 上（calculatePrice 从这里取）。
function wireSeatClasses(
  seatClasses: SeatClassStub[],
  flight: { businessPriceLinked: boolean; businessUpgradeCnyPerLeg: number; flightNumber?: string },
): void {
  prismaMock.flightSeatClass.findFirst.mockImplementation(
    async ({ where, include }: { where: { cabin: string }; include?: unknown }) => {
      const sc = seatClasses.find((s) => s.cabin === where.cabin);
      if (!sc) return null;
      const base = {
        id: `${sc.cabin}-sc`,
        scheduleId: SCHEDULE_ID,
        cabin: sc.cabin,
        capacity: sc.capacity,
        sold: sc.sold,
        basePrice: sc.basePrice,
        fareBuckets: sc.fareBuckets ?? null,
      };
      // 请求主舱位时带 schedule+flight（include 存在）；经济舱现价解析不带 include。
      return include
        ? {
            ...base,
            schedule: {
              id: SCHEDULE_ID,
              departureTz: 'Asia/Macau',
              departureTime: new Date('2026-08-10T02:00:00.000Z'),
              flight,
            },
          }
        : base;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.dateRanking.findUnique.mockResolvedValue(null);
});

describe('PricingService.calculatePrice · 商务舱价格联动经济舱', () => {
  it('联动关：商务舱按自身 basePrice 定价（现状不变，无 businessLinked 标记）', async () => {
    wireSeatClasses(
      [
        { cabin: 'ECONOMY', capacity: 100, sold: 0, basePrice: 1000 },
        { cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: 3000 },
      ],
      { businessPriceLinked: false, businessUpgradeCnyPerLeg: 700 },
    );
    const res = await new PricingService().calculatePrice(SCHEDULE_ID, 'BUSINESS', 1);
    expect(res.averageUnitPrice).toBe(3000);
    expect(res.businessLinked).toBeUndefined();
    expect(res.businessLinkFallback).toBeUndefined();
  });

  it('联动开 + 经济舱固定底价：商务舱现价 = 经济舱现价 + 航班升舱差价', async () => {
    wireSeatClasses(
      [
        { cabin: 'ECONOMY', capacity: 100, sold: 0, basePrice: 1200 },
        { cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: 9999 }, // 自身 basePrice 应被忽略
      ],
      { businessPriceLinked: true, businessUpgradeCnyPerLeg: 700 },
    );
    const res = await new PricingService().calculatePrice(SCHEDULE_ID, 'BUSINESS', 2);
    expect(res.averageUnitPrice).toBe(1900); // 1200 + 700
    expect(res.totalPrice).toBe(3800); // 2 座
    expect(res.businessLinked).toBe(true);
    expect(res.perSeatBreakdown.every((s) => s.unitPrice === 1900)).toBe(true);
  });

  it('联动开 + 经济舱仓位阶梯：商务舱现价 = 经济舱当前档现价 + 差价', async () => {
    // 经济舱已售 25 张，阶梯 [20@1280, 30@1480] → 第 26 张落第二档 1480。
    wireSeatClasses(
      [
        {
          cabin: 'ECONOMY',
          capacity: 100,
          sold: 25,
          basePrice: 1000,
          fareBuckets: [
            { quota: 20, price: 1280 },
            { quota: 30, price: 1480 },
          ],
        },
        { cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: 5000 },
      ],
      { businessPriceLinked: true, businessUpgradeCnyPerLeg: 700 },
    );
    const res = await new PricingService().calculatePrice(SCHEDULE_ID, 'BUSINESS', 1);
    expect(res.averageUnitPrice).toBe(2180); // 1480 + 700
    expect(res.businessLinked).toBe(true);
  });

  it('联动开但无经济舱舱位 → 回退商务舱自身 basePrice + businessLinkFallback', async () => {
    wireSeatClasses(
      [{ cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: 3200 }],
      { businessPriceLinked: true, businessUpgradeCnyPerLeg: 700 },
    );
    const res = await new PricingService().calculatePrice(SCHEDULE_ID, 'BUSINESS', 1);
    expect(res.averageUnitPrice).toBe(3200); // 回退自身
    expect(res.businessLinked).toBeUndefined();
    expect(res.businessLinkFallback).toBe(true);
  });

  it('联动开但经济舱现价 ≤0（缺价）→ 回退商务舱自身 basePrice + businessLinkFallback', async () => {
    wireSeatClasses(
      [
        { cabin: 'ECONOMY', capacity: 100, sold: 0, basePrice: 0 }, // 缺价
        { cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: 2800 },
      ],
      { businessPriceLinked: true, businessUpgradeCnyPerLeg: 700 },
    );
    const res = await new PricingService().calculatePrice(SCHEDULE_ID, 'BUSINESS', 1);
    expect(res.averageUnitPrice).toBe(2800);
    expect(res.businessLinkFallback).toBe(true);
  });

  it('联动开时请求经济舱本身 → 不受联动影响（正常定价，无 businessLinked）', async () => {
    wireSeatClasses(
      [
        { cabin: 'ECONOMY', capacity: 100, sold: 0, basePrice: 1200 },
        { cabin: 'BUSINESS', capacity: 20, sold: 0, basePrice: 3000 },
      ],
      { businessPriceLinked: true, businessUpgradeCnyPerLeg: 700 },
    );
    const res = await new PricingService().calculatePrice(SCHEDULE_ID, 'ECONOMY', 1);
    expect(res.averageUnitPrice).toBe(1200);
    expect(res.businessLinked).toBeUndefined();
  });
});

describe('PricingService.calculatePrice · 余票不足报错指明是哪一程', () => {
  // 往返 / 多段报价时，只说「ECONOMY 余票仅 0 张」看不出是去程还是回程不够座；
  // 带上航班号与出发地当地日期，录单的人一眼能定位，失败日志也能按航班统计售罄后仍有人要订。
  it('售罄：前缀带航班号与当地出发日', async () => {
    wireSeatClasses([{ cabin: 'ECONOMY', capacity: 10, sold: 10, basePrice: 1000 }], {
      businessPriceLinked: false,
      businessUpgradeCnyPerLeg: 0,
      flightNumber: 'QH9589',
    });
    await expect(new PricingService().calculatePrice(SCHEDULE_ID, 'ECONOMY', 2)).rejects.toThrow(
      'QH9589（08-10 出发）ECONOMY 余票仅 0 张，不够 2 张。已售罄。',
    );
  });

  it('余票不够但未售罄：照旧给出最多可购张数', async () => {
    wireSeatClasses([{ cabin: 'ECONOMY', capacity: 10, sold: 9, basePrice: 1000 }], {
      businessPriceLinked: false,
      businessUpgradeCnyPerLeg: 0,
      flightNumber: 'QH9588',
    });
    await expect(new PricingService().calculatePrice(SCHEDULE_ID, 'ECONOMY', 3)).rejects.toThrow(
      'QH9588（08-10 出发）ECONOMY 余票仅 1 张，不够 3 张。最多可购 1 张。',
    );
  });

  it('取不到航班号时退回原文案，不拼出半截前缀', async () => {
    wireSeatClasses([{ cabin: 'ECONOMY', capacity: 10, sold: 10, basePrice: 1000 }], {
      businessPriceLinked: false,
      businessUpgradeCnyPerLeg: 0,
    });
    await expect(new PricingService().calculatePrice(SCHEDULE_ID, 'ECONOMY', 1)).rejects.toThrow(
      /^ECONOMY 余票仅 0 张，不够 1 张。已售罄。$/,
    );
  });
});
