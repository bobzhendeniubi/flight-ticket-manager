import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BundleChangeRequestStatus, OrderStatus, Prisma, UserRole } from '@prisma/client';

const { mockPrisma, mockGetDescendantAgentIds } = vi.hoisted(() => ({
  mockPrisma: {
    agent: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    orderItem: { findUnique: vi.fn() },
    bundle: { findUnique: vi.fn() },
    bundleChangeRequest: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  mockGetDescendantAgentIds: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/agent-tree.js', () => ({ getDescendantAgentIds: mockGetDescendantAgentIds }));
vi.mock('../orders/orders.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../orders/orders.service.js')>();
  return original;
});

import { BUNDLE_CHANGE_NIGHTS_WARNING, BUNDLE_CHANGE_REQUEST_REASON_TEXT, BundleChangeRequestsService } from './bundle-change-requests.service.js';

const AGENT = { userId: 'agent-user-1', role: UserRole.AGENT };
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };
const AT = new Date('2026-09-01T00:00:00.000Z');

function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'FTM2026090100001',
    agentId: 'agent-1',
    status: OrderStatus.PENDING_PAYMENT,
    deletedAt: null,
    items: [
      {
        id: 'bundle-item-1',
        kind: 'BUNDLE',
        quantity: 2,
        amount: new Prisma.Decimal(12000),
        bundleId: 'bundle-old',
        hotelRoomTypeId: null,
        hotelCheckIn: null,
        hotelCheckOut: null,
        roomsBilled: null,
        randomStarTier: null,
        visaIntendedDate: null,
        metadata: {},
        hotelRoomType: null,
        flightSchedule: null,
      },
    ],
    ...overrides,
  };
}

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    orderId: 'order-1',
    agentId: 'agent-1',
    requestedById: 'agent-user-1',
    fromBundleId: 'bundle-old',
    fromBundleName: '旧套餐',
    fromNights: 3,
    toBundleId: 'bundle-new',
    toBundleName: '新套餐',
    toNights: 3,
    note: '客人想升级',
    status: BundleChangeRequestStatus.PENDING,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    appliedAt: null,
    appliedDiffCny: null,
    appliedDiffItemId: null,
    createdAt: AT,
    agent: { id: 'agent-1', companyName: '示例商旅', contactName: '联系人' },
    order: { orderNumber: 'FTM2026090100001', _count: { passengers: 2 } },
    ...overrides,
  };
}

function fakeOrders(changeOrderBundle: ReturnType<typeof vi.fn>) {
  return { changeOrderBundle } as any;
}

let changeOrderBundle: ReturnType<typeof vi.fn>;
let service: BundleChangeRequestsService;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    return Promise.all(arg as Promise<unknown>[]);
  });
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.orderItem.findUnique.mockResolvedValue({ description: '旧套餐快照' });
  mockPrisma.bundle.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    if (where.id === 'bundle-new') {
      return { id: 'bundle-new', name: '新套餐', isActive: true, settlementNights: 3 };
    }
    return { id: 'bundle-old', name: '旧套餐', settlementNights: 3 };
  });
  changeOrderBundle = vi.fn();
  service = new BundleChangeRequestsService(fakeOrders(changeOrderBundle));
});

