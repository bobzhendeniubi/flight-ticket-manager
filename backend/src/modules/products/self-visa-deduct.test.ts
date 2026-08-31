/**
 * 自备签减免费率解析（null = 跟随签证组件产品价）· 单测（mock Prisma）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { visa: { findMany: vi.fn() } },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { Prisma } from '@prisma/client';
import {
  bundleVisaIds,
  resolveSelfVisaDeductCny,
  resolveSelfVisaDeductCnyBatch,
} from './self-visa-deduct.js';

beforeEach(() => vi.clearAllMocks());

describe('bundleVisaIds', () => {
  it('抽取 VISA 组件的 visaId；非数组/畸形记录一律忽略', () => {
    expect(
      bundleVisaIds([
        { kind: 'VISA', visaId: 'v1' },
        { kind: 'HOTEL', qty: 5 },
        { kind: 'VISA' }, // 缺 visaId
        { kind: 'VISA', visaId: '' }, // 空串
        null,
        { kind: 'VISA', visaId: 'v2' },
      ]),
    ).toEqual(['v1', 'v2']);
    expect(bundleVisaIds('not-an-array')).toEqual([]);
    expect(bundleVisaIds(null)).toEqual([]);
  });
});

describe('resolveSelfVisaDeductCny', () => {
  it('显式覆盖值（含 0）直接生效，不触库', async () => {
    expect(await resolveSelfVisaDeductCny({ selfVisaDeductCny: 240, items: [] })).toBe(240);
    expect(await resolveSelfVisaDeductCny({ selfVisaDeductCny: 0, items: [{ kind: 'VISA', visaId: 'v1' }] })).toBe(0);
    expect(mockPrisma.visa.findMany).not.toHaveBeenCalled();
  });

  it('null → 按签证组件产品价合计（多组件相加）', async () => {
    mockPrisma.visa.findMany.mockResolvedValue([
      { basePrice: new Prisma.Decimal(240) },
      { basePrice: new Prisma.Decimal(110) },
    ]);
    expect(
      await resolveSelfVisaDeductCny({
        selfVisaDeductCny: null,
        items: [
          { kind: 'VISA', visaId: 'v1' },
          { kind: 'VISA', visaId: 'v2' },
        ],
      }),
    ).toBe(350);
  });

  it('null + 无签证组件 → 0（不触库）', async () => {
    expect(await resolveSelfVisaDeductCny({ selfVisaDeductCny: null, items: [{ kind: 'HOTEL' }] })).toBe(0);
    expect(mockPrisma.visa.findMany).not.toHaveBeenCalled();
  });

  it('null + visaId 查不到产品（已删）→ 0，不抛错', async () => {
    mockPrisma.visa.findMany.mockResolvedValue([]);
    expect(
      await resolveSelfVisaDeductCny({ selfVisaDeductCny: null, items: [{ kind: 'VISA', visaId: 'gone' }] }),
    ).toBe(0);
  });
});

describe('resolveSelfVisaDeductCnyBatch', () => {
  it('混合批量：覆盖值原样、跟随的按产品价、一次查库', async () => {
    mockPrisma.visa.findMany.mockResolvedValue([
      { id: 'v1', basePrice: new Prisma.Decimal(240) },
      { id: 'v2', basePrice: new Prisma.Decimal(350) },
    ]);
    const out = await resolveSelfVisaDeductCnyBatch([
      { id: 'b-override', selfVisaDeductCny: 180, items: [{ kind: 'VISA', visaId: 'v1' }] },
      { id: 'b-follow', selfVisaDeductCny: null, items: [{ kind: 'VISA', visaId: 'v1' }] },
      { id: 'b-follow2', selfVisaDeductCny: null, items: [{ kind: 'VISA', visaId: 'v2' }] },
      { id: 'b-zero', selfVisaDeductCny: 0, items: [] },
      { id: 'b-novisa', selfVisaDeductCny: null, items: [{ kind: 'HOTEL' }] },
    ]);
    expect(out.get('b-override')).toBe(180);
    expect(out.get('b-follow')).toBe(240);
    expect(out.get('b-follow2')).toBe(350);
    expect(out.get('b-zero')).toBe(0);
    expect(out.get('b-novisa')).toBe(0);
    expect(mockPrisma.visa.findMany).toHaveBeenCalledTimes(1);
  });

  it('全部为覆盖值 → 零查库', async () => {
    const out = await resolveSelfVisaDeductCnyBatch([
      { id: 'a', selfVisaDeductCny: 240, items: [] },
    ]);
    expect(out.get('a')).toBe(240);
    expect(mockPrisma.visa.findMany).not.toHaveBeenCalled();
  });
});
