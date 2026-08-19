/**
 * 结算价立减规则：固定金额（CNY/人）叠加在结算价日历或散客套餐折扣之后。
 * 规则命中只读 active 规则；订单写入命中结果快照，历史订单不回查本表。
 */
import { Prisma, SettlementDiscountKind, SettlementTier, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import { utcDateToYmd, ymdToUtcDate } from '../settlement-rates/settlement-rates.service.js';
import type {
  DiscountRuleEntry,
  ListDiscountRulesQuery,
} from './settlement-discounts.schemas.js';

export type PrismaLike = Pick<PrismaClient, 'settlementDiscountRule' | '$transaction'>;

export interface SettlementDiscountRuleDto {
  id: string;
  kind: SettlementDiscountKind;
  agentId: string | null;
  tier: SettlementTier;
  nights: number;
  startDate: string;
  endDate: string;
  discountPerPersonCny: number;
  isActive: boolean;
  note: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SettlementDiscountHit = {
  ruleId: string;
  kind: SettlementDiscountKind;
  discountPerPersonCny: number;
};

type RuleRow = {
  id: string;
  kind: SettlementDiscountKind;
  agentId: string | null;
  tier: SettlementTier;
  nights: number;
  startDate: Date;
  endDate: Date;
  discountPerPersonCny: number;
  isActive: boolean;
  note: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function serialize(row: RuleRow): SettlementDiscountRuleDto {
  return {
    id: row.id,
    kind: row.kind,
    agentId: row.agentId,
    tier: row.tier,
    nights: row.nights,
    startDate: utcDateToYmd(row.startDate),
    endDate: utcDateToYmd(row.endDate),
    discountPerPersonCny: row.discountPerPersonCny,
    isActive: row.isActive,
    note: row.note,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateEntry(rule: DiscountRuleEntry): void {
  if (rule.discountPerPersonCny < 1 || rule.discountPerPersonCny > 20_000 || !Number.isInteger(rule.discountPerPersonCny)) {
    throw new BadRequestError('立减金额必须是 1 至 20000 元的整数');
  }
  if (rule.endDate < rule.startDate) {
    throw new BadRequestError('结束日期不能早于开始日期');
  }
  if ((rule.kind === SettlementDiscountKind.AGENT) !== Boolean(rule.agentId)) {
    throw new BadRequestError('指定代理立减必须选择代理；代理兜底和散客立减不能绑定代理');
  }
}

function groupKey(rule: { kind: SettlementDiscountKind; agentId?: string | null; tier: SettlementTier; nights: number }): string {
  return [rule.kind, rule.agentId ?? '', rule.tier, rule.nights].join('|');
}

function overlaps(a: { startDate: string | Date; endDate: string | Date }, b: { startDate: string | Date; endDate: string | Date }): boolean {
  const aStart = typeof a.startDate === 'string' ? a.startDate : utcDateToYmd(a.startDate);
  const aEnd = typeof a.endDate === 'string' ? a.endDate : utcDateToYmd(a.endDate);
  const bStart = typeof b.startDate === 'string' ? b.startDate : utcDateToYmd(b.startDate);
  const bEnd = typeof b.endDate === 'string' ? b.endDate : utcDateToYmd(b.endDate);
  return aStart <= bEnd && bStart <= aEnd;
}

function ruleLabel(rule: { id?: string; kind: SettlementDiscountKind; agentId?: string | null; startDate: string | Date; endDate: string | Date }): string {
  const start = typeof rule.startDate === 'string' ? rule.startDate : utcDateToYmd(rule.startDate);
  const end = typeof rule.endDate === 'string' ? rule.endDate : utcDateToYmd(rule.endDate);
  return `${rule.id ? `规则 ${rule.id}` : '本批规则'}（${rule.kind}${rule.agentId ? `/${rule.agentId}` : ''}，${start} 至 ${end}）`;
}

async function assertNoWindowOverlap(
  rules: DiscountRuleEntry[],
  client: PrismaLike,
): Promise<void> {
  const activeIncoming = rules.filter((r) => r.isActive !== false);
  if (activeIncoming.length === 0) return;
  const incomingIds = rules.flatMap((r) => (r.id ? [r.id] : []));
  const groups = [
    ...new Map(
      activeIncoming.map((rule) => [groupKey(rule), {
        kind: rule.kind,
        agentId: rule.agentId ?? null,
        tier: rule.tier,
        nights: rule.nights,
      }]),
    ).values(),
  ];
  const existing = await client.settlementDiscountRule.findMany({
    where: {
      isActive: true,
      ...(incomingIds.length > 0 ? { id: { notIn: incomingIds } } : {}),
      OR: groups,
    },
    orderBy: [{ startDate: 'asc' }, { updatedAt: 'desc' }],
  });

  for (let i = 0; i < activeIncoming.length; i += 1) {
    for (let j = i + 1; j < activeIncoming.length; j += 1) {
      const left = activeIncoming[i];
      const right = activeIncoming[j];
      if (groupKey(left) === groupKey(right) && overlaps(left, right)) {
        throw new BadRequestError(
          `启用立减规则的出发日期窗口重叠：${ruleLabel(left)} 与 ${ruleLabel(right)}，请拆分日期范围后再保存`,
        );
      }
    }
  }

  for (const incoming of activeIncoming) {
    const conflict = (existing as RuleRow[]).find(
      (row) => groupKey(row) === groupKey(incoming) && overlaps(row, incoming),
    );
    if (conflict) {
      throw new BadRequestError(
        `启用立减规则的出发日期窗口重叠：${ruleLabel(incoming)} 与 ${ruleLabel(conflict)}，请拆分日期范围后再保存`,
      );
    }
  }
}

export async function listDiscountRules(
  q: ListDiscountRulesQuery,
  client: PrismaLike = defaultPrisma,
): Promise<SettlementDiscountRuleDto[]> {
  if (q.from && q.to && q.from > q.to) {
    throw new BadRequestError('起始日期不能晚于结束日期');
  }
  const rows = await client.settlementDiscountRule.findMany({
    where: {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.agentId ? { agentId: q.agentId } : {}),
      ...(q.tier ? { tier: q.tier } : {}),
      ...(q.nights != null ? { nights: q.nights } : {}),
      ...(q.from || q.to
        ? {
            endDate: q.from ? { gte: ymdToUtcDate(q.from) } : undefined,
            startDate: q.to ? { lte: ymdToUtcDate(q.to) } : undefined,
          }
        : {}),
    },
    orderBy: [{ startDate: 'asc' }, { kind: 'asc' }, { nights: 'asc' }],
  });
  return (rows as RuleRow[]).map(serialize);
}

export async function listDiscountRulesByIds(
  ids: string[],
  client: PrismaLike = defaultPrisma,
): Promise<SettlementDiscountRuleDto[]> {
  if (ids.length === 0) return [];
  const rows = await client.settlementDiscountRule.findMany({
    where: { id: { in: [...new Set(ids)] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return (rows as RuleRow[]).map(serialize);
}

export async function upsertDiscountRules(
  rules: DiscountRuleEntry[],
  userId: string | null,
  client: PrismaLike = defaultPrisma,
): Promise<SettlementDiscountRuleDto[]> {
  if (rules.length < 1 || rules.length > 200) {
    throw new BadRequestError('每次至少保存 1 条、最多保存 200 条立减规则');
  }
  rules.forEach(validateEntry);
  await assertNoWindowOverlap(rules, client);

  const operations = rules.map((r) => {
    const data = {
      kind: r.kind,
      agentId: r.agentId ?? null,
      tier: r.tier,
      nights: r.nights,
      startDate: ymdToUtcDate(r.startDate),
      endDate: ymdToUtcDate(r.endDate),
      discountPerPersonCny: r.discountPerPersonCny,
      isActive: r.isActive !== false,
      note: r.note ?? null,
      updatedBy: userId,
    };
    if (r.id) {
      return client.settlementDiscountRule.update({ where: { id: r.id }, data });
    }
    return client.settlementDiscountRule.create({ data });
  });
  let rows: unknown;
  try {
    rows = await client.$transaction(operations);
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new BadRequestError(
        '启用立减规则的出发日期窗口重叠：并发保存检测到已有重叠规则，请拆分日期范围后再保存',
      );
    }
    throw error;
  }
  return (rows as RuleRow[]).map(serialize);
}

export async function deleteDiscountRule(
  id: string,
  client: PrismaLike = defaultPrisma,
): Promise<SettlementDiscountRuleDto | null> {
  const existing = await client.settlementDiscountRule.findUnique({ where: { id } });
  if (!existing) return null;
  try {
    await client.settlementDiscountRule.delete({ where: { id } });
  } catch (error) {
    if (isPrismaCode(error, 'P2025')) return null;
    throw error;
  }
  return serialize(existing as RuleRow);
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === code) ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code)
  );
}

function isExclusionViolation(error: unknown): boolean {
  if (isPrismaCode(error, '23P01')) return true;
  if (isPrismaCode(error, 'P2010')) {
    const meta = (error as { meta?: { code?: unknown; message?: unknown } }).meta;
    return meta?.code === '23P01' || String(meta?.message ?? '').includes('exclusion_violation');
  }
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; detail?: unknown };
  return (
    candidate.code === '23P01' ||
    candidate.code === 'exclusion_violation' ||
    `${candidate.message ?? ''} ${candidate.detail ?? ''}`.includes('exclusion_violation')
  );
}

function latestHit(rows: RuleRow[], layer: SettlementDiscountKind): SettlementDiscountHit | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  if (rows.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(`[settlement-discounts] 同层存在 ${rows.length} 条命中规则，已取 updatedAt 最新的一条`, {
      kind: layer,
      ruleIds: rows.map((r) => r.id),
    });
  }
  const row = sorted[0];
  return {
    ruleId: row.id,
    kind: row.kind,
    discountPerPersonCny: row.discountPerPersonCny,
  };
}

async function findMatching(
  kind: SettlementDiscountKind,
  agentId: string | null,
  tier: SettlementTier,
  nights: number,
  departDate: string,
  client: PrismaLike,
): Promise<RuleRow[]> {
  // 旧订单单测可能只 mock 结算价 delegate；缺少规则表时按“无命中”降级，真实 Prisma 始终具备该 delegate。
  const delegate = (client as unknown as {
    settlementDiscountRule?: { findMany?: unknown };
  }).settlementDiscountRule;
  if (!delegate || typeof delegate.findMany !== 'function') {
    return [];
  }
  return (await client.settlementDiscountRule.findMany({
    where: {
      kind,
      agentId,
      tier,
      nights,
      isActive: true,
      startDate: { lte: ymdToUtcDate(departDate) },
      endDate: { gte: ymdToUtcDate(departDate) },
    },
    orderBy: { updatedAt: 'desc' },
  })) as RuleRow[];
}

export async function resolveAgentSettlementDiscount(
  agentId: string,
  tier: SettlementTier,
  nights: number,
  departDate: string,
  client: PrismaLike = defaultPrisma,
): Promise<SettlementDiscountHit | null> {
  const specific = await findMatching(
    SettlementDiscountKind.AGENT,
    agentId,
    tier,
    nights,
    departDate,
    client,
  );
  const specificHit = latestHit(specific, SettlementDiscountKind.AGENT);
  if (specificHit) return specificHit;

  const fallback = await findMatching(
    SettlementDiscountKind.AGENT_DEFAULT,
    null,
    tier,
    nights,
    departDate,
    client,
  );
  return latestHit(fallback, SettlementDiscountKind.AGENT_DEFAULT);
}

export async function resolveRetailSettlementDiscount(
  tier: SettlementTier,
  nights: number,
  departDate: string,
  client: PrismaLike = defaultPrisma,
): Promise<SettlementDiscountHit | null> {
  const rows = await findMatching(
    SettlementDiscountKind.RETAIL,
    null,
    tier,
    nights,
    departDate,
    client,
  );
  return latestHit(rows, SettlementDiscountKind.RETAIL);
}
