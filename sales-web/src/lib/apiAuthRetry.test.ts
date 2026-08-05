/**
 * apiFetch 的 401 静默续期 + 自动重试单测（vitest，stub 掉 fetch 与续期桥）。
 * 与 admin-web/src/lib/apiAuthRetry.test.ts 同语义（两端故意保持一致，改口径要一起改）。
 *
 * 回归本次修复：access token 到期那一瞬间，页面并行发出的多个请求会同时吃 401。
 * 旧实现里续期结果只有「新 token / null」两态，并发轮换竞争、网络抖动都塌缩成 null →
 * 请求把原始 401 抛给上层 → 上层「401 即登出」把正在填资料/下单的用户弹回登录页。
 *
 * 现在按三态分流：
 *   refreshed   → 带新 token 重试原请求（用户操作不丢）
 *   unavailable → 抛 AUTH_REFRESH_UNAVAILABLE（非 401），会话原地保留
 *   expired     → 放行原始 401 走登出；只读请求额外退回游客视角再试一次
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiFetch,
  registerAuthRefresh,
  ApiError,
  AUTH_REFRESH_UNAVAILABLE_CODE,
  type RefreshOutcome,
} from './api';

const OLD_TOKEN = 'old-access-token';
const NEW_TOKEN = 'new-access-token';

/** 记录每次请求带的 Authorization，用来断言重试确实换了新 token / 确实摘掉了头。 */
let sentAuthHeaders: Array<string | null> = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 只认 NEW_TOKEN 的服务端：其余一律 401（含不带头的游客请求）。 */
function stubTokenAwareFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('Authorization');
    sentAuthHeaders.push(auth);
    if (auth === `Bearer ${NEW_TOKEN}`) return jsonResponse(200, { ok: true });
    return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'token 过期' } });
  });
}

/** 公开接口的服务端：带（失效的）token → 401；不带头 → 游客 200。 */
function stubPublicEndpointFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get('Authorization');
    sentAuthHeaders.push(auth);
    if (auth) return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'token 过期' } });
    return jsonResponse(200, { guest: true });
  });
}

beforeEach(() => {
  sentAuthHeaders = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 归位：避免续期桩泄漏到其它用例
  registerAuthRefresh(async () => ({ status: 'expired' }));
});

