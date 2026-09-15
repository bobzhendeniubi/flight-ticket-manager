/**
 * rewrite-shared-room-group-ids 单元测试（astra N9 回归修复 + astra B-N1 脚本扩面）。
 *
 * N9 反例：旧实现全表扫描后，`--apply` 无条件把整份 roomAssignment 覆盖成
 * `{ roomGroups: newGroups }`——① 用的是扫描时的旧快照，脚本运行期间业务侧对同一张单
 * 的并发改动会被整份覆盖悄悄冲掉；② 丢弃 roomGroups 之外的其它顶层字段。
 * 修复后逐单一个独立事务：锁行、基于锁后最新状态重判、只替换命中的旧式编码 id、
 * 保留其它字段、审计写入同事务。
 *
 * B-N1 反例：脚本原本只改 `Order.roomAssignment`，`OrderItem.metadata.splitRoomGroup.
 * roomGroupId` 里还存着旧式编码 id（按房组拆行时留下的历史 breadcrumb）。脚本要同时
 * 重写这处载体，同一事务、同样锁后重读，dry-run 也要列出命中数。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { rewriteSharedRoomGroupIds } from './rewrite-shared-room-group-ids.js';

interface FakeOrderRow {
  id: string;
  orderNumber: string;
  roomAssignment: unknown;
}

interface FakeItemRow {
  id: string;
  orderId: string;
  metadata: unknown;
}

/**
 * 假 client：
 *   - `scanRows` / `scanItemRows`：扫描阶段看到的快照（`client.order.findMany` /
 *     `client.orderItem.findMany`）；
 *   - `freshByOrderId`：`$transaction` 内部 `tx.order.findUnique` 应该读到的「锁后最新
 *     roomAssignment」，省略某 id = 该单未变，沿用 scanRows；显式给 null = 订单已被删除；
 *   - `freshItemsByOrderId`：`tx.orderItem.findMany` 应该读到的「锁后最新该单全部行
 *     metadata」，省略某 id = 该单的行未变，沿用 scanItemRows 里属于它的行。
 * 两组「扫描快照 / 锁后最新」可以不同，用来模拟脚本运行期间的并发写入。
 */
function fakeClient(opts: {
  scanRows?: FakeOrderRow[];
  scanItemRows?: FakeItemRow[];
  freshByOrderId?: Record<string, FakeOrderRow | null>;
  freshItemsByOrderId?: Record<string, FakeItemRow[]>;
}) {
  const scanRows = opts.scanRows ?? [];
  const scanItemRows = opts.scanItemRows ?? [];
  const freshByOrderId = opts.freshByOrderId ?? {};
  const freshItemsByOrderId = opts.freshItemsByOrderId ?? {};

  const orderUpdateCalls: Array<{ id: string; roomAssignment: unknown }> = [];
  const itemUpdateCalls: Array<{ id: string; metadata: unknown }> = [];
  const auditCalls: Array<{ entry: Record<string, unknown> }> = [];

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    order: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const fresh = where.id in freshByOrderId ? freshByOrderId[where.id] : scanRows.find((r) => r.id === where.id);
        return Promise.resolve(fresh ?? null);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: { roomAssignment: unknown } }) => {
        orderUpdateCalls.push({ id: where.id, roomAssignment: data.roomAssignment });
        return Promise.resolve({ id: where.id });
      }),
    },
    orderItem: {
      findMany: vi.fn(({ where }: { where: { orderId: string } }) => {
        const fresh = where.orderId in freshItemsByOrderId
          ? freshItemsByOrderId[where.orderId]
          : scanItemRows.filter((r) => r.orderId === where.orderId);
        return Promise.resolve(fresh ?? []);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: { metadata: unknown } }) => {
        itemUpdateCalls.push({ id: where.id, metadata: data.metadata });
        return Promise.resolve({ id: where.id });
      }),
    },
    auditLog: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        auditCalls.push({ entry: args.data });
        return Promise.resolve({});
      }),
    },
  };

  const client = {
    order: {
      findMany: vi.fn().mockResolvedValue(scanRows),
    },
    orderItem: {
      findMany: vi.fn().mockResolvedValue(scanItemRows),
    },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaClient;

  return { client, orderUpdateCalls, itemUpdateCalls, auditCalls, tx };
}

