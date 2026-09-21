/**
 * 导出分批取数（orders.export-fetch.ts）。
 *
 * 这层的存在理由是「一次裸查整月会撞 napi 单字符串上限 → 导出 500」，所以测试盯的不是
 * 渲染，而是三件事：切片边界对不对、结果顺序是不是还等于 orderBy 排好的顺序、
 * 以及 where/orderBy/include 有没有被原样透传（口径不能在这一层悄悄变形）。
 */
import { describe, it, expect, vi } from 'vitest';

import type { PrismaClient } from '@prisma/client';
import { fetchOrdersInChunks, ORDER_EXPORT_CHUNK_SIZE } from './orders.export-fetch.js';

interface FakeOrder {
  id: string;
  createdAt: Date;
  label: string;
}

/** 第二步的 where 形态：`{ AND: [原 where, { id: { in: [...] } }] }`。*/
interface FetchCond {
  id?: { in?: string[] };
  agentId?: { in?: string[] };
  deletedAt?: null;
}
type FetchWhere = { AND?: FetchCond[] };

/** 从一次 findMany 调用里取出这批的 id 列表；盘点那一次返回 undefined。*/
function sliceOf(args?: { where?: FetchWhere }): string[] | undefined {
  return args?.where?.AND?.find((c) => c.id?.in != null)?.id?.in;
}

/**
 * 假 client：按 where 形态分流，完整模拟真实 Prisma 的两种调用。
 *   - where 里没有 id.in（盘点 id）→ 按 createdAt 倒序返回全部 { id }；
 *   - where 是 `AND: [原 where, { id: { in } }]`（取实体）→ 只返回该批 id 的实体，且
 *     **故意打乱顺序**（真实数据库对 `id in (...)` 不保证顺序），用来验证 helper 自己重排。
 */
function fakeClient(rows: FakeOrder[]): {
  client: PrismaClient;
  findMany: ReturnType<typeof vi.fn>;
} {
  const byCreatedDesc = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const findMany = vi.fn(async (args?: { where?: FetchWhere }) => {
    const idIn = sliceOf(args);
    if (!idIn) return byCreatedDesc.map((r) => ({ id: r.id }));
    return byCreatedDesc.filter((r) => idIn.includes(r.id)).reverse(); // 乱序返回
  });
  return { client: { order: { findMany } } as unknown as PrismaClient, findMany };
}

/** 各批实际取了哪些 id（按调用顺序），盘点那一次不计入。*/
function chunkIds(findMany: ReturnType<typeof vi.fn>): string[][] {
  return findMany.mock.calls
    .map((c) => sliceOf(c[0] as { where?: FetchWhere }))
    .filter((ids): ids is string[] => ids != null);
}

/** 生成 n 条订单，createdAt 递减 → 倒序即 o1, o2, … on。*/
function makeOrders(n: number): FakeOrder[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `o${i + 1}`,
    createdAt: new Date(Date.UTC(2026, 8, 30 - i)),
    label: `label-${i + 1}`,
  }));
}

const ARGS = {
  where: { deletedAt: null },
  orderBy: { createdAt: 'desc' },
  include: { passengers: true },
} as unknown as Parameters<typeof fetchOrdersInChunks>[1];

