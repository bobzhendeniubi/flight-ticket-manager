import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

export interface AccessTokenPayload {
  sub: string; // user id
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Verifies the Authorization bearer token and attaches request.user. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Best-effort auth: if an Authorization header is present and valid, attaches
     * request.user; otherwise leaves it undefined and does NOT 401. Use for routes
     * that work both logged-in and as guest (e.g. guest checkout).
     */
    optionalAuthenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Factory: returns a preHandler that requires one of the given roles. */
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Set by `authenticate`; may be undefined on `optionalAuthenticate` routes. */
    user: AccessTokenPayload;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

export const authPlugin = fp(async function authPlugin(app: FastifyInstance) {
  await app.register(fastifyJwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: `${env.JWT_ACCESS_TTL}s` },
  });

  app.decorate('authenticate', async function authenticate(req, _reply) {
    try {
      await req.jwtVerify();
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }
  });

  app.decorate('optionalAuthenticate', async function optionalAuthenticate(req, _reply) {
    // No Authorization header → treat as guest, do not 401.
    const hasAuthHeader = typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;
    if (!hasAuthHeader) return;
    // Header present but invalid/expired → also treat as guest (silently ignore).
    // jwtVerify() populates req.user on success.
    try {
      await req.jwtVerify();
    } catch {
      // leave req.user undefined; caller branches on its presence
    }
  });

  app.decorate('requireRole', function requireRole(...roles: UserRole[]) {
    return async function roleGuard(req: FastifyRequest, _reply: FastifyReply) {
      // requireRole implies authenticate ran first — defensive check anyway.
      if (!req.user) throw new UnauthorizedError();
      if (!roles.includes(req.user.role)) {
        throw new ForbiddenError(`Requires role: ${roles.join(' | ')}`);
      }
    };
  });
});
