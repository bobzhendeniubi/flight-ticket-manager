import { describe, expect, it } from 'vitest';
import { OrderStatus, Prisma } from '@prisma/client';
import {
  ALLOWED_TRANSITIONS,
  buildPaidOrderBalanceWarning,
  hasVisaDeductReversalFor,
  type OrderAdjustmentEntry,
} from './orders.service.js';
import { assertPaymentsNotLocked } from '../../lib/funds-guard.js';
import { ConflictError } from '../../lib/errors.js';

describe('状态机：改签申请中也能走退款取消', () => {
  it('CHANGE_REQUESTED → REFUND_REQUESTED 在白名单里（与 cancellation.ts 的可取消状态一致）', () => {
    expect(ALLOWED_TRANSITIONS.CHANGE_REQUESTED).toContain('REFUND_REQUESTED');
  });
});

describe('收款复核锁：内部搬账入口同样受锁', () => {
  it('锁定态抛 409，文案带动作名', () => {
    expect(() =>
      assertPaymentsNotLocked({ orderNumber: 'FTM1', paymentsLocked: true }, '用代理余额抵扣'),
    ).toThrowError(ConflictError);
    expect(() =>
      assertPaymentsNotLocked({ orderNumber: 'FTM1', paymentsLocked: true }, '用代理余额抵扣'),
    ).toThrow(/用代理余额抵扣/);
  });
  it('未锁定放行', () => {
    expect(() =>
      assertPaymentsNotLocked({ orderNumber: 'FTM1', paymentsLocked: false }, '将多付转入挂账池'),
    ).not.toThrow();
  });
});

describe('自备签减免冲抵的幂等锚点：槽位 + 这个人', () => {
  const entry = (extra: Partial<OrderAdjustmentEntry>): OrderAdjustmentEntry => ({
    type: 'SWAP_VISA_DEDUCT_REVERSAL',
    label: '撤销自备签减免',
    amountCny: 300,
    at: '2026-09-01T00:00:00.000Z',
    by: 'u1',
    passengerId: 'p1',
    ...extra,
  });
  it('老记录（无证件号留痕）沿用旧口径：同槽位即视为已冲', () => {
    expect(hasVisaDeductReversalFor([entry({})], 'p1', 'E123')).toBe(true);
  });
  it('同槽位、被换下去的是别人 → 不算已冲（第二次真实换人照常追回减免）', () => {
    expect(hasVisaDeductReversalFor([entry({ passengerDocument: 'E111' })], 'p1', 'E222')).toBe(false);
  });
  it('同槽位、同一个人（证件号大小写/空格差异归一）→ 已冲', () => {
    expect(hasVisaDeductReversalFor([entry({ passengerDocument: 'e111' })], 'p1', ' E111 ')).toBe(true);
  });
  it('别的槽位不算', () => {
    expect(hasVisaDeductReversalFor([entry({ passengerDocument: 'E111' })], 'p2', 'E111')).toBe(false);
  });
});

describe('已付单抬应收后的资金后果提示', () => {
  it('未收款 → 无提示', () => {
    expect(
      buildPaidOrderBalanceWarning({ status: OrderStatus.PENDING_PAYMENT, paidAmount: new Prisma.Decimal(0) }, 1200),
    ).toBeNull();
  });
  it('已付款族新增尾款 → 提示补收并带差额', () => {
    const w = buildPaidOrderBalanceWarning(
      { status: OrderStatus.PAID, paidAmount: new Prisma.Decimal(1000) },
      1200,
    );
    expect(w).toMatch(/新增尾款 ¥200/);
  });
  it('降低应收形成多付 → 指路多付处置', () => {
    const w = buildPaidOrderBalanceWarning({ status: OrderStatus.TICKETED, paidAmount: '1000' }, 800);
    expect(w).toMatch(/多付 ¥200/);
  });
  it('待支付单收了定金再加项 → 不算已付款族，不提示尾款', () => {
    expect(
      buildPaidOrderBalanceWarning({ status: OrderStatus.PENDING_PAYMENT, paidAmount: 300 }, 1200),
    ).toBeNull();
  });
});
