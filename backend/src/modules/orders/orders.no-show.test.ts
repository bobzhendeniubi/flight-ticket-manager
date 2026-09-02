/**
 * 去程 no-show + 回程释放 / 恢复 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 业务原样（航司每天发 no-show 名单，票务照单处理）：
 *   去程标 no-show —— 钱不动不退、成本不动；回程座位释放回库存继续卖 —— 钱同样不动；
 *   代理来说要保留 —— 恢复回原班次，有座直接占、没座允许超售。
 *
 * 覆盖：
 *   1. 权限：仅 ADMIN/STAFF。
 *   2. 预检各 blocker（未起飞 / 回收站 / 无去程 / 重复标记）与各 warning（已出票 / 已开票 / 单程单）。
 *   3. 整单执行：金额四字段与 subtotal/total 一个都没写、放座张数正确、未出票任务终态化、
 *      未出票不派工单、hasReturnLeg 同步、adjustments 双条留痕。
 *   4. 已出票的回程释放 → 出票任务不动 + 派「撤名单/退票」工单。
 *   5. 幂等回放：同 requestToken 重试不二次放座、不二次派工单。
 *   6. 恢复回程：有座直接占 / 没座未确认回 409 / 确认后超售直加 / 超出上限被闸挡。
 *   7. 取消航段闸 8 修复：本段已出票从 blocker 变 warning，未带确认回执 → 400。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    fulfillmentTask: { count: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    operationalReminder: { findUnique: vi.fn(), create: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    flightSeatClass: { findFirst: vi.fn() },
    seatLock: { aggregate: vi.fn() },
    refund: { count: vi.fn() },
    cancellationPolicy: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { noShowBodySchema, restoreReturnLegBodySchema } from './orders.schemas.js';
import { AppError, BadRequestError, ForbiddenError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT } as const;
const TOKEN = '00000000-0000-4000-8000-00000000n0s1'.replace('n0s', 'a0b');
const TOKEN2 = '00000000-0000-4000-8000-0000000ab0c2';

// 去程已飞（3 天前），回程还没飞（7 天后）—— no-show 的正常时间关系。
const OUT_DEPART = new Date(Date.now() - 3 * 24 * 3600_000);
const RET_DEPART = new Date(Date.now() + 7 * 24 * 3600_000);

const OUT_AMOUNT = 3000;
const RET_AMOUNT = 3000;
const HOTEL_AMOUNT = 2000;
const TOTAL = OUT_AMOUNT + RET_AMOUNT + HOTEL_AMOUNT;

function outboundRow(over: Record<string, unknown> = {}) {
  return {
    id: 'leg-out',
    kind: OrderItemKind.FLIGHT,
    description: '机票 QH9589 经济舱 × 2',
    quantity: 2,
    amount: new Prisma.Decimal(OUT_AMOUNT),
    flightCabin: 'ECONOMY',
    flightScheduleId: 'sch-out',
    metadata: null as unknown,
    flightSchedule: {
      departureTime: OUT_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9589' },
    },
    ...over,
  };
}

function returnRow(over: Record<string, unknown> = {}) {
  return {
    id: 'leg-ret',
    kind: OrderItemKind.FLIGHT,
    description: '机票 QH9588 经济舱 × 2',
    quantity: 2,
    amount: new Prisma.Decimal(RET_AMOUNT),
    flightCabin: 'ECONOMY',
    flightScheduleId: 'sch-ret',
    metadata: null as unknown,
    flightSchedule: {
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    },
    ...over,
  };
}

const hotelRow = {
  id: 'hotel-1',
  kind: OrderItemKind.HOTEL,
  description: '酒店 2 晚',
  quantity: 2,
  amount: new Prisma.Decimal(HOTEL_AMOUNT),
  flightCabin: null,
  flightScheduleId: null,
  metadata: null as unknown,
  flightSchedule: null,
};

/** loadOrderForLegCancel 的 select 形状（no-show / 恢复共用同一份快照）。 */
function orderSnapshot(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    orderNumber: 'FTM20260902-001',
    status: 'TICKETED',
    deletedAt: null,
    subtotal: new Prisma.Decimal(TOTAL),
    total: new Prisma.Decimal(TOTAL),
    paidAmount: new Prisma.Decimal(TOTAL),
    adjustmentCny: 0,
    adjustments: [],
    outboundInvoiced: false,
    returnInvoiced: false,
    systemInvoiced: false,
    settlementLocked: false,
    paymentsLocked: false,
    items: [outboundRow(), returnRow(), hotelRow],
    passengers: [
      { id: 'pax-1', fullName: 'ZHANG SAN', chineseName: '张三', pnr: null, eticketNumber: null },
      { id: 'pax-2', fullName: 'LI SI', chineseName: '李四', pnr: null, eticketNumber: null },
    ],
    ...over,
  };
}

