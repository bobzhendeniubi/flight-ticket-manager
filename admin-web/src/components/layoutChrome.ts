import { createContext, useContext } from 'react';

// ── 内容区宽度口径 ─────────────────────────────────────────────────────
// 表单/详情类页面在侧栏展开时保持 1400 上限（行太长读起来累）；以下两种情况去掉上限、铺满屏宽：
//   1. 侧栏收起——收起的目的就是给表格腾宽度，若仍卡 1400，宽屏上只是居中平移、并不变宽；
//   2. 宽表页（订单管理）——列多，无论侧栏开合都按屏宽铺开，少横滑。
// 宽表页用白名单而不是让页面自己声明：外壳在页面挂载前就要定宽度，白名单一眼可查、不会闪一下。

/** 无论侧栏是否收起都铺满屏宽的页面（按路径分段命中，/orders 不会误伤 /orders-xxx）。 */
export const WIDE_PAGE_PATHS: readonly string[] = ['/orders'];

export function isWidePagePath(pathname: string): boolean {
  return WIDE_PAGE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isContentUnbounded(opts: { sidebarCollapsed: boolean; pathname: string }): boolean {
  return opts.sidebarCollapsed || isWidePagePath(opts.pathname);
}

/** 1400 上限的 Tailwind 类（页面内 fixed 浮条等需要与内容区同宽时共用）。 */
export function contentMaxWidthClass(unbounded: boolean): string {
  return unbounded ? 'max-w-none' : 'max-w-[1400px]';
}

export interface LayoutChrome {
  /** 桌面端侧栏是否收成细条 */
  sidebarCollapsed: boolean;
  /** 内容区是否去掉 1400 上限 */
  contentUnbounded: boolean;
}

/**
 * 外壳状态下发给页面：页面里 position:fixed 的浮条（如工单看板的批量操作条）脱离了内容区，
 * 需要自己跟随侧栏宽度与内容区上限。默认值 = 侧栏展开 + 1400 上限（外壳之外渲染时的安全值）。
 */
export const LayoutChromeContext = createContext<LayoutChrome>({
  sidebarCollapsed: false,
  contentUnbounded: false,
});

export function useLayoutChrome(): LayoutChrome {
  return useContext(LayoutChromeContext);
}
