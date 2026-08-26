/**
 * 房控 service — 酒店包房周期（HotelBlockPeriod）CRUD + 销控板 / 远期视图。
 *
 * 口径：
 *   block(d)     = SUM(该酒店所有周期 rooms，其中 dateFrom <= d <= dateTo，周期可叠加)
 *   used(d)      = 当晚占房订单行数 —— OrderItem 带 hotelRoomTypeId + 入住区间
 *                  [hotelCheckIn, hotelCheckOut)，即 checkIn <= d < checkOut，1 间/行；
 *                  只数与导出一致的有效状态订单（COUNTED_STATUSES）。
 *                  注：BUNDLE 行如带房型+入住日期同样计入；当前套餐下单不写这些字段，
 *                  纯 bundleId 的行（Bundle.items JSON 无房型/日期）无法归属酒店，跳过。
 *   remaining(d) = block(d) - used(d)
 *   physical(d)  = 物理房间口径：有权威分房表（Order.roomAssignment.roomGroups）的订单
 *                  按「有乘客的房间盒子数」直计（见 expandAssignedPhysicalByDate）；
 *                  其余订单按拼房性别推算（异性不能拼一间，见 computePhysicalUsed）。
 *
 * 写操作由 routes 层负责 ADMIN/STAFF 鉴权 + 审计日志（镜像 finances 成本周期风格）。
 */
import {
  AuditSeverity,
  AuditTargetType,
  OrderItemKind,
  OrderStatus,
  Prisma,
  type Gender,
  type PrismaClient,
} from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import type { AuditActor } from '../../lib/audit.js';
import { writeAudit } from '../../lib/audit.js';
import { businessDateISO, startOfBusinessDayUtc } from '../../lib/business-time.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { fmtDepartureLocalDate } from '../orders/passport-zip.js';
import type { CreateBlockPeriodBody, UpdateBlockPeriodBody } from './hotel-control.schemas.js';

// 读模型既可运行在默认 PrismaClient，也可运行在订单状态事务的 TransactionClient 内。
type HotelControlDbClient = PrismaClient | Prisma.TransactionClient;

/** 房控有效订单：退款申请中的订单已释放占房，不计入销控、分房与名单。*/
export const COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 销控板最长跨度（天）—— 超出按 from 起截断。*/
const MAX_BOARD_DAYS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── 星级随机档（三星随机 / 四星随机）──────────────────────────────────────
/**
 * 「N 星随机」**不是**单独切的独立库存池，而是同星级酒店库存的**派生聚合**：
 *
 *   随机N星余量(d) = Σ(starRating=N 且非国际五星的酒店当晚余量) − 当晚未落位随机单占用
 *
 * 三条对账恒等（这也是聚合口径相对「独立池」的全部意义）：
 *   卖具体酒店 → 该酒店余量少 → 随机 N 星合计随之少；
 *   卖随机     → 未落位随机单占用多 → 合计少；
 *   房控把随机单落位到某家酒店 → 该酒店用房 +1、未落位占用 −1 ⇒ **合计不变**。
 *
 * 写路径有两种「未落位」形态，读路径一视同仁：
 *   a) OrderItem.randomStarTier 非空、无房型 —— 正规的未落位随机单；
 *   b) 房型挂在**占位酒店**（Hotel.randomTierPlaceholder 非空）上的订单行 —— 早期用假酒店
 *      承载随机档时留下的形态，业务上同样还没落到任何一家真酒店。
 * 落位都走换酒店流程（把房型换到真酒店；(a) 同时清 randomStarTier）。
 *
 * 酒店的星级分类直接取 Hotel.starRating（不另建分类表）。两类酒店**一律排除**在
 * 「Σ真酒店余量」之外：
 *   · 国际五星（Hotel.intlFiveStar）—— 与 starRating=5 共用整数星级，另行报价；
 *   · 占位酒店（Hotel.randomTierPlaceholder 非空）—— 它不是真房源，把它当酒店合计
 *     就是把同一批房算两遍，销控板上还会既出现酒店组又出现同名聚合组。
 *
 * 历史：随机档曾是 HotelBlockPeriod.randomStarTier 的独立切房周期。该建池入口已废止
 * （createBlockPeriod 拒绝新建），存量周期数据保留供审计，但**所有读路径都不再计入**；
 * 占位酒店名下的切房周期同款处理（不计入、不许新建）。
 */
export const RANDOM_STAR_TIERS = [3, 4, 5] as const;
export type RandomStarTier = (typeof RANDOM_STAR_TIERS)[number];

const CN_NUMERALS = ['一', '二', '三', '四', '五'] as const;

/** 随机档的展示名：3 → 「三星随机」。超出 1..5 的异常值回落成数字，不抛错。*/
export function randomStarTierLabel(tier: number): string {
  return `${CN_NUMERALS[tier - 1] ?? String(tier)}星随机`;
}

/**
 * 销控板里随机档聚合组的分组键。**不是真实酒店 id** —— 前端据 `randomStarTier` 非空
 * 判定聚合组，这个键只用于 React key / 分组归并；把它当 hotelId 传给按酒店的接口不会命中。
 */
export function randomPoolGroupKey(tier: number): string {
  return `random-star-${tier}`;
}

/**
 * 该**真实酒店**归入哪个随机档；不属于任何随机档 → null。
 * 两类一律排除（判定看列，不看名字）：
 *   · 国际五星（intlFiveStar）—— 与 starRating=5 共用整数星级，五星随机档不含它，另行报价；
 *   · 占位酒店（randomTierPlaceholder 非空）—— 它不是房源，进合计就是同一批房算两遍。
 *     占位酒店该归哪个聚合组由 `randomTierPlaceholder` 自己说了算（见 placeholderTierOfHotel），
 *     且只进「用房（未落位）」那一行，绝不进「包房」。
 */
export function randomTierOfHotel(hotel: {
  starRating: number;
  intlFiveStar?: boolean | null;
  randomTierPlaceholder?: number | null;
}): number | null {
  if (hotel.intlFiveStar) return null;
  if (hotel.randomTierPlaceholder != null) return null;
  return (RANDOM_STAR_TIERS as readonly number[]).includes(hotel.starRating)
    ? hotel.starRating
    : null;
}

/**
 * 该酒店是不是随机档的**占位酒店**；是 → 它代表的档次（3/4/5），否 → null。
 * 落在占位酒店房型上的订单行在房控口径里等同「未落位随机单」，计入该档次聚合组的用房。
 */
export function placeholderTierOfHotel(hotel: {
  randomTierPlaceholder?: number | null;
}): number | null {
  return hotel.randomTierPlaceholder ?? null;
}

/**
 * 占房行口径的作用域：一家具体酒店，或某个随机档的**未落位随机单**。
 * 随机档作用域只描述占房行（销控板下钻用）—— 随机档自己没有包房周期了（见本节头部注释），
 * 它的房量一律由同星级酒店聚合而来。
 */
export type RoomScope = { hotelId: string } | { randomStarTier: number };

/**
 * 该作用域的占房行过滤条件。
 *
 * 随机档作用域 = 两类「未落位」占房行（与销控板聚合组的用房行同一口径）：
 *   a) 无房型 + randomStarTier 命中该档 —— 正规未落位随机单；
 *   b) 房型挂在该档的占位酒店上 —— 早期假酒店承载随机档留下的伪落位行。
 * (a) 显式要求 hotelRoomTypeId 为空 —— 与销控板分组「有房型就归该酒店」同优先级，
 * 万一出现两列都有值的异常行，两边都把它算成具体酒店的占房，不会被重复计两次。
 * 具体酒店作用域天然不会命中占位酒店 —— 占位酒店不作为酒店组出现在销控板上。
 */
function scopeItemWhere(scope: RoomScope): Prisma.OrderItemWhereInput {
  return 'hotelId' in scope
    ? { hotelRoomTypeId: { not: null }, hotelRoomType: { hotelId: scope.hotelId } }
    : {
        OR: [
          { hotelRoomTypeId: null, randomStarTier: scope.randomStarTier },
          { hotelRoomType: { hotel: { randomTierPlaceholder: scope.randomStarTier } } },
        ],
      };
}

