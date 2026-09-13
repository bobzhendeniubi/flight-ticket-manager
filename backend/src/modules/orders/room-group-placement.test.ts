/**
 * 房组落位名口径 · 纯函数单测（不依赖 DB）。
 *
 * 背景：套餐改档后产品内容已是三星，导出《全岗可用》「酒店类型」仍印「四星 2天1晚 岘港」——
 * 分房表房组的 hotelName 是改档前分房弹窗按套餐行 description 首段存下来的套餐名，改档没刷它，
 * 而导出刻意优先取房组文本。这里锁住：落位名解析 / 房组刷新匹配 / 派生行前缀改名 / 套餐名识别。
 */
import { describe, it, expect } from 'vitest';
import {
  PENDING_PLACEMENT_ROOM_TYPE,
  isBundleLikeHotelText,
  randomStarTierLabel,
  planRoomGroupTextBackfill,
  randomStarTierShortLabel,
  readRoomGroupArray,
  refreshRoomGroupsForItem,
  renameBundlePrefixedDescription,
  resolveRoomGroupPlacement,
  roomGroupItemId,
} from './room-group-placement.js';

describe('randomStarTierLabel', () => {
  it('3/4/5 → 「X星随机（待落位）」；枚举外档次回落「N星」；空档次返回空串', () => {
    expect(randomStarTierLabel(3)).toBe('三星随机（待落位）');
    expect(randomStarTierLabel(5)).toBe('五星随机（待落位）');
    expect(randomStarTierLabel(7)).toBe('7星随机（待落位）');
    expect(randomStarTierLabel(null)).toBe('');
    expect(randomStarTierLabel(undefined)).toBe('');
  });

  it('短档次名（列表 / 审计用）不带「待落位」后缀', () => {
    expect(randomStarTierShortLabel(4)).toBe('四星随机');
    expect(randomStarTierShortLabel(null)).toBe('');
  });
});

describe('resolveRoomGroupPlacement', () => {
  it('真酒店 FK → 酒店名 + 房型名，pending=false', () => {
    expect(
      resolveRoomGroupPlacement({
        hotelRoomType: { name: '高级双床', hotel: { name: '岘港明月酒店', randomTierPlaceholder: null } },
      }),
    ).toEqual({ hotelName: '岘港明月酒店', roomType: '高级双床', pending: false, pendingTier: null });
  });

  it('房型挂在随机档占位酒店上（伪落位）→ 「X星随机（待落位）」+「待落位」，不用占位酒店字面名', () => {
    expect(
      resolveRoomGroupPlacement({
        hotelRoomType: { name: '标准间', hotel: { name: '随机三星', randomTierPlaceholder: 3 } },
      }),
    ).toEqual({
      hotelName: '三星随机（待落位）',
      roomType: PENDING_PLACEMENT_ROOM_TYPE,
      pending: true,
      pendingTier: 3,
    });
  });

  it('无 FK、只有 randomStarTier 的随机行 → 同样按档次出「待落位」', () => {
    expect(resolveRoomGroupPlacement({ hotelRoomType: null, randomStarTier: 4 })).toEqual({
      hotelName: '四星随机（待落位）',
      roomType: PENDING_PLACEMENT_ROOM_TYPE,
      pending: true,
      pendingTier: 4,
    });
  });

  it('联查没带 randomTierPlaceholder（旧调用方）→ 按真酒店显示，不误判', () => {
    expect(
      resolveRoomGroupPlacement({ hotelRoomType: { name: '大床', hotel: { name: '真酒店' } } })?.pending,
    ).toBe(false);
  });

  it('无 FK 也无档次 → null（调用方自行决定不动 / 留空）', () => {
    expect(resolveRoomGroupPlacement({ hotelRoomType: null, randomStarTier: null })).toBeNull();
    expect(resolveRoomGroupPlacement({})).toBeNull();
  });
});

