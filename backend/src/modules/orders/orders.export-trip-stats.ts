/**
 * 导出「飞行次数 / 在订未飞 / 可用次数」三列的唯一取数口径（三张表共用，不各自实现）。
 *
 * 消费方：
 *   - 全岗总表（orders.export-master.ts）—— 三列都用；
 *   - 分房表（orders.export-room-allocation.ts）—— 只用「飞行次数」列；
 *   - 《全岗可用》模板（orders.export-templates.ts）—— 只用「飞行次数」列。
 * 三处共用本文件的同一份取数 + 同一个渲染函数（flightCountCell），保证同一位乘客在三张表里
 * 的数字必然相同；口径漂移在这里就没有生长空间。
 *
 * 独立成文件（而非从 orders.export-master.ts 导出）的原因：master 已 import 分房表与三模板
 * 导出的工具函数，反向 import 会形成模块环。
 *
 * 诚实口径：
 *   - 飞行次数 = 该乘客的常旅客合计飞行次数（新系统已飞 + 老系统历史飞行（已去重、退票不计）），
 *     按档案全部证件号归拢，只计去程已起飞的行程；取自 TravelerProfile.tripCount ——
 *     是「这个人跟我们飞过几次」，与本单航段数无关，
 *     故同一订单不同乘客的飞行次数互不相同。匹配不到档案（新客/证件号对不上）→ 留空。
 *     该列读自档案快照表（值是上次重建时的，见 TravelerProfile.refreshedAt）；快照表一条
 *     都没有时（新环境 / 从没人开过档案页）会导致整列全部留空，导出会先同步做一次全量首建
 *     兜底。非空但过期的快照不归导出管——那由档案页自身访问时的后台重建负责刷新，导出不为
 *     此额外重建（全量重建太慢，不能挂在每次导出请求上）。
 *   - 在订未飞 = TravelerProfile.pendingTripCount（不含老系统未来日期未重录单；同一条快照重算链路回写）。
 *   - 可用次数 = 飞行次数（含老系统历史飞行（已去重、退票不计））− 已核销权益次数（TravelerBenefitRedemption 流水 sum，
 *     核销/冲正同一档案），可为负——核销后订单又被退改导致已飞回落时如实透出，不截断也不臆造。
 *     核销流水挂在合并链的主档案上，取值前已沿 mergedIntoId 解析到主档案。
 */
