/**
 * 去程 no-show / 回程释放 / 恢复回程 · **真 DB** 集成测试
 *
 * 为什么这一套非得走真库：这条链路的正确性全在「座位账」上 —— sold 逐舱增减、
 * 释放量与快照恒等、旧 token 重试不二次动账、超售放行有 CRITICAL 审计。
 * mock 版单测里 `flightSeatClass` 是个返回常量的假对象，`$executeRaw` 恒返回 1：
 * 「放了 2 座」和「一座没放」在那里长得一模一样，测得再多也是假绿。
 *
 * 覆盖：
 *   1. 释放 → 恢复 → 再释放：逐舱 sold 守恒（放几座恢复几座）。
 *   2. 升舱拆座（businessUpgradeCount）：经济/商务各退各舱、各占各舱，两舱都守恒。
 *   3. 该舱 sold 不足以释放 → 整单回滚（sold 不动、metadata 不写）。
 *   4. 多轮之后旧 token 的延迟重试 → 回放，sold 一座不动。
 *   5. 余位不足 + 确认超售 → sold 真的超过 capacity，且 AuditLog 里有 CRITICAL 记录。
 *   6. 全程金额四字段（unitPrice/amount/unitCostCny/totalCostCny）与
 *      subtotal/total/paidAmount 前后 diff 恒为零 —— 这条链路一分钱都不该动。
 *
 * 跑：
 *   1. docker compose -f docker-compose.test.yml up -d
 *   2. npx vitest run -c vitest.integration.config.ts src/modules/orders/orders.no-show.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { AuditSeverity, CabinClass, OrderItemKind, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { OrderService, type OrderRequester } from './orders.service.js';
import { ConflictError } from '../../lib/errors.js';

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function token(tag: string): string {
  // requestToken 必须是 uuid：拼一个固定形状、按 tag 区分的 v4。
  return `00000000-0000-4000-8000-0000000${tag.padStart(5, '0')}`;
}

async function adminActor(): Promise<{ userId: string; role: UserRole }> {
  const u = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: u.id, role: UserRole.ADMIN };
}

async function staffRequester(): Promise<OrderRequester> {
  const u = await prisma.user.create({
    data: { email: `${uniq('staff')}@test.com`, role: UserRole.STAFF },
  });
  return { userId: u.id, role: UserRole.STAFF };
}

/** 建一个班次；cabins 里每个舱位各建一行 FlightSeatClass。 */
async function createSchedule(opts: {
  hoursFromNow: number;
  cabins?: Array<{ cabin: CabinClass; capacity: number }>;
}) {
  const flight = await prisma.flight.create({
    data: {
      flightNumber: `T${Math.floor(Math.random() * 1000000)}`,
      originCode: 'MFM',
      destinationCode: 'DAD',
      isActive: true,
    },
  });
  const departureTime = new Date(Date.now() + opts.hoursFromNow * 3600_000);
  return prisma.flightSchedule.create({
    data: {
      flightId: flight.id,
      departureTime,
      arrivalTime: new Date(departureTime.getTime() + 90 * 60 * 1000),
      departureTz: 'Asia/Macau',
      arrivalTz: 'Asia/Ho_Chi_Minh',
      isActive: true,
      seatClasses: {
        create: (opts.cabins ?? [{ cabin: CabinClass.ECONOMY, capacity: 50 }]).map((c) => ({
          cabin: c.cabin,
          capacity: c.capacity,
          sold: 0,
          basePrice: new Prisma.Decimal(1000),
        })),
      },
    },
    include: { seatClasses: true },
  });
}

async function soldOf(scheduleId: string, cabin: CabinClass): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({ where: { scheduleId, cabin } });
  return sc.sold;
}

async function setSold(scheduleId: string, cabin: CabinClass, sold: number): Promise<void> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({ where: { scheduleId, cabin } });
  await prisma.flightSeatClass.update({ where: { id: sc.id }, data: { sold } });
}

