/**
 * 权益核销台账校验口径单测（vitest，mock prisma）。
 *
 * 覆盖：
 *   - 核销不透支：tripsUsed ≤ 可用次数（已飞 tripCount − 已核销净值）
 *   - 可用次数被吃光 / 已为负（退单导致）时一律不放行
 *   - 冲正只能冲核销（tripsUsed > 0）、只能冲本档案的条目、只能冲一次
 *   - 冲正写入的是负数补偿流水，原条目一个字都不动（append-only）
 *   - 唯一约束在并发下兜底：P2002 转成「已冲正过」
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => {
  const mock = {
    travelerBenefitRedemption: {
      aggregate: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    // $transaction(fn) 直接以同一个 mock 作为 tx 执行回调（隔离级别参数在这里无意义）
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mock)),
  };
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { Prisma } from '@prisma/client';
import {
  TravelerBenefitsService,
  withBenefitTotals,
  type RedemptionActor,
} from './traveler-benefits.service.js';
import type { TravelerProfilesService } from './traveler-profiles.service.js';

const ACTOR: RedemptionActor = { userId: 'u1' };

function redemptionRow(over: { id: string } & Partial<Record<string, unknown>>) {
  return {
    profileId: 'p1',
    tripsUsed: 3,
    benefit: '航司权益兑换',
    note: null,
    reversalOfId: null,
    createdById: 'u1',
    createdByName: '票务小组',
    createdAt: new Date('2026-08-24T09:15:00.000Z'),
    ...over,
  };
}

/** 只桩出 benefits service 真正用到的两个方法：getDetail（实时重算取 tripCount）与 resolveMaster */
function fakeProfiles(over?: { tripCount?: number; masterId?: string }) {
  const id = over?.masterId ?? 'p1';
  return {
    getDetail: vi.fn(async () => ({
      profile: { id, fullName: 'ZHANG SAN', tripCount: over?.tripCount ?? 5 },
    })),
    resolveMaster: vi.fn(async () => ({ id, fullName: 'ZHANG SAN' })),
  } as unknown as TravelerProfilesService;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({ displayName: '票务小组', email: null });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock));
});

describe('核销：不得透支可用次数', () => {
  it('可用次数够时正常写入正数流水，并盖上操作人姓名快照', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(redemptionRow({ id: 'r1' }));

    const res = await svc.redeem('p1', { tripsUsed: 3, benefit: '航司权益兑换' }, ACTOR);

    expect(res.redemption.tripsUsed).toBe(3);
    expect(prismaMock.travelerBenefitRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profileId: 'p1',
          tripsUsed: 3,
          createdById: 'u1',
          createdByName: '票务小组',
        }),
      }),
    );
  });

  it('恰好用光可用次数（tripsUsed = 可用）放行', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 2 } });
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(redemptionRow({ id: 'r1' }));

    await expect(
      svc.redeem('p1', { tripsUsed: 3, benefit: '航司权益兑换' }, ACTOR),
    ).resolves.toBeDefined();
  });

  it('超出可用次数一次就拒绝，且不写任何流水', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 3 } });

    await expect(svc.redeem('p1', { tripsUsed: 3, benefit: '航司权益兑换' }, ACTOR)).rejects.toThrow(
      /可核销次数不足/,
    );
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('可用次数已被退单打成负数时，任何核销都拒绝', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 1 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 4 } });

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '航司权益兑换' }, ACTOR)).rejects.toThrow(
      /可核销次数不足/,
    );
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('可用次数按实时重算的 tripCount 算，不认快照旧值', async () => {
    const profiles = fakeProfiles({ tripCount: 2 });
    const svc = new TravelerBenefitsService(profiles);
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });

    await expect(svc.redeem('p1', { tripsUsed: 3, benefit: '航司权益兑换' }, ACTOR)).rejects.toThrow(
      /可核销次数不足/,
    );
    expect(profiles.getDetail).toHaveBeenCalledWith('p1');
  });

  it('传指针行 id 时流水挂到解析出的主档案上', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5, masterId: 'master-1' }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(
      redemptionRow({ id: 'r1', profileId: 'master-1' }),
    );

    const res = await svc.redeem('pointer-9', { tripsUsed: 1, benefit: '航司权益兑换' }, ACTOR);

    expect(res.profileId).toBe('master-1');
    expect(prismaMock.travelerBenefitRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ profileId: 'master-1' }) }),
    );
  });
});

