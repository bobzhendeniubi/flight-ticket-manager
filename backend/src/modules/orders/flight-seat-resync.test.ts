/**
 * flight-seat-resync · 换人 / 订正跨婴儿边界后的占座数重对账（纯函数层）单测。
 */
import { describe, it, expect } from 'vitest';
import { PassengerType } from '@prisma/client';
import {
  flightSeatResyncShortageMessage,
  isInfantBoundaryCrossed,
  planFlightSeatResync,
  type FlightSeatResyncRowInput,
} from './flight-seat-resync.js';

const NOW = new Date('2026-09-13T00:00:00.000Z').getTime();
const FUTURE = new Date('2026-10-01T02:00:00.000Z');
const PAST = new Date('2026-09-01T02:00:00.000Z');

const ADULT = { passengerType: PassengerType.ADULT };
const CHILD = { passengerType: PassengerType.CHILD };
const INFANT = { passengerType: PassengerType.INFANT };

function flightRow(
  quantity: number,
  metadata: Record<string, unknown> | null,
  opts: { id?: string; departureTime?: Date | null; cabin?: 'ECONOMY' | 'BUSINESS' } = {},
): FlightSeatResyncRowInput {
  return {
    id: opts.id ?? 'itm-go',
    description: 'QH9588 澳门→岘港 经济舱',
    quantity,
    flightScheduleId: 'sched-go',
    flightCabin: opts.cabin ?? 'ECONOMY',
    metadata,
    flightSchedule: { departureTime: opts.departureTime === undefined ? FUTURE : opts.departureTime },
  };
}

describe('isInfantBoundaryCrossed · 只有婴儿 ↔ 占座乘客才算跨边界', () => {
  it('成人 → 婴儿 / 婴儿 → 成人 / 婴儿 → 儿童 都跨', () => {
    expect(isInfantBoundaryCrossed(PassengerType.ADULT, PassengerType.INFANT)).toBe(true);
    expect(isInfantBoundaryCrossed(PassengerType.INFANT, PassengerType.ADULT)).toBe(true);
    expect(isInfantBoundaryCrossed(PassengerType.INFANT, PassengerType.CHILD)).toBe(true);
  });

  it('成人 ↔ 儿童、类型没变、本次没带新类型 → 不跨', () => {
    expect(isInfantBoundaryCrossed(PassengerType.ADULT, PassengerType.CHILD)).toBe(false);
    expect(isInfantBoundaryCrossed(PassengerType.INFANT, PassengerType.INFANT)).toBe(false);
    expect(isInfantBoundaryCrossed(PassengerType.INFANT, undefined)).toBe(false);
    expect(isInfantBoundaryCrossed(null, PassengerType.ADULT)).toBe(false);
  });
});

