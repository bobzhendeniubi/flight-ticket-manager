// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  PASSENGER_SHARES_INCLUDE,
  resolvePassengerShares,
  type PersistedShareLike,
  type ShareSourceOrder,
} from '../passenger-shares.js';
import { attachPersistedShares } from './passenger-shares.js';
import {
  AuditTargetType,
  OrderItemKind,
  OrderLegFlag,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { AppError, ForbiddenError, NotFoundError } from '../../../lib/errors.js';
import type { ItineraryData } from '../../../lib/itinerary-pdf.js';
import { stripInternalLegPrefix, derivePublicLegStatus } from '../orders.leg-status.js';
import type { LegStatusItemLike, PublicLegStatus } from '../orders.leg-status.js';
import { balanceDueCny, payableCny } from '../../../lib/order-money.js';
import { AGENT_STATS_PAID_STATUSES } from '../../../lib/order-status-sets.js';
import { randomStarTierLabel } from '../../hotel-control/hotel-control.service.js';
import { determineFlightLegItems } from '../ticketing-cap.js';
import type { FlightLegItem } from '../ticketing-cap.js';
import type { ListOrdersQuery, PublicOrderLookupQuery } from '../orders.schemas.js';
import { FulfillmentStatus, FulfillmentType } from '@prisma/client';
import {
  actorCan,
  ALLOWED_TRANSITIONS,
  computeAgentSelfEditWindow,
  DAY_MS,
  formatDateOnly,
  formatHHMM,
  ITINERARY_READY_STATUSES,
  type OrderRequester,
  round2,
} from './shared.js';
import type { OrderService } from '../orders.service.js';

// ── 代理分销统计（GET /orders/agent-stats）────────────────────────────────
/**
 * 统计口径的「已付款」= 钱已经进来、单子还算数的三个状态。
 * 与列表卡片标题「仅含已付款订单」同义，也与卡片此前的前端算法逐字一致 ——
 * 待支付单不算成交额，取消/退款族不再是成交。
 */
//（AGENT_STATS_PAID_STATUSES 本体见 lib/order-status-sets.ts = 已付款四态 − PROCESSING；与仪表盘 /
//  客户档案的两个「已付款」集合不同，差异已登记待拍板，不合并。）

/** 代理行查不到（已删/脏数据）时的兜底名，与前台列表同一标签，不静默丢掉这笔成交额。*/
export const AGENT_STATS_UNKNOWN_AGENT_LABEL = '未知代理';

/** GET /orders/agent-stats 响应体。金额单位元（CNY），两位小数。*/
export interface AgentStatsResult {
  /** 直客/散客（Order.agentId 为空）汇总。*/
  direct: { orders: number; revenueCny: number };
  /** 各代理汇总，按成交额从高到低。*/
  agents: Array<{ agentId: string; agentName: string; orders: number; revenueCny: number }>;
}

// ════════════════════════════════════════════════════════════════════
// 列表
// ════════════════════════════════════════════════════════════════════
/**
 * 列表取数的最终 where —— 「筛选 + RBAC + 接单 + 出行/返程/航班日期精筛」一次算完。
 *
 * 抽出来是因为「代理分销统计」必须与列表**同一口径**：统计卡片曾在前端按已加载的那一页
 * 现算，真分页之后只能由后端聚合；聚合若自己再拼一份 where，两处必然漂移（差一个 RBAC
 * 分支就是越权，差一个精筛就是「卡片数字和列表条数对不上」）。listOrders 与
 * getAgentStats 共用本方法，保证两者永远看同一批订单。
 *
 * 不含分页与排序（由调用方各自决定）。
 */
export async function resolveListOrdersWhere(svc: OrderService, query: ListOrdersQuery, requester: OrderRequester): Promise<Prisma.OrderWhereInput> {
  // 代理不能按 legFlag 筛：那是内部航段口径，能筛就能反推（见 withoutAgentHiddenFilters）。
  const where = buildOrderFilterWhere(
    requester.role === 'AGENT' ? withoutAgentHiddenFilters(query) : query,
  );

  // RBAC 过滤 — 先建基准可见集合，再按 query 过滤（但 query.agentId 不能覆盖可见集合）
  if (requester.role === 'CUSTOMER') {
    where.userId = requester.userId;
  } else if (requester.role === 'AGENT') {
    const visibleAgentIds = await svc.getDescendantAgentIds(requester.agentId);
    if (query.agentId) {
      // agentId 过滤 — 必须在可见集合内才生效，否则 403（防横向越权）
      if (!visibleAgentIds.includes(query.agentId)) {
        throw new ForbiddenError('无权查看该代理的订单');
      }
      // where.agentId 已由 buildOrderFilterWhere 设为 query.agentId
    } else {
      where.agentId = { in: visibleAgentIds };
    }
  }
  // ADMIN/STAFF: 无额外过滤；query.agentId（如有）已由 buildOrderFilterWhere 设置

  if (query.claimedById) where.claimedById = query.claimedById;
  if (query.unclaimedOnly) where.claimedById = null;

  // 出行日期 / 返程日期精确细筛（两段式）：buildOrderFilterWhere 的 travelFrom/travelTo、
  // returnFrom/returnTo 都只做 ±1 天粗窗口（防 UTC/本地日边界漏单），会把「去程 7/10、回程
  // 7/11」这类整单出发日/返程日在窗口外的往返单也粗召回。
  // 这里在分页/计数之前，先按粗窗口 + 全部筛选 + RBAC 圈出候选订单的最早/回程航段与酒店时间
  //（只取必要字段），在 JS 里按整单出发日（deriveOrderDepartDate）与整单返程日
  //（deriveOrderReturnDate）精确判定，再把命中 id 作为 id in (...) 并回 where —— 保证分页
  // take/skip 与总数都在精确过滤之后计算，且「列表所见 = 筛选所得」。两个筛选可同时给出，
  // 精确结果取交集。orderIds 勾选导出不走 listOrders，此处无需考虑。
  if (
    query.travelFrom ||
    query.travelTo ||
    query.returnFrom ||
    query.returnTo ||
    query.flightDateFrom ||
    query.flightDateTo
  ) {
    const candidates = await prisma.order.findMany({
      where,
      select: {
        id: true,
        items: {
          select: {
            hotelCheckIn: true,
            // 纯签证单的第三级日期锚点：漏了这个字段，deriveOrderDepartDate 在精筛时
            // 拿不到签证预计出行日期 → 派生 null → 整单被丢，DB 召回白做。
            visaIntendedDate: true,
            // 回程精筛（deriveOrderReturnDate → determineFlightLegItems）按 departureTime
            // 升序取第 2 段，需要 flightScheduleId 才能判定该行是不是「带班次的 FLIGHT 行」。
            flightScheduleId: true,
            // 航班日期精筛在「航班号+日期同段」组合时要核对段上的航班号，故联查 flightNumber。
            flightSchedule: {
              select: {
                departureTime: true,
                departureTz: true,
                flight: { select: { flightNumber: true } },
              },
            },
          },
        },
      },
    });
    let preciseIds = candidates.map((c) => c.id);
    if (query.travelFrom || query.travelTo) {
      preciseIds = filterOrderIdsByDepartDate(candidates, query.travelFrom, query.travelTo);
    }
    if (query.returnFrom || query.returnTo) {
      const returnMatched = new Set(
        filterOrderIdsByReturnDate(candidates, query.returnFrom, query.returnTo),
      );
      preciseIds = preciseIds.filter((id) => returnMatched.has(id));
    }
    if (query.flightDateFrom || query.flightDateTo) {
      const flightMatched = new Set(
        filterOrderIdsByFlightDate(
          candidates,
          query.flightDateFrom,
          query.flightDateTo,
          query.flightNumber,
        ),
      );
      preciseIds = preciseIds.filter((id) => flightMatched.has(id));
    }
    // 航班号 × 日期维度绑定（0831 票务反馈）：航班号与出行/返程日期同时给出时，航班号
    // 收口到**对应航段**——「出行日期+QH9588」=去程段就是 QH9588（岘港→澳门当天出发的单），
    // 而不是「订单里任何一段含 QH9588」（那会把当天出发、回程才坐 QH9588 的往返单全捞进来）。
    // 航班号单独使用时维持任一段命中（DB 粗筛即终态，不进本精筛块）。
    if (query.flightNumber?.trim() && (query.travelFrom || query.travelTo || query.returnFrom || query.returnTo)) {
      const legDims: Array<'outbound' | 'return'> = [];
      if (query.travelFrom || query.travelTo) legDims.push('outbound');
      if (query.returnFrom || query.returnTo) legDims.push('return');
      const legBound = new Set(
        filterOrderIdsByLegFlightNumber(candidates, query.flightNumber, legDims),
      );
      preciseIds = preciseIds.filter((id) => legBound.has(id));
    }
    where.id = { in: preciseIds };
  }

  return where;
}

export async function listOrders(svc: OrderService, query: ListOrdersQuery, requester: OrderRequester) {
  const where = await svc.resolveListOrdersWhere(query, requester);

  const [rows, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      include: {
        // 带上 fulfillment 任务(类型+状态)，前端据此派生「签证状态」列；
        // 再联查班次出发时间（轻量 select），用于派生订单级「出发日期」列（deriveOrderDepartDate）。
        items: {
          include: {
            fulfillmentTasks: { select: { type: true, status: true } },
            // 联查盖章酒店：列表「内容」列的住宿标签要显示**当前**酒店。此前列表不联查，
            // 序列化里 hotelName 恒为 null，前端只能退回到套餐行 metadata 里录单时的「指定酒店」
            // 留痕——换酒店之后标签永远不跟着走。randomTierPlaceholder 用于把占位酒店显示成
            // 「X星随机（待落位）」而不是当成一家真酒店。
            hotelRoomType: {
              select: { name: true, hotel: { select: { name: true, randomTierPlaceholder: true } } },
            },
            // 联查航班号（flight.flightNumber）——列表「出发日期」列旁的往返航班号展示要用它；
            // 此前只 select 了 departureTime/departureTz，序列化里的 flightNumber 恒为 null，
            // 前端 deriveFlightLegs 只能退化用正则从 description 里捞第一个航班号，往返单两条腿
            // 共用同一段批量建单 description，于是去程/回程两行都显示成了去程号（对比 getOrder，
            // 3618-3627 行早就带了这个 select）。
            flightSchedule: {
              select: {
                departureTime: true,
                departureTz: true,
                flight: { select: { flightNumber: true } },
              },
            },
          },
        },
        // 列表乘客窄 select：身份字段之外补齐每人子行的徽标位（自备签/单住/送签进度）
        // 与票号（pnr/eticketNumber）、子行身份补充（生日/国籍/护照有效期），
        // 仍不带护照照片等重字段。
        passengers: {
          select: {
            id: true,
            fullName: true,
            chineseName: true,
            gender: true,
            documentNumber: true,
            dateOfBirth: true,
            nationality: true,
            passportExpiry: true,
            visaExempt: true,
            singleRoom: true,
            visaSubmissionStatus: true,
            pnr: true,
            eticketNumber: true,
          },
        },
        // 按人份额（R1）：列表只读库，不顺手回填（回填在详情 / 导出 / 回填脚本）
        passengerShares: PASSENGER_SHARES_INCLUDE,
        agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
        user: { select: { id: true, displayName: true, email: true } },
        claimedBy: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  // 对外脱敏口径按请求者角色一次算好（列表所有行同角色），AGENT/CUSTOMER 剥离内部字段 + 逐项拆价。
  const serializeCtx = orderSerializeRoleCtx(requester.role);
  return {
    // 显式包一层箭头函数——serializeOrder 现在带一个可选的第二参数（ctx），直接把它当
    // Array.map 回调传会让 map 的 index 顶进 ctx 位置（number 不是合法 ctx，TS 会报错，
    // 运行时也会把 index 当 ctx.visaStayDaysById 用，产生诡异行为）。listOrders 未联查
    // bundle.items，没有 visaStayDaysById 可传，这里只传 order + 角色脱敏口径，用默认空表。
    orders: rows.map((order) => serializeOrder(order, serializeCtx)),
    pagination: { page: query.page, pageSize: query.pageSize, total },
  };
}

/**
 * 代理分销统计（仅含已付款订单）—— 按当前筛选条件在**全量**订单上聚合。
 *
 * 此前这张卡片在前端按「已加载的那一批订单」现算：列表一次只拉最新 200 单，于是
 * 「共 N 家代理 / 成交额前 2 家」算的其实是最近 200 单里的排名，最近一单稍早的代理直接
 * 从卡片和下拉里消失。真分页之后前端手上更没有全量数据，只能由后端聚合。
 *
 * 口径与卡片旧算法逐条对齐，不新开第三口径：
 *   · 只计已付款族 status ∈ {PAID, TICKETED, COMPLETED}（与列表卡片标题「仅含已付款订单」同义）；
 *   · 成交额 = Σ Order.total（订单总额，非人均、非结算价），保留两位小数；
 *   · 代理名 = 公司名优先、否则联系人名（与列表「代理机构」列同源）；
 *   · 直客 = Order.agentId 为空的单，单独一格。
 * 筛选 / RBAC / 精筛全部走 resolveListOrdersWhere —— 与列表同一批订单，卡片和列表不会打架。
 * 聚合走 groupBy + 一次代理名查询，不把订单全拉进内存。
 */
export async function getAgentStats(svc: OrderService, query: ListOrdersQuery, requester: OrderRequester): Promise<AgentStatsResult> {
  const where = await svc.resolveListOrdersWhere(query, requester);
  // 已付款族叠进 AND 而不是覆盖 where.status：用户同时筛了「待支付」时诚实返回空集，
  // 而不是让某一边静默失效。
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  const paidWhere: Prisma.OrderWhereInput = {
    ...where,
    AND: [...and, { status: { in: AGENT_STATS_PAID_STATUSES } }],
  };

  const grouped = await prisma.order.groupBy({
    by: ['agentId'],
    where: paidWhere,
    _count: { _all: true },
    _sum: { total: true },
  });

  const agentIds = grouped
    .map((g) => g.agentId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const agentRows = agentIds.length
    ? await prisma.agent.findMany({
        where: { id: { in: agentIds } },
        select: { id: true, companyName: true, contactName: true },
      })
    : [];
  const nameById = new Map(
    agentRows.map((a) => [
      a.id,
      a.companyName?.trim() || a.contactName?.trim() || AGENT_STATS_UNKNOWN_AGENT_LABEL,
    ]),
  );

  const directRow = grouped.find((g) => g.agentId === null);
  return {
    direct: {
      orders: directRow?._count._all ?? 0,
      revenueCny: round2(Number(directRow?._sum.total ?? 0)),
    },
    agents: grouped
      .filter((g): g is typeof g & { agentId: string } => typeof g.agentId === 'string')
      .map((g) => ({
        agentId: g.agentId,
        // 代理行被删/查不到时不静默丢掉这笔成交额（金额对不上比名字缺失更糟）。
        agentName: nameById.get(g.agentId) ?? AGENT_STATS_UNKNOWN_AGENT_LABEL,
        orders: g._count._all,
        revenueCny: round2(Number(g._sum.total ?? 0)),
      }))
      .sort((a, b) => b.revenueCny - a.revenueCny),
  };
}

// ════════════════════════════════════════════════════════════════════
// 详情
// ════════════════════════════════════════════════════════════════════
export async function getOrder(svc: OrderService, id: string, requester: OrderRequester) {
  const fetched = await prisma.order.findUnique({
    where: { id },
    include: {
      // 联查行程单渲染所需的产品信息（套餐订单「产品内容」板块用；不新增客户端往返）：
      //   hotelRoomType → 房型名 + 酒店中文名（HOTEL 行 或 BUNDLE 行盖章的 hotelRoomTypeId 均可命中；
      //     套餐订单没有独立的 HOTEL 行，酒店只盖章在 BUNDLE 行的 hotelRoomTypeId 上）。
      //   flightSchedule → 出发/到达时间 + 航班号/起降地（FLIGHT 行、含套餐关联的经济舱腿）。
      //   visa → 签证名/国家/单次最多停留天数（VISA 行 或 套餐通过 items JSON 描述，行本身仅在
      //     客户端提交独立 VISA 行时才带 visaId；套餐纯地面签证组件走 bundle.items 文本描述，见 serializeOrder）。
      //   transfer → 接送产品名。
      //   bundle → 套餐名 + 服务内容 + 组件明细（items）+ 按人定价配置 + 关联房型（BUNDLE 行「产品内容」卡片 v2 用）。
      //     不按 isActive 过滤 —— 套餐下架/软删后历史订单仍需正确渲染（Bundle? 关系本身是普通 FK join，
      //     不会因为关联行的其它字段值而不联查；isActive 只在下单校验时拦截新购，不影响历史订单读取）。
      items: {
        include: {
          hotelRoomType: {
            select: { name: true, hotel: { select: { name: true, randomTierPlaceholder: true } } },
          },
          flightSchedule: {
            select: {
              departureTime: true,
              arrivalTime: true,
              // 当地时区：行程单/订单详情的时刻必须按它折算，否则显示的是 UTC 分量
              departureTz: true,
              arrivalTz: true,
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
            },
          },
          visa: { select: { visaName: true, country: true, destinationCountry: true, stayDays: true } },
          transfer: { select: { name: true } },
          bundle: {
            select: {
              name: true,
              serviceNotes: true,
              items: true,
              infantPriceCny: true,
              childSeatDiscountCnyPerPerson: true,
              hotelRoomTypeId: true,
              hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
            },
          },
        },
      },
      passengers: true, // 含护照/签证/地址全部新字段
      // 按人份额（R1）：先读库；老单没有就在下面顺手回填一次
      passengerShares: PASSENGER_SHARES_INCLUDE,
      payments: true,
      refunds: true,
      statusEvents: { orderBy: { createdAt: 'asc' } },
      agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
      user: { select: { id: true, displayName: true, email: true } },
      claimedBy: { select: { id: true, displayName: true, email: true } },
      reminders: {
        orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
        include: { createdBy: { select: { id: true, displayName: true } } },
      },
    },
  });
  if (!fetched) throw new NotFoundError('订单不存在');
  await svc.assertCanView(fetched, requester);
  // 按人份额 lazy 回填（R1）：库里没有完整一套（老单 / 算法换版）→ 顺手落一遍再读回来；
  // 失败（撞锁 / 异常）不影响本次读，DTO 照旧派生并标 DERIVED。
  const [order] = await attachPersistedShares([fetched]);
  // 套餐 VISA 组件的「最多可停留天数」不在 bundle.items JSON 里（那只存 visaId），需按 visaId 批量查
  // Visa.stayDays（best-effort：查询失败/无签证组件时给空表，itineraryFieldsForItem 照常降级为 null）。
  const visaStayDaysById = await svc.loadBundleVisaStayDays(order.items);
  // 按角色一次算好脱敏口径：ADMIN/STAFF 看全量（含护照大图）；AGENT/CUSTOMER 剥离内部字段 + 逐项拆价
  // （护照大图同口径剥离——响应瘦身 + 少暴露 PII，与既有 includePassportPhotos 行为一致）。
  return serializeOrder(order, {
    visaStayDaysById,
    ...orderSerializeRoleCtx(requester.role),
  });
}

// ════════════════════════════════════════════════════════════════════
// 回收站：列出已软删订单 + 恢复（ADMIN + STAFF）
// ════════════════════════════════════════════════════════════════════
/**
 * 回收站列表：分页列出 deletedAt 非空的订单（按删除时间倒序）。
 *
 * 删除人（deletedBy）从 SOFT_DELETE_ORDER 审计取——每单取最近一条，关联 actor
 * 拿 displayName/email。审计写入是 fire-and-forget，可能缺失；取不到就置 null，不硬凑。
 * status 未被软删改动，故这里直接就是删除前的原状态。
 *
 * 仅 ADMIN 可看（与删除权限对称，STAFF 不行）。
 */
export async function listDeletedOrders(
  svc: OrderService,
  query: { page: number; pageSize: number; search?: string },
  requester: OrderRequester,
) {
  if (!actorCan(requester, 'orders.read_deleted')) {
    throw new ForbiddenError('仅内部员工可查看回收站');
  }
  const where: Prisma.OrderWhereInput = { deletedAt: { not: null } };
  // 搜索：与主列表同口径，复用 splitSearchTerms + buildSearchTermClause——
  // 分词（空格/英文逗号/中文逗号/顿号，上限 5 词）后词间 AND，每词 OR 匹配
  // 订单号/联系人/电话/备注六栏/乘客中英文名+护照号。回收站无自有可搜字段
  // （deletedBy 来自审计表另查，不在 Order 上），故字段集与主列表完全一致。
  // 只在分词非空时叠加 AND，避免默认路径的 where 形状变化（单测断言精确匹配）。
  if (query.search) {
    const termClauses = splitSearchTerms(query.search).map(buildSearchTermClause);
    if (termClauses.length > 0) where.AND = termClauses;
  }
  const [rows, total] = await prisma.$transaction([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        orderNumber: true,
        contactName: true,
        total: true,
        currency: true,
        status: true,
        deletedAt: true,
        // 只取姓名字段（不整对象）：回收站行展示用，供运营按乘客名找回误删单。
        passengers: { select: { fullName: true, chineseName: true } },
        // 派生「出发日期」列所需的最小字段（deriveOrderDepartDate 同口径，= 订单列表「出发日期」列）：
        // FLIGHT 行取班次出发时间、酒店行取入住日；恢复误删单前先看清是哪个团期。
        items: {
          select: {
            hotelCheckIn: true,
            flightSchedule: { select: { departureTime: true, departureTz: true } },
          },
        },
      },
      orderBy: { deletedAt: 'desc' },
      take: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  // 每单最近一条 SOFT_DELETE_ORDER 审计 → 删除人标签（缓存 actorLabel 优先，
  // 回退到关联 actor 的 displayName/email）。desc 排序后每单首条即最近。
  const orderIds = rows.map((o) => o.id);
  const deletedByMap = new Map<string, string>();
  if (orderIds.length > 0) {
    const audits = await prisma.auditLog.findMany({
      where: {
        action: 'SOFT_DELETE_ORDER',
        targetType: AuditTargetType.ORDER,
        targetId: { in: orderIds },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        targetId: true,
        actorLabel: true,
        actor: { select: { displayName: true, email: true } },
      },
    });
    for (const a of audits) {
      if (!a.targetId || deletedByMap.has(a.targetId)) continue;
      const label = a.actorLabel ?? a.actor?.displayName ?? a.actor?.email ?? null;
      if (label) deletedByMap.set(a.targetId, label);
    }
  }

  return {
    orders: rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.contactName,
      total: o.total.toString(),
      currency: o.currency,
      status: o.status,
      deletedAt: o.deletedAt,
      deletedBy: deletedByMap.get(o.id) ?? null,
      // 原出发日期（去程最早航段当地出发日 → 回退最早酒店入住日 → null；与订单列表「出发日期」同口径）：
      // 恢复误删单前先辨清是哪个团期。items 缺失（形状漂移）时安全落空为 null。
      departDate: deriveOrderDepartDate(o.items ?? []),
      // 乘客姓名（中文名优先，缺失回退证件姓名）：回收站行展示 + 前端搜索命中辅助定位。
      passengerNames: o.passengers.map((p) => p.chineseName?.trim() || p.fullName),
    })),
    pagination: { page: query.page, pageSize: query.pageSize, total },
  };
}

/**
 * 批量解析本单所有 BUNDLE 行关联套餐的 VISA 组件 stayDays（订单详情「产品内容」卡片「签证」板块用）。
 * bundle.items JSON 里的 VISA 组件只带 visaId（见 bundleItemSchema），stayDays 要另查 Visa 表。
 * 一次 findMany 覆盖本单所有套餐的所有 VISA 组件，避免逐行 N+1。查询失败不阻断订单详情渲染。
 */
export async function loadBundleVisaStayDays(svc: OrderService, items: ReadonlyArray<{ bundle?: { items: Prisma.JsonValue } | null }>): Promise<Map<string, number | null>> {
  const visaIds = new Set<string>();
  for (const i of items) {
    const bundleItems = i.bundle?.items;
    if (!Array.isArray(bundleItems)) continue;
    for (const b of bundleItems) {
      if (b == null || typeof b !== 'object') continue;
      const rec = b as { kind?: unknown; visaId?: unknown };
      if (rec.kind === 'VISA' && typeof rec.visaId === 'string' && rec.visaId) {
        visaIds.add(rec.visaId);
      }
    }
  }
  if (visaIds.size === 0) return new Map();
  try {
    const visas = await prisma.visa.findMany({
      where: { id: { in: [...visaIds] } },
      select: { id: true, stayDays: true },
    });
    return new Map(visas.map((v) => [v.id, v.stayDays]));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[orders] failed to load bundle visa stayDays for', [...visaIds], err);
    return new Map();
  }
}

// ════════════════════════════════════════════════════════════════════
// 公开订单查询（A4，免登录）
// ════════════════════════════════════════════════════════════════════
/**
 * 用 orderNumber + (phone 或 email) 匹配订单，命中返回脱敏视图，否则返回 null。
 * 匹配范围：订单游客联系人(guestPhone/guestEmail/contactPhone/contactEmail) 或
 * 归属用户(user.phone/user.email)。任一字段命中即可。
 * 安全：永不泄露内部备注/成本/代理/expectedAmount/PII；不命中统一返回 null（路由 → 404）。
 */
export async function lookupOrderPublic(svc: OrderService, query: PublicOrderLookupQuery): Promise<MaskedOrderView | null> {
  const order = await prisma.order.findUnique({
    where: { orderNumber: query.orderNumber },
    include: {
      items: { include: { flightSchedule: { select: { departureTime: true, departureTz: true } } } },
      passengers: { select: { fullName: true, firstName: true } },
      payments: { select: { status: true } },
      user: { select: { phone: true, email: true } },
    },
  });
  if (!order) return null;

  // 联系方式匹配（phone / email 任一）。比对时去空白；电话忽略大小写无意义但邮箱忽略大小写。
  const phone = query.phone?.trim();
  const email = query.email?.trim().toLowerCase();
  const orderPhones = [order.guestPhone, order.contactPhone, order.user?.phone]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim());
  const orderEmails = [order.guestEmail, order.contactEmail, order.user?.email]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim().toLowerCase());

  const phoneMatch = phone ? orderPhones.includes(phone) : false;
  const emailMatch = email ? orderEmails.includes(email) : false;
  if (!phoneMatch && !emailMatch) return null;

  return maskOrderForPublic(order);
}

