/**
 * 「换人记录」列 —— 原地换人（swapPassenger）之后，对账/统计类导出里把被换掉的人找回来。
 *
 * 背景（运营反馈：换人后旧人导不出来、统计采不到）：原地换人是就地覆盖同一条 Passenger 行，
 * 所有导出都按 order.passengers 现值出行，旧人从导出里彻底消失；换人费作为 SWAP_FEE 并进
 * adjustmentCny，只剩「尾款/是否清账」里的一个合计数。履约类导出（名单/PNR/送签/分房）只该出
 * 实际出行的新人，不动；本模块只给对账/统计类导出补一列「换人记录」，每次换人一段：
 *
 *   09-30 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥480
 *
 * 多次换人按时间先后用「；」连接。时间按北京时间（系统时间戳口径）。
 *
 * 数据来源：SWAP_ORDER_PASSENGER 审计（与订单详情乘客卡下方「换人 / 改信息记录」同一份），
 * 不新增存储。审计里有：
 *   before = { passengerId, fullName, documentNumber, snapshot?{ chineseName, … } }
 *   after  = { fullName, documentNumber, feeCny, reprice?{ diffCny, repriceSkipped, … } }
 * 换人费取 after.feeCny —— 换人事务里 feeCny>0 就按同一个数写一条 SWAP_FEE 调价流水，
 * 两边是同一笔钱；换人差价取 after.reprice.diffCny（未重算/旧记录没有就不写）。
 * 新人中文名审计没单独记：取同一乘客槽位**下一条**换人审计的 before.snapshot.chineseName，
 * 最后一次换人取乘客行现值；取不到就只写拼音名，不臆造。
 *
 * 换人通道也承接「只改自备签 / 生日 / 性别」这类小修（同一个 action），这类记录姓名与证件号
 * 都没变、也没收费，不算换人，不进本列；没换人但收了费的照实写成「资料变更」。
 *
 * 拆单会把乘客行（保 id）搬到新单，而审计挂在换人当时的订单上 —— 取数时顺着拆单流水把
 * 祖先单一并查上，再按 before.passengerId 归到当前乘客头上，拆出去的人记录跟着人走。
 *
 * 代理视角：本列只有姓名（代理自家乘客，姓名本就可见）+ 时间 + 换人费（代理自己被收的钱），
 * 不含证件号、经手人、备注等内部字段，故全岗总表代理白名单放行本列。
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { businessDateTime } from '../../lib/business-time.js';

/** 换人审计的 action（与 orders.routes.ts 写审计处同一个字面量）。*/
export const SWAP_AUDIT_ACTION = 'SWAP_ORDER_PASSENGER';

/** 一次换人（已从审计解析、已判定为真换人或收了费）。*/
export interface PassengerSwapRecord {
  /** 被换的乘客槽位（Passenger.id，换人就地覆盖，前后同一个 id）。*/
  passengerId: string;
  at: Date;
  oldFullName: string;
  oldChineseName: string | null;
  newFullName: string;
  newChineseName: string | null;
  /** true = 姓名或证件号变了（真换人）；false = 只是资料小修但收了换人费。*/
  identityChanged: boolean;
  /** true = 姓名没变、只换了证件号。*/
  documentOnlyChanged: boolean;
  /** 换人费（after.feeCny）；0 / 缺失 = null。*/
  feeCny: number | null;
  /** 换人差价（after.reprice.diffCny，未重算的不算）；0 / 缺失 = null。*/
  priceDiffCny: number | null;
}

/** 审计行（只取本列用得到的三项）。*/
export interface SwapAuditRow {
  before: unknown;
  after: unknown;
  createdAt: Date;
}

// ── 解析 ────────────────────────────────────────────────────────────────────
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function positiveAmount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** 姓名比对口径：trim + 大写 + 折叠空白（`QIN/XUE` 与 ` qin/xue ` 是同一个名字）。*/
function normName(v: string): string {
  return v.toUpperCase().replace(/\s+/g, ' ').trim();
}

function normDoc(v: string): string {
  return v.toUpperCase().trim();
}

