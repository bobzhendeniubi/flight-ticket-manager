import { describe, expect, it, vi } from 'vitest';
import type { QwenConfig } from '../../lib/qwen-config.js';
import type { FlightRouteSummary, PosterFact } from './marketing.facts.js';
import {
  runPosterPipeline,
  validatePosterInputText,
  type PosterPipelineDependencies,
} from './marketing.service.js';

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
  },
  inbound: null,
  effectiveFrom: '8月21日起',
  baggageText: '20KG+手提7KG',
};

const facts: PosterFact[] = [
  { key: 'outbound.flightNumber', label: '去程航班号', value: 'QH9589', strict: true, group: 'outbound' },
  { key: 'outbound.time', label: '去程时刻', value: '15:45-16:30', strict: true, group: 'outbound' },
  { key: 'outbound.route', label: '去程航线', value: '澳门 → 岘港', strict: true, group: 'outbound' },
  { key: 'effectiveFrom', label: '生效日期', value: '8月21日起', strict: true, group: 'global' },
  { key: 'baggage', label: '行李额', value: '20KG+手提7KG', strict: false, group: 'global' },
];

const background = 'data:image/png;base64,YmFja2dyb3VuZA==';

function dependencies(): PosterPipelineDependencies {
  return {
    generateImage: vi.fn().mockResolvedValue({ imageDataUrl: background, model: 'test-image' }),
    compose: vi.fn().mockResolvedValue({ png: Buffer.from('composed-png'), truncated: [] }),
    generateCopy: vi.fn().mockResolvedValue({
      copy: { moments: '{{outboundFlight}}', agent: null, xhs: null },
      rejected: [],
    }),
    getFontPath: vi.fn().mockReturnValue('/font/test.ttc'),
  };
}

function pipelineInput() {
  return {
    cfg,
    prompt: '纯背景提示词',
    templateKey: 'OCEAN_GOLD' as const,
    title: '航线通知',
    summary,
    facts,
  };
}

describe('runPosterPipeline — 方案 B 状态语义', () => {
  it('连续出图失败时落 FAILED', async () => {
    const deps = dependencies();
    deps.generateImage = vi.fn().mockRejectedValue(new Error('模型网络失败'));

    const result = await runPosterPipeline(pipelineInput(), deps);

    expect(result.status).toBe('FAILED');
    expect(result.attempts).toBe(3);
    expect(result.imageDataUrl).toBeNull();
    expect(deps.compose).not.toHaveBeenCalled();
    expect(result.report.error).toContain('模型网络失败');
  });

  it('背景图成功但合成失败时落 FAILED', async () => {
    const deps = dependencies();
    deps.compose = vi.fn().mockRejectedValue(new Error('字体注册失败'));

    const result = await runPosterPipeline(pipelineInput(), deps);

    expect(result.status).toBe('FAILED');
    expect(result.attempts).toBe(1);
    expect(result.imageDataUrl).toBeNull();
    expect(result.report.error).toContain('海报合成失败');
    expect(deps.generateCopy).not.toHaveBeenCalled();
  });

  it('背景图、合成和文案正常时落 READY', async () => {
    const deps = dependencies();

    const result = await runPosterPipeline(pipelineInput(), deps);

    expect(result.status).toBe('READY');
    expect(result.attempts).toBe(1);
    expect(result.imageDataUrl).toBe('data:image/png;base64,Y29tcG9zZWQtcG5n');
    expect(result.copy?.moments).toBe('{{outboundFlight}}');
    expect(result.report.renderedFields).toEqual(expect.arrayContaining([
      'outbound.flightNumber',
      'outbound.time',
      'outbound.route',
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
});
