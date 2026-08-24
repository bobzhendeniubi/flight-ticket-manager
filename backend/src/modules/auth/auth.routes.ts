import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import {
  loginBodySchema,
  changePasswordBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';

const wechatLoginBodySchema = z.object({
  code: z.string().min(1, 'code 必填'),
  userInfo: z
    .object({
      nickName: z.string().max(100).optional(),
      avatarUrl: z.string().max(500).optional(),
    })
    .optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  const service = new AuthService(app);

  // 客户账号由后台（销售/客服）开通，不开放匿名自助注册。
  // 匿名 /register 会直接建 CUSTOMER 并发 token —— 前端虽已把注册页重定向到登录，
  // 后端裸开=UI 伪装而非权限。游客可免登录下单，正式账号走此受控入口或 /wechat 微信登录。
  app.post(
    '/register',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req, reply) => {
      const body = registerBodySchema.parse(req.body);
      const result = await service.register(body, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/login',
    {
      // 覆盖全局限流：登录口更严（~8 req/min/IP），防暴力破解密码。
      config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = loginBodySchema.parse(req.body);
      return service.login(body, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });
    },
  );

  app.post(
    '/change-password',
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = changePasswordBodySchema.parse(req.body);
      return service.changePassword(req.user.sub, body.currentPassword, body.newPassword, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });
    },
  );

  app.post('/refresh', async (req) => {
    const body = refreshBodySchema.parse(req.body);
    const tokens = await service.refresh(body.refreshToken, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return { tokens };
  });

  /**
   * 微信小程序登录
   * body: { code: wx.login 返回的 code, userInfo?: { nickName, avatarUrl } }
   * 返回: { user, tokens } —— 同 /login 结构
   */
  app.post('/wechat', async (req) => {
    const body = wechatLoginBodySchema.parse(req.body);
    return service.loginWithWechat(body, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  });

  app.post('/logout', async (req, reply) => {
    const body = logoutBodySchema.parse(req.body);
    await service.logout(body.refreshToken);
    return reply.status(204).send();
  });
};
