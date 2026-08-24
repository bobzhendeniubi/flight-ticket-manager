import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { StaffRole, UserRole } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError, ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { prisma } from '../db/prisma.js';

export interface AccessTokenPayload {
  sub: string; // user id
  role: UserRole;
  /** 会话版本号；旧部署签发的 token 没有 ver，按兼容宽限口径跳过版本检查。 */
  ver?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Verifies the Authorization bearer token and attaches request.user. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Optional auth for routes that work both logged-in and as guest (e.g. guest checkout).
     * · 没带 Authorization 头 → 游客，request.user 保持 undefined，绝不 401；
     * · 带了但无效/过期     → 401（让客户端去续期并自动重试，而不是被静默降级成游客）；
     * · 带了且有效         → attaches request.user（停用账号除外，见实现）。
     */
    optionalAuthenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Factory: returns a preHandler that requires one of the given roles. */
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Requires ADMIN or STAFF with the finance staff role. */
    requireFinanceAccess: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** Set by `authenticate`; may be undefined on `optionalAuthenticate` routes. */
    user: AccessTokenPayload;
    /** Set from the current User row by authenticate/optionalAuthenticate. */
    staffRole?: StaffRole | null;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

/**
 * 账号停用即时生效的共享判定 —— authenticate 与 optionalAuthenticate 都用它逐请求复核，
 * 避免两处校验漂移（以后改账号失效口径只改这一处）。
 *
 * 背景：登录时的停用拦截（auth.service.ts）只挡得住新登录；已签发的 access token 在到期前
 * 仍会通过 jwtVerify，持旧 token 的设备可继续访问。因此每个「携带有效 token 的请求」都补一次
 * User 主键查询——停用后存量 token 立即失效，不必等其自然过期。access token TTL 目前为 1 小时，
 * 这里用每请求一次查询换取停用的即时生效，是有意保留的安全取舍。
 *
 * 一次查询同时返回停用判定和当前岗位。岗位不放入 token，财务权限因此可以逐请求随 User 表变更即时生效。
 * deactivated=true 表示「用户已停用、用户不存在、会话版本已失效，或 AGENT 的 Agent 记录已失效」，由调用方决定拒绝或降级。
 * DB 异常向上抛出（不静默放行），保证判定失败时绝不误授予代理身份。
 */
async function isDeactivatedUser(payload: AccessTokenPayload): Promise<{
  deactivated: boolean;
  staffRole: StaffRole | null;
  mustChangePassword: boolean;
}> {
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      disabledAt: true,
      authVersion: true,
      staffRole: true,
      mustChangePassword: true,
      agentProfile: { select: { isActive: true } },
    },
  });
  if (!user) return { deactivated: true, staffRole: null, mustChangePassword: false };
  // ver 为空代表部署前签发的旧 token；给 access token 最长一个 TTL 的自然消亡宽限，
  // 不因新增版本字段把已登录用户瞬间踢出。新签 token 都带 ver，生命周期变更后立即失效。
  const deactivated =
    user.disabledAt != null ||
    (payload.ver != null && payload.ver !== user.authVersion) ||
    (payload.role === UserRole.AGENT && (!user.agentProfile || !user.agentProfile.isActive));
  return { deactivated, staffRole: user.staffRole, mustChangePassword: user.mustChangePassword };
}

/**
 * 首登强制改密的服务端白名单：mustChangePassword=true 的账号只放行「完成改密所需的最小闭环」。
 * 强制点必须在后端 —— 前端的路由重定向（Layout 里的 Navigate）只是 UX，绕开官方前端
 * 直接携 token 调 API 的客户端不受它约束；没有这道闸，临时/重置密码可以被无限期使用，
 * 「首登强制改密」就名存实亡。
 * 白名单按 Fastify 路由模式（含注册前缀）精确匹配：
 * - POST /auth/change-password：改密本身；
 * - GET  /users/me：改密页需要当前用户信息（且响应里携带 mustChangePassword 供前端跳转）。
 * /auth/login、/auth/refresh、/auth/logout 不挂 authenticate，天然不受影响。
 */
const MUST_CHANGE_PASSWORD_ALLOWED_ROUTES = new Set(['/auth/change-password', '/users/me']);

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
    // 这些路由本就要求登录 → 停用账号的存量 token 硬拒绝（401）。
    const check = await isDeactivatedUser(req.user);
    if (check.deactivated) {
      throw new UnauthorizedError('账号已停用，请联系管理员');
    }
    // 首登强制改密：白名单外的业务路由一律 403（稳定 code，前端据此跳改密页，不靠文案匹配）。
    if (check.mustChangePassword && !MUST_CHANGE_PASSWORD_ALLOWED_ROUTES.has(req.routeOptions?.url ?? '')) {
      throw new AppError('请先修改初始密码后再继续操作', {
        statusCode: 403,
        code: 'FORCE_PASSWORD_CHANGE',
      });
    }
    req.staffRole = check.staffRole;
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
    // 口径：停用账号经 optionalAuthenticate = 降级为匿名，而非硬 401。
    // optionalAuthenticate 语义是「可选登录」，停用账号应等同「未登录」——清空 req.user 后，
    // 免登录路由（如游客下单 POST /orders、产品列表定价）继续按匿名/游客处理，绝不再按代理身份
    // 绑定 agentId 或套用代理价。选降级而非 401 是为了不破坏匿名下单路径（硬 401 会连累游客场景）。
    const check = await isDeactivatedUser(req.user);
    if (check.deactivated) {
      // fastify-jwt 成功校验后已给 req.user 赋值；这里清回 undefined，让下游 Boolean(req.user) 判定为游客。
      (req as { user?: AccessTokenPayload }).user = undefined;
      req.staffRole = undefined;
    } else {
      req.staffRole = check.staffRole;
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

  app.decorate('requireFinanceAccess', async function requireFinanceAccess(req, _reply) {
    // 岗位逐请求从 User 表取回，改岗后下一个请求立即生效，不依赖 access token 内容。
    if (!req.user) throw new UnauthorizedError();
    const allowed =
      req.user.role === UserRole.ADMIN ||
      (req.user.role === UserRole.STAFF && req.staffRole === StaffRole.FINANCE);
    if (!allowed) throw new ForbiddenError('需要财务岗权限');
  });
});
