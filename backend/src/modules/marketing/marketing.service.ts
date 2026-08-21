/**
 * 营销中心编排层 —— 取事实 → 拼整图提示词 → 按模型出图 → 生成配套文案 → 落库。
 *
 * 航班号、日期、时刻和航线由事实快照提供；模型负责直接画完整海报，因此详情页必须由运营人工核对。
 */
import { MarketingPosterKind, MarketingPosterStatus, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { resolveQwenConfig, type QwenConfig } from '../../lib/qwen-config.js';
import {
  buildFlightRouteFacts,
  MarketingInputError,
  type FlightRouteFactsInput,
  type FlightRouteSummary,
  type PosterFact,
} from './marketing.facts.js';
import { findAirlineBrand, type AirlineBrand } from './airline-brands.js';
import {
  buildFlightRoutePrompt,
  findTemplate,
  type PosterContent,
  type PosterTemplateKey,
} from './marketing.templates.js';
import {
  DEFAULT_POSTER_SIZE,
  generatePosterImage,
  type GenerateImageResult,
} from './marketing.image.js';
import {
  generatePosterCopy,
  type PosterCopy,
  type PosterCopyRejection,
  type PosterCopyResult,
} from './marketing.copy.js';
import { findUnsupportedHardData } from './marketing.copy.js';
import { pruneposterImages } from './marketing.retention.js';

const MAX_IMAGE_ATTEMPTS = 3;

export const DEFAULT_POSTER_SUBTITLE = '黄金时刻·每天一班';
export const DEFAULT_POSTER_HIGHLIGHTS = [
  '安全出行·严苛保障',
  '舒适日间·尊享旅程',
  '高标准飞行保障·贴心服务',
] as const;
export const DEFAULT_POSTER_CTA_LINE2 = '即刻预订，享黄金时刻优惠';

async function prunePosterImagesBestEffort(): Promise<void> {
  try {
    await pruneposterImages(new Date());
  } catch (err) {
    console.error('海报图片保留期清理失败', err);
  }
}

export interface CreateFlightRoutePosterInput extends FlightRouteFactsInput {
  title: string;
  templateKey: PosterTemplateKey;
  headline?: string;
  subtitle?: string;
  slogan?: string;
  highlights?: string[];
  ctaLine1?: string;
  ctaLine2?: string;
  /** 运营额外想强调的内容，继续供三条配套文案使用。 */
  extraNote?: string;
  createdById: string;
}

export class MarketingConfigError extends Error {
  constructor() {
    super('尚未配置 AI 密钥，请先到「AI 识别设置」填写后再生成海报');
    this.name = 'MarketingConfigError';
  }
}

export type PosterQuotaScope = 'user' | 'team';

export interface PosterQuotaCounts {
  mine: number;
  total: number;
}

export interface PosterQuotaLimits {
  perUser: number;
  total: number;
}

export class MarketingQuotaError extends Error {
  readonly statusCode = 429;
  readonly code: string;
  readonly scope: PosterQuotaScope;
  readonly current: number;
  readonly limit: number;

  constructor(scope: PosterQuotaScope, current: number, limit: number) {
    const message = scope === 'user'
      ? `今日已生成 ${current}/${limit} 张，明日恢复；如需调整，请联系管理员`
      : `今日团队额度已用完（${current}/${limit} 张），明日恢复；如需调整，请联系管理员`;
    super(message);
    this.name = 'MarketingQuotaError';
    this.code = scope === 'user' ? 'POSTER_DAILY_USER_LIMIT' : 'POSTER_DAILY_TOTAL_LIMIT';
    this.scope = scope;
    this.current = current;
    this.limit = limit;
  }
}

export function marketingQuotaErrorBody(error: MarketingQuotaError): {
  error: {
    code: string;
    message: string;
    details: { scope: PosterQuotaScope; current: number; limit: number };
  };
} {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: { scope: error.scope, current: error.current, limit: error.limit },
    },
  };
}

/** 配额判断使用 >=，因此未达、刚好达到和超出三种边界都不会多调用一次模型。 */
export function assertPosterQuota(
  counts: PosterQuotaCounts,
  limits: PosterQuotaLimits,
): void {
  if (counts.mine >= limits.perUser) {
    throw new MarketingQuotaError('user', counts.mine, limits.perUser);
  }
  if (counts.total >= limits.total) {
    throw new MarketingQuotaError('team', counts.total, limits.total);
  }
}

