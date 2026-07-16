/**
 * 出纳「预期到账金额」入参校验 · schema 单测（vitest，不依赖 DB）
 *
 * 背景：PATCH /orders/:id/expected-amount 原本收裸 `z.number().nullable()` —— 无 min/max/finite，
 * 负数、Infinity、三位小数、天文数字全部放行，只在 Decimal(12,2) 写库那层炸成 500。
 * 本组用例锁住加界后的行为：schema 层拒绝（路由 .parse 抛 ZodError → 全局 error-handler 转 400），
 * 不再让脏值走到 DB。
 *
 * 端点鉴权（仅运营/管理员可改、锁定后仅管理员可改）与审计落库属全链路口径，不在本文件覆盖。
 */
import { describe, it, expect } from 'vitest';
import { EXPECTED_AMOUNT_CAP_CNY, expectedAmountBodySchema } from './orders.routes.js';

const parse = (amountCny: unknown) => expectedAmountBodySchema.safeParse({ amountCny });

describe('expectedAmountBodySchema — 放行的合法值', () => {
  it('null 放行：清空预期到账是合法操作（出纳撤回已填值）', () => {
    const r = parse(null);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amountCny).toBeNull();
  });

  it('正常整数金额放行', () => {
    const r = parse(28_800);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amountCny).toBe(28_800);
  });

  it('两位小数放行（Decimal(12,2) 的合法精度）', () => {
    const r = parse(1234.56);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amountCny).toBe(1234.56);
  });

  it('一位小数放行', () => {
    expect(parse(99.5).success).toBe(true);
  });

  it('0 放行：整单全额抵扣/全额减免时预期到账为 0，是真实业务值', () => {
    expect(parse(0).success).toBe(true);
  });

  it('恰好等于上限放行（边界含端点）', () => {
    expect(parse(EXPECTED_AMOUNT_CAP_CNY).success).toBe(true);
  });
});

describe('expectedAmountBodySchema — 拒绝的脏值', () => {
  it('负数 → 拒绝', () => {
    const r = parse(-1);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('不能为负数');
  });

  it('大额负数 → 拒绝', () => {
    expect(parse(-28_800).success).toBe(false);
  });

  it('NaN → 拒绝', () => {
    expect(parse(Number.NaN).success).toBe(false);
  });

  it('Infinity → 拒绝', () => {
    expect(parse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('-Infinity → 拒绝', () => {
    expect(parse(Number.NEGATIVE_INFINITY).success).toBe(false);
  });

  it('三位小数 → 拒绝（Decimal(12,2) 存不下，原本会被静默截断或报 500）', () => {
    const r = parse(100.005);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('两位小数');
  });

  it('超上限 → 拒绝', () => {
    const r = parse(EXPECTED_AMOUNT_CAP_CNY + 1);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('超出上限');
  });

  it('天文数字（多打几个 0 / 误按「分」填）→ 拒绝，不再等 DB 炸', () => {
    expect(parse(9_999_999_999).success).toBe(false);
  });

  it('非数字类型 → 拒绝', () => {
    expect(parse('28800').success).toBe(false);
    expect(parse(undefined).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });
});

describe('EXPECTED_AMOUNT_CAP_CNY 口径', () => {
  it('上限 = 订单结构上限（20 行 × 20 人/行 × 10 万/人），且远在 Decimal(12,2) 物理上限内', () => {
    expect(EXPECTED_AMOUNT_CAP_CNY).toBe(20 * 20 * 100_000);
    expect(EXPECTED_AMOUNT_CAP_CNY).toBeLessThan(9_999_999_999.99);
  });
});
