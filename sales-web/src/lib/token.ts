/**
 * Access token（JWT）过期时间解析 + 「临期」判断。
 *
 * 与 admin-web/src/lib/token.ts 同语义（两端故意保持一致，改口径要一起改）。
 * stores/auth.ts 的 refreshSession 用它做「从存储同步兄弟标签的新令牌后，若仍新鲜就免刷」。
 * App.tsx 的会话保活体检也从这里引入同一份解析与阈值。
 */

/**
 * access token 进入「临期窗」的提前量（毫秒）：剩余寿命 ≤ 此值就该续期。
 * 取值要大于一次体检间隔，保证过期前总有机会续期；也用作「仍新鲜」判断的同一阈值。
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * 解析 JWT 的 exp（毫秒时间戳）。
 * 解析失败 / 无 exp → 返回 null（调用方一律当作「临期」，交由续期兜底，宁可多刷不可漏刷）。
 */
export function getAccessTokenExpMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * access token 是否仍「新鲜」——距过期还长于临期窗，无需续期。
 * exp 解析失败 / 缺失 → 视为不新鲜（false），交由续期兜底。
 */
export function isAccessTokenFresh(
  token: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const expMs = getAccessTokenExpMs(token);
  return expMs !== null && expMs - now > REFRESH_SKEW_MS;
}
