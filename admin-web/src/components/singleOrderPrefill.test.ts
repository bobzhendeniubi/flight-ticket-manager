/**
 * 「以此单为模板」预填映射的回归。
 *
 * 守两条线：
 *   1. 带对该带的（产品类型 / 套餐 / 代理 / 联系人 / 五类备注 / 签证状态）——
 *      少带一样，运营就得回去看源单再敲一遍，这功能也就没意义了；
 *   2. **绝不带**出行人、日期、金额 —— 模板悄悄把上一单的钱或人带进新单，
 *      是这类功能最容易出的事故，这里用「字段白名单」把它钉死。
 */
import { describe, it, expect } from 'vitest';
import { buildSingleOrderPrefill } from './singleOrderPrefill';
import type { OrderItem, OrderItemKind, OrderSummary } from '../lib/api';

let seq = 0;
function item(kind: OrderItemKind, extra: Partial<OrderItem> = {}): OrderItem {
  seq += 1;
  return {
    id: `it-${kind}-${seq}`,
    kind,
    description: `${kind} 行`,
    quantity: 1,
    unitPrice: '0',
    amount: '0',
    flightScheduleId: null,
    flightCabin: null,
    hotelRoomTypeId: null,
    hotelCheckIn: null,
    hotelCheckOut: null,
    transferId: null,
    visaId: null,
    metadata: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

function order(partial: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: 'ord-1',
    orderNumber: 'FTM2026090100001',
    userId: 'usr-1',
    agentId: null,
    status: 'PAID',
    currency: 'CNY',
    subtotal: '0',
    total: '0',
    paidAmount: '0',
    balanceDue: '0',
    contactName: '',
    contactPhone: '',
    contactEmail: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    items: [],
    passengers: [],
    agent: null,
    user: { id: 'usr-1', displayName: null, email: null },
    ...partial,
  };
}

describe('产品类型推导', () => {
  it('套餐单：只给一个套餐区块，并带上套餐 id（套餐独占一张单）', () => {
    const p = buildSingleOrderPrefill(
      order({
        items: [
          item('BUNDLE', { bundleId: 'bdl-1' }),
          // 套餐的机票腿也挂同一个 bundleId，不该额外生出机票区块
          item('FLIGHT', { bundleId: 'bdl-1' }),
          item('FLIGHT', { bundleId: 'bdl-1' }),
        ],
      }),
    );
    expect(p.blockKinds).toEqual(['BUNDLE']);
    expect(p.bundleId).toBe('bdl-1');
  });

  it('往返机票 + 酒店：两个区块，机票区块是往返', () => {
    const p = buildSingleOrderPrefill(
      order({ items: [item('FLIGHT'), item('FLIGHT'), item('HOTEL')] }),
    );
    expect(p.blockKinds).toEqual(['FLIGHT', 'HOTEL']);
    expect(p.flightTripType).toBe('ROUNDTRIP');
    expect(p.bundleId).toBe('');
  });

  it('单程机票：机票区块是单程', () => {
    const p = buildSingleOrderPrefill(order({ items: [item('FLIGHT')] }));
    expect(p.blockKinds).toEqual(['FLIGHT']);
    expect(p.flightTripType).toBe('ONEWAY');
  });

  it('同类型多条只给一个区块，顺序按首次出现', () => {
    const p = buildSingleOrderPrefill(
      order({ items: [item('VISA'), item('HOTEL'), item('HOTEL'), item('VISA')] }),
    );
    expect(p.blockKinds).toEqual(['VISA', 'HOTEL']);
  });

  it('调价 / 折扣 / 保险等非可录产品行不生成区块', () => {
    const p = buildSingleOrderPrefill(
      order({ items: [item('DISCOUNT'), item('FEE'), item('INSURANCE'), item('TRANSFER')] }),
    );
    expect(p.blockKinds).toEqual(['TRANSFER']);
  });

  it('一条可录产品行都没有 → 空数组（交给弹窗回落到默认机票区块）', () => {
    const p = buildSingleOrderPrefill(order({ items: [item('DISCOUNT')] }));
    expect(p.blockKinds).toEqual([]);
    expect(p.flightTripType).toBe('ONEWAY');
  });
});

describe('客户侧字段', () => {
  it('代理 / 联系人 / 五类备注 / 签证状态照原样带过来（首尾空格去掉）', () => {
    const p = buildSingleOrderPrefill(
      order({
        agentId: 'agt-1',
        contactName: ' 联系人甲 ',
        contactPhone: '13800000000',
        contactEmail: 'ops@example.com',
        notes: ' 通用备注 ',
        noteHotel: '大床房',
        noteVisa: '材料齐',
        notePayment: '尾款下周',
        noteSpecial: '靠窗',
        visaStatus: 'E_VISA',
      }),
    );
    expect(p).toMatchObject({
      agentId: 'agt-1',
      contactName: '联系人甲',
      contactPhone: '13800000000',
      contactEmail: 'ops@example.com',
      notes: '通用备注',
      noteHotel: '大床房',
      noteVisa: '材料齐',
      notePayment: '尾款下周',
      noteSpecial: '靠窗',
      visaStatus: 'E_VISA',
    });
  });

  it('直客单 / 各字段为空：代理与备注是空串，签证状态是 null（交回弹窗按产品派生默认值）', () => {
    const p = buildSingleOrderPrefill(order());
    expect(p.agentId).toBe('');
    expect(p.contactEmail).toBe('');
    expect(p.noteHotel).toBe('');
    expect(p.visaStatus).toBeNull();
  });
});

describe('绝不带过来的东西', () => {
  it('预填对象的字段是一份白名单：没有乘客、没有日期、没有任何金额', () => {
    const p = buildSingleOrderPrefill(
      order({
        total: '19800',
        paidAmount: '19800',
        adjustmentCny: 450,
        departDate: '2026-09-20',
        passengers: [{ id: 'pax-1', fullName: 'ZHANG/SAN' } as OrderSummary['passengers'][number]],
        items: [item('FLIGHT', { hotelCheckIn: '2026-09-20' })],
      }),
    );
    expect(Object.keys(p).sort()).toEqual(
      [
        'agentId',
        'blockKinds',
        'bundleId',
        'contactEmail',
        'contactName',
        'contactPhone',
        'flightTripType',
        'notePayment',
        'noteSpecial',
        'noteHotel',
        'noteVisa',
        'notes',
        'visaStatus',
      ].sort(),
    );
  });
});
