/**
 * 导出选单 —— 「按订单列表同款筛选选出这批要导出的订单」的唯一入口。
 *
 * 三模板导出（orders.export-templates.ts）与全岗总表（orders.export-master.ts）此前各写了
 * 一份选单逻辑：取数 where 一份、取回内存后的二次精筛一份。两份一旦分叉，症状就是
 * 「列表筛出 N 条、导出的表里不是这 N 条」——运营看不出哪张对，只能挨个数。
 * 本模块把两段都收成共享函数，两个导出共用，新增一个筛选维度只需在这里加一次。
 *
 * 两段式选单（沿用列表 listOrders 的同一套路，见 orders.service.ts）：
 *
 *   1. 取数 where（buildExportOrderWhere）—— Prisma 能表达的部分。
 *      出行/返程/航班日期在 DB 侧只做 ±1 天粗窗口（UTC 与当地日跨午夜防漏单），
 *      故意宽召回。另叠加：
 *        · includeAnchorless —— 导出独有：一个日期锚点都没有的**签证单**也取回
 *          （纯签证单不能因为没填预计出行日期就整批从岗位手上消失）；
 *        · 状态闸 —— 按 scope 二选一：缺省 active 走 EXPORT_COUNTED_STATUSES（排除已取消/
 *          超时/失败/退款类），released 走 EXPORT_RELEASED_STATUSES（只导这批，独立入口用）；
 *          勾选导出不叠状态闸（详见 applyExportStatusScope）；
 *        · agentScope —— 代理只导自己 + 下级（AND 交集，勾选导出同受此闸）。
 *
 *   2. 内存精筛（filterExportOrders）—— Prisma where 表达不了的部分：
 *      整单出发日/返程日、航段当地起飞日、航班号×日期绑定、单程/往返（要「关联行 ≥ 2 条」）。
 *      各分支的口径注释在各自的实现文件里，本模块只负责按正确顺序串起来。
 *
 * 两个短路口径原样保留，不能顺手统一：
 *   · orderIds（勾选导出）—— 用户勾了哪些就导哪些，取数与精筛全部短路，状态闸也不叠；
 *   · scheduleId（整班·全岗精确导出）—— 取数已按班次精确圈定，日期类精筛不适用，
 *     但单程/往返筛选照常生效（它与班次无关）。
 */
import { OrderStatus, Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import {
  applyExportAgentScope,
  buildOrderFilterWhere,
  filterOrderIdsByFlightDate,
  filterOrderIdsByLegFlightNumber,
  filterOrderIdsByReturnDate,
  withoutAgentHiddenFilters,
  type OrderListFilters,
} from './orders.service.js';
import { filterExportOrdersByDepartDate } from './orders.export-depart-filter.js';
import {
  excludeOnewayFromReturnLegExport,
  filterExportOrdersByTripType,
} from './orders.export-trip-filter.js';

/**
 * 运营导出有效订单：所有仍占座、应出行的状态。
 * 退款申请中/已退款/已取消/超时/失败已释放库存，不计入任何导出。
 * 三模板与全岗总表共用同一份 —— 各写一份的话，「这张表有这单、那张表没有」将无从解释。
 */
export const EXPORT_COUNTED_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/**
 * 已释放座位的订单：已取消 / 退款申请中 / 已退款 / 支付超时 / 失败。
 *
 * 主导出（scope=active）一条都不导，这是有意的：名单、送签、分房这些表是拿去办事的，
 * 混进取消单会照着做无用功。但运营确实要单独把这批单捞出来对账，故给一个**独立入口**
 *（scope=released），而不是把它们塞回主导出——两边口径互不影响。
 *
 * DRAFT 不在内：草稿单从来没占过座、也没成过单，不属于「取消/退款」这件事。
 */
export const EXPORT_RELEASED_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUND_REQUESTED,
  OrderStatus.REFUNDED,
  OrderStatus.PAYMENT_TIMEOUT,
  OrderStatus.FAILED,
];

/**
 * 导出范围：active=有效单（缺省，即现状）；released=已取消/退款类单（独立入口）。
 * 只切换状态集合这一条，日期/代理/渠道/勾选等其余筛选两种范围下完全一致。
 */
export type ExportScope = 'active' | 'released';

