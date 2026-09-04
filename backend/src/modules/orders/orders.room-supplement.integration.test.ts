/**
 * OrderService.addRoomSupplement（事后补收单房差）· 真 DB 集成测试
 *
 * 覆盖：
 *   - 正常：含 HOTEL/BUNDLE 行的订单补收 → 新增一条 FEE 行 + subtotal/total 增加 + 尾款反映 +
 *     order.adjustments 追加 ROOM_SUPPLEMENT 审计流水 + 新行 metadata 打标（reasonCode/perNightCny/nights）
 *   - 纯机票单拒绝：订单只含 FLIGHT 行 → BadRequestError，且不新增任何行
 *   - 非 ADMIN/STAFF 调用被拒（ForbiddenError）
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService } from './orders.service.js';

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

/** 建一个 PAID 订单，含一条给定 kind 的行（HOTEL/BUNDLE = 有住宿；FLIGHT = 纯机票）。 */
async function createOrderWith(
  kind: OrderItemKind,
  opts: { total?: number; paidAmount?: number } = {},
) {
  const total = opts.total ?? 1000;
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-RS'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(total),
      total: new Prisma.Decimal(total),
      paidAmount: new Prisma.Decimal(opts.paidAmount ?? total),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind,
            description: kind === OrderItemKind.FLIGHT ? '机票 MFM→DAD' : '住宿/套餐',
            quantity: 1,
            unitPrice: new Prisma.Decimal(total),
            amount: new Prisma.Decimal(total),
          },
        ],
      },
    },
    include: { items: true },
  });
}

describe('OrderService.addRoomSupplement · 真 DB E2E', () => {
  it('指定乘客补收：FEE 行挂上 passengerId（每人结算价 / 导出单房差按它归属到人），乘客标单住', async () => {
    const actor = await adminActor();
    const order = await createOrderWith(OrderItemKind.HOTEL, { total: 1000, paidAmount: 1000 });
    const pax = await prisma.passenger.create({
      data: {
        orderId: order.id,
        fullName: 'ZHANG/SAN',
        documentType: 'PASSPORT',
        documentNumber: uniq('E'),
        nationality: 'CN',
      },
    });

    await service.addRoomSupplement(
      order.id,
      { perNightCny: 200, nights: 2, passengerId: pax.id },
      actor,
    );

    const fee = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id, kind: OrderItemKind.FEE },
    });
    expect(fee.passengerId).toBe(pax.id);
    expect(Number(fee.amount)).toBe(400);
    const reloadedPax = await prisma.passenger.findUniqueOrThrow({ where: { id: pax.id } });
    expect(reloadedPax.singleRoom).toBe(true);
  });

  it('正常：新增 FEE 行 + total 增加 + 审计流水追加 + metadata 打标', async () => {
    const actor = await adminActor();
    const order = await createOrderWith(OrderItemKind.HOTEL, { total: 1000, paidAmount: 1000 });

    const result = await service.addRoomSupplement(
      order.id,
      { perNightCny: 300, nights: 4, note: '客户单房' },
      actor,
    );

    // 金额计算：300 × 4 = 1200
    expect(result.audit.amountCny).toBe(1200);

    // 新增一条 FEE 行（reasonCode/perNightCny/nights 打标）
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(2);
    const fee = items.find((it) => it.kind === OrderItemKind.FEE);
    expect(fee).toBeTruthy();
    expect(Number(fee!.amount)).toBe(1200);
    expect(fee!.description).toBe('补收单房差 ¥300/晚 × 4晚');
    const meta = fee!.metadata as Record<string, unknown>;
    expect(meta.reasonCode).toBe('ROOM_DIFF');
    expect(meta.perNightCny).toBe(300);
    expect(meta.nights).toBe(4);
    expect(meta.note).toBe('客户单房');

    // subtotal/total 增加（1000 → 2200）；adjustmentCny 不动（钱走 total）
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reloaded.total)).toBe(2200);
    expect(Number(reloaded.subtotal)).toBe(2200);
    expect(reloaded.adjustmentCny).toBe(0);

    // 审计流水追加 ROOM_SUPPLEMENT
    const log = reloaded.adjustments as Array<{ type: string; amountCny: number; note?: string }>;
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('ROOM_SUPPLEMENT');
    expect(log[0].amountCny).toBe(1200);
    expect(log[0].note).toBe('客户单房');

    // 尾款口径：balanceDue = total(2200) + adjustmentCny(0) − paid(1000) = 1200
    expect(result.order.balanceDue).toBe('1200');
    expect(result.order.total).toBe('2200');
  });

  it('纯机票单 → BadRequestError，不新增任何行', async () => {
    const actor = await adminActor();
    const order = await createOrderWith(OrderItemKind.FLIGHT, { total: 800 });

    await expect(
      service.addRoomSupplement(order.id, { perNightCny: 200, nights: 2 }, actor),
    ).rejects.toThrow(/不含酒店\/套餐/);

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toHaveLength(1); // 仍只有原 FLIGHT 行
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(reloaded.total)).toBe(800); // total 未变
  });

  it('非 ADMIN/STAFF 调用 → 拒绝', async () => {
    const order = await createOrderWith(OrderItemKind.BUNDLE, { total: 1000 });
    await expect(
      service.addRoomSupplement(
        order.id,
        { perNightCny: 300, nights: 3 },
        { userId: 'someone', role: UserRole.AGENT },
      ),
    ).rejects.toThrow(/仅运营\/管理员/);
  });
});
