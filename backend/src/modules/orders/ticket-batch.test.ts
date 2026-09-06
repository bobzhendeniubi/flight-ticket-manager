/**
 * 按航班批量回填票号 · 行解析内核 + 编排层单测（mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. 行解析：逗号/Tab/空格三种分隔都认；票面 784- 连字符去掉；只给票号不给 PNR；
 *      纯空格行里**纯字母**的 PNR 不猜（宁可整行落未匹配，也不把客人的名字当订座编码存进去）；
 *      格式不对的行整行落 invalid，不半收；表头行跳过；超上限如实回 totalLines / truncated。
 *   2. 匹配：护照号优先、姓名兜底、同名不猜（落 ambiguous）；对外只出证件号后 4 位。
 *   3. 预检比对：新填 / 原样重填（unchanged）/ 覆盖不同的号（conflict）三态；
 *      同一人被两行互补合并；两行给出不同号 → rosterConflict，不猜。
 *   4. 执行：班次不符与非占座态 fail-closed 跳过；有不同号且没带 overwrite → TICKET_CONFLICT；
 *      带了 overwrite 才写；重发同一批 → changedFields 为空、一个字段都不写（幂等）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrderStatus, UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findMany: vi.fn() },
    flightSchedule: { findUnique: vi.fn() },
    passenger: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { executeTicketBatch, previewTicketBatch } from './ticket-batch.js';
import {
  TICKET_ROSTER_MAX_LINES,
  parseTicketRosterLine,
  parseTicketRosterLines,
} from './ticket-roster.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

const ADMIN = { userId: 'admin-1', role: UserRole.ADMIN } as const;
const STAFF = { userId: 'staff-1', role: UserRole.STAFF } as const;
const AGENT = { userId: 'agent-1', role: UserRole.AGENT } as const;
const SCHEDULE_ID = 'sch-out';
const BATCH_TOKEN = 'b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const DEPART = new Date('2026-09-05T01:40:00.000Z');

/** 一张 2 人单挂在 sch-out 上：p-1 只有沙箱票号，p-2 只有一个旧 PNR。 */
function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    orderNumber: 'FTM2026090100001',
    status: OrderStatus.TICKETED,
    passengers: [
      {
        id: 'p-1',
        fullName: 'CHEN/ZHIYUAN',
        chineseName: '陈志远',
        documentNumber: 'E10000001',
        lastName: 'CHEN',
        firstName: 'ZHIYUAN',
        pnr: null,
        eticketNumber: '12345678901234567',
      },
      {
        id: 'p-2',
        fullName: 'LIN/XIAOMEI',
        chineseName: '林晓梅',
        documentNumber: 'E20000002',
        lastName: 'LIN',
        firstName: 'XIAOMEI',
        pnr: 'OLDPN1',
        eticketNumber: null,
      },
    ],
    ...over,
  };
}

function scheduleRow() {
  return {
    id: SCHEDULE_ID,
    departureTime: DEPART,
    departureTz: 'Asia/Shanghai',
    flight: { flightNumber: 'QH9588' },
    seatClasses: [{ sold: 120 }, { sold: 8 }],
  };
}

beforeEach(() => {
  mockPrisma.order.findMany.mockReset();
  mockPrisma.flightSchedule.findUnique.mockReset();
  mockPrisma.passenger.findUnique.mockReset();
  mockPrisma.passenger.update.mockReset();
  mockPrisma.$transaction.mockReset();
  mockPrisma.flightSchedule.findUnique.mockResolvedValue(scheduleRow());
  mockPrisma.order.findMany.mockResolvedValue([orderRow()]);
  // 事务体直接拿同一个 mock 当 tx 跑（本模块的事务里只有一读一写）。
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
});

