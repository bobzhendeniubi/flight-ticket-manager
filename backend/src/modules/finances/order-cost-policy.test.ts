/**
 * order-cost-policy · 单元测试
 *
 * 已换人（SWAPPED）单成本一律按 0——财务汇总 / 订单毛利 / 三份导出共用的唯一判定；核对明细
 * 人数列照常显示、备注列打标注。这里只钉口径本身；各出口的落地见各自的测试文件。
 */
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  SWAPPED_OUT_ROW_NOTE,
  ZERO_COST_ORDER_STATUSES,
  isZeroCostOrder,
  swappedOutRowNote,
} from './order-cost-policy.js';

describe('order-cost-policy — 已换人单成本按 0', () => {
  it('只有已换人（SWAPPED）成本按 0；其余状态照常算成本', () => {
    expect([...ZERO_COST_ORDER_STATUSES]).toEqual([OrderStatus.SWAPPED]);
    expect(isZeroCostOrder({ status: OrderStatus.SWAPPED })).toBe(true);
    for (const status of Object.values(OrderStatus)) {
      if (status === OrderStatus.SWAPPED) continue;
      expect(isZeroCostOrder({ status })).toBe(false);
    }
  });

  it('核对明细备注：已换人单打「被换下，不计人次、不计成本」标注，有备注用「；」接上；其余状态原样', () => {
    expect(swappedOutRowNote({ status: OrderStatus.SWAPPED, notes: null })).toBe(SWAPPED_OUT_ROW_NOTE);
    expect(swappedOutRowNote({ status: OrderStatus.SWAPPED, notes: '  ' })).toBe(SWAPPED_OUT_ROW_NOTE);
    expect(swappedOutRowNote({ status: OrderStatus.SWAPPED, notes: '客人临时换同事出行' })).toBe(
      `${SWAPPED_OUT_ROW_NOTE}；客人临时换同事出行`,
    );
    expect(swappedOutRowNote({ status: OrderStatus.PAID, notes: '普通备注' })).toBe('普通备注');
    expect(swappedOutRowNote({ status: OrderStatus.PAID, notes: null })).toBe('');
    expect(swappedOutRowNote({ status: OrderStatus.CANCELLED, notes: null })).toBe('');
  });
});
