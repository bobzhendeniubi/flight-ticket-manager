import { useEffect, useState } from 'react';
import { api, type SellableDateReason } from './api';

/**
 * 单个套餐的可售日期窗口 —— 按 航班 + 酒店库存 逐日算，可设 blackout 封盘。
 *
 * 后台公开端点 GET /products/bundles/:id/sellable-dates 只回每日
 * { sellable, reason, flightTier, hotelTier }（与六档余位 / 房量同纪律，
 * 不回原始库存数字）。挂载时拉一次滚动窗口（今天 .. 今天+60 天），按套餐缓存。
 *
 * 失败口径（与 useHotelAvailability 的 catch 一致）：查询失败 → PERMISSIVE，
 * 即返回空集合并视为"未知、不硬性拦截下单"——绝不造假可售日，也绝不因
 * 一次可用性查询失败就阻断下单（售罄拦截仍走原有 soldOut 实时档位口径）。
 *
 * 返回值：
 *   status      —— 'loading' | 'ready' | 'error'（error 时按 PERMISSIVE 处理）
 *   sellableSet —— 可售日期 ISO 集合（空集 = 未知/未加载，不据此硬拦截）
 *   minDate     —— 窗口内首个可售日（约束日期输入 min；无则 null）
 *   maxDate     —— 窗口内末个可售日（约束日期输入 max；无则 null）
 *   reasonOf    —— 查某日不可售原因（不在数据里 → null，按"未知不拦截"）
 */
export type SellableDatesStatus = 'loading' | 'ready' | 'error';

/** 滚动窗口跨度（天）：今天 .. 今天 + WINDOW_DAYS（含两端，约束 ≤90 天后端上限）。 */
const WINDOW_DAYS = 60;

export interface BundleSellableDates {
  status: SellableDatesStatus;
  sellableSet: Set<string>;
  minDate: string | null;
  maxDate: string | null;
  reasonOf: (iso: string) => SellableDateReason;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function useBundleSellableDates(
  bundleId: string | null | undefined,
): BundleSellableDates {
  const [status, setStatus] = useState<SellableDatesStatus>(bundleId ? 'loading' : 'ready');
  const [sellableSet, setSellableSet] = useState<Set<string>>(() => new Set());
  const [reasonMap, setReasonMap] = useState<Map<string, SellableDateReason>>(() => new Map());
  const [minDate, setMinDate] = useState<string | null>(null);
  const [maxDate, setMaxDate] = useState<string | null>(null);

  useEffect(() => {
    if (!bundleId) {
      setStatus('ready');
      setSellableSet(new Set());
      setReasonMap(new Map());
      setMinDate(null);
      setMaxDate(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    const from = todayISO();
    const to = addDaysISO(from, WINDOW_DAYS);
    api
      .getBundleSellableDates(bundleId, from, to)
      .then((r) => {
        if (cancelled) return;
        const set = new Set<string>();
        const reasons = new Map<string, SellableDateReason>();
        for (const d of r.dates) {
          if (d.sellable) set.add(d.dateISO);
          // 记录每日 reason（含可售日的 null），用于 reasonOf 精确回答。
          reasons.set(d.dateISO, d.reason);
        }
        const sellableSorted = [...set].sort();
        setSellableSet(set);
        setReasonMap(reasons);
        setMinDate(sellableSorted[0] ?? null);
        setMaxDate(sellableSorted[sellableSorted.length - 1] ?? null);
        setStatus('ready');
      })
      .catch(() => {
        // PERMISSIVE：查询失败按"未知"处理 —— 空集、无 min/max 约束、不硬拦截下单。
        if (cancelled) return;
        setSellableSet(new Set());
        setReasonMap(new Map());
        setMinDate(null);
        setMaxDate(null);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [bundleId]);

  const reasonOf = (iso: string): SellableDateReason => reasonMap.get(iso) ?? null;

  return { status, sellableSet, minDate, maxDate, reasonOf };
}