describe('rewriteSharedRoomGroupIds（astra N9）', () => {
  it('dry-run：只预览不加锁、不写库、不产生审计', async () => {
    const { client, orderUpdateCalls } = fakeClient({
      scanRows: [
        {
          id: 'o1',
          orderNumber: 'ST-0001',
          roomAssignment: { roomGroups: [{ id: 'shared:sr1:item-a', passengerIds: ['p1'] }] },
        },
      ],
    });
    const result = await rewriteSharedRoomGroupIds(client, { apply: false });
    expect(result.scannedOrders).toBe(1);
    expect(result.candidateGroups).toBe(1);
    expect(result.rewrittenOrders).toBe(0);
    expect(orderUpdateCalls).toHaveLength(0);
    expect((client as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });

  it('astra N9：保留 roomAssignment 里除 roomGroups 之外的其它顶层字段，不整份覆盖', async () => {
    const scanRow: FakeOrderRow = {
      id: 'o1',
      orderNumber: 'ST-0001',
      roomAssignment: {
        note: '这是 roomAssignment 顶层的另一个字段，不该被脚本丢弃',
        roomGroups: [{ id: 'shared:sr1:item-a', passengerIds: ['p1'] }],
      },
    };
    const { client, orderUpdateCalls, auditCalls } = fakeClient({ scanRows: [scanRow] });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });

    expect(result.rewrittenOrders).toBe(1);
    expect(result.rewrittenGroups).toBe(1);
    expect(orderUpdateCalls).toHaveLength(1);
    const written = orderUpdateCalls[0]!.roomAssignment as { note?: string; roomGroups: Array<{ id: string }> };
    // 旧实现只写 `{ roomGroups: newGroups }`，note 字段会消失——修复后必须保留。
    expect(written.note).toBe('这是 roomAssignment 顶层的另一个字段，不该被脚本丢弃');
    expect(written.roomGroups).toHaveLength(1);
    expect(written.roomGroups[0]!.id).not.toBe('shared:sr1:item-a'); // 已换新
    expect(written.roomGroups[0]!.id).not.toMatch(/^shared:|^plain:/);
    // 审计与业务写入同一个事务（tx.auditLog.create，不是脚本外层的 prisma.auditLog.create）。
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!.entry.action).toBe('REWRITE_SHARED_ROOM_GROUP_IDS');
    expect(auditCalls[0]!.entry.targetId).toBe('o1');
  });

  it('astra N9：逐单事务内基于锁后最新状态重判，不是扫描时的旧快照', async () => {
    // 扫描时看到的旧快照：两个旧式编码 id。
    const staleSnapshot: FakeOrderRow = {
      id: 'o1',
      orderNumber: 'ST-0001',
      roomAssignment: {
        roomGroups: [
          { id: 'shared:sr1:item-a', passengerIds: ['p1'] },
          { id: 'plain:sr1:item-b', passengerIds: ['p2'] },
        ],
      },
    };
    // 脚本运行期间，业务侧并发把 item-b 那个盒子搬空删掉了、又新增了一个正常 id 的盒子——
    // 这是「锁后最新状态」，与扫描快照不同。
    const freshState: FakeOrderRow = {
      id: 'o1',
      orderNumber: 'ST-0001',
      roomAssignment: {
        roomGroups: [
          { id: 'shared:sr1:item-a', passengerIds: ['p1'] },
          { id: 'brand-new-random-id', passengerIds: ['p3'] },
        ],
      },
    };
    const { client, orderUpdateCalls } = fakeClient({ scanRows: [staleSnapshot], freshByOrderId: { o1: freshState } });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });

    expect(result.rewrittenOrders).toBe(1);
    expect(result.rewrittenGroups).toBe(1); // 只有 item-a 那一个仍是旧式编码
    const written = orderUpdateCalls[0]!.roomAssignment as { roomGroups: Array<{ id: string; passengerIds: string[] }> };
    expect(written.roomGroups).toHaveLength(2);
    // plain:sr1:item-b（旧快照里的）不应该出现——它已经不在锁后最新状态里了。
    expect(written.roomGroups.some((g) => g.id === 'plain:sr1:item-b')).toBe(false);
    // 并发新增的 brand-new-random-id 必须原样保留，不能被旧快照覆盖掉。
    expect(written.roomGroups.some((g) => g.id === 'brand-new-random-id')).toBe(true);
  });

  it('锁后重读发现旧式编码 id 已经不在了（并发已处理/订单已删）→ 跳过，不写库', async () => {
    const scanRow: FakeOrderRow = {
      id: 'o1',
      orderNumber: 'ST-0001',
      roomAssignment: { roomGroups: [{ id: 'shared:sr1:item-a', passengerIds: ['p1'] }] },
    };
    // 锁后重读：订单已被删除。
    const { client, orderUpdateCalls } = fakeClient({ scanRows: [scanRow], freshByOrderId: { o1: null } });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });
    expect(result.rewrittenOrders).toBe(0);
    expect(orderUpdateCalls).toHaveLength(0);
  });
});

