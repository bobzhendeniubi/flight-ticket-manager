/**
 * 每人结算价（perPassengerSettlementCny）· 真 DB 集成测试
 *
 * 覆盖单测（mock Prisma）无法验证的全链路：
 *   (a) 三人不同价 → 逐人 SETTLEMENT 差额行 passengerId 真实落库且挂对人、
 *       整单 SETTLEMENT 收敛行 passengerId=NULL、total = Σ每人价；
 *       按订单详情「每人结算价」派生口径（基准 = (total − Σ按乘客净额)/人数）还原出所填逐人价。
 *   (b) 全员同价 → 无逐人行，行为与整单结算总价一致。
 *   (c) 审计落库：APPLY_SETTLEMENT_TOTAL 带 perPassengerSettlementCny 快照。
 *   (d) 数组长度 ≠ 乘客数 → 400，不建单。
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

async function staffRequester(): Promise<OrderRequester> {
  const u = await prisma.user.create({
    data: { email: `${uniq('u')}@test.com`, role: UserRole.STAFF },
  });
  return { userId: u.id, role: UserRole.STAFF };
}

function passenger(name: string) {
  return {
    fullName: name,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq('P'),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
  };
}

// TRANSFER 行：无产品 id → 信任前端 unitPrice（不查 DB、不扣座），聚焦结算分解链路。
function transferItems(unitPrice: number, quantity: number) {
  return [{ kind: 'TRANSFER' as const, description: '接送', quantity, unitPrice }];
}

describe('createOrder · 每人结算价（真 DB）', () => {
  it('(a) 三人不同价 → 逐人差额行挂对人 + 整单收敛行 + total=Σ每人价，派生口径还原逐人价', async () => {
    const requester = await staffRequester();
    const paxA = passenger('ZHANG SAN');
    const paxB = passenger('LI SI');
    const paxC = passenger('WANG WU');
    const order = await service.createOrder(
      {
        contactName: '每人结算价测试',
        contactPhone: '13800138000',
        items: transferItems(1000, 3), // 系统价 3000
        passengers: [paxA, paxB, paxC],
        perPassengerSettlementCny: [1300, 1348, 1400],
      },
      requester,
    );

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, passengers: true },
    });

    // total = Σ每人价 = 4048
    expect(Number(created.total)).toBe(4048);

    // 逐人 SETTLEMENT 差额行：LI SI +48、WANG WU +100，passengerId 挂对人；ZHANG SAN 无行
    const idByName = new Map(created.passengers.map((p) => [p.fullName, p.id]));
    const perPaxItems = created.items.filter(
      (it) => (it.metadata as Record<string, unknown> | null)?.perPassenger === true,
    );
    expect(perPaxItems).toHaveLength(2);
    const byPassenger = new Map(perPaxItems.map((it) => [it.passengerId, Number(it.amount)]));
    expect(byPassenger.get(idByName.get('LI SI')!)).toBe(48);
    expect(byPassenger.get(idByName.get('WANG WU')!)).toBe(100);
    expect(perPaxItems.every((it) => it.kind === OrderItemKind.FEE)).toBe(true);

    // 整单 SETTLEMENT 收敛行：4048 − (3000 + 148) = 900，passengerId=NULL
    const whole = created.items.find(
      (it) =>
        (it.metadata as Record<string, unknown> | null)?.reasonCode === 'SETTLEMENT' &&
        (it.metadata as Record<string, unknown> | null)?.perPassenger !== true,
    );
    expect(whole).toBeTruthy();
    expect(Number(whole!.amount)).toBe(900);
    expect(whole!.passengerId).toBeNull();

    // 订单详情「每人结算价」派生口径还原：基准 = (4048 − 148)/3 = 1300 → 1300/1348/1400
    const netByPassenger = new Map<string, number>();
    for (const it of perPaxItems) {
      netByPassenger.set(
        it.passengerId!,
        (netByPassenger.get(it.passengerId!) ?? 0) + Number(it.amount),
      );
    }
    const netSum = [...netByPassenger.values()].reduce((s, v) => s + v, 0);
    const base = (Number(created.total) - netSum) / created.passengers.length;
    expect(base).toBe(1300);
    expect(base + (netByPassenger.get(idByName.get('ZHANG SAN')!) ?? 0)).toBe(1300);
    expect(base + (netByPassenger.get(idByName.get('LI SI')!) ?? 0)).toBe(1348);
    expect(base + (netByPassenger.get(idByName.get('WANG WU')!) ?? 0)).toBe(1400);
  });

  it('(b) 全员同价 → 无逐人行，整单收敛与 settlementTotalCny 同口径', async () => {
    const requester = await staffRequester();
    const order = await service.createOrder(
      {
        contactName: '同价测试',
        contactPhone: '13800138000',
        items: transferItems(1000, 2), // 系统价 2000
        passengers: [passenger('A A'), passenger('B B')],
        perPassengerSettlementCny: [1200, 1200],
      },
      requester,
    );

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(Number(created.total)).toBe(2400);
    expect(
      created.items.filter(
        (it) => (it.metadata as Record<string, unknown> | null)?.perPassenger === true,
      ),
    ).toHaveLength(0);
    const whole = created.items.find(
      (it) => (it.metadata as Record<string, unknown> | null)?.reasonCode === 'SETTLEMENT',
    );
    expect(Number(whole!.amount)).toBe(400); // 2400 − 2000
  });

  it('(c) 审计落库：APPLY_SETTLEMENT_TOTAL 带 perPassengerSettlementCny 快照', async () => {
    const requester = await staffRequester();
    const order = await service.createOrder(
      {
        contactName: '审计测试',
        contactPhone: '13800138000',
        items: transferItems(1000, 2),
        passengers: [passenger('C C'), passenger('D D')],
        perPassengerSettlementCny: [900, 1100],
      },
      requester,
    );

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'APPLY_SETTLEMENT_TOTAL', targetId: order.id },
    });
    expect(audit).toBeTruthy();
    const after = audit!.after as Record<string, unknown>;
    expect(after.perPassengerSettlementCny).toEqual([900, 1100]);
    expect(after.settlementTotalCny).toBe(2000);
  });

  it('(d) 数组长度 ≠ 乘客数 → 400，不建单', async () => {
    const requester = await staffRequester();
    const contactName = uniq('长度不符');
    await expect(
      service.createOrder(
        {
          contactName,
          contactPhone: '13800138000',
          items: transferItems(1000, 2),
          passengers: [passenger('E E'), passenger('F F')],
          perPassengerSettlementCny: [1000],
        },
        requester,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await prisma.order.findFirst({ where: { contactName } })).toBeNull();
  });
});
