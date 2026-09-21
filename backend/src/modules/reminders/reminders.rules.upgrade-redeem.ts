/**
 * 规则 12：次数升级待核销（UPGRADE_REDEEM_PENDING）
 *
 * 「次数升级」（Passenger.upgradeRedeemLeg）只是录单时打的执行标签，票务据此给这一程
 * 排商务舱；真正扣常旅客次数的是权益核销台账（TravelerBenefitRedemption）。两边此前零
 * 交叉：标了升舱、飞完了，却没人去档案里扣一次，可用次数虚高，客人等于白拿一次额度。
 * 这条规则就是那座桥 —— 可用次数口径不动（仍是「已飞 − 已核销」），只在该扣没扣时喊一声。
 *
 * 从 reminders.rules.ts 拆出来（主文件已逼近约定的单文件行数上限）：纯函数 + 取数块 +
 * 收敛（状态机）都在这里，主文件只在 generateRuleReminders 里调 collect / reconcile 两个
 * 入口，并把纯函数原样 re-export（老调用方/测试的 import 路径不变）。
 *
 * 只 `import type` 主文件的 ReminderCandidate（类型在编译期擦除，不产生运行期循环依赖）。
 */
import { Prisma, ReminderPriority, ReminderStatus, UpgradeRedeemLeg, type PrismaClient } from '@prisma/client';
import { localDateISO, localToUtc } from '../../lib/flight-time.js';
import type { ReminderCandidate } from './reminders.rules.js';

/** 兑换航段 → 中文（与前端 PassengerPrefChips 的标签一字不差）。 */
const UPGRADE_REDEEM_LEG_LABEL: Record<string, string> = {
  [UpgradeRedeemLeg.OUTBOUND]: '去程',
  [UpgradeRedeemLeg.RETURN]: '回程',
  [UpgradeRedeemLeg.BOTH]: '往返',
};

/** 本规则全部 ruleKey 的前缀（收敛扫描、列表接口识别都按它）。 */
export const UPGRADE_REDEEM_RULE_PREFIX = 'UPGRADEREDEEM:';

/**
 * 规则 12 的 ruleKey：`UPGRADEREDEEM:{乘客id}:{标的那一程的订单行id}`。
 *
 * 键里只放**稳定的业务身份**（谁 + 哪一程），不放起飞日期、更不放常旅客档案 id：
 *   - 档案 id 会因为「先没档案后建档」「档案 A→B→C 连续合并」变来变去，进了键就等于
 *     同一件事随时换身份，旧条永久挂在待办列表（astra 评审 F4）；
 *   - 起飞日期会因为改期变，同理。
 * 改期只刷新标题/正文（同一把键），不再换键重发；「跳哪去核销」由列表接口按乘客证件号
 * 当场解析成最新主档案 id 返回（见 reminders.routes.ts 的 redeemProfileId），永远是当前值。
 */
export function upgradeRedeemRuleKey(passengerId: string, legItemId: string): string {
  return `${UPGRADE_REDEEM_RULE_PREFIX}${passengerId}:${legItemId}`;
}

/**
 * ruleKey → 乘客 id（收敛时判「这条旧待办是谁的」，以及列表接口拼直达链接用）。
 * 兼容旧格式 `UPGRADEREDEEM:{乘客id}:{起飞日}:{档案id|NOPROFILE}`（四段）：同样能取出乘客 id，
 * `legacy=true` 让收敛给出「键已升级」的留痕文案。
 */
export function parseUpgradeRedeemRuleKey(
  ruleKey: string | null | undefined,
): { passengerId: string; legacy: boolean } | null {
  if (!ruleKey || !ruleKey.startsWith(UPGRADE_REDEEM_RULE_PREFIX)) return null;
  const parts = ruleKey.split(':');
  const passengerId = parts[1];
  if (!passengerId) return null;
  return { passengerId, legacy: parts.length > 3 };
}

