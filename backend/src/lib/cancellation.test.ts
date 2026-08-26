/**
 * 取消订单 · 单元测试（vitest）
 *
 * 覆盖：
 *  - validateTiers（已 exported，纯函数）
 *  - tier 选择算法（pickTierForHours，inline 镜像 cancellation.ts evaluateItem 里的核心逻辑；
 *    一旦把它 export 出来本测试切换到直接 import）
 */
import { describe, it, expect } from 'vitest';
import {
  CANCELLABLE_STATUSES,
  computeRefundBreakdown,
  splitRefundBetweenCashAndBalance,
  validateTiers,
  type CancellationTier,
  type GrossItemQuote,
} from './cancellation.js';

/** 造一条毛价口径的行报价（feeAmount 按毛价 × feePercent，与 quoteItem 的输出一致）。 */
function grossItem(amount: number, feePercent: number, kind = 'FLIGHT'): GrossItemQuote {
  return {
    itemId: `itm-${kind}-${amount}-${feePercent}`,
    kind,
    description: `${kind} 行`,
    amount,
    hoursLeft: 100,
    policyId: 'pol-1',
    policyName: '标准',
    matchedTier: { hoursBeforeDeparture: 72, feePercent },
    feePercent,
    feeAmount: Math.round(amount * (feePercent / 100) * 100) / 100,
    refundAmount: Math.round(amount * (1 - feePercent / 100) * 100) / 100,
    reason: '测试',
    fulfilled: false,
  };
}

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

// ════════════════════════════════════════════════════════════════════════
// 退款金额引擎 computeRefundBreakdown
// 三条已坐实的资金缺陷的守卫（每条断言到具体金额，不只断言"算出来了"）：
//   ① 预存余额抵付单被算成应退 ¥0
//   ② 手续费按毛价计、应退按实收扣 → 立减后实际费率被放大
//   ③ adjustmentCny（改期费/换人费）被全额退还
// ════════════════════════════════════════════════════════════════════════

describe('computeRefundBreakdown · ① 预存余额抵付单必须能退到钱', () => {
  it('全额余额抵付（现金 0 / 余额抵 10000，20% 档）→ 应退 8000，全部回余额', () => {
    // 旧口径只看 paidAmount(=0) → totalRefund = 0，客户白丢一整单钱。
    const r = computeRefundBreakdown({
      paidAmount: 0,
      prepaymentOffsetCny: 10_000,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 20)],
    });
    expect(r.refundableBaseCny).toBe(10_000);
    expect(r.feeScale).toBe(1);
    expect(r.totalFee).toBe(2_000);
    expect(r.totalRefund).toBe(8_000);
    expect(r.refundToCashCny).toBe(0);
    expect(r.refundToBalanceCny).toBe(8_000);
  });

  it('现金 3000 + 余额抵 7000（20% 档）→ 应退 8000 = 现金 3000 + 余额 5000（现金优先）', () => {
    const r = computeRefundBreakdown({
      paidAmount: 3_000,
      prepaymentOffsetCny: 7_000,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 20)],
    });
    expect(r.totalRefund).toBe(8_000);
    expect(r.refundToCashCny).toBe(3_000);
    expect(r.refundToBalanceCny).toBe(5_000);
    // 两段之和必须恰好等于应退，绝不重复退
    expect(r.refundToCashCny + r.refundToBalanceCny).toBe(r.totalRefund);
  });

  it('回余额部分永不超过当初抵扣掉的余额（防凭空造币）', () => {
    const r = computeRefundBreakdown({
      paidAmount: 0,
      prepaymentOffsetCny: 1_000,
      adjustmentCny: 0,
      // 毛价远小于实付 → feeScale 被夹到 1，可退基数仍是 1000
      grossItems: [grossItem(100, 0)],
    });
    expect(r.totalRefund).toBe(1_000);
    expect(r.refundToBalanceCny).toBeLessThanOrEqual(1_000);
    expect(r.refundToBalanceCny).toBe(1_000);
  });
});

