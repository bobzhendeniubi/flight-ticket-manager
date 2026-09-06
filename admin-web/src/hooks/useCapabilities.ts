/**
 * 能力钩子：前端权限判断的唯一入口。
 *
 * 能力清单由后端 GET /users/me 随用户一起返回（见 backend/src/lib/capabilities.ts），
 * 与后端 requireCapability 用的是同一张表、同一个纯函数。前端不再自己拼
 * `role === 'ADMIN' || (role === 'STAFF' && staffRole === 'FINANCE')` 这种判断——
 * 那种写法要在前后端各写一遍，改口径时总有一边漏掉：
 * 只改后端，按钮还是灰的，运营报「没有权限」；只改前端，按钮亮了但一点就 403。
 *
 * 清单跟着 user 一起进 auth store（也一起 persist），刷新页面不丢；
 * Layout 启动时那次 /users/me 体检会把它刷一遍，改岗后下次进后台即生效。
 */
import { useMemo } from 'react';
import { useAuth } from '../stores/auth';
import type { Capability } from '../lib/capabilities';

export interface Capabilities {
  /** 是否持有某项能力。 */
  can: (cap: Capability) => boolean;
  /** 是否持有其中任意一项（菜单分组这类「有一个就显示」的场景）。 */
  canAny: (...caps: Capability[]) => boolean;
  /**
   * 能力清单是否已经从后端拿到。
   *
   * 登录那一瞬间 /auth/login 的响应里还没有能力清单，要等 Layout 的 /users/me 回来。
   * 这个窗口只有几百毫秒，但足够让菜单闪一下空。各调用方按自己的场景取舍：
   * · 菜单与页面级路由 —— 未就绪时先乐观放行渲染，数据由后端闸兜底
   *   （与既有 staffRole 未就绪时的处理口径一致，见 App.tsx 的 financeRole 注释）；
   * · 危险按钮 —— 未就绪时先不显示，少给入口，绝不谎报权限。
   */
  ready: boolean;
}

export function useCapabilities(): Capabilities {
  const capabilities = useAuth((s) => s.user?.capabilities);

  return useMemo(() => {
    const held = new Set<string>(capabilities ?? []);
    return {
      can: (cap: Capability) => held.has(cap),
      canAny: (...caps: Capability[]) => caps.some((c) => held.has(c)),
      ready: capabilities != null,
    };
  }, [capabilities]);
}
