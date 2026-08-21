/**
 * 签证台：出签后补录 出签日/生效日/有效期（M2）· 服务级测试（vitest，vi.mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. updatePassengerVisaDatesBodySchema：至少一个字段（空 body 拒绝）、日期格式校验、null 允许清空、签证号长度校验
 *   2. updatePassengerVisaDates（service）：
 *      - 非 ADMIN/STAFF → 403 ForbiddenError
 *      - 订单不存在 → 404 NotFoundError
 *      - 出行人不存在或不属于该订单 → 404 NotFoundError
 *      - happy path：写入签证号和三字段，返回 before/after（YYYY-MM-DD）
 *      - 清空（null）：字段写为 null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: {
      findUnique: vi.fn(),
    },
    passenger: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

// audit 由路由层调用；mock 掉避免真写库
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService } from './orders.service.js';
import { updatePassengerVisaDatesBodySchema } from './orders.schemas.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin1', role: UserRole.ADMIN };
const STAFF = { userId: 'staff1', role: UserRole.STAFF };

beforeEach(() => {
  mockPrisma.order.findUnique.mockReset();
  mockPrisma.passenger.findUnique.mockReset();
  mockPrisma.passenger.update.mockReset();
});

// ── 1. Schema ────────────────────────────────────────────────────────────
describe('updatePassengerVisaDatesBodySchema', () => {
  it('空 body → 拒绝（至少提供一个字段）', () => {
    expect(() => updatePassengerVisaDatesBodySchema.parse({})).toThrow();
  });

  it('单个字段合法 YYYY-MM-DD → 通过', () => {
    const parsed = updatePassengerVisaDatesBodySchema.parse({ visaIssueDate: '2026-07-01' });
    expect(parsed).toEqual({ visaIssueDate: '2026-07-01' });
  });

  it('签证号合法 → 通过并保留原文', () => {
    const parsed = updatePassengerVisaDatesBodySchema.parse({ visaNumber: 'VISA-2026-001' });
    expect(parsed).toEqual({ visaNumber: 'VISA-2026-001' });
  });

  it('签证号超过 40 个字符 → 拒绝', () => {
    expect(() => updatePassengerVisaDatesBodySchema.parse({ visaNumber: 'X'.repeat(41) })).toThrow();
  });

  it('null 表示清空 → 通过', () => {
    const parsed = updatePassengerVisaDatesBodySchema.parse({
      visaIssueDate: null,
      visaEffectiveDate: null,
      visaExpiry: null,
    });
    expect(parsed).toEqual({ visaIssueDate: null, visaEffectiveDate: null, visaExpiry: null });
  });

  it('格式非 YYYY-MM-DD → 拒绝', () => {
    expect(() => updatePassengerVisaDatesBodySchema.parse({ visaIssueDate: '2026/07/01' })).toThrow();
  });

  it('未知字段（非白名单）→ 拒绝（.strict）', () => {
    expect(() =>
      updatePassengerVisaDatesBodySchema.parse({ visaIssueDate: '2026-07-01', fullName: 'NEW NAME' }),
    ).toThrow();
  });
});

// ── 2. Service ───────────────────────────────────────────────────────────
describe('updatePassengerVisaDates', () => {
  const orderRow = { id: 'o1', orderNumber: 'FTM20260709001' };

  it('非 ADMIN/STAFF（如 AGENT）→ 403 ForbiddenError，不查库', async () => {
    const err = await service
      .updatePassengerVisaDates('o1', 'p1', { visaIssueDate: '2026-07-01' }, {
        userId: 'agent1',
        role: UserRole.AGENT,
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('订单不存在 → 404 NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await expect(
      service.updatePassengerVisaDates('missing', 'p1', { visaIssueDate: '2026-07-01' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('出行人不属于该订单 → 404 NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'other-order',
      visaIssueDate: null,
      visaEffectiveDate: null,
      visaExpiry: null,
    });
    await expect(
      service.updatePassengerVisaDates('o1', 'p1', { visaIssueDate: '2026-07-01' }, STAFF),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('出行人不存在 → 404 NotFoundError', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);
    mockPrisma.passenger.findUnique.mockResolvedValue(null);
    await expect(
      service.updatePassengerVisaDates('o1', 'missing-p', { visaIssueDate: '2026-07-01' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('happy path：写入签证号和三字段（Date 对象），before/after 以规范值返回', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      visaNumber: null,
      visaIssueDate: null,
      visaEffectiveDate: null,
      visaExpiry: null,
    });
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      fullName: 'ZHANG SAN',
      visaNumber: 'VISA-2026-001',
      visaIssueDate: new Date('2026-07-01'),
      visaEffectiveDate: new Date('2026-07-05'),
      visaExpiry: new Date('2026-10-01'),
    });

    const result = await service.updatePassengerVisaDates(
      'o1',
      'p1',
      {
        visaNumber: 'VISA-2026-001',
        visaIssueDate: '2026-07-01',
        visaEffectiveDate: '2026-07-05',
        visaExpiry: '2026-10-01',
      },
      ADMIN,
    );

    const updateArg = mockPrisma.passenger.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'p1' });
    expect(updateArg.data.visaIssueDate).toBeInstanceOf(Date);
    expect(updateArg.data.visaEffectiveDate).toBeInstanceOf(Date);
    expect(updateArg.data.visaExpiry).toBeInstanceOf(Date);
    expect(updateArg.data.visaNumber).toBe('VISA-2026-001');

    expect(result.orderNumber).toBe('FTM20260709001');
    expect(result.before).toEqual({
      visaNumber: null,
      visaIssueDate: null,
      visaEffectiveDate: null,
      visaExpiry: null,
    });
    expect(result.after).toEqual({
      visaNumber: 'VISA-2026-001',
      visaIssueDate: '2026-07-01',
      visaEffectiveDate: '2026-07-05',
      visaExpiry: '2026-10-01',
    });
  });

  it('清空（null）：仅传 visaExpiry:null → 只清该字段，其余字段不进 update.data', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRow);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      visaNumber: 'VISA-OLD',
      visaIssueDate: new Date('2026-07-01'),
      visaEffectiveDate: new Date('2026-07-05'),
      visaExpiry: new Date('2026-10-01'),
    });
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      fullName: 'ZHANG SAN',
      visaNumber: 'VISA-OLD',
      visaIssueDate: new Date('2026-07-01'),
      visaEffectiveDate: new Date('2026-07-05'),
      visaExpiry: null,
    });

    const result = await service.updatePassengerVisaDates('o1', 'p1', { visaExpiry: null }, STAFF);

    const updateArg = mockPrisma.passenger.update.mock.calls[0][0];
    expect(Object.keys(updateArg.data)).toEqual(['visaExpiry']);
    expect(updateArg.data.visaExpiry).toBeNull();
    expect(result.before).toEqual({
      visaNumber: 'VISA-OLD',
      visaIssueDate: '2026-07-01',
      visaEffectiveDate: '2026-07-05',
      visaExpiry: '2026-10-01',
    });
    expect(result.after.visaNumber).toBe('VISA-OLD');
    expect(result.before.visaExpiry).toBe('2026-10-01');
    expect(result.after.visaExpiry).toBeNull();
  });
});
