/**
 * 批量查常旅客次数（lookupByDocuments）单测（vitest，mock prisma）。
 *
 * 覆盖：
 *   - 命中 canonical 档案：直接返回快照值 + 权益台账合计
 *   - 命中指针行（已被合并）：解析到主档案取值，documentType/documentNumber 保持请求原值
 *   - 主档案被删导致断链：停在指针行本身兜底，不抛错
 *   - 没有档案的证件不出现在结果里
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
});

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

  it('没有档案的证件不出现在结果里', async () => {
    const svc = new TravelerProfilesService();
    prismaMock.travelerProfile.findMany.mockResolvedValueOnce([
      profileRow({ id: 'p1', documentNumber: 'E11111111' }),
    ]);

    const results = await svc.lookupByDocuments([
      { documentType: DocumentType.PASSPORT, documentNumber: 'E11111111' },
      { documentType: DocumentType.PASSPORT, documentNumber: 'NO-SUCH-DOC' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].documentNumber).toBe('E11111111');
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
