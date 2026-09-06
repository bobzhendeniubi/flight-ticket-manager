/**
 * 发票 · 状态机与 RBAC 单测（mock Prisma，不依赖真 DB）
 *
 * ⚠️ 这里的「发票」是给客户 / 代理开的真发票。订单上 outboundInvoiced / returnInvoiced /
 *    systemInvoiced 三个布尔位是票务岗的**出票**进度，本模块从不读也从不写它们
 *    （那一侧的测试在 orders.batch-invoice-flags.test.ts）。两件事只是中文撞了名字。
 *
 * 钉的是三处一改就出事的地方：
 *   1. 状态机终局唯一 —— 已开具不能再开（会多出一个票号），已作废不能复活。
 *   2. 归属闸 —— 代理只能给自家单申请；解析不出 agentId 的代理账号必须看不到任何东西，
 *      绝不 fail-open 成「全部」。
 *   3. 金额口径 —— 开票金额 = 应收 = total + adjustmentCny，且永远由服务端算。
 */
import { describe, expect, it, vi } from 'vitest';
import { InvoiceRecordStatus, InvoiceType, Prisma, UserRole } from '@prisma/client';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  ACTIVE_INVOICE_STATUSES,
  assertOrdersOwned,
  assertTaxNoForType,
  canIssue,
  canVoid,
  invoiceScopeWhere,
  isFinanceSide,
  orderInvoiceableCny,
  type InvoiceRequester,
} from './invoices.service.js';

const financeStaff: InvoiceRequester = { userId: 'usr_staff', role: UserRole.STAFF };
const admin: InvoiceRequester = { userId: 'usr_admin', role: UserRole.ADMIN };
const agentA: InvoiceRequester = { userId: 'usr_a', role: UserRole.AGENT, agentId: 'agt_a' };
const agentB: InvoiceRequester = { userId: 'usr_b', role: UserRole.AGENT, agentId: 'agt_b' };
/** 数据异常：AGENT 账号没解析出 agentId（比如 Agent 记录被删了） */
const agentOrphan: InvoiceRequester = { userId: 'usr_x', role: UserRole.AGENT };
const customer: InvoiceRequester = { userId: 'usr_c', role: UserRole.CUSTOMER };

const orderOfAgentA = {
  id: 'ord_a',
  orderNumber: 'FTM20260900001',
  agentId: 'agt_a',
  userId: 'usr_buyer',
};
const orderOfAgentB = {
  id: 'ord_b',
  orderNumber: 'FTM20260900002',
  agentId: 'agt_b',
  userId: 'usr_other',
};
const orderOfCustomer = {
  id: 'ord_c',
  orderNumber: 'FTM20260900003',
  agentId: null,
  userId: 'usr_c',
};

describe('canIssue / canVoid —— 三态状态机，终局唯一', () => {
  it('只有待开具能开具', () => {
    expect(canIssue(InvoiceRecordStatus.REQUESTED)).toBe(true);
    expect(canIssue(InvoiceRecordStatus.ISSUED)).toBe(false);
    expect(canIssue(InvoiceRecordStatus.VOID)).toBe(false);
  });

  it('待开具与已开具都能作废；已作废是终局', () => {
    expect(canVoid(InvoiceRecordStatus.REQUESTED)).toBe(true);
    expect(canVoid(InvoiceRecordStatus.ISSUED)).toBe(true);
    expect(canVoid(InvoiceRecordStatus.VOID)).toBe(false);
  });

  it('作废之后既开不了也再作废不了 —— 客户只能重新申请', () => {
    expect(canIssue(InvoiceRecordStatus.VOID)).toBe(false);
    expect(canVoid(InvoiceRecordStatus.VOID)).toBe(false);
  });

  it('「还占着订单」的是待开具与已开具两态，作废的不占', () => {
    expect(ACTIVE_INVOICE_STATUSES).toEqual([
      InvoiceRecordStatus.REQUESTED,
      InvoiceRecordStatus.ISSUED,
    ]);
    expect(ACTIVE_INVOICE_STATUSES).not.toContain(InvoiceRecordStatus.VOID);
  });
});

describe('assertTaxNoForType —— 专票税号闸', () => {
  it('专票没税号直接拒（挡在申请那一步，别等财务开到一半才发现开不出来）', () => {
    expect(() => assertTaxNoForType(InvoiceType.VAT_SPECIAL, null)).toThrow();
    expect(() => assertTaxNoForType(InvoiceType.VAT_SPECIAL, '')).toThrow();
    expect(() => assertTaxNoForType(InvoiceType.VAT_SPECIAL, '   ')).toThrow();
  });

  it('专票有税号放行', () => {
    expect(() => assertTaxNoForType(InvoiceType.VAT_SPECIAL, '91000000MA000000XX')).not.toThrow();
  });

  it('普票与收据不要求税号', () => {
    expect(() => assertTaxNoForType(InvoiceType.VAT_GENERAL, null)).not.toThrow();
    expect(() => assertTaxNoForType(InvoiceType.RECEIPT, null)).not.toThrow();
  });
});

