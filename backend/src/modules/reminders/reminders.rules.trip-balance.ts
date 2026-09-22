/**
 * 规则 13：可用次数为负（TRIP_BALANCE_NEGATIVE）
 *
 * 可用 = 已飞 + 已付款在订未飞 − 已核销（computeAvailableTrips）< 0，就是账实不符：
 * 典型是核销之后订单退改 / 删单让已飞回落，或者核销没挂单号、订单取消时没被自动冲正。
 * 台账口径本来就允许负数、不截断（截断会掩盖账实不符），这条规则负责把负数喊出来 ——
 * 运营去档案页核对：该冲正的冲正，该重新核销的重新核销。转正后自动关，同键复发重开。
 *
 * 从 reminders.rules.ts 拆出来（主文件已逼近单文件行数上限）：纯函数 + 取数块 + 收敛
 * 都在这里，主文件只在 generateRuleReminders 里调 collect / reconcile 两个入口。
 * 只 `import type` 主文件的 ReminderCandidate（编译期擦除，不产生运行期循环依赖）。
 */
import { ReminderPriority, ReminderStatus, type PrismaClient } from '@prisma/client';
import { computeAvailableTrips } from '../travelers/traveler-benefits.service.js';
import type { ReminderCandidate } from './reminders.rules.js';

/** 本规则全部 ruleKey 的前缀（收敛扫描、列表接口识别都按它）。 */
export const TRIP_BALANCE_RULE_PREFIX = 'TRIPNEG:';

/**
 * 规则 13 的 ruleKey：`TRIPNEG:{档案 id}`。
 * 档案级、稳定键：可用次数是档案的属性，负多少会变（文案就地刷新），身份不变。
 * 档案合并后台账整体搬到主档案（merge() 同事务 repoint），旧档案的负数随之消失、旧键自动关，
 * 主档案若仍为负则由主档案的键接手 —— 不需要沿链解析。
 */
export function tripBalanceRuleKey(profileId: string): string {
  return `${TRIP_BALANCE_RULE_PREFIX}${profileId}`;
}

/** ruleKey → 档案 id（列表接口拼「去档案」直达链接用）；不是本规则的键返回 null。 */
export function parseTripBalanceRuleKey(
  ruleKey: string | null | undefined,
): { profileId: string } | null {
  if (!ruleKey || !ruleKey.startsWith(TRIP_BALANCE_RULE_PREFIX)) return null;
  const profileId = ruleKey.slice(TRIP_BALANCE_RULE_PREFIX.length);
  return profileId ? { profileId } : null;
}

/** 规则 13 的输入：档案快照 + 已核销净额（取数块按 groupBy 拼好）。 */
export interface RuleTripBalanceProfile {
  id: string;
  fullName: string;
  documentNumber: string;
  tripCount: number;
  pendingPaidTripCount: number;
  redeemedTrips: number;
}

/**
 * 规则 13：可用次数 < 0 → 一条 HIGH 待办（档案级，orderId 为 null）。
 * 正文带姓名与证件号（前端契约），并把三项拆开讲清楚，运营一眼能对账。
 */
export function buildTripBalanceCandidates(
  profile: RuleTripBalanceProfile,
  today: string,
): ReminderCandidate[] {
  const availableTrips = computeAvailableTrips(profile);
  if (availableTrips >= 0) return [];
  return [
    {
      rule: 'TRIP_BALANCE_NEGATIVE',
      ruleKey: tripBalanceRuleKey(profile.id),
      orderId: null,
      title: `【可用次数为负】${profile.fullName} ${profile.documentNumber} 可用 ${availableTrips} 次`,
      body:
        `${profile.fullName}（证件号 ${profile.documentNumber}）的常旅客可用次数为 ${availableTrips}：` +
        `已飞 ${profile.tripCount} 次 + 已付款在订未飞 ${profile.pendingPaidTripCount} 次 − 已核销 ${profile.redeemedTrips} 次。` +
        `多半是核销之后订单退改 / 删单，或核销没挂单号、订单取消时没被自动冲正。` +
        `请到常旅客档案核对台账：该冲正的冲正，该重新核销的重新核销；转正后本条自动关闭。`,
      priority: ReminderPriority.HIGH,
      dueAt: today,
    },
  ];
}

