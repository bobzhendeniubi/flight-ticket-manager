# orders.service 结构（拆分后）与 OrderMutation 内核

> 2026-09-06 · 审查根因 R5（`docs/反馈存档/2026-09-05-效率审查-C-反馈模式与根因.md`）的落地。
> 拆分前盘点见 `docs/反馈存档/2026-09-06-orders-service-拆分盘点.md`。
> 原则：拆分**纯机械、行为零变化**；内核只把「行锁 / 幂等 / 审计进事务 / 守恒断言」四件各自早已存在的事收成一处，**不改任何业务口径、错误文案、审计 action 名**。

## 1. 模块图

```
backend/src/modules/orders/
├── orders.service.ts              facade（1.4k 行）：OrderService 类每个方法一行转调；拆分前导出的 166 个名字原名再导出
└── service/
    ├── order-mutation.ts          内核：runOrderMutation / runOrderOrchestration / lockOrderRowWithinTx
    ├── order-ledger.ts            账本快照 + 守恒断言（拆单 §11 的四个求和函数搬来共用）
    │
    ├── shared.ts                  常量 / 状态标签 / 档次映射 / 请求者类型 / 定价行构造器 / DTO 帮助 / 纯函数（叶子）
    ├── seat-inventory.ts          座位 CAS：takeSeatWithinTx / releaseSeat* / 超售三值 / 舱位行锁（叶子）
    ├── bundle-pricing.ts          套餐占用 / 房数 / 加项 / 酒店与随机档库存闸（叶子）
    ├── leg-action-log.ts          航段动作留痕 / 幂等 token 指纹 / 编排快照（叶子）
    │
    ├── create.ts                  建单 / 报价 / 批量建单 / 占位转正建单内核 / 定价校验与结算价日历
    ├── read.ts                    列表 / 详情 / 序列化 / 筛选 where / 公开查询 / 代理可见范围
    ├── status.ts                  状态机 _updateStatusWithinTx / 软删与恢复 / 开票标记 / 改签·退款申请
    ├── funds-links.ts             超收处置 / 余额抵扣 / 锁结算价·锁收款 / 换人退款与替换单号
    ├── pricing-adjust.ts          调价（单笔 / 批量 / 事务内内核）/ 改结算价
    ├── passengers.ts              乘客纠错 / 代理自助改乘客 / 换人（含重报价）/ 签证日期·票号 / 自备签
    ├── reschedule.ts              改期 / 批量改期 / 升舱 / 代理自助纠错班次 / 按人改期编排
    ├── hotel.ts                   换酒店 / 按房组拆行 / 单订酒店改期 / 改归属代理 / 加项 / 补房差 / 套餐改档
    ├── split.ts                   拆单预检 / 执行内核 / 幂等重放 / 镜像票务任务
    ├── legs.ts                    取消航段 / no-show / 恢复回程 / 作废回程（含预检与工单）
    ├── commission.ts              计佣落库
    └── visa-sync.ts               履约任务生成 / 签证任务同步 / 拆单承接签证任务
```

| 文件 | 行 | 类方法数 |
|---|---:|---:|
| orders.service.ts（facade） | 1 434 | 109（全部一行转调） |
| service/create.ts | 3 452 | 18 |
| service/legs.ts | 3 088 | 19 |
| service/passengers.ts | 3 034 | 14 |
| service/hotel.ts | 2 727 | 7 |
| service/split.ts | 2 398 | 5 |
| service/read.ts | 2 259 | 12 |
| service/reschedule.ts | 1 848 | 8 |
| service/status.ts | 1 605 | 13 |
| service/shared.ts | 1 437 | — |
| service/bundle-pricing.ts | 905 | — |
| service/funds-links.ts | 866 | 9 |
| service/visa-sync.ts | 636 | — |
| service/pricing-adjust.ts | 603 | 4 |
| service/leg-action-log.ts | 415 | — |
| service/seat-inventory.ts | 381 | — |
| service/order-ledger.ts | ~300 | — |
| service/order-mutation.ts | ~220 | — |
| service/commission.ts | 288 | — |

