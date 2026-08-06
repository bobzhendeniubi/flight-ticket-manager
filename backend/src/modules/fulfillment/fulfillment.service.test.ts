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
  VisaSubmissionStatus,
} from '@prisma/client';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../db/prisma.js';
import {
  FulfillmentService,
  deriveVisaTaskStatus,
  effectiveVisaClassification,
  issuanceMethodWhere,
  resolveVisaUnitCost,
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

describe('resolveVisaUnitCost — 签证人均成本折算（CNY 入账权威）', () => {
  it('USD + 汇率齐备 → 自动折算 CNY 存底（$31.5 ×7.2 = ¥226.8），四舍五入两位', () => {
    expect(resolveVisaUnitCost({ visaUnitCostUsd: 31.5, visaFxRate: 7.2 })).toEqual({
      usd: 31.5,
      rate: 7.2,
      cny: 226.8,
    });
    // 折算带舍入：39 × 7.23 = 281.97
    expect(resolveVisaUnitCost({ visaUnitCostUsd: 39, visaFxRate: 7.23 })).toEqual({
      usd: 39,
      rate: 7.23,
      cny: 281.97,
    });
  });

  it('只给 CNY（无美金/汇率）→ 直接入账，美金/汇率保持 null', () => {
    expect(resolveVisaUnitCost({ visaUnitCostCny: 200 })).toEqual({
      usd: null,
      rate: null,
      cny: 200,
    });
  });

  it('USD+汇率齐备时覆盖直填 CNY（保证「$x ×汇率=¥y」自洽，不采信矛盾的直填值）', () => {
    expect(
      resolveVisaUnitCost({ visaUnitCostUsd: 10, visaFxRate: 7, visaUnitCostCny: 999 }),
    ).toEqual({ usd: 10, rate: 7, cny: 70 });
  });

  it('三者皆空 → 全 null（调用方据此清空回退产品主数据成本）', () => {
    expect(resolveVisaUnitCost({})).toEqual({ usd: null, rate: null, cny: null });
    expect(
      resolveVisaUnitCost({ visaUnitCostUsd: null, visaFxRate: null, visaUnitCostCny: null }),
    ).toEqual({ usd: null, rate: null, cny: null });
  });

  it('只给美金无汇率 → 无法折算，CNY 回落直填值（此处为 null）', () => {
    expect(resolveVisaUnitCost({ visaUnitCostUsd: 31.5 })).toEqual({
      usd: 31.5,
      rate: null,
      cny: null,
    });
  });
});

describe('FulfillmentService.batchSetVisaCost — 逐条透传 update()（签证公司按航班统一单价）', () => {
  it('每个 taskId 用同一份成本参数调 update()，全部成功', async () => {
    const service = new FulfillmentService();
    const updateSpy = vi.spyOn(service, 'update').mockResolvedValue({} as never);
    const cost = { visaUnitCostUsd: 31.5, visaFxRate: 7.2, visaUnitCostCny: null };

    const res = await service.batchSetVisaCost(['t1', 't2'], cost);

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenNthCalledWith(1, 't1', cost);
    expect(updateSpy).toHaveBeenNthCalledWith(2, 't2', cost);
    expect(res).toEqual({ successCount: 2, failureCount: 0, failures: [] });
  });

  it('部分失败（如非签证任务被拒）不影响其余，failures 带错误信息', async () => {
    const service = new FulfillmentService();
    vi.spyOn(service, 'update').mockImplementation(async (id) => {
      if (id === 'flight') throw new ConflictError('签证金额只能设置在签证任务上');
      return {} as never;
    });

    const res = await service.batchSetVisaCost(['visa1', 'flight'], { visaUnitCostCny: 200 });

    expect(res.successCount).toBe(1);
    expect(res.failureCount).toBe(1);
    expect(res.failures).toEqual([
      { id: 'flight', error: '签证金额只能设置在签证任务上' },
    ]);
  });
});

describe('FulfillmentService.update — 签证金额只允许签证任务', () => {
  it('非签证任务带签证金额 → 抛 ConflictError（不写库）', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 't1',
      type: 'FLIGHT_TICKETING',
      status: 'PENDING',
      orderItem: { order: { status: 'PAID', deletedAt: null } },
    });
    const update = vi.fn();
    (prisma as unknown as { fulfillmentTask: unknown }).fulfillmentTask = { findUnique, update };
    const service = new FulfillmentService();

    await expect(service.update('t1', { visaUnitCostCny: 200 })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(update).not.toHaveBeenCalled();
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
      select: {
        id: true,
        fullName: true,
        documentNumber: true,
        passportPhotoUrl: true,
        passportExpiry: true,
        visaSubmissionStatus: true,
      },
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

  it('无产品 + 录单签证状态=NEEDED → 签发方式回退落地签（标 ORDER_STATUS）；入境次数留空', () => {
    // 签证岗反馈：录单选「需要签证」= 由我们代办落地签，之前全落进「未标注」桶按落地签筛不出来
    expect(effectiveVisaClassification(null, VisaRequirement.NEEDED)).toEqual({
      issuanceMethod: 'ARRIVAL',
      entryType: null,
      issuanceSource: 'ORDER_STATUS',
      entrySource: null,
    });
  });

  it('产品标了贴纸签 + 录单需要签证 → 产品字段优先，不被 NEEDED 回退改写成落地签', () => {
    expect(
      effectiveVisaClassification(
        { issuanceMethod: VisaIssuanceMethod.STICKER, entryType: null },
        VisaRequirement.NEEDED,
      ),
    ).toEqual({
      issuanceMethod: 'STICKER',
      entryType: null,
      issuanceSource: 'PRODUCT',
      entrySource: null,
    });
  });

  it('无产品 + 录单签证状态=HAS_VISA/NOT_NEEDED/null（都不办签）→ 未标注（值与出处全 null）', () => {
    for (const status of [VisaRequirement.HAS_VISA, VisaRequirement.NOT_NEEDED, null]) {
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
  /** 无签证产品的纯机票录单单：签证信息只落在订单级「签证状态」上 */
  function orderLevelOnlyTaskRow(visaStatus: string) {
    const now = new Date('2026-07-15T00:00:00Z');
    return {
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
          visaStatus, // 录单签证状态：只表达签发方式，从不表达入境次数
        },
      },
    };
  }

  /** 录单签证状态 → 期望下发的有效签发方式（出处一律 ORDER_STATUS，前端浅色标「·录单」） */
  const fallbackCases: Array<{ visaStatus: string; expectedIssuance: string; note: string }> = [
    { visaStatus: 'E_VISA', expectedIssuance: 'E_VISA', note: '录单下拉选的就是「电子签」' },
    { visaStatus: 'NEEDED', expectedIssuance: 'ARRIVAL', note: '录单「需要签证」= 代办落地签' },
  ];

  for (const c of fallbackCases) {
    it(`无签证产品的 ${c.visaStatus} 录单单 → 下发 visaIssuanceMethod=${c.expectedIssuance} + source=ORDER_STATUS；入境次数不臆造（${c.note}）`, async () => {
      const taskFindMany = vi.fn().mockResolvedValue([orderLevelOnlyTaskRow(c.visaStatus)]);
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
      // 签发方式：回退有据 → 下发值 + 出处标（前端据此浅色标「·录单」）
      expect(task.visaIssuanceMethod).toBe(c.expectedIssuance);
      expect(task.visaIssuanceSource).toBe('ORDER_STATUS');
      // 入境次数：录单从未表达过，不臆造「单次/多次」
      expect(task.visaEntryType).toBeNull();
      expect(task.visaEntrySource).toBeNull();
    });
  }
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
  /**
   * 内存口径（现网真值）：
   *   有效签发方式 = 产品 issuanceMethod ?? 录单回退(订单级 visaStatus)
   *   录单回退：E_VISA → 电子签，NEEDED → 落地签，其余（HAS_VISA/NOT_NEEDED/NULL）→ 无
   */
  interface FallbackCase {
    label: string;
    visa: { issuanceMethod: VisaIssuanceMethod | null; entryType: null } | null;
    visaStatus: VisaRequirement | null;
  }
  const cases: FallbackCase[] = [
    { label: '产品标了电子签', visa: { issuanceMethod: VisaIssuanceMethod.E_VISA, entryType: null }, visaStatus: null },
    { label: '产品标了贴纸签', visa: { issuanceMethod: VisaIssuanceMethod.STICKER, entryType: null }, visaStatus: null },
    { label: '产品标了落地签', visa: { issuanceMethod: VisaIssuanceMethod.ARRIVAL, entryType: null }, visaStatus: null },
    { label: '无签证产品 + 录单电子签（回退）', visa: null, visaStatus: VisaRequirement.E_VISA },
    { label: '产品未标 + 录单电子签（回退）', visa: { issuanceMethod: null, entryType: null }, visaStatus: VisaRequirement.E_VISA },
    { label: '无签证产品 + 录单需要签证（回退落地签）', visa: null, visaStatus: VisaRequirement.NEEDED },
    { label: '产品未标 + 录单需要签证（回退落地签）', visa: { issuanceMethod: null, entryType: null }, visaStatus: VisaRequirement.NEEDED },
    { label: '产品标了贴纸签 + 录单需要签证（产品优先，不回退）', visa: { issuanceMethod: VisaIssuanceMethod.STICKER, entryType: null }, visaStatus: VisaRequirement.NEEDED },
    { label: '产品未标 + 录单已签证（不办签，无回退）', visa: null, visaStatus: VisaRequirement.HAS_VISA },
    { label: '产品未标 + 录单不需要签证（不办签，无回退）', visa: null, visaStatus: VisaRequirement.NOT_NEEDED },
    { label: '产品未标 + 订单级为空', visa: null, visaStatus: null },
  ];

  const ALL_FILTERS: Array<VisaIssuanceMethod | 'NONE'> = [
    VisaIssuanceMethod.E_VISA,
    VisaIssuanceMethod.STICKER,
    VisaIssuanceMethod.ARRIVAL,
    VisaIssuanceMethod.OTHER,
    'NONE',
  ];

  type WhereNode = Record<string, unknown>;

  /**
   * 迷你 where 求值器 —— 只认 issuanceMethodWhere 产出的那几种形状，把 where 施加到内存 case 上。
   * 刻意复刻 SQL 的 NULL 语义：可空列上的 `notIn` 遇 NULL 不成立（NULL NOT IN (...) 得 NULL 而非真），
   * 关系过滤 `visa: { is: {...} }` 在关系为空时不成立。
   */
  function matchesWhere(where: WhereNode, c: FallbackCase): boolean {
    if (Array.isArray(where.AND)) return (where.AND as WhereNode[]).every((w) => matchesWhere(w, c));
    if (Array.isArray(where.OR)) return (where.OR as WhereNode[]).some((w) => matchesWhere(w, c));
    if ('visa' in where) {
      const is = (where.visa as { is: { issuanceMethod?: VisaIssuanceMethod | null } | null }).is;
      if (is === null) return c.visa === null;
      return c.visa !== null && c.visa.issuanceMethod === (is.issuanceMethod ?? null);
    }
    if ('order' in where) {
      const o = where.order as WhereNode;
      if (Array.isArray(o.OR)) return (o.OR as WhereNode[]).some((w) => matchesWhere({ order: w }, c));
      const vs = o.visaStatus as VisaRequirement | { notIn: VisaRequirement[] } | null;
      if (vs === null) return c.visaStatus === null;
      if (typeof vs === 'object') return c.visaStatus !== null && !vs.notIn.includes(c.visaStatus);
      return c.visaStatus === vs;
    }
    throw new Error(`未支持的 where 形状：${JSON.stringify(where)}`);
  }

  it('对齐性质：每个筛选桶命中的单 === 内存分类算出该桶的单（逐 case × 逐筛选值）', () => {
    for (const c of cases) {
      const eff = effectiveVisaClassification(c.visa, c.visaStatus);
      for (const filter of ALL_FILTERS) {
        const inMemoryBucket =
          filter === 'NONE' ? eff.issuanceMethod === null : eff.issuanceMethod === filter;
        const where = issuanceMethodWhere(filter) as unknown as WhereNode;
        expect(matchesWhere(where, c), `${c.label} × 筛选=${filter}`).toBe(inMemoryBucket);
      }
    }
  });

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

  it('落地签同样含回退分支：产品未标 + 录单「需要签证」的单必须筛得到（签证岗反馈）', () => {
    // 先钉住内存真值：产品未标 + 录单 NEEDED → 有效签发方式 = ARRIVAL
    for (const c of cases) {
      const eff = effectiveVisaClassification(c.visa, c.visaStatus);
      if (!c.visa?.issuanceMethod && c.visaStatus === VisaRequirement.NEEDED) {
        expect(eff.issuanceMethod).toBe(VisaIssuanceMethod.ARRIVAL);
      }
    }
    const where = issuanceMethodWhere(VisaIssuanceMethod.ARRIVAL) as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ visa: { is: { issuanceMethod: 'ARRIVAL' } } });
    expect(where.OR[1]).toEqual({
      AND: [
        { OR: [{ visa: { is: null } }, { visa: { is: { issuanceMethod: null } } }] },
        { order: { visaStatus: 'NEEDED' } },
      ],
    });
  });

  it('无回退来源的签发方式（贴纸签 / 其他）→ 只认产品结构化字段', () => {
    expect(issuanceMethodWhere(VisaIssuanceMethod.STICKER)).toEqual({
      visa: { is: { issuanceMethod: 'STICKER' } },
    });
    expect(issuanceMethodWhere(VisaIssuanceMethod.OTHER)).toEqual({
      visa: { is: { issuanceMethod: 'OTHER' } },
    });
  });

  it('「未标注」= 产品未标 且 订单级无回退来源（E_VISA/NEEDED 都会回退成有值，不算未标注）', () => {
    const where = issuanceMethodWhere('NONE') as { AND: Array<Record<string, unknown>> };
    expect(where.AND[0]).toEqual({
      OR: [{ visa: { is: null } }, { visa: { is: { issuanceMethod: null } } }],
    });
    // 显式列出 NULL：SQL 里 NULL NOT IN (...) 得 NULL 而非真，不能只靠 notIn
    expect(where.AND[1]).toEqual({
      order: { OR: [{ visaStatus: null }, { visaStatus: { notIn: ['E_VISA', 'NEEDED'] } }] },
    });
  });

  it('未标注桶不再兜住录单「需要签证」的单（该单已归落地签桶）', () => {
    const noneWhere = issuanceMethodWhere('NONE') as unknown as WhereNode;
    const neededCases = cases.filter(
      (c) => !c.visa?.issuanceMethod && c.visaStatus === VisaRequirement.NEEDED,
    );
    expect(neededCases.length).toBeGreaterThan(0);
    for (const c of neededCases) {
      expect(matchesWhere(noneWhere, c), c.label).toBe(false);
    }
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

// ── 出发日期区间筛选（from/to；兼容旧单日）──────────────────────────────────
describe('FulfillmentService.list — 出发日期区间（from/to，兼容旧单日）', () => {
  it('给 from+to：SQL 带上下界（>= from 且 <= to），两个日期都以参数传入', async () => {
    mockPagedDataset([]);
    const p = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    const queryRaw = vi.fn().mockResolvedValue([{ orderId: 'ord-a' }]);
    p.$queryRaw = queryRaw;

    await new FulfillmentService().list({
      departureDateFrom: '2026-07-01',
      departureDateTo: '2026-07-31',
      page: 1,
      pageSize: 50,
    });

    const sql = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const text = sql.strings.join('?');
    expect(text).toContain('>=');
    expect(text).toContain('<=');
    expect(sql.values).toContain('2026-07-01');
    expect(sql.values).toContain('2026-07-31');
  });

  it('只给 from：SQL 只带下界（>= from），无上界', async () => {
    mockPagedDataset([]);
    const p = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    const queryRaw = vi.fn().mockResolvedValue([]);
    p.$queryRaw = queryRaw;

    await new FulfillmentService().list({ departureDateFrom: '2026-07-01', page: 1, pageSize: 50 });

    const sql = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const text = sql.strings.join('?');
    expect(text).toContain('>=');
    expect(text).not.toContain('<=');
    expect(sql.values).toContain('2026-07-01');
  });

  it('旧单日 departureDate 向后兼容：等价于 from=to=该日（上下界同值）', async () => {
    mockPagedDataset([]);
    const p = prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> };
    const queryRaw = vi.fn().mockResolvedValue([]);
    p.$queryRaw = queryRaw;

    await new FulfillmentService().list({ departureDate: '2026-07-20', page: 1, pageSize: 50 });

    const sql = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const text = sql.strings.join('?');
    expect(text).toContain('>=');
    expect(text).toContain('<=');
    // from=to=该日 → 两个边界参数都是同一天
    expect(sql.values.filter((v) => v === '2026-07-20')).toHaveLength(2);
  });
});

// ── 派生口径：全部到某档任务才算该档，部分取最早档 ──────────────────────────
describe('deriveVisaTaskStatus — 取最早（最低）一档', () => {
  it('空乘客 → PENDING（无人可送，保持待处理）', () => {
    expect(deriveVisaTaskStatus([])).toBe(FulfillmentStatus.PENDING);
  });

  it('全部已送签 → 任务 CONFIRMED', () => {
    expect(
      deriveVisaTaskStatus([VisaSubmissionStatus.CONFIRMED, VisaSubmissionStatus.CONFIRMED]),
    ).toBe(FulfillmentStatus.CONFIRMED);
  });

  it('部分已送、部分待处理 → 任务保持最早的 PENDING', () => {
    expect(
      deriveVisaTaskStatus([VisaSubmissionStatus.CONFIRMED, VisaSubmissionStatus.PENDING]),
    ).toBe(FulfillmentStatus.PENDING);
  });

  it('最早档是材料准备（无人还在待处理） → 任务 IN_PROGRESS', () => {
    expect(
      deriveVisaTaskStatus([VisaSubmissionStatus.IN_PROGRESS, VisaSubmissionStatus.CONFIRMED]),
    ).toBe(FulfillmentStatus.IN_PROGRESS);
  });
});

// ── 按人批量标记送签进度（部分送签核心入口）─────────────────────────────────
describe('FulfillmentService.batchUpdateVisaPassengerStatus', () => {
  function mockPassengers(rows: Array<{
    id: string;
    orderId: string;
    visaExempt: boolean;
    status: string;
    deletedAt?: Date | null;
  }>) {
    const findMany = vi.fn().mockResolvedValue(
      rows.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        visaExempt: r.visaExempt,
        order: { status: r.status, deletedAt: r.deletedAt ?? null },
      })),
    );
    const updateMany = vi.fn().mockResolvedValue({ count: rows.length });
    const p = prisma as unknown as {
      passenger: { findMany: typeof findMany; updateMany: typeof updateMany };
    };
    p.passenger = { findMany, updateMany };
    return { findMany, updateMany };
  }

  it('全部有效 → updateMany 只改这些乘客，受影响订单去重后各派生一次', async () => {
    const { updateMany } = mockPassengers([
      { id: 'p1', orderId: 'o1', visaExempt: false, status: 'PAID' },
      { id: 'p2', orderId: 'o1', visaExempt: false, status: 'PAID' }, // 同单 → 只派生一次
    ]);
    const service = new FulfillmentService();
    const rederive = vi
      .spyOn(
        service as unknown as { rederiveVisaTasksForOrder: (o: string) => Promise<unknown> },
        'rederiveVisaTasksForOrder',
      )
      .mockResolvedValue(FulfillmentStatus.CONFIRMED as never);

    const res = await service.batchUpdateVisaPassengerStatus(
      ['p1', 'p2'],
      VisaSubmissionStatus.CONFIRMED,
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] } },
      data: { visaSubmissionStatus: VisaSubmissionStatus.CONFIRMED },
    });
    expect(rederive).toHaveBeenCalledTimes(1); // o1 去重
    expect(rederive).toHaveBeenCalledWith('o1');
    expect(res).toMatchObject({ successCount: 2, failureCount: 0, affectedOrderIds: ['o1'] });
  });

  it('自备签 / 死单 / 不存在的乘客各自失败，有效乘客照常处理', async () => {
    const { updateMany } = mockPassengers([
      { id: 'ok', orderId: 'o1', visaExempt: false, status: 'PAID' },
      { id: 'exempt', orderId: 'o1', visaExempt: true, status: 'PAID' },
      { id: 'dead', orderId: 'o2', visaExempt: false, status: 'CANCELLED' },
      // 'missing' 不在库中返回
    ]);
    const service = new FulfillmentService();
    vi.spyOn(
      service as unknown as { rederiveVisaTasksForOrder: (o: string) => Promise<unknown> },
      'rederiveVisaTasksForOrder',
    ).mockResolvedValue(FulfillmentStatus.IN_PROGRESS as never);

    const res = await service.batchUpdateVisaPassengerStatus(
      ['ok', 'exempt', 'dead', 'missing'],
      VisaSubmissionStatus.IN_PROGRESS,
    );

    // 只改有效乘客
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ok'] } },
      data: { visaSubmissionStatus: VisaSubmissionStatus.IN_PROGRESS },
    });
    expect(res.successCount).toBe(1);
    expect(res.failureCount).toBe(3);
    const failIds = res.failures.map((f) => f.id).sort();
    expect(failIds).toEqual(['dead', 'exempt', 'missing']);
  });

  it('无有效乘客 → 不 updateMany、不派生', async () => {
    const { updateMany } = mockPassengers([
      { id: 'exempt', orderId: 'o1', visaExempt: true, status: 'PAID' },
    ]);
    const service = new FulfillmentService();
    const rederive = vi
      .spyOn(
        service as unknown as { rederiveVisaTasksForOrder: (o: string) => Promise<unknown> },
        'rederiveVisaTasksForOrder',
      )
      .mockResolvedValue(FulfillmentStatus.PENDING as never);

    const res = await service.batchUpdateVisaPassengerStatus(
      ['exempt'],
      VisaSubmissionStatus.CONFIRMED,
    );

    expect(updateMany).not.toHaveBeenCalled();
    expect(rederive).not.toHaveBeenCalled();
    expect(res).toMatchObject({ successCount: 0, failureCount: 1, affectedOrderIds: [] });
  });
});
