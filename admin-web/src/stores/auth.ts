import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, ApiError, registerAuthRefresh, type AuthTokens, type AuthUser } from '../lib/api';
import { isAccessTokenFresh } from '../lib/token';

/** persist 存储键：storage 事件按此 key 过滤，跨标签同步只认自己这份。 */
const AUTH_STORAGE_KEY = 'ftm-admin-auth';

/**
 * 单飞行中刷新去重：所有并发 refreshSession 共享同一个 api.refresh。
 * 防止「定时续期 + 401 重试 + 多次挂载」用同一个 refreshToken 二次轮换，
 * 触发后端一次性轮换的重放判定（会撤销整会话）。
 */
let refreshInFlight: Promise<boolean> | null = null;

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
        // 已有刷新在飞：复用同一个 promise，避免用同一 refreshToken 二次轮换。
        if (refreshInFlight) return refreshInFlight;

        refreshInFlight = (async () => {
          try {
            // 取内存 tokens 之前，先从 localStorage 同步一次：后台隐藏标签的轮询用的是
            // 内存里几分钟前的旧 refreshToken，而兄弟标签可能早已把它轮换掉。若不同步就直接拿
            // 旧 token 去刷 → 撞后端「很久以前作废」的重放判定 → 撤销该用户全部会话（所有标签
            // /所有共用该账号的人一起被踢）。rehydrate 先把兄弟标签轮换出的新令牌读进来。
            await useAuth.persist?.rehydrate?.();

            const { tokens } = get();
            if (!tokens?.refreshToken) return false;

            // 同步后 accessToken 仍新鲜（兄弟标签刚轮换过 / 本就没到期）→ 无需再刷，直接放行。
            // 这一步把「后台标签拿旧 token 去刷」的场景在源头挡掉，只有真的临期才会打 /auth/refresh。
            if (isAccessTokenFresh(tokens.accessToken)) return true;

            try {
              const res = await api.refresh(tokens.refreshToken);
              set({ tokens: res.tokens });
              return true;
            } catch (err) {
              // 只有「确凿的会话失效」(401：refresh token 真的过期/无效/被判重放) 才清会话。
              // 网络抖动 / 5xx / 并发轮换竞争(REFRESH_TOKEN_RACE 409) 一律保留会话，等下次续期或 401 重试兜底，
              // 避免一次瞬时故障就把正在使用的运营踢下线。
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
      name: AUTH_STORAGE_KEY,
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

// ── 跨标签页实时同步（幂等，只在模块首次加载时注册一次）───────────────────────
// 兄弟标签轮换出新令牌、或登出时，会写入 localStorage 的 AUTH_STORAGE_KEY —— 触发本页
// storage 事件，立刻 rehydrate 跟上，避免本页继续拿旧令牌请求。
// · storage 事件只由「其它」标签页的写入触发，本页自己 set 不会触发它；因此不存在「本页刚
//   set 的新 token 又被自己盖回旧值」的问题。刷新在飞（refreshInFlight）时若收到事件，读到的
//   也是兄弟页成功轮换后的更新令牌，正是我们想要的；而并发双刷中的失败方会拿到后端
//   REFRESH_TOKEN_RACE（非 401）不落地任何 token，不会与胜出方的令牌相互覆盖。
// · 写入相同字符串时浏览器不广播 storage 事件（HTML 规范：值未变即早退），rehydrate 回写同值
//   不会在标签间形成回声风暴。
// · 登出同步：兄弟页登出后 tokens=null 落盘，rehydrate 后本页 hasSession 变 false，
//   App 的 Protected/Navigate 自然把本页导航到登录页。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== AUTH_STORAGE_KEY) return;
    void useAuth.persist?.rehydrate?.();
  });
}