/** 回读序列化用的最小订单。 */
const serializableOrder = () => ({
  id: 'ord-1',
  orderNumber: 'FTM20260902-001',
  status: 'TICKETED',
  subtotal: new Prisma.Decimal(TOTAL),
  taxesAndFees: new Prisma.Decimal(0),
  discountTotal: new Prisma.Decimal(0),
  total: new Prisma.Decimal(TOTAL),
  paidAmount: new Prisma.Decimal(TOTAL),
  prepaymentOffset: new Prisma.Decimal(0),
  adjustmentCny: 0,
  items: [],
  passengers: [],
  payments: [],
});

/** 预检走裸 prisma（非事务）。 */
function mountPreview(snapshot = orderSnapshot(), ticketedReturn = 0) {
  mockPrisma.order.findUnique.mockResolvedValue(snapshot);
  mockPrisma.fulfillmentTask.count.mockResolvedValue(ticketedReturn);
}

/**
 * 事务客户端 mock。orderItem.findMany 按 where 分流：
 *   带 flightScheduleId 条件 = syncOrderHasReturnLeg 的自愈查询；
 *   不带 = 幂等回放扫描（全部 FLIGHT 行 + metadata）。
 */
function mountTx(
  opts: {
    snapshot?: ReturnType<typeof orderSnapshot>;
    flightMeta?: Array<{ id: string; metadata: unknown }>;
    ticketedReturn?: number;
    /** 恢复用：原班次 + 该舱余位 */
    schedule?: { id: string; departureTime: Date } | null;
    seatClass?: { capacity: number; sold: number } | null;
  } = {},
) {
  const snapshot = opts.snapshot ?? orderSnapshot();
  const flightMeta =
    opts.flightMeta ??
    [
      { id: 'leg-out', metadata: null },
      { id: 'leg-ret', metadata: null },
    ];
  const survivors = snapshot.items
    .filter((it) => it.kind === OrderItemKind.FLIGHT && it.flightScheduleId != null)
    .map((it) => ({
      flightScheduleId: it.flightScheduleId,
      flightSchedule: it.flightSchedule,
    }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'ord-1' }]),
    $executeRaw: vi.fn(async () => 1),
    order: {
      findUnique: vi.fn(async () => snapshot),
      findUniqueOrThrow: vi.fn(async () => ({ orderNumber: snapshot.orderNumber })),
      update: vi.fn(async () => ({})),
    },
    orderItem: {
      findMany: vi.fn(async (args: { where?: { flightScheduleId?: unknown } }) =>
        args?.where?.flightScheduleId !== undefined ? survivors : flightMeta,
      ),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 'new-item' })),
    },
    fulfillmentTask: {
      count: vi.fn(async () => opts.ticketedReturn ?? 0),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: 'task-1' })),
    },
    operationalReminder: {
      findUnique: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async () => ({ id: 'wo-1' })),
    },
    flightSchedule: {
      findUnique: vi.fn(async () =>
        opts.schedule === undefined
          ? { id: 'sch-ret', departureTime: RET_DEPART }
          : opts.schedule,
      ),
    },
    flightSeatClass: {
      findFirst: vi.fn(async () =>
        opts.seatClass === undefined ? { capacity: 180, sold: 100 } : opts.seatClass,
      ),
    },
    seatLock: { aggregate: vi.fn(async () => ({ _sum: { qty: 0 } })) },
    refund: { count: vi.fn(async () => 0) },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(serializableOrder());
  // markNoShow 的「先看要不要拆单」头查询走裸 prisma。
  mockPrisma.order.findUnique.mockResolvedValue({
    id: 'ord-1',
    orderNumber: snapshot.orderNumber,
    passengers: snapshot.passengers.map((p) => ({ id: p.id })),
  });
  return tx;
}

const noShowBody = (over: Record<string, unknown> = {}) =>
  noShowBodySchema.parse({ requestToken: TOKEN, ...over });
const restoreBody = (over: Record<string, unknown> = {}) =>
  restoreReturnLegBodySchema.parse({ requestToken: TOKEN, ...over });

