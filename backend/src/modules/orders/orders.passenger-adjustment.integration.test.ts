/**
 * OrderService.addPriceAdjustment（按乘客/整单事后调价 · 0722 公测反馈）· 真 DB 集成测试
 *
 * 覆盖：
 *   - 乘客级调整计入总额：给指定乘客挂差额 → 新增一条 priceAdjustment 行（passengerId 落库）+
 *     subtotal/total 增加 + 尾款反映 + adjustments 审计追加（type=PRICE_ADJUSTMENT、带 passengerId/reasonCode）
 *   - 整单调价回归：不带 passengerId → 差额行 passengerId=NULL、计入 total（与录单整单调价同口径）
 *   - 负调整（优惠）→ kind=DISCOUNT、total 下降
 *   - passengerId 不属于本单 → BadRequestError，不新增任何行、total 不变
 *   - 已取消单（CANCELLED）→ 调价闸放行（assertOrderAllowsPriceAdjustment，运营反馈：
 *     换人/取消手续费本来就靠调价定格，事后改这个数字不涉及收款），整单与按乘客调价均成功、
 *     total 正确更新；已退款/软删单仍拒绝，文案是调价口径（不是收款口径）
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { DocumentType, OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: admin.id, role: UserRole.ADMIN };
}

/** 建一个 PAID 订单：一条 BUNDLE 基础行 + 两位乘客。 */
async function createOrderWithPassengers(total = 6000, paidAmount = 6000) {
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-PADJ'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(paidAmount),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.BUNDLE,
            description: '套餐 3天2晚',
            quantity: 2,
            unitPrice: new Prisma.Decimal(total / 2),
            amount: new Prisma.Decimal(total),
          },
        ],
      },
      passengers: {
        create: [
          {
            fullName: 'LI SI',
            documentType: DocumentType.PASSPORT,
            documentNumber: uniq('P1'),
            dateOfBirth: new Date('1990-01-01'),
            nationality: 'CN',
          },
          {
            fullName: 'WANG WU',
            documentType: DocumentType.PASSPORT,
            documentNumber: uniq('P2'),
            dateOfBirth: new Date('1992-02-02'),
            nationality: 'CN',
          },
        ],
      },
    },
    include: { items: true, passengers: true },
  });
}

