# Session Handoff · 下一会话从这里开始

> 把这个文件喂给下一个 Claude 会话开头就行（"读 docs/SESSION_HANDOFF.md 然后继续"）。

---

## 项目状态（2026-04-26 末）

**Branch:** `feat/m2-agent-hierarchy-flights` @ `9f705bb`（origin/GitHub 已同步）

**Stack:**
- `backend/` — Fastify + Prisma + BullMQ（Postgres 5432 + Redis 6379）
- `sales-web/` — React 18 + Vite + Tailwind + Zustand（:5173）
- `admin-web/` — React 18 + Vite + Tailwind（:5174）
- `miniprogram/` — Taro 4 + React + TS（微信开发者工具打开 `dist/`）

**TypeScript 4 端 `tsc -b --force` 全绿。**

---

## 本次会话 9 个 commits 完成的事

```
9f705bb fix(ai): admin 也显示 AI 助手 + .env 加 OPENAI_API_KEY 占位
3aeb1cf refactor(ai): 切换 Anthropic SDK → OpenAI SDK (gpt-5-mini 默认)
5505655 feat(ai): AI 订票助手 beta — Claude sonnet-4-6 + tool use loop + 双重确认
896bbcd feat: 取消订单 + 退款手续费引擎（费率可后台改）+ Codex 4 修复
810affa feat: 后台批量切位 + 前台小程序预览壳
db8cd5f feat(admin-web): 代理可进后台 — 只看自己树内订单/客户/旅客/结算
e481180 fix(miniprogram): 3 Codex verify-fix 回归 — idempotency/refresh/timeout
6297a35 fix(miniprogram): 6 Codex review 发现 — P1 fail-closed + 5 个 P2/P3
1291c0c feat: 微信小程序 · 客户端 MVP（Taro 4 + React + TS）
```

更早的 highlights:
- `b0a5391` Admin 定价日历 + 座位保留自动释放 + PNR/PDF/邮件
- `27fa179` 动态定价前端收尾 + 真图片 (Visa/Bundle)

---

## 现在跑得起来的

```bash
# 假设 Postgres + Redis 已经在跑
# Postgres: ftm/ftm_dev_password@localhost:5432/ftm
# Redis: localhost:6379

cd backend && npm run dev               # :4000
cd backend && npm run worker            # BullMQ worker (出票/座位释放/邮件)
cd sales-web && npm run dev             # :5173
cd admin-web && npm run dev             # :5174
cd miniprogram && npm run dev:weapp     # 编译到 dist/，配合微信开发者工具
```

**Demo 账号** 密码全部 `Password123!`:

| 角色 | 邮箱 |
|------|------|
| ADMIN | `admin@ftm.local` |
| CUSTOMER | `customer@ftm.local` |
| CUSTOMER（挂 agent1） | `customer2@ftm.local`、`customer3@ftm.local` |
| AGENT Tier 1 | `agent1@ftm.local` |
| AGENT Tier 2 | `agent2@ftm.local`、`agent2b@ftm.local` |
| AGENT Tier 3 | `agent3@ftm.local`、`agent3b@ftm.local`、`agent3c@ftm.local` |

---

## 🚧 下次要做的 3 件事（用户最新请求）

### 1. AI 助手 · 护照 OCR 上传入口
**需求：** 用户在 AI 聊天框里发一张护照照片，后端 OCR 识别后把姓名/护照号/出生日期/国籍读出来，自动填进结账页表单。

**当前状态：**
- `sales-web/src/lib/passportOcr.ts` 已有 **tesseract.js 浏览器端 OCR**（中文护照识别率 60-75%）
- 结账页 (`CheckoutPage.tsx`) 已经接了"上传照片识别"按钮 —— 但**只在结账页**有
- AI 助手 (`AiAssistant.tsx`) **没有**任何文件上传入口

**实现思路：**
- 方案 A（最快）：在 AI 聊天框加一个 📎 按钮 → 文件选择 → 直接调 `ocrPassport()` 浏览器 OCR → 把识别结果作为系统消息插入对话（"用户上传了护照：姓名 X，护照号 Y，DOB Z"）→ AI 用这些信息后续填表
- 方案 B（更稳）：新加 OCR 后端服务（接 AWS Textract / 阿里云 / 腾讯云通用文字识别）→ 给 AI 一个 `extract_passport(imageUrl)` tool
- **建议方案 A 先做**，B 写到 ROADMAP

**关键文件：**
- `sales-web/src/components/AiAssistant.tsx` — 加上传按钮
- `sales-web/src/lib/passportOcr.ts` — 已有 ocrPassport(file) 直接调
- `backend/src/lib/ai-assistant.ts` — 系统提示词加一段："用户可能会发护照信息（OCR 后的结构化数据），你看到时不要追问那些字段"

