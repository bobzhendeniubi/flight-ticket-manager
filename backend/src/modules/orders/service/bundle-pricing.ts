// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  assertHotelPhysicalFitWithinTx,
  assertRandomTierFitWithinTx,
  type PhysicalFitViolation,
  type ProspectiveOccupancy,
  type RandomTierFitViolation,
} from '../../hotel-control/hotel-control.service.js';
import { normalizeCityCode, RANDOM_TIER_LEGACY_CITY_CODE } from '../../hotel-control/hotel-city.js';
import { bundleItemMetadataSchema } from '../orders.schemas.js';
import type { OrderItemInput } from '../orders.schemas.js';
import { DAY_MS, DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG, round2 } from './shared.js';

/**
 * 套餐关联了酒店房型时，从订单行 metadata（goDate/returnDate）推导入住/退房日期。
 * - returnDate 合法且晚于 goDate → 用 returnDate 做退房日
 * - 否则按 goDate + nights 推退房日（nights 由 resolveBundleNights 解析的单一权威晚数，调用方传入）
 * - 套餐没关联房型、或 goDate 缺失/非法 → 返回 null（不盖章，下单照常）
 *
 * 导出仅供单测使用。
 */
/**
 * 把住宿区间 [checkIn, checkOut)（半开）展开为逐晚 YYYY-MM-DD（UTC date-only）。
 * 供套餐下单时的酒店房量库存校验用（口径与 getHotelNightlyRemaining / 房控完全一致）。
 * 防御：checkOut <= checkIn 或跨度异常大 → 返回空数组（调用方按"无从校验"跳过，不阻断下单）。
 */
