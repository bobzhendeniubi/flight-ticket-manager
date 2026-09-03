/**
 * 前台自助端点（M2）· 服务级测试（vitest，vi.mock Prisma，不依赖真 DB）
 *
 * 覆盖三个 service 方法的关键口径：
 *   1. selfUpdatePassenger：状态闸（出票后锁定 409 ORDER_LOCKED）、passengerId 归属校验、
 *      仅更新传入字段、返回剥离 passportPhotoUrl 大图 + hasPassportPhoto 布尔、越权 403
 *   2. requestChange：状态闸（409 ORDER_NOT_CHANGEABLE）、幂等（已是 CHANGE_REQUESTED
 *      直接返回不再写库）、happy path 走状态机（记 OrderStatusEvent）+ 建 HIGH 运营提醒
 *   3. getOrderItineraryData：状态闸（409 ITINERARY_NOT_READY）、无航班行 409
 *      NO_FLIGHT_ITEMS、happy path 航段/乘客映射
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
    },
    passenger: {
      findUnique: vi.fn(),
      // findMany：补录反向查重（证件从空补成真值时查同班次是否已有人用这本护照）。
      findMany: vi.fn(),
      update: vi.fn(),
    },
    // 反向查重要先知道本单占着哪几个班次。
    orderItem: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// audit 由路由层调用；mock 掉避免真写库
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService } from './orders.service.js';
import {
  resolvePassengerPatchChannel,
  selfUpdatePassengerBodySchema,
  swapPassengerBodySchema,
} from './orders.schemas.js';
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const OWNER = { userId: 'u1', role: UserRole.CUSTOMER };

/** 最小 Decimal 桩：serializeOrder 只用 toString / greaterThan / toFixed。 */
const dec = (s: string) => ({
  toString: () => s,
  toFixed: () => s,
  greaterThan: () => false,
});

beforeEach(() => {
  mockPrisma.order.findUnique.mockReset();
  mockPrisma.passenger.findUnique.mockReset();
  mockPrisma.passenger.findMany.mockReset();
  mockPrisma.passenger.update.mockReset();
  mockPrisma.orderItem.findMany.mockReset();
  mockPrisma.$transaction.mockReset();
});

// ── 1. selfUpdatePassenger ─────────────────────────────────────────────
describe('selfUpdatePassenger', () => {
  const orderRow = {
    id: 'o1',
    status: 'PAID',
    userId: 'u1',
    agentId: null,
    orderNumber: 'FTM20260709001',
  };

  it('出票后（TICKETED）→ 409 ORDER_LOCKED，不写库', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...orderRow, status: 'TICKETED' });
    const err = await service
      .selfUpdatePassenger('o1', 'p1', { chineseName: '张三' }, OWNER)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('ORDER_LOCKED');
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('passengerId 不属于该订单 → 404', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);
    mockPrisma.passenger.findUnique.mockResolvedValue({ id: 'p1', orderId: 'other-order' });
    await expect(
      service.selfUpdatePassenger('o1', 'p1', { chineseName: '张三' }, OWNER),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('非本人订单（CUSTOMER）→ 403', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...orderRow, userId: 'someone-else' });
    await expect(
      service.selfUpdatePassenger('o1', 'p1', { chineseName: '张三' }, OWNER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('happy path：仅更新传入字段；返回剥离大图 + hasPassportPhoto', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);
    mockPrisma.passenger.findUnique.mockResolvedValue({ id: 'p1', orderId: 'o1' });
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      fullName: 'ZHANG SAN',
      chineseName: '张三',
      passportExpiry: new Date('2030-01-01'),
      passportPhotoUrl: 'data:image/jpeg;base64,xxxx',
    });

    const result = await service.selfUpdatePassenger(
      'o1',
      'p1',
      { chineseName: '张三', passportExpiry: '2030-01-01' },
      OWNER,
    );

    // 仅传入字段进 update.data；日期字符串转 Date
    const updateArg = mockPrisma.passenger.update.mock.calls[0][0];
    expect(Object.keys(updateArg.data).sort()).toEqual(['chineseName', 'passportExpiry']);
    expect(updateArg.data.passportExpiry).toBeInstanceOf(Date);
    expect(result.changedFields.sort()).toEqual(['chineseName', 'passportExpiry']);

    // 序列化：大图剥离，布尔代替
    expect(result.passenger).not.toHaveProperty('passportPhotoUrl');
    expect(result.passenger.hasPassportPhoto).toBe(true);
    expect(result.orderNumber).toBe('FTM20260709001');
  });

  it('运营补录（ADMIN/STAFF）：非本人单也放行、仅更新证件字段', async () => {
    // 归属校验对 ADMIN/STAFF 直接放行（assertCanView）——运营可替任意订单补录护照资料。
    const OPS = { userId: 'admin1', role: UserRole.STAFF };
    mockPrisma.order.findUnique.mockResolvedValue({ ...orderRow, userId: 'someone-else' });
    mockPrisma.passenger.findUnique.mockResolvedValue({ id: 'p1', orderId: 'o1' });
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      fullName: 'ZHANG SAN',
      passportIssueDate: new Date('2020-03-15'),
      passportExpiry: new Date('2030-03-14'),
    });

    const result = await service.selfUpdatePassenger(
      'o1',
      'p1',
      { passportIssueDate: '2020-03-15', passportExpiry: '2030-03-14' },
      OPS,
    );
    const updateArg = mockPrisma.passenger.update.mock.calls[0][0];
    expect(Object.keys(updateArg.data).sort()).toEqual(['passportExpiry', 'passportIssueDate']);
    expect(result.changedFields.sort()).toEqual(['passportExpiry', 'passportIssueDate']);
  });
});

