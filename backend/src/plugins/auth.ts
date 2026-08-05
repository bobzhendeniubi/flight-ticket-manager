import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { prisma } from '../db/prisma.js';

export interface AccessTokenPayload {
  sub: string; // user id
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Verifies the Authorization bearer token and attaches request.user. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Optional auth for routes that work both logged-in and as guest (e.g. guest checkout).
     * · 没带 Authorization 头 → 游客，request.user 保持 undefined，绝不 401；
     * · 带了但无效/过期     → 401（让客户端去续期并自动重试，而不是被静默降级成游客）；
     * · 带了且有效         → attaches request.user（停用代理除外，见实现）。
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

/**
 * 停用代理即时生效的共享判定 —— authenticate 与 optionalAuthenticate 都用它逐请求复核，
 * 避免两处校验漂移（以后改 isActive 口径只改这一处）。
 *
 * 背景：登录时的停用拦截（auth.service.ts）只挡得住新登录；已签发的 access token 在到期前
 * 仍会通过 jwtVerify，持旧 token 的设备可继续按代理身份访问。因此对每个「携带有效 token 的
 * AGENT 请求」补一次 Agent.isActive 查询——停用后存量 token 立即失效，不必等其自然过期。
 *
 * 仅 role=AGENT 触发一次 DB 查询；ADMIN/STAFF/CUSTOMER 直接返回 false（不查、不受影响）。
 * 返回 true 表示「该 token 的代理已停用（或 Agent 记录缺失）」，由调用方决定拒绝或降级。
 * DB 异常向上抛出（不静默放行），保证判定失败时绝不误授予代理身份。
 */
async function isDeactivatedAgent(payload: AccessTokenPayload): Promise<boolean> {
  if (payload.role !== UserRole.AGENT) return false;
  const agent = await prisma.agent.findUnique({
    where: { userId: payload.sub },
    select: { isActive: true },
  });
  return !agent || !agent.isActive;
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
    // 这些路由本就要求登录 → 停用代理的存量 token 硬拒绝（401）。
    if (await isDeactivatedAgent(req.user)) {
      throw new UnauthorizedError('账号已停用，请联系管理员');
    }
  });

  app.decorate('optionalAuthenticate', async function optionalAuthenticate(req, _reply) {
    // No Authorization header → treat as guest, do not 401.
    const hasAuthHeader = typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0;
    if (!hasAuthHeader) return;

    // Header present but invalid/expired → 401（而不是静默降级为游客）。
    //
    // 口径变更的理由：静默降级会让「access token 刚过期」的登录用户毫无征兆地拿到游客视角——
    // 后台产品页的成本价整片消失、下单被当成游客单而丢掉账号归属，且因为响应是 200，
    // 客户端的 401 续期通道永远不会被触发，坏状态能一直挂着不自愈。
    // 改成 401 后，客户端会静默续期并自动重试；真正的游客（不带头）路径分毫不动。
    // jwtVerify() populates req.user on success.
    try {
      await req.jwtVerify();
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }
    // 口径：停用代理经 optionalAuthenticate = 降级为匿名，而非硬 401。
    // optionalAuthenticate 语义是「可选登录」，停用代理应等同「未登录」——清空 req.user 后，
    // 免登录路由（如游客下单 POST /orders、产品列表定价）继续按匿名/游客处理，绝不再按代理身份
    // 绑定 agentId 或套用代理价。选降级而非 401 是为了不破坏匿名下单路径（硬 401 会连累游客场景）。
    if (await isDeactivatedAgent(req.user)) {
      // fastify-jwt 成功校验后已给 req.user 赋值；这里清回 undefined，让下游 Boolean(req.user) 判定为游客。
      (req as { user?: AccessTokenPayload }).user = undefined;
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