/** 选单用到的筛选字段：列表同款筛选 + 勾选导出 / 整班导出两个短路开关 + 导出范围。*/
export type ExportSelectionFilters = OrderListFilters & {
  scope?: ExportScope;
  /**
   * 导出口径标记：'ticketing' = 票务模板（orders.export-templates.ts 的 template='ticketing'，
   * 或全岗总表 role='ticketing' 由调用方换算成同一个标记，见 orders.export-master.ts）。
   * 仅供 applyExportStatusScope 判断"勾选导出（orderIds）时是否仍要剔除已取消/退款单"——
   * 开票表混进这类单没有业务意义，不属于"用户勾了就该原样出现"的范畴（详见该函数注释）。
   * full/visa 模板与全岗总表 role=all 不传本字段，行为与改动前一致（勾选导出不叠状态闸）。
   */
  template?: 'full' | 'ticketing' | 'visa';
};

/**
 * 取数 where：列表同款筛选 + 无锚点签证单召回 + 有效状态 + 代理可见集合。
 *
 * @param query           列表同款筛选（含 orderIds / scheduleId 两个导出专用短路）
 * @param opts.agentScope 代理可见集合（AGENT=自己+下级；ADMIN/STAFF=null 不设限）。
 *                        由路由从登录身份解析，**绝不从 query 读**——query 是客户端可控的。
 * @param opts.extraAnd   各导出自己的附加条件（如票务模板「只导含机票的订单」）
 */
export function buildExportOrderWhere(
  query: ExportSelectionFilters,
  opts?: { agentScope?: string[] | null; extraAnd?: Prisma.OrderWhereInput[] },
): Prisma.OrderWhereInput {
  // agentScope 非空 = 代理在导自己的单 → 剥掉 legFlag 筛选：那是内部航段口径的枚举，
  // 能筛就能从「哪些单出现在结果里」反推出每张单的内部状态（详见 withoutAgentHiddenFilters）。
  // 与列表 resolveListOrdersWhere 同一句口径，两边不分叉。
  const effectiveQuery = opts?.agentScope != null ? withoutAgentHiddenFilters(query) : query;
  const where = buildOrderFilterWhere(effectiveQuery, { includeAnchorless: true });
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  applyExportStatusScope(where, and, query);
  if (opts?.extraAnd?.length) and.push(...opts.extraAnd);
  where.AND = and;
  return applyExportAgentScope(where, opts?.agentScope);
}

/**
 * 状态闸：按导出范围决定这次导哪一组状态。三条互斥的路，都写在这一处。
 *
 * 1) 勾选导出（orderIds）—— 默认**不叠任何状态闸**：勾了哪些就导哪些。
 *    此前这里照叠 COUNTED_STATUSES，于是运营勾了几张已取消单点导出，那几行**静默消失**，
 *    表里既没有行也没有提示，只能挨个数才发现少了。软删仍然不导（buildOrderFilterWhere
 *    的 orderIds 短路里就带着 deletedAt: null），那是「这单已经不存在」，与状态无关。
 *    例外：票务口径（query.template === 'ticketing'）—— 开票表混进已取消/退款单没有任何
 *    业务意义（票都不用开了），这不算"用户勾了就该出现"，故仍剔除 EXPORT_RELEASED_STATUSES。
 *    为了不再"静默"：调用方（orders.routes.ts）会把被剔掉的张数放进响应头
 *    X-Export-Skipped-Cancelled 告知运营，而不是像旧版那样悄悄少几行。full/visa 模板、
 *    全岗总表 role=all 不传 template，行为不变。
 * 2) scope=released —— 已取消/退款类单的独立入口。
 *    query.status 明确给了且本就属于该集合（例：只要「已退款」）→ 收窄到那一个状态；
 *    否则按整组释放型状态导。后一支要连 where.status 一起清掉：占座类状态（例「已出票」）
 *    与本范围天然矛盾，留着它会 AND 成空表，运营拿到一张没有行、也没有原因的表。
 *    调用方（运营后台）在按钮上已把这种矛盾拦掉，这里是服务端兜底。
 * 3) 缺省 scope=active —— 现状：只导仍占座的有效单。
 */
