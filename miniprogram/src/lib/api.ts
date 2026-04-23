/**
 * 小程序端 API 客户端 —— 基于 Taro.request。
 *
 * 差异 vs sales-web：
 *   1. 无 fetch，用 Taro.request（支持 Promise、response 字段不同）
 *   2. 无 cookie，JWT 必须显式塞 header
 *   3. 无 localStorage，持久化用 Taro.getStorageSync
 */
import Taro from '@tarojs/taro';
import type {
  AuthResult, AuthTokens, CabinClass,
  FlightSearchResult, OrderSummary, PaymentMethod,
} from './types';

const API_URL: string = typeof API_BASE !== 'undefined' ? API_BASE : 'http://localhost:4000';

// access token 大概 15 分钟，小程序常驻后台会过期 —— 引入一个全局刷新 helper
// 延迟 import auth store 避免循环依赖
type AuthStoreApi = {
  getState: () => {
    tokens: { accessToken: string; refreshToken: string } | null;
    setTokens: (t: { accessToken: string; refreshToken: string; accessTokenExpiresIn: number; refreshTokenExpiresIn: number }) => void;
    clear: () => void;
  };
};
let _authStore: AuthStoreApi | null = null;
async function getAuthStore(): Promise<AuthStoreApi> {
  if (_authStore) return _authStore;
  // 动态 import 避免 api.ts ↔ stores/auth.ts 循环
  const mod = (await import('../stores/auth')) as unknown as { useAuth: AuthStoreApi };
  _authStore = mod.useAuth;
  return _authStore;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ── 通用 request 包装 ─────────────────────────────────────
interface RequestInit<TBody = unknown> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: TBody;
  token?: string | null;
  /** 不抛错，直接返回 response（供调用方自己判断） */
  raw?: boolean;
  /** 内部标志：refresh 重试标记，防循环 */
  __isRetry?: boolean;
}

// 多个并发请求同时 401 时，只做一次 refresh
let _refreshingPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (_refreshingPromise) return _refreshingPromise;
  _refreshingPromise = (async () => {
    try {
      const store = await getAuthStore();
      const state = store.getState();
      if (!state.tokens?.refreshToken) return null;
      const url = `${API_URL}/auth/refresh`;
      const res = await Taro.request({
        url,
        method: 'POST',
        header: { 'content-type': 'application/json' },
        data: { refreshToken: state.tokens.refreshToken },
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // refresh token 也失效了 —— 踢出登录
        state.clear();
        return null;
      }
      const body = res.data as { tokens: { accessToken: string; refreshToken: string; accessTokenExpiresIn: number; refreshTokenExpiresIn: number } };
      state.setTokens(body.tokens);
      return body.tokens.accessToken;
    } catch {
      return null;
    } finally {
      // 下一波 401 可以再试
      setTimeout(() => { _refreshingPromise = null; }, 0);
    }
  })();
  return _refreshingPromise;
}

export async function apiFetch<TResp, TBody = unknown>(
  path: string,
  init: RequestInit<TBody> = {},
): Promise<TResp> {
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const header: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (init.token) header['authorization'] = `Bearer ${init.token}`;

  const res = await Taro.request({
    url,
    method: init.method ?? 'GET',
    header,
    data: init.body,
  });

  // Taro 的 request 不会因 4xx/5xx reject —— 我们自己判断
  if (res.statusCode >= 200 && res.statusCode < 300) {
    return res.data as TResp;
  }

  // 401 + 带 token + 非 auth 路径 + 未重试过 → 自动 refresh 重试一次
  const isAuthPath = path.startsWith('/auth/');
  if (res.statusCode === 401 && init.token && !isAuthPath && !init.__isRetry) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      return apiFetch<TResp, TBody>(path, { ...init, token: newToken, __isRetry: true });
    }
  }

  const body = res.data as { error?: { code?: string; message?: string; details?: unknown } };
  throw new ApiError(
    res.statusCode,
    body?.error?.code ?? 'UNKNOWN',
    body?.error?.message ?? `HTTP ${res.statusCode}`,
    body?.error?.details,
  );
}

// ── Typed endpoints ───────────────────────────────────────
export const api = {
  // 认证 — 微信登录（code 换 JWT）
  wechatLogin: (code: string, userInfo?: { nickName?: string; avatarUrl?: string }) =>
    apiFetch<AuthResult>('/auth/wechat', {
      method: 'POST',
      body: { code, userInfo },
    }),

  // fallback dev 登录（开发者工具里跑，不真调微信服务端）
  devLogin: (email: string, password: string) =>
    apiFetch<AuthResult>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),

  refreshToken: (refreshToken: string) =>
    apiFetch<{ tokens: AuthTokens }>('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
    }),

  // 航班
  searchFlights: (params: {
    origin?: string;
    destination?: string;
    date?: string;
    cabin?: CabinClass;
    passengers?: number;
  }) => {
    const qs: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== null) {
        qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    return apiFetch<{ results: FlightSearchResult[] }>(`/flights/search?${qs.join('&')}`);
  },

  // 订单 — 创建 / 列表 / 详情
  createOrder: (
    token: string,
    body: {
      contactName: string;
      contactPhone: string;
      contactEmail?: string;
      paymentMethod: PaymentMethod;
      items: Array<Record<string, unknown>>;
      passengers: Array<Record<string, unknown>>;
      idempotencyKey?: string;
      notes?: string;
    },
  ) => apiFetch<{ order: OrderSummary }>('/orders/', { method: 'POST', token, body }),

  listMyOrders: (token: string) =>
    apiFetch<{ orders: OrderSummary[] }>('/orders?mine=1', { token }),

  getOrder: (token: string, id: string) =>
    apiFetch<{ order: OrderSummary }>(`/orders/${id}`, { token }),

  // 微信支付 JSAPI prepay — 返回给 wx.requestPayment 的参数
  wechatMiniappPrepay: (token: string, orderId: string) =>
    apiFetch<{
      timeStamp: string;
      nonceStr: string;
      package: string;
      signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
      paySign: string;
    }>(`/payments/wechat/miniapp-prepay`, {
      method: 'POST',
      token,
      body: { orderId },
    }),
};
