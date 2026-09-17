/**
 * 订单号发号器：FTM + 北京业务日（YYYYMMDD）+ 5 位后缀。
 *
 * 历史上后五位是随机数（10000–99999，一天只有 9 万个号）。按生日悖论，一天 200 单就有约两成概率
 * 撞出一对同号；撞上时 Order.orderNumber 的唯一约束抛 P2002，建单 / 占位转正直接失败，
 * 用户只看到「记录已存在」。改成按业务日计数：OrderNumberCounter 一天一行，
 * 用一条 INSERT … ON CONFLICT DO UPDATE … RETURNING 原子自增，并发各拿各的号，从根上没有撞号。
 *
 * 后五位不是裸序号：当日序号先过一层固定置换（0..99999 上的双射）再落成 5 位数字，
 * 看起来仍像随机数——连号会直接暴露当天单量（同事一眼、代理按自己的单号也能推），
 * 而置换不改唯一性：同一天序号不同 → 后缀必不同。
 *
 * 切换当天存量单号还是旧随机数，置换结果有极小概率撞上它们，所以发出前查一次 Order 是否已占，
 * 占了就取下一个序号（只会在切换当天或人工导入过同日单号时发生）。
 *
 * 调用方已经在事务里时请把 tx 传进来（事务回滚不烧号，也不会在事务里再借一条连接）；
 * 事务外用默认的全局 prisma（自动提交，计数器行锁只握到语句结束）。
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { businessDateISO } from '../../lib/business-time.js';

export const ORDER_NUMBER_PREFIX = 'FTM';
/** 后缀位数：一天最多 99999 单。 */
export const ORDER_NUMBER_SEQ_WIDTH = 5;
const SUFFIX_SPACE = 10 ** ORDER_NUMBER_SEQ_WIDTH; // 100000
const MAX_SEQ = SUFFIX_SPACE - 1;
/** 候选号已被存量单占用时最多顺延几个序号（只在切换当天可能碰到，正常一次就过）。 */
const MAX_TAKEN_SKIPS = 8;

type OrderNumberDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

// ── 序号 → 后缀的固定置换 ────────────────────────────────────────────────────
// 17 位 Feistel（2^17 = 131072 ≥ 100000）+ cycle-walking：落在 ≥ 100000 的结果再过一遍，
// 直到落回 0..99999。Feistel 每轮可逆 → 整体是双射；cycle-walking 不破坏双射。
// 常量不是密钥、只求看起来乱：改了常量就换一套排列，但唯一性只靠序号不重复，与常量无关。
const FEISTEL_RIGHT_BITS = 9;
const FEISTEL_LEFT_BITS = 8;
const FEISTEL_SPACE = 1 << (FEISTEL_LEFT_BITS + FEISTEL_RIGHT_BITS);
const FEISTEL_ROUND_KEYS = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f] as const;

function mix(value: number, key: number): number {
  let h = Math.imul(value ^ key, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** 0..131071 上的双射（4 轮不平衡 Feistel，偶数轮数 → 出入口两半位宽一致）。 */
function feistel17(x: number): number {
  let leftBits = FEISTEL_LEFT_BITS;
  let rightBits = FEISTEL_RIGHT_BITS;
  let left = x >>> rightBits;
  let right = x & ((1 << rightBits) - 1);
  for (const key of FEISTEL_ROUND_KEYS) {
    const next = (left ^ mix(right, key)) & ((1 << leftBits) - 1);
    left = right;
    right = next;
    [leftBits, rightBits] = [rightBits, leftBits];
  }
  return ((left << rightBits) | right) >>> 0;
}

/** 当日序号（0..99999）→ 后缀数值（0..99999），双射。 */
export function permuteSeq(seq: number): number {
  if (!Number.isInteger(seq) || seq < 0 || seq >= SUFFIX_SPACE) {
    throw new RangeError(`permuteSeq: 序号越界 ${seq}`);
  }
  let y = feistel17(seq);
  while (y >= SUFFIX_SPACE) y = feistel17(y);
  if (y >= FEISTEL_SPACE) throw new Error('permuteSeq: Feistel 结果越界'); // 不可能，保险
  return y;
}

// ── 发号 ────────────────────────────────────────────────────────────────────
async function nextSeq(db: OrderNumberDb, businessDate: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ nextSeq: number }>>`
    INSERT INTO "OrderNumberCounter" ("businessDate", "nextSeq")
    VALUES (${businessDate}::date, 1)
    ON CONFLICT ("businessDate")
    DO UPDATE SET "nextSeq" = "OrderNumberCounter"."nextSeq" + 1
    RETURNING "nextSeq"
  `;
  const seq = rows[0]?.nextSeq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new Error(`订单号发号失败：计数器没有返回序号（业务日 ${businessDate}）`);
  }
  if (seq > MAX_SEQ) {
    throw new Error(`订单号发号失败：业务日 ${businessDate} 的序号已超过 ${MAX_SEQ}`);
  }
  return seq;
}

async function isOrderNumberTaken(db: OrderNumberDb, orderNumber: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM "Order" WHERE "orderNumber" = ${orderNumber} LIMIT 1
  `;
  return rows.length > 0;
}

export async function generateOrderNumber(
  db: OrderNumberDb = prisma,
  now: Date = new Date(),
): Promise<string> {
  // 单号里的日期按北京业务日（不是 UTC）：凌晨 0-8 点下的单，UTC 日历还停在前一天。
  const businessDate = businessDateISO(now);
  const datePart = businessDate.replaceAll('-', '');
  for (let attempt = 0; attempt < MAX_TAKEN_SKIPS; attempt++) {
    const seq = await nextSeq(db, businessDate);
    const suffix = String(permuteSeq(seq)).padStart(ORDER_NUMBER_SEQ_WIDTH, '0');
    const candidate = `${ORDER_NUMBER_PREFIX}${datePart}${suffix}`;
    if (!(await isOrderNumberTaken(db, candidate))) return candidate;
  }
  throw new Error(`订单号发号失败：业务日 ${businessDate} 连续 ${MAX_TAKEN_SKIPS} 个候选号都已被占用`);
}