describe('fetchOrdersInChunks — 切片边界', () => {
  it('0 条：盘点 id 后短路，不再发取实体的查询', async () => {
    const { client, findMany } = fakeClient([]);
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 3);
    expect(out).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1); // 只有盘点那一次
  });

  it('不足一批：1 条 → 盘点 1 次 + 取实体 1 次', async () => {
    const { client, findMany } = fakeClient(makeOrders(1));
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 3);
    expect(out.map((o) => o.id)).toEqual(['o1']);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('恰好整除：6 条 / 每批 3 → 2 批，不多切出一个空批', async () => {
    const { client, findMany } = fakeClient(makeOrders(6));
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 3);
    expect(out.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);
    expect(findMany).toHaveBeenCalledTimes(3); // 盘点 1 + 取实体 2
    expect(chunkIds(findMany).map((ids) => ids.length)).toEqual([3, 3]);
  });

  it('有余数：7 条 / 每批 3 → 3 批（3+3+1），一条都不丢', async () => {
    const { client, findMany } = fakeClient(makeOrders(7));
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 3);
    expect(out).toHaveLength(7);
    expect(out.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']);
    expect(chunkIds(findMany).map((ids) => ids.length)).toEqual([3, 3, 1]);
  });

  it('缺省批量 = ORDER_EXPORT_CHUNK_SIZE：正好 150 条仍是单批，151 条才切成两批', async () => {
    const exact = fakeClient(makeOrders(ORDER_EXPORT_CHUNK_SIZE));
    const exactOut = await fetchOrdersInChunks<FakeOrder>(exact.client, ARGS);
    expect(exactOut).toHaveLength(ORDER_EXPORT_CHUNK_SIZE);
    expect(exact.findMany).toHaveBeenCalledTimes(2); // 盘点 1 + 单批 1

    const overflow = fakeClient(makeOrders(ORDER_EXPORT_CHUNK_SIZE + 1));
    const overflowOut = await fetchOrdersInChunks<FakeOrder>(overflow.client, ARGS);
    expect(overflowOut).toHaveLength(ORDER_EXPORT_CHUNK_SIZE + 1);
    expect(overflow.findMany).toHaveBeenCalledTimes(3); // 盘点 1 + 两批（150 + 1）
  });

  it('非正整数批量直接报错，不静默退化成一次裸查', async () => {
    const { client } = fakeClient(makeOrders(3));
    await expect(fetchOrdersInChunks<FakeOrder>(client, ARGS, 0)).rejects.toThrow('chunkSize');
    await expect(fetchOrdersInChunks<FakeOrder>(client, ARGS, -1)).rejects.toThrow('chunkSize');
    await expect(fetchOrdersInChunks<FakeOrder>(client, ARGS, 1.5)).rejects.toThrow('chunkSize');
  });
});

