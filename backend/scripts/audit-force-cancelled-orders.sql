-- =============================================================================
-- 历史数据体检：06-23 ~ 07-08 期间「已收款却被 force 取消、退款没跟上」的订单
-- =============================================================================
--
-- 【这是只读体检脚本，不修任何数据】
-- 全文包在 `SET TRANSACTION READ ONLY` 事务里，结尾 ROLLBACK。即使误加了写语句，
-- 数据库层也会直接拒绝执行。不要把这个约束删掉。
--
-- ---------------------------------------------------------------------------
-- 背景（为什么要查）
-- ---------------------------------------------------------------------------
-- 06-23 上线的订单「删除」按钮，实现并不是删除，而是：
--     updateStatus(id, 'CANCELLED', '录入错误删除', force = true)
-- 弹窗文案却写「不可恢复」——实际只是把订单取消掉了。
-- force = true 会**绕过状态机守卫**，所以**已收款的 PAID 单也能被"删除"**：
--     座位释放 ✓   paidAmount 原样留在订单上 ✗   不建 Refund ✗
--   → 订单从列表消失，但**退款义务没有任何记录在追**。钱还在我们这儿，客户不知道。
--
-- 07-08 才有真正的软删 + 回收站（Order.deletedAt），并带 netReceived > 0 拒删闸
-- （见 orders.service.ts softDeleteOrder）。
--   → 所以嫌疑窗口 ≈ 06-23 ~ 07-08。
--
-- ---------------------------------------------------------------------------
-- ⚠️ 口径警告一：updatedAt 是脏代理
-- ---------------------------------------------------------------------------
-- Order.updatedAt 是 @updatedAt —— 取消之后**任何**一次改动（改备注、改结算价、
-- 后来被软删、脚本回填…）都会把它推到今天。所以：
--   * 用 updatedAt 卡窗口会**漏**（当年取消、上周被人碰过 → 落到窗口外）；
--   * 也会**误收**（窗口内最后一次改动，但取消其实发生在别的时间）。
-- → **以 OrderStatusEvent / AuditLog 的 createdAt 为准（append-only，不会被推）。**
--   下面查询 A 只是**兜底网**，真正定性看查询 B / C。
--
-- ---------------------------------------------------------------------------
-- ⚠️ 口径警告二：查出来的单怎么处理，不由工程决定
-- ---------------------------------------------------------------------------
-- 这个脚本只负责**把嫌疑单列出来**。列出来 ≠ 就是坏账，也 ≠ 就该补退款：
--   可能当年已经**线下**退给客户了，只是系统里没建 Refund（那是记录缺失，不是欠款）。
-- 三条处置路线（补建 Refund 追平 / 只出清单交财务逐单人工核 / 认定坏账核销）
-- **都动钱，必须财务拍板**。工程不要自己选一条就跑。
--
-- ---------------------------------------------------------------------------
-- 怎么跑（staging）
-- ---------------------------------------------------------------------------
--   ssh root@47.83.249.163
--   cd /opt/ftm
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U ftm -d ftm -f - < backend/scripts/audit-force-cancelled-orders.sql
--
--   # 或把文件拷进容器再跑：
--   docker compose -f docker-compose.prod.yml cp \
--     backend/scripts/audit-force-cancelled-orders.sql postgres:/tmp/a.sql
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U ftm -d ftm -f /tmp/a.sql
--
-- 时区：DateTime 列是 timestamp(3) without time zone，存的是 **UTC**。
-- 下面窗口用的是 UTC，且两头各放宽了一点，避免 -0700 换算把边界单切掉。
--   06-23 按钮上线   = 2026-06-24 02:31 UTC
--   07-08 软删闸上线 = 2026-07-08 21:51 UTC
-- =============================================================================

\pset pager off
\timing off

BEGIN;
SET TRANSACTION READ ONLY;   -- ← 硬闸：本事务内任何写操作都会被 PG 拒绝