// ── 1a. selfUpdatePassenger · 补录护照的反向同班次查重 ────────────────────────────
//
// 建单查重只在**建单那一刻**量得到。占位单转正的乘客当时只填姓名、证件号落库是空串，
// 那一刻量不出任何东西；若同期还有人在同一班次用这本真护照建过单，这份重复要等到
// 护照补录落库那一刻才浮出水面 —— 补完之后，同一个人在同一班次上实打实占着两份座。
// 所以补录路径要回头再查一次。这条路**没有强录口子**：两张单总有一张要收口，
// 先处理掉那一张再来补录。
describe('selfUpdatePassenger · 补录护照的反向同班次查重', () => {
  const NEW_DOCUMENT = 'E12345678';
  const OPS = { userId: 'staff1', role: UserRole.STAFF };

  /** 摆好一次补录：本单一段去程班次 sch-out，乘客证件号现状由 currentDocument 给定。 */
  function arm(
    opts: {
      currentDocument?: string | null;
      legScheduleIds?: Array<string | null>;
      conflictOrderNumbers?: string[];
    } = {},
  ): void {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: 'PAID',
      userId: 'u1',
      agentId: null,
      orderNumber: 'FTM20260709001',
    });
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      documentNumber: opts.currentDocument ?? '',
    });
    mockPrisma.orderItem.findMany.mockResolvedValue(
      (opts.legScheduleIds ?? ['sch-out']).map((flightScheduleId) => ({ flightScheduleId })),
    );
    mockPrisma.passenger.findMany.mockResolvedValue(
      (opts.conflictOrderNumbers ?? []).map((orderNumber) => ({ order: { orderNumber } })),
    );
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      fullName: 'ZHANG SAN',
      documentNumber: NEW_DOCUMENT,
    });
  }

  it('证件从「待补」补成真值、同班次已有人用同一本护照 → 拦（带冲突订单号），且不落库', async () => {
    arm({ currentDocument: '', conflictOrderNumbers: ['FTM-DUP-001'] });

    const err = await service
      .selfUpdatePassenger('o1', 'p1', { documentNumber: NEW_DOCUMENT }, OPS)
      .then(() => null, (e: unknown) => e as AppError);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('DUPLICATE_PASSENGER');
    expect((err as AppError).message).toContain('FTM-DUP-001');
    // 补录一旦落库两份座就都算数了 —— 必须拦在 update 之前。
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('查重范围与建单闸同源：本单各航段班次上的占座中订单，且排除本单自己', async () => {
    arm({ currentDocument: '', conflictOrderNumbers: ['FTM-DUP-001'] });

    await service
      .selfUpdatePassenger('o1', 'p1', { documentNumber: NEW_DOCUMENT }, OPS)
      .catch(() => undefined);

    const where = mockPrisma.passenger.findMany.mock.calls[0][0].where;
    expect(where.documentNumber).toBe(NEW_DOCUMENT);
    expect(where.orderId).toEqual({ not: 'o1' });
    expect(where.order.items.some.flightScheduleId).toEqual({ in: ['sch-out'] });
    expect(where.order.status.in).toContain('PAID');
    // 已取消的单不占座，不该拦住补录。
    expect(where.order.status.in).not.toContain('CANCELLED');
  });

  it('同班次没人用这本护照 → 照常补录落库', async () => {
    arm({ currentDocument: '', conflictOrderNumbers: [] });

    const res = await service.selfUpdatePassenger(
      'o1',
      'p1',
      { documentNumber: NEW_DOCUMENT },
      OPS,
    );

    expect(res.changedFields).toContain('documentNumber');
    expect(mockPrisma.passenger.update).toHaveBeenCalledTimes(1);
  });

  it('本来就有证件号（是改证件不是补录）→ 不走这道闸，一次查重都不打', async () => {
    arm({ currentDocument: 'E00000001', conflictOrderNumbers: ['FTM-DUP-001'] });

    await service.selfUpdatePassenger('o1', 'p1', { documentNumber: NEW_DOCUMENT }, OPS);

    expect(mockPrisma.passenger.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.passenger.update).toHaveBeenCalledTimes(1);
  });

  it('本次没改证件号（只补有效期）→ 不走这道闸', async () => {
    arm({ currentDocument: '', conflictOrderNumbers: ['FTM-DUP-001'] });

    await service.selfUpdatePassenger('o1', 'p1', { passportExpiry: '2035-06-30' }, OPS);

    expect(mockPrisma.passenger.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.passenger.update).toHaveBeenCalledTimes(1);
  });

  // 纯酒店 / 接送单没有航段，就没有「同班次」这个概念，无从比对 —— 不能因此把补录锁死。
  it('本单没有有效航段 → 无从比对，放行', async () => {
    arm({ currentDocument: '', legScheduleIds: [], conflictOrderNumbers: ['FTM-DUP-001'] });

    await service.selfUpdatePassenger('o1', 'p1', { documentNumber: NEW_DOCUMENT }, OPS);

    expect(mockPrisma.passenger.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.passenger.update).toHaveBeenCalledTimes(1);
  });
});

