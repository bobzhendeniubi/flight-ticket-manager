import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  legacyTicket: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    groupBy: vi.fn(),
    aggregate: vi.fn(),
  },
  legacyReceipt: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { getLegacyDashboard, getLegacyPassengerHistory, getLegacyStats, listLegacyTickets } from './legacy.service.js';

describe('历史档案查询服务', () => {
  beforeEach(() => vi.clearAllMocks());

  it('默认排除已作废档案并支持模糊搜索', async () => {
    prismaMock.legacyTicket.findMany.mockResolvedValue([]);
    prismaMock.legacyTicket.count.mockResolvedValue(0);
    await listLegacyTickets({ q: 'PX-1', page: 1, pageSize: 20 });
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isDeleted: false,
        OR: expect.arrayContaining([
          { documentNumberNorm: { contains: 'PX-1', mode: 'insensitive' } },
        ]),
      }),
    }));
  });

  it('passes an exact data issue filter to the archive query', async () => {
    prismaMock.legacyTicket.findMany.mockResolvedValue([]);
    prismaMock.legacyTicket.count.mockResolvedValue(0);
    await listLegacyTickets({ dataIssue: 'birth:after-order', page: 1, pageSize: 20 });
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isDeleted: false, dataIssues: { has: 'birth:after-order' } },
    }));
  });

  it('history query returns the non-deleted total and superseded count', async () => {
    prismaMock.legacyTicket.count.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
    prismaMock.legacyTicket.findMany.mockResolvedValue([]);
    const result = await getLegacyPassengerHistory(' px-1 ');
    expect(result).toEqual({ total: 4, superseded: 3, items: [] });
    expect(prismaMock.legacyTicket.count).toHaveBeenNthCalledWith(1, {
      where: { documentNumberNorm: 'PX-1', isDeleted: false },
    });
  });

  it('uses the non-deleted archive population for stats', async () => {
    prismaMock.legacyTicket.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    prismaMock.legacyTicket.groupBy.mockResolvedValue([{ documentNumberNorm: 'PX-1' }, { documentNumberNorm: 'PX-2' }]);
    prismaMock.legacyTicket.aggregate.mockResolvedValue({
      _min: { legacyCreateTime: new Date('2020-01-01T00:00:00.000Z') },
      _max: { legacyCreateTime: new Date('2026-08-24T00:00:00.000Z') },
    });
    prismaMock.legacyReceipt.count.mockResolvedValue(8);

    const result = await getLegacyStats();

    expect(result).toEqual({
      total: 5,
      uniquePassengers: 2,
      dateFrom: '2020-01-01T00:00:00.000Z',
      dateTo: '2026-08-24T00:00:00.000Z',
      receiptCount: 8,
      superseded: 2,
    });
    expect(prismaMock.legacyTicket.count).toHaveBeenNthCalledWith(1, { where: { isDeleted: false } });
    expect(prismaMock.legacyTicket.count).toHaveBeenNthCalledWith(2, {
      where: { isDeleted: false, supersededByOrderId: { not: null } },
    });
    expect(prismaMock.legacyTicket.groupBy).toHaveBeenCalledWith({
      by: ['documentNumberNorm'],
      where: { documentNumberNorm: { not: null }, isDeleted: false },
    });
    expect(prismaMock.legacyTicket.aggregate).toHaveBeenCalledWith({
      where: { isDeleted: false },
      _min: { legacyCreateTime: true },
      _max: { legacyCreateTime: true },
    });
  });

  it('returns dashboard aggregates as JSON-safe numbers and strings', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ month: '2025-01', count: 2n, finalPriceSum: '1200.00' }])
      .mockResolvedValueOnce([{ confirmed: 1n, unconfirmed: 1n }])
      .mockResolvedValueOnce([{ finalPriceSum: '1200.00', truePriceSum: '1000.00', superseded: 1n }])
      .mockResolvedValueOnce([{ receiptCount: 3n, receiptAmountSum: '800.00' }])
      .mockResolvedValueOnce([{ orgId: 'org-1', orgName: '代理一', count: 2n, finalPriceSum: '1200.00' }])
      .mockResolvedValueOnce([{ flightNo: 'QH1', count: 2n }])
      .mockResolvedValueOnce([{ issue: 'birth:after-order', count: 1n }]);

    await expect(getLegacyDashboard()).resolves.toEqual({
      monthly: [{ month: '2025-01', count: 2, finalPriceSum: '1200.00' }],
      payment: { confirmed: 1, unconfirmed: 1 },
      totals: { finalPriceSum: '1200.00', truePriceSum: '1000.00', receiptCount: 3, receiptAmountSum: '800.00' },
      topOrgs: [{ orgId: 'org-1', orgName: '代理一', count: 2, finalPriceSum: '1200.00' }],
      topFlights: [{ flightNo: 'QH1', count: 2 }],
      dataIssues: [{ issue: 'birth:after-order', count: 1 }],
      superseded: 1,
    });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(7);
    const monthlyQuery = String(prismaMock.$queryRaw.mock.calls[0]?.[0]);
    const receiptQuery = String(prismaMock.$queryRaw.mock.calls[3]?.[0]);
    expect(monthlyQuery).toContain('date_trunc');
    expect(monthlyQuery).not.toContain('AT TIME ZONE');
    expect(receiptQuery).toContain('INNER JOIN "LegacyTicket"');
    expect(receiptQuery).toContain('ticket."isDeleted" = false');
  });
});
