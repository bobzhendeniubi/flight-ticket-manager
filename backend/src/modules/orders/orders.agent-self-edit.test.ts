/**
 * 代理自助改单（下单当天）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 口径：代理录单出错的比例高、改起来又急，运营本来就会拿群里的信息把每张代理单核对 2–3 遍，
 * 所以**下单当天**（北京业务日）代理可以自己改自家的单；**次日起**一律走改单申请审批。
 * 自助口子只开给「不动钱」的四件事：航班班次纠错 / 订单级签证状态 / 换酒店 / 升舱。
 *
 * 本文件覆盖：
 *   1. computeAgentSelfEditWindow 纯函数（含北京业务日边界 15:59Z vs 16:01Z 同一个 UTC 日）
 *   2. assertAgentSelfEditAllowed（运营直通 / 客户 403 / 代理越权 403 / 过期 403）
 *   3. correctFlightSchedule（纠错参数固定：差价 0 + correction 通道；运营路径不受窗口约束）
 *   4. rescheduleOrderItem 的运营闸没被削弱（代理直接调仍 403）
 *   5. swapItemHotel 自助通道差价强制归 0（运营填多少还是多少）
 *   6. upgradeOrderItemCabin 的窗口闸（升舱差价本就服务端算，代理动不了钱）
 *   7. setOrderVisaStatus（矛盾组合硬闸 / 只在真变了时同步签证任务）
 *
 * 路由层（HAS_VISA 403、纠错端点鉴权、审计留痕）见 orders.agent-self-edit.routes.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, Prisma, UserRole, VisaRequirement } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    $transaction: vi.fn(),
    // 代理归属判定（getDescendantAgentIds 的递归 CTE）与事务内的 Order 行锁共用。
    $queryRaw: vi.fn(),
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), update: vi.fn() },
    hotelRoomType: { findUnique: vi.fn() },
    // 换酒店的套餐档次 ↔ 酒店星级闸要按 bundleId 读套餐的 settlementTier。
    bundle: { findUnique: vi.fn() },
    passenger: { findMany: vi.fn() },
    visa: { findMany: vi.fn() },
  },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  computeAgentSelfEditWindow,
  AGENT_SELF_EDIT_REASON,
  OrderService,
} from './orders.service.js';
import { VISA_CONTRADICTION_MESSAGE } from './visa-need.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 各角色 actor（代理带 agentId —— 归属判定要用）。 */
const ADMIN = { userId: 'u-admin', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'u-staff', role: UserRole.STAFF } as const;
const CUSTOMER = { userId: 'u-cust', role: UserRole.CUSTOMER } as const;
const AGENT = { userId: 'u-agent', role: UserRole.AGENT, agentId: 'ag-1' } as const;

/** 一张「今天下的、还没出票」的代理单（时间取真实此刻，不受运行日影响）。 */
const openOrderRow = (over: Record<string, unknown> = {}) => ({
  userId: null,
  agentId: 'ag-1',
  createdAt: new Date(),
  status: OrderStatus.PAID,
  deletedAt: null,
  outboundInvoiced: false,
  returnInvoiced: false,
  systemInvoiced: false,
  settlementLocked: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：代理树里只有自己（归属判定放行 ag-1 的单）。
  mockPrisma.$queryRaw.mockResolvedValue([{ id: 'ag-1' }]);
});

