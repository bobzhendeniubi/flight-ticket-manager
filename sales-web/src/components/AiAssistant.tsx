/**
 * AI 助手 · 浮动聊天框（beta）
 *
 * 右下角按钮 → 弹出对话窗口。
 * 用户用人话说"明天去岘港 2 个人"，助手自动调后端工具搜索航班 + 报价。
 *
 * 关键 UX 决策（防 AI 误操作）：
 *   - AI 永远只能 propose_order（dry-run），不能直接 createOrder
 *   - 收到 proposal 后前端渲染一张「确认下单」卡片
 *   - 用户必须点卡上的按钮才会真正加购物车
 *   - 没登录就跳登录页，登录回来重新点
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type AiChatMessage, type AiProposal } from '../lib/api';
import { useCart } from '../stores/cart';
import { useAuth } from '../stores/auth';

interface DisplayMessage {
  role: 'user' | 'assistant';
  text: string;
  proposals?: AiProposal[];
  mocked?: boolean;
}

const SUGGESTIONS = [
  '明天去岘港的机票，2 人经济舱',
  '5 月 1 号有什么航班？',
  '商务舱最便宜哪天？',
];

export function AiAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([
    {
      role: 'assistant',
      text: '你好！我是世途旅行 AI 助手 ✈️\n说一下你想要什么样的机票（日期/人数/舱位），我帮你找。',
    },
  ]);
  // 后端真正记忆 = aiHistory（包含 tool_use / tool_result blocks）
  // displayMessages 仅用来渲染聊天气泡
  const [aiHistory, setAiHistory] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const addToCart = useCart((s) => s.add);
  const user = useAuth((s) => s.user);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setMessages((prev) => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setLoading(true);

    try {
      const r = await api.aiChat({
        messages: aiHistory,
        userMessage: trimmed,
      });
      setAiHistory(r.messages);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: r.reply,
          proposals: r.proposals,
          mocked: r.mocked,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: e instanceof Error ? `出错了：${e.message}` : '助手暂时不可用，请稍后再试',
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmProposal = (p: AiProposal) => {
    if (!user) {
      // 未登录：先把 proposal 暂存，登录回来后看到提示
      navigate('/login?redirect=/');
      return;
    }
    // 加购物车 → 跳结账
    addToCart({
      kind: p.cartItem.kind,
      productId: p.cartItem.productId,
      name: p.cartItem.name,
      emoji: '✈️',
      unitPrice: p.cartItem.unitPrice,
      qty: p.cartItem.qty,
      meta: p.cartItem.meta as Record<string, string | number | boolean> | undefined,
    });
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text: `✓ 已加入购物车。下一步去填乘客信息 → [跳到结账]`,
      },
    ]);
    setTimeout(() => {
      setOpen(false);
      navigate('/cart');
    }, 800);
  };

  const reset = () => {
    setMessages([
      {
        role: 'assistant',
        text: '新对话开始。说一下你想要什么样的机票吧～',
      },
    ]);
    setAiHistory([]);
  };

  return (
    <>
      {/* 浮动按钮 */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 px-5 py-3 text-white shadow-lg hover:shadow-xl transition"
          aria-label="AI 助手"
        >
          <span className="text-xl">🤖</span>
          <span className="text-sm font-medium">AI 帮我订票</span>
          <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">Beta</span>
        </button>
      )}

      {/* 聊天窗口 */}
      {open && (
        <div className="fixed bottom-6 right-6 z-40 flex h-[600px] w-[380px] max-w-[calc(100vw-3rem)] max-h-[calc(100vh-3rem)] flex-col rounded-lg bg-white shadow-2xl border border-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between rounded-t-lg bg-gradient-to-br from-blue-600 to-purple-600 px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <span className="text-lg">🤖</span>
              <div>
                <div className="font-semibold text-sm">世途 AI 助手</div>
                <div className="text-xs opacity-80">Beta · 帮你找机票 + 报价</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={reset}
                title="清空对话"
                className="text-white/70 hover:text-white text-xs"
              >
                ⟲
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-white/70 hover:text-white text-lg"
              >
                ×
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
            {messages.map((m, i) => (
              <div key={i}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'ml-auto bg-blue-600 text-white'
                      : 'bg-white border border-slate-200 text-slate-800'
                  }`}
                >
                  {m.text}
                  {m.mocked && (
                    <div className="mt-1 text-xs opacity-70">(运维未配 ANTHROPIC_API_KEY，AI 走 mock 模式)</div>
                  )}
                </div>
                {m.proposals?.map((p, pi) => (
                  <ProposalCard
                    key={`${i}-${pi}`}
                    proposal={p}
                    onConfirm={() => handleConfirmProposal(p)}
                  />
                ))}
              </div>
            ))}
            {loading && (
              <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-500 max-w-[85%]">
                <span className="inline-block animate-pulse">思考中…</span>
              </div>
            )}
          </div>

          {/* Suggestions（只在第一句助手消息后显示）*/}
          {messages.length <= 1 && (
            <div className="px-3 py-2 border-t border-slate-100 bg-white">
              <div className="text-xs text-slate-500 mb-1">试试：</div>
              <div className="flex flex-wrap gap-1">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="text-xs rounded-full border border-slate-300 px-2 py-1 hover:bg-slate-50 hover:border-blue-400"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex gap-2 border-t border-slate-200 bg-white p-3 rounded-b-lg"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="比如：5 月 1 号 2 个人去岘港"
              disabled={loading}
              className="input flex-1"
              autoFocus
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="btn-primary text-sm disabled:opacity-50"
            >
              发送
            </button>
          </form>

          {/* 安全提示 */}
          <div className="px-3 pb-2 text-[10px] text-slate-400 text-center bg-white rounded-b-lg">
            ⚠️ AI 只能给你提议；真正下单需要你点确认按钮 → 填乘客信息 → 支付
          </div>
        </div>
      )}
    </>
  );
}

// ── 订单草稿确认卡 ──────────────────────────────────────────
function ProposalCard({
  proposal,
  onConfirm,
}: {
  proposal: AiProposal;
  onConfirm: () => void;
}) {
  const dep = new Date(proposal.departureTime);
  const arr = new Date(proposal.arrivalTime);
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  return (
    <div className="mt-2 max-w-[85%] rounded-lg border-2 border-purple-300 bg-gradient-to-br from-purple-50 to-blue-50 p-3 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-purple-700 bg-purple-100 px-2 py-0.5 rounded">
          📋 订单草稿
        </span>
        <span className="text-xs text-slate-500">需要你确认</span>
      </div>
      <div className="font-semibold text-slate-900 text-sm">
        {proposal.flightNumber} {proposal.origin} → {proposal.destination}
      </div>
      <div className="text-xs text-slate-600 mt-1">
        {fmt(dep)} → {fmt(arr)} · {proposal.cabin} × {proposal.passengers} 人
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-xs text-slate-500">
          单价 ¥{proposal.pricing.unitPrice.toLocaleString()}（rank {proposal.pricing.dateRank}）
        </span>
        <span className="text-lg font-bold text-red-600">
          ¥{proposal.pricing.totalPrice.toLocaleString()}
        </span>
      </div>
      <button
        type="button"
        onClick={onConfirm}
        className="mt-3 w-full rounded-md bg-purple-600 py-2 text-sm font-semibold text-white hover:bg-purple-700"
      >
        ✓ 确认加入购物车 → 去结账
      </button>
      <div className="mt-1 text-[10px] text-slate-400 text-center">
        加购后可改人数 / 填乘客 / 支付
      </div>
    </div>
  );
}