describe('create() · 代理提交只落申请', () => {
  it('代理提交 → 只落一条 PENDING，快照字段正确，不碰订单', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.bundleChangeRequest.findFirst.mockResolvedValue(null);
    mockPrisma.bundleChangeRequest.create.mockResolvedValue(requestFixture());

    const result = await service.create(AGENT, 'order-1', { bundleId: 'bundle-new', note: '客人想升级' });

    expect(mockPrisma.bundleChangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-1',
          agentId: 'agent-1',
          requestedById: 'agent-user-1',
          fromBundleId: 'bundle-old',
          fromBundleName: '旧套餐',
          fromNights: 3,
          toBundleId: 'bundle-new',
          toBundleName: '新套餐',
          toNights: 3,
          note: '客人想升级',
          status: BundleChangeRequestStatus.PENDING,
        }),
      }),
    );
    expect(mockPrisma.order.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.orderItem.findUnique).not.toHaveBeenCalled();
    expect(changeOrderBundle).not.toHaveBeenCalled();
    expect(result.nightsChanged).toBe(false);
    expect(result.status).toBe(BundleChangeRequestStatus.PENDING);
  });

  it('非归属代理提交 → 403', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-2' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());

    await expect(service.create(AGENT, 'order-1', { bundleId: 'bundle-new' })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockPrisma.bundleChangeRequest.create).not.toHaveBeenCalled();
  });

  it('同单已有 PENDING → 409', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.bundleChangeRequest.findFirst.mockResolvedValue({ id: 'request-existing' });

    await expect(service.create(AGENT, 'order-1', { bundleId: 'bundle-new' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('目标套餐已下架 → 400', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
    mockPrisma.bundle.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'bundle-new'
        ? { id: 'bundle-new', name: '新套餐', isActive: false, settlementNights: 3 }
        : { id: 'bundle-old', name: '旧套餐', settlementNights: 3 },
    );

    await expect(service.create(AGENT, 'order-1', { bundleId: 'bundle-new' })).rejects.toThrow('目标套餐已下架');
  });

  it('目标与当前相同 → 400', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture());

    await expect(service.create(AGENT, 'order-1', { bundleId: 'bundle-old' })).rejects.toThrow('目标套餐与当前套餐相同');
  });
});

function prepareApprove(overrides: Record<string, unknown> = {}) {
  const fromNights = (overrides.fromNights as number | null | undefined) ?? 3;
  const toNights = (overrides.toNights as number | null | undefined) ?? 3;
  mockPrisma.$queryRaw.mockResolvedValue([
    {
      id: 'request-1',
      orderId: 'order-1',
      toBundleId: 'bundle-new',
      fromNights,
      toNights,
      note: '客人想升级',
      status: BundleChangeRequestStatus.PENDING,
      requestedById: 'agent-user-1',
      decidedAt: (overrides.decidedAt as Date | null | undefined) ?? null,
    },
  ]);
  mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
  mockPrisma.bundleChangeRequest.findUniqueOrThrow.mockResolvedValue(
    requestFixture({
      status: BundleChangeRequestStatus.APPROVED,
      appliedAt: AT,
      appliedDiffCny: new Prisma.Decimal(500),
      appliedDiffItemId: 'diff-item-1',
      ...overrides,
    }),
  );
}

