/**
 * lib/token · access token exp 解析 + 临期判断回归（合成 JWT，无任何真实令牌）。
 *
 * 这套口径是「多标签页令牌轮换同步」的关键闸：refreshSession 先从存储同步兄弟标签的新令牌，
 * 再用 isAccessTokenFresh 判断——仍新鲜就直接放行、不再打 /auth/refresh，从源头挡掉
 * 「后台标签拿几分钟前的旧 refreshToken 去刷 → 撞后端重放判定 → 全账号被踢」。
 */
import { describe, it, expect } from 'vitest';
import { getAccessTokenExpMs, isAccessTokenFresh, REFRESH_SKEW_MS } from './token';

/** 用给定 exp（秒）合成一个结构合法的 JWT（签名段占位，解析不校验签名）。 */
function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const NOW = 1_800_000_000_000; // 固定基准时刻，避免依赖真实时钟

describe('getAccessTokenExpMs', () => {
  it('从合法 JWT 解析出 exp（毫秒）', () => {
    const expSec = Math.floor(NOW / 1000) + 600;
    expect(getAccessTokenExpMs(jwtWithExp(expSec))).toBe(expSec * 1000);
  });

  it('null / 空串 / 非 JWT 结构 → null（当作临期，交由续期兜底）', () => {
    expect(getAccessTokenExpMs(null)).toBeNull();
    expect(getAccessTokenExpMs(undefined)).toBeNull();
    expect(getAccessTokenExpMs('')).toBeNull();
    expect(getAccessTokenExpMs('not-a-jwt')).toBeNull();
  });

  it('payload 无 exp 字段 → null', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
    expect(getAccessTokenExpMs(`h.${payload}.sig`)).toBeNull();
  });

  it('payload 非法 base64/JSON → null（不抛错）', () => {
    expect(getAccessTokenExpMs('h.@@@not-base64@@@.sig')).toBeNull();
  });
});

describe('isAccessTokenFresh', () => {
  it('距过期远大于临期窗 → 新鲜（refreshSession 应免刷直接放行）', () => {
    const expSec = Math.floor((NOW + REFRESH_SKEW_MS + 60_000) / 1000);
    expect(isAccessTokenFresh(jwtWithExp(expSec), NOW)).toBe(true);
  });

  it('剩余寿命正好等于临期窗 → 不新鲜（须续期）', () => {
    const expSec = Math.floor((NOW + REFRESH_SKEW_MS) / 1000);
    expect(isAccessTokenFresh(jwtWithExp(expSec), NOW)).toBe(false);
  });

  it('已过期 → 不新鲜', () => {
    const expSec = Math.floor((NOW - 1000) / 1000);
    expect(isAccessTokenFresh(jwtWithExp(expSec), NOW)).toBe(false);
  });

  it('解析失败（null / 无 exp）→ 不新鲜，交由续期兜底', () => {
    expect(isAccessTokenFresh(null, NOW)).toBe(false);
    expect(isAccessTokenFresh('not-a-jwt', NOW)).toBe(false);
  });
});
