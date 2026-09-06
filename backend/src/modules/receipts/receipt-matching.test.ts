/**
 * 流水匹配引擎 · 纯函数单元测试。
 *
 * 覆盖：每种 reason 的触发与不触发、置信度边界（HIGH 双向唯一 / 同额多候选降级 /
 * 部分付款强弱身份 / 覆盖）、组合建议（多笔凑一单 / 一笔付多单）、金额分精度、
 * 文本归一化（全角 / 空格 / 代理后缀 / 手机尾号整串比对）、截断与排序。
 */
import { describe, it, expect } from 'vitest';
import {
  collectReasons,
  matchReceipts,
  normalizeText,
  scoreReasons,
  toCents,
  MATCH_REASON_WEIGHT,
  type MatchOrder,
  type MatchReceipt,
} from './receipt-matching.js';

// 2026-09-01 10:00 北京时
const T0 = new Date('2026-09-01T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function receipt(over: Partial<MatchReceipt> & { id: string }): MatchReceipt {
  return {
    remainingCents: 100_000,
    receivedAt: T0,
    payerNote: null,
    orderHintId: null,
    ...over,
  };
}

function order(over: Partial<MatchOrder> & { orderId: string }): MatchOrder {
  return {
    orderNumber: `FTM20260901${over.orderId.padStart(5, '0')}`,
    contactName: '联系人',
    contactPhone: null,
    passengerNames: [],
    agentId: null,
    agentNames: [],
    agentPhone: null,
    createdAt: new Date(T0.getTime() - DAY),
    balanceDueCents: 100_000,
    ...over,
  };
}

function candidatesOf(result: ReturnType<typeof matchReceipts>, receiptId: string) {
  return result.receipts.find((r) => r.receiptId === receiptId)?.candidates ?? [];
}

