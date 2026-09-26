/**
 * ocr.metrics · 护照 OCR 指标的纯函数（合成数据，无真实证件信息）。
 */
import { describe, it, expect } from 'vitest';
import {
  approxDataUrlKb,
  buildOcrMetricsFields,
  OCR_METRICS_TAG,
  parseOcrUsage,
  summarizeOcrError,
} from './ocr.metrics.js';

describe('parseOcrUsage', () => {
  it('取 OpenAI 兼容 usage 的三项 token', () => {
    expect(
      parseOcrUsage({ usage: { prompt_tokens: 1234, completion_tokens: 210, total_tokens: 1444 } }),
    ).toEqual({ promptTokens: 1234, completionTokens: 210, totalTokens: 1444 });
  });

  it('缺项记 null；没有 usage 返回 undefined', () => {
    expect(parseOcrUsage({ usage: { prompt_tokens: 10 } })).toEqual({
      promptTokens: 10,
      completionTokens: null,
      totalTokens: null,
    });
    expect(parseOcrUsage({ choices: [] })).toBeUndefined();
    expect(parseOcrUsage(null)).toBeUndefined();
  });
});

describe('approxDataUrlKb', () => {
  it('按 base64 段长度估算体积', () => {
    const base64 = 'A'.repeat(4096); // 解码后 3072 字节 = 3KB
    expect(approxDataUrlKb(`data:image/jpeg;base64,${base64}`)).toBe(3);
  });
});

describe('summarizeOcrError', () => {
  it('超时（AbortSignal.timeout 抛 TimeoutError）→ timeout', () => {
    const err = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(summarizeOcrError(err, {})).toEqual({ errorKind: 'timeout', errorSummary: 'AI 服务调用超时' });
  });

  it('JSON 解析失败 → bad_output，固定文案，不带模型输出片段', () => {
    let err: unknown;
    try {
      JSON.parse('ZHANG SAN E12345678 is not json');
    } catch (e) {
      err = e;
    }
    const out = summarizeOcrError(err, {});
    expect(out.errorKind).toBe('bad_output');
    expect(JSON.stringify(out)).not.toContain('ZHANG');
    expect(JSON.stringify(out)).not.toContain('E12345678');
  });

  it('callQwenOcr 自己标记的失败沿用标记（http / upstream），摘要截断到 200 字', () => {
    const out = summarizeOcrError(new Error(`AI 服务返回 502：${'x'.repeat(400)}`), { errorKind: 'http' });
    expect(out.errorKind).toBe('http');
    expect(out.errorSummary.length).toBeLessThanOrEqual(200);
  });

  it('网络错误带上 cause code', () => {
    const err = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    expect(summarizeOcrError(err, {})).toEqual({ errorKind: 'network', errorSummary: 'fetch failed (ECONNRESET)' });
  });

  it('其它异常 → other', () => {
    expect(summarizeOcrError(new Error('boom'), {}).errorKind).toBe('other');
  });
});

describe('buildOcrMetricsFields', () => {
  it('成功：带分段耗时与 token，不带错误字段', () => {
    const fields = buildOcrMetricsFields({
      model: 'qwen3-vl-plus',
      ok: true,
      totalMs: 7310,
      configMs: 3,
      imageKb: 512,
      trace: {
        upstreamMs: 7290,
        readMs: 4,
        httpStatus: 200,
        usage: { promptTokens: 1234, completionTokens: 210, totalTokens: 1444 },
      },
    });
    expect(fields).toEqual({
      tag: OCR_METRICS_TAG,
      model: 'qwen3-vl-plus',
      ok: true,
      totalMs: 7310,
      configMs: 3,
      upstreamMs: 7290,
      readMs: 4,
      httpStatus: 200,
      promptTokens: 1234,
      completionTokens: 210,
      totalTokens: 1444,
      imageKb: 512,
    });
  });

  it('失败：没测到的分段与 token 记 null，并带 errorKind / errorSummary', () => {
    const fields = buildOcrMetricsFields({
      model: 'qwen3-vl-plus',
      ok: false,
      totalMs: 30010,
      configMs: 2,
      imageKb: 800,
      trace: { upstreamMs: 30005 },
      error: new DOMException('aborted', 'TimeoutError'),
    });
    expect(fields).toMatchObject({
      ok: false,
      upstreamMs: 30005,
      readMs: null,
      httpStatus: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorKind: 'timeout',
    });
  });
});