describe('invoiceScopeWhere —— 列表可见范围', () => {
  it('财务侧（ADMIN / STAFF）看全部', () => {
    expect(isFinanceSide(UserRole.ADMIN)).toBe(true);
    expect(isFinanceSide(UserRole.STAFF)).toBe(true);
    expect(invoiceScopeWhere(admin)).toEqual({});
    expect(invoiceScopeWhere(financeStaff)).toEqual({});
  });

  it('代理只看自己名下 —— 不含下级（抬头税号是各家自己的事）', () => {
    expect(invoiceScopeWhere(agentA)).toEqual({ agentId: 'agt_a' });
  });

  it('解析不出 agentId 的代理账号看不到任何东西，绝不 fail-open 成「全部」', () => {
    const where = invoiceScopeWhere(agentOrphan);
    expect(where).not.toEqual({});
    // 用一个不可能命中的 agentId 兜底，而不是省略条件
    expect(where.agentId).toBe('__no_agent__');
  });

  it('客户只看自己申请的', () => {
    expect(isFinanceSide(UserRole.CUSTOMER)).toBe(false);
    expect(invoiceScopeWhere(customer)).toEqual({ requestedByUserId: 'usr_c' });
  });
});

describe('assertOrdersOwned —— 只能给自家订单申请发票', () => {
  it('代理给自家单申请放行', () => {
    expect(() => assertOrdersOwned([orderOfAgentA], agentA)).not.toThrow();
  });

  it('代理给别家单申请拒绝', () => {
    expect(() => assertOrdersOwned([orderOfAgentB], agentA)).toThrow();
    expect(() => assertOrdersOwned([orderOfAgentA], agentB)).toThrow();
  });

  it('混着一张别家的单 → 整批拒，并把是哪张告诉申请人', () => {
    expect(() => assertOrdersOwned([orderOfAgentA, orderOfAgentB], agentA)).toThrow(
      /FTM20260900002/u,
    );
  });

  it('不做「挑出能开的那几张」—— 那样申请人根本不知道少开了什么', () => {
    // 两张里只有一张是自家的，结果必须是抛错而不是静默只开一张
    let threw = false;
    try {
      assertOrdersOwned([orderOfAgentA, orderOfAgentB], agentA);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('解析不出 agentId 的代理账号一张都申请不了', () => {
    expect(() => assertOrdersOwned([orderOfAgentA], agentOrphan)).toThrow();
  });

  it('客户只能给自己下的单申请', () => {
    expect(() => assertOrdersOwned([orderOfCustomer], customer)).not.toThrow();
    expect(() => assertOrdersOwned([orderOfAgentA], customer)).toThrow();
  });

  it('代理不能借「订单 userId 是我」的路子绕过归属判定', () => {
    // 这张单的 userId 恰好等于代理自己的登录账号，但 agentId 不是它 —— 仍旧拒
    const trap = {
      id: 'ord_t',
      orderNumber: 'FTM20260900009',
      agentId: 'agt_b',
      userId: 'usr_a',
    };
    expect(() => assertOrdersOwned([trap], agentA)).toThrow();
  });

  it('财务侧可以代任意订单申请', () => {
    expect(() =>
      assertOrdersOwned([orderOfAgentA, orderOfAgentB, orderOfCustomer], financeStaff),
    ).not.toThrow();
    expect(() => assertOrdersOwned([orderOfAgentB], admin)).not.toThrow();
  });

  it('空单列表不抛（数量校验是上一道闸的事）', () => {
    expect(() => assertOrdersOwned([], agentA)).not.toThrow();
  });
});

describe('orderInvoiceableCny —— 开票金额口径 = 应收 = total + adjustmentCny', () => {
  it('无调价时就是订单总额', () => {
    expect(orderInvoiceableCny({ total: new Prisma.Decimal('1200.00'), adjustmentCny: 0 })).toBe(
      1200,
    );
  });

  it('加价计入', () => {
    expect(orderInvoiceableCny({ total: new Prisma.Decimal('1200.00'), adjustmentCny: 300 })).toBe(
      1500,
    );
  });

  it('减价（负调价）也计入 —— 开票不能按打折前的数开', () => {
    expect(orderInvoiceableCny({ total: new Prisma.Decimal('1200.00'), adjustmentCny: -200 })).toBe(
      1000,
    );
  });

  it('保留两位', () => {
    expect(orderInvoiceableCny({ total: new Prisma.Decimal('1200.335'), adjustmentCny: 0 })).toBe(
      1200.34,
    );
  });
});
