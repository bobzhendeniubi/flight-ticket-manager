/**
 * 票号批量回填页的纯逻辑（勾选键、默认勾选、分片、幂等键）—— 无 React、无网络，可单独推敲。
 *
 * 与 no-show 批量页的 noShowMatch.ts 是同一角色的两份东西：那边的条目是
 *「一张单 + 一串乘客 id」（还牵扯拆单、释放座位），这边是「一位乘客 + 一个 PNR + 一个票号」，
 * 除了「生成 requestToken」这一件事，没有一个函数能共用。
 */
import type { TicketBatchEntry, TicketBatchMatch } from '../../lib/api';

/**
 * 单次提交的条目上限，与服务端 TICKET_BATCH_MAX_ENTRIES 对齐。
 * 超过就分片顺序连发：一片失败不拦后面的片，重发也不会写坏已经对的号（写值幂等）。
 */
export const TICKET_BATCH_CHUNK_SIZE = 200;

/** 勾选键：一位乘客一条（同一人被多行命中时服务端已经合并成一条了）。 */
export function matchKey(m: Pick<TicketBatchMatch, 'orderId' | 'passengerId'>): string {
  return `${m.orderId}:${m.passengerId}`;
}

/**
 * 这一条能不能提交（与服务端闸同源的前置判断，纯粹为了少打一次白工）：
 *   · 名单自相矛盾 → 不行，人得先去把名单改对；
 *   · 库里已经就是这个号 → 提交也不会有变化（服务端只会回 unchanged），不占提交名额。
 * 「库里有不同的号」**不**在这里拦：那是要不要覆盖的问题，交给页面上的覆盖开关。
 */
export function isSubmittable(m: TicketBatchMatch): boolean {
  return !m.rosterConflict && !m.unchanged;
}

/**
 * 默认勾选：能提交、且**不冲突**的条目。
 * 冲突条目（库里已有不同的号）一律默认不勾 —— 覆盖别人已经录好的票号必须是人主动做的动作，
 * 不能靠「默认全勾 + 没人细看」滑过去。
 */
export function defaultSelectedKeys(matched: TicketBatchMatch[]): Set<string> {
  return new Set(matched.filter((m) => isSubmittable(m) && !m.conflict).map(matchKey));
}

/** 勾选集合 → 提交条目。冲突条目按页面上的覆盖开关决定带不带 overwrite。 */
export function buildEntries(
  matched: TicketBatchMatch[],
  selected: Set<string>,
  allowOverwrite: boolean,
): TicketBatchEntry[] {
  return matched
    .filter((m) => selected.has(matchKey(m)) && isSubmittable(m))
    .map((m) => ({
      orderId: m.orderId,
      passengerId: m.passengerId,
      // 名单没给这一列就不传 —— 传 null 与不传在服务端是同一件事（都不动这一列），
      // 但不传更贴近「我们压根没说这一列」的本意。
      ...(m.pnr === null ? {} : { pnr: m.pnr }),
      ...(m.eticketNumber === null ? {} : { eticketNumber: m.eticketNumber }),
      ...(m.conflict && allowOverwrite ? { overwrite: true } : {}),
    }));
}

/** 顺序分片（服务端 entries 上限就是 TICKET_BATCH_CHUNK_SIZE）。 */
export function chunkEntries(
  entries: TicketBatchEntry[],
  size: number = TICKET_BATCH_CHUNK_SIZE,
): TicketBatchEntry[][] {
  const chunks: TicketBatchEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size));
  return chunks;
}

/**
 * 一片载荷的指纹：同一片内容（含「重试失败项」原样重发）算出同一个串 →
 * 页面据此复用同一个 requestToken，整批重试在审计里认得出是同一批。
 * 改了勾选 / 覆盖开关，指纹自然不同、换新键。
 */
export function payloadFingerprint(scheduleId: string, entries: TicketBatchEntry[]): string {
  const body = entries
    .map(
      (e) =>
        `${e.passengerId}:${e.pnr ?? ''}:${e.eticketNumber ?? ''}:${e.overwrite === true ? 1 : 0}`,
    )
    .sort()
    .join('|');
  return `${scheduleId}|${body}`;
}

/**
 * 幂等键（RFC 4122 v4）。
 * 与 no-show 批量页同款实现：crypto.randomUUID 有就用，没有就自己盖版本位/variant 位 ——
 * 少了那两步就不是合法 v4，服务端 zod 的 .uuid() 会直接 400。
 */
export function newRequestToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/** 勾选情况汇总（提交前的确认文案用）。 */
export function summarizeSelection(
  matched: TicketBatchMatch[],
  selected: Set<string>,
): { pax: number; orders: number; overwrites: number } {
  const picked = matched.filter((m) => selected.has(matchKey(m)) && isSubmittable(m));
  return {
    pax: picked.length,
    orders: new Set(picked.map((m) => m.orderId)).size,
    overwrites: picked.filter((m) => m.conflict).length,
  };
}

/** 文件 → base64（去掉 data URL 前缀）。上传 .xlsx 用；只在内存里过一道，不落盘。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败，请重新选择'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
