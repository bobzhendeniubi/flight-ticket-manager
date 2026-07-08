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

import { FulfillmentStatus } from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';
import { prisma } from '../../db/prisma.js';
import { FulfillmentService } from './fulfillment.service.js';

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
