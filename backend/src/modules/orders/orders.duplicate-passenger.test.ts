/**
 * createOrder 重复乘客强录（allowDuplicatePassengers）单测。
 *
 * 业务口径（0708 定）：同班次同证件号本会被拦（防重复占座），但客人有时线上重复订票且都已付款，
 * 后台需能强录回补。正解：
 *   - 后台 ADMIN/STAFF 带 allowDuplicatePassengers=true → 放行 + 写审计（FORCE_DUPLICATE_PASSENGERS）
 *     + 订单备注留痕；
 *   - 前台散客 / 客户 / AGENT 携带此 flag 一律无效（服务端按认证身份判权限），照旧拦（DUPLICATE_PASSENGER）。
 *
 * mock 风格对齐 orders.payment-timeout.test.ts：vi.mock Prisma + queue，spy 掉定价/护照，
 * 但**保留真实查重**（驱动 prisma.passenger.findMany 造冲突），以校验放行/拦截 + 审计 + 备注。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 在 import OrderService 之前 mock 依赖（vi.mock 会被 hoist） ──
const { mockPrisma } = vi.hoisted(() => {
  const prisma = {
    // update：syncOrderHasReturnLeg 在建单事务内回写物化列 hasReturnLeg
    order: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderCostItem: { create: vi.fn() },
    orderItem: { findMany: vi.fn() },
    // 真实查重会查这个：造冲突用
    passenger: { findMany: vi.fn() },
    // 出行人类型服务端权威派生（passengerToData）会查最早出发日；本文件不关心该派生，
    // 缺省无匹配班次 → 派生跳过（保留 passenger 里手填的 passengerType，不影响本文件断言）。
    flightSchedule: { findMany: vi.fn().mockResolvedValue([]) },
    seatLock: { aggregate: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    fulfillmentTask: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { mockPrisma: prisma };
});

// tx 与 prisma 共用同一批 vi.fn（事务体内 tx.* 与事务外 prisma.* 不区分）
const mockTx = mockPrisma;
mockPrisma.$transaction.mockImplementation(
  async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
);

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// mock queue，避免 createOrder 事务后 import 真连 Redis
vi.mock('../../queues/queue.js', () => ({
  scheduleSeatHoldRelease: vi.fn(),
  cancelSeatLockExpiry: vi.fn(),
}));

import { OrderService } from './orders.service.js';
import type { CreateOrderBody } from './orders.schemas.js';
import type { OrderRequester, GuestRequester } from './orders.service.js';

const flightItem = {
  kind: 'FLIGHT' as const,
  description: 'QH9589 澳门→岘港 经济舱',
  quantity: 1,
  flightScheduleId: 'sched-1',
  flightCabin: 'ECONOMY' as const,
};

const passenger = {
  fullName: '张三',
  documentType: 'PASSPORT' as const,
  documentNumber: 'E12345678',
  dateOfBirth: '1990-01-01',
  nationality: 'CN',
  passengerType: 'ADULT' as const,
  // 后台录单（ADMIN/STAFF）新建路径护照有效期必填
  passportExpiry: '2031-01-01',
};

function makeBody(allowDuplicatePassengers?: boolean): CreateOrderBody {
  return {
    contactName: '联系人',
    contactPhone: '13800000000',
    items: [flightItem],
    passengers: [passenger],
    ...(allowDuplicatePassengers !== undefined ? { allowDuplicatePassengers } : {}),
  } as unknown as CreateOrderBody;
}

/** 建 service 实例并 spy 掉定价/护照（保留真实查重逻辑）。 */
function makeService(): OrderService {
  const service = new OrderService();
  const priced = [
    {
      kind: 'FLIGHT' as const,
      description: flightItem.description,
      quantity: 1,
      unitPrice: 1000,
      amount: 1000,
      flightScheduleId: 'sched-1',
      flightCabin: 'ECONOMY' as const,
      businessUpgradeCount: undefined,
    },
  ];
  const anyService = service as unknown as Record<string, unknown>;
  vi.spyOn(anyService as never, 'priceAndValidateItems' as never).mockResolvedValue(priced as never);
  vi.spyOn(anyService as never, 'applyPassportExpiryRule' as never).mockResolvedValue(
    undefined as never,
  );
  return service;
}

/** 造一条同班次占座冲突（真实查重会返回它）。 */
function stageConflict(): void {
  mockPrisma.passenger.findMany.mockResolvedValue([
    { documentNumber: 'E12345678', order: { orderNumber: 'FTM-TEST-001' } },
  ]);
}

