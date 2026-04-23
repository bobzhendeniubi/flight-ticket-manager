/**
 * Auth store — JWT 持久化到 Taro.storage。
 *
 * 小程序不像浏览器有 localStorage 的 reactive 监听；换个 tab / 重启小程序时
 * 我们手动 rehydrate。
 */
import { create } from 'zustand';
import Taro from '@tarojs/taro';
import type { AuthTokens, AuthUser } from '../lib/types';

interface AuthState {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  hydrated: boolean;

  /** 从 storage 恢复（app 启动时调一次） */
  hydrate: () => void;

  /** 登录成功后写入 + 持久化 */
  setAuth: (user: AuthUser, tokens: AuthTokens) => void;

  /** 仅换 tokens（refresh 流程） */
  setTokens: (tokens: AuthTokens) => void;

  /** 退出 — 清除一切 */
  clear: () => void;
}

const STORAGE_KEY = 'ftm_auth';

export const useAuth = create<AuthState>((set) => ({
  user: null,
  tokens: null,
  hydrated: false,

  hydrate: () => {
    try {
      const raw = Taro.getStorageSync(STORAGE_KEY) as string | undefined;
      if (!raw) {
        set({ hydrated: true });
        return;
      }
      const parsed = JSON.parse(raw) as { user: AuthUser; tokens: AuthTokens };
      set({ user: parsed.user, tokens: parsed.tokens, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setAuth: (user, tokens) => {
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify({ user, tokens }));
    set({ user, tokens });
  },

  setTokens: (tokens) => {
    const { user } = useAuth.getState();
    if (user) {
      Taro.setStorageSync(STORAGE_KEY, JSON.stringify({ user, tokens }));
    }
    set({ tokens });
  },

  clear: () => {
    Taro.removeStorageSync(STORAGE_KEY);
    set({ user: null, tokens: null });
  },
}));
