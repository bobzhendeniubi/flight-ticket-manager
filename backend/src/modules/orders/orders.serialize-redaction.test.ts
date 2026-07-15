/**
 * serializeOrder 对外脱敏（A15）· 单元测试（vitest）
 *
 * 口径：AGENT / CUSTOMER 视角只该看到 产品名 / 航班号 / 接待服务标准 / 自己的结算价（订单总价），
 * 其余「我方内部口径」——内部备注、结构化四栏、出纳期望到账、售后审计流水、接单运营、运营待办、
 * 代理预存余额、以及逐项拆价（item.unitPrice / item.amount）——一律不下发；ADMIN / STAFF 看全量。
 *
 * 直接测纯函数 serializeOrder + orderSerializeRoleCtx，不经 DB（只 mock 掉 prisma 单例以免实例化）。
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma, UserRole } from '@prisma/client';

// serializeOrder / orderSerializeRoleCtx 本身不查库，但导入 orders.service 会实例化 prisma 单例——mock 掉即可。
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { serializeOrder, orderSerializeRoleCtx } from './orders.service.js';

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

/** 构造一条「内部字段齐全」的订单，便于断言脱敏前后差异。每次返回全新对象（避免用例间互相污染）。 */
function buildOrder() {
  return {
    id: 'ord_1',
    orderNumber: 'CO-TEST-1',
    status: 'PAID',
    subtotal: dec(1000),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(1000),
    paidAmount: dec(1000),
    prepaymentOffset: dec(0),
    adjustmentCny: 0,
    // 客户可见备注（保留）
    notes: '客户填写的说明',
    // 以下均为「我方内部口径」，对外应被剥离
    internalNotes: '内部私密备注',
    noteHotel: '酒店内部口径',
    noteVisa: '签证内部口径',
    notePayment: '付款内部口径',
    noteSpecial: '特殊内部口径',
    expectedAmountCny: dec(1000),
    expectedAmountLocked: true,
    adjustments: [{ type: 'RESCHEDULE_FEE', amountCny: 100, by: 'user_ops_1' }],
    claimedById: 'user_ops_1',
    claimedBy: { id: 'user_ops_1', displayName: '内部运营', email: 'ops@example.com' },
    reminders: [{ id: 'rem_1', title: '2 日内拿批文', status: 'OPEN', priority: 'HIGH' }],
    agent: {
      id: 'ag_1',
      companyName: '某代理公司',
      contactName: '代理联系人',
      settlementMode: 'MONTHLY',
      prepaymentBalance: dec(5000),
    },
    passengers: [
      {
        id: 'p1',
        fullName: '李四',
        passengerType: 'ADULT',
        documentNumber: 'E12345678',
        passportPhotoUrl: 'data:image/png;base64,AAAA',
      },
    ],
    items: [
      {
        id: 'it1',
        kind: 'FLIGHT',
        description: '国航 CA123 经济舱',
        quantity: 2,
        unitPrice: dec(500),
        amount: dec(1000),
        // metadata 混合：计价键（perSeatBreakdown 含逐座 unitPrice）+ 业务键（出发日期）
        metadata: {
          perSeatBreakdown: [
            { seatIndex: 1, bucket: 0, bucketMultiplier: 1, unitPrice: 480 },
            { seatIndex: 2, bucket: 0, bucketMultiplier: 1, unitPrice: 520 },
          ],
          goDate: '2026-08-01',
          businessUpgradeCount: 0,
        },
      },
      {
        id: 'it2',
        kind: 'BUNDLE',
        description: '三亚 5 日跟团套餐',
        quantity: 1,
        unitPrice: dec(3000),
        amount: dec(3200),
        // metadata 混合：计价键（addOns/operationFee/bundleDiscountPct）+ 业务键（房间/晚数/乘客构成）
        metadata: {
          addOns: {
            singleSupplementCnyPerNight: 80,
            selfVisaDeductCny: 150,
            total: -150,
          },
          operationFee: { perPaxCny: 20, pax: 2, totalCny: 40 },
          bundleDiscountPct: 10,
          roomsNeeded: 1,
          hotelNights: 4,
          adultCount: 2,
          childCount: 0,
          infantCount: 0,
        },
      },
    ],
  };
}

