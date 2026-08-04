/**
 * createOrder 支付超时口径（0708 业务定）单测。
 *
 * 口径：机位是否因未支付被自动退回，只看服务端认证身份——
 *   - 后台/代理录入（AGENT / STAFF / ADMIN）→ paymentExpiresAt=null，且不入队 seat-hold 自动释放；
 *   - 前台散客（匿名游客 / 登录 CUSTOMER）→ paymentExpiresAt=now+30min，并入队自动释放。
 *
 * mock 风格对齐 orders.service.test.ts / orders.status-seats.test.ts：
 *   vi.mock Prisma + queue，spy 掉定价/护照/查重私有方法，只驱动超时/入队那一小节。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 在 import OrderService 之前 mock 依赖（vi.mock 会被 hoist） ──
const { mockPrisma, mockScheduleSeatHoldRelease } = vi.hoisted(() => {
  const prisma = {
    order: {
      findUnique: vi.fn(),
      // tx.order.create：回显传入的 paymentExpiresAt，供事务后入队判定读取
      create: vi.fn(),
      // syncOrderHasReturnLeg 在建单事务内回写物化列 hasReturnLeg
      update: vi.fn(),
    },
    orderCostItem: { create: vi.fn() },
    // createVisaTaskAtCreation（best-effort，事务后调用）会查订单项；返回空 → 直接 return []
    orderItem: { findMany: vi.fn() },
    seatLock: {
      aggregate: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    // createVisaTaskAtCreation（best-effort，try/catch 包裹）可能用到
    fulfillmentTask: { findFirst: vi.fn(), create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return {
    mockPrisma: prisma,
    mockScheduleSeatHoldRelease: vi.fn(),
  };
});

// tx 与 prisma 共用同一批 vi.fn（事务体内 tx.* 与事务外 prisma.* 不区分）
const mockTx = mockPrisma;
mockPrisma.$transaction.mockImplementation(
  async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
);

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// 关键：mock queue 模块，避免 createOrder 事务后 import 真连 Redis；同时 spy 入队调用
vi.mock('../../queues/queue.js', () => ({
  scheduleSeatHoldRelease: mockScheduleSeatHoldRelease,
  cancelSeatLockExpiry: vi.fn(),
}));

import { OrderService } from './orders.service.js';
import type { CreateOrderBody } from './orders.schemas.js';
import type { OrderRequester, GuestRequester } from './orders.service.js';

const RETAIL_TIMEOUT_MS = 30 * 60 * 1000;

const flightItem = {
  kind: 'FLIGHT' as const,
  description: 'QH9589 澳门→岘港 经济舱',
  quantity: 1,
  flightScheduleId: 'sched-1',
  flightCabin: 'ECONOMY' as const,
};

const passenger = {
  fullName: '张三',
  documentType: 'PASSPORT' as const,
  documentNumber: 'E12345678',
  dateOfBirth: '1990-01-01',
  nationality: 'CN',
  passengerType: 'ADULT' as const,
  // 后台录单（ADMIN/STAFF）新建路径护照有效期必填
  passportExpiry: '2031-01-01',
};

const body = {
  contactName: '联系人',
  contactPhone: '13800000000',
  items: [flightItem],
  passengers: [passenger],
} as unknown as CreateOrderBody;

/** 建 service 实例并 spy 掉定价/护照/查重，只保留超时/入队逻辑。 */
function makeService(): OrderService {
  const service = new OrderService();
  const priced = [
    {
      kind: 'FLIGHT' as const,
      description: flightItem.description,
      quantity: 1,
      unitPrice: 1000,
      amount: 1000,
      flightScheduleId: 'sched-1',
      flightCabin: 'ECONOMY' as const,
      businessUpgradeCount: undefined,
    },
  ];
  const anyService = service as unknown as Record<string, unknown>;
  vi.spyOn(anyService as never, 'assertNoDuplicatePassengersOnFlights' as never).mockResolvedValue(
    undefined as never,
  );
  vi.spyOn(anyService as never, 'priceAndValidateItems' as never).mockResolvedValue(priced as never);
  vi.spyOn(anyService as never, 'applyPassportExpiryRule' as never).mockResolvedValue(
    undefined as never,
  );
  return service;
}

