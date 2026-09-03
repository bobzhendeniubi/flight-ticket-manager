/**
 * 存量半间行配对键回填 · 判定内核单测（纯函数，零 IO）
 *
 * 这里的每一条「不配」都比「配上」更重要：错配会把两间真实的半间房强行并成一间，
 * 房控看到的可用房量凭空多一间，直接超卖。所以逐条钉死拒绝的理由。
 */
import { describe, expect, it } from 'vitest';
import { OrderItemKind } from '@prisma/client';
import {
  buildBackfillPairKey,
  dateOnly,
  decideItemPair,
  decideRoomGroupPair,
  isHalfRoom,
  readBackfillRoomGroups,
  ROOM_GROUP_UNOWNED_REASON,
  splitFromItemIdOf,
  withGroupPairKey,
  type BackfillItemView,
  type BackfillRoomGroupView,
} from './split-pair-backfill.js';

const TOKEN = 'b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const CHECK_IN = new Date('2026-09-02T00:00:00.000Z');
const CHECK_OUT = new Date('2026-09-05T00:00:00.000Z');

function item(over: Partial<BackfillItemView> = {}): BackfillItemView {
  return {
    id: 'itm_src1',
    orderId: 'ord-a',
    kind: OrderItemKind.HOTEL,
    hotelRoomTypeId: 'rt-1',
    randomStarTier: null,
    hotelCheckIn: CHECK_IN,
    hotelCheckOut: CHECK_OUT,
    roomsBilled: 0.5,
    metadata: {},
    ...over,
  };
}

/** 拆出来的那一半（另一张单、metadata 指回源行）。 */
function splitItem(over: Partial<BackfillItemView> = {}): BackfillItemView {
  return item({
    id: 'itm_new1',
    orderId: 'ord-b',
    metadata: { splitFromItemId: 'itm_src1' },
    ...over,
  });
}

describe('小工具', () => {
  it('date-only 归一化：Date 与 ISO 串都切到 YYYY-MM-DD', () => {
    expect(dateOnly(CHECK_IN)).toBe('2026-09-02');
    expect(dateOnly('2026-09-02T00:00:00.000Z')).toBe('2026-09-02');
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(new Date('not-a-date'))).toBeNull();
  });

  it('半间判定按 0.5 网格（浮点尾数不影响）', () => {
    expect(isHalfRoom(0.5)).toBe(true);
    expect(isHalfRoom(0.5000001)).toBe(true);
    expect(isHalfRoom(1)).toBe(false);
    expect(isHalfRoom(1.5)).toBe(false);
    expect(isHalfRoom(null)).toBe(false);
  });

  it('splitFromItemId 只认非空字符串', () => {
    expect(splitFromItemIdOf({ splitFromItemId: 'itm_src1' })).toBe('itm_src1');
    expect(splitFromItemIdOf({ splitFromItemId: '' })).toBeNull();
    expect(splitFromItemIdOf(null)).toBeNull();
    expect(splitFromItemIdOf([1, 2])).toBeNull();
  });

  it('键 = 源行id:backfill-token；没有 token 时回落到新行 id', () => {
    expect(buildBackfillPairKey('itm_src1', TOKEN, 'itm_new1')).toBe(`itm_src1:backfill-${TOKEN}`);
    expect(buildBackfillPairKey('itm_src1', null, 'itm_new1')).toBe('itm_src1:backfill-itm_new1');
    expect(buildBackfillPairKey('itm_src1', '', 'itm_new1')).toBe('itm_src1:backfill-itm_new1');
  });
});

describe('decideItemPair · 配上的那一种', () => {
  it('两行都是半间、同房型同日期、跨单、都没键 → 给出配对键', () => {
    const d = decideItemPair(splitItem(), item(), TOKEN);
    expect(d).toEqual({ ok: true, splitPairKey: `itm_src1:backfill-${TOKEN}` });
  });

  it('BUNDLE 行同样参与配对', () => {
    const d = decideItemPair(
      splitItem({ kind: OrderItemKind.BUNDLE }),
      item({ kind: OrderItemKind.BUNDLE }),
      TOKEN,
    );
    expect(d.ok).toBe(true);
  });

  it('星级随机档（无具体房型）两侧档次一致也能配', () => {
    const d = decideItemPair(
      splitItem({ hotelRoomTypeId: null, randomStarTier: 4 }),
      item({ hotelRoomTypeId: null, randomStarTier: 4 }),
      TOKEN,
    );
    expect(d.ok).toBe(true);
  });

  it('日期是 ISO 串（JSON 来源）也认', () => {
    const d = decideItemPair(
      splitItem({ hotelCheckIn: '2026-09-02T00:00:00.000Z', hotelCheckOut: '2026-09-05' }),
      item(),
      TOKEN,
    );
    expect(d.ok).toBe(true);
  });

  it('拆单记录取不到 token 时键回落到新行 id（照样唯一）', () => {
    const d = decideItemPair(splitItem(), item(), null);
    expect(d).toEqual({ ok: true, splitPairKey: 'itm_src1:backfill-itm_new1' });
  });
});

