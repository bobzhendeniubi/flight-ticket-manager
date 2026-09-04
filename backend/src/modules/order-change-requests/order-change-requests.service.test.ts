/**
 * 改单申请 · 服务层单测。
 *
 * 覆盖：提交只落申请不碰订单 / 代理越权 403 / 同类重复 409 / 已签证硬闸 /
 * 批量按航段解析 / 确认调对通道且用运营身份 / 确认失败留 PENDING 记 applyError /
 * 驳回 / 批量确认部分成功。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrderChangeKind,
  OrderChangeRequestStatus,
  UserRole,
  VisaRequirement,
} from '@prisma/client';

const { mockPrisma, mockGetDescendantAgentIds } = vi.hoisted(() => ({
  mockPrisma: {
    agent: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    orderChangeRequest: {
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

import {
  ORDER_CHANGE_BATCH_UNSUPPORTED_KIND_MESSAGE,
  ORDER_CHANGE_DUPLICATE_PENDING_MESSAGE,
  ORDER_CHANGE_VISA_HAS_VISA_MESSAGE,
  OrderChangeRequestsService,
} from './order-change-requests.service.js';

const AGENT = { userId: 'agent-user-1', role: UserRole.AGENT };
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };
const AT = new Date('2026-09-04T00:00:00.000Z');

/** 去程 2026-09-12 QH0001 / 回程 2026-09-15 QH0002（合成航班号，非真实班次）。 */
function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'FTM2026090400001',
    agentId: 'agent-1',
    deletedAt: null,
    visaStatus: VisaRequirement.NEEDED,
    items: [
      {
        id: 'item-out',
        kind: 'FLIGHT',
        flightScheduleId: 'sched-out',
        flightCabin: 'ECONOMY',
        hotelRoomTypeId: null,
        flightSchedule: {
          id: 'sched-out',
          departureTime: new Date('2026-09-12T02:00:00.000Z'),
          departureTz: 'Asia/Shanghai',
          flight: { flightNumber: 'QH0001' },
        },
        hotelRoomType: null,
      },
      {
        id: 'item-ret',
        kind: 'FLIGHT',
        flightScheduleId: 'sched-ret',
        flightCabin: 'ECONOMY',
        hotelRoomTypeId: null,
        flightSchedule: {
          id: 'sched-ret',
          departureTime: new Date('2026-09-15T02:00:00.000Z'),
          departureTz: 'Asia/Shanghai',
          flight: { flightNumber: 'QH0002' },
        },
        hotelRoomType: null,
      },
      {
        id: 'item-hotel',
        kind: 'HOTEL',
        flightScheduleId: null,
        flightCabin: null,
        hotelRoomTypeId: 'room-old',
        flightSchedule: null,
        hotelRoomType: { id: 'room-old', name: '高级大床', hotel: { name: '示例海景酒店' } },
      },
    ],
    ...overrides,
  };
}

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    orderId: 'order-1',
    agentId: 'agent-1',
    requestedById: 'agent-user-1',
    batchId: null,
    kind: OrderChangeKind.VISA,
    payload: { toVisaStatus: VisaRequirement.NOT_NEEDED, fromVisaStatus: VisaRequirement.NEEDED },
    summary: '签证状态 需要 → 不需要',
    note: null,
    status: OrderChangeRequestStatus.PENDING,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    appliedAt: null,
    applyError: null,
    createdAt: AT,
    agent: { id: 'agent-1', companyName: '示例商旅', contactName: '联系人' },
    order: { orderNumber: 'FTM2026090400001' },
    ...overrides,
  };
}

let ordersStub: {
  correctFlightSchedule: ReturnType<typeof vi.fn>;
  setOrderVisaStatus: ReturnType<typeof vi.fn>;
  swapItemHotel: ReturnType<typeof vi.fn>;
  upgradeOrderItemCabin: ReturnType<typeof vi.fn>;
};
let service: OrderChangeRequestsService;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
  mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
  mockPrisma.orderChangeRequest.findFirst.mockResolvedValue(null);
  mockPrisma.orderChangeRequest.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => requestFixture(data),
  );
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockGetDescendantAgentIds.mockResolvedValue(['agent-1', 'agent-1-child']);

  ordersStub = {
    correctFlightSchedule: vi.fn(),
    setOrderVisaStatus: vi.fn(),
    swapItemHotel: vi.fn(),
    upgradeOrderItemCabin: vi.fn(),
  };
  service = new OrderChangeRequestsService(ordersStub as never);
});

