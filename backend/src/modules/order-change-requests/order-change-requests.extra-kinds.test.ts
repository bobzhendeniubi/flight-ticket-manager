/**
 * 改单申请 · 扩展三类（拆单 / 取消单程 / 改自备签）单测。
 *
 * 与 order-change-requests.service.test.ts 分开：那份的 prisma mock 故意不铺
 * systemSetting delegate（flag 一律回落 false），正好证明「关着时基础四类分毫不动」；
 * 这份要来回切 flag，用的是另一套 mock。
 *
 * 覆盖：
 *   1. flag 关 → 三类提交 / 预检 / 批量一律 403 FEATURE_DISABLED，**代理与运营同拒**；
 *      基础四类不受影响。
 *   2. flag 开 → 归属闸、预检 blocker 当场拒、payload 与摘要形状。
 *   3. 确认分发到真实通道（参数逐个断言）、改自备签的岗位闸，
 *      以及「执行失败不留半状态」（撤占位 + 记 applyError + 状态仍是 PENDING）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrderChangeKind,
  OrderChangeRequestStatus,
  StaffRole,
  UserRole,
  VisaRequirement,
} from '@prisma/client';

const { mockPrisma, mockGetDescendantAgentIds } = vi.hoisted(() => ({
  mockPrisma: {
    agent: { findUnique: vi.fn() },
    order: { findUnique: vi.fn() },
    orderItem: { findUnique: vi.fn() },
    passenger: { findUnique: vi.fn(), findMany: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    systemSetting: { findUnique: vi.fn(), upsert: vi.fn() },
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

import { invalidateFeatureFlagCache } from '../../lib/feature-flags.js';
import {
  ORDER_CHANGE_BATCH_EXTRA_KIND_MESSAGE,
  ORDER_CHANGE_EXTRA_KIND_DISABLED_MESSAGE,
  ORDER_CHANGE_VISA_EXEMPT_DESK_ONLY_MESSAGE,
  OrderChangeRequestsService,
} from './order-change-requests.service.js';

const AGENT = { userId: 'agent-user-1', role: UserRole.AGENT };
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };
const VISA_DESK = { userId: 'staff-visa', role: UserRole.STAFF, staffRole: StaffRole.VISA_DESK };
const TICKETING = { userId: 'staff-tkt', role: UserRole.STAFF, staffRole: StaffRole.TICKETING };
/** 未设岗的通用运营：按口径也拒（改自备签只收在签证岗手里）。 */
const STAFF_NO_DESK = { userId: 'staff-plain', role: UserRole.STAFF, staffRole: null };

const AT = new Date('2026-09-04T00:00:00.000Z');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 2 人往返单（去程 QH0001 / 回程 QH0002，合成航班号，非真实班次）。 */
function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'FTM2026090400001',
    agentId: 'agent-1',
    deletedAt: null,
    status: 'PAID',
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
    ],
    ...overrides,
  };
}

const ROSTER = [
  { id: 'pax-1', orderId: 'order-1', fullName: 'WANG XIAO', chineseName: '王小', visaExempt: false },
  { id: 'pax-2', orderId: 'order-1', fullName: 'LI DA', chineseName: null, visaExempt: false },
];

function requestFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    orderId: 'order-1',
    agentId: 'agent-1',
    requestedById: 'agent-user-1',
    batchId: null,
    kind: OrderChangeKind.SPLIT,
    payload: {},
    summary: '摘要',
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

/** flag 开 / 关：改完必须清缓存 —— feature-flags 库有 60 秒进程内缓存。 */
function setFlag(enabled: boolean) {
  mockPrisma.systemSetting.findUnique.mockResolvedValue(enabled ? { value: 'true' } : null);
  invalidateFeatureFlagCache();
}

