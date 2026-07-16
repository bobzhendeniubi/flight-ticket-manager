/**
 * FulfillmentService.batchUpdateStatus · 单元测试（vitest）
 *
 * 关注点：批量端点不另写状态规则 —— 逐条透传给单任务 update()，
 * partial failure 聚合到 failures 而不中断其余任务。
 * update() 本身的副作用（startedAt/completedAt/attempts/PNR 同步）不在此重复测。
 */
import { describe, it, expect, vi } from 'vitest';

// fulfillment.service 顶层引用 prisma —— 先 mock 掉（本测试只 spy update，不碰 DB）
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  FulfillmentStatus,
  VisaEntryType,
  VisaIssuanceMethod,
  VisaRequirement,
} from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../db/prisma.js';
import {
  FulfillmentService,
  effectiveVisaClassification,
  issuanceMethodWhere,
} from './fulfillment.service.js';

describe('FulfillmentService.batchUpdateStatus', () => {
  it('逐条复用单任务 update()（同参数透传），全部成功', async () => {
    const service = new FulfillmentService();
    const updateSpy = vi.spyOn(service, 'update').mockResolvedValue({} as never);

    const res = await service.batchUpdateStatus(['t1', 't2'], FulfillmentStatus.IN_PROGRESS);

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenNthCalledWith(1, 't1', { status: FulfillmentStatus.IN_PROGRESS });
    expect(updateSpy).toHaveBeenNthCalledWith(2, 't2', { status: FulfillmentStatus.IN_PROGRESS });
    expect(res).toEqual({ successCount: 2, failureCount: 0, failures: [] });
  });

  it('部分失败不影响其余，failures 按 id 带错误信息', async () => {
    const service = new FulfillmentService();
    vi.spyOn(service, 'update').mockImplementation(async (id) => {
      if (id === 'missing') throw new NotFoundError('履约任务不存在');
      return {} as never;
    });

    const res = await service.batchUpdateStatus(
      ['a', 'missing', 'b'],
      FulfillmentStatus.CONFIRMED,
    );

    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(1);
    expect(res.failures).toEqual([{ id: 'missing', error: '履约任务不存在' }]);
  });

  it('非 Error 异常也能聚合（兜底"未知错误"）', async () => {
    const service = new FulfillmentService();
    vi.spyOn(service, 'update').mockRejectedValue('boom');

    const res = await service.batchUpdateStatus(['x'], FulfillmentStatus.FAILED);

    expect(res).toEqual({
      successCount: 0,
      failureCount: 1,
      failures: [{ id: 'x', error: '未知错误' }],
    });
  });
});

describe('FulfillmentService.batchUpdateNotes', () => {
  it('逐条复用单任务 update()（同参数透传 { notes }），全部成功', async () => {
    const service = new FulfillmentService();
    const updateSpy = vi.spyOn(service, 'update').mockResolvedValue({} as never);

    const res = await service.batchUpdateNotes(['t1', 't2'], '已联系客人补材料');

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenNthCalledWith(1, 't1', { notes: '已联系客人补材料' });
    expect(updateSpy).toHaveBeenNthCalledWith(2, 't2', { notes: '已联系客人补材料' });
    expect(res).toEqual({ successCount: 2, failureCount: 0, failures: [] });
  });

  it('notes 空串（批量清空）也原样透传，不被当成"省略"过滤掉', async () => {
    const service = new FulfillmentService();
    const updateSpy = vi.spyOn(service, 'update').mockResolvedValue({} as never);

    await service.batchUpdateNotes(['t1'], '');

    expect(updateSpy).toHaveBeenCalledWith('t1', { notes: '' });
  });

  it('部分失败不影响其余，failures 按 id 带错误信息（不动状态，独立于 batchUpdateStatus）', async () => {
    const service = new FulfillmentService();
    vi.spyOn(service, 'update').mockImplementation(async (id) => {
      if (id === 'missing') throw new NotFoundError('履约任务不存在');
      return {} as never;
    });

    const res = await service.batchUpdateNotes(['a', 'missing', 'b'], '备注');

    expect(res.successCount).toBe(2);
    expect(res.failureCount).toBe(1);
    expect(res.failures).toEqual([{ id: 'missing', error: '履约任务不存在' }]);
  });

  it('非 Error 异常也能聚合（兜底"未知错误"）', async () => {
    const service = new FulfillmentService();
    vi.spyOn(service, 'update').mockRejectedValue('boom');

    const res = await service.batchUpdateNotes(['x'], '备注');

    expect(res).toEqual({
      successCount: 0,
      failureCount: 1,
      failures: [{ id: 'x', error: '未知错误' }],
    });
  });
});

