/**
 * 取消订单 · 单元测试（vitest）
 *
 * 覆盖：
 *  - validateTiers（已 exported，纯函数）
 *  - tier 选择算法（pickTierForHours，inline 镜像 cancellation.ts evaluateItem 里的核心逻辑；
 *    一旦把它 export 出来本测试切换到直接 import）
 */
import { describe, it, expect } from 'vitest';
import { validateTiers, type CancellationTier } from './cancellation.js';

// ── inline 镜像：cancellation.ts evaluateItem 里 tier 选择逻辑 ──
// 一旦 export 真版本，删掉本副本
function pickTierForHours(
  tiers: CancellationTier[],
  hoursLeft: number | null,
  fulfilled: boolean,
): CancellationTier {
  if (fulfilled) {
    return (
      tiers.find((t) => t.hoursBeforeDeparture === -1) ?? {
        hoursBeforeDeparture: -1,
        feePercent: 100,
      }
    );
  }
  if (hoursLeft === null) {
    // 没参考时间（VISA/TRANSFER）→ 最严的一档（feePercent 最大）
    if (tiers.length === 0) return { hoursBeforeDeparture: -1, feePercent: 100 };
    return tiers.reduce((max, t) => (t.feePercent > max.feePercent ? t : max));
  }
  // 找 tier.hoursBeforeDeparture <= hoursLeft 中最大的（"刚好踩进的最早档"）
  const sorted = tiers
    .filter((t) => t.hoursBeforeDeparture >= 0)
    .sort((a, b) => b.hoursBeforeDeparture - a.hoursBeforeDeparture);
  const matched = sorted.find((t) => hoursLeft >= t.hoursBeforeDeparture) ?? null;
  if (!matched) {
    return (
      tiers.find((t) => t.hoursBeforeDeparture === -1) ?? {
        hoursBeforeDeparture: -1,
        feePercent: 100,
      }
    );
  }
  return matched;
}

