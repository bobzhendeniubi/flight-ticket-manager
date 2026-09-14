/**
 * 跨单分房导出统一房间身份映射 · 单元测试（§九，验收反例 11 的地基）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  roomIdentityKey,
  roomNumberScopeKey,
  RoomNumberer,
  loadSharedRoomPartnerLookup,
  sharedRoomPartnerNote,
  AGENT_SHARED_ROOM_NOTE,
} from './room-identity.js';

describe('roomIdentityKey', () => {
  it('共享房组：恒定用 sharedRoomId，两侧份额不同也算出同一个身份', () => {
    const sideA = { id: 'g1', sharedRoomId: 'sr_abc' };
    const sideB = { id: 'g9', sharedRoomId: 'sr_abc' };
    expect(roomIdentityKey(sideA, 'ord_a')).toBe('sr_abc');
    expect(roomIdentityKey(sideB, 'ord_b')).toBe('sr_abc');
    expect(roomIdentityKey(sideA, 'ord_a')).toBe(roomIdentityKey(sideB, 'ord_b'));
  });

  it('普通房组：退回 `${orderId}:${groupId}`；不同单的本地 id 撞字面值也不会撞身份', () => {
    expect(roomIdentityKey({ id: 'g1' }, 'ord_a')).toBe('ord_a:g1');
    expect(roomIdentityKey({ id: 'g1' }, 'ord_b')).toBe('ord_b:g1');
    expect(roomIdentityKey({ id: 'g1' }, 'ord_a')).not.toBe(roomIdentityKey({ id: 'g1' }, 'ord_b'));
  });

  it('sharedRoomId 为空串 / null 视同没有——退回普通房组身份', () => {
    expect(roomIdentityKey({ id: 'g1', sharedRoomId: '' }, 'ord_a')).toBe('ord_a:g1');
    expect(roomIdentityKey({ id: 'g1', sharedRoomId: null }, 'ord_a')).toBe('ord_a:g1');
  });
});

describe('roomNumberScopeKey', () => {
  it('真实酒店按 hotelId；未落位按展示名兜底，两者不会撞', () => {
    expect(roomNumberScopeKey('hotel_1', '4星随机（待落位）')).toBe('hotel:hotel_1');
    expect(roomNumberScopeKey(null, '4星随机（待落位）')).toBe('pending:4星随机（待落位）');
    // 万一某个真实 hotelId 字面上恰好等于某个展示名（几乎不可能，但兜底验证前缀隔离生效）
    expect(roomNumberScopeKey('4星随机（待落位）', 'x')).not.toBe(roomNumberScopeKey(null, '4星随机（待落位）'));
  });
});

describe('RoomNumberer', () => {
  it('同 scope 同 identityKey 恒定复用同一个号；不同 identityKey 按首次出现顺序递增', () => {
    const n = new RoomNumberer();
    expect(n.numberFor('hotel:h1', 'sr_1')).toBe(1);
    expect(n.numberFor('hotel:h1', 'sr_2')).toBe(2);
    expect(n.numberFor('hotel:h1', 'sr_1')).toBe(1); // 复用
    expect(n.numberFor('hotel:h1', 'sr_2')).toBe(2); // 复用
  });

  it('不同 scope 各自独立计数，互不影响', () => {
    const n = new RoomNumberer();
    expect(n.numberFor('hotel:h1', 'sr_1')).toBe(1);
    expect(n.numberFor('hotel:h2', 'sr_1')).toBe(1); // 不同酒店，同一 identityKey 也从 1 开始
  });

  it('next() 与 numberFor() 共用同一套计数器，交替调用号码连续不撞号', () => {
    const n = new RoomNumberer();
    expect(n.numberFor('hotel:h1', 'sr_1')).toBe(1);
    expect(n.next('hotel:h1')).toBe(2); // 未分房打包用的新号，接着计数
    expect(n.numberFor('hotel:h1', 'sr_2')).toBe(3);
    expect(n.next('hotel:h1')).toBe(4);
  });
});

describe('loadSharedRoomPartnerLookup', () => {
  it('按 sharedRoomId 分组，去重同一订单的多个成员', async () => {
    const client = {
      sharedRoomMember: {
        findMany: vi.fn().mockResolvedValue([
          { sharedRoomId: 'sr_1', order: { orderNumber: 'FTM_A' } },
          { sharedRoomId: 'sr_1', order: { orderNumber: 'FTM_A' } }, // 同订单第二位成员，去重
          { sharedRoomId: 'sr_1', order: { orderNumber: 'FTM_B' } },
          { sharedRoomId: 'sr_2', order: { orderNumber: 'FTM_C' } },
        ]),
      },
    } as unknown as PrismaClient;
    const lookup = await loadSharedRoomPartnerLookup(['sr_1', 'sr_2'], client);
    expect(lookup.get('sr_1')).toEqual(['FTM_A', 'FTM_B']);
    expect(lookup.get('sr_2')).toEqual(['FTM_C']);

    const where = (
      (client as unknown as { sharedRoomMember: { findMany: ReturnType<typeof vi.fn> } }).sharedRoomMember
        .findMany
    ).mock.calls[0][0].where;
    expect(where.sharedRoomId).toEqual({ in: ['sr_1', 'sr_2'] });
  });

  it('空 id 列表不查库，直接返回空 Map', async () => {
    const findMany = vi.fn();
    const lookup = await loadSharedRoomPartnerLookup(
      [],
      { sharedRoomMember: { findMany } } as unknown as PrismaClient,
    );
    expect(lookup.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('sharedRoomPartnerNote', () => {
  it('排除本单单号，单一伙伴 → 「与 FTM… 合住」', () => {
    const lookup = new Map([['sr_1', ['FTM_A', 'FTM_B']]]);
    expect(sharedRoomPartnerNote('sr_1', 'FTM_A', lookup)).toBe('与 FTM_B 合住');
  });

  it('三人间跨两张单：多个伙伴用「、」连接', () => {
    const lookup = new Map([['sr_1', ['FTM_A', 'FTM_B', 'FTM_C']]]);
    expect(sharedRoomPartnerNote('sr_1', 'FTM_A', lookup)).toBe('与 FTM_B、FTM_C 合住');
  });

  it('查不到伙伴（异常态）→ 空串，不编造', () => {
    const lookup = new Map<string, string[]>();
    expect(sharedRoomPartnerNote('sr_missing', 'FTM_A', lookup)).toBe('');
  });

  it('AGENT_SHARED_ROOM_NOTE 是中性文案，不含单号', () => {
    expect(AGENT_SHARED_ROOM_NOTE).toBe('与他单合住');
  });
});