import type { DocumentType, PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { docKey } from '../travelers/traveler-profiles.aggregate.js';
import { TravelerProfilesService } from '../travelers/traveler-profiles.service.js';

/** 一位旅客的三项快照口径数字：合计飞行次数（含老系统）/ 在订未飞 / 可用次数（合计飞行−已核销，可为负）。*/
export interface TripStats {
  tripCount: number;
  pendingTripCount: number;
  availableTrips: number;
}

/** docKey(证件类型|证件号) → 该旅客的三项快照数字。渲染纯函数只认这张 Map，不碰 DB。*/
export type TripStatsMap = Map<string, TripStats>;

/** 快照新鲜度：本次导出用到的档案里最旧的一条重建时间（null = 一条都没匹配上）。*/
export interface TripCountLookup {
  tripStats: TripStatsMap;
  /** 表头批注用：让读表的人知道这几列是快照、有多旧。*/
  oldestRefreshedAt: Date | null;
}

/** 取数/渲染只需要证件对，三张表的乘客行都满足这个最小形状。*/
export interface TripStatsPassenger {
  documentType: DocumentType;
  documentNumber: string;
}

/** mergedIntoId 指针链解析用的最小行。*/
interface ProfileRef {
  id: string;
  documentType: DocumentType;
  documentNumber: string;
  tripCount: number;
  pendingTripCount: number;
  refreshedAt: Date;
  mergedIntoId: string | null;
}

/** 合并链最大跟随跳数：merge() 禁止并入指针行 → 数据上不该有链；给足冗余并防脏数据死循环。*/
const MAX_MERGE_HOPS = 4;

/**
 * 拉取本次导出全部乘客的常旅客档案 → docKey → { 飞行次数, 在订未飞, 可用次数 }。
 *
 * 无 N+1：先按 (证件类型,证件号) 组合一次 findMany（走 @@unique([documentType, documentNumber])），
 * 再对「命中的档案是指针行（mergedIntoId 非空）」的情况按 id 批量补拉主档案 —— 每一跳一条查询，
 * 实践中最多一跳（合并时禁止把档案并入指针行，链深恒为 1）。之后再加一条 groupBy 取回全部命中
 * 主档案的已核销次数合计（可用次数 = 飞行次数 − 已核销）。几百位乘客也只有 2~3 条查询。
 *
 * mergedIntoId：合并过的档案 tripCount/pendingTripCount 累积在主档案上，指针行留的是合并前的
 * 残值 —— 直读源档案会少算；核销流水（TravelerBenefitRedemption）同理只挂在主档案上。命中
 * 指针行时沿链跟随到主档案取值（防环：记录已访问 id）。客人报旧护照号下的单，也能因此拿到
 * 归一后的真实数字。
 */
export async function loadTripCountMap(
  passengers: readonly TripStatsPassenger[],
  client: PrismaClient = defaultPrisma,
): Promise<TripCountLookup> {
  const select = {
    id: true,
    documentType: true,
    documentNumber: true,
    tripCount: true,
    pendingTripCount: true,
    refreshedAt: true,
    mergedIntoId: true,
  } as const;

  // 证件对去重（同一旅客在多张订单里重复出现 → 只查一次）
  const pairByKey = new Map<string, TripStatsPassenger>();
  for (const p of passengers) {
    if (!p.documentNumber) continue; // 证件号缺失 → 无从匹配，留空
    pairByKey.set(docKey(p.documentType, p.documentNumber), {
      documentType: p.documentType,
      documentNumber: p.documentNumber,
    });
  }
  if (pairByKey.size === 0) return { tripStats: new Map(), oldestRefreshedAt: null };

  // SQL 侧与内存侧 docKey 同口径归一（trim + 忽略大小写）：档案列存的是乘客行原始写法，
  // 精确匹配会让大小写/空格变体在查询层就漏掉，后面的 docKey 归一根本没机会兜住。
  const matched = (await client.travelerProfile.findMany({
    where: {
      OR: [...pairByKey.values()].map((p) => ({
        documentType: p.documentType,
        documentNumber: { equals: p.documentNumber.trim(), mode: Prisma.QueryMode.insensitive },
      })),
    },
    select,
  })) as ProfileRef[];

  // 指针行 → 批量补拉主档案（按 id in，逐跳；命中即停）
  const byId = new Map<string, ProfileRef>(matched.map((r) => [r.id, r]));
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const wanted = [...byId.values()]
      .map((r) => r.mergedIntoId)
      .filter((id): id is string => id !== null && !byId.has(id));
    if (wanted.length === 0) break;
    const masters = (await client.travelerProfile.findMany({
      where: { id: { in: [...new Set(wanted)] } },
      select,
    })) as ProfileRef[];
    if (masters.length === 0) break; // 断链（主档案被删）→ 停在当前行，用其残值而非空
    for (const m of masters) byId.set(m.id, m);
  }

  // 已核销次数合计（可用次数 = 飞行次数 − 已核销）：一次 groupBy 覆盖全部命中的主档案，
  // 与 traveler-benefits.service.ts 的 loadRedeemedTripsByProfile 同口径，
  // 此处不复用该函数——它内部固定读默认 prisma，本函数需支持注入 client 以便单测。
  const masterIds = new Set<string>();
  for (const row of matched) masterIds.add(resolveMaster(row, byId).id);
  let redeemedByProfile = new Map<string, number>();
  if (masterIds.size > 0) {
    // Prisma 5 的 groupBy 条件泛型在注入 PrismaClient 时会把可选 orderBy 推成错误的
    // 必填交集；这里固定本查询的参数/结果形状，保留编译期字段约束又避免污染业务调用。
    const groupByRedemptions = client.travelerBenefitRedemption.groupBy as unknown as (args: {
      by: ['profileId'];
      where: { profileId: { in: string[] } };
      orderBy: { profileId: 'asc' };
      _sum: { tripsUsed: true };
    }) => Promise<{ profileId: string; _sum: { tripsUsed: number | null } }[]>;
    const redemptionGroups = await groupByRedemptions({
      by: ['profileId'],
      where: { profileId: { in: [...masterIds] } },
      orderBy: { profileId: 'asc' },
      _sum: { tripsUsed: true },
    });
    redeemedByProfile = new Map(redemptionGroups.map((g) => [g.profileId, g._sum.tripsUsed ?? 0]));
  }

  const tripStats: TripStatsMap = new Map();
  let oldestRefreshedAt: Date | null = null;
  for (const row of matched) {
    const master = resolveMaster(row, byId);
    const redeemedTrips = redeemedByProfile.get(master.id) ?? 0;
    tripStats.set(docKey(row.documentType, row.documentNumber), {
      tripCount: master.tripCount,
      pendingTripCount: master.pendingTripCount,
      availableTrips: master.tripCount - redeemedTrips,
    });
    if (!oldestRefreshedAt || master.refreshedAt < oldestRefreshedAt) {
      oldestRefreshedAt = master.refreshedAt;
    }
  }
  return { tripStats, oldestRefreshedAt };
}