// ── 取数 + 收敛 ─────────────────────────────────────────────────────────────

/** 本轮规则 13 的扫描结果（候选 + 收敛所需的上下文）。 */
export interface TripBalanceScan {
  /** 两个 delegate 齐备、这一轮真的扫过 —— 否则收敛必须整个跳过（不然会把全库旧条误关）。 */
  ran: boolean;
  candidates: ReminderCandidate[];
  /** 本轮「应该开着」的全部 ruleKey。 */
  desiredKeys: Set<string>;
}

const STALE_NOTE_RESTORED = '可用次数已转正（≥ 0），本条自动核销。';

/** 只有带这句备注的已核销条，才允许在负数复发时被重开；人工完成/跳过一律尊重。 */
const TRIP_BALANCE_AUTO_NOTES: readonly string[] = [STALE_NOTE_RESTORED];

const TRIP_BALANCE_SCAN_SKIPPED: TripBalanceScan = {
  ran: false,
  candidates: [],
  desiredKeys: new Set(),
};

/** 规则 13 取数用到的 delegate（防御式取：老测试 mock 没有它们时整条规则跳过）。 */
interface TripBalanceDelegates {
  travelerBenefitRedemption?: {
    groupBy?: (args: unknown) => Promise<
      Array<{ profileId: string; _sum: { tripsUsed: number | null } }>
    >;
  };
  travelerProfile?: {
    findMany?: (args: unknown) => Promise<
      Array<{
        id: string;
        fullName: string;
        documentNumber: string;
        tripCount: number;
        pendingPaidTripCount: number | null;
      }>
    >;
  };
}

/**
 * 规则 13 取数（档案级）。
 *
 * 可用为负必然 已核销净额 > 已飞 + 已付款在订未飞 ≥ 0 ⇒ 只有净核销 > 0 的档案才可能为负：
 * 先一条 groupBy 取全部有正净额的档案，再按 id 拉快照（两条查询，与档案数无关）。
 * 快照是上次重建的值（档案页 / 导出会刷新）—— 本规则每天跑一次，读快照够用；
 * 详情页实时重算后的数字若与快照不同，下一轮自然收敛。
 */
export async function collectTripBalanceCandidates(
  prisma: PrismaClient,
  today: string,
): Promise<TripBalanceScan> {
  const delegates = prisma as unknown as TripBalanceDelegates;
  const redemptionDelegate = delegates.travelerBenefitRedemption;
  const profileDelegate = delegates.travelerProfile;
  if (
    typeof redemptionDelegate?.groupBy !== 'function' ||
    typeof profileDelegate?.findMany !== 'function'
  ) {
    return TRIP_BALANCE_SCAN_SKIPPED;
  }

  const groups = await redemptionDelegate.groupBy({
    by: ['profileId'],
    _sum: { tripsUsed: true },
    having: { tripsUsed: { _sum: { gt: 0 } } },
    orderBy: { profileId: 'asc' },
  });
  const redeemedByProfile = new Map<string, number>();
  for (const g of groups) {
    const net = g._sum.tripsUsed ?? 0;
    if (net > 0) redeemedByProfile.set(g.profileId, net);
  }
  const candidates: ReminderCandidate[] = [];
  const desiredKeys = new Set<string>();
  if (redeemedByProfile.size === 0) return { ran: true, candidates, desiredKeys };

  const profiles = await profileDelegate.findMany({
    where: { id: { in: [...redeemedByProfile.keys()] } },
    select: {
      id: true,
      fullName: true,
      documentNumber: true,
      tripCount: true,
      pendingPaidTripCount: true,
    },
  });
  for (const p of profiles) {
    const built = buildTripBalanceCandidates(
      {
        id: p.id,
        fullName: p.fullName,
        documentNumber: p.documentNumber,
        tripCount: p.tripCount,
        pendingPaidTripCount: p.pendingPaidTripCount ?? 0,
        redeemedTrips: redeemedByProfile.get(p.id) ?? 0,
      },
      today,
    );
    for (const c of built) desiredKeys.add(c.ruleKey);
    candidates.push(...built);
  }
  return { ran: true, candidates, desiredKeys };
}

