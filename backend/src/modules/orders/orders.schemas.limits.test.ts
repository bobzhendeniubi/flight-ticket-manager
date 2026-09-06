/**
 * orders.schemas · 金额上限 / 批量上限 / 布尔查询参数回归测试（vitest）
 *
 * 覆盖：
 *   B-13  批量开票单次上限：口径决议（2026-07-08）要求 50，此前代码误抄成 100
 *   C-16  addGroundItemBodySchema.unitPriceCny 此前无上限，手滑多打几个 0 会在写库时
 *         炸 500；照 updateItemSettlementPriceBodySchema 同款上限补上
 *   C-28  unclaimedOnly 此前是 z.coerce.boolean()（"false" 非空串会被判 true 的反模式），
 *         改成跟 invoiced 字段一样显式只认 'true'/'false'
 */
import { describe, expect, it } from 'vitest';
import {
  addGroundItemBodySchema,
  batchSetInvoiceFlagsBodySchema,
  listOrdersQuerySchema,
  SETTLEMENT_PRICE_CAP_CNY,
} from './orders.schemas.js';

describe('batchSetInvoiceFlagsBodySchema · orderIds 上限（B-13）', () => {
  it('50 个 orderIds → 通过', () => {
    const orderIds = Array.from({ length: 50 }, (_, i) => `o${i}`);
    expect(() =>
      batchSetInvoiceFlagsBodySchema.parse({ orderIds, flags: { outboundInvoiced: true } }),
    ).not.toThrow();
  });

  it('51 个 orderIds → 拒绝（口径决议 2026-07-08：批量开票单次上限 50）', () => {
    const orderIds = Array.from({ length: 51 }, (_, i) => `o${i}`);
    expect(() =>
      batchSetInvoiceFlagsBodySchema.parse({ orderIds, flags: { outboundInvoiced: true } }),
    ).toThrow();
  });
});

describe('addGroundItemBodySchema.unitPriceCny · 金额上限（C-16）', () => {
  it('等于上限 → 通过', () => {
    expect(() =>
      addGroundItemBodySchema.parse({
        kind: 'VISA',
        visaId: 'v1',
        unitPriceCny: SETTLEMENT_PRICE_CAP_CNY,
      }),
    ).not.toThrow();
  });

  it('超出上限（手滑多打几个 0）→ 拒绝，而不是留到写库时炸 500', () => {
    expect(() =>
      addGroundItemBodySchema.parse({
        kind: 'VISA',
        visaId: 'v1',
        unitPriceCny: 99_999_999_999,
      }),
    ).toThrow();
  });

  it('未传 unitPriceCny（服务端按产品成本价带出）仍然合法', () => {
    expect(() =>
      addGroundItemBodySchema.parse({ kind: 'VISA', visaId: 'v1' }),
    ).not.toThrow();
  });
});

describe('listOrdersQuerySchema.unclaimedOnly · 布尔解析（C-28）', () => {
  it('未传 → undefined（不过滤）', () => {
    expect(listOrdersQuerySchema.parse({}).unclaimedOnly).toBeUndefined();
  });

  it("字符串 'true' → true", () => {
    expect(listOrdersQuerySchema.parse({ unclaimedOnly: 'true' }).unclaimedOnly).toBe(true);
  });

  it("字符串 'false' → false（此前 z.coerce.boolean 会误判成 true）", () => {
    expect(listOrdersQuerySchema.parse({ unclaimedOnly: 'false' }).unclaimedOnly).toBe(false);
  });

  it('原生布尔 true/false 直通', () => {
    expect(listOrdersQuerySchema.parse({ unclaimedOnly: true }).unclaimedOnly).toBe(true);
    expect(listOrdersQuerySchema.parse({ unclaimedOnly: false }).unclaimedOnly).toBe(false);
  });
});
