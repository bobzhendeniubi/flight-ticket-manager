# e2e 测试指南（Playwright）

面向开发。这套 e2e 用真浏览器点后台，专门补单测补不到的那一层：
导出、前端渲染、跨页状态流转——以前只能靠人眼冒烟的那些。

- 单测（`npm test --workspace=backend`）全是 mock，**不连库、不开浏览器**。
- e2e 起真 Postgres + 真后端 + 真 admin-web，点的是运营每天点的那些按钮。

两条用例：

| 文件 | 覆盖 |
|---|---|
| `e2e/tests/main-chain.spec.ts` | 一张套餐单走完 **录单 → 认款 → 签证 → 分房 → 出票标记 → 拆单 → 换人 → 取消** |
| `e2e/tests/smoke.spec.ts` | 登录后依次开 12 个主要页面，断言主标题可见、无 console error、无 5xx |

本地全绿约 **22 秒**（冷启，含迁移 + seed）。

---

## 一、跑之前：准备一个一次性测试库

e2e 的全局 setup 会对目标库跑 `prisma migrate deploy` + `seed`，**是写操作**。
所以有一道硬护栏：**库名不含 `e2e` / `test` 就直接报错退出**，碰不到实测库，也碰不到你本地的主开发库 `ftm`。

```bash
# 一次性建库（brew 的 Postgres 在 127.0.0.1:5432）
createdb -h 127.0.0.1 -O ftm ftm_e2e
```

库地址取值优先级：

1. 环境变量 `E2E_DATABASE_URL`
2. 否则读 `backend/.env` 里的 `DATABASE_URL`

推荐显式指定，别让它去读 `backend/.env`（那份平时指着主开发库，会被护栏拦下）：

```bash
export E2E_DATABASE_URL='postgresql://ftm:ftm_dev_password@127.0.0.1:5432/ftm_e2e?schema=public'
```

还要保证 Redis 起着 —— 后端的全局限流器挂在 Redis 上，**Redis 不通的话每个请求都会失败**（进程照样能起来、`/healthz` 照样 200，所以别拿进程起没起当判据）：

```bash
docker compose up -d redis
```

浏览器只装 chromium，一次就够：

```bash
npm run e2e:install
```

## 二、怎么跑

```bash
npm run e2e            # 跑全部
npm run e2e:ui         # Playwright UI 模式，一步步看
npm run e2e -- smoke.spec.ts          # 只跑冒烟
npm run e2e -- main-chain.spec.ts     # 只跑主链
npm run e2e -- --headed               # 想亲眼看它点
```

后端和 admin-web 由 `playwright.config.ts` 的 `webServer` 自己拉起来，**不用手工开 dev server**：

| 服务 | 端口 | 说明 |
|---|---|---|
| backend | 4801 | `npx tsx src/index.ts`（不是 `tsx watch`，避免跑用例中途因为存文件重启） |
| admin-web | 5874 | `vite --strictPort`，`baseURL` 就指它 |

刻意避开日常的 4000 / 5174，免得和同事或你自己开着的 dev server 抢端口。
本地默认 `reuseExistingServer`，所以连着跑第二次会快一些。

失败会自动留 **截图 + 视频 + trace**：

```bash
npx playwright show-trace e2e/test-results/<用例目录>/trace.zip
npm run report --workspace=e2e     # HTML 报告
```

## 三、什么时候跑

- **发版前必跑一次**（部署实测/测试环境之前）。主链绿 = 订单那条主干没被这批改动打断。
- 动过订单、收款、签证、分房、拆单、换人、退款里任何一块，本地跑一遍再提。
- CI 里是**手动触发**的独立 job：Actions → CI → Run workflow。
  常规 push / PR 不带它 —— 它要起 Postgres + Redis + 两个 dev server，挂在每次提交上太拖。

## 四、怎么加用例

### 选择器优先级

这个后台**几乎没有 `data-testid`**，所以按这个顺序挑：

1. `getByRole('button', { name: '确认收款' })` —— 角色 + 可见文案，首选
2. `getByLabel('出发日期')` —— 表单标签基本都是包裹式 `<label>文案<input/></label>`，能直接拿到控件
3. `getByPlaceholder('姓名 / 护照号…')`
4. 已有的 `aria-label`：`选择订单 {单号} 全部乘客`、`分房编辑`、`订单详情`、`录单`
5. **实在不行才加 `data-testid`**，而且只加属性，不动业务逻辑

目前只加过一个：`admin-web/src/pages/OrdersPage.tsx` 的 `PassengerEditForm` 根节点
`data-testid="passenger-edit-form"` —— 因为订单详情里「保存」按钮不止一个，非圈住这张表单不可。

### 几个真踩过的坑

- **登录别只断言「有个 h1」**。登录页自己就有一个 `<h1>登录</h1>`，会在登录请求还在飞的时候立刻通过，
  后面第一个 `goto` 就被 `Protected` 打回登录页。用 `loginAsAdmin()`（等 `**/dashboard` + 「运营仪表盘」标题）。
- **不是所有二次确认都会弹**。比如收款金额默认预填成尾款全额，正常路径根本不弹确认框；
  留空提交或重复同额才弹。用 `acceptConfirmIfShown()`，别写死等确认。
- **异步渲染的控件要显式 `waitFor`**。拆单弹窗勾人之后才去拉预览，「自动把同房组按人劈成两个半组」
  那个复选框要等预览回来才出现，立刻 `count()` 会拿到 0。
- **详情抽屉里有同名文本的隐藏副本**（导出/打印用）。断言人名一律加 `.filter({ visible: true })`。
- **弹层壳自带一个 `aria-label="关闭"` 的右上角叉**，正文底部往往还有一个「关闭」按钮，
  `getByRole('button', { name: '关闭' })` 会撞两个，按需 `.first()` / `.last()`。
- **「申请退款」走的是原生 `window.prompt`**，不是 React 弹窗。要挂 `page.on('dialog', d => d.accept('...'))`，
  否则 Playwright 默认 dismiss，动作静默失败。
- **拖拽分房不要用 UI 驱动**。主链里分房走 `PUT /orders/:id/room-assignment`，落库之后再回 UI 断言房间里站着谁——
  「能用 UI 就用 UI，实在脆的用 API 备料、UI 断言」。

### 用例之间怎么隔离

seed 是幂等的（全 upsert），不清库。用例靠 `runTag()` 生成每轮唯一的乘客名和护照号把自己和历史数据分开，
所以**反复跑不会互相干扰**，也不会撞上后端的重复乘客闸。

### 命名

测试名和注释里**不写同事姓名**，一律用岗位称呼（运营 / 财务 / 签证岗 / 操作部）。

## 五、目录

```text
e2e/
├── playwright.config.ts     # webServer（起后端 + admin-web）、baseURL、超时、报告
├── support/
│   ├── e2e-env.ts           # 端口/地址解析 + 测试库护栏（库名必须含 e2e/test）
│   ├── global-setup.ts      # migrate deploy + seed
│   └── admin-console.ts     # 登录、console/5xx 噪音收集、runTag、日期工具
└── tests/
    ├── main-chain.spec.ts
    └── smoke.spec.ts
```
