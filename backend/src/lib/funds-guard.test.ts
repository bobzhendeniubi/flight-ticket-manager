import { describe, it, expect } from 'vitest';
import { OrderStatus } from '@prisma/client';

import {
  assertOrderAcceptsFunds,
  assertOrderAllowsFundsDisposal,
  assertOrderAllowsFundsReversal,
  FUNDS_CREDIT_BLOCKED_STATUSES,
  FUNDS_DISPOSE_BLOCKED_STATUSES,
  FUNDS_REVERSAL_BLOCKED_STATUSES,
} from './funds-guard.js';
import { BadRequestError } from './errors.js';

const live = (status: OrderStatus) => ({ orderNumber: 'T-1', status, deletedAt: null });

describe('funds-guard · 收款闸 assertOrderAcceptsFunds', () => {
  it('允许对可收款状态入账（PENDING_PAYMENT / PAID / PROCESSING / TICKETED / FAILED）', () => {
    for (const s of [
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
      OrderStatus.PROCESSING,
      OrderStatus.TICKETED,
      OrderStatus.FAILED,
    ]) {
      expect(() => assertOrderAcceptsFunds(live(s))).not.toThrow();
    }
  });

  it('拒绝对死单入账（CANCELLED / REFUNDED / PAYMENT_TIMEOUT / DRAFT）', () => {
    for (const s of FUNDS_CREDIT_BLOCKED_STATUSES) {
      expect(() => assertOrderAcceptsFunds(live(s))).toThrow(BadRequestError);
    }
  });

  it('拒绝对软删单入账（即便状态本身可收款）', () => {
    expect(() =>
      assertOrderAcceptsFunds({ orderNumber: 'T-1', status: OrderStatus.PAID, deletedAt: new Date() }),
    ).toThrow(BadRequestError);
  });
});

describe('funds-guard · 处置闸 assertOrderAllowsFundsDisposal', () => {
  it('允许对活跃单处置（PAID / PROCESSING / TICKETED / COMPLETED）', () => {
    for (const s of [
      OrderStatus.PAID,
      OrderStatus.PROCESSING,
      OrderStatus.TICKETED,
      OrderStatus.COMPLETED,
    ]) {
      expect(() => assertOrderAllowsFundsDisposal(live(s), '测试')).not.toThrow();
    }
  });

  it('处置闸比收款闸更严：FAILED 也拒绝', () => {
    expect(FUNDS_DISPOSE_BLOCKED_STATUSES).toContain(OrderStatus.FAILED);
    expect(() => assertOrderAllowsFundsDisposal(live(OrderStatus.FAILED), '测试')).toThrow(
      BadRequestError,
    );
  });

  /**
   * 退款审批中 = 退款义务已成立、但 Refund 仍停在 REQUESTED（不计入「已完成退款」）的窗口期。
   * 此时放行多付处置 → 同一笔钱先按多付转走、再按退款快照退给客户，公司净损失。
   */
  it('处置闸拉黑 REFUND_REQUESTED：退款审批中的单不许动资金处置', () => {
    expect(FUNDS_DISPOSE_BLOCKED_STATUSES).toContain(OrderStatus.REFUND_REQUESTED);
    expect(() =>
      assertOrderAllowsFundsDisposal(live(OrderStatus.REFUND_REQUESTED), '将多付存入代理余额'),
    ).toThrow(BadRequestError);
  });

  it('收款闸不拉黑 REFUND_REQUESTED：退款审批中仍可补收（只挡处置，不挡进钱）', () => {
    expect(FUNDS_CREDIT_BLOCKED_STATUSES).not.toContain(OrderStatus.REFUND_REQUESTED);
    expect(() => assertOrderAcceptsFunds(live(OrderStatus.REFUND_REQUESTED))).not.toThrow();
  });

  it('拒绝对死单/软删单处置', () => {
    for (const s of FUNDS_DISPOSE_BLOCKED_STATUSES) {
      expect(() => assertOrderAllowsFundsDisposal(live(s), '测试')).toThrow(BadRequestError);
    }
    expect(() =>
      assertOrderAllowsFundsDisposal(
        { orderNumber: 'T-1', status: OrderStatus.PAID, deletedAt: new Date() },
        '测试',
      ),
    ).toThrow(BadRequestError);
  });
});

describe('funds-guard · 撤销闸 assertOrderAllowsFundsReversal', () => {
  it('允许取消族及正常状态撤销收款（取消族不减少公司总资金）', () => {
    for (const s of [
      OrderStatus.CANCELLED,
      OrderStatus.PAYMENT_TIMEOUT,
      OrderStatus.FAILED,
      OrderStatus.DRAFT,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
    ]) {
      expect(() => assertOrderAllowsFundsReversal(live(s), '撤销收款')).not.toThrow();
    }
  });

  it('仅拒绝已退款和退款审批中的订单', () => {
    expect(FUNDS_REVERSAL_BLOCKED_STATUSES).toEqual([
      OrderStatus.REFUNDED,
      OrderStatus.REFUND_REQUESTED,
    ]);
    for (const s of FUNDS_REVERSAL_BLOCKED_STATUSES) {
      expect(() => assertOrderAllowsFundsReversal(live(s), '撤销收款')).toThrow(BadRequestError);
    }
  });

  it('拒绝回收站订单', () => {
    expect(() =>
      assertOrderAllowsFundsReversal(
        { orderNumber: 'T-1', status: OrderStatus.CANCELLED, deletedAt: new Date() },
        '撤销收款',
      ),
    ).toThrow(BadRequestError);
  });

  it('回归：处置闸仍拒绝 CANCELLED', () => {
    expect(() => assertOrderAllowsFundsDisposal(live(OrderStatus.CANCELLED), '处置资金')).toThrow(
      BadRequestError,
    );
  });
});
