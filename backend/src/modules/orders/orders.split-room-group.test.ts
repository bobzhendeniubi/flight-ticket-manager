/**
 * 按房组拆分酒店行（split-room-group）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. 守卫矩阵：权限 / 死单 / 回收站 / 非住宿行（FLIGHT）/
 *      无分房表 / 房组不存在 / 已归属其它行 / 拆满-拆超-源行无房数 —— 全部拒绝且分毫不写。
 *   2. 成功路径：新行 0 元（拆行只拆库存归属不拆应收）、roomsBilled 与 totalCostCny
 *      按 0.5 网格/间数比例拆分且 Σ 守恒、metadata 打标、idempotencyKey 置空。
 *   3. roomAssignment 归属回填：目标组指到新行，其余无归属组回填为源行。
 *   4. 守恒断言兜底：落库结果对不上拆前 Σ → 抛错（事务回滚），绝不静默吞账。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderItemKind, Prisma, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    orderItem: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { ForbiddenError } from '../../lib/errors.js';
import { splitRoomGroupBodySchema } from './orders.schemas.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;

beforeEach(() => {
  vi.clearAllMocks();
  // serializeOrder 走不到（返回 null 会抛）—— 成功路径一律 .catch(() => undefined) 后断言写入。
  mockPrisma.order.findUniqueOrThrow.mockResolvedValue(null);
});

/** 源酒店行 fixture：2 间 × 2 晚，成本 1200。*/
function hotelItem(over: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    orderId: 'ord-1',
    kind: OrderItemKind.HOTEL,
    description: '明月酒店 · 标准间 · 2026-09-01~2026-09-03 · 2晚 × 2间',
    quantity: 2,
    unitPrice: new Prisma.Decimal(800),
    unitCostCny: new Prisma.Decimal(300),
    totalCostCny: new Prisma.Decimal(1200),
    hotelRoomTypeId: 'rt-1',
    randomStarTier: null,
    hotelCheckIn: new Date('2026-09-01T00:00:00.000Z'),
    hotelCheckOut: new Date('2026-09-03T00:00:00.000Z'),
    roomsBilled: new Prisma.Decimal(2),
    ...over,
  };
}

/** 分房表 fixture：g1（要拆的组，0.5 间）+ g2（无归属组，应回填源行）。*/
function assignment(over: { g1?: Record<string, unknown>; g2?: Record<string, unknown> } = {}) {
  return {
    roomGroups: [
      {
        id: 'g1',
        hotelName: '明月酒店',
        roomType: '标准间',
        passengerIds: ['p1'],
        roomFraction: 0.5,
        ...(over.g1 ?? {}),
      },
      {
        id: 'g2',
        hotelName: '明月酒店',
        roomType: '标准间',
        passengerIds: ['p2', 'p3'],
        roomFraction: 1.5,
        ...(over.g2 ?? {}),
      },
    ],
  };
}

/**
 * 挂载事务内依赖：小型内存账 —— create/update 写进去，守恒断言的 findUniqueOrThrow
 * 读出来；corrupt* 开关故意让落库结果与拆前对不上（验证守恒断言真的会拦）。
 */
function mountSplit(
  o: {
    status?: string;
    deletedAt?: Date | null;
    item?: Record<string, unknown> | null;
    roomAssignment?: unknown;
    corruptRoomsBilled?: boolean;
    corruptTotal?: boolean;
  } = {},
) {
  const state: {
    created: (Record<string, unknown> & { id: string }) | null;
    srcAfter: Record<string, unknown> | null;
    orderUpdates: Array<{ data: Record<string, unknown> }>;
  } = { created: null, srcAfter: null, orderUpdates: [] };
  const item = o.item === null ? null : hotelItem(o.item ?? {});
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'ord-1' }]),
    order: {
      findUnique: vi.fn(async () => ({
        id: 'ord-1',
        orderNumber: 'FTM-1',
        status: o.status ?? 'PAID',
        deletedAt: o.deletedAt ?? null,
        roomAssignment: 'roomAssignment' in o ? o.roomAssignment : assignment(),
        total: new Prisma.Decimal(5000),
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.orderUpdates.push(args);
        return { id: 'ord-1' };
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        total: new Prisma.Decimal(o.corruptTotal ? 4999 : 5000),
      })),
    },
    orderItem: {
      findUnique: vi.fn(async () => item),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.created = { id: 'item-new', ...args.data };
        return state.created;
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.srcAfter = args.data;
        return { id: 'item-1' };
      }),
      findUniqueOrThrow: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === 'item-new') {
          return {
            roomsBilled: o.corruptRoomsBilled
              ? new Prisma.Decimal(99)
              : ((state.created?.roomsBilled as Prisma.Decimal | undefined) ?? null),
            totalCostCny: (state.created?.totalCostCny as Prisma.Decimal | null | undefined) ?? null,
          };
        }
        return {
          roomsBilled: (state.srcAfter?.roomsBilled as Prisma.Decimal | undefined) ?? null,
          totalCostCny: (state.srcAfter?.totalCostCny as Prisma.Decimal | null | undefined) ?? null,
        };
      }),
    },
  };
  mockPrisma.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  return { tx, state };
}

