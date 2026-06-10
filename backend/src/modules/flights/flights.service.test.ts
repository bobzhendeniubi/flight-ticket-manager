/**
 * 六档余位档位 computeAvailabilityTier · 纯函数单测（vitest）
 *
 * 阈值口径（AVAILABILITY_TIER_THRESHOLDS，运营可能调整）：
 *   >40 AMPLE；16-40 TIGHT；6-15 LOW；1-5 VERY_LOW；≤0 SOLD_OUT
 */
import { describe, it, expect, vi } from 'vitest';

// flights.service 顶层会实例化 PricingService 并引用 prisma —— 先 mock 掉
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));
vi.mock('../pricing/pricing.service.js', () => ({ PricingService: class {} }));

import { AVAILABILITY_TIER_THRESHOLDS, computeAvailabilityTier } from './flights.service.js';

describe('computeAvailabilityTier', () => {
  it('>40 → AMPLE', () => {
    expect(computeAvailabilityTier(41)).toBe('AMPLE');
    expect(computeAvailabilityTier(180)).toBe('AMPLE');
  });

  it('16-40 → TIGHT（含边界）', () => {
    expect(computeAvailabilityTier(40)).toBe('TIGHT');
    expect(computeAvailabilityTier(16)).toBe('TIGHT');
  });

  it('6-15 → LOW（含边界）', () => {
    expect(computeAvailabilityTier(15)).toBe('LOW');
    expect(computeAvailabilityTier(6)).toBe('LOW');
  });

  it('1-5 → VERY_LOW（含边界）', () => {
    expect(computeAvailabilityTier(5)).toBe('VERY_LOW');
    expect(computeAvailabilityTier(1)).toBe('VERY_LOW');
  });

  it('≤0 → SOLD_OUT', () => {
    expect(computeAvailabilityTier(0)).toBe('SOLD_OUT');
    expect(computeAvailabilityTier(-3)).toBe('SOLD_OUT');
  });

  it('阈值常量与档位边界一致（防止改常量漏改函数）', () => {
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.AMPLE_MIN)).toBe('AMPLE');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.AMPLE_MIN - 1)).toBe('TIGHT');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.TIGHT_MIN - 1)).toBe('LOW');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.LOW_MIN - 1)).toBe('VERY_LOW');
    expect(computeAvailabilityTier(AVAILABILITY_TIER_THRESHOLDS.VERY_LOW_MIN - 1)).toBe('SOLD_OUT');
  });
});
