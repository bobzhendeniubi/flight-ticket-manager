import { describe, expect, it } from 'vitest';
import {
  fmtRefundCny,
  readRefundSplit,
  refundApprovalUnknownWarning,
  refundApprovalWarning,
} from './refundSplit';

describe('readRefundSplit', () => {
  it('原样读出后端三个金额，不做任何二次运算', () => {
    // Arrange：后端口径 9000 = 现金 4000 + 余额 5000
    const quote = { totalRefund: 9000, refundToCashCny: 4000, refundToBalanceCny: 5000 };

    // Act
    const split = readRefundSplit(quote);

    // Assert
    expect(split).toEqual({
      available: true,
      totalRefundCny: 9000,
      refundToCashCny: 4000,
      refundToBalanceCny: 5000,
      hasBalanceRefund: true,
    });
  });

  it('余额部分为 0（散客单/未用余额抵扣）时 hasBalanceRefund 为 false', () => {
    const split = readRefundSplit({ totalRefund: 3000, refundToCashCny: 3000, refundToBalanceCny: 0 });
    expect(split.available).toBe(true);
    expect(split.available && split.hasBalanceRefund).toBe(false);
  });

  it('全额余额抵扣单：现金 0、全部回余额', () => {
    const split = readRefundSplit({ totalRefund: 8000, refundToCashCny: 0, refundToBalanceCny: 8000 });
    expect(split.available && split.refundToCashCny).toBe(0);
    expect(split.available && split.hasBalanceRefund).toBe(true);
  });

  it('后端未下发拆分字段时返回不可用，绝不用减法补算现金部分', () => {
    // Arrange：老后端只有 totalRefund
    const legacy = { totalRefund: 9000 } as unknown as Parameters<typeof readRefundSplit>[0];

    // Act
    const split = readRefundSplit(legacy);

    // Assert：只保留合计，没有任何 refundToCashCny
    expect(split).toEqual({ available: false, totalRefundCny: 9000 });
  });

  it('拆分字段是 NaN / null 等非法值时同样视为不可用', () => {
    expect(readRefundSplit({ totalRefund: 100, refundToCashCny: NaN, refundToBalanceCny: 0 }).available).toBe(false);
    expect(
      readRefundSplit({ totalRefund: 100, refundToCashCny: null as unknown as number, refundToBalanceCny: 0 }).available,
    ).toBe(false);
  });

  it('报价整体缺失（未加载/请求失败）时返回不可用且合计为 null', () => {
    expect(readRefundSplit(null)).toEqual({ available: false, totalRefundCny: null });
    expect(readRefundSplit(undefined)).toEqual({ available: false, totalRefundCny: null });
  });
});

describe('refundApprovalWarning', () => {
  it('有余额回补时给出三行拆分与「勿重复打款」提示', () => {
    const split = readRefundSplit({ totalRefund: 9000, refundToCashCny: 4000, refundToBalanceCny: 5000 });
    const text = refundApprovalWarning('ORD-20260820-001', split);

    expect(text).toContain('ORD-20260820-001');
    expect(text).toContain('应退合计 ¥9,000');
    expect(text).toContain('退现金 ¥4,000');
    expect(text).toContain('退回代理预存余额 ¥5,000');
    expect(text).toContain('请勿按应退合计重复退钱');
  });

  it('余额部分为 0 时不弹额外确认（绝大多数单，不给日常操作添噪音）', () => {
    const split = readRefundSplit({ totalRefund: 3000, refundToCashCny: 3000, refundToBalanceCny: 0 });
    expect(refundApprovalWarning('ORD-1', split)).toBeNull();
  });

  it('拆分不可用时不冒充确认文案（交给 unknown 分支处理）', () => {
    expect(refundApprovalWarning('ORD-1', { available: false, totalRefundCny: 9000 })).toBeNull();
  });
});

describe('refundApprovalUnknownWarning', () => {
  it('读不到拆分时如实说明风险并带上错误原因', () => {
    const text = refundApprovalUnknownWarning('ORD-2', '网络错误');
    expect(text).toContain('ORD-2');
    expect(text).toContain('网络错误');
    expect(text).toContain('重复退钱');
  });
});

describe('fmtRefundCny', () => {
  it('整数不带小数，有零头保留两位', () => {
    expect(fmtRefundCny(9000)).toBe('¥9,000');
    expect(fmtRefundCny(4000.5)).toBe('¥4,000.5');
    expect(fmtRefundCny(0)).toBe('¥0');
  });
});
