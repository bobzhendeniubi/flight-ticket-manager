/**
 * 权益核销挂单 → 订单作废 → 自动冲正 · **真 DB** 集成测试
 *
 * 为什么走真库：自动冲正靠 `reversedBy: null` 的关系过滤 + createMany(skipDuplicates) 撞
 * reversalOfId 唯一索引 + 事务内审计 / 待办三件事一起成败，mock 版单测只能看到「调了什么」，
 * 看不到唯一约束与事务真正的行为。
 *
 * 覆盖：
 *   1. 可用次数按新口径放行：已飞 0 + 已付款在订未飞 1 − 已核销 0 = 1，挂本单核销 1 次成功
 *   2. 订单被管理员强制取消 → 台账出现负数补偿行（系统自动、照抄 orderId、note 带原因与单号）
 *      + 审计 BENEFIT_REDEMPTION_AUTO_REVERSED + 一条待办；档案可用次数回到 0（不是 −1）
 *   3. 幂等：同单再次落取消族终态不会二次冲正
 *   4. 挂待支付单被 400 REDEMPTION_ORDER_MISMATCH 拒绝，不写流水
 *   5. 拆单后取消源单不补回（客人在拆出去的单上照常出行；INFO 审计 SKIPPED）；再取消目标单才补回
 *   6. 拆单后取消目标单补回：核销挂源单、补偿行记触发单 = 目标单
 *   7. no-show 首次打标冲正（去程已关柜的已付款单）
 *   8. 恢复占位：按触发单找到「本单曾触发的冲正」提示（补偿行挂源单、触发单是目标单）
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d
 *   2. npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.benefit-auto-reverse.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { CabinClass, OrderItemKind, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { TravelerProfilesService } from '../travelers/traveler-profiles.service.js';
import { TravelerBenefitsService } from '../travelers/traveler-benefits.service.js';
import {
  BENEFIT_AUTO_REVERSAL_ACTOR_ID,
  BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX,
  BENEFIT_AUTO_REVERSED_AUDIT_ACTION,
  BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION,
} from '../travelers/traveler-benefits.auto-reverse.js';

const orders = new OrderService();
const profiles = new TravelerProfilesService();
const benefits = new TravelerBenefitsService(profiles);

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor(): Promise<OrderRequester> {
  const admin = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN, displayName: '运营' },
  });
  return { userId: admin.id, role: UserRole.ADMIN, actorType: 'USER' };
}

/** 班次：hoursFromNow > 0 未飞（默认 10 天后），< 0 已起飞（no-show 用）；sold 按占座人数给。 */
async function createSchedule(hoursFromNow = 10 * 24, sold = 1) {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1000000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const departureTime = new Date(Date.now() + hoursFromNow * 3600_000);
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: [{ cabin: CabinClass.ECONOMY, capacity: 50, sold, basePrice: new Prisma.Decimal(1000) }],
      },
    },
  });
}

function passengerData(fullName: string, documentNumber: string) {
  return {
    fullName,
    documentType: 'PASSPORT' as const,
    documentNumber,
    dateOfBirth: new Date('1990-01-01T00:00:00Z'),
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    passportExpiry: new Date('2031-01-01T00:00:00Z'),
  };
}

/** 直接落一张单（乘客证件 = 档案证件），带一段去程（默认未来）；默认已付款。 */
async function createOrderFor(
  documentNumber: string,
  status: OrderStatus = OrderStatus.PAID,
  hoursFromNow = 10 * 24,
) {
  const schedule = await createSchedule(hoursFromNow);
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-BR'),
      status,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(status === OrderStatus.PAID ? 1000 : 0),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: '去程（经济舱）',
            quantity: 1,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(1000),
            flightScheduleId: schedule.id,
            flightCabin: CabinClass.ECONOMY,
          },
        ],
      },
      passengers: { create: [passengerData('ZHANG SAN', documentNumber)] },
    },
  });
}

