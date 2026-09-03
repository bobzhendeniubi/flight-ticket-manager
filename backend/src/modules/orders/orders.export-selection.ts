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
 *        · EXPORT_COUNTED_STATUSES —— 排除释放型状态（已取消/超时/失败/退款申请中）；
 *        · agentScope —— 代理只导自己 + 下级（AND 交集，勾选导出同受此闸）。
 *
 *   2. 内存精筛（filterExportOrders）—— Prisma where 表达不了的部分：
 *      整单出发日/返程日、航段当地起飞日、航班号×日期绑定、单程/往返（要「关联行 ≥ 2 条」）。
 *      各分支的口径注释在各自的实现文件里，本模块只负责按正确顺序串起来。
 *
 * 两个短路口径原样保留，不能顺手统一：
 *   · orderIds（勾选导出）—— 用户勾了哪些就导哪些，取数与精筛全部短路；
 *   · scheduleId（整班·全岗精确导出）—— 取数已按班次精确圈定，日期类精筛不适用，
 *     但单程/往返筛选照常生效（它与班次无关）。
 */
import { OrderStatus, Prisma } from '@prisma/client';
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

/** 选单用到的筛选字段：列表同款筛选 + 勾选导出 / 整班导出两个短路开关。*/
export type ExportSelectionFilters = OrderListFilters;

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
  and.push({ status: { in: EXPORT_COUNTED_STATUSES } });
  if (opts?.extraAnd?.length) and.push(...opts.extraAnd);
  where.AND = and;
  return applyExportAgentScope(where, opts?.agentScope);
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
