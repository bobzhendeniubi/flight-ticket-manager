/**
 * 班次开票上限（= 座位库存）· 按航段口径 · 单元测试
 *
 * 覆盖：
 *   1. determineFlightLegs：去程/回程按 departureTime 升序判定；单程/多段/缺字段
 *   2. getScheduleSeatCapacity：上限 = Σ 舱位 capacity（商务 + 经济）；未配舱位/班次已删 → null
 *   3. countIssuedPassengers：某班次已开票**座位数**按「该班次是订单去程 ? outboundInvoiced : returnInvoiced」计，
 *      且订单状态需在 COUNTED_STATUSES 内——取消族订单（如已开票后转 CANCELLED）不再占额度；
 *      **婴儿不占座不计**；**同证件号跨单只计 1 个座**（空证件号按 id 兜底不塌）
 *   4. assertTicketingCap：未超限放行 / 恰好到上限放行 / 超限抛 422 / 班次无舱位跳过 / scheduleId 去重
 *   5. OrderService.setInvoiceFlags：翻某航段为已开时校验对应班次上限；翻回未开/系统开不校验；订单不存在 404
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, PassengerType } from '@prisma/client';
import {
  assertTicketingCap,
  countIssuedPassengers,
  determineFlightLegs,
  determineFlightLegItems,
  getScheduleSeatCapacity,
} from './ticketing-cap.js';
import { UnprocessableEntityError } from '../../lib/errors.js';

// ── setInvoiceFlags 需要 mock prisma（vi.mock 会 hoist，变量也要 hoist）──
const { txMock, mockPrisma } = vi.hoisted(() => {
  const txMock = {
    order: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    flightSeatClass: { findMany: vi.fn() },
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
interface FakePax {
  id: string;
  documentNumber: string | null;
  passengerType: PassengerType;
}
interface FakeOrder {
  status: OrderStatus;
  outboundInvoiced: boolean;
  returnInvoiced: boolean;
  passengers: FakePax[];
  items: Array<{ flightScheduleId: string; flightSchedule: { departureTime: Date } }>;
}

// 造 n 位互不相同的成人（各自唯一证件号）——默认用例只想表达「n 个座」，
// 不希望被去重逻辑意外合并。序号全局自增，跨订单也不会撞号。
let paxSeq = 0;
function adults(n: number): FakePax[] {
  return Array.from({ length: n }, () => {
    paxSeq += 1;
    return {
      id: `p${paxSeq}`,
      documentNumber: `DOC${paxSeq}`,
      passengerType: PassengerType.ADULT,
    };
  });
}
/** 指定证件号/类型的乘客（去重与婴儿口径用例用）。 */
function pax(documentNumber: string | null, passengerType = PassengerType.ADULT): FakePax {
  paxSeq += 1;
  return { id: `p${paxSeq}`, documentNumber, passengerType };
}

/** 第 1 参：数字 = n 位互不相同的成人；数组 = 精确指定的乘客名单。 */
function fakeOrder(
  pax: number | FakePax[],
  legs: Leg[],
  flags: { out?: boolean; ret?: boolean; status?: OrderStatus } = {},
): FakeOrder {
  return {
    status: flags.status ?? OrderStatus.PAID, // 未指定时默认落在 COUNTED_STATUSES 内，保持既有用例行为
    outboundInvoiced: flags.out ?? false,
    returnInvoiced: flags.ret ?? false,
    passengers: typeof pax === 'number' ? adults(pax) : pax,
    items: legs.map(([sid, iso]) => ({
      flightScheduleId: sid,
      flightSchedule: { departureTime: new Date(iso) },
    })),
  };
}

// assertTicketingCap / countIssuedPassengers 用的轻量 fake db（无需 vi.mock，直接传参）
// cap: number = 单舱位班次；number[] = 各舱位容量（上限取和）；null = 班次已删/未配舱位
// order.findMany 会按传入的 where.status.in 实际过滤 opts.orders —— 用来验证
// countIssuedPassengers 真的把 status 过滤条件下推给了查询，而不是查回全部订单再各自判定。
function fakeDb(opts: { cap: number | number[] | null; orders: FakeOrder[] }) {
  const seatRows =
    opts.cap === null
      ? []
      : (Array.isArray(opts.cap) ? opts.cap : [opts.cap]).map((capacity) => ({ capacity }));
  return {
    flightSeatClass: { findMany: vi.fn().mockResolvedValue(seatRows) },
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

// ── 迁移：删掉 191 那一列（上限改为派生自座位库存）──────────────────────────
describe('migration 20260715170000_drop_flight_schedule_ticketing_cap', () => {
  const sql = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../prisma/migrations/20260715170000_drop_flight_schedule_ticketing_cap/migration.sql',
    ),
    'utf8',
  );

  it('删除 FlightSchedule.ticketingCap 列', () => {
    expect(sql.replace(/\s+/g, ' ')).toMatch(
      /ALTER TABLE "FlightSchedule" DROP COLUMN "ticketingCap"/,
    );
  });

  it('纯删列：不迁移数据、不新建列（上限从 FlightSeatClass.capacity 现算）', () => {
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/UPDATE "FlightSchedule"/i);
  });
});

