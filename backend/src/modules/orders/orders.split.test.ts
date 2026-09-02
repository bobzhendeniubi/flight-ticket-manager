/**
 * 拆单 v1（split PNR 售后逃生门）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. 权限：非 ADMIN/STAFF 调 preview/execute → ForbiddenError（未触库）。
 *   2. 准入闸矩阵：回收站/状态/两把锁/佣金/退款/售后费/套餐/升舱/
 *      人数选择/同房组 —— preview 逐条返回人话 blocker；已结清单（原闸 13）、已开票（原闸 6）、
 *      已出票（原闸 12）均已放开，另有放行 + 「票随人走」的专门用例。
 *   3. 纯机票 2 人拆 1 人：份额计算、行拆分（quantity/amount/成本比例）、乘客物理转移、
 *      两侧金额收口、承接 Payment 形状、拆单流水与审计。
 *   4. 按人调整行跟人走 / 整单调整行留守 + 两侧 SPLIT 平账行（±50 对称）。
 *   5. requestToken 幂等回放（不进事务、不二次拆）。
 *   6. 守恒断言兜底：total / 座位数量对不上拆前 → 抛错回滚（流水不落库）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    orderItem: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      aggregate: vi.fn(),
    },
    passenger: { updateMany: vi.fn(), findMany: vi.fn() },
    payment: { findMany: vi.fn(), create: vi.fn() },
    refund: { count: vi.fn(), aggregate: vi.fn() },
    commissionRecord: { aggregate: vi.fn() },
    fulfillmentTask: {
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    orderCostItem: { create: vi.fn() },
    orderSplitRecord: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const admin = { userId: 'admin-1', role: 'ADMIN' as const };
const TOKEN = '00000000-0000-4000-8000-00000000abcd';

// ── fixtures ──────────────────────────────────────────────────────────────
const flightItem = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  orderId: 'o1',
  kind: 'FLIGHT',
  description: '测试机票 去程',
  quantity: 2,
  unitPrice: 1000,
  amount: 2000,
  unitCostCny: 600,
  totalCostCny: 1200,
  flightScheduleId: 'sch1',
  flightCabin: 'ECONOMY',
  hotelRoomTypeId: null,
  randomStarTier: null,
  hotelCheckIn: null,
  hotelCheckOut: null,
  transferId: null,
  visaId: null,
  visaIntendedDate: null,
  bundleId: null,
  passengerId: null,
  metadata: null,
  roomsBilled: null,
  idempotencyKey: null,
  ...over,
});

const pax = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  fullName: `PAX ${id}`,
  chineseName: null,
  pnr: null,
  eticketNumber: null,
  ...over,
});

const baseOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  orderNumber: 'FTM20260830-SRC',
  userId: null,
  agentId: null,
  guestName: null,
  guestPhone: null,
  guestEmail: null,
  status: 'PENDING_PAYMENT',
  currency: 'CNY',
  subtotal: 2000,
  total: 2000,
  paidAmount: 500,
  prepaymentOffset: 0,
  adjustmentCny: 0,
  adjustments: [],
  contactName: '联系人',
  contactPhone: '13800000000',
  contactEmail: null,
  settlementLocked: false,
  paymentsLocked: false,
  outboundInvoiced: false,
  returnInvoiced: false,
  systemInvoiced: false,
  visaStatus: null,
  claimedById: null,
  claimedAt: null,
  notes: null,
  noteHotel: null,
  noteVisa: null,
  notePayment: null,
  noteSpecial: null,
  roomAssignment: null,
  deletedAt: null,
  items: [flightItem()],
  passengers: [pax('p1'), pax('p2')],
  ...over,
});

/** 准入闸相关查询全部给「干净」返回（无佣金/无退款/无出票任务/无已完成退款）。 */
const armCleanGates = () => {
  mockPrisma.commissionRecord.aggregate.mockResolvedValue({ _sum: { amount: null } });
  mockPrisma.refund.count.mockResolvedValue(0);
  mockPrisma.fulfillmentTask.count.mockResolvedValue(0);
  mockPrisma.refund.aggregate.mockResolvedValue({ _sum: { amount: null } });
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
describe('拆单 · 权限', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('preview：%s → ForbiddenError，未触库', async (role) => {
    await expect(
      service.previewOrderSplit('o1', { passengerIds: ['p1'] }, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it.each(['CUSTOMER', 'AGENT'] as const)('execute：%s → ForbiddenError，未触库', async (role) => {
    await expect(
      service.splitOrder(
        'o1',
        { passengerIds: ['p1'], requestToken: TOKEN },
        { userId: 'u1', role },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.orderSplitRecord.findUnique).not.toHaveBeenCalled();
  });

  it('preview：订单不存在 → NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(
      service.previewOrderSplit('missing', { passengerIds: ['p1'] }, admin),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('拆单 · 准入闸矩阵（preview 返回人话 blocker）', () => {
  const previewWith = async (
    orderOver: Record<string, unknown>,
    passengerIds: string[] = ['p1'],
  ) => {
    armCleanGates();
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder(orderOver));
    return service.previewOrderSplit('o1', { passengerIds }, admin);
  };

  it('回收站单', async () => {
    const r = await previewWith({ deletedAt: new Date() });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join()).toContain('回收站');
  });

  it('非占座状态（已取消）', async () => {
    const r = await previewWith({ status: 'CANCELLED' });
    expect(r.eligible).toBe(false);
    expect(r.blockers.join()).toContain('仅占座中的有效订单可拆');
  });

  it('结算价锁', async () => {
    const r = await previewWith({ settlementLocked: true });
    expect(r.blockers.join()).toContain('结算价已锁定');
  });

  it('收款复核锁', async () => {
    const r = await previewWith({ paymentsLocked: true });
    expect(r.blockers.join()).toContain('收款已复核锁定');
  });

  it.each(['outboundInvoiced', 'returnInvoiced', 'systemInvoiced'] as const)(
    '已开票（%s）→ 闸 6 已放开：不拦，只给「票随人走」提示',
    async (flag) => {
      const r = await previewWith({ [flag]: true });
      expect(r.eligible).toBe(true);
      expect(r.blockers).toEqual([]);
      expect(r.warnings.join()).toContain('票务状态');
    },
  );

  it('已计提佣金', async () => {
    armCleanGates();
    mockPrisma.commissionRecord.aggregate.mockResolvedValue({ _sum: { amount: 88 } });
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
    const r = await service.previewOrderSplit('o1', { passengerIds: ['p1'] }, admin);
    expect(r.blockers.join()).toContain('佣金');
  });

  it('进行中退款', async () => {
    armCleanGates();
    mockPrisma.refund.count.mockResolvedValue(1);
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
    const r = await service.previewOrderSplit('o1', { passengerIds: ['p1'] }, admin);
    expect(r.blockers.join()).toContain('退款');
  });

  it('售后费用未结清（adjustmentCny ≠ 0）', async () => {
    const r = await previewWith({ adjustmentCny: 200 });
    expect(r.blockers.join()).toContain('售后费用');
  });

  it('套餐单', async () => {
    const r = await previewWith({
      items: [flightItem(), flightItem({ id: 'ib', kind: 'BUNDLE', flightScheduleId: null })],
    });
    expect(r.blockers.join()).toContain('套餐订单暂不支持拆单');
  });

  it('升舱行', async () => {
    const r = await previewWith({
      items: [flightItem({ metadata: { businessUpgradeCount: 1 } })],
    });
    expect(r.blockers.join()).toContain('升舱');
  });

  it('乘客已有 PNR/票号（闸 12 已放开）→ eligible，提示票随人走', async () => {
    const r = await previewWith({
      passengers: [pax('p1', { pnr: 'ABC123', eticketNumber: '999-1234567890' }), pax('p2')],
    });
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.warnings.join()).toContain('已出票');
    expect(r.warnings.join()).toContain('票务台重开');
  });

  it('已确认出票任务（闸 12 已放开）→ eligible，提示票随人走', async () => {
    armCleanGates();
    mockPrisma.fulfillmentTask.count.mockResolvedValue(1);
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder());
    const r = await service.previewOrderSplit('o1', { passengerIds: ['p1'] }, admin);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.warnings.join()).toContain('已出票');
  });

  it('未出票的干净单：没有任何提示（warning 不是常驻文案）', async () => {
    const r = await previewWith({});
    expect(r.eligible).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('已结清单（闸 13 已放开）→ 不再拦，movedPaid 按份额全额随拆', async () => {
    const r = await previewWith({ paidAmount: 2000 });
    expect(r.blockers).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.movedShareCny).toBe(1000);
    expect(r.movedPaidCny).toBe(1000); // 已结清 → min(份额 1000, 已收 2000) = 份额
  });

  it('多付单同样放行：只搬份额，多出来的钱留在源单', async () => {
    const r = await previewWith({ paidAmount: 2600 });
    expect(r.blockers).toEqual([]);
    expect(r.movedShareCny).toBe(1000);
    expect(r.movedPaidCny).toBe(1000);
  });

  it('拆出全员', async () => {
    const r = await previewWith({}, ['p1', 'p2']);
    expect(r.blockers.join()).toContain('少于全员');
  });

  it('乘客不属于本单', async () => {
    const r = await previewWith({}, ['ghost']);
    expect(r.blockers.join()).toContain('不属于本订单');
  });

  it('同房组同时含拆出与留下 → 拒绝', async () => {
    const r = await previewWith({
      roomAssignment: {
        roomGroups: [
          { id: 'g1', hotelName: '测试酒店', roomType: '双床', passengerIds: ['p1', 'p2'] },
        ],
      },
    });
    expect(r.blockers.join()).toContain('房组');
  });

  it('全闸通过：eligible + 份额/已收/酒店行', async () => {
    armCleanGates();
    mockPrisma.order.findUnique.mockResolvedValue(
      baseOrder({
        items: [
          flightItem(),
          flightItem({
            id: 'ih',
            kind: 'HOTEL',
            description: '测试酒店 双床房',
            flightScheduleId: null,
            flightCabin: null,
            quantity: 1,
            unitPrice: 0,
            amount: 0,
            roomsBilled: 1,
          }),
        ],
      }),
    );
    const r = await service.previewOrderSplit('o1', { passengerIds: ['p1'] }, admin);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.shares).toEqual([{ passengerId: 'p1', fullName: 'PAX p1', shareCny: 1000 }]);
    expect(r.movedShareCny).toBe(1000);
    expect(r.movedPaidCny).toBe(500); // min(份额 1000, 已收 500)
    expect(r.hotelItems).toEqual([
      { itemId: 'ih', description: '测试酒店 双床房', roomsBilled: 1 },
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 执行链路的完整 mock 编排：$transaction 直接以 mockPrisma 为 tx。
// ══════════════════════════════════════════════════════════════════════════
/** 守恒断言读到的一侧终值：金额 + 三个开票位 + 乘客数（开票位随人搬家的守恒口径）。 */
interface FinalOrderShape {
  total: number;
  paidAmount: number;
  outboundInvoiced?: boolean;
  returnInvoiced?: boolean;
  systemInvoiced?: boolean;
  passengerCount?: number;
}

interface ExecuteArmOptions {
  order: ReturnType<typeof baseOrder>;
  /** orderItem.aggregate 的返回（先查目标单再查源单，按 where.orderId 分派） */
  targetItemsSum: number;
  sourceItemsSum: number;
  /** 守恒断言读到的两侧终值 */
  finalSource: FinalOrderShape;
  finalTarget: FinalOrderShape;
  conservationRows?: Array<{
    kind: string;
    flightScheduleId: string | null;
    flightCabin: string | null;
    quantity: number;
  }>;
  /** 源单拆分行上已存在的出票任务（出票任务镜像用；缺省=源行没有出票任务） */
  sourceTicketingTasks?: Array<Record<string, unknown>>;
}

/** 终值 → findUniqueOrThrow 的返回形状（补齐开票位与 _count.passengers 缺省值）。 */
const finalOrderRow = (shape: FinalOrderShape) => ({
  total: shape.total,
  paidAmount: shape.paidAmount,
  outboundInvoiced: shape.outboundInvoiced ?? false,
  returnInvoiced: shape.returnInvoiced ?? false,
  systemInvoiced: shape.systemInvoiced ?? false,
  _count: { passengers: shape.passengerCount ?? 1 },
});

const armExecute = (opts: ExecuteArmOptions) => {
  armCleanGates();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(mockPrisma),
  );
  mockPrisma.$queryRaw.mockResolvedValue([{ id: opts.order.id }]);
  mockPrisma.orderSplitRecord.findUnique.mockResolvedValue(null);
  mockPrisma.orderSplitRecord.create.mockResolvedValue({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.order.findUnique.mockImplementation(async (args: any) => {
    if (args?.include) return opts.order;
    const sel = args?.select ?? {};
    if (sel.prepaymentOffset) {
      // advanceOrderToPaidIfClearedWithinTx：读目标单终值
      return {
        status: opts.order.status,
        total: opts.finalTarget.total,
        adjustmentCny: 0,
        paidAmount: opts.finalTarget.paidAmount,
        prepaymentOffset: 0,
      };
    }
    if (sel.orderNumber && sel.visaStatus) {
      // evaluateOrderVisaTaskState
      return {
        visaStatus: null,
        orderNumber: 'FTM-TGT',
        status: opts.order.status,
        deletedAt: null,
      };
    }
    if (sel.visaStatus) return { visaStatus: null }; // createFulfillmentTasks
    return null;
  });
  let createdSeq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.order.create.mockImplementation(async (args: any) => ({
    id: 'o2',
    orderNumber: args.data.orderNumber,
  }));
  mockPrisma.order.update.mockResolvedValue({});
  mockPrisma.orderItem.update.mockResolvedValue({});
  mockPrisma.orderItem.create.mockImplementation(async () => ({ id: `new_i${++createdSeq}` }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.orderItem.aggregate.mockImplementation(async (args: any) => ({
    _sum: { amount: args?.where?.orderId === 'o2' ? opts.targetItemsSum : opts.sourceItemsSum },
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.orderItem.findMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.orderId?.in) {
      // 守恒断言：两单的 FLIGHT 行
      return (
        opts.conservationRows ?? [
          { kind: 'FLIGHT', flightScheduleId: 'sch1', flightCabin: 'ECONOMY', quantity: 1 },
          { kind: 'FLIGHT', flightScheduleId: 'sch1', flightCabin: 'ECONOMY', quantity: 1 },
        ]
      );
    }
    const sel = args?.select ?? {};
    if (sel.flightSchedule) return []; // syncOrderHasReturnLeg
    if (sel.fulfillmentTasks) {
      // createFulfillmentTasks / evaluateOrderVisaTaskState：新单上只有拆过来的机票行
      return [{ id: 'new_i1', kind: 'FLIGHT', bundleId: null, fulfillmentTasks: [] }];
    }
    return [];
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.passenger.updateMany.mockImplementation(async (args: any) => ({
    count: args?.where?.id?.in?.length ?? 0,
  }));
  mockPrisma.passenger.findMany.mockResolvedValue([{ visaExempt: false }]);
  mockPrisma.payment.findMany.mockResolvedValue([{ verifiedAt: new Date('2026-08-01') }]);
  mockPrisma.payment.create.mockResolvedValue({ id: 'pay-split' });
  mockPrisma.fulfillmentTask.create.mockResolvedValue({ id: 'task-1' });
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.fulfillmentTask.update.mockResolvedValue({});
  // 出票任务镜像：先查新单刚建的出票任务（按 id），再查源单对应行上的出票任务（按 orderItemId）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.fulfillmentTask.findMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.id?.in) return [{ id: 'task-1', orderItemId: 'new_i1' }];
    if (where.orderItemId?.in) return opts.sourceTicketingTasks ?? [];
    return [];
  });
  mockPrisma.orderCostItem.create.mockResolvedValue({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.order.findUniqueOrThrow.mockImplementation(async (args: any) =>
    args?.where?.id === 'o2' ? finalOrderRow(opts.finalTarget) : finalOrderRow(opts.finalSource),
  );
  mockPrisma.auditLog.create.mockResolvedValue({});
};

describe('拆单 · 执行（纯机票 2 人拆 1 人）', () => {
  it('份额/行拆/乘客转移/承接收款/流水/审计 全链路形状', async () => {
    armExecute({
      order: baseOrder(),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 1000, paidAmount: 0 },
      finalTarget: { total: 1000, paidAmount: 500 },
    });

    const result = await service.splitOrder(
      'o1',
      { passengerIds: ['p1'], requestToken: TOKEN, note: '客人分开走' },
      admin,
    );

    // 响应形状
    expect(result.sourceOrderNumber).toBe('FTM20260830-SRC');
    expect(result.targetOrderNumber).toMatch(/^FTM\d{13}$/);
    expect(result.movedShareCny).toBe(1000);
    expect(result.movedPaidCny).toBe(500);
    expect(result.passengerCount).toBe(1);
    expect(result.replayed).toBe(false);

    // 行拆分：源行 2→1（amount=unitPrice×新数量、成本同比例），新行 quantity=1、幂等键置空
    expect(mockPrisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'i1' },
        data: expect.objectContaining({ quantity: 1 }),
      }),
    );
    const splitCreate = mockPrisma.orderItem.create.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0].data.kind === 'FLIGHT',
    );
    expect(splitCreate?.[0].data).toMatchObject({
      orderId: 'o2',
      quantity: 1,
      flightScheduleId: 'sch1',
      flightCabin: 'ECONOMY',
      idempotencyKey: null,
    });
    expect(Number(splitCreate?.[0].data.amount)).toBe(1000);
    expect(Number(splitCreate?.[0].data.totalCostCny)).toBe(600);

    // 两侧份额恰好等于行合计 → 不建 SPLIT 平账行
    const balanceRows = mockPrisma.orderItem.create.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0].data.metadata?.reasonCode === 'SPLIT',
    );
    expect(balanceRows).toHaveLength(0);

    // 乘客物理转移（保 id）
    expect(mockPrisma.passenger.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1'] }, orderId: 'o1' },
      data: { orderId: 'o2' },
    });

    // 两侧金额收口：源 1000/已收 0；新 1000/已收 500
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderUpdates = mockPrisma.order.update.mock.calls.map((c: any[]) => c[0]);
    const srcUpdate = orderUpdates.find((u) => u.where.id === 'o1');
    const tgtUpdate = orderUpdates.find((u) => u.where.id === 'o2');
    expect(Number(srcUpdate.data.total)).toBe(1000);
    expect(Number(srcUpdate.data.paidAmount)).toBe(0);
    expect(Number(tgtUpdate.data.total)).toBe(1000);
    expect(Number(tgtUpdate.data.paidAmount)).toBe(500);
    // 源单留同状态自转事件；SPLIT_OUT/SPLIT_IN 流水仅记录（不写 adjustmentCny）
    expect(srcUpdate.data.statusEvents.create.toStatus).toBe('PENDING_PAYMENT');
    expect(srcUpdate.data.adjustmentCny).toBeUndefined();
    expect(tgtUpdate.data.adjustmentCny).toBeUndefined();
    expect(srcUpdate.data.adjustments[0]).toMatchObject({ type: 'SPLIT_OUT', amountCny: -1000 });
    expect(tgtUpdate.data.adjustments[0]).toMatchObject({ type: 'SPLIT_IN', amountCny: 1000 });

    // 承接 Payment 形状：幂等键 split:{源id}:{token}、来源载荷、核实继承（源单全核实 → 非空）
    // 成对两条：新单正额承接行 + 源单等额负额对冲行（对冲行形状另有专用用例）
    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(2);
    const paymentData = mockPrisma.payment.create.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0].data)
      .find((d) => d.orderId === 'o2');
    expect(paymentData).toMatchObject({
      orderId: 'o2',
      status: 'SUCCEEDED',
      transactionId: null,
      idempotencyKey: `split:o1:${TOKEN}`,
    });
    expect(Number(paymentData.amount)).toBe(500);
    expect(paymentData.verifiedAt).not.toBeNull();
    expect(paymentData.gatewayPayload).toMatchObject({
      manual: false,
      splitFrom: { orderId: 'o1', orderNumber: 'FTM20260830-SRC', movedCny: 500 },
    });

    // 拆单流水 + 双侧 CRITICAL 审计
    expect(mockPrisma.orderSplitRecord.create).toHaveBeenCalledTimes(1);
    const record = mockPrisma.orderSplitRecord.create.mock.calls[0][0].data;
    expect(record).toMatchObject({
      sourceOrderId: 'o1',
      targetOrderId: 'o2',
      passengerCount: 1,
      requestToken: TOKEN,
      createdById: 'admin-1',
    });
    expect(record.snapshot.movedPassengerIds).toEqual(['p1']);
    expect(record.snapshot.rows).toHaveLength(2);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(2);

    // 新单操作费计提
    expect(mockPrisma.orderCostItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'o2', category: 'OPERATION_FEE' }),
      }),
    );
  });

  it('已结清单拆单（闸 13 放开后）：两侧各自结清，paid/total 守恒', async () => {
    armExecute({
      order: baseOrder({ status: 'PAID', paidAmount: 2000 }),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 1000, paidAmount: 1000 },
      finalTarget: { total: 1000, paidAmount: 1000 },
    });

    const result = await service.splitOrder(
      'o1',
      { passengerIds: ['p1'], requestToken: TOKEN },
      admin,
    );

    // 已结清 → 随拆已收 = 份额（不是被已收余额夹住的部分额）
    expect(result.movedShareCny).toBe(1000);
    expect(result.movedPaidCny).toBe(1000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orderUpdates = mockPrisma.order.update.mock.calls.map((c: any[]) => c[0]);
    const srcUpdate = orderUpdates.find((u) => u.where.id === 'o1');
    const tgtUpdate = orderUpdates.find((u) => u.where.id === 'o2');
    // 源单仍结清（1000/1000）、新单也结清（1000/1000）；合计 total 2000、合计 paid 2000 = 拆前
    expect(Number(srcUpdate.data.total)).toBe(1000);
    expect(Number(srcUpdate.data.paidAmount)).toBe(1000);
    expect(Number(tgtUpdate.data.total)).toBe(1000);
    expect(Number(tgtUpdate.data.paidAmount)).toBe(1000);
    expect(Number(srcUpdate.data.total) + Number(tgtUpdate.data.total)).toBe(2000);
    expect(Number(srcUpdate.data.paidAmount) + Number(tgtUpdate.data.paidAmount)).toBe(2000);

    // 新单继承源单状态（已付款），不会被 advanceOrderToPaid 再推一次
    expect(mockPrisma.order.create.mock.calls[0][0].data.status).toBe('PAID');
    // 承接 Payment = 全额份额，源单等额负额对冲（两侧台账合计不变）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paymentRows = mockPrisma.payment.create.mock.calls.map((c: any[]) => c[0].data);
    expect(Number(paymentRows.find((d) => d.orderId === 'o2').amount)).toBe(1000);
    expect(Number(paymentRows.find((d) => d.orderId === 'o1').amount)).toBe(-1000);
    // 守恒断言通过 → 拆单流水落库
    expect(mockPrisma.orderSplitRecord.create).toHaveBeenCalledTimes(1);
  });

  it('源单台账对称：随拆转出登记等额负额对冲行（Σ源单成功收款 = 拆后已收）', async () => {
    // 前提：源单拆前 paidAmount 500，且这 500 就是台账里唯一一笔 SUCCEEDED 收款。
    const PRE_LEDGER_CNY = 500;
    armExecute({
      order: baseOrder(),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 1000, paidAmount: 0 },
      finalTarget: { total: 1000, paidAmount: 500 },
    });

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = mockPrisma.payment.create.mock.calls.map((c: any[]) => c[0].data);
    const sourceRows = created.filter((d) => d.orderId === 'o1');
    expect(sourceRows).toHaveLength(1);
    const offset = sourceRows[0];
    // 形状与「多付处置」对冲行同一口径：负额 SUCCEEDED、paidAt 留空、创建即视同已核实
    expect(Number(offset.amount)).toBe(-500);
    expect(offset.status).toBe('SUCCEEDED');
    expect(offset.paidAt).toBeNull();
    expect(offset.verifiedAt).not.toBeNull();
    expect(offset.idempotencyKey).toBe(`split-out:o1:${TOKEN}`);
    expect(offset.gatewayPayload).toMatchObject({
      source: 'split-transfer',
      targetOrderId: 'o2',
      requestToken: TOKEN,
      transferredOut: true,
    });

    // 台账合计与订单已收对齐：500 + (−500) = 0 = 拆后源单 paidAmount
    const ledgerAfter =
      PRE_LEDGER_CNY + sourceRows.reduce((sum, d) => sum + Number(d.amount), 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcUpdate = mockPrisma.order.update.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0])
      .find((u) => u.where.id === 'o1');
    expect(ledgerAfter).toBe(Number(srcUpdate.data.paidAmount));
  });

  it('拆后源单再收一笔款，进 PAID 时不会被台账把已收抬回去', async () => {
    // 病灶复现：拆单只减 order.paidAmount、源单台账原封不动 → 源单下次进 PAID 时
    // _updateStatusWithinTx 的 `if (paymentsSum > currentPaid) paidAmount = paymentsSum`
    // 会把随拆转走的钱重新灌回源单，同一笔钱在两张单上各算一次。
    const PRE_LEDGER_CNY = 500;
    armExecute({
      order: baseOrder(),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 1000, paidAmount: 0 },
      finalTarget: { total: 1000, paidAmount: 500 },
    });

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = mockPrisma.payment.create.mock.calls.map((c: any[]) => c[0].data);
    const sourceLedgerAfterSplit =
      PRE_LEDGER_CNY +
      created.filter((d) => d.orderId === 'o1').reduce((sum, d) => sum + Number(d.amount), 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcUpdate = mockPrisma.order.update.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0])
      .find((u) => u.where.id === 'o1');

    // 拆后再确认一笔 300 的收款：台账 +300、order.paidAmount +300（两边同步加）
    const LATER_PAYMENT_CNY = 300;
    const paymentsSum = sourceLedgerAfterSplit + LATER_PAYMENT_CNY;
    const currentPaid = Number(srcUpdate.data.paidAmount) + LATER_PAYMENT_CNY;

    // PAID 分支的重写条件必须为假，否则源单已收凭空多出随拆转走的那份
    expect(paymentsSum).toBeLessThanOrEqual(currentPaid);
  });

  it('执行前重跑准入闸：锁内发现结算价已锁 → BadRequestError，不建新单', async () => {
    armExecute({
      order: baseOrder({ settlementLocked: true }),
      targetItemsSum: 0,
      sourceItemsSum: 0,
      finalSource: { total: 0, paidAmount: 0 },
      finalTarget: { total: 0, paidAmount: 0 },
    });
    await expect(
      service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.orderSplitRecord.create).not.toHaveBeenCalled();
  });
});

