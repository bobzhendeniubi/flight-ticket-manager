import type { FastifyInstance } from 'fastify';
import { type User, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateRefreshToken, hashToken } from '../../lib/tokens.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
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
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // ── 原子轮换：CAS revoke — 并发两个 refresh 只会有一个成功 ──
    // 若已被撤销（count=0），视为 token 重放，撤销该用户所有 token 强制重登录
    const cas = await prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (cas.count !== 1) {
      await prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedError('Refresh token reuse detected, please login again');
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let resp: Response;
      try {
        resp = await fetch(url, { signal: controller.signal });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          throw new UnauthorizedError('微信登录超时：jscode2session 8 秒未响应');
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
      const body = (await resp.json()) as {
        openid?: string;
        session_key?: string;
        unionid?: string;
        errcode?: number;
        errmsg?: string;
      };
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
