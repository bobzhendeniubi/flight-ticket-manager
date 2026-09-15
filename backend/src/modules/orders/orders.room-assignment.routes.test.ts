/**
 * 分房保存 · 路由级单测（鉴权 + 代理归属）
 *
 * 口径（2026-09）：代理可以给自家（含下级）订单分房，与运营用同一个编辑器、同一条保存接口；
 * 归属靠 service.getOrder（assertCanView）判，客户仍旧 403。
 * 分房本身的房量闸 / roomsBilled 分行落 / 警示文案不在这里测（见 hotel-control 与集成测试）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => {
  const tx = {
    // 分房保存现在锁序「先 Order 后酒店」：处理器自己在 tx 里 $queryRaw FOR UPDATE 锁本单，
    // 再 tx.order.findUnique 重读锁后现状（reconcile 共享组用）——两者都要 mock 掉。
    $queryRaw: vi.fn().mockResolvedValue([]),
    order: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ roomAssignment: null }),
    },
    orderItem: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockResolvedValue({ _sum: { roomsBilled: null } }),
    },
    // §五闸（assertHotelFitAfterChange）读包房周期；缺省当「本酒店未纳管」（不拦截）。
    hotelBlockPeriod: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    tx,
    user: {
      findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
    },
    agent: { findUnique: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn() },
    orderItem: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { roomsBilled: null } }),
    },
    passenger: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
}));
vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return {
    ...actual,
    OrderService: vi.fn().mockImplementation(() => serviceMocks),
  };
});

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderRoutes } from './orders.routes.js';
import { writeAudit } from '../../lib/audit.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

describe('PUT /orders/:id/room-assignment · 角色与归属', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      agentProfile: { isActive: true },
    });
    prismaMock.agent.findUnique.mockResolvedValue({ id: 'ag-1', isActive: true });
    prismaMock.order.findUnique.mockResolvedValue({ orderNumber: 'FTM-1', roomAssignment: null });
    prismaMock.orderItem.count.mockResolvedValue(0);
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { roomsBilled: null } });
    prismaMock.passenger.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findFirst.mockResolvedValue(null);
    serviceMocks.getOrder.mockResolvedValue({ id: 'o1' });
  });

  const tokenFor = (sub: string, role: UserRole) => app.jwt.sign({ sub, role });

  const body = {
    roomGroups: [
      { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1', 'p2'] },
    ],
  };

  const put = (role: UserRole) =>
    app.inject({
      method: 'PUT',
      url: '/orders/o1/room-assignment',
      headers: { authorization: `Bearer ${tokenFor(`u-${role}`, role)}` },
      payload: body,
    });

  it('客户 → 403，不查归属也不落库', async () => {
    const res = await put(UserRole.CUSTOMER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '仅运营 / 代理可分房' });
    expect(serviceMocks.getOrder).not.toHaveBeenCalled();
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('代理给自家单分房 → 先过归属（带 agentId），再照运营路径落库 + 审计', async () => {
    const res = await put(UserRole.AGENT);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, warnings: [] });
    expect(serviceMocks.getOrder).toHaveBeenCalledWith('o1', {
      userId: 'u-AGENT',
      role: UserRole.AGENT,
      agentId: 'ag-1',
    });
    expect(prismaMock.tx.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { roomAssignment: body },
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE_ROOM_ASSIGNMENT', targetId: 'o1' }),
    );
  });

  it('代理碰别家的单（归属校验 403）→ 原样回 403，不落库', async () => {
    serviceMocks.getOrder.mockRejectedValue(new ForbiddenError('无权查看该订单'));
    const res = await put(UserRole.AGENT);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('代理分不存在的单 → 404', async () => {
    serviceMocks.getOrder.mockRejectedValue(new NotFoundError('订单不存在'));
    const res = await put(UserRole.AGENT);
    expect(res.statusCode).toBe(404);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('运营路径不受影响：不走归属校验，直接落库', async () => {
    const res = await put(UserRole.STAFF);
    expect(res.statusCode).toBe(200);
    expect(serviceMocks.getOrder).not.toHaveBeenCalled();
    expect(prismaMock.tx.order.update).toHaveBeenCalled();
  });
});

/**
 * PUT /orders/:id/room-assignment · 跨单分房 reconcile（§五「改」+ astra 评审 finding 9）
 *
 *   - 服务端以「锁后现状」（tx.order.findUnique 重读，而不是请求前的旧值）为准，把客户端
 *     发不出来的 sharedRoomId / splitPairKey 搬回最终写库的 roomGroups；
 *   - 带 sharedRoomId 的旧房组：改乘客/酒店名/房型/份额/归属或整组删除 → 400；只改 notes → 放行；
 *   - 没有 sharedRoomId 的旧房组若带 splitPairKey（拆单配对键），resave 后原样保留（finding 9）。
 */
