/**
 * 最近订单动态 widget — 仪表盘右侧或独立卡片显示。
 *
 * 展示真实最近订单（GET /orders?pageSize=…，按下单时间倒序），每 15 秒轮询一次。
 * 之前的版本用随机 mock 模板伪造"实时客户动态"（浏览/加购/支付等），
 * 会让运营误以为看到了真实客户行为——已移除，改为展示后端真实订单数据。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';

const POLL_INTERVAL_MS = 15000;
const RECENT_ORDER_LIMIT = 12;

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'badge-neutral' },
  PENDING_PAYMENT: { label: '待支付', color: 'badge-warning' },
  PAID: { label: '已支付', color: 'badge-success' },
  PROCESSING: { label: '处理中', color: 'badge-info' },
  TICKETED: { label: '出票完成', color: 'badge-success' },
  COMPLETED: { label: '已完成', color: 'badge-neutral' },
  PAYMENT_TIMEOUT: { label: '超时', color: 'badge-neutral' },
  CANCELLED: { label: '已取消', color: 'badge-neutral' },
  REFUND_REQUESTED: { label: '退款申请中', color: 'badge-danger' },
  REFUNDED: { label: '已退款', color: 'badge-danger' },
  CHANGE_REQUESTED: { label: '改期申请中', color: 'badge-warning' },
  CHANGED: { label: '已改期', color: 'badge-info' },
  FAILED: { label: '出票失败', color: 'badge-danger' },
};

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function RealtimeActivity() {
  const tokens = useAuth((s) => s.tokens);
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0); // 用于触发"X 分钟前"刷新

  const load = useCallback(async () => {
    if (!tokens) return;
    try {
      const res = await api.listOrders(tokens.accessToken, { pageSize: RECENT_ORDER_LIMIT });
      setOrders(res.orders);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载最近订单失败');
    }
  }, [tokens]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (paused) return;
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [paused, load]);

  // 每 5 秒强制重渲染让"X 分钟前"动起来
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const _refresh = tick; // ensure relativeTime re-renders
  void _refresh;

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">最近订单</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            按下单时间倒序 · 每 {POLL_INTERVAL_MS / 1000} 秒自动刷新
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className={`inline-flex items-center gap-1.5 font-medium ${paused ? 'text-ink-muted' : 'text-emerald-600'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${paused ? 'bg-slate-300' : 'bg-emerald-500 animate-pulse'}`} />
            {paused ? '已暂停' : 'LIVE'}
          </span>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ 继续' : '⏸ 暂停'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      )}

      <ul className="mt-4 space-y-1.5 max-h-96 overflow-y-auto">
        {(orders ?? []).map((o) => {
          const badge = STATUS_BADGE[o.status] ?? { label: o.status, color: 'badge-neutral' };
          const summary = o.items.map((it) => it.description).join(' + ') || '（无明细）';
          return (
            <li
              key={o.id}
              className="flex items-start gap-3 rounded-lg border border-slate-100 px-3 py-2.5 transition hover:bg-slate-50/70"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={badge.color}>{badge.label}</span>
                  <span className="truncate text-sm font-medium text-ink">{o.contactName}</span>
                  <span className="nums ml-auto whitespace-nowrap text-sm font-semibold text-ink">
                    ¥{Number(o.total).toLocaleString()}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-sm text-ink-soft">{o.orderNumber} · {summary}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{relativeTime(o.createdAt)}</p>
              </div>
            </li>
          );
        })}
        {orders !== null && orders.length === 0 && !error && (
          <li className="py-4 text-center text-sm text-ink-muted">暂无订单</li>
        )}
        {orders === null && !error && (
          <li className="py-4 text-center text-sm text-ink-muted">加载中…</li>
        )}
      </ul>
    </div>
  );
}
