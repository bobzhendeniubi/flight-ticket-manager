# CLAUDE.md — Flight Ticket Manager (世途旅行 / 前台品牌「椰岛假期」)

## 🚫 铁律：产品里禁止出现内部同事姓名 / 内部出处标注

**绝不**在任何会进产品的地方写内部同事姓名，或"按某人口径 / 某人定名 / 反馈：某人"这类出处标注。
覆盖范围：`backend/`、`admin-web/`、`sales-web/`、`miniprogram/` 的**代码、UI 文案、注释、JSDoc、测试名（`it(...)`/`describe(...)`）、以及任何会渲染到界面的字符串**。
客户与商户都不该看到"我们内部是谁提的需求/定的口径"。这是硬性要求，发现即改。

**中性替代（去掉人名，保留含义）：**

| 内部姓名 | 角色 | 产品里写成 |
|---|---|---|
| 贺帅 | 财务负责人 | 财务 / 财务口径 |
| 赵姐 | 业务·运营需求来源 | 业务 / 运营需求 |
| 李萍 | 签证员 | 签证岗 |
| 李孟 | 房控 | 房控 |
| 谢晓枝 / 童明青 | 操作部 | 操作部 / 公测反馈 |
| 寇露 / 倪嘉露 / 章琴 / 王在美 | 财务团队 | 财务 |

- "口径 / 反馈 / 需求"这些**词本身没问题**——只去掉**人名**（"余位口径""公测反馈"保留）。
- 需求是谁提的、内部职责分工，**只记在 `docs/` 内部文档里**（那是内部资料，不进产品）。
- 写/改产品文案或注释前自检一句：**有没有人名？有就换成角色。**

## 项目结构

- **backend** — Fastify + Prisma + Postgres（订单/航班/产品/财务/履约/锁位/房控）。
- **admin-web** — 运营后台（"Console" 设计系统，靛蓝 Inter）。
- **sales-web** — 前台商城。消费者品牌 = **椰岛假期 / Coco Holiday**；`世途旅行 / Citur` 仅法律主体，**前台不露出**。设计系统 "Sunlit Coast → 椰岛"（海洋蓝绿 + 棕榈绿 + 暖沙 + 珊瑚，Manrope + Fraunces 展示字）。
- **miniprogram** — 微信小程序（Taro）。

## 构建 / 校验 / 部署

- **前端真值闸 = `npm run build`**（sales-web 根 tsconfig `files:[]`，裸 `tsc --noEmit` 是**假绿**）。
- 后端：`npm run build` + `npm test`。
- **只有一台服务器 `47.83.249.163`，它就是同事日常在用的环境**（`admin/store/api.citurtravel.com`，`NODE_ENV=production`）。
  历史上文档里管它叫 "staging"，但没有第二套环境——推上去同事立刻就看得到，按生产对待。
- 主干是 `main`，服务器也跟 `main` 跑（2026-08-23 前整个项目活在 feature 分支上，已快进合回）。
- 部署：`ssh -i ~/.ssh/ftm_staging root@47.83.249.163` → `cd /opt/ftm && git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build <svc>`（backend 启动自动 `prisma migrate deploy`）。**部署需用户逐次明确批准（"部署"）。**
  - `docker compose` 任何子命令（含 `ps`）都要带 `--env-file .env.prod`，否则报 `PAYMENT_MODE is missing`。
  - `.env.prod` 只在服务器上、未进版本库，切分支/拉代码都不会动它。
