/**
 * OrderService.requestCancellation · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 和 computeCancellationQuote 替换成可控的 fixture，
 * 不依赖真 DB。覆盖 3 条最关键的分支：
 *   1. 订单不存在 → NotFoundError
 *   2. 客户权限：尝试取消别人的订单 → ForbiddenError
 *   3. 幂等：已有 REQUESTED 退款 → 返回 isNew=false（不再创建第二条）
 *
 * 不覆盖（需要 stage 多层 transaction 调用，超出本次范围）：
 *   - 完整 happy path（创建 Refund + 状态流转）—— 真集成测试该用 testDB
 *   - quote.cancellable=false 的 BadRequestError —— 算法已在 cancellation.test.ts 测过
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 在 import OrderService 之前 mock 依赖 ──
// vi.mock 会被 hoist 到文件顶部，所以引用的变量也得 hoist
const { mockPrisma, mockComputeQuote, mockGetHotelNightlyRemaining } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    passenger: {
      findMany: vi.fn(),
      // findUnique/update/findUniqueOrThrow/findFirst: 只有 swapPassenger 的换人测试用（其余既有测试
      // 不碰这几个方法，新增不影响它们）。findFirst = 换人重复证件号校验（P1-8）。
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    // swapPassenger 换人重复证件号校验：查本订单 FLIGHT 行的 flightScheduleId（P1-8）。
    orderItem: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    agent: {
      findUnique: vi.fn(),
    },
    hotelRoomType: {
      findUnique: vi.fn(),
    },
    bundle: {
      findUnique: vi.fn(),
    },
    // priceAndValidateItems 的 FLIGHT 分支走 PricingService.calculatePrice（真实动态定价，非 mock
    // 出来的 stub）——它也是从 '../../db/prisma.js' 拿 prisma 单例，这里的 mock 全局生效。
    // Bug 2a（metadata.businessUpgradeCount 伪造）测试需要一条最小可用的 FlightSeatClass +
    // DateRanking 查询链（固定底价模式：不配仓位阶梯，走 round(basePrice) 分支）。
    flightSeatClass: {
      findFirst: vi.fn(),
    },
    dateRanking: {
      findUnique: vi.fn(),
    },
    // getOrder 的 loadBundleVisaStayDays 用它批量查套餐 VISA 组件的 stayDays（不 mock 时默认
    // undefined，调用即抛错——loadBundleVisaStayDays 有 try/catch best-effort 降级，不影响
    // 既有未涉及签证的测试；专门测 visa 板块的用例会显式 mock 这个方法）。
    visa: {
      findMany: vi.fn(),
      // priceAndValidateItems 的 VISA 分支按产品查权威价 + 加急档位表（expressTiers）。
      findUnique: vi.fn(),
    },
    // swapPassenger 内部用 prisma.$transaction(async (tx) => {...})；tx 复用同一批 mock 方法
    // （swapPassenger 事务体只碰 order/passenger/fulfillmentTask，这里按需最小补齐）。
    fulfillmentTask: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
    // R2：rescheduleOrderItem 事务开头对 Order 行 FOR UPDATE（tx.$queryRaw）。默认返回一行（订单存在）
    // → 锁通过、继续走占座守卫；具体守卫用例仍由 order.findUnique 决定拒绝原因。
    $queryRaw: vi.fn(async () => [{ id: 'ord1' }]),
  },
  mockComputeQuote: vi.fn(),
  mockGetHotelNightlyRemaining: vi.fn(),
}));

// tx 对象与 mockPrisma 共享同一批 vi.fn()（swapPassenger 事务内 tx.order/tx.passenger/tx.fulfillmentTask
// 与事务外的 prisma.order/passenger 调用互不区分，测试只需断言最终调用记录）。
const mockTx = mockPrisma;

vi.mock('../../db/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../lib/cancellation.js', () => ({
  computeCancellationQuote: mockComputeQuote,
}));

vi.mock('../hotel-control/hotel-control.service.js', () => ({
  getHotelNightlyRemaining: mockGetHotelNightlyRemaining,
}));

// 现在才能 import service
import {
  OrderService,
  assertVisaPassengersHavePassportExpiry,
  resolveBundleHotelStamp,
  computeBundleAddOn,
  resolveBundleBusinessUpgradeRate,
  resolveBundleBusinessUpgradeInput,
  computeBundleSeatSplit,
  computeRequiredPassengerCount,
  resolveBundleOccupancy,
  computeRoomsNeeded,
  computeBundleRoomsCharged,
  toProspectiveOccupancy,
  computeBundleOperationFeeTotal,
  derivePerPaxBundleOptions,
  passengerToData,
  createFulfillmentTasks,
  resolveOrderAgentId,
  buildStayNightDates,
  summarizeBundleItems,
  deriveBundlePerAgeUnitPrices,
  buildOrderFilterWhere,
  resolveHasReturnLeg,
  splitSearchTerms,
  filterOrderIdsByDepartDate,
  assertDisplayedTotalMatches,
  computeGroundItemAmounts,
  resolveGroundItemUnitPrice,
} from './orders.service.js';
import { PriceChangedError } from '../../lib/errors.js';
import type { OrderItemInput } from './orders.schemas.js';
import {
  batchCreateOrdersBodySchema,
  createOrderBodySchema,
  swapItemHotelBodySchema,
  swapPassengerBodySchema,
} from './orders.schemas.js';

// ── Fixture helper：build 一个完整的 fake order（serializeOrder 要的字段全有） ──
const dec = (n: number) => ({ toString: () => String(n) });
function fakeFullOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord1',
    orderNumber: 'ORD-001',
    userId: 'me',
    agentId: null,
    status: 'PAID',
    subtotal: dec(100),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(100),
    paidAmount: dec(100),
    prepaymentOffset: dec(0),
    totalAmount: dec(100),
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
    user: { id: 'me', displayName: null, email: null },
    ...overrides,
  };
}

describe('OrderService.requestCancellation', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('订单不存在 → 抛 NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);

    await expect(
      service.requestCancellation('nonexistent-id', 'reason', {
        userId: 'u1',
        role: 'CUSTOMER',
        agentId: undefined,
      }),
    ).rejects.toThrow(/不存在/);
  });

  it('客户尝试取消别人的订单 → 抛 ForbiddenError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'ord1',
      userId: 'other-user',
      agentId: null,
      refunds: [],
    });

    await expect(
      service.requestCancellation('ord1', undefined, {
        userId: 'me',
        role: 'CUSTOMER',
        agentId: undefined,
      }),
    ).rejects.toThrow(/无权/);

    // 关键：根本没走到 quote 计算
    expect(mockComputeQuote).not.toHaveBeenCalled();
  });

  it('幂等：已有 pending Refund → 返回 isNew=false，不再创建', async () => {
    const existingRefund = { id: 'ref-existing', status: 'REQUESTED', amount: '100' };

    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      userId: 'me',
      agentId: null,
      refunds: [existingRefund], // 已有 pending 退款
    });

    // mock findUniqueOrThrow（service 内部的二次查）
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(
      fakeFullOrder({ refunds: [existingRefund] }),
    );

    mockComputeQuote.mockResolvedValue({
      orderId: 'ord1',
      orderNumber: 'ORD-001',
      paidAmount: 100,
      totalFee: 30,
      totalRefund: 70,
      items: [],
      cancellable: true,
    });

    const r = await service.requestCancellation('ord1', undefined, {
      userId: 'me',
      role: 'CUSTOMER',
      agentId: undefined,
    });

    expect(r.isNew).toBe(false);
    expect(r.refund).toBe(existingRefund);
    // 关键：service 不应该走 prisma.refund.create — 因为已经有 pending refund
    expect(mockComputeQuote).toHaveBeenCalledTimes(1); // 只为重算最新报价
  });

  it('ADMIN 角色绕过 owner 检查（即使不是订单 owner 也能调）', async () => {
    const existingRefund = { id: 'ref-1', status: 'REQUESTED', amount: '100' };

    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      userId: 'someone-else',
      agentId: null,
      refunds: [existingRefund],
    });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(
      fakeFullOrder({
        userId: 'someone-else',
        refunds: [existingRefund],
        user: { id: 'someone-else', displayName: null, email: null },
      }),
    );
    mockComputeQuote.mockResolvedValue({
      orderId: 'ord1',
      orderNumber: 'ORD-001',
      paidAmount: 100,
      totalFee: 30,
      totalRefund: 70,
      items: [],
      cancellable: true,
    });

    // ADMIN 应该能调通，不抛 Forbidden
    const r = await service.requestCancellation('ord1', undefined, {
      userId: 'admin-id',
      role: 'ADMIN',
      agentId: undefined,
    });
    expect(r.isNew).toBe(false);
  });

  it('客户取消自己的订单（happy 权限路径）→ 不抛 Forbidden', async () => {
    const existingRefund = { id: 'ref-1', status: 'REQUESTED', amount: '100' };

    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      userId: 'me',
      agentId: null,
      refunds: [existingRefund],
    });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(
      fakeFullOrder({ refunds: [existingRefund] }),
    );
    mockComputeQuote.mockResolvedValue({
      orderId: 'ord1',
      orderNumber: 'ORD-001',
      paidAmount: 100,
      totalFee: 30,
      totalRefund: 70,
      items: [],
      cancellable: true,
    });

    const r = await service.requestCancellation('ord1', '不去了', {
      userId: 'me',
      role: 'CUSTOMER',
      agentId: undefined,
    });
    expect(r.isNew).toBe(false);
    expect(r.order).toBeDefined();
    expect(r.quote.totalRefund).toBe(70);
  });
});

// ── 重复乘客校验：同班次占座订单中证件号查重 ─────────────────────────────
describe('OrderService 重复乘客校验', () => {
  const service = new OrderService();

  const fakePassenger = (documentNumber: string, fullName = '张三') => ({
    fullName,
    documentType: 'PASSPORT' as const,
    documentNumber,
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    // 新建路径护照有效期必填（批量 schema / 后台录单 service 校验同口径）
    passportExpiry: '2031-01-01',
  });

  const flightItem = {
    kind: 'FLIGHT' as const,
    description: 'QH9589 澳门→岘港 经济舱',
    quantity: 1,
    flightScheduleId: 'sched-1',
    flightCabin: 'ECONOMY' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createOrder：证件号已在同班次占座订单中 → BadRequestError 列出证件号+冲突订单号', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([
      { documentNumber: 'E12345678', order: { orderNumber: 'FTM-TEST-001' } },
      { documentNumber: 'E12345678', order: { orderNumber: 'FTM-TEST-002' } },
    ]);

    let thrown: Error | undefined;
    try {
      await service.createOrder(
        {
          contactName: '联系人',
          contactPhone: '13800000000',
          items: [flightItem],
          passengers: [fakePassenger('E12345678')],
        },
        { userId: 'u1', role: 'CUSTOMER' },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('E12345678');
    expect(thrown!.message).toContain('FTM-TEST-001');
    expect(thrown!.message).toContain('FTM-TEST-002');

    // 查重条件：同班次 + 占座状态 + 证件号 in
    expect(mockPrisma.passenger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          documentNumber: { in: ['E12345678'] },
          order: expect.objectContaining({
            items: { some: { flightScheduleId: { in: ['sched-1'] } } },
          }),
        }),
      }),
    );
  });

  it('查重无命中 → 校验通过（返回空冲突数组，不抛重复错误）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    // 直接调私有校验方法：通过 = resolve 空数组，不抛
    await expect(
      (service as unknown as {
        assertNoDuplicatePassengersOnFlights(
          s: string[],
          d: string[],
          allow?: boolean,
        ): Promise<unknown[]>;
      }).assertNoDuplicatePassengersOnFlights(['sched-1'], ['E12345678']),
    ).resolves.toEqual([]);
  });

  it('无 FLIGHT 班次（纯酒店/签证单）→ 跳过查重，不查库', async () => {
    await (service as unknown as {
      assertNoDuplicatePassengersOnFlights(
        s: string[],
        d: string[],
        allow?: boolean,
      ): Promise<unknown[]>;
    }).assertNoDuplicatePassengersOnFlights([], ['E12345678']);
    expect(mockPrisma.passenger.findMany).not.toHaveBeenCalled();
  });

  it('batchCreateOrders：名单内证件号重复 → 整批拒绝，且不查库', async () => {
    await expect(
      service.batchCreateOrders(
        {
          flightScheduleId: 'sched-1',
          flightCabin: 'ECONOMY',
          description: 'QH9589 澳门→岘港',
          contactName: '联系人',
          contactPhone: '13800000000',
          passengers: [fakePassenger('E12345678', '张三'), fakePassenger('E12345678', '李四')],
        },
        { userId: 'u1', role: 'STAFF' },
      ),
    ).rejects.toThrow(/名单内证件号重复.*E12345678/);
    expect(mockPrisma.passenger.findMany).not.toHaveBeenCalled();
  });

  it('batchCreateOrders：名单与同班次占座订单冲突 → 整批拒绝（不建任何单）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([
      { documentNumber: 'G88888888', order: { orderNumber: 'FTM-TEST-009' } },
    ]);

    await expect(
      service.batchCreateOrders(
        {
          flightScheduleId: 'sched-1',
          flightCabin: 'ECONOMY',
          description: 'QH9589 澳门→岘港',
          contactName: '联系人',
          contactPhone: '13800000000',
          passengers: [fakePassenger('E12345678'), fakePassenger('G88888888', '王五')],
        },
        { userId: 'u1', role: 'STAFF' },
      ),
    ).rejects.toThrow(/G88888888.*FTM-TEST-009/);
  });

  it('batchCreateOrders：不传 contactName → 联系人=本单乘客本人（B9：不再冒充录单员）', async () => {
    // 无重复 → 进入逐单建单
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    // 登录用户：录入人 = 王操作（displayName）——只作电话兜底，不再落 contactName
    mockPrisma.user.findUnique.mockResolvedValue({
      displayName: '王操作',
      email: 'op@example.com',
      phone: '13900000000',
    });
    // 隔离 createOrder：断言子单联系人是乘客本人（每人一单，「联系人」回答的是找哪个客人）
    const createSpy = vi
      .spyOn(service, 'createOrder')
      .mockResolvedValue({ id: 'ord-1', orderNumber: 'FTM-001' } as never);

    const result = await service.batchCreateOrders(
      {
        flightScheduleId: 'sched-1',
        flightCabin: 'ECONOMY',
        description: 'QH9589 澳门→岘港',
        // 注意：不传 contactName / contactPhone
        passengers: [fakePassenger('E12345678', '张三')],
      },
      { userId: 'u1', role: 'STAFF' },
    );

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { displayName: true, email: true, phone: true },
    });
    // B9 口径：contactName=本单乘客姓名；contactPhone 系统不采集乘客电话 → 录入人电话兜底
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ contactName: '张三', contactPhone: '13900000000' }),
      { userId: 'u1', role: 'STAFF' },
    );
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
    createSpy.mockRestore();
  });

  it('batchCreateOrders：显式传 contactName 时覆盖登录账号（兼容旧前端）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockResolvedValue({
      displayName: '王操作',
      email: null,
      phone: '13900000000',
    });
    const createSpy = vi
      .spyOn(service, 'createOrder')
      .mockResolvedValue({ id: 'ord-2', orderNumber: 'FTM-002' } as never);

    await service.batchCreateOrders(
      {
        flightScheduleId: 'sched-1',
        flightCabin: 'ECONOMY',
        description: 'QH9589 澳门→岘港',
        contactName: '指定联系人',
        contactPhone: '13800000000',
        passengers: [fakePassenger('E12345678', '张三')],
      },
      { userId: 'u1', role: 'STAFF' },
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ contactName: '指定联系人', contactPhone: '13800000000' }),
      { userId: 'u1', role: 'STAFF' },
    );
    createSpy.mockRestore();
  });

  // ── 团队议价结算价 + 团期备注 ──────────────────────────────────────────
  it('batchCreateOrders：传 settlementPriceCny → 每张子单注入 flightSettlementPriceCny（覆盖机票价）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: '王操作', email: null, phone: '139' });
    const createSpy = vi
      .spyOn(service, 'createOrder')
      .mockResolvedValue({ id: 'ord-1', orderNumber: 'FTM-001' } as never);

    await service.batchCreateOrders(
      {
        flightScheduleId: 'sched-1',
        flightCabin: 'ECONOMY',
        description: 'QH9589 澳门→岘港',
        settlementPriceCny: 1500,
        groupNote: '0701团 20人',
        passengers: [fakePassenger('E12345678', '张三'), fakePassenger('E22222222', '李四')],
      },
      { userId: 'u1', role: 'STAFF' },
    );

    // 每张子单都带上议价结算价；FLIGHT 行 quantity 仍是 1（扣座不受影响）
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        flightSettlementPriceCny: 1500,
        items: [expect.objectContaining({ kind: 'FLIGHT', quantity: 1, flightScheduleId: 'sched-1' })],
      }),
      { userId: 'u1', role: 'STAFF' },
    );
    createSpy.mockRestore();
  });

  it('batchCreateOrders：groupNote 合并进 notes + noteSpecial', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: '王操作', email: null, phone: '139' });
    const createSpy = vi
      .spyOn(service, 'createOrder')
      .mockResolvedValue({ id: 'ord-1', orderNumber: 'FTM-001' } as never);

    await service.batchCreateOrders(
      {
        flightScheduleId: 'sched-1',
        flightCabin: 'ECONOMY',
        description: 'QH9589 澳门→岘港',
        notes: '已收定金',
        groupNote: '0701团 20人',
        passengers: [fakePassenger('E12345678', '张三')],
      },
      { userId: 'u1', role: 'STAFF' },
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: '已收定金 · 0701团 20人',
        noteSpecial: '0701团 20人',
      }),
      { userId: 'u1', role: 'STAFF' },
    );
    createSpy.mockRestore();
  });

  it('batchCreateOrders：不传 settlementPriceCny → 子单 flightSettlementPriceCny=undefined（走动态价）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: '王操作', email: null, phone: '139' });
    const createSpy = vi
      .spyOn(service, 'createOrder')
      .mockResolvedValue({ id: 'ord-1', orderNumber: 'FTM-001' } as never);

    await service.batchCreateOrders(
      {
        flightScheduleId: 'sched-1',
        flightCabin: 'ECONOMY',
        description: 'QH9589 澳门→岘港',
        passengers: [fakePassenger('E12345678', '张三')],
      },
      { userId: 'u1', role: 'STAFF' },
    );

    const arg = createSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.flightSettlementPriceCny).toBeUndefined();
    createSpy.mockRestore();
  });

  // ── schema 守卫：结算价 ≥ 0 且封顶 ───────────────────────────────────────
  it('batchCreateOrdersBodySchema：结算价负数 / 超上限 → 校验失败；合法值通过', () => {
    const base = {
      flightScheduleId: 'sched-1',
      flightCabin: 'ECONOMY' as const,
      description: 'QH9589',
      passengers: [fakePassenger('E12345678', '张三')],
    };
    expect(batchCreateOrdersBodySchema.safeParse({ ...base, settlementPriceCny: -1 }).success).toBe(false);
    expect(batchCreateOrdersBodySchema.safeParse({ ...base, settlementPriceCny: 999999999 }).success).toBe(false);
    expect(batchCreateOrdersBodySchema.safeParse({ ...base, settlementPriceCny: 1500 }).success).toBe(true);
    // 缺省（不传）仍合法 → 走旧动态定价路径
    expect(batchCreateOrdersBodySchema.safeParse(base).success).toBe(true);
  });
});

// ── 套餐酒店盖章：resolveBundleHotelStamp ─────────────────────────────
// 第 3 参 nights = 调用方按 resolveBundleNights 解析的单一权威晚数（不再从 bundle 内部读 hotelNights）。
describe('resolveBundleHotelStamp', () => {
  const linkedBundle = { hotelRoomTypeId: 'rt1' };

  it('套餐没关联房型 → null', () => {
    expect(
      resolveBundleHotelStamp({ hotelRoomTypeId: null }, { goDate: '2026-07-01' }, 3),
    ).toBeNull();
  });

  it('goDate 缺失 → null（不盖章，不抛错）', () => {
    expect(resolveBundleHotelStamp(linkedBundle, undefined, 3)).toBeNull();
    expect(resolveBundleHotelStamp(linkedBundle, {}, 3)).toBeNull();
  });

  it('returnDate 合法且晚于 goDate → 用 returnDate 做退房日', () => {
    const stamp = resolveBundleHotelStamp(
      linkedBundle,
      { goDate: '2026-07-01', returnDate: '2026-07-04' },
      3,
    );
    expect(stamp).toEqual({
      hotelRoomTypeId: 'rt1',
      hotelCheckIn: new Date('2026-07-01'),
      hotelCheckOut: new Date('2026-07-04'),
    });
  });

  it('returnDate 缺失 → goDate + nights 推退房日', () => {
    const stamp = resolveBundleHotelStamp(linkedBundle, { goDate: '2026-07-01' }, 3);
    expect(stamp?.hotelCheckOut).toEqual(new Date('2026-07-04'));
  });

  it('returnDate ≤ goDate → 回落到 nights；nights=1 默认 1 晚', () => {
    const sameDay = resolveBundleHotelStamp(
      linkedBundle,
      { goDate: '2026-07-01', returnDate: '2026-07-01' },
      3,
    );
    expect(sameDay?.hotelCheckOut).toEqual(new Date('2026-07-04'));

    // nights=1（调用方对 hotelNights 空套餐解析出的最小晚数）→ 退房日 = 入住 + 1 晚
    const oneNight = resolveBundleHotelStamp(
      { hotelRoomTypeId: 'rt1' },
      { goDate: '2026-07-01' },
      1,
    );
    expect(oneNight?.hotelCheckOut).toEqual(new Date('2026-07-02'));
  });

  it('metadata 畸形（错误类型/非法格式）→ 降级不抛错', () => {
    expect(resolveBundleHotelStamp(linkedBundle, { goDate: 12345 } as never, 3)).toBeNull();
    expect(resolveBundleHotelStamp(linkedBundle, { goDate: 'not-a-date' }, 3)).toBeNull();
    // goDate 合法但 returnDate 畸形 → 仍盖章，按 nights 推退房日
    const stamp = resolveBundleHotelStamp(
      linkedBundle,
      { goDate: '2026-07-01', returnDate: 'garbage' },
      3,
    );
    expect(stamp?.hotelCheckIn).toEqual(new Date('2026-07-01'));
    expect(stamp?.hotelCheckOut).toEqual(new Date('2026-07-04'));
  });
});

// ── 套餐占座归一化：resolveBundleOccupancy ───────────────────────────────
// 成人 / 占座儿童 / 不占座婴儿；向后兼容旧 pax → 全成人。拼房每人 0.5 间、婴儿不占房。
describe('resolveBundleOccupancy', () => {
  it('显式三计数（2 大 1 小 1 婴）→ seatPax 3、headCount 4、rooms 2', () => {
    const o = resolveBundleOccupancy({ adultCount: 2, childCount: 1, infantCount: 1 });
    expect(o).toEqual({
      adultCount: 2,
      childCount: 1,
      infantCount: 1,
      seatPax: 3, // 2 大 + 1 占座小孩
      headCount: 4, // + 1 婴儿（也是出行人）
      rooms: 2, // ceil(3/2)
    });
  });

  it('1 人（1 大）→ seatPax 1、headCount 1、rooms 1（ceil(0.5)=1）', () => {
    expect(resolveBundleOccupancy({ adultCount: 1 })).toEqual({
      adultCount: 1,
      childCount: 0,
      infantCount: 0,
      seatPax: 1,
      headCount: 1,
      rooms: 1,
    });
  });

  it('向后兼容：无三计数，metadata.pax=2 → 2 大 0 小 0 婴（与旧版一致）', () => {
    const o = resolveBundleOccupancy({ metadata: { pax: 2 } });
    expect(o).toMatchObject({ adultCount: 2, childCount: 0, infantCount: 0, seatPax: 2, headCount: 2, rooms: 1 });
  });

  it('向后兼容：无三计数也无 pax → 回退行 quantity 当成人', () => {
    expect(resolveBundleOccupancy({ quantity: 3 })).toMatchObject({
      adultCount: 3,
      seatPax: 3,
      headCount: 3,
      rooms: 2,
    });
  });

  it('metadata 三计数（前台带过来）在无行字段时生效', () => {
    const o = resolveBundleOccupancy({ metadata: { adultCount: 1, childCount: 2, infantCount: 1 } });
    expect(o).toMatchObject({ adultCount: 1, childCount: 2, infantCount: 1, seatPax: 3, headCount: 4, rooms: 2 });
  });

  it('行字段优先于 metadata（显式 1 大覆盖 metadata.pax=5）', () => {
    const o = resolveBundleOccupancy({ adultCount: 1, metadata: { pax: 5 } });
    expect(o).toMatchObject({ adultCount: 1, seatPax: 1, headCount: 1 });
  });
});

// ── 套餐升舱差价单一配置源解析：resolveBundleBusinessUpgradeRate ─────────────
describe('resolveBundleBusinessUpgradeRate（¥/程/座；null=跟随航班，非 null=套餐覆盖）', () => {
  it('套餐自有非 null（含 0）→ 直接用套餐值，忽略航班', () => {
    expect(
      resolveBundleBusinessUpgradeRate({
        businessUpgradeCnyPerLeg: 900,
        outboundFlight: { businessUpgradeCnyPerLeg: 700 },
        returnFlight: { businessUpgradeCnyPerLeg: 700 },
      }),
    ).toBe(900);
    // 0 = 显式不提供升舱，是有效覆盖，不能被航班值顶替
    expect(
      resolveBundleBusinessUpgradeRate({
        businessUpgradeCnyPerLeg: 0,
        outboundFlight: { businessUpgradeCnyPerLeg: 700 },
      }),
    ).toBe(0);
  });

  it('套餐 null（跟随航班）→ 去程优先、回程次之', () => {
    expect(
      resolveBundleBusinessUpgradeRate({
        businessUpgradeCnyPerLeg: null,
        outboundFlight: { businessUpgradeCnyPerLeg: 1400 },
        returnFlight: { businessUpgradeCnyPerLeg: 800 },
      }),
    ).toBe(1400);
    // 去程未绑 → 回退回程
    expect(
      resolveBundleBusinessUpgradeRate({
        businessUpgradeCnyPerLeg: null,
        outboundFlight: null,
        returnFlight: { businessUpgradeCnyPerLeg: 800 },
      }),
    ).toBe(800);
  });

  it('套餐 null 且两趟都没绑航班 → 兜底默认 700（绝不派生 0/裸价）', () => {
    expect(resolveBundleBusinessUpgradeRate({ businessUpgradeCnyPerLeg: null })).toBe(700);
  });
});

// ── 套餐可选升级 add-on 重算：computeBundleAddOn ──────────────────────
describe('computeBundleAddOn', () => {
  const bundle = {
    hotelNights: 3,
    singleSupplementCnyPerNight: 80,
    businessUpgradeCnyPerLeg: 700,
    childSeatDiscountCnyPerPerson: 30,
    infantPriceCny: 0,
    selfVisaDeductCny: 0,
    legs: 2,
  };
  // 真实入住区间：7/1 → 7/4 = 3 晚
  const stamp = {
    hotelCheckIn: new Date('2026-07-01'),
    hotelCheckOut: new Date('2026-07-04'),
  };
  // 占座归一化助手：单测里按需造 occupancy
  const occ = (adultCount: number, childCount = 0, infantCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount, infantCount });

  it('无升级（singleCount/businessCount 缺省，纯成人）→ total 0、hasAddOn false（向后兼容）', () => {
    const r = computeBundleAddOn(bundle, stamp, undefined, undefined, occ(2), 3);
    expect(r.total).toBe(0);
    expect(r.hasAddOn).toBe(false);
    const zero = computeBundleAddOn(bundle, stamp, 0, 0, occ(2), 3);
    expect(zero.total).toBe(0);
    expect(zero.hasAddOn).toBe(false);
  });

  it('单人入住 = singleCount × 房差/晚 × 晚数', () => {
    // 1 人 × 80 × 3 晚 = 240
    const r = computeBundleAddOn(bundle, stamp, 1, 0, occ(2), 3);
    expect(r.breakdown.singleSupplementTotal).toBe(240);
    expect(r.breakdown.businessUpgradeTotal).toBe(0);
    expect(r.total).toBe(240);
    expect(r.hasAddOn).toBe(true);
  });

  it('升舱商务 = businessCount × 升舱/航段 × 航段数', () => {
    // 1 人 × 700 × 2 段 = 1400
    const r = computeBundleAddOn(bundle, stamp, 0, 1, occ(2), 3);
    expect(r.breakdown.businessUpgradeTotal).toBe(1400);
    expect(r.total).toBe(1400);
  });

  it('两项叠加（占座模型默认费率，3 晚来回，各 1 人）= 240 + 1400 = 1640', () => {
    const r = computeBundleAddOn(bundle, stamp, 1, 1, occ(2), 3);
    expect(r.total).toBe(1640);
    expect(r.breakdown).toMatchObject({
      singleCount: 1,
      businessCount: 1,
      nights: 3,
      legs: 2,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
    });
  });

  it('每产品可配置：高端套餐房差上调（480/晚）按配置算', () => {
    const premium = { ...bundle, singleSupplementCnyPerNight: 480 };
    // 4 晚区间
    const fourNights = {
      hotelCheckIn: new Date('2026-07-01'),
      hotelCheckOut: new Date('2026-07-05'),
    };
    const r = computeBundleAddOn(premium, fourNights, 1, 0, occ(2), 4);
    expect(r.breakdown.nights).toBe(4);
    expect(r.total).toBe(480 * 4); // 1920
  });

  it('无 hotelStamp → 回退 bundle.hotelNights（≥1）算晚数', () => {
    // 无盖章 → resolvedNights 被使用；传 bundle.hotelNights(=3) 保持旧期望 ¥
    const r = computeBundleAddOn(bundle, null, 2, 0, occ(2), 3);
    // 2 人 × 80 × 3 晚 = 480
    expect(r.breakdown.nights).toBe(3);
    expect(r.total).toBe(480);
  });

  it('单程套餐 legs=1：升舱只算 1 段', () => {
    const oneWay = { ...bundle, legs: 1 };
    const r = computeBundleAddOn(oneWay, stamp, 0, 2, occ(2), 3);
    // 2 人 × 700 × 1 段 = 1400
    expect(r.breakdown.legs).toBe(1);
    expect(r.total).toBe(1400);
  });

  // ── 占座儿童折扣 + 婴儿价（占座模型新需求）────────────────────────────────
  it('占座儿童折扣：1 小孩 × 30 → 套餐行净减 30（hasAddOn true）', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, 0, occ(2, 1, 0), 3);
    expect(r.breakdown.childSeatDiscountTotal).toBe(30);
    expect(r.breakdown.infantPriceTotal).toBe(0);
    expect(r.total).toBe(-30); // 0 升级 + 0 婴儿 − 30 折扣（加项净额允许为负；非负保护在行金额层）
    expect(r.hasAddOn).toBe(true);
    expect(r.breakdown).toMatchObject({ adultCount: 2, childCount: 1, infantCount: 0, seatPax: 3, headCount: 3 });
  });

  it('折扣可配置：childSeatDiscount=50（不是死 30）→ 2 小孩净减 100', () => {
    const cfg = { ...bundle, childSeatDiscountCnyPerPerson: 50 };
    // 加一个升级让 total 不被 clamp 到 0，验证折扣真减进去：
    //   单人入住 1 人 × 80 × 3 = 240；2 小孩折扣 50 × 2 = 100 → 240 − 100 = 140
    const r = computeBundleAddOn(cfg, stamp, 1, 0, occ(2, 2, 0), 3);
    expect(r.breakdown.childSeatDiscountCnyPerPerson).toBe(50);
    expect(r.breakdown.childSeatDiscountTotal).toBe(100);
    expect(r.total).toBe(140);
  });

  it('婴儿价：infantPrice=500/人 × 1 婴 → 套餐行净加 500', () => {
    const cfg = { ...bundle, infantPriceCny: 500 };
    const r = computeBundleAddOn(cfg, stamp, 0, 0, occ(2, 0, 1), 3);
    expect(r.breakdown.infantPriceTotal).toBe(500);
    expect(r.total).toBe(500);
    expect(r.hasAddOn).toBe(true);
  });

  it('2 大 1 小 1 婴（折扣 30、婴儿价 0）→ 折扣 30、婴儿 0、净 −30（升级机票仍在 FLIGHT 行）', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, 0, occ(2, 1, 1), 3);
    expect(r.breakdown).toMatchObject({
      adultCount: 2,
      childCount: 1,
      infantCount: 1,
      seatPax: 3,
      headCount: 4,
      rooms: 2,
      childSeatDiscountTotal: 30,
      infantPriceTotal: 0,
    });
    expect(r.total).toBe(-30); // 升级 0 + 婴儿 0 − 折扣 30（加项净额允许为负；非负保护在行金额层）
  });

  it('businessCount 夹到占座人数（seatPax）上限：2 大 0 小，businessCount=5 → 只算 2 段商务', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, 5, occ(2, 0, 0), 3);
    expect(r.breakdown.businessCount).toBe(2);
    expect(r.breakdown.businessUpgradeTotal).toBe(2 * 700 * 2); // 2800
  });

  it('婴儿不占座、不能升舱：2 大 0 小 0 婴 seatPax=2，businessCount=3 夹到 2', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, 3, occ(2, 0, 0), 3);
    expect(r.breakdown.businessCount).toBe(2);
  });

  // ── 自备签证减钱（旧整单口径：count=1）────────────────────────────────
  it('自备签证：selfProvidedVisaCount=1（整单减一次）→ 套餐行净减该套餐配置的 selfVisaDeductCny', () => {
    const cfg = { ...bundle, selfVisaDeductCny: 600 };
    // 单人入住 1 人 × 80 × 3 = 240；自备签证减 600 → 240 − 600 = −360（加项净额允许为负）
    const withDeduct = computeBundleAddOn(cfg, stamp, 1, 0, occ(2), 3, 1);
    expect(withDeduct.breakdown.selfVisaDeductTotal).toBe(600);
    expect(withDeduct.breakdown.selfProvidedVisaCount).toBe(1);
    expect(withDeduct.breakdown.selfProvidedVisa).toBe(true);
    expect(withDeduct.total).toBe(-360); // 240 − 600（非负保护下沉到行金额层，不在此夹 0）
    expect(withDeduct.hasAddOn).toBe(true);
    // 升级足够大时确实减进去：升舱 1 人 × 700 × 2 = 1400 − 600 = 800
    const r = computeBundleAddOn(cfg, stamp, 0, 1, occ(2), 3, 1);
    expect(r.total).toBe(800);
  });

  it('自备签证缺省 0 → 不减（向后兼容，selfVisaDeductTotal=0）', () => {
    const cfg = { ...bundle, selfVisaDeductCny: 600 };
    const r = computeBundleAddOn(cfg, stamp, 0, 1, occ(2), 3);
    expect(r.breakdown.selfVisaDeductTotal).toBe(0);
    expect(r.breakdown.selfProvidedVisaCount).toBe(0);
    expect(r.breakdown.selfProvidedVisa).toBe(false);
    expect(r.total).toBe(1400); // 升舱 1400，无减免
  });

  // ── 自备签证减钱（新乘客级口径：count=勾选人数，每人各减一次）───────────────
  it('乘客级自备签：selfProvidedVisaCount=2 → 减免 = 2 × selfVisaDeductCny（每人各减一次）', () => {
    const cfg = { ...bundle, selfVisaDeductCny: 300 };
    // 3 大同行，2 人自备签；升舱 3 人 × 700 × 2 = 4200；减 2 × 300 = 600 → 3600
    const r = computeBundleAddOn(cfg, stamp, 0, 3, occ(3), 3, 2);
    expect(r.breakdown.selfProvidedVisaCount).toBe(2);
    expect(r.breakdown.selfVisaDeductTotal).toBe(600);
    expect(r.total).toBe(4200 - 600);
  });

  it('自备签人数夹到 headCount 上限：headCount=2 但传 count=5 → 只减 2 人份', () => {
    const cfg = { ...bundle, selfVisaDeductCny: 500 };
    // 升舱 2 人 × 700 × 2 = 2800；count 夹到 headCount(2) → 减 2 × 500 = 1000 → 1800
    const r = computeBundleAddOn(cfg, stamp, 0, 2, occ(2), 3, 5);
    expect(r.breakdown.selfProvidedVisaCount).toBe(2);
    expect(r.breakdown.selfVisaDeductTotal).toBe(1000);
    expect(r.total).toBe(1800);
  });
});

// ── 升舱拆去程/回程：分程人数定价 + 与旧整程入参的等价性 ────────────────────
// 业务：同一批客人可以只升去程、或去回程升的人数不同（回程留经济舱）。
// 口径：加价 = (去程人数 + 回程人数) × 每程差价；旧入参（整程 businessCount）沿用 人数 × 差价 × legs。
describe('computeBundleAddOn · 升舱分程（去程/回程各自人数）', () => {
  const bundle = {
    hotelNights: 3,
    singleSupplementCnyPerNight: 80,
    businessUpgradeCnyPerLeg: 700,
    childSeatDiscountCnyPerPerson: 0,
    infantPriceCny: 0,
    selfVisaDeductCny: 0,
    legs: 2,
  };
  const stamp = {
    hotelCheckIn: new Date('2026-07-01'),
    hotelCheckOut: new Date('2026-07-04'),
  };
  const occ = (adultCount: number, childCount = 0, infantCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount, infantCount });

  it('新旧入参等价：整程 businessCount=1 与 分程 {去1, 回1} 定价/明细完全一致（往返）', () => {
    const legacy = computeBundleAddOn(bundle, stamp, 0, 1, occ(2), 3);
    const split = computeBundleAddOn(bundle, stamp, 0, { outbound: 1, return: 1 }, occ(2), 3);
    expect(legacy.total).toBe(1400); // 1 人 × 700 × 2 段
    expect(split.total).toBe(legacy.total);
    expect(split.breakdown.businessUpgradeTotal).toBe(legacy.breakdown.businessUpgradeTotal);
    expect(legacy.breakdown.businessCountOutbound).toBe(1);
    expect(legacy.breakdown.businessCountReturn).toBe(1);
  });

  it('新旧入参等价（单程 legs=1）：整程 businessCount=2 与 分程 {去2, 回2} 都只收去程一段', () => {
    const oneWay = { ...bundle, legs: 1 };
    const legacy = computeBundleAddOn(oneWay, stamp, 0, 2, occ(2), 3);
    const split = computeBundleAddOn(oneWay, stamp, 0, { outbound: 2, return: 2 }, occ(2), 3);
    expect(legacy.total).toBe(1400); // 2 人 × 700 × 1 段
    expect(split.total).toBe(1400);
    // 单程套餐没有回程航段可占座 → 回程人数恒 0，回程那份钱也不该收
    expect(split.breakdown.businessCountReturn).toBe(0);
    expect(legacy.breakdown.businessCountReturn).toBe(0);
  });

  it('两程不同人数：去 2 回 1 → (2+1) × 700 = 2100', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, { outbound: 2, return: 1 }, occ(2), 3);
    expect(r.breakdown.businessCountOutbound).toBe(2);
    expect(r.breakdown.businessCountReturn).toBe(1);
    expect(r.breakdown.businessUpgradeTotal).toBe(2100);
    expect(r.total).toBe(2100);
  });

  it('只升去程：{去1, 回0} → 只收 1 段 700（不是整程 1400）', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, { outbound: 1, return: 0 }, occ(2), 3);
    expect(r.breakdown.businessCountReturn).toBe(0);
    expect(r.total).toBe(700);
    expect(r.hasAddOn).toBe(true);
  });

  it('只升回程：{去0, 回2} → 只收回程 2 × 700 = 1400', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, { outbound: 0, return: 2 }, occ(2), 3);
    expect(r.breakdown.businessCountOutbound).toBe(0);
    expect(r.breakdown.businessCountReturn).toBe(2);
    expect(r.total).toBe(1400);
  });

  it('两程各自夹到占座人数上限：2 大 1 婴（seatPax=2），传 {去5, 回5} → 各夹到 2 → 2800', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, { outbound: 5, return: 5 }, occ(2, 0, 1), 3);
    expect(r.breakdown.businessCountOutbound).toBe(2);
    expect(r.breakdown.businessCountReturn).toBe(2);
    expect(r.breakdown.businessUpgradeTotal).toBe(2800);
  });

  it('两程都 0（显式）→ 无加项，与不传升舱等价', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, { outbound: 0, return: 0 }, occ(2), 3);
    expect(r.total).toBe(0);
    expect(r.hasAddOn).toBe(false);
  });

  it('负数/小数入参按整数非负夹逼（不信客户端）', () => {
    const r = computeBundleAddOn(bundle, stamp, 0, { outbound: -3, return: 1.9 }, occ(2), 3);
    expect(r.breakdown.businessCountOutbound).toBe(0);
    expect(r.breakdown.businessCountReturn).toBe(1);
    expect(r.total).toBe(700);
  });
});

// ── BUNDLE 行入参 → 升舱口径解析：resolveBundleBusinessUpgradeInput ────────────
describe('resolveBundleBusinessUpgradeInput', () => {
  it('只有旧 businessCount → 回落整程口径（原样返回数字）', () => {
    expect(resolveBundleBusinessUpgradeInput({ businessCount: 2 })).toBe(2);
  });

  it('三个字段都没有 → undefined（无升舱）', () => {
    expect(resolveBundleBusinessUpgradeInput({})).toBeUndefined();
  });

  it('分程字段任一存在 → 分程口径（旧 businessCount 被忽略，以分程为权威）', () => {
    expect(
      resolveBundleBusinessUpgradeInput({ businessCount: 9, businessCountOutbound: 2 }),
    ).toEqual({ outbound: 2, return: undefined });
    expect(resolveBundleBusinessUpgradeInput({ businessCountReturn: 1 })).toEqual({
      outbound: undefined,
      return: 1,
    });
  });

  it('显式 0 也算「提供」：{去1, 回0} 不能退化成整程口径（否则回程会被收钱）', () => {
    const input = resolveBundleBusinessUpgradeInput({
      businessCountOutbound: 1,
      businessCountReturn: 0,
    });
    expect(input).toEqual({ outbound: 1, return: 0 });
  });
});

// ── 占/释对称（两程升舱人数不同）：扣座与退座逐行必须镜像 ──────────────────────
// 扣座读 priced 行的类型化 businessUpgradeCount，退座读**同一行**落库的 metadata.businessUpgradeCount，
// 两者同源 → 每条腿各按自己的人数拆/还，跨腿不串。这里用 computeBundleSeatSplit 逐行验证守恒。
describe('套餐升舱拆座 · 去/回程人数不同时的占/释对称', () => {
  it('去程 2 人升舱、回程 1 人升舱（每段 3 座）→ 逐行占座 = 逐行退座，净占座恒为 quantity', () => {
    const legs = [
      { label: '去程', quantity: 3, businessUpgradeCount: 2 },
      { label: '回程', quantity: 3, businessUpgradeCount: 1 },
    ];
    for (const leg of legs) {
      // 下单扣座：用行自己的类型化字段
      const held = computeBundleSeatSplit('ECONOMY', leg.quantity, leg.businessUpgradeCount);
      // 取消/超时退座：用**同一行**落库的 metadata.businessUpgradeCount（镜像还原）
      const metadata: Record<string, unknown> = { businessUpgradeCount: leg.businessUpgradeCount };
      const raw = typeof metadata.businessUpgradeCount === 'number' ? metadata.businessUpgradeCount : 0;
      const released = computeBundleSeatSplit('ECONOMY', leg.quantity, raw);
      expect(released).toEqual(held);
      expect(held.sameCabin + held.business).toBe(leg.quantity);
    }
    // 两条腿的商务舱占用互不相等且各自正确（旧版会把同一个数盖到每程）
    expect(computeBundleSeatSplit('ECONOMY', 3, legs[0].businessUpgradeCount).business).toBe(2);
    expect(computeBundleSeatSplit('ECONOMY', 3, legs[1].businessUpgradeCount).business).toBe(1);
  });

  it('只升去程（回程 0）→ 回程整段仍留经济舱，退座不会去动从未占用的商务舱', () => {
    const outbound = computeBundleSeatSplit('ECONOMY', 2, 2);
    const inbound = computeBundleSeatSplit('ECONOMY', 2, 0);
    expect(outbound).toEqual({ sameCabin: 0, business: 2 });
    expect(inbound).toEqual({ sameCabin: 2, business: 0 });
  });
});

// ── 套餐行金额：自备签减免正常抵扣地面价（693 场景）+ 减免超地面价夹 0 ──────────────
// createOrder 的 BUNDLE 行金额口径：amount = max(0, bundleUnitPrice×qty + addOn.total + operationFeeTotal)，
// 之后再对该套餐的 BUNDLE/FLIGHT 行整体 percent-off。这里在纯函数层复刻这条流水线，验证减免不再被
// 「加项净额层夹 0」吞掉（修复前 addOn.total 被 max(0,…) 钳成 0，无其它加价时减免一分不减）。
describe('套餐行金额：自备签减免抵扣 + 极端夹 0（复刻 createOrder BUNDLE 行）', () => {
  const stamp = {
    hotelCheckIn: new Date('2026-07-01'),
    hotelCheckOut: new Date('2026-07-04'), // 3 晚
  };
  const occ = (adultCount: number, childCount = 0, infantCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount, infantCount });

  /** 复刻 createOrder：套餐行金额（含非负保护），再套 percent-off。 */
  const bundleLineAmount = (
    bundleUnitPrice: number,
    qty: number,
    addOnTotal: number,
    operationFeeTotal: number,
  ) => Math.max(0, bundleUnitPrice * qty + addOnTotal + operationFeeTotal);
  const applyDiscount = (amount: number, pct: number) => Math.round(amount * ((100 - pct) / 100));

  it('693 场景：1 成人仅自备签（visaExempt）→ (600 地面 + 300 签证 − 150 减免 + 20 操作费) × 0.9 = 693', () => {
    // 仅配自备签减免（其它加项费率全 0），验证减免单独存在时也能抵扣：
    const cfg = {
      hotelNights: 3,
      singleSupplementCnyPerNight: 0,
      businessUpgradeCnyPerLeg: 0,
      childSeatDiscountCnyPerPerson: 0,
      infantPriceCny: 0,
      selfVisaDeductCny: 150,
      legs: 2,
    };
    // 1 成人，自备签 1 人 → addOn.total = −150（修复前会被夹成 0）
    const addOn = computeBundleAddOn(cfg, stamp, 0, 0, occ(1), 3, 1);
    expect(addOn.total).toBe(-150);
    expect(addOn.breakdown.selfVisaDeductTotal).toBe(150);

    // bundleUnitPrice = 地面价 = 3 晚 × 400 × 0.5 间(600) + 签证 300 = 900；操作费 20；qty 1
    const amount = bundleLineAmount(900, 1, addOn.total, 20);
    expect(amount).toBe(770); // 900 − 150 + 20（修复前为 900 − 0 + 20 = 920）
    expect(applyDiscount(amount, 10)).toBe(693); // 770 × 0.9（修复前 920 × 0.9 = 828）
  });

  it('极端：自备签减免大于地面总价 → 行金额夹到 0，绝不为负', () => {
    const cfg = {
      hotelNights: 3,
      singleSupplementCnyPerNight: 0,
      businessUpgradeCnyPerLeg: 0,
      childSeatDiscountCnyPerPerson: 0,
      infantPriceCny: 0,
      selfVisaDeductCny: 600,
      legs: 2,
    };
    const addOn = computeBundleAddOn(cfg, stamp, 0, 0, occ(1), 3, 1);
    expect(addOn.total).toBe(-600);
    // 地面 300 + 操作费 20 = 320，减免 600 → 320 − 600 = −280 → 夹到 0
    const amount = bundleLineAmount(300, 1, addOn.total, 20);
    expect(amount).toBe(0);
    expect(applyDiscount(amount, 10)).toBe(0); // 折扣作用在 0 上仍为 0，不为负
  });
});

