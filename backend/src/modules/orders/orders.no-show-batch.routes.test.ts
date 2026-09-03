/**
 * 按航班批量 no-show · **路由层**（HTTP + zod）用例
 *
 * 为什么非要走 app.inject：批量的入参是在**路由的 zod 那一层**收的，直接调编排函数
 * 永远测不到「前端发过来的这个 body 到底收不收」。名单曾经就是这么漏的 ——
 * 前端把 names 发成字符串数组、后端只收字符串，界面上贴好了名单，后端一条 400。
 *
 * 覆盖：
 *   1. names 两种形状（整块字符串 / 字符串数组）都收，数组按换行拼回同一份文本；
 *   2. 空名单 / 非运营角色 → 400 / 403；
 *   3. releaseReturn 原样传到预检（预检与执行同口径）；
 *   4. POST /orders/no-show/batch：单次上限 50 张，超出 400；整批审计挂 FLIGHT + 班次 id；
 *   5. GET /orders/no-show/report：区间可不传（缺省近 30 天），跨度超上限 400。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }),
  },
  agent: { findUnique: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

vi.mock('./orders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders.service.js')>();
  return { ...actual, OrderService: vi.fn().mockImplementation(() => ({})) };
});

const { previewBatchMock, executeBatchMock } = vi.hoisted(() => ({
  previewBatchMock: vi.fn(),
  executeBatchMock: vi.fn(),
}));
vi.mock('./no-show-batch.js', () => ({
  previewNoShowBatch: previewBatchMock,
  executeNoShowBatch: executeBatchMock,
}));

const { loadReportMock } = vi.hoisted(() => ({ loadReportMock: vi.fn() }));
vi.mock('./no-show-report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./no-show-report.js')>();
  return { ...actual, loadNoShowReport: loadReportMock };
});

vi.mock('../../lib/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/audit.js')>();
  return { ...actual, writeAudit: vi.fn().mockResolvedValue(undefined) };
});

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderRoutes } from './orders.routes.js';
import { writeAudit } from '../../lib/audit.js';

const BATCH_TOKEN = 'b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

const EMPTY_PREVIEW = {
  schedule: {
    id: 'sch-out',
    flightNumber: 'QH9589',
    departDate: '2026-09-02',
    departTimeLocal: '08:30',
    departed: true,
    seatsSold: 12,
  },
  matched: [],
  unmatched: [],
  ambiguous: [],
  totalLines: 0,
  truncated: false,
  processedLines: 0,
};

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
  // AGENT 角色的 authenticate 会额外查 Agent.isActive；本组不测停用场景，默认给活跃代理，
  // 免得 401 掩盖了要测的 403。
  prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
  previewBatchMock.mockResolvedValue(EMPTY_PREVIEW);
  executeBatchMock.mockResolvedValue({
    results: [
      {
        orderId: 'ord-1',
        orderNumber: 'FTM20260902-001',
        ok: true,
        releasedSeats: 2,
        replayed: false,
      },
    ],
    summary: { ok: 1, failed: 0, releasedSeats: 2, replayedCount: 0 },
  });
  loadReportMock.mockResolvedValue({ rows: [], totals: {}, details: [] });
});

/**
 * 可读短名 → 25 位 cuid 形状的假 id。
 * 路由 schema 对 scheduleId / orderId / passengerIds 加了主键形状闸（20–32 位小写字母数字），
 * 「sch-out」这种可读短名会被 400 挡在门外 —— 用它把短名补成合法形状，测试仍然读得懂。
 */
// 补位用 'z' 而不是 '0'：用 '0' 会让 ord1 与 ord10 补成同一串，批量体的「同一张单只能出现一次」
// 会把整批判成重复 → 400，而问题其实出在夹具。
const id = (label: string): string => label.replace(/[^a-z0-9]/g, '').padEnd(25, 'z');
const SCH_OUT = id('schout');

function tokenFor(sub: string, role: UserRole): string {
  return app.jwt.sign({ sub, role });
}

