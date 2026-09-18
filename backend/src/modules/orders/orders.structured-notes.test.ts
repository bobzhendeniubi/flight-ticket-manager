/**
 * 备注结构化（2026-09-17）回归测试 — 把高频写在自由备注里的四项做成字段。
 *
 * 覆盖的是「字段契约」本身，不碰任何定价：
 *   · 乘客级 bedPref（旧字段新露出）/ upgradeRedeemLeg / upgradeRedeemNote
 *   · 订单级 separatePnr / sameHotelWith
 * 分四段：
 *   ① 入口 schema 收得下、越界挡得住（枚举、长度、可空）
 *   ② 落库映射（passengerToData）默认值与显式值
 *   ③ 三处导出的单元格口径（大床/双床、是、去程·说明）
 *   ④ 四张表的列位（分房表挨着「酒店类型」、模板挨着「备注」、全岗总表在「备注」之前）
 *
 * 为什么值得单测：这四项的唯一价值就是「下游不用再读备注文本」。列位错了、单元格写法
 * 与另一张表不一致，运营对表时就得退回去翻备注 —— 功能等于没做。
 */
import { describe, expect, it } from 'vitest';
import {
  correctPassengerBodySchema,
  createOrderBodySchema,
  passengerInputSchema,
  selfUpdatePassengerBodySchema,
} from './orders.schemas.js';
import { passengerToData } from './orders.service.js';
import {
  bedPrefCell,
  separatePnrCell,
  upgradeRedeemCell,
  withoutAgentHiddenColumns,
  FULL_COLUMNS,
  TICKETING_COLUMNS,
} from './orders.export-templates.js';
import { COLUMNS as ROOM_ALLOCATION_COLUMNS } from './orders.export-room-allocation.js';
import { visibleColumns } from './orders.export-master.js';

/** 建单请求体的最小骨架（本文件只关心结构化备注那几个键，其余给刚好通过校验的最小值）。*/
function minimalOrderBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contactName: '张三',
    contactPhone: '13800000000',
    items: [
      {
        kind: 'FLIGHT',
        description: '成都 → 芽庄',
        quantity: 1,
        flightScheduleId: 'fs1',
        flightCabin: 'ECONOMY',
      },
    ],
    passengers: [
      {
        fullName: 'ZHANG/SAN',
        documentNumber: 'E12345678',
        dateOfBirth: '1990-01-01',
        passportExpiry: '2030-01-01',
      },
    ],
    ...extra,
  };
}

// ── ① 入口 schema ───────────────────────────────────────────────────────────
describe('备注结构化 · 乘客级字段入口校验', () => {
  const basePassenger = {
    fullName: 'ZHANG/SAN',
    documentNumber: 'E12345678',
    dateOfBirth: '1990-01-01',
  };

  it('兑换升舱四档枚举照单全收，说明一并落下', () => {
    for (const leg of ['NONE', 'OUTBOUND', 'RETURN', 'BOTH'] as const) {
      const parsed = passengerInputSchema.parse({
        ...basePassenger,
        upgradeRedeemLeg: leg,
        upgradeRedeemNote: '用同行人的次数',
      });
      expect(parsed.upgradeRedeemLeg).toBe(leg);
      expect(parsed.upgradeRedeemNote).toBe('用同行人的次数');
    }
  });

  it('枚举之外的航段值（如 ONEWAY）直接拒 —— 不静默落库成脏枚举', () => {
    expect(
      passengerInputSchema.safeParse({ ...basePassenger, upgradeRedeemLeg: 'ONEWAY' }).success,
    ).toBe(false);
  });

  it('兑换说明 80 字放行、81 字拒收（超长说明塞不进导出的一格）', () => {
    expect(
      passengerInputSchema.safeParse({ ...basePassenger, upgradeRedeemNote: '次'.repeat(80) })
        .success,
    ).toBe(true);
    expect(
      passengerInputSchema.safeParse({ ...basePassenger, upgradeRedeemNote: '次'.repeat(81) })
        .success,
    ).toBe(false);
  });

  it('床型仍是老四档（DOUBLE/TWIN 是界面新露出的两档），中文字面量不收', () => {
    expect(passengerInputSchema.parse({ ...basePassenger, bedPref: 'DOUBLE' }).bedPref).toBe(
      'DOUBLE',
    );
    expect(passengerInputSchema.safeParse({ ...basePassenger, bedPref: '大床' }).success).toBe(
      false,
    );
  });

  it('三项都不传 → 键不出现（老客户端行为与改造前完全一致）', () => {
    const parsed = passengerInputSchema.parse(basePassenger);
    expect(parsed.upgradeRedeemLeg).toBeUndefined();
    expect(parsed.upgradeRedeemNote).toBeUndefined();
    expect(parsed.bedPref).toBeUndefined();
  });
});

