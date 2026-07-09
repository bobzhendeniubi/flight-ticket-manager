---
name: feedback-batch
description: 反馈批处理流水线——用户丢来运营反馈文档（docx/xls，通常微信拖拽路径）时全流程处理：解析统计→真伪甄别→分波 spawn agent 修复→构建闸→提交→实测→（批准后）部署 staging→微信总结。触发词：反馈批、0708/0709 这类日期批次、运营/票务反馈、后台反馈文档。
---

# 反馈批处理流水线

用户丢来一批运营反馈（.docx 反馈文 + .xls/.xlsx 模版或样例表）时，按以下流程走。整条线在 2026-07-08 会话中实战定型（29 条反馈 → 26 项修复 9 commit 全上 staging），别偷工减料也别过度发挥。

## 0. 硬性铁律（每一步都适用）
- **产品代码/UI/注释/测试名里绝不出现内部同事人名**（对照表见仓库 CLAUDE.md；一律换成 财务/业务/签证岗/房控/操作部 等角色词）。
- **服务端权威定价是底线**：任何"手填价"诉求 → 做成调价/加项通道（记原价+差额+原因+审计），绝不裸放开。
- **座位账对称**：任何触碰占座/释放的改动，检查 SEAT_HOLDING_STATUSES / SEAT_RELEASING_STATUSES 对称性。
- **前端真值闸 = `npm run build`**；裸 `tsc --noEmit` 是假绿（根 tsconfig files:[]），agent 中途验证用 `npx tsc -p tsconfig.app.json --noEmit`。
- **部署需用户当次明确说「部署」**，一次批准只覆盖一批。

## 1. 解析输入
文件通常在微信拖拽目录（路径含 `xwechat_files/.../temp/drag/`）。先全部拷进 scratchpad 再处理。
- **docx 正文**：`unzip -o -q x.docx -d x_x word/document.xml`，按 `</w:p>` 切段、抽 `<w:t>` 文本，标注哪些段带图（`<w:drawing>`）。没有 comments.xml——反馈就是正文。
- **xls（旧格式）**：scratchpad 建 venv 装 `xlrd==1.2.0 openpyxl`（系统 pip 有 PEP668 锁），xlrd 读 .xls、openpyxl 读 .xlsx。逐 sheet dump 表头+前几行。
- 旧系统模版类文件要**逐列逐格式**记录（列名/列序/日期格式如 04Feb84、DD-MM-YYYY）。

## 2. 统计归类（先交付分析，不动代码）
把所有条目合并去重编号，**逐条对照现状代码核实**（grep 关键实现，别凭印象），分四类输出给用户：
1. ✅ **真问题**：确实缺/坏/慢（注明代码证据：文件+现状）
2. 🔍 **大概率不是问题**：功能已有/近期刚改（先复现再动手，注明证据行号）
3. ⚠️ **真需求但按原话做会出事**：给"正解方案"（如硬删→软删、手填价→调价通道、全拆拦截→仅后台确认强过）
4. 💬 **新需求/要拍板的口径**：整理成**微信文案**（SendUserFile 发 .md，问题编号化让对方能按 1①②③ 直接回复；口径类单独一条、已完成明细另一条）

**运营旁路检查**（0708 教训）：财务有审计 ≠ 运营看得见。任何绕过结构化操作的通道（调价、强录、删除）都要问：库存/房控/签证履约岗位还能看到真实状态吗？

## 3. 用户说「做」之后：分波 spawn agent
每条一个 agent（用户惯例），**按文件簇分波，波内文件不相交、波间串行**：
- **热点文件必须串行**：`admin-web/src/pages/OrdersPage.tsx`（超大：列表/筛选/导出/批量条/BatchCreateModal/详情抽屉/乘客区是不同小节，同波两个 agent 只能各占一个小节且在 prompt 里明说）、`backend/src/modules/orders/orders.service.ts`（按函数区域划分并点名"别碰 XX 小节"）、`SingleOrderModal.tsx`、`VisaDeskPage.tsx`、`orders.export-*.ts`。
- 模型：机械活/UI 接线/补测试用 **sonnet**，模型改动/根因排查/大功能用 **opus**。
- 每个 agent prompt 必含：仓库路径+分支；任务原话+已核实的现状证据；实现要点；**硬性约束**（不 commit/push/部署/不跑 npm run build；人名铁律；点名禁碰文件/小节；后端 `npx vitest run <文件>` 跑绿；前端 tsc -p tsconfig.app.json）；要求最终回复给"改动文件:行、口径、测试结果、遗留风险"。
- agent 报告里的"遗留风险/衔接缺口"要读——常有真问题（如换人没清生日）：小的自己顺手修，大的报给用户拍板。

