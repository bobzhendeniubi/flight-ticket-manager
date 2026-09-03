/**
 * no-show 报表 · 单测（纯聚合 + xlsx 渲染，不依赖真 DB）
 *
 * 报表的价值全在口径上，所以逐条钉死：
 *   · 只收「去程行带 noShow 快照」的单（没标过的单不该出现在 no-show 报表里）；
 *   · 按**去程航班的当地日期**分组，同一班多张单合并成一行；
 *   · released/restored 是累计事件量（多轮释放/恢复各记各的），
 *     stillReleased 才是「此刻还躺在库存里可卖的座」—— 两个数刻意不相等；
 *   · 起飞后作废的座落 voided，不再算进 stillReleased；
 *   · workOrdersOpen 只数 NOSHOW_* 且 OPEN/IN_PROGRESS 的工单。
 */
import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { OrderItemKind, ReminderStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  aggregateNoShowReport,
  loadNoShowReport,
  noShowReportFilename,
  renderNoShowReportWorkbook,
  type NoShowReportOrderView,
} from './no-show-report.js';

const OUT_DEPART = new Date('2026-09-02T01:40:00.000Z'); // 北京 09:40
const RET_DEPART = new Date('2026-09-09T05:00:00.000Z');

function outboundRow(metadata: unknown, scheduleId = 'sch-a', flightNumber = 'QH9589') {
  return {
    id: 'leg-out',
    kind: OrderItemKind.FLIGHT,
    flightScheduleId: scheduleId,
    metadata,
    flightSchedule: {
      departureTime: OUT_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber },
    },
  };
}

/** 已释放的回程行：班次被置空（座位账已经不认这一行了）。 */
function releasedReturnRow(metadata: unknown) {
  return {
    id: 'leg-ret',
    kind: OrderItemKind.FLIGHT,
    flightScheduleId: null,
    metadata,
    flightSchedule: null,
  };
}

/** 已恢复的回程行：班次写了回去。 */
function restoredReturnRow(metadata: unknown) {
  return {
    id: 'leg-ret',
    kind: OrderItemKind.FLIGHT,
    flightScheduleId: 'sch-b',
    metadata,
    flightSchedule: {
      departureTime: RET_DEPART,
      departureTz: 'Asia/Shanghai',
      flight: { flightNumber: 'QH9588' },
    },
  };
}

function noShowMeta(passengerIds: string[] = ['p-1']) {
  return { noShow: { at: '2026-09-02T02:00:00.000Z', passengerIds } };
}

function order(over: Partial<NoShowReportOrderView> = {}): NoShowReportOrderView {
  return {
    id: 'ord-1',
    orderNumber: 'FTM20260902-001',
    agentName: '某旅行社',
    passengers: [
      { id: 'p-1', fullName: 'CHEN/ZHIYUAN', chineseName: '陈志远' },
      { id: 'p-2', fullName: 'LIN/XIAOMEI', chineseName: '林晓梅' },
    ],
    items: [outboundRow(noShowMeta())],
    reminders: [],
    ...over,
  };
}

describe('aggregateNoShowReport · 选单口径', () => {
  it('去程没标过 no-show 的单不进表', () => {
    const r = aggregateNoShowReport([order({ items: [outboundRow({})] })]);
    expect(r.rows).toEqual([]);
    expect(r.totals.orders).toBe(0);
  });

  it('单程单只有 no-show 标：人次按快照里的 passengerIds 算', () => {
    const r = aggregateNoShowReport([order({ items: [outboundRow(noShowMeta(['p-1', 'p-2']))] })]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      scheduleId: 'sch-a',
      flightNumber: 'QH9589',
      departDate: '2026-09-02',
      orders: 1,
      noShowPax: 2,
      releasedSeats: 0,
      stillReleasedSeats: 0,
    });
    expect(r.details[0].returnStatus).toBe('无回程');
  });

  it('快照没留 passengerIds（老数据）→ 回落到整单人数', () => {
    const r = aggregateNoShowReport([
      order({ items: [outboundRow({ noShow: { at: '2026-09-02T02:00:00.000Z' } })] }),
    ]);
    expect(r.rows[0].noShowPax).toBe(2);
  });

  it('同一班多张单合并成一行；不同班分行并按日期 + 航班号排序', () => {
    const later = outboundRow(noShowMeta(), 'sch-z', 'QH9600');
    const r = aggregateNoShowReport([
      order({ id: 'ord-2', orderNumber: 'FTM20260902-002', items: [later] }),
      order(),
      order({ id: 'ord-3', orderNumber: 'FTM20260902-003' }),
    ]);
    expect(r.rows.map((x) => [x.flightNumber, x.orders])).toEqual([
      ['QH9589', 2],
      ['QH9600', 1],
    ]);
    expect(r.totals.orders).toBe(3);
  });
});

