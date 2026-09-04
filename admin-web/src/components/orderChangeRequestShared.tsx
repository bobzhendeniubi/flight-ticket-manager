/**
 * 改单申请（次日起代理提申请 → 运营一键执行）几个新组件共用的常量 / 小 hook。
 * 与 OrdersPage.tsx 内部私有的「改期表单」「批量改航班」用的是同一套航班/班次加载口径
 * （GET /flights/ + GET /flights/:id/schedules，仅取 isActive 班次），但那份逻辑是
 * OrdersPage 的模块私有函数，拿不到；这里单独维护一份小的，供本组件族共用，避免各文件各抄一遍。
 */
import { useEffect, useState } from 'react';
import { api, type AdminFlight, type AdminSchedule, type ChangeRequestVisaStatus, type OrderChangeRequestKind } from '../lib/api';
import { formatLocalTime, localYmd } from '../lib/airports';

export const ORDER_CHANGE_REQUEST_KIND_LABEL: Record<OrderChangeRequestKind, string> = {
  FLIGHT: '改航班',
  VISA: '签证状态',
  HOTEL: '换酒店',
  CABIN: '升舱',
};

/** 改单申请里签证目标状态的三个选项（比录单口径少「已签证」——那是完成态，不是申请目标）。 */
export const CHANGE_REQUEST_VISA_STATUS_OPTIONS: Array<{ value: ChangeRequestVisaStatus; label: string }> = [
  { value: 'NEEDED', label: '需要' },
  { value: 'E_VISA', label: '电子签(三个月多次)' },
  { value: 'NOT_NEEDED', label: '不需要' },
];

/** 班次展示文案：起飞→到达，按班次自己的起降地时区折算（与 OrdersPage 改期表单同口径）。 */
export function scheduleLabel(s: AdminSchedule): string {
  const dep = `${localYmd(s.departureTime, s.departureTz).slice(5)} ${formatLocalTime(s.departureTime, s.departureTz)}`;
  const arr = formatLocalTime(s.arrivalTime, s.arrivalTz);
  return `${dep} → ${arr}`;
}

/** 航班 + 该航班在架班次的加载逻辑（选航班 → 选新班次两级下拉共用）。 */
export function useChangeRequestFlightSchedules(token: string, flightId: string, enabled = true) {
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [schedules, setSchedules] = useState<AdminSchedule[]>([]);
  const [loadingSchedules, setLoadingSchedules] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !token) return;
    let cancelled = false;
    setError(null);
    api
      .listAllFlights(token)
      .then((r) => { if (!cancelled) setFlights(r.flights); })
      .catch(() => { if (!cancelled) setError('航班列表加载失败'); });
    return () => { cancelled = true; };
  }, [enabled, token]);

  useEffect(() => {
    if (!enabled || !token || !flightId) {
      setSchedules([]);
      setLoadingSchedules(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoadingSchedules(true);
    api
      .listSchedules(token, flightId)
      .then((r) => { if (!cancelled) setSchedules(r.schedules.filter((s) => s.isActive)); })
      .catch(() => { if (!cancelled) setError('班次加载失败'); })
      .finally(() => { if (!cancelled) setLoadingSchedules(false); });
    return () => { cancelled = true; };
  }, [enabled, flightId, token]);

  return { flights, schedules, loadingSchedules, error };
}