describe('FulfillmentService.listByOrder — 签证台过滤自备签乘客', () => {
  it('乘客查询排除 visaExempt=true（客人自备签证不进签证台）', async () => {
    const orderItemFindMany = vi.fn().mockResolvedValue([]);
    const passengerFindMany = vi.fn().mockResolvedValue([]);
    // listByOrder 用 prisma.$transaction([orderItem.findMany(...), passenger.findMany(...)])：
    // 数组元素在传入前已被同步调用（下面的 spy 因此能捕获 where），$transaction 只需汇总结果。
    const p = prisma as unknown as {
      orderItem: { findMany: typeof orderItemFindMany };
      passenger: { findMany: typeof passengerFindMany };
      $transaction: (ops: unknown[]) => Promise<unknown[]>;
    };
    p.orderItem = { findMany: orderItemFindMany };
    p.passenger = { findMany: passengerFindMany };
    p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);

    const service = new FulfillmentService();
    await service.listByOrder('order-9');

    expect(passengerFindMany).toHaveBeenCalledWith({
      where: { orderId: 'order-9', visaExempt: false },
      select: { id: true, fullName: true, documentNumber: true, passportPhotoUrl: true },
    });
  });

  it('过滤父订单：已软删（deletedAt 非空）/ 取消族状态的订单任务不再出现', async () => {
    const orderItemFindMany = vi.fn().mockResolvedValue([]);
    const passengerFindMany = vi.fn().mockResolvedValue([]);
    const p = prisma as unknown as {
      orderItem: { findMany: typeof orderItemFindMany };
      passenger: { findMany: typeof passengerFindMany };
      $transaction: (ops: unknown[]) => Promise<unknown[]>;
    };
    p.orderItem = { findMany: orderItemFindMany };
    p.passenger = { findMany: passengerFindMany };
    p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);

    const service = new FulfillmentService();
    await service.listByOrder('order-9');

    // 与订单/财务导出同一补集口径：排除 DRAFT/PAYMENT_TIMEOUT/CANCELLED/REFUNDED/FAILED
    const { where } = orderItemFindMany.mock.calls[0][0] as {
      where: { orderId: string; order: { deletedAt: null; status: { in: string[] } } };
    };
    expect(where.orderId).toBe('order-9');
    expect(where.order.deletedAt).toBeNull();
    const counted = where.order.status.in;
    for (const excluded of ['DRAFT', 'PAYMENT_TIMEOUT', 'CANCELLED', 'REFUNDED', 'FAILED']) {
      expect(counted).not.toContain(excluded);
    }
    expect(counted).toContain('PAID');
    expect(counted).toContain('REFUND_REQUESTED'); // 退款申请中仍在册（未终态）
  });
});