// ═════════════════════════════════════════════════════════════════════════════
describe('toCents / normalizeText', () => {
  it('金额转分四舍五入到分，字符串与 Decimal 形状都吃', () => {
    expect(toCents(1000.01)).toBe(100_001);
    expect(toCents('1000.01')).toBe(100_001);
    expect(toCents({ toString: () => '544.00' })).toBe(54_400);
    // 0.1 + 0.2 这种浮点尾巴不会漏成 30 分以外的值
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(Number.NaN)).toBe(0);
  });

  it('归一化：全角转半角、小写、去空白与标点', () => {
    expect(normalizeText(' ＦＴＭ2026 - 0901／00001 ')).toBe('ftm2026090100001');
    expect(normalizeText('张三（微信）')).toBe('张三微信');
    expect(normalizeText(null)).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('collectReasons · 每种 reason', () => {
  it('AMOUNT_EXACT / AMOUNT_PARTIAL / AMOUNT_COVERS 按分整数比较', () => {
    const o = order({ orderId: 'o1', balanceDueCents: 100_000 });
    expect(collectReasons(receipt({ id: 'r', remainingCents: 100_000 }), o)[0]).toBe('AMOUNT_EXACT');
    expect(collectReasons(receipt({ id: 'r', remainingCents: 99_999 }), o)[0]).toBe('AMOUNT_PARTIAL');
    expect(collectReasons(receipt({ id: 'r', remainingCents: 100_001 }), o)[0]).toBe('AMOUNT_COVERS');
  });

  it('REMARK_HAS_ORDER_NO：备注含完整订单号（大小写/全角/空格不敏感）或订单号数字核整串', () => {
    const o = order({ orderId: 'o1', orderNumber: 'FTM2026090100001' });
    expect(collectReasons(receipt({ id: 'r', payerNote: '尾款 ftm 2026090100001' }), o)).toContain(
      'REMARK_HAS_ORDER_NO',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '单号2026090100001' }), o)).toContain(
      'REMARK_HAS_ORDER_NO',
    );
    // 数字核只认整串，前缀相同的更长数字串不算
    expect(
      collectReasons(receipt({ id: 'r', payerNote: '20260901000019' }), o),
    ).not.toContain('REMARK_HAS_ORDER_NO');
    expect(collectReasons(receipt({ id: 'r', payerNote: null }), o)).not.toContain(
      'REMARK_HAS_ORDER_NO',
    );
  });

  it('ORDER_HINT：进账自报的疑似订单指向该单才算', () => {
    const o = order({ orderId: 'o1' });
    expect(collectReasons(receipt({ id: 'r', orderHintId: 'o1' }), o)).toContain('ORDER_HINT');
    expect(collectReasons(receipt({ id: 'r', orderHintId: 'o2' }), o)).not.toContain('ORDER_HINT');
  });

  it('REMARK_HAS_PASSENGER_NAME：联系人或乘客姓名（中文 ≥2 字、拼音 ≥3 位、斜线拆名容错）', () => {
    const o = order({
      orderId: 'o1',
      contactName: '王小明',
      passengerNames: ['ZHANG/SAN', '李四', 'A/B'],
    });
    expect(collectReasons(receipt({ id: 'r', payerNote: '王小明 尾款' }), o)).toContain(
      'REMARK_HAS_PASSENGER_NAME',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: 'zhang san' }), o)).toContain(
      'REMARK_HAS_PASSENGER_NAME',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '李四' }), o)).toContain(
      'REMARK_HAS_PASSENGER_NAME',
    );
    // "A/B" 归一化后只有 2 个字母，不算线索——否则随便一个付款人 ID 都能撞上
    expect(collectReasons(receipt({ id: 'r', payerNote: 'ab' }), o)).not.toContain(
      'REMARK_HAS_PASSENGER_NAME',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '赵六' }), o)).not.toContain(
      'REMARK_HAS_PASSENGER_NAME',
    );
  });

  it('PAYER_MATCHES_AGENT：代理公司名去「有限公司/旅行社」后缀取核心词，也认代理联系人', () => {
    const o = order({
      orderId: 'o1',
      agentId: 'a1',
      agentNames: ['阳光国际旅行社有限公司', '周经理'],
    });
    expect(collectReasons(receipt({ id: 'r', payerNote: '阳光 尾款' }), o)).toContain(
      'PAYER_MATCHES_AGENT',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '阳光国际旅行社' }), o)).toContain(
      'PAYER_MATCHES_AGENT',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '周经理' }), o)).toContain(
      'PAYER_MATCHES_AGENT',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '月光' }), o)).not.toContain(
      'PAYER_MATCHES_AGENT',
    );
  });

  it('PHONE_TAIL：备注里的数字串整串等于全号或尾号 4 位；子串不算', () => {
    const o = order({ orderId: 'o1', contactPhone: '+86 138-1234-5678' });
    expect(collectReasons(receipt({ id: 'r', payerNote: '王先生 尾号5678' }), o)).toContain(
      'PHONE_TAIL',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '13812345678' }), o)).toContain(
      'PHONE_TAIL',
    );
    // 尾号出现在更长的数字串里（如 2026090156780）不算
    expect(collectReasons(receipt({ id: 'r', payerNote: '2026090156780' }), o)).not.toContain(
      'PHONE_TAIL',
    );
    expect(collectReasons(receipt({ id: 'r', payerNote: '尾号1234' }), o)).not.toContain(
      'PHONE_TAIL',
    );
  });

  it('PHONE_TAIL 也认代理手机', () => {
    const o = order({ orderId: 'o1', agentId: 'a1', agentPhone: '13900001111' });
    expect(collectReasons(receipt({ id: 'r', payerNote: '1111' }), o)).toContain('PHONE_TAIL');
  });

  it('DATE_NEAR：下单前 1 天 ~ 下单后 N 天（默认 30）为邻近，边界含', () => {
    const created = T0;
    const o = order({ orderId: 'o1', createdAt: created });
    const near = (ms: number) =>
      collectReasons(receipt({ id: 'r', receivedAt: new Date(created.getTime() + ms) }), o).includes(
        'DATE_NEAR',
      );
    expect(near(0)).toBe(true);
    expect(near(-DAY)).toBe(true);
    expect(near(-DAY - 1)).toBe(false);
    expect(near(30 * DAY)).toBe(true);
    expect(near(30 * DAY + 1)).toBe(false);
    // 可配置窗口
    expect(
      collectReasons(
        receipt({ id: 'r', receivedAt: new Date(created.getTime() + 3 * DAY) }),
        o,
        { dateNearDays: 2 },
      ),
    ).not.toContain('DATE_NEAR');
  });

  it('scoreReasons = 权重之和', () => {
    expect(scoreReasons(['AMOUNT_EXACT', 'REMARK_HAS_ORDER_NO', 'DATE_NEAR'])).toBe(
      MATCH_REASON_WEIGHT.AMOUNT_EXACT +
        MATCH_REASON_WEIGHT.REMARK_HAS_ORDER_NO +
        MATCH_REASON_WEIGHT.DATE_NEAR,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('matchReceipts · 置信度', () => {
  it('HIGH = 金额精确 + 身份线索 + 双向唯一', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 181_000, payerNote: '张三' })],
      [
        order({ orderId: 'o1', contactName: '张三', balanceDueCents: 181_000 }),
        order({ orderId: 'o2', contactName: '李四', balanceDueCents: 181_000 }),
      ],
    );
    const cs = candidatesOf(res, 'r1');
    expect(cs[0]).toMatchObject({
      orderId: 'o1',
      confidence: 'HIGH',
      suggestedAmountCents: 181_000,
    });
    expect(cs[0].reasons).toEqual(
      expect.arrayContaining(['AMOUNT_EXACT', 'REMARK_HAS_PASSENGER_NAME']),
    );
    // 同额但无身份的 o2：这笔流水有两张精确候选 → 不唯一 → LOW
    expect(cs[1]).toMatchObject({ orderId: 'o2', confidence: 'LOW' });
  });

  it('同额多候选（两张同名同额订单）→ 双方都降 MEDIUM，不出 HIGH', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', payerNote: '张三' })],
      [
        order({ orderId: 'o1', contactName: '张三' }),
        order({ orderId: 'o2', contactName: '张三' }),
      ],
    );
    const cs = candidatesOf(res, 'r1');
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.confidence === 'MEDIUM')).toBe(true);
  });

  it('同一张订单被两笔「精确+身份」流水命中 → 两笔都 MEDIUM（订单侧不唯一）', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'r1', payerNote: '张三' }),
        receipt({ id: 'r2', payerNote: '张三', receivedAt: new Date(T0.getTime() + 3600_000) }),
      ],
      [order({ orderId: 'o1', contactName: '张三' })],
    );
    expect(candidatesOf(res, 'r1')[0].confidence).toBe('MEDIUM');
    expect(candidatesOf(res, 'r2')[0].confidence).toBe('MEDIUM');
  });

  it('金额精确、无身份线索、双向唯一 → MEDIUM（老前端的一对一口径现在只到 MEDIUM）', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 54_400 })],
      [order({ orderId: 'o1', balanceDueCents: 54_400 }), order({ orderId: 'o2', balanceDueCents: 99_900 })],
    );
    const cs = candidatesOf(res, 'r1');
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ orderId: 'o1', confidence: 'MEDIUM', reasons: ['AMOUNT_EXACT', 'DATE_NEAR'] });
  });

  it('金额精确、无身份线索、撞车（两张同额订单）→ LOW', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1' })],
      [order({ orderId: 'o1' }), order({ orderId: 'o2' })],
    );
    const cs = candidatesOf(res, 'r1');
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.confidence === 'LOW')).toBe(true);
  });

  it('部分付款 + 强身份（订单号）→ MEDIUM；建议金额 = 流水余额', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 30_000, payerNote: 'FTM2026090100001 定金' })],
      [order({ orderId: 'o1', orderNumber: 'FTM2026090100001', balanceDueCents: 100_000 })],
    );
    const c = candidatesOf(res, 'r1')[0];
    expect(c).toMatchObject({ confidence: 'MEDIUM', suggestedAmountCents: 30_000 });
    expect(c.reasons).toEqual(expect.arrayContaining(['AMOUNT_PARTIAL', 'REMARK_HAS_ORDER_NO']));
  });

  it('部分付款 + 两条弱身份叠加（姓名 + 尾号）→ MEDIUM；单条弱身份 → LOW', () => {
    const strong = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 30_000, payerNote: '张三 尾号5678' })],
      [order({ orderId: 'o1', contactName: '张三', contactPhone: '13812345678', balanceDueCents: 100_000 })],
    );
    expect(candidatesOf(strong, 'r1')[0].confidence).toBe('MEDIUM');

    const weak = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 30_000, payerNote: '张三' })],
      [order({ orderId: 'o1', contactName: '张三', balanceDueCents: 100_000 })],
    );
    expect(candidatesOf(weak, 'r1')[0].confidence).toBe('LOW');
  });

  it('流水大于尾款（覆盖）+ 身份线索 → LOW，建议金额 = 订单尾款', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 120_000, payerNote: 'FTM2026090100001' })],
      [order({ orderId: 'o1', orderNumber: 'FTM2026090100001', balanceDueCents: 100_000 })],
    );
    const c = candidatesOf(res, 'r1')[0];
    expect(c).toMatchObject({ confidence: 'LOW', suggestedAmountCents: 100_000 });
    expect(c.reasons).toContain('AMOUNT_COVERS');
  });

  it('只有金额部分/覆盖关系、无任何身份线索 → 不成候选', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 30_000 }), receipt({ id: 'r2', remainingCents: 999_999 })],
      [order({ orderId: 'o1', balanceDueCents: 100_000 })],
    );
    expect(res.receipts).toEqual([]);
  });

  it('余额 ≤ 0 的流水与尾款 ≤ 0 的订单直接忽略', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 0, payerNote: '张三' })],
      [order({ orderId: 'o1', contactName: '张三', balanceDueCents: 0 })],
    );
    expect(res.receipts).toEqual([]);
    expect(res.combos).toEqual([]);
  });

  it('1000.01 与 1000.00 不相等（分级精度，不吃浮点容差）', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: toCents(1000.01), payerNote: '张三' })],
      [order({ orderId: 'o1', contactName: '张三', balanceDueCents: toCents(1000) })],
    );
    const c = candidatesOf(res, 'r1')[0];
    expect(c.reasons[0]).toBe('AMOUNT_COVERS');
    expect(c.confidence).toBe('LOW');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('matchReceipts · 排序与截断', () => {
  it('候选按 HIGH → MEDIUM → LOW，再按分数降序；每笔最多 maxCandidatesPerReceipt 张', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 100_000, payerNote: '张三 FTM2026090100003' })],
      [
        order({ orderId: 'o1', contactName: '张三', balanceDueCents: 100_000 }), // 精确+姓名，但订单号指向 o3
        order({ orderId: 'o2', contactName: '张三', balanceDueCents: 200_000 }), // 部分+姓名 → LOW
        order({ orderId: 'o3', orderNumber: 'FTM2026090100003', balanceDueCents: 100_000 }), // 精确+订单号
        order({ orderId: 'o4', contactName: '张三', balanceDueCents: 300_000 }),
        order({ orderId: 'o5', contactName: '张三', balanceDueCents: 400_000 }),
        order({ orderId: 'o6', contactName: '张三', balanceDueCents: 500_000 }),
        order({ orderId: 'o7', contactName: '张三', balanceDueCents: 600_000 }),
      ],
      { maxCandidatesPerReceipt: 3 },
    );
    const cs = candidatesOf(res, 'r1');
    expect(cs).toHaveLength(3);
    // o1 与 o3 都是「精确+身份」→ 这笔流水不唯一 → 都 MEDIUM；o3 分更高（订单号 40 > 姓名 25）排第一
    expect(cs[0]).toMatchObject({ orderId: 'o3', confidence: 'MEDIUM' });
    expect(cs[1]).toMatchObject({ orderId: 'o1', confidence: 'MEDIUM' });
    expect(cs[2].confidence).toBe('LOW');
    expect(cs[0].score).toBeGreaterThan(cs[1].score);
  });

  it('同分同档时到账时间更贴近下单的排前', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 30_000, payerNote: '张三', receivedAt: T0 })],
      [
        order({ orderId: 'far', contactName: '张三', balanceDueCents: 100_000, createdAt: new Date(T0.getTime() - 20 * DAY) }),
        order({ orderId: 'near', contactName: '张三', balanceDueCents: 100_000, createdAt: new Date(T0.getTime() - DAY) }),
      ],
    );
    expect(candidatesOf(res, 'r1').map((c) => c.orderId)).toEqual(['near', 'far']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('matchReceipts · 组合：多笔凑一单', () => {
  it('同付款人、同一北京日、两笔之和 == 某单尾款 → MANY_RECEIPTS_ONE_ORDER，含逐条认款计划', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'r1', remainingCents: 30_000, payerNote: '王芳', receivedAt: T0 }),
        receipt({ id: 'r2', remainingCents: 70_000, payerNote: '王芳', receivedAt: new Date(T0.getTime() + 3600_000) }),
      ],
      [order({ orderId: 'o1', contactName: '王芳', balanceDueCents: 100_000 })],
    );
    const combo = res.combos.find((c) => c.type === 'MANY_RECEIPTS_ONE_ORDER');
    expect(combo).toBeDefined();
    expect(combo).toMatchObject({
      receiptIds: ['r1', 'r2'],
      orderIds: ['o1'],
      totalCents: 100_000,
      confidence: 'MEDIUM',
    });
    expect(combo?.parts).toEqual([
      { receiptId: 'r1', orderId: 'o1', amountCents: 30_000 },
      { receiptId: 'r2', orderId: 'o1', amountCents: 70_000 },
    ]);
    expect(combo?.reasons).toEqual(
      expect.arrayContaining(['AMOUNT_SUM_EXACT', 'SAME_PAYER', 'SAME_DAY', 'REMARK_HAS_PASSENGER_NAME']),
    );
  });

  it('同付款人但订单与付款人无身份关联 → LOW', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'r1', remainingCents: 30_000, payerNote: '王芳' }),
        receipt({ id: 'r2', remainingCents: 70_000, payerNote: '王芳' }),
      ],
      [order({ orderId: 'o1', contactName: '陌生人', balanceDueCents: 100_000 })],
    );
    expect(res.combos[0]).toMatchObject({ type: 'MANY_RECEIPTS_ONE_ORDER', confidence: 'LOW' });
  });

  it('不同北京日的两笔不凑（同一 UTC 日但跨北京零点也不凑）', () => {
    // 2026-08-31 23:30 北京 vs 2026-09-01 00:30 北京
    const res = matchReceipts(
      [
        receipt({ id: 'r1', remainingCents: 30_000, payerNote: '王芳', receivedAt: new Date('2026-08-31T15:30:00.000Z') }),
        receipt({ id: 'r2', remainingCents: 70_000, payerNote: '王芳', receivedAt: new Date('2026-08-31T16:30:00.000Z') }),
      ],
      [order({ orderId: 'o1', contactName: '王芳', balanceDueCents: 100_000 })],
    );
    expect(res.combos.filter((c) => c.type === 'MANY_RECEIPTS_ONE_ORDER')).toEqual([]);
  });

  it('同代理三笔凑一单：只推荐该代理的订单，不推荐同额的别家订单', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'r1', remainingCents: 10_000, payerNote: '阳光旅行社' }),
        receipt({ id: 'r2', remainingCents: 20_000, payerNote: '阳光旅行社' }),
        receipt({ id: 'r3', remainingCents: 30_000, payerNote: '阳光旅行社' }),
      ],
      [
        order({ orderId: 'mine', agentId: 'a1', agentNames: ['阳光旅行社有限公司'], balanceDueCents: 60_000 }),
        order({ orderId: 'other', agentId: 'a2', agentNames: ['月光旅行社'], balanceDueCents: 60_000 }),
      ],
    );
    const combos = res.combos.filter((c) => c.type === 'MANY_RECEIPTS_ONE_ORDER');
    const targets = combos.map((c) => c.orderIds[0]);
    expect(targets).toContain('mine');
    // 「别家」订单只能靠同付款人桶命中，而该桶对 other 无身份关联 → LOW；同代理桶的 mine → MEDIUM
    const mine = combos.find((c) => c.orderIds[0] === 'mine');
    expect(mine).toMatchObject({ confidence: 'MEDIUM', receiptIds: ['r1', 'r2', 'r3'] });
    expect(mine?.reasons).toEqual(expect.arrayContaining(['SAME_AGENT', 'PAYER_MATCHES_AGENT']));
  });

  it('超过 comboMaxParts 的组合不枚举（4 笔凑一单不出现）', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'r1', remainingCents: 10_000, payerNote: '王芳' }),
        receipt({ id: 'r2', remainingCents: 20_000, payerNote: '王芳' }),
        receipt({ id: 'r3', remainingCents: 30_000, payerNote: '王芳' }),
        receipt({ id: 'r4', remainingCents: 40_000, payerNote: '王芳' }),
      ],
      [order({ orderId: 'o1', contactName: '王芳', balanceDueCents: 100_000 })],
    );
    expect(res.combos.filter((c) => c.type === 'MANY_RECEIPTS_ONE_ORDER')).toEqual([]);
  });

  it('已 HIGH 命中的流水/订单不再参与组合', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'high', remainingCents: 100_000, payerNote: '张三' }),
        receipt({ id: 'r2', remainingCents: 40_000, payerNote: '张三' }),
        receipt({ id: 'r3', remainingCents: 60_000, payerNote: '张三' }),
      ],
      [order({ orderId: 'o1', contactName: '张三', balanceDueCents: 100_000 })],
    );
    expect(candidatesOf(res, 'high')[0].confidence).toBe('HIGH');
    expect(res.combos).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('matchReceipts · 组合：一笔付多单', () => {
  it('同代理两单尾款之和 == 流水余额 → ONE_RECEIPT_MANY_ORDERS；备注命中代理 → MEDIUM', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 150_000, payerNote: '阳光旅行社 两单' })],
      [
        order({ orderId: 'o1', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 60_000 }),
        order({ orderId: 'o2', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 90_000 }),
        order({ orderId: 'o3', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 10_000 }),
      ],
    );
    const combo = res.combos.find((c) => c.type === 'ONE_RECEIPT_MANY_ORDERS');
    expect(combo).toMatchObject({
      receiptIds: ['r1'],
      orderIds: ['o1', 'o2'],
      totalCents: 150_000,
      confidence: 'MEDIUM',
    });
    expect(combo?.parts).toEqual(
      expect.arrayContaining([
        { receiptId: 'r1', orderId: 'o1', amountCents: 60_000 },
        { receiptId: 'r1', orderId: 'o2', amountCents: 90_000 },
      ]),
    );
    expect(combo?.reasons).toEqual(
      expect.arrayContaining(['AMOUNT_SUM_EXACT', 'SAME_AGENT', 'PAYER_MATCHES_AGENT']),
    );
  });

  it('同代理但备注无任何关联 → LOW', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 150_000 })],
      [
        order({ orderId: 'o1', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 60_000 }),
        order({ orderId: 'o2', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 90_000 }),
      ],
    );
    expect(res.combos[0]).toMatchObject({ type: 'ONE_RECEIPT_MANY_ORDERS', confidence: 'LOW' });
  });

  it('散客同联系人手机的多单也能凑（SAME_CONTACT）', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 50_000, payerNote: '尾号5678' })],
      [
        order({ orderId: 'o1', contactPhone: '13812345678', balanceDueCents: 20_000 }),
        order({ orderId: 'o2', contactPhone: '13812345678', balanceDueCents: 30_000 }),
      ],
    );
    const combo = res.combos.find((c) => c.type === 'ONE_RECEIPT_MANY_ORDERS');
    expect(combo).toMatchObject({ orderIds: ['o1', 'o2'], confidence: 'MEDIUM' });
    expect(combo?.reasons).toEqual(expect.arrayContaining(['SAME_CONTACT', 'PHONE_TAIL']));
  });

  it('不同代理的订单不凑', () => {
    const res = matchReceipts(
      [receipt({ id: 'r1', remainingCents: 150_000 })],
      [
        order({ orderId: 'o1', agentId: 'a1', balanceDueCents: 60_000 }),
        order({ orderId: 'o2', agentId: 'a2', balanceDueCents: 90_000 }),
      ],
    );
    expect(res.combos).toEqual([]);
  });

  it('组合总数受 maxCombos 截断，MEDIUM 排在 LOW 前', () => {
    const res = matchReceipts(
      [
        receipt({ id: 'r1', remainingCents: 150_000, payerNote: '阳光' }),
        receipt({ id: 'r2', remainingCents: 150_000 }),
        receipt({ id: 'r3', remainingCents: 150_000 }),
      ],
      [
        order({ orderId: 'o1', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 60_000 }),
        order({ orderId: 'o2', agentId: 'a1', agentNames: ['阳光旅行社'], balanceDueCents: 90_000 }),
      ],
      { maxCombos: 2 },
    );
    expect(res.combos).toHaveLength(2);
    expect(res.combos[0]).toMatchObject({ receiptIds: ['r1'], confidence: 'MEDIUM' });
    expect(res.combos[1].confidence).toBe('LOW');
  });
});
