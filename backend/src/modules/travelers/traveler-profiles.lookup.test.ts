/**
 * 批量查常旅客次数（lookupByDocuments）单测（vitest，mock prisma）。
 *
 * 覆盖：
 *   - 命中 canonical 档案：直接返回快照值 + 权益台账合计
 *   - 命中指针行（已被合并）：解析到主档案取值，documentType/documentNumber 保持请求原值
 *   - 主档案被删导致断链：停在指针行本身兜底，不抛错
 *   - 没有档案的证件走现算兜底：合计 = 新系统已飞 + 老系统历史，hasProfile=false
 *   - 占位出行人（N/A）现算也不给条目
 *   - availableTrips 可为负，不截断
 *   - 空数组直接返回 []，不查库
 *   - 批量证件只打一次 findMany + 一次 redemption groupBy（无 N+1）
 *   - 请求体 schema：1~100 条上限校验、documentNumber trim 后非空
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentType } from '@prisma/client';
import { lookupTravelerProfilesBodySchema } from './travelers.schemas.js';

const prismaMock = vi.hoisted(() => ({
  travelerProfile: {
    findMany: vi.fn(),
  },
  travelerBenefitRedemption: {
    groupBy: vi.fn(),
  },
  // 现算兜底（computeCombinedTripCounts）用的两张表：默认无数据，
  // 需要断言兜底数字的用例各自 mock 返回值
  order: {
    findMany: vi.fn(),
  },
  legacyTicket: {
    findMany: vi.fn(),
  },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { TravelerProfilesService } from './traveler-profiles.service.js';

function profileRow(over: { id: string; documentNumber: string } & Partial<Record<string, unknown>>) {
  return {
    id: over.id,
    travelerNo: 1,
    documentType: DocumentType.PASSPORT,
    documentNumber: over.documentNumber,
    fullName: 'ZHANG SAN',
    chineseName: '张三',
    gender: null,
    dateOfBirth: null,
    nationality: 'CN',
    passportExpiry: null,
    tripCount: 5,
    pendingTripCount: 1,
    orderCount: 4,
    firstTripAt: null,
    lastTripAt: null,
    nextTripAt: null,
    totalSpendCny: { toFixed: () => '0.00' },
    prefCabin: null,
    prefBed: null,
    prefMeal: null,
    prefSingleRoom: null,
    needsWheelchair: false,
    hotelHistory: [],
    companions: [],
    linkedUserId: null,
    notes: null,
    mergedIntoId: null,
    refreshedAt: new Date('2026-08-24T00:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValue([]);
  prismaMock.order.findMany.mockResolvedValue([]);
  prismaMock.legacyTicket.findMany.mockResolvedValue([]);
});

/** 现算兜底用的最小订单行（orderSelect 形状）：一位乘客 + 一条已起飞的去程 */
function flownOrderRow(documentNumber: string, departureTime: Date) {
  return {
    id: `o-${documentNumber}-${departureTime.toISOString()}`,
    orderNumber: `FTM-${documentNumber}`,
    status: 'PAID',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    paidAmount: 1000,
    passengers: [
      {
        fullName: 'ZHANG SAN',
        chineseName: '张三',
        gender: null,
        documentType: DocumentType.PASSPORT,
        documentNumber,
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
        kind: 'FLIGHT',
        flightCabin: null,
        hotelCheckIn: null,
        hotelCheckOut: null,
        flightSchedule: {
          departureTime,
          flight: { flightNumber: 'QH9588', originCode: 'MFM', destinationCode: 'DAD' },
        },
        hotelRoomType: null,
      },
    ],
  };
}