### 2. AI 确认订单卡 · 展开多产品明细
**需求：** 现在 `propose_order` 只支持机票，确认卡只显示 1 条机票。要支持订单含多个产品（机票 + 酒店 + 接送 + 签证 + 套餐），卡片能 expand 看每项详情。

**当前状态：**
- AI 工具 `propose_order` 在 `backend/src/lib/ai-assistant.ts:executeProposeOrder()` 只接受 `{ scheduleId, cabin, passengers }`，只生成一条机票草稿
- 前端 `AiAssistant.tsx > ProposalCard` 渲染单条机票

**实现思路：**
- 后端：新工具 `add_to_proposal` / `propose_complete_order` 接 multi-item array
  ```ts
  items: Array<
    | { kind: 'FLIGHT', scheduleId, cabin, passengers }
    | { kind: 'HOTEL', hotelRoomTypeId, checkIn, checkOut, rooms }
    | { kind: 'VISA', visaId, qty, express? }
    | { kind: 'TRANSFER', transferId, qty }
    | { kind: 'BUNDLE', bundleId, pax, rooms }
  >
  ```
  返回每项 priced result + 总价
- 前端 `ProposalCard` 改成 collapsible：标题"订单草稿（机票×2 + 酒店×3晚 + 签证×2）¥4567" → 展开看每行详情
- 系统提示词加：「如果用户问完整套餐，调 `propose_complete_order`；只买机票就用旧的 `propose_order`」（或者干脆把旧的废弃，统一新接口）

**关键文件：**
- `backend/src/lib/ai-assistant.ts` — 新工具
- `sales-web/src/components/AiAssistant.tsx` — `ProposalCard` 改 expand UI
- `sales-web/src/lib/api.ts` — `AiProposal` 类型加 items[]

### 3. AI 助手 · markdown 渲染坏了
**需求：** AI 现在回复带 `**加粗**` 之类的 markdown，前端**直接显示成字面星号**，看起来很丑。

**当前状态：**
- `AiAssistant.tsx` 用 `<div className="whitespace-pre-wrap">{m.text}</div>` 渲染 → 不解析 markdown
- AI 系统提示词没禁用 markdown，默认就会用 `**bold**` `*italic*` `### header` 等

**实现思路（选其一）：**

**A. 加 markdown 渲染器（推荐）**
```bash
cd sales-web && npm install react-markdown
```
```tsx
import ReactMarkdown from 'react-markdown';
// 替换 <div>{m.text}</div> 为：
<ReactMarkdown className="prose prose-sm">{m.text}</ReactMarkdown>
```
配合 `@tailwindcss/typography` 插件让 `prose` 生效，或自己写最简 styles for `<strong>` `<ul>` `<code>` 几个标签。

**B. 系统提示词禁用 markdown**
在 `backend/src/lib/ai-assistant.ts` 的 SYSTEM_PROMPT 末尾加：
```
# 输出格式
- **不要使用 markdown 语法**（不要 ** ## - 等符号）
- 用纯文本 + emoji 强调（✓ ⚠️ 💡 🎯 📋）
- 列表用 「1." 「2." 数字编号
```

**建议 A** —— 让 AI 自由发挥更自然，前端 5 分钟就能加 ReactMarkdown。

**关键文件：**
- `sales-web/src/components/AiAssistant.tsx` — 改渲染
- `sales-web/package.json` — +react-markdown
- 或 `backend/src/lib/ai-assistant.ts` — 改 system prompt

---

## 一些已知需要的下一步（更早讨论过，没做）

| 任务 | 优先级 | 备注 |
|------|--------|------|
| Sales-web 客户端 OrderDetail 页 | 中 | miniprogram 已有；sales-web 还没 |
| 真退款网关调用 | 中 | admin 推 REFUNDED 后只改 DB，没真调 wechat refund API |
| AI SSE 流式输出 | 低 | 现在等几秒一次性回，体验可以更好 |
| 小程序版 AI 助手 | 低 | sales-web 验证后镜像到 miniprogram |
| 真 OCR (AWS Textract) | 低 | tesseract demo 够用，生产再换 |
| 月度结算单生成 + 提款审核 | 中 | 代理长留刚需 |

---

## 会话工具

- 用户开发用的 OpenAI key 在 `backend/.env`（gitignored；本会话至少泄露过 2 个 key，已让用户全部 revoke）
- AI 默认模型 `gpt-5.4-mini`（用户的 key 有这个 model 权限；OPENAI_MODEL 可改）
- Codex 5.5 review 用 `codex exec` 命令（用户提到 "codex 5.5"），review 出问题就改

---

## 给下次会话的开场建议

直接告诉它：

> 读 `docs/SESSION_HANDOFF.md`。本次先做"下次要做的 3 件事"里的 #3 markdown 渲染（最快），再做 #1 护照 OCR，最后做 #2 多产品 expand。