describe('readRoomGroupArray / roomGroupItemId', () => {
  it('形状不符（null / 数组 / 无 roomGroups / roomGroups 不是数组）→ null', () => {
    expect(readRoomGroupArray(null)).toBeNull();
    expect(readRoomGroupArray([])).toBeNull();
    expect(readRoomGroupArray({})).toBeNull();
    expect(readRoomGroupArray({ roomGroups: 'x' })).toBeNull();
    expect(readRoomGroupArray({ roomGroups: [{ id: 'g1' }] })).toEqual([{ id: 'g1' }]);
  });

  it('归属 id 只认非空字符串', () => {
    expect(roomGroupItemId({ orderItemId: 'it-1' })).toBe('it-1');
    expect(roomGroupItemId({ orderItemId: '' })).toBeNull();
    expect(roomGroupItemId({})).toBeNull();
    expect(roomGroupItemId(null)).toBeNull();
  });
});

describe('refreshRoomGroupsForItem', () => {
  const placement = { hotelName: '三星随机（待落位）', roomType: PENDING_PLACEMENT_ROOM_TYPE };

  it('本行有归属组 → 只改归属到本行的组，其余键（乘客 / 半间 / 配对键）原样保留', () => {
    const roomAssignment = {
      version: 2,
      roomGroups: [
        {
          id: 'g1',
          hotelName: '四星 2天1晚 岘港',
          roomType: '',
          passengerIds: ['p1'],
          orderItemId: 'bundle-1',
          roomFraction: 0.5,
          splitPairKey: 'k-1',
        },
        { id: 'g2', hotelName: '别的酒店', roomType: '大床', passengerIds: ['p2'], orderItemId: 'hotel-9' },
        { id: 'g3', hotelName: '四星 2天1晚 岘港', roomType: '', passengerIds: ['p3'] },
      ],
    };

    const res = refreshRoomGroupsForItem(roomAssignment, 'bundle-1', placement, {
      legacyMatch: (g) => g.hotelName === '四星 2天1晚 岘港',
    });

    expect(res.changed).toBe(true);
    expect(res.roomAssignment.version).toBe(2);
    const groups = res.roomAssignment.roomGroups as Array<Record<string, unknown>>;
    expect(groups[0]).toEqual({
      id: 'g1',
      hotelName: '三星随机（待落位）',
      roomType: '待落位',
      passengerIds: ['p1'],
      orderItemId: 'bundle-1',
      roomFraction: 0.5,
      splitPairKey: 'k-1',
    });
    // 归属到其它行的组不动；本行已有归属组时，无归属的旧文本组也不走 legacyMatch（精确归属优先）
    expect(groups[1]).toEqual(roomAssignment.roomGroups[1]);
    expect(groups[2]).toEqual(roomAssignment.roomGroups[2]);
    expect(res.touched).toEqual([
      {
        groupId: 'g1',
        orderItemId: 'bundle-1',
        before: { hotelName: '四星 2天1晚 岘港', roomType: '' },
        after: { hotelName: '三星随机（待落位）', roomType: '待落位' },
      },
    ]);
    // 不可变：入参没被就地改
    expect(roomAssignment.roomGroups[0].hotelName).toBe('四星 2天1晚 岘港');
  });

  it('本行无归属组 → 只对「无归属 + legacyMatch 命中」的组生效；归属到其它行的同名组绝不改', () => {
    const roomAssignment = {
      roomGroups: [
        { id: 'g1', hotelName: '旧酒店', roomType: '旧房型', passengerIds: ['p1'] },
        { id: 'g2', hotelName: '旧酒店', roomType: '旧房型', passengerIds: ['p2'], orderItemId: 'other' },
        { id: 'g3', hotelName: '旧酒店', roomType: '另一房型', passengerIds: ['p3'] },
      ],
    };
    const res = refreshRoomGroupsForItem(
      roomAssignment,
      'hotel-1',
      { hotelName: '新酒店', roomType: '新房型' },
      { legacyMatch: (g) => g.hotelName === '旧酒店' && g.roomType === '旧房型' },
    );
    const groups = res.roomAssignment.roomGroups as Array<Record<string, unknown>>;
    expect(groups.map((g) => g.hotelName)).toEqual(['新酒店', '旧酒店', '旧酒店']);
    expect(groups[0].roomType).toBe('新房型');
  });

  it('不传 legacyMatch → 只认精确归属', () => {
    const res = refreshRoomGroupsForItem(
      { roomGroups: [{ id: 'g1', hotelName: '旧酒店', roomType: '', passengerIds: [] }] },
      'hotel-1',
      { hotelName: '新酒店', roomType: 'x' },
    );
    expect(res.changed).toBe(false);
    expect(res.touched).toEqual([]);
  });

  it('文本已经一致 → changed=false（不产生无意义写库）', () => {
    const res = refreshRoomGroupsForItem(
      { roomGroups: [{ id: 'g1', hotelName: 'A', roomType: 'B', orderItemId: 'it' }] },
      'it',
      { hotelName: 'A', roomType: 'B' },
    );
    expect(res.changed).toBe(false);
  });

  it('roomAssignment 形状不符 / 无分房 → changed=false，不抛错', () => {
    expect(refreshRoomGroupsForItem(null, 'it', placement).changed).toBe(false);
    expect(refreshRoomGroupsForItem({ roomGroups: 'bad' }, 'it', placement).changed).toBe(false);
    expect(refreshRoomGroupsForItem({ roomGroups: [null, 3, 'x'] }, 'it', placement).changed).toBe(false);
  });
});