// ── 1b. resolvePassengerPatchChannel（补录 vs 换人 双通道判定）──────────────────
describe('resolvePassengerPatchChannel', () => {
  it('前台角色（CUSTOMER/AGENT）一律走补录', () => {
    for (const role of [UserRole.CUSTOMER, UserRole.AGENT]) {
      expect(resolvePassengerPatchChannel(role, { passportExpiry: '2030-01-01' })).toBe('SELF_UPDATE');
      // 前台即便误带换人语义字段也判为补录（后续 schema 严格解析会自然拒绝换人字段）
      expect(resolvePassengerPatchChannel(role, { fullName: 'NEW PERSON' })).toBe('SELF_UPDATE');
    }
  });

  it('运营（ADMIN/STAFF）仅护照/证件字段（无换人语义字段）→ 补录', () => {
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      expect(
        resolvePassengerPatchChannel(role, { passportIssueDate: '2020-03-15', passportPhotoUrl: 'data:image/png;base64,AAAA' }),
      ).toBe('SELF_UPDATE');
      expect(resolvePassengerPatchChannel(role, { documentNumber: 'E12345678', dateOfBirth: '1990-01-01' })).toBe('SELF_UPDATE');
    }
  });

  it('运营（ADMIN/STAFF）带换人语义字段 → 换人', () => {
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      expect(resolvePassengerPatchChannel(role, { fullName: 'NEW PERSON' })).toBe('SWAP');
      expect(resolvePassengerPatchChannel(role, { resetVisa: true })).toBe('SWAP');
      expect(resolvePassengerPatchChannel(role, { feeCny: 100 })).toBe('SWAP');
    }
  });

  it('运营字段混合（证件字段 + 换人语义字段）→ 换人（换人语义字段一票判定）', () => {
    expect(
      resolvePassengerPatchChannel(UserRole.ADMIN, { documentNumber: 'E99', fullName: 'NEW PERSON' }),
    ).toBe('SWAP');
  });

  // 护照有效期/签发日两个 schema 都有 → 绝不能进「换人独有键」集合，否则只补护照资料的请求
  // 会被误分流到换人通道。换人表单带着它们提交时靠 fullName 等换人语义字段判定，
  // 且换人 schema 必须接得住这两个键（不然分流对了却 400）。
  it('只带护照有效期/签发日 → 补录；与换人语义字段同行 → 换人且换人 schema 接得住', () => {
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      expect(resolvePassengerPatchChannel(role, { passportExpiry: '2035-06-30' })).toBe('SELF_UPDATE');
      expect(resolvePassengerPatchChannel(role, { passportIssueDate: '2025-06-30' })).toBe('SELF_UPDATE');
    }
    const swapBody = {
      fullName: 'NEW PERSON',
      documentNumber: 'E12345678',
      passportExpiry: '2035-06-30',
      passportIssueDate: '2025-06-30',
    };
    expect(resolvePassengerPatchChannel(UserRole.ADMIN, swapBody)).toBe('SWAP');
    expect(swapPassengerBodySchema.safeParse(swapBody).success).toBe(true);
  });

  // 换人 schema 独有、补录 schema 没有的新出行人属性 —— 漏进分流集合就会被判成补录，
  // 而补录 schema 是 .strict() 的 → 400；换人通道后面挂着的自备签→签证任务同步也整条跑不到。
  it.each([
    ['visaExempt', { visaExempt: true }],
    ['singleRoom', { singleRoom: true }],
    ['title', { title: 'MR' }],
    ['passengerType', { passengerType: 'CHILD' }],
  ])('运营单独提交 %s → 走换人通道（不被分流到补录后 400）', (_label, body) => {
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      expect(resolvePassengerPatchChannel(role, body)).toBe('SWAP');
    }
  });

  it('分流集合与换人 schema 独有键保持一致：分流过去后 body 确实过得了换人 schema', () => {
    expect(resolvePassengerPatchChannel(UserRole.ADMIN, { visaExempt: false })).toBe('SWAP');
    expect(swapPassengerBodySchema.safeParse({ visaExempt: false }).success).toBe(true);
    expect(swapPassengerBodySchema.safeParse({ singleRoom: true }).success).toBe(true);
    // 反向：补录 schema 是 .strict() 的，这些键在它那里必然被拒 —— 分流错了就是 400
    expect(selfUpdatePassengerBodySchema.safeParse({ visaExempt: false }).success).toBe(false);
    expect(selfUpdatePassengerBodySchema.safeParse({ singleRoom: true }).success).toBe(false);
  });

  it('前台角色带这些字段仍走补录（换人只能联系客服，口径不变）', () => {
    for (const role of [UserRole.CUSTOMER, UserRole.AGENT]) {
      expect(resolvePassengerPatchChannel(role, { visaExempt: true })).toBe('SELF_UPDATE');
    }
  });
});

