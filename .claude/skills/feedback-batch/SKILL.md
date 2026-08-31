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
   **等价物全量盘点是硬前置**（0825 教训）：只核实"被点名的功能确实不干这事"≠"系统干不了这事"。导出/报表类诉求尤其如此——系统里同域入口通常有多个（订单页三模板/整班机/master/分房表/房态/护照 zip……），归入 ✅/⚠️ 前必须把该领域**全部**入口扫一遍（grep 路由 + 导出文件 + 页面），给用户的分析先答"现有 XX 是否已覆盖"。0825 分房表"导当天所有订单"实为订单页《全岗可用》筛出发日已覆盖；0824 录单批 5 条里 2 条也是功能早有只是没配。
3. ⚠️ **真需求但按原话做会出事**：给"正解方案"（如硬删→软删、手填价→调价通道、全拆拦截→仅后台确认强过）
4. 💬 **新需求/要拍板的口径**：整理成**微信文案**（SendUserFile 发 .md，问题编号化让对方能按 1①②③ 直接回复；口径类单独一条、已完成明细另一条）

**运营旁路检查**（0708 教训）：财务有审计 ≠ 运营看得见。任何绕过结构化操作的通道（调价、强录、删除）都要问：库存/房控/签证履约岗位还能看到真实状态吗？

**质疑需求——先对峙，再动手**（0714 定价语义之争定型，老板亲自示范的问法）：运营的改法诉求 ≠ 需求本身，把口径逼到具体数字再归类：
1. 对方嫌"太复杂/不得行" → 先讲清**设计意图**（如：分项报价=展示各项单卖原价，衬托套餐划算），分清是真流程卡点还是没理解意图。没理解的先解释，别急着改系统。
2. 对方抛 workaround（"价格随便填高点"）→ 用**现实推演**戳破：客户不是傻子，会单独买了自己加总对账——组件价必须是真实单卖价，拍脑袋填数不可接受。
3. 一切争论落到**具体金额**：「单卖多少钱？套票卖多少钱？」——0714 正是这样问出了运营把「每晚起价（前台展示价）」字段填成了**成本价**（填 180，实际单卖 300）。
4. 拿**系统事实**对质：字段标签是什么就截图圈出来（"每晚起价（前台展示价）"），不争抽象概念。
5. 追问到底通常会暴露**真产品问题**：组件单卖价加总 ≠ 想卖的套票价（2800）→ 要解的是"套餐总价与组件加总的关系口径"，不是照原话"简化系统/随便填价"。这类深层矛盾整理成拍板项交用户，绝不按表面诉求直接改。
6. **价格字段语义三层速查**：成本价（内部，costPriceCny 类字段）／单卖展示价（前台）／套餐权威价（下单）——运营最常混填。遇到价格类反馈，先问清对方脑子里说的是哪一层，再归类。

## 3. 用户说「做」之后：分波 spawn agent
每条一个 agent（用户惯例），**按文件簇分波，波内文件不相交、波间串行**：
- **热点文件必须串行**：`admin-web/src/pages/OrdersPage.tsx`（超大：列表/筛选/导出/批量条/BatchCreateModal/详情抽屉/乘客区是不同小节，同波两个 agent 只能各占一个小节且在 prompt 里明说）、`backend/src/modules/orders/orders.service.ts`（按函数区域划分并点名"别碰 XX 小节"）、`SingleOrderModal.tsx`、`VisaDeskPage.tsx`、`orders.export-*.ts`。
- 模型：机械活/UI 接线/补测试用 **sonnet**，模型改动/根因排查/大功能用 **opus**。
- 每个 agent prompt 必含：仓库路径+分支；任务原话+已核实的现状证据；实现要点；**硬性约束**（不 commit/push/部署/不跑 npm run build；人名铁律；点名禁碰文件/小节；后端 `npx vitest run <文件>` 跑绿；前端 tsc -p tsconfig.app.json）；要求最终回复给"改动文件:行、口径、测试结果、遗留风险"。
- agent 报告里的"遗留风险/衔接缺口"要读——常有真问题（如换人没清生日）：小的自己顺手修，大的报给用户拍板。