// ── 套餐签证按办签人数计费（S2 修复：复刻 createOrder 套餐子项 groundTotal + BUNDLE 行）──────────
// createOrder 里 VISA 子项定价：办签人数 = occupancy.headCount − selfProvidedVisaCount（夹到 ≥0），
// 份数 = 办签人数 × unitPrice（TRANSFER 仍固定 qty×unitPrice）。这里在纯函数层复刻同一 reduce，
// 验证「随人数收费」+「自备签减免与办签份数联动后 BUNDLE 行金额不为负」。
describe('套餐签证按办签人数计费（S2·复刻 createOrder groundTotal）', () => {
  const stamp = {
    hotelCheckIn: new Date('2026-07-01'),
    hotelCheckOut: new Date('2026-07-04'), // 3 晚
  };
  const occ = (adultCount: number, childCount = 0, infantCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount, infantCount });

  /** 复刻 createOrder 套餐子项 groundTotal（含 S2 的 VISA 按办签人数缩放）。 */
  const bundleGroundTotal = (
    items: Array<{ kind: string; qty: number; unitPrice: number }>,
    headCount: number,
    selfProvidedVisaCount: number,
    rooms: number,
    linkedHotelNightlyPrice: number | null = null,
  ) => {
    const visaHeadCount = Math.max(0, headCount - selfProvidedVisaCount);
    return items
      .filter((b) => b.kind !== 'FLIGHT')
      .reduce((s, b) => {
        if (b.kind === 'HOTEL') {
          const nightlyPrice = linkedHotelNightlyPrice ?? b.unitPrice;
          return s + b.qty * nightlyPrice * rooms;
        }
        if (b.kind === 'VISA') return s + visaHeadCount * b.unitPrice;
        return s + b.qty * b.unitPrice;
      }, 0);
  };
  /** 复刻 createOrder：BUNDLE 行金额（含非负保护）。 */
  const bundleLineAmount = (ground: number, addOnTotal: number, opFee: number) =>
    Math.max(0, Math.round(ground) + addOnTotal + opFee);

  const visaItems = [{ kind: 'VISA', qty: 1, unitPrice: 220 }];

  it('2 成人套餐 → 签证收 2 份（headCount=2、无自备签 → 办签 2 人 × ¥220 = 440）', () => {
    expect(bundleGroundTotal(visaItems, occ(2).headCount, 0, 1)).toBe(440);
  });

  it('婴儿也计入办签人数（headCount 含婴儿，与自备签减免同基数）：2 成人 1 婴儿 → 收 3 份', () => {
    // 修复前静态 qty=1 只收 1 份；办签人数 = headCount(3) − 0 = 3 → 3 × 220 = 660。
    expect(bundleGroundTotal(visaItems, occ(2, 0, 1).headCount, 0, 1)).toBe(660);
  });

  it('1 人自备签 → 只收 (headCount−1) 份（2 成人、1 人自备 → 办签 1 人 × ¥220 = 220）', () => {
    expect(bundleGroundTotal(visaItems, occ(2).headCount, 1, 1)).toBe(220);
  });

  it('自备签人数超过出行人 → 办签份数夹到 0（不出现负份）', () => {
    expect(bundleGroundTotal(visaItems, occ(2).headCount, 5, 1)).toBe(0);
  });

  it('自备签减免与办签份数联动后 BUNDLE 行金额不为负（自备者不收签证 + 减免叠加 → 夹到 0）', () => {
    // 1 成人独自自备签：办签人数 = 1 − 1 = 0 → 签证地面 = 0；再叠加 selfVisaDeductCny=150 减免。
    const cfg = {
      hotelNights: 3,
      singleSupplementCnyPerNight: 0,
      businessUpgradeCnyPerLeg: 0,
      childSeatDiscountCnyPerPerson: 0,
      infantPriceCny: 0,
      selfVisaDeductCny: 150,
      legs: 2,
    };
    const ground = bundleGroundTotal(visaItems, occ(1).headCount, 1, 1); // = 0（自备者不收签证）
    expect(ground).toBe(0);
    const addOn = computeBundleAddOn(cfg, stamp, 0, 0, occ(1), 3, 1); // 减免 −150
    expect(addOn.total).toBe(-150);
    // 行金额 = max(0, 0 − 150 + 操作费 20) = max(0, −130) = 0（联动后不为负）。
    expect(bundleLineAmount(ground, addOn.total, 20)).toBe(0);
  });

  it('多人单：部分自备签仍随办签人数正常收费（净额为正、诚实抵扣）', () => {
    // 2 成人、1 人自备签：办签 1 人；酒店 3 晚 × ¥400 × 1 间 + 签证 1 × ¥220 = 1420。
    const items = [
      { kind: 'HOTEL', qty: 3, unitPrice: 400 },
      { kind: 'VISA', qty: 1, unitPrice: 220 },
    ];
    const cfg = {
      hotelNights: 3,
      singleSupplementCnyPerNight: 0,
      businessUpgradeCnyPerLeg: 0,
      childSeatDiscountCnyPerPerson: 0,
      infantPriceCny: 0,
      selfVisaDeductCny: 150,
      legs: 2,
    };
    const ground = bundleGroundTotal(items, occ(2).headCount, 1, 1, 400);
    expect(ground).toBe(1420);
    const addOn = computeBundleAddOn(cfg, stamp, 0, 0, occ(2), 3, 1); // 减免 −150
    expect(addOn.total).toBe(-150);
    // 操作费 = 20 × seatPax(2) = 40 → 行金额 = max(0, 1420 − 150 + 40) = 1310（诚实抵扣、为正）。
    expect(bundleLineAmount(ground, addOn.total, 40)).toBe(1310);
  });
});