/**
 * 规则 13 的收敛（状态机，照抄规则 12 reconcileUpgradeRedeemReminders 的三条支路）：
 *   - **关**：库里仍活着、却不在本轮候选集里的条（可用已转正 / 档案被合并）→ 自动核销；
 *   - **重开**：本轮候选命中、库里那条是「自动核销」状态的（备注 ∈ TRIP_BALANCE_AUTO_NOTES）→ 就地重开、
 *     清认领人、刷成现势文案；人工完成/跳过（备注是运营自己写的）一律不动；
 *   - **刷新**：命中键且仍 OPEN/IN_PROGRESS 的条，标题/正文与本轮不一致（负得更多 / 更少）→ 就地更新。
 * 三条支路的写入都把状态条件重复进 where（status IN 原子更新）：读出来之后、写回之前运营可能刚手工
 * 处理完，只按 id 写会覆盖人工结论。ran=false 时什么都不做。
 * 必须在 generateRuleReminders 的 existing 查重 **之前** 调用（重开在前、查重在后）。
 */
export async function reconcileTripBalanceReminders(
  prisma: PrismaClient,
  scan: TripBalanceScan,
  now: Date,
): Promise<void> {
  if (!scan.ran) return;
  const candidateByKey = new Map(scan.candidates.map((c) => [c.ruleKey, c]));
  const active = await prisma.operationalReminder.findMany({
    where: {
      ruleKey: { startsWith: TRIP_BALANCE_RULE_PREFIX },
      status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] },
    },
    select: { id: true, ruleKey: true, title: true, body: true },
  });
  const toClose: string[] = [];
  const toRefresh: Array<{ id: string; title: string; body: string }> = [];
  for (const row of active) {
    if (!row.ruleKey) continue;
    if (scan.desiredKeys.has(row.ruleKey)) {
      const candidate = candidateByKey.get(row.ruleKey);
      if (candidate && (candidate.title !== row.title || candidate.body !== row.body)) {
        toRefresh.push({ id: row.id, title: candidate.title, body: candidate.body });
      }
      continue;
    }
    toClose.push(row.id);
  }

  const desired = [...scan.desiredKeys];
  const reopenRows =
    desired.length === 0
      ? []
      : await prisma.operationalReminder.findMany({
          where: {
            ruleKey: { in: desired },
            status: ReminderStatus.DONE,
            resolvedNote: { in: [...TRIP_BALANCE_AUTO_NOTES] },
          },
          select: { id: true, ruleKey: true },
        });

  if (toClose.length > 0) {
    await prisma.operationalReminder.updateMany({
      where: { id: { in: toClose }, status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] } },
      data: { status: ReminderStatus.DONE, resolvedAt: now, resolvedNote: STALE_NOTE_RESTORED },
    });
  }
  for (const row of toRefresh) {
    await prisma.operationalReminder.updateMany({
      where: { id: row.id, status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] } },
      data: { title: row.title, body: row.body },
    });
  }
  for (const row of reopenRows) {
    const candidate = row.ruleKey ? candidateByKey.get(row.ruleKey) : undefined;
    if (!candidate) continue;
    await prisma.operationalReminder.updateMany({
      where: {
        id: row.id,
        status: ReminderStatus.DONE,
        resolvedNote: { in: [...TRIP_BALANCE_AUTO_NOTES] },
      },
      data: {
        status: ReminderStatus.OPEN,
        resolvedAt: null,
        resolvedNote: null,
        // 重开 = 一条全新的待办：原认领人一并清掉，否则会出现「OPEN 但带认领人」的半状态
        claimedById: null,
        title: candidate.title,
        body: candidate.body,
        priority: candidate.priority,
        dueAt: new Date(`${candidate.dueAt}T00:00:00Z`),
      },
    });
  }
}
