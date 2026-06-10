/**
 * 班次开票上限（191）· 单元测试
 *
 * 覆盖：
 *   1. assertTicketingCap：未超限放行 / 恰好到上限放行 / 超限抛 422 / 班次不存在跳过 / 去重 / 自定义上限
 *   2. OrderService.setInvoiceStatus：转 ISSUED 校验上限；已 ISSUED 幂等跳过；
 *      非 ISSUED 目标不校验；订单不存在 404
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertTicketingCap } from './ticketing-cap.js';
import { UnprocessableEntityError } from '../../lib/errors.js';

// ── setInvoiceStatus 需要 mock prisma（vi.mock 会 hoist，变量也要 hoist）──
const { txMock, mockPrisma } = vi.hoisted(() => {
  const txMock = {
    order: { findUnique: vi.fn(), update: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    passenger: { count: vi.fn() },
  };
  return {
    txMock,
    mockPrisma: {
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
    },
  };
});

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';

// ── assertTicketingCap 用的轻量 fake db（无需 vi.mock，直接传参）──
interface FakeDb {
  flightSchedule: { findUnique: ReturnType<typeof vi.fn> };
  passenger: { count: ReturnType<typeof vi.fn> };
}

function fakeDb(opts: { cap: number | null; issued: number }): FakeDb {
  return {
    flightSchedule: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.cap === null ? null : { ticketingCap: opts.cap }),
    },
    passenger: { count: vi.fn().mockResolvedValue(opts.issued) },
  };
}

// 只用到 flightSchedule/passenger 两个 delegate；窄化后传入
const asDb = (db: FakeDb) => db as unknown as Parameters<typeof assertTicketingCap>[0];

describe('assertTicketingCap', () => {
  it('已开票 + 新增 ≤ 上限 → 放行（190 + 1 = 191）', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: 191, issued: 190 })), ['sch1'], 1),
    ).resolves.toBeUndefined();
  });

  it('已开票 + 新增 > 上限 → 抛 422，消息含已开票数与上限', async () => {
    const err = await assertTicketingCap(
      asDb(fakeDb({ cap: 191, issued: 191 })),
      ['sch1'],
      1,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect((err as UnprocessableEntityError).statusCode).toBe(422);
    expect((err as Error).message).toBe('该班次已开票 191 张，最多 191 张，无法继续开票');
  });

  it('多乘客订单：189 已开 + 3 人 → 超 191 拒绝', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: 191, issued: 189 })), ['sch1'], 3),
    ).rejects.toThrow(/已开票 189 张，最多 191 张/);
  });

  it('班次不存在 → 跳过校验不计数', async () => {
    const db = fakeDb({ cap: null, issued: 0 });
    await expect(assertTicketingCap(asDb(db), ['gone'], 5)).resolves.toBeUndefined();
    expect(db.passenger.count).not.toHaveBeenCalled();
  });

  it('重复 scheduleId 去重，只查一次', async () => {
    const db = fakeDb({ cap: 191, issued: 0 });
    await assertTicketingCap(asDb(db), ['sch1', 'sch1'], 2);
    expect(db.flightSchedule.findUnique).toHaveBeenCalledTimes(1);
  });

  it('按班次自定义上限（ticketingCap=100）生效', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: 100, issued: 100 })), ['sch1'], 1),
    ).rejects.toThrow(/最多 100 张/);
  });
});

describe('OrderService.setInvoiceStatus', () => {
  const service = new OrderService();

  beforeEach(() => {
    vi.clearAllMocks();
    txMock.order.update.mockResolvedValue({
      id: 'ord1',
      orderNumber: 'ORD-001',
      invoiceStatus: 'ISSUED',
    });
  });

  function stubOrder(overrides: Record<string, unknown> = {}) {
    txMock.order.findUnique.mockResolvedValue({
      invoiceStatus: 'NONE',
      items: [{ flightScheduleId: 'sch1' }],
      _count: { passengers: 2 },
      ...overrides,
    });
  }

  it('订单不存在 → NotFoundError', async () => {
    txMock.order.findUnique.mockResolvedValue(null);
    await expect(service.setInvoiceStatus('missing', 'ISSUED')).rejects.toThrow(/不存在/);
    expect(txMock.order.update).not.toHaveBeenCalled();
  });

  it('转 ISSUED 未超限 → 正常更新', async () => {
    stubOrder();
    txMock.flightSchedule.findUnique.mockResolvedValue({ ticketingCap: 191 });
    txMock.passenger.count.mockResolvedValue(100);

    const result = await service.setInvoiceStatus('ord1', 'ISSUED');
    expect(result.invoiceStatus).toBe('ISSUED');
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invoiceStatus: 'ISSUED' } }),
    );
  });

  it('转 ISSUED 超限 → 422 且不更新', async () => {
    stubOrder();
    txMock.flightSchedule.findUnique.mockResolvedValue({ ticketingCap: 191 });
    txMock.passenger.count.mockResolvedValue(190); // 190 + 2 > 191

    await expect(service.setInvoiceStatus('ord1', 'ISSUED')).rejects.toThrow(
      /已开票 190 张，最多 191 张，无法继续开票/,
    );
    expect(txMock.order.update).not.toHaveBeenCalled();
  });

  it('已是 ISSUED 再设 ISSUED → 幂等，跳过上限校验', async () => {
    stubOrder({ invoiceStatus: 'ISSUED' });
    await service.setInvoiceStatus('ord1', 'ISSUED');
    expect(txMock.flightSchedule.findUnique).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalled();
  });

  it('改回 REQUESTED → 不校验上限', async () => {
    stubOrder({ invoiceStatus: 'ISSUED' });
    await service.setInvoiceStatus('ord1', 'REQUESTED');
    expect(txMock.flightSchedule.findUnique).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invoiceStatus: 'REQUESTED' } }),
    );
  });
});