describe('renameBundlePrefixedDescription', () => {
  it('精确前缀「<旧套餐名> · 」→ 换成新套餐名，其余原样', () => {
    expect(
      renameBundlePrefixedDescription('四星 2天1晚 岘港 · 去程（经济舱）', '四星 2天1晚 岘港', '三星 2天1晚 岘港'),
    ).toBe('三星 2天1晚 岘港 · 去程（经济舱）');
  });

  it('不是该前缀（差额行 / 套餐行本身 / 名字只是包含）→ null', () => {
    expect(
      renameBundlePrefixedDescription(
        '套餐改档差额：四星 2天1晚 岘港 → 三星 2天1晚 岘港（−¥200）',
        '四星 2天1晚 岘港',
        '三星 2天1晚 岘港',
      ),
    ).toBeNull();
    expect(renameBundlePrefixedDescription('四星 2天1晚 岘港', '四星 2天1晚 岘港', '三星 2天1晚 岘港')).toBeNull();
    expect(renameBundlePrefixedDescription('四星 2天1晚 岘港升级版 · 去程', '四星 2天1晚 岘港', 'X')).toBeNull();
  });

  it('旧名为空 / 新旧同名 → null', () => {
    expect(renameBundlePrefixedDescription('A · 去程', null, 'B')).toBeNull();
    expect(renameBundlePrefixedDescription('A · 去程', '', 'B')).toBeNull();
    expect(renameBundlePrefixedDescription('A · 去程', 'A', 'A')).toBeNull();
  });
});

describe('isBundleLikeHotelText', () => {
  it('含「N天N晚」的文本视为套餐名', () => {
    expect(isBundleLikeHotelText('四星 2天1晚 岘港')).toBe(true);
    expect(isBundleLikeHotelText('岘港3天2晚随机')).toBe(true);
    expect(isBundleLikeHotelText('五星 4 天 3 晚 芽庄')).toBe(true);
  });

  it('真实酒店名 / 手填备注式酒店名 / 待落位文案 / 空值 → 不算', () => {
    expect(isBundleLikeHotelText('岘港明月酒店')).toBe(false);
    expect(isBundleLikeHotelText('岘港 A酒店(待定/换房中)')).toBe(false);
    expect(isBundleLikeHotelText('三星随机（待落位）')).toBe(false);
    expect(isBundleLikeHotelText('')).toBe(false);
    expect(isBundleLikeHotelText(null)).toBe(false);
  });
});

