/**
 * OrderService.listDeletedOrders + restoreOrder 回收站口径 · 服务级测试（vitest）
 *
 * 用 vi.mock 把 Prisma 替换成可控 fixture，不依赖真 DB。覆盖：
 *   1. 权限：非 ADMIN（STAFF/AGENT/CUSTOMER）看回收站 / 恢复 → ForbiddenError，且不查库不写库
 *   2. listDeletedOrders：只列 deletedAt 非空、按删除时间倒序；映射订单号/客户/金额/原状态/
 *      删除时间/删除人；删除人从 SOFT_DELETE_ORDER 审计取（actorLabel 优先，回退 actor
 *      displayName/email），取不到置 null（不硬凑）
 *   3. restoreOrder：置 deletedAt=null（不改 status —— 不触碰座位账），返回 before/after 供审计
 *   4. 恢复后重新可见：restore 清空 deletedAt，即从「已删」集合移出，回到正常列表口径
 *   5. 未删 / 不存在的订单 restore → NotFoundError（findFirst 只匹配 deletedAt 非空）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findFirst: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
    // 服务用 $transaction([...]) 批量并发；等价 Promise.all
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// audit 是 fire-and-forget，由路由层调；service 不直接调它。mock 掉避免真写库
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService } from './orders.service.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN };

beforeEach(() => {
  mockPrisma.order.findFirst.mockReset();
  mockPrisma.order.update.mockReset();
  mockPrisma.order.findMany.mockReset();
  mockPrisma.order.count.mockReset();
  mockPrisma.auditLog.findMany.mockReset();
  mockPrisma.$transaction.mockClear();
});

describe('listDeletedOrders · 权限（仅 ADMIN）', () => {
  it.each([UserRole.STAFF, UserRole.AGENT, UserRole.CUSTOMER])(
    '%s 看回收站 → ForbiddenError，且不查库',
    async (role) => {
      await expect(
        service.listDeletedOrders({ page: 1, pageSize: 50 }, { userId: 'u', role }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('listDeletedOrders · 口径与映射', () => {
  it('只列 deletedAt 非空、按删除时间倒序，映射删除人（审计 actorLabel 优先）', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        orderNumber: 'FTM1',
        contactName: '张三',
        total: { toString: () => '1200.00' },
        currency: 'CNY',
        status: OrderStatus.CANCELLED,
        deletedAt,
        passengers: [{ fullName: 'ZHANG SAN', chineseName: '张三' }],
        // 出发日期取最早航段：回程 07-15 在前但被 07-13 去程压过 → departDate=2026-07-13
        items: [
          { hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-07-15T02:00:00Z') } },
          { hotelCheckIn: null, flightSchedule: { departureTime: new Date('2026-07-13T08:30:00Z') } },
        ],
      },
      {
        id: 'o2',
        orderNumber: 'FTM2',
        contactName: '李四',
        total: { toString: () => '800.00' },
        currency: 'CNY',
        status: OrderStatus.REFUNDED,
        deletedAt,
        // 无中文名 → 回退证件姓名
        passengers: [{ fullName: 'LI SI', chineseName: null }],
        // 纯酒店单（无航班）→ 回退最早入住日 → departDate=2026-07-20
        items: [{ hotelCheckIn: new Date('2026-07-20T00:00:00Z'), flightSchedule: null }],
      },
    ]);
    mockPrisma.order.count.mockResolvedValue(2);
    mockPrisma.auditLog.findMany.mockResolvedValue([
      // o1 有缓存 actorLabel → 直接用
      { targetId: 'o1', actorLabel: 'ops@coco', actor: null },
      // o2 无 actorLabel，回退到关联 actor 的 displayName
      { targetId: 'o2', actorLabel: null, actor: { displayName: '运营小组', email: 'x@coco' } },
    ]);

    const res = await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);

    // findMany 只取 deletedAt 非空、倒序；未传 search 时 where 形状不变（无 OR）
    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({ deletedAt: { not: null } });
    expect(findArg.orderBy).toEqual({ deletedAt: 'desc' });
    // select 只取乘客姓名字段（不整对象）
    expect(findArg.select.passengers).toEqual({ select: { fullName: true, chineseName: true } });
    // select 联查派生「出发日期」列所需的最小字段（班次出发时间 + 出发地时区 + 酒店入住日）。
    // departureTz 不可省：出发日要按出发地当地日折算，按 UTC 会把当地凌晨起飞的班次写早一天。
    expect(findArg.select.items).toEqual({
      select: {
        hotelCheckIn: true,
        flightSchedule: { select: { departureTime: true, departureTz: true } },
      },
    });
    // 审计按目标订单 + 动作查
    const auditArg = mockPrisma.auditLog.findMany.mock.calls[0][0];
    expect(auditArg.where.action).toBe('SOFT_DELETE_ORDER');
    expect(auditArg.where.targetId).toEqual({ in: ['o1', 'o2'] });

    expect(res.pagination).toEqual({ page: 1, pageSize: 50, total: 2 });
    expect(res.orders[0]).toEqual({
      id: 'o1',
      orderNumber: 'FTM1',
      customerName: '张三',
      total: '1200.00',
      currency: 'CNY',
      status: OrderStatus.CANCELLED,
      deletedAt,
      deletedBy: 'ops@coco',
      passengerNames: ['张三'],
      // 最早航段（去程 07-13，压过回程 07-15）
      departDate: '2026-07-13',
    });
    expect(res.orders[1].deletedBy).toBe('运营小组');
    // 中文名缺失 → 回退证件姓名（fullName）
    expect(res.orders[1].passengerNames).toEqual(['LI SI']);
    // 纯酒店单无航班 → 回退最早入住日
    expect(res.orders[1].departDate).toBe('2026-07-20');
  });

  it('审计缺失时 deletedBy 置 null（不硬凑）', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findMany.mockResolvedValue([
      {
        id: 'o9',
        orderNumber: 'FTM9',
        contactName: '王五',
        total: { toString: () => '500.00' },
        currency: 'CNY',
        status: OrderStatus.PAYMENT_TIMEOUT,
        deletedAt,
        passengers: [],
      },
    ]);
    mockPrisma.order.count.mockResolvedValue(1);
    mockPrisma.auditLog.findMany.mockResolvedValue([]); // 无审计

    const res = await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);
    expect(res.orders[0].deletedBy).toBeNull();
    expect(res.orders[0].passengerNames).toEqual([]);
    // 无航班无酒店（items 缺失）→ 出发日期安全落空为 null
    expect(res.orders[0].departDate).toBeNull();
  });

  it('无已删订单时不查审计（省一次查询）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    const res = await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);
    expect(res.orders).toEqual([]);
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});

describe('listDeletedOrders · search 分词（与主列表同口径：词间 AND，护照号/备注可搜）', () => {
  /** 主列表口径的单词 OR 块（字面写死，不复用实现——防实现与测试同错）。 */
  const expectedTermClause = (term: string) => ({
    OR: [
      { orderNumber: { contains: term, mode: 'insensitive' } },
      { contactName: { contains: term, mode: 'insensitive' } },
      { contactPhone: { contains: term } },
      { notes: { contains: term, mode: 'insensitive' } },
      { internalNotes: { contains: term, mode: 'insensitive' } },
      { noteHotel: { contains: term, mode: 'insensitive' } },
      { noteVisa: { contains: term, mode: 'insensitive' } },
      { notePayment: { contains: term, mode: 'insensitive' } },
      { noteSpecial: { contains: term, mode: 'insensitive' } },
      {
        passengers: {
          some: {
            OR: [
              { fullName: { contains: term, mode: 'insensitive' } },
              { chineseName: { contains: term, mode: 'insensitive' } },
              { documentNumber: { contains: term, mode: 'insensitive' } },
            ],
          },
        },
      },
    ],
  });

  it('不传 search 时 where 不含 AND/OR（保持原口径）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    await service.listDeletedOrders({ page: 1, pageSize: 50 }, ADMIN);

    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({ deletedAt: { not: null } });
  });

  it('单词向后兼容：where.AND 单元素，OR 覆盖订单号/联系人/电话/备注六栏/乘客名', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    await service.listDeletedOrders({ page: 1, pageSize: 50, search: '陈小雨' }, ADMIN);

    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({
      deletedAt: { not: null },
      AND: [expectedTermClause('陈小雨')],
    });
    // count 也要用同一个 where（分页 total 与筛选口径一致）
    const countArg = mockPrisma.order.count.mock.calls[0][0];
    expect(countArg.where).toEqual(findArg.where);
  });

  it('多词跨乘客：空格分词后词间 AND —— 两个乘客名各自命中一词才算中', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    await service.listDeletedOrders(
      { page: 1, pageSize: 50, search: '陈小雨 林大山' },
      ADMIN,
    );

    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    // 词间 AND：每个词各自独立展开成一组 OR，跨乘客（passengers.some 各词独立）命中同一单
    expect(findArg.where).toEqual({
      deletedAt: { not: null },
      AND: [expectedTermClause('陈小雨'), expectedTermClause('林大山')],
    });
  });

  it('护照号可搜：证件号词也展开到 passengers.documentNumber（含于每词 OR 块）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    await service.listDeletedOrders({ page: 1, pageSize: 50, search: 'EA1234567' }, ADMIN);

    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    const clause = findArg.where.AND[0];
    expect(clause.OR).toContainEqual({
      passengers: {
        some: {
          OR: [
            { fullName: { contains: 'EA1234567', mode: 'insensitive' } },
            { chineseName: { contains: 'EA1234567', mode: 'insensitive' } },
            { documentNumber: { contains: 'EA1234567', mode: 'insensitive' } },
          ],
        },
      },
    });
  });

  it('纯分隔符 search（如全空格）→ 分词为空，where 不叠加 AND', async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    mockPrisma.order.count.mockResolvedValue(0);

    await service.listDeletedOrders({ page: 1, pageSize: 50, search: '  、, ' }, ADMIN);

    const findArg = mockPrisma.order.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({ deletedAt: { not: null } });
  });
});

