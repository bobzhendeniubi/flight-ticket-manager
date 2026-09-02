/**
 * 按人改期（POST /orders/:id/reschedule-passengers）· 服务级单测
 *
 * 组合闸口本身的职责很窄：判航段、判是否全员、串起「拆单 → 对新单改期」。
 * 拆单与改期各自的事务/守恒/座位逻辑由 orders.split.test.ts 与 orders.service.test.ts 覆盖，
 * 这里把两者 spy 掉，只验证编排契约：
 *   1. 权限：非 ADMIN/STAFF → ForbiddenError（未触库）。
 *   2. 入参守卫：订单不存在 / 乘客不属于本单 / 航段行不是去回程。
 *   3. 全员勾选 → 直接整单改期，不拆单。
 *   4. 部分乘客 → 先拆单、再对**新单**按航段改期，源单不被就地改期。
 *   5. 拆成了但改期失败 → 409 结构化错误、拆单不回滚、新单信息随错误返回。
 *   6. 同 requestToken 重试 → 拆单回放；新单已在目标班次则不再调改期（不重复收差价）。
 *   7. 已出票单（拆单闸 6/12 放开后的主场景）：三人单勾一人 → 拆单 → 只对新单改期，
 *      作废票的动作全部落在新单上，源单留守乘客的票与开票位不被触碰。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderItem: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const admin = { userId: 'admin-1', role: 'ADMIN' as const };
const TOKEN = '00000000-0000-4000-8000-00000000abcd';

const OUT_DEPART = new Date('2026-09-10T02:00:00.000Z');
const RET_DEPART = new Date('2026-09-15T02:00:00.000Z');

/** prisma.order.findUnique 的源单快照（乘客名册 + 带班次的机票行）。 */
const sourceSnapshot = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'FTM20260901-SRC',
  passengers: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
  items: [
    {
      id: 'leg-out',
      flightScheduleId: 'sch-out',
      flightSchedule: { departureTime: OUT_DEPART },
    },
    {
      id: 'leg-ret',
      flightScheduleId: 'sch-ret',
      flightSchedule: { departureTime: RET_DEPART },
    },
  ],
  ...over,
});

/** serializeOrder 的最小可序列化订单（回读两侧订单用）。 */
const serializableOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'FTM20260901-SRC',
  status: 'PAID',
  subtotal: new Prisma.Decimal(6000),
  taxesAndFees: new Prisma.Decimal(0),
  discountTotal: new Prisma.Decimal(0),
  total: new Prisma.Decimal(6000),
  paidAmount: new Prisma.Decimal(6000),
  prepaymentOffset: new Prisma.Decimal(0),
  adjustmentCny: 0,
  items: [],
  passengers: [],
  payments: [],
  ...over,
});

const splitOutcome = (over: Record<string, unknown> = {}) => ({
  sourceOrderId: 'o1',
  sourceOrderNumber: 'FTM20260901-SRC',
  targetOrderId: 'o2',
  targetOrderNumber: 'FTM20260901-TGT',
  movedShareCny: 2000,
  movedPaidCny: 2000,
  passengerCount: 1,
  replayed: false,
  ...over,
});

const rescheduleOutcome = (orderNumber = 'FTM20260901-TGT') => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  order: { id: 'o2', orderNumber } as any,
  audit: {
    orderNumber,
    orderItemId: 'leg-out-moved',
    fromScheduleId: 'sch-out',
    fromCabin: 'ECONOMY' as const,
    fromDeparture: OUT_DEPART,
    toScheduleId: 'sch-new',
    toCabin: 'ECONOMY' as const,
    toDeparture: new Date('2026-09-12T02:00:00.000Z'),
    feeCny: 300,
    statusChanged: false,
    hotelDateSync: [],
  },
});