let ordersStub: {
  correctFlightSchedule: ReturnType<typeof vi.fn>;
  setOrderVisaStatus: ReturnType<typeof vi.fn>;
  swapItemHotel: ReturnType<typeof vi.fn>;
  upgradeOrderItemCabin: ReturnType<typeof vi.fn>;
  getOrder: ReturnType<typeof vi.fn>;
  previewOrderSplit: ReturnType<typeof vi.fn>;
  previewCancelLeg: ReturnType<typeof vi.fn>;
  splitOrder: ReturnType<typeof vi.fn>;
  cancelLeg: ReturnType<typeof vi.fn>;
  setPassengerVisaExempt: ReturnType<typeof vi.fn>;
};
let service: OrderChangeRequestsService;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateFeatureFlagCache();
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
  mockPrisma.order.findUnique.mockResolvedValue(orderFixture());
  mockPrisma.passenger.findMany.mockResolvedValue(ROSTER);
  mockPrisma.passenger.findUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) => ROSTER.find((p) => p.id === where.id) ?? null,
  );
  mockPrisma.orderChangeRequest.findFirst.mockResolvedValue(null);
  mockPrisma.orderChangeRequest.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => requestFixture(data),
  );
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockGetDescendantAgentIds.mockResolvedValue(['agent-1']);

  ordersStub = {
    correctFlightSchedule: vi.fn(),
    setOrderVisaStatus: vi.fn(),
    swapItemHotel: vi.fn(),
    upgradeOrderItemCabin: vi.fn(),
    getOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
    previewOrderSplit: vi.fn().mockResolvedValue({
      eligible: true,
      blockers: [],
      warnings: [],
      shares: [
        { passengerId: 'pax-1', fullName: 'WANG XIAO', shareCny: 5000 },
        { passengerId: 'pax-2', fullName: 'LI DA', shareCny: 5000 },
      ],
      movedShareCny: 5000,
    }),
    previewCancelLeg: vi.fn().mockResolvedValue({
      eligible: true,
      blockers: [],
      warnings: [],
      requiresAcknowledgement: false,
      returnItem: { flightNumber: 'QH0002', departDate: '2026-09-15' },
      policyFee: { policyName: '起飞前 7 天' },
      netReductionCny: 2800,
    }),
    splitOrder: vi.fn(),
    cancelLeg: vi.fn(),
    setPassengerVisaExempt: vi.fn(),
  };
  service = new OrderChangeRequestsService(ordersStub as never);
  setFlag(false);
});

// ── 1. flag 关：零行为变化 ───────────────────────────────────────────────────

describe('flag 关 · 三类一律 403，代理与运营同拒', () => {
  const cases: Array<[OrderChangeKind, Record<string, unknown>]> = [
    [OrderChangeKind.SPLIT, { passengerIds: ['pax-1'] }],
    [OrderChangeKind.CANCEL_LEG, { leg: 'RETURN' }],
    [OrderChangeKind.VISA_EXEMPT, { passengerId: 'pax-1', visaExempt: true }],
  ];

  for (const [kind, payload] of cases) {
    it(`${kind} · 代理提交 → 403 尚未开放，一条申请都不落`, async () => {
      await expect(service.create(AGENT, 'order-1', { kind, payload })).rejects.toThrow(
        ORDER_CHANGE_EXTRA_KIND_DISABLED_MESSAGE,
      );
      expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
    });

    it(`${kind} · 运营代提也 403（只拦代理等于关着还留了一条能走通的路）`, async () => {
      await expect(service.create(ADMIN, 'order-1', { kind, payload })).rejects.toThrow(
        ORDER_CHANGE_EXTRA_KIND_DISABLED_MESSAGE,
      );
      expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
    });

    it(`${kind} · 预检也 403，不给探底`, async () => {
      await expect(service.previewExtraKind(AGENT, 'order-1', kind, payload)).rejects.toThrow(
        ORDER_CHANGE_EXTRA_KIND_DISABLED_MESSAGE,
      );
    });
  }

  it('403 带稳定 code FEATURE_DISABLED，前端不靠中文文案判', async () => {
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.SPLIT,
        payload: { passengerIds: ['pax-1'] },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FEATURE_DISABLED' });
  });

  it('可用类型只回基础四类', async () => {
    await expect(service.availableKinds(AGENT)).resolves.toEqual({
      kinds: [
        OrderChangeKind.FLIGHT,
        OrderChangeKind.VISA,
        OrderChangeKind.HOTEL,
        OrderChangeKind.CABIN,
      ],
    });
  });

  it('基础四类分毫不受影响（关着 = 零行为变化）', async () => {
    await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.VISA,
      payload: { toVisaStatus: VisaRequirement.NOT_NEEDED },
    });
    expect(mockPrisma.orderChangeRequest.create).toHaveBeenCalledTimes(1);
  });
});

// ── 2. flag 开：提交 ─────────────────────────────────────────────────────────

