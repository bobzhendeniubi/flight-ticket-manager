/**
 * 旅客档案服务 —— TravelerProfile 快照表的读写与重建。
 *
 * 架构：订单是真值，快照表只是缓存。
 *   - 列表读快照（可排序/分页）；空表惰性 bootstrap，过期(>6h)后台自动重建。
 *   - 详情实时从订单重算（永远准确）并回写快照；快照写入同时并入老系统历史飞行次数。
 *   - 批量查次数（lookupByDocuments）读快照，快照没有的证件号现算兜底（见 traveler-trip-count.ts）。
 *   - 重建绝不覆盖 notes（运营手工输入）。
 * 不 hook 订单写路径 —— 纯读侧聚合，对钱路径零风险。
 */
import { Prisma, type DocumentType } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  buildTravelerAggregates,
  docKey,
  type AggOrder,
  type TravelerAggregate,
  type TripSummary,
} from './traveler-profiles.aggregate.js';
import {
  addLegacyTripCount,
  aggregateFlownBusinessDates,
  computeCombinedTripCounts,
  EXCLUDED_ORDER_STATUSES,
  loadLegacyTripCounts,
  orderSelect,
  toAggOrder,
  type CombinedTripCount,
  type LegacyTripCountScope,
} from './traveler-trip-count.js';
import {
  loadRedeemedTripsByProfile,
  loadRedemptions,
  withBenefitTotals,
} from './traveler-benefits.service.js';
import type { ListTravelerProfilesQuery } from './travelers.schemas.js';

// 有效订单口径、老系统次数与「合计」加法都搬到了 traveler-trip-count.ts（导出侧也要用，
// 留在本文件会成模块环）；这里原样再导出一次，历史调用方不必分叉。
export {
  addLegacyTripCount,
  isLegacyTripMatchedByFlownDate,
  loadLegacyTripCounts,
  sumLegacyTripCounts,
} from './traveler-trip-count.js';
export type { LegacyTripCountScope } from './traveler-trip-count.js';

/** 快照过期阈值：超过后列表访问会触发后台重建（不阻塞本次响应） */
export const SNAPSHOT_STALE_MS = 6 * 60 * 60 * 1000;

/** 常旅客号展示格式：CT- + 6 位补零（服务端统一格式化，前端不拼） */
export function formatTravelerNo(no: number): string {
  return `CT-${String(no).padStart(6, '0')}`;
}

/** 档案合并解析用的最小行（全表小数据量，一次拉全量在内存里解析链） */
interface ProfileRef {
  id: string;
  travelerNo: number;
  documentType: DocumentType;
  documentNumber: string;
  mergedIntoId: string | null;
}

interface DocPair {
  documentType: DocumentType;
  documentNumber: string;
}

/** 现算兜底行的常旅客号占位：这人还没档案，别让界面显示一个不存在的 CT- 号。 */
const UNFILED_TRAVELER_NO = '未建档';

/** 批量查常旅客次数（lookupByDocuments）的单条结果 —— 订单详情抽屉「已飞/在订/可用」用 */
export interface TravelerLookupResult {
  documentType: DocumentType;
  documentNumber: string;
  /** 现算兜底行（还没建档）为空串 */
  profileId: string;
  /** 现算兜底行为「未建档」 */
  travelerNo: string;
  /** false = 数字是本次实时算的（新系统已飞 + 老系统历史），不是档案快照 */
  hasProfile: boolean;
  tripCount: number;
  pendingTripCount: number;
  redeemedTrips: number;
  availableTrips: number;
}

/** 聚合 + 老系统次数 → 快照行（不含 notes：重建/回写永不覆盖运营备注）。 */
function toProfileData(
  agg: TravelerAggregate,
  legacyTripCount: number,
  linkedUserId: string | null,
) {
  return {
    documentType: agg.documentType,
    documentNumber: agg.documentNumber,
    fullName: agg.fullName,
    chineseName: agg.chineseName,
    gender: agg.gender,
    dateOfBirth: agg.dateOfBirth,
    nationality: agg.nationality,
    passportExpiry: agg.passportExpiry,
    tripCount: addLegacyTripCount(agg, legacyTripCount),
    legacyTripCount,
    pendingTripCount: agg.pendingTripCount,
    orderCount: agg.orderCount,
    firstTripAt: agg.firstTripAt,
    lastTripAt: agg.lastTripAt,
    nextTripAt: agg.nextTripAt,
    totalSpendCny: new Prisma.Decimal(agg.totalSpendCny.toFixed(2)),
    prefCabin: agg.prefCabin,
    prefBed: agg.prefBed,
    prefMeal: agg.prefMeal,
    prefSingleRoom: agg.prefSingleRoom,
    needsWheelchair: agg.needsWheelchair,
    hotelHistory: agg.hotelHistory as unknown as Prisma.InputJsonValue,
    companions: agg.companions as unknown as Prisma.InputJsonValue,
    linkedUserId,
    refreshedAt: new Date(),
  };
}