// ── 前台展示价兜底：assertDisplayedTotalMatches（S1，匹配通过 / 偏差拒单 / 不传跳过）──────────
describe('assertDisplayedTotalMatches（前台展示价兜底 S1）', () => {
  it('匹配（含 ≤1 元取整误差）→ 通过，不抛', () => {
    expect(() => assertDisplayedTotalMatches(3200, 3200)).not.toThrow();
    expect(() => assertDisplayedTotalMatches(3200, 3199)).not.toThrow(); // 差 1 元容忍
    expect(() => assertDisplayedTotalMatches(3200, 3201)).not.toThrow();
  });

  it('偏差 > 1 元 → 抛 PriceChangedError（code=PRICE_CHANGED）', () => {
    // 典型：套餐机票展示 547，实扣 ~3200。
    expect(() => assertDisplayedTotalMatches(3200, 547)).toThrow(PriceChangedError);
    try {
      assertDisplayedTotalMatches(3200, 547);
    } catch (e) {
      expect((e as PriceChangedError).code).toBe('PRICE_CHANGED');
      expect((e as PriceChangedError).statusCode).toBe(400);
    }
    expect(() => assertDisplayedTotalMatches(3200, 3202)).toThrow(PriceChangedError); // 差 2 元即拒
  });

  it('不传 expectedTotalCny（undefined/null）→ 跳过比对，不抛（admin/批量路径不受影响）', () => {
    expect(() => assertDisplayedTotalMatches(3200, undefined)).not.toThrow();
    expect(() => assertDisplayedTotalMatches(3200, null)).not.toThrow();
  });
});

// ── 套餐乘客级住宿/签证派生：derivePerPaxBundleOptions（新旧口径优先级）──────────
describe('derivePerPaxBundleOptions', () => {
  it('无 passengers（老客户端）→ 回落 item 级旧聚合口径', () => {
    const r = derivePerPaxBundleOptions(
      { selfProvidedVisa: true, singleCount: 2 },
      undefined,
    );
    // 旧整单布尔 true → count=1（整单减一次）；singleCount 用 item 聚合值
    expect(r).toEqual({ selfProvidedVisaCount: 1, singleCount: 2 });
  });

  it('item 布尔 false / 无 singleCount → count=0 / singleCount=undefined', () => {
    const r = derivePerPaxBundleOptions({}, undefined);
    expect(r).toEqual({ selfProvidedVisaCount: 0, singleCount: undefined });
  });

  it('乘客级提供 → 以勾选人数为权威（覆盖 item 旧值）', () => {
    const passengers = [
      { visaExempt: true, singleRoom: false },
      { visaExempt: false, singleRoom: true },
      { visaExempt: true, singleRoom: true },
    ];
    // item 上的旧值应被乘客级派生覆盖：自备签 2 人、单住 2 人
    const r = derivePerPaxBundleOptions(
      { selfProvidedVisa: false, singleCount: 0 },
      passengers,
    );
    expect(r).toEqual({ selfProvidedVisaCount: 2, singleCount: 2 });
  });

  it('两维各自独立判定：只结构化住宿、签证仍走旧布尔', () => {
    const passengers = [{ singleRoom: true }, { singleRoom: false }];
    // singleRoom 有提供 → 单住派生 1；visaExempt 无人提供 → 回落 item.selfProvidedVisa(true) → 1
    const r = derivePerPaxBundleOptions(
      { selfProvidedVisa: true, singleCount: 9 },
      passengers,
    );
    expect(r).toEqual({ selfProvidedVisaCount: 1, singleCount: 1 });
  });

  it('乘客级全 false（显式提供）→ 派生 0，覆盖 item 旧聚合值', () => {
    const passengers = [
      { visaExempt: false, singleRoom: false },
      { visaExempt: false, singleRoom: false },
    ];
    const r = derivePerPaxBundleOptions(
      { selfProvidedVisa: true, singleCount: 2 },
      passengers,
    );
    expect(r).toEqual({ selfProvidedVisaCount: 0, singleCount: 0 });
  });
});

// ── 乘客字段落库映射：passengerToData（0713 反馈批新增 visaExempt/singleRoom）──────
describe('passengerToData — 套餐乘客级选项落库', () => {
  const base = {
    fullName: 'ZHANG SAN',
    documentType: 'PASSPORT' as const,
    documentNumber: 'E12345678',
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
  };

  it('显式提供 → 原样落库', () => {
    const data = passengerToData({ ...base, visaExempt: true, singleRoom: true });
    expect(data.visaExempt).toBe(true);
    expect(data.singleRoom).toBe(true);
  });

  it('缺省 → 落 false（拼房 + 随套餐办签，与旧行为一致）', () => {
    const data = passengerToData(base);
    expect(data.visaExempt).toBe(false);
    expect(data.singleRoom).toBe(false);
  });

  it('单维提供：仅自备签 true，单住缺省 false', () => {
    const data = passengerToData({ ...base, visaExempt: true });
    expect(data.visaExempt).toBe(true);
    expect(data.singleRoom).toBe(false);
  });

  // fullName 允许带斜线（合法分隔符），lastName/firstName 两栏不允许。
  // 从 fullName 反推时若只按空格拆，斜线会整串落进 lastName，绕过入口的禁斜线校验。
  it('fullName 带斜线：ZHANG/SAN → 姓 ZHANG（不含斜线）、名 SAN', () => {
    const data = passengerToData({ ...base, fullName: 'ZHANG/SAN' });
    expect(data.lastName).toBe('ZHANG');
    expect(data.lastName).not.toContain('/');
    expect(data.firstName).toBe('SAN');
  });

  it('fullName 按空格拆：ZHANG SAN → 姓 ZHANG、名 SAN', () => {
    const data = passengerToData(base);
    expect(data.lastName).toBe('ZHANG');
    expect(data.firstName).toBe('SAN');
  });

  it('显式传入的姓/名优先于 fullName 反推', () => {
    const data = passengerToData({
      ...base,
      fullName: 'ZHANG/SAN',
      lastName: 'LI',
      firstName: 'SI',
    });
    expect(data.lastName).toBe('LI');
    expect(data.firstName).toBe('SI');
  });
});

// ── 按房型容量算所需房间数：computeRoomsNeeded（C-v2 核心）──────────────
describe('computeRoomsNeeded', () => {
  const occ = (adultCount: number, childCount = 0, infantCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount, infantCount });
  // 标准房型：1 间坐 2 大 1 小
  const room2A1C = { maxAdults: 2, maxChildren: 1 };

  it('2 大（房型 2大1小）→ 1 间（向后兼容：与旧 ceil(seatPax/2)=1 一致）', () => {
    expect(computeRoomsNeeded(occ(2), room2A1C)).toBe(1);
  });

  it('4 大（房型 2大1小）→ ceil(4/2)=2 间', () => {
    expect(computeRoomsNeeded(occ(4), room2A1C)).toBe(2);
  });

  it('2 大 2 小（房型 2大1小）→ max(ceil(2/2)=1, ceil(2/1)=2, 1)=2 间', () => {
    expect(computeRoomsNeeded(occ(2, 2), room2A1C)).toBe(2);
  });

  it('2 大 1 小（房型 2大1小）→ max(1, 1, 1)=1 间', () => {
    expect(computeRoomsNeeded(occ(2, 1), room2A1C)).toBe(1);
  });

  it('婴儿不占床：2 大 0 小 3 婴 → 仍 1 间（婴儿不计入）', () => {
    expect(computeRoomsNeeded(occ(2, 0, 3), room2A1C)).toBe(1);
  });

  it('容量缺失 / 无房型 → 回退默认 2大1小：4 大 → 2 间', () => {
    expect(computeRoomsNeeded(occ(4), null)).toBe(2);
    expect(computeRoomsNeeded(occ(4), {})).toBe(2);
  });

  // ── 单人入住（singleCount）计入间数（A6）──────────────────────────────
  // 原口径把 singleCount 完全排除在 roomsNeeded 外 → 「2 大都勾单人入住 = 1 间」，
  // 房量校验据此少算 → 超卖；而这个 rooms 正是喂给物理房间前瞻闸的整间数输入。
  it('2 大都勾单人入住（房型 2大1小）→ 2 间（各自独住，不是挤 1 间）', () => {
    expect(computeRoomsNeeded(occ(2), room2A1C, 2)).toBe(2);
  });

  it('2 大其中 1 位勾单人入住 → 1 间独住 + 1 间给剩下那位 = 2 间', () => {
    expect(computeRoomsNeeded(occ(2), room2A1C, 1)).toBe(2);
  });

  it('1 大勾单人入住 → 1 间（不因独住而多开）', () => {
    expect(computeRoomsNeeded(occ(1), room2A1C, 1)).toBe(1);
  });

  it('4 大其中 2 位勾单人入住 → 2 间独住 + ceil(2/2)=1 间 = 3 间', () => {
    expect(computeRoomsNeeded(occ(4), room2A1C, 2)).toBe(3);
  });

  it('singleCount 缺省 / 0 → 与加入该维度之前完全一致（老调用方零影响）', () => {
    expect(computeRoomsNeeded(occ(2), room2A1C)).toBe(computeRoomsNeeded(occ(2), room2A1C, 0));
    expect(computeRoomsNeeded(occ(4), room2A1C, 0)).toBe(2);
  });

  it('singleCount 夹到 [0, 成人数]：脏输入（负数 / 超过成人数）不放大间数', () => {
    expect(computeRoomsNeeded(occ(2), room2A1C, -3)).toBe(1); // 负 → 按 0
    expect(computeRoomsNeeded(occ(2), room2A1C, 99)).toBe(2); // 超 → 夹到 2 大
  });

  it('大房型 4大2小：6 大 → ceil(6/4)=2 间；4 小 → ceil(4/2)=2 间', () => {
    expect(computeRoomsNeeded(occ(6), { maxAdults: 4, maxChildren: 2 })).toBe(2);
    expect(computeRoomsNeeded(occ(0, 4), { maxAdults: 4, maxChildren: 2 })).toBe(2);
  });

  it('永远 ≥ 1 间（0 人也至少 1 间）', () => {
    expect(computeRoomsNeeded(occ(0), room2A1C)).toBe(1);
  });

  it('lone-child packing：房型 maxChildren=0 时把儿童并入成人维度（不除 0）', () => {
    // 2 大 1 小，maxAdults=2、maxChildren=0 → ceil((2+1)/2)=2 间
    expect(computeRoomsNeeded(occ(2, 1), { maxAdults: 2, maxChildren: 0 })).toBe(2);
  });
});

// ── 套餐酒店地面成本随房间数缩放（与 createOrder BUNDLE 分支同源公式）──────
// 公式：bundleGround = Σ(HOTEL: unitPrice×qty×roomsNeeded) + Σ(其它非机票: unitPrice×qty) − groundDiscount
describe('套餐酒店地面成本 ×roomsNeeded', () => {
  const occ = (adultCount: number, childCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount });
  const room2A1C = { maxAdults: 2, maxChildren: 1 };
  // HOTEL: 每间每晚 1280，住 2 晚；TRANSFER: 一口价 300（不随房间数变）
  const items = [
    { kind: 'FLIGHT', qty: 1, unitPrice: 0 },
    { kind: 'HOTEL', qty: 2, unitPrice: 1280 },
    { kind: 'TRANSFER', qty: 1, unitPrice: 300 },
  ];
  const groundDiscount = 100;
  // 与 orders.service.ts BUNDLE 分支同源的纯函数复刻（验证缩放公式）
  const computeGround = (rooms: number) =>
    Math.max(
      0,
      Math.round(
        items
          .filter((b) => b.kind !== 'FLIGHT')
          .reduce((s, b) => s + b.qty * b.unitPrice * (b.kind === 'HOTEL' ? rooms : 1), 0) -
          groundDiscount,
      ),
    );

  it('2 大 → 1 间 → 酒店 1280×2×1 + 300 − 100 = 2760', () => {
    const rooms = computeRoomsNeeded(occ(2), room2A1C);
    expect(rooms).toBe(1);
    expect(computeGround(rooms)).toBe(1280 * 2 * 1 + 300 - 100); // 2760
  });

  it('4 大 → 2 间 → 酒店 1280×2×2 + 300 − 100 = 5320（酒店部分翻倍，接送不变）', () => {
    const rooms = computeRoomsNeeded(occ(4), room2A1C);
    expect(rooms).toBe(2);
    expect(computeGround(rooms)).toBe(1280 * 2 * 2 + 300 - 100); // 5320
  });

  it('酒店成本随房间数线性增长（4 大酒店部分 = 2 大的 2 倍）', () => {
    const hotelOnly = (rooms: number) => 1280 * 2 * rooms;
    expect(hotelOnly(computeRoomsNeeded(occ(4), room2A1C))).toBe(
      hotelOnly(computeRoomsNeeded(occ(2), room2A1C)) * 2,
    );
  });
});

