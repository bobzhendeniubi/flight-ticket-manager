/**
 * 规则 12「该程已核销」判定的挂单升级（2026-09-21）：
 *   - 档案上有挂了同一张订单的流水 → 只看这些行的净额（绑定优先，起飞前核销也认）
 *   - 挂本单的被冲正（净额 0）→ 判未核销，**不**退回时间窗（别的一程的核销不能替它顶）
 *   - 一条挂本单的都没有（存量）→ 退回起飞当地零点之后的净额 > 0，且只算**没挂单号**的行：
 *     明确挂了别单的核销不替本单顶包，否则同人 A/B 两单时 B 的核销会把 A 判成已核销、A 白送一次
 */
import { describe, it, expect } from 'vitest';
import { isLegRedeemed } from './reminders.rules.upgrade-redeem.js';

const LEG_START = Date.parse('2026-09-10T00:00:00+08:00');
const BEFORE = new Date('2026-09-01T10:00:00+08:00');
const AFTER = new Date('2026-09-11T10:00:00+08:00');

describe('isLegRedeemed', () => {
  it('挂本单的正数核销在起飞前就记了 → 已核销（绑定优先，不看时间窗）', () => {
    expect(isLegRedeemed([{ tripsUsed: 1, createdAt: BEFORE, orderId: 'o1' }], 'o1', LEG_START)).toBe(true);
  });

  it('挂本单的核销被冲正（净额 0）→ 未核销，即使另一程起飞后有没挂单的核销也不顶', () => {
    const rows = [
      { tripsUsed: 1, createdAt: BEFORE, orderId: 'o1' },
      { tripsUsed: -1, createdAt: AFTER, orderId: 'o1' },
      { tripsUsed: 1, createdAt: AFTER, orderId: null }, // 别的一程
    ];
    expect(isLegRedeemed(rows, 'o1', LEG_START)).toBe(false);
  });

  it('挂的是别的订单 → 不算本单的绑定，时间窗里也不算（不替本单顶包）', () => {
    expect(isLegRedeemed([{ tripsUsed: 1, createdAt: BEFORE, orderId: 'o-other' }], 'o1', LEG_START)).toBe(false);
    expect(isLegRedeemed([{ tripsUsed: 1, createdAt: AFTER, orderId: 'o-other' }], 'o1', LEG_START)).toBe(false);
  });

  it('本单绑定优先：挂本单的净额 > 0 就算已核销，同期挂别单的行不影响结论', () => {
    const rows = [
      { tripsUsed: 1, createdAt: AFTER, orderId: 'o1' },
      { tripsUsed: 1, createdAt: AFTER, orderId: 'o-other' },
      { tripsUsed: -1, createdAt: AFTER, orderId: 'o-other' },
    ];
    expect(isLegRedeemed(rows, 'o1', LEG_START)).toBe(true);
  });

  it('没有本单绑定：时间窗只看没挂单号的行，挂别单的被剔掉', () => {
    // 同人 A(o1)/B(o-other) 两单都标了次数升级，运营只给 B 挂单号核销了一次 →
    // A 这一程仍未核销，待办必须照常生成。
    expect(isLegRedeemed([{ tripsUsed: 1, createdAt: AFTER, orderId: 'o-other' }], 'o1', LEG_START)).toBe(false);
    // 同一批里混一条没挂单号的存量核销 → 那条才算数
    expect(
      isLegRedeemed(
        [
          { tripsUsed: 1, createdAt: AFTER, orderId: 'o-other' },
          { tripsUsed: 1, createdAt: AFTER, orderId: null },
        ],
        'o1',
        LEG_START,
      ),
    ).toBe(true);
  });

  it('别单绑定不算：挂别单的净额再大也顶不掉本单的待办', () => {
    const rows = [
      { tripsUsed: 2, createdAt: AFTER, orderId: 'o-other' },
      { tripsUsed: 1, createdAt: AFTER, orderId: 'o-third' },
    ];
    expect(isLegRedeemed(rows, 'o1', LEG_START)).toBe(false);
  });

  it('存量没挂单号：起飞后净额 > 0 才算已核销（老行为不变）', () => {
    expect(isLegRedeemed([{ tripsUsed: 1, createdAt: AFTER, orderId: null }], 'o1', LEG_START)).toBe(true);
    expect(isLegRedeemed([{ tripsUsed: 1, createdAt: BEFORE }], 'o1', LEG_START)).toBe(false);
    expect(
      isLegRedeemed(
        [
          { tripsUsed: 1, createdAt: AFTER, orderId: null },
          { tripsUsed: -1, createdAt: AFTER, orderId: null },
        ],
        'o1',
        LEG_START,
      ),
    ).toBe(false);
  });
});
