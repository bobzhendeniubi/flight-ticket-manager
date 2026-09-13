/**
 * OrderService.resyncFlightSeatsWithinTx · 换人 / 订正跨婴儿边界后机票行占座数与座位账重对账 · 服务级单测
 *（vitest，mock Prisma，不依赖真 DB）。
 *
 * 运营反馈：换人或改生日把成人改成婴儿（或反过来）时，机位数不会自动加减。
 * 收口：乘客类型跨过「婴儿 ↔ 占座乘客」边界时，同事务重算每条机票行的占座数 —— 成人改婴儿放座、
 * 婴儿改成人占座（余票不足硬拒、整事务回滚）、已起飞航段只重盖章不动账、没跨边界一个字都不写。
 *
 * 直接调用事务内方法 resyncFlightSeatsWithinTx（与 orders.status-seats.test.ts 直接调 _updateStatusWithinTx
 * 同一用法）：mock 只需覆盖它真正会碰的 tx.* 方法；换人 / 订正两条入口的接线用 spy 单独验证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, PassengerType, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    passenger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    fulfillmentTask: { updateMany: vi.fn() },
    auditLog: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { ConflictError } from '../../lib/errors.js';

const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const FUTURE = new Date('2036-10-01T02:00:00.000Z');
const PAST = new Date('2020-10-01T02:00:00.000Z');

const ADULT = { passengerType: PassengerType.ADULT };
const INFANT = { passengerType: PassengerType.INFANT };

type ResyncInput = {
  orderId: string;
  orderStatus: OrderStatus;
  reason: 'swap' | 'correct';
  passengerId: string;
  actor: { userId: string; role: UserRole };
};
type ResyncFn = (tx: unknown, input: ResyncInput) => Promise<{ rows: number; seatDelta: number } | null>;
/** writeAuditWithinTx → tx.auditLog.create 的入参形状（只声明断言会读的键）。 */
type AuditCreateArgs = {
  data: {
    action: string;
    targetType: string;
    targetId: string | null;
    severity: string;
    actorUserId: string | null;
    before: { rows: Array<Record<string, unknown>> };
    after: Record<string, unknown> & { rows: Array<Record<string, unknown>> };
  };
};

function callResync(tx: unknown, overrides: Partial<ResyncInput> = {}) {
  const service = new OrderService();
  const fn = (service as unknown as { resyncFlightSeatsWithinTx: ResyncFn }).resyncFlightSeatsWithinTx;
  return fn.call(service, tx, {
    orderId: 'ord-1',
    orderStatus: OrderStatus.PAID,
    reason: 'swap',
    passengerId: 'pax-1',
    actor: ADMIN,
    ...overrides,
  });
}

function flightRow(
  quantity: number,
  metadata: Record<string, unknown> | null,
  opts: { id?: string; departureTime?: Date; cabin?: 'ECONOMY' | 'BUSINESS' } = {},
) {
  return {
    id: opts.id ?? 'itm-go',
    description: 'QH9588 澳门→岘港 经济舱',
    quantity,
    flightScheduleId: 'sched-go',
    flightCabin: opts.cabin ?? 'ECONOMY',
    metadata,
    flightSchedule: { departureTime: opts.departureTime ?? FUTURE },
  };
}

/** 一个够 resyncFlightSeatsWithinTx 跑完的事务桩；$executeRaw 默认「CAS 命中 1 行」。 */
function mountTx(opts: {
  rows: ReturnType<typeof flightRow>[];
  passengers: Array<{ passengerType: PassengerType }>;
  casAffected?: number;
}) {
  const tx = {
    orderItem: {
      findMany: vi.fn(async () => opts.rows),
      update: vi.fn(async () => ({})),
    },
    passenger: { findMany: vi.fn(async () => opts.passengers) },
    seatLock: { aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })) },
    flightSeatClass: { findFirst: vi.fn(async () => ({ capacity: 10, sold: 10 })) },
    auditLog: { create: vi.fn(async (_args: AuditCreateArgs) => ({})) },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => opts.casAffected ?? 1),
  };
  return tx;
}