/**
 * 沿 mergedIntoId 链解析到主档案。
 * 与 travelers/traveler-profiles.service.ts 的 resolveMasterRef 同款口径（该函数为模块私有、
 * 未导出，本文件不改 travelers/ 故就近实现）：断链（主档案被删）/ 环（脏数据）时停在当前行，
 * 不抛错不死循环 —— 脏数据只会让这一条取到残值，不拖垮整表导出。
 */
function resolveMaster(start: ProfileRef, byId: Map<string, ProfileRef>): ProfileRef {
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
 * 空表首建兜底：若本次导出确实有乘客、但快照表一条记录都没有（新环境 / 从没人开过档案页），
 * 直接读 loadTripCountMap 只会拿到空 Map → 整列留空。这里同步做一次全量重建把表填起来。
 *
 * 只处理「空表」这一种情况——非空但过期的快照不归导出管，那是档案页自身访问时
 * （traveler-profiles.service.ts 的 ensureFresh）负责的后台刷新；导出依旧不为过期快照
 * 触发重建（全量重建太慢，不能挂在每次导出请求上，见文件头部口径说明）。
 *
 * rebuild 参数化：便于单测在不真正跑全量重建的前提下断言「空表触发/非空不触发」。
 */
export async function bootstrapTripCountProfilesIfEmpty(
  passengerCount: number,
  client: PrismaClient,
  rebuild: () => Promise<unknown>,
): Promise<void> {
  if (passengerCount === 0) return;
  const existing = await client.travelerProfile.count();
  if (existing > 0) return;
  await rebuild();
}

/**
 * 导出取数的统一入口：空表首建兜底 + 拉快照，一步到位。
 * 三张表（全岗总表 / 分房表 /《全岗可用》）都走这里 —— 谁也别再自己拼「先 bootstrap 再 load」，
 * 否则漏掉兜底的那张表在新环境里会整列留空，同一位乘客在三张表里就出现两个答案。
 */
export async function loadExportTripStats(
  passengers: readonly TripStatsPassenger[],
  client: PrismaClient = defaultPrisma,
  rebuild: () => Promise<unknown> = () => new TravelerProfilesService().rebuildAll(),
): Promise<TripCountLookup> {
  await bootstrapTripCountProfilesIfEmpty(passengers.length, client, rebuild);
  return loadTripCountMap(passengers, client);
}

/**
 * 「飞行次数」单元格渲染（三张表唯一入口，纯函数、不碰 DB）。
 * 匹配不到档案（新客 / 证件号对不上 / 证件号缺失）→ 留空，不臆造 0
 * （0 会被读成"从没飞过"的结论）。
 */
export function flightCountCell(p: TripStatsPassenger, tripStats: TripStatsMap): string {
  const stats = p.documentNumber
    ? tripStats.get(docKey(p.documentType, p.documentNumber))
    : undefined;
  return stats === undefined ? '' : String(stats.tripCount);
}
