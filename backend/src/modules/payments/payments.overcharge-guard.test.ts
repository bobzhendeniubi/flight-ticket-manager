/**
 * 收款判定内核 · 纯函数单测（vitest，不依赖 DB）
 *
 * 覆盖三个判定内核：
 *   - wouldOvercharge：是否超出应收（累计已付净额 + 预存抵扣 是否超过应收）
 *   - splitOverpayment：超收拆分（应收部分核销进订单 / 超出部分转挂账池）
 *   - findDuplicateManualPayment：同额防呆软闸（近 10 分钟等额手工收款）
 *
 * 全链路行为（confirmManualPayment 事务内落库 + 建挂账进账 + 状态翻转）由集成测试覆盖，
 * 这里只锁判定口径。
 */
import { describe, it, expect } from 'vitest';
import {
  wouldOvercharge,
  splitOverpayment,
  findDuplicateManualPayment,
} from './payments.service.js';

describe('wouldOvercharge · 是否超出应收', () => {
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

describe('splitOverpayment · 超收拆分口径', () => {
  const base = { effectivePayable: 1000, alreadyPaid: 0, prepaymentOffset: 0, refundedTotal: 0 };

  it('刚好收满：应收 1000 一次收 1000 → 整笔进订单，不拆', () => {
    expect(splitOverpayment({ ...base, amount: 1000 })).toEqual({
      creditAmount: 1000,
      poolAmount: 0,
    });
  });

  it('分次凑到收满：已付 400 再收 600 → 整笔进订单，不拆', () => {
    expect(splitOverpayment({ ...base, alreadyPaid: 400, amount: 600 })).toEqual({
      creditAmount: 600,
      poolAmount: 0,
    });
  });

  it('超收拆两笔：应收 1000 一次收 1200 → 1000 进订单、200 进池', () => {
    expect(splitOverpayment({ ...base, amount: 1200 })).toEqual({
      creditAmount: 1000,
      poolAmount: 200,
    });
  });

  it('部分已付后超收：已付 700、再收 500 → 300 进订单、200 进池', () => {
    expect(splitOverpayment({ ...base, alreadyPaid: 700, amount: 500 })).toEqual({
      creditAmount: 300,
      poolAmount: 200,
    });
  });

  it('应收已为 0（已收满）→ 整笔进池，一分不记订单', () => {
    expect(splitOverpayment({ ...base, alreadyPaid: 1000, amount: 800 })).toEqual({
      creditAmount: 0,
      poolAmount: 800,
    });
  });

  it('一分钱容差：应收 1000 收 1000.005（浮点毛刺）→ 不拆，绝不生成几厘钱的挂账进账', () => {
    expect(splitOverpayment({ ...base, amount: 1000.005 })).toEqual({
      creditAmount: 1000.01,
      poolAmount: 0,
    });
  });

  it('应收含售后调整行：payable 1300、已付 1000，收 500 → 300 进订单、200 进池', () => {
    expect(
      splitOverpayment({
        effectivePayable: 1300,
        alreadyPaid: 1000,
        prepaymentOffset: 0,
        refundedTotal: 0,
        amount: 500,
      }),
    ).toEqual({ creditAmount: 300, poolAmount: 200 });
  });

  it('预存抵扣视同已付：payable 1000、预存 400、已付 600，再收 300 → 整笔进池', () => {
    expect(
      splitOverpayment({
        effectivePayable: 1000,
        alreadyPaid: 600,
        prepaymentOffset: 400,
        refundedTotal: 0,
        amount: 300,
      }),
    ).toEqual({ creditAmount: 0, poolAmount: 300 });
  });

  it('退款腾出额度：已付 1000、已退 300，再收 500 → 300 进订单、200 进池', () => {
    expect(
      splitOverpayment({
        effectivePayable: 1000,
        alreadyPaid: 1000,
        prepaymentOffset: 0,
        refundedTotal: 300,
        amount: 500,
      }),
    ).toEqual({ creditAmount: 300, poolAmount: 200 });
  });

  it('守恒：任何拆法两半之和都等于到账全额（含两位小数）', () => {
    const cases = [
      { ...base, amount: 1200 },
      { ...base, alreadyPaid: 999.99, amount: 0.02 },
      { ...base, alreadyPaid: 333.33, amount: 1000.01 },
      { ...base, alreadyPaid: 1000, amount: 0.01 },
    ];
    for (const c of cases) {
      const { creditAmount, poolAmount } = splitOverpayment(c);
      expect(Math.round((creditAmount + poolAmount) * 100) / 100).toBe(
        Math.round(c.amount * 100) / 100,
      );
    }
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