/** 从一串 orderItem.update 调用里取某一行的 data。 */
function updateDataFor(
  calls: Array<[{ where: { id: string }; data: Record<string, unknown> }]>,
  id: string,
): Record<string, unknown> | undefined {
  return calls.find((c) => c[0].where.id === id)?.[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// 1. 权限
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 权限', () => {
  it('代理不能预检（且不触库）', async () => {
    await expect(service.previewNoShow('ord-1', {}, AGENT)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('代理不能执行（且不开事务）', async () => {
    await expect(service.markNoShow('ord-1', noShowBody(), AGENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('代理不能恢复回程（且不开事务）', async () => {
    await expect(
      service.restoreReturnLeg('ord-1', restoreBody(), AGENT),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('运营（STAFF）可以预检', async () => {
    mountPreview();
    const res = await service.previewNoShow('ord-1', {}, STAFF);
    expect(res.eligible).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 预检 · 各 blocker / warning
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 预检', () => {
  it('整单可标记：去程/回程都回、乘客名单齐、scope=WHOLE', async () => {
    mountPreview();
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(true);
    expect(res.scope).toBe('WHOLE');
    expect(res.outboundItem).toMatchObject({ orderItemId: 'leg-out', flightNumber: 'QH9589' });
    expect(res.returnItem).toMatchObject({ orderItemId: 'leg-ret', ticketed: false });
    expect(res.passengers).toEqual([
      { id: 'pax-1', fullName: 'ZHANG SAN', chineseName: '张三' },
      { id: 'pax-2', fullName: 'LI SI', chineseName: '李四' },
    ]);
    expect(res.alreadyNoShow).toBe(false);
  });

  it('去程还没起飞 → 拒绝（没飞怎么算没来）', async () => {
    const future = new Date(Date.now() + 2 * 24 * 3600_000);
    mountPreview(
      orderSnapshot({
        items: [
          outboundRow({
            flightSchedule: {
              departureTime: future,
              departureTz: 'Asia/Shanghai',
              flight: { flightNumber: 'QH9589' },
            },
          }),
          returnRow(),
          hotelRow,
        ],
      }),
    );
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('尚未起飞');
  });

  it('回收站单 → 拒绝', async () => {
    mountPreview(orderSnapshot({ deletedAt: new Date() }));
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.blockers.join('')).toContain('回收站');
  });

  it('非占座态（已取消）→ 拒绝', async () => {
    mountPreview(orderSnapshot({ status: 'CANCELLED' }));
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.blockers.join('')).toContain('不能标记 no-show');
  });

  it('去程班次已被置空（无有效去程航段）→ 拒绝', async () => {
    mountPreview(
      orderSnapshot({ items: [outboundRow({ flightScheduleId: null }), returnRow(), hotelRow] }),
    );
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    // 只剩一段有效航段 → 那一段被判成去程（回程行），但它还没起飞 → 仍然拒绝。
    expect(res.eligible).toBe(false);
  });

  it('去程已标记过 no-show → 拒绝重复标记', async () => {
    mountPreview(
      orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: new Date().toISOString() } } }),
          returnRow(),
          hotelRow,
        ],
      }),
    );
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.alreadyNoShow).toBe(true);
    expect(res.blockers.join('')).toContain('已标记 no-show');
  });

  it('单程单 → 可标记，提示没有座位可释放', async () => {
    mountPreview(orderSnapshot({ items: [outboundRow(), hotelRow] }));
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(true);
    expect(res.returnItem).toBeNull();
    expect(res.warnings.join('')).toContain('没有回程航段');
  });

  it('回程已出票 / 已开票 → 只是提示，不阻断', async () => {
    mountPreview(orderSnapshot({ returnInvoiced: true }), 2);
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(true);
    expect(res.returnItem?.ticketed).toBe(true);
    expect(res.warnings.join('')).toContain('回程已出票（2 人有确认出票记录）');
    expect(res.warnings.join('')).toContain('不动钱也不动开票状态');
  });

  it('只勾部分乘客 → scope=SPLIT_REQUIRED，拆单的闸并进 blockers', async () => {
    mountPreview();
    const spy = vi
      .spyOn(service as unknown as { assessOrderSplitForNoShow: () => Promise<string[]> },
        'assessOrderSplitForNoShow')
      .mockResolvedValue(['套餐订单暂不支持拆单：请改用按人办签证 / 拆房组等既有售后操作。']);
    const res = await service.previewNoShow('ord-1', { passengerIds: ['pax-1'] }, ADMIN);
    expect(res.scope).toBe('SPLIT_REQUIRED');
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('套餐订单暂不支持拆单');
    expect(res.warnings.join('')).toContain('1/2 位乘客');
    spy.mockRestore();
  });

  it('勾了不属于本单的乘客 → 拒绝', async () => {
    mountPreview();
    const res = await service.previewNoShow('ord-1', { passengerIds: ['pax-x'] }, ADMIN);
    expect(res.blockers.join('')).toContain('不属于本订单');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. 整单执行 —— 钱一分不动、座位如实放回
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 整单执行', () => {
  it('去程打标 + 回程放座，金额四字段与 subtotal/total 一个都没写', async () => {
    const tx = mountTx();
    const res = await service.markNoShow('ord-1', noShowBody({ note: '航司名单 9/2' }), ADMIN);

    expect(res.targetOrderId).toBe('ord-1');
    expect(res.audit.outboundItemId).toBe('leg-out');
    expect(res.audit.returnItemId).toBe('leg-ret');
    expect(res.audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    expect(res.audit.split).toBeNull();
    expect(res.audit.replayed).toBe(false);

    // 商品行只写了描述前缀与 metadata（回程另加 flightScheduleId=null）——金额/成本一个没碰。
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const moneyKeys = ['amount', 'unitPrice', 'unitCostCny', 'totalCostCny', 'quantity'];
    for (const [arg] of calls) {
      for (const k of moneyKeys) expect(arg.data).not.toHaveProperty(k);
    }
    expect(Object.keys(updateDataFor(calls, 'leg-out') ?? {}).sort()).toEqual([
      'description',
      'metadata',
    ]);
    expect(Object.keys(updateDataFor(calls, 'leg-ret') ?? {}).sort()).toEqual([
      'description',
      'flightScheduleId',
      'metadata',
    ]);

    // 订单级只写了 hasReturnLeg（物化列自愈）与 adjustments（留痕）。
    const orderKeys = (tx.order.update.mock.calls as unknown as Array<[{ data: object }]>).flatMap(
      ([a]) => Object.keys(a.data),
    );
    expect(new Set(orderKeys)).toEqual(new Set(['hasReturnLeg', 'adjustments']));
  });

  it('去程行留下 noShow 快照与前缀，班次**不置空**（这段是真飞了的）', async () => {
    const tx = mountTx();
    await service.markNoShow('ord-1', noShowBody({ note: '客人没来' }), ADMIN);
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const out = updateDataFor(calls, 'leg-out')!;
    expect(out.description).toBe('[去程 no-show] 机票 QH9589 经济舱 × 2');
    expect(out).not.toHaveProperty('flightScheduleId');
    const snap = (out.metadata as { noShow: Record<string, unknown> }).noShow;
    expect(snap).toMatchObject({
      byUserId: 'admin-1',
      requestToken: TOKEN,
      leg: 'OUTBOUND',
      source: 'MANUAL',
      note: '客人没来',
      returnItemId: 'leg-ret',
      returnReleased: true,
    });
    expect(snap.passengerIds).toEqual(['pax-1', 'pax-2']);
    expect(typeof snap.listDate).toBe('string');
  });

  it('回程行留下 returnReleased 快照（含原班次/原舱位/放座明细），供恢复照单回填', async () => {
    const tx = mountTx();
    await service.markNoShow('ord-1', noShowBody(), ADMIN);
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const ret = updateDataFor(calls, 'leg-ret')!;
    expect(ret.description).toBe('[回程已释放] 机票 QH9588 经济舱 × 2');
    expect(ret.flightScheduleId).toBeNull();
    const snap = (ret.metadata as { returnReleased: Record<string, unknown> }).returnReleased;
    expect(snap).toMatchObject({
      reason: 'NO_SHOW_OUTBOUND',
      originalScheduleId: 'sch-ret',
      originalCabin: 'ECONOMY',
      ticketedAtRelease: 0,
      workOrderReminderId: null,
    });
    expect(snap.releasedSeats).toEqual([{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }]);
  });

  it('升舱拆座镜像：商务/经济各退各舱，两条明细都进快照', async () => {
    const tx = mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow(),
          returnRow({ quantity: 3, metadata: { businessUpgradeCount: 1 } }),
          hotelRow,
        ],
      }),
    });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(res.audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'BUSINESS', quantity: 1 },
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('未出票的回程出票任务终态化，且不派工单', async () => {
    const tx = mountTx({ ticketedReturn: 0 });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(tx.fulfillmentTask.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
    expect(res.audit.workOrderReminderId).toBeNull();
  });

  it('releaseReturn=false → 只打去程标，一座不放、回程行不动', async () => {
    const tx = mountTx();
    const res = await service.markNoShow('ord-1', noShowBody({ releaseReturn: false }), ADMIN);
    expect(res.audit.returnItemId).toBeNull();
    expect(res.audit.releasedSeats).toEqual([]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    const calls = tx.orderItem.update.mock.calls as unknown as Array<[{ where: { id: string } }]>;
    expect(calls.map(([a]) => a.where.id)).toEqual(['leg-out']);
  });

  it('单程单：只打去程标，没有座位可放', async () => {
    const tx = mountTx({
      snapshot: orderSnapshot({ items: [outboundRow(), hotelRow] }),
      flightMeta: [{ id: 'leg-out', metadata: null }],
    });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(res.audit.returnItemId).toBeNull();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('去程未起飞 → 执行被拒且不放座（预检放行到执行之间的闸重跑）', async () => {
    const tx = mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow({
            flightSchedule: {
              departureTime: new Date(Date.now() + 3600_000),
              departureTz: 'Asia/Shanghai',
              flight: { flightNumber: 'QH9589' },
            },
          }),
          returnRow(),
          hotelRow,
        ],
      }),
    });
    await expect(service.markNoShow('ord-1', noShowBody(), ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3b. 部分乘客 —— 先拆单再标记（票随人走）
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 部分乘客', () => {
  it('拆单被闸挡 → 409 SPLIT_BLOCKED（details 带人话闸），不进标记事务', async () => {
    mountTx();
    const preview = vi.spyOn(service, 'previewOrderSplit').mockResolvedValue({
      eligible: false,
      blockers: ['套餐订单暂不支持拆单：请改用按人办签证 / 拆房组等既有售后操作。'],
      warnings: [],
      shares: [],
      movedShareCny: 0,
      movedPaidCny: 0,
      hotelItems: [],
    });
    const err = await service
      .markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('SPLIT_BLOCKED');
    expect((err as AppError).details).toMatchObject({
      blockers: [expect.stringContaining('套餐订单暂不支持拆单')],
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    preview.mockRestore();
  });

  it('拆成了但标记失败 → 409 SPLIT_DONE_NOSHOW_FAILED，带新单 id（拆单不回滚）', async () => {
    mountTx({
      // 新单里的去程还没起飞 → 标记必然失败，用来构造「拆成了、标记没成」的中间态。
      snapshot: orderSnapshot({
        items: [
          outboundRow({
            flightSchedule: {
              departureTime: new Date(Date.now() + 3600_000),
              departureTz: 'Asia/Shanghai',
              flight: { flightNumber: 'QH9589' },
            },
          }),
          returnRow(),
          hotelRow,
        ],
      }),
    });
    const preview = vi.spyOn(service, 'previewOrderSplit').mockResolvedValue({
      eligible: true,
      blockers: [],
      warnings: [],
      shares: [],
      movedShareCny: 0,
      movedPaidCny: 0,
      hotelItems: [],
    });
    const split = vi.spyOn(service, 'splitOrder').mockResolvedValue({
      sourceOrderId: 'ord-1',
      sourceOrderNumber: 'FTM20260902-001',
      targetOrderId: 'ord-2',
      targetOrderNumber: 'FTM20260902-002',
      movedShareCny: 4000,
      movedPaidCny: 4000,
      passengerCount: 1,
      replayed: false,
    });

    const err = await service
      .markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('SPLIT_DONE_NOSHOW_FAILED');
    expect((err as AppError).details).toMatchObject({
      newOrderId: 'ord-2',
      newOrderNumber: 'FTM20260902-002',
    });
    preview.mockRestore();
    split.mockRestore();
  });

  it('拆单成功 → 对新单标记，audit.split 记两侧单号、targetOrderId 指新单', async () => {
    mountTx();
    const preview = vi.spyOn(service, 'previewOrderSplit').mockResolvedValue({
      eligible: true,
      blockers: [],
      warnings: [],
      shares: [],
      movedShareCny: 0,
      movedPaidCny: 0,
      hotelItems: [],
    });
    const split = vi.spyOn(service, 'splitOrder').mockResolvedValue({
      sourceOrderId: 'ord-1',
      sourceOrderNumber: 'FTM20260902-001',
      targetOrderId: 'ord-2',
      targetOrderNumber: 'FTM20260902-002',
      movedShareCny: 4000,
      movedPaidCny: 4000,
      passengerCount: 1,
      replayed: false,
    });

    const res = await service.markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN);
    expect(res.targetOrderId).toBe('ord-2');
    expect(res.audit.split).toEqual({
      sourceOrderNumber: 'FTM20260902-001',
      targetOrderNumber: 'FTM20260902-002',
    });
    expect(res.audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    preview.mockRestore();
    split.mockRestore();
  });

  it('勾了全员 → 不拆单，直接整单标记', async () => {
    mountTx();
    const split = vi.spyOn(service, 'splitOrder');
    const res = await service.markNoShow(
      'ord-1',
      noShowBody({ passengerIds: ['pax-1', 'pax-2'] }),
      ADMIN,
    );
    expect(split).not.toHaveBeenCalled();
    expect(res.targetOrderId).toBe('ord-1');
    expect(res.audit.split).toBeNull();
    split.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. 已出票的回程释放 → 派「撤名单/退票」工单
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 已出票的回程', () => {
  it('出票任务不动，另派 HIGH 工单，工单 id 进审计与快照', async () => {
    const tx = mountTx({ ticketedReturn: 2 });
    const res = await service.markNoShow('ord-1', noShowBody({ note: '代理确认不飞' }), ADMIN);

    expect(tx.fulfillmentTask.updateMany).not.toHaveBeenCalled();
    expect(tx.operationalReminder.create).toHaveBeenCalledTimes(1);
    const arg = (tx.operationalReminder.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(arg.data.ruleKey).toBe(`NOSHOW_WITHDRAW:leg-ret:${TOKEN}`);
    expect(arg.data.priority).toBe('HIGH');
    expect(arg.data.orderId).toBe('ord-1');
    expect(arg.data.createdById).toBe('admin-1');
    expect(arg.data.title).toBe('撤名单/退票：FTM20260902-001 · 回程 QH9588 ' +
      `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(RET_DEPART)} · 2 人`);
    expect(String(arg.data.body)).toContain('2 条确认出票记录');
    expect(res.audit.workOrderReminderId).toBe('wo-1');
  });

  it('同 ruleKey 的工单已存在 → 复用不重复建', async () => {
    const tx = mountTx({ ticketedReturn: 1 });
    tx.operationalReminder.findUnique.mockResolvedValue({ id: 'wo-existing' });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
    expect(res.audit.workOrderReminderId).toBe('wo-existing');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. 幂等回放
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 幂等', () => {
  it('同 requestToken 重试：回放既有结果，不二次放座、不二次派工单', async () => {
    const tx = mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            noShow: {
              requestToken: TOKEN,
              returnItemId: 'leg-ret',
              releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
              workOrderReminderId: 'wo-1',
            },
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(res.audit.replayed).toBe(true);
    expect(res.audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    expect(res.audit.workOrderReminderId).toBe('wo-1');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
  });

  it('不同 requestToken 不会命中回放（走正常闸，重复标记被拒）', async () => {
    const tx = mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: new Date().toISOString(), requestToken: TOKEN } } }),
          returnRow(),
          hotelRow,
        ],
      }),
      flightMeta: [
        { id: 'leg-out', metadata: { noShow: { at: 'x', requestToken: TOKEN } } },
        { id: 'leg-ret', metadata: null },
      ],
    });
    await expect(
      service.markNoShow('ord-1', noShowBody({ requestToken: TOKEN2 }), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. 恢复回程
// ══════════════════════════════════════════════════════════════════════════
const RELEASED_SNAPSHOT = {
  at: new Date().toISOString(),
  byUserId: 'admin-1',
  requestToken: TOKEN,
  reason: 'NO_SHOW_OUTBOUND',
  originalScheduleId: 'sch-ret',
  originalCabin: 'ECONOMY',
  releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
  ticketedAtRelease: 0,
  workOrderReminderId: null,
};

function releasedSnapshotOrder(over: Record<string, unknown> = {}, snapOver: Record<string, unknown> = {}) {
  return orderSnapshot({
    items: [
      outboundRow({ metadata: { noShow: { at: RELEASED_SNAPSHOT.at } } }),
      returnRow({
        description: '[回程已释放] 机票 QH9588 经济舱 × 2',
        flightScheduleId: null,
        flightSchedule: null,
        metadata: { returnReleased: { ...RELEASED_SNAPSHOT, ...snapOver } },
      }),
      hotelRow,
    ],
    ...over,
  });
}

describe('恢复回程 · 预检', () => {
  it('有座：needsOversell=false，余位与原班次如实回', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 100 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(true);
    expect(res.available).toBe(80);
    expect(res.needsOversell).toBe(false);
    expect(res.oversellBy).toBe(0);
    expect(res.departed).toBe(false);
    expect(res.original).toMatchObject({
      orderItemId: 'leg-ret',
      scheduleId: 'sch-ret',
      flightNumber: 'QH9588',
      quantity: 2,
    });
  });

  it('售罄：needsOversell=true、余位可为负、限额内仍 eligible', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 181 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.available).toBe(-1);
    expect(res.needsOversell).toBe(true);
    expect(res.oversellBy).toBe(3);
    expect(res.maxOversell).toBe(5);
    expect(res.eligible).toBe(true);
  });

  it('缺口超上限 → blocker', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 190 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.oversellBy).toBe(12);
    expect(res.blockers.join('')).toContain('超售将超过上限 5 座');
  });

  it('原班次已起飞 → blocker + departed=true', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: new Date(Date.now() - 3600_000),
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.departed).toBe(true);
    expect(res.blockers.join('')).toContain('原班次已起飞');
  });

  it('没有被释放过的回程 → blocker', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderSnapshot());
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('没有被 no-show 释放的回程航段');
    expect(res.original).toBeNull();
  });

  it('已被起飞后作废（returnVoidedFinal）→ blocker', async () => {
    const snap = releasedSnapshotOrder();
    (snap.items[1] as { metadata: Record<string, unknown> }).metadata = {
      returnReleased: RELEASED_SNAPSHOT,
      returnVoidedFinal: { at: new Date().toISOString() },
    };
    mockPrisma.order.findUnique.mockResolvedValue(snap);
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.blockers.join('')).toContain('过期作废');
  });
});