interface LocalDateRange {
  start: Date;
  end: Date;
}

function localDayRange(now: Date): LocalDateRange {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { start, end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}

function localMonthRange(now: Date): LocalDateRange {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start, end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}

function createdAtIn(range: LocalDateRange): Prisma.MarketingPosterWhereInput {
  return { createdAt: { gte: range.start, lt: range.end } };
}

/**
 * 读取当天配额。这里不筛状态，GENERATING、READY、FAILED 都算一张，
 * 因为失败前可能已经调用过模型，失败记录也必须消耗额度。
 */
async function countTodayPosters(
  tx: Prisma.TransactionClient,
  createdById: string,
  now: Date,
): Promise<PosterQuotaCounts> {
  const where = createdAtIn(localDayRange(now));
  const [mine, total] = await Promise.all([
    tx.marketingPoster.count({ where: { ...where, createdById } }),
    tx.marketingPoster.count({ where }),
  ]);
  return { mine, total };
}

export interface MarketingUsageByModel {
  model: string;
  count: number;
  attempts: number;
}

export interface MarketingUsage {
  today: {
    total: number;
    mine: number;
    limitPerUser: number;
    limitTotal: number;
  };
  month: {
    total: number;
    byModel: MarketingUsageByModel[];
  };
}

/** 将数据库聚合结果整理成前端稳定的用量结构；attempts 是真实模型调用次数而非海报张数。 */
export function buildMarketingUsage(
  counts: PosterQuotaCounts & { monthTotal: number },
  byModel: MarketingUsageByModel[],
): MarketingUsage {
  return {
    today: {
      total: counts.total,
      mine: counts.mine,
      limitPerUser: env.POSTER_DAILY_LIMIT_PER_USER,
      limitTotal: env.POSTER_DAILY_LIMIT_TOTAL,
    },
    month: {
      total: counts.monthTotal,
      byModel: [...byModel].sort((left, right) => left.model.localeCompare(right.model)),
    },
  };
}

function readAggregateNumber(value: unknown, key: string): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' ? candidate : 0;
}

export async function getMarketingUsage(
  createdById: string,
  now = new Date(),
): Promise<MarketingUsage> {
  // 用量同样不筛 status，失败记录也保留在海报数中；attempts 才表示实际模型调用次数。
  const dayWhere = createdAtIn(localDayRange(now));
  const monthWhere = createdAtIn(localMonthRange(now));
  const [todayTotal, todayMine, monthTotal, grouped] = await prisma.$transaction([
    prisma.marketingPoster.count({ where: dayWhere }),
    prisma.marketingPoster.count({ where: { ...dayWhere, createdById } }),
    prisma.marketingPoster.count({ where: monthWhere }),
    prisma.marketingPoster.groupBy({
      by: ['imageModel'],
      where: monthWhere,
      _count: { _all: true },
      _sum: { attempts: true },
      orderBy: { imageModel: 'asc' },
    }),
  ]);
  const byModel: MarketingUsageByModel[] = grouped.map((row) => ({
    model: row.imageModel,
    count: readAggregateNumber(row._count, '_all'),
    attempts: readAggregateNumber(row._sum, 'attempts'),
  }));
  return buildMarketingUsage({ mine: todayMine, total: todayTotal, monthTotal }, byModel);
}

interface PosterReservationInput {
  kind: MarketingPosterKind;
  status: MarketingPosterStatus;
  title: string;
  flightId: string | null;
  templateKey: string;
  size: string;
  imageModel: string;
  prompt: string;
  facts: Prisma.InputJsonValue;
  imageDataUrl: null;
  attempts: number;
  verifyReport: Prisma.NullableJsonNullValueInput;
  copyMoments: null;
  copyAgent: null;
  copyXhs: null;
  createdById: string;
}

/**
 * 在可调用模型前以 GENERATING 记录占用一个名额，再由最终状态更新。
 * 计数与占位记录放在串行化事务内，避免并发点击同时通过配额检查。
 */