依赖方向：`shared` 不依赖任何兄弟；`seat-inventory / bundle-pricing / leg-action-log / order-ledger` 只依赖 `shared`（与 `leg-action-log`）；业务组只 `import type { OrderService }`（类型导入，运行时无环）；`order-mutation` 只依赖 `order-ledger`。

## 2. facade 怎么转调

- `orders.service.ts` 里 `OrderService` 的每个方法签名与拆分前**一字不差**，方法体是一行 `return xxxSvc.method(this, …)`。
- 子模块里方法体写成 `export function method(svc: OrderService, …)`，原来的 `this.xxx` 一律是 `svc.xxx` —— **跨组调用仍走 facade 实例**，所以单测里 `vi.spyOn(service, 'rescheduleOrderItem')` 一类 spy 行为不变（`reschedulePassengers` 内部调 `svc.rescheduleOrderItem` 会命中 spy）。
- 原 `private` 方法为了让子模块通过 `svc.` 调用而去掉了 `private`（运行时无差异；测试本来就是 `(service as any)._xxx`）。
- 拆分前 `export` 的名字由 facade `export { … } from './service/<组>.js'` 原名再导出，routes / 其它模块 / 测试的 import 路径**一个没改**（生成器逐名对账 166 个）。
- 动态 `import('../../queues/queue.js')` 因目录深一层写成 `'../../../…'`，其余一字未动。
- 拆分是一次性生成器（TS AST 搬家）完成的，生成器不进仓库；**以后直接改子模块**，不要再指望重新生成。

## 3. OrderMutation 内核

`service/order-mutation.ts`：

```ts
const audit = await runOrderMutation<CancelLegAudit>(
  {
    orderId,                              // 行锁目标（主单）
    actor,                                // { userId, role }
    action: 'CANCEL_RETURN_LEG',          // 现有审计 action 名，只作留痕上下文 / 守恒文案
    requestToken: input.requestToken,     // 有 token 才做幂等
    idempotency: { fastPath: false, find: (db) => findCancelLegReplay(db, orderId, input) },
    conserve: { unchanged: ['paid', 'rooms'], label: '取消回程' },
  },
  async (ctx) => {
    const tx = ctx.tx;                    // 动作本身照写
    await ctx.audit({ action: '…', … }); // 事务内审计（writeAuditWithinTx）
    ctx.afterCommit(() => { void notify(); }); // 提交后钩子（fire-and-forget 自己 void）
    ctx.track(newOrderId);                // body 里才知道的单加进守恒快照（拆单新单）
    return audit;
  },
);
```

内核做的四件事（顺序即代码顺序）：

1. **幂等快路径**（事务外，`fastPath !== false` 且有 token）：`find(prisma)` 命中 → 原样返回，不进事务、不拿锁。
2. **事务 + 行锁**：`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`（与改期 / 超时 worker / 认款同一把锁；不存在 → `NotFoundError('订单不存在')`）。
3. **锁内幂等复查**：`find(tx)` 命中 → 回放（并发同 token 双击，后到者在锁内命中）。`fastPath: false` 的动作只做这一次（留痕在航段行 metadata 上，必须读锁后的行才作数）。
4. **body → 守恒 → 提交 → 钩子**：`conserve` 声明了就在 body 前后各读一次账本快照（`order-ledger.snapshotOrderLedger`），点名维度 Σ 不等或账本恒等式**新**出现不平 → 抛错 → 整事务回滚；提交后按注册顺序 `await` 钩子。

5. **按人份额落库**（`persistShares: true`，审查根因 R1，2026-09-06）：守恒通过后对主单 + `conserve.orderIds` + `ctx.track()` 的每张单调 `service/passenger-shares.persistPassengerShares`（每位在单乘客一行 upsert，Σ 份额对不上应收同样回滚）。七条已接路径全部开了；未接内核的改钱路径在各自事务末尾直接调同一个写点。业务口径见 `docs/系统逻辑全解.md` §4a。

