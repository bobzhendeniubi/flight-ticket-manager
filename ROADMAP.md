# 世途旅行 Citur Travel — 产品路线图 & 架构债

> **现阶段产品定位**（2026-04-20 决策）：
> **先做一家**：世途旅行自己先用起来，把履约 + 财务 + 运营跑通。
> **多租户 / SaaS 化 已 defer**：等第 1 家真跑顺了再说。
>
> **Codex GPT-5 2026-04-16 审查** 留档参考 —— 5 类生产级缺失里，"多租户内核" 明确降级，其他 4 项（履约 / 财务 / 运营治理 / 集成基建）按 M6 推进。

---

## 🎯 现阶段定位（诚实面对）

| 维度 | 现状 | 当前目标 |
|---|---|---|
| 演示给潜在客户 | ✅ 完整 | 卖第 1–3 家旅行社 |
| **真实承接 1 家客户业务（世途自用）** | 🟡 需补履约 + 财务 | **M6 上线前完成 ← 当前焦点** |
| 支撑 10+ 家并发使用 | ⏸️ 已 defer | 第 1 家跑顺后再评估 |
| 支撑 50+ 家 | ⏸️ 已 defer | 需要时再重构 |

---

## 🔴 生产级缺失（优先级从高到低）

### ⏸️ 0. 多租户 / SaaS 内核 — 已 defer（2026-04-20 决策）
**决策**：先把世途旅行自家跑顺再说，单租户单实例即可。/tenants 页和 MOCK_TENANTS 已移除。
**重新激活条件**：第 1 家客户稳定运营 ≥ 3 个月，且有第 2 家明确付费意向时，再评估是否做多租户改造。
**如重启需要做**：`Tenant` + `AgencyLicense` 表、所有 Prisma 查询加 tenantId filter、每家独立品牌/域名/配置。

---

### 1. 供应链履约（Fulfillment）
**现状**：订单流转只有状态 TICKETED/PAID，没有真实对接。

**缺什么**：
- **机票**：`PNR`、出票编号、改签/退票流程、航司对账
- **酒店**：confirmation number、PMS 对接、No-show 处理
- **签证**：进度跟踪（送签 → 审核 → 下签 → 取件）、材料上传文件管理
- **接送**：司机排班、车辆调度、实时位置
- **供应商对账**：每个供应商单独应付台账

**判断标准**：客户在后台点"出票"，真的要生成 PNR 发给客户。

---

### 3. 财务结算内核
**现状**：只有预付余额 + mock 佣金计算。

**缺什么**：
- **钱包账本**（double-entry bookkeeping）：每一笔动账都有借贷两端
- **预存款状态**：可用 / 冻结（hold 未出票订单）/ 已扣 / 退回
- **佣金台账**：分多级代理分润链 + 待结算 / 已结算 / 冲销
- **应收应付**：散客未付、代理账期（月结 30 天）、供应商应付
- **结算单**：月度对账单（PDF）、发票开具
- **退款工作流**：审批 → 原路退 / 入预付

**判断标准**：月底能一键生成每家代理的对账单 + 供应商付款单。

---

### 4. 运营治理（Governance）
**现状**：改定价 / 调余额 / 改代理直接生效无审计。

**缺什么**：
- **审批流**：大额调余额需上级审批、定价规则变更留痕
- **操作审计**：谁什么时候改了什么（类似 `AuditLog`）
- **配置发布**：定价 / 佣金规则有"草稿 → 预发布 → 生效 → 可回滚"
- **权限模板**：不止 ADMIN/STAFF，要能定义"出纳"、"客服"、"产品运营"等角色
- **数据权限**：某运营只能看自己负责的代理

**判断标准**：客户的财务出事了能查到"谁什么时候改了什么"。

---

### 5. 集成基础设施
**现状**：所有操作同步执行，没异步。

**缺什么**：
- **异步任务**：出票 / OCR / 发邮件 / 生成报表走队列（BullMQ 或 SQS）
- **幂等**：支付回调、创建订单要有 idempotency-key
- **Webhook**：对外提供回调（订单状态变化通知第三方）
- **对外 API**：给旅行社 ERP 对接
- **报表仓库**：OLAP（或至少 read replica），不要在主库跑大查询

---

## 🟡 6 处当前结构问题（需要重构）

