/**
 * 飞行次数共享核心单测 —— 直接注入假 client 驱动 computeCombinedTripCounts，无需 mock 模块。
 *
 * 覆盖：
 *   - 合计 = 新系统已飞 + 老系统历史（兜底路径绝不只出老系统那一半）
 *   - 没有任何新系统订单的证件：只出老系统次数，在订未飞为 0
 *   - ±1 天活体去重在兜底路径下仍生效（真实的新系统已飞业务日传进了 scope）
 *   - 批量：证件再多也只有一条订单查询 + 一条老系统查询（无 N+1）
 *   - 有效订单口径包含「待支付」（后台单/代理单永不自动退位）
 *   - 占位出行人（N/A / 空证件号）不给条目、也不白查库
 */
import { describe, it, expect, vi } from 'vitest';
import { DocumentType } from '@prisma/client';
import { computeCombinedTripCounts, EXCLUDED_ORDER_STATUSES } from './traveler-trip-count.js';
import { docKey } from './traveler-profiles.aggregate.js';

const NOW = new Date('2026-07-14T00:00:00.000Z');

/** orderSelect 形状的最小订单行：一位乘客 + 一条去程 */
function orderRow(documentNumber: string, departISO: string, status = 'PAID') {
  return {
    id: `o-${documentNumber}-${departISO}`,
    orderNumber: `FTM-${documentNumber}`,
    status,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    paidAmount: 1000,
    passengers: [
      {
        fullName: 'ZHANG SAN',
        chineseName: '张三',
        gender: null,
        documentType: DocumentType.PASSPORT,
        documentNumber,
        dateOfBirth: null,
        nationality: 'CN',
        passportExpiry: null,
        mealPreference: null,
        bedPref: null,
        needsWheelchair: false,
        singleRoom: false,
      },
    ],
    items: [
      {
        kind: 'FLIGHT',
        flightCabin: null,
        hotelCheckIn: null,
        hotelCheckOut: null,
        flightSchedule: {
          departureTime: new Date(departISO),
          flight: { flightNumber: 'QH9588', originCode: 'MFM', destinationCode: 'DAD' },
        },
        hotelRoomType: null,
      },
    ],
  };
}

function legacyRow(documentNumberNorm: string, outboundISO: string | null) {
  return {
    documentNumberNorm,
    outboundDate: outboundISO ? new Date(outboundISO) : null,
  };
}

function fakeClient(
  orders: ReturnType<typeof orderRow>[],
  legacy: ReturnType<typeof legacyRow>[],
) {
  const orderFindMany = vi.fn().mockResolvedValue(orders);
  const legacyFindMany = vi.fn().mockResolvedValue(legacy);
  const client = {
    order: { findMany: orderFindMany },
    legacyTicket: { findMany: legacyFindMany },
  } as unknown as Parameters<typeof computeCombinedTripCounts>[1];
  return { client, orderFindMany, legacyFindMany };
}

const doc = (documentNumber: string) => ({
  documentType: DocumentType.PASSPORT,
  documentNumber,
});

