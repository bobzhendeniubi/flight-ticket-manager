/**
 * 收款对账台 / 挂账池 · 真 DB 集成测试
 *
 * 覆盖（资金关键路径）：
 *   - register → allocate：认领给订单加钱 + 全额翻 PAID + 进账 ALLOCATED
 *   - 部分认领：PARTIALLY_ALLOCATED + remaining 正确
 *   - 超额认领（> remaining）拒绝
 *   - overpay-to-pool：把游客订单的多付移出订单进 OPEN 进账（paidAmount 回压到 total）
 *   - refund：剩余未认领部分标 REFUNDED
 *   - 权限：非 ADMIN/STAFF 走 overpayToPool 被拒
 *   - 公开上传：错 lookupKey 拒；对 lookupKey 建 OPEN 进账且不给订单加钱
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import {
  OrderStatus,
  PaymentMethod,
  ReceiptSource,
  ReceiptStatus,
  UserRole,
  Prisma,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from '../orders/orders.service.js';
import { ReceiptsService } from './receipts.service.js';

const receiptsService = new ReceiptsService();
const orderService = new OrderService();

// ── Fixtures ──────────────────────────────────────────────────────────────
function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createAdminActor() {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 建一个 PENDING_PAYMENT 游客订单（无代理），可设 paidAmount、联系人姓名/电话。 */
async function createGuestOrder(opts: {
  total?: number;
  paidAmount?: number;
  contactName?: string;
  contactPhone?: string;
}) {
  const total = opts.total ?? 1000;
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-RCP'),
      agentId: null,
      status: OrderStatus.PENDING_PAYMENT,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(opts.paidAmount ?? 0),
      contactName: opts.contactName ?? 'WANG MEI',
      contactPhone: opts.contactPhone ?? '13800138000',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试服务项',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
          },
        ],
      },
    },
  });
}

async function registerReceipt(amountCny: number, actor: { userId: string; role: UserRole }) {
  return receiptsService.register(
    { amountCny, method: PaymentMethod.WECHAT_PAY },
    actor,
  );
}

