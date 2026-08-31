/**
 * 旅客档案老系统飞行次数单测：
 *   - LegacyTicket 过滤条件集中在一次批量 findMany，并对新系统已飞日期活体去重；
 *   - 主证件与合并别名证件号按 norm 归拢且不重复计数；
 *   - 详情实时重算回写时，老系统次数仍并入 tripCount；无有效订单的保留档案也刷新次数。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CabinClass, DocumentType, OrderItemKind, OrderStatus, Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  legacyTicket: { findMany: vi.fn() },
  travelerProfile: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  order: { findMany: vi.fn() },
  savedPassenger: { findMany: vi.fn() },
  travelerBenefitRedemption: { groupBy: vi.fn(), findMany: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import {
  addLegacyTripCount,
  loadLegacyTripCounts,
  sumLegacyTripCounts,
  TravelerProfilesService,
} from './traveler-profiles.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.legacyTicket.findMany.mockResolvedValue([]);
  prismaMock.savedPassenger.findMany.mockResolvedValue([]);
  prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValue([]);
  prismaMock.travelerBenefitRedemption.findMany.mockResolvedValue([]);
});

describe('loadLegacyTripCounts', () => {
  it('一次批量查询并应用删除、重录、退票和未来日期过滤，保留 stateRaw=NULL', async () => {
    const today = new Date('2026-08-31T12:00:00.000Z');
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: null },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-20T00:00:00.000Z') },
      { documentNumberNorm: 'OLD456', outboundDate: new Date('2026-08-25T00:00:00.000Z') },
    ]);

    const counts = await loadLegacyTripCounts(
      [{ key: 'profile-1', documentNumbers: [' e123 ', 'OLD456', 'E123'], flownBusinessDates: [] }],
      today,
      { legacyTicket: prismaMock.legacyTicket } as never,
    );

    expect(counts).toEqual(
      new Map([
        ['profile-1', 3],
      ]),
    );
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledWith({
      where: {
        documentNumberNorm: { in: ['E123', 'OLD456'] },
        isDeleted: false,
        supersededByOrderId: null,
        OR: [{ stateRaw: null }, { stateRaw: { not: 2 } }],
        AND: [{ OR: [{ outboundDate: null }, { outboundDate: { lte: today } }] }],
      },
      select: { documentNumberNorm: true, outboundDate: true },
    });
  });

  it('同日及前后一天重录票不双算，不同日期的真实行程仍计入', async () => {
    const today = new Date('2026-09-30T12:00:00.000Z');
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-30T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-31T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-01T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-02T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: null },
    ]);

    const counts = await loadLegacyTripCounts(
      [{ key: 'profile-1', documentNumbers: ['E123'], flownBusinessDates: ['2026-08-31'] }],
      today,
      { legacyTicket: prismaMock.legacyTicket } as never,
    );

    expect(counts.get('profile-1')).toBe(2);
  });

  it('不同日期各有新系统行程时只分别去重对应日期，不误杀真实次数', async () => {
    const today = new Date('2026-09-30T12:00:00.000Z');
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-31T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-10T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-09-20T00:00:00.000Z') },
    ]);

    const counts = await loadLegacyTripCounts(
      [{
        key: 'profile-1',
        documentNumbers: ['E123'],
        flownBusinessDates: ['2026-08-31', '2026-09-10'],
      }],
      today,
      { legacyTicket: prismaMock.legacyTicket } as never,
    );

    expect(counts.get('profile-1')).toBe(1);
  });

  it('没有可匹配的 norm 时不查库并返回空 Map', async () => {
    const counts = await loadLegacyTripCounts([{
      key: 'profile-1',
      documentNumbers: ['  ', ''],
      flownBusinessDates: [],
    }], new Date(), {
      legacyTicket: prismaMock.legacyTicket,
    } as never);

    expect(counts).toEqual(new Map());
    expect(prismaMock.legacyTicket.findMany).not.toHaveBeenCalled();
  });

  it('有匹配证件但没有老系统记录时返回零，不制造次数', async () => {
    const counts = await loadLegacyTripCounts([{
      key: 'profile-1',
      documentNumbers: ['E123'],
      flownBusinessDates: [],
    }], new Date(), {
      legacyTicket: prismaMock.legacyTicket,
    } as never);

    expect(counts).toEqual(new Map([['profile-1', 0]]));
  });
});

describe('老系统次数归拢 helper', () => {
  it('主证件与合并别名按 norm 相加，同一证件不会重复计数', () => {
    const counts = new Map([
      ['E123', 3],
      ['OLD456', 4],
    ]);
    const legacyTripCount = sumLegacyTripCounts([' e123 ', 'old456', 'E123'], counts);

    expect(legacyTripCount).toBe(7);
    expect(addLegacyTripCount({ tripCount: 5 }, legacyTripCount)).toBe(12);
    expect(addLegacyTripCount({ tripCount: 5 }, 0)).toBe(5);
  });
});

function profileRow() {
  return {
    id: 'profile-1',
    travelerNo: 1,
    documentType: DocumentType.PASSPORT,
    documentNumber: 'E123',
    fullName: 'ZHANG SAN',
    chineseName: null,
    gender: null,
    dateOfBirth: null,
    nationality: 'CN',
    passportExpiry: null,
    tripCount: 1,
    legacyTripCount: 0,
    pendingTripCount: 0,
    orderCount: 1,
    firstTripAt: null,
    lastTripAt: null,
    nextTripAt: null,
    totalSpendCny: new Prisma.Decimal('100.00'),
    prefCabin: null,
    prefBed: null,
    prefMeal: null,
    prefSingleRoom: false,
    needsWheelchair: false,
    hotelHistory: [],
    companions: [],
    linkedUserId: null,
    notes: null,
    mergedIntoId: null,
    refreshedAt: new Date('2026-08-30T00:00:00.000Z'),
  };
}

describe('TravelerProfilesService.getDetail', () => {
  it('详情实时重算回写后仍保留老系统次数，并按 UTC+8 去程业务日活体去重', async () => {
    const row = profileRow();
    // UTC 8/30 16:30 属于 UTC+8 业务日 8/31；老系统 8/29 与其相差 2 天，不应误杀。
    const departedAt = new Date('2026-08-30T16:30:00.000Z');
    prismaMock.travelerProfile.findUnique.mockResolvedValue(row);
    prismaMock.travelerProfile.findMany.mockResolvedValue([
      {
        id: row.id,
        travelerNo: row.travelerNo,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        mergedIntoId: null,
      },
    ]);
    prismaMock.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        orderNumber: 'ORDER-1',
        status: OrderStatus.COMPLETED,
        createdAt: departedAt,
        paidAmount: new Prisma.Decimal('100.00'),
        passengers: [
          {
            fullName: 'ZHANG SAN',
            chineseName: null,
            gender: null,
            documentType: DocumentType.PASSPORT,
            documentNumber: 'E123',
            dateOfBirth: null,
            nationality: 'CN',
            passportExpiry: null,
            mealPreference: null,
            bedPref: null,
            needsWheelchair: false,
            singleRoom: false,
          },
        ],
        items: [
          {
            kind: OrderItemKind.FLIGHT,
            flightCabin: CabinClass.ECONOMY,
            hotelCheckIn: null,
            hotelCheckOut: null,
            flightSchedule: {
              departureTime: departedAt,
              flight: { flightNumber: 'FTM1', originCode: 'MFM', destinationCode: 'DAD' },
            },
            hotelRoomType: null,
          },
        ],
      },
    ]);
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: new Date('2026-08-29T00:00:00.000Z') },
      { documentNumberNorm: 'E123', outboundDate: new Date('2020-01-01T00:00:00.000Z') },
    ]);
    prismaMock.travelerProfile.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
    }));

    const result = await new TravelerProfilesService().getDetail(row.id);

    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.travelerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: expect.objectContaining({ tripCount: 3, legacyTripCount: 2 }),
      }),
    );
    expect(result.profile).toMatchObject({ tripCount: 3, legacyTripCount: 2 });
  });

  it('订单全部失效时仍刷新老系统次数，并保留快照中的新系统部分', async () => {
    const row = { ...profileRow(), tripCount: 7, legacyTripCount: 4 };
    prismaMock.travelerProfile.findUnique.mockResolvedValue(row);
    prismaMock.travelerProfile.findMany.mockResolvedValue([{
      id: row.id,
      travelerNo: row.travelerNo,
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      mergedIntoId: null,
    }]);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: null },
      { documentNumberNorm: 'E123', outboundDate: new Date('2020-01-01T00:00:00.000Z') },
    ]);
    prismaMock.travelerProfile.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
    }));

    const result = await new TravelerProfilesService().getDetail(row.id);

    expect(prismaMock.travelerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: expect.objectContaining({ tripCount: 5, legacyTripCount: 2 }),
      }),
    );
    expect(result.profile).toMatchObject({ tripCount: 5, legacyTripCount: 2 });
  });
});

describe('TravelerProfilesService.rebuildAll', () => {
  it('有权益台账但没有新系统聚合的主档案仍刷新老系统次数', async () => {
    const row = { ...profileRow(), tripCount: 7, legacyTripCount: 4 };
    prismaMock.travelerProfile.findMany
      .mockResolvedValueOnce([{
        id: row.id,
        travelerNo: row.travelerNo,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        mergedIntoId: null,
      }])
      .mockResolvedValueOnce([{ id: row.id, tripCount: row.tripCount, legacyTripCount: row.legacyTripCount }]);
    prismaMock.order.findMany.mockResolvedValue([]);
    prismaMock.savedPassenger.findMany.mockResolvedValue([]);
    prismaMock.legacyTicket.findMany.mockResolvedValue([
      { documentNumberNorm: 'E123', outboundDate: null },
      { documentNumberNorm: 'E123', outboundDate: new Date('2020-01-01T00:00:00.000Z') },
    ]);
    prismaMock.travelerProfile.update.mockResolvedValue({});
    prismaMock.travelerProfile.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValue([]);

    // deleteMany 的 redemptions:none 条件会保护有权益台账的主档案；findMany 第二次模拟该保留行。
    const result = await new TravelerProfilesService().rebuildAll();

    expect(result).toEqual({ built: 0, removed: 0 });
    expect(prismaMock.travelerProfile.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ tripCount: 5, legacyTripCount: 2, refreshedAt: expect.any(Date) }),
    });
  });
});
