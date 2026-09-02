/**
 * 取消航段（partial cancellation）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖运营诉求「客人只飞其中一段，另一段放回给系统继续销售」的全部硬口径。
 * 第 1–8 组是取消回程（leg=RETURN，老路径 /cancel-return-leg 同义），
 * 第 9 组是镜像的取消去程（leg=OUTBOUND，客人去程 noshow 只留回程）+ 请求体契约。
 *
 * 取消回程部分：
 *   1. 权限：仅 ADMIN/STAFF。
 *   2. 准入闸一次性全列（单程 / 回程已开票 / 已出票 / 结算价锁 / 收款复核锁 / 退款中）。
 *   3. POLICY 模式手续费 = 取消政策引擎（lib/cancellation）对**回程行**的报价，
 *      订单总额 = 原总额 − (回程行金额 − 手续费)。
 *   4. MANUAL 模式：缺原因/缺金额被 schema 拒；超过回程行金额被服务拒；正常覆盖成功。
 *   5. 座位释放参数正确（含套餐升舱拆座镜像：商务/经济各退各舱）。
 *   6. hasReturnLeg 物化列回落 false；回程行作废保留（班次置空、金额归零、快照留痕）。
 *   7. 幂等：同 requestToken 重放不二次放座、不二次收手续费。
 *   8. 套餐单可取消回程，BUNDLE 行分毫不动。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    fulfillmentTask: { count: vi.fn(), updateMany: vi.fn() },
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
import {
  cancelLegBodySchema,
  cancelLegPreviewBodySchema,
  cancelReturnLegBodySchema,
} from './orders.schemas.js';
import { AppError, BadRequestError, ForbiddenError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT } as const;
const TOKEN = '00000000-0000-4000-8000-0000000cafe1';

// 取消航段的入参指纹（键排序后 JSON）。**写死字面量**，不从 service import 那个函数：
// 它是落库的持久化契约，格式一改这里就该红，跟着实现走就永远测不出静默漂移。
const cancelLegFp = (
  over: Partial<{ leg: string; feeMode: string; manualFeeCny: number | null; overrideReason: string | null }> = {},
): string =>
  JSON.stringify({
    feeMode: 'POLICY',
    leg: 'RETURN',
    manualFeeCny: null,
    overrideReason: null,
    ...over,
  });

/** 一条 CANCEL_LEG 流水（回放守闸认的就是它的 type 与 fingerprint）。 */
const cancelLegLog = (requestToken: string, fingerprint = cancelLegFp()) => ({
  type: 'CANCEL_LEG' as const,
  requestToken,
  at: new Date().toISOString(),
  byUserId: 'admin-1',
  fingerprint,
});

// 现在起 10 天后出发 → 稳稳落在「>=72h」档（20% 手续费），不受跑测时刻影响。
const OUT_DEPART = new Date(Date.now() + 10 * 24 * 3600_000);
const RET_DEPART = new Date(Date.now() + 15 * 24 * 3600_000);

/** 一条 20%/100% 两档的机票默认取消政策（引擎按真算，不 mock lib/cancellation）。 */
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

const OUT_AMOUNT = 3000;
const RET_AMOUNT = 3000;
const HOTEL_AMOUNT = 2000;
const TOTAL_BEFORE = OUT_AMOUNT + RET_AMOUNT + HOTEL_AMOUNT; // 8000

function flightRow(over: Record<string, unknown> = {}) {
  return {
    id: 'leg-ret',
    kind: OrderItemKind.FLIGHT,
    description: '机票 QH9588 经济舱 × 2',
    quantity: 2,
    amount: new Prisma.Decimal(RET_AMOUNT),
    flightCabin: 'ECONOMY',
    flightScheduleId: 'sch-ret',
    metadata: null,
    flightSchedule: {
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    },
    ...over,
  };
}

/** 订单快照（loadOrderForReturnLegCancel 的 select 形状）。 */
function orderSnapshot(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    orderNumber: 'FTM20260901-001',
    status: 'PAID',
    deletedAt: null,
    subtotal: new Prisma.Decimal(TOTAL_BEFORE),
    total: new Prisma.Decimal(TOTAL_BEFORE),
    paidAmount: new Prisma.Decimal(TOTAL_BEFORE),
    adjustmentCny: 0,
    adjustments: [],
    outboundInvoiced: false,
    returnInvoiced: false,
    systemInvoiced: false,
    settlementLocked: false,
    paymentsLocked: false,
    items: [
      {
        id: 'leg-out',
        kind: OrderItemKind.FLIGHT,
        description: '机票 QH9589 经济舱 × 2',
        quantity: 2,
        amount: new Prisma.Decimal(OUT_AMOUNT),
        flightCabin: 'ECONOMY',
        flightScheduleId: 'sch-out',
        metadata: null,
        flightSchedule: {
          departureTime: OUT_DEPART,
          departureTz: 'Asia/Shanghai',
          flight: { flightNumber: 'QH9589' },
        },
      },
      flightRow(),
      {
        id: 'hotel-1',
        kind: OrderItemKind.HOTEL,
        description: '酒店 2 晚',
        quantity: 2,
        amount: new Prisma.Decimal(HOTEL_AMOUNT),
        flightCabin: null,
        flightScheduleId: null,
        metadata: null,
        flightSchedule: null,
      },
    ],
    passengers: [
      { pnr: null, eticketNumber: null },
      { pnr: null, eticketNumber: null },
    ],
    ...over,
  };
}

