/**
 * OrderMutation 内核 · 单测（mock prisma）：锁 / 幂等 / 审计进事务 / 守恒失败回滚 / 提交后钩子。
 * 真库上的行为（并发同 token 只执行一次、守恒失败整事务无半状态）在 order-mutation.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole, Prisma } from '@prisma/client';

const { mockPrisma, tx } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
    order: { findUnique: vi.fn() },
  };
  const mockPrisma = {
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    order: { findUnique: vi.fn() },
    orderSplitRecord: { findUnique: vi.fn() },
  };
  return { mockPrisma, tx };
});
vi.mock('../../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { runOrderMutation, runOrderOrchestration, lockOrderRowWithinTx } from './order-mutation.js';
import { NotFoundError } from '../../../lib/errors.js';

const actor = { userId: 'u-1', role: UserRole.ADMIN };

/** 一张账本平的单（内核守恒快照读的形状）。 */
const ledgerRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'FTM-1',
  subtotal: new Prisma.Decimal(1000),
  total: new Prisma.Decimal(1000),
  adjustmentCny: 0,
  adjustments: [],
  paidAmount: new Prisma.Decimal(300),
  prepaymentOffset: new Prisma.Decimal(0),
  passengers: [{ id: 'p1' }],
  items: [
    {
      id: 'i1',
      kind: 'FLIGHT',
      description: '去程',
      amount: new Prisma.Decimal(1000),
      quantity: 1,
      passengerId: null,
      flightScheduleId: 'sch-1',
      flightCabin: 'ECONOMY',
      metadata: null,
      roomsBilled: null,
      totalCostCny: null,
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([{ id: 'o1' }]);
  tx.auditLog.create.mockResolvedValue({ id: 'a1' });
  tx.order.findUnique.mockResolvedValue(ledgerRow());
});