export const MAX_STAY_NIGHTS = 60;
export function buildStayNightDates(checkIn: Date, checkOut: Date): string[] {
  const startMs = checkIn.getTime();
  const endMs = checkOut.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const nights = Math.round((endMs - startMs) / DAY_MS);
  if (nights < 1 || nights > MAX_STAY_NIGHTS) return [];
  return Array.from({ length: nights }, (_, i) =>
    new Date(startMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * 把 HOTEL 行 description 里的「日期段」与「晚数段」就地改写成新住宿区间，其余部分原样保留。
 *
 * 为什么用就地改写而不是整条重建：HOTEL 行的 description 历史上有多种形态 ——
 *   · 建单/换酒店：`酒店名 · 房型 · 2026-09-01~2026-09-04 · 3晚 × 1间`
 *   · 后台补录房费：`酒店名 · 房型 × 3晚 × 1间`（没有日期段）
 *   · 更老的存量单：可能是运营手填的自由文本
 * 整条重建会把手填信息冲掉，也会强行给本来没有日期段的行硬塞一段。就地改写只动确实存在的
 * 那两段，其余（酒店名/房型/间数/手填备注）一个字不碰。
 *
 * 只替换第一处匹配：日期段与晚数段在这些格式里都只出现一次，全局替换反而会误伤备注里的日期。
 * 两段都不存在（纯自由文本）→ 原样返回，不报错（描述只是展示，不是权威数据；权威在
 * hotelCheckIn/hotelCheckOut 字段上）。
 *
 * 导出仅供单测使用。
 */
export function rewriteHotelStayDescription(
  description: string,
  stay: { checkIn: string; checkOut: string; nights: number },
): string {
  return description
    .replace(/\d{4}-\d{2}-\d{2}\s*~\s*\d{4}-\d{2}-\d{2}/, `${stay.checkIn}~${stay.checkOut}`)
    .replace(/\d+(?:\.\d+)?\s*晚/, `${stay.nights}晚`);
}

// ── 事务内酒店房量闸（新增真实占房的写路径统一入口）─────────────────────────
/** 对外端点的中性话术：不把包房间数/余量这些内部库存数字回给客人。*/
export const HOTEL_SOLD_OUT_MESSAGE = '该出发日期酒店可用房量不足，请更换日期或联系客服';

/** 一条「本次打算落库」的酒店占房（口径同 OrderItem 的占房四件套）。*/
export interface ProspectiveHotelStay {
  hotelRoomTypeId?: string | null;
  hotelCheckIn?: Date | null;
  hotelCheckOut?: Date | null;
  /** 计费房间数（床位/计费口径，可为 0.5 拼房）；缺省 1，与房控 itemRoomCount 的兜底一致。*/
  roomsBilled?: number | null;
  /** 未落位随机档行的档次（3/4）；具体酒店行为空。*/
  randomStarTier?: number | null;
}

/**
 * 事务内**随机档**余量闸：把本次要落库的「未落位随机档占房」按「档次 × 住宿区间」归并，
 * 逐组过一遍带行锁的聚合闸（assertRandomTierFitWithinTx）。装不下就抛 BadRequestError、整事务回滚。
 *
 * 与 assertHotelStaysFitWithinTx 是互斥的两半（合起来覆盖全部占房）：
 *   · 那一半管**真酒店的真房量**（物理房间口径 + 性别桶）；
 *   · 这一半管**还没落位的随机档**（同星级聚合的床位口径）—— 随机单没落到任何一家酒店，
 *     拼房能否配对要等落位那一刻由该店当晚性别桶决定，落位走换酒店流程、那里有物理闸把关。
 *
 * 两类行都归到这里（它们占的是同一份聚合余量，必须合并计数）：
 *   · 单独 HOTEL 行的 `randomStarTier`（后台直接录「三星随机」）；
 *   · 房型挂在**随机档占位酒店**上的行（套餐绑定占位房型）—— 占位酒店不是真房源，
 *     tier 取该酒店的 `randomTierPlaceholder`。
 *
 * 为什么必须事务内 + 行锁：聚合闸本身是只读判定，两笔并发单抢同星级最后一间会各自读到
 * 「还剩 1 间」的旧快照双双通过。带锁版先把该档次全部真酒店在该区间的包房周期行
 * `SELECT … FOR UPDATE`，后到的事务要等前一个提交后重新取快照，才真正互斥。
 * 调用方必须在 `prisma.$transaction` 内调用，且本次占房在**同一事务**里落库。
 *
 * 归并同样是必需的：同一单两条随机档行各判一次会双双通过（它们都还没落库、彼此看不见）。
 * 加锁顺序按归并键排序，避免并发事务以不同顺序锁同一批档次造成死锁。
 */
/** 建单事务闸容忍的随机档超卖明细（按城市 × 档次归并后逐组）。*/
export interface RandomTierOversellRecord {
  tier: number;
  /** 归一后的城市码（随机档按城市圈定；单独随机行 = 存量默认城市）。*/
  cityCode: string;
  violations: RandomTierFitViolation[];
}

export async function assertRandomTierStaysFitWithinTx(
  tx: Prisma.TransactionClient,
  stays: ReadonlyArray<ProspectiveHotelStay>,
  opts: { excludeOrderId?: string; maxOversellRooms?: number; buildMessage?: () => string } = {},
): Promise<RandomTierOversellRecord[]> {
  const dated = stays.filter(
    (s): s is ProspectiveHotelStay & { hotelCheckIn: Date; hotelCheckOut: Date } =>
      Boolean(s.hotelCheckIn && s.hotelCheckOut),
  );
  if (dated.length === 0) return [];

  // 占位酒店房型 → 档次：只对「有房型 id 且无显式 randomStarTier」的行查一次库。
  const placeholderLookupIds = [
    ...new Set(
      dated
        .filter((s) => s.randomStarTier == null && s.hotelRoomTypeId)
        .map((s) => s.hotelRoomTypeId as string),
    ),
  ];
  // 随机档按城市圈定：占位酒店行的城市取占位酒店的 cityCode（与档次一起查回）。
  const placeholderByRoomTypeId = new Map<string, { tier: number; cityCode: string }>();
  if (placeholderLookupIds.length > 0) {
    const roomTypes = await tx.hotelRoomType.findMany({
      where: { id: { in: placeholderLookupIds } },
      select: { id: true, hotel: { select: { randomTierPlaceholder: true, cityCode: true } } },
    });
    for (const rt of roomTypes) {
      if (rt.hotel.randomTierPlaceholder != null) {
        placeholderByRoomTypeId.set(rt.id, {
          tier: rt.hotel.randomTierPlaceholder,
          cityCode: normalizeCityCode(rt.hotel.cityCode),
        });
      }
    }
  }

  type TierGroup = { tier: number; cityCode: string; nightDates: string[]; rooms: number };
  const groups = new Map<string, TierGroup>();
  for (const stay of dated) {
    // 单独随机行（randomStarTier 非空）没有酒店也就没有城市 → 存量默认城市；
    // 占位酒店房型行 → 档次与城市都取占位酒店的。
    const scope =
      stay.randomStarTier != null
        ? { tier: stay.randomStarTier, cityCode: RANDOM_TIER_LEGACY_CITY_CODE }
        : stay.hotelRoomTypeId
          ? placeholderByRoomTypeId.get(stay.hotelRoomTypeId)
          : undefined;
    // 具体酒店的真房型 → 不归这道闸管（走 assertHotelStaysFitWithinTx）。
    if (scope == null) continue;
    const nightDates = buildStayNightDates(stay.hotelCheckIn, stay.hotelCheckOut);
    // 空 = 区间非法/超长（buildStayNightDates 的防御）→ 无从校验，与既有口径一致不阻断。
    if (nightDates.length === 0) continue;
    // 首尾夜唯一确定整段（逐晚连续），连同城市与档次一起可安全用作归并键。
    const key = `${scope.cityCode}|${scope.tier}|${nightDates[0]}|${nightDates[nightDates.length - 1]}`;
    const rooms = stay.roomsBilled ?? 1;
    const existing = groups.get(key);
    if (existing) {
      existing.rooms = round2(existing.rooms + rooms);
    } else {
      groups.set(key, { tier: scope.tier, cityCode: scope.cityCode, nightDates, rooms });
    }
  }

  const tolerated: RandomTierOversellRecord[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const violations = await assertRandomTierFitWithinTx(
      tx,
      { tier: group.tier, cityCode: group.cityCode },
      group.nightDates,
      group.rooms,
      opts,
    );
    if (violations.length > 0) {
      tolerated.push({ tier: group.tier, cityCode: group.cityCode, violations });
    }
  }
  return tolerated;
}

/**
 * 事务内酒店房量闸：把本次要落库的占房按「酒店 × 住宿区间」归并，逐组过一遍**带行锁**的
 * 物理房间前瞻闸（assertHotelPhysicalFitWithinTx）。装不下就抛 BadRequestError，整事务回滚。
 *
 * 为什么必须是事务内 + 行锁：前瞻闸本身是「查一遍 + 纯内存推算」的只读判定，两个请求同时抢
 * 最后 1 间会各自读到「还剩 1 间」的旧快照双双通过。带锁版先把该酒店该区间的包房周期行
 * `SELECT … FOR UPDATE`，后到的事务要等前一个提交后重新取快照，才真正互斥。
 *
 * 调用方必须满足（否则锁白加）：
 *   1. 在 `prisma.$transaction(async (tx) => { … })` 里调用，把同一个 `tx` 传进来；
 *   2. 本次占房（OrderItem 的 hotelRoomTypeId + hotelCheckIn/hotelCheckOut/roomsBilled）
 *      必须在**同一个事务**里写入 —— 行锁随事务提交才释放；
 *   3. 隔离级别用默认的 READ COMMITTED 即可。
 *
 * 归并口径：同一酒店、同一住宿区间的多条行合并成一笔前瞻占房（整间数相加、拼房客性别桶合并）。
 * 逐行各判一次会让「同单两条行各抢最后一间」双双通过 —— 它们都还没落库，彼此看不见对方。
 * 加锁顺序按归并键排序，避免并发事务以不同顺序锁同一批酒店造成死锁。
 *
 * 跳过两类行（都不是「真酒店的真房量」，不该拿具体酒店的库存去判）：
 *   · 房型查不到 —— 上游各自有 NotFoundError 负责报错，这里不抢它的活；
 *   · 房型挂在**随机档占位酒店**上（randomTierPlaceholder 非空）—— 那不是真房源，
 *     这类行走随机档聚合闸（assertRandomTierFit），与本闸互斥不重叠。
 */
/** 建单事务闸容忍的具体酒店超卖明细（按酒店×区间归并后逐组）。*/
export interface HotelStayOversellRecord {
  hotelId: string;
  violations: PhysicalFitViolation[];
}

export async function assertHotelStaysFitWithinTx(
  tx: Prisma.TransactionClient,
  stays: ReadonlyArray<ProspectiveHotelStay>,
  passengers: ReadonlyArray<{ gender?: 'M' | 'F' | 'X' }> | undefined,
  opts: { excludeOrderId?: string; maxOversellRooms?: number; buildMessage?: () => string } = {},
): Promise<HotelStayOversellRecord[]> {
  const rows = stays.filter(
    (s): s is ProspectiveHotelStay & {
      hotelRoomTypeId: string;
      hotelCheckIn: Date;
      hotelCheckOut: Date;
    } => Boolean(s.hotelRoomTypeId && s.hotelCheckIn && s.hotelCheckOut),
  );
  if (rows.length === 0) return [];

  const roomTypes = await tx.hotelRoomType.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.hotelRoomTypeId))] } },
    select: { id: true, hotelId: true, hotel: { select: { randomTierPlaceholder: true } } },
  });
  const roomTypeById = new Map(roomTypes.map((rt) => [rt.id, rt]));

  type FitGroup = {
    hotelId: string;
    nightDates: string[];
    wholeRooms: number;
    solos: Array<'M' | 'F' | 'U'>;
  };
  const groups = new Map<string, FitGroup>();
  for (const row of rows) {
    const roomType = roomTypeById.get(row.hotelRoomTypeId);
    if (!roomType || roomType.hotel.randomTierPlaceholder != null) continue;
    const nightDates = buildStayNightDates(row.hotelCheckIn, row.hotelCheckOut);
    // 空 = 区间非法/超长（buildStayNightDates 的防御）→ 无从校验，与既有口径一致不阻断。
    if (nightDates.length === 0) continue;
    // 首尾夜唯一确定整段（逐晚连续），可安全用作归并键。
    const key = `${roomType.hotelId}|${nightDates[0]}|${nightDates[nightDates.length - 1]}`;
    const prospective = toProspectiveOccupancy(row.roomsBilled ?? 1, passengers);
    const existing = groups.get(key);
    if (existing) {
      existing.wholeRooms += prospective.wholeRooms;
      existing.solos.push(...prospective.solos);
    } else {
      groups.set(key, {
        hotelId: roomType.hotelId,
        nightDates,
        wholeRooms: prospective.wholeRooms,
        solos: [...prospective.solos],
      });
    }
  }

  const tolerated: HotelStayOversellRecord[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const violations = await assertHotelPhysicalFitWithinTx(
      tx,
      group.hotelId,
      group.nightDates,
      { wholeRooms: group.wholeRooms, solos: group.solos },
      {
        excludeOrderId: opts.excludeOrderId,
        maxOversellRooms: opts.maxOversellRooms,
        // 不传 → 用 assertHotelPhysicalFit 自带的带数字文案（后台录单要看得见差多少间）；
        // 对外可达的端点（前台下单）显式传中性话术，别把包房间数回给客人。
        buildMessage: opts.buildMessage,
      },
    );
    if (violations.length > 0) tolerated.push({ hotelId: group.hotelId, violations });
  }
  return tolerated;
}

