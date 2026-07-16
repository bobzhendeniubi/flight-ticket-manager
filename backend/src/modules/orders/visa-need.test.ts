/**
 * visa-need.ts · 单一签证判定口径（vitest）
 *
 * 口径：本单存在至少一位需要我方代办签证的乘客。
 * 三根轴：订单级 visaStatus / 商品级涉签（VISA 行·含签证组件套餐） / 乘客级 visaExempt。
 */
import { describe, it, expect } from 'vitest';
import { VisaRequirement } from '@prisma/client';
import {
  passengerNeedsVisa,
  anyPassengerNeedsVisa,
  orderVisaStatusRequiresVisa,
  orderNeedsVisaTask,
} from './visa-need.js';

describe('passengerNeedsVisa — 乘客级', () => {
  it('自备签（visaExempt=true）→ 不用我方代办', () => {
    expect(passengerNeedsVisa({ visaExempt: true })).toBe(false);
  });

  it('随团办签（visaExempt=false）→ 要我方代办', () => {
    expect(passengerNeedsVisa({ visaExempt: false })).toBe(true);
  });

  it('缺省 / null → 按随团办签处理，不漏单', () => {
    expect(passengerNeedsVisa({})).toBe(true);
    expect(passengerNeedsVisa({ visaExempt: null })).toBe(true);
  });
});

describe('anyPassengerNeedsVisa — 乘客级汇总', () => {
  it('混合单：一位自备签 + 一位要代办 → 仍要办', () => {
    expect(anyPassengerNeedsVisa([{ visaExempt: true }, { visaExempt: false }])).toBe(true);
  });

  it('全员自备签 → 无人要办', () => {
    expect(anyPassengerNeedsVisa([{ visaExempt: true }, { visaExempt: true }])).toBe(false);
  });

  it('空名单 → 回落 true（没录乘客 ≠ 没人要办，宁可多建也不漏单）', () => {
    expect(anyPassengerNeedsVisa([])).toBe(true);
  });
});

describe('orderVisaStatusRequiresVisa — 订单级', () => {
  it('NEEDED / E_VISA 都要送签（电子签同样要办）', () => {
    expect(orderVisaStatusRequiresVisa(VisaRequirement.NEEDED)).toBe(true);
    expect(orderVisaStatusRequiresVisa(VisaRequirement.E_VISA)).toBe(true);
  });

  it('其余状态 / null / undefined → 订单级不要求送签', () => {
    expect(orderVisaStatusRequiresVisa(VisaRequirement.NOT_NEEDED)).toBe(false);
    expect(orderVisaStatusRequiresVisa(VisaRequirement.HAS_VISA)).toBe(false);
    expect(orderVisaStatusRequiresVisa(null)).toBe(false);
    expect(orderVisaStatusRequiresVisa(undefined)).toBe(false);
  });
});

describe('orderNeedsVisaTask — 三根轴收口', () => {
  it('混合单（一位自备签 + 一位要代办）+ 订单级需签 → 建任务', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.NEEDED,
        passengers: [{ visaExempt: true }, { visaExempt: false }],
      }),
    ).toBe(true);
  });

  it('全员自备签 + 订单级需签 → 不建（否则签证台是零乘客空任务）', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.NEEDED,
        passengers: [{ visaExempt: true }, { visaExempt: true }],
      }),
    ).toBe(false);
  });

  it('全员自备签 + 商品级涉签（含签证组件套餐）→ 同样不建', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.NOT_NEEDED,
        hasVisaScope: true,
        passengers: [{ visaExempt: true }],
      }),
    ).toBe(false);
  });

  it('商品级涉签 + 有人要代办 → 建（订单级 visaStatus 未标也算数）', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: null,
        hasVisaScope: true,
        passengers: [{ visaExempt: false }],
      }),
    ).toBe(true);
  });

  it('三根轴都不涉签 → 不建', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.NOT_NEEDED,
        hasVisaScope: false,
        passengers: [{ visaExempt: false }],
      }),
    ).toBe(false);
  });

  it('订单级需签 + 未录乘客 → 建（空名单回落，不漏单）', () => {
    expect(
      orderNeedsVisaTask({ visaStatus: VisaRequirement.NEEDED, passengers: [] }),
    ).toBe(true);
  });
});