describe('flag 开 · 提交', () => {
  beforeEach(() => setFlag(true));

  it('可用类型多出三项', async () => {
    const { kinds } = await service.availableKinds(AGENT);
    expect(kinds).toContain(OrderChangeKind.SPLIT);
    expect(kinds).toContain(OrderChangeKind.CANCEL_LEG);
    expect(kinds).toContain(OrderChangeKind.VISA_EXEMPT);
  });

  it('代理拿别家订单提 → 403，且不跑预检（blockers 文案不能当探针）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderFixture({ agentId: 'agent-other' }));
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.SPLIT,
        payload: { passengerIds: ['pax-1'] },
      }),
    ).rejects.toThrow('只能对自己名下的订单提交改单申请');
    expect(ordersStub.previewOrderSplit).not.toHaveBeenCalled();
  });

  it('拆单 → 复用拆单自己的只读预检当准入闸，blockers 原样回给提交方且不落申请', async () => {
    ordersStub.previewOrderSplit.mockResolvedValue({
      eligible: false,
      blockers: ['本单佣金已进结算流程，请财务先处理后再拆。'],
      warnings: [],
      shares: [],
      movedShareCny: 0,
    });
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.SPLIT,
        payload: { passengerIds: ['pax-1'] },
      }),
    ).rejects.toThrow('本单佣金已进结算流程，请财务先处理后再拆。');
    expect(mockPrisma.orderChangeRequest.create).not.toHaveBeenCalled();
  });

  it('拆单 → payload 记人 + 提交这一刻就定死 requestToken，摘要是人话', async () => {
    await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.SPLIT,
      payload: { passengerIds: ['pax-1'], note: ' 客人分开走 ' },
    });
    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload.passengerIds).toEqual(['pax-1']);
    expect(data.payload.note).toBe('客人分开走');
    // token 在提交时生成：确认被点两次时靠它回放，绝不拆出第二张单
    expect(String(data.payload.requestToken)).toMatch(UUID_RE);
    expect(data.summary).toBe('拆出 1 人：王小');
    expect(ordersStub.splitOrder).not.toHaveBeenCalled();
  });

  it('拆单 → 全员都勾等于整单转移，拒', async () => {
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.SPLIT,
        payload: { passengerIds: ['pax-1', 'pax-2'] },
      }),
    ).rejects.toThrow('至少要留 1 位乘客在原订单');
  });

  it('取消单程 → 记航段与班次，摘要写明按取消政策，payload 里没有任何金额字段', async () => {
    await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.CANCEL_LEG,
      payload: { leg: 'RETURN' },
    });
    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toMatchObject({
      leg: 'RETURN',
      itemId: 'item-ret',
      flightNo: 'QH0002',
      departureLocal: '2026-09-15',
    });
    expect(Object.keys(data.payload)).not.toContain('refundCny');
    expect(data.summary).toBe('取消回程 QH0002 2026-09-15（退款按取消政策计算）');
  });

  it('取消单程 → 本单有已释放航段就一律拒，绝不猜落到另一段上', async () => {
    const base = orderFixture();
    mockPrisma.order.findUnique.mockResolvedValue(
      orderFixture({
        items: [
          base.items[0],
          { ...base.items[1], flightScheduleId: null, flightSchedule: null },
        ],
      }),
    );
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.CANCEL_LEG,
        payload: { leg: 'RETURN' },
      }),
    ).rejects.toThrow('该航段座位已释放，无法按航段申请');
  });

  it('改自备签 → 记人 + 目标值 + 原值快照', async () => {
    await service.create(AGENT, 'order-1', {
      kind: OrderChangeKind.VISA_EXEMPT,
      payload: { passengerId: 'pax-1', visaExempt: true },
    });
    const data = mockPrisma.orderChangeRequest.create.mock.calls[0][0].data;
    expect(data.payload).toMatchObject({
      passengerId: 'pax-1',
      visaExempt: true,
      fromVisaExempt: false,
    });
    expect(data.summary).toBe('王小 改为自备签');
  });

  it('改自备签 → 目标值与现值相同 = 什么都没发生，拒', async () => {
    await expect(
      service.create(AGENT, 'order-1', {
        kind: OrderChangeKind.VISA_EXEMPT,
        payload: { passengerId: 'pax-1', visaExempt: false },
      }),
    ).rejects.toThrow('已经是「随团办签」');
  });

  it('三类都不进批量：一批单套同一份 payload 必然张冠李戴', async () => {
    await expect(
      service.createBatch(AGENT, {
        orderIds: ['order-1', 'order-2'],
        kind: OrderChangeKind.CANCEL_LEG,
        payload: { leg: 'RETURN' },
      }),
    ).rejects.toThrow(ORDER_CHANGE_BATCH_EXTRA_KIND_MESSAGE);
  });
});

// ── 3. 预检端点 ─────────────────────────────────────────────────────────────

