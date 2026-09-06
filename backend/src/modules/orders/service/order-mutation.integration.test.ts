/**
 * OrderMutation 内核 · **真 DB** 集成测试
 *
 * 为什么非得走真库：内核的四件事里有三件（行锁互斥、锁内幂等复查、事务回滚）只有真 Postgres 才看得见——
 * mock 里 `$transaction` 就是直接调回调，两个「并发」请求永远排不上队。
 *
 * 覆盖：
 *   1. 内核本体：同 requestToken 两个并发调用，只有一个真的执行、审计只落一条，另一个在锁内命中回放。
 *   2. 内核本体：守恒断言失败 → 整事务回滚（订单一分没动、事务内写的审计也没留下）。
 *   3. 真动作：markNoShow 同 token 并发两次 → 回程座位只放一次，第二次回放。
 *   4. 真动作：拆单守恒断言（§11）失败 → 整事务回滚无半状态——源单人数 / 金额 / 座位原样，
 *      没有新单、没有拆单流水、也没有 SPLIT_ORDER 审计（审计已进事务，这是本批新增的保证）。
 *
 * 跑：
 *   TEST_DATABASE_URL=… npx vitest run -c vitest.integration.config.ts src/modules/orders/service/order-mutation.integration.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { CabinClass, OrderItemKind, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { OrderService, type OrderRequester } from '../orders.service.js';
import { runOrderMutation } from './order-mutation.js';
import * as ledger from './order-ledger.js';

// 拆单守恒断言（§11）在真库上本来就不会失败——它守的就是自己刚写的账。要看「失败时整事务回滚」，
// 只能让求和函数在事后那一次读到不同的数：这里把 Σ 成本的求和包成可控的 spy（默认原样透传）。
vi.mock('./order-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./order-ledger.js')>();
  return { ...actual, sumTotalCostCents: vi.fn(actual.sumTotalCostCents) };
});

const service = new OrderService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** requestToken 必须是 uuid：拼一个固定形状、按 tag 区分的 v4。 */
function token(tag: string): string {
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

async function createSchedule(opts: { hoursFromNow: number; capacity?: number }) {
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
        create: [
          {
            cabin: CabinClass.ECONOMY,
            capacity: opts.capacity ?? 50,
            sold: 0,
            basePrice: new Prisma.Decimal(1000),
          },
        ],
      },
    },
  });
}

async function soldOf(scheduleId: string): Promise<number> {
  const sc = await prisma.flightSeatClass.findFirstOrThrow({
    where: { scheduleId, cabin: CabinClass.ECONOMY },
  });
  return sc.sold;
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

/** 2 人往返单；去程改到过去（no-show 的前提是去程已飞）。 */
async function createRoundTripOrder() {
  const requester = await staffRequester();
  const outbound = await createSchedule({ hoursFromNow: 48 });
  const ret = await createSchedule({ hoursFromNow: 24 * 10 });
  const created = await service.createOrder(
    {
      contactName: 'KERNEL IT',
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
  await prisma.flightSchedule.update({
    where: { id: outbound.id },
    data: { departureTime: new Date(Date.now() - 3 * 24 * 3600_000) },
  });
  return { orderId: created.id, outbound, ret };
}

/** 2 人单程机票单（拆单夹具）。 */
async function createTwoPaxFlightOrder() {
  const requester = await staffRequester();
  const outbound = await createSchedule({ hoursFromNow: 72 });
  const created = await service.createOrder(
    {
      contactName: 'KERNEL SPLIT',
      contactPhone: '13800138000',
      items: [
        {
          kind: 'FLIGHT',
          description: '去程（经济舱）',
          quantity: 2,
          flightScheduleId: outbound.id,
          flightCabin: CabinClass.ECONOMY,
        },
      ],
      passengers: [passenger(1), passenger(2)],
    },
    requester,
  );
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: created.id },
    include: { passengers: true, items: true },
  });
  return { order, outbound };
}

async function bareOrder() {
  return prisma.order.create({
    data: {
      orderNumber: uniq('K'),
      subtotal: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      contactName: 'kernel',
      contactPhone: '1',
    },
  });
}

const PROBE = 'KERNEL_IT_PROBE';

