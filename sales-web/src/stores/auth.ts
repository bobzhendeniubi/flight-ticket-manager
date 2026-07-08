import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, ApiError, registerAuthRefresh, type AuthTokens, type AuthUser } from '../lib/api';

/**
 * 单飞行中刷新去重：所有并发 refreshSession 共享同一个 api.refresh。
 * 防止「定时续期 + 401 重试 + 多标签/多次挂载」用同一个 refreshToken 二次轮换，
 * 触发后端一次性轮换的重放判定（会撤销整会话）。
 */
let refreshInFlight: Promise<boolean> | null = null;

interface AuthState {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  error: string | null;

  register: (email: string, password: string, displayName?: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 用 refreshToken 换新 accessToken，保持会话不掉线。返回是否成功。 */
  refreshSession: () => Promise<boolean>;
  clearError: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      tokens: null,
      isLoading: false,
      error: null,

      clearError: () => set({ error: null }),

      register: async (email, password, displayName) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.register(email, password, displayName);
          set({ user: res.user, tokens: res.tokens, isLoading: false });
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof ApiError ? err.message : '注册失败，请重试',
          });
          throw err;
        }
      },

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.login(email, password);
          set({ user: res.user, tokens: res.tokens, isLoading: false });
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof ApiError ? err.message : '登录失败，请重试',
          });
          throw err;
        }
      },

      logout: async () => {
        const { tokens } = get();
        if (tokens) {
          // Best-effort server-side revoke; never block client logout on it.
          api.logout(tokens.refreshToken).catch(() => undefined);
        }
        set({ user: null, tokens: null, error: null });
      },

      refreshSession: async () => {
        // 已有刷新在飞：复用同一个 promise，避免用同一 refreshToken 二次轮换。
        if (refreshInFlight) return refreshInFlight;

        refreshInFlight = (async () => {
          try {
            const { tokens } = get();
            if (!tokens?.refreshToken) return false;
            try {
              const res = await api.refresh(tokens.refreshToken);
              set({ tokens: res.tokens });
              return true;
            } catch (err) {
              // 只有「确凿的会话失效」(401：refresh token 真的过期/无效/被判重放) 才清会话。
              // 网络抖动 / 5xx / 并发轮换竞争(REFRESH_TOKEN_RACE 409) 一律保留会话，等下次续期或
              // 401 重试兜底，避免一次瞬时故障就把正在使用的登录用户踢下线。
              if (err instanceof ApiError && err.status === 401) {
                set({ user: null, tokens: null });
              }
              return false;
            }
          } finally {
            refreshInFlight = null;
          }
        })();

        return refreshInFlight;
      },
    }),
    {
      name: 'ftm-auth',
      partialize: (state) => ({ user: state.user, tokens: state.tokens }),
    },
  ),
);

// 请求层 401 时回调：静默续期（单飞行去重）后返回新的 accessToken，供 apiFetch 重试。
// 续期失败返回 null → apiFetch 放行原始 401 → 上层走登出。
registerAuthRefresh(async () => {
  const ok = await useAuth.getState().refreshSession();
  return ok ? (useAuth.getState().tokens?.accessToken ?? null) : null;
});
