import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';

const serviceMock = vi.hoisted(() => {
  class TestMarketingQuotaError extends Error {
    readonly code = 'POSTER_DAILY_USER_LIMIT';
    readonly scope = 'user' as const;
    readonly current = 10;
    readonly limit = 10;

    constructor() {
      super('今日已生成 10/10 张，明日恢复；如需调整，请联系管理员');
      this.name = 'MarketingQuotaError';
    }
  }

  return {
    createFlightRoutePoster: vi.fn(),
    getMarketingUsage: vi.fn(),
    MarketingConfigError: class MarketingConfigError extends Error {},
    MarketingQuotaError: TestMarketingQuotaError,
    marketingQuotaErrorBody: (error: TestMarketingQuotaError) => ({
      error: {
        code: error.code,
        message: error.message,
        details: { scope: error.scope, current: error.current, limit: error.limit },
      },
    }),
  };
});

vi.mock('./marketing.service.js', () => serviceMock);
vi.mock('../../db/prisma.js', () => ({
  prisma: {
    user: { findUnique: vi.fn().mockResolvedValue({ disabledAt: null, agentProfile: { isActive: true } }) },
    agent: { findUnique: vi.fn() },
  },
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { marketingRoutes } from './marketing.routes.js';

describe('营销海报配额路由', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(marketingRoutes, { prefix: '/marketing' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.createFlightRoutePoster.mockRejectedValue(new serviceMock.MarketingQuotaError());
  });

  it('超配额返回 429 和稳定的 error 结构', async () => {
    const token = app.jwt.sign({ sub: 'staff-1', role: UserRole.STAFF });
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/posters/flight-route',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: '航线海报',
        outboundScheduleId: 'schedule-1',
        templateKey: 'OCEAN_GOLD',
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: {
        code: 'POSTER_DAILY_USER_LIMIT',
        message: '今日已生成 10/10 张，明日恢复；如需调整，请联系管理员',
        details: { scope: 'user', current: 10, limit: 10 },
      },
    });
  });
});