// ── 1. 行解析 ────────────────────────────────────────────────────────────
describe('parseTicketRosterLine', () => {
  it('逗号分列 + 票面连字符：三列各就各位，票号去掉 784- 的横杠', () => {
    expect(parseTicketRosterLine('E12345678, 7QRS9K, 784-1234567890')).toEqual({
      line: 'E12345678, 7QRS9K, 784-1234567890',
      identity: 'E12345678',
      pnr: '7QRS9K',
      eticketNumber: '7841234567890',
      error: null,
    });
  });

  it('Tab 分列（表格粘贴）：姓名里的空格不被当成分隔符', () => {
    const row = parseTicketRosterLine('ZHANG SAN\tABC12\t12345678901234567');
    expect(row.identity).toBe('ZHANG SAN');
    expect(row.pnr).toBe('ABC12');
    expect(row.eticketNumber).toBe('12345678901234567');
  });

  it('两列：第 2 列长得像票号就当票号，像 PNR 就当 PNR', () => {
    expect(parseTicketRosterLine('E12345678,7841234567890').eticketNumber).toBe('7841234567890');
    expect(parseTicketRosterLine('E12345678,7841234567890').pnr).toBeNull();
    expect(parseTicketRosterLine('E12345678,7QRS9K').pnr).toBe('7QRS9K');
    expect(parseTicketRosterLine('E12345678,7QRS9K').eticketNumber).toBeNull();
  });

  it('纯空格行：从右往左认，含数字的 PNR 收得进来', () => {
    const row = parseTicketRosterLine('ZHANG SAN 7QRS9K 7841234567890');
    expect(row.identity).toBe('ZHANG SAN');
    expect(row.pnr).toBe('7QRS9K');
    expect(row.eticketNumber).toBe('7841234567890');
  });

  it('纯空格行 + 纯字母 PNR：不猜，整段留在姓名里（宁可匹配不上也不认错人）', () => {
    const row = parseTicketRosterLine('ZHANG XIAOMING 7841234567890');
    expect(row.identity).toBe('ZHANG XIAOMING');
    expect(row.pnr).toBeNull();
    expect(row.eticketNumber).toBe('7841234567890');
  });

  it('票号长度不对 → 整行 error，pnr 也不半收', () => {
    const row = parseTicketRosterLine('E12345678,7QRS9K,12345');
    expect(row.error).toContain('电子票号');
    expect(row.pnr).toBeNull();
    expect(row.eticketNumber).toBeNull();
  });

  it('只有一段内容 → error（认不出这是谁的什么号）', () => {
    expect(parseTicketRosterLine('E12345678').error).not.toBeNull();
  });

  it('既没有 PNR 也没有票号 → error', () => {
    expect(parseTicketRosterLine('ZHANG SAN,,').error).toContain('既没有 PNR 也没有票号');
  });
});

describe('parseTicketRosterLines', () => {
  it('跳表头、去空行、按原文去重', () => {
    const res = parseTicketRosterLines(
      ['姓名,PNR,票号', 'E1,7QRS9K,7841234567890', '', 'E1,7QRS9K,7841234567890'].join('\n'),
    );
    expect(res.totalLines).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect(res.truncated).toBe(false);
  });

  it('超上限：只处理前 N 行，但总行数与截断标记如实回（绝不静默丢）', () => {
    const many = Array.from(
      { length: TICKET_ROSTER_MAX_LINES + 20 },
      (_, i) => `E${i},7QRS9K,${String(7841000000000 + i)}`,
    ).join('\n');
    const res = parseTicketRosterLines(many);
    expect(res.totalLines).toBe(TICKET_ROSTER_MAX_LINES + 20);
    expect(res.rows).toHaveLength(TICKET_ROSTER_MAX_LINES);
    expect(res.truncated).toBe(true);
  });
});

