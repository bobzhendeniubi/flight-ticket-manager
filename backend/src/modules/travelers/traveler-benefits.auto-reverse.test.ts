/**
 * 权益核销自动冲正单测（假 tx 驱动，不 mock 模块）。
 *
 * 覆盖：
 *   - 挂了本单的正数核销 → 追加负数补偿行（照抄 benefit / orderId，操作人「系统自动」，note 带原因与单号）
 *   - 候选只认「正数且未被冲正」：where 里带 tripsUsed > 0 与 reversedBy: null（重复取消不会二次冲正）
 *   - 补偿行走 createMany(skipDuplicates)，被人工抢先冲正的行不进结果、不写审计
 *   - 审计 BENEFIT_REDEMPTION_AUTO_REVERSED（WARNING，target=档案）+ 一条给运营的待办（ruleKey 幂等）
 *   - 系统调用者（reminderCreatedById=null）只冲正 + 审计，不建待办
 *   - 拆单一跳：源单上的核销只在「该档案证件出现在本单乘客里」时连带冲正
 *   - 缺 delegate 的老 mock 直接跳过（返回空数组，不抛）
 */
import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  autoReverseRedemptionsForOrderWithinTx,
  BENEFIT_AUTO_REVERSAL_ACTOR_ID,
  BENEFIT_AUTO_REVERSAL_ACTOR_NAME,
  BENEFIT_AUTO_REVERSED_AUDIT_ACTION,
  BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX,
} from './traveler-benefits.auto-reverse.js';

const AT = new Date('2026-09-21T03:00:00.000Z');

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

/** 假 tx：candidates 是首次 findMany 的返回；written 是 createMany 之后按 reversalOfId 读回的行。 */
function fakeTx(opts: {
  candidates?: ReturnType<typeof candidate>[];
  written?: Array<{ id: string; reversalOfId: string }>;
  splitSources?: string[];
  passengers?: Array<{ documentType: string; documentNumber: string }>;
  profiles?: Array<{ id: string; mergedIntoId: string | null; documentType: string; documentNumber: string }>;
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
      findMany: vi.fn().mockResolvedValue((opts.splitSources ?? []).map((id) => ({ sourceOrderId: id }))),
    },
    passenger: { findMany: vi.fn().mockResolvedValue(opts.passengers ?? []) },
    travelerProfile: { findMany: vi.fn().mockResolvedValue(opts.profiles ?? []) },
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

describe('autoReverseRedemptionsForOrderWithinTx · 取消 / 退款 / no-show 自动冲正', () => {
  it('挂了本单的正数核销 → 追加负数补偿行：照抄 benefit / orderId，操作人「系统自动」，note 带原因与单号', async () => {
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
      candidates: [candidate({ id: 'r1' }), candidate({ id: 'r2', profileId: 'p2' })],
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

  it('拆单一跳：源单上的核销，只有「该档案证件出现在本单乘客里」的才连带冲正', async () => {
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
    const created = (tx.travelerBenefitRedemption.createMany.mock.calls[0][0] as { data: Array<{ reversalOfId: string; orderId: string }> }).data;
    expect(created).toEqual([expect.objectContaining({ reversalOfId: 'r-moved', orderId: 'o-src' })]);
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

  it('老 mock 缺 delegate → 整段跳过，返回空数组不抛', async () => {
    const tx = { fulfillmentTask: { updateMany: vi.fn() } } as unknown as Prisma.TransactionClient;

    await expect(autoReverseRedemptionsForOrderWithinTx(tx, INPUT)).resolves.toEqual([]);
  });
});
