# 微信小程序 / WeChat Mini Program

> 状态：**规划中（M2.5 迭代）**
> 技术栈：Taro 4 + React + TypeScript（与 sales-web 共享业务逻辑）

## 范围

小程序版本是 sales-web 的**移动端镜像**，覆盖的功能：

| 模块 | 状态 | 说明 |
|---|---|---|
| 首页（航班搜索） | 🟡 规划 | QH9588/9589 港澳→岘港搜索 |
| 酒店列表 | 🟡 规划 | 复用 sales-web mockData |
| 机场接送 | 🟡 规划 | 同上 |
| 越南签证 | 🟡 规划 | 同上 |
| 微信登录（OAuth） | 🟡 规划 | 通过 wx.login + backend `/auth/wechat` |
| 订单 / 我的 | 🟡 规划 | 共用 backend `/orders` API |
| 微信支付 | 🟡 规划 | 调用 `wx.requestPayment` |

**不做**：管理后台功能（在 admin-web :5174）。

## 为什么暂未实现

1. Taro 项目脚手架需要 1-2 小时 npm 安装 + 微信开发者工具配置
2. 小程序需要：开发者账号、AppID、ICP 备案、白名单后端域名
3. 实际业务流程（微信登录、支付）涉及微信平台资质审核
4. 当前阶段先用 sales-web (响应式 web) 验证业务流程，小程序在 M2.5 里实现

## 下一步规划

1. 申请微信小程序 AppID
2. `npx @tarojs/cli@latest init flight-ticket-manager-mp`
3. 配置 vite-style alias 引入 sales-web 的 lib/api.ts、mockData.ts、airports.ts
4. 镜像首页 + 酒店 + 接送 + 签证 4 个 tab
5. 接 wx.login → backend 加 `/auth/wechat` 端点
6. 接 wx.requestPayment → backend 加 `/payments/wechat-pay` 端点

## Demo 期间如何展示

由于今晚 demo 没有真实的小程序代码可演示，使用以下方案：

- **方案 A（推荐）**：在 sales-web :5173 上把 Chrome 切换为**移动端预览**（F12 → Toggle device toolbar → iPhone 14 Pro），演示同一套页面在移动端的响应式效果，告诉听众"小程序版本会在 M2.5 阶段镜像这个体验"
- **方案 B**：直接打开本目录的 README（即此文件）的 GitHub 渲染版本，向听众展示规划清单