// ── 2 & 3. 预检 ──────────────────────────────────────────────────────────
describe('previewTicketBatch', () => {
  it('非 ADMIN/STAFF（代理）→ 403，一次库都不查', async () => {
    const err = await previewTicketBatch({}, { scheduleId: SCHEDULE_ID, lines: '' }, AGENT).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.flightSchedule.findUnique).not.toHaveBeenCalled();
  });

  it('班次不存在 → 404', async () => {
    mockPrisma.flightSchedule.findUnique.mockResolvedValue(null);
    const err = await previewTicketBatch({}, { scheduleId: 'nope', lines: 'x,y,z' }, ADMIN).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('班次抬头：按 departureTz 折算当地日与时刻，座位数是逐舱之和', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E10000001,7QRS9K,7841234567890' },
      ADMIN,
    );
    expect(res.schedule.flightNumber).toBe('QH9588');
    expect(res.schedule.departDate).toBe('2026-09-05');
    expect(res.schedule.departTimeLocal).toBe('09:40');
    expect(res.schedule.seatsSold).toBe(128);
  });

  it('护照号优先命中；对外只出证件号后 4 位', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E10000001,7QRS9K,7841234567890' },
      ADMIN,
    );
    expect(res.matched).toHaveLength(1);
    const row = res.matched[0];
    expect(row.matchedBy).toBe('DOCUMENT');
    expect(row.passengerId).toBe('p-1');
    expect(row.documentTail).toBe('0001');
    // 完整证件号绝不出现在响应里（名单原文那一行是操作人自己贴的，不算我们下发的 PII）。
    expect(JSON.stringify(res.matched)).not.toContain('E20000002');
  });

  it('姓名兜底命中（没给护照号时按英文名匹配）', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'CHEN/ZHIYUAN,7QRS9K,7841234567890' },
      ADMIN,
    );
    expect(res.matched[0].matchedBy).toBe('NAME');
    expect(res.matched[0].passengerId).toBe('p-1');
  });

  it('冲突：库里已有一个不同的沙箱票号 → conflict + conflictFields', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E10000001,7QRS9K,7841234567890' },
      ADMIN,
    );
    const row = res.matched[0];
    expect(row.currentEticketNumber).toBe('12345678901234567');
    expect(row.conflict).toBe(true);
    expect(row.conflictFields).toEqual(['eticketNumber']);
    // PNR 原本是空的 → 填上去不算冲突
    expect(row.conflictFields).not.toContain('pnr');
    expect(row.unchanged).toBe(false);
  });

  it('原样重填：库里已经就是这个号 → unchanged，且不算冲突', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E20000002,OLDPN1,' },
      ADMIN,
    );
    const row = res.matched[0];
    expect(row.passengerId).toBe('p-2');
    expect(row.unchanged).toBe(true);
    expect(row.conflict).toBe(false);
  });

  it('同一人被两行互补命中（一行给 PNR、一行给票号）→ 合并成一条，原文行都留着', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E10000001,7QRS9K,\n陈志远,,7841234567890' },
      ADMIN,
    );
    expect(res.matched).toHaveLength(1);
    expect(res.matched[0].lines).toHaveLength(2);
    expect(res.matched[0].pnr).toBe('7QRS9K');
    expect(res.matched[0].eticketNumber).toBe('7841234567890');
  });

  it('名单自相矛盾（同一人两个不同 PNR）→ rosterConflict + blockers，不猜', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E10000001,7QRS9K,\n陈志远,ZZZ99,' },
      ADMIN,
    );
    expect(res.matched[0].rosterConflict).toBe(true);
    expect(res.matched[0].blockers[0]).toContain('两个不同的PNR');
  });

  it('这一班里没有的人 → unmatched；行格式不对 → invalid（两类分开摆）', async () => {
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'E99999999,7QRS9K,7841234567890\nE10000001,7QRS9K,12345' },
      ADMIN,
    );
    expect(res.unmatched).toEqual([
      { line: 'E99999999,7QRS9K,7841234567890', identity: 'E99999999' },
    ]);
    expect(res.invalid).toHaveLength(1);
    expect(res.invalid[0].error).toContain('电子票号');
  });

  it('同名撞车 → ambiguous，系统不猜（候选带 orderId/passengerId 供人工点选）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      orderRow(),
      orderRow({
        id: 'ord-2',
        orderNumber: 'FTM2026090100002',
        passengers: [
          {
            id: 'p-3',
            fullName: 'CHEN/ZHIYUAN',
            chineseName: '陈志远',
            documentNumber: 'E30000003',
            lastName: 'CHEN',
            firstName: 'ZHIYUAN',
            pnr: null,
            eticketNumber: null,
          },
        ],
      }),
    ]);
    const res = await previewTicketBatch(
      {},
      { scheduleId: SCHEDULE_ID, lines: 'CHEN/ZHIYUAN,7QRS9K,7841234567890' },
      ADMIN,
    );
    expect(res.matched).toHaveLength(0);
    expect(res.ambiguous).toHaveLength(1);
    expect(res.ambiguous[0].candidates.map((c) => c.passengerId).sort()).toEqual(['p-1', 'p-3']);
    expect(res.ambiguous[0].eticketNumber).toBe('7841234567890');
  });
});

