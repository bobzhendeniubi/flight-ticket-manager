/**
 * 规则化自动生成提醒 — 扫描订单/乘客/签证任务，按规则生成操作部待办。
 *
 * 五条规则（详见各 build 函数）：
 *   1. BALANCE_DUE      催尾款：临近出发仍有尾款未收
 *   2. DEPARTURE_SOON   出行提醒：3 天内出发的已付订单
 *   3. PASSPORT_EXPIRY  护照有效期：距出发不足 6 个月
 *   4. VISA_MISSING     签证缺件：在办签证任务下有乘客缺护照照片（排除自备签乘客，见下）
 *   5. HOLD_INSTALLMENT_DUE 占位单收款期：截止前三天提醒，逾期标红
 *
 * 各规则与「自备签证」（Passenger.visaExempt=true：客人自行办妥签证，无需送签）的口径：
 *   - 规则 4 签证缺件：按签证台同口径排除自备签乘客（visaExempt=true）——客人自备签证
 *     不需要我们收护照照片，不应被催缺件。
 *   - 规则 3 护照有效期：不排除。护照有效期是所有出行乘客的通用要求，与签证是否自备无关。
 *
 * 幂等：每条候选算出确定性 ruleKey（唯一索引），已存在同 key 的跳过；
 * 重复触发生成不会刷屏。ruleKey 里只放出发日 / 收款期 / 缺件人数，**不放「今天」**，
 * 所以调整「今天」的口径不会给存量提醒换键重发。
 *
 * 三层时间口径（勿造第四套）：
 *   - 「今天」= 北京业务日（businessDateISO）——规则 1–4 比出行日、算窗口都用它；
 *   - 占位单收款期（规则 5）的「今天」另按班次 departureTz 折，与建单时写 dueDate 的口径一致；
 *   - hotelCheckIn / passportExpiry / installment.dueDate 是 @db.Date，按 UTC 切日（utcDateStr）。
 *
 * 出发时间口径与履约台一致（见 fulfillment.service.ts listTasks）：
 * 订单内最早一段机票的起飞时间（按班次时区取当地日期）；无机票则取最早酒店入住日。
 */
import {
  FulfillmentStatus,
  FulfillmentType,
  OrderStatus,
  Prisma,
  ReceiptSource,
  ReceiptStatus,
  ReminderPriority,
  HoldOrderStatus,
  HoldInstallmentStatus,
  VisaSubmissionStatus,
  type PrismaClient,
} from '@prisma/client';
import { businessDateISO } from '../../lib/business-time.js';
import { localDateISO } from '../../lib/flight-time.js';

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
// 规则 6 出票提醒：出发 5 天内还有乘客缺票号就催（≤2 天升级 CRITICAL）——
// 防「单子标了已出票、票号却没回填/根本没出」的假票号缺口。
const TICKET_MISSING_WINDOW_DAYS = 5;
const TICKET_CRITICAL_DAYS = 2;
// 规则 7 送签提醒：出发 7 天内还有非自备签乘客未完成送签就催（≤3 天升级 CRITICAL）——
// 签证缺件规则只管「缺材料」，这条管「材料齐了没人送」。
const VISA_SUBMIT_WINDOW_DAYS = 7;
const VISA_SUBMIT_CRITICAL_DAYS = 3;
// 规则 8 分房提醒：入住 3 天内订单还没进分房表就提醒房控（≤1 天升级 CRITICAL）。
const ROOM_UNASSIGNED_WINDOW_DAYS = 3;
const ROOM_UNASSIGNED_CRITICAL_DAYS = 1;
// 规则 9 到账核实积压：OPS_CLAIM 手工登记的到账挂 ≥2 天未经财务核实就催（≥7 天升级 CRITICAL）。
const RECEIPT_VERIFY_AGE_DAYS = 2;
const RECEIPT_VERIFY_CRITICAL_AGE_DAYS = 7;