// ══════════════════════════════════════════════════════════════════════════
describe('ReceiptsService.register + allocate · 登记进账并认领到订单', () => {
  it('全额认领：订单 paidAmount += amount + 翻 PAID，进账 ALLOCATED', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    expect(receipt.status).toBe(ReceiptStatus.OPEN);
    expect(receipt.remainingCny).toBe('1000.00');

    const result = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 1000 },
      ADMIN,
    );

    expect(result.ok).toBe(true);
    expect(result.allocatedAmount).toBe(1000);
    expect(result.remainingCny).toBe('0.00');
    expect(result.receiptStatus).toBe(ReceiptStatus.ALLOCATED);
    expect(result.order.fullyPaid).toBe(true);
    expect(result.order.status).toBe(OrderStatus.PAID);

    // 订单真值：paidAmount=1000 + PAID
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
    expect(dbOrder.status).toBe(OrderStatus.PAID);

    // 进账真值：allocatedCny=1000, status ALLOCATED
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(1000);
    expect(dbReceipt.status).toBe(ReceiptStatus.ALLOCATED);

    // 认领明细落库
    const alloc = await prisma.receiptAllocation.findFirst({ where: { receiptId: receipt.id } });
    expect(alloc?.orderId).toBe(order.id);
    expect(Number(alloc?.amountCny)).toBe(1000);

    // 入账产生一笔 SUCCEEDED Payment（复用人工确认收款内核）
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment?.status).toBe('SUCCEEDED');
    expect(Number(payment?.amount)).toBe(1000);
  });

  it('部分认领：进账 PARTIALLY_ALLOCATED + remaining 正确，订单仍 PENDING_PAYMENT', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);

    const result = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 400 },
      ADMIN,
    );
    expect(result.receiptStatus).toBe(ReceiptStatus.PARTIALLY_ALLOCATED);
    expect(result.remainingCny).toBe('600.00');
    expect(result.order.fullyPaid).toBe(false);
    expect(result.order.status).toBe(OrderStatus.PENDING_PAYMENT);

    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(400);
    expect(dbReceipt.status).toBe(ReceiptStatus.PARTIALLY_ALLOCATED);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(400);
    expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it('超额认领（amount > remaining）拒绝，进账与订单都不变', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(500, ADMIN);

    await expect(
      receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 600 }, ADMIN),
    ).rejects.toThrow(/超过进账剩余/);

    // 全有或全无：进账未动，订单未动，无 Payment / 无认领明细
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(0);
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment).toBeNull();
    const alloc = await prisma.receiptAllocation.findFirst({ where: { receiptId: receipt.id } });
    expect(alloc).toBeNull();
  });

  it('认领到不存在订单：整体回滚（进账不变）', async () => {
    const ADMIN = await createAdminActor();
    const receipt = await registerReceipt(500, ADMIN);
    await expect(
      receiptsService.allocate(receipt.id, { orderId: 'no-such-order', amountCny: 100 }, ADMIN),
    ).rejects.toThrow(/订单不存在/);
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(0);
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('OrderService.overpayToPool · 订单超额转挂账池', () => {
  it('游客订单多付 200 → 移出订单进 OPEN 进账，paidAmount 回压到 total', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 1200 });

    const result = await orderService.overpayToPool(order.id, ADMIN);
    expect(result.ok).toBe(true);
    expect(result.movedAmount).toBe(200);
    expect(result.newPaidAmount).toBe(1000);

    // 订单真值：paidAmount 回压到 total（尾款=0）
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);

    // 进账真值：OPEN，来源 ORDER_OVERPAY，金额=200，orderHintId=order.id
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: result.receiptId } });
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);
    expect(dbReceipt.source).toBe(ReceiptSource.ORDER_OVERPAY);
    expect(Number(dbReceipt.amountCny)).toBe(200);
    expect(dbReceipt.orderHintId).toBe(order.id);
  });

  it('拒绝：无多付（paidAmount ≤ total）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 1000 });
    await expect(orderService.overpayToPool(order.id, ADMIN)).rejects.toThrow(/没有多付/);
  });

  it('拒绝：非 ADMIN/STAFF', async () => {
    const order = await createGuestOrder({ total: 1000, paidAmount: 1200 });
    await expect(
      orderService.overpayToPool(order.id, { userId: 'someone', role: UserRole.CUSTOMER }),
    ).rejects.toThrow(/仅运营\/管理员/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('ReceiptsService.refund · 退款剩余未认领部分', () => {
  it('部分认领后退款剩余：进账 REFUNDED，已认领部分留在订单上', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 400 }, ADMIN);

    const result = await receiptsService.refund(receipt.id, '客户多打，退剩余', ADMIN);
    expect(result.ok).toBe(true);
    expect(result.refundedRemainingCny).toBe('600.00');
    expect(result.status).toBe(ReceiptStatus.REFUNDED);

    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(dbReceipt.status).toBe(ReceiptStatus.REFUNDED);
    expect(dbReceipt.refundNote).toBe('客户多打，退剩余');

    // 已认领的 400 留在订单上
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(400);
  });

  it('拒绝：无剩余可退（已全部认领）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 1000 }, ADMIN);
    await expect(receiptsService.refund(receipt.id, 'x', ADMIN)).rejects.toThrow(/无剩余/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('ReceiptsService.allocateBatch · 批量认款（逐组独立事务）', () => {
  it('两组金额吻合：全部成功，各自订单入账 + 进账 ALLOCATED', async () => {
    const ADMIN = await createAdminActor();
    const orderA = await createGuestOrder({ total: 500, paidAmount: 0 });
    const orderB = await createGuestOrder({ total: 800, paidAmount: 0 });
    const rcptA = await registerReceipt(500, ADMIN);
    const rcptB = await registerReceipt(800, ADMIN);

    const res = await receiptsService.allocateBatch(
      [
        { receiptId: rcptA.id, orderId: orderA.id, amountCny: 500 },
        { receiptId: rcptB.id, orderId: orderB.id, amountCny: 800 },
      ],
      ADMIN,
    );

    expect(res.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(res.results.every((r) => r.ok)).toBe(true);

    const dbA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const dbB = await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } });
    expect(Number(dbA.paidAmount)).toBe(500);
    expect(dbA.status).toBe(OrderStatus.PAID);
    expect(Number(dbB.paidAmount)).toBe(800);
    expect(dbB.status).toBe(OrderStatus.PAID);

    const dbRcptA = await prisma.receipt.findUniqueOrThrow({ where: { id: rcptA.id } });
    const dbRcptB = await prisma.receipt.findUniqueOrThrow({ where: { id: rcptB.id } });
    expect(dbRcptA.status).toBe(ReceiptStatus.ALLOCATED);
    expect(dbRcptB.status).toBe(ReceiptStatus.ALLOCATED);
  });

  it('某组失败（订单不存在）不影响其它组：成功组入账、失败组进账不变', async () => {
    const ADMIN = await createAdminActor();
    const orderOk = await createGuestOrder({ total: 500, paidAmount: 0 });
    const rcptOk = await registerReceipt(500, ADMIN);
    const rcptBad = await registerReceipt(300, ADMIN);

    const res = await receiptsService.allocateBatch(
      [
        { receiptId: rcptOk.id, orderId: orderOk.id, amountCny: 500 },
        { receiptId: rcptBad.id, orderId: 'no-such-order', amountCny: 300 },
      ],
      ADMIN,
    );

    expect(res.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    const okItem = res.results.find((r) => r.receiptId === rcptOk.id);
    const badItem = res.results.find((r) => r.receiptId === rcptBad.id);
    expect(okItem?.ok).toBe(true);
    expect(badItem?.ok).toBe(false);

    // 成功组：订单入账 + 进账 ALLOCATED
    const dbOk = await prisma.receipt.findUniqueOrThrow({ where: { id: rcptOk.id } });
    expect(dbOk.status).toBe(ReceiptStatus.ALLOCATED);
    const dbOrderOk = await prisma.order.findUniqueOrThrow({ where: { id: orderOk.id } });
    expect(Number(dbOrderOk.paidAmount)).toBe(500);

    // 失败组：进账原封不动（OPEN，无认领明细）
    const dbBad = await prisma.receipt.findUniqueOrThrow({ where: { id: rcptBad.id } });
    expect(dbBad.status).toBe(ReceiptStatus.OPEN);
    expect(Number(dbBad.allocatedCny)).toBe(0);
    const badAlloc = await prisma.receiptAllocation.findFirst({ where: { receiptId: rcptBad.id } });
    expect(badAlloc).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('ReceiptsService.list · 到账日期筛选（receivedAt）', () => {
  it('过去区间不含今天登记的进账；含今天的宽区间则包含', async () => {
    const ADMIN = await createAdminActor();
    const receipt = await registerReceipt(1000, ADMIN);

    // 纯过去区间：今天登记的进账不应出现
    const past = await receiptsService.list({ from: '2000-01-01', to: '2000-01-02' });
    expect(past.some((r) => r.id === receipt.id)).toBe(false);

    // 覆盖今天的宽区间：应出现
    const wide = await receiptsService.list({ from: '2000-01-01', to: '2999-12-31' });
    expect(wide.some((r) => r.id === receipt.id)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('ReceiptsService.matchCandidates · 关键词 + 下单日期筛选', () => {
  it('关键词命中联系人姓名；不命中则不返回', async () => {
    const uniqueName = `CONTACTSEARCH${Date.now()}`;
    const order = await createGuestOrder({ total: 1000, paidAmount: 0, contactName: uniqueName });

    const hit = await receiptsService.matchCandidates({ q: uniqueName });
    expect(hit.some((o) => o.orderId === order.id)).toBe(true);

    const miss = await receiptsService.matchCandidates({ q: 'NOSUCHCONTACTNAME_XYZ' });
    expect(miss.some((o) => o.orderId === order.id)).toBe(false);
  });

  it('纯过去下单日期区间不含今天的订单', async () => {
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const past = await receiptsService.matchCandidates({ from: '2000-01-01', to: '2000-01-02' });
    expect(past.some((o) => o.orderId === order.id)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('公开上传付款凭证 · 门禁 + 仅声明不入账', () => {
  const PROOF = 'data:image/png;base64,SGVsbG8=';

  it('错 lookupKey → 门禁不命中（返回 null），不建进账', async () => {
    const order = await createGuestOrder({
      total: 1000,
      paidAmount: 0,
      contactName: 'WANG MEI',
      contactPhone: '13800138000',
    });
    const match = await orderService.lookupOrderForReceiptUpload(order.orderNumber, '错误的key');
    expect(match).toBeNull();
  });

  it('对 lookupKey（姓氏）→ 命中，建 OPEN 进账且不给订单加钱', async () => {
    const order = await createGuestOrder({
      total: 1000,
      paidAmount: 0,
      contactName: 'WANG MEI',
      contactPhone: '13800138000',
    });

    // 姓氏命中（WANG）
    const match = await orderService.lookupOrderForReceiptUpload(order.orderNumber, 'WANG');
    expect(match).not.toBeNull();
    expect(match?.orderId).toBe(order.id);
    expect(match?.balanceCny).toBe(1000); // 应付尾款

    const uploaded = await receiptsService.customerUpload({
      orderId: match!.orderId,
      amountCny: match!.balanceCny,
      method: PaymentMethod.WECHAT_PAY,
      proofUrl: PROOF,
    });
    expect(uploaded.ok).toBe(true);
    expect(uploaded.status).toBe(ReceiptStatus.OPEN);

    // 进账：OPEN, source CUSTOMER_UPLOAD, orderHintId=order, proofUrl 保存
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: uploaded.receiptId } });
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);
    expect(dbReceipt.source).toBe(ReceiptSource.CUSTOMER_UPLOAD);
    expect(dbReceipt.orderHintId).toBe(order.id);
    expect(dbReceipt.proofUrl).toBe(PROOF);

    // 关键：订单未被加钱（仍是声明，未入账）
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    expect(dbOrder.status).toBe(OrderStatus.PENDING_PAYMENT);
    const payment = await prisma.payment.findFirst({ where: { orderId: order.id } });
    expect(payment).toBeNull();
  });

  it('手机号也能命中门禁', async () => {
    const order = await createGuestOrder({
      total: 800,
      paidAmount: 0,
      contactPhone: '13900139000',
    });
    const match = await orderService.lookupOrderForReceiptUpload(order.orderNumber, '13900139000');
    expect(match?.orderId).toBe(order.id);
  });
});
