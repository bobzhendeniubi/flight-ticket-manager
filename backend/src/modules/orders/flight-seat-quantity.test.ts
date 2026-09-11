/**
 * flight-seat-quantity · 机票行占座数唯一口径（婴儿不占座）纯函数单测。
 */
import { describe, it, expect } from 'vitest';
import {
  flightSeatQuantity,
  hasExplicitFlightSeatQuantity,
  resolveFlightSeatQuantity,
  stripClientFlightSeatMetadata,
  withFlightSeatMetadata,
} from './flight-seat-quantity.js';

describe('flightSeatQuantity · 读占座数', () => {
  it('老行没有 seatQuantity → 回落 quantity（现状不变）', () => {
    expect(flightSeatQuantity({ quantity: 2, metadata: null })).toBe(2);
    expect(flightSeatQuantity({ quantity: 2 })).toBe(2);
    expect(flightSeatQuantity({ quantity: 2, metadata: { businessUpgradeCount: 1 } })).toBe(2);
  });

  it('显式 seatQuantity 生效：1 成人 + 1 婴儿的行 quantity=2 → 占 1 座', () => {
    expect(flightSeatQuantity({ quantity: 2, metadata: { seatQuantity: 1 } })).toBe(1);
  });

  it('婴儿单独一单：seatQuantity=0 → 0 座', () => {
    expect(flightSeatQuantity({ quantity: 1, metadata: { seatQuantity: 0 } })).toBe(0);
  });

  it('seatQuantity 大于 quantity（脏数据）→ 夹到 quantity，绝不比行数量还多', () => {
    expect(flightSeatQuantity({ quantity: 2, metadata: { seatQuantity: 5 } })).toBe(2);
  });

  it('畸形值（负数 / 字符串 / 数组 metadata）→ 回落 quantity', () => {
    expect(flightSeatQuantity({ quantity: 2, metadata: { seatQuantity: -1 } })).toBe(2);
    expect(flightSeatQuantity({ quantity: 2, metadata: { seatQuantity: '0' } })).toBe(2);
    expect(flightSeatQuantity({ quantity: 2, metadata: [0] })).toBe(2);
  });

  it('hasExplicitFlightSeatQuantity 只认合法的非负整数', () => {
    expect(hasExplicitFlightSeatQuantity({ quantity: 1, metadata: { seatQuantity: 0 } })).toBe(true);
    expect(hasExplicitFlightSeatQuantity({ quantity: 1, metadata: {} })).toBe(false);
    expect(hasExplicitFlightSeatQuantity({ quantity: 1, metadata: { seatQuantity: 'x' } })).toBe(false);
  });
});

describe('resolveFlightSeatQuantity · 建单算占座数 = min(quantity, 非婴儿人数)', () => {
  it('纯机票 1 成人 + 1 婴儿：quantity 2、非婴儿 1 → 1 座', () => {
    expect(resolveFlightSeatQuantity(2, 1)).toBe(1);
  });

  it('婴儿单独一单：quantity 1、非婴儿 0 → 0 座', () => {
    expect(resolveFlightSeatQuantity(1, 0)).toBe(0);
  });

  it('套餐机票腿：quantity 已是 seatPax（=非婴儿人数）→ 等于 quantity，不重复扣', () => {
    expect(resolveFlightSeatQuantity(2, 2)).toBe(2);
  });

  it('没有婴儿：占座 = quantity', () => {
    expect(resolveFlightSeatQuantity(3, 3)).toBe(3);
  });

  it('负数 / 小数入参按非负整数夹逼', () => {
    expect(resolveFlightSeatQuantity(2, -1)).toBe(0);
    expect(resolveFlightSeatQuantity(2.9, 1.9)).toBe(1);
  });
});

describe('withFlightSeatMetadata / stripClientFlightSeatMetadata', () => {
  it('盖章保留其它键并覆盖同名键', () => {
    expect(
      withFlightSeatMetadata({ dateRank: 3, seatQuantity: 9 }, { seatQuantity: 1, infantCount: 1 }),
    ).toEqual({ dateRank: 3, seatQuantity: 1, infantCount: 1 });
  });

  it('客户端传的 seatQuantity / infantCount 一律剥掉（只能服务端写）', () => {
    expect(stripClientFlightSeatMetadata({ seatQuantity: 0, infantCount: 5, foo: 'bar' })).toEqual({
      foo: 'bar',
    });
    expect(stripClientFlightSeatMetadata(undefined)).toEqual({});
  });
});
