import type { FastifyInstance } from 'fastify';
import { type User, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateRefreshToken, hashToken } from '../../lib/tokens.js';
import { AppError, ConflictError, ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthResult {
  user: Pick<User, 'id' | 'email' | 'role' | 'displayName'>;
  tokens: AuthTokens;
}

export interface IssueTokensContext {
  userAgent?: string;
  ipAddress?: string;
}

/**
 * 刷新令牌轮换的「并发宽限窗」（毫秒）。
 *
 * refreshToken 一次性轮换：换新时旧 token 立即作废。但前端在正常使用中很容易同时
 * 发出多个刷新（多标签页、定时续期与 401 重试撞车、开发期 StrictMode 双挂载），
 * 它们带的是同一个尚未过期的旧 token —— 其中一个轮换成功，其余会撞到「已作废」。
 *
 * 若把这种毫秒级并发当成 token 重放去「撤销该用户所有会话」，正常使用会被瞬间踢下线。
 * 因此：只有当旧 token 是「很久以前」被作废（超过本窗口）才判定为真正的重放并全撤销；
 * 窗口内的并发只拒绝这一次请求（REFRESH_TOKEN_RACE，非 401），不牵连整个会话。
 */
const REFRESH_REUSE_GRACE_MS = 10_000;

/** 并发刷新竞争：这一次刷新输给了同时发生的另一次轮换。非会话失效，调用方可忽略/重试。 */
export class RefreshTokenRaceError extends AppError {
  constructor() {
    super('Refresh token was just rotated by a concurrent request; retry', {
      statusCode: 409,
      code: 'REFRESH_TOKEN_RACE',
    });
    this.name = 'RefreshTokenRaceError';
  }
}

export class AuthService {
  constructor(private readonly app: FastifyInstance) {}

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    role?: UserRole;
  }, ctx: IssueTokensContext = {}): Promise<AuthResult> {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        displayName: input.displayName,
        role: input.role ?? UserRole.CUSTOMER,
      },
    });

    const tokens = await this.issueTokens(user, ctx);
    return {
      user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
      tokens,
    };
  }

  async login(input: { email: string; password: string }, ctx: IssueTokensContext = {}): Promise<AuthResult> {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !user.passwordHash) {
      // Fixed-time-ish: intentionally don't distinguish missing user vs wrong password.
      throw new UnauthorizedError('Invalid email or password');
    }
    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) throw new UnauthorizedError('Invalid email or password');

    // 代理账号停用拦截：仅在登录时校验（此处不牵连已持有 access/refresh token 的存量会话——
    // 已登录设备在 access token 到期前仍可继续访问，是已知的遗留风险，非本次范围内解决）。
    if (user.role === UserRole.AGENT) {
      const agent = await prisma.agent.findUnique({
        where: { userId: user.id },
        select: { isActive: true },
      });
      if (agent && !agent.isActive) {
        throw new ForbiddenError('账号已停用，请联系管理员');
      }
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tokens = await this.issueTokens(user, ctx);
    return {
      user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
      tokens,
    };
  }

  async refresh(refreshToken: string, ctx: IssueTokensContext = {}): Promise<AuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!record || record.expiresAt < new Date()) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // 令牌已被作废：区分「真正的重放」与「客户端毫秒级并发轮换」。
    // - 很久以前作废（超过宽限窗）→ 视为 token 重放 → 撤销该用户所有会话强制重登录。
    // - 宽限窗内作废（另一并发刷新刚刚轮换掉它）→ 只拒绝这一次，不牵连整个会话。
    if (record.revokedAt) {
      const revokedAgeMs = Date.now() - record.revokedAt.getTime();
      if (revokedAgeMs > REFRESH_REUSE_GRACE_MS) {
        await prisma.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        throw new UnauthorizedError('Refresh token reuse detected, please login again');
      }
      throw new RefreshTokenRaceError();
    }

    // ── 原子轮换：CAS revoke — 并发两个 refresh 只会有一个抢到（count=1）──
    const cas = await prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (cas.count !== 1) {
      // 抢锁失败：在 findUnique 与本次 CAS 之间，另一并发刷新刚把它轮换掉了。
      // 这是良性并发（真正的重放已在上面「已作废」分支按时效判定），只拒绝这一次。
      throw new RefreshTokenRaceError();
    }

    return this.issueTokens(record.user, ctx);
  }

  /**
   * 微信小程序登录：wx.login → code → 换 openid + unionId
   *
   * 开发模式（WECHAT_MP_APPID / _APPSECRET 未配置 或 code 以 `dev:` 开头）：
   *   - 直接用 code 作为 "openid"，跳过 jscode2session 调用
   *   - 让小程序在本地 Taro 开发者工具里也能跑完整登录流程
   *
   * 生产：
   *   - GET https://api.weixin.qq.com/sns/jscode2session?appid=X&secret=Y&js_code=Z&grant_type=authorization_code
   *   - 返回 { openid, session_key, unionid? }
   *   - 找/建 User + 发 JWT
   */
  async loginWithWechat(
    input: { code: string; userInfo?: { nickName?: string; avatarUrl?: string } },
    ctx: IssueTokensContext = {},
  ): Promise<AuthResult> {
    let openid: string;
    let unionid: string | undefined;

    const hasWxCreds = !!env.WECHAT_MP_APPID && !!env.WECHAT_MP_APPSECRET;
    const devCode = input.code.startsWith('dev:');
    const isDev = devCode || !hasWxCreds;

    // 生产环境 fail-closed：NODE_ENV=production 下必须有真凭证且拒绝 dev: 前缀
    // （避免 env 漏配导致接受任意 code 以合成 openid 登录）
    if (env.NODE_ENV === 'production') {
      if (!hasWxCreds) {
        throw new UnauthorizedError(
          '微信登录不可用：WECHAT_MP_APPID / WECHAT_MP_APPSECRET 未配置',
        );
      }
      if (devCode) {
        throw new UnauthorizedError('生产环境不接受 dev: 前缀的测试 code');
      }
    }

    if (isDev) {
      // eslint-disable-next-line no-console
      console.log(`[auth:wechat] DEV mode — using code=${input.code} as synthetic openid`);
      openid = `dev_${input.code.replace(/^dev:/, '')}`;
    } else {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(env.WECHAT_MP_APPID!)}&secret=${encodeURIComponent(env.WECHAT_MP_APPSECRET!)}&js_code=${encodeURIComponent(input.code)}&grant_type=authorization_code`;
      // P3 修复：8s 硬超时（移动网络 + 微信接口偶发 stall 不应 block worker）
      // 超时要覆盖 fetch + body 读；headers 到了但 body 卡住也应触发 abort
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let body: {
        openid?: string;
        session_key?: string;
        unionid?: string;
        errcode?: number;
        errmsg?: string;
      };
      try {
        const resp = await fetch(url, { signal: controller.signal });
        body = (await resp.json()) as typeof body; // 也被 signal 控制（stream 断 → json 抛）
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          throw new UnauthorizedError('微信登录超时：jscode2session 8 秒未响应或 body 读取超时');
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
      if (!body.openid || body.errcode) {
        throw new UnauthorizedError(
          `微信登录失败：${body.errmsg ?? 'jscode2session 无 openid'} (code=${body.errcode ?? '-'})`,
        );
      }
      openid = body.openid;
      unionid = body.unionid;
    }

    // find or create — 处理并发首次登录的 race condition
    let user = await prisma.user.findUnique({ where: { wechatOpenId: openid } });
    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            wechatOpenId: openid,
            wechatUnionId: unionid,
            displayName: input.userInfo?.nickName ?? '微信用户',
            role: UserRole.CUSTOMER,
          },
        });
      } catch (err) {
        // P2002 = Unique constraint violation；说明另一个并发请求刚创建了同 openid 用户
        // 重新读一次拿到那条记录即可（幂等）
        const code = (err as { code?: string })?.code;
        if (code === 'P2002') {
          user = await prisma.user.findUnique({ where: { wechatOpenId: openid } });
          if (!user) throw err; // 理论不可达
        } else {
          throw err;
        }
      }
    } else if (input.userInfo?.nickName && user.displayName !== input.userInfo.nickName) {
      // 昵称刷新
      await prisma.user.update({
        where: { id: user.id },
        data: { displayName: input.userInfo.nickName },
      });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tokens = await this.issueTokens(user, ctx);
    return {
      user: { id: user.id, email: user.email, role: user.role, displayName: user.displayName },
      tokens,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    // Idempotent: don't error if the token doesn't exist.
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(user: User, ctx: IssueTokensContext): Promise<AuthTokens> {
    const accessToken = this.app.jwt.sign({ sub: user.id, role: user.role });

    const { token: refreshToken, tokenHash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: env.JWT_ACCESS_TTL,
      refreshTokenExpiresIn: env.JWT_REFRESH_TTL,
    };
  }
}
