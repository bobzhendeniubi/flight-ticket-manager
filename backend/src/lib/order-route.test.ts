/**
 * lib/order-route · 单元测试（vitest）
 *
 * 订单 → 航线只有一条派生规则链，但每一环都能悄悄错成「归错线」，而归错线在报表上看不出来
 * （两条线的数都还是数），所以逐环钉死：
 *   · 往返单必须归**去程**方向（拿回程那条会得到反向的航线，两条线的账互相串）；
 *   · 纯地面套餐单退到套餐绑定航班（这类单没有航段，漏了它整批会掉进未知桶）；
 *   · 推不出来 → 未知桶，**绝不兜底**到任何写死的航线（兜底 = 新航线的单静默算进老航线）。
 */
import { describe, it, expect } from 'vitest';
import {
  orderMatchesRoute,
  orderRouteBucketKey,
  resolveOrderRouteKey,
  routeKeyLabel,
  UNKNOWN_ROUTE_KEY,
  type RouteOrderItemLike,
} from './order-route.js';

function leg(origin: string, destination: string, departISO: string): RouteOrderItemLike {
  return {
    flightSchedule: {
      departureTime: new Date(departISO),
      flight: { originCode: origin, destinationCode: destination },
    },
  };
}

function groundItem(): RouteOrderItemLike {
  return { flightSchedule: null, bundle: null };
}

describe('resolveOrderRouteKey — 订单归哪条航线', () => {
  it('单程单：航线 = 该航段航班的起降地', () => {
    expect(resolveOrderRouteKey([leg('MFM', 'DAD', '2026-09-10T02:00:00Z')])).toBe('MFM-DAD');
  });

  it('往返单：取最早起飞那条（去程方向），不是数组里的最后一条', () => {
    // 刻意把回程排在前面：真实数据里去程总排在前，但排序坏了也不该改变航线归属。
    const items = [
      leg('DAD', 'MFM', '2026-09-14T06:00:00Z'),
      leg('MFM', 'DAD', '2026-09-10T02:00:00Z'),
    ];
    expect(resolveOrderRouteKey(items)).toBe('MFM-DAD');
  });

  it('纯地面套餐单（没有航段）：退到套餐绑定的去程航班', () => {
    const items: RouteOrderItemLike[] = [
      {
        bundle: {
          outboundFlight: { originCode: 'MFM', destinationCode: 'DAD' },
          returnFlight: { originCode: 'DAD', destinationCode: 'MFM' },
        },
      },
    ];
    expect(resolveOrderRouteKey(items)).toBe('MFM-DAD');
  });

  it('套餐只绑了回程：按回程反推去程方向（口径同 resolveBundleRoute）', () => {
    const items: RouteOrderItemLike[] = [
      {
        bundle: {
          outboundFlight: null,
          returnFlight: { originCode: 'DAD', destinationCode: 'MFM' },
        },
      },
    ];
    expect(resolveOrderRouteKey(items)).toBe('MFM-DAD');
  });

  it('有航段就以航段为准，不看套餐绑的是哪条线', () => {
    const items: RouteOrderItemLike[] = [
      leg('HKG', 'DAD', '2026-09-10T02:00:00Z'),
      { bundle: { outboundFlight: { originCode: 'MFM', destinationCode: 'DAD' } } },
    ];
    expect(resolveOrderRouteKey(items)).toBe('HKG-DAD');
  });

  it('起降地是脏数据（缺一半）：按没有航线处理，绝不半途拼出一条假航线', () => {
    const items: RouteOrderItemLike[] = [
      {
        flightSchedule: {
          departureTime: new Date('2026-09-10T02:00:00Z'),
          flight: { originCode: 'MFM', destinationCode: null },
        },
      },
    ];
    expect(resolveOrderRouteKey(items)).toBeNull();
  });

  it('机场码大小写 / 空格不一致：归一化到同一条线，不裂成两桶', () => {
    expect(resolveOrderRouteKey([leg(' mfm ', 'dad', '2026-09-10T02:00:00Z')])).toBe('MFM-DAD');
  });

  it('纯地面单（无航段无套餐）：null，归未知桶', () => {
    expect(resolveOrderRouteKey([groundItem()])).toBeNull();
    expect(orderRouteBucketKey([groundItem()])).toBe(UNKNOWN_ROUTE_KEY);
  });
});

describe('orderMatchesRoute — 筛选', () => {
  const roundTrip = [
    leg('MFM', 'DAD', '2026-09-10T02:00:00Z'),
    leg('DAD', 'MFM', '2026-09-14T06:00:00Z'),
  ];

  it('往返单只命中去程方向那条航线，不会两条线各数一遍', () => {
    expect(orderMatchesRoute(roundTrip, 'MFM-DAD')).toBe(true);
    // 这条是关键：若按「任一航段命中」判定，往返单会同时进两条线的桶，两条线相加超过总数。
    expect(orderMatchesRoute(roundTrip, 'DAD-MFM')).toBe(false);
  });

  it("筛 'unknown' = 只看推不出航线的单", () => {
    expect(orderMatchesRoute([groundItem()], UNKNOWN_ROUTE_KEY)).toBe(true);
    expect(orderMatchesRoute(roundTrip, UNKNOWN_ROUTE_KEY)).toBe(false);
  });
});

describe('routeKeyLabel — 展示名', () => {
  it('MFM-DAD → MFM→DAD；未知桶给中文名；形状不对的原样返回', () => {
    expect(routeKeyLabel('MFM-DAD')).toBe('MFM→DAD');
    expect(routeKeyLabel(UNKNOWN_ROUTE_KEY)).toBe('未知航线');
    expect(routeKeyLabel('MFM-DAD-HKG')).toBe('MFM-DAD-HKG');
  });
});
