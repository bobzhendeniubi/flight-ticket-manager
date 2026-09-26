/**
 * backend 信任几跳反代写进 X-Forwarded-For 的值（Fastify trustProxy）。req.ip 由它决定——
 * 按 IP 限流分桶（登录爆破、订单号枚举、前端报错上报）、审计日志 IP、登录日志 IP 都靠它。
 *
 * 线上拓扑（一机两栈，Caddy 在宿主机上终结 TLS）：
 *   admin / store 域：客户端 → Caddy → 前端 nginx 容器（/api/ 反代）→ backend
 *   api 域         ：客户端 → Caddy → backend
 * 两条链路里紧挨着 backend 的那一跳（nginx 或 Caddy）写进 X-Forwarded-For 的最右一段就是真实来访 IP：
 * Caddy 写入来访 IP，前端 nginx 原样透传（admin-web / sales-web 的 nginx.conf 用 $http_x_forwarded_for，
 * 不能用 $proxy_add_x_forwarded_for 再追加一段 Caddy 的内网地址——那样所有人的 req.ip 都是同一个 docker
 * 网关 IP，按 IP 限流就成了全站共用一个桶）。客户端自带的伪造段只会出现在更左边，不被信任。
 *
 * 不能用 true（信任整条链）：客户端随便追加一段自定义 XFF 就能让 req.ip 跟着变，绕过所有按 IP 限流。
 * 若在 Caddy 前再加 CDN / 负载均衡，或 nginx 改回追加，这里与 nginx.conf 要一起改（config/proxy.test.ts 有守卫）。
 */
export const TRUST_PROXY_HOPS = 1;