describe('planRoomGroupTextBackfill（存量回填判定内核）', () => {
  const OLD = '四星 2天1晚 岘港';
  const NEW = '三星 2天1晚 岘港';
  const bundleRow = (over: Record<string, unknown> = {}) => ({
    id: 'item-bundle',
    kind: 'BUNDLE',
    description: NEW,
    metadata: { bundleChange: { fromBundleName: OLD, toBundleName: NEW } },
    hotelRoomType: { name: '标准间', hotel: { name: '随机三星', randomTierPlaceholder: 3 } },
    randomStarTier: null,
    ...over,
  });
  const flight = (id: string, leg: string, prefix = OLD) => ({
    id,
    kind: 'FLIGHT',
    description: `${prefix} · ${leg}（经济舱）`,
    metadata: {},
    hotelRoomType: null,
    randomStarTier: null,
  });
  const diffRow = (from = OLD, to = NEW) => ({
    id: `item-diff-${from}`,
    kind: 'DISCOUNT',
    description: `套餐改档差额：${from} → ${to}（−¥200）`,
    metadata: { priceAdjustment: true, bundleChange: true },
    hotelRoomType: null,
    randomStarTier: null,
  });
  const order = (roomGroups: unknown[] | null, items: unknown[]) => ({
    id: 'o1',
    orderNumber: 'FTM-1',
    roomAssignment: roomGroups ? { roomGroups } : null,
    items: items as never,
  });

  it('实测场景：改档后房组仍是旧套餐名、机票腿仍是旧前缀 → 房组改「三星随机（待落位）」/「待落位」，两腿换新前缀，差额行与套餐行不动', () => {
    const plan = planRoomGroupTextBackfill(
      order(
        [{ id: 'g1', hotelName: OLD, roomType: '', passengerIds: ['p1'], orderItemId: 'item-bundle', roomFraction: 0.5 }],
        [bundleRow(), flight('item-go', '去程'), flight('item-back', '回程'), diffRow()],
      ),
    );
    expect(plan.groupChanges).toEqual([
      {
        groupId: 'g1',
        orderItemId: 'item-bundle',
        before: { hotelName: OLD, roomType: '' },
        after: { hotelName: '三星随机（待落位）', roomType: '待落位' },
      },
    ]);
    expect((plan.roomAssignment?.roomGroups as Array<Record<string, unknown>>)[0]).toMatchObject({
      hotelName: '三星随机（待落位）',
      roomType: '待落位',
      roomFraction: 0.5,
      passengerIds: ['p1'],
    });
    expect(plan.descriptionChanges).toEqual([
      { itemId: 'item-go', before: `${OLD} · 去程（经济舱）`, after: `${NEW} · 去程（经济舱）` },
      { itemId: 'item-back', before: `${OLD} · 回程（经济舱）`, after: `${NEW} · 回程（经济舱）` },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('房控手填的酒店名与行落位不同 → 不改，记「交人工」', () => {
    const plan = planRoomGroupTextBackfill(
      order([{ id: 'g1', hotelName: '椰林湾度假村', roomType: '海景', passengerIds: [], orderItemId: 'item-bundle' }], [bundleRow()]),
    );
    expect(plan.groupChanges).toEqual([]);
    expect(plan.roomAssignment).toBeNull();
    expect(plan.skipped[0].reason).toContain('交人工');
  });

  it('酒店名是套餐名、房型是房控填的真实文本 → 只改酒店名，房型保留', () => {
    const plan = planRoomGroupTextBackfill(
      order(
        [{ id: 'g1', hotelName: OLD, roomType: '大床', passengerIds: [], orderItemId: 'item-real' }],
        [bundleRow({ id: 'item-real', hotelRoomType: { name: '豪华双床', hotel: { name: '岘港明月酒店', randomTierPlaceholder: null } } })],
      ),
    );
    expect(plan.groupChanges[0].after).toEqual({ hotelName: '岘港明月酒店', roomType: '大床' });
  });

  it('随机档标签文本（占位酒店名「随机X星」/ 短档次名「X星随机」/ 旧档次「四星随机（待落位）」）都算派生残留 → 改成当前落位', () => {
    const items = [bundleRow()];
    for (const text of ['随机三星', '三星随机', '随机四星', '四星随机（待落位）']) {
      const plan = planRoomGroupTextBackfill(
        order([{ id: 'g1', hotelName: text, roomType: '', passengerIds: [], orderItemId: 'item-bundle' }], items),
      );
      expect(plan.groupChanges[0]?.after.hotelName, text).toBe('三星随机（待落位）');
    }
    // 行已落位到真酒店、房组还停在随机档标签 → 同样刷成真酒店名（标签绝不是房控手填）
    const placed = planRoomGroupTextBackfill(
      order(
        [{ id: 'g1', hotelName: '四星随机', roomType: '', passengerIds: [], orderItemId: 'item-real' }],
        [bundleRow({ id: 'item-real', hotelRoomType: { name: '豪华双床', hotel: { name: '岘港明月酒店', randomTierPlaceholder: null } } })],
      ),
    );
    expect(placed.groupChanges[0]?.after).toEqual({ hotelName: '岘港明月酒店', roomType: '豪华双床' });
  });

  it('无归属房组：套餐名 + 本单恰好一条占房行 → 认那一行；占房行不唯一 → 交人工；非套餐名文本 → 静默不动', () => {
    const sole = planRoomGroupTextBackfill(order([{ id: 'g1', hotelName: OLD, roomType: '', passengerIds: [] }], [bundleRow(), flight('f', '去程')]));
    expect(sole.groupChanges[0]?.orderItemId).toBe('item-bundle');
    expect(sole.groupChanges[0]?.after.hotelName).toBe('三星随机（待落位）');

    const twoRows = planRoomGroupTextBackfill(
      order([{ id: 'g1', hotelName: OLD, roomType: '', passengerIds: [] }], [bundleRow(), bundleRow({ id: 'item-hotel', kind: 'HOTEL' })]),
    );
    expect(twoRows.groupChanges).toEqual([]);
    expect(twoRows.skipped[0].reason).toContain('不唯一');

    const manual = planRoomGroupTextBackfill(order([{ id: 'g1', hotelName: '手填酒店', roomType: '', passengerIds: [] }], [bundleRow()]));
    expect(manual.groupChanges).toEqual([]);
    expect(manual.skipped).toEqual([]);
  });

  it('归属行不存在 → 交人工；文本已一致 → 不计不改', () => {
    const missing = planRoomGroupTextBackfill(order([{ id: 'g1', hotelName: OLD, roomType: '', passengerIds: [], orderItemId: 'ghost' }], [bundleRow()]));
    expect(missing.skipped[0].reason).toContain('归属行不存在');
    const same = planRoomGroupTextBackfill(
      order([{ id: 'g1', hotelName: '三星随机（待落位）', roomType: '待落位', passengerIds: [], orderItemId: 'item-bundle' }], [bundleRow()]),
    );
    expect(same.groupChanges).toEqual([]);
    expect(same.roomAssignment).toBeNull();
  });

  it('链式改档（A→B→C）：from 名从历次差额行描述里收集，仍带 A 前缀的机票腿也能换成 C', () => {
    const plan = planRoomGroupTextBackfill(
      order(null, [
        bundleRow({ description: 'C 3天2晚', metadata: { bundleChange: { fromBundleName: 'B 3天2晚', toBundleName: 'C 3天2晚' } } }),
        diffRow('A 3天2晚', 'B 3天2晚'),
        diffRow('B 3天2晚', 'C 3天2晚'),
        flight('item-go', '去程', 'A 3天2晚'),
      ]),
    );
    expect(plan.descriptionChanges).toEqual([
      { itemId: 'item-go', before: 'A 3天2晚 · 去程（经济舱）', after: 'C 3天2晚 · 去程（经济舱）' },
    ]);
  });

  it('套餐行现名与 bundleChange.toBundleName 不一致（并发 / 人工改过）→ description 一律不动', () => {
    const plan = planRoomGroupTextBackfill(
      order(null, [bundleRow({ description: '人工改过的名字' }), flight('item-go', '去程')]),
    );
    expect(plan.descriptionChanges).toEqual([]);
  });

  it('roomAssignment 形状不符 / 无套餐行 → 空计划，不抛错', () => {
    const plan = planRoomGroupTextBackfill({ id: 'o', orderNumber: 'n', roomAssignment: 'garbage', items: [] });
    expect(plan).toEqual({ roomAssignment: null, groupChanges: [], descriptionChanges: [], skipped: [] });
  });
});