describe('OrderService.addPriceAdjustment · 真 DB E2E', () => {
  it('乘客级正调整 → 计入 total + passengerId 落库 + 审计追加', async () => {
    const actor = await adminActor();
    const order = await createOrderWithPassengers(6000, 6000);
    const pax = order.passengers[0];

    const result = await service.addPriceAdjustment(
      order.id,
      { amountCny: 200, reasonCode: 'MISC_FEE', passengerId: pax.id, reasonText: '临时加项' },
      actor,
    );

    // 新增一条 FEE 行，挂在该乘客名下
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(2);
    const fee = items.find((it) => it.kind === OrderItemKind.FEE);
    expect(fee).toBeTruthy();
    expect(fee!.passengerId).toBe(pax.id);
    expect(Number(fee!.amount)).toBe(200);
    const meta = fee!.metadata as Record<string, unknown>;
    expect(meta.priceAdjustment).toBe(true);
    expect(meta.reasonCode).toBe('MISC_FEE');

    // total = 6000 + 200 = 6200；尾款反映
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reloaded.total)).toBe(6200);
    expect(Number(reloaded.subtotal)).toBe(6200);
    expect(result.order.balanceDue).toBe('200'); // 6200 − 6000 paid

    // 审计流水追加 PRICE_ADJUSTMENT（带 passengerId/reasonCode）
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number; passengerId?: string; reasonCode?: string }>;
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('PRICE_ADJUSTMENT');
    expect(log[0].amountCny).toBe(200);
    expect(log[0].passengerId).toBe(pax.id);
    expect(log[0].reasonCode).toBe('MISC_FEE');
  });

  it('整单调价（无 passengerId）→ 差额行 passengerId=NULL，计入 total（回归）', async () => {
    const actor = await adminActor();
    const order = await createOrderWithPassengers(6000, 6000);

    await service.addPriceAdjustment(order.id, { amountCny: -500, reasonCode: 'DISCOUNT' }, actor);

    const fee = await prisma.orderItem.findFirst({
      where: { orderId: order.id, kind: OrderItemKind.DISCOUNT },
    });
    expect(fee).toBeTruthy();
    expect(fee!.passengerId).toBeNull(); // 整单调价：不挂乘客
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reloaded.total)).toBe(5500); // 6000 − 500
  });

  it('passengerId 不属于本单 → BadRequestError，不新增行、total 不变', async () => {
    const actor = await adminActor();
    const orderA = await createOrderWithPassengers();
    const orderB = await createOrderWithPassengers();
    const foreignPax = orderB.passengers[0];

    await expect(
      service.addPriceAdjustment(
        orderA.id,
        { amountCny: 100, reasonCode: 'MISC_FEE', passengerId: foreignPax.id },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);

    const items = await prisma.orderItem.findMany({ where: { orderId: orderA.id } });
    expect(items).toHaveLength(1); // 仍只有原 BUNDLE 行
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    expect(Number(reloaded.total)).toBe(6000);
  });

  // 运营反馈：换人时先把订单调价到只剩手续费金额、再标记「已取消」——已取消单的应收就是这笔
  // 手续费的最终定格，运营事后要能改这个数字（如换人费从 350.5 改成 200）。调价只改应收，
  // 不动 paidAmount，不产生任何收款/退款事实，钱不动。
  it('已取消单整单调价：-150 再 +200 均成功，total 正确更新（换人手续费改价场景）', async () => {
    const actor = await adminActor();
    // 起点：total=6000（模拟换人前的应收）。
    const order = await createOrderWithPassengers(6000, 0);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    // 第一笔：-150（把应收往下调，比如手续费从更高的数改低）。
    const first = await service.addPriceAdjustment(
      order.id,
      { amountCny: -150, reasonCode: 'CHANGE', reasonText: '换人手续费改价' },
      actor,
    );
    expect(first.audit.after.total).toBe('5850'); // 6000 − 150
    const afterFirst = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(afterFirst.total)).toBe(5850);
    expect(afterFirst.status).toBe(OrderStatus.CANCELLED); // 调价不改变订单状态

    // 第二笔：+200（同一张已取消单上再改一次，运营反馈的原始场景就是要能反复改这个数）。
    const second = await service.addPriceAdjustment(
      order.id,
      { amountCny: 200, reasonCode: 'CHANGE', reasonText: '换人手续费改价' },
      actor,
    );
    expect(second.audit.after.total).toBe('6050'); // 5850 + 200
    const afterSecond = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(afterSecond.total)).toBe(6050);

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(3); // 原 BUNDLE 行 + 两条调价行
  });

  it('已取消单按乘客调价同样成功', async () => {
    const actor = await adminActor();
    const order = await createOrderWithPassengers(6000, 0);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    const pax = order.passengers[0];

    const result = await service.addPriceAdjustment(
      order.id,
      { amountCny: 100, reasonCode: 'MISC_FEE', passengerId: pax.id },
      actor,
    );

    expect(result.audit.after.total).toBe('6100');
    const fee = await prisma.orderItem.findFirst({
      where: { orderId: order.id, kind: OrderItemKind.FEE, passengerId: pax.id },
    });
    expect(fee).toBeTruthy();
  });

  it('已退款单（REFUNDED）→ 调价闸拒绝，文案是调价口径（不是收款口径），不新增行', async () => {
    const actor = await adminActor();
    const order = await createOrderWithPassengers();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.REFUNDED } });

    await expect(
      service.addPriceAdjustment(order.id, { amountCny: 200, reasonCode: 'MISC_FEE' }, actor),
    ).rejects.toThrow(/当前状态为「已退款」，不能再调价/);

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(1); // 仍只有原 BUNDLE 行
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reloaded.total)).toBe(6000); // total 不变
  });

  it('软删单（回收站）→ 调价闸拒绝，即便状态本身是可调价的', async () => {
    const actor = await adminActor();
    const order = await createOrderWithPassengers();
    await prisma.order.update({ where: { id: order.id }, data: { deletedAt: new Date() } });

    await expect(
      service.addPriceAdjustment(order.id, { amountCny: 200, reasonCode: 'MISC_FEE' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(1);
  });
});
