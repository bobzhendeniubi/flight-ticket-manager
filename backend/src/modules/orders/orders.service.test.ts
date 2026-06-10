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
const { mockPrisma, mockComputeQuote } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    passenger: {
      findMany: vi.fn(),
    },
  },
  mockComputeQuote: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../lib/cancellation.js', () => ({
  computeCancellationQuote: mockComputeQuote,
}));

// 现在才能 import service
import {
  OrderService,
  assertVisaPassengersHavePassportExpiry,
  resolveBundleHotelStamp,
} from './orders.service.js';

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

  it('查重无命中 → 校验通过（不抛重复错误）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    // 直接调私有校验方法：通过 = resolve，不抛
    await expect(
      (service as unknown as {
        assertNoDuplicatePassengersOnFlights(s: string[], d: string[]): Promise<void>;
      }).assertNoDuplicatePassengersOnFlights(['sched-1'], ['E12345678']),
    ).resolves.toBeUndefined();
  });

  it('无 FLIGHT 班次（纯酒店/签证单）→ 跳过查重，不查库', async () => {
    await (service as unknown as {
      assertNoDuplicatePassengersOnFlights(s: string[], d: string[]): Promise<void>;
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
});

// ── 套餐酒店盖章：resolveBundleHotelStamp ─────────────────────────────
describe('resolveBundleHotelStamp', () => {
  const linkedBundle = { hotelRoomTypeId: 'rt1', hotelNights: 3 };

  it('套餐没关联房型 → null', () => {
    expect(
      resolveBundleHotelStamp(
        { hotelRoomTypeId: null, hotelNights: null },
        { goDate: '2026-07-01' },
      ),
    ).toBeNull();
  });

  it('goDate 缺失 → null（不盖章，不抛错）', () => {
    expect(resolveBundleHotelStamp(linkedBundle, undefined)).toBeNull();
    expect(resolveBundleHotelStamp(linkedBundle, {})).toBeNull();
  });

  it('returnDate 合法且晚于 goDate → 用 returnDate 做退房日', () => {
    const stamp = resolveBundleHotelStamp(linkedBundle, {
      goDate: '2026-07-01',
      returnDate: '2026-07-04',
    });
    expect(stamp).toEqual({
      hotelRoomTypeId: 'rt1',
      hotelCheckIn: new Date('2026-07-01'),
      hotelCheckOut: new Date('2026-07-04'),
    });
  });

  it('returnDate 缺失 → goDate + hotelNights 推退房日', () => {
    const stamp = resolveBundleHotelStamp(linkedBundle, { goDate: '2026-07-01' });
    expect(stamp?.hotelCheckOut).toEqual(new Date('2026-07-04'));
  });

  it('returnDate ≤ goDate → 回落到 hotelNights；hotelNights 空默认 1 晚', () => {
    const sameDay = resolveBundleHotelStamp(linkedBundle, {
      goDate: '2026-07-01',
      returnDate: '2026-07-01',
    });
    expect(sameDay?.hotelCheckOut).toEqual(new Date('2026-07-04'));

    const oneNight = resolveBundleHotelStamp(
      { hotelRoomTypeId: 'rt1', hotelNights: null },
      { goDate: '2026-07-01' },
    );
    expect(oneNight?.hotelCheckOut).toEqual(new Date('2026-07-02'));
  });

  it('metadata 畸形（错误类型/非法格式）→ 降级不抛错', () => {
    expect(resolveBundleHotelStamp(linkedBundle, { goDate: 12345 } as never)).toBeNull();
    expect(resolveBundleHotelStamp(linkedBundle, { goDate: 'not-a-date' })).toBeNull();
    // goDate 合法但 returnDate 畸形 → 仍盖章，按 hotelNights 推退房日
    const stamp = resolveBundleHotelStamp(linkedBundle, {
      goDate: '2026-07-01',
      returnDate: 'garbage',
    });
    expect(stamp?.hotelCheckIn).toEqual(new Date('2026-07-01'));
    expect(stamp?.hotelCheckOut).toEqual(new Date('2026-07-04'));
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
