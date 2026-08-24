/**
 * GET /orders/:id/pnr-export · 出行人脱敏回归测试（vitest）
 *
 * 本路由是 authenticate-only（ADMIN/STAFF/AGENT 均可下载），是少数代理够得到的导出口。
 * 曾经的破口：路由拿到 service.getOrder（已脱敏）之后，又另起一行
 *   prisma.passenger.findMany({ where: { orderId: id } })
 * 裸查乘客全字段喂给 buildPnrWorkbook —— 绕开了 serializeOrder 的脱敏，
 * 代理对自己树内的订单能导出到未脱敏的乘客行（含 passportPhotoUrl 护照大图）。
 *
 * 这里不 mock OrderService —— 走真实的 getOrder（真实 RBAC + 真实 serializeOrder），
 * 只 mock prisma 与 buildPnrWorkbook，断言「真正喂给工作簿的乘客行」按角色脱敏：
 *   · AGENT → 不含 passportPhotoUrl，只留 hasPassportPhoto 布尔
 *   · ADMIN → 保留大图（后台护照缩略图依赖同一口径）
 * 并断言路由不再裸查 passenger 表（prisma.passenger.findMany 一次都不该被调用）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma, UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }) },
  agent: { findUnique: vi.fn() },
  order: { findUnique: vi.fn() },
  visa: { findMany: vi.fn() },
  passenger: { findMany: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  // assertCanView 对 AGENT 会走递归 CTE 查「自己 + 后代代理 id」（getDescendantAgentIds），
  // 返回 Array<{ id }>；给单节点代理树即可让本代理看到自己名下的订单。
  $queryRaw: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const buildPnrWorkbookMock = vi.hoisted(() => vi.fn());
vi.mock('./pnr-export.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pnr-export.js')>();
  return { ...actual, buildPnrWorkbook: buildPnrWorkbookMock };
});

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderRoutes } from './orders.routes.js';

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

const AGENT_ID = 'agent_1';
const AGENT_USER_ID = 'user_agent_1';
const SYNTHETIC_PHOTO = 'data:image/jpeg;base64,SYNTHETIC_PHOTO_PAYLOAD';

/** 一条「护照大图齐全」的乘客原始行——脱敏与否，差异全在 passportPhotoUrl 上。 */
function rawPassenger() {
  return {
    id: 'p1',
    orderId: 'ord_1',
    fullName: 'CHEN/HAOLIANG',
    lastName: null,
    firstName: null,
    title: null,
    gender: 'M',
    documentType: 'PASSPORT',
    documentNumber: 'E00000000',
    dateOfBirth: new Date('1995-10-24T00:00:00.000Z'),
    nationality: 'CN',
    passengerType: 'ADULT',
    // 护照大图：内部字段，对外角色必须剥离
    passportPhotoUrl: SYNTHETIC_PHOTO,
  };
}

/** getOrder 的 prisma.order.findUnique 返回值（归属该代理，保证 assertCanView 放行）。 */
function rawOrder() {
  return {
    id: 'ord_1',
    orderNumber: 'CO-PNR-1',
    status: 'PAID',
    agentId: AGENT_ID,
    userId: 'user_customer_1',
    subtotal: dec(1000),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(1000),
    paidAmount: dec(1000),
    prepaymentOffset: dec(0),
    adjustmentCny: 0,
    items: [],
    passengers: [rawPassenger()],
    payments: [],
    refunds: [],
    statusEvents: [],
    reminders: [],
    agent: null,
    user: null,
    claimedBy: null,
  };
}

describe('GET /orders/:id/pnr-export · 出行人按角色脱敏', () => {
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
    // AGENT 的 authenticate 会查 Agent.isActive；buildRequester 再查一次拿 agentId。
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true, id: AGENT_ID });
    prismaMock.order.findUnique.mockResolvedValue(rawOrder());
    prismaMock.visa.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([{ id: AGENT_ID }]);
    // 关键：裸查按真实 DB 行为返回「带护照大图的原始行」。这样一旦有人把裸查加回来，
    // 用例是因为**真的读到了大图**而红，而不是因为 mock 没配好返回 undefined 而红。
    prismaMock.passenger.findMany.mockResolvedValue([rawPassenger()]);
    buildPnrWorkbookMock.mockResolvedValue(Buffer.from('xlsx'));
  });

  function hitPnrExport(sub: string, role: UserRole) {
    const token = app.jwt.sign({ sub, role });
    return app.inject({
      method: 'GET',
      url: '/orders/ord_1/pnr-export',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** 取本次真正喂给 buildPnrWorkbook 的乘客行。 */
  function passengersHandedToWorkbook(): Array<Record<string, unknown>> {
    expect(buildPnrWorkbookMock).toHaveBeenCalledTimes(1);
    return buildPnrWorkbookMock.mock.calls[0][0].passengers;
  }

  it('AGENT → 喂给工作簿的乘客行不含 passportPhotoUrl（只留 hasPassportPhoto 布尔）', async () => {
    const res = await hitPnrExport(AGENT_USER_ID, UserRole.AGENT);
    expect(res.statusCode).toBe(200);

    const [passenger] = passengersHandedToWorkbook();
    expect(passenger).not.toHaveProperty('passportPhotoUrl');
    expect(passenger.hasPassportPhoto).toBe(true);
    // 出票必需的文本字段仍在（脱敏不该把 PNR 列打空）
    expect(passenger.fullName).toBe('CHEN/HAOLIANG');
    expect(passenger.documentNumber).toBe('E00000000');
  });

  it('AGENT → 路由不再裸查 passenger 表（乘客只能来自已脱敏的 getOrder）', async () => {
    const res = await hitPnrExport(AGENT_USER_ID, UserRole.AGENT);
    expect(res.statusCode).toBe(200);
    expect(prismaMock.passenger.findMany).not.toHaveBeenCalled();
  });

  it('ADMIN → 保留护照大图（后台口径不受本次收敛影响）', async () => {
    const res = await hitPnrExport('user_admin_1', UserRole.ADMIN);
    expect(res.statusCode).toBe(200);

    const [passenger] = passengersHandedToWorkbook();
    expect(passenger.passportPhotoUrl).toBe(SYNTHETIC_PHOTO);
    expect(passenger.hasPassportPhoto).toBe(true);
  });
});
