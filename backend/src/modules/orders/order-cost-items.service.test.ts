/**
 * order-cost-items.service · 单元测试（vitest）
 *
 * 覆盖（C-17）：update/remove 的先查后写窗口内记录被并发删除（P2025）时，
 * 应转译成 NotFoundError（→ 路由层 404），而不是让裸 Prisma 错误冒到全局错误处理器的
 * 500 兜底（此前 order-cost-items.routes.ts 的 PATCH/DELETE 之间没有任何 try/catch）。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { Prisma, type PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';
import { create, listByOrder, remove, update } from './order-cost-items.service.js';

function p2025(message = 'Record to update not found.') {
  return new Prisma.PrismaClientKnownRequestError(message, { code: 'P2025', clientVersion: 'test' });
}

describe('order-cost-items.service · update', () => {
  it('并发下记录已被删除（P2025）→ 抛 NotFoundError 而非原样 500', async () => {
    const client = {
      orderCostItem: {
        update: vi.fn().mockRejectedValue(p2025()),
      },
    } as unknown as PrismaClient;

    await expect(update('missing-id', { amountCny: 100 }, client)).rejects.toBeInstanceOf(NotFoundError);
    await expect(update('missing-id', { amountCny: 100 }, client)).rejects.toThrow('成本明细不存在或已被删除');
  });

  it('其它数据库错误原样抛出（不误吞成 404）', async () => {
    const boom = new Error('connection reset');
    const client = {
      orderCostItem: { update: vi.fn().mockRejectedValue(boom) },
    } as unknown as PrismaClient;

    await expect(update('id1', { amountCny: 100 }, client)).rejects.toBe(boom);
  });

  it('正常更新返回转换后的 DTO（amountCny 从 Decimal 转 number）', async () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    const client = {
      orderCostItem: {
        update: vi.fn().mockResolvedValue({
          id: 'id1',
          orderId: 'order1',
          category: 'HANDLING_FEE',
          amountCny: new Prisma.Decimal(88.5),
          note: '手续费',
          createdAt: now,
          updatedAt: now,
        }),
      },
    } as unknown as PrismaClient;

    const dto = await update('id1', { amountCny: 88.5 }, client);
    expect(dto.amountCny).toBe(88.5);
    expect(dto.category).toBe('HANDLING_FEE');
  });
});

describe('order-cost-items.service · remove', () => {
  it('并发下记录已被删除（P2025）→ 抛 NotFoundError', async () => {
    const client = {
      orderCostItem: { delete: vi.fn().mockRejectedValue(p2025('Record to delete does not exist.')) },
    } as unknown as PrismaClient;

    await expect(remove('missing-id', client)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('其它数据库错误原样抛出', async () => {
    const boom = new Error('connection reset');
    const client = {
      orderCostItem: { delete: vi.fn().mockRejectedValue(boom) },
    } as unknown as PrismaClient;

    await expect(remove('id1', client)).rejects.toBe(boom);
  });

  it('正常删除返回 { id }', async () => {
    const client = {
      orderCostItem: { delete: vi.fn().mockResolvedValue({}) },
    } as unknown as PrismaClient;

    await expect(remove('id1', client)).resolves.toEqual({ id: 'id1' });
  });
});

describe('order-cost-items.service · create / listByOrder（回归，未改动行为）', () => {
  it('create 把 amountCny 转成 Decimal 落库、DTO 转回 number', async () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    const createFn = vi.fn().mockResolvedValue({
      id: 'id1',
      orderId: 'order1',
      category: 'OTHER',
      amountCny: new Prisma.Decimal(200),
      note: null,
      createdAt: now,
      updatedAt: now,
    });
    const client = { orderCostItem: { create: createFn } } as unknown as PrismaClient;

    const dto = await create('order1', { category: 'OTHER', amountCny: 200 }, client);
    expect(dto.amountCny).toBe(200);
    expect(createFn).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: 'order1', category: 'OTHER' }),
    });
  });

  it('listByOrder 按 createdAt 升序列出并转换 DTO', async () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'id1',
        orderId: 'order1',
        category: 'GUIDE_SERVICE',
        amountCny: new Prisma.Decimal(50),
        note: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const client = { orderCostItem: { findMany } } as unknown as PrismaClient;

    const items = await listByOrder('order1', client);
    expect(items).toHaveLength(1);
    expect(items[0].amountCny).toBe(50);
    expect(findMany).toHaveBeenCalledWith({
      where: { orderId: 'order1' },
      orderBy: { createdAt: 'asc' },
    });
  });
});
