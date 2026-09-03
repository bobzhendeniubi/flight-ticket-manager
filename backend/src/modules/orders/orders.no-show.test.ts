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
    // markNoShow 的拆单回放入参比对（同 token 换了另一批乘客 → 409 TOKEN_PAYLOAD_MISMATCH）。
    orderSplitRecord: { findUnique: vi.fn() },
    cancellationPolicy: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, syncOrderLegFlag } from './orders.service.js';
import {
  noShowBodySchema,
  restoreReturnLegBodySchema,
  voidReturnLegBodySchema,
} from './orders.schemas.js';
import { AppError, BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';

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
  // vi.clearAllMocks() 只清调用记录、不清实现，所以每次挂载都要把「进行中的退款」显式归零，
  // 否则某个用例把它设成 1 之后，后面所有预检用例都会被退款闸挡住。
  mockPrisma.refund.count.mockResolvedValue(0);
}

/**
 * 事务客户端 mock。orderItem.findMany 按 where 分流：
 *   带 flightScheduleId 条件 = syncOrderHasReturnLeg 的自愈查询；
 *   不带 = 幂等回放扫描（全部 FLIGHT 行 + metadata）。
 */
function mountTx(
  opts: {
    snapshot?: ReturnType<typeof orderSnapshot>;
    /**
     * 裸 prisma（非事务）读到的**源单**快照。markNoShow 在拆单**之前**要过一遍订单级 no-show 闸，
     * 那一遍走裸 prisma；不传则与事务内同一份。只有「源单没问题、新单上出事」这类用例需要分开。
     */
    sourceSnapshot?: ReturnType<typeof orderSnapshot>;
    flightMeta?: Array<{ id: string; metadata: unknown } & Record<string, unknown>>;
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
      // 回程作废会把「回程已释放」的两条待办一并关掉（同事务）。
      updateMany: vi.fn(async () => ({ count: 1 })),
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
    // 超售放行的 CRITICAL 审计与占座同一事务写（writeAuditWithinTx），故 tx 上必须有这张表。
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(serializableOrder());
  // 裸 prisma 上有两次读：markNoShow 的「要不要拆单」头查询，以及拆单前那一遍订单级 no-show 闸
  //（loadOrderForLegCancel，要 items）。整份快照两边都够用，故统一返回它。
  mockPrisma.order.findUnique.mockResolvedValue(opts.sourceSnapshot ?? snapshot);
  mockPrisma.refund.count.mockResolvedValue(0);
  mockPrisma.fulfillmentTask.count.mockResolvedValue(opts.ticketedReturn ?? 0);
  // 默认没有既有拆单流水（= 本次不是拆单回放）。
  mockPrisma.orderSplitRecord.findUnique.mockResolvedValue(null);
  return tx;
}

// ── legActionLog 流水的测试构造 ────────────────────────────────────────────────
// 指纹字面量**写死**（不从 service import 那个函数）：它是落库的持久化契约，
// 格式一改这里就该红。跟着实现走就永远测不出「指纹格式悄悄变了、存量 token 全部失配」。
/** no-show / 再释放的入参指纹（键排序后 JSON）。 */
const noShowFp = (releaseReturn = true, passengerIds: string[] = []): string =>
  JSON.stringify({ passengerIds: [...passengerIds].sort(), releaseReturn });
/** 恢复回程 / 起飞后作废的入参指纹：请求体里没有能改结果的字段，恒为空对象。 */
const EMPTY_FP = '{}';

/** 一条 legActionLog 流水（默认带上与 type 相称的指纹）。 */
const legLog = (
  type: 'NO_SHOW' | 'RELEASE' | 'RESTORE' | 'CANCEL_LEG' | 'VOID',
  requestToken: string,
  over: Record<string, unknown> = {},
) => ({
  type,
  requestToken,
  at: new Date().toISOString(),
  byUserId: 'admin-1',
  fingerprint: type === 'NO_SHOW' || type === 'RELEASE' ? noShowFp() : EMPTY_FP,
  ...over,
});

const noShowBody = (over: Record<string, unknown> = {}) =>
  noShowBodySchema.parse({ requestToken: TOKEN, ...over });
const restoreBody = (over: Record<string, unknown> = {}) =>
  restoreReturnLegBodySchema.parse({ requestToken: TOKEN, ...over });
const voidBody = (over: Record<string, unknown> = {}) =>
  voidReturnLegBodySchema.parse({ requestToken: TOKEN, ...over });

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

  it('回程当前处于已释放态 → 拒绝重复释放，指路「恢复回程」', async () => {
    mountPreview(
      orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: new Date().toISOString() } } }),
          returnRow({
            flightScheduleId: null,
            flightSchedule: null,
            metadata: { returnReleased: { at: new Date().toISOString() } },
          }),
          hotelRow,
        ],
      }),
    );
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.alreadyNoShow).toBe(true);
    expect(res.blockers.join('')).toContain('回程座位当前已释放');
    expect(res.blockers.join('')).toContain('恢复回程');
  });

  it('去程标过 no-show 但本单是单程 → 没有可执行动作，拒绝', async () => {
    mountPreview(
      orderSnapshot({
        items: [outboundRow({ metadata: { noShow: { at: new Date().toISOString() } } }), hotelRow],
      }),
    );
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('没有可释放的回程航段');
  });

  it('去程标过 no-show、回程已恢复回来 → 允许再释放一次（isRerelease）', async () => {
    const releasedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const restoredAt = new Date(Date.now() - 3600_000).toISOString();
    mountPreview(
      orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: releasedAt } } }),
          returnRow({
            metadata: {
              returnReleased: { at: releasedAt },
              returnRestored: { at: restoredAt },
            },
          }),
          hotelRow,
        ],
      }),
    );
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(true);
    expect(res.isRerelease).toBe(true);
    expect(res.warnings.join('')).toContain('只会再释放一次回程座位');
  });

  it('回程班次已起飞 + 勾了释放 → 拒绝；不勾释放则放行', async () => {
    const departed = new Date(Date.now() - 2 * 24 * 3600_000);
    const snapshot = orderSnapshot({
      items: [
        outboundRow(),
        returnRow({
          flightSchedule: {
            departureTime: departed,
            departureTz: 'Asia/Shanghai',
            flight: { flightNumber: 'QH9588' },
          },
        }),
        hotelRow,
      ],
    });
    mountPreview(snapshot);
    const blocked = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(blocked.eligible).toBe(false);
    expect(blocked.returnDeparted).toBe(true);
    expect(blocked.blockers.join('')).toContain('回程航班已起飞');

    mountPreview(snapshot);
    const allowed = await service.previewNoShow('ord-1', { releaseReturn: false }, ADMIN);
    expect(allowed.eligible).toBe(true);
    expect(allowed.returnDeparted).toBe(true);
  });

  it('有进行中的退款 → 拒绝标记 no-show', async () => {
    mountPreview();
    mockPrisma.refund.count.mockResolvedValue(1);
    const res = await service.previewNoShow('ord-1', {}, ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('进行中的退款');
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
    expect(res.warnings.join('')).toContain('回程已出票（该段有 2 条确认出票记录）');
    expect(res.warnings.join('')).toContain('清成未开');
  });

  it('只勾部分乘客 → scope=SPLIT_REQUIRED，拆单的闸并进 blockers', async () => {
    mountPreview();
    const spy = vi
      .spyOn(service as unknown as { assessOrderSplitForNoShow: () => Promise<string[]> },
        'assessOrderSplitForNoShow')
      .mockResolvedValue(['本单佣金已进结算流程，请财务先处理后再拆。']);
    const res = await service.previewNoShow('ord-1', { passengerIds: ['pax-1'] }, ADMIN);
    expect(res.scope).toBe('SPLIT_REQUIRED');
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('佣金已进结算流程');
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
    // 订单级只写了两条物化列（hasReturnLeg / legFlag，自愈）、回程开票位归零、adjustments 留痕。
    expect(new Set(orderKeys)).toEqual(
      new Set(['hasReturnLeg', 'legFlag', 'returnInvoiced', 'adjustments']),
    );
  });

  it('去程行留下 noShow 快照与前缀，班次**不置空**（这段是真飞了的）', async () => {
    const tx = mountTx();
    await service.markNoShow('ord-1', noShowBody({ note: '客人没来' }), ADMIN);
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const out = updateDataFor(calls, 'leg-out')!;
    expect(out.description).toBe('【去程未登机】机票 QH9589 经济舱 × 2');
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
    expect(ret.description).toBe('【回程座位已释放】机票 QH9588 经济舱 × 2');
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
    // 判定权整个交给 splitOrder（不再先跑一遍 previewOrderSplit，见 markNoShow 步骤 2 的注释）。
    const split = vi
      .spyOn(service, 'splitOrder')
      .mockRejectedValue(new BadRequestError('本单佣金已进结算流程，请财务先处理后再拆。'));
    const err = await service
      .markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('SPLIT_BLOCKED');
    expect((err as AppError).details).toMatchObject({
      blockers: [expect.stringContaining('佣金已进结算流程')],
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    split.mockRestore();
  });

  it('重试：所选乘客已被上一轮拆走 → 走 splitOrder 回放，绝不把源单当整单标记', async () => {
    // C1 的事故场景：首刷把 pax-1 拆到新单，重试时源单只剩 pax-2 ——
    // 旧写法用「所选人数 < 源单当前人数」判定，重试就成了「≥ 全员」→ 判成整单，
    // 结果给留守的 pax-2（登了机的人）打标并放掉他的回程座位。
    mountTx({
      snapshot: orderSnapshot({
        passengers: [
          { id: 'pax-2', fullName: 'LI SI', chineseName: '李四', pnr: null, eticketNumber: null },
        ],
      }),
    });
    // 源单快照（头查询 + 拆单前的订单级闸共用）里只剩 1 位乘客 —— pax-1 已被上一轮拆走。
    const split = vi.spyOn(service, 'splitOrder').mockResolvedValue({
      sourceOrderId: 'ord-1',
      sourceOrderNumber: 'FTM20260902-001',
      targetOrderId: 'ord-2',
      targetOrderNumber: 'FTM20260902-002',
      movedShareCny: 4000,
      movedPaidCny: 4000,
      passengerCount: 1,
      replayed: true,
    });

    const res = await service.markNoShow(
      'ord-1',
      noShowBody({ passengerIds: ['pax-1'] }),
      ADMIN,
    );
    expect(split).toHaveBeenCalledTimes(1);
    // 目标是拆出的那张新单，绝不是源单。
    expect(res.targetOrderId).toBe('ord-2');
    split.mockRestore();
  });

  it('拆成了但标记失败 → 409 SPLIT_DONE_NOSHOW_FAILED，带新单 id（拆单不回滚）', async () => {
    mountTx({
      // 事务内（= 新单）的去程还没起飞 → 标记必然失败，用来构造「拆成了、标记没成」的中间态。
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
      // 源单本身干净（去程已飞）→ 拆单前那道订单级闸放行，才走得到拆单与新单标记。
      sourceSnapshot: orderSnapshot(),
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
            legActionLog: [legLog('NO_SHOW', TOKEN)],
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

  it('不同 requestToken 不会命中回放（走正常闸：回程已释放态被拒）', async () => {
    const releasedAt = new Date().toISOString();
    const tx = mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: releasedAt, requestToken: TOKEN } } }),
          returnRow({
            flightScheduleId: null,
            flightSchedule: null,
            metadata: { returnReleased: { at: releasedAt, requestToken: TOKEN } },
          }),
          hotelRow,
        ],
      }),
      flightMeta: [
        { id: 'leg-out', metadata: { noShow: { at: releasedAt, requestToken: TOKEN } } },
        { id: 'leg-ret', metadata: { returnReleased: { at: releasedAt, requestToken: TOKEN } } },
      ],
    });
    await expect(
      service.markNoShow('ord-1', noShowBody({ requestToken: TOKEN2 }), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('再释放的重试也命中回放：token 落在回程 returnReleased 上，不二次放座', async () => {
    const releasedAt = new Date().toISOString();
    const tx = mountTx({
      flightMeta: [
        // 首个 no-show 快照用的是另一个 token（再释放不重写它）。
        { id: 'leg-out', metadata: { noShow: { at: releasedAt, requestToken: TOKEN2 } } },
        {
          id: 'leg-ret',
          metadata: {
            returnReleased: {
              at: releasedAt,
              requestToken: TOKEN,
              releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
              workOrderReminderId: null,
            },
            legActionLog: [legLog('RELEASE', TOKEN)],
          },
        },
      ],
    });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(res.audit.replayed).toBe(true);
    expect(res.audit.returnItemId).toBe('leg-ret');
    expect(res.audit.outboundItemId).toBe('leg-out');
    expect(res.audit.orderNumber).toBe('FTM20260902-001');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('整单回放的 orderNumber 读真值，不再是空串', async () => {
    mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            noShow: { at: new Date().toISOString(), requestToken: TOKEN },
            legActionLog: [legLog('NO_SHOW', TOKEN)],
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const res = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(res.audit.replayed).toBe(true);
    expect(res.audit.orderNumber).toBe('FTM20260902-001');
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
        description: '【回程座位已释放】机票 QH9588 经济舱 × 2',
        flightScheduleId: null,
        flightSchedule: null,
        metadata: { returnReleased: { ...RELEASED_SNAPSHOT, ...snapOver } },
      }),
      hotelRow,
    ],
    ...over,
  });
}

