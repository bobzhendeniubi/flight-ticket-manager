/**
 * 最近订单动态 widget — 仪表盘右侧或独立卡片显示。
 *
 * 展示真实最近订单（GET /orders?pageSize=…，按下单时间倒序），每 15 秒轮询一次。
 * 之前的版本用随机 mock 模板伪造"实时客户动态"（浏览/加购/支付等），
 * 会让运营误以为看到了真实客户行为——已移除，改为展示后端真实订单数据。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type OrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { orderStatusBadgeClass, orderStatusLabel } from '../lib/orderStatus';
import { formatDateTimeSecCn } from '../lib/datetime';
import { Icon } from './Icon';

const POLL_INTERVAL_MS = 15000;
const RECENT_ORDER_LIMIT = 12;

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
          <h2 className="text-sm font-semibold text-ink">最新订单</h2>
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
            {paused ? <><Icon name="play" /> 继续</> : <><Icon name="pause" /> 暂停</>}
          </button>
          <Link to="/orders" className="text-sm font-medium text-brand hover:text-brand-dark">查看全部 →</Link>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="table-admin">
          <thead>
            <tr>
              <th>订单号</th>
              <th>客户</th>
              <th>内容摘要</th>
              <th className="text-right">金额</th>
              <th className="text-center">状态</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {orders?.map((o) => {
              const summary = o.items.map((it) => it.description).join(' + ') || '（无明细）';
              return (
                <tr key={o.id}>
                  <td className="font-mono text-xs text-ink-soft">{o.orderNumber}</td>
                  <td className="whitespace-nowrap text-ink">
                    {o.contactName}
                    {o.agent && (
                      <span className="badge-info ml-2">
                        代理 · {o.agent.companyName ?? o.agent.contactName}
                      </span>
                    )}
                  </td>
                  <td className="max-w-xs truncate" title={summary}>{summary}</td>
                  <td className="nums whitespace-nowrap text-right font-medium text-ink">¥{Number(o.total).toLocaleString()}</td>
                  <td className="text-center"><span className={orderStatusBadgeClass(o.status)}>{orderStatusLabel(o.status)}</span></td>
                  <td className="whitespace-nowrap text-xs text-ink-muted" title={formatDateTimeSecCn(o.createdAt)}>
                    {relativeTime(o.createdAt)}
                  </td>
                </tr>
              );
            })}
            {orders !== null && orders.length === 0 && !error && (
              <tr><td colSpan={6} className="py-8 text-center text-ink-muted">暂无订单</td></tr>
            )}
            {orders === null && !error && (
              <tr><td colSpan={6} className="py-8 text-center text-ink-muted">加载中…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
