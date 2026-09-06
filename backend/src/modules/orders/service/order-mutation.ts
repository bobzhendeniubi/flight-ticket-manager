/**
 * OrderMutation 内核（审查根因 R5）：订单写路径的统一入口，把四件**各自早已存在**的事收成一处——
 *
 *   1. 行锁：事务开头 `SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`（与改期 / 超时 worker / 认款
 *      同一把锁；不存在 → NotFoundError('订单不存在')），照抄拆单 / no-show / 取消航段原来的写法；
 *   2. 幂等：带 requestToken 的动作先查已有记录，命中原样返回、绝不重放——事务外先查一次（快路径），
 *      拿到行锁后再查一次（并发双击时后到者在锁内命中）；
 *   3. 审计进事务：ctx.audit() = writeAuditWithinTx，与业务写入同生共死。通知类推送走 ctx.afterCommit()，
 *      事务提交后才跑（fire-and-forget 由调用方自己 `void`），绝不在事务内发 HTTP；
 *   4. 守恒：事务提交前对点名的订单做前后快照比对（钱 / 座 / 房 / 成本哪些维度不许动）+ 账本恒等式
 *      （subtotal = Σ items、total = subtotal、应收不为负、Σ 每人份额 = 应收、挂人调价行有人），
 *      不平抛错 → 整事务回滚，无半状态。口径全部来自 order-ledger.ts（复用拆单守恒断言的函数）。
 *   5. 按人份额落库（persistShares: true，审查根因 R1）：守恒通过后，对本次点名 / track 的每张单调
 *      service/passenger-shares.persistPassengerShares —— 每位在单乘客一行 upsert（算法不在内核里，
 *      仍是 lib/order-money 的 perPax*），Σ 份额对不上应收同样抛错回滚。改钱 / 改人的动作都该开它。
 *
 * 内核**不改任何业务口径、错误文案、审计 action 名**：它只提供位置与顺序，动作本身仍写在各自模块里。
 * 内核也**不替动作自动写审计**——路由层与各动作已有各自的审计约定，重复写会让财务对账多出一条。
 *
 * 用法：
 *   const audit = await runOrderMutation(
 *     { orderId, actor, action: 'CANCEL_RETURN_LEG', requestToken, idempotency: { fastPath: false, find },
 *       conserve: { unchanged: ['paid', 'rooms'] } },
 *     async (ctx) => { …ctx.tx 里写库…; await ctx.audit({...}); ctx.afterCommit(() => void notify()); return audit; },
 *   );
 *
 * 嵌套禁忌：body 里**不能**再调用会自己开 prisma.$transaction 的方法（Prisma 交互式事务不可嵌套，
 * 内层拿全局 client 会另开连接、撞上外层刚拿的行锁而死锁）。按人改期这种「拆单 + 改期」两段式编排
 * 用 runOrderOrchestration（无事务、无锁，只统一幂等快路径与提交后钩子）。
 */
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { NotFoundError } from '../../../lib/errors.js';
import { writeAuditWithinTx, type AuditActor, type AuditEntry } from '../../../lib/audit.js';
import {
  assertLedgerUnchanged,
  assertNoNewLedgerViolations,
  snapshotOrderLedger,
  type LedgerDimension,
  type OrderLedgerSnapshot,
} from './order-ledger.js';
import { persistPassengerShares } from './passenger-shares.js';

export interface MutationActor {
  userId: string;
  role: UserRole;
  /** 代理自助路径会带；审计 actor 只取 userId / role，与各动作原来写审计的口径一致。 */
  agentId?: string;
}

/** 幂等查询可在事务外（快路径，裸 prisma）或事务内（锁后复查，tx）跑，两处形状一致。 */
export type MutationDb = Prisma.TransactionClient | PrismaClient;

export interface MutationIdempotency<R> {
  /**
   * 查「同 (订单, requestToken) 已有记录」：命中返回可直接回给调用方的结果（通常带 replayed: true），
   * 未命中返回 null。可以抛错（入参指纹对不上 → 409 一类），内核原样上抛。
   */
  find: (db: MutationDb) => Promise<R | null>;
  /**
   * false = 只在拿到行锁后查（no-show / 取消航段 / 恢复 / 作废：留痕在航段行 metadata 上，
   * 必须读锁后的行才作数）。默认 true：事务外先查一次，命中不进事务（拆单原有的快路径）。
   */
  fastPath?: boolean;
}

export interface MutationConservation {
  /** 除主单 orderId 外还要一起看的订单（body 里也可用 ctx.track() 追加，拆单的新单就是这样进来的）。 */
  orderIds?: readonly string[];
  /** 前后快照必须 Σ 恒等的维度；没点名的维度不比（动作本来就要改它）。 */
  unchanged: readonly LedgerDimension[];
  /** 错误文案前缀（默认取 action）。 */
  label?: string;
}

export interface OrderMutationSpec<R> {
  orderId: string;
  actor: MutationActor;
  /** 现有审计 action 名（不改名）；这里只作留痕上下文与守恒文案。 */
  action: string;
  requestToken?: string;
  idempotency?: MutationIdempotency<R>;
  /** 默认 true。false 仅供只读预检类调用（当前七条写路径全部 true）。 */
  lockOrder?: boolean;
  conserve?: MutationConservation;
  /**
   * true = body 跑完、守恒通过后，对主单 + conserve.orderIds + ctx.track() 追加的每张单落一遍按人份额
   *（service/passenger-shares.persistPassengerShares）。会改钱（应收 / 售后费 / 行金额）或改人
   *（拆单搬人 / 换人 / 自备签翻转）的动作都要开；纯状态类动作可不开。
   */
  persistShares?: boolean;
}

