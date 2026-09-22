/**
 * 权益核销自动冲正单测（假 tx 驱动，不 mock 模块）。
 *
 * 覆盖：
 *   - 挂了本单的正数核销 → 追加负数补偿行（照抄 benefit / orderId，记触发单，操作人「系统自动」，note 带原因与单号）
 *   - 候选只认「正数且未被冲正」：where 里带 tripsUsed > 0 与 reversedBy: null（重复取消不会二次冲正）
 *   - 补偿行走 createMany(skipDuplicates)，被人工抢先冲正的行不进结果、不写审计
 *   - 审计 BENEFIT_REDEMPTION_AUTO_REVERSED（WARNING，target=档案）+ 一条给运营的待办（ruleKey 幂等）
 *   - 系统调用者（reminderCreatedById=null）只冲正 + 审计，不建待办
 *   - 拆单一跳：源单上的核销只在「该档案证件出现在本单乘客里」时连带冲正
 *   - 仍有有效行程（评审 F1）：档案还在别的已付款未飞单 / 拆单谱系已飞单上 → 不冲正，只写 INFO 审计；
 *     待支付单、打了 no-show 标的单、谱系外的历史已飞单都不算「仍有行程」；触发单本身不参与判定
 *   - 合并链任意深度（评审 F2）：P1→P2→P3，单上乘客仍用 P1 旧证，核销挂在 P3 → 命中；链成环不死循环
 *   - 缺 delegate 的老 mock 直接跳过（返回空数组，不抛）
 */
import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  autoReverseRedemptionsForOrderWithinTx,
  BENEFIT_AUTO_REVERSAL_ACTOR_ID,
  BENEFIT_AUTO_REVERSAL_ACTOR_NAME,
  BENEFIT_AUTO_REVERSED_AUDIT_ACTION,
  BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION,
  BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX,
} from './traveler-benefits.auto-reverse.js';

const AT = new Date('2026-09-21T03:00:00.000Z');
const DAY_MS = 24 * 3600_000;

function candidate(over: Partial<{
  id: string;
  profileId: string;
  tripsUsed: number;
  benefit: string;
  orderId: string | null;
  fullName: string;
  documentNumber: string;
}> = {}) {
  return {
    id: over.id ?? 'r1',
    profileId: over.profileId ?? 'p1',
    tripsUsed: over.tripsUsed ?? 5,
    benefit: over.benefit ?? '飞满 5 次兑换升舱',
    orderId: over.orderId === undefined ? 'o1' : over.orderId,
    profile: {
      id: over.profileId ?? 'p1',
      fullName: over.fullName ?? 'ZHANG SAN',
      documentType: 'PASSPORT',
      documentNumber: over.documentNumber ?? 'E12345678',
    },
  };
}

type FakeOrder = {
  id: string;
  status: string;
  passengers: Array<{ documentType: string; documentNumber: string }>;
  items: Array<{ metadata: unknown; flightSchedule: { departureTime: Date } | null }>;
};

/** 一张只带一段去程的单：departsInDays > 0 未飞，< 0 已飞；noShow 给去程打标。 */
function order(over: {
  id: string;
  status?: string;
  documentNumber?: string;
  departsInDays?: number;
  noShow?: boolean;
}): FakeOrder {
  return {
    id: over.id,
    status: over.status ?? 'PAID',
    passengers: [{ documentType: 'PASSPORT', documentNumber: over.documentNumber ?? 'E12345678' }],
    items: [
      {
        metadata: over.noShow ? { noShow: { at: AT.toISOString() } } : null,
        flightSchedule: { departureTime: new Date(AT.getTime() + (over.departsInDays ?? 10) * DAY_MS) },
      },
    ],
  };
}

/**
 * 假 tx：candidates 是首次 findMany 的返回；written 是 createMany 之后按 reversalOfId 读回的行；
 * splitSources = 本单的源单；splitTargets = 拆单记录（候选挂的单 → 目标单）；orders = 「仍有有效行程」
 * 判定读到的别的订单。
 */