describe('lookupByDocuments：命中 canonical 档案', () => {
  it('直接返回快照值，字段名与契约一致', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([
      profileRow({ id: 'p1', documentNumber: 'E12345678', tripCount: 5, pendingTripCount: 1 }),
    ]);
    prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValueOnce([
      { profileId: 'p1', _sum: { tripsUsed: 2 } },
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'E12345678' },
    ]);

    expect(results).toEqual([
      {
        documentType: DocumentType.PASSPORT,
        documentNumber: 'E12345678',
        profileId: 'p1',
        travelerNo: 'CT-000001',
        hasProfile: true,
        tripCount: 5,
        pendingTripCount: 1,
        redeemedTrips: 2,
        availableTrips: 3,
      },
    ]);
  });

  it('只打一次 findMany 主查询 + 一次 redemption groupBy（批量证件不逐个查）', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([
      profileRow({ id: 'p1', documentNumber: 'E11111111' }),
      profileRow({ id: 'p2', documentNumber: 'E22222222' }),
      profileRow({ id: 'p3', documentNumber: 'E33333333' }),
    ]);

    await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'E11111111' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'E22222222' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'E33333333' },
    ]);

    // 全部命中 canonical 行（mergedIntoId 为空）：不需要补查主档案，findMany 只调一次
    expect(prismaMock.travelerProfile.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.travelerBenefitRedemption.groupBy).toHaveBeenCalledTimes(1);
  });

  it('没有档案的证件走现算兜底：合计 = 新系统已飞 + 老系统历史，不是只有老系统那一半', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([
      profileRow({ id: 'p1', documentNumber: 'E11111111' }),
    ]);
    // 新系统：两张已飞的单；老系统：两条与新系统日期不重叠的历史票
    prismaMock.order.findMany.mockResolvedValueOnce([
      flownOrderRow('NEW-CLIENT', new Date('2026-03-01T02:00:00.000Z')),
      flownOrderRow('NEW-CLIENT', new Date('2026-04-01T02:00:00.000Z')),
    ]);
    prismaMock.legacyTicket.findMany.mockResolvedValueOnce([
      { documentNumberNorm: 'NEW-CLIENT', outboundDate: new Date('2019-05-01T00:00:00.000Z') },
      { documentNumberNorm: 'NEW-CLIENT', outboundDate: new Date('2020-06-01T00:00:00.000Z') },
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'E11111111' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'NEW-CLIENT' },
    ]);

    expect(results).toHaveLength(2);
    const live = results.find((r) => r.documentNumber === 'NEW-CLIENT')!;
    expect(live.tripCount).toBe(4); // 新系统 2 + 老系统 2
    expect(live.hasProfile).toBe(false);
    expect(live.profileId).toBe('');
    expect(live.redeemedTrips).toBe(0);
    expect(live.availableTrips).toBe(4);
  });

  it('兜底路径同样做 ±1 天活体去重：老系统重录的那趟不重复计', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([]);
    prismaMock.order.findMany.mockResolvedValueOnce([
      flownOrderRow('NEW-CLIENT', new Date('2026-03-01T02:00:00.000Z')),
    ]);
    prismaMock.legacyTicket.findMany.mockResolvedValueOnce([
      // 与新系统那趟同一天（业务日 UTC+8 2026-03-01）→ 判为重录，不计
      { documentNumberNorm: 'NEW-CLIENT', outboundDate: new Date('2026-03-01T00:00:00.000Z') },
      { documentNumberNorm: 'NEW-CLIENT', outboundDate: new Date('2019-05-01T00:00:00.000Z') },
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'NEW-CLIENT' },
    ]);

    expect(results[0].tripCount).toBe(2); // 新系统 1 + 老系统 1（重录的那条被去掉）
  });

  it('多个未建档证件只打一次订单查询 + 一次老系统查询（兜底不 N+1）', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([]);

    await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'NEW-1' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'NEW-2' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'NEW-3' },
    ]);

    expect(prismaMock.order.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.legacyTicket.findMany).toHaveBeenCalledTimes(1);
  });

  it('占位出行人（N/A）没有档案也不给条目，现算不去猜一个假人', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'N/A' },
    ]);

    expect(results).toEqual([]);
    expect(prismaMock.order.findMany).not.toHaveBeenCalled();
  });

  it('availableTrips 可为负（退单导致），不截断到 0', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([
      profileRow({ id: 'p1', documentNumber: 'E11111111', tripCount: 1 }),
    ]);
    prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValueOnce([
      { profileId: 'p1', _sum: { tripsUsed: 4 } },
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'E11111111' },
    ]);

    expect(results[0].availableTrips).toBe(-3);
  });

  it('空数组直接返回 []，不查库', async () => {
    const svc = new TravelerProfilesService();
    const results = await svc.lookupByDocuments([]);
    expect(results).toEqual([]);
    expect(prismaMock.travelerProfile.findMany).not.toHaveBeenCalled();
  });
});

