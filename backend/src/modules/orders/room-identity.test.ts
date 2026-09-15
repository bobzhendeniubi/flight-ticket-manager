/**
 * 跨单分房导出统一房间身份映射 · 单元测试（§九，验收反例 11 的地基）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  roomIdentityKey,
  buildVerifiedSplitPairKeys,
  roomIdentitySortKey,
  scopedIdentityMapKey,
  buildIdentityNumberMap,
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

  it('拆单配对键（splitPairKey）：不传核验集时保持旧行为——没有 sharedRoomId 时两个半组用它算出同一个身份（§十三验收反例 10）', () => {
    const half1 = { id: 'g1', splitPairKey: 'item-x:token-1' };
    const half2 = { id: 'g2', splitPairKey: 'item-x:token-1' };
    expect(roomIdentityKey(half1, 'ord_a')).toBe('item-x:token-1');
    expect(roomIdentityKey(half2, 'ord_b')).toBe('item-x:token-1');
    expect(roomIdentityKey(half1, 'ord_a')).toBe(roomIdentityKey(half2, 'ord_b'));
  });

  it('sharedRoomId 优先于 splitPairKey（两者理论互斥，但顺序仍要明确）', () => {
    expect(roomIdentityKey({ id: 'g1', sharedRoomId: 'sr1', splitPairKey: 'pk1' }, 'ord_a')).toBe('sr1');
  });

  it('A4：给了核验集且 splitPairKey 在集合里——照常合号', () => {
    const half1 = { id: 'g1', splitPairKey: 'item-x:token-1' };
    const half2 = { id: 'g2', splitPairKey: 'item-x:token-1' };
    const verified = new Set(['item-x:token-1']);
    expect(roomIdentityKey(half1, 'ord_a', verified)).toBe('item-x:token-1');
    expect(roomIdentityKey(half2, 'ord_b', verified)).toBe('item-x:token-1');
  });

  it('A4：给了核验集但 splitPairKey 不在集合里——退回 orderId:groupId，不跨单合号', () => {
    const half1 = { id: 'g1', splitPairKey: 'item-x:token-1' };
    const half2 = { id: 'g2', splitPairKey: 'item-x:token-1' };
    const verified = new Set<string>(); // 空集合：谁都没核验通过
    expect(roomIdentityKey(half1, 'ord_a', verified)).toBe('ord_a:g1');
    expect(roomIdentityKey(half2, 'ord_b', verified)).toBe('ord_b:g2');
    expect(roomIdentityKey(half1, 'ord_a', verified)).not.toBe(roomIdentityKey(half2, 'ord_b', verified));
  });
});

describe('buildVerifiedSplitPairKeys', () => {
  it('同一个 splitPairKey 出现在同一条 OrderSplitRecord 的 source/target 二元组里——判定可信', async () => {
    const client = {
      orderSplitRecord: {
        findMany: vi.fn().mockResolvedValue([
          { sourceOrderId: 'ord_a', targetOrderId: 'ord_b', requestToken: 'token-1' },
        ]),
      },
    } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'item-x:token-1' },
        { orderId: 'ord_b', splitPairKey: 'item-x:token-1' },
      ],
      client,
    );
    expect(verified.has('item-x:token-1')).toBe(true);
  });

  it('撞键但不是同一条拆单记录——不可信，导出侧应退回 orderId:groupId（A4 核心反例）', async () => {
    // ord_a 与 ord_c 两张不相关订单，各自被别的拆单记录关联，却恰好复用了同一个
    // splitPairKey 字面值（legacy 数据 / baseId+requestToken 撞车）。
    const client = {
      orderSplitRecord: {
        findMany: vi.fn().mockResolvedValue([
          { sourceOrderId: 'ord_a', targetOrderId: 'ord_b', requestToken: 'token-1' },
        ]),
      },
    } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'item-x:token-1' },
        { orderId: 'ord_c', splitPairKey: 'item-x:token-1' }, // ord_c 不在 ord_a/ord_b 的拆单记录里
      ],
      client,
    );
    expect(verified.has('item-x:token-1')).toBe(false);
  });

  it('单订单内部出现同一个 splitPairKey——不跨单，无需查表即可信', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { orderSplitRecord: { findMany } } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'pax:p1|p2:token-1' },
        { orderId: 'ord_a', splitPairKey: 'pax:p1|p2:token-1' },
      ],
      client,
    );
    expect(verified.has('pax:p1|p2:token-1')).toBe(true);
  });

  it('没有 orderSplitRecord 匹配——不可信', async () => {
    const client = {
      orderSplitRecord: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'item-x:token-1' },
        { orderId: 'ord_b', splitPairKey: 'item-x:token-1' },
      ],
      client,
    );
    expect(verified.has('item-x:token-1')).toBe(false);
  });

  it('空输入不查库，直接返回空集合', async () => {
    const findMany = vi.fn();
    const verified = await buildVerifiedSplitPairKeys([], {
      orderSplitRecord: { findMany },
    } as unknown as PrismaClient);
    expect(verified.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  // ── astra finding N7：sp2: 新格式按单条拆分记录核验，不再按 token 取并集 ────────────
  it('N7 正例：sp2 格式——source/target 恰为对应记录二元组，判定可信', async () => {
    const client = {
      orderSplitRecord: {
        findMany: vi.fn().mockResolvedValue([
          { sourceOrderId: 'ord_a', targetOrderId: 'ord_b', requestToken: 'token-1' },
        ]),
      },
    } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'sp2:ord_a:item-x:token-1' },
        { orderId: 'ord_b', splitPairKey: 'sp2:ord_a:item-x:token-1' },
      ],
      client,
    );
    expect(verified.has('sp2:ord_a:item-x:token-1')).toBe(true);
  });

  it('N7 反例：两组独立拆分复用同一个 token——sp2 按单条记录精确核验，不再像旧的 token 并集判定那样被误判为可信', async () => {
    // ord_a→ord_b 与 ord_c→ord_d 是两次完全不相关的拆分，只是碰巧复用了同一个
    // requestToken（token 只在 (源单, token) 内做幂等去重，不同源单本就允许复用）。
    // 这里模拟 ord_c 的条目错误地携带了 ord_a 那条拆分的 splitPairKey 字面值
    // （legacy 数据 / 拼接错误的极端场景）——旧实现按 token 取并集会把 ord_a/ord_b/
    // ord_c/ord_d 全部并进 legit 集合，ord_c 恰好也在集合里，被误判为「同一次拆分」；
    // sp2 精确核验只认 sourceOrderId=ord_a、token=token-1 对应的那一条记录
    // {ord_a, ord_b}，ord_c 不在其中，必须判为不可信。
    const client = {
      orderSplitRecord: {
        findMany: vi.fn().mockResolvedValue([
          { sourceOrderId: 'ord_a', targetOrderId: 'ord_b', requestToken: 'token-1' },
          { sourceOrderId: 'ord_c', targetOrderId: 'ord_d', requestToken: 'token-1' },
        ]),
      },
    } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'sp2:ord_a:item-x:token-1' },
        { orderId: 'ord_c', splitPairKey: 'sp2:ord_a:item-x:token-1' }, // 错误挪用 ord_a 的 key
      ],
      client,
    );
    expect(verified.has('sp2:ord_a:item-x:token-1')).toBe(false);
    // 只查了这一条 (sourceOrderId, requestToken) 组合，不是不加区分地按 token 广查。
    expect(client.orderSplitRecord.findMany).toHaveBeenCalledWith({
      where: { OR: [{ sourceOrderId: 'ord_a', requestToken: 'token-1' }] },
      select: { sourceOrderId: true, targetOrderId: true, requestToken: true },
    });
  });

  it('N7：sp2 与旧格式混用互不干扰——各走各的核验路径', async () => {
    const client = {
      orderSplitRecord: {
        findMany: vi.fn().mockResolvedValue([
          { sourceOrderId: 'ord_a', targetOrderId: 'ord_b', requestToken: 'token-1' },
        ]),
      },
    } as unknown as PrismaClient;
    const verified = await buildVerifiedSplitPairKeys(
      [
        { orderId: 'ord_a', splitPairKey: 'sp2:ord_a:item-x:token-1' },
        { orderId: 'ord_b', splitPairKey: 'sp2:ord_a:item-x:token-1' },
        { orderId: 'ord_a', splitPairKey: 'legacy-item:token-1' },
        { orderId: 'ord_b', splitPairKey: 'legacy-item:token-1' },
      ],
      client,
    );
    expect(verified.has('sp2:ord_a:item-x:token-1')).toBe(true);
    expect(verified.has('legacy-item:token-1')).toBe(true);
  });
});

describe('roomNumberScopeKey', () => {
  it('真实酒店按 hotelId；未落位按展示名兜底，两者不会撞', () => {
    expect(roomNumberScopeKey('hotel_1', '4星随机（待落位）', '2026-10-01')).toBe('hotel:hotel_1|2026-10-01');
    expect(roomNumberScopeKey(null, '4星随机（待落位）', '2026-10-01')).toBe(
      'pending:4星随机（待落位）|2026-10-01',
    );
    // 万一某个真实 hotelId 字面上恰好等于某个展示名（几乎不可能，但兜底验证前缀隔离生效）
    expect(roomNumberScopeKey('4星随机（待落位）', 'x', '2026-10-01')).not.toBe(
      roomNumberScopeKey(null, '4星随机（待落位）', '2026-10-01'),
    );
  });

  it('N11：入住日是作用域的一部分——同一酒店不同入住日不合并进同一个编号序列', () => {
    expect(roomNumberScopeKey('hotel_1', '', '2026-10-01')).not.toBe(
      roomNumberScopeKey('hotel_1', '', '2026-10-02'),
    );
  });
});

describe('roomIdentitySortKey + buildIdentityNumberMap（B10）', () => {
  it('共享房排在普通房组之前，各自内部按规则升序，不依赖遍历顺序', () => {
    const sharedB = { id: 'gb', sharedRoomId: 'sr_b' };
    const sharedA = { id: 'ga', sharedRoomId: 'sr_a' };
    const plainB = { id: 'gp2' };
    const plainA = { id: 'gp1' };
    const entries = [
      // 故意用「逆序」喂入：sortKey 与喂入顺序无关，编号只看排序结果。
      {
        scope: 'hotel:h1',
        identityKey: roomIdentityKey(sharedB, 'ord_b'),
        sortKey: roomIdentitySortKey(sharedB, 'sr_b', 'FTM_B'),
      },
      {
        scope: 'hotel:h1',
        identityKey: roomIdentityKey(sharedA, 'ord_a'),
        sortKey: roomIdentitySortKey(sharedA, 'sr_a', 'FTM_A'),
      },
      {
        scope: 'hotel:h1',
        identityKey: roomIdentityKey(plainB, 'ord_z'),
        sortKey: roomIdentitySortKey(plainB, 'ord_z:gp2', 'FTM_Z'),
      },
      {
        scope: 'hotel:h1',
        identityKey: roomIdentityKey(plainA, 'ord_y'),
        sortKey: roomIdentitySortKey(plainA, 'ord_y:gp1', 'FTM_Y'),
      },
    ];
    const map = buildIdentityNumberMap(entries);
    expect(map.get(scopedIdentityMapKey('hotel:h1', 'sr_a'))).toBe(1);
    expect(map.get(scopedIdentityMapKey('hotel:h1', 'sr_b'))).toBe(2);
    expect(map.get(scopedIdentityMapKey('hotel:h1', 'ord_y:gp1'))).toBe(3);
    expect(map.get(scopedIdentityMapKey('hotel:h1', 'ord_z:gp2'))).toBe(4);
  });

  it('跨导出断言：两套完全不同的遍历/喂入顺序算出同一份「身份→房号」映射', () => {
    const sharedA = { id: 'ga', sharedRoomId: 'sr_a' };
    const sharedB = { id: 'gb', sharedRoomId: 'sr_b' };
    const plain = { id: 'gp1' };
    const build = (order: Array<'sr_a' | 'sr_b' | 'plain'>) =>
      buildIdentityNumberMap(
        order.map((kind) => {
          if (kind === 'sr_a') {
            return {
              scope: 'hotel:h1',
              identityKey: 'sr_a',
              sortKey: roomIdentitySortKey(sharedA, 'sr_a', 'FTM_A'),
            };
          }
          if (kind === 'sr_b') {
            return {
              scope: 'hotel:h1',
              identityKey: 'sr_b',
              sortKey: roomIdentitySortKey(sharedB, 'sr_b', 'FTM_B'),
            };
          }
          return {
            scope: 'hotel:h1',
            identityKey: 'ord_c:gp1',
            sortKey: roomIdentitySortKey(plain, 'ord_c:gp1', 'FTM_C'),
          };
        }),
      );
    // “整班机”式升序遍历 vs “全岗总表”式降序遍历——喂入顺序完全相反。
    const ascending = build(['sr_a', 'sr_b', 'plain']);
    const descending = build(['plain', 'sr_b', 'sr_a']);
    for (const key of ['sr_a', 'sr_b', 'ord_c:gp1']) {
      expect(ascending.get(scopedIdentityMapKey('hotel:h1', key))).toBe(
        descending.get(scopedIdentityMapKey('hotel:h1', key)),
      );
    }
  });

  it('不同 scope 各自独立编号，互不影响', () => {
    const map = buildIdentityNumberMap([
      { scope: 'hotel:h1', identityKey: 'sr_1', sortKey: '0:sr_1' },
      { scope: 'hotel:h2', identityKey: 'sr_1', sortKey: '0:sr_1' },
    ]);
    expect(map.get(scopedIdentityMapKey('hotel:h1', 'sr_1'))).toBe(1);
    expect(map.get(scopedIdentityMapKey('hotel:h2', 'sr_1'))).toBe(1);
  });

  it('astra finding N11 反例：同一 identityKey 的两条候选 sortKey（拆单两侧订单号不同）取最小值，不随遍历顺序把两间房的编号印反', () => {
    // 拆单产生的两个半间共用同一个 identityKey（splitPairKey = 'pair-1'），但源单/新单
    // 订单号不同，roomIdentitySortKey 算出的 sortKey 也不同（1:<orderNumber>:<groupId>）。
    // 'other-1' 是另一个独立身份，订单号排在这两者之间——谁被选中当 pair-1 的代表
    // sortKey，直接决定 pair-1 排在 other-1 前面还是后面。
    const pairSideSource = { id: 'pair-1' }; // 源单 FTM_2000（排最前）
    const pairSideTarget = { id: 'pair-1' }; // 新单 FTM_9000（排最后）
    const other = { id: 'gp-other' }; // FTM_5000（排中间）

    const entriesAscending = [
      { scope: 'hotel:h1', identityKey: 'pair-1', sortKey: roomIdentitySortKey(pairSideSource, 'pair-1', 'FTM_2000') },
      { scope: 'hotel:h1', identityKey: 'other-1', sortKey: roomIdentitySortKey(other, 'other-1', 'FTM_5000') },
      { scope: 'hotel:h1', identityKey: 'pair-1', sortKey: roomIdentitySortKey(pairSideTarget, 'pair-1', 'FTM_9000') },
    ];
    // 反过来喂：先遇到新单那一侧（FTM_9000），源单那一侧（FTM_2000）最后才出现。
    const entriesDescending = [
      { scope: 'hotel:h1', identityKey: 'pair-1', sortKey: roomIdentitySortKey(pairSideTarget, 'pair-1', 'FTM_9000') },
      { scope: 'hotel:h1', identityKey: 'other-1', sortKey: roomIdentitySortKey(other, 'other-1', 'FTM_5000') },
      { scope: 'hotel:h1', identityKey: 'pair-1', sortKey: roomIdentitySortKey(pairSideSource, 'pair-1', 'FTM_2000') },
    ];

    const mapAscending = buildIdentityNumberMap(entriesAscending);
    const mapDescending = buildIdentityNumberMap(entriesDescending);

    // 两种遍历顺序必须算出同一份结果：pair-1（源单号 2000，字典序最小）排第 1，
    // other-1（5000）排第 2——不因为先遇到哪一侧就把两者的相对顺序印反。
    for (const map of [mapAscending, mapDescending]) {
      expect(map.get(scopedIdentityMapKey('hotel:h1', 'pair-1'))).toBe(1);
      expect(map.get(scopedIdentityMapKey('hotel:h1', 'other-1'))).toBe(2);
    }
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

  it('prime()：把计数器下限抬到 floor，未分房续编号不与外部预建号相撞（B10）', () => {
    const n = new RoomNumberer();
    n.prime('hotel:h1', 3); // 假设外部预建号已经用掉了 1..3
    expect(n.next('hotel:h1')).toBe(4);
  });

  it('prime()：不会把已经领先的计数器往回拨', () => {
    const n = new RoomNumberer();
    expect(n.next('hotel:h1')).toBe(1);
    expect(n.next('hotel:h1')).toBe(2);
    n.prime('hotel:h1', 1); // floor 低于当前计数器，不生效
    expect(n.next('hotel:h1')).toBe(3);
  });
});

describe('loadSharedRoomPartnerLookup', () => {
  it('按 sharedRoomId 分组，去重同一订单的多个成员，附带失效状态（B11）', async () => {
    const client = {
      sharedRoomMember: {
        findMany: vi.fn().mockResolvedValue([
          {
            sharedRoomId: 'sr_1',
            order: { orderNumber: 'FTM_A', status: 'PAID', deletedAt: null },
          },
          {
            sharedRoomId: 'sr_1',
            order: { orderNumber: 'FTM_A', status: 'PAID', deletedAt: null },
          }, // 同订单第二位成员，去重
          {
            sharedRoomId: 'sr_1',
            order: { orderNumber: 'FTM_B', status: 'CANCELLED', deletedAt: null },
          },
          {
            sharedRoomId: 'sr_2',
            order: { orderNumber: 'FTM_C', status: 'PAID', deletedAt: new Date('2026-01-01') },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const lookup = await loadSharedRoomPartnerLookup(['sr_1', 'sr_2'], client);
    expect(lookup.get('sr_1')).toEqual([
      { orderNumber: 'FTM_A', cancelled: false },
      { orderNumber: 'FTM_B', cancelled: true }, // CANCELLED 状态
    ]);
    expect(lookup.get('sr_2')).toEqual([{ orderNumber: 'FTM_C', cancelled: true }]); // 软删

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
  it('排除本单单号，单一伙伴（有效）→ 「与 FTM… 合住」', () => {
    const lookup = new Map([
      [
        'sr_1',
        [
          { orderNumber: 'FTM_A', cancelled: false },
          { orderNumber: 'FTM_B', cancelled: false },
        ],
      ],
    ]);
    expect(sharedRoomPartnerNote('sr_1', 'FTM_A', lookup)).toBe('与 FTM_B 合住');
  });

  it('三人间跨两张单：多个伙伴用「、」连接', () => {
    const lookup = new Map([
      [
        'sr_1',
        [
          { orderNumber: 'FTM_A', cancelled: false },
          { orderNumber: 'FTM_B', cancelled: false },
          { orderNumber: 'FTM_C', cancelled: false },
        ],
      ],
    ]);
    expect(sharedRoomPartnerNote('sr_1', 'FTM_A', lookup)).toBe('与 FTM_B、FTM_C 合住');
  });

  it('B11：伙伴已失效——单独标注「（已取消）」', () => {
    const lookup = new Map([
      [
        'sr_1',
        [
          { orderNumber: 'FTM_A', cancelled: false },
          { orderNumber: 'FTM_B', cancelled: true },
        ],
      ],
    ]);
    expect(sharedRoomPartnerNote('sr_1', 'FTM_A', lookup)).toBe('与 FTM_B（已取消） 合住');
  });

  it('查不到伙伴（异常态）→ 空串，不编造', () => {
    const lookup = new Map<string, Array<{ orderNumber: string; cancelled: boolean }>>();
    expect(sharedRoomPartnerNote('sr_missing', 'FTM_A', lookup)).toBe('');
  });

  it('AGENT_SHARED_ROOM_NOTE 是中性文案，不含单号', () => {
    expect(AGENT_SHARED_ROOM_NOTE).toBe('与他单合住');
  });
});
