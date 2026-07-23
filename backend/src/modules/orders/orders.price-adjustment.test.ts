/**
 * 录单调价/加项 + 录单前试算（quote）· 服务级单测（vitest，mock Prisma，不依赖真 DB）
 *
 * 覆盖：
 *   1. buildPriceAdjustmentItem：正=FEE/负=DISCOUNT，金额入行、描述可读、metadata 打标。
 *   2. quoteOrder 只算不落库：用 TRANSFER 行（信任前端价，不查 DB）→ 返回总价，且不写任何库。
 *   3. priceAdjustment 权限：游客 / CUSTOMER / AGENT 携带该字段一律 BadRequestError（散客 400）。
 *
 * 「调整计入 total」与「审计落库」需真 DB 全链路 —— 见 orders.price-adjustment.integration.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// createOrder 的权限断言在函数最顶端（早于任何 prisma 调用），故最小 mock 即可。
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { create: vi.fn(), findUnique: vi.fn() },
    orderItem: { create: vi.fn() },
    transfer: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import {
  OrderService,
  buildPriceAdjustmentItem,
} from './orders.service.js';
import { BadRequestError } from '../../lib/errors.js';
import { priceAdjustmentSchema, type CreateOrderBody } from './orders.schemas.js';

const service = new OrderService();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildPriceAdjustmentItem', () => {
  it('正金额 → FEE 行，金额与描述正确，metadata 打标', () => {
    const row = buildPriceAdjustmentItem({ amountCny: 700, reasonCode: 'MISC_FEE' });
    expect(row.kind).toBe('FEE');
    expect(row.amount).toBe(700);
    expect(row.unitPrice).toBe(700);
    expect(row.quantity).toBe(1);
    expect(row.description).toBe('价格调整：补收杂费（+¥700）');
    expect(row.metadata).toMatchObject({ priceAdjustment: true, reasonCode: 'MISC_FEE' });
  });

  it('负金额 → DISCOUNT 行，描述用负号（−）', () => {
    const row = buildPriceAdjustmentItem({ amountCny: -200, reasonCode: 'DISCOUNT' });
    expect(row.kind).toBe('DISCOUNT');
    expect(row.amount).toBe(-200);
    expect(row.description).toBe('价格调整：优惠（−¥200）');
  });

  it('「其它」原因把说明拼进描述与 metadata', () => {
    const row = buildPriceAdjustmentItem({ amountCny: 300, reasonCode: 'OTHER', reasonText: '临时加派车' });
    expect(row.description).toBe('价格调整：其它（+¥300）：临时加派车');
    expect(row.metadata.reasonText).toBe('临时加派车');
  });

  it('成本侧显式落 0（纯价格调整无采购成本，不留 NULL 拖累毛利明细）', () => {
    // 正（FEE）/ 负（DISCOUNT）两向都显式 0，避免被毛利明细当「缺成本」。
    expect(buildPriceAdjustmentItem({ amountCny: 700, reasonCode: 'MISC_FEE' }).totalCostCny).toBe(0);
    expect(buildPriceAdjustmentItem({ amountCny: -200, reasonCode: 'DISCOUNT' }).totalCostCny).toBe(0);
  });
});

describe('priceAdjustmentSchema · 原因收窄为纯财务类（堵运营旁路）', () => {
  it.each(['UPGRADE_CABIN', 'UPGRADE_HOTEL', 'VISA_MULTI'])(
    '旧原因 %s 被拒绝（不再是可录入值）',
    (reasonCode) => {
      const result = priceAdjustmentSchema.safeParse({ amountCny: 700, reasonCode });
      expect(result.success).toBe(false);
    },
  );

  it.each(['DISCOUNT', 'MISC_FEE', 'CHANGE'])('新原因 %s 可用', (reasonCode) => {
    const result = priceAdjustmentSchema.safeParse({ amountCny: 700, reasonCode });
    expect(result.success).toBe(true);
  });

  it('OTHER 未填 reasonText → 拒绝', () => {
    const result = priceAdjustmentSchema.safeParse({ amountCny: 700, reasonCode: 'OTHER' });
    expect(result.success).toBe(false);
  });

  it('OTHER 填了 reasonText → 通过', () => {
    const result = priceAdjustmentSchema.safeParse({
      amountCny: 700,
      reasonCode: 'OTHER',
      reasonText: '临时加派车',
    });
    expect(result.success).toBe(true);
  });
});

describe('OrderService.quoteOrder', () => {
  it('只算不落库：返回权威总价，且不写任何库/不开事务', async () => {
    const res = await service.quoteOrder({
      items: [{ kind: 'TRANSFER', description: '接送', quantity: 2, unitPrice: 150 }],
    });
    expect(res.currency).toBe('CNY');
    expect(res.subtotal).toBe(300);
    expect(res.total).toBe(300);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ kind: 'TRANSFER', quantity: 2, unitPrice: 150, amount: 300 });
    // 关键：只读不写
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
    expect(mockPrisma.orderItem.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('OrderService.createOrder · priceAdjustment 权限（服务端按认证身份判）', () => {
  const bodyWithAdjustment = {
    items: [{ kind: 'TRANSFER', description: '接送', quantity: 1, unitPrice: 150 }],
    passengers: [
      { fullName: '张三', documentNumber: 'E1234567', dateOfBirth: '1990-01-01', nationality: 'CN' },
    ],
    priceAdjustment: { amountCny: 700, reasonCode: 'MISC_FEE' },
  } as unknown as CreateOrderBody;

  it('游客携带 priceAdjustment → BadRequestError（散客 400），且未触库', async () => {
    await expect(
      service.createOrder(bodyWithAdjustment, { guest: { name: '游客', phone: '13800000000' } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('CUSTOMER 携带 priceAdjustment → BadRequestError', async () => {
    await expect(
      service.createOrder(bodyWithAdjustment, { userId: 'u-cust', role: 'CUSTOMER' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('AGENT 携带 priceAdjustment → BadRequestError', async () => {
    await expect(
      service.createOrder(bodyWithAdjustment, { userId: 'u-agent', role: 'AGENT', agentId: 'a1' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
