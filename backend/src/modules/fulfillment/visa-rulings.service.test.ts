/**
 * 签证口径台账（特征测试 · 写入路径 / 签证台 / 提醒）—— 与 visa-rulings.test.ts 配套。
 *
 * 这里钉的是「谁在什么时候写哪一列」的现状：收拢成状态机后这些写入必须原样发生
 * （同样的列、同样的条件），签证台统计条与提醒规则读到的数字也必须一个不变。
 *
 * 台账：
 *   0830  签证台标「已送签」→ 非自备签乘客全部 CONFIRMED 且确有我方任务 → 订单自动 HAS_VISA；
 *         任一乘客退回 → 仅当已签证是派生写的（审计可查）才对称回退；录单手选的已签证绝不回退；
 *         回退会造出矛盾单（全员自备签）时保持已签证不回退
 *   0830  任务级流转 = 作用于该单**全部非自备签**乘客（旧的整单批量入口语义保留）
 *   0830  签证台对数条：按整个筛选范围内订单的**非自备签**乘客按送签进度分组计数
 *   0828  按人批量标记：自备签乘客一律拒绝（「该乘客自备签证，无需送签」），其余照常
 *   待拍板（保持现状）：代理自助把订单改成「不需要签证」→ 与运营同样触发签证任务同步，
 *         该单「待处理」签证任务被撤销（是否该否决未拍板，这里只钉现状）
 *   提醒：VISA_MISSING 只催非自备签且缺护照图的乘客；VISA_NOT_SUBMITTED 只催非自备签且
 *         送签进度 ≠ 已送签的乘客
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FulfillmentStatus,
  FulfillmentType,
  OrderStatus,
  UserRole,
  VisaRequirement,
  VisaSubmissionStatus,
  type PrismaClient,
} from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findMany: vi.fn() },
    passenger: { findMany: vi.fn(), updateMany: vi.fn(), groupBy: vi.fn() },
    bundle: { findUnique: vi.fn() },
    fulfillmentTask: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  writeAuditWithinTx: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { FulfillmentService } from './fulfillment.service.js';
import { syncOrderVisaCompletion, VISA_AUTO_COMPLETE_ACTION } from './visa-completion.js';
import { OrderService } from '../orders/orders.service.js';
import { generateRuleReminders } from '../reminders/reminders.rules.js';

const { CONFIRMED, IN_PROGRESS, PENDING } = VisaSubmissionStatus;
const STAFF = { userId: 'u-staff', role: UserRole.STAFF } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(mockPrisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  mockPrisma.order.update.mockResolvedValue({});
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.fulfillmentTask.count.mockResolvedValue(0);
  mockPrisma.passenger.updateMany.mockResolvedValue({ count: 1 });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0830 · 办结派生：全员（非自备签）已送签 → 订单 HAS_VISA；回退对称', () => {
  function mountOrder(opts: {
    visaStatus: VisaRequirement;
    roster: Array<{ visaExempt: boolean; visaSubmissionStatus: VisaSubmissionStatus }>;
    ourTaskCount?: number;
    lastAudit?: { action: string; before: unknown } | null;
  }) {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM-1',
      visaStatus: opts.visaStatus,
      deletedAt: null,
    });
    mockPrisma.passenger.findMany.mockResolvedValue(opts.roster);
    mockPrisma.fulfillmentTask.count.mockResolvedValue(opts.ourTaskCount ?? 1);
    mockPrisma.auditLog.findFirst.mockResolvedValue(opts.lastAudit ?? null);
  }

  it('两位随团 + 一位自备签：随团两位都已送签 → 办结（自备签的人不参与判定）', async () => {
    mountOrder({
      visaStatus: VisaRequirement.NEEDED,
      roster: [
        { visaExempt: false, visaSubmissionStatus: CONFIRMED },
        { visaExempt: false, visaSubmissionStatus: CONFIRMED },
        { visaExempt: true, visaSubmissionStatus: PENDING },
      ],
    });
    const res = await syncOrderVisaCompletion('o1', STAFF);
    expect(res).toEqual({ changed: true, kind: 'COMPLETED', orderNumber: 'FTM-1' });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { visaStatus: VisaRequirement.HAS_VISA },
    });
  });

  it('还有人在材料准备 → 不办结；无我方任务（录单已签证/全员自备签的单）→ 不办结', async () => {
    mountOrder({
      visaStatus: VisaRequirement.NEEDED,
      roster: [
        { visaExempt: false, visaSubmissionStatus: CONFIRMED },
        { visaExempt: false, visaSubmissionStatus: IN_PROGRESS },
      ],
    });
    expect(await syncOrderVisaCompletion('o1', STAFF)).toEqual({ changed: false });
    mountOrder({
      visaStatus: VisaRequirement.NEEDED,
      roster: [{ visaExempt: false, visaSubmissionStatus: CONFIRMED }],
      ourTaskCount: 0,
    });
    expect(await syncOrderVisaCompletion('o1', STAFF)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('派生写的已签证 + 有人退回 → 恢复办结前原档（E_VISA）；录单手选的已签证（无办结审计）绝不回退', async () => {
    mountOrder({
      visaStatus: VisaRequirement.HAS_VISA,
      roster: [
        { visaExempt: false, visaSubmissionStatus: CONFIRMED },
        { visaExempt: false, visaSubmissionStatus: PENDING },
      ],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'E_VISA' } },
    });
    expect(await syncOrderVisaCompletion('o1', STAFF)).toEqual({
      changed: true,
      kind: 'REVERTED',
      orderNumber: 'FTM-1',
      restoredTo: VisaRequirement.E_VISA,
    });
    mockPrisma.order.update.mockClear();
    mountOrder({
      visaStatus: VisaRequirement.HAS_VISA,
      roster: [{ visaExempt: false, visaSubmissionStatus: PENDING }],
      lastAudit: null,
    });
    expect(await syncOrderVisaCompletion('o1', STAFF)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('回退会造出矛盾单（全员已改自备签）→ 保持已签证不回退（签证台本就无事可做）', async () => {
    mountOrder({
      visaStatus: VisaRequirement.HAS_VISA,
      roster: [
        { visaExempt: true, visaSubmissionStatus: PENDING },
        { visaExempt: true, visaSubmissionStatus: PENDING },
      ],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'NEEDED' } },
    });
    expect(await syncOrderVisaCompletion('o1', STAFF)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0830 · 任务级流转作用于该单全部非自备签乘客（整单一起推进）', () => {
  const taskRow = (status: FulfillmentStatus) => ({
    id: 't1',
    orderItemId: 'oi1',
    type: FulfillmentType.VISA_APPLICATION,
    status,
    data: null,
    notes: null,
    attempts: 0,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    failureReason: null,
    assigneeUserId: null,
    visaUnitCostUsd: null,
    visaFxRate: null,
    visaUnitCostCny: null,
    visaSupplier: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    orderItem: {
      id: 'oi1',
      kind: 'VISA',
      description: '签证',
      quantity: 2,
      orderId: 'o1',
      order: {
        id: 'o1',
        orderNumber: 'FTM-1',
        contactName: 'A',
        contactPhone: '1',
        status: OrderStatus.PAID,
        notes: null,
        deletedAt: null,
      },
    },
  });

  it('把签证任务标 CONFIRMED → 该单所有 visaExempt=false 的乘客送签进度一起写成 CONFIRMED，并触发办结派生', async () => {
    mockPrisma.fulfillmentTask.findUnique
      .mockResolvedValueOnce(taskRow(FulfillmentStatus.IN_PROGRESS))
      .mockResolvedValueOnce(taskRow(FulfillmentStatus.CONFIRMED));
    // 办结派生读订单：null = 不存在 → 零写入（派生本身有专属台账）
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const service = new FulfillmentService();

    await service.update('t1', { status: FulfillmentStatus.CONFIRMED }, STAFF);

    expect(mockPrisma.passenger.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', visaExempt: false },
      data: { visaSubmissionStatus: CONFIRMED },
    });
    expect(mockPrisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1' } }),
    );
  });

  it('任务级 CANCELLED / FAILED 是任务独有终态 → 不改任何乘客的送签进度', async () => {
    mockPrisma.fulfillmentTask.findUnique.mockResolvedValue(taskRow(FulfillmentStatus.PENDING));
    mockPrisma.fulfillmentTask.update.mockResolvedValue(taskRow(FulfillmentStatus.FAILED));
    const service = new FulfillmentService();

    await service.update('t1', { status: FulfillmentStatus.FAILED }, STAFF);

    expect(mockPrisma.passenger.updateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0828 · 按人批量标记：自备签乘客一律拒绝，其余改写后按单重派生任务状态', () => {
  it('两位随团 + 一位自备签 → 只写随团两位；自备签的人进 failures；任务状态按人重派生一次', async () => {
    mockPrisma.passenger.findMany
      .mockResolvedValueOnce([
        { id: 'p1', orderId: 'o1', visaExempt: false, order: { status: 'PAID', deletedAt: null } },
        { id: 'p2', orderId: 'o1', visaExempt: false, order: { status: 'PAID', deletedAt: null } },
        { id: 'p3', orderId: 'o1', visaExempt: true, order: { status: 'PAID', deletedAt: null } },
      ])
      // rederive：该单非自备签乘客现势（两位都已送签）
      .mockResolvedValueOnce([
        { visaSubmissionStatus: CONFIRMED },
        { visaSubmissionStatus: CONFIRMED },
      ]);
    mockPrisma.order.findUnique.mockResolvedValue(null); // 办结派生零写入
    const service = new FulfillmentService();

    const res = await service.batchUpdateVisaPassengerStatus(['p1', 'p2', 'p3'], CONFIRMED, STAFF);

    expect(res.failures).toEqual([{ id: 'p3', error: '该乘客自备签证，无需送签' }]);
    expect(mockPrisma.passenger.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] } },
      data: { visaSubmissionStatus: CONFIRMED },
    });
    // 任务级 = 非自备签乘客进度最低档 → 两位都已送签 → CONFIRMED，并盖 completedAt
    expect(mockPrisma.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: {
        orderItem: { orderId: 'o1' },
        type: FulfillmentType.VISA_APPLICATION,
        status: {
          in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS, FulfillmentStatus.CONFIRMED],
        },
      },
      data: { status: FulfillmentStatus.CONFIRMED, completedAt: expect.any(Date) },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('0830 · 签证台对数条：筛选范围内订单的非自备签乘客按送签进度计数', () => {
  const listRow = () => ({
    id: 'task-1',
    orderItemId: 'itm-1',
    type: FulfillmentType.VISA_APPLICATION,
    status: FulfillmentStatus.PENDING,
    data: null,
    notes: null,
    attempts: 0,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    failureReason: null,
    assigneeUserId: null,
    visaUnitCostUsd: null,
    visaFxRate: null,
    visaUnitCostCny: null,
    visaSupplier: null,
    createdAt: new Date('2026-07-15T00:00:00Z'),
    updatedAt: new Date('2026-07-15T00:00:00Z'),
    orderItem: {
      id: 'itm-1',
      kind: 'FLIGHT',
      description: '机票行',
      quantity: 1,
      orderId: 'ord-1',
      visa: null,
      order: {
        id: 'ord-1',
        orderNumber: 'FTM-TEST-1',
        contactName: '联系人',
        contactPhone: '100',
        status: OrderStatus.PAID,
        notes: null,
        visaStatus: VisaRequirement.NEEDED,
      },
    },
  });

  it('passengerStats 按「命中任务的订单集合 × visaExempt=false」groupBy，数字 = 已送/材料准备/待送三档', async () => {
    mockPrisma.fulfillmentTask.findMany.mockImplementation(async (args: { select?: unknown }) =>
      args?.select ? [{ orderItem: { orderId: 'ord-1' } }] : [listRow()],
    );
    mockPrisma.fulfillmentTask.count.mockResolvedValue(1);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.orderItem.findMany.mockResolvedValue([]);
    mockPrisma.passenger.groupBy.mockResolvedValue([
      { visaSubmissionStatus: CONFIRMED, _count: { _all: 3 } },
      { visaSubmissionStatus: PENDING, _count: { _all: 1 } },
    ]);
    const service = new FulfillmentService();

    const res = await service.list({
      page: 1,
      pageSize: 50,
      type: FulfillmentType.VISA_APPLICATION,
      status: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS],
    });

    expect(res.passengerStats).toEqual({ pending: 1, inProgress: 0, confirmed: 3 });
    expect(mockPrisma.passenger.groupBy).toHaveBeenCalledWith({
      by: ['visaSubmissionStatus'],
      where: { orderId: { in: ['ord-1'] }, visaExempt: false },
      _count: { _all: true },
    });
    // 统计范围 = 与列表同一个 where（整个筛选范围，不是当前页）
    const statCall = mockPrisma.fulfillmentTask.findMany.mock.calls.find((c) => c[0]?.select);
    const listCall = mockPrisma.fulfillmentTask.findMany.mock.calls.find((c) => c[0]?.include);
    expect(statCall?.[0].where).toEqual(listCall?.[0].where);
  });

  it('非签证任务列表 → 不算统计条（passengerStats=null，也不查乘客）', async () => {
    mockPrisma.fulfillmentTask.findMany.mockResolvedValue([]);
    mockPrisma.fulfillmentTask.count.mockResolvedValue(0);
    const service = new FulfillmentService();
    const res = await service.list({ page: 1, pageSize: 50, type: FulfillmentType.HOTEL_BOOKING });
    expect(res.passengerStats).toBeNull();
    expect(mockPrisma.passenger.groupBy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('待拍板（保持现状）· 代理自助改「不需要签证」→ 与运营同样撤销该单待处理签证任务', () => {
  it('AGENT 调 setOrderVisaStatus(NOT_NEEDED) → 事务内跑任务同步，PENDING 签证任务被置 CANCELLED', async () => {
    // 首查（矛盾闸用）读到改前的 NEEDED；事务内任务同步（evaluateOrderVisaTaskState）读到已落库的 NOT_NEEDED
    mockPrisma.order.findUnique
      .mockResolvedValueOnce({
        visaStatus: VisaRequirement.NEEDED,
        status: OrderStatus.PAID,
        deletedAt: null,
        passengers: [{ visaExempt: false }],
      })
      .mockResolvedValue({
        visaStatus: VisaRequirement.NOT_NEEDED,
        orderNumber: 'FTM-1',
        status: OrderStatus.PAID,
        deletedAt: null,
      });
    mockPrisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'i1',
        kind: 'VISA',
        bundleId: null,
        fulfillmentTasks: [
          { id: 'task-pending', type: FulfillmentType.VISA_APPLICATION, status: FulfillmentStatus.PENDING },
        ],
      },
    ]);
    mockPrisma.passenger.findMany.mockResolvedValue([{ visaExempt: false }]);
    const service = new OrderService();

    const res = await service.setOrderVisaStatus(
      'o1',
      VisaRequirement.NOT_NEEDED,
      { userId: 'u-agent', role: UserRole.AGENT, agentId: 'ag1' },
      { withOrder: false },
    );

    expect(res).toMatchObject({ changed: true, before: VisaRequirement.NEEDED, after: VisaRequirement.NOT_NEEDED });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { visaStatus: VisaRequirement.NOT_NEEDED },
    });
    expect(mockPrisma.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['task-pending'] }, status: FulfillmentStatus.PENDING },
      data: { status: FulfillmentStatus.CANCELLED },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('提醒 · VISA_MISSING / VISA_NOT_SUBMITTED 的乘客圈定与签证台同口径', () => {
  function reminderPrisma() {
    const passengerFindMany = vi.fn(async () => []);
    const raw = {
      order: { findMany: vi.fn(async () => []) },
      fulfillmentTask: { findMany: vi.fn(async () => []) },
      passenger: { findMany: passengerFindMany },
      operationalReminder: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    return { prisma: raw as unknown as PrismaClient, raw, passengerFindMany };
  }

  it('VISA_MISSING：在办签证任务下只取 visaExempt=false 且缺护照图的乘客', async () => {
    const { prisma, raw } = reminderPrisma();
    await generateRuleReminders(prisma, 'user_sys');
    const args = (raw.fulfillmentTask.findMany.mock.calls[0] as unknown[])[0] as {
      where: { status: { in: FulfillmentStatus[] }; type: FulfillmentType };
      select: {
        orderItem: { select: { order: { select: { passengers: { where: Record<string, unknown> } } } } };
      };
    };
    expect(args.where.type).toBe(FulfillmentType.VISA_APPLICATION);
    expect(args.where.status.in).toEqual([FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS]);
    expect(args.select.orderItem.select.order.select.passengers.where).toEqual({
      visaExempt: false,
      OR: [{ passportPhotoUrl: null }, { passportPhotoUrl: '' }],
    });
  });

  it('VISA_NOT_SUBMITTED：范围 = 有在办签证任务的订单；乘客圈定 visaExempt=false 且进度 ≠ CONFIRMED', async () => {
    const { prisma, raw, passengerFindMany } = reminderPrisma();
    raw.fulfillmentTask.findMany = vi.fn(async () => [
      {
        id: 'task-1',
        orderItem: {
          order: {
            id: 'ord-1',
            orderNumber: 'FTM-1',
            deletedAt: null,
            items: [],
            passengers: [],
          },
        },
      },
    ]);
    await generateRuleReminders(prisma, 'user_sys');
    expect(passengerFindMany).toHaveBeenCalledWith({
      where: {
        orderId: { in: ['ord-1'] },
        visaExempt: false,
        visaSubmissionStatus: { not: CONFIRMED },
      },
      select: { orderId: true, fullName: true },
    });
  });
});