/** 把 $executeRaw 的 tagged-template 调用还原成「SQL 文本 + 占位值」。 */
function sqlCalls(tx: { $executeRaw: ReturnType<typeof vi.fn> }) {
  return tx.$executeRaw.mock.calls.map((call) => ({
    sql: (call[0] as ReadonlyArray<string>).join('?'),
    values: call.slice(1) as unknown[],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
describe('resyncFlightSeatsWithinTx · 座位账', () => {
  it('成人改婴儿：占座 2 → 1，放 1 座（GREATEST 下限版）、重盖章、落 FLIGHT_SEAT_RESYNC 审计', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 2, infantCount: 0 })],
      passengers: [ADULT, INFANT],
    });

    const result = await callResync(tx);

    expect(result).toEqual({ rows: 1, seatDelta: -1 });
    const calls = sqlCalls(tx);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('GREATEST(0, sold -');
    expect(calls[0].values.slice(0, 3)).toEqual([1, 'sched-go', 'ECONOMY']);
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'itm-go' },
      data: { metadata: { seatQuantity: 1, infantCount: 1 } },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: 'FLIGHT_SEAT_RESYNC',
      targetType: 'ORDER',
      targetId: 'ord-1',
      severity: 'INFO',
      actorUserId: 'admin-1',
    });
    expect(audit.after).toMatchObject({
      reason: 'swap',
      passengerId: 'pax-1',
      infantCount: 1,
      nonInfantPax: 1,
      seatDelta: -1,
    });
    expect(audit.after.rows[0]).toMatchObject({
      itemId: 'itm-go',
      oldSeatQuantity: 2,
      newSeatQuantity: 1,
      delta: -1,
      soldApplied: true,
      departed: false,
    });
  });

  it('婴儿改成人：占座 1 → 2，走 CAS 占 1 座（含他人锁位 / 占位余座口径）并重盖章', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      passengers: [ADULT, ADULT],
    });

    const result = await callResync(tx, { reason: 'correct' });

    expect(result).toEqual({ rows: 1, seatDelta: 1 });
    const calls = sqlCalls(tx);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('sold = sold +');
    expect(calls[0].sql).toContain('<= capacity');
    expect(calls[0].values.slice(0, 3)).toEqual([1, 'sched-go', 'ECONOMY']);
    // 占座前对舱位行 FOR UPDATE（与 takeSeatWithinTx 同款）。
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'itm-go' },
      data: { metadata: { seatQuantity: 2, infantCount: 0 } },
    });
    expect(tx.auditLog.create.mock.calls[0][0].data.after).toMatchObject({
      reason: 'correct',
      seatDelta: 1,
    });
  });

  it('婴儿改成人但班次售罄 → 409 硬拒（文案指路改期 / 改单申请），不盖章、不写审计（整事务回滚）', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      passengers: [ADULT, ADULT],
      casAffected: 0,
    });

    const err = await callResync(tx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe(
      '出行人改为成人/儿童后需再占 1 个机位，该班次（QH9588 澳门→岘港 经济舱 · 经济舱）已售罄，请先改期或提交改单申请',
    );
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('代理与运营同一口径：代理触发售罄同样硬拒，没有超售开关', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      passengers: [ADULT, ADULT],
      casAffected: 0,
    });

    await expect(
      callResync(tx, { actor: { userId: 'agent-user', role: UserRole.AGENT } }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('已起飞航段：只重盖章不动 sold，审计升为 WARNING 且标 soldApplied=false', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 2, infantCount: 0 }, { departureTime: PAST })],
      passengers: [ADULT, INFANT],
    });

    const result = await callResync(tx);

    expect(result).toEqual({ rows: 1, seatDelta: 0 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'itm-go' },
      data: { metadata: { seatQuantity: 1, infantCount: 1 } },
    });
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.severity).toBe('WARNING');
    expect(audit.after.rows[0]).toMatchObject({ delta: -1, soldApplied: false, departed: true });
  });

  it('非占座态订单（已取消）：座位本就不在账上 → 只盖章不动 sold', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 2, infantCount: 0 })],
      passengers: [ADULT, INFANT],
    });

    await callResync(tx, { orderStatus: OrderStatus.CANCELLED });

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
  });

  it('盖章已是最新（没跨边界的重复调用）→ 不写库、不写审计，返回 null', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      passengers: [ADULT, INFANT],
    });

    const result = await callResync(tx);

    expect(result).toBeNull();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('套餐升舱拆座镜像：经济舱行 3 座（升舱 1）成人改婴儿 → 只放经济舱 1 座，商务舱不动', async () => {
    const tx = mountTx({
      rows: [flightRow(3, { seatQuantity: 3, infantCount: 0, businessUpgradeCount: 1 })],
      passengers: [ADULT, ADULT, INFANT],
    });

    await callResync(tx);

    const calls = sqlCalls(tx);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('GREATEST(0, sold -');
    expect(calls[0].values.slice(0, 3)).toEqual([1, 'sched-go', 'ECONOMY']);
  });

  it('套餐机票腿 quantity=seatPax：婴儿改成人加不上座 → 只重盖 infantCount，审计 WARNING 标 seatCappedByQuantity', async () => {
    const tx = mountTx({
      rows: [flightRow(2, { seatQuantity: 2, infantCount: 1 })],
      passengers: [ADULT, ADULT, ADULT],
    });

    const result = await callResync(tx);

    expect(result).toEqual({ rows: 1, seatDelta: 0 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.severity).toBe('WARNING');
    expect(audit.after.rows[0]).toMatchObject({ seatCappedByQuantity: true, delta: 0 });
  });

  it('去程 + 回程两条行各自放座；老行没盖过章按 quantity 起算', async () => {
    const tx = mountTx({
      rows: [flightRow(2, null, { id: 'go' }), flightRow(2, null, { id: 'back' })],
      passengers: [ADULT, INFANT],
    });

    const result = await callResync(tx);

    expect(result).toEqual({ rows: 2, seatDelta: -2 });
    expect(sqlCalls(tx).map((c) => c.values[0])).toEqual([1, 1]);
    expect(tx.orderItem.update).toHaveBeenCalledTimes(2);
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    // 老行 seatQuantity 缺省 → before 里 seatQuantity=null、seatEffective=quantity。
    expect(audit.before.rows[0]).toMatchObject({ itemId: 'go', seatQuantity: null, seatEffective: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('接线 · swapPassenger / correctPassenger 只在跨婴儿边界时调重对账', () => {
  function spyResync(service: OrderService) {
    return vi
      .spyOn(service as unknown as { resyncFlightSeatsWithinTx: ResyncFn }, 'resyncFlightSeatsWithinTx')
      .mockResolvedValue(null);
  }

  function mountSwapTx(passengerType: PassengerType) {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'ord-1',
          adjustmentCny: 0,
          adjustments: null,
          status: 'PAID',
          deletedAt: null,
          visaStatus: null,
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
          settlementLocked: false,
        },
      ]),
      passenger: {
        findUnique: vi.fn(async () => ({
          id: 'pax-1',
          orderId: 'ord-1',
          fullName: 'ZHANG/SAN',
          documentNumber: 'E11111111',
          visaExempt: false,
          passengerType,
          pnr: null,
          eticketNumber: null,
          chineseName: null,
          dateOfBirth: null,
          passportExpiry: null,
          formerIdentities: null,
        })),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({ id: 'pax-1' })),
        findUniqueOrThrow: vi.fn(async () => ({ fullName: 'ZHANG/SAN', documentNumber: 'E11111111' })),
      },
      orderItem: { findMany: vi.fn(async () => []), update: vi.fn(), count: vi.fn(async () => 0) },
      order: { findUnique: vi.fn(async () => null), update: vi.fn() },
      fulfillmentTask: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
    return tx;
  }

  it('换人把成人改成婴儿（显式新类型）→ 事务内调重对账，reason=swap', async () => {
    const service = new OrderService();
    const resync = spyResync(service);
    const tx = mountSwapTx(PassengerType.ADULT);

    // 事务提交后的整单序列化不在本测试关心范围（mock 没铺全量 include），吞掉即可；
    // 接线断言看 spy —— 它在事务内、passenger.update 之后就该被调到。
    await service
      .swapPassenger('ord-1', 'pax-1', { passengerType: PassengerType.INFANT }, ADMIN)
      .catch(() => undefined);

    expect(tx.passenger.update).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0][1]).toMatchObject({
      orderId: 'ord-1',
      orderStatus: 'PAID',
      reason: 'swap',
      passengerId: 'pax-1',
      actor: { userId: 'admin-1', role: UserRole.ADMIN },
    });
  });

  it('真换人（证件号变）且旧人是婴儿、新人默认成人 → 同样跨边界，调重对账', async () => {
    const service = new OrderService();
    const resync = spyResync(service);
    mountSwapTx(PassengerType.INFANT);

    await service
      .swapPassenger(
        'ord-1',
        'pax-1',
        { fullName: 'LI/SI', documentNumber: 'E22222222', passportExpiry: '2031-01-01' },
        ADMIN,
      )
      .catch(() => undefined);

    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0][1]).toMatchObject({ reason: 'swap' });
  });

  it('换人只改名字 / 成人改儿童 → 没跨边界，不调重对账（一个字都不写）', async () => {
    const service = new OrderService();
    const resync = spyResync(service);
    const tx = mountSwapTx(PassengerType.ADULT);

    await service
      .swapPassenger('ord-1', 'pax-1', { fullName: 'ZHANG/SAM' }, ADMIN)
      .catch(() => undefined);
    await service
      .swapPassenger('ord-1', 'pax-1', { passengerType: PassengerType.CHILD }, ADMIN)
      .catch(() => undefined);

    expect(tx.passenger.update).toHaveBeenCalledTimes(2);
    expect(resync).not.toHaveBeenCalled();
  });

  function mountCorrectTx(opts: { passengerType: PassengerType; departureTime?: Date }) {
    const passenger = {
      id: 'pax-1',
      orderId: 'ord-1',
      fullName: 'ZHANG/SAN',
      lastName: 'ZHANG',
      firstName: 'SAN',
      chineseName: null,
      documentNumber: 'E11111111',
      dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      gender: null,
      nationality: 'CN',
      passengerType: opts.passengerType,
      passportExpiry: null,
      passportIssueDate: null,
      formerIdentities: null,
      pnr: null,
      eticketNumber: null,
    };
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'ord-1',
          orderNumber: 'FTM1',
          userId: null,
          agentId: null,
          status: 'PAID',
          deletedAt: null,
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
        },
      ]),
      passenger: {
        findUnique: vi.fn(async () => passenger),
        findFirst: vi.fn(async () => null),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...passenger, ...args.data })),
      },
      // 出行人类型权威重派生要读本单最早出发日（同一批 FLIGHT 行）。
      orderItem: {
        findMany: vi.fn(async () => [
          { flightSchedule: { departureTime: opts.departureTime ?? FUTURE, departureTz: 'Asia/Macau' } },
        ]),
        update: vi.fn(),
      },
      auditLog: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
    return tx;
  }

  it('订正生日把成人改成婴儿（按出发日派生 INFANT）→ 事务内调重对账，reason=correct', async () => {
    const service = new OrderService();
    const resync = spyResync(service);
    const tx = mountCorrectTx({ passengerType: PassengerType.ADULT });

    // 出发日 2036-10-01，出生 2036-01-01 → 出发时 0 岁 → INFANT。
    await service
      .correctPassenger('ord-1', 'pax-1', { dateOfBirth: '2036-01-01' }, ADMIN)
      .catch(() => undefined);

    expect(tx.passenger.update).toHaveBeenCalledTimes(1);
    expect(tx.passenger.update.mock.calls[0][0].data).toMatchObject({ passengerType: 'INFANT' });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0][1]).toMatchObject({
      orderId: 'ord-1',
      orderStatus: 'PAID',
      reason: 'correct',
      passengerId: 'pax-1',
      actor: { userId: 'admin-1', role: UserRole.ADMIN },
    });
  });

  it('订正生日婴儿改成人（出发时已 5 岁 → CHILD，儿童占座）→ 跨边界，调重对账', async () => {
    const service = new OrderService();
    const resync = spyResync(service);
    mountCorrectTx({ passengerType: PassengerType.INFANT });

    await service
      .correctPassenger('ord-1', 'pax-1', { dateOfBirth: '2031-01-01' }, ADMIN)
      .catch(() => undefined);

    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0][1]).toMatchObject({ reason: 'correct' });
  });

  it('订正只改拼音名 / 改生日仍是成人 → 没跨边界，不调重对账', async () => {
    const service = new OrderService();
    const resync = spyResync(service);
    const tx = mountCorrectTx({ passengerType: PassengerType.ADULT });

    await service
      .correctPassenger('ord-1', 'pax-1', { fullName: 'ZHANG/SAM' }, ADMIN)
      .catch(() => undefined);
    await service
      .correctPassenger('ord-1', 'pax-1', { dateOfBirth: '1991-01-01' }, ADMIN)
      .catch(() => undefined);

    expect(tx.passenger.update).toHaveBeenCalledTimes(2);
    expect(resync).not.toHaveBeenCalled();
  });
});