describe('恢复回程 · 执行', () => {
  it('有座：CAS 占座、班次写回、释放前缀去掉、returnReleased 历史保留', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: null },
      ],
      seatClass: { capacity: 180, sold: 100 },
    });
    const { audit } = await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);

    expect(audit).toMatchObject({
      returnItemId: 'leg-ret',
      scheduleId: 'sch-ret',
      cabin: 'ECONOMY',
      quantity: 2,
      oversold: false,
      oversoldBy: 0,
      replayed: false,
    });
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const data = updateDataFor(calls, 'leg-ret')!;
    expect(data.flightScheduleId).toBe('sch-ret');
    expect(data.description).toBe('机票 QH9588 经济舱 × 2');
    const meta = data.metadata as Record<string, unknown>;
    expect(meta.returnReleased).toBeTruthy();
    expect(meta.returnRestored).toMatchObject({ toScheduleId: 'sch-ret', seats: 2, oversold: false });
    // 金额四字段一个没写。
    for (const k of ['amount', 'unitPrice', 'unitCostCny', 'totalCostCny']) {
      expect(data).not.toHaveProperty(k);
    }
  });

  it('没座且未确认 → 409 OVERSELL_CONFIRMATION_REQUIRED，一座不动', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      seatClass: { capacity: 180, sold: 181 },
    });
    const err = await service
      .restoreReturnLeg('ord-1', restoreBody(), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('OVERSELL_CONFIRMATION_REQUIRED');
    expect((err as AppError).details).toEqual({ available: -1, oversellBy: 3 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('确认超售 → 直加 sold（不带余位条件），审计标 oversold', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      seatClass: { capacity: 180, sold: 181 },
    });
    const { audit } = await service.restoreReturnLeg(
      'ord-1',
      restoreBody({ allowOversell: true }),
      ADMIN,
    );
    expect(audit.oversold).toBe(true);
    expect(audit.oversoldBy).toBe(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const meta = updateDataFor(calls, 'leg-ret')!.metadata as Record<string, unknown>;
    expect(meta.returnRestored).toMatchObject({ oversold: true, oversoldBy: 3 });
  });

  it('缺口超上限 → 即便确认也被拒，且一座不动', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      seatClass: { capacity: 180, sold: 190 },
    });
    await expect(
      service.restoreReturnLeg('ord-1', restoreBody({ allowOversell: true }), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('出票任务复活：被关掉的重开为 PENDING，不重复建', async () => {
    const tx = mountTx({ snapshot: releasedSnapshotOrder(), seatClass: { capacity: 180, sold: 0 } });
    await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);
    const arg = (tx.fulfillmentTask.updateMany.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(arg.data).toEqual({ status: 'PENDING', completedAt: null });
    expect(tx.fulfillmentTask.create).not.toHaveBeenCalled();
  });

  it('一条出票任务都没有 → 新建一条 PENDING', async () => {
    const tx = mountTx({ snapshot: releasedSnapshotOrder(), seatClass: { capacity: 180, sold: 0 } });
    tx.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
    tx.fulfillmentTask.count.mockResolvedValue(0);
    await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);
    expect(tx.fulfillmentTask.create).toHaveBeenCalledTimes(1);
  });

  it('释放时已出票 → 恢复时再派一条「重新上名单」工单', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder({}, { ticketedAtRelease: 2, workOrderReminderId: 'wo-1' }),
      seatClass: { capacity: 180, sold: 0 },
    });
    await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);
    expect(tx.operationalReminder.create).toHaveBeenCalledTimes(1);
    const arg = (tx.operationalReminder.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(arg.data.ruleKey).toBe(`NOSHOW_RELIST:leg-ret:${TOKEN}`);
    expect(String(arg.data.title)).toContain('重新上名单');
  });

  it('幂等回放：同 requestToken 重试不二次占座', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      flightMeta: [
        { id: 'leg-out', metadata: null },
        {
          id: 'leg-ret',
          metadata: {
            returnRestored: {
              requestToken: TOKEN,
              toScheduleId: 'sch-ret',
              cabin: 'ECONOMY',
              seats: 2,
              oversold: true,
              oversoldBy: 1,
            },
          },
        },
      ],
    });
    const { audit } = await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);
    expect(audit.replayed).toBe(true);
    expect(audit.oversold).toBe(true);
    expect(audit.oversoldBy).toBe(1);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. 取消航段闸 8 修复 —— 已出票从 blocker 变 warning + 二次确认 + 派工单
