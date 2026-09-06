/**
 * 酒店房型提交体（roomTypesPayload）单测。
 *
 * 守的是一条不能破的线：**改房型名不能变成「删旧建新」**。
 * 后端 updateHotel 先按 id 匹配、再按名称匹配现有房型；两样都匹配不上就新建一条 + 物理删掉旧的，
 * 而 Bundle.hotelRoomTypeId / OrderItem.hotelRoomTypeId 两条外键都是 ON DELETE SET NULL——
 * 提交体一旦丢了 id，运营改一次房型名就会静默清空套餐与历史订单的房型引用。
 */
import { describe, it, expect } from 'vitest';
import { roomTypesPayload } from './ProductsPage';

describe('roomTypesPayload', () => {
  it('改名后仍带上原房型 id（后端据此原地更新，不删旧建新）', () => {
    const payload = roomTypesPayload(600, [
      {
        id: 'rt-existing-1',
        name: '豪华标准双床房', // 原名「标准房」，运营刚改
        priceMult: 1.2,
        sleeps: 2,
        bedType: '2 张单人床',
        maxAdults: 2,
        maxChildren: 1,
        costPriceCny: 380,
      },
    ]);

    expect(payload).toHaveLength(1);
    expect(payload[0].id).toBe('rt-existing-1');
    expect(payload[0].name).toBe('豪华标准双床房');
    expect(payload[0].basePrice).toBe(720);
    expect(payload[0].priceMultiplier).toBe(1.2);
    expect(payload[0].capacity).toBe(2);
    expect(payload[0].costPriceCny).toBe(380);
  });

  it('新建房型没有 id 时不下发 id 键（后端按新建处理）', () => {
    const payload = roomTypesPayload(500, [
      { name: '海景大床房', priceMult: 1, sleeps: 2, bedType: '1 张大床' },
    ]);

    expect(payload[0]).not.toHaveProperty('id');
    expect(payload[0].name).toBe('海景大床房');
    // 缺省人数口径：2 大 1 小
    expect(payload[0].maxAdults).toBe(2);
    expect(payload[0].maxChildren).toBe(1);
  });

  it('一次提交里新老房型混排，各自保留/省略 id', () => {
    const payload = roomTypesPayload(400, [
      { id: 'rt-a', name: '标准房', priceMult: 1, sleeps: 2, bedType: '' },
      { name: '新加的家庭房', priceMult: 1.5, sleeps: 4, bedType: '2 张大床' },
    ]);

    expect(payload[0].id).toBe('rt-a');
    expect(payload[1]).not.toHaveProperty('id');
  });

  it('成本价留空 = 未录 → 省略字段，不发 null', () => {
    const payload = roomTypesPayload(400, [
      { id: 'rt-a', name: '标准房', priceMult: 1, sleeps: 2, bedType: '', costPriceCny: null },
    ]);

    expect(payload[0].costPriceCny).toBeUndefined();
  });
});