describe('create() · 提交只落申请', () => {
  it('签证申请 → 快照原值、摘要是人话，订单一个字没动', async () => {
    const request = await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.VISA,
      payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
      note: ' 客人自己有签 ',
    });

    expect(mockPrisma.orderChangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-1',
          agentId: 'agent-1',
          requestedById: 'agent-user-1',
          kind: OrderChangeKind.VISA,
          batchId: null,
          note: '客人自己有签',
          status: OrderChangeRequestStatus.PENDING,
          payload: {
            toVisaStatus: VisaRequirement.NOT_NEEDED,
            fromVisaStatus: VisaRequirement.NEEDED,
          },
          summary: '签证状态 需要 → 不需要',
        }),
      }),
    );
    expect(request.status).toBe(OrderChangeRequestStatus.PENDING);
    // 提交阶段一个改订单的通道都不该被碰。
    expect(ordersStub.setOrderVisaStatus).not.toHaveBeenCalled();
    expect(ordersStub.correctFlightSchedule).not.toHaveBeenCalled();
  });

  it('改班次申请 → 落 from/to 班次与当地出发日快照，摘要带航段与航班号', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched-new',
      departureTime: new Date('2026-09-13T02:00:00.000Z'),
      departureTz: 'Asia/Shanghai',
      isActive: true,
      flight: { flightNumber: 'QH0001' },
    });

    await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.FLIGHT,
      payload: { itemId: 'item-out', newScheduleId: 'sched-new' },
    });

    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toEqual({
      itemId: 'item-out',
      newScheduleId: 'sched-new',
      fromScheduleId: 'sched-out',
      fromDepartureLocal: '2026-09-12',
      toDepartureLocal: '2026-09-13',
      flightNo: 'QH0001',
    });
    expect(data.summary).toBe('去程 2026-09-12 QH0001 → 2026-09-13 QH0001');
  });

  it('换酒店申请 → 快照新旧「酒店 · 房型」', async () => {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      id: 'room-new',
      name: '豪华套房',
      hotel: { name: '示例山景酒店', isActive: true },
    });

    await service.create(ADMIN, 'order-1', {
      kind: OrderChangeKind.HOTEL,
      payload: { itemId: 'item-hotel', toHotelRoomTypeId: 'room-new' },
    });

    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toEqual({
      itemId: 'item-hotel',
      toHotelRoomTypeId: 'room-new',
      toHotelName: '示例山景酒店 · 豪华套房',
      fromHotelName: '示例海景酒店 · 高级大床',
    });
    expect(data.summary).toBe('酒店 示例海景酒店 · 高级大床 → 示例山景酒店 · 豪华套房');
  });

  it('升舱申请 → 目标舱位恒商务舱，快照原舱位', async () => {
    await service.create(ADMIN, 'order-1', {
      kind: OrderChangeKind.CABIN,
      payload: { itemId: 'item-out' },
    });

    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toEqual({ itemId: 'item-out', toCabin: 'BUSINESS', fromCabin: 'ECONOMY' });
    expect(data.summary).toBe('经济舱 → 商务舱');
  });

  it('代理对别家单提申请 → 403，不写库', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ agentId: 'agent-other' }));
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
      }),
    ).rejects.toThrow('只能对自己名下的订单提交改单申请');
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('同一订单同一类已有待处理 → 409', async () => {
    mockPrisma.orderChangeRequest.findFirst.mockResolvedValue({ id: 'req-old' });
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
      }),
    ).rejects.toThrow(ORDER_CHANGE_DUPLICATE_PENDING_MESSAGE);
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('签证状态想改成「已签证」→ 400，那是签证岗的活', async () => {
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.HAS_VISA },
      }),
    ).rejects.toThrow(ORDER_CHANGE_VISA_HAS_VISA_MESSAGE);
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
  });
});

