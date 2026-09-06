/**
 * 订单状态集合 · 对称性断言（vitest）
 *
 * 把 14 处副本合成一份之后，各集合之间「一直靠人肉维持」的约定在这里钉成断言：
 *   · 占座 ∪ 释放 = 全部状态、占座 ∩ 释放 = ∅（口径决议 2026-08「座位口径」）
 *   · 财务口径 = 库存口径 + REFUND_REQUESTED（两者的差恰好只有它）
 *   · 取消族终态 = 释放型 − {DRAFT, REFUND_REQUESTED}
 *   · 三个「已付款」集合的差异逐条钉住（它们**不一样**是现状，待拍板，不许悄悄合并）
 *   · 每个数组的元素顺序快照（Prisma in: 不关心顺序，但 where 子句日志/快照要字节一致）
 * 任何一条断言翻红，都意味着有人改了某一份口径而没改另一份——那正是本模块要消灭的事故。
 */
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import { FUNDS_CREDIT_BLOCKED_STATUSES } from './funds-guard.js';
import {
  AGENT_STATS_PAID_STATUSES,
  ALL_ORDER_STATUSES,
  COUNTED_STATUSES,
  FULFILLMENT_TERMINATING_STATUSES,
  INVENTORY_COUNTED_STATUSES,
  PAID_LIKE_STATUSES,
  PAID_STATUSES,
  RECEIVABLE_STATUSES,
  REFUND_FAMILY_STATUSES,
  SEAT_HOLDING_STATUSES,
  SEAT_RELEASING_STATUSES,
  statusIn,
} from './order-status-sets.js';

const asSet = (xs: readonly OrderStatus[]): Set<OrderStatus> => new Set(xs);
const sorted = (xs: Iterable<OrderStatus>): OrderStatus[] => [...xs].sort();
const minus = (a: readonly OrderStatus[], b: readonly OrderStatus[]): OrderStatus[] =>
  sorted(a.filter((s) => !b.includes(s)));

describe('订单状态集合 · 全集与去重', () => {
  it('OrderStatus 枚举恰好 13 个值，且每个集合内部无重复', () => {
    expect(ALL_ORDER_STATUSES).toHaveLength(13);
    for (const set of [
      SEAT_HOLDING_STATUSES,
      SEAT_RELEASING_STATUSES,
      COUNTED_STATUSES,
      FULFILLMENT_TERMINATING_STATUSES,
      REFUND_FAMILY_STATUSES,
      PAID_LIKE_STATUSES,
      PAID_STATUSES,
      AGENT_STATS_PAID_STATUSES,
      RECEIVABLE_STATUSES,
    ]) {
      expect(asSet(set).size).toBe(set.length);
      for (const s of set) expect(ALL_ORDER_STATUSES).toContain(s);
    }
  });
});

describe('订单状态集合 · 占座 / 释放对称（口径决议 2026-08 座位口径）', () => {
  it('SEAT_HOLDING ∪ SEAT_RELEASING = 全部 13 个状态', () => {
    expect(sorted([...SEAT_HOLDING_STATUSES, ...SEAT_RELEASING_STATUSES])).toEqual(
      sorted(ALL_ORDER_STATUSES),
    );
  });

  it('SEAT_HOLDING ∩ SEAT_RELEASING = ∅', () => {
    const holding = asSet(SEAT_HOLDING_STATUSES);
    expect(SEAT_RELEASING_STATUSES.filter((s) => holding.has(s))).toEqual([]);
  });

  it('DRAFT 归释放型（force H→DRAFT→PAID 不能把 sold 做爆）', () => {
    expect(SEAT_RELEASING_STATUSES).toContain(OrderStatus.DRAFT);
    expect(SEAT_HOLDING_STATUSES).not.toContain(OrderStatus.DRAFT);
  });
});

describe('订单状态集合 · 库存口径 vs 财务口径', () => {
  it('INVENTORY_COUNTED 就是 SEAT_HOLDING 同一份数组（进导出 ⟺ 占库存）', () => {
    expect(INVENTORY_COUNTED_STATUSES).toBe(SEAT_HOLDING_STATUSES);
  });

  it('COUNTED − INVENTORY_COUNTED = {REFUND_REQUESTED}，反向差为空', () => {
    expect(minus(COUNTED_STATUSES, INVENTORY_COUNTED_STATUSES)).toEqual([OrderStatus.REFUND_REQUESTED]);
    expect(minus(INVENTORY_COUNTED_STATUSES, COUNTED_STATUSES)).toEqual([]);
  });

  it('COUNTED 明确排除 REFUNDED（财务概览对它单独补负项）与取消族', () => {
    for (const s of [OrderStatus.REFUNDED, OrderStatus.CANCELLED, OrderStatus.PAYMENT_TIMEOUT, OrderStatus.FAILED, OrderStatus.DRAFT]) {
      expect(COUNTED_STATUSES).not.toContain(s);
    }
  });
});

