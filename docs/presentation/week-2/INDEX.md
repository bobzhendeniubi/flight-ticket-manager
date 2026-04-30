# Week 2 演示 + 测试包

> 2026-04-29 内部演示 + 公司测试 1-2 周用的全部材料。
> 给 Bob 用：演示前过一遍 [DEMO_SCRIPT](./DEMO_SCRIPT.md)。
> 给团队用：先看 [TEAM_ACCOUNTS](./TEAM_ACCOUNTS.md) → 按 [TEST_PLAN](./TEST_PLAN.md) 跑 → 在 [FEEDBACK](./FEEDBACK.md) 记录问题。

---

## 文档清单

| 文档 | 给谁 | 做什么用 |
|------|------|---------|
| [TEAM_ACCOUNTS.md](./TEAM_ACCOUNTS.md) | 全员，先看这个 | URL + 5 个测试账号 + 6 张 demo 订单说明 |
| [TEST_PLAN.md](./TEST_PLAN.md) | 测试人员 | P0/P1/P2 场景 + 验收标准（含新功能：批量改状态、审计日志、我的分成） |
| [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) | Bob 自己 | 30-45 分钟分三段（客户/代理/管理员）演示流程 + 常见问题 |
| [FEEDBACK.md](./FEEDBACK.md) | 全员填问题 | 问题模板 + 严重度分级 + 已知问题清单 |
| [COSTS.md](./COSTS.md) | 决策层 / 全员 | 已花 ~$5,000 + 投产后 3 阶段月成本（AI / 服务器 / CDN / 其他） |

---

## Staging 环境快速链接

- 前台（客户/代理）：http://47.83.249.163/
- 后台（管理员）：http://47.83.249.163:8080/
- API 健康检查：http://47.83.249.163/api/healthz

测试账号密码统一：`Password123!`

| 邮箱 | 角色 | 入口 |
|------|------|------|
| `admin@ftm.local` | 管理员 | 后台 :8080 |
| `agent1@ftm.local` | 一级代理 | 前台 :80 |
| `agent2@ftm.local` | 二级代理 | 前台 :80 |
| `agent3@ftm.local` | 三级代理 | 前台 :80 |
| `customer@ftm.local` | 客户 | 前台 :80 |

完整说明见 [TEAM_ACCOUNTS.md](./TEAM_ACCOUNTS.md)。

---

## 本周新功能要点

1. **「我的分成」前台页**（agent 用）— 按层级看自己 + 下级的结算单 + 佣金明细
2. **批量改订单状态**（admin 用）— 表头全选 + 工具条选目标状态 + 强制模式开关
3. **审计日志中文化**（admin 用）— action 代码 + JSON 都翻译成人类可读，含彩色 diff

---

## 给团队群发的话

```
今天演示 staging 环境：
- 前台 http://47.83.249.163/
- 后台 http://47.83.249.163:8080/

文档（GitHub feat/m2-agent-hierarchy-flights 分支 docs/presentation/week-2/）：
- TEAM_ACCOUNTS.md  — 账号 + 流程
- TEST_PLAN.md      — 怎么测
- FEEDBACK.md       — 报问题模板
- COSTS.md          — 成本估算

1-2 周内有问题往 FEEDBACK 加；紧急的（点不开 / 报错）直接微信我。
```
