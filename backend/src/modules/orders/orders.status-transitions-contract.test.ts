/**
 * 状态机真源契约（N8）· 单元测试（vitest）
 *
 * 背景：前端曾手抄一份 ALLOWED_TRANSITIONS，并已漂移四行（PAID / PROCESSING 少 CHANGE_REQUESTED，
 * CHANGE_REQUESTED 少 PAID/PROCESSING，CHANGED 少 PROCESSING/TICKETED）。后果不是「按钮少了」——
 * 是后端合法的流转被前端当成「需要管理员强制」，运营被迫走 force 通道，把正常操作污染成
 * FORCE_ORDER_STATUS + severity:WARNING 的强制审计记录，真正该警觉的强制被淹没。
 *
 * 修法：后端 ALLOWED_TRANSITIONS 是唯一真源，serializeOrder 逐单下发 allowedTransitions，
 * 前端消费同一份、不再手抄。本文件钉死「下发的元数据 === 权威表」这条契约：
 * 只要有人改了状态机而没走 serializeOrder，或 serializeOrder 擅自过滤/改写，这里就红。
 */
import { describe, it, expect, vi } from 'vitest';
import { OrderStatus, Prisma } from '@prisma/client';

// orders.service 顶层引用 prisma —— mock 掉，避免测试连库。
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { ALLOWED_TRANSITIONS, serializeOrder } from './orders.service.js';

const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

/** 构造 serializeOrder 所需的最小订单（只关心 status → allowedTransitions 这条链路）。 */
function buildOrder(status: OrderStatus) {
  return {
    id: 'ord_1',
    orderNumber: 'CO-TEST-1',
    status,
    subtotal: dec(1000),
    taxesAndFees: dec(0),
    discountTotal: dec(0),
    total: dec(1000),
    paidAmount: dec(0),
    prepaymentOffset: dec(0),
    adjustmentCny: 0,
    items: [],
    passengers: [],
  };
}

describe('状态机真源契约 · serializeOrder 下发的 allowedTransitions === 后端权威表', () => {
  const ALL_STATUSES = Object.values(OrderStatus);

  it.each(ALL_STATUSES)('status=%s：下发集合与 ALLOWED_TRANSITIONS 逐条一致', (status) => {
    const out = serializeOrder(buildOrder(status)) as Record<string, unknown>;
    expect(out.allowedTransitions).toEqual(ALLOWED_TRANSITIONS[status]);
  });

  it('权威表覆盖 OrderStatus 枚举的每一个值（新增状态忘了加 → 这里红）', () => {
    for (const status of ALL_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status], `ALLOWED_TRANSITIONS 缺 ${status}`).toBeDefined();
    }
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('终态下发空集（前端据此说明「为何没有可用操作」，而不是渲染空白工具条）', () => {
    for (const status of [OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.REFUNDED]) {
      const out = serializeOrder(buildOrder(status)) as Record<string, unknown>;
      expect(out.allowedTransitions).toEqual([]);
    }
  });

  it('下发的目标状态都是合法的 OrderStatus 值（不会下发前端认不出的字符串）', () => {
    for (const status of ALL_STATUSES) {
      for (const to of ALLOWED_TRANSITIONS[status]) {
        expect(ALL_STATUSES).toContain(to);
      }
    }
  });

  // 漂移回归：这四条正是前端手抄版漏掉的，漏掉就把合法流转逼进 force 通道。
  // 钉死它们仍在权威表里 —— 不是「修正」状态机，是防止有人把它们again抄丢。
  it('回归：出票前（已支付/处理中）可发起改签申请 —— 曾被前端手抄版漏掉', () => {
    expect(ALLOWED_TRANSITIONS[OrderStatus.PAID]).toContain(OrderStatus.CHANGE_REQUESTED);
    expect(ALLOWED_TRANSITIONS[OrderStatus.PROCESSING]).toContain(OrderStatus.CHANGE_REQUESTED);
  });

  it('回归：改签申请可驳回退回出票前流程；改签后可继续走出票 —— 曾被前端手抄版漏掉', () => {
    expect(ALLOWED_TRANSITIONS[OrderStatus.CHANGE_REQUESTED]).toEqual(
      expect.arrayContaining([OrderStatus.PAID, OrderStatus.PROCESSING]),
    );
    expect(ALLOWED_TRANSITIONS[OrderStatus.CHANGED]).toEqual(
      expect.arrayContaining([OrderStatus.PROCESSING, OrderStatus.TICKETED]),
    );
  });
});
