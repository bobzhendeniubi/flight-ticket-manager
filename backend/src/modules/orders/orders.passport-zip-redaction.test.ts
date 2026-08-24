/**
 * GET /orders/:id/passport-photos.zip · 角色闸 + 出行人脱敏回归测试（vitest）
 *
 * 这个包的正身就是**护照原图**：passport-zip.ts 逐乘客 fetchPhoto(p.passportPhotoUrl)
 * 把大图写进 zip。曾经的破口有两层，本文件各钉一枚：
 *   1. 路由只挂了 authenticate（AGENT/CUSTOMER 也够得到），而同性质的批量导出
 *      /orders/visa-passports.zip 是 ADMIN/STAFF only —— 同一份资料两道不同的门。
 *   2. 路由拿到 service.getOrder（已按角色脱敏）之后，又另起一行
 *        prisma.passenger.findMany({ where: { orderId: id } })
 *      裸查乘客全字段喂给 buildPassportPhotoZip —— 绕开 serializeOrder 的
 *      includePassportPhotos = (ADMIN || STAFF) 口径（与 pnr-export 曾犯的是同一个错）。
 *
 * 这里不 mock OrderService —— 走真实的 getOrder（真实 RBAC + 真实 serializeOrder），
 * 只 mock prisma 与 buildPassportPhotoZip，断言：
 *   · AGENT / CUSTOMER → 403，一个字节的护照图都拿不到
 *   · ADMIN / STAFF    → 200，且真正喂给 zip 的乘客行带大图（签证岗要靠它送签）
 *   · 任何角色下路由都不裸查 passenger 表（数据源只能是已脱敏的 getOrder）
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
  $queryRaw: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const buildPassportPhotoZipMock = vi.hoisted(() => vi.fn());
vi.mock('./passport-zip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./passport-zip.js')>();
  return { ...actual, buildPassportPhotoZip: buildPassportPhotoZipMock };
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
const CUSTOMER_USER_ID = 'user_customer_1';
const SYNTHETIC_PHOTO = 'data:image/jpeg;base64,SYNTHETIC_PHOTO_PAYLOAD';

/** 一条「护照大图齐全」的乘客原始行——脱敏与否，差异全在 passportPhotoUrl 上。 */
function rawPassenger() {
  return {
    id: 'p1',
    orderId: 'ord_1',
    fullName: 'CHEN/HAOLIANG',
    lastName: 'CHEN',
    firstName: 'HAOLIANG',
    title: null,
    gender: 'M',
    documentType: 'PASSPORT',
    documentNumber: 'E00000000',
    dateOfBirth: new Date('1995-10-24T00:00:00.000Z'),
    nationality: 'CN',
    passengerType: 'ADULT',
    visaExempt: false,
    passportPhotoUrl: SYNTHETIC_PHOTO,
  };
}

/** getOrder 的 prisma.order.findUnique 返回值（同时归属该代理与该客户，两种角色都能过 assertCanView）。 */
function rawOrder() {
  return {
    id: 'ord_1',
    orderNumber: 'CO-ZIP-1',
    status: 'PAID',
    agentId: AGENT_ID,
    userId: CUSTOMER_USER_ID,
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

describe('GET /orders/:id/passport-photos.zip · 角色闸与出行人脱敏', () => {
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
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true, id: AGENT_ID });
    prismaMock.order.findUnique.mockResolvedValue(rawOrder());
    prismaMock.visa.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([{ id: AGENT_ID }]);
    // 关键：裸查按真实 DB 行为返回「带护照大图的原始行」。这样一旦有人把裸查加回来，
    // 用例是因为**真的读到了大图**而红，而不是因为 mock 没配好返回 undefined 而红。
    prismaMock.passenger.findMany.mockResolvedValue([rawPassenger()]);
    buildPassportPhotoZipMock.mockResolvedValue(Buffer.from('zip'));
  });

  function hitZip(sub: string, role: UserRole) {
    const token = app.jwt.sign({ sub, role });
    return app.inject({
      method: 'GET',
      url: '/orders/ord_1/passport-photos.zip',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** 取本次真正喂给 buildPassportPhotoZip 的乘客行。 */
  function passengersHandedToZip(): Array<Record<string, unknown>> {
    expect(buildPassportPhotoZipMock).toHaveBeenCalledTimes(1);
    return buildPassportPhotoZipMock.mock.calls[0][0].passengers;
  }

  it('AGENT → 403，且根本不去构建 zip（代理拿不到整单护照原图包）', async () => {
    const res = await hitZip(AGENT_USER_ID, UserRole.AGENT);
    expect(res.statusCode).toBe(403);
    expect(buildPassportPhotoZipMock).not.toHaveBeenCalled();
    expect(prismaMock.passenger.findMany).not.toHaveBeenCalled();
  });

  it('CUSTOMER → 403（哪怕是自己的订单，护照原图包也只在内部岗位流转）', async () => {
    const res = await hitZip(CUSTOMER_USER_ID, UserRole.CUSTOMER);
    expect(res.statusCode).toBe(403);
    expect(buildPassportPhotoZipMock).not.toHaveBeenCalled();
  });

  it('STAFF → 200，喂给 zip 的乘客行保留护照大图（签证岗送签依赖它）', async () => {
    const res = await hitZip('user_staff_1', UserRole.STAFF);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');

    const [passenger] = passengersHandedToZip();
    expect(passenger.passportPhotoUrl).toBe(SYNTHETIC_PHOTO);
    expect(passenger.documentNumber).toBe('E00000000');
  });

  it('ADMIN → 200，且路由不裸查 passenger 表（乘客只能来自已脱敏的 getOrder）', async () => {
    const res = await hitZip('user_admin_1', UserRole.ADMIN);
    expect(res.statusCode).toBe(200);
    expect(prismaMock.passenger.findMany).not.toHaveBeenCalled();
    // 大图仍在（ADMIN/STAFF 的 includePassportPhotos 口径不受本次收敛影响）
    expect(passengersHandedToZip()[0].passportPhotoUrl).toBe(SYNTHETIC_PHOTO);
  });

  it('订单无出行人 → 400 友好提示，不生成只有空表的 zip', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ ...rawOrder(), passengers: [] });
    const res = await hitZip('user_admin_1', UserRole.ADMIN);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('该订单暂无出行人信息，无法生成出行人资料表');
    expect(buildPassportPhotoZipMock).not.toHaveBeenCalled();
  });
});