describe('aggregateNoShowReport · 座位口径', () => {
  it('释放 → 恢复 → 再释放：累计量各记各的，当前可卖只算最后一次', () => {
    const retMeta = {
      returnReleased: {
        at: '2026-09-03T02:00:00.000Z',
        releasedSeats: [{ cabin: 'ECONOMY', quantity: 2 }],
        history: [
          { at: '2026-09-02T02:00:00.000Z', releasedSeats: [{ cabin: 'ECONOMY', quantity: 2 }] },
        ],
      },
      returnRestored: { at: '2026-09-02T08:00:00.000Z', seats: 2, oversold: false },
      legActionLog: [
        { type: 'NO_SHOW', requestToken: 't1', at: '2026-09-02T02:00:00.000Z', seats: 2 },
        { type: 'RESTORE', requestToken: 't2', at: '2026-09-02T08:00:00.000Z', seats: 2 },
        { type: 'RELEASE', requestToken: 't3', at: '2026-09-03T02:00:00.000Z', seats: 2 },
      ],
    };
    const r = aggregateNoShowReport([
      order({ items: [outboundRow(noShowMeta()), releasedReturnRow(retMeta)] }),
    ]);
    expect(r.rows[0]).toMatchObject({
      releasedSeats: 4, // 两次释放
      restoredSeats: 2, // 一次恢复
      stillReleasedSeats: 2, // 此刻躺在库存里的只有最后那一次
      voidedSeats: 0,
    });
    expect(r.details[0].returnStatus).toBe('回程座位已释放');
  });

  it('已恢复且超售：超售 / 挤占预留进表，当前可卖归零', () => {
    const retMeta = {
      returnReleased: {
        at: '2026-09-02T02:00:00.000Z',
        releasedSeats: [{ cabin: 'ECONOMY', quantity: 2 }],
      },
      returnRestored: {
        at: '2026-09-02T08:00:00.000Z',
        seats: 2,
        oversold: true,
        oversoldBy: 1,
        displacedReserved: 1,
      },
      legActionLog: [
        { type: 'NO_SHOW', requestToken: 't1', at: '2026-09-02T02:00:00.000Z', seats: 2 },
        { type: 'RESTORE', requestToken: 't2', at: '2026-09-02T08:00:00.000Z', seats: 2 },
      ],
    };
    const r = aggregateNoShowReport([
      order({ items: [outboundRow(noShowMeta()), restoredReturnRow(retMeta)] }),
    ]);
    expect(r.rows[0]).toMatchObject({
      releasedSeats: 2,
      restoredSeats: 2,
      oversoldSeats: 1,
      displacedSeats: 1,
      stillReleasedSeats: 0,
    });
    expect(r.details[0].returnStatus).toBe('回程已恢复（超售 1 座）');
    expect(r.details[0].restoredAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('起飞后作废：座落 voided，不再算进当前可卖', () => {
    const retMeta = {
      returnReleased: {
        at: '2026-09-02T02:00:00.000Z',
        releasedSeats: [{ cabin: 'ECONOMY', quantity: 2 }],
      },
      returnVoidedFinal: { at: '2026-09-10T02:00:00.000Z', byUserId: 'SYSTEM' },
      legActionLog: [
        { type: 'NO_SHOW', requestToken: 't1', at: '2026-09-02T02:00:00.000Z', seats: 2 },
        { type: 'VOID', requestToken: 'job:x', at: '2026-09-10T02:00:00.000Z' },
      ],
    };
    const r = aggregateNoShowReport([
      order({ items: [outboundRow(noShowMeta()), releasedReturnRow(retMeta)] }),
    ]);
    expect(r.rows[0]).toMatchObject({ voidedSeats: 2, stillReleasedSeats: 0 });
    expect(r.details[0].voidedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(r.details[0].returnStatus).toBe('回程已作废');
  });

  it('老数据没有 legActionLog → 回落到 returnReleased 快照 + history', () => {
    const retMeta = {
      returnReleased: {
        at: '2026-09-03T02:00:00.000Z',
        releasedSeats: [{ cabin: 'ECONOMY', quantity: 2 }],
        history: [
          { at: '2026-09-02T02:00:00.000Z', releasedSeats: [{ cabin: 'ECONOMY', quantity: 1 }] },
        ],
      },
    };
    const r = aggregateNoShowReport([
      order({ items: [outboundRow(noShowMeta()), releasedReturnRow(retMeta)] }),
    ]);
    expect(r.rows[0].releasedSeats).toBe(3);
    expect(r.rows[0].stillReleasedSeats).toBe(2);
  });

  it('脏 JSON（metadata 是数组 / null）读侧不抛错', () => {
    expect(() =>
      aggregateNoShowReport([
        order({ items: [outboundRow(noShowMeta()), releasedReturnRow([1, 2, 3])] }),
        order({ id: 'ord-x', items: [outboundRow(null)] }),
      ]),
    ).not.toThrow();
  });
});

describe('aggregateNoShowReport · 工单', () => {
  it('只数 NOSHOW_* 且 OPEN/IN_PROGRESS 的工单', () => {
    const r = aggregateNoShowReport([
      order({
        reminders: [
          { ruleKey: 'NOSHOW_WITHDRAW:leg-ret:tok', status: ReminderStatus.OPEN },
          { ruleKey: 'NOSHOW_RELIST:leg-ret:tok', status: ReminderStatus.IN_PROGRESS },
          { ruleKey: 'NOSHOW_WITHDRAW:leg-ret:old', status: ReminderStatus.DONE },
          { ruleKey: 'BALANCE:ord-1:2026-09-02', status: ReminderStatus.OPEN },
          { ruleKey: null, status: ReminderStatus.OPEN },
        ],
      }),
    ]);
    expect(r.rows[0].workOrdersOpen).toBe(2);
    expect(r.details[0].workOrderStatus).toBe('待处理 2 条');
  });

  it('工单都收口了 → 明细写「已收口」；压根没派过 → 「无工单」', () => {
    const done = aggregateNoShowReport([
      order({ reminders: [{ ruleKey: 'NOSHOW_WITHDRAW:x:y', status: ReminderStatus.DONE }] }),
    ]);
    expect(done.details[0].workOrderStatus).toBe('已收口');
    expect(aggregateNoShowReport([order()]).details[0].workOrderStatus).toBe('无工单');
  });
});

describe('明细行', () => {
  it('乘客只列被标的那几位；代理为空写「直客」', () => {
    const r = aggregateNoShowReport([
      order({ agentName: null, items: [outboundRow(noShowMeta(['p-2']))] }),
    ]);
    expect(r.details[0].passengers).toBe('林晓梅');
    expect(r.details[0].agent).toBe('直客');
    expect(r.details[0].noShowAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

// ── 装载层（假 client：只钉查询口径，不碰真库）────────────────────────────
describe('loadNoShowReport · 装载口径', () => {
  function fakeClient(scheduleIds: string[]) {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = {
      $queryRaw: vi.fn().mockResolvedValue(scheduleIds.map((id) => ({ id }))),
      order: { findMany },
    } as unknown as PrismaClient;
    return { client, findMany };
  }

  // 没动过航段的单 legFlag 恒为 NONE，一个 no-show 快照都不会有。不粗筛的话，
  // 一班几百张正常单要连行带 metadata 全捞进内存再逐单丢掉。
  it('按 legFlag 粗筛（有索引），回收站单不进表', async () => {
    const { client, findMany } = fakeClient(['sch-a']);
    await loadNoShowReport('2026-09-01', '2026-09-03', client);
    const where = findMany.mock.calls[0][0].where;
    expect(where.legFlag).toEqual({ not: 'NONE' });
    expect(where.deletedAt).toBeNull();
    expect(where.items.some).toMatchObject({ flightScheduleId: { in: ['sch-a'] } });
  });

  it('区间内一个班次都没有 → 直接回空表，不去捞订单', async () => {
    const { client, findMany } = fakeClient([]);
    const r = await loadNoShowReport('2026-09-01', '2026-09-03', client);
    expect(r).toEqual({ rows: [], totals: expect.any(Object), details: [] });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('xlsx 导出', () => {
  it('文件名带区间', () => {
    expect(noShowReportFilename('2026-09-01', '2026-09-03')).toBe(
      'no-show报表_2026-09-01_2026-09-03.xlsx',
    );
  });

  it('两个 sheet：按班次汇总（末行合计）+ 逐单明细', async () => {
    const report = aggregateNoShowReport([
      order({
        items: [
          outboundRow(noShowMeta()),
          releasedReturnRow({
            returnReleased: {
              at: '2026-09-02T02:00:00.000Z',
              releasedSeats: [{ cabin: 'ECONOMY', quantity: 2 }],
            },
            legActionLog: [
              { type: 'NO_SHOW', requestToken: 't1', at: '2026-09-02T02:00:00.000Z', seats: 2 },
            ],
          }),
        ],
      }),
    ]);
    const buf = await renderNoShowReportWorkbook(report, '2026-09-01', '2026-09-03');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['按班次汇总', '逐单明细']);

    const summary = wb.getWorksheet('按班次汇总')!;
    expect(summary.getRow(1).getCell(1).value).toBe('出发日期');
    expect(summary.getRow(2).getCell(1).value).toBe('2026-09-02');
    expect(summary.getRow(2).getCell(2).value).toBe('QH9589');
    // 末行 = 合计
    const last = summary.getRow(summary.rowCount);
    expect(last.getCell(1).value).toBe('合计');
    expect(last.getCell(2).value).toBe('2026-09-01 ~ 2026-09-03');

    const detail = wb.getWorksheet('逐单明细')!;
    expect(detail.getRow(1).getCell(1).value).toBe('订单号');
    expect(detail.getRow(2).getCell(1).value).toBe('FTM20260902-001');
    expect(detail.getRow(2).getCell(7).value).toBe('回程座位已释放');
  });

  it('空区间也能导出（只有表头 + 合计行）', async () => {
    const buf = await renderNoShowReportWorkbook(
      aggregateNoShowReport([]),
      '2026-09-01',
      '2026-09-03',
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const summary = wb.getWorksheet('按班次汇总')!;
    expect(summary.rowCount).toBe(2);
    expect(summary.getRow(2).getCell(1).value).toBe('合计');
  });
});
