/**
 * 旅客档案老系统飞行次数单测：
 *   - LegacyTicket 过滤条件集中在一次批量 findMany，并对新系统已飞日期活体去重；
 *   - 主证件与合并别名证件号按 norm 归拢且不重复计数；
 *   - 详情实时重算回写时，老系统次数仍并入 tripCount；无有效订单的保留档案也刷新次数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CabinClass, DocumentType, OrderItemKind, OrderStatus, Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  legacyTicket: { findMany: vi.fn() },
  travelerProfile: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  passenger: { findFirst: vi.fn() },
  order: { findMany: vi.fn() },
  savedPassenger: { findMany: vi.fn() },
  travelerBenefitRedemption: { groupBy: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import {
  addLegacyTripCount,
  loadLegacyTripCounts,
  parseTravelerSearchTerms,
  REBUILD_RETRY_BACKOFF_MS,
  resetRebuildStateForTests,
  SNAPSHOT_STALE_MS,
  sumLegacyTripCounts,
  TravelerProfilesService,
} from './traveler-profiles.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.legacyTicket.findMany.mockResolvedValue([]);
  prismaMock.savedPassenger.findMany.mockResolvedValue([]);
  prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValue([]);
  prismaMock.travelerBenefitRedemption.findMany.mockResolvedValue([]);
  // list() 用数组形式的 $transaction（不是回调形式）：原样把每个 promise 跑完再收集结果。
  prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('loadLegacyTripCounts', () => {
  it('一次批量查询并应用删除、重录、退票和未来日期过滤，保留 stateRaw=NULL', async () => {
    const today = new Date('2026-08-31T12:00:00.000Z');
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: null },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-20T00:00:00.000Z') },
      { documentNumberNorm: 'OLD456', outboundDate: new Date('2026-08-25T00:00:00.000Z') },
    ]);

    const counts = await loadLegacyTripCounts(
      [{ key: 'profile-1', documentNumbers: [' e123 ', 'OLD456', 'E123'], flownBusinessDates: [] }],
      today,
      { legacyTicket: prismaMock.legacyTicket } as never,
    );

    expect(counts).toEqual(
      new Map([
        ['profile-1', 3],
      ]),
    );
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledWith({
      where: {
        documentNumberNorm: { in: ['E123', 'OLD456'] },
        isDeleted: false,
        supersededByOrderId: null,
        OR: [{ stateRaw: null }, { stateRaw: { not: 2 } }],
        AND: [{ OR: [{ outboundDate: null }, { outboundDate: { lte: today } }] }],
      },
      select: { documentNumberNorm: true, outboundDate: true },
    });
  });

  it('同日及前后一天重录票不双算，不同日期的真实行程仍计入', async () => {
    const today = new Date('2026-09-30T12:00:00.000Z');
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-30T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-31T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-01T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-02T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: null },
    ]);

    const counts = await loadLegacyTripCounts(
      [{ key: 'profile-1', documentNumbers: ['E123'], flownBusinessDates: ['2026-08-31'] }],
      today,
      { legacyTicket: prismaMock.legacyTicket } as never,
    );

    expect(counts.get('profile-1')).toBe(2);
  });

  it('不同日期各有新系统行程时只分别去重对应日期，不误杀真实次数', async () => {
    const today = new Date('2026-09-30T12:00:00.000Z');
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-31T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-10T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-20T00:00:00.000Z') },
    ]);

    const counts = await loadLegacyTripCounts(
      [{
        key: 'profile-1',
        documentNumbers: ['E123'],
        flownBusinessDates: ['2026-08-31', '2026-09-10'],
      }],
      today,
      { legacyTicket: prismaMock.legacyTicket } as never,
    );

    expect(counts.get('profile-1')).toBe(1);
  });

  it('没有可匹配的 norm 时不查库并返回空 Map', async () => {
    const counts = await loadLegacyTripCounts([{
      key: 'profile-1',
      documentNumbers: ['  ', ''],
      flownBusinessDates: [],
    }], new Date(), {
      legacyTicket: prismaMock.legacyTicket,
    } as never);

    expect(counts).toEqual(new Map());
    expect(prismaMock.legacyTicket.findMany).not.toHaveBeenCalled();
  });

  it('有匹配证件但没有老系统记录时返回零，不制造次数', async () => {
    const counts = await loadLegacyTripCounts([{
      key: 'profile-1',
      documentNumbers: ['E123'],
      flownBusinessDates: [],
    }], new Date(), {
      legacyTicket: prismaMock.legacyTicket,
    } as never);

    expect(counts).toEqual(new Map([['profile-1', 0]]));
  });
});

describe('老系统次数归拢 helper', () => {
  it('主证件与合并别名按 norm 相加，同一证件不会重复计数', () => {
    const counts = new Map([
      ['E123', 3],
      ['OLD456', 4],
    ]);
    const legacyTripCount = sumLegacyTripCounts([' e123 ', 'old456', 'E123'], counts);

    expect(legacyTripCount).toBe(7);
    expect(addLegacyTripCount({ tripCount: 5 }, legacyTripCount)).toBe(12);
    expect(addLegacyTripCount({ tripCount: 5 }, 0)).toBe(5);
  });
});

function profileRow() {
  return {
    id: 'profile-1',
    travelerNo: 1,
    documentType: DocumentType.PASSPORT,
    documentNumber: 'E123',
    fullName: 'ZHANG SAN',
    chineseName: null,
    gender: null,
    dateOfBirth: null,
    nationality: 'CN',
    passportExpiry: null,
    tripCount: 1,
    legacyTripCount: 0,
    pendingTripCount: 0,
    orderCount: 1,
    firstTripAt: null,
    lastTripAt: null,
    nextTripAt: null,
    totalSpendCny: new Prisma.Decimal('100.00'),
    prefCabin: null,
    prefBed: null,
    prefMeal: null,
    prefSingleRoom: false,
    needsWheelchair: false,
    hotelHistory: [],
    companions: [],
    linkedUserId: null,
    notes: null,
    mergedIntoId: null,
    refreshedAt: new Date('2026-08-30T00:00:00.000Z'),
  };
}

describe('TravelerProfilesService.getDetail', () => {
  it('详情实时重算回写后仍保留老系统次数，并按 UTC+8 去程业务日活体去重', async () => {
    const row = profileRow();
    // UTC 8/30 16:30 属于 UTC+8 业务日 8/31；老系统 8/29 与其相差 2 天，不应误杀。
    const departedAt = new Date('2026-08-30T16:30:00.000Z');
    prismaMock.travelerProfile.findUnique.mockResolvedValue(row);
    prismaMock.travelerProfile.findMany.mockResolvedValue([
      {
        id: row.id,
        travelerNo: row.travelerNo,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        mergedIntoId: null,
      },
    ]);
    prismaMock.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        orderNumber: 'ORDER-1',
        status: OrderStatus.COMPLETED,
        createdAt: departedAt,
        paidAmount: new Prisma.Decimal('100.00'),
        passengers: [
          {
            fullName: 'ZHANG SAN',
            chineseName: null,
            gender: null,
            documentType: DocumentType.PASSPORT,
            documentNumber: 'E123',
            dateOfBirth: null,
            nationality: 'CN',
            passportExpiry: null,
            mealPreference: null,
            bedPref: null,
            needsWheelchair: false,
            singleRoom: false,
            visaExempt: false,
            upgradeRedeemLeg: 'NONE',
          },
        ],
        items: [
          {
            kind: OrderItemKind.FLIGHT,
            bundle: null,
            flightCabin: CabinClass.ECONOMY,
            randomStarTier: null,
            hotelCheckIn: null,
            hotelCheckOut: null,
            flightSchedule: {
              departureTime: departedAt,
              flight: { flightNumber: 'FTM1', originCode: 'MFM', destinationCode: 'DAD' },
            },
            hotelRoomType: null,
            fulfillmentTasks: [],
          },
        ],
      },
    ]);
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-29T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2020-01-01T00:00:00.000Z') },
    ]);
    prismaMock.travelerProfile.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
    }));

    const result = await new TravelerProfilesService().getDetail(row.id);

    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.travelerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: expect.objectContaining({ tripCount: 3, legacyTripCount: 2 }),
      }),
    );
    expect(result.profile).toMatchObject({ tripCount: 3, legacyTripCount: 2 });
  });

  it('订单全部失效时仍刷新老系统次数，并保留快照中的新系统部分', async () => {
    const row = { ...profileRow(), tripCount: 7, legacyTripCount: 4 };
    prismaMock.travelerProfile.findUnique.mockResolvedValue(row);
    prismaMock.travelerProfile.findMany.mockResolvedValue([{
      id: row.id,
      travelerNo: row.travelerNo,
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      mergedIntoId: null,
    }]);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: null },
      { documentNumberNorm: 'E123', outboundDate: new Date('2020-01-01T00:00:00.000Z') },
    ]);
    prismaMock.travelerProfile.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
    }));

    const result = await new TravelerProfilesService().getDetail(row.id);

    expect(prismaMock.travelerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: expect.objectContaining({ tripCount: 5, legacyTripCount: 2 }),
      }),
    );
    expect(result.profile).toMatchObject({ tripCount: 5, legacyTripCount: 2 });
  });
});

describe('TravelerProfilesService.rebuildAll', () => {
  it('有权益台账但没有新系统聚合的主档案仍刷新老系统次数', async () => {
    const row = { ...profileRow(), tripCount: 7, legacyTripCount: 4 };
    prismaMock.travelerProfile.findMany
      .mockResolvedValueOnce([{
        id: row.id,
        travelerNo: row.travelerNo,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        mergedIntoId: null,
      }])
      .mockResolvedValueOnce([{ id: row.id, tripCount: row.tripCount, legacyTripCount: row.legacyTripCount }]);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.savedPassenger.findMany.mockResolvedValue([]);
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: null },
      { documentNumberNorm: 'E123', outboundDate: new Date('2020-01-01T00:00:00.000Z') },
    ]);
    prismaMock.travelerProfile.update.mockResolvedValue({});
    prismaMock.travelerProfile.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValue([]);

    // deleteMany 的 redemptions:none 条件会保护有权益台账的主档案；findMany 第二次模拟该保留行。
    const result = await new TravelerProfilesService().rebuildAll();

    expect(result).toEqual({ built: 0, removed: 0 });
    expect(prismaMock.travelerProfile.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ tripCount: 5, legacyTripCount: 2, refreshedAt: expect.any(Date) }),
    });
  });
});

describe('TravelerProfilesService.ensureFresh（列表入口）', () => {
  const baseQuery = { sort: 'lastTripAt' as const, order: 'desc' as const, page: 1, pageSize: 100 };
  const NOW = new Date('2026-09-21T03:00:00.000Z').getTime();

  beforeEach(() => {
    resetRebuildStateForTests();
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    prismaMock.travelerProfile.findMany.mockResolvedValue([]);
    prismaMock.travelerProfile.count.mockResolvedValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetRebuildStateForTests();
  });

  function staleAggregate() {
    prismaMock.travelerProfile.aggregate.mockResolvedValue({
      _count: { _all: 5 },
      _sum: { tripCount: 50 },
      _min: { refreshedAt: new Date(NOW - SNAPSHOT_STALE_MS - 60_000) },
      _max: { refreshedAt: new Date(NOW) },
    });
  }

  /** 后台重建走 void + catch：让被拒绝的 promise 的 catch 回调跑完再断言。 */
  async function flushRejections() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('过期判定只看 canonical 行：aggregate 带 where mergedIntoId: null 与 _min(refreshedAt)', async () => {
    prismaMock.travelerProfile.aggregate.mockResolvedValue({
      _count: { _all: 5 },
      _sum: { tripCount: 50 },
      _min: { refreshedAt: new Date(NOW) },
      _max: { refreshedAt: new Date(NOW) },
    });

    await new TravelerProfilesService().list({ ...baseQuery });

    expect(prismaMock.travelerProfile.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { mergedIntoId: null }, _min: { refreshedAt: true } }),
    );
  });

  /** 让真正的 rebuildAll（并发去重 + 成功解除退避）跑，只替换底下的全量重建。 */
  function spyDoRebuild() {
    return vi.spyOn(
      TravelerProfilesService.prototype as unknown as { doRebuildAll: () => Promise<unknown> },
      'doRebuildAll',
    );
  }

  it('后台重建失败 → 写 error 日志，退避期内再访问不重试；退避期过后再试', async () => {
    staleAggregate();
    const rebuild = spyDoRebuild().mockRejectedValue(new Error('upsert 撞唯一约束'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await new TravelerProfilesService().list({ ...baseQuery });
    await flushRejections();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('重建失败');

    // 退避期内（快照仍过期）：不再触发
    vi.setSystemTime(NOW + REBUILD_RETRY_BACKOFF_MS - 1000);
    await new TravelerProfilesService().list({ ...baseQuery });
    await flushRejections();
    expect(rebuild).toHaveBeenCalledTimes(1);

    // 退避期过后：再试一次
    vi.setSystemTime(NOW + REBUILD_RETRY_BACKOFF_MS + 1000);
    await new TravelerProfilesService().list({ ...baseQuery });
    await flushRejections();
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('退避期内别的路径（导出同步重建）成功一次 → 解除退避，列表下次过期访问照常触发', async () => {
    staleAggregate();
    const rebuild = spyDoRebuild()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ built: 1, removed: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await new TravelerProfilesService().list({ ...baseQuery });
    await flushRejections();
    expect(rebuild).toHaveBeenCalledTimes(1);

    // 退避期内导出路径直接调 rebuildAll（不吃退避）并成功
    vi.setSystemTime(NOW + 1000);
    await expect(new TravelerProfilesService().rebuildAll()).resolves.toEqual({ built: 1, removed: 0 });
    expect(rebuild).toHaveBeenCalledTimes(2);

    // 仍在原退避窗口内：因上一次成功已解除退避，列表访问照常触发
    vi.setSystemTime(NOW + 2000);
    await new TravelerProfilesService().list({ ...baseQuery });
    await flushRejections();
    expect(rebuild).toHaveBeenCalledTimes(3);
  });

  it('并发去重是模块级的：不同 service 实例（路由单例 vs 导出每次 new）共享同一次全量重建', async () => {
    let finish!: (v: { built: number; removed: number }) => void;
    const pending = new Promise<{ built: number; removed: number }>((r) => (finish = r));
    const rebuild = spyDoRebuild().mockReturnValue(pending);

    const fromRoute = new TravelerProfilesService().rebuildAll();
    const fromExport = new TravelerProfilesService().rebuildAll();
    expect(rebuild).toHaveBeenCalledTimes(1);

    finish({ built: 3, removed: 0 });
    await expect(fromRoute).resolves.toEqual({ built: 3, removed: 0 });
    await expect(fromExport).resolves.toEqual({ built: 3, removed: 0 });
    // 跑完后再来一次 → 新的一轮
    await new TravelerProfilesService().rebuildAll();
    expect(rebuild).toHaveBeenCalledTimes(2);
  });
});

describe('parseTravelerSearchTerms', () => {
  it('按换行/逗号/顿号/分号/空格切分并过滤空 term', () => {
    const raw = '张三, 李四\n王五、赵六；E1234  钱七';
    expect(parseTravelerSearchTerms(raw)).toEqual(['张三', '李四', '王五', '赵六', 'E1234', '钱七']);
  });

  it('单个词没有分隔符时返回它自身这一个 term', () => {
    expect(parseTravelerSearchTerms('张三')).toEqual(['张三']);
  });

  it('全是分隔符/空白时返回空数组', () => {
    expect(parseTravelerSearchTerms('  , 、;\n')).toEqual([]);
  });
});

describe('TravelerProfilesService.list 多人搜索', () => {
  const baseQuery = { sort: 'lastTripAt' as const, order: 'desc' as const, page: 1, pageSize: 100 };

  beforeEach(() => {
    prismaMock.travelerProfile.aggregate.mockResolvedValue({
      _count: { _all: 5 },
      _sum: { tripCount: 50 },
      _min: { refreshedAt: new Date() },
      _max: { refreshedAt: new Date() },
    });
    prismaMock.travelerProfile.findMany.mockResolvedValue([]);
  });

  it('单 term 时 where.OR 与改造前一致（姓名/中文名/证件号三个 contains）', async () => {
    prismaMock.travelerProfile.count.mockResolvedValue(0);

    await new TravelerProfilesService().list({ ...baseQuery, search: '张三' });

    expect(prismaMock.travelerProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { fullName: { contains: '张三', mode: 'insensitive' } },
            { chineseName: { contains: '张三', mode: 'insensitive' } },
            { documentNumber: { contains: '张三', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('多 term 时展开成整体 OR（每个 term 各三个字段）', async () => {
    prismaMock.travelerProfile.count.mockResolvedValue(0);

    await new TravelerProfilesService().list({ ...baseQuery, search: '张三,李四' });

    expect(prismaMock.travelerProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { fullName: { contains: '张三', mode: 'insensitive' } },
            { chineseName: { contains: '张三', mode: 'insensitive' } },
            { documentNumber: { contains: '张三', mode: 'insensitive' } },
            { fullName: { contains: '李四', mode: 'insensitive' } },
            { chineseName: { contains: '李四', mode: 'insensitive' } },
            { documentNumber: { contains: '李四', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('返回 unmatchedTerms：一个都没命中的 term 会被列出来，命中的不会', async () => {
    prismaMock.travelerProfile.count.mockImplementation(
      async ({ where }: { where?: { OR?: Array<{ fullName?: { contains?: string } }> } }) => {
        const or = where?.OR ?? [];
        // 只有「按 term 单独 count」的调用带精确 3 项 OR；命中判定按 term 内容分支。
        if (or.length === 3) {
          const term = or[0]?.fullName?.contains;
          return term === '张三' ? 1 : 0;
        }
        return 1; // 分页 total（整体 OR）不影响本测试断言
      },
    );

    const result = await new TravelerProfilesService().list({ ...baseQuery, search: '张三,李四,  ,王五' });

    expect(result.unmatchedTerms).toEqual(['李四', '王五']);
  });

  it('空 term（多余分隔符/空白）不进入搜索条件，也不出现在 unmatchedTerms', async () => {
    prismaMock.travelerProfile.count.mockResolvedValue(0);

    const result = await new TravelerProfilesService().list({ ...baseQuery, search: '  张三 ,, 、 ' });

    expect(result.unmatchedTerms).toEqual(['张三']);
    const call = prismaMock.travelerProfile.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } };
    expect(call.where.OR).toHaveLength(3);
  });

  it('没有搜索条件时不加 OR，也不产生 unmatchedTerms 相关的额外 count 调用', async () => {
    const result = await new TravelerProfilesService().list({ ...baseQuery });

    const call = prismaMock.travelerProfile.findMany.mock.calls[0][0] as { where: { OR?: unknown[] } };
    expect(call.where.OR).toBeUndefined();
    expect(result.unmatchedTerms).toEqual([]);
    expect(prismaMock.travelerProfile.count).toHaveBeenCalledTimes(1); // 只有分页 total 这一次
  });
});