| 问题 | 位置 | 后果 | 修法 |
|---|---|---|---|
| User.role + Agent 绑死 | `schema.prisma` User/Agent | 平台 staff / 代理员工 / 门店员工混乱 | 拆 Staff 实体，User 只管登录，业务身份另立 |
| Agent.tier 硬编码 5 级 | `schema.prisma:99` | 区域/门店/员工被压成一个 Agent | 引入 Organization 树，tier 改 parentOrgId |
| OrderItem 超级表 | `schema.prisma:423` | 靠可空外键 + metadata 承载所有产品，长期膨胀 | 拆 FlightOrderItem / HotelOrderItem / VisaOrderItem |
| PricingConfig 悬空 + DateRanking 两套配置 | `schema.prisma:554, :641` + `pricing.service.ts` | 抽象分裂，配置源不统一 | 合并为 `PricingRule`（版本化 + 作用域） |
| AgentsPage 单页塞太多 | `admin-web/src/pages/AgentsPage.tsx` (820+ 行) | 佣金 / 余额 / 散客全 mock 塞 UI 里 | 拆成 agent / commission / balance / customer 4 个模块 |
| Passenger ≠ SavedPassenger | `schema.prisma:77, :451` | 姓名+DOB 查重会越来越脏 | 建 `TravelerProfile` 主档，Order 的 Passenger 引用它 |

---

## 🔥 下一步最该做的 3 件事（按 Codex 建议）

### Step 1 — ⏸️ 多租户 / 组织 / 权限 重构（已 defer）
当前单租户模式，Staff/Admin 直接用 RBAC 够用。等有第 2 家客户再做：
```
Tenant (licensee)
 └ Agency (分销方：代理商 / 门店 / 或平台自营)
    └ Region / Store
       └ Staff / User（带 role 和 scope）
```

### Step 2 — 财务结算内核
- Wallet（账户）+ LedgerEntry（双式记账）
- PrepaymentHold（冻结）/ Release / Charge
- CommissionChain（一笔订单切多级代理，每级一条 record）
- 月度结算单生成器

### Step 3 — 库存履约内核
- FlightBooking / HotelBooking / VisaApplication / TransferJob 各自状态机
- FulfillmentTask 异步队列（出票 / 对账 / 通知）
- 供应商 API 抽象层（将来对接多家）

---

## 📋 完整功能矩阵（按客户签约时的问卷顺序）

以下每一项是旅行社签约时会问"你们有没有"：

### 基础登录 & 权限
- [x] 邮箱 + 密码登录
- [x] JWT 双 token 轮换
- [x] RBAC (CUSTOMER/AGENT/STAFF/ADMIN)
- [ ] 微信小程序登录 (wx.login)
- [ ] 二次验证 (SMS/TOTP)
- [ ] 权限模板 + 作用域 ⭐
- [ ] SSO (企业客户要)

### 产品管理
- [x] 航班 CRUD + 365 天批量 + 班次管理
- [x] 酒店 / 接送 / 签证 列表
- [ ] **产品编辑**（进行中）
- [ ] 酒店 PMS 对接
- [ ] 签证材料上传 / 进度
- [ ] 供应商管理

### 定价
- [x] 两层动态定价（日期等级 × 余位阶梯）
- [x] Admin 手动覆盖日期等级
- [ ] 定价规则版本化 ⭐
- [ ] 手动单班次定价锁定
- [ ] ML 需求预测（Prophet 真实接入）
- [ ] A/B/C/D 之外的更多等级（周期定制）

### 销售 & 预订
- [x] 航班搜索（单程/往返）
- [x] 购物车（5 种 kind）
- [x] 结账 + 多乘客 + 护照 OCR mock
- [x] 套餐（可配置人数/房间数）
- [x] 多种支付（微信/支付宝/信用卡/预付余额）
- [ ] 真微信/支付宝支付
- [ ] 真 OCR（AWS Textract）
- [ ] 下单幂等 ⭐
- [ ] 座位持有（15 分钟未支付释放）

### 履约（Fulfillment）⭐ 核心缺口
- [ ] **机票出票（PNR 生成）**
- [ ] **改签 / 退票流程**
- [ ] **酒店 confirmation 对接 PMS**
- [ ] **签证进度 + 材料上传**
- [ ] **接送司机调度**
- [ ] 短信 / 微信模板消息通知
- [ ] 电子行程单 PDF

