/**
 * 录单车队成本快照 · 服务级单测（vitest，mock Prisma）
 *
 * 覆盖 priceAndValidateItems 的 TRANSFER 分支：
 *   1. 人民币结算价：unitCostCny / totalCostCny 与改前一致，metadata.costSource 记 { CNY, unitAmount }，
 *      不查汇率表、不查班次。
 *   2. 越南盾结算价：按服务日（本单无航段 → 今天）生效的 VND 汇率行折人民币；metadata.costSource 记
 *      原币 / 汇率名 / 汇率 / 生效日 / 按哪天折（fxDateBasis）；原有 metadata key 原样保留。
 *   3. 越南盾缺汇率：成本两栏 undefined（毛利「未知」，不落 0），costSource 标 missingFx。
 * 售价（unitPrice / amount）在三种情况下都不变 —— 只改成本侧。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    transfer: { findUnique: vi.fn() },
    fxRate: { findMany: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
    bundle: { findUnique: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import type { OrderItemInput } from './orders.schemas.js';

type PricedRow = {
  kind: string;
  unitPrice: number;
  amount: number;
  unitCostCny?: number;
  totalCostCny?: number;
  metadata?: Record<string, unknown>;
};
type PriceFn = (
  items: OrderItemInput[],
  flightSettlementPriceCny?: number,
  passengers?: unknown,
  allowClientPricedGround?: boolean,
) => Promise<PricedRow[]>;

const service = new OrderService();
const priceItems = (service as unknown as { priceAndValidateItems: PriceFn }).priceAndValidateItems.bind(service);

const dec = (n: number) => new Prisma.Decimal(n);

const transferRow = (): OrderItemInput =>
  ({
    kind: 'TRANSFER',
    description: '机场接送',
    quantity: 2,
    unitPrice: 300,
    transferId: 't1',
    metadata: { note: '航站楼 2 号门' },
  }) as unknown as OrderItemInput;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.flightSchedule.findMany.mockResolvedValue([]);
  mockPrisma.fxRate.findMany.mockResolvedValue([]);
});

describe('priceAndValidateItems · 车队成本快照（人民币 / 越南盾）', () => {
  it('人民币结算价：成本两栏与改前一致，costSource 记人民币，不查汇率表也不查班次', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValue({
      basePrice: dec(300),
      costPriceCny: dec(200),
      costPriceVnd: null,
      costFxName: null,
      isActive: true,
    });
    const [row] = await priceItems([transferRow()], undefined, undefined, true);
    expect(row).toMatchObject({ kind: 'TRANSFER', unitPrice: 300, amount: 600, unitCostCny: 200, totalCostCny: 400 });
    expect(row!.metadata).toEqual({ note: '航站楼 2 号门', costSource: { currency: 'CNY', unitAmount: 200 } });
    expect(mockPrisma.fxRate.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.flightSchedule.findMany).not.toHaveBeenCalled();
  });

  it('越南盾结算价：按服务日生效的 VND 汇率行折人民币，costSource 记原币 / 汇率 / 按哪天折，原 metadata 保留', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValue({
      basePrice: dec(300),
      costPriceCny: null,
      costPriceVnd: dec(3_740_000),
      costFxName: '车队越南盾',
      isActive: true,
    });
    mockPrisma.fxRate.findMany.mockResolvedValue([
      {
        id: 'fx1',
        name: '车队越南盾',
        currency: 'VND',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        rate: dec(3740),
        note: null,
        updatedBy: null,
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    const [row] = await priceItems([transferRow()], undefined, undefined, true);
    // 3,740,000 ÷ 3740 = ¥1000/份 × 2 份；售价不动
    expect(row).toMatchObject({ kind: 'TRANSFER', unitPrice: 300, amount: 600, unitCostCny: 1000, totalCostCny: 2000 });
    expect(row!.metadata).toMatchObject({
      note: '航站楼 2 号门',
      costSource: {
        currency: 'VND',
        unitAmount: 3_740_000,
        fxName: '车队越南盾',
        fxRate: 3740,
        fxEffectiveFrom: '2026-01-01',
        // 本单没有航段、订单尚未落库 → 按今天折
        fxDateBasis: 'TODAY',
      },
    });
    expect((row!.metadata!.costSource as { fxDate: string }).fxDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockPrisma.fxRate.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.fxRate.findMany.mock.calls[0]![0].where).toMatchObject({ currency: 'VND' });
  });

  it('越南盾缺汇率：成本两栏留空（不落 0），costSource 标 missingFx；售价不动', async () => {
    mockPrisma.transfer.findUnique.mockResolvedValue({
      basePrice: dec(300),
      costPriceCny: null,
      costPriceVnd: dec(3_740_000),
      costFxName: '车队越南盾',
      isActive: true,
    });
    const [row] = await priceItems([transferRow()], undefined, undefined, true);
    expect(row).toMatchObject({ kind: 'TRANSFER', unitPrice: 300, amount: 600 });
    expect(row!.unitCostCny).toBeUndefined();
    expect(row!.totalCostCny).toBeUndefined();
    expect(row!.metadata).toMatchObject({
      costSource: { currency: 'VND', unitAmount: 3_740_000, fxRate: null, missingFx: true },
    });
  });
});
