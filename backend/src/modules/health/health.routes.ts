import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness: always 200 if the process is up.
  app.get('/healthz', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Readiness: verifies dependencies.
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { postgres: 'fail', redis: 'fail' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch (err) {
      app.log.warn({ err }, 'readiness: postgres check failed');
    }

    try {
      const pong = await redis.ping();
      if (pong === 'PONG') checks.redis = 'ok';
    } catch (err) {
      app.log.warn({ err }, 'readiness: redis check failed');
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.status(allOk ? 200 : 503).send({ status: allOk ? 'ok' : 'degraded', checks });
  });
};