// ── 1. 纯函数：窗口口径 ──────────────────────────────────────────────────
describe('computeAgentSelfEditWindow', () => {
  it('当天下的占座单 → open，until = 当天北京 24:00', () => {
    // 2026-09-04T02:00Z = 北京 9/4 10:00 → 业务日 9/4，当日结束 = 2026-09-04T16:00Z
    const w = computeAgentSelfEditWindow(
      { createdAt: new Date('2026-09-04T02:00:00.000Z'), status: OrderStatus.PAID },
      new Date('2026-09-04T06:00:00.000Z'),
    );
    expect(w).toEqual({ open: true, until: '2026-09-04T16:00:00.000Z', reason: null });
  });

  it('北京业务日边界：同一个 UTC 日的 15:59Z 与 16:01Z 分属前后两个业务日', () => {
    // now = 2026-09-04T16:30Z → 北京 9/5 00:30，业务日 = 9/5
    const now = new Date('2026-09-04T16:30:00.000Z');

    // 15:59Z = 北京 9/4 23:59 —— 昨天的单，窗口已关，until 为 null
    const yesterday = computeAgentSelfEditWindow(
      { createdAt: new Date('2026-09-04T15:59:00.000Z'), status: OrderStatus.PAID },
      now,
    );
    expect(yesterday).toEqual({
      open: false,
      until: null,
      reason: AGENT_SELF_EDIT_REASON.NEXT_DAY,
    });

    // 16:01Z = 北京 9/5 00:01 —— 今天的单，窗口开着，until = 9/5 北京 24:00
    const today = computeAgentSelfEditWindow(
      { createdAt: new Date('2026-09-04T16:01:00.000Z'), status: OrderStatus.PAID },
      now,
    );
    expect(today).toEqual({ open: true, until: '2026-09-05T16:00:00.000Z', reason: null });
  });

  it('次日起关闭，理由指向改单申请', () => {
    const w = computeAgentSelfEditWindow(
      { createdAt: new Date('2026-09-01T02:00:00.000Z'), status: OrderStatus.PAID },
      new Date('2026-09-04T02:00:00.000Z'),
    );
    expect(w.open).toBe(false);
    expect(w.until).toBeNull();
    expect(w.reason).toBe('下单当天可自助修改，次日起请提交改单申请');
  });

  it.each([OrderStatus.TICKETED, OrderStatus.COMPLETED])(
    '%s（当天单）→ 关闭且理由是「已出票」，until 仍给出（界面说明为什么改不了）',
    (status) => {
      const w = computeAgentSelfEditWindow(
        { createdAt: new Date('2026-09-04T02:00:00.000Z'), status },
        new Date('2026-09-04T06:00:00.000Z'),
      );
      expect(w.open).toBe(false);
      expect(w.reason).toBe('已出票，请提交改单申请');
      expect(w.until).toBe('2026-09-04T16:00:00.000Z');
    },
  );

  it('取消族状态 → 理由带状态中文名', () => {
    const w = computeAgentSelfEditWindow(
      { createdAt: new Date('2026-09-04T02:00:00.000Z'), status: OrderStatus.CANCELLED },
      new Date('2026-09-04T06:00:00.000Z'),
    );
    expect(w.open).toBe(false);
    expect(w.reason).toBe('订单「已取消」不可自助修改');
  });

  it.each([
    ['去程已开票', { outboundInvoiced: true }, '已开票，请提交改单申请'],
    ['回程已开票', { returnInvoiced: true }, '已开票，请提交改单申请'],
    ['系统已开票', { systemInvoiced: true }, '已开票，请提交改单申请'],
    ['结算价已锁', { settlementLocked: true }, '结算价已锁定'],
    ['在回收站', { deletedAt: new Date('2026-09-04T03:00:00.000Z') }, '订单已在回收站，请联系运营'],
  ])('%s → 当天也关闭', (_label, over, reason) => {
    const w = computeAgentSelfEditWindow(
      {
        createdAt: new Date('2026-09-04T02:00:00.000Z'),
        status: OrderStatus.PAID,
        ...(over as Record<string, unknown>),
      },
      new Date('2026-09-04T06:00:00.000Z'),
    );
    expect(w.open).toBe(false);
    expect(w.reason).toBe(reason);
  });
});

// ── 2. 服务闸：assertAgentSelfEditAllowed ────────────────────────────────
describe('assertAgentSelfEditAllowed', () => {
  it.each([ADMIN, STAFF])('运营/管理员直通，不查库（role=$role）', async (actor) => {
    await expect(service.assertAgentSelfEditAllowed('o1', actor)).resolves.toBeUndefined();
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('客户没有自助通道 → 403，不查库', async () => {
    const err = await service.assertAgentSelfEditAllowed('o1', CUSTOMER).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe('仅运营 / 代理可自助改单');
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('订单不存在 → 404', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(service.assertAgentSelfEditAllowed('o1', AGENT)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('代理动别人家的单 → 403（归属闸先于窗口闸）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow({ agentId: 'ag-other' }));
    const err = await service.assertAgentSelfEditAllowed('o1', AGENT).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe('无权查看该订单');
  });

  it('代理自家单、下单当天 → 放行', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow());
    await expect(service.assertAgentSelfEditAllowed('o1', AGENT)).resolves.toBeUndefined();
  });

  it('代理自家单、次日 → 403 且报错文案 = 窗口 reason', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      openOrderRow({ createdAt: new Date(Date.now() - 3 * DAY_MS) }),
    );
    const err = await service.assertAgentSelfEditAllowed('o1', AGENT).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(AGENT_SELF_EDIT_REASON.NEXT_DAY);
  });

  it('代理自家单、当天但已出票 → 403「已出票」', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow({ status: OrderStatus.TICKETED }));
    const err = await service.assertAgentSelfEditAllowed('o1', AGENT).catch((e: Error) => e);
    expect((err as Error).message).toBe(AGENT_SELF_EDIT_REASON.TICKETED);
  });
});

