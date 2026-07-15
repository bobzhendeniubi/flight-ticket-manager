/**
 * 班次开票上限（191）· 按航段口径 · 单元测试
 *
 * 覆盖：
 *   1. determineFlightLegs：去程/回程按 departureTime 升序判定；单程/多段/缺字段
 *   2. countIssuedPassengers：某班次已开票乘客数按「该班次是订单去程 ? outboundInvoiced : returnInvoiced」计，
 *      且订单状态需在 COUNTED_STATUSES 内——取消族订单（如已开票后转 CANCELLED）不再占额度
 *   3. assertTicketingCap：未超限放行 / 恰好到上限放行 / 超限抛 422 / 班次不存在跳过 / 去重 / 自定义上限
 *   4. OrderService.setInvoiceFlags：翻某航段为已开时校验对应班次上限；翻回未开/系统开不校验；订单不存在 404
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus } from '@prisma/client';
import {
  assertTicketingCap,
  countIssuedPassengers,
  determineFlightLegs,
} from './ticketing-cap.js';
import { UnprocessableEntityError } from '../../lib/errors.js';

// ── setInvoiceFlags 需要 mock prisma（vi.mock 会 hoist，变量也要 hoist）──
const { txMock, mockPrisma } = vi.hoisted(() => {
  const txMock = {
    order: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
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

// ── 测试数据小工具 ─────────────────────────────────────────────────────────
type Leg = [scheduleId: string, departISO: string];
interface FakeOrder {
  status: OrderStatus;
  outboundInvoiced: boolean;
  returnInvoiced: boolean;
  _count: { passengers: number };
  items: Array<{ flightScheduleId: string; flightSchedule: { departureTime: Date } }>;
}
function fakeOrder(
  pax: number,
  legs: Leg[],
  flags: { out?: boolean; ret?: boolean; status?: OrderStatus } = {},
): FakeOrder {
  return {
    status: flags.status ?? OrderStatus.PAID, // 未指定时默认落在 COUNTED_STATUSES 内，保持既有用例行为
    outboundInvoiced: flags.out ?? false,
    returnInvoiced: flags.ret ?? false,
    _count: { passengers: pax },
    items: legs.map(([sid, iso]) => ({
      flightScheduleId: sid,
      flightSchedule: { departureTime: new Date(iso) },
    })),
  };
}

// assertTicketingCap / countIssuedPassengers 用的轻量 fake db（无需 vi.mock，直接传参）
// order.findMany 会按传入的 where.status.in 实际过滤 opts.orders —— 用来验证
// countIssuedPassengers 真的把 status 过滤条件下推给了查询，而不是查回全部订单再各自判定。
function fakeDb(opts: { cap: number | null; orders: FakeOrder[] }) {
  return {
    flightSchedule: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.cap === null ? null : { ticketingCap: opts.cap }),
    },
    order: {
      findMany: vi
        .fn()
        .mockImplementation((args: { where?: { status?: { in: OrderStatus[] } } } = {}) => {
          const allowed = args.where?.status?.in;
          const filtered = allowed
            ? opts.orders.filter((o) => allowed.includes(o.status))
            : opts.orders;
          return Promise.resolve(filtered);
        }),
    },
  };
}
type FakeDb = ReturnType<typeof fakeDb>;
const asDb = (db: FakeDb) => db as unknown as Parameters<typeof assertTicketingCap>[0];

// ── 迁移回填语义（存量 invoiceStatus=ISSUED → 三个布尔全 true）────────────────
describe('migration 20260708130000_order_invoice_legs — 回填语义', () => {
  const sql = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../prisma/migrations/20260708130000_order_invoice_legs/migration.sql',
    ),
    'utf8',
  );

  it('新增三个布尔列，默认 false（未开）', () => {
    for (const col of ['outboundInvoiced', 'returnInvoiced', 'systemInvoiced']) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN "${col}" BOOLEAN NOT NULL DEFAULT false`));
    }
  });

  it('存量 ISSUED 单回填三个布尔=true（整单已开口径）', () => {
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toMatch(/UPDATE "Order" SET "outboundInvoiced" = true, "returnInvoiced" = true, "systemInvoiced" = true WHERE "invoiceStatus" = 'ISSUED'/);
  });
});

// ── determineFlightLegs ────────────────────────────────────────────────────
describe('determineFlightLegs', () => {
  it('单程：只有去程，回程为 null', () => {
    expect(
      determineFlightLegs([
        { flightScheduleId: 'a', flightSchedule: { departureTime: new Date('2026-07-10T02:00:00Z') } },
      ]),
    ).toEqual({ outboundScheduleId: 'a', returnScheduleId: null });
  });

  it('往返：按 departureTime 升序，最早=去程、次早=回程（乱序输入也正确）', () => {
    const legs = determineFlightLegs([
      { flightScheduleId: 'ret', flightSchedule: { departureTime: new Date('2026-07-17T05:00:00Z') } },
      { flightScheduleId: 'out', flightSchedule: { departureTime: new Date('2026-07-10T02:00:00Z') } },
    ]);
    expect(legs).toEqual({ outboundScheduleId: 'out', returnScheduleId: 'ret' });
  });

  it('>2 段：只认前两段', () => {
    const legs = determineFlightLegs([
      { flightScheduleId: 's1', flightSchedule: { departureTime: new Date('2026-07-10T02:00:00Z') } },
      { flightScheduleId: 's2', flightSchedule: { departureTime: new Date('2026-07-12T02:00:00Z') } },
      { flightScheduleId: 's3', flightSchedule: { departureTime: new Date('2026-07-17T02:00:00Z') } },
    ]);
    expect(legs).toEqual({ outboundScheduleId: 's1', returnScheduleId: 's2' });
  });

  it('缺 flightScheduleId / departureTime 的行被跳过', () => {
    const legs = determineFlightLegs([
      { flightScheduleId: null },
      { flightScheduleId: 'only', flightSchedule: { departureTime: new Date('2026-07-10T02:00:00Z') } },
    ]);
    expect(legs).toEqual({ outboundScheduleId: 'only', returnScheduleId: null });
  });
});

// ── countIssuedPassengers（按航段口径）───────────────────────────────────────
describe('countIssuedPassengers', () => {
  const OUT = 'schOut';
  const RET = 'schRet';
  const OUT_ISO = '2026-07-10T02:00:00Z';
  const RET_ISO = '2026-07-17T05:00:00Z';

  it('班次作为去程：只计 outboundInvoiced=true 的订单乘客', async () => {
    const db = fakeDb({
      cap: 191,
      orders: [
        fakeOrder(3, [[OUT, OUT_ISO], [RET, RET_ISO]], { out: true, ret: false }), // 计入 3
        fakeOrder(2, [[OUT, OUT_ISO], [RET, RET_ISO]], { out: false, ret: true }), // 去程未开 → 不计
      ],
    });
    await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(3);
  });

  it('班次作为回程：只计 returnInvoiced=true 的订单乘客', async () => {
    const db = fakeDb({
      cap: 191,
      orders: [
        fakeOrder(3, [[OUT, OUT_ISO], [RET, RET_ISO]], { out: true, ret: false }), // 回程未开 → 不计
        fakeOrder(2, [[OUT, OUT_ISO], [RET, RET_ISO]], { out: false, ret: true }), // 计入 2
      ],
    });
    await expect(countIssuedPassengers(asDb(db), RET)).resolves.toBe(2);
  });

  it('同一班次既是 A 单去程(已开)又是 B 单回程(已开) → 两段乘客都计入', async () => {
    const SHARED = 'shared';
    const db = fakeDb({
      cap: 191,
      orders: [
        // A：SHARED 是最早段=去程，去程已开 → 计 4
        fakeOrder(4, [[SHARED, '2026-07-10T02:00:00Z'], ['x', '2026-07-17T05:00:00Z']], { out: true }),
        // B：SHARED 是次早段=回程，回程已开 → 计 5
        fakeOrder(5, [['y', '2026-07-01T02:00:00Z'], [SHARED, '2026-07-10T02:00:00Z']], { ret: true }),
      ],
    });
    await expect(countIssuedPassengers(asDb(db), SHARED)).resolves.toBe(9);
  });

  it('已开票后订单转 CANCELLED → 不再计入 issued，额度释放（P1-11）', async () => {
    const db = fakeDb({
      cap: 191,
      orders: [
        // 已开票但订单已取消 → 不应计入占额
        fakeOrder(3, [[OUT, OUT_ISO]], { out: true, status: OrderStatus.CANCELLED }),
        // 已开票且订单仍是有效状态 → 正常计入
        fakeOrder(2, [[OUT, OUT_ISO]], { out: true, status: OrderStatus.TICKETED }),
      ],
    });
    await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(2);
  });

  it('已开票后订单转 REFUNDED / PAYMENT_TIMEOUT / FAILED / DRAFT → 均不计入 issued', async () => {
    const cancelFamily = [
      OrderStatus.REFUNDED,
      OrderStatus.PAYMENT_TIMEOUT,
      OrderStatus.FAILED,
      OrderStatus.DRAFT,
    ];
    for (const status of cancelFamily) {
      const db = fakeDb({
        cap: 191,
        orders: [fakeOrder(5, [[OUT, OUT_ISO]], { out: true, status })],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(0);
    }
  });
});

// ── assertTicketingCap ──────────────────────────────────────────────────────
describe('assertTicketingCap', () => {
  const S = 'sch1';
  const ISO = '2026-07-10T02:00:00Z';
  // 该班次作为去程、去程已开的订单，凑出 issued 人数
  const issuedOrders = (n: number): FakeOrder[] => [fakeOrder(n, [[S, ISO]], { out: true })];

  it('已开票 + 新增 ≤ 上限 → 放行（190 + 1 = 191）', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: 191, orders: issuedOrders(190) })), [S], 1),
    ).resolves.toBeUndefined();
  });

  it('已开票 + 新增 > 上限 → 抛 422，消息含已开票数与上限', async () => {
    const err = await assertTicketingCap(
      asDb(fakeDb({ cap: 191, orders: issuedOrders(191) })),
      [S],
      1,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect((err as UnprocessableEntityError).statusCode).toBe(422);
    expect((err as Error).message).toBe('该班次已开票 191 张，最多 191 张，无法继续开票');
  });

  it('多乘客订单：189 已开 + 3 人 → 超 191 拒绝', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: 191, orders: issuedOrders(189) })), [S], 3),
    ).rejects.toThrow(/已开票 189 张，最多 191 张/);
  });

  it('班次不存在 → 跳过校验不计数', async () => {
    const db = fakeDb({ cap: null, orders: [] });
    await expect(assertTicketingCap(asDb(db), ['gone'], 5)).resolves.toBeUndefined();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('重复 scheduleId 去重，只查一次', async () => {
    const db = fakeDb({ cap: 191, orders: [] });
    await assertTicketingCap(asDb(db), [S, S], 2);
    expect(db.flightSchedule.findUnique).toHaveBeenCalledTimes(1);
  });

  it('按班次自定义上限（ticketingCap=100）生效', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: 100, orders: issuedOrders(100) })), [S], 1),
    ).rejects.toThrow(/最多 100 张/);
  });
});

// ── OrderService.setInvoiceFlags ───────────────────────────────────────────
describe('OrderService.setInvoiceFlags', () => {
  const service = new OrderService();
  const OUT = 'schOut';
  const RET = 'schRet';
  const OUT_ISO = '2026-07-10T02:00:00Z';
  const RET_ISO = '2026-07-17T05:00:00Z';

  beforeEach(() => {
    vi.clearAllMocks();
    txMock.order.update.mockResolvedValue({
      id: 'ord1',
      orderNumber: 'ORD-001',
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: false,
    });
    // 默认：cap 校验时该班次无其他已开票订单
    txMock.order.findMany.mockResolvedValue([]);
    txMock.flightSchedule.findUnique.mockResolvedValue({ ticketingCap: 191 });
  });

  function stubOrder(overrides: Partial<FakeOrder> = {}) {
    txMock.order.findUnique.mockResolvedValue({
      outboundInvoiced: false,
      returnInvoiced: false,
      systemInvoiced: false,
      _count: { passengers: 2 },
      items: [
        { flightScheduleId: OUT, flightSchedule: { departureTime: new Date(OUT_ISO) } },
        { flightScheduleId: RET, flightSchedule: { departureTime: new Date(RET_ISO) } },
      ],
      ...overrides,
    });
  }

  it('订单不存在 → NotFoundError', async () => {
    txMock.order.findUnique.mockResolvedValue(null);
    await expect(service.setInvoiceFlags('missing', { outboundInvoiced: true })).rejects.toThrow(/不存在/);
    expect(txMock.order.update).not.toHaveBeenCalled();
  });

  it('去程 false→true 未超限 → 校验去程班次并更新', async () => {
    stubOrder();
    await service.setInvoiceFlags('ord1', { outboundInvoiced: true });
    expect(txMock.flightSchedule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OUT } }),
    );
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { outboundInvoiced: true } }),
    );
  });

  it('去程 false→true 超限 → 422 且不更新', async () => {
    stubOrder();
    // 该去程班次已开 190（190 + 本单 2 > 191）
    txMock.order.findMany.mockResolvedValue([fakeOrder(190, [[OUT, OUT_ISO]], { out: true })]);
    await expect(service.setInvoiceFlags('ord1', { outboundInvoiced: true })).rejects.toThrow(
      /已开票 190 张，最多 191 张/,
    );
    expect(txMock.order.update).not.toHaveBeenCalled();
  });

  it('回程 false→true → 校验回程班次（非去程班次）', async () => {
    stubOrder();
    await service.setInvoiceFlags('ord1', { returnInvoiced: true });
    expect(txMock.flightSchedule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RET } }),
    );
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { returnInvoiced: true } }),
    );
  });

  it('翻回未开（true→false）→ 不校验上限', async () => {
    stubOrder({ outboundInvoiced: true });
    await service.setInvoiceFlags('ord1', { outboundInvoiced: false });
    expect(txMock.flightSchedule.findUnique).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { outboundInvoiced: false } }),
    );
  });

  it('已是 true 再设 true → 幂等，跳过上限校验', async () => {
    stubOrder({ outboundInvoiced: true });
    await service.setInvoiceFlags('ord1', { outboundInvoiced: true });
    expect(txMock.flightSchedule.findUnique).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalled();
  });

  it('仅系统开票（systemInvoiced）→ 不占额度、不校验班次', async () => {
    stubOrder();
    await service.setInvoiceFlags('ord1', { systemInvoiced: true });
    expect(txMock.flightSchedule.findUnique).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { systemInvoiced: true } }),
    );
  });
});

// ── OrderService.batchSetInvoiceFlags（票务岗批量开票，逐单复用 setInvoiceFlags）───
describe('OrderService.batchSetInvoiceFlags', () => {
  const service = new OrderService();
  const OUT = 'schOut';
  const OUT_ISO = '2026-07-10T02:00:00Z';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function orderRow(overrides: Partial<FakeOrder> = {}): FakeOrder {
    return {
      status: OrderStatus.PAID,
      outboundInvoiced: false,
      returnInvoiced: false,
      _count: { passengers: 2 },
      items: [{ flightScheduleId: OUT, flightSchedule: { departureTime: new Date(OUT_ISO) } }],
      ...overrides,
    };
  }

  it('批量标去程已开：全部成功', async () => {
    txMock.order.findUnique.mockResolvedValueOnce(orderRow()).mockResolvedValueOnce(orderRow());
    txMock.flightSchedule.findUnique.mockResolvedValue({ ticketingCap: 191 });
    txMock.order.findMany.mockResolvedValue([]); // 该班次无其他已开票乘客，两单均放行
    txMock.order.update
      .mockResolvedValueOnce({
        id: 'ord1',
        orderNumber: 'ORD-001',
        outboundInvoiced: true,
        returnInvoiced: false,
        systemInvoiced: false,
      })
      .mockResolvedValueOnce({
        id: 'ord2',
        orderNumber: 'ORD-002',
        outboundInvoiced: true,
        returnInvoiced: false,
        systemInvoiced: false,
      });

    const result = await service.batchSetInvoiceFlags(['ord1', 'ord2'], { outboundInvoiced: true });

    expect(result).toEqual({
      succeeded: 2,
      failed: 0,
      results: [
        {
          id: 'ord1',
          orderNumber: 'ORD-001',
          ok: true,
          outboundInvoiced: true,
          returnInvoiced: false,
          systemInvoiced: false,
        },
        {
          id: 'ord2',
          orderNumber: 'ORD-002',
          ok: true,
          outboundInvoiced: true,
          returnInvoiced: false,
          systemInvoiced: false,
        },
      ],
    });
  });

  it('其中一单超班次开票上限 → 该单失败，其余成功', async () => {
    txMock.order.findUnique.mockResolvedValueOnce(orderRow()).mockResolvedValueOnce(orderRow());
    txMock.flightSchedule.findUnique.mockResolvedValue({ ticketingCap: 191 });
    // ord1：该班次已开 191（+本单 2 人 = 193 > 191）→ 超限；ord2：无占额 → 放行
    txMock.order.findMany
      .mockResolvedValueOnce([fakeOrder(191, [[OUT, OUT_ISO]], { out: true })])
      .mockResolvedValueOnce([]);
    txMock.order.update.mockResolvedValueOnce({
      id: 'ord2',
      orderNumber: 'ORD-002',
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: false,
    });

    const result = await service.batchSetInvoiceFlags(['ord1', 'ord2'], { outboundInvoiced: true });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({ id: 'ord1', ok: false });
    expect(result.results[0].error).toMatch(/已开票 191 张，最多 191 张/);
    expect(result.results[1]).toEqual({
      id: 'ord2',
      orderNumber: 'ORD-002',
      ok: true,
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: false,
    });
    // ord1 超限未被更新，只有 ord2 一次 update
    expect(txMock.order.update).toHaveBeenCalledTimes(1);
  });

  it('订单不存在（单单失败）→ 记为失败并附错误信息，不影响其余单', async () => {
    txMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(orderRow());
    txMock.flightSchedule.findUnique.mockResolvedValue({ ticketingCap: 191 });
    txMock.order.findMany.mockResolvedValue([]);
    txMock.order.update.mockResolvedValueOnce({
      id: 'ord2',
      orderNumber: 'ORD-002',
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: false,
    });

    const result = await service.batchSetInvoiceFlags(['missing', 'ord2'], {
      outboundInvoiced: true,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(/不存在/);
    expect(result.results[1].ok).toBe(true);
  });
});