describe('拆单 · 调整行归属与平账行', () => {
  it('按人调整行跟人走、整单调整行留守，两侧各一条 ±50 SPLIT 平账行', async () => {
    const order = baseOrder({
      total: 2200,
      subtotal: 2200,
      items: [
        flightItem(),
        flightItem({
          id: 'i_adj_p1',
          kind: 'FEE',
          description: '价格调整：补收',
          quantity: 1,
          unitPrice: 300,
          amount: 300,
          totalCostCny: null,
          unitCostCny: null,
          flightScheduleId: null,
          flightCabin: null,
          passengerId: 'p1',
          metadata: { priceAdjustment: true, reasonCode: 'MISC_FEE' },
        }),
        flightItem({
          id: 'i_adj_whole',
          kind: 'DISCOUNT',
          description: '价格调整：整单优惠',
          quantity: 1,
          unitPrice: -100,
          amount: -100,
          totalCostCny: null,
          unitCostCny: null,
          flightScheduleId: null,
          flightCabin: null,
          passengerId: null,
          metadata: { priceAdjustment: true, reasonCode: 'DISCOUNT' },
        }),
      ],
    });
    // 份额：基准 = (2200 − 300) / 2 = 950；p1 = 950 + 300 = 1250。
    // 目标行合计 = 拆来的机票 1000 + 跟人走的调整 300 = 1300 → 平账 −50（DISCOUNT）。
    // 源侧目标 total = 2200 − 1250 = 950；行合计 = 1000 − 100 = 900 → 平账 +50（FEE）。
    armExecute({
      order,
      targetItemsSum: 1300,
      sourceItemsSum: 900,
      finalSource: { total: 950, paidAmount: 0 },
      finalTarget: { total: 1250, paidAmount: 500 },
    });

    const result = await service.splitOrder(
      'o1',
      { passengerIds: ['p1'], requestToken: TOKEN },
      admin,
    );
    expect(result.movedShareCny).toBe(1250);

    // 按人调整行：UPDATE orderId 搬走，不改金额
    expect(mockPrisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'i_adj_p1' },
      data: { orderId: 'o2' },
    });
    // 整单调整行绝不被搬
    const movedWhole = mockPrisma.orderItem.update.mock.calls.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0].where.id === 'i_adj_whole',
    );
    expect(movedWhole).toBe(false);

    // 平账行：两边各一条，金额对称 ±50，metadata 打 SPLIT 标
    const balanceRows = mockPrisma.orderItem.create.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0].data)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((d: any) => d.metadata?.reasonCode === 'SPLIT');
    expect(balanceRows).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = balanceRows.find((d: any) => d.orderId === 'o2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const source = balanceRows.find((d: any) => d.orderId === 'o1');
    expect(Number(target.amount)).toBe(-50);
    expect(target.kind).toBe('DISCOUNT');
    expect(Number(source.amount)).toBe(50);
    expect(source.kind).toBe('FEE');
    expect(target.metadata).toMatchObject({
      priceAdjustment: true,
      splitFrom: 'FTM20260830-SRC',
      shareCny: 1250,
      itemsSumCny: 1300,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 已出票单拆单（闸 6 / 闸 12 放开后）：票务状态随人搬家。
// ══════════════════════════════════════════════════════════════════════════
describe('拆单 · 已出票单：票务状态随人搬家', () => {
  /** 已出票的 2 人单：去程与系统已开、乘客各有 PNR/票号、拆分行上有已确认出票任务。 */
  const ticketedOrder = () =>
    baseOrder({
      status: 'TICKETED',
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: true,
      passengers: [
        pax('p1', { pnr: 'ABC123', eticketNumber: '999-1234567890' }),
        pax('p2', { pnr: 'ABC123', eticketNumber: '999-1234567891' }),
      ],
    });

  const armTicketed = (over: Partial<ExecuteArmOptions> = {}) =>
    armExecute({
      order: ticketedOrder(),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: {
        total: 1000,
        paidAmount: 0,
        outboundInvoiced: true,
        systemInvoiced: true,
        passengerCount: 1,
      },
      finalTarget: {
        total: 1000,
        paidAmount: 500,
        outboundInvoiced: true,
        systemInvoiced: true,
        passengerCount: 1,
      },
      sourceTicketingTasks: [
        {
          orderItemId: 'i1',
          status: 'CONFIRMED',
          data: { pnr: 'ABC123' },
          notes: '票务台已出票',
          startedAt: new Date('2026-08-20T02:00:00.000Z'),
          completedAt: new Date('2026-08-21T02:00:00.000Z'),
        },
      ],
      ...over,
    });

  it('新单复制源单三个开票位，源单开票位一个不动', async () => {
    armTicketed();

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    const created = mockPrisma.order.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srcUpdate = mockPrisma.order.update.mock.calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any[]) => c[0])
      .find((u) => u.where.id === 'o1');
    expect(srcUpdate.data).not.toHaveProperty('outboundInvoiced');
    expect(srcUpdate.data).not.toHaveProperty('returnInvoiced');
    expect(srcUpdate.data).not.toHaveProperty('systemInvoiced');
  });

  it('乘客整行搬家：PNR/票号原样跟人走（拆单不清票）', async () => {
    armTicketed();

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    expect(mockPrisma.passenger.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1'] }, orderId: 'o1' },
      data: { orderId: 'o2' },
    });
    // 拆单只改归属，绝不清票号（清票是改期 3b 的活，且只清新单那一侧）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clearedTickets = mockPrisma.passenger.updateMany.mock.calls.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0]?.data?.pnr === null || c[0]?.data?.eticketNumber === null,
    );
    expect(clearedTickets).toBe(false);
  });

  it('新单拆分行的出票任务镜像源单：CONFIRMED + 票务 data + 备注留拆单来源', async () => {
    armTicketed();

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    expect(mockPrisma.fulfillmentTask.update).toHaveBeenCalledTimes(1);
    const mirrored = mockPrisma.fulfillmentTask.update.mock.calls[0][0];
    expect(mirrored.where).toEqual({ id: 'task-1' });
    expect(mirrored.data).toMatchObject({
      status: 'CONFIRMED',
      data: { pnr: 'ABC123' },
    });
    expect(mirrored.data.notes).toBe('票务台已出票 · 由订单 FTM20260830-SRC 拆分创建');
  });

  it('源行没有活动出票任务 → 不镜像，新任务维持 PENDING', async () => {
    armTicketed({ sourceTicketingTasks: [] });

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    expect(mockPrisma.fulfillmentTask.update).not.toHaveBeenCalled();
  });

  it('出票人数守恒断言：新单漏抄开票位 → 抛错回滚（拆单流水不落库）', async () => {
    // 蓄意做坏：拆前去程已开（2 人占额），拆后只剩源单 1 人占额 → 额度凭空少一份。
    armTicketed({
      finalTarget: {
        total: 1000,
        paidAmount: 500,
        outboundInvoiced: false,
        systemInvoiced: true,
        passengerCount: 1,
      },
    });

    await expect(
      service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin),
    ).rejects.toThrow(/守恒断言失败：开票维度 outboundInvoiced/);
    expect(mockPrisma.orderSplitRecord.create).not.toHaveBeenCalled();
  });
});

