/**
 * 营销中心编排层 —— 取事实 → 出无字背景 → 服务端叠字 → 生成文案 → 落库。
 *
 * 生图失败可以重试；合成失败直接 FAILED。航班号、时刻、航线、生效日期和行李额
 * 从不交给模型，也不再调用视觉模型回读海报。
 */
import { MarketingPosterKind, MarketingPosterStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { resolveQwenConfig, type QwenConfig } from '../../lib/qwen-config.js';
import {
  buildFlightRouteFacts,
  MarketingInputError,
  type FlightRouteFactsInput,
  type FlightRouteSummary,
  type PosterFact,
} from './marketing.facts.js';
import {
  buildFlightRoutePrompt,
  findTemplate,
  type PosterTemplateKey,
} from './marketing.templates.js';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_POSTER_SIZE,
  generatePosterImage,
  type GenerateImageResult,
} from './marketing.image.js';
import {
  buildPosterContent,
  composePosterWithReport,
  getPosterFontPath,
  getPosterLayout,
  type ComposePosterResult,
  type PosterContent,
  type PosterLayout,
} from './marketing.compose.js';
import {
  generatePosterCopy,
  type PosterCopy,
  type PosterCopyRejection,
  type PosterCopyResult,
} from './marketing.copy.js';
import { findUnsupportedHardData } from './marketing.copy.js';
import { pruneposterImages } from './marketing.retention.js';

const MAX_IMAGE_ATTEMPTS = 3;

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
  /** 运营额外想强调的内容，会由服务端绘制并作为文案生成要求。 */
  extraNote?: string;
  createdById: string;
}

export class MarketingConfigError extends Error {
  constructor() {
    super('尚未配置 AI 密钥，请先到「AI 识别设置」填写后再生成海报');
    this.name = 'MarketingConfigError';
  }
}

export interface PosterAttemptResult {
  imageDataUrl: string | null;
  error: string | null;
}

export interface PosterAttemptSummary {
  attempts: number;
  result: PosterAttemptResult;
}

/** 只对网络/模型出图失败重试，不包含任何内容校验。 */
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
  schemaVersion: 2;
  templateKey: string;
  fontPath: string | null;
  /** 已由服务端绘制的字段 key。 */
  renderedFields: string[];
  /** 海报文字块的实际取值，供详情页展示数据来源。 */
  renderedValues: Record<string, string>;
  /** 被丢弃的模型文案段落及原因。 */
  copyRejected: PosterCopyRejection[];
  /** 非关键字段因过长而截断的字段 key。 */
  truncated: string[];
  copyError?: string;
  error?: string;
}

export interface PosterPipelineInput {
  cfg: QwenConfig;
  prompt: string;
  templateKey: PosterTemplateKey;
  title: string;
  extraNote?: string;
  summary: FlightRouteSummary;
  facts: PosterFact[];
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
  compose: (backgroundPng: Buffer, layout: PosterLayout, content: PosterContent) => Promise<ComposePosterResult>;
  generateCopy: (
    cfg: QwenConfig,
    summary: FlightRouteSummary,
    facts: PosterFact[],
    extraNote?: string,
  ) => Promise<PosterCopyResult | null>;
  getFontPath: () => string;
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/u.exec(dataUrl);
  if (!match) throw new Error('背景图不是受支持的 PNG/JPEG/WebP data URL');
  return Buffer.from(match[1], 'base64');
}

function renderedFields(content: PosterContent): string[] {
  const fields = [
    'title',
    'outbound.flightNumber',
    'outbound.time',
    'outbound.route',
  ];
  if (content.inbound) {
    fields.push('inbound.flightNumber', 'inbound.time', 'inbound.route');
  }
  if (content.effectiveFrom) fields.push('effectiveFrom');
  if (content.baggageText) fields.push('baggage');
  if (content.extraNote) fields.push('extraNote');
  return fields;
}

function renderedValues(content: PosterContent): Record<string, string> {
  const values: Record<string, string> = {
    title: content.title,
    'outbound.flightNumber': content.outbound.flightNumber,
    'outbound.time': content.outbound.time,
    'outbound.route': content.outbound.route,
  };
  if (content.inbound) {
    values['inbound.flightNumber'] = content.inbound.flightNumber;
    values['inbound.time'] = content.inbound.time;
    values['inbound.route'] = content.inbound.route;
  }
  if (content.effectiveFrom) values.effectiveFrom = content.effectiveFrom;
  if (content.baggageText) values.baggage = content.baggageText;
  if (content.extraNote) values.extraNote = content.extraNote;
  return values;
}

