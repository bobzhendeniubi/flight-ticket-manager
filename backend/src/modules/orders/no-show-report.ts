/**
 * no-show 报表 —— 「这段时间，哪几班 no-show 了多少人、放回去多少座、又要回来多少座」。
 *
 * 为什么要有它：no-show 的每一步都只在订单行的 metadata 快照里留痕（零迁移设计），
 * 单看订单页只能一张一张翻。可票务/财务真正要回答的是**按班次**的问题 ——
 * 「那一班放回库存的座卖出去了没有？有几个客人后来又要回程了？有没有为了让人回来而超售？
 *   还有几条撤名单工单没人处理？」
 *
 * 数据源（全部是既有快照，本文件一个字都不写库）：
 *   · 去程行 metadata.noShow            —— 谁被标了、什么时候标的、名单日期；
 *   · 回程行 metadata.returnReleased    —— 放了几座（逐舱明细）+ history 历次；
 *   · 回程行 metadata.returnRestored    —— 恢复了几座、超售几座、挤掉几座他人软预留；
 *   · 回程行 metadata.returnVoidedFinal —— 起飞后作废（终态）；
 *   · 各行 metadata.legActionLog        —— 逐次动作流水（多轮释放/恢复的**唯一**全量来源）；
 *   · OperationalReminder（NOSHOW_WITHDRAW / NOSHOW_RELIST）—— 未处理的工单条数。
 *
 * 口径三条，读表前先看清楚：
 *   1. **按去程航班的当地日期**分组（与全站「出发日期」同口径），不是按 no-show 的操作日期。
 *   2. releasedSeats / restoredSeats 是**累计事件量**（释放→恢复→再释放会各记各的），
 *      stillReleasedSeats 才是「此刻还躺在库存里可卖的座」。两个数不该相等，也不该互相校验。
 *   3. oversoldSeats / displacedSeats 取**最近一次恢复**的快照值（恢复不留 history 快照）。
 *      多次超售恢复同一段极罕见；要逐次复盘请查审计里的 RESTORE_RETURN_LEG_OVERSOLD。
 *
 * 回收站单（deletedAt 非空）不进表：与全站其它导出同口径。
 */

