/**
 * 导出层「出发日期」精确细筛 —— 全岗总表 / 三模板 两处共享。
 *
 * 背景（0722 公测反馈 · 财务岗）：按出发日期导出《全岗可用》，本想只要「当天出发」的订单，
 * 实际却把出行日期及**返程**日期落在窗口内的数据也导了进来。
 *
 * 根因：列表/导出的取数 where（buildOrderFilterWhere 的 travelFrom/travelTo）出于「宁可多召回、
 * 不漏单」故意做了两件放宽 ——
 *   1. 窗口各向外 ±1 天（UTC 与出发地 +8 跨午夜的边界防漏）；
 *   2. `items.some.OR[ 任意 FLIGHT 行的班次出发时间, 任意酒店入住日 ]` —— 只要**任一**航段
 *      （含返程）或**任一**入住日落在窗口内就召回。
 * 于是「去程 21 号、回程 22 号」这类整单出发日在窗口外的往返单，会因返程段落在窗口内被捞进来。
 *
 * 取数层的宽召回口径**保持不动**（列表页依赖它防漏单）；本模块只在导出把数据取回内存后，
 * 按「整单出发日」二次精确过滤。整单出发日的判定复用订单列表「出发日期」列同一函数
 * （orders.service.filterOrderIdsByDepartDate → deriveOrderDepartDate：本单最早 FLIGHT 行的班次
 * 出发日；无航班回退最早酒店入住日），因此「导出所得 = 列表所见」。
 *
 * 纯签证单等既无航班行、也无酒店入住日的订单：本就没有「出发日」——在带 travelFrom/travelTo 的
 * 导出里维持现状口径（不命中、被排除）。这与取数 where 的现状一致：travelFrom/travelTo 的
 * `items.some.OR` 两个分支都要求字段存在于窗口内，纯签证单两个分支都落空、本来就不会被选中；
 * 故二次过滤把它们过滤掉不改变现有行为，只是让「返程/±1 天邻日」这类多召回被收口。
 */
import { filterOrderIdsByDepartDate } from './orders.service.js';

/**
 * 按整单「出发日」把导出订单精确过滤到 [travelFrom, travelTo]（闭区间，+8 日历日；
 * 口径与订单列表「出发日期」列一致，见文件头）。
 *
 * - travelFrom / travelTo 均未给（如勾选导出 / 整班导出已在别处短路）→ 原样返回（浅拷贝），不过滤；
 * - 订单需带 `items`（含 `flightSchedule.departureTime` 与 `hotelCheckIn`）——全岗总表 / 三模板的
 *   取数 include 均已联查，形状满足；类型上以内部 cast 收敛，调用方无需再断言。
 *
 * @param orders     已取回内存的订单数组（各带 id + items）
 * @param travelFrom 出发日期起（YYYY-MM-DD，含）
 * @param travelTo   出发日期止（YYYY-MM-DD，含）
 */
export function filterExportOrdersByDepartDate<T extends { id: string; items: unknown }>(
  orders: readonly T[],
  travelFrom?: string,
  travelTo?: string,
): T[] {
  if (!travelFrom && !travelTo) return [...orders];
  const candidates = orders.map((o) => ({
    id: o.id,
    items: (o.items as ReadonlyArray<Record<string, unknown>>) ?? [],
  }));
  const keep = new Set(filterOrderIdsByDepartDate(candidates, travelFrom, travelTo));
  return orders.filter((o) => keep.has(o.id));
}