describe('computeRefundBreakdown · ② 手续费基数与应退基数同源（立减/SETTLEMENT 差额行）', () => {
  it('毛价 12000、立减收敛后实收 6000、20% 档 → 扣 1200（不是旧口径的 2400）', () => {
    const r = computeRefundBreakdown({
      paidAmount: 6_000,
      prepaymentOffsetCny: 0,
      adjustmentCny: 0,
      grossItems: [grossItem(12_000, 20)],
    });
    expect(r.feeScale).toBe(0.5);
    expect(r.totalFee).toBe(1_200);
    expect(r.totalRefund).toBe(4_800);
    // 实际费率必须回到 20%，而不是被放大成 40%
    expect(r.totalFee / r.refundableBaseCny).toBeCloseTo(0.2, 10);
  });

  it('负金额优惠行不参与毛价合计，也不产生负手续费', () => {
    const discountRow: GrossItemQuote = {
      ...grossItem(-4_000, 0, 'DISCOUNT'),
      feeAmount: 0,
      refundAmount: 0,
      policyId: null,
      policyName: '（优惠/减免行，不计手续费）',
      matchedTier: null,
    };
    const r = computeRefundBreakdown({
      paidAmount: 6_000,
      prepaymentOffsetCny: 0,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 20), discountRow],
    });
    // 毛价合计只数正金额行 = 10000 → feeScale = 6000/10000
    expect(r.feeScale).toBe(0.6);
    expect(r.totalFee).toBe(1_200);
    expect(r.totalRefund).toBe(4_800);
    // 优惠行的分摊已付额为 0，绝不出现负手续费把应退顶高
    const discount = r.items.find((i) => i.kind === 'DISCOUNT')!;
    expect(discount.paidShare).toBe(0);
    expect(discount.feeAmount).toBe(0);
  });

  it('客户多付时 feeScale 夹到 1：手续费不随多付一起放大', () => {
    const r = computeRefundBreakdown({
      paidAmount: 20_000,
      prepaymentOffsetCny: 0,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 20)],
    });
    expect(r.feeScale).toBe(1);
    expect(r.totalFee).toBe(2_000); // 而非 4000
    expect(r.totalRefund).toBe(18_000); // 多付 10000 原样退回 + 8000
  });

  it('毛价合计为 0（整单只剩优惠行）→ 不收手续费，可退基数原样退', () => {
    const r = computeRefundBreakdown({
      paidAmount: 500,
      prepaymentOffsetCny: 0,
      adjustmentCny: 0,
      grossItems: [],
    });
    expect(r.feeScale).toBe(0);
    expect(r.totalFee).toBe(0);
    expect(r.totalRefund).toBe(500);
  });

  it('行级 refund/(refund+fee) 比值不随折算改变 → 佣金按比例冲销口径不受影响', () => {
    const r = computeRefundBreakdown({
      paidAmount: 6_000,
      prepaymentOffsetCny: 0,
      adjustmentCny: 0,
      grossItems: [grossItem(8_000, 30), grossItem(4_000, 10, 'HOTEL')],
    });
    for (const i of r.items) {
      const ratio = i.refundAmount / (i.refundAmount + i.feeAmount);
      expect(ratio).toBeCloseTo(1 - i.feePercent / 100, 6);
    }
  });
});

