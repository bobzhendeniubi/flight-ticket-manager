# Flight Ticket Manager · 历次工作清单

> 世途旅行 Citur Travel — 澳门 ↔ 岘港 自营机票 + 多产品（酒店/签证/接送/套餐）+ 多级代理 SaaS。
> 单租户、Postgres + Prisma、React + Vite、Fastify + BullMQ、OpenAI 工具调用。

按 **里程碑** 倒序排（最新在前）。工时只算实际写代码的时间，不含构思 / 调研 / 来回沟通。

---

## 🆕 M9 · AI 助手 + OCR + UX 收尾（约 14 小时）

### 9.1 OCR 真实输入回归 · 4h
- 用户实测中国护照 → 拿到 raw OCR text，发现 3 个 bug
- 修：护照号空格容忍（`EE 141 20 98` → `EE1412098`）、英文名跳 stopword（`FATA TT` → `LIU CHAO`）、姓名锚定跨行
- 国籍从 OCR 文本抽（`CHN` → `CN`），不再硬编码 `MO`
- DOB 加中英混合格式（`19 8月/AUG 1991`）+ 容噪分隔符
- 测试：从 5 个用例扩到 11/11 通过；新增 `npm run test:ocr` 命令
- 文件：`sales-web/src/lib/passportOcr.ts`、`scripts/test-passport-ocr.mjs`

### 9.2 加购后醒目护照面板 · 2h
- 之前：AI 加购 → 800ms 跳 /cart，护照啥时候传不明确
- 现在：加购后聊天底部弹**红边面板** "📷 还需 N 本护照 · 进度条 · 大红上传按钮"
- 上传齐变绿"✓ 去结账"，"稍后填"按钮跳走
- 关键 bug：CheckoutPage `flightTicketCount` 用 SUM → 2 人往返要 4 本护照；改 MAX
- 文件：`sales-web/src/components/AiAssistant.tsx`、`pages/CheckoutPage.tsx`

### 9.3 强制往返默认 · 1h
- SYSTEM_PROMPT 加硬规则：95% 客户来回，没说"单程"两个字必须按往返做
- 用户只给 1 个日期 → AI **反问**回程，不假设
- 实测："明天去岘港" → AI 追问回程哪天回 + 几位 + 要不要酒店签证
- 文件：`backend/src/lib/ai-assistant.ts`

### 9.4 dateRank A/B/C/D 全 UI 隐藏 · 1.5h
- 内部日期等级（A 黄金 ×1.5 / D 优惠 ×0.8）3 处泄露给客户：
  - HomePage 航班卡彩色徽章 → 改成 dynamicPrice<basePrice×0.95 时显示"限时优惠"
  - CartPage 机票行 `日期等级 D · 2 人` → 删
  - BundlesPage 顶部 + 套餐卡 RankBadge → 删，函数本身删除
- 客户 UI 完全没有 A/B/C/D 字样
- 文件：`HomePage.tsx`、`CartPage.tsx`、`BundlesPage.tsx`

### 9.5 OK 按钮 = 直接下单 · 1h
- 之前："👌 OK · 看详情" → 发文本给 AI 要详情
- 现在：当最近一条 AI 消息有 proposals → 按钮变绿色填充"✅ 确认下单"，直接调 handleConfirmProposal（与卡片紫色按钮等效）
- 文件：`AiAssistant.tsx`

### 9.6 多产品 AI 助手（机票/酒店/接送/签证/套餐）· 4.5h
- 后端加 4 个 search 工具 + propose_order 重构为 items[] 数组
- 前端 ProposalCard 写成可折叠多产品 UI（5 类不同 emoji + 详情）
- handleConfirmProposal 把所有 items 加进购物车
- SYSTEM_PROMPT 重写支持自由组合（机票+酒店+接送 / 套餐一价全包）
- 实测 5 类产品 E2E 全跑通
- 文件：`backend/src/lib/ai-assistant.ts`、`sales-web/src/components/AiAssistant.tsx`、`api.ts`

---

## M8 · AI 助手第一版（约 8 小时）

### 8.1 OpenAI 切换 + 多产品 propose_order · 3h
- Anthropic Claude Sonnet → OpenAI gpt-5.4-mini
- 工具调用循环 max 8 iter，finish_reason='tool_calls' 检测
- ai-assistant.ts 全部 OpenAI Chat Completions + 新工具 schema

### 8.2 浏览器端 OCR + Markdown 渲染 · 3h
- tesseract.js v7 + chi_sim+eng 双语
- ICAO 9303 MRZ 解析（TD3 两行 44 字符）
- react-markdown 渲染 AI 回复（之前 `**bold**` 显示字面量）
- 浏览器端 OCR 准确率 60-75%；失败时引导手填

### 8.3 OCR → CheckoutPage 自动填表 · 1h
- Zustand + sessionStorage 暂存识别结果
- CheckoutPage hydrate 后自动填姓名/护照号/出生日期

### 8.4 AI 助手浮窗 UI · 1h
- 右下角浮动按钮 + 380×600 聊天窗
- 双重确认：AI 永远只能 propose_order（dry-run），客户必须点"确认下单"才真下单

