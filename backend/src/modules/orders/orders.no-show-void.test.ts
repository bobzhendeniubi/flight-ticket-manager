/**
 * 回程「起飞后自动作废」后台扫描 · 服务级单测（mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. 原班次已起飞满 2 小时 → 推到终态；快照 / 物化列 / 待办收口都到位。
 *   2. 缓冲期内（刚过起飞点不到 2 小时）→ 不动，留给人工。
 *   3. 已恢复回班次 / 已作废过 → 跳过（幂等）。
 *   4. 原班次查不到 → 不自动作废（判不出飞没飞，交人工）。
 *   5. 全程**不动座位、不动钱**。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    orderItem: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    operationalReminder: { updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  voidDepartedReleasedReturnLegs,
  RETURN_VOID_DEPARTED_GRACE_MS,
  VOID_SCAN_PAGE_SIZE,
} from './no-show-void.js';

const NOW = new Date('2026-09-10T12:00:00Z');
/** 起飞满 2 小时以上（缓冲期已过）。 */
const LONG_DEPARTED = new Date(NOW.getTime() - RETURN_VOID_DEPARTED_GRACE_MS - 60_000);
/** 刚过起飞点、还在缓冲期内。 */
const JUST_DEPARTED = new Date(NOW.getTime() - 30 * 60_000);

const RELEASED_AT = '2026-09-09T02:00:00.000Z';
const releasedMeta = (over: Record<string, unknown> = {}) => ({
  returnReleased: {
    at: RELEASED_AT,
    originalScheduleId: 'sch-ret',
    releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
  },
  ...over,
});

/** 候选行（粗筛查询的返回形状）。 */
const candidate = (metadata: unknown) => ({ id: 'leg-ret', orderId: 'ord-1', metadata });

