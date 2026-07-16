-- =============================================================================
-- 存量体检：singleCount >= 2 的订单（2 位及以上出行人各自「单人入住」）
-- =============================================================================
--
-- 【这是只读体检脚本，不修任何数据】
-- 全文包在 `SET TRANSACTION READ ONLY` 事务里，结尾 ROLLBACK。即使误加了写语句，
-- 数据库层也会直接拒绝执行。不要把这个约束删掉。
--
-- ---------------------------------------------------------------------------
-- 背景（为什么要查）
-- ---------------------------------------------------------------------------
-- computeRoomsNeeded 原口径把「单人入住」（singleCount）完全排除在房间数之外，
-- 只当作一个独立的自愿加价项 → **2 位成人都勾单人入住 = 算 1 间**。
-- 但两人各自独住，物理上就是 2 间：房量校验据此少算 → 超卖；而这个 roomsNeeded
-- 正是喂给物理房间前瞻闸的整间数输入，输入错了闸再准也白搭。
--
-- 修正后：roomsNeeded = clamp(singleCount,0,成人数) + max(ceil(其余成人/maxAdults), 儿童间数)
--
-- 【本次修正只对新单生效，不回填存量单的 roomsBilled / total。】
-- 这条查询就是用来回答「存量里到底有没有 singleCount >= 2 的单」——
--   · 查出来是 0 行  → 这个口径修正对存量零影响，收工；
--   · 查出来有行     → 这些单的房间数（进而房量占用）按新口径本应更多，
--                       交房控人工核对是否需要补房 / 补差价。**不要自动改单**。
--
-- ---------------------------------------------------------------------------
-- 口径（两条来源，与 derivePerPaxBundleOptions 的优先级一致）
-- ---------------------------------------------------------------------------
--   A. 乘客级（新口径，优先）：Passenger.singleRoom = true 的人数 >= 2
--   B. 行级（旧聚合口径）：OrderItem.metadata -> 'addOns' ->> 'singleCount' >= 2
--      （createOrder 在 hasAddOn 或 rooms > 1 时把 addOns.breakdown 落进行 metadata）
-- 两条各自独立输出 来源 列，便于区分。
--
-- ---------------------------------------------------------------------------
-- 用法（连只读副本 / 只读账号执行）
-- ---------------------------------------------------------------------------
--   psql "$DATABASE_URL" -f scripts/audit-single-count-multi.sql
-- =============================================================================

BEGIN;
SET TRANSACTION READ ONLY;

WITH
counted AS (
  SELECT unnest(ARRAY[
    'PENDING_PAYMENT','PAID','PROCESSING','TICKETED',
    'COMPLETED','REFUND_REQUESTED','CHANGE_REQUESTED','CHANGED'
  ]) AS status
),

-- A. 乘客级：勾了「单人入住」的出行人数 >= 2
pax_level AS (
  SELECT
    o.id            AS order_id,
    o."orderNumber",
    o.status::text  AS status,
    '乘客级(Passenger.singleRoom)' AS source,
    COUNT(*)::numeric AS single_count
  FROM "Order" o
  JOIN "Passenger" p ON p."orderId" = o.id
  WHERE o."deletedAt" IS NULL
    AND o.status::text IN (SELECT status FROM counted)
    AND p."singleRoom" = true
  GROUP BY o.id, o."orderNumber", o.status
  HAVING COUNT(*) >= 2
),

-- B. 行级：metadata.addOns.singleCount >= 2
item_level AS (
  SELECT
    o.id            AS order_id,
    o."orderNumber",
    o.status::text  AS status,
    '行级(metadata.addOns.singleCount)' AS source,
    MAX((oi.metadata -> 'addOns' ->> 'singleCount')::numeric) AS single_count
  FROM "Order" o
  JOIN "OrderItem" oi ON oi."orderId" = o.id
  WHERE o."deletedAt" IS NULL
    AND o.status::text IN (SELECT status FROM counted)
    AND (oi.metadata -> 'addOns' ->> 'singleCount') ~ '^[0-9]+$'
    AND (oi.metadata -> 'addOns' ->> 'singleCount')::numeric >= 2
  GROUP BY o.id, o."orderNumber", o.status
)

SELECT
  x."orderNumber"  AS "订单号",
  x.status         AS "状态",
  x.source         AS "来源",
  x.single_count   AS "单人入住人数",
  -- 该单的酒店行现状（用于人工核对房量）
  (
    SELECT string_agg(
      h.name || ' ' || to_char(oi."hotelCheckIn", 'MM-DD') || '~' ||
      to_char(oi."hotelCheckOut", 'MM-DD') || ' 计费' ||
      COALESCE(oi."roomsBilled"::text, '(未填)') || '间',
      '; '
    )
    FROM "OrderItem" oi
    JOIN "HotelRoomType" rt ON rt.id = oi."hotelRoomTypeId"
    JOIN "Hotel" h          ON h.id = rt."hotelId"
    WHERE oi."orderId" = x.order_id AND oi."hotelRoomTypeId" IS NOT NULL
  )                AS "酒店行现状"
FROM (
  SELECT * FROM pax_level
  UNION ALL
  SELECT * FROM item_level
) x
ORDER BY x."orderNumber", x.source;

ROLLBACK;
