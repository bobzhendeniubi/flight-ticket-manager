/**
 * 签证任务事件驱动同步（syncVisaTasksForOrder）· 服务级测试（vitest）
 *
 * 背景：建任务的三条路径历来只补不删——订单改成「不需要签证」、或乘客全部改成自备签之后，
 * 早先建的 PENDING 任务还挂在签证台上，签证岗看到一条永远办不掉、点进去零乘客的「待处理」。
 *
 * 覆盖：
 *   1. 不再需要签证（订单级 NOT_NEEDED / HAS_VISA / 全员自备签）→ PENDING 签证任务置 CANCELLED；
 *   2. 已经在办 / 已出结果的任务（IN_PROGRESS / CONFIRMED / FAILED）→ 一律不碰；
 *   3. 需求改回「需要」且只剩终态任务 → 按锚点补建一条 PENDING；
 *   4. 幂等：已有活动任务不重复建、没有 PENDING 可撤时零写入；
 *   5. 锚点口径与建单一致：VISA 行 → 含签证组件的套餐行 → 订单级需签时首个订单项；
 *   6. 不参与履约的单（取消族终态 / 已软删）一律判「不需要任务」——改备注不会给已取消的单
 *      凭空补出 PENDING，残留的 PENDING 反被顺手撤掉；
 *   7. 补建前的同事务 re-check：并发已经补建过一条时不再建第二条。
 *
 * 用 vi.mock 把 Prisma 换成可控 stub，不依赖真 DB（tx 与 prisma 共用同一批 vi.fn()）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FulfillmentStatus, FulfillmentType, UserRole, VisaRequirement } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderItem: { findMany: vi.fn() },
    passenger: { findMany: vi.fn() },
    bundle: { findUnique: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    // 换人挂接点用：swapPassenger 走 prisma.$transaction(async (tx) => ...)
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// 审计是 fire-and-forget（走全局 prisma、不进业务事务）；mock 掉避免真写库。
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService, syncVisaTasksForOrder } from './orders.service.js';
import { writeAudit } from '../../lib/audit.js';

interface StubItem {
  id: string;
  kind: string;
  bundleId?: string | null;
  tasks?: Array<{ id: string; type: string; status: string }>;
}

/** 装配一单的库存量：订单级签证状态 / 订单状态 / 软删 / 订单项（含既有任务）/ 乘客自备签 / 套餐组件。 */
function seed(opts: {
  visaStatus?: VisaRequirement | null;
  /** 订单状态；缺省 PAID（正常在途单）。 */
  status?: string;
  /** 软删时间戳；缺省 null（未进回收站）。 */
  deletedAt?: Date | null;
  items: StubItem[];
  passengers?: Array<{ visaExempt: boolean }>;
  bundleItems?: Array<{ kind: string }> | null;
}): void {
  mockPrisma.order.findUnique.mockResolvedValue({
    visaStatus: opts.visaStatus ?? null,
    orderNumber: 'ORD-0001',
    status: opts.status ?? 'PAID',
    deletedAt: opts.deletedAt ?? null,
  });
  mockPrisma.orderItem.findMany.mockResolvedValue(
    opts.items.map((it) => ({
      id: it.id,
      kind: it.kind,
      bundleId: it.bundleId ?? null,
      fulfillmentTasks: it.tasks ?? [],
    })),
  );
  mockPrisma.passenger.findMany.mockResolvedValue(opts.passengers ?? [{ visaExempt: false }]);
  mockPrisma.bundle.findUnique.mockResolvedValue(
    opts.bundleItems === null ? null : { items: opts.bundleItems ?? [] },
  );
}

const pendingVisaTask = (id = 'task_pending') => ({
  id,
  type: FulfillmentType.VISA_APPLICATION,
  status: FulfillmentStatus.PENDING,
});

const run = () =>
  syncVisaTasksForOrder(
    mockPrisma as unknown as Parameters<typeof syncVisaTasksForOrder>[0],
    'ord1',
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.fulfillmentTask.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 'task_new', ...data }),
  );
  mockPrisma.fulfillmentTask.updateMany.mockResolvedValue({ count: 1 });
  // 补建前的同事务 re-check：缺省「没有并发建过」，需要模拟并发的用例各自覆盖。
  mockPrisma.fulfillmentTask.findFirst.mockResolvedValue(null);
});