const body = (over: Record<string, unknown> = {}) => ({
  passengerIds: ['p1'],
  orderItemId: 'leg-out',
  newScheduleId: 'sch-new',
  feeCny: 300,
  requestToken: TOKEN,
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(serializableOrder());
  mockPrisma.orderItem.findMany.mockResolvedValue([
    { id: 'leg-out-moved', flightScheduleId: 'sch-out' },
    { id: 'leg-ret-moved', flightScheduleId: 'sch-ret' },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════
describe('按人改期 · 权限与入参守卫', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('%s → ForbiddenError，未触库', async (role) => {
    await expect(
      service.reschedulePassengers('o1', body(), { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('订单不存在 → NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(service.reschedulePassengers('missing', body(), admin)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('所选乘客不属于本订单 → BadRequestError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    await expect(
      service.reschedulePassengers('o1', body({ passengerIds: ['ghost'] }), admin),
    ).rejects.toThrow(/不属于本订单/u);
  });

  it('航段行不是本单的去程/回程 → BadRequestError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    await expect(
      service.reschedulePassengers('o1', body({ orderItemId: 'not-a-leg' }), admin),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('没有任何机票行 → BadRequestError（无从判定航段）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot({ items: [] }));
    await expect(service.reschedulePassengers('o1', body(), admin)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('按人改期 · 全员勾选 = 整单改期（不拆单）', () => {
  it('直接对源单改期，不调用拆单', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    const split = vi.spyOn(service, 'splitOrder');
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockResolvedValue(rescheduleOutcome('FTM20260901-SRC'));

    const result = await service.reschedulePassengers(
      'o1',
      body({ passengerIds: ['p1', 'p2', 'p3'] }),
      admin,
    );

    expect(split).not.toHaveBeenCalled();
    expect(reschedule).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ orderItemId: 'leg-out', newScheduleId: 'sch-new', feeCny: 300 }),
      admin,
    );
    // 整单改期走 orderItemId，不走航段入口
    expect(reschedule.mock.calls[0][1]).not.toHaveProperty('leg');
    expect(result.splitPerformed).toBe(false);
    expect(result.newOrder).toBeNull();
    expect(result.audit.newOrderNumber).toBeNull();
    expect(result.audit.passengerCount).toBe(3);
    expect(result.audit.leg).toBe('OUTBOUND');
  });

  it('重复勾选同一位乘客不算多人：去重后仍是全员 → 不拆单', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot({ passengers: [{ id: 'p1' }] }));
    const split = vi.spyOn(service, 'splitOrder');
    vi.spyOn(service, 'rescheduleOrderItem').mockResolvedValue(
      rescheduleOutcome('FTM20260901-SRC'),
    );

    const result = await service.reschedulePassengers(
      'o1',
      body({ passengerIds: ['p1', 'p1'] }),
      admin,
    );
    expect(split).not.toHaveBeenCalled();
    expect(result.audit.passengerCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('按人改期 · 部分乘客 = 先拆单再对新单改期', () => {
  it('拆单入参透传、改期落在新单上并按航段定位、源单不被就地改期', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    const split = vi.spyOn(service, 'splitOrder').mockResolvedValue(splitOutcome());
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockResolvedValue(rescheduleOutcome());

    const result = await service.reschedulePassengers(
      'o1',
      body({ roomSplit: [{ itemId: 'hotel-1', roomsBilledToMove: 0.5 }], note: '客人单独改期' }),
      admin,
    );

    expect(split).toHaveBeenCalledWith(
      'o1',
      {
        passengerIds: ['p1'],
        roomSplit: [{ itemId: 'hotel-1', roomsBilledToMove: 0.5 }],
        note: '客人单独改期',
        requestToken: TOKEN,
        // 编排路径：混合房组自动劈半 + 未给的间数/升舱位按人头自动派生
        autoSplitRoomGroups: true,
      },
      admin,
    );
    // 改期打在新单 o2 上，用 leg 定位（新单的行 id 与源单不同）
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(reschedule).toHaveBeenCalledWith(
      'o2',
      expect.objectContaining({ leg: 'OUTBOUND', newScheduleId: 'sch-new', feeCny: 300 }),
      admin,
    );
    expect(reschedule.mock.calls[0][0]).not.toBe('o1');

    expect(result.splitPerformed).toBe(true);
    expect(result.newOrder).not.toBeNull();
    expect(result.audit).toMatchObject({
      orderNumber: 'FTM20260901-SRC',
      newOrderId: 'o2',
      newOrderNumber: 'FTM20260901-TGT',
      passengerCount: 1,
      leg: 'OUTBOUND',
      toScheduleId: 'sch-new',
      feeCny: 300,
      splitReplayed: false,
      rescheduleSkipped: false,
      split: { movedShareCny: 2000, movedPaidCny: 2000 },
    });
    // 汇总审计（CRITICAL）
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'RESCHEDULE_PASSENGERS',
      severity: 'CRITICAL',
    });
  });

  it('改回程 → leg=RETURN', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    vi.spyOn(service, 'splitOrder').mockResolvedValue(splitOutcome());
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockResolvedValue(rescheduleOutcome());

    const result = await service.reschedulePassengers('o1', body({ orderItemId: 'leg-ret' }), admin);

    expect(reschedule).toHaveBeenCalledWith(
      'o2',
      expect.objectContaining({ leg: 'RETURN' }),
      admin,
    );
    expect(result.audit.leg).toBe('RETURN');
  });

  it('拆单本身失败 → 原样抛出，不调用改期', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    vi.spyOn(service, 'splitOrder').mockRejectedValue(
      new BadRequestError('当前不能拆单：\n该订单已有开票记录'),
    );
    const reschedule = vi.spyOn(service, 'rescheduleOrderItem');

    await expect(service.reschedulePassengers('o1', body(), admin)).rejects.toThrow(/不能拆单/u);
    expect(reschedule).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 已出票单（拆单闸 6/12 放开后的主场景）：三人单只给一位客人改期。
// 两块拼图各自有专门覆盖 —— 拆单侧「票随人走」见 orders.split.test.ts，
// 改期侧「换班次即作废原票（按 orderId 清票 + 翻回本单开票位）」见 orders.service.test.ts。
// 这里验证的是**编排把这两块拼在哪张单上**：改期只打在新单，源单一次都没被改期。
// 两个 spy 各按自己那块的既有契约做最小模拟，好让票的最终归属看得见。
// ══════════════════════════════════════════════════════════════════════════
describe('按人改期 · 已出票三人单勾一人', () => {
  it('拆单成功 → 只对新单改期：作废票落在新单，源单两位乘客的票与开票位不动', async () => {
    /** 两张单的票务快照（拆前只有源单）：每人一个票号 + 订单级去程开票位。 */
    const ticketing: Record<string, { pax: Array<{ id: string; pnr: string | null }>; outboundInvoiced: boolean }> = {
      o1: {
        pax: [
          { id: 'p1', pnr: 'ABC123' },
          { id: 'p2', pnr: 'ABC123' },
          { id: 'p3', pnr: 'ABC123' },
        ],
        outboundInvoiced: true,
      },
    };
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());

    // 拆单：乘客整行搬到新单（票号随人走）+ 开票位复制给新单，源单其余人原样留守。
    const split = vi.spyOn(service, 'splitOrder').mockImplementation(async () => {
      const moved = ticketing.o1.pax.filter((p) => p.id === 'p1');
      ticketing.o1 = {
        pax: ticketing.o1.pax.filter((p) => p.id !== 'p1'),
        outboundInvoiced: ticketing.o1.outboundInvoiced,
      };
      ticketing.o2 = { pax: moved, outboundInvoiced: true };
      return splitOutcome();
    });
    // 改期：换班次即作废原票 —— 只清**被调用那张单**的票号并翻回它的开票位。
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockImplementation(async (targetOrderId: string) => {
        const snapshot = ticketing[targetOrderId];
        if (snapshot) {
          snapshot.pax = snapshot.pax.map((p) => ({ ...p, pnr: null }));
          snapshot.outboundInvoiced = false;
        }
        return rescheduleOutcome();
      });

    const result = await service.reschedulePassengers('o1', body(), admin);

    // 已出票单不再被拆单闸挡回去：真的拆了，且只拆勾选的那一位
    expect(split).toHaveBeenCalledTimes(1);
    expect(split.mock.calls[0][1].passengerIds).toEqual(['p1']);
    // 改期只打在新单上，源单一次都没被改期
    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(reschedule.mock.calls[0][0]).toBe('o2');
    // 新单：拆出去那位的票被作废、开票位翻回未开（票务台据此重开）
    expect(ticketing.o2.pax).toEqual([{ id: 'p1', pnr: null }]);
    expect(ticketing.o2.outboundInvoiced).toBe(false);
    // 源单：留守两位的票号与开票位一概不动
    expect(ticketing.o1.pax).toEqual([
      { id: 'p2', pnr: 'ABC123' },
      { id: 'p3', pnr: 'ABC123' },
    ]);
    expect(ticketing.o1.outboundInvoiced).toBe(true);
    expect(result.splitPerformed).toBe(true);
    expect(result.audit.newOrderNumber).toBe('FTM20260901-TGT');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('按人改期 · 拆成了但改期失败', () => {
  it('抛 409 结构化错误，拆单不回滚，错误体带新单号', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    vi.spyOn(service, 'splitOrder').mockResolvedValue(splitOutcome());
    vi.spyOn(service, 'rescheduleOrderItem').mockRejectedValue(
      new BadRequestError('目标班次不存在该舱位，无法改期'),
    );

    const err = await service.reschedulePassengers('o1', body(), admin).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('SPLIT_DONE_RESCHEDULE_FAILED');
    expect(err.details).toMatchObject({
      splitPerformed: true,
      newOrderId: 'o2',
      newOrderNumber: 'FTM20260901-TGT',
      passengerCount: 1,
      reason: '目标班次不存在该舱位，无法改期',
    });
    expect(err.message).toContain('FTM20260901-TGT');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('按人改期 · 幂等（同 requestToken 重试）', () => {
  it('拆单回放 + 新单已在目标班次 → 不再调改期（不重复收差价）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    vi.spyOn(service, 'splitOrder').mockResolvedValue(splitOutcome({ replayed: true }));
    const reschedule = vi.spyOn(service, 'rescheduleOrderItem');
    mockPrisma.orderItem.findMany.mockResolvedValue([
      { id: 'leg-out-moved', flightScheduleId: 'sch-new' },
      { id: 'leg-ret-moved', flightScheduleId: 'sch-ret' },
    ]);

    const result = await service.reschedulePassengers('o1', body(), admin);

    expect(reschedule).not.toHaveBeenCalled();
    expect(result.splitPerformed).toBe(true);
    expect(result.audit.splitReplayed).toBe(true);
    expect(result.audit.rescheduleSkipped).toBe(true);
    expect(result.audit.reschedule).toBeNull();
    expect(result.newOrder).not.toBeNull();
  });

  it('拆单回放但新单还没改成（上一轮改期失败）→ 继续对新单改期', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(sourceSnapshot());
    vi.spyOn(service, 'splitOrder').mockResolvedValue(splitOutcome({ replayed: true }));
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockResolvedValue(rescheduleOutcome());

    const result = await service.reschedulePassengers('o1', body(), admin);

    expect(reschedule).toHaveBeenCalledWith(
      'o2',
      expect.objectContaining({ leg: 'OUTBOUND' }),
      admin,
    );
    expect(result.audit.splitReplayed).toBe(true);
    expect(result.audit.rescheduleSkipped).toBe(false);
  });
});
