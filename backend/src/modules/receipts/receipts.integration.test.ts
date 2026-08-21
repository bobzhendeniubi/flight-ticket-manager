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

  /**
   * 超收硬闸：认款入账内核与逐单人工确认收款（confirmManualPayment）共用同一条口径。
   *
   * 内核此前只有防手误上限（总额×10 / 100 万封顶），没有超收闸 —— 认款于是成了一条
   * 能把 paidAmount 无限抬到应收之上的旁路：一笔大额流水反复认到同一张小额订单上，
   * 订单账面凭空多付，多付再往下游喂（多付转余额 / 退款），就是真实资金损失。
   *
   * 认款场景下拒绝不会丢钱：钱本来就躺在挂账池里，只认到应收余额为止，
   * 剩下的留在池子里按挂账处置（退回客户 / 认到别的单）——这正是挂账池存在的意义。
   */
  it('认款会让订单超收 → 拒绝，并告知最多可认多少；进账与订单一分未动', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1500, ADMIN);

    await expect(
      receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 1500 }, ADMIN),
    ).rejects.toThrow(/最多只能认领 ¥1000\.00，超出部分请留在挂账池另行处置/);

    // 全有或全无：进账未动、订单未动、无收款记录、无认领明细
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(0);
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    expect(await prisma.payment.findFirst({ where: { orderId: order.id } })).toBeNull();
    expect(await prisma.receiptAllocation.findFirst({ where: { receiptId: receipt.id } })).toBeNull();
  });

  it('已收满的订单再认一分钱 → 拒绝（重复认款不能把同一张单越认越多）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const first = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(first.id, { orderId: order.id, amountCny: 1000 }, ADMIN);

    const second = await registerReceipt(1000, ADMIN);
    await expect(
      receiptsService.allocate(second.id, { orderId: order.id, amountCny: 1 }, ADMIN),
    ).rejects.toThrow(/会超出应收/);

    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000); // 停在应收，没被越认越多
  });

  it('收满（恰好等于应收）不拦：只拦严格超出', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 400 });
    const receipt = await registerReceipt(600, ADMIN);

    const result = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 600 },
      ADMIN,
    );
    expect(result.order.paidAmount).toBe(1000);
    expect(result.order.fullyPaid).toBe(true);
  });

  it('已完成退款腾出的额度可以再收：净额口径（已付 − 已退）不算超收', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 1000 });
    // 已退给客户 300：净额 700，还能再收 300（退款不减 paidAmount，只翻 Refund 状态）
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: new Prisma.Decimal(300),
        status: 'COMPLETED',
        reason: '部分退款',
      },
    });
    const receipt = await registerReceipt(300, ADMIN);

    const result = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 300 },
      ADMIN,
    );
    expect(result.order.paidAmount).toBe(1300); // 账面 1300 − 已退 300 = 净额 1000 = 应收

    // 再多认一分就超了
    const extra = await registerReceipt(100, ADMIN);
    await expect(
      receiptsService.allocate(extra.id, { orderId: order.id, amountCny: 1 }, ADMIN),
    ).rejects.toThrow(/会超出应收/);
  });

  it('改期费加价（adjustmentCny）计入应收：加价后原本超收的金额变得可认', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 1000 });
    await prisma.order.update({ where: { id: order.id }, data: { adjustmentCny: 200 } });
    const receipt = await registerReceipt(200, ADMIN);

    const result = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 200 },
      ADMIN,
    );
    expect(result.order.paidAmount).toBe(1200);
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
describe('ReceiptsService.reverseAllocation · 撤销认款（认领的逆操作）', () => {
  it('全额认领后撤销：订单已付回退 + 收款冲销 + 进账回 OPEN + 认领明细消失', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    const allocated = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 1000 },
      ADMIN,
    );
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    const result = await receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN);
    expect(result.ok).toBe(true);
    expect(result.reversedAmount).toBe(1000);
    expect(result.remainingCny).toBe('1000.00');
    expect(result.receiptStatus).toBe(ReceiptStatus.OPEN);
    expect(result.order.paidAmount).toBe(0);
    expect(result.order.balanceDue).toBe(1000);
    expect(result.order.stillFullyPaid).toBe(false);
    // 由「已结清」变回「有尾款」→ 明说，不静默
    expect(result.warning).toMatch(/重新产生尾款/);

    // 订单真值：已付回退到 0（状态不回退，佣金/履约不动）
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);

    // 进账真值：allocatedCny 减回 0，状态回 OPEN
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(0);
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);

    // 认领明细已删除；当初那笔收款被冲销（不再计入实收）
    expect(await prisma.receiptAllocation.findUnique({ where: { id: alloc.id } })).toBeNull();
    const dbPayment = await prisma.payment.findUniqueOrThrow({
      where: { id: allocated.order.paymentId },
    });
    expect(dbPayment.status).toBe('REFUNDED');
    expect((dbPayment.gatewayPayload as Record<string, unknown>).reversed).toBe(true);
    expect((dbPayment.gatewayPayload as Record<string, unknown>).reversedAllocationId).toBe(alloc.id);

    // 冲销后进账余额确实回到池子里：可以重新认领给别的订单
    const other = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const reAllocated = await receiptsService.allocate(
      receipt.id,
      { orderId: other.id, amountCny: 1000 },
      ADMIN,
    );
    expect(reAllocated.receiptStatus).toBe(ReceiptStatus.ALLOCATED);
  });

  it('订单已计提代理佣金（尚未冲销）：拒绝撤销认款，钱与进账都不动', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    // 直接挂一条 ACCRUED 佣金记录，模拟认款把单推到 PAID 后整条代理链已计提
    const agentUser = await prisma.user.create({
      data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
    });
    const agent = await prisma.agent.create({
      data: { userId: agentUser.id, contactName: '测试代理', contactPhone: '13900000000' },
    });
    await prisma.commissionRecord.create({
      data: {
        agentId: agent.id,
        orderId: order.id,
        productKind: 'FLIGHT',
        baseAmount: new Prisma.Decimal(1000),
        rate: new Prisma.Decimal(0.05),
        amount: new Prisma.Decimal(50),
      },
    });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 1000 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    await expect(
      receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN),
    ).rejects.toThrow(/已计提代理佣金/);

    // 拒绝后一切不动：订单已付、进账认领、认领明细都保持撤销前状态
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(1000);
    expect(dbReceipt.status).toBe(ReceiptStatus.ALLOCATED);
    expect(await prisma.receiptAllocation.findUnique({ where: { id: alloc.id } })).not.toBeNull();
  });

  it('两笔认领只撤一笔：进账停在 PARTIALLY_ALLOCATED，另一笔订单不受影响', async () => {
    const ADMIN = await createAdminActor();
    const orderA = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const orderB = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: orderA.id, amountCny: 300 }, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: orderB.id, amountCny: 200 }, ADMIN);

    const allocA = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id, orderId: orderA.id },
    });
    const result = await receiptsService.reverseAllocation(receipt.id, allocA.id, ADMIN);
    expect(result.receiptStatus).toBe(ReceiptStatus.PARTIALLY_ALLOCATED);
    expect(result.remainingCny).toBe('800.00');

    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(200);
    expect(dbReceipt.status).toBe(ReceiptStatus.PARTIALLY_ALLOCATED);

    const dbA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    const dbB = await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } });
    expect(Number(dbA.paidAmount)).toBe(0);
    expect(Number(dbB.paidAmount)).toBe(200); // 另一单一分不动
  });

  it('未结清单撤销认款：不产生 warning（本来就有尾款）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(400, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 400 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    const result = await receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN);
    expect(result.warning).toBeNull();
    expect(result.order.paidAmount).toBe(0);
  });

  it('重复撤销：第二次拒绝，金额不会被扣两次', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(500, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 500 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    await receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN);
    await expect(
      receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN),
    ).rejects.toThrow(/认款记录不存在或已撤销/);

    // 幂等：订单已付停在 0，没有被扣成负数
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(0);
  });

  /**
   * 收款复核锁在对账认款这条通道上**进出两侧一律不拦**——这是刻意的对称。
   *
   * 认款入账（_creditOrderPaymentWithinTx）明确不受锁约束：真钱已经到公司账上，必须如实落库。
   * 那撤销就不能反过来受锁：否则出现单向阀门——复核锁定后仍可能有人把一笔流水误认到这张单上
   *（锁拦不住），想撤回时反被 409 挡下，复核锁变成了**保护错误入账**的东西，账面永远错着。
   *
   * 对照组是人工录入那条通道：confirmManualPayment ↔ reverseManualPayment 两侧都受锁（未变）。
   * 同一条通道两侧同一把闸 —— 这才是复核锁该有的样子。
   */
  it('订单收款已锁定：认款与撤销都不受锁约束（同一通道两侧对称）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(600, ADMIN);

    // 先锁定，再认款：锁只拦人工录入，对账认款照进（真钱已到账）
    await prisma.order.update({ where: { id: order.id }, data: { paymentsLocked: true } });
    const allocated = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 600 },
      ADMIN,
    );
    expect(allocated.order.paidAmount).toBe(600);

    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    // 仍在锁定态下撤销：同样放行 —— 认得进来就必须撤得回去
    const lockedStill = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(lockedStill.paymentsLocked).toBe(true);
    const result = await receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN);
    expect(result.order.paidAmount).toBe(0);

    // 撤销是真撤：订单已付回 0、进账回 OPEN、认领明细消失
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(0);
    const dbReceipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(Number(dbReceipt.allocatedCny)).toBe(0);
    expect(dbReceipt.status).toBe(ReceiptStatus.OPEN);
    expect(await prisma.receiptAllocation.findUnique({ where: { id: alloc.id } })).toBeNull();
  });

  it('进账已退款：拒绝撤销（撤回的钱与已退金额会对不上）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 400 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });
    await receiptsService.refund(receipt.id, '剩余部分原路退回', ADMIN);

    await expect(
      receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN),
    ).rejects.toThrow(/已标记退款/);
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(400);
  });

  it('订单已取消：仍可撤销认款，钱回挂账池', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(300, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 300 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CANCELLED },
    });
    const result = await receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN);
    expect(result.order.paidAmount).toBe(0);
    expect(result.receiptStatus).toBe(ReceiptStatus.OPEN);
  });

  it('退款审批中：仍拒绝撤销认款', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(300, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 300 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.REFUND_REQUESTED },
    });
    await expect(
      receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN),
    ).rejects.toThrow(/退款申请中/);
  });

  it('订单已完成退款且撤销后会倒挂：拒绝（退出去的不能多过收进来的）', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 1000 }, ADMIN);
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });
    // 已把 800 退给客户：撤销 1000 会让「已付 0 < 已退 800」
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: new Prisma.Decimal(800),
        status: 'COMPLETED',
        reason: '部分退款',
      },
    });

    await expect(
      receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN),
    ).rejects.toThrow(/账目倒挂/);
    const dbOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(dbOrder.paidAmount)).toBe(1000);
  });

  it('历史认款（收款上没有 allocationId）：按流水号 + 金额兜底定位并冲销', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(700, ADMIN);
    const allocated = await receiptsService.allocate(
      receipt.id,
      { orderId: order.id, amountCny: 700 },
      ADMIN,
    );
    const alloc = await prisma.receiptAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id },
    });
    // 模拟旧数据：抹掉 allocationId，只留 source/receiptNo（老库里就是这个形状）
    const legacy = await prisma.payment.findUniqueOrThrow({
      where: { id: allocated.order.paymentId },
    });
    const payload = { ...(legacy.gatewayPayload as Record<string, unknown>) };
    delete payload.allocationId;
    await prisma.payment.update({
      where: { id: legacy.id },
      data: { gatewayPayload: payload as Prisma.InputJsonValue },
    });

    const result = await receiptsService.reverseAllocation(receipt.id, alloc.id, ADMIN);
    expect(result.order.paidAmount).toBe(0);
    const dbPayment = await prisma.payment.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(dbPayment.status).toBe('REFUNDED');
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

  /**
   * 退款后「未认余额」必须归零，且列表与导出必须同一个口径。
   *
   * refund() 只翻 status、不动 allocatedCny（allocatedCny 的语义是「认领给订单的钱」，
   * 退款不是认领），所以 amount − allocated 仍是正数。这笔钱已经退回客户了，
   * 继续算作待认领 → 财务对核对表「未认余额」列求和，挂账池余额被虚增。
   * 界面 KPI 早就排除了 REFUNDED、导出没排除，两处口径还会互相打架。
   */
  it('退款后：列表与核对表导出的「未认余额」都归零，且已认金额保持诚实', async () => {
    const ADMIN = await createAdminActor();
    const order = await createGuestOrder({ total: 1000, paidAmount: 0 });
    const receipt = await registerReceipt(1000, ADMIN);
    await receiptsService.allocate(receipt.id, { orderId: order.id, amountCny: 300 }, ADMIN);
    await receiptsService.refund(receipt.id, '剩余 700 原路退回', ADMIN);

    // ① 列表口径
    const { receipts, summary } = await receiptsService.list({});
    const listed = receipts.find((r) => r.id === receipt.id);
    expect(listed?.status).toBe(ReceiptStatus.REFUNDED);
    expect(listed?.remainingCny).toBe('0.00');
    // 已认金额不被抬成 1000 —— 那会与「认到订单」只有 ¥300 自相矛盾
    expect(Number(listed?.allocatedCny)).toBe(300);
    // ② 未认领全量聚合不含已退款这笔（挂账余额 KPI 的真值）
    expect(Number(summary.unallocatedRemainingCny)).toBe(0);
    expect(summary.unallocatedCount).toBe(0);

    // ③ 导出口径（此前正是这里把 700 算进「未认余额」合计）
    const wb = await receiptsService.exportStatement({});
    const ws = wb.getWorksheet('流水核对表');
    expect(ws).toBeDefined();
    let remainingCell: unknown = undefined;
    let allocatedCell: unknown = undefined;
    ws!.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell('receiptNo').value === receipt.receiptNo) {
        remainingCell = row.getCell('remainingCny').value;
        allocatedCell = row.getCell('allocatedCny').value;
      }
    });
    expect(remainingCell).toBe(0);
    expect(allocatedCell).toBe(300);
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
    expect(past.receipts.some((r) => r.id === receipt.id)).toBe(false);

    // 覆盖今天的宽区间：应出现
    const wide = await receiptsService.list({ from: '2000-01-01', to: '2999-12-31' });
    expect(wide.receipts.some((r) => r.id === receipt.id)).toBe(true);
    // 未认领聚合与日期过滤同轴：过去区间聚合为空，宽区间含这笔
    expect(past.summary.unallocatedCount).toBe(0);
    expect(wide.summary.unallocatedCount).toBeGreaterThanOrEqual(1);
    expect(Number(wide.summary.unallocatedRemainingCny)).toBeGreaterThanOrEqual(1000);
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
