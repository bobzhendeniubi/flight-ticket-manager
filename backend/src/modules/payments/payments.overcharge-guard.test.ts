/**
 * 收款防重两闸 · 纯函数单测（vitest，不依赖 DB）
 *
 * 覆盖两个判定内核：
 *   - wouldOvercharge：超收硬闸（累计已付净额 + 预存抵扣 是否超过应收）
 *   - findDuplicateManualPayment：同额防呆软闸（近 10 分钟等额手工收款）
 *
 * 全链路行为（confirmManualPayment 事务内落库 + 状态翻转）由集成测试覆盖，这里只锁判定口径。
 */
import { describe, it, expect } from 'vitest';
import { wouldOvercharge, findDuplicateManualPayment } from './payments.service.js';

describe('wouldOvercharge · 超收硬闸判定', () => {
  const base = { effectivePayable: 1000, alreadyPaid: 0, prepaymentOffset: 0, refundedTotal: 0 };

  it('正常分次凑单不拦：先付 400（0+400≤1000）', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 0, amount: 400 })).toBe(false);
  });

  it('凑到恰好收满不拦：已付 400，再付 600 = 1000（等于应收，含容差）', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 400, amount: 600 })).toBe(false);
  });

  it('收满后再录被拦：已付 1000，再录 1 → 超出应收', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 1000, amount: 1 })).toBe(true);
  });

  it('单笔一次性超收被拦：应收 1000，一次录 1200', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 0, amount: 1200 })).toBe(true);
  });

  it('一分钱容差内不拦：应收 1000，恰好录 1000.005（浮点毛刺）', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 0, amount: 1000.005 })).toBe(false);
  });

  it('应收含调整行（改期费）：payable 1300，已付 1000，再录 300 = 1300 不拦', () => {
    expect(wouldOvercharge({ effectivePayable: 1300, alreadyPaid: 1000, prepaymentOffset: 0, refundedTotal: 0, amount: 300 })).toBe(false);
  });

  it('预存抵扣视同已付：payable 1000，预存 400，已付 600 后再录 1 → 600+1+400 > 1000 被拦', () => {
    expect(wouldOvercharge({ effectivePayable: 1000, alreadyPaid: 600, prepaymentOffset: 400, refundedTotal: 0, amount: 1 })).toBe(true);
  });

  it('退款腾出额度：已付 1000（收满），已退 300 → 净额 700，可再收 300 不拦', () => {
    expect(wouldOvercharge({ effectivePayable: 1000, alreadyPaid: 1000, prepaymentOffset: 0, refundedTotal: 300, amount: 300 })).toBe(false);
  });

  it('退款后再超收仍拦：已付 1000，已退 300 → 可再收 300；录 301 被拦', () => {
    expect(wouldOvercharge({ effectivePayable: 1000, alreadyPaid: 1000, prepaymentOffset: 0, refundedTotal: 300, amount: 301 })).toBe(true);
  });
});

describe('findDuplicateManualPayment · 同额防呆判定', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it('近 10 分钟内等额 → 命中（返回已有记录）', () => {
    const hit = findDuplicateManualPayment(
      1000,
      [{ id: 'p1', amount: 1000, createdAt: minutesAgo(3) }],
      now,
    );
    expect(hit?.id).toBe('p1');
  });

  it('金额不等 → 不命中', () => {
    const hit = findDuplicateManualPayment(
      1000,
      [{ id: 'p1', amount: 900, createdAt: minutesAgo(3) }],
      now,
    );
    expect(hit).toBeNull();
  });

  it('超出时间窗（>10 分钟前）→ 不命中', () => {
    const hit = findDuplicateManualPayment(
      1000,
      [{ id: 'p1', amount: 1000, createdAt: minutesAgo(11) }],
      now,
    );
    expect(hit).toBeNull();
  });

  it('一分钱容差内视为等额 → 命中', () => {
    const hit = findDuplicateManualPayment(
      1000,
      [{ id: 'p1', amount: 1000.005, createdAt: minutesAgo(1) }],
      now,
    );
    expect(hit?.id).toBe('p1');
  });

  it('空历史 → 不命中', () => {
    expect(findDuplicateManualPayment(1000, [], now)).toBeNull();
  });
});