// ── 单人拼房 0.5 间计费房间数（server-authoritative）：computeBundleRoomsCharged ──
// 业务口径：1 人报套餐且非独住 → 愿意拼房共用一间，只按 0.5 间收（床位口径）；
// 独住 / 2 人及以上 / 含占座儿童 → 沿用容量口径（不变）。客户端 roomsBilled 只能上调不能下压。
describe('computeBundleRoomsCharged（单人拼房 0.5 间 + 权威下限）', () => {
  const occ = (adultCount: number, childCount = 0, infantCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount, infantCount });
  const room2A1C = { maxAdults: 2, maxChildren: 1 };
  const ROOM_TYPE_ID = 'room-type-1'; // 绑定套餐房型的占位 id

  const call = (over: Partial<Parameters<typeof computeBundleRoomsCharged>[0]>) =>
    computeBundleRoomsCharged({
      occupancy: occ(1),
      capacity: room2A1C,
      hotelRoomTypeId: ROOM_TYPE_ID,
      singleCount: undefined,
      clientRoomsBilled: undefined,
      ...over,
    });

  it('单人拼房（1 成人 0 儿童，singleCount 缺省 / 0，绑房型）→ 0.5 间', () => {
    expect(call({ singleCount: undefined })).toBe(0.5);
    expect(call({ singleCount: 0 })).toBe(0.5);
  });

  it('单人独住（singleCount ≥ 1）→ 1 整间（不走 0.5，照旧 + 单房差另算）', () => {
    expect(call({ singleCount: 1 })).toBe(1);
  });

  it('单人 + 婴儿（婴儿不占房）仍算单人拼房 → 0.5 间', () => {
    expect(call({ occupancy: occ(1, 0, 2) })).toBe(0.5);
  });

  it('未绑套餐房型（hotelRoomTypeId=null）→ 不走 0.5 口径，按容量 1 间', () => {
    expect(call({ hotelRoomTypeId: null })).toBe(1);
  });

  it('2 成人 → 1 整间（容量口径不变，不走 0.5）', () => {
    expect(call({ occupancy: occ(2) })).toBe(1);
  });

  it('1 成人 1 占座儿童 → 有占座儿童，非单人 → 按容量 1 间（不走 0.5）', () => {
    expect(call({ occupancy: occ(1, 1) })).toBe(1);
  });

  it('权威下限：2 成人 + 客户端伪造 roomsBilled=0.5 → 取 max(0.5, 1)=1（不给少付）', () => {
    expect(call({ occupancy: occ(2), clientRoomsBilled: 0.5 })).toBe(1);
  });

  it('权威下限：单人拼房 + 客户端 roomsBilled=0.5 → 与权威一致 0.5', () => {
    expect(call({ occupancy: occ(1), clientRoomsBilled: 0.5 })).toBe(0.5);
  });

  it('客户端可上调：单人拼房 + roomsBilled=2（主动多开房）→ 取 max(2, 0.5)=2', () => {
    expect(call({ occupancy: occ(1), clientRoomsBilled: 2 })).toBe(2);
  });

  it('4 成人 + 客户端伪造 roomsBilled=0.5 → 取 max(0.5, 2)=2（多人不给伪造半间）', () => {
    expect(call({ occupancy: occ(4), clientRoomsBilled: 0.5 })).toBe(2);
  });
});

// ── 单人拼房 0.5 间：可观测的套餐地面价（与 BUNDLE 分支同源公式：ground = basePrice×nights×rooms，随后 ×(1−pct/100)）──
// 用 computeBundleRoomsCharged 的权威房间数驱动酒店行定价，复刻 createOrder BUNDLE 分支的收费口径。
describe('单人拼房 0.5 间 → 套餐酒店地面价（basePrice 600 / 2 晚）', () => {
  const occ = (adultCount: number, childCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount });
  const room2A1C = { maxAdults: 2, maxChildren: 1 };
  const ROOM_TYPE_ID = 'room-type-1';
  const BASE_PRICE = 600;
  const NIGHTS = 2;
  // 与 orders.service.ts BUNDLE 分支同源：groundTotal = basePrice×nights×rooms（HOTEL 行随房间数缩放）。
  const hotelGround = (rooms: number) => Math.max(0, Math.round(BASE_PRICE * NIGHTS * rooms));
  // 折后套餐行金额 = round(amount × (100−pct)/100)（与循环后 percent-off 后处理一致）。
  const afterDiscount = (amount: number, pct: number) => Math.round((amount * (100 - pct)) / 100);
  const rooms = (over: Partial<Parameters<typeof computeBundleRoomsCharged>[0]>) =>
    computeBundleRoomsCharged({
      occupancy: occ(1),
      capacity: room2A1C,
      hotelRoomTypeId: ROOM_TYPE_ID,
      singleCount: undefined,
      clientRoomsBilled: undefined,
      ...over,
    });

  it('单人拼房（singleCount 0）→ 0.5 间 → 酒店地面 = 600×2×0.5 = 600（折前）', () => {
    const r = rooms({ singleCount: 0 });
    expect(r).toBe(0.5);
    expect(hotelGround(r)).toBe(600);
  });

  it('单人拼房 + discountPct 10 → 折后 = round(600 × 0.9) = 540', () => {
    const r = rooms({ singleCount: 0 });
    expect(afterDiscount(hotelGround(r), 10)).toBe(540);
  });

  it('单人独住（singleCount 1）→ 1 整间 → 酒店地面 = 600×2×1 = 1200（不变；单房差另算）', () => {
    const r = rooms({ singleCount: 1 });
    expect(r).toBe(1);
    expect(hotelGround(r)).toBe(1200);
  });

  it('2 成人 → 1 间 → 酒店地面 = 600×2×1 = 1200（不变）', () => {
    const r = rooms({ occupancy: occ(2) });
    expect(r).toBe(1);
    expect(hotelGround(r)).toBe(1200);
  });

  it('3 成人 → 2 间 → 酒店地面 = 600×2×2 = 2400（不变）', () => {
    const r = rooms({ occupancy: occ(3) });
    expect(r).toBe(2);
    expect(hotelGround(r)).toBe(2400);
  });

  it('滥用：2 成人 + 客户端伪造 roomsBilled=0.5 → 服务端仍按 1 间收 1200（不给 0.5 少付）', () => {
    const r = rooms({ occupancy: occ(2), clientRoomsBilled: 0.5 });
    expect(r).toBe(1);
    expect(hotelGround(r)).toBe(1200);
  });

  it('单房差独住 vs 拼房：拼房酒店地面正好是独住整间的一半（0.5 vs 1）', () => {
    const share = hotelGround(rooms({ singleCount: 0 }));
    const single = hotelGround(rooms({ singleCount: 1 }));
    expect(share * 2).toBe(single);
  });
});

// ── 单独 HOTEL 行（非套餐）不受 0.5 拼房口径影响：仍按 computeRoomsNeeded 整间（out of scope）──
// computeBundleRoomsCharged 仅在 BUNDLE 分支调用；单独 HOTEL 分支用 computeRoomsNeeded，1 成人 → ceil(1/2)=1 间。
describe('单独 HOTEL 单人（非套餐）→ 仍 1 整间（0.5 口径不外溢）', () => {
  const occ = (adultCount: number, childCount = 0) =>
    resolveBundleOccupancy({ adultCount, childCount });
  const room2A1C = { maxAdults: 2, maxChildren: 1 };

  it('1 成人（房型 2大1小）→ computeRoomsNeeded = 1 间（单独 HOTEL 分支不走 0.5）', () => {
    expect(computeRoomsNeeded(occ(1), room2A1C)).toBe(1);
  });
});

// ── 套餐每人操作费：computeBundleOperationFeeTotal ────────────────────
// 操作费 = max(0, trunc(operationFeeCny)) × 占座人数 seatPax（婴儿不占座不收）。
describe('computeBundleOperationFeeTotal', () => {
  it('默认 ¥20 × 占座人数（2 大 1 占座童 = 3 人 → ¥60）', () => {
    expect(computeBundleOperationFeeTotal(20, 3)).toBe(60);
  });

  it('费率 0 → 不收；占座 0 人 → 不收', () => {
    expect(computeBundleOperationFeeTotal(0, 5)).toBe(0);
    expect(computeBundleOperationFeeTotal(20, 0)).toBe(0);
  });

  it('脏输入夹逼：负费率→0、小数截断、NaN/undefined→0（不产生负账/小数账）', () => {
    expect(computeBundleOperationFeeTotal(-5, 3)).toBe(0);
    expect(computeBundleOperationFeeTotal(20.9, 2)).toBe(40);
    expect(computeBundleOperationFeeTotal(Number.NaN, 2)).toBe(0);
    expect(computeBundleOperationFeeTotal(20, -1)).toBe(0);
  });
});

// ── 套餐升舱拆座模型：computeBundleSeatSplit ──────────────────────────
// 正确模型：客户机票仍按经济舱套餐价收，升舱只把座位从经济舱「拆」到真实商务舱库存
// （ECONOMY 减 businessCount、BUSINESS 加 businessCount），净占座不变、不超售。
describe('computeBundleSeatSplit', () => {
  it('businessCount 缺省/0 → 全额留原舱、不占商务舱（向后兼容）', () => {
    expect(computeBundleSeatSplit('ECONOMY', 2, undefined)).toEqual({ sameCabin: 2, business: 0 });
    expect(computeBundleSeatSplit('ECONOMY', 2, 0)).toEqual({ sameCabin: 2, business: 0 });
  });

  it('2 人 1 人升舱 → 经济舱占 1、商务舱占 1（净占座仍 2）', () => {
    const split = computeBundleSeatSplit('ECONOMY', 2, 1);
    expect(split).toEqual({ sameCabin: 1, business: 1 });
    expect(split.sameCabin + split.business).toBe(2);
  });

  it('全员升舱：2 人 2 人升舱 → 经济舱 0、商务舱 2', () => {
    expect(computeBundleSeatSplit('ECONOMY', 2, 2)).toEqual({ sameCabin: 0, business: 2 });
  });

  it('升舱人数超过本段人数 → clamp 到本段人数（不会出现负的经济舱占座）', () => {
    expect(computeBundleSeatSplit('ECONOMY', 2, 5)).toEqual({ sameCabin: 0, business: 2 });
  });

  it('非经济舱航段不拆：BUSINESS 行即便带 businessUpgradeCount 也全额留本舱', () => {
    expect(computeBundleSeatSplit('BUSINESS', 2, 1)).toEqual({ sameCabin: 2, business: 0 });
  });
});

// ── 出行人数校验口径：computeRequiredPassengerCount ───────────────────────
// 正确模型：往返同一批人，按「单程最大人数」取 MAX 不取 SUM；签证/接送/套餐同理。
describe('computeRequiredPassengerCount', () => {
  const flightLeg = (quantity: number, scheduleId = 'sched-go'): OrderItemInput => ({
    kind: 'FLIGHT',
    description: 'QH9589 经济舱',
    quantity,
    flightScheduleId: scheduleId,
    flightCabin: 'ECONOMY',
  });
  const bundleLine = (
    quantity: number,
    metadata?: Record<string, unknown>,
  ): OrderItemInput => ({
    kind: 'BUNDLE',
    description: '岘港 4 天 3 晚',
    quantity,
    bundleId: 'bundle-1',
    unitPrice: 1000,
    ...(metadata ? { metadata } : {}),
  });
  const visaLine = (quantity: number): OrderItemInput => ({
    kind: 'VISA',
    description: '越南签证',
    quantity,
    unitPrice: 300,
  });
  const transferLine = (quantity: number): OrderItemInput => ({
    kind: 'TRANSFER',
    description: '机场接送',
    quantity,
    unitPrice: 150,
  });

  it('往返机票（2 段各 2 人）→ 需 2 位（MAX 不是 SUM 的 4）', () => {
    // 这是本次修复的核心：旧 SUM 逻辑会错算成 4，新 MAX 逻辑算 2
    expect(
      computeRequiredPassengerCount([flightLeg(2, 'sched-go'), flightLeg(2, 'sched-ret')]),
    ).toBe(2);
  });

  it('单程单航段 2 人 → 需 2 位（与旧行为一致，向后兼容）', () => {
    expect(computeRequiredPassengerCount([flightLeg(2)])).toBe(2);
  });

  it('往返人数不同（去 3 / 回 2，理论异常）→ 取最大段 3', () => {
    expect(
      computeRequiredPassengerCount([flightLeg(3, 'sched-go'), flightLeg(2, 'sched-ret')]),
    ).toBe(3);
  });

  it('套餐 + 往返机票（套餐 pax=2，2 段各 2 人）→ 需 2 位', () => {
    expect(
      computeRequiredPassengerCount([
        flightLeg(2, 'sched-go'),
        flightLeg(2, 'sched-ret'),
        bundleLine(1, { pax: 2 }),
      ]),
    ).toBe(2);
  });

  it('套餐无 metadata.pax → 回退到行 quantity', () => {
    expect(computeRequiredPassengerCount([bundleLine(3)])).toBe(3);
  });

  it('多份套餐叠加：pax 2 + pax 1 → 3 位', () => {
    expect(
      computeRequiredPassengerCount([bundleLine(1, { pax: 2 }), bundleLine(1, { pax: 1 })]),
    ).toBe(3);
  });

  it('纯签证 3 张 → 需 3 位', () => {
    expect(computeRequiredPassengerCount([visaLine(3)])).toBe(3);
  });

  it('纯接送 2 → 需 2 位', () => {
    expect(computeRequiredPassengerCount([transferLine(2)])).toBe(2);
  });

  it('混买取最大维度：往返机票 2 人 + 签证 4 张 → 需 4 位', () => {
    expect(
      computeRequiredPassengerCount([
        flightLeg(2, 'sched-go'),
        flightLeg(2, 'sched-ret'),
        visaLine(4),
      ]),
    ).toBe(4);
  });

  it('仅酒店（无按人产品）→ 0，不触发出行人校验', () => {
    const hotel: OrderItemInput = {
      kind: 'HOTEL',
      description: '海景房 3 晚',
      quantity: 1,
      unitPrice: 800,
    };
    expect(computeRequiredPassengerCount([hotel])).toBe(0);
  });

  it('套餐畸形 metadata.pax（非法格式）→ 降级回退行 quantity，不抛错', () => {
    expect(computeRequiredPassengerCount([bundleLine(2, { pax: 'garbage' })])).toBe(2);
  });

  // ── 占座模型：套餐出行人 = headCount（成人 + 占座儿童 + 不占座婴儿）─────────
  const bundleWithCounts = (
    adultCount: number,
    childCount: number,
    infantCount: number,
  ): OrderItemInput => ({
    kind: 'BUNDLE',
    description: '岘港 4 天 3 晚',
    quantity: 1,
    bundleId: 'bundle-1',
    unitPrice: 1000,
    adultCount,
    childCount,
    infantCount,
  });

  it('2 大 1 小 1 婴 → 需 4 位（婴儿也是出行人，需护照）', () => {
    // 占座核心场景：占座 3，出行人 4
    expect(computeRequiredPassengerCount([bundleWithCounts(2, 1, 1)])).toBe(4);
  });

  it('2 大 1 小 1 婴 + 占座往返机票（各 3 座）→ 需 4 位（headCount=4 > seatPax=3）', () => {
    // FLIGHT 行 quantity = seatPax = 3（占座），但出行人按 headCount=4 校验
    expect(
      computeRequiredPassengerCount([
        flightLeg(3, 'sched-go'),
        flightLeg(3, 'sched-ret'),
        bundleWithCounts(2, 1, 1),
      ]),
    ).toBe(4);
  });

  it('纯 2 大（无小孩婴儿）→ 需 2 位（与旧版 pax=2 一致，向后兼容）', () => {
    expect(computeRequiredPassengerCount([bundleWithCounts(2, 0, 0)])).toBe(2);
  });

  it('metadata 三计数（前台只塞 metadata）→ headCount 同样生效', () => {
    expect(
      computeRequiredPassengerCount([bundleLine(1, { adultCount: 1, childCount: 1, infantCount: 1 })]),
    ).toBe(3);
  });

  it('多份套餐叠加 headCount：(2 大 1 婴) + (1 大) → 4 位', () => {
    expect(
      computeRequiredPassengerCount([bundleWithCounts(2, 0, 1), bundleWithCounts(1, 0, 0)]),
    ).toBe(4);
  });
});

// ── 签证订单：护照有效期必填 assertVisaPassengersHavePassportExpiry ────
describe('assertVisaPassengersHavePassportExpiry', () => {
  const visaItem = { kind: 'VISA' as const };
  const flightItem = { kind: 'FLIGHT' as const };
  const pxFilled = { passportExpiry: '2030-01-01' };
  const pxMissing = { passportExpiry: undefined };

  it('含 VISA 行且有乘客缺护照有效期 → BadRequestError', () => {
    expect(() =>
      assertVisaPassengersHavePassportExpiry([flightItem, visaItem], [pxFilled, pxMissing]),
    ).toThrow('签证订单每位出行人需填写护照有效期');
  });

  it('含 VISA 行且全部乘客已填 → 通过', () => {
    expect(() =>
      assertVisaPassengersHavePassportExpiry([visaItem], [pxFilled, pxFilled]),
    ).not.toThrow();
  });

  it('不含 VISA 行 → 缺有效期也不拦截', () => {
    expect(() =>
      assertVisaPassengersHavePassportExpiry([flightItem], [pxMissing]),
    ).not.toThrow();
  });
});