// ── 3. 航班纠错 ──────────────────────────────────────────────────────────
describe('correctFlightSchedule', () => {
  /** 纠错本体（座位搬移）已由 rescheduleOrderItem 的既有用例覆盖，这里只验入参与闸。 */
  function stubReschedule() {
    return vi
      .spyOn(service, 'rescheduleOrderItem')
      .mockResolvedValue({ order: { id: 'o1' }, audit: {} } as never);
  }

  it('代理当天自家单 → 走 correction 通道，差价恒 0、不允许已出票', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow());
    const spy = stubReschedule();
    await service.correctFlightSchedule('o1', 'item-1', 'sched-new', AGENT);
    expect(spy).toHaveBeenCalledWith(
      'o1',
      {
        orderItemId: 'item-1',
        newScheduleId: 'sched-new',
        feeCny: 0,
        guard: { correction: true, forbidTicketed: true },
        selfServiceCorrection: true,
      },
      AGENT,
    );
    spy.mockRestore();
  });

  it('代理次日改 → 403，一次都不进改期', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      openOrderRow({ createdAt: new Date(Date.now() - 3 * DAY_MS) }),
    );
    const spy = stubReschedule();
    await expect(service.correctFlightSchedule('o1', 'item-1', 'sched-new', AGENT)).rejects.toThrow(
      AGENT_SELF_EDIT_REASON.NEXT_DAY,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('代理改别人家的单 → 403，一次都不进改期', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow({ agentId: 'ag-other' }));
    const spy = stubReschedule();
    await expect(service.correctFlightSchedule('o1', 'item-1', 'sched-new', AGENT)).rejects.toThrow(
      '无权查看该订单',
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('运营任意时候都能单单纠错（不查窗口）', async () => {
    const spy = stubReschedule();
    await service.correctFlightSchedule('o1', 'item-1', 'sched-new', STAFF);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ── 4. 售后改期的运营闸没被削弱 ───────────────────────────────────────────
describe('rescheduleOrderItem · 运营闸', () => {
  it.each([UserRole.AGENT, UserRole.CUSTOMER])(
    'role=%s 直接调售后改期 → 仍旧 403（自助旗子只有纠错通道会带）',
    async (role) => {
      const err = await service
        .rescheduleOrderItem(
          'o1',
          { orderItemId: 'i1', newScheduleId: 's2', feeCny: 500 },
          { userId: 'u1', role },
        )
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as Error).message).toBe('仅运营/管理员可改期');
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    },
  );
});

// ── 5. 换酒店：自助通道差价强制归 0 ──────────────────────────────────────
describe('swapItemHotel · 自助差价', () => {
  /** 同酒店换房型（净房量不变 → 不走房控前瞻闸），把换酒店主流程铺到能读出生效差价。 */
  function mountSwap() {
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      id: 'i1',
      orderId: 'o1',
      kind: 'HOTEL',
      description: '旧描述',
      quantity: 2,
      hotelRoomTypeId: 'rt-old',
      randomStarTier: null,
      bundleId: null,
      hotelCheckIn: new Date('2026-10-01T00:00:00.000Z'),
      hotelCheckOut: new Date('2026-10-03T00:00:00.000Z'),
      roomsBilled: 1,
      unitCostCny: null,
      totalCostCny: null,
    });
    mockPrisma.hotelRoomType.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'rt-old'
          ? {
              id: 'rt-old',
              name: '大床房',
              hotelId: 'h1',
              hotel: { name: '椰岛酒店', randomTierPlaceholder: null },
            }
          : {
              id: 'rt-new',
              name: '海景房',
              hotelId: 'h1', // 同酒店 → needsHotelFitCheck=false，不必铺房控
              costPriceCny: null,
              hotel: {
                name: '椰岛酒店',
                isActive: true,
                starRating: 4,
                intlFiveStar: false,
                randomTierPlaceholder: null,
              },
            },
    );
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'o1' }]),
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'o1',
          orderNumber: 'FTM-1',
          status: OrderStatus.PAID,
          deletedAt: null,
          adjustmentCny: 0,
          adjustments: [],
          roomAssignment: null,
          total: dec(1000),
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      orderItem: { update: vi.fn().mockResolvedValue({}) },
    };
    mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM-1',
      status: OrderStatus.PAID,
      createdAt: new Date(),
      subtotal: dec(1000),
      taxesAndFees: dec(0),
      discountTotal: dec(0),
      total: dec(1000),
      paidAmount: dec(0),
      prepaymentOffset: dec(0),
      adjustmentCny: 0,
      items: [],
      passengers: [],
      payments: [],
      refunds: [],
      reminders: [],
    });
    return tx;
  }

  const body = { newHotelRoomTypeId: 'rt-new', feeCny: 500, feeLabel: '升级差价' };

  it('代理当天自助换酒店 → 差价被强制归 0，不动 adjustmentCny', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow());
    const tx = mountSwap();
    const { audit } = await service.swapItemHotel('o1', 'i1', body, AGENT);
    expect(audit.feeCny).toBe(0);
    // 差价 0 → 既不写 adjustments 流水也不动订单金额（roomAssignment 为空，也不会走改名分支）
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('运营换酒店 → 差价照原样生效（自助归零只针对代理通道）', async () => {
    const tx = mountSwap();
    const { audit } = await service.swapItemHotel('o1', 'i1', body, STAFF);
    expect(audit.feeCny).toBe(500);
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ adjustmentCny: 500 }) }),
    );
  });

  // ── 套餐档次 ↔ 酒店星级不匹配：代理硬拒，运营写原因才放行（W3）────────────────
  // 放行是「明知档次不符仍按此成交」的定价决定。代理自己填一行原因就能把四星档的单落到
  // 三星店，等于把定价权从我方手里拿走 —— 自助通道没有这个口子，一律找运营。
  function mountBundleSwapToLowStar() {
    const tx = mountSwap();
    mockPrisma.orderItem.findUnique.mockResolvedValue({
      id: 'i1',
      orderId: 'o1',
      kind: 'BUNDLE',
      description: '套餐',
      quantity: 2,
      hotelRoomTypeId: 'rt-old',
      randomStarTier: null,
      bundleId: 'b1',
      hotelCheckIn: new Date('2026-10-01T00:00:00.000Z'),
      hotelCheckOut: new Date('2026-10-03T00:00:00.000Z'),
      roomsBilled: 1,
      unitCostCny: null,
      totalCostCny: null,
    });
    // 换入的是三星店，套餐是四星档 → 不匹配
    mockPrisma.hotelRoomType.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        where.id === 'rt-old'
          ? {
              id: 'rt-old',
              name: '大床房',
              hotelId: 'h1',
              hotel: { name: '椰岛酒店', randomTierPlaceholder: null },
            }
          : {
              id: 'rt-new',
              name: '标准房',
              hotelId: 'h1',
              costPriceCny: null,
              hotel: {
                name: '海棠三星店',
                isActive: true,
                starRating: 3,
                intlFiveStar: false,
                randomTierPlaceholder: null,
              },
            },
    );
    mockPrisma.bundle.findUnique.mockResolvedValue({
      id: 'b1',
      name: '市区四星套餐',
      settlementTier: 'CITY_4STAR',
    });
    return tx;
  }

  it('代理自助换到低星酒店 → 硬拒，写了放行原因也不认', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow());
    const tx = mountBundleSwapToLowStar();

    await expect(
      service.swapItemHotel(
        'o1',
        'i1',
        { newHotelRoomTypeId: 'rt-new', designatedHotelStarMismatchReason: '客人自己要求' },
        AGENT,
      ),
    ).rejects.toThrow('套餐档次与酒店星级不符，请联系运营处理');
    // 一个字都没落库
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it('运营换到低星酒店：不写原因 → 拒；写了原因 → 放行并留档', async () => {
    mountBundleSwapToLowStar();

    await expect(
      service.swapItemHotel('o1', 'i1', { newHotelRoomTypeId: 'rt-new' }, STAFF),
    ).rejects.toThrow('请填写放行原因');

    mountBundleSwapToLowStar();
    const { audit } = await service.swapItemHotel(
      'o1',
      'i1',
      { newHotelRoomTypeId: 'rt-new', designatedHotelStarMismatchReason: '同城升级补位' },
      STAFF,
    );
    expect(audit.starMismatchOverride).toMatchObject({
      bundleId: 'b1',
      hotelStarRating: 3,
      reason: '同城升级补位',
    });
  });

  it('代理次日换酒店 → 403，一行订单项都不读', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      openOrderRow({ createdAt: new Date(Date.now() - 3 * DAY_MS) }),
    );
    await expect(service.swapItemHotel('o1', 'i1', body, AGENT)).rejects.toThrow(
      AGENT_SELF_EDIT_REASON.NEXT_DAY,
    );
    expect(mockPrisma.orderItem.findUnique).not.toHaveBeenCalled();
  });
});

