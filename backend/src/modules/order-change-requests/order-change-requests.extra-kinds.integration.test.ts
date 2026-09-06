/**
 * 改单申请 · 扩三类（拆单 / 取消单程 / 改自备签）· 真 DB 集成测试。
 *
 * 单测（order-change-requests.extra-kinds.test.ts）mock 了 OrderService 的三个通道，
 * 只验证「参数传对了」；真正会不会算错钱、乘客搬没搬对，mock 版看不出来 —— 这份补上
 * 唯一真正要紧的一条：**一次拆单申请从提交到运营确认执行完，钱是不是守恒的**
 *（源单 + 新单的 total / paidAmount 合计必须恰好等于拆前源单的数）。
 *
 * 夹具直接用 prisma 建单（与 orders.agent-change.integration.test.ts 同一种写法），
 * 不经过 createOrder：一条不挂航班/酒店的 VISA 行 + 2 位乘客，把「拆单按人头均分应收」
 * 的权威口径（per-pax-share.ts）从真实拆单执行链路里跑一遍，而不是在 mock 里断言参数。
 *
 * 跑：
 *   1. docker compose -f ../docker-compose.test.yml up -d（或指向自建测试库）
 *   2. npm run test:integration --workspace=backend
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentType,
  OrderChangeRequestStatus,
  OrderStatus,
  PassengerType,
  Prisma,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { invalidateFeatureFlagCache, setFeatureFlag } from '../../lib/feature-flags.js';
import { OrderChangeRequestsService } from './order-change-requests.service.js';

const service = new OrderChangeRequestsService();

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function adminActor() {
  const u = await prisma.user.create({
    data: { email: `${uniq('admin')}@test.com`, role: UserRole.ADMIN },
  });
  return { userId: u.id, role: UserRole.ADMIN as const };
}

async function createAgentActor() {
  const user = await prisma.user.create({
    data: { email: `${uniq('agent')}@test.com`, role: UserRole.AGENT },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      contactName: '测试代理',
      contactPhone: '13800138000',
      companyName: '示例商旅',
      isActive: true,
    },
  });
  return { actor: { userId: user.id, role: UserRole.AGENT as const }, agent };
}

/**
 * 一张已付清的 2 人单：1 条不挂航班/酒店的 VISA 服务行（总额 ¥1000），
 * 不牵扯座位/房态，把断言聚焦在「拆单按人头均分应收 + 搬钱」这条权威口径上。
 */
async function createSplittableOrder(agentId: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: uniq('TEST-EK'),
      agentId,
      status: OrderStatus.PAID,
      subtotal: new Prisma.Decimal(1000),
      total: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(1000),
      contactName: '测试联系人',
      contactPhone: '13900001111',
      items: {
        create: [
          {
            kind: 'VISA',
            description: '测试签证服务费',
            quantity: 2,
            unitPrice: new Prisma.Decimal(500),
            amount: new Prisma.Decimal(1000),
          },
        ],
      },
      passengers: {
        create: [
          {
            fullName: 'WANG XIAO',
            chineseName: '王小',
            documentType: DocumentType.PASSPORT,
            documentNumber: uniq('P1'),
            nationality: 'CN',
            passengerType: PassengerType.ADULT,
          },
          {
            fullName: 'LI DA',
            chineseName: '李大',
            documentType: DocumentType.PASSPORT,
            documentNumber: uniq('P2'),
            nationality: 'CN',
            passengerType: PassengerType.ADULT,
          },
        ],
      },
    },
    include: { passengers: true, items: true },
  });
  return order;
}