## 4. 每波收口：构建闸 → 提交
波内 agent 全部完成、**确认无 agent 在写文件**后：
```
cd backend && npx prisma migrate deploy   # 若本波有新迁移，先应用到本地库
cd backend && npm run build && npm test
cd admin-web && npm run build
cd sales-web && npm run build             # 本波动过 sales-web 才跑
```
全绿 → `git add -A backend admin-web/src sales-web/src && git commit`（中文 conventional message，逐项列改动与根因；不写 Co-Authored-By——归属已全局禁用）。红了 → 定位是哪个 agent 的改动，自己修或回炉。

## 5. 实测（goal 通常要求"实际使用没 bug"）
本地全栈：backend `npm run dev`（本地 Postgres 容器 ftm-postgres-test；先 migrate deploy）+ `preview_start admin-web`（launch.json 已配，端口 5174，vite 代理 /api→4000）。
- **登录坑**：预览合成事件进不了 React 登录表单。绕过：`fetch('/api/auth/login', {…开发测试号见登录页脚注…})` 拿 tokens → `localStorage.setItem('ftm-admin-auth', JSON.stringify({state:{user,tokens},version:0}))` → 跳转。
- 逐项走查本批改动的页面/流程（snapshot/eval 断言优先，截图收尾）；导出类直接带 token curl 端点验 200+内容类型；模版类下载后用 venv 解析逐列比对。
- 全程盯 preview_console_logs error 为零。测完关 dev server 和 preview。

## 6. 部署（仅当用户说「部署」）
```
ssh -i ~/.ssh/ftm_staging root@47.83.249.163 \
  'cd /opt/ftm && git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build backend worker sales-web admin-web'
```
（本批没动的前端服务可省；backend 动了则 worker 一并重建——同代码）。ssh 输出过滤 post-quantum 警告噪音。部署后验证三件：
1. 容器全 healthy（循环等 `(healthy)` 计数 ≥5）；backend 启动自动 migrate deploy，查 `_prisma_migrations` 最新几条
2. 登录拿 token 冒烟本批新端点/改动端点（200 + 正确 content-type）
3. staging psql 入口：`docker compose ... exec -T postgres psql -U ftm -d ftm`

## 7. 收尾
- 微信总结：已完成明细（按岗位分组 ✅ 列表，用运营的话别用开发黑话）+ 待拍板另发；SendUserFile 交付。
- 更新记忆（memory/ 对应批次文件 + MEMORY.md 索引）：批次结论、已拍板口径、教训、遗留项。
- 跨设备要用的口径沉淀进本文件或仓库 docs/，不要只留在本机 memory。

## 已知业务口径速查（避免重问）
- 开票=三维布尔（去程/回程/系统 invoiced），出票上限按航段计
- 后台/代理单 paymentExpiresAt=null 永不自动退位；散客 30 分钟
- 软删仅 ADMIN、占座先取消、净收款>0 禁删、回收站可恢复
- 调价原因只许纯财务类（优惠/补收杂费/变更改期费/其它）；升舱走套餐加购、换酒店走换酒店功能、多签换签证产品
- OTA 入单：批量创单粘贴解析（parseOtaRoster.ts）+ manualUnitPriceCny（仅 staff，系统价+调整行）
- PNR/票务导出：拆名支持斜线格式；PTC 按起飞日实足年龄；27 列航司模版列序格式一格不能动
- 套票"机票款=残差"拆分：业务已确认不做，**别再做**；如再被提起，只做展示报表、绝不驱动定价