/** 证件号脱敏（前2后2）：E12345678 → E1*****78；过短(≤4)全打码。列表/导出用。 */
function maskDocumentNumber(doc: string): string {
  const d = (doc ?? '').trim();
  if (d.length <= 4) return '*'.repeat(Math.max(d.length, 2));
  return `${d.slice(0, 2)}${'*'.repeat(d.length - 4)}${d.slice(-2)}`;
}

export class TravelerProfilesService {
  /** 并发重建去重：同一时刻只跑一次全量重建 */
  private rebuildInFlight: Promise<{ built: number; removed: number }> | null = null;

  async list(query: ListTravelerProfilesQuery) {
    await this.ensureFresh();

    // 列表只出 canonical 行；被合并的指针行只做归拢，不再单独展示。
    // 排除占位档案（N/A 证件）：纯酒店/接送单塞的占位出行人不是真人，重建后会被 prune，
    // 这里再加一道防线，避免重建前的存量 N/A 档案在列表/导出里露出（聚合已不再产生新的）。
    const where: Prisma.TravelerProfileWhereInput = {
      mergedIntoId: null,
      documentNumber: { not: 'N/A' },
    };
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { chineseName: { contains: query.search, mode: 'insensitive' } },
        { documentNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.minTrips !== undefined) where.tripCount = { gte: query.minTrips };

    const orderBy: Prisma.TravelerProfileOrderByWithRelationInput =
      query.sort === 'totalSpendCny'
        ? { totalSpendCny: query.order }
        : query.sort === 'tripCount'
          ? { tripCount: query.order }
          : query.sort === 'nextTripAt'
            ? { nextTripAt: { sort: query.order, nulls: 'last' } }
            : { lastTripAt: { sort: query.order, nulls: 'last' } };

    const [rows, total, stats] = await prisma.$transaction([
      prisma.travelerProfile.findMany({
        where,
        orderBy,
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.travelerProfile.count({ where }),
      prisma.travelerProfile.aggregate({
        where: { mergedIntoId: null },
        _count: { _all: true },
        _sum: { tripCount: true },
        _max: { refreshedAt: true },
      }),
    ]);

    // 权益台账合计：整页一次 groupBy（不是逐行查，避免 N+1）
    const redeemedByProfile = await loadRedeemedTripsByProfile(rows.map((r) => r.id));

    return {
      // N4（提案 §1.4 隐私口径，2026-07-17 收口）：列表/导出默认脱敏证件号（前2后2）。
      // 前端 CSV 导出直接用列表数据 → 服务端一脱敏，导出自动是脱敏版，不再能批量导全号。
      // 全号只在详情页（getDetail，逐人查看）与录单联想（suggest，定向回填）返回。
      profiles: rows.map((r) => {
        const p = withBenefitTotals(serializeProfile(r), redeemedByProfile);
        return { ...p, documentNumber: maskDocumentNumber(p.documentNumber) };
      }),
      pagination: { page: query.page, pageSize: query.pageSize, total },
      meta: {
        totalProfiles: stats._count._all,
        totalTrips: stats._sum.tripCount ?? 0,
        refreshedAt: stats._max.refreshedAt,
      },
    };
  }

  /**
   * 详情：实时从订单重算（含出行时间线），并回写快照。
   * 传入指针行（已被合并的档案）id 时直接解析并返回主档案详情；
   * 重算查订单覆盖主档案本证 + 所有并入它的旧证件号。
   */
  async getDetail(id: string) {
    const row = await prisma.travelerProfile.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('旅客档案不存在');

    const refs = await this.loadProfileRefs();
    const masterRef = resolveMasterRef(refs.get(row.id)!, refs);
    const master =
      masterRef.id === row.id
        ? row
        : await prisma.travelerProfile.findUnique({ where: { id: masterRef.id } });
    if (!master) throw new NotFoundError('旅客档案不存在');

    const { aliasMap, docPairsByMasterId } = buildAliasIndex(refs);
    const docPairs = docPairsByMasterId.get(master.id) ?? [
      { documentType: master.documentType, documentNumber: master.documentNumber },
    ];
    const orders = await this.loadValidOrders({
      passengers: { some: { OR: docPairs } },
    });
    const key = docKey(master.documentType, master.documentNumber);
    const now = new Date();
    const agg = buildTravelerAggregates(orders, now, aliasMap).get(key);

    // 订单已全部失效/删除 → 不臆造新系统聚合，但仍刷新老系统次数。
    // 台账照常返回：订单没了不等于核销没发生过（此时 availableTrips 可能为负，如实透出）。
    if (!agg) {
      const legacyDocuments = docPairs.map((pair) => pair.documentNumber);
      const legacyTripCount = (
        await loadLegacyTripCounts(
          [{ key: master.id, documentNumbers: legacyDocuments, flownBusinessDates: [] }],
          now,
        )
      ).get(master.id) ?? 0;
      const newSystemTripCount = Math.max(0, master.tripCount - master.legacyTripCount);
      const updated = await prisma.travelerProfile.update({
        where: { id: master.id },
        data: {
          tripCount: newSystemTripCount + legacyTripCount,
          legacyTripCount,
          refreshedAt: now,
        },
      });
      return {
        profile: await this.attachBenefitTotals(updated),
        trips: [] as TripSummary[],
        redemptions: await loadRedemptions(master.id),
      };
    }

    const linkedUserId = await this.resolveLinkedUser(master.documentType, master.documentNumber);
    const legacyDocuments = docPairs.map((pair) => pair.documentNumber);
    const legacyTripCount = (
      await loadLegacyTripCounts(
        [
          {
            key: master.id,
            documentNumbers: legacyDocuments,
            flownBusinessDates: aggregateFlownBusinessDates(agg),
          },
        ],
        now,
      )
    ).get(master.id) ?? 0;
    // 证件字段钉死为主档案现值：防聚合取到旧证/大小写变体后，update 撞指针行的唯一键
    const data = {
      ...toProfileData(agg, legacyTripCount, linkedUserId),
      documentType: master.documentType,
      documentNumber: master.documentNumber,
    };
    const updated = await prisma.travelerProfile.update({ where: { id: master.id }, data });
    return {
      profile: await this.attachBenefitTotals(updated),
      trips: agg.trips,
      redemptions: await loadRedemptions(master.id),
    };
  }

  /** 解析到主档案（指针行跟随 mergedIntoId 链）；台账写入前定位归属用，比 getDetail 轻得多 */
  async resolveMaster(id: string): Promise<ProfileRow> {
    const row = await prisma.travelerProfile.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('旅客档案不存在');
    const refs = await this.loadProfileRefs();
    const masterRef = resolveMasterRef(refs.get(row.id)!, refs);
    if (masterRef.id === row.id) return row;
    const master = await prisma.travelerProfile.findUnique({ where: { id: masterRef.id } });
    if (!master) throw new NotFoundError('旅客档案不存在');
    return master;
  }

  async updateNotes(id: string, notes: string | null) {
    const existing = await prisma.travelerProfile.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('旅客档案不存在');
    const updated = await prisma.travelerProfile.update({ where: { id }, data: { notes } });
    return serializeProfile(updated);
  }

  /**
   * 档案合并（同人换证归一）：把 sourceId 并进 intoId。
   * source 保留为「指针行」（mergedIntoId 指向主档案），不做解除合并；
   * source 的手工备注拼进主档案（带来源常旅客号标注），合并后立即对主档案实时重算回写。
   */
  async merge(sourceId: string, intoId: string) {
    if (sourceId === intoId) throw new BadRequestError('不能把档案并入自己');
    const [source, target] = await Promise.all([
      prisma.travelerProfile.findUnique({ where: { id: sourceId } }),
      prisma.travelerProfile.findUnique({ where: { id: intoId } }),
    ]);
    if (!source) throw new NotFoundError('待合并的旅客档案不存在');
    if (!target) throw new NotFoundError('目标旅客档案不存在');
    if (source.mergedIntoId) throw new ConflictError('该档案已被合并过，不能再次合并');
    // 目标是指针行时报错让运营改选主档案，不自动跟随 —— 避免误点旧档案还静默成功
    if (target.mergedIntoId) throw new ConflictError('目标档案已被并入其他档案，请直接选择其主档案');

    // source 的运营备注非空时拼进主档案，标注来源常旅客号；主档案原来为空则直接沿用
    const mergedNotes = source.notes
      ? target.notes
        ? `${target.notes}\n[并入 ${formatTravelerNo(source.travelerNo)}] ${source.notes}`
        : source.notes
      : target.notes;

    // 权益台账跟着人走：source 的核销/冲正流水整体 repoint 到主档案，
    // 与 mergedIntoId 同一个事务 —— 否则中途失败会留下挂在指针行上、谁也算不到的孤儿流水。
    const [movedRedemptions] = await prisma.$transaction([
      prisma.travelerBenefitRedemption.updateMany({
        where: { profileId: source.id },
        data: { profileId: target.id },
      }),
      prisma.travelerProfile.update({
        where: { id: source.id },
        data: { mergedIntoId: target.id },
      }),
      prisma.travelerProfile.update({ where: { id: target.id }, data: { notes: mergedNotes } }),
    ]);

    // 合并后立即实时重算主档案（getDetail 自带回写快照）
    const detail = await this.getDetail(target.id);
    return {
      profile: detail.profile,
      trips: detail.trips,
      redemptions: detail.redemptions,
      movedRedemptions: movedRedemptions.count,
      source: {
        id: source.id,
        travelerNo: formatTravelerNo(source.travelerNo),
        documentType: source.documentType,
        documentNumber: source.documentNumber,
        fullName: source.fullName,
      },
      targetBefore: {
        id: target.id,
        travelerNo: formatTravelerNo(target.travelerNo),
        documentType: target.documentType,
        documentNumber: target.documentNumber,
        fullName: target.fullName,
      },
    };
  }

  /**
   * 录单联想：q 匹配证件号/姓名（startsWith）或中文名（contains），按 tripCount 倒序。
   * 只出 canonical 行；q 命中被合并旧证时解析出其主档案。
   * 每条建议带 fillFields —— 该人最近一张有效订单的乘机人完整快照，录单表单一键回填。
   */
  async suggest(qRaw: string, limit: number) {
    const q = qRaw.trim();
    if (q.length < 2) return [];

    const refs = await this.loadProfileRefs();
    const { docPairsByMasterId } = buildAliasIndex(refs);

    // canonical 行直接匹配
    const direct = await prisma.travelerProfile.findMany({
      where: {
        mergedIntoId: null,
        documentNumber: { not: 'N/A' }, // 占位档案不进录单联想（避免把假人回填进新单）
        OR: [
          { documentNumber: { startsWith: q, mode: 'insensitive' } },
          { fullName: { startsWith: q, mode: 'insensitive' } },
          { chineseName: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { tripCount: 'desc' },
      take: limit,
    });

    // q 命中指针行的证件号（客人报旧护照号）→ 解析出主档案
    const pointerHits = await prisma.travelerProfile.findMany({
      where: {
        mergedIntoId: { not: null },
        documentNumber: { startsWith: q, mode: 'insensitive' },
      },
      select: { id: true },
    });
    const extraMasterIds = new Set<string>();
    for (const hit of pointerHits) {
      const ref = refs.get(hit.id);
      if (!ref) continue;
      const master = resolveMasterRef(ref, refs);
      if (master.mergedIntoId === null && !direct.some((d) => d.id === master.id)) {
        extraMasterIds.add(master.id);
      }
    }
    const viaPointer = extraMasterIds.size
      ? await prisma.travelerProfile.findMany({ where: { id: { in: [...extraMasterIds] } } })
      : [];

    const profiles = [...direct, ...viaPointer]
      .sort((a, b) => b.tripCount - a.tripCount)
      .slice(0, limit);

    // 联想条数已被 limit 卡死（≤20），仍走一次 groupBy 汇总，口径与列表/详情一致
    const redeemedByProfile = await loadRedeemedTripsByProfile(profiles.map((p) => p.id));

    return Promise.all(
      profiles.map(async (p) => ({
        id: p.id,
        travelerNo: formatTravelerNo(p.travelerNo),
        fullName: p.fullName,
        chineseName: p.chineseName,
        gender: p.gender,
        dateOfBirth: p.dateOfBirth,
        nationality: p.nationality,
        documentType: p.documentType,
        documentNumber: p.documentNumber,
        passportExpiry: p.passportExpiry,
        tripCount: p.tripCount,
        pendingTripCount: p.pendingTripCount,
        redeemedTrips: redeemedByProfile.get(p.id) ?? 0,
        availableTrips: p.tripCount - (redeemedByProfile.get(p.id) ?? 0),
        lastTripAt: p.lastTripAt,
        prefCabin: p.prefCabin,
        prefBed: p.prefBed,
        prefMeal: p.prefMeal,
        prefSingleRoom: p.prefSingleRoom,
        needsWheelchair: p.needsWheelchair,
        fillFields: await this.loadFillFields(
          { documentType: p.documentType, documentNumber: p.documentNumber },
          docPairsByMasterId.get(p.id) ?? [],
        ),
      })),
    );
  }

  /**
   * 批量查常旅客次数（按证件号，供订单详情抽屉一次拉「已飞/在订/可用」）。
   * 有档案的读快照值，不触发重算/重建。命中指针行（mergedIntoId 非空）时取主档案的值——
   * merge() 只允许并入 canonical 行（不许把档案并进指针行，见该方法），所以 mergedIntoId
   * 保证最多一跳，这里不必像 getDetail 那样拉全表走 resolveMasterRef 的链解析。
   *
   * 没有档案的证件号（刚录进来的新客，还没赶上下一次快照重建）不再直接放弃 ——
   * 走 computeCombinedTripCounts 现算一份合计（新系统已飞 + 老系统历史），
   * 一录护照号就能看出这人在老系统飞过几次。现算行没有档案，故 profileId 留空、
   * travelerNo 给「未建档」，已核销恒为 0（核销流水只挂在档案上）。
   *
   * 返回的 documentType/documentNumber 保持请求里的原证件（前端按它对回乘客）；
   * 占位出行人（N/A / 空证件号）仍不出现在结果里。查询数固定：一次档案 findMany
   * （命中指针行时再补一次主档案 findMany）+ 一次 redemption groupBy + 现算的两条批量查询，
   * 都不随证件数增长，无 N+1。
   */
  async lookupByDocuments(documents: DocPair[]): Promise<TravelerLookupResult[]> {
    if (documents.length === 0) return [];

    // 证件号按 docKey 同口径归一后查询（trim + 忽略大小写）：档案列存的是乘客行原始写法，
    // 录入时大小写/首尾空格稍有出入不该让「已飞/可用」徽章静默消失——那正是本接口要服务的场景。
    const hits = await prisma.travelerProfile.findMany({
      where: {
        OR: documents.map((d) => ({
          documentType: d.documentType,
          documentNumber: { equals: d.documentNumber.trim(), mode: Prisma.QueryMode.insensitive },
        })),
      },
    });

    const hitByKey = new Map<string, ProfileRow>();
    const rowById = new Map<string, ProfileRow>();
    for (const h of hits) {
      hitByKey.set(docKey(h.documentType, h.documentNumber), h);
      rowById.set(h.id, h);
    }

    const missingMasterIds = new Set<string>();
    for (const h of hits) {
      if (h.mergedIntoId && !rowById.has(h.mergedIntoId)) missingMasterIds.add(h.mergedIntoId);
    }
    if (missingMasterIds.size > 0) {
      const extraMasters = await prisma.travelerProfile.findMany({
        where: { id: { in: [...missingMasterIds] } },
      });
      for (const m of extraMasters) rowById.set(m.id, m);
    }

    // 主档案被删导致断链（罕见：全量重建 prune 只保护有订单/有台账的 canonical 行，
    // 见 doRebuildAll 的注释）时，停在指针行本身兜底展示，不抛错。
    const masterOf = (row: ProfileRow): ProfileRow =>
      row.mergedIntoId ? (rowById.get(row.mergedIntoId) ?? row) : row;

    const masterIds = [...new Set(hits.map((h) => masterOf(h).id))];
    const redeemedByProfile = masterIds.length
      ? await loadRedeemedTripsByProfile(masterIds)
      : new Map<string, number>();

    // 没档案的证件号一次性现算（批量，不在下面的循环里逐人查库）
    const missing = documents.filter(
      (doc) => !hitByKey.has(docKey(doc.documentType, doc.documentNumber)),
    );
    const computed: Map<string, CombinedTripCount> = missing.length
      ? await computeCombinedTripCounts(missing)
      : new Map();

    const results: TravelerLookupResult[] = [];
    for (const doc of documents) {
      const key = docKey(doc.documentType, doc.documentNumber);
      const hit = hitByKey.get(key);
      if (!hit) {
        const live = computed.get(key);
        if (!live) continue; // 占位出行人 / 空证件号：现算也不给条目
        results.push({
          documentType: doc.documentType,
          documentNumber: doc.documentNumber,
          profileId: '',
          travelerNo: UNFILED_TRAVELER_NO,
          hasProfile: false,
          tripCount: live.tripCount,
          pendingTripCount: live.pendingTripCount,
          redeemedTrips: 0,
          availableTrips: live.tripCount,
        });
        continue;
      }
      const master = masterOf(hit);
      const redeemedTrips = redeemedByProfile.get(master.id) ?? 0;
      results.push({
        documentType: doc.documentType,
        documentNumber: doc.documentNumber,
        profileId: master.id,
        travelerNo: formatTravelerNo(master.travelerNo),
        hasProfile: true,
        tripCount: master.tripCount,
        pendingTripCount: master.pendingTripCount,
        redeemedTrips,
        availableTrips: master.tripCount - redeemedTrips,
      });
    }
    return results;
  }

  /**
   * 全量重建：扫全部有效订单 → 聚合 → upsert 快照（保留 notes）→ 清掉已消失的档案。
   * 内部量级（包机生意，订单数千级）全量跑很快；并发调用共享同一次执行。
   */
  async rebuildAll(): Promise<{ built: number; removed: number }> {
    if (this.rebuildInFlight) return this.rebuildInFlight;
    this.rebuildInFlight = this.doRebuildAll().finally(() => {
      this.rebuildInFlight = null;
    });
    return this.rebuildInFlight;
  }

  private async doRebuildAll(): Promise<{ built: number; removed: number }> {
    // 先从指针行构建别名映射：旧证订单归拢进主档案，而不是重建出一个新档案
    const refs = await this.loadProfileRefs();
    const { aliasMap, docPairsByMasterId } = buildAliasIndex(refs);
    const masterByKey = new Map<string, ProfileRef>();
    for (const ref of refs.values()) {
      if (ref.mergedIntoId === null) {
        masterByKey.set(docKey(ref.documentType, ref.documentNumber), ref);
      }
    }

    const orders = await this.loadValidOrders();
    const now = new Date();
    const aggregates = buildTravelerAggregates(orders, now, aliasMap);

    // 这些主档案没有新系统聚合，但因有权益台账会被 prune 保留；也要刷新老系统次数。
    // 只取本轮不会被聚合 upsert 的 canonical 行，避免覆盖正常聚合结果。
    const aggregateMasterIds = new Set(
      [...aggregates.keys()]
        .map((key) => masterByKey.get(key)?.id)
        .filter((id): id is string => id !== undefined),
    );
    const preservedWhere: Prisma.TravelerProfileWhereInput = {
      mergedIntoId: null,
      redemptions: { some: {} },
    };
    if (aggregateMasterIds.size > 0) {
      preservedWhere.id = { notIn: [...aggregateMasterIds] };
    }
    const preservedWithoutAggregate = await prisma.travelerProfile.findMany({
      where: preservedWhere,
      select: { id: true, tripCount: true, legacyTripCount: true },
    });

    const legacyScopes = new Map<string, LegacyTripCountScope>();
    for (const [key, aggregate] of aggregates) {
      const master = masterByKey.get(key);
      const identity: DocPair = {
        documentType: master?.documentType ?? aggregate.documentType,
        documentNumber: master?.documentNumber ?? aggregate.documentNumber,
      };
      const documentPairs = master
        ? docPairsByMasterId.get(master.id) ?? [identity]
        : [identity];
      const scopeKey = master?.id ?? key;
      legacyScopes.set(scopeKey, {
        key: scopeKey,
        documentNumbers: documentPairs.map((pair) => pair.documentNumber),
        flownBusinessDates: aggregateFlownBusinessDates(aggregate),
      });
    }
    for (const preserved of preservedWithoutAggregate) {
      const master = refs.get(preserved.id);
      if (!master) continue;
      const documentPairs = docPairsByMasterId.get(master.id) ?? [master];
      legacyScopes.set(preserved.id, {
        key: preserved.id,
        documentNumbers: documentPairs.map((pair) => pair.documentNumber),
        flownBusinessDates: [],
      });
    }
    const legacyCounts = await loadLegacyTripCounts([...legacyScopes.values()], now);

    // SavedPassenger 证件号 → 唯一归属账号（多账号存同一证件时不猜，置空）
    const savedRows = await prisma.savedPassenger.findMany({
      select: { userId: true, documentType: true, documentNumber: true },
    });
    const linkMap = new Map<string, string | null>();
    for (const s of savedRows) {
      const k = docKey(s.documentType, s.documentNumber);
      linkMap.set(k, linkMap.has(k) && linkMap.get(k) !== s.userId ? null : s.userId);
    }

    const keptIds: string[] = [];
    for (const [key, agg] of aggregates) {
      // 已有主档案：证件字段钉死为其现值（防聚合取到大小写变体后 upsert 撞不上原行，
      // 导致主档案被 prune、指针行悬空）；全新旅客才用聚合出的证件
      const master = masterByKey.get(key);
      const identity: DocPair = {
        documentType: master?.documentType ?? agg.documentType,
        documentNumber: master?.documentNumber ?? agg.documentNumber,
      };
      const legacyTripCount = legacyCounts.get(master?.id ?? key) ?? 0;
      const data = {
        ...toProfileData(agg, legacyTripCount, linkMap.get(key) ?? null),
        ...identity,
      };
      const row = await prisma.travelerProfile.upsert({
        where: { documentType_documentNumber: identity },
        create: data,
        update: data, // 不含 notes / travelerNo / mergedIntoId → 手工备注、常旅客号、合并关系都保留
        select: { id: true },
      });
      keptIds.push(row.id);
    }

    for (const preserved of preservedWithoutAggregate) {
      const legacyTripCount = legacyCounts.get(preserved.id) ?? 0;
      const newSystemTripCount = Math.max(0, preserved.tripCount - preserved.legacyTripCount);
      await prisma.travelerProfile.update({
        where: { id: preserved.id },
        data: {
          tripCount: newSystemTripCount + legacyTripCount,
          legacyTripCount,
          refreshedAt: now,
        },
      });
    }

    // prune 只清 canonical 行：指针行没有对应聚合（订单都归拢进主档案了），必须保留合并关系。
    // 带权益台账的档案一律不清 —— 流水是 append-only 的账，订单被退光也不能把账连人一起抹掉
    // （数据库那边 profileId 外键是 RESTRICT，这里再挡一道，让重建永远撞不上外键报错）。
    const { count: removed } = await prisma.travelerProfile.deleteMany({
      where: { id: { notIn: keptIds }, mergedIntoId: null, redemptions: { none: {} } },
    });
    return { built: keptIds.length, removed };
  }

  // ── private ──

  /** 单档案序列化 + 权益台账合计（availableTrips 可为负，不截断） */
  private async attachBenefitTotals(row: ProfileRow) {
    const redeemedByProfile = await loadRedeemedTripsByProfile([row.id]);
    return withBenefitTotals(serializeProfile(row), redeemedByProfile);
  }

  /** 全表最小行（含指针行），供别名解析；内部量级（千级档案）一次拉全量可接受 */
  private async loadProfileRefs(): Promise<Map<string, ProfileRef>> {
    const rows = await prisma.travelerProfile.findMany({
      select: {
        id: true,
        travelerNo: true,
        documentType: true,
        documentNumber: true,
        mergedIntoId: true,
      },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * 录单回填快照：取该人（主证 + 并入的旧证）最近一张有效订单的乘机人行。
   * 先只查主证 —— 回填的证件号必须是主档案当前证件，不能把旧证回填进新单；
   * 主证下没有订单（合并后还没用新证下过单）才退回全证件取最近行。
   */
  private async loadFillFields(masterDoc: DocPair, allDocPairs: DocPair[]) {
    const validOrder = { deletedAt: null, status: { notIn: EXCLUDED_ORDER_STATUSES } };
    const select = {
      lastName: true,
      firstName: true,
      title: true,
      gender: true,
      chineseName: true,
      dateOfBirth: true,
      placeOfBirth: true,
      nationality: true,
      documentType: true,
      documentNumber: true,
      passportIssueDate: true,
      passportIssueCountry: true,
      passportIssuePlace: true,
      passportExpiry: true,
      mealPreference: true,
      bedPref: true,
      needsWheelchair: true,
      needsInfantBassinet: true,
      passengerType: true,
    } satisfies Prisma.PassengerSelect;
    const orderBy: Prisma.PassengerOrderByWithRelationInput[] = [
      { order: { createdAt: 'desc' } },
      { createdAt: 'desc' },
    ];

    const fromMasterDoc = await prisma.passenger.findFirst({
      where: { ...masterDoc, order: validOrder },
      orderBy,
      select,
    });
    if (fromMasterDoc) return fromMasterDoc;

    const fallbackPairs = allDocPairs.length ? allDocPairs : [masterDoc];
    return prisma.passenger.findFirst({
      where: { OR: fallbackPairs, order: validOrder },
      orderBy,
      select,
    });
  }

  private async loadValidOrders(extra?: Prisma.OrderWhereInput): Promise<AggOrder[]> {
    const rows = await prisma.order.findMany({
      where: {
        deletedAt: null,
        status: { notIn: EXCLUDED_ORDER_STATUSES },
        ...extra,
      },
      select: orderSelect,
    });
    return rows.map(toAggOrder);
  }

  private async resolveLinkedUser(
    documentType: DocumentType,
    documentNumber: string,
  ): Promise<string | null> {
    const matches = await prisma.savedPassenger.findMany({
      where: { documentType, documentNumber },
      select: { userId: true },
    });
    const distinct = [...new Set(matches.map((m) => m.userId))];
    return distinct.length === 1 ? distinct[0] : null;
  }

  /** 空表惰性 bootstrap（阻塞首个请求）；过期则后台重建（不阻塞） */
  private async ensureFresh(): Promise<void> {
    const stats = await prisma.travelerProfile.aggregate({
      _count: { _all: true },
      _max: { refreshedAt: true },
    });
    if (stats._count._all === 0) {
      const anyPassenger = await prisma.passenger.findFirst({ select: { id: true } });
      if (anyPassenger) await this.rebuildAll();
      return;
    }
    const newest = stats._max.refreshedAt;
    if (newest && Date.now() - newest.getTime() > SNAPSHOT_STALE_MS) {
      void this.rebuildAll().catch(() => {
        /* 后台重建失败不影响本次读；下次访问会再试 */
      });
    }
  }
}

/**
 * 沿 mergedIntoId 链解析到最终主档案。
 * 数据上不该有链（合并时禁止把档案并进指针行），但解析要健壮：
 * 断链（主档案被删）/ 环（脏数据）时停在当前行，不抛错不死循环。
 */
function resolveMasterRef(start: ProfileRef, byId: Map<string, ProfileRef>): ProfileRef {
  let current = start;
  const seen = new Set<string>([current.id]);
  while (current.mergedIntoId) {
    const next = byId.get(current.mergedIntoId);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/**
 * 从指针行构建别名索引：
 *   aliasMap           — 旧证 docKey → 主档案 docKey（喂给聚合做归拢）
 *   docPairsByMasterId — 主档案 id → 全部证件对（本证 + 并入的旧证），查订单乘机人用
 */
function buildAliasIndex(byId: Map<string, ProfileRef>): {
  aliasMap: Map<string, string>;
  docPairsByMasterId: Map<string, DocPair[]>;
} {
  const aliasMap = new Map<string, string>();
  const docPairsByMasterId = new Map<string, DocPair[]>();
  for (const ref of byId.values()) {
    if (ref.mergedIntoId === null) {
      docPairsByMasterId.set(ref.id, [
        { documentType: ref.documentType, documentNumber: ref.documentNumber },
      ]);
    }
  }
  for (const ref of byId.values()) {
    if (ref.mergedIntoId === null) continue;
    const master = resolveMasterRef(ref, byId);
    // 断链/环解析不到 canonical 行 → 该指针放弃归拢（只影响这一条，不拖垮整体）
    if (master.id === ref.id || master.mergedIntoId !== null) continue;
    aliasMap.set(
      docKey(ref.documentType, ref.documentNumber),
      docKey(master.documentType, master.documentNumber),
    );
    docPairsByMasterId
      .get(master.id)!
      .push({ documentType: ref.documentType, documentNumber: ref.documentNumber });
  }
  return { aliasMap, docPairsByMasterId };
}

type ProfileRow = Prisma.TravelerProfileGetPayload<Record<string, never>>;

function serializeProfile(row: ProfileRow) {
  return {
    id: row.id,
    travelerNo: formatTravelerNo(row.travelerNo),
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    fullName: row.fullName,
    chineseName: row.chineseName,
    gender: row.gender,
    dateOfBirth: row.dateOfBirth,
    nationality: row.nationality,
    passportExpiry: row.passportExpiry,
    tripCount: row.tripCount,
    legacyTripCount: row.legacyTripCount,
    pendingTripCount: row.pendingTripCount,
    orderCount: row.orderCount,
    firstTripAt: row.firstTripAt,
    lastTripAt: row.lastTripAt,
    nextTripAt: row.nextTripAt,
    totalSpendCny: row.totalSpendCny.toFixed(2),
    prefCabin: row.prefCabin,
    prefBed: row.prefBed,
    prefMeal: row.prefMeal,
    prefSingleRoom: row.prefSingleRoom,
    needsWheelchair: row.needsWheelchair,
    hotelHistory: row.hotelHistory,
    companions: row.companions,
    linkedUserId: row.linkedUserId,
    notes: row.notes,
    mergedIntoId: row.mergedIntoId,
    refreshedAt: row.refreshedAt,
  };
}