// ── 6. 升舱：窗口闸 ──────────────────────────────────────────────────────
describe('upgradeOrderItemCabin · 自助窗口', () => {
  it('代理次日升舱 → 403，不进事务', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      openOrderRow({ createdAt: new Date(Date.now() - 3 * DAY_MS) }),
    );
    await expect(service.upgradeOrderItemCabin('o1', 'i1', {}, AGENT)).rejects.toThrow(
      AGENT_SELF_EDIT_REASON.NEXT_DAY,
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('代理当天升舱 → 过闸，进入既有升舱事务', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(openOrderRow());
    mockPrisma.$transaction.mockRejectedValue(new Error('REACHED_UPGRADE_TX'));
    await expect(service.upgradeOrderItemCabin('o1', 'i1', {}, AGENT)).rejects.toThrow(
      'REACHED_UPGRADE_TX',
    );
  });

  it('客户升舱 → 403（自助通道不对客户开）', async () => {
    await expect(service.upgradeOrderItemCabin('o1', 'i1', {}, CUSTOMER)).rejects.toThrow(
      '仅运营 / 代理可自助改单',
    );
  });
});

// ── 7. 订单级签证状态 ────────────────────────────────────────────────────
describe('setOrderVisaStatus', () => {
  const visaOrderRow = (over: Record<string, unknown> = {}) => ({
    visaStatus: VisaRequirement.NOT_NEEDED,
    status: OrderStatus.PAID,
    deletedAt: null,
    passengers: [{ visaExempt: false }],
    ...over,
  });

  function mountFinalRead() {
    mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM-1',
      status: OrderStatus.PAID,
      createdAt: new Date(),
      subtotal: dec(0),
      taxesAndFees: dec(0),
      discountTotal: dec(0),
      total: dec(0),
      paidAmount: dec(0),
      prepaymentOffset: dec(0),
      adjustmentCny: 0,
      items: [],
      passengers: [],
      payments: [],
      refunds: [],
      reminders: [],
    });
  }

  it('改成「需要签证」但全员自备签 → 400，一个字都不落库', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      visaOrderRow({ passengers: [{ visaExempt: true }] }),
    );
    const err = await service
      .setOrderVisaStatus('o1', VisaRequirement.NEEDED, STAFF)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toBe(VISA_CONTRADICTION_MESSAGE);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('状态真变了 → 写库 + 事务内同步签证任务', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(visaOrderRow());
    mockPrisma.$transaction.mockResolvedValue(undefined);
    mountFinalRead();
    const res = await service.setOrderVisaStatus('o1', VisaRequirement.NEEDED, STAFF);
    expect(res.changed).toBe(true);
    expect(res.before).toBe(VisaRequirement.NOT_NEEDED);
    expect(res.after).toBe(VisaRequirement.NEEDED);
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { visaStatus: VisaRequirement.NEEDED },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('状态没变 → 不跑签证任务同步（纯改备注的请求不平白多几次查询）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      visaOrderRow({ visaStatus: VisaRequirement.NEEDED }),
    );
    mountFinalRead();
    const res = await service.setOrderVisaStatus('o1', VisaRequirement.NEEDED, STAFF);
    expect(res.changed).toBe(false);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('回收站 / 取消族单不受矛盾闸约束（不参与履约，允许状态收尾）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      visaOrderRow({ status: OrderStatus.CANCELLED, passengers: [{ visaExempt: true }] }),
    );
    mockPrisma.$transaction.mockResolvedValue(undefined);
    mountFinalRead();
    await expect(
      service.setOrderVisaStatus('o1', VisaRequirement.NEEDED, STAFF),
    ).resolves.toMatchObject({ changed: true });
  });
});
