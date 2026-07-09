/**
 * 规则化自动生成提醒 — 扫描订单/乘客/签证任务，按规则生成操作部待办。
 *
 * 四条规则（详见各 build 函数）：
 *   1. BALANCE_DUE      催尾款：临近出发仍有尾款未收
 *   2. DEPARTURE_SOON   出行提醒：3 天内出发的已付订单
 *   3. PASSPORT_EXPIRY  护照有效期：距出发不足 6 个月
 *   4. VISA_MISSING     签证缺件：在办签证任务下有乘客缺护照照片
 *
 * 幂等：每条候选算出确定性 ruleKey（唯一索引），已存在同 key 的跳过；
 * 重复触发生成不会刷屏。所有日期比较用 UTC 日期字符串（YYYY-MM-DD），
 * 因为 dueAt / hotelCheckIn / passportExpiry 都是 @db.Date（UTC 零点）。
 *
 * 出发时间口径与履约台一致（见 fulfillment.service.ts listTasks）：
 * 订单内最早一段机票的起飞时间（按班次时区取当地日期）；无机票则取最早酒店入住日。
 */
import {
  FulfillmentStatus,
  FulfillmentType,
  OrderStatus,
  Prisma,
  ReminderPriority,
  type PrismaClient,
} from '@prisma/client';

// ── 状态集合 ────────────────────────────────────────────────────────────────
/** 催尾款：待付 + 已付未完结（这些状态还会收钱） */
const BALANCE_DUE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
];
/** 出行提醒：PAID_LIKE 排除 COMPLETED（已完结不用再提醒出行） */
const DEPARTURE_SOON_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];
/** 护照有效期：活跃订单 = 待付 + PAID_LIKE 排除 COMPLETED */
const PASSPORT_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  ...DEPARTURE_SOON_STATUSES,
];
/** 规则 1–3 一次查询覆盖的状态并集 */
const SCAN_STATUSES: OrderStatus[] = [
  ...new Set([...BALANCE_DUE_STATUSES, ...PASSPORT_ACTIVE_STATUSES]),
];

const BALANCE_DUE_WINDOW_DAYS = 14;
const BALANCE_CRITICAL_DAYS = 3;
const DEPARTURE_SOON_WINDOW_DAYS = 3;
const PASSPORT_MIN_VALID_MONTHS = 6;

// ── 日期纯函数（可单测）────────────────────────────────────────────────────
/** Date → UTC 日期字符串 YYYY-MM-DD（@db.Date 的正确读法） */
export function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 起飞时刻在班次时区下的当地日期（YYYY-MM-DD）；时区缺失/非法回落 UTC */
export function dateInTz(d: Date, tz: string | null | undefined): string {
  if (tz) {
    try {
      // en-CA 的日期格式恰好是 YYYY-MM-DD
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    } catch {
      // 非法时区字符串 → 回落 UTC
    }
  }
  return utcDateStr(d);
}

/** 两个 YYYY-MM-DD 之间的整天差（to − from） */
export function diffDays(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** YYYY-MM-DD 加 n 天（UTC 算术） */
export function addDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDateStr(d);
}

/** YYYY-MM-DD 加 n 个月（UTC 算术；月末溢出钳制到目标月最后一天：08-31 +6月 → 02-28 而非 03-03） */
export function addMonthsUtc(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayOfMonth = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return utcDateStr(d);
}

