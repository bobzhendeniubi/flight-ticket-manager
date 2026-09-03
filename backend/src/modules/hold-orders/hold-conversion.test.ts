import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CabinClass, DocumentType, HoldAmountRule, HoldInstallmentStatus, HoldOrderStatus, PassengerType } from '@prisma/client';

const { prismaMock, orderCreateMock, paymentMock, advancePaidMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    holdOrder: { findUnique: vi.fn(), update: vi.fn() },
    holdInstallment: { update: vi.fn(), findMany: vi.fn() },
    holdConversionRecord: { create: vi.fn(), findUnique: vi.fn() },
    // 结转款核实状态继承：convert 会数一遍未核实的 OPS_CLAIM 认款（默认 0 = 全部已核实）
    holdReceiptAllocation: { count: vi.fn() },
    // 证件待补转正：建单后清临时证件键 / 哨兵生日，并在订单备注贴「证件待补 N 人」
    passenger: { findMany: vi.fn(), updateMany: vi.fn() },
    order: { findUnique: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  orderCreateMock: vi.fn(),
  paymentMock: vi.fn(),
  advancePaidMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../../lib/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../orders/orders.service.js', () => ({
  OrderService: vi.fn(() => ({
    createHoldConversionOrderWithinTx: orderCreateMock,
    advanceOrderToPaidIfClearedWithinTx: advancePaidMock,
  })),
}));
vi.mock('../payments/payments.service.js', () => ({
  PaymentsService: vi.fn(() => ({ _creditOrderPaymentWithinTx: paymentMock })),
}));

import { HoldOrderService } from './hold-orders.service.js';

const passenger = (name: string, documentNumber: string) => ({
  fullName: name,
  documentType: DocumentType.PASSPORT,
  documentNumber,
  dateOfBirth: '1990-01-01',
  passportExpiry: '2030-01-01',
  nationality: 'CN',
  passengerType: PassengerType.ADULT,
});

const requestToken = '00000000-0000-4000-8000-000000000001';
const conversionBody = (passengers: ReturnType<typeof passenger>[], token = requestToken) => ({ requestToken: token, passengers });

function makeHold(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold_1',
    holdNo: 'H20260824AB12',
    flightScheduleId: 'schedule_1',
    seatClassId: 'seat_1',
    ownerType: 'AGENT',
    agentId: 'agent_1',
    groupName: null,
    seats: 10,
    seatsConverted: 0,
    seatsCancelled: 0,
    perSeatPriceCny: 1000,
    freeCancelRatio: 0.1,
    freeCancelUsed: 0,
    occupyOn: 'CREATE',
    status: HoldOrderStatus.HOLDING,
    installments: [{
      id: 'installment_1',
      seq: 1,
      amountRule: HoldAmountRule.REMAINDER,
      perPersonCny: null,
      amountCny: 3000,
      seatsBasis: 10,
      status: HoldInstallmentStatus.PAID,
      paidAt: new Date(),
      allocations: [{ amountCny: 3000, reversedAt: null }],
    }],
    reductions: [],
    conversions: [],
    seatClass: { cabin: CabinClass.ECONOMY },
    flightSchedule: { id: 'schedule_1', departureTime: new Date(), departureTz: 'UTC', flight: { flightNumber: 'CA1' } },
    agent: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => unknown) => callback(prismaMock));
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'seat_1' }]);
  prismaMock.holdReceiptAllocation.count.mockResolvedValue(0);
  prismaMock.holdOrder.findUnique.mockResolvedValue(makeHold());
  prismaMock.holdOrder.update.mockResolvedValue({});
  prismaMock.holdInstallment.update.mockResolvedValue({});
  prismaMock.holdInstallment.findMany.mockResolvedValue(makeHold().installments);
  prismaMock.holdConversionRecord.create.mockResolvedValue({ id: 'conversion_1' });
  prismaMock.holdConversionRecord.findUnique.mockResolvedValue(undefined);
  prismaMock.order.findUnique.mockResolvedValue({ id: 'order_1', orderNumber: 'FTM2026082400001', total: 2000, paidAmount: 600, status: 'PENDING_PAYMENT' });
  prismaMock.order.update.mockResolvedValue({});
  prismaMock.passenger.findMany.mockResolvedValue([]);
  prismaMock.passenger.updateMany.mockResolvedValue({ count: 0 });
  orderCreateMock.mockResolvedValue({ order: { id: 'order_1', orderNumber: 'FTM2026082400001', notes: '占位单 H20260824AB12 转正' }, duplicateConflicts: [] });
  paymentMock.mockResolvedValue({ paymentId: 'payment_1', paidAmount: 600, total: 2000, fullyPaid: false, orderNumber: 'FTM2026082400001', status: 'PENDING_PAYMENT' });
  advancePaidMock.mockResolvedValue({ fullyPaid: false, status: HoldOrderStatus.PENDING });
});

