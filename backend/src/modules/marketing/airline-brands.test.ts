import { describe, expect, it } from 'vitest';
import { findAirlineBrand } from './airline-brands.js';

describe('findAirlineBrand', () => {
  it('按去程航班号前两位匹配越竹航空', () => {
    expect(findAirlineBrand('QH9589')?.nameZh).toBe('越竹航空');
  });

  it('未知航司码返回无品牌', () => {
    expect(findAirlineBrand('9C1234')).toBeNull();
    expect(findAirlineBrand('XX1234')).toBeNull();
  });
});
