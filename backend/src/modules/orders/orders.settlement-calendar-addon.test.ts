/**
 * 结算价日历 × 加项净额叠加 · 服务级单测（vitest，mock Prisma + 结算价查价，不依赖真 DB）
 *
 * 口径（0805 指定酒店批修正）：日历价是「基础随机套餐」的每人同业价，
 * 加项净额（升舱/单房差/婴儿价/儿童折扣/自备签减免/指定酒店加价，未打折）按报价口径
 * 叠加其上：结算总价 = Σ(每人价 × 人数 + 行加项净额)。
 * 修正前日历价裸收敛，任何加项都会被 SETTLEMENT 差额行吞掉（代理日历单升舱等于白升）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetSettlementRate } = vi.hoisted(() => ({
  mockPrisma: {
    bundle: { findMany: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
  },
  mockGetSettlementRate: vi.fn(),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../settlement-rates/settlement-rates.service.js', () => ({
  getSettlementRate: mockGetSettlementRate,
}));
// localDate 仅用于把班次 departureTime 折成出发地本地日；此处固定为测试日期，聚焦叠加口径。
vi.mock('../finances/finances.cost.service.js', () => ({
  localDate: vi.fn(() => '2026-09-01'),
}));

import { OrderService } from './orders.service.js';
import type { CreateOrderBody } from './orders.schemas.js';

const service = new OrderService();

type CalendarResult = { totalCny: number; audit: { lines: Array<Record<string, unknown>> } } | null;
const resolveCalendar = (body: CreateOrderBody, nets?: number[]): Promise<CalendarResult> =>
  (
    service as unknown as {
      resolveBundleSettlementCalendarTotal: (
        b: CreateOrderBody,
        n?: number[],
      ) => Promise<CalendarResult>;
    }
  ).resolveBundleSettlementCalendarTotal(body, nets);

/** 最小订单体：1 条 FLIGHT 航段（定位出发日）+ 1 条 2 成人 BUNDLE 行。 */
function baseBody(): CreateOrderBody {
  return {
    items: [
      {
        kind: 'FLIGHT',
        description: 'QH9588 MFM→DAD',
        quantity: 2,
        unitPrice: 0,
        flightScheduleId: 's-1',
        flightCabin: 'ECONOMY',
        bundleId: 'b-1',
      },
      {
        kind: 'BUNDLE',
        description: '三星 2天1晚',
        quantity: 1,
        unitPrice: 0,
        bundleId: 'b-1',
        adultCount: 2,
        childCount: 0,
        infantCount: 0,
      },
    ],
  } as unknown as CreateOrderBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.bundle.findMany.mockResolvedValue([
    { id: 'b-1', name: '三星 2天1晚', settlementTier: 'THREE_STAR', settlementNights: 1 },
  ]);
  mockPrisma.flightSchedule.findMany.mockResolvedValue([
    { departureTime: new Date('2026-09-01T00:30:00Z'), departureTz: 'Asia/Macau' },
  ]);
  mockGetSettlementRate.mockResolvedValue({ pricePerPersonCny: 1500 });
});

describe('resolveBundleSettlementCalendarTotal · 加项净额叠加在日历价之上', () => {
  it('无加项（净额缺省）→ 结算总价 = 每人价 × 人数（与修正前完全一致）', async () => {
    const r = await resolveCalendar(baseBody());
    expect(r).not.toBeNull();
    expect(r!.totalCny).toBe(3000);
  });

  it('正加项（如升舱/指定酒店加价）→ 叠加进结算总价并落审计行', async () => {
    const r = await resolveCalendar(baseBody(), [740]);
    expect(r!.totalCny).toBe(3740);
    const line = r!.audit.lines[0];
    expect(line.addOnCny).toBe(740);
    expect(String(line.note)).toContain('加项 +¥740');
  });

  it('负加项（如儿童折扣/自备签减免）→ 从结算总价里减', async () => {
    const r = await resolveCalendar(baseBody(), [-100]);
    expect(r!.totalCny).toBe(2900);
    expect(String(r!.audit.lines[0].note)).toContain('加项 −¥100');
  });

  it('未配日历键的套餐 → 返回 null（现状不变，不进结算收敛）', async () => {
    mockPrisma.bundle.findMany.mockResolvedValue([
      { id: 'b-1', name: '老套餐', settlementTier: null, settlementNights: null },
    ]);
    const r = await resolveCalendar(baseBody(), [740]);
    expect(r).toBeNull();
  });
});
