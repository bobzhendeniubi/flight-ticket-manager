/**
 * 代理对账单 · 单测（vitest，mock Prisma）
 *
 * 钉死四件事，每一件都是「错了会赔钱或泄密」的：
 *   1. RBAC —— 代理拿别家 agentId 请求必须 403；自己和下级放行。不区分 404/403，
 *      否则可以拿状态码差异探测别家代理 id 是否存在。
 *   2. 脱敏 —— 导出列集合与 AGENT_HIDDEN_EXPORT_KEYS 零交集（无成本、无证件、无内部风控）。
 *      这条是防日后加列时手滑把成本夹带出岛，比任何注释都管用。
 *   3. 合计 —— 合计行逐列等于明细之和；每人结算价 × 人数 = 应收。
 *   4. 归月 —— 按**出发日**归月而不是下单日；上月出发的单不能混进本月。
 * 外加预存款段的恒等式：期初 + 本月充值 − 本月抵扣 = 期末。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetDescendantAgentIds } = vi.hoisted(() => ({
  mockPrisma: {},
  mockGetDescendantAgentIds: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/agent-tree.js', () => ({ getDescendantAgentIds: mockGetDescendantAgentIds }));

import type { PrismaClient } from '@prisma/client';
import { UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { buildAgentStatement, resolveStatementScope } from './agent-statements.service.js';
import { buildAgentStatementWorkbook, STATEMENT_COLUMNS } from './agent-statements.export.js';
import { AGENT_HIDDEN_EXPORT_KEYS } from '../orders/orders.export-templates.js';

const SUBJECT = 'agent-subject';
const CHILD = 'agent-child';
const STRANGER = 'agent-stranger';

/** 一段越南当地 09:00 起飞的航段（UTC 02:00 + tz）。 */
function leg(departureTimeIso: string) {
  return {
    flightSchedule: { departureTime: new Date(departureTimeIso), departureTz: 'Asia/Ho_Chi_Minh' },
    hotelCheckIn: null,
    visaIntendedDate: null,
  };
}

interface OrderFixtureInput {
  id: string;
  orderNumber: string;
  agentId: string;
  total: number;
  paidAmount: number;
  adjustmentCny?: number;
  paxIds: string[];
  departureTimeIso: string;
  createdAtIso?: string;
  /** 立减快照行金额（负数，与真实数据一致）；undefined = 没有立减 */
  discountAmount?: number;
  discountRevoked?: boolean;
  /** 按乘客调价：passengerId → 净额 */
  perPaxAdjust?: Record<string, number>;
}

function orderFixture(input: OrderFixtureInput) {
  const items: Array<Record<string, unknown>> = [
    {
      id: `${input.id}-flight`,
      kind: 'FLIGHT',
      amount: input.total,
      description: '机票',
      passengerId: null,
      metadata: null,
      bundle: null,
      ...leg(input.departureTimeIso),
    },
  ];
  if (input.discountAmount !== undefined) {
    items.push({
      id: `${input.id}-discount`,
      kind: 'FEE',
      amount: input.discountAmount,
      description: '立减',
      passengerId: null,
      metadata: {
        settlementDiscount: true,
        ...(input.discountRevoked ? { settlementDiscountRevoked: true } : {}),
      },
      bundle: null,
      flightSchedule: null,
      hotelCheckIn: null,
      visaIntendedDate: null,
    });
  }
  for (const [pid, net] of Object.entries(input.perPaxAdjust ?? {})) {
    items.push({
      id: `${input.id}-adj-${pid}`,
      kind: 'FEE',
      amount: net,
      description: '按乘客调价',
      passengerId: pid,
      metadata: { priceAdjustment: true },
      bundle: null,
      flightSchedule: null,
      hotelCheckIn: null,
      visaIntendedDate: null,
    });
  }
  return {
    id: input.id,
    orderNumber: input.orderNumber,
    agentId: input.agentId,
    status: 'PAID',
    total: input.total,
    paidAmount: input.paidAmount,
    prepaymentOffset: 0,
    adjustmentCny: input.adjustmentCny ?? 0,
    adjustments: [],
    createdAt: new Date(input.createdAtIso ?? '2026-08-03T02:00:00.000Z'),
    passengers: input.paxIds.map((id) => ({ id })),
    refunds: [],
    items,
  };
}

