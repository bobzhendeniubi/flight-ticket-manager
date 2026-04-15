import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, ApiError, type AuthTokens, type AuthUser } from '../lib/api';

interface AuthState {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  error: string | null;

  register: (email: string, password: string, displayName?: string) => Promise<void>;
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
    }),
    {
      name: 'ftm-auth',
      partialize: (state) => ({ user: state.user, tokens: state.tokens }),
    },
  ),
);
