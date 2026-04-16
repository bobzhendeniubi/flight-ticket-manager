/**
 * 实时客户动态 widget — 仪表盘右侧或独立卡片显示。
 *
 * Demo 模式：每 8 秒推一条 mock 活动，模拟 backend SSE 推送。
 * 真接 API 后改为：建立 EventSource('/api/admin/events') 接收 cart_add / order_create / order_pay 等事件。
 */
import { useEffect, useState } from 'react';

interface Activity {
  id: string;
  ts: string; // ISO
  kind: 'cart_add' | 'cart_view' | 'checkout_start' | 'order_create' | 'order_pay' | 'order_cancel';
  customer: string;
  message: string;
  emoji: string;
  amount?: number;
}

const KIND_LABEL: Record<Activity['kind'], { label: string; color: string }> = {
  cart_view: { label: '浏览', color: 'bg-slate-100 text-slate-600' },
  cart_add: { label: '加购', color: 'bg-blue-100 text-blue-700' },
  checkout_start: { label: '结账', color: 'bg-amber-100 text-amber-700' },
  order_create: { label: '下单', color: 'bg-indigo-100 text-indigo-700' },
  order_pay: { label: '支付', color: 'bg-green-100 text-green-700' },
  order_cancel: { label: '取消', color: 'bg-slate-200 text-slate-500' },
};

// 模板池：每隔几秒随机推一条
const ACTIVITY_TEMPLATES: Omit<Activity, 'id' | 'ts'>[] = [
  { kind: 'cart_view', customer: '匿名访客 (澳门 IP)', message: '浏览了岘港四季度假村', emoji: '👀' },
  { kind: 'cart_add', customer: '陈先生 (138****1234)', message: '加购 QH9589 经济舱 × 2', emoji: '🛒', amount: 2960 },
  { kind: 'cart_add', customer: '李小姐 (139****5678)', message: '加购 岘港洲际半岛 5 晚', emoji: '🛒', amount: 18400 },
  { kind: 'checkout_start', customer: '王女士 (137****9012)', message: '进入结账，2 名出行人，OCR 上传护照', emoji: '🛂' },
  { kind: 'order_create', customer: '张先生 (138****3344)', message: '下单：岘港 4 天 3 晚经典套餐 × 1', emoji: '🆕', amount: 8920 },
  { kind: 'order_pay', customer: '黄先生 (135****7788)', message: '微信支付完成 · QH9588 商务舱 × 1', emoji: '💚', amount: 4280 },
  { kind: 'cart_add', customer: '匿名访客 (香港 IP)', message: '加购 越南 E-visa 30 天 × 4', emoji: '🛒', amount: 1120 },
  { kind: 'order_create', customer: '刘女士 (139****6655)', message: '下单：巴拿山 1 日包车 × 1', emoji: '🆕', amount: 588 },
  { kind: 'cart_view', customer: '匿名访客 (深圳 IP)', message: '浏览了套餐：蜜月豪华', emoji: '👀' },
  { kind: 'order_pay', customer: '徐先生 (136****1122)', message: '支付宝支付完成 · 岘港凯悦 3 晚', emoji: '💙', amount: 5640 },
  { kind: 'order_cancel', customer: '吴先生 (138****4455)', message: '取消订单 FTM20260415015', emoji: '❌' },
  { kind: 'order_create', customer: '马女士 (137****8899)', message: '下单：会安文化 5 天 4 晚 × 2', emoji: '🆕', amount: 16980 },
];

function pickRandom(): Omit<Activity, 'id' | 'ts'> {
  return ACTIVITY_TEMPLATES[Math.floor(Math.random() * ACTIVITY_TEMPLATES.length)];
}

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

