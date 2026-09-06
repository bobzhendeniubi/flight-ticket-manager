/**
 * 按人份额 · 唯一写点单测（mock 事务客户端）。
 * 真库上的行为（拆单两侧 / 换人 / 调价链 / lazy 回填 / 幂等）在 passenger-shares.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { $transaction: vi.fn(), $queryRaw: vi.fn() },
}));
vi.mock('../../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  backfillPassengerShares,
  lazyPersistPassengerShares,
  persistPassengerShares,
  SHARE_SOURCE_SELECT,
} from './passenger-shares.js';
import { PASSENGER_SHARE_ALGO_VERSION } from '../passenger-shares.js';

const shareSourceRow = () => ({
  id: 'o1',
  orderNumber: 'FTM-1',
  total: new Prisma.Decimal(1000),
  adjustmentCny: 0,
  adjustments: [],
  passengers: [
    { id: 'p2', visaExempt: false, singleRoom: false },
    { id: 'p1', visaExempt: true, singleRoom: true },
  ],
  items: [
    {
      id: 'i1',
      kind: 'FLIGHT',
      amount: new Prisma.Decimal(800),
      description: '去程',
      passengerId: null,
      metadata: null,
      bundle: null,
    },
    {
      id: 'i2',
      kind: 'FEE',
      amount: new Prisma.Decimal(200),
      description: '补收',
      passengerId: 'p1',
      metadata: { priceAdjustment: true, reasonCode: 'MISC_FEE' },
      bundle: null,
    },
  ],
});

function makeTx(opts: { withDelegate?: boolean; order?: unknown } = {}) {
  const delegate = {
    deleteMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async (args: unknown) => args),
  };
  const tx = {
    order: { findUnique: vi.fn(async () => (opts.order === undefined ? shareSourceRow() : opts.order)) },
    ...(opts.withDelegate === false ? {} : { orderPassengerShare: delegate }),
    $queryRaw: vi.fn(),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, delegate, findUnique: tx.order.findUnique };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('persistPassengerShares', () => {
  it('读订单（SHARE_SOURCE_SELECT）→ 清掉不在单上的旧行 → 每位乘客 upsert 一行，值 = 派生', async () => {
    const { tx, delegate, findUnique } = makeTx();
    const res = await persistPassengerShares(tx, 'o1');

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'o1' }, select: SHARE_SOURCE_SELECT });
    expect(delegate.deleteMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', passengerId: { notIn: ['p2', 'p1'] } },
    });
    expect(delegate.upsert).toHaveBeenCalledTimes(2);
    const byPid = new Map(
      delegate.upsert.mock.calls.map(([args]) => {
        const a = args as { where: { orderId_passengerId: { passengerId: string } }; update: Record<string, unknown> };
        return [a.where.orderId_passengerId.passengerId, a.update];
      }),
    );
    // 1000 应收 − 200 按人补收 = 800 均摊 → 每人 400；p1 再加自己那 200。
    expect(String(byPid.get('p1')!.settlementCny)).toBe('600');
    expect(String(byPid.get('p1')!.baseCny)).toBe('400');
    expect(String(byPid.get('p1')!.adjustmentCny)).toBe('200');
    expect(String(byPid.get('p2')!.settlementCny)).toBe('400');
    expect(String(byPid.get('p2')!.adjustmentCny)).toBe('0');
    expect(byPid.get('p1')!.algoVersion).toBe(PASSENGER_SHARE_ALGO_VERSION);
    expect(byPid.get('p1')!.computedAt).toBeInstanceOf(Date);
    // create 分支带 orderId / passengerId
    const first = delegate.upsert.mock.calls[0][0] as { create: { orderId: string; passengerId: string } };
    expect(first.create.orderId).toBe('o1');

    expect(res).toMatchObject({ orderId: 'o1', orderNumber: 'FTM-1', removed: 1, payableCny: 1000, excludedCny: 0 });
    expect(res!.rows.map((r) => r.passengerId)).toEqual(['p2', 'p1']);
  });

  it('订单不存在 → null，不写', async () => {
    const { tx, delegate } = makeTx({ order: null });
    expect(await persistPassengerShares(tx, 'gone')).toBeNull();
    expect(delegate.upsert).not.toHaveBeenCalled();
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });

  it('无乘客 → 清空本单全部行、不 upsert', async () => {
    const { tx, delegate } = makeTx({ order: { ...shareSourceRow(), passengers: [] } });
    const res = await persistPassengerShares(tx, 'o1');
    expect(delegate.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'o1' } });
    expect(delegate.upsert).not.toHaveBeenCalled();
    expect(res!.rows).toEqual([]);
  });

  it('mock 事务客户端没有 orderPassengerShare 委托 → null，且不碰 order.findUnique（不吃业务代码排队的 mock 值）', async () => {
    const { tx, findUnique } = makeTx({ withDelegate: false });
    expect(await persistPassengerShares(tx, 'o1')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('lazyPersistPassengerShares · 读侧顺手回填', () => {
  it('NOWAIT 拿到锁 → 走写点 → PERSISTED', async () => {
    const { tx, delegate } = makeTx();
    (tx.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'o1' }]);
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    expect(await lazyPersistPassengerShares('o1')).toBe('PERSISTED');
    expect(delegate.upsert).toHaveBeenCalledTimes(2);
  });

  it('撞锁（55P03）→ LOCKED，不上抛', async () => {
    mockPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('lock', { code: 'P2010', clientVersion: 'x', meta: { code: '55P03' } }),
    );
    expect(await lazyPersistPassengerShares('o1')).toBe('LOCKED');
  });

  it('订单不存在 → MISSING；其它错误 → FAILED（只记日志）', async () => {
    const { tx } = makeTx({ order: null });
    (tx.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    expect(await lazyPersistPassengerShares('o1')).toBe('MISSING');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockPrisma.$transaction.mockRejectedValue(new Error('boom'));
    expect(await lazyPersistPassengerShares('o1')).toBe('FAILED');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('backfillPassengerShares · 分批幂等', () => {
  it('挑出缺行的活单逐单回填，回报 persisted / locked / failed / remaining', async () => {
    const { tx } = makeTx();
    (tx.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'x' }]);
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) // 候选
      .mockResolvedValueOnce([{ n: 1 }]); // remaining
    let call = 0;
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
      call += 1;
      if (call === 2) {
        throw new Prisma.PrismaClientKnownRequestError('lock', { code: 'P2010', clientVersion: 'x', meta: { code: '55P03' } });
      }
      if (call === 3) throw new Error('boom');
      return fn(tx);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const progress: Array<[number, number]> = [];
    const res = await backfillPassengerShares({ limit: 3, onProgress: (d, t) => progress.push([d, t]) });
    warn.mockRestore();
    expect(res).toEqual({ scanned: 3, persisted: 1, locked: 1, failed: 1, remaining: 1 });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
});