describe('FulfillmentService.list — 签证台列表过滤已取消/软删父订单', () => {
  it('主查询 where 恒挂父订单过滤（deletedAt=null + 取消族排除）；orderId 筛选与之合并', async () => {
    const taskFindMany = vi.fn().mockResolvedValue([]);
    const taskCount = vi.fn().mockResolvedValue(0);
    const p = prisma as unknown as {
      fulfillmentTask: { findMany: typeof taskFindMany; count: typeof taskCount };
      $transaction: (ops: unknown[]) => Promise<unknown[]>;
    };
    p.fulfillmentTask = { findMany: taskFindMany, count: taskCount };
    p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);

    const service = new FulfillmentService();
    await service.list({ orderId: 'order-1', page: 1, pageSize: 50 });

    const { where } = taskFindMany.mock.calls[0][0] as {
      where: {
        orderItem: { orderId?: string; order: { deletedAt: null; status: { in: string[] } } };
      };
    };
    // orderId 筛选与父订单过滤合并在同一个 orderItem 关系过滤里（不互相覆盖）
    expect(where.orderItem.orderId).toBe('order-1');
    expect(where.orderItem.order.deletedAt).toBeNull();
    for (const excluded of ['DRAFT', 'PAYMENT_TIMEOUT', 'CANCELLED', 'REFUNDED', 'FAILED']) {
      expect(where.orderItem.order.status.in).not.toContain(excluded);
    }
  });

  it('无 orderId 筛选时父订单过滤依旧存在（全局签证台视图也不残留取消单）', async () => {
    const taskFindMany = vi.fn().mockResolvedValue([]);
    const taskCount = vi.fn().mockResolvedValue(0);
    const p = prisma as unknown as {
      fulfillmentTask: { findMany: typeof taskFindMany; count: typeof taskCount };
      $transaction: (ops: unknown[]) => Promise<unknown[]>;
    };
    p.fulfillmentTask = { findMany: taskFindMany, count: taskCount };
    p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);

    const service = new FulfillmentService();
    await service.list({ page: 1, pageSize: 50 });

    const { where } = taskFindMany.mock.calls[0][0] as {
      where: {
        orderItem: { orderId?: string; order: { deletedAt: null; status: { in: string[] } } };
      };
    };
    expect(where.orderItem.orderId).toBeUndefined();
    expect(where.orderItem.order.deletedAt).toBeNull();
    expect(where.orderItem.order.status.in).toContain('PAID');
    expect(where.orderItem.order.status.in).not.toContain('CANCELLED');
  });

  it('notesQuery 命中时 where.notes 用不区分大小写子串匹配；省略时不带该条件', async () => {
    const taskFindMany = vi.fn().mockResolvedValue([]);
    const taskCount = vi.fn().mockResolvedValue(0);
    const p = prisma as unknown as {
      fulfillmentTask: { findMany: typeof taskFindMany; count: typeof taskCount };
      $transaction: (ops: unknown[]) => Promise<unknown[]>;
    };
    p.fulfillmentTask = { findMany: taskFindMany, count: taskCount };
    p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);

    const service = new FulfillmentService();
    await service.list({ notesQuery: '补材料', page: 1, pageSize: 50 });

    const { where: whereWithQuery } = taskFindMany.mock.calls[0][0] as {
      where: { notes?: { contains: string; mode: string } };
    };
    expect(whereWithQuery.notes).toEqual({ contains: '补材料', mode: 'insensitive' });

    await service.list({ page: 1, pageSize: 50 });
    const { where: whereWithoutQuery } = taskFindMany.mock.calls[1][0] as {
      where: { notes?: { contains: string; mode: string } };
    };
    expect(whereWithoutQuery.notes).toBeUndefined();
  });
});

describe('FulfillmentService.listPassengerPhotos', () => {
  it('按订单只取 id + 护照图（列表瘦身后展开某单时按需拉真图）', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'p1', passportPhotoUrl: 'data:image/jpeg;base64,AAA' },
      { id: 'p2', passportPhotoUrl: null },
    ]);
    // 顶层 mock 的 prisma 是空对象；这里补上本用例需要的 passenger.findMany
    (prisma as unknown as { passenger: { findMany: typeof findMany } }).passenger = { findMany };

    const service = new FulfillmentService();
    const res = await service.listPassengerPhotos('order-1');

    expect(findMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      select: { id: true, passportPhotoUrl: true },
    });
    expect(res).toEqual([
      { id: 'p1', passportPhotoUrl: 'data:image/jpeg;base64,AAA' },
      { id: 'p2', passportPhotoUrl: null },
    ]);
  });
});

