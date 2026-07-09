/**
 * OTA 线上单快速入单 · batchCreateOrders 手动结算单价（manualUnitPriceCny）· 服务级单测
 * （vitest，mock Prisma + spy 私有定价/建单方法，不依赖真 DB）
 *
 * 覆盖任务硬性要求：
 *   1. 权限：散客/AGENT 携带 manualUnitPriceCny → BadRequestError（400），且未触库（早于任何 prisma）。
 *   2. 调整行金额 = 手动价 − 系统权威价：正 → MISC_FEE、负 → DISCOUNT、相等 → 不加调整行。
 *   3. 审计内容：调整行 reasonText 记「OTA 结算价 ¥X/人」，随 createOrder 的 priceAdjustment 审计路径落库
 *      （真 DB 全链路审计见 orders.price-adjustment.integration.test.ts；此处校验交给 createOrder 的
 *       载荷 reasonCode/reasonText 正确——即最终写入 AuditLog 的内容）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    order: { create: vi.fn(), findUnique: vi.fn() },
    orderItem: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { OrderService } from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';
import type { BatchCreateOrdersBody, PriceAdjustmentInput } from './orders.schemas.js';

const service = new OrderService();

/** FLIGHT_ONEWAY 批量单基础 body（不含手动价；测试逐个覆盖 manualUnitPriceCny）。 */
function baseBody(overrides: Partial<BatchCreateOrdersBody> = {}): BatchCreateOrdersBody {
  return {
    productType: 'FLIGHT_ONEWAY',
    outboundScheduleId: 's-1',
    flightCabin: 'ECONOMY',
    description: 'QH9588 DAD→MFM 2026-08-15 经济舱',
    passengers: [
      { fullName: 'WU/FEILAI', documentNumber: 'EB9452866', dateOfBirth: '1983-09-20', nationality: 'CN' },
    ],
    ...overrides,
  } as unknown as BatchCreateOrdersBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ displayName: '运营A', email: 'op@x.io', phone: '-' });
});

describe('batchCreateOrders · manualUnitPriceCny 权限（服务端按认证身份判）', () => {
  it('AGENT 携带 manualUnitPriceCny → BadRequestError（400），且未触库', async () => {
    const priceSpy = vi.spyOn(service as never, 'priceAndValidateItems');
    const createSpy = vi.spyOn(service as never, 'createOrder');

    await expect(
      service.batchCreateOrders(baseBody({ manualUnitPriceCny: 1000 }), {
        userId: 'u-agent',
        role: 'AGENT',
        agentId: 'a1',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(priceSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('CUSTOMER 携带 manualUnitPriceCny → BadRequestError（400）', async () => {
    await expect(
      service.batchCreateOrders(baseBody({ manualUnitPriceCny: 1000 }), {
        userId: 'u-cust',
        role: 'CUSTOMER',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('batchCreateOrders · manualUnitPriceCny 差额调整行（手动价 − 系统价）', () => {
  /** 装配：系统权威价 = systemTotal，createOrder 捕获入参、返回一张成功子单。 */
  function wire(systemTotal: number): { capturedAdjustment: () => PriceAdjustmentInput | undefined } {
    vi.spyOn(service as never, 'assertNoDuplicatePassengersOnFlights').mockResolvedValue(undefined as never);
    vi.spyOn(service as never, 'priceAndValidateItems').mockResolvedValue([
      { kind: 'FLIGHT', description: 'QH9588', quantity: 1, unitPrice: systemTotal, amount: systemTotal },
    ] as never);
    let captured: PriceAdjustmentInput | undefined;
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { priceAdjustment?: PriceAdjustmentInput }) => {
      captured = body.priceAdjustment;
      return { id: 'o-1', orderNumber: 'N-1' };
    }) as never);
    return { capturedAdjustment: () => captured };
  }

  it('手动价 > 系统价 → 追加 MISC_FEE 调整行，金额 = 差额（正），reasonText 记 OTA 结算价', async () => {
    const { capturedAdjustment } = wire(800);
    const res = await service.batchCreateOrders(baseBody({ manualUnitPriceCny: 1000 }), {
      userId: 'u-admin',
      role: 'ADMIN',
    } as never);

    expect(res.successCount).toBe(1);
    expect(capturedAdjustment()).toEqual({
      amountCny: 200, // 1000 − 800
      reasonCode: 'MISC_FEE',
      reasonText: 'OTA 结算价 ¥1000/人',
    });
  });

  it('手动价 < 系统价 → 追加 DISCOUNT 调整行，金额 = 差额（负）', async () => {
    const { capturedAdjustment } = wire(800);
    await service.batchCreateOrders(baseBody({ manualUnitPriceCny: 600 }), {
      userId: 'u-admin',
      role: 'ADMIN',
    } as never);

    expect(capturedAdjustment()).toEqual({
      amountCny: -200, // 600 − 800
      reasonCode: 'DISCOUNT',
      reasonText: 'OTA 结算价 ¥600/人',
    });
  });

  it('手动价 = 系统价 → 不追加调整行（priceAdjustment 为 undefined）', async () => {
    const { capturedAdjustment } = wire(800);
    await service.batchCreateOrders(baseBody({ manualUnitPriceCny: 800 }), {
      userId: 'u-admin',
      role: 'ADMIN',
    } as never);

    expect(capturedAdjustment()).toBeUndefined();
  });

  it('未传 manualUnitPriceCny → 不算系统价、不加调整行（旧行为不变）', async () => {
    vi.spyOn(service as never, 'assertNoDuplicatePassengersOnFlights').mockResolvedValue(undefined as never);
    const priceSpy = vi.spyOn(service as never, 'priceAndValidateItems');
    let captured: PriceAdjustmentInput | undefined = { amountCny: 1, reasonCode: 'MISC_FEE' };
    vi.spyOn(service as never, 'createOrder').mockImplementation((async (body: { priceAdjustment?: PriceAdjustmentInput }) => {
      captured = body.priceAdjustment;
      return { id: 'o-2', orderNumber: 'N-2' };
    }) as never);

    await service.batchCreateOrders(baseBody(), { userId: 'u-admin', role: 'ADMIN' } as never);

    expect(priceSpy).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
  });
});
