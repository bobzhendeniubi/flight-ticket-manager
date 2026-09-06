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
  // 扩展三类：后端 flag 关着时这三个 kind 根本回不来，但 Record 是穷举的，标签仍要给全。
  SPLIT: '拆单',
  CANCEL_LEG: '取消单程',
  VISA_EXEMPT: '改自备签',
};

/** 三类扩展在队列/面板里要单独提示「这一类动订单结构或动钱」，用它判。 */
export function isExtraOrderChangeKind(kind: OrderChangeRequestKind): boolean {
  return kind === 'SPLIT' || kind === 'CANCEL_LEG' || kind === 'VISA_EXEMPT';
}

/** 「套餐档次与酒店星级不符」放行原因的字数上限，与 SingleOrderModal 纠错换酒店同一档口径。 */
export const STAR_MISMATCH_REASON_MAX = 200;

/** 400 报错文案里带「放行原因」= 指定酒店星级与套餐档次不符，需要运营补填理由才能放行执行。 */
export function isStarMismatchApproveError(message: string): boolean {
  return message.includes('放行原因');
}

/**
 * 取消单程确认时命中「需要我已知悉回执」的稳定 code。
 * 最典型的是该段已出票 —— 取消后要给票务派撤名单/退票工单，不该静默放行。
 * 按 code 判，不匹配中文文案（服务端把底层 code 原样带上来了）。
 */
export const ACKNOWLEDGEMENT_REQUIRED_CODE = 'ACKNOWLEDGEMENT_REQUIRED';

/**
 * 确认执行前要额外说清楚的一句话（三类扩展动的是订单结构或钱，
 * 不能只写一句「直接执行」就让人点下去）。返回空串 = 不需要额外提示。
 */
export function extraKindConfirmHint(kind: OrderChangeRequestKind): string {
  switch (kind) {
    case 'SPLIT':
      return '\n确认后会按所选出行人拆出一张新单：金额按每人份额分开，两侧合计不变，座位与房间随人走。';
    case 'CANCEL_LEG':
      return '\n确认后该航段座位放回库存重新销售，退款按取消政策计算并降低本单应收（本步不打款）。';
    case 'VISA_EXEMPT':
      return '\n确认后该出行人的办签方式改变：套餐单按下单时的减免标准重算应收，送签进度重置为待处理。';
    default:
      return '';
  }
}

/** 金额带正负号展示（成本变化用）：正数 +¥X，负数 −¥X（全角负号，跟订单财务模块同一套写法）。 */
export function formatSignedCny(amountCny: number): string {
  const sign = amountCny < 0 ? '−' : '+';
  return `${sign}¥${Math.abs(amountCny).toLocaleString()}`;
}

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
