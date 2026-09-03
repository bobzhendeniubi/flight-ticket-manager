/**
 * 顶栏「工单」角标 · ADMIN/STAFF
 *
 * no-show 释放已出票的回程时会开出撤名单 / 退票工单 —— 这类工单有时效，
 * 埋在提醒中心里没人盯着就过期了，所以在顶栏常驻一个铃铛。
 *
 * 行为：
 *   - 每 60s 轮询一次汇总；失败静默（网络抖一下不该在顶栏弹红字），下一轮自然重试。
 *   - 角标数字 = 未结（open）条数。
 *   - latestAt 比上次看到的新 → 视为「有新工单」：页面标题加 `(N) ` 前缀；
 *     浏览器通知权限已授予时再弹一条桌面通知。没授权就不弹，也不主动骚扰——
 *     下拉里给一颗按钮，运营想要才点（权限请求必须由点击触发，否则浏览器直接拒）。
 *   - 「看过了」的判定 = 打开过下拉：此时把 latestAt 记进 localStorage，标题前缀消失。
 *
 * 工单的处理仍在提醒中心 / 订单详情里做，这里只负责「别漏看」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type WorkOrderKind, type WorkOrderSummary } from '../lib/api';
import { useAuth } from '../stores/auth';
import { formatDateTimeCn } from '../lib/datetime';
import { Icon } from './Icon';

const POLL_INTERVAL_MS = 60_000;
/** 下拉里「最近」的窗口：只是列表范围，未结数量由服务端的 open 给 */
const RECENT_WINDOW_DAYS = 7;
const LAST_SEEN_KEY = 'ftm.workOrders.lastSeenAt';
/** index.html 里的站点标题，加前缀时拿它做基底 */
const BASE_TITLE = '世途旅行 · 运营后台';

const KIND_LABEL: Record<WorkOrderKind, string> = {
  WITHDRAW: '撤名单',
  RELIST: '重新上架',
  LEG_CANCEL_WITHDRAW: '航段取消撤名单',
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: '待处理',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  SKIPPED: '已跳过',
};

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    // 隐私模式下读不到就当作没看过：顶多多提醒一次，不会漏
    return null;
  }
}

function writeLastSeen(value: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, value);
  } catch {
    // 存不进去只影响「记住看过了」，不影响本次展示
  }
}

/** 浏览器是否支持桌面通知（旧内核 / 非安全上下文下 Notification 可能不存在） */
function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function WorkOrderBell() {
  const token = useAuth((s) => s.tokens?.accessToken) ?? '';
  const navigate = useNavigate();

  const [summary, setSummary] = useState<WorkOrderSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() => readLastSeen());
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    notificationsSupported() ? Notification.permission : 'unsupported',
  );

  // 「最近」窗口的起点只算一次：每轮重算会让 since 一直往前爬，列表来回抖动
  const sinceRef = useRef<string>(
    new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  );
  // 上一轮已经弹过通知的 latestAt —— 同一批工单只弹一次
  const notifiedAtRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.listWorkOrderSummary(token, sinceRef.current);
      setSummary(res);
    } catch {
      // 轮询失败静默：顶栏不该因为一次网络抖动就报错，下一轮自然重试
    }
  }, [token]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const latestAt = summary?.latestAt ?? null;
  const openCount = summary?.open ?? 0;
  // 「有新的」= 服务端最新时间比本机记过的那次更晚
  const hasNew = Boolean(latestAt && (!lastSeenAt || latestAt > lastSeenAt));

  // 桌面通知：只在「有新的」且已授权时弹，同一个 latestAt 只弹一次
  useEffect(() => {
    if (!hasNew || !latestAt) return;
    if (notifiedAtRef.current === latestAt) return;
    if (!notificationsSupported() || Notification.permission !== 'granted') return;
    notifiedAtRef.current = latestAt;
    const newest = summary?.items?.[0];
    const orderPart = newest?.orderNumber ? `单号 ${newest.orderNumber}` : '详见工单列表';
    try {
      new Notification('有新的撤名单 / 退票工单', { body: orderPart, tag: 'ftm-work-orders' });
    } catch {
      // 某些环境构造 Notification 会抛（要求走 ServiceWorker）：静默降级为角标提示
    }
  }, [hasNew, latestAt, summary]);

  // 页面标题前缀：有新工单时挂 `(N) `，看过 / 清零后还原
  useEffect(() => {
    document.title = hasNew && openCount > 0 ? `(${openCount}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [hasNew, openCount]);

  // 点外面 / Esc 关下拉
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const togglePanel = () => {
    setOpen((prev) => {
      const next = !prev;
      // 打开即视为「看过了」：标题前缀落下，下次再有更新的才会重新提示
      if (next && latestAt) {
        setLastSeenAt(latestAt);
        writeLastSeen(latestAt);
      }
      return next;
    });
  };

  const requestPermission = () => {
    if (!notificationsSupported()) return;
    void Notification.requestPermission().then((p) => setPermission(p));
  };

  const items = summary?.items ?? [];

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-ink-soft transition hover:bg-slate-50 hover:text-ink"
        aria-label={`撤名单 / 退票工单${openCount > 0 ? `（未结 ${openCount} 条）` : ''}`}
        aria-expanded={open}
        title="撤名单 / 退票工单"
        onClick={togglePanel}
      >
        <Icon name="alert" size={18} />
        {openCount > 0 && (
          <span
            className={`absolute -right-1 -top-1 min-w-[18px] rounded-full px-1 text-[10px] font-semibold leading-[18px] text-white ${
              hasNew ? 'bg-rose-600' : 'bg-slate-500'
            }`}
          >
            {openCount > 99 ? '99+' : openCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[22rem] max-w-[90vw] overflow-hidden rounded-xl border border-slate-200 bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <span className="text-sm font-semibold text-ink">撤名单 / 退票工单</span>
            <span className="text-xs text-ink-muted">
              未结 {openCount} · 进行中 {summary?.inProgress ?? 0}
            </span>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">近期没有新工单。</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left transition hover:bg-slate-50"
                      onClick={() => {
                        setOpen(false);
                        navigate(`/orders?q=${encodeURIComponent(it.orderNumber)}`);
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="badge-neutral">{KIND_LABEL[it.kind] ?? it.kind}</span>
                        <span className="truncate text-sm font-medium text-ink">{it.title}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                        <span className="nums">{it.orderNumber}</span>
                        <span className="nums">{formatDateTimeCn(it.createdAt)}</span>
                        <span>{STATUS_LABEL[it.status] ?? it.status}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-3 py-2">
            <button
              type="button"
              className="text-xs font-medium text-brand hover:text-brand-dark"
              onClick={() => {
                setOpen(false);
                navigate('/reminders');
              }}
            >
              去提醒中心处理
            </button>
            {permission === 'default' && (
              <button
                type="button"
                className="btn-secondary py-1 text-xs"
                onClick={requestPermission}
              >
                开启桌面通知
              </button>
            )}
            {permission === 'denied' && (
              <span className="text-[11px] text-ink-muted" title="需要在浏览器的站点设置里放开">
                桌面通知已被浏览器拦截
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