describe('effectiveVisaClassification — 签发方式可回退录单状态；入境次数只认产品字段', () => {
  it('产品字段齐全 → 原样返回，两项均标为 PRODUCT（订单级状态不覆盖产品）', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: VisaIssuanceMethod.STICKER, entryType: VisaEntryType.SINGLE },
        VisaRequirement.E_VISA,
      ),
    ).toEqual({
      issuanceMethod: 'STICKER',
      entryType: 'SINGLE',
      issuanceSource: 'PRODUCT',
      entrySource: 'PRODUCT',
    });
  });

  it('无产品 + 录单签证状态=E_VISA → 签发方式回退电子签（标 ORDER_STATUS）；入境次数留空', () => {
    expect(effectiveVisaClassification(null, VisaRequirement.E_VISA)).toEqual({
      issuanceMethod: 'E_VISA',
      entryType: null,
      issuanceSource: 'ORDER_STATUS',
      entrySource: null,
    });
  });

  it('录单状态从不表达入境次数 → 即使产品标了签发方式，入境次数也不被推断出来', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: VisaIssuanceMethod.E_VISA, entryType: null },
        VisaRequirement.E_VISA,
      ),
    ).toEqual({
      issuanceMethod: 'E_VISA',
      entryType: null,
      issuanceSource: 'PRODUCT',
      entrySource: null,
    });
  });

  it('产品只标了入境次数 → 入境次数=产品；签发方式回退录单状态并标 ORDER_STATUS', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: null, entryType: VisaEntryType.SINGLE },
        VisaRequirement.E_VISA,
      ),
    ).toEqual({
      issuanceMethod: 'E_VISA',
      entryType: 'SINGLE',
      issuanceSource: 'ORDER_STATUS',
      entrySource: 'PRODUCT',
    });
  });

  it('将来卖单次电子签：产品标 SINGLE + 录单电子签 → 保持单次，不被回退改写成多次', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: VisaIssuanceMethod.E_VISA, entryType: VisaEntryType.SINGLE },
        VisaRequirement.E_VISA,
      ).entryType,
    ).toBe('SINGLE');
  });

  it('无产品 + 录单签证状态=NEEDED/HAS_VISA/NOT_NEEDED/null → 未标注（值与出处全 null）', () => {
    for (const status of [
      VisaRequirement.NEEDED,
      VisaRequirement.HAS_VISA,
      VisaRequirement.NOT_NEEDED,
      null,
    ]) {
      expect(effectiveVisaClassification(null, status)).toEqual({
        issuanceMethod: null,
        entryType: null,
        issuanceSource: null,
        entrySource: null,
      });
    }
  });
});

describe('FulfillmentService.list — 签发方式回退录单签证状态（签证台筛选口径打通）', () => {
  it('无签证产品的 E_VISA 录单单 → 下发 visaIssuanceMethod=E_VISA + source=ORDER_STATUS；入境次数不臆造', async () => {
    const now = new Date('2026-07-15T00:00:00Z');
    const row = {
      id: 'task-1',
      orderItemId: 'itm-1',
      type: 'VISA_APPLICATION',
      status: 'PENDING',
      data: null,
      notes: null,
      attempts: 0,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      failureReason: null,
      assigneeUserId: null,
      createdAt: now,
      updatedAt: now,
      orderItem: {
        id: 'itm-1',
        kind: 'FLIGHT',
        description: '机票行',
        quantity: 1,
        orderId: 'ord-1',
        visa: null, // 录单单子无签证产品 item
        order: {
          id: 'ord-1',
          orderNumber: 'FTM-TEST-1',
          contactName: '联系人',
          contactPhone: '100',
          status: 'PAID',
          notes: null,
          visaStatus: 'E_VISA', // 录单签证状态：电子签（只表达签发方式，不表达入境次数）
        },
      },
    };
    const taskFindMany = vi.fn().mockResolvedValue([row]);
    const taskCount = vi.fn().mockResolvedValue(1);
    const queryRaw = vi.fn().mockResolvedValue([]); // 乘客批量查询（本用例无乘客）
    const orderItemFindMany = vi.fn().mockResolvedValue([]); // 机票段批量查询
    const p = prisma as unknown as {
      fulfillmentTask: { findMany: typeof taskFindMany; count: typeof taskCount };
      orderItem: { findMany: typeof orderItemFindMany };
      $queryRaw: typeof queryRaw;
      $transaction: (ops: unknown[]) => Promise<unknown[]>;
    };
    p.fulfillmentTask = { findMany: taskFindMany, count: taskCount };
    p.orderItem = { findMany: orderItemFindMany };
    p.$queryRaw = queryRaw;
    p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);

    const service = new FulfillmentService();
    const res = await service.list({ page: 1, pageSize: 50 });

    expect(res.tasks).toHaveLength(1);
    const task = res.tasks[0] as {
      visaIssuanceMethod: string | null;
      visaEntryType: string | null;
      visaIssuanceSource: string | null;
      visaEntrySource: string | null;
    };
    // 签发方式：录单下拉选的就是「电子签」，回退有据 → 下发值 + 出处标（前端据此浅色标「·录单」）
    expect(task.visaIssuanceMethod).toBe('E_VISA');
    expect(task.visaIssuanceSource).toBe('ORDER_STATUS');
    // 入境次数：录单从未表达过，不臆造「多次」
    expect(task.visaEntryType).toBeNull();
    expect(task.visaEntrySource).toBeNull();
  });
});