/** 序列化用的最小订单（回读时用，避免 serializeOrder 抛错吞掉 audit）。 */
const serializableOrder = () => ({
  id: 'ord-1',
  orderNumber: 'FTM20260901-001',
  status: 'PAID',
  subtotal: new Prisma.Decimal(5600),
  taxesAndFees: new Prisma.Decimal(0),
  discountTotal: new Prisma.Decimal(0),
  total: new Prisma.Decimal(5600),
  paidAmount: new Prisma.Decimal(TOTAL_BEFORE),
  prepaymentOffset: new Prisma.Decimal(0),
  adjustmentCny: 0,
  items: [],
  passengers: [],
  payments: [],
});

/**
 * 事务客户端 mock。orderItem.findMany 按 where 分流：
 *   带 flightScheduleId 条件 = syncOrderHasReturnLeg 的自愈查询（取消后只剩去程）；
 *   不带 = 幂等回放扫描（全部 FLIGHT 行 + metadata）。
 */
function mountTx(
  opts: {
    snapshot?: ReturnType<typeof orderSnapshot>;
    flightMeta?: unknown[];
    /** 被取消的那一段（默认回程 leg-ret；取消去程用 leg-out）。 */
    targetId?: string;
  } = {},
) {
  const snapshot = opts.snapshot ?? orderSnapshot();
  const targetId = opts.targetId ?? 'leg-ret';
  const targetDepart = targetId === 'leg-out' ? OUT_DEPART : RET_DEPART;
  // syncOrderHasReturnLeg 的自愈查询只看得到「还带班次」的行 = 取消后幸存的那一段。
  const survivor =
    targetId === 'leg-out'
      ? { flightScheduleId: 'sch-ret', flightSchedule: { departureTime: RET_DEPART, departureTz: 'Asia/Shanghai' } }
      : { flightScheduleId: 'sch-out', flightSchedule: { departureTime: OUT_DEPART, departureTz: 'Asia/Shanghai' } };
  const flightMeta =
    opts.flightMeta ??
    [
      { id: 'leg-out', metadata: null },
      { id: 'leg-ret', metadata: null },
    ];
  const returnItem = snapshot.items.find((it) => it.id === targetId);
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
        args?.where?.flightScheduleId !== undefined ? [survivor] : flightMeta,
      ),
      findUnique: vi.fn(async () => ({
        ...returnItem,
        fulfillmentTasks: [],
        flightSchedule: { departureTime: targetDepart },
      })),
      update: vi.fn(async () => ({})),
      create: vi.fn(async () => ({ id: 'fee-1' })),
    },
    fulfillmentTask: { count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({ count: 1 })) },
    refund: { count: vi.fn(async () => 0) },
    cancellationPolicy: { findMany: vi.fn(async () => [FLIGHT_POLICY]) },
    // 手工覆盖手续费的 CRITICAL 审计写在**同一事务**里（与改金额同生共死），
    // 所以事务 mock 必须带 auditLog —— 路由层那条 fire-and-forget 的只记 POLICY 档。
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(serializableOrder());
  return tx;
}

/** preview 走裸 prisma（非事务），单独装配。targetId 指定被取消的那一段。 */
function mountPreview(snapshot = orderSnapshot(), targetId = 'leg-ret') {
  const returnItem = snapshot.items.find((it) => it.id === targetId);
  const targetDepart = targetId === 'leg-out' ? OUT_DEPART : RET_DEPART;
  mockPrisma.order.findUnique.mockResolvedValue(snapshot);
  mockPrisma.fulfillmentTask.count.mockResolvedValue(0);
  mockPrisma.refund.count.mockResolvedValue(0);
  mockPrisma.cancellationPolicy.findMany.mockResolvedValue([FLIGHT_POLICY]);
  mockPrisma.orderItem.findUnique.mockResolvedValue(
    returnItem
      ? { ...returnItem, fulfillmentTasks: [], flightSchedule: { departureTime: targetDepart } }
      : null,
  );
}