// ── 金额 ───────────────────────────────────────────────────────────────────
/** Decimal → 展示串：保留两位小数并去尾零（1234.00 → "1234"，1234.50 → "1234.5"） */
export function formatAmount(v: Prisma.Decimal): string {
  const fixed = v.toFixed(2);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** 尾款口径（与财务一致）：total + adjustmentCny − paidAmount − prepaymentOffset */
export function computeBalance(order: {
  total: Prisma.Decimal;
  adjustmentCny: number;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
}): Prisma.Decimal {
  return new Prisma.Decimal(order.total)
    .plus(order.adjustmentCny)
    .minus(order.paidAmount)
    .minus(order.prepaymentOffset);
}

// ── 出发时间推导 ────────────────────────────────────────────────────────────
export interface DepartureSourceItem {
  hotelCheckIn: Date | null;
  flightSchedule: { departureTime: Date; departureTz: string | null } | null;
}

/**
 * 订单出发日（YYYY-MM-DD）：最早一段机票起飞时间（按班次时区）；
 * 无机票行则用最早酒店入住日（@db.Date → UTC 日期）。两者皆无 → null。
 * 口径提炼自 fulfillment.service.ts 的 earliestLegByOrder（不 import 私有实现避免耦合）。
 */
export function deriveDepartureDate(items: DepartureSourceItem[]): string | null {
  let earliestFlight: { departureTime: Date; departureTz: string | null } | null = null;
  let earliestCheckIn: Date | null = null;
  for (const item of items) {
    const sched = item.flightSchedule;
    if (sched && (!earliestFlight || sched.departureTime < earliestFlight.departureTime)) {
      earliestFlight = sched;
    }
    if (item.hotelCheckIn && (!earliestCheckIn || item.hotelCheckIn < earliestCheckIn)) {
      earliestCheckIn = item.hotelCheckIn;
    }
  }
  if (earliestFlight) return dateInTz(earliestFlight.departureTime, earliestFlight.departureTz);
  if (earliestCheckIn) return utcDateStr(earliestCheckIn);
  return null;
}

// ── 候选构建（纯函数，可单测）───────────────────────────────────────────────
export type RuleName = 'BALANCE_DUE' | 'DEPARTURE_SOON' | 'PASSPORT_EXPIRY' | 'VISA_MISSING';

export interface ReminderCandidate {
  rule: RuleName;
  ruleKey: string;
  orderId: string;
  title: string;
  body: string;
  priority: ReminderPriority;
  /** YYYY-MM-DD */
  dueAt: string;
}

export interface RuleOrder {
  id: string;
  orderNumber: string;
  contactName: string;
  status: OrderStatus;
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
  adjustmentCny: number;
  items: DepartureSourceItem[];
  passengers: { id: string; fullName: string; passportExpiry: Date | null }[];
}

export interface RuleVisaTask {
  taskId: string;
  orderId: string;
  orderNumber: string;
  items: DepartureSourceItem[];
  /** 缺护照照片的乘客姓名（已在库内过滤，不拉大字段） */
  missingPassengerNames: string[];
}

/** 规则 1–3：逐单判定，返回候选（today = UTC 今天 YYYY-MM-DD） */
export function buildOrderCandidates(order: RuleOrder, today: string): ReminderCandidate[] {
  const out: ReminderCandidate[] = [];
  const departure = deriveDepartureDate(order.items);
  if (!departure) return out;
  const days = diffDays(today, departure);

  // 1) 催尾款：14 天内出发（含今天）且尾款 > 0
  if (BALANCE_DUE_STATUSES.includes(order.status) && days >= 0 && days <= BALANCE_DUE_WINDOW_DAYS) {
    const balance = computeBalance(order);
    if (balance.greaterThan(0)) {
      out.push({
        rule: 'BALANCE_DUE',
        ruleKey: `BALANCE:${order.id}:${departure}`,
        orderId: order.id,
        title: `【催尾款】${order.orderNumber} 尾款¥${formatAmount(balance)}`,
        body: `联系人 ${order.contactName}，出发 ${departure}。请联系客人补齐尾款。`,
        priority: days <= BALANCE_CRITICAL_DAYS ? ReminderPriority.CRITICAL : ReminderPriority.HIGH,
        dueAt: today,
      });
    }
  }

  // 2) 出行提醒：3 天内出发（含今天）；dueAt = 出发前一天（不早于今天）
  if (
    DEPARTURE_SOON_STATUSES.includes(order.status) &&
    days >= 0 &&
    days <= DEPARTURE_SOON_WINDOW_DAYS
  ) {
    const dayBefore = addDaysUtc(departure, -1);
    out.push({
      rule: 'DEPARTURE_SOON',
      ruleKey: `DEPART:${order.id}:${departure}`,
      orderId: order.id,
      title: `【出行提醒】${order.orderNumber} ${departure}出发`,
      body: '请与客人确认集合时间、证件与接送安排。',
      priority: ReminderPriority.NORMAL,
      dueAt: dayBefore < today ? today : dayBefore,
    });
  }

  // 3) 护照有效期：出发在未来（含今天）且护照有效期 < 出发日 + 6 个月
  if (PASSPORT_ACTIVE_STATUSES.includes(order.status) && days >= 0) {
    const minExpiry = addMonthsUtc(departure, PASSPORT_MIN_VALID_MONTHS);
    for (const pax of order.passengers) {
      if (!pax.passportExpiry) continue;
      const expiry = utcDateStr(pax.passportExpiry);
      if (expiry < minExpiry) {
        out.push({
          rule: 'PASSPORT_EXPIRY',
          ruleKey: `PPEXP:${pax.id}:${departure}`,
          orderId: order.id,
          title: `【护照有效期不足】${order.orderNumber} ${pax.fullName}`,
          body: `护照有效期 ${expiry}，距出发不足6个月，请提醒客人换发护照或确认目的地入境政策。`,
          priority: ReminderPriority.CRITICAL,
          dueAt: today,
        });
      }
    }
  }

  return out;
}

/** 规则 4：签证缺件（在办签证任务 + 订单出发在未来 + 有乘客缺护照照片） */
export function buildVisaCandidates(task: RuleVisaTask, today: string): ReminderCandidate[] {
  const departure = deriveDepartureDate(task.items);
  if (!departure || diffDays(today, departure) < 0) return [];
  const count = task.missingPassengerNames.length;
  if (count === 0) return [];
  return [
    {
      rule: 'VISA_MISSING',
      // 人数入 key：缺件人数变化会生成新的一条（旧条可手动关掉），可接受
      ruleKey: `VISAMISS:${task.taskId}:${count}`,
      orderId: task.orderId,
      title: `【签证缺件】${task.orderNumber} 缺护照照片${count}人`,
      body: `缺护照照片乘客：${task.missingPassengerNames.join('，')}。请尽快收齐并上传。`,
      priority: ReminderPriority.HIGH,
      dueAt: today,
    },
  ];
}

export interface GenerateRuleRemindersResult {
  created: number;
  skipped: number;
  byRule: Record<string, number>;
}

/**
 * 扫描全库并落库自动提醒（幂等）。
 * 性能：订单量千级 —— 一次 order.findMany（不拉护照大图等 blob 字段）+
 * 一次 fulfillmentTask.findMany + 一次 ruleKey in 查重 + 一次 createMany。
 */
export async function generateRuleReminders(
  prisma: PrismaClient,
  createdById: string,
): Promise<GenerateRuleRemindersResult> {
  const today = utcDateStr(new Date());

  const [orders, visaTasks] = await Promise.all([
    prisma.order.findMany({
      where: { deletedAt: null, status: { in: SCAN_STATUSES } },
      select: {
        id: true,
        orderNumber: true,
        contactName: true,
        status: true,
        total: true,
        paidAmount: true,
        prepaymentOffset: true,
        adjustmentCny: true,
        // 只取推导出发时间需要的行（有机票班次或酒店入住日的）
        items: {
          where: { OR: [{ flightScheduleId: { not: null } }, { hotelCheckIn: { not: null } }] },
          select: {
            hotelCheckIn: true,
            flightSchedule: { select: { departureTime: true, departureTz: true } },
          },
        },
        passengers: { select: { id: true, fullName: true, passportExpiry: true } },
      },
    }),
    prisma.fulfillmentTask.findMany({
      where: {
        type: FulfillmentType.VISA_APPLICATION,
        status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] },
        // 已取消/退款/超时/失败的订单可能残留在办签证任务——不再催缺件（deletedAt 兜底过滤保留在下游）
        orderItem: { order: { deletedAt: null, status: { in: SCAN_STATUSES } } },
      },
      select: {
        id: true,
        orderItem: {
          select: {
            order: {
              select: {
                id: true,
                orderNumber: true,
                deletedAt: true,
                items: {
                  where: {
                    OR: [{ flightScheduleId: { not: null } }, { hotelCheckIn: { not: null } }],
                  },
                  select: {
                    hotelCheckIn: true,
                    flightSchedule: { select: { departureTime: true, departureTz: true } },
                  },
                },
                // 只取缺照片乘客的姓名；护照大图（base64 可达数 MB）绝不拉到应用层
                passengers: {
                  where: { OR: [{ passportPhotoUrl: null }, { passportPhotoUrl: '' }] },
                  select: { fullName: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const candidates: ReminderCandidate[] = [];
  for (const order of orders) {
    candidates.push(...buildOrderCandidates(order, today));
  }
  for (const task of visaTasks) {
    const order = task.orderItem.order;
    if (order.deletedAt) continue;
    candidates.push(
      ...buildVisaCandidates(
        {
          taskId: task.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          items: order.items,
          missingPassengerNames: order.passengers.map((p) => p.fullName),
        },
        today,
      ),
    );
  }

  // 批内去重（同一 ruleKey 只留第一条）
  const byKey = new Map<string, ReminderCandidate>();
  for (const c of candidates) {
    if (!byKey.has(c.ruleKey)) byKey.set(c.ruleKey, c);
  }
  const unique = [...byKey.values()];
  if (unique.length === 0) return { created: 0, skipped: 0, byRule: {} };

  // 幂等：一次性查出已存在的 ruleKey，过滤后 createMany（skipDuplicates 兜底并发竞争）
  const existing = await prisma.operationalReminder.findMany({
    where: { ruleKey: { in: unique.map((c) => c.ruleKey) } },
    select: { ruleKey: true },
  });
  const existingKeys = new Set(existing.map((e) => e.ruleKey));
  const fresh = unique.filter((c) => !existingKeys.has(c.ruleKey));

  const byRule: Record<string, number> = {};
  for (const c of fresh) {
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
  }

  let created = 0;
  if (fresh.length > 0) {
    const result = await prisma.operationalReminder.createMany({
      data: fresh.map((c) => ({
        orderId: c.orderId,
        createdById,
        title: c.title,
        body: c.body,
        // YYYY-MM-DD → UTC 零点，@db.Date 落库口径与手工创建一致
        dueAt: new Date(`${c.dueAt}T00:00:00Z`),
        priority: c.priority,
        ruleKey: c.ruleKey,
      })),
      skipDuplicates: true,
    });
    created = result.count;
  }

  return { created, skipped: unique.length - created, byRule };
}
