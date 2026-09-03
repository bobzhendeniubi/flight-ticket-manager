/**
 * 按航班批量 no-show · 编排层单测（mock Prisma + 假 service，不依赖真 DB）
 *
 * 这一层不碰座位也不碰钱（落库全在 markNoShow 里），所以要测的是**编排的正确性**：
 *   1. 权限：仅 ADMIN/STAFF；
 *   2. 候选池口径：只收「该班次是这单**去程**」的占座单 —— 同一班次是别单回程时绝不能进池；
 *   3. 同一张单被名单点到多人时只跑一次预检，结论分发给这单的每一行；
 *      同一位乘客被多行命中时合并成一条（原文行都留在 lines 里）；
 *   3b. releaseReturn 原样带进逐单预检；名单超上限时 totalLines / truncated 如实回；
 *   4. 对外只出证件号后 4 位；
 *   5. 执行逐单独立：一单失败不影响其它单，失败带稳定 code；
 *   6. 逐单 token 由「整批 token + 订单 id」稳定派生（整批重试才会命中逐单回放）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  executeNoShowBatch,
  previewNoShowBatch,
  type NoShowBatchService,
} from './no-show-batch.js';
import { NO_SHOW_PREVIEW_MAX_ORDERS } from './no-show-batch.js';
import {
  deriveBatchOrderToken,
  NO_SHOW_ROSTER_MAX_LINES,
} from './no-show-roster-match.js';
import { ForbiddenError, NotFoundError, AppError } from '../../lib/errors.js';
import type { NoShowPreview } from './orders.service.js';

const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT } as const;
const BATCH_TOKEN = 'b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

const OUT_DEPART = new Date(Date.now() - 3 * 24 * 3600_000);
const RET_DEPART = new Date(Date.now() + 7 * 24 * 3600_000);

/** 一张 2 人往返单：去程挂 sch-out、回程挂 sch-ret。 */
function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    orderNumber: 'FTM20260902-001',
    // 备注随行下发，给票务在单号旁边多一个可读识别标（本表所有行同一班次，没有团期可分）
    notes: '两位成人（双床）三星',
    passengers: [
      {
        id: 'p-1',
        fullName: 'CHEN/ZHIYUAN',
        chineseName: '陈志远',
        documentNumber: 'E10000001',
        lastName: 'CHEN',
        firstName: 'ZHIYUAN',
      },
      {
        id: 'p-2',
        fullName: 'LIN/XIAOMEI',
        chineseName: '林晓梅',
        documentNumber: 'E20000002',
        lastName: 'LIN',
        firstName: 'XIAOMEI',
      },
    ],
    items: [
      { id: 'leg-out', flightScheduleId: 'sch-out', flightSchedule: { departureTime: OUT_DEPART } },
      { id: 'leg-ret', flightScheduleId: 'sch-ret', flightSchedule: { departureTime: RET_DEPART } },
    ],
    ...over,
  };
}

function previewResult(over: Partial<NoShowPreview> = {}): NoShowPreview {
  return {
    eligible: true,
    blockers: [],
    warnings: [],
    scope: 'WHOLE',
    outboundItem: {
      orderItemId: 'leg-out',
      description: '去程',
      flightNumber: 'QH9589',
      departDate: '2026-09-02',
      cabin: null,
      quantity: 2,
    },
    returnItem: {
      orderItemId: 'leg-ret',
      description: '回程',
      flightNumber: 'QH9588',
      departDate: '2026-09-09',
      cabin: null,
      quantity: 2,
      ticketed: false,
    },
    passengers: [],
    alreadyNoShow: false,
    returnDeparted: false,
    isRerelease: false,
    ...over,
  };
}