### 代理网络
- [x] 多级代理（1/2/3 级）
- [x] 代理创建下级
- [x] 预付余额
- [x] 佣金规则（每个下级独立 rate）
- [x] 数据隔离（AGENT 看不到平级）
- [x] 散客 / 旅客 管理
- [x] 代理余额调整
- [ ] 代理申请流程 + 审核
- [ ] 代理 KPI 考核
- [ ] 佣金结算单 ⭐
- [ ] 代理提款审核

### 财务 ⭐ 核心缺口
- [x] 预付余额
- [ ] **钱包双式记账**
- [ ] **佣金分润链多级记录**
- [ ] **月度对账单**
- [ ] **发票开具**
- [ ] **退款审批工作流**
- [ ] 账期（T+N 结算）
- [ ] 异常交易预警

### 运营治理
- [x] 后台多页面
- [x] CSV 导出（订单/散客/旅客）
- [ ] **Excel 导出**（真 xlsx 而非 CSV）
- [ ] **操作审计日志** ⭐
- [ ] **配置版本化 + 回滚**
- [ ] **审批流**（调余额 / 改定价）
- [ ] 多端同时操作冲突处理

### 数据 & 报表
- [x] 实时仪表盘（mock）
- [x] 座位统计
- [x] 代理分销统计
- [ ] **自定义报表**（可拉维度/指标）
- [ ] **BI 看板**（对比 / 环比 / 漏斗）
- [ ] 数据导出 API
- [ ] 报表仓库（OLAP read replica）

### 集成 & 基础设施
- [ ] **异步任务队列**（BullMQ/SQS）⭐
- [ ] **幂等键**
- [ ] **Webhook 对外回调**
- [ ] **公开 API**（给旅行社 ERP 对接）
- [ ] **速率限制**（每家租户独立）
- [ ] 审计 / 监控 (Sentry + DataDog)
- [ ] 多环境（dev/staging/prod）
- [ ] CI/CD 自动化

### 部署
- [ ] **AWS ECS + RDS + ElastiCache**
- [ ] CloudFront CDN
- [ ] S3 文件存储（护照照片 / 签证材料）
- [ ] Route 53 多域名
- [ ] 自动备份 + DR
- [ ] 容器镜像仓库

### 合规
- [ ] PDPA / GDPR（港澳 / 欧盟客户）
- [ ] 数据脱敏 + 访问审计
- [ ] 支付 PCI DSS
- [ ] 发票合规（中国增值税 / 港澳）

### 小程序
- [ ] **微信小程序（Taro）**
- [ ] 小程序扫码支付
- [ ] 订阅消息通知

---

## 📊 完成度粗略评分

| 模块 | 完成度 | 备注 |
|---|---|---|
| 认证 & RBAC | 80% | 差 SSO + 权限模板 |
| 代理网络 | 70% | 有功能，缺佣金结算台账 |
| 销售流程 | 70% | 有流程，缺真实支付 + 库存锁定 |
| 动态定价 | 60% | 引擎真，但 PricingConfig 悬空 |
| 产品管理 | 50% | 有 CRUD mock，缺真编辑（本次迭代做） |
| 客户 / 旅客管理 | 60% | 有基础，缺 edit（本次迭代做） |
| **履约** | **5%** | 🔴 基本没做 |
| **财务** | **10%** | 🔴 只有预付余额 |
| **运营治理** | **10%** | 🔴 缺审计 / 审批 |
| 基础设施 | 15% | 缺异步 / 幂等 / Webhook |
| 部署 | 10% | 只有本地 Docker Compose |

**总体约 35%**。

---

## 🗓️ 建议里程碑

| Milestone | 时间 | 目标 |
|---|---|---|
| **M5.5** | 1 周 | 补齐 edit 功能 + 小程序骨架（演示够用） |
| **M6** | 1–2 个月 | 财务结算 + 履约内核 → **世途自用上线（单租户）** |
| **M7** | 2–3 个月 | 集成 + 部署 + 合规 → AWS 上线 |
| **M8** | 3 个月 | 真微信支付 + OCR + Prophet ML |
| **V2** | ⏸️ 已 defer | 多租户 / SaaS 化 → 等第 1 家跑顺 + 有第 2 家意向时重启 |
| **V3** | ⏸️ 已 defer | 50+ 租户 + 多币种 + 国际市场 |