describe('createBatch() · 一批单同一类改动', () => {
  it('按航段批量改班次 → 每张单各自解析到回程行，共用一个 batchId', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched-new-ret',
      departureTime: new Date('2026-09-16T02:00:00.000Z'),
      departureTz: 'Asia/Shanghai',
      isActive: true,
      flight: { flightNumber: 'QH0002' },
    });

    const res = await service.createBatch(ADMIN, {
      orderIds: ['order-1', 'order-2'],
      kind: OrderChangeKind.FLIGHT,
      payload: { leg: 'RETURN', newScheduleId: 'sched-new-ret' },
    });

    expect(res.created).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.results.every((r) => r.ok)).toBe(true);
    const [first, second] = mockPrisma.orderChangeRequest.create.mock.calls;
    expect(first[0].data.payload).toMatchObject({
      itemId: 'item-ret',
      fromScheduleId: 'sched-ret',
      fromDepartureLocal: '2026-09-15',
      toDepartureLocal: '2026-09-16',
    });
    expect(first[0].data.summary).toBe('回程 2026-09-15 QH0002 → 2026-09-16 QH0002');
    // 同一批共用一个 batchId
    expect(first[0].data.batchId).toBe(second[0].data.batchId);
    expect(first[0].data.batchId).toBeTruthy();
  });

  it('单张失败不拖垮整批 → 失败那张记 reason，其余照常落库', async () => {
    mockPrisma.orderChangeRequest.findFirst
      .mockResolvedValueOnce({ id: 'req-old' }) // order-1 已有同类待处理
      .mockResolvedValueOnce(null);

    const res = await service.createBatch(ADMIN, {
      orderIds: ['order-1', 'order-2'],
      kind: OrderChangeKind.VISA,
      payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
    });

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.results[0]).toMatchObject({
      orderId: 'order-1',
      ok: false,
      reason: ORDER_CHANGE_DUPLICATE_PENDING_MESSAGE,
    });
    expect(res.results[1]).toMatchObject({ orderId: 'order-2', ok: true });
  });

  it('换酒店 / 升舱不支持批量 → 400', async () => {
    for (const kind of [OrderChangeKind.HOTEL, OrderChangeKind.CABIN]) {
      await expect(
        service.createBatch(ADMIN, {
          orderIds: ['order-1'],
          kind,
          payload: { itemId: 'item-hotel' },
        }),
      ).rejects.toThrow(ORDER_CHANGE_BATCH_UNSUPPORTED_KIND_MESSAGE);
    }
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
  });
});

// ── 确认 / 驳回 ─────────────────────────────────────────────────────────────

function primeApprove(kind: OrderChangeKind, payload: Record<string, unknown>) {
  mockPrisma.$queryRaw.mockResolvedValue([
    {
      id: 'req-1',
      orderId: 'order-1',
      kind,
      payload,
      summary: '摘要',
      status: OrderChangeRequestStatus.PENDING,
      requestedById: 'agent-user-1',
      decidedAt: null,
    },
  ]);
  mockPrisma.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'FTM2026090400001',
    deletedAt: null,
  });
  mockPrisma.orderChangeRequest.update.mockResolvedValue(requestFixture());
  mockPrisma.orderChangeRequest.findUniqueOrThrow.mockResolvedValue(
    requestFixture({
      kind,
      payload,
      status: OrderChangeRequestStatus.APPROVED,
      decidedById: 'admin-1',
      decidedAt: AT,
      appliedAt: AT,
    }),
  );
}

describe('approve() · 运营一键执行', () => {
  it('改班次 → 调纠错通道，actor 是点确认的运营', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    ordersStub.correctFlightSchedule.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    const res = await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.correctFlightSchedule).toHaveBeenCalledWith(
      'order-1',
      'item-out',
      'sched-new',
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
    expect(res.request.status).toBe(OrderChangeRequestStatus.APPROVED);
    expect(res.order).toEqual({ id: 'order-1' });
    expect(mockPrisma.orderChangeRequest.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OrderChangeRequestStatus.APPROVED,
          applyError: null,
        }),
      }),
    );
  });

  it('签证 → 调写签证状态通道', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });
    ordersStub.setOrderVisaStatus.mockResolvedValue({ order: { id: 'order-1' } });

    await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.setOrderVisaStatus).toHaveBeenCalledWith(
      'order-1',
      VisaRequirement.NOT_NEEDED,
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
  });

  it('换酒店 → 调换酒店通道且差价恒 0', async () => {
    primeApprove(OrderChangeKind.HOTEL, { itemId: 'item-hotel', toHotelRoomTypeId: 'room-new' });
    ordersStub.swapItemHotel.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.swapItemHotel).toHaveBeenCalledWith(
      'order-1',
      'item-hotel',
      expect.objectContaining({ newHotelRoomTypeId: 'room-new', feeCny: 0 }),
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
  });

  it('升舱 → 调升舱通道（金额字段一个都不传，服务端自己算）', async () => {
    primeApprove(OrderChangeKind.CABIN, { itemId: 'item-out', toCabin: 'BUSINESS' });
    ordersStub.upgradeOrderItemCabin.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {});

    const input = ordersStub.upgradeOrderItemCabin.mock.calls[0][2];
    expect(Object.keys(input)).toEqual(['note']);
  });

  it('执行失败 → 申请留在 PENDING、记 applyError、400 把原因原样带出来', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    ordersStub.correctFlightSchedule.mockRejectedValue(
      new Error('本单含套餐立减，改班次要重算补差'),
    );

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(
      '本单含套餐立减，改班次要重算补差',
    );

    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: OrderChangeRequestStatus.PENDING, appliedAt: null },
      data: {
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
        applyError: '本单含套餐立减，改班次要重算补差',
      },
    });
    // 状态没被翻成 APPROVED
    const statusWrites = (
      mockPrisma.orderChangeRequest.update.mock.calls as Array<[{ data: Record<string, unknown> }]>
    ).filter((c) => c[0].data.status !== undefined);
    expect(statusWrites).toHaveLength(0);
  });

  it('非待处理状态 → 409，不碰任何改订单通道', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        kind: OrderChangeKind.VISA,
        payload: {},
        summary: '摘要',
        status: OrderChangeRequestStatus.APPROVED,
        requestedById: 'agent-user-1',
        decidedAt: null,
      },
    ]);
    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow('不可重复处理');
    expect(ordersStub.setOrderVisaStatus).not.toHaveBeenCalled();
  });

  it('代理点确认 → 403', async () => {
    await expect(service.approve(AGENT, 'req-1', {})).rejects.toThrow(
      '仅运营/管理员可确认改单申请',
    );
  });
});