/** 极简 Prisma 替身：只实现本模块用到的四张表的读方法。 */
function makeClient(opts: {
  orders: ReturnType<typeof orderFixture>[];
  commissions?: Array<{
    orderId: string;
    agentId: string;
    amount: number;
    status: string;
    settlementId: string | null;
  }>;
  prepaymentTxs?: Array<{ amount: number; balanceAfter: number; createdAt: Date }>;
  prepaymentBefore?: { balanceAfter: number } | null;
}) {
  const txs = opts.prepaymentTxs ?? [];
  return {
    agent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        companyName: `公司-${where.id}`,
        contactName: `联系人-${where.id}`,
        tier: 1,
      })),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, companyName: `公司-${id}`, contactName: `联系人-${id}` })),
      ),
    },
    order: { findMany: vi.fn(async () => opts.orders) },
    commissionRecord: { findMany: vi.fn(async () => opts.commissions ?? []) },
    prepaymentTransaction: {
      findMany: vi.fn(async () => txs),
      findFirst: vi.fn(async () => opts.prepaymentBefore ?? null),
    },
  } as unknown as PrismaClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 主体 + 一个下级；陌生代理不在树里。
  mockGetDescendantAgentIds.mockImplementation(async (id: string) =>
    id === SUBJECT ? [SUBJECT, CHILD] : [id],
  );
});

