/**
 * 代理返佣「补提」（一次性脚本）。
 *
 * 背景：佣金只在订单转 PAID 的那一刻由 orders.service.ts 的 createCommissionsForOrder 计提一次
 * 并写死，全系统没有第二个计提入口、也没有重算入口。于是「费率配置晚于订单付款」的单会永久归零：
 * 付款时该代理该产品档还没有 CommissionRule，链路上取到的 rate 全是 0 → 一条 CommissionRecord
 * 都不建；事后把费率配好也不会回头补。实测库当前 CommissionRule / CommissionRecord 都是 0 条，
 * 而已经躺着一批 PAID、9 月及以后起飞的代理单——运营配好费率后，这批单要靠本脚本一次性补上。
 *
 * 口径不漂移（本脚本最关键的一条）：
 *   本脚本**不自己算佣金**。它对每张待补订单原样调用线上那一个 createCommissionsForOrder，
 *   由它去按出发日取费率、按净额（折扣按毛额比例分摊）算基数、沿代理链取差额费率。
 *   dry-run 的做法是把这次调用跑在一个**最后主动回滚的事务**里，再把事务内新建出来的
 *   CommissionRecord 读回来打印——所以预览出来的每一分钱，就是 --apply 会写进库的那一分钱，
 *   也就是当初该单正常付款时系统本该写的那一分钱。脚本里没有任何一行是佣金算法的副本。
 *
 * 选单口径：
 *   1) Order.agentId 非空（非代理单本来就不计佣）。
 *   2) 状态属于「已经过了计提时点」的那一族 —— 见下方 BACKFILLABLE_STATUSES 的逐条论证。
 *      取消族 / 退款族 / 出票失败一律排除（那几个状态会触发佣金冲销，给它们补提等于凭空造钱）。
 *   3) 该单该档还没有 CommissionRecord —— 这一条不由脚本判断，而是**交给 createCommissionsForOrder
 *      自己的 per-productKind 幂等闸**（d969d76 把闸从「整单」收细到「按档」，补提才成立）。
 *      已计提过的档原样跳过，绝不会重复计佣，脚本可安全重跑。
 *   4) 出发日过滤是**可选参数**（--depart-from / --depart-to），不硬编码任何日期；口径复用
 *      filterOrderIdsByDepartDate（订单列表「出发日期」筛选同一函数）。不传 = 不按出发日过滤。
 *
 * 默认 dry-run：只打印逐单明细 + 按代理汇总，不写库（事务回滚，且关掉零计提审计以免污染审计表）。
 * 加 --apply 才真正写库。每张订单一个独立事务（不是按 100 条批量）——刻意与
 * normalize-passenger-names.ts 的分批事务不同：佣金是「一张单一整条代理链」的原子写入，
 * 批量事务里一张坏单会把同批已算好的好单一起回滚；单张失败也不中断整体扫描，失败最后统一打印。
 *
 * 用法（backend/ 目录下）：
 *   npx tsx scripts/backfill-agent-commissions.ts                          # dry-run 全量
 *   npx tsx scripts/backfill-agent-commissions.ts --depart-from=2026-09-01 # 只看 9/1 及以后起飞
 *   npx tsx scripts/backfill-agent-commissions.ts --csv=/tmp/补提明细.csv   # 导出给财务对账
 *   npx tsx scripts/backfill-agent-commissions.ts --limit=1 --apply        # 先真补一张试水
 *   npx tsx scripts/backfill-agent-commissions.ts --apply                  # 真正写库
 *
 * 参数：
 *   --apply              真正写库（不加 = dry-run，只读）
 *   --depart-from=YMD    只处理出发日 >= 该日的单（YYYY-MM-DD，含边界；派生不出出发日的单会被排除）
 *   --depart-to=YMD      只处理出发日 <= 该日的单（同上）
 *   --limit=N            只处理前 N 张候选单（按建单时间升序），用于试水
 *   --csv=路径            导出逐条明细 CSV；**拒绝覆盖已存在的文件**，请指新路径
 *
 * 连接串：走 Prisma 默认的 DATABASE_URL 环境变量（本脚本不硬编码、不额外读取连接串），
 * 与后端服务同一个 src/db/prisma.js 客户端。本地 = backend/.env 的 DATABASE_URL；
 * 实测 / 测试环境 = 各自 .env 里的那一条。
 *
 * 建议流程：dry-run 存证并交财务核对 → --limit=1 --apply 试水核一张 → --apply 全量
 *          → 再 dry-run 复核（应为 0 条待补）。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../src/db/prisma.js';
import {
  createCommissionsForOrder,
  deriveOrderDepartDate,
  filterOrderIdsByDepartDate,
} from '../src/modules/orders/orders.service.js';

const LOG_PREFIX = '[backfill-agent-commissions]';

/**
 * 「已经过了计提时点」的状态族 —— 逐条按 ALLOWED_TRANSITIONS（orders.service.ts 的状态机唯一真源）
 * 反查得出：只有这些状态是**只能从 PAID 或 PAID 的下游进入**的，即该单已经付过款、计提早该发生。
 *   PAID              计提就发生在进入这一刻。
 *   PROCESSING        入口 = PAID / REFUND_REQUESTED(驳回) / CHANGE_REQUESTED(驳回) / CHANGED / FAILED，全在 PAID 下游。
 *   TICKETED          入口 = PAID / PROCESSING / CHANGE_REQUESTED / CHANGED。
 *   COMPLETED         入口 = TICKETED / CHANGED。
 *   CHANGE_REQUESTED  入口 = PAID / PROCESSING / TICKETED（改签申请出票前后都能发起）。
 *   CHANGED           入口 = CHANGE_REQUESTED。
 *
 * 明确排除，且都不是「顺手漏了」：
 *   DRAFT / PENDING_PAYMENT / PAYMENT_TIMEOUT — 还没到计提时点，将来真付款时会正常计提。
 *   CANCELLED / REFUNDED / FAILED             — 释放态，_updateStatusWithinTx 进入这些状态时会
 *       **按比例冲销佣金**。给它们补提 = 在冲销已经跑完之后凭空建一批 ACCRUED 记录，代理白拿钱。
 *   REFUND_REQUESTED                          — 退款在途。虽然它按设计不冲销（驳回要能恢复），
 *       但钱还没定，此刻补提意义不大而风险实在；退款若被驳回会回到 PROCESSING，届时重跑本脚本
 *       即可自然补上（幂等闸保证不会重复）。
 */
const BACKFILLABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 每张订单一个事务；给足超时（链路 + 逐档查费率 + 逐条 create，本身很快，宽松些防止大单卡边界）。 */
const TX_TIMEOUT_MS = 60_000;
const TX_MAX_WAIT_MS = 30_000;
/**
 * --apply 收尾等待：零计提审计（COMMISSION_ACCRUAL_EMPTY）在 createCommissionsForOrder 里是
 * `void writeAudit(...)` 即发即忘的，脚本一 disconnect 就可能把还在飞的审计写请求掐掉。
 * 收尾多等一会儿让它们落库——审计本身是 best-effort（失败只打 console，不影响计提），
 * 所以这里只是尽量，不做强保证。
 */
const AUDIT_FLUSH_WAIT_MS = 3_000;

interface CliOptions {
  apply: boolean;
  departFrom?: string;
  departTo?: string;
  limit?: number;
  csvPath?: string;
}

/** 补提出来的一条 CommissionRecord（回读自事务内，字段即库里将要/已经存下的值）。 */
interface CreatedRow {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  departDate: string | null;
  sellerAgentLabel: string;
  beneficiaryAgentId: string;
  beneficiaryAgentLabel: string;
  chainDepth: number;
  productKind: string;
  baseAmount: number;
  rate: number;
  amount: number;
}

interface RowError {
  orderNumber: string;
  message: string;
}

interface CommissionRecordSnapshot {
  id: string;
  agentId: string;
  productKind: string;
  baseAmount: Prisma.Decimal;
  rate: Prisma.Decimal;
  amount: Prisma.Decimal;
  chainDepth: number;
}

