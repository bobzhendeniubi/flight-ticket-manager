/**
 * 规则 13（可用次数为负）单测：纯函数 + 假 delegate 取数 + 收敛状态机。
 *
 * 覆盖：
 *   - 可用 = 已飞 + 已付款在订未飞 − 已核销 < 0 才出候选；= 0 / > 0 不出
 *   - 正文带姓名与证件号、三项拆开；ruleKey = TRIPNEG:{档案 id}，HIGH，orderId 为 null
 *   - 取数：只查净核销 > 0 的档案（负数只可能出现在这些档案上），缺列按 0
 *   - 收敛：转正自动关（status IN 原子更新）、复发重开自动核销的旧条、负得更多时就地刷新文案
 *   - delegate 不全 → ran=false，收敛整个跳过
 */
import { describe, it, expect, vi } from 'vitest';
import { ReminderStatus, type PrismaClient } from '@prisma/client';
import {
  buildTripBalanceCandidates,
  collectTripBalanceCandidates,
  parseTripBalanceRuleKey,
  reconcileTripBalanceReminders,
  tripBalanceRuleKey,
  TRIP_BALANCE_RULE_PREFIX,
} from './reminders.rules.trip-balance.js';

const TODAY = '2026-09-21';
const NOW = new Date('2026-09-21T02:00:00.000Z');

function profile(over: Partial<Parameters<typeof buildTripBalanceCandidates>[0]> = {}) {
  return {
    id: 'p1',
    fullName: 'ZHANG SAN',
    documentNumber: 'E12345678',
    tripCount: 4,
    pendingPaidTripCount: 0,
    redeemedTrips: 5,
    ...over,
  };
}

describe('buildTripBalanceCandidates 纯函数', () => {
  it('可用 < 0 → 一条 HIGH 待办，键 TRIPNEG:{档案 id}，正文带姓名/证件号与三项拆解', () => {
    const out = buildTripBalanceCandidates(profile(), TODAY);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      rule: 'TRIP_BALANCE_NEGATIVE',
      ruleKey: 'TRIPNEG:p1',
      orderId: null,
      priority: 'HIGH',
      dueAt: TODAY,
      title: '【可用次数为负】ZHANG SAN E12345678 可用 -1 次',
    });
    expect(out[0].body).toContain('ZHANG SAN');
    expect(out[0].body).toContain('E12345678');
    expect(out[0].body).toContain('已飞 4 次 + 已付款在订未飞 0 次 − 已核销 5 次');
  });

  it('已付款在订未飞把可用拉回 ≥ 0 → 不提醒（4 + 1 − 5 = 0）', () => {
    expect(buildTripBalanceCandidates(profile({ pendingPaidTripCount: 1 }), TODAY)).toEqual([]);
  });

  it('可用 > 0 不提醒', () => {
    expect(buildTripBalanceCandidates(profile({ redeemedTrips: 2 }), TODAY)).toEqual([]);
  });

  it('ruleKey 往返解析', () => {
    expect(parseTripBalanceRuleKey(tripBalanceRuleKey('abc'))).toEqual({ profileId: 'abc' });
    expect(parseTripBalanceRuleKey('UPGRADEREDEEM:x:y')).toBeNull();
    expect(parseTripBalanceRuleKey(TRIP_BALANCE_RULE_PREFIX)).toBeNull();
    expect(parseTripBalanceRuleKey(null)).toBeNull();
  });
});

