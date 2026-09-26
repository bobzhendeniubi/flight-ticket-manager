/**
 * POST /ocr/passport · 指标日志（stub 掉上游 fetch + 抓 pino 输出，合成数据）
 *
 * 覆盖：
 *   - 每次调用一行 info（msg=ocr passport call）：分段耗时、模型、token、成败、错误分类
 *   - 不记图片、不记识别结果（姓名 / 证件号不进任何一行日志）
 *   - 发给模型的请求参数（model / temperature / messages）保持原样
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  aiOcrConfig: { findFirst: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { ocrRoutes } from './ocr.routes.js';

type LogLine = Record<string, unknown> & { level: number; msg: string };

// 8192 个 base64 字符 → 解码后 6144 字节 ≈ 6KB
const BASE64_BODY = 'QUJD'.repeat(2048);
const IMAGE_DATA_URL = `data:image/jpeg;base64,${BASE64_BODY}`;
const RECOGNIZED = {
  lastName: 'ZHANG',
  firstName: 'SANFENG',
  fullName: 'ZHANG SANFENG',
  documentNumber: 'E12345678',
  dateOfBirth: '1990-01-01',
  gender: 'M',
  nationality: 'CHN',
  passportExpiry: '2030-01-01',
};

let app: FastifyInstance;
let logLines: LogLine[] = [];
let rawLog = '';
const fetchMock = vi.fn();

beforeAll(async () => {
  app = Fastify({
    logger: {
      level: 'info',
      stream: {
        write(chunk: string) {
          rawLog += chunk;
          logLines.push(JSON.parse(chunk) as LogLine);
        },
      },
    },
  });
  await app.register(authPlugin);
  registerErrorHandler(app);
  await app.register(ocrRoutes, { prefix: '/ocr' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  logLines = [];
  rawLog = '';
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({
    disabledAt: null,
    authVersion: 0,
    staffRole: null,
    mustChangePassword: false,
    agentProfile: null,
  });
  prismaMock.aiOcrConfig.findFirst.mockResolvedValue({
    enabled: true,
    apiKey: 'test-key-not-real',
    baseUrl: 'https://ocr.example.test/v1',
    model: 'qwen3-vl-plus',
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function modelResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function postPassport() {
  const token = app.jwt.sign({ sub: 'staff-user-1', role: UserRole.STAFF });
  return app.inject({
    method: 'POST',
    url: '/ocr/passport',
    headers: { authorization: `Bearer ${token}` },
    payload: { imageDataUrl: IMAGE_DATA_URL },
  });
}

function ocrLine(): LogLine {
  const lines = logLines.filter((line) => line.msg === 'ocr passport call');
  expect(lines).toHaveLength(1);
  return lines[0];
}

function expectNoImageOrRecognizedData(): void {
  expect(rawLog).not.toContain(BASE64_BODY.slice(0, 64));
  expect(rawLog).not.toContain('E12345678');
  expect(rawLog).not.toContain('SANFENG');
}

describe('POST /ocr/passport · 指标日志', () => {
  it('成功：一行 info，带分段耗时 / 模型 / token / 图片体积，且请求参数原样', async () => {
    fetchMock.mockResolvedValue(
      modelResponse({
        choices: [{ message: { content: JSON.stringify(RECOGNIZED) } }],
        usage: { prompt_tokens: 1234, completion_tokens: 210, total_tokens: 1444 },
      }),
    );
    const res = await postPassport();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, engine: 'qwen', model: 'qwen3-vl-plus' });

    const line = ocrLine();
    expect(line).toMatchObject({
      level: 30,
      tag: 'ocr_call',
      model: 'qwen3-vl-plus',
      ok: true,
      httpStatus: 200,
      promptTokens: 1234,
      completionTokens: 210,
      totalTokens: 1444,
      imageKb: 6,
    });
    for (const key of ['totalMs', 'configMs', 'upstreamMs', 'readMs']) {
      expect(typeof line[key]).toBe('number');
    }
    expect(line).not.toHaveProperty('errorKind');
    expectNoImageOrRecognizedData();

    // 发给模型的请求没被改动：只有 model / temperature / messages，图片原样透传
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ocr.example.test/v1/chat/completions');
    const sent = JSON.parse(String(init.body));
    expect(Object.keys(sent).sort()).toEqual(['messages', 'model', 'temperature']);
    expect(sent.model).toBe('qwen3-vl-plus');
    expect(sent.temperature).toBe(0);
    expect(sent.messages[0].content[0].text).toMatch(/^你是护照 OCR 引擎/);
    expect(sent.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: IMAGE_DATA_URL } });
  });

  it('超时：ok=false、errorKind=timeout，token 记 null', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const res = await postPassport();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, suggested: null });
    expect(ocrLine()).toMatchObject({
      level: 30,
      ok: false,
      errorKind: 'timeout',
      httpStatus: null,
      promptTokens: null,
      readMs: null,
    });
    expect(typeof ocrLine().upstreamMs).toBe('number');
  });

  it('模型输出不是 JSON：errorKind=bad_output，日志里没有输出片段', async () => {
    fetchMock.mockResolvedValue(
      modelResponse({
        choices: [{ message: { content: 'ZHANG SANFENG E12345678 (not json)' } }],
        usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 },
      }),
    );
    await postPassport();
    expect(ocrLine()).toMatchObject({
      ok: false,
      errorKind: 'bad_output',
      errorSummary: '模型返回内容不是合法 JSON',
      promptTokens: 1200,
    });
    expectNoImageOrRecognizedData();
  });

  it('模型接口 429：errorKind=http，带 httpStatus', async () => {
    fetchMock.mockResolvedValue(modelResponse({ error: { message: 'Throttling' } }, 429));
    await postPassport();
    expect(ocrLine()).toMatchObject({
      ok: false,
      errorKind: 'http',
      httpStatus: 429,
      errorSummary: '请求频率超限，请稍后再试',
    });
  });

  it('模型 200 但响应里带 error：errorKind=upstream', async () => {
    fetchMock.mockResolvedValue(modelResponse({ error: { message: 'image too large' } }));
    await postPassport();
    expect(ocrLine()).toMatchObject({ ok: false, errorKind: 'upstream', httpStatus: 200 });
  });
});