/** 规则 12 的输入：一位标了次数升级的乘客 + 他所在订单的机票航段快照。 */
export interface RuleUpgradeRedeemPassenger {
  passengerId: string;
  fullName: string;
  orderId: string;
  orderNumber: string;
  upgradeRedeemLeg: UpgradeRedeemLeg;
  /** 本单全部有班次的机票行（顺序随意，函数内按起飞时间排）。 */
  flights: ReadonlyArray<{
    /** 该机票行的 OrderItem id —— ruleKey 的稳定身份之一。 */
    itemId: string;
    departureTime: Date;
    departureTz: string | null;
    flightNumber: string | null;
  }>;
  /** 解析到的主档案 id；null = 该证件号没匹配到常旅客档案（只影响正文提示，不进 ruleKey）。 */
  profileId: string | null;
  /** 该程起飞日之后档案上已有正数核销流水（true = 已扣过，不再提醒）。 */
  redeemedAfterLeg: boolean;
}

/** 标了次数升级的那一程（去程/回程）的班次快照。 */
export interface UpgradeRedeemLegRef {
  /** 该程的订单行 id（ruleKey 用）。 */
  itemId: string;
  departureTime: Date;
  /** 起飞当地日期 YYYY-MM-DD（口径同 deriveDepartureDate）。 */
  legDate: string;
  /** 起飞地时区（核销时间下界要按它把当地零点折回 UTC）。 */
  departureTz: string | null;
  flightNumber: string | null;
  /** 录单标的是哪一程（去程/回程/往返）——文案里如实复述运营填的那一档。 */
  legLabel: string;
}

/**
 * 「标的那一程」是哪一段：去程 = 最早起飞的机票行，回程 = 第二段
 * （口径与旅客档案 summarizeOrder 同源，全站只留一套「哪段是回程」的判法）。
 * 双程（BOTH）按**回程**判 —— 两程都要升舱时，回程飞完这一单才算走完，
 * 早在去程就催核销会把「人还在境外、回程可能改期/不飞」的单提前催一遍。
 * 目标航段不存在（单程单标了回程、回程被释放导致班次为空）→ 返回 null，不提醒。
 */
export function resolveUpgradeRedeemLeg(
  pax: Pick<RuleUpgradeRedeemPassenger, 'upgradeRedeemLeg' | 'flights'>,
): UpgradeRedeemLegRef | null {
  const legLabel = UPGRADE_REDEEM_LEG_LABEL[pax.upgradeRedeemLeg];
  if (!legLabel) return null; // NONE / 未知值
  const sorted = [...pax.flights].sort(
    (a, b) => a.departureTime.getTime() - b.departureTime.getTime(),
  );
  const target = pax.upgradeRedeemLeg === UpgradeRedeemLeg.OUTBOUND ? sorted[0] : sorted[1];
  if (!target) return null;
  return {
    itemId: target.itemId,
    departureTime: target.departureTime,
    legDate: localDateISO(target.departureTime, target.departureTz),
    departureTz: target.departureTz,
    flightNumber: target.flightNumber,
    legLabel,
  };
}

/**
 * 「这一程之后的核销」时间下界（UTC 毫秒）。
 *
 * 台账不挂订单号，只能按时间判「这次核销是不是为这一程扣的」，下界取**起飞当地日的零点**
 * （宽松一档：当天早上先核销、晚上才起飞的也认）。当地零点必须按班次 departureTz 折回
 * UTC —— 直接拼 `${legDate}T00:00:00Z` 等于把北京零点当成北京早八点，北京 07:00 核销、
 * 10:00 起飞的合法同日核销会被判成「没核销」继续催（astra 评审 F5）。tz 为空（班次没
 * 联查到时区）时回退 UTC 零点，与 flight-time 其它函数同一个回退口径。
 */