/** dry-run 用的回滚哨兵：带着事务内读回来的新记录一起抛出，外层接住即完成一次「预演」。 */
class DryRunRollback extends Error {
  constructor(readonly created: ReadonlyArray<CommissionRecordSnapshot>) {
    super('DRY_RUN_ROLLBACK');
    this.name = 'DryRunRollback';
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const apply = argv.includes('--apply');
  const readValue = (flag: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : undefined;
  };

  const departFrom = readValue('--depart-from');
  const departTo = readValue('--depart-to');
  for (const [flag, value] of [
    ['--depart-from', departFrom],
    ['--depart-to', departTo],
  ] as const) {
    if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error(`${flag} 需要 YYYY-MM-DD 格式，收到：${value}`);
    }
  }
  if (departFrom && departTo && departFrom > departTo) {
    throw new Error(`--depart-from(${departFrom}) 晚于 --depart-to(${departTo})，区间为空`);
  }

  const rawLimit = readValue('--limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`--limit 需要正整数，收到：${rawLimit}`);
    }
  }

  const csvPath = readValue('--csv');
  if (csvPath !== undefined) {
    if (csvPath.length === 0) throw new Error('--csv 需要一个文件路径');
    // 提前一步就拦掉「目标已存在」：CSV 是最后才写的，等写的时候才报错，--apply 下钱已经落库、
    // 汇总行却因为异常没打出来——操作的人会以为整批失败。宁可开跑前就退出。
    // （写入时仍用 flag:'wx' 兜底，防这中间有人塞了同名文件。）
    if (existsSync(csvPath)) {
      throw new Error(`--csv 目标已存在，拒绝覆盖（这是要给财务对账的存证）：${csvPath}`);
    }
  }

  return { apply, departFrom, departTo, limit, csvPath };
}

/** 代理展示名：优先公司名，回落联系人；两者都空时退回 id，保证明细里永远有个能对上的抓手。 */
function agentLabel(
  a: { id: string; companyName: string | null; contactName: string } | undefined,
  id: string,
): string {
  if (!a) return `未知代理(${id})`;
  return a.companyName?.trim() || a.contactName?.trim() || `代理(${id})`;
}

function money(n: number): string {
  return n.toFixed(2);
}

function ratePct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * 对一张订单跑一次计提。
 * dry-run：事务内跑完 → 读回本次新建的记录 → 抛哨兵回滚（库里什么都不留）。
 * apply  ：同样跑完并读回，正常提交。
 * 两种模式走的是**同一段调用**，唯一差别只有「最后提交还是回滚」+「dry-run 关掉零计提审计」。
 */
