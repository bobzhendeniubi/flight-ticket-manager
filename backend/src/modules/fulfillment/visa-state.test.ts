/**
 * 乘客级签证状态机 · 单测（纯函数 + 唯一落库点的调用形状）
 *
 * 覆盖：
 *   1. derivePassengerVisaState：订单头 × 自备签 × 送签进度全矩阵，与导出「签证状态」列逐字一致
 *   2. deriveOrderVisaStatus：办结派生只看非自备签乘客；无我方任务 / 无人可送 → 回落声明档
 *   3. transitionPassengerVisa：每个事件的守卫与写入列；幂等事件 changed=false
 *   4. visaProgressEvent：签证台目标档 → 事件的翻译
 *   5. 三列唯一写点 + 任务状态唯一重派生点的 Prisma 调用形状（mock db）
 */
import { describe, it, expect, vi } from 'vitest';
import { FulfillmentStatus, FulfillmentType, VisaRequirement, VisaSubmissionStatus } from '@prisma/client';

import {
  applyVisaProgress,
  assertNoVisaContradiction,
  DERIVABLE_TASK_STATUSES,
  deriveOrderVisaStates,
  deriveOrderVisaStatus,
  derivePassengerVisaState,
  deriveVisaTaskStatus,
  ourUnsubmittedVisaPassengersWhere,
  ourVisaPassengersWhere,
  PASSENGER_VISA_STATE_LABEL,
  rederiveVisaTaskStatus,
  transitionPassengerVisa,
  VISA_NEED_CONFIRM_SUBMITTED_MESSAGE,
  VISA_SELF_ARRANGED_NO_PROGRESS_MESSAGE,
  visaProgressEvent,
  writeOrderVisaStatus,
  writePassengerVisaExempt,
  writePassengerVisaProgress,
  type PassengerVisaFacts,
  type VisaDb,
} from './visa-state.js';
import { BadRequestError } from '../../lib/errors.js';
import { VISA_CONTRADICTION_MESSAGE } from '../orders/visa-need.js';

const { NOT_NEEDED, NEEDED, E_VISA, HAS_VISA } = VisaRequirement;
const { PENDING, IN_PROGRESS, CONFIRMED } = VisaSubmissionStatus;