export function upgradeRedeemLegStartMs(
  leg: Pick<UpgradeRedeemLegRef, 'legDate' | 'departureTz'>,
): number {
  if (!leg.departureTz) return Date.parse(`${leg.legDate}T00:00:00Z`);
  try {
    return localToUtc(leg.legDate, '00:00', leg.departureTz).getTime();
  } catch {
    return Date.parse(`${leg.legDate}T00:00:00Z`);
  }
}

/**
 * 规则 12：标了次数升级的那一程已起飞、档案里却还没扣次数 → 提醒去核销。
 * 起飞前不提醒（还没飞成，扣了要冲正）；已核销不提醒（redeemedAfterLeg 由调用方按台账判定）。
 */
export function buildUpgradeRedeemCandidates(
  pax: RuleUpgradeRedeemPassenger,
  today: string,
  now: Date,
): ReminderCandidate[] {
  const leg = resolveUpgradeRedeemLeg(pax);
  if (!leg) return [];
  // 起飞那一刻起算（与规则 11 的 departed 判定同口径：含正点起飞的那一秒）
  if (leg.departureTime.getTime() > now.getTime()) return [];
  if (pax.redeemedAfterLeg) return [];
  const flightLabel = leg.flightNumber ?? '航班未知';
  const missingProfileHint = pax.profileId
    ? ''
    : '（未按该乘客证件号匹配到常旅客档案：请从订单详情点乘客姓名进档案页，查不到会当场建档）';
  return [
    {
      rule: 'UPGRADE_REDEEM_PENDING',
      ruleKey: upgradeRedeemRuleKey(pax.passengerId, leg.itemId),
      orderId: pax.orderId,
      title: `【次数升级待核销】${pax.orderNumber} ${pax.fullName} ${flightLabel} ${leg.legDate}`,
      body:
        `${pax.fullName} 在本单标了次数升级（${leg.legLabel}），${flightLabel} ${leg.legDate} 已起飞，` +
        `常旅客档案里还没有这一程之后的核销流水。可用次数不会自动扣（口径＝已飞 − 已核销），` +
        `请到常旅客档案「核销权益」扣减一次。${missingProfileHint}`,
      priority: ReminderPriority.HIGH,
      dueAt: today,
    },
  ];
}

// ── 档案沿链解析 ────────────────────────────────────────────────────────────

/** 沿链解析要用到的最小档案行。 */
export interface UpgradeRedeemProfileRef {
  id: string;
  documentType: string;
  documentNumber: string;
  mergedIntoId: string | null;
}

interface ProfileFindManyDelegate {
  findMany: (args: unknown) => Promise<UpgradeRedeemProfileRef[]>;
}

/** 证件对 → 归一化索引键（trim + 大写：档案列存的是乘客行原始写法，大小写/空格出入不该让解析落空）。 */
function docKey(documentType: string, documentNumber: string): string {
  return `${documentType}|${(documentNumber ?? '').trim().toUpperCase()}`;
}

/**
 * 沿 mergedIntoId 链解析到最终主档案 id（口径与 traveler-profiles.service.ts 的
 * resolveMasterRef 一致：断链/环时就地停，不抛错不死循环）。
 *
 * 不能只取一跳（`mergedIntoId ?? id`）：A→B 之后再 B→C 两次合并都合法（第二次开始时 B、C
 * 都还是主档案），A 的指针仍指着 B，而核销台账已经跟着人搬到 C —— 只跳一次会永远查 B 的
 * 台账、永远报「没核销」，运营再怎么核销也消不掉（astra 评审 F6）。
 *
 * byId 里加载不到下一跳时返回那个指针目标 id（mergedIntoId 是外键，目标行必然存在，
 * 只是本次没把它查进内存）——比就地停在指针行更接近真值。
 */
export function resolveProfileMasterId(
  startId: string,
  byId: Map<string, UpgradeRedeemProfileRef>,
): string {
  let currentId = startId;
  const seen = new Set<string>([currentId]);
  for (;;) {
    const row = byId.get(currentId);
    if (!row || !row.mergedIntoId) return currentId;
    const nextId = row.mergedIntoId;
    if (seen.has(nextId)) return currentId; // 环（脏数据）：停在当前行
    seen.add(nextId);
    currentId = nextId;
  }
}