describe('computeCombinedTripCounts 合计口径', () => {
  it('合计 = 新系统已飞 + 老系统历史，不是只有老系统那一半', async () => {
    const { client } = fakeClient(
      [orderRow('E12345678', '2026-03-01T02:00:00.000Z'), orderRow('E12345678', '2026-04-01T02:00:00.000Z')],
      [legacyRow('E12345678', '2019-05-01T00:00:00.000Z')],
    );
    const counts = await computeCombinedTripCounts([doc('E12345678')], client, NOW);
    expect(counts.get(docKey('PASSPORT', 'E12345678'))).toEqual({
      tripCount: 3, // 新系统 2 + 老系统 1
      pendingTripCount: 0,
    });
  });

  it('新系统里没有订单的证件：只出老系统次数，在订未飞为 0', async () => {
    const { client } = fakeClient(
      [],
      [legacyRow('OLD-ONLY', '2018-01-01T00:00:00.000Z'), legacyRow('OLD-ONLY', null)],
    );
    const counts = await computeCombinedTripCounts([doc('OLD-ONLY')], client, NOW);
    expect(counts.get(docKey('PASSPORT', 'OLD-ONLY'))).toEqual({
      tripCount: 2,
      pendingTripCount: 0,
    });
  });

  it('未起飞的单进在订未飞，不进飞行次数', async () => {
    const { client } = fakeClient([orderRow('E12345678', '2026-09-01T02:00:00.000Z')], []);
    const counts = await computeCombinedTripCounts([doc('E12345678')], client, NOW);
    expect(counts.get(docKey('PASSPORT', 'E12345678'))).toEqual({
      tripCount: 0,
      pendingTripCount: 1,
    });
  });

  it('±1 天活体去重在兜底路径下仍生效：老系统重录的那趟不重复计', async () => {
    const { client } = fakeClient(
      [orderRow('E12345678', '2026-03-01T02:00:00.000Z')],
      [
        legacyRow('E12345678', '2026-03-02T00:00:00.000Z'), // 差 1 天 → 判为同一趟重录
        legacyRow('E12345678', '2019-05-01T00:00:00.000Z'),
      ],
    );
    const counts = await computeCombinedTripCounts([doc('E12345678')], client, NOW);
    expect(counts.get(docKey('PASSPORT', 'E12345678'))?.tripCount).toBe(2); // 1 + 1
  });

  it('证件号大小写/首尾空格归一：与聚合 key 对得上，不会白算一遍', async () => {
    const { client, orderFindMany } = fakeClient(
      [orderRow('e12345678', '2026-03-01T02:00:00.000Z')],
      [legacyRow('E12345678', '2019-05-01T00:00:00.000Z')],
    );
    const counts = await computeCombinedTripCounts([doc('  E12345678  ')], client, NOW);
    expect(counts.get(docKey('PASSPORT', 'E12345678'))?.tripCount).toBe(2);
    // 查询条件按 trim 后的证件号 + 忽略大小写下发
    const or = orderFindMany.mock.calls[0][0].where.passengers.some.OR;
    expect(or).toEqual([
      {
        documentType: DocumentType.PASSPORT,
        documentNumber: { equals: 'E12345678', mode: 'insensitive' },
      },
    ]);
  });
});

describe('computeCombinedTripCounts 批量与口径边界', () => {
  it('证件再多也只有一条订单查询 + 一条老系统查询（不在循环里逐人查库）', async () => {
    const { client, orderFindMany, legacyFindMany } = fakeClient([], []);
    await computeCombinedTripCounts(
      [doc('E1'), doc('E2'), doc('E3'), doc('E4'), doc('E5')],
      client,
      NOW,
    );
    expect(orderFindMany).toHaveBeenCalledTimes(1);
    expect(legacyFindMany).toHaveBeenCalledTimes(1);
    expect(legacyFindMany.mock.calls[0][0].where.documentNumberNorm.in).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
    ]);
  });

  it('有效订单口径含「待支付」：这类单也算飞行次数（后台单/代理单永不自动退位）', async () => {
    expect(EXCLUDED_ORDER_STATUSES).not.toContain('PENDING_PAYMENT');
    const { client, orderFindMany } = fakeClient(
      [orderRow('E12345678', '2026-03-01T02:00:00.000Z', 'PENDING_PAYMENT')],
      [],
    );
    const counts = await computeCombinedTripCounts([doc('E12345678')], client, NOW);
    expect(counts.get(docKey('PASSPORT', 'E12345678'))?.tripCount).toBe(1);
    expect(orderFindMany.mock.calls[0][0].where.status.notIn).not.toContain('PENDING_PAYMENT');
  });

  it('占位出行人（N/A）与空证件号：不给条目，也不白查一次库', async () => {
    const { client, orderFindMany, legacyFindMany } = fakeClient([], []);
    const counts = await computeCombinedTripCounts([doc('N/A'), doc('   ')], client, NOW);
    expect(counts.size).toBe(0);
    expect(orderFindMany).not.toHaveBeenCalled();
    expect(legacyFindMany).not.toHaveBeenCalled();
  });

  it('空入参直接返回空 Map，不查库', async () => {
    const { client, orderFindMany } = fakeClient([], []);
    expect((await computeCombinedTripCounts([], client, NOW)).size).toBe(0);
    expect(orderFindMany).not.toHaveBeenCalled();
  });
});