const BODY = { roomGroupId: 'g1' } as const;

describe('splitRoomGroupBodySchema · 输入校验', () => {
  it('roomGroupId 必填；note 可选且限长', () => {
    expect(splitRoomGroupBodySchema.safeParse({ roomGroupId: 'g1' }).success).toBe(true);
    expect(
      splitRoomGroupBodySchema.safeParse({ roomGroupId: 'g1', note: '拆去换酒店' }).success,
    ).toBe(true);
    expect(splitRoomGroupBodySchema.safeParse({}).success).toBe(false);
    expect(splitRoomGroupBodySchema.safeParse({ roomGroupId: '' }).success).toBe(false);
    expect(
      splitRoomGroupBodySchema.safeParse({ roomGroupId: 'g1', note: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('splitHotelItemByRoomGroup · 守卫矩阵（全部拒绝且分毫不写）', () => {
  it.each(['CUSTOMER', 'AGENT'] as const)('%s 调用 → ForbiddenError，且未开事务', async (role) => {
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, { userId: 'u1', role }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('回收站单（deletedAt 非空）→ 400', async () => {
    const { tx } = mountSplit({ deletedAt: new Date() });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/回收站/);
    expect(tx.orderItem.create).not.toHaveBeenCalled();
  });

  it('非占座态（已取消）→ 400', async () => {
    const { tx } = mountSplit({ status: 'CANCELLED' });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/不可拆分房组/);
    expect(tx.orderItem.create).not.toHaveBeenCalled();
  });

  it('BUNDLE 行（0902 放开）→ 照拆：新行落 kind=HOTEL、0 元、带走 0.5 间', async () => {
    const { tx, state } = mountSplit({ item: { kind: OrderItemKind.BUNDLE } });
    await service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN).catch(() => undefined);
    expect(tx.orderItem.create).toHaveBeenCalledTimes(1);
    // 新行不是第二条 BUNDLE 行（那会让改档与拆单的套餐行数闸一起失灵），而是一条住宿行。
    expect(state.created?.kind).toBe(OrderItemKind.HOTEL);
    expect(Number(state.created?.amount)).toBe(0);
    expect(Number(state.created?.roomsBilled)).toBe(0.5);
    // 单价与金额配套归 0：照抄套餐整包一口价会得到「单价 ¥X / 金额 ¥0」的自相矛盾行，
    // 任何按 unitPrice × quantity 复算金额的地方都会把它算成一笔没入账的钱。
    expect(Number(state.created?.unitPrice)).toBe(0);
    // 描述点明来历（新行 kind=HOTEL，不加后缀会被当成另买的酒店）
    expect(String(state.created?.description)).toContain('（拆出住宿）');
  });

  it('独立 HOTEL 行拆出的新行保留源行单价与描述（只有套餐行才归 0 / 加后缀）', async () => {
    const { state } = mountSplit({ item: { kind: OrderItemKind.HOTEL } });
    await service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN).catch(() => undefined);
    expect(Number(state.created?.unitPrice)).not.toBe(0);
    expect(String(state.created?.description)).not.toContain('（拆出住宿）');
  });

  it('非住宿行（FLIGHT）→ 400', async () => {
    const { tx } = mountSplit({ item: { kind: OrderItemKind.FLIGHT } });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/不是住宿行/);
    expect(tx.orderItem.create).not.toHaveBeenCalled();
  });

  it('本单尚无分房表 → 400', async () => {
    mountSplit({ roomAssignment: null });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/尚无分房表/);
  });

  it('roomGroupId 不在分房表里 → 400', async () => {
    mountSplit();
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', { roomGroupId: 'g999' }, ADMIN),
    ).rejects.toThrow(/不存在该房组/);
  });

  it('房组已归属其它订单行 → 400', async () => {
    mountSplit({ roomAssignment: assignment({ g1: { orderItemId: 'item-other' } }) });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/已归属其它订单行/);
  });

  it('房组占满源行全部房数（拆空源行）→ 400 提示无需拆分', async () => {
    mountSplit({ roomAssignment: assignment({ g1: { roomFraction: 2 } }) });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/无需拆分/);
  });

  it('房组间数超过源行计费房数 → 400', async () => {
    mountSplit({ roomAssignment: assignment({ g1: { roomFraction: 3 } }) });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/超过源行计费房数/);
  });

  it('源行未记录 roomsBilled → 400（先保存分房表）', async () => {
    mountSplit({ item: { roomsBilled: null } });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/未记录计费房数/);
  });

  it('itemId 不属于本单 → 404 语义（NotFound）', async () => {
    mountSplit({ item: { orderId: 'ord-other' } });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/不存在或不属于该订单/);
  });
});