// ── determineFlightLegs ────────────────────────────────────────────────────
describe('determineFlightLegs', () => {
  it('航段行定位与 scheduleId 解耦：同 scheduleId 仍按 departureTime 返回第 2 条回程行', () => {
    const outbound = {
      id: 'outbound-item',
      flightScheduleId: 'same-schedule',
      flightSchedule: { departureTime: new Date('2026-07-10T02:00:00Z') },
    };
    const returned = {
      id: 'return-item',
      flightScheduleId: 'same-schedule',
      flightSchedule: { departureTime: new Date('2026-07-17T05:00:00Z') },
    };

    expect(determineFlightLegItems([returned, outbound])).toEqual({
      outbound,
      return: returned,
    });
    expect(determineFlightLegs([returned, outbound])).toEqual({
      outboundScheduleId: 'same-schedule',
      returnScheduleId: 'same-schedule',
    });
  });

  it('起飞时间相同：无论正序还是反序输入，都按订单行 id 选择同一条', () => {
    const sameTime = '2026-07-10T02:00:00Z';
    const first = {
      id: 'item-a',
      flightScheduleId: 'schedule-a',
      flightSchedule: { departureTime: new Date(sameTime) },
    };
    const second = {
      id: 'item-b',
      flightScheduleId: 'schedule-b',
      flightSchedule: { departureTime: new Date(sameTime) },
    };

    expect(determineFlightLegItems([second, first])).toEqual({ outbound: first, return: second });
    expect(determineFlightLegItems([first, second])).toEqual({ outbound: first, return: second });
  });

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

  // ── 口径：数的是「座」不是「人」──────────────────────────────────────────
  describe('婴儿有票无座 → 不占库存不计', () => {
    it('2 成人 + 1 婴儿 → 计 2 个座', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder(
            [pax('E001'), pax('E002'), pax('E003', PassengerType.INFANT)],
            [[OUT, OUT_ISO]],
            { out: true },
          ),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(2);
    });

    it('儿童占座 → 照常计（只有婴儿不占）', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax('E001'), pax('E002', PassengerType.CHILD)], [[OUT, OUT_ISO]], {
            out: true,
          }),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(2);
    });

    it('整单全是婴儿 → 计 0 个座', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder(
            [pax('E001', PassengerType.INFANT), pax('E002', PassengerType.INFANT)],
            [[OUT, OUT_ISO]],
            { out: true },
          ),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(0);
    });
  });

  describe('一人两单 = 1 个座 → 按 documentNumber 去重', () => {
    it('同一证件号出现在本班次的两张已开票单上 → 只计 1 个座', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax('E12345')], [[OUT, OUT_ISO]], { out: true }),
          fakeOrder([pax('E12345')], [[OUT, OUT_ISO]], { out: true }),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(1);
    });

    it('同单内重复证件号 → 也只计 1 个座', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [fakeOrder([pax('E12345'), pax('E12345')], [[OUT, OUT_ISO]], { out: true })],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(1);
    });

    it('证件号大小写/空格不一致 → 视为同一人，仍计 1 个座', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax('e12345')], [[OUT, OUT_ISO]], { out: true }),
          fakeOrder([pax('  E12345 ')], [[OUT, OUT_ISO]], { out: true }),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(1);
    });

    it('不同证件号 → 各计各的，不误合并', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax('E11111')], [[OUT, OUT_ISO]], { out: true }),
          fakeOrder([pax('E22222')], [[OUT, OUT_ISO]], { out: true }),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(2);
    });

    // 脏数据兜底：空证件号不参与去重，否则 N 个没填证件号的人会被塌成 1 个座（把上限算松 → 放出超卖）
    it('多位乘客证件号为空 / 纯空白 → 按 id 各计各的，不塌成一个', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax(''), pax('   '), pax(null)], [[OUT, OUT_ISO]], { out: true }),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(3);
    });

    it('空证件号婴儿仍不计（婴儿口径先于 id 兜底）', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax(''), pax('', PassengerType.INFANT)], [[OUT, OUT_ISO]], { out: true }),
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(1);
    });

    it('去重只在「已开票」的单之间发生：未开票单里的同一人不影响计数', async () => {
      const db = fakeDb({
        cap: 191,
        orders: [
          fakeOrder([pax('E12345')], [[OUT, OUT_ISO]], { out: true }),
          fakeOrder([pax('E99999')], [[OUT, OUT_ISO]], { out: false }), // 去程未开 → 整单不计
        ],
      });
      await expect(countIssuedPassengers(asDb(db), OUT)).resolves.toBe(1);
    });
  });
});

