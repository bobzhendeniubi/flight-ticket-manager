/**
 * 导出层「单程/往返」判定 —— 与 orders.export-depart-filter.ts 同一模式：查询层的
 * Prisma where 表达不了「关联行 ≥ 2 条」，只能在取回内存后按 determineFlightLegs 二次收口。
 *
 * 修两个口径漏洞（票务岗反馈）：
 *
 * 1. 单程单混进「回程未开」的开票导出——查询层的航段守卫（orders.service.ts
 *    buildOrderFilterWhere）只能挡「一条航段都没有」的单（酒店单/签证单），挡不住单程单：
 *    单程单有去程、无回程，returnInvoiced 默认 false，天然命中「回程未开」被一起捞出，
 *    但它压根没有回程票可开。真正判断「有没有回程」要 determineFlightLegs（FLIGHT 行按
 *    departureTime 排序取第 2 段），这是内存计算，Prisma where 跑不了。
 *
 * 2. 新增 tripType 筛选（单程/往返）——票务岗需要按行程类型缩小导出范围，同样只能在内存里判定。
 *
 * 勾选导出（orderIds）不走这两个过滤：用户勾了哪些就导哪些，与 filterExportOrdersByDepartDate
 * 对 orderIds 的处理同一原则，调用方负责在 orderIds 命中时跳过。
 */
import { determineFlightLegs, type FlightLegItem } from './ticketing-cap.js';

export interface TripFilterOrder {
  id: string;
  items: ReadonlyArray<FlightLegItem>;
}

/**
 * 单程单从「回程」维度的开票导出里剔除。
 * 只在 invoiceLeg === 'return' 时生效；outbound / system 维度不受影响（它们本就不需要回程）。
 */
export function excludeOnewayFromReturnLegExport<T extends TripFilterOrder>(
  orders: readonly T[],
  invoiceLeg: 'outbound' | 'return' | 'system' | undefined,
): T[] {
  if (invoiceLeg !== 'return') return [...orders];
  return orders.filter((o) => determineFlightLegs(o.items).returnScheduleId !== null);
}

/** 按行程类型（单程/往返）过滤导出订单；tripType 未给 → 原样返回，不过滤。*/
export function filterExportOrdersByTripType<T extends TripFilterOrder>(
  orders: readonly T[],
  tripType: 'oneway' | 'roundtrip' | undefined,
): T[] {
  if (!tripType) return [...orders];
  return orders.filter((o) => {
    const hasReturn = determineFlightLegs(o.items).returnScheduleId !== null;
    return tripType === 'roundtrip' ? hasReturn : !hasReturn;
  });
}