// ── 服务端分页 + 服务端筛选：total 与实际能翻到的行数必须同口径 ──────────────
//
// 这批修的真 bug：旧实现「分页/总数在服务端、状态(OPEN)/签证类型/出发日期在客户端」，
// 于是 total 按服务端全量算、行按客户端过滤后展示 —— 两个口径。后果：
//   1. 行数和总数对不上（第 1 页筛剩 3 条，总数却显示 200）；
//   2. 每页各自过滤，跨页匹配项永远凑不齐 → 签证岗按「待办」翻页会漏单。
// 下面的用例锁死「一个 where 同时喂 findMany 和 count」这条不变式。

/** 构造一条 list() 主查询返回的行（字段对齐 serializeTask 的读取面）。 */
function makeTaskRow(args: {
  id: string;
  status: string;
  orderId?: string;
  visa?: { visaName: string | null; issuanceMethod: string | null; entryType: string | null } | null;
  visaStatus?: string | null;
}) {
  const now = new Date('2026-07-15T00:00:00Z');
  const orderId = args.orderId ?? `ord-${args.id}`;
  return {
    id: args.id,
    orderItemId: `itm-${args.id}`,
    type: 'VISA_APPLICATION',
    status: args.status,
    data: null,
    notes: null,
    attempts: 0,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    failureReason: null,
    assigneeUserId: null,
    createdAt: now,
    updatedAt: now,
    orderItem: {
      id: `itm-${args.id}`,
      kind: 'VISA',
      description: '签证行',
      quantity: 1,
      orderId,
      visa: args.visa ?? null,
      order: {
        id: orderId,
        orderNumber: `FTM-TEST-${args.id}`,
        contactName: '联系人',
        contactPhone: '100',
        status: 'PAID',
        notes: null,
        visaStatus: args.visaStatus ?? null,
      },
    },
  };
}

/**
 * 极简 where 求值器 —— 只解释本用例用到的 status.in 子句（其余条件不参与）。
 * 目的不是复刻 Prisma，而是让 findMany 与 count 走**同一个** where、同一份数据，
 * 从而暴露「总数与可翻行数不一致」这一类回归。
 */
function matchesStatus(row: { status: string }, where: unknown): boolean {
  const w = where as { status?: { in?: string[] } } | undefined;
  const allowed = w?.status?.in;
  return allowed ? allowed.includes(row.status) : true;
}

/** 把内存数据集接成 fulfillmentTask.findMany/count 的假实现（共用 where）。 */
function mockPagedDataset(rows: Array<ReturnType<typeof makeTaskRow>>) {
  const findMany = vi.fn(async (args: { where: unknown; take: number; skip: number }) => {
    const hit = rows.filter((r) => matchesStatus(r, args.where));
    return hit.slice(args.skip, args.skip + args.take);
  });
  const count = vi.fn(async (args: { where: unknown }) =>
    rows.filter((r) => matchesStatus(r, args.where)).length,
  );
  const p = prisma as unknown as {
    fulfillmentTask: { findMany: typeof findMany; count: typeof count };
    orderItem: { findMany: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
    $transaction: (ops: unknown[]) => Promise<unknown[]>;
  };
  p.fulfillmentTask = { findMany, count };
  p.orderItem = { findMany: vi.fn().mockResolvedValue([]) };
  p.$queryRaw = vi.fn().mockResolvedValue([]);
  p.$transaction = async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);
  return { findMany, count };
}

