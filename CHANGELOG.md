# 世途旅行 Citur Travel — 产品迭代日志

> 记录所有主要迭代：**改了什么 + 为什么 + 怎么做的**。每一条都是真实 commit。
> 分支：`feat/m2-agent-hierarchy-flights`（已合并到 main 前的主干）

---

## 角色模型（核心概念，不要混淆）

| 角色 | 是谁 | 登录地方 | 账号示例 |
|---|---|---|---|
| **Admin** | 世途旅行自己（我们 + 合作运营方） | 后台 :5174 | `admin@ftm.local` |
| **1 级代理** | 总旅行社（合作的其他旅行社） | 前台 :5173 | `agent1@ftm.local` |
| **2 级代理** | 区代 | 前台 :5173 | `agent2@ftm.local` |
| **3 级代理** | 门店 | 前台 :5173 | `agent3@ftm.local` |
| **客户** | 直接购买的散客 | 前台 :5173 | `customer@ftm.local` |

**关键**：Admin ≠ 1 级代理。我们是平台方，1 级代理是我们的外部合作方（总旅行社）。

**佣金模型（嵌套切分）**：
- Admin 给 1 级代理定一个佣金率（比如机票 10%）
- 1 级从这 10% 里切一部分给 2 级（比如 40%，即 ¥1000 订单 → 1级¥100 → 2级¥40）
- 2 级再从自己拿到的里切一部分给 3 级（比如 30%，即 2级¥40 → 3级¥12）
- **规则**：每层的切分比例 ≤ 自己从上级拿到的总额

---

## M1 · 基础架构（初期）

**做了什么**：
- 后端 Fastify + Prisma + PostgreSQL + Redis 骨架
- 认证系统：Argon2 密码 + JWT access/refresh 双 token 轮换 + RBAC
- 完整 Prisma schema：User / Agent / Flight / FlightSchedule / Order / Payment / PricingConfig…
- Sales-web React + Vite + Tailwind 前端脚手架

**为什么**：要有一个可跑的后端和前端壳，才能在上面加业务。RBAC 和 refresh-token 是保障后续多角色登录的基础，不能省。

---

## M2 · 代理层级 + 自营航班

**Commit**: `feat/m2-agent-hierarchy-flights` (`f5b5ae2`)

**做了什么**：
- Prisma `Agent` 加 `parentAgentId` + `tier` + self-referential `AgentHierarchy` 关系
- 后端 `/agents` 模块：列表（按可见性过滤）、创建下级（AGENT 只能建自己下级，ADMIN 可任意）
- 后端 `/flights` 模块：公共搜索 + admin CRUD + 班次管理
- Seed：3 级代理链 + 8 条示例国内航线

**为什么**：
- **代理层级**是业务核心模型，不是后补的功能。一开始就把 parentAgent 做对，比后面改 schema 容易得多。
- **tier 上限 5**：防无限嵌套；实际业务 3 层够用。
- **自营航班**（非 GDS）：公司业务就是自己包的航班号，不能用别家 API。

---

## ✅ 港澳 → 澳门（品牌定位修正）

**为什么**：用户指出"我们只从澳门出发，不应写港澳"。
- 改所有 "港澳总代" → "澳门总代"
- 首页 Hero "港澳直飞" → "澳门直飞"
- HKG 机场在前台下拉里隐藏（active: false）

---

## ✅ QH9588/9589 实际航班（市场真实性）

**Commit**: `700c888`

**为什么**：原 seed 是虚构国内线（QH9588 PEK→PVG）。用户说"QH9588/9589 你自己查"，经 WebSearch 确认：
- **QH9588** DAD 岘港 → MFM 澳门，11:40-14:25，A321-211，1h 45m（Bamboo Airways 实际时刻表）
- **QH9589** 反向 15:25-16:10

**做了什么**：
- Seed 改为 DAD↔MFM 跨时区（Asia/Ho_Chi_Minh +7 vs Asia/Macau +8）
- 所有 mock 数据整体改岘港主题（12 酒店 / 8 接送 / 10 签证 / 6 套餐）
- 去除中国大陆机场（PEK/PVG/CAN/SZX…）只留 DAD/MFM/HKG/HAN/SGN/CXR/PQC

---

## ✅ M2 完整验证（代理层级 + 自营航班 API）

