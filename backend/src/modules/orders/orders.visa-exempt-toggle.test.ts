/**
 * 建单后按人改自备签（PATCH /orders/:id/passengers/:passengerId/visa-exempt）· 服务级单测
 * （vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. 权限：非 ADMIN/STAFF → ForbiddenError（未触库）。
 *   2. 幂等短路：目标值与现值相同 → no-op（不写乘客、不动钱、audit=null）。
 *   3. false→true 门槛：送签已在办理（非 PENDING）→ ConflictError。
 *   4. 历史冲突闸：换人通道补过钱（SWAP_VISA_DEDUCT_REVERSAL 有该乘客流水）→ ConflictError。
 *   5. BUNDLE 单翻转钱对称：false→true 减一份快照费率 / true→false 加回一份；
 *      metadata.addOns 快照同步（selfProvidedVisaCount / selfVisaDeductTotal）；
 *      subtotal/total 按锁内聚合写回。
 *   6. 结算锁 / 开票闸：有钱语义时 → ConflictError（且不写乘客）。
 *   7. 非 BUNDLE 单：纯改标记，不动任何行金额与订单总额。
 *   8. visaSubmissionStatus 双向置回 PENDING（true→false 连 CONFIRMED 也重置）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    passenger: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn(), update: vi.fn(), aggregate: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { Prisma } from '@prisma/client';

import { OrderService } from './orders.service.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { setPassengerVisaExemptBodySchema } from './orders.schemas.js';

const service = new OrderService();
const actor = { userId: 'admin', role: 'ADMIN' as const };

/** 建单快照（BUNDLE 行 metadata.addOns）：2 成人 5 晚往返、仅配自备签减免 ¥300/人。 */
const baseSnapshot = (selfProvidedVisaCount: number) => ({
  singleCount: 0,
  businessCount: 0,
  businessCountOutbound: 0,
  businessCountReturn: 0,
  adultCount: 2,
  childCount: 0,
  infantCount: 0,
  seatPax: 2,
  headCount: 2,
  rooms: 1,
  nights: 5,
  legs: 2,
  singleSupplementCnyPerNight: 0,
  businessUpgradeCnyPerLeg: 0,
  childSeatDiscountCnyPerPerson: 0,
  infantPriceCny: 0,
  selfProvidedVisaCount,
  selfProvidedVisa: selfProvidedVisaCount > 0,
  selfVisaDeductCny: 300,
  singleSupplementTotal: 0,
  businessUpgradeTotal: 0,
  childSeatDiscountTotal: 0,
  infantPriceTotal: 0,
  selfVisaDeductTotal: selfProvidedVisaCount * 300,
  total: -selfProvidedVisaCount * 300,
});

type MountOptions = {
  /** 目标乘客现状。 */
  passenger?: { visaExempt: boolean; visaSubmissionStatus: string };
  /** 订单锁行字段。 */
  status?: string;
  /** 订单级签证状态（矛盾组合硬闸读它；缺省 null=未标注 → 闸不触发）。 */
  visaStatus?: string | null;
  deletedAt?: Date | null;
  adjustments?: unknown[];
  settlementLocked?: boolean;
  invoiced?: boolean;
  /** kind=BUNDLE 的行（钱路径读取）。 */
  bundleLines?: Array<Record<string, unknown>>;
  /**
   * 全体乘客 visaExempt 现势（钱路径 + 任务同步读「翻转之后」；矛盾组合硬闸在翻转之前读，
   * 按 id 把本次要改的那位投影成目标值——带 id 才能被投影到）。
   */
  passengersAfterFlip?: Array<{ id?: string; visaExempt: boolean }>;
  /** 翻转之后的非自备签乘客送签进度（任务重派生用）。 */
  nonExemptAfterFlip?: Array<{ visaSubmissionStatus: string }>;
  /** 钱路径改行后聚合出来的 Σ items。 */
  aggregateAfterCny?: number;
};

