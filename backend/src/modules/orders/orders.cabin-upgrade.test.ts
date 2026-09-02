/**
 * 售后升舱（经济舱 → 商务舱）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 背景：运营反馈「已生成的订单没办法改成商务舱」。此前唯一路径是借「改期」表单手填差价，
 * 科目落成改期费、订单被误推「已改期」、行描述仍写着经济舱。现在有独立的升舱操作：
 * 目标舱固定商务舱，差价由服务端按航班的升舱差价源 × 人数权威计算。
 *
 * 覆盖：
 *   1. computeCabinUpgradeDiffCny：差价 = 每人每航段 × 人数（含 0/负数兜底）。
 *   2. buildUpgradedCabinDescription：描述快照刷新（替换/追加/幂等/超级经济舱写法）。
 *   3. upgradeItemCabinBodySchema：请求体只收备注，任何金额字段都进不来。
 *   4. 权限：非 ADMIN/STAFF → ForbiddenError（未触库）。
 *   5. 成功路径：座位对称搬移（放 ECONOMY → 拿 BUSINESS）+ 行改舱 + UPGRADE_CHANGE 行 + 总额抬升 + 状态不动。
 *   6. 商务舱余位不足 → ConflictError，且不落任何金额写入（真回滚由事务保证）。
 *   7. 非经济舱行 / 套餐机票腿 / 差价源未配置 / 收款已锁定 → 拒绝，且不搬座位。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  OrderService,
  buildUpgradedCabinDescription,
  computeCabinUpgradeDiffCny,
} from './orders.service.js';
import { BadRequestError, ConflictError, ForbiddenError } from '../../lib/errors.js';
import { upgradeItemCabinBodySchema } from './orders.schemas.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: 'ADMIN' } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 测试夹具：一个可就地改写的 tx mock ──────────────────────────────────────
type TxOverrides = {
  status?: string;
  deletedAt?: Date | null;
  paymentsLocked?: boolean;
  itemCabin?: string | null;
  itemKind?: string;
  itemQuantity?: number;
  itemDescription?: string;
  itemBundleId?: string | null;
  itemMetadata?: Record<string, unknown> | null;
  /** 该航段的出发时刻（默认 30 天后 = 还没飞）。 */
  itemDepartureTime?: Date;
  upgradeCnyPerLeg?: number;
  /** 拿商务舱座的 CAS 是否成功（false = 余位不足） */
  businessSeatAvailable?: boolean;
};

function buildTx(o: TxOverrides = {}) {
  const businessSeatAvailable = o.businessSeatAvailable ?? true;
  // $executeRaw 依次被调用：① 放经济舱座（GREATEST 版）② 拿商务舱座（CAS）。
  // CAS 判定看返回的 affected 行数：1 = 拿到，0 = 售罄。
  let rawCallIndex = 0;
  const $executeRaw = vi.fn(async () => {
    rawCallIndex += 1;
    if (rawCallIndex === 1) return 1; // 放座
    return businessSeatAvailable ? 1 : 0; // 拿座
  });

  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'o1' }]),
    $executeRaw,
    order: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'o1',
        orderNumber: 'ORD-1',
        status: o.status ?? 'PAID',
        deletedAt: o.deletedAt ?? null,
        paymentsLocked: o.paymentsLocked ?? false,
        subtotal: new Prisma.Decimal(10000),
        total: new Prisma.Decimal(10000),
        items: [{ amount: new Prisma.Decimal(10000) }],
      }),
      update: vi.fn(),
    },
    orderItem: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'it-1',
        orderId: 'o1',
        kind: o.itemKind ?? 'FLIGHT',
        description: o.itemDescription ?? 'MFM→DAD 经济舱 去程',
        quantity: o.itemQuantity ?? 2,
        flightScheduleId: 'sch-1',
        flightCabin: o.itemCabin === undefined ? 'ECONOMY' : o.itemCabin,
        bundleId: o.itemBundleId ?? null,
        metadata: o.itemMetadata ?? null,
        // 升舱有「已起飞不许升舱」硬闸：默认给一个未来时刻，用例要测那道闸时传过去的时刻。
        flightSchedule: {
          departureTime: o.itemDepartureTime ?? new Date(Date.now() + 30 * 24 * 3600_000),
          departureTz: 'Asia/Shanghai',
        },
      }),
      update: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'it-upgrade-1' }),
    },
    flightSchedule: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'sch-1',
        flight: { businessUpgradeCnyPerLeg: o.upgradeCnyPerLeg ?? 700 },
      }),
    },
    flightSeatClass: {
      findFirst: vi.fn().mockResolvedValue({ capacity: 10, sold: 10 }),
    },
    seatLock: { aggregate: vi.fn().mockResolvedValue({ _sum: { qty: 0 } }) },
  };
}

