/**
 * 收款判定内核 · 纯函数单测（vitest，不依赖 DB）
 *
 * 覆盖判定内核：
 *   - wouldOvercharge：是否超出应收（累计已付净额 + 预存抵扣 是否超过应收）
 *   - splitOverpayment：超收拆分（应收部分核销进订单 / 超出部分转挂账池）
 *   - findDuplicateManualPayment：同额防呆软闸（近 10 分钟等额手工收款）
 *   - idempotentReplayMismatch：幂等回放前的请求指纹校验（撞键 ≠ 重放）
 *   - findDuplicateOrderIds：同一批次里重复的订单
 *   - cnyAmountSchema：金额入参到分为止（三位小数拒收）
 *
 * 全链路行为（confirmManualPayment 事务内落库 + 建挂账进账 + 状态翻转）由集成测试覆盖，
 * 这里只锁判定口径。
 */
import { describe, it, expect } from 'vitest';
import { PaymentMethod } from '@prisma/client';
import {
  wouldOvercharge,
  splitOverpayment,
  findDuplicateManualPayment,
  idempotentReplayMismatch,
  buildBatchIdempotencyKeys,
} from './payments.service.js';
import { cnyAmountSchema } from './payments.schemas.js';

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

  it('浮点毛刺不拦：应收 1000，已付 0.1+0.2（二进制相加有毛刺）再收 999.7 = 恰好收满', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 0.1 + 0.2, amount: 999.7 })).toBe(false);
  });

  it('精确多收一分也拦：应收 1000，一次录 1000.01', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 0, amount: 1000.01 })).toBe(true);
  });

  it('收满后再录一分也拦：已付 1000，再录 0.01', () => {
    expect(wouldOvercharge({ ...base, alreadyPaid: 1000, amount: 0.01 })).toBe(true);
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

  it('浮点毛刺不拆：应收 1000、已付 0.1+0.2，再收 999.7 → 整笔进订单', () => {
    expect(splitOverpayment({ ...base, alreadyPaid: 0.1 + 0.2, amount: 999.7 })).toEqual({
      creditAmount: 999.7,
      poolAmount: 0,
    });
  });

  it('多收一分也拆：应收 1000 一次收 1000.01 → 1000 进订单、0.01 进池（绝不让它记成账面多付）', () => {
    expect(splitOverpayment({ ...base, amount: 1000.01 })).toEqual({
      creditAmount: 1000,
      poolAmount: 0.01,
    });
  });

  it('收满后再收一分 → 整笔 0.01 进池，订单一分不动', () => {
    expect(splitOverpayment({ ...base, alreadyPaid: 1000, amount: 0.01 })).toEqual({
      creditAmount: 0,
      poolAmount: 0.01,
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

describe('idempotentReplayMismatch · 幂等回放前的请求指纹', () => {
  const original = {
    originalOrderId: 'order-A',
    originalAmount: 1000,
    originalMethod: PaymentMethod.BANK_CARD,
  };

  it('同单同额同方式 → 是真重放，放行回放', () => {
    expect(
      idempotentReplayMismatch({
        ...original,
        requestedOrderId: 'order-A',
        requestedAmount: 1000,
        requestedMethod: PaymentMethod.BANK_CARD,
      }),
    ).toBeNull();
  });

  it('换了订单 → 撞键，不是重放', () => {
    expect(
      idempotentReplayMismatch({
        ...original,
        requestedOrderId: 'order-B',
        requestedAmount: 1000,
        requestedMethod: PaymentMethod.BANK_CARD,
      }),
    ).toMatch(/另一张订单/);
  });

  it('金额不同 → 是另一笔钱，不是重放', () => {
    expect(
      idempotentReplayMismatch({
        ...original,
        requestedOrderId: 'order-A',
        requestedAmount: 800,
        requestedMethod: PaymentMethod.BANK_CARD,
      }),
    ).toMatch(/¥1000\.00/);
  });

  it('收款方式不同 → 不是同一笔钱', () => {
    expect(
      idempotentReplayMismatch({
        ...original,
        requestedOrderId: 'order-A',
        requestedAmount: 1000,
        requestedMethod: PaymentMethod.WECHAT_PAY,
      }),
    ).toBeTruthy();
  });

  it('金额省略（按尾款自动取数）→ 无从比对，只比订单与方式', () => {
    expect(
      idempotentReplayMismatch({
        ...original,
        requestedOrderId: 'order-A',
        requestedMethod: PaymentMethod.BANK_CARD,
      }),
    ).toBeNull();
  });

  it('浮点毛刺内的金额差视为同一笔 → 仍是重放', () => {
    expect(
      idempotentReplayMismatch({
        ...original,
        originalAmount: 0.1 + 0.2,
        requestedOrderId: 'order-A',
        requestedAmount: 0.3,
        requestedMethod: PaymentMethod.BANK_CARD,
      }),
    ).toBeNull();
  });
});

describe('buildBatchIdempotencyKeys · 批量到账逐行幂等键', () => {
  it('不传 batchId → 全部 undefined（不做批量去重，等价旧行为）', () => {
    expect(buildBatchIdempotencyKeys(undefined, ['a', 'b'])).toEqual([undefined, undefined]);
  });

  it('各行订单不同 → 老格式 batch:{batchId}:{orderId}，重放键不变', () => {
    expect(buildBatchIdempotencyKeys('B1', ['a', 'b'])).toEqual(['batch:B1:a', 'batch:B1:b']);
  });

  it('同一订单出现多行 → 各行各有各的 key（第二行绝不撞第一行）', () => {
    const keys = buildBatchIdempotencyKeys('B1', ['a', 'b', 'a', 'a']);
    expect(keys).toEqual(['batch:B1:a', 'batch:B1:b', 'batch:B1:a#1', 'batch:B1:a#2']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('同一批次重复提交 → 逐行拿到同一把 key（重放才认得出来）', () => {
    const items = ['a', 'b', 'a'];
    expect(buildBatchIdempotencyKeys('B1', items)).toEqual(
      buildBatchIdempotencyKeys('B1', items),
    );
  });
});

describe('cnyAmountSchema · 金额入参到分为止', () => {
  it('两位小数放行', () => {
    expect(cnyAmountSchema.parse(1000.01)).toBe(1000.01);
  });

  it('整数与一位小数放行', () => {
    expect(cnyAmountSchema.parse(1000)).toBe(1000);
    expect(cnyAmountSchema.parse(0.1)).toBe(0.1);
  });

  it('三位小数拒收（落库会被四舍五入成半分差）', () => {
    const r = cnyAmountSchema.safeParse(1000.005);
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0].message).toMatch(/两位小数/);
  });

  it('更细的小数同样拒收', () => {
    expect(cnyAmountSchema.safeParse(0.129).success).toBe(false);
  });

  it('0 与负数拒收', () => {
    expect(cnyAmountSchema.safeParse(0).success).toBe(false);
    expect(cnyAmountSchema.safeParse(-10).success).toBe(false);
  });
});