export interface OrderMutationCtx {
  tx: Prisma.TransactionClient;
  actor: MutationActor;
  action: string;
  requestToken: string | null;
  /** 事务内审计：与业务写入同一事务；失败上抛 → 整事务回滚。actor 缺省取本次动作的 userId / role。 */
  audit: (entry: Omit<AuditEntry, 'actor'> & { actor?: AuditActor }) => Promise<void>;
  /** 提交后钩子，按注册顺序 await；fire-and-forget 的推送请在钩子里自己 `void`。 */
  afterCommit: (hook: () => void | Promise<void>) => void;
  /** 把 body 里才知道的订单（如拆单的新单）加进守恒快照。 */
  track: (orderId: string) => void;
}

/** 与拆单 / no-show / 取消航段 / 恢复 / 作废 / 换人 / 改期原来的写法一字不差的行锁。 */
export async function lockOrderRowWithinTx(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundError('订单不存在');
}

type TxOutcome<R> = { kind: 'replayed'; result: R } | { kind: 'done'; result: R; hooks: Array<() => void | Promise<void>> };

export async function runOrderMutation<R>(
  spec: OrderMutationSpec<R>,
  body: (ctx: OrderMutationCtx) => Promise<R>,
): Promise<R> {
  const requestToken = spec.requestToken ?? null;
  const idem = spec.idempotency;

  // ── 幂等快路径（事务外）：同 token 已做过 → 原样回放，不进事务、不拿锁 ──
  if (idem && requestToken !== null && idem.fastPath !== false) {
    const hit = await idem.find(prisma);
    if (hit !== null) return hit;
  }

  const outcome = await prisma.$transaction(async (tx): Promise<TxOutcome<R>> => {
    if (spec.lockOrder !== false) await lockOrderRowWithinTx(tx, spec.orderId);

    // ── 锁内幂等复查：并发同 token 双击，后到者拿到锁时前者已提交 → 命中回放 ──
    if (idem && requestToken !== null) {
      const hit = await idem.find(tx);
      if (hit !== null) return { kind: 'replayed', result: hit };
    }

    const tracked = new Set<string>([spec.orderId, ...(spec.conserve?.orderIds ?? [])]);
    const before: OrderLedgerSnapshot | null = spec.conserve
      ? await snapshotOrderLedger(tx, [...tracked])
      : null;

    const hooks: Array<() => void | Promise<void>> = [];
    const ctx: OrderMutationCtx = {
      tx,
      actor: spec.actor,
      action: spec.action,
      requestToken,
      audit: (entry) =>
        writeAuditWithinTx(tx, {
          ...entry,
          actor: entry.actor ?? { userId: spec.actor.userId, role: spec.actor.role },
        }),
      afterCommit: (hook) => {
        hooks.push(hook);
      },
      track: (orderId) => {
        tracked.add(orderId);
      },
    };

    const result = await body(ctx);

    if (spec.conserve && before) {
      const label = spec.conserve.label ?? spec.action;
      const after = await snapshotOrderLedger(tx, [...tracked]);
      assertLedgerUnchanged(before, after, spec.conserve.unchanged, label);
      assertNoNewLedgerViolations(before, after, label);
    }
    // ── 按人份额落库（R1）：守恒通过之后、提交之前；订单不存在（拆单前的新单 id 之类）自动跳过 ──
    if (spec.persistShares) {
      for (const id of tracked) await persistPassengerShares(tx, id);
    }
    return { kind: 'done', result, hooks };
  });

  if (outcome.kind === 'replayed') return outcome.result;
  // ── 事务已提交：这里才跑通知类钩子（推企微 / 办结派生对齐 …），绝不在事务内发 HTTP ──
  for (const hook of outcome.hooks) await hook();
  return outcome.result;
}

// ── 编排（无事务、无锁）────────────────────────────────────────────────────

export interface OrderOrchestrationSpec<R> {
  orderId: string;
  actor: MutationActor;
  action: string;
  requestToken?: string;
  /** 只有快路径（裸 prisma）：编排本身没有事务，锁内复查由各内层动作自己做。 */
  idempotency?: Pick<MutationIdempotency<R>, 'find'>;
}

export interface OrderOrchestrationCtx {
  actor: MutationActor;
  action: string;
  requestToken: string | null;
  /** 全部内层动作各自提交之后才跑（汇总审计 / 通知）。 */
  afterCommit: (hook: () => void | Promise<void>) => void;
}

/**
 * 多段式编排（每一段各自是一个 runOrderMutation 或既有事务）。内核在这里只统一两件事：
 * 幂等快路径与「全部段落提交后」的钩子顺序；行锁与守恒由各段各自负责。
 */
export async function runOrderOrchestration<R>(
  spec: OrderOrchestrationSpec<R>,
  body: (ctx: OrderOrchestrationCtx) => Promise<R>,
): Promise<R> {
  const requestToken = spec.requestToken ?? null;
  if (spec.idempotency && requestToken !== null) {
    const hit = await spec.idempotency.find(prisma);
    if (hit !== null) return hit;
  }
  const hooks: Array<() => void | Promise<void>> = [];
  const result = await body({
    actor: spec.actor,
    action: spec.action,
    requestToken,
    afterCommit: (hook) => {
      hooks.push(hook);
    },
  });
  for (const hook of hooks) await hook();
  return result;
}
