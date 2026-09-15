/**
 * reserveRequestOrReplay 单元测试（astra N10：幂等 pending 回收无所有权保护）。
 *
 * 反例：旧实现的孤儿占位回收只按 `requestToken + id` 删除，没有校验「此刻仍是 pending」——
 * 如果就在回收方读到 existing（判定超时）之后、真正执行删除之前，原持有者其实没死、只是
 * 慢，刚好在这个窗口写完了真结果，回收方按 id 删还是会把这条「刚成功」的记录删掉。
 * 修复后回收删除必须带 `resultJson: { equals: PENDING_SENTINEL }` 的条件 CAS：只有此刻
 * 仍确实是 pending 才删得掉。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  reserveRequestOrReplay,
  PENDING_SENTINEL,
} from './hotel-control.shared-rooms.js';
import type { SaveSharedRoomsBody } from './hotel-control.schemas.js';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

const body: SaveSharedRoomsBody = {
  hotelId: 'h1',
  checkIn: '2026-10-01',
  checkOut: '2026-10-02',
  requestToken: 'tok-1',
  rooms: [],
  dissolve: [],
};

describe('reserveRequestOrReplay（astra N10）', () => {
  it('新鲜占位（create 直接成功）→ 返回自己的占位行 id 作为 reservationId', async () => {
    const client = {
      sharedRoomRequest: {
        create: vi.fn().mockResolvedValue({ id: 'reservation-1' }),
      },
    } as unknown as PrismaClient;
    const result = await reserveRequestOrReplay(client, body, 'fp-1');
    expect(result).toEqual({ replay: null, reservationId: 'reservation-1' });
  });

  it('同 token 同指纹、已有真结果 → 回放，reservationId 为 null（回放路径没有新占位）', async () => {
    const realResult = { rooms: [], dissolved: [], warnings: [], orphanedSharedRoomIds: [] };
    const client = {
      sharedRoomRequest: {
        create: vi.fn().mockRejectedValue(p2002()),
        findUnique: vi.fn().mockResolvedValue({
          id: 'old-1',
          fingerprint: 'fp-1',
          resultJson: realResult,
          createdAt: new Date(),
        }),
      },
    } as unknown as PrismaClient;
    const result = await reserveRequestOrReplay(client, body, 'fp-1');
    expect(result).toEqual({ replay: realResult, reservationId: null });
  });

  it('P2 修复（批 10）：部署前写入的占位行 resultJson 不带 orphanedSharedRoomIds/warnings/dissolved → 回放时逐字段兜底成 []，类型不撒谎', async () => {
    // 模拟批 9 之前（orphanedSharedRoomIds 字段引入前）写入的真结果——只有 rooms，
    // 其它三个字段在那个年代的代码里根本不存在。
    const legacyResult = { rooms: [{ sharedRoomId: 'sr-1', version: 3 }] };
    const client = {
      sharedRoomRequest: {
        create: vi.fn().mockRejectedValue(p2002()),
        findUnique: vi.fn().mockResolvedValue({
          id: 'old-legacy',
          fingerprint: 'fp-1',
          resultJson: legacyResult,
          createdAt: new Date(),
        }),
      },
    } as unknown as PrismaClient;
    const result = await reserveRequestOrReplay(client, body, 'fp-1');
    expect(result).toEqual({
      replay: {
        rooms: [{ sharedRoomId: 'sr-1', version: 3 }],
        dissolved: [],
        warnings: [],
        orphanedSharedRoomIds: [],
      },
      reservationId: null,
    });
  });

  it('astra N10（核心反例）：孤儿占位回收的删除条件必须带「仍是 pending」的 CAS，不能只按 id', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 }); // CAS 未命中：此刻已经不是 pending 了
    const client = {
      sharedRoomRequest: {
        create: vi.fn().mockRejectedValue(p2002()),
        findUnique: vi.fn().mockResolvedValue({
          id: 'stale-reservation',
          fingerprint: 'fp-1',
          resultJson: PENDING_SENTINEL,
          createdAt: new Date(Date.now() - 11 * 60 * 1000), // 超过 10 分钟孤儿超时窗口
        }),
        deleteMany,
      },
    } as unknown as PrismaClient;

    await expect(reserveRequestOrReplay(client, body, 'fp-1')).rejects.toThrow(
      /请稍后使用同一请求编号重试/,
    );

    // 删除条件必须显式带上「仍为 PENDING_SENTINEL」，不能只有 requestToken + id——
    // 这正是本条回归要钉住的地方：少了这个条件，回收方会把「原持有者刚写完的真结果」
    // 连带删掉。
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0]![0].where;
    expect(where.id).toBe('stale-reservation');
    expect(where.requestToken).toBe(body.requestToken);
    expect(where.resultJson).toEqual({ equals: PENDING_SENTINEL });
  });

  it('孤儿占位确实仍是 pending → CAS 命中，抢占成功并生成新的 reservationId', async () => {
    let createCallCount = 0;
    const client = {
      sharedRoomRequest: {
        create: vi.fn().mockImplementation(() => {
          createCallCount += 1;
          if (createCallCount === 1) return Promise.reject(p2002());
          return Promise.resolve({ id: 'new-reservation' });
        }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'stale-reservation',
          fingerprint: 'fp-1',
          resultJson: PENDING_SENTINEL,
          createdAt: new Date(Date.now() - 11 * 60 * 1000),
        }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }), // CAS 命中：确实还是 pending，删成功
      },
    } as unknown as PrismaClient;

    const result = await reserveRequestOrReplay(client, body, 'fp-1');
    expect(result).toEqual({ replay: null, reservationId: 'new-reservation' });
    expect(result.reservationId).not.toBe('stale-reservation'); // 新占位是独立的一行，id 不同
  });
});
