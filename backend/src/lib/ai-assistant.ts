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
const SYSTEM_PROMPT = `你是「世途旅行」的客服 AI 助手，帮客户预订澳门 ⇌ 岘港旅行的全套产品。

# 你能搜的 5 类产品（都通过 tool 调用，不要凭记忆）
- ✈️ **机票** — search_flights / get_flight_price（只有 MFM ⇌ DAD 这条线）
- 🛂 **签证** — search_visas（越南最常用；东南亚 7 国都有）
- 🏨 **酒店** — search_hotels（岘港多家；返回各房型 ¥/晚）
- 🚗 **接送** — search_transfers（机场接送 / 包车）
- 🎁 **套餐** — search_bundles（一价全包：机票+酒店+接送+签证 + 让利）

# 工作流程
1. 听用户说想要什么（去程日期 / 回程日期 / 人数 / 是否含酒店签证接送 / 是否要套餐）
2. **【硬规则】机票永远按往返查**——这是世途的主营业务，95% 客户都是来回行程。
   - 用户没说"单程"两个字 → 必须按往返做
   - 用户只说了一个日期 → **先反问** "回程哪天回？" 不要直接做单程
   - 用户说了"明天去"（没说回） → **追问** "您计划玩几天？什么时候回？"
   - 只有用户明确写"我只要单程"、"one way"、"不要回程" → 才做单程
   - 调 search_flights 两次：
     · 去程：origin=MFM, destination=DAD, date=去程日期
     · 回程：origin=DAD, destination=MFM, date=回程日期
3. 用人话总结 2-3 个组合给用户（去 + 回 一对一对介绍，不要散列）
4. 用户选定后用 propose_order 生成"订单草稿"
   - **往返必须 2 个 FLIGHT items**（去程 + 回程都加进 items 数组）
   - 每个 FLIGHT item 的 passengers 字段 = 该方向同行人数（往返同一批人，两边一样）
5. UI 展示卡片 → 用户点「确认下单」 → 加购后立刻提示上传 N 本护照
   （N = 出行人数 = 每个 FLIGHT item 的 passengers，不是 SUM）

# propose_order items 用法（必看）
- FLIGHT: { kind:'FLIGHT', scheduleId, cabin: 'ECONOMY'|'BUSINESS', passengers }
- VISA: { kind:'VISA', visaId, qty (一般=机票乘客数), express?:bool }
- HOTEL: { kind:'HOTEL', hotelRoomTypeId, checkIn:'YYYY-MM-DD', checkOut:'YYYY-MM-DD', rooms? (默认 1) }
- TRANSFER: { kind:'TRANSFER', transferId, qty (车次/趟数) }
- BUNDLE: { kind:'BUNDLE', bundleId, pax (人数), rooms? }

混搭例：用户要"5 月 1 号 2 人去岘港 3 晚 + 越南签证 + 接机"
items=[
  {kind:'FLIGHT', scheduleId:'...', cabin:'ECONOMY', passengers:2},
  {kind:'HOTEL', hotelRoomTypeId:'...', checkIn:'2026-05-01', checkOut:'2026-05-04', rooms:1},
  {kind:'TRANSFER', transferId:'...', qty:1},
  {kind:'VISA', visaId:'...', qty:2}
]

# 套餐 vs 自由组合
- 用户犹豫不决或想"一价全包" → 推套餐
- 用户已经知道要哪班机票/哪家酒店 → 自由组合
- 套餐价是估算（最终下单按当日动态价重算）—— 主动告诉用户

# 【重要】BUNDLE 定价规则（避免漏付）
- BUNDLE 单 item **只含地面服务**（酒店/接送/签证）的让利价，**不含机票**
- 推 BUNDLE 时 propose_order 必须同时加 **2 个 FLIGHT items**（去程 + 回程）才算完整
- 例：用户要"5/1-5/4 2 人岘港全包套餐"，items 应该是：
  · BUNDLE { bundleId, pax: 2, rooms: 1 }
  · FLIGHT { scheduleId: 去程, cabin: 'ECONOMY', passengers: 2 }
  · FLIGHT { scheduleId: 回程, cabin: 'ECONOMY', passengers: 2 }
- 客户最终付款 = BUNDLE 地面价 + 2×FLIGHT 动态价
- detail.grossTotalEstimate 是含机票估算的"全包价感觉"仅供口头展示

# 严格不能做的事
- 绝对不能编造航班 / 价格 / 签证 / 酒店 / 旅客信息（必须从工具返回值读）
- 绝对不能跳过用户确认就下单（你只能 propose_order，不能真创建订单）
- 不能填假的护照号 / 出生日期；旅客信息用户自己填或 OCR 上传
- 不能讨论政治、暴力、医疗等无关话题

# 关于护照 OCR
- 用户可能上传护照照片，前端 OCR 后把识别结果作为 \`[系统提示]\` 消息发给你
- 看到时简短确认（"收到了，张三的护照已登记"），告诉用户在结账页自动填好；不要追问已识别的字段

# 关于价格
- basePrice = 标价；dynamicPrice = 实际成交价（搜索时直接显示成交价即可）
- **【内部信息·永远不要告诉客户】** dateRank A/B/C/D 是公司内部日期等级（A=旺×1.5, D=淡×0.8）
  · 不说"日期等级 D"、"rank C"、"等级 A 较贵"、"D 档便宜"等任何 A/B/C/D 字样
  · 不说"价格随等级"、"日期评级"、"今天是淡季档"等暗示内部分级的话
  · 客户只看到一个最终成交价 ¥X，不解释为什么是这个数
- 鼓励锁价用泛化语言：「这个时间段相对平价」「最近预定的人不多」「过几天可能会涨」
  不要说「因为是 D 档/淡季档/低等级」

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
        'countryCode 可省略（返回所有国家）；常见：VN(越南) KH(柬埔寨) TH(泰国) SG(新加坡) LA(老挝) MY(马来) ID(印尼)',
      parameters: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', description: '目的地国家 ISO 代码，例 VN；省略 = 所有国家' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_hotels',
      description:
        '搜索酒店（含每个酒店的多种房型）。用户问酒店或想要"机票+酒店"组合时调。返回酒店列表 + rooms 数组（每房型有 hotelRoomTypeId / 床型 / 容量 / ¥/晚）。',
      parameters: {
        type: 'object',
        properties: {
          cityCode: { type: 'string', description: '城市代码，例 DAD(岘港)；省略 = 所有城市' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_transfers',
      description:
        '搜索机场接送 / 包车服务。用户问"接机/包车/巴拿山一日游/会安专车"等都调这个。' +
        '不传 query 返回全部 6 个产品（推荐：直接不传，让用户挑）。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '可选模糊关键词，跨 name/origin/dest 匹配（如 "机场" / "巴拿山" / "会安"）。不传 = 全部',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_bundles',
      description:
        '查全部"一价全包"套餐（机票+酒店+接送+签证打包）。用户问"套餐"或"打包优惠"时调。注意：套餐价是估算值，最终下单按当日动态价重算。',
      parameters: {
        type: 'object',
        properties: {},
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
        '支持多产品组合：items 数组里混合 FLIGHT / VISA / HOTEL / TRANSFER / BUNDLE。\n' +
        '老的单航班调用方式（顶层 scheduleId/cabin/passengers）仍兼容。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description:
              '订单产品列表。每个 item 必填字段不同：\n' +
              '- FLIGHT: scheduleId, cabin, passengers\n' +
              '- VISA: visaId, qty (一般=机票乘客数), express? (加急)\n' +
              '- HOTEL: hotelRoomTypeId, checkIn (YYYY-MM-DD), checkOut, rooms? (默认1)\n' +
              '- TRANSFER: transferId, qty (车次)\n' +
              '- BUNDLE: bundleId, pax (人数), rooms? (默认1)',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['FLIGHT', 'VISA', 'HOTEL', 'TRANSFER', 'BUNDLE'],
                },
                scheduleId: { type: 'string' },
                cabin: { type: 'string', enum: ['ECONOMY', 'BUSINESS'] },
                passengers: { type: 'integer', minimum: 1, maximum: 9 },
                visaId: { type: 'string' },
                qty: { type: 'integer', minimum: 1, maximum: 20 },
                express: { type: 'boolean' },
                hotelRoomTypeId: { type: 'string' },
                checkIn: { type: 'string', description: 'YYYY-MM-DD' },
                checkOut: { type: 'string', description: 'YYYY-MM-DD' },
                rooms: { type: 'integer', minimum: 1, maximum: 10 },
                transferId: { type: 'string' },
                bundleId: { type: 'string' },
                pax: { type: 'integer', minimum: 1, maximum: 9 },
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

async function executeSearchHotels(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    const cityCode = input.cityCode as string | undefined;
    const where: Record<string, unknown> = { isActive: true };
    if (cityCode) where.cityCode = cityCode;
    const hotels = await prisma.hotel.findMany({
      where,
      include: { roomTypes: true },
      take: 15,
    });
    return {
      ok: true,
      data: {
        count: hotels.length,
        hotels: hotels.map((h) => ({
          hotelId: h.id,
          name: h.name,
          cityCode: h.cityCode,
          area: h.area,
          starRating: h.starRating,
          rating: h.rating ? Number(h.rating) : null,
          highlight: h.highlight,
          amenities: h.amenities,
          rooms: h.roomTypes.map((rt) => ({
            hotelRoomTypeId: rt.id,
            name: rt.name,
            bedType: rt.bedType,
            capacity: rt.capacity,
            basePrice: Number(rt.basePrice), // ¥/晚
          })),
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'search_hotels failed' };
  }
}

async function executeSearchTransfers(input: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    const query = input.query as string | undefined;
    const where: Record<string, unknown> = { isActive: true };
    if (query) {
      // 跨 name / originArea / destArea 模糊匹配（OR）
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { originArea: { contains: query, mode: 'insensitive' } },
        { destArea: { contains: query, mode: 'insensitive' } },
      ];
    }
    const transfers = await prisma.transfer.findMany({ where, take: 20 });
    return {
      ok: true,
      data: {
        count: transfers.length,
        transfers: transfers.map((t) => ({
          transferId: t.id,
          name: t.name,
          vehicleType: t.vehicleType,
          capacity: t.capacity,
          originArea: t.originArea,
          destArea: t.destArea,
          basePrice: Number(t.basePrice),
          duration: t.duration,
          features: t.features,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'search_transfers failed' };
  }
}

async function executeSearchBundles(): Promise<ToolExecutionResult> {
  try {
    const bundles = await prisma.bundle.findMany({ where: { isActive: true }, take: 20 });
    return {
      ok: true,
      data: {
        count: bundles.length,
        bundles: bundles.map((b) => ({
          bundleId: b.id,
          name: b.name,
          tagline: b.tagline,
          flightPax: b.flightPax, // 套餐内含的机票人数（不含税前）
          groundDiscount: Number(b.groundDiscount),
          suitableFor: b.suitableFor,
          // items 字段是 [{kind, productName, qty, unitPrice}] 的 JSON，给 AI 看大致组成
          components: b.items,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'search_bundles failed' };
  }
}

interface ProposalItemInput {
  kind: 'FLIGHT' | 'VISA' | 'HOTEL' | 'TRANSFER' | 'BUNDLE';
  // FLIGHT
  scheduleId?: string;
  cabin?: CabinClass;
  passengers?: number;
  // VISA
  visaId?: string;
  qty?: number;
  express?: boolean;
  // HOTEL
  hotelRoomTypeId?: string;
  checkIn?: string;
  checkOut?: string;
  rooms?: number;
  // TRANSFER
  transferId?: string;
  // BUNDLE
  bundleId?: string;
  pax?: number;
}

interface ProposalItemOut {
  kind: 'FLIGHT' | 'VISA' | 'HOTEL' | 'TRANSFER' | 'BUNDLE';
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

async function priceHotelItem(item: ProposalItemInput): Promise<ProposalItemOut | { error: string }> {
  if (!item.hotelRoomTypeId || !item.checkIn || !item.checkOut) {
    return { error: 'HOTEL item 需要 hotelRoomTypeId / checkIn / checkOut（YYYY-MM-DD）' };
  }
  const rooms = item.rooms && item.rooms > 0 ? item.rooms : 1;
  const ci = new Date(`${item.checkIn}T00:00:00Z`);
  const co = new Date(`${item.checkOut}T00:00:00Z`);
  const nights = Math.round((co.getTime() - ci.getTime()) / 86_400_000);
  if (Number.isNaN(nights) || nights <= 0) {
    return { error: 'checkOut 必须晚于 checkIn' };
  }
  const roomType = await prisma.hotelRoomType.findUnique({
    where: { id: item.hotelRoomTypeId },
    include: { hotel: true },
  });
  if (!roomType) return { error: `房型 ${item.hotelRoomTypeId} 不存在` };
  const unitPrice = Number(roomType.basePrice); // ¥/晚/间
  const total = unitPrice * nights * rooms;
  const name = `${roomType.hotel.name} · ${roomType.name} × ${rooms} 间 × ${nights} 晚`;
  return {
    kind: 'HOTEL',
    name,
    qty: rooms * nights,
    unitPrice,
    total,
    detail: {
      hotelName: roomType.hotel.name,
      roomTypeName: roomType.name,
      bedType: roomType.bedType,
      capacity: roomType.capacity,
      starRating: roomType.hotel.starRating,
      area: roomType.hotel.area,
      checkIn: item.checkIn,
      checkOut: item.checkOut,
      nights,
      rooms,
      pricePerNight: unitPrice,
      amenities: roomType.hotel.amenities,
    },
    cartItem: {
      kind: 'HOTEL',
      productId: roomType.id,
      name,
      emoji: '🏨',
      unitPrice,
      qty: nights * rooms, // 用 qty 表达"间夜数"，与 sales-web cart 习惯对齐
      meta: {
        hotelName: roomType.hotel.name,
        roomTypeName: roomType.name,
        checkIn: item.checkIn,
        checkOut: item.checkOut,
        nights,
        rooms,
      },
    },
  };
}

async function priceTransferItem(item: ProposalItemInput): Promise<ProposalItemOut | { error: string }> {
  if (!item.transferId || !item.qty) {
    return { error: 'TRANSFER item 需要 transferId / qty' };
  }
  const transfer = await prisma.transfer.findUnique({ where: { id: item.transferId } });
  if (!transfer) return { error: `接送服务 ${item.transferId} 不存在` };
  const unitPrice = Number(transfer.basePrice);
  const total = unitPrice * item.qty;
  const name = `${transfer.name} × ${item.qty}`;
  return {
    kind: 'TRANSFER',
    name,
    qty: item.qty,
    unitPrice,
    total,
    detail: {
      vehicleType: transfer.vehicleType,
      capacity: transfer.capacity,
      originArea: transfer.originArea,
      destArea: transfer.destArea,
      duration: transfer.duration,
      features: transfer.features,
    },
    cartItem: {
      kind: 'TRANSFER',
      productId: transfer.id,
      name,
      emoji: transfer.emoji ?? '🚗',
      unitPrice,
      qty: item.qty,
      meta: {
        vehicleType: transfer.vehicleType,
        capacity: transfer.capacity,
      },
    },
  };
}

async function priceBundleItem(item: ProposalItemInput): Promise<ProposalItemOut | { error: string }> {
  if (!item.bundleId) {
    return { error: 'BUNDLE item 需要 bundleId' };
  }
  const pax = item.pax && item.pax > 0 ? item.pax : 1;
  const rooms = item.rooms && item.rooms > 0 ? item.rooms : 1;
  const bundle = await prisma.bundle.findUnique({ where: { id: item.bundleId } });
  if (!bundle) return { error: `套餐 ${item.bundleId} 不存在` };

  // 套餐定价：照搬 BundlesPage 的简化模型 — 地面组件用 unitPrice * qty，按 pax/rooms 缩放，
  // 减去 groundDiscount 拿地面价；再加上 ¥1480 × pax 估算机票（避免再调 pricing service）
  // 注意：真下单时 createOrder 会重新算价，这里只是给 AI 一个 quote 让用户决定
  type BundleComponent = { kind: string; qty: number; unitPrice: number; productName?: string };
  const components = (bundle.items as unknown as BundleComponent[]) ?? [];
  let groundTotal = 0;
  const ITEMS_PER_PAX = new Set(['VISA']); // 按人数缩放
  const ITEMS_PER_ROOM = new Set(['HOTEL']); // 按房间数缩放
  for (const c of components) {
    if (c.kind === 'FLIGHT') continue; // 机票单独算
    const scale =
      ITEMS_PER_PAX.has(c.kind) ? pax :
      ITEMS_PER_ROOM.has(c.kind) ? rooms :
      1;
    groundTotal += c.unitPrice * c.qty * scale;
  }
  const flightEstimate = 1480 * pax * 2; // 来回 × pax，估算占位（仅展示用）
  const discount = Number(bundle.groundDiscount);
  // CRITICAL: cartItem.unitPrice 必须与 backend createOrder 重算的 BUNDLE 价一致
  // backend BUNDLE = ground - discount（飞机另算成 FLIGHT items）。
  // 之前 bug：cartItem.unitPrice 含 flightEstimate → 客户少付 ¥flightEstimate（Codex P1 review）
  // 修复：cartItem 只算 ground 部分；客户想含飞机要 AI 额外加 2 个 FLIGHT items
  const bundleGroundPrice = Math.max(0, Math.round(groundTotal - discount));
  const grossTotalEstimate = bundleGroundPrice + flightEstimate;
  const name = `${bundle.name} 地面服务 · ${pax} 人${rooms !== 1 ? ` · ${rooms} 间` : ''}`;

  return {
    kind: 'BUNDLE',
    name,
    qty: pax,
    unitPrice: Math.round(bundleGroundPrice / pax),
    total: bundleGroundPrice, // 与实际入车的钱一致（不含机票）
    detail: {
      bundleName: bundle.name,
      tagline: bundle.tagline,
      pax,
      rooms,
      components: components.map((c) => ({
        kind: c.kind,
        productName: c.productName,
        qty: c.qty,
      })),
      groundDiscount: discount,
      flightEstimate,
      groundTotal,
      grossTotalEstimate,
      note: '⚠️ BUNDLE 只含地面服务（酒店/接送/签证）让利价；机票需 AI 另外用 FLIGHT items 加（否则漏付）。grossTotalEstimate 是含机票估算的全包价，仅供向客户展示参考。',
    },
    cartItem: {
      kind: 'BUNDLE',
      productId: bundle.id,
      name,
      emoji: bundle.emoji ?? '🎁',
      unitPrice: bundleGroundPrice, // 地面价（与 backend createOrder 同步）
      qty: 1,
      meta: { pax, rooms, groundDiscount: discount },
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
      switch (it.kind) {
        case 'FLIGHT':   result = await priceFlightItem(it); break;
        case 'VISA':     result = await priceVisaItem(it); break;
        case 'HOTEL':    result = await priceHotelItem(it); break;
        case 'TRANSFER': result = await priceTransferItem(it); break;
        case 'BUNDLE':   result = await priceBundleItem(it); break;
        default:
          return { ok: false, error: `Unknown item kind: ${(it as ProposalItemInput).kind}` };
      }
      if ('error' in result) return { ok: false, error: result.error };
      priced.push(result);
    }

    const totalPrice = priced.reduce((s, p) => s + p.total, 0);

    const KIND_EMOJI: Record<string, string> = {
      FLIGHT: '✈️',
      VISA: '🛂',
      HOTEL: '🏨',
      TRANSFER: '🚗',
      BUNDLE: '🎁',
    };
    const proposal = {
      kind: 'PROPOSAL' as const,
      items: priced,
      totalPrice,
      summary:
        priced
          .map((p) => `${KIND_EMOJI[p.kind] ?? ''} ${p.name}`)
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
    case 'search_hotels':
      return executeSearchHotels(input);
    case 'search_transfers':
      return executeSearchTransfers(input);
    case 'search_bundles':
      return executeSearchBundles();
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
// 启发式规则解析常见意图（机票/酒店/签证/接送/套餐 + 日期 + 人数 + 舱位），
// 调真实 tool executor 取库存数据 + 用 propose_order 生成订单草稿。
// 适合：没 AI API key 时演示完整下单流程；OpenAI 被地区屏蔽时兜底。
async function mockTurn(history: ChatMessage[], userMessage: string): Promise<ChatTurnResult> {
  const intent = parseUserIntent(userMessage);
  const proposals: Array<Record<string, unknown>> = [];
  let reply = '';

  try {
    if (intent.kind === 'greeting') {
      reply = '你好！我可以帮你订澳门 ↔ 岘港的机票、岘港酒店、接送、越南签证，或者一价全包套餐。\n\n你可以这样说：\n· "明天去岘港，2 人经济舱"\n· "下周三去岘港，3 晚海景酒店"\n· "越南签证，急加"\n· "看下套餐推荐"';
    } else if (intent.kind === 'flight') {
      const flights = await executeSearchFlights({
        origin: 'MFM',
        destination: 'DAD',
        date: intent.date,
        cabin: intent.cabin,
        passengers: intent.passengers,
      });
      if (flights.ok && Array.isArray((flights.data as Record<string, unknown>)?.results)) {
        const results = (flights.data as { results: Array<Record<string, unknown>> }).results;
        if (results.length > 0) {
          const f = results[0];
          const scheduleId = f.scheduleId as string;
          const selectedCabin = intent.cabin ?? 'ECONOMY';
          const prop = await executeProposeOrder({
            items: [{ kind: 'FLIGHT', scheduleId, cabin: selectedCabin, passengers: intent.passengers }],
          });
          if (prop.ok && prop.data) {
            proposals.push(prop.data as Record<string, unknown>);
            const dateLabel = intent.date ?? '最近一天';
            reply = `好的，给你找到 ${dateLabel} 澳门 → 岘港的航班，${intent.passengers} 人 ${cabinLabel(selectedCabin)}。\n方案已经准备好，确认下单点 "确认" 即可。`;
          } else {
            reply = `找到航班但生成方案时出错了：${prop.ok ? '未知错误' : prop.error}。可以试着说 "${results[0].flightNumber} ${intent.passengers} 人经济舱" 让我再试一次。`;
          }
        } else {
          reply = `${intent.date ? intent.date : '该日期'} 暂时没有符合条件的航班。我们的 QH9588/9589 每天 1 班，可以换个日期试试。`;
        }
      } else {
        reply = '航班查询失败，请稍后重试。或者直接说 "明天去岘港 2 人经济舱"。';
      }
    } else if (intent.kind === 'hotel') {
      const hotels = await executeSearchHotels({});
      if (hotels.ok && Array.isArray((hotels.data as Record<string, unknown>)?.hotels)) {
        const hs = (hotels.data as { hotels: Array<Record<string, unknown>> }).hotels;
        reply = `岘港和会安一带我们直签了 ${hs.length} 家酒店，价格从 ¥${hs[hs.length - 1]?.basePrice ?? 1480} / 晚起：\n` +
          hs.slice(0, 3).map((h, i) => `${i + 1}. ${h.name} — ¥${h.basePrice}/晚 · ${h.highlight ?? ''}`).join('\n') +
          '\n\n告诉我哪家 + 几晚，我帮你算总价。';
      } else {
        reply = '酒店列表加载失败，请稍后重试。';
      }
    } else if (intent.kind === 'visa') {
      const visas = await executeSearchVisas({});
      if (visas.ok && Array.isArray((visas.data as Record<string, unknown>)?.visas)) {
        const vs = (visas.data as { visas: Array<Record<string, unknown>> }).visas;
        const vn = vs.find((v) => (v.destinationCountry as string) === 'VN') ?? vs[0];
        reply = `越南签证我们能办几种：\n` +
          vs.filter((v) => (v.destinationCountry as string) === 'VN').slice(0, 3).map((v, i) => `${i + 1}. ${v.visaName ?? v.visaType} — ¥${v.basePrice} · ${v.processingDays} 个工作日`).join('\n') +
          (vn ? `\n\n最常用的是 ${vn.visaName ?? 'E-visa'}，需要护照首页 + 证件照。要办几位？` : '');
      } else {
        reply = '签证产品加载失败。常用的：越南 E-visa ¥280/人，5 个工作日出。';
      }
    } else if (intent.kind === 'transfer') {
      const ts = await executeSearchTransfers({});
      if (ts.ok && Array.isArray((ts.data as Record<string, unknown>)?.transfers)) {
        const tr = (ts.data as { transfers: Array<Record<string, unknown>> }).transfers;
        reply = `岘港接送/包车有 ${tr.length} 种车型：\n` +
          tr.slice(0, 4).map((t, i) => `${i + 1}. ${t.name} — ¥${t.basePrice}起`).join('\n') +
          '\n\n说一下日期 + 起止地点，我帮你算价。';
      } else {
        reply = '接送产品加载失败。';
      }
    } else if (intent.kind === 'bundle') {
      const bd = await executeSearchBundles();
      if (bd.ok && Array.isArray((bd.data as Record<string, unknown>)?.bundles)) {
        const bs = (bd.data as { bundles: Array<Record<string, unknown>> }).bundles;
        reply = `我们有 ${bs.length} 个套餐：\n` +
          bs.map((b, i) => `${i + 1}. ${b.name} — ${b.tagline}（地面省 ¥${b.groundDiscount}）`).join('\n') +
          '\n\n哪个套餐适合你？告诉我出行日期和人数。';
      } else {
        reply = '套餐列表加载失败。';
      }
    } else {
      reply = `我没完全 get 到你的意思。你可以试着说：\n· "明天 2 人去岘港，经济舱"\n· "推荐岘港 3 晚海景酒店"\n· "越南签证"\n· "套餐推荐"`;
    }
  } catch (err) {
    reply = `本地演示遇到点小问题：${err instanceof Error ? err.message : String(err)}\n可以稍等再试。`;
  }

  return {
    reply,
    proposals,
    messages: [
      ...history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: reply },
    ],
    debug: { toolCalls: proposals.length, promptTokens: 0, completionTokens: 0, totalTokens: 0, model: env.OPENAI_MODEL },
    mocked: true,
  };
}

// 启发式解析用户消息：抓意图 + 日期 + 人数 + 舱位
interface ParsedIntent {
  kind: 'greeting' | 'flight' | 'hotel' | 'visa' | 'transfer' | 'bundle' | 'unknown';
  date?: string;
  passengers: number;
  cabin?: CabinClass;
}

function parseUserIntent(msg: string): ParsedIntent {
  const m = msg.trim().toLowerCase();
  const passengers = parsePassengers(msg);
  const cabin = parseCabin(m);
  const date = parseDate(m);

  if (/^(hi|hello|你好|您好|hey)\s*[，,。.！!？?]*$/.test(m) || m.length < 3) {
    return { kind: 'greeting', passengers, cabin, date };
  }
  if (/机票|航班|飞机|flight|airline|tickets?|经济舱|商务舱|头等舱|business|economy/.test(m)) {
    return { kind: 'flight', passengers, cabin, date };
  }
  if (/酒店|住|宿|入住|hotel|resort|stay/.test(m)) {
    return { kind: 'hotel', passengers, cabin, date };
  }
  if (/签证|visa|出签|护照|passport/.test(m) && !/送/.test(m)) {
    return { kind: 'visa', passengers, cabin, date };
  }
  if (/接送|包车|接机|送机|transfer|车|taxi|driver|chauffeur/.test(m)) {
    return { kind: 'transfer', passengers, cabin, date };
  }
  if (/套餐|bundle|package|combo|deal/.test(m)) {
    return { kind: 'bundle', passengers, cabin, date };
  }
  if (date || passengers > 1) {
    return { kind: 'flight', passengers, cabin, date };
  }
  return { kind: 'unknown', passengers, cabin, date };
}

function parsePassengers(msg: string): number {
  const m = msg.match(/(\d+)\s*(?:个人|个|人|大人|位|pax|people|adults?|persons?|名)/i);
  if (m) return Math.min(Math.max(parseInt(m[1], 10), 1), 9);
  return 1;
}

function parseCabin(msg: string): CabinClass | undefined {
  if (/头等舱|first[\s-]?class/.test(msg)) return 'FIRST' as CabinClass;
  if (/商务舱|business[\s-]?class/.test(msg)) return 'BUSINESS' as CabinClass;
  if (/超级经济舱|premium[\s-]?economy/.test(msg)) return 'PREMIUM_ECONOMY' as CabinClass;
  if (/经济舱|economy/.test(msg)) return 'ECONOMY' as CabinClass;
  return undefined;
}

function parseDate(msg: string): string | undefined {
  const now = new Date();
  const y = now.getFullYear();
  if (/明天|tomorrow|tmr/i.test(msg)) return offsetDate(now, 1);
  if (/后天|day after tomorrow/i.test(msg)) return offsetDate(now, 2);
  if (/大后天/.test(msg)) return offsetDate(now, 3);
  const weekdayMap: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
  };
  const nextWeek = msg.match(/下周([一二三四五六日天])|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (nextWeek) {
    const key = (nextWeek[1] || nextWeek[2]).toLowerCase();
    const target = weekdayMap[key];
    if (target !== undefined) {
      const today = now.getDay();
      const diff = (7 - today + target) % 7 || 7;
      return offsetDate(now, diff);
    }
  }
  let m = msg.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = msg.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = msg.match(/\b(\d{1,2})[-/](\d{1,2})\b/);
  if (m) return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return undefined;
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function cabinLabel(c: CabinClass): string {
  return { ECONOMY: '经济舱', PREMIUM_ECONOMY: '超级经济舱', BUSINESS: '商务舱', FIRST: '头等舱' }[c] ?? c;
}