/** 审计 before.snapshot.chineseName；旧记录没有快照 → undefined（与「中文名为空」区分）。*/
function snapshotChineseName(before: Record<string, unknown>): string | null | undefined {
  const snap = before.snapshot;
  if (!snap || typeof snap !== 'object') return undefined;
  return str((snap as Record<string, unknown>).chineseName) || null;
}

/**
 * 一批换人审计 → 按乘客槽位归好的换人记录（每位按时间升序）。
 *
 * 纯函数（不碰 DB），便于单测。
 * @param rows 换人审计（任意顺序；一张单或多张单混在一起都行，按 before.passengerId 分组）
 * @param currentChineseName 乘客槽位 → 现在的中文名（最后一次换人的「新中文名」取它）
 */
export function parseSwapAuditRows(
  rows: readonly SwapAuditRow[],
  currentChineseName: ReadonlyMap<string, string | null> = new Map(),
): Map<string, PassengerSwapRecord[]> {
  const bySlot = new Map<string, SwapAuditRow[]>();
  for (const row of rows) {
    const passengerId = str(obj(row.before).passengerId);
    if (!passengerId) continue; // 缺槽位的残缺记录归不到人头上，不硬挂
    const list = bySlot.get(passengerId) ?? [];
    list.push(row);
    bySlot.set(passengerId, list);
  }

  const out = new Map<string, PassengerSwapRecord[]>();
  for (const [passengerId, list] of bySlot) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const records: PassengerSwapRecord[] = [];
    sorted.forEach((row, i) => {
      const before = obj(row.before);
      const after = obj(row.after);
      const oldFullName = str(before.fullName);
      const newFullName = str(after.fullName);
      const nameChanged = newFullName !== '' && normName(oldFullName) !== normName(newFullName);
      const docChanged = normDoc(str(before.documentNumber)) !== normDoc(str(after.documentNumber));
      const identityChanged = nameChanged || docChanged;
      const feeCny = positiveAmount(after.feeCny);
      const reprice = obj(after.reprice);
      // 未按日历重算（repriceSkipped 有原因码）时 diffCny 不采信，与换人事务的记账口径一致。
      const priceDiffCny = reprice.repriceSkipped ? null : positiveAmount(reprice.diffCny);
      if (!identityChanged && feeCny === null && priceDiffCny === null) return; // 资料小修，不算换人

      // 新人中文名：下一条审计（同槽位、任意类型）换人前快照里的中文名 = 这次换完之后的中文名；
      // 没有下一条就取乘客行现值。下一条是没快照的旧记录 → 取不到，留空。
      const next = sorted[i + 1];
      const newChineseName =
        next !== undefined
          ? snapshotChineseName(obj(next.before)) ?? null
          : currentChineseName.get(passengerId) ?? null;
      records.push({
        passengerId,
        at: row.createdAt,
        oldFullName,
        oldChineseName: snapshotChineseName(before) ?? null,
        newFullName: newFullName || oldFullName,
        newChineseName: newChineseName ? newChineseName.trim() || null : null,
        identityChanged,
        documentOnlyChanged: !nameChanged && docChanged,
        feeCny,
        priceDiffCny,
      });
    });
    if (records.length > 0) out.set(passengerId, records);
  }
  return out;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
/** 多次换人之间的分隔符。*/
export const SWAP_RECORD_SEPARATOR = '；';

