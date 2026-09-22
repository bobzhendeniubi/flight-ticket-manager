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
    travelerProfile: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    // $transaction(fn) 直接以同一个 mock 作为 tx 执行回调（隔离级别参数在这里无意义）
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mock)),
  };
  return mock;
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { Prisma } from '@prisma/client';
import {
  computeAvailableTrips,
  serializeRedemption,
  TravelerBenefitsService,
  withBenefitTotals,
  type RedemptionActor,
} from './traveler-benefits.service.js';
import { BENEFIT_AUTO_REVERSAL_ACTOR_ID } from './traveler-benefits.auto-reverse.js';
import type { TravelerProfilesService } from './traveler-profiles.service.js';

const ACTOR: RedemptionActor = { userId: 'u1' };

function redemptionRow(over: { id: string } & Partial<Record<string, unknown>>) {
  return {
    profileId: 'p1',
    tripsUsed: 3,
    benefit: '航司权益兑换',
    note: null,
    reversalOfId: null,
    orderId: null,
    createdById: 'u1',
    createdByName: '票务小组',
    createdAt: new Date('2026-08-24T09:15:00.000Z'),
    ...over,
  };
}

/**
 * 只桩出 benefits service 真正用到的三个方法：getDetail（实时重算取 tripCount）、resolveMaster、
 * resolveDocPairs（挂单校验用的档案证件对）。
 */
function fakeProfiles(over?: { tripCount?: number; pendingPaidTripCount?: number; masterId?: string }) {
  const id = over?.masterId ?? 'p1';
  const tripCount = over?.tripCount ?? 5;
  const pendingPaidTripCount = over?.pendingPaidTripCount ?? 0;
  // 真实流程里 getDetail 会把重算后的 tripCount / pendingPaidTripCount 回写快照列，事务内重读读到的
  // 就是同一个值，这里同步桩出 travelerProfile.findUnique 保持两处一致。
  prismaMock.travelerProfile.findUnique.mockResolvedValue({ tripCount, pendingPaidTripCount });
  return {
    getDetail: vi.fn(async () => ({
      profile: { id, fullName: 'ZHANG SAN', tripCount, pendingPaidTripCount },
    })),
    resolveMaster: vi.fn(async () => ({ id, fullName: 'ZHANG SAN' })),
    resolveDocPairs: vi.fn(async () => [
      { documentType: 'PASSPORT', documentNumber: 'E12345678' },
      { documentType: 'PASSPORT', documentNumber: 'OLD-E999' }, // 合并前的旧证
    ]),
  } as unknown as TravelerProfilesService;
}

/** 挂单校验用的订单行（默认：已支付、未删、乘客证件命中档案主证）。 */
function orderRow(over: Partial<{
  status: string;
  deletedAt: Date | null;
  passengers: Array<{ documentType: string; documentNumber: string }>;
}> = {}) {
  return {
    id: 'o1',
    orderNumber: 'FTM2026092100001',
    status: over.status ?? 'PAID',
    deletedAt: over.deletedAt ?? null,
    passengers: over.passengers ?? [{ documentType: 'PASSPORT', documentNumber: ' e12345678 ' }],
  };
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

  it('可用次数判定用事务内重读的 tripCount，不用事务外的旧快照', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    // 模拟快照漂移：事务开始时 tripCount 已从 5 掉到 2（如退单触发重算）
    prismaMock.travelerProfile.findUnique.mockResolvedValue({ tripCount: 2 });
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });

    await expect(svc.redeem('p1', { tripsUsed: 3, benefit: '航司权益兑换' }, ACTOR)).rejects.toThrow(
      /可核销次数不足/,
    );
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('档案在事务开始前被删除 → 404 而非 TypeError', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.travelerProfile.findUnique.mockResolvedValue(null);

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '航司权益兑换' }, ACTOR)).rejects.toThrow(
      /常旅客档案不存在/,
    );
  });
});