describe('runOrderMutation · 行锁', () => {
  it('事务开头先 SELECT … FOR UPDATE 锁订单行，再跑 body', async () => {
    const order: string[] = [];
    tx.$queryRaw.mockImplementation(async () => {
      order.push('lock');
      return [{ id: 'o1' }];
    });
    const result = await runOrderMutation({ orderId: 'o1', actor, action: 'TEST' }, async (ctx) => {
      order.push('body');
      expect(ctx.tx).toBe(tx);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(order).toEqual(['lock', 'body']);
    const sql = (tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/SELECT id FROM "Order" WHERE id = \? FOR UPDATE/);
  });

  it('订单不存在 → NotFoundError「订单不存在」，body 不跑', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    const body = vi.fn();
    await expect(runOrderMutation({ orderId: 'nope', actor, action: 'TEST' }, body)).rejects.toThrow(
      NotFoundError,
    );
    await expect(runOrderMutation({ orderId: 'nope', actor, action: 'TEST' }, body)).rejects.toThrow(
      '订单不存在',
    );
    expect(body).not.toHaveBeenCalled();
  });

  it('lockOrderRowWithinTx 可单独复用（其它写路径逐步接入时用同一句 SQL）', async () => {
    await expect(lockOrderRowWithinTx(tx as never, 'o1')).resolves.toBeUndefined();
    tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(lockOrderRowWithinTx(tx as never, 'o1')).rejects.toThrow('订单不存在');
  });
});

describe('runOrderMutation · 幂等', () => {
  it('快路径：事务外 find(prisma) 命中 → 原样返回，不进事务、不拿锁、body 不跑', async () => {
    const find = vi.fn(async () => ({ replayed: true }));
    const body = vi.fn();
    const result = await runOrderMutation(
      { orderId: 'o1', actor, action: 'TEST', requestToken: 't1', idempotency: { find } },
      body,
    );
    expect(result).toEqual({ replayed: true });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(mockPrisma);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it('快路径未命中 → 拿锁后再查一次（并发双击时后到者在锁内命中）', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ replayed: true });
    const body = vi.fn();
    const hook = vi.fn();
    const result = await runOrderMutation(
      { orderId: 'o1', actor, action: 'TEST', requestToken: 't1', idempotency: { find } },
      async (ctx) => {
        ctx.afterCommit(hook);
        return body();
      },
    );
    expect(result).toEqual({ replayed: true });
    expect(find).toHaveBeenNthCalledWith(1, mockPrisma);
    expect(find).toHaveBeenNthCalledWith(2, tx);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1); // 锁在复查之前
    expect(body).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('fastPath:false → 只在锁内查（留痕在航段行 metadata 上，必须读锁后的行）', async () => {
    const find = vi.fn(async () => null);
    await runOrderMutation(
      { orderId: 'o1', actor, action: 'TEST', requestToken: 't1', idempotency: { find, fastPath: false } },
      async () => 'done',
    );
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(tx);
  });

  it('没有 requestToken → 不查幂等', async () => {
    const find = vi.fn();
    await runOrderMutation({ orderId: 'o1', actor, action: 'TEST', idempotency: { find } }, async () => 1);
    expect(find).not.toHaveBeenCalled();
  });

  it('find 抛错（入参指纹对不上一类）→ 原样上抛', async () => {
    const find = vi.fn(async () => {
      throw new Error('这个请求编号已经用于另一批乘客');
    });
    await expect(
      runOrderMutation(
        { orderId: 'o1', actor, action: 'TEST', requestToken: 't1', idempotency: { find } },
        async () => 1,
      ),
    ).rejects.toThrow('这个请求编号已经用于另一批乘客');
  });
});

describe('runOrderMutation · 审计进事务', () => {
  it('ctx.audit 走 tx.auditLog.create，actor 缺省取本次动作的 userId / role', async () => {
    await runOrderMutation({ orderId: 'o1', actor, action: 'CANCEL_RETURN_LEG' }, async (ctx) => {
      await ctx.audit({
        action: 'CANCEL_RETURN_LEG',
        targetType: 'ORDER',
        targetId: 'o1',
        after: { feeCny: 100 },
        severity: 'CRITICAL',
      });
      return 1;
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      actorUserId: 'u-1',
      actorRole: 'ADMIN',
      action: 'CANCEL_RETURN_LEG',
      targetType: 'ORDER',
      targetId: 'o1',
      severity: 'CRITICAL',
      after: { feeCny: 100 },
    });
  });

  it('审计写不成 → 整个事务失败（与业务写入同生共死），提交后钩子不跑', async () => {
    tx.auditLog.create.mockRejectedValue(new Error('audit down'));
    const hook = vi.fn();
    await expect(
      runOrderMutation({ orderId: 'o1', actor, action: 'TEST' }, async (ctx) => {
        ctx.afterCommit(hook);
        await ctx.audit({ action: 'TEST', targetType: 'ORDER', targetId: 'o1' });
        return 1;
      }),
    ).rejects.toThrow('audit down');
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('runOrderMutation · 提交后钩子', () => {
  it('钩子在事务提交后按注册顺序 await，body 抛错则一个不跑', async () => {
    const trace: string[] = [];
    mockPrisma.$transaction.mockImplementationOnce(async (fn: (t: unknown) => unknown) => {
      const r = await fn(tx);
      trace.push('commit');
      return r;
    });
    await runOrderMutation({ orderId: 'o1', actor, action: 'TEST' }, async (ctx) => {
      ctx.afterCommit(async () => {
        trace.push('hook-1');
      });
      ctx.afterCommit(() => {
        trace.push('hook-2');
      });
      trace.push('body');
      return 1;
    });
    expect(trace).toEqual(['body', 'commit', 'hook-1', 'hook-2']);

    const hook = vi.fn();
    await expect(
      runOrderMutation({ orderId: 'o1', actor, action: 'TEST' }, async (ctx) => {
        ctx.afterCommit(hook);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('runOrderMutation · 守恒', () => {
  it('点名维度前后不等 → 抛「…守恒断言失败…（已回滚）」，钩子不跑', async () => {
    tx.order.findUnique
      .mockResolvedValueOnce(ledgerRow())
      .mockResolvedValueOnce(ledgerRow({ paidAmount: new Prisma.Decimal(400) }));
    const hook = vi.fn();
    await expect(
      runOrderMutation(
        { orderId: 'o1', actor, action: 'SWAP_PASSENGER', conserve: { unchanged: ['paid'], label: '换人' } },
        async (ctx) => {
          ctx.afterCommit(hook);
          return 1;
        },
      ),
    ).rejects.toThrow(/换人守恒断言失败：已收.*¥300→¥400（已回滚）/);
    expect(hook).not.toHaveBeenCalled();
  });

  it('变的维度没被点名 → 放行', async () => {
    tx.order.findUnique
      .mockResolvedValueOnce(ledgerRow())
      .mockResolvedValueOnce(
        ledgerRow({
          total: new Prisma.Decimal(900),
          subtotal: new Prisma.Decimal(900),
          items: [{ ...ledgerRow().items[0], amount: new Prisma.Decimal(900) }],
        }),
      );
    await expect(
      runOrderMutation(
        { orderId: 'o1', actor, action: 'CANCEL_RETURN_LEG', conserve: { unchanged: ['paid', 'rooms'] } },
        async () => 'ok',
      ),
    ).resolves.toBe('ok');
  });

  it('账本恒等式：本次新引入的不平（subtotal ≠ Σ items）→ 回滚；存量就不平的放行', async () => {
    tx.order.findUnique
      .mockResolvedValueOnce(ledgerRow())
      .mockResolvedValueOnce(ledgerRow({ subtotal: new Prisma.Decimal(999), total: new Prisma.Decimal(999) }));
    await expect(
      runOrderMutation({ orderId: 'o1', actor, action: 'TEST', conserve: { unchanged: [] } }, async () => 1),
    ).rejects.toThrow(/TEST账本恒等式失败：FTM-1 SUBTOTAL_NE_ITEMS/);

    const dirty = ledgerRow({ subtotal: new Prisma.Decimal(999), total: new Prisma.Decimal(999) });
    tx.order.findUnique.mockResolvedValueOnce(dirty).mockResolvedValueOnce(dirty);
    await expect(
      runOrderMutation({ orderId: 'o1', actor, action: 'TEST', conserve: { unchanged: [] } }, async () => 1),
    ).resolves.toBe(1);
  });

  it('ctx.track 把 body 里才知道的订单（拆单新单）加进事后快照', async () => {
    // o2 是 body 里才建出来的单：事前快照读不到（null），事后按 id 读到才算数。
    tx.order.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === 'o1' ? ledgerRow() : null,
    );
    await runOrderMutation(
      { orderId: 'o1', actor, action: 'SPLIT_ORDER', conserve: { unchanged: ['receivable'] } },
      async (ctx) => {
        ctx.track('o2');
        return 1;
      },
    );
    const ids = tx.order.findUnique.mock.calls.map((c) => c[0].where.id);
    expect(ids).toEqual(['o1', 'o1', 'o2']);
  });

  it('不声明 conserve → 不读快照', async () => {
    await runOrderMutation({ orderId: 'o1', actor, action: 'TEST' }, async () => 1);
    expect(tx.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('runOrderOrchestration · 两段式编排', () => {
  it('幂等快路径命中 → body 不跑；未命中 → body 后按序跑钩子', async () => {
    const body = vi.fn(async () => 'x');
    const hit = await runOrderOrchestration(
      {
        orderId: 'o1',
        actor,
        action: 'RESCHEDULE_PASSENGERS',
        requestToken: 't',
        idempotency: { find: async () => 'replay' },
      },
      body,
    );
    expect(hit).toBe('replay');
    expect(body).not.toHaveBeenCalled();

    const trace: string[] = [];
    const result = await runOrderOrchestration(
      {
        orderId: 'o1',
        actor,
        action: 'RESCHEDULE_PASSENGERS',
        requestToken: 't',
        idempotency: { find: async () => null },
      },
      async (ctx) => {
        ctx.afterCommit(() => {
          trace.push('audit');
        });
        trace.push('body');
        return 'done';
      },
    );
    expect(result).toBe('done');
    expect(trace).toEqual(['body', 'audit']);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled(); // 编排本身不开事务
  });
});
