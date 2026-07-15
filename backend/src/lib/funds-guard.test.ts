import { describe, it, expect } from 'vitest';
import { OrderStatus } from '@prisma/client';

import {
  assertOrderAcceptsFunds,
  assertOrderAllowsFundsDisposal,
  FUNDS_CREDIT_BLOCKED_STATUSES,
  FUNDS_DISPOSE_BLOCKED_STATUSES,
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
