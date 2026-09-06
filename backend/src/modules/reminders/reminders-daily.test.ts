import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReminderPriority, UserRole } from '@prisma/client';

const { auditMock, flagMock, generateMock, pushMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  flagMock: vi.fn(),
  generateMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../../lib/feature-flags.js', () => ({ isFeatureEnabled: flagMock }));
vi.mock('../../lib/wecom-webhook.js', () => ({ pushWecomMarkdown: pushMock }));
vi.mock('./reminders.rules.js', () => ({ generateRuleReminders: generateMock }));

import { REMINDER_AUTO_LAST_RUN_KEY, runDailyReminderGeneration } from './reminders-daily.js';

function client(overrides: { priorRun?: unknown; admin?: { id: string } | null } = {}) {
  const admin = 'admin' in overrides ? overrides.admin : { id: 'admin_1' };
  return {
    user: { findFirst: vi.fn().mockResolvedValue(admin) },
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(overrides.priorRun ?? null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    operationalReminder: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  };
}

const NOW = new Date('2026-09-05T00:30:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  generateMock.mockResolvedValue({ created: 3, skipped: 1, byRule: { BALANCE_DUE: 2, DEPARTURE_SOON: 1 } });
});

describe('runDailyReminderGeneration · flag 关', () => {
  it('REMINDER_AUTO_GENERATE 关闭 → 直接跳过，不查库不生成', async () => {
    flagMock.mockResolvedValue(false);
    const db = client();

    const result = await runDailyReminderGeneration(db as never, NOW);

    expect(result.skippedReason).toBe('flag_off');
    expect(generateMock).not.toHaveBeenCalled();
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('runDailyReminderGeneration · 找不到系统起单账号', () => {
  it('没有任何 ADMIN 账号 → 跳过本轮，不写脏数据', async () => {
    flagMock.mockResolvedValue(true);
    const db = client({ admin: null });

    const result = await runDailyReminderGeneration(db as never, NOW);

    expect(result.skippedReason).toBe('no_system_actor');
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('runDailyReminderGeneration · 正常生成', () => {
  it('flag 开且找到 ADMIN → 调用 generateRuleReminders 并落 autoLastRun', async () => {
    flagMock.mockImplementation(async (_client: unknown, key: string) => key === 'REMINDER_AUTO_GENERATE');
    const db = client({ priorRun: { value: '{"at":"old"}' } }); // 非首跑

    const result = await runDailyReminderGeneration(db as never, NOW);

    expect(generateMock).toHaveBeenCalledWith(db, 'admin_1', NOW);
    expect(db.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: REMINDER_AUTO_LAST_RUN_KEY } }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GENERATE_RULE_REMINDERS',
        actor: expect.objectContaining({ userId: 'admin_1', role: 'SYSTEM' }),
      }),
    );
    expect(result.generated).toEqual({ created: 3, skipped: 1, byRule: { BALANCE_DUE: 2, DEPARTURE_SOON: 1 } });
    expect(result.isFirstRun).toBe(false);
    // REMINDER_WEBHOOK_PUSH 未开 → 不推送
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('systemSetting 之前没有记录 → 视为首跑', async () => {
    flagMock.mockResolvedValue(true);
    const db = client({ priorRun: null });

    const result = await runDailyReminderGeneration(db as never, NOW);

    expect(result.isFirstRun).toBe(true);
  });
});

describe('runDailyReminderGeneration · 企业微信推送', () => {
  beforeEach(() => {
    flagMock.mockResolvedValue(true); // 两个 flag 都开
    pushMock.mockResolvedValue({ skipped: false, ok: true });
  });

  it('非首跑：推送带各规则新增数与 CRITICAL 明细', async () => {
    const db = client({ priorRun: { value: '{}' } });
    db.operationalReminder.findMany.mockResolvedValue([
      {
        ruleKey: 'BALANCE:order_1:2026-09-10',
        dueAt: new Date('2026-09-10T00:00:00Z'),
        order: { orderNumber: 'FTM001' },
      },
    ]);
    db.operationalReminder.count.mockResolvedValue(1);

    await runDailyReminderGeneration(db as never, NOW);

    expect(pushMock).toHaveBeenCalledTimes(1);
    const text = pushMock.mock.calls[0][0] as string;
    expect(text).toContain('催尾款 2');
    expect(text).toContain('FTM001');
    expect(text).toContain('催尾款');
    expect(text).toContain('2026-09-10');
    expect(pushMock.mock.calls[0][1]).toBe('reminder-daily-summary');
  });

  it('首跑：推送只提首次自动生成提示，不列各规则新增数', async () => {
    const db = client({ priorRun: null });
    db.operationalReminder.findMany.mockResolvedValue([]);
    db.operationalReminder.count.mockResolvedValue(0);

    await runDailyReminderGeneration(db as never, NOW);

    const text = pushMock.mock.calls[0][0] as string;
    expect(text).toContain('首次自动生成，存量待办较多');
    expect(text).not.toContain('新增：');
  });

  it('CRITICAL 明细超过 10 条时提示还有更多', async () => {
    const db = client({ priorRun: { value: '{}' } });
    db.operationalReminder.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        ruleKey: `HOLD_DUE:item_${i}:2026-09-10`,
        dueAt: new Date('2026-09-10T00:00:00Z'),
        order: null,
      })),
    );
    db.operationalReminder.count.mockResolvedValue(15);

    await runDailyReminderGeneration(db as never, NOW);

    const text = pushMock.mock.calls[0][0] as string;
    expect(text).toContain('本轮共新增 15 条紧急待办');
  });

  it('operationalReminder 查询按 priority=CRITICAL 且 createdAt >= 本轮开始时间过滤', async () => {
    const db = client({ priorRun: { value: '{}' } });

    await runDailyReminderGeneration(db as never, NOW);

    expect(db.operationalReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          priority: ReminderPriority.CRITICAL,
          ruleKey: { not: null },
          createdAt: { gte: NOW },
        }),
      }),
    );
  });
});

// 系统起单账号解析：按最早创建的 ADMIN
describe('runDailyReminderGeneration · 起单人解析', () => {
  it('user.findFirst 按 role=ADMIN + createdAt asc 查询', async () => {
    flagMock.mockResolvedValue(true);
    const db = client();

    await runDailyReminderGeneration(db as never, NOW);

    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: UserRole.ADMIN },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });
});
