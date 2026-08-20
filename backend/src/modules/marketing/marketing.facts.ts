/**
 * 海报事实层 —— 决定「海报上哪些字必须是真的」。
 *
 * 这是整个营销中心的地基：生图模型只负责背景，航班号、起降时刻这类硬数据
 * 一律从库里取，快照成 PosterFact[] 存进 MarketingPoster.facts，再由服务端代码绘制。
 * strict 保留用于事实元数据的兼容性与前端展示；它不再触发图片回读或重试。
 */
import { prisma } from '../../db/prisma.js';

export class MarketingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingInputError';
  }
}

export type PosterFactGroup = 'outbound' | 'inbound' | 'global';

/** 图上必须出现的一条事实。value 是期望原样出现的文本。 */
export interface PosterFact {
  key: string;
  /** 给运营看的中文名，出现在海报数据来源里 */
  label: string;
  /** 期望值：服务端叠字时使用的事实值 */
  value: string;
  /** 历史字段，保留用于兼容既有事实快照 */
  strict: boolean;
  /** 同一航段的事实归入同一张服务端绘制的卡片；非航段事实归入全局区域。 */
  group: PosterFactGroup;
}

export interface LegSummary {
  flightNumber: string;
  originCode: string;
  destinationCode: string;
  originName: string;
  destinationName: string;
  /** 当地时间 HH:mm */
  departTime: string;
  arriveTime: string;
}

/** 航线海报的人类可读摘要，用于拼 prompt 和列表展示。 */
export interface FlightRouteSummary {
  outbound: LegSummary;
  inbound: LegSummary | null;
  effectiveFrom: string | null;
  baggageText: string | null;
}

/**
 * 机场代码 → 中文名。
 * 与 admin-web/src/lib/airports.ts、sales-web/src/lib/airports.ts 同源 —— 改动请三处同步。
 * 后端只需要展示名这一列，故不复制完整的 AirportInfo 结构。
 */
const AIRPORT_NAMES: Record<string, string> = {
  DAD: '岘港',
  MFM: '澳门',
  HKG: '香港',
  HAN: '河内',
  SGN: '胡志明',
  CXR: '芽庄',
  PQC: '富国岛',
};

/** 查不到就退回代码本身 —— 海报上显示 IATA 码，总好过显示 undefined。 */
export function airportName(code: string): string {
  return AIRPORT_NAMES[code] ?? code;
}

/**
 * 按航段所在时区格式化成 HH:mm。
 *
 * 必须用 schedule 自带的 departureTz / arrivalTz，不能用服务器时区 ——
 * 澳门和岘港差 1 小时，用错时区海报上的时刻就是错的，而且错得很隐蔽。
 */
function formatLocalTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
}

interface LoadedLeg extends LegSummary {
  departureAt: Date;
  arrivalAt: Date;
}

async function loadLegWithInstants(scheduleId: string): Promise<LoadedLeg> {
  const s = await prisma.flightSchedule.findUnique({
    where: { id: scheduleId },
    include: { flight: true },
  });
  if (!s) throw new MarketingInputError(`航班班次不存在：${scheduleId}`);

  return {
    flightNumber: s.flight.flightNumber,
    originCode: s.flight.originCode,
    destinationCode: s.flight.destinationCode,
    originName: airportName(s.flight.originCode),
    destinationName: airportName(s.flight.destinationCode),
    departTime: formatLocalTime(s.departureTime, s.departureTz),
    arriveTime: formatLocalTime(s.arrivalTime, s.arrivalTz),
    departureAt: s.departureTime,
    arrivalAt: s.arrivalTime,
  };
}

export interface FlightRouteFactsInput {
  outboundScheduleId: string;
  /** 回程班次；不传就是单程海报 */
  returnScheduleId?: string;
  /** 如「8月21日起」，运营填，会原样印在海报上 */
  effectiveFrom?: string;
  /** 如「20KG+手提7KG」，库里没有这个字段，运营手填 */
  baggageText?: string;
}

export interface FlightRouteFactsResult {
  facts: PosterFact[];
  summary: FlightRouteSummary;
  /** 关联的去程航班 id，存进 MarketingPoster.flightId，便于按航线查历史海报 */
  flightId: string;
}

/** 把一个航段展开成 3 条海报事实（航班号 / 时刻 / 航线）。 */
function legFacts(leg: LegSummary, prefix: 'outbound' | 'inbound', cn: string): PosterFact[] {
  return [
    {
      key: `${prefix}.flightNumber`,
      label: `${cn}航班号`,
      value: leg.flightNumber,
      strict: true,
      group: prefix,
    },
    {
      // 时刻写成「15:45-16:30」连写形式，与海报模板排版一致。
      key: `${prefix}.time`,
      label: `${cn}时刻`,
      value: `${leg.departTime}-${leg.arriveTime}`,
      strict: true,
      group: prefix,
    },
    {
      key: `${prefix}.route`,
      label: `${cn}航线`,
      value: `${leg.originName} → ${leg.destinationName}`,
      strict: true,
      group: prefix,
    },
  ];
}

/** 构造航线海报的事实快照。 */
export async function buildFlightRouteFacts(
  input: FlightRouteFactsInput,
): Promise<FlightRouteFactsResult> {
  if (input.returnScheduleId === input.outboundScheduleId) {
    throw new MarketingInputError('回程班次校验失败：回程班次不能与去程班次相同');
  }

  const outbound = await loadLegWithInstants(input.outboundScheduleId);
  const inbound = input.returnScheduleId
    ? await loadLegWithInstants(input.returnScheduleId)
    : null;

  if (inbound) {
    const errors: string[] = [];
    if (
      inbound.originCode !== outbound.destinationCode ||
      inbound.destinationCode !== outbound.originCode
    ) {
      errors.push(
        `起降机场必须与去程互换（去程 ${outbound.originCode}→${outbound.destinationCode}，` +
          `回程实际为 ${inbound.originCode}→${inbound.destinationCode}）`,
      );
    }
    if (inbound.departureAt.getTime() <= outbound.arrivalAt.getTime()) {
      errors.push('回程出发时间必须晚于去程到达时间');
    }
    if (errors.length > 0) {
      throw new MarketingInputError(`回程班次校验失败：${errors.join('；')}`);
    }
  }

  const schedule = await prisma.flightSchedule.findUnique({
    where: { id: input.outboundScheduleId },
    select: { flightId: true },
  });

  const facts: PosterFact[] = [...legFacts(outbound, 'outbound', '去程')];
  if (inbound) facts.push(...legFacts(inbound, 'inbound', '回程'));

  if (input.effectiveFrom) {
    facts.push({
      key: 'effectiveFrom',
      label: '生效日期',
      value: input.effectiveFrom,
      strict: true,
      group: 'global',
    });
  }

  // 行李额是运营手填的补充信息，保留 strict:false 的历史语义，不影响确定性绘制。
  if (input.baggageText) {
    facts.push({
      key: 'baggage',
      label: '行李额',
      value: input.baggageText,
      strict: false,
      group: 'global',
    });
  }

  return {
    facts,
    summary: {
      outbound,
      inbound,
      effectiveFrom: input.effectiveFrom ?? null,
      baggageText: input.baggageText ?? null,
    },
    flightId: schedule?.flightId ?? '',
  };
}