**Commit**: `4949ba9`

**为什么**：要确保整个 M2 功能链路真的能跑通。

**做了什么**：端到端 12 项 smoke test 全绿：
1. 公共航班搜索
2. Admin 列代理（全部 4 个）
3. 1级代理可见自己+后代
4. 1级创建2级下级
5. 3级创建4级下级（tier 自动递增）
6. 客户被拒（403）
7. Admin 创建航班
8. 创建后立即可搜…

---

## ✅ 双系统拆分（前后台独立 app）

**Commit**: `7199e72`

**为什么**：一开始前台和后台都在同一个 sales-web 里，admin 页面只是 `/admin/*` 子路由。用户要求"两个入口，独立部署"。

**做了什么**：
- 新建 `admin-web/`（Vite + React）独立 workspace，端口 :5174
- 复制脚手架：package.json / vite.config / tsconfig / tailwind
- 共享代码（api.ts, airports.ts, mockData.ts）复制到 admin-web，顶部加 `// SHARED with sales-web/...`
- sales-web 隐藏 admin 导航，保留路由（平滑过渡）
- 后端不变，双端共享同一个 API

**架构决策**：不用 monorepo 的 shared package（那需要重新配 tsconfig paths）。直接复制 + 注释提示同步，短期可接受。

---

## ✅ 两层动态定价引擎（核心技术）

**Commit**: `dcc2713`

**为什么**：用户要求"整个动态定价系统弄好"。航空业标准的定价逻辑是：
1. **日期等级**：节假日/周末涨价，淡季降价
2. **余位阶梯（Fare Bucket）**：越晚买越贵，每卖 10 张涨一档

这两层都得有，而且要是真后端逻辑，不能是前端 mock。

**做了什么**：
- Prisma 加 `DateRanking` 表：每天一行 A/B/C/D 等级，admin 可手动 override
- Seed 填 365 天日期等级：DOW 默认（Sun=A/Fri=B/Sat=B/Mon=C/Thu=C/Tue=D/Wed=D）+ 2026 中国节假日 override
- 新后端 `PricingService.calculatePrice(scheduleId, cabin, qty)`：
  - Layer 1: 查 DateRanking → 日期倍率 A=1.5 / B=1.2 / C=1.0 / D=0.8
  - Layer 2: 余位阶梯 BUCKET_SIZE=10，线性 0.70 → 1.55
  - 跨 bucket 逐座位算价（第 6 张可能进下一档）
- 新端点 `GET /flights/price?scheduleId=X&cabin=ECONOMY&qty=N`
- `flights/search` 每个 seatClass 加 `dynamicPrice / dateRank / totalForQty`
- 前台 HomePage FlightSeatCard 显示动态价（红字）+ basePrice 划线 + 日期 badge

**Codex 三轮 review**：
1. 第 1 轮找出 3 个 CRITICAL：load() 重置选中、find?? 不同步、`(h)=>true` TS6133
2. 第 2 轮：都 PASS
3. 第 3 轮：确认 cross-bucket 数学正确

---

## ✅ 购物车 + OCR 结账 + Bundle 前台

**Commit**: `dadc380`

**为什么**：
- 航班只能单独买不够，要做购物车把机票/酒店/接送/签证打包
- 下单要收集出行人信息（姓名/护照号/电话），可以用 OCR 加速
- 代理要能用预付余额支付

**做了什么**：
- 新 `stores/cart.ts` (zustand + persist localStorage) — 5 种 kind 统一
- Layout 顶栏 🛒 购物车图标（数字徽章）
- 所有产品页加"加入购物车"按钮
- 新 `/cart` `/checkout` 页
- Checkout 收集**多位出行人**（姓名 / 护照号 / 电话 / 出生日期 / 国籍）
- 每位独立"📷 上传护照"按钮（mock OCR，1.5s 延时假装识别）
- 4 种支付：微信 / 支付宝 / 信用卡 / **代理预付余额**（仅 AGENT 角色可见）

**Codex review**：抓到 2 个 CRITICAL
1. cart ID 用 Date.now() 同毫秒会冲突 → 改 `crypto.randomUUID()`
2. Checkout 没兜底 `passengers.length===0` → 加显式校验 + `.trim()`

---

## ✅ 套餐含机票 + 动态定价联动

