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
import { FulfillmentService, effectiveVisaClassification } from './fulfillment.service.js';

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

describe('effectiveVisaClassification — 签证分类：产品结构化字段优先，缺失回退录单签证状态', () => {
  it('产品字段齐全 → 原样返回（订单级状态不覆盖产品）', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: VisaIssuanceMethod.STICKER, entryType: VisaEntryType.SINGLE },
        VisaRequirement.E_VISA,
      ),
    ).toEqual({ issuanceMethod: 'STICKER', entryType: 'SINGLE' });
  });

  it('无产品 + 录单签证状态=E_VISA（电子签·三个月多次）→ 电子签 + 多次', () => {
    expect(effectiveVisaClassification(null, VisaRequirement.E_VISA)).toEqual({
      issuanceMethod: 'E_VISA',
      entryType: 'MULTIPLE',
    });
  });

  it('产品字段部分缺失 → 只补缺失的那一项', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: VisaIssuanceMethod.E_VISA, entryType: null },
        VisaRequirement.E_VISA,
      ),
    ).toEqual({ issuanceMethod: 'E_VISA', entryType: 'MULTIPLE' });
  });

  it('无产品 + 录单签证状态=NEEDED/HAS_VISA/NOT_NEEDED/null → 未标注（null/null）', () => {
    for (const status of [
      VisaRequirement.NEEDED,
      VisaRequirement.HAS_VISA,
      VisaRequirement.NOT_NEEDED,
      null,
    ]) {
      expect(effectiveVisaClassification(null, status)).toEqual({
        issuanceMethod: null,
        entryType: null,
      });
    }
  });
});

describe('FulfillmentService.list — 签证类型回退录单签证状态（签证台筛选口径打通）', () => {
  it('无签证产品的 E_VISA 录单单 → 任务下发 visaIssuanceMethod=E_VISA / visaEntryType=MULTIPLE', async () => {
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
          visaStatus: 'E_VISA', // 录单签证状态：电子签(三个月多次)
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
    const task = res.tasks[0] as { visaIssuanceMethod: string | null; visaEntryType: string | null };
    expect(task.visaIssuanceMethod).toBe('E_VISA');
    expect(task.visaEntryType).toBe('MULTIPLE');
  });
});