describe('flag 开 · 预检端点', () => {
  beforeEach(() => setFlag(true));

  it('取消单程 → 回预估退款与政策名，供合作方端展示', async () => {
    const res = await service.previewExtraKind(AGENT, 'order-1', OrderChangeKind.CANCEL_LEG, {
      leg: 'RETURN',
    });
    expect(res.eligible).toBe(true);
    expect(res.cancelLeg).toMatchObject({
      leg: 'RETURN',
      legLabel: '回程',
      flightNumber: 'QH0002',
      departDate: '2026-09-15',
      refundCny: 2800,
      policyName: '起飞前 7 天',
    });
    expect(res.split).toBeNull();
  });

  it('拆单 → 回每人份额与随拆搬走的份额', async () => {
    const res = await service.previewExtraKind(AGENT, 'order-1', OrderChangeKind.SPLIT, {
      passengerIds: ['pax-1'],
    });
    expect(res.split).toMatchObject({ movedShareCny: 5000 });
    expect(res.split?.shares).toHaveLength(2);
  });

  it('基础四类没有预检可跑', async () => {
    await expect(
      service.previewExtraKind(AGENT, 'order-1', OrderChangeKind.VISA, {
        toVisaStatus: VisaRequirement.NOT_NEEDED,
      }),
    ).rejects.toThrow('该改单类型不需要预检');
  });
});

// ── 4. 确认执行 ─────────────────────────────────────────────────────────────

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
  mockPrisma.orderChangeRequest.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.orderChangeRequest.findUniqueOrThrow.mockResolvedValue(
    requestFixture({ kind, payload, status: OrderChangeRequestStatus.APPROVED, appliedAt: AT }),
  );
}

const SPLIT_PAYLOAD = {
  passengerIds: ['pax-1'],
  requestToken: '11111111-1111-4111-8111-111111111111',
  note: '客人分开走',
};
const CANCEL_PAYLOAD = {
  leg: 'RETURN',
  itemId: 'item-ret',
  requestToken: '22222222-2222-4222-8222-222222222222',
  note: null,
};
const VISA_EXEMPT_PAYLOAD = { passengerId: 'pax-1', visaExempt: true, fromVisaExempt: false };

const SPLIT_RESULT = {
  sourceOrderId: 'order-1',
  sourceOrderNumber: 'FTM2026090400001',
  targetOrderId: 'order-2',
  targetOrderNumber: 'FTM2026090400002',
  movedShareCny: 5000,
  movedPaidCny: 5000,
  passengerCount: 1,
  replayed: false,
};

