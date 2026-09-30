import { describe, expect, it } from 'vitest';
import { matchSwapForAdjustment, swapAdjustmentTitle, type SwapHistoryLite } from './swapFeeLine';

const FEE = {
  type: 'SWAP_FEE',
  label: '换人费',
  at: '2026-09-30T02:00:01.000Z', // 北京时间 09-30 10:00
  passengerName: 'QIN/XUE',
  passengerDocument: 'E111',
};

const SWAP: SwapHistoryLite = {
  kind: 'SWAP',
  at: '2026-09-30T02:00:03.000Z', // 审计在换人事务提交后写，晚几秒
  beforeName: 'QIN/XUE',
  beforeDoc: 'E111',
  afterName: 'YANG/LIN',
};

describe('swapAdjustmentTitle（售后费用区换人费行）', () => {
  it('对上换人审计：原 → 新 + 日期（北京时间）', () => {
    expect(swapAdjustmentTitle(FEE, [SWAP])).toBe('换人费（原 QIN/XUE → 新 YANG/LIN，09-30）');
  });

  it('换人差价同样补原 → 新', () => {
    expect(swapAdjustmentTitle({ ...FEE, type: 'SWAP_PRICE_DIFF', label: '换人差价' }, [SWAP])).toBe(
      '换人差价（原 QIN/XUE → 新 YANG/LIN，09-30）',
    );
  });

  it('审计读不到（空历史）：只写旧人与日期，不臆造新人', () => {
    expect(swapAdjustmentTitle(FEE, [])).toBe('换人费（原 QIN/XUE，09-30）');
  });

  it('很早的流水没记旧人：只写日期', () => {
    expect(swapAdjustmentTitle({ ...FEE, passengerName: undefined }, [SWAP])).toBe('换人费（09-30）');
  });

  it('非换人类流水返回 null，调用方沿用原展示', () => {
    expect(swapAdjustmentTitle({ ...FEE, type: 'RESCHEDULE_FEE', label: '改期费' }, [SWAP])).toBeNull();
  });

  it('日期跨北京时间零点：UTC 16:30 落到次日', () => {
    const late = { ...FEE, at: '2026-09-29T16:30:00.000Z' };
    const swap = { ...SWAP, at: '2026-09-29T16:30:02.000Z' };
    expect(swapAdjustmentTitle(late, [swap])).toBe('换人费（原 QIN/XUE → 新 YANG/LIN，09-30）');
  });
});

describe('matchSwapForAdjustment', () => {
  it('同一位旧人换过两次：取时间最近的那次', () => {
    const later: SwapHistoryLite = { ...SWAP, at: '2026-09-30T02:10:00.000Z', afterName: 'ZHAO/MU' };
    expect(matchSwapForAdjustment(FEE, [later, SWAP])?.afterName).toBe('YANG/LIN');
  });

  it('证件号两边都有但对不上 → 不配', () => {
    expect(matchSwapForAdjustment(FEE, [{ ...SWAP, beforeDoc: 'E999' }])).toBeNull();
  });

  it('超出 30 分钟窗口 → 不配；改信息记录（CORRECTION）不参与', () => {
    expect(matchSwapForAdjustment(FEE, [{ ...SWAP, at: '2026-09-30T03:00:00.000Z' }])).toBeNull();
    expect(matchSwapForAdjustment(FEE, [{ ...SWAP, kind: 'CORRECTION' }])).toBeNull();
  });

  it('姓名比对忽略大小写与多余空白', () => {
    expect(matchSwapForAdjustment({ ...FEE, passengerName: ' qin/xue ' }, [SWAP])?.afterName).toBe('YANG/LIN');
  });
});