describe('computeRefundBreakdown · ③ 改期费/换人费不可退', () => {
  it('实收 10500（含 500 改期费）、0% 档 → 只退 10000，改期费留存', () => {
    const r = computeRefundBreakdown({
      paidAmount: 10_500,
      prepaymentOffsetCny: 0,
      adjustmentCny: 500,
      grossItems: [grossItem(10_000, 0)],
    });
    expect(r.refundableBaseCny).toBe(10_000);
    expect(r.totalFee).toBe(0);
    expect(r.totalRefund).toBe(10_000); // 旧口径会退 10500
    expect(r.refundToCashCny).toBe(10_000);
    expect(r.refundToBalanceCny).toBe(0);
  });

  it('改期费从现金侧先扣：现金 1000 + 余额 9000、改期费 1000、0% 档 → 现金 0 / 余额 9000', () => {
    const r = computeRefundBreakdown({
      paidAmount: 1_000,
      prepaymentOffsetCny: 9_000,
      adjustmentCny: 1_000,
      grossItems: [grossItem(9_000, 0)],
    });
    expect(r.refundableBaseCny).toBe(9_000);
    expect(r.totalRefund).toBe(9_000);
    expect(r.refundToCashCny).toBe(0);
    expect(r.refundToBalanceCny).toBe(9_000);
  });

  it('改期费超过实收（异常数据）→ 可退基数夹到 0，绝不算出负应退', () => {
    const r = computeRefundBreakdown({
      paidAmount: 100,
      prepaymentOffsetCny: 0,
      adjustmentCny: 5_000,
      grossItems: [grossItem(10_000, 20)],
    });
    expect(r.refundableBaseCny).toBe(0);
    expect(r.totalRefund).toBe(0);
    expect(r.refundToCashCny).toBe(0);
    expect(r.refundToBalanceCny).toBe(0);
  });
});

describe('splitRefundBetweenCashAndBalance · 现金优先且两段互斥', () => {
  it('应退 ≤ 可退现金 → 全走现金', () => {
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 500,
        paidAmount: 2_000,
        adjustmentCny: 0,
        prepaymentOffsetCny: 3_000,
      }),
    ).toEqual({ refundToCashCny: 500, refundToBalanceCny: 0 });
  });

  it('无现金可退 → 全回余额', () => {
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 800,
        paidAmount: 0,
        adjustmentCny: 0,
        prepaymentOffsetCny: 1_000,
      }),
    ).toEqual({ refundToCashCny: 0, refundToBalanceCny: 800 });
  });

  it('余额侧被 prepaymentOffset 硬夹：抵扣过 0 就绝不回补余额', () => {
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 800,
        paidAmount: 0,
        adjustmentCny: 0,
        prepaymentOffsetCny: 0,
      }),
    ).toEqual({ refundToCashCny: 0, refundToBalanceCny: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 可取消状态集合
// ══════════════════════════════════════════════════════════════════════════
describe('CANCELLABLE_STATUSES · 出票失败单必须能走退款', () => {
  it('FAILED 在集合内 —— 出票失败恰是最该退款的场景', () => {
    // 漏放的后果：这类单只能靠 ADMIN 手动 PATCH 状态硬推 REFUNDED（不生成 Refund、
    // 不算退改费），账目当场分叉。
    expect(CANCELLABLE_STATUSES.has('FAILED')).toBe(true);
  });

  it('占座态与改期态照旧可取消', () => {
    for (const s of ['PAID', 'PROCESSING', 'TICKETED', 'CHANGE_REQUESTED', 'CHANGED']) {
      expect(CANCELLABLE_STATUSES.has(s), `${s} 应可取消`).toBe(true);
    }
  });

  it('已终结 / 未付款的单不走退款取消', () => {
    // PENDING_PAYMENT 走另一条路（直接释放座位 + 0 费用）；其余是终态或草稿。
    for (const s of ['DRAFT', 'PENDING_PAYMENT', 'PAYMENT_TIMEOUT', 'CANCELLED', 'REFUNDED', 'REFUND_REQUESTED', 'COMPLETED']) {
      expect(CANCELLABLE_STATUSES.has(s), `${s} 不应可取消`).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 现金 / 余额拆分：流水口径 offsetGrossCny（报价与落库同源）
// ══════════════════════════════════════════════════════════════════════════
describe('splitRefundBetweenCashAndBalance · offsetGrossCny（余额抵扣已内含在 paidAmount 里）', () => {
  it('全额余额抵付单：paidAmount 全是抵扣 → 应退全部回余额，现金侧 0', () => {
    // 旧口径（读恒为 0 的 Order.prepaymentOffset）会算成「全退现金」，
    // 而落 REFUNDED 的执行侧按流水回补余额 —— 报价与落库当场分叉。
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 8_000,
        paidAmount: 8_000,
        adjustmentCny: 0,
        prepaymentOffsetCny: 0,
        offsetGrossCny: 8_000,
      }),
    ).toEqual({ refundToCashCny: 0, refundToBalanceCny: 8_000 });
  });

  it('半现金半余额：现金优先退，退不下的部分回余额', () => {
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 9_000,
        paidAmount: 10_000, // 其中 4000 是余额抵扣
        adjustmentCny: 0,
        prepaymentOffsetCny: 0,
        offsetGrossCny: 4_000,
      }),
    ).toEqual({ refundToCashCny: 6_000, refundToBalanceCny: 3_000 });
  });

  it('改期费先从现金里消耗：压低现金上限，溢出的部分回余额', () => {
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 6_000,
        paidAmount: 10_000, // 其中 4000 是余额抵扣 → 真现金 6000
        adjustmentCny: 1_000, // 现金上限降到 5000
        prepaymentOffsetCny: 0,
        offsetGrossCny: 4_000,
      }),
    ).toEqual({ refundToCashCny: 5_000, refundToBalanceCny: 1_000 });
  });

  it('余额侧绝不超过当初抵扣掉的毛额（防凭空造币）', () => {
    expect(
      splitRefundBetweenCashAndBalance({
        totalRefund: 10_000,
        paidAmount: 3_000,
        adjustmentCny: 0,
        prepaymentOffsetCny: 0,
        offsetGrossCny: 3_000,
      }),
    ).toEqual({ refundToCashCny: 0, refundToBalanceCny: 3_000 });
  });

  it('缺省 offsetGrossCny → 与旧版逐位一致（无余额抵扣的单不受本次改动影响）', () => {
    const legacy = splitRefundBetweenCashAndBalance({
      totalRefund: 700,
      paidAmount: 1_000,
      adjustmentCny: 200,
      prepaymentOffsetCny: 0,
    });
    expect(legacy).toEqual({ refundToCashCny: 700, refundToBalanceCny: 0 });
  });
});

