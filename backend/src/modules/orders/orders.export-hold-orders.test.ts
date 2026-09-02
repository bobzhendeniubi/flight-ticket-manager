/**
 * 全岗总表「占位单」表 · 单元测试（vitest）
 *
 * 占位单不是订单（无名单、无订单号），按订单口径导出的任何一张表都看不见它，
 * 于是「今天留了哪几个团、几号的、多少座」在收工核对时无处可查。这里测的就是这张表：
 *   - 选单按出发日期（起飞地当地日），不是建单日期
 *   - 已释放 / 已取消 / 已转正不进表（座位早已回池，不是当天要盯的）
 *   - 「当前占座」= 占位数 − 已转正 − 已减员，与库存聚合口径一致
 *   - 「已收」只算未撤销的认款
 */
import { describe, expect, it, vi } from 'vitest';
import { HoldOrderStatus } from '@prisma/client';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { loadHoldExportRows } from './orders.export-hold-orders.js';

function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    holdNo: 'H20260825K7Z9',
    groupRef: 'G20260825AB12',
    groupName: '九月团',
    ownerType: 'AGENT',
    seats: 55,
    seatsConverted: 5,
    seatsCancelled: 3,
    perSeatPriceCny: 1450,
    status: HoldOrderStatus.HOLDING,
    notes: '去程',
    createdAt: new Date('2026-08-25T15:15:00Z'),
    seatClass: { cabin: 'ECONOMY' },
    agent: { companyName: '某某国旅', contactName: '联系人' },
    installments: [
      { allocations: [{ amountCny: 20000, reversedAt: null }, { amountCny: 9000, reversedAt: new Date() }] },
    ],
    flightSchedule: {
      departureTime: new Date('2026-09-04T04:30:00Z'),
      departureTz: 'Asia/Macau',
      flight: { flightNumber: 'QH9588', originCode: 'DAD', destinationCode: 'MFM' },
    },
    ...overrides,
  };
}

function clientWith(schedules: string[], holds: unknown[]) {
  const findMany = vi.fn(async () => holds);
  return {
    client: {
      $queryRaw: vi.fn(async () => schedules.map((id) => ({ id }))),
      holdOrder: { findMany },
    },
    findMany,
  };
}

describe('loadHoldExportRows', () => {
  it('按出发日期折算起飞地当地日，并算出当前占座与已收', async () => {
    const { client } = clientWith(['schedule_1'], [holdRow()]);
    const rows = await loadHoldExportRows('2026-09-04', '2026-09-07', client as never);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      departDate: '2026-09-04',
      departTime: '12:30',
      flightNumber: 'QH9588',
      route: 'DAD→MFM',
      groupRef: 'G20260825AB12',
      owner: '某某国旅',
      ownerType: '代理',
      cabin: '经济舱',
      seats: 55,
      occupying: 47,
      status: '占座中',
      receivedCny: 20000,
      // 建单时间是「动作发生时刻」，按北京时间折算：15:15Z + 8h = 当日 23:15
      createdAt: '2026-08-25 23:15',
    });
  });

  it('建单时间跨日：UTC 20:00 → 北京时间次日 04:00，日期进位', async () => {
    const { client } = clientWith(
      ['schedule_1'],
      [holdRow({ createdAt: new Date('2026-08-25T20:00:00Z') })],
    );
    const rows = await loadHoldExportRows('2026-09-04', '2026-09-07', client as never);

    expect(rows[0]?.createdAt).toBe('2026-08-26 04:00');
  });

  it('只取仍占座 / 仍在流程里的状态——已释放、已取消、已转正不进表', async () => {
    const { client, findMany } = clientWith(['schedule_1'], []);
    await loadHoldExportRows('2026-09-04', '2026-09-07', client as never);

    const where = findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(
      expect.arrayContaining([HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE, HoldOrderStatus.FULLY_PAID]),
    );
    expect(where.status.in).not.toContain(HoldOrderStatus.RELEASED);
    expect(where.status.in).not.toContain(HoldOrderStatus.CANCELLED);
    expect(where.status.in).not.toContain(HoldOrderStatus.CONVERTED);
  });

  it('区间内一个班次都没有 → 直接返回空，不再查占位单', async () => {
    const { client, findMany } = clientWith([], []);
    expect(await loadHoldExportRows('2026-09-04', '2026-09-07', client as never)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('直客团没有代理档案时，归属回落到团名', async () => {
    const { client } = clientWith(['schedule_1'], [holdRow({ ownerType: 'CUSTOMER', agent: null, groupName: '自组团' })]);
    const rows = await loadHoldExportRows(undefined, undefined, client as never);
    expect(rows[0]).toMatchObject({ owner: '自组团', ownerType: '直客' });
  });

  it('代理导出圈定：agentScope 非空时占位单只取自己+下级代理的（与订单主表同一把闸）', async () => {
    const { client, findMany } = clientWith(['schedule_1'], [holdRow()]);
    await loadHoldExportRows(undefined, undefined, client as never, ['agent_a', 'agent_b']);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agentId: { in: ['agent_a', 'agent_b'] } }),
      }),
    );
  });

  it('代理导出圈定：可见集合为空时不查库直接空表；内部岗位（null）不圈', async () => {
    const empty = clientWith(['schedule_1'], [holdRow()]);
    expect(await loadHoldExportRows(undefined, undefined, empty.client as never, [])).toEqual([]);
    expect(empty.findMany).not.toHaveBeenCalled();

    const internal = clientWith(['schedule_1'], [holdRow()]);
    await loadHoldExportRows(undefined, undefined, internal.client as never, null);
    const where = (internal.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> } | undefined)?.where;
    expect(where).toBeDefined();
    expect(where).not.toHaveProperty('agentId');
  });
});