function applyExportStatusScope(
  where: Prisma.OrderWhereInput,
  and: Prisma.OrderWhereInput[],
  query: ExportSelectionFilters,
): void {
  if (query.orderIds && query.orderIds.length > 0) {
    // 票务口径例外：勾选导出也剔除已取消/退款类单（见函数头注释 1)）。
    if (query.template === 'ticketing') {
      and.push({ status: { notIn: EXPORT_RELEASED_STATUSES } });
    }
    return;
  }

  if (query.scope === 'released') {
    const pickedOne =
      query.status && EXPORT_RELEASED_STATUSES.includes(query.status) ? query.status : null;
    if (!pickedOne) delete where.status; // 与本范围矛盾的占座类状态筛选，清掉而不是 AND 成空表
    and.push({ status: { in: pickedOne ? [pickedOne] : EXPORT_RELEASED_STATUSES } });
    return;
  }

  and.push({ status: { in: EXPORT_COUNTED_STATUSES } });
}

/**
 * 票务口径下，勾选导出（orderIds）里有多少张因「已取消/退款类」被剔除——供路由把这个数字
 * 放进响应头 X-Export-Skipped-Cancelled，告知运营「剔了几张」而不是让表悄悄变短。
 *
 * 非票务口径（template 不是 'ticketing'，或没勾选 orderIds）恒为 0——那些模板/入口现状
 * 不变，不剔单，也没有"被剔掉"这件事。
 */
export async function countExportSkippedCancelled(
  query: ExportSelectionFilters,
  client: PrismaClient = defaultPrisma,
): Promise<number> {
  if (query.template !== 'ticketing') return 0;
  if (!query.orderIds || query.orderIds.length === 0) return 0;
  return client.order.count({
    where: { id: { in: query.orderIds }, status: { in: EXPORT_RELEASED_STATUSES } },
  });
}

/**
 * 精筛入参的最小形状：带 id 与 items 的订单。
 * items 的具体字段要求由各 filterOrderIdsBy* / filterExportOrdersBy* 自己声明；
 * 各导出的 include 均已满足，这里不再重复一遍长长的结构类型。
 */
interface SelectableOrder {
  id: string;
  items: unknown;
}

/** 内部窄化：把 items 交给下游按各自的最小字段集判读（形状由取数 include 保证）。*/
type ItemsBearing = { id: string; items: ReadonlyArray<never> };

/**
 * 内存精筛：把粗召回的订单收窄到「与列表筛选完全一致」的那一批。
 *
 * 顺序 = listOrders 精筛块的顺序，逐条对应（改这里请同步改那边，两处口径必须一致）：
 *   出行日期 → 返程日期 → 航班日期 → 航班号×日期绑定 → 回程维度排单程 → 单程/往返。
 * 与列表的唯一差别在第一步：导出保留「无锚点的签证单」（filterExportOrdersByDepartDate），
 * 列表一律剔除（filterOrderIdsByDepartDate）——理由见那两个函数的注释。
 */
export function filterExportOrders<T extends SelectableOrder>(
  orders: readonly T[],
  query: ExportSelectionFilters,
): T[] {
  // 勾选导出：用户勾了哪些就导哪些，一步都不再筛。
  if (query.orderIds && query.orderIds.length > 0) return [...orders];

  // 整班导出：取数已按班次精确圈定，日期类精筛不适用（会把同班次里整单出发日落到邻日的
  // 往返单误杀）；单程/往返与班次无关，照常生效。
  const dateFiltered = query.scheduleId
    ? [...orders]
    : filterByDateDimensions(orders, query);

  const withoutOneway = excludeOnewayFromReturnLegExport(
    dateFiltered as unknown as ReadonlyArray<ItemsBearing>,
    query.invoiceLeg,
  );
  return filterExportOrdersByTripType(withoutOneway, query.tripType) as unknown as T[];
}

