/**
 * AI 订票助手（beta） — OpenAI Chat Completions + tool use
 *
 * 默认 gpt-5-mini（便宜 + 支持 tool use）；OPENAI_MODEL 可切换。
 *
 * 工具：search_flights, get_flight_price, propose_order
 *
 * 安全护栏：
 *   - propose_order 只 dry-run（返 quote），不真创建订单
 *   - 真下单走前端「确认」按钮 → 现有 POST /orders/ 流程
 *   - 系统提示词反复强调"不能编造旅客信息 / 不能跳过用户确认"
 */
import OpenAI from 'openai';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { PricingService } from '../modules/pricing/pricing.service.js';
import { CabinClass } from '@prisma/client';

const MAX_TOOL_ITERATIONS = 8; // 防止 loop 失控

// ── 系统提示词 ───────────────────────────────────────────────
const SYSTEM_PROMPT = `你是「世途旅行」的客服 AI 助手，帮客户预订澳门 ⇌ 岘港的机票（顺带配签证）。

# 你的工作流程
1. 听用户说想要什么（日期 / 目的地 / 人数 / 舱位）
2. 调 search_flights 找航班
3. 用人话总结 2-3 个选项给用户（包括动态价 + 日期等级）
4. 用户选了具体航班后：
   - **主动询问需不需要配越南签证**（去越南必需，除非用户已有）
   - 如果要 → 调 search_visas 查可选签证
5. 调 propose_order 生成"订单草稿"（**优先用新的 items 数组方式**，可以同时含机票 + 签证）
6. 让 UI 展示草稿卡片，提示用户点「确认下单」

# propose_order 用法
- 单买机票：items=[{kind:'FLIGHT', scheduleId, cabin, passengers}]
- 机票 + 签证：items=[{kind:'FLIGHT',...}, {kind:'VISA', visaId, qty:N, express?:bool}]
- VISA qty 一般 = 机票乘客数（每个人都要签证）
- 暂不支持 HOTEL/TRANSFER/BUNDLE — 用户问就说"酒店/接送/套餐请去前台首页购买"

# 严格不能做的事
- 绝对不能编造航班 / 价格 / 签证 / 旅客信息（必须从工具返回值读）
- 绝对不能跳过用户确认就下单（你只能 propose_order，不能真创建订单）
- 不能填假的护照号 / 出生日期；旅客信息用户自己填或 OCR 上传
- 不能讨论政治、暴力、医疗等无关话题

# 关于护照 OCR
- 用户可能上传护照照片，前端 OCR 后把识别结果作为 \`[系统提示]\` 消息发给你
- 看到时简短确认（"收到了，张三的护照已登记"），告诉用户在结账页自动填好；不要追问已识别的字段

# 关于价格
- basePrice = 标价；dynamicPrice = 实际成交价
- dateRank A/B/C/D 是日期等级：A 最旺(×1.5)，D 最淡(×0.8)
- 价格随余位升档（卖得越多越贵），主动提醒用户"现在锁价划算"

# 对话风格
- 简洁，不啰嗦
- 每次最多介绍 3 个选项；多了用户记不住
- 主动追问关键缺失信息（出发日期 / 人数 / 舱位偏好 / 是否需要签证）
- 用 ¥ 而不是 RMB
- 出发地默认澳门 (MFM)，目的地默认岘港 (DAD)

# 当前默认参数（用户没说就用这些）
- origin: MFM, destination: DAD
- cabin: ECONOMY
- passengers: 1`;

