/**
 * 航段状态派生 · 单元测试
 *
 * 这是 no-show / 回程释放·恢复·作废在**四处**（退款报价、三模板导出、全岗总表、整班导出）
 * 的唯一口径来源，任何一条判定跑偏都会同时污染四张表，所以逐态钉死。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveLegStatus,
  formatLegStatus,
  formatOrderLegStatus,
  hasNoShowMark,
  isReturnCurrentlyReleased,
  restoredOversoldSeats,
  stripInternalLegPrefix,
} from './orders.leg-status.js';

const RELEASED_AT = '2026-09-02T03:15:23.000Z';
const RESTORED_AT = '2026-09-02T05:00:00.000Z';

const flight = (
  flightScheduleId: string | null,
  metadata: unknown,
): { kind: string; flightScheduleId: string | null; metadata: unknown } => ({
  kind: 'FLIGHT',
  flightScheduleId,
  metadata,
});

describe('isReturnCurrentlyReleased', () => {
  it('班次为空 + 有 returnReleased.at → 已释放', () => {
    expect(isReturnCurrentlyReleased(flight(null, { returnReleased: { at: RELEASED_AT } }))).toBe(
      true,
    );
  });

  it('班次已写回（恢复后）→ 不是已释放态', () => {
    expect(
      isReturnCurrentlyReleased(
        flight('sch-1', {
          returnReleased: { at: RELEASED_AT },
          returnRestored: { at: RESTORED_AT },
        }),
      ),
    ).toBe(false);
  });

  it('恢复晚于释放 → 不是已释放态（即使班次意外为空）', () => {
    expect(
      isReturnCurrentlyReleased(
        flight(null, {
          returnReleased: { at: RELEASED_AT },
          returnRestored: { at: RESTORED_AT },
        }),
      ),
    ).toBe(false);
  });

  it('再次释放（释放晚于恢复）→ 重新回到已释放态', () => {
    expect(
      isReturnCurrentlyReleased(
        flight(null, {
          returnRestored: { at: RESTORED_AT },
          returnReleased: { at: '2026-09-02T07:00:00.000Z' },
        }),
      ),
    ).toBe(true);
  });

  it('已被起飞后自动作废终结 → 不再算已释放（不可恢复）', () => {
    expect(
      isReturnCurrentlyReleased(
        flight(null, {
          returnReleased: { at: RELEASED_AT },
          returnVoidedFinal: { at: '2026-09-03T00:00:00.000Z' },
        }),
      ),
    ).toBe(false);
  });

  it('非机票行、无快照行、脏 metadata 一律 false', () => {
    expect(
      isReturnCurrentlyReleased({
        kind: 'HOTEL',
        flightScheduleId: null,
        metadata: { returnReleased: { at: RELEASED_AT } },
      }),
    ).toBe(false);
    expect(isReturnCurrentlyReleased(flight(null, null))).toBe(false);
    expect(isReturnCurrentlyReleased(flight(null, 'not-an-object'))).toBe(false);
    expect(isReturnCurrentlyReleased(flight(null, { returnReleased: { at: '不是时间' } }))).toBe(
      false,
    );
  });
});

describe('restoredOversoldSeats', () => {
  it('恢复时超售 → 返回超售座数', () => {
    expect(
      restoredOversoldSeats(
        flight('sch-1', { returnRestored: { at: RESTORED_AT, oversold: true, oversoldBy: 3 } }),
      ),
    ).toBe(3);
  });

  it('恢复时没超售 / 座数非法 → 0', () => {
    expect(
      restoredOversoldSeats(
        flight('sch-1', { returnRestored: { at: RESTORED_AT, oversold: false, oversoldBy: 0 } }),
      ),
    ).toBe(0);
    expect(
      restoredOversoldSeats(
        flight('sch-1', { returnRestored: { at: RESTORED_AT, oversold: true, oversoldBy: 'x' } }),
      ),
    ).toBe(0);
  });

  it('恢复之后又被释放 → 那笔超售已不成立，归 0', () => {
    expect(
      restoredOversoldSeats(
        flight(null, {
          returnRestored: { at: RESTORED_AT, oversold: true, oversoldBy: 2 },
          returnReleased: { at: '2026-09-02T07:00:00.000Z' },
        }),
      ),
    ).toBe(0);
  });
});

describe('deriveLegStatus / formatLegStatus — 四态', () => {
  it('去程未登机', () => {
    const item = flight('sch-out', { noShow: { at: RELEASED_AT, leg: 'OUTBOUND' } });
    expect(deriveLegStatus(item)).toBe('去程未登机');
    expect(formatLegStatus(item)).toBe('去程未登机');
  });

  it('回程座位已释放', () => {
    expect(formatLegStatus(flight(null, { returnReleased: { at: RELEASED_AT } }))).toBe(
      '回程座位已释放',
    );
  });

  it('回程已恢复（超售时带座数）', () => {
    expect(
      formatLegStatus(flight('sch-1', { returnRestored: { at: RESTORED_AT, oversold: false } })),
    ).toBe('回程已恢复');
    expect(
      formatLegStatus(
        flight('sch-1', { returnRestored: { at: RESTORED_AT, oversold: true, oversoldBy: 2 } }),
      ),
    ).toBe('回程已恢复（超售 2 座）');
  });

  it('回程已作废：起飞后自动作废与取消航段都算', () => {
    expect(
      formatLegStatus(
        flight(null, {
          returnReleased: { at: RELEASED_AT },
          returnVoidedFinal: { at: '2026-09-03T00:00:00.000Z' },
        }),
      ),
    ).toBe('回程已作废');
    // 快照没记 leg（取消航段刚上线时的早期数据）→ 按回程处理，与那阵子只做回程的事实一致。
    expect(
      formatLegStatus(flight(null, { returnLegCancelled: { at: '2026-08-30T00:00:00.000Z' } })),
    ).toBe('回程已作废');
    expect(
      formatLegStatus(
        flight(null, { returnLegCancelled: { at: '2026-08-30T00:00:00.000Z', leg: 'RETURN' } }),
      ),
    ).toBe('回程已作废');
  });

  it('取消的是**去程** → 「去程已作废」（一律写成回程会把方向说反）', () => {
    expect(
      deriveLegStatus(
        flight(null, { returnLegCancelled: { at: '2026-08-30T00:00:00.000Z', leg: 'OUTBOUND' } }),
      ),
    ).toBe('去程已作废');
    expect(
      formatLegStatus(
        flight(null, { returnLegCancelled: { at: '2026-08-30T00:00:00.000Z', leg: 'OUTBOUND' } }),
      ),
    ).toBe('去程已作废');
  });

  it('起飞后作废（returnVoidedFinal）只发生在回程：即便同行还挂着去程取消快照也判回程作废', () => {
    expect(
      deriveLegStatus(
        flight(null, {
          returnVoidedFinal: { at: '2026-09-03T00:00:00.000Z' },
          returnLegCancelled: { at: '2026-08-30T00:00:00.000Z', leg: 'OUTBOUND' },
        }),
      ),
    ).toBe('回程已作废');
  });

  it('正常航段留空', () => {
    expect(deriveLegStatus(flight('sch-1', null))).toBeNull();
    expect(formatLegStatus(flight('sch-1', null))).toBe('');
  });
});

describe('formatOrderLegStatus — 整单合并成一格', () => {
  it('去程未登机 + 回程已释放两行 → 两个状态都出，去重保序', () => {
    expect(
      formatOrderLegStatus([
        flight('sch-out', { noShow: { at: RELEASED_AT } }),
        flight(null, { returnReleased: { at: RELEASED_AT } }),
        { kind: 'HOTEL', flightScheduleId: null, metadata: null },
      ]),
    ).toBe('去程未登机 / 回程座位已释放');
  });

  it('同状态多行只出一次；全正常 → 空串', () => {
    expect(
      formatOrderLegStatus([
        flight('sch-1', { noShow: { at: RELEASED_AT } }),
        flight('sch-2', { noShow: { at: RELEASED_AT } }),
      ]),
    ).toBe('去程未登机');
    expect(formatOrderLegStatus([flight('sch-1', null), flight('sch-2', null)])).toBe('');
  });
});

describe('hasNoShowMark — 与飞行次数共用的「未登机」判据', () => {
  it('metadata.noShow 存在即为真；脏 JSON 一律按未打标，绝不抛错', () => {
    expect(hasNoShowMark({ noShow: { at: RELEASED_AT } })).toBe(true);
    expect(hasNoShowMark({ noShow: {} })).toBe(true);
    expect(hasNoShowMark({})).toBe(false);
    expect(hasNoShowMark(null)).toBe(false);
    expect(hasNoShowMark(undefined)).toBe(false);
    expect(hasNoShowMark('not-an-object')).toBe(false);
    expect(hasNoShowMark([{ noShow: { at: RELEASED_AT } }])).toBe(false);
  });
});

describe('stripInternalLegPrefix — 对外一律剥净', () => {
  it('六种前缀（含两种半角旧写法）逐一剥掉', () => {
    expect(stripInternalLegPrefix('【去程未登机】CA123')).toBe('CA123');
    expect(stripInternalLegPrefix('【回程座位已释放】CA124')).toBe('CA124');
    expect(stripInternalLegPrefix('【已取消去程】CA125')).toBe('CA125');
    expect(stripInternalLegPrefix('【已取消回程】CA126')).toBe('CA126');
    expect(stripInternalLegPrefix('[去程 no-show] CA127')).toBe('CA127');
    expect(stripInternalLegPrefix('[回程已释放] CA128')).toBe('CA128');
  });

  it('叠加多层（先释放后取消的脏数据）一路剥到干净；无前缀原样返回', () => {
    expect(stripInternalLegPrefix('【已取消回程】【回程座位已释放】CA129')).toBe('CA129');
    expect(stripInternalLegPrefix('CA130')).toBe('CA130');
    expect(stripInternalLegPrefix('')).toBe('');
  });
});