// ═══════════════════════════════════════════════════════════════════════════
describe('resolveStatementScope · RBAC', () => {
  it('代理取别家代理的对账单 → 403（不是 404，避免用状态码探测代理是否存在）', async () => {
    const client = makeClient({ orders: [] });
    await expect(
      resolveStatementScope(
        STRANGER,
        { userId: 'u1', role: UserRole.AGENT, agentId: SUBJECT },
        client,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    // 越权在查库之前就被拦下：连「这个 id 存不存在」都没去问。
    expect(client.agent.findUnique as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('代理取自己 / 取自己的下级 → 放行', async () => {
    const client = makeClient({ orders: [] });
    const requester = { userId: 'u1', role: UserRole.AGENT, agentId: SUBJECT };
    await expect(resolveStatementScope(SUBJECT, requester, client)).resolves.toEqual([
      SUBJECT,
      CHILD,
    ]);
    await expect(resolveStatementScope(CHILD, requester, client)).resolves.toEqual([CHILD]);
  });

  it('未绑定代理的 AGENT 账号 → 403', async () => {
    const client = makeClient({ orders: [] });
    await expect(
      resolveStatementScope(SUBJECT, { userId: 'u1', role: UserRole.AGENT }, client),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('散客 → 403；内部岗位 → 任意代理放行', async () => {
    const client = makeClient({ orders: [] });
    await expect(
      resolveStatementScope(SUBJECT, { userId: 'u1', role: UserRole.CUSTOMER }, client),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      resolveStatementScope(STRANGER, { userId: 'u2', role: UserRole.STAFF }, client),
    ).resolves.toBeDefined();
    await expect(
      resolveStatementScope(STRANGER, { userId: 'u3', role: UserRole.ADMIN }, client),
    ).resolves.toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('buildAgentStatement · 归月与合计', () => {
  it('按出发日归月：上月出发的单不进本月对账单（哪怕是本月下的单）', async () => {
    const client = makeClient({
      orders: [
        orderFixture({
          id: 'o1',
          orderNumber: 'FTM-A1',
          agentId: SUBJECT,
          total: 3000,
          paidAmount: 3000,
          paxIds: ['p1'],
          departureTimeIso: '2026-09-12T02:00:00.000Z',
        }),
        orderFixture({
          id: 'o2',
          orderNumber: 'FTM-A2',
          agentId: SUBJECT,
          total: 5000,
          paidAmount: 0,
          paxIds: ['p2'],
          // 8 月出发、9 月才下的单 —— 按出发日归月就该落在 8 月，不进 9 月的表。
          departureTimeIso: '2026-08-28T02:00:00.000Z',
          createdAtIso: '2026-09-01T02:00:00.000Z',
        }),
      ],
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT, CHILD] },
      client,
    );
    expect(s.rows.map((r) => r.orderNumber)).toEqual(['FTM-A1']);
    expect(s.totals.orderCount).toBe(1);
  });

  it('合计逐列等于明细之和；余额 = 应收 − 已收，负数（多付）不钳零', async () => {
    const client = makeClient({
      orders: [
        orderFixture({
          id: 'o1',
          orderNumber: 'FTM-A1',
          agentId: SUBJECT,
          total: 3000,
          paidAmount: 1000,
          adjustmentCny: 200, // 售后费也是应收
          paxIds: ['p1', 'p2'],
          departureTimeIso: '2026-09-12T02:00:00.000Z',
          discountAmount: -150,
        }),
        orderFixture({
          id: 'o2',
          orderNumber: 'FTM-B1',
          agentId: CHILD,
          total: 1000,
          paidAmount: 1200, // 多付 200
          paxIds: ['p3'],
          departureTimeIso: '2026-09-20T02:00:00.000Z',
        }),
      ],
      commissions: [
        { orderId: 'o1', agentId: SUBJECT, amount: 90, status: 'ACCRUED', settlementId: null },
        // 下级自己赚 50，上级从这单拿 20 的分成
        { orderId: 'o2', agentId: CHILD, amount: 50, status: 'ACCRUED', settlementId: null },
        { orderId: 'o2', agentId: SUBJECT, amount: 20, status: 'ACCRUED', settlementId: null },
      ],
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT, CHILD] },
      client,
    );

    const a = s.rows.find((r) => r.orderNumber === 'FTM-A1')!;
    const b = s.rows.find((r) => r.orderNumber === 'FTM-B1')!;
    expect(a.payableCny).toBe(3200);
    expect(a.receivedCny).toBe(1000);
    expect(a.balanceCny).toBe(2200);
    expect(a.settlementDiscountCny).toBe(150);
    expect(a.ownedBySubject).toBe(true);
    // 多付照实为负，不钳零 —— 钳了这 200 就在表上凭空消失。
    expect(b.balanceCny).toBe(-200);
    expect(b.ownedBySubject).toBe(false);
    expect(b.ownerAgentLabel).toBe(`公司-${CHILD}`);

    // 佣金两列：归属代理自己的 vs 主体拿到的分成
    expect(a.commissionOwnerCny).toBe(90);
    expect(a.commissionSubjectCny).toBe(90);
    expect(b.commissionOwnerCny).toBe(50);
    expect(b.commissionSubjectCny).toBe(20);

    expect(s.totals.orderCount).toBe(2);
    expect(s.totals.paxCount).toBe(3);
    expect(s.totals.payableCny).toBe(a.payableCny + b.payableCny);
    expect(s.totals.receivedCny).toBe(a.receivedCny + b.receivedCny);
    expect(s.totals.balanceCny).toBe(a.balanceCny + b.balanceCny);
    expect(s.totals.settlementDiscountCny).toBe(150);
    expect(s.totals.commissionOwnerCny).toBe(140);
    expect(s.totals.commissionSubjectCny).toBe(110);
  });

  it('每人结算价 × 人数 = 应收；逐人价不同时给出区间', async () => {
    const client = makeClient({
      orders: [
        orderFixture({
          id: 'o1',
          orderNumber: 'FTM-SAME',
          agentId: SUBJECT,
          total: 6000,
          paidAmount: 0,
          paxIds: ['p1', 'p2'],
          departureTimeIso: '2026-09-12T02:00:00.000Z',
        }),
        orderFixture({
          id: 'o2',
          orderNumber: 'FTM-DIFF',
          agentId: SUBJECT,
          total: 6000,
          paidAmount: 0,
          paxIds: ['p3', 'p4'],
          departureTimeIso: '2026-09-13T02:00:00.000Z',
          // p3 补收 400、p4 优惠 400 → 两人份额 3400 / 2600
          perPaxAdjust: { p3: 400, p4: -400 },
        }),
      ],
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT, CHILD] },
      client,
    );
    const same = s.rows.find((r) => r.orderNumber === 'FTM-SAME')!;
    const diff = s.rows.find((r) => r.orderNumber === 'FTM-DIFF')!;
    expect(same.settlementPerPaxCny * same.paxCount).toBe(same.payableCny);
    // 逐人一致 → 区间列留空，不用一句废话占位
    expect(same.settlementPerPaxRange).toBe('');
    // 逐人不同 → 人均仍是应收 ÷ 人数，另给真实区间
    expect(diff.settlementPerPaxCny * diff.paxCount).toBe(diff.payableCny);
    expect(diff.settlementPerPaxRange).toBe('2,600.00 ~ 3,400.00');
  });

  it('已撤销的立减行不计入立减合计', async () => {
    const client = makeClient({
      orders: [
        orderFixture({
          id: 'o1',
          orderNumber: 'FTM-A1',
          agentId: SUBJECT,
          total: 3000,
          paidAmount: 0,
          paxIds: ['p1'],
          departureTimeIso: '2026-09-12T02:00:00.000Z',
          discountAmount: -150,
          discountRevoked: true,
        }),
      ],
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT] },
      client,
    );
    expect(s.rows[0].settlementDiscountCny).toBe(0);
  });

  it('佣金净额：同期翻状态的正数 REVERSED 不重复冲销，未并单的负数补偿记录要扣', async () => {
    const client = makeClient({
      orders: [
        orderFixture({
          id: 'o1',
          orderNumber: 'FTM-A1',
          agentId: SUBJECT,
          total: 3000,
          paidAmount: 0,
          paxIds: ['p1'],
          departureTimeIso: '2026-09-12T02:00:00.000Z',
        }),
      ],
      commissions: [
        { orderId: 'o1', agentId: SUBJECT, amount: 100, status: 'ACCRUED', settlementId: null },
        // 同期被翻状态的原记录（正数）：已因 status≠ACCRUED 被排除，绝不能再减一次
        { orderId: 'o1', agentId: SUBJECT, amount: 80, status: 'REVERSED', settlementId: null },
        // 跨期负数补偿记录：真正的追回，要扣
        { orderId: 'o1', agentId: SUBJECT, amount: -30, status: 'REVERSED', settlementId: null },
        // 已并入结算单的负数记录：上一期已经追过了，本期不再重复扣
        { orderId: 'o1', agentId: SUBJECT, amount: -25, status: 'REVERSED', settlementId: 'stl-1' },
      ],
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT] },
      client,
    );
    expect(s.rows[0].commissionSubjectCny).toBe(70);
  });

  it('月份格式非法 → 400', async () => {
    const client = makeClient({ orders: [] });
    await expect(
      buildAgentStatement({ agentId: SUBJECT, month: '2026-13', scopeAgentIds: [SUBJECT] }, client),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('buildAgentStatement · 预存款段', () => {
  it('期初 + 本月充值 − 本月抵扣 = 期末', async () => {
    const client = makeClient({
      orders: [],
      prepaymentTxs: [
        { amount: 5000, balanceAfter: 7000, createdAt: new Date('2026-09-02T02:00:00.000Z') },
        { amount: -1200, balanceAfter: 5800, createdAt: new Date('2026-09-10T02:00:00.000Z') },
        { amount: 300, balanceAfter: 6100, createdAt: new Date('2026-09-18T02:00:00.000Z') },
      ],
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT] },
      client,
    );
    const p = s.prepayment;
    expect(p.openingCny).toBe(2000); // 7000 − 5000，用本月第一笔反推
    expect(p.topUpCny).toBe(5300);
    expect(p.offsetCny).toBe(1200);
    expect(p.closingCny).toBe(6100);
    expect(p.openingCny + p.topUpCny - p.offsetCny).toBe(p.closingCny);
  });

  it('本月无流水 → 期初=期末=上一笔余额，进出都是 0', async () => {
    const client = makeClient({
      orders: [],
      prepaymentTxs: [],
      prepaymentBefore: { balanceAfter: 4200 },
    });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT] },
      client,
    );
    expect(s.prepayment).toEqual({
      openingCny: 4200,
      topUpCny: 0,
      offsetCny: 0,
      closingCny: 4200,
    });
  });

  it('从没充过值 → 四项全 0', async () => {
    const client = makeClient({ orders: [], prepaymentTxs: [], prepaymentBefore: null });
    const s = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT] },
      client,
    );
    expect(s.prepayment).toEqual({ openingCny: 0, topUpCny: 0, offsetCny: 0, closingCny: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('对账单导出 · 脱敏与表体', () => {
  it('列集合与代理脱敏黑名单零交集（无成本、无证件、无内部风控列）', () => {
    for (const col of STATEMENT_COLUMNS) {
      expect(
        AGENT_HIDDEN_EXPORT_KEYS.has(col.key),
        `列「${col.header}」(${col.key}) 命中代理脱敏黑名单，不能出现在对账单里`,
      ).toBe(false);
    }
    // 正向再钉一遍最容易手滑加回来的几个
    const keys = new Set<string>(STATEMENT_COLUMNS.map((c) => c.key));
    for (const forbidden of [
      'orderCost',
      'costAmount',
      'passportNumber',
      'documentNumber',
      'legStatus',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('xlsx：抬头印口径注脚、末行是合计、预存款单独一张表', async () => {
    const client = makeClient({
      orders: [
        orderFixture({
          id: 'o1',
          orderNumber: 'FTM-A1',
          agentId: SUBJECT,
          total: 3000,
          paidAmount: 1000,
          paxIds: ['p1'],
          departureTimeIso: '2026-09-12T02:00:00.000Z',
        }),
      ],
      prepaymentTxs: [
        { amount: 1000, balanceAfter: 1000, createdAt: new Date('2026-09-02T02:00:00.000Z') },
      ],
    });
    const statement = await buildAgentStatement(
      { agentId: SUBJECT, month: '2026-09', scopeAgentIds: [SUBJECT] },
      client,
    );
    const buf = await buildAgentStatementWorkbook(statement);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

    const ws = wb.getWorksheet('2026-09 对账单')!;
    expect(String(ws.getCell('A3').value)).toContain('以出发日归月');
    expect(String(ws.getCell('A3').value)).toContain('月结口径以财务确认为准');
    // 抬头 3 行 + 列头 1 行 → 第 4 行第 1 列 = 订单号
    expect(ws.getRow(4).getCell(1).value).toBe('订单号');
    // 最后一行是合计行，金额列等于 totals
    const last = ws.getRow(ws.rowCount);
    expect(last.getCell(1).value).toBe('合计');
    const payableIdx = STATEMENT_COLUMNS.findIndex((c) => c.key === 'payableCny') + 1;
    expect(last.getCell(payableIdx).value).toBe(statement.totals.payableCny);

    const ws2 = wb.getWorksheet('预存款')!;
    expect(ws2.getRow(2).getCell(1).value).toBe('期初余额');
    expect(ws2.getRow(5).getCell(1).value).toBe('期末余额');
    expect(ws2.getRow(5).getCell(2).value).toBe(statement.prepayment.closingCny);
  });
});