/** 事务体最小依赖 + 建单回显（happy path 走通所需）。 */
function stageHappyPath(): void {
  mockPrisma.seatLock.aggregate.mockResolvedValue({ _sum: { qty: 0 } });
  mockPrisma.seatLock.findMany.mockResolvedValue([]);
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.orderCostItem.create.mockResolvedValue({});
  mockPrisma.order.findUnique.mockResolvedValue({ visaStatus: null });
  mockPrisma.orderItem.findMany.mockResolvedValue([]);
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.order.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'ord1',
    orderNumber: args.data.orderNumber,
    notes: args.data.notes ?? null,
    total: 1000,
    paymentExpiresAt: args.data.paymentExpiresAt ?? null,
    items: [],
    passengers: [],
    statusEvents: [],
  }));
}

function notesPassedToCreate(): string | null {
  const call = mockPrisma.order.create.mock.calls[0];
  return (call[0] as { data: { notes: string | null } }).data.notes;
}

async function catchErr(
  p: Promise<unknown>,
): Promise<{ code?: string; message: string; details?: unknown }> {
  try {
    await p;
    throw new Error('expected rejection but resolved');
  } catch (e) {
    return e as { code?: string; message: string; details?: unknown };
  }
}

describe('createOrder 重复乘客强录 · allowDuplicatePassengers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );
  });

  it('不带 flag（CUSTOMER）→ 照旧拦：抛 DUPLICATE_PASSENGER（含证件号/订单号 + details.conflicts），不建单不审计', async () => {
    stageConflict();
    const service = makeService();
    const requester: OrderRequester = { userId: 'u1', role: 'CUSTOMER' };

    const err = await catchErr(service.createOrder(makeBody(), requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(err.message).toContain('E12345678');
    expect(err.message).toContain('FTM-TEST-001');
    expect(err.details).toEqual({
      conflicts: [{ documentNumber: 'E12345678', orderNumbers: ['FTM-TEST-001'] }],
    });
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('散客带 flag（CUSTOMER + allowDuplicatePassengers=true）→ 仍拦（身份不合法，flag 无效）', async () => {
    stageConflict();
    const service = makeService();
    const requester: OrderRequester = { userId: 'u1', role: 'CUSTOMER' };

    const err = await catchErr(service.createOrder(makeBody(true), requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('AGENT 带 flag → 仍拦（仅 ADMIN/STAFF 生效）', async () => {
    stageConflict();
    const service = makeService();
    const requester: OrderRequester = { userId: 'ag1', role: 'AGENT', agentId: 'agent-1' };

    const err = await catchErr(service.createOrder(makeBody(true), requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('STAFF 带 flag → 放行建单 + 写 FORCE_DUPLICATE_PASSENGERS 审计（WARNING，含操作人/冲突）+ 备注留痕', async () => {
    stageConflict();
    stageHappyPath();
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    const order = await service.createOrder(makeBody(true), requester);

    // 建单成功
    expect(order).toMatchObject({ id: 'ord1' });
    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);

    // 备注留痕：附加「重复乘客强录：与订单 FTM-TEST-001 同班次同证件号」
    const notes = notesPassedToCreate();
    expect(notes).toContain('重复乘客强录');
    expect(notes).toContain('FTM-TEST-001');

    // 审计：FORCE_DUPLICATE_PASSENGERS / WARNING / 操作人 / 冲突明细
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditData = mockPrisma.auditLog.create.mock.calls[0][0] as {
      data: { action: string; severity: string; actorUserId: string | null; after: unknown };
    };
    expect(auditData.data.action).toBe('FORCE_DUPLICATE_PASSENGERS');
    expect(auditData.data.severity).toBe('WARNING');
    expect(auditData.data.actorUserId).toBe('staff1');
    expect(auditData.data.after).toEqual({
      conflicts: [{ documentNumber: 'E12345678', orderNumbers: ['FTM-TEST-001'] }],
    });
  });

  it('STAFF 带 flag 但无冲突 → 正常建单，不加强录备注、不写 FORCE 审计', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]); // 无冲突
    stageHappyPath();
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    await service.createOrder(makeBody(true), requester);

    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);
    expect(notesPassedToCreate() ?? '').not.toContain('重复乘客强录');
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('游客带 flag → 仍拦（游客身份 flag 无效）', async () => {
    stageConflict();
    const service = makeService();
    const requester: GuestRequester = { guest: { name: '游客甲', phone: '13900000000' } };

    const err = await catchErr(service.createOrder(makeBody(true), requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 证件待补的同名乘客（占位单转正只填了姓名 → documentNumber 落库为空串）
//
// 只按证件号查重的旧口径量不到这种人：空串对不上任何真护照号。于是「占位单转正只填姓名 →
// 三天后护照到了、经办人没走补录而是在同一班次重新建了一张带真护照号的新单」这条路上，
// 闸静默放行 —— 同 3 个人占了 6 个座。第二把尺子（同班次 + 证件待补 + 同名）就是补这个洞。
// ══════════════════════════════════════════════════════════════════════════
describe('createOrder 重复乘客 · 同班次「证件待补」同名乘客', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );
  });

  /** 库里已有的一位「证件待补」乘客（占位单转正留下的），挂在同班次的另一张单上。 */
  function stagePendingDocumentConflict(over: Record<string, unknown> = {}): void {
    mockPrisma.passenger.findMany.mockResolvedValue([
      {
        documentNumber: '',
        lastName: null,
        firstName: null,
        fullName: '张三',
        chineseName: '张三',
        order: { orderNumber: 'FTM-HOLD-007' },
        ...over,
      },
    ]);
  }

  it('① 同班次已有空证件同名乘客 + 新单带真护照 → 拦，错误信息含旧单号并指路去补录', async () => {
    stagePendingDocumentConflict();
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    const err = await catchErr(service.createOrder(makeBody(), requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(err.message).toContain('FTM-HOLD-007');
    expect(err.message).toContain('张三');
    // 「去哪张单、做什么」必须写在错误里，否则经办人只会换个证件号再试一次。
    expect(err.message).toContain('请到该订单补录护照而不是重新建单');
    expect(err.details).toEqual({
      conflicts: [{ documentNumber: '', passengerName: '张三', orderNumbers: ['FTM-HOLD-007'] }],
    });
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('② STAFF 带 allowDuplicatePassengers → 放行建单 + 备注留痕 + FORCE 审计（与证件号命中同权）', async () => {
    stagePendingDocumentConflict();
    stageHappyPath();
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    const order = await service.createOrder(makeBody(true), requester);

    expect(order).toMatchObject({ id: 'ord1' });
    const notes = notesPassedToCreate();
    expect(notes).toContain('重复乘客强录');
    expect(notes).toContain('FTM-HOLD-007');
    // 备注要说清是哪一类命中：「对方证件待补」要采取的动作与「同证件号」完全不同。
    expect(notes).toContain('同班次同名（对方证件待补）');

    const auditData = mockPrisma.auditLog.create.mock.calls[0][0] as {
      data: { action: string; severity: string; after: unknown };
    };
    expect(auditData.data.action).toBe('FORCE_DUPLICATE_PASSENGERS');
    expect(auditData.data.severity).toBe('WARNING');
    expect(auditData.data.after).toEqual({
      conflicts: [{ documentNumber: '', passengerName: '张三', orderNumbers: ['FTM-HOLD-007'] }],
    });
  });

  // 查重的 where 本来就把候选圈在「本单各航段班次上的占座中订单」里；不同班次的同名乘客
  // 根本进不了候选集（查不出行）——重名在中文名里太常见，跨班次拦人只会天天误伤。
  it('③ 同名但不在同班次 → 不拦（候选集里根本没有这一行）', async () => {
    mockPrisma.passenger.findMany.mockResolvedValue([]);
    stageHappyPath();
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    await service.createOrder(makeBody(), requester);

    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);
    expect(notesPassedToCreate() ?? '').not.toContain('重复乘客强录');
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('④ 同班次有空证件乘客但姓名对不上 → 不拦（证件待补不等于谁都算重复）', async () => {
    stagePendingDocumentConflict({ fullName: '李四', chineseName: '李四' });
    stageHappyPath();
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };

    await service.createOrder(makeBody(), requester);

    expect(mockPrisma.order.create).toHaveBeenCalledTimes(1);
    expect(notesPassedToCreate() ?? '').not.toContain('重复乘客强录');
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  // 姓名比对键先拆再拼：录单两种写法（空格 / 斜线）都会出现，按原样比对会漏掉一半。
  it('拉丁姓名 `ZHANG SAN` 与库里的 `ZHANG/SAN` 算同一个人 → 拦', async () => {
    stagePendingDocumentConflict({ fullName: 'ZHANG/SAN', chineseName: null });
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };
    const body = makeBody();
    (body as unknown as { passengers: Array<Record<string, unknown>> }).passengers = [
      { ...passenger, fullName: 'ZHANG SAN' },
    ];

    const err = await catchErr(service.createOrder(body, requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(err.message).toContain('FTM-HOLD-007');
  });

  // 姓/名两栏优先于 fullName：航司标准写法录入的新单，同样要量得到库里只填了 fullName 的那位。
  it('新单填的是姓/名两栏（ZHANG + SAN）→ 与库里 fullName=`ZHANG/SAN` 命中', async () => {
    stagePendingDocumentConflict({ fullName: 'ZHANG/SAN', chineseName: null });
    const service = makeService();
    const requester: OrderRequester = { userId: 'staff1', role: 'STAFF' };
    const body = makeBody();
    (body as unknown as { passengers: Array<Record<string, unknown>> }).passengers = [
      { ...passenger, fullName: 'SOMEONE ELSE', lastName: 'ZHANG', firstName: 'SAN' },
    ];

    const err = await catchErr(service.createOrder(body, requester));

    expect(err.code).toBe('DUPLICATE_PASSENGER');
    expect(err.message).toContain('FTM-HOLD-007');
  });
});
