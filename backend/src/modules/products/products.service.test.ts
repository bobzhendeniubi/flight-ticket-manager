/**
 * ProductsService · 套餐写入不变量单测（vitest）
 *
 * 聚焦 deriveHotelNightsFromItems：套餐 items 含 HOTEL 组件时，落库 hotelNights 必须
 * 规范化 = HOTEL.qty（真实晚数），夹到 zod 范围 1..30；无 HOTEL 组件 → undefined（不覆盖）。
 * 这是「saved bundles never diverge + legacy null 行 re-save 自愈」的核心口径。
 *
 * 用 vi.mock 把 prisma 替换掉（products.service 模块加载即 import prisma），不连真 DB。
 */
import { describe, it, expect, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { deriveHotelNightsFromItems } from './products.service.js';

describe('deriveHotelNightsFromItems · 套餐写入不变量', () => {
  it('items 含 HOTEL 组件 → hotelNights = HOTEL.qty（真实晚数）', () => {
    const items = [
      { kind: 'FLIGHT', qty: 1 },
      { kind: 'HOTEL', qty: 3 },
      { kind: 'TRANSFER', qty: 1 },
    ];
    expect(deriveHotelNightsFromItems(items)).toBe(3);
  });

  it('无 HOTEL 组件 → undefined（不强行覆盖调用方原值）', () => {
    expect(
      deriveHotelNightsFromItems([
        { kind: 'FLIGHT', qty: 1 },
        { kind: 'VISA', qty: 1 },
      ]),
    ).toBeUndefined();
  });

  it('HOTEL.qty 超上限 → 夹到 30（保持 zod 1..30 范围）', () => {
    expect(deriveHotelNightsFromItems([{ kind: 'HOTEL', qty: 99 }])).toBe(30);
  });

  it('多个 HOTEL 组件 → 取第一个的 qty', () => {
    expect(
      deriveHotelNightsFromItems([
        { kind: 'HOTEL', qty: 2 },
        { kind: 'HOTEL', qty: 5 },
      ]),
    ).toBe(2);
  });

  it('items 畸形 / 空 → undefined（不抛错）', () => {
    expect(deriveHotelNightsFromItems(null)).toBeUndefined();
    expect(deriveHotelNightsFromItems([])).toBeUndefined();
    expect(deriveHotelNightsFromItems('garbage')).toBeUndefined();
  });
});
