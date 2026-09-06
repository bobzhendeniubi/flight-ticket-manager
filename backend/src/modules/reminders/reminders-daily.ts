/**
 * 提醒每日自动生成 —— 由 BullMQ `reminder-daily` repeat 任务驱动（每天北京时间 08:30）。
 *
 * 受 REMINDER_AUTO_GENERATE feature flag 控制：关闭时直接跳过（不生成、不推送）——
 * 上线当天默认关，运营确认口径后再手动打开。
 *
 * 起单人（OperationalReminder.createdById 是必填的真实 User 外键；本仓库没有专门的
 * 「系统账号」，加一个要建表/迁移，本次禁止动 schema）：复用最早创建的 ADMIN 账号 id。
 * 这与 hold-overdue / no-show-void 里 `actor:{label:'system:...', role:'SYSTEM'}` 不是
 * 一回事——那两处只是审计标签（AuditLog.actorUserId 允许为空），这里必须是能通过外键
 * 校验的真实账号。找不到 ADMIN 账号就跳过本轮并记错误日志，不瞎猜一个 id 写脏数据。
 *
 * 首跑保护：SystemSetting['reminder.autoLastRun'] 之前不存在 = 第一次跑。生成照常
 *（把历史欠账一次性补全），但企业微信推送只发 CRITICAL 明细并注明「首次自动生成，
 * 存量待办较多」——防止上线当天一堆存量提醒把群聊刷屏。
 */