function failedReport(templateKey: string, error: string, fields: string[] = []): PosterRenderReport {
  return {
    schemaVersion: 2,
    templateKey,
    fontPath: null,
    renderedFields: fields,
    renderedValues: {},
    copyRejected: [],
    truncated: [],
    error,
  };
}

/** 创建前拒绝自由文本中的伪造硬数据，避免它绕过事实卡片进入海报。 */
export function validatePosterInputText(
  title: string,
  extraNote: string | undefined,
  facts: PosterFact[],
): void {
  const fields: Array<[string, string | undefined]> = [
    ['标题', title],
    ['补充要求', extraNote],
  ];
  for (const [label, value] of fields) {
    if (!value?.trim()) continue;
    const reasons = findUnsupportedHardData(value, facts);
    if (reasons.length > 0) {
      throw new MarketingInputError(`海报${label}包含不在事实快照中的硬数据：${reasons.join('；')}`);
    }
  }
}

/**
 * 纯编排函数：依赖作为参数注入，便于单元测试覆盖出图失败、合成失败和正常路径。
 */
export async function runPosterPipeline(
  input: PosterPipelineInput,
  dependencies: PosterPipelineDependencies,
): Promise<PosterPipelineResult> {
  const content = buildPosterContent(input.summary, input.title, input.extraNote);
  const layout = getPosterLayout(input.templateKey);
  const fields = renderedFields(content);
  const attempts = await runPosterAttempts(MAX_IMAGE_ATTEMPTS, dependencies.generateImage);

  if (!attempts.result.imageDataUrl) {
    return {
      status: 'FAILED',
      attempts: attempts.attempts,
      imageDataUrl: null,
      copy: null,
      report: failedReport(input.templateKey, attempts.result.error ?? '背景图生成失败'),
    };
  }

  let finalImageDataUrl: string;
  let fontPath: string;
  let truncated: string[] = [];
  try {
    const backgroundPng = decodeDataUrl(attempts.result.imageDataUrl);
    const composed = await dependencies.compose(backgroundPng, layout, content);
    finalImageDataUrl = `data:image/png;base64,${composed.png.toString('base64')}`;
    fontPath = dependencies.getFontPath();
    truncated = composed.truncated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'FAILED',
      attempts: attempts.attempts,
      imageDataUrl: null,
      copy: null,
      report: failedReport(input.templateKey, `海报合成失败：${message}`, fields),
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
    imageDataUrl: finalImageDataUrl,
    copy,
    report: {
      schemaVersion: 2,
      templateKey: input.templateKey,
      fontPath,
      renderedFields: fields,
      renderedValues: renderedValues(content),
      truncated,
      copyRejected,
      ...(copyError ? { copyError } : {}),
    },
  };
}

export async function createFlightRoutePoster(input: CreateFlightRoutePosterInput) {
  const cfg = await resolveQwenConfig();
  if (!cfg) throw new MarketingConfigError();

  const { facts, summary, flightId } = await buildFlightRouteFacts(input);
  validatePosterInputText(input.title, input.extraNote, facts);
  const actualTemplateKey = findTemplate(input.templateKey).key as PosterTemplateKey;
  const prompt = buildFlightRoutePrompt(actualTemplateKey);
  const pipeline = await runPosterPipeline(
    {
      cfg,
      prompt,
      templateKey: actualTemplateKey,
      title: input.title,
      extraNote: input.extraNote,
      summary,
      facts,
    },
    {
      generateImage: () => generatePosterImage({
        cfg,
        prompt,
        size: DEFAULT_POSTER_SIZE,
        model: DEFAULT_IMAGE_MODEL,
      }),
      compose: composePosterWithReport,
      generateCopy: generatePosterCopy,
      getFontPath: getPosterFontPath,
    },
  );

  const poster = await prisma.marketingPoster.create({
    data: {
      kind: MarketingPosterKind.FLIGHT_ROUTE,
      status: pipeline.status === 'READY'
        ? MarketingPosterStatus.READY
        : MarketingPosterStatus.FAILED,
      title: input.title,
      flightId: flightId || null,
      templateKey: actualTemplateKey,
      size: DEFAULT_POSTER_SIZE,
      imageModel: DEFAULT_IMAGE_MODEL,
      prompt,
      facts: facts as unknown as Prisma.InputJsonValue,
      imageDataUrl: pipeline.imageDataUrl,
      attempts: pipeline.attempts,
      verifyReport: pipeline.report as unknown as Prisma.InputJsonValue,
      copyMoments: pipeline.copy?.moments ?? null,
      copyAgent: pipeline.copy?.agent ?? null,
      copyXhs: pipeline.copy?.xhs ?? null,
      createdById: input.createdById,
    },
  });
  await prunePosterImagesBestEffort();
  return poster;
}