describe('approve() · 分发到真实通道', () => {
  beforeEach(() => setFlag(true));

  it('拆单 → 调 splitOrder，带提交时那个 token，混合房组不自动劈半', async () => {
    primeApprove(OrderChangeKind.SPLIT, SPLIT_PAYLOAD);
    ordersStub.splitOrder.mockResolvedValue(SPLIT_RESULT);

    const res = await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.splitOrder).toHaveBeenCalledWith(
      'order-1',
      {
        passengerIds: ['pax-1'],
        requestToken: '11111111-1111-4111-8111-111111111111',
        note: '客人分开走',
        autoSplitRoomGroups: false,
      },
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
    expect(res.request.status).toBe(OrderChangeRequestStatus.APPROVED);
    // 新单号要写进决定备注，否则代理只知道「批了」，不知道人被拆到哪张单上
    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'req-1', status: OrderChangeRequestStatus.PENDING },
        data: expect.objectContaining({
          status: OrderChangeRequestStatus.APPROVED,
          decisionNote: '已拆出新单 FTM2026090400002（1 人）',
        }),
      }),
    );
  });

  it('取消单程 → 调 cancelLeg，feeMode 恒 POLICY，申请里给不出手工金额', async () => {
    primeApprove(OrderChangeKind.CANCEL_LEG, CANCEL_PAYLOAD);
    ordersStub.cancelLeg.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.cancelLeg).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({
        leg: 'RETURN',
        feeMode: 'POLICY',
        requestToken: '22222222-2222-4222-8222-222222222222',
        acknowledgeWarnings: false,
      }),
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
    const passed = ordersStub.cancelLeg.mock.calls[0][1];
    expect(passed).not.toHaveProperty('manualRefundCny');
    expect(passed).not.toHaveProperty('manualFeeCny');
  });

  it('取消单程 → 运营勾了「我已知悉」才透传 acknowledgeWarnings', async () => {
    primeApprove(OrderChangeKind.CANCEL_LEG, CANCEL_PAYLOAD);
    ordersStub.cancelLeg.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', { acknowledgeWarnings: true });

    expect(ordersStub.cancelLeg.mock.calls[0][1].acknowledgeWarnings).toBe(true);
  });

  it('改自备签 → 管理员可确认，调 setPassengerVisaExempt', async () => {
    primeApprove(OrderChangeKind.VISA_EXEMPT, VISA_EXEMPT_PAYLOAD);
    ordersStub.setPassengerVisaExempt.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(ADMIN, 'req-1', {});

    expect(ordersStub.setPassengerVisaExempt).toHaveBeenCalledWith(
      'order-1',
      'pax-1',
      { visaExempt: true, note: '改单申请（运营确认）' },
      { userId: 'admin-1', role: UserRole.ADMIN, agentId: undefined },
    );
  });

  it('改自备签 → 签证岗可确认', async () => {
    primeApprove(OrderChangeKind.VISA_EXEMPT, VISA_EXEMPT_PAYLOAD);
    ordersStub.setPassengerVisaExempt.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(VISA_DESK, 'req-1', {});

    expect(ordersStub.setPassengerVisaExempt).toHaveBeenCalledTimes(1);
  });

  for (const [label, actor] of [
    ['票务岗', TICKETING],
    ['未设岗的通用运营', STAFF_NO_DESK],
  ] as const) {
    it(`改自备签 → ${label}确认 403，且不留「处理中」死占位`, async () => {
      primeApprove(OrderChangeKind.VISA_EXEMPT, VISA_EXEMPT_PAYLOAD);

      await expect(service.approve(actor, 'req-1', {})).rejects.toThrow(
        ORDER_CHANGE_VISA_EXEMPT_DESK_ONLY_MESSAGE,
      );
      expect(ordersStub.setPassengerVisaExempt).not.toHaveBeenCalled();
      // 判岗抛在 claim 事务里、占位之前 → 一次占位写入都不该发生
      expect(mockPrisma.orderChangeRequest.update).not.toHaveBeenCalled();
    });
  }

  it('其它两类不判岗：票务岗照样能确认取消单程', async () => {
    primeApprove(OrderChangeKind.CANCEL_LEG, CANCEL_PAYLOAD);
    ordersStub.cancelLeg.mockResolvedValue({ order: { id: 'order-1' }, audit: {} });

    await service.approve(TICKETING, 'req-1', {});

    expect(ordersStub.cancelLeg).toHaveBeenCalledTimes(1);
  });

  it('执行失败 → 撤占位、记 applyError、状态仍是 PENDING（不留半状态）', async () => {
    primeApprove(OrderChangeKind.SPLIT, SPLIT_PAYLOAD);
    ordersStub.splitOrder.mockRejectedValue(new Error('本单有进行中的退款，请先完成或驳回'));

    await expect(service.approve(ADMIN, 'req-1', {})).rejects.toThrow(
      '本单有进行中的退款，请先完成或驳回',
    );

    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'req-1', status: OrderChangeRequestStatus.PENDING, appliedAt: null },
      data: {
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
        applyError: '本单有进行中的退款，请先完成或驳回',
      },
    });
    // 绝不能翻成 APPROVED
    const wroteApproved = mockPrisma.orderChangeRequest.updateMany.mock.calls.some(
      (c: [{ data?: { status?: unknown } }]) =>
        c[0]?.data?.status === OrderChangeRequestStatus.APPROVED,
    );
    expect(wroteApproved).toBe(false);
  });

  it('拆单幂等回放 → 备注写明「本次未再拆」，不当成新拆一次', async () => {
    primeApprove(OrderChangeKind.SPLIT, SPLIT_PAYLOAD);
    ordersStub.splitOrder.mockResolvedValue({ ...SPLIT_RESULT, replayed: true });

    await service.approve(ADMIN, 'req-1', {});

    expect(mockPrisma.orderChangeRequest.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          decisionNote: '已拆出新单 FTM2026090400002（重试时发现已拆过，本次未再拆）',
        }),
      }),
    );
  });
});

describe('reject() · 三类扩展照旧，不判岗', () => {
  beforeEach(() => setFlag(true));

  it('票务岗可以驳回改自备签申请（驳回不动订单）', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 'req-1', status: OrderChangeRequestStatus.PENDING, decidedAt: null },
    ]);
    mockPrisma.orderChangeRequest.update.mockResolvedValue(
      requestFixture({
        kind: OrderChangeKind.VISA_EXEMPT,
        status: OrderChangeRequestStatus.REJECTED,
      }),
    );

    const res = await service.reject(TICKETING, 'req-1', { decisionNote: '客人没提供签证页' });

    expect(res.request.status).toBe(OrderChangeRequestStatus.REJECTED);
    expect(ordersStub.setPassengerVisaExempt).not.toHaveBeenCalled();
  });
});