describe('restoreOrder · 权限（仅 ADMIN）', () => {
  it.each([UserRole.STAFF, UserRole.AGENT, UserRole.CUSTOMER])(
    '%s 恢复 → ForbiddenError，且不查库不写库',
    async (role) => {
      await expect(
        service.restoreOrder('o1', { userId: 'u', role }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockPrisma.order.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    },
  );
});

describe('restoreOrder · 恢复已软删订单', () => {
  it('置 deletedAt=null（不改 status），返回 before/after 供审计', async () => {
    const deletedAt = new Date('2026-07-08T12:00:00Z');
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      deletedAt,
    });
    mockPrisma.order.update.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      deletedAt: null,
    });

    const res = await service.restoreOrder('o1', ADMIN);

    // 只找已软删订单（deletedAt 非空）
    expect(mockPrisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1', deletedAt: { not: null } } }),
    );
    // 清 deletedAt；绝不改 status（软删/恢复都不触碰座位账）
    const updateArg = mockPrisma.order.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'o1' });
    expect(updateArg.data).toEqual({ deletedAt: null });
    expect(updateArg.data).not.toHaveProperty('status');
    // 审计快照：before 记删除时间、原状态；after 记 deletedAt=null（恢复动作可追溯）
    expect(res.before).toEqual({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.CANCELLED,
      deletedAt,
    });
    expect(res.after.deletedAt).toBeNull();
    expect(res.after.status).toBe(OrderStatus.CANCELLED);
  });

  it('恢复后 deletedAt=null —— 从「已删」集合移出，回到正常列表口径', async () => {
    mockPrisma.order.findFirst.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      deletedAt: new Date('2026-07-08T12:00:00Z'),
    });
    mockPrisma.order.update.mockResolvedValue({
      id: 'o1',
      orderNumber: 'FTM1',
      status: OrderStatus.REFUNDED,
      deletedAt: null,
    });

    const res = await service.restoreOrder('o1', ADMIN);
    // deletedAt 为 null → 之后 listDeletedOrders 的 where(deletedAt not null) 不再命中它，
    // 同时 buildOrderFilterWhere(deletedAt: null) 会重新纳入它（软删口径见 soft-delete 测试）
    expect(res.after.deletedAt).toBeNull();
  });
});

describe('restoreOrder · 未删 / 不存在', () => {
  it('findFirst 返回 null（未软删或不存在）→ NotFoundError，且不写库', async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    await expect(service.restoreOrder('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });
});
