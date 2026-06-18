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
    user: {
      findUnique: vi.fn(),
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
  computeBundleAddOn,
  computeBundleSeatSplit,
  computeRequiredPassengerCount,
  resolveBundleOccupancy,
  computeRoomsNeeded,
  createFulfillmentTasks,
} from './orders.service.js';
import type { OrderItemInput } from './orders.schemas.js';

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

  it('batchCreateOrders：不传 contactName/contactPhone → 录入人=登录账号（displayName 落 contactName）', async () => {
    // 无重复 → 进入逐单建单
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    // 登录用户：录入人 = 王操作（displayName）
    mockPrisma.user.findUnique.mockResolvedValue({
      displayName: '王操作',
      email: 'op@example.com',
      phone: '13900000000',
    });
    // 隔离 createOrder：只断言传入的 contact 是登录账号，不跑真事务
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
    // 录入人即登录账号：contactName=displayName，contactPhone=登录账号 phone
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ contactName: '王操作', contactPhone: '13900000000' }),
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

// ── 套餐可选升级 add-on 重算：computeBundleAddOn ──────────────────────
describe('computeBundleAddOn', () => {
  const bundle = {
    hotelNights: 3,
    singleSupplementCnyPerNight: 80,
    businessUpgradeCnyPerLeg: 700,
    childSeatDiscountCnyPerPerson: 30,
    infantPriceCny: 0,
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
    expect(r.total).toBe(0); // 0 升级 + 0 婴儿 − 30 折扣 → clamp 到 0（无其他正向项时）
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

  it('2 大 1 小 1 婴（折扣 30、婴儿价 0）→ 折扣 30、婴儿 0、净 0（升级机票仍在 FLIGHT 行）', () => {
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
    expect(r.total).toBe(0); // 升级 0 + 婴儿 0 − 折扣 30 → clamp 0
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
  }) {
    const created: Array<{ orderItemId: string; type: string; status: string }> = [];
    let seq = 0;
    const tx = {
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
});