内核**不替动作自动写审计**（路由层与各动作已有各自约定，重复写会让财务对账多一条），也**不能嵌套**：body 里不能再调会自己开 `prisma.$transaction` 的方法（Prisma 交互式事务不可嵌套，内层拿全局 client 另开连接会撞上外层刚拿的行锁）。两段式编排用 `runOrderOrchestration`（无事务、无锁，只统一幂等快路径与「全部段落提交后」的钩子）。

### 守恒口径（`service/order-ledger.ts`，全部复用既有函数）

| 维度 | 算法 | 来源 |
|---|---|---|
| receivable | Σ(total + adjustmentCny) | 拆单 §11 conservationSelect |
| paid | Σ(paidAmount + prepaymentOffset) | 同上 |
| seats | 逐班次舱位 Σquantity + 逐班次舱位升舱位 | `sumFlightQuantities` / `sumFlightUpgradeCounts`（原 split.ts） |
| rooms | Σ roomsBilled（半间整数） | `sumRoomsBilledHalves`（原 split.ts） |
| cost | Σ totalCostCny（分） | `sumTotalCostCents`（原 split.ts） |

账本恒等式（每张被点名的单）：`subtotal = Σ items.amount`、`total = subtotal`（建单 / 改结算价的既有口径：目前没有 taxes / discount）、`total ≥ 0`、Σ 每人份额 = 应收（`computePerPaxShares` + `groupPassengerAdjustments`）、挂人的调价行必须还有这个人。**只拦本次新引入的不平**：存量脏单 before 就不平的同类不平原样放行，内核不替历史数据背锅、也不让它卡住无关动作。

## 4. 已接内核的七条写路径

| 动作 | 模块 | 锁 | 幂等 | 审计进事务 | 守恒（前后恒等维度） | 提交后钩子 |
|---|---|---|---|---|---|---|
| `splitOrder` | split | 内核 | 快路径 + 锁内复查（`findSplitReplayIn`，OrderSplitRecord (源单, token)） | SPLIT_ORDER ×2 / SPLIT_ORDER_COMMISSION / SPLIT_ORDER_PREPAYMENT_OFFSET（原先事务外 fire-and-forget） | 仍是 `executeSplitWithinTx` §11 那份更细的（含开票人数 / 佣金 / 逐侧占座）；内核通用五维是它的子集，不重复读 | 两侧 `syncOrderVisaCompletion` |
| `markNoShow → _executeNoShow` | legs | 内核 | 锁内（航段行 metadata token + 指纹，`findNoShowReplay`） | —（路由记 MARK_NO_SHOW） | receivable / paid / rooms / cost | 企微推送仍在调用方（markNoShow）事务后 `void` |
| `cancelLeg` | legs | 内核 | 锁内（`findCancelLegReplay`） | MANUAL 手续费 CRITICAL（原本就在事务内） | paid / rooms | 企微推送事务后 `void`（原位置） |
| `restoreReturnLeg` | legs | 内核 | 锁内（`findRestoreReturnLegReplay`） | 超售放行 / 挤占预留两条 CRITICAL（原本就在事务内） | receivable / paid / rooms / cost | 同上 |
| `voidReturnLeg` | legs | 内核 | 锁内（`findVoidReturnLegReplay`） | —（路由记 VOID_RETURN_LEG） | receivable / paid / seats / rooms / cost | — |
| `swapPassenger` | passengers | 内核（按列读锁行的 SELECT … FOR UPDATE 保留，同事务重复上锁无副作用） | **无**（前端不带 requestToken，待拍板） | SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION WARNING（原先事务提交后 await 写） | paid / seats / rooms / cost | — |
| `reschedulePassengers` | reschedule | 编排模式：拆单段（已接内核）+ 改期段（`rescheduleOrderItem` 自己的事务）各自持锁 | 仍在 body（拆单流水编排快照比对 + 全员分支 token 回放；回放命中后还要继续对新单改期） | — | 各段各自 | RESCHEDULE_PASSENGERS 汇总审计（原先 await，现 afterCommit，顺序不变） |