import ExcelJS from 'exceljs';
import { OrderItemKind, OrderLegFlag, ReminderStatus, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { localDateISO } from '../../lib/flight-time.js';
import { businessDateTime } from '../../lib/business-time.js';
import { determineFlightLegItems } from './ticketing-cap.js';
import { formatLegStatus, isReturnCurrentlyReleased } from './orders.leg-status.js';

// ── 契约 ────────────────────────────────────────────────────────────────────

/** 一班的汇总行。 */
export interface NoShowReportRow {
  scheduleId: string;
  flightNumber: string;
  /** 起飞地当地日 YYYY-MM-DD。 */
  departDate: string;
  /** 该班有多少张单被标了 no-show。 */
  orders: number;
  /** 被标 no-show 的人次。 */
  noShowPax: number;
  /** 累计释放回库存的回程座数（含多轮再释放）。 */
  releasedSeats: number;
  /** 累计恢复回原班次的座数（含多轮恢复）。 */
  restoredSeats: number;
  /** 恢复时放行的超售座数（最近一次恢复口径）。 */
  oversoldSeats: number;
  /** 恢复时挤掉的他人软预留座数（最近一次恢复口径）。 */
  displacedSeats: number;
  /** 已过期作废（起飞后终态）的回程座数。 */
  voidedSeats: number;
  /** 此刻仍处于「已释放」态、可继续销售的座数。 */
  stillReleasedSeats: number;
  /** 该班相关的 no-show 工单里仍是待处理/处理中的条数。 */
  workOrdersOpen: number;
}

/** 汇总合计（字段与 NoShowReportRow 的数值列一一对应）。 */
export type NoShowReportTotals = Omit<
  NoShowReportRow,
  'scheduleId' | 'flightNumber' | 'departDate'
>;

/** 明细 sheet 的一行（逐单）。 */
export interface NoShowReportDetailRow {
  orderNumber: string;
  /** 被标 no-show 的乘客（中文名优先，顿号分隔）。 */
  passengers: string;
  agent: string;
  flightNumber: string;
  departDate: string;
  /** 标记时间（北京业务时间）。 */
  noShowAt: string;
  /** 回程当前状态（派生自航段快照；单程单为「无回程」）。 */
  returnStatus: string;
  releasedSeats: number;
  restoredAt: string;
  oversoldSeats: number;
  voidedAt: string;
  workOrderStatus: string;
}

export interface NoShowReport {
  rows: NoShowReportRow[];
  totals: NoShowReportTotals;
  details: NoShowReportDetailRow[];
}

// ── 聚合内核的入参形状（纯数据，便于单测直接喂） ──────────────────────────────

export interface NoShowReportItemView {
  id: string;
  kind: OrderItemKind;
  flightScheduleId: string | null;
  metadata: unknown;
  flightSchedule?: {
    departureTime: Date;
    departureTz: string | null;
    flight?: { flightNumber: string } | null;
  } | null;
}

export interface NoShowReportOrderView {
  id: string;
  orderNumber: string;
  agentName: string | null;
  passengers: Array<{ id: string; fullName: string; chineseName: string | null }>;
  items: NoShowReportItemView[];
  reminders: Array<{ ruleKey: string | null; status: ReminderStatus }>;
}

// ── 快照读取（全部防御式：脏 JSON 读侧一律按缺省处理，不抛错） ─────────────────

function readObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function readArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function toInt(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** 一份 returnReleased 快照里的逐舱张数之和。 */
function releasedSeatTotal(snapshot: unknown): number {
  return readArray(readObject(snapshot).releasedSeats).reduce(
    (n: number, entry) => n + toInt(readObject(entry).quantity),
    0,
  );
}

/** 快照里的 ISO 时间戳（缺失/不可解析 → null）。 */
function snapshotDate(snapshot: unknown): Date | null {
  const at = readObject(snapshot).at;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** 一行的动作流水（形状不符的条目丢弃）。 */
function legActionEntries(metadata: unknown): Array<{ type: string; seats: number }> {
  return readArray(readObject(metadata).legActionLog)
    .map((e) => readObject(e))
    .filter((e) => typeof e.type === 'string')
    .map((e) => ({ type: e.type as string, seats: toInt(e.seats) }));
}

/**
 * 一行上的座位事件量。
 *
 * 主源是 legActionLog（多轮释放/恢复的唯一全量来源）。老数据没有这条流水时回落到快照：
 * 当前 returnReleased + 它的 history（首刷时 history 为空，每次再释放把上一份整体压进去）。
 */
function seatEventsOfItem(metadata: unknown): { released: number; restored: number } {
  const entries = legActionEntries(metadata);
  const released = entries
    .filter((e) => e.type === 'NO_SHOW' || e.type === 'RELEASE')
    .reduce((n, e) => n + e.seats, 0);
  const restored = entries.filter((e) => e.type === 'RESTORE').reduce((n, e) => n + e.seats, 0);
  if (entries.length > 0) return { released, restored };

  const meta = readObject(metadata);
  const currentRelease = readObject(meta.returnReleased);
  const fallbackReleased =
    releasedSeatTotal(currentRelease) +
    readArray(currentRelease.history).reduce((n: number, h) => n + releasedSeatTotal(h), 0);
  const fallbackRestored = toInt(readObject(meta.returnRestored).seats);
  return { released: fallbackReleased, restored: fallbackRestored };
}

/** 仍未收口的工单状态。 */
const OPEN_REMINDER_STATUSES: ReminderStatus[] = [ReminderStatus.OPEN, ReminderStatus.IN_PROGRESS];

/** no-show 派生的工单 ruleKey 前缀（撤名单/退票、重新上架可卖）。 */
export const NO_SHOW_REMINDER_PREFIXES = ['NOSHOW_WITHDRAW:', 'NOSHOW_RELIST:'] as const;

function isNoShowReminder(ruleKey: string | null): boolean {
  return ruleKey != null && NO_SHOW_REMINDER_PREFIXES.some((p) => ruleKey.startsWith(p));
}

// ── 聚合 ────────────────────────────────────────────────────────────────────

const EMPTY_TOTALS: NoShowReportTotals = {
  orders: 0,
  noShowPax: 0,
  releasedSeats: 0,
  restoredSeats: 0,
  oversoldSeats: 0,
  displacedSeats: 0,
  voidedSeats: 0,
  stillReleasedSeats: 0,
  workOrdersOpen: 0,
};

/**
 * 订单快照 → 按班次汇总 + 逐单明细（**纯函数**，无 IO，单测直接喂假数据）。
 *
 * 只收「去程行带 noShow 快照」的单：没标过 no-show 的单不该出现在 no-show 报表里。
 */
export function aggregateNoShowReport(orders: readonly NoShowReportOrderView[]): NoShowReport {
  const byScheduleId = new Map<string, NoShowReportRow>();
  const details: NoShowReportDetailRow[] = [];

  for (const order of orders) {
    const flightRows = order.items.filter((it) => it.kind === OrderItemKind.FLIGHT);
    const { outbound } = determineFlightLegItems(flightRows);
    if (!outbound?.flightScheduleId) continue;
    const noShowSnap = readObject(readObject(outbound.metadata).noShow);
    if (noShowSnap.at == null) continue;

    const scheduleId = outbound.flightScheduleId;
    const sched = outbound.flightSchedule;
    const flightNumber = sched?.flight?.flightNumber ?? '';
    const departDate = sched?.departureTime
      ? localDateISO(sched.departureTime, sched.departureTz)
      : '';

    // ── 该单的座位事件量（逐行累加：释放留痕落在回程行、单程单落在去程行）──
    let released = 0;
    let restored = 0;
    let oversold = 0;
    let displaced = 0;
    let voided = 0;
    let stillReleased = 0;
    let restoredAt: Date | null = null;
    let voidedAt: Date | null = null;
    let returnStatus = '';

    for (const row of flightRows) {
      const meta = readObject(row.metadata);
      const events = seatEventsOfItem(row.metadata);
      released += events.released;
      restored += events.restored;

      const restoredSnap = readObject(meta.returnRestored);
      if (restoredSnap.at != null) {
        if (restoredSnap.oversold === true) oversold += toInt(restoredSnap.oversoldBy);
        displaced += toInt(restoredSnap.displacedReserved);
        const at = snapshotDate(restoredSnap);
        if (at && (restoredAt == null || at > restoredAt)) restoredAt = at;
      }

      // 作废 / 仍处于已释放态，都按「最后一次释放放了几座」计：这几座此刻的去向就是它。
      const lastReleaseSeats = releasedSeatTotal(meta.returnReleased);
      if (meta.returnVoidedFinal != null) {
        voided += lastReleaseSeats;
        const at = snapshotDate(meta.returnVoidedFinal);
        if (at && (voidedAt == null || at > voidedAt)) voidedAt = at;
      } else if (isReturnCurrentlyReleased({ ...row, kind: 'FLIGHT' })) {
        stillReleased += lastReleaseSeats;
      }

      if (row.id !== outbound.id) {
        const status = formatLegStatus({ ...row, kind: 'FLIGHT' });
        if (status !== '') returnStatus = status;
      }
    }

    const markedIds = readArray(noShowSnap.passengerIds).filter(
      (v): v is string => typeof v === 'string',
    );
    const noShowPax = markedIds.length > 0 ? markedIds.length : order.passengers.length;
    const workOrdersOpen = order.reminders.filter(
      (r) => isNoShowReminder(r.ruleKey) && OPEN_REMINDER_STATUSES.includes(r.status),
    ).length;

    const row = byScheduleId.get(scheduleId) ?? {
      scheduleId,
      flightNumber,
      departDate,
      ...EMPTY_TOTALS,
    };
    row.orders += 1;
    row.noShowPax += noShowPax;
    row.releasedSeats += released;
    row.restoredSeats += restored;
    row.oversoldSeats += oversold;
    row.displacedSeats += displaced;
    row.voidedSeats += voided;
    row.stillReleasedSeats += stillReleased;
    row.workOrdersOpen += workOrdersOpen;
    byScheduleId.set(scheduleId, row);

    const markedSet = new Set(markedIds);
    const shownPassengers = order.passengers.filter(
      (p) => markedSet.size === 0 || markedSet.has(p.id),
    );
    const hasNoShowReminder = order.reminders.some((r) => isNoShowReminder(r.ruleKey));
    details.push({
      orderNumber: order.orderNumber,
      passengers: shownPassengers.map((p) => p.chineseName || p.fullName).join('、'),
      agent: order.agentName ?? '直客',
      flightNumber,
      departDate,
      noShowAt: businessDateTime(snapshotDate(noShowSnap)),
      returnStatus: returnStatus || (flightRows.length > 1 ? '' : '无回程'),
      releasedSeats: released,
      restoredAt: businessDateTime(restoredAt),
      oversoldSeats: oversold,
      voidedAt: businessDateTime(voidedAt),
      workOrderStatus:
        workOrdersOpen > 0 ? `待处理 ${workOrdersOpen} 条` : hasNoShowReminder ? '已收口' : '无工单',
    });
  }

  const rows = [...byScheduleId.values()].sort((a, b) =>
    a.departDate === b.departDate
      ? a.flightNumber.localeCompare(b.flightNumber)
      : a.departDate.localeCompare(b.departDate),
  );
  const totals = rows.reduce<NoShowReportTotals>(
    (acc, r) => ({
      orders: acc.orders + r.orders,
      noShowPax: acc.noShowPax + r.noShowPax,
      releasedSeats: acc.releasedSeats + r.releasedSeats,
      restoredSeats: acc.restoredSeats + r.restoredSeats,
      oversoldSeats: acc.oversoldSeats + r.oversoldSeats,
      displacedSeats: acc.displacedSeats + r.displacedSeats,
      voidedSeats: acc.voidedSeats + r.voidedSeats,
      stillReleasedSeats: acc.stillReleasedSeats + r.stillReleasedSeats,
      workOrdersOpen: acc.workOrdersOpen + r.workOrdersOpen,
    }),
    { ...EMPTY_TOTALS },
  );
  details.sort((a, b) =>
    a.departDate === b.departDate
      ? a.orderNumber.localeCompare(b.orderNumber)
      : a.departDate.localeCompare(b.departDate),
  );
  return { rows, totals, details };
}

// ── 装载 ────────────────────────────────────────────────────────────────────

/**
 * 取区间内的报表数据。
 *
 * 选班次走**权威 SQL**（双段 AT TIME ZONE 折算起飞地当地日），与占位单导出同一套写法 ——
 * 用 UTC 窗口猜当地日会在跨时区边界上漏班/多班。
 */
export async function loadNoShowReport(
  from: string,
  to: string,
  client: PrismaClient = defaultPrisma,
): Promise<NoShowReport> {
  const scheduleRows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM "FlightSchedule" s
    WHERE (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date >= ${from}::date
      AND (s."departureTime" AT TIME ZONE 'UTC' AT TIME ZONE s."departureTz")::date <= ${to}::date
  `;
  const scheduleIds = scheduleRows.map((r) => r.id);
  if (scheduleIds.length === 0) {
    return { rows: [], totals: { ...EMPTY_TOTALS }, details: [] };
  }

  const orders = await client.order.findMany({
    where: {
      deletedAt: null,
      // legFlag 粗筛（有索引）：没动过航段的单恒为 NONE，一个 no-show 快照都不会有 ——
      // 不筛的话一班几百张正常单全都要连行带 metadata 捞进内存再逐单丢掉。
      // 粗筛只保证「不漏」：取消航段的单 legFlag 也非 NONE，但它没有 noShow 快照，
      // 会被 aggregateNoShowReport 里的「去程行必须带 noShow 快照」那一关精筛掉。
      legFlag: { not: OrderLegFlag.NONE },
      items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { in: scheduleIds } } },
    },
    select: {
      id: true,
      orderNumber: true,
      agent: { select: { companyName: true, contactName: true } },
      passengers: { select: { id: true, fullName: true, chineseName: true } },
      items: {
        where: { kind: OrderItemKind.FLIGHT },
        select: {
          id: true,
          kind: true,
          flightScheduleId: true,
          metadata: true,
          flightSchedule: {
            select: {
              departureTime: true,
              departureTz: true,
              flight: { select: { flightNumber: true } },
            },
          },
        },
      },
      reminders: { select: { ruleKey: true, status: true } },
    },
  });

  const scheduleSet = new Set(scheduleIds);
  const views: NoShowReportOrderView[] = orders
    .map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      agentName: o.agent ? o.agent.companyName || o.agent.contactName || null : null,
      passengers: o.passengers,
      items: o.items,
      reminders: o.reminders,
    }))
    // 该单的**去程**必须落在选中的班次里：同一个班次可能是别的单的回程，
    // 那种单不属于这一班的 no-show 台账。
    .filter((o) => {
      const { outbound } = determineFlightLegItems(
        o.items.filter((it) => it.kind === OrderItemKind.FLIGHT),
      );
      return outbound?.flightScheduleId != null && scheduleSet.has(outbound.flightScheduleId);
    });

  return aggregateNoShowReport(views);
}

// ── 导出 ────────────────────────────────────────────────────────────────────

const SUMMARY_COLUMNS: Array<{ header: string; key: keyof NoShowReportRow; width: number }> = [
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: '航班号', key: 'flightNumber', width: 10 },
  { header: '订单数', key: 'orders', width: 8 },
  { header: 'no-show 人次', key: 'noShowPax', width: 14 },
  { header: '累计释放座数', key: 'releasedSeats', width: 14 },
  { header: '累计恢复座数', key: 'restoredSeats', width: 14 },
  { header: '超售座数', key: 'oversoldSeats', width: 10 },
  { header: '挤占预留座数', key: 'displacedSeats', width: 14 },
  { header: '已作废座数', key: 'voidedSeats', width: 12 },
  { header: '当前可卖座数', key: 'stillReleasedSeats', width: 14 },
  { header: '未处理工单', key: 'workOrdersOpen', width: 12 },
];

const DETAIL_COLUMNS: Array<{ header: string; key: keyof NoShowReportDetailRow; width: number }> = [
  { header: '订单号', key: 'orderNumber', width: 20 },
  { header: '乘客', key: 'passengers', width: 24 },
  { header: '代理', key: 'agent', width: 20 },
  { header: '去程航班', key: 'flightNumber', width: 10 },
  { header: '出发日期', key: 'departDate', width: 12 },
  { header: 'no-show 时间', key: 'noShowAt', width: 18 },
  { header: '回程状态', key: 'returnStatus', width: 16 },
  { header: '释放座数', key: 'releasedSeats', width: 10 },
  { header: '恢复时间', key: 'restoredAt', width: 18 },
  { header: '超售座数', key: 'oversoldSeats', width: 10 },
  { header: '作废时间', key: 'voidedAt', width: 18 },
  { header: '工单状态', key: 'workOrderStatus', width: 14 },
];

/** 文件名：`no-show报表_2026-09-01_2026-09-02.xlsx`。 */
export function noShowReportFilename(from: string, to: string): string {
  return `no-show报表_${from}_${to}.xlsx`;
}

/** 汇总 + 明细两个 sheet 的工作簿。 */
export async function buildNoShowReportWorkbook(
  from: string,
  to: string,
  client: PrismaClient = defaultPrisma,
): Promise<Buffer> {
  const report = await loadNoShowReport(from, to, client);
  return renderNoShowReportWorkbook(report, from, to);
}

/** 报表数据 → xlsx Buffer（与装载分开，单测可直接喂聚合结果）。 */
export async function renderNoShowReportWorkbook(
  report: NoShowReport,
  from: string,
  to: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'no-show 报表';
  wb.created = new Date();

  const summary = wb.addWorksheet('按班次汇总');
  summary.columns = SUMMARY_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  summary.getRow(1).font = { bold: true };
  for (const row of report.rows) summary.addRow(row);
  const totalRow = summary.addRow({
    departDate: '合计',
    flightNumber: `${from} ~ ${to}`,
    ...report.totals,
  });
  totalRow.font = { bold: true };

  const detail = wb.addWorksheet('逐单明细');
  detail.columns = DETAIL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  detail.getRow(1).font = { bold: true };
  for (const row of report.details) detail.addRow(row);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