describe('fetchOrdersInChunks — 保序', () => {
  it('结果顺序 = 盘点 id 的顺序（即 orderBy createdAt desc），不随各批返回顺序漂移', async () => {
    const rows = makeOrders(7); // createdAt 递减 → 倒序即 o1…o7
    const { client } = fakeClient(rows);
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 3);
    // 假 client 每批都是乱序返回的，helper 必须自己排回来
    expect(out.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7']);
    // 顺序与「直接按 createdAt 倒序排全表」完全一致
    const expected = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(out.map((o) => o.id)).toEqual(expected.map((o) => o.id));
  });

  it('跨批也保序：把 createdAt 打乱后，结果仍严格按 createdAt 倒序', async () => {
    const rows: FakeOrder[] = [
      { id: 'a', createdAt: new Date('2026-09-03T00:00:00Z'), label: 'a' },
      { id: 'b', createdAt: new Date('2026-09-07T00:00:00Z'), label: 'b' },
      { id: 'c', createdAt: new Date('2026-09-01T00:00:00Z'), label: 'c' },
      { id: 'd', createdAt: new Date('2026-09-09T00:00:00Z'), label: 'd' },
      { id: 'e', createdAt: new Date('2026-09-05T00:00:00Z'), label: 'e' },
    ];
    const { client } = fakeClient(rows);
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 2);
    expect(out.map((o) => o.id)).toEqual(['d', 'b', 'e', 'a', 'c']);
  });

  it('取回的是完整实体（带 include 的字段），不是只有 id', async () => {
    const { client } = fakeClient(makeOrders(4));
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 2);
    expect(out.map((o) => o.label)).toEqual(['label-1', 'label-2', 'label-3', 'label-4']);
  });

  it('两步之间订单消失 → 该单不出现在结果里，其余顺序不受影响（不留空洞）', async () => {
    const rows = makeOrders(5);
    const findMany = vi.fn(async (args?: { where?: FetchWhere }) => {
      const idIn = sliceOf(args);
      if (!idIn) return rows.map((r) => ({ id: r.id }));
      // o3 在第二步被删掉了，取不回来
      return rows.filter((r) => idIn.includes(r.id) && r.id !== 'o3');
    });
    const client = { order: { findMany } } as unknown as PrismaClient;
    const out = await fetchOrdersInChunks<FakeOrder>(client, ARGS, 2);
    expect(out.map((o) => o.id)).toEqual(['o1', 'o2', 'o4', 'o5']);
  });

  it('两步之间某单不再满足 where（被改归别家代理）→ 第二步就取不回来，不会混进结果', async () => {
    // 代理 a1 在导自己的单：where 带 agentScope。假 client 会**真的**按 where 判读，
    // 不是只看 id —— 第二步若丢了原条件，o3 就会被取回来导出去（越权）。
    const rows = makeOrders(5);
    const ownerOf = new Map(rows.map((r) => [r.id, 'a1']));
    const scopedArgs = {
      where: { deletedAt: null, agentId: { in: ['a1'] } },
      orderBy: { createdAt: 'desc' },
      include: { passengers: true },
    } as unknown as Parameters<typeof fetchOrdersInChunks>[1];

    const findMany = vi.fn(async (args?: { where?: FetchWhere }) => {
      const idIn = sliceOf(args);
      if (!idIn) return rows.map((r) => ({ id: r.id })); // 盘点时 5 张都还归 a1
      // 盘点之后、取实体之前：o3 被改归 a2，从此不再命中 where。
      ownerOf.set('o3', 'a2');
      const scope = args?.where?.AND?.find((c) => c.agentId?.in != null)?.agentId?.in;
      return rows.filter(
        (r) => idIn.includes(r.id) && (scope == null || scope.includes(ownerOf.get(r.id) as string)),
      );
    });
    const client = { order: { findMany } } as unknown as PrismaClient;
    const out = await fetchOrdersInChunks<FakeOrder>(client, scopedArgs, 2);

    expect(out.map((o) => o.id)).toEqual(['o1', 'o2', 'o4', 'o5']); // o3 消失，顺序不乱
    // 每一批都带着原条件（agentScope），不是只按 id 取
    for (const call of findMany.mock.calls.slice(1)) {
      expect((call[0] as { where: FetchWhere }).where.AND).toContainEqual({
        deletedAt: null,
        agentId: { in: ['a1'] },
      });
    }
  });
});

describe('fetchOrdersInChunks — 口径透传', () => {
  it('where / orderBy 原样进盘点查询；取实体这步 where = 原条件 AND id in，include 原样', async () => {
    const { client, findMany } = fakeClient(makeOrders(2));
    await fetchOrdersInChunks<FakeOrder>(client, ARGS, 10);

    const [idPass, entityPass] = findMany.mock.calls.map((c) => c[0] as Record<string, unknown>);
    // 盘点：原样的 where + orderBy，只取 id（序列化压力可忽略，不会撞 napi 上限）
    expect(idPass.where).toEqual({ deletedAt: null });
    expect(idPass.orderBy).toEqual({ createdAt: 'desc' });
    expect(idPass.select).toEqual({ id: true });
    expect(idPass.include).toBeUndefined();
    // 取实体：原条件与 id 切片取交集 —— 原条件里装着 agentScope / 软删 / 状态这些闸，
    // 丢了它就等于放行两步之间发生的越权与状态变更（不是「把筛选跑两遍」的冗余）。
    expect(entityPass.where).toEqual({
      AND: [{ deletedAt: null }, { id: { in: ['o1', 'o2'] } }],
    });
    expect(entityPass.include).toEqual({ passengers: true });
    expect(entityPass.select).toBeUndefined();
    // 顺序不靠这一步：`id in` 的返回顺序由数据库决定，重排靠第一步的 id 顺序。
    expect(entityPass.orderBy).toBeUndefined();
  });
});