const facts = (over: Partial<PassengerVisaFacts>): PassengerVisaFacts => ({
  orderVisaStatus: NEEDED,
  visaExempt: false,
  visaSubmissionStatus: PENDING,
  allPassengersExempt: false,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
describe('derivePassengerVisaState · 订单头 × 自备签 × 送签进度', () => {
  it('逐人推进的送签进度压过一切（含 NOT_NEEDED / HAS_VISA 订单头与自备签标记）', () => {
    for (const orderVisaStatus of [NOT_NEEDED, NEEDED, E_VISA, HAS_VISA, null]) {
      for (const visaExempt of [true, false]) {
        expect(derivePassengerVisaState(facts({ orderVisaStatus, visaExempt, visaSubmissionStatus: IN_PROGRESS }))).toBe('IN_PROGRESS');
        expect(derivePassengerVisaState(facts({ orderVisaStatus, visaExempt, visaSubmissionStatus: CONFIRMED }))).toBe('SUBMITTED');
      }
    }
  });

  it('订单头 NOT_NEEDED → 全员 NOT_NEEDED（联动置上的自备签跟订单头）', () => {
    expect(derivePassengerVisaState(facts({ orderVisaStatus: NOT_NEEDED, visaExempt: true, allPassengersExempt: true }))).toBe('NOT_NEEDED');
    expect(derivePassengerVisaState(facts({ orderVisaStatus: NOT_NEEDED, visaExempt: true }))).toBe('NOT_NEEDED');
    expect(derivePassengerVisaState(facts({ orderVisaStatus: NOT_NEEDED, visaExempt: false }))).toBe('NOT_NEEDED');
  });

  it('订单头 HAS_VISA → 全员联动置 exempt 写 ISSUED；混合单里手勾的自备签写 SELF_ARRANGED；随团无进度写 ISSUED', () => {
    expect(derivePassengerVisaState(facts({ orderVisaStatus: HAS_VISA, visaExempt: true, allPassengersExempt: true }))).toBe('ISSUED');
    expect(derivePassengerVisaState(facts({ orderVisaStatus: HAS_VISA, visaExempt: true, allPassengersExempt: false }))).toBe('SELF_ARRANGED');
    expect(derivePassengerVisaState(facts({ orderVisaStatus: HAS_VISA, visaExempt: false }))).toBe('ISSUED');
  });

  it('订单头 NEEDED / E_VISA / 未表态 → 自备签 SELF_ARRANGED，随团 PENDING', () => {
    for (const orderVisaStatus of [NEEDED, E_VISA, null, undefined]) {
      expect(derivePassengerVisaState(facts({ orderVisaStatus, visaExempt: true }))).toBe('SELF_ARRANGED');
      expect(derivePassengerVisaState(facts({ orderVisaStatus, visaExempt: false }))).toBe('PENDING');
    }
  });

  it('老数据缺列：visaExempt/visaSubmissionStatus 为 null/undefined 按随团待处理', () => {
    expect(derivePassengerVisaState(facts({ visaExempt: null, visaSubmissionStatus: undefined }))).toBe('PENDING');
  });

  it('六态各有中文文案', () => {
    expect(Object.keys(PASSENGER_VISA_STATE_LABEL).sort()).toEqual(
      ['IN_PROGRESS', 'ISSUED', 'NOT_NEEDED', 'PENDING', 'SELF_ARRANGED', 'SUBMITTED'],
    );
  });
});

describe('deriveOrderVisaStates · 整单一次算 allPassengersExempt', () => {
  it('HAS_VISA 混合单：自备签的写 SELF_ARRANGED；全员自备签写 ISSUED', () => {
    const mixed = deriveOrderVisaStates({ visaStatus: HAS_VISA }, [
      { id: 'a', visaExempt: true, visaSubmissionStatus: PENDING },
      { id: 'b', visaExempt: false, visaSubmissionStatus: CONFIRMED },
    ]);
    expect(mixed.map((p) => p.state)).toEqual(['SELF_ARRANGED', 'SUBMITTED']);
    const all = deriveOrderVisaStates({ visaStatus: HAS_VISA }, [
      { visaExempt: true, visaSubmissionStatus: PENDING },
      { visaExempt: true, visaSubmissionStatus: PENDING },
    ]);
    expect(all.map((p) => p.state)).toEqual(['ISSUED', 'ISSUED']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('deriveOrderVisaStatus · 办结派生只看非自备签乘客', () => {
  const pax = (visaExempt: boolean, state: 'PENDING' | 'IN_PROGRESS' | 'SUBMITTED' | 'SELF_ARRANGED') => ({ visaExempt, state });

  it('非自备签全部 SUBMITTED + 有我方任务 → HAS_VISA（自备签乘客不参与判定）', () => {
    expect(
      deriveOrderVisaStatus({
        declared: NEEDED,
        passengers: [pax(false, 'SUBMITTED'), pax(false, 'SUBMITTED'), pax(true, 'SELF_ARRANGED')],
        hasOurVisaTask: true,
      }),
    ).toBe(HAS_VISA);
  });

  it('还有人未送 / 无我方任务 / 无非自备签乘客 → 回落声明档', () => {
    expect(deriveOrderVisaStatus({ declared: E_VISA, passengers: [pax(false, 'SUBMITTED'), pax(false, 'IN_PROGRESS')], hasOurVisaTask: true })).toBe(E_VISA);
    expect(deriveOrderVisaStatus({ declared: NEEDED, passengers: [pax(false, 'SUBMITTED')], hasOurVisaTask: false })).toBe(NEEDED);
    expect(deriveOrderVisaStatus({ declared: NEEDED, passengers: [pax(true, 'SELF_ARRANGED')], hasOurVisaTask: true })).toBe(NEEDED);
    expect(deriveOrderVisaStatus({ declared: null, passengers: [], hasOurVisaTask: true })).toBeNull();
  });

  it('换人残留的「自备签 + 已送签」矛盾行不算我方送签数（与签证台统计条同口径）', () => {
    expect(deriveOrderVisaStatus({ declared: NEEDED, passengers: [pax(true, 'SUBMITTED')], hasOurVisaTask: true })).toBe(NEEDED);
  });
});

describe('deriveVisaTaskStatus（迁入）· 取最低档', () => {
  it('空 → PENDING；全 CONFIRMED → CONFIRMED；有人更早 → 较早那档', () => {
    expect(deriveVisaTaskStatus([])).toBe(FulfillmentStatus.PENDING);
    expect(deriveVisaTaskStatus([CONFIRMED, CONFIRMED])).toBe(FulfillmentStatus.CONFIRMED);
    expect(deriveVisaTaskStatus([CONFIRMED, IN_PROGRESS])).toBe(FulfillmentStatus.IN_PROGRESS);
    expect(deriveVisaTaskStatus([IN_PROGRESS, PENDING])).toBe(FulfillmentStatus.PENDING);
    expect(DERIVABLE_TASK_STATUSES).toEqual([FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS, FulfillmentStatus.CONFIRMED]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('transitionPassengerVisa · 转移表与守卫', () => {
  it('DECLARE_NOT_NEEDED / NEEDED / HAS_VISA：只写订单列；同值 → changed=false 不写', () => {
    const t1 = transitionPassengerVisa(facts({}), { type: 'DECLARE_NOT_NEEDED' });
    expect(t1).toMatchObject({ ok: true, from: 'PENDING', to: 'NOT_NEEDED', changed: true, write: { order: { visaStatus: NOT_NEEDED } } });
    const t2 = transitionPassengerVisa(facts({ orderVisaStatus: NOT_NEEDED }), { type: 'DECLARE_NEEDED', visaStatus: 'E_VISA' });
    expect(t2).toMatchObject({ ok: true, from: 'NOT_NEEDED', to: 'PENDING', write: { order: { visaStatus: E_VISA } } });
    const t3 = transitionPassengerVisa(facts({}), { type: 'DECLARE_HAS_VISA' });
    expect(t3).toMatchObject({ ok: true, to: 'ISSUED', write: { order: { visaStatus: HAS_VISA } } });
    const same = transitionPassengerVisa(facts({}), { type: 'DECLARE_NEEDED', visaStatus: 'NEEDED' });
    expect(same).toMatchObject({ ok: true, changed: false, write: {} });
  });

  it('DECLARE_SELF_ARRANGED：待处理的人直接改，进度置 PENDING；已在办理须 submittedConfirmed；已是自备签幂等', () => {
    const ok = transitionPassengerVisa(facts({}), { type: 'DECLARE_SELF_ARRANGED' });
    expect(ok).toMatchObject({
      ok: true,
      from: 'PENDING',
      to: 'SELF_ARRANGED',
      changed: true,
      write: { passenger: { visaExempt: true, visaSubmissionStatus: PENDING } },
    });
    const blocked = transitionPassengerVisa(facts({ visaSubmissionStatus: CONFIRMED }), { type: 'DECLARE_SELF_ARRANGED' });
    expect(blocked).toEqual({ ok: false, from: 'SUBMITTED', code: 'NEED_CONFIRM_SUBMITTED', reason: VISA_NEED_CONFIRM_SUBMITTED_MESSAGE });
    const confirmed = transitionPassengerVisa(facts({ visaSubmissionStatus: IN_PROGRESS }), { type: 'DECLARE_SELF_ARRANGED', submittedConfirmed: true });
    expect(confirmed).toMatchObject({ ok: true, from: 'IN_PROGRESS', to: 'SELF_ARRANGED', write: { passenger: { visaExempt: true, visaSubmissionStatus: PENDING } } });
    const idem = transitionPassengerVisa(facts({ visaExempt: true }), { type: 'DECLARE_SELF_ARRANGED' });
    expect(idem).toMatchObject({ ok: true, changed: false, write: {} });
  });

  it('REVOKE_SELF_ARRANGED：连已确认的进度也置回 PENDING；本就随团 → 幂等', () => {
    const t = transitionPassengerVisa(facts({ visaExempt: true, visaSubmissionStatus: CONFIRMED }), { type: 'REVOKE_SELF_ARRANGED' });
    expect(t).toMatchObject({ ok: true, from: 'SUBMITTED', to: 'PENDING', changed: true, write: { passenger: { visaExempt: false, visaSubmissionStatus: PENDING } } });
    expect(transitionPassengerVisa(facts({}), { type: 'REVOKE_SELF_ARRANGED' })).toMatchObject({ ok: true, changed: false, write: {} });
  });

  it('MARK_DOCS_READY / SUBMIT / REVERT：只写进度列；自备签乘客一律拒绝', () => {
    expect(transitionPassengerVisa(facts({}), { type: 'MARK_DOCS_READY' })).toMatchObject({ ok: true, from: 'PENDING', to: 'IN_PROGRESS', write: { passenger: { visaSubmissionStatus: IN_PROGRESS } } });
    expect(transitionPassengerVisa(facts({ visaSubmissionStatus: IN_PROGRESS }), { type: 'SUBMIT' })).toMatchObject({ ok: true, to: 'SUBMITTED', write: { passenger: { visaSubmissionStatus: CONFIRMED } } });
    expect(transitionPassengerVisa(facts({ visaSubmissionStatus: CONFIRMED }), { type: 'REVERT', to: 'IN_PROGRESS' })).toMatchObject({ ok: true, from: 'SUBMITTED', to: 'IN_PROGRESS' });
    expect(transitionPassengerVisa(facts({ visaSubmissionStatus: CONFIRMED }), { type: 'REVERT' })).toMatchObject({ ok: true, to: 'PENDING', write: { passenger: { visaSubmissionStatus: PENDING } } });
    for (const type of ['MARK_DOCS_READY', 'SUBMIT', 'REVERT'] as const) {
      expect(transitionPassengerVisa(facts({ visaExempt: true }), { type })).toEqual({
        ok: false,
        from: 'SELF_ARRANGED',
        code: 'SELF_ARRANGED',
        reason: VISA_SELF_ARRANGED_NO_PROGRESS_MESSAGE,
      });
    }
    // 换人残留的矛盾行（自备签 + 已送签）派生成 SUBMITTED，守卫按 visaExempt 列仍拒
    expect(transitionPassengerVisa(facts({ visaExempt: true, visaSubmissionStatus: CONFIRMED }), { type: 'REVERT' })).toMatchObject({ ok: false, from: 'SUBMITTED', code: 'SELF_ARRANGED' });
  });

  it('进度同值 → changed=false 不写（签证台重复点同一档）', () => {
    expect(transitionPassengerVisa(facts({ visaSubmissionStatus: CONFIRMED }), { type: 'SUBMIT' })).toMatchObject({ ok: true, changed: false, write: {} });
  });

  it('UPLOAD_PASSPORT / SPLIT_MOVE：不改任何列（状态随人走）', () => {
    for (const type of ['UPLOAD_PASSPORT', 'SPLIT_MOVE'] as const) {
      const t = transitionPassengerVisa(facts({ visaSubmissionStatus: CONFIRMED }), { type });
      expect(t).toMatchObject({ ok: true, from: 'SUBMITTED', to: 'SUBMITTED', changed: false, write: {} });
    }
  });

  it('SWAP_PASSENGER：显式带值 > 证件变化回落 false > 保持原值；进度不动（现状）', () => {
    expect(transitionPassengerVisa(facts({ visaExempt: true, visaSubmissionStatus: CONFIRMED }), { type: 'SWAP_PASSENGER', documentChanged: true })).toMatchObject({
      ok: true,
      changed: true,
      write: { passenger: { visaExempt: false } },
      facts: { visaSubmissionStatus: CONFIRMED },
    });
    expect(transitionPassengerVisa(facts({ visaExempt: false }), { type: 'SWAP_PASSENGER', documentChanged: true, visaExempt: true })).toMatchObject({ changed: true, write: { passenger: { visaExempt: true } } });
    expect(transitionPassengerVisa(facts({ visaExempt: true }), { type: 'SWAP_PASSENGER', documentChanged: false })).toMatchObject({ changed: false, write: {} });
  });
});

describe('visaProgressEvent · 签证台目标档翻译', () => {
  it('CONFIRMED → SUBMIT；IN_PROGRESS 从 CONFIRMED 来是 REVERT 否则 MARK_DOCS_READY；PENDING → REVERT', () => {
    expect(visaProgressEvent(CONFIRMED, PENDING)).toEqual({ type: 'SUBMIT' });
    expect(visaProgressEvent(IN_PROGRESS, PENDING)).toEqual({ type: 'MARK_DOCS_READY' });
    expect(visaProgressEvent(IN_PROGRESS, CONFIRMED)).toEqual({ type: 'REVERT', to: 'IN_PROGRESS' });
    expect(visaProgressEvent(PENDING, CONFIRMED)).toEqual({ type: 'REVERT', to: 'PENDING' });
    expect(visaProgressEvent(IN_PROGRESS, undefined)).toEqual({ type: 'MARK_DOCS_READY' });
  });
});

describe('assertNoVisaContradiction', () => {
  it('需签 + 全员自备签 → BadRequestError（统一文案）；其余放行', () => {
    expect(() => assertNoVisaContradiction({ visaStatus: NEEDED, passengers: [{ visaExempt: true }] })).toThrow(BadRequestError);
    expect(() => assertNoVisaContradiction({ visaStatus: NEEDED, passengers: [{ visaExempt: true }] })).toThrow(VISA_CONTRADICTION_MESSAGE);
    expect(() => assertNoVisaContradiction({ visaStatus: NEEDED, passengers: [] })).not.toThrow();
    expect(() => assertNoVisaContradiction({ visaStatus: NOT_NEEDED, passengers: [{ visaExempt: true }] })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('唯一写点 · Prisma 调用形状', () => {
  function mockDb() {
    const db = {
      passenger: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([{ visaSubmissionStatus: CONFIRMED }, { visaSubmissionStatus: PENDING }]),
      },
      fulfillmentTask: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      order: { update: vi.fn().mockResolvedValue({}) },
    };
    return { db: db as unknown as VisaDb, raw: db };
  }

  it('圈定条件：我方的人 = visaExempt=false；未送出 = 且进度 ≠ CONFIRMED', () => {
    expect(ourVisaPassengersWhere()).toEqual({ visaExempt: false });
    expect(ourVisaPassengersWhere('o1')).toEqual({ orderId: 'o1', visaExempt: false });
    expect(ourUnsubmittedVisaPassengersWhere()).toEqual({ visaExempt: false, visaSubmissionStatus: { not: CONFIRMED } });
  });

  it('writePassengerVisaProgress：按人 → id in；整单 → orderId + visaExempt=false', async () => {
    const { db, raw } = mockDb();
    await writePassengerVisaProgress(db, { passengerIds: ['p1', 'p2'] }, CONFIRMED);
    expect(raw.passenger.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['p1', 'p2'] } }, data: { visaSubmissionStatus: CONFIRMED } });
    await writePassengerVisaProgress(db, { orderId: 'o1' }, IN_PROGRESS);
    expect(raw.passenger.updateMany).toHaveBeenCalledWith({ where: { orderId: 'o1', visaExempt: false }, data: { visaSubmissionStatus: IN_PROGRESS } });
  });

  it('writePassengerVisaExempt / writeOrderVisaStatus：单条 update，extra 与签证状态同一条 UPDATE', async () => {
    const { db, raw } = mockDb();
    await writePassengerVisaExempt(db, 'p1', { visaExempt: true, visaSubmissionStatus: PENDING });
    expect(raw.passenger.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { visaExempt: true, visaSubmissionStatus: PENDING } });
    await writeOrderVisaStatus(db, 'o1', NEEDED, { noteVisa: '备注' });
    expect(raw.order.update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { noteVisa: '备注', visaStatus: NEEDED } });
    await writeOrderVisaStatus(db, 'o1', HAS_VISA);
    expect(raw.order.update).toHaveBeenLastCalledWith({ where: { id: 'o1' }, data: { visaStatus: HAS_VISA } });
  });

  it('rederiveVisaTaskStatus：按 touch 集合改写任务状态；CONFIRMED 盖 completedAt；statuses 传入时不回表', async () => {
    const { db, raw } = mockDb();
    const derived = await rederiveVisaTaskStatus(db, 'o1', { touch: DERIVABLE_TASK_STATUSES });
    expect(derived).toBe(FulfillmentStatus.PENDING);
    expect(raw.passenger.findMany).toHaveBeenCalledWith({ where: { orderId: 'o1', visaExempt: false }, select: { visaSubmissionStatus: true } });
    expect(raw.fulfillmentTask.updateMany).toHaveBeenCalledWith({
      where: { orderItem: { orderId: 'o1' }, type: FulfillmentType.VISA_APPLICATION, status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS, FulfillmentStatus.CONFIRMED] } },
      data: { status: FulfillmentStatus.PENDING, completedAt: null },
    });
    raw.passenger.findMany.mockClear();
    const derived2 = await rederiveVisaTaskStatus(db, 'o1', {
      touch: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS],
      statuses: [CONFIRMED, CONFIRMED],
    });
    expect(derived2).toBe(FulfillmentStatus.CONFIRMED);
    expect(raw.passenger.findMany).not.toHaveBeenCalled();
    expect(raw.fulfillmentTask.updateMany).toHaveBeenLastCalledWith({
      where: { orderItem: { orderId: 'o1' }, type: FulfillmentType.VISA_APPLICATION, status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS] } },
      data: { status: FulfillmentStatus.CONFIRMED, completedAt: expect.any(Date) },
    });
  });

  it('applyVisaProgress：逐人过守卫，自备签进 rejected，通过者一次 updateMany；全被拒 → 不写', async () => {
    const { db, raw } = mockDb();
    const res = await applyVisaProgress(db, {
      passengers: [
        { id: 'p1', visaExempt: false, visaSubmissionStatus: PENDING },
        { id: 'p2', visaExempt: true, visaSubmissionStatus: PENDING },
        { id: 'p3', visaExempt: false },
      ],
      to: CONFIRMED,
    });
    expect(res).toEqual({ okIds: ['p1', 'p3'], rejected: [{ id: 'p2', reason: VISA_SELF_ARRANGED_NO_PROGRESS_MESSAGE }] });
    expect(raw.passenger.updateMany).toHaveBeenCalledTimes(1);
    expect(raw.passenger.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['p1', 'p3'] } }, data: { visaSubmissionStatus: CONFIRMED } });
    raw.passenger.updateMany.mockClear();
    const none = await applyVisaProgress(db, { passengers: [{ id: 'x', visaExempt: true }], to: IN_PROGRESS });
    expect(none.okIds).toEqual([]);
    expect(raw.passenger.updateMany).not.toHaveBeenCalled();
  });
});