describe('核销：并发序列化冲突（P2034）的处理', () => {
  function p2034() {
    return new Prisma.PrismaClientKnownRequestError('serialization conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
  }

  it('首次 P2034 自动重试一次，重试成功则对调用方透明', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(redemptionRow({ id: 'r1' }));
    prismaMock.$transaction
      .mockRejectedValueOnce(p2034())
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn(prismaMock));

    const res = await svc.redeem('p1', { tripsUsed: 1, benefit: '航司权益兑换' }, ACTOR);

    expect(res.redemption.id).toBe('r1');
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  it('重试仍 P2034 → 409 友好提示，不再是裸 500', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.$transaction.mockRejectedValue(p2034());

    await expect(
      svc.redeem('p1', { tripsUsed: 1, benefit: '航司权益兑换' }, ACTOR),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('正在同时核销'),
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });

  it('非 P2034 的异常原样上抛，不吞错也不重试', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.$transaction.mockRejectedValue(new Error('db down'));

    await expect(
      svc.redeem('p1', { tripsUsed: 1, benefit: '航司权益兑换' }, ACTOR),
    ).rejects.toThrow('db down');
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
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

describe('可用次数口径 computeAvailableTrips（2026-09-21：已飞 + 已付款在订未飞 − 已核销）', () => {
  it('已飞 4 + 已付款在订未飞 1 − 已核销 0 = 5：第五次进单当场就能核销 5 次', () => {
    expect(computeAvailableTrips({ tripCount: 4, pendingPaidTripCount: 1, redeemedTrips: 0 })).toBe(5);
  });

  it('待支付的在订单不计：pendingPaidTripCount 只收已付款那部分（调用方按聚合口径传入 0）', () => {
    expect(computeAvailableTrips({ tripCount: 4, pendingPaidTripCount: 0, redeemedTrips: 0 })).toBe(4);
  });

  it('可为负，不截断', () => {
    expect(computeAvailableTrips({ tripCount: 1, pendingPaidTripCount: 0, redeemedTrips: 4 })).toBe(-3);
  });
});

describe('可用次数口径 withBenefitTotals', () => {
  it('availableTrips = tripCount + pendingPaidTripCount − 已核销净值', () => {
    const out = withBenefitTotals(
      { id: 'p1', tripCount: 5, pendingPaidTripCount: 1 },
      new Map([['p1', 3]]),
    );
    expect(out).toMatchObject({ redeemedTrips: 3, availableTrips: 3 });
  });

  it('没有台账流水的档案按 0 核销处理', () => {
    const out = withBenefitTotals({ id: 'p1', tripCount: 5, pendingPaidTripCount: 0 }, new Map());
    expect(out).toMatchObject({ redeemedTrips: 0, availableTrips: 5 });
  });

  it('退单让已飞次数掉下来时 availableTrips 如实为负，不截断到 0', () => {
    const out = withBenefitTotals(
      { id: 'p1', tripCount: 1, pendingPaidTripCount: 0 },
      new Map([['p1', 4]]),
    );
    expect(out.availableTrips).toBe(-3);
  });

  it('冲正后净值回落，可用次数随之补回', () => {
    // 核销 3 + 冲正 -3 ⇒ groupBy sum = 0
    const out = withBenefitTotals(
      { id: 'p1', tripCount: 5, pendingPaidTripCount: 0 },
      new Map([['p1', 0]]),
    );
    expect(out).toMatchObject({ redeemedTrips: 0, availableTrips: 5 });
  });
});

describe('核销闸按新口径放行：已飞 + 已付款在订未飞', () => {
  it('已飞 4 + 已付款在订未飞 1，核销 5 次放行（旧口径会 400）', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 4, pendingPaidTripCount: 1 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(redemptionRow({ id: 'r1', tripsUsed: 5 }));

    await expect(
      svc.redeem('p1', { tripsUsed: 5, benefit: '飞满 5 次兑换升舱' }, ACTOR),
    ).resolves.toBeDefined();
  });

  it('已飞 4 + 已付款在订未飞 0（在订的是待支付单），核销 5 次仍拒', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 4, pendingPaidTripCount: 0 }));
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });

    await expect(
      svc.redeem('p1', { tripsUsed: 5, benefit: '飞满 5 次兑换升舱' }, ACTOR),
    ).rejects.toThrow(/已付款在订未飞 0 次/);
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });
});

