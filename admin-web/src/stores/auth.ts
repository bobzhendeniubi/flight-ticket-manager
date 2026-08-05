import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  api,
  ApiError,
  registerAuthRefresh,
  type AuthTokens,
  type AuthUser,
  type RefreshOutcome,
} from '../lib/api';
import { isAccessTokenFresh } from '../lib/token';

/** persist 存储键：storage 事件按此 key 过滤，跨标签同步只认自己这份。 */
const AUTH_STORAGE_KEY = 'ftm-admin-auth';

/** 后端并发轮换竞争的稳定 code（409）：这一次刷新输给了同时发生的另一次轮换，会话仍有效。 */
const REFRESH_TOKEN_RACE_CODE = 'REFRESH_TOKEN_RACE';

/**
 * 输掉并发轮换后，等兄弟标签把新令牌落到 localStorage 的轮询参数。
 * 硬上限 = 次数 × 间隔（3 × 300ms ≈ 0.9s）—— 只覆盖「胜出方正在写盘」的毫秒级窗口；
 * 等不到就返回 unavailable（既不登出、也不假装成功），由下一次续期或请求兜底。
 */
const SIBLING_ROTATION_POLL_TIMES = 3;
const SIBLING_ROTATION_POLL_MS = 300;

/**
 * 单飞行中刷新去重（single-flight）：同一时刻只发一个 api.refresh，
 * 所有并发 refreshSession（定时续期 / 多个 401 重试 / 重复挂载）共享同一个 promise。
 * 防止用同一个 refreshToken 二次轮换，触发后端一次性轮换的竞争/重放判定。
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface AuthState {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * 用 refreshToken 换新 accessToken，保持后台会话不掉线。
   * staleAccessToken = 刚被服务端判 401 的那枚（由请求层传入）；定时体检调用可不传。
   * 返回三态见 RefreshOutcome —— 只有 'expired' 代表会话确凿失效（此时会话已被清空）。
   */
  refreshSession: (staleAccessToken?: string | null) => Promise<RefreshOutcome>;
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

      refreshSession: async (staleAccessToken = null) => {
        // 第一轮：有刷新在飞就搭车（single-flight），否则自己发起一轮。
        const first = await joinOrStartRefresh(staleAccessToken);

        // 搭车拿到的那轮，判断依据可能早于本次 401（例如它启动时 token 还"新鲜"，就直接放行了）。
        // 若它给回的仍是刚被服务端拒掉的同一枚 token，说明本地 exp 判断不可信（时钟偏差 / 服务端
        // 提前作废）—— 再强制来一轮真刷新。最多两轮，绝不原地打转。
        const sameStaleToken =
          first.status === 'refreshed' &&
          staleAccessToken != null &&
          first.accessToken === staleAccessToken;
        if (!sameStaleToken) return first;

        return joinOrStartRefresh(staleAccessToken);
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      partialize: (state) => ({ user: state.user, tokens: state.tokens }),
    },
  ),
);

/**
 * 一轮续期：有在飞就搭车，没有就自己发起并登记为在飞。
 *
 * 用 useAuth.getState()/setState() 而不是闭包里的 get/set —— 本函数在 store 之外，
 * 请求层（非 React 模块）也会经由它读写会话，统一走 store 单一真源，避免两份状态漂移。
 */
function joinOrStartRefresh(staleAccessToken: string | null): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    try {
      return await runRefresh(staleAccessToken);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** 真正干活的一轮续期（永远只在 single-flight 里被调用一次）。 */
async function runRefresh(staleAccessToken: string | null): Promise<RefreshOutcome> {
  // 取内存 tokens 之前，先从 localStorage 同步一次：后台隐藏标签的轮询用的是
  // 内存里几分钟前的旧 refreshToken，而兄弟标签可能早已把它轮换掉。若不同步就直接拿
  // 旧 token 去刷 → 撞后端「很久以前作废」的重放判定 → 撤销该用户全部会话（所有标签
  // /所有共用该账号的人一起被踢）。rehydrate 先把兄弟标签轮换出的新令牌读进来。
  await useAuth.persist?.rehydrate?.();

  const tokens = useAuth.getState().tokens;
  if (!tokens?.refreshToken) return { status: 'expired' };

  // 同步后已经换到了「与刚被拒的那枚不同、且仍新鲜」的 accessToken（兄弟标签刚轮换过 /
  // 本就没到期）→ 无需再刷，直接放行。这一步把「后台标签拿旧 token 去刷」在源头挡掉。
  // 必须排除 staleAccessToken 本身：服务端已经拒过它，本地 exp 说它新鲜也不足为凭。
  if (tokens.accessToken !== staleAccessToken && isAccessTokenFresh(tokens.accessToken)) {
    return { status: 'refreshed', accessToken: tokens.accessToken };
  }

  try {
    const res = await api.refresh(tokens.refreshToken);
    useAuth.setState({ tokens: res.tokens });
    return { status: 'refreshed', accessToken: res.tokens.accessToken };
  } catch (err) {
    // 「确凿的会话失效」(401：refresh token 真的过期/无效/被判重放) → 清会话，上层登出。
    if (err instanceof ApiError && err.status === 401) {
      useAuth.setState({ user: null, tokens: null });
      return { status: 'expired' };
    }

    // 并发轮换竞争（409）：胜出方是兄弟标签，它会把新令牌落到 localStorage。
    // 等它落盘后取用 —— 这样输的那一方也能拿到可用 token，把原请求重试掉，不掉线也不丢操作。
    if (err instanceof ApiError && err.status === 409 && err.code === REFRESH_TOKEN_RACE_CODE) {
      const winnerToken = await awaitSiblingRotation(tokens.accessToken);
      if (winnerToken) return { status: 'refreshed', accessToken: winnerToken };
    }

    // 网络抖动 / 5xx / 竞争未收敛：保留会话（绝不因一次瞬时故障把正在录单的运营踢下线），
    // 但也不谎称成功 —— 请求层据此抛 AUTH_REFRESH_UNAVAILABLE 让页面提示重试。
    return { status: 'unavailable' };
  }
}

/**
 * 输掉并发轮换后，等兄弟标签把轮换出的新令牌写进 localStorage 并取回。
 * 有硬上限（3 × 300ms）；等不到就返回 null，绝不无限等待。
 */
async function awaitSiblingRotation(beforeAccessToken: string): Promise<string | null> {
  for (let i = 0; i < SIBLING_ROTATION_POLL_TIMES; i += 1) {
    await sleep(SIBLING_ROTATION_POLL_MS);
    await useAuth.persist?.rehydrate?.();
    const next = useAuth.getState().tokens?.accessToken;
    if (next && next !== beforeAccessToken && isAccessTokenFresh(next)) return next;
  }
  return null;
}

// 请求层 401 时回调：静默续期（single-flight 去重）后把结果三态原样交回 apiFetch。
// refreshed → 带新 token 重试原请求；expired → 放行原始 401 走登出；
// unavailable → apiFetch 抛 AUTH_REFRESH_UNAVAILABLE（非 401），会话原地保留。
registerAuthRefresh((staleAccessToken) =>
  useAuth.getState().refreshSession(staleAccessToken),
);

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