function post(url: string, token: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

// ── POST /orders/no-show/batch-preview ──────────────────────────────────────
describe('POST /orders/no-show/batch-preview', () => {
  it('names 是整块字符串 → 200，原样进编排层', async () => {
    const res = await post('/orders/no-show/batch-preview', tokenFor('s1', UserRole.STAFF), {
      scheduleId: SCH_OUT,
      names: '陈志远\n林晓梅',
    });
    expect(res.statusCode).toBe(200);
    expect(previewBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scheduleId: SCH_OUT, names: '陈志远\n林晓梅' }),
      { userId: 's1', role: UserRole.STAFF },
    );
  });

  it('names 是字符串数组 → 200，按换行拼回同一份文本（前端两种发法都收）', async () => {
    const res = await post('/orders/no-show/batch-preview', tokenFor('s1', UserRole.STAFF), {
      scheduleId: SCH_OUT,
      names: ['陈志远', '林晓梅'],
    });
    expect(res.statusCode).toBe(200);
    expect(previewBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ names: '陈志远\n林晓梅' }),
      expect.anything(),
    );
  });

  it('releaseReturn 原样往下传（预检与执行同口径）', async () => {
    const res = await post('/orders/no-show/batch-preview', tokenFor('a1', UserRole.ADMIN), {
      scheduleId: SCH_OUT,
      names: ['陈志远'],
      releaseReturn: false,
    });
    expect(res.statusCode).toBe(200);
    expect(previewBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ releaseReturn: false }),
      expect.anything(),
    );
  });

  it('空名单（空串 / 空数组 / 只有一行空串）→ 400', async () => {
    const token = tokenFor('s1', UserRole.STAFF);
    for (const names of ['', [], ['']]) {
      const res = await post('/orders/no-show/batch-preview', token, {
        scheduleId: SCH_OUT,
        names,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(previewBatchMock).not.toHaveBeenCalled();
  });

  it.each<UserRole>([UserRole.CUSTOMER, UserRole.AGENT])('role=%s → 403', async (role) => {
    const res = await post('/orders/no-show/batch-preview', tokenFor(`u-${role}`, role), {
      scheduleId: SCH_OUT,
      names: '陈志远',
    });
    expect(res.statusCode).toBe(403);
    expect(previewBatchMock).not.toHaveBeenCalled();
  });
});

// ── POST /orders/no-show/batch ──────────────────────────────────────────────
describe('POST /orders/no-show/batch', () => {
  function entries(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      orderId: id(`ord${i}`),
      passengerIds: [id(`p${i}`)],
    }));
  }

  it('合法 body → 200，整批审计挂 FLIGHT + 班次 id（不是订单 id）', async () => {
    const res = await post('/orders/no-show/batch', tokenFor('s1', UserRole.STAFF), {
      requestToken: BATCH_TOKEN,
      scheduleId: SCH_OUT,
      entries: entries(2),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({
      ok: 1,
      failed: 0,
      releasedSeats: 2,
      replayedCount: 0,
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MARK_NO_SHOW_BATCH',
        targetType: 'FLIGHT',
        targetId: SCH_OUT,
      }),
    );
    // releaseReturn 不传 → 缺省 true 落到执行体。
    expect(executeBatchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ releaseReturn: true }),
      { userId: 's1', role: UserRole.STAFF },
    );
  });

  // 部分乘客的单会先拆单，真正被标的是拆出来的**新单** —— 审计挂源单 id，
  // 按订单 id 查新单的流水时一条都查不到。
  it('逐单审计挂被标的那张单（targetOrderId），并把源单 id 留在 after 里', async () => {
    const targetId = id('ordnew');
    executeBatchMock.mockResolvedValue({
      results: [
        {
          orderId: id('ord0'),
          orderNumber: 'FTM20260902-001',
          ok: true,
          releasedSeats: 2,
          targetOrderId: targetId,
          targetOrderNumber: 'FTM20260902-001-S1',
          replayed: false,
        },
      ],
      summary: { ok: 1, failed: 0, releasedSeats: 2, replayedCount: 0 },
    });
    await post('/orders/no-show/batch', tokenFor('s1', UserRole.STAFF), {
      requestToken: BATCH_TOKEN,
      scheduleId: SCH_OUT,
      entries: entries(1),
    });
    const perOrder = (writeAudit as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls.map((c) => c[0])
      .filter((e) => e.action === 'MARK_NO_SHOW');
    expect(perOrder).toHaveLength(1);
    expect(perOrder[0].targetId).toBe(targetId);
    expect(perOrder[0].after).toMatchObject({ sourceOrderId: id('ord0'), targetOrderId: targetId });
  });

  // 回放 = 库里一个字段都没动。落一条 MARK_NO_SHOW 会让订单流水上凭空多出「又标了一次」，
  // 事后复盘把重试看成真操作。
  it('回放的单不落逐单审计；整批审计带 replayedCount', async () => {
    executeBatchMock.mockResolvedValue({
      results: [
        {
          orderId: id('ord0'),
          orderNumber: 'FTM20260902-001',
          ok: true,
          releasedSeats: 2,
          replayed: true,
        },
      ],
      summary: { ok: 1, failed: 0, releasedSeats: 0, replayedCount: 1 },
    });
    await post('/orders/no-show/batch', tokenFor('s1', UserRole.STAFF), {
      requestToken: BATCH_TOKEN,
      scheduleId: SCH_OUT,
      entries: entries(1),
    });
    const calls = (writeAudit as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls.map((c) => c[0]);
    expect(calls.filter((e) => e.action === 'MARK_NO_SHOW')).toHaveLength(0);
    const batch = calls.find((e) => e.action === 'MARK_NO_SHOW_BATCH')!;
    expect(batch.after).toMatchObject({ replayedCount: 1, releasedSeats: 0 });
  });

  it('单次 50 张是上限：50 张放行、51 张 400（前端分片连发）', async () => {
    const token = tokenFor('s1', UserRole.STAFF);
    const ok = await post('/orders/no-show/batch', token, {
      requestToken: BATCH_TOKEN,
      scheduleId: SCH_OUT,
      entries: entries(50),
    });
    expect(ok.statusCode).toBe(200);

    const tooMany = await post('/orders/no-show/batch', token, {
      requestToken: BATCH_TOKEN,
      scheduleId: SCH_OUT,
      entries: entries(51),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(executeBatchMock).toHaveBeenCalledTimes(1);
  });

  it.each<UserRole>([UserRole.CUSTOMER, UserRole.AGENT])('role=%s → 403', async (role) => {
    const res = await post('/orders/no-show/batch', tokenFor(`u-${role}`, role), {
      requestToken: BATCH_TOKEN,
      scheduleId: SCH_OUT,
      entries: entries(1),
    });
    expect(res.statusCode).toBe(403);
    expect(executeBatchMock).not.toHaveBeenCalled();
  });
});

// ── GET /orders/no-show/report ──────────────────────────────────────────────
describe('GET /orders/no-show/report', () => {
  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  it('不传区间 → 200，后端按近 30 天补缺省（前端把区间当可选参数发）', async () => {
    const res = await get('/orders/no-show/report', tokenFor('s1', UserRole.STAFF));
    expect(res.statusCode).toBe(200);
    const [from, to] = loadReportMock.mock.calls[0];
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(from <= to).toBe(true);
    const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    expect(spanDays).toBe(29); // 含首尾共 30 天
  });

  it('跨度超上限 → 400（这张表要按区间捞全部班次，跨度越大越接近全表扫描）', async () => {
    const res = await get(
      '/orders/no-show/report?from=2026-01-01&to=2026-12-31',
      tokenFor('s1', UserRole.STAFF),
    );
    expect(res.statusCode).toBe(400);
    expect(loadReportMock).not.toHaveBeenCalled();
  });

  it('区间合法 → 200，原样传到装载层', async () => {
    const res = await get(
      '/orders/no-show/report?from=2026-09-01&to=2026-09-30',
      tokenFor('s1', UserRole.STAFF),
    );
    expect(res.statusCode).toBe(200);
    // 第三个参数是调用方身份（报表模块内部再断一次岗位，纵深防御）。
    expect(loadReportMock).toHaveBeenCalledWith('2026-09-01', '2026-09-30', {
      userId: 's1',
      role: UserRole.STAFF,
    });
  });

  // 这张表是跨代理的整班库存/超售台账：只审导出、不审在线翻表，等于给自己留了个盲区。
  it('看表也落一条 INFO 审计（谁在什么时候查了哪一段）', async () => {
    await get('/orders/no-show/report?from=2026-09-01&to=2026-09-30', tokenFor('s1', UserRole.STAFF));
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VIEW_NO_SHOW_REPORT',
        targetType: 'FLIGHT',
        severity: 'INFO',
        after: expect.objectContaining({ from: '2026-09-01', to: '2026-09-30' }),
      }),
    );
  });
});