describe('冲正：只增补偿流水，一条核销最多冲一次', () => {
  it('冲正写入负数流水并指回原条目，原条目不被改动', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles());
    prismaMock.travelerBenefitRedemption.findUnique
      .mockResolvedValueOnce(redemptionRow({ id: 'r1', tripsUsed: 3 })) // 原条目
      .mockResolvedValueOnce(null); // 尚未被冲正
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(
      redemptionRow({ id: 'r2', tripsUsed: -3, reversalOfId: 'r1', note: '录错，冲正' }),
    );

    const res = await svc.reverse('p1', 'r1', '录错，冲正', ACTOR);

    expect(res.reversal.tripsUsed).toBe(-3);
    expect(res.reversal.reversalOfId).toBe('r1');
    expect(res.original.tripsUsed).toBe(3);
    expect(prismaMock.travelerBenefitRedemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tripsUsed: -3, reversalOfId: 'r1', benefit: '航司权益兑换' }),
    });
  });

  it('已冲正过的核销不能再冲', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles());
    prismaMock.travelerBenefitRedemption.findUnique
      .mockResolvedValueOnce(redemptionRow({ id: 'r1', tripsUsed: 3 }))
      .mockResolvedValueOnce({ id: 'r2' }); // 已存在冲正条目

    await expect(svc.reverse('p1', 'r1', null, ACTOR)).rejects.toThrow(/已冲正过/);
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('冲正条目（负数）本身不能再被冲正', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles());
    prismaMock.travelerBenefitRedemption.findUnique.mockResolvedValueOnce(
      redemptionRow({ id: 'r2', tripsUsed: -3, reversalOfId: 'r1' }),
    );

    await expect(svc.reverse('p1', 'r2', null, ACTOR)).rejects.toThrow(/不能再被冲正/);
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('条目不属于该档案时按「不存在」拒绝', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles());
    prismaMock.travelerBenefitRedemption.findUnique.mockResolvedValueOnce(
      redemptionRow({ id: 'r1', profileId: 'other-profile' }),
    );

    await expect(svc.reverse('p1', 'r1', null, ACTOR)).rejects.toThrow(/核销记录不存在/);
  });

  it('条目根本不存在时拒绝', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles());
    prismaMock.travelerBenefitRedemption.findUnique.mockResolvedValueOnce(null);

    await expect(svc.reverse('p1', 'nope', null, ACTOR)).rejects.toThrow(/核销记录不存在/);
  });

  it('并发穿过预检时，唯一约束报错转成「已冲正过」', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles());
    prismaMock.travelerBenefitRedemption.findUnique
      .mockResolvedValueOnce(redemptionRow({ id: 'r1', tripsUsed: 3 }))
      .mockResolvedValueOnce(null);
    prismaMock.travelerBenefitRedemption.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(svc.reverse('p1', 'r1', null, ACTOR)).rejects.toThrow(/已冲正过/);
  });
});

describe('可用次数口径 withBenefitTotals', () => {
  it('availableTrips = tripCount − 已核销净值', () => {
    const out = withBenefitTotals({ id: 'p1', tripCount: 5 }, new Map([['p1', 3]]));
    expect(out).toMatchObject({ redeemedTrips: 3, availableTrips: 2 });
  });

  it('没有台账流水的档案按 0 核销处理', () => {
    const out = withBenefitTotals({ id: 'p1', tripCount: 5 }, new Map());
    expect(out).toMatchObject({ redeemedTrips: 0, availableTrips: 5 });
  });

  it('退单让已飞次数掉下来时 availableTrips 如实为负，不截断到 0', () => {
    const out = withBenefitTotals({ id: 'p1', tripCount: 1 }, new Map([['p1', 4]]));
    expect(out.availableTrips).toBe(-3);
  });

  it('冲正后净值回落，可用次数随之补回', () => {
    // 核销 3 + 冲正 -3 ⇒ groupBy sum = 0
    const out = withBenefitTotals({ id: 'p1', tripCount: 5 }, new Map([['p1', 0]]));
    expect(out).toMatchObject({ redeemedTrips: 0, availableTrips: 5 });
  });
});