async function reservePosterSlot(
  input: PosterReservationInput,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const counts = await countTodayPosters(tx, input.createdById, new Date());
    assertPosterQuota(counts, {
      perUser: env.POSTER_DAILY_LIMIT_PER_USER,
      total: env.POSTER_DAILY_LIMIT_TOTAL,
    });
    return tx.marketingPoster.create({ data: input, select: { id: true } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export interface PosterAttemptResult {
  imageDataUrl: string | null;
  error: string | null;
}

export interface PosterAttemptSummary {
  attempts: number;
  result: PosterAttemptResult;
}

/** 只对网络/模型出图失败重试，不包含话术内容校验。 */
export async function runPosterAttempts(
  maxAttempts: number,
  generate: (attempt: number) => Promise<GenerateImageResult>,
): Promise<PosterAttemptSummary> {
  let latest: PosterAttemptResult = { imageDataUrl: null, error: null };
  let attempts = 0;

  for (let index = 0; index < maxAttempts; index += 1) {
    attempts = index + 1;
    try {
      const image = await generate(attempts);
      latest = { imageDataUrl: image.imageDataUrl, error: null };
      break;
    } catch (err) {
      latest = {
        imageDataUrl: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { attempts, result: latest };
}

export interface PosterRenderReport {
  schemaVersion: 3;
  templateKey: string;
  fontPath: null;
  /** 提示词中使用的系统事实与话术字段，字段名沿用历史 verifyReport 结构。 */
  renderedFields: string[];
  /** 供详情页逐项对照的系统事实和本次提示词话术值。 */
  renderedValues: Record<string, string>;
  copyRejected: PosterCopyRejection[];
  truncated: string[];
  copyError?: string;
  error?: string;
}

export interface PosterPipelineInput {
  cfg: QwenConfig;
  prompt: string;
  templateKey: PosterTemplateKey;
  content: PosterContent;
  summary: FlightRouteSummary;
  facts: PosterFact[];
  extraNote?: string;
}

export interface PosterPipelineResult {
  status: 'READY' | 'FAILED';
  attempts: number;
  imageDataUrl: string | null;
  copy: PosterCopy | null;
  report: PosterRenderReport;
}

export interface PosterPipelineDependencies {
  generateImage: (attempt: number) => Promise<GenerateImageResult>;
  generateCopy: (
    cfg: QwenConfig,
    summary: FlightRouteSummary,
    facts: PosterFact[],
    extraNote?: string,
  ) => Promise<PosterCopyResult | null>;
}

function contentFields(content: PosterContent): Array<[string, string | undefined]> {
  return [
    ['主标题', content.headline],
    ['副标题', content.subtitle],
    ['标语', content.slogan],
    ['卖点1', content.highlights[0]],
    ['卖点2', content.highlights[1]],
    ['卖点3', content.highlights[2]],
    ['底部文案1', content.ctaLine1],
    ['底部文案2', content.ctaLine2],
    ['行李额文案', content.baggageText ?? undefined],
  ];
}

function promptValues(content: PosterContent): Record<string, string> {
  const values: Record<string, string> = {
    headline: content.headline,
    subtitle: content.subtitle,
    slogan: content.slogan,
    ctaLine1: content.ctaLine1,
    ctaLine2: content.ctaLine2,
    'outbound.flightNumber': content.outbound.flightNumber,
    'outbound.time': content.outbound.time,
    'outbound.route': content.outbound.route,
  };
  content.highlights.forEach((highlight, index) => {
    values[`highlight${index + 1}`] = highlight;
  });
  if (content.baggageText) values.baggageText = content.baggageText;
  if (content.inbound) {
    values['inbound.flightNumber'] = content.inbound.flightNumber;
    values['inbound.time'] = content.inbound.time;
    values['inbound.route'] = content.inbound.route;
  }
  return values;
}

function factValues(facts: PosterFact[]): Record<string, string> {
  return Object.fromEntries(facts.map((fact) => [fact.key, fact.value]));
}

function reportForContent(
  templateKey: PosterTemplateKey,
  content: PosterContent,
  facts: PosterFact[],
  copyRejected: PosterCopyRejection[] = [],
  copyError?: string,
): PosterRenderReport {
  const values = { ...factValues(facts), ...promptValues(content) };
  return {
    schemaVersion: 3,
    templateKey,
    fontPath: null,
    renderedFields: Object.keys(values),
    renderedValues: values,
    copyRejected,
    truncated: [],
    ...(copyError ? { copyError } : {}),
  };
}

function failedReport(templateKey: string, error: string): PosterRenderReport {
  return {
    schemaVersion: 3,
    templateKey,
    fontPath: null,
    renderedFields: [],
    renderedValues: {},
    copyRejected: [],
    truncated: [],
    error,
  };
}

/** 创建前拒绝自由文本中的伪造硬数据，避免它绕过事实快照进入海报或配套文案。 */
export function validatePosterTextFields(
  fields: Array<[string, string | undefined]>,
  facts: PosterFact[],
): void {
  for (const [label, value] of fields) {
    if (!value?.trim()) continue;
    const reasons = findUnsupportedHardData(value, facts);
    if (reasons.length > 0) {
      throw new MarketingInputError(`海报${label}包含不在事实快照中的硬数据：${reasons.join('；')}`);
    }
  }
}

/** 保留旧版调用签名；新增海报话术由 validatePosterTextFields 统一校验。 */
export function validatePosterInputText(
  title: string,
  extraNote: string | undefined,
  facts: PosterFact[],
): void {
  validatePosterTextFields([
    ['标题', title],
    ['补充要求', extraNote],
  ], facts);
}

function legContent(summary: FlightRouteSummary['outbound']): PosterContent['outbound'] {
  return {
    flightNumber: summary.flightNumber,
    route: `${summary.originName} → ${summary.destinationName}`,
    time: `${summary.departTime}-${summary.arriveTime}`,
  };
}

function airlineShortName(brand: AirlineBrand | null): string | null {
  if (!brand) return null;
  return brand.nameZh.replace(/航空$/u, '') || brand.nameZh;
}

function defaultHeadline(summary: FlightRouteSummary): string {
  // 生产事实层一定有去程本地日期；effectiveFrom 只为旧调用方没有 departureDate 时兜底。
  return summary.outbound.departureDate
    ? `${summary.outbound.departureDate}起`
    : summary.effectiveFrom?.trim() || '';
}

function defaultSlogan(summary: FlightRouteSummary, brand: AirlineBrand | null): string {
  const shortName = airlineShortName(brand);
  return shortName
    ? `飞${summary.outbound.destinationName}，选${shortName}，越飞越值！`
    : `飞${summary.outbound.destinationName}，享黄金时刻，越飞越值！`;
}

/** 用系统事实补齐默认值；明确传空字符串时保留为空，让提示词整行省略。 */
export function buildPosterContent(
  summary: FlightRouteSummary,
  input: Pick<CreateFlightRoutePosterInput, 'headline' | 'subtitle' | 'slogan' | 'highlights' | 'ctaLine1' | 'ctaLine2' | 'baggageText'>,
  brand: AirlineBrand | null = findAirlineBrand(summary.outbound.flightNumber),
): PosterContent {
  const highlights = input.highlights === undefined
    ? [...DEFAULT_POSTER_HIGHLIGHTS]
    : input.highlights.map((highlight) => highlight.trim());
  return {
    headline: input.headline === undefined ? defaultHeadline(summary) : input.headline.trim(),
    subtitle: input.subtitle === undefined ? DEFAULT_POSTER_SUBTITLE : input.subtitle.trim(),
    slogan: input.slogan === undefined ? defaultSlogan(summary, brand) : input.slogan.trim(),
    highlights,
    ctaLine1: input.ctaLine1 === undefined
      ? `开启您的${summary.outbound.destinationName}尊享之旅`
      : input.ctaLine1.trim(),
    ctaLine2: input.ctaLine2 === undefined ? DEFAULT_POSTER_CTA_LINE2 : input.ctaLine2.trim(),
    baggageText: input.baggageText?.trim() || null,
    outbound: legContent(summary.outbound),
    inbound: summary.inbound ? legContent(summary.inbound) : null,
  };
}

/** 纯编排函数：注入网络与文案依赖，便于单元测试重试、失败与正常路径。 */
export async function runPosterPipeline(
  input: PosterPipelineInput,
  dependencies: PosterPipelineDependencies,
): Promise<PosterPipelineResult> {
  const attempts = await runPosterAttempts(MAX_IMAGE_ATTEMPTS, dependencies.generateImage);
  if (!attempts.result.imageDataUrl) {
    return {
      status: 'FAILED',
      attempts: attempts.attempts,
      imageDataUrl: null,
      copy: null,
      report: failedReport(input.templateKey, attempts.result.error ?? '整图海报生成失败'),
    };
  }

  let copy: PosterCopy | null = null;
  let copyRejected: PosterCopyRejection[] = [];
  let copyError: string | undefined;
  try {
    const copyResult = await dependencies.generateCopy(
      input.cfg,
      input.summary,
      input.facts,
      input.extraNote,
    );
    copy = copyResult?.copy ?? null;
    copyRejected = copyResult?.rejected ?? [];
    if (!copyResult) copyError = '文案接口未返回可用结果';
  } catch (err) {
    copyError = err instanceof Error ? err.message : String(err);
  }

  return {
    status: 'READY',
    attempts: attempts.attempts,
    imageDataUrl: attempts.result.imageDataUrl,
    copy,
    report: reportForContent(input.templateKey, input.content, input.facts, copyRejected, copyError),
  };
}

export async function createFlightRoutePoster(input: CreateFlightRoutePosterInput) {
  const cfg = await resolveQwenConfig();
  if (!cfg) throw new MarketingConfigError();

  const imageModel = env.POSTER_IMAGE_MODEL;
  const { facts, summary, flightId } = await buildFlightRouteFacts(input);
  const actualTemplateKey = findTemplate(input.templateKey).key as PosterTemplateKey;
  const brand = findAirlineBrand(summary.outbound.flightNumber);
  const content = buildPosterContent(summary, input, brand);
  validatePosterInputText(input.title, input.extraNote, facts);
  validatePosterTextFields(contentFields(content), facts);
  const prompt = buildFlightRoutePrompt(actualTemplateKey, content, brand);

  // 先占用名额并落一条 GENERATING 记录，再调用模型；因此失败记录也会进入当天统计。
  const reservation = await reservePosterSlot({
    kind: MarketingPosterKind.FLIGHT_ROUTE,
    status: MarketingPosterStatus.GENERATING,
    title: input.title,
    flightId: flightId || null,
    templateKey: actualTemplateKey,
    size: DEFAULT_POSTER_SIZE,
    imageModel,
    prompt,
    facts: facts as unknown as Prisma.InputJsonValue,
    imageDataUrl: null,
    attempts: 0,
    verifyReport: Prisma.JsonNull,
    copyMoments: null,
    copyAgent: null,
    copyXhs: null,
    createdById: input.createdById,
  });

  let pipeline: PosterPipelineResult;
  try {
    pipeline = await runPosterPipeline(
      { cfg, prompt, templateKey: actualTemplateKey, content, summary, facts, extraNote: input.extraNote },
      {
        generateImage: () => generatePosterImage({
          cfg,
          prompt,
          size: DEFAULT_POSTER_SIZE,
          model: imageModel,
        }),
        generateCopy: generatePosterCopy,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.marketingPoster.update({
      where: { id: reservation.id },
      data: {
        status: MarketingPosterStatus.FAILED,
        verifyReport: failedReport(actualTemplateKey, message) as unknown as Prisma.InputJsonValue,
      },
    });
    throw err;
  }

  const poster = await prisma.marketingPoster.update({
    where: { id: reservation.id },
    data: {
      status: pipeline.status === 'READY' ? MarketingPosterStatus.READY : MarketingPosterStatus.FAILED,
      imageDataUrl: pipeline.imageDataUrl,
      attempts: pipeline.attempts,
      verifyReport: pipeline.report as unknown as Prisma.InputJsonValue,
      copyMoments: pipeline.copy?.moments ?? null,
      copyAgent: pipeline.copy?.agent ?? null,
      copyXhs: pipeline.copy?.xhs ?? null,
    },
    include: { createdBy: { select: { id: true, displayName: true } } },
  });
  await prunePosterImagesBestEffort();
  return poster;
}