// 放座是按舱位做的：舱位为空时旧写法静默跳过放座，却照常置空班次、落 returnReleased 快照 ——
// 座位一个没放回库存，系统却认为释放过了（这一班从此少卖 N 座）。
describe('no-show · 回程行缺舱位信息（C-L4）', () => {
  it('勾了「同时释放回程」但回程行没有舱位 → blocker，不做半拉子释放', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      orderSnapshot({
        items: [outboundRow(), returnRow({ flightCabin: null }), hotelRow],
      }),
    );
    const res = await service.previewNoShow('ord-1', { releaseReturn: true }, ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('缺舱位信息');
  });

  it('不勾释放回程 → 照常放行（只记 no-show，不动座位）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      orderSnapshot({
        items: [outboundRow(), returnRow({ flightCabin: null }), hotelRow],
      }),
    );
    const res = await service.previewNoShow('ord-1', { releaseReturn: false }, ADMIN);
    expect(res.blockers.join('')).not.toContain('缺舱位信息');
  });
});

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
    // 班次本来就已超 1 座（sold 181 / capacity 180），本次占回 2 座 →
    // **本次新增** 2 座超售、恢复后累计超出 3 座。旧口径把别人早就卖穿的那 1 座也算进本次，报 3。
    expect(res.oversellBy).toBe(2);
    expect(res.oversoldAfter).toBe(3);
    expect(res.oversellDetail).toEqual([
      { cabin: 'ECONOMY', quantity: 2, before: 1, after: 3, increment: 2 },
    ]);
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
    // 上限比的是**累计**（恢复后一共超 12 座），不是本次新增的 2 座 ——
    // 班次早被卖穿到上限之外时，再放行 1 座也是继续加码。
    expect(res.oversellBy).toBe(2);
    expect(res.oversoldAfter).toBe(12);
    expect(res.blockers.join('')).toContain('超售将超过上限 5 座');
    expect(res.blockers.join('')).toContain('累计超出 12 座');
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
  // ── 待办收口：不关的话运营手上那条「回程已释放待跟进」会一直催，还会照旧条去点「恢复回程」──
  it('把这一行的两条「回程已释放」提醒置 DONE，写明是本次恢复收的口', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: null },
      ],
      seatClass: { capacity: 180, sold: 100 },
    });
    await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);

    const calls = tx.operationalReminder.updateMany.mock.calls as unknown as Array<
      [{ where: Record<string, unknown>; data: Record<string, unknown> }]
    >;
    const released = calls.find((c) => Array.isArray((c[0].where.ruleKey as { in?: string[] })?.in));
    expect(released).toBeDefined();
    expect((released![0].where.ruleKey as { in: string[] }).in).toEqual([
      `NOSHOW_RELEASED:leg-ret:${RELEASED_SNAPSHOT.at}`,
      `NOSHOW_RELEASED:leg-ret:${RELEASED_SNAPSHOT.at}:DEPARTED`,
    ]);
    expect(released![0].data.status).toBe('DONE');
    expect(released![0].data.resolvedNote).toContain('回程已恢复到原班次');
  });

  // 释放时派的「撤名单/退票」工单：这一刀作废了（名单不用撤了），要办的是新派的「重新上名单」。
  // 置 SKIPPED 而不是 DONE —— 这活并没有做完，报表上不该记成一条已完成的工单。
  it('把该行仍未处理的「撤名单/退票」工单置 SKIPPED，注明改派重新上名单', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: null },
      ],
      seatClass: { capacity: 180, sold: 100 },
    });
    await service.restoreReturnLeg('ord-1', restoreBody(), ADMIN);

    const calls = tx.operationalReminder.updateMany.mock.calls as unknown as Array<
      [{ where: Record<string, unknown>; data: Record<string, unknown> }]
    >;
    const withdraw = calls.find(
      (c) => (c[0].where.ruleKey as { startsWith?: string })?.startsWith != null,
    );
    expect(withdraw).toBeDefined();
    expect((withdraw![0].where.ruleKey as { startsWith: string }).startsWith).toBe(
      'NOSHOW_WITHDRAW:leg-ret:',
    );
    expect(withdraw![0].data.status).toBe('SKIPPED');
    expect(withdraw![0].data.resolvedNote).toContain('改派重新上名单');
  });

  // legActionLog 是多轮释放/恢复的**唯一**全量来源：returnRestored 快照是覆盖写，
  // 只记布尔的 oversold 事后连「这一班到底为恢复多卖了几座」都答不上来。
  it('legActionLog 的 RESTORE 条目带 oversoldBy / displacedReserved 数值', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: null },
      ],
      // 余位不够 → 走超售直加（本次新增 2 座超售）。
      seatClass: { capacity: 100, sold: 100 },
    });
    await service.restoreReturnLeg('ord-1', restoreBody({ allowOversell: true }), ADMIN);

    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const meta = updateDataFor(calls, 'leg-ret')!.metadata as Record<string, unknown>;
    const log = meta.legActionLog as Array<Record<string, unknown>>;
    const restore = log.find((e) => e.type === 'RESTORE')!;
    expect(restore.oversoldBy).toBe(2);
    expect(restore.displacedReserved).toBe(0);
  });

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
    expect((err as AppError).details).toEqual({
      available: -1,
      oversellBy: 2,
      oversoldAfter: 3,
    });
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
    // 本次新增 2 座（班次原本已超 1 座）；恢复后该舱累计超出 3 座。
    expect(audit.oversoldBy).toBe(2);
    expect(audit.scheduleOversoldAfter).toBe(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const meta = updateDataFor(calls, 'leg-ret')!.metadata as Record<string, unknown>;
    expect(meta.returnRestored).toMatchObject({
      oversold: true,
      oversoldBy: 2,
      scheduleOversoldAfter: 3,
      seatDetail: [{ cabin: 'ECONOMY', quantity: 2, before: 1, after: 3, increment: 2 }],
    });

    // 超售放行的 CRITICAL 审计与占座同一事务（不再由路由异步补记，避免占座成了、审计没成）。
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = (tx.auditLog.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(auditArg.data.action).toBe('RESTORE_RETURN_LEG_OVERSOLD');
    expect(auditArg.data.severity).toBe('CRITICAL');
    expect(auditArg.data.targetType).toBe('ORDER');
    expect(String(auditArg.data.targetLabel)).toContain('超出 3 座（本次 +2，上限 5）');
    expect(auditArg.data.after).toMatchObject({
      oversoldBy: 2,
      scheduleOversoldAfter: 3,
      seatDetail: [{ cabin: 'ECONOMY', before: 1, after: 3, increment: 2 }],
    });
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
            legActionLog: [legLog('RESTORE', TOKEN)],
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
      warnings: [expect.stringContaining('回程已出票（该段有 2 条确认出票记录）')],
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

// ══════════════════════════════════════════════════════════════════════════
// 8. 释放 → 恢复 → 再释放（M10）：座位账守恒 + 首个 no-show 快照不被覆盖
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 释放→恢复→再释放', () => {
  it('三步走完座位账守恒（放 2 → 占 2 → 再放 2），且首个 no-show 快照原样保留', async () => {
    // ① 第一次释放：干净单 → 放回 2 座。
    const tx1 = mountTx();
    const first = await service.markNoShow('ord-1', noShowBody(), ADMIN);
    expect(first.audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    expect(tx1.$executeRaw).toHaveBeenCalledTimes(1); // 释放 2 座（同舱一次）
    const firstNoShow = (
      updateDataFor(
        tx1.orderItem.update.mock.calls as unknown as Array<
          [{ where: { id: string }; data: Record<string, unknown> }]
        >,
        'leg-out',
      )!.metadata as { noShow: Record<string, unknown> }
    ).noShow;
    const firstMarkAt = firstNoShow.at as string;

    // ② 恢复：照释放快照占回同样的 2 座。
    vi.clearAllMocks();
    mountTx({
      snapshot: releasedSnapshotOrder(),
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: null },
      ],
      seatClass: { capacity: 180, sold: 100 },
    });
    const restored = await service.restoreReturnLeg('ord-1', restoreBody({}), ADMIN);
    expect(restored.audit.quantity).toBe(2);
    expect(restored.audit.oversold).toBe(false);
    expect(restored.audit.scheduleOversoldAfter).toBe(0);

    // ③ 再释放：去程标记仍在、回程已恢复回原班次 → 只做「再放一次座」。
    vi.clearAllMocks();
    const releasedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const restoredAt = new Date(Date.now() - 3600_000).toISOString();
    const tx3 = mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow({
            description: '【去程未登机】机票 QH9589 经济舱 × 2',
            metadata: { noShow: { at: firstMarkAt, byUserId: 'admin-1', requestToken: TOKEN } },
          }),
          returnRow({
            metadata: {
              returnReleased: { at: releasedAt, requestToken: TOKEN },
              returnRestored: { at: restoredAt, requestToken: TOKEN },
            },
          }),
          hotelRow,
        ],
      }),
      flightMeta: [
        { id: 'leg-out', metadata: { noShow: { at: firstMarkAt, requestToken: TOKEN } } },
        {
          id: 'leg-ret',
          metadata: {
            returnReleased: { at: releasedAt, requestToken: TOKEN },
            returnRestored: { at: restoredAt, requestToken: TOKEN },
          },
        },
      ],
    });
    const second = await service.markNoShow('ord-1', noShowBody({ requestToken: TOKEN2 }), ADMIN);
    // 放的还是同样的 2 座 —— 占回几座就再放几座，账两边对得上。
    expect(second.audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    expect(tx3.$executeRaw).toHaveBeenCalledTimes(1);

    const calls3 = tx3.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    // 首个 no-show 快照原样保留（at / requestToken 不变），只多一条释放历史。
    const outMeta = (updateDataFor(calls3, 'leg-out')!.metadata as {
      noShow: Record<string, unknown>;
    }).noShow;
    expect(outMeta.at).toBe(firstMarkAt);
    expect(outMeta.requestToken).toBe(TOKEN);
    expect(Array.isArray(outMeta.releaseHistory)).toBe(true);
    expect((outMeta.releaseHistory as unknown[]).length).toBe(1);
    expect((outMeta.releaseHistory as Array<Record<string, unknown>>)[0]).toMatchObject({
      requestToken: TOKEN2,
      returnItemId: 'leg-ret',
    });

    // 新的 returnReleased 覆盖旧的，旧的整份进 history（历史一条不丢）。
    const retMeta = (updateDataFor(calls3, 'leg-ret')!.metadata as {
      returnReleased: Record<string, unknown>;
    }).returnReleased;
    expect(retMeta.requestToken).toBe(TOKEN2);
    expect((retMeta.history as Array<Record<string, unknown>>)[0]).toMatchObject({
      at: releasedAt,
      requestToken: TOKEN,
    });
  });

  it('去程标过 no-show 又不勾释放 → 没有可执行动作，直接拒', async () => {
    const releasedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const restoredAt = new Date(Date.now() - 3600_000).toISOString();
    mountPreview(
      orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: releasedAt } } }),
          returnRow({
            metadata: {
              returnReleased: { at: releasedAt },
              returnRestored: { at: restoredAt },
            },
          }),
          hotelRow,
        ],
      }),
    );
    const res = await service.previewNoShow('ord-1', { releaseReturn: false }, ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('没有任何可执行的动作');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. 恢复回程的两条新闸（H2）
// ══════════════════════════════════════════════════════════════════════════
describe('恢复回程 · 已取消 / 已恢复过', () => {
  it('该回程已按取消政策取消 → 拒绝恢复（钱早按取消结清了，不能把座位白占回来）', async () => {
    const order = releasedSnapshotOrder();
    order.items = order.items.map((it) =>
      it.id === 'leg-ret'
        ? {
            ...it,
            metadata: {
              ...(it.metadata as Record<string, unknown>),
              returnLegCancelled: { at: new Date().toISOString(), leg: 'RETURN' },
            },
          }
        : it,
    ) as typeof order.items;
    mockPrisma.order.findUnique.mockResolvedValue(order);
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('已按取消政策取消');
  });

  it('释放过但已恢复（快照仍在）→ 拒绝二次恢复，不会照快照重复占座', async () => {
    const releasedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const restoredAt = new Date(Date.now() - 3600_000).toISOString();
    mockPrisma.order.findUnique.mockResolvedValue(
      orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: releasedAt } } }),
          // 已恢复：班次占着 + returnRestored 比 returnReleased 新。
          returnRow({
            metadata: {
              returnReleased: { ...RELEASED_SNAPSHOT, at: releasedAt },
              returnRestored: { at: restoredAt },
            },
          }),
          hotelRow,
        ],
      }),
    );
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('无需恢复');
  });

  it('预检的恢复座数取释放快照逐舱之和（升舱拆座时与行 quantity 不等）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      releasedSnapshotOrder({}, {
        releasedSeats: [
          { scheduleId: 'sch-ret', cabin: 'BUSINESS', quantity: 1 },
          { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
        ],
      }),
    );
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 100 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    // 行 quantity 是 2，但实际放了 3 座（商务 1 + 经济 2）→ 预检要显示 3。
    expect(res.original?.quantity).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 10. B2：状态流转释放座位时，已起飞的航段不放座
