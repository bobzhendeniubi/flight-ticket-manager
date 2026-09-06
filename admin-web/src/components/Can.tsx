/**
 * 按能力显隐的包装组件。
 *
 * 用法：
 *   <Can cap="orders.split"><button>拆单</button></Can>
 *   <Can cap="finances.view" fallback={<EmptyHint />}>...</Can>
 *   <Can anyOf={['hotel_control.view', 'hotel_control.manage']}>...</Can>
 *
 * 判定完全依赖后端下发的能力清单（见 hooks/useCapabilities），前端不自己判角色。
 *
 * 清单还没从 /users/me 回来时**不渲染**：少给入口，绝不谎报权限——与 exportCatalog 里
 * 「staffRole 没回来就按不是财务岗处理」是同一条口径。
 * 页面级路由与左侧菜单不适用这条：它们该乐观放行，免得整屏闪一下空，各自单独处理。
 */
import type { ReactNode } from 'react';
import { useCapabilities } from '../hooks/useCapabilities';
import type { Capability } from '../lib/capabilities';

interface CanProps {
  /** 需要的能力；与 anyOf 二选一。 */
  cap?: Capability;
  /** 任一满足即可（同一块 UI 覆盖多项能力时用）。 */
  anyOf?: Capability[];
  children: ReactNode;
  /** 没权限时渲染什么，默认什么都不渲染。 */
  fallback?: ReactNode;
}

export function Can({ cap, anyOf, children, fallback = null }: CanProps) {
  const { can, canAny, ready } = useCapabilities();
  if (!ready) return <>{fallback}</>;
  const allowed = cap ? can(cap) : anyOf ? canAny(...anyOf) : false;
  return <>{allowed ? children : fallback}</>;
}