// ── 公开下单端点（前台散客/游客/自助代理/小程序共用）：护照有效期必填 ────────
// 全渠道强制口径：POST /orders 走 createOrderBodySchema，schema 层即拦缺失/格式错，
// 文案指到第几位出行人（0 基下标路径客人看不懂）。
describe('createOrderBodySchema · 护照有效期全渠道必填', () => {
  const passenger = (patch: Record<string, unknown> = {}) => ({
    fullName: '张三',
    documentNumber: 'E12345678',
    dateOfBirth: '1990-01-01',
    passportExpiry: '2031-01-01',
    ...patch,
  });
  const bodyWith = (passengers: unknown[]) => ({
    contactName: '联系人',
    contactPhone: '13800000000',
    items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
    passengers,
  });

  it('全部出行人已填 → 解析通过', () => {
    const r = createOrderBodySchema.safeParse(bodyWith([passenger(), passenger()]));
    expect(r.success).toBe(true);
  });

  it('某位缺护照有效期 → 拒绝，且文案指明第几位出行人', () => {
    const r = createOrderBodySchema.safeParse(
      bodyWith([passenger(), passenger({ passportExpiry: undefined })]),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) => i.message.includes('第 2 位出行人') && i.message.includes('护照有效期必填'),
        ),
      ).toBe(true);
    }
  });

  it('空串 / 非 YYYY-MM-DD → 拒绝（格式校验不放松）', () => {
    expect(createOrderBodySchema.safeParse(bodyWith([passenger({ passportExpiry: '' })])).success)
      .toBe(false);
    expect(
      createOrderBodySchema.safeParse(bodyWith([passenger({ passportExpiry: '2031/01/01' })]))
        .success,
    ).toBe(false);
  });

  it('纯酒店单（无按人出行产品行）→ 出行人缺有效期不拦（占位出行人无护照资料）', () => {
    const r = createOrderBodySchema.safeParse({
      contactName: '联系人',
      contactPhone: '13800000000',
      items: [{ kind: 'HOTEL', description: '海景房 2 晚', quantity: 2, unitPrice: 600 }],
      passengers: [
        { fullName: '联系人', documentNumber: 'N/A', dateOfBirth: '1990-01-01', nationality: 'CN' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('机票行 → 同样必填（不分渠道，公开端点与后台单录同一 schema）', () => {
    const r = createOrderBodySchema.safeParse({
      contactName: '联系人',
      contactPhone: '13800000000',
      items: [
        {
          kind: 'FLIGHT',
          description: 'CZ123',
          quantity: 1,
          flightScheduleId: 'fs-1',
          flightCabin: 'ECONOMY',
        },
      ],
      passengers: [passenger({ passportExpiry: undefined })],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('第 1 位出行人'))).toBe(true);
    }
  });
});

// ── 套餐 fan-out：createFulfillmentTasks 把 BUNDLE 项拆成 per-component 地面岗任务 ──
// 根因：旧逻辑 BUNDLE→单一 BUNDLE_COMPOSITE，签证/酒店/地面岗永远看不到套餐单。
// 修复：反查 Bundle.items 组件 kind，fan-out 成 HOTEL_BOOKING / VISA_APPLICATION / TRANSFER_DISPATCH。
describe('createFulfillmentTasks · 套餐 fan-out 到地面岗', () => {
  // 构造一个可控的假 tx（TransactionClient stub）：
  //   orderItem.findMany → 返回给定订单项；bundle.findUnique → 返回给定套餐 items；
  //   fulfillmentTask.create → 记录所有写入，返回带 id 的任务。
  function makeTx(opts: {
    items: Array<{
      id: string;
      kind: string;
      bundleId?: string | null;
      fulfillmentTasks?: Array<{ type: string }>;
    }>;
    bundleItems?: Array<{ kind: string }> | null;
    // 订单级签证状态（缺省 null = 不需要订单级补签证任务）
    visaStatus?: string | null;
    // 乘客级自备签（缺省一位随团办签 → 签证任务照建，与本组用例原有意图一致）
    passengers?: Array<{ visaExempt: boolean }>;
  }) {
    const created: Array<{ orderItemId: string; type: string; status: string }> = [];
    let seq = 0;
    const tx = {
      order: {
        findUnique: vi.fn().mockResolvedValue({ visaStatus: opts.visaStatus ?? null }),
      },
      passenger: {
        findMany: vi.fn().mockResolvedValue(opts.passengers ?? [{ visaExempt: false }]),
      },
      orderItem: {
        findMany: vi.fn().mockResolvedValue(
          opts.items.map((it) => ({
            id: it.id,
            kind: it.kind,
            bundleId: it.bundleId ?? null,
            fulfillmentTasks: it.fulfillmentTasks ?? [],
          })),
        ),
      },
      bundle: {
        findUnique: vi.fn().mockResolvedValue(
          opts.bundleItems === null ? null : { items: opts.bundleItems ?? [] },
        ),
      },
      fulfillmentTask: {
        create: vi.fn().mockImplementation(async ({ data }: { data: { orderItemId: string; type: string; status: string } }) => {
          created.push(data);
          return { id: `task_${++seq}`, ...data };
        }),
      },
    };
    return { tx, created };
  }

  const run = async (tx: unknown) =>
    createFulfillmentTasks(tx as Parameters<typeof createFulfillmentTasks>[0], 'ord1');

  it('套餐含 VISA 组件 → 生成 VISA_APPLICATION 任务（核心修复：签证岗能看到套餐单）', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
      bundleItems: [
        { kind: 'FLIGHT' },
        { kind: 'HOTEL' },
        { kind: 'VISA' },
      ],
    });
    const ids = await run(tx);
    const types = created.map((c) => c.type);
    expect(types).toContain('VISA_APPLICATION');
    expect(types).toContain('HOTEL_BOOKING');
    // FLIGHT 组件不从套餐生成（套餐另落 FLIGHT 订单项）
    expect(types).not.toContain('FLIGHT_TICKETING');
    // 不再生成 BUNDLE_COMPOSITE 占位
    expect(types).not.toContain('BUNDLE_COMPOSITE');
    expect(ids).toHaveLength(2);
    expect(created.every((c) => c.status === 'PENDING')).toBe(true);
    expect(created.every((c) => c.orderItemId === 'itm_bundle')).toBe(true);
  });

  it('套餐不含 VISA → 不生成签证任务，但酒店任务恒有', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_no_visa' }],
      bundleItems: [{ kind: 'FLIGHT' }, { kind: 'HOTEL' }, { kind: 'TRANSFER' }],
    });
    await run(tx);
    const types = created.map((c) => c.type);
    expect(types).not.toContain('VISA_APPLICATION');
    expect(types).toContain('HOTEL_BOOKING');
    expect(types).toContain('TRANSFER_DISPATCH');
  });

  // ── 乘客级一票否决（口径：本单存在至少一位需要我方代办签证的乘客）──────────
  // 签证台按 visaExempt=false 过滤乘客展示，全员自备签若仍建任务 → 点进去零乘客的空壳。
  it('混合单：一位自备签 + 一位要代办 → 签证任务照建', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
      passengers: [{ visaExempt: true }, { visaExempt: false }],
    });
    await run(tx);
    expect(created.map((c) => c.type)).toContain('VISA_APPLICATION');
  });

  it('全员自备签 + 套餐含 VISA 组件 → 不建签证任务，酒店任务不受影响', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
      passengers: [{ visaExempt: true }, { visaExempt: true }],
    });
    await run(tx);
    const types = created.map((c) => c.type);
    expect(types).not.toContain('VISA_APPLICATION');
    expect(types).toContain('HOTEL_BOOKING');
  });

  it('全员自备签 + 订单级 visaStatus=NEEDED → 订单级兜底也不建', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_flight', kind: 'FLIGHT' }],
      visaStatus: 'NEEDED',
      passengers: [{ visaExempt: true }],
    });
    await run(tx);
    expect(created.map((c) => c.type)).not.toContain('VISA_APPLICATION');
  });

  it('未录乘客 + 订单级 visaStatus=NEEDED → 仍建（空名单 ≠ 无人需要，不漏单）', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_flight', kind: 'FLIGHT' }],
      visaStatus: 'NEEDED',
      passengers: [],
    });
    await run(tx);
    expect(created.map((c) => c.type)).toContain('VISA_APPLICATION');
  });

  it('套餐组件解析不到（套餐被删）→ 优雅降级至少建 HOTEL_BOOKING', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_gone' }],
      bundleItems: null, // findUnique 返回 null
    });
    await run(tx);
    expect(created.map((c) => c.type)).toEqual(['HOTEL_BOOKING']);
  });

  it('同类组件去重：两段 TRANSFER → 只开一个 TRANSFER_DISPATCH', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_2transfer' }],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'TRANSFER' }, { kind: 'TRANSFER' }],
    });
    await run(tx);
    const transferCount = created.filter((c) => c.type === 'TRANSFER_DISPATCH').length;
    expect(transferCount).toBe(1);
  });

  it('幂等：套餐已有 HOTEL_BOOKING、缺 VISA → 只补 VISA，不重复建酒店', async () => {
    const { tx, created } = makeTx({
      items: [
        {
          id: 'itm_bundle',
          kind: 'BUNDLE',
          bundleId: 'bdl_visa',
          fulfillmentTasks: [{ type: 'HOTEL_BOOKING' }], // 已存在
        },
      ],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
    });
    const ids = await run(tx);
    expect(created.map((c) => c.type)).toEqual(['VISA_APPLICATION']); // 只补缺失类型
    expect(ids).toHaveLength(1);
  });

  it('幂等：全类型已存在 → 重跑零新建', async () => {
    const { tx, created } = makeTx({
      items: [
        {
          id: 'itm_bundle',
          kind: 'BUNDLE',
          bundleId: 'bdl_visa',
          fulfillmentTasks: [{ type: 'HOTEL_BOOKING' }, { type: 'VISA_APPLICATION' }],
        },
      ],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
    });
    const ids = await run(tx);
    expect(created).toHaveLength(0);
    expect(ids).toHaveLength(0);
  });

  it('非套餐项仍是一行一任务（FLIGHT→FLIGHT_TICKETING、HOTEL→HOTEL_BOOKING）', async () => {
    const { tx, created } = makeTx({
      items: [
        { id: 'itm_flight', kind: 'FLIGHT' },
        { id: 'itm_hotel', kind: 'HOTEL' },
      ],
    });
    await run(tx);
    expect(created).toEqual([
      { orderItemId: 'itm_flight', type: 'FLIGHT_TICKETING', status: 'PENDING' },
      { orderItemId: 'itm_hotel', type: 'HOTEL_BOOKING', status: 'PENDING' },
    ]);
  });

  // ── 订单级「需要签证」也进签证台 ─────────────────────────────────────
  it('visaStatus=NEEDED 且无任何签证任务（纯机票单）→ 补一条 VISA_APPLICATION 挂首项', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_flight', kind: 'FLIGHT' }],
      visaStatus: 'NEEDED',
    });
    await run(tx);
    expect(created).toEqual([
      { orderItemId: 'itm_flight', type: 'FLIGHT_TICKETING', status: 'PENDING' },
      { orderItemId: 'itm_flight', type: 'VISA_APPLICATION', status: 'PENDING' },
    ]);
  });

  it('visaStatus=NEEDED 但已有签证任务（套餐含 VISA 组件）→ 不重复补', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
      visaStatus: 'NEEDED',
    });
    await run(tx);
    const visaCount = created.filter((c) => c.type === 'VISA_APPLICATION').length;
    expect(visaCount).toBe(1); // 套餐组件已建一条，不再额外补
  });

  it('visaStatus=NEEDED 幂等：已存在 VISA_APPLICATION → 重跑零新建', async () => {
    const { tx, created } = makeTx({
      items: [
        {
          id: 'itm_flight',
          kind: 'FLIGHT',
          fulfillmentTasks: [{ type: 'FLIGHT_TICKETING' }, { type: 'VISA_APPLICATION' }],
        },
      ],
      visaStatus: 'NEEDED',
    });
    const ids = await run(tx);
    expect(created).toHaveLength(0);
    expect(ids).toHaveLength(0);
  });

  it('visaStatus=E_VISA（电子签·三个月多次，需送签）→ 同 NEEDED 补一条 VISA_APPLICATION', async () => {
    const { tx, created } = makeTx({
      items: [{ id: 'itm_flight', kind: 'FLIGHT' }],
      visaStatus: 'E_VISA',
    });
    await run(tx);
    expect(created).toContainEqual({
      orderItemId: 'itm_flight',
      type: 'VISA_APPLICATION',
      status: 'PENDING',
    });
  });

  it('visaStatus=NOT_NEEDED/HAS_VISA → 不补订单级签证任务', async () => {
    for (const visaStatus of ['NOT_NEEDED', 'HAS_VISA']) {
      const { tx, created } = makeTx({
        items: [{ id: 'itm_flight', kind: 'FLIGHT' }],
        visaStatus,
      });
      await run(tx);
      expect(created.map((c) => c.type)).not.toContain('VISA_APPLICATION');
    }
  });
});

// ── 代理归属解析（运营代下单选代理）─────────────────────────────────────
describe('resolveOrderAgentId · 代理归属', () => {
  beforeEach(() => {
    mockPrisma.agent.findUnique.mockReset();
  });

  it('ADMIN 传有效 agentId → 校验通过后归属该代理（佣金链按 order.agentId 跑，与代理自下单一致）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent_target', isActive: true });
    const resolved = await resolveOrderAgentId(
      { userId: 'u_admin', role: 'ADMIN' },
      'agent_target',
    );
    expect(resolved).toBe('agent_target');
    expect(mockPrisma.agent.findUnique).toHaveBeenCalledWith({
      where: { id: 'agent_target' },
      select: { id: true, isActive: true },
    });
  });

  it('STAFF 传有效 agentId → 同样归属该代理', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent_target', isActive: true });
    const resolved = await resolveOrderAgentId(
      { userId: 'u_staff', role: 'STAFF' },
      'agent_target',
    );
    expect(resolved).toBe('agent_target');
  });

  it('AGENT 自助下单忽略 body.agentId，永远归属自己（代理不能替他人记单）', async () => {
    const resolved = await resolveOrderAgentId(
      { userId: 'u_agent', role: 'AGENT', agentId: 'agent_self' },
      'agent_someone_else',
    );
    expect(resolved).toBe('agent_self');
    // 不应查库校验他人代理
    expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('ADMIN 不传 agentId → 直客单（null）', async () => {
    const resolved = await resolveOrderAgentId({ userId: 'u_admin', role: 'ADMIN' }, undefined);
    expect(resolved).toBeNull();
    expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('ADMIN 传不存在的 agentId → 抛错（拒单）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue(null);
    await expect(
      resolveOrderAgentId({ userId: 'u_admin', role: 'ADMIN' }, 'agent_ghost'),
    ).rejects.toThrow(/不存在/);
  });

  it('ADMIN 传已停用的 agentId → 抛错（拒单）', async () => {
    mockPrisma.agent.findUnique.mockResolvedValue({ id: 'agent_off', isActive: false });
    await expect(
      resolveOrderAgentId({ userId: 'u_admin', role: 'ADMIN' }, 'agent_off'),
    ).rejects.toThrow(/停用/);
  });

  it('CUSTOMER 自助下单 → 无代理归属（null），不查库', async () => {
    const resolved = await resolveOrderAgentId(
      { userId: 'u_cust', role: 'CUSTOMER' },
      'agent_target',
    );
    expect(resolved).toBeNull();
    expect(mockPrisma.agent.findUnique).not.toHaveBeenCalled();
  });
});

// ── 订单级签证状态 + 结构化备注四栏：schema 受理 + serializer 暴露 ────────────
describe('订单签证状态 + 结构化备注四栏', () => {
  const onePassenger = {
    fullName: '张三',
    documentNumber: 'E12345678',
    dateOfBirth: '1990-01-01',
    // 批量建单（新建路径）护照有效期必填
    passportExpiry: '2031-01-01',
  };
  const structured = {
    visaStatus: 'E_VISA' as const,
    noteHotel: '海景房 2 间',
    noteVisa: '电子签待出',
    notePayment: '已付定金 ¥2000',
    noteSpecial: '蜜月布置',
  };

  it('createOrderBodySchema 受理 visaStatus + 四栏结构化备注', () => {
    const parsed = createOrderBodySchema.parse({
      contactName: '张三',
      contactPhone: '13800000000',
      items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
      passengers: [onePassenger],
      ...structured,
    });
    expect(parsed.visaStatus).toBe('E_VISA');
    expect(parsed.noteHotel).toBe('海景房 2 间');
    expect(parsed.noteVisa).toBe('电子签待出');
    expect(parsed.notePayment).toBe('已付定金 ¥2000');
    expect(parsed.noteSpecial).toBe('蜜月布置');
  });

  it('createOrderBodySchema 四栏全缺省 → 解析通过（向后兼容，老客户端不传）', () => {
    const parsed = createOrderBodySchema.parse({
      contactName: '张三',
      contactPhone: '13800000000',
      items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
      passengers: [onePassenger],
    });
    expect(parsed.visaStatus).toBeUndefined();
    expect(parsed.noteHotel).toBeUndefined();
  });

  it('结构化备注单栏超 300 字 → 拒绝', () => {
    expect(() =>
      createOrderBodySchema.parse({
        contactName: '张三',
        contactPhone: '13800000000',
        items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
        passengers: [onePassenger],
        noteHotel: 'x'.repeat(301),
      }),
    ).toThrow();
  });

  it('非法 visaStatus 枚举值 → 拒绝', () => {
    expect(() =>
      createOrderBodySchema.parse({
        contactName: '张三',
        contactPhone: '13800000000',
        items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
        passengers: [onePassenger],
        visaStatus: 'MAYBE',
      }),
    ).toThrow();
  });

  it('batchCreateOrdersBodySchema 受理 visaStatus + 四栏（整批共用）', () => {
    const parsed = batchCreateOrdersBodySchema.parse({
      flightScheduleId: 'fs1',
      flightCabin: 'ECONOMY',
      description: 'QH9589 澳门→岘港 2026-06-01 经济舱',
      passengers: [{ ...onePassenger, businessUpgrade: true }],
      ...structured,
    });
    expect(parsed.visaStatus).toBe('E_VISA');
    expect(parsed.notePayment).toBe('已付定金 ¥2000');
    expect(parsed.passengers[0].businessUpgrade).toBe(true);
  });

  it('getOrder：serializer 透传 visaStatus + 四栏结构化备注（详情读路径）', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        visaStatus: 'E_VISA',
        noteHotel: '海景房 2 间',
        noteVisa: '电子签待出',
        notePayment: '已付定金 ¥2000',
        noteSpecial: '蜜月布置',
        notes: '客户原始自由备注（兼容保留）',
      }),
    );
    // ADMIN 直接通过 assertCanView
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    expect(result.visaStatus).toBe('E_VISA');
    expect(result.noteHotel).toBe('海景房 2 间');
    expect(result.noteVisa).toBe('电子签待出');
    expect(result.notePayment).toBe('已付定金 ¥2000');
    expect(result.noteSpecial).toBe('蜜月布置');
    // 兼容：老的 notes 字段仍然存在
    expect(result.notes).toBe('客户原始自由备注（兼容保留）');
  });
});

