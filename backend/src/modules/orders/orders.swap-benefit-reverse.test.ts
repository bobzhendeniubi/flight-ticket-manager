/**
 * 原地换人 → 被换下者权益核销自动冲正 + 档案刷新 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 只钉 swapPassenger 在**什么时候、拿什么**去调两处既有入口（台账写法本身见
 * traveler-benefits.auto-reverse.test.ts，真库行为见 orders.benefit-auto-reverse.integration.test.ts）：
 *   1. 真换人（证件号变化）→ 事务内按换人前读到的旧证件调自动冲正，reason 为「原地换人自动冲正」，
 *      待办提单人 = 经办人；事务外用旧 / 新两个证件刷新档案（lookupByDocuments → getDetail）；
 *      审计 after 带 benefitReversals 与 profilesRefreshed。
 *   2. 只改拼写（证件号没变）→ 两处都不调，审计 after 没有这两个键。
 *   3. 档案刷新失败不拖垮换人：换人照常返回，审计 profilesRefreshed=false。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole, type Prisma } from '@prisma/client';

const { mockPrisma, mockAutoReverse, mockLookup, mockGetDetail } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    passenger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    commissionRecord: { findMany: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn() },
    systemSetting: { findUnique: vi.fn() },
    // 档案刷新的取数守卫只认这个 delegate 存在；真正的刷新走被 mock 掉的 TravelerProfilesService。
    travelerProfile: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  mockAutoReverse: vi.fn(),
  mockLookup: vi.fn(),
  mockGetDetail: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../travelers/traveler-benefits.auto-reverse.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../travelers/traveler-benefits.auto-reverse.js')>()),
  autoReverseRedemptionsForSwappedOutPassengerWithinTx: mockAutoReverse,
}));
vi.mock('../travelers/traveler-profiles.service.js', () => ({
  TravelerProfilesService: class {
    lookupByDocuments = mockLookup;
    getDetail = mockGetDetail;
  },
}));

import { OrderService } from './orders.service.js';
import { BENEFIT_SWAP_REVERSAL_REASON } from '../travelers/traveler-benefits.auto-reverse.js';

const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const dec = (n: number) => ({ toString: () => String(n) }) as unknown as Prisma.Decimal;

const fakeFullOrder = () => ({
  id: 'ord1',
  orderNumber: 'FTM2026093000001',
  userId: 'u1',
  agentId: null,
  status: 'PAID',
  subtotal: dec(1000),
  taxesAndFees: dec(0),
  discountTotal: dec(0),
  total: dec(1000),
  paidAmount: dec(1000),
  prepaymentOffset: dec(0),
  currency: 'CNY',
  contactName: 'X',
  contactPhone: 'Y',
  contactEmail: null,
  paymentExpiresAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [],
  passengers: [],
  payments: [],
  refunds: [],
  statusEvents: [],
  agent: null,
  user: { id: 'u1', displayName: null, email: null },
});

/** 纯酒店单（没有按人出行行 → 不强制护照有效期、不查同班次重复、不走结算价重算）。 */
function mountSwap() {
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.$queryRaw.mockResolvedValue([
    {
      id: 'ord1',
      orderNumber: 'FTM2026093000001',
      adjustmentCny: 0,
      adjustments: null,
      status: 'PAID',
      deletedAt: null,
      visaStatus: null,
      outboundInvoiced: false,
      returnInvoiced: false,
      systemInvoiced: false,
      settlementLocked: false,
    },
  ]);
  // 快照 / 取价共用这一条读：没有明细行 → 重算按「非日历成交」跳过。
  mockPrisma.order.findUnique.mockResolvedValue({
    agentId: null,
    total: dec(1000),
    adjustmentCny: 0,
    adjustments: null,
    settlementLocked: false,
    status: 'PAID',
    deletedAt: null,
    passengers: [{ id: 'pax-1' }],
    _count: { splitsIn: 0, splitsOut: 0 },
    items: [],
  });
  mockPrisma.passenger.findUnique.mockResolvedValue({
    id: 'pax-1',
    orderId: 'ord1',
    fullName: 'OLD/PERSON',
    documentType: 'PASSPORT',
    documentNumber: 'OLD111',
    visaExempt: false,
    passengerType: 'ADULT',
    pnr: null,
    eticketNumber: null,
    chineseName: null,
    dateOfBirth: null,
    passportExpiry: null,
    formerIdentities: null,
  });
  mockPrisma.passenger.findFirst.mockResolvedValue(null);
  mockPrisma.passenger.findMany.mockResolvedValue([]);
  mockPrisma.passenger.update.mockResolvedValue({});
  mockPrisma.passenger.findUniqueOrThrow.mockResolvedValue({
    fullName: 'NEW/PERSON',
    documentNumber: 'NEW999',
  });
  mockPrisma.orderItem.count.mockResolvedValue(0);
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  mockPrisma.orderItem.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.commissionRecord.findMany.mockResolvedValue([]);
  mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  mockPrisma.order.update.mockResolvedValue({});
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(fakeFullOrder());

  mockAutoReverse.mockResolvedValue([
    {
      profileId: 'prof-old',
      profileName: 'OLD/PERSON',
      originalId: 'r1',
      reversalId: 'rev-r1',
      tripsUsed: 1,
      benefit: '升舱',
      orderId: 'ord1',
    },
  ]);
  mockLookup.mockResolvedValue([
    { documentType: 'PASSPORT', documentNumber: 'OLD111', profileId: 'prof-old', hasProfile: true },
    { documentType: 'PASSPORT', documentNumber: 'NEW999', profileId: 'prof-new', hasProfile: true },
  ]);
  mockGetDetail.mockResolvedValue({});
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('swapPassenger · 原地换人 → 被换下者核销自动冲正 + 档案刷新', () => {
  it('真换人（证件号变化）→ 事务内按旧证件调自动冲正，事务外刷新旧 / 新两人档案，审计带明细', async () => {
    mountSwap();

    const { audit } = await new OrderService().swapPassenger(
      'ord1',
      'pax-1',
      { fullName: 'NEW PERSON', documentNumber: 'NEW999' },
      ADMIN,
    );

    expect(mockAutoReverse).toHaveBeenCalledTimes(1);
    const [tx, input] = mockAutoReverse.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(tx).toBe(mockPrisma); // 同一事务内
    expect(input).toEqual({
      orderId: 'ord1',
      orderNumber: 'FTM2026093000001',
      reason: BENEFIT_SWAP_REVERSAL_REASON,
      reminderCreatedById: 'admin-1',
      swappedOut: {
        passengerId: 'pax-1',
        documentType: 'PASSPORT',
        documentNumber: 'OLD111',
        fullName: 'OLD/PERSON',
      },
    });
    // 冲正在 passenger.update 之后：名单此刻已是新人，「仍在同谱系行程上」不会把本单算成旧人的承载
    const updateOrder = mockPrisma.passenger.update.mock.invocationCallOrder[0];
    const reverseOrder = mockAutoReverse.mock.invocationCallOrder[0];
    expect(reverseOrder).toBeGreaterThan(updateOrder);

    expect(mockLookup).toHaveBeenCalledWith([
      { documentType: 'PASSPORT', documentNumber: 'OLD111' },
      { documentType: 'PASSPORT', documentNumber: 'NEW999' },
    ]);
    expect(mockGetDetail.mock.calls.map((c) => c[0]).sort()).toEqual(['prof-new', 'prof-old']);

    expect(audit.after.benefitReversals).toEqual([
      {
        profileId: 'prof-old',
        originalId: 'r1',
        reversalId: 'rev-r1',
        tripsUsed: 1,
        benefit: '升舱',
        orderId: 'ord1',
      },
    ]);
    expect(audit.after.profilesRefreshed).toBe(true);
    expect(audit.clearedProfile).toBe(true);
  });

  it('只改拼写（证件号没变）→ 不冲正、不刷档案，审计 after 没有这两个键', async () => {
    mountSwap();

    const { audit } = await new OrderService().swapPassenger(
      'ord1',
      'pax-1',
      { fullName: 'OLD/PERSOM' },
      ADMIN,
    );

    expect(mockAutoReverse).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockGetDetail).not.toHaveBeenCalled();
    expect(audit.after).not.toHaveProperty('benefitReversals');
    expect(audit.after).not.toHaveProperty('profilesRefreshed');
    expect(audit.clearedProfile).toBe(false);
  });

  it('档案刷新抛错 → 换人照常成功，审计 profilesRefreshed=false', async () => {
    mountSwap();
    mockLookup.mockRejectedValue(new Error('profiles down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { audit } = await new OrderService().swapPassenger(
      'ord1',
      'pax-1',
      { fullName: 'NEW PERSON', documentNumber: 'NEW999' },
      ADMIN,
    );

    expect(audit.after.profilesRefreshed).toBe(false);
    expect(audit.after.benefitReversals).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
