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
          // 后台只允许 ADMIN/STAFF。CUSTOMER/AGENT 拒绝并提示去前台。
          if (res.user.role !== 'ADMIN' && res.user.role !== 'STAFF') {
            // 已登录但角色不对 — 立刻撤销 token
            api.logout(res.tokens.refreshToken).catch(() => undefined);
            throw new ApiError(403, {
              code: 'WRONG_PORTAL',
              message: `当前账号是「${roleLabel(res.user.role)}」，无权登录后台。请到前台 http://localhost:5173 登录。`,
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
    }),
    {
      name: 'ftm-admin-auth',
      partialize: (state) => ({ user: state.user, tokens: state.tokens }),
    },
  ),
);

function roleLabel(role: string): string {
  return { CUSTOMER: '客户', AGENT: '代理', STAFF: '运营', ADMIN: '管理员' }[role] ?? role;
}