describe('apiFetch · 401 静默续期与自动重试', () => {
  it('续期拿到新 token → 用新 token 自动重试原请求，调用方拿到成功结果', async () => {
    vi.stubGlobal('fetch', stubTokenAwareFetch());
    const refresh = vi.fn(
      async (): Promise<RefreshOutcome> => ({ status: 'refreshed', accessToken: NEW_TOKEN }),
    );
    registerAuthRefresh(refresh);

    const res = await apiFetch<{ ok: boolean }>('/orders/mine', { token: OLD_TOKEN });

    expect(res).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    // 续期桥拿到的是「刚被判 401 的那枚」，store 据此判断本地新鲜度是否可信
    expect(refresh).toHaveBeenCalledWith(OLD_TOKEN);
    expect(sentAuthHeaders).toEqual([`Bearer ${OLD_TOKEN}`, `Bearer ${NEW_TOKEN}`]);
  });

  it('续期暂时不可用（并发轮换竞争/网络抖动）→ 抛 AUTH_REFRESH_UNAVAILABLE，绝不是 401', async () => {
    vi.stubGlobal('fetch', stubTokenAwareFetch());
    registerAuthRefresh(async () => ({ status: 'unavailable' }));

    const err = await apiFetch('/orders/mine', { token: OLD_TOKEN }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    // 关键：状态码不是 401 —— 上层任何「401 即登出」的分支都不会被触发，会话原地保留
    expect((err as ApiError).status).not.toBe(401);
    expect((err as ApiError).code).toBe(AUTH_REFRESH_UNAVAILABLE_CODE);
    // 也不会去做游客兜底重试（会话没失效，没这个必要）
    expect(sentAuthHeaders).toEqual([`Bearer ${OLD_TOKEN}`]);
  });

  it('续期确凿失效（expired）+ 写操作 → 放行原始 401，不做任何重试', async () => {
    vi.stubGlobal('fetch', stubPublicEndpointFetch());
    registerAuthRefresh(async () => ({ status: 'expired' }));

    const err = await apiFetch('/orders', { method: 'POST', token: OLD_TOKEN, body: { a: 1 } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    // 写操作绝不退回游客身份重试 —— 掉登录后以游客提交会写出归属错误的订单
    expect(sentAuthHeaders).toEqual([`Bearer ${OLD_TOKEN}`]);
  });

  it('续期确凿失效（expired）+ 只读请求 → 摘掉 Authorization 按游客再试一次并成功', async () => {
    // 前台商品/套餐/酒店列表本就是公开接口：散客浏览到一半掉登录不该整页报错。
    vi.stubGlobal('fetch', stubPublicEndpointFetch());
    registerAuthRefresh(async () => ({ status: 'expired' }));

    const res = await apiFetch<{ guest: boolean }>('/products/bundles', { token: OLD_TOKEN });

    expect(res).toEqual({ guest: true });
    expect(sentAuthHeaders).toEqual([`Bearer ${OLD_TOKEN}`, null]);
  });

  it('续期确凿失效（expired）+ 只读但接口本就要登录 → 游客重试也 401，照常抛给上层登出', async () => {
    vi.stubGlobal('fetch', stubTokenAwareFetch()); // 对任何非 NEW_TOKEN 请求都 401
    registerAuthRefresh(async () => ({ status: 'expired' }));

    const err = await apiFetch('/orders/mine', { token: OLD_TOKEN }).catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(401);
    // 兜底只多打一次，且第二次不带 Authorization
    expect(sentAuthHeaders).toEqual([`Bearer ${OLD_TOKEN}`, null]);
  });

  it('续期换回同一枚 token（服务端坚持拒它）→ 不再带 token 重试，不打转', async () => {
    vi.stubGlobal('fetch', stubTokenAwareFetch());
    registerAuthRefresh(async () => ({ status: 'refreshed', accessToken: OLD_TOKEN }));

    const err = await apiFetch('/orders/mine', { token: OLD_TOKEN }).catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(401);
    expect(sentAuthHeaders).toEqual([`Bearer ${OLD_TOKEN}`]);
  });

  it('重试后仍 401 → 只重试一次，不无限递归', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sentAuthHeaders.push(new Headers(init.headers).get('Authorization'));
        return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: '账号已停用' } });
      }),
    );
    const refresh = vi.fn(
      async (): Promise<RefreshOutcome> => ({ status: 'refreshed', accessToken: NEW_TOKEN }),
    );
    registerAuthRefresh(refresh);

    const err = await apiFetch('/orders/mine', { token: OLD_TOKEN }).catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(401);
    expect(sentAuthHeaders).toHaveLength(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('过期瞬间 4 个并行请求同时 401：共享一次续期，四个原请求各自用新 token 重试成功', async () => {
    vi.stubGlobal('fetch', stubTokenAwareFetch());

    // 模拟 store 侧的 single-flight：并发调用共享同一个 promise，底层只真刷一次。
    let realRefreshCount = 0;
    let inFlight: Promise<RefreshOutcome> | null = null;
    registerAuthRefresh(() => {
      if (inFlight) return inFlight;
      inFlight = (async (): Promise<RefreshOutcome> => {
        try {
          realRefreshCount += 1;
          await new Promise((r) => setTimeout(r, 10));
          return { status: 'refreshed', accessToken: NEW_TOKEN };
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    });

    const results = await Promise.all([
      apiFetch<{ ok: boolean }>('/orders/mine', { token: OLD_TOKEN }),
      apiFetch<{ ok: boolean }>('/users/me', { token: OLD_TOKEN }),
      apiFetch<{ ok: boolean }>('/agents/commissions', { token: OLD_TOKEN }),
      apiFetch<{ ok: boolean }>('/travelers', { token: OLD_TOKEN }),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    // 四个 401 只触发一次真正的 /auth/refresh —— 不会用同一 refreshToken 多次轮换
    expect(realRefreshCount).toBe(1);
    expect(sentAuthHeaders.filter((h) => h === `Bearer ${OLD_TOKEN}`)).toHaveLength(4);
    expect(sentAuthHeaders.filter((h) => h === `Bearer ${NEW_TOKEN}`)).toHaveLength(4);
  });

  it('游客请求（不带 token）401 → 不触发续期，也不做游客兜底（本来就是游客）', async () => {
    vi.stubGlobal('fetch', stubTokenAwareFetch());
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ status: 'expired' }));
    registerAuthRefresh(refresh);

    await apiFetch('/products/bundles').catch(() => undefined);

    expect(refresh).not.toHaveBeenCalled();
    expect(sentAuthHeaders).toEqual([null]);
  });
});