-- =============================================================================
-- 查询 A —— 兜底网：净欠款 > 0 的取消/超时单（按 updatedAt 卡窗口，口径脏）
-- =============================================================================
-- 「已退」口径与生产守卫严格一致：只认 Refund.status = 'COMPLETED'
--   （见 orders.service.ts:1656 refunds: { where: { status: 'COMPLETED' } }）
--   REQUESTED / APPROVED / PROCESSING 的退款**还没到客户手里**，不能算已退。
-- net_owed = paidAmount − 已完成退款 ＝ 生产 netReceived 的同一条公式。
--
-- 注意：**故意不加 deletedAt IS NULL**。被软删的单是最该查的一类
--（列表/导出全看不见 → 最容易烂在那儿），所以连它们一起捞，用 deleted_at 列区分。
\echo '=== [A] 净欠款>0 的取消族订单（updatedAt 窗口 · 脏代理 · 仅兜底参考）==='
SELECT
  o."orderNumber",
  o.status,
  o."paidAmount"                                   AS paid,
  COALESCE(r.refunded, 0)                          AS refunded,
  o."paidAmount" - COALESCE(r.refunded, 0)         AS net_owed,
  o."deletedAt"                                    AS deleted_at,   -- 非空 = 已软删（列表里看不见）
  o."adjustmentCny"                                AS adjustment_cny,
  o."prepaymentOffset"                             AS prepayment_offset,
  o."createdAt"                                    AS created_at,
  o."updatedAt"                                    AS updated_at    -- ⚠️ 脏：之后任何改动都会推它
FROM "Order" o
LEFT JOIN (
  SELECT "orderId", SUM(amount) AS refunded
  FROM "Refund"
  WHERE status = 'COMPLETED'          -- 只认真正退到账的
  GROUP BY "orderId"
) r ON r."orderId" = o.id
WHERE o.status IN ('CANCELLED', 'PAYMENT_TIMEOUT', 'REFUNDED', 'FAILED')
  AND o."paidAmount" > 0
  AND o."paidAmount" - COALESCE(r.refunded, 0) > 0
  AND o."updatedAt" >= TIMESTAMP '2026-06-23 00:00:00'
  AND o."updatedAt" <  TIMESTAMP '2026-07-10 00:00:00'
ORDER BY net_owed DESC;

-- =============================================================================
-- 查询 B —— 权威口径：OrderStatusEvent 直接指认「当年被删除按钮打掉的单」
-- =============================================================================
-- 这是**最强的一条线索**，比 AuditLog 还准：
--   * OrderStatusEvent 是 append-only，createdAt 不会被后续改动推走（治好了 updatedAt 的脏）；
--   * 它带 orderId（AuditLog 的批量记录没有，见查询 D 的坑）；
--   * reason = '录入错误删除' 是**删除按钮写死的字符串**，等于它的指纹；
--   * fromStatus 直接告诉我们「被打掉的那一刻它是不是 PAID」——PAID → 就是收了钱被抹掉。
-- OrderStatusEvent 不记 force 位（metadata 这条路径没写），所以 force 与否看查询 C。
\echo ''
\echo '=== [B] 删除按钮指纹（reason=录入错误删除）· 权威时间轴 · 附当前净欠款 ==='
SELECT
  o."orderNumber",
  e."fromStatus"                                   AS killed_from,   -- PAID = 收了钱还被打掉
  e."toStatus"                                     AS killed_to,
  e."createdAt"                                    AS killed_at,     -- ✓ 不可篡改的真实时间
  e.reason,
  e."actorUserId"                                  AS actor_user_id,
  o.status                                         AS status_now,
  o."paidAmount"                                   AS paid,
  COALESCE(r.refunded, 0)                          AS refunded,
  o."paidAmount" - COALESCE(r.refunded, 0)         AS net_owed,
  o."deletedAt"                                    AS deleted_at
FROM "OrderStatusEvent" e
JOIN "Order" o ON o.id = e."orderId"
LEFT JOIN (
  SELECT "orderId", SUM(amount) AS refunded
  FROM "Refund"
  WHERE status = 'COMPLETED'
  GROUP BY "orderId"
) r ON r."orderId" = o.id
WHERE e.reason = '录入错误删除'
ORDER BY (o."paidAmount" - COALESCE(r.refunded, 0)) DESC, e."createdAt";

-- =============================================================================
-- 查询 C —— 交叉：AuditLog 里的 force 记录 → 区分「被 force 删的」vs「正常取消没退款」
-- =============================================================================
-- ⚠️ 字段名更正：AuditLog **没有** payload / metadata 列。它是 before / after（都是 jsonb）。
--    force 位写在 after 里：after = { toStatus, reason, force }（orders.routes.ts:330）。
-- 两种 action 都要捞：
--    FORCE_ORDER_STATUS    —— force=true 时写的（新）
--    ADVANCE_ORDER_STATUS  —— 正常路径；旧批次可能 force 位在 after 里但 action 没区分
-- 所以不靠 action 名判断，直接看 after->>'force'。
\echo ''
\echo '=== [C] AuditLog force 记录 × 净欠款（单笔口径 · targetId = 真实 orderId）==='
SELECT
  a."createdAt"                                    AS forced_at,     -- ✓ append-only
  a.action,
  a."actorLabel"                                   AS actor,
  a."actorRole"                                    AS actor_role,
  a.after ->> 'toStatus'                           AS to_status,
  a.after ->> 'reason'                             AS reason,
  a.after ->> 'force'                              AS force_flag,
  o."orderNumber",
  o.status                                         AS status_now,
  o."paidAmount"                                   AS paid,
  COALESCE(r.refunded, 0)                          AS refunded,
  o."paidAmount" - COALESCE(r.refunded, 0)         AS net_owed,
  o."deletedAt"                                    AS deleted_at,
  CASE
    WHEN o."paidAmount" - COALESCE(r.refunded, 0) > 0 THEN '⚠️ 被force掉且仍有净欠款'
    ELSE 'force掉但钱已平'
  END                                              AS verdict