import { ReminderPriority, UserRole, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { writeAudit } from '../../lib/audit.js';
import { businessDateISO } from '../../lib/business-time.js';
import { isFeatureEnabled } from '../../lib/feature-flags.js';
import { pushWecomMarkdown } from '../../lib/wecom-webhook.js';
import { generateRuleReminders, type GenerateRuleRemindersResult } from './reminders.rules.js';

export const REMINDER_AUTO_LAST_RUN_KEY = 'reminder.autoLastRun';
export const REMINDER_MANUAL_LAST_RUN_KEY = 'reminder.manualLastRun';

/**
 * ruleKey 前缀 → 中文名，给企业微信 CRITICAL 明细用。
 *
 * ⚠️ OperationalReminder 表只落 ruleKey，不落 reminders.rules.ts 里的 `rule` 字段（那个
 * 字段只活在内存候选对象上），所以这里按 ruleKey 的前缀反查，不能照抄 admin-web
 * RemindersPage 那份按 `rule` 字段名建的 RULE_LABEL——两份 key 空间不一样，见
 * generateRuleReminders 里各条 `ruleKey: \`XXX:...\`` 的字面量前缀。
 */
const RULE_KEY_PREFIX_LABEL: Record<string, string> = {
  BALANCE: '催尾款',
  DEPART: '出行提醒',
  PPEXP: '护照有效期',
  TICKET: '临近出发未出票',
  ROOMASSIGN: '临近入住未分房',
  VISAMISS: '签证缺件',
  VISASUBMIT: '临近出发未送签',
  CLAIMVERIFY: '到账待核实',
  RANDOMSHORTFALL: '随机档缺口',
  HOLD_DUE: '占位单催款',
  NOSHOW_RELEASED: '回程已释放待跟进',
};

/** byRule 汇总用：按 generateRuleReminders 返回的 `rule` 字段名（与 admin-web 同口径）。 */
const RULE_NAME_LABEL: Record<string, string> = {
  BALANCE_DUE: '催尾款',
  DEPARTURE_SOON: '出行提醒',
  PASSPORT_EXPIRY: '护照有效期',
  VISA_MISSING: '签证缺件',
  HOLD_INSTALLMENT_DUE: '占位单催款',
  TICKET_MISSING: '临近出发未出票',
  VISA_NOT_SUBMITTED: '临近出发未送签',
  ROOM_UNASSIGNED: '临近入住未分房',
  RECEIPT_UNVERIFIED: '到账待核实',
  RANDOM_TIER_SHORTFALL: '随机档缺口',
  NO_SHOW_RETURN_RELEASED: '回程已释放待跟进',
};

function ruleKeyLabel(ruleKey: string | null): string {
  if (!ruleKey) return '手工创建';
  const prefix = ruleKey.split(':')[0];
  return RULE_KEY_PREFIX_LABEL[prefix] ?? prefix;
}

export interface DailyReminderRunResult {
  ranAt: string;
  skippedReason?: 'flag_off' | 'no_system_actor';
  generated?: GenerateRuleRemindersResult;
  isFirstRun?: boolean;
}

/** 找一个能当自动生成「起单人」的真实账号：最早创建的 ADMIN。 */
async function resolveSystemReminderActorId(client: PrismaClient): Promise<string | null> {
  const admin = await client.user.findFirst({
    where: { role: UserRole.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return admin?.id ?? null;
}

export async function runDailyReminderGeneration(
  client: PrismaClient = defaultPrisma,
  now = new Date(),
): Promise<DailyReminderRunResult> {
  const ranAt = now.toISOString();
  const enabled = await isFeatureEnabled(client, 'REMINDER_AUTO_GENERATE');
  if (!enabled) return { ranAt, skippedReason: 'flag_off' };

  const priorRun = await client.systemSetting.findUnique({
    where: { key: REMINDER_AUTO_LAST_RUN_KEY },
  });
  const isFirstRun = !priorRun;

  const systemActorId = await resolveSystemReminderActorId(client);
  if (!systemActorId) {
    // eslint-disable-next-line no-console
    console.error(
      '[reminder-daily] 找不到任何 ADMIN 账号，跳过本轮自动生成（生成需要一个真实账号作为起单人）',
    );
    return { ranAt, skippedReason: 'no_system_actor' };
  }

  const result = await generateRuleReminders(client, systemActorId, now);

  const runSummary = { at: ranAt, created: result.created, byRule: result.byRule };
  await client.systemSetting.upsert({
    where: { key: REMINDER_AUTO_LAST_RUN_KEY },
    create: { key: REMINDER_AUTO_LAST_RUN_KEY, value: JSON.stringify(runSummary), updatedById: systemActorId },
    update: { value: JSON.stringify(runSummary), updatedById: systemActorId },
  });

  void writeAudit({
    actor: { userId: systemActorId, label: 'system:reminder-daily', role: 'SYSTEM' },
    action: 'GENERATE_RULE_REMINDERS',
    targetType: 'SYSTEM',
    after: { created: result.created, skipped: result.skipped, byRule: result.byRule, auto: true, isFirstRun },
  });

  if (await isFeatureEnabled(client, 'REMINDER_WEBHOOK_PUSH')) {
    await pushDailySummaryToWecom(client, { ranAt, result, isFirstRun });
  }

  return { ranAt, generated: result, isFirstRun };
}

const CRITICAL_DIGEST_LIMIT = 10;

async function pushDailySummaryToWecom(
  client: PrismaClient,
  input: { ranAt: string; result: GenerateRuleRemindersResult; isFirstRun: boolean },
): Promise<void> {
  const today = businessDateISO(new Date(input.ranAt));
  // 本轮新增的 CRITICAL 明细：createMany 不回传行，按「本轮开始之后创建」反查——
  // 幂等跳过的旧记录 createdAt 更早，不会混进来；ruleKey 非空排掉恰好同时手工创建的条目。
  const criticalWhere = {
    priority: ReminderPriority.CRITICAL,
    ruleKey: { not: null },
    createdAt: { gte: new Date(input.ranAt) },
  } as const;
  const [criticalRows, criticalTotal] = await Promise.all([
    client.operationalReminder.findMany({
      where: criticalWhere,
      orderBy: { createdAt: 'asc' },
      take: CRITICAL_DIGEST_LIMIT,
      include: { order: { select: { orderNumber: true } } },
    }),
    client.operationalReminder.count({ where: criticalWhere }),
  ]);

  const lines: string[] = [];
  if (input.isFirstRun) {
    lines.push(`### 提醒每日自动生成 · ${today}（首次自动生成，存量待办较多）`);
  } else {
    lines.push(`### 提醒每日自动生成 · ${today}`);
    const byRuleEntries = Object.entries(input.result.byRule);
    lines.push(
      byRuleEntries.length > 0
        ? `新增：${byRuleEntries.map(([k, n]) => `${RULE_NAME_LABEL[k] ?? k} ${n}`).join('，')}`
        : '本轮无新增待办。',
    );
  }

  if (criticalRows.length > 0) {
    lines.push('', `紧急（CRITICAL）明细（前 ${criticalRows.length} 条）：`);
    for (const row of criticalRows) {
      const dueAt = row.dueAt ? row.dueAt.toISOString().slice(0, 10) : '—';
      lines.push(`- ${row.order?.orderNumber ?? '（无关联订单）'} · ${ruleKeyLabel(row.ruleKey)} · 出发日 ${dueAt}`);
    }
    if (criticalTotal > criticalRows.length) {
      lines.push(`本轮共新增 ${criticalTotal} 条紧急待办，其余请到提醒中心查看。`);
    }
  }

  await pushWecomMarkdown(lines.join('\n'), 'reminder-daily-summary', client);
}