**Commit**: `f6baf9a` → `f4ad49b`

**为什么**：
- 套餐应该含机票（一价全含），但机票价不能写死
- 选不同日期，套餐总价要跟着变（因为机票是动态价）
- 用户要能调人数和房间数

**做了什么**：
- BundlePage 顶部加**去程 / 回程日期选择器**
- 加载时调 2 次 `searchFlights` 拿实时动态价
- 每个套餐卡加 **+/-** 控件：人数（1-9）+ 房间数（1-5）
- 机票价 × 人数（动态）+ 酒店价 × 晚数 × 房间数 + 其他 = 套餐价
- 签证价 × 人数（自动按人数变）
- 接送价固定（按趟不按人头）
- MockBundle 加字段：`groundDiscount`（地面让利）+ `flightPax`（默认人数）

---

## ✅ 乘客校验 + 购物车航班明细 + 余额支付

**Commit**: `03552a3`

**为什么**：买 3 张票不能结账只填 1 个乘客。代理用预付余额要看到余额。

**做了什么**：
- `effectivePax = max(机票张数, 套餐人数)`
- 不匹配 → checkout 红色警告 + 禁用提交按钮
- 购物车行内显示航班 + 套餐明细（航班号/日期/舱等）
- 代理选"预付余额"支付 → 显示当前¥80K / 本单抵扣 / 余额不足警告

---

## ✅ 产品可配置人数 + 实时客户动态

**Commit**: `dadc380`

**为什么**：用户"客服端能看到客户的 API 数据"。后台要有实时感。

**做了什么**：
- 后台仪表盘加 **"实时客户动态" widget**
- 每 8 秒推 mock 事件（浏览 / 加购 / 结账 / 下单 / 支付）
- LIVE 闪烁指示 + 暂停/继续按钮
- 真接 API 后改 EventSource SSE（接口规范已定）

**限制**：sales-web :5173 和 admin-web :5174 跨端口 localStorage 不共享，暂用 mock 事件模拟。生产环境走 backend SSE。

---

## ✅ 品牌改名 世途旅行 Citur Travel + 单程/往返

**Commit**: `983f9ee`

**为什么**：平台定名、澳门出发要支持回程。

**做了什么**：
- 全仓 `机票管家` → `世途旅行`（首页/后台/登录/footer/title）
- 首页加**单程/往返** toggle（默认往返）
- 往返模式多一个"回程日期"字段
- 搜索：去程 + 回程两次 API call，结果按"✈ 去程 / ✈ 回程"分组
- Admin AgentsPage 加"💰 调整余额"按钮（充值/扣款 + 预览）

---

## ✅ 套餐机票去掉又加回来（业务沟通误会）

**Commit**: `d4f4a81` → `f6baf9a`

**为什么**：用户一开始说"为什么套餐里有机票"，我理解成"不应该有"，去掉了。后来澄清**套餐应该含机票**，但价格要动态。

**教训**：业务问题一次问清楚。这种"X 是不是对的"的问法容易误判方向。

---

## ✅ 后台产品管理（酒店 / 接送 / 签证 / 套餐 4 section）

**Commit**: `fc03cd9`

**为什么**：后台要能 CRUD 产品，不是只改代码。套餐是核心卖点需要向导创建。

**做了什么**：
- 新 `/products` 页，4 个 Tab：酒店 / 机场接送 / 签证 / 套餐
- 每 section 支持增删（mock 会话内生效）
- 套餐 Bundle 创建向导：填名称 + 营销文案 + 一键加产品行 + 让利金额拉条 + 实时算总价
- 业务约束：bundlePrice ≥ 0、items 非空、discount ∈ [0, listPrice]

---

## ✅ 动态定价 PEK 回归修复

**Commit**: `fc03cd9`

**为什么**：动态定价页之前 mock 数据还残留 PEK/PVG 硬编码，没改成 DAD/MFM。

**做了什么**：
- PricingPage 整页重写，从 backend 拉真实 QH9588/9589 班次
- 全仓扫 4 处 PEK 残留全清

---

## ✅ 真图片替换 emoji

**Commit**: `dcc2713`

**为什么**：演示要专业，emoji 图标不够。