describe('OrderMutation 内核 · 行锁 + 锁内幂等（真 DB）', () => {
  it('同 requestToken 两个并发调用：只执行一次、审计只落一条，另一个在锁内命中回放', async () => {
    const actor = await adminActor();
    const order = await bareOrder();
    let executions = 0;
    const find = async (db: Pick<typeof prisma, 'auditLog'>) => {
      const prior = await db.auditLog.findFirst({ where: { action: PROBE, targetId: order.id } });
      return prior ? { replayed: true } : null;
    };
    const run = () =>
      runOrderMutation<{ replayed: boolean }>(
        { orderId: order.id, actor, action: PROBE, requestToken: token('c1'), idempotency: { find } },
        async (ctx) => {
          executions += 1;
          // 拖一拍：让第二个请求真的撞上 FOR UPDATE，而不是靠时序碰巧串行。
          await new Promise((r) => setTimeout(r, 150));
          await ctx.audit({ action: PROBE, targetType: 'ORDER', targetId: order.id });
          return { replayed: false };
        },
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect(executions).toBe(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await prisma.auditLog.count({ where: { action: PROBE, targetId: order.id } })).toBe(1);
  });

  it('订单不存在 → 「订单不存在」，不进 body', async () => {
    const actor = await adminActor();
    await expect(
      runOrderMutation({ orderId: 'no-such-order', actor, action: PROBE }, async () => 1),
    ).rejects.toThrow('订单不存在');
  });
});

describe('OrderMutation 内核 · 守恒失败整事务回滚（真 DB）', () => {
  it('body 改了已收、守恒点名 paid 不许动 → 抛错，订单一分没动、事务内审计也没留下', async () => {
    const actor = await adminActor();
    const order = await bareOrder();
    await expect(
      runOrderMutation(
        { orderId: order.id, actor, action: PROBE, conserve: { unchanged: ['paid'], label: '探针' } },
        async (ctx) => {
          await ctx.audit({ action: PROBE, targetType: 'ORDER', targetId: order.id });
          await ctx.tx.order.update({
            where: { id: order.id },
            data: { paidAmount: new Prisma.Decimal(100) },
          });
          return 1;
        },
      ),
    ).rejects.toThrow(/探针守恒断言失败：已收.*¥0→¥100（已回滚）/);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paidAmount.toString()).toBe('0');
    expect(await prisma.auditLog.count({ where: { action: PROBE, targetId: order.id } })).toBe(0);
  });
});

describe('真动作 · markNoShow 同 token 并发两次（真 DB）', () => {
  it('回程座位只放一次，第二次回放；钱款四字段不动', async () => {
    const actor = await adminActor();
    const { orderId, ret } = await createRoundTripOrder();
    expect(await soldOf(ret.id)).toBe(2);
    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    const call = () =>
      service.markNoShow(orderId, { requestToken: token('n1'), releaseReturn: true }, actor);
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.audit.replayed, b.audit.replayed].sort()).toEqual([false, true]);
    expect(await soldOf(ret.id)).toBe(0);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.subtotal.toString()).toBe(before.subtotal.toString());
    expect(after.total.toString()).toBe(before.total.toString());
    expect(after.paidAmount.toString()).toBe(before.paidAmount.toString());
  });
});

describe('真动作 · 拆单守恒断言失败 → 整事务回滚无半状态（真 DB）', () => {
  it('Σ 成本事后对不上 → 源单原样、无新单、无拆单流水、无 SPLIT_ORDER 审计', async () => {
    const actor = await adminActor();
    const { order, outbound } = await createTwoPaxFlightOrder();
    const ordersBefore = await prisma.order.count();
    const soldBefore = await soldOf(outbound.id);

    // 拆单里 Σ 成本求两次（拆前 / 拆后）：让拆后那一次多出 ¥1，§11 必炸。
    const spy = vi.mocked(ledger.sumTotalCostCents);
    const real = spy.getMockImplementation()!;
    let calls = 0;
    spy.mockImplementation((items) => {
      calls += 1;
      const v = real(items);
      return calls === 2 ? v + 100 : v;
    });
    try {
      await expect(
        service.splitOrder(
          order.id,
          {
            passengerIds: [order.passengers[0]!.id],
            requestToken: token('s1'),
            autoSplitRoomGroups: true,
          },
          actor,
        ),
      ).rejects.toThrow(/拆单守恒断言失败：Σ 成本/);
    } finally {
      spy.mockImplementation(real);
    }
    expect(calls).toBe(2);

    const source = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { passengers: true, items: true },
    });
    expect(source.passengers).toHaveLength(2);
    expect(source.total.toString()).toBe(order.total.toString());
    expect(source.paidAmount.toString()).toBe(order.paidAmount.toString());
    expect(source.items.find((it) => it.kind === OrderItemKind.FLIGHT)!.quantity).toBe(2);
    expect(await prisma.order.count()).toBe(ordersBefore);
    expect(await soldOf(outbound.id)).toBe(soldBefore);
    expect(await prisma.orderSplitRecord.count({ where: { sourceOrderId: order.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'SPLIT_ORDER' } } })).toBe(0);

    // 同一个 token 再来一次（求和已恢复原样）→ 这回真的拆成，证明失败那轮没留下任何幂等痕迹。
    const ok = await service.splitOrder(
      order.id,
      { passengerIds: [order.passengers[0]!.id], requestToken: token('s1'), autoSplitRoomGroups: true },
      actor,
    );
    expect(ok.replayed).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'SPLIT_ORDER' } })).toBe(2);
  });
});
