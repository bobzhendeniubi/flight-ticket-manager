/**
 * POST /receipts/match/suggest · 端点 + 查询层单测（fastify inject，fake prisma）。
 *
 * 覆盖：权限（ADMIN/STAFF 放行、AGENT 403）、入参校验（sinceDays 越界 400）、
 * 流水取数口径（缺省只取未认完的流水导入/运营水单；给 receiptIds 则按 id 且去重）、
 * 订单取数口径（资金闸黑名单状态排除、软删排除、下单时间窗、游标分页拉全）、
 * 尾款在代码里算（含调整费 / 预存抵扣 / 已收齐单不参与）、部分认款流水按未认余额匹配、
 * 响应序列化（金额分→元、订单摘要随建议回、summary 计数、组合 parts）。
 * 断言不写库：prisma 只有 findMany 被调用。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  OrderStatus,
  PaymentMethod,
  Prisma,
  ReceiptSource,
  ReceiptStatus,
  UserRole,
} from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: { isActive: true },
    }),
  },
  receipt: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  order: { findMany: vi.fn(), update: vi.fn() },
  receiptAllocation: { create: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
  $transaction: vi.fn(),
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const writeAuditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn(),
  writeAudit: writeAuditMock,
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { receiptRoutes } from './receipts.routes.js';

const T0 = new Date('2026-09-01T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function receiptRow(over: {
  id: string;
  amountCny: number;
  allocatedCny?: number;
  payerNote?: string | null;
  orderHintId?: string | null;
  status?: ReceiptStatus;
  source?: ReceiptSource;
  receivedAt?: Date;
}) {
  return {
    id: over.id,
    receiptNo: `RCP20260901${over.id.toUpperCase().padStart(12, '0')}`,
    amountCny: new Prisma.Decimal(over.amountCny),
    allocatedCny: new Prisma.Decimal(over.allocatedCny ?? 0),
    status: over.status ?? (over.allocatedCny ? ReceiptStatus.PARTIALLY_ALLOCATED : ReceiptStatus.OPEN),
    method: PaymentMethod.WECHAT_PAY,
    source: over.source ?? ReceiptSource.STATEMENT_IMPORT,
    payerNote: over.payerNote ?? null,
    externalTxnId: `TXN-${over.id}`,
    orderHintId: over.orderHintId ?? null,
    receivedAt: over.receivedAt ?? T0,
  };
}

function orderRow(over: {
  id: string;
  total: number;
  paidAmount?: number;
  prepaymentOffset?: number;
  adjustmentCny?: number;
  contactName?: string;
  contactPhone?: string;
  agent?: { id: string; companyName: string | null; contactName: string; contactPhone: string } | null;
  passengers?: Array<{ fullName: string; chineseName: string | null }>;
  createdAt?: Date;
}) {
  return {
    id: over.id,
    orderNumber: `FTM20260901${over.id.toUpperCase().padStart(5, '0')}`,
    contactName: over.contactName ?? '联系人',
    contactPhone: over.contactPhone ?? '13800000000',
    status: OrderStatus.PENDING_PAYMENT,
    createdAt: over.createdAt ?? new Date(T0.getTime() - DAY),
    total: new Prisma.Decimal(over.total),
    paidAmount: new Prisma.Decimal(over.paidAmount ?? 0),
    prepaymentOffset: new Prisma.Decimal(over.prepaymentOffset ?? 0),
    adjustmentCny: over.adjustmentCny ?? 0,
    agentId: over.agent?.id ?? null,
    agent: over.agent ?? null,
    passengers: over.passengers ?? [],
    items: [],
  };
}

describe('POST /receipts/match/suggest', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(receiptRoutes, { prefix: '/receipts' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole: null,
      agentProfile: { isActive: true },
    });
    prismaMock.receipt.findMany.mockResolvedValue([]);
    prismaMock.order.findMany.mockResolvedValue([]);
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function post(body: unknown, role: UserRole = UserRole.ADMIN) {
    return app.inject({
      method: 'POST',
      url: '/receipts/match/suggest',
      headers: { authorization: `Bearer ${tokenFor(`u-${role}`, role)}` },
      payload: body,
    });
  }

  it('AGENT → 403，且不打库', async () => {
    const res = await post({}, UserRole.AGENT);
    expect(res.statusCode).toBe(403);
    expect(prismaMock.receipt.findMany).not.toHaveBeenCalled();
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it('sinceDays 越界 → 400', async () => {
    expect((await post({ sinceDays: 0 })).statusCode).toBe(400);
    expect((await post({ sinceDays: 400 })).statusCode).toBe(400);
    expect((await post({ sinceDays: 1.5 })).statusCode).toBe(400);
    expect(prismaMock.receipt.findMany).not.toHaveBeenCalled();
  });

  it('缺省：只取未认完的流水导入 / 运营水单登记；订单按资金闸黑名单 + 软删 + 近 90 天取', async () => {
    const before = Date.now();
    const res = await post({});
    expect(res.statusCode).toBe(200);

    const receiptArgs = prismaMock.receipt.findMany.mock.calls[0][0];
    expect(receiptArgs.where.status).toEqual({
      in: [ReceiptStatus.OPEN, ReceiptStatus.PARTIALLY_ALLOCATED],
    });
    expect(receiptArgs.where.source).toEqual({
      in: [ReceiptSource.STATEMENT_IMPORT, ReceiptSource.OPS_CLAIM],
    });
    expect(receiptArgs.where.id).toBeUndefined();
    expect(receiptArgs.take).toBe(1000);

    const orderArgs = prismaMock.order.findMany.mock.calls[0][0];
    expect(orderArgs.where.deletedAt).toBeNull();
    expect(orderArgs.where.status.notIn).toEqual(
      expect.arrayContaining([
        OrderStatus.CANCELLED,
        OrderStatus.REFUNDED,
        OrderStatus.PAYMENT_TIMEOUT,
        OrderStatus.DRAFT,
        OrderStatus.REFUND_REQUESTED,
      ]),
    );
    const since = orderArgs.where.createdAt.gte as Date;
    expect(Math.abs(before - 90 * DAY - since.getTime())).toBeLessThan(5_000);
    // 不再只回近 400 单：按 id 游标分页，首页无 cursor
    expect(orderArgs.take).toBe(500);
    expect(orderArgs.cursor).toBeUndefined();

    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      scanned: { receipts: 0, orders: 0, unpaidOrders: 0, sinceDays: 90 },
      summary: { receiptsWithCandidates: 0, high: 0, medium: 0, low: 0, combos: 0 },
      receipts: [],
      combos: [],
    });
  });

  it('给 receiptIds：按 id 取（去重），不再限来源；sinceDays 可覆盖', async () => {
    const res = await post({ receiptIds: ['r1', 'r2', 'r1'], sinceDays: 30 });
    expect(res.statusCode).toBe(200);
    const receiptArgs = prismaMock.receipt.findMany.mock.calls[0][0];
    expect(receiptArgs.where.id).toEqual({ in: ['r1', 'r2'] });
    expect(receiptArgs.where.source).toBeUndefined();
    expect(receiptArgs.where.status).toEqual({
      in: [ReceiptStatus.OPEN, ReceiptStatus.PARTIALLY_ALLOCATED],
    });
    const orderArgs = prismaMock.order.findMany.mock.calls[0][0];
    const since = orderArgs.where.createdAt.gte as Date;
    expect(Math.abs(Date.now() - 30 * DAY - since.getTime())).toBeLessThan(5_000);
    expect(res.json().scanned.sinceDays).toBe(30);
  });

  it('空数组 receiptIds 视同缺省', async () => {
    await post({ receiptIds: [] });
    const receiptArgs = prismaMock.receipt.findMany.mock.calls[0][0];
    expect(receiptArgs.where.id).toBeUndefined();
    expect(receiptArgs.where.source).toBeDefined();
  });

  it('订单分页：首页满 500 条则带游标继续拉，直到不满一页', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) =>
      orderRow({ id: `p1-${String(i).padStart(3, '0')}`, total: 1 }),
    );
    const page2 = [orderRow({ id: 'p2-000', total: 1 })];
    prismaMock.order.findMany.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    const res = await post({});
    expect(res.statusCode).toBe(200);
    expect(prismaMock.order.findMany).toHaveBeenCalledTimes(2);
    const second = prismaMock.order.findMany.mock.calls[1][0];
    expect(second.cursor).toEqual({ id: 'p1-499' });
    expect(second.skip).toBe(1);
    expect(res.json().scanned.orders).toBe(501);
  });

  it('HIGH 建议：金额精确 + 备注含联系人 + 双向唯一；响应带订单摘要与元口径金额', async () => {
    prismaMock.receipt.findMany.mockResolvedValue([
      receiptRow({ id: 'r1', amountCny: 1810, payerNote: '张三 尾款' }),
    ]);
    prismaMock.order.findMany.mockResolvedValue([
      orderRow({ id: 'o1', total: 3840, paidAmount: 2030, contactName: '张三' }),
      orderRow({ id: 'o2', total: 1810, contactName: '李四' }),
    ]);

    const res = await post({});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scanned).toMatchObject({ receipts: 1, orders: 2, unpaidOrders: 2 });
    expect(body.summary).toMatchObject({ receiptsWithCandidates: 1, high: 1, medium: 0, low: 0 });
    expect(body.receipts).toHaveLength(1);
    const r = body.receipts[0];
    expect(r).toMatchObject({
      receiptId: 'r1',
      externalTxnId: 'TXN-r1',
      payerNote: '张三 尾款',
      remainingCny: '1810.00',
    });
    expect(r.candidates[0]).toMatchObject({
      orderId: 'o1',
      orderNumber: 'FTM20260901000O1',
      contactName: '张三',
      agentName: null,
      totalPayable: 3840,
      paidAmount: 2030,
      balanceDue: 1810,
      suggestedAmountCny: 1810,
      confidence: 'HIGH',
    });
    expect(r.candidates[0].reasons).toEqual(
      expect.arrayContaining(['AMOUNT_EXACT', 'REMARK_HAS_PASSENGER_NAME']),
    );
    // 同额但无身份的 o2 也在候选里，但已被降到 LOW
    expect(r.candidates[1]).toMatchObject({ orderId: 'o2', confidence: 'LOW' });
  });

  it('尾款 = total + 调整费 − 已付 − 预存抵扣；已收齐的单不参与匹配', async () => {
    prismaMock.receipt.findMany.mockResolvedValue([
      receiptRow({ id: 'r1', amountCny: 1000, payerNote: 'FTM20260901000O1' }),
    ]);
    prismaMock.order.findMany.mockResolvedValue([
      // 3000 + 200 调整 − 1500 已付 − 700 预存 = 1000
      orderRow({ id: 'o1', total: 3000, adjustmentCny: 200, paidAmount: 1500, prepaymentOffset: 700 }),
      // 已收齐
      orderRow({ id: 'o2', total: 1000, paidAmount: 1000 }),
    ]);
    const body = (await post({})).json();
    expect(body.scanned.unpaidOrders).toBe(1);
    expect(body.receipts[0].candidates).toHaveLength(1);
    expect(body.receipts[0].candidates[0]).toMatchObject({
      orderId: 'o1',
      totalPayable: 3200,
      balanceDue: 1000,
      confidence: 'HIGH',
    });
    expect(body.receipts[0].candidates[0].reasons).toContain('REMARK_HAS_ORDER_NO');
  });

  it('部分认款的流水按未认余额匹配，remainingCny 回未认余额', async () => {
    prismaMock.receipt.findMany.mockResolvedValue([
      receiptRow({ id: 'r1', amountCny: 5000, allocatedCny: 4456, payerNote: '王五' }),
    ]);
    prismaMock.order.findMany.mockResolvedValue([
      orderRow({ id: 'o1', total: 544, contactName: '王五' }),
    ]);
    const body = (await post({})).json();
    expect(body.receipts[0].remainingCny).toBe('544.00');
    expect(body.receipts[0].candidates[0]).toMatchObject({
      orderId: 'o1',
      suggestedAmountCny: 544,
      confidence: 'HIGH',
    });
  });

  it('代理名 / 乘客中文名也进引擎；组合建议带逐条 parts（元口径）', async () => {
    prismaMock.receipt.findMany.mockResolvedValue([
      receiptRow({ id: 'r1', amountCny: 300, payerNote: '阳光旅行社' }),
      receiptRow({ id: 'r2', amountCny: 700, payerNote: '阳光旅行社', receivedAt: new Date(T0.getTime() + 3600_000) }),
    ]);
    const agent = { id: 'a1', companyName: '阳光国际旅行社有限公司', contactName: '周经理', contactPhone: '13900001111' };
    prismaMock.order.findMany.mockResolvedValue([
      orderRow({
        id: 'o1',
        total: 1000,
        agent,
        passengers: [{ fullName: 'ZHAO/LIU', chineseName: '赵六' }],
      }),
    ]);
    const body = (await post({})).json();
    const combo = body.combos.find((c: { type: string }) => c.type === 'MANY_RECEIPTS_ONE_ORDER');
    expect(combo).toMatchObject({ confidence: 'MEDIUM', totalCny: 1000 });
    expect(combo.reasons).toEqual(expect.arrayContaining(['AMOUNT_SUM_EXACT', 'SAME_AGENT', 'PAYER_MATCHES_AGENT']));
    expect(combo.parts).toEqual([
      expect.objectContaining({ receiptId: 'r1', orderId: 'o1', amountCny: 300, orderNumber: 'FTM20260901000O1', agentName: '阳光国际旅行社有限公司' }),
      expect.objectContaining({ receiptId: 'r2', orderId: 'o1', amountCny: 700 }),
    ]);
    expect(body.summary.combos).toBeGreaterThanOrEqual(1);
  });

  it('只读：不写任何表、不写审计', async () => {
    prismaMock.receipt.findMany.mockResolvedValue([
      receiptRow({ id: 'r1', amountCny: 100, payerNote: '张三' }),
    ]);
    prismaMock.order.findMany.mockResolvedValue([orderRow({ id: 'o1', total: 100, contactName: '张三' })]);
    await post({});
    expect(prismaMock.receipt.create).not.toHaveBeenCalled();
    expect(prismaMock.receipt.update).not.toHaveBeenCalled();
    expect(prismaMock.order.update).not.toHaveBeenCalled();
    expect(prismaMock.receiptAllocation.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