/** 两人已付款单（P + Q），一段未来去程 2 座 —— 拆单场景用。 */
async function createTwoPaxOrder(docP: string, docQ: string) {
  const schedule = await createSchedule(10 * 24, 2);
  return prisma.order.create({
    data: {
      orderNumber: uniq('TEST-BR2'),
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(2000),
      total: new Prisma.Decimal(2000),
      paidAmount: new Prisma.Decimal(2000),
      contactName: 'Test User',
      contactPhone: '13800138000',
      items: {
        create: [
          {
            kind: OrderItemKind.FLIGHT,
            description: '去程（经济舱）',
            quantity: 2,
            unitPrice: new Prisma.Decimal(1000),
            amount: new Prisma.Decimal(2000),
            totalCostCny: new Prisma.Decimal(600),
            flightScheduleId: schedule.id,
            flightCabin: CabinClass.ECONOMY,
          },
        ],
      },
      passengers: { create: [passengerData('ZHANG SAN', docP), passengerData('LI SI', docQ)] },
    },
    include: { passengers: true },
  });
}

/** P 在源单上挂单核销 1 次，再把 P 拆到新单 B；返回 A / B / 档案 / 核销行。 */
async function redeemThenSplitOut(admin: OrderRequester) {
  const docP = uniq('E');
  const docQ = uniq('E');
  const orderA = await createTwoPaxOrder(docP, docQ);
  const [lookupP] = await profiles.lookupByDocuments([{ documentType: 'PASSPORT', documentNumber: docP }]);
  expect(lookupP).toMatchObject({ hasProfile: true, availableTrips: 1 });
  const redeemed = await benefits.redeem(
    lookupP.profileId,
    { tripsUsed: 1, benefit: '飞满 5 次兑换升舱', orderId: orderA.id },
    { userId: admin.userId },
  );
  const passengerP = orderA.passengers.find((p) => p.documentNumber === docP)!;
  const split = await orders.splitOrder(
    orderA.id,
    { passengerIds: [passengerP.id], requestToken: randomUUID() },
    { userId: admin.userId, role: UserRole.ADMIN },
  );
  return { orderA, orderBId: split.targetOrderId, profileId: lookupP.profileId, redemption: redeemed.redemption };
}

async function ledgerOf(profileId: string) {
  return prisma.travelerBenefitRedemption.findMany({
    where: { profileId },
    orderBy: { createdAt: 'asc' },
  });
}

