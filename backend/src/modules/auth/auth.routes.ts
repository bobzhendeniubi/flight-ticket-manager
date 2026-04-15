import type { FastifyPluginAsync } from 'fastify';
import {
  loginBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  const service = new AuthService(app);

  app.post('/register', async (req, reply) => {
    const body = registerBodySchema.parse(req.body);
    const result = await service.register(body, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return reply.status(201).send(result);
  });

  app.post('/login', async (req) => {
    const body = loginBodySchema.parse(req.body);
    return service.login(body, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  });

  app.post('/refresh', async (req) => {
    const body = refreshBodySchema.parse(req.body);
    const tokens = await service.refresh(body.refreshToken, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return { tokens };
  });

  app.post('/logout', async (req, reply) => {
    const body = logoutBodySchema.parse(req.body);
    await service.logout(body.refreshToken);
    return reply.status(204).send();
  });
};
