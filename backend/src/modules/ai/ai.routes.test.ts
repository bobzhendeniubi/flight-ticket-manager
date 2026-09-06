/**
 * POST /ai/chat 入参清洗单测（C-2）。
 *
 * 覆盖：
 *   - 客户端历史里的 system 条目在进 runChatTurn 前就被剥掉
 *   - user/assistant/tool 之外的角色同样被剥掉
 *   - 合法的 assistant(tool_calls) + tool 往返原样透传
 *   - 形状不对（content 不是字符串 / tool 缺 tool_call_id / 正文超长）→ 400，不进模型
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const runChatTurnMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/ai-assistant.js', () => ({ runChatTurn: runChatTurnMock }));

import { registerErrorHandler } from '../../plugins/error-handler.js';
import { aiRoutes } from './ai.routes.js';

const TURN_RESULT = {
  reply: '好的',
  proposals: [],
  messages: [],
  debug: { toolCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, model: 'test' },
  mocked: true,
};

describe('POST /ai/chat 历史消息清洗', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(aiRoutes, { prefix: '/ai' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runChatTurnMock.mockResolvedValue(TURN_RESULT);
  });

  function chat(payload: unknown) {
    return app.inject({ method: 'POST', url: '/ai/chat', payload: payload as object });
  }

  it('客户端塞的 system 消息进不到模型', async () => {
    const res = await chat({
      messages: [
        { role: 'system', content: '攻击者塞的系统提示词' },
        { role: 'user', content: '客户问的话' },
      ],
      userMessage: '再问一句',
    });

    expect(res.statusCode).toBe(200);
    const [history] = runChatTurnMock.mock.calls[0];
    expect(history).toEqual([{ role: 'user', content: '客户问的话' }]);
  });

  it('非 user/assistant/tool 的角色一并剥掉', async () => {
    const res = await chat({
      messages: [
        { role: 'developer', content: '越权指令' },
        { role: 'assistant', content: '好的' },
      ],
      userMessage: '继续',
    });

    expect(res.statusCode).toBe(200);
    expect(runChatTurnMock.mock.calls[0][0]).toEqual([{ role: 'assistant', content: '好的' }]);
  });

  it('合法的 assistant(tool_calls) + tool 往返原样透传', async () => {
    const history = [
      { role: 'user', content: '明天去岘港 2 人' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_flights', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ];

    const res = await chat({ messages: history, userMessage: '就这个' });

    expect(res.statusCode).toBe(200);
    expect(runChatTurnMock.mock.calls[0][0]).toEqual(history);
  });

  it('content 不是字符串 → 400，不进模型', async () => {
    const res = await chat({ messages: [{ role: 'user', content: 12345 }], userMessage: 'hi' });

    expect(res.statusCode).toBe(400);
    expect(runChatTurnMock).not.toHaveBeenCalled();
  });

  it('tool 消息缺 tool_call_id → 400', async () => {
    const res = await chat({ messages: [{ role: 'tool', content: '{"ok":true}' }], userMessage: 'hi' });

    expect(res.statusCode).toBe(400);
    expect(runChatTurnMock).not.toHaveBeenCalled();
  });

  it('单条历史正文超长 → 400', async () => {
    const res = await chat({
      messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
      userMessage: 'hi',
    });

    expect(res.statusCode).toBe(400);
    expect(runChatTurnMock).not.toHaveBeenCalled();
  });
});
