/**
 * POST /orders/:id/reschedule-passengers · 路由级单测（astra B 路 finding B5 遗漏①）
 *
 * 服务层编排契约（拆单 → 改期）已在 orders.reschedule-passengers.test.ts 覆盖；这里只测
 * 路由这一层「把 service 返回值拼成响应体」的契约——共享房解绑产生的 warnings 原本只
 * 留在 audit.reschedule.warnings 里，前端改期成功后只读顶层 warnings（同换酒店/酒店改期
 * 入口口径一致），必须由路由层提到顶层，否则运营永远看不到「该房组原与他单合住」提示。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMocks = vi.hoisted(() => ({
  reschedulePassengers: vi.fn(),
  reschedulePassengersAsAgent: vi.fn(),
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

const SHARED_WARNING = '该房组原与 FTM-partner 合住、计费 0 间，解绑后物理占 1 间，金额未重算。';

function rescheduleResult(warnings: string[]) {
  return {
    order: { id: 'o1', orderNumber: 'FTM-1' },
    newOrder: null,
    splitPerformed: false,
    audit: {
      orderNumber: 'FTM-1',
      newOrderId: null,
      newOrderNumber: null,
      passengerCount: 1,
      leg: 'OUTBOUND',
      orderItemId: 'item-1',
      toScheduleId: 'schedule-new',
      feeCny: 0,
      splitReplayed: false,
      rescheduleSkipped: false,
      reschedule: {
        orderNumber: 'FTM-1',
        orderItemId: 'item-1',
        fromScheduleId: 'schedule-old',
        fromCabin: 'ECONOMY',
        fromDeparture: null,
        toScheduleId: 'schedule-new',
        toCabin: 'ECONOMY',
        toDeparture: null,
        feeCny: 0,
        statusChanged: false,
        hotelDateSync: [],
        warnings,
      },
      split: null,
    },
  };
}

describe('POST /orders/:id/reschedule-passengers · 顶层 warnings（astra B 路 B5 遗漏①）', () => {
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
  });

  const tokenFor = (sub: string, role: UserRole) => app.jwt.sign({ sub, role });

  const body = {
    passengerIds: ['p1'],
    orderItemId: 'item-1',
    newScheduleId: 'schedule-new',
    requestToken: '00000000-0000-4000-8000-000000000001',
  };

  const post = (role: UserRole) =>
    app.inject({
      method: 'POST',
      url: '/orders/o1/reschedule-passengers',
      headers: { authorization: `Bearer ${tokenFor(`u-${role}`, role)}` },
      payload: body,
    });

  it('共享房解绑警告从 audit.reschedule.warnings 被提到响应顶层 warnings', async () => {
    serviceMocks.reschedulePassengers.mockResolvedValue(rescheduleResult([SHARED_WARNING]));

    const res = await post(UserRole.STAFF);

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.warnings).toEqual([SHARED_WARNING]);
    // audit 里原样保留（路由不是把它搬走，是复制一份到顶层）。
    expect(json.audit.reschedule.warnings).toEqual([SHARED_WARNING]);
  });

  it('没有共享房解绑发生时，顶层 warnings 是空数组（不是 undefined）', async () => {
    serviceMocks.reschedulePassengers.mockResolvedValue(rescheduleResult([]));

    const res = await post(UserRole.STAFF);

    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual([]);
  });
});