describe('备注结构化 · 订单级字段入口校验', () => {
  it('建单收 separatePnr / sameHotelWith', () => {
    const parsed = createOrderBodySchema.parse(
      minimalOrderBody({ separatePnr: true, sameHotelWith: '和王五同一个酒店' }),
    );
    expect(parsed.separatePnr).toBe(true);
    expect(parsed.sameHotelWith).toBe('和王五同一个酒店');
  });

  it('同酒店安排 120 字放行、121 字拒收', () => {
    expect(
      createOrderBodySchema.safeParse(minimalOrderBody({ sameHotelWith: '和'.repeat(120) }))
        .success,
    ).toBe(true);
    expect(
      createOrderBodySchema.safeParse(minimalOrderBody({ sameHotelWith: '和'.repeat(121) }))
        .success,
    ).toBe(false);
  });

  it('sameHotelWith 收 null —— 填过的安排要能清空，而不是只能越填越多', () => {
    expect(createOrderBodySchema.parse(minimalOrderBody({ sameHotelWith: null })).sameHotelWith)
      .toBeNull();
  });
});

describe('备注结构化 · 订正 / 自助补录通道同样收这三项', () => {
  it('订正弹窗收床型 / 兑换升舱，且可置空回「不限」「不兑换」', () => {
    const parsed = correctPassengerBodySchema.parse({
      mode: 'CORRECTION',
      bedPref: 'TWIN',
      upgradeRedeemLeg: 'RETURN',
      upgradeRedeemNote: '用同行人的次数',
    });
    expect(parsed).toMatchObject({
      bedPref: 'TWIN',
      upgradeRedeemLeg: 'RETURN',
      upgradeRedeemNote: '用同行人的次数',
    });
    expect(
      correctPassengerBodySchema.safeParse({
        mode: 'CORRECTION',
        bedPref: null,
        upgradeRedeemNote: null,
      }).success,
    ).toBe(true);
  });

  it('只改床型也算「提供了需要订正的字段」（不该被 refine 判成空请求）', () => {
    expect(
      correctPassengerBodySchema.safeParse({ mode: 'CORRECTION', bedPref: 'DOUBLE' }).success,
    ).toBe(true);
  });

  it('代理自助补录同样收这三项（不影响定价，无审批闸）', () => {
    expect(
      selfUpdatePassengerBodySchema.parse({
        bedPref: 'DOUBLE',
        upgradeRedeemLeg: 'BOTH',
        upgradeRedeemNote: '经济舱第一排',
      }),
    ).toMatchObject({
      bedPref: 'DOUBLE',
      upgradeRedeemLeg: 'BOTH',
      upgradeRedeemNote: '经济舱第一排',
    });
  });
});

// ── ② 落库映射 ──────────────────────────────────────────────────────────────
describe('备注结构化 · passengerToData 落库映射', () => {
  const base = {
    fullName: 'ZHANG/SAN',
    documentType: 'PASSPORT' as const,
    documentNumber: 'E12345678',
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
  };

  it('不传 → 兑换升舱落 NONE、说明与床型落 null（存量与旧客户端口径不变）', () => {
    const data = passengerToData(base);
    expect(data.upgradeRedeemLeg).toBe('NONE');
    expect(data.upgradeRedeemNote).toBeNull();
    expect(data.bedPref).toBeNull();
  });

  it('传了 → 原样落库', () => {
    expect(
      passengerToData({
        ...base,
        bedPref: 'TWIN',
        upgradeRedeemLeg: 'OUTBOUND',
        upgradeRedeemNote: '用同行人的次数',
      }),
    ).toMatchObject({
      bedPref: 'TWIN',
      upgradeRedeemLeg: 'OUTBOUND',
      upgradeRedeemNote: '用同行人的次数',
    });
  });
});

