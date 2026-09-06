/**
 * 签证口径台账（特征测试 · 纯函数部分）—— 把已拍板的口径逐条钉成用例。
 *
 * 签证是反馈最反复的领域（同一联动 5 天修 5 次、签证台漏 4 处、拆单不重派生）。在把
 * 「订单级 visaStatus / 乘客级 visaExempt / 乘客级 visaSubmissionStatus / VISA_APPLICATION 任务 /
 * 套餐签证组件」五个真值源收拢成乘客级状态机之前，先把「现状必须保持」的每条口径钉死在这里：
 * 收拢过程中任何一条变红，就是行为变了。
 *
 * 本文件只钉**纯函数**口径（判定 / 导出文案 / 金额 / 任务级派生）；写入路径与签证台/提醒的
 * 钉子见 visa-rulings.service.test.ts。
 *
 * 台账（日期 = 拍板日；依据 docs/口径决议.md、docs/签证流程-收口方案.md）：
 *   0827  录单「不需要签证」联动全员自备签——服务端判定不依赖前端联动，订单级一票否决
 *   0830  全员（非自备签）已送签 → 订单自动已签证；HAS_VISA 与 NOT_NEEDED 同权否决建任务
 *   0901  两层收口：矛盾组合（需签 + 全员自备签）服务端硬拒；文案给两条出路
 *   0903  「自备签优先」是错的：联动方向只能是「不需要签证 → 自备签」，不能反过来
 *         把全员自备签当成「不需要」；导出侧订单头压过联动置上的自备签
 *   0904  导出四列按人：混合单自备签写「自备签」金额 0；全员自备签跟订单头写「已签证」；
 *         NOT_NEEDED 口径不动；visaListSnapshotCny 是每人口径不再 ÷ 人数
 */
import { describe, it, expect } from 'vitest';
import { FulfillmentStatus, VisaRequirement, VisaSubmissionStatus } from '@prisma/client';

import {
  anyPassengerNeedsVisa,
  isVisaContradiction,
  orderNeedsVisaTask,
  orderVisaStatusExplicitlyNotNeeded,
  orderVisaStatusRequiresVisa,
  passengerNeedsVisa,
  VISA_CONTRADICTION_MESSAGE,
} from '../orders/visa-need.js';
import {
  allPassengersVisaExempt,
  orderVisaStatusLabel,
  passengerVisaStatusCell,
  perPaxVisaAmountByPassenger,
} from '../orders/orders.export-templates.js';
import { deriveVisaTaskStatus } from './fulfillment.service.js';

const { NOT_NEEDED, NEEDED, E_VISA, HAS_VISA } = VisaRequirement;
const { PENDING, IN_PROGRESS, CONFIRMED } = VisaSubmissionStatus;

const ours = { visaExempt: false };
const self = { visaExempt: true };