function fakeService(over: Partial<NoShowBatchService> = {}): NoShowBatchService {
  return {
    previewNoShow: vi.fn(async () => previewResult()),
    markNoShow: vi.fn(async () => ({
      targetOrderId: 'ord-1',
      audit: {
        orderNumber: 'FTM20260902-001',
        outboundItemId: 'leg-out',
        returnItemId: 'leg-ret',
        releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY' as never, quantity: 2 }],
        workOrderReminderId: null,
        split: null,
        replayed: false,
      },
    })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.flightSchedule.findUnique.mockResolvedValue({
    id: 'sch-out',
    departureTime: OUT_DEPART,
    departureTz: 'Asia/Shanghai',
    checkinCloseMinutes: null, // 未配置 → 系统默认提前 45 分钟关柜
    flight: { flightNumber: 'QH9589' },
    seatClasses: [{ sold: 12 }, { sold: 3 }],
  });
  mockPrisma.order.findMany.mockResolvedValue([orderRow()]);
});

// ══════════════════════════════════════════════════════════════════════════
describe('批量 no-show · 权限', () => {
  it('代理不放行（预检）', async () => {
    await expect(
      previewNoShowBatch(
        { service: fakeService() },
        { scheduleId: 'sch-out', names: '陈志远' },
        AGENT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('代理不放行（执行）', async () => {
    await expect(
      executeNoShowBatch(
        { service: fakeService() },
        {
          requestToken: BATCH_TOKEN,
          scheduleId: 'sch-out',
          entries: [{ orderId: 'ord-1', passengerIds: ['p-1'] }],
          releaseReturn: true,
        },
        AGENT,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('批量 no-show · 预检', () => {
  it('班次不存在 → 404', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue(null);
    await expect(
      previewNoShowBatch({ service: fakeService() }, { scheduleId: 'nope', names: '陈志远' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('抬头带航班号 / 当地日期时刻 / 已关柜 / 已售座数', async () => {
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.schedule.flightNumber).toBe('QH9589');
    expect(r.schedule.departDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.schedule.departTimeLocal).toMatch(/^\d{2}:\d{2}$/);
    expect(r.schedule.departed).toBe(true);
    expect(r.schedule.seatsSold).toBe(15);
  });

  // 抬头的「能不能提交」按关柜算，与单单闸 4 同源 —— 两处若一个看起飞、一个看关柜，
  // 就会出现「抬头说不能提交、逐行却全绿」的对不上。
  it('起飞前 20 分钟（已过默认关柜点）→ 抬头判已关柜', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-out',
      departureTime: new Date(Date.now() + 20 * 60_000),
      departureTz: 'Asia/Shanghai',
      checkinCloseMinutes: null,
      flight: { flightNumber: 'QH9589' },
      seatClasses: [{ sold: 1 }],
    });
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.schedule.departed).toBe(true);
  });

  // 关柜到起飞之间那 45 分钟里，去程照样能标（抬头绿、逐行也绿），但回程座位放不了 ——
  // 逐行的 returnDeparted 就是单单预检闸 5b 的结论（现按关柜算），批量原样透出来给票务看。
  it('关柜后未起飞窗口内：去程逐行仍 eligible，回程按关柜口径回 returnDeparted=true', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-out',
      departureTime: new Date(Date.now() + 20 * 60_000),
      departureTz: 'Asia/Shanghai',
      checkinCloseMinutes: null,
      flight: { flightNumber: 'QH9589' },
      seatClasses: [{ sold: 1 }],
    });
    const service = fakeService({
      // 单单预检在这个窗口给出的结论：可标 no-show，但回程已关柜 → 座位不释放。
      previewNoShow: vi.fn(async () => previewResult({ returnDeparted: true })),
    });
    const r = await previewNoShowBatch(
      { service },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.schedule.departed).toBe(true);
    expect(r.matched[0].eligible).toBe(true);
    expect(r.matched[0].hasReturn).toBe(true);
    expect(r.matched[0].returnDeparted).toBe(true);
  });

  it('起飞前 2 小时（还没到关柜点）→ 抬头判未关柜', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-out',
      departureTime: new Date(Date.now() + 2 * 3600_000),
      departureTz: 'Asia/Shanghai',
      checkinCloseMinutes: null,
      flight: { flightNumber: 'QH9589' },
      seatClasses: [{ sold: 1 }],
    });
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.schedule.departed).toBe(false);
  });

  it('匹配行带订单备注（认人认团用；没备注则为 null）', async () => {
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.matched[0].notes).toBe('两位成人（双床）三星');

    mockPrisma.order.findMany.mockResolvedValue([orderRow({ notes: null })]);
    const r2 = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r2.matched[0].notes).toBeNull();
  });

  it('匹配上的行带准入结论；证件号只给后 4 位', async () => {
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远\n林晓梅\n某位不在名单里的人' },
      ADMIN,
    );
    expect(r.matched).toHaveLength(2);
    expect(r.matched[0]).toMatchObject({
      orderId: 'ord-1',
      orderNumber: 'FTM20260902-001',
      passengerId: 'p-1',
      documentTail: '0001',
      matchedBy: 'CHINESE_NAME',
      eligible: true,
      blockers: [],
      scope: 'WHOLE',
      hasReturn: true,
      returnTicketed: false,
      returnDeparted: false,
    });
    // 完整证件号一个字符都不许出现在响应里。
    expect(JSON.stringify(r)).not.toContain('E10000001');
    expect(r.unmatched).toEqual(['某位不在名单里的人']);
  });

  it('同一张单被点到 2 人 → 只跑一次预检，结论分发给两行', async () => {
    const service = fakeService();
    await previewNoShowBatch({ service }, { scheduleId: 'sch-out', names: '陈志远\n林晓梅' }, ADMIN);
    expect(service.previewNoShow).toHaveBeenCalledTimes(1);
    expect(service.previewNoShow).toHaveBeenCalledWith(
      'ord-1',
      { passengerIds: ['p-1', 'p-2'], releaseReturn: true },
      ADMIN,
    );
  });

  // 预检口径必须与执行口径同参：不带 releaseReturn 进去，「回程已起飞不能释放」这条闸
  // 在贴名单时是绿的、点了执行才逐单蹦红。
  it('releaseReturn 原样带进逐单预检（缺省 true）', async () => {
    const service = fakeService();
    await previewNoShowBatch(
      { service },
      { scheduleId: 'sch-out', names: '陈志远', releaseReturn: false },
      ADMIN,
    );
    expect(service.previewNoShow).toHaveBeenCalledWith(
      'ord-1',
      { passengerIds: ['p-1'], releaseReturn: false },
      ADMIN,
    );

    const withDefault = fakeService();
    await previewNoShowBatch(
      { service: withDefault },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(withDefault.previewNoShow).toHaveBeenCalledWith(
      'ord-1',
      { passengerIds: ['p-1'], releaseReturn: true },
      ADMIN,
    );
  });

  // 同一个人被名单点到两次（中文名一行、拼音 + 护照号又一行）→ 勾选列表只该出现一条，
  // 否则票务勾两次、执行时这一单会被排两遍。
  it('同一位乘客被多行命中 → 合并成一条，原文行都留在 lines 里', async () => {
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远\nCHEN/ZHIYUAN E10000001' },
      ADMIN,
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].passengerId).toBe('p-1');
    // line 保留第一条（老前端只读这个字段）；lines 是全部命中的原文行。
    expect(r.matched[0].line).toBe('陈志远');
    expect(r.matched[0].lines).toEqual(['陈志远', 'CHEN/ZHIYUAN E10000001']);
  });

  it('名单超上限 → 仍处理前若干行，但 totalLines / truncated 明说', async () => {
    const names = Array.from({ length: NO_SHOW_ROSTER_MAX_LINES + 8 }, (_, i) => `路人${i}`).join(
      '\n',
    );
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names },
      ADMIN,
    );
    expect(r.totalLines).toBe(NO_SHOW_ROSTER_MAX_LINES + 8);
    expect(r.processedLines).toBe(NO_SHOW_ROSTER_MAX_LINES);
    expect(r.truncated).toBe(true);
  });

  it('名单没超上限 → truncated=false，两个计数一致', async () => {
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远\n林晓梅' },
      ADMIN,
    );
    expect(r.totalLines).toBe(2);
    expect(r.processedLines).toBe(2);
    expect(r.truncated).toBe(false);
  });

  // 订单数上限：500 行名单可能点到几百张单，每张单一次 previewNoShow。不设限就是一个请求
  // 打穿网关超时；超出的单**不装绿**，如实回一条「本次未预检」的 blocker + truncatedOrders。
  it('点到的订单数超上限 → truncatedOrders=true，超出的单给出明说的 blocker', async () => {
    const overflow = NO_SHOW_PREVIEW_MAX_ORDERS + 3;
    // 纯中文名（不带数字）：名单行里混数字会被解析器当成证件号，匹配不上。
    const POOL = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
    const cnName = (i: number) =>
      `路${POOL[Math.floor(i / POOL.length) % POOL.length]}${POOL[i % POOL.length]}`;
    // 每张单一位乘客，姓名各不相同 → 名单一行对一单。
    mockPrisma.order.findMany.mockResolvedValue(
      Array.from({ length: overflow }, (_, i) => ({
        id: `ord-${i}`,
        orderNumber: `FTM2026090200${i}`,
        passengers: [
          {
            id: `p-${i}`,
            fullName: `PAX/NO${i}`,
            chineseName: cnName(i),
            documentNumber: `E2000${i}`,
            lastName: 'PAX',
            firstName: `NO${i}`,
          },
        ],
        items: [
          {
            id: `leg-out-${i}`,
            flightScheduleId: 'sch-out',
            flightSchedule: { departureTime: OUT_DEPART },
          },
        ],
      })),
    );
    const names = Array.from({ length: overflow }, (_, i) => cnName(i)).join('\n');
    const service = fakeService();
    const r = await previewNoShowBatch({ service }, { scheduleId: 'sch-out', names }, ADMIN);

    expect(r.totalOrders).toBe(overflow);
    expect(r.processedOrders).toBe(NO_SHOW_PREVIEW_MAX_ORDERS);
    expect(r.truncatedOrders).toBe(true);
    expect(service.previewNoShow).toHaveBeenCalledTimes(NO_SHOW_PREVIEW_MAX_ORDERS);
    const unchecked = r.matched.filter(
      (m) => !m.eligible && m.blockers.join('').includes('这一单没有预检'),
    );
    expect(unchecked).toHaveLength(3);
    expect(unchecked[0].blockers.join('')).toContain('分批贴名单');
  });

  it('订单数没超上限 → truncatedOrders=false，两个计数一致', async () => {
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远\n林晓梅' },
      ADMIN,
    );
    expect(r.totalOrders).toBe(1); // 两人同一张单
    expect(r.processedOrders).toBe(1);
    expect(r.truncatedOrders).toBe(false);
  });

  it('只勾一部分 → 预检回 SPLIT_REQUIRED，前端据此提示会先自动拆单', async () => {
    const service = fakeService({
      previewNoShow: vi.fn(async () => previewResult({ scope: 'SPLIT_REQUIRED' })),
    });
    const r = await previewNoShowBatch(
      { service },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.matched[0].scope).toBe('SPLIT_REQUIRED');
  });

  it('该班次是这单的**回程**时不进候选池（否则会放掉正等着飞的客人的座）', async () => {
    // 名单贴的是 sch-ret 这一班：这张单的 sch-ret 是回程，去程是 sch-out → 整单不该被匹配到。
    mockPrisma.flightSchedule.findUnique.mockResolvedValue({
      id: 'sch-ret',
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
      seatClasses: [{ sold: 2 }],
    });
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-ret', names: '陈志远' },
      ADMIN,
    );
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toEqual(['陈志远']);
  });

  it('单张单预检抛错只影响这一张单，整批照常返回（错因落进 blockers）', async () => {
    const service = fakeService({
      previewNoShow: vi.fn(async () => {
        throw new Error('订单不存在');
      }),
    });
    const r = await previewNoShowBatch(
      { service },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    expect(r.matched[0].eligible).toBe(false);
    expect(r.matched[0].blockers).toEqual(['订单不存在']);
  });

  it('同名两人 → 落 ambiguous，不替人做主', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      orderRow({
        id: 'ord-1',
        orderNumber: 'FTM20260902-001',
        passengers: [
          {
            id: 'p-1',
            fullName: 'WANG/WEI',
            chineseName: null,
            documentNumber: 'E30000003',
            lastName: 'WANG',
            firstName: 'WEI',
          },
        ],
      }),
      orderRow({
        id: 'ord-2',
        orderNumber: 'FTM20260902-002',
        passengers: [
          {
            id: 'p-9',
            fullName: 'WANG/WEI',
            chineseName: null,
            documentNumber: 'E40000004',
            lastName: 'WANG',
            firstName: 'WEI',
          },
        ],
      }),
    ]);
    const r = await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: 'WANG/WEI' },
      ADMIN,
    );
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].candidates.map((c) => c.orderNumber).sort()).toEqual([
      'FTM20260902-001',
      'FTM20260902-002',
    ]);
    // 候选带 orderId：前端点选后直接拼进执行体的 entries，不必再回匹配一次。
    expect(r.ambiguous[0].candidates.map((c) => c.orderId).sort()).toEqual(['ord-1', 'ord-2']);
    expect(r.ambiguous[0].candidates[0]).toMatchObject({
      orderId: expect.any(String),
      orderNumber: expect.any(String),
      passengerId: expect.any(String),
      fullName: 'WANG/WEI',
      chineseName: null,
    });
  });

  it('候选池只查占座态、非回收站的单', async () => {
    await previewNoShowBatch(
      { service: fakeService() },
      { scheduleId: 'sch-out', names: '陈志远' },
      ADMIN,
    );
    const where = mockPrisma.order.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.status.in).toEqual(expect.arrayContaining(['PAID', 'TICKETED']));
    expect(where.items.some).toEqual({ kind: OrderItemKind.FLIGHT, flightScheduleId: 'sch-out' });
  });
});