// ── 日期纯函数（可单测）────────────────────────────────────────────────────
/**
 * Date → UTC 日期字符串 YYYY-MM-DD（`@db.Date` 的正确读法：库里存的是 UTC 午夜）。
 *
 * ⚠️ 只用于 `@db.Date` 字段（passportExpiry / hotelCheckIn / installment.dueDate）。
 * 「今天」不能用它算——那是系统时刻，要按北京业务日折，见 businessDateISO。
 */
export function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 起飞时刻在班次时区下的当地日期（YYYY-MM-DD）；时区缺失/非法回落 UTC。
 * 实现统一走 lib/flight-time.ts，本文件不再自带一份折算（全站只留一套航班时区口径）。
 */
export function dateInTz(d: Date, tz: string | null | undefined): string {
  return localDateISO(d, tz);
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
export type RuleName =
  | 'BALANCE_DUE'
  | 'DEPARTURE_SOON'
  | 'PASSPORT_EXPIRY'
  | 'VISA_MISSING'
  | 'HOLD_INSTALLMENT_DUE'
  | 'TICKET_MISSING'
  | 'VISA_NOT_SUBMITTED'
  | 'ROOM_UNASSIGNED'
  | 'RECEIPT_UNVERIFIED';

export interface ReminderCandidate {
  rule: RuleName;
  ruleKey: string;
  orderId: string | null;
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
  /** 分房表 JSON（{ roomGroups: [...] }）；可选 = 老调用方不传时规则 8 不触发。*/
  roomAssignment?: unknown;
  items: DepartureSourceItem[];
  passengers: {
    id: string;
    fullName: string;
    passportExpiry: Date | null;
    /** 票号；可选 = 老调用方不传时规则 6 不判该乘客（undefined ≠ 缺票号）。*/
    eticketNumber?: string | null;
  }[];
}

/**
 * 分房表是否已有实际分房（任一房组里有人）。空 roomGroups / 全空组视同未分房——
 * 保存过一张空表不该让「未分房」提醒哑掉。
 */
export function hasRoomAssignment(roomAssignment: unknown): boolean {
  if (!roomAssignment || typeof roomAssignment !== 'object') return false;
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => {
    const ids = (g as { passengerIds?: unknown }).passengerIds;
    return Array.isArray(ids) && ids.length > 0;
  });
}

export interface RuleVisaTask {
  taskId: string;
  orderId: string;
  orderNumber: string;
  items: DepartureSourceItem[];
  /** 缺护照照片的乘客姓名（已在库内过滤：不拉大字段 + 排除自备签乘客 visaExempt=true） */
  missingPassengerNames: string[];
}

export interface RuleHoldInstallment {
  id: string;
  label: string;
  amountCny: number;
  status: HoldInstallmentStatus;
  dueDate: Date;
}

export interface RuleHoldOrder {
  id: string;
  holdNo: string;
  groupName: string | null;
  status: HoldOrderStatus;
  installments: RuleHoldInstallment[];
  flightSchedule?: { departureTz: string | null } | null;
}

