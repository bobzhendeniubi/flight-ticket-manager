/**
 * 结算价日历 service — 运营维护「航线 × 出发日期 × 晚数 × 酒店档次」的每人同业结算价（CNY）。
 *
 * 口径：
 *   - date-only 匹配：SettlementRate.departDate 是 @db.Date；YMD 字符串统一按 UTC 零点折成 Date
 *     再存/查（ymdToUtcDate），避免本地时区把日期挪前一天。读回同样按 UTC 口径 slice YMD。
 *   - 唯一键 (routeKey, tier, nights, departDate)：一条航线一个组合一个每人价；批量 upsert 以此幂等，
 *     重复提交只覆盖不新增。routeKey = 去程方向「起飞-到达」机场码（如 MFM-DAD），
 *     取价侧由套餐绑定航班派生（modules/products/bundle-route.ts 唯一入口）——派生不到 = 没有航线 =
 *     不取价，本模块不提供任何默认航线。
 *   - getSettlementRate 供代理下单自动取价复用（orders.service）——只查不改，命中返回价、未维护返回 null。
 *   - 0811 滚动窗口 / 0828 每人结算价 / 0903 代理自助结算价 的口径不在本文件，本批只加航线这一维。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计（镜像 hotel-control / finances 成本周期风格）。
 */
import { SettlementTier, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError } from '../../lib/errors.js';
import {
  BUNDLE_ROUTE_SELECT,
  bundleRouteKey,
  parseRouteKey,
  routeKeyOf,
} from '../products/bundle-route.js';
import type { ListRatesQuery, RateEntry } from './settlement-rates.schemas.js';

/**
 * YMD（YYYY-MM-DD）→ UTC 零点 Date（@db.Date 存/查用）。
 * 用 Date.UTC 折日，避免服务器本地时区把日期挪前一天（date-only 语义只认年月日）。
 * 非法输入抛 BadRequestError（调用方均来自已通过 zod dateStr 校验的入参，此处是最后一道防御）。
 */
