import { describe, expect, it, vi } from 'vitest';
import type { QwenConfig } from '../../lib/qwen-config.js';
import type { FlightRouteSummary, PosterFact } from './marketing.facts.js';
import {
  buildPosterContent,
  runPosterPipeline,
  validatePosterInputText,
  validatePosterTextFields,
  type PosterPipelineDependencies,
} from './marketing.service.js';
import { findAirlineBrand } from './airline-brands.js';

const cfg: QwenConfig = {
  apiKey: 'test-key',
  compatibleBaseUrl: 'https://example.test/v1',
  nativeBaseUrl: 'https://example.test',
  vlModel: 'test-model',
};

const summary: FlightRouteSummary = {
  outbound: {
    flightNumber: 'QH9589',
    originCode: 'MFM',
    destinationCode: 'DAD',
    originName: '澳门',
    destinationName: '岘港',
    departTime: '15:45',
    arriveTime: '16:30',
    departureDate: '8月21日',
  },
  inbound: null,
  effectiveFrom: '8月21日起',
  baggageText: '20KG+手提7KG',
};

const facts: PosterFact[] = [
  { key: 'outbound.flightNumber', label: '去程航班号', value: 'QH9589', strict: true, group: 'outbound' },
  { key: 'outbound.time', label: '去程时刻', value: '15:45-16:30', strict: true, group: 'outbound' },
  { key: 'outbound.route', label: '去程航线', value: '澳门 → 岘港', strict: true, group: 'outbound' },
  { key: 'outbound.date', label: '去程日期', value: '8月21日', strict: true, group: 'outbound' },
  { key: 'effectiveFrom', label: '生效日期', value: '8月21日起', strict: true, group: 'global' },
  { key: 'baggage', label: '行李额', value: '20KG+手提7KG', strict: false, group: 'global' },
];

const background = 'data:image/png;base64,YmFja2dyb3VuZA==';

function dependencies(): PosterPipelineDependencies {
  return {
    generateImage: vi.fn().mockResolvedValue({ imageDataUrl: background, model: 'test-image' }),
    generateCopy: vi.fn().mockResolvedValue({
      copy: { moments: '{{outboundFlight}}', agent: null, xhs: null },
      rejected: [],
    }),
    getFontPath: vi.fn().mockReturnValue('/font/test.ttc'),
  };
}

function pipelineInput() {
  const brand = findAirlineBrand(summary.outbound.flightNumber);
  return {
    cfg,
    prompt: '纯背景提示词',
    templateKey: 'OCEAN_GOLD' as const,
    content: buildPosterContent(summary, {
      headline: undefined,
      subtitle: undefined,
      slogan: undefined,
      highlights: undefined,
      ctaLine1: undefined,
      ctaLine2: undefined,
      baggageText: summary.baggageText ?? undefined,
    }, brand),
    summary,
    facts,
  };
}

describe('runPosterPipeline — 整图生图状态语义', () => {
  it('连续出图失败时落 FAILED', async () => {
    const deps = dependencies();
    deps.generateImage = vi.fn().mockRejectedValue(new Error('模型网络失败'));

    const result = await runPosterPipeline(pipelineInput(), deps);

    expect(result.status).toBe('FAILED');
    expect(result.attempts).toBe(3);
    expect(result.imageDataUrl).toBeNull();
    expect(result.report.error).toContain('模型网络失败');
  });

  it('整图成功且文案正常时落 READY，不调用服务端合成', async () => {
    const deps = dependencies();

    const result = await runPosterPipeline(pipelineInput(), deps);

    expect(result.status).toBe('READY');
    expect(result.attempts).toBe(1);
    expect(result.imageDataUrl).toBe(background);
    expect(result.copy?.moments).toBe('{{outboundFlight}}');
    expect(result.report.renderedFields).toEqual(expect.arrayContaining([
      'outbound.flightNumber',
      'outbound.time',
      'outbound.route',
      'outbound.date',
      'effectiveFrom',
      'baggage',
    ]));
  });
});

describe('validatePosterInputText — 自由文本硬数据', () => {
  it('拒绝标题或补充要求中的非事实航班号、时刻', () => {
    expect(() => validatePosterInputText('9C1234 特价', undefined, facts)).toThrow('标题');
    expect(() => validatePosterInputText('航线通知', '请写 8点05分 起飞', facts)).toThrow('补充要求');
  });

  it('允许事实快照中的硬数据', () => {
    expect(() => validatePosterInputText('QH9589 航线通知', '15:45 出发', facts)).not.toThrow();
  });

  it('新话术字段继续受事实快照白名单约束', () => {
    expect(() => validatePosterTextFields([
      ['主标题', '8月21日起'],
      ['标语', '飞岘港，选越竹'],
    ], facts)).not.toThrow();
    expect(() => validatePosterTextFields([
      ['主标题', '9C1234 特价'],
    ], facts)).toThrow('主标题');
  });
});

describe('buildPosterContent — 系统默认话术', () => {
  it('用去程出发地当地日期生成主标题', () => {
    const result = buildPosterContent(
      { ...summary, effectiveFrom: null },
      {},
      findAirlineBrand('QH9589'),
    );

    expect(result.headline).toBe('8月21日起');
    expect(result.slogan).toBe('飞岘港，选越竹，越飞越值！');
    expect(result.highlights).toHaveLength(3);
  });
});
