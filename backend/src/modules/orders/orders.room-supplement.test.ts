/**
 * 事后补收单房差 · 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. buildRoomSupplementItem：金额 = perNightCny × nights，FEE 行、描述可读、metadata 打标。
 *   2. roomSupplementBodySchema：每晚金额正整数 / 晚数 1–60 边界校验。
 *   3. addRoomSupplement 权限：非 ADMIN/STAFF（CUSTOMER/AGENT）→ ForbiddenError（未触库）。
 *   4. addRoomSupplement 纯机票单拒绝：订单只含 FLIGHT 行 → BadRequestError（事务内早拦）。
 *
 * 「计入 total / 审计流水追加」需真 DB 全链路 —— 见 orders.room-supplement.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService, buildRoomSupplementItem } from './orders.service.js';
import { BadRequestError, ForbiddenError } from '../../lib/errors.js';
import { roomSupplementBodySchema, ROOM_SUPPLEMENT_MAX_NIGHTS } from './orders.schemas.js';

const service = new OrderService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildRoomSupplementItem', () => {
  it('金额 = perNightCny × nights，FEE 行、描述含 ¥X/晚 × N晚、metadata 打标', () => {
    const row = buildRoomSupplementItem({ perNightCny: 300, nights: 4 });
    expect(row.kind).toBe('FEE');
    expect(row.amount).toBe(1200);
    expect(row.unitPrice).toBe(1200);
    expect(row.quantity).toBe(1);
    expect(row.description).toBe('补收单房差 ¥300/晚 × 4晚');
    expect(row.metadata).toMatchObject({
      priceAdjustment: true,
      reasonCode: 'ROOM_DIFF',
      perNightCny: 300,
      nights: 4,
      note: null,
    });
  });

  it('单晚：金额 = perNightCny', () => {
    const row = buildRoomSupplementItem({ perNightCny: 500, nights: 1 });
    expect(row.amount).toBe(500);
    expect(row.description).toBe('补收单房差 ¥500/晚 × 1晚');
  });

  it('备注落 metadata.note（不拼进描述）', () => {
    const row = buildRoomSupplementItem({ perNightCny: 200, nights: 3, note: '客户单房' });
    expect(row.description).toBe('补收单房差 ¥200/晚 × 3晚');
    expect(row.metadata.note).toBe('客户单房');
  });
});

describe('roomSupplementBodySchema · 输入校验', () => {
  it('正常：每晚金额正整数 + 晚数在 1–60', () => {
    expect(roomSupplementBodySchema.safeParse({ perNightCny: 300, nights: 5 }).success).toBe(true);
    expect(roomSupplementBodySchema.safeParse({ perNightCny: 1, nights: 1 }).success).toBe(true);
    expect(
      roomSupplementBodySchema.safeParse({ perNightCny: 300, nights: ROOM_SUPPLEMENT_MAX_NIGHTS })
        .success,
    ).toBe(true);
  });

  it('每晚金额 0 / 负数 / 非整数 → 拒绝', () => {
    expect(roomSupplementBodySchema.safeParse({ perNightCny: 0, nights: 3 }).success).toBe(false);
    expect(roomSupplementBodySchema.safeParse({ perNightCny: -100, nights: 3 }).success).toBe(false);
    expect(roomSupplementBodySchema.safeParse({ perNightCny: 99.5, nights: 3 }).success).toBe(false);
  });

  it('晚数 0 / 超过上限 / 非整数 → 拒绝', () => {
    expect(roomSupplementBodySchema.safeParse({ perNightCny: 300, nights: 0 }).success).toBe(false);
    expect(
      roomSupplementBodySchema.safeParse({
        perNightCny: 300,
        nights: ROOM_SUPPLEMENT_MAX_NIGHTS + 1,
      }).success,
    ).toBe(false);
    expect(roomSupplementBodySchema.safeParse({ perNightCny: 300, nights: 2.5 }).success).toBe(false);
  });
});

describe('OrderService.addRoomSupplement · 权限（服务端按认证身份判）', () => {
  const body = { perNightCny: 300, nights: 4 };

  it.each(['CUSTOMER', 'AGENT'] as const)('%s 调用 → ForbiddenError，且未开事务', async (role) => {
    await expect(
      service.addRoomSupplement('o1', body, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('OrderService.addRoomSupplement · 纯机票单拒绝（事务内早拦）', () => {
  it('订单只含 FLIGHT 行 → BadRequestError，不新增 FEE 行', async () => {
    // 让 $transaction 就地执行回调，注入只含 FLIGHT 行的订单。
    const tx = {
      // FOR UPDATE 行锁：事务开头执行，测试里 no-op。
      $queryRaw: vi.fn().mockResolvedValue([]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'o1',
          orderNumber: 'ORD-1',
          subtotal: new Prisma.Decimal(1000),
          total: new Prisma.Decimal(1000),
          adjustments: [],
          items: [{ id: 'i1', kind: 'FLIGHT', amount: new Prisma.Decimal(1000) }],
        }),
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
      },
      orderItem: { create: vi.fn(), findUnique: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));

    await expect(
      service.addRoomSupplement(
        'o1',
        { perNightCny: 300, nights: 4 },
        { userId: 'admin', role: 'ADMIN' },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