// ── 2. requestChange ───────────────────────────────────────────────────
describe('requestChange', () => {
  const orderRow = {
    id: 'o1',
    status: 'PAID',
    userId: 'u1',
    agentId: null,
    orderNumber: 'FTM20260709001',
  };

  it('待支付订单 → 409 ORDER_NOT_CHANGEABLE，不开事务', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...orderRow, status: 'PENDING_PAYMENT' });
    const err = await service
      .requestChange('o1', '想改到 7 月 20 日出发', OWNER)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('ORDER_NOT_CHANGEABLE');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('幂等：已是 CHANGE_REQUESTED → 直接返回当前订单，不再写库', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...orderRow, status: 'CHANGE_REQUESTED' });
    const getOrderSpy = vi
      .spyOn(service, 'getOrder')
      .mockResolvedValue({ id: 'o1', orderNumber: 'FTM20260709001', status: 'CHANGE_REQUESTED' } as never);

    const result = await service.requestChange('o1', '想改到 7 月 20 日出发', OWNER);
    expect(result.idempotent).toBe(true);
    expect(getOrderSpy).toHaveBeenCalledWith('o1', OWNER);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    getOrderSpy.mockRestore();
  });

  it('happy path（PAID）：走状态机记 OrderStatusEvent + 建 HIGH 运营提醒', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);

    const fullOrder = {
      id: 'o1',
      orderNumber: 'FTM20260709001',
      status: 'CHANGE_REQUESTED',
      subtotal: dec('100.00'),
      taxesAndFees: dec('0.00'),
      discountTotal: dec('0.00'),
      total: dec('100.00'),
      paidAmount: dec('100.00'),
      prepaymentOffset: dec('0.00'),
      adjustmentCny: 0,
      items: [],
      passengers: [],
      payments: [],
      refunds: [],
      statusEvents: [],
      agent: null,
      user: null,
    };
    const tx = {
      order: {
        // _updateStatusWithinTx 内部按当前状态做 CAS
        findUnique: vi.fn().mockResolvedValue({ ...orderRow, items: [], paidAmount: dec('100.00'), total: dec('100.00') }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(fullOrder),
      },
      orderStatusEvent: { create: vi.fn() },
      operationalReminder: { create: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const result = await service.requestChange('o1', '想改到 7 月 20 日出发', OWNER);

    expect(result.idempotent).toBe(false);
    expect(result.order.status).toBe('CHANGE_REQUESTED');
    // 状态机 CAS + 事件（PAID → CHANGE_REQUESTED 已进白名单）
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', status: 'PAID' } }),
    );
    expect(tx.orderStatusEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromStatus: 'PAID', toStatus: 'CHANGE_REQUESTED' }),
      }),
    );
    // 运营待办提醒（HIGH）
    expect(tx.operationalReminder.create).toHaveBeenCalledWith({
      data: {
        orderId: 'o1',
        createdById: 'u1',
        title: '【改签申请】FTM20260709001',
        body: '想改到 7 月 20 日出发',
        priority: 'HIGH',
      },
    });
  });
});

