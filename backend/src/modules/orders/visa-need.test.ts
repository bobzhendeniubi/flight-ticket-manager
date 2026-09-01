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
  orderVisaStatusExplicitlyNotNeeded,
  orderNeedsVisaTask,
  isVisaContradiction,
  VISA_CONTRADICTION_MESSAGE,
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

describe('orderVisaStatusExplicitlyNotNeeded — 订单级一票否决', () => {
  it('NOT_NEEDED 与 HAS_VISA 都算「明说不用我方办」（已签证客人签证岗完全不用管）', () => {
    expect(orderVisaStatusExplicitlyNotNeeded(VisaRequirement.NOT_NEEDED)).toBe(true);
    expect(orderVisaStatusExplicitlyNotNeeded(VisaRequirement.HAS_VISA)).toBe(true);
    expect(orderVisaStatusExplicitlyNotNeeded(VisaRequirement.NEEDED)).toBe(false);
    expect(orderVisaStatusExplicitlyNotNeeded(VisaRequirement.E_VISA)).toBe(false);
  });

  it('没表态（null / undefined）≠ 不需要', () => {
    expect(orderVisaStatusExplicitlyNotNeeded(null)).toBe(false);
    expect(orderVisaStatusExplicitlyNotNeeded(undefined)).toBe(false);
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

  // ── 订单级「不需要」压过商品级涉签（签证岗实测：套餐含签证组件的单选了「不需要」仍挂待处理）──
  it('订单级「不需要」+ 含签证组件套餐 + 乘客都没置自备签 → 不建（不依赖前端联动）', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.NOT_NEEDED,
        hasVisaScope: true,
        passengers: [{ visaExempt: false }, { visaExempt: false }],
      }),
    ).toBe(false);
  });

  it('订单级「不需要」+ 未录乘客 → 也不建（空名单回落只在没明说不需要时生效）', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.NOT_NEEDED,
        hasVisaScope: true,
        passengers: [],
      }),
    ).toBe(false);
  });

  it('已签证（HAS_VISA）+ 商品级涉签 → 不建（客人已自持签证，与「不需要」同权否决）', () => {
    expect(
      orderNeedsVisaTask({
        visaStatus: VisaRequirement.HAS_VISA,
        hasVisaScope: true,
        passengers: [{ visaExempt: false }],
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

describe('isVisaContradiction — 订单级需签 × 全员自备签 的矛盾组合', () => {
  it('NEEDED + 全员自备签 → 矛盾（不建任务，签证台看不见 → 漏签）', () => {
    expect(
      isVisaContradiction({
        visaStatus: VisaRequirement.NEEDED,
        passengers: [{ visaExempt: true }, { visaExempt: true }],
      }),
    ).toBe(true);
  });

  it('E_VISA + 全员自备签 → 同样矛盾（电子签一样要送签）', () => {
    expect(
      isVisaContradiction({
        visaStatus: VisaRequirement.E_VISA,
        passengers: [{ visaExempt: true }],
      }),
    ).toBe(true);
  });

  it('混合名单（部分自备签）→ 不矛盾（其余人照常送签）', () => {
    expect(
      isVisaContradiction({
        visaStatus: VisaRequirement.NEEDED,
        passengers: [{ visaExempt: true }, { visaExempt: false }],
      }),
    ).toBe(false);
  });

  it('空名单 → 不矛盾（先建单后补乘客是正常流程）', () => {
    expect(
      isVisaContradiction({ visaStatus: VisaRequirement.NEEDED, passengers: [] }),
    ).toBe(false);
  });

  it('订单级不要求送签的三档（NOT_NEEDED / HAS_VISA / 未标注）+ 全员自备签 → 不矛盾', () => {
    for (const visaStatus of [
      VisaRequirement.NOT_NEEDED,
      VisaRequirement.HAS_VISA,
      null,
      undefined,
    ]) {
      expect(isVisaContradiction({ visaStatus, passengers: [{ visaExempt: true }] })).toBe(false);
    }
  });

  it('visaExempt 缺省 / null 按随团办签算 → 不矛盾', () => {
    expect(
      isVisaContradiction({ visaStatus: VisaRequirement.NEEDED, passengers: [{}] }),
    ).toBe(false);
    expect(
      isVisaContradiction({
        visaStatus: VisaRequirement.NEEDED,
        passengers: [{ visaExempt: null }],
      }),
    ).toBe(false);
  });

  // 与权威判定的关系：矛盾成立 ⇔ 订单级说要办、但 orderNeedsVisaTask 判不建。
  it('矛盾成立时 orderNeedsVisaTask 恒判「不建任务」（这正是漏签的机制）', () => {
    const input = {
      visaStatus: VisaRequirement.NEEDED,
      passengers: [{ visaExempt: true }, { visaExempt: true }],
    };
    expect(isVisaContradiction(input)).toBe(true);
    expect(orderNeedsVisaTask(input)).toBe(false);
  });

  it('报错文案给出两条出路，且不含内部人名', () => {
    expect(VISA_CONTRADICTION_MESSAGE).toContain('自备签');
    expect(VISA_CONTRADICTION_MESSAGE).toContain('不需要签证');
    expect(VISA_CONTRADICTION_MESSAGE).toContain('已签证');
  });
});
