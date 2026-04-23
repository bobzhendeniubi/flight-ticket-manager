# 微信小程序 · 客户端 (Taro 4 + React + TS)

> 状态：**MVP 实装完成**（2026-04-22）
> 技术栈：Taro 4.0.9 + React 18 + TypeScript + zustand + SCSS
> 和 sales-web 共享：类型 (`src/lib/types.ts`)、airport 工具、API 契约

## 快速开始

```bash
cd miniprogram
npm install           # 安装 Taro / 依赖
npm run dev:weapp     # 编译到 dist/（watch 模式）

# 另开窗口：
# 1. 安装微信开发者工具 https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
# 2. 打开工具 → "导入项目" → 路径选 miniprogram/ → AppID 随便填或用 touristappid
# 3. 左侧"详情" → 本地设置 → 勾选「不校验合法域名」（dev 时调 localhost:4000 必须）
# 4. 编辑器会自动热更新（前提：backend 已启动在 :4000）
```

## 页面清单

| 页面 | 路径 | 功能 |
|------|------|------|
| 🏠 首页 | `pages/index/index` | 航班搜索 · 动态价 · 日期等级 A/B/C/D 徽章 · 一键加购 |
| ✈️ 航班详情 | `pages/flight-detail/index` | 占位（未来扩展座位图） |
| 🛒 购物车 | `pages/cart/index` | 产品列表 + 删除 + 合计 |
| 📝 结账 | `pages/checkout/index` | 联系信息 + 乘客信息 + 人数=票数校验 + 创建订单 |
| 💳 订单详情 | `pages/order-detail/index` | 状态横幅 + 倒计时 + 调 `wx.requestPayment` 支付 |
| 📋 订单列表 | `pages/orders/index` | 我的订单 + 状态过滤 |
| 🔑 登录 | `pages/login/index` | 微信登录（`wx.login` → JWT）+ 开发者邮箱登录 |
| 👤 我的 | `pages/me/index` | 资料 + 客服 + 退出 |

TabBar：首页 / 订单 / 我的（其他页 Taro.navigateTo 跳转）

## 后端配对端点

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/auth/wechat` | code → openid → User → JWT（dev 模式 code 以 `dev:` 开头走 mock） |
| POST | `/auth/login` | 邮箱密码登录（开发者模式备用） |
| GET  | `/flights/search` | 航班搜索（含 dynamicPrice） |
| POST | `/orders` | 创建订单（idempotencyKey 防双击） |
| GET  | `/orders?mine=1` | 我的订单 |
| POST | `/payments/wechat/miniapp-prepay` | JSAPI prepay — 生成 wx.requestPayment 参数（sandbox 返 mock 参数） |

## 开发模式说明

**无真微信环境**也能完整跑通业务逻辑：

1. **wx.login 返回 code** → 后端 `/auth/wechat` 接到后，若 `WECHAT_MP_APPID`/`_APPSECRET` 未配置，直接把 `code` 当 synthetic openid（`dev_<code>`），创建 User 返 JWT
2. **wx.requestPayment** → 后端 prepay 端点在 `PAYMENT_MODE != 'live'` 时返回 mock 参数，`wx.requestPayment` 会 fail（这是预期，DevTools 没有真微信支付环境）
3. **订单到 PAID 推进** → 用 admin-web 直接改状态，或调 sandbox webhook：
   ```bash
   curl -X POST http://localhost:4000/payments/webhook/sandbox \
     -H "content-type: application/json" \
     -d '{"paymentId":"<id>","status":"SUCCEEDED","secret":"<SANDBOX_WEBHOOK_SECRET>"}'
   ```

## 生产部署 checklist

- [ ] 申请微信小程序 AppID（mp.weixin.qq.com）
- [ ] 更新 `project.config.json` 里的 `appid`
- [ ] 在后台 `开发设置 → 服务器域名` 把 `https://api.citur.com` 加白名单
- [ ] 设 `WECHAT_MP_APPID` + `WECHAT_MP_APPSECRET` env（注意不是公众号的那对）
- [ ] 绑定商户号到小程序（用于 JSAPI 支付）
- [ ] 小程序审核发布（需 ICP 备案）
- [ ] `npm run build:weapp` → 在开发者工具里上传代码 → 提交审核

## 和 sales-web 的异同

| 维度 | sales-web | miniprogram |
|------|-----------|-------------|
| 路由 | react-router-dom | Taro.navigateTo |
| 请求 | fetch | Taro.request |
| 存储 | localStorage | Taro.setStorageSync |
| 样式单位 | rem/px | rpx (750rpx=屏宽) |
| 组件 | 原生 HTML | `@tarojs/components`（View/Text/Input） |
| 支付 | 浏览器跳转 | wx.requestPayment |
| OCR | tesseract.js (浏览器) | 未实现（太重；未来走后端） |

## 未来待做

- 酒店 / 接送 / 签证 / 套餐 4 个类目页（已做机票 + 结账闭环）
- 订阅消息（支付成功通知）
- 真 OCR（护照扫描走后端）
- 地图选机场
- 深色模式