describe('decideItemPair · 一律不配的那些', () => {
  const cases: Array<[string, BackfillItemView, BackfillItemView | null, RegExp]> = [
    ['新行不是拆出来的行', splitItem({ metadata: {} }), item(), /splitFromItemId/],
    ['行类型不参与配对', splitItem({ kind: OrderItemKind.FLIGHT }), item(), /不参与房间配对/],
    ['新行不是半间', splitItem({ roomsBilled: 1 }), item(), /新行 roomsBilled/],
    ['源行不存在', splitItem(), null, /不存在/],
    ['源行也得是半间', splitItem(), item({ roomsBilled: 1 }), /源行 roomsBilled/],
    ['同一张单里的两半不需要键', splitItem({ orderId: 'ord-a' }), item(), /同一张订单/],
    ['行类型对不上', splitItem(), item({ kind: OrderItemKind.BUNDLE }), /类型/],
    ['房型对不上', splitItem(), item({ hotelRoomTypeId: 'rt-2' }), /同一个酒店房型/],
    [
      '随机档对不上',
      splitItem({ hotelRoomTypeId: null, randomStarTier: 3 }),
      item({ hotelRoomTypeId: null, randomStarTier: 4 }),
      /星级随机档/,
    ],
    [
      '入住日期对不上',
      splitItem({ hotelCheckIn: new Date('2026-09-03T00:00:00.000Z') }),
      item(),
      /入住区间/,
    ],
    ['退房日期缺失', splitItem({ hotelCheckOut: null }), item(), /入住区间/],
    [
      '源行已有键（不覆盖）',
      splitItem(),
      item({ metadata: { splitPairKey: 'itm_src1:real-token' } }),
      /已有配对键/,
    ],
    [
      '新行已有键（不覆盖）',
      splitItem({ metadata: { splitFromItemId: 'itm_src1', splitPairKey: 'x:y' } }),
      item(),
      /已有配对键/,
    ],
  ];

  for (const [name, split, source, reason] of cases) {
    it(name, () => {
      const d = decideItemPair(split, source, TOKEN);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.reason).toMatch(reason);
    });
  }

  it('源行 id 与 splitFromItemId 不一致（调用方拿错行）也拒', () => {
    const d = decideItemPair(splitItem(), item({ id: 'itm_other' }), TOKEN);
    expect(d.ok).toBe(false);
  });
});

