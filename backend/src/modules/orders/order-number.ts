/**
 * 订单号发号器：FTM + 北京业务日（YYYYMMDD）+ 5 位当日序号（00001 起）。
 *
 * 历史上后五位是随机数（10000–99999，一天只有 9 万个号）。按生日悖论，一天 200 单就有约两成概率
 * 撞出一对同号；撞上时 Order.orderNumber 的唯一约束抛 P2002，建单 / 占位转正直接失败，
 * 用户只看到「记录已存在」。改成按业务日计数：OrderNumberCounter 一天一行，
 * 用一条 INSERT … ON CONFLICT DO UPDATE … RETURNING 原子自增，并发各拿各的号，从根上没有撞号。
 *
 * 调用方已经在事务里时请把 tx 传进来（事务回滚不烧号，也不会在事务里再借一条连接）；
 * 事务外用默认的全局 prisma（自动提交，计数器行锁只握到语句结束）。
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { businessDateISO } from '../../lib/business-time.js';

export const ORDER_NUMBER_PREFIX = 'FTM';
/** 序号位数：一天最多 99999 单。 */
export const ORDER_NUMBER_SEQ_WIDTH = 5;
const MAX_SEQ = 10 ** ORDER_NUMBER_SEQ_WIDTH - 1;

type OrderNumberDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

export async function generateOrderNumber(
  db: OrderNumberDb = prisma,
  now: Date = new Date(),
): Promise<string> {
  // 单号里的日期按北京业务日（不是 UTC）：凌晨 0-8 点下的单，UTC 日历还停在前一天。
  const businessDate = businessDateISO(now);
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
  return `${ORDER_NUMBER_PREFIX}${businessDate.replaceAll('-', '')}${String(seq).padStart(ORDER_NUMBER_SEQ_WIDTH, '0')}`;
}