// ── helpers ──────────────────────────────────────────────────────────────
function dec(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Prisma @db.Date 返回 UTC 0:00 的 Date；序列化为 'YYYY-MM-DD'。*/
function fmtDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toDateOnly(s: string): Date {
  // 'YYYY-MM-DD' → UTC midnight，与 Prisma @db.Date 的存取口径一致
  return new Date(`${s}T00:00:00.000Z`);
}

// ── 包房周期 CRUD ─────────────────────────────────────────────────────────
export interface HotelBlockPeriodDto {
  /** 池周期为 null（此时 randomStarTier 非空）。*/
  hotelId: string | null;
  id: string;
  /** 具体酒店周期 = 酒店名；池周期 = 「三星随机」/「四星随机」。恒非空，前端直接展示。*/
  hotelName: string;
  /** 非空 = 星级随机池周期（3=三星随机、4=四星随机）。*/
  randomStarTier: number | null;
  /**
   * 已停用：本周期不计入任何余量，仅保留供查账（前端打灰标，可直接删）。
   * 两种来源同款处理 —— 存量的随机档池周期（randomStarTier 非空），以及挂在**占位酒店**
   * 名下的周期（占位酒店不是真房源，它的切房进合计就是同一批房算两遍）。
   */
  disabled: boolean;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD（闭区间）
  rooms: number;
  unitPrice: number | null;
  note: string | null;
  updatedAt: string;
}

type BlockPeriodRow = Prisma.HotelBlockPeriodGetPayload<{
  include: { hotel: { select: { name: true; randomTierPlaceholder: true } } };
}>;

function toDto(row: BlockPeriodRow): HotelBlockPeriodDto {
  const price = dec(row.unitPrice);
  return {
    id: row.id,
    hotelId: row.hotelId,
    // hotel 关联随 hotelId 一起为空（池周期）→ 用池档次名占位，前端无需分支即可展示
    hotelName: row.hotel?.name ?? randomStarTierLabel(row.randomStarTier ?? 0),
    randomStarTier: row.randomStarTier,
    disabled: row.randomStarTier != null || row.hotel?.randomTierPlaceholder != null,
    dateFrom: fmtDateOnly(row.dateFrom),
    dateTo: fmtDateOnly(row.dateTo),
    rooms: row.rooms,
    unitPrice: price == null ? null : round2(price),
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 周期归属校验：包房周期必须挂在一家具体酒店上。
 *
 * 随机档周期（randomStarTier 非空）已废止 —— 随机档改为同星级酒店的派生聚合（见本文件
 * 「星级随机档」小节），再单独切一份总量就会与酒店库存双记一笔账。存量周期数据保留供审计，
 * 但既不允许新建、读路径也不再计入。占位酒店名下的周期同理（在 createBlockPeriod 里查库判定）。
 */
function assertBlockPeriodScope(input: {
  hotelId?: string | null;
  randomStarTier?: number | null;
}): void {
  if (input.randomStarTier != null) {
    throw new BadRequestError('随机档已改为同星级酒店合计，无需单独切池');
  }
  if (!input.hotelId) {
    throw new BadRequestError('包房周期必须指定一家酒店');
  }
}

export async function listBlockPeriods(
  filter: { hotelId?: string; randomStarTier?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<HotelBlockPeriodDto[]> {
  const rows = await client.hotelBlockPeriod.findMany({
    where: filter.hotelId
      ? { hotelId: filter.hotelId }
      : filter.randomStarTier != null
        ? { randomStarTier: filter.randomStarTier }
        : undefined,
    orderBy: [{ hotelId: 'asc' }, { dateFrom: 'desc' }],
    include: { hotel: { select: { name: true, randomTierPlaceholder: true } } },
  });
  return rows.map(toDto);
}

export async function createBlockPeriod(
  input: CreateBlockPeriodBody,
  client: PrismaClient = defaultPrisma,
): Promise<HotelBlockPeriodDto> {
  if (input.dateFrom > input.dateTo) {
    throw new BadRequestError('起始日不能晚于结束日');
  }
  assertBlockPeriodScope(input);
  if (input.hotelId) {
    const hotel = await client.hotel.findUnique({
      where: { id: input.hotelId },
      select: { id: true, randomTierPlaceholder: true },
    });
    if (!hotel) throw new NotFoundError('酒店不存在');
    // 占位酒店不是真房源，给它切房 = 与同星级真酒店的库存双记一笔账（同存量池周期同款拒绝）
    if (hotel.randomTierPlaceholder != null) {
      throw new BadRequestError('该酒店是星级随机档占位项，不能切房；请为真实酒店设置包房周期');
    }
  }

  const row = await client.hotelBlockPeriod.create({
    data: {
      hotelId: input.hotelId ?? null,
      // 随机档周期已废止（assertBlockPeriodScope 上面已拒），新周期恒为具体酒店周期
      randomStarTier: null,
      dateFrom: toDateOnly(input.dateFrom),
      dateTo: toDateOnly(input.dateTo),
      rooms: input.rooms,
      unitPrice: input.unitPrice ?? null,
      note: input.note ?? null,
    },
    include: { hotel: { select: { name: true, randomTierPlaceholder: true } } },
  });
  return toDto(row);
}

/** [fromD, toD] 逐日展开为 YYYY-MM-DD 数组（闭区间，含两端）；不做跨度上限截断—— 调用方
 *  （占用守卫）传入的都是具体包房周期的日期区间，不是用户可任意拉长的查询窗口。*/
function enumerateDates(fromD: Date, toD: Date): string[] {
  const days = Math.floor((toD.getTime() - fromD.getTime()) / DAY_MS) + 1;
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(fromD.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

/** 缩减/删除包房周期的占用守卫判定结果：逐晚「已占用（物理间数）> 新包房」的缺口列表。*/
interface HotelOversellCheck {
  violations: Array<{ date: string; occupied: number; block: number; shortfall: number }>;
  maxShortfall: number;
}

/**
 * 计算「某酒店的一条包房周期被改动/删除后」逐晚是否形成超占（照抄机票侧
 * FLIGHT_MAX_OVERSELL_SEATS 的哲学，见 flights.service.updateSchedule）。
 *
 * override：
 *   - 非 null → 该周期改为 override 的 dateFrom/dateTo/rooms（改小/收窄日期场景）；
 *   - null    → 该周期整段移除（删除场景）。
 * 占用数复用房控既有的「物理房间口径」（computePhysicalUsedForItems）—— 与销控板
 * physicalUsed / 前瞻闸 checkHotelPhysicalFit 同一把尺子，不另发明一套计数方式。
 *
 * [fromD, toD] 由调用方给：改动场景传「旧区间 ∪ 新区间」的并集（收窄日期腾出来的那几晚
 * 同样要查，否则日期一改小就绕开了守卫）；删除场景直接传该周期自己的整段区间。
 */
async function computeHotelOversellAfterPeriodChange(
  hotelId: string,
  excludePeriodId: string,
  override: { dateFrom: Date; dateTo: Date; rooms: number } | null,
  fromD: Date,
  toD: Date,
  client: PrismaClient,
): Promise<HotelOversellCheck> {
  const others = await client.hotelBlockPeriod.findMany({
    where: { hotelId, id: { not: excludePeriodId }, dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    select: { dateFrom: true, dateTo: true, rooms: true },
  });
  const periods = override ? [...others, override] : others;
  const dates = enumerateDates(fromD, toD);
  const newBlock = expandBlockByDate(periods, dates);

  // 占用查询口径与 getHotelNightlyRemaining / checkHotelPhysicalFit 完全一致
  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelRoomType: { hotelId },
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });
  const occupied = computePhysicalUsedForItems(items, dates, null);

  const violations: HotelOversellCheck['violations'] = [];
  dates.forEach((date, i) => {
    const shortfall = round2(occupied[i] - newBlock[i]);
    if (shortfall > 0) violations.push({ date, occupied: occupied[i], block: newBlock[i], shortfall });
  });
  const maxShortfall = violations.reduce((m, v) => Math.max(m, v.shortfall), 0);
  return { violations, maxShortfall };
}

export async function updateBlockPeriod(
  id: string,
  input: UpdateBlockPeriodBody,
  client: PrismaClient = defaultPrisma,
  actor?: AuditActor,
): Promise<HotelBlockPeriodDto> {
  const existing = await client.hotelBlockPeriod.findUnique({
    where: { id },
    include: { hotel: { select: { name: true, randomTierPlaceholder: true } } },
  });
  if (!existing) throw new NotFoundError('包房周期不存在');

  const from = input.dateFrom ?? fmtDateOnly(existing.dateFrom);
  const to = input.dateTo ?? fmtDateOnly(existing.dateTo);
  if (from > to) {
    throw new BadRequestError('起始日不能晚于结束日');
  }

  const newFromD = toDateOnly(from);
  const newToD = toDateOnly(to);
  const newRooms = input.rooms ?? existing.rooms;
  // 只在「缩减」场景（房数变少，或日期区间收窄丢了原覆盖的日子）才需要查库做占用守卫——
  // 单纯改价/改备注/扩容/日期后移不会让任何一晚的容量变少，不必付这次查询代价。
  const shrinking =
    newRooms < existing.rooms ||
    newFromD.getTime() > existing.dateFrom.getTime() ||
    newToD.getTime() < existing.dateTo.getTime();
  // 随机档周期（hotelId 为 null）与占位酒店名下的周期已被读路径全体忽略（见文件头「星级
  // 随机档」小节）——它们本就不计入任何余量，缩放/占用守卫对它们没有意义，直接跳过。
  if (shrinking && existing.hotelId && existing.hotel?.randomTierPlaceholder == null) {
    const unionFromD = existing.dateFrom.getTime() < newFromD.getTime() ? existing.dateFrom : newFromD;
    const unionToD = existing.dateTo.getTime() > newToD.getTime() ? existing.dateTo : newToD;
    const { violations, maxShortfall } = await computeHotelOversellAfterPeriodChange(
      existing.hotelId,
      id,
      { dateFrom: newFromD, dateTo: newToD, rooms: newRooms },
      unionFromD,
      unionToD,
      client,
    );
    if (violations.length > 0) {
      if (maxShortfall > env.HOTEL_MAX_OVERSELL_ROOMS) {
        const v = violations[0];
        throw new BadRequestError(
          `该酒店房量下调后 ${v.date} 起将短缺 ${v.shortfall} 间（已占用 ${v.occupied} 间 > 新包房 ${v.block} 间），超过超卖上限 ${env.HOTEL_MAX_OVERSELL_ROOMS} 间，请先处理相关订单再调整`,
        );
      }
      // 未超阈值但确实形成超占（航司/酒店减配的真实场景同款处理）—— 放行但留痕，
      // 供财务/房控事后追溯是谁在什么时候把哪家酒店的房量调到了占用之下。
      void writeAudit({
        actor: actor ?? {},
        action: 'UPDATE_HOTEL_BLOCK_PERIOD_OVERSOLD',
        targetType: AuditTargetType.PRODUCT,
        targetId: existing.hotelId,
        targetLabel: `${existing.hotel?.name ?? existing.hotelId} 包房下调后短期超占`,
        before: {
          rooms: existing.rooms,
          dateFrom: fmtDateOnly(existing.dateFrom),
          dateTo: fmtDateOnly(existing.dateTo),
        },
        after: { rooms: newRooms, dateFrom: from, dateTo: to, violations },
        severity: AuditSeverity.WARNING,
      });
    }
  }

  const data: Prisma.HotelBlockPeriodUpdateInput = {};
  if (input.dateFrom) data.dateFrom = newFromD;
  if (input.dateTo) data.dateTo = newToD;
  if (input.rooms !== undefined) data.rooms = input.rooms;
  if (input.unitPrice !== undefined) data.unitPrice = input.unitPrice ?? null;
  if (input.note !== undefined) data.note = input.note ?? null;

  const row = await client.hotelBlockPeriod.update({
    where: { id },
    data,
    include: { hotel: { select: { name: true, randomTierPlaceholder: true } } },
  });
  return toDto(row);
}

export async function deleteBlockPeriod(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  const existing = await client.hotelBlockPeriod.findUnique({
    where: { id },
    include: { hotel: { select: { name: true, randomTierPlaceholder: true } } },
  });
  if (!existing) throw new NotFoundError('包房周期不存在');

  // 随机档周期 / 占位酒店周期本就不计入任何余量（见文件头「星级随机档」小节），删除
  // 它们不影响任何真实库存，跳过占用守卫。
  if (existing.hotelId && existing.hotel?.randomTierPlaceholder == null) {
    const { violations } = await computeHotelOversellAfterPeriodChange(
      existing.hotelId,
      id,
      null,
      existing.dateFrom,
      existing.dateTo,
      client,
    );
    // 删除不给「改小」那样的超卖阈值豁免——整段周期直接消失比缩容更激进，只要会让
    // 任何一晚变成「已占用 > 删除后剩余包房」就先拒绝，请运营先处理订单再删。
    if (violations.length > 0) {
      const v = violations[0];
      throw new BadRequestError(
        `该周期覆盖的日期仍有占用（如 ${v.date} 已占用 ${v.occupied} 间 > 删除后包房 ${v.block} 间），请先处理相关订单再删除`,
      );
    }
  }

  await client.hotelBlockPeriod.delete({ where: { id } });
  return { id };
}

// ── 逐日展开（销控板 / 前台余量共用）─────────────────────────────────────
/** dates 上逐日累加包房数：dateFrom <= d <= dateTo（闭区间，周期可叠加）。*/
export function expandBlockByDate(
  periods: ReadonlyArray<{ dateFrom: Date; dateTo: Date; rooms: number }>,
  dates: readonly string[],
): number[] {
  const block = new Array<number>(dates.length).fill(0);
  for (const p of periods) {
    const fromStr = fmtDateOnly(p.dateFrom);
    const toStr = fmtDateOnly(p.dateTo);
    for (let i = 0; i < dates.length; i++) {
      if (fromStr <= dates[i] && dates[i] <= toStr) block[i] += p.rooms;
    }
  }
  return block;
}

/**
 * 单行真实占房间数：roomsBilled（新列，支持 0.5 半间）→ metadata.roomsNeeded（套餐已写）
 * → metadata.rooms（酒店行写）→ 1（兜底）。任意值非有限正数都回落到下一优先级。
 * export：占房下钻（getOccupyingOrders）复用同一口径，避免与销控板 used 计算漂移。
 */
export function itemRoomCount(it: {
  roomsBilled?: Prisma.Decimal | number | null;
  metadata?: unknown;
}): number {
  const billed = dec(it.roomsBilled ?? null);
  if (billed != null && Number.isFinite(billed) && billed > 0) return billed;
  if (it.metadata != null && typeof it.metadata === 'object') {
    const meta = it.metadata as { roomsNeeded?: unknown; rooms?: unknown };
    const needed = Number(meta.roomsNeeded);
    if (Number.isFinite(needed) && needed > 0) return needed;
    const rooms = Number(meta.rooms);
    if (Number.isFinite(rooms) && rooms > 0) return rooms;
  }
  return 1;
}

/**
 * dates 上逐日累计占房间数：checkIn <= d < checkOut（半开区间）。
 * 每行按真实房间数计（见 itemRoomCount），支持 0.5 半间 — 用浮点累加后 round2。
 */
export function expandUsedByDate(
  items: ReadonlyArray<{
    hotelCheckIn: Date | null;
    hotelCheckOut: Date | null;
    roomsBilled?: Prisma.Decimal | number | null;
    metadata?: unknown;
  }>,
  dates: readonly string[],
): number[] {
  const used = new Array<number>(dates.length).fill(0);
  for (const it of items) {
    if (!it.hotelCheckIn || !it.hotelCheckOut) continue;
    const checkIn = fmtDateOnly(it.hotelCheckIn);
    const checkOut = fmtDateOnly(it.hotelCheckOut);
    const rooms = itemRoomCount(it);
    for (let i = 0; i < dates.length; i++) {
      if (checkIn <= dates[i] && dates[i] < checkOut) used[i] += rooms;
    }
  }
  // 浮点累加可能引入 0.999… 误差 — 统一 round2，半间(0.5)精度足够
  return used.map(round2);
}

/** roomsBilled 判为半间（拼房 0.5）：恰为 0.5 的分数占房行。*/
function isHalfRoom(it: { roomsBilled?: Prisma.Decimal | number | null }): boolean {
  const billed = dec(it.roomsBilled ?? null);
  return billed != null && billed === 0.5;
}

/**
 * 拼房客逐日按性别分桶计数（异性不能拼一间）。每桶数组与 dates 等长。
 *   m/f = 明确性别为 男/女 的拼房客数；
 *   u   = 性别未知（Passenger.gender 为 null 或 X）的拼房客数——保守口径每人独占 1 间。
 */
export interface SharedGenderBuckets {
  m: number[];
  f: number[];
  u: number[];
}

/**
 * 取拼房单出行人的性别：拼房单（roomsBilled==0.5）恒为 adultCount===1 的套餐单，
 * 正常只 1 位真实出行人。取第一位性别为 M/F 的出行人；X / null / 无出行人一律视为「未知」。
 * 订单若含多位出行人（异常兜底），取第一位有明确性别（M/F）者，其余忽略。
 */
function pickSoloGender(
  passengers: ReadonlyArray<{ gender: Gender | null }> | null | undefined,
): 'M' | 'F' | 'U' {
  if (!passengers) return 'U';
  for (const p of passengers) {
    if (p.gender === 'M' || p.gender === 'F') return p.gender;
  }
  return 'U';
}

/**
 * dates 上逐日按性别累计「拼房客」人数：roomsBilled == 0.5 的占房行，
 * 入住区间 [checkIn, checkOut) 覆盖该晚即按其出行人性别 +1（每行 = 1 位拼房客）。
 * 异性不能拼一间 → 男/女各自两两配对、未知每人独占，用于物理房间与落单口径。
 *
 * 注：有权威分房表的订单（含运营故意混拼）已由 expandAssignedPhysicalByDate 在上游拆分
 * 排除——物理口径调用方应只传拆分后的 fallback 行，分房表订单不进此保守推算。
 */
export function expandSharedHalfByDate(
  items: ReadonlyArray<{
    hotelCheckIn: Date | null;
    hotelCheckOut: Date | null;
    roomsBilled?: Prisma.Decimal | number | null;
    order?: { passengers: Array<{ gender: Gender | null }> } | null;
  }>,
  dates: readonly string[],
): SharedGenderBuckets {
  const m = new Array<number>(dates.length).fill(0);
  const f = new Array<number>(dates.length).fill(0);
  const u = new Array<number>(dates.length).fill(0);
  for (const it of items) {
    if (!it.hotelCheckIn || !it.hotelCheckOut) continue;
    if (!isHalfRoom(it)) continue;
    const g = pickSoloGender(it.order?.passengers);
    const bucket = g === 'M' ? m : g === 'F' ? f : u;
    const checkIn = fmtDateOnly(it.hotelCheckIn);
    const checkOut = fmtDateOnly(it.hotelCheckOut);
    for (let i = 0; i < dates.length; i++) {
      if (checkIn <= dates[i] && dates[i] < checkOut) bucket[i] += 1;
    }
  }
  return { m, f, u };
}

/**
 * 物理房间口径占房：逐日真实占用的整间数（可由销控板既有数组在内存推导，无需查库）。
 *   physicalUsed[i] = ceil(m/2) + ceil(f/2) + u + 整间预订数
 * 其中（按性别分组，异性不能拼一间）：
 *   m/f = 当晚男/女拼房客数 → 同性两两配对、落单向上取整独占 ⇒ ceil(m/2)+ceil(f/2)；
 *   u   = 性别未知拼房客数 → 保守口径每人独占 1 间；
 *   整间预订数 = (used*2 的 half-unit 总量 − 拼房客 half-unit) / 2（应为整数）。
 * 防浮点误差：used 由 Decimal 0.5 累加而来，先按 0.5 网格对齐消除 0.999… 类误差，最后 round2 输出。
 */
export function computePhysicalUsed(
  used: readonly number[],
  buckets: SharedGenderBuckets,
): number[] {
  return used.map((bedUsed, i) => {
    const m = buckets.m[i] ?? 0;
    const f = buckets.f[i] ?? 0;
    const u = buckets.u[i] ?? 0;
    const solos = m + f + u; // 拼房客总数（各 = 0.5 = 1 个 half-unit）
    // used 由 Decimal 0.5 累加而来，先按 0.5 网格对齐消除 0.999… 类误差
    const usedHalfUnits = Math.round(bedUsed * 2);
    const wholeRooms = (usedHalfUnits - solos) / 2; // 整间预订数（应为整数）
    return round2(Math.ceil(m / 2) + Math.ceil(f / 2) + u + wholeRooms);
  });
}

// ── 权威分房表（Order.roomAssignment）────────────────────────────────────
/**
 * 权威分房表的物理间数：Order.roomAssignment.roomGroups（orders 模块分房保存的 JSON）中
 * 「至少 1 名出行人」的房间盒子数量。返回 null = 无有效分房表（未分房 / 形状不符 /
 * 全部盒子无人）→ 调用方走拼房性别推算 fallback。防御式解析，形状不符不抛错。
 *
 * 背景：分房保存把 Σ roomFraction 塌缩写进首个酒店行的 roomsBilled（床位/计费口径），
 * "男+女各半间分 2 房"会塌缩成 1.0——物理间数必须回读分房表，不能只看 roomsBilled。
 */
export function assignedPhysicalRooms(roomAssignment: unknown): number | null {
  if (roomAssignment == null || typeof roomAssignment !== 'object') return null;
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const withPassengers = groups.filter((g) => {
    if (g == null || typeof g !== 'object') return false;
    const ids = (g as { passengerIds?: unknown }).passengerIds;
    return Array.isArray(ids) && ids.length > 0;
  }).length;
  return withPassengers > 0 ? withPassengers : null;
}

/** 占房行（物理口径拆分用）：订单级分房表 + 拼房性别 fallback 所需字段。*/
export interface PhysicalOccupancyItem {
  hotelCheckIn: Date | null;
  hotelCheckOut: Date | null;
  roomsBilled?: Prisma.Decimal | number | null;
  metadata?: unknown;
  order?: {
    id?: string;
    roomAssignment?: unknown;
    passengers: Array<{ gender: Gender | null }>;
  } | null;
}

/**
 * 物理房间口径拆分：有权威分房表的订单逐日按「有乘客的 roomGroup 数」直计物理间数
 * （assignedPhysical），其余行原样返回（fallbackItems）走性别推算（expandSharedHalfByDate
 * + computePhysicalUsed）。分房表订单不再参与 isHalfRoom / 性别配对 / 整间推算，
 * 也不进「拼」落单口径（sharedUnpaired）。
 *
 * 订单级去重：分房是订单级、占房行是行级——同一订单在同酒店的多行（两种房型 / 分段住）
 * 只按分房表间数计一次/晚：对该单所有行的 [checkIn, checkOut) 取并集覆盖，
 * 覆盖到的每晚 += 分房表间数（日期展开方式对齐 expandUsedByDate 的半开区间）。
 */
export function expandAssignedPhysicalByDate<T extends PhysicalOccupancyItem>(
  items: ReadonlyArray<T>,
  dates: readonly string[],
): { assignedPhysical: number[]; fallbackItems: T[] } {
  const assignedPhysical = new Array<number>(dates.length).fill(0);
  const fallbackItems: T[] = [];
  const byOrder = new Map<string, { rooms: number; covered: boolean[] }>();
  items.forEach((it, idx) => {
    const rooms = assignedPhysicalRooms(it.order?.roomAssignment);
    if (rooms == null || !it.hotelCheckIn || !it.hotelCheckOut) {
      fallbackItems.push(it);
      return;
    }
    // 订单 id 缺失（异常兜底）按行独立计，避免静默丢占房
    const key = it.order?.id ?? `__row_${idx}`;
    const entry = byOrder.get(key) ?? {
      rooms,
      covered: new Array<boolean>(dates.length).fill(false),
    };
    if (!byOrder.has(key)) byOrder.set(key, entry);
    const checkIn = fmtDateOnly(it.hotelCheckIn);
    const checkOut = fmtDateOnly(it.hotelCheckOut);
    for (let i = 0; i < dates.length; i++) {
      if (checkIn <= dates[i] && dates[i] < checkOut) entry.covered[i] = true;
    }
  });
  for (const { rooms, covered } of byOrder.values()) {
    for (let i = 0; i < dates.length; i++) {
      if (covered[i]) assignedPhysical[i] += rooms;
    }
  }
  return { assignedPhysical, fallbackItems };
}

/**
 * 单酒店逐晚余量（remaining = block - used），口径与销控板 getBoard 完全一致。
 * 一次 findMany 拉周期 + 一次 findMany 拉占房行，JS 内展开（无逐日查询）。
 * hasBlock=false 表示整段没有任何包房周期（未配置房控）—— 调用方自行决定降级行为。
 *
 * 返回逐晚 `block`（该晚被包房周期管控的房量）供调用方区分「被管控但售罄」与「未被管控」：
 *   block[i] > 0 ⇒ 该晚由房控管控，remaining[i] 可信；
 *   block[i] === 0 ⇒ 该晚无任何周期覆盖（未管控），不应据 remaining 判为售罄。
 */
export async function getHotelNightlyRemaining(
  hotelId: string,
  nightDates: readonly string[],
  client: HotelControlDbClient = defaultPrisma,
): Promise<{ remaining: number[]; hasBlock: boolean; block: number[]; physicalRemaining: number[] }> {
  if (nightDates.length === 0) {
    return { remaining: [], hasBlock: false, block: [], physicalRemaining: [] };
  }
  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);

  const periods = await client.hotelBlockPeriod.findMany({
    where: { hotelId, dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    select: { dateFrom: true, dateTo: true, rooms: true },
  });
  if (periods.length === 0) {
    return { remaining: [], hasBlock: false, block: [], physicalRemaining: [] };
  }

  // 占晚区间 [checkIn, checkOut) 与夜晚集合有交集 ⇔ checkIn <= 最后一晚 && checkOut > 第一晚
  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelRoomType: { hotelId },
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      // 物理房间口径 physicalRemaining 需要（口径同 getBoard）：
      //   roomAssignment = 权威分房表（优先直计物理间数）；passengers.gender = fallback 性别推算
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });

  const block = expandBlockByDate(periods, nightDates);
  const used = expandUsedByDate(items, nightDates);
  // 物理房间口径（与销控板 getBoard / 房态导出同口径）：权威分房表订单按「有乘客的
  // roomGroup 数」直计整间；无分房表订单按性别分桶推算真实占用整间数（异性不能拼）——
  // 避免"男+女各半间已分 2 房"被塌缩的 roomsBilled=1.0 误算成 1 间。
  const physicalUsed = computePhysicalUsedForItems(items, nightDates, null);
  const physicalRemaining = block.map((b, i) => round2(b - physicalUsed[i]));

  return {
    remaining: block.map((b, i) => b - used[i]),
    hasBlock: true,
    block,
    physicalRemaining,
  };
}

// ── 物理房间口径前瞻闸（下单 / 换酒店 / 分房写入共用）──────────────────────
/**
 * 本次操作**打算新增**的占房——前瞻闸的输入。
 *   wholeRooms = 新增整间数（非负整数）；
 *   solos      = 新增拼房客逐人性别（'M'/'F'/'U'；未知按保守口径每人独占 1 间）。
 *
 * 为什么必须拆这两维、而不是拿 `physicalRemaining >= rooms` 直接比：
 *   1) 量纲不同 —— rooms 可能是 0.5（单人拼房的床位/计费口径），物理余量是整间；
 *   2) **一个新拼房客的物理增量是 0 还是 1，取决于当晚有没有可配对的同性落单** ——
 *      这在「余量」这个存量数字里根本看不出来。往「已有 1 位男拼房客」里再加 1 位男
 *      → ceil(2/2)=1 → 增量 0（放行）；往「0 位男」里加 → 增量 1。
 *   所以只能把人真的塞进性别桶里、按 computePhysicalUsed 重算一遍，才是权威判定。
 */
export interface ProspectiveOccupancy {
  wholeRooms: number;
  solos: ReadonlyArray<'M' | 'F' | 'U'>;
}

/** 前瞻闸判定为「装不下」的某一晚。*/
export interface PhysicalFitViolation {
  index: number; // 在 nightDates 中的下标
  date: string; // YYYY-MM-DD
  block: number; // 该晚包房间数
  physicalUsed: number; // 本次操作后该晚需要的物理间数
  shortfall: number; // = physicalUsed − block（超出的物理间数）
}

export interface PhysicalFitResult {
  /** false = 整段没有任何包房周期（未配房控）→ 调用方不应据此拦截。*/
  hasBlock: boolean;
  block: number[];
  physicalUsedBefore: number[];
  physicalUsedAfter: number[];
  violations: PhysicalFitViolation[];
}

/**
 * 物理房间口径占房（逐晚），可选叠加一笔「打算新增的占房」。
 * 口径与销控板 getBoard / physicalRemaining 完全一致，纯内存推算，不额外查库。
 */
function computePhysicalUsedForItems<T extends PhysicalOccupancyItem>(
  items: ReadonlyArray<T>,
  dates: readonly string[],
  prospective: ProspectiveOccupancy | null,
): number[] {
  const { assignedPhysical, fallbackItems } = expandAssignedPhysicalByDate(items, dates);
  const baseBuckets = expandSharedHalfByDate(fallbackItems, dates);
  const baseUsed = expandUsedByDate(fallbackItems, dates);

  const solos = prospective?.solos ?? [];
  // 防御：整间数按非负整数取，避免调用方误传 0.5（0.5 间的语义是「拼房客」，应走 solos）。
  const extraWhole = prospective ? Math.max(0, Math.ceil(prospective.wholeRooms)) : 0;
  const soloCount = (g: 'M' | 'F' | 'U'): number => solos.filter((s) => s === g).length;
  const buckets: SharedGenderBuckets = {
    m: baseBuckets.m.map((v) => v + soloCount('M')),
    f: baseBuckets.f.map((v) => v + soloCount('F')),
    u: baseBuckets.u.map((v) => v + soloCount('U')),
  };
  // 拼房客各 0.5 间 + 新增整间，一并加进床位口径 used —— computePhysicalUsed 由
  // (usedHalfUnits − solos)/2 反推整间数，两边必须同步加，否则整间数会被算成负。
  const used = baseUsed.map((v) => round2(v + solos.length * 0.5 + extraWhole));

  const fallbackPhysical = computePhysicalUsed(used, buckets);
  return fallbackPhysical.map((v, i) => round2(v + assignedPhysical[i]));
}

/**
 * 前瞻闸：把 prospective 的新增占房塞进当晚的性别桶后重算物理间数，逐晚判定装不装得下。
 *   逐晚拒绝条件：block[i] > 0（该晚确被包房周期管控）且 block[i] − physicalUsedAfter[i] < 0。
 *   block[i] === 0（未被任何周期覆盖）→ 视为未管控，不据此拦截（房控哲学：未配包房 ≠ 售罄）。
 *
 * ⚠ 这是**只读快照判定**，本身不提供并发互斥：两个请求同时抢最后 1 间，会各自读到
 * 「还剩 1 间」的旧快照双双通过。要真正互斥，调用方必须在事务里改用
 * `assertHotelPhysicalFitWithinTx(tx, …)`（它会先对包房周期行加 FOR UPDATE 行锁）。
 *
 * @param excludeOrderId 改存量单（换酒店 / 重排分房）时排除该单自身的既有占房，避免把自己算两遍。
 */
export async function checkHotelPhysicalFit(
  hotelId: string,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: { excludeOrderId?: string } = {},
  client: HotelControlDbClient = defaultPrisma,
): Promise<PhysicalFitResult> {
  const empty: PhysicalFitResult = {
    hasBlock: false,
    block: [],
    physicalUsedBefore: [],
    physicalUsedAfter: [],
    violations: [],
  };
  if (nightDates.length === 0) return empty;

  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);
  const periods = await client.hotelBlockPeriod.findMany({
    where: { hotelId, dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    select: { dateFrom: true, dateTo: true, rooms: true },
  });
  if (periods.length === 0) return empty;

  // 过滤口径与 getHotelNightlyRemaining / getBoard 的 used 完全一致
  const items = await client.orderItem.findMany({
    where: {
      ...scopeItemWhere({ hotelId }),
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: {
        deletedAt: null,
        status: { in: COUNTED_STATUSES },
        ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
      },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });

  const block = expandBlockByDate(periods, nightDates);
  const physicalUsedBefore = computePhysicalUsedForItems(items, nightDates, null);
  const physicalUsedAfter = computePhysicalUsedForItems(items, nightDates, prospective);

  const violations: PhysicalFitViolation[] = [];
  nightDates.forEach((date, i) => {
    if (block[i] > 0 && block[i] - physicalUsedAfter[i] < 0) {
      violations.push({
        index: i,
        date,
        block: block[i],
        physicalUsed: physicalUsedAfter[i],
        shortfall: round2(physicalUsedAfter[i] - block[i]),
      });
    }
  });

  return { hasBlock: true, block, physicalUsedBefore, physicalUsedAfter, violations };
}

/**
 * checkHotelPhysicalFit 的抛错版：装不下就抛 BadRequestError。
 *
 * @param opts.allowNonWorsening 只拦「让某晚更差」的操作。存量单可能**已经**物理超卖
 *   （切闸前累积的），运营重排分房去补救时不该被自己造成的存量超卖挡在门外 —— 这类
 *   「改完不比改前差」的操作放行。新增占房（下单/换酒店）不应开这个豁免。
 * @param opts.buildMessage 定制错误文案（对外端点用中性话术，后台可回明细）。
 */
export async function assertHotelPhysicalFit(
  hotelId: string,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: {
    excludeOrderId?: string;
    allowNonWorsening?: boolean;
    buildMessage?: (violations: readonly PhysicalFitViolation[]) => string;
  } = {},
  client: HotelControlDbClient = defaultPrisma,
): Promise<void> {
  const fit = await checkHotelPhysicalFit(
    hotelId,
    nightDates,
    prospective,
    { excludeOrderId: opts.excludeOrderId },
    client,
  );
  if (!fit.hasBlock || fit.violations.length === 0) return;
  if (
    opts.allowNonWorsening &&
    fit.violations.every((v) => fit.physicalUsedAfter[v.index] <= fit.physicalUsedBefore[v.index])
  ) {
    return;
  }
  const message = opts.buildMessage
    ? opts.buildMessage(fit.violations)
    : `酒店实际房间不足（${fit.violations[0].date} 包房 ${fit.violations[0].block} 间，本次操作后需 ${fit.violations[0].physicalUsed} 间）`;
  throw new BadRequestError(message);
}

// ── 事务内互斥版前瞻闸（并发抢最后一间的唯一正解）────────────────────────────
/**
 * 把某酒店在 [nightDates 首, nightDates 尾] 区间内的包房周期行 `SELECT … FOR UPDATE`。
 *
 * 为什么必须锁：`checkHotelPhysicalFit` 是「两次 findMany + 纯内存推算」的**只读**判定。
 * 两个请求同时抢最后 1 间时，各自读到的都是「还剩 1 间」的旧快照，于是双双通过、双双落库
 * —— 闸再准也拦不住，因为它们从来没在同一条时间线上排过队。加了这把行锁，同一酒店同一段
 * 日期的并发下单会在这里串行：后到的那个要等前一个事务提交，然后**重新读到**它已落库的占房。
 *
 * 锁哪一行：包房周期（HotelBlockPeriod）—— 它是「这个酒店这几天有多少间」的权威载体，
 * 天然是这段库存的共享父记录；顺带也把「房控正在改包房间数」和下单串了起来。
 * 按 id 排序加锁，避免两个事务以不同顺序锁同一批行造成死锁。
 *
 * 该酒店该区间没有任何包房周期 → 无行可锁，直接返回：这种情况本就「未纳入管控」，
 * 前瞻闸也不会拦（房控哲学：未配包房 ≠ 售罄），没有需要互斥的库存。
 *
 * ⚠ 必须在**调用方的事务内**调用，且调用方要在同一事务里完成占房落库 —— 行锁随事务提交
 * 才释放；在事务外调用等于锁一秒就放，毫无意义。
 */
export async function lockHotelBlockPeriodsWithinTx(
  tx: Prisma.TransactionClient,
  hotelId: string,
  nightDates: readonly string[],
): Promise<void> {
  if (nightDates.length === 0) return;
  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);
  await tx.$queryRaw`
    SELECT id FROM "HotelBlockPeriod"
    WHERE "hotelId" = ${hotelId} AND "dateFrom" <= ${toD} AND "dateTo" >= ${fromD}
    ORDER BY id
    FOR UPDATE
  `;
}

/**
 * `assertHotelPhysicalFit` 的**事务内互斥**变体：先锁该酒店该区间的包房周期行，
 * 再在同一事务里跑一遍完全相同的前瞻闸判定。
 *
 * 用法（调用方必须满足，否则锁白加）：
 *   1. 在 `prisma.$transaction(async (tx) => { … })` 里调用，把 `tx` 传进来；
 *   2. 调用它之后、**同一个事务内**写入本次占房（OrderItem 的 hotelRoomTypeId +
 *      hotelCheckIn/hotelCheckOut/roomsBilled），事务提交前不得释放；
 *   3. 事务隔离级别用默认的 READ COMMITTED 即可 —— 后到的事务拿到锁时会重新取快照，
 *      看得见前一个事务刚提交的占房。
 *
 * 判定口径与非事务版一字不差（同一个 checkHotelPhysicalFit），只是多了一把锁：
 * 语义没变，变的是「两个人同时抢最后一间」时不再双双通过。
 */
export async function assertHotelPhysicalFitWithinTx(
  tx: Prisma.TransactionClient,
  hotelId: string,
  nightDates: readonly string[],
  prospective: ProspectiveOccupancy,
  opts: {
    excludeOrderId?: string;
    allowNonWorsening?: boolean;
    buildMessage?: (violations: readonly PhysicalFitViolation[]) => string;
  } = {},
): Promise<void> {
  await lockHotelBlockPeriodsWithinTx(tx, hotelId, nightDates);
  await assertHotelPhysicalFit(hotelId, nightDates, prospective, opts, tx);
}

// ── 随机档聚合余量（派生视图；下单闸 + 销控板共用同一公式）─────────────────
/**
 * 某个随机档在给定夜晚集合上的聚合余量（口径见本文件「星级随机档」小节）：
 *
 *   block(d)      = Σ 同星级**真**酒店当晚包房间数（排除国际五星与占位酒店）
 *   hotelUsed(d)  = Σ 同星级真酒店当晚床位口径用房（已落到具体酒店的占房，含随机单落位后的）
 *   pendingUsed(d)= 当晚**未落位**占用（床位口径）= randomStarTier 非空且无房型的行
 *                   ＋ 房型挂在该档占位酒店上的行（伪落位，业务上同样没落到真酒店）
 *   remaining(d)  = block(d) − hotelUsed(d) − pendingUsed(d)
 *
 * `hasBlock=false` 表示该档次整段没有任何同星级酒店的包房周期 —— 未纳入管控，调用方
 * 不应据此判为售罄（房控哲学：未配包房 ≠ 售罄，与 getHotelNightlyRemaining 一致）。
 */
export interface RandomTierAggregate {
  hasBlock: boolean;
  block: number[];
  hotelUsed: number[];
  pendingUsed: number[];
  remaining: number[];
}

export async function getRandomTierAggregate(
  tier: number,
  nightDates: readonly string[],
  opts: { excludeOrderId?: string } = {},
  client: HotelControlDbClient = defaultPrisma,
): Promise<RandomTierAggregate> {
  const empty: RandomTierAggregate = {
    hasBlock: false,
    block: [],
    hotelUsed: [],
    pendingUsed: [],
    remaining: [],
  };
  if (nightDates.length === 0) return empty;

  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);

  // 该档次的真酒店集合：starRating 命中、非国际五星、非占位酒店（randomTierOfHotel 的等价 where）
  const hotels = await client.hotel.findMany({
    where: { starRating: tier, intlFiveStar: false, randomTierPlaceholder: null },
    select: { id: true },
  });
  const hotelIds = hotels.map((h) => h.id);
  if (hotelIds.length === 0) return empty;

  const orderWhere = {
    deletedAt: null,
    status: { in: COUNTED_STATUSES },
    ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
  };
  const nightWhere = { hotelCheckIn: { lte: toD }, hotelCheckOut: { gt: fromD } };

  const [periods, hotelItems, pendingItems] = await Promise.all([
    client.hotelBlockPeriod.findMany({
      // hotelId in 列表已天然排除存量随机档周期（那些 hotelId 为 NULL）
      where: { hotelId: { in: hotelIds }, dateFrom: { lte: toD }, dateTo: { gte: fromD } },
      select: { dateFrom: true, dateTo: true, rooms: true },
    }),
    client.orderItem.findMany({
      where: {
        hotelRoomTypeId: { not: null },
        hotelRoomType: { hotelId: { in: hotelIds } },
        ...nightWhere,
        order: orderWhere,
      },
      select: { hotelCheckIn: true, hotelCheckOut: true, roomsBilled: true, metadata: true },
    }),
    client.orderItem.findMany({
      where: {
        // 两类未落位占用：正规随机单（无房型 + 档次命中）＋ 伪落位（房型挂在该档占位酒店上）
        OR: [
          { hotelRoomTypeId: null, randomStarTier: tier },
          { hotelRoomType: { hotel: { randomTierPlaceholder: tier } } },
        ],
        ...nightWhere,
        order: orderWhere,
      },
      select: { hotelCheckIn: true, hotelCheckOut: true, roomsBilled: true, metadata: true },
    }),
  ]);
  if (periods.length === 0) return empty;

  const block = expandBlockByDate(periods, nightDates);
  const hotelUsed = expandUsedByDate(hotelItems, nightDates);
  const pendingUsed = expandUsedByDate(pendingItems, nightDates);
  const remaining = block.map((b, i) => round2(b - hotelUsed[i] - pendingUsed[i]));
  return { hasBlock: true, block, hotelUsed, pendingUsed, remaining };
}

/**
 * 随机档下单闸：本次要新增 `rooms` 间（床位口径，可为 0.5 拼房）时，逐晚判定聚合余量够不够。
 * 装不下就抛 BadRequestError。
 *
 * 为什么这里用床位口径、不套具体酒店那套「物理房间前瞻闸」：随机单**还没落到任何一家酒店**，
 * 拼房能不能配对要等落位那一刻才由该酒店当晚的性别桶决定 —— 落位走的是换酒店流程，
 * 那里已有物理口径前瞻闸把关。下单这一刻只需保证「同星级还有房可落」。
 *
 * `buildMessage`：对外端点（前台下单）传中性话术，别把包房间数/合计余量这些内部库存数字
 * 回给客人；后台录单不传，用默认的带数字文案，方便运营直接判断差多少间。
 */
export async function assertRandomTierFit(
  tier: number,
  nightDates: readonly string[],
  rooms: number,
  opts: { excludeOrderId?: string; buildMessage?: () => string } = {},
  client: HotelControlDbClient = defaultPrisma,
): Promise<void> {
  const agg = await getRandomTierAggregate(tier, nightDates, opts, client);
  if (!agg.hasBlock) return;
  for (let i = 0; i < nightDates.length; i++) {
    // block[i] === 0 = 该晚同星级酒店都没切房 → 未管控，不拦截
    if (agg.block[i] <= 0) continue;
    const after = round2(agg.remaining[i] - rooms);
    if (after < 0) {
      throw new BadRequestError(
        opts.buildMessage?.() ??
          `${randomStarTierLabel(tier)}余量不足（${nightDates[i]} 同星级酒店合计余量 ${agg.remaining[i]} 间，本次需 ${rooms} 间）`,
      );
    }
  }
}

/**
 * 把「该随机档全部真酒店、覆盖 nightDates 区间」的包房周期行 `SELECT … FOR UPDATE`。
 * 是 `lockHotelBlockPeriodsWithinTx` 的聚合档版本 —— 随机档没有自己的周期表，它的库存
 * 由同星级真酒店（`randomTierOfHotel` 判定，排除国际五星与占位酒店）的周期聚合而来，
 * 所以要锁的是这批酒店各自名下的周期行，不是单一酒店。
 *
 * 该档次一家真酒店都没有 → 无行可锁，直接返回（未纳入管控，见 assertRandomTierFit 同款哲学）。
 * 按 id 排序加锁，避免两个事务以不同顺序锁同一批行造成死锁（同 lockHotelBlockPeriodsWithinTx）。
 */
export async function lockRandomTierBlockPeriodsWithinTx(
  tx: Prisma.TransactionClient,
  tier: number,
  nightDates: readonly string[],
): Promise<void> {
  if (nightDates.length === 0) return;
  const fromD = toDateOnly(nightDates[0]);
  const toD = toDateOnly(nightDates[nightDates.length - 1]);
  const hotels = await tx.hotel.findMany({
    where: { starRating: tier, intlFiveStar: false, randomTierPlaceholder: null },
    select: { id: true },
  });
  const hotelIds = hotels.map((h) => h.id);
  if (hotelIds.length === 0) return;
  await tx.$queryRaw`
    SELECT id FROM "HotelBlockPeriod"
    WHERE "hotelId" IN (${Prisma.join(hotelIds)})
      AND "dateFrom" <= ${toD} AND "dateTo" >= ${fromD}
    ORDER BY id
    FOR UPDATE
  `;
}

/**
 * `assertRandomTierFit` 的**事务内互斥**变体：先锁该档次全部真酒店在该区间的包房周期行，
 * 再在同一事务里跑一遍完全相同的聚合判定 —— 解决并发抢随机档最后一间双双通过的问题
 * （口径与 `assertHotelPhysicalFitWithinTx` 完全一致，只是锁的对象从「一家酒店」换成
 * 「一整个星级档次的全部酒店」）。
 *
 * 用法同 `assertHotelPhysicalFitWithinTx`：必须在 `prisma.$transaction(async (tx) => {…})`
 * 里调用，且同一事务内完成本次占房落库（写 OrderItem 的 randomStarTier 或占位酒店房型）。
 *
 * ⚠ 接线未完成：orders.service 的随机档下单路径目前仍调用只读版 `assertRandomTierFit`
 * （事务外或非互斥场景），需要下一波把并发下单的调用点切到这个事务内版本，见文件顶部
 * 任务交接说明。
 */
export async function assertRandomTierFitWithinTx(
  tx: Prisma.TransactionClient,
  tier: number,
  nightDates: readonly string[],
  rooms: number,
  opts: { excludeOrderId?: string; buildMessage?: () => string } = {},
): Promise<void> {
  await lockRandomTierBlockPeriodsWithinTx(tx, tier, nightDates);
  await assertRandomTierFit(tier, nightDates, rooms, opts, tx);
}

// ── 销控板（按酒店 × 日期）────────────────────────────────────────────────
export interface HotelControlBoard {
  dates: string[];
  hotels: Array<{
    /**
     * 分组键。具体酒店 = 真实 Hotel.id；随机档聚合组 = 合成键 `random-star-{tier}`
     * （见 randomPoolGroupKey）—— 聚合组不是酒店，别拿它去调按 hotelId 的接口，
     * 判定聚合组一律看 `randomStarTier` 是否非空。
     */
    hotelId: string;
    /** 具体酒店 = 酒店名；聚合组 = 「三星随机」/「四星随机」。*/
    hotelName: string;
    /** 非空 = 随机档聚合组（3=三星随机、4=四星随机）。*/
    randomStarTier: number | null;
    /** 最新周期（dateFrom 最晚且有价）的切房单价；聚合组无单一单价 → null */
    unitPrice: number | null;
    rows: {
      /** 具体酒店 = 该酒店包房间数；聚合组 = 同星级酒店包房合计，逐日 */
      block: number[];
      /**
       * 床位口径占房：Σ roomsBilled（拼房客各计 0.5，可为小数），逐日。
       * 聚合组这一行只统计**未落位随机单**（还没落到具体酒店的那些）——
       * 同星级各酒店已落位的占房在各自酒店行里，不在这里重复列。
       */
      used: number[];
      /**
       * 床位口径余量，逐日。
       *   具体酒店 = block − used；
       *   聚合组   = Σ(同星级酒店 block − 其床位用房) − 未落位随机单占用
       *   ⚠ 聚合组这一行**不等于**本组 block − used：同星级酒店已售出的房已经从余量里扣掉了。
       */
      remaining: number[];
      /** 当晚拼房客（roomsBilled==0.5，仅无分房表的 fallback 订单）总人数（含各性别），逐日 */
      sharedHalfCount: number[];
      /**
       * 当晚无法配对的拼房客数（落单数），逐日。仅统计无分房表的 fallback 订单——
       * 已有权威分房表的订单不再标为落单。
       * = m%2 + f%2 + u（同性两两配对后的余数 + 未知性别全算落单）。
       */
      sharedUnpaired: number[];
      /** 当晚有拼房客无法配对（sharedUnpaired > 0，需补单房差或另行配对），逐日 */
      sharedOdd: boolean[];
      /**
       * 物理房间口径占房：真实占用的整间数，逐日。
       * 有权威分房表（Order.roomAssignment.roomGroups）的订单 = 有乘客的房间盒子数（直计）；
       * 其余订单 = ceil(男/2) + ceil(女/2) + 未知 + 整间预订数
       *   异性不能拼一间：男/女各自两两共用 1 间、落单向上取整独占；未知每人独占 1 间。
       */
      physicalUsed: number[];
      /**
       * 物理房间口径余量，逐日。
       *   具体酒店 = block − physicalUsed；
       *   聚合组   = Σ(同星级酒店 block − 其物理用房) − 未落位随机单物理用房（口径同 remaining）。
       */
      physicalRemaining: number[];
    };
  }>;
}

/** from..to（含两端）展开为 YYYY-MM-DD 数组；超 MAX_BOARD_DAYS 按 from 起截断。*/
function buildDateRange(from: string, to: string): string[] {
  if (from > to) {
    throw new BadRequestError('起始日不能晚于结束日');
  }
  const fromMs = toDateOnly(from).getTime();
  const toMs = toDateOnly(to).getTime();
  const days = Math.min(Math.floor((toMs - fromMs) / DAY_MS) + 1, MAX_BOARD_DAYS);
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    dates.push(new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

export async function getBoard(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<HotelControlBoard> {
  const dates = buildDateRange(range.from, range.to);
  const fromD = toDateOnly(dates[0]);
  const toD = toDateOnly(dates[dates.length - 1]);

  // 周期：与 [from, to] 有交集的全部（按 dateFrom 倒序 → 第一条即"最新周期"）
  // hotel.starRating / intlFiveStar / randomTierPlaceholder 随主查带回，供随机档聚合分组，不额外查库。
  const periods = await client.hotelBlockPeriod.findMany({
    where: { dateFrom: { lte: toD }, dateTo: { gte: fromD } },
    orderBy: { dateFrom: 'desc' },
    include: {
      hotel: {
        select: {
          name: true,
          starRating: true,
          intlFiveStar: true,
          randomTierPlaceholder: true,
        },
      },
    },
  });

  // 占房订单行：一次 findMany 拉全范围内相关行，再在 JS 里按天展开（无逐日查询）
  // 入住区间 [checkIn, checkOut) 与 [from, to] 有交集 ⇔ checkIn <= to && checkOut > from
  // 两类占房行：盖了房型的（归具体酒店）+ 未落位随机单（randomStarTier 非空，归随机档聚合组）。
  const items = await client.orderItem.findMany({
    where: {
      OR: [{ hotelRoomTypeId: { not: null } }, { randomStarTier: { not: null } }],
      hotelCheckIn: { lte: toD },
      hotelCheckOut: { gt: fromD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    select: {
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      metadata: true,
      randomStarTier: true,
      hotelRoomType: {
        select: {
          hotelId: true,
          hotel: {
            select: {
              name: true,
              starRating: true,
              intlFiveStar: true,
              randomTierPlaceholder: true,
            },
          },
        },
      },
      // roomAssignment = 权威分房表（优先直计物理间数，订单级去重需 id）；
      // passengers.gender = fallback 拼房性别推算（异性不能拼一间）——拼房单恒为
      // adultCount===1 的套餐单，取其出行人性别；批量随主查带回，不额外查库。
      order: {
        select: { id: true, roomAssignment: true, passengers: { select: { gender: true } } },
      },
    },
  });

  // 具体酒店分组 = 有周期的 ∪ 有占房的。两类**一律跳过**（随机档已改为同星级酒店的派生聚合，
  // 再把它们的 rooms 计进来就是第二本账；数据保留供审计，读路径不认）：
  //   · 存量随机档周期（hotelId 为 NULL）；
  //   · 占位酒店（randomTierPlaceholder 非空）—— 它不作为酒店组出现，名下周期不计入包房，
  //     落在它房型上的占房行改由下面的聚合组按「未落位」统计。
  const groups = new Map<string, { name: string; randomTier: number | null }>();
  for (const p of periods) {
    if (!p.hotelId || p.hotel?.randomTierPlaceholder != null) continue;
    groups.set(p.hotelId, {
      name: p.hotel?.name ?? p.hotelId,
      randomTier: p.hotel ? randomTierOfHotel(p.hotel) : null,
    });
  }
  for (const it of items) {
    if (!it.hotelRoomType || groups.has(it.hotelRoomType.hotelId)) continue;
    if (it.hotelRoomType.hotel.randomTierPlaceholder != null) continue;
    groups.set(it.hotelRoomType.hotelId, {
      name: it.hotelRoomType.hotel.name,
      randomTier: randomTierOfHotel(it.hotelRoomType.hotel),
    });
  }

  /** 一组周期 + 占房行 → 销控板的一套逐日数列（酒店组与聚合组共用，不出现第二本账）。*/
  const buildRows = (
    groupPeriods: typeof periods,
    groupItems: typeof items,
  ): HotelControlBoard['hotels'][number]['rows'] => {
    const block = expandBlockByDate(groupPeriods, dates);
    const used = expandUsedByDate(groupItems, dates);
    // 权威分房表订单直计物理间数并退出拼房口径；其余行（fallback）按性别推算
    const { assignedPhysical, fallbackItems } = expandAssignedPhysicalByDate(groupItems, dates);
    // 拼房客（0.5 半间）逐日按性别分桶（仅 fallback 订单；异性不能拼一间；
    // 已有分房表的订单不进拼房桶、不标「拼」落单）
    const buckets = expandSharedHalfByDate(fallbackItems, dates);
    const sharedHalfCount = buckets.m.map((mv, i) => mv + buckets.f[i] + buckets.u[i]);
    // 落单数 = 同性两两配对后的余数 + 未知性别（全算落单）
    const sharedUnpaired = buckets.m.map((mv, i) => (mv % 2) + (buckets.f[i] % 2) + buckets.u[i]);
    const sharedOdd = sharedUnpaired.map((n) => n > 0);
    // 物理房间口径（内存推导，无额外查库）：分房表直计 + fallback 性别推算
    const fallbackPhysical = computePhysicalUsed(expandUsedByDate(fallbackItems, dates), buckets);
    const physicalUsed = fallbackPhysical.map((v, i) => round2(v + assignedPhysical[i]));
    return {
      block,
      used,
      remaining: block.map((b, i) => round2(b - used[i])),
      sharedHalfCount,
      sharedUnpaired,
      sharedOdd,
      physicalUsed,
      physicalRemaining: block.map((b, i) => round2(b - physicalUsed[i])),
    };
  };

  const hotelGroups = Array.from(groups.entries())
    .sort(([, a], [, b]) => a.name.localeCompare(b.name, 'zh-CN'))
    .map(([hotelId, { name: hotelName, randomTier }]) => {
      const groupPeriods = periods.filter((p) => p.hotelId === hotelId);
      const groupItems = items.filter((it) => it.hotelRoomType?.hotelId === hotelId);
      const latestPriced = groupPeriods.find((p) => p.unitPrice != null);
      return {
        hotelId,
        hotelName,
        randomStarTier: null as number | null,
        unitPrice: latestPriced ? round2(dec(latestPriced.unitPrice)!) : null,
        rows: buildRows(groupPeriods, groupItems),
        /** 该酒店归属的随机档（仅供下面聚合，不进对外 DTO）。*/
        randomTier,
      };
    });

  // ── 随机档聚合组（三星随机 / 四星随机 / 五星随机）──────────────────────
  // 包房 = 同星级真酒店包房合计；用房 = 未落位占用；
  // 余量 = Σ(同星级酒店余量) − 未落位占用（见文件头「星级随机档」小节的对账恒等）。
  //
  // 「未落位占用」收两类行（业务上都还没落到真酒店，见文件头小节）：
  //   a) 无房型 + randomStarTier 非空 —— 正规未落位随机单，档次取 randomStarTier；
  //   b) 房型挂在占位酒店上 —— 伪落位行，档次取该占位酒店的 randomTierPlaceholder。
  // 上面的酒店分组已把 (b) 排除在酒店组之外，故两处不会重复计一笔。
  const pendingByTier = new Map<number, typeof items>();
  const pushPending = (tier: number, it: (typeof items)[number]): void => {
    const list = pendingByTier.get(tier) ?? [];
    list.push(it);
    pendingByTier.set(tier, list);
  };
  for (const it of items) {
    const placeholderTier = it.hotelRoomType
      ? placeholderTierOfHotel(it.hotelRoomType.hotel)
      : null;
    if (placeholderTier != null) {
      pushPending(placeholderTier, it);
      continue;
    }
    if (it.hotelRoomType || it.randomStarTier == null) continue;
    pushPending(it.randomStarTier, it);
  }
  // 出现条件：该档次有同星级酒店进了销控板（有周期或有占房），或有未落位随机单待落地
  const tiers = new Set<number>([
    ...hotelGroups.filter((h) => h.randomTier != null).map((h) => h.randomTier!),
    ...pendingByTier.keys(),
  ]);
  const poolGroups = Array.from(tiers)
    .sort((a, b) => a - b)
    .map((tier) => {
      const tierHotels = hotelGroups.filter((h) => h.randomTier === tier);
      const pendingRows = buildRows([], pendingByTier.get(tier) ?? []);
      const sumAt = (pick: (h: (typeof tierHotels)[number]) => number[]) => (i: number) =>
        tierHotels.reduce((sum, h) => sum + (pick(h)[i] ?? 0), 0);
      const blockAt = sumAt((h) => h.rows.block);
      const hotelRemainingAt = sumAt((h) => h.rows.remaining);
      const hotelPhysRemainingAt = sumAt((h) => h.rows.physicalRemaining);
      return {
        hotelId: randomPoolGroupKey(tier),
        hotelName: randomStarTierLabel(tier),
        randomStarTier: tier as number | null,
        // 聚合组横跨多家酒店，没有单一切房单价
        unitPrice: null,
        rows: {
          ...pendingRows,
          block: dates.map((_, i) => blockAt(i)),
          remaining: dates.map((_, i) => round2(hotelRemainingAt(i) - pendingRows.used[i])),
          physicalRemaining: dates.map((_, i) =>
            round2(hotelPhysRemainingAt(i) - pendingRows.physicalUsed[i]),
          ),
        },
      };
    });

  // 聚合组排在最前（房控先看「随机单还剩多少没落地、同星级还够不够」），其余酒店按名称
  const hotels = [
    ...poolGroups,
    ...hotelGroups.map(({ randomTier: _tier, ...rest }) => rest),
  ];

  return { dates, hotels };
}

// ── 提醒线（超卖加房 / 富余退房 / 班次超开票上限 / 拼房落单临近）──────────
export interface HotelControlAlerts {
  /** 余量 < 0：占房超过包房，提醒加房 */
  oversold: Array<{
    hotelId: string;
    hotelName: string;
    date: string; // YYYY-MM-DD
    block: number;
    used: number;
    deficit: number; // used - block（正数）
  }>;
  /** 距今 3 天内仍有剩余包房（block > 0 且 remaining > 0）：提示该退房 */
  surplusSoon: Array<{ hotelName: string; date: string; surplus: number }>;
  /** 出发在 30 天内、计入口径乘客数超过班次开票上限（默认 191）的班次 */
  overCapacitySchedules: Array<{
    flightNumber: string;
    departureDate: string; // YYYY-MM-DD
    paxCount: number;
  }>;
  /**
   * 入住临近（SHARED_ODD_NEAR_DAYS 天内）当晚有拼房客无法配对（落单数 > 0，异性不能拼、
   * 未知性别每人独占）：需趁出发前补单房差或另配。被动的销控板「拼」角标之外的主动推送。
   */
  sharedOddNear: Array<{
    hotelId: string;
    hotelName: string;
    date: string; // YYYY-MM-DD（入住晚）
    sharedHalfCount: number; // 当晚拼房客总人数（触发条件是落单数 > 0）
  }>;
}

/** 富余提醒窗口（天）— 距今 3 天内还剩包房就该考虑退房了。*/
const SURPLUS_WINDOW_DAYS = 3;

/** 班次超员检查窗口（天）。*/
const SCHEDULE_ALERT_WINDOW_DAYS = 30;

/** 拼房客落单主动提醒窗口（天）— 入住在此天数内且当晚有拼房客落单（落单数>0）就推送。*/
const SHARED_ODD_NEAR_DAYS = 7;

/**
 * 按需计算提醒线（无 cron）：
 *   - 超卖 / 富余直接复用销控板 getBoard 的展开结果，不重复口径；
 *   - 班次乘客数按导出同款 COUNTED_STATUSES 统计，对比 FlightSchedule.ticketingCap（默认 191）。
 *
 * 随机档聚合组同样是 getBoard 的一个分组，因此「随机单落不下去了」（聚合余量 < 0）
 * 一并进超卖提醒；此时 hotelName = 「三星随机」/「四星随机」、hotelId = 聚合组合成键
 * （非真实酒店 id，仅供去重）。
 * 但**富余提醒跳过聚合组** —— 聚合余量是同星级各酒店余量推导出来的，那些酒店自己已经
 * 各报了一条富余，聚合组再报一次就是同一件事重复推送。
 */
export async function getAlerts(
  days: number,
  client: PrismaClient = defaultPrisma,
): Promise<HotelControlAlerts> {
  const now = new Date();
  const today = businessDateISO(now);
  const fromMs = toDateOnly(today).getTime();
  // [today, today+days) → 销控板闭区间 [today, today+days-1]
  const to = new Date(fromMs + (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const board = await getBoard({ from: today, to }, client);

  const oversold: HotelControlAlerts['oversold'] = [];
  const surplusSoon: HotelControlAlerts['surplusSoon'] = [];
  const sharedOddNear: HotelControlAlerts['sharedOddNear'] = [];
  const surplusCutoff = new Date(fromMs + SURPLUS_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  // 拼房落单临近窗口：入住晚在 [today, today+SHARED_ODD_NEAR_DAYS) 内即算「临近」。
  const sharedOddCutoff = new Date(fromMs + SHARED_ODD_NEAR_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  for (const hotel of board.hotels) {
    for (let i = 0; i < board.dates.length; i++) {
      const date = board.dates[i];
      const block = hotel.rows.block[i];
      const used = hotel.rows.used[i];
      const remaining = hotel.rows.remaining[i];
      if (remaining < 0) {
        oversold.push({
          hotelId: hotel.hotelId,
          hotelName: hotel.hotelName,
          date,
          block,
          used,
          // 具体酒店 remaining = block − used，故 −remaining 与旧的 used − block 完全一致；
          // 聚合组 remaining 另有公式（同星级余量合计 − 未落位随机单），只有 −remaining 才是真缺口。
          deficit: round2(-remaining),
        });
      }
      if (hotel.randomStarTier == null && date < surplusCutoff && block > 0 && remaining > 0) {
        surplusSoon.push({ hotelName: hotel.hotelName, date, surplus: remaining });
      }
      // 有拼房客落单（异性不能拼、未知独占后仍无法配对）且入住临近 → 主动提醒补单房差 / 另配
      const shared = hotel.rows.sharedHalfCount[i];
      const unpaired = hotel.rows.sharedUnpaired[i];
      if (date < sharedOddCutoff && unpaired > 0) {
        sharedOddNear.push({
          hotelId: hotel.hotelId,
          hotelName: hotel.hotelName,
          date,
          sharedHalfCount: shared,
        });
      }
    }
  }

  // 班次乘客数 > 开票上限 — 出发日在 [today, today+30d)
  const fromD = startOfBusinessDayUtc(now);
  const horizon = new Date(fromD.getTime() + SCHEDULE_ALERT_WINDOW_DAYS * DAY_MS);
  const schedules = await client.flightSchedule.findMany({
    where: { departureTime: { gte: fromD, lt: horizon } },
    orderBy: { departureTime: 'asc' },
    select: {
      id: true,
      departureTime: true,
      // 座位库存 = Σ 各舱位 capacity（商务 + 经济 + …），与开票上限同源（见 orders/ticketing-cap.ts）。
      // 曾经这里读 FlightSchedule.ticketingCap（常量 191）—— 那是与真实座位数从不对账的第二本账，已删。
      seatClasses: { select: { capacity: true } },
      flight: { select: { flightNumber: true } },
    },
  });
  const paxCounts = await Promise.all(
    schedules.map((s) =>
      client.passenger.count({
        where: {
          order: {
            deletedAt: null, // 排除已软删订单
            status: { in: COUNTED_STATUSES },
            items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: s.id } },
          },
        },
      }),
    ),
  );
  const overCapacitySchedules: HotelControlAlerts['overCapacitySchedules'] = [];
  schedules.forEach((s, i) => {
    // 一个舱位都没配的班次 → 无库存可比，跳过（与 getScheduleSeatCapacity 同口径：
    // 这种班次本来就卖不出座，把上限当 0 会把它全部报成超员）。
    if (s.seatClasses.length === 0) return;
    const seatCapacity = s.seatClasses.reduce((sum, sc) => sum + sc.capacity, 0);
    if (paxCounts[i] > seatCapacity) {
      overCapacitySchedules.push({
        flightNumber: s.flight.flightNumber,
        departureDate: fmtDateOnly(s.departureTime),
        paxCount: paxCounts[i],
      });
    }
  });

  return { oversold, surplusSoon, overCapacitySchedules, sharedOddNear };
}

// ── 近期用房变更（读审计流，不新做事件系统）────────────────────────────────
/**
 * 会实际改动酒店用房口径、或影响占房行程日期的订单操作 —— 全部由 orders 路由在成功后 writeAudit 落库：
 *   UPDATE_ROOM_ASSIGNMENT  调整分房（改 roomAssignment / 计费房数 → 直接影响「占」）
 *   SWAP_ORDER_ITEM_HOTEL   换酒店（改 hotelRoomTypeId → 换一家酒店占房）
 *   ADD_ROOM_SUPPLEMENT     补收单房差（房数/房态相关的售后补收）
 *   RESCHEDULE_ORDER_ITEM   改期（改航班班次/出发日）——不落 hotelCheckIn/hotelCheckOut，
 *                           不改变销控板占房数字口径，但会改变出行日期，房控需要能看到这单动了。
 *   RESCHEDULE_ORDER_ITEM_HOTEL  酒店改期（改 hotelCheckIn/hotelCheckOut → 占房整段从旧区间
 *                           挪到新区间）——直接改动销控板逐晚占房，房控必须看得见。
 * 五者 targetType 均为 ORDER、targetId=订单 id、targetLabel=订单号。
 */
export const ROOM_CHANGE_ACTIONS = [
  'UPDATE_ROOM_ASSIGNMENT',
  'SWAP_ORDER_ITEM_HOTEL',
  'ADD_ROOM_SUPPLEMENT',
  'RESCHEDULE_ORDER_ITEM',
  'RESCHEDULE_ORDER_ITEM_HOTEL',
] as const;

/** 近期用房变更返回上限（条）。*/
const ROOM_CHANGE_LIMIT = 100;

const ROOM_CHANGE_ACTION_LABELS: Record<string, string> = {
  UPDATE_ROOM_ASSIGNMENT: '调整分房',
  SWAP_ORDER_ITEM_HOTEL: '换酒店',
  ADD_ROOM_SUPPLEMENT: '补收单房差',
  RESCHEDULE_ORDER_ITEM: '改期',
  RESCHEDULE_ORDER_ITEM_HOTEL: '酒店改期',
};

export interface HotelRoomChangeEntry {
  id: string;
  action: string;
  actionLabel: string; // 人类可读中文（不含任何内部人名）
  orderId: string | null; // = AuditLog.targetId
  orderNumber: string | null; // = AuditLog.targetLabel
  actor: string | null; // 操作人（displayName/email/角色，运行期真实数据）
  summary: string; // 关键字段摘要（房数/酒店等）
  severity: string;
  at: string; // ISO8601
  /** 出行人姓名（优先中文名，无则回落护照姓名；占位联系人不列）。订单查不到/已软删 → []。 */
  passengerNames: string[];
  /** 出发日（YYYY-MM-DD，按出发地时区折算）——订单 FLIGHT 行按班次 departureTime 升序第 1 段；无航段/查不到订单 → null。 */
  departDate: string | null;
  /** 返程日（YYYY-MM-DD）——FLIGHT 行第 2 段；单程/无航段/查不到订单 → null。 */
  returnDate: string | null;
  /** 订单总额（CNY）= Order.total；查不到订单 → null。 */
  orderAmountCny: number | null;
}

export interface HotelRecentRoomChanges {
  days: number;
  count: number;
  changes: HotelRoomChangeEntry[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function readNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function readStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** 从 before/after JSON 里挑关键字段拼出一句人类可读的变更摘要。*/
function summarizeRoomChange(action: string, before: unknown, after: unknown): string {
  const b = asRecord(before);
  const a = asRecord(after);
  if (action === 'UPDATE_ROOM_ASSIGNMENT') {
    const from = readNum(b.roomsBilled);
    const to = readNum(a.roomsBilled);
    if (from != null && to != null && from !== to) return `计费房数 ${from} → ${to} 间`;
    if (to != null) return `分房调整（计费房数 ${to} 间）`;
    return '分房调整';
  }
  if (action === 'SWAP_ORDER_ITEM_HOTEL') {
    const fromH = readStr(b.hotelName);
    const fromR = readStr(b.roomTypeName);
    const toH = readStr(a.hotelName);
    const toR = readStr(a.roomTypeName);
    const fromLabel = fromH ? `${fromH}${fromR ? `·${fromR}` : ''}` : '原酒店';
    const toLabel = toH ? `${toH}${toR ? `·${toR}` : ''}` : '新酒店';
    return `换酒店 ${fromLabel} → ${toLabel}`;
  }
  if (action === 'ADD_ROOM_SUPPLEMENT') {
    const perNight = readNum(a.perNightCny);
    const nights = readNum(a.nights);
    const amount = readNum(a.amountCny);
    if (perNight != null && nights != null) {
      return `补收单房差 ${perNight}元 × ${nights} 晚${amount != null ? ` = ${amount} 元` : ''}`;
    }
    return '补收单房差';
  }
  if (action === 'RESCHEDULE_ORDER_ITEM_HOTEL') {
    // before/after.checkIn|checkOut 是 YYYY-MM-DD（date-only 字段，writeAudit 落库时已是纯日期串）。
    const fromIn = readStr(b.checkIn);
    const fromOut = readStr(b.checkOut);
    const toIn = readStr(a.checkIn);
    const toOut = readStr(a.checkOut);
    const nights = readNum(a.nights);
    if (fromIn && fromOut && toIn && toOut) {
      return `酒店改期 ${fromIn}~${fromOut} → ${toIn}~${toOut}${nights != null ? `（${nights} 晚）` : ''}`;
    }
    if (toIn && toOut) return `酒店改期至 ${toIn}~${toOut}`;
    return '酒店改期';
  }
  if (action === 'RESCHEDULE_ORDER_ITEM') {
    // before/after.departure 是 writeAudit 落库时 Date.toISOString() 的完整 ISO8601 串（非 @db.Date）。
    const fromDate = readStr(b.departure)?.slice(0, 10) ?? null;
    const toDate = readStr(a.departure)?.slice(0, 10) ?? null;
    if (fromDate && toDate && fromDate !== toDate) return `改期 ${fromDate} → ${toDate}`;
    if (toDate) return `改期至 ${toDate}`;
    return '改期';
  }
  return ROOM_CHANGE_ACTION_LABELS[action] ?? action;
}

interface RoomChangeOrderInfo {
  passengerNames: string[];
  departDate: string | null;
  returnDate: string | null;
  orderAmountCny: number | null;
}

/**
 * 按 orderId 去重批量查订单，给「近期用房变更」面板补充乘客姓名/出行日期/订单金额。
 * 查不到的订单（id 已失效等）不在返回的 Map 里——调用方按 undefined 处理，各字段置 null/[]，不抛错。
 */
async function buildRoomChangeOrderInfo(
  orderIds: string[],
  client: PrismaClient,
): Promise<Map<string, RoomChangeOrderInfo>> {
  const map = new Map<string, RoomChangeOrderInfo>();
  if (orderIds.length === 0) return map;

  const orders = await client.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      total: true,
      passengers: { select: { documentNumber: true, chineseName: true, fullName: true } },
      // 出发/返程日：订单 FLIGHT 行按班次 departureTime 升序，第 1 段=去程、第 2 段=回程（与 Order.outboundInvoiced 注释同口径）。
      items: {
        where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        orderBy: { flightSchedule: { departureTime: 'asc' } },
        select: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
      },
    },
  });

  for (const order of orders) {
    const legs = order.items
      .map((it) => it.flightSchedule)
      .filter((fs): fs is NonNullable<typeof fs> => fs != null);
    map.set(order.id, {
      passengerNames: order.passengers
        .filter((p) => p.documentNumber !== 'N/A')
        .map((p) => p.chineseName?.trim() || p.fullName),
      departDate: legs[0] ? fmtDepartureLocalDate(legs[0].departureTime, legs[0].departureTz) : null,
      returnDate: legs[1] ? fmtDepartureLocalDate(legs[1].departureTime, legs[1].departureTz) : null,
      orderAmountCny: dec(order.total),
    });
  }
  return map;
}

/**
 * 近期用房变更（近 N 天，倒序，上限 100 条）——读 AuditLog 中会影响用房的订单操作，
 * 并批量补充乘客姓名/出行日期/订单金额，方便房控核对是谁、哪天走、多少钱的单动了用房。
 * 给房控看板顶部「近期用房变更」面板做可见性，不做已读态、不建事件系统。
 */
export async function getRecentRoomChanges(
  days: number,
  client: PrismaClient = defaultPrisma,
): Promise<HotelRecentRoomChanges> {
  const since = new Date(Date.now() - days * DAY_MS);
  const logs = await client.auditLog.findMany({
    where: {
      action: { in: [...ROOM_CHANGE_ACTIONS] },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
    take: ROOM_CHANGE_LIMIT,
    select: {
      id: true,
      action: true,
      targetId: true,
      targetLabel: true,
      before: true,
      after: true,
      severity: true,
      createdAt: true,
      actorLabel: true,
      actorRole: true,
      actor: { select: { displayName: true, email: true } },
    },
  });

  const orderIds = Array.from(
    new Set(logs.map((log) => log.targetId).filter((id): id is string => !!id)),
  );
  const orderInfoById = await buildRoomChangeOrderInfo(orderIds, client);

  const changes: HotelRoomChangeEntry[] = logs.map((log) => {
    const info = log.targetId ? orderInfoById.get(log.targetId) : undefined;
    return {
      id: log.id,
      action: log.action,
      actionLabel: ROOM_CHANGE_ACTION_LABELS[log.action] ?? log.action,
      orderId: log.targetId,
      orderNumber: log.targetLabel,
      actor:
        log.actor?.displayName ??
        log.actor?.email ??
        log.actorLabel ??
        (log.actorRole ? String(log.actorRole) : null),
      summary: summarizeRoomChange(log.action, log.before, log.after),
      severity: String(log.severity),
      at: log.createdAt.toISOString(),
      passengerNames: info?.passengerNames ?? [],
      departDate: info?.departDate ?? null,
      returnDate: info?.returnDate ?? null,
      orderAmountCny: info?.orderAmountCny ?? null,
    };
  });

  return { days, count: changes.length, changes };
}

// ── 远期视图（按日期跨酒店合计）──────────────────────────────────────────
export interface HotelControlForward {
  dates: string[];
  held: number[]; // 切房合计
  occupied: number[]; // 占房合计
  remaining: number[]; // held - occupied
}

/**
 * 跨酒店合计。随机档聚合组的「包房」是同星级酒店包房的合计（派生值）——**必须排除**，
 * 否则那些房会被计两遍；它的「用房」是未落位随机单，那是任何酒店行里都没有的真实占用，
 * 因此**要计入**收客。
 */
export async function getForward(
  range: { from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<HotelControlForward> {
  const board = await getBoard(range, client);
  const held = board.dates.map((_, i) =>
    board.hotels.reduce((sum, h) => sum + (h.randomStarTier != null ? 0 : h.rows.block[i]), 0),
  );
  const occupied = board.dates.map((_, i) =>
    round2(board.hotels.reduce((sum, h) => sum + h.rows.used[i], 0)),
  );
  const remaining = held.map((v, i) => round2(v - occupied[i]));
  return { dates: board.dates, held, occupied, remaining };
}

// ── 占房下钻（某酒店某晚，谁占的；销控矩阵余量格点击下钻用）──────────────────
export interface HotelOccupantDto {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  contactName: string;
  /** 该订单出行人数（占位联系人 documentNumber='N/A' 不计，口径同前台分房池） */
  passengerCount: number;
  /**
   * 该订单出行人姓名（优先中文名，无则回落护照姓名；占位联系人 documentNumber='N/A' 不列）。
   * 用于房控核对分房——一眼看清这几间房住的是哪几个人。
   */
  passengerNames: string[];
  /**
   * 该占房行的间数。有权威分房表（Order.roomAssignment.roomGroups）的订单按
   * 「有乘客的房间盒子数」展示（物理间数，覆盖被塌缩的 roomsBilled）；
   * 否则与销控板「用房」同口径（见 itemRoomCount）。
   */
  rooms: number;
  checkIn: string; // YYYY-MM-DD（该行入住日）
  checkOut: string; // YYYY-MM-DD（该行退房日）
  agentName: string; // 无代理 = '直客'
}

/**
 * 某酒店某晚的占房订单明细。过滤口径与 getHotelNightlyRemaining 的 used 完全一致
 * （COUNTED_STATUSES + [checkIn, checkOut) 半开区间覆盖该晚）。
 * 一个订单若有多行占该酒店该晚（如同订单订了两种房型）展开成多行、不做订单级合并——
 * 每行对应一次真实占房，避免合并后间数/入住区间失真。
 */
export async function getOccupyingOrders(
  scope: string | RoomScope,
  date: string,
  client: PrismaClient = defaultPrisma,
): Promise<HotelOccupantDto[]> {
  // 兼容既有按 hotelId 字符串调用（分房表导出等）
  const roomScope: RoomScope = typeof scope === 'string' ? { hotelId: scope } : scope;
  const d = toDateOnly(date);
  const items = await client.orderItem.findMany({
    where: {
      ...scopeItemWhere(roomScope),
      hotelCheckIn: { lte: d },
      hotelCheckOut: { gt: d },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    orderBy: { hotelCheckIn: 'asc' },
    select: {
      roomsBilled: true,
      metadata: true,
      hotelCheckIn: true,
      hotelCheckOut: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          contactName: true,
          roomAssignment: true, // 权威分房表——间数展示优先按「有乘客的房间盒子数」
          agent: { select: { companyName: true } },
          passengers: { select: { documentNumber: true, chineseName: true, fullName: true } },
        },
      },
    },
  });

  return items
    .filter((it) => it.hotelCheckIn != null && it.hotelCheckOut != null)
    .map((it) => ({
      orderId: it.order.id,
      orderNumber: it.order.orderNumber,
      status: it.order.status,
      contactName: it.order.contactName,
      passengerCount: it.order.passengers.filter((p) => p.documentNumber !== 'N/A').length,
      passengerNames: it.order.passengers
        .filter((p) => p.documentNumber !== 'N/A')
        .map((p) => p.chineseName?.trim() || p.fullName),
      rooms: assignedPhysicalRooms(it.order.roomAssignment) ?? itemRoomCount(it),
      checkIn: fmtDateOnly(it.hotelCheckIn!),
      checkOut: fmtDateOnly(it.hotelCheckOut!),
      agentName: it.order.agent?.companyName ?? '直客',
    }));
}

// ── 当日余量（给定房型 + 入住区间；分房弹窗徽标用）───────────────────────────
export interface HotelNightlyRemainingResult {
  dates: string[];
  remaining: number[];
  block: number[];
  hasBlock: boolean;
}

/** [checkIn, checkOut) 逐晚展开为 YYYY-MM-DD（半开区间）。*/
function buildNightDates(checkIn: string, checkOut: string): string[] {
  const fromMs = toDateOnly(checkIn).getTime();
  const toMs = toDateOnly(checkOut).getTime();
  const nights = Math.max(0, Math.round((toMs - fromMs) / DAY_MS));
  return Array.from({ length: nights }, (_, i) =>
    new Date(fromMs + i * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * 由 hotelRoomTypeId 解出 hotelId 后复用 getHotelNightlyRemaining——分房弹窗徽标（RoomingEditor）用。
 * ADMIN/STAFF only：直接回原始数字，与前台 /products/hotel-availability 的档位口径不同（那是公开端点，
 * 只回 tier 不回数字）。
 *
 * `remaining` 回的是**物理房间口径**（physicalRemaining），与销控板看板 / 房态导出 / 下单闸完全一致：
 * 分房是按真实房间盒子摆人的，徽标必须回真实可用整间数。床位口径（block − Σ roomsBilled）会把
 * 「男+女各一位拼房客」算成 1 间、把落单拼房客算成半间，分房时照着摆必然摆不下。
 */
export async function getNightlyRemainingForRoomType(
  hotelRoomTypeId: string,
  checkIn: string,
  checkOut: string,
  client: PrismaClient = defaultPrisma,
): Promise<HotelNightlyRemainingResult> {
  const roomType = await client.hotelRoomType.findUnique({
    where: { id: hotelRoomTypeId },
    select: { hotelId: true },
  });
  if (!roomType) throw new NotFoundError('房型不存在');

  const dates = buildNightDates(checkIn, checkOut);
  const { physicalRemaining, block, hasBlock } = await getHotelNightlyRemaining(
    roomType.hotelId,
    dates,
    client,
  );
  return { dates, remaining: physicalRemaining, block, hasBlock };
}