/**
 * 星级随机档行的成本快照来源：取**同星级酒店**覆盖入住首晚的包房周期切房单价（CNY/间/晚）里
 * 的最高价。随机档行没有具体房型可查价，切房单价就是我们付给酒店的真实每间每晚成本
 * —— 与具体酒店行取 HotelRoomType.costPriceCny 语义一致（都是成本侧，售价另说）。
 *
 * 为什么取**最高**而不是平均/最低：这单最终会被房控落到该星级里的**某一家**酒店，落到哪家
 * 下单这一刻并不知道。取最高 = 最坏情况成本，毛利宁可报低不报高（与「产品未录成本就留空、
 * 绝不落 0 虚高」同一取向）。同一家酒店有多条周期覆盖该晚时，取其有价周期中 dateFrom 最晚
 * 的一条（"最新一次切房的价"，与销控板 unitPrice 展示口径一致）。
 *
 * 该星级一家酒店都没切房 / 都没填价 → undefined（毛利显示「未知」，不落 0 虚高）。
 * 注：不读存量的随机档池周期 —— 随机档已改为同星级酒店的派生聚合，那份数据只留作审计。
 */
export async function resolveRandomTierNightlyCost(
  randomStarTier: number,
  checkIn: string,
): Promise<number | undefined> {
  const d = new Date(`${checkIn}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  const periods = await prisma.hotelBlockPeriod.findMany({
    where: {
      // 与 hotel-control 的档次口径同源：星级命中、排除国际五星与占位酒店
      // （占位酒店不是真房源，它名下的切房单价不是任何真实成本）。
      hotel: { starRating: randomStarTier, intlFiveStar: false, randomTierPlaceholder: null },
      dateFrom: { lte: d },
      dateTo: { gte: d },
      unitPrice: { not: null },
    },
    orderBy: { dateFrom: 'desc' },
    select: { hotelId: true, unitPrice: true },
  });
  // 每家酒店只认其最新一条有价周期（findMany 已按 dateFrom 倒序 → 首次见到的即最新）
  const latestByHotel = new Map<string, number>();
  for (const p of periods) {
    if (!p.hotelId || p.unitPrice == null || latestByHotel.has(p.hotelId)) continue;
    const price = Number(p.unitPrice.toString());
    if (Number.isFinite(price)) latestByHotel.set(p.hotelId, price);
  }
  if (latestByHotel.size === 0) return undefined;
  return Math.max(...latestByHotel.values());
}

/**
 * 团队议价结算价按航段分摊（A9）。
 *
 * `settlementPriceCny` 是「每位出行人**整程**价」，不是「每人每段价」。往返单有两条 FLIGHT 行，
 * 逐行各写满价会把每人收两遍（填 3600 往返 → 每人实收 7200）。这里把整程价切成各段的每人价，
 * **各段之和恰好等于整程价**（按分为单位分配，除不尽的余数全部给第一段），
 * 与结算价日历「去程价 + 回程价求和 = 每人整程价」的口径一致。
 *
 * legCount ≤ 1（单程 / 无航段）→ 原样返回整程价，行为与修正前完全一致。
 * 导出供单测直接断言金额。
 */
export function splitSettlementPriceAcrossLegs(
  pricePerPersonCny: number,
  legCount: number,
): number[] {
  if (!Number.isFinite(pricePerPersonCny) || legCount <= 0) return [];
  if (legCount === 1) return [round2(pricePerPersonCny)];
  const totalCents = Math.round(pricePerPersonCny * 100);
  const baseCents = Math.floor(totalCents / legCount);
  const remainderCents = totalCents - baseCents * legCount;
  return Array.from({ length: legCount }, (_, i) =>
    // 余数全给第一段：合计精确等于整程价，且不会出现「每段都多一分」的累积漂移。
    ((i === 0 ? baseCents + remainderCents : baseCents) / 100),
  );
}

/**
 * 套餐「地面部分」权威价（CNY，整数，≥0）—— 录单与售后改档共用的单一口径。
 *
 *   HOTEL 组件（qty=晚数）  = 每间每晚价 × qty × rooms  → 套餐价随房间数涨；
 *     每间每晚价 = linkedHotelNightlyPrice（套餐绑定房型的 basePrice，服务端权威）优先，
 *     回退 components JSON 里的 unitPrice（未绑房型的老套餐才会走到）。
 *     绝不无条件信任 JSON 里的 unitPrice：历史上那可能是占位/过时的畸低值，
 *     会把套餐酒店部分算成几元、整单总价崩塌。
 *   VISA 组件           = 每份单价 × 办签人数（visaHeadCount，已扣自备签人数）。
 *   TRANSFER 等其它组件  = qty × unitPrice（整车/整趟计价，不随人数缩放）。
 *   FLIGHT 组件不计      = 机票由 FLIGHT 行单独动态定价。
 *
 * 套餐折扣（percent-off）不在此扣 —— 由调用方在行金额层统一处理。
 */
export function computeBundleGroundTotal(input: {
  /** Bundle.items（JSON）；非数组一律按空处理，绝不因脏数据抛错。 */
  components: unknown;
  linkedHotelNightlyPrice: number | null;
  rooms: number;
  visaHeadCount: number;
}): number {
  const components = Array.isArray(input.components)
    ? (input.components as Array<{ kind: string; qty: number; unitPrice: number }>)
    : [];
  const groundTotal = components
    .filter((b) => b && b.kind !== 'FLIGHT')
    .reduce((s, b) => {
      if (b.kind === 'HOTEL') {
        const nightlyPrice = input.linkedHotelNightlyPrice ?? b.unitPrice;
        return s + b.qty * nightlyPrice * input.rooms;
      }
      if (b.kind === 'VISA') {
        // 每份签证单价（unitPrice 写入时已由 products.service 覆盖为 Visa.basePrice/人）× 办签人数。
        return s + input.visaHeadCount * b.unitPrice;
      }
      // TRANSFER 等：固定 qty×unitPrice（整车/整趟计价，按趟不按人头，不随人数缩放）。
      return s + b.qty * b.unitPrice;
    }, 0);
  return Math.max(0, Math.round(groundTotal));
}

export function resolveBundleHotelStamp(
  bundle: { hotelRoomTypeId: string | null },
  metadata: Record<string, unknown> | undefined,
  nights: number,
): { hotelRoomTypeId: string; hotelCheckIn: Date; hotelCheckOut: Date } | null {
  if (!bundle.hotelRoomTypeId) return null;
  const meta = bundleItemMetadataSchema.parse(metadata ?? {});
  if (!meta.goDate) return null;
  const checkIn = new Date(meta.goDate);
  if (Number.isNaN(checkIn.getTime())) return null;
  const safeNights = Math.max(1, Math.trunc(nights));
  const returnDate = meta.returnDate ? new Date(meta.returnDate) : null;
  const checkOut =
    returnDate && !Number.isNaN(returnDate.getTime()) && returnDate.getTime() > checkIn.getTime()
      ? returnDate
      : new Date(checkIn.getTime() + safeNights * DAY_MS);
  return {
    hotelRoomTypeId: bundle.hotelRoomTypeId,
    hotelCheckIn: checkIn,
    hotelCheckOut: checkOut,
  };
}

// ── 套餐可选升级 add-on 重算（server-priced）─────────────────────────
/** 写到订单行 metadata.addOns 的升级重算明细（金额单位 CNY，整数）。 */
export interface BundleAddOnBreakdown {
  singleCount: number; // 选「一个人住酒店（单人入住）」的人数
  /**
   * 选「升舱商务」的人数（整程口径，= max(去程, 回程)）。
   * 旧字段保留供既有展示/导出读取；真正的每程人数看下面两个分程字段。
   */
  businessCount: number;
  businessCountOutbound: number; // 去程升舱人数（占去程班次的真实商务舱座位）
  businessCountReturn: number; // 回程升舱人数（单程套餐 legs=1 时恒为 0）
  // 占座模型（业务需求）：成人 / 占座儿童 / 不占座婴儿
  adultCount: number; // 成人数（占座、占房）
  childCount: number; // 占座儿童数（占座、占房；机票按成人价减折扣）
  infantCount: number; // 不占座婴儿数（不占座、不占房；按婴儿价收）
  seatPax: number; // 占座人数 = adultCount + childCount（拼房按此计房；businessCount ≤ seatPax）
  headCount: number; // 全部出行人 = adultCount + childCount + infantCount（都需护照）
  rooms: number; // 拼房间数 = ceil(seatPax / 2)（婴儿不占房）
  nights: number; // 计费晚数（用于单人入住房差）
  legs: number; // 计费航段数（用于升舱商务）
  singleSupplementCnyPerNight: number; // 该套餐配置的单人入住房差/晚
  businessUpgradeCnyPerLeg: number; // 该套餐配置的升舱/航段
  childSeatDiscountCnyPerPerson: number; // 该套餐配置的占座儿童折扣/人
  infantPriceCny: number; // 该套餐配置的婴儿价/人
  selfProvidedVisaCount: number; // 自备签证（自行办妥签证）人数：乘客级勾选数 / 旧整单布尔 → 1
  selfProvidedVisa: boolean; // 是否有自备签证乘客（= selfProvidedVisaCount > 0；向后兼容展示用）
  selfVisaDeductCny: number; // 该套餐配置的自备签证减免/人
  singleSupplementTotal: number; // = singleCount × rate × nights
  // 分程口径 = (去程人数 + 回程人数) × rate；旧整程口径 = businessCount × rate × legs
  businessUpgradeTotal: number;
  childSeatDiscountTotal: number; // = childCount × childSeatDiscountCnyPerPerson（机票折扣，负向计入套餐行）
  infantPriceTotal: number; // = infantCount × infantPriceCny（婴儿机票价，正向计入套餐行）
  selfVisaDeductTotal: number; // = selfProvidedVisaCount × selfVisaDeductCny（自备签证减免，负向计入套餐行）
  total: number; // 升级加价 + 婴儿价 − 儿童折扣 − 自备签证减免 的净额（计入套餐行总额）
}

/**
 * 套餐占座模型归一化（纯函数，向后兼容）。
 * 优先用订单行显式三计数；缺省时用 metadata.adultCount/childCount/infantCount；
 * 若三者都没有，则把旧的 pax（metadata.pax）或行 quantity 视为 adultCount（child/infant = 0），
 * 保证旧客户端/旧订单的占座 + 定价与扩展前完全一致。
 *
 * 导出供单测与 createOrder 共用。
 */
export interface BundleOccupancyInput {
  adultCount?: number;
  childCount?: number;
  infantCount?: number;
  quantity?: number;
  metadata?: Record<string, unknown>;
}
export interface BundleOccupancy {
  adultCount: number;
  childCount: number;
  infantCount: number;
  seatPax: number; // adult + child（占座）
  headCount: number; // adult + child + infant（出行人）
  rooms: number; // ceil(seatPax / 2)
}
export function resolveBundleOccupancy(item: BundleOccupancyInput): BundleOccupancy {
  const meta = bundleItemMetadataSchema.parse(item.metadata ?? {});
  const norm = (v: number | undefined): number | undefined =>
    v == null ? undefined : Math.max(0, Math.trunc(v));
  // 显式行字段优先，其次 metadata 字段
  const adultExplicit = norm(item.adultCount) ?? norm(meta.adultCount);
  const childExplicit = norm(item.childCount) ?? norm(meta.childCount);
  const infantExplicit = norm(item.infantCount) ?? norm(meta.infantCount);
  const hasExplicit =
    adultExplicit != null || childExplicit != null || infantExplicit != null;

  let adultCount: number;
  let childCount: number;
  let infantCount: number;
  if (hasExplicit) {
    adultCount = adultExplicit ?? 0;
    childCount = childExplicit ?? 0;
    infantCount = infantExplicit ?? 0;
  } else {
    // 向后兼容：旧 pax（metadata.pax）或行 quantity → 全部当成成人
    adultCount = Math.max(0, Math.trunc(meta.pax ?? item.quantity ?? 0));
    childCount = 0;
    infantCount = 0;
  }
  const seatPax = adultCount + childCount;
  const headCount = adultCount + childCount + infantCount;
  const rooms = Math.ceil(seatPax / 2); // 每人 0.5 间；婴儿不占房（旧拼房口径，展示用）
  return { adultCount, childCount, infantCount, seatPax, headCount, rooms };
}

// ── 按房型容量算所需房间数（C-v2 核心）────────────────────────────────
/**
 * 业务口径："每个酒店房型可以 fit 几大人几小孩；选的人数一间房坐不下时，自动加房。"
 * 外加："选了单人入住的人，每人自己独占一间"——独住的人不跟别人挤，也不占别人的床位。
 *
 *   soloRooms   = clamp(singleCount, 0, 成人数)          // 独住者每人 1 间
 *   sharedAdults= 成人数 − soloRooms                      // 其余成人才参与拼间
 *   roomsNeeded = max( soloRooms + max( ceil(sharedAdults / maxAdults),
 *                                       ceil(占座儿童 / maxChildren) ), 1 )
 *
 * - 婴儿不占床 → 不参与计算。
 * - maxChildren=0 且有占座儿童时：把儿童并入成人维度 ceil((sharedAdults+child)/maxAdults)
 *   近似（避免除 0；lone-child packing edge case）。正常配置 maxChildren≥1 不会走到这里。
 * - 套餐没绑房型 / 容量缺失 → 回退默认 2大1小（等价旧 ceil(seatPax/2)-ish 行为）。
 * - singleCount 缺省 0 → 结果与加入该维度之前完全一致（老调用方零影响）。
 *
 * 口径变更记录（原口径：singleCount **不**计入 roomsNeeded，仅作为独立自愿加价项）：
 *   原口径下「2 位成人都勾单人入住」= 1 间 —— 但两个人各自独住物理上就是要 2 间，
 *   房量校验会据此少算、导致超卖，且这个 roomsNeeded 正是喂给物理房间前瞻闸的整间数输入，
 *   输入错了闸再准也白搭。故按「独住者各占一间」修正。
 *   单人入住房差（singleSupplementCnyPerNight × singleCount × nights）仍是**独立**加价项，
 *   由 computeBundleAddOn 另算，与本函数的间数互不重复计价。
 *   仅对新单生效：不回填存量单的 roomsBilled / total。
 *
 * 导出供单测与 createOrder 共用。
 */
export const DEFAULT_ROOM_MAX_ADULTS = 2;
export const DEFAULT_ROOM_MAX_CHILDREN = 1;
export function computeRoomsNeeded(
  occupancy: Pick<BundleOccupancy, 'adultCount' | 'childCount'>,
  capacity: { maxAdults?: number | null; maxChildren?: number | null } | null,
  singleCount = 0,
): number {
  const maxAdults = Math.max(1, Math.trunc(capacity?.maxAdults ?? DEFAULT_ROOM_MAX_ADULTS));
  const maxChildrenRaw = Math.trunc(capacity?.maxChildren ?? DEFAULT_ROOM_MAX_CHILDREN);
  const adults = Math.max(0, occupancy.adultCount);
  const children = Math.max(0, occupancy.childCount);
  // 独住人数夹到 [0, 成人数]：单人入住是成人维度的选项，不能超过成人数、也不能为负。
  const soloRooms = Math.min(Math.max(0, Math.trunc(singleCount)), adults);
  const sharedAdults = adults - soloRooms;

  const adultRooms = Math.ceil(sharedAdults / maxAdults);
  // maxChildren=0 → 该房型不单独承载儿童；把儿童并入成人维度（lone-child packing edge case）。
  const childRooms =
    maxChildrenRaw > 0
      ? Math.ceil(children / maxChildrenRaw)
      : Math.ceil((sharedAdults + children) / maxAdults);
  // 独住间与「其余人拼出来的间」相加；整单至少 1 间（0 成人 0 儿童的兜底，与旧口径一致）。
  return Math.max(soloRooms + Math.max(adultRooms, childRooms), 1);
}

// ── 物理房间前瞻闸的输入翻译（床位/计费口径 → 物理口径）─────────────────────
/**
 * 把「本单酒店部分要新增的占房」翻译成物理房间前瞻闸的输入（ProspectiveOccupancy）。
 *
 *   roomsCharged === 0.5（单人拼房；床位/计费口径的半间）→ 1 位拼房客，按性别进桶配对；
 *   其余                                                → 整间数（向上取整防御脏小数），不进拼房桶。
 *
 * 性别口径与房控 pickSoloGender 严格一致（下单后这一单就是被那套口径数进销控板的，
 * 两边必须同一口径，否则闸放行的单会在看板上变成超卖）：
 *   取第一位性别为 M/F 的出行人；X / 未填 / 无出行人 → 'U' —— 保守口径每人独占 1 间，
 *   即「拼单性别未知就把它单独出来」，不参与自动配对。
 *
 * 导出供单测与 createOrder 共用。
 */
export function toProspectiveOccupancy(
  roomsCharged: number,
  passengers: ReadonlyArray<{ gender?: 'M' | 'F' | 'X' }> | undefined,
): ProspectiveOccupancy {
  if (roomsCharged === 0.5) {
    const explicit = passengers?.find((p) => p.gender === 'M' || p.gender === 'F')?.gender;
    return { wholeRooms: 0, solos: [explicit === 'M' || explicit === 'F' ? explicit : 'U'] };
  }
  return { wholeRooms: Math.max(0, Math.ceil(roomsCharged)), solos: [] };
}

// ── 套餐酒店计费房间数（server-authoritative；含单人拼房 0.5 间口径）──────────
/**
 * 计算套餐酒店部分应计费的房间数（钱路径，权威计算，不轻信客户端）。
 *
 * 业务口径：一个人报套餐（1 成人 / 0 儿童，婴儿不占房）且**不**独住时，愿意拼房共用一间，
 * 只按 0.5 间收费（床位口径）；独住（singleCount ≥ 1）则照旧收整间 + 单人入住房差。
 * 2 人及以上、或含占座儿童 → 沿用 computeRoomsNeeded 的容量口径（不变）。
 *
 *   isSoloSharing = 绑了套餐房型 且 adultCount===1 且 childCount===0 且 singleCount(缺省0)===0
 *   roomsCharged  = isSoloSharing ? 0.5 : physicalRooms(容量推算)
 *
 * 仅对绑定套餐房型（hotelRoomTypeId 存在）生效；未绑房型的老套餐不走 0.5 口径。
 *
 * server-authoritative：客户端传的 roomsBilled 只能「上调」不能「下压」——最终取
 * max(clientRooms, roomsCharged)。这样单人拼房单不会被 2 人单伪造成 0.5 间少付钱，
 * 同时保留「录单方主动多开房」等向上调整的向后兼容能力。
 *
 * 导出供单测与 createOrder BUNDLE 分支共用（同一份权威口径，避免漂移）。
 */
export function computeBundleRoomsCharged(params: {
  occupancy: Pick<BundleOccupancy, 'adultCount' | 'childCount'>;
  capacity: { maxAdults?: number | null; maxChildren?: number | null } | null;
  hotelRoomTypeId: string | null;
  singleCount: number | undefined;
  clientRoomsBilled: number | undefined;
}): number {
  const { occupancy, capacity, hotelRoomTypeId, singleCount, clientRoomsBilled } = params;
  // singleCount 传进容量口径：独住者各占一间（见 computeRoomsNeeded 的口径变更记录）。
  // 不会与下方 isSoloSharing 重复加间——isSoloSharing 恒要求 singleCount===0。
  const physicalRooms = computeRoomsNeeded(occupancy, capacity, singleCount);
  const isSoloSharing =
    hotelRoomTypeId != null &&
    occupancy.adultCount === 1 &&
    occupancy.childCount === 0 &&
    (singleCount ?? 0) === 0;
  const roomsCharged = isSoloSharing ? 0.5 : physicalRooms;
  // 权威下限：客户端只能上调、不能下压（防止把多人单伪造成 0.5 间）。
  if (clientRoomsBilled != null) {
    return Math.max(clientRoomsBilled, roomsCharged);
  }
  return roomsCharged;
}

/**
 * 套餐升级加价权威重算（不信任客户端金额）。公式：
 *   nights = stamp 推导的入住晚数（无房型 → hotelNights ?? 1）
 *   legs   = bundle.legs（来回默认 2）
 *   单人入住房差 = singleCount × singleSupplementCnyPerNight × nights
 *   升舱商务加价 = 分程口径（去程人数 + 回程人数）× businessUpgradeCnyPerLeg
 *                 旧整程口径（businessCount 为数字）沿用 businessCount × businessUpgradeCnyPerLeg × legs
 *   自备签证减免 = selfProvidedVisaCount × selfVisaDeductCny（自行办妥签证的人数，从套餐行扣减）
 * singleCount / businessCount / selfProvidedVisaCount 缺省 0 → total=0 → 套餐价与旧版完全一致（向后兼容）。
 *
 * 升舱分程（去程/回程可以升不同人数）：第 4 个参数传对象 `{ outbound, return }` 即分程口径；
 * 传数字/缺省 = 旧整程口径（每程同人数，× legs），公式原样保留，历史入参重算结果一分不差。
 * 单程套餐（legs=1）下回程人数恒按 0 处理 —— 没有回程航段可占座，也就不该收回程升舱费。
 *
 * selfProvidedVisaCount 语义（两种模式，调用处 priceAndValidateItems 决定 count）：
 *   · 旧整单口径：录单勾「客人自备签证」布尔 true → count=1（整单减一次 −selfVisaDeductCny）。
 *   · 新乘客级：同一订单各乘客各选 → count=勾「自备签」的人数（每人减一次）。
 * count 夹到 [0, headCount]（自备签是按人的，最多全体出行人）。
 *
 * 导出仅供单测使用。
 */
/**
 * 套餐每人操作费总额（服务端权威，不信客户端）。
 *   操作费 = max(0, trunc(operationFeeCny)) × seatPax（占座人数：成人 + 占座儿童；婴儿不收）
 * operationFeeCny 由 Bundle.operationFeeCny 提供（DB @default(20)，运营可在套餐向导改）；
 * 负值/小数夹到非负整数。计入套餐地面金额，随 discountPct 一并 percent-off，与起价把操作费
 * 计入 originalPerPaxCny 原价再打折的口径一致。导出仅供单测使用。
 */
export function computeBundleOperationFeeTotal(operationFeeCny: number, seatPax: number): number {
  // Number(x)||0 兜底：DB 有 @default(20) 保证非空，但防御旧数据/未选字段导致的 undefined→NaN。
  const perPax = Math.max(0, Math.trunc(Number(operationFeeCny) || 0));
  const pax = Math.max(0, Math.trunc(Number(seatPax) || 0));
  return perPax * pax;
}

/**
 * 套餐乘客级「住宿方式 + 签证」派生（纯函数，向后兼容）。
 *
 * 购物车模式：同一订单每人各选自己的住宿方式（拼房/单住）与签证（随套餐/自备签），价差全部系统算。
 * 优先级（两维各自独立判定，互不干扰）：
 *   · 自备签：passengers 里任一乘客显式提供 visaExempt（true/false 均算「提供」）→ 以勾 true 的人数为权威；
 *            否则回落 item.selfProvidedVisa 布尔（旧整单口径 true → 记 1 次，整单减一次）。
 *   · 单住：  passengers 里任一乘客显式提供 singleRoom → 以勾 true 的人数为权威；
 *            否则回落 item.singleCount（旧 item 级聚合口径）。
 * passengers 缺省（老客户端不传）→ 全部回落旧口径，定价与扩展前完全一致。
 *
 * 导出供单测与 createOrder/quoteOrder 的 priceAndValidateItems BUNDLE 分支共用。
 */
export function derivePerPaxBundleOptions(
  item: { selfProvidedVisa?: boolean; singleCount?: number },
  passengers: ReadonlyArray<{ visaExempt?: boolean; singleRoom?: boolean }> | undefined,
): { selfProvidedVisaCount: number; singleCount: number | undefined } {
  const paxVisaProvided = passengers?.some((px) => px.visaExempt !== undefined) ?? false;
  const paxSingleProvided = passengers?.some((px) => px.singleRoom !== undefined) ?? false;
  const selfProvidedVisaCount = paxVisaProvided
    ? (passengers?.filter((px) => px.visaExempt === true).length ?? 0)
    : (item.selfProvidedVisa === true ? 1 : 0);
  const singleCount = paxSingleProvided
    ? (passengers?.filter((px) => px.singleRoom === true).length ?? 0)
    : item.singleCount;
  return { selfProvidedVisaCount, singleCount };
}

/**
 * 套餐升舱差价单一配置源解析（¥/程/座；纯函数，导出供单测与 createOrder/quoteOrder 共用）。
 *   · 套餐 businessUpgradeCnyPerLeg 非 null（含 0）→ 套餐自有覆盖，直接用。
 *   · null =「跟随航班」→ 取该套餐绑定航班的每程差价：去程优先、回程次之
 *     （往返同程对称，computeBundleAddOn 再 × legs 得总加价）。
 *   · 两趟都没绑到航班（或未 include）→ 兜底 DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG，绝不派生出 0/裸价。
 */
export function resolveBundleBusinessUpgradeRate(bundle: {
  businessUpgradeCnyPerLeg: number | null;
  outboundFlight?: { businessUpgradeCnyPerLeg: number } | null;
  returnFlight?: { businessUpgradeCnyPerLeg: number } | null;
}): number {
  return (
    bundle.businessUpgradeCnyPerLeg ??
    bundle.outboundFlight?.businessUpgradeCnyPerLeg ??
    bundle.returnFlight?.businessUpgradeCnyPerLeg ??
    DEFAULT_BUSINESS_UPGRADE_CNY_PER_LEG
  );
}

/** 升舱分程人数（去程 / 回程各自的升舱人数）。 */
export interface BundleBusinessUpgradeSplit {
  outbound?: number;
  return?: number;
}

/**
 * BUNDLE 行入参 → computeBundleAddOn 的升舱口径（纯函数，导出供单测与定价分支共用）。
 *   · 分程字段任一显式提供（含 0）→ 分程口径 `{ outbound, return }`；
 *   · 两者都省略 → 回落旧的整程 businessCount（数字/undefined），定价与扩展前完全一致。
 * 「显式 0」必须走分程分支：只升去程（回程 0）正是本次要支持的场景，落到旧口径会按两程都升收钱。
 */
export function resolveBundleBusinessUpgradeInput(item: {
  businessCount?: number;
  businessCountOutbound?: number;
  businessCountReturn?: number;
}): number | BundleBusinessUpgradeSplit | undefined {
  if (item.businessCountOutbound !== undefined || item.businessCountReturn !== undefined) {
    return { outbound: item.businessCountOutbound, return: item.businessCountReturn };
  }
  return item.businessCount;
}

export function computeBundleAddOn(
  bundle: {
    hotelNights: number | null;
    singleSupplementCnyPerNight: number;
    businessUpgradeCnyPerLeg: number;
    childSeatDiscountCnyPerPerson: number;
    infantPriceCny: number;
    selfVisaDeductCny: number;
    legs: number;
  },
  hotelStamp: { hotelCheckIn: Date; hotelCheckOut: Date } | null,
  singleCount: number | undefined,
  /**
   * 升舱人数。数字/缺省 = 旧整程口径（每程同人数，× legs 计价）；
   * 对象 = 分程口径（去程 / 回程各自的人数，合计 × 每程差价）。
   */
  businessCount: number | BundleBusinessUpgradeSplit | undefined,
  occupancy: BundleOccupancy,
  /** 调用方按 resolveBundleNights 解析的单一权威晚数（无盖章时的回退口径）。 */
  resolvedNights: number,
  /**
   * 自备签证（出行人自行办妥签证）人数 → 每人从套餐行扣减 selfVisaDeductCny。缺省 0。
   * 旧整单布尔口径由调用处归一化为 count（true → 1）；新乘客级口径为勾选人数。
   */
  selfProvidedVisaCount?: number,
): { total: number; hasAddOn: boolean; breakdown: BundleAddOnBreakdown } {
  const single = Math.max(0, Math.trunc(singleCount ?? 0));
  // 自备签人数：夹到 [0, headCount]（按人减免，最多全体出行人）。旧整单布尔已在调用处归一化为 0/1。
  const selfVisaCount = Math.min(
    Math.max(0, Math.trunc(selfProvidedVisaCount ?? 0)),
    occupancy.headCount,
  );
  // 计费晚数：优先用盖章推导的真实入住区间，否则回退套餐默认晚数（≥1）
  const nights = hotelStamp
    ? Math.max(
        1,
        Math.round((hotelStamp.hotelCheckOut.getTime() - hotelStamp.hotelCheckIn.getTime()) / DAY_MS),
      )
    : Math.max(1, resolvedNights);
  const legs = Math.max(1, bundle.legs);
  const singleRate = Math.max(0, bundle.singleSupplementCnyPerNight);
  const businessRate = Math.max(0, bundle.businessUpgradeCnyPerLeg);
  const childDiscountRate = Math.max(0, bundle.childSeatDiscountCnyPerPerson);
  const infantRate = Math.max(0, bundle.infantPriceCny);
  const selfVisaRate = Math.max(0, bundle.selfVisaDeductCny);

  // 升舱人数：两种口径共用同一个夹逼（≤ 占座人数；婴儿不占座、不能升舱）。
  //   · 分程口径（对象）：去/回程各自夹逼，总加价 = (去 + 回) × 每程差价；
  //     单程套餐 legs=1 → 回程恒 0（没有回程航段可占座，也不该收回程升舱费）。
  //   · 整程口径（数字/缺省）：**原公式一字不动**（人数 × 每程差价 × legs），历史入参重算结果一分不差；
  //     分程字段按「每程同人数」派生，供占座拆分与明细文案使用（legs=1 时回程仍为 0）。
  const clampSeat = (n: number | undefined): number =>
    Math.min(Math.max(0, Math.trunc(n ?? 0)), occupancy.seatPax);
  const isSplitInput = typeof businessCount === 'object' && businessCount !== null;
  const businessOutbound = clampSeat(isSplitInput ? businessCount.outbound : businessCount);
  const businessReturn =
    legs >= 2 ? clampSeat(isSplitInput ? businessCount.return : businessCount) : 0;
  // 旧展示字段（整程口径的「升舱人数」）：取两程较大值 —— 旧入参两程同值时与旧版完全一致。
  const business = Math.max(businessOutbound, businessReturn);

  const singleSupplementTotal = single * singleRate * nights;
  const businessUpgradeTotal = isSplitInput
    ? (businessOutbound + businessReturn) * businessRate
    : business * businessRate * legs;
  // 占座儿童机票按成人价减折扣 → 套餐行净减 childCount × 折扣
  const childSeatDiscountTotal = occupancy.childCount * childDiscountRate;
  // 不占座婴儿机票收婴儿价（不走经济舱全价）→ 套餐行净加 infantCount × 婴儿价
  const infantPriceTotal = occupancy.infantCount * infantRate;
  // 自备签证：自行办妥签证的人数 × 每人减免（乘客级各减一次；旧整单口径 count=1 即整单减一次）
  const selfVisaDeductTotal = selfVisaCount * selfVisaRate;
  // 升级加价 + 婴儿价 − 儿童折扣 − 自备签证减免。
  // 加项净额**允许为负**：自备签/儿童折扣可以大于其它加价，甚至在无任何其它加价时单独存在。
  // 绝不在此「加项净额」层夹到 0——否则减免只能抵扣其它加价、无加价时一分不减（把套餐行整体价算高）。
  // 非负保护下沉到 BUNDLE 行金额层（unitPrice×qty + total + 操作费）再统一夹到 0，减免可正常抵扣套餐地面价。
  const total =
    singleSupplementTotal +
    businessUpgradeTotal +
    infantPriceTotal -
    childSeatDiscountTotal -
    selfVisaDeductTotal;

  return {
    total,
    // 任一占座升级或儿童/婴儿差价 / 自备签证减免存在 → 视为有 add-on（落 metadata 供运营/财务查看）
    hasAddOn:
      single > 0 ||
      business > 0 ||
      childSeatDiscountTotal > 0 ||
      infantPriceTotal > 0 ||
      selfVisaDeductTotal > 0,
    breakdown: {
      singleCount: single,
      businessCount: business,
      businessCountOutbound: businessOutbound,
      businessCountReturn: businessReturn,
      adultCount: occupancy.adultCount,
      childCount: occupancy.childCount,
      infantCount: occupancy.infantCount,
      seatPax: occupancy.seatPax,
      headCount: occupancy.headCount,
      rooms: occupancy.rooms,
      nights,
      legs,
      singleSupplementCnyPerNight: singleRate,
      businessUpgradeCnyPerLeg: businessRate,
      childSeatDiscountCnyPerPerson: childDiscountRate,
      infantPriceCny: infantRate,
      selfProvidedVisaCount: selfVisaCount,
      selfProvidedVisa: selfVisaCount > 0,
      selfVisaDeductCny: selfVisaRate,
      singleSupplementTotal,
      businessUpgradeTotal,
      childSeatDiscountTotal,
      infantPriceTotal,
      selfVisaDeductTotal,
      total,
    },
  };
}

/**
 * 出行人数校验口径（纯函数，与前台 CheckoutPage 的 effectivePax 同源）。
 *
 * 同一批出行人会出现在多条订单行里 —— 往返机票拆成去/回两条 FLIGHT 行（各 quantity=pax），
 * 套餐 / 签证 / 接送也都是「按人」的产品。所需出行人数应是「单程最大人数」，不是各行相加：
 *   - FLIGHT：取各行 quantity 的 MAX（往返同一批人，绝不两段相加）
 *   - BUNDLE：每行 pax 取自 metadata.pax（缺失回退 quantity），多份套餐相加
 *   - VISA / TRANSFER：每行 quantity 相加
 *   - required = max(maxFlightLegQty, bundlePax, visaQty, transferPax)
 * 任一维度为 0 时不约束（required 仍由其余维度决定）；全为 0（无按人产品）→ 返回 0，不校验。
 *
 * 导出供单测与 createOrder 共用。
 */
export function computeRequiredPassengerCount(items: OrderItemInput[]): number {
  let maxFlightLegQty = 0;
  let bundlePax = 0;
  let visaQty = 0;
  let transferPax = 0;

  for (const item of items) {
    if (item.kind === 'FLIGHT') {
      // 往返两段共享乘客 → 取最大单段人数，不累加
      maxFlightLegQty = Math.max(maxFlightLegQty, item.quantity);
    } else if (item.kind === 'BUNDLE') {
      // 套餐出行人数 = 占座模型 headCount（成人 + 占座儿童 + 不占座婴儿，都需护照）。
      // 婴儿不占座但是出行人：FLIGHT 行 quantity = seatPax（占座），required 校验按 headCount。
      // 向后兼容：无三计数时把旧 pax / 行 quantity 当成全成人 → headCount = 旧 pax，结论与旧版一致。
      const occupancy = resolveBundleOccupancy({
        adultCount: item.adultCount,
        childCount: item.childCount,
        infantCount: item.infantCount,
        quantity: item.quantity,
        metadata: item.metadata,
      });
      bundlePax += occupancy.headCount;
    } else if (item.kind === 'VISA') {
      visaQty += item.quantity;
    } else if (item.kind === 'TRANSFER') {
      transferPax += item.quantity;
    }
  }

  return Math.max(maxFlightLegQty, bundlePax, visaQty, transferPax);
}
