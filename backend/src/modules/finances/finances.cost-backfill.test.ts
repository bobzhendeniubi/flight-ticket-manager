/**
 * 存量成本快照回填 · 单元测试（vitest）
 *
 * 回填一按会改动整本订单簿上的毛利，所以要钉死的不是「能不能填上」，而是**不该填的时候
 * 一定不填**：
 *   · 只碰 totalCostCny 为 NULL 的行，且写的时候 where 里再夹一次 null（并发下不覆盖别人刚填的）；
 *   · 算不出来的行原样留 NULL 并按原因记数，绝不写 0 让毛利虚高；
 *   · dry-run 一个字都不写库，返回的数就是 --apply 会写进去的数；
 *   · 游标要往前走 —— 算不出来的行会一直留在候选集里，不带游标会在同一批上原地打转。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { Prisma, type PrismaClient } from '@prisma/client';
import { backfillItemCostSnapshots } from './finances.cost-backfill.js';

/** 一条能算出成本的班次：包机 180000 ÷ 180 座 + 税 50 + 燃油 30 = 每座 1080。 */
const SCHEDULE = {
  id: 'sched-1',
  flightId: 'flight-1',
  departureTime: new Date('2026-09-10T02:00:00Z'),
  departureTz: 'Asia/Macau',
  costLocked: false,
  charterCostCny: new Prisma.Decimal(180_000),
  airportTaxDepCny: new Prisma.Decimal(50),
  airportTaxArrCny: null,
  fuelCostCny: new Prisma.Decimal(30),
  peakSurchargeCny: null,
  aircraftAdjustCny: null,
  takeoffDiscountCny: null,
  seatClasses: [{ capacity: 180 }],
};

function flightRow(id: string, scheduleId: string | null = 'sched-1') {
  return {
    id,
    kind: 'FLIGHT',
    quantity: 2,
    flightScheduleId: scheduleId,
    roomsBilled: null,
    hotelRoomType: null,
    bundle: null,
    order: { passengers: [{ visaExempt: false }, { visaExempt: false }] },
  };
}

function bundleRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'BUNDLE',
    quantity: 1,
    flightScheduleId: null,
    roomsBilled: new Prisma.Decimal(1),
    hotelRoomType: { costPriceCny: new Prisma.Decimal(400) },
    bundle: { items: [{ kind: 'HOTEL', qty: 4, unitPrice: 0 }] },
    order: { passengers: [{ visaExempt: false }, { visaExempt: false }] },
    ...over,
  };
}

/** 分批返回候选行（第一次给 batches[0]，第二次给 batches[1]…，之后给空）。 */
function backfillClient(batches: unknown[][], schedules: unknown[] = [SCHEDULE]) {
  let call = 0;
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockImplementation(async () => batches[call++] ?? []);
  const raw = {
    orderItem: { findMany, updateMany },
    flightSchedule: { findMany: vi.fn().mockResolvedValue(schedules) },
    flightCostPeriod: { findMany: vi.fn().mockResolvedValue([]) },
    visa: { findMany: vi.fn().mockResolvedValue([]) },
    transfer: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation(async (ops: unknown[]) => ops),
  };
  return { client: raw as unknown as PrismaClient, findMany, updateMany, raw };
}