// ── 4. 执行 ──────────────────────────────────────────────────────────────
describe('executeTicketBatch', () => {
  const baseEntry = {
    orderId: 'ord-1',
    passengerId: 'p-1',
    pnr: '7QRS9K',
    eticketNumber: '7841234567890',
  };

  function headRow(over: Record<string, unknown> = {}) {
    return {
      id: 'ord-1',
      orderNumber: 'FTM2026090100001',
      status: OrderStatus.TICKETED,
      deletedAt: null,
      items: [{ flightScheduleId: SCHEDULE_ID }],
      ...over,
    };
  }

  it('非 ADMIN/STAFF → 403', async () => {
    const err = await executeTicketBatch(
      {},
      { requestToken: BATCH_TOKEN, scheduleId: SCHEDULE_ID, entries: [baseEntry] },
      AGENT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('订单不在本班次 → SCHEDULE_MISMATCH 跳过，不写库（fail-closed）', async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      headRow({ items: [{ flightScheduleId: 'other' }] }),
    ]);
    const res = await executeTicketBatch(
      {},
      { requestToken: BATCH_TOKEN, scheduleId: SCHEDULE_ID, entries: [baseEntry] },
      ADMIN,
    );
    expect(res.results[0].code).toBe('SCHEDULE_MISMATCH');
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('订单已取消（非占座态）→ ORDER_NOT_HOLDING，引导去单人回填', async () => {
    mockPrisma.order.findMany.mockResolvedValue([headRow({ status: OrderStatus.CANCELLED })]);
    const res = await executeTicketBatch(
      {},
      { requestToken: BATCH_TOKEN, scheduleId: SCHEDULE_ID, entries: [baseEntry] },
      ADMIN,
    );
    expect(res.results[0].code).toBe('ORDER_NOT_HOLDING');
    expect(res.results[0].error).toContain('单人回填');
  });

  it('库里已有不同的票号且没带 overwrite → TICKET_CONFLICT，一个字段都不写', async () => {
    mockPrisma.order.findMany.mockResolvedValue([headRow()]);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p-1',
      orderId: 'ord-1',
      fullName: 'CHEN/ZHIYUAN',
      pnr: null,
      eticketNumber: '12345678901234567',
    });
    const res = await executeTicketBatch(
      {},
      { requestToken: BATCH_TOKEN, scheduleId: SCHEDULE_ID, entries: [baseEntry] },
      ADMIN,
    );
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].code).toBe('TICKET_CONFLICT');
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
    expect(res.summary).toEqual({ ok: 0, failed: 1, changed: 0, unchanged: 0 });
  });

  it('带 overwrite:true → 覆盖沙箱号，两列一起写', async () => {
    mockPrisma.order.findMany.mockResolvedValue([headRow()]);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p-1',
      orderId: 'ord-1',
      fullName: 'CHEN/ZHIYUAN',
      pnr: null,
      eticketNumber: '12345678901234567',
    });
    const res = await executeTicketBatch(
      {},
      {
        requestToken: BATCH_TOKEN,
        scheduleId: SCHEDULE_ID,
        entries: [{ ...baseEntry, overwrite: true }],
      },
      STAFF,
    );
    expect(mockPrisma.passenger.update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { pnr: '7QRS9K', eticketNumber: '7841234567890' },
    });
    expect(res.results[0].changedFields).toEqual(['pnr', 'eticketNumber']);
    expect(res.summary).toEqual({ ok: 1, failed: 0, changed: 1, unchanged: 0 });
  });

  it('重发同一批（库里已经是这个号）→ 幂等：不写库，changedFields 为空，计进 unchanged', async () => {
    mockPrisma.order.findMany.mockResolvedValue([headRow()]);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p-1',
      orderId: 'ord-1',
      fullName: 'CHEN/ZHIYUAN',
      pnr: '7QRS9K',
      eticketNumber: '7841234567890',
    });
    const res = await executeTicketBatch(
      {},
      { requestToken: BATCH_TOKEN, scheduleId: SCHEDULE_ID, entries: [baseEntry] },
      ADMIN,
    );
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
    expect(res.results[0].ok).toBe(true);
    expect(res.results[0].changedFields).toEqual([]);
    expect(res.summary).toEqual({ ok: 1, failed: 0, changed: 0, unchanged: 1 });
  });

  it('出行人已被换人/拆走 → PASSENGER_NOT_FOUND 跳过，不影响其它条', async () => {
    mockPrisma.order.findMany.mockResolvedValue([headRow()]);
    mockPrisma.passenger.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'p-2',
      orderId: 'ord-1',
      fullName: 'LIN/XIAOMEI',
      pnr: null,
      eticketNumber: null,
    });
    const res = await executeTicketBatch(
      {},
      {
        requestToken: BATCH_TOKEN,
        scheduleId: SCHEDULE_ID,
        entries: [baseEntry, { orderId: 'ord-1', passengerId: 'p-2', pnr: 'ABC12' }],
      },
      ADMIN,
    );
    expect(res.results[0].code).toBe('PASSENGER_NOT_FOUND');
    expect(res.results[1].ok).toBe(true);
    expect(res.summary).toEqual({ ok: 1, failed: 1, changed: 1, unchanged: 0 });
  });
});
