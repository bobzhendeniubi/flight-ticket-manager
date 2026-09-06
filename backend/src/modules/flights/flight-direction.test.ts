/**
 * 航班去 / 回程判定 flight-direction · 纯函数单测（vitest，不连库）。
 *
 * 守两条：
 *   1) 方向来自活跃航线表，不来自任何写死的机场码——换一条线，判定跟着换；
 *   2) 航线表里查不到的线返回 UNKNOWN，不猜（宁可不涂色，也不把去程画成回程）。
 */
import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { loadOutboundRouteKeys, resolveFlightDirection } from './flight-direction.js';

/** 假 Prisma：三张表各喂一组行，形状与 loadOutboundRouteKeys 需要的最小接口一致。 */
function fakeClient(opts: {
  rates?: string[];
  rules?: string[];
  bundles?: {
    outboundFlight?: { originCode: string | null; destinationCode: string | null } | null;
    returnFlight?: { originCode: string | null; destinationCode: string | null } | null;
  }[];
}): PrismaClient {
  return {
    settlementRate: {
      findMany: async () => (opts.rates ?? []).map((routeKey) => ({ routeKey })),
    },
    settlementDiscountRule: {
      findMany: async () => (opts.rules ?? []).map((routeKey) => ({ routeKey })),
    },
    bundle: {
      findMany: async () =>
        (opts.bundles ?? []).map((b) => ({
          outboundFlight: b.outboundFlight ?? null,
          returnFlight: b.returnFlight ?? null,
        })),
    },
  } as unknown as PrismaClient;
}

describe('resolveFlightDirection', () => {
  const keys = new Set(['MFM-DAD']);

  it('命中航线表的正向 = 去程', () => {
    expect(resolveFlightDirection('MFM', 'DAD', keys)).toBe('OUTBOUND');
  });

  it('命中航线表的反向 = 回程', () => {
    expect(resolveFlightDirection('DAD', 'MFM', keys)).toBe('RETURN');
  });

  it('航线表里没有这条线时返回 UNKNOWN（不猜）', () => {
    expect(resolveFlightDirection('MFM', 'KIX', keys)).toBe('UNKNOWN');
    expect(resolveFlightDirection('KIX', 'MFM', keys)).toBe('UNKNOWN');
  });

  it('起降地缺失（脏数据）返回 UNKNOWN', () => {
    expect(resolveFlightDirection(null, 'DAD', keys)).toBe('UNKNOWN');
    expect(resolveFlightDirection('MFM', '  ', keys)).toBe('UNKNOWN');
  });

  it('大小写 / 空白不影响判定', () => {
    expect(resolveFlightDirection(' mfm ', 'dad', keys)).toBe('OUTBOUND');
  });

  it('两个方向都被当去程备过价时按去程优先，结果稳定', () => {
    const both = new Set(['MFM-DAD', 'DAD-MFM']);
    expect(resolveFlightDirection('MFM', 'DAD', both)).toBe('OUTBOUND');
    expect(resolveFlightDirection('DAD', 'MFM', both)).toBe('OUTBOUND');
  });

  it('换一条线（起飞地不是澳门）照样能判出去程', () => {
    const newLine = new Set(['CAN-KIX']);
    expect(resolveFlightDirection('CAN', 'KIX', newLine)).toBe('OUTBOUND');
    expect(resolveFlightDirection('KIX', 'CAN', newLine)).toBe('RETURN');
  });
});

describe('loadOutboundRouteKeys', () => {
  it('并集三个来源：结算价日历、立减规则、活跃套餐派生', async () => {
    const keys = await loadOutboundRouteKeys(
      fakeClient({
        rates: ['MFM-DAD'],
        rules: ['CAN-KIX'],
        bundles: [{ outboundFlight: { originCode: 'SZX', destinationCode: 'BKK' } }],
      }),
    );
    expect([...keys].sort()).toEqual(['CAN-KIX', 'MFM-DAD', 'SZX-BKK']);
  });

  it('套餐只绑回程时反推去程方向', async () => {
    const keys = await loadOutboundRouteKeys(
      fakeClient({ bundles: [{ returnFlight: { originCode: 'DAD', destinationCode: 'MFM' } }] }),
    );
    expect([...keys]).toEqual(['MFM-DAD']);
  });

  it('套餐去程绑定优先于回程（回程脏数据不参与）', async () => {
    const keys = await loadOutboundRouteKeys(
      fakeClient({
        bundles: [
          {
            outboundFlight: { originCode: 'MFM', destinationCode: 'DAD' },
            returnFlight: { originCode: 'XXX', destinationCode: 'YYY' },
          },
        ],
      }),
    );
    expect([...keys]).toEqual(['MFM-DAD']);
  });

  it('脏航线键（缺段 / 空段）不进集合', async () => {
    const keys = await loadOutboundRouteKeys(
      fakeClient({ rates: ['MFM', 'MFM-DAD-NRT', '-DAD', ''] }),
    );
    expect(keys.size).toBe(0);
  });

  it('套餐两段都没绑时不贡献航线', async () => {
    const keys = await loadOutboundRouteKeys(fakeClient({ bundles: [{}] }));
    expect(keys.size).toBe(0);
  });
});