describe('splitHotelItemByRoomGroup · 成功路径（守恒 + 归属回填）', () => {
  it('拆 0.5 间：新行 0 元、roomsBilled=0.5、成本按比例挪；源行 1.5 间、成本同步减 —— Σ 守恒', async () => {
    const { tx, state } = mountSplit();

    await service
      .splitHotelItemByRoomGroup('ord-1', 'item-1', { roomGroupId: 'g1', note: '拆去换酒店' }, ADMIN)
      .catch(() => undefined);

    // 新行：复制住宿要素，钱=0（拆行只拆库存归属不拆应收），成本 = 1200 × 0.5/2 = 300
    expect(tx.orderItem.create).toHaveBeenCalledTimes(1);
    const created = state.created!;
    expect(created.kind).toBe(OrderItemKind.HOTEL);
    expect(Number((created.amount as Prisma.Decimal).toString())).toBe(0);
    expect(Number((created.roomsBilled as Prisma.Decimal).toString())).toBe(0.5);
    expect(Number((created.totalCostCny as Prisma.Decimal).toString())).toBe(300);
    expect(created.hotelRoomTypeId).toBe('rt-1');
    expect(created.quantity).toBe(2);
    expect(created.idempotencyKey).toBeNull();
    expect(created.metadata).toMatchObject({
      splitRoomGroup: { fromItemId: 'item-1', roomGroupId: 'g1' },
      note: '拆去换酒店',
    });

    // 源行：2 - 0.5 = 1.5 间；成本 1200 - 300 = 900（Σ roomsBilled / Σ 成本与拆前恒等）
    const srcAfter = state.srcAfter!;
    expect(Number((srcAfter.roomsBilled as Prisma.Decimal).toString())).toBe(1.5);
    expect(Number((srcAfter.totalCostCny as Prisma.Decimal).toString())).toBe(900);

    // 归属回填：目标组 → 新行；无归属的 g2 → 源行（本单从此每组有归属）
    expect(state.orderUpdates).toHaveLength(1);
    const groups = (
      state.orderUpdates[0].data.roomAssignment as { roomGroups: Array<Record<string, unknown>> }
    ).roomGroups;
    expect(groups.find((g) => g.id === 'g1')?.orderItemId).toBe('item-new');
    expect(groups.find((g) => g.id === 'g2')?.orderItemId).toBe('item-1');
  });

  it('roomFraction 缺省按 1 间拆；源行成本为 null → 两行成本都保持 null（不虚构成本）', async () => {
    const { state } = mountSplit({
      item: { totalCostCny: null, unitCostCny: null },
      roomAssignment: assignment({ g1: { roomFraction: undefined } }),
    });

    await service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN).catch(() => undefined);

    expect(Number((state.created!.roomsBilled as Prisma.Decimal).toString())).toBe(1);
    expect(state.created!.totalCostCny).toBeNull();
    expect(Number((state.srcAfter!.roomsBilled as Prisma.Decimal).toString())).toBe(1);
    expect(state.srcAfter!.totalCostCny).toBeNull();
  });

  it('已归属本行（orderItemId == itemId）的组允许拆出，拆后指到新行', async () => {
    const { state } = mountSplit({ roomAssignment: assignment({ g1: { orderItemId: 'item-1' } }) });

    await service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN).catch(() => undefined);

    expect(state.created).not.toBeNull();
    const groups = (
      state.orderUpdates[0].data.roomAssignment as { roomGroups: Array<Record<string, unknown>> }
    ).roomGroups;
    expect(groups.find((g) => g.id === 'g1')?.orderItemId).toBe('item-new');
  });
});

describe('splitHotelItemByRoomGroup · 守恒断言兜底（不平回滚）', () => {
  it('落库后 Σ roomsBilled 与拆前不符 → 抛错（事务回滚），绝不静默吞账', async () => {
    mountSplit({ corruptRoomsBilled: true });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/Σ roomsBilled 与拆前不符/);
  });

  it('order.total 被改动 → 抛错（拆行绝不动应收）', async () => {
    mountSplit({ corruptTotal: true });
    await expect(
      service.splitHotelItemByRoomGroup('ord-1', 'item-1', BODY, ADMIN),
    ).rejects.toThrow(/order\.total 被改动/);
  });
});
