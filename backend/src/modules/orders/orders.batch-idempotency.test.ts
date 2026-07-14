/**
 * R7 · batchCreateOrders 批量重试幂等（派生稳定幂等键）· 服务级单测
 * （vitest，mock Prisma + spy 私有定价/建单方法，不依赖真 DB）
 *
 * 口径：整批 HTTP 重试/双击时，每张子单派生稳定幂等键 `batch:{batchId}:{index}`，透传给 createOrder
 *       复用其幂等回放 → 同批重复提交每子单只建一次、不双占座。
 *   - body.batchId 存在 → 用它；同一 body 再跑一遍，各子单幂等键与首次完全一致（跨请求重试可防重）。
 *   - body.batchId 缺省 → 后端生成一个同批共享的 batchId（同批各子单前缀一致；仅防同一请求内）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    order: { create: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import type { BatchCreateOrdersBody } from './orders.schemas.js';

const service = new OrderService();

function baseBody(overrides: Partial<BatchCreateOrdersBody> = {}): BatchCreateOrdersBody {
  return {
    productType: 'FLIGHT_ONEWAY',
    outboundScheduleId: 's-1',
    flightCabin: 'ECONOMY',
    description: 'QH9588 DAD→MFM 2026-08-15 经济舱',
    passengers: [
      { fullName: 'WU/FEILAI', documentNumber: 'EB9452866', dateOfBirth: '1983-09-20', nationality: 'CN' },
      { fullName: 'LI/MENG', documentNumber: 'EC1112223', dateOfBirth: '1990-02-02', nationality: 'CN' },
      { fullName: 'ZHAO/LEI', documentNumber: 'ED4445556', dateOfBirth: '1988-03-03', nationality: 'CN' },
    ],
    ...overrides,
  } as unknown as BatchCreateOrdersBody;
}

/** 装配：查重/建单都放行，createOrder 捕获每次入参的 idempotencyKey，返回成功子单。 */
function wire(): { keys: () => Array<string | undefined> } {
  vi.spyOn(service as never, 'assertNoDuplicatePassengersOnFlights').mockResolvedValue(undefined as never);
  const captured: Array<string | undefined> = [];
  vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { idempotencyKey?: string }) => {
    captured.push(body.idempotencyKey);
    return { id: `o-${captured.length}`, orderNumber: `N-${captured.length}` };
  }) as never);
  return { keys: () => captured };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ displayName: '运营A', email: 'op@x.io', phone: '-' });
});

describe('batchCreateOrders · 派生稳定幂等键 batch:{batchId}:{index}', () => {
  it('body.batchId 存在 → 每子单幂等键 = batch:{batchId}:{index}（按行号 0..n-1）', async () => {
    const { keys } = wire();
    await service.batchCreateOrders(baseBody({ batchId: 'fixed-batch-uuid-1234' }), {
      userId: 'u-admin',
      role: 'ADMIN',
    } as never);

    expect(keys()).toEqual([
      'batch:fixed-batch-uuid-1234:0',
      'batch:fixed-batch-uuid-1234:1',
      'batch:fixed-batch-uuid-1234:2',
    ]);
  });

  it('同一 body（含 batchId）重跑一遍 → 各子单幂等键与首次逐一相同（跨请求重试可防重）', async () => {
    const first = wire();
    await service.batchCreateOrders(baseBody({ batchId: 'stable-xyz-9999' }), {
      userId: 'u-admin',
      role: 'ADMIN',
    } as never);
    const firstKeys = first.keys();

    // 第二次提交（模拟整批 HTTP 重试）：同 batchId → 同一批幂等键
    vi.restoreAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: '运营A', email: 'op@x.io', phone: '-' });
    const second = wire();
    await service.batchCreateOrders(baseBody({ batchId: 'stable-xyz-9999' }), {
      userId: 'u-admin',
      role: 'ADMIN',
    } as never);

    expect(second.keys()).toEqual(firstKeys);
  });

  it('body.batchId 缺省 → 后端生成同批共享 batchId（同批各子单前缀一致、index 递增、去重后=1 个 batchId）', async () => {
    const { keys } = wire();
    await service.batchCreateOrders(baseBody(), { userId: 'u-admin', role: 'ADMIN' } as never);

    const ks = keys();
    expect(ks).toHaveLength(3);
    // 每个键形如 batch:{batchId}:{index}
    const parsed = ks.map((k) => {
      const m = /^batch:(.+):(\d+)$/.exec(k ?? '');
      return m ? { batchId: m[1], index: Number(m[2]) } : null;
    });
    expect(parsed.every((p) => p !== null)).toBe(true);
    // 同批共享一个 batchId
    const batchIds = new Set(parsed.map((p) => p!.batchId));
    expect(batchIds.size).toBe(1);
    // index 按行号 0..2
    expect(parsed.map((p) => p!.index)).toEqual([0, 1, 2]);
  });

  it('缺省 batchId：两次不同批次提交 → batchId 不同（各自独立一批，互不复用幂等键）', async () => {
    const first = wire();
    await service.batchCreateOrders(baseBody(), { userId: 'u-admin', role: 'ADMIN' } as never);
    const firstBatchId = /^batch:(.+):\d+$/.exec(first.keys()[0] ?? '')?.[1];

    vi.restoreAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ displayName: '运营A', email: 'op@x.io', phone: '-' });
    const second = wire();
    await service.batchCreateOrders(baseBody(), { userId: 'u-admin', role: 'ADMIN' } as never);
    const secondBatchId = /^batch:(.+):\d+$/.exec(second.keys()[0] ?? '')?.[1];

    expect(firstBatchId).toBeTruthy();
    expect(secondBatchId).toBeTruthy();
    expect(firstBatchId).not.toBe(secondBatchId);
  });
});