describe('核销挂订单号（orderId）', () => {
  beforeEach(() => {
    prismaMock.travelerBenefitRedemption.aggregate.mockResolvedValue({ _sum: { tripsUsed: 0 } });
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(
      redemptionRow({ id: 'r1', orderId: 'o1', order: { orderNumber: 'FTM2026092100001' } }),
    );
  });

  it('订单存在、未删、已付款、乘客证件命中档案（大小写/空格归一）→ 落 orderId，响应带回单号', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.order.findUnique.mockResolvedValue(orderRow());

    const res = await svc.redeem('p1', { tripsUsed: 1, benefit: '升舱', orderId: ' o1 ' }, ACTOR);

    expect(prismaMock.travelerBenefitRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'o1' }) }),
    );
    expect(res.redemption).toMatchObject({ orderId: 'o1', orderNumber: 'FTM2026092100001', auto: false });
  });

  it('合并前的旧证出现在单上也算命中', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.order.findUnique.mockResolvedValue(
      orderRow({ passengers: [{ documentType: 'PASSPORT', documentNumber: 'old-e999' }] }),
    );

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '升舱', orderId: 'o1' }, ACTOR)).resolves.toBeDefined();
  });

  it('订单不存在 → 400 REDEMPTION_ORDER_MISMATCH，不写流水', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.order.findUnique.mockResolvedValue(null);

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '升舱', orderId: 'nope' }, ACTOR)).rejects.toMatchObject({
      code: 'REDEMPTION_ORDER_MISMATCH',
      statusCode: 400,
      message: expect.stringContaining('找不到这张订单'),
    });
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('订单在回收站（软删）→ 400 REDEMPTION_ORDER_MISMATCH', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.order.findUnique.mockResolvedValue(orderRow({ deletedAt: new Date() }));

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '升舱', orderId: 'o1' }, ACTOR)).rejects.toMatchObject({
      code: 'REDEMPTION_ORDER_MISMATCH',
      message: expect.stringContaining('回收站'),
    });
  });

  it('订单待支付（未付款族）→ 400 REDEMPTION_ORDER_MISMATCH', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.order.findUnique.mockResolvedValue(orderRow({ status: 'PENDING_PAYMENT' }));

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '升舱', orderId: 'o1' }, ACTOR)).rejects.toMatchObject({
      code: 'REDEMPTION_ORDER_MISMATCH',
      message: expect.stringContaining('不是已付款'),
    });
  });

  it('单上乘客证件与档案不匹配 → 400 REDEMPTION_ORDER_MISMATCH', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.order.findUnique.mockResolvedValue(
      orderRow({ passengers: [{ documentType: 'PASSPORT', documentNumber: 'SOMEONE-ELSE' }] }),
    );

    await expect(svc.redeem('p1', { tripsUsed: 1, benefit: '升舱', orderId: 'o1' }, ACTOR)).rejects.toMatchObject({
      code: 'REDEMPTION_ORDER_MISMATCH',
      message: expect.stringContaining('没有本档案的证件号'),
    });
    expect(prismaMock.travelerBenefitRedemption.create).not.toHaveBeenCalled();
  });

  it('不挂单号时不查订单', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    await svc.redeem('p1', { tripsUsed: 1, benefit: '升舱' }, ACTOR);
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled();
  });

  it('冲正照抄原行的 orderId', async () => {
    const svc = new TravelerBenefitsService(fakeProfiles({ tripCount: 5 }));
    prismaMock.travelerBenefitRedemption.findUnique
      .mockResolvedValueOnce(redemptionRow({ id: 'r1', orderId: 'o1' }))
      .mockResolvedValueOnce(null);
    prismaMock.travelerBenefitRedemption.create.mockResolvedValue(
      redemptionRow({ id: 'r2', tripsUsed: -3, reversalOfId: 'r1', orderId: 'o1' }),
    );

    await svc.reverse('p1', 'r1', null, ACTOR);

    expect(prismaMock.travelerBenefitRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reversalOfId: 'r1', orderId: 'o1' }) }),
    );
  });
});

describe('serializeRedemption 契约字段', () => {
  it('带 orderId / orderNumber（联查）/ auto（系统自动冲正行）', () => {
    const auto = serializeRedemption(
      redemptionRow({
        id: 'rev-1',
        tripsUsed: -5,
        reversalOfId: 'r1',
        orderId: 'o1',
        order: { orderNumber: 'FTM2026092100001' },
        createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
        createdByName: '系统自动',
      }) as never,
    );
    expect(auto).toMatchObject({ orderId: 'o1', orderNumber: 'FTM2026092100001', auto: true });
    const manual = serializeRedemption(redemptionRow({ id: 'r1' }) as never);
    expect(manual).toMatchObject({ orderId: null, orderNumber: null, auto: false });
  });
});
