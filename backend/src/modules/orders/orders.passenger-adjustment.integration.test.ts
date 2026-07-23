/**
 * OrderService.addPriceAdjustment（按乘客/整单事后调价 · 0722 公测反馈）· 真 DB 集成测试
 *
 * 覆盖：
 *   - 乘客级调整计入总额：给指定乘客挂差额 → 新增一条 priceAdjustment 行（passengerId 落库）+
 *     subtotal/total 增加 + 尾款反映 + adjustments 审计追加（type=PRICE_ADJUSTMENT、带 passengerId/reasonCode）
 *   - 整单调价回归：不带 passengerId → 差额行 passengerId=NULL、计入 total（与录单整单调价同口径）
 *   - 负调整（优惠）→ kind=DISCOUNT、total 下降
 *   - passengerId 不属于本单 → BadRequestError，不新增任何行、total 不变
 *   - 死单（CANCELLED）→ 资金闸拒绝（assertOrderAcceptsFunds），不新增任何行
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

  it('死单（CANCELLED）→ 资金闸拒绝，不新增行', async () => {
    const actor = await adminActor();
    const order = await createOrderWithPassengers();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    await expect(
      service.addPriceAdjustment(order.id, { amountCny: 200, reasonCode: 'MISC_FEE' }, actor),
    ).rejects.toBeInstanceOf(BadRequestError);

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(1);
  });
});