function passenger(i: number) {
  return {
    fullName: `WANG XIAO ${i}`,
    documentType: 'PASSPORT' as const,
    documentNumber: uniq(`P${i}`),
    dateOfBirth: '1990-01-01',
    nationality: 'CN',
    passengerType: 'ADULT' as const,
    passportExpiry: '2031-01-01',
  };
}

/**
 * 建一张 2 人往返单，然后把**去程班次改到过去** —— no-show 的前提是「去程真的飞了」，
 * 而建单时班次必须是未来的（定价与占座闸都拦过去班次），所以只能建完再改。
 */
async function createRoundTripOrder() {
  const requester = await staffRequester();
  const outbound = await createSchedule({ hoursFromNow: 48 });
  const ret = await createSchedule({
    hoursFromNow: 24 * 10,
    cabins: [
      { cabin: CabinClass.ECONOMY, capacity: 50 },
      { cabin: CabinClass.BUSINESS, capacity: 10 },
    ],
  });

  const created = await service.createOrder(
    {
      contactName: 'NO SHOW E2E',
      contactPhone: '13800138000',
      items: [
        {
          kind: 'FLIGHT',
          description: '去程（经济舱）',
          quantity: 2,
          flightScheduleId: outbound.id,
          flightCabin: CabinClass.ECONOMY,
        },
        {
          kind: 'FLIGHT',
          description: '回程（经济舱）',
          quantity: 2,
          flightScheduleId: ret.id,
          flightCabin: CabinClass.ECONOMY,
        },
      ],
      passengers: [passenger(1), passenger(2)],
    },
    requester,
  );

  // 去程改到 3 天前（真 UTC 瞬间，departureTz 只用于展示折算）。
  await prisma.flightSchedule.update({
    where: { id: outbound.id },
    data: { departureTime: new Date(Date.now() - 3 * 24 * 3600_000) },
  });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: created.id },
    include: { items: true },
  });
  const legs = order.items.filter((it) => it.kind === OrderItemKind.FLIGHT);
  const outItem = legs.find((it) => it.flightScheduleId === outbound.id)!;
  const retItem = legs.find((it) => it.flightScheduleId === ret.id)!;
  return { orderId: order.id, outbound, ret, outItem, retItem };
}