function mount(opts: MountOptions = {}): void {
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
  );
  mockPrisma.$queryRaw.mockResolvedValue([
    {
      id: 'o1',
      orderNumber: 'ORD-1',
      status: opts.status ?? 'PAID',
      deletedAt: opts.deletedAt ?? null,
      adjustments: opts.adjustments ?? [],
      adjustmentCny: 0,
      settlementLocked: opts.settlementLocked ?? false,
      outboundInvoiced: opts.invoiced ?? false,
      returnInvoiced: false,
      systemInvoiced: false,
      visaStatus: opts.visaStatus ?? null,
    },
  ]);
  mockPrisma.passenger.findUnique.mockResolvedValue({
    id: 'p1',
    orderId: 'o1',
    visaExempt: opts.passenger?.visaExempt ?? false,
    visaSubmissionStatus: opts.passenger?.visaSubmissionStatus ?? 'PENDING',
  });
  mockPrisma.passenger.update.mockResolvedValue({});
  // 乘客列表双通道：where.visaExempt === false → 任务重派生用的非自备签名单；其余 → 全员现势。
  mockPrisma.passenger.findMany.mockImplementation(async (args?: { where?: { visaExempt?: boolean } }) => {
    if (args?.where?.visaExempt === false) return opts.nonExemptAfterFlip ?? [];
    return opts.passengersAfterFlip ?? [];
  });
  // 订单行双通道：where.kind === 'BUNDLE' → 钱路径；其余 → 任务同步的行 + 任务扫描（置空即可：
  // visaStatus=null 且无行 → 权威判定「不需要」且无任务可撤，同步为零写入）。
  mockPrisma.orderItem.findMany.mockImplementation(async (args?: { where?: { kind?: string } }) => {
    if (args?.where?.kind === 'BUNDLE') return opts.bundleLines ?? [];
    return [];
  });
  mockPrisma.orderItem.update.mockResolvedValue({});
  mockPrisma.orderItem.aggregate.mockResolvedValue({
    _sum: { amount: new Prisma.Decimal(opts.aggregateAfterCny ?? 0) },
  });
  mockPrisma.order.update.mockResolvedValue({});
  // 任务同步内部读订单（visaStatus 等）：null = 录单没表态 → 不需要建任务。
  mockPrisma.order.findUnique.mockResolvedValue({
    visaStatus: null,
    orderNumber: 'ORD-1',
    status: opts.status ?? 'PAID',
    deletedAt: opts.deletedAt ?? null,
  });
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.fulfillmentTask.count.mockResolvedValue(0);
  mockPrisma.fulfillmentTask.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
    id: 'o1',
    orderNumber: 'ORD-1',
    status: opts.status ?? 'PAID',
    subtotal: new Prisma.Decimal(opts.aggregateAfterCny ?? 0),
    taxesAndFees: new Prisma.Decimal(0),
    discountTotal: new Prisma.Decimal(0),
    total: new Prisma.Decimal(opts.aggregateAfterCny ?? 0),
    paidAmount: new Prisma.Decimal(0),
    prepaymentOffset: new Prisma.Decimal(0),
    adjustmentCny: 0,
    items: [],
    passengers: [],
    payments: [],
    refunds: [],
    statusEvents: [],
    agent: null,
    user: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setPassengerVisaExemptBodySchema', () => {
  it('visaExempt 必填布尔；note 可选', () => {
    expect(setPassengerVisaExemptBodySchema.safeParse({}).success).toBe(false);
    expect(setPassengerVisaExemptBodySchema.safeParse({ visaExempt: 'yes' }).success).toBe(false);
    const parsed = setPassengerVisaExemptBodySchema.parse({ visaExempt: true, note: '客人自行办妥' });
    expect(parsed).toEqual({ visaExempt: true, note: '客人自行办妥' });
  });
});