function fmtCny(n: number): string {
  return `¥${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

function personLabel(fullName: string, chineseName: string | null): string {
  return [fullName, chineseName ?? ''].filter((s) => s !== '').join(' ') || '—';
}

/**
 * 一次换人 → 一段文案。
 *   真换人：   「09-30 原 QIN/XUE 覃雪 → 新 YANG/LIN 杨林，换人费 ¥480」
 *   只换证件： 「09-30 QIN/XUE 覃雪 更换证件，换人费 ¥480」
 *   资料小修但收了费：「09-30 QIN/XUE 覃雪 资料变更，换人费 ¥480」
 * 换人差价 >0 时追加「，换人差价 ¥X」；没收费就不写费用段。
 */
export function formatSwapRecordSegment(r: PassengerSwapRecord): string {
  const date = businessDateTime(r.at).slice(5, 10); // MM-DD（北京时间）
  const oldLabel = personLabel(r.oldFullName, r.oldChineseName);
  let body: string;
  if (r.identityChanged && !r.documentOnlyChanged) {
    body = `原 ${oldLabel} → 新 ${personLabel(r.newFullName, r.newChineseName)}`;
  } else if (r.documentOnlyChanged) {
    body = `${oldLabel} 更换证件`;
  } else {
    body = `${oldLabel} 资料变更`;
  }
  const money = [
    r.feeCny !== null ? `换人费 ${fmtCny(r.feeCny)}` : '',
    r.priceDiffCny !== null ? `换人差价 ${fmtCny(r.priceDiffCny)}` : '',
  ].filter((s) => s !== '');
  return [`${date} ${body}`, ...money].join('，');
}

/** 若干次换人 → 一个单元格（按时间先后，「；」连接）；没有换人 = 空串。*/
export function formatSwapRecordCell(records: readonly PassengerSwapRecord[] | undefined): string {
  if (!records || records.length === 0) return '';
  return [...records]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(formatSwapRecordSegment)
    .join(SWAP_RECORD_SEPARATOR);
}

/** 一张单所有乘客的换人记录合成一格（订单级导出用）。*/
export function formatOrderSwapRecordCell(
  passengerIds: readonly string[],
  bySlot: ReadonlyMap<string, readonly PassengerSwapRecord[]>,
): string {
  return formatSwapRecordCell(passengerIds.flatMap((id) => bySlot.get(id) ?? []));
}

// ── 取数 ────────────────────────────────────────────────────────────────────
/** IN 列表分批大小（远低于 Postgres 单语句参数上限，整月上千张单也只多几条查询）。*/
const IN_CHUNK = 1000;
/** 顺拆单流水往上找祖先单的最大层数（拆单再拆单也就两三层，防环兜底）。*/
const MAX_SPLIT_DEPTH = 10;

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 本批订单 + 它们沿拆单流水往上的全部祖先单 id（换人审计挂在换人当时的那张单上）。*/
async function withSplitAncestors(orderIds: readonly string[], client: PrismaClient): Promise<string[]> {
  const all = new Set(orderIds);
  let frontier = [...all];
  for (let depth = 0; depth < MAX_SPLIT_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const ids of chunks(frontier, IN_CHUNK)) {
      const recs = await client.orderSplitRecord.findMany({
        where: { targetOrderId: { in: ids } },
        select: { sourceOrderId: true },
      });
      for (const r of recs) {
        if (!all.has(r.sourceOrderId)) {
          all.add(r.sourceOrderId);
          next.push(r.sourceOrderId);
        }
      }
    }
    frontier = next;
  }
  return [...all];
}

/**
 * 批量取本批订单全部乘客的换人记录（按乘客槽位归好）。
 * 查询走 AuditLog 的 (targetType, targetId) 索引，无 N+1。
 * 只返回**当前**在这批订单里的乘客的记录（拆单搬走的人在他现在所在的单上出现）。
 */
export async function loadSwapRecordsByPassenger(
  orders: ReadonlyArray<{
    id: string;
    passengers: ReadonlyArray<{ id: string; chineseName?: string | null }>;
  }>,
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, PassengerSwapRecord[]>> {
  const currentChineseName = new Map<string, string | null>();
  for (const o of orders) for (const p of o.passengers) currentChineseName.set(p.id, p.chineseName ?? null);
  if (currentChineseName.size === 0) return new Map();

  const orderIds = await withSplitAncestors(
    orders.map((o) => o.id),
    client,
  );
  const rows: SwapAuditRow[] = [];
  for (const ids of chunks(orderIds, IN_CHUNK)) {
    const found = await client.auditLog.findMany({
      where: { action: SWAP_AUDIT_ACTION, targetType: 'ORDER', targetId: { in: ids } },
      select: { before: true, after: true, createdAt: true },
    });
    rows.push(...found);
  }
  const parsed = parseSwapAuditRows(rows, currentChineseName);
  // 只留当前在这批订单里的乘客（祖先单上别的乘客的换人不该算到这批单头上）。
  for (const passengerId of [...parsed.keys()]) {
    if (!currentChineseName.has(passengerId)) parsed.delete(passengerId);
  }
  return parsed;
}