describe('PUT /orders/:id/room-assignment · 跨单分房 reconcile', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      agentProfile: { isActive: true },
    });
    prismaMock.order.findUnique.mockResolvedValue({ orderNumber: 'FTM-1', roomAssignment: null });
    prismaMock.orderItem.count.mockResolvedValue(0);
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { roomsBilled: null } });
    prismaMock.passenger.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findMany.mockResolvedValue([]);
    prismaMock.tx.orderItem.findFirst.mockResolvedValue(null);
    prismaMock.tx.orderItem.aggregate.mockResolvedValue({ _sum: { roomsBilled: null } });
    prismaMock.tx.$queryRaw.mockResolvedValue([]);
  });

  const tokenFor = (sub: string, role: UserRole) => app.jwt.sign({ sub, role });

  const putStaff = (payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/orders/o1/room-assignment',
      headers: { authorization: `Bearer ${tokenFor('u-STAFF', UserRole.STAFF)}` },
      payload,
    });

  it('拆单配对键（splitPairKey）resave 后原样保留——不因编辑器重构对象而丢失', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 0.5,
            splitPairKey: 'pair-abc',
          },
        ],
      },
    });
    // 编辑器重存：整个对象重新构造，不带 splitPairKey（这正是 finding 9 描述的存量 bug 触发点）
    const res = await putStaff({
      roomGroups: [
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'], roomFraction: 0.5 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    expect(written.roomGroups[0].splitPairKey).toBe('pair-abc');
  });

  it('带 sharedRoomId 的房组只改 notes → 放行，sharedRoomId 原样保留', async () => {
    // orderItemId 归属校验（本单的酒店/套餐行）与 reconcile 是两道独立闸——这里过归属闸。
    prismaMock.orderItem.count.mockResolvedValue(1);
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 0,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
            notes: '旧备注',
          },
        ],
      },
    });
    const res = await putStaff({
      roomGroups: [
        {
          id: 'g1',
          hotelName: '椰岛大酒店',
          roomType: '双床',
          passengerIds: ['p1'],
          roomFraction: 0,
          orderItemId: 'item1',
          notes: '新备注',
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    expect(written.roomGroups[0]).toMatchObject({ sharedRoomId: 'sr1', notes: '新备注', roomFraction: 0 });
  });

  /**
   * astra B4：代理拿到的外部 DTO（room-group-dto.ts 的 ExternalRoomGroup）本就不含
   * orderItemId / hotelName，前端保存一次「只改备注」的编辑时这些字段很可能干脆不出现在
   * payload 里——不是显式传了不一样的值。旧实现把「省略」等同于「显式改成别的值」，锁定
   * 组一有归属/酒店名就会被误判成「被改动」，代理连改个备注都做不到。
   */
  it('astra B4：AGENT 只带 id + passengerIds + notes（省略 orderItemId/hotelName/roomType/roomFraction）保存共享组 → 200 且只改备注', async () => {
    prismaMock.agent.findUnique.mockResolvedValue({ id: 'ag-1', isActive: true });
    serviceMocks.getOrder.mockResolvedValue({ id: 'o1' });
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 0.5,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
            notes: '旧备注',
          },
        ],
      },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/orders/o1/room-assignment',
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: 'u-AGENT', role: UserRole.AGENT })}` },
      // 外部 DTO（ExternalRoomGroup）本就没有 orderItemId / hotelName；这里连 roomType /
      // roomFraction 也一并省略，只有 schema 硬性要求的 id + passengerIds，外加要改的 notes。
      payload: { roomGroups: [{ id: 'g1', passengerIds: ['p1'], notes: '代理改的备注' }] },
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    // 锁定组的其它字段一律沿用锁后现状（old），只有 notes 按请求更新——省略不代表被清空
    // 或被拒绝，也不会让 hotelName/roomType/orderItemId/roomFraction 变成 undefined。
    expect(written.roomGroups[0]).toMatchObject({
      sharedRoomId: 'sr1',
      hotelName: '椰岛大酒店',
      roomType: '双床',
      orderItemId: 'item1',
      roomFraction: 0.5,
      notes: '代理改的备注',
    });
  });

  it('带 sharedRoomId 的房组改乘客 → 400，不落库', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 1,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
          },
        ],
      },
    });
    const res = await putStaff({
      roomGroups: [
        {
          id: 'g1',
          hotelName: '椰岛大酒店',
          roomType: '双床',
          passengerIds: ['p1', 'p2'],
          roomFraction: 1,
          orderItemId: 'item1',
        },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('直接删除带 sharedRoomId 的房组（新 payload 里整组消失）→ 400，不落库', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            roomFraction: 1,
            orderItemId: 'item1',
            sharedRoomId: 'sr1',
          },
        ],
      },
    });
    const res = await putStaff({ roomGroups: [] });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('普通（非共享）房组 roomFraction=0 → 400', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null });
    const res = await putStaff({
      roomGroups: [
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'], roomFraction: 0 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  /**
   * 房型在分房编辑器里是选填字段（RoomingEditor.tsx 输入框写着「选填」），存量大量
   * roomGroups 的 roomType 就是空串。普通组的硬校验只该拒「没传这个字段」（undefined），
   * 不该把「传了空串」也当成缺失一起拒了——否则日常保存分房会整批 400。
   */
  it('普通房组 roomType 传空串 → 200，不是 400', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null });
    const res = await putStaff({
      roomGroups: [{ id: 'g1', hotelName: '椰岛大酒店', roomType: '', passengerIds: ['p1'] }],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    expect(written.roomGroups[0]).toMatchObject({ hotelName: '椰岛大酒店', roomType: '' });
  });

  /**
   * M1：reconcile 前没有房组 id 去重时，同一 id 重复出现会被按旧组命中两次、原样各 push
   * 一份进 finalGroups——物理份额（按 sharedRoomId 去重）仍是 1 间，但 roomsByItem 按
   * orderItemId 累加 roomFraction，该行 roomsBilled 就从 1 翻成 2。改成在 reconcile 之前
   * 就拒绝重复 id，不落库。
   */
  it('重复提交同一房组 id → 400，不落库，roomsBilled 不会翻倍', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null });
    const res = await putStaff({
      roomGroups: [
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'] },
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'] },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  it('同一乘客出现在多个房组 → 400，不落库', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null });
    const res = await putStaff({
      roomGroups: [
        { id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'] },
        { id: 'g2', hotelName: '椰岛大酒店', roomType: '大床', passengerIds: ['p1'] },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(prismaMock.tx.order.update).not.toHaveBeenCalled();
  });

  /**
   * astra A5③：普通组本不该是 0 份额，除非它就是解绑后留下的「与他单合住时计费 0 间」那条
   * （§八：解绑后 0 份额那张单钱不动）。服务端锁后现状（old）里这条组的 roomFraction 恰好
   * 也是 0 时，必须放行原样重存——不能一律拒绝，否则运营连改个备注都会被拦。放行时以
   * old 的字段为准（只接受 notes 补丁），客户端顺手夹带的归属/乘客/房型改动被忽略，不生效。
   */
  it('普通房组锁后现状就是 0 份额（解绑留下的）→ 放行原样重存，客户端夹带的其它字段改动被忽略', async () => {
    prismaMock.orderItem.count.mockResolvedValue(1); // orderItemId 归属校验通过
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g1',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            orderItemId: 'item1',
            roomFraction: 0,
          },
        ],
      },
    });
    const res = await putStaff({
      roomGroups: [
        {
          id: 'g1',
          hotelName: '换了个名字的酒店', // 客户端试图顺手改字段——应被忽略
          roomType: '换了房型',
          passengerIds: ['p1', 'p2'],
          orderItemId: 'item1',
          roomFraction: 0,
          notes: '新备注',
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    // 归属/乘客/房型/酒店名沿用锁后现状（old），只有 notes 按请求更新。
    expect(written.roomGroups[0]).toMatchObject({
      hotelName: '椰岛大酒店',
      roomType: '双床',
      passengerIds: ['p1'],
      orderItemId: 'item1',
      roomFraction: 0,
      notes: '新备注',
    });
    // roomsBilled 显式落库为 0（不是 null，也不是被跳过不写）。
    const itemUpdateCalls = prismaMock.tx.orderItem.update.mock.calls;
    const item1Call = itemUpdateCalls.find((c) => c[0].where.id === 'item1');
    expect(item1Call).toBeDefined();
    expect(item1Call![0].data.roomsBilled).toBe(0);
  });

  /**
   * astra A5①：旧实现先把本单所有酒店行的 roomsBilled 清成 null、再跳过 Σ<=0 的行不回写——
   * 一条行这次不再被任何房组引用（乘客/份额搬去挂在另一条行），本该显式写 0，旧实现却让它
   * 停在 null（重新激活别处的 metadata 兜底）。这里造一个「行的房组本次被整体搬空」的场景。
   */
  it('一条酒店行本次不再被任何房组引用 → roomsBilled 显式写 0，不是 null（astra A5①）', async () => {
    prismaMock.orderItem.count.mockResolvedValue(1); // 新房组归属 item2 的校验
    prismaMock.tx.order.findUnique.mockResolvedValue({
      roomAssignment: {
        roomGroups: [
          {
            id: 'g-old',
            hotelName: '椰岛大酒店',
            roomType: '双床',
            passengerIds: ['p1'],
            orderItemId: 'item1',
            roomFraction: 1,
          },
        ],
      },
    });
    // 新 payload 完全不提 g-old / item1——乘客被整体搬到 item2 的新房组去了。
    const res = await putStaff({
      roomGroups: [
        {
          id: 'g-new',
          hotelName: '椰岛大酒店',
          roomType: '双床',
          passengerIds: ['p1'],
          orderItemId: 'item2',
          roomFraction: 1,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const itemUpdateCalls = prismaMock.tx.orderItem.update.mock.calls;
    const item1Call = itemUpdateCalls.find((c) => c[0].where.id === 'item1');
    expect(item1Call).toBeDefined();
    expect(item1Call![0].data.roomsBilled).toBe(0); // 显式 0，不是 null、也不是被跳过
    const item2Call = itemUpdateCalls.find((c) => c[0].where.id === 'item2');
    expect(item2Call).toBeDefined();
    expect(item2Call![0].data.roomsBilled).toBe(1);
    // 旧的「先 updateMany 清空全部行为 null」调用已被移除——不再无差别清空整单酒店行。
    expect(prismaMock.tx.orderItem.updateMany).not.toHaveBeenCalled();
  });

  /**
   * astra A11：本单在两家酒店各有一条行，§五闸逐酒店调用 assertHotelFitAfterChange 时，
   * H1 的 nextOrderItems 曾经被塞进整单（含 H2 那条行）的快照——H2 的房组也被算进 H1 的
   * 前瞻，凭空多占一间。这里造一个只有 H1 纳管（block=1 间）、H2 不纳管的场景：只改 H1
   * 自己那条行的分房（1 间），旧 bug 会把 H2 的 1 间也算进 H1（合计 2 间 > block 1 间）→ 400；
   * 修复后 H1 前瞻只看自己的行（1 间 = block 1 间）→ 200。
   */
  it('本单跨两家酒店：H1 的前瞻不再把 H2 的行算进去（astra A11）', async () => {
    const CHECK_IN = new Date('2026-06-01T00:00:00.000Z');
    const CHECK_OUT = new Date('2026-06-02T00:00:00.000Z');
    prismaMock.orderItem.count.mockResolvedValue(2); // itemA + itemB 归属校验通过
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null }); // 本单原先未分房

    prismaMock.tx.orderItem.findMany.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const where = args.where ?? {};
      if (where.orderId === 'o1') {
        // §五闸的「本单在各酒店变更后的占房快照」源查询：本单在 H1、H2 各一条酒店行。
        return [
          {
            id: 'itemA',
            hotelCheckIn: CHECK_IN,
            hotelCheckOut: CHECK_OUT,
            metadata: null,
            hotelRoomType: { hotelId: 'H1' },
          },
          {
            id: 'itemB',
            hotelCheckIn: CHECK_IN,
            hotelCheckOut: CHECK_OUT,
            metadata: null,
            hotelRoomType: { hotelId: 'H2' },
          },
        ];
      }
      // assertHotelFitAfterChange 内部的 liveItems 查询，按 hotelRoomType.hotelId 区分酒店。
      const hotelId = (where.hotelRoomType as { hotelId?: string } | undefined)?.hotelId;
      if (hotelId === 'H1') {
        return [
          {
            id: 'itemA',
            hotelCheckIn: CHECK_IN,
            hotelCheckOut: CHECK_OUT,
            roomsBilled: null,
            metadata: null,
            hotelRoomType: { hotel: { name: 'H1 酒店' } },
            order: { id: 'o1', roomAssignment: null, passengers: [] },
          },
        ];
      }
      if (hotelId === 'H2') {
        return [
          {
            id: 'itemB',
            hotelCheckIn: CHECK_IN,
            hotelCheckOut: CHECK_OUT,
            roomsBilled: null,
            metadata: null,
            hotelRoomType: { hotel: { name: 'H2 酒店' } },
            order: { id: 'o1', roomAssignment: null, passengers: [] },
          },
        ];
      }
      return [];
    });
    prismaMock.tx.hotelBlockPeriod.findMany.mockImplementation(
      async (args: { where?: Record<string, unknown> }) => {
        if (args.where?.hotelId === 'H1') {
          return [{ dateFrom: CHECK_IN, dateTo: CHECK_OUT, rooms: 1 }]; // H1 纳管，只有 1 间
        }
        return []; // H2 未纳管——不该拦，也不该被算进 H1
      },
    );

    const res = await putStaff({
      roomGroups: [
        { id: 'gA', hotelName: 'H1 酒店', roomType: '标间', passengerIds: ['p1'], orderItemId: 'itemA' },
        { id: 'gB', hotelName: 'H2 酒店', roomType: '标间', passengerIds: ['p2'], orderItemId: 'itemB' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(prismaMock.tx.order.update).toHaveBeenCalled();
  });

  /**
   * 审计 after 必须与实际落库的 roomAssignment 同源（与 before 对称），不能记客户端发来的
   * 原始 body——普通房组分支同样可能让二者不同：客户端可以夹带一个未声明的多余字段
   * （zod 已剥离），或者（更典型地）多个普通组一起提交时，写库顺序/去重后的房组数组
   * 形状本就和 body.roomGroups 不是同一个对象引用。用「reconcile 后写库的那份」与
   * writeAudit 收到的 after.roomAssignment 做同一性断言，锁死这条同源关系。
   */
  it('审计 after.roomAssignment 记 reconcile 后落库的 finalGroups，不是客户端原始 body', async () => {
    prismaMock.tx.order.findUnique.mockResolvedValue({ roomAssignment: null });
    const res = await putStaff({
      roomGroups: [{ id: 'g1', hotelName: '椰岛大酒店', roomType: '双床', passengerIds: ['p1'] }],
    });
    expect(res.statusCode).toBe(200);
    const written = prismaMock.tx.order.update.mock.calls[0][0].data.roomAssignment;
    const auditCall = (writeAudit as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'UPDATE_ROOM_ASSIGNMENT',
    );
    expect(auditCall).toBeDefined();
    const after = (auditCall![0] as { after: { roomAssignment: unknown } }).after;
    expect(after.roomAssignment).toEqual(written);
  });
});