// ── 护照签发地点 passportIssuePlace（OCR 或手填，选填）────────────────────
// 自由文本（如"广东省广州市"），区别于 ISO-2 颁发国 passportIssueCountry。
describe('乘客护照签发地点 passportIssuePlace', () => {
  const basePassenger = {
    fullName: '张三',
    documentNumber: 'E12345678',
    dateOfBirth: '1990-01-01',
    // 护照有效期全渠道必填（含公开下单端点）→ 基础夹具必须带
    passportExpiry: '2031-01-01',
  };

  it('passengerInputSchema 受理 passportIssuePlace 自由文本（≤120 字）', () => {
    const parsed = createOrderBodySchema.parse({
      contactName: '张三',
      contactPhone: '13800000000',
      items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
      passengers: [{ ...basePassenger, passportIssuePlace: '广东省广州市' }],
    });
    expect(parsed.passengers[0].passportIssuePlace).toBe('广东省广州市');
  });

  it('passportIssuePlace 缺省 → 解析通过（选填，向后兼容手填/老客户端）', () => {
    const parsed = createOrderBodySchema.parse({
      contactName: '张三',
      contactPhone: '13800000000',
      items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
      passengers: [basePassenger],
    });
    expect(parsed.passengers[0].passportIssuePlace).toBeUndefined();
  });

  it('passportIssuePlace 超 120 字 → 拒绝', () => {
    expect(() =>
      createOrderBodySchema.parse({
        contactName: '张三',
        contactPhone: '13800000000',
        items: [{ kind: 'VISA', description: '泰国签证', quantity: 1, unitPrice: 300 }],
        passengers: [{ ...basePassenger, passportIssuePlace: '市'.repeat(121) }],
      }),
    ).toThrow();
  });

  it('getOrder：serializer 透传乘客 passportIssuePlace（passengers select=true，读路径不剥字段）', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        passengers: [
          {
            id: 'px1',
            fullName: '张三',
            passportIssueCountry: 'CN',
            passportIssuePlace: '广东省广州市',
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    expect(result.passengers[0].passportIssuePlace).toBe('广东省广州市');
    // 与 ISO-2 颁发国是两个独立字段，各自透传
    expect(result.passengers[0].passportIssueCountry).toBe('CN');
  });
});

// ── 0702 反馈 1：订单详情行程单（套餐订单「产品内容」板块）────────────────────
// getOrder 联查 flightSchedule/bundle/visa/transfer/hotelRoomType 后，serializeOrder 应把渲染
// 行程单所需字段（航班号/出发日期时间/到达时间/航线/舱位、套餐名/服务内容）附加到每条订单行上，
// ADDITIVE，不改动既有 unitPrice/amount/hotelName 等字段的既有行为。
describe('getOrder：套餐订单行程单渲染字段（ADDITIVE）', () => {
  it('FLIGHT 行联查 flightSchedule → 透出 flightNumber/departureDate/departureTime/arrivalTime/route/cabin', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        items: [
          {
            id: 'itm-flight',
            kind: 'FLIGHT',
            description: '去程',
            quantity: 2,
            unitPrice: dec(2100),
            amount: dec(4200),
            flightCabin: 'ECONOMY',
            bundleId: 'bdl1',
            flightSchedule: {
              departureTime: new Date('2026-07-11T08:40:00.000Z'),
              arrivalTime: new Date('2026-07-11T09:35:00.000Z'),
              flight: { flightNumber: 'QH9589', originCode: 'MFM', destinationCode: 'DAD' },
            },
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    const item = result.items[0];
    expect(item.flightNumber).toBe('QH9589');
    expect(item.departureDate).toBe('2026-07-11');
    expect(item.departureTime).toBe('08:40');
    expect(item.arrivalTime).toBe('09:35');
    expect(item.route).toBe('MFM→DAD');
    expect(item.cabin).toBe('ECONOMY');
    // 既有字段（unitPrice/amount 的 Decimal→string 转换）不受影响
    expect(item.unitPrice).toBe('2100');
    expect(item.amount).toBe('4200');
  });

  it('BUNDLE 行联查 bundle → 透出 bundleName/serviceNotes；未联查关系时安全落 null', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        items: [
          {
            id: 'itm-bundle',
            kind: 'BUNDLE',
            description: '套餐',
            quantity: 1,
            unitPrice: dec(1378),
            amount: dec(1378),
            bundleId: 'bdl1',
            bundle: {
              name: '澳门-岘港 5 天 4 晚',
              serviceNotes: '中文客服，越南当地机场助签\n举牌接机，送至酒店并协助分房',
            },
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    const item = result.items[0];
    expect(item.bundleName).toBe('澳门-岘港 5 天 4 晚');
    expect(item.serviceNotes).toBe('中文客服，越南当地机场助签\n举牌接机，送至酒店并协助分房');
    // 该行没有联查 flightSchedule/visa/transfer/hotelRoomType → 对应字段安全落 null，不抛错
    expect(item.flightNumber).toBeNull();
    expect(item.visaName).toBeNull();
    expect(item.transferProductName).toBeNull();
    expect(item.roomTypeName).toBeNull();
  });

  it('order.passengers 按 passengerType 统计 → adultCount/childCount/infantCount', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        passengers: [
          { id: 'p1', fullName: '张三', passengerType: 'ADULT' },
          { id: 'p2', fullName: '李四', passengerType: 'ADULT' },
          { id: 'p3', fullName: '张小明', passengerType: 'CHILD' },
          { id: 'p4', fullName: '张小宝', passengerType: 'INFANT' },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    expect(result.adultCount).toBe(2);
    expect(result.childCount).toBe(1);
    expect(result.infantCount).toBe(1);
  });
});

// ── 0702 反馈：产品内容卡片 v2 — 套餐组件构成派生（summarizeBundleItems） ──────────
// bundle.items JSON → bundleKinds / transfers[{name,qty}] / visa{name,stayDays}。
// 纯函数：不查库（stayDays 由调用方批量查好，作为 visaStayDaysById 传入）。
describe('summarizeBundleItems', () => {
  it('全组件套餐（FLIGHT+HOTEL+TRANSFER+VISA）→ 正确拆出 kinds/transfers/visa', () => {
    const summary = summarizeBundleItems(
      [
        { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱', qty: 1, unitPrice: 0 },
        { kind: 'HOTEL', productName: '岘港凯悦度假村 美溪海景房', qty: 3, unitPrice: 2162 },
        {
          kind: 'TRANSFER',
          productName: '岘港机场接送（来回 7 座商务车）',
          qty: 2,
          unitPrice: 188,
          transferId: 'trf1',
        },
        { kind: 'VISA', productName: '越南 E-visa 30 天 × 2 人', qty: 2, unitPrice: 280, visaId: 'visa1' },
      ],
      new Map([['visa1', 30]]),
    );
    expect(summary.bundleKinds.sort()).toEqual(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA'].sort());
    expect(summary.transfers).toEqual([{ name: '岘港机场接送（来回 7 座商务车）', qty: 2 }]);
    expect(summary.visa).toEqual({ name: '越南 E-visa 30 天 × 2 人', visaId: 'visa1', stayDays: 30 });
  });

  it('多条 TRANSFER 组件 → 全部列出（不只取第一条）', () => {
    const summary = summarizeBundleItems([
      { kind: 'TRANSFER', productName: '接机', qty: 1, unitPrice: 100, transferId: 't1' },
      { kind: 'TRANSFER', productName: '送机', qty: 1, unitPrice: 100, transferId: 't2' },
    ]);
    expect(summary.transfers).toEqual([
      { name: '接机', qty: 1 },
      { name: '送机', qty: 1 },
    ]);
  });

  it('VISA 组件的 visaId 在 visaStayDaysById 里查不到 → stayDays 落 null（不抛错）', () => {
    const summary = summarizeBundleItems(
      [{ kind: 'VISA', productName: '越南签证', qty: 1, unitPrice: 280, visaId: 'visa-unknown' }],
      new Map([['visa1', 30]]), // 不含 visa-unknown
    );
    expect(summary.visa).toEqual({ name: '越南签证', visaId: 'visa-unknown', stayDays: null });
  });

  it('只有 FLIGHT+HOTEL 的套餐（无接送/签证）→ transfers 空数组、visa 为 null', () => {
    const summary = summarizeBundleItems([
      { kind: 'FLIGHT', productName: 'QH 往返', qty: 1, unitPrice: 0 },
      { kind: 'HOTEL', productName: '海景房', qty: 2, unitPrice: 800 },
    ]);
    expect(summary.bundleKinds.sort()).toEqual(['FLIGHT', 'HOTEL']);
    expect(summary.transfers).toEqual([]);
    expect(summary.visa).toBeNull();
  });

  it('items 非数组 / null / 元素畸形 → 安全降级为空摘要，不抛错', () => {
    expect(summarizeBundleItems(null)).toEqual({ bundleKinds: [], transfers: [], visa: null });
    expect(summarizeBundleItems(undefined)).toEqual({ bundleKinds: [], transfers: [], visa: null });
    expect(summarizeBundleItems('not-an-array')).toEqual({ bundleKinds: [], transfers: [], visa: null });
    // 元素非对象 / kind 不识别 / 字段类型错误 → 逐条跳过，其余正常条目仍解析
    const summary = summarizeBundleItems([
      null,
      42,
      { kind: 'UNKNOWN_KIND', productName: 'x', qty: 1 },
      { kind: 'TRANSFER', productName: '正常接送', qty: 1, unitPrice: 100, transferId: 't1' },
    ] as never);
    expect(summary.transfers).toEqual([{ name: '正常接送', qty: 1 }]);
  });

  it('TRANSFER 缺 productName / qty 非法 → 名称兜底「接送服务」、qty 兜底 1', () => {
    const summary = summarizeBundleItems([
      { kind: 'TRANSFER', qty: -5, unitPrice: 100, transferId: 't1' },
      { kind: 'TRANSFER', productName: '  ', qty: 'not-a-number', unitPrice: 100, transferId: 't2' },
    ] as never);
    expect(summary.transfers).toEqual([
      { name: '接送服务', qty: 1 }, // qty=-5 → 兜底 1（不允许负数/0 趟）
      { name: '接送服务', qty: 1 }, // 空白 productName 视为缺失；qty 非数字 → 兜底 1
    ]);
  });
});

// ── 0702 反馈：产品内容卡片 v2 — 按人头单价反推（deriveBundlePerAgeUnitPrices） ────
// 由 order.total（服务端权威重算后的实付总额）反推成人/儿童/婴儿单价，不臆造数字。
describe('deriveBundlePerAgeUnitPrices', () => {
  it('worked example：真实订单 FTM2026063016427（2 成人，total=10562，无儿童/婴儿）', () => {
    // 该套餐（经典度假 3 晚 · 凯悦海景）infantPriceCny=0，childSeatDiscountCnyPerPerson=30
    const result = deriveBundlePerAgeUnitPrices(
      10562,
      { adultCount: 2, childCount: 0, infantCount: 0 },
      { infantPriceCny: 0, childSeatDiscountCnyPerPerson: 30 },
    );
    // adultUnitPriceCny = round((10562 − 0 + 0) / 2) = 5281
    expect(result.adultUnitPriceCny).toBe(5281);
    // childUnitPriceCny = 5281 − 30 = 5251（本单无儿童，仍按配置算出展示价）
    expect(result.childUnitPriceCny).toBe(5251);
    expect(result.infantUnitPriceCny).toBe(0);
  });

  it('含儿童+婴儿：儿童折扣从均摊池里加回、婴儿价先从总额减掉，均摊人数=成人+儿童', () => {
    // 6 人：2 成人 + 2 儿童（占座儿童折扣 30/人）+ 2 婴儿（不占座，婴儿价 1000/人）
    // total = 假设服务端权威重算出 10680
    const result = deriveBundlePerAgeUnitPrices(
      10680,
      { adultCount: 2, childCount: 2, infantCount: 2 },
      { infantPriceCny: 1000, childSeatDiscountCnyPerPerson: 30 },
    );
    // adultUnitPriceCny = round((10680 − 2×1000 + 2×30) / (2+2)) = round(8740/4) = 2185
    expect(result.adultUnitPriceCny).toBe(2185);
    // childUnitPriceCny = 2185 − 30 = 2155
    expect(result.childUnitPriceCny).toBe(2155);
    expect(result.infantUnitPriceCny).toBe(1000);
    // 反向验证：Σ(单价×人数) 应约等于 total（婴儿价单独展示，不参与均摊池但仍是总额的一部分）
    const reconstructed =
      result.adultUnitPriceCny * 2 + result.childUnitPriceCny * 2 + result.infantUnitPriceCny * 2;
    expect(Math.abs(reconstructed - 10680)).toBeLessThanOrEqual(2); // round() 累计误差容差
  });

  it('adultCount+childCount=0（全婴儿的异常订单，理论不应发生）→ 除数保底 1，不除零', () => {
    const result = deriveBundlePerAgeUnitPrices(
      500,
      { adultCount: 0, childCount: 0, infantCount: 1 },
      { infantPriceCny: 500, childSeatDiscountCnyPerPerson: 30 },
    );
    // seatPax = max(1, 0) = 1 → adultUnitPriceCny = round((500 − 500 + 0) / 1) = 0（不抛错/不是 NaN）
    expect(result.adultUnitPriceCny).toBe(0);
    expect(Number.isFinite(result.adultUnitPriceCny)).toBe(true);
  });

  it('childSeatDiscountCnyPerPerson=0（套餐未配置儿童折扣）→ 儿童单价=成人单价', () => {
    const result = deriveBundlePerAgeUnitPrices(
      4000,
      { adultCount: 2, childCount: 0, infantCount: 0 },
      { infantPriceCny: 0, childSeatDiscountCnyPerPerson: 0 },
    );
    expect(result.adultUnitPriceCny).toBe(2000);
    expect(result.childUnitPriceCny).toBe(2000);
  });
});

// ── 0702 反馈：产品内容卡片 v2 — getOrder 端到端联查（bundle.items/visa/按人单价） ──
describe('getOrder：产品内容卡片 v2（套餐组件构成 + 按人单价，来自套餐定义而非订单行）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BUNDLE 行联查 bundle.items（全组件）→ bundleKinds/bundleTransfers/bundleVisa 来自套餐定义', async () => {
    const service = new OrderService();
    mockPrisma.visa.findMany.mockResolvedValue([{ id: 'visa1', stayDays: 30 }]);
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        items: [
          {
            id: 'itm-bundle',
            kind: 'BUNDLE',
            description: '套餐',
            quantity: 1,
            unitPrice: dec(5414),
            amount: dec(5414),
            bundleId: 'bdl1',
            bundle: {
              name: '经典度假 3 晚 · 凯悦海景',
              serviceNotes: null,
              items: [
                { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱', qty: 1, unitPrice: 0 },
                { kind: 'HOTEL', productName: '岘港凯悦度假村 美溪海景房', qty: 3, unitPrice: 2162 },
                {
                  kind: 'TRANSFER',
                  productName: '岘港机场接送（来回 7 座商务车）',
                  qty: 2,
                  unitPrice: 188,
                  transferId: 'trf1',
                },
                {
                  kind: 'VISA',
                  productName: '越南 E-visa 30 天 × 2 人',
                  qty: 2,
                  unitPrice: 280,
                  visaId: 'visa1',
                },
              ],
              infantPriceCny: 0,
              childSeatDiscountCnyPerPerson: 30,
              hotelRoomTypeId: 'rt1',
              hotelRoomType: { name: '海景大床房', hotel: { name: '岘港凯悦度假村' } },
            },
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    const item = result.items[0];
    expect(item.bundleKinds?.sort()).toEqual(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA'].sort());
    expect(item.bundleTransfers).toEqual([{ name: '岘港机场接送（来回 7 座商务车）', qty: 2 }]);
    expect(item.bundleVisa).toEqual({ name: '越南 E-visa 30 天 × 2 人', visaId: 'visa1', stayDays: 30 });
    // Visa.stayDays 查询确实按本单套餐的 visaId 发出（不是本地硬编码）
    expect(mockPrisma.visa.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['visa1'] } },
      select: { id: true, stayDays: true },
    });
    // 订单行自身未盖章 hotelRoomTypeId（老订单常见）时，酒店名/房型名回落到套餐定义自己的关联房型
    expect(item.hotelName).toBe('岘港凯悦度假村');
    expect(item.roomTypeName).toBe('海景大床房');
  });

  it('软删除套餐（isActive=false）仍正常联查——不按 isActive 过滤', async () => {
    // isActive 字段本身不在 select 里（getOrder 的 bundle select 没选它），这条用例验证的是
    // 「即便套餐已下架，只要 bundle 关联行还在，FK join 就照常返回数据」——这是 Prisma include
    // 的默认行为（不会因为关联行的其它字段值而跳过联查），这里用一个不含 isActive 的 bundle
    // 对象模拟软删除套餐的联查结果，断言字段仍正确透出。
    const service = new OrderService();
    mockPrisma.visa.findMany.mockResolvedValue([]);
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        items: [
          {
            id: 'itm-bundle',
            kind: 'BUNDLE',
            description: '套餐',
            quantity: 1,
            unitPrice: dec(1200),
            amount: dec(1200),
            bundleId: 'bdl-deleted',
            bundle: {
              name: '已下架套餐',
              serviceNotes: '中文客服',
              items: [{ kind: 'HOTEL', productName: '海景房', qty: 2, unitPrice: 600 }],
              infantPriceCny: 0,
              childSeatDiscountCnyPerPerson: 30,
              hotelRoomTypeId: null,
              hotelRoomType: null,
            },
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    expect(result.items[0].bundleName).toBe('已下架套餐');
    expect(result.items[0].bundleKinds).toEqual(['HOTEL']);
  });

  it('本单含 BUNDLE 行 → order 级 adultUnitPriceCny/childUnitPriceCny/infantUnitPriceCny 由 total 反推', async () => {
    const service = new OrderService();
    mockPrisma.visa.findMany.mockResolvedValue([]);
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        total: dec(10562),
        passengers: [
          { id: 'p1', fullName: 'A', passengerType: 'ADULT' },
          { id: 'p2', fullName: 'B', passengerType: 'ADULT' },
        ],
        items: [
          {
            id: 'itm-bundle',
            kind: 'BUNDLE',
            description: '套餐',
            quantity: 1,
            unitPrice: dec(5414),
            amount: dec(5414),
            bundleId: 'bdl1',
            bundle: {
              name: '经典度假 3 晚 · 凯悦海景',
              serviceNotes: null,
              items: [],
              infantPriceCny: 0,
              childSeatDiscountCnyPerPerson: 30,
              hotelRoomTypeId: null,
              hotelRoomType: null,
            },
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    // 与 deriveBundlePerAgeUnitPrices 单测的 worked example 同一组输入，结果应一致
    expect(result.adultUnitPriceCny).toBe(5281);
    expect(result.childUnitPriceCny).toBe(5251);
    expect(result.infantUnitPriceCny).toBe(0);
  });

  it('非套餐订单（无 BUNDLE 行）→ 按人头单价字段安全落 null，不抛错', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        total: dec(2100),
        items: [
          {
            id: 'itm-flight',
            kind: 'FLIGHT',
            description: '单程机票',
            quantity: 1,
            unitPrice: dec(2100),
            amount: dec(2100),
          },
        ],
      }),
    );
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    expect(result.adultUnitPriceCny).toBeNull();
    expect(result.childUnitPriceCny).toBeNull();
    expect(result.infantUnitPriceCny).toBeNull();
  });

  it('Visa.stayDays 查询失败（DB 异常）→ best-effort 降级，bundleVisa.stayDays 落 null，不阻断整单渲染', async () => {
    const service = new OrderService();
    mockPrisma.visa.findMany.mockRejectedValue(new Error('DB 连接超时'));
    mockPrisma.order.findUnique.mockResolvedValue(
      fakeFullOrder({
        userId: 'someone-else',
        items: [
          {
            id: 'itm-bundle',
            kind: 'BUNDLE',
            description: '套餐',
            quantity: 1,
            unitPrice: dec(1200),
            amount: dec(1200),
            bundleId: 'bdl1',
            bundle: {
              name: '套餐',
              serviceNotes: null,
              items: [{ kind: 'VISA', productName: '越南签证', qty: 1, unitPrice: 280, visaId: 'visa1' }],
              infantPriceCny: 0,
              childSeatDiscountCnyPerPerson: 30,
              hotelRoomTypeId: null,
              hotelRoomType: null,
            },
          },
        ],
      }),
    );
    // 不抛错，整单仍正常返回
    const result = await service.getOrder('ord1', { userId: 'admin1', role: 'ADMIN' });
    expect(result.items[0].bundleVisa).toEqual({ name: '越南签证', visaId: 'visa1', stayDays: null });
  });
});

// ── 0702 反馈 2：换人/编辑接受中文姓名 chineseName ────────────────────────────
describe('swapPassengerBodySchema · chineseName', () => {
  it('受理 chineseName（与下单时 passengerInputSchema 同款 ≤120 字约束）', () => {
    const parsed = swapPassengerBodySchema.parse({ chineseName: '庄宇' });
    expect(parsed.chineseName).toBe('庄宇');
  });

  it('仅传 chineseName 不视为空 PATCH（不触发"至少一项变更"拒绝）', () => {
    expect(() => swapPassengerBodySchema.parse({ chineseName: '庄宇' })).not.toThrow();
  });

  it('chineseName 超 120 字 → 拒绝', () => {
    expect(() => swapPassengerBodySchema.parse({ chineseName: '庄'.repeat(121) })).toThrow();
  });

  it('swapPassenger 服务层：chineseName 传入时写入 Prisma.PassengerUpdateInput.chineseName', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValueOnce({ id: 'ord1', adjustmentCny: 0, adjustments: [] });
    mockPrisma.passenger.findUnique.mockResolvedValueOnce({
      id: 'px1',
      orderId: 'ord1',
      fullName: 'ZHUANG, YU',
      documentNumber: 'E12345678',
    });
    mockPrisma.passenger.update.mockResolvedValueOnce({});
    mockPrisma.passenger.findUniqueOrThrow.mockResolvedValueOnce({
      fullName: 'ZHUANG, YU',
      documentNumber: 'E12345678',
    });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(fakeFullOrder({ id: 'ord1' }));

    await service.swapPassenger(
      'ord1',
      'px1',
      { chineseName: '庄宇' },
      { userId: 'admin1', role: 'ADMIN' },
    );

    expect(mockPrisma.passenger.update).toHaveBeenCalledWith({
      where: { id: 'px1' },
      data: { chineseName: '庄宇' },
    });
  });
});

// ── swapPassenger · 换人清洗（证件号变化清除旧护照/签证信息）─────────────
// 语义：换人后不残留前一个人的任何证件/签证信息；改错别字（证件号不变）不触发；
// 本请求带了新值就用新值（护照/证件相关字段随人走）。
describe('swapPassenger · 证件号变化触发旧护照/签证清洗', () => {
  beforeEach(() => {
    // clearAllMocks（保留模块级 $transaction 等实现）；orderItem.findMany 用持久 stub（见 armSwapMocks）
    // 而非 once，避免证件号不变用例不消费它时把 once 队列串到后续用例。
    vi.clearAllMocks();
  });

  function armSwapMocks(existingDoc: string) {
    mockPrisma.order.findUnique.mockResolvedValueOnce({ id: 'ord1', adjustmentCny: 0, adjustments: [] });
    mockPrisma.passenger.findUnique.mockResolvedValueOnce({
      id: 'px1',
      orderId: 'ord1',
      fullName: 'OLD, PERSON',
      documentNumber: existingDoc,
    });
    // 重复证件号校验（P1-8）：本订单无 FLIGHT 行 → 无班次 → 短路，不触达 passenger.findFirst。
    // 持久 stub（非 once）：证件号不变用例不消费它，避免 once 队列串到后续用例。
    mockPrisma.orderItem.findMany.mockResolvedValue([]);
    mockPrisma.passenger.update.mockResolvedValueOnce({});
    mockPrisma.passenger.findUniqueOrThrow.mockResolvedValueOnce({
      fullName: 'NEW, PERSON',
      documentNumber: 'NEW999',
    });
    mockPrisma.order.findUniqueOrThrow.mockResolvedValueOnce(fakeFullOrder({ id: 'ord1' }));
  }

  it('证件号变化 → 清空旧护照/签证/出生地字段（本次没带新值的一律置 null）', async () => {
    const service = new OrderService();
    armSwapMocks('OLD111');

    const { audit } = await service.swapPassenger(
      'ord1',
      'px1',
      { fullName: 'NEW PERSON', documentNumber: 'NEW999' },
      { userId: 'admin1', role: 'ADMIN' },
    );

    const data = mockPrisma.passenger.update.mock.calls[0][0].data;
    // 新身份字段用新值
    expect(data.documentNumber).toBe('NEW999');
    // 护照证件信息随人走 → 置空
    expect(data.passportPhotoUrl).toBeNull();
    expect(data.passportIssueDate).toBeNull();
    expect(data.passportIssueCountry).toBeNull();
    expect(data.passportIssuePlace).toBeNull();
    expect(data.passportExpiry).toBeNull();
    // 已签发签证信息随人走 → 置空
    expect(data.visaNumber).toBeNull();
    expect(data.visaType).toBeNull();
    expect(data.visaIssueDate).toBeNull();
    expect(data.visaEffectiveDate).toBeNull();
    expect(data.visaExpiry).toBeNull();
    expect(data.visaPlaceOfIssue).toBeNull();
    expect(data.visaCountryOfApplication).toBeNull();
    // 生日 + 出生地 + 本次未填的中文名/性别 → 置空（换人不带生日 → 清空，不残留前一位）
    expect(data.dateOfBirth).toBeNull();
    expect(data.placeOfBirth).toBeNull();
    expect(data.chineseName).toBeNull();
    expect(data.gender).toBeNull();
    // 航司票号随人走 → 置空（旧人的 PNR / 电子票号绝不能留给新人）
    expect(data.pnr).toBeNull();
    expect(data.eticketNumber).toBeNull();
    // 乘客级选项回落安全默认（未显式带新值）：自备签 false（新人不会被签证台漏）、拼房 false、
    // 敬称 null、乘客类型回 ADULT（schema 默认）
    expect(data.visaExempt).toBe(false);
    expect(data.singleRoom).toBe(false);
    expect(data.title).toBeNull();
    expect(data.passengerType).toBe('ADULT');
    // 审计标记
    expect(audit.clearedProfile).toBe(true);
  });

  it('证件号不变（仅改拼写/其它字段）→ 不清除任何护照/签证信息', async () => {
    const service = new OrderService();
    armSwapMocks('SAME123');

    const { audit } = await service.swapPassenger(
      'ord1',
      'px1',
      { fullName: 'FIXED SPELLING', documentNumber: 'SAME123' },
      { userId: 'admin1', role: 'ADMIN' },
    );

    const data = mockPrisma.passenger.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('passportPhotoUrl');
    expect(data).not.toHaveProperty('passportExpiry');
    expect(data).not.toHaveProperty('visaNumber');
    expect(data).not.toHaveProperty('placeOfBirth');
    // chineseName/gender/dateOfBirth 本次未传，且非换人 → 不应被塞 null（生日不动）
    expect(data).not.toHaveProperty('chineseName');
    expect(data).not.toHaveProperty('gender');
    expect(data).not.toHaveProperty('dateOfBirth');
    expect(audit.clearedProfile).toBe(false);
  });

  it('证件号变化但同时提供新值（中文名/性别/生日）→ 用新值，不置空', async () => {
    const service = new OrderService();
    armSwapMocks('OLD111');

    await service.swapPassenger(
      'ord1',
      'px1',
      {
        fullName: 'NEW PERSON',
        documentNumber: 'NEW999',
        chineseName: '新客',
        gender: 'F',
        dateOfBirth: '1992-03-04',
      },
      { userId: 'admin1', role: 'ADMIN' },
    );

    const data = mockPrisma.passenger.update.mock.calls[0][0].data;
    expect(data.chineseName).toBe('新客');
    expect(data.gender).toBe('F');
    expect(data.dateOfBirth).toEqual(new Date('1992-03-04'));
    // 表单没有的护照字段仍随人清空
    expect(data.passportPhotoUrl).toBeNull();
    expect(data.visaExpiry).toBeNull();
  });

  it('证件号变化但换入证件号已在同航班占座订单中 → DuplicatePassengerError，不落库', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValueOnce({ id: 'ord1', adjustmentCny: 0, adjustments: [] });
    mockPrisma.passenger.findUnique.mockResolvedValueOnce({
      id: 'px1',
      orderId: 'ord1',
      fullName: 'OLD, PERSON',
      documentNumber: 'OLD111',
    });
    // 本订单有一条 FLIGHT 行 → 有班次 → 触发重复证件号校验
    mockPrisma.orderItem.findMany.mockResolvedValueOnce([{ flightScheduleId: 'sched1' }]);
    // 同班次占座订单里已存在换入的证件号 → 命中冲突
    mockPrisma.passenger.findFirst.mockResolvedValueOnce({ order: { orderNumber: 'ORD-CONFLICT' } });

    await expect(
      service.swapPassenger(
        'ord1',
        'px1',
        { fullName: 'NEW PERSON', documentNumber: 'DUP777' },
        { userId: 'admin1', role: 'ADMIN' },
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_PASSENGER' });
    // 冲突时在 update 之前中止 → 绝不落库
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });
});

// ── P0-1：改期占座状态守卫（拒绝对已取消/已退款/软删单改期）─────────────
// 背景：改期要"放旧座 + 拿新座"，只有订单真持有座位时才成立；对非占座态改期会二次释放旧座
// （打成负数卡账）+ 新座挂死单永不释放（超卖）。入口硬性要求 deletedAt=null 且 status ∈ 占座态。
describe('OrderService.rescheduleOrderItem · 占座状态守卫', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // R2：FOR UPDATE 锁默认返回一行（订单存在）→ 锁通过后走占座守卫（守卫拒绝原因由 findUnique 决定）。
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'ord1' }]);
  });

  it('已取消订单（CANCELLED，非占座态）→ 拒绝改期（400），不触碰座位台账', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      status: 'CANCELLED',
      deletedAt: null,
      adjustmentCny: 0,
      adjustments: [],
    });

    await expect(
      service.rescheduleOrderItem(
        'ord1',
        { orderItemId: 'it1', newScheduleId: 'sched2' },
        { userId: 'admin1', role: 'ADMIN' },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    // 守卫在取订单项/搬座位之前中止
    expect(mockPrisma.flightSeatClass.findFirst).not.toHaveBeenCalled();
  });

  it('软删单（deletedAt 非空）→ 拒绝改期（400，提示先恢复）', async () => {
    const service = new OrderService();
    mockPrisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord1',
      status: 'PAID', // 即便占座态，软删也拒
      deletedAt: new Date('2026-07-01T00:00:00.000Z'),
      adjustmentCny: 0,
      adjustments: [],
    });

    await expect(
      service.rescheduleOrderItem(
        'ord1',
        { orderItemId: 'it1', newScheduleId: 'sched2' },
        { userId: 'admin1', role: 'ADMIN' },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.flightSeatClass.findFirst).not.toHaveBeenCalled();
  });
});