describe('rewriteSharedRoomGroupIds（astra B-N1：OrderItem.metadata.splitRoomGroup.roomGroupId）', () => {
  it('dry-run 也要列出行 metadata 里的旧式编码命中数', async () => {
    const { client } = fakeClient({
      scanRows: [{ id: 'o1', orderNumber: 'ST-0001', roomAssignment: null }],
      scanItemRows: [
        {
          id: 'item-b',
          orderId: 'o1',
          metadata: { splitRoomGroup: { fromItemId: 'item-a', roomGroupId: 'shared:sr1:item-a' } },
        },
      ],
    });
    const result = await rewriteSharedRoomGroupIds(client, { apply: false });
    expect(result.candidateItemMetadata).toBe(1);
    expect(result.rewrittenItemMetadata).toBe(0);
  });

  it('astra B-N1：改写行 metadata 的 roomGroupId，保留 metadata 里其它字段（fromItemId / note / at）', async () => {
    const scanItem: FakeItemRow = {
      id: 'item-b',
      orderId: 'o1',
      metadata: {
        splitRoomGroup: { fromItemId: 'item-a', roomGroupId: 'plain:sr1:item-a', at: '2026-09-01T00:00:00.000Z' },
        note: '这是 metadata 顶层的另一个字段，不该被丢弃',
      },
    };
    const { client, itemUpdateCalls, auditCalls } = fakeClient({
      scanRows: [{ id: 'o1', orderNumber: 'ST-0001', roomAssignment: null }],
      scanItemRows: [scanItem],
    });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });

    expect(result.rewrittenOrders).toBe(1);
    expect(result.rewrittenGroups).toBe(0); // 这次命中的不是 roomGroups
    expect(result.rewrittenItemMetadata).toBe(1);
    expect(itemUpdateCalls).toHaveLength(1);
    const written = itemUpdateCalls[0]!.metadata as {
      note?: string;
      splitRoomGroup: { fromItemId: string; roomGroupId: string; at: string };
    };
    expect(written.note).toBe('这是 metadata 顶层的另一个字段，不该被丢弃');
    expect(written.splitRoomGroup.fromItemId).toBe('item-a'); // 其它子字段原样保留
    expect(written.splitRoomGroup.at).toBe('2026-09-01T00:00:00.000Z');
    expect(written.splitRoomGroup.roomGroupId).not.toBe('plain:sr1:item-a'); // 已换新
    expect(written.splitRoomGroup.roomGroupId).not.toMatch(/^shared:|^plain:/);
    expect(auditCalls).toHaveLength(1); // 同一事务、同一条审计（roomGroups 与行 metadata 合并一条）
  });

  it('astra B-N1：roomAssignment 干净但行 metadata 有旧式编码——仍会被扫到并改写', async () => {
    const { client, orderUpdateCalls, itemUpdateCalls } = fakeClient({
      scanRows: [{ id: 'o1', orderNumber: 'ST-0001', roomAssignment: { roomGroups: [{ id: 'clean-id' }] } }],
      scanItemRows: [
        {
          id: 'item-b',
          orderId: 'o1',
          metadata: { splitRoomGroup: { fromItemId: 'item-a', roomGroupId: 'shared:sr1:item-a' } },
        },
      ],
    });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });
    expect(result.rewrittenOrders).toBe(1);
    expect(result.rewrittenGroups).toBe(0);
    expect(result.rewrittenItemMetadata).toBe(1);
    expect(orderUpdateCalls).toHaveLength(0); // roomAssignment 本就干净，不该被改写
    expect(itemUpdateCalls).toHaveLength(1);
  });

  it('锁后重读该单全部行都不再有旧式编码 metadata（并发已处理）→ 跳过，不写库', async () => {
    const { client, itemUpdateCalls } = fakeClient({
      scanRows: [{ id: 'o1', orderNumber: 'ST-0001', roomAssignment: null }],
      scanItemRows: [
        { id: 'item-b', orderId: 'o1', metadata: { splitRoomGroup: { roomGroupId: 'shared:sr1:item-a' } } },
      ],
      freshItemsByOrderId: {
        o1: [{ id: 'item-b', orderId: 'o1', metadata: { splitRoomGroup: { roomGroupId: 'already-new-id' } } }],
      },
    });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });
    expect(result.rewrittenOrders).toBe(0);
    expect(itemUpdateCalls).toHaveLength(0);
  });
});