describe('批量 no-show · 执行', () => {
  const twoOrders = [orderRow(), orderRow({ id: 'ord-2', orderNumber: 'FTM20260902-002' })];

  it('逐单 token 由「整批 token + 订单 id」稳定派生', async () => {
    mockPrisma.order.findMany.mockResolvedValue(twoOrders);
    const service = fakeService();
    await executeNoShowBatch(
      { service },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: 'sch-out',
        entries: [
          { orderId: 'ord-1', passengerIds: ['p-1', 'p-2'] },
          { orderId: 'ord-2', passengerIds: ['p-1'] },
        ],
        releaseReturn: true,
        note: '航司名单',
      },
      ADMIN,
    );
    expect(service.markNoShow).toHaveBeenNthCalledWith(
      1,
      'ord-1',
      {
        requestToken: deriveBatchOrderToken(BATCH_TOKEN, 'ord-1'),
        passengerIds: ['p-1', 'p-2'],
        releaseReturn: true,
        note: '航司名单',
      },
      ADMIN,
    );
    expect(service.markNoShow).toHaveBeenNthCalledWith(
      2,
      'ord-2',
      expect.objectContaining({ requestToken: deriveBatchOrderToken(BATCH_TOKEN, 'ord-2') }),
      ADMIN,
    );
  });

  it('一单失败不影响其它单；失败带稳定 code，汇总如实', async () => {
    mockPrisma.order.findMany.mockResolvedValue(twoOrders);
    const markNoShow = vi
      .fn()
      .mockRejectedValueOnce(new AppError('拆单未成功', { statusCode: 409, code: 'SPLIT_BLOCKED' }))
      .mockResolvedValueOnce({
        targetOrderId: 'ord-2',
        audit: {
          orderNumber: 'FTM20260902-002',
          outboundItemId: 'leg-out',
          returnItemId: 'leg-ret',
          releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
          workOrderReminderId: 'rem-1',
          split: null,
          replayed: false,
        },
      });
    const r = await executeNoShowBatch(
      { service: fakeService({ markNoShow }) },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: 'sch-out',
        entries: [
          { orderId: 'ord-1', passengerIds: ['p-1'] },
          { orderId: 'ord-2', passengerIds: ['p-1', 'p-2'] },
        ],
        releaseReturn: true,
      },
      ADMIN,
    );
    expect(r.results[0]).toMatchObject({
      orderId: 'ord-1',
      orderNumber: 'FTM20260902-001',
      ok: false,
      code: 'SPLIT_BLOCKED',
      error: '拆单未成功',
    });
    expect(r.results[1]).toMatchObject({
      orderId: 'ord-2',
      ok: true,
      releasedSeats: 2,
      workOrderReminderId: 'rem-1',
    });
    expect(r.summary).toEqual({ ok: 1, failed: 1, releasedSeats: 2, replayedCount: 0 });
  });

  // 整批重试时前几单必然命中逐单回放：库里一个字段都没动、座位没有二次释放。
  // 不标出来的话，前端会把「一座没放」的单显示成「本次释放了 N 座」，票务拿这个数跟航司对不上。
  it('回放的单标 replayed，且不计进 summary.releasedSeats', async () => {
    mockPrisma.order.findMany.mockResolvedValue(twoOrders);
    const markNoShow = vi
      .fn()
      .mockResolvedValueOnce({
        targetOrderId: 'ord-1',
        audit: {
          orderNumber: 'FTM20260902-001',
          outboundItemId: 'leg-out',
          returnItemId: 'leg-ret',
          releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 2 }],
          workOrderReminderId: null,
          split: null,
          replayed: true,
        },
      })
      .mockResolvedValueOnce({
        targetOrderId: 'ord-2',
        audit: {
          orderNumber: 'FTM20260902-002',
          outboundItemId: 'leg-out',
          returnItemId: 'leg-ret',
          releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY', quantity: 3 }],
          workOrderReminderId: null,
          split: null,
          replayed: false,
        },
      });
    const r = await executeNoShowBatch(
      { service: fakeService({ markNoShow }) },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: 'sch-out',
        entries: [
          { orderId: 'ord-1', passengerIds: ['p-1'] },
          { orderId: 'ord-2', passengerIds: ['p-1'] },
        ],
        releaseReturn: true,
      },
      ADMIN,
    );
    expect(r.results[0]).toMatchObject({ replayed: true, targetOrderId: 'ord-1' });
    expect(r.results[1]).toMatchObject({ replayed: false, targetOrderId: 'ord-2' });
    // 只累加真正放回库存的那 3 座。
    expect(r.summary).toEqual({ ok: 2, failed: 0, releasedSeats: 3, replayedCount: 1 });
  });

  it('拆单时回目标新单号（票务据此知道去哪张单看结果）', async () => {
    const markNoShow = vi.fn(async () => ({
      targetOrderId: 'ord-new',
      audit: {
        orderNumber: 'FTM20260902-001-S1',
        outboundItemId: 'leg-out',
        returnItemId: 'leg-ret',
        releasedSeats: [{ scheduleId: 'sch-ret', cabin: 'ECONOMY' as never, quantity: 1 }],
        workOrderReminderId: null,
        split: {
          sourceOrderNumber: 'FTM20260902-001',
          targetOrderNumber: 'FTM20260902-001-S1',
        },
        replayed: false,
      },
    }));
    const r = await executeNoShowBatch(
      { service: fakeService({ markNoShow }) },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: 'sch-out',
        entries: [{ orderId: 'ord-1', passengerIds: ['p-1'] }],
        releaseReturn: true,
      },
      ADMIN,
    );
    expect(r.results[0].targetOrderNumber).toBe('FTM20260902-001-S1');
  });

  it('订单不存在 → 本单 ORDER_NOT_FOUND，绝不去调 markNoShow', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    const service = fakeService();
    const r = await executeNoShowBatch(
      { service },
      {
        requestToken: BATCH_TOKEN,
        scheduleId: 'sch-out',
        entries: [{ orderId: 'ord-gone', passengerIds: ['p-1'] }],
        releaseReturn: true,
      },
      ADMIN,
    );
    expect(r.results[0]).toMatchObject({ ok: false, code: 'ORDER_NOT_FOUND' });
    expect(service.markNoShow).not.toHaveBeenCalled();
  });

  it('该单去程不在本班次 → SCHEDULE_MISMATCH，绝不动它的座位', async () => {
    const service = fakeService();
    const r = await executeNoShowBatch(
      { service },
      {
        requestToken: BATCH_TOKEN,
        // 名单贴的是回程那一班：这单的去程是 sch-out，不该被这一批处理。
        scheduleId: 'sch-ret',
        entries: [{ orderId: 'ord-1', passengerIds: ['p-1'] }],
        releaseReturn: true,
      },
      ADMIN,
    );
    expect(r.results[0]).toMatchObject({ ok: false, code: 'SCHEDULE_MISMATCH' });
    expect(service.markNoShow).not.toHaveBeenCalled();
    expect(r.summary).toEqual({ ok: 0, failed: 1, releasedSeats: 0, replayedCount: 0 });
  });
});