describe('OrderService.setPassengerVisaExempt · 权限与守卫', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('%s 调用 → ForbiddenError，未触库', async (role) => {
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('订单不存在 → NotFoundError', async () => {
    mount();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(
      service.setPassengerVisaExempt('missing', 'p1', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('乘客不属于本单 → NotFoundError', async () => {
    mount();
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p9',
      orderId: 'other-order',
      visaExempt: false,
      visaSubmissionStatus: 'PENDING',
    });
    await expect(
      service.setPassengerVisaExempt('o1', 'p9', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('幂等短路：目标值与现值相同 → no-op（不写乘客、不动钱、audit=null）', async () => {
    mount({ passenger: { visaExempt: true, visaSubmissionStatus: 'PENDING' } });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(res.idempotent).toBe(true);
    expect(res.audit).toBeNull();
    expect(res.warning).toBeNull();
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('false→true 门槛：送签已在办理（IN_PROGRESS）→ ConflictError，不写乘客', async () => {
    mount({ passenger: { visaExempt: false, visaSubmissionStatus: 'IN_PROGRESS' } });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('历史冲突闸：该乘客有换人通道的 SWAP_VISA_DEDUCT_REVERSAL 流水 → ConflictError', async () => {
    mount({
      adjustments: [
        { type: 'SWAP_VISA_DEDUCT_REVERSAL', label: '撤销自备签减免', amountCny: 300, passengerId: 'p1' },
      ],
    });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('别的乘客的 SWAP_VISA_DEDUCT_REVERSAL 流水不挡本乘客', async () => {
    mount({
      adjustments: [
        { type: 'SWAP_VISA_DEDUCT_REVERSAL', label: '撤销自备签减免', amountCny: 300, passengerId: 'p2' },
      ],
      passengersAfterFlip: [{ visaExempt: true }, { visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
    });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(res.idempotent).toBe(false);
    expect(mockPrisma.passenger.update).toHaveBeenCalled();
  });
});

describe('OrderService.setPassengerVisaExempt · BUNDLE 钱路径（行重算，对称可逆）', () => {
  const bundleLine = (amountCny: number, snapshotCount: number) => ({
    id: 'item-b1',
    quantity: 2,
    amount: new Prisma.Decimal(amountCny),
    metadata: { addOns: baseSnapshot(snapshotCount) },
  });

  it('false→true：套餐行减一份快照费率（¥300），快照同步为 1 人自备签', async () => {
    mount({
      bundleLines: [bundleLine(5000, 0)],
      passengersAfterFlip: [{ visaExempt: true }, { visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
      aggregateAfterCny: 4700,
    });

    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);

    const itemUpdate = mockPrisma.orderItem.update.mock.calls[0][0];
    expect(itemUpdate.where).toEqual({ id: 'item-b1' });
    expect(Number(itemUpdate.data.amount.toString())).toBe(4700);
    expect(itemUpdate.data.metadata.addOns).toMatchObject({
      selfProvidedVisaCount: 1,
      selfVisaDeductCny: 300,
      selfVisaDeductTotal: 300,
    });

    // subtotal/total 按锁内聚合写回
    const orderUpdate = mockPrisma.order.update.mock.calls[0][0];
    expect(Number(orderUpdate.data.subtotal.toString())).toBe(4700);
    expect(Number(orderUpdate.data.total.toString())).toBe(4700);

    expect(res.audit?.totalDeltaCny).toBe(-300);
    expect(res.audit?.after).toEqual({ visaExempt: true, visaSubmissionStatus: 'PENDING' });
  });

  it('true→false：套餐行加回一份快照费率（¥300），快照同步为 0 人自备签', async () => {
    mount({
      passenger: { visaExempt: true, visaSubmissionStatus: 'PENDING' },
      bundleLines: [bundleLine(4700, 1)],
      passengersAfterFlip: [{ visaExempt: false }, { visaExempt: false }],
      nonExemptAfterFlip: [
        { visaSubmissionStatus: 'PENDING' },
        { visaSubmissionStatus: 'PENDING' },
      ],
      aggregateAfterCny: 5000,
    });

    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: false }, actor);

    const itemUpdate = mockPrisma.orderItem.update.mock.calls[0][0];
    expect(Number(itemUpdate.data.amount.toString())).toBe(5000);
    expect(itemUpdate.data.metadata.addOns).toMatchObject({
      selfProvidedVisaCount: 0,
      selfVisaDeductTotal: 0,
    });
    expect(res.audit?.totalDeltaCny).toBe(300);
  });

  it('快照与乘客现势漂移（重算差额 ≠ ±快照费率）→ ConflictError 回滚（fail-closed）', async () => {
    // 快照记 0 人自备签，但库里另有一人早已自备签（换人时代快照没跟上）：
    // 翻本乘客后现势 2 人 → 重算差额 -600 ≠ 应为 -300 → 拒绝自动算钱。
    mount({
      bundleLines: [bundleLine(5000, 0)],
      passengersAfterFlip: [{ visaExempt: true }, { visaExempt: true }],
      nonExemptAfterFlip: [],
    });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('结算价已锁定 + 有钱语义 → ConflictError，且不写乘客', async () => {
    mount({ bundleLines: [bundleLine(5000, 0)], settlementLocked: true });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('已开票（任一维度）+ 有钱语义 → ConflictError，且不写乘客', async () => {
    mount({ bundleLines: [bundleLine(5000, 0)], invoiced: true });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('BUNDLE 行快照费率为 0 → 无钱语义：结算锁不拦，纯改标记', async () => {
    mount({
      passenger: { visaExempt: false, visaSubmissionStatus: 'PENDING' },
      bundleLines: [
        {
          id: 'item-b1',
          quantity: 2,
          amount: new Prisma.Decimal(5000),
          metadata: { addOns: { ...baseSnapshot(0), selfVisaDeductCny: 0 } },
        },
      ],
      settlementLocked: true,
      passengersAfterFlip: [{ visaExempt: true }, { visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
    });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(res.audit?.totalDeltaCny).toBe(0);
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});

describe('OrderService.setPassengerVisaExempt · 非 BUNDLE 单与送签进度重置', () => {
  it('非 BUNDLE 单（纯机票/签证单）：纯改标记，不动任何金额', async () => {
    mount({
      bundleLines: [],
      passengersAfterFlip: [{ visaExempt: true }],
      nonExemptAfterFlip: [],
    });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(res.audit?.totalDeltaCny).toBe(0);
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
    expect(mockPrisma.orderItem.aggregate).not.toHaveBeenCalled();
  });

  it('false→true：visaSubmissionStatus 置回 PENDING（本就 PENDING，写入幂等）', async () => {
    mount({
      passengersAfterFlip: [{ visaExempt: true }],
      nonExemptAfterFlip: [],
    });
    await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(mockPrisma.passenger.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { visaExempt: true, visaSubmissionStatus: 'PENDING' },
    });
  });

  it('true→false：连已确认（CONFIRMED）的送签进度也置回 PENDING（防旧进度复活污染派生）', async () => {
    mount({
      passenger: { visaExempt: true, visaSubmissionStatus: 'CONFIRMED' },
      passengersAfterFlip: [{ visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
    });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: false }, actor);
    expect(mockPrisma.passenger.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { visaExempt: false, visaSubmissionStatus: 'PENDING' },
    });
    expect(res.audit?.before).toEqual({ visaExempt: true, visaSubmissionStatus: 'CONFIRMED' });
    expect(res.audit?.after).toEqual({ visaExempt: false, visaSubmissionStatus: 'PENDING' });
  });

  it('存在非自备签乘客 → 任务状态按人重派生（仅动 PENDING/IN_PROGRESS）', async () => {
    mount({
      passenger: { visaExempt: true, visaSubmissionStatus: 'PENDING' },
      passengersAfterFlip: [{ visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
    });
    await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: false }, actor);
    const rederive = mockPrisma.fulfillmentTask.updateMany.mock.calls.find(
      (c) => (c[0] as { where: { type?: string } }).where.type === 'VISA_APPLICATION',
    );
    expect(rederive).toBeDefined();
    expect((rederive![0] as { where: { status: { in: string[] } } }).where.status.in).toEqual([
      'PENDING',
      'IN_PROGRESS',
    ]);
    expect((rederive![0] as { data: { status: string } }).data.status).toBe('PENDING');
  });

  it('全员自备签且仍有 IN_PROGRESS/CONFIRMED 签证任务 → 返回 warning，且不重派生（留给签证岗）', async () => {
    mount({
      passengersAfterFlip: [{ visaExempt: true }],
      nonExemptAfterFlip: [],
    });
    mockPrisma.fulfillmentTask.count.mockResolvedValue(1);
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(res.warning).toContain('签证岗人工处置');
    const rederive = mockPrisma.fulfillmentTask.updateMany.mock.calls.find(
      (c) =>
        (c[0] as { data?: { status?: string } }).data?.status !== 'CANCELLED' &&
        (c[0] as { where: { type?: string } }).where.type === 'VISA_APPLICATION',
    );
    expect(rederive).toBeUndefined();
  });
});

describe('OrderService.setPassengerVisaExempt · 已送签人为确认（submittedOverride）', () => {
  const bundleLine = (amountCny: number, snapshotCount: number) => ({
    id: 'item-b1',
    quantity: 2,
    amount: new Prisma.Decimal(amountCny),
    metadata: { addOns: baseSnapshot(snapshotCount) },
  });
  const submittedMount = (extra: Parameters<typeof mount>[0] = {}) =>
    mount({
      passenger: { visaExempt: false, visaSubmissionStatus: 'CONFIRMED' },
      bundleLines: [bundleLine(5000, 0)],
      passengersAfterFlip: [{ visaExempt: true }, { visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
      aggregateAfterCny: 4700,
      ...extra,
    });

  it('无 override → ConflictError 带 [NEED_CONFIRM_SUBMITTED] 标记（前端据此弹确认框）', async () => {
    submittedMount();
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toThrow(/\[NEED_CONFIRM_SUBMITTED\]/);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('override 退 100（费率 300）→ 行重算 −300 + 批文留存 200 补回应收，净退 100', async () => {
    submittedMount();
    const res = await service.setPassengerVisaExempt(
      'o1',
      'p1',
      { visaExempt: true, submittedOverride: { refundCny: 100, reason: '客人临时不办，材料费已发生' } },
      actor,
    );
    // 行重算照旧退整份费率
    expect(res.audit?.totalDeltaCny).toBe(-300);
    // 留存调整行：adjustmentCny += 200，流水带乘客与原因
    const retainUpdate = mockPrisma.order.update.mock.calls.find(
      (c) => (c[0] as { data: { adjustmentCny?: number } }).data.adjustmentCny !== undefined,
    );
    expect(retainUpdate).toBeDefined();
    const data = (retainUpdate![0] as { data: { adjustmentCny: number; adjustments: unknown[] } }).data;
    expect(data.adjustmentCny).toBe(200);
    expect(data.adjustments).toEqual([
      expect.objectContaining({
        type: 'VISA_SUBMITTED_COST_RETAIN',
        amountCny: 200,
        passengerId: 'p1',
        note: '客人临时不办，材料费已发生',
      }),
    ]);
    expect(res.audit?.refundCny).toBe(100);
    expect(res.audit?.retainCny).toBe(200);
  });

  it('override 退 0 → 全额留存 300（不退），有流水可查', async () => {
    submittedMount();
    const res = await service.setPassengerVisaExempt(
      'o1',
      'p1',
      { visaExempt: true, submittedOverride: { refundCny: 0, reason: '批文已出，不退' } },
      actor,
    );
    const retainUpdate = mockPrisma.order.update.mock.calls.find(
      (c) => (c[0] as { data: { adjustmentCny?: number } }).data.adjustmentCny !== undefined,
    );
    expect((retainUpdate![0] as { data: { adjustmentCny: number } }).data.adjustmentCny).toBe(300);
    expect(res.audit?.refundCny).toBe(0);
    expect(res.audit?.retainCny).toBe(300);
  });

  it('override 退 400 > 费率 300 → ConflictError（显式拒绝，不静默钳位）', async () => {
    submittedMount();
    await expect(
      service.setPassengerVisaExempt(
        'o1',
        'p1',
        { visaExempt: true, submittedOverride: { refundCny: 400, reason: '填错了' } },
        actor,
      ),
    ).rejects.toThrow(/不能超过/);
  });

  it('非钱单（无减免费率行）+ override 退 >0 → ConflictError（无退费来源）', async () => {
    submittedMount({ bundleLines: [], aggregateAfterCny: 0 });
    await expect(
      service.setPassengerVisaExempt(
        'o1',
        'p1',
        { visaExempt: true, submittedOverride: { refundCny: 50, reason: '想退点' } },
        actor,
      ),
    ).rejects.toThrow(/未配自备签减免费率/);
  });

  it('非钱单 + override 退 0 → 放行纯改标记（不动钱）', async () => {
    submittedMount({ bundleLines: [], aggregateAfterCny: 0 });
    const res = await service.setPassengerVisaExempt(
      'o1',
      'p1',
      { visaExempt: true, submittedOverride: { refundCny: 0, reason: '客人自带，材料自理' } },
      actor,
    );
    expect(res.audit?.totalDeltaCny).toBe(0);
    expect(res.audit?.retainCny).toBe(0);
    expect(mockPrisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('schema：submittedOverride.reason 必填非空、refundCny 非负整数', () => {
    expect(
      setPassengerVisaExemptBodySchema.safeParse({
        visaExempt: true,
        submittedOverride: { refundCny: 100, reason: '  ' },
      }).success,
    ).toBe(false);
    expect(
      setPassengerVisaExemptBodySchema.safeParse({
        visaExempt: true,
        submittedOverride: { refundCny: -1, reason: 'x' },
      }).success,
    ).toBe(false);
    expect(
      setPassengerVisaExemptBodySchema.safeParse({
        visaExempt: true,
        submittedOverride: { refundCny: 0, reason: '不退' },
      }).success,
    ).toBe(true);
  });
});

describe('OrderService.setPassengerVisaExempt · 签证矛盾组合硬闸', () => {
  it('订单级「需要签证」+ 把最后一位随团办签的人改成自备签 → BadRequestError，不写乘客', async () => {
    mount({
      visaStatus: 'NEEDED',
      passenger: { visaExempt: false, visaSubmissionStatus: 'PENDING' },
      // 翻转前名单：p1（本次要改的人）是唯一一位随团办签的
      passengersAfterFlip: [{ id: 'p1', visaExempt: false }, { id: 'p2', visaExempt: true }],
    });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toThrow(/全部标了自备签/);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('订单级「电子签」同样拦（电子签一样要送签）', async () => {
    mount({
      visaStatus: 'E_VISA',
      passenger: { visaExempt: false, visaSubmissionStatus: 'PENDING' },
      passengersAfterFlip: [{ id: 'p1', visaExempt: false }],
    });
    await expect(
      service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor),
    ).rejects.toThrow(/签证台看不到这单/);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('名单里还有别人随团办签 → 放行（部分自备签不拦）', async () => {
    mount({
      visaStatus: 'NEEDED',
      passenger: { visaExempt: false, visaSubmissionStatus: 'PENDING' },
      passengersAfterFlip: [
        { id: 'p1', visaExempt: false },
        { id: 'p2', visaExempt: false },
      ],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
    });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
    expect(res.idempotent).toBe(false);
    expect(mockPrisma.passenger.update).toHaveBeenCalled();
  });

  it('改回随团办签（visaExempt=false）永不受本闸影响', async () => {
    mount({
      visaStatus: 'NEEDED',
      passenger: { visaExempt: true, visaSubmissionStatus: 'PENDING' },
      passengersAfterFlip: [{ id: 'p1', visaExempt: false }],
      nonExemptAfterFlip: [{ visaSubmissionStatus: 'PENDING' }],
    });
    const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: false }, actor);
    expect(res.idempotent).toBe(false);
  });

  it('订单级「不需要签证 / 已签证 / 未标注」+ 全员自备签 → 放行', async () => {
    for (const visaStatus of ['NOT_NEEDED', 'HAS_VISA', null]) {
      vi.clearAllMocks();
      mount({
        visaStatus,
        passenger: { visaExempt: false, visaSubmissionStatus: 'PENDING' },
        passengersAfterFlip: [{ id: 'p1', visaExempt: false }],
      });
      const res = await service.setPassengerVisaExempt('o1', 'p1', { visaExempt: true }, actor);
      expect(res.idempotent).toBe(false);
    }
  });
});