describe('planFlightSeatResync · 现占 / 应占 / Δ', () => {
  it('成人改婴儿：2 人行盖章 2 座 → 应占 1，Δ = −1（放座）', () => {
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 2, infantCount: 0 })],
      [ADULT, INFANT],
      NOW,
    );
    expect(plan).toMatchObject({ passengerCount: 2, infantCount: 1, nonInfantPax: 1, changed: true });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      oldSeat: 2,
      newSeat: 1,
      delta: -1,
      departed: false,
      needsWrite: true,
      seatCappedByQuantity: false,
    });
  });

  it('婴儿改成人：2 人行盖章 1 座 → 应占 2，Δ = +1（占座）', () => {
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      [ADULT, ADULT],
      NOW,
    );
    expect(plan.rows[0]).toMatchObject({ oldSeat: 1, newSeat: 2, delta: 1, needsWrite: true });
  });

  it('婴儿改儿童同样占座（儿童是占座乘客）', () => {
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      [ADULT, CHILD],
      NOW,
    );
    expect(plan.rows[0]).toMatchObject({ oldSeat: 1, newSeat: 2, delta: 1 });
  });

  it('老行没盖过章：现占回落 quantity（2 座），成人改婴儿 → 放 1 座并首次盖章', () => {
    const plan = planFlightSeatResync([flightRow(2, null)], [ADULT, INFANT], NOW);
    expect(plan.rows[0]).toMatchObject({
      oldSeat: 2,
      newSeat: 1,
      delta: -1,
      hadExplicitSeatQuantity: false,
      needsWrite: true,
    });
  });

  it('盖章已是最新 → 没有一行要写，changed=false', () => {
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 1, infantCount: 1 })],
      [ADULT, INFANT],
      NOW,
    );
    expect(plan.changed).toBe(false);
    expect(plan.rows[0].needsWrite).toBe(false);
  });

  it('Δ=0 但婴儿数盖章过期 → 只需重盖章（needsWrite=true、delta=0）', () => {
    // 老行只写了 seatQuantity 没写 infantCount 的脏形状，也走这一支。
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 1 })],
      [ADULT, INFANT],
      NOW,
    );
    expect(plan.rows[0]).toMatchObject({ delta: 0, needsWrite: true });
    expect(plan.changed).toBe(true);
  });

  it('已起飞航段：Δ 照算但 departed=true（调用方只盖章不动账）', () => {
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 2, infantCount: 0 }, { departureTime: PAST })],
      [ADULT, INFANT],
      NOW,
    );
    expect(plan.rows[0]).toMatchObject({ delta: -1, departed: true });
  });

  it('套餐机票腿 quantity=seatPax：婴儿改成人时应占被 quantity 夹住，标 seatCappedByQuantity', () => {
    // 2 成人 + 1 婴儿的套餐：腿 quantity=2；婴儿改成人 → 非婴儿 3 > 2，加不上座。
    const plan = planFlightSeatResync(
      [flightRow(2, { seatQuantity: 2, infantCount: 1 })],
      [ADULT, ADULT, ADULT],
      NOW,
    );
    expect(plan.rows[0]).toMatchObject({
      oldSeat: 2,
      newSeat: 2,
      delta: 0,
      seatCappedByQuantity: true,
      needsWrite: true, // infantCount 1 → 0 要重盖
    });
  });

  it('取消航段 / 回程作废的残骸行与无班次行一律跳过', () => {
    const plan = planFlightSeatResync(
      [
        flightRow(2, { seatQuantity: 2, returnLegCancelled: { at: '2026-09-01' } }, { id: 'cancelled' }),
        flightRow(2, { seatQuantity: 2, returnVoidedFinal: { at: '2026-09-01' } }, { id: 'voided' }),
        { ...flightRow(2, { seatQuantity: 2 }, { id: 'no-sched' }), flightScheduleId: null },
        { ...flightRow(2, { seatQuantity: 2 }, { id: 'no-cabin' }), flightCabin: null },
        flightRow(2, { seatQuantity: 2, infantCount: 0 }, { id: 'live' }),
      ],
      [ADULT, INFANT],
      NOW,
    );
    expect(plan.rows.map((r) => r.itemId)).toEqual(['live']);
  });

  it('去程 + 回程两条行各算各的 Δ；升舱人数原样带出', () => {
    const plan = planFlightSeatResync(
      [
        flightRow(3, { seatQuantity: 3, infantCount: 0, businessUpgradeCount: 1 }, { id: 'go' }),
        flightRow(3, { seatQuantity: 3, infantCount: 0 }, { id: 'back' }),
      ],
      [ADULT, ADULT, INFANT],
      NOW,
    );
    expect(plan.rows.map((r) => [r.itemId, r.delta, r.businessUpgradeCount])).toEqual([
      ['go', -1, 1],
      ['back', -1, 0],
    ]);
  });

  it('婴儿单独一单：唯一乘客改成成人 → 0 座变 1 座', () => {
    const plan = planFlightSeatResync(
      [flightRow(1, { seatQuantity: 0, infantCount: 1 })],
      [ADULT],
      NOW,
    );
    expect(plan.rows[0]).toMatchObject({ oldSeat: 0, newSeat: 1, delta: 1 });
  });
});

describe('flightSeatResyncShortageMessage', () => {
  it('文案点名需要几个机位、哪个班次，并指路改期 / 改单申请', () => {
    expect(
      flightSeatResyncShortageMessage({
        description: 'QH9588 澳门→岘港',
        cabinLabel: '经济舱',
        need: 1,
      }),
    ).toBe(
      '出行人改为成人/儿童后需再占 1 个机位，该班次（QH9588 澳门→岘港 · 经济舱）已售罄，请先改期或提交改单申请',
    );
  });
});