function mountTx(tx: ReturnType<typeof buildTx>) {
  mockPrisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  // 事务提交后重新读整单交给 serializeOrder —— 单测里给一份最小可序列化的订单。
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue({
    id: 'o1',
    orderNumber: 'ORD-1',
    status: 'PAID',
    subtotal: new Prisma.Decimal(11400),
    taxesAndFees: new Prisma.Decimal(0),
    discountTotal: new Prisma.Decimal(0),
    total: new Prisma.Decimal(11400),
    paidAmount: new Prisma.Decimal(0),
    prepaymentOffset: new Prisma.Decimal(0),
    adjustmentCny: 0,
    items: [],
    passengers: [],
  });
}

/** 从 $executeRaw 的调用参数里挑出舱位值（模板参数里出现的 ECONOMY/BUSINESS）。 */
function cabinOfRawCall(call: unknown[]): string | undefined {
  return call.slice(1).find((v): v is string => v === 'ECONOMY' || v === 'BUSINESS');
}

describe('computeCabinUpgradeDiffCny · 升舱差价 = 每人每航段 × 人数', () => {
  it('¥700/程/座 × 2 人 = ¥1400', () => {
    expect(computeCabinUpgradeDiffCny(700, 2)).toBe(1400);
  });

  it('单人：差价 = 每人每航段价本身', () => {
    expect(computeCabinUpgradeDiffCny(700, 1)).toBe(700);
  });

  it('差价源为 0 / 人数为 0 → 0（调用方另有守卫拒绝，这里只保证不出负数）', () => {
    expect(computeCabinUpgradeDiffCny(0, 3)).toBe(0);
    expect(computeCabinUpgradeDiffCny(700, 0)).toBe(0);
    expect(computeCabinUpgradeDiffCny(-700, 2)).toBe(0);
  });
});

describe('buildUpgradedCabinDescription · 行描述快照刷新', () => {
  it('描述含「经济舱」→ 就地替换为「商务舱」', () => {
    expect(buildUpgradedCabinDescription('MFM→DAD 经济舱 去程')).toBe('MFM→DAD 商务舱 去程');
  });

  it('往返两处舱位字样都替换', () => {
    expect(buildUpgradedCabinDescription('经济舱去程 + 经济舱回程')).toBe('商务舱去程 + 商务舱回程');
  });

  it('「超级经济舱」整体替换，不留「超级商务舱」', () => {
    expect(buildUpgradedCabinDescription('MFM→DAD 超级经济舱')).toBe('MFM→DAD 商务舱');
  });

  it('描述里没写舱位 → 末尾追加「 · 商务舱」', () => {
    expect(buildUpgradedCabinDescription('MFM→DAD 去程')).toBe('MFM→DAD 去程 · 商务舱');
  });

  it('已写着商务舱 → 原样返回（幂等，不重复追加）', () => {
    expect(buildUpgradedCabinDescription('MFM→DAD 商务舱')).toBe('MFM→DAD 商务舱');
  });
});

describe('upgradeItemCabinBodySchema · 请求体不接受任何金额', () => {
  it('空请求体合法（差价全由服务端算）', () => {
    expect(upgradeItemCabinBodySchema.safeParse({}).success).toBe(true);
  });

  it('只收备注', () => {
    const parsed = upgradeItemCabinBodySchema.parse({ note: '客户加钱升舱' });
    expect(parsed).toEqual({ note: '客户加钱升舱' });
  });

  it('客户端传金额 → 被 schema 丢弃，进不到服务层', () => {
    const parsed = upgradeItemCabinBodySchema.parse({ diffCny: 1, feeCny: 9999 });
    expect(parsed).not.toHaveProperty('diffCny');
    expect(parsed).not.toHaveProperty('feeCny');
  });
});