describe('FulfillmentService.list — 跨页一致性（total ≡ 实际能翻到的行数）', () => {
  it('「待办」多状态筛选：N > pageSize 时逐页翻完，行数正好等于 total，且无漏单', async () => {
    // 7 条任务、5 条命中「待办」(PENDING/IN_PROGRESS)，pageSize=2 → 必须翻 3 页拿满 5 条
    const rows = [
      makeTaskRow({ id: '1', status: 'PENDING' }),
      makeTaskRow({ id: '2', status: 'CONFIRMED' }),
      makeTaskRow({ id: '3', status: 'IN_PROGRESS' }),
      makeTaskRow({ id: '4', status: 'CANCELLED' }),
      makeTaskRow({ id: '5', status: 'PENDING' }),
      makeTaskRow({ id: '6', status: 'IN_PROGRESS' }),
      makeTaskRow({ id: '7', status: 'PENDING' }),
    ];
    mockPagedDataset(rows);
    const service = new FulfillmentService();
    const openStatuses = [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS];

    const first = await service.list({ status: openStatuses, page: 1, pageSize: 2 });
    const total = first.pagination.total;

    // 逐页翻到底，收集所有能翻到的行
    const walked: string[] = first.tasks.map((t) => (t as { id: string }).id);
    for (let page = 2; (page - 1) * 2 < total; page++) {
      const res = await service.list({ status: openStatuses, page, pageSize: 2 });
      walked.push(...res.tasks.map((t) => (t as { id: string }).id));
    }

    // 核心断言：总数 = 实际能翻到的行数（旧实现这里 total=7 而可见行=5，对不上）
    expect(total).toBe(5);
    expect(walked).toHaveLength(total);
    // 且翻到的正是全部「待办」单（1/3/5/6/7）—— 跨页不漏单
    expect([...walked].sort()).toEqual(['1', '3', '5', '6', '7']);
  });

  it('findMany 与 count 共用同一个 where（分页与总数不可能再分叉）', async () => {
    const { findMany, count } = mockPagedDataset([makeTaskRow({ id: '1', status: 'PENDING' })]);
    const service = new FulfillmentService();

    await service.list({
      status: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS],
      issuanceMethod: VisaIssuanceMethod.E_VISA,
      page: 1,
      pageSize: 50,
    });

    const findManyWhere = (findMany.mock.calls[0][0] as { where: unknown }).where;
    const countWhere = (count.mock.calls[0][0] as { where: unknown }).where;
    expect(countWhere).toBe(findManyWhere);
  });

  it('多状态落到 status:{ in: [...] }；「全部状态」不加 status 条件', async () => {
    const { findMany } = mockPagedDataset([]);
    const service = new FulfillmentService();

    await service.list({
      status: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS],
      page: 1,
      pageSize: 50,
    });
    expect((findMany.mock.calls[0][0] as { where: { status?: unknown } }).where.status).toEqual({
      in: ['PENDING', 'IN_PROGRESS'],
    });

    const { findMany: findMany2 } = mockPagedDataset([]);
    await new FulfillmentService().list({ page: 1, pageSize: 50 });
    expect(
      (findMany2.mock.calls[0][0] as { where: { status?: unknown } }).where.status,
    ).toBeUndefined();
  });
});

describe('issuanceMethodWhere — 签发方式筛选下沉后与内存回退口径一致', () => {
  /** 内存口径（现网真值）：有效签发方式 = 产品 issuanceMethod ?? (订单级 E_VISA ? E_VISA : null) */
  const cases: Array<{
    label: string;
    visa: { issuanceMethod: VisaIssuanceMethod | null; entryType: null } | null;
    visaStatus: VisaRequirement | null;
  }> = [
    { label: '产品标了电子签', visa: { issuanceMethod: VisaIssuanceMethod.E_VISA, entryType: null }, visaStatus: null },
    { label: '产品标了贴纸签', visa: { issuanceMethod: VisaIssuanceMethod.STICKER, entryType: null }, visaStatus: null },
    { label: '无签证产品 + 录单电子签（回退）', visa: null, visaStatus: VisaRequirement.E_VISA },
    { label: '产品未标 + 录单电子签（回退）', visa: { issuanceMethod: null, entryType: null }, visaStatus: VisaRequirement.E_VISA },
    { label: '产品未标 + 录单需签证', visa: { issuanceMethod: null, entryType: null }, visaStatus: VisaRequirement.NEEDED },
    { label: '产品未标 + 订单级为空', visa: null, visaStatus: null },
  ];

  it('回退出来的电子签单：内存口径判为 E_VISA —— 下沉后的 where 必须含订单级回退分支', () => {
    // 先钉住内存真值：产品未标 + 录单 E_VISA → 有效签发方式 = E_VISA
    for (const c of cases) {
      const eff = effectiveVisaClassification(c.visa, c.visaStatus);
      if (!c.visa?.issuanceMethod && c.visaStatus === VisaRequirement.E_VISA) {
        expect(eff.issuanceMethod).toBe(VisaIssuanceMethod.E_VISA);
      }
    }
    // 下沉后的 where：E_VISA 分两支 —— 产品直标，或「产品未标 且 订单级 E_VISA」回退
    const where = issuanceMethodWhere(VisaIssuanceMethod.E_VISA) as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ visa: { is: { issuanceMethod: 'E_VISA' } } });
    // 回退支：产品未标（无产品 或 产品字段为空）且订单级 = E_VISA
    expect(where.OR[1]).toEqual({
      AND: [
        { OR: [{ visa: { is: null } }, { visa: { is: { issuanceMethod: null } } }] },
        { order: { visaStatus: 'E_VISA' } },
      ],
    });
  });

  it('非电子签的签发方式无回退来源 → 只认产品结构化字段', () => {
    expect(issuanceMethodWhere(VisaIssuanceMethod.STICKER)).toEqual({
      visa: { is: { issuanceMethod: 'STICKER' } },
    });
    expect(issuanceMethodWhere(VisaIssuanceMethod.ARRIVAL)).toEqual({
      visa: { is: { issuanceMethod: 'ARRIVAL' } },
    });
  });

  it('「未标注」= 产品未标 且 订单级不是电子签（否则会回退成电子签，不算未标注）', () => {
    const where = issuanceMethodWhere('NONE') as { AND: Array<Record<string, unknown>> };
    expect(where.AND[0]).toEqual({
      OR: [{ visa: { is: null } }, { visa: { is: { issuanceMethod: null } } }],
    });
    // 显式列出 NULL：SQL 里 NULL <> 'E_VISA' 得 NULL 而非真，不能只靠 not
    expect(where.AND[1]).toEqual({
      order: { OR: [{ visaStatus: null }, { visaStatus: { not: 'E_VISA' } }] },
    });
  });
});

