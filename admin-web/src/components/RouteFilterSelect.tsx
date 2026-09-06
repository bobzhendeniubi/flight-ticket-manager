/**
 * 航线筛选下拉（财务页 / 经营报表页共用）。
 *
 * 选项来自 `GET /settlement-rates/routes` —— 那是全站「可维护航线」的现成清单
 * （结算价日历 ∪ 立减规则 ∪ 活跃套餐派生 ∪ 活跃航班，去程方向），不必为筛选另建一份。
 *
 * 与结算价日历页、立减规则页那两个航线下拉不是一回事，故没有合并：那两个是**选择器**
 * （必须选中一条具体航线才能维护价格，默认选第一条），这里是**筛选器**，多两个固定项：
 *   · 「全部航线」= 不筛（传空值）；
 *   · 「未知航线」= 只看推不出航线的单。这一项不是噪音——它正好是运营要去补绑航班的那批单，
 *     藏起来的话「为什么两条线加起来对不上总数」就永远查不出来。
 *
 * 拉不到航线（网络错 / 权限不足）时只留这两个固定项：下拉照常能用，不会因为一次筛选器加载
 * 失败把整页数据挡住。
 */
import { useEffect, useState } from 'react';
import { api, type SettlementRoute } from '../lib/api';

/** 「未知航线」桶的键，与后端 lib/order-route.ts 的 UNKNOWN_ROUTE_KEY 一字不差。 */
export const UNKNOWN_ROUTE_KEY = 'unknown';

/** 'MFM-DAD' → 'MFM→DAD'；未知桶 → 「未知航线」（口径同后端 routeKeyLabel）。 */
export function routeKeyLabel(routeKey: string): string {
  if (routeKey === UNKNOWN_ROUTE_KEY) return '未知航线';
  const parts = routeKey.split('-');
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}→${parts[1]}` : routeKey;
}

/** 航线选项（一次取回，页面内多个下拉共用同一份，不各拉各的）。 */
export function useRouteOptions(token: string): SettlementRoute[] {
  const [routes, setRoutes] = useState<SettlementRoute[]>([]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .listSettlementRateRoutes(token)
      .then((res) => {
        if (!cancelled) setRoutes(res.routes);
      })
      // 拉不到就只留固定项：航线下拉是个筛选器，不该因为它失败而挡住整页数据。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);
  return routes;
}

export function RouteFilterSelect({
  routes,
  value,
  onChange,
  label = '航线',
}: {
  routes: SettlementRoute[];
  /** 空串 = 全部航线。 */
  value: string;
  onChange: (routeKey: string) => void;
  label?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input py-1.5"
        aria-label="按航线筛选"
      >
        <option value="">全部航线</option>
        {routes.map((r) => (
          <option key={r.routeKey} value={r.routeKey}>
            {routeKeyLabel(r.routeKey)}
          </option>
        ))}
        <option value={UNKNOWN_ROUTE_KEY}>{routeKeyLabel(UNKNOWN_ROUTE_KEY)}</option>
      </select>
    </div>
  );
}
