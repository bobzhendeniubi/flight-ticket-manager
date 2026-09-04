/**
 * 代理自助改单 · 路由级单测（鉴权、通道分流、审计留痕）
 *
 * 服务层口径见 orders.agent-self-edit.test.ts；这里只管路由这一层：
 *   1. POST /orders/:id/correct-flight —— 客户 403；代理/运营可达；审计 CORRECT_ORDER_FLIGHT
 *      带 correction:true + 差价 0 + 当地出发日。
 *   2. PATCH /orders/:id/notes —— 代理只能改 visaStatus 这一个内部字段，且 HAS_VISA 一律 403
 *      （已签证由签证岗确认）；带别的内部字段仍旧 403；运营路径一字未变。
 *   3. 换酒店 / 升舱 —— 代理放行到 service（窗口闸在那里判），客户仍旧 403。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole, VisaRequirement } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
  order: { findUnique: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  getOrder: vi.fn(),
  correctFlightSchedule: vi.fn(),
  assertAgentSelfEditAllowed: vi.fn(),
  setOrderVisaStatus: vi.fn(),
  swapItemHotel: vi.fn(),
  upgradeOrderItemCabin: vi.fn(),
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
import { ForbiddenError } from '../../lib/errors.js';

describe('代理自助改单路由', () => {
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
    serviceMocks.getOrder.mockResolvedValue({ id: 'o1' });
  });

  const tokenFor = (sub: string, role: UserRole) => app.jwt.sign({ sub, role });

  const call = (method: 'POST' | 'PATCH', url: string, role: UserRole, payload: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokenFor(`u-${role}`, role)}` },
      payload: payload as Record<string, unknown>,
    });

  // ── 1. 航班纠错端点 ────────────────────────────────────────────────────
  describe('POST /orders/:id/correct-flight', () => {
    const body = { itemId: 'i1', newScheduleId: 's2' };

    it('客户打不开纠错端点 → 403，不触服务', async () => {
      const res = await call('POST', '/orders/o1/correct-flight', UserRole.CUSTOMER, body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: '仅运营 / 代理可纠正航班' });
      expect(serviceMocks.correctFlightSchedule).not.toHaveBeenCalled();
    });

    it('代理纠错 → 带 agentId 进服务，回包 { order }，审计记纠错口径', async () => {
      serviceMocks.correctFlightSchedule.mockResolvedValue({
        order: { id: 'o1' },
        audit: {
          orderNumber: 'FTM-1',
          orderItemId: 'i1',
          fromScheduleId: 's1',
          toScheduleId: 's2',
          fromDepartureLocal: '2026-10-01',
          toDepartureLocal: '2026-10-02',
          hotelDateSync: [],
        },
      });
      const res = await call('POST', '/orders/o1/correct-flight', UserRole.AGENT, body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ order: { id: 'o1' } });
      expect(serviceMocks.correctFlightSchedule).toHaveBeenCalledWith(
        'o1',
        'i1',
        's2',
        { userId: 'u-AGENT', role: UserRole.AGENT, agentId: 'ag-1' },
        // allowTicketed 未传 → schema 缺省 false（服务端还会按角色再判一次，代理传了也不认）。
        { allowTicketed: false },
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CORRECT_ORDER_FLIGHT',
          targetType: 'ORDER',
          targetId: 'o1',
          severity: 'WARNING',
          before: { orderItemId: 'i1', scheduleId: 's1', departureDate: '2026-10-01' },
          after: expect.objectContaining({
            scheduleId: 's2',
            departureDate: '2026-10-02',
            correction: true,
            feeCny: 0,
            selfService: true,
          }),
        }),
      );
    });

    it('窗口已关（服务抛 403）→ 原样把理由回给界面', async () => {
      serviceMocks.correctFlightSchedule.mockRejectedValue(
        new ForbiddenError('下单当天可自助修改，次日起请提交改单申请'),
      );
      const res = await call('POST', '/orders/o1/correct-flight', UserRole.AGENT, body);
      expect(res.statusCode).toBe(403);
      // 领域错误由 error-handler 统一包成 { error: { code, message } }
      expect(res.json().error.message).toBe('下单当天可自助修改，次日起请提交改单申请');
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('运营也能单单纠错（此前只有批量入口）', async () => {
      serviceMocks.correctFlightSchedule.mockResolvedValue({
        order: { id: 'o1' },
        audit: {
          orderNumber: 'FTM-1',
          orderItemId: 'i1',
          fromScheduleId: 's1',
          toScheduleId: 's2',
          fromDepartureLocal: null,
          toDepartureLocal: null,
          hotelDateSync: [],
        },
      });
      const res = await call('POST', '/orders/o1/correct-flight', UserRole.STAFF, body);
      expect(res.statusCode).toBe(200);
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.objectContaining({ selfService: false }),
        }),
      );
    });
  });

  // ── 2. 订单级签证状态（notes 端点）─────────────────────────────────────
  describe('PATCH /orders/:id/notes · 签证状态', () => {
    const beforeRow = {
      orderNumber: 'FTM-1',
      notes: null,
      internalNotes: null,
      visaStatus: null,
      noteHotel: null,
      noteVisa: null,
      notePayment: null,
      noteSpecial: null,
      status: 'PAID',
      deletedAt: null,
      passengers: [{ visaExempt: false }],
    };

    beforeEach(() => {
      prismaMock.order.findUnique.mockResolvedValue(beforeRow);
      prismaMock.order.update.mockResolvedValue({});
      serviceMocks.setOrderVisaStatus.mockResolvedValue({
        order: { id: 'o1' },
        changed: true,
        before: null,
        after: VisaRequirement.NEEDED,
      });
      serviceMocks.assertAgentSelfEditAllowed.mockResolvedValue(undefined);
    });

    it.each([VisaRequirement.NEEDED, VisaRequirement.E_VISA, VisaRequirement.NOT_NEEDED])(
      '代理改成 %s → 过自助窗口闸后写入',
      async (visaStatus) => {
        const res = await call('PATCH', '/orders/o1/notes', UserRole.AGENT, { visaStatus });
        expect(res.statusCode).toBe(200);
        expect(serviceMocks.assertAgentSelfEditAllowed).toHaveBeenCalledWith('o1', {
          userId: 'u-AGENT',
          role: UserRole.AGENT,
          agentId: 'ag-1',
        });
        expect(serviceMocks.setOrderVisaStatus).toHaveBeenCalledWith(
          'o1',
          visaStatus,
          { userId: 'u-AGENT', role: UserRole.AGENT, agentId: 'ag-1' },
          // 本端点只回 { ok: true } → 不必回读整单；本次没带备注 → 只写签证状态。
          { withOrder: false },
        );
      },
    );

    it('代理标「已签证」→ 403，签证岗专属，不触窗口闸也不写库', async () => {
      const res = await call('PATCH', '/orders/o1/notes', UserRole.AGENT, {
        visaStatus: VisaRequirement.HAS_VISA,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: '已签证状态由签证岗确认，代理不可自行设置' });
      expect(serviceMocks.assertAgentSelfEditAllowed).not.toHaveBeenCalled();
      expect(serviceMocks.setOrderVisaStatus).not.toHaveBeenCalled();
    });

    it('代理顺手夹带内部备注 → 仍旧 403（自助口子只开了 visaStatus 一个字段）', async () => {
      const res = await call('PATCH', '/orders/o1/notes', UserRole.AGENT, {
        visaStatus: VisaRequirement.NEEDED,
        internalNotes: '偷偷写一句',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: '仅运营/管理员可修改内部备注 / 签证状态 / 结构化备注',
      });
      expect(serviceMocks.setOrderVisaStatus).not.toHaveBeenCalled();
    });

    it('代理只改客户备注 → 照旧放行，不碰签证通道', async () => {
      const res = await call('PATCH', '/orders/o1/notes', UserRole.AGENT, { notes: '客人要靠窗' });
      expect(res.statusCode).toBe(200);
      expect(serviceMocks.assertAgentSelfEditAllowed).not.toHaveBeenCalled();
      expect(serviceMocks.setOrderVisaStatus).not.toHaveBeenCalled();
      expect(prismaMock.order.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { notes: '客人要靠窗' },
      });
    });

    // M2：签证状态与备注四栏是一次提交 → 必须一起进 setOrderVisaStatus 的那一个事务，
    // 不能再分成「service 写签证状态 + 路由另写一条 update」两笔（中间失败会写半拉）。
    it('运营同时改签证状态与备注 → 备注随签证状态进同一个事务，路由不再单独写库', async () => {
      const res = await call('PATCH', '/orders/o1/notes', UserRole.STAFF, {
        visaStatus: VisaRequirement.NEEDED,
        internalNotes: '运营口径',
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMocks.assertAgentSelfEditAllowed).not.toHaveBeenCalled();
      expect(serviceMocks.setOrderVisaStatus).toHaveBeenCalledTimes(1);
      expect(serviceMocks.setOrderVisaStatus).toHaveBeenCalledWith(
        'o1',
        VisaRequirement.NEEDED,
        { userId: 'u-STAFF', role: UserRole.STAFF, agentId: undefined },
        { withOrder: false, noteData: { internalNotes: '运营口径' } },
      );
      expect(prismaMock.order.update).not.toHaveBeenCalled();
    });

    it('客户改签证状态 → 403（口径未变）', async () => {
      const res = await call('PATCH', '/orders/o1/notes', UserRole.CUSTOMER, {
        visaStatus: VisaRequirement.NEEDED,
      });
      expect(res.statusCode).toBe(403);
      expect(serviceMocks.setOrderVisaStatus).not.toHaveBeenCalled();
    });
  });

  // ── 3. 换酒店 / 升舱：代理放行到 service，客户仍旧 403 ────────────────────
  describe('换酒店 / 升舱的角色闸', () => {
    it('客户换酒店 → 403（文案未变）', async () => {
      const res = await call('PATCH', '/orders/o1/items/i1/hotel', UserRole.CUSTOMER, {
        newHotelRoomTypeId: 'rt-new',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: '仅运营/管理员可换酒店' });
      expect(serviceMocks.swapItemHotel).not.toHaveBeenCalled();
    });

    it('代理换酒店 → 放行进 service（窗口闸在服务层），审计标 selfService', async () => {
      serviceMocks.swapItemHotel.mockResolvedValue({
        order: { id: 'o1' },
        audit: {
          orderNumber: 'FTM-1',
          orderItemId: 'i1',
          before: {},
          after: {},
          feeCny: 0,
          untrackedNights: [],
          starMismatchOverride: null,
        },
      });
      const res = await call('PATCH', '/orders/o1/items/i1/hotel', UserRole.AGENT, {
        newHotelRoomTypeId: 'rt-new',
        feeCny: 500,
      });
      expect(res.statusCode).toBe(200);
      expect(serviceMocks.swapItemHotel).toHaveBeenCalledWith(
        'o1',
        'i1',
        expect.objectContaining({ newHotelRoomTypeId: 'rt-new' }),
        { userId: 'u-AGENT', role: UserRole.AGENT, agentId: 'ag-1' },
      );
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SWAP_ORDER_ITEM_HOTEL',
          // 生效差价取服务端返回值：自助通道恒 0，请求里那 500 不作数
          after: expect.objectContaining({ feeCny: 0, selfService: true }),
        }),
      );
    });

    it('客户升舱 → 403（文案未变）', async () => {
      const res = await call('POST', '/orders/o1/items/i1/upgrade-cabin', UserRole.CUSTOMER, {});
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: '仅运营/管理员可升舱' });
      expect(serviceMocks.upgradeOrderItemCabin).not.toHaveBeenCalled();
    });

    it('代理升舱 → 放行进 service，审计标 selfService', async () => {
      serviceMocks.upgradeOrderItemCabin.mockResolvedValue({
        order: { id: 'o1' },
        audit: {
          orderNumber: 'FTM-1',
          orderItemId: 'i1',
          upgradeItemId: 'up1',
          scheduleId: 's1',
          fromCabin: 'ECONOMY',
          toCabin: 'BUSINESS',
          quantity: 2,
          upgradeCnyPerLeg: 700,
          diffCny: 1400,
          subtotalBefore: 1000,
          subtotalAfter: 2400,
        },
      });
      const res = await call('POST', '/orders/o1/items/i1/upgrade-cabin', UserRole.AGENT, {});
      expect(res.statusCode).toBe(200);
      expect(serviceMocks.upgradeOrderItemCabin).toHaveBeenCalledWith('o1', 'i1', {}, {
        userId: 'u-AGENT',
        role: UserRole.AGENT,
        agentId: 'ag-1',
      });
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPGRADE_CABIN_ITEM',
          after: expect.objectContaining({ selfService: true }),
        }),
      );
    });
  });
});
