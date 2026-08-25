/**
 * 批量改航班服务层测试：验证航段解析、已出票守卫和逐单隔离。
 * 座位搬移本身由 rescheduleOrderItem 的事务负责；这里确认批量入口正确传递 guard/correction，
 * 且一单失败不会阻断后续订单。真实服务分支见 orders.service.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CabinClass, OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderItem: { findUnique: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { batchRescheduleBodySchema } from './orders.schemas.js';

const service = new OrderService();
const ACTOR = { userId: 'staff-1', role: UserRole.STAFF } as const;
type BatchInput = Parameters<OrderService['batchReschedule']>[0];
type RescheduleResult = Awaited<ReturnType<OrderService['rescheduleOrderItem']>>;

function flightItem(id: string, scheduleId: string, departureTime: string) {
  return {
    id,
    flightScheduleId: scheduleId,
    flightCabin: CabinClass.ECONOMY,
    flightSchedule: { departureTime: new Date(departureTime) },
  };
}

function orderRecord(
  id: string,
  status: OrderStatus,
  items: ReturnType<typeof flightItem>[],
) {
  return { id, orderNumber: `FT-${id}`, status, items };
}

function input(orderIds: string[], leg: BatchInput['leg'], allowTicketed = false): BatchInput {
  return {
    orderIds,
    leg,
    newScheduleId: 'schedule-new',
    allowTicketed,
  };
}

function successfulReschedule(orderId: string, orderItemId: string): RescheduleResult {
  return {
    order: { orderNumber: `FT-${orderId}` } as RescheduleResult['order'],
    audit: {
      orderNumber: `FT-${orderId}`,
      orderItemId,
      fromScheduleId: 'schedule-old',
      fromCabin: CabinClass.ECONOMY,
      fromDeparture: new Date('2026-08-25T01:00:00.000Z'),
      toScheduleId: 'schedule-new',
      toCabin: CabinClass.ECONOMY,
      toDeparture: new Date('2026-08-26T01:00:00.000Z'),
      feeCny: 0,
      statusChanged: false,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('OrderService.batchReschedule', () => {
  it('拒绝重复 orderIds，避免同一订单被批量改两次', () => {
    const parsed = batchRescheduleBodySchema.safeParse({
      orderIds: ['same-order', 'same-order'],
      leg: 'OUTBOUND',
      newScheduleId: 'schedule-new',
    });

    expect(parsed.success).toBe(false);
  });

  it('单程订单选择回程 → 单条改期返回航段错误并记为失败', async () => {
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockRejectedValue(new Error('本单没有回程航段'));

    const result = await service.batchReschedule(input(['one-way'], 'RETURN'), ACTOR);

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ ok: false, error: '本单没有回程航段' });
    expect(reschedule).toHaveBeenCalledWith(
      'one-way',
      expect.objectContaining({ leg: 'RETURN', guard: { forbidTicketed: true, correction: true } }),
      ACTOR,
    );
  });

  it('已出票订单默认拦截；勾选同时修改已出票订单后才调用单条改期', async () => {
    const reschedule = vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockImplementation(async (orderId, item) => {
        if (item.guard?.forbidTicketed) {
          throw new Error('订单已出票/已完成，需勾选「同时修改已出票订单」后才能改');
        }
        return successfulReschedule(orderId, 'ticketed-item');
      });

    const blocked = await service.batchReschedule(input(['ticketed'], 'OUTBOUND'), ACTOR);
    expect(blocked.results[0]).toMatchObject({
      ok: false,
      error: '订单已出票/已完成，需勾选「同时修改已出票订单」后才能改',
    });
    expect(reschedule).toHaveBeenCalledTimes(1);

    const allowed = await service.batchReschedule(input(['ticketed'], 'OUTBOUND', true), ACTOR);
    expect(allowed).toMatchObject({ succeeded: 1, failed: 0 });
    expect(reschedule).toHaveBeenCalledWith(
      'ticketed',
      expect.objectContaining({
        leg: 'OUTBOUND',
        newScheduleId: 'schedule-new',
        guard: { forbidTicketed: false, correction: true },
      }),
      ACTOR,
    );
  });

  it('事务已提交但回包异常：回读已改班次后记为成功并标注', async () => {
    mockPrisma.$transaction.mockReset().mockResolvedValue({
      orderItemId: 'item-1',
      oldScheduleId: 'schedule-old',
      oldCabin: CabinClass.ECONOMY,
      newScheduleId: 'schedule-new',
      newCabin: CabinClass.ECONOMY,
      statusChanged: false,
    });
    mockPrisma.flightSchedule.findUnique.mockReset().mockResolvedValue({
      departureTime: new Date('2026-08-25T01:00:00.000Z'),
    });
    mockPrisma.order.findUniqueOrThrow.mockReset().mockRejectedValue(Object.freeze(new Error('回包序列化失败')));
    mockPrisma.orderItem.findUnique.mockReset();
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      orderId: 'committed',
      flightScheduleId: 'schedule-new',
      flightCabin: CabinClass.ECONOMY,
      order: { orderNumber: 'FT-committed' },
    });

    const result = await service.batchReschedule(input(['committed'], 'OUTBOUND'), ACTOR);

    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      id: 'committed',
      ok: true,
      notice: '已生效（回包异常）',
      orderNumber: 'FT-committed',
    });
  });

  it('事务已提交但回读班次不匹配：仍记为失败', async () => {
    mockPrisma.$transaction.mockReset().mockResolvedValue({
      orderItemId: 'item-1',
      oldScheduleId: 'schedule-old',
      oldCabin: CabinClass.ECONOMY,
      newScheduleId: 'schedule-new',
      newCabin: CabinClass.ECONOMY,
      statusChanged: false,
    });
    mockPrisma.flightSchedule.findUnique.mockReset().mockResolvedValue({ departureTime: new Date() });
    mockPrisma.order.findUniqueOrThrow.mockReset().mockRejectedValue(new Error('回包序列化失败'));
    mockPrisma.orderItem.findUnique.mockReset().mockResolvedValue({
      orderId: 'committed',
      flightScheduleId: 'another-schedule',
      flightCabin: CabinClass.ECONOMY,
      order: { orderNumber: 'FT-committed' },
    });

    const result = await service.batchReschedule(input(['committed'], 'OUTBOUND'), ACTOR);

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ id: 'committed', ok: false, error: '回包序列化失败' });
  });

  it('事务已提交但回读本身失败：仍记为失败', async () => {
    mockPrisma.$transaction.mockReset().mockResolvedValue({
      orderItemId: 'item-1',
      oldScheduleId: 'schedule-old',
      oldCabin: CabinClass.ECONOMY,
      newScheduleId: 'schedule-new',
      newCabin: CabinClass.ECONOMY,
      statusChanged: false,
    });
    mockPrisma.flightSchedule.findUnique.mockReset().mockResolvedValue({ departureTime: new Date() });
    mockPrisma.order.findUniqueOrThrow.mockReset().mockRejectedValue(new Error('回包序列化失败'));
    mockPrisma.orderItem.findUnique.mockReset().mockRejectedValue(new Error('回读数据库失败'));

    const result = await service.batchReschedule(input(['committed'], 'OUTBOUND'), ACTOR);

    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ id: 'committed', ok: false, error: '回包序列化失败' });
  });

  it('混批中一单新班次售罄 → 该单失败，其余订单继续成功', async () => {
    mockPrisma.order.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      orderRecord(
        where.id,
        OrderStatus.PAID,
        [flightItem(`${where.id}-item`, `${where.id}-schedule`, '2026-08-25T01:00:00.000Z')],
      ),
    );
    const reschedule = vi.spyOn(service, 'rescheduleOrderItem').mockImplementation(async (orderId, item) => {
      if (orderId === 'sold-out') throw new Error('目标班次余位不足');
      return successfulReschedule(orderId, item.orderItemId);
    });

    const result = await service.batchReschedule(input(['sold-out', 'available'], 'OUTBOUND'), ACTOR);

    expect(result).toMatchObject({ succeeded: 1, failed: 1 });
    expect(result.results).toEqual([
      { id: 'sold-out', ok: false, error: '目标班次余位不足' },
      expect.objectContaining({ id: 'available', ok: true }),
    ]);
    expect(reschedule).toHaveBeenCalledTimes(2);
  });

  it('往返订单改去程只取第 1 段，改回程只取第 2 段', async () => {
    const reschedule = vi.spyOn(service, 'rescheduleOrderItem').mockImplementation(async (orderId, item) =>
      successfulReschedule(orderId, item.orderItemId ?? `${item.leg?.toLowerCase()}-item`),
    );

    await service.batchReschedule(input(['round-trip'], 'OUTBOUND'), ACTOR);
    await service.batchReschedule(input(['round-trip'], 'RETURN'), ACTOR);

    expect(reschedule).toHaveBeenNthCalledWith(
      1,
      'round-trip',
      expect.objectContaining({ leg: 'OUTBOUND' }),
      ACTOR,
    );
    expect(reschedule).toHaveBeenNthCalledWith(
      2,
      'round-trip',
      expect.objectContaining({ leg: 'RETURN' }),
      ACTOR,
    );
  });
});
