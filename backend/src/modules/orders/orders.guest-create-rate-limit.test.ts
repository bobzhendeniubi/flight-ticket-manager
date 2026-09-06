/**
 * POST /orders（匿名可达的游客下单入口）· 限流路由级单测（C-22）
 *
 * 背景：这条路由允许免登录访问，且 bodyLimit 放宽到 25MB（多人团护照图），
 * 全局限流桶是 100 次/分钟——匿名攻击者可持续以接近上限的频率打这个端点，
 * 是一个成本很低的带宽/内存放大型 DoS 面。修复：单独给这条路由挂一档更严的
 * per-IP 限流（GUEST_ORDER_CREATE_RATE_LIMIT，orders.routes.ts）。
 *
 * 本测试只验证「限流确实生效」，不关心下单业务是否成功——发的是空 body，
 * 会在 zod 校验阶段被拒（items/passengers 必填），但限流的 onRequest 钩子
 * 在路由处理器之前就已经计数，400 一样会被计入限流桶。
 *
 * 其它 orders 路由测试文件都不注册 @fastify/rate-limit 插件（config.rateLimit
 * 在没有插件时是无意义的 route config，不影响它们），所以这条行为需要单独起一个
 * 真的注册了限流插件的最小 app 来测。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { orderRoutes } from './orders.routes.js';

describe('POST /orders — 匿名下单入口按 IP 限流（C-22）', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    // 不设 redis：@fastify/rate-limit 默认走进程内 LRU store，单测够用。
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(orderRoutes, { prefix: '/orders' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = () =>
    app.inject({ method: 'POST', url: '/orders', payload: {}, remoteAddress: '203.0.113.9' });

  it('放行前 20 次（本路由的更严限流档），第 21 次同一 IP 触发 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const res = await post();
      statuses.push(res.statusCode);
    }
    // 前 20 次：路由自身逻辑拒收空 body（400），但没有被限流拦截（不是 429）。
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    // 第 21 次：撞上本路由更严的每分钟 20 次限流（全局桶是 100/min，不会在这里拦下）。
    expect(statuses[20]).toBe(429);
  });

  it('不同 IP 各自独立计数，不共享同一限流桶', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/orders', payload: {}, remoteAddress: '198.51.100.1' });
      expect(res.statusCode).not.toBe(429);
    }
    const otherIp = await app.inject({ method: 'POST', url: '/orders', payload: {}, remoteAddress: '198.51.100.2' });
    expect(otherIp.statusCode).not.toBe(429);
  });
});
