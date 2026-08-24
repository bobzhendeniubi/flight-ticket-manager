import type { FastifyInstance } from 'fastify';
import { type User, StaffRole, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateRefreshToken, hashToken } from '../../lib/tokens.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../lib/errors.js';
import { env } from '../../config/env.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface AuthResult {
  user: Pick<User, 'id' | 'email' | 'role' | 'displayName' | 'mustChangePassword'>;
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
 *
 * 窗口取 60s：多标签页场景里，后台隐藏标签的轮询会被浏览器节流到分钟级，兄弟标签轮换掉旧
 * token 后，本标签可能过了几十秒才拿着这份（已作废的）旧 token 来刷。这仍是「正常并发轮换
 * 竞争」而非重放，宽限窗要覆盖到这个量级，才不会把多标签正常使用误判成重放而全账号踢下线。
 * 前端已在 refreshSession 里先从存储同步兄弟标签的新令牌来从源头减少这种迟到刷新，此窗口是兜底。
 */
const REFRESH_REUSE_GRACE_MS = 60_000;

/**
 * 「立即失效」时间戳：把 expiresAt 打到过去，让该 token 在 refresh 里走**过期分支（401）**，
 * 而不是落进上面的并发宽限窗被当成良性竞争（409）。
 *
 * 宽限窗只该覆盖「轮换」造成的作废——那是正常使用中的毫秒级并发。而登出、以及重放检测触发的
 * 全撤销，是**确凿的会话终结**：客户端必须立刻被判死并重新登录，绝不能收到「稍后重试」的 409
 * ——否则被盗用场景里，其余会话在宽限窗内还能继续按「良性竞争」重试，踢不干净。
 * 退 1 秒是为了避开同毫秒比较（`expiresAt < new Date()` 用严格小于）。
 */
function expireImmediately(): Date {
  return new Date(Date.now() - 1000);
}

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
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        mustChangePassword: user.mustChangePassword,
      },
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

    if (user.disabledAt) {
      throw new ForbiddenError('账号已停用，请联系管理员');
    }

    // 代理账号停用拦截（登录时）：提前挡掉，避免给已停用账号签发新 token。
    // 已签发的存量 token 由 authenticate 中间件（plugins/auth.ts）逐请求校验 isActive，
    // 停用对新登录和已登录会话都立即生效，不依赖这里。
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
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        mustChangePassword: user.mustChangePassword,
      },
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
    if (record.user.disabledAt != null) {
      throw new UnauthorizedError('账号已停用，请联系管理员');
    }
    if (record.authVersion !== record.user.authVersion) {
      throw new UnauthorizedError('会话已失效，请重新登录');
    }

    // 令牌已被作废：区分「真正的重放」与「客户端毫秒级并发轮换」。
    // - 很久以前作废（超过宽限窗）→ 视为 token 重放 → 撤销该用户所有会话强制重登录。
    // - 宽限窗内作废（另一并发刷新刚刚轮换掉它）→ 只拒绝这一次，不牵连整个会话。
    if (record.revokedAt) {
      const revokedAgeMs = Date.now() - record.revokedAt.getTime();
      if (revokedAgeMs > REFRESH_REUSE_GRACE_MS) {
        // 全撤销同时把 expiresAt 打到过去：被撤销的兄弟会话下一次刷新直接吃 401（会话终结），
        // 而不是在宽限窗里被当成良性并发竞争（409）继续重试——盗用场景必须踢干净。
        await prisma.refreshToken.updateMany({
          where: { userId: record.userId, revokedAt: null },
          data: { revokedAt: new Date(), expiresAt: expireImmediately() },
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
    }

    if (user.disabledAt) {
      throw new ForbiddenError('账号已停用，请联系管理员');
    }

    if (input.userInfo?.nickName && user.displayName !== input.userInfo.nickName) {
      // 昵称刷新
      await prisma.user.update({
        where: { id: user.id },
        data: { displayName: input.userInfo.nickName },
      });
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tokens = await this.issueTokens(user, ctx);
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        mustChangePassword: user.mustChangePassword,
      },
      tokens,
    };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: IssueTokensContext = {},
  ): Promise<AuthResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedError('账号不存在');
    if (!user.passwordHash) {
      throw new BadRequestError('该账号未设置密码，无法修改');
    }

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) throw new UnauthorizedError('当前密码不正确');
    if (newPassword === currentPassword) {
      throw new BadRequestError('新密码不能与当前密码相同');
    }

    const passwordHash = await hashPassword(newPassword);
    const { updatedUser, tokens } = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false, authVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), expiresAt: expireImmediately() },
      });
      // 新 refresh token 与密码更新、旧会话撤销共用事务；创建失败时不留下半完成的改密状态。
      const tokens = await this.issueTokens(updated, ctx, tx);
      return { updatedUser: updated, tokens };
    });

    return {
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        role: updatedUser.role,
        displayName: updatedUser.displayName,
        mustChangePassword: updatedUser.mustChangePassword,
      },
      tokens,
    };
  }

  async adminResetPassword(
    targetUserId: string,
    newPassword: string,
  ): Promise<Pick<User, 'id' | 'email' | 'displayName'>> {
    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) throw new NotFoundError('用户不存在');
    if (!target.email) {
      throw new BadRequestError('该账号没有邮箱，无法使用密码登录');
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: targetUserId },
        data: { passwordHash, mustChangePassword: true, authVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date(), expiresAt: expireImmediately() },
      });
    });

    return { id: target.id, email: target.email, displayName: target.displayName };
  }

  async createInternalUser(input: {
    email: string;
    password: string;
    displayName: string;
    role: Extract<UserRole, 'ADMIN' | 'STAFF'>;
    staffRole?: StaffRole | null;
  }): Promise<Pick<User, 'id' | 'email' | 'displayName' | 'role' | 'staffRole'>> {
    if (input.role !== UserRole.ADMIN && input.role !== UserRole.STAFF) {
      throw new BadRequestError('内部账号角色无效');
    }
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictError('邮箱已被占用');

    const passwordHash = await hashPassword(input.password);
    try {
      return await prisma.user.create({
        data: {
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          role: input.role,
          staffRole: input.role === UserRole.STAFF ? (input.staffRole ?? null) : null,
          mustChangePassword: true,
        },
        select: { id: true, email: true, displayName: true, role: true, staffRole: true },
      });
    } catch (err) {
      // 并发开户的唯一键冲突也按邮箱占用返回，避免把可理解的业务冲突暴露成 500。
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictError('邮箱已被占用');
      }
      throw err;
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    // Idempotent: don't error if the token doesn't exist.
    // 同时把 expiresAt 打到过去：主动登出是确凿的会话终结，登出后再拿这枚 token 来刷必须是 401，
    // 而不是落进并发宽限窗被当成「稍后重试」的 409——否则客户端会以为会话还活着而反复重试。
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), expiresAt: expireImmediately() },
    });
  }

  private async issueTokens(
    user: User,
    ctx: IssueTokensContext,
    client: Pick<typeof prisma, 'refreshToken'> = prisma,
  ): Promise<AuthTokens> {
    const accessToken = this.app.jwt.sign({ sub: user.id, role: user.role, ver: user.authVersion });

    const { token: refreshToken, tokenHash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL * 1000);

    await client.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        authVersion: user.authVersion,
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