describe('订单状态集合 · 取消族 / 退款族 / 资金闸', () => {
  it('FULFILLMENT_TERMINATING = SEAT_RELEASING − {DRAFT, REFUND_REQUESTED}', () => {
    expect(sorted(FULFILLMENT_TERMINATING_STATUSES)).toEqual(
      minus(SEAT_RELEASING_STATUSES, [OrderStatus.DRAFT, OrderStatus.REFUND_REQUESTED]),
    );
  });

  it('REFUND_FAMILY ⊂ SEAT_RELEASING（退款申请那一刻即释放）', () => {
    for (const s of REFUND_FAMILY_STATUSES) expect(SEAT_RELEASING_STATUSES).toContain(s);
  });

  it('资金入账闸 FUNDS_CREDIT_BLOCKED = SEAT_RELEASING − {FAILED}（写侧口径，另一份文件，关系钉住）', () => {
    expect(sorted(FUNDS_CREDIT_BLOCKED_STATUSES)).toEqual(minus(SEAT_RELEASING_STATUSES, [OrderStatus.FAILED]));
  });
});

describe('订单状态集合 · 三个「已付款」与应收口径（差异是现状，待拍板，不许合并）', () => {
  it('PAID_LIKE = SEAT_HOLDING − {PENDING_PAYMENT}', () => {
    expect(sorted(PAID_LIKE_STATUSES)).toEqual(minus(SEAT_HOLDING_STATUSES, [OrderStatus.PENDING_PAYMENT]));
  });

  it('PAID = PAID_LIKE − {CHANGE_REQUESTED, CHANGED}（客户档案 / 结算单 GMV）', () => {
    expect(sorted(PAID_STATUSES)).toEqual(
      minus(PAID_LIKE_STATUSES, [OrderStatus.CHANGE_REQUESTED, OrderStatus.CHANGED]),
    );
  });

  it('AGENT_STATS_PAID = PAID − {PROCESSING}（代理成交额）', () => {
    expect(sorted(AGENT_STATS_PAID_STATUSES)).toEqual(minus(PAID_STATUSES, [OrderStatus.PROCESSING]));
  });

  it('RECEIVABLE = SEAT_HOLDING − {COMPLETED}（已完成不再催款）', () => {
    expect(sorted(RECEIVABLE_STATUSES)).toEqual(minus(SEAT_HOLDING_STATUSES, [OrderStatus.COMPLETED]));
  });
});

describe('订单状态集合 · 元素顺序快照（逐字沿用各处原定义）', () => {
  it('每个数组的字面顺序', () => {
    expect({
      SEAT_HOLDING_STATUSES,
      SEAT_RELEASING_STATUSES,
      COUNTED_STATUSES,
      FULFILLMENT_TERMINATING_STATUSES,
      REFUND_FAMILY_STATUSES,
      PAID_LIKE_STATUSES,
      PAID_STATUSES,
      AGENT_STATS_PAID_STATUSES,
      RECEIVABLE_STATUSES,
    }).toMatchInlineSnapshot(`
      {
        "AGENT_STATS_PAID_STATUSES": [
          "PAID",
          "TICKETED",
          "COMPLETED",
        ],
        "COUNTED_STATUSES": [
          "PENDING_PAYMENT",
          "PAID",
          "PROCESSING",
          "TICKETED",
          "COMPLETED",
          "REFUND_REQUESTED",
          "CHANGE_REQUESTED",
          "CHANGED",
        ],
        "FULFILLMENT_TERMINATING_STATUSES": [
          "CANCELLED",
          "REFUNDED",
          "PAYMENT_TIMEOUT",
          "FAILED",
        ],
        "PAID_LIKE_STATUSES": [
          "PAID",
          "PROCESSING",
          "TICKETED",
          "COMPLETED",
          "CHANGE_REQUESTED",
          "CHANGED",
        ],
        "PAID_STATUSES": [
          "PAID",
          "PROCESSING",
          "TICKETED",
          "COMPLETED",
        ],
        "RECEIVABLE_STATUSES": [
          "PENDING_PAYMENT",
          "PAID",
          "PROCESSING",
          "TICKETED",
          "CHANGE_REQUESTED",
          "CHANGED",
        ],
        "REFUND_FAMILY_STATUSES": [
          "REFUND_REQUESTED",
          "REFUNDED",
        ],
        "SEAT_HOLDING_STATUSES": [
          "PENDING_PAYMENT",
          "PAID",
          "PROCESSING",
          "TICKETED",
          "COMPLETED",
          "CHANGE_REQUESTED",
          "CHANGED",
        ],
        "SEAT_RELEASING_STATUSES": [
          "CANCELLED",
          "PAYMENT_TIMEOUT",
          "REFUNDED",
          "FAILED",
          "DRAFT",
          "REFUND_REQUESTED",
        ],
      }
    `);
  });
});

describe('订单状态集合 · statusIn', () => {
  it('string 与枚举值都能判，未知串为 false', () => {
    expect(statusIn(SEAT_HOLDING_STATUSES, 'PAID')).toBe(true);
    expect(statusIn(SEAT_HOLDING_STATUSES, OrderStatus.CANCELLED)).toBe(false);
    expect(statusIn(SEAT_HOLDING_STATUSES, 'NOPE')).toBe(false);
  });
});