describe('拆单 · 幂等与守恒兜底', () => {
  it('同 (源单, requestToken) 已拆过 → 直接回放，不进事务', async () => {
    mockPrisma.orderSplitRecord.findUnique.mockResolvedValue({
      sourceOrderId: 'o1',
      targetOrderId: 'o2',
      passengerCount: 1,
      movedShareCny: 1000,
      movedPaidCny: 500,
      requestToken: TOKEN,
      sourceOrder: { orderNumber: 'FTM-SRC' },
      targetOrder: { orderNumber: 'FTM-TGT' },
    });
    const result = await service.splitOrder(
      'o1',
      { passengerIds: ['p1'], requestToken: TOKEN },
      admin,
    );
    expect(result).toEqual({
      sourceOrderId: 'o1',
      sourceOrderNumber: 'FTM-SRC',
      targetOrderId: 'o2',
      targetOrderNumber: 'FTM-TGT',
      movedShareCny: 1000,
      movedPaidCny: 500,
      passengerCount: 1,
      replayed: true,
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.orderSplitRecord.create).not.toHaveBeenCalled();
  });

  it('total 守恒断言不平 → 抛错回滚（拆单流水不落库）', async () => {
    armExecute({
      order: baseOrder(),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 999, paidAmount: 0 }, // 蓄意做坏：合计 1999 ≠ 拆前 2000
      finalTarget: { total: 1000, paidAmount: 500 },
    });
    await expect(
      service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin),
    ).rejects.toThrow(/守恒断言失败/);
    expect(mockPrisma.orderSplitRecord.create).not.toHaveBeenCalled();
  });

  it('座位数量守恒断言不平（拆后凭空少 1 座）→ 抛错回滚', async () => {
    armExecute({
      order: baseOrder(),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 1000, paidAmount: 0 },
      finalTarget: { total: 1000, paidAmount: 500 },
      conservationRows: [
        { kind: 'FLIGHT', flightScheduleId: 'sch1', flightCabin: 'ECONOMY', quantity: 1 },
      ],
    });
    await expect(
      service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin),
    ).rejects.toThrow(/守恒断言失败/);
    expect(mockPrisma.orderSplitRecord.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// A5：会话/座位账快照不跨单继承
// ══════════════════════════════════════════════════════════════════════════
describe('拆单 · 不继承 no-show / 释放 / 取消航段快照', () => {
  const snapshotMeta = {
    // 业务键：该继承的照常继承。
    businessUpgradeCount: 0,
    goDate: '2026-09-10',
    // 会话/座位账快照：一律剔除（requestToken 跨单重复会命中别单的幂等回放；
    // releasedSeats 跟着走会让新单「恢复回程」凭空多占座）。
    noShow: { at: '2026-09-02T03:00:00.000Z', requestToken: TOKEN },
    returnReleased: {
      at: '2026-09-02T03:00:00.000Z',
      requestToken: TOKEN,
      releasedSeats: [{ scheduleId: 'sch1', cabin: 'ECONOMY', quantity: 2 }],
    },
    returnRestored: { at: '2026-09-02T04:00:00.000Z', requestToken: TOKEN },
    returnVoidedFinal: { at: '2026-09-02T05:00:00.000Z' },
    returnLegCancelled: { at: '2026-09-02T06:00:00.000Z', originalAmountCny: 3000 },
  };

  it('拆出的新行只带业务键，五个快照键一个都不复制', async () => {
    armExecute({
      order: baseOrder({ items: [flightItem({ metadata: snapshotMeta })] }),
      targetItemsSum: 1000,
      sourceItemsSum: 1000,
      finalSource: { total: 1000, paidAmount: 0 },
      finalTarget: { total: 1000, paidAmount: 500 },
    });

    await service.splitOrder('o1', { passengerIds: ['p1'], requestToken: TOKEN }, admin);

    const splitCreate = mockPrisma.orderItem.create.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[0].data.kind === 'FLIGHT',
    );
    const meta = splitCreate?.[0].data.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ goDate: '2026-09-10', splitFromItemId: 'i1' });
    for (const key of [
      'noShow',
      'returnReleased',
      'returnRestored',
      'returnVoidedFinal',
      'returnLegCancelled',
    ]) {
      expect(meta).not.toHaveProperty(key);
    }
  });

  it('预检提示：源单去程已标 no-show，拆出的新单不会自动带标记', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      baseOrder({ items: [flightItem({ metadata: { noShow: { at: '2026-09-02T03:00:00.000Z' } } })] }),
    );
    armCleanGates();
    const preview = await service.previewOrderSplit('o1', { passengerIds: ['p1'] }, admin);
    expect(preview.warnings.join('')).toContain('拆出的新单不会自动带标记');
  });
});