**做了什么**：
- MockHotel / MockTransfer 加 `photo` 字段（Unsplash CDN URL）
- 12 酒店 + 8 接送各配真实图片
- HotelsPage / TransfersPage 用 `<img>` 替换 emoji

---

## ✅ 365 天班次 + 月份筛选

**Commit**: `4949ba9`

**为什么**：14 天太少，演示时切不到明年春节/国庆的价格变化。

**做了什么**：
- seed DAYS_OUT 从 14 扩到 365（QH9588/9589 各 365 班次）
- Seed 性能优化：批量预取已存在 departureTime，从 365 次 findFirst 降到 1 次查询
- Admin 航班页加月份筛选（默认"未来 30 天"，可切到任意 YYYY-MM）

---

## ✅ 酒店房型（最近一次）

**Commit**: `96a201e`

**为什么**：用户说"查看详情之后也可以改日期，然后房型"。酒店应该有多个房型选择。

**做了什么**：
- MockHotel 加 `roomTypes[]`：
  - 5 星 4 种：豪华双床 / 海景大床 (×1.15) / 行政套房 (×1.45) / 别墅套房 (×1.85)
  - 4 星 3 种：标准双床 / 豪华大床 / 家庭房
  - 3 星 2 种：标准房 / 商务房
- 酒店详情弹窗重做：大图预览 + 入住/退房日期改 + 房间数 ± + 房型点选卡片
- 合计 = 基础价 × 房型倍率 × 晚数 × 房间数

---

## ✅ 代理页重做 + 订单代理维度（最近一次）

**Commit**: `96a201e` → `efcca85`

**为什么**：用户"代理管理那边需要有很多 filter，也需要 better ways of filtering and displaying"。

**做了什么**：
- 顶栏 5 个 KPI 卡：总代理 / 总余额 / 总订单 / 1-2-3 级分布 / 快捷操作
- 6 维过滤器：搜索 + 层级 + 状态 + 余额档 + 排序（5 项）+ 升/降序
- **表格 / 树形** 视图切换
- 点代理名 → 右侧详情抽屉 4 个 Tab：基本信息 / 佣金规则 / 余额调整 / 散客管理
- 订单页加代理分销统计卡 + 渠道/代理过滤 + 按产品佣金率计算

---

## 🔜 接下来

- **佣金模型重构**（下一步）：从独立费率改为嵌套切分，子级不能超过父级
- **小程序**：Taro 4 骨架（规划中）
- **AWS 上线**：ECS + RDS + ElastiCache（规划中）
- **真 OCR**：AWS Textract 替代 mock（规划中）
- **ML 定价**：Prophet 模型真实接入（规划中）

---

## 关键技术决策

| 决策 | 理由 |
|---|---|
| 前后台拆成两个 Vite app | 独立部署、独立域名、独立更新，比路由子前缀干净 |
| 不搞 monorepo shared package | 增加配置复杂度。复制 + 注释同步更务实 |
| DateRanking 单独建表（非 JSON 配置） | 管理员要能手动 override 单日，JSON 不好按日期主键查 |
| FareBucket 用线性倍率（非阶梯跳变） | 价格更平滑，客户不会感到"11 张比 10 张突然贵 10%" |
| Cart 用 localStorage 持久化 | 客户浏览中途关页面再回来还在，减少流失 |
| Mock OCR 填 demo 数据 | 演示够用，真 OCR 后端对接时再做 |
| 实时客户动态用 mock SSE | 跨端口 localStorage 不通，真上线走后端 SSE |

---

## Codex GPT-5 Review 记录

每次大改都用 codex 过一遍 CRITICAL 级 bug 检查：

| 轮次 | 找到 | 是否修 |
|---|---|---|
| 计划 review | 9 点（30/90/365 矛盾、auth bypass、切位 invariant 等） | 全采纳 |
| 代码 review v1 | 4 CRITICAL（recycle 丢已售、路由 auth、SeatAllocation 无 catch） | 全修 |
| 代码 review v2 | 3 CRITICAL（pricing selectedId 重置、find fallback 不同步、TS6133） | 全修 |
| 代码 review v3 | 3 CRITICAL（cart ID 冲突、checkout 乘客兜底、search 并发读） | 修前两个，第三个接受 |

---

**最后更新**：2026-04-16
**GitHub**：github.com/bobzhendeniubi/flight-ticket-manager
