/**
 * AI 订票助手（beta）
 *
 * 用 claude-sonnet-4-6 做对话 + tool use loop。
 * 工具：search_flights, get_flight_price, propose_order
 *
 * 安全护栏：
 *   - propose_order 只 dry-run（返 quote），不真创建订单
 *   - 真下单走前端「确认」按钮 → 现有 POST /orders/ 流程
 *   - 系统提示词反复强调"不能编造旅客信息 / 不能跳过用户确认"
 *
 * Prompt caching：
 *   - 系统提示词 + 工具定义在 cache_control 里 → 第二次起 ~90% 折扣
 *   - 用户消息和工具结果不缓存（每次都不同）
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { PricingService } from '../modules/pricing/pricing.service.js';
import { CabinClass } from '@prisma/client';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 8; // 防止 loop 失控

// ── 系统提示词（cache 友好；不要插入时间戳/UUID 等变化值）─────
const SYSTEM_PROMPT = `你是「世途旅行」的客服 AI 助手，帮客户预订澳门 ⇌ 岘港的机票。

# 你的工作流程
1. 听用户说想要什么（日期 / 目的地 / 人数 / 舱位）
2. 调 search_flights 找航班
3. 用人话总结 2-3 个选项给用户（包括动态价 + 日期等级）
4. 用户选了具体航班后，调 get_flight_price 算精确价
5. 调 propose_order 生成"订单草稿"
6. 让 UI 展示草稿卡片，提示用户点「确认下单」

# 严格不能做的事
- 绝对不能编造航班 / 价格 / 旅客信息（必须从工具返回值读）
- 绝对不能跳过用户确认就下单（你只能 propose_order，不能真创建订单）
- 不能填假的护照号 / 出生日期；旅客信息必须用户在结账页自己填
- 不能讨论政治、暴力、医疗等无关话题

# 关于价格
- basePrice = 标价；dynamicPrice = 实际成交价
- dateRank A/B/C/D 是日期等级：A 最旺(×1.5)，D 最淡(×0.8)
- 价格随余位升档（卖得越多越贵），主动提醒用户"现在锁价划算"

# 对话风格
- 简洁，不啰嗦
- 每次最多介绍 3 个航班选项；多了用户记不住
- 主动追问关键缺失信息（出发日期 / 人数 / 舱位偏好）
- 用 ¥ 而不是 RMB
- 出发地默认澳门 (MFM)，目的地默认岘港 (DAD)

# 当前默认参数（用户没说就用这些）
- origin: MFM, destination: DAD
- cabin: ECONOMY
- passengers: 1`;

// ── 工具定义（也参与 cache）──────────────────────────────────
const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'search_flights',
    description:
      '搜索澳门 ⇌ 岘港的航班。返回班次列表，每个班次含多个舱位的动态价、日期等级、余位。' +
      '如果客户没指定日期，date 留空就返回全部未来 50 个班次。',
    input_schema: {
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
      required: [],
    },
  },
  {
    name: 'get_flight_price',
    description:
      '查询某个特定航班 + 舱位 + 数量的精确价格明细（每张票一个 unitPrice，跨 bucket 时单价不同）。' +
      '在用户已经选定了一个具体班次后调，给客户报最终价。',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: '航班 scheduleId，从 search_flights 返回' },
        cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] },
        qty: { type: 'integer', minimum: 1, maximum: 9 },
      },
      required: ['scheduleId', 'cabin', 'qty'],
    },
  },
  {
    name: 'propose_order',
    description:
      '生成"订单草稿"（dry-run，不真扣库存、不真扣钱）。' +
      '调完返回订单摘要 → 前端会渲染一张确认卡片让用户点「确认下单」。' +
      '只有用户在卡片上点了确认，才会真正创建订单。',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string' },
        cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] },
        passengers: { type: 'integer', minimum: 1, maximum: 9 },
      },
      required: ['scheduleId', 'cabin', 'passengers'],
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

    // 给每个班次的每个舱位算动态价
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

async function executeProposeOrder(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    // dry-run：算价 + 拼出"草稿"返回，但不真 createOrder
    const scheduleId = input.scheduleId as string;
    const cabin = input.cabin as CabinClass;
    const passengers = input.passengers as number;

    const pricing = await pricingService.calculatePrice(scheduleId, cabin, passengers);
    const schedule = await prisma.flightSchedule.findUnique({
      where: { id: scheduleId },
      include: { flight: true },
    });
    if (!schedule) {
      return { ok: false, error: '该班次不存在' };
    }

    const proposal = {
      kind: 'PROPOSAL' as const,
      scheduleId,
      cabin,
      passengers,
      flightNumber: schedule.flight.flightNumber,
      origin: schedule.flight.originCode,
      destination: schedule.flight.destinationCode,
      departureTime: schedule.departureTime.toISOString(),
      arrivalTime: schedule.arrivalTime.toISOString(),
      pricing: {
        unitPrice: pricing.averageUnitPrice,
        totalPrice: pricing.totalPrice,
        dateRank: pricing.dateRank,
        bucketBreakdown: pricing.perSeatBreakdown,
      },
      // 给前端渲染确认卡用：直接拼到 cart.add() 的 payload
      cartItem: {
        kind: 'FLIGHT',
        productId: scheduleId,
        name: `${schedule.flight.flightNumber} ${schedule.flight.originCode}→${schedule.flight.destinationCode} · ${cabin} × ${passengers}`,
        unitPrice: pricing.totalPrice,
        qty: 1,
        meta: { cabin, passengers, dateRank: pricing.dateRank, totalForQty: pricing.totalPrice },
      },
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
    case 'propose_order':
      return executeProposeOrder(input);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ── 主入口 ───────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | Array<Anthropic.Messages.ContentBlockParam>;
}

export interface ChatTurnResult {
  /** 助手最终自然语言回复 */
  reply: string;
  /** 助手生成的草稿（如有），UI 用来渲染确认卡 */
  proposals: Array<Record<string, unknown>>;
  /** 完整对话上下文（前端下次 chat 要带回来） */
  messages: ChatMessage[];
  /** 调试信息：用了几次 tool call，token 用量 */
  debug: {
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
  /** 是否走了 mock 模式（API key 未配） */
  mocked: boolean;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * 跑一轮对话：
 *   1. 把历史消息 + 新用户消息 → Claude
 *   2. 如果 stop_reason=tool_use，执行工具，把结果加进 messages，再调一次
 *   3. 直到 stop_reason=end_turn
 *
 * 注意：messages 长度 > 4096 token 时建议前端做截断（保最近 N 条）。
 */
export async function runChatTurn(
  history: ChatMessage[],
  userMessage: string,
): Promise<ChatTurnResult> {
  const client = getClient();
  if (!client) {
    return mockTurn(history, userMessage);
  }

  const messages: ChatMessage[] = [...history, { role: 'user', content: userMessage }];

  let toolCalls = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  const proposals: Array<Record<string, unknown>> = [];
  let finalReply = '';

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // System + tools 缓存（5 min TTL，第二次起便宜 ~90%）
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: TOOLS,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content as Anthropic.Messages.ContentBlockParam[] | string,
      })),
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    totalCacheRead += response.usage.cache_read_input_tokens ?? 0;

    // 把 assistant 的完整 content 写回历史
    messages.push({ role: 'assistant', content: response.content });

    // 找 tool_use blocks
    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      // end_turn — 提取最终文本
      finalReply = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }

    // 执行所有 tool calls，结果作为下一个 user 消息
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      const result = await executeTool(tu.name, tu.input as Record<string, unknown>);
      // 收集 propose_order 的草稿给前端渲染
      if (tu.name === 'propose_order' && result.ok && result.data) {
        proposals.push(result.data as Record<string, unknown>);
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
    }
    messages.push({ role: 'user', content: toolResults });
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
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
    },
    mocked: false,
  };
}

// ── Mock 模式（没 API key 时也能 demo）──────────────────────
function mockTurn(history: ChatMessage[], userMessage: string): ChatTurnResult {
  const reply = `[Mock 模式 · ANTHROPIC_API_KEY 未配置]
我会建议你试着说："明天去岘港的机票，2 个人，经济舱"。
真正接入 Claude 后，我会自动调 search_flights / propose_order 把订单草稿生成给你确认。`;
  return {
    reply,
    proposals: [],
    messages: [...history, { role: 'user', content: userMessage }, { role: 'assistant', content: reply }],
    debug: { toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    mocked: true,
  };
}
