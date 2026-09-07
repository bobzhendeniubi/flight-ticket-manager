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
    orderItem: { findUnique: vi.fn() },
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
  ORDER_CHANGE_EXECUTION_KIND_MESSAGE,
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
    status: 'PENDING_PAYMENT',
    visaStatus: VisaRequirement.NEEDED,
    items: [
      {
        id: 'item-out',
        kind: 'FLIGHT',
        quantity: 2,
        roomsBilled: null,
        totalCostCny: null,
        flightScheduleId: 'sched-out',
        flightCabin: 'ECONOMY',
        hotelRoomTypeId: null,
        flightSchedule: {
          id: 'sched-out',
          departureTime: new Date('2026-09-12T02:00:00.000Z'),
          departureTz: 'Asia/Shanghai',
          // 2 人 × ¥2400/程 = ¥4800 补差
          flight: { flightNumber: 'QH0001', businessUpgradeCnyPerLeg: 2400 },
        },
        hotelRoomType: null,
      },
      {
        id: 'item-ret',
        kind: 'FLIGHT',
        quantity: 2,
        roomsBilled: null,
        totalCostCny: null,
        flightScheduleId: 'sched-ret',
        flightCabin: 'ECONOMY',
        hotelRoomTypeId: null,
        flightSchedule: {
          id: 'sched-ret',
          departureTime: new Date('2026-09-15T02:00:00.000Z'),
          departureTz: 'Asia/Shanghai',
          flight: { flightNumber: 'QH0002', businessUpgradeCnyPerLeg: 2400 },
        },
        hotelRoomType: null,
      },
      {
        id: 'item-hotel',
        kind: 'HOTEL',
        // 3 晚 × 1 间，原成本 ¥900
        quantity: 3,
        roomsBilled: 1,
        totalCostCny: 900,
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
  /** 售后改期通道（改班次申请选「按售后改期执行」时走它）。 */
  rescheduleOrderItem: ReturnType<typeof vi.fn>;
  setOrderVisaStatus: ReturnType<typeof vi.fn>;
  swapItemHotel: ReturnType<typeof vi.fn>;
  upgradeOrderItemCabin: ReturnType<typeof vi.fn>;
  /** 幂等分支（不执行、只补状态）要回一份当前订单。 */
  getOrder: ReturnType<typeof vi.fn>;
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
    rescheduleOrderItem: vi.fn(),
    setOrderVisaStatus: vi.fn(),
    swapItemHotel: vi.fn(),
    upgradeOrderItemCabin: vi.fn(),
    getOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
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

  it('换酒店申请 → 快照新旧「酒店 · 房型」+ 前后成本，摘要里不带成本', async () => {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      id: 'room-new',
      name: '豪华套房',
      costPriceCny: 400, // 400 × 3 晚 × 1 间 = 1200
      hotel: { name: '示例山景酒店', isActive: true },
    });

    const request = await service.create(ADMIN, 'order-1', {
      kind: OrderChangeKind.HOTEL,
      payload: { itemId: 'item-hotel', toHotelRoomTypeId: 'room-new' },
    });

    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toEqual({
      itemId: 'item-hotel',
      toHotelRoomTypeId: 'room-new',
      toHotelName: '示例山景酒店 · 豪华套房',
      fromHotelName: '示例海景酒店 · 高级大床',
      costBeforeCny: 900,
      costAfterCny: 1200,
    });
    expect(data.summary).toBe('酒店 示例海景酒店 · 高级大床 → 示例山景酒店 · 豪华套房');
    // 运营看得到成本变动
    expect(request.costDeltaCny).toBe(300);
  });

  it('换酒店申请 · 代理侧 → 成本快照与 costDeltaCny 一个字都不给', async () => {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      id: 'room-new',
      name: '豪华套房',
      costPriceCny: 400,
      hotel: { name: '示例山景酒店', isActive: true },
    });

    const request = await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.HOTEL,
      payload: { itemId: 'item-hotel', toHotelRoomTypeId: 'room-new' },
    });

    expect(request.costDeltaCny).toBeNull();
    expect(request.payload).not.toHaveProperty('costBeforeCny');
    expect(request.payload).not.toHaveProperty('costAfterCny');
    // 落库的那份仍然带着成本（运营侧要看）
    expect(mockPrisma.orderChangeRequest.create.mock.calls[0][0].data.payload).toMatchObject({
      costBeforeCny: 900,
      costAfterCny: 1200,
    });
  });

  it('升舱申请 → 目标舱位恒商务舱，快照原舱位与补差，摘要写明金额', async () => {
    const request = await service.create(ADMIN, 'order-1', {
      kind: OrderChangeKind.CABIN,
      payload: { itemId: 'item-out' },
    });

    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toEqual({
      itemId: 'item-out',
      toCabin: 'BUSINESS',
      fromCabin: 'ECONOMY',
      diffCny: 4800,
    });
    expect(data.summary).toBe('经济舱 → 商务舱（补差 ¥4,800）');
    // 补差所有角色都看得见（这笔钱最终由代理的客人出）
    expect(request.amountCny).toBe(4800);
  });

  it('升舱申请 · 代理侧同样看得到补差金额', async () => {
    const request = await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.CABIN,
      payload: { itemId: 'item-out' },
    });
    expect(request.amountCny).toBe(4800);
  });

  it('升舱申请 · 航班没配商务舱差价 → 400，不攒执行不了的申请', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      orderFixture({
        items: [
          {
            ...orderFixture().items[0],
            flightSchedule: {
              ...orderFixture().items[0].flightSchedule,
              flight: { flightNumber: 'QH0001', businessUpgradeCnyPerLeg: 0 },
            },
          },
        ],
      }),
    );
    await expect(
      service.create(ADMIN, 'order-1', {
        kind: OrderChangeKind.CABIN,
        payload: { itemId: 'item-out' },
      }),
    ).rejects.toThrow('该航班未配置商务舱差价，请先在航班管理维护');
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('订单不在占座态 → 400 带状态中文名，不写库', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ status: 'CANCELLED' }));
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
      }),
    ).rejects.toThrow('订单当前状态（已取消）不可提交改单申请');
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
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

  it('按航段批量 · 本单有已释放的机票行 → 拒，绝不落到另一段上', async () => {
    // 去程座位被 no-show 释放（flightScheduleId 置空）：旧口径下回程会顶上来当「去程」。
    const released = orderFixture();
    released.items[0].flightScheduleId = null;
    released.items[0].flightSchedule = null;
    mockPrisma.order.findUnique.mockResolvedValue(released);
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched-new',
      departureTime: new Date('2026-09-13T02:00:00.000Z'),
      departureTz: 'Asia/Shanghai',
      isActive: true,
      flight: { flightNumber: 'QH0001' },
    });

    const res = await service.createBatch(ADMIN, {
      orderIds: ['order-1'],
      kind: OrderChangeKind.FLIGHT,
      payload: { leg: 'OUTBOUND', newScheduleId: 'sched-new' },
    });

    expect(res.created).toBe(0);
    expect(res.results[0].reason).toBe('该航段座位已释放，无法按航段申请');
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
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
  // 目标班次默认可用（在售 + 未起飞）：改班次执行前会复检一次现状。
  mockPrisma.flightSchedule.findUnique.mockResolvedValue({
    id: 'sched-new',
    isActive: true,
    departureTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  mockPrisma.orderChangeRequest.update.mockResolvedValue(requestFixture());
  mockPrisma.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
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
    // 收尾回写是条件更新（status 仍是 PENDING 才写），不是无条件 update
    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'req-1', status: OrderChangeRequestStatus.PENDING },
        data: expect.objectContaining({
          status: OrderChangeRequestStatus.APPROVED,
          applyError: null,
        }),
      }),
    );
  });

  it('改班次 · 缺省（不传 execution）→ 仍走纠错通道，不碰售后改期', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    ordersStub.correctFlightSchedule.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    const res = await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.correctFlightSchedule).toHaveBeenCalled();
    expect(ordersStub.rescheduleOrderItem).not.toHaveBeenCalled();
    expect(res.audit.executionMode).toBe('CORRECTION');
    expect(res.audit.executionFeeCny).toBe(0);
  });

  it('改班次 · 按售后改期执行 → 调改期通道并透传改期费/名目/备注', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    ordersStub.rescheduleOrderItem.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    const res = await service.approve(ADMIN, 'req-1', {
      execution: { mode: 'AFTER_SALES', feeCny: 800, feeLabel: '改期费', note: '客人自行改期' },
    });

    expect(ordersStub.correctFlightSchedule).not.toHaveBeenCalled();
    expect(ordersStub.rescheduleOrderItem).toHaveBeenCalledWith(
      'order-1',
      {
        orderItemId: 'item-out',
        newScheduleId: 'sched-new',
        feeCny: 800,
        feeLabel: '改期费',
        note: '客人自行改期',
      },
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
    expect(res.audit.executionMode).toBe('AFTER_SALES');
    expect(res.audit.executionFeeCny).toBe(800);
    // 「已起飞放行」两个开关一律不从确认通道溜进去
    const passed = ordersStub.rescheduleOrderItem.mock.calls[0][1];
    expect(passed.allowDepartedTarget).toBeUndefined();
    expect(passed.allowFlownSource).toBeUndefined();
  });

  it('改班次 · 按售后改期执行 → 确认备注留下执行方式与改期费', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    ordersStub.rescheduleOrderItem.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {
      execution: { mode: 'AFTER_SALES', feeCny: 800 },
      decisionNote: '已与代理确认',
    });

    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decisionNote: '按售后改期执行（改期费 ¥800）；已与代理确认',
        }),
      }),
    );
  });

  it('改班次 · 按售后改期执行 → 目标班次复检照跑，停售一样拒', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched-new',
      isActive: false,
      departureTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await expect(
      service.approve(ADMIN, 'req-1', { execution: { mode: 'AFTER_SALES', feeCny: 800 } }),
    ).rejects.toThrow('目标班次已停售或已起飞，请驳回后重新申请');
    expect(ordersStub.rescheduleOrderItem).not.toHaveBeenCalled();
  });

  it('非改班次申请传 execution → 400，一个通道都不碰', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });

    await expect(
      service.approve(ADMIN, 'req-1', { execution: { mode: 'AFTER_SALES', feeCny: 800 } }),
    ).rejects.toThrow(ORDER_CHANGE_EXECUTION_KIND_MESSAGE);
    expect(ordersStub.setOrderVisaStatus).not.toHaveBeenCalled();
    expect(ordersStub.rescheduleOrderItem).not.toHaveBeenCalled();
  });

  it('目标班次已停售 → 400 指路重提，申请留 PENDING', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched-new',
      isActive: false,
      departureTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(
      '目标班次已停售或已起飞，请驳回后重新申请',
    );
    expect(ordersStub.correctFlightSchedule).not.toHaveBeenCalled();
  });

  it('目标班次已起飞 → 400 指路重提', async () => {
    primeApprove(OrderChangeKind.FLIGHT, { itemId: 'item-out', newScheduleId: 'sched-new' });
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sched-new',
      isActive: true,
      departureTime: new Date(Date.now() - 60 * 60 * 1000),
    });

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(
      '目标班次已停售或已起飞，请驳回后重新申请',
    );
    expect(ordersStub.correctFlightSchedule).not.toHaveBeenCalled();
  });

  it('升舱补差变了 → 400 带新旧金额，不按新价扣钱', async () => {
    primeApprove(OrderChangeKind.CABIN, {
      itemId: 'item-out',
      toCabin: 'BUSINESS',
      diffCny: 4800,
    });
    // 现状：航班差价涨到 3000/程，2 人 → ¥6000
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      orderId: 'order-1',
      flightScheduleId: 'sched-out',
      hotelRoomTypeId: null,
      flightCabin: 'ECONOMY',
      quantity: 2,
      flightSchedule: { flight: { businessUpgradeCnyPerLeg: 3000 } },
    });

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(
      '升舱差价已变（申请时 ¥4,800，现 ¥6,000），请驳回后让代理重新提交',
    );
    expect(ordersStub.upgradeOrderItemCabin).not.toHaveBeenCalled();
  });

  it('升舱补差没变 → 照常执行', async () => {
    primeApprove(OrderChangeKind.CABIN, {
      itemId: 'item-out',
      toCabin: 'BUSINESS',
      diffCny: 4800,
    });
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      orderId: 'order-1',
      flightScheduleId: 'sched-out',
      hotelRoomTypeId: null,
      flightCabin: 'ECONOMY',
      quantity: 2,
      flightSchedule: { flight: { businessUpgradeCnyPerLeg: 2400 } },
    });
    ordersStub.upgradeOrderItemCabin.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {});
    expect(ordersStub.upgradeOrderItemCabin).toHaveBeenCalled();
  });

  it('换酒店 · 带星级放行原因 → 原样透给换酒店通道', async () => {
    primeApprove(OrderChangeKind.HOTEL, { itemId: 'item-hotel', toHotelRoomTypeId: 'room-new' });
    ordersStub.swapItemHotel.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {
      designatedHotelStarMismatchReason: '客人自愿降档，差额已线下退回',
    });

    expect(ordersStub.swapItemHotel).toHaveBeenCalledWith(
      'order-1',
      'item-hotel',
      expect.objectContaining({
        designatedHotelStarMismatchReason: '客人自愿降档，差额已线下退回',
      }),
      expect.anything(),
    );
  });

  it('订单早已是目标状态（上次执行成功但状态没回写）→ 不再执行一遍，备注写明', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });
    // 幂等判定读到的现状：签证状态已经是目标值
    mockPrisma.order.findUnique
      .mockResolvedValueOnce({ id: 'order-1', orderNumber: 'FTM2026090400001', deletedAt: null })
      .mockResolvedValueOnce({ visaStatus: VisaRequirement.NOT_NEEDED });

    await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.setOrderVisaStatus).not.toHaveBeenCalled();
    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'req-1', status: OrderChangeRequestStatus.PENDING },
        data: expect.objectContaining({
          status: OrderChangeRequestStatus.APPROVED,
          decisionNote: '已按申请内容生效（重试时发现已执行）',
        }),
      }),
    );
  });

  it('执行中的占位未过期 → 409，不重复执行', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        kind: OrderChangeKind.VISA,
        payload: {},
        summary: '摘要',
        status: OrderChangeRequestStatus.PENDING,
        requestedById: 'agent-user-1',
        decidedAt: new Date(Date.now() - 60 * 1000), // 1 分钟前占位，TTL 5 分钟内
      },
    ]);

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow('该申请正在处理中');
    expect(ordersStub.setOrderVisaStatus).not.toHaveBeenCalled();
  });

  it('占位超过 5 分钟 TTL → 允许重试执行', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        orderId: 'order-1',
        kind: OrderChangeKind.VISA,
        payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
        summary: '摘要',
        status: OrderChangeRequestStatus.PENDING,
        requestedById: 'agent-user-1',
        decidedAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    ]);
    ordersStub.setOrderVisaStatus.mockResolvedValue({ order: { id: 'order-1' } });

    await service.approve(ADMIN, 'req-1', {});
    expect(ordersStub.setOrderVisaStatus).toHaveBeenCalled();
  });

  it('收尾回写没命中 PENDING（并发驳回）→ 409 留声', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });
    ordersStub.setOrderVisaStatus.mockResolvedValue({ order: { id: 'order-1' } });
    mockPrisma.orderChangeRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow('申请状态已被其他操作改变');
  });

  it('收尾回写瞬时失败 → 重试后成功（订单已改完，不留脏队列）', async () => {
    primeApprove(OrderChangeKind.VISA, { toVisaStatus: VisaRequirement.NOT_NEEDED });
    ordersStub.setOrderVisaStatus.mockResolvedValue({ order: { id: 'order-1' } });
    mockPrisma.orderChangeRequest.updateMany
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ count: 1 });

    const res = await service.approve(ADMIN, 'req-1', {});
    expect(res.request.status).toBe(OrderChangeRequestStatus.APPROVED);
    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenCalledTimes(2);
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

  it('有人正在执行这条申请 → 驳回被拒 409（否则队列显示已驳回、订单却真改了）', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        status: OrderChangeRequestStatus.PENDING,
        decidedAt: new Date(Date.now() - 30 * 1000),
      },
    ]);

    await expect(service.reject(ADMIN, 'req-1', {})).rejects.toThrow('该申请正在执行中，请稍后刷新');
    expect(mockPrisma.orderChangeRequest.update).not.toHaveBeenCalled();
  });

  it('占位已过 TTL（上次执行挂了）→ 允许驳回', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'req-1',
        status: OrderChangeRequestStatus.PENDING,
        decidedAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    ]);
    mockPrisma.orderChangeRequest.update.mockResolvedValue(
      requestFixture({ status: OrderChangeRequestStatus.REJECTED }),
    );

    const { request } = await service.reject(ADMIN, 'req-1', {});
    expect(request.status).toBe(OrderChangeRequestStatus.REJECTED);
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

  it('代理可查已处理的申请 + since 只要这个时间之后的，决定备注照常回', async () => {
    const since = new Date('2026-09-01T00:00:00.000Z');
    mockPrisma.orderChangeRequest.findMany.mockResolvedValue([
      requestFixture({
        status: OrderChangeRequestStatus.REJECTED,
        decisionNote: '客人已确认不改',
      }),
    ]);

    const res = await service.list(AGENT, {
      status: OrderChangeRequestStatus.REJECTED,
      since,
      limit: 50,
    });

    expect(mockPrisma.orderChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: OrderChangeRequestStatus.REJECTED,
          createdAt: { gte: since },
        }),
      }),
    );
    expect(res.requests[0].decisionNote).toBe('客人已确认不改');
  });

  it('代理侧列表：换酒店的成本一律不给（costDeltaCny=null，payload 里也没有）', async () => {
    mockPrisma.orderChangeRequest.findMany.mockResolvedValue([
      requestFixture({
        kind: OrderChangeKind.HOTEL,
        payload: {
          itemId: 'item-hotel',
          toHotelRoomTypeId: 'room-new',
          costBeforeCny: 900,
          costAfterCny: 1200,
        },
      }),
    ]);

    const agentView = await service.list(AGENT, { limit: 50 });
    expect(agentView.requests[0].costDeltaCny).toBeNull();
    expect(agentView.requests[0].payload).not.toHaveProperty('costBeforeCny');

    const opsView = await service.list(ADMIN, { limit: 50 });
    expect(opsView.requests[0].costDeltaCny).toBe(300);
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