/**
 * 客户上传付款凭证用的轻量校验 —— 与公开订单查询同一套防枚举门禁。
 *   orderNo + lookupKey 必须命中（lookupKey 任一匹配：手机号 / 邮箱 / 订单联系人姓氏）。
 * 命中返回订单 id + 应付尾款（amountCny 缺省时用作进账额）；不命中返回 null（路由 → 拒绝）。
 * 只读，绝不入账。
 */
export async function lookupOrderForReceiptUpload(svc: OrderService, orderNumber: string, lookupKey: string): Promise<{ orderId: string; balanceCny: number } | null> {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: { user: { select: { phone: true, email: true } } },
  });
  if (!order) return null;

  const key = lookupKey.trim();
  if (!key) return null;
  const keyLower = key.toLowerCase();

  const phones = [order.guestPhone, order.contactPhone, order.user?.phone]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim());
  const emails = [order.guestEmail, order.contactEmail, order.user?.email]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim().toLowerCase());
  // 姓氏匹配：联系人 / 游客姓名首段（与公开查单同口径），忽略大小写。
  // 只取首段（拉丁名首词 / 中文整名），不再接受单字符首字匹配——
  // 单字符的猜测空间太小，会削弱公开上传的第二因子强度。
  const names = [order.contactName, order.guestName]
    .filter((v): v is string => Boolean(v))
    .map((v) => v.trim());
  const lastNames = names.flatMap((n) => {
    const segs = n.split(/\s+/).filter(Boolean);
    return segs.length > 0 ? [segs[0].toLowerCase()] : [];
  });

  const matched =
    phones.includes(key) || emails.includes(keyLower) || lastNames.includes(keyLower);
  if (!matched) return null;

  // 清账口径：total + adjustmentCny − paidAmount − prepaymentOffset（与 serializeOrder.balanceDue 一字一致）。
  const balanceCny = round2(
    Number(order.total) + (order.adjustmentCny ?? 0) - Number(order.paidAmount) - Number(order.prepaymentOffset),
  );
  return { orderId: order.id, balanceCny: Math.max(0, balanceCny) };
}

/**
 * 电子行程单数据（前台客户下载 PDF 用；归属校验同 getOrder）。
 *
 * 状态闸：订单确认（付款）后才可下载 —— PAID / PROCESSING / TICKETED / COMPLETED /
 * CHANGE_REQUESTED / CHANGED；否则 409 ITINERARY_NOT_READY。
 * 无 FLIGHT 行（纯地面产品单）→ 409 NO_FLIGHT_ITEMS（与行程单邮件 no_flights 语义对齐）。
 */