/** 链上还没加载进内存的祖先 id。 */
function missingChainTargets(byId: Map<string, UpgradeRedeemProfileRef>): string[] {
  const out = new Set<string>();
  for (const row of byId.values()) {
    if (row.mergedIntoId && !byId.has(row.mergedIntoId)) out.add(row.mergedIntoId);
  }
  return [...out];
}

/** 合并链最多补齐几轮（正常数据 0–1 跳；上限只为脏数据兜底，不会真的跑满）。 */
const PROFILE_CHAIN_MAX_HOPS = 5;

/**
 * 证件对 → 主档案 id。先按证件号（忽略大小写）查出命中行，再沿 mergedIntoId 链按 id
 * 批量补齐祖先行，直到全部解析完或补不出新行为止。
 */
export async function resolveMasterIdByDoc(
  delegate: ProfileFindManyDelegate,
  docs: ReadonlyArray<{ documentType: string; documentNumber: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (docs.length === 0) return out;
  const select = { id: true, documentType: true, documentNumber: true, mergedIntoId: true };
  const matched = await delegate.findMany({
    where: {
      OR: docs.map((d) => ({
        documentType: d.documentType,
        documentNumber: { equals: d.documentNumber, mode: Prisma.QueryMode.insensitive },
      })),
    },
    select,
  });
  const byId = new Map<string, UpgradeRedeemProfileRef>(matched.map((r) => [r.id, r]));
  for (let hop = 0; hop < PROFILE_CHAIN_MAX_HOPS; hop += 1) {
    const pending = missingChainTargets(byId);
    if (pending.length === 0) break;
    const more = await delegate.findMany({ where: { id: { in: pending } }, select });
    let added = false;
    for (const row of more) {
      if (!byId.has(row.id)) {
        byId.set(row.id, row);
        added = true;
      }
    }
    if (!added) break; // 补不出新行（断链 / 调用方不支持按 id 查）——就用已知的指针目标
  }
  for (const row of matched) {
    out.set(docKey(row.documentType, row.documentNumber), resolveProfileMasterId(row.id, byId));
  }
  return out;
}

// ── 取数 + 收敛 ─────────────────────────────────────────────────────────────

/** 占位出行人（N/A / 空证件号）不是真人，没有也不该有档案。 */
function realDocumentNumber(raw: string | null | undefined): string | null {
  const doc = (raw ?? '').trim();
  if (doc === '' || doc.toUpperCase() === 'N/A') return null;
  return doc;
}

/** 本轮规则 12 的扫描结果（喂给 generateRuleReminders 的候选 + 收敛所需的上下文）。 */
export interface UpgradeRedeemScan {
  /** 三个 delegate 齐备、这一轮真的扫过 —— 否则收敛必须整个跳过（不然会把全库旧条误关）。 */
  ran: boolean;
  candidates: ReminderCandidate[];
  /** 本轮「应该开着」的全部 ruleKey。 */
  desiredKeys: Set<string>;
  /** 乘客 id → 他名下**其它**（非本轮候选）ruleKey 的自动核销留痕文案。 */
  staleReasonByPassenger: Map<string, string>;
}

const STALE_NOTE_SUPERSEDED = '标的航段已变更（改期/换程），已由新的待办接手，本条自动核销。';
const STALE_NOTE_REDEEMED = '常旅客档案已核销过这一程的次数，无需再催，本条自动核销。';
const STALE_NOTE_NOT_DEPARTED =
  '标的航段尚未起飞或已不存在（改期/回程释放），暂不需要催核销，本条自动核销。';
const STALE_NOTE_GONE = '次数升级标记已撤销，或订单已取消/删除，本条自动核销。';
const STALE_NOTE_LEGACY = '待办键已升级为「乘客＋航段」的稳定键，本条由新待办接手，自动核销。';

const UPGRADE_REDEEM_SCAN_SKIPPED: UpgradeRedeemScan = {
  ran: false,
  candidates: [],
  desiredKeys: new Set(),
  staleReasonByPassenger: new Map(),
};

/** 规则 12 取数用到的三个 delegate（防御式取：老测试 mock 没有它们时整条规则跳过）。 */
interface UpgradeRedeemDelegates {
  passenger?: {
    findMany?: (args: unknown) => Promise<
      Array<{
        id: string;
        fullName: string;
        orderId: string;
        documentType: string;
        documentNumber: string;
        upgradeRedeemLeg: UpgradeRedeemLeg;
        order: {
          orderNumber: string;
          items: Array<{
            id: string;
            flightSchedule: {
              departureTime: Date;
              departureTz: string | null;
              flight: { flightNumber: string | null } | null;
            } | null;
          }>;
        } | null;
      }>
    >;
  };
  travelerProfile?: { findMany?: (args: unknown) => Promise<UpgradeRedeemProfileRef[]> };
  travelerBenefitRedemption?: {
    findMany?: (args: unknown) => Promise<Array<{ profileId: string; createdAt: Date }>>;
  };
}

/**
 * 规则 12 取数（乘客级；范围 = 标了 upgradeRedeemLeg 的乘客）。
 *
 * 单独取数，不放宽主扫描订单查询的状态集：本规则要覆盖 COMPLETED 单（起飞后才触发），
 * 而主扫描的 SCAN_STATUSES 刻意排除 COMPLETED —— 放宽它会把其余十一条规则的扫描面一起
 * 撑开。命中面只有真的标过次数升级的那几位乘客，量级很小。
 */
export async function collectUpgradeRedeemCandidates(
  prisma: PrismaClient,
  orderStatuses: readonly string[],
  today: string,
  now: Date,
): Promise<UpgradeRedeemScan> {
  const delegates = prisma as unknown as UpgradeRedeemDelegates;
  const passengerDelegate = delegates.passenger;
  const profileDelegate = delegates.travelerProfile;
  const redemptionDelegate = delegates.travelerBenefitRedemption;
  if (
    typeof passengerDelegate?.findMany !== 'function' ||
    typeof profileDelegate?.findMany !== 'function' ||
    typeof redemptionDelegate?.findMany !== 'function'
  ) {
    return UPGRADE_REDEEM_SCAN_SKIPPED;
  }

  const marked = await passengerDelegate.findMany({
    where: {
      upgradeRedeemLeg: { not: UpgradeRedeemLeg.NONE },
      order: { deletedAt: null, status: { in: orderStatuses } },
    },
    select: {
      id: true,
      fullName: true,
      orderId: true,
      documentType: true,
      documentNumber: true,
      upgradeRedeemLeg: true,
      order: {
        select: {
          orderNumber: true,
          items: {
            where: { flightScheduleId: { not: null } },
            select: {
              id: true,
              flightSchedule: {
                select: {
                  departureTime: true,
                  departureTz: true,
                  flight: { select: { flightNumber: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const staleReasonByPassenger = new Map<string, string>();
  // 只留「标的那一程已经起飞」的人：没起飞的不催（扣早了要冲正），目标航段不存在
  //（单程单标了回程 / 回程已释放）的同样跳过；两种都记进收敛原因，好让上一轮留下的
  // 旧待办这一轮就被关掉，而不是永久挂着。
  const departedLegs: Array<{
    row: (typeof marked)[number];
    flights: RuleUpgradeRedeemPassenger['flights'];
    leg: UpgradeRedeemLegRef;
  }> = [];
  for (const row of marked) {
    const flights = (row.order?.items ?? [])
      .filter((item) => item.flightSchedule != null)
      .map((item) => ({
        itemId: item.id,
        departureTime: item.flightSchedule!.departureTime,
        departureTz: item.flightSchedule!.departureTz,
        flightNumber: item.flightSchedule!.flight?.flightNumber ?? null,
      }));
    const leg = resolveUpgradeRedeemLeg({ upgradeRedeemLeg: row.upgradeRedeemLeg, flights });
    if (leg && leg.departureTime.getTime() <= now.getTime()) {
      departedLegs.push({ row, flights, leg });
    } else {
      staleReasonByPassenger.set(row.id, STALE_NOTE_NOT_DEPARTED);
    }
  }

  const candidates: ReminderCandidate[] = [];
  const desiredKeys = new Set<string>();
  if (departedLegs.length === 0) {
    return { ran: true, candidates, desiredKeys, staleReasonByPassenger };
  }

  // 证件号 → 主档案 id（沿 mergedIntoId 链解析，见 resolveMasterIdByDoc）。
  const docPairs = new Map<string, { documentType: string; documentNumber: string }>();
  for (const { row } of departedLegs) {
    const doc = realDocumentNumber(row.documentNumber);
    if (!doc) continue;
    docPairs.set(docKey(row.documentType, doc), {
      documentType: row.documentType,
      documentNumber: doc,
    });
  }
  const masterIdByDoc = await resolveMasterIdByDoc(profileDelegate as ProfileFindManyDelegate, [
    ...docPairs.values(),
  ]);

  // 这一程起飞之后的正数核销流水（负数是冲正，不算「已扣过」）。同一位客人短期内飞两趟
  // 都标了升舱时，一次核销可能把两条都判成已核销 —— 台账无单据关联，已知近似（见遗留风险）。
  const masterIds = [...new Set(masterIdByDoc.values())];
  const redemptions =
    masterIds.length === 0
      ? []
      : await redemptionDelegate.findMany({
          where: { profileId: { in: masterIds }, tripsUsed: { gt: 0 } },
          select: { profileId: true, createdAt: true },
        });
  const redeemedAtByProfile = new Map<string, Date[]>();
  for (const r of redemptions) {
    const list = redeemedAtByProfile.get(r.profileId) ?? [];
    list.push(r.createdAt);
    redeemedAtByProfile.set(r.profileId, list);
  }

  for (const { row, flights, leg } of departedLegs) {
    const doc = realDocumentNumber(row.documentNumber);
    const profileId = doc ? (masterIdByDoc.get(docKey(row.documentType, doc)) ?? null) : null;
    const legStart = upgradeRedeemLegStartMs(leg);
    const redeemedAfterLeg = (redeemedAtByProfile.get(profileId ?? '') ?? []).some(
      (at) => at.getTime() >= legStart,
    );
    const built = buildUpgradeRedeemCandidates(
      {
        passengerId: row.id,
        fullName: row.fullName,
        orderId: row.orderId,
        orderNumber: row.order?.orderNumber ?? '',
        upgradeRedeemLeg: row.upgradeRedeemLeg,
        flights,
        profileId,
        redeemedAfterLeg,
      },
      today,
      now,
    );
    for (const c of built) desiredKeys.add(c.ruleKey);
    candidates.push(...built);
    staleReasonByPassenger.set(
      row.id,
      redeemedAfterLeg
        ? STALE_NOTE_REDEEMED
        : built.length > 0
          ? STALE_NOTE_SUPERSEDED
          : STALE_NOTE_NOT_DEPARTED,
    );
  }

  return { ran: true, candidates, desiredKeys, staleReasonByPassenger };
}

/**
 * 规则 12 的收敛（状态机，照抄 reconcileRoomAssignmentReminders 的思路）：
 * 把库里**本规则全部仍活着的**提醒拉出来，与本轮有效候选逐一核对，不在候选里的自动核销。
 *
 * 通用的 resolvedRuleKeys 兜底只认「本轮算得出来的精确 key」，覆盖不了这四类
 *（astra 评审 F4）：撤销 upgradeRedeemLeg → NONE、订单取消/软删、改期换了航段行、
 * 以及旧格式（键里带起飞日 + 档案 id）的存量条。它们的共同点是**本轮根本算不出那把旧键**，
 * 只能反过来从库里扫。
 *
 * ran=false（三个 delegate 不全，整条规则这一轮没跑）时**什么都不做** —— 否则会把全库
 * 旧条按「不在候选集里」一把关掉。
 */
export async function reconcileUpgradeRedeemReminders(
  prisma: PrismaClient,
  scan: UpgradeRedeemScan,
  now: Date,
): Promise<void> {
  if (!scan.ran) return;
  const active = await prisma.operationalReminder.findMany({
    where: {
      ruleKey: { startsWith: UPGRADE_REDEEM_RULE_PREFIX },
      status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] },
    },
    select: { id: true, ruleKey: true },
  });
  const idsByNote = new Map<string, string[]>();
  for (const row of active) {
    if (!row.ruleKey || scan.desiredKeys.has(row.ruleKey)) continue;
    const parsed = parseUpgradeRedeemRuleKey(row.ruleKey);
    const note = parsed?.legacy
      ? STALE_NOTE_LEGACY
      : ((parsed && scan.staleReasonByPassenger.get(parsed.passengerId)) ?? STALE_NOTE_GONE);
    const list = idsByNote.get(note) ?? [];
    list.push(row.id);
    idsByNote.set(note, list);
  }
  for (const [note, ids] of idsByNote) {
    await prisma.operationalReminder.updateMany({
      // 第二次写入重复一遍状态条件：读出来之后、更新之前运营可能已经手工完成/跳过并写了
      // 备注，只按 id 更新会把人工结论覆盖掉（astra 评审 F8）。
      where: { id: { in: ids }, status: { in: [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS] } },
      data: { status: ReminderStatus.DONE, resolvedAt: now, resolvedNote: note },
    });
  }
}

/**
 * 列表接口用：乘客 id → 当前主档案 id（「去核销」直达链接）。
 *
 * ruleKey 里不再带档案 id（见 upgradeRedeemRuleKey），跳转目标改成读的时候现算 —— 建档、
 * 档案合并之后立刻是最新值，不会像旧键那样指着一个早就被并掉的旧档案。
 * 查不到档案的不返回（前端据此不渲染链接，正文里写了怎么先建档）。
 */
export async function resolveRedeemProfileIdsByPassenger(
  prisma: PrismaClient,
  passengerIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (passengerIds.length === 0) return out;
  const delegates = prisma as unknown as UpgradeRedeemDelegates;
  const passengerDelegate = delegates.passenger;
  const profileDelegate = delegates.travelerProfile;
  if (
    typeof passengerDelegate?.findMany !== 'function' ||
    typeof profileDelegate?.findMany !== 'function'
  ) {
    return out;
  }
  const rows = (await passengerDelegate.findMany({
    where: { id: { in: [...passengerIds] } },
    select: { id: true, documentType: true, documentNumber: true },
  })) as unknown as Array<{ id: string; documentType: string; documentNumber: string }>;
  const docPairs = new Map<string, { documentType: string; documentNumber: string }>();
  for (const row of rows) {
    const doc = realDocumentNumber(row.documentNumber);
    if (!doc) continue;
    docPairs.set(docKey(row.documentType, doc), {
      documentType: row.documentType,
      documentNumber: doc,
    });
  }
  const masterIdByDoc = await resolveMasterIdByDoc(profileDelegate as ProfileFindManyDelegate, [
    ...docPairs.values(),
  ]);
  for (const row of rows) {
    const doc = realDocumentNumber(row.documentNumber);
    if (!doc) continue;
    const masterId = masterIdByDoc.get(docKey(row.documentType, doc));
    if (masterId) out.set(row.id, masterId);
  }
  return out;
}
