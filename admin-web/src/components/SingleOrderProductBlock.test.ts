/**
 * 手工录单 · 产品区块 → 订单行 的纯函数单测。
 *
 * 守的是两条不能破的线：
 *   1. 混合单：多个区块各自产出的订单行能合并进同一张单，行与行互不串味；
 *   2. 服务端权威定价：区块只送产品引用 + 数量/日期，unitPrice 只能是「产品现价占位」，
 *      运营在界面上没有任何手填价的口子（星级随机档是唯一既有例外，它本就没有房型可查价）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildProductBlockItems,
  createProductBlock,
  nightsBetween,
  type ProductBlock,
  type ProductBlockBuildContext,
} from './SingleOrderProductBlock';

const ctx: ProductBlockBuildContext = {
  flights: [
    { id: 'flt-go', flightNumber: 'QH9587', originCode: 'MFM', destinationCode: 'DAD', isActive: true },
    { id: 'flt-back', flightNumber: 'QH9588', originCode: 'DAD', destinationCode: 'MFM', isActive: true },
  ] as unknown as ProductBlockBuildContext['flights'],
  hotels: [
    {
      id: 'htl-1',
      name: '海景酒店',
      cityCode: 'DAD',
      starRating: 4,
      roomTypes: [{ id: 'rt-1', name: '豪华大床房', basePrice: '680' }],
    },
  ] as unknown as ProductBlockBuildContext['hotels'],
  visas: [
    {
      id: 'visa-1',
      visaName: '越南旅游签',
      destinationCountry: '越南',
      basePrice: '400',
      expressTiers: [{ label: '一工', workDays: 1, surchargeCny: 300 }],
    },
  ] as unknown as ProductBlockBuildContext['visas'],
  transfers: [
    { id: 'trf-1', name: '机场接机', originArea: '岘港机场', destArea: '市区', basePrice: '150' },
  ] as unknown as ProductBlockBuildContext['transfers'],
  seatPax: 2,
};

function flightBlock(patch: Partial<ProductBlock> = {}): ProductBlock {
  return {
    ...createProductBlock('FLIGHT'),
    flightId: 'flt-go',
    scheduleId: 'sch-go',
    scheduleDate: '2026-09-03',
    cabin: 'ECONOMY',
    ...patch,
  };
}

function hotelBlock(patch: Partial<ProductBlock> = {}): ProductBlock {
  return {
    ...createProductBlock('HOTEL'),
    hotelId: 'htl-1',
    roomTypeId: 'rt-1',
    checkIn: '2026-09-03',
    checkOut: '2026-09-04',
    rooms: 1,
    ...patch,
  };
}

describe('buildProductBlockItems', () => {
  it('单程机票产出一条 FLIGHT 行，数量等于出行人数（不按航段翻倍）', () => {
    const built = buildProductBlockItems(flightBlock(), ctx);
    if (!('items' in built)) throw new Error(built.error);
    expect(built.items).toHaveLength(1);
    expect(built.items[0]).toMatchObject({
      kind: 'FLIGHT',
      quantity: 2,
      flightScheduleId: 'sch-go',
      flightCabin: 'ECONOMY',
    });
    // FLIGHT 行不带价：服务端按班次舱位权威定价。
    expect((built.items[0] as Record<string, unknown>).unitPrice).toBeUndefined();
  });

  it('往返机票产出去程 + 回程两条行，两条数量都等于出行人数', () => {
    const built = buildProductBlockItems(
      flightBlock({
        tripType: 'ROUNDTRIP',
        returnFlightId: 'flt-back',
        returnScheduleId: 'sch-back',
        returnScheduleDate: '2026-09-13',
        returnCabin: 'ECONOMY',
      }),
      ctx,
    );
    if (!('items' in built)) throw new Error(built.error);
    expect(built.items).toHaveLength(2);
    expect(built.items.map((i) => i.quantity)).toEqual([2, 2]);
    expect(built.items[0].description).toContain('去程');
    expect(built.items[1].description).toContain('回程');
  });

  it('往返缺回程班次时报错，不产出半张行程', () => {
    const built = buildProductBlockItems(flightBlock({ tripType: 'ROUNDTRIP' }), ctx);
    expect(built).toEqual({ error: '往返需选择回程航班班次和舱位' });
  });

  it('酒店行按晚数计量，单价取房型现价（服务端会比对，前端不给手填口子）', () => {
    const built = buildProductBlockItems(hotelBlock(), ctx);
    if (!('items' in built)) throw new Error(built.error);
    expect(built.items).toHaveLength(1);
    expect(built.items[0]).toMatchObject({
      kind: 'HOTEL',
      quantity: 1, // 9/3 入住、9/4 退房 = 1 晚
      hotelRoomTypeId: 'rt-1',
      checkIn: '2026-09-03',
      checkOut: '2026-09-04',
      unitPrice: 680,
    });
  });

  it('退房不晚于入住时报错', () => {
    const built = buildProductBlockItems(hotelBlock({ checkOut: '2026-09-03' }), ctx);
    expect(built).toEqual({ error: '退房日期需晚于入住日期' });
  });

  it('签证加急只送档名，加价按产品档位表算进单价供服务端比对', () => {
    const block: ProductBlock = {
      ...createProductBlock('VISA'),
      visaId: 'visa-1',
      visaQty: 2,
      visaExpressTierLabel: '一工',
    };
    const built = buildProductBlockItems(block, ctx);
    if (!('items' in built)) throw new Error(built.error);
    expect(built.items[0]).toMatchObject({
      kind: 'VISA',
      quantity: 2,
      visaId: 'visa-1',
      unitPrice: 700, // 400 基价 + 300 加急
      metadata: { expressTierLabel: '一工' },
    });
  });

  it('接送行带用车日期，单价取产品现价', () => {
    const block: ProductBlock = {
      ...createProductBlock('TRANSFER'),
      transferId: 'trf-1',
      transferQty: 1,
      transferDate: '2026-09-03',
    };
    const built = buildProductBlockItems(block, ctx);
    if (!('items' in built)) throw new Error(built.error);
    expect(built.items[0]).toMatchObject({
      kind: 'TRANSFER',
      transferId: 'trf-1',
      unitPrice: 150,
      metadata: { date: '2026-09-03' },
    });
  });

  it('未选产品的区块报错，不产出空行', () => {
    expect(buildProductBlockItems(createProductBlock('VISA'), ctx)).toEqual({ error: '请选择签证产品' });
    expect(buildProductBlockItems(createProductBlock('TRANSFER'), ctx)).toEqual({ error: '请选择接送产品' });
    expect(buildProductBlockItems(createProductBlock('HOTEL'), ctx)).toEqual({ error: '请选择酒店和房型' });
  });

  it('套餐区块不在这里生成订单行（套餐由录单弹窗自己的分支负责）', () => {
    expect(buildProductBlockItems(createProductBlock('BUNDLE'), ctx)).toHaveProperty('error');
  });

  it('往返机票 + 只住一晚酒店：三条行合成一张单，各行互不串味', () => {
    // 这正是改动的由来：这类单以前只能拆成机票、酒店两张订单。
    const blocks: ProductBlock[] = [
      flightBlock({
        tripType: 'ROUNDTRIP',
        returnFlightId: 'flt-back',
        returnScheduleId: 'sch-back',
        returnScheduleDate: '2026-09-13',
        returnCabin: 'ECONOMY',
      }),
      hotelBlock(),
    ];
    const merged = blocks.flatMap((b) => {
      const r = buildProductBlockItems(b, ctx);
      if (!('items' in r)) throw new Error(r.error);
      return r.items;
    });
    expect(merged.map((i) => i.kind)).toEqual(['FLIGHT', 'FLIGHT', 'HOTEL']);
    // 机票按人头、酒店按晚数：两套计量口径不能互相污染。
    expect(merged.map((i) => i.quantity)).toEqual([2, 2, 1]);
    // 后端 items 上限 20 条，这类单离上限很远。
    expect(merged.length).toBeLessThanOrEqual(20);
  });

  it('同类型可以录多条（两段单订酒店），各自独立成行', () => {
    const blocks: ProductBlock[] = [
      hotelBlock(),
      hotelBlock({ checkIn: '2026-09-10', checkOut: '2026-09-12', rooms: 2 }),
    ];
    const merged = blocks.flatMap((b) => {
      const r = buildProductBlockItems(b, ctx);
      if (!('items' in r)) throw new Error(r.error);
      return r.items;
    });
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ quantity: 2, metadata: { rooms: 2 } });
  });
});

describe('nightsBetween', () => {
  it('按整日差计晚数，非正区间返回 0', () => {
    expect(nightsBetween('2026-09-03', '2026-09-04')).toBe(1);
    expect(nightsBetween('2026-09-03', '2026-09-13')).toBe(10);
    expect(nightsBetween('2026-09-03', '2026-09-03')).toBe(0);
    expect(nightsBetween('2026-09-04', '2026-09-03')).toBe(0);
  });
});