// ── 工具定义（OpenAI Chat Completions tool 格式）─────────────
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_flights',
      description:
        '搜索澳门 ⇌ 岘港的航班。返回班次列表，每个班次含多个舱位的动态价、日期等级、余位。' +
        '如果客户没指定日期，date 留空就返回全部未来 50 个班次。',
      parameters: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: '出发地 IATA 代码，默认 MFM（澳门）' },
          destination: { type: 'string', description: '目的地 IATA 代码，默认 DAD（岘港）' },
          date: { type: 'string', description: 'YYYY-MM-DD 出发日期。可省略 = 不限。' },
          cabin: {
            type: 'string',
            enum: ['ECONOMY', 'BUSINESS'],
            description: '舱位筛选；可省略 = 全部',
          },
          passengers: { type: 'integer', minimum: 1, maximum: 9, description: '人数，默认 1' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_flight_price',
      description:
        '查询某个特定航班 + 舱位 + 数量的精确价格明细（每张票一个 unitPrice，跨 bucket 时单价不同）。' +
        '在用户已经选定了一个具体班次后调，给客户报最终价。',
      parameters: {
        type: 'object',
        properties: {
          scheduleId: { type: 'string', description: '航班 scheduleId，从 search_flights 返回' },
          cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] },
          qty: { type: 'integer', minimum: 1, maximum: 9 },
        },
        required: ['scheduleId', 'cabin', 'qty'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_visas',
      description:
        '搜索可办理的签证（用户去越南/东南亚需要签证时调）。返回签证列表，含办理时长、价格、加急选项。' +
        'country 可省略（返回所有国家）；常见 countryCode：VN(越南) KH(柬埔寨) TH(泰国) SG(新加坡) LA(老挝) MY(马来) ID(印尼)',
      parameters: {
        type: 'object',
        properties: {
          countryCode: {
            type: 'string',
            description: '目的地国家 ISO 代码，例 VN；省略 = 所有国家',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_order',
      description:
        '生成"订单草稿"（dry-run，不真扣库存、不真扣钱）。' +
        '调完返回订单摘要 → 前端会渲染一张确认卡片让用户点「确认下单」。' +
        '只有用户在卡片上点了确认，才会真正创建订单。\n\n' +
        '支持多产品组合（机票 + 签证）：把 items 数组传进来。\n' +
        '老的单航班调用方式（顶层 scheduleId/cabin/passengers）仍兼容。',
      parameters: {
        type: 'object',
        properties: {
          // 新方式：items 数组，混合多种产品
          items: {
            type: 'array',
            description: '订单包含的产品列表（混合机票 + 签证）',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['FLIGHT', 'VISA'],
                  description: 'FLIGHT=机票, VISA=签证（HOTEL/TRANSFER/BUNDLE 暂不支持，请引导用户去前台单独下单）',
                },
                // FLIGHT
                scheduleId: { type: 'string', description: 'kind=FLIGHT 时必填，从 search_flights 拿' },
                cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] },
                passengers: { type: 'integer', minimum: 1, maximum: 9 },
                // VISA
                visaId: { type: 'string', description: 'kind=VISA 时必填，从 search_visas 拿' },
                qty: { type: 'integer', minimum: 1, maximum: 9, description: 'VISA 申请人数' },
                express: { type: 'boolean', description: 'VISA 是否加急（贵但快）' },
              },
              required: ['kind'],
            },
          },
          // 老方式：单航班（向后兼容老对话）
          scheduleId: { type: 'string', description: '（兼容）单航班时的 scheduleId' },
          cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] },
          passengers: { type: 'integer', minimum: 1, maximum: 9 },
        },
      },
    },
  },
];

// ── 工具执行 ─────────────────────────────────────────────────
const pricingService = new PricingService();

interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