describe('approve() · 确认后调用既有改档通道', () => {
  it('确认 → 传目标套餐和固定原因，回填 applied 三字段', async () => {
    prepareApprove();
    changeOrderBundle.mockResolvedValue({
      order: { id: 'order-1' },
      audit: {
        orderNumber: 'FTM2026090100001',
        orderItemId: 'bundle-item-1',
        before: { bundleId: 'bundle-old', total: '12000.00' },
        after: { bundleId: 'bundle-new', total: '12500.00' },
        diffCny: 500,
        diffItemId: 'diff-item-1',
        pricingSource: 'BUNDLE_PRICE',
        note: `${BUNDLE_CHANGE_REQUEST_REASON_TEXT}：客人想升级`,
        warnings: [],
      },
    });

    const result = await service.approve(ADMIN, 'request-1', { note: '运营确认' });

    expect(changeOrderBundle).toHaveBeenCalledWith(
      'order-1',
      { bundleId: 'bundle-new', note: `${BUNDLE_CHANGE_REQUEST_REASON_TEXT}：客人想升级` },
      ADMIN,
    );
    expect(mockPrisma.bundleChangeRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({
        status: BundleChangeRequestStatus.APPROVED,
        appliedDiffCny: expect.any(Prisma.Decimal),
        appliedDiffItemId: 'diff-item-1',
      }),
    });
    expect(result.diffCny).toBe(500);
    expect(result.request.appliedDiffCny).toBe('500');
    expect(result.request.appliedDiffItemId).toBe('diff-item-1');
  });

  it('确认时 changeOrderBundle 抛错 → 原样透出，申请回到 PENDING', async () => {
    prepareApprove();
    const error = new Error('本单酒店已落位，请先通过换酒店功能处理住宿再改档');
    changeOrderBundle.mockRejectedValue(error);

    await expect(service.approve(ADMIN, 'request-1', {})).rejects.toBe(error);
    expect(mockPrisma.bundleChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', status: BundleChangeRequestStatus.PENDING, appliedAt: null },
      data: { decidedById: null, decidedAt: null, decisionNote: null },
    });
    // 执行期间从未把状态改成 APPROVED：占位只写 decidedAt，APPROVED 只在改档成功后才落。
    for (const call of mockPrisma.bundleChangeRequest.update.mock.calls) {
      expect((call[0] as { data: { status?: unknown } }).data.status).toBeUndefined();
    }
  });

  it('另一运营正在处理（占位未过期）→ 409，不重复执行改档', async () => {
    prepareApprove({ decidedAt: new Date() });
    await expect(service.approve(ADMIN, 'request-1', {})).rejects.toMatchObject({ statusCode: 409 });
    expect(changeOrderBundle).not.toHaveBeenCalled();
  });

  it('占位已过期（上次执行中途挂掉）→ 允许再次确认', async () => {
    prepareApprove({ decidedAt: new Date(Date.now() - 10 * 60 * 1000) });
    changeOrderBundle.mockResolvedValue({
      order: { id: 'order-1' },
      audit: { orderNumber: 'FTM2026090100001', orderItemId: 'bundle-item-1', before: {}, after: {}, diffCny: 0, diffItemId: null, pricingSource: 'BUNDLE_PRICE', note: BUNDLE_CHANGE_REQUEST_REASON_TEXT, warnings: [] },
    });
    await expect(service.approve(ADMIN, 'request-1', {})).resolves.toBeTruthy();
    expect(changeOrderBundle).toHaveBeenCalledTimes(1);
  });

  it('晚数不同 → warnings 追加回程改期提示；晚数相同不追加', async () => {
    prepareApprove({ fromNights: 3, toNights: 5 });
    changeOrderBundle.mockResolvedValue({
      order: { id: 'order-1' },
      audit: {
        orderNumber: 'FTM2026090100001',
        orderItemId: 'bundle-item-1',
        before: {},
        after: {},
        diffCny: 0,
        diffItemId: null,
        pricingSource: 'BUNDLE_PRICE',
        note: BUNDLE_CHANGE_REQUEST_REASON_TEXT,
        warnings: ['已有提示'],
      },
    });
    const changed = await service.approve(ADMIN, 'request-1', {});
    expect(changed.warnings).toEqual(['已有提示', BUNDLE_CHANGE_NIGHTS_WARNING]);

    prepareApprove({ fromNights: 3, toNights: 3 });
    const same = await service.approve(ADMIN, 'request-1', {});
    expect(same.warnings).toEqual(['已有提示']);
  });

  it('非 PENDING 再确认 → 409', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'request-1',
        orderId: 'order-1',
        toBundleId: 'bundle-new',
        fromNights: 3,
        toNights: 3,
        note: null,
        status: BundleChangeRequestStatus.APPROVED,
        requestedById: 'agent-user-1',
      },
    ]);

    await expect(service.approve(ADMIN, 'request-1', {})).rejects.toMatchObject({ statusCode: 409 });
    expect(changeOrderBundle).not.toHaveBeenCalled();
  });
});

describe('reject() · 只改申请状态', () => {
  it('驳回 → 只改状态', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 'request-1', orderId: 'order-1', status: BundleChangeRequestStatus.PENDING, requestedById: 'agent-user-1' },
    ]);
    mockPrisma.bundleChangeRequest.update.mockResolvedValue(
      requestFixture({ status: BundleChangeRequestStatus.REJECTED, decidedById: 'admin-1', decidedAt: AT, decisionNote: '暂不支持' }),
    );

    const result = await service.reject(ADMIN, 'request-1', { note: '暂不支持' });

    expect(mockPrisma.bundleChangeRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'request-1' },
      data: expect.objectContaining({ status: BundleChangeRequestStatus.REJECTED, decisionNote: '暂不支持' }),
    }));
    expect(changeOrderBundle).not.toHaveBeenCalled();
    expect(result.request.status).toBe(BundleChangeRequestStatus.REJECTED);
  });
});
