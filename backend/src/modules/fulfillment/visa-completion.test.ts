/**
 * 订单级签证办结派生（syncOrderVisaCompletion）· 单测（mock Prisma）
 *
 * 口径（签证岗 2026-08-30）：非自备签乘客全部「已送签」且确有我方签证任务 → 订单自动置
 * 已签证（HAS_VISA）；任一乘客退回 → 仅当已签证是本派生写的（审计可查）才对称回退原档。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    passenger: { findMany: vi.fn() },
    fulfillmentTask: { count: vi.fn() },
    auditLog: { create: vi.fn(), findFirst: vi.fn() },
  },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  syncOrderVisaCompletion,
  VISA_AUTO_COMPLETE_ACTION,
  VISA_AUTO_COMPLETE_REVERT_ACTION,
} from './visa-completion.js';

const actor = { userId: 'u1', role: 'STAFF' as const };

function mount(opts: {
  order?: { visaStatus: string | null; deletedAt?: Date | null } | null;
  // 全名单（不带 visaExempt 视为随团办签）：办结判定只看非自备签那部分。
  passengers?: Array<{ visaSubmissionStatus: string; visaExempt?: boolean }>;
  taskCount?: number;
  lastAudit?: { action: string; before: unknown } | null;
}) {
  mockPrisma.order.findUnique.mockResolvedValue(
    opts.order === null
      ? null
      : {
          id: 'o1',
          orderNumber: 'ORD-1',
          visaStatus: opts.order?.visaStatus ?? 'NEEDED',
          deletedAt: opts.order?.deletedAt ?? null,
        },
  );
  mockPrisma.passenger.findMany.mockResolvedValue(opts.passengers ?? []);
  mockPrisma.fulfillmentTask.count.mockResolvedValue(opts.taskCount ?? 1);
  mockPrisma.auditLog.findFirst.mockResolvedValue(opts.lastAudit ?? null);
  mockPrisma.order.update.mockResolvedValue({});
  mockPrisma.auditLog.create.mockResolvedValue({});
}

beforeEach(() => vi.clearAllMocks());

describe('syncOrderVisaCompletion · 办结写入', () => {
  it('全员已送签 + 有我方任务 → 订单置 HAS_VISA，审计留原档', async () => {
    mount({
      order: { visaStatus: 'NEEDED' },
      passengers: [{ visaSubmissionStatus: 'CONFIRMED' }, { visaSubmissionStatus: 'CONFIRMED' }],
    });
    const res = await syncOrderVisaCompletion('o1', actor);
    expect(res).toEqual({ changed: true, kind: 'COMPLETED', orderNumber: 'ORD-1' });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { visaStatus: 'HAS_VISA' },
    });
    const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe(VISA_AUTO_COMPLETE_ACTION);
    expect(audit.before).toEqual({ visaStatus: 'NEEDED' });
  });

  it('已是 HAS_VISA → 幂等不重写', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'CONFIRMED' }],
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('还有人没送完 → 不办结', async () => {
    mount({
      order: { visaStatus: 'NEEDED' },
      passengers: [{ visaSubmissionStatus: 'CONFIRMED' }, { visaSubmissionStatus: 'IN_PROGRESS' }],
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('无我方签证任务（全撤销/从未建）→ 不办结（录单口径不被暗改）', async () => {
    mount({
      order: { visaStatus: 'NEEDED' },
      passengers: [{ visaSubmissionStatus: 'CONFIRMED' }],
      taskCount: 0,
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
  });

  it('无非自备签乘客 → 不办结（空单不算完成）', async () => {
    mount({ order: { visaStatus: 'NEEDED' }, passengers: [] });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
  });

  it('回收站单 → 不派生', async () => {
    mount({
      order: { visaStatus: 'NEEDED', deletedAt: new Date() },
      passengers: [{ visaSubmissionStatus: 'CONFIRMED' }],
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
    expect(mockPrisma.passenger.findMany).not.toHaveBeenCalled();
  });
});

describe('syncOrderVisaCompletion · 对称回退', () => {
  it('进度退回 + 已签证是派生写的（最近审计=办结）→ 恢复原档 E_VISA', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'PENDING' }],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'E_VISA' } },
    });
    const res = await syncOrderVisaCompletion('o1', actor);
    expect(res).toEqual({
      changed: true,
      kind: 'REVERTED',
      orderNumber: 'ORD-1',
      restoredTo: 'E_VISA',
    });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { visaStatus: 'E_VISA' },
    });
    expect(mockPrisma.auditLog.create.mock.calls[0][0].data.action).toBe(
      VISA_AUTO_COMPLETE_REVERT_ACTION,
    );
  });

  it('审计里原档缺失/不合法 → 回退到 NEEDED 兜底', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'PENDING' }],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'WHATEVER' } },
    });
    const res = await syncOrderVisaCompletion('o1', actor);
    expect(res).toMatchObject({ changed: true, kind: 'REVERTED', restoredTo: 'NEEDED' });
  });

  it('录单人手选的已签证（无办结审计）→ 绝不回退', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'PENDING' }],
      lastAudit: null,
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('上一条审计已是回退 → 不再重复回退', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'PENDING' }],
      lastAudit: { action: VISA_AUTO_COMPLETE_REVERT_ACTION, before: { visaStatus: 'HAS_VISA' } },
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
  });

  it('非 HAS_VISA 现值 → 无事可回退', async () => {
    mount({ order: { visaStatus: 'NEEDED' }, passengers: [{ visaSubmissionStatus: 'PENDING' }] });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
  });
});

describe('syncOrderVisaCompletion · 回退时的签证矛盾闸', () => {
  it('全员已改成自备签 → 不回退成「需要签证」（否则造出矛盾单，签证台看不见）', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'PENDING', visaExempt: true }],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'NEEDED' } },
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({ changed: false });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it('全员自备签但原档是「不需要签证」→ 照常回退（不构成矛盾）', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [{ visaSubmissionStatus: 'PENDING', visaExempt: true }],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'NOT_NEEDED' } },
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({
      changed: true,
      kind: 'REVERTED',
      orderNumber: 'ORD-1',
      restoredTo: 'NOT_NEEDED',
    });
  });

  it('名单里仍有人随团办签、只是进度退回 → 常规回退不受影响', async () => {
    mount({
      order: { visaStatus: 'HAS_VISA' },
      passengers: [
        { visaSubmissionStatus: 'PENDING', visaExempt: false },
        { visaSubmissionStatus: 'CONFIRMED', visaExempt: true },
      ],
      lastAudit: { action: VISA_AUTO_COMPLETE_ACTION, before: { visaStatus: 'NEEDED' } },
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({
      changed: true,
      kind: 'REVERTED',
      orderNumber: 'ORD-1',
      restoredTo: 'NEEDED',
    });
  });

  it('自备签乘客不参与办结判定：非自备签那位已送签 → 照常办结', async () => {
    mount({
      order: { visaStatus: 'NEEDED' },
      passengers: [
        { visaSubmissionStatus: 'CONFIRMED', visaExempt: false },
        { visaSubmissionStatus: 'PENDING', visaExempt: true },
      ],
    });
    expect(await syncOrderVisaCompletion('o1', actor)).toEqual({
      changed: true,
      kind: 'COMPLETED',
      orderNumber: 'ORD-1',
    });
  });
});