// ── 住宿逐晚展开：buildStayNightDates ────────────────────────────────────
// [checkIn, checkOut) 半开区间展开为逐晚 YYYY-MM-DD（UTC date-only）。
// 防御：反向 / 相等 / 超大跨度 → []（调用方按"无从校验"跳过，不阻断下单）。
describe('buildStayNightDates', () => {
  it('合法区间 [7/1, 7/4) → 三晚 7/1、7/2、7/3', () => {
    expect(
      buildStayNightDates(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-04T00:00:00.000Z')),
    ).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('单晚 [7/1, 7/2) → [7/1]', () => {
    expect(
      buildStayNightDates(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-02T00:00:00.000Z')),
    ).toEqual(['2026-07-01']);
  });

  it('反向区间（checkOut < checkIn）→ []', () => {
    expect(
      buildStayNightDates(new Date('2026-07-04T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z')),
    ).toEqual([]);
  });

  it('相等区间（0 晚）→ []', () => {
    expect(
      buildStayNightDates(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z')),
    ).toEqual([]);
  });

  it('超大跨度（> 60 晚）→ []（防御）', () => {
    expect(
      buildStayNightDates(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-12-01T00:00:00.000Z')),
    ).toEqual([]);
  });

  it('非法 Date（NaN）→ []', () => {
    expect(buildStayNightDates(new Date('garbage'), new Date('2026-07-04T00:00:00.000Z'))).toEqual([]);
  });
});

// ── 套餐酒店房量库存门槛（与 createOrder BUNDLE 分支同源判定式）──────────────
// 守卫式：hasBlock && remaining.some((r, i) => block[i] > 0 && r < rooms) → 房量不足拦截。
//   · 只看被周期覆盖的晚（block[i] > 0）：未管控的晚（block[i] === 0）不拦截。
//   · 与本单所需房间数 rooms 比较（多间需求时够 1 间不能放行）。
describe('套餐酒店房量库存门槛（roomsNeeded-aware guard）', () => {
  // 与 orders.service.ts BUNDLE 分支逐字同源的纯判定式复刻
  const blocks = (
    remaining: number[],
    block: number[],
    hasBlock: boolean,
    rooms: number,
  ): boolean => hasBlock && remaining.some((r, i) => block[i] > 0 && r < rooms);

  it('每晚 remaining ≥ rooms → 放行（不拦截）', () => {
    // 需要 2 间，被管控晚都剩 2 → 通过
    expect(blocks([2, 2, 3], [4, 4, 4], true, 2)).toBe(false);
  });

  it('被管控晚 remaining < rooms（余 1 需 2）→ 拦截', () => {
    // 第二晚被周期覆盖（block=4）但只剩 1 间 < 需求 2 → 拦截（旧逻辑只查 <=0 会漏放）
    expect(blocks([2, 1, 2], [4, 4, 4], true, 2)).toBe(true);
  });

  it('余量不足的那晚未被周期覆盖（block===0）→ 不拦截', () => {
    // 第二晚 remaining=0 但 block=0（未管控）→ 不据此判售罄
    expect(blocks([2, 0, 2], [4, 0, 4], true, 2)).toBe(false);
  });

  it('hasBlock=false（整段未配置房控）→ 直接跳过守卫', () => {
    // 即便 remaining 里有不足，hasBlock=false 一律放行
    expect(blocks([0, 0, 0], [0, 0, 0], false, 2)).toBe(false);
  });

  it('rooms=1（单间需求）且被管控晚剩 0 → 拦截（等价旧 <=0 语义）', () => {
    expect(blocks([1, 0, 1], [2, 2, 2], true, 1)).toBe(true);
  });

  it('半间需求（rooms=0.5）被管控晚剩 0 → 拦截；剩 1 → 放行', () => {
    expect(blocks([0], [2], true, 0.5)).toBe(true);
    expect(blocks([1], [2], true, 0.5)).toBe(false);
  });
});

// ── 套餐/酒店服务端权威重算 + 下架拦截（priceAndValidateItems）─────────────
// 通过私有方法直接驱动，隔离扣座事务；验证 FIX：机票外产品的重算价来源 + 下架酒店拦截。
describe('priceAndValidateItems · 酒店重算价来源 + 下架拦截', () => {
  const service = new OrderService();
  const dec2 = (n: number) => ({ toString: () => String(n) }) as unknown;
  // 私有方法访问器（沿用文件既有 as-unknown 转型风格）
  const price = (items: OrderItemInput[]) =>
    (service as unknown as {
      priceAndValidateItems(i: OrderItemInput[], s?: number): Promise<Array<{
        kind: string;
        unitPrice: number;
        amount: number;
        hotelRoomTypeId?: string;
        roomsBilled?: number;
        // Bug 2a（businessUpgradeCount 伪造）测试要看 FLIGHT 行落库前的 metadata/类型化字段。
        metadata?: Record<string, unknown>;
        businessUpgradeCount?: number;
      }>>;
    }).priceAndValidateItems(items);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('HOTEL 行绑房型 → 单价改用 HotelRoomType.basePrice（不信前端 unitPrice）', async () => {
    // 房型权威价 1280；酒店在售
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      basePrice: dec2(1280),
      hotel: { isActive: true },
    });
    const priced = await price([
      {
        kind: 'HOTEL',
        description: '海景房',
        quantity: 2, // 2 晚
        unitPrice: 1280, // 前端传的价与权威价一致（避免容差拒单）
        hotelRoomTypeId: 'rt1',
      } as OrderItemInput,
    ]);
    const hotel = priced.find((p) => p.kind === 'HOTEL')!;
    expect(hotel.unitPrice).toBe(1280); // 来自 basePrice
    expect(hotel.amount).toBe(1280 * 2); // unitPrice × qty × rooms(1)
    expect(mockPrisma.hotelRoomType.findUnique).toHaveBeenCalled();
  });

  it('HOTEL 行无房型（未绑）+ 对外角色 → 拒绝自定义价（防公开下单提交 1 元酒店行）', async () => {
    await expect(
      price([
        {
          kind: 'HOTEL',
          description: '自由行酒店',
          quantity: 3,
          unitPrice: 900,
          // 无 hotelRoomTypeId，且未开 allowClientPricedGround（对外角色缺省）
        } as OrderItemInput,
      ]),
    ).rejects.toThrow('酒店行必须选择系统内的酒店房型');
  });

  it('HOTEL 行无房型（未绑）+ 后台/代理手录（allowClientPricedGround）→ 信任前端 unitPrice，不查库', async () => {
    const priceTrusted = (items: OrderItemInput[]) =>
      (service as unknown as {
        priceAndValidateItems(
          i: OrderItemInput[],
          s?: number,
          p?: unknown,
          allow?: boolean,
        ): ReturnType<typeof price>;
      }).priceAndValidateItems(items, undefined, undefined, true);
    const priced = await priceTrusted([
      {
        kind: 'HOTEL',
        description: '自由行酒店',
        quantity: 3,
        unitPrice: 900,
        // 无 hotelRoomTypeId
      } as OrderItemInput,
    ]);
    const hotel = priced.find((p) => p.kind === 'HOTEL')!;
    expect(hotel.unitPrice).toBe(900);
    expect(hotel.amount).toBe(900 * 3);
    // 未绑房型 → 不查房型库
    expect(mockPrisma.hotelRoomType.findUnique).not.toHaveBeenCalled();
  });

  it('HOTEL 行绑房型但酒店已下架 → 抛「酒店已下架」', async () => {
    mockPrisma.hotelRoomType.findUnique.mockResolvedValue({
      basePrice: dec2(1280),
      hotel: { isActive: false },
    });
    await expect(
      price([
        {
          kind: 'HOTEL',
          description: '海景房',
          quantity: 1,
          unitPrice: 1280,
          hotelRoomTypeId: 'rt_off',
        } as OrderItemInput,
      ]),
    ).rejects.toThrow('酒店已下架');
  });

  it('套餐绑的房型其酒店已下架 → 抛「酒店已下架」（防止经套餐绕过下架酒店，FIX C）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      items: [],
      groundDiscount: dec2(0),
      discountPct: 0,
      isActive: true,
      hotelRoomTypeId: 'rt_bundle',
      hotelNights: 3,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      hotelRoomType: {
        maxAdults: 2,
        maxChildren: 1,
        basePrice: dec2(1280),
        hotelId: 'hotel_off',
        hotel: { isActive: false }, // 下架
      },
    });
    await expect(
      price([
        {
          kind: 'BUNDLE',
          description: '岘港套餐',
          quantity: 1,
          unitPrice: 0,
          bundleId: 'bdl1',
        } as OrderItemInput,
      ]),
    ).rejects.toThrow('酒店已下架');
    // 抛错在库存校验之前，不应调用房量查询
    expect(mockGetHotelNightlyRemaining).not.toHaveBeenCalled();
  });

  it('套餐绑的房型酒店在售 → 不因下架拦截（走后续定价，酒店在售放行）', async () => {
    mockPrisma.bundle.findUnique.mockResolvedValue({
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 1280 }],
      groundDiscount: dec2(0),
      discountPct: 0,
      isActive: true,
      hotelRoomTypeId: 'rt_bundle',
      hotelNights: 3,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      hotelRoomType: {
        maxAdults: 2,
        maxChildren: 1,
        basePrice: dec2(1280),
        hotelId: 'hotel_on',
        hotel: { isActive: true },
      },
    });
    // 无 goDate 盖章 → 不触发库存校验（沿用宽松口径），此调用应成功不抛下架。
    // 显式 2 成人（占整间）→ 走整间口径，验证「在售放行 + 权威 basePrice ×rooms 重算」。
    const priced = await price([
      {
        kind: 'BUNDLE',
        description: '岘港套餐',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'bdl1',
        adultCount: 2,
      } as OrderItemInput,
    ]);
    const bundle = priced.find((p) => p.kind === 'BUNDLE')!;
    expect(bundle).toBeDefined();
    // 酒店地面价按权威 basePrice ×rooms 重算：1280 × 3 晚 × 1 间 = 3840
    expect(bundle.unitPrice).toBe(3840);
  });

  // ── 单人拼房 0.5 间（server-authoritative，钱路径经 BUNDLE 分支落到订单行）─────────
  const soloBundleFixture = () =>
    mockPrisma.bundle.findUnique.mockResolvedValue({
      items: [{ kind: 'HOTEL', qty: 3, unitPrice: 1280 }],
      groundDiscount: dec2(0),
      discountPct: 0,
      isActive: true,
      hotelRoomTypeId: 'rt_bundle',
      hotelNights: 3,
      singleSupplementCnyPerNight: 80,
      businessUpgradeCnyPerLeg: 700,
      childSeatDiscountCnyPerPerson: 30,
      infantPriceCny: 0,
      selfVisaDeductCny: 0,
      legs: 2,
      hotelRoomType: {
        maxAdults: 2,
        maxChildren: 1,
        basePrice: dec2(1280),
        hotelId: 'hotel_on',
        hotel: { isActive: true },
      },
    });

  it('单人拼房（1 成人 / singleCount 0，绑房型）→ 0.5 间 → 酒店地面 1280×3×0.5 = 1920', async () => {
    soloBundleFixture();
    const priced = await price([
      {
        kind: 'BUNDLE',
        description: '岘港套餐',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'bdl1',
        adultCount: 1,
        childCount: 0,
      } as OrderItemInput,
    ]);
    const bundle = priced.find((p) => p.kind === 'BUNDLE')!;
    expect(bundle.unitPrice).toBe(1920); // 1280 × 3 × 0.5
    expect(bundle.roomsBilled).toBe(0.5); // 计费房间数落到订单行（供房控读取）
  });

  it('单人独住（1 成人 / singleCount 1，绑房型）→ 1 整间 → 酒店地面 1280×3×1 = 3840 + 单房差', async () => {
    soloBundleFixture();
    const priced = await price([
      {
        kind: 'BUNDLE',
        description: '岘港套餐',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'bdl1',
        adultCount: 1,
        childCount: 0,
        singleCount: 1,
      } as OrderItemInput,
    ]);
    const bundle = priced.find((p) => p.kind === 'BUNDLE')!;
    expect(bundle.roomsBilled).toBe(1); // 独住 → 整间（不走 0.5）
    expect(bundle.unitPrice).toBe(3840); // 1280 × 3 × 1（单房差记在 amount，不进 unitPrice）
    // 单房差 = 1 × 80 × 3 晚 = 240 → amount = 3840 + 240
    expect(bundle.amount).toBe(3840 + 240);
  });

  it('滥用防护：2 成人 + 客户端伪造 roomsBilled=0.5 → 服务端仍按 1 间收 3840（不给少付）', async () => {
    soloBundleFixture();
    const priced = await price([
      {
        kind: 'BUNDLE',
        description: '岘港套餐',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'bdl1',
        adultCount: 2,
        childCount: 0,
        roomsBilled: 0.5, // 客户端伪造半间
      } as OrderItemInput,
    ]);
    const bundle = priced.find((p) => p.kind === 'BUNDLE')!;
    expect(bundle.roomsBilled).toBe(1); // 权威下限：max(0.5, 1) = 1
    expect(bundle.unitPrice).toBe(3840); // 按 1 间收，不给 0.5 少付
  });

  // ── Bug 2a：普通 FLIGHT 行的 metadata.businessUpgradeCount 只能来自套餐升舱内部派生，
  // 客户端伪造的值必须在下单时被剥离——否则退座/admin force 重新占座会按这个伪造值拆分商务舱
  // 库存，把从未真正占用过的 BUSINESS sold 冲成负数（见 orders.status-seats.test.ts 里
  // releaseSeatFloored 的第二层防线；这里测的是第一层：源头不让伪造值落库）。────────────────
  it('Bug 2a：动态定价分支剥离客户端伪造的 metadata.businessUpgradeCount', async () => {
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({
      capacity: 10,
      sold: 0,
      basePrice: dec2(500),
      fareBuckets: null,
      schedule: { departureTz: 'Asia/Macau', departureTime: new Date('2026-08-01T03:00:00.000Z') },
    });
    mockPrisma.dateRanking.findUnique.mockResolvedValue(null);

    const priced = await price([
      {
        kind: 'FLIGHT',
        description: 'CA123 上海→东京',
        quantity: 3,
        flightScheduleId: 'sched1',
        flightCabin: 'ECONOMY',
        // 客户端伪造：这是一条普通机票行，从未走套餐升舱，正常不该有这个字段。
        metadata: { businessUpgradeCount: 999 },
      } as OrderItemInput,
    ]);

    const flight = priced.find((p) => p.kind === 'FLIGHT')!;
    // 扣座真正读的类型化字段本就不受 metadata 影响（旧行为），这里断言的是落库后的 metadata——
    // 退座/重新占座分支读的正是这个字段，必须确认伪造键被剥掉了。
    expect(flight.businessUpgradeCount).toBeUndefined();
    expect(flight.metadata?.businessUpgradeCount).toBeUndefined();
  });

  it('Bug 2a：团队议价结算价（flightSettlementPriceCny）分支同样剥离伪造值，其余合法 metadata 不受影响', async () => {
    const priced = await (
      service as unknown as {
        priceAndValidateItems(
          i: OrderItemInput[],
          s?: number,
        ): Promise<Array<{ kind: string; metadata?: Record<string, unknown> }>>;
      }
    ).priceAndValidateItems(
      [
        {
          kind: 'FLIGHT',
          description: 'CA123 上海→东京',
          quantity: 2,
          flightScheduleId: 'sched1',
          flightCabin: 'ECONOMY',
          metadata: { businessUpgradeCount: 50, someClientNote: 'keep-me' },
        } as OrderItemInput,
      ],
      600, // flightSettlementPriceCny：走团队议价分支，短路动态定价，不查 flightSeatClass
    );
    const flight = priced.find((p) => p.kind === 'FLIGHT')!;
    expect(flight.metadata?.businessUpgradeCount).toBeUndefined();
    expect(flight.metadata?.someClientNote).toBe('keep-me'); // 无关的客户端 metadata 键不受牵连
    expect(flight.metadata?.priceOverride).toBe('TEAM_SETTLEMENT'); // 合法内部写入的键仍正常生效
  });
});

// ── 签证加急分档定价（priceAndValidateItems · VISA 分支）────────────────────
// 运营在签证产品上配「零工/一工/二工」等档位（各自出签工作日 + 加价）；录单选档，
// 客户端只传档名，加价金额一律服务端按产品档位表查出来（钱路径服务端权威）。
describe('priceAndValidateItems · 签证加急分档', () => {
  const service = new OrderService();
  const dec2 = (n: number) => ({ toString: () => String(n) }) as unknown;
  const price = (items: OrderItemInput[]) =>
    (service as unknown as {
      priceAndValidateItems(i: OrderItemInput[]): Promise<Array<{
        kind: string;
        unitPrice: number;
        amount: number;
        metadata?: Record<string, unknown>;
      }>>;
    }).priceAndValidateItems(items);

  const visaItem = (unitPrice: number, metadata?: Record<string, unknown>) =>
    ({
      kind: 'VISA',
      description: '越南电子签',
      quantity: 2,
      visaId: 'visa1',
      unitPrice,
      ...(metadata ? { metadata } : {}),
    }) as OrderItemInput;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('选中加急档 → 单价 = 挂牌价 + 该档 surchargeCny，档位快照落行 metadata', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: dec2(150),
      expressTiers: [
        { label: '零工', workDays: 0, surchargeCny: 300 },
        { label: '一工', workDays: 1, surchargeCny: 100 },
      ],
      costPriceCny: dec2(200),
      isActive: true,
    });
    const priced = await price([visaItem(480, { expressTierLabel: '一工' })]);
    const visa = priced.find((p) => p.kind === 'VISA')!;
    expect(visa.unitPrice).toBe(480); // 380 + 100
    expect(visa.amount).toBe(960); // × 2 份
    expect(visa.metadata?.expressTier).toEqual({ label: '一工', workDays: 1, surchargeCny: 100 });
  });

  it('不同档不同价：同产品选「零工」→ 380 + 300 = 680', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: null,
      expressTiers: [
        { label: '零工', workDays: 0, surchargeCny: 300 },
        { label: '一工', workDays: 1, surchargeCny: 100 },
      ],
      costPriceCny: null,
      isActive: true,
    });
    const priced = await price([visaItem(680, { expressTierLabel: '零工' })]);
    expect(priced.find((p) => p.kind === 'VISA')!.unitPrice).toBe(680);
  });

  it('产品没配分档却传档名 → 400 拒单（绝不静默按不加急成交）', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: dec2(150),
      expressTiers: [],
      costPriceCny: null,
      isActive: true,
    });
    await expect(price([visaItem(380, { expressTierLabel: '一工' })])).rejects.toThrow(
      '没有「一工」加急档',
    );
  });

  it('档名对不上（运营改了档位表 / 伪造档名）→ 400 拒单', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: null,
      expressTiers: [{ label: '一工', workDays: 1, surchargeCny: 100 }],
      costPriceCny: null,
      isActive: true,
    });
    await expect(price([visaItem(380, { expressTierLabel: '三工' })])).rejects.toThrow(
      '请重新选择加急档位',
    );
  });

  it('金额不信客户端：前端传低价 + 合法档名 → 按服务端档价校验后拒单（容差外）', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: null,
      expressTiers: [{ label: '一工', workDays: 1, surchargeCny: 100 }],
      costPriceCny: null,
      isActive: true,
    });
    await expect(price([visaItem(380, { expressTierLabel: '一工' })])).rejects.toThrow('签证价格已变动');
  });

  it('未选档（不传 expressTierLabel）→ 旧的单值 express 口径完全不变', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: dec2(150),
      expressTiers: [{ label: '一工', workDays: 1, surchargeCny: 100 }],
      costPriceCny: null,
      isActive: true,
    });
    // 不加急
    const plain = await price([visaItem(380)]);
    expect(plain.find((p) => p.kind === 'VISA')!.unitPrice).toBe(380);
    expect(plain.find((p) => p.kind === 'VISA')!.metadata).toBeUndefined();
    // 旧的 express 布尔 → 仍走 expressSurcharge 单值
    const legacyExpress = await price([visaItem(530, { express: true })]);
    expect(legacyExpress.find((p) => p.kind === 'VISA')!.unitPrice).toBe(530); // 380 + 150
    expect(legacyExpress.find((p) => p.kind === 'VISA')!.metadata?.expressTier).toBeUndefined();
  });

  it('空白档名视为未选档（不因误传空串拒单）', async () => {
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: dec2(380),
      expressSurcharge: null,
      expressTiers: [{ label: '一工', workDays: 1, surchargeCny: 100 }],
      costPriceCny: null,
      isActive: true,
    });
    const priced = await price([visaItem(380, { expressTierLabel: '   ' })]);
    expect(priced.find((p) => p.kind === 'VISA')!.unitPrice).toBe(380);
  });
});

// ── 换酒店（hotel swap）body schema：feeCny 可负、拒绝 0、超上限拒绝 ─────────────
// 服务层的事务行为（冻结定价 / 余量校验 / roomAssignment 改名等）见真 DB 集成测试
// orders.hotel-swap.integration.test.ts（与 reschedule/swapPassenger 同款测试策略）。
describe('swapItemHotelBodySchema', () => {
  it('最小合法 body（仅 newHotelRoomTypeId）→ 通过，feeCny 缺省 undefined', () => {
    const parsed = swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new' });
    expect(parsed.newHotelRoomTypeId).toBe('rt_new');
    expect(parsed.feeCny).toBeUndefined();
  });

  it('feeCny 可以是负数（减价）', () => {
    const parsed = swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeCny: -80 });
    expect(parsed.feeCny).toBe(-80);
  });

  it('feeCny 可以是正数（加价）', () => {
    const parsed = swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeCny: 200 });
    expect(parsed.feeCny).toBe(200);
  });

  it('feeCny = 0 → 拒绝（"不调整"应留空不传，而不是显式传 0）', () => {
    expect(() => swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeCny: 0 })).toThrow();
  });

  it('feeCny 非整数 → 拒绝', () => {
    expect(() =>
      swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeCny: 49.5 }),
    ).toThrow();
  });

  it('feeCny 超出上限（±100000）→ 拒绝（正负两侧）', () => {
    expect(() =>
      swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeCny: 100_001 }),
    ).toThrow();
    expect(() =>
      swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeCny: -100_001 }),
    ).toThrow();
  });

  it('newHotelRoomTypeId 缺失 → 拒绝', () => {
    expect(() => swapItemHotelBodySchema.parse({ feeCny: 50 })).toThrow();
  });

  it('feeLabel 超 60 字 → 拒绝；note 超 200 字 → 拒绝', () => {
    expect(() =>
      swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', feeLabel: '费'.repeat(61) }),
    ).toThrow();
    expect(() =>
      swapItemHotelBodySchema.parse({ newHotelRoomTypeId: 'rt_new', note: '注'.repeat(201) }),
    ).toThrow();
  });
});