/**
 * 规则 1–3：逐单判定，返回候选。
 * @param today 「今天」YYYY-MM-DD —— 北京业务日（由 generateRuleReminders 折好传入）。
 *   出发日 departure 是航段当地日；两者相减得到的 days 是「还有几天出发」的运营口径，
 *   跨时区严格算是近似值，但窗口本身就是 3/14 天量级，误差一天以内可接受。
 */
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

  // 6) 出票提醒：有机票航段、出发 5 天内（含今天）、仍有乘客缺票号。
  //    eticketNumber === undefined 表示调用方没取这个字段（老口径）→ 不判该乘客，
  //    避免「没查字段」被当成「没出票」误报；null / 空串才是真缺票号。
  if (
    DEPARTURE_SOON_STATUSES.includes(order.status) &&
    days >= 0 &&
    days <= TICKET_MISSING_WINDOW_DAYS &&
    order.items.some((item) => item.flightSchedule)
  ) {
    const missing = order.passengers.filter(
      (p) => p.eticketNumber !== undefined && (p.eticketNumber ?? '').trim() === '',
    );
    if (missing.length > 0) {
      out.push({
        rule: 'TICKET_MISSING',
        ruleKey: `TICKET:${order.id}:${departure}`,
        orderId: order.id,
        title: `【临近出发未出票】${order.orderNumber} ${missing.length}人缺票号`,
        body: `出发 ${departure}，尚未录入票号乘客：${missing.map((p) => p.fullName).join('，')}。请票务确认出票并回填票号。`,
        priority: days <= TICKET_CRITICAL_DAYS ? ReminderPriority.CRITICAL : ReminderPriority.HIGH,
        dueAt: today,
      });
    }
  }

  // 8) 分房提醒：有酒店入住、最早入住日 3 天内（含今天）、分房表还没分人。
  //    roomAssignment === undefined 表示调用方没取这个字段（老口径）→ 不判，同规则 6 哲学。
  if (order.roomAssignment !== undefined && DEPARTURE_SOON_STATUSES.includes(order.status)) {
    const checkIns = order.items
      .filter((item): item is DepartureSourceItem & { hotelCheckIn: Date } =>
        Boolean(item.hotelCheckIn),
      )
      .map((item) => item.hotelCheckIn.getTime());
    if (checkIns.length > 0 && !hasRoomAssignment(order.roomAssignment)) {
      const firstCheckIn = utcDateStr(new Date(Math.min(...checkIns)));
      const daysToCheckIn = diffDays(today, firstCheckIn);
      if (daysToCheckIn >= 0 && daysToCheckIn <= ROOM_UNASSIGNED_WINDOW_DAYS) {
        out.push({
          rule: 'ROOM_UNASSIGNED',
          ruleKey: `ROOMASSIGN:${order.id}:${firstCheckIn}`,
          orderId: order.id,
          title: `【临近入住未分房】${order.orderNumber} ${firstCheckIn}入住`,
          body: `最早入住 ${firstCheckIn}，该单还没进分房表。请房控完成分房（随机档单需先落位到具体酒店）。`,
          priority:
            daysToCheckIn <= ROOM_UNASSIGNED_CRITICAL_DAYS
              ? ReminderPriority.CRITICAL
              : ReminderPriority.HIGH,
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

/** 规则 7 的输入：有在办签证任务的订单 + 尚未完成送签（CONFIRMED 之外）的非自备签乘客名单。*/
export interface RuleVisaSubmissionOrder {
  orderId: string;
  orderNumber: string;
  items: DepartureSourceItem[];
  /** visaExempt=false 且 visaSubmissionStatus ≠ CONFIRMED 的乘客姓名（库内过滤）。*/
  pendingPassengerNames: string[];
}

/**
 * 规则 7：临近出发签证未送签完成。签证缺件（规则 4）只管「缺材料」，这条管
 * 「材料齐了没人送」——出发 7 天内还有非自备签乘客送签进度不到「已送签」（CONFIRMED）就催。
 */
export function buildVisaSubmissionCandidates(
  order: RuleVisaSubmissionOrder,
  today: string,
): ReminderCandidate[] {
  const departure = deriveDepartureDate(order.items);
  if (!departure) return [];
  const days = diffDays(today, departure);
  if (days < 0 || days > VISA_SUBMIT_WINDOW_DAYS) return [];
  const count = order.pendingPassengerNames.length;
  if (count === 0) return [];
  return [
    {
      rule: 'VISA_NOT_SUBMITTED',
      ruleKey: `VISASUBMIT:${order.orderId}:${departure}`,
      orderId: order.orderId,
      title: `【临近出发未送签】${order.orderNumber} ${count}人未完成送签`,
      body: `出发 ${departure}，未完成送签乘客：${order.pendingPassengerNames.join('，')}（自备签乘客已排除）。请签证岗尽快送签或更新送签进度。`,
      priority:
        days <= VISA_SUBMIT_CRITICAL_DAYS ? ReminderPriority.CRITICAL : ReminderPriority.HIGH,
      dueAt: today,
    },
  ];
}

/** 规则 9 的输入：OPS_CLAIM 手工登记、财务尚未核实的到账。*/
export interface RuleUnverifiedReceipt {
  id: string;
  receiptNo: string;
  amountCny: Prisma.Decimal;
  createdAt: Date;
}

/**
 * 规则 9：到账核实队列积压。运营凭客户水单手工登记的到账（source=OPS_CLAIM）
 * 挂 ≥2 天还没经财务对流水核实（verifiedAt 空）就催——钱到没到账不能一直悬着。
 * ruleKey 只含 receipt id：同一笔只提醒一次，财务处理完 resolve 即消；不按天重发刷屏。
 */
export function buildReceiptVerifyCandidates(
  receipt: RuleUnverifiedReceipt,
  today: string,
): ReminderCandidate[] {
  const claimedOn = businessDateISO(receipt.createdAt);
  const ageDays = diffDays(claimedOn, today);
  if (ageDays < RECEIPT_VERIFY_AGE_DAYS) return [];
  return [
    {
      rule: 'RECEIPT_UNVERIFIED',
      ruleKey: `CLAIMVERIFY:${receipt.id}`,
      orderId: null,
      title: `【到账待核实】${receipt.receiptNo} ¥${formatAmount(receipt.amountCny)} 已挂${ageDays}天`,
      body: `运营手工登记的到账（${claimedOn}）尚未经财务核实，请对照收款平台流水确认后在收款台核实。`,
      priority:
        ageDays >= RECEIPT_VERIFY_CRITICAL_AGE_DAYS
          ? ReminderPriority.CRITICAL
          : ReminderPriority.HIGH,
      dueAt: today,
    },
  ];
}

/** 规则 5：占位单收款期截止提醒；日期口径与 dueDate（建单时已按起飞地折算）一致。 */
export function buildHoldInstallmentCandidates(hold: RuleHoldOrder, today: string): ReminderCandidate[] {
  const activeStatuses: HoldOrderStatus[] = [HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE];
  if (!activeStatuses.includes(hold.status)) return [];
  const limit = addDaysUtc(today, 3);
  const out: ReminderCandidate[] = [];
  for (const item of hold.installments) {
    if (item.status !== HoldInstallmentStatus.PENDING) continue;
    const dueDate = utcDateStr(item.dueDate);
    if (dueDate > limit) continue;
    const overdue = dueDate < today;
    out.push({
        rule: 'HOLD_INSTALLMENT_DUE' as const,
        ruleKey: `HOLD_DUE:${item.id}:${dueDate}`,
        orderId: null,
        title: `【占位单催款】${hold.holdNo} ${hold.groupName ?? ''}${item.label} ¥${item.amountCny}`.trim(),
        body: `占位单 ${hold.holdNo}（${hold.groupName ?? '未填团名'}）${item.label}应收 ¥${item.amountCny}，截止 ${dueDate}，请及时跟进。`,
        priority: overdue ? ReminderPriority.CRITICAL : ReminderPriority.HIGH,
        dueAt: overdue ? today : dueDate,
      });
  }
  return out;
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
  now = new Date(),
): Promise<GenerateRuleRemindersResult> {
  // 「今天」= 北京业务日。以前按 UTC 日切，北京 00:00–08:00 跑这个扫描会拿到昨天：
  // 今天出发的单被算成「还有 1 天」，昨天已出发的单还会被催尾款。
  // 注意 ruleKey 不含 today（键里是出发日/收款期/缺件人数），所以这次口径变更
  // **不会**给存量提醒换键、也就不会重发；只影响窗口边界的判定与新条目的 dueAt。
  const today = businessDateISO(now);

  const holdDelegate = (prisma as unknown as { holdOrder?: { findMany: (args: unknown) => Promise<RuleHoldOrder[]> } }).holdOrder;
  const [orders, visaTasks, holdOrders] = await Promise.all([
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
        // 分房表 JSON（规则 8 判是否已分房；只有 roomGroups/passengerIds，无大字段）
        roomAssignment: true,
        // 只取推导出发时间需要的行（有机票班次或酒店入住日的）
        items: {
          where: { OR: [{ flightScheduleId: { not: null } }, { hotelCheckIn: { not: null } }] },
          select: {
            hotelCheckIn: true,
            flightSchedule: { select: { departureTime: true, departureTz: true } },
          },
        },
        passengers: {
          select: { id: true, fullName: true, passportExpiry: true, eticketNumber: true },
        },
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
                // 只取缺照片乘客的姓名；护照大图（base64 可达数 MB）绝不拉到应用层。
                // 自备签证乘客（visaExempt=true）不催缺件——与签证台同口径（见 fulfillment.service.ts listByOrder）。
                passengers: {
                  where: {
                    visaExempt: false,
                    OR: [{ passportPhotoUrl: null }, { passportPhotoUrl: '' }],
                  },
                  select: { fullName: true },
                },
              },
            },
          },
        },
      },
    }),
    holdDelegate
      ? holdDelegate.findMany({
          where: { status: { in: [HoldOrderStatus.PENDING, HoldOrderStatus.HOLDING, HoldOrderStatus.OVERDUE] } },
          select: {
            id: true,
            holdNo: true,
            groupName: true,
            status: true,
            flightSchedule: { select: { departureTz: true } },
            installments: { where: { status: HoldInstallmentStatus.PENDING }, select: { id: true, label: true, amountCny: true, status: true, dueDate: true } },
          },
        })
      : Promise.resolve([] as RuleHoldOrder[]),
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
  for (const hold of holdOrders) {
    const holdToday = dateInTz(now, hold.flightSchedule?.departureTz);
    candidates.push(...buildHoldInstallmentCandidates(hold, holdToday));
  }

  // ── 规则 7：临近出发未送签（订单级；范围 = 有在办签证任务的订单）─────────────
  // 一条按 orderId in 的轻量查询取「非自备签且送签进度 ≠ 已送签」的乘客名单——
  // 不能塞进上面的 visaTasks select：那里的 passengers 已按「缺照片」过滤，同一关系
  // 一个 select 里不能带两套 where。防御式取 delegate 与 holdOrder 同哲学（旧测试 mock 没有它）。
  const visaOrderById = new Map<string, { orderNumber: string; items: DepartureSourceItem[] }>();
  for (const task of visaTasks) {
    const order = task.orderItem.order;
    if (order.deletedAt) continue;
    visaOrderById.set(order.id, { orderNumber: order.orderNumber, items: order.items });
  }
  const passengerDelegate = (
    prisma as unknown as {
      passenger?: {
        findMany: (args: unknown) => Promise<Array<{ orderId: string; fullName: string }>>;
      };
    }
  ).passenger;
  if (passengerDelegate && visaOrderById.size > 0) {
    const pendingPax = await passengerDelegate.findMany({
      where: {
        orderId: { in: [...visaOrderById.keys()] },
        visaExempt: false,
        visaSubmissionStatus: { not: VisaSubmissionStatus.CONFIRMED },
      },
      select: { orderId: true, fullName: true },
    });
    const namesByOrder = new Map<string, string[]>();
    for (const pax of pendingPax) {
      const list = namesByOrder.get(pax.orderId) ?? [];
      list.push(pax.fullName);
      namesByOrder.set(pax.orderId, list);
    }
    for (const [orderId, names] of namesByOrder) {
      const order = visaOrderById.get(orderId)!;
      candidates.push(
        ...buildVisaSubmissionCandidates(
          {
            orderId,
            orderNumber: order.orderNumber,
            items: order.items,
            pendingPassengerNames: names,
          },
          today,
        ),
      );
    }
  }

  // ── 规则 9：到账核实队列积压（OPS_CLAIM 未核实；量级小，全取后在内存按挂账天数过滤）──
  const receiptDelegate = (
    prisma as unknown as {
      receipt?: { findMany: (args: unknown) => Promise<RuleUnverifiedReceipt[]> };
    }
  ).receipt;
  if (receiptDelegate) {
    const unverified = await receiptDelegate.findMany({
      where: { source: ReceiptSource.OPS_CLAIM, verifiedAt: null, status: { not: ReceiptStatus.REFUNDED } },
      select: { id: true, receiptNo: true, amountCny: true, createdAt: true },
    });
    for (const receipt of unverified) {
      candidates.push(...buildReceiptVerifyCandidates(receipt, today));
    }
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