describe('改单申请 · 拆单扩展 · 真 DB', () => {
  beforeEach(async () => {
    // flag 有 60 秒进程内缓存：每个用例都要从干净状态起跑。
    invalidateFeatureFlagCache();
  });

  it('flag 关（真库无记录）→ 代理提交直接 403，不落任何申请行', async () => {
    const { actor, agent } = await createAgentActor();
    const order = await createSplittableOrder(agent.id);

    await expect(
      service.create(actor, order.id, {
        kind: 'SPLIT',
        payload: { passengerIds: [order.passengers[1]!.id] },
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FEATURE_DISABLED' });

    const count = await prisma.orderChangeRequest.count({ where: { orderId: order.id } });
    expect(count).toBe(0);
  });

  it('flag 开 → 提交 + 运营确认执行 → 源单/新单金额与已收合计恰好守恒，人搬到新单', async () => {
    await setFeatureFlag(prisma, 'AGENT_CHANGE_REQUEST_EXTRA_KINDS', true, null);
    const { actor, agent } = await createAgentActor();
    const admin = await adminActor();
    const order = await createSplittableOrder(agent.id);
    const [stay, moved] = order.passengers;

    const created = await service.create(actor, order.id, {
      kind: 'SPLIT',
      payload: { passengerIds: [moved!.id], note: '客人分开走' },
    });
    expect(created.status).toBe(OrderChangeRequestStatus.PENDING);
    expect(created.summary).toBe('拆出 1 人：李大');

    // 提交这一刻只落申请，不该动订单/乘客半分。
    const untouchedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(untouchedOrder.total)).toBe(1000);
    const untouchedPax = await prisma.passenger.findMany({ where: { orderId: order.id } });
    expect(untouchedPax).toHaveLength(2);

    const { request, order: refreshedOrder } = await service.approve(admin, created.id, {});
    expect(request.status).toBe(OrderChangeRequestStatus.APPROVED);
    expect(request.decisionNote).toMatch(/^已拆出新单 /);
    expect(refreshedOrder).toBeTruthy();

    const sourceAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // 决定备注里带的新单号就是权威来源，按它去查新单，不去猜任何 id 拼接规则。
    const targetOrderNumber = request.decisionNote!.match(/已拆出新单 (\S+)（/)![1];
    const targetOrder = await prisma.order.findFirstOrThrow({
      where: { orderNumber: targetOrderNumber },
      include: { passengers: true },
    });

    // ── 核心断言：金额守恒 ──────────────────────────────────────────────────
    // 2 人均分 ¥1000 应收 → 每人 ¥500；源单留 1 人、新单拿 1 人，两侧合计必须恰好等于拆前的数，
    // 一分不多一分不少（这是拆单存在的全部意义：搬钱不算钱）。
    expect(Number(sourceAfter.total) + Number(targetOrder.total)).toBe(1000);
    expect(Number(sourceAfter.paidAmount) + Number(targetOrder.paidAmount)).toBe(1000);
    expect(Number(targetOrder.total)).toBe(500);
    expect(Number(sourceAfter.total)).toBe(500);

    // ── 人确实搬到了新单，源单只剩留下的那位 ──────────────────────────────────
    const sourcePax = await prisma.passenger.findMany({ where: { orderId: order.id } });
    expect(sourcePax.map((p) => p.id)).toEqual([stay!.id]);
    expect(targetOrder.passengers.map((p) => p.id)).toEqual([moved!.id]);

    // 申请落库的 payload 记着提交那一刻定死的 requestToken（幂等键），不是确认时现生成。
    const persisted = await prisma.orderChangeRequest.findUniqueOrThrow({
      where: { id: created.id },
    });
    const payload = persisted.payload as Record<string, unknown>;
    expect(typeof payload.requestToken).toBe('string');
    expect(payload.passengerIds).toEqual([moved!.id]);
  });

  it('flag 开 → 全员都勾（等于整单转移）→ 400，且不建任何新单', async () => {
    await setFeatureFlag(prisma, 'AGENT_CHANGE_REQUEST_EXTRA_KINDS', true, null);
    const { actor, agent } = await createAgentActor();
    const order = await createSplittableOrder(agent.id);
    const allIds = order.passengers.map((p) => p.id);
    const orderCountBefore = await prisma.order.count();

    // 这条闸在真实链路里由拆单自己的只读预检（previewOrderSplit）当准入闸拦下，
    // 文案是拆单模块自己的措辞，与 mock 版单测里 resolveSplitChange 兜底的那句不是同一句
    // （mock 版的准入闸被替身直接放行，走到的是本模块自己那句；真库这里走的是被拦在
    // 准入闸的那句，两者都成立，断言各自的真实产出）。
    await expect(
      service.create(actor, order.id, { kind: 'SPLIT', payload: { passengerIds: allIds } }),
    ).rejects.toThrow('至少留 1 位乘客在原订单');

    expect(await prisma.order.count()).toBe(orderCountBefore);
    expect(await prisma.orderChangeRequest.count({ where: { orderId: order.id } })).toBe(0);
  });
});
