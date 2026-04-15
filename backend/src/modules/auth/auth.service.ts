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

    // Rotate: revoke old, issue new.
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(record.user, ctx);
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