describe('orderSerializeRoleCtx', () => {
  it('内部角色（ADMIN/STAFF）不脱敏、保留护照大图', () => {
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      expect(orderSerializeRoleCtx(role)).toEqual({
        includePassportPhotos: true,
        redactForExternal: false,
      });
    }
  });

  it('对外角色（AGENT/CUSTOMER）脱敏、剥离护照大图', () => {
    for (const role of [UserRole.AGENT, UserRole.CUSTOMER]) {
      expect(orderSerializeRoleCtx(role)).toEqual({
        includePassportPhotos: false,
        redactForExternal: true,
      });
    }
  });
});

describe('serializeOrder · ADMIN/STAFF 视角（不脱敏）', () => {
  const out = serializeOrder(buildOrder(), orderSerializeRoleCtx(UserRole.ADMIN)) as Record<string, any>;

  it('保留内部备注 + 结构化四栏', () => {
    expect(out.internalNotes).toBe('内部私密备注');
    expect(out.noteHotel).toBe('酒店内部口径');
    expect(out.noteVisa).toBe('签证内部口径');
    expect(out.notePayment).toBe('付款内部口径');
    expect(out.noteSpecial).toBe('特殊内部口径');
  });

  it('保留出纳期望到账 / 售后审计 / 接单运营 / 运营待办 / 代理预存余额', () => {
    expect(String(out.expectedAmountCny)).toBe('1000');
    expect(out.expectedAmountLocked).toBe(true);
    expect(out.adjustments).toHaveLength(1);
    expect(out.claimedById).toBe('user_ops_1');
    expect(out.claimedBy?.displayName).toBe('内部运营');
    expect(out.reminders).toHaveLength(1);
    expect(out.agent.prepaymentBalance).toBe('5000');
  });

  it('保留逐项拆价（单价 / 小计）与护照大图', () => {
    expect(out.items[0].unitPrice).toBe('500');
    expect(out.items[0].amount).toBe('1000');
    expect(out.passengers[0].passportPhotoUrl).toBe('data:image/png;base64,AAAA');
    expect(out.passengers[0].hasPassportPhoto).toBe(true);
  });

  it('保留订单行 metadata 计价明细（perSeatBreakdown / addOns / operationFee / bundleDiscountPct）', () => {
    expect(out.items[0].metadata.perSeatBreakdown).toHaveLength(2);
    expect(out.items[0].metadata.perSeatBreakdown[0].unitPrice).toBe(480);
    expect(out.items[1].metadata.addOns.total).toBe(-150);
    expect(out.items[1].metadata.operationFee.totalCny).toBe(40);
    expect(out.items[1].metadata.bundleDiscountPct).toBe(10);
  });

});