FROM "AuditLog" a
JOIN "Order" o ON o.id = a."targetId"
LEFT JOIN (
  SELECT "orderId", SUM(amount) AS refunded
  FROM "Refund"
  WHERE status = 'COMPLETED'
  GROUP BY "orderId"
) r ON r."orderId" = o.id
WHERE a."targetType" = 'ORDER'
  AND a.action IN ('FORCE_ORDER_STATUS', 'ADVANCE_ORDER_STATUS')
  AND a.after ->> 'force' = 'true'
ORDER BY (o."paidAmount" - COALESCE(r.refunded, 0)) DESC, a."createdAt";

-- =============================================================================
-- 查询 D —— 已知盲区：批量 force 的审计记录**追不到具体订单**
-- =============================================================================
-- 坑：批量改状态写审计时 targetId 是字符串 'batch'，不是订单 id（orders.routes.ts:361）。
--     after 里只有 requestedCount / successCount，**没有 ids**。
--   → 通过 BATCH_FORCE_ORDER_STATUS **无法反查是哪几单被打掉的**。查询 C 天然漏掉这批。
--   → 这也是为什么查询 B（OrderStatusEvent，按单逐条记）不可替代：批量路径同样会逐单写
--     OrderStatusEvent，所以批量打掉的单**能在 B 里现形**，只是 reason 取决于当时填了什么。
-- 这条查询只统计「批量 force 发生过几次、涉及多少单」，用来判断盲区有多大。
\echo ''
\echo '=== [D] 批量 force 事件（盲区评估：审计追不到具体 orderId）==='
SELECT
  a."createdAt"                                    AS forced_at,
  a.action,
  a."actorLabel"                                   AS actor,
  a.after ->> 'toStatus'                           AS to_status,
  a.after ->> 'requestedCount'                     AS requested_count,
  a.after ->> 'successCount'                       AS success_count,
  a.after ->> 'reason'                             AS reason,
  '审计未记 orderId → 需用查询 B 按时间对齐'        AS note
FROM "AuditLog" a
WHERE a.action IN ('BATCH_FORCE_ORDER_STATUS', 'BATCH_ADVANCE_ORDER_STATUS')
  AND a.after ->> 'force' = 'true'
ORDER BY a."createdAt";

-- =============================================================================
-- 查询 E —— 汇总：总共有多少钱悬着
-- =============================================================================
\echo ''
\echo '=== [E] 汇总：净欠款总额（全时段 · 不卡窗口 · 口径同 A）==='
SELECT
  COUNT(*)                                             AS suspect_orders,
  SUM(o."paidAmount" - COALESCE(r.refunded, 0))        AS total_net_owed,
  MIN(o."updatedAt")                                   AS earliest_touch,
  MAX(o."updatedAt")                                   AS latest_touch,
  COUNT(*) FILTER (WHERE o."deletedAt" IS NOT NULL)    AS also_soft_deleted
FROM "Order" o
LEFT JOIN (
  SELECT "orderId", SUM(amount) AS refunded
  FROM "Refund"
  WHERE status = 'COMPLETED'
  GROUP BY "orderId"
) r ON r."orderId" = o.id
WHERE o.status IN ('CANCELLED', 'PAYMENT_TIMEOUT', 'REFUNDED', 'FAILED')
  AND o."paidAmount" > 0
  AND o."paidAmount" - COALESCE(r.refunded, 0) > 0;
-- ↑ 故意**不卡时间窗**：force 改状态的接口今天依然开着（PATCH /orders/:id/status，
--   force=true 仅需 ADMIN/STAFF），07-08 的闸只关了「软删」那条路，没关 force 取消。
--   所以窗口外一样可能有新的。A 的窗口是为了对齐当年那批，E 才是全量口径。

ROLLBACK;   -- 只读体检，什么都不留下