// ══════════════════════════════════════════════════════════════════════════
describe('_updateStatusWithinTx · 已起飞航段不放座', () => {
  /** 最小 Decimal 桩：释放分支只在 toStatus==='PAID' 时用到 greaterThan，这里用不到。 */
  const decimalLike = (n: number) => ({
    toString: () => String(n),
    greaterThan: (o: { toString: () => string }) => n > Number(o.toString()),
  });

  function mountStatusTx(items: Array<Record<string, unknown>>) {
    const tx = {
      order: {
        findUnique: vi.fn(async () => ({
          id: 'ord-1',
          orderNumber: 'FTM20260902-001',
          status: 'PENDING_PAYMENT',
          userId: 'user-1',
          agentId: null,
          deletedAt: null,
          paidAmount: decimalLike(0),
          total: decimalLike(TOTAL),
          items,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => serializableOrder()),
      },
      orderStatusEvent: { create: vi.fn(async () => ({})) },
      orderItem: { findMany: vi.fn(async () => []) },
      fulfillmentTask: { updateMany: vi.fn(async () => ({ count: 0 })) },
      commissionRecord: { findMany: vi.fn(async () => []) },
      refund: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
      payment: { updateMany: vi.fn(async () => ({ count: 0 })) },
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => []),
    };
    return tx;
  }

  const requester = { userId: 'admin-1', role: UserRole.ADMIN, actorType: 'USER' as const };

  it('已起飞的航段不还座（否则过去的班次凭空多出可卖余位）', async () => {
    const flown = new Date(Date.now() - 3 * 24 * 3600_000);
    const tx = mountStatusTx([
      {
        id: 'leg-out',
        kind: 'FLIGHT',
        quantity: 2,
        flightScheduleId: 'sch-out',
        flightCabin: 'ECONOMY',
        metadata: null,
        flightSchedule: { departureTime: flown },
      },
    ]);
    await service._updateStatusWithinTx(
      tx as unknown as Parameters<OrderService['_updateStatusWithinTx']>[0],
      'ord-1',
      'CANCELLED' as never,
      requester as never,
      '客人 no-show 后取消',
      [],
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('未起飞的航段照常还座', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600_000);
    const tx = mountStatusTx([
      {
        id: 'leg-ret',
        kind: 'FLIGHT',
        quantity: 2,
        flightScheduleId: 'sch-ret',
        flightCabin: 'ECONOMY',
        metadata: null,
        flightSchedule: { departureTime: future },
      },
    ]);
    await service._updateStatusWithinTx(
      tx as unknown as Parameters<OrderService['_updateStatusWithinTx']>[0],
      'ord-1',
      'CANCELLED' as never,
      requester as never,
      '客人取消',
      [],
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. 多轮释放/恢复后，**旧 token** 仍然幂等（legActionLog）
//
// 释放 → 恢复 → 再释放 → 再恢复，returnReleased / returnRestored 每轮都会被新快照顶掉，
// 中间几轮的 requestToken 因此从「当前快照」上消失。旧写法只查当前快照的 token，
// 那几轮的延迟重试（网络抖动/运营连点/前端自动重试）会被当成新请求重跑一遍：
// 二次放座 / 二次占座，座位账凭空多算或少算一批，事后极难查。
// 现在每轮都往行上的 legActionLog 追加一条（append-only），回放只认「见没见过这个 token」。
// ══════════════════════════════════════════════════════════════════════════
const TOKEN_A = '00000000-0000-4000-8000-00000000aaa1';
const TOKEN_B = '00000000-0000-4000-8000-00000000bbb2';
const TOKEN_C = '00000000-0000-4000-8000-00000000ccc3';
const TOKEN_D = '00000000-0000-4000-8000-00000000ddd4';
const TOKEN_E = '00000000-0000-4000-8000-00000000eee5';

describe('no-show · 多轮释放/恢复后旧 token 的延迟重试', () => {
  it('释放 A → 恢复 B → 再释放 C → 再恢复 D → 再释放 E 之后，B 与 C 的重试都不动库存', async () => {
    type UpdateCalls = Array<[{ where: { id: string }; data: Record<string, unknown> }]>;
    let outMeta: unknown = null;
    let retMeta: unknown = null;

    // 只假造 Date：四轮动作在真实时钟下可能落在同一毫秒，
    // 「释放晚于最近一次恢复」就判不出来了（那是时间戳精度问题，不是本用例要测的东西）。
    vi.useFakeTimers({ toFake: ['Date'] });
    const tick = (): void => {
      vi.setSystemTime(new Date(Date.now() + 60_000));
    };

    /** 把上一轮写下的 metadata 接到下一轮的快照上（mock 不持久化，得手工串起来）。 */
    const mountRound = (returnOnSchedule: boolean, seatClass?: { capacity: number; sold: number }) =>
      mountTx({
        snapshot: orderSnapshot({
          items: [
            outboundRow({
              description: '【去程未登机】机票 QH9589 经济舱 × 2',
              metadata: outMeta,
            }),
            returnRow(
              returnOnSchedule
                ? { metadata: retMeta }
                : {
                    description: '【回程座位已释放】机票 QH9588 经济舱 × 2',
                    flightScheduleId: null,
                    flightSchedule: null,
                    metadata: retMeta,
                  },
            ),
            hotelRow,
          ],
        }),
        flightMeta: [
          { id: 'leg-out', metadata: outMeta },
          { id: 'leg-ret', metadata: retMeta },
        ],
        seatClass,
      });

    // ① 释放 A（干净单）
    let tx = mountTx();
    await service.markNoShow('ord-1', noShowBody({ requestToken: TOKEN_A }), ADMIN);
    outMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-out')!
      .metadata;
    retMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-ret')!
      .metadata;

    // ② 恢复 B
    tick();
    vi.clearAllMocks();
    tx = mountRound(false, { capacity: 180, sold: 100 });
    await service.restoreReturnLeg('ord-1', restoreBody({ requestToken: TOKEN_B }), ADMIN);
    retMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-ret')!
      .metadata;

    // ③ 再释放 C
    tick();
    vi.clearAllMocks();
    tx = mountRound(true);
    await service.markNoShow('ord-1', noShowBody({ requestToken: TOKEN_C }), ADMIN);
    outMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-out')!
      .metadata;
    retMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-ret')!
      .metadata;

    // ④ 再恢复 D
    tick();
    vi.clearAllMocks();
    tx = mountRound(false, { capacity: 180, sold: 100 });
    await service.restoreReturnLeg('ord-1', restoreBody({ requestToken: TOKEN_D }), ADMIN);
    retMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-ret')!
      .metadata;

    // ⑤ 再释放 E（多走这一轮，C 才会被 E 挤出 returnReleased —— 否则 C 还挂在当前快照上，
    //    旧写法也能扫到，这条用例就白测了）
    tick();
    vi.clearAllMocks();
    tx = mountRound(true);
    await service.markNoShow('ord-1', noShowBody({ requestToken: TOKEN_E }), ADMIN);
    outMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-out')!
      .metadata;
    retMeta = updateDataFor(tx.orderItem.update.mock.calls as unknown as UpdateCalls, 'leg-ret')!
      .metadata;

    // 五轮动作都进了 legActionLog（append-only，一条不丢）。
    const log = (retMeta as { legActionLog: Array<Record<string, unknown>> }).legActionLog;
    expect(log.map((e) => [e.type, e.requestToken])).toEqual([
      ['NO_SHOW', TOKEN_A],
      ['RESTORE', TOKEN_B],
      ['RELEASE', TOKEN_C],
      ['RESTORE', TOKEN_D],
      ['RELEASE', TOKEN_E],
    ]);
    // 当前快照上只剩最后两轮：returnReleased=E、returnRestored=D。
    // C 被挤进了 returnReleased.history，B 则**连 history 都没有**（returnRestored 是纯覆盖写）——
    // 只查当前快照 requestToken 的旧写法，这两个 token 到这里就彻底扫不到了。
    expect((retMeta as { returnReleased: { requestToken: string } }).returnReleased.requestToken)
      .toBe(TOKEN_E);
    expect((retMeta as { returnRestored: { requestToken: string } }).returnRestored.requestToken)
      .toBe(TOKEN_D);

    // ⑥ C（第二次释放）的延迟重试 → 回放，一座不动
    vi.clearAllMocks();
    const txC = mountRound(false); // E 之后回程又处于已释放态
    const replayC = await service.markNoShow(
      'ord-1',
      noShowBody({ requestToken: TOKEN_C }),
      ADMIN,
    );
    expect(replayC.audit.replayed).toBe(true);
    expect(txC.$executeRaw).not.toHaveBeenCalled();
    expect(txC.orderItem.update).not.toHaveBeenCalled();

    // ⑦ B（第一次恢复）的延迟重试 → 回放，一座不动
    vi.clearAllMocks();
    const txB = mountRound(false, { capacity: 180, sold: 100 });
    const replayB = await service.restoreReturnLeg(
      'ord-1',
      restoreBody({ requestToken: TOKEN_B }),
      ADMIN,
    );
    expect(replayB.audit.replayed).toBe(true);
    // 回放回的是**当前状态**（最后那次恢复的结果），不是 B 那一轮的旧快照。
    expect(replayB.audit.returnItemId).toBe('leg-ret');
    expect(txB.$executeRaw).not.toHaveBeenCalled();
    expect(txB.orderItem.update).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 10. 释放量必须与快照恒等（releaseSeatStrictWithinTx）
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 释放量与快照恒等', () => {
  it('该舱 sold 不足以释放 → 整单回滚，metadata 一个字都不写', async () => {
    const tx = mountTx();
    // sold >= qty 的条件没命中 → affected 0（floored 版会静默少放，快照却照记 2 座）。
    tx.$executeRaw.mockResolvedValue(0);

    await expect(service.markNoShow('ord-1', noShowBody(), ADMIN)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
  });

  it('错误文案写清楚「已回滚、一座未放」，运营知道下一步是核库存', async () => {
    const tx = mountTx();
    tx.$executeRaw.mockResolvedValue(0);
    const err = await service.markNoShow('ord-1', noShowBody(), ADMIN).catch((e: unknown) => e);
    expect(String((err as Error).message)).toContain('库存账对不上');
    expect(String((err as Error).message)).toContain('已回滚');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 11. legFlag 物化列 —— 与导出「航段状态」同一口径（含取消航段的作废态）
// ══════════════════════════════════════════════════════════════════════════
describe('syncOrderLegFlag · 与 deriveLegStatus 同口径', () => {
  /** 只给 syncOrderLegFlag 用的最小 tx：一批 FLIGHT 行 + 记录写下的 legFlag。 */
  function legFlagTx(items: Array<Record<string, unknown>>) {
    return {
      orderItem: { findMany: vi.fn(async () => items) },
      order: { update: vi.fn(async () => ({})) },
    } as unknown as Parameters<typeof syncOrderLegFlag>[0];
  }

  const AT1 = '2026-09-01T00:00:00.000Z';
  const AT2 = '2026-09-02T00:00:00.000Z';
  const AT3 = '2026-09-03T00:00:00.000Z';

  it('释放 → RETURN_RELEASED', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        { kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: { noShow: { at: AT1 } } },
        { kind: 'FLIGHT', flightScheduleId: null, metadata: { returnReleased: { at: AT1 } } },
      ]),
      'ord-1',
    );
    expect(flag).toBe('RETURN_RELEASED');
  });

  it('释放 → 恢复 → RETURN_RESTORED', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        { kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: { noShow: { at: AT1 } } },
        {
          kind: 'FLIGHT',
          flightScheduleId: 'sch-ret',
          metadata: { returnReleased: { at: AT1 }, returnRestored: { at: AT2 } },
        },
      ]),
      'ord-1',
    );
    expect(flag).toBe('RETURN_RESTORED');
  });

  it('释放 → 恢复 → 取消航段 → RETURN_VOIDED（此前停在 RETURN_RESTORED，与导出列自相矛盾）', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        { kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: { noShow: { at: AT1 } } },
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: {
            returnReleased: { at: AT1 },
            returnRestored: { at: AT2 },
            returnLegCancelled: { at: AT3 },
          },
        },
      ]),
      'ord-1',
    );
    expect(flag).toBe('RETURN_VOIDED');
  });

  it('没标过 no-show、直接取消回程 → 同样是 RETURN_VOIDED', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        { kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: null },
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: { returnLegCancelled: { at: AT1, originalAmountCny: 3000 } },
        },
      ]),
      'ord-1',
    );
    expect(flag).toBe('RETURN_VOIDED');
  });

  it('取消**去程** → OUTBOUND_VOIDED（按快照里的 leg 分方向，不再一律记成回程作废）', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: { returnLegCancelled: { at: AT1, leg: 'OUTBOUND', originalAmountCny: 3000 } },
        },
        { kind: 'FLIGHT', flightScheduleId: 'sch-ret', metadata: null },
      ]),
      'ord-1',
    );
    expect(flag).toBe('OUTBOUND_VOIDED');
  });

  it('取消**回程**（快照 leg=RETURN）→ RETURN_VOIDED', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        { kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: null },
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: { returnLegCancelled: { at: AT1, leg: 'RETURN', originalAmountCny: 3000 } },
        },
      ]),
      'ord-1',
    );
    expect(flag).toBe('RETURN_VOIDED');
  });

  it('两段都取消过 → 去程作废优先（整趟行程都不成立了）', async () => {
    const flag = await syncOrderLegFlag(
      legFlagTx([
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: { returnLegCancelled: { at: AT2, leg: 'OUTBOUND' } },
        },
        {
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: { returnLegCancelled: { at: AT1, leg: 'RETURN' } },
        },
      ]),
      'ord-1',
    );
    expect(flag).toBe('OUTBOUND_VOIDED');
  });

  it('起飞后作废（returnVoidedFinal）→ RETURN_VOIDED；单标去程 → NO_SHOW；干净单 → NONE', async () => {
    expect(
      await syncOrderLegFlag(
        legFlagTx([
          {
            kind: 'FLIGHT',
            flightScheduleId: null,
            metadata: { returnReleased: { at: AT1 }, returnVoidedFinal: { at: AT3 } },
          },
        ]),
        'ord-1',
      ),
    ).toBe('RETURN_VOIDED');

    expect(
      await syncOrderLegFlag(
        legFlagTx([
          { kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: { noShow: { at: AT1 } } },
        ]),
        'ord-1',
      ),
    ).toBe('NO_SHOW');

    expect(
      await syncOrderLegFlag(
        legFlagTx([{ kind: 'FLIGHT', flightScheduleId: 'sch-out', metadata: null }]),
        'ord-1',
      ),
    ).toBe('NONE');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 12. 拆单**之前**先过订单级 no-show 闸（拆单不可回滚）
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 部分乘客 · 拆单前的订单级闸', () => {
  it('去程还没起飞 + 只勾部分乘客 → 400，splitOrder 一次都没被调用', async () => {
    mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow({
            flightSchedule: {
              departureTime: new Date(Date.now() + 2 * 24 * 3600_000),
              departureTz: 'Asia/Shanghai',
              flight: { flightNumber: 'QH9589' },
            },
          }),
          returnRow(),
          hotelRow,
        ],
      }),
    });
    const split = vi.spyOn(service, 'splitOrder');
    const err = await service
      .markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(String((err as Error).message)).toContain('尚未起飞');
    // 拆单不可回滚：这类「跟选了谁无关」的原因必须在拆之前拦住，不能拆完再说标不了。
    expect(split).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    split.mockRestore();
  });

  it('回程当前已释放 + 只勾部分乘客 → 同样在拆单前被拦下', async () => {
    const releasedAt = new Date().toISOString();
    mountTx({
      snapshot: orderSnapshot({
        items: [
          outboundRow({ metadata: { noShow: { at: releasedAt } } }),
          returnRow({
            flightScheduleId: null,
            flightSchedule: null,
            metadata: { returnReleased: { at: releasedAt } },
          }),
          hotelRow,
        ],
      }),
    });
    const split = vi.spyOn(service, 'splitOrder');
    await expect(
      service.markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(split).not.toHaveBeenCalled();
    split.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 13. 幂等回放的**入参比对**（同 token 换请求体 → 409 TOKEN_PAYLOAD_MISMATCH）
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 回放入参比对', () => {
  it('首刷释放了回程、重试却不勾释放 → 409 TOKEN_PAYLOAD_MISMATCH，不回放成功', async () => {
    const tx = mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            noShow: { at: new Date().toISOString(), requestToken: TOKEN, returnReleased: true },
            legActionLog: [legLog('NO_SHOW', TOKEN, { fingerprint: noShowFp(true) })],
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const err = await service
      .markNoShow('ord-1', noShowBody({ releaseReturn: false }), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'PAYLOAD', priorType: 'NO_SHOW' });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('入参一致 → 照常回放（比对不误伤正常重试）', async () => {
    mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            noShow: { at: new Date().toISOString(), requestToken: TOKEN, returnReleased: true },
            legActionLog: [legLog('NO_SHOW', TOKEN, { fingerprint: noShowFp(true) })],
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const res = await service.markNoShow('ord-1', noShowBody({ releaseReturn: true }), ADMIN);
    expect(res.audit.replayed).toBe(true);
  });

  it('同 token 换了另一批乘客名单（整单 → 指定两人）→ 409，指纹认得出来', async () => {
    const tx = mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            noShow: { at: new Date().toISOString(), requestToken: TOKEN },
            // 首刷是整单（passengerIds 为空）。
            legActionLog: [legLog('NO_SHOW', TOKEN, { fingerprint: noShowFp(true, []) })],
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    // 这次勾了全员两人 —— markNoShow 判成整单不走拆单，直接进 _executeNoShow 的回放守闸。
    const err = await service
      .markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1', 'pax-2'] }), ADMIN)
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'PAYLOAD' });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('同一批乘客顺序不同 → 指纹一致，照常回放（排序后比对）', async () => {
    mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            noShow: { at: new Date().toISOString(), requestToken: TOKEN },
            legActionLog: [
              legLog('NO_SHOW', TOKEN, { fingerprint: noShowFp(true, ['pax-1', 'pax-2']) }),
            ],
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const res = await service.markNoShow(
      'ord-1',
      noShowBody({ passengerIds: ['pax-2', 'pax-1'] }),
      ADMIN,
    );
    expect(res.audit.replayed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 13b. 回放守闸：**动作类型**必须对得上 + 旧快照 fail-closed
//
// requestToken 由前端生成，同一个 token 拿去调另一个端点是完全可能的（页面里复用了同一个
// 编号、或运营连点了两个按钮）。只按「见过这个 token」就回放，会让运营看到一条「成功」，
// 而这次的动作压根没发生 —— 座位/钱早按上一次那个动作处置完了，审计里一个字都查不到。
// 老数据（本次改动之前落库的行）没有指纹，一律拒：宁可让人换个新编号重新预检一遍。
// ══════════════════════════════════════════════════════════════════════════
describe('no-show / 恢复 · 回放守闸的动作类型与旧快照', () => {
  it('token 是恢复回程用过的，拿来标 no-show → 409（类型不符）', async () => {
    const tx = mountTx({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: { legActionLog: [legLog('RESTORE', TOKEN)] } },
      ],
    });
    const err = await service.markNoShow('ord-1', noShowBody(), ADMIN).catch((e: unknown) => e);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({
      reason: 'ACTION_TYPE',
      priorType: 'RESTORE',
    });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('token 是取消航段用过的，拿去恢复回程 → 409（类型不符），一座不动', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      seatClass: { capacity: 180, sold: 0 },
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: { legActionLog: [legLog('CANCEL_LEG', TOKEN)] } },
      ],
    });
    const err = await service
      .restoreReturnLeg('ord-1', restoreBody(), ADMIN)
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({
      reason: 'ACTION_TYPE',
      priorType: 'CANCEL_LEG',
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('旧快照（只有 noShow.requestToken、没有流水指纹）→ 409 fail-closed，不再按老入参回成功', async () => {
    const tx = mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: { noShow: { at: new Date().toISOString(), requestToken: TOKEN } },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const err = await service.markNoShow('ord-1', noShowBody(), ADMIN).catch((e: unknown) => e);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'LEGACY_SNAPSHOT' });
    expect(String((err as AppError).message)).toContain('重新预检');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('旧快照（只有 returnRestored.requestToken）拿去恢复回程 → 同样 409 fail-closed', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      seatClass: { capacity: 180, sold: 0 },
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: { returnRestored: { requestToken: TOKEN } } },
      ],
    });
    const err = await service
      .restoreReturnLeg('ord-1', restoreBody(), ADMIN)
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'LEGACY_SNAPSHOT' });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('同 token 换了另一批乘客 → 409 TOKEN_PAYLOAD_MISMATCH，不拿上一轮的新单顶包', async () => {
    mountTx();
    mockPrisma.orderSplitRecord.findUnique.mockResolvedValue({
      snapshot: { movedPassengerIds: ['pax-2'] },
    });
    const split = vi.spyOn(service, 'splitOrder');
    const err = await service
      .markNoShow('ord-1', noShowBody({ passengerIds: ['pax-1'] }), ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ field: 'passengerIds' });
    expect(split).not.toHaveBeenCalled();
    split.mockRestore();
  });

  it('同 token 同一批乘客（顺序不同）→ 不算不一致，照常交给 splitOrder 回放', async () => {
    mountTx();
    mockPrisma.orderSplitRecord.findUnique.mockResolvedValue({
      snapshot: { movedPassengerIds: ['pax-2', 'pax-1'] },
    });
    const split = vi.spyOn(service, 'splitOrder').mockResolvedValue({
      sourceOrderId: 'ord-1',
      sourceOrderNumber: 'FTM20260902-001',
      targetOrderId: 'ord-2',
      targetOrderNumber: 'FTM20260902-002',
      movedShareCny: 4000,
      movedPaidCny: 4000,
      passengerCount: 2,
      replayed: true,
    });
    // 勾了两位里的… 这里源单共 2 人，勾 1 人才会走拆单路径，故用一张 3 人单。
    mockPrisma.order.findUnique.mockResolvedValue(
      orderSnapshot({
        passengers: [
          { id: 'pax-1', fullName: 'A', chineseName: null, pnr: null, eticketNumber: null },
          { id: 'pax-2', fullName: 'B', chineseName: null, pnr: null, eticketNumber: null },
          { id: 'pax-3', fullName: 'C', chineseName: null, pnr: null, eticketNumber: null },
        ],
      }),
    );
    const res = await service.markNoShow(
      'ord-1',
      noShowBody({ passengerIds: ['pax-1', 'pax-2'] }),
      ADMIN,
    );
    expect(split).toHaveBeenCalledTimes(1);
    expect(res.targetOrderId).toBe('ord-2');
    split.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 14. 恢复回程 · 释放快照没有座位明细 / 超售纯 sold-vs-capacity 口径 / 预检提示
// ══════════════════════════════════════════════════════════════════════════
describe('恢复回程 · 释放快照缺座位明细', () => {
  it('releasedSeats 为空数组 → 拒绝恢复（否则会占 0 座变成幽灵持有）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      releasedSnapshotOrder({}, { releasedSeats: [] }),
    );
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('释放快照里没有座位明细');
  });

  it('执行端同样拒绝，且一座不动', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder({}, { releasedSeats: [] }),
      seatClass: { capacity: 180, sold: 0 },
    });
    await expect(
      service.restoreReturnLeg('ord-1', restoreBody(), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });
});

describe('恢复回程 · 超售口径 = 纯 sold vs capacity', () => {
  it('sold 没到 capacity、余位被锁位吃满 → 要确认但 oversoldAfter=0、不触上限', async () => {
    // capacity 180 / sold 100 → 物理上还有 80 个空位，一座都没超卖；
    // 但 100 个 ACTIVE 锁位把 available 压到 -20，本次要占 2 座 → 缺口 22。
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 100 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 100 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.available).toBe(-20);
    // 要拿运营确认（抢的是别人锁着的位子）……
    expect(res.needsOversell).toBe(true);
    // ……但这一班一座都没超卖：新增 0、累计 0，上限自然不触发，仍然 eligible。
    expect(res.oversellBy).toBe(0);
    expect(res.oversoldAfter).toBe(0);
    expect(res.oversellDetail).toEqual([
      { cabin: 'ECONOMY', quantity: 2, before: -80, after: -78, increment: 0 },
    ]);
    expect(res.eligible).toBe(true);
  });

  it('预检回 reservedConflict：本次会挤掉几座他人锁位/占位', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    // capacity 10 / sold 8 → 物理还剩 2 座，但这 2 座正被他人 ACTIVE 锁位占着 → available 0。
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 10, sold: 8 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 2 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.available).toBe(0);
    expect(res.needsOversell).toBe(true);
    // 一座都没超卖 —— 要抢的 2 座全部是别人的软预留。
    expect(res.oversellBy).toBe(0);
    expect(res.oversoldAfter).toBe(0);
    expect(res.reservedConflict).toBe(2);
  });

  it('确认后走超售直加分支（余位不够就不能用 CAS 抢），账面不超卖但**必记** CRITICAL 挤占审计', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      seatClass: { capacity: 180, sold: 100 },
    });
    tx.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 100 } });
    const { audit } = await service.restoreReturnLeg(
      'ord-1',
      restoreBody({ allowOversell: true }),
      ADMIN,
    );
    // 走的是 oversellSeatWithinTx（无条件 sold += qty），但账面上一座没超卖。
    expect(audit.oversold).toBe(false);
    expect(audit.oversoldBy).toBe(0);
    expect(audit.scheduleOversoldAfter).toBe(0);
    // 超售审计不该记（确实没超卖）；但抢的是别人锁着的位子 —— 这一条必须留痕，
    // 否则对面那张锁位单下单失败时，审计里查不到是谁、什么时候、抢了几座。
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = (tx.auditLog.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(arg.data.action).toBe('RESTORE_RETURN_LEG_DISPLACED_RESERVATION');
    expect(arg.data.severity).toBe('CRITICAL');
    expect(arg.data.after).toMatchObject({
      displacedReserved: 2,
      oversold: false,
      oversoldBy: 0,
      displacedDetail: [
        { cabin: 'ECONOMY', quantity: 2, displacedReserved: 2, physicalIncrement: 0 },
      ],
    });
    // 恢复快照里也留一份，事后从订单行就能看出这次挤了谁。
    const retData = updateDataFor(
      tx.orderItem.update.mock.calls as unknown as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >,
      'leg-ret',
    )!;
    expect((retData.metadata as { returnRestored: Record<string, unknown> }).returnRestored)
      .toMatchObject({ displacedReserved: 2 });
  });

  it('真·物理超售时只记一条超售审计，after 里同时带上挤掉的软预留', async () => {
    const tx = mountTx({
      snapshot: releasedSnapshotOrder(),
      // capacity 10 / sold 10 → 已卖满；再占 2 座就是真超卖 2 座。
      seatClass: { capacity: 10, sold: 10 },
    });
    tx.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 1 } });
    const { audit } = await service.restoreReturnLeg(
      'ord-1',
      restoreBody({ allowOversell: true }),
      ADMIN,
    );
    expect(audit.oversold).toBe(true);
    expect(audit.oversoldBy).toBe(2);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = (tx.auditLog.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ])[0];
    expect(arg.data.action).toBe('RESTORE_RETURN_LEG_OVERSOLD');
    expect(arg.data.after).toMatchObject({ oversoldBy: 2, displacedReserved: 1 });
  });
});