describe('serializeOrder · AGENT/CUSTOMER 视角（脱敏）', () => {
  const out = serializeOrder(buildOrder(), orderSerializeRoleCtx(UserRole.AGENT)) as Record<string, any>;

  it('剥离内部备注 + 结构化四栏（客户可见备注 notes 保留）', () => {
    expect(out.internalNotes).toBeUndefined();
    expect(out.noteHotel).toBeUndefined();
    expect(out.noteVisa).toBeUndefined();
    expect(out.notePayment).toBeUndefined();
    expect(out.noteSpecial).toBeUndefined();
    expect(out.notes).toBe('客户填写的说明');
  });

  it('剥离出纳期望到账 / 售后审计 / 接单运营 / 代理预存余额，待办清空', () => {
    expect(out.expectedAmountCny).toBeUndefined();
    expect(out.expectedAmountLocked).toBeUndefined();
    expect(out.adjustments).toBeUndefined();
    expect(out.claimedById).toBeUndefined();
    expect(out.claimedBy).toBeUndefined();
    expect(out.reminders).toEqual([]);
    expect(out.agent.prepaymentBalance).toBeUndefined();
  });

  it('剥离逐项拆价（单价 / 小计）与护照大图，但保留产品名/数量/证件号', () => {
    expect(out.items[0].unitPrice).toBeUndefined();
    expect(out.items[0].amount).toBeUndefined();
    expect(out.items[0].description).toBe('国航 CA123 经济舱');
    expect(out.items[0].quantity).toBe(2);
    expect(out.items[0].kind).toBe('FLIGHT');
    // 出行人证件保留（代理要凭此替客人办事），仅剥离护照大图
    expect(out.passengers[0].documentNumber).toBe('E12345678');
    expect(out.passengers[0].passportPhotoUrl).toBeUndefined();
    expect(out.passengers[0].hasPassportPhoto).toBe(true);
  });

  it('剥离订单行 metadata 计价明细（perSeatBreakdown/addOns/operationFee/bundleDiscountPct），保留非价格业务键', () => {
    // FLIGHT 行：逐座定价明细（含 unitPrice）剥离，出发日期等业务键保留
    expect(out.items[0].metadata.perSeatBreakdown).toBeUndefined();
    expect(out.items[0].metadata.goDate).toBe('2026-08-01');
    expect(out.items[0].metadata.businessUpgradeCount).toBe(0);
    // BUNDLE 行：加项/操作费/折扣百分比剥离，房间数/晚数/乘客构成计数保留
    expect(out.items[1].metadata.addOns).toBeUndefined();
    expect(out.items[1].metadata.operationFee).toBeUndefined();
    expect(out.items[1].metadata.bundleDiscountPct).toBeUndefined();
    expect(out.items[1].metadata.roomsNeeded).toBe(1);
    expect(out.items[1].metadata.hotelNights).toBe(4);
    expect(out.items[1].metadata.adultCount).toBe(2);
    expect(out.items[1].metadata.childCount).toBe(0);
    expect(out.items[1].metadata.infantCount).toBe(0);
  });

  it('保留订单总价与派生结清口径（= 该角色自己的结算价）以及非金额代理字段', () => {
    expect(out.total).toBe('1000');
    expect(out.subtotal).toBe('1000');
    expect(out.paidAmount).toBe('1000');
    expect(out.effectivePayable).toBe('1000');
    expect(out.balanceDue).toBe('0');
    // 代理的非金额字段（公司名/结算模式）仍在，仅余额被剥离
    expect(out.agent.companyName).toBe('某代理公司');
    expect(out.agent.settlementMode).toBe('MONTHLY');
  });
});

// ── B2：派生结清口径纳入 prepaymentOffset（与 reports/reminders/导出全局清账公式一字一致）──
describe('serializeOrder · balanceDue 纳入 prepaymentOffset', () => {
  it('尾款 = total + adjustmentCny − paidAmount − prepaymentOffset（含改期费与预存抵扣）', () => {
    const out = serializeOrder(
      { ...buildOrder(), total: dec(5000), adjustmentCny: 500, paidAmount: dec(3000), prepaymentOffset: dec(1000) },
      orderSerializeRoleCtx(UserRole.ADMIN),
    ) as Record<string, any>;
    // effectivePayable = 5000 + 500（应付含改期费，不减预存）
    expect(out.effectivePayable).toBe('5500');
    // balanceDue = 5500 − 3000（已付）− 1000（预存抵扣）= 1500
    expect(out.balanceDue).toBe('1500');
  });

  it('预存抵扣把尾款抵成负数 → 视为多付（balanceDue<0 语义保持）', () => {
    const out = serializeOrder(
      { ...buildOrder(), total: dec(1000), adjustmentCny: 0, paidAmount: dec(800), prepaymentOffset: dec(300) },
      orderSerializeRoleCtx(UserRole.ADMIN),
    ) as Record<string, any>;
    // balanceDue = 1000 − 800 − 300 = −100（多付）
    expect(out.balanceDue).toBe('-100');
  });

  it('prepaymentOffset=0 时与旧口径一致（无回归）', () => {
    const out = serializeOrder(
      { ...buildOrder(), total: dec(1000), adjustmentCny: 200, paidAmount: dec(1000), prepaymentOffset: dec(0) },
      orderSerializeRoleCtx(UserRole.ADMIN),
    ) as Record<string, any>;
    expect(out.effectivePayable).toBe('1200');
    expect(out.balanceDue).toBe('200'); // 1200 − 1000 − 0
  });
});