describe('backfillItemCostSnapshots — 只填 NULL，算不出来就跳过', () => {
  it('dry-run（缺省）：一个字都不写库，但返回的数就是 --apply 会写进去的数', async () => {
    const { client, updateMany, raw } = backfillClient([[flightRow('i1')]]);

    const result = await backfillItemCostSnapshots({}, client);

    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.filled).toBe(1);
    expect(updateMany).not.toHaveBeenCalled();
    expect(raw.$transaction).not.toHaveBeenCalled();
  });

  it('--apply：写库，且 where 里夹了 totalCostCny: null（并发下不覆盖别人刚填的）', async () => {
    const { client, updateMany } = backfillClient([[flightRow('i1')]]);

    const result = await backfillItemCostSnapshots({ apply: true }, client);

    expect(result.dryRun).toBe(false);
    expect(result.filled).toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // 这条 where 是幂等的最后一道保险：漏了它，并发下会把别人刚算好的成本盖掉。
    expect(arg.where).toEqual({ id: 'i1', totalCostCny: null });
    expect(Number(String(arg.data.totalCostCny))).toBe(2160); // 每座 1080 × 2 人
    expect(Number(String(arg.data.unitCostCny))).toBe(1080);
  });

  it('候选集只包含 totalCostCny 为 NULL、未软删的机票/套餐行', async () => {
    const { client, findMany } = backfillClient([[]]);
    await backfillItemCostSnapshots({}, client);
    const where = (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      totalCostCny: null,
      kind: { in: ['FLIGHT', 'BUNDLE'] },
      order: { deletedAt: null },
    });
  });

  it('套餐行：按组件求和落库，且不写 unitCostCny（整包成本没有「每件」这个口径）', async () => {
    const { client, updateMany } = backfillClient([[bundleRow('b1')]]);

    const result = await backfillItemCostSnapshots({ apply: true }, client);

    expect(result.byKind.BUNDLE.filled).toBe(1);
    const arg = updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Number(String(arg.data.totalCostCny))).toBe(1600); // 4 晚 × 400 × 1 间
    expect(arg.data.unitCostCny).toBeUndefined();
  });

  it('算不出成本的行：留 NULL 并按原因记数，绝不写 0', async () => {
    const bare = { ...SCHEDULE, charterCostCny: null, airportTaxDepCny: null, fuelCostCny: null };
    const { client, updateMany } = backfillClient([[flightRow('i1')]], [bare]);

    const result = await backfillItemCostSnapshots({ apply: true }, client);

    expect(result.filled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(Object.values(result.skipReasons)[0]).toBe(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('机票行没有班次（航段已取消 / 老数据）：跳过并记数', async () => {
    const { client } = backfillClient([[flightRow('i1', null)]]);
    const result = await backfillItemCostSnapshots({}, client);
    expect(result.filled).toBe(0);
    expect(result.skipReasons['机票行没有班次（航段已取消 / 老数据）']).toBe(1);
  });

  it('套餐组件成本不全（酒店没录成本价）：跳过并记数', async () => {
    const { client } = backfillClient([[bundleRow('b1', { hotelRoomType: null })]]);
    const result = await backfillItemCostSnapshots({}, client);
    expect(result.filled).toBe(0);
    expect(result.skipReasons['套餐组件成本不全：住宿/签证/用车里有产品没录成本价']).toBe(1);
  });

  it('翻页带游标：算不出来的行留在候选集里，没有游标会原地打转', async () => {
    const { client, findMany } = backfillClient([[flightRow('i1')], [flightRow('i2')]]);

    await backfillItemCostSnapshots({}, client);

    expect(findMany).toHaveBeenCalledTimes(3); // 两批数据 + 一次空批收尾
    expect(findMany.mock.calls[0]![0]).not.toHaveProperty('cursor');
    expect(findMany.mock.calls[1]![0]).toMatchObject({ cursor: { id: 'i1' }, skip: 1 });
  });

  it('limit：只处理指定条数，并标记 truncated（还有候选行没扫到）', async () => {
    const { client, findMany } = backfillClient([[flightRow('i1')]]);

    const result = await backfillItemCostSnapshots({ limit: 1 }, client);

    expect(result.scanned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 1 });
  });

  it('重跑：第二次候选集已空（首次填过的行不再是 NULL）→ 零改动', async () => {
    const { client, updateMany } = backfillClient([[]]);
    const result = await backfillItemCostSnapshots({ apply: true }, client);
    expect(result.scanned).toBe(0);
    expect(result.filled).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
