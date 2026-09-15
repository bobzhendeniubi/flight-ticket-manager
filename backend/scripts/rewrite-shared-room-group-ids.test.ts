/**
 * rewrite-shared-room-group-ids 单元测试（astra N9 回归修复）。
 *
 * 反例：旧实现全表扫描后，`--apply` 无条件把整份 roomAssignment 覆盖成
 * `{ roomGroups: newGroups }`——① 用的是扫描时的旧快照，脚本运行期间业务侧对同一张单
 * 的并发改动会被整份覆盖悄悄冲掉；② 丢弃 roomGroups 之外的其它顶层字段。
 * 修复后逐单一个独立事务：锁行、基于锁后最新状态重判、只替换命中的旧式编码 id、
 * 保留其它顶层字段、审计写入同事务。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { rewriteSharedRoomGroupIds } from './rewrite-shared-room-group-ids.js';

interface FakeOrderRow {
  id: string;
  orderNumber: string;
  roomAssignment: unknown;
}

/**
 * 假 client：`order.findMany` 提供「扫描阶段」看到的快照；`freshByOrderId` 提供
 * `$transaction` 内部 `order.findUnique` 应该读到的「锁后最新状态」——两者可以不同，
 * 用来模拟脚本运行期间的并发写入。省略 `freshByOrderId` 里的某个 id = 模拟订单已被删除
 * （`findUnique` 返回 null）。
 */
function fakeClient(
  scanRows: FakeOrderRow[],
  freshByOrderId: Record<string, FakeOrderRow | null> = {},
) {
  const updateCalls: Array<{ id: string; roomAssignment: unknown }> = [];
  const auditCalls: Array<{ tx: boolean; entry: Record<string, unknown> }> = [];

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    order: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) => {
        const fresh = where.id in freshByOrderId ? freshByOrderId[where.id] : scanRows.find((r) => r.id === where.id);
        return Promise.resolve(fresh ?? null);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: { roomAssignment: unknown } }) => {
        updateCalls.push({ id: where.id, roomAssignment: data.roomAssignment });
        return Promise.resolve({ id: where.id });
      }),
    },
    auditLog: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        auditCalls.push({ tx: true, entry: args.data });
        return Promise.resolve({});
      }),
    },
  };

  const client = {
    order: {
      findMany: vi.fn().mockResolvedValue(scanRows),
    },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaClient;

  return { client, updateCalls, auditCalls, tx };
}

describe('rewriteSharedRoomGroupIds（astra N9）', () => {
  it('dry-run：只预览不加锁、不写库、不产生审计', async () => {
    const { client, updateCalls } = fakeClient([
      {
        id: 'o1',
        orderNumber: 'ST-0001',
        roomAssignment: { roomGroups: [{ id: 'shared:sr1:item-a', passengerIds: ['p1'] }] },
      },
    ]);
    const result = await rewriteSharedRoomGroupIds(client, { apply: false });
    expect(result.scannedOrders).toBe(1);
    expect(result.candidateGroups).toBe(1);
    expect(result.rewrittenOrders).toBe(0);
    expect(updateCalls).toHaveLength(0);
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
    const { client, updateCalls, auditCalls } = fakeClient([scanRow]);
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });

    expect(result.rewrittenOrders).toBe(1);
    expect(result.rewrittenGroups).toBe(1);
    expect(updateCalls).toHaveLength(1);
    const written = updateCalls[0]!.roomAssignment as { note?: string; roomGroups: Array<{ id: string }> };
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
    const { client, updateCalls } = fakeClient([staleSnapshot], { o1: freshState });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });

    expect(result.rewrittenOrders).toBe(1);
    expect(result.rewrittenGroups).toBe(1); // 只有 item-a 那一个仍是旧式编码
    const written = updateCalls[0]!.roomAssignment as { roomGroups: Array<{ id: string; passengerIds: string[] }> };
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
    const { client, updateCalls } = fakeClient([scanRow], { o1: null });
    const result = await rewriteSharedRoomGroupIds(client, { apply: true });
    expect(result.rewrittenOrders).toBe(0);
    expect(updateCalls).toHaveLength(0);
  });
});