describe('buildOrderFilterWhere · 签证办理状态筛选（与列表徽标同源）', () => {
  // 已签证 = 订单存在已确认(CONFIRMED)的签证办理任务 VISA_APPLICATION。
  // 关键口径：按履约任务判定、不限 item kind —— 签证任务常挂在 BUNDLE 行或首个订单项上
  //（套餐订单没有独立 VISA 行）；强求 kind=VISA 会漏掉套餐签证单，导致 signed/unsigned 双 0。
  const HAS_VISA_TASK_CLAUSE = {
    items: { some: { fulfillmentTasks: { some: { type: 'VISA_APPLICATION' } } } },
  };
  const CONFIRMED_CLAUSE = {
    items: {
      some: {
        fulfillmentTasks: {
          some: { type: 'VISA_APPLICATION', status: 'CONFIRMED' },
        },
      },
    },
  };

  it('不传 visaFulfillmentStatus → 不产生任何签证相关子句', () => {
    const where = buildOrderFilterWhere({});
    expect(where.AND).toBeUndefined();
  });

  it('signed → AND 含「存在已确认签证办理任务」子句（不限 item kind）', () => {
    const where = buildOrderFilterWhere({ visaFulfillmentStatus: 'signed' });
    expect(where.AND).toEqual([CONFIRMED_CLAUSE]);
    // 回归守卫：签证子句不得再要求 kind=VISA（否则套餐签证单漏召回 = 双 0 bug 复现）。
    expect(JSON.stringify(where.AND)).not.toContain('"kind"');
  });

  it('unsigned → AND 含「有签证办理任务」且「无已确认」(NOT) 组合，不限 kind', () => {
    const where = buildOrderFilterWhere({ visaFulfillmentStatus: 'unsigned' });
    expect(where.AND).toEqual([
      { AND: [HAS_VISA_TASK_CLAUSE, { NOT: CONFIRMED_CLAUSE }] },
    ]);
    expect(JSON.stringify(where.AND)).not.toContain('"kind"');
  });

  it('signed 可与 kind 组合而不互相覆盖（各自独立叠加进 AND）', () => {
    const where = buildOrderFilterWhere({ kind: 'VISA', visaFulfillmentStatus: 'signed' });
    // kind 筛选（显式选了「签证」产品类型）与 signed 分别是两条子句，都进 AND，互不覆盖。
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toEqual([
      { items: { some: { kind: 'VISA' } } },
      CONFIRMED_CLAUSE,
    ]);
  });

  it('signed 与 invoiceStatus 组合：签证走 AND、开票走顶层字段，互不干扰', () => {
    const where = buildOrderFilterWhere({ invoiceStatus: 'ISSUED', visaFulfillmentStatus: 'signed' });
    expect(where.invoiceStatus).toBe('ISSUED');
    expect(where.AND).toEqual([CONFIRMED_CLAUSE]);
  });

  it.each([
    ['NEEDED', '需要签证'],
    ['E_VISA', '电子签'],
    ['HAS_VISA', '已签证'],
    ['NOT_NEEDED', '不需要签证'],
  ] as const)('visaRequirement=%s → 按订单录单要求 Order.visaStatus 筛选（%s）', (visaRequirement, _label) => {
    const where = buildOrderFilterWhere({ visaRequirement });
    expect(where.AND).toEqual([{ visaStatus: visaRequirement }]);
  });

  it('visaRequirement 与 visaFulfillmentStatus 同时给出 → 两个维度分别叠加', () => {
    const where = buildOrderFilterWhere({ visaRequirement: 'NEEDED', visaFulfillmentStatus: 'signed' });
    expect(where.AND).toEqual([
      CONFIRMED_CLAUSE,
      { visaStatus: 'NEEDED' },
    ]);
  });
});

// ── 回程物化列 Order.hasReturnLeg：写入口径 + 查询层收口 ─────────────────────
// 背景：单程单 returnInvoiced 恒为 false，会天然混进「回程未开」的开票清单，但它没有回程票可开。
// Prisma where 表达不了「关联行 ≥ 2 条」，故把判定物化成列，查询层直接用。
describe('resolveHasReturnLeg · 物化列写入口径（与 determineFlightLegs 同源）', () => {
  const leg = (id: string, departure: string) => ({
    flightScheduleId: id,
    flightSchedule: { departureTime: new Date(departure) },
  });

  it('往返单（两条带班次的 FLIGHT 行）→ true', () => {
    expect(
      resolveHasReturnLeg([
        leg('sch_out', '2026-07-10T02:00:00Z'),
        leg('sch_ret', '2026-07-14T09:00:00Z'),
      ]),
    ).toBe(true);
  });

  it('单程单（只有一条航段）→ false —— 这正是「回程未开」误召回的那类单', () => {
    expect(resolveHasReturnLeg([leg('sch_out', '2026-07-10T02:00:00Z')])).toBe(false);
  });

  it('无航段（酒店单/签证单）→ false', () => {
    expect(resolveHasReturnLeg([])).toBe(false);
  });

  it('行顺序与判定无关：录入顺序颠倒仍是 true（按 departureTime 升序取第 2 段）', () => {
    expect(
      resolveHasReturnLeg([
        leg('sch_ret', '2026-07-14T09:00:00Z'),
        leg('sch_out', '2026-07-10T02:00:00Z'),
      ]),
    ).toBe(true);
  });

  it('缺 flightScheduleId 的行不算航段：一条有效 + 一条空 → false（不虚构回程）', () => {
    expect(
      resolveHasReturnLeg([
        leg('sch_out', '2026-07-10T02:00:00Z'),
        { flightScheduleId: null, flightSchedule: null },
      ]),
    ).toBe(false);
  });

  it('多段（>2）仍是 true —— 有第 2 段即有回程', () => {
    expect(
      resolveHasReturnLeg([
        leg('sch_a', '2026-07-10T02:00:00Z'),
        leg('sch_b', '2026-07-12T02:00:00Z'),
        leg('sch_c', '2026-07-14T02:00:00Z'),
      ]),
    ).toBe(true);
  });
});

describe('buildOrderFilterWhere · 回程守卫与行程类型筛选（物化列 hasReturnLeg）', () => {
  const HAS_FLIGHT_LEG_CLAUSE = {
    items: { some: { kind: 'FLIGHT', flightScheduleId: { not: null } } },
  };

  it('回程未开：AND 同时含「有航段」与 hasReturnLeg=true —— 单程单被彻底排除', () => {
    const where = buildOrderFilterWhere({ invoiceLeg: 'return', invoiced: false });
    expect(where.returnInvoiced).toBe(false);
    expect(where.AND).toEqual([HAS_FLIGHT_LEG_CLAUSE, { hasReturnLeg: true }]);
  });

  it('去程维度不挂 hasReturnLeg —— 单程单本来就该出现在「去程未开」清单里', () => {
    const where = buildOrderFilterWhere({ invoiceLeg: 'outbound', invoiced: false });
    expect(where.outboundInvoiced).toBe(false);
    expect(where.AND).toEqual([HAS_FLIGHT_LEG_CLAUSE]);
  });

  it('系统维度既不挂航段守卫也不挂 hasReturnLeg（酒店单/签证单本就要系统开票）', () => {
    const where = buildOrderFilterWhere({ invoiceLeg: 'system', invoiced: false });
    expect(where.systemInvoiced).toBe(false);
    expect(where.AND).toBeUndefined();
  });

  it('invoiceLeg 缺 invoiced（未成对给出）→ 不产生任何开票/回程子句', () => {
    const where = buildOrderFilterWhere({ invoiceLeg: 'return' });
    expect(where.returnInvoiced).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it('tripType=roundtrip → hasReturnLeg=true', () => {
    const where = buildOrderFilterWhere({ tripType: 'roundtrip' });
    expect(where.AND).toEqual([{ hasReturnLeg: true }]);
  });

  it('tripType=oneway → hasReturnLeg=false 且必须有航段（酒店单/签证单不算单程单）', () => {
    const where = buildOrderFilterWhere({ tripType: 'oneway' });
    expect(where.AND).toEqual([{ hasReturnLeg: false }, HAS_FLIGHT_LEG_CLAUSE]);
  });

  it('不传 tripType → 不产生 hasReturnLeg 子句（默认不按行程类型收口）', () => {
    const where = buildOrderFilterWhere({});
    expect(JSON.stringify(where)).not.toContain('hasReturnLeg');
  });

  it('往返 + 回程未开可叠加：两条子句各自独立进 AND，互不覆盖', () => {
    const where = buildOrderFilterWhere({
      invoiceLeg: 'return',
      invoiced: false,
      tripType: 'roundtrip',
    });
    expect(where.AND).toEqual([
      HAS_FLIGHT_LEG_CLAUSE,
      { hasReturnLeg: true },
      { hasReturnLeg: true },
    ]);
  });

  it('单程 + 回程未开是自相矛盾的组合：两条子句并存 → 诚实返回空集，而非某一边静默失效', () => {
    const where = buildOrderFilterWhere({
      invoiceLeg: 'return',
      invoiced: false,
      tripType: 'oneway',
    });
    expect(where.AND).toEqual([
      HAS_FLIGHT_LEG_CLAUSE,
      { hasReturnLeg: true },
      { hasReturnLeg: false },
      HAS_FLIGHT_LEG_CLAUSE,
    ]);
  });

  it('勾选导出（orderIds）短路：不叠加任何行程类型子句', () => {
    const where = buildOrderFilterWhere({ orderIds: ['o1', 'o2'], tripType: 'roundtrip' });
    expect(where).toEqual({ id: { in: ['o1', 'o2'] }, deletedAt: null });
  });
});

// ── 下单时间 from/to 边界（公测反馈：需精确到几点几分统计当日进单）──
// 纯日期保持历史口径；带时间按录单人所见的北京时（+08:00）墙钟精确卡界。
describe('buildOrderFilterWhere · 下单时间 from/to 边界解析', () => {
  it('纯日期口径不变：from→当日 00:00:00Z（gte），to→当日 23:59:59Z（lte）', () => {
    const where = buildOrderFilterWhere({ from: '2026-07-21', to: '2026-07-21' });
    const createdAt = where.createdAt as { gte: Date; lte: Date };
    expect(createdAt.gte.toISOString()).toBe('2026-07-21T00:00:00.000Z');
    expect(createdAt.lte.toISOString()).toBe('2026-07-21T23:59:59.000Z');
  });

  it('带时间（datetime-local）按 +08:00 精确卡界：14:30 北京 = 06:30Z', () => {
    const where = buildOrderFilterWhere({ from: '2026-07-21T14:30', to: '2026-07-21T18:00' });
    const createdAt = where.createdAt as { gte: Date; lte: Date };
    expect(createdAt.gte.toISOString()).toBe('2026-07-21T06:30:00.000Z');
    expect(createdAt.lte.toISOString()).toBe('2026-07-21T10:00:00.000Z');
  });

  it('只给 from（带时间）→ 只产生 gte，无 lte', () => {
    const where = buildOrderFilterWhere({ from: '2026-07-21T09:00:00' });
    const createdAt = where.createdAt as { gte: Date; lte?: Date };
    expect(createdAt.gte.toISOString()).toBe('2026-07-21T01:00:00.000Z');
    expect(createdAt.lte).toBeUndefined();
  });
});

// ── 出行日期精确细筛（整单出发日 = deriveOrderDepartDate 同口径；列表所见 = 筛选所得）──
describe('filterOrderIdsByDepartDate · 按整单出发日精确细筛', () => {
  // departureTime 以「本地时刻当作 UTC」存取（与仓库其余时间口径一致）——
  // deriveOrderDepartDate 取最早航段 departureTime 的 date-only 作整单出发日。
  const flightItem = (isoDepart: string) => ({
    hotelCheckIn: null,
    flightSchedule: { departureTime: new Date(isoDepart) },
  });
  const hotelItem = (isoCheckIn: string) => ({
    hotelCheckIn: new Date(isoCheckIn),
    flightSchedule: null,
  });

  it('往返单（去程 7/10、回程 7/11），travelFrom=7/11 → 不命中（整单出发日=去程 7/10 < 7/11）', () => {
    const roundTrip = {
      id: 'rt',
      // 顺序刻意先回程后去程，验证取的是「最早」而非「第一条」。
      items: [flightItem('2026-07-11T09:00:00Z'), flightItem('2026-07-10T08:00:00Z')],
    };
    expect(filterOrderIdsByDepartDate([roundTrip], '2026-07-11', undefined)).toEqual([]);
  });

  it('7/11 出发的单 → travelFrom=7/11 命中（含起始边界）', () => {
    const dep0711 = { id: 'a', items: [flightItem('2026-07-11T06:00:00Z')] };
    expect(filterOrderIdsByDepartDate([dep0711], '2026-07-11', undefined)).toEqual(['a']);
  });

  it('区间 [7/11, 7/12] 同时筛掉早于起始与晚于结束者，保留区间内（含边界）', () => {
    const before = { id: 'b', items: [flightItem('2026-07-10T23:00:00Z')] }; // 7/10 < 7/11
    const onFrom = { id: 'f', items: [flightItem('2026-07-11T02:00:00Z')] }; // 7/11 边界
    const onTo = { id: 't', items: [flightItem('2026-07-12T22:00:00Z')] }; // 7/12 边界
    const after = { id: 'z', items: [flightItem('2026-07-13T01:00:00Z')] }; // 7/13 > 7/12
    const ids = filterOrderIdsByDepartDate([before, onFrom, onTo, after], '2026-07-11', '2026-07-12');
    expect(ids).toEqual(['f', 't']);
  });

  it('无航班的纯地面单回退酒店入住日；既无航班也无酒店 → 不命中', () => {
    const hotelOnly = { id: 'h', items: [hotelItem('2026-07-11T00:00:00Z')] };
    const empty = { id: 'e', items: [] };
    const ids = filterOrderIdsByDepartDate([hotelOnly, empty], '2026-07-11', '2026-07-11');
    expect(ids).toEqual(['h']);
  });
});

// ── 床位/计费口径 → 物理房间前瞻闸输入的翻译：toProspectiveOccupancy ────────────
describe('toProspectiveOccupancy', () => {
  it('0.5 间（单人拼房）→ 1 位拼房客，按第一位 M/F 出行人的性别进桶', () => {
    expect(toProspectiveOccupancy(0.5, [{ gender: 'M' }])).toEqual({ wholeRooms: 0, solos: ['M'] });
    expect(toProspectiveOccupancy(0.5, [{ gender: 'F' }])).toEqual({ wholeRooms: 0, solos: ['F'] });
  });

  it('拼房客性别未知（X / 未填 / 无出行人）→ U，独占一间、不参与自动配对', () => {
    expect(toProspectiveOccupancy(0.5, [{ gender: 'X' }])).toEqual({ wholeRooms: 0, solos: ['U'] });
    expect(toProspectiveOccupancy(0.5, [{}])).toEqual({ wholeRooms: 0, solos: ['U'] });
    expect(toProspectiveOccupancy(0.5, [])).toEqual({ wholeRooms: 0, solos: ['U'] });
    expect(toProspectiveOccupancy(0.5, undefined)).toEqual({ wholeRooms: 0, solos: ['U'] });
  });

  it('多位出行人（异常兜底）→ 取第一位有明确性别者，口径同房控 pickSoloGender', () => {
    expect(toProspectiveOccupancy(0.5, [{ gender: 'X' }, { gender: 'F' }])).toEqual({
      wholeRooms: 0,
      solos: ['F'],
    });
  });

  it('整间数 → wholeRooms，不进拼房桶（不参与性别配对）', () => {
    expect(toProspectiveOccupancy(1, [{ gender: 'M' }])).toEqual({ wholeRooms: 1, solos: [] });
    expect(toProspectiveOccupancy(3, [{ gender: 'M' }])).toEqual({ wholeRooms: 3, solos: [] });
  });

  it('脏小数（如 1.5 间）→ 向上取整为整间，绝不少算', () => {
    expect(toProspectiveOccupancy(1.5, [])).toEqual({ wholeRooms: 2, solos: [] });
  });
});

describe('buildOrderFilterWhere · 搜索/乘客姓名含中文名（公测反馈：中文名搜不到）', () => {
  /** 从 where.AND 里挑出搜索词生成的 OR 匹配块（区别于 kind/出行日期等 items 维度子句）。 */
  function searchClauses(where: ReturnType<typeof buildOrderFilterWhere>) {
    return ((where.AND ?? []) as Array<Record<string, unknown>>).filter((c) => 'OR' in c) as Array<{
      OR: Array<Record<string, unknown>>;
    }>;
  }

  it('单词 search → 一个 OR 匹配块，含乘客 fullName/chineseName/documentNumber 模糊匹配', () => {
    const where = buildOrderFilterWhere({ search: '张伟' });
    const clauses = searchClauses(where);
    expect(clauses).toHaveLength(1);
    const passengerClause = clauses[0].OR.find((c) => 'passengers' in c) as {
      passengers: { some: { OR: Array<Record<string, unknown>> } };
    };
    expect(passengerClause).toBeDefined();
    expect(passengerClause.passengers.some.OR).toEqual([
      { fullName: { contains: '张伟', mode: 'insensitive' } },
      { chineseName: { contains: '张伟', mode: 'insensitive' } },
      { documentNumber: { contains: '张伟', mode: 'insensitive' } },
    ]);
  });

  it('单词 search 保留历史字段语义（订单号/联系人不区分大小写，电话原样 contains）', () => {
    const where = buildOrderFilterWhere({ search: 'co-123' });
    const [clause] = searchClauses(where);
    expect(clause.OR).toContainEqual({ orderNumber: { contains: 'co-123', mode: 'insensitive' } });
    expect(clause.OR).toContainEqual({ contactName: { contains: 'co-123', mode: 'insensitive' } });
    expect(clause.OR).toContainEqual({ contactPhone: { contains: 'co-123' } });
  });

  it('search 覆盖订单级备注六栏（notes/internalNotes/noteHotel/noteVisa/notePayment/noteSpecial）', () => {
    const where = buildOrderFilterWhere({ search: '改期' });
    const [clause] = searchClauses(where);
    for (const field of ['notes', 'internalNotes', 'noteHotel', 'noteVisa', 'notePayment', 'noteSpecial']) {
      expect(clause.OR).toContainEqual({ [field]: { contains: '改期', mode: 'insensitive' } });
    }
  });

  it('多词 search → 每词一个 OR 块、词间 AND（两词分别命中同单两位乘客时订单命中）', () => {
    const where = buildOrderFilterWhere({ search: '陈志远，林晓梅' });
    const clauses = searchClauses(where);
    expect(clauses).toHaveLength(2);
    const terms = clauses.map(
      (c) => (c.OR[0] as { orderNumber: { contains: string } }).orderNumber.contains,
    );
    expect(terms).toEqual(['陈志远', '林晓梅']);
    // 词间是 AND：都在 where.AND 里、每词独立成块 —— 其中一词不命中则整单不出。
    expect(where.OR).toBeUndefined();
  });

  it('多词 search 与 kind 等 items 维度子句共存互不覆盖', () => {
    const where = buildOrderFilterWhere({ kind: 'FLIGHT', search: '陈志远 E12345678' });
    expect(searchClauses(where)).toHaveLength(2);
    expect(
      ((where.AND ?? []) as Array<Record<string, unknown>>).filter((c) => 'items' in c),
    ).toHaveLength(1);
  });

  it('passengerName → fullName 与 chineseName 任一命中', () => {
    const where = buildOrderFilterWhere({ passengerName: '李娜' });
    expect(where.passengers).toEqual({
      some: {
        OR: [
          { fullName: { contains: '李娜', mode: 'insensitive' } },
          { chineseName: { contains: '李娜', mode: 'insensitive' } },
        ],
      },
    });
  });
});

describe('splitSearchTerms · 搜索分词', () => {
  it('空格/英文逗号/中文逗号/顿号均可作分隔符，混用亦可', () => {
    expect(splitSearchTerms('陈志远 林晓梅')).toEqual(['陈志远', '林晓梅']);
    expect(splitSearchTerms('陈志远,林晓梅')).toEqual(['陈志远', '林晓梅']);
    expect(splitSearchTerms('陈志远，林晓梅')).toEqual(['陈志远', '林晓梅']);
    expect(splitSearchTerms('陈志远、林晓梅')).toEqual(['陈志远', '林晓梅']);
    expect(splitSearchTerms('陈志远， 林晓梅、E12345678')).toEqual(['陈志远', '林晓梅', 'E12345678']);
  });

  it('trim + 去空词：首尾分隔符与连续分隔符不产生空词', () => {
    expect(splitSearchTerms('  ，陈志远，，  ')).toEqual(['陈志远']);
    expect(splitSearchTerms('   ')).toEqual([]);
  });

  it('词数上限 5：超出部分截断防滥用', () => {
    expect(splitSearchTerms('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('computeGroundItemAmounts · 订单详情地面项收入/成本双字段', () => {
  it('售价缺省时默认取产品成本价', () => {
    expect(
      resolveGroundItemUnitPrice({ costPriceCny: 180, label: '签证' }),
    ).toBe(180);
  });

  it('产品无成本价且未手动填写售价时拒绝录入', () => {
    expect(() => resolveGroundItemUnitPrice({ costPriceCny: null, label: '酒店房型' })).toThrow(
      '请手动填写售价',
    );
  });

  it('售价缺省带出成本价时，HOTEL 按晚数×间数独立计算收入与成本', () => {
    expect(
      computeGroundItemAmounts({
        kind: 'HOTEL',
        unitPriceCny: 180,
        quantity: 2,
        rooms: 0.5,
        costPriceCny: 180,
      }),
    ).toEqual({ amount: 180, unitCostCny: 180, totalCostCny: 180 });
  });

  it('手改售价不覆盖成本快照', () => {
    expect(
      computeGroundItemAmounts({
        kind: 'VISA',
        unitPriceCny: 260,
        quantity: 3,
        costPriceCny: 180,
      }),
    ).toEqual({ amount: 780, unitCostCny: 180, totalCostCny: 540 });
  });

  it('产品无成本价时成本字段保持 null，收入仍按手动售价计算', () => {
    expect(
      computeGroundItemAmounts({
        kind: 'VISA',
        unitPriceCny: 200,
        quantity: 2,
        costPriceCny: null,
      }),
    ).toEqual({ amount: 400, unitCostCny: null, totalCostCny: null });
  });
});