// ═══════════════════════════════════════════════════════════════════════════
describe('0827 · 录单「不需要签证」联动全员自备签——服务端判定不依赖前端联动', () => {
  it('订单级 NOT_NEEDED + 含签证组件（商品级涉签）+ 乘客都没置自备签 → 不建任务', () => {
    expect(
      orderNeedsVisaTask({ visaStatus: NOT_NEEDED, hasVisaScope: true, passengers: [ours, ours] }),
    ).toBe(false);
  });

  it('订单级 NOT_NEEDED + 未录乘客 → 也不建（空名单回落只在没明说不需要时生效）', () => {
    expect(orderNeedsVisaTask({ visaStatus: NOT_NEEDED, hasVisaScope: true, passengers: [] })).toBe(
      false,
    );
  });

  it('回归：同一张单签证状态 NEEDED / E_VISA → 照建；没表态（null）+ 商品级涉签 → 照建（不漏单）', () => {
    expect(orderNeedsVisaTask({ visaStatus: NEEDED, passengers: [ours] })).toBe(true);
    expect(orderNeedsVisaTask({ visaStatus: E_VISA, passengers: [ours] })).toBe(true);
    expect(orderNeedsVisaTask({ visaStatus: null, hasVisaScope: true, passengers: [ours] })).toBe(
      true,
    );
    expect(orderNeedsVisaTask({ visaStatus: null, hasVisaScope: false, passengers: [ours] })).toBe(
      false,
    );
  });

  it('订单级四档 → 「要求送签」/「明确不需要」两个谓词互斥且各只认两档', () => {
    expect(orderVisaStatusRequiresVisa(NEEDED)).toBe(true);
    expect(orderVisaStatusRequiresVisa(E_VISA)).toBe(true);
    expect(orderVisaStatusRequiresVisa(NOT_NEEDED)).toBe(false);
    expect(orderVisaStatusRequiresVisa(HAS_VISA)).toBe(false);
    expect(orderVisaStatusRequiresVisa(null)).toBe(false);
    expect(orderVisaStatusExplicitlyNotNeeded(NOT_NEEDED)).toBe(true);
    expect(orderVisaStatusExplicitlyNotNeeded(HAS_VISA)).toBe(true);
    expect(orderVisaStatusExplicitlyNotNeeded(NEEDED)).toBe(false);
    expect(orderVisaStatusExplicitlyNotNeeded(E_VISA)).toBe(false);
    expect(orderVisaStatusExplicitlyNotNeeded(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0903 · 联动方向只能是「不需要签证 → 自备签」，不能反过来', () => {
  it('全员自备签**不**等于「不需要签证」：订单级仍是需签时判成矛盾（拒绝），不是静默改成不需要', () => {
    const allSelf = [self, self];
    // 乘客级汇总：无人要我方办
    expect(anyPassengerNeedsVisa(allSelf)).toBe(false);
    // 但订单级 NEEDED 不因此被视作「不需要」——这是矛盾，写入路径硬拒（见 service 台账）
    expect(isVisaContradiction({ visaStatus: NEEDED, passengers: allSelf })).toBe(true);
    expect(isVisaContradiction({ visaStatus: E_VISA, passengers: allSelf })).toBe(true);
    // 判定层也不替订单改口：orderVisaStatusExplicitlyNotNeeded 只看订单级
    expect(orderVisaStatusExplicitlyNotNeeded(NEEDED)).toBe(false);
  });

  it('订单级 NOT_NEEDED / HAS_VISA / 未表态 + 全员自备签 → 不矛盾（那正是联动置上的形态）', () => {
    for (const visaStatus of [NOT_NEEDED, HAS_VISA, null]) {
      expect(isVisaContradiction({ visaStatus, passengers: [self, self] })).toBe(false);
    }
  });

  it('乘客级 visaExempt 缺省 / null 一律按随团办签（老数据不会被当成自备签）', () => {
    expect(passengerNeedsVisa({})).toBe(true);
    expect(passengerNeedsVisa({ visaExempt: null })).toBe(true);
    expect(passengerNeedsVisa({ visaExempt: true })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0830 · 办结派生与同权否决', () => {
  it('HAS_VISA 与 NOT_NEEDED 同权否决建任务（客人已自持签证，签证岗无事可做）', () => {
    expect(orderNeedsVisaTask({ visaStatus: HAS_VISA, hasVisaScope: true, passengers: [ours] })).toBe(
      false,
    );
    expect(orderNeedsVisaTask({ visaStatus: HAS_VISA, passengers: [ours, ours] })).toBe(false);
  });

  it('任务级状态 = 全体非自备签乘客送签进度的最低档（部分送签 → 任务保持较早那档）', () => {
    expect(deriveVisaTaskStatus([])).toBe(FulfillmentStatus.PENDING);
    expect(deriveVisaTaskStatus([CONFIRMED, CONFIRMED])).toBe(FulfillmentStatus.CONFIRMED);
    expect(deriveVisaTaskStatus([CONFIRMED, PENDING])).toBe(FulfillmentStatus.PENDING);
    expect(deriveVisaTaskStatus([IN_PROGRESS, CONFIRMED])).toBe(FulfillmentStatus.IN_PROGRESS);
    expect(deriveVisaTaskStatus([IN_PROGRESS, PENDING])).toBe(FulfillmentStatus.PENDING);
  });

  it('混合单：一位自备签 + 一位要代办 → 仍建任务（自备签的人不显示、不计数，其余照常送签）', () => {
    expect(orderNeedsVisaTask({ visaStatus: NEEDED, passengers: [self, ours] })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0901 · 矛盾组合服务端硬拒的判定与文案', () => {
  it('两条豁免：空名单不拦（先建单后补人）；部分自备签不拦（混合单正常）', () => {
    expect(isVisaContradiction({ visaStatus: NEEDED, passengers: [] })).toBe(false);
    expect(isVisaContradiction({ visaStatus: NEEDED, passengers: [self, ours] })).toBe(false);
  });

  it('矛盾成立时 orderNeedsVisaTask 恒判「不建」——这正是漏签机制，所以写入侧必须拒', () => {
    const input = { visaStatus: NEEDED, hasVisaScope: true, passengers: [self, self] };
    expect(isVisaContradiction(input)).toBe(true);
    expect(orderNeedsVisaTask(input)).toBe(false);
  });

  it('报错文案说清后果 + 两条出路（改回随团办签 / 改订单签证状态），且不含内部人名', () => {
    expect(VISA_CONTRADICTION_MESSAGE).toContain('签证台看不到这单');
    expect(VISA_CONTRADICTION_MESSAGE).toContain('取消');
    expect(VISA_CONTRADICTION_MESSAGE).toContain('「不需要签证」或「已签证」');
    expect(VISA_CONTRADICTION_MESSAGE).not.toMatch(/口径[:：]?\s*[一-龥]{2,3}(说|定)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0904 · 导出「签证状态」列按人取值（订单头 × 自备签 × 送签进度 全矩阵）', () => {
  /** 订单级文案由行循环外算一次传入：录单档优先，未表态时回落履约任务文案。 */
  const label = (visaStatus: VisaRequirement | null, taskStatus: string | null = 'IN_PROGRESS') =>
    orderVisaStatusLabel(visaStatus, taskStatus);

  const cell = (
    visaStatus: VisaRequirement | null,
    passenger: { visaExempt?: boolean; visaSubmissionStatus?: VisaSubmissionStatus | null },
    allPassengersExempt: boolean,
  ) =>
    passengerVisaStatusCell({
      orderVisaLabel: label(visaStatus),
      orderVisaStatus: visaStatus,
      passenger,
      allPassengersExempt,
    });

  it('订单级 NEEDED：自备签→「自备签」；随团待处理→「需要」；材料准备/已送签→进度文案', () => {
    expect(cell(NEEDED, { visaExempt: true, visaSubmissionStatus: PENDING }, false)).toBe('自备签');
    expect(cell(NEEDED, { visaExempt: false, visaSubmissionStatus: PENDING }, false)).toBe('需要');
    expect(cell(NEEDED, { visaExempt: false, visaSubmissionStatus: IN_PROGRESS }, false)).toBe(
      '材料准备',
    );
    expect(cell(NEEDED, { visaExempt: false, visaSubmissionStatus: CONFIRMED }, false)).toBe(
      '已送签',
    );
  });

  it('订单级 E_VISA：与 NEEDED 同型，只是待处理的人写「电子签」', () => {
    expect(cell(E_VISA, { visaExempt: false, visaSubmissionStatus: PENDING }, false)).toBe('电子签');
    expect(cell(E_VISA, { visaExempt: true, visaSubmissionStatus: PENDING }, false)).toBe('自备签');
  });

  it('订单级 NOT_NEEDED（口径不动）：联动置上的自备签跟订单头写「不需要」；逐人进度仍压过订单头', () => {
    expect(cell(NOT_NEEDED, { visaExempt: true, visaSubmissionStatus: PENDING }, true)).toBe('不需要');
    expect(cell(NOT_NEEDED, { visaExempt: true, visaSubmissionStatus: PENDING }, false)).toBe(
      '不需要',
    );
    expect(cell(NOT_NEEDED, { visaExempt: false, visaSubmissionStatus: PENDING }, false)).toBe(
      '不需要',
    );
    expect(cell(NOT_NEEDED, { visaExempt: false, visaSubmissionStatus: CONFIRMED }, false)).toBe(
      '已送签',
    );
  });

  it('订单级 HAS_VISA：全员联动置 exempt → 全员「已签证」；混合单 exempt 的人写「自备签」；已送签写「已送签」', () => {
    expect(cell(HAS_VISA, { visaExempt: true, visaSubmissionStatus: PENDING }, true)).toBe('已签证');
    expect(cell(HAS_VISA, { visaExempt: true, visaSubmissionStatus: PENDING }, false)).toBe('自备签');
    expect(cell(HAS_VISA, { visaExempt: false, visaSubmissionStatus: PENDING }, false)).toBe(
      '已签证',
    );
    expect(cell(HAS_VISA, { visaExempt: false, visaSubmissionStatus: CONFIRMED }, false)).toBe(
      '已送签',
    );
  });

  it('订单级未表态（null）：回落履约任务文案；自备签仍写「自备签」', () => {
    expect(cell(null, { visaExempt: false, visaSubmissionStatus: PENDING }, false)).toBe('处理中');
    expect(cell(null, { visaExempt: true, visaSubmissionStatus: PENDING }, false)).toBe('自备签');
    expect(
      passengerVisaStatusCell({
        orderVisaLabel: label(null, null),
        orderVisaStatus: null,
        passenger: { visaExempt: false },
      }),
    ).toBe('');
  });

  it('老数据（乘客无送签/自备签字段）→ 整列沿用订单级/履约任务文案', () => {
    expect(cell(NEEDED, {}, false)).toBe('需要');
    expect(cell(null, {}, false)).toBe('处理中');
  });

  it('「全员自备签」在订单级算一次：空名单 → false；缺省字段 → false', () => {
    expect(allPassengersVisaExempt([])).toBe(false);
    expect(allPassengersVisaExempt([self, self])).toBe(true);
    expect(allPassengersVisaExempt([self, ours])).toBe(false);
    expect(allPassengersVisaExempt([{}, self])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0904 · 导出「签证金额」列按人：自备签 0；套餐挂牌价快照是每人口径不 ÷ 人数', () => {
  const pax = (id: string, visaExempt: boolean) => ({ id, visaExempt });

  it('套餐 visaListSnapshotCny=240（每人口径）+ 四人单两人自备签 → 0 / 0 / 240 / 240', () => {
    const m = perPaxVisaAmountByPassenger({
      passengers: [pax('a', true), pax('b', true), pax('c', false), pax('d', false)],
      items: [{ kind: 'BUNDLE', amount: 10000, metadata: { visaListSnapshotCny: 240 } }],
    });
    expect([...m.values()]).toEqual([0, 0, 240, 240]);
  });

  it('独立 VISA 行 500 元是整单口径 → 在非自备签乘客间均摊；自备签乘客 0', () => {
    const m = perPaxVisaAmountByPassenger({
      passengers: [pax('a', true), pax('b', false), pax('c', false)],
      items: [{ kind: 'VISA', amount: 500 }],
    });
    expect([...m.values()]).toEqual([0, 250, 250]);
  });

  it('全员自备签却仍有 VISA 行（矛盾数据）→ 在全员间均摊，钱不凭空消失', () => {
    const m = perPaxVisaAmountByPassenger({
      passengers: [pax('a', true), pax('b', true)],
      items: [{ kind: 'VISA', amount: 500 }],
    });
    expect([...m.values()]).toEqual([250, 250]);
  });

  it('老单无快照 → 回退套餐现行定义 qty×unitPrice（每人口径）；快照 0 = 当时不含签证组件', () => {
    const noSnapshot = perPaxVisaAmountByPassenger({
      passengers: [pax('a', false)],
      items: [
        {
          kind: 'BUNDLE',
          amount: 1000,
          metadata: null,
          bundle: { items: [{ kind: 'VISA', qty: 1, unitPrice: 240 }] },
        },
      ],
    });
    expect(noSnapshot.get('a')).toBe(240);
    const zeroSnapshot = perPaxVisaAmountByPassenger({
      passengers: [pax('a', false)],
      items: [
        {
          kind: 'BUNDLE',
          amount: 1000,
          metadata: { visaListSnapshotCny: 0 },
          bundle: { items: [{ kind: 'VISA', qty: 1, unitPrice: 240 }] },
        },
      ],
    });
    expect(zeroSnapshot.get('a')).toBe(0);
  });
});