describe('HoldOrderService.convert', () => {
  it('全量转正：先消费占位，再建订单、结转并进入 CONVERTED', async () => {
    const service = new HoldOrderService();
    const result = await service.convert('hold_1', conversionBody(Array.from({ length: 10 }, (_, i) => passenger(`P${i}`, `P${i}001`))), { userId: 'user_1', role: 'ADMIN' });

    expect(result).toMatchObject({ seats: 10, carryCny: 3000, remainingSeats: 0, holdStatus: HoldOrderStatus.CONVERTED, orderNumber: 'FTM2026082400001' });
    expect(orderCreateMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 10, unitPriceCny: 1000 }));
    expect(paymentMock).toHaveBeenCalledWith(expect.anything(), 'order_1', expect.objectContaining({ amount: 3000, note: '占位单 H20260824AB12 结转' }), expect.anything(), expect.anything());
    expect(prismaMock.holdConversionRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ seats: 10, carryCny: 3000, orderId: 'order_1' }) });
    expect(prismaMock.holdOrder.update.mock.invocationCallOrder[0]).toBeLessThan(orderCreateMock.mock.invocationCallOrder[0]);
    expect(orderCreateMock.mock.invocationCallOrder[0]).toBeLessThan(paymentMock.mock.invocationCallOrder[0]);
    expect(paymentMock.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.holdConversionRecord.create.mock.invocationCallOrder[0]);
  });

  it('分批转正：第二次扣除历史 carry 后只结转剩余可归属实收', async () => {
    const service = new HoldOrderService();
    const first = makeHold({ seatsConverted: 3, conversions: [{ carryCny: 900 }] });
    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(first);
    prismaMock.order.findUnique.mockResolvedValueOnce({ id: 'order_2', orderNumber: 'FTM2026082400002', total: 2000, paidAmount: 600, status: 'PENDING_PAYMENT' });
    orderCreateMock.mockResolvedValueOnce({ order: { id: 'order_2', orderNumber: 'FTM2026082400002' }, duplicateConflicts: [] });
    paymentMock.mockResolvedValueOnce({ paymentId: 'payment_2', paidAmount: 600, total: 2000, fullyPaid: false, orderNumber: 'FTM2026082400002', status: 'PENDING_PAYMENT' });

    const result = await service.convert('hold_1', conversionBody([passenger('P11', 'P11001'), passenger('P12', 'P12001')], '00000000-0000-4000-8000-000000000002'), { userId: 'user_1', role: 'STAFF' });
    expect(result).toMatchObject({ seats: 2, carryCny: 600, remainingSeats: 5, holdStatus: HoldOrderStatus.FULLY_PAID });
  });

  it('部分付款下转正：按余座人均结转，订单保留尾款', async () => {
    const service = new HoldOrderService();
    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(makeHold({
      seats: 4,
      perSeatPriceCny: 1000,
      installments: [{
        id: 'installment_1',
        seq: 1,
        amountRule: HoldAmountRule.REMAINDER,
        perPersonCny: null,
        amountCny: 1200,
        seatsBasis: 4,
        status: HoldInstallmentStatus.PAID,
        paidAt: new Date(),
        allocations: [{ amountCny: 1200, reversedAt: null }],
      }],
    }));
    const result = await service.convert('hold_1', conversionBody([passenger('P1', 'P1001'), passenger('P2', 'P2001')], '00000000-0000-4000-8000-000000000003'), { userId: 'user_1', role: 'STAFF' });

    expect(result).toMatchObject({ seats: 2, carryCny: 600, remainingSeats: 2 });
    expect(paymentMock).toHaveBeenCalledWith(expect.anything(), 'order_1', expect.objectContaining({ amount: 600 }), expect.anything(), expect.anything());
  });

  it('减员后转正：历史没收与挂账先扣除，再按剩余余座结转', async () => {
    const service = new HoldOrderService();
    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(makeHold({
      seatsCancelled: 2,
      reductions: [{ forfeitCny: 300, surplusCny: 100 }],
    }));
    const result = await service.convert('hold_1', conversionBody([passenger('P1', 'P1001'), passenger('P2', 'P2001')], '00000000-0000-4000-8000-000000000004'), { userId: 'user_1', role: 'ADMIN' });

    // (3000 - 300 - 100) / 8 = 325，转 2 座结转 650，余 6 座。
    expect(result).toMatchObject({ seats: 2, carryCny: 650, remainingSeats: 6 });
  });

  it('乘客校验失败发生在事务前，不消费占位余座', async () => {
    const service = new HoldOrderService();
    // 姓名是转正唯一的必填项；格式不对的护照有效期同样在事务前就被拦下。
    await expect(service.convert('hold_1', conversionBody([{ ...passenger('P1', 'P1001'), fullName: '' }]))).rejects.toThrow();
    await expect(service.convert('hold_1', conversionBody([{ ...passenger('P1', 'P1001'), passportExpiry: '2030/01/01' }]))).rejects.toThrow();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.holdOrder.update).not.toHaveBeenCalled();
  });

  // ── 证件待补：先占名字、护照后到 ───────────────────────────────────────────
  describe('证件待补转正（只填姓名）', () => {
    it('只有姓名也能转正：证件号/出生日期/护照有效期留空不再报错', async () => {
      const service = new HoldOrderService();
      const result = await service.convert('hold_1', conversionBody([
        { fullName: '张三', documentType: DocumentType.PASSPORT, passengerType: PassengerType.ADULT },
        { fullName: '李四', documentType: DocumentType.PASSPORT, passengerType: PassengerType.ADULT },
      ] as unknown as ReturnType<typeof passenger>[], '00000000-0000-4000-8000-000000000011'));

      expect(result).toMatchObject({ seats: 2 });
      const created = orderCreateMock.mock.calls[0][1] as { passengers: Array<{ documentNumber: string; dateOfBirth: string; passportExpiry?: string }> };
      // 建单入参补了本次请求内唯一的临时证件键 + 可解析的哨兵生日，重复乘客校验才有键可用。
      expect(created.passengers.map((p) => p.documentNumber)).toEqual([
        'PENDING-DOC-00000000-1',
        'PENDING-DOC-00000000-2',
      ]);
      expect(new Set(created.passengers.map((p) => p.documentNumber)).size).toBe(2);
      expect(created.passengers.every((p) => p.passportExpiry === undefined)).toBe(true);
    });

    it('建单后把临时证件键清成空、哨兵生日清成 null，并在订单备注贴「证件待补」', async () => {
      const service = new HoldOrderService();
      prismaMock.passenger.findMany.mockResolvedValueOnce([
        { id: 'pax_1', documentNumber: 'PENDING-DOC-00000000-1' },
        { id: 'pax_2', documentNumber: 'PENDING-DOC-00000000-2' },
      ]);

      await service.convert('hold_1', conversionBody([
        { fullName: '张三', documentType: DocumentType.PASSPORT, passengerType: PassengerType.ADULT },
        { fullName: '李四', documentType: DocumentType.PASSPORT, passengerType: PassengerType.ADULT },
      ] as unknown as ReturnType<typeof passenger>[], '00000000-0000-4000-8000-000000000012'));

      expect(prismaMock.passenger.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['pax_1', 'pax_2'] } },
        data: { documentNumber: '' },
      });
      expect(prismaMock.passenger.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['pax_1', 'pax_2'] } },
        data: { dateOfBirth: null },
      });
      expect(prismaMock.order.update).toHaveBeenCalledWith({
        where: { id: 'order_1' },
        data: { notes: '占位单 H20260824AB12 转正 · 证件待补 2 人' },
      });
    });

    it('名单是全的时候完全不碰乘客表，也不改订单备注', async () => {
      const service = new HoldOrderService();
      await service.convert('hold_1', conversionBody([passenger('P1', 'P1001')], '00000000-0000-4000-8000-000000000013'));

      expect(prismaMock.passenger.findMany).not.toHaveBeenCalled();
      expect(prismaMock.passenger.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.order.update).not.toHaveBeenCalled();
    });

    it('只补了护照号、生日仍待补：证件号原样保留，只清生日', async () => {
      const service = new HoldOrderService();
      prismaMock.passenger.findMany.mockResolvedValueOnce([{ id: 'pax_1', documentNumber: 'E12345678' }]);

      await service.convert('hold_1', conversionBody([
        { fullName: '张三', documentType: DocumentType.PASSPORT, passengerType: PassengerType.ADULT, documentNumber: 'E12345678' },
      ] as unknown as ReturnType<typeof passenger>[], '00000000-0000-4000-8000-000000000014'));

      const created = orderCreateMock.mock.calls[0][1] as { passengers: Array<{ documentNumber: string }> };
      expect(created.passengers[0]!.documentNumber).toBe('E12345678');
      expect(prismaMock.passenger.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.passenger.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['pax_1'] } },
        data: { dateOfBirth: null },
      });
    });

    it('空串等同于留空：前端表格没填的列不会被当成非法值打回', async () => {
      const service = new HoldOrderService();
      const result = await service.convert('hold_1', conversionBody([
        { fullName: '张三', documentType: DocumentType.PASSPORT, passengerType: PassengerType.ADULT, documentNumber: '', dateOfBirth: '', passportExpiry: '', nationality: '' },
      ] as unknown as ReturnType<typeof passenger>[], '00000000-0000-4000-8000-000000000015'));

      expect(result).toMatchObject({ seats: 1 });
      const created = orderCreateMock.mock.calls[0][1] as { passengers: Array<{ nationality: string; documentNumber: string }> };
      // 国籍留空回落 CN（与基座 schema 默认值一致）
      expect(created.passengers[0]!.nationality).toBe('CN');
      expect(created.passengers[0]!.documentNumber).toBe('PENDING-DOC-00000000-1');
    });
  });

  it('重复 requestToken 只回放既有订单，不再次消费余座或生成收款', async () => {
    const service = new HoldOrderService();
    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(makeHold({ status: HoldOrderStatus.CONVERTED, seatsConverted: 2 }));
    prismaMock.holdConversionRecord.findUnique.mockResolvedValueOnce({
      id: 'conversion_existing',
      orderId: 'order_existing',
      seats: 2,
      carryCny: 600,
      requestToken,
    });
    prismaMock.order.findUnique.mockResolvedValueOnce({ id: 'order_existing', orderNumber: 'FTM2026082400099', total: 2000, paidAmount: 600, status: 'PENDING_PAYMENT' });

    const result = await service.convert('hold_1', conversionBody([passenger('P1', 'P1001')]));

    expect(result).toMatchObject({ orderId: 'order_existing', orderNumber: 'FTM2026082400099', seats: 2, carryCny: 600, requestToken });
    expect(prismaMock.holdOrder.update).not.toHaveBeenCalled();
    expect(orderCreateMock).not.toHaveBeenCalled();
    expect(paymentMock).not.toHaveBeenCalled();
    expect(prismaMock.holdConversionRecord.create).not.toHaveBeenCalled();
  });

  it('零价转正也调用订单付款状态机，且不伪造零元 Payment', async () => {
    const service = new HoldOrderService();
    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(makeHold({
      perSeatPriceCny: 0,
      installments: [{
        id: 'installment_1', seq: 1, amountRule: HoldAmountRule.REMAINDER, perPersonCny: null,
        amountCny: 0, seatsBasis: 1, status: HoldInstallmentStatus.PAID, paidAt: new Date(), allocations: [],
      }],
    }));
    prismaMock.order.findUnique.mockResolvedValueOnce({ id: 'order_1', orderNumber: 'FTM2026082400001', total: 0, paidAmount: 0, status: 'PAID' });

    const result = await service.convert('hold_1', conversionBody([passenger('P1', 'P1001')], '00000000-0000-4000-8000-000000000005'));

    expect(result.carryCny).toBe(0);
    expect(paymentMock).not.toHaveBeenCalled();
    expect(advancePaidMock).toHaveBeenCalledTimes(1);
  });

  it('建单失败发生在占位聚合更新后也会由事务整体回滚', async () => {
    const service = new HoldOrderService();
    orderCreateMock.mockRejectedValueOnce(new Error('passenger validation failed'));

    await expect(service.convert('hold_1', conversionBody([passenger('P1', 'P1001')]))).rejects.toThrow('passenger validation failed');
    expect(paymentMock).not.toHaveBeenCalled();
    expect(prismaMock.holdConversionRecord.create).not.toHaveBeenCalled();
  });

  it('人数超余座与非占座状态均返回冲突，且不消费占位', async () => {
    const service = new HoldOrderService();
    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(makeHold({ seatsConverted: 9 }));
    await expect(service.convert('hold_1', conversionBody([passenger('P1', 'P1001'), passenger('P2', 'P2001')]))).rejects.toMatchObject({ statusCode: 409 });
    expect(orderCreateMock).not.toHaveBeenCalled();

    prismaMock.holdOrder.findUnique.mockResolvedValueOnce(makeHold({ status: HoldOrderStatus.CONVERTED }));
    await expect(service.convert('hold_1', conversionBody([passenger('P1', 'P1001')]))).rejects.toMatchObject({ statusCode: 409 });
  });
});