function fakePrisma(opts: {
  groups?: Array<{ profileId: string; _sum: { tripsUsed: number | null } }>;
  profiles?: Array<{
    id: string;
    fullName: string;
    documentNumber: string;
    tripCount: number;
    pendingPaidTripCount: number | null;
  }>;
  active?: Array<{ id: string; ruleKey: string; title: string; body: string }>;
  reopenable?: Array<{ id: string; ruleKey: string }>;
}) {
  const reminderFindMany = vi
    .fn()
    .mockResolvedValueOnce(opts.active ?? [])
    .mockResolvedValueOnce(opts.reopenable ?? []);
  const p = {
    travelerBenefitRedemption: { groupBy: vi.fn().mockResolvedValue(opts.groups ?? []) },
    travelerProfile: { findMany: vi.fn().mockResolvedValue(opts.profiles ?? []) },
    operationalReminder: {
      findMany: reminderFindMany,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return p as unknown as PrismaClient & typeof p;
}

describe('collectTripBalanceCandidates 取数', () => {
  it('只查净核销 > 0 的档案；快照缺列按 0；负数档案出候选、正数档案不出', async () => {
    const prisma = fakePrisma({
      groups: [
        { profileId: 'neg', _sum: { tripsUsed: 6 } },
        { profileId: 'ok', _sum: { tripsUsed: 1 } },
        { profileId: 'zero', _sum: { tripsUsed: 0 } },
      ],
      profiles: [
        { id: 'neg', fullName: 'A', documentNumber: 'E1', tripCount: 5, pendingPaidTripCount: null },
        { id: 'ok', fullName: 'B', documentNumber: 'E2', tripCount: 0, pendingPaidTripCount: 1 },
      ],
    });

    const scan = await collectTripBalanceCandidates(prisma, TODAY);

    expect(scan.ran).toBe(true);
    expect([...scan.desiredKeys]).toEqual(['TRIPNEG:neg']);
    expect(scan.candidates[0].title).toBe('【可用次数为负】A E1 可用 -1 次');
    // 净额 0 的档案不进第二条查询（负数不可能出现在它身上）
    expect(prisma.travelerProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['neg', 'ok'] } } }),
    );
  });

  it('delegate 不全（老 mock）→ ran=false 且无候选', async () => {
    const prisma = { travelerProfile: { findMany: vi.fn() } } as unknown as PrismaClient;
    const scan = await collectTripBalanceCandidates(prisma, TODAY);
    expect(scan).toEqual({ ran: false, candidates: [], desiredKeys: new Set() });
  });
});

describe('reconcileTripBalanceReminders 收敛', () => {
  it('转正：库里活着、本轮不在候选 → 自动核销（where 重复带 status IN，原子更新）', async () => {
    const prisma = fakePrisma({
      active: [{ id: 'rem-1', ruleKey: 'TRIPNEG:p1', title: 't', body: 'b' }],
    });

    await reconcileTripBalanceReminders(
      prisma,
      { ran: true, candidates: [], desiredKeys: new Set() },
      NOW,
    );

    expect(prisma.operationalReminder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['rem-1'] }, status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] } },
      data: {
        status: ReminderStatus.DONE,
        resolvedAt: NOW,
        resolvedNote: '可用次数已转正（≥ 0），本条自动核销。',
      },
    });
  });

  it('复发：本轮候选命中、库里那条是自动核销过的 → 重开、清认领人、刷成现势文案', async () => {
    const candidates = buildTripBalanceCandidates(profile(), TODAY);
    const prisma = fakePrisma({ reopenable: [{ id: 'rem-1', ruleKey: 'TRIPNEG:p1' }] });

    await reconcileTripBalanceReminders(
      prisma,
      { ran: true, candidates, desiredKeys: new Set(['TRIPNEG:p1']) },
      NOW,
    );

    expect(prisma.operationalReminder.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          ruleKey: { in: ['TRIPNEG:p1'] },
          status: ReminderStatus.DONE,
          resolvedNote: { in: ['可用次数已转正（≥ 0），本条自动核销。'] },
        }),
      }),
    );
    expect(prisma.operationalReminder.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'rem-1',
        status: ReminderStatus.DONE,
        resolvedNote: { in: ['可用次数已转正（≥ 0），本条自动核销。'] },
      },
      data: expect.objectContaining({
        status: ReminderStatus.OPEN,
        resolvedAt: null,
        resolvedNote: null,
        claimedById: null,
        title: candidates[0].title,
        body: candidates[0].body,
      }),
    });
  });

  it('负得更多：键相同、文案过期 → 就地刷新，不换键', async () => {
    const candidates = buildTripBalanceCandidates(profile({ redeemedTrips: 7 }), TODAY);
    const prisma = fakePrisma({
      active: [{ id: 'rem-1', ruleKey: 'TRIPNEG:p1', title: '【可用次数为负】ZHANG SAN E12345678 可用 -1 次', body: 'old' }],
    });

    await reconcileTripBalanceReminders(
      prisma,
      { ran: true, candidates, desiredKeys: new Set(['TRIPNEG:p1']) },
      NOW,
    );

    expect(prisma.operationalReminder.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.operationalReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'rem-1', status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] } },
      data: { title: '【可用次数为负】ZHANG SAN E12345678 可用 -3 次', body: candidates[0].body },
    });
  });

  it('ran=false → 什么都不做（不会把全库旧条误关）', async () => {
    const prisma = fakePrisma({ active: [{ id: 'rem-1', ruleKey: 'TRIPNEG:p1', title: 't', body: 'b' }] });
    await reconcileTripBalanceReminders(
      prisma,
      { ran: false, candidates: [], desiredKeys: new Set() },
      NOW,
    );
    expect(prisma.operationalReminder.findMany).not.toHaveBeenCalled();
    expect(prisma.operationalReminder.updateMany).not.toHaveBeenCalled();
  });
});