function fakeTx(opts: {
  candidates?: ReturnType<typeof candidate>[];
  written?: Array<{ id: string; reversalOfId: string }>;
  splitSources?: string[];
  splitTargets?: Array<{ sourceOrderId: string; targetOrderId: string }>;
  passengers?: Array<{ documentType: string; documentNumber: string }>;
  profiles?: Array<{ id: string; mergedIntoId: string | null; documentType: string; documentNumber: string }>;
  orders?: FakeOrder[];
  existingReminder?: boolean;
}) {
  const candidates = opts.candidates ?? [];
  const written =
    opts.written ?? candidates.map((c) => ({ id: `rev-${c.id}`, reversalOfId: c.id }));
  const tx = {
    travelerBenefitRedemption: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce(written),
      createMany: vi.fn().mockResolvedValue({ count: written.length }),
    },
    orderSplitRecord: {
      findMany: vi.fn(async (args: { where: { targetOrderId?: string; sourceOrderId?: { in: string[] } } }) => {
        if (args.where.targetOrderId) {
          return (opts.splitSources ?? []).map((id) => ({ sourceOrderId: id }));
        }
        const ids = new Set(args.where.sourceOrderId?.in ?? []);
        return (opts.splitTargets ?? [])
          .filter((r) => ids.has(r.sourceOrderId))
          .map((r) => ({ targetOrderId: r.targetOrderId }));
      }),
    },
    passenger: { findMany: vi.fn().mockResolvedValue(opts.passengers ?? []) },
    travelerProfile: { findMany: vi.fn().mockResolvedValue(opts.profiles ?? []) },
    order: { findMany: vi.fn().mockResolvedValue(opts.orders ?? []) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a1' }) },
    operationalReminder: {
      findUnique: vi.fn().mockResolvedValue(opts.existingReminder ? { id: 'rem-existing' } : null),
      create: vi.fn().mockResolvedValue({ id: 'rem-1' }),
    },
  };
  return tx as unknown as Prisma.TransactionClient & typeof tx;
}

const INPUT = {
  orderId: 'o1',
  orderNumber: 'FTM2026092100001',
  reason: '订单已取消',
  reminderCreatedById: 'u-ops',
  at: AT,
};

function auditActions(tx: ReturnType<typeof fakeTx>): string[] {
  return tx.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
}