describe('恢复回程 · 预检 warnings', () => {
  it('释放时清过开票位 + 派过撤名单工单 → 两条提示都给票务台', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      releasedSnapshotOrder({}, { returnInvoicedAtRelease: true, ticketedAtRelease: 2 }),
    );
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 0 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(true);
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings.join('')).toContain('开票位清成未开');
    expect(res.warnings.join('')).toContain('重新上名单');
  });

  it('释放时既没开票位也没出票 → 一条提示都不给（不制造噪音）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(releasedSnapshotOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    mockPrisma.flightSeatClass.findFirst.mockResolvedValue({ capacity: 180, sold: 0 });
    mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });

    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.warnings).toEqual([]);
  });

  it('释放时回程是已开票态 → 快照记下 returnInvoicedAtRelease（恢复预检才提示得出来）', async () => {
    const tx = mountTx({ snapshot: orderSnapshot({ returnInvoiced: true }) });
    await service.markNoShow('ord-1', noShowBody(), ADMIN);
    const calls = tx.orderItem.update.mock.calls as unknown as Array<
      [{ where: { id: string }; data: Record<string, unknown> }]
    >;
    const meta = updateDataFor(calls, 'leg-ret')!.metadata as Record<string, unknown>;
    expect(meta.returnReleased).toMatchObject({ returnInvoicedAtRelease: true });
  });
});


