/**
 * 订单金额单一口径 · 单元测试（vitest）
 *
 * 黄金测试（order-money.golden*.test.ts）钉的是「各调用点算出来的数」；本文件钉的是口径函数
 * 自身的三件事：
 *   1. 各基元的等价关系（尾款按元 vs 按分、两种清账、两种人均、两种已收减已退）——
 *      **该相等的相等，该不等的不等**：不等的就是待拍板冲突，测试把差异钉成数字，不许谁悄悄统一；
 *   2. 计佣基数与 orders.service 计佣落库内联算法同式（文档例子逐分对拍）；
 *   3. 三个 perPax* 从 export-templates 搬到这里后，那边的 re-export 与这里是同一个函数对象。
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma, OrderItemKind } from '@prisma/client';

// export-templates → orders.service 顶层引用 prisma —— mock 掉（与黄金测试同款）
vi.mock('../db/prisma.js', () => ({ prisma: {} }));

import {
  balanceDueCents,
  balanceDueCny,
  balanceDueDecimal,
  commissionBaseForItemCny,
  completedRefundTotalCny,
  computeCommissionBase,
  evenShareCny,
  grossTotalCny,
  isSettledByNetReceived,
  isSettledByPaidAmount,
  netReceivedCny,
  outstandingRawCny,
  paidCny,
  paidMinusCompletedRefundsCny,
  paidWithOffsetCny,
  payableCny,
  payablePerPaxCny,
  perPaxSettlementByPassenger,
  perPaxSingleRoomDiffByPassenger,
  perPaxVisaAmountByPassenger,
  receivableBalanceCny,
  settlementDiscountTotalCny,
  settlePerPaxFallbackCny,
  spreadablePayableRawCny,
  toCents,
  toCny,
} from './order-money.js';
import * as templates from '../modules/orders/orders.export-templates.js';
import {
  allFixtures,
  completedRefunds,
  fixtureMultiPax,
  fixtureRefundedFull,
  fixtureRefundedPartial,
  fixtureSwapped,
} from './order-money.golden.fixtures.js';

const Dec = (n: number | string) => new Prisma.Decimal(n);

describe('order-money · 基元', () => {
  it('toCny：Decimal / number / 空值', () => {
    expect(toCny(Dec('3333.33'))).toBe(3333.33);
    expect(toCny(12)).toBe(12);
    expect(toCny(null)).toBe(0);
    expect(toCny(undefined)).toBe(0);
  });

  it('toCents：与 receipt-matching.toCents 同式（Decimal / string / number / 非有限数）', () => {
    expect(toCents(Dec('1000.01'))).toBe(100001);
    expect(toCents('4618')).toBe(461800);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(Number.NaN)).toBe(0);
    expect(toCents(null)).toBe(0);
  });

  it('evenShareCny：两位小数', () => {
    expect(evenShareCny(10000, 3)).toBe(3333.33);
    expect(evenShareCny(0, 4)).toBe(0);
  });
});

describe('order-money · 应收 / 已付 / 尾款（六张夹具单）', () => {
  it('应收 = round2(total + adjustmentCny)；订单总额不含售后费', () => {
    const f3 = fixtureSwapped();
    expect(grossTotalCny(f3)).toBe(8100);
    expect(payableCny(f3)).toBe(8750);
    expect(payableCny({ total: Dec('3333.33') })).toBe(3333.33);
  });

  it('已付原样 / 已付含抵扣', () => {
    const f2 = fixtureRefundedPartial();
    expect(paidCny(f2)).toBe(6300);
    expect(paidWithOffsetCny(f2)).toBe(6800);
    expect(paidWithOffsetCny({ paidAmount: Dec(10) })).toBe(10);
  });

  it('尾款按元 与 按分 在两位小数输入下同值（认款建议 vs 对账台候选 vs 列表 DTO 三处同源）', () => {
    for (const o of allFixtures()) {
      expect(balanceDueCents(o)).toBe(Math.round(balanceDueCny(o) * 100));
      expect(balanceDueDecimal(o).toNumber()).toBe(balanceDueCny(o));
    }
  });

  it('尾款有符号：F2 多付 −500；未收尾款钳零：F2 → 0，F1 → 4618', () => {
    const f2 = fixtureRefundedPartial();
    expect(balanceDueCny(f2)).toBe(-500);
    expect(outstandingRawCny(f2)).toBe(0);
    expect(outstandingRawCny(fixtureMultiPax())).toBe(4618);
  });
});

describe('order-money · 待拍板冲突：同一个词、两个数（钉住差异，不许统一）', () => {
  it('是否清账 · 按已付 vs 按已收净额：F2（先收 6300+抵扣 500，后退 1000）一个「是」一个「否」', () => {
    const f2 = fixtureRefundedPartial();
    expect(isSettledByPaidAmount(f2)).toBe(true);
    expect(isSettledByNetReceived(f2, completedRefunds(f2))).toBe(false);
    // 没退过款的单两种算法一致
    const f1 = fixtureMultiPax();
    expect(isSettledByPaidAmount(f1)).toBe(false);
    expect(isSettledByNetReceived(f1, completedRefunds(f1))).toBe(false);
    const f3 = fixtureSwapped();
    expect(isSettledByPaidAmount(f3)).toBe(true);
    expect(isSettledByNetReceived(f3, completedRefunds(f3))).toBe(true);
  });

  it('已收减已退 · 含抵扣（net-received） vs 不含抵扣（财务概览负项）：F2 差一个 prepaymentOffset', () => {
    const f2 = fixtureRefundedPartial();
    expect(netReceivedCny(f2, completedRefunds(f2))).toBe(5800);
    expect(paidMinusCompletedRefundsCny(f2, completedRefunds(f2))).toBe(5300);
    // 抵扣为 0 的单两者相同（现状全库抵扣恒 0，所以线上数字今天是一样的）
    const f4 = fixtureRefundedFull();
    expect(netReceivedCny(f4, completedRefunds(f4))).toBe(300);
    expect(paidMinusCompletedRefundsCny(f4, completedRefunds(f4))).toBe(300);
  });

  it('尾款 vs 应收余额：没退款时同一个数，退过款的单差 Σ已完成退款', () => {
    const f1 = fixtureMultiPax();
    expect(receivableBalanceCny(f1, completedRefunds(f1))).toBe(balanceDueCny(f1));
    const f2 = fixtureRefundedPartial();
    expect(balanceDueCny(f2)).toBe(-500);
    expect(receivableBalanceCny(f2, completedRefunds(f2))).toBe(500);
  });

  it('人均结算价 · 应收÷人数（代理对账单） vs 可摊应收÷人数（导出兜底）：F3 换人费 450 一边摊一边不摊', () => {
    const f3 = fixtureSwapped();
    expect(payablePerPaxCny(f3, 3)).toBe(2916.67);
    expect(settlePerPaxFallbackCny(f3, 3)).toBe(2766.67);
    expect(spreadablePayableRawCny(f3)).toBe(8300);
    // 没有 excludeFromPerPax 流水的单两者相同
    const f1 = fixtureMultiPax();
    expect(payablePerPaxCny(f1, 4)).toBe(settlePerPaxFallbackCny(f1, 4));
  });
});

describe('order-money · 退款 / 立减合计', () => {
  it('completedRefundTotalCny 只数 COMPLETED，且不四舍五入（调用方再均摊）', () => {
    const f2 = fixtureRefundedPartial();
    expect(completedRefundTotalCny(f2.refunds)).toBe(1000);
    expect(completedRefundTotalCny(null)).toBe(0);
    expect(completedRefundTotalCny([{ amount: Dec('0.1'), status: 'COMPLETED' }, { amount: Dec('0.2'), status: 'COMPLETED' }]))
      .toBe(0.1 + 0.2);
  });

  it('settlementDiscountTotalCny：只认未撤销的立减快照行，取绝对值，不四舍五入', () => {
    expect(settlementDiscountTotalCny(fixtureMultiPax().items)).toBe(1032);
    expect(
      settlementDiscountTotalCny([
        { amount: Dec(-100), metadata: { settlementDiscount: true } },
        { amount: Dec(-50), metadata: { settlementDiscount: true, settlementDiscountRevoked: true } },
        { amount: Dec(-7), metadata: { priceAdjustment: true } },
        { amount: Dec(-1), metadata: null },
        { amount: Dec(-1), metadata: [1] },
      ]),
    ).toBe(100);
  });
});

describe('order-money · 计佣基数（与 orders.service 计佣落库内联算法同式）', () => {
  it('文档例子：BUNDLE 450 + FLIGHT 800 + FLIGHT 1000 + DISCOUNT −1032 → 243.60 / 433.07 / 541.33', () => {
    const items = [
      { kind: OrderItemKind.BUNDLE, amount: Dec(450) },
      { kind: OrderItemKind.FLIGHT, amount: Dec(800) },
      { kind: OrderItemKind.FLIGHT, amount: Dec(1000) },
      { kind: OrderItemKind.DISCOUNT, amount: Dec(-1032) },
      // 不进分母也不计提的行
      { kind: OrderItemKind.FEE, amount: Dec(120) },
      { kind: OrderItemKind.INSURANCE, amount: Dec(30) },
    ];
    const base = computeCommissionBase(items);
    expect(base).toEqual({
      grossCommissionableCny: 2250,
      discountTotalCny: -1032,
      netCommissionableCny: 1218,
      discountRatio: 1218 / 2250,
    });
    expect(commissionBaseForItemCny(Dec(450), base.discountRatio)).toBe(243.6);
    expect(commissionBaseForItemCny(Dec(800), base.discountRatio)).toBe(433.07);
    expect(commissionBaseForItemCny(Dec(1000), base.discountRatio)).toBe(541.33);
  });

  it('无折扣 ratio=1 基数=毛额；折扣吃光 / 只有折扣行 → ratio=0', () => {
    expect(computeCommissionBase([{ kind: OrderItemKind.HOTEL, amount: Dec(999.99) }]).discountRatio).toBe(1);
    expect(computeCommissionBase([
      { kind: OrderItemKind.VISA, amount: Dec(240) },
      { kind: OrderItemKind.DISCOUNT, amount: Dec(-300) },
    ])).toEqual({ grossCommissionableCny: 240, discountTotalCny: -300, netCommissionableCny: 0, discountRatio: 0 });
    expect(computeCommissionBase([{ kind: OrderItemKind.DISCOUNT, amount: Dec(-10) }]).discountRatio).toBe(0);
  });
});

describe('order-money · perPax* 搬家后 export-templates 的 re-export 是同一个函数', () => {
  it('三个函数对象恒等', () => {
    expect(templates.perPaxSettlementByPassenger).toBe(perPaxSettlementByPassenger);
    expect(templates.perPaxVisaAmountByPassenger).toBe(perPaxVisaAmountByPassenger);
    expect(templates.perPaxSingleRoomDiffByPassenger).toBe(perPaxSingleRoomDiffByPassenger);
  });
});