/** 钱的四字段 + 订单三个合计 —— 这条链路里必须前后一模一样。 */
async function moneySnapshot(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { orderBy: { id: 'asc' } } },
  });
  return {
    subtotal: order.subtotal.toString(),
    total: order.total.toString(),
    paidAmount: order.paidAmount.toString(),
    items: order.items.map((it) => ({
      id: it.id,
      unitPrice: it.unitPrice.toString(),
      amount: it.amount.toString(),
      unitCostCny: it.unitCostCny?.toString() ?? null,
      totalCostCny: it.totalCostCny?.toString() ?? null,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════
describe('no-show · 座位账守恒（真 DB）', () => {
  it('释放 → 恢复 → 再释放：回程逐舱 sold 守恒，金额四字段与合计一个都没动', async () => {
    const actor = await adminActor();
    const { orderId, ret } = await createRoundTripOrder();

    const soldAfterBooking = await soldOf(ret.id, CabinClass.ECONOMY);
    expect(soldAfterBooking).toBe(2);
    const money0 = await moneySnapshot(orderId);

    // ① 释放
    await service.markNoShow(orderId, { requestToken: token('a1'), releaseReturn: true }, actor);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(0);

    // ② 恢复：放几座占回几座
    await service.restoreReturnLeg(
      orderId,
      { requestToken: token('b2'), allowOversell: false },
      actor,
    );
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(2);

    // ③ 再释放
    await service.markNoShow(orderId, { requestToken: token('c3'), releaseReturn: true }, actor);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(0);

    // 钱一分没动。
    expect(await moneySnapshot(orderId)).toEqual(money0);
  });

  it('升舱拆座：经济/商务各退各舱、各占各舱，两舱都守恒', async () => {
    const actor = await adminActor();
    const { orderId, ret, retItem } = await createRoundTripOrder();

    // 模拟「3 人行里 1 人升商务」的下单结果：行上标 businessUpgradeCount=1，
    // 座位账按拆座镜像摆好（经济 1 + 商务 1，合计仍是这一行的 2 座）。
    await prisma.orderItem.update({
      where: { id: retItem.id },
      data: { metadata: { businessUpgradeCount: 1 } as Prisma.InputJsonValue },
    });
    await setSold(ret.id, CabinClass.ECONOMY, 1);
    await setSold(ret.id, CabinClass.BUSINESS, 1);

    await service.markNoShow(orderId, { requestToken: token('a1'), releaseReturn: true }, actor);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(0);
    expect(await soldOf(ret.id, CabinClass.BUSINESS)).toBe(0);

    // 快照里逐舱各记一条，恢复照单回填。
    const released = await prisma.orderItem.findUniqueOrThrow({ where: { id: retItem.id } });
    const snap = (released.metadata as Record<string, any>).returnReleased;
    expect(snap.releasedSeats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cabin: 'BUSINESS', quantity: 1 }),
        expect.objectContaining({ cabin: 'ECONOMY', quantity: 1 }),
      ]),
    );

    await service.restoreReturnLeg(
      orderId,
      { requestToken: token('b2'), allowOversell: false },
      actor,
    );
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(1);
    expect(await soldOf(ret.id, CabinClass.BUSINESS)).toBe(1);
  });

  it('该舱 sold 不足以释放 → 整单回滚：sold 不动、行 metadata 不写、班次不置空', async () => {
    const actor = await adminActor();
    const { orderId, ret, retItem } = await createRoundTripOrder();

    // 库存被别处改乱：这一行占着 2 座，班次上却只剩 1 座 sold。
    await setSold(ret.id, CabinClass.ECONOMY, 1);

    await expect(
      service.markNoShow(orderId, { requestToken: token('a1'), releaseReturn: true }, actor),
    ).rejects.toBeInstanceOf(ConflictError);

    // floored 版会静默少放 1 座、快照却照记 2 座 —— 恢复时就凭空多占 1 座。这里必须整单回滚。
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(1);
    const item = await prisma.orderItem.findUniqueOrThrow({ where: { id: retItem.id } });
    expect(item.flightScheduleId).toBe(ret.id);
    expect((item.metadata as Record<string, unknown> | null)?.returnReleased).toBeUndefined();
  });
});

describe('no-show · 幂等（真 DB）', () => {
  it('释放 A → 恢复 B → 再释放 C → 再恢复 D → 再释放 E 之后，B 与 C 的延迟重试都不改 sold', async () => {
    const actor = await adminActor();
    const { orderId, ret, retItem } = await createRoundTripOrder();
    const A = token('a1');
    const B = token('b2');
    const C = token('c3');
    const D = token('d4');
    const E = token('e5');

    await service.markNoShow(orderId, { requestToken: A, releaseReturn: true }, actor);
    await service.restoreReturnLeg(orderId, { requestToken: B, allowOversell: false }, actor);
    await service.markNoShow(orderId, { requestToken: C, releaseReturn: true }, actor);
    await service.restoreReturnLeg(orderId, { requestToken: D, allowOversell: false }, actor);
    // 第五轮：C 被 E 挤出 returnReleased，这才是「旧 token 真的从当前快照上消失了」的状态。
    await service.markNoShow(orderId, { requestToken: E, releaseReturn: true }, actor);

    const soldNow = await soldOf(ret.id, CabinClass.ECONOMY);
    expect(soldNow).toBe(0);

    // 当前快照上只剩 E（returnReleased）与 D（returnRestored）：C 进了 history，B 连 history 都没有。
    const row = await prisma.orderItem.findUniqueOrThrow({ where: { id: retItem.id } });
    const meta = row.metadata as Record<string, any>;
    expect(meta.returnReleased.requestToken).toBe(E);
    expect(meta.returnRestored.requestToken).toBe(D);
    expect(meta.legActionLog.map((e: Record<string, unknown>) => e.requestToken)).toEqual([
      A,
      B,
      C,
      D,
      E,
    ]);

    // C（第二次释放）的重试：当前快照上已经没有 C 了，靠 legActionLog 才认得出来。
    const replayC = await service.markNoShow(
      orderId,
      { requestToken: C, releaseReturn: true },
      actor,
    );
    expect(replayC.audit.replayed).toBe(true);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(soldNow);

    // B（第一次恢复）的重试：returnRestored 早被 D 顶掉，只有 legActionLog 里还留着 B。
    const replayB = await service.restoreReturnLeg(
      orderId,
      { requestToken: B, allowOversell: false },
      actor,
    );
    expect(replayB.audit.replayed).toBe(true);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(soldNow);

    // A（第一次释放）同理。
    const replayA = await service.markNoShow(
      orderId,
      { requestToken: A, releaseReturn: true },
      actor,
    );
    expect(replayA.audit.replayed).toBe(true);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(soldNow);
  });
});