describe('syncVisaTasksForOrder · 不再需要签证 → 撤销待处理任务', () => {
  it('订单级改成「不需要签证」→ PENDING 任务置 CANCELLED（签证台不再挂僵尸待处理）', async () => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [{ id: 'itm_flight', kind: 'FLIGHT', tasks: [pendingVisaTask()] }],
    });
    const result = await run();
    expect(result.needed).toBe(false);
    expect(result.cancelledTaskIds).toEqual(['task_pending']);
    expect(mockPrisma.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['task_pending'] }, status: FulfillmentStatus.PENDING },
      data: { status: FulfillmentStatus.CANCELLED },
    });
  });

  it('客人已有签证（HAS_VISA）→ 同样撤销', async () => {
    seed({
      visaStatus: VisaRequirement.HAS_VISA,
      items: [{ id: 'itm_flight', kind: 'FLIGHT', tasks: [pendingVisaTask()] }],
    });
    expect((await run()).cancelledTaskIds).toEqual(['task_pending']);
  });

  it('全员改自备签（订单含 VISA 行）→ 撤销：任务点进去本就是零乘客的空壳', async () => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      items: [{ id: 'itm_visa', kind: 'VISA', tasks: [pendingVisaTask()] }],
      passengers: [{ visaExempt: true }, { visaExempt: true }],
    });
    const result = await run();
    expect(result.needed).toBe(false);
    expect(result.cancelledTaskIds).toEqual(['task_pending']);
  });

  it('撤销时写 VISA_TASK_AUTO_CANCELLED 审计（INFO）', async () => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [{ id: 'itm_flight', kind: 'FLIGHT', tasks: [pendingVisaTask()] }],
    });
    await run();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VISA_TASK_AUTO_CANCELLED', severity: 'INFO' }),
    );
  });

  it('多条 PENDING 任务一并撤销', async () => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [
        { id: 'itm_a', kind: 'FLIGHT', tasks: [pendingVisaTask('t1')] },
        { id: 'itm_b', kind: 'HOTEL', tasks: [pendingVisaTask('t2')] },
      ],
    });
    expect((await run()).cancelledTaskIds).toEqual(['t1', 't2']);
  });
});

describe('syncVisaTasksForOrder · 只动 PENDING，已在办/已出结果的一律不碰', () => {
  it.each([
    [FulfillmentStatus.IN_PROGRESS, '签证岗已经在办'],
    [FulfillmentStatus.CONFIRMED, '已出签'],
    [FulfillmentStatus.FAILED, '已出结果（失败）'],
  ])('%s（%s）→ 不撤销、不写库', async (status) => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [
        {
          id: 'itm_visa',
          kind: 'VISA',
          tasks: [{ id: 'task_busy', type: FulfillmentType.VISA_APPLICATION, status }],
        },
      ],
      passengers: [{ visaExempt: true }],
    });
    const result = await run();
    expect(result.cancelledTaskIds).toEqual([]);
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
  });

  it('混合：一条在办 + 一条待处理 → 只撤待处理那条', async () => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [
        {
          id: 'itm_visa',
          kind: 'VISA',
          tasks: [
            {
              id: 'task_busy',
              type: FulfillmentType.VISA_APPLICATION,
              status: FulfillmentStatus.IN_PROGRESS,
            },
            pendingVisaTask('task_idle'),
          ],
        },
      ],
      passengers: [{ visaExempt: true }],
    });
    expect((await run()).cancelledTaskIds).toEqual(['task_idle']);
  });

  it('其它岗任务（酒店/接送）不受影响：撤销只针对 VISA_APPLICATION', async () => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [
        {
          id: 'itm_hotel',
          kind: 'HOTEL',
          tasks: [
            {
              id: 'task_hotel',
              type: FulfillmentType.HOTEL_BOOKING,
              status: FulfillmentStatus.PENDING,
            },
          ],
        },
      ],
    });
    const result = await run();
    expect(result.cancelledTaskIds).toEqual([]);
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
  });
});