### 3.1 分波的四个坑（2026-07-15 一天踩全，22 个 agent 实测）

**① 按文件分工，但改动本身跨文件。**
删一个数据库字段时，我按「谁拥有哪个文件」划分工、明令 agent「别碰 hotel-control/」——**而 hotel-control 正好读那个字段** → 字段删了，它编译不过。
→ **判据：改动的单位是「文件」还是「符号」？** 删字段/改签名/改枚举是**符号级**的，爆炸半径 = 全仓引用，**不是你划的那个目录**。这类活先 grep 出全部引用，**引用列表就是分工边界**，不是反过来。

**② grep 停在第一个命中，就当成了「唯一调用方」。**
「护照 zip 只有签证台在调，收权限安全」——实际有第二个调用方，改了会 403 掉一个代理天天在点的按钮。**我拿这个假前提去要了老板的批准。**
→ **判据：说「唯一」之前，把 grep 结果数出来。** 「找到一个」和「一个都没漏」是两回事。

**③ 目录名不是权限模型。**
我把 `admin-web` 读成「管理员后台」——**它其实是 ADMIN/STAFF/AGENT 共享的控制台**，代理进得来、订单页就是它的落地页。基于「这是后台所以只有内部人」做的每个推论都错了。
→ **判据：权限只看 `Protected`/`requireRole` 的实际代码**，不看目录名、不看应用名。

**④ 把「跑法错了」当成「既有的债」，还传播了五次。**
`npx vitest run src/modules/orders/` 会把 `*.integration.test.ts` 卷进来，但**默认配置不加载集成 setup**（不 truncate/不 migrate）→ fixture 撞唯一约束**假红**。我跟五个 agent 说「那 5 条是既有失败，别管」——**用对配置（`-c vitest.integration.config.ts`）6/6 全绿**。
→ **判据：报告「既有失败」之前，先确认自己跑对了。** `npm test` 的 `--exclude` 存在就是有原因的。
→ **附带**：`npm run test:integration` 全量会把测试 Postgres **OOM 打死**（`docker-compose.test.yml` 数据放 tmpfs=内存）。分模块跑，别一把梭。

### 3.2 agent 拦你的时候，先信它

今天 22 个 agent 里**三次拦下我的指令，三次都是它对**：
- 「护照 zip 照 PNR 那样改用脱敏乘客」→ **拒绝**：那里图**就是交付物**，照搬会给代理一个零张图的空 zip——静默弄坏功能，不是加固。
- 「删掉 sales-web 的 admin 路由」→ **只删了假的三个**，保留 `/admin/flights`——它**有 5 个真实 API 调用、是真能用的页面**，不是假后台。（后来另起一个 agent，**先验完 5 个能力在 admin-web 全都有等价物**，才把它删掉。**删除的前置条件是平权证明，不是我说删。**顺带：我口头说的「6 个 API」也是错的，是 5 个——`listSchedules` 被调了两次。）
- 「B7 用 `productType === 'FLIGHT_ROUNDTRIP'` 做守卫」→ **核出该字段根本不落库**，且就算落了也是错的（套餐单真的有回程，会被误排除 → **假阴性比原来的假阳性更糟**）。

→ **prompt 里显式给「停下来报我」的授权**，并点明哪些前提**它必须自己重新核实**。**你给的前提越具体，它越容易发现你错了。**

### 3.3 别让 agent 碰 `git stash`

树上载着十几个 agent 的未提交改动时，**任何 stash 都是在拿全天的活赌博**。今天有两个 agent 为了「测改动前的基线」stash 又 pop（都自报了，也都没丢东西——但那是运气）。
→ **prompt 里明写「不要 `git stash`」**。要测基线用别的办法：读 commit、跑指定测试文件、或直接问主会话。

---

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
