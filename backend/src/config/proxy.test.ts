/**
 * 反代拓扑与客户端 IP 识别（req.ip 决定限流分桶、审计日志 IP、登录日志 IP）。
 *
 * 线上两条链路：
 *   admin / store 域：客户端 → Caddy → 前端 nginx 容器（/api/ 反代）→ backend
 *   api 域         ：客户端 → Caddy → backend
 * 两条都只能让 backend 信任「紧挨着它的那一跳」写进 X-Forwarded-For 的值；前端 nginx 必须原样透传
 * Caddy 写的值，而不是再追加一段——追加的话最右那段是 Caddy 的内网地址，所有人的 req.ip 都变成
 * 同一个 docker 网关 IP，按 IP 限流就成了全站共用一个桶（一个人连输错密码，所有人被锁一分钟）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { TRUST_PROXY_HOPS } from './proxy.js';

async function clientIpOf(remoteAddress: string, xForwardedFor?: string): Promise<string> {
  const app = Fastify({ trustProxy: TRUST_PROXY_HOPS });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    headers: xForwardedFor === undefined ? {} : { 'x-forwarded-for': xForwardedFor },
  });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe('反代拓扑 · req.ip 取到真实来访 IP', () => {
  it('admin / store 域：nginx 透传 Caddy 写的来访 IP → 取到来访 IP，不同来访者各自分桶', async () => {
    expect(await clientIpOf('172.18.0.5', '203.0.113.7')).toBe('203.0.113.7');
    expect(await clientIpOf('172.18.0.5', '198.51.100.9')).toBe('198.51.100.9');
  });

  it('api 域：Caddy 直连 backend → 同样取到来访 IP', async () => {
    expect(await clientIpOf('172.18.0.1', '203.0.113.7')).toBe('203.0.113.7');
  });

  it('客户端自带伪造的 X-Forwarded-For：只认最右一段（由 Caddy 写入），伪造段不起作用', async () => {
    expect(await clientIpOf('172.18.0.5', '10.9.9.9, 203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('前端 nginx 反代配置守卫', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

  it.each(['admin-web/nginx.conf', 'sales-web/nginx.conf'])(
    '%s 的 /api/ 原样透传 X-Forwarded-For，不追加 Caddy 的内网地址',
    (file) => {
      const conf = readFileSync(path.join(repoRoot, file), 'utf8');
      expect(conf).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$http_x_forwarded_for;/);
      expect(conf).not.toMatch(/\$proxy_add_x_forwarded_for/);
    },
  );
});