// ── assertTicketingCap ──────────────────────────────────────────────────────
describe('assertTicketingCap', () => {
  const S = 'sch1';
  const ISO = '2026-07-10T02:00:00Z';
  // 该班次作为去程、去程已开的订单，凑出 issued 人数
  const issuedOrders = (n: number): FakeOrder[] => [fakeOrder(n, [[S, ISO]], { out: true })];

  it('已开票 + 新增 < 座位库存 → 放行（100 + 2 < 190）', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: [12, 178], orders: issuedOrders(100) })), [S], 2),
    ).resolves.toBeUndefined();
  });

  it('恰好坐满座位库存 → 放行（189 + 1 = 190）', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: [12, 178], orders: issuedOrders(189) })), [S], 1),
    ).resolves.toBeUndefined();
  });

  it('已开票 + 新增 > 座位库存 → 抛 422，消息含已开票数与库存数', async () => {
    const err = await assertTicketingCap(
      asDb(fakeDb({ cap: [12, 178], orders: issuedOrders(190) })),
      [S],
      1,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect((err as UnprocessableEntityError).statusCode).toBe(422);
    expect((err as Error).message).toBe(
      '该班次已开票 190 张，座位库存共 190 张（各舱位容量之和），无法继续开票。如需放宽，请先调整该班次的舱位容量。',
    );
  });

  it('422 详情带 seatCapacity（派生上限），不再有 ticketingCap 字段', async () => {
    const err = (await assertTicketingCap(
      asDb(fakeDb({ cap: [12, 178], orders: issuedOrders(190) })),
      [S],
      1,
    ).catch((e: unknown) => e)) as UnprocessableEntityError & {
      details?: Record<string, unknown>;
    };
    const detail = (err.details ?? {}) as Record<string, unknown>;
    expect(detail).toMatchObject({ scheduleId: S, issued: 190, seatCapacity: 190, requested: 1 });
    expect(detail).not.toHaveProperty('ticketingCap');
  });

  it('多乘客订单：188 已开 + 3 人 → 超 190 拒绝', async () => {
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: [12, 178], orders: issuedOrders(188) })), [S], 3),
    ).rejects.toThrow(/已开票 188 张，座位库存共 190 张/);
  });

  it('上限随舱位容量走：改大商务舱容量 → 上限跟着变大（无第二本账）', async () => {
    // 同样 190 已开票：库存 190 → 拒；把商务舱从 12 加到 30（库存 208）→ 放行
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: [12, 178], orders: issuedOrders(190) })), [S], 1),
    ).rejects.toThrow(/无法继续开票/);
    await expect(
      assertTicketingCap(asDb(fakeDb({ cap: [30, 178], orders: issuedOrders(190) })), [S], 1),
    ).resolves.toBeUndefined();
  });

  it('班次已删 / 未配舱位 → 跳过校验不计数', async () => {
    const db = fakeDb({ cap: null, orders: [] });
    await expect(assertTicketingCap(asDb(db), ['gone'], 5)).resolves.toBeUndefined();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it('重复 scheduleId 去重，只查一次', async () => {
    const db = fakeDb({ cap: 191, orders: [] });
    await assertTicketingCap(asDb(db), [S, S], 2);
    expect(db.flightSeatClass.findMany).toHaveBeenCalledTimes(1);
  });
});