export function RealtimeActivity() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0); // 用于触发"X 秒前"刷新

  // 初始化：放 5 条已发生的活动
  useEffect(() => {
    const initial: Activity[] = [];
    for (let i = 0; i < 5; i++) {
      const tmpl = pickRandom();
      initial.push({
        ...tmpl,
        id: `init-${i}`,
        ts: new Date(Date.now() - (i * 45 + Math.random() * 60) * 1000).toISOString(),
      });
    }
    setActivities(initial);
  }, []);

  // 每 8 秒推新活动
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      setActivities((prev) => {
        const tmpl = pickRandom();
        const newOne: Activity = {
          ...tmpl,
          id: `live-${Date.now()}`,
          ts: new Date().toISOString(),
        };
        return [newOne, ...prev].slice(0, 12); // 保留最近 12 条
      });
    }, 8000);
    return () => clearInterval(interval);
  }, [paused]);

  // 每 5 秒强制重渲染让"X 秒前"动起来
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // 也尝试读 sales-web 同源同口的 localStorage（如果 sales-web 把订单写到了同一个存储）
  // 注意：sales-web 在 :5173, admin-web 在 :5174，浏览器视它们为不同 origin，
  // localStorage 不互通。这里读自己的 ftm-recent-orders 没东西，但保留逻辑作为接口规范。
  useEffect(() => {
    if (paused) return;
    const interval = setInterval(() => {
      try {
        const raw = localStorage.getItem('ftm-recent-orders');
        if (!raw) return;
        const orders = JSON.parse(raw) as Array<{ orderNumber: string; customerName: string; total: number; createdAt: string }>;
        const recent = orders.slice(0, 3);
        setActivities((prev) => {
          const existing = new Set(prev.map((a) => a.id));
          const fromStorage: Activity[] = recent
            .filter((o) => !existing.has(`order-${o.orderNumber}`))
            .map((o) => ({
              id: `order-${o.orderNumber}`,
              ts: o.createdAt,
              kind: 'order_create',
              customer: o.customerName,
              message: `下单成功 ${o.orderNumber} · ¥${o.total.toLocaleString()}`,
              emoji: '🆕',
              amount: o.total,
            }));
          if (fromStorage.length === 0) return prev;
          return [...fromStorage, ...prev].slice(0, 12);
        });
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [paused]);

  const _refresh = tick; // ensure relativeTime re-renders
  void _refresh;

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-slate-900">实时客户动态</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            来自前台 :5173 和小程序的实时事件流（demo 模拟 SSE 推送，每 8 秒一条）
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1 ${paused ? 'text-slate-400' : 'text-green-600'}`}>
            <span className={`h-2 w-2 rounded-full ${paused ? 'bg-slate-300' : 'bg-green-500 animate-pulse'}`} />
            {paused ? '已暂停' : 'LIVE'}
          </span>
          <button className="text-slate-500 hover:text-brand" onClick={() => setPaused((p) => !p)}>
            {paused ? '▶ 继续' : '⏸ 暂停'}
          </button>
        </div>
      </div>

      <ul className="mt-4 space-y-2 max-h-96 overflow-y-auto">
        {activities.map((a) => (
          <li
            key={a.id}
            className="flex items-start gap-3 rounded-md border border-slate-100 bg-slate-50/50 px-3 py-2"
          >
            <span className="text-2xl mt-0.5">{a.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_LABEL[a.kind].color}`}>
                  {KIND_LABEL[a.kind].label}
                </span>
                <span className="text-sm font-medium text-slate-900 truncate">{a.customer}</span>
                {a.amount && (
                  <span className="ml-auto text-sm font-semibold text-red-600 whitespace-nowrap">
                    ¥{a.amount.toLocaleString()}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-sm text-slate-700 truncate">{a.message}</p>
              <p className="mt-0.5 text-xs text-slate-400">{relativeTime(a.ts)}</p>
            </div>
          </li>
        ))}
        {activities.length === 0 && (
          <li className="text-center text-sm text-slate-400 py-4">等待第一条事件…</li>
        )}
      </ul>
    </div>
  );
}