function paymentExpiresAtPassedToCreate(): Date | null {
  const call = mockPrisma.order.create.mock.calls[0];
  return (call[0] as { data: { paymentExpiresAt: Date | null } }).data.paymentExpiresAt;
}

describe('createOrder 支付超时口径 · 身份判定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 事务体最小依赖：扣座（aggregate + $executeRaw）、消费本人锁位（findMany 空）、成本项、建单回显
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
    mockPrisma.seatLock.findMany.mockResolvedValue([]);
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.orderCostItem.create.mockResolvedValue({});
    // createVisaTaskAtCreation：无订单项 → 直接 return []（best-effort，另有 try/catch 兜底）
    mockPrisma.order.findUnique.mockResolvedValue({ visaStatus: null });
    mockPrisma.orderItem.findMany.mockResolvedValue([]);
    mockPrisma.order.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      id: 'ord1',
      orderNumber: args.data.orderNumber,
      paymentExpiresAt: args.data.paymentExpiresAt ?? null,
      items: [],
      passengers: [],
      statusEvents: [],
    }));
  });

  it('前台散客（登录 CUSTOMER）→ paymentExpiresAt=now+30min，且入队自动释放', async () => {
    const service = makeService();
    const requester: OrderRequester = { userId: 'u1', role: 'CUSTOMER' };

    const before = Date.now();
    await service.createOrder(body, requester);
    const after = Date.now();

    const expiresAt = paymentExpiresAtPassedToCreate();
    expect(expiresAt).toBeInstanceOf(Date);
    const ms = (expiresAt as Date).getTime();
    expect(ms).toBeGreaterThanOrEqual(before + RETAIL_TIMEOUT_MS - 50);
    expect(ms).toBeLessThanOrEqual(after + RETAIL_TIMEOUT_MS + 50);

    // 入队：seat-hold 自动释放
    expect(mockScheduleSeatHoldRelease).toHaveBeenCalledTimes(1);
    expect(mockScheduleSeatHoldRelease).toHaveBeenCalledWith('ord1', expect.any(Number));
  });

  it('前台散客（匿名游客）→ paymentExpiresAt=now+30min，且入队自动释放', async () => {
    const service = makeService();
    const requester: GuestRequester = {
      guest: { name: '游客甲', phone: '13900000000' },
    };

    await service.createOrder(body, requester);

    expect(paymentExpiresAtPassedToCreate()).toBeInstanceOf(Date);
    expect(mockScheduleSeatHoldRelease).toHaveBeenCalledTimes(1);
  });

  it('后台录入（STAFF）→ paymentExpiresAt=null，且不入队（机位不自动退）', async () => {
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    await service.createOrder(body, requester);

    expect(paymentExpiresAtPassedToCreate()).toBeNull();
    expect(mockScheduleSeatHoldRelease).not.toHaveBeenCalled();
  });

  it('管理员录入（ADMIN）→ paymentExpiresAt=null，且不入队', async () => {
    const service = makeService();
    const requester: OrderRequester = { userId: 'admin1', role: 'ADMIN' };

    await service.createOrder(body, requester);

    expect(paymentExpiresAtPassedToCreate()).toBeNull();
    expect(mockScheduleSeatHoldRelease).not.toHaveBeenCalled();
  });

  it('代理自助（AGENT）→ paymentExpiresAt=null，且不入队', async () => {
    const service = makeService();
    const requester: OrderRequester = { userId: 'ag1', role: 'AGENT', agentId: 'agent-1' };

    await service.createOrder(body, requester);

    expect(paymentExpiresAtPassedToCreate()).toBeNull();
    expect(mockScheduleSeatHoldRelease).not.toHaveBeenCalled();
  });
});
