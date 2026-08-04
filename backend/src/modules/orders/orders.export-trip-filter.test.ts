/**
 * 导出层「单程/往返」判定 · 单元测试（vitest）—— orders.export-trip-filter.ts
 *
 *   1. excludeOnewayFromReturnLegExport：invoiceLeg='return' 时剔除单程单；
 *      outbound/system/undefined 维度不受影响。
 *   2. filterExportOrdersByTripType：tripType='oneway'/'roundtrip' 各自筛对；未给不过滤。
 */
import { describe, it, expect } from 'vitest';
import {
  excludeOnewayFromReturnLegExport,
  filterExportOrdersByTripType,
  type TripFilterOrder,
} from './orders.export-trip-filter.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** 往返单：两条 FLIGHT 行，按 departureTime 升序第 2 段即回程。*/
function roundTripOrder(id: string): TripFilterOrder {
  return {
    id,
    items: [
      { flightScheduleId: 'fs-out', flightSchedule: { departureTime: D('2026-07-13') } },
      { flightScheduleId: 'fs-ret', flightSchedule: { departureTime: D('2026-07-14') } },
    ],
  };
}

/** 单程单：只有一条 FLIGHT 行（去程），没有回程。*/
function onewayOrder(id: string): TripFilterOrder {
  return {
    id,
    items: [{ flightScheduleId: 'fs-out', flightSchedule: { departureTime: D('2026-07-13') } }],
  };
}

describe('excludeOnewayFromReturnLegExport', () => {
  it('invoiceLeg=return → 剔除单程单，只留往返单', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1'), roundTripOrder('rt2')];
    const result = excludeOnewayFromReturnLegExport(orders, 'return');
    expect(result.map((o) => o.id)).toEqual(['rt1', 'rt2']);
  });

  it('invoiceLeg=outbound → 不过滤，单程单原样保留', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1')];
    const result = excludeOnewayFromReturnLegExport(orders, 'outbound');
    expect(result.map((o) => o.id)).toEqual(['rt1', 'ow1']);
  });

  it('invoiceLeg=system → 不过滤，单程单原样保留', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1')];
    const result = excludeOnewayFromReturnLegExport(orders, 'system');
    expect(result.map((o) => o.id)).toEqual(['rt1', 'ow1']);
  });

  it('invoiceLeg 未给 → 不过滤，原样返回', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1')];
    const result = excludeOnewayFromReturnLegExport(orders, undefined);
    expect(result.map((o) => o.id)).toEqual(['rt1', 'ow1']);
  });

  it('返回浅拷贝而非原数组引用（不过滤分支）', () => {
    const orders = [roundTripOrder('rt1')];
    const result = excludeOnewayFromReturnLegExport(orders, 'outbound');
    expect(result).not.toBe(orders);
    expect(result).toEqual(orders);
  });
});

describe('filterExportOrdersByTripType', () => {
  it('tripType=oneway → 只留单程单', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1'), onewayOrder('ow2')];
    const result = filterExportOrdersByTripType(orders, 'oneway');
    expect(result.map((o) => o.id)).toEqual(['ow1', 'ow2']);
  });

  it('tripType=roundtrip → 只留往返单', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1'), roundTripOrder('rt2')];
    const result = filterExportOrdersByTripType(orders, 'roundtrip');
    expect(result.map((o) => o.id)).toEqual(['rt1', 'rt2']);
  });

  it('tripType 未给 → 不过滤，原样返回', () => {
    const orders = [roundTripOrder('rt1'), onewayOrder('ow1')];
    const result = filterExportOrdersByTripType(orders, undefined);
    expect(result.map((o) => o.id)).toEqual(['rt1', 'ow1']);
  });
});
