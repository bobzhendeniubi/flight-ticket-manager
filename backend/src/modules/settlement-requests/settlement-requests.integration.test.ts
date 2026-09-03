/**
 * 代理自助改结算价 · 真 DB 集成测试（vitest）
 *
 * 覆盖单测（mock Prisma）验证不到的全链路 —— 钱是不是真的动了、锁是不是真的挡得住：
 *   (a) 代理录单当场自填结算总价 → 落 SETTLEMENT 差额行，order.total = 结算价。
 *   (b) 下单后代理自助改价 → APPROVED 记录 + 真差额行 + order.total 收敛到申请价。
 *   (c) 结算价锁定后再提交 → 只落 PENDING，订单金额一分不动。
 *   (d) 锁着的单由运营确认 → 409（调价通道的锁闸挡住），申请留在 PENDING 等解锁。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { describe, it, expect } from 'vitest';
import { SettlementRequestStatus, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from '../orders/orders.service.js';
import { SettlementRequestsService } from './settlement-requests.service.js';

const orders = new OrderService();
const service = new SettlementRequestsService(orders);

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createAgentRequester(): Promise<OrderRequester & { agentId: string }> {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      isActive: true,
    },
  });
  return { userId: user.id, role: UserRole.AGENT, agentId: agent.id };
}

async function opsActor(): Promise<{ userId: string; role: UserRole }> {
  const staff = await prisma.user.create({
    data: { email: `${uniq('staff')}@test.com`, role: UserRole.STAFF },
  });
  return { userId: staff.id, role: UserRole.STAFF };
}

function passenger(i: number) {
  return {
    fullName: `ZHANG SAN ${i}`,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
  };
}

/**
 * 代理自家的一张 TRANSFER 单（无产品 id → 信任前端单价，不查库存），
 * 让本测试聚焦「结算价怎么落、锁怎么挡」而不牵扯航班/酒店链路。
 */
async function createAgentOrder(
  requester: OrderRequester,
  opts: { unitPrice: number; settlementTotalCny?: number },
) {
  return orders.createOrder(
    {
      contactName: '自助改价测试',
      contactPhone: '13800138000',
      items: [
        { kind: 'TRANSFER' as const, description: '接送', quantity: 1, unitPrice: opts.unitPrice },
      ],
      passengers: [passenger(1)],
      ...(opts.settlementTotalCny !== undefined
        ? { settlementTotalCny: opts.settlementTotalCny }
        : {}),
    } as never,
    requester,
  );
}

async function receivableOf(orderId: string): Promise<number> {
  const row = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { total: true, adjustmentCny: true },
  });
  return Number(row.total) + row.adjustmentCny;
}

describe('代理自助改结算价（真 DB）', () => {
  it('(a) 代理录单当场自填结算总价 → 落 SETTLEMENT 差额行，total = 结算价', async () => {
    const agent = await createAgentRequester();
    const order = await createAgentOrder(agent, { unitPrice: 1000, settlementTotalCny: 880 });

    const created = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(Number(created.total)).toBe(880);
    expect(created.agentId).toBe(agent.agentId);
    const settlementRow = created.items.find(
      (it) => (it.metadata as Record<string, unknown> | null)?.settlementPrice === true,
    );
    expect(settlementRow).toBeTruthy();
    expect(Number(settlementRow!.amount)).toBe(-120);
  });

  it('(b) 下单后自助改价 → APPROVED + 真差额行 + 应收收敛到申请价', async () => {
    const agent = await createAgentRequester();
    const order = await createAgentOrder(agent, { unitPrice: 1000 });
    expect(await receivableOf(order.id)).toBe(1000);

    const result = await service.create(agent, order.id, {
      requestedTotalCny: 860,
      note: '同行价',
    });

    expect(result.selfApplied).toBe(true);
    expect(result.status).toBe(SettlementRequestStatus.APPROVED);
    expect(result.appliedDiffCny).toBe('-140.00');
    expect(result.decidedById).toBe(agent.userId);
    expect(result.note).toBe('代理自助：同行价');
    expect(await receivableOf(order.id)).toBe(860);

    // 差额行是真的落了库，且申请记录指向它。
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.appliedAdjustmentItemId).toBeTruthy();
    const item = await prisma.orderItem.findUniqueOrThrow({
      where: { id: row.appliedAdjustmentItemId! },
    });
    expect(item.orderId).toBe(order.id);
    expect(Number(item.amount)).toBe(-140);
    expect(item.description).toContain('代理自助改结算价');
  });

  it('(c) 锁价后提交只落 PENDING，(d) 运营确认被锁闸挡回 409，解锁后才生效', async () => {
    const agent = await createAgentRequester();
    const ops = await opsActor();
    const order = await createAgentOrder(agent, { unitPrice: 1000 });
    await orders.batchSetSettlementLock([order.id], true, ops.userId);

    const result = await service.create(agent, order.id, { requestedTotalCny: 860 });

    expect(result.selfApplied).toBe(false);
    expect(result.status).toBe(SettlementRequestStatus.PENDING);
    expect(result.appliedDiffCny).toBeNull();
    expect(await receivableOf(order.id)).toBe(1000);

    // (d) 锁着的单运营也改不动：调价通道的锁闸挡回 409，申请留在队列里等解锁。
    await expect(service.approve(ops, result.id, {})).rejects.toMatchObject({ statusCode: 409 });
    const afterApprove = await prisma.settlementRequest.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(afterApprove.status).toBe(SettlementRequestStatus.PENDING);
    expect(afterApprove.appliedAdjustmentItemId).toBeNull();
    expect(await receivableOf(order.id)).toBe(1000);

    // 解锁后同一条申请可以正常确认，钱这时才动。
    await orders.batchSetSettlementLock([order.id], false, ops.userId);
    const approved = await service.approve(ops, result.id, {});
    expect(approved.request.status).toBe(SettlementRequestStatus.APPROVED);
    expect(await receivableOf(order.id)).toBe(860);
  });
});