describe('syncVisaTasksForOrder · 需求改回「需要」→ 补建待处理任务', () => {
  it('订单级改回 NEEDED 且只剩已取消的任务 → 补建一条 PENDING（不复活终态任务）', async () => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      items: [
        {
          id: 'itm_flight',
          kind: 'FLIGHT',
          tasks: [
            {
              id: 'task_old',
              type: FulfillmentType.VISA_APPLICATION,
              status: FulfillmentStatus.CANCELLED,
            },
          ],
        },
      ],
    });
    const result = await run();
    expect(result.needed).toBe(true);
    expect(result.createdTaskIds).toEqual(['task_new']);
    expect(mockPrisma.fulfillmentTask.create).toHaveBeenCalledWith({
      data: {
        orderItemId: 'itm_flight',
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.PENDING,
      },
    });
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VISA_TASK_AUTO_RECREATED', severity: 'INFO' }),
    );
  });

  it('最后一位自备签客人改回随团办签 → 补建（锚点=VISA 行）', async () => {
    seed({
      visaStatus: null,
      items: [
        {
          id: 'itm_visa',
          kind: 'VISA',
          tasks: [
            {
              id: 'task_old',
              type: FulfillmentType.VISA_APPLICATION,
              status: FulfillmentStatus.CANCELLED,
            },
          ],
        },
      ],
      passengers: [{ visaExempt: false }],
    });
    const result = await run();
    expect(result.createdTaskIds).toEqual(['task_new']);
    expect(mockPrisma.fulfillmentTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderItemId: 'itm_visa' }) }),
    );
  });

  it('锚点=含签证组件的套餐行（套餐单没有独立 VISA 行）', async () => {
    seed({
      visaStatus: null,
      items: [
        { id: 'itm_flight', kind: 'FLIGHT' },
        { id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' },
      ],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
    });
    await run();
    expect(mockPrisma.fulfillmentTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderItemId: 'itm_bundle' }) }),
    );
  });

  it('幂等：已有活动（PENDING）任务 → 不重复建、不撤销', async () => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      items: [{ id: 'itm_flight', kind: 'FLIGHT', tasks: [pendingVisaTask()] }],
    });
    const result = await run();
    expect(result.needed).toBe(true);
    expect(result.createdTaskIds).toEqual([]);
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
  });

  it('与签证无关的单（无 VISA 行、订单级未填）→ 零写入', async () => {
    seed({ visaStatus: null, items: [{ id: 'itm_flight', kind: 'FLIGHT' }] });
    const result = await run();
    expect(result.needed).toBe(false);
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
    expect(mockPrisma.fulfillmentTask.updateMany).not.toHaveBeenCalled();
  });

  it('未录乘客 + 订单级需签（电子签）→ 仍判需要（空名单 ≠ 无人需要，不漏单）', async () => {
    seed({
      visaStatus: VisaRequirement.E_VISA,
      items: [{ id: 'itm_flight', kind: 'FLIGHT' }],
      passengers: [],
    });
    const result = await run();
    expect(result.needed).toBe(true);
    expect(result.createdTaskIds).toEqual(['task_new']);
  });

  it('订单不存在 → 安全返回，零写入', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const result = await run();
    expect(result).toEqual({ needed: false, cancelledTaskIds: [], createdTaskIds: [] });
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 不参与履约的单：取消族终态 / 已软删 → 一律判「不需要任务」
// 此前只看签证口径：一张已取消的需签单，改一次备注（=改订单级签证状态）就会被补出一条
// PENDING，签证台上冒出根本不用办的活；回收站里的单同理。
describe('syncVisaTasksForOrder · 取消族终态 / 已软删 → 不建任务', () => {
  const TERMINATING = ['CANCELLED', 'REFUNDED', 'PAYMENT_TIMEOUT', 'FAILED'] as const;

  it.each(TERMINATING)('%s 的需签单 → 不补建（不给已终结的单凭空造活）', async (status) => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      status,
      items: [{ id: 'itm_visa', kind: 'VISA' }],
    });
    const result = await run();
    expect(result.needed).toBe(false);
    expect(result.createdTaskIds).toEqual([]);
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
  });

  it.each(TERMINATING)('%s 的单里残留 PENDING 任务 → 顺手撤掉（正确的清理）', async (status) => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      status,
      items: [{ id: 'itm_visa', kind: 'VISA', tasks: [pendingVisaTask()] }],
    });
    const result = await run();
    expect(result.needed).toBe(false);
    expect(result.cancelledTaskIds).toEqual(['task_pending']);
  });

  it('已软删（回收站）的需签单 → 不补建', async () => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      deletedAt: new Date('2026-08-27T00:00:00.000Z'),
      items: [{ id: 'itm_visa', kind: 'VISA' }],
    });
    const result = await run();
    expect(result.needed).toBe(false);
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
  });

  it('已软删的单里残留 PENDING 任务 → 撤掉（回收站单不该还挂在签证台上）', async () => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      deletedAt: new Date('2026-08-27T00:00:00.000Z'),
      items: [{ id: 'itm_visa', kind: 'VISA', tasks: [pendingVisaTask()] }],
    });
    expect((await run()).cancelledTaskIds).toEqual(['task_pending']);
  });

  it('DRAFT 不算取消族（只是座位账口径上的释放型）→ 仍按签证口径正常补建', async () => {
    seed({
      visaStatus: VisaRequirement.NEEDED,
      status: 'DRAFT',
      items: [{ id: 'itm_visa', kind: 'VISA' }],
    });
    const result = await run();
    expect(result.needed).toBe(true);
    expect(result.createdTaskIds).toEqual(['task_new']);
  });

  it.each(['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'TICKETED', 'COMPLETED'])(
    '%s（在途单）→ 行为不变，照常补建',
    async (status) => {
      seed({
        visaStatus: VisaRequirement.NEEDED,
        status,
        items: [{ id: 'itm_visa', kind: 'VISA' }],
      });
      expect((await run()).createdTaskIds).toEqual(['task_new']);
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════
// 并发补建：判定开头那次读与 create 之间，另一路同步可能已经建过一条
describe('syncVisaTasksForOrder · 补建前的同事务 re-check', () => {
  it('re-check 查到并发已补建的活动任务 → 不再建第二条', async () => {
    seed({ visaStatus: VisaRequirement.NEEDED, items: [{ id: 'itm_visa', kind: 'VISA' }] });
    // 判定开头读到「无任务」，贴身 re-check 时并发那一路已经建好了。
    mockPrisma.fulfillmentTask.findFirst.mockResolvedValue({ id: 'task_by_other' });
    const result = await run();
    expect(result.needed).toBe(true);
    expect(result.createdTaskIds).toEqual([]);
    expect(mockPrisma.fulfillmentTask.create).not.toHaveBeenCalled();
  });

  it('re-check 只认「活动」任务：查询按 type=签证 + status≠CANCELLED + 本单', async () => {
    seed({ visaStatus: VisaRequirement.NEEDED, items: [{ id: 'itm_visa', kind: 'VISA' }] });
    await run();
    expect(mockPrisma.fulfillmentTask.findFirst).toHaveBeenCalledWith({
      where: {
        type: FulfillmentType.VISA_APPLICATION,
        status: { not: FulfillmentStatus.CANCELLED },
        orderItem: { orderId: 'ord1' },
      },
      select: { id: true },
    });
  });

  it('撤销路径不做 re-check（updateMany 的 where 二次卡 PENDING 已够）', async () => {
    seed({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [{ id: 'itm_visa', kind: 'VISA', tasks: [pendingVisaTask()] }],
    });
    await run();
    expect(mockPrisma.fulfillmentTask.findFirst).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 挂接点：换人通道（乘客级自备签在存量订单上的唯一写入口）
// 改自备签的 PATCH 会被 resolvePassengerPatchChannel 判成换人语义走到 swapPassenger；
// 真换人（证件号变化）也会把 visaExempt 强制回落 false。两种情形都该触发同步。
describe('swapPassenger · 自备签变更后触发签证任务同步', () => {
  const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;

  /** 装一个够 swapPassenger 跑通的 tx（口径同售后守卫测试：最后的序列化不管，catch 掉）。 */
  function mountSwap(opts: {
    oldVisaExempt: boolean;
    /** 同步重算时库里的乘客状态（= passenger.update 之后的状态）。 */
    passengersAfter: Array<{ visaExempt: boolean }>;
    tasks?: Array<{ id: string; type: string; status: string }>;
  }) {
    const tx = {
      $queryRaw: vi.fn(async () => [
        { id: 'ord1', adjustmentCny: 0, adjustments: null, status: 'PAID', deletedAt: null },
      ]),
      order: {
        findUnique: vi.fn(async () => ({
          visaStatus: VisaRequirement.NEEDED,
          orderNumber: 'ORD-0001',
          status: 'PAID',
          deletedAt: null,
        })),
        update: vi.fn(),
      },
      orderItem: {
        findMany: vi.fn(async () => [
          {
            id: 'itm_visa',
            kind: 'VISA',
            bundleId: null,
            metadata: null,
            fulfillmentTasks: opts.tasks ?? [pendingVisaTask()],
          },
        ]),
        update: vi.fn(),
      },
      passenger: {
        findUnique: vi.fn(async () => ({
          id: 'pax-1',
          orderId: 'ord1',
          fullName: 'WANG XIAOMING',
          documentNumber: 'E11111111',
          visaExempt: opts.oldVisaExempt,
          passengerType: 'ADULT',
        })),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => opts.passengersAfter),
        update: vi.fn(async () => ({ id: 'pax-1' })),
        findUniqueOrThrow: vi.fn(async () => ({
          fullName: 'WANG XIAOMING',
          documentNumber: 'E11111111',
        })),
      },
      bundle: { findUnique: vi.fn(async () => ({ items: [] })) },
      fulfillmentTask: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'task_new',
          ...data,
        })),
        // 补建前的同事务 re-check：换人事务里没有并发，恒为「没建过」。
        findFirst: vi.fn(async () => null),
      },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    // 事务后的序列化取数不是本用例关心的，返回 null 让调用方 catch 掉。
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
    return tx;
  }

  it('改成全员自备签 → 撤销该单的待处理签证任务', async () => {
    const tx = mountSwap({ oldVisaExempt: false, passengersAfter: [{ visaExempt: true }] });

    await new OrderService()
      .swapPassenger('ord1', 'pax-1', { visaExempt: true }, ADMIN)
      .catch(() => undefined);

    expect(tx.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['task_pending'] }, status: FulfillmentStatus.PENDING },
      data: { status: FulfillmentStatus.CANCELLED },
    });
  });

  it('最后一位自备签客人改回随团办签（任务此前已被撤）→ 补建待处理任务', async () => {
    const tx = mountSwap({
      oldVisaExempt: true,
      passengersAfter: [{ visaExempt: false }],
      tasks: [
        {
          id: 'task_old',
          type: FulfillmentType.VISA_APPLICATION,
          status: FulfillmentStatus.CANCELLED,
        },
      ],
    });

    await new OrderService()
      .swapPassenger('ord1', 'pax-1', { visaExempt: false }, ADMIN)
      .catch(() => undefined);

    expect(tx.fulfillmentTask.create).toHaveBeenCalledWith({
      data: {
        orderItemId: 'itm_visa',
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.PENDING,
      },
    });
  });

  it('自备签没变（只改姓名）→ 不跑同步，零额外写入', async () => {
    const tx = mountSwap({ oldVisaExempt: false, passengersAfter: [{ visaExempt: false }] });

    await new OrderService()
      .swapPassenger('ord1', 'pax-1', { chineseName: '王小明' }, ADMIN)
      .catch(() => undefined);

    expect(tx.fulfillmentTask.updateMany).not.toHaveBeenCalled();
    expect(tx.fulfillmentTask.create).not.toHaveBeenCalled();
  });
});