---

## M7 · 取消订单 + 退款引擎（约 4 小时）

- 取消策略 CRUD（退款费率可后台改）
- 时间窗口规则：起飞前 24h / 48h / 72h 不同费率
- 后端：`/orders/:id/refund-quote` + `/orders/:id/cancel`
- Codex 4 review 修了 4 处问题
- 文件：`cancellation-policies/*`、`orders.service.ts`

---

## M6 · 微信小程序客户端 MVP（约 6 小时）

- Taro 4 + React + TS（复用 sales-web 类型）
- 首页/购物车/我的订单 3 屏 + 微信登录
- 6 个 Codex review 反馈（P1 fail-closed + P2/P3）
- 3 个 Codex verify-fix 回归（idempotency / refresh / timeout）
- 文件：`miniprogram-client/`

---

## M5 · 后台批量切位 + 移动端预览（约 3 小时）

- Admin 批量切位：bulk seat allocation 表单（多班次同时切）
- 移动端：sales-web mobile-adapted preview（viewport meta + 响应式）
- Codex 5.5 review 配套修复

---

## M4 · 真生产级 P3（约 8 小时）

- 微信支付 + 支付宝 SDK 真接入（env 驱动 PAYMENT_MODE=sandbox/live）
- BullMQ worker 跑邮件 + PDF 异步任务
- 生产部署 docker-compose + nginx 反代
- 全部 API URL 抽成 env（防 Host header 伪造）
- Codex P1（9 处阻断级）+ P2（13 处性能/安全/质量）修复
- 文件：`backend/src/modules/payments/*`、`workers/*`

---

## M3 · 治理层（约 5 小时）

- 审计日志（每个写操作 + actor + before/after）
- 客户/旅客管理 CRUD + 全局 edit
- 履约任务（订单状态机 + 票务出票流）
- Codex 5 类缺失骨架补齐

---

## M2 · 销售闭环（约 7 小时）

- 订单系统（散单 + 套餐 + 多人 + 多产品）
- 结算模块（佣金链路 + 月结 + 预付抵扣 + 嵌套切分）
- 产品 CRUD（Hotels / Transfers / Visas / Bundles）
- 真动态定价引擎：DateRanking（A/B/C/D 365 天）× FareBucket（180 座 18 档）
- Dashboard KPI 真聚合
- 真图片替换 emoji（Unsplash + 本地）
- 乘客=票数验证 1:1
- 套餐含机票动态定价
- 港澳→澳门、PEK→DAD 回归

---

## M1 · 业务定位 + 多级代理（约 6 小时）

- 自营航班 QH9588/QH9589 澳门↔岘港真实时刻表
- 365 天班次扩展 + 后台月份筛选
- 拆分前/后台（admin-web + sales-web）
- 切位 / 座位统计
- 中文化 + 多级代理层级（agent2b/agent3b/agent3c demo）
- 单程/往返 + 代理余额调整
- 移除中国大陆机场（业务定位）

---

## M0 · 基础架构（约 8 小时）

- 单租户 Prisma schema（移除多租户/License）
- Fastify + RBAC（CUSTOMER/AGENT/STAFF/ADMIN）
- React + Vite + Tailwind 双前端
- Auth（JWT + refresh token + bcrypt）
- 文档：PRD、架构、ROADMAP、CHANGELOG

---

## 📊 总工时（写代码部分）

| 阶段 | 工时 | 累计 |
|------|------|------|
| M0 基础架构 | 8h | 8h |
| M1 业务定位 + 代理 | 6h | 14h |
| M2 销售闭环 | 7h | 21h |
| M3 治理层 | 5h | 26h |
| M4 生产级 P3 | 8h | 34h |
| M5 切位 + 移动 | 3h | 37h |
| M6 微信小程序 | 6h | 43h |
| M7 取消引擎 | 4h | 47h |
| M8 AI 助手 v1 | 8h | 55h |
| M9 AI/OCR/UX 收尾 | 14h | **69h** |

---

## 📦 当前代码量

```
backend/src/    ~12,000 行 TS
sales-web/src/  ~ 8,500 行 TSX
admin-web/src/  ~ 9,200 行 TSX
miniprogram-client/  ~3,500 行 TSX
docs/           ~5,000 行 MD
```

总计 ~38,000 行（不含 node_modules / 生成文件）。

---

## 🎯 下一步（按 ROI 排序）

| # | 内容 | 工时 | 优先级 |
|---|------|------|--------|
| **1+4** | **客户"我的订单"页 + 自助取消（含退款报价）** | **3h** | **P0 进行中** |
| 2 | 后端测试（payments / pricing / cancellation） | 3-4h | P0 |
| 3 | AWS Textract / 阿里云证件 OCR（生产级） | 2h + 配 IAM | P0 |
| 5 | 移动端 QA（手机验过） | 2h | P1 |
| 6 | AI 对话历史持久化 | 2h | P1 |
| 7 | i18n（英文/越南文） | ~6h | P2 |
| 8 | 2FA / 密码重置 | 3h | P2 |
| 9 | Admin Dashboard 数据可视化 polish | 3h | P2 |
