import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, ApiError, type AuthTokens, type AuthUser } from '../lib/api';

interface AuthState {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 用 refreshToken 换新 accessToken，保持后台会话不掉线。返回是否成功。 */
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

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.login(email, password);
          // 后台允许 ADMIN/STAFF/AGENT（代理可进但只看自己树内数据）
          // CUSTOMER 仍拒绝 —— 他们有专用前台 5173
          if (res.user.role === 'CUSTOMER') {
            api.logout(res.tokens.refreshToken).catch(() => undefined);
            throw new ApiError(403, {
              code: 'WRONG_PORTAL',
              message: '客户账号请到前台 http://localhost:5173 登录',
            });
          }
          set({ user: res.user, tokens: res.tokens, isLoading: false });
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof ApiError ? err.message : '登录失败',
          });
          throw err;
        }
      },

      logout: async () => {
        const { tokens } = get();
        if (tokens) {
          api.logout(tokens.refreshToken).catch(() => undefined);
        }
        set({ user: null, tokens: null, error: null });
      },

      refreshSession: async () => {
        const { tokens } = get();
        if (!tokens?.refreshToken) return false;
        try {
          const res = await api.refresh(tokens.refreshToken);
          set({ tokens: res.tokens });
          return true;
        } catch {
          set({ user: null, tokens: null });
          return false;
        }
      },
    }),
    {
      name: 'ftm-admin-auth',
      partialize: (state) => ({ user: state.user, tokens: state.tokens }),
    },
  ),
);

