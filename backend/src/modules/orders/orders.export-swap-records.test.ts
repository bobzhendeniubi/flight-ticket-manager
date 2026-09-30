/**
 * orders.export-swap-records · 「换人记录」列的解析 / 拼装 / 取数单测。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import {
  formatOrderSwapRecordCell,
  formatSwapRecordCell,
  loadSwapRecordsByPassenger,
  parseSwapAuditRows,
  type SwapAuditRow,
} from './orders.export-swap-records.js';

function swapRow(
  at: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SwapAuditRow {
  return { createdAt: new Date(at), before, after };
}

describe('parseSwapAuditRows + formatSwapRecordCell', () => {
  it('单次换人：旧中文名取换人前快照、新中文名取乘客现值，换人费照写', () => {
    const bySlot = parseSwapAuditRows(
      [
        swapRow(
          '2026-09-30T02:00:00.000Z',
          { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E111', snapshot: { chineseName: '覃雪' } },
          { fullName: 'YANG/LIN', documentNumber: 'E222', feeCny: 480 },
        ),
      ],
      new Map([['p1', '杨林']]),
    );
    expect(formatSwapRecordCell(bySlot.get('p1'))).toBe('09-30 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥480');
  });

  it('时间按北京时间：UTC 前一天 16:30 落到北京次日', () => {
    const bySlot = parseSwapAuditRows([
      swapRow(
        '2026-09-29T16:30:00.000Z',
        { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
        { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 0 },
      ),
    ]);
    expect(formatSwapRecordCell(bySlot.get('p1'))).toBe('09-30 原 QIN/XUE → 新 YANG/LIN');
  });

  it('同一位置多次换人：按时间先后「；」连接，中间那位的中文名取下一次换人前的快照', () => {
    const bySlot = parseSwapAuditRows(
      [
        // 故意乱序传入，解析要自己按时间排
        swapRow(
          '2026-09-20T02:00:00.000Z',
          { passengerId: 'p1', fullName: 'YANG/LIN', documentNumber: 'E2', snapshot: { chineseName: '杨林' } },
          { fullName: 'ZHAO/MU', documentNumber: 'E3', feeCny: 550 },
        ),
        swapRow(
          '2026-09-10T02:00:00.000Z',
          { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1', snapshot: { chineseName: '覃雪' } },
          { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 480 },
        ),
      ],
      new Map([['p1', '赵木']]),
    );
    expect(formatSwapRecordCell(bySlot.get('p1'))).toBe(
      '09-10 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥480；' +
        '09-20 原 YANG/LIN 杨林 → 新 ZHAO/MU 赵木，换人费 ¥550',
    );
  });

  it('没有换人 = 空串；只改自备签/生日这类小修（姓名证件号都没变、没收费）不算换人', () => {
    expect(formatSwapRecordCell(undefined)).toBe('');
    expect(formatSwapRecordCell([])).toBe('');
    const bySlot = parseSwapAuditRows([
      swapRow(
        '2026-09-30T02:00:00.000Z',
        { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
        { fullName: ' qin/xue ', documentNumber: 'e1', feeCny: 0 },
      ),
    ]);
    expect(bySlot.has('p1')).toBe(false);
  });

  it('小修不产生换人段，但它的换人前快照仍用来补上一次换人的新中文名', () => {
    const bySlot = parseSwapAuditRows(
      [
        swapRow(
          '2026-09-10T02:00:00.000Z',
          { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
          { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 480 },
        ),
        swapRow(
          '2026-09-12T02:00:00.000Z',
          { passengerId: 'p1', fullName: 'YANG/LIN', documentNumber: 'E2', snapshot: { chineseName: '杨林' } },
          { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 0 },
        ),
      ],
      new Map([['p1', '杨琳']]),
    );
    expect(formatSwapRecordCell(bySlot.get('p1'))).toBe('09-10 原 QIN/XUE → 新 YANG/LIN 杨林，换人费 ¥480');
  });

  it('只换证件号 →「更换证件」；没换人但收了费 →「资料变更」', () => {
    const bySlot = parseSwapAuditRows([
      swapRow(
        '2026-09-30T02:00:00.000Z',
        { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1', snapshot: { chineseName: '覃雪' } },
        { fullName: 'QIN/XUE', documentNumber: 'E9', feeCny: 200 },
      ),
      swapRow(
        '2026-09-30T02:00:00.000Z',
        { passengerId: 'p2', fullName: 'LI/SI', documentNumber: 'E5' },
        { fullName: 'LI/SI', documentNumber: 'E5', feeCny: 100 },
      ),
    ]);
    expect(formatSwapRecordCell(bySlot.get('p1'))).toBe('09-30 QIN/XUE 覃雪 更换证件，换人费 ¥200');
    expect(formatSwapRecordCell(bySlot.get('p2'))).toBe('09-30 LI/SI 资料变更，换人费 ¥100');
  });

  it('换人差价 >0 追加一段；未按日历重算（repriceSkipped）的差价不采信', () => {
    const bySlot = parseSwapAuditRows([
      swapRow(
        '2026-09-30T02:00:00.000Z',
        { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
        { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 480, reprice: { diffCny: 120.5, repriceSkipped: null } },
      ),
      swapRow(
        '2026-09-30T02:00:00.000Z',
        { passengerId: 'p2', fullName: 'LI/SI', documentNumber: 'E3' },
        {
          fullName: 'WANG/WU',
          documentNumber: 'E4',
          feeCny: 0,
          reprice: { diffCny: 300, repriceSkipped: 'SETTLEMENT_LOCKED' },
        },
      ),
    ]);
    expect(formatSwapRecordCell(bySlot.get('p1'))).toBe(
      '09-30 原 QIN/XUE → 新 YANG/LIN，换人费 ¥480，换人差价 ¥120.50',
    );
    expect(formatSwapRecordCell(bySlot.get('p2'))).toBe('09-30 原 LI/SI → 新 WANG/WU');
  });

  it('缺乘客槽位的残缺审计不硬挂到任何人头上', () => {
    const bySlot = parseSwapAuditRows([
      swapRow('2026-09-30T02:00:00.000Z', { fullName: 'QIN/XUE' }, { fullName: 'YANG/LIN', feeCny: 480 }),
    ]);
    expect(bySlot.size).toBe(0);
  });

  it('订单级一格：本单各乘客的换人按时间合并', () => {
    const bySlot = parseSwapAuditRows([
      swapRow(
        '2026-09-12T02:00:00.000Z',
        { passengerId: 'p2', fullName: 'LI/SI', documentNumber: 'E3' },
        { fullName: 'WANG/WU', documentNumber: 'E4' },
      ),
      swapRow(
        '2026-09-10T02:00:00.000Z',
        { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
        { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 450 },
      ),
    ]);
    expect(formatOrderSwapRecordCell(['p1', 'p2', 'p3'], bySlot)).toBe(
      '09-10 原 QIN/XUE → 新 YANG/LIN，换人费 ¥450；09-12 原 LI/SI → 新 WANG/WU',
    );
    expect(formatOrderSwapRecordCell(['p3'], bySlot)).toBe('');
  });
});

describe('loadSwapRecordsByPassenger（取数）', () => {
  function fakeClient(audits: SwapAuditRow[], splitSources: string[][] = []) {
    const auditFindMany = vi.fn().mockResolvedValue(audits);
    const splitFindMany = vi.fn();
    for (const sources of splitSources) {
      splitFindMany.mockResolvedValueOnce(sources.map((sourceOrderId) => ({ sourceOrderId })));
    }
    splitFindMany.mockResolvedValue([]);
    const client = {
      auditLog: { findMany: auditFindMany },
      orderSplitRecord: { findMany: splitFindMany },
    } as unknown as PrismaClient;
    return { client, auditFindMany, splitFindMany };
  }

  it('没有乘客 → 不查库', async () => {
    const { client, auditFindMany, splitFindMany } = fakeClient([]);
    const out = await loadSwapRecordsByPassenger([{ id: 'o1', passengers: [] }], client);
    expect(out.size).toBe(0);
    expect(auditFindMany).not.toHaveBeenCalled();
    expect(splitFindMany).not.toHaveBeenCalled();
  });

  it('按 (targetType, targetId) 查换人审计，顺拆单流水带上祖先单；只留当前在这批单里的乘客', async () => {
    const { client, auditFindMany } = fakeClient(
      [
        swapRow(
          '2026-09-10T02:00:00.000Z',
          { passengerId: 'p1', fullName: 'QIN/XUE', documentNumber: 'E1' },
          { fullName: 'YANG/LIN', documentNumber: 'E2', feeCny: 480 },
        ),
        // 祖先单上留下的另一位（没被拆到这批单里）：不该出现在结果里
        swapRow(
          '2026-09-10T02:00:00.000Z',
          { passengerId: 'p-stayed', fullName: 'LI/SI', documentNumber: 'E3' },
          { fullName: 'WANG/WU', documentNumber: 'E4' },
        ),
      ],
      [['o-parent'], ['o-grandparent']],
    );
    const out = await loadSwapRecordsByPassenger(
      [{ id: 'o-child', passengers: [{ id: 'p1', chineseName: '杨林' }] }],
      client,
    );
    expect([...out.keys()]).toEqual(['p1']);
    expect(formatSwapRecordCell(out.get('p1'))).toBe('09-10 原 QIN/XUE → 新 YANG/LIN 杨林，换人费 ¥480');
    const { where } = auditFindMany.mock.calls[0][0] as {
      where: { action: string; targetType: string; targetId: { in: string[] } };
    };
    expect(where.action).toBe('SWAP_ORDER_PASSENGER');
    expect(where.targetType).toBe('ORDER');
    expect([...where.targetId.in].sort()).toEqual(['o-child', 'o-grandparent', 'o-parent']);
  });
});
