/**
 * 票号回填（单人）· 校验内核 + schema + service 测试（vitest，vi.mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. ticket-number.ts 内核：归一化只去空格/连字符、PNR 5–8 位、票号 10–17 位（真实 13 与沙箱 17 都放行）
 *   2. updatePassengerTicketBodySchema：clear 与给值互斥、至少给一个、null 单字段清空、strict 白名单
 *   3. updatePassengerTicket（service）：
 *      - 非 ADMIN/STAFF → 403
 *      - 订单不存在 / 在回收站 → 404 / 409
 *      - 出行人不属于该单 → 404
 *      - 写入 / 单字段保持 / clear 全清 / 回填同一个号（幂等，不写库）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRole } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn() },
    passenger: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  writeAuditWithinTx: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { OrderService } from './orders.service.js';
import { updatePassengerTicketBodySchema } from './orders.schemas.js';
import {
  isValidEticketNumber,
  isValidPnr,
  normalizeEticketNumber,
  normalizePnr,
} from './ticket-number.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

const service = new OrderService();
const ADMIN = { userId: 'admin1', role: UserRole.ADMIN };
const STAFF = { userId: 'staff1', role: UserRole.STAFF };

const ORDER_ROW = { id: 'o1', orderNumber: 'FTM2026090100001', deletedAt: null };

beforeEach(() => {
  mockPrisma.order.findUnique.mockReset();
  mockPrisma.passenger.findUnique.mockReset();
  mockPrisma.passenger.findUniqueOrThrow.mockReset();
  mockPrisma.passenger.update.mockReset();
});

// ── 1. 校验内核 ──────────────────────────────────────────────────────────
describe('ticket-number 归一化与校验', () => {
  it('PNR 归一化：去空格与连字符并大写', () => {
    expect(normalizePnr(' 7qr-s9k ')).toBe('7QRS9K');
  });

  it('PNR 5 位与 8 位都放行，4 位与 9 位拒绝', () => {
    expect(isValidPnr(normalizePnr('ABC12'))).toBe(true);
    expect(isValidPnr(normalizePnr('ABC12345'))).toBe(true);
    expect(isValidPnr(normalizePnr('ABC1'))).toBe(false);
    expect(isValidPnr(normalizePnr('ABC123456'))).toBe(false);
  });

  it('PNR 去掉分隔符后仍含非字母数字 → 拒绝', () => {
    expect(isValidPnr(normalizePnr('AB#12'))).toBe(false);
  });

  it('票号归一化：票面 784-1234567890 → 13 位纯数字', () => {
    expect(normalizeEticketNumber('784-1234567890')).toBe('7841234567890');
    expect(isValidEticketNumber(normalizeEticketNumber('784-1234567890'))).toBe(true);
  });

  it('真实 13 位与沙箱 17 位都放行；9 位与 18 位拒绝', () => {
    expect(isValidEticketNumber(normalizeEticketNumber('1234567890123'))).toBe(true);
    expect(isValidEticketNumber(normalizeEticketNumber('12345678901234567'))).toBe(true);
    expect(isValidEticketNumber(normalizeEticketNumber('123456789'))).toBe(false);
    expect(isValidEticketNumber(normalizeEticketNumber('123456789012345678'))).toBe(false);
  });

  it('票号里混进字母 → 拒绝（绝不悄悄剪成一个合法长度的假号）', () => {
    expect(isValidEticketNumber(normalizeEticketNumber('784ABC1234567890'))).toBe(false);
  });
});

// ── 2. Schema ────────────────────────────────────────────────────────────
describe('updatePassengerTicketBodySchema', () => {
  it('空 body → 拒绝（至少给一个值，或显式 clear）', () => {
    expect(() => updatePassengerTicketBodySchema.parse({})).toThrow();
  });

  it('写入：归一化后落库值大写去分隔符', () => {
    const parsed = updatePassengerTicketBodySchema.parse({
      pnr: ' 7qr-s9k ',
      eticketNumber: '784-1234567890',
    });
    expect(parsed.pnr).toBe('7QRS9K');
    expect(parsed.eticketNumber).toBe('7841234567890');
  });

  it('单字段 null = 只清这一个字段', () => {
    expect(updatePassengerTicketBodySchema.parse({ pnr: null })).toEqual({ pnr: null });
  });

  it('clear:true 与给值同时提交 → 拒绝（不猜意图）', () => {
    expect(() => updatePassengerTicketBodySchema.parse({ clear: true, pnr: 'ABC12' })).toThrow();
  });

  it('clear:true 单独提交 → 通过', () => {
    expect(updatePassengerTicketBodySchema.parse({ clear: true })).toEqual({ clear: true });
  });

  it('PNR 格式不合法 → 拒绝', () => {
    expect(() => updatePassengerTicketBodySchema.parse({ pnr: 'AB' })).toThrow();
  });

  it('票号格式不合法 → 拒绝', () => {
    expect(() => updatePassengerTicketBodySchema.parse({ eticketNumber: '12345' })).toThrow();
  });

  it('未知字段 → 拒绝（.strict）', () => {
    expect(() =>
      updatePassengerTicketBodySchema.parse({ pnr: 'ABC12', fullName: 'NEW NAME' }),
    ).toThrow();
  });
});

// ── 3. Service ───────────────────────────────────────────────────────────
describe('updatePassengerTicket', () => {
  it('非 ADMIN/STAFF（代理）→ 403，且一次库都不查', async () => {
    const err = await service
      .updatePassengerTicket('o1', 'p1', { pnr: 'ABC12' }, { userId: 'a1', role: UserRole.AGENT })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('订单不存在 → 404', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const err = await service
      .updatePassengerTicket('o1', 'p1', { pnr: 'ABC12' }, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('订单在回收站 → 409（先恢复再回填）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...ORDER_ROW, deletedAt: new Date() });
    const err = await service
      .updatePassengerTicket('o1', 'p1', { pnr: 'ABC12' }, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
  });

  it('出行人不属于该订单 → 404', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ORDER_ROW);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'OTHER',
      fullName: 'ZHANG/SAN',
      pnr: null,
      eticketNumber: null,
    });
    const err = await service
      .updatePassengerTicket('o1', 'p1', { pnr: 'ABC12' }, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('把沙箱 17 位号换成真实 13 位票号：两个字段都记进 changedFields', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ORDER_ROW);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      fullName: 'ZHANG/SAN',
      pnr: 'XKCD01',
      eticketNumber: '12345678901234567',
    });
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      pnr: '7QRS9K',
      eticketNumber: '7841234567890',
    });

    const res = await service.updatePassengerTicket(
      'o1',
      'p1',
      { pnr: '7QRS9K', eticketNumber: '7841234567890' },
      STAFF,
    );
    expect(res.before).toEqual({ pnr: 'XKCD01', eticketNumber: '12345678901234567' });
    expect(res.after).toEqual({ pnr: '7QRS9K', eticketNumber: '7841234567890' });
    expect(res.changedFields).toEqual(['pnr', 'eticketNumber']);
    expect(res.orderNumber).toBe('FTM2026090100001');
    expect(res.passengerName).toBe('ZHANG/SAN');
  });

  it('只给 PNR：票号原样不动（未传的字段不碰）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ORDER_ROW);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      fullName: 'ZHANG/SAN',
      pnr: null,
      eticketNumber: '7841234567890',
    });
    mockPrisma.passenger.update.mockResolvedValue({
      id: 'p1',
      pnr: 'ABC12',
      eticketNumber: '7841234567890',
    });

    const res = await service.updatePassengerTicket('o1', 'p1', { pnr: 'ABC12' }, ADMIN);
    expect(mockPrisma.passenger.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { pnr: 'ABC12', eticketNumber: '7841234567890' },
    });
    expect(res.changedFields).toEqual(['pnr']);
  });

  it('clear:true → 两个字段一起清空', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ORDER_ROW);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      fullName: 'ZHANG/SAN',
      pnr: 'ABC12',
      eticketNumber: '7841234567890',
    });
    mockPrisma.passenger.update.mockResolvedValue({ id: 'p1', pnr: null, eticketNumber: null });

    const res = await service.updatePassengerTicket('o1', 'p1', { clear: true }, ADMIN);
    expect(mockPrisma.passenger.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { pnr: null, eticketNumber: null },
    });
    expect(res.after).toEqual({ pnr: null, eticketNumber: null });
    expect(res.changedFields).toEqual(['pnr', 'eticketNumber']);
  });

  it('回填的号与库里一模一样 → 不写库，changedFields 为空（幂等，不是错误）', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(ORDER_ROW);
    mockPrisma.passenger.findUnique.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      fullName: 'ZHANG/SAN',
      pnr: 'ABC12',
      eticketNumber: '7841234567890',
    });
    mockPrisma.passenger.findUniqueOrThrow.mockResolvedValue({
      id: 'p1',
      pnr: 'ABC12',
      eticketNumber: '7841234567890',
    });

    const res = await service.updatePassengerTicket(
      'o1',
      'p1',
      { pnr: 'ABC12', eticketNumber: '7841234567890' },
      ADMIN,
    );
    expect(mockPrisma.passenger.update).not.toHaveBeenCalled();
    expect(res.changedFields).toEqual([]);
  });
});