// ── 3. getOrderItineraryData ───────────────────────────────────────────
describe('getOrderItineraryData', () => {
  const baseOrder = {
    id: 'o1',
    status: 'TICKETED',
    userId: 'u1',
    agentId: null,
    orderNumber: 'FTM20260709001',
    contactName: '张三',
    contactPhone: '13800000000',
    contactEmail: null,
    total: dec('1234.00'),
    currency: 'CNY',
    createdAt: new Date('2026-07-09T00:00:00Z'),
    passengers: [
      { fullName: 'ZHANG SAN', documentNumber: 'E12345678', pnr: 'ABC123', eticketNumber: null },
    ],
    items: [] as unknown[],
  };

  it('未付款（PENDING_PAYMENT）→ 409 ITINERARY_NOT_READY', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: 'PENDING_PAYMENT' });
    const err = await service
      .getOrderItineraryData('o1', OWNER)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('ITINERARY_NOT_READY');
  });

  it('纯地面单（无 FLIGHT 行）→ 409 NO_FLIGHT_ITEMS', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      ...baseOrder,
      items: [{ kind: 'HOTEL', flightSchedule: null }],
    });
    const err = await service
      .getOrderItineraryData('o1', OWNER)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('NO_FLIGHT_ITEMS');
  });

  it('happy path：映射航段 + 乘客（护照号 = documentNumber）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      ...baseOrder,
      items: [
        {
          kind: 'FLIGHT',
          flightCabin: 'ECONOMY',
          flightSchedule: {
            departureTime: new Date('2026-07-13T08:30:00Z'),
            arrivalTime: new Date('2026-07-13T10:00:00Z'),
            flight: { flightNumber: 'VJ2534', originCode: 'MFM', destinationCode: 'DAD' },
          },
        },
      ],
    });

    const { orderNumber, itinerary } = await service.getOrderItineraryData('o1', OWNER);
    expect(orderNumber).toBe('FTM20260709001');
    expect(itinerary.flights).toHaveLength(1);
    expect(itinerary.flights[0]).toMatchObject({
      flightNumber: 'VJ2534',
      origin: 'MFM',
      destination: 'DAD',
      cabin: 'ECONOMY',
    });
    expect(itinerary.passengers[0]).toEqual({
      fullName: 'ZHANG SAN',
      passportNumber: 'E12345678',
      pnr: 'ABC123',
      eticketNumber: null,
    });
    expect(itinerary.total).toBe('1234.00');
  });
});