---

---

## 📝 2026-04-20 更新 · Codex 反馈采纳进度

针对 Codex CTO review 的 5 类生产级缺失，我们在**前端 UI 层面**先把骨架搭起来（真后端按 M6-M7 里程碑做）。当前进度：

### ✅ 已做（UI scaffolding + 部分真功能）

| 缺失项 | 状态 | 说明 |
|---|---|---|
| 多租户 / License | ⏸️ 已移除 | 2026-04-20 产品决策 "先做一家"，`/tenants` 页已删、MOCK_TENANTS 已清，等有第 2 家客户再重做 |
| **订单系统** | ✅ **真后端** | `orders` 模块 4 端点：`POST/GET/GET/:id/PATCH/:id/status` · 动态定价重算 · 座位事务扣/退 · 状态机 + RBAC + 幂等 key + 乘客数校验 · sales CheckoutPage 接通 · admin OrdersPage 接通 |
| **结算模块** | ✅ **真后端** | `settlements` 模块 4 端点 · CommissionRecord 自动生成（PAID 时按代理层级走链路，child.rate≤parent.rate 的 spread 模型）· 月度结算单：GMV/earned/paidToChildren/offset/payable · 状态机 DRAFT→审核→核准→PAID · PAID 时触发 SETTLED + 预付余额 OFFSET 扣减 · admin SettlementsPage 接通 |
| **产品 CRUD** | ✅ **真后端** | `products` 模块 4 子资源（hotels/transfers/visas/bundles）· 公共 GET 无需登录 + 管理员写 · 软删除（isActive=false）· Hotel 嵌套 roomTypes 替换式更新 · BUNDLE 订单闭环（OrderItemKind.BUNDLE + bundleId FK）· admin ProductsPage + sales HotelsPage/VisasPage/TransfersPage/BundlesPage 全接通 |
| **Dashboard KPI** | ✅ **真后端** | `dashboard` 模块 3 端点 · 今日/本月营收 + 变化率（vs 昨日/上月）· 待支付/活跃代理统计 · 近 7 天时间序列 · Top 5 代理 by GMV · admin DashboardPage 接通真数据 |
| 运营治理 - 审计 | 🟡 UI 骨架 | `/audit-logs` 页 · 12 条 mock 日志 · 谁/何时/哪 IP/改了什么 · 严重度分级 · CSV 导出（后端未接） |
| 履约 (订单 drawer) | 🟡 UI 骨架 | OrdersPage 订单详情 🚚 履约进度：PNR / 酒店确认号 / 签证进度 / 司机调度 · 5 种状态（后端未接） |
| **OCR 真实实现** | ✅ 真功能 | tesseract.js `chi_sim+eng` + MRZ 解析 · 进度条 · 图片预览 · 识别原文可展开 · 中国护照号 `[EGSDPH]\d{8}` 正则兜底 |

### 🔴 还欠 —— 后端架构债（按 M6 里程碑 · 单租户版本）

1. ~~**订单系统**~~ ✅ **已完成**（2026-04-20）
2. ~~**结算模块**~~ ✅ **已完成**（2026-04-20）—— CommissionRecord 自动生成 + 月度 Settlement + 预付抵扣
3. ~~**产品 CRUD**~~ ✅ **已完成**（2026-04-21）—— Hotels/Transfers/Visas/Bundles + BUNDLE 订单闭环
4. ~~**Dashboard KPI**~~ ✅ **已完成**（2026-04-21）—— 真 SQL 聚合 + Top 代理 + 7 天时间序列
5. **审计日志**：操作日志写入中间件 + 查询 API
6. **履约任务**：FulfillmentTask 表 + 状态机 + 异步队列（BullMQ）
7. **支付网关**：微信/支付宝对接（目前 PAID 是管理员手动标记）
8. **Prisma 重构**：统一 PricingRule（目前 DateRanking + 默认 bucket 两处配置）
9. ~~多租户数据隔离~~ —— 已 defer

---

**最后更新**：2026-04-21（产品 CRUD + Dashboard 真数据上线；BUNDLE 订单打通）
**下一次架构 review**：审计 + 履约 + 支付网关齐活后
