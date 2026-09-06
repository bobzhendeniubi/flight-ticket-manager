/**
 * 公开航线 / 机场 / 酒店城市聚合 · 单元测试（vitest）
 *
 * 注入 fake PrismaClient（同 bundle-availability.service 测试风格），只验证聚合逻辑：
 *   - listPublicRoutes：只看 isActive=true 的航班、按 (起降机场) 去重、附机场展示信息
 *   - listPublicAirports：起飞 + 降落两端去重、按代码排序
 *   - listPublicHotelCities：只看 isActive=true 的酒店、distinct 城市码、非机场码走覆盖表（HOA→会安）
 *   - 表里没有的三字码不报错，原样兜底展示（新航线上线但还没来得及补表的场景）
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import { listPublicAirports, listPublicHotelCities, listPublicRoutes } from './public.service.js';

interface FlightRow {
  originCode: string;
  destinationCode: string;
  isActive: boolean;
}

interface HotelRow {
  cityCode: string;
  isActive: boolean;
}

function fakeClient(opts: { flights?: FlightRow[]; hotels?: HotelRow[] }): PrismaClient {
  const flights = opts.flights ?? [];
  const hotels = opts.hotels ?? [];
  return {
    flight: {
      findMany: vi.fn().mockImplementation(({ where }: { where?: { isActive?: boolean } }) => {
        const active = where?.isActive === true ? flights.filter((f) => f.isActive) : flights;
        const rows = active.map((f) => ({ originCode: f.originCode, destinationCode: f.destinationCode }));
        // 模拟 Prisma distinct：按序列化后的字段组合去重（测试关心的字段够用）
        const seen = new Set<string>();
        const deduped = rows.filter((r) => {
          const key = JSON.stringify(r);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return Promise.resolve(deduped);
      }),
    },
    hotel: {
      findMany: vi.fn().mockImplementation(({ where }: { where?: { isActive?: boolean } }) => {
        const active = where?.isActive === true ? hotels.filter((h) => h.isActive) : hotels;
        const seen = new Set<string>();
        const deduped = active.filter((h) => {
          if (seen.has(h.cityCode)) return false;
          seen.add(h.cityCode);
          return true;
        });
        return Promise.resolve(deduped.map((h) => ({ cityCode: h.cityCode })));
      }),
    },
  } as unknown as PrismaClient;
}

describe('listPublicRoutes', () => {
  it('只聚合 isActive=true 的航班，按起降机场去重并附机场展示信息', async () => {
    const client = fakeClient({
      flights: [
        { originCode: 'MFM', destinationCode: 'DAD', isActive: true },
        { originCode: 'MFM', destinationCode: 'DAD', isActive: true }, // 同航线不同班次 → 应去重
        { originCode: 'HKG', destinationCode: 'BKK', isActive: true }, // 第二条航线
        { originCode: 'MFM', destinationCode: 'HAN', isActive: false }, // 停售，不应出现
      ],
    });

    const routes = await listPublicRoutes(client);

    expect(routes).toHaveLength(2);
    const mfmDad = routes.find((r) => r.originCode === 'MFM' && r.destinationCode === 'DAD');
    expect(mfmDad).toBeDefined();
    expect(mfmDad!.origin).toMatchObject({ code: 'MFM', name: '澳门', country: '中国澳门', tz: 'Asia/Macau' });
    expect(mfmDad!.destination).toMatchObject({ code: 'DAD', name: '岘港', tz: 'Asia/Ho_Chi_Minh' });
    expect(routes.some((r) => r.originCode === 'HKG' && r.destinationCode === 'BKK')).toBe(true);
    expect(routes.some((r) => r.destinationCode === 'HAN')).toBe(false);
  });

  it('未收录的三字码原样兜底展示，不抛错', async () => {
    const client = fakeClient({
      flights: [{ originCode: 'MFM', destinationCode: 'ZZZ', isActive: true }],
    });

    const routes = await listPublicRoutes(client);

    expect(routes).toHaveLength(1);
    expect(routes[0].destination).toMatchObject({ code: 'ZZZ', name: 'ZZZ', city: 'ZZZ', tz: 'Asia/Shanghai' });
  });

  it('没有任何活跃航班时返回空数组', async () => {
    const client = fakeClient({ flights: [{ originCode: 'MFM', destinationCode: 'DAD', isActive: false }] });
    const routes = await listPublicRoutes(client);
    expect(routes).toEqual([]);
  });
});

describe('listPublicAirports', () => {
  it('起飞 + 降落两端去重，按代码排序', async () => {
    const client = fakeClient({
      flights: [
        { originCode: 'MFM', destinationCode: 'DAD', isActive: true },
        { originCode: 'HKG', destinationCode: 'DAD', isActive: true }, // DAD 重复出现 → 应只算一次
        { originCode: 'MFM', destinationCode: 'BKK', isActive: false }, // 停售，不计入
      ],
    });

    const airports = await listPublicAirports(client);

    const codes = airports.map((a) => a.code);
    expect(codes).toEqual(['DAD', 'HKG', 'MFM']); // 排序 + 去重
    expect(codes).not.toContain('BKK');
  });
});

describe('listPublicHotelCities', () => {
  it('只看在架酒店，distinct 城市码，非机场码走覆盖表', async () => {
    const client = fakeClient({
      hotels: [
        { cityCode: 'DAD', isActive: true },
        { cityCode: 'DAD', isActive: true }, // 同城市多家酒店 → 应去重
        { cityCode: 'HOA', isActive: true }, // 非机场码（会安）
        { cityCode: 'BKK', isActive: false }, // 已下架，不应出现
      ],
    });

    const cities = await listPublicHotelCities(client);

    expect(cities).toEqual([
      { code: 'DAD', name: '岘港' },
      { code: 'HOA', name: '会安' },
    ]);
  });

  it('没有在架酒店时返回空数组', async () => {
    const client = fakeClient({ hotels: [{ cityCode: 'DAD', isActive: false }] });
    const cities = await listPublicHotelCities(client);
    expect(cities).toEqual([]);
  });
});