describe('权益核销挂单 → 取消自动冲正（真 DB）', () => {
  it('挂本单核销 1 次（可用 = 0 + 1 − 0）→ 强制取消 → 负数补偿行 + 审计 + 待办；再落取消族不重复冲正', async () => {
    const admin = await adminActor();
    const documentNumber = uniq('E');
    const order = await createOrderFor(documentNumber);

    // 档案由 lookup 现算建档（快照带 pendingPaidTripCount=1）
    const [lookup] = await profiles.lookupByDocuments([{ documentType: 'PASSPORT', documentNumber }]);
    expect(lookup.hasProfile).toBe(true);
    expect(lookup).toMatchObject({ tripCount: 0, pendingTripCount: 1, pendingPaidTripCount: 1, availableTrips: 1 });

    // 1. 挂本单核销 1 次：新口径放行（旧口径可用 0 会 400）
    const redeemed = await benefits.redeem(
      lookup.profileId,
      { tripsUsed: 1, benefit: '飞满 5 次兑换升舱', orderId: order.id },
      { userId: admin.userId },
    );
    expect(redeemed.redemption).toMatchObject({
      tripsUsed: 1,
      orderId: order.id,
      orderNumber: order.orderNumber,
      auto: false,
    });
    const afterRedeem = await profiles.getDetail(lookup.profileId);
    expect(afterRedeem.profile.availableTrips).toBe(0);

    // 2. 管理员强制取消（已收款单走不了普通取消边，force 是既有应急通道）
    await orders.updateStatus(order.id, OrderStatus.CANCELLED, admin, '集成测试：取消', true);

    const ledger = await ledgerOf(lookup.profileId);
    expect(ledger).toHaveLength(2);
    const reversal = ledger.find((r) => r.tripsUsed < 0)!;
    expect(reversal).toMatchObject({
      tripsUsed: -1,
      benefit: '飞满 5 次兑换升舱',
      reversalOfId: redeemed.redemption.id,
      orderId: order.id,
      createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
      createdByName: '系统自动',
    });
    expect(reversal.note).toContain('订单已取消');
    expect(reversal.note).toContain(order.orderNumber);

    const audits = await prisma.auditLog.findMany({
      where: { action: BENEFIT_AUTO_REVERSED_AUDIT_ACTION, targetId: lookup.profileId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].severity).toBe('WARNING');
    expect(audits[0].after).toMatchObject({ reversalId: reversal.id, triggerOrderId: order.id });

    const reminder = await prisma.operationalReminder.findUnique({
      where: { ruleKey: `${BENEFIT_AUTO_REVERSAL_REMINDER_PREFIX}${reversal.id}` },
    });
    expect(reminder).not.toBeNull();
    expect(reminder!.orderId).toBe(order.id);
    expect(reminder!.createdById).toBe(admin.userId);
    expect(reminder!.priority).toBe('HIGH');

    // 取消后：这单不再算行程，核销也补回 → 可用回到 0（不是 −1），台账明细带 auto 标记
    const afterCancel = await profiles.getDetail(lookup.profileId);
    expect(afterCancel.profile).toMatchObject({ pendingPaidTripCount: 0, redeemedTrips: 0, availableTrips: 0 });
    expect(afterCancel.redemptions.find((r) => r.id === reversal.id)).toMatchObject({
      auto: true,
      orderNumber: order.orderNumber,
    });

    // 3. 幂等：同单再次落取消族终态（CANCELLED → PAYMENT_TIMEOUT 是白名单边）不会二次冲正
    await orders.updateStatus(order.id, OrderStatus.PAYMENT_TIMEOUT, admin, '集成测试：再流转', true);
    expect(await ledgerOf(lookup.profileId)).toHaveLength(2);
  });

  it('挂待支付单 → 400 REDEMPTION_ORDER_MISMATCH，不写流水', async () => {
    const admin = await adminActor();
    const documentNumber = uniq('E');
    await createOrderFor(documentNumber, OrderStatus.PAID); // 给档案一次已付款在订额度，只测挂单校验
    const pendingOrder = await createOrderFor(documentNumber, OrderStatus.PENDING_PAYMENT);
    const [lookup] = await profiles.lookupByDocuments([{ documentType: 'PASSPORT', documentNumber }]);
    // 待支付那单进在订未飞、不进已付款在订未飞
    expect(lookup).toMatchObject({ pendingTripCount: 2, pendingPaidTripCount: 1, availableTrips: 1 });

    await expect(
      benefits.redeem(
        lookup.profileId,
        { tripsUsed: 1, benefit: '升舱', orderId: pendingOrder.id },
        { userId: admin.userId },
      ),
    ).rejects.toMatchObject({ code: 'REDEMPTION_ORDER_MISMATCH' });
    expect(await ledgerOf(lookup.profileId)).toHaveLength(0);
  });

  it('拆单后取消源单：P 在 B 上照常出行 → A 上的核销不补回（INFO 审计 SKIPPED）；再取消 B 才补回', async () => {
    const admin = await adminActor();
    const { orderA, orderBId, profileId, redemption } = await redeemThenSplitOut(admin);
    expect(redemption.orderId).toBe(orderA.id);

    // 1. 取消源单 A（留下的 Q 不飞了）：P 的行程仍由 B 承载，核销**不**冲正
    await orders.updateStatus(orderA.id, OrderStatus.CANCELLED, admin, '集成测试：取消源单', true);

    expect(await ledgerOf(profileId)).toHaveLength(1);
    const skipped = await prisma.auditLog.findMany({
      where: { action: BENEFIT_AUTO_REVERSE_SKIPPED_AUDIT_ACTION, targetId: profileId },
    });
    expect(skipped).toHaveLength(1);
    expect(skipped[0].severity).toBe('INFO');
    expect(skipped[0].after).toMatchObject({ triggerOrderId: orderA.id, carriedByOrderIds: [orderBId] });
    expect(
      await prisma.auditLog.count({ where: { action: BENEFIT_AUTO_REVERSED_AUDIT_ACTION, targetId: profileId } }),
    ).toBe(0);
    // 可用 = 已飞 0 + 已付款在订未飞 1（B）− 已核销 1 = 0，账实相符
    const afterCancelA = await profiles.getDetail(profileId);
    expect(afterCancelA.profile).toMatchObject({ pendingPaidTripCount: 1, redeemedTrips: 1, availableTrips: 0 });

    // 2. 再取消 B：P 已没有任何有效行程 → 这才补回（补偿行挂源单 A、触发单记 B）
    await orders.updateStatus(orderBId, OrderStatus.CANCELLED, admin, '集成测试：取消目标单', true);

    const ledger = await ledgerOf(profileId);
    expect(ledger).toHaveLength(2);
    const reversal = ledger.find((r) => r.tripsUsed < 0)!;
    expect(reversal).toMatchObject({
      tripsUsed: -1,
      reversalOfId: redemption.id,
      orderId: orderA.id,
      triggeredByOrderId: orderBId,
      createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
    });
    const afterCancelB = await profiles.getDetail(profileId);
    expect(afterCancelB.profile).toMatchObject({ pendingPaidTripCount: 0, redeemedTrips: 0, availableTrips: 0 });
  });

  it('拆单后取消目标单：核销挂在源单上、P 已拆到 B → 取消 B 补回，补偿行记触发单 = B', async () => {
    const admin = await adminActor();
    const { orderA, orderBId, profileId, redemption } = await redeemThenSplitOut(admin);

    await orders.updateStatus(orderBId, OrderStatus.CANCELLED, admin, '集成测试：取消目标单', true);

    const ledger = await ledgerOf(profileId);
    expect(ledger).toHaveLength(2);
    expect(ledger.find((r) => r.tripsUsed < 0)).toMatchObject({
      reversalOfId: redemption.id,
      orderId: orderA.id,
      triggeredByOrderId: orderBId,
    });
    // 源单 A（Q 留守）不受影响，仍是已付款
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } })).status).toBe(OrderStatus.PAID);
    const detail = await profiles.getDetail(profileId);
    expect(detail.profile).toMatchObject({ redeemedTrips: 0, availableTrips: 0 });
  });

  it('去程 no-show 首次打标 → 挂本单的核销自动冲正（再打标 / 再释放不重复）', async () => {
    const admin = await adminActor();
    const documentNumber = uniq('E');
    // 去程 3 小时前已起飞（早过关柜）：这一单先算「已飞 1」，可用 1
    const order = await createOrderFor(documentNumber, OrderStatus.PAID, -3);
    const [lookup] = await profiles.lookupByDocuments([{ documentType: 'PASSPORT', documentNumber }]);
    expect(lookup).toMatchObject({ hasProfile: true, tripCount: 1, availableTrips: 1 });
    const redeemed = await benefits.redeem(
      lookup.profileId,
      { tripsUsed: 1, benefit: '升舱', orderId: order.id },
      { userId: admin.userId },
    );

    await orders.markNoShow(
      order.id,
      { requestToken: randomUUID(), releaseReturn: true },
      { userId: admin.userId, role: UserRole.ADMIN },
    );

    const ledger = await ledgerOf(lookup.profileId);
    expect(ledger).toHaveLength(2);
    const reversal = ledger.find((r) => r.tripsUsed < 0)!;
    expect(reversal).toMatchObject({
      reversalOfId: redeemed.redemption.id,
      orderId: order.id,
      triggeredByOrderId: order.id,
      createdById: BENEFIT_AUTO_REVERSAL_ACTOR_ID,
    });
    expect(reversal.note).toContain('去程 no-show');
    // no-show 单不算飞过一次，核销也补回 → 可用回到 0
    const detail = await profiles.getDetail(lookup.profileId);
    expect(detail.profile).toMatchObject({ tripCount: 0, redeemedTrips: 0, availableTrips: 0 });
  });

  it('恢复占位：按触发单找到「本单曾触发的冲正」提示（补偿行挂源单 A、触发单是目标单 B）', async () => {
    const admin = await adminActor();
    const { orderA, orderBId, profileId } = await redeemThenSplitOut(admin);
    await orders.updateStatus(orderBId, OrderStatus.CANCELLED, admin, '集成测试：取消目标单', true);
    expect((await ledgerOf(profileId)).find((r) => r.tripsUsed < 0)).toMatchObject({
      orderId: orderA.id,
      triggeredByOrderId: orderBId,
    });

    const { audit } = await orders.restoreCancelledOrder(
      orderBId,
      { requestToken: randomUUID(), allowOversell: false, allowFlownLegs: false },
      { userId: admin.userId, role: UserRole.ADMIN },
    );

    expect(audit.warnings.some((w) => w.includes('权益核销') && w.includes('不会自动再核销'))).toBe(true);
    // 恢复不自动再核销：台账不变
    expect(await ledgerOf(profileId)).toHaveLength(2);
  });
});