describe('autoReverseRedemptionsForOrderWithinTx · 取消 / 退款 / no-show 自动冲正', () => {
  it('挂了本单的正数核销 → 追加负数补偿行：照抄 benefit / orderId，记触发单，操作人「系统自动」，note 带原因与单号', async () => {
    const tx = fakeTx({ candidates: [candidate({ id: 'r1', tripsUsed: 5 })] });

    const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(out).toEqual([
      {
        profileId: 'p1',
        profileName: 'ZHANG SAN',
        originalId: 'r1',
        reversalId: 'rev-r1',
        tripsUsed: 5,
        benefit: '飞满 5 次兑换升舱',
        orderId: 'o1',
      },
    ]);
    expect(tx.travelerBenefitRedemption.createMany).toHaveBeenCalledWith({
      data: [
        {
          profileId: 'p1',
          tripsUsed: -5,
          benefit: '飞满 5 次兑换升舱',
          note: '订单已取消（订单 FTM2026092100001），系统自动冲正',
          reversalOfId: 'r1',
          orderId: 'o1',
          triggeredByOrderId: 'o1',
          createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
          createdByName: BENEFIT_AUTO_REVERSAL_ACTOR_NAME,
          createdAt: AT,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('候选只认「挂本单 + 正数 + 未被冲正」：where 带 tripsUsed > 0 与 reversedBy: null（重复取消不会二次冲正）', async () => {
    const tx = fakeTx({ candidates: [] });

    const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(out).toEqual([]);
    expect(tx.travelerBenefitRedemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: { in: ['o1'] }, tripsUsed: { gt: 0 }, reversedBy: null },
      }),
    );
    expect(tx.travelerBenefitRedemption.createMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
  });

  it('被人工抢先冲正的行（createMany 撞唯一约束被跳过）不进结果、不写审计、不建待办', async () => {
    const tx = fakeTx({
      candidates: [candidate({ id: 'r1' }), candidate({ id: 'r2', profileId: 'p2', documentNumber: 'E2' })],
      // 只有 r2 真正落库（r1 被人工冲正抢先，ON CONFLICT DO NOTHING）
      written: [{ id: 'rev-r2', reversalOfId: 'r2' }],
    });

    const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(out.map((r) => r.originalId)).toEqual(['r2']);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.operationalReminder.create).toHaveBeenCalledTimes(1);
  });

  it('审计 BENEFIT_REDEMPTION_AUTO_REVERSED：WARNING、target=档案、before/after 记原行与补偿行', async () => {
    const tx = fakeTx({ candidates: [candidate({ id: 'r1', tripsUsed: 2 })] });

    await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: BENEFIT_AUTO_REVERSED_AUDIT_ACTION,
        targetType: 'TRAVELER',
        targetId: 'p1',
        targetLabel: 'ZHANG SAN',
        severity: 'WARNING',
        actorRole: 'SYSTEM',
        actorLabel: BENEFIT_AUTO_REVERSAL_ACTOR_NAME,
        before: { redemptionId: 'r1', tripsUsed: 2, benefit: '飞满 5 次兑换升舱', orderId: 'o1' },
        after: {
          reversalId: 'rev-r1',
          tripsUsed: -2,
          reason: '订单已取消',
          triggerOrderId: 'o1',
          triggerOrderNumber: 'FTM2026092100001',
        },
      }),
    });
  });

  it('给操作人派一条 HIGH 待办：ruleKey = BENEFITREV:{补偿行 id}，正文说明已补回、恢复后不自动再核销', async () => {
    const tx = fakeTx({ candidates: [candidate({ id: 'r1', tripsUsed: 5 })] });

    await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(tx.operationalReminder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'o1',
        createdById: 'u-ops',
        priority: 'HIGH',
        ruleKey: `${BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX}rev-r1`,
        title: '【核销已自动冲正】FTM2026092100001 ZHANG SAN 补回 5 次',
        dueAt: new Date('2026-09-21T00:00:00Z'),
      }),
      select: { id: true },
    });
    const body = (tx.operationalReminder.create.mock.calls[0][0] as { data: { body: string } }).data.body;
    expect(body).toContain('订单已取消');
    expect(body).toContain('不会自动再核销');
  });

  it('同一补偿行的待办已存在（同事务重跑 / 回放）→ 不重复建', async () => {
    const tx = fakeTx({ candidates: [candidate({ id: 'r1' })], existingReminder: true });

    await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
  });

  it('系统调用者（reminderCreatedById=null）只冲正 + 审计，不建待办（提单人要真实账号）', async () => {
    const tx = fakeTx({ candidates: [candidate({ id: 'r1' })] });

    const out = await autoReverseRedemptionsForOrderWithinTx(tx, { ...INPUT, reminderCreatedById: null });

    expect(out).toHaveLength(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.operationalReminder.findUnique).not.toHaveBeenCalled();
    expect(tx.operationalReminder.create).not.toHaveBeenCalled();
  });

  it('拆单一跳：源单上的核销，只有「该档案证件出现在本单乘客里」的才连带冲正（取消目标单 → 补回）', async () => {
    const tx = fakeTx({
      splitSources: ['o-src'],
      candidates: [
        candidate({ id: 'r-moved', profileId: 'p-moved', orderId: 'o-src', documentNumber: 'E-MOVED' }),
        candidate({ id: 'r-stay', profileId: 'p-stay', orderId: 'o-src', documentNumber: 'E-STAY' }),
      ],
      passengers: [{ documentType: 'PASSPORT', documentNumber: ' e-moved ' }], // 大小写/空格归一
      profiles: [
        { id: 'p-moved', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E-MOVED' },
        { id: 'p-stay', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E-STAY' },
      ],
      // 留在源单上的 p-stay 仍有行程；p-moved 只在被取消的本单上
      orders: [order({ id: 'o-src', documentNumber: 'E-STAY' })],
      written: [{ id: 'rev-moved', reversalOfId: 'r-moved' }],
    });

    const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(tx.travelerBenefitRedemption.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { orderId: { in: ['o1', 'o-src'] }, tripsUsed: { gt: 0 }, reversedBy: null },
      }),
    );
    expect(out.map((r) => r.originalId)).toEqual(['r-moved']);
    const created = (tx.travelerBenefitRedemption.createMany.mock.calls[0][0] as { data: Array<{ reversalOfId: string; orderId: string; triggeredByOrderId: string }> }).data;
    expect(created).toEqual([
      expect.objectContaining({ reversalOfId: 'r-moved', orderId: 'o-src', triggeredByOrderId: 'o1' }),
    ]);
    // p-stay 的核销既不冲正也不算「跳过」（它根本没进候选：证件不在本单上）
    expect(auditActions(tx)).toEqual([BENEFIT_AUTO_REVERSED_AUDIT_ACTION]);
  });

  it('拆单一跳：档案的旧证（一跳指针行）出现在本单乘客里同样命中', async () => {
    const tx = fakeTx({
      splitSources: ['o-src'],
      candidates: [candidate({ id: 'r1', profileId: 'p-master', orderId: 'o-src', documentNumber: 'E-NEW' })],
      passengers: [{ documentType: 'PASSPORT', documentNumber: 'E-OLD' }],
      profiles: [
        { id: 'p-master', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E-NEW' },
        { id: 'p-old', mergedIntoId: 'p-master', documentType: 'PASSPORT', documentNumber: 'E-OLD' },
      ],
    });

    const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

    expect(out.map((r) => r.originalId)).toEqual(['r1']);
  });

  describe('仍有有效行程（评审 F1）：冲正跟着旅客当前承载的行程走', () => {
    it('拆单后取消源单：被拆到 B 且 B 已正常出行的客人，A 上挂的核销**不补回**，只写 INFO 审计', async () => {
      // 触发单 = A（o1），P 的核销挂 A；P 已被拆到 B（谱系一跳），B 一天前飞了
      const tx = fakeTx({
        candidates: [candidate({ id: 'r1', profileId: 'p1', orderId: 'o1' })],
        splitTargets: [{ sourceOrderId: 'o1', targetOrderId: 'oB' }],
        profiles: [{ id: 'p1', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E12345678' }],
        orders: [order({ id: 'oB', departsInDays: -1 })],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out).toEqual([]);
      expect(tx.travelerBenefitRedemption.createMany).not.toHaveBeenCalled();
      expect(tx.operationalReminder.create).not.toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION,
          severity: 'INFO',
          targetType: 'TRAVELER',
          targetId: 'p1',
          before: { redemptionId: 'r1', tripsUsed: 5, benefit: '飞满 5 次兑换升舱', orderId: 'o1' },
          after: expect.objectContaining({
            triggerOrderId: 'o1',
            carriedByOrderIds: ['oB'],
          }),
        }),
      });
      // 谱系查询按候选挂的单找目标单
      expect(tx.orderSplitRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sourceOrderId: { in: ['o1'] } } }),
      );
    });

    it('档案还在另一张已付款未飞单上 → 不冲正（那趟行程会用掉这次核销的额度）', async () => {
      const tx = fakeTx({
        candidates: [candidate({ id: 'r1' })],
        profiles: [{ id: 'p1', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E12345678' }],
        orders: [order({ id: 'o-other', status: 'TICKETED', departsInDays: 20 })],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out).toEqual([]);
      expect(auditActions(tx)).toEqual([BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION]);
    });

    it('另一张单是待支付 → 不算有效行程，照常冲正', async () => {
      const tx = fakeTx({
        candidates: [candidate({ id: 'r1' })],
        profiles: [{ id: 'p1', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E12345678' }],
        orders: [order({ id: 'o-other', status: 'PENDING_PAYMENT', departsInDays: 20 })],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out.map((r) => r.originalId)).toEqual(['r1']);
      expect(auditActions(tx)).toEqual([BENEFIT_AUTO_REVERSED_AUDIT_ACTION]);
    });

    it('谱系外的历史已飞单不算「仍有行程」→ 照常冲正；谱系内的单打了 no-show 标也不算', async () => {
      const tx = fakeTx({
        candidates: [candidate({ id: 'r1' })],
        splitTargets: [{ sourceOrderId: 'o1', targetOrderId: 'oB' }],
        profiles: [{ id: 'p1', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E12345678' }],
        orders: [
          order({ id: 'o-history', departsInDays: -200 }),
          order({ id: 'oB', departsInDays: -1, noShow: true }),
        ],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out.map((r) => r.originalId)).toEqual(['r1']);
    });

    it('触发单本身不参与判定（事务内它正在落终态 / 刚打标）：查询排除本单', async () => {
      const tx = fakeTx({
        candidates: [candidate({ id: 'r1' })],
        profiles: [{ id: 'p1', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E12345678' }],
      });

      await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(tx.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: 'o1' },
            deletedAt: null,
            passengers: {
              some: {
                OR: [{ documentType: 'PASSPORT', documentNumber: { equals: 'E12345678', mode: 'insensitive' } }],
              },
            },
          }),
        }),
      );
    });

    it('有效行程按档案**全部证件**找：另一张单上用的是合并前的旧证 → 同样算仍有行程', async () => {
      const tx = fakeTx({
        candidates: [candidate({ id: 'r1', profileId: 'p-master', documentNumber: 'E-NEW' })],
        profiles: [
          { id: 'p-master', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E-NEW' },
          { id: 'p-old', mergedIntoId: 'p-master', documentType: 'PASSPORT', documentNumber: 'E-OLD' },
        ],
        orders: [order({ id: 'o-other', documentNumber: 'E-OLD', departsInDays: 5 })],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out).toEqual([]);
      expect(auditActions(tx)).toEqual([BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION]);
    });
  });

  describe('合并链任意深度（评审 F2）', () => {
    it('P1→P2→P3：单上乘客仍用 P1 旧证，核销挂在主档案 P3 → 拆单一跳照样命中并冲正', async () => {
      const tx = fakeTx({
        splitSources: ['o-src'],
        candidates: [candidate({ id: 'r1', profileId: 'p3', orderId: 'o-src', documentNumber: 'E-P3' })],
        passengers: [{ documentType: 'PASSPORT', documentNumber: 'E-P1' }],
        profiles: [
          { id: 'p1', mergedIntoId: 'p2', documentType: 'PASSPORT', documentNumber: 'E-P1' },
          { id: 'p2', mergedIntoId: 'p3', documentType: 'PASSPORT', documentNumber: 'E-P2' },
          { id: 'p3', mergedIntoId: null, documentType: 'PASSPORT', documentNumber: 'E-P3' },
        ],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out.map((r) => r.originalId)).toEqual(['r1']);
    });

    it('链成环（脏数据 p1→p2→p1）不死循环：退回候选自带的本证，仍能按本证命中', async () => {
      const tx = fakeTx({
        splitSources: ['o-src'],
        candidates: [candidate({ id: 'r1', profileId: 'p1', orderId: 'o-src', documentNumber: 'E-P1' })],
        passengers: [{ documentType: 'PASSPORT', documentNumber: 'E-P1' }],
        profiles: [
          { id: 'p1', mergedIntoId: 'p2', documentType: 'PASSPORT', documentNumber: 'E-P1' },
          { id: 'p2', mergedIntoId: 'p1', documentType: 'PASSPORT', documentNumber: 'E-P2' },
        ],
      });

      const out = await autoReverseRedemptionsForOrderWithinTx(tx, INPUT);

      expect(out.map((r) => r.originalId)).toEqual(['r1']);
    });
  });

  it('老 mock 缺 delegate → 整段跳过，返回空数组不抛', async () => {
    const tx = { fulfillmentTask: { updateMany: vi.fn() } } as unknown as Prisma.TransactionClient;

    await expect(autoReverseRedemptionsForOrderWithinTx(tx, INPUT)).resolves.toEqual([]);
  });
});
