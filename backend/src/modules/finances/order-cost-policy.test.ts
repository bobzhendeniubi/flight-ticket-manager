/**
 * order-cost-policy · 单元测试
 *
 * 已换人（SWAPPED）单成本一律按 0、人数不计被换下的人——财务汇总 / 订单毛利 / 三份导出
 * 共用的唯一判定。这里只钉口径本身；各出口的落地见各自的测试文件。
 */
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  ZERO_COST_ORDER_STATUSES,
  countedPassengerCount,
  isZeroCostOrder,
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

  it('人数口径：被换下的人不计人次；其余状态照乘客数', () => {
    const passengers = [{}, {}];
    expect(countedPassengerCount({ status: OrderStatus.SWAPPED, passengers })).toBe(0);
    expect(countedPassengerCount({ status: OrderStatus.PAID, passengers })).toBe(2);
    expect(countedPassengerCount({ status: OrderStatus.CANCELLED, passengers })).toBe(2);
  });
});