function arm(opts: {
  candidates?: unknown[];
  /** 锁内重读到的行（缺省 = 与候选同一份）。 */
  locked?: Record<string, unknown> | null;
  departureTime?: Date | null;
} = {}) {
  const candidates = opts.candidates ?? [candidate(releasedMeta())];
  // 三种 orderItem.findMany 按 where 形状区分：
  //   · 候选粗筛      —— 没有 orderId（全库扫）
  //   · hasReturnLeg  —— 带 orderId + flightScheduleId:{not:null}（作废后一段有效航段都不剩）
  //   · legFlag       —— 带 orderId、不带 flightScheduleId（回读全部 FLIGHT 行现算状态）
  mockPrisma.orderItem.findMany.mockImplementation(
    async (args: { where?: { orderId?: unknown; flightScheduleId?: unknown } }) => {
      const where = args?.where ?? {};
      if (where.orderId == null) return candidates;
      if (where.flightScheduleId !== undefined) return [];
      return [
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: releasedMeta({ returnVoidedFinal: { at: NOW.toISOString() } }),
        },
      ];
    },
  );
  mockPrisma.orderItem.findUnique.mockResolvedValue(
    opts.locked === undefined
      ? {
          id: 'leg-ret',
          orderId: 'ord-1',
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: releasedMeta(),
        }
      : opts.locked,
  );
  mockPrisma.orderItem.update.mockResolvedValue({});
  mockPrisma.order.findUnique.mockResolvedValue({
    orderNumber: 'FTM20260910-001',
    adjustments: [],
  });
  mockPrisma.order.update.mockResolvedValue({});
  mockPrisma.flightSchedule.findUnique.mockResolvedValue(
    opts.departureTime === undefined
      ? { departureTime: LONG_DEPARTED }
      : opts.departureTime && { departureTime: opts.departureTime },
  );
  mockPrisma.operationalReminder.updateMany.mockResolvedValue({ count: 2 });
  mockPrisma.$queryRaw.mockResolvedValue([{ id: 'ord-1' }]);
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(mockPrisma));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('回程起飞后自动作废 · 扫描', () => {
  it('起飞满 2 小时仍停在已释放态 → 推到终态，快照带 SYSTEM 与批次号', async () => {
    arm();
    const res = await voidDepartedReleasedReturnLegs(
      mockPrisma as never,
      NOW,
    );
    expect(res).toMatchObject({ scanned: 1, voided: 1 });
    expect(res.jobId).toContain('noshow-void-');

    const data = mockPrisma.orderItem.update.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(data.data.metadata.returnVoidedFinal).toMatchObject({
      byUserId: 'SYSTEM',
      jobId: res.jobId,
    });
    // job 没有请求编号，流水里用批次号占位（形状永不与前端 uuid 撞车）。
    const log = data.data.metadata.legActionLog as Array<Record<string, unknown>>;
    expect(log[0]).toMatchObject({ type: 'VOID', requestToken: `job:${res.jobId}` });

    // 座位、钱一个字都不写。
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
    for (const key of ['unitPrice', 'amount', 'unitCostCny', 'totalCostCny', 'flightScheduleId']) {
      expect(data.data).not.toHaveProperty(key);
    }
    const orderUpdates = mockPrisma.order.update.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data,
    );
    for (const d of orderUpdates) {
      expect(d).not.toHaveProperty('subtotal');
      expect(d).not.toHaveProperty('total');
    }
    // 物化列落到 RETURN_VOIDED；两条待办一起关掉。
    expect(orderUpdates.some((d) => d.legFlag === 'RETURN_VOIDED')).toBe(true);
    const rem = mockPrisma.operationalReminder.updateMany.mock.calls[0][0] as {
      where: { ruleKey: { in: string[] } };
      data: { status: string; resolvedNote: string };
    };
    expect(rem.where.ruleKey.in).toEqual([
      `NOSHOW_RELEASED:leg-ret:${RELEASED_AT}`,
      `NOSHOW_RELEASED:leg-ret:${RELEASED_AT}:DEPARTED`,
    ]);
    expect(rem.data.status).toBe('DONE');
    expect(rem.data.resolvedNote).toContain('系统自动作废');
  });

  it('刚过起飞点、还在 2 小时缓冲期内 → 不动（留给人工「恢复回程」）', async () => {
    arm({ departureTime: JUST_DEPARTED });
    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res).toMatchObject({ scanned: 1, voided: 0 });
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('已经作废过 → 粗筛就跳过（幂等，不重复写）', async () => {
    arm({
      candidates: [candidate(releasedMeta({ returnVoidedFinal: { at: RELEASED_AT } }))],
    });
    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res).toMatchObject({ scanned: 1, voided: 0 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('拿锁期间被人工恢复（占回班次）→ 锁内重判后放弃，绝不把恢复好的单又作废掉', async () => {
    arm({
      locked: {
        id: 'leg-ret',
        orderId: 'ord-1',
        kind: 'FLIGHT',
        flightScheduleId: 'sch-ret', // 已经占回班次
        metadata: releasedMeta({ returnRestored: { at: '2026-09-10T11:00:00.000Z' } }),
      },
    });
    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res).toMatchObject({ scanned: 1, voided: 0 });
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('原班次已被删除 → 不自动作废（判不出飞没飞，交人工端点处置）', async () => {
    arm({ departureTime: null });
    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res).toMatchObject({ scanned: 1, voided: 0 });
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('释放快照里没有原班次 id → 跳过（无从判定）', async () => {
    arm({ candidates: [candidate({ returnReleased: { at: RELEASED_AT } })] });
    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res).toMatchObject({ scanned: 1, voided: 0 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ── 候选集粗筛：能让数据库筛的一律别捞回内存 ────────────────────────────────
  it('粗筛 where 排除「已作废」与「回收站单」，并带游标分页', async () => {
    arm();
    await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);

    const args = mockPrisma.orderItem.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      take: number;
      orderBy: Record<string, string>;
    };
    expect(args.where).toMatchObject({
      kind: 'FLIGHT',
      flightScheduleId: null,
      order: { deletedAt: null },
    });
    const and = args.where.AND as Array<{ metadata: { path: string[]; equals?: unknown; not?: unknown } }>;
    expect(and.map((c) => c.metadata.path[0])).toEqual(['returnReleased', 'returnVoidedFinal']);
    // 已作废的那一条走 equals DbNull（= 这一行还没有终态标）。
    expect(and[1].metadata).toHaveProperty('equals');
    expect(args.take).toBe(VOID_SCAN_PAGE_SIZE);
    expect(args.orderBy).toEqual({ id: 'asc' });
  });

  it('满页 → 按 id 游标继续翻下一页，直到不满一页为止', async () => {
    arm();
    const fullPage = Array.from({ length: VOID_SCAN_PAGE_SIZE }, (_, i) => ({
      id: `leg-${i}`,
      orderId: 'ord-1',
      // 没有原班次 id → 逐条跳过（本例只验翻页，不验作废动作）。
      metadata: { returnReleased: { at: RELEASED_AT } },
    }));
    let call = 0;
    mockPrisma.orderItem.findMany.mockImplementation(
      async (args: { where?: { orderId?: unknown } }) => {
        if (args?.where?.orderId != null) return [];
        call += 1;
        return call === 1 ? fullPage : [];
      },
    );

    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res.scanned).toBe(VOID_SCAN_PAGE_SIZE);
    expect(call).toBe(2);
    const second = mockPrisma.orderItem.findMany.mock.calls[1][0] as {
      cursor?: { id: string };
      skip?: number;
    };
    expect(second.cursor).toEqual({ id: `leg-${VOID_SCAN_PAGE_SIZE - 1}` });
    expect(second.skip).toBe(1);
  });

  // ── 逐条容错：一条炸了不能把整轮打断（本 job 每小时才跑一次）────────────────
  it('一条处理失败 → 计进 failed 并继续跑完整轮，其余单照常作废', async () => {
    arm({
      candidates: [
        { id: 'leg-bad', orderId: 'ord-bad', metadata: releasedMeta() },
        { id: 'leg-ret', orderId: 'ord-1', metadata: releasedMeta() },
      ],
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 第一条的行锁查询抛错，第二条正常。
    let first = true;
    mockPrisma.$queryRaw.mockImplementation(async () => {
      if (first) {
        first = false;
        throw new Error('deadlock detected');
      }
      return [{ id: 'ord-1' }];
    });

    const res = await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(res).toMatchObject({ scanned: 2, voided: 1, failed: 1 });
    // 日志里必须能看出是哪一单（否则线上只剩一句无主的堆栈）。
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('ord-bad'),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('审计与作废同一事务写（重试时补不回来的东西不能 fire-and-forget）', async () => {
    arm();
    await voidDepartedReleasedReturnLegs(mockPrisma as never, NOW);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const entry = mockPrisma.auditLog.create.mock.calls[0][0] as {
      data: { action: string; targetId: string; severity: string };
    };
    expect(entry.data).toMatchObject({
      action: 'VOID_RETURN_LEG',
      targetId: 'ord-1',
      severity: 'WARNING',
    });
  });
});