describe('reject()', () => {
  it('驳回 → 落 REJECTED + 决定人 + 备注，不碰订单', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 'req-1', status: OrderChangeRequestStatus.PENDING },
    ]);
    mockPrisma.orderChangeRequest.update.mockResolvedValue(
      requestFixture({
        status: OrderChangeRequestStatus.REJECTED,
        decidedById: 'admin-1',
        decidedAt: AT,
        decisionNote: '客人已确认不改',
      }),
    );

    const { request, audit } = await service.reject(ADMIN, 'req-1', {
      decisionNote: ' 客人已确认不改 ',
    });

    expect(request.status).toBe(OrderChangeRequestStatus.REJECTED);
    expect(audit.orderNumber).toBe('FTM2026090400001');
    expect(mockPrisma.orderChangeRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OrderChangeRequestStatus.REJECTED,
          decidedById: 'admin-1',
          decisionNote: '客人已确认不改',
        }),
      }),
    );
    expect(ordersStub.setOrderVisaStatus).not.toHaveBeenCalled();
  });

  it('代理点驳回 → 403', async () => {
    await expect(service.reject(AGENT, 'req-1', {})).rejects.toThrow('仅运营/管理员可驳回改单申请');
  });
});

describe('batchApprove() · 部分成功', () => {
  it('一条成一条败 → approved/failed 分开计数，失败带原因', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'FTM2026090400001',
      deletedAt: null,
    });
    mockPrisma.orderChangeRequest.update.mockResolvedValue(requestFixture());
    mockPrisma.orderChangeRequest.findUniqueOrThrow.mockResolvedValue(
      requestFixture({ status: OrderChangeRequestStatus.APPROVED, appliedAt: AT }),
    );
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'req-1',
          orderId: 'order-1',
          kind: OrderChangeKind.VISA,
          payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
          summary: '摘要',
          status: OrderChangeRequestStatus.PENDING,
          requestedById: 'agent-user-1',
          decidedAt: null,
        },
      ])
      .mockResolvedValueOnce([]); // req-2 不存在
    ordersStub.setOrderVisaStatus.mockResolvedValue({ order: { id: 'order-1' } });

    const res = await service.batchApprove(ADMIN, { ids: ['req-1', 'req-2'] });

    expect(res.approved).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.results).toEqual([
      { id: 'req-1', ok: true },
      { id: 'req-2', ok: false, error: '改单申请不存在' },
    ]);
    expect(res.approvedRequests).toHaveLength(1);
  });
});

describe('list() · 可见范围', () => {
  it('代理只看自己（含下级）的申请，越权传 agentId 也筛不出别人的', async () => {
    mockPrisma.orderChangeRequest.findMany.mockResolvedValue([requestFixture()]);

    await service.list(AGENT, { agentId: 'agent-other', limit: 50 });

    expect(mockPrisma.orderChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ agentId: { in: [] } }) }),
    );
  });

  it('运营可按订单筛，多出一条时回 nextCursor', async () => {
    mockPrisma.orderChangeRequest.findMany.mockResolvedValue([
      requestFixture({ id: 'req-a' }),
      requestFixture({ id: 'req-b' }),
    ]);

    const res = await service.list(ADMIN, { orderId: 'order-1', limit: 1 });

    expect(mockPrisma.orderChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order-1' }, take: 2 }),
    );
    expect(res.requests).toHaveLength(1);
    expect(res.nextCursor).toBe('req-a');
  });
});

describe('pendingCount()', () => {
  it('只数待处理的，代理打不开', async () => {
    mockPrisma.orderChangeRequest.count.mockResolvedValue(7);
    await expect(service.pendingCount(ADMIN)).resolves.toEqual({ count: 7 });
    expect(mockPrisma.orderChangeRequest.count).toHaveBeenCalledWith({
      where: { status: OrderChangeRequestStatus.PENDING },
    });
    await expect(service.pendingCount(AGENT)).rejects.toThrow('仅运营/管理员可查看待处理改单申请');
  });
});
