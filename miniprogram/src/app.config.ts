/**
 * 小程序全局配置 — 页面注册 + TabBar + 窗口。
 * 微信要求所有可路由的页面都在 pages 列表里。
 */
export default defineAppConfig({
  pages: [
    'pages/index/index',        // 首页（航班搜索）
    'pages/flight-detail/index', // 航班详情
    'pages/cart/index',          // 购物车
    'pages/checkout/index',      // 结账
    'pages/orders/index',        // 订单列表
    'pages/order-detail/index',  // 订单详情
    'pages/login/index',         // 登录（wx.login 换 JWT）
    'pages/me/index',            // 我的
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#1e40af',
    navigationBarTitleText: '世途旅行',
    navigationBarTextStyle: 'white',
  },
  tabBar: {
    color: '#64748b',
    selectedColor: '#1e40af',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/index/index', text: '首页' },
      { pagePath: 'pages/orders/index', text: '订单' },
      { pagePath: 'pages/me/index', text: '我的' },
    ],
  },
});