describe('no-show · 超售放行（真 DB）', () => {
  it('余位不足 + 确认超售 → sold 真的超过 capacity，且同一事务里落了 CRITICAL 审计', async () => {
    const actor = await adminActor();
    const { orderId, ret } = await createRoundTripOrder();
    const capacity = (
      await prisma.flightSeatClass.findFirstOrThrow({
        where: { scheduleId: ret.id, cabin: CabinClass.ECONOMY },
      })
    ).capacity;

    await service.markNoShow(orderId, { requestToken: token('a1'), releaseReturn: true }, actor);
    // 释放出来的 2 座在这期间被别人买走，班次正好卖满。
    await setSold(ret.id, CabinClass.ECONOMY, capacity);

    // 未确认 → 409（一座不动）
    await expect(
      service.restoreReturnLeg(orderId, { requestToken: token('b2'), allowOversell: false }, actor),
    ).rejects.toMatchObject({ code: 'OVERSELL_CONFIRMATION_REQUIRED' });
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(capacity);

    const { audit } = await service.restoreReturnLeg(
      orderId,
      { requestToken: token('b3'), allowOversell: true },
      actor,
    );
    expect(audit.oversold).toBe(true);
    // 本次**新增** 2 座超售；恢复后该舱累计也是 2（之前正好卖满、没超）。
    expect(audit.oversoldBy).toBe(2);
    expect(audit.scheduleOversoldAfter).toBe(2);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(capacity + 2);

    // 审计与占座同一事务写下（不是路由异步补记）→ 事务提交后必然查得到。
    const logs = await prisma.auditLog.findMany({
      where: { action: 'RESTORE_RETURN_LEG_OVERSOLD', targetId: orderId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].severity).toBe(AuditSeverity.CRITICAL);
    expect(logs[0].actorUserId).toBe(actor.userId);
    expect(String(logs[0].targetLabel)).toContain('超出 2 座（本次 +2');
    const after = logs[0].after as Record<string, any>;
    expect(after.seatDetail).toEqual([
      { cabin: 'ECONOMY', quantity: 2, before: 0, after: 2, increment: 2 },
    ]);
  });

  it('超售恢复后再释放：多出来的 2 座如实放回去，班次回到卖满而不是被打成负数', async () => {
    const actor = await adminActor();
    const { orderId, ret } = await createRoundTripOrder();
    const capacity = (
      await prisma.flightSeatClass.findFirstOrThrow({
        where: { scheduleId: ret.id, cabin: CabinClass.ECONOMY },
      })
    ).capacity;

    await service.markNoShow(orderId, { requestToken: token('a1'), releaseReturn: true }, actor);
    await setSold(ret.id, CabinClass.ECONOMY, capacity);
    await service.restoreReturnLeg(
      orderId,
      { requestToken: token('b2'), allowOversell: true },
      actor,
    );
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(capacity + 2);

    await service.markNoShow(orderId, { requestToken: token('c3'), releaseReturn: true }, actor);
    expect(await soldOf(ret.id, CabinClass.ECONOMY)).toBe(capacity);
  });
});