export async function getOrderItineraryData(svc: OrderService, orderId: string, requester: OrderRequester): Promise<{ orderNumber: string; itinerary: ItineraryData }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { flightSchedule: { include: { flight: true } } } },
      passengers: true,
    },
  });
  if (!order) throw new NotFoundError('订单不存在');
  await svc.assertCanView(order, requester);

  if (!ITINERARY_READY_STATUSES.includes(order.status)) {
    throw new AppError('订单确认后可下载行程单', {
      statusCode: 409,
      code: 'ITINERARY_NOT_READY',
    });
  }

  const flightItems = order.items.filter((i) => i.kind === 'FLIGHT' && i.flightSchedule);
  if (flightItems.length === 0) {
    throw new AppError('该订单暂不支持生成行程单', {
      statusCode: 409,
      code: 'NO_FLIGHT_ITEMS',
    });
  }

  return {
    orderNumber: order.orderNumber,
    itinerary: {
      orderNumber: order.orderNumber,
      contactName: order.contactName,
      contactPhone: order.contactPhone,
      contactEmail: order.contactEmail,
      total: order.total.toFixed(2),
      // 应付 = total + adjustmentCny（改期费/换人费等售后调整），与订单详情「应收」/
      // effectivePayable 同口径 —— 行程单金额不能漏掉这块（itinerary-pdf.ts 里用它算应付）。
      adjustmentCny: Number(order.adjustmentCny ?? 0),
      currency: order.currency,
      createdAt: order.createdAt,
      flights: flightItems.map((i) => ({
        flightNumber: i.flightSchedule!.flight.flightNumber,
        origin: i.flightSchedule!.flight.originCode,
        destination: i.flightSchedule!.flight.destinationCode,
        departureTime: i.flightSchedule!.departureTime,
        arrivalTime: i.flightSchedule!.arrivalTime,
        departureTz: i.flightSchedule!.departureTz,
        arrivalTz: i.flightSchedule!.arrivalTz,
        cabin: i.flightCabin ?? 'ECONOMY',
      })),
      passengers: order.passengers.map((p) => ({
        fullName: p.fullName,
        passportNumber: p.documentNumber,
        pnr: p.pnr,
        eticketNumber: p.eticketNumber,
      })),
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// 权限校验
// ════════════════════════════════════════════════════════════════════
export async function assertCanView(
  svc: OrderService,
  order: { userId: string | null; agentId: string | null },
  requester: OrderRequester,
) {
  if (requester.role === 'ADMIN' || requester.role === 'STAFF') return;
  if (requester.role === 'CUSTOMER') {
    // 游客单（userId=null）无登录归属 → 普通客户不可通过此路径查看（走公开 lookup）
    if (!order.userId || order.userId !== requester.userId) throw new ForbiddenError('无权查看该订单');
    return;
  }
  if (requester.role === 'AGENT') {
    const ids = await svc.getDescendantAgentIds(requester.agentId);
    if (!order.agentId || !ids.includes(order.agentId)) {
      throw new ForbiddenError('无权查看该订单');
    }
  }
}

/**
 * 导出口径的代理可见集合：AGENT → 自己 + 全部下级代理 id（与 listOrders RBAC 同源）；
 * ADMIN/STAFF → null（不设限）。各导出路由拿它交给 applyExportAgentScope 叠 where，
 * 让「导出=列表所见」在代理视角同样成立。AGENT 无 agentId（脏账号）→ 空数组，fail-closed。
 */
export async function resolveExportAgentScope(svc: OrderService, requester: OrderRequester): Promise<string[] | null> {
  if (requester.role !== UserRole.AGENT) return null;
  return svc.getDescendantAgentIds(requester.agentId);
}

// 查自己 + 所有后代代理 id — 用 PostgreSQL 递归 CTE 一次查完
// 之前是按层 BFS 每层一次 findMany，代理树深就会放大 N 倍
export async function getDescendantAgentIds(svc: OrderService, agentId: string | undefined): Promise<string[]> {
  if (!agentId) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE agent_tree AS (
      SELECT id FROM "Agent" WHERE id = ${agentId}
      UNION ALL
      SELECT a.id FROM "Agent" a
      INNER JOIN agent_tree t ON a."parentAgentId" = t.id
    )
    SELECT id FROM agent_tree
  `;
  return rows.map((r) => r.id);
}

// ── Helpers ────────────────────────────────────────────────────────────

/** listOrders / 三模板导出共用的筛选字段（不含 RBAC / 接单 / 分页）。 */
export type OrderListFilters = Pick<
  ListOrdersQuery,
  | 'status'
  | 'agentId'
  | 'channel'
  | 'kind'
  | 'search'
  | 'from'
  | 'to'
  | 'travelFrom'
  | 'travelTo'
  | 'returnFrom'
  | 'returnTo'
  | 'flightDateFrom'
  | 'flightDateTo'
  | 'flightNumber'
  | 'passengerName'
  | 'recordedBy'
  | 'invoiceStatus'
  | 'invoiceLeg'
  | 'invoiced'
  | 'visaFulfillmentStatus'
  | 'visaRequirement'
  | 'tripType'
  | 'legFlag'
> & {
  /** 精确按班次过滤（整班·全岗导出用）；比 travelFrom/travelTo 更准，不受 ±1 天放宽影响。 */
  scheduleId?: string;
  /**
   * 勾选导出：给了非空数组就「只导这批订单」——以 id 集合为准，忽略其余筛选条件
   *（COUNTED_STATUSES 保护仍由各导出入口叠加）。仅导出路径设置，listOrders 不用。
   */
  orderIds?: string[];
};

/**
 * 下单时间（createdAt）筛选边界解析（公测反馈：需精确到几点几分统计当日进单）。
 * - 纯日期 YYYY-MM-DD：保持历史口径不变 —— from → 当日 00:00:00Z（gte）；to → 当日 23:59:59Z（lte）。
 * - 带时间 YYYY-MM-DDTHH:mm[:ss]（datetime-local 口径）：按录单人所见的北京时（+08:00）墙钟时刻精确
 *   卡界。列表「下单时间」列用浏览器本地时区（北京 +8）渲染 createdAt，故按 +08:00 解释输入才与所见
 *   一致；若按 UTC 解释会整体偏 8 小时。缺秒补 :00。
 */
export const BUSINESS_UTC_OFFSET = '+08:00';
export function resolveCreatedAtBoundary(value: string, edge: 'from' | 'to'): Date {
  if (value.includes('T')) {
    const withSeconds = /T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    return new Date(`${withSeconds}${BUSINESS_UTC_OFFSET}`);
  }
  return edge === 'from'
    ? new Date(`${value}T00:00:00Z`)
    : new Date(`${value}T23:59:59Z`);
}

// ── 搜索分词（多词 AND 匹配）────────────────────────────────────────
// 分隔符：空格（含全角/换行）、英文逗号、中文逗号、顿号 —— 覆盖录单员常见的姓名串写法。
export const SEARCH_TERM_SEPARATORS = /[\s,，、]+/;
// 词数上限（query.search 专用）：词间 AND 语义——每个词都会展开成一组跨表 OR 子查询，
// 词数不设限会被超长输入拖垮查询，故这里保持 5 不动。
export const MAX_SEARCH_TERMS = 5;
// 乘客姓名筛选专用上限（运营反馈：一次要贴一整团几十人的名单，5 个卡得太死）。
// 词间是 OR、且只在 passengers 一张表上 contains（不像 search 要跨表展开 AND），
// 放宽到 50 代价可控，覆盖绝大多数团组名单规模。
export const MAX_PASSENGER_NAME_TERMS = 50;

/**
 * 输入串 → 规整后的词列表（trim、去空词、截断到上限）。导出供单测使用。
 * @param limit 词数上限，默认 MAX_SEARCH_TERMS（5，query.search / recordedBy 用）；
 *   乘客姓名筛选传 MAX_PASSENGER_NAME_TERMS（50）。
 */
export function splitSearchTerms(search: string, limit: number = MAX_SEARCH_TERMS): string[] {
  return search
    .split(SEARCH_TERM_SEPARATORS)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, limit);
}

/**
 * 单个搜索词 → OR 匹配块。字段口径：
 * - 订单号 / 联系人 / 联系电话（历史字段，保持原语义）；
 * - 乘客中/英文名（公测反馈：搜索框要能按乘客姓名搜到订单）；
 * - 乘客护照号 documentNumber（运营需求：按证件号定位订单）；
 * - 订单级备注六栏 notes/internalNotes/noteHotel/noteVisa/notePayment/noteSpecial；
 * - 订单项名称 OrderItem.description（公测反馈：搜产品名/酒店名/签证名要能搜到订单）——
 *   运营记得住「客人买的是哪个产品」的次数，不比记得住订单号少；此前搜索只认订单号/人/备注，
 *   按产品名搜一律空手而归。与乘客子查询同构（items.some.description），词间 AND 语义不变。
 * 导出：主列表与回收站（listDeletedOrders）共用本口径，另供单测断言 where 形状。
 */
export function buildSearchTermClause(term: string): Prisma.OrderWhereInput {
  return {
    OR: [
      { orderNumber: { contains: term, mode: 'insensitive' } },
      { contactName: { contains: term, mode: 'insensitive' } },
      { contactPhone: { contains: term } },
      { notes: { contains: term, mode: 'insensitive' } },
      { internalNotes: { contains: term, mode: 'insensitive' } },
      { noteHotel: { contains: term, mode: 'insensitive' } },
      { noteVisa: { contains: term, mode: 'insensitive' } },
      { notePayment: { contains: term, mode: 'insensitive' } },
      { noteSpecial: { contains: term, mode: 'insensitive' } },
      {
        passengers: {
          some: {
            OR: [
              { fullName: { contains: term, mode: 'insensitive' } },
              { chineseName: { contains: term, mode: 'insensitive' } },
              { documentNumber: { contains: term, mode: 'insensitive' } },
            ],
          },
        },
      },
      // 产品名（航段/酒店/签证/套餐的行描述）——任一订单项命中即命中该订单。
      { items: { some: { description: { contains: term, mode: 'insensitive' } } } },
    ],
  };
}

/**
 * 游客单（userId=null，前台自助下单无录单账号）在「录入人员」口径下的统一标签。
 * 列表筛选与各导出的「录入人员」列共用本常量，避免两处各写各的字面量漂移。
 */
export const GUEST_RECORDED_BY_LABEL = '散客';

/**
 * 把「代理可见集合」叠进导出 where（AND agentId in）。
 * scope=null/undefined（ADMIN/STAFF 不设限）时原样返回；空数组=什么都看不到（fail-closed）。
 * 关键在勾选导出：buildOrderFilterWhere 的 orderIds 路径只按 id 圈单，本函数叠加后
 * 越权勾选的订单会被 AND 交集静默排除，而不是跟着 id 集合被带出去。
 */
export function applyExportAgentScope(
  where: Prisma.OrderWhereInput,
  agentScope: string[] | null | undefined,
): Prisma.OrderWhereInput {
  if (!agentScope) return where;
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  return { ...where, AND: [...and, { agentId: { in: agentScope } }] };
}

/**
 * 把列表/导出共用的筛选参数转成 Prisma where。
 * listOrders 与 orders.export-templates.ts 三模板导出共用，避免两处过滤逻辑漂移。
 * 注意：不含 RBAC（userId/可见代理集合）、claimedById/unclaimedOnly、分页 —— 由调用方叠加。
 *
 * @param options.includeAnchorless 仅导出路径传 true —— 出行日期筛选时把「一个日期锚点都没有
 *   **的签证单**」也召回（详见下方 travelFrom/travelTo 分支；空单/接送单/资料不全的机酒单
 *   不在豁免之列）。列表路径保持默认 false。
 */
/**
 * 代理视角的筛选净化：剥掉 `legFlag`（航段留痕四态）。
 *
 * legFlag 是**内部口径**的枚举（NO_SHOW / RETURN_RELEASED / RETURN_RESTORED / RETURN_VOIDED）。
 * serializeOrder 对代理已经把它连同行描述前缀一起脱敏掉了（见 orders.service 的 redact 分支），
 * 可它仍然是个**可筛的查询参数** —— 代理挨个枚举值筛一遍，就能从「哪些单出现在结果里」
 * 反推出每张单的内部航段状态，脱敏白做。
 *
 * 处置是**忽略这个键**（当成没传），不是报错：代理侧界面本来就不该出现这个筛选器，
 * 报 400 只会把「有人在探测」变成一条噪音告警，静默忽略等价于「这个维度对你不存在」。
 */
export function withoutAgentHiddenFilters<T extends OrderListFilters>(query: T): T {
  if (query.legFlag == null) return query;
  const next = { ...query };
  delete next.legFlag;
  return next;
}

export function buildOrderFilterWhere(
  query: OrderListFilters,
  options?: { includeAnchorless?: boolean },
): Prisma.OrderWhereInput {
  // 勾选导出：给了 orderIds 就以「勾选的 id 集合」为准，忽略其余筛选条件
  //（导出=用户勾了哪些就导哪些；不计数状态的 COUNTED_STATUSES 保护由各导出入口叠加）。
  // deletedAt: null —— 已软删的订单即便被显式勾中也不导出（从所有列表/导出里消失）。
  if (query.orderIds && query.orderIds.length > 0) {
    return { id: { in: query.orderIds }, deletedAt: null };
  }
  // 软删除排除：listOrders 与所有复用本 where 的导出（三模板 / 全岗总表）统一排除已删订单。
  // listOrders 会展示全部状态（含 CANCELLED/REFUNDED 等释放型），是唯一会「看见」已删订单的口径，
  // 故必须在此挂 deletedAt: null（各导出另叠 COUNTED_STATUSES，本就不含释放型，此处为对齐兜底）。
  const where: Prisma.OrderWhereInput = { deletedAt: null };
  // 多个 items 维度的筛选必须用 AND 叠加（每个 { items: { some } } 各自独立成立），
  // 否则直接赋值 where.items 会互相覆盖 —— 历史上 kind 与 travelFrom/travelTo 同时传时
  // 后者会清掉前者，造成漏单（结构性根因）。统一往 andClauses 里推。
  const andClauses: Prisma.OrderWhereInput[] = [];

  if (query.status) where.status = query.status;
  // 归属代理 / 渠道 —— 同一维度的粗细两档，同时给出时 agentId 优先（更细的那一档；
  //「某一家代理」本就是「代理单」的子集），故写成 if/else if 而不是两条独立的 if。
  //
  // ⚠️ channel 必须走 andClauses，不能直接赋值 where.agentId：listOrders 对 AGENT 角色会把
  // where.agentId 覆盖成 { in: 可见代理集合 }（RBAC 基准），若 channel 也写 where.agentId，
  // 两者互相覆盖 —— 代理请求 channel=direct 就会把 RBAC 那层打穿、看到全站直客单。
  // 放进 AND 后两个条件同时成立：代理 + 直客 = 空集（诚实地什么都没有），而不是越权。
  if (query.agentId) {
    where.agentId = query.agentId;
  } else if (query.channel === 'direct') {
    andClauses.push({ agentId: null });
  } else if (query.channel === 'agent') {
    andClauses.push({ agentId: { not: null } });
  }
  if (query.kind) andClauses.push({ items: { some: { kind: query.kind } } });
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: resolveCreatedAtBoundary(query.from, 'from') } : {}),
      ...(query.to ? { lte: resolveCreatedAtBoundary(query.to, 'to') } : {}),
    };
  }
  // 按出行日期筛选 — 跨 OrderItem 多种字段
  // FLIGHT: 取 schedule.departureTime；HOTEL: hotelCheckIn；其他暂时用 createdAt 兜底。
  // 出行日期存的是 UTC 时刻，而筛选用的是本地（出发地 +8）日期；UTC 与本地跨午夜会落到相邻日，
  // 直接按 [from 00:00Z, to 23:59Z] 卡会漏掉边界单。故把窗口各向外放宽一天做安全余量
  //（宁可多召回、不漏单 —— 与财务按出发地时区分桶同源的容忍口径）。
  if (query.travelFrom || query.travelTo) {
    const start = query.travelFrom
      ? new Date(new Date(`${query.travelFrom}T00:00:00Z`).getTime() - DAY_MS)
      : undefined;
    const end = query.travelTo
      ? new Date(new Date(`${query.travelTo}T23:59:59Z`).getTime() + DAY_MS)
      : undefined;
    const withinWindow = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {}),
    };
    const anchoredInWindow: Prisma.OrderWhereInput = {
      items: {
        some: {
          OR: [
            { flightSchedule: { departureTime: withinWindow } },
            { hotelCheckIn: withinWindow },
            // 签证行的「预计出行日期」—— 纯签证单（无航班、无住宿）唯一的日期锚点。
            // 缺了这一支，填了预计出行日期的签证单照样取不回来，
            // 与「出发日期」列的派生口径（deriveOrderDepartDate 第三级回退）也对不上。
            { visaIntendedDate: withinWindow },
          ],
        },
      },
    };
    // ── 无锚点**签证单**：仅导出路径召回 ────────────────────────────────────
    // 「锚点」= 能派生出整单出发日的字段，三选一：航段出发时间 / 酒店入住日 / 签证预计出行日期。
    // 一条锚点都没有的单（典型：还没填预计出行日期的纯签证单）在上面的 some 里必然落空。
    //   导出 —— 要召回：导出是「把这批单交出去办事」，静默漏掉等于签证岗整批看不到自己的单；
    //     召回后由 orders.export-depart-filter.ts 的内存过滤按同一口径兜底保留。
    //   列表 —— 不召回：列表的日期筛选是「找某天走的单」，无日期单若无条件保留就会出现在
    //     每一个日期区间里，筛选失效（口径详见 filterOrderIdsByDepartDate 注释）。
    //
    // 例外只给签证单（收窄，P1-7）：这条豁免的**理由**是「签证业务本身没有航班和住宿，
    // 没填预计出行日期就彻底无处归日」——只有涉签的单才配得上它。此前只判「一个日期锚点都没有」，
    // 于是空单、纯接送单、资料还没录全的机酒单也跟着被塞进每一个指定日期的导出里。
    // 涉签判定与签证任务锚点同源（VISA 行 → 含签证组件的 BUNDLE 行）：
    //   · VISA 行：items.some.kind = VISA；
    //   · 含签证组件的套餐行：Bundle.items（JSON 数组）含 { kind: 'VISA' } 组件，
    //     用 array_contains 走 Postgres jsonb 包含（部分匹配：组件的其余字段不影响命中）。
    const anchorlessVisaOnly: Prisma.OrderWhereInput = {
      AND: [
        {
          items: {
            none: {
              OR: [
                { flightScheduleId: { not: null } },
                { hotelCheckIn: { not: null } },
                { visaIntendedDate: { not: null } },
              ],
            },
          },
        },
        {
          items: {
            some: {
              OR: [
                { kind: OrderItemKind.VISA },
                {
                  kind: OrderItemKind.BUNDLE,
                  bundle: { items: { array_contains: [{ kind: 'VISA' }] } },
                },
              ],
            },
          },
        },
      ],
    };
    andClauses.push(
      options?.includeAnchorless ? { OR: [anchoredInWindow, anchorlessVisaOnly] } : anchoredInWindow,
    );
  }
  // 按返程日期筛选 — 两段式的 DB 粗窗口（精筛在 listOrders 里用 filterOrderIdsByReturnDate）。
  // 与出发日期同一套 ±1 天安全余量口径；但只看 FLIGHT 行的班次出发时间——返程日期没有酒店/签证
  // 兜底（只对「确实买了回程机票」的单有意义），粗窗口只需保证真正的回程腿落在窗口内的订单
  // 被召回即可，允许多召回去程腿恰好落在窗口内的单（JS 精筛会按 determineFlightLegItems 的
  // 第 2 段口径把它们筛掉）。
  if (query.returnFrom || query.returnTo) {
    const start = query.returnFrom
      ? new Date(new Date(`${query.returnFrom}T00:00:00Z`).getTime() - DAY_MS)
      : undefined;
    const end = query.returnTo
      ? new Date(new Date(`${query.returnTo}T23:59:59Z`).getTime() + DAY_MS)
      : undefined;
    andClauses.push({
      items: {
        some: {
          kind: OrderItemKind.FLIGHT,
          flightSchedule: {
            departureTime: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {}),
            },
          },
        },
      },
    });
  }
  // 精确按班次：订单需含该班次的 FLIGHT 行。整班·全岗导出专用——比 travelFrom/travelTo 精确，
  // 不受出行日期窗口 ±1 天放宽影响，保证只导该班次当天的订单。
  if (query.scheduleId) {
    andClauses.push({ items: { some: { flightScheduleId: query.scheduleId } } });
  }
  if (query.invoiceStatus) where.invoiceStatus = query.invoiceStatus;
  // 六态开票筛选（组合式）：invoiceLeg 指航段/系统维度，invoiced 指该维度已开(true)/未开(false)。
  // 二者需同时给出才生效——这正是票务岗「出行日期=7/10 + 去程未开 → 导出」的筛选路径。
  //   outbound → outboundInvoiced；return → returnInvoiced；system → systemInvoiced。
  if (query.invoiceLeg && query.invoiced !== undefined) {
    const col = (
      { outbound: 'outboundInvoiced', return: 'returnInvoiced', system: 'systemInvoiced' } as const
    )[query.invoiceLeg];
    where[col] = query.invoiced;
    // ── 航段守卫（B7）：航段维度只该捞「真有航段可开」的单 ──────────────────
    // outboundInvoiced / returnInvoiced 缺省就是 false，所以没有航段的单（酒店单/签证单）
    // 天然命中「未开」，会被一起捞进票务岗的开票清单 —— 它们根本没有票可开。
    // 三个渲染层（export-master / export-templates / 列表徽标）都按 determineFlightLegs 做了
    // 结构判定，唯独查询层裸奔：这是遗漏，不是设计。
    //   · outbound / return：要求本单至少有一条带班次的 FLIGHT 行。
    //   · system：**不加**守卫 —— 系统开票是订单维度、不是航段维度，酒店单/签证单本来就要
    //     系统开票，给它加守卫会错杀（假阴性比假阳性更糟：清单里少了单 = 真活丢了）。
    if (query.invoiceLeg === 'outbound' || query.invoiceLeg === 'return') {
      andClauses.push({
        items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } },
      });
    }
    // ── 单程单守卫：回程维度加挂物化列 hasReturnLeg ────────────────────────
    // 上面的航段守卫只能排除「一条航段都没有」的单，排不掉**单程单**——单程单有去程、无回程，
    // returnInvoiced 恒为 false，天然命中「回程未开」，但它压根没有回程票可开。
    // 判定回程要 determineFlightLegs（FLIGHT 行按 departureTime 升序取第 2 段），Prisma where
    // 表达不了「关联行 ≥ 2 条」，故物化成 Order.hasReturnLeg（建单/改期写路径同步维护）。
    // 导出路径的内存二次过滤（orders.export-trip-filter.ts 的 excludeOnewayFromReturnLegExport）
    // 保留不动，作为物化列失准时的双保险。
    if (query.invoiceLeg === 'return') {
      andClauses.push({ hasReturnLeg: true });
    }
  }
  // 行程类型筛选（单程/往返）—— 同样走物化列。
  //   roundtrip：有回程航段。
  //   oneway   ：无回程航段，且**必须有航段**（否则酒店单/签证单会被当成「单程」捞出来）。
  // 走 andClauses 而不是直接赋值 where.hasReturnLeg：与上面的回程守卫互不覆盖，
  // 「单程 + 回程未开」这种自相矛盾的组合会诚实地返回空集，而不是让某一边静默失效。
  if (query.tripType === 'roundtrip') {
    andClauses.push({ hasReturnLeg: true });
  } else if (query.tripType === 'oneway') {
    andClauses.push({ hasReturnLeg: false });
    andClauses.push({
      items: { some: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } } },
    });
  }
  // 签证办理状态筛选 — 与列表「签证」列徽标同源（签证办理履约任务 VISA_APPLICATION 的状态）。
  //   signed  ：订单存在「已确认(CONFIRMED)」的签证办理任务 = 已签证。
  //   unsigned：订单存在签证办理任务、但无任何「已确认」的（待处理/处理中/取消/失败）= 未签证。
  // 按履约任务判定、不限 item kind —— 签证任务常挂在 BUNDLE 行或首个订单项上（套餐订单没有
  // 独立 VISA 行），若强求 kind=VISA 会漏掉套餐签证单（signed/unsigned 双 0）。
  // 无任何签证办理任务的订单两者都不命中（列表徽标显示「—」），与徽标口径一致、不制造第三口径。
  // 走 andClauses 叠加，可与 kind / 出行日期 / 航班号等 items 维度组合而不互相覆盖。
  const HAS_VISA_TASK: Prisma.OrderWhereInput = {
    items: {
      some: {
        fulfillmentTasks: { some: { type: FulfillmentType.VISA_APPLICATION } },
      },
    },
  };
  const VISA_APPLICATION_CONFIRMED: Prisma.OrderWhereInput = {
    items: {
      some: {
        fulfillmentTasks: {
          some: { type: FulfillmentType.VISA_APPLICATION, status: FulfillmentStatus.CONFIRMED },
        },
      },
    },
  };
  if (query.visaFulfillmentStatus === 'signed') {
    andClauses.push(VISA_APPLICATION_CONFIRMED);
  } else if (query.visaFulfillmentStatus === 'unsigned') {
    andClauses.push({
      AND: [HAS_VISA_TASK, { NOT: VISA_APPLICATION_CONFIRMED }],
    });
  }
  // 签证录单要求筛选 — 这是订单级 Order.visaStatus 维度，与上面的履约办理进度互不替代。
  if (query.visaRequirement) {
    andClauses.push({ visaStatus: query.visaRequirement });
  }
  // 航段留痕四态筛选（no-show / 回程已释放 / 已恢复 / 已作废）—— 走物化列 Order.legFlag，
  // 派生规则见 syncOrderLegFlag。同样进 andClauses：可与出行日期、航班号等 items 维度自由组合。
  if (query.legFlag) {
    andClauses.push({ legFlag: query.legFlag as OrderLegFlag });
  }
  // 航班号 / 航班日期筛选 — 订单需含命中的 FLIGHT 行（同样走 AND 叠加，可与 kind/出行日期组合）。
  // 航班日期是**航段级**维度：该航段（不分去程/回程）的当地起飞日落在区间内；与航班号同时给出时
  // 两个条件落在**同一个 some 里 = 同一段**同时满足——这正是「某天的某一班」的语义。
  // 日期侧沿用 travelFrom/travelTo 的 ±1 天粗窗口（UTC 与当地日跨午夜防漏单），
  // 精筛在 listOrders 里用 filterOrderIdsByFlightDate 按 departureTz 折当地日收口。
  if (query.flightNumber || query.flightDateFrom || query.flightDateTo) {
    const scheduleWhere: Prisma.FlightScheduleWhereInput = {};
    if (query.flightNumber) {
      scheduleWhere.flight = {
        flightNumber: { equals: query.flightNumber, mode: 'insensitive' },
      };
    }
    if (query.flightDateFrom || query.flightDateTo) {
      const start = query.flightDateFrom
        ? new Date(new Date(`${query.flightDateFrom}T00:00:00Z`).getTime() - DAY_MS)
        : undefined;
      const end = query.flightDateTo
        ? new Date(new Date(`${query.flightDateTo}T23:59:59Z`).getTime() + DAY_MS)
        : undefined;
      scheduleWhere.departureTime = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {}),
      };
    }
    andClauses.push({
      items: {
        some: {
          kind: OrderItemKind.FLIGHT,
          flightSchedule: scheduleWhere,
        },
      },
    });
  }
  // 乘客姓名筛选（词内 OR）：拼音 fullName 与中文名 chineseName 任一命中即可（公测反馈：中文名搜不到）。
  // 多词间同样 OR（运营需求：姓名框填多个人名要把这些人的订单都列出来——"列出这些乘客的订单"而非
  // "同一订单里凑齐这些乘客"，故不复用 query.search 的词间 AND 语义）；任一乘客命中任一词即命中该订单。
  // 单词输入退化为原语义（fullName/chineseName 任一命中该词）。
  // 词数上限用 MAX_PASSENGER_NAME_TERMS（50）而非 search 的 5——运营反馈：一次要贴一整团
  // 几十人的名单，5 个名字卡不住整团人数；这里只在 passengers 一张表上 contains，代价可控。
  if (query.passengerName) {
    const terms = splitSearchTerms(query.passengerName, MAX_PASSENGER_NAME_TERMS);
    where.passengers = {
      some: {
        OR: terms.flatMap((term) => [
          { fullName: { contains: term, mode: 'insensitive' } },
          { chineseName: { contains: term, mode: 'insensitive' } },
        ]),
      },
    };
  }
  // 录入人员筛选（词间 OR）：匹配下单账号的显示名 / 邮箱 —— 与总表导出「录入人员」列同源，
  // 保证「列表筛到的 = 导出那列写的」。
  // 游客单（userId=null）没有录单账号，整类归到 GUEST_RECORDED_BY_LABEL（散客）：搜「散客」
  // 把这批单全捞出来，而不是拿客人自己的名字冒充录入人。
  // 走 andClauses 叠加，可与产品类型 / 出行日期 / 航班号等维度组合而不互相覆盖。
  if (query.recordedBy) {
    const terms = splitSearchTerms(query.recordedBy);
    andClauses.push({
      OR: terms.flatMap((term) => [
        { user: { displayName: { contains: term, mode: 'insensitive' as const } } },
        { user: { email: { contains: term, mode: 'insensitive' as const } } },
        // 「散客」是固定标签、不是库里的字段：词命中标签本身才把整批游客单纳入（含前缀输入「散」）。
        ...(GUEST_RECORDED_BY_LABEL.includes(term) ? [{ userId: null }] : []),
      ]),
    });
  }
  // 多词分词 AND 搜索（运营需求：一次输入多位乘客姓名要能定位同一订单）。
  // 每个词各自生成一个 OR 匹配块（订单号/联系人/电话/乘客名/护照号/各类备注），
  // 词与词之间 AND —— 两个词分别命中同单的两位乘客时该订单命中；单词输入 = 原语义 + 新增字段。
  // 走 andClauses 叠加，与 kind / 出行日期 / 航班号等维度组合互不覆盖。
  if (query.search) {
    for (const term of splitSearchTerms(query.search)) {
      andClauses.push(buildSearchTermClause(term));
    }
  }

  // 把所有 items 维度的子句一次性 AND 起来（kind / 出行日期 / 航班号可任意组合，互不覆盖）
  if (andClauses.length > 0) where.AND = andClauses;

  return where;
}

// 注意：list() 和 get() 的 passengers select 不同，所以 serialize 用宽松类型
// 只处理我们关心的 Decimal 字段 → string。其他字段原样透传。
export interface OrderLike {
  id: string;
  orderNumber: string;
  // 状态：serializeOrder 据此下发 allowedTransitions（状态机真源，前端不再手抄）。
  status: OrderStatus;
  subtotal: Prisma.Decimal;
  taxesAndFees: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  prepaymentOffset: Prisma.Decimal;
  // 售后费用（改期费/换人费等）累计额（CNY，整数）。Prisma 直接返回 number。
  adjustmentCny: number;
  items: Array<{ unitPrice: Prisma.Decimal; amount: Prisma.Decimal } & Record<string, unknown>>;
  // 可选嵌套代理（含余额 Decimal + 结算模式）；不同 include 下可能不带或带 null
  agent?: ({ prepaymentBalance?: Prisma.Decimal | null } & Record<string, unknown>) | null;
  // ── 对外脱敏（redactForExternal）会剥离的内部字段（均可选：不同 include/select 下形状不同）──
  //   内部备注 + 结构化四栏备注 + 出纳期望到账 + 售后审计流水 + 接单运营 + 运营待办。
  //   声明为可选是为了让 serializeOrder 能安全读取并按角色覆盖（listOrders/getOrder 都联查了这些）。
  internalNotes?: string | null;
  swapRefundedAt?: Date | null;
  swapFeeCny?: number | null;
  swapReplacementOrderNumber?: string | null;
  noteHotel?: string | null;
  noteVisa?: string | null;
  notePayment?: string | null;
  noteSpecial?: string | null;
  expectedAmountCny?: Prisma.Decimal | null;
  expectedAmountLocked?: boolean;
  // 代理自助改单窗口（agentSelfEdit）的判定位。列表与详情都是 include 全量标量，必然带上；
  // 声明为可选是为了兼容窄 select 的调用方（缺失时窗口 fail-closed，见 serializeOrder）。
  createdAt?: Date;
  deletedAt?: Date | null;
  outboundInvoiced?: boolean;
  returnInvoiced?: boolean;
  systemInvoiced?: boolean;
  settlementLocked?: boolean;
  settlementLockedAt?: Date | null;
  settlementLockedBy?: string | null;
  // 收款复核锁（出纳/财务对账后写保护）：锁定后禁止人工录新收款。
  paymentsLocked?: boolean;
  paymentsLockedAt?: Date | null;
  paymentsLockedBy?: string | null;
  // 收款记录（ORDER_FULL_INCLUDE 下 payments: true 时联查）；不同 include 下可能不带。
  // gatewayPayload 是内部原始载荷，serializeOrder 只透出安全字段 + 认款标注，绝不整段外泄。
  payments?: Array<{
    id: string;
    method: PaymentMethod;
    amount: Prisma.Decimal;
    status: PaymentStatus;
    proofUrl?: string | null;
    paidAt?: Date | null;
    verifiedAt?: Date | null;
    createdAt: Date;
    gatewayPayload?: Prisma.JsonValue;
  }>;
  refunds?: Array<{
    gatewayPayload?: Prisma.JsonValue;
  } & Record<string, unknown>>;
  adjustments?: Prisma.JsonValue;
  claimedById?: string | null;
  claimedBy?: Record<string, unknown> | null;
  reminders?: Array<Record<string, unknown>>;
  // 出行人（用于套餐行程单「人数」——按 passengerType 计数；不同 include 下 select 形状不同，
  // 如 listOrders 只 select id/fullName，无 passengerType 字段，故用 Record<string, unknown> 兜底，
  // 与本接口 items/agent 的处理方式一致）。
  passengers?: Array<Record<string, unknown>>;
  // 按人份额落库行（PASSENGER_SHARES_INCLUDE 下联查）；没联查 / 老单没回填时 serializeOrder 派生并标 DERIVED。
  passengerShares?: Array<PersistedShareLike> | null;
}

/**
 * 订单「出发日期」派生（列表列展示用；YYYY-MM-DD 或 null）。
 * 口径（三级回退，依次取第一个有值的）：
 *   1. 本单 FLIGHT 行里最早班次的当地出发日；
 *   2. 无航班的纯地面单 → 最早的酒店入住日；
 *   3. 既无航班也无酒店（纯签证单）→ 最早 VISA 行的「预计出行日期」visaIntendedDate。
 * 三级都没有 → null（前端显示「—」）。
 *
 * 第三级的由来（反馈：签证岗）：签证业务必有「预计出行日期」这个业务锚点，只是从前没有字段可落，
 * 于是纯签证单永远派生不出出发日、被带出发日期区间的导出静默漏掉。字段可空 —— 老数据和行程
 * 未定的单仍回落 null，行为与扩展前一致。
 *
 * 依赖已联查的行数据，不另发查询；未联查 flightSchedule（如扁平 items:true）时航班部分
 * 安全落空，按后两级回退。
 */
// 注：导出在文件末尾的 `export { createCommissionsForOrder, deriveOrderDepartDate }` 统一给出。
export function deriveOrderDepartDate(items: ReadonlyArray<Record<string, unknown>>): string | null {
  let earliestFlight: Date | null = null;
  // 最早那段航班的出发地时区——出发日要按它折，不是按 UTC（当地凌晨起飞的红眼班次
  // UTC 还停在前一天，按 UTC 算会把出发日期写早一天）。未联查 tz 时为 null → 回退 UTC。
  let earliestFlightTz: string | null = null;
  let earliestHotel: Date | null = null;
  let earliestVisa: Date | null = null;
  for (const i of items) {
    const schedule = i.flightSchedule as
      | { departureTime?: Date | string; departureTz?: string | null }
      | null
      | undefined;
    if (schedule?.departureTime) {
      const d = new Date(schedule.departureTime);
      if (!Number.isNaN(d.getTime()) && (earliestFlight === null || d < earliestFlight)) {
        earliestFlight = d;
        earliestFlightTz = schedule.departureTz ?? null;
      }
    }
    const checkIn = i.hotelCheckIn as Date | string | null | undefined;
    if (checkIn) {
      const d = new Date(checkIn);
      if (!Number.isNaN(d.getTime()) && (earliestHotel === null || d < earliestHotel)) {
        earliestHotel = d;
      }
    }
    // 签证行的「预计出行日期」——第三级回退用；只有前两级都落空时才会被采纳。
    const visaDate = i.visaIntendedDate as Date | string | null | undefined;
    if (visaDate) {
      const d = new Date(visaDate);
      if (!Number.isNaN(d.getTime()) && (earliestVisa === null || d < earliestVisa)) {
        earliestVisa = d;
      }
    }
  }
  // 航班优先按出发地当地日；回退到酒店入住日 / 签证预计出行日时用 UTC
  // （两者都是 @db.Date，存的就是 UTC 零点，再折时区反而会漂一天）
  if (earliestFlight) return formatDateOnly(earliestFlight, earliestFlightTz);
  if (earliestHotel) return formatDateOnly(earliestHotel);
  return earliestVisa ? formatDateOnly(earliestVisa) : null;
}

/**
 * 出行日期精确细筛：把「粗窗口候选订单」按整单出发日（deriveOrderDepartDate 同口径）精确
 * 过滤到 [travelFrom, travelTo] 内，返回命中的订单 id。
 * 口径复用 deriveOrderDepartDate（列表「出发日期」列同一函数）——保证「列表所见 = 筛选所得」。
 *   无出发日（航班/酒店/签证预计出行日三级全空）→ **不命中**；
 *   YYYY-MM-DD 字符串按字典序即日期序，可直接比较。
 * 两端半闭区间含边界（travelFrom/travelTo 各自可选）。导出供 listOrders 调用 + 单测。
 *
 * ⚠️ 与导出侧口径**故意不同**，别顺手统一：
 *   本函数（列表筛选）—— 无锚点单**排除**。列表的日期筛选是「找某天走的单」，一张没有任何
 *     日期的单若无条件保留，就会出现在**每一个**日期区间的结果里，等于筛选失效。
 *   filterExportOrdersByDepartDate（导出，见 orders.export-depart-filter.ts）—— 无锚点的
 *     **签证单**保留。导出是「把这批单交出去办事」，宁可多带一张也不能让签证岗的单整批消失；
 *     且与签证台看板（fulfillment.service 对纯签证单的保护）口径一致。豁免只给涉签单：
 *     空单/接送单/资料不全的机酒单没有「无处归日」这个理由，导出侧同样剔除。
 */
export function filterOrderIdsByDepartDate(
  candidates: ReadonlyArray<{ id: string; items: ReadonlyArray<Record<string, unknown>> }>,
  travelFrom?: string,
  travelTo?: string,
): string[] {
  const result: string[] = [];
  for (const o of candidates) {
    const departDate = deriveOrderDepartDate(o.items);
    if (departDate === null) continue;
    if (travelFrom && departDate < travelFrom) continue;
    if (travelTo && departDate > travelTo) continue;
    result.push(o.id);
  }
  return result;
}

/** deriveOrderReturnDate / filterOrderIdsByReturnDate 入参：determineFlightLegItems 的最小字段集，外加 departureTz。 */
export interface ReturnLegItem extends FlightLegItem {
  flightSchedule?: { departureTime: Date | string; departureTz?: string | null } | null;
}

/**
 * 订单「返程日期」派生（返程日期筛选用；YYYY-MM-DD 或 null）。
 * 口径与 deriveOrderDepartDate 同源但只认回程航段、无兜底：
 *   带班次的 FLIGHT 行按 departureTime 升序，第 2 段 = 回程（与 determineFlightLegItems /
 *   Order.hasReturnLeg 物化列同一判定），当地日期按该腿 departureTz 折算。
 * 单程单 / 纯地面单没有回程腿 → null —— **不像出发日期那样回落酒店入住日或签证预计出行日**：
 * 返程日期只对「确实买了回程机票」的订单有意义，没有回程票就没有「无处归日」这回事。
 */
export function deriveOrderReturnDate(items: ReadonlyArray<ReturnLegItem>): string | null {
  const { return: returnItem } = determineFlightLegItems(items);
  const schedule = returnItem?.flightSchedule;
  if (!schedule?.departureTime) return null;
  const d = new Date(schedule.departureTime);
  if (Number.isNaN(d.getTime())) return null;
  return formatDateOnly(d, schedule.departureTz ?? null);
}

/**
 * 返程日期精确细筛：把「粗窗口候选订单」（buildOrderFilterWhere 的 returnFrom/returnTo 分支，
 * 按 FLIGHT 行 departureTime ±1 天粗召回）按整单返程日（deriveOrderReturnDate 同口径）精确过滤到
 * [returnFrom, returnTo] 内，返回命中的订单 id。两端半闭区间含边界（returnFrom/returnTo 各自可选）。
 * 无回程腿的单（单程/纯地面/纯签证单）→ **不命中**：与出发日期筛选的「无锚点不命中」同一立场
 * ——筛选是「找某天回的单」，没有回程票的单填了返程筛选就该被筛掉，不该无条件出现在每个区间里。
 * 导出供 listOrders 调用 + 单测。
 */
export function filterOrderIdsByReturnDate(
  candidates: ReadonlyArray<{ id: string; items: ReadonlyArray<ReturnLegItem> }>,
  returnFrom?: string,
  returnTo?: string,
): string[] {
  const result: string[] = [];
  for (const o of candidates) {
    const returnDate = deriveOrderReturnDate(o.items);
    if (returnDate === null) continue;
    if (returnFrom && returnDate < returnFrom) continue;
    if (returnTo && returnDate > returnTo) continue;
    result.push(o.id);
  }
  return result;
}

/** filterOrderIdsByFlightDate 入参：航段行的最小字段集（班次出发时间 + 时区 + 航班号）。 */
export interface FlightDateItem {
  flightSchedule?: {
    departureTime: Date | string;
    departureTz?: string | null;
    flight?: { flightNumber?: string | null } | null;
  } | null;
}

/**
 * 航班日期精确细筛：把「粗窗口候选订单」（buildOrderFilterWhere 的 flightDateFrom/flightDateTo
 * 分支，按 FLIGHT 行 departureTime ±1 天粗召回）按**航段当地起飞日**精确过滤，返回命中的订单 id。
 * 这是航段级口径，与出行日期（整单去程日）/返程日期（整单回程日）不同：任一带班次的航段命中即可，
 * 不看它是第几段——「某天飞的这一班」既可能是别人的去程也可能是别人的回程。
 *   · flightNumber 给出时：**同一段**须同时满足「航班号相等（不区分大小写）+ 当地日在区间内」，
 *     与 buildOrderFilterWhere 把两个条件放进同一个 some 的语义一致（"9/3 的 QH9588"）。
 *   · 当地日按该段 departureTz 折算（formatDateOnly，与出发/返程精筛同一函数）；
 *   · 两端半闭区间含边界，单填一端即开区间；无任何带班次航段的单（纯地面/纯签证）不命中。
 * 导出供 listOrders 调用 + 单测。
 */
export function filterOrderIdsByFlightDate(
  candidates: ReadonlyArray<{ id: string; items: ReadonlyArray<FlightDateItem> }>,
  flightDateFrom?: string,
  flightDateTo?: string,
  flightNumber?: string,
): string[] {
  const wantedFlightNo = flightNumber?.trim().toLowerCase() || null;
  const result: string[] = [];
  for (const o of candidates) {
    const hit = o.items.some((i) => {
      const schedule = i.flightSchedule;
      if (!schedule?.departureTime) return false;
      if (
        wantedFlightNo &&
        (schedule.flight?.flightNumber ?? '').trim().toLowerCase() !== wantedFlightNo
      ) {
        return false;
      }
      const d = new Date(schedule.departureTime);
      if (Number.isNaN(d.getTime())) return false;
      const localDay = formatDateOnly(d, schedule.departureTz ?? null);
      if (!localDay) return false;
      if (flightDateFrom && localDay < flightDateFrom) return false;
      if (flightDateTo && localDay > flightDateTo) return false;
      return true;
    });
    if (hit) result.push(o.id);
  }
  return result;
}

/** filterOrderIdsByLegFlightNumber 入参：determineFlightLegItems 的最小字段集 + 段上的航班号。 */
export interface LegFlightNumberItem extends FlightLegItem {
  flightSchedule?: {
    departureTime: Date | string;
    flight?: { flightNumber?: string | null } | null;
  } | null;
}

/**
 * 航班号 × 日期维度绑定精筛（0831 票务反馈）：航班号与出行/返程日期筛选同时给出时，
 * 航班号收口到**对应航段**，而不是「订单里任何一段含该航班号」——
 *   · 出行日期在用（legs 含 'outbound'）：整单**去程段**（determineFlightLegItems 第 1 段，
 *     与列表出发日期列/hasReturnLeg 同一判定）的航班号须相等；
 *   · 返程日期在用（legs 含 'return'）：整单**回程段**（第 2 段）的航班号须相等；
 *   · 两个日期维度都在用：任一段命中即可（同一航班号不可能同时是去回两段，取 AND 恒空集）。
 * 没有这层绑定，「出行日期=8/31 + QH9588」会把 8/31 出发、回程才坐 QH9588 的往返单全部
 * 捞进来——用户要的其实是「8/31 当天坐 QH9588 出发的单」。航班号**单独**使用时不走本函数，
 * 维持任一段命中的宽口径。匹配不区分大小写、容忍首尾空格（与 DB 侧 insensitive 一致）。
 * 导出供 listOrders 与三模板导出（orders.export-templates.ts）共用 + 单测。
 */
export function filterOrderIdsByLegFlightNumber(
  candidates: ReadonlyArray<{ id: string; items: ReadonlyArray<LegFlightNumberItem> }>,
  flightNumber: string,
  legs: ReadonlyArray<'outbound' | 'return'>,
): string[] {
  const wanted = flightNumber.trim().toLowerCase();
  if (!wanted || legs.length === 0) return candidates.map((c) => c.id);
  const result: string[] = [];
  for (const o of candidates) {
    const legItems = determineFlightLegItems(o.items);
    const hit = legs.some((leg) => {
      const item = leg === 'outbound' ? legItems.outbound : legItems.return;
      const legFlightNo = item?.flightSchedule?.flight?.flightNumber ?? '';
      return legFlightNo.trim().toLowerCase() === wanted;
    });
    if (hit) result.push(o.id);
  }
  return result;
}

/** Prisma.Decimal | null | undefined → number | null（JSON 序列化前统一转换，未联查/未盖章时安全落 null）。 */
export function decimalOrNull(d: Prisma.Decimal | null | undefined): number | null {
  return d == null ? null : Number(d);
}

/** 套餐组件明细里的一条（Bundle.items JSON 元素；与 bundleItemSchema 对齐）。 */
export interface BundleItemEntry {
  kind?: unknown;
  productName?: unknown;
  qty?: unknown;
  transferId?: unknown;
  visaId?: unknown;
}

/**
 * BUNDLE 行「产品内容」卡片 v2 用的套餐组件派生字段（纯函数，供单测复用）：
 *   bundleKinds  — 该套餐 items 里实际存在哪些组件类型（FLIGHT/HOTEL/TRANSFER/VISA），
 *                  用于拼「往返机票+酒店+签证+接送机服务」这类产品名称。
 *   transfers    — TRANSFER 组件列表 [{name, qty(趟)}]（一个套餐可能配多条接送）。
 *   visa         — 第一个 VISA 组件 {name, stayDays}；name 用 productName（运营在套餐向导里填的
 *                  展示名，如「越南 E-visa 30 天 × 2 人」），productName 缺失时兜底为字面量「签证」；
 *                  stayDays 从 visaStayDaysById（按 visaId 查好的 Visa.stayDays）取，查不到落 null。
 * 容错：items 非数组/元素非对象/字段类型不对 → 跳过该条，不抛错（老数据/畸形 JSON 不阻断渲染）。
 */
export interface BundleItemsSummary {
  bundleKinds: Array<'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA'>;
  transfers: Array<{ name: string; qty: number }>;
  visa: { name: string; visaId: string; stayDays: number | null } | null;
}
export function summarizeBundleItems(
  bundleItems: unknown,
  visaStayDaysById: ReadonlyMap<string, number | null> = new Map(),
): BundleItemsSummary {
  const empty: BundleItemsSummary = { bundleKinds: [], transfers: [], visa: null };
  if (!Array.isArray(bundleItems)) return empty;

  const kindSet = new Set<string>();
  const transfers: Array<{ name: string; qty: number }> = [];
  let visa: BundleItemsSummary['visa'] = null;

  for (const raw of bundleItems as BundleItemEntry[]) {
    if (raw == null || typeof raw !== 'object') continue;
    const kind = raw.kind;
    if (kind !== 'FLIGHT' && kind !== 'HOTEL' && kind !== 'TRANSFER' && kind !== 'VISA') continue;
    kindSet.add(kind);
    const name = typeof raw.productName === 'string' && raw.productName.trim() ? raw.productName.trim() : null;
    if (kind === 'TRANSFER') {
      const qty = typeof raw.qty === 'number' && Number.isFinite(raw.qty) ? Math.trunc(raw.qty) : 1;
      transfers.push({ name: name ?? '接送服务', qty: Math.max(1, qty) });
    } else if (kind === 'VISA' && !visa) {
      // 只取第一个 VISA 组件（套餐目前按单一目的地/单一签证产品设计，多签证组件不是既有用例）
      const visaId = typeof raw.visaId === 'string' && raw.visaId ? raw.visaId : null;
      visa = {
        name: name ?? '签证',
        visaId: visaId ?? '',
        stayDays: visaId ? visaStayDaysById.get(visaId) ?? null : null,
      };
    }
  }

  return {
    bundleKinds: [...kindSet] as BundleItemsSummary['bundleKinds'],
    transfers,
    visa,
  };
}

/**
 * 单条订单行的行程单渲染字段（套餐订单详情「产品内容」板块用；ADDITIVE，不改/不删既有字段）。
 * FLIGHT 行 → 航班号/出发日期时间/到达时间/航线/舱位（来自 flightSchedule include）；
 * BUNDLE 行 → 套餐名/服务内容/组件构成/接送/签证（来自 bundle include，签证/接送来自套餐定义
 *   而非订单行——套餐订单通常只有机票腿 + 一条 BUNDLE 地面行，没有独立 VISA/TRANSFER 行）；
 * 三者关联的 VISA/TRANSFER 独立行（客户端提交时才会有）→ 签证/接送产品名称（保留，向后兼容）。
 * 未联查对应关系时（如 listOrders 用扁平 items:true）安全落 null，不强行断言非空。
 *
 * @param visaStayDaysById BUNDLE 行的 VISA 组件 stayDays 查询结果（getOrder 事先批量查好传入；
 *   其余调用方未传时用空表——套餐签证板块的 stayDays 会是 null，不影响其余字段。
 */
export function itineraryFieldsForItem(
  i: Record<string, unknown>,
  visaStayDaysById: ReadonlyMap<string, number | null> = new Map(),
): Record<string, unknown> {
  const flightSchedule = i.flightSchedule as
    | {
        departureTime?: Date | string;
        arrivalTime?: Date | string;
        // 当地时区：未联查时为 undefined，格式化会安全回退 UTC 分量（口径同改动前）。
        departureTz?: string | null;
        arrivalTz?: string | null;
        flight?: { flightNumber?: string; originCode?: string; destinationCode?: string } | null;
      }
    | null
    | undefined;
  const hotelRoomType = i.hotelRoomType as { name?: string | null } | null | undefined;
  const visa = i.visa as
    | { visaName?: string | null; country?: string | null; destinationCountry?: string | null; stayDays?: number | null }
    | null
    | undefined;
  const transfer = i.transfer as { name?: string | null } | null | undefined;
  const bundle = i.bundle as
    | {
        name?: string | null;
        serviceNotes?: string | null;
        items?: unknown;
        hotelRoomType?: { name?: string | null; hotel?: { name?: string | null } | null } | null;
      }
    | null
    | undefined;

  const departureTime = flightSchedule?.departureTime ? new Date(flightSchedule.departureTime) : null;
  const arrivalTime = flightSchedule?.arrivalTime ? new Date(flightSchedule.arrivalTime) : null;
  const bundleSummary = bundle ? summarizeBundleItems(bundle.items, visaStayDaysById) : null;

  return {
    // ── FLIGHT 行（含套餐关联的经济舱腿）──
    flightNumber: flightSchedule?.flight?.flightNumber ?? null,
    // 出发日/时刻按出发地时区折算；到达时刻按到达地时区（跨时区航段两头不同）。
    departureDate: departureTime ? formatDateOnly(departureTime, flightSchedule?.departureTz) : null,
    departureTime: departureTime ? formatHHMM(departureTime, flightSchedule?.departureTz) : null,
    arrivalTime: arrivalTime ? formatHHMM(arrivalTime, flightSchedule?.arrivalTz) : null,
    route:
      flightSchedule?.flight?.originCode && flightSchedule?.flight?.destinationCode
        ? `${flightSchedule.flight.originCode}→${flightSchedule.flight.destinationCode}`
        : null,
    cabin: (i.flightCabin as string | null | undefined) ?? null,
    // ── HOTEL 行 / BUNDLE 行盖章的酒店房型 ──
    roomTypeName: hotelRoomType?.name ?? null,
    // ── VISA 行（独立提交时）──
    visaName: visa?.visaName ?? null,
    visaCountry: visa?.country ?? visa?.destinationCountry ?? null,
    visaStayDays: visa?.stayDays ?? null,
    // ── TRANSFER 行（独立提交时）──
    transferProductName: transfer?.name ?? null,
    // ── BUNDLE 行 ──
    bundleName: bundle?.name ?? null,
    serviceNotes: bundle?.serviceNotes ?? null,
    // 套餐组件构成（该套餐 items 里实际有哪些类型）——「产品名称」自动拼装用
    bundleKinds: bundleSummary?.bundleKinds ?? null,
    // 套餐定义里的接送组件（来自套餐，不是订单行——套餐订单通常没有独立 TRANSFER 行）
    bundleTransfers: bundleSummary?.transfers ?? null,
    // 套餐定义里的签证组件（来自套餐，不是订单行；stayDays 由调用方批量查好传入）
    bundleVisa: bundleSummary?.visa ?? null,
    // 套餐关联房型的兜底酒店名/房型名——订单行自身未盖章 hotelRoomTypeId 时（老订单常见），
    // 从套餐定义本身的关联房型回落，而不是整段留空。
    bundleHotelName: bundle?.hotelRoomType?.hotel?.name ?? null,
    bundleRoomTypeName: bundle?.hotelRoomType?.name ?? null,
  };
}

/**
 * 订单级「按人头单价」派生（套餐订单详情「产品内容」卡片「人数」板块用）。
 * 由真实成交金额反推，不臆造数字——起点是 order.total（服务端权威重算后的实付总额，
 * 已含套餐折扣/升级加价等一切调整），按套餐的婴儿价/占座儿童折扣往回摊：
 *
 *   infantUnitPriceCny = bundle.infantPriceCny（套餐配置的婴儿价，直接展示，不参与摊分）
 *   childDiscount      = bundle.childSeatDiscountCnyPerPerson（占座儿童比成人价低多少）
 *   adultUnitPriceCny  = round( (total − infantCount×infantPrice + childCount×childDiscount)
 *                                 / max(1, adultCount+childCount) )
 *     —— 先把婴儿价从总额里减掉（婴儿不占座，价格与成人/儿童均摊池无关），
 *        儿童比成人少收的部分加回去（还原「儿童按成人价打折」之前的等效成人价基数），
 *        再按占座人数（成人+儿童）均摊，得到「等效成人单价」。
 *   childUnitPriceCny  = adultUnitPriceCny − childDiscount
 *
 * 仅在本单含 BUNDLE 行且能解析出该行关联套餐的定价配置时返回；非套餐订单 / 套餐已被删除
 * 查不到定价配置时返回 null（调用方按需省略该板块，不臆造）。
 */
export interface BundlePerAgeUnitPrices {
  infantUnitPriceCny: number;
  childUnitPriceCny: number;
  adultUnitPriceCny: number;
}
export function deriveBundlePerAgeUnitPrices(
  totalCny: number,
  counts: { adultCount: number; childCount: number; infantCount: number },
  bundlePricing: { infantPriceCny: number; childSeatDiscountCnyPerPerson: number },
): BundlePerAgeUnitPrices {
  const { adultCount, childCount, infantCount } = counts;
  const infantUnitPriceCny = bundlePricing.infantPriceCny;
  const childDiscount = bundlePricing.childSeatDiscountCnyPerPerson;
  const seatPax = Math.max(1, adultCount + childCount);
  const adultUnitPriceCny = round2(
    (totalCny - infantCount * infantUnitPriceCny + childCount * childDiscount) / seatPax,
  );
  const childUnitPriceCny = round2(adultUnitPriceCny - childDiscount);
  return { infantUnitPriceCny, childUnitPriceCny, adultUnitPriceCny };
}

/**
 * 从订单行数组里找第一条 BUNDLE 行关联的套餐定价配置（infantPriceCny / childSeatDiscountCnyPerPerson）。
 * 未联查 bundle（如 listOrders 用扁平 items:true）或本单无 BUNDLE 行 / 套餐已被删除 → 返回 null。
 */
export function findBundlePricingConfig(
  items: ReadonlyArray<Record<string, unknown>>,
): { infantPriceCny: number; childSeatDiscountCnyPerPerson: number } | null {
  for (const i of items) {
    if (i.kind !== 'BUNDLE') continue;
    const bundle = i.bundle as
      | { infantPriceCny?: number | null; childSeatDiscountCnyPerPerson?: number | null }
      | null
      | undefined;
    if (!bundle) continue;
    return {
      infantPriceCny: bundle.infantPriceCny ?? 0,
      childSeatDiscountCnyPerPerson: bundle.childSeatDiscountCnyPerPerson ?? 0,
    };
  }
  return null;
}

/**
 * 详情/自助补录共用的出行人序列化：默认剥离 passportPhotoUrl 大图（data-URL 可达 MB 级，
 * 会把订单详情响应撑爆，且是证件级敏感数据），以 hasPassportPhoto 布尔代替。
 * keepPhotoUrl=true 时才保留大图（后台订单详情的护照缩略图直接读该字段，剥掉会瞎）。
 * 窄 select（如 listOrders 只带 id/fullName）不含该字段 → 原样透传，不硬加布尔。
 */
export function serializePassengerRecord<P extends Record<string, unknown>>(
  p: P,
  opts: { keepPhotoUrl?: boolean } = {},
): Record<string, unknown> {
  if (!('passportPhotoUrl' in p)) return p;
  const hasPassportPhoto = p.passportPhotoUrl != null;
  if (opts.keepPhotoUrl) return { ...p, hasPassportPhoto };
  const { passportPhotoUrl: _stripped, ...rest } = p;
  return { ...rest, hasPassportPhoto };
}

/**
 * 对外脱敏（A15）会从订单行 metadata 剥离的「我方内部计价明细」键。
 * item.unitPrice / item.amount 已在 serializeOrder 里对外剥离，但 metadata 里还藏着逐座 / 逐加项的
 * 计价拆解（如 perSeatBreakdown[].unitPrice、addOns 的各项费率与小计、operationFee、折扣百分比）——
 * 代理凭此能反推我方成本与加价。对外角色一律剥掉这些**计价键**，保留非价格业务键
 *（goDate/returnDate/roomsNeeded/hotelNights/pax/adultCount/childCount/infantCount/selfProvidedVisa…
 * 代理要凭此替客人办事）。采用「剥离已知计价键」黑名单：新增业务键默认保留、不会被误删。
 */
export const REDACTED_ITEM_METADATA_KEYS: readonly string[] = [
  'perSeatBreakdown', // FLIGHT 逐座定价阶梯（含 unitPrice/bucket，能反推实时销量与档位价）
  'addOns', // BUNDLE 升级重算明细（含单房差/升舱/儿童折扣/婴儿价/自备签费率与各项小计、total）
  'designatedHotel', // BUNDLE 指定酒店加价明细（每人费率/小计，能反推我方与酒店的差价口径）
  'operationFee', // BUNDLE 每人操作费（perPaxCny/totalCny）
  'bundleDiscountPct', // BUNDLE 套餐折扣百分比
  'perNightCny', // 补收单房差每晚价（售后调价行）
  'expressTier', // VISA 加急档快照（含该档 surchargeCny，能反推我方加急加价口径）
  'unitPrice', // 任何行级单价明细
  // ── 售后会话 / 座位账快照（都带原价、取消政策报价、逐舱放座明细与内部操作人 id）──
  'noShow', // 去程 no-show 快照（内部操作人、乘客 id 名单、工单 id）
  'returnReleased', // 回程释放快照（原班次 id、逐舱放座明细、内部操作人）
  'returnRestored', // 回程恢复快照（超售座数 —— 我方库存口径，绝不外露）
  'returnVoidedFinal', // 回程过期作废快照
  'returnLegCancelled', // 取消航段快照（**含原价 originalAmountCny 与取消政策报价 policySnapshot**）
  'legActionLog', // 航段动作流水（内部操作人 id + 每次放/占几座 + 是否超售）
  // ── 取消航段手续费行上的内部标记（这条 FEE 行本身对外可见，但这几个键是我方内部口径）──
  'returnLegCancelFee', // 「这是取消航段手续费行」的内部标记
  'cancelledLeg', // 被取消的是去程还是回程（内部航段方向判定）
  'returnItemId', // 指向被作废的那条航段行 id（内部关联）
  'feeMode', // 手续费口径：按政策 / 手工核定 —— 让代理看见等于把议价空间摊开
  // ── 拆单留痕（都指向**另一张单**上的行，对外一律不认）────────────────────────
  'splitPairKey', // 住宿行劈半的配对键 = `<源行 id>:<拆单令牌>`：泄露源行 id 与内部拆单令牌
  'splitFromItemId', // 这条行是从哪条源行拆出来的（源行可能在代理看不见的另一张单上）
  // ── 换人重算结算价（SWAP_REPRICE 行）：整段是我方同业价口径 ──────────────────
  // 基准价 / 重取价 / 日历档次晚数与每人立减 —— 代理凭这几个数能把我方结算价日历反推出来。
  // 行金额本身对外仍可见（这笔钱确实调了他的应收），只是「这个价怎么来的」不外露。
  'basisCny', // 成交那天的日历每人价（差价基准）
  'oldShareCny', // 被换人换人前的每人份额
  'newSettlementCny', // 换人当天重取的日历每人价
  'calendarDetail', // 取价明细（档次/晚数/出发日/日历价/每人立减 或 逐航段每人价）
  'calendarSource', // 取自哪张日历表
  // 建单落在 SETTLEMENT 行上的日历基准戳：calendarPerPaxCny 是**未减立减**的同业挂牌价，
  // 露出去等于把我方 rate card 与这家代理的折扣幅度一并交出去（代理该看到的是自己的结算价，
  // 不是折前价）。settlementTotalCny 等既有键不在此列，维持现状。
  'calendarPerPaxCny',
  'calendarDiscountPerPaxCny',
  'calendarKey', // 成交那格的定价键（档次/晚数/出发日 或 逐航段航班号/出发日）
];
// ⚠ 这份名单只管**订单行 metadata**。换人预览（swapPreview）是另一回事，刻意不脱敏：
//    它回给代理的 basisCny / newSettlementCny / calendarSource 是**减完这家代理自己的立减之后**
//    的价，也就是这单他自己要付的结算价 —— 本来就该让他在换人前看见、据此决定换不换。
//    折前挂牌价（calendarPerPaxCny）与我方 rate card 仍只活在订单行 metadata 里，按上表剥掉。
// ⚠ 新增「会话 / 座位账快照」类 metadata 键（售后动作往行上落的留痕对象）必须来这里登记：
//    它们普遍带原价、成本、政策报价、班次 id 与内部操作人，随 `...i` 展开就会整段下发给代理。

/**
 * 对外脱敏：从订单行 metadata 剥离计价键，保留非价格业务键。
 * metadata 为空 / 非对象 → 原样返回（不强行造对象）。
 */
export function redactItemMetadataForExternal(metadata: unknown): unknown {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (REDACTED_ITEM_METADATA_KEYS.includes(key)) continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * 收款记录序列化：只透出安全字段 + 认款来源标注，绝不外泄 gatewayPayload 其余内容
 *（内部 confirmedBy / 原始网关载荷等一律不下发）。
 *
 * 认款标注（reconciled）判定：
 *   1) 新数据：gatewayPayload.source === 'reconciliation' → 直接取 receiptNo / externalTxnId。
 *   2) 旧数据兼容：gatewayPayload.note 以「对账认领 」开头 → 视为认款，并从 note 提取 receiptNo。
 * 其余（手工确认 / 网关到账）reconciled=false，前端标为「手工确认」。
 */
export const RECONCILE_NOTE_PREFIX = '对账认领 ';
export function serializePaymentRecord(p: NonNullable<OrderLike['payments']>[number]): {
  id: string;
  method: PaymentMethod;
  amount: string;
  status: PaymentStatus;
  proofUrl: string | null;
  paidAt: Date | null;
  createdAt: Date;
  reconciled: boolean;
  receiptNo: string | null;
  externalTxnId: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  transferredOut?: boolean;
  transferredIn?: boolean;
  transferredToOrderNumber?: string | null;
  transferredFromOrderNumber?: string | null;
} {
  const payload =
    p.gatewayPayload && typeof p.gatewayPayload === 'object' && !Array.isArray(p.gatewayPayload)
      ? (p.gatewayPayload as Record<string, unknown>)
      : null;
  let reconciled = false;
  let receiptNo: string | null = null;
  let externalTxnId: string | null = null;
  const transferredOut = payload?.transferredOut === true;
  const transferredIn = payload?.transferredIn === true;
  const transferredToOrderNumber =
    typeof payload?.transferredToOrderNumber === 'string' ? payload.transferredToOrderNumber : null;
  const transferredFromOrderNumber =
    typeof payload?.transferredFromOrderNumber === 'string' ? payload.transferredFromOrderNumber : null;
  if (payload) {
    if (payload.source === 'reconciliation') {
      reconciled = true;
      receiptNo = typeof payload.receiptNo === 'string' ? payload.receiptNo : null;
      externalTxnId = typeof payload.externalTxnId === 'string' ? payload.externalTxnId : null;
    } else if (typeof payload.note === 'string' && payload.note.startsWith(RECONCILE_NOTE_PREFIX)) {
      // 旧数据：来源信息只留在 note 里，尽力提取进账单号，无流水号。
      reconciled = true;
      receiptNo = payload.note.slice(RECONCILE_NOTE_PREFIX.length).trim() || null;
    }
  }
  return {
    id: p.id,
    method: p.method,
    amount: p.amount.toString(),
    status: p.status,
    proofUrl: p.proofUrl ?? null,
    paidAt: p.paidAt ?? null,
    createdAt: p.createdAt,
    reconciled,
    receiptNo,
    externalTxnId,
    // 到账双状态：财务核过流水才算 verified（认款/网关创建即核实；人工录入待财务核实）。
    verified: p.verifiedAt != null,
    verifiedAt: p.verifiedAt ?? null,
    ...(transferredOut
      ? { transferredOut: true, transferredToOrderNumber }
      : {}),
    ...(transferredIn
      ? { transferredIn: true, transferredFromOrderNumber }
      : {}),
  };
}

/** 退款记录仍按既有形状透传，但移除不应进入订单响应的内部操作人 id。 */
export function serializeRefundRecord<T extends { gatewayPayload?: Prisma.JsonValue }>(refund: T): T {
  const payload = refund.gatewayPayload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return refund;
  if (!Object.prototype.hasOwnProperty.call(payload, 'requestedBy')) return refund;
  const safePayload = Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== 'requestedBy'),
  );
  return { ...refund, gatewayPayload: safePayload as Prisma.JsonObject } as T;
}

/**
 * 按人份额 DTO（R1）：passengerShares[]（每位在单乘客一行）+ sharesSource（PERSISTED = 读库 / DERIVED = 现算）
 * + sharesExcludedCny（换人费等不摊条目）+ sharesComputedAt。
 * 读侧优先级在 resolvePassengerShares：库里完整一套 + 当前算法版本 → PERSISTED；否则派生。
 * 窄 select 拼不出算法输入（乘客没 id / 行没 kind）时整组不下发，前端按旧后端处理（自算）。
 */
function passengerSharesDto(order: OrderLike): {
  passengerShares?: Array<{
    passengerId: string;
    settlementCny: number;
    baseCny: number;
    adjustmentCny: number;
    visaCny: number;
    singleRoomDiffCny: number;
    discountCny: number;
  }>;
  sharesSource?: 'PERSISTED' | 'DERIVED';
  sharesExcludedCny?: number;
  sharesComputedAt?: Date | null;
} {
  const passengers = order.passengers;
  const items = order.items as ReadonlyArray<Record<string, unknown>>;
  const resolvable =
    Array.isArray(passengers) &&
    passengers.every((p) => typeof p.id === 'string') &&
    Array.isArray(items) &&
    items.every((it) => typeof it.id === 'string' && typeof it.kind === 'string');
  if (!resolvable) return {};
  const source: ShareSourceOrder & { passengerShares?: ReadonlyArray<PersistedShareLike> | null } = {
    total: order.total,
    adjustmentCny: order.adjustmentCny,
    adjustments: order.adjustments,
    passengers: passengers as unknown as ReadonlyArray<{ id: string; visaExempt?: boolean | null; singleRoom?: boolean | null }>,
    items: items as unknown as ShareSourceOrder['items'],
    passengerShares: order.passengerShares ?? null,
  };
  const resolved = resolvePassengerShares(source);
  return {
    passengerShares: source.passengers.flatMap((p) => {
      const r = resolved.rows.get(p.id);
      return r ? [r] : [];
    }),
    sharesSource: resolved.source,
    sharesExcludedCny: resolved.excludedCny,
    sharesComputedAt: resolved.computedAt,
  };
}

// 导出供单测直接验证脱敏口径（redactForExternal）；运行时仍由本模块内部各读取/流转处调用。
export function serializeOrder<T extends OrderLike>(
  order: T,
  ctx: {
    visaStayDaysById?: ReadonlyMap<string, number | null>;
    /**
     * 后台（ADMIN/STAFF）详情需要护照大图渲染缩略图；客户/代理侧剥离瘦身。
     * **缺省剥离（fail-closed）**：不传 ctx / 不显式置 true 的调用方一律拿不到 passportPhotoUrl，
     * 只拿到 hasPassportPhoto 布尔。要大图必须显式传 includePassportPhotos: true
     *（通常经 orderSerializeRoleCtx(role) 按角色推导，不要手写 true）。
     * 口径理由：护照大图是证件级敏感数据，新写的调用方漏传 ctx 时应当「少给」而非「多给」。
     */
    includePassportPhotos?: boolean;
    /**
     * 对外脱敏（A15）：AGENT / CUSTOMER 视角只该看到 产品名 / 航班号 / 接待服务标准 / 自己的结算价（订单总价）。
     * 置 true 时剥离「我方内部口径」——内部备注、结构化四栏、出纳期望到账、售后审计流水、接单运营、运营待办、
     * 代理预存余额、以及逐项拆价（item.unitPrice / item.amount）。缺省 false（ADMIN/STAFF 看全量，兼容既有调用方）。
     */
    redactForExternal?: boolean;
    /**
     * 请求者角色（由 orderSerializeRoleCtx 带上）。只用于「这个字段该给谁看」这类判断，
     * 目前仅代理自助改单窗口（agentSelfEdit）用它把客户视角整个略掉。缺省不传 = 照旧全给。
     */
    role?: UserRole;
  } = {},
) {
  const visaStayDaysById = ctx.visaStayDaysById ?? new Map<string, number | null>();
  // 对外脱敏开关：仅当显式传 true（AGENT/CUSTOMER 上下文）才剥离内部字段；缺省保留全量。
  const redact = ctx.redactForExternal === true;
  // 售后费用叠加后的口径（与 reports.service / reminders.rules / 财务导出全局清账公式一字一致）：
  //   effectivePayable = total + adjustmentCny（客户应付；含改期费/换人费等售后调整）
  //   balanceDue       = effectivePayable − paidAmount − prepaymentOffset（尾款；负数表示多付）
  //     · prepaymentOffset（代理预存抵扣）视同已付，必须一并扣减，否则详情尾款与报表/提醒/导出对不平。
  // 不改 total/subtotal（机票基础价不重算），只在结清口径上暴露派生值，前端统一用此尾款。
  // 两者都从 lib/order-money 取（审查根因 R2 的单一口径入口），本函数不再自己写 total + adjustmentCny。
  // adjustmentCny 原样透出给前端；totalNum 只喂套餐按人头单价派生（不参与应收/尾款）。
  const adjustmentCny = order.adjustmentCny ?? 0;
  const totalNum = Number(order.total.toString());
  const effectivePayable = payableCny(order);
  const balanceDue = balanceDueCny(order);
  // 按 passengerType 统计人数（订单详情行程单「人数」板块用；未 include passengers/无 passengerType
  // 字段时安全落 0，不强行断言——如 listOrders 的 passengers select 只带 id/fullName）。
  const passengerTypeOf = (p: Record<string, unknown>): string =>
    (p.passengerType as string | null | undefined) ?? 'ADULT';
  const adultCount = order.passengers?.filter((p) => passengerTypeOf(p) === 'ADULT').length ?? 0;
  const childCount = order.passengers?.filter((p) => passengerTypeOf(p) === 'CHILD').length ?? 0;
  const infantCount = order.passengers?.filter((p) => passengerTypeOf(p) === 'INFANT').length ?? 0;
  // 套餐订单按人头单价（仅本单含 BUNDLE 行且联查到套餐定价配置时才有；见 deriveBundlePerAgeUnitPrices）。
  const bundlePricing = findBundlePricingConfig(order.items);
  const perAgePrices = bundlePricing
    ? deriveBundlePerAgeUnitPrices(totalNum, { adultCount, childCount, infantCount }, bundlePricing)
    : null;
  return {
    ...order,
    subtotal: order.subtotal.toString(),
    taxesAndFees: order.taxesAndFees.toString(),
    discountTotal: order.discountTotal.toString(),
    total: order.total.toString(),
    paidAmount: order.paidAmount.toString(),
    prepaymentOffset: order.prepaymentOffset.toString(),
    swapRefundedAt: redact ? undefined : (order.swapRefundedAt ?? null),
    swapFeeCny: redact ? undefined : (order.swapFeeCny ?? null),
    swapReplacementOrderNumber: redact ? undefined : (order.swapReplacementOrderNumber ?? null),
    // 售后费用派生口径（前端用 effectivePayable / balanceDue 取代「total − paidAmount」）
    adjustmentCny,
    effectivePayable: effectivePayable.toString(),
    balanceDue: balanceDue.toString(),
    // 按人份额（R1）：内部角色下发；对外角色（AGENT/CUSTOMER）整组不带 —— 逐人拆价是我方内部口径。
    // 关系数组本身（...order 展开带进来的 passengerShares 原始行）一律覆盖掉，DTO 只认下面这组派生键。
    passengerShares: undefined,
    ...(redact ? {} : passengerSharesDto(order)),
    // 订单「出发日期」（列表列用；FLIGHT 最早班次当地出发日 → 回退最早酒店入住日 → null）
    departDate: deriveOrderDepartDate(order.items),
    // ── 状态机元数据（N8）：本单当前状态下的合法流转，直接取自后端权威 ALLOWED_TRANSITIONS。
    //    前端抽屉据此渲染「标准流转」按钮与「管理员强制」清单，不再自己抄一份状态机——
    //    抄的那份曾漂移（PAID/PROCESSING 少了 CHANGE_REQUESTED 等），把合法流转逼进 force 通道，
    //    污染成 FORCE_ORDER_STATUS + WARNING 审计记录，真正该警觉的强制被淹没。
    //    逐单下发（而非单独的 meta 接口）：天然跟随本单 status，不存在「元数据与单状态不同步」的窗口。
    allowedTransitions: ALLOWED_TRANSITIONS[order.status] ?? [],
    // ── 代理自助改单窗口（下单当天可自助改班次/签证状态/酒店/升舱，次日起走改单申请）──
    //    **所有角色都下发**：代理端据此显示/隐藏自助入口与倒计时，运营端也要一眼看出
    //    「这单代理现在还能不能自己改」，否则运营接到电话得自己心算下单日期。
    //    createdAt 缺失（窄 select 的调用方）时 fail-closed：按 1970 年的单算 → 窗口关闭，
    //    宁可少给一个自助入口，也不能凭一次漏 select 就把闸放开。
    //    **客户视角整个不下发**（键都不出现）：自助改单是代理与我方之间的业务口径，
    //    客户既没有这条通道，也不该从响应里读出「这单还能不能被改」这类我方内部时限。
    agentSelfEdit:
      ctx.role === UserRole.CUSTOMER
        ? undefined
        : computeAgentSelfEditWindow({
            createdAt: order.createdAt ?? new Date(0),
            status: order.status,
            deletedAt: order.deletedAt ?? null,
            outboundInvoiced: order.outboundInvoiced ?? false,
            returnInvoiced: order.returnInvoiced ?? false,
            systemInvoiced: order.systemInvoiced ?? false,
            settlementLocked: order.settlementLocked ?? false,
          }),
    // 出行人数（按 Passenger.passengerType 统计；套餐行程单「人数：成人 X · 儿童 X · 婴儿 X」用）
    adultCount,
    childCount,
    infantCount,
    // 套餐订单按人头单价（由 total 反推，非套餐订单/查不到套餐定价配置时为 null）。
    // 内部均摊口径，仅 ADMIN/STAFF 可见：客户/代理端页面不渲染它，响应体也不该带（redact 时置 null）。
    infantUnitPriceCny: redact ? null : (perAgePrices?.infantUnitPriceCny ?? null),
    childUnitPriceCny: redact ? null : (perAgePrices?.childUnitPriceCny ?? null),
    adultUnitPriceCny: redact ? null : (perAgePrices?.adultUnitPriceCny ?? null),
    // ── 对外脱敏（redact）：内部备注 / 结构化四栏 / 出纳期望到账 / 售后审计流水 / 接单运营 / 运营待办一律不下发。
    //    这些键都来自上面的 ...order 展开，这里放在其后按角色覆盖：置 undefined 时 JSON.stringify 会自动省略该键。
    //    保留订单级金额（total/subtotal/paidAmount/effectivePayable/balanceDue = 该角色自己的结算价）与出行人证件
    //    （代理要凭此替客人办事）；只剥离「我方内部口径」，不影响 ADMIN/STAFF（redact=false 时原样透传）。
    internalNotes: redact ? undefined : order.internalNotes,
    noteHotel: redact ? undefined : order.noteHotel,
    noteVisa: redact ? undefined : order.noteVisa,
    notePayment: redact ? undefined : order.notePayment,
    noteSpecial: redact ? undefined : order.noteSpecial,
    expectedAmountCny: redact ? undefined : order.expectedAmountCny,
    expectedAmountLocked: redact ? undefined : order.expectedAmountLocked,
    // 航段留痕物化列：NO_SHOW / RETURN_RELEASED / RETURN_RESTORED / 去程或回程 VOIDED 说的都是
    //「我方内部怎么处置的这段座位」，与行描述上的内部留痕前缀是同一类信息（那批前缀在下面的
    // items 分支已经剥掉了）。只留 legFlag 不剥 = 前缀白剥了，代理照样能从这个枚举反推出来。
    // 物化列本身只服务内部列表筛选与导出，对外角色（AGENT/CUSTOMER）一律不下发。
    // hasReturnLeg 是客户自己也知道的行程事实（买没买回程），照常透出，两者不是一回事。
    legFlag: redact ? undefined : (order as { legFlag?: unknown }).legFlag,
    settlementLocked: order.settlementLocked ?? false,
    // 锁定时间/操作人仅内部可见（对代理 redact），条件透传保持与 Prisma payload 类型兼容
    settlementLockedAt: redact ? undefined : (order.settlementLockedAt ?? null),
    settlementLockedBy: redact ? undefined : (order.settlementLockedBy ?? null),
    // 收款复核锁：锁状态是内部收款区功能，对外角色（AGENT/CUSTOMER）一律不下发（收款区本就不对外）。
    paymentsLocked: redact ? undefined : (order.paymentsLocked ?? false),
    paymentsLockedAt: redact ? undefined : (order.paymentsLockedAt ?? null),
    paymentsLockedBy: redact ? undefined : (order.paymentsLockedBy ?? null),
    // 收款记录：显式重映射，只透出安全字段 + 认款标注（reconciled/receiptNo/externalTxnId），
    // 剥掉 gatewayPayload 原始载荷（confirmedBy 等内部字段绝不外泄）。未联查 payments 时不加此键。
    ...(Array.isArray(order.payments)
      ? {
          payments: order.payments.map(serializePaymentRecord),
          // 未经财务核实的已收金额（正额 SUCCEEDED 且 verifiedAt 为空之和）。
          // 出票/推进终态前的界面提示据此显示「这单 ¥xxx 到账未经财务核实」；仅内部可见。
          ...(redact
            ? {}
            : {
                unverifiedPaidCny: round2(
                  order.payments
                    .filter((p) => p.status === PaymentStatus.SUCCEEDED && !p.verifiedAt && Number(p.amount) > 0)
                    .reduce((sum, p) => sum + Number(p.amount), 0),
                ),
              }),
        }
      : {}),
    adjustments: redact ? undefined : order.adjustments,
    claimedById: redact ? undefined : order.claimedById,
    claimedBy: redact ? undefined : order.claimedBy,
    reminders: redact ? [] : order.reminders,
    ...(Array.isArray(order.refunds)
      ? { refunds: order.refunds.map(serializeRefundRecord) }
      : {}),
    // 出行人：客户/代理侧剥离 passportPhotoUrl 大图（详情响应瘦身），以 hasPassportPhoto
    // 布尔代替；后台详情保留大图（订单抽屉护照缩略图依赖）。窄 select 无该字段时原样透传。
    passengers: (order.passengers ?? []).map((p) =>
      serializePassengerRecord(p, { keepPhotoUrl: ctx.includePassportPhotos === true }),
    ),
    // 暴露代理结算模式 + 余额（前端据 settlementMode=MONTHLY 把订单显示成「月结」而非「欠款」）
    agent:
      order.agent == null
        ? order.agent
        : {
            ...order.agent,
            // 对外脱敏：代理预存余额是我方内部结算口径，AGENT/CUSTOMER 不下发（保留结算模式等非金额字段）。
            prepaymentBalance: redact
              ? undefined
              : order.agent.prepaymentBalance == null
                ? null
                : order.agent.prepaymentBalance.toString(),
          },
    items: order.items.map((i) => {
      const bundleFallback = i.bundle as
        | { hotelRoomType?: { name?: string | null; hotel?: { name?: string | null } | null } | null }
        | null
        | undefined;
      // 权威酒店中文名：HOTEL 行或 BUNDLE 行（盖章 hotelRoomTypeId）联查 hotelRoomType.hotel.name 均可命中。
      // 不是所有调用方的 items include 都联查了 hotelRoomType（如 listOrders 用 items: true）——
      // 这里用可选链读取，未联查时安全落 null，不强行断言非空。
      // 订单行自身未盖章 hotelRoomTypeId 时（老订单常见，见 CLAUDE 里记录的"套餐没盖房型"数据问题），
      // 回落到套餐定义自己关联的房型，而不是整段留空。
      const ownHotel = (
        i as {
          hotelRoomType?: {
            name?: string | null;
            hotel?: { name?: string | null; randomTierPlaceholder?: number | null } | null;
          } | null;
        }
      ).hotelRoomType;
      // 房型挂在随机档占位酒店上 = 伪落位，业务上还没落到任何一家真酒店：
      // 酒店名显示成档次名（「四星随机」），房型留空，并单独暴露 hotelPendingTier 让前端标「待落位」。
      // 联查没带 randomTierPlaceholder（老调用方）时安全落 null，按真酒店显示，不误判。
      const hotelPendingTier = ownHotel?.hotel?.randomTierPlaceholder ?? null;
      const ownHotelName =
        hotelPendingTier != null
          ? randomStarTierLabel(hotelPendingTier)
          : (ownHotel?.hotel?.name ?? null);
      const ownRoomTypeName = hotelPendingTier != null ? null : (ownHotel?.name ?? null);
      return {
        ...i,
        hotelPendingTier,
        // 对外脱敏：逐项拆价（单价/小计）是我方内部口径，AGENT/CUSTOMER 只看订单总价，不下发行级金额。
        //   保留 kind / description / quantity / 行程信息（航班号、出发日期等）等非价格字段。
        unitPrice: redact ? undefined : i.unitPrice.toString(),
        amount: redact ? undefined : i.amount.toString(),
        // 对外脱敏：**我方真实进价**。这两个字段之前随 `...i` 整行展开一起下发了——
        // CUSTOMER/AGENT 调 GET /orders 就能在浏览器 Network 面板里逐行看到我们的成本，
        // 拿它和自己付的钱一减就是我方毛利。比行级售价泄露严重得多，必须一并抹掉。
        unitCostCny: redact ? undefined : (i as { unitCostCny?: unknown }).unitCostCny,
        totalCostCny: redact ? undefined : (i as { totalCostCny?: unknown }).totalCostCny,
        // 对外脱敏：metadata 里的计价明细（perSeatBreakdown[].unitPrice、addOns、operationFee、
        //   bundleDiscountPct…）同样是我方内部口径——剥离计价键，保留非价格业务键（内部角色原样透传）。
        ...(redact
          ? { metadata: redactItemMetadataForExternal((i as { metadata?: unknown }).metadata) }
          : {}),
        // 对外脱敏：行描述上的内部留痕前缀（【去程未登机】/【回程座位已释放】/【已取消去/回程】）
        //   是内部岗位的操作标记，代理与客户不该看到我们内部怎么标 —— 剥掉，内部角色原样保留。
        ...(redact && typeof (i as { description?: unknown }).description === 'string'
          ? {
              description: stripInternalLegPrefix(
                (i as { description?: unknown }).description as string,
              ),
            }
          : {}),
        // 对外中性航段状态：前缀剥掉、快照黑名单掉之后，被释放的回程行在前台只剩一个光杆名字
        //   （无班次 → 无日期无航班号），客人会以为系统坏了。这里补一个**枚举**让前端能落一句
        //   买家口吻的说明，不含任何内部动作/操作人/库存口径。
        //   内部角色不下发：他们有 legFlag 与行描述前缀，够用且更细。
        //   注意必须从原始行 i 派生 —— 上面的 metadata 脱敏已经把 noShow/returnReleased 等快照抹掉了。
        ...(redact
          ? (() => {
              const publicLegStatus = derivePublicLegStatus(i as unknown as LegStatusItemLike);
              return publicLegStatus ? { publicLegStatus } : {};
            })()
          : {}),
        // 未落位随机单还没落到具体酒店 → 用档次名（「四星随机」）当酒店名，让各处「住哪」
        // 一栏如实显示"买的是随机、待落位"，而不是空白（落位后本列被清空，自然回到真实酒店名）。
        hotelName:
          ownHotelName ??
          bundleFallback?.hotelRoomType?.hotel?.name ??
          ((i as { randomStarTier?: number | null }).randomStarTier != null
            ? randomStarTierLabel((i as { randomStarTier?: number | null }).randomStarTier!)
            : null),
        // 计费房间数（Decimal → number；未联查/未盖章时为 null，原样透出不强行转换）。
        roomsBilled: decimalOrNull((i as { roomsBilled?: Prisma.Decimal | null }).roomsBilled),
        // 行程单渲染字段（ADDITIVE；见 itineraryFieldsForItem 注释——未联查对应关系时安全落 null）。
        ...itineraryFieldsForItem(i, visaStayDaysById),
        // itineraryFieldsForItem 已经算了 roomTypeName（HOTEL/BUNDLE 行自身盖章的房型名）；
        // 这里只在它为空时才用套餐兜底房型名覆盖，放在展开之后确保生效（避免被 spread 顺序覆盖）。
        roomTypeName: ownRoomTypeName ?? bundleFallback?.hotelRoomType?.name ?? null,
      };
    }),
  };
}

/**
 * 按请求者角色推导 serializeOrder 的对外脱敏口径（A15）。
 *   - 内部角色（ADMIN / STAFF）：看全量（含护照大图、内部备注、逐项拆价、代理余额…）。
 *   - 对外角色（AGENT / CUSTOMER）：只看 产品名 / 航班号 / 接待服务标准 / 自己的结算价（订单总价），
 *     其余「我方内部口径」一律剥离（见 serializeOrder 的 redactForExternal）。
 * 供订单读取/流转的各调用处统一复用，避免各处重复写角色判断。
 */
export function orderSerializeRoleCtx(role: UserRole): {
  includePassportPhotos: boolean;
  redactForExternal: boolean;
  role: UserRole;
} {
  const isInternal = role === UserRole.ADMIN || role === UserRole.STAFF;
  // role 原样带上：个别字段（如代理自助改单窗口）是「给谁看」的问题，不是「脱不脱敏」能表达的。
  return { includePassportPhotos: isInternal, redactForExternal: !isInternal, role };
}

// ── 公开订单脱敏视图（A4）────────────────────────────────────────────
export interface MaskedOrderView {
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'NONE';
  createdAt: Date;
  total: string;
  items: Array<{
    kind: OrderItemKind;
    productName: string;
    quantity: number;
    amount: string;
    travelDate: string | null; // 出行/入住日期（仅日期，无时间）
    flightChanged: boolean; // 该航段是否发生过航变改班（前台标红提示「留意新起飞时间」）
    /** 对外中性航段状态（无状态时不带该键）；前端据此落一句买家口吻的说明。 */
    publicLegStatus?: PublicLegStatus;
  }>;
  passengers: Array<{ name: string }>; // 仅名（given name），姓氏脱敏
}

/**
 * 脱敏中文/英文姓名：只保留「名」，姓氏打码。
 *   "张三"   → "张*"     （中文：首字 + *）
 *   "李小明" → "李**"
 *   "WANG MEI" → "W** MEI"（拉丁：首字母 + ** + 其余）
 * 兜底：无法判断时保留首字符 + *。
 */
export function maskFamilyName(fullName: string): string {
  const name = (fullName ?? '').trim();
  if (!name) return '*';
  // 拉丁姓名（含空格）：第一段视为姓 → 首字母 + **，其余原样
  if (/\s/.test(name)) {
    const [family, ...rest] = name.split(/\s+/);
    const maskedFamily = family.length <= 1 ? `${family}*` : `${family[0]}${'*'.repeat(Math.min(family.length - 1, 2))}`;
    return [maskedFamily, ...rest].join(' ');
  }
  // 中文姓名：首字（姓）+ 其余打码
  if (name.length <= 1) return `${name}*`;
  return `${name[0]}${'*'.repeat(name.length - 1)}`;
}

export type OrderForMasking = Prisma.OrderGetPayload<{
  include: {
    items: { include: { flightSchedule: { select: { departureTime: true, departureTz: true } } } };
    passengers: { select: { fullName: true; firstName: true } };
    payments: { select: { status: true } };
  };
}>;

/** 把 order（含 items/passengers/payments）转脱敏视图，绝不带内部字段。 */
export function maskOrderForPublic(order: OrderForMasking): MaskedOrderView {
  // 取最近一笔成功支付；否则取任一支付状态；都没有 → NONE
  const succeeded = order.payments.some((p) => p.status === 'SUCCEEDED');
  const latest = order.payments[order.payments.length - 1];
  const paymentStatus: MaskedOrderView['paymentStatus'] = succeeded
    ? 'SUCCEEDED'
    : latest
      ? (latest.status as MaskedOrderView['paymentStatus'])
      : 'NONE';

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus,
    createdAt: order.createdAt,
    total: order.total.toString(),
    items: order.items.map((it) => {
      // 中性航段状态（口径与 serializeOrder 的对外分支一致）：无班次的航段行不至于变光杆。
      const publicLegStatus = derivePublicLegStatus(it as unknown as LegStatusItemLike);
      return {
        kind: it.kind,
        // 公开脱敏视图同样不露内部留痕前缀（口径与 serializeOrder 的对外分支一致）。
        productName: stripInternalLegPrefix(it.description),
        quantity: it.quantity,
        amount: it.amount.toString(),
        travelDate: maskedItemTravelDate(it),
        // 仅暴露「是否航变」这个客户可见事实布尔，不带任何内部班次 id/明细（脱敏口径）。
        flightChanged: hasFlightChanged((it as { metadata?: unknown }).metadata),
        ...(publicLegStatus ? { publicLegStatus } : {}),
      };
    }),
    passengers: order.passengers.map((p) => ({ name: maskFamilyName(p.fullName) })),
  };
}

/** 该订单行是否带「航变」标记（rescheduleOrderItem 换班次时落在 metadata.flightChanged）。 */
export function hasFlightChanged(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const mark = (metadata as { flightChanged?: unknown }).flightChanged;
  return Boolean(mark) && typeof mark === 'object';
}

/** 行的出行/入住日期（仅日期字符串）；HOTEL→入住日，FLIGHT→出发日，否则 null。 */
export function maskedItemTravelDate(it: {
  hotelCheckIn: Date | null;
  flightSchedule: { departureTime: Date; departureTz?: string | null } | null;
}): string | null {
  if (it.hotelCheckIn) return it.hotelCheckIn.toISOString().slice(0, 10);
  // 航班出发日按出发地当地日折算；未联查 tz 时回退 UTC 日（口径同改动前）
  if (it.flightSchedule) {
    return formatDateOnly(it.flightSchedule.departureTime, it.flightSchedule.departureTz);
  }
  return null;
}