describe('decideRoomGroupPair · 分房表两个半房组', () => {
  function group(over: Partial<BackfillRoomGroupView> = {}): BackfillRoomGroupView {
    return {
      id: 'g1',
      hotelName: '椰岛湾酒店',
      roomType: '双床房',
      passengerIds: ['p-1'],
      roomFraction: 0.5,
      orderItemId: 'itm_src1',
      ...over,
    };
  }

  it('各恰一个、酒店房型一致 → 配对', () => {
    const d = decideRoomGroupPair(
      [group(), group({ id: 'g-full', roomFraction: 1, orderItemId: 'itm_other' })],
      [group({ id: 'g2', orderItemId: 'itm_new1' })],
      'itm_src1',
      'itm_new1',
    );
    expect(d).toEqual({ ok: true, sourceIndex: 0, splitIndex: 0 });
  });

  // 老分房表（没写 orderItemId）一律不配：一张单有两行住宿时，「按本单兜底」会把另一行的
  // 半房组配过来，两间真房并成一间 —— 房控看到的可用房量凭空多一间，直接超卖。
  it('没写 orderItemId 的老分房表一律跳过交人工（宁可不配）', () => {
    const d = decideRoomGroupPair(
      [group({ orderItemId: undefined })],
      [group({ id: 'g2', orderItemId: undefined })],
      'itm_src1',
      'itm_new1',
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe(ROOM_GROUP_UNOWNED_REASON);
  });

  it('一侧写了归属、另一侧没写 → 照样不配（半边兜底也不行）', () => {
    const d = decideRoomGroupPair(
      [group()],
      [group({ id: 'g2', orderItemId: undefined })],
      'itm_src1',
      'itm_new1',
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe(ROOM_GROUP_UNOWNED_REASON);
  });

  it('归属指向别的行 → 不算候选（不会被误当成这一行的半间）', () => {
    const d = decideRoomGroupPair(
      [group({ orderItemId: 'itm_other_hotel_row' })],
      [group({ id: 'g2', orderItemId: 'itm_new1' })],
      'itm_src1',
      'itm_new1',
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/没有可配对的半房组/);
  });

  it('房组自带入住区间且对不上 → 不配（订单行区间之外的加保）', () => {
    const d = decideRoomGroupPair(
      [group({ checkIn: '2026-09-02', checkOut: '2026-09-05' } as BackfillRoomGroupView)],
      [
        group({
          id: 'g2',
          orderItemId: 'itm_new1',
          checkIn: '2026-09-03',
          checkOut: '2026-09-05',
        } as BackfillRoomGroupView),
      ],
      'itm_src1',
      'itm_new1',
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/入住区间对不上/);
  });

  it('房组自带入住区间且一致 → 照常配对', () => {
    const d = decideRoomGroupPair(
      [group({ checkIn: '2026-09-02', checkOut: '2026-09-05' } as BackfillRoomGroupView)],
      [
        group({
          id: 'g2',
          orderItemId: 'itm_new1',
          checkIn: '2026-09-02',
          checkOut: '2026-09-05',
        } as BackfillRoomGroupView),
      ],
      'itm_src1',
      'itm_new1',
    );
    expect(d).toEqual({ ok: true, sourceIndex: 0, splitIndex: 0 });
  });

  it('一侧有两个候选 → 不猜，跳过交人工', () => {
    const d = decideRoomGroupPair(
      [group(), group({ id: 'g1b' })],
      [group({ id: 'g2', orderItemId: 'itm_new1' })],
      'itm_src1',
      'itm_new1',
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/不唯一/);
  });

  it('一侧一个候选都没有 → 不配', () => {
    const d = decideRoomGroupPair([group()], [], 'itm_src1', 'itm_new1');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/没有可配对的半房组/);
  });

  it('整间 / 空房组 / 已有键的房组都不算候选', () => {
    expect(
      decideRoomGroupPair([group({ roomFraction: 1 })], [group()], 'itm_src1', 'itm_src1').ok,
    ).toBe(false);
    expect(
      decideRoomGroupPair([group({ passengerIds: [] })], [group()], 'itm_src1', 'itm_src1').ok,
    ).toBe(false);
    expect(
      decideRoomGroupPair([group({ splitPairKey: 'a:b' })], [group()], 'itm_src1', 'itm_src1').ok,
    ).toBe(false);
  });

  it('酒店 / 房型对不上 → 不配', () => {
    const d = decideRoomGroupPair(
      [group()],
      [group({ id: 'g2', orderItemId: 'itm_new1', roomType: '大床房' })],
      'itm_src1',
      'itm_new1',
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/房型对不上/);
  });
});

describe('roomAssignment 读写', () => {
  it('形状不符一律按无分房处理（读侧不抛错）', () => {
    expect(readBackfillRoomGroups(null)).toEqual([]);
    expect(readBackfillRoomGroups({ roomGroups: 'oops' })).toEqual([]);
    expect(readBackfillRoomGroups({ roomGroups: [null, 1, { id: 'g1' }] })).toEqual([{ id: 'g1' }]);
  });

  it('写键只改指定那一组，其余原样，且不改原对象', () => {
    const original = {
      version: 2,
      roomGroups: [{ id: 'g1', roomFraction: 0.5 }, { id: 'g2' }],
    };
    const next = withGroupPairKey(original, 0, 'itm_src1:backfill-x');
    expect(next).toEqual({
      version: 2,
      roomGroups: [
        { id: 'g1', roomFraction: 0.5, splitPairKey: 'itm_src1:backfill-x' },
        { id: 'g2' },
      ],
    });
    expect(original.roomGroups[0]).not.toHaveProperty('splitPairKey');
  });
});
