export default definePageConfig({
  // 静态兜底：JS 跑起来前微信就要渲染标题栏。运行时拉到 `/public/routes` 后
  // 由 index.tsx 用 Taro.setNavigationBarTitle 覆盖成真实航线；拉不到/为空
  // 就保留品牌名，不写死某条目的地（见 lib/routes.ts routeSummaryText）。
  navigationBarTitleText: '椰岛假期',
  enablePullDownRefresh: true,
});