async function executeSearchFlights(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    const origin = (input.origin as string) ?? 'MFM';
    const destination = (input.destination as string) ?? 'DAD';
    const date = input.date as string | undefined;
    const passengers = (input.passengers as number) ?? 1;
    const cabin = input.cabin as CabinClass | undefined;

    const where: Record<string, unknown> = {
      flight: { originCode: origin, destinationCode: destination, isActive: true },
    };
    if (date) {
      const [y, m, d] = date.split('-').map(Number);
      const startUtc = new Date(Date.UTC(y, m - 1, d, -8, 0, 0));
      const endUtc = new Date(Date.UTC(y, m - 1, d + 1, -8, 0, 0));
      where.departureTime = { gte: startUtc, lt: endUtc };
    } else {
      where.departureTime = { gte: new Date() };
    }

    const schedules = await prisma.flightSchedule.findMany({
      where,
      include: { flight: true, seatClasses: true },
      orderBy: { departureTime: 'asc' },
      take: 20, // AI 上下文友好：最多 20 个班次
    });

    const results = await Promise.all(
      schedules.map(async (s) => {
        const seats = cabin ? s.seatClasses.filter((c) => c.cabin === cabin) : s.seatClasses;
        const cabinDetails = await Promise.all(
          seats.map(async (c) => {
            let dynamicPrice = Number(c.basePrice);
            let dateRank = 'C';
            try {
              if (c.capacity - c.sold >= passengers) {
                const pr = await pricingService.calculatePrice(s.id, c.cabin, passengers);
                dynamicPrice = pr.averageUnitPrice;
                dateRank = pr.dateRank;
              }
            } catch {
              /* fallback */
            }
            return {
              cabin: c.cabin,
              available: c.capacity - c.sold,
              basePrice: Number(c.basePrice),
              dynamicPrice,
              dateRank,
            };
          }),
        );
        return {
          scheduleId: s.id,
          flightNumber: s.flight.flightNumber,
          origin: s.flight.originCode,
          destination: s.flight.destinationCode,
          departureTime: s.departureTime.toISOString(),
          arrivalTime: s.arrivalTime.toISOString(),
          durationMinutes: Math.round(
            (s.arrivalTime.getTime() - s.departureTime.getTime()) / 60_000,
          ),
          cabins: cabinDetails,
        };
      }),
    );

    return { ok: true, data: { count: results.length, flights: results.slice(0, 10) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'search_flights failed' };
  }
}

async function executeGetFlightPrice(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    const result = await pricingService.calculatePrice(
      input.scheduleId as string,
      input.cabin as CabinClass,
      input.qty as number,
    );
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'get_flight_price failed' };
  }
}