// ══════════════════════════════════════════════════════════════════════════
// 14. 「勾了人但一个都没勾」（passengerIds: []）
//
// 缺省（不传）才等于整单。传 `[]` 是前端把勾选框全部取消时的形状，把它当成整单
// 就是给全单的人打 no-show 标、把全单的回程座位放回库存 —— 而请求体看上去毫无异常。
// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 空乘客数组不等于整单', () => {
  it('schema 直接拒（执行体与预检体同口径）', () => {
    expect(() =>
      noShowBodySchema.parse({ requestToken: TOKEN, passengerIds: [] }),
    ).toThrow();
  });

  it('绕过 schema 的内部调用也被服务拒（防御式断言），一座不动', async () => {
    const tx = mountTx();
    const err = await service
      .markNoShow(
        'ord-1',
        { requestToken: TOKEN, passengerIds: [], releaseReturn: true } as never,
        ADMIN,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(String((err as Error).message)).toContain('至少选择 1 位乘客');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('预检同样拒', async () => {
    await expect(
      service.previewNoShow('ord-1', { passengerIds: [] }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 15. 回程起飞后作废（终态收口）
//
// 「已释放」不是终态：原班次一飞走，恢复窗口就关了，而这一行还挂在单上、提醒一直在催。
// 作废只打一个终态标：**座位不动、钱不动、开票位不动**。起飞前一律拒。
// ══════════════════════════════════════════════════════════════════════════
describe('回程作废 · 权限与预检', () => {
  /** 已释放 + 原班次已起飞（3 天前）的单。 */
  const departedReleasedOrder = () => releasedSnapshotOrder();
  const armPreview = (departureTime: Date | null) => {
    mockPrisma.order.findUnique.mockResolvedValue(departedReleasedOrder());
    mockPrisma.flightSchedule.findUnique.mockResolvedValue(
      departureTime
        ? {
            id: 'sch-ret',
            departureTime,
            departureTz: 'Asia/Shanghai',
            flight: { flightNumber: 'QH9588' },
          }
        : null,
    );
  };

  it('代理无权作废', async () => {
    await expect(service.previewVoidReturnLeg('ord-1', AGENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.voidReturnLeg('ord-1', voidBody(), AGENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('原班次已起飞 → eligible，original 如实回哪一班', async () => {
    armPreview(OUT_DEPART); // 3 天前
    const res = await service.previewVoidReturnLeg('ord-1', STAFF);
    expect(res.eligible).toBe(true);
    expect(res.blockers).toEqual([]);
    expect(res.departed).toBe(true);
    expect(res.original).toMatchObject({
      orderItemId: 'leg-ret',
      scheduleId: 'sch-ret',
      flightNumber: 'QH9588',
      quantity: 2,
    });
  });

  it('回程还没起飞 → 拒，并把下一步说清楚（去点恢复回程）', async () => {
    armPreview(RET_DEPART); // 7 天后
    const res = await service.previewVoidReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.departed).toBe(false);
    expect(res.blockers.join('')).toContain('回程未起飞，请用恢复回程或等待起飞后作废');
  });

  it('本单没有已释放的回程 → 拒（无事可做）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderSnapshot());
    const res = await service.previewVoidReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('没有被 no-show 释放的回程航段');
  });

  it('已经作废过 → 拒（不重复操作）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      releasedSnapshotOrder({}, {}),
    );
    // 在回程行上补一个终态快照。
    const snap = releasedSnapshotOrder();
    const ret = snap.items.find((it) => it.id === 'leg-ret')!;
    (ret as { metadata: Record<string, unknown> }).metadata = {
      ...(ret.metadata as Record<string, unknown>),
      returnVoidedFinal: { at: new Date().toISOString(), byUserId: 'SYSTEM' },
    };
    mockPrisma.order.findUnique.mockResolvedValue(snap);
    const res = await service.previewVoidReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('已作废');
  });

  it('原班次已被删除 → 放行（恢复回程那条路同样走不通，不放行就永远收不了口）', async () => {
    armPreview(null);
    const res = await service.previewVoidReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(true);
    // 判不出飞没飞，如实回 false，不假装。
    expect(res.departed).toBe(false);
  });
});

describe('回程作废 · 执行', () => {
  const mountVoid = (over: Record<string, unknown> = {}) =>
    mountTx({
      snapshot: releasedSnapshotOrder(),
      // 原班次 3 天前已起飞。
      schedule: { id: 'sch-ret', departureTime: OUT_DEPART },
      ...over,
    });

  it('落终态快照 + 同步物化列 + 关掉两条待办；座位与金额一个字都不写', async () => {
    // flightMeta 是 syncOrderLegFlag 回读行状态的那一份（mock 不持久化写入）：
    // 摆成「已作废」的样子，才验得到物化列真的落到 RETURN_VOIDED。
    // 这里刻意不带 requestToken —— 带了就会命中回放分支，本用例要测的是首刷。
    const tx = mountVoid({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        {
          id: 'leg-ret',
          kind: 'FLIGHT',
          flightScheduleId: null,
          metadata: { returnVoidedFinal: { at: new Date().toISOString() } },
        },
      ],
    });
    const { audit } = await service.voidReturnLeg('ord-1', voidBody({ note: '客人确认不飞' }), ADMIN);
    expect(audit.replayed).toBe(false);
    expect(audit.returnItemId).toBe('leg-ret');

    const data = updateDataFor(
      tx.orderItem.update.mock.calls as unknown as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >,
      'leg-ret',
    )!;
    const meta = data.metadata as Record<string, unknown>;
    expect(meta.returnVoidedFinal).toMatchObject({
      byUserId: 'admin-1',
      requestToken: TOKEN,
      note: '客人确认不飞',
    });
    expect((meta.legActionLog as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'VOID',
      requestToken: TOKEN,
      fingerprint: EMPTY_FP,
    });
    // 释放快照保留（历史全留着才查得清）。
    expect(meta.returnReleased).toBeTruthy();
    // 钱与座位一个都不动。
    for (const key of ['unitPrice', 'amount', 'unitCostCny', 'totalCostCny', 'flightScheduleId']) {
      expect(data).not.toHaveProperty(key);
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();

    // 两条「回程已释放」待办一起收口（原 key + :DEPARTED）。
    expect(tx.operationalReminder.updateMany).toHaveBeenCalledTimes(1);
    const remArgs = (tx.operationalReminder.updateMany.mock.calls[0] as unknown as [
      { where: { ruleKey: { in: string[] } }; data: { status: string } },
    ])[0];
    expect(remArgs.where.ruleKey.in).toEqual([
      `NOSHOW_RELEASED:leg-ret:${RELEASED_SNAPSHOT.at}`,
      `NOSHOW_RELEASED:leg-ret:${RELEASED_SNAPSHOT.at}:DEPARTED`,
    ]);
    expect(remArgs.data.status).toBe('DONE');

    // 订单上：物化列同步 + 0 元留痕，subtotal/total 不写。
    const orderUpdates = tx.order.update.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(orderUpdates.some((d) => d.legFlag === 'RETURN_VOIDED')).toBe(true);
    for (const d of orderUpdates) {
      expect(d).not.toHaveProperty('subtotal');
      expect(d).not.toHaveProperty('total');
    }
    const adj = orderUpdates.find((d) => d.adjustments != null)!.adjustments as Array<
      Record<string, unknown>
    >;
    expect(adj[adj.length - 1]).toMatchObject({ type: 'RETURN_LEG_VOIDED', amountCny: 0 });
  });

  it('回程还没起飞 → 400，一个字都不写', async () => {
    const tx = mountVoid({ schedule: { id: 'sch-ret', departureTime: RET_DEPART } });
    await expect(
      service.voidReturnLeg('ord-1', voidBody(), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('同 token 重试 → 回放，不重复写快照、不重复关待办', async () => {
    const tx = mountVoid({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        {
          id: 'leg-ret',
          metadata: {
            returnVoidedFinal: { at: new Date().toISOString(), requestToken: TOKEN },
            legActionLog: [legLog('VOID', TOKEN)],
          },
        },
      ],
    });
    const { audit } = await service.voidReturnLeg('ord-1', voidBody(), ADMIN);
    expect(audit.replayed).toBe(true);
    expect(audit.returnItemId).toBe('leg-ret');
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.operationalReminder.updateMany).not.toHaveBeenCalled();
  });

  it('token 是恢复回程用过的，拿来作废 → 409（类型不符）', async () => {
    const tx = mountVoid({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        { id: 'leg-ret', metadata: { legActionLog: [legLog('RESTORE', TOKEN)] } },
      ],
    });
    const err = await service.voidReturnLeg('ord-1', voidBody(), ADMIN).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'ACTION_TYPE' });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('作废之后恢复回程被拒（终态不可逆）', async () => {
    const snap = releasedSnapshotOrder();
    const ret = snap.items.find((it) => it.id === 'leg-ret')!;
    (ret as { metadata: Record<string, unknown> }).metadata = {
      ...(ret.metadata as Record<string, unknown>),
      returnVoidedFinal: { at: new Date().toISOString(), byUserId: 'SYSTEM' },
    };
    mockPrisma.order.findUnique.mockResolvedValue(snap);
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    });
    const res = await service.previewRestoreReturnLeg('ord-1', ADMIN);
    expect(res.eligible).toBe(false);
    expect(res.blockers.join('')).toContain('已过期作废');
  });
});