describe('validateTiers — happy path', () => {
  it('单档（72h 前 0%）通过 + normalized 回来', () => {
    const r = validateTiers([{ hoursBeforeDeparture: 72, feePercent: 0 }]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual([{ hoursBeforeDeparture: 72, feePercent: 0 }]);
  });
  it('多档：自动按 hoursBeforeDeparture 降序排，-1 排最后', () => {
    const r = validateTiers([
      { hoursBeforeDeparture: 24, feePercent: 50 },
      { hoursBeforeDeparture: -1, feePercent: 100 },
      { hoursBeforeDeparture: 72, feePercent: 0 },
      { hoursBeforeDeparture: 48, feePercent: 30 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual([
      { hoursBeforeDeparture: 72, feePercent: 0 },
      { hoursBeforeDeparture: 48, feePercent: 30 },
      { hoursBeforeDeparture: 24, feePercent: 50 },
      { hoursBeforeDeparture: -1, feePercent: 100 },
    ]);
  });
  it('feePercent 边界：0 和 100 都接受', () => {
    expect(validateTiers([{ hoursBeforeDeparture: 0, feePercent: 0 }]).ok).toBe(true);
    expect(validateTiers([{ hoursBeforeDeparture: 0, feePercent: 100 }]).ok).toBe(true);
  });
});

describe('validateTiers — 拒绝错误输入', () => {
  it('拒绝空数组', () => {
    expect(validateTiers([]).ok).toBe(false);
  });
  it('拒绝非数组', () => {
    expect(validateTiers(null).ok).toBe(false);
    expect(validateTiers(undefined).ok).toBe(false);
    expect(validateTiers({}).ok).toBe(false);
    expect(validateTiers('foo').ok).toBe(false);
  });
  it('拒绝 hoursBeforeDeparture 不是数字', () => {
    expect(validateTiers([{ hoursBeforeDeparture: '24', feePercent: 50 }]).ok).toBe(false);
    expect(validateTiers([{ hoursBeforeDeparture: NaN, feePercent: 50 }]).ok).toBe(false);
    expect(validateTiers([{ hoursBeforeDeparture: Infinity, feePercent: 50 }]).ok).toBe(false);
  });
  it('拒绝 hoursBeforeDeparture < -1（只允许 >=0 或 = -1）', () => {
    const r = validateTiers([
      { hoursBeforeDeparture: -2, feePercent: 100 },
      { hoursBeforeDeparture: 24, feePercent: 50 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('-2');
  });
  it('拒绝 feePercent 越界 (< 0 或 > 100)', () => {
    expect(validateTiers([{ hoursBeforeDeparture: 24, feePercent: -1 }]).ok).toBe(false);
    expect(validateTiers([{ hoursBeforeDeparture: 24, feePercent: 101 }]).ok).toBe(false);
  });
  it('拒绝 feePercent 不是数字', () => {
    expect(validateTiers([{ hoursBeforeDeparture: 24, feePercent: 'half' }]).ok).toBe(false);
  });
  it('拒绝重复的 hoursBeforeDeparture', () => {
    const r = validateTiers([
      { hoursBeforeDeparture: 24, feePercent: 30 },
      { hoursBeforeDeparture: 24, feePercent: 50 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('重复');
  });
  it('拒绝全是 -1（没有正常档 → 所有取消都会被当"已起飞"处理）', () => {
    const r = validateTiers([{ hoursBeforeDeparture: -1, feePercent: 100 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('hoursBeforeDeparture >= 0');
  });
  it('拒绝 tier 为非对象', () => {
    expect(validateTiers([null]).ok).toBe(false);
    expect(validateTiers(['foo']).ok).toBe(false);
    expect(validateTiers([42]).ok).toBe(false);
  });
});

describe('pickTierForHours — 起飞前不同时间段', () => {
  // 标准航班策略：起飞前 72h 0%、48h 30%、24h 50%、已起飞 100%
  const tiers: CancellationTier[] = [
    { hoursBeforeDeparture: 72, feePercent: 0 },
    { hoursBeforeDeparture: 48, feePercent: 30 },
    { hoursBeforeDeparture: 24, feePercent: 50 },
    { hoursBeforeDeparture: -1, feePercent: 100 },
  ];

  it('起飞前 100h：踩 72h 档 → 0%', () => {
    expect(pickTierForHours(tiers, 100, false).feePercent).toBe(0);
  });
  it('起飞前正好 72h：踩 72h 档 → 0%（包含等号）', () => {
    expect(pickTierForHours(tiers, 72, false).feePercent).toBe(0);
  });
  it('起飞前 71.9h：踩 48h 档 → 30%', () => {
    expect(pickTierForHours(tiers, 71.9, false).feePercent).toBe(30);
  });
  it('起飞前 50h：踩 48h 档 → 30%', () => {
    expect(pickTierForHours(tiers, 50, false).feePercent).toBe(30);
  });
  it('起飞前 48h：踩 48h 档 → 30%', () => {
    expect(pickTierForHours(tiers, 48, false).feePercent).toBe(30);
  });
  it('起飞前 30h：踩 24h 档 → 50%', () => {
    expect(pickTierForHours(tiers, 30, false).feePercent).toBe(50);
  });
  it('起飞前 0h：0 < 24 → 走 -1 档 100%', () => {
    expect(pickTierForHours(tiers, 0, false).feePercent).toBe(100);
  });
  it('已起飞（hoursLeft < 0）→ -1 档 100%', () => {
    expect(pickTierForHours(tiers, -5, false).feePercent).toBe(100);
  });
});

describe('pickTierForHours — 已履约（fulfilled=true 不看时间）', () => {
  const tiers: CancellationTier[] = [
    { hoursBeforeDeparture: 72, feePercent: 0 },
    { hoursBeforeDeparture: -1, feePercent: 100 },
  ];
  it('已履约 → 取 -1 档', () => {
    expect(pickTierForHours(tiers, 1000, true).feePercent).toBe(100); // 即使时间充裕也 100%
  });
  it('已履约但策略没 -1 档 → fallback 100%', () => {
    const noTerminal: CancellationTier[] = [{ hoursBeforeDeparture: 72, feePercent: 0 }];
    expect(pickTierForHours(noTerminal, 1000, true).feePercent).toBe(100);
  });
});

describe('pickTierForHours — hoursLeft=null（VISA/TRANSFER 等无时间字段）', () => {
  it('选最严档（feePercent 最大）', () => {
    const tiers: CancellationTier[] = [
      { hoursBeforeDeparture: 72, feePercent: 0 },
      { hoursBeforeDeparture: 24, feePercent: 50 },
      { hoursBeforeDeparture: 0, feePercent: 80 },
    ];
    expect(pickTierForHours(tiers, null, false).feePercent).toBe(80);
  });
  it('空 tiers 兜底 100%', () => {
    expect(pickTierForHours([], null, false).feePercent).toBe(100);
  });
});

describe('pickTierForHours — 起飞前刚好踩档边界（重要 off-by-one 防回归）', () => {
  // 防止"hoursLeft >= tier.hoursBeforeDeparture"被改成 ">"
  const tiers: CancellationTier[] = [
    { hoursBeforeDeparture: 24, feePercent: 50 },
    { hoursBeforeDeparture: -1, feePercent: 100 },
  ];
  it('hoursLeft=24（边界）→ 50%', () => {
    expect(pickTierForHours(tiers, 24, false).feePercent).toBe(50);
  });
  it('hoursLeft=23.99 → 100%（已过 24h 关键点，必须按 -1 档）', () => {
    expect(pickTierForHours(tiers, 23.99, false).feePercent).toBe(100);
  });
});