// ── getScheduleSeatCapacity（上限即库存）─────────────────────────────────────
describe('getScheduleSeatCapacity', () => {
  const S = 'sch1';

  it('上限 = Σ 各舱位 capacity（商务 12 + 经济 178 = 190）', async () => {
    await expect(getScheduleSeatCapacity(asDb(fakeDb({ cap: [12, 178], orders: [] })), S)).resolves.toBe(190);
  });

  it('单舱位班次：上限 = 该舱容量', async () => {
    await expect(getScheduleSeatCapacity(asDb(fakeDb({ cap: 150, orders: [] })), S)).resolves.toBe(150);
  });

  it('班次已删 / 一个舱位都没配 → null（无上限可校验，不是 0）', async () => {
    // 返回 0 会把上限算成 0 从而卡死全部开票；退化态宁可跳过不卡
    await expect(getScheduleSeatCapacity(asDb(fakeDb({ cap: null, orders: [] })), S)).resolves.toBeNull();
  });

  it('上限只按 scheduleId 取本班次舱位', async () => {
    const db = fakeDb({ cap: [12, 178], orders: [] });
    await getScheduleSeatCapacity(asDb(db), S);
    expect(db.flightSeatClass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scheduleId: S } }),
    );
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
    txMock.flightSeatClass.findMany.mockResolvedValue([{ capacity: 12 }, { capacity: 178 }]);
  });

  function stubOrder(
    overrides: Partial<FakeOrder> & { deletedAt?: Date | null; systemInvoiced?: boolean } = {},
  ) {
    txMock.order.findUnique.mockResolvedValue({
      orderNumber: 'ORD-001',
      // 默认落在 COUNTED_STATUSES 内且未软删 → 通过开票状态闸，保持既有用例行为
      status: OrderStatus.PAID,
      deletedAt: null,
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
    expect(txMock.flightSeatClass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scheduleId: OUT } }),
    );
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { outboundInvoiced: true } }),
    );
  });

  it('去程 false→true 超限 → 422 且不更新', async () => {
    stubOrder();
    // 该去程班次已开 190 = 座位库存（12 商务 + 178 经济），再加本单 2 人 → 超限
    txMock.order.findMany.mockResolvedValue([fakeOrder(190, [[OUT, OUT_ISO]], { out: true })]);
    await expect(service.setInvoiceFlags('ord1', { outboundInvoiced: true })).rejects.toThrow(
      /已开票 190 张，座位库存共 190 张/,
    );
    expect(txMock.order.update).not.toHaveBeenCalled();
  });

  it('回程 false→true → 校验回程班次（非去程班次）', async () => {
    stubOrder();
    await service.setInvoiceFlags('ord1', { returnInvoiced: true });
    expect(txMock.flightSeatClass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scheduleId: RET } }),
    );
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { returnInvoiced: true } }),
    );
  });

  it('翻回未开（true→false）→ 不校验上限', async () => {
    stubOrder({ outboundInvoiced: true });
    await service.setInvoiceFlags('ord1', { outboundInvoiced: false });
    expect(txMock.flightSeatClass.findMany).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { outboundInvoiced: false } }),
    );
  });

  it('已是 true 再设 true → 幂等，跳过上限校验', async () => {
    stubOrder({ outboundInvoiced: true });
    await service.setInvoiceFlags('ord1', { outboundInvoiced: true });
    expect(txMock.flightSeatClass.findMany).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalled();
  });

  it('仅系统开票（systemInvoiced）→ 不占额度、不校验班次', async () => {
    stubOrder();
    await service.setInvoiceFlags('ord1', { systemInvoiced: true });
    expect(txMock.flightSeatClass.findMany).not.toHaveBeenCalled();
    expect(txMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { systemInvoiced: true } }),
    );
  });

  // ── 开票标记状态闸（口径：「能标开票」⟺「占额度」，复用 COUNTED_STATUSES）────────
  describe('订单状态闸：取消族/软删单不许标开票', () => {
    // COUNTED_STATUSES 的补集——这几个状态都不占班次额度，因此也不该能标开票
    const BLOCKED: Array<[OrderStatus, string]> = [
      [OrderStatus.CANCELLED, '已取消'],
      [OrderStatus.REFUNDED, '已退款'],
      [OrderStatus.PAYMENT_TIMEOUT, '支付超时'],
      [OrderStatus.DRAFT, '草稿'],
      [OrderStatus.FAILED, '出票失败'],
    ];

    for (const [status, label] of BLOCKED) {
      it(`${label}单标去程已开 → 拒绝且不更新、不校验班次`, async () => {
        stubOrder({ status });
        await expect(service.setInvoiceFlags('ord1', { outboundInvoiced: true })).rejects.toThrow(
          new RegExp(`ORD-001 当前状态为「${label}」，不能标记开票`),
        );
        expect(txMock.order.update).not.toHaveBeenCalled();
        // 状态闸先于班次上限校验：死单直接拒，不必再去查班次额度
        expect(txMock.flightSeatClass.findMany).not.toHaveBeenCalled();
      });
    }

    it('已取消单标回程已开 → 同样拒绝', async () => {
      stubOrder({ status: OrderStatus.CANCELLED });
      await expect(service.setInvoiceFlags('ord1', { returnInvoiced: true })).rejects.toThrow(
        /不能标记开票/,
      );
      expect(txMock.order.update).not.toHaveBeenCalled();
    });

    it('已取消单标系统已开 → 同样拒绝（三个位都过状态闸）', async () => {
      stubOrder({ status: OrderStatus.CANCELLED });
      await expect(service.setInvoiceFlags('ord1', { systemInvoiced: true })).rejects.toThrow(
        /不能标记开票/,
      );
      expect(txMock.order.update).not.toHaveBeenCalled();
    });

    it('软删单（在回收站）标开票 → 拒绝并提示先恢复订单', async () => {
      stubOrder({ deletedAt: new Date('2026-07-01T00:00:00Z') });
      await expect(service.setInvoiceFlags('ord1', { outboundInvoiced: true })).rejects.toThrow(
        /ORD-001 已在回收站，不能标记开票/,
      );
      expect(txMock.order.update).not.toHaveBeenCalled();
    });

    // 只挡「翻成已开」——死单纠错撤销错标记必须放行（与资金闸「只挡进钱不挡退钱」同构）
    it('已取消单翻回未开（true→false）→ 放行（纠错撤销错标记）', async () => {
      stubOrder({ status: OrderStatus.CANCELLED, outboundInvoiced: true });
      await service.setInvoiceFlags('ord1', { outboundInvoiced: false });
      expect(txMock.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { outboundInvoiced: false } }),
      );
    });

    it('软删单翻回未开 → 同样放行', async () => {
      stubOrder({ deletedAt: new Date('2026-07-01T00:00:00Z'), outboundInvoiced: true });
      await service.setInvoiceFlags('ord1', { outboundInvoiced: false });
      expect(txMock.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { outboundInvoiced: false } }),
      );
    });

    it('已取消单「已是 true 再设 true」→ 无变化不触发闸（幂等放行）', async () => {
      stubOrder({ status: OrderStatus.CANCELLED, outboundInvoiced: true });
      await service.setInvoiceFlags('ord1', { outboundInvoiced: true });
      expect(txMock.order.update).toHaveBeenCalled();
    });

    it('有效状态（处理中）标开票 → 放行', async () => {
      stubOrder({ status: OrderStatus.PROCESSING });
      await service.setInvoiceFlags('ord1', { outboundInvoiced: true });
      expect(txMock.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { outboundInvoiced: true } }),
      );
    });
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
    txMock.flightSeatClass.findMany.mockResolvedValue([{ capacity: 12 }, { capacity: 178 }]);
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
    txMock.flightSeatClass.findMany.mockResolvedValue([{ capacity: 12 }, { capacity: 178 }]);
    // ord1：该班次已开 191 > 座位库存 190 → 超限；ord2：无占额 → 放行
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
    expect(result.results[0].error).toMatch(/已开票 191 张，座位库存共 190 张/);
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

  // 批量入口逐单复用 setInvoiceFlags → 自动继承开票状态闸；死单单独报错，不整批回滚。
  it('批量含已取消单 → 该单单独失败（状态闸），其余单照常成功', async () => {
    txMock.order.findUnique
      .mockResolvedValueOnce(orderRow({ status: OrderStatus.CANCELLED }))
      .mockResolvedValueOnce(orderRow());
    txMock.flightSeatClass.findMany.mockResolvedValue([{ capacity: 12 }, { capacity: 178 }]);
    txMock.order.findMany.mockResolvedValue([]);
    txMock.order.update.mockResolvedValueOnce({
      id: 'ord2',
      orderNumber: 'ORD-002',
      outboundInvoiced: true,
      returnInvoiced: false,
      systemInvoiced: false,
    });

    const result = await service.batchSetInvoiceFlags(['ord1', 'ord2'], {
      outboundInvoiced: true,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(/不能标记开票/);
    expect(result.results[1].ok).toBe(true);
    // 已取消单未被更新，只有有效单那一次 update
    expect(txMock.order.update).toHaveBeenCalledTimes(1);
  });

  it('订单不存在（单单失败）→ 记为失败并附错误信息，不影响其余单', async () => {
    txMock.order.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(orderRow());
    txMock.flightSeatClass.findMany.mockResolvedValue([{ capacity: 12 }, { capacity: 178 }]);
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