async function executeSearchVisas(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    const countryCode = input.countryCode as string | undefined;
    const where: Record<string, unknown> = { isActive: true };
    if (countryCode) where.destinationCountry = countryCode;
    const visas = await prisma.visa.findMany({ where, take: 30 });
    return {
      ok: true,
      data: {
        count: visas.length,
        visas: visas.map((v) => ({
          visaId: v.id,
          country: v.country,
          countryCode: v.destinationCountry,
          name: v.visaName ?? v.visaType,
          processingDays: v.processingDays,
          basePrice: Number(v.basePrice),
          expressSurcharge: v.expressSurcharge ? Number(v.expressSurcharge) : null,
          validityMonths: v.validityMonths,
          highlight: v.highlight,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'search_visas failed' };
  }
}

interface ProposalItemInput {
  kind: 'FLIGHT' | 'VISA';
  scheduleId?: string;
  cabin?: CabinClass;
  passengers?: number;
  visaId?: string;
  qty?: number;
  express?: boolean;
}

interface ProposalItemOut {
  kind: 'FLIGHT' | 'VISA';
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  detail: Record<string, unknown>;
  cartItem: {
    kind: string;
    productId: string;
    name: string;
    emoji?: string;
    unitPrice: number;
    qty: number;
    meta?: Record<string, unknown>;
  };
}

async function priceFlightItem(item: ProposalItemInput): Promise<ProposalItemOut | { error: string }> {
  if (!item.scheduleId || !item.cabin || !item.passengers) {
    return { error: 'FLIGHT item 需要 scheduleId / cabin / passengers' };
  }
  const pricing = await pricingService.calculatePrice(
    item.scheduleId,
    item.cabin,
    item.passengers,
  );
  const schedule = await prisma.flightSchedule.findUnique({
    where: { id: item.scheduleId },
    include: { flight: true },
  });
  if (!schedule) return { error: `班次 ${item.scheduleId} 不存在` };
  const name = `${schedule.flight.flightNumber} ${schedule.flight.originCode}→${schedule.flight.destinationCode} · ${item.cabin} × ${item.passengers}`;
  return {
    kind: 'FLIGHT',
    name,
    qty: item.passengers,
    unitPrice: pricing.averageUnitPrice,
    total: pricing.totalPrice,
    detail: {
      flightNumber: schedule.flight.flightNumber,
      origin: schedule.flight.originCode,
      destination: schedule.flight.destinationCode,
      departureTime: schedule.departureTime.toISOString(),
      arrivalTime: schedule.arrivalTime.toISOString(),
      cabin: item.cabin,
      passengers: item.passengers,
      dateRank: pricing.dateRank,
      basePrice: pricing.basePrice,
    },
    cartItem: {
      kind: 'FLIGHT',
      productId: item.scheduleId,
      name,
      emoji: '✈️',
      unitPrice: pricing.totalPrice,
      qty: 1,
      meta: {
        cabin: item.cabin,
        passengers: item.passengers,
        dateRank: pricing.dateRank,
        totalForQty: pricing.totalPrice,
      },
    },
  };
}

async function priceVisaItem(item: ProposalItemInput): Promise<ProposalItemOut | { error: string }> {
  if (!item.visaId || !item.qty) {
    return { error: 'VISA item 需要 visaId / qty' };
  }
  const visa = await prisma.visa.findUnique({ where: { id: item.visaId } });
  if (!visa) return { error: `签证 ${item.visaId} 不存在` };
  const base = Number(visa.basePrice);
  const surcharge = item.express && visa.expressSurcharge ? Number(visa.expressSurcharge) : 0;
  const unitPrice = base + surcharge;
  const total = unitPrice * item.qty;
  const expressLabel = item.express ? ' (加急)' : '';
  const name = `${visa.country} · ${visa.visaName ?? visa.visaType}${expressLabel} × ${item.qty}`;
  return {
    kind: 'VISA',
    name,
    qty: item.qty,
    unitPrice,
    total,
    detail: {
      country: visa.country,
      type: visa.visaName ?? visa.visaType,
      processingDays: item.express
        ? Math.max(visa.processingDays - 2, 1)
        : visa.processingDays,
      validityMonths: visa.validityMonths,
      requiredDocs: visa.requiredDocs,
      express: !!item.express,
    },
    cartItem: {
      kind: 'VISA',
      productId: visa.id + (item.express ? '-express' : ''),
      name,
      emoji: visa.flag ?? '🛂',
      unitPrice,
      qty: item.qty,
      meta: {
        express: !!item.express,
        processingDays: item.express
          ? Math.max(visa.processingDays - 2, 1)
          : visa.processingDays,
      },
    },
  };
}

async function executeProposeOrder(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    // 兼容老调用：顶层 scheduleId/cabin/passengers → 转成 single FLIGHT item
    let items: ProposalItemInput[];
    if (Array.isArray(input.items) && input.items.length > 0) {
      items = input.items as ProposalItemInput[];
    } else if (input.scheduleId && input.cabin && input.passengers) {
      items = [
        {
          kind: 'FLIGHT',
          scheduleId: input.scheduleId as string,
          cabin: input.cabin as CabinClass,
          passengers: input.passengers as number,
        },
      ];
    } else {
      return { ok: false, error: 'propose_order 需要 items 数组，或顶层 scheduleId+cabin+passengers' };
    }

    const priced: ProposalItemOut[] = [];
    for (const it of items) {
      let result: ProposalItemOut | { error: string };
      if (it.kind === 'FLIGHT') result = await priceFlightItem(it);
      else if (it.kind === 'VISA') result = await priceVisaItem(it);
      else {
        return { ok: false, error: `暂不支持的 item kind: ${it.kind}（HOTEL/TRANSFER/BUNDLE 请引导用户在前台单独下单）` };
      }
      if ('error' in result) return { ok: false, error: result.error };
      priced.push(result);
    }

    const totalPrice = priced.reduce((s, p) => s + p.total, 0);

    const proposal = {
      kind: 'PROPOSAL' as const,
      items: priced,
      totalPrice,
      summary:
        priced
          .map((p) => `${p.kind === 'FLIGHT' ? '✈️' : '🛂'} ${p.name}`)
          .join(' + ') + ` = ¥${totalPrice}`,
      cartItems: priced.map((p) => p.cartItem),
      note: '此为草稿（dry-run），未扣库存未扣款。前端会展示确认卡，用户点「确认下单」才真正提交。',
    };
    return { ok: true, data: proposal };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'propose_order failed' };
  }
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
  switch (name) {
    case 'search_flights':
      return executeSearchFlights(input);
    case 'get_flight_price':
      return executeGetFlightPrice(input);
    case 'search_visas':
      return executeSearchVisas(input);
    case 'propose_order':
      return executeProposeOrder(input);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ── 主入口 ───────────────────────────────────────────────────
// 前端只需要原样回传 messages 数组；包含 user / assistant / tool 三种 role
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ChatTurnResult {
  reply: string;
  proposals: Array<Record<string, unknown>>;
  messages: ChatMessage[];
  debug: {
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
  };
  mocked: boolean;
}

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (_client) return _client;
  if (!env.OPENAI_API_KEY) return null;
  _client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL, // undefined = OpenAI 官方
  });
  return _client;
}

