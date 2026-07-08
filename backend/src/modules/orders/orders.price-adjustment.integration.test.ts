/**
 * 录单调价/加项 · 真 DB 集成测试（vitest）
 *
 * 覆盖单测（mock Prisma）无法验证的全链路：
 *   (a) STAFF 录单带 priceAdjustment（正）→ 落一条独立 OrderItem（kind=FEE、metadata.priceAdjustment）
 *       且 order.total = 系统价 + 调整额。
 *   (b) 负调整（优惠）→ kind=DISCOUNT，total 相应下调。
 *   (c) 审计落库：写入一条 action=ADJUST_ORDER_PRICE、含原价/调整额/原因的 AuditLog。
 *   (d) CUSTOMER 带 priceAdjustment → BadRequestError（散客 400），不建单。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { OrderItemKind, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createUser(role: UserRole) {
  return prisma.user.create({ data: { email: `${uniq('u')}@test.com`, role } });
}

async function staffRequester(): Promise<OrderRequester> {
  const u = await createUser(UserRole.STAFF);
  return { userId: u.id, role: UserRole.STAFF };
}

function passenger(i: number) {
  return {
    fullName: `LI SI ${i}`,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
  };
}

// TRANSFER 行：无产品 id → 信任前端 unitPrice（不查 DB、不扣座），
// 让本测试聚焦「调价计入 total + 审计」而不牵扯航班库存链路。
function transferItems(unitPrice: number, quantity = 1) {
  return [{ kind: 'TRANSFER' as const, description: '接送', quantity, unitPrice }];
}

describe('createOrder · 录单调价/加项（真 DB）', () => {
  it('(a) 正调整 → 独立 FEE 行 + total = 系统价 + 调整额', async () => {
    const requester = await staffRequester();
    const order = await service.createOrder(
      {
        contactName: '调价测试',
        contactPhone: '13800138000',
        items: transferItems(150),
        passengers: [passenger(1)],
        priceAdjustment: { amountCny: 700, reasonCode: 'UPGRADE_CABIN' },
      },
      requester,
    );

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    // 系统价 150 + 调整 700 = 850
    expect(Number(created.total)).toBe(850);

    const adjRow = created.items.find(
      (it) => (it.metadata as Record<string, unknown> | null)?.priceAdjustment === true,
    );
    expect(adjRow).toBeTruthy();
    expect(adjRow!.kind).toBe(OrderItemKind.FEE);
    expect(Number(adjRow!.amount)).toBe(700);
    expect(adjRow!.description).toContain('升舱');
    expect((adjRow!.metadata as Record<string, unknown>).reasonCode).toBe('UPGRADE_CABIN');
  });

  it('(b) 负调整（优惠）→ DISCOUNT 行，total 下调', async () => {
    const requester = await staffRequester();
    const order = await service.createOrder(
      {
        contactName: '优惠测试',
        contactPhone: '13800138000',
        items: transferItems(1000),
        passengers: [passenger(2)],
        priceAdjustment: { amountCny: -200, reasonCode: 'DISCOUNT' },
      },
      requester,
    );

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    // 1000 − 200 = 800
    expect(Number(created.total)).toBe(800);
    const adjRow = created.items.find(
      (it) => (it.metadata as Record<string, unknown> | null)?.priceAdjustment === true,
    );
    expect(adjRow!.kind).toBe(OrderItemKind.DISCOUNT);
    expect(Number(adjRow!.amount)).toBe(-200);
  });

  it('(c) 审计落库：ADJUST_ORDER_PRICE 含原价/调整额/原因', async () => {
    const requester = await staffRequester();
    const order = await service.createOrder(
      {
        contactName: '审计测试',
        contactPhone: '13800138000',
        items: transferItems(150),
        passengers: [passenger(3)],
        priceAdjustment: { amountCny: 700, reasonCode: 'UPGRADE_CABIN' },
      },
      requester,
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'ADJUST_ORDER_PRICE', targetId: order.id },
    });
    expect(audit).toBeTruthy();
    const before = audit!.before as Record<string, unknown>;
    const after = audit!.after as Record<string, unknown>;
    expect(before.total).toBe('150'); // 原价（调整前）
    expect(after.total).toBe('850'); // 调整后
    expect(after.amountCny).toBe(700);
    expect(after.reasonCode).toBe('UPGRADE_CABIN');
    expect(after.reasonLabel).toBe('升舱');
    expect(audit!.actorUserId).toBe(requester.userId);
  });

  it('(d) CUSTOMER 带 priceAdjustment → BadRequestError（散客 400），不建单', async () => {
    const cust = await createUser(UserRole.CUSTOMER);
    const idempotencyKey = uniq('idem');
    await expect(
      service.createOrder(
        {
          contactName: '越权测试',
          contactPhone: '13800138000',
          items: transferItems(150),
          passengers: [passenger(4)],
          priceAdjustment: { amountCny: 700, reasonCode: 'UPGRADE_CABIN' },
          idempotencyKey,
        },
        { userId: cust.id, role: UserRole.CUSTOMER },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);

    const leaked = await prisma.order.findFirst({ where: { idempotencyKey } });
    expect(leaked).toBeNull();
  });
});