describe('OrderService.upgradeOrderItemCabin · 权限', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('%s 调用 → ForbiddenError，且未开事务', async (role) => {
    await expect(
      service.upgradeOrderItemCabin('o1', 'it-1', {}, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('OrderService.upgradeOrderItemCabin · 成功路径', () => {
  it('放经济舱座 → 拿商务舱座（同事务、同班次、同人数），行改舱 + 差价成行 + 总额抬升，状态不动', async () => {
    const tx = buildTx({ itemQuantity: 2, upgradeCnyPerLeg: 700 });
    mountTx(tx);

    const { audit } = await service.upgradeOrderItemCabin('o1', 'it-1', { note: '客户加钱升舱' }, ADMIN);

    // ① 座位对称：先放经济舱、再拿商务舱，两笔都在同一事务内
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(cabinOfRawCall(tx.$executeRaw.mock.calls[0] as unknown[])).toBe('ECONOMY');
    expect(cabinOfRawCall(tx.$executeRaw.mock.calls[1] as unknown[])).toBe('BUSINESS');

    // ② 原机票行就地改舱 + 描述快照刷新（列表不再显示「经济舱」）
    expect(tx.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'it-1' },
        data: expect.objectContaining({
          flightCabin: 'BUSINESS',
          description: 'MFM→DAD 商务舱 去程',
        }),
      }),
    );

    // ③ 差价单独成一条 UPGRADE_CHANGE 收入行（不是 RESCHEDULE_FEE、不是手填）
    const createArg = tx.orderItem.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(createArg.data.kind).toBe('UPGRADE_CHANGE');
    expect(createArg.data.description).toBe('升舱商务 ×2人');
    expect(createArg.data.quantity).toBe(2);
    expect(Number(String(createArg.data.amount))).toBe(1400);
    expect(Number(String(createArg.data.unitPrice))).toBe(700);

    // ④ 订单总额 = 原商品行合计 + 差价（不走 adjustmentCny）
    const updateArg = tx.order.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Number(String(updateArg.data.subtotal))).toBe(11400);
    expect(Number(String(updateArg.data.total))).toBe(11400);
    // ⑤ 订单状态不动：升舱不是改签，不写 status
    expect(updateArg.data).not.toHaveProperty('status');

    expect(audit).toMatchObject({
      fromCabin: 'ECONOMY',
      toCabin: 'BUSINESS',
      quantity: 2,
      upgradeCnyPerLeg: 700,
      diffCny: 1400,
      subtotalBefore: 10000,
      subtotalAfter: 11400,
    });
  });
});

describe('OrderService.upgradeOrderItemCabin · 商务舱余位不足', () => {
  it('拿商务舱座 CAS 失败 → ConflictError（文案指向升舱），且不写任何金额', async () => {
    const tx = buildTx({ businessSeatAvailable: false });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toThrow(
      /商务舱余位不足/,
    );
    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // 差价行 / 订单总额 / 行改舱一律没发生（真回滚由数据库事务保证，这里守住「抛错前不写」）
    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe('OrderService.upgradeOrderItemCabin · 拒绝的入口（都不搬座位）', () => {
  it('非经济舱行（已是商务舱）→ BadRequestError', async () => {
    const tx = buildTx({ itemCabin: 'BUSINESS' });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('非机票行（酒店行）→ BadRequestError', async () => {
    const tx = buildTx({ itemKind: 'HOTEL' });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('套餐机票腿（带 bundleId）→ BadRequestError，提示联系技术处理', async () => {
    const tx = buildTx({ itemBundleId: 'bundle-1' });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toThrow(
      /套餐订单.*联系技术处理/,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('建单时已拆过商务舱座的行（metadata.businessUpgradeCount>0）→ BadRequestError', async () => {
    const tx = buildTx({ itemMetadata: { businessUpgradeCount: 1 } });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('航班未配置升舱差价（0）→ BadRequestError，提示先去航班管理维护', async () => {
    const tx = buildTx({ upgradeCnyPerLeg: 0 });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toThrow(
      /未配置商务舱差价/,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('收款已锁定（财务复核完成）→ ConflictError（金额要变，先解锁）', async () => {
    const tx = buildTx({ paymentsLocked: true });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.create).not.toHaveBeenCalled();
  });

  it('回收站单（已软删）→ BadRequestError（资金闸）', async () => {
    const tx = buildTx({ deletedAt: new Date() });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('已取消单 → BadRequestError（资金闸：终态单不许再抬总额）', async () => {
    const tx = buildTx({ status: 'CANCELLED' });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('该段已标 no-show（客人未登机）→ 拒绝升舱，一座不动', async () => {
    // no-show 的口径是钱与成本一分不动。给这一段升舱会真搬座位、真抬 total —— 客人没上飞机
    // 却被收了升舱差价，与取消航段闸 11、改期同一道闸。
    const tx = buildTx({ itemMetadata: { noShow: { at: new Date().toISOString() } } });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toThrow(
      /已标 no-show/,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.create).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('该段已起飞 → 拒绝升舱（放旧座会让过去的班次凭空多出余位）', async () => {
    const tx = buildTx({ itemDepartureTime: new Date(Date.now() - 3 * 24 * 3600_000) });
    mountTx(tx);

    await expect(service.upgradeOrderItemCabin('o1', 'it-1', {}, ADMIN)).rejects.toThrow(
      /已起飞/,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItem.create).not.toHaveBeenCalled();
  });
});