// ── ③ 导出单元格口径 ────────────────────────────────────────────────────────
describe('备注结构化 · 导出单元格口径（四张表共用一份）', () => {
  it('床型只出运营真会填的两档，其余一律留空', () => {
    expect(bedPrefCell('DOUBLE')).toBe('大床');
    expect(bedPrefCell('TWIN')).toBe('双床');
    expect(bedPrefCell('SHARE_OK')).toBe('');
    expect(bedPrefCell('SINGLE')).toBe('');
    expect(bedPrefCell(null)).toBe('');
    expect(bedPrefCell(undefined)).toBe('');
  });

  it('单独编码勾了写「是」，没勾留空（不写「否」——整列「否」读起来像逐单确认过）', () => {
    expect(separatePnrCell(true)).toBe('是');
    expect(separatePnrCell(false)).toBe('');
    expect(separatePnrCell(null)).toBe('');
  });

  it('兑换升舱 = 航段 + 说明；NONE 与「只有说明没选航段」都留空', () => {
    expect(upgradeRedeemCell({ upgradeRedeemLeg: 'OUTBOUND' })).toBe('去程');
    expect(
      upgradeRedeemCell({ upgradeRedeemLeg: 'RETURN', upgradeRedeemNote: '用同行人的次数' }),
    ).toBe('回程 · 用同行人的次数');
    expect(upgradeRedeemCell({ upgradeRedeemLeg: 'BOTH' })).toBe('往返');
    expect(upgradeRedeemCell({ upgradeRedeemLeg: 'NONE', upgradeRedeemNote: '随手写的' })).toBe('');
    expect(upgradeRedeemCell({ upgradeRedeemNote: '只写了说明' })).toBe('');
    expect(upgradeRedeemCell({})).toBe('');
  });

  it('说明两侧空白不带进单元格', () => {
    expect(upgradeRedeemCell({ upgradeRedeemLeg: 'RETURN', upgradeRedeemNote: '  ' })).toBe('回程');
  });

  it('原型上的键（toString / constructor）不当成航段 —— 查表不许顺着原型链摸上去', () => {
    // 对象字面量查表会把 Object.prototype 上的函数当成命中值，这一格就渲染成
    // `function toString() ... · 说明`。床型那列同理（bedPref 还是自由 String? 列，更容易脏）。
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(upgradeRedeemCell({ upgradeRedeemLeg: key, upgradeRedeemNote: '说明' })).toBe('');
      expect(bedPrefCell(key)).toBe('');
    }
  });
});

// ── ④ 列位 ──────────────────────────────────────────────────────────────────
describe('备注结构化 · 四张表的列位', () => {
  it('分房表：床型 / 同酒店紧挨「酒店类型」', () => {
    const headers = ROOM_ALLOCATION_COLUMNS.map((c) => c.header);
    const at = headers.indexOf('酒店类型');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(headers.slice(at, at + 3)).toEqual(['酒店类型', '床型', '同酒店']);
  });

  it('《票务专用》：单独编码 / 兑换升舱紧跟「备注」，PNR 标准列整块不被插开', () => {
    const headers = TICKETING_COLUMNS.map((c) => c.header);
    expect(headers.slice(0, 5)).toEqual(['代理', '备注', '单独编码', '兑换升舱', 'Last Name']);
  });

  it('《全岗可用》：单独编码 / 兑换升舱紧跟「备注」', () => {
    const headers = FULL_COLUMNS.map((c) => c.header);
    const at = headers.indexOf('备注');
    expect(headers.slice(at, at + 3)).toEqual(['备注', '单独编码', '兑换升舱']);
  });

  it('全岗总表：四列都在「备注」之前（先看结构化的，再看剩下的自由文本）', () => {
    const headers = visibleColumns('all').map((c) => c.header);
    const at = headers.indexOf('备注');
    expect(headers.slice(at - 4, at + 1)).toEqual([
      '床型',
      '同酒店',
      '单独编码',
      '兑换升舱',
      '备注',
    ]);
  });

  // ── 代理视角的不对称（刻意为之，别在后续改动里「顺手对齐」）──────────────────
  // 三模板给代理看这两列，全岗总表不给：这四项本就是代理自己录单时填的，模板是他自己的
  // 名单，看见天经地义；全岗总表的代理视图是一份收敛到 13 列的白名单（内部台账裁出来的），
  // 政策是「白名单没点名就一列都没有」——新列默认不外泄，要加得先拍板加进白名单。
  it('不对称①：《票务专用》代理视图保留单独编码 / 兑换升舱（代理自己填的，不是我方内部口径）', () => {
    const agentHeaders = withoutAgentHiddenColumns(TICKETING_COLUMNS).map((c) => c.header);
    expect(agentHeaders).toContain('单独编码');
    expect(agentHeaders).toContain('兑换升舱');
  });

  it('不对称②：《全岗可用》代理视图同样保留这两列', () => {
    const agentHeaders = withoutAgentHiddenColumns(FULL_COLUMNS).map((c) => c.header);
    expect(agentHeaders).toContain('单独编码');
    expect(agentHeaders).toContain('兑换升舱');
  });

  it('不对称③：全岗总表代理白名单没点名新四列 → 一列都不外泄（与①②刻意不同）', () => {
    const agentHeaders = visibleColumns('agent').map((c) => c.header);
    for (const h of ['床型', '同酒店', '单独编码', '兑换升舱']) {
      expect(agentHeaders).not.toContain(h);
    }
  });
});
