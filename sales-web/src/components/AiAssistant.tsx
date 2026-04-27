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
import ReactMarkdown from 'react-markdown';
import { api, type AiChatMessage, type AiProposal } from '../lib/api';
import { useCart } from '../stores/cart';
import { useAuth } from '../stores/auth';
import { usePassengers, type OcrPassenger } from '../stores/passengers';
import { ocrPassport } from '../lib/passportOcr';

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
      text: '你好！我是世途旅行 AI 助手 ✈️\n\n你可以：\n- 用人话告诉我你想要什么机票（日期/人数/舱位）\n- 点 📎 上传护照照片，我帮你 OCR 提取信息',
    },
  ]);
  // 后端真正记忆 = aiHistory（包含 tool_use / tool_result blocks）
  // displayMessages 仅用来渲染聊天气泡
  const [aiHistory, setAiHistory] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ pct: number; stage: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const addToCart = useCart((s) => s.add);
  const user = useAuth((s) => s.user);
  const addPassenger = usePassengers((s) => s.add);
  const hydratePassengers = usePassengers((s) => s.hydrate);

  useEffect(() => {
    hydratePassengers();
  }, [hydratePassengers]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // 护照 OCR — 选了文件后浏览器跑 tesseract.js（中文护照精度 60-75%；
  // 失败时引导用户手填，不阻断流程）
  const handleFile = async (file: File) => {
    if (loading) return;
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: `📎 上传了护照：${file.name}` },
    ]);
    setOcrProgress({ pct: 0, stage: '准备识别…' });
    try {
      const result = await ocrPassport(file, (pct, stage) => {
        setOcrProgress({ pct, stage });
      });
      setOcrProgress(null);

      if (!result.success || !result.suggested.passportNumber) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text:
              `**OCR 识别失败 😅**\n\n` +
              `中文护照在浏览器端 tesseract.js 准确率约 60-75%，可能因为：\n` +
              `- 拍照反光/倾斜\n- 字迹被压痕遮挡\n- 不是标准 ICAO 9303 格式\n\n` +
              `**麻烦你结账时手动填一下姓名/护照号/出生日期。**`,
          },
        ]);
        return;
      }

      const ocr: OcrPassenger = {
        fullName: result.suggested.fullName ?? '（未识别）',
        passportNumber: result.suggested.passportNumber,
        dateOfBirth: result.suggested.dateOfBirth,
        nationality: result.suggested.nationality,
        capturedAt: Date.now(),
      };
      addPassenger(ocr);

      // 给 AI 一条系统级提示（说"用户上传了护照"），让它在后续对话中用
      const sysHint =
        `[系统提示] 用户刚刚上传了护照照片，OCR 识别出以下旅客信息（已暂存到结账队列）：\n` +
        `- 姓名: ${ocr.fullName}\n- 护照号: ${ocr.passportNumber}\n` +
        `- 出生日期: ${ocr.dateOfBirth ?? '?'}\n- 国籍: ${ocr.nationality ?? '?'}\n\n` +
        `请友好地确认你看到了，告诉用户在结账页这些字段会自动填好。不要追问。`;
      // 直接走 send 让 AI 知道；再展示 OCR 结果给用户看
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text:
            `✅ **OCR 识别成功**（置信度 ${Math.round(result.confidence)}%，耗时 ${(result.elapsedMs / 1000).toFixed(1)}s）\n\n` +
            `- **姓名**：${ocr.fullName}\n` +
            `- **护照号**：\`${ocr.passportNumber}\`\n` +
            `- **出生日期**：${ocr.dateOfBirth ?? '（未识别，结账时手填）'}\n` +
            `- **国籍**：${ocr.nationality ?? '（未识别）'}\n\n` +
            `已暂存。下单时这些字段会自动填进结账页。`,
        },
      ]);
      // 顺便发给 AI（隐形 system prompt 形式）让它知道用户已上传
      await send(sysHint, { hideUserBubble: true });
    } catch (err) {
      setOcrProgress(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `OCR 出错了：${err instanceof Error ? err.message : '未知错误'}`,
        },
      ]);
    }
  };

  const send = async (text: string, opts?: { hideUserBubble?: boolean }) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    if (!opts?.hideUserBubble) {
      setMessages((prev) => [...prev, { role: 'user', text: trimmed }]);
    }
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
      navigate('/login?redirect=/');
      return;
    }
    // 把草稿里的每一项都加进购物车（机票 + 签证可能并存）
    const cartItems = p.cartItems ?? [];
    for (const ci of cartItems) {
      addToCart({
        kind: ci.kind as 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'BUNDLE',
        productId: ci.productId,
        name: ci.name,
        emoji: ci.emoji ?? '🎫',
        unitPrice: ci.unitPrice,
        qty: ci.qty,
        meta: ci.meta as Record<string, string | number | boolean> | undefined,
      });
    }
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text: `✓ **已加入购物车 ${cartItems.length} 项**\n\n下一步：填乘客信息 → 提交订单 → 支付。马上跳到结账页…`,
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
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'ml-auto bg-blue-600 text-white whitespace-pre-wrap'
                      : 'bg-white border border-slate-200 text-slate-800 ai-md'
                  }`}
                >
                  {m.role === 'assistant' ? (
                    <ReactMarkdown
                      components={{
                        // 用 <p> 但去掉默认的大 margin，让聊天气泡紧凑
                        p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                        ul: ({ children }) => <ul className="my-1 ml-4 list-disc">{children}</ul>,
                        ol: ({ children }) => <ol className="my-1 ml-4 list-decimal">{children}</ol>,
                        li: ({ children }) => <li className="my-0.5">{children}</li>,
                        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
                        em: ({ children }) => <em className="italic">{children}</em>,
                        code: ({ children }) => (
                          <code className="bg-slate-100 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                        ),
                        h1: ({ children }) => <div className="text-base font-semibold mb-1">{children}</div>,
                        h2: ({ children }) => <div className="text-sm font-semibold mb-1">{children}</div>,
                        h3: ({ children }) => <div className="text-sm font-semibold mb-1">{children}</div>,
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline">{children}</a>
                        ),
                      }}
                    >
                      {m.text}
                    </ReactMarkdown>
                  ) : (
                    <div className="whitespace-pre-wrap">{m.text}</div>
                  )}
                  {m.mocked && (
                    <div className="mt-1 text-xs opacity-70">(运维未配 OPENAI_API_KEY，AI 走 mock 模式)</div>
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

          {/* OCR 进度条（OCR 中显示）*/}
          {ocrProgress && (
            <div className="px-3 py-2 border-t border-slate-100 bg-amber-50 text-xs">
              <div className="flex justify-between mb-1 text-amber-900">
                <span>{ocrProgress.stage}</span>
                <span>{Math.round(ocrProgress.pct)}%</span>
              </div>
              <div className="h-1 bg-amber-100 rounded">
                <div
                  className="h-full bg-amber-500 rounded transition-all"
                  style={{ width: `${ocrProgress.pct}%` }}
                />
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
            {/* 隐藏文件 input + 可见 📎 按钮 */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = ''; // reset 让用户能再传同一文件
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={loading || !!ocrProgress}
              title="上传护照照片自动识别"
              className="rounded-md border border-slate-300 px-2.5 py-2 text-sm hover:bg-slate-50 disabled:opacity-40"
            >
              📎
            </button>
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

// ── 订单草稿确认卡（multi-item，可展开）─────────────────────
function ProposalCard({
  proposal,
  onConfirm,
}: {
  proposal: AiProposal;
  onConfirm: () => void;
}) {
  const [expanded, setExpanded] = useState(true); // 默认展开（项数少没必要折）
  const items = proposal.items ?? [];
  const summaryText =
    items.length === 0
      ? '空草稿'
      : items
          .map((i) => `${i.kind === 'FLIGHT' ? '✈️' : '🛂'} ${shortItemLabel(i)}`)
          .join(' + ');

  return (
    <div className="mt-2 max-w-[85%] rounded-lg border-2 border-purple-300 bg-gradient-to-br from-purple-50 to-blue-50 p-3 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-purple-700 bg-purple-100 px-2 py-0.5 rounded">
            📋 订单草稿
          </span>
          <span className="text-xs text-slate-500">需要你确认</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-purple-700 hover:underline"
        >
          {expanded ? '收起 ▲' : `展开 ▼（${items.length} 项）`}
        </button>
      </div>

      {/* 折叠时显示一行 summary，展开时显示每项详情 */}
      {!expanded ? (
        <div className="text-xs text-slate-700">{summaryText}</div>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <ProposalItemRow key={i} item={item} />
          ))}
        </div>
      )}

      {/* 总价 + 确认按钮（永远显示） */}
      <div className="mt-3 flex items-baseline justify-between border-t border-purple-200 pt-2">
        <span className="text-xs text-slate-500">合计</span>
        <span className="text-xl font-bold text-red-600">
          ¥{proposal.totalPrice.toLocaleString()}
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

function shortItemLabel(item: { kind: 'FLIGHT' | 'VISA'; detail: Record<string, unknown> }): string {
  if (item.kind === 'FLIGHT') {
    const d = item.detail;
    return `${d.flightNumber as string ?? '机票'} ${d.origin}→${d.destination} ${d.cabin}`;
  }
  return `${(item.detail.country as string) ?? '签证'}签证`;
}

function ProposalItemRow({ item }: { item: AiProposal['items'][number] }) {
  if (item.kind === 'FLIGHT') {
    const d = item.detail as {
      flightNumber: string;
      origin: string;
      destination: string;
      departureTime: string;
      arrivalTime: string;
      cabin: string;
      passengers: number;
      dateRank: string;
      basePrice: number;
    };
    const dep = new Date(d.departureTime);
    const arr = new Date(d.arrivalTime);
    const fmt = (x: Date) =>
      `${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
    return (
      <div className="rounded-md bg-white/70 px-3 py-2 border border-purple-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-xs">✈️</span>
            <span className="font-semibold text-slate-900 text-sm">
              {d.flightNumber} {d.origin}→{d.destination}
            </span>
            <span className={`text-xs px-1.5 rounded ${
              d.dateRank === 'A' ? 'bg-red-100 text-red-700' :
              d.dateRank === 'B' ? 'bg-amber-100 text-amber-700' :
              d.dateRank === 'C' ? 'bg-blue-100 text-blue-700' :
              'bg-emerald-100 text-emerald-700'
            }`}>{d.dateRank}</span>
          </div>
          <span className="text-sm font-bold text-red-600">¥{item.total.toLocaleString()}</span>
        </div>
        <div className="text-xs text-slate-600 mt-1">
          {fmt(dep)} → {fmt(arr)} · {d.cabin} × {d.passengers} 人 · ¥{item.unitPrice}/人
          {item.unitPrice !== d.basePrice && (
            <span className="text-slate-400 line-through ml-1">¥{d.basePrice}</span>
          )}
        </div>
      </div>
    );
  }
  // VISA
  const d = item.detail as {
    country: string;
    type: string;
    processingDays: number;
    validityMonths: number;
    requiredDocs: string[];
    express: boolean;
  };
  return (
    <div className="rounded-md bg-white/70 px-3 py-2 border border-purple-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-xs">🛂</span>
          <span className="font-semibold text-slate-900 text-sm">
            {d.country} · {d.type}
          </span>
          {d.express && <span className="text-xs px-1.5 rounded bg-amber-100 text-amber-700">加急</span>}
        </div>
        <span className="text-sm font-bold text-red-600">¥{item.total.toLocaleString()}</span>
      </div>
      <div className="text-xs text-slate-600 mt-1">
        {d.processingDays} 天出签 · 有效期 {d.validityMonths} 个月 · {item.qty} 人 · ¥{item.unitPrice}/人
      </div>
      {d.requiredDocs?.length > 0 && (
        <div className="text-[10px] text-slate-400 mt-1">
          需材料：{d.requiredDocs.join(' / ')}
        </div>
      )}
    </div>
  );
}