const body = (over: Record<string, unknown> = {}) => ({
  requestToken: TOKEN,
  feeMode: 'POLICY' as const,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// 1. 权限
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · 权限', () => {
  it('代理不能预检取消回程（且不触库）', async () => {
    await expect(service.previewCancelReturnLeg('ord-1', AGENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('代理不能执行取消回程（且不开事务）', async () => {
    await expect(service.cancelReturnLeg('ord-1', body(), AGENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('运营（STAFF）可以预检', async () => {
    mountPreview();
    const res = await service.previewCancelReturnLeg('ord-1', STAFF);
    expect(res.eligible).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 准入闸
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · 准入闸', () => {
  it('单程单：预检给出「本单是单程」，执行被拒且不放座', async () => {
    const oneWay = orderSnapshot({
      items: orderSnapshot().items.filter((it) => it.id !== 'leg-ret'),
    });
    mountPreview(oneWay);
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('单程');
    expect(preview.returnItem).toBeNull();

    const tx = mountTx({ snapshot: oneWay, flightMeta: [{ id: 'leg-out', metadata: null }] });
    await expect(service.cancelReturnLeg('ord-1', body(), ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('回程已开票 → 拒绝，并指到票务台改回未开', async () => {
    mountPreview(orderSnapshot({ returnInvoiced: true }));
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('回程已开票');
    expect(preview.blockers.join('')).toContain('票务台');
  });

  // 闸 8 修复：整单级的「乘客有 PNR/票号」不再参与判定 —— 那是订单维度的，
  // 去程出了票会把回程一并判成已出票，回程明明一张票都没开也被挡住。
  it('乘客有票号但回程没有确认出票记录 → 不挡取消回程，只留一条不需回执的提示', async () => {
    mountPreview(
      orderSnapshot({
        passengers: [
          { pnr: 'ABC123', eticketNumber: '880-1234567890' },
          { pnr: null, eticketNumber: null },
        ],
      }),
    );
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(true);
    // 判定仍只信航段级出票任务（订单级会把去程的票算到回程头上），但「这单出过票」是客观事实，
    // 至少提醒一句；它不进 requiresAcknowledgement，不逼运营勾回执。
    expect(preview.warnings.join('')).toContain('本单乘客已有 PNR/票号');
    expect(preview.requiresAcknowledgement).toBe(false);
  });

  it('只有订单级票号的提示不逼回执：不带 acknowledgeWarnings 也能直接执行', async () => {
    const snapshot = orderSnapshot({
      passengers: [
        { pnr: 'ABC123', eticketNumber: '880-1234567890' },
        { pnr: null, eticketNumber: null },
      ],
    });
    const tx = mountTx({ snapshot });
    await expect(
      service.cancelReturnLeg('ord-1', body(), ADMIN),
    ).resolves.toBeTruthy();
    expect(tx.orderItem.update).toHaveBeenCalled();
  });

  // ── H4：no-show 与取消航段的边界（钱不动 vs 按政策退钱，绝不能互相串门）──
  it('该段已起飞 → 拒绝取消航段，指路 no-show', async () => {
    const flownOut = new Date(Date.now() - 20 * 24 * 3600_000);
    const flownRet = new Date(Date.now() - 5 * 24 * 3600_000);
    const snapshot = orderSnapshot();
    snapshot.items = snapshot.items.map((it) =>
      it.id === 'leg-out'
        ? { ...it, flightSchedule: { ...it.flightSchedule!, departureTime: flownOut } }
        : it.id === 'leg-ret'
          ? { ...it, flightSchedule: { ...it.flightSchedule!, departureTime: flownRet } }
          : it,
    ) as typeof snapshot.items;
    mountPreview(snapshot);
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('回程已起飞');
    expect(preview.blockers.join('')).toContain('no-show');
  });

  it('该段已标 no-show → 拒绝取消航段（钱已明确不退，不能再从取消通道退一次）', async () => {
    const snapshot = orderSnapshot();
    snapshot.items = snapshot.items.map((it) =>
      it.id === 'leg-ret' ? { ...it, metadata: { noShow: { at: new Date().toISOString() } } } : it,
    ) as typeof snapshot.items;
    mountPreview(snapshot);
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('已标记 no-show');
  });

  it('执行段同样挡住已标 no-show 的段（预检放行到执行之间世界变了也拦得住）', async () => {
    const snapshot = orderSnapshot();
    snapshot.items = snapshot.items.map((it) =>
      it.id === 'leg-ret' ? { ...it, metadata: { noShow: { at: new Date().toISOString() } } } : it,
    ) as typeof snapshot.items;
    const tx = mountTx({ snapshot });
    await expect(service.cancelReturnLeg('ord-1', body(), ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('回程有确认出票任务 → 不再拒绝，改为 warning + 需二次确认', async () => {
    mountPreview();
    mockPrisma.fulfillmentTask.count.mockResolvedValue(2);
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.requiresAcknowledgement).toBe(true);
    expect(preview.warnings.join('')).toContain('回程已出票（2 人有确认出票记录）');
    expect(preview.warnings.join('')).toContain('撤名单/退票工单');
  });

  it('结算价锁 / 收款复核锁 → 两条闸各自成条列出（不是命中一条就停）', async () => {
    mountPreview(orderSnapshot({ settlementLocked: true, paymentsLocked: true }));
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.some((b) => b.includes('结算价已锁定'))).toBe(true);
    expect(preview.blockers.some((b) => b.includes('收款已复核锁定'))).toBe(true);
  });

  it('进行中的退款 → 拒绝', async () => {
    mountPreview();
    mockPrisma.refund.count.mockResolvedValue(1);
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.blockers.join('')).toContain('进行中的退款');
  });

  it('已取消的死单 → 拒绝（座位早已释放，再放会把库存账打乱）', async () => {
    mountPreview(orderSnapshot({ status: 'CANCELLED' }));
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('不可取消回程');
  });

  it('回收站单 → 拒绝', async () => {
    mountPreview(orderSnapshot({ deletedAt: new Date() }));
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.blockers.join('')).toContain('回收站');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. POLICY 模式：手续费与总额
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · POLICY 模式手续费', () => {
  it('预检按取消政策报价：¥3000 的回程行 × 20% = ¥600，应收降 ¥2400', async () => {
    mountPreview();
    const preview = await service.previewCancelReturnLeg('ord-1', ADMIN);
    expect(preview.policyFee).toMatchObject({
      policyName: '机票默认取消政策',
      feePercent: 20,
      feeAmountCny: 600,
    });
    expect(preview.netReductionCny).toBe(2400);
    expect(preview.currentTotalCny).toBe(TOTAL_BEFORE);
    // 已收 8000、取消后应收 5600 → 多收 2400（由既有多付/退款流程处置，本端点不打款）
    expect(preview.overpayAfterCny).toBe(2400);
    expect(preview.returnItem).toMatchObject({
      orderItemId: 'leg-ret',
      flightNumber: 'QH9588',
      cabin: 'ECONOMY',
      quantity: 2,
      amountCny: RET_AMOUNT,
    });
  });

  it('执行后订单总额 = 原总额 − (回程行金额 − 手续费)，手续费落一条调价行', async () => {
    const tx = mountTx();
    const { audit } = await service.cancelReturnLeg('ord-1', body(), ADMIN);

    expect(audit.feeMode).toBe('POLICY');
    expect(audit.feeCny).toBe(600);
    expect(audit.originalAmountCny).toBe(RET_AMOUNT);
    expect(audit.netReductionCny).toBe(2400);
    expect(audit.totalBefore).toBe(TOTAL_BEFORE);
    expect(audit.totalAfter).toBe(5600);
    expect(audit.overpayAfterCny).toBe(2400);
    expect(audit.replayed).toBe(false);

    // 手续费调价行：正金额 → FEE，原因码是 endpoint-only 的 RETURN_LEG_CANCEL_FEE
    const feeCall = tx.orderItem.create.mock.calls[0][0];
    expect(feeCall.data.kind).toBe(OrderItemKind.FEE);
    expect(feeCall.data.amount).toEqual(new Prisma.Decimal(600));
    expect(feeCall.data.description).toContain('取消回程手续费');
    expect(feeCall.data.metadata).toMatchObject({
      priceAdjustment: true,
      reasonCode: 'RETURN_LEG_CANCEL_FEE',
      returnLegCancelFee: true,
    });

    // 订单总额重算：8000 − 3000 + 600 = 5600
    const totalUpdate = tx.order.update.mock.calls.find(
      (c: [{ data: Record<string, unknown> }]) => c[0].data.total !== undefined,
    );
    expect(totalUpdate?.[0].data).toMatchObject({
      subtotal: new Prisma.Decimal(5600),
      total: new Prisma.Decimal(5600),
      returnInvoiced: false,
    });
  });

  it('手续费为 0 时不生成空调价行（政策免费退档）', async () => {
    const tx = mountTx();
    tx.cancellationPolicy.findMany.mockResolvedValue([
      { ...FLIGHT_POLICY, tiers: [{ hoursBeforeDeparture: 72, feePercent: 0 }] },
    ]);
    const { audit } = await service.cancelReturnLeg('ord-1', body(), ADMIN);
    expect(audit.feeCny).toBe(0);
    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(audit.totalAfter).toBe(TOTAL_BEFORE - RET_AMOUNT);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. MANUAL 模式
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · MANUAL 手工覆盖', () => {
  it('手工模式缺原因 → schema 拒收', () => {
    const parsed = cancelReturnLegBodySchema.safeParse({
      requestToken: TOKEN,
      feeMode: 'MANUAL',
      manualFeeCny: 500,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('必须填写原因');
  });

  it('手工模式缺金额 → schema 拒收', () => {
    const parsed = cancelReturnLegBodySchema.safeParse({
      requestToken: TOKEN,
      feeMode: 'MANUAL',
      overrideReason: '航司特批',
    });
    expect(parsed.success).toBe(false);
  });

  it('手工金额超过回程行金额 → 400，且座位未被释放（整事务不成立）', async () => {
    const tx = mountTx();
    await expect(
      service.cancelReturnLeg(
        'ord-1',
        body({ feeMode: 'MANUAL', manualFeeCny: RET_AMOUNT + 1, overrideReason: '航司特批' }),
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('正常手工覆盖：调价行按手工金额，原因只进快照不进行描述', async () => {
    const tx = mountTx();
    const { audit } = await service.cancelReturnLeg(
      'ord-1',
      body({ feeMode: 'MANUAL', manualFeeCny: 100, overrideReason: '航司特批全免大部分退改费' }),
      ADMIN,
    );
    expect(audit.feeMode).toBe('MANUAL');
    expect(audit.feeCny).toBe(100);
    expect(audit.totalAfter).toBe(TOTAL_BEFORE - RET_AMOUNT + 100);

    const feeCall = tx.orderItem.create.mock.calls[0][0];
    expect(feeCall.data.amount).toEqual(new Prisma.Decimal(100));
    // 覆盖原因是内部口径：只进 metadata 快照与审计，不进客户可见的行描述
    expect(feeCall.data.description).not.toContain('航司特批全免大部分退改费');
    expect(feeCall.data.description).toContain('手工核定');

    const snapshot = tx.orderItem.update.mock.calls[0][0].data.metadata.returnLegCancelled;
    expect(snapshot.feeMode).toBe('MANUAL');
    expect(snapshot.overrideReason).toBe('航司特批全免大部分退改费');
    // 政策报价照旧留档，供事后复核「手工覆盖了多少」
    expect(snapshot.policySnapshot).toMatchObject({ feePercent: 20, feeAmountCny: 600 });
  });

  it('手工覆盖的 CRITICAL 审计与改金额**同一事务**（路由层那条 fire-and-forget 靠不住）', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg(
      'ord-1',
      body({ feeMode: 'MANUAL', manualFeeCny: 100, overrideReason: '航司特批全免大部分退改费' }),
      ADMIN,
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const arg = tx.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(arg.data.action).toBe('CANCEL_RETURN_LEG');
    expect(arg.data.severity).toBe('CRITICAL');
    expect(arg.data.after).toMatchObject({
      feeMode: 'MANUAL',
      manualFeeCny: 100,
      overrideReason: '航司特批全免大部分退改费',
      policyFeeCny: 600,
      totalBefore: TOTAL_BEFORE,
      totalAfter: TOTAL_BEFORE - RET_AMOUNT + 100,
    });
  });

  it('按政策走（POLICY）不在事务内写审计 —— 那一档由路由层记 WARNING', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4b. 回放守闸：动作类型 / 入参指纹 / 旧快照
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · 回放守闸', () => {
  it('同 token 换了手续费口径（POLICY → MANUAL）→ 409，不按上一次的钱回成功', async () => {
    const tx = mountTx({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        {
          id: 'leg-ret',
          metadata: {
            returnLegCancelled: { requestToken: TOKEN, feeCny: 600, feeMode: 'POLICY' },
            legActionLog: [cancelLegLog(TOKEN)],
          },
        },
      ],
    });
    const err = await service
      .cancelReturnLeg(
        'ord-1',
        body({ feeMode: 'MANUAL', manualFeeCny: 0, overrideReason: '航司特批' }),
        ADMIN,
      )
      .catch((e: unknown) => e);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'PAYLOAD' });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('token 是 no-show 用过的，拿来取消回程 → 409（类型不符），一座不动', async () => {
    const tx = mountTx({
      flightMeta: [
        {
          id: 'leg-out',
          metadata: {
            legActionLog: [
              {
                type: 'NO_SHOW',
                requestToken: TOKEN,
                at: new Date().toISOString(),
                byUserId: 'admin-1',
                fingerprint: '{"passengerIds":[],"releaseReturn":true}',
              },
            ],
          },
        },
        { id: 'leg-ret', metadata: null },
      ],
    });
    const err = await service.cancelReturnLeg('ord-1', body(), ADMIN).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({
      reason: 'ACTION_TYPE',
      priorType: 'NO_SHOW',
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('旧快照（只有 returnLegCancelled、没有流水指纹）→ 409 fail-closed', async () => {
    const tx = mountTx({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        {
          id: 'leg-ret',
          metadata: { returnLegCancelled: { requestToken: TOKEN, feeCny: 600, feeMode: 'POLICY' } },
        },
      ],
    });
    const err = await service.cancelReturnLeg('ord-1', body(), ADMIN).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('TOKEN_PAYLOAD_MISMATCH');
    expect((err as AppError).details).toMatchObject({ reason: 'LEGACY_SNAPSHOT' });
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('作废快照里也追了一条 CANCEL_LEG 流水（带类型与指纹）', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    const meta = tx.orderItem.update.mock.calls[0][0].data.metadata as {
      legActionLog: Array<Record<string, unknown>>;
    };
    expect(meta.legActionLog).toHaveLength(1);
    expect(meta.legActionLog[0]).toMatchObject({
      type: 'CANCEL_LEG',
      requestToken: TOKEN,
      fingerprint: cancelLegFp(),
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. 座位释放 / 6. 作废保留与 hasReturnLeg
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · 座位与航段', () => {
  it('普通经济舱回程：只放经济舱，张数 = 该行人数', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    // releaseSeatFloored 的 tagged template 值序：[qty, scheduleId, cabin]；qty<=0 直接跳过
    const releases = tx.$executeRaw.mock.calls.map((c: unknown[]) => c.slice(1));
    expect(releases).toEqual([[2, 'sch-ret', 'ECONOMY']]);
  });

  it('套餐升舱拆座：商务 1 + 经济 1 各退各舱（与下单时的拆座镜像一致）', async () => {
    const snapshot = orderSnapshot();
    const ret = snapshot.items.find((it) => it.id === 'leg-ret')!;
    ret.metadata = { businessUpgradeCount: 1 };
    const tx = mountTx({ snapshot });
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    const releases = tx.$executeRaw.mock.calls.map((c: unknown[]) => c.slice(1));
    expect(releases).toEqual([
      [1, 'sch-ret', 'BUSINESS'],
      [1, 'sch-ret', 'ECONOMY'],
    ]);
  });

  it('回程行作废保留：班次置空、金额与成本归零、描述打标、快照留痕', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    const data = tx.orderItem.update.mock.calls[0][0].data;
    expect(data.flightScheduleId).toBeNull();
    expect(data.amount).toEqual(new Prisma.Decimal(0));
    expect(data.unitPrice).toEqual(new Prisma.Decimal(0));
    expect(data.totalCostCny).toEqual(new Prisma.Decimal(0));
    expect(data.description).toContain('已取消回程');
    expect(data.metadata.returnLegCancelled).toMatchObject({
      requestToken: TOKEN,
      originalScheduleId: 'sch-ret',
      originalAmountCny: RET_AMOUNT,
      feeCny: 600,
      byUserId: 'admin-1',
    });
  });

  it('回程票务任务终态化（只动仍活着的任务）', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    expect(tx.fulfillmentTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orderItemId: 'leg-ret' }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
  });

  it('hasReturnLeg 物化列回落 false（取消后只剩去程一段）', async () => {
    const tx = mountTx();
    await service.cancelReturnLeg('ord-1', body(), ADMIN);
    const legUpdate = tx.order.update.mock.calls.find(
      (c: [{ data: Record<string, unknown> }]) => c[0].data.hasReturnLeg !== undefined,
    );
    expect(legUpdate?.[0].data).toEqual({ hasReturnLeg: false });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. 幂等
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · 幂等', () => {
  it('同 requestToken 重放：不二次放座、不二次收手续费，原样回放结果', async () => {
    const tx = mountTx({
      flightMeta: [
        { id: 'leg-out', metadata: null },
        {
          id: 'leg-ret',
          metadata: {
            returnLegCancelled: {
              requestToken: TOKEN,
              originalAmountCny: RET_AMOUNT,
              feeCny: 600,
              feeMode: 'POLICY',
              policyName: '机票默认取消政策',
              totalBeforeCny: TOTAL_BEFORE,
              releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
            },
            legActionLog: [cancelLegLog(TOKEN)],
          },
        },
      ],
    });
    tx.order.findUniqueOrThrow.mockResolvedValue({
      orderNumber: 'FTM20260901-001',
      total: new Prisma.Decimal(5600),
      paidAmount: new Prisma.Decimal(TOTAL_BEFORE),
    });

    const { audit } = await service.cancelReturnLeg('ord-1', body(), ADMIN);

    expect(audit.replayed).toBe(true);
    expect(audit.feeCny).toBe(600);
    expect(audit.netReductionCny).toBe(2400);
    expect(audit.totalAfter).toBe(5600);
    expect(audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
    // 一分座位都不许再放，一条行都不许再改
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. 套餐单
// ══════════════════════════════════════════════════════════════════════════
describe('取消回程 · 套餐单', () => {
  it('套餐单可取消回程：只作废回程 FLIGHT 行，BUNDLE 行分毫不动', async () => {
    const base = orderSnapshot();
    const snapshot = orderSnapshot({
      items: [
        ...base.items,
        {
          id: 'bundle-1',
          kind: OrderItemKind.BUNDLE,
          description: '海岛 5 日套餐 × 2',
          quantity: 2,
          amount: new Prisma.Decimal(4000),
          flightCabin: null,
          flightScheduleId: null,
          metadata: null,
          flightSchedule: null,
        },
      ],
      total: new Prisma.Decimal(TOTAL_BEFORE + 4000),
      subtotal: new Prisma.Decimal(TOTAL_BEFORE + 4000),
      paidAmount: new Prisma.Decimal(TOTAL_BEFORE + 4000),
    });
    const tx = mountTx({ snapshot });

    const { audit } = await service.cancelReturnLeg('ord-1', body(), ADMIN);

    // 只改了回程那一行
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.update.mock.calls[0][0].where).toEqual({ id: 'leg-ret' });
    // 12000 − 3000 + 600 = 9600
    expect(audit.totalAfter).toBe(9600);
    expect(audit.releasedSeats).toEqual([
      { scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. 取消去程（leg=OUTBOUND）：与取消回程完全镜像的另一半
//    场景：客人去程 noshow 没飞，只留回程 —— 去程座位放回系统继续销售。
// ══════════════════════════════════════════════════════════════════════════
describe('取消去程 · 准入闸', () => {
  it('去程已开票 → 拒绝，并指到票务台改回未开（不看回程开票位）', async () => {
    mountPreview(orderSnapshot({ outboundInvoiced: true, returnInvoiced: true }), 'leg-out');
    const preview = await service.previewCancelLeg('ord-1', 'OUTBOUND', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('去程已开票');
    expect(preview.blockers.join('')).toContain('票务台');
  });

  it('回程已开票不挡取消去程（那张票的行程还在飞）', async () => {
    mountPreview(orderSnapshot({ returnInvoiced: true }), 'leg-out');
    const preview = await service.previewCancelLeg('ord-1', 'OUTBOUND', ADMIN);
    expect(preview.eligible).toBe(true);
  });

  it('去程有确认出票任务 → 不再拒绝，改为 warning + 需二次确认', async () => {
    mountPreview(orderSnapshot(), 'leg-out');
    mockPrisma.fulfillmentTask.count.mockResolvedValue(1);
    const preview = await service.previewCancelLeg('ord-1', 'OUTBOUND', ADMIN);
    expect(preview.eligible).toBe(true);
    expect(preview.requiresAcknowledgement).toBe(true);
    expect(preview.warnings.join('')).toContain('去程已出票（1 人有确认出票记录）');
  });

  it('乘客有票号但本段没有确认出票记录 → 不产生任何闸或提示', async () => {
    mountPreview(
      orderSnapshot({
        passengers: [
          { pnr: 'ABC123', eticketNumber: null },
          { pnr: null, eticketNumber: null },
        ],
      }),
      'leg-out',
    );
    const preview = await service.previewCancelLeg('ord-1', 'OUTBOUND', ADMIN);
    expect(preview.eligible).toBe(true);
    expect(preview.warnings.join('')).toContain('本单乘客已有 PNR/票号');
    expect(preview.requiresAcknowledgement).toBe(false);
  });

  it('单程单取消去程 → 拒绝：取消唯一一段等于取消整单', async () => {
    const oneWay = orderSnapshot({
      items: orderSnapshot().items.filter((it) => it.id !== 'leg-ret'),
    });
    mountPreview(oneWay, 'leg-out');
    const preview = await service.previewCancelLeg('ord-1', 'OUTBOUND', ADMIN);
    expect(preview.eligible).toBe(false);
    expect(preview.blockers.join('')).toContain('取消唯一一段等于取消整单');

    const tx = mountTx({ snapshot: oneWay, targetId: 'leg-out', flightMeta: [{ id: 'leg-out', metadata: null }] });
    await expect(
      service.cancelLeg('ord-1', { ...body(), leg: 'OUTBOUND' }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('代理不能取消去程', async () => {
    await expect(service.previewCancelLeg('ord-1', 'OUTBOUND', AGENT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('取消去程 · 手续费与航段', () => {
  it('POLICY 手续费按**去程行**报价（预检指向去程航段，不是回程）', async () => {
    mountPreview(orderSnapshot(), 'leg-out');
    const preview = await service.previewCancelLeg('ord-1', 'OUTBOUND', ADMIN);
    expect(preview.leg).toBe('OUTBOUND');
    expect(preview.returnItem).toMatchObject({
      orderItemId: 'leg-out',
      flightNumber: 'QH9589',
      amountCny: OUT_AMOUNT,
    });
    expect(preview.policyFee).toMatchObject({ feePercent: 20, feeAmountCny: 600 });
    expect(preview.netReductionCny).toBe(2400);
  });

  it('放回的是**去程班次**的座位，作废的是去程行，剩下的是原回程行', async () => {
    const tx = mountTx({ targetId: 'leg-out' });
    const { audit } = await service.cancelLeg('ord-1', { ...body(), leg: 'OUTBOUND' }, ADMIN);

    expect(audit.leg).toBe('OUTBOUND');
    // releaseSeatFloored 的 tagged template 值序：[qty, scheduleId, cabin]
    const releases = tx.$executeRaw.mock.calls.map((c: unknown[]) => c.slice(1));
    expect(releases).toEqual([[2, 'sch-out', 'ECONOMY']]);
    expect(audit.releasedSeats).toEqual([
      { scheduleId: 'sch-out', cabin: 'ECONOMY', quantity: 2 },
    ]);

    // 只作废去程那一行；回程行分毫不动（班次仍在 → 它就是幸存的那一段）
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1);
    const call = tx.orderItem.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'leg-out' });
    expect(call.data.flightScheduleId).toBeNull();
    expect(call.data.amount).toEqual(new Prisma.Decimal(0));
    expect(call.data.description).toContain('已取消去程');
    expect(call.data.metadata.returnLegCancelled).toMatchObject({
      leg: 'OUTBOUND',
      originalScheduleId: 'sch-out',
      originalAmountCny: OUT_AMOUNT,
      feeCny: 600,
    });

    // 去程票务任务终态化
    expect(tx.fulfillmentTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderItemId: 'leg-out' }) }),
    );
  });

  it('hasReturnLeg 回落 false（只剩原回程一段，全站按单程看）', async () => {
    const tx = mountTx({ targetId: 'leg-out' });
    await service.cancelLeg('ord-1', { ...body(), leg: 'OUTBOUND' }, ADMIN);
    const legUpdate = tx.order.update.mock.calls.find(
      (c: [{ data: Record<string, unknown> }]) => c[0].data.hasReturnLeg !== undefined,
    );
    expect(legUpdate?.[0].data).toEqual({ hasReturnLeg: false });
  });

  it('手续费调价行用去程专属原因码，行文案写「取消去程手续费」', async () => {
    const tx = mountTx({ targetId: 'leg-out' });
    await service.cancelLeg('ord-1', { ...body(), leg: 'OUTBOUND' }, ADMIN);
    const feeCall = tx.orderItem.create.mock.calls[0][0];
    expect(feeCall.data.metadata).toMatchObject({ reasonCode: 'OUTBOUND_LEG_CANCEL_FEE' });
    expect(feeCall.data.description).toContain('取消去程手续费');
    expect(feeCall.data.description).not.toContain('取消回程手续费');
  });

  it('手工手续费超过去程行金额 → 400，整事务不成立', async () => {
    const tx = mountTx({ targetId: 'leg-out' });
    await expect(
      service.cancelLeg(
        'ord-1',
        { ...body(), leg: 'OUTBOUND', feeMode: 'MANUAL', manualFeeCny: OUT_AMOUNT + 1, overrideReason: '航司特批' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('开票位随航段改判搬家：原回程的已开票位落到 outboundInvoiced', async () => {
    // 取消去程后，幸存的原回程行在全站位置判定里变成「去程」；它的开票位必须跟着搬，
    // 否则出票上限漏计、导出显示完全未开、还会掉进「去程未开」的票务待办。
    const tx = mountTx({ snapshot: orderSnapshot({ returnInvoiced: true }), targetId: 'leg-out' });
    await service.cancelLeg('ord-1', { ...body(), leg: 'OUTBOUND' }, ADMIN);
    const totalUpdate = tx.order.update.mock.calls.find(
      (c: [{ data: Record<string, unknown> }]) => c[0].data.total !== undefined,
    );
    expect(totalUpdate?.[0].data).toMatchObject({
      outboundInvoiced: true,
      returnInvoiced: false,
    });
  });

  it('回程未开票时搬家是无害的定值写（两个开票位都落 false）', async () => {
    const tx = mountTx({ targetId: 'leg-out' });
    await service.cancelLeg('ord-1', { ...body(), leg: 'OUTBOUND' }, ADMIN);
    const totalUpdate = tx.order.update.mock.calls.find(
      (c: [{ data: Record<string, unknown> }]) => c[0].data.total !== undefined,
    );
    expect(totalUpdate?.[0].data).toMatchObject({
      outboundInvoiced: false,
      returnInvoiced: false,
      total: new Prisma.Decimal(5600),
    });
  });
});

describe('取消航段 · 请求体契约', () => {
  it('不带 leg 的老请求体默认取消回程（老前端与集成方行为不变）', () => {
    const parsed = cancelLegBodySchema.safeParse({ requestToken: TOKEN, feeMode: 'POLICY' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.leg).toBe('RETURN');
  });

  it('leg=OUTBOUND 可解析；非法方向被拒', () => {
    expect(
      cancelLegBodySchema.safeParse({ requestToken: TOKEN, feeMode: 'POLICY', leg: 'OUTBOUND' })
        .success,
    ).toBe(true);
    expect(
      cancelLegBodySchema.safeParse({ requestToken: TOKEN, feeMode: 'POLICY', leg: 'MIDDLE' })
        .success,
    ).toBe(false);
  });

  it('预检请求体：空 body = 回程；显式 OUTBOUND 生效', () => {
    expect(cancelLegPreviewBodySchema.parse({}).leg).toBe('RETURN');
    expect(cancelLegPreviewBodySchema.parse({ leg: 'OUTBOUND' }).leg).toBe('OUTBOUND');
  });

  it('老别名 cancelReturnLeg 恒等于 leg=RETURN', async () => {
    const tx = mountTx();
    const { audit } = await service.cancelReturnLeg('ord-1', body(), ADMIN);
    expect(audit.leg).toBe('RETURN');
    expect(tx.orderItem.update.mock.calls[0][0].where).toEqual({ id: 'leg-ret' });
  });
});