describe('FulfillmentService.list — 出发日期筛选（纯签证单无航班仍保留可见）', () => {
  it('按最早一段机票的出发地本地日筛，且无航班订单不被日期筛掉', async () => {
    const { findMany } = mockPagedDataset([]);
    const p = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    // 原生 SQL 算出「最早一段出发地本地日 = 所选日期」的订单集合
    p.$queryRaw = vi.fn().mockResolvedValue([{ orderId: 'ord-a' }, { orderId: 'ord-b' }]);

    const service = new FulfillmentService();
    await service.list({ departureDate: '2026-07-20', page: 1, pageSize: 50 });

    const { where } = findMany.mock.calls[0][0] as {
      where: { orderItem: { AND: Array<{ order: { OR: unknown[] } }> } };
    };
    const dateBranch = where.orderItem.AND[0].order.OR;
    // 命中日期的订单
    expect(dateBranch[0]).toEqual({ id: { in: ['ord-a', 'ord-b'] } });
    // 纯签证单/纯酒店单（无任何带班次的机票行）→ 保留可见，与护照导出同口径
    expect(dateBranch[1]).toEqual({
      items: { none: { kind: 'FLIGHT', flightScheduleId: { not: null } } },
    });
  });

  it('时区换算方向正确：先 AT TIME ZONE UTC 再折算出发地时区，且取最早一段（MIN）', async () => {
    mockPagedDataset([]);
    const p = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    const queryRaw = vi.fn().mockResolvedValue([]);
    p.$queryRaw = queryRaw;

    await new FulfillmentService().list({ departureDate: '2026-07-20', page: 1, pageSize: 50 });

    const sql = (queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] });
    const text = sql.strings.join('?');
    // departureTime 是 TIMESTAMP without time zone 且存 UTC：少了 AT TIME ZONE 'UTC' 这一跳会整体错日
    expect(text).toContain("AT TIME ZONE 'UTC'");
    expect(text).toContain('AT TIME ZONE fs."departureTz"');
    // 取最早一段而非任意一段：否则回程恰好落在该日的订单会被误命中
    expect(text).toContain('MIN(fs2."departureTime")');
    // 所选日期以参数传入（不拼字符串）
    expect(sql.values).toContain('2026-07-20');
  });

  it('不传 departureDate → 不查订单集合、不加日期条件', async () => {
    const { findMany } = mockPagedDataset([]);
    const p = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    const queryRaw = vi.fn().mockResolvedValue([]);
    p.$queryRaw = queryRaw;

    await new FulfillmentService().list({ page: 1, pageSize: 50 });

    expect(queryRaw).not.toHaveBeenCalled();
    const { where } = findMany.mock.calls[0][0] as { where: { orderItem: { AND?: unknown } } };
    expect(where.orderItem.AND).toBeUndefined();
  });
});