// ══════════════════════════════════════════════════════════════════════════
const FLIGHT_POLICY = {
  id: 'pol-flight',
  productKind: 'FLIGHT',
  scope: null,
  name: '机票默认取消政策',
  tiers: [
    { hoursBeforeDeparture: 72, feePercent: 20 },
    { hoursBeforeDeparture: -1, feePercent: 100 },
  ],
  isDefault: true,
  isActive: true,
};

/** 取消回程用的事务 mock（订单两段航段都还在，回程未起飞）。 */
function mountCancelTx(ticketed: number) {
  const snapshot = orderSnapshot({
    items: [
      outboundRow({
        flightSchedule: {
          // 取消回程的场景：去程比回程早（+5 天 < 回程 +7 天），航段方向才判得对。
          departureTime: new Date(Date.now() + 5 * 24 * 3600_000),
          departureTz: 'Asia/Shanghai',
          flight: { flightNumber: 'QH9589' },
        },
      }),
      returnRow(),
      hotelRow,
    ],
  });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'ord-1' }]),
    $executeRaw: vi.fn(async () => 1),
    order: {
      findUnique: vi.fn(async () => snapshot),
      findUniqueOrThrow: vi.fn(async () => ({
        orderNumber: snapshot.orderNumber,
        total: snapshot.total,
        paidAmount: snapshot.paidAmount,
      })),
      update: vi.fn(async () => ({})),
    },
    orderItem: {
      findMany: vi.fn(async (args: { where?: { flightScheduleId?: unknown } }) =>
        args?.where?.flightScheduleId !== undefined
          ? [{ flightScheduleId: 'sch-out', flightSchedule: snapshot.items[0].flightSchedule }]
          : [
              { id: 'leg-out', metadata: null },
              { id: 'leg-ret', metadata: null },
            ],
      ),
      findUnique: vi.fn(async () => ({
        ...returnRow(),
        fulfillmentTasks: [],
        flightSchedule: { departureTime: RET_DEPART },
      })),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 'fee-1' })),
    },
    fulfillmentTask: { count: vi.fn(async () => ticketed), updateMany: vi.fn(async () => ({ count: 1 })) },
    operationalReminder: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'wo-cancel-1' })),
    },
    refund: { count: vi.fn(async () => 0) },
    cancellationPolicy: { findMany: vi.fn(async () => [FLIGHT_POLICY]) },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(serializableOrder());
  return tx;
}