export function ymdToUtcDate(ymd: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(ymd);
  if (!m) throw new BadRequestError(`非法日期：${ymd}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`非法日期：${ymd}`);
  return d;
}

/** @db.Date 读回 Date → YMD（UTC 口径，与 ymdToUtcDate 对称，绝不经本地时区跨天）。 */
export function utcDateToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SettlementRateDto {
  id: string;
  routeKey: string;
  tier: SettlementTier;
  nights: number;
  departDate: string; // YMD
  pricePerPersonCny: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string; // ISO
}

function serialize(row: {
  id: string;
  routeKey: string;
  tier: SettlementTier;
  nights: number;
  departDate: Date;
  pricePerPersonCny: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}): SettlementRateDto {
  return {
    id: row.id,
    routeKey: row.routeKey,
    tier: row.tier,
    nights: row.nights,
    departDate: utcDateToYmd(row.departDate),
    pricePerPersonCny: row.pricePerPersonCny,
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 网格查询：按航线 + 出发日期区间（含端点）+ 可选晚数/档次筛选，供 admin 结算价日历页渲染。
 * 排序：日期 → 晚数 → 档次（稳定顺序，前端按此铺网格）。
 */
export async function listRates(
  q: ListRatesQuery,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto[]> {
  if (q.from > q.to) {
    throw new BadRequestError('起始日期不能晚于结束日期');
  }
  const rows = await client.settlementRate.findMany({
    where: {
      routeKey: q.routeKey,
      departDate: { gte: ymdToUtcDate(q.from), lte: ymdToUtcDate(q.to) },
      ...(q.nights != null ? { nights: q.nights } : {}),
      ...(q.tier != null ? { tier: q.tier } : {}),
    },
    orderBy: [{ departDate: 'asc' }, { nights: 'asc' }, { tier: 'asc' }],
  });
  return rows.map(serialize);
}

/**
 * 批量 upsert（网格整批保存 / Excel 粘贴块）：每格按 (routeKey, tier, nights, departDate) 幂等 upsert。
 * 事务包裹——整批同成同败，避免半保存造成网格与库不一致。updatedBy 记最近更新人（展示"谁改的"）。
 */
export async function upsertRates(
  rates: RateEntry[],
  updatedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto[]> {
  const rows = await client.$transaction(
    rates.map((r) =>
      client.settlementRate.upsert({
        where: {
          routeKey_tier_nights_departDate: {
            routeKey: r.routeKey,
            tier: r.tier,
            nights: r.nights,
            departDate: ymdToUtcDate(r.departDate),
          },
        },
        create: {
          routeKey: r.routeKey,
          tier: r.tier,
          nights: r.nights,
          departDate: ymdToUtcDate(r.departDate),
          pricePerPersonCny: r.pricePerPersonCny,
          note: r.note ?? null,
          updatedBy,
        },
        update: {
          pricePerPersonCny: r.pricePerPersonCny,
          note: r.note ?? null,
          updatedBy,
        },
      }),
    ),
  );
  return rows.map(serialize);
}

/** 删除一格（网格清空某单元格）。返回被删行（供审计留痕），不存在返回 null。 */
export async function deleteRate(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto | null> {
  const existing = await client.settlementRate.findUnique({ where: { id } });
  if (!existing) return null;
  await client.settlementRate.delete({ where: { id } });
  return serialize(existing);
}

/**
 * 查价函数（代理下单自动取价 / 网格单格回显复用）：按 (航线, tier, nights, 出发日期) 命中当日每人结算价。
 *   - routeKey 由调用方从套餐绑定航班派生（bundle-route.ts）；派生不到就**不要调用**本函数——
 *     这里不做任何航线兜底。
 *   - departDate 为 YMD 字符串（调用方已按班次本地出发日折算），内部按 UTC date-only 匹配。
 *   - 命中返回每人价（+ 元数据），未维护返回 null（调用方据此拒单 / 显示空格）。
 */
export async function getSettlementRate(
  routeKey: string,
  tier: SettlementTier,
  nights: number,
  departDate: string,
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRateDto | null> {
  const row = await client.settlementRate.findUnique({
    where: {
      routeKey_tier_nights_departDate: {
        routeKey,
        tier,
        nights,
        departDate: ymdToUtcDate(departDate),
      },
    },
  });
  return row ? serialize(row) : null;
}

/** 可维护的航线（结算价日历 / 立减规则页的航线下拉）。 */
export interface SettlementRouteDto {
  routeKey: string;
  origin: string;
  destination: string;
  /** 日历里已有该航线的价（运营正在用的线排前面） */
  hasRates: boolean;
}

/**
 * 可选航线 = 日历表 distinct routeKey ∪ 立减规则表 distinct routeKey ∪ 活跃套餐派生航线（去程优先）
 *          ∪ 活跃航班按自身方向派生的航线（去程方向）。
 *
 * 「去程方向」的判定：航班表本身不分去回程——同一条线的去程/回程是两条 Flight 行。
 * 只被活跃套餐绑成**回程**的航班（如 DAD→MFM）不算一条航线，否则每条线都会多出一条反向噪声，
 * 运营选错方向会填出一张永远不被取价的日历。尚无套餐绑定的新线（两个方向都没绑）两向都列出，
 * 供运营在建套餐前先备价；取价永远以套餐绑定航班派生为准，多列一条不会串价。
 */
export async function listSettlementRoutes(
  client: PrismaClient = defaultPrisma,
): Promise<SettlementRouteDto[]> {
  const [rateRows, ruleRows, bundles, flights] = await Promise.all([
    client.settlementRate.findMany({ distinct: ['routeKey'], select: { routeKey: true } }),
    client.settlementDiscountRule.findMany({ distinct: ['routeKey'], select: { routeKey: true } }),
    client.bundle.findMany({
      where: { isActive: true },
      select: { outboundFlightId: true, returnFlightId: true, ...BUNDLE_ROUTE_SELECT },
    }),
    client.flight.findMany({
      where: { isActive: true },
      select: { id: true, originCode: true, destinationCode: true },
    }),
  ]);

  const withRates = new Set(rateRows.map((r) => r.routeKey));
  const byKey = new Map<string, SettlementRouteDto>();
  const add = (routeKey: string): void => {
    const parsed = parseRouteKey(routeKey);
    if (!parsed) return; // 表里的脏键不进下拉（历史手工写入的非法值不该污染选项）
    const key = routeKeyOf(parsed.origin, parsed.destination);
    if (byKey.has(key)) return;
    byKey.set(key, {
      routeKey: key,
      origin: parsed.origin,
      destination: parsed.destination,
      hasRates: withRates.has(key),
    });
  };

  for (const r of rateRows) add(r.routeKey);
  for (const r of ruleRows) add(r.routeKey);

  const outboundIds = new Set<string>();
  const returnIds = new Set<string>();
  for (const b of bundles) {
    if (b.outboundFlightId) outboundIds.add(b.outboundFlightId);
    if (b.returnFlightId) returnIds.add(b.returnFlightId);
    const derived = bundleRouteKey(b);
    if (derived) add(derived);
  }
  for (const f of flights) {
    const returnOnly = returnIds.has(f.id) && !outboundIds.has(f.id);
    if (returnOnly) continue;
    add(routeKeyOf(f.originCode, f.destinationCode));
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.hasRates !== b.hasRates) return a.hasRates ? -1 : 1;
    return a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0;
  });
}
