import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-012345678901234567890';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-012345678901234567890';
});

const prismaMock = vi.hoisted(() => ({
  aiOcrConfig: { findFirst: vi.fn() },
  agent: { findUnique: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

vi.mock('@prisma/client', () => ({
  UserRole: {
    ADMIN: 'ADMIN',
    STAFF: 'STAFF',
    AGENT: 'AGENT',
    CUSTOMER: 'CUSTOMER',
  },
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', fetchMock);

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { ocrRoutes } from './ocr.routes.js';

describe('OCR 路由', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(ocrRoutes, { prefix: '/ocr' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    prismaMock.aiOcrConfig.findFirst.mockResolvedValue({
      enabled: true,
      apiKey: 'server-secret-key',
      baseUrl: 'https://ocr.example.test/v1',
      model: 'qwen-test',
    });
    prismaMock.agent.findUnique.mockResolvedValue({ isActive: true });
  });

  function tokenFor(role: UserRole): string {
    return app.jwt.sign({ sub: `user-${role}`, role });
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function qwenResponse(content: string, status = 200): Response {
    return jsonResponse({ choices: [{ message: { content } }] }, status);
  }

  async function postVisa(role: UserRole = UserRole.STAFF) {
    return app.inject({
      method: 'POST',
      url: '/ocr/visa',
      headers: { authorization: `Bearer ${tokenFor(role)}` },
      payload: { imageDataUrl: 'data:image/jpeg;base64,AAAA' },
    });
  }

  it.each(['not json', '{"visaIssueDate":"2026-08-15"'])(
    '模型返回非完整 JSON 时返回固定错误，不泄漏原文：%s',
    async (content) => {
      fetchMock.mockResolvedValue(qwenResponse(content));

      const res = await postVisa();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        configured: true,
        model: 'qwen-test',
        errorCode: 'OCR_INVALID_RESPONSE',
        error: 'AI 识别返回格式异常，请重试',
        suggested: null,
      });
      expect(res.body).not.toContain('server-secret-key');
    },
  );

  it('模型缺字段时补齐为 null', async () => {
    fetchMock.mockResolvedValue(qwenResponse(JSON.stringify({ visaIssueDate: '15/08/2026' })));

    const res = await postVisa();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      model: 'qwen-test',
      suggested: {
        visaIssueDate: '2026-08-15',
        visaEffectiveDate: null,
        visaExpiry: null,
        visaNumber: null,
      },
    });
  });

  it('模型返回空字符串和非法日期时所有字段均为 null', async () => {
    fetchMock.mockResolvedValue(
      qwenResponse(
        JSON.stringify({
          visaIssueDate: '',
          visaEffectiveDate: '乱码',
          visaExpiry: '31/02/2026',
          visaNumber: '',
        }),
      ),
    );

    const res = await postVisa();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      suggested: {
        visaIssueDate: null,
        visaEffectiveDate: null,
        visaExpiry: null,
        visaNumber: null,
      },
    });
  });

  it('上游错误正文不向调用方透传，也不泄漏密钥', async () => {
    fetchMock.mockResolvedValue(
      new Response('Authorization: Bearer leaked-upstream-key', { status: 500 }),
    );

    const res = await postVisa();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      model: 'qwen-test',
      errorCode: 'OCR_UPSTREAM_ERROR',
      error: 'AI 识别服务暂时不可用，请稍后再试',
      suggested: null,
    });
    expect(res.body).not.toContain('leaked-upstream-key');
  });

  it('上游响应不是 JSON 时返回固定错误', async () => {
    fetchMock.mockResolvedValue(new Response('upstream key: leaked-key', { status: 200 }));

    const res = await postVisa();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      errorCode: 'OCR_INVALID_RESPONSE',
      error: 'AI 识别返回格式异常，请重试',
      suggested: null,
    });
    expect(res.body).not.toContain('leaked-key');
  });

  it('AGENT 调用签证 OCR 被拒绝，且不请求上游', async () => {
    const res = await postVisa(UserRole.AGENT);

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('护照 OCR 成功响应契约保持不变', async () => {
    fetchMock.mockResolvedValue(qwenResponse('{}'));

    const res = await app.inject({
      method: 'POST',
      url: '/ocr/passport',
      headers: { authorization: `Bearer ${tokenFor(UserRole.AGENT)}` },
      payload: { imageDataUrl: 'data:image/jpeg;base64,AAAA' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      configured: true,
      engine: 'qwen',
      model: 'qwen-test',
      suggested: expect.objectContaining({
        documentNumber: null,
        passportExpiry: null,
        passportIssueDate: null,
      }),
      verify: { mrzValid: false, reviewFields: expect.any(Array) },
    });
    expect(res.json()).not.toHaveProperty('errorCode');
  });

  it('护照 OCR 上游失败时也不透传错误正文或密钥', async () => {
    fetchMock.mockResolvedValue(
      new Response('Authorization: Bearer passport-leaked-key', { status: 401 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/ocr/passport',
      headers: { authorization: `Bearer ${tokenFor(UserRole.AGENT)}` },
      payload: { imageDataUrl: 'data:image/jpeg;base64,AAAA' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      engine: 'qwen',
      model: 'qwen-test',
      errorCode: 'OCR_UPSTREAM_AUTH',
      error: 'AI 识别服务认证失败，请联系运营检查 AI 配置',
      suggested: null,
    });
    expect(res.body).not.toContain('passport-leaked-key');
  });
});
