/**
 * 签证矛盾组合硬闸 · 写入路径单测（vitest，mock Prisma）
 *
 * 矛盾组合 = 订单级 visaStatus ∈ {NEEDED, E_VISA}（录单明说「这单要我方办签」）
 *          + 已录出行人**全部** visaExempt=true（人级说「没有一个人要我们办」）。
 * 后果：orderNeedsVisaTask 按乘客级判「不建任务」→ 签证台看不见这单 → 漏送签。
 * 录单页的软提示拦不住（提示上线后仍有新单落进来），因此服务端在写入路径上硬拒。
 *
 * 本文件覆盖建单（createOrder，批量创单逐单复用它）与换人（swapPassenger）两条路径；
 * 按人改自备签见 orders.visa-exempt-toggle.test.ts，办结回退见 fulfillment/visa-completion.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole, VisaRequirement } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    passenger: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { VISA_CONTRADICTION_MESSAGE } from './visa-need.js';
import { BadRequestError } from '../../lib/errors.js';

const service = new OrderService();
const STAFF = { userId: 'u-staff', role: UserRole.STAFF } as const;

/** 联系人两项都填 + 不带幂等键 → 建单在触库前就走到本闸，无需铺 Prisma。 */
const baseBody = (
  visaStatus: VisaRequirement | undefined,
  passengers: Array<{ visaExempt?: boolean }>,
) => ({
  contactName: '联系人',
  contactPhone: '13800000000',
  visaStatus,
  items: [{ kind: 'VISA' as const, visaId: 'v1', quantity: passengers.length }],
  passengers: passengers.map((p, i) => ({
    fullName: `PAX ${i + 1}`,
    documentType: 'PASSPORT' as const,
    documentNumber: `E${1000 + i}`,
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    passportExpiry: '2035-01-01',
    ...p,
  })),
});

/** createOrder 的 body 形状很宽，测试只关心签证三根轴，用 never 收口类型噪音。 */
const createOrder = (body: unknown) => service.createOrder(body as never, STAFF);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createOrder · 签证矛盾组合硬闸', () => {
  it('「需要签证」+ 全员自备签 → BadRequestError，一行库都不碰', async () => {
    await expect(
      createOrder(baseBody(VisaRequirement.NEEDED, [{ visaExempt: true }, { visaExempt: true }])),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('报错文案给出两条出路（改回随团办签 / 改签证状态）', async () => {
    await expect(
      createOrder(baseBody(VisaRequirement.NEEDED, [{ visaExempt: true }])),
    ).rejects.toThrow(VISA_CONTRADICTION_MESSAGE);
  });

  it('「电子签」+ 全员自备签 → 同样拦（电子签一样要送签）', async () => {
    await expect(
      createOrder(baseBody(VisaRequirement.E_VISA, [{ visaExempt: true }])),
    ).rejects.toThrow(/签证台看不到这单/);
  });

  it.each([
    ['混合名单（部分自备签）', VisaRequirement.NEEDED, [{ visaExempt: true }, { visaExempt: false }]],
    ['全员随团办签', VisaRequirement.NEEDED, [{ visaExempt: false }]],
    ['「不需要签证」+ 全员自备签', VisaRequirement.NOT_NEEDED, [{ visaExempt: true }]],
    ['「已签证」+ 全员自备签', VisaRequirement.HAS_VISA, [{ visaExempt: true }]],
    ['未标注签证状态 + 全员自备签', undefined, [{ visaExempt: true }]],
  ])('%s → 不被本闸拦（继续往下走）', async (_label, visaStatus, passengers) => {
    // 往下会因为 Prisma 未铺而失败，只断言「失败的不是本闸」。
    const err = await createOrder(baseBody(visaStatus, passengers)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error); // 确保确实往下走到了未铺 Prisma 的地方，而非静默通过
    expect((err as Error).message).not.toBe(VISA_CONTRADICTION_MESSAGE);
  });

  it('未录出行人 → 不拦（先建单、后补人是正常流程）', async () => {
    const body = { ...baseBody(VisaRequirement.NEEDED, []), items: [] };
    const err = await createOrder(body).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe(VISA_CONTRADICTION_MESSAGE);
  });
});

/** 换人通道：mock 到「订单已锁 + 目标乘客已读」，剩下的靠名单投影判定。 */
function mountSwap(opts: {
  visaStatus: VisaRequirement | null;
  passengerVisaExempt?: boolean;
  roster: Array<{ id: string; visaExempt: boolean }>;
}) {
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
  );
  mockPrisma.$queryRaw.mockResolvedValue([
    {
      id: 'o1',
      adjustmentCny: 0,
      adjustments: [],
      status: 'PAID',
      deletedAt: null,
      visaStatus: opts.visaStatus,
    },
  ]);
  mockPrisma.passenger.findUnique.mockResolvedValue({
    id: 'p1',
    orderId: 'o1',
    fullName: '旧客',
    documentNumber: 'E1000',
    visaExempt: opts.passengerVisaExempt ?? false,
    passengerType: 'ADULT',
  });
  mockPrisma.passenger.findMany.mockResolvedValue(opts.roster);
  mockPrisma.passenger.update.mockResolvedValue({});
}

describe('swapPassenger · 签证矛盾组合硬闸', () => {
  it('换人把最后一位随团办签的人也带成自备签 → BadRequestError，不写乘客', async () => {
    mountSwap({
      visaStatus: VisaRequirement.NEEDED,
      roster: [
        { id: 'p1', visaExempt: false },
        { id: 'p2', visaExempt: true },
      ],
    });
    await expect(
      service.swapPassenger('o1', 'p1', { fullName: '新客', visaExempt: true }, STAFF),
    ).rejects.toThrow(VISA_CONTRADICTION_MESSAGE);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('名单里还有别人随团办签 → 本闸放行', async () => {
    mountSwap({
      visaStatus: VisaRequirement.NEEDED,
      roster: [
        { id: 'p1', visaExempt: false },
        { id: 'p2', visaExempt: false },
      ],
    });
    const err = await service
      .swapPassenger('o1', 'p1', { fullName: '新客', visaExempt: true }, STAFF)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe(VISA_CONTRADICTION_MESSAGE);
  });

  it('订单级「不需要签证」→ 本闸不触发', async () => {
    mountSwap({
      visaStatus: VisaRequirement.NOT_NEEDED,
      roster: [{ id: 'p1', visaExempt: false }],
    });
    const err = await service
      .swapPassenger('o1', 'p1', { fullName: '新客', visaExempt: true }, STAFF)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe(VISA_CONTRADICTION_MESSAGE);
  });

  it('换人不带 visaExempt 且证件号变化（回落随团办签）→ 本闸不触发', async () => {
    mountSwap({
      visaStatus: VisaRequirement.NEEDED,
      passengerVisaExempt: true,
      roster: [{ id: 'p1', visaExempt: true }],
    });
    const err = await service
      .swapPassenger('o1', 'p1', { fullName: '新客', documentNumber: 'E9999' }, STAFF)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toBe(VISA_CONTRADICTION_MESSAGE);
  });
});