/**
 * 跑一轮对话：手动 tool-use loop
 *   1. 把历史 messages + 新用户消息 → OpenAI
 *   2. 如果 finish_reason='tool_calls' → 执行所有 tool，把结果作为 role:tool 消息追加
 *   3. 再调一次，直到 finish_reason='stop'
 */
export async function runChatTurn(
  history: ChatMessage[],
  userMessage: string,
): Promise<ChatTurnResult> {
  const client = getClient();
  if (!client) {
    return mockTurn(history, userMessage);
  }

  // 第一次进对话时把 system 加上；后续 history 已含
  const hasSystem = history.some((m) => m.role === 'system');
  const messages: ChatMessage[] = [
    ...(hasSystem ? [] : [{ role: 'system' as const, content: SYSTEM_PROMPT }]),
    ...history,
    { role: 'user', content: userMessage },
  ];

  let toolCalls = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;
  const proposals: Array<Record<string, unknown>> = [];
  let finalReply = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await client.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages,
      tools: TOOLS,
      // gpt-5-mini 等 reasoning 模型不接受 temperature，省略让默认生效
    });

    totalPrompt += response.usage?.prompt_tokens ?? 0;
    totalCompletion += response.usage?.completion_tokens ?? 0;

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    // 把 assistant 的完整消息（含 tool_calls）写回历史
    messages.push(assistantMsg);

    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      // 普通文本回复 → 结束
      finalReply = assistantMsg.content ?? '';
      break;
    }

    // 执行所有 tool calls，每个对应一条 role:tool 消息
    for (const tc of assistantMsg.tool_calls) {
      if (tc.type !== 'function') continue;
      toolCalls++;
      let parsedInput: Record<string, unknown>;
      try {
        parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        parsedInput = {};
      }
      const result = await executeTool(tc.function.name, parsedInput);
      if (tc.function.name === 'propose_order' && result.ok && result.data) {
        proposals.push(result.data as Record<string, unknown>);
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  if (!finalReply) {
    finalReply = '（达到工具调用上限，请重新组织你的需求再试一次）';
  }

  return {
    reply: finalReply,
    proposals,
    messages,
    debug: {
      toolCalls,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      totalTokens: totalPrompt + totalCompletion,
      model: env.OPENAI_MODEL,
    },
    mocked: false,
  };
}

// ── Mock 模式（没 API key 时也能 demo）──────────────────────
function mockTurn(history: ChatMessage[], userMessage: string): ChatTurnResult {
  const reply = `[Mock 模式 · OPENAI_API_KEY 未配置]
我会建议你试着说："明天去岘港的机票，2 个人，经济舱"。
真正接入 OpenAI 后，我会自动调 search_flights / propose_order 把订单草稿生成给你确认。

配置方式：
  export OPENAI_API_KEY=sk-...
  export OPENAI_MODEL=gpt-5-mini   # 可选，默认 gpt-5-mini
  cd backend && npm run dev`;
  return {
    reply,
    proposals: [],
    messages: [
      ...history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply },
    ],
    debug: { toolCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, model: env.OPENAI_MODEL },
    mocked: true,
  };
}