行为差异**只有一处是有意的**：拆单四条 CRITICAL 审计与换人那条 WARNING 审计从事务外改进事务——写不成整体回滚，「钱动了却查不到是谁动的」这种状态不再可能。其余（锁、回放口径、错误文案、审计字段、企微推送时机）一字未变。

## 5. 未接内核的写路径（29 条，留清单）

按模块列；每条都还是自己的 `prisma.$transaction`（大多数已各自 FOR UPDATE）。接入顺序建议：先钱（pricing-adjust / funds-links）、再库存（hotel / reschedule）、最后状态机。

- **status**：`updateStatus`、`requestChange`、`requestCancellation`、`setInvoiceFlags`
- **funds-links**：`applyAgentBalanceToOrder`、`creditOverpayToAgent`、`overpayToPool`、`batchSetSettlementLock`、`batchSetPaymentsLock`、`swapRefund`、`updateSwapReplacementOrderNumber`
- **pricing-adjust**：`addPriceAdjustment`、`batchAddPriceAdjustment`、`updateItemSettlementPrice`
- **hotel**：`swapItemHotel`、`splitHotelItemByRoomGroup`、`rescheduleItemHotel`、`changeOrderAgent`、`changeOrderBundle`、`addGroundItem`、`addRoomSupplement`
- **passengers**：`correctPassenger`、`setOrderVisaStatus`、`setPassengerVisaExempt`
- **reschedule**：`rescheduleOrderItem`、`upgradeOrderItemCabin`
- **create**：`createOrder`（建单没有「已有订单」可锁，接法要另议：锁班次舱位行）
- **read**：`listOrders`、`listDeletedOrders`（只读事务，不该接）

批量动作（`batchSetSettlementLock` 等按 id 排序逐单 FOR UPDATE）接内核要加多单锁（按 id 排序），当前内核只锁主单。

## 6. 给新写路径的接法（三步）

1. 把「同 token 已做过 → 回放」那段抽成 `findXxxReplay(db, …): Promise<R | null>`（留痕在 metadata 上的用 `fastPath: false`）。
2. `prisma.$transaction(async (tx) => { 锁; 回放; …})` 换成 `runOrderMutation({...}, async (ctx) => { const tx = ctx.tx; … })`，事务内的 `writeAuditWithinTx(tx, {actor, …})` 换成 `ctx.audit({…})`。
3. 声明 `conserve.unchanged`：动作**不该**动的维度点出来（钱不动的写 `['receivable','paid','rooms','cost']`，动钱的至少写 `['paid']`）。

## 7. 测试

- `service/order-ledger.test.ts`（16 例）：五维求和、逐维度恒等文案、账本恒等式五类违反、只拦新不平。
- `service/order-mutation.test.ts`（17 例，mock prisma）：锁先于 body、订单不存在、快路径 / 锁内复查 / fastPath:false、find 抛错原样上抛、ctx.audit 走 tx 且 actor 缺省、审计失败整事务失败、钩子顺序与 body 抛错不跑、守恒回滚、恒等式新不平回滚而存量放行、ctx.track、编排模式。
- `service/order-mutation.integration.test.ts`（5 例，真 Postgres）：同 token 并发两次只执行一次且审计一条；守恒失败订单一分没动、事务内审计没留下；`markNoShow` 同 token 并发两次回程座位只放一次；拆单 §11 被迫失败 → 源单原样、无新单、无拆单流水、无 SPLIT_ORDER 审计，同 token 重来真的拆成。
- 既有：后端单测 226 文件 / 4 836 例、集成 26 文件 / 243 例、e2e 主链 + 12 页冒烟。
