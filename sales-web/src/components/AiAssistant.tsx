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
  // 已经 OCR'd 但还没下单的护照队列（subscribed → 上传一本就重渲染面板进度条）
  const pendingPassengers = usePassengers((s) => s.pending);

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
        // 把原始 OCR 文字 dump 出来 — 既能让用户看出哪里识错，也方便我们调正则
        const rawSnippet = (result.rawText || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .slice(0, 12)
          .join('\n');
        const partial: string[] = [];
        if (result.fallback?.englishName) partial.push(`姓名（候选）: ${result.fallback.englishName}`);
        if (result.fallback?.chineseName) partial.push(`中文名（候选）: ${result.fallback.chineseName}`);
        if (result.fallback?.passportNumber) partial.push(`护照号（候选）: ${result.fallback.passportNumber}`);
        if (result.fallback?.dateOfBirth) partial.push(`出生日期（候选）: ${result.fallback.dateOfBirth}`);

        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text:
              `**OCR 没完全识别成功 😅**（置信度 ${Math.round(result.confidence)}%，耗时 ${(result.elapsedMs / 1000).toFixed(1)}s）\n\n` +
              (partial.length > 0
                ? `**部分字段拿到了：**\n${partial.map((p) => `- ${p}`).join('\n')}\n\n但护照号没匹配上正则，需要手填。\n\n`
                : `没匹配到护照号 / 姓名。\n\n`) +
              `常见原因：拍照反光、倾斜、低分辨率、字体被压痕遮挡。\n\n` +
              (rawSnippet
                ? `**OCR 原始文字（前 12 行，调试用）：**\n\`\`\`\n${rawSnippet}\n\`\`\`\n\n`
                : '') +
              `**麻烦你结账时手填一下姓名/护照号/出生日期。**`,
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
      // 部分字段缺失时（DOB/国籍）— dump raw OCR 让用户能看 tesseract 实际抓到啥
      const hasMissingField = !ocr.dateOfBirth || !ocr.nationality;
      const debugSnippet = hasMissingField
        ? (result.rawText || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .slice(0, 15)
            .join('\n')
        : '';

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
            (debugSnippet
              ? `📋 **OCR 抓到的前 15 行**（部分字段没识别上时给你看）：\n\`\`\`\n${debugSnippet}\n\`\`\`\n\n`
              : '') +
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

  // 已加购但还没传完护照 — 一旦设置就在聊天里显示一个醒目的"上传护照"面板
  const [pendingPassportPrompt, setPendingPassportPrompt] = useState<{
    needed: number; // 需要 N 本护照
  } | null>(null);

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

    // 算一下需要几本护照：取 FLIGHT items 里 passengers 的最大值，往返同一批人
    const flightItems = cartItems.filter((ci) => ci.kind === 'FLIGHT');
    const flightPax = flightItems.length > 0
      ? Math.max(...flightItems.map((ci) => {
          const m = ci.meta as Record<string, unknown> | undefined;
          return Number(m?.passengers) || ci.qty;
        }))
      : 0;
    const bundleItems = cartItems.filter((ci) => ci.kind === 'BUNDLE');
    const bundlePax = bundleItems.length > 0
      ? Math.max(...bundleItems.map((ci) => {
          const m = ci.meta as Record<string, unknown> | undefined;
          return Number(m?.pax) || 0;
        }))
      : 0;
    const needPassports = Math.max(flightPax, bundlePax);

    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text: needPassports > 0
          ? `✓ **已加入购物车 ${cartItems.length} 项**\n\n下一步：上传 **${needPassports} 位** 出行人的护照（每张机票一个人，照片就行，OCR 自动填表）。\n\n下面那个红色 📷 按钮上传，传完点"去结账"。`
          : `✓ **已加入购物车 ${cartItems.length} 项**\n\n下一步：去结账 → 支付。`,
      },
    ]);

    if (needPassports > 0) {
      // 触发醒目的"上传护照"面板
      setPendingPassportPrompt({ needed: needPassports });
    } else {
      // 没机票（纯酒店/接送/签证）— 直接跳结账
      setTimeout(() => {
        setOpen(false);
        navigate('/cart');
      }, 800);
    }
  };

  // 快捷动作下拉的展开状态：null = 全收起，'add' = 加产品菜单展开，'modify' = 修改菜单展开
  const [actionMenu, setActionMenu] = useState<null | 'add' | 'modify'>(null);

  const quickAction = (text: string) => {
    setActionMenu(null);
    void send(text);
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

          {/* 快捷动作（在 AI 回复后显示，引导客户下一步）— 只在最近一条是 assistant 时出现 */}
          {messages.length > 1 &&
            messages[messages.length - 1].role === 'assistant' &&
            !loading &&
            !ocrProgress && (() => {
              // 看最近这条助手消息有没有 proposal — 有就把"OK"按钮变成「直接下单」
              const lastMsg = messages[messages.length - 1];
              const lastProposal = lastMsg.proposals?.[0];
              return (
            <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/60">
              {actionMenu === null && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (lastProposal) {
                        // 已有订单草稿 → 直接确认下单（与卡片紫色按钮等效）
                        setActionMenu(null);
                        handleConfirmProposal(lastProposal);
                      } else {
                        // 没草稿 → 让 AI 给详情
                        quickAction('好的，给我详细信息（出发到达时间、行李、退改条款都给我说一下）');
                      }
                    }}
                    className={`flex-1 min-w-[80px] text-xs rounded-md border px-2 py-1.5 ${
                      lastProposal
                        ? 'border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                    }`}
                  >
                    {lastProposal ? '✅ 确认下单' : '👌 OK · 看详情'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionMenu('add')}
                    className="flex-1 min-w-[80px] text-xs rounded-md border border-blue-300 bg-blue-50 px-2 py-1.5 text-blue-800 hover:bg-blue-100"
                  >
                    ➕ 再加点
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionMenu('modify')}
                    className="flex-1 min-w-[80px] text-xs rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-800 hover:bg-amber-100"
                  >
                    ✏️ 要改
                  </button>
                </div>
              )}
              {actionMenu === 'add' && (
                <div>
                  <div className="text-xs text-slate-500 mb-1 flex items-center justify-between">
                    <span>加点什么：</span>
                    <button
                      type="button"
                      onClick={() => setActionMenu(null)}
                      className="text-slate-400 hover:text-slate-700"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => quickAction('帮我加越南签证（每个出行人都要）')} className="text-xs rounded-md border border-blue-200 bg-white px-2 py-1.5 hover:bg-blue-50">🛂 加签证</button>
                    <button type="button" onClick={() => quickAction('再帮我加岘港 3 晚酒店')} className="text-xs rounded-md border border-blue-200 bg-white px-2 py-1.5 hover:bg-blue-50">🏨 加酒店</button>
                    <button type="button" onClick={() => quickAction('再帮我加机场接机一趟')} className="text-xs rounded-md border border-blue-200 bg-white px-2 py-1.5 hover:bg-blue-50">🚗 加接机</button>
                    <button type="button" onClick={() => quickAction('有什么一价全包套餐推荐？')} className="text-xs rounded-md border border-blue-200 bg-white px-2 py-1.5 hover:bg-blue-50">🎁 看套餐</button>
                  </div>
                </div>
              )}
              {actionMenu === 'modify' && (
                <div>
                  <div className="text-xs text-slate-500 mb-1 flex items-center justify-between">
                    <span>改什么：</span>
                    <button
                      type="button"
                      onClick={() => setActionMenu(null)}
                      className="text-slate-400 hover:text-slate-700"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => quickAction('改人数（请问当前是几人？我想改成 ___ 人）')} className="text-xs rounded-md border border-amber-200 bg-white px-2 py-1.5 hover:bg-amber-50">👥 改人数</button>
                    <button type="button" onClick={() => quickAction('改日期，我想换一天看看')} className="text-xs rounded-md border border-amber-200 bg-white px-2 py-1.5 hover:bg-amber-50">📅 改日期</button>
                    <button type="button" onClick={() => quickAction('我想换商务舱看看价格')} className="text-xs rounded-md border border-amber-200 bg-white px-2 py-1.5 hover:bg-amber-50">💺 换舱位</button>
                    <button type="button" onClick={() => quickAction('再给我看看其他选项')} className="text-xs rounded-md border border-amber-200 bg-white px-2 py-1.5 hover:bg-amber-50">🔄 看别的</button>
                  </div>
                </div>
              )}
            </div>
              );
            })()}

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

          {/* 已加购后醒目的"上传 N 本护照"面板 — 加购后只显示这个，覆盖快捷动作 */}
          {pendingPassportPrompt && !ocrProgress && (() => {
            const uploaded = pendingPassengers.length;
            const need = pendingPassportPrompt.needed;
            const done = uploaded >= need;
            return (
              <div className="px-3 py-2 border-t-2 border-rose-400 bg-rose-50">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-semibold text-rose-900">
                    {done ? '✅ 护照已齐' : `📷 还需 ${need - uploaded} 本护照`}
                  </div>
                  <div className="text-xs text-rose-700">
                    已上传 <strong>{uploaded}</strong> / {need}
                  </div>
                </div>
                <div className="h-1.5 bg-rose-100 rounded mb-2">
                  <div
                    className="h-full bg-rose-500 rounded transition-all"
                    style={{ width: `${Math.min(100, (uploaded / need) * 100)}%` }}
                  />
                </div>
                <div className="flex gap-1.5">
                  {!done && (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="flex-1 rounded-md bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700"
                    >
                      📷 上传第 {uploaded + 1} 本护照
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPendingPassportPrompt(null);
                      setOpen(false);
                      navigate('/cart');
                    }}
                    className={`rounded-md px-3 py-2 text-sm ${
                      done
                        ? 'flex-1 bg-emerald-600 font-semibold text-white hover:bg-emerald-700'
                        : 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {done ? '✓ 去结账' : '稍后填'}
                  </button>
                </div>
              </div>
            );
          })()}

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

function shortItemLabel(item: AiProposal['items'][number]): string {
  const d = item.detail;
  switch (item.kind) {
    case 'FLIGHT':
      return `${d.flightNumber as string ?? '机票'} ${d.origin}→${d.destination} ${d.cabin}`;
    case 'VISA':
      return `${(d.country as string) ?? '签证'}签证`;
    case 'HOTEL':
      return `${(d.hotelName as string) ?? '酒店'} × ${d.nights as number} 晚`;
    case 'TRANSFER':
      return `${(d.vehicleType as string) ?? '接送'} × ${item.qty}`;
    case 'BUNDLE':
      return `${(d.bundleName as string) ?? '套餐'} × ${d.pax as number} 人`;
    default:
      return item.name;
  }
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
      dateRank: string; // 内部字段，不渲染给客户
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
  if (item.kind === 'VISA') {
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
  if (item.kind === 'HOTEL') {
    const d = item.detail as {
      hotelName: string;
      roomTypeName: string;
      bedType?: string;
      starRating?: number;
      area?: string;
      checkIn: string;
      checkOut: string;
      nights: number;
      rooms: number;
      pricePerNight: number;
      amenities?: string[];
    };
    return (
      <div className="rounded-md bg-white/70 px-3 py-2 border border-purple-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-xs">🏨</span>
            <span className="font-semibold text-slate-900 text-sm truncate">{d.hotelName}</span>
            {d.starRating && (
              <span className="text-xs text-amber-500 flex-shrink-0">{'★'.repeat(d.starRating)}</span>
            )}
          </div>
          <span className="text-sm font-bold text-red-600 flex-shrink-0 ml-2">
            ¥{item.total.toLocaleString()}
          </span>
        </div>
        <div className="text-xs text-slate-600 mt-1">
          {d.roomTypeName}{d.bedType ? ` · ${d.bedType}` : ''}{d.area ? ` · ${d.area}` : ''}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {d.checkIn} → {d.checkOut} · {d.nights} 晚 × {d.rooms} 间 · ¥{d.pricePerNight}/晚
        </div>
      </div>
    );
  }
  if (item.kind === 'TRANSFER') {
    const d = item.detail as {
      vehicleType: string;
      capacity: number;
      originArea: string;
      destArea: string;
      duration?: string;
      features?: string[];
    };
    return (
      <div className="rounded-md bg-white/70 px-3 py-2 border border-purple-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-xs">🚗</span>
            <span className="font-semibold text-slate-900 text-sm truncate">{item.name}</span>
          </div>
          <span className="text-sm font-bold text-red-600 flex-shrink-0 ml-2">
            ¥{item.total.toLocaleString()}
          </span>
        </div>
        <div className="text-xs text-slate-600 mt-1">
          {d.vehicleType} · 可乘 {d.capacity} 人 · {d.originArea} → {d.destArea}
          {d.duration ? ` · ${d.duration}` : ''}
        </div>
        {d.features && d.features.length > 0 && (
          <div className="text-[10px] text-slate-400 mt-0.5">
            {d.features.slice(0, 3).join(' / ')}
          </div>
        )}
      </div>
    );
  }
  // BUNDLE
  const d = item.detail as {
    bundleName: string;
    tagline?: string;
    pax: number;
    rooms: number;
    components: Array<{ kind: string; productName?: string; qty: number }>;
    groundDiscount: number;
    note?: string;
  };
  return (
    <div className="rounded-md bg-white/70 px-3 py-2 border border-purple-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs">🎁</span>
          <span className="font-semibold text-slate-900 text-sm truncate">{d.bundleName}</span>
        </div>
        <span className="text-sm font-bold text-red-600 flex-shrink-0 ml-2">
          ¥{item.total.toLocaleString()}
        </span>
      </div>
      {d.tagline && <div className="text-xs text-slate-600 mt-1">{d.tagline}</div>}
      <div className="text-xs text-slate-500 mt-0.5">
        {d.pax} 人{d.rooms > 1 ? ` · ${d.rooms} 间房` : ''}
        {d.groundDiscount > 0 && (
          <span className="ml-1 text-emerald-600">已让利 ¥{d.groundDiscount}</span>
        )}
      </div>
      {d.components && d.components.length > 0 && (
        <div className="text-[10px] text-slate-400 mt-1">
          含：{d.components.map((c) => c.productName ?? c.kind).slice(0, 4).join(' / ')}
        </div>
      )}
      {d.note && <div className="text-[10px] text-amber-600 mt-1 italic">⚠ {d.note}</div>}
    </div>
  );
}