describe('取消航段 · 已出票的段', () => {
  const cancelBody = (over: Record<string, unknown> = {}) => ({
    requestToken: TOKEN,
    leg: 'RETURN' as const,
    feeMode: 'POLICY' as const,
    ...over,
  });

  it('未带确认回执 → 400 ACKNOWLEDGEMENT_REQUIRED，一座不放', async () => {
    const tx = mountCancelTx(2);
    const err = await service.cancelLeg('ord-1', cancelBody(), ADMIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(400);
    expect((err as AppError).code).toBe('ACKNOWLEDGEMENT_REQUIRED');
    expect((err as AppError).details).toMatchObject({
      warnings: [expect.stringContaining('回程已出票（2 人有确认出票记录）')],
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('带确认回执 → 照常取消，并派「撤名单/退票」工单', async () => {
    const tx = mountCancelTx(2);
    const { audit } = await service.cancelLeg(
      'ord-1',
      cancelBody({ acknowledgeWarnings: true }),
      ADMIN,
    );
    expect(audit.workOrderReminderId).toBe('wo-cancel-1');
    expect(tx.operationalReminder.create).toHaveBeenCalledTimes(1);
    const arg = (tx.operationalReminder.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(arg.data.ruleKey).toBe(`LEG_CANCEL_WITHDRAW:leg-ret:${TOKEN}`);
    expect(String(arg.data.title)).toContain('撤名单/退票');
    // 座位照放（回程 2 座）。
    expect(audit.releasedSeats).toEqual([{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }]);
  });

  it('本段没出票 → 没有 warning，不需要回执，也不派工单', async () => {
    const tx = mountCancelTx(0);
    const { audit } = await service.cancelLeg('ord-1', cancelBody(), ADMIN);
    expect(audit.workOrderReminderId).toBeNull();
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
  });
});
