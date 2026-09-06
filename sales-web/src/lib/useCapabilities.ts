/**
 * 能力钩子：前台权限判断的唯一入口，与后台 admin-web 的同名钩子一个写法。
 *
 * 能力清单由后端 GET /users/me 随用户一起返回（见 backend/src/lib/capabilities.ts），
 * 与后端 requireCapability 用的是同一张表、同一个纯函数。前端不再自己拼
 * `role === 'AGENT' || role === 'ADMIN' || role === 'STAFF'` —— 那种写法要在前后端
 * 各写一遍，改口径时总有一边漏掉。
 *
 * 清单跟着 user 一起进 auth store（也一起 persist），刷新页面不丢；
 * Layout 挂载时那次 /users/me 会把它刷一遍，改岗后下次进站即生效。
 */
import { useMemo } from 'react';
import { useAuth } from '../stores/auth';
import type { Capability } from './capabilities';

export interface Capabilities {
  /** 是否持有某项能力。 */
  can: (cap: Capability) => boolean;
  /**
   * 能力清单是否已经从后端拿到。
   *
   * 登录那一瞬间 /auth/login 的响应里还没有能力清单，要等 Layout 的 /users/me 回来。
   * 路由守卫在这个窗口里**乐观放行**：悲观拦截会让代理刚登录就被弹回首页，
   * 数据保护始终由后端闸兜底。
   */
  ready: boolean;
}

export function useCapabilities(): Capabilities {
  const capabilities = useAuth((s) => s.user?.capabilities);

  return useMemo(() => {
    const held = new Set<string>(capabilities ?? []);
    return {
      can: (cap: Capability) => held.has(cap),
      ready: capabilities != null,
    };
  }, [capabilities]);
}