async function accrueOnce(
  order: { id: string; orderNumber: string; agentId: string },
  apply: boolean,
): Promise<ReadonlyArray<CommissionRecordSnapshot>> {
  const run = async (tx: Prisma.TransactionClient): Promise<CommissionRecordSnapshot[]> => {
    const before = await tx.commissionRecord.findMany({
      where: { orderId: order.id },
      select: { id: true },
    });
    const beforeIds = new Set(before.map((r) => r.id));

    await createCommissionsForOrder(tx, order.id, order.agentId, order.orderNumber, {
      // dry-run 不落零计提审计：那条审计走全局 prisma、不在本事务里，回滚不掉。
      emitEmptyAccrualAudit: apply,
    });

    const after = await tx.commissionRecord.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        agentId: true,
        productKind: true,
        baseAmount: true,
        rate: true,
        amount: true,
        chainDepth: true,
      },
      orderBy: [{ productKind: 'asc' }, { chainDepth: 'asc' }],
    });
    return after.filter((r) => !beforeIds.has(r.id));
  };

  const txOptions = { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS };

  if (apply) {
    return prisma.$transaction(run, txOptions);
  }

  try {
    await prisma.$transaction(async (tx) => {
      throw new DryRunRollback(await run(tx));
    }, txOptions);
  } catch (error: unknown) {
    if (error instanceof DryRunRollback) return error.created;
    throw error;
  }
  // 理论上到不了这里（上面一定会抛哨兵）；到了就说明事务语义变了，宁可报错也不静默返回空。
  throw new Error('dry-run 事务未按预期回滚');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 模式: ${opts.apply ? 'APPLY（真正写库）' : 'DRY-RUN（仅预览，不写库）'}` +
      ` | 出发日区间: ${opts.departFrom ?? '不限'} ~ ${opts.departTo ?? '不限'}` +
      (opts.limit ? ` | 限量: ${opts.limit}` : ''),
  );
  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 可补提状态: ${BACKFILLABLE_STATUSES.join(' / ')}（取消族/退款族/出票失败已排除）；且必须实收 > 0`,
  );

  // 1. 候选单：代理单 + 已过计提时点。items 只取派生出发日需要的字段。
  const candidates = await prisma.order.findMany({
    // paidAmount > 0 是补提专属的额外闸，线上实时计提**没有**这一条 —— 这处分叉是有意的：
    //   admin 强制改状态能把订单从「待付款」直接推到已出票/已完成而**从未真正收过钱**，
    //   那种单同样落在上面的状态族里。实时计提每次只影响一张、当场有人盯着；补提是批量的，
    //   混进一张没收钱的单就是凭空给代理记一笔应收，事后冲销很难看。
    //   批量的事后动作理应比实时更保守：宁可漏补一张（还能再跑一次），不可错补一张。
    where: {
      agentId: { not: null },
      status: { in: [...BACKFILLABLE_STATUSES] },
      paidAmount: { gt: 0 },
    },
    select: {
      id: true,
      orderNumber: true,
      agentId: true,
      status: true,
      items: {
        select: {
          hotelCheckIn: true,
          flightSchedule: { select: { departureTime: true, departureTz: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // 2. 出发日过滤（可选）。口径复用 filterOrderIdsByDepartDate = 订单列表「出发日期」筛选同一函数：
  //    派生不出出发日的单不命中——这是那个函数的既有语义，与列表筛选一致，不在这里另开口子。
  let selected = candidates;
  if (opts.departFrom || opts.departTo) {
    const keep = new Set(filterOrderIdsByDepartDate(candidates, opts.departFrom, opts.departTo));
    selected = candidates.filter((o) => keep.has(o.id));
  }
  if (opts.limit !== undefined) selected = selected.slice(0, opts.limit);

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 候选订单: ${candidates.length} 张 → 过滤后待处理: ${selected.length} 张`,
  );

  // 3. 代理展示名（卖家 + 链路上的受益人都可能出现，先全量拉一次，避免逐单查）。
  const agents = await prisma.agent.findMany({
    select: { id: true, companyName: true, contactName: true },
  });
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const createdRows: CreatedRow[] = [];
  const errors: RowError[] = [];
  let skippedAlreadyAccrued = 0;
  let emptyAccrual = 0;

  for (const order of selected) {
    const agentId = order.agentId;
    if (!agentId) continue; // where 已经过滤过，这里只是把 TS 的 nullable 收掉
    const departDate = deriveOrderDepartDate(order.items);
    const sellerLabel = agentLabel(agentById.get(agentId), agentId);

    let created: ReadonlyArray<CommissionRecordSnapshot>;
    try {
      created = await accrueOnce(
        { id: order.id, orderNumber: order.orderNumber, agentId },
        opts.apply,
      );
    } catch (error: unknown) {
      // 单张失败不中断整体扫描（apply 模式下该单事务已整体回滚，不会留半条记录）。
      errors.push({ orderNumber: order.orderNumber, message: getErrorMessage(error) });
      continue;
    }

    if (created.length === 0) {
      // 分两种情形，对财务的含义完全不同，必须分开报。
      const existing = await prisma.commissionRecord.count({ where: { orderId: order.id } });
      if (existing > 0) {
        skippedAlreadyAccrued += 1;
        // eslint-disable-next-line no-console
        console.log(
          `${LOG_PREFIX} [跳过] ${order.orderNumber} | ${sellerLabel} | 各档均已有佣金记录，不重复计提`,
        );
      } else {
        emptyAccrual += 1;
        // eslint-disable-next-line no-console
        console.log(
          `${LOG_PREFIX} [无佣金] ${order.orderNumber} | ${sellerLabel} | 出发日 ${departDate ?? '—'}` +
            ' | 走完链路一条记录都没产生（多半是该档费率仍未配置；也可能折扣吃光净额或全单无可计提行）',
        );
      }
      continue;
    }

    for (const r of created) {
      const row: CreatedRow = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        departDate,
        sellerAgentLabel: sellerLabel,
        beneficiaryAgentId: r.agentId,
        beneficiaryAgentLabel: agentLabel(agentById.get(r.agentId), r.agentId),
        chainDepth: r.chainDepth,
        productKind: r.productKind,
        baseAmount: Number(r.baseAmount),
        rate: Number(r.rate),
        amount: Number(r.amount),
      };
      createdRows.push(row);
      // eslint-disable-next-line no-console
      console.log(
        `${LOG_PREFIX} [补提] ${row.orderNumber} | 状态 ${row.orderStatus} | 出发日 ${row.departDate ?? '—'}` +
          ` | 卖家 ${row.sellerAgentLabel} | 受益 ${row.beneficiaryAgentLabel}(层级${row.chainDepth})` +
          ` | 档 ${row.productKind} | 计佣基数 ${money(row.baseAmount)} | 费率 ${ratePct(row.rate)}` +
          ` | 佣金 ${money(row.amount)}`,
      );
    }
  }

  // 4. 按代理汇总（财务对账的主表）。
  const byAgent = new Map<string, { label: string; count: number; total: number }>();
  for (const row of createdRows) {
    const cur = byAgent.get(row.beneficiaryAgentId) ?? {
      label: row.beneficiaryAgentLabel,
      count: 0,
      total: 0,
    };
    cur.count += 1;
    cur.total = Math.round((cur.total + row.amount) * 100) / 100;
    byAgent.set(row.beneficiaryAgentId, cur);
  }

  // eslint-disable-next-line no-console
  console.log(`${LOG_PREFIX} ── 按代理汇总 ──`);
  const sortedAgents = [...byAgent.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [id, v] of sortedAgents) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX}   ${v.label}(${id}) | ${v.count} 条 | 佣金合计 ${money(v.total)}`);
  }
  if (sortedAgents.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX}   （无）`);
  }

  const grandTotal = Math.round(createdRows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const touchedOrders = new Set(createdRows.map((r) => r.orderId)).size;

  // 5. CSV（可选）。拒绝覆盖已存在文件：这是财务要拿去对账的存证，误覆盖一版就再也找不回来。
  if (opts.csvPath) {
    const header = [
      '订单号',
      '订单状态',
      '出发日',
      '卖家代理',
      '受益代理',
      '受益代理ID',
      '链路层级',
      '产品档',
      '计佣基数CNY',
      '费率',
      '佣金金额CNY',
    ];
    const lines = [
      header.map(csvCell).join(','),
      ...createdRows.map((r) =>
        [
          r.orderNumber,
          r.orderStatus,
          r.departDate ?? '',
          r.sellerAgentLabel,
          r.beneficiaryAgentLabel,
          r.beneficiaryAgentId,
          r.chainDepth,
          r.productKind,
          money(r.baseAmount),
          ratePct(r.rate),
          money(r.amount),
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    // 前置 BOM：Excel 不认无 BOM 的 UTF-8，中文列名会变乱码。flag 'wx' = 目标已存在就报错不覆盖。
    writeFileSync(opts.csvPath, `﻿${lines.join('\r\n')}\r\n`, { encoding: 'utf8', flag: 'wx' });
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} CSV 已导出: ${opts.csvPath}（${createdRows.length} 行明细）`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `${LOG_PREFIX} 汇总 — 待处理 ${selected.length} 张` +
      ` | 补提订单 ${touchedOrders} 张 / 记录 ${createdRows.length} 条 / 佣金合计 ${money(grandTotal)}` +
      ` | 已有记录跳过 ${skippedAlreadyAccrued} 张 | 零计提 ${emptyAccrual} 张 | 失败 ${errors.length} 张` +
      (opts.apply ? '（已写库）' : '（dry-run，未写库；加 --apply 真正执行）'),
  );

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} ${errors.length} 张订单处理失败（各自事务已回滚，未留半条记录）:`);
    for (const e of errors) {
      // eslint-disable-next-line no-console
      console.error(`  ${e.orderNumber}: ${e.message}`);
    }
    process.exitCode = 1;
  }

  if (opts.apply && emptyAccrual > 0) {
    // 让即发即忘的零计提审计有机会落库（见 AUDIT_FLUSH_WAIT_MS 说明）。
    await sleep(AUDIT_FLUSH_WAIT_MS);
  }
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} 致命错误:`, err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