describe('lookupByDocuments：命中指针行（合并链解析）', () => {
  it('沿 mergedIntoId 解析到主档案取值，documentType/documentNumber 保持请求原值', async () => {
    const svc = new TravelerProfilesService();
    // 主查询命中一条指针行（旧证）；主档案没被请求方直接命中，需要补一次批量查询
    prismaMock.travelerProfile.findMany
      .mockResolvedValueOnce([
        profileRow({ id: 'pointer-1', documentNumber: 'OLD-E999', mergedIntoId: 'master-1' }),
      ])
      .mockResolvedValueOnce([
        profileRow({
          id: 'master-1',
          documentNumber: 'E12345678',
          tripCount: 8,
          pendingTripCount: 0,
        }),
      ]);
    prismaMock.travelerBenefitRedemption.groupBy.mockResolvedValueOnce([
      { profileId: 'master-1', _sum: { tripsUsed: 1 } },
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'OLD-E999' },
    ]);

    expect(results).toEqual([
      {
        documentType: DocumentType.PASSPORT,
        documentNumber: 'OLD-E999', // 保持请求里的原证件，不被主档案证件覆盖
        profileId: 'master-1',
        travelerNo: 'CT-000001',
        hasProfile: true,
        tripCount: 8,
        pendingTripCount: 0,
        redeemedTrips: 1,
        availableTrips: 7,
      },
    ]);
    // 补查主档案按去重后的 id 批量查一次，不逐证件查
    expect(prismaMock.travelerProfile.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.travelerProfile.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['master-1'] } },
    });
  });

  it('主查询已经同时命中主档案时，不再补查（findMany 只调一次）', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([
      profileRow({ id: 'pointer-1', documentNumber: 'OLD-E999', mergedIntoId: 'master-1' }),
      profileRow({ id: 'master-1', documentNumber: 'E12345678', tripCount: 8 }),
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'OLD-E999' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'E12345678' },
    ]);

    expect(prismaMock.travelerProfile.findMany).toHaveBeenCalledTimes(1);
    expect(results.find((r) => r.documentNumber === 'OLD-E999')?.profileId).toBe('master-1');
    expect(results.find((r) => r.documentNumber === 'E12345678')?.profileId).toBe('master-1');
  });

  it('主档案被删导致断链时，停在指针行本身兜底展示，不抛错', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany
      .mockResolvedValueOnce([
        profileRow({
          id: 'pointer-1',
          documentNumber: 'OLD-E999',
          mergedIntoId: 'deleted-master',
          tripCount: 3,
          pendingTripCount: 0,
        }),
      ])
      .mockResolvedValueOnce([]); // 补查主档案：已被删，查不到

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'OLD-E999' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].profileId).toBe('pointer-1'); // 兜底用指针行自身
    expect(results[0].tripCount).toBe(3);
  });
});

describe('lookupTravelerProfilesBodySchema：批量上限校验', () => {
  it('空数组拒绝（至少 1 条）', () => {
    expect(() => lookupTravelerProfilesBodySchema.parse({ documents: [] })).toThrow();
  });

  it('超过 100 条拒绝', () => {
    const documents = Array.from({ length: 101 }, (_, i) => ({
      documentType: DocumentType.PASSPORT,
      documentNumber: `E${i}`,
    }));
    expect(() => lookupTravelerProfilesBodySchema.parse({ documents })).toThrow();
  });

  it('恰好 100 条放行', () => {
    const documents = Array.from({ length: 100 }, (_, i) => ({
      documentType: DocumentType.PASSPORT,
      documentNumber: `E${i}`,
    }));
    expect(() => lookupTravelerProfilesBodySchema.parse({ documents })).not.toThrow();
  });

  it('documentNumber 空白字符串（trim 后为空）拒绝', () => {
    expect(() =>
      lookupTravelerProfilesBodySchema.parse({
        documents: [{ documentType: DocumentType.PASSPORT, documentNumber: '   ' }],
      }),
    ).toThrow();
  });

  it('documentNumber 前后空白会被 trim 掉', () => {
    const parsed = lookupTravelerProfilesBodySchema.parse({
      documents: [{ documentType: DocumentType.PASSPORT, documentNumber: '  E12345678  ' }],
    });
    expect(parsed.documents[0].documentNumber).toBe('E12345678');
  });
});