// ── 审计留痕 ──────────────────────────────────────────────────────────────
/** 筛选字段 → 审计里的中文标签。没列出的字段不进摘要（但仍进 after 的结构化留痕）。*/
const FILTER_LABELS: ReadonlyArray<[keyof ExportSelectionFilters, string]> = [
  ['from', '下单起'],
  ['to', '下单止'],
  ['travelFrom', '出行起'],
  ['travelTo', '出行止'],
  ['returnFrom', '返程起'],
  ['returnTo', '返程止'],
  ['flightDateFrom', '航班日起'],
  ['flightDateTo', '航班日止'],
  ['status', '状态'],
  ['channel', '渠道'],
  ['agentId', '代理'],
  ['kind', '产品类型'],
  ['tripType', '行程类型'],
  ['flightNumber', '航班号'],
  ['passengerName', '乘客'],
  ['recordedBy', '录入人'],
  ['search', '关键词'],
  ['invoiceLeg', '开票维度'],
  ['visaFulfillmentStatus', '签证进度'],
  ['visaRequirement', '签证要求'],
];

/**
 * 人读的筛选摘要，进审计 targetLabel。
 * 一个筛选都没给 = 「全部」——这是句诚实的话：确实导了全库。
 */
export function describeOrderFilters(query: ExportSelectionFilters): string {
  const parts = FILTER_LABELS.flatMap(([key, label]) => {
    const v = query[key];
    return v === undefined || v === '' ? [] : [`${label}=${String(v)}`];
  });
  // 导出范围放在最前：同一批筛选条件下，导的是有效单还是取消/退款单，
  // 是这份表最要紧的一句话，事后查审计一眼要看见。
  if (query.scope === 'released') parts.unshift('范围=已取消/退款单');
  // invoiced 是布尔，单独成句（false 也要出现，不能被 falsy 吞掉）。
  if (query.invoiced !== undefined) parts.push(`已开票=${query.invoiced ? '是' : '否'}`);
  return parts.length > 0 ? parts.join('，') : '全部';
}

/** 结构化筛选留痕，进审计 after。undefined 一律落 null，让「没筛」与「筛了空值」可区分。*/
export function serializableOrderFilters(
  query: ExportSelectionFilters,
): Record<string, string | boolean | null> {
  const out: Record<string, string | boolean | null> = {};
  for (const [key] of FILTER_LABELS) {
    const v = query[key];
    out[key] = v === undefined || v === '' ? null : String(v);
  }
  out.invoiced = query.invoiced ?? null;
  // 范围恒落值（缺省写 active），别让「老版本没这个字段」与「这次导的是有效单」长得一样。
  out.scope = query.scope ?? 'active';
  return out;
}

/** 三个日期维度 + 航班号绑定的精筛（整班导出短路掉这一段）。*/
function filterByDateDimensions<T extends SelectableOrder>(
  orders: readonly T[],
  query: ExportSelectionFilters,
): T[] {
  let kept = filterExportOrdersByDepartDate(orders, query.travelFrom, query.travelTo);

  if (query.returnFrom || query.returnTo) {
    const matched = new Set(
      filterOrderIdsByReturnDate(
        orders as unknown as ReadonlyArray<ItemsBearing>,
        query.returnFrom,
        query.returnTo,
      ),
    );
    kept = kept.filter((o) => matched.has(o.id));
  }
  if (query.flightDateFrom || query.flightDateTo) {
    const matched = new Set(
      filterOrderIdsByFlightDate(
        orders as unknown as ReadonlyArray<ItemsBearing>,
        query.flightDateFrom,
        query.flightDateTo,
        query.flightNumber,
      ),
    );
    kept = kept.filter((o) => matched.has(o.id));
  }
  // 航班号 × 日期维度绑定（与 listOrders 同口径）：航班号与出行/返程日期同时给出时收口到
  // 对应航段——「出行日期=8/31 + QH9588」只要 8/31 当天坐 QH9588 出发的单，不要 8/31 出发、
  // 回程才坐 QH9588 的往返单。航班号单独使用时维持任一段命中的宽口径，不进本分支。
  const legDims: Array<'outbound' | 'return'> = [];
  if (query.travelFrom || query.travelTo) legDims.push('outbound');
  if (query.returnFrom || query.returnTo) legDims.push('return');
  if (query.flightNumber?.trim() && legDims.length > 0) {
    const matched = new Set(
      filterOrderIdsByLegFlightNumber(
        kept as unknown as ReadonlyArray<ItemsBearing>,
        query.flightNumber,
        legDims,
      ),
    );
    kept = kept.filter((o) => matched.has(o.id));
  }
  return kept;
}