describe('computeRefundBreakdown · offsetGrossCny 只改拆分、不改可退基数', () => {
  it('余额抵扣不再被加进可退基数（paidAmount 已含它，加第二次＝放宽退款上限）', () => {
    const r = computeRefundBreakdown({
      paidAmount: 10_000, // 现金 6000 + 余额抵扣 4000
      prepaymentOffsetCny: 0,
      offsetGrossCny: 4_000,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 0)],
    });
    expect(r.refundableBaseCny).toBe(10_000);
    expect(r.totalRefund).toBe(10_000);
    expect(r.refundToCashCny).toBe(6_000);
    expect(r.refundToBalanceCny).toBe(4_000);
    expect(r.offsetGrossCny).toBe(4_000);
  });

  it('手续费口径不受影响：拆分变了，扣多少费不变', () => {
    const withOffset = computeRefundBreakdown({
      paidAmount: 10_000,
      prepaymentOffsetCny: 0,
      offsetGrossCny: 4_000,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 30)],
    });
    const withoutOffset = computeRefundBreakdown({
      paidAmount: 10_000,
      prepaymentOffsetCny: 0,
      adjustmentCny: 0,
      grossItems: [grossItem(10_000, 30)],
    });
    expect(withOffset.totalFee).toBe(withoutOffset.totalFee);
    expect(withOffset.totalRefund).toBe(withoutOffset.totalRefund);
    // 差别只在拆分：现金优先，应退 7000 先退满真现金 6000，余下 1000 回余额
    expect(withOffset.refundToCashCny).toBe(6_000);
    expect(withOffset.refundToBalanceCny).toBe(1_000);
    expect(withoutOffset.refundToBalanceCny).toBe(0);
  });
});
