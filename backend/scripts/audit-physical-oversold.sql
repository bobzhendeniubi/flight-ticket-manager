-- =============================================================================
-- 存量体检：物理房间口径已超卖的 酒店 × 日期（block > 0 且 physicalRemaining < 0）
-- =============================================================================
--
-- 【这是只读体检脚本，不修任何数据】
-- 全文包在 `SET TRANSACTION READ ONLY` 事务里，结尾 ROLLBACK。即使误加了写语句，
-- 数据库层也会直接拒绝执行。不要把这个约束删掉。
--
-- 【绝对不要据此自动取消任何订单】——输出交房控人工协调加房 / 换酒店。
--
-- ---------------------------------------------------------------------------
-- 背景（为什么要查）
-- ---------------------------------------------------------------------------
-- 卖货闸此前用的是**床位口径**（block − Σ roomsBilled）：拼房客各计 0.5 间，
-- 「一位男拼房客 + 一位女拼房客」被算成 1 间。但异性不能拼一间，物理上要 2 间。
-- 床位口径永远看不见性别这一维 → 切闸前可能已经放行过物理超卖的单。
--
-- 切闸（orders.service 的 assertHotelPhysicalFit）只挡**新**单，不会自动修复存量；
-- 且存量超卖会**挤掉新单**（新单撞上已经满了的晚会被拒）。所以要先把存量捞出来人工处理。
--
-- ---------------------------------------------------------------------------
-- 口径（与 hotel-control.service.ts getBoard / getHotelNightlyRemaining 完全一致）
-- ---------------------------------------------------------------------------
--   block(d)        = Σ 该酒店所有包房周期 rooms，dateFrom <= d <= dateTo（可叠加）
--   占房行          = OrderItem 带 hotelRoomTypeId + [hotelCheckIn, hotelCheckOut) 覆盖 d，
--                     且订单 deletedAt IS NULL、status ∈ COUNTED_STATUSES
--   physicalUsed(d) = 有权威分房表的订单按「有乘客的 roomGroup 数」直计（订单级去重，
--                     对该单在该酒店所有行的住宿区间取并集）
--                   + 其余行按性别推算：ceil(男拼房客/2) + ceil(女拼房客/2) + 性别未知数 + 整间数
--   physicalRemaining(d) = block(d) − physicalUsed(d)
--
-- 拼房客 = roomsBilled 恰为 0.5 的占房行。性别取该单第一位 M/F 出行人；X / 未填 / 无出行人
-- → 未知，保守口径每人独占 1 间（「拼单性别未知就把它单独出来」，不参与自动配对）。
--
-- ⚠️ 已知近似：service 里 pickSoloGender 取 order.passengers **数组顺序**的第一位 M/F；
--    SQL 无法复刻该顺序，这里用 ORDER BY id 取第一位 M/F。拼房单恒为单出行人套餐单
--    （adultCount=1），正常只 1 位真实出行人 → 两者一致；多出行人的异常兜底单可能有出入。
--
-- ---------------------------------------------------------------------------
-- 用法（连只读副本 / 只读账号执行）
-- ---------------------------------------------------------------------------
--   psql "$DATABASE_URL" -f scripts/audit-physical-oversold.sql
-- =============================================================================

BEGIN;
SET TRANSACTION READ ONLY;

WITH
-- 与财务/订单导出一致：草稿 / 已取消 / 已退款 / 支付超时 / 失败 不计入
counted AS (
  SELECT unnest(ARRAY[
    'PENDING_PAYMENT','PAID','PROCESSING','TICKETED',
    'COMPLETED','REFUND_REQUESTED','CHANGE_REQUESTED','CHANGED'
  ]) AS status
),

-- 1. 逐日包房量（周期可叠加）
block AS (
  SELECT
    p."hotelId",
    gs::date            AS night,
    SUM(p.rooms)::int   AS block_rooms
  FROM "HotelBlockPeriod" p
  CROSS JOIN LATERAL generate_series(p."dateFrom", p."dateTo", interval '1 day') AS gs
  GROUP BY p."hotelId", gs::date
),

-- 2. 占房行（口径同 getHotelNightlyRemaining 的 used）
occupancy AS (
  SELECT
    o.id                AS order_id,
    o."orderNumber",
    rt."hotelId",
    oi."hotelCheckIn",
    oi."hotelCheckOut",
    -- itemRoomCount：roomsBilled → metadata.roomsNeeded → metadata.rooms → 1
    CASE
      WHEN oi."roomsBilled" IS NOT NULL AND oi."roomsBilled" > 0
        THEN oi."roomsBilled"::numeric
      WHEN (oi.metadata ->> 'roomsNeeded') ~ '^[0-9]+(\.[0-9]+)?$'
       AND (oi.metadata ->> 'roomsNeeded')::numeric > 0
        THEN (oi.metadata ->> 'roomsNeeded')::numeric
      WHEN (oi.metadata ->> 'rooms') ~ '^[0-9]+(\.[0-9]+)?$'
       AND (oi.metadata ->> 'rooms')::numeric > 0
        THEN (oi.metadata ->> 'rooms')::numeric
      ELSE 1
    END                 AS room_count,
    (oi."roomsBilled" = 0.5) AS is_half,
    -- 权威分房表间数（assignedPhysicalRooms）：有乘客的 roomGroup 数；无有效分房表 → NULL。
    -- 外层 jsonb_typeof 守卫必须留着：roomGroups 形状不符（对象/标量）时 jsonb_array_elements
    -- 会直接报错，而 service 侧是防御式解析、形状不符只当作"无分房表"走 fallback，两边必须一致。
    CASE
      WHEN jsonb_typeof(o."roomAssignment" -> 'roomGroups') = 'array' THEN (
        SELECT NULLIF(COUNT(*), 0)
        FROM jsonb_array_elements(o."roomAssignment" -> 'roomGroups') AS g
        WHERE jsonb_typeof(g -> 'passengerIds') = 'array'
          AND jsonb_array_length(g -> 'passengerIds') > 0
      )
      ELSE NULL
    END                 AS assigned_rooms,
    -- 该单第一位 M/F 出行人性别；无 → NULL（= 未知，独占一间）
    (
      SELECT p.gender::text
      FROM "Passenger" p
      WHERE p."orderId" = o.id AND p.gender IN ('M', 'F')
      ORDER BY p.id
      LIMIT 1
    )                   AS solo_gender
  FROM "OrderItem" oi
  JOIN "Order" o          ON o.id = oi."orderId"
  JOIN "HotelRoomType" rt ON rt.id = oi."hotelRoomTypeId"
  WHERE oi."hotelRoomTypeId" IS NOT NULL
    AND oi."hotelCheckIn"  IS NOT NULL
    AND oi."hotelCheckOut" IS NOT NULL
    AND o."deletedAt" IS NULL
    AND o.status::text IN (SELECT status FROM counted)
),

-- 3. 逐晚展开（[checkIn, checkOut) 半开区间）
occupancy_nights AS (
  SELECT
    oc.*,
    gs::date AS night
  FROM occupancy oc
  CROSS JOIN LATERAL generate_series(
    oc."hotelCheckIn",
    oc."hotelCheckOut" - interval '1 day',
    interval '1 day'
  ) AS gs
),

-- 4a. 有分房表的订单：订单级去重（同单同酒店同晚只计一次分房表间数）
assigned_by_night AS (
  SELECT "hotelId", night, SUM(rooms)::numeric AS rooms
  FROM (
    SELECT DISTINCT "hotelId", night, order_id, assigned_rooms AS rooms
    FROM occupancy_nights
    WHERE assigned_rooms IS NOT NULL
  ) d
  GROUP BY "hotelId", night
),

-- 4b. 无分房表的订单：性别推算 fallback
fallback_by_night AS (
  SELECT
    "hotelId",
    night,
    COUNT(*) FILTER (WHERE is_half AND solo_gender = 'M')   AS m,
    COUNT(*) FILTER (WHERE is_half AND solo_gender = 'F')   AS f,
    COUNT(*) FILTER (WHERE is_half AND solo_gender IS NULL) AS u,
    -- 整间数 = (Σ room_count×2 的 half-unit 总量 − 拼房客 half-unit) / 2
    (SUM(room_count * 2) - COUNT(*) FILTER (WHERE is_half)) / 2.0 AS whole_rooms
  FROM occupancy_nights
  WHERE assigned_rooms IS NULL
  GROUP BY "hotelId", night
),

-- 5. 物理占房 = 分房表直计 + 性别推算
physical AS (
  SELECT
    b."hotelId",
    b.night,
    b.block_rooms,
    COALESCE(a.rooms, 0)
      + COALESCE(ceil(fb.m / 2.0), 0)
      + COALESCE(ceil(fb.f / 2.0), 0)
      + COALESCE(fb.u, 0)
      + COALESCE(fb.whole_rooms, 0) AS physical_used
  FROM block b
  LEFT JOIN assigned_by_night a  ON a."hotelId" = b."hotelId" AND a.night = b.night
  LEFT JOIN fallback_by_night fb ON fb."hotelId" = b."hotelId" AND fb.night = b.night
)

-- 6. 只输出真超卖：block > 0 且 physicalRemaining < 0
SELECT
  h.name                                        AS "酒店",
  ph.night                                      AS "日期",
  ph.block_rooms                                AS "包房间数",
  ph.physical_used                              AS "物理需要间数",
  (ph.block_rooms - ph.physical_used)           AS "物理余量(负=超卖)",
  ceil(ph.physical_used - ph.block_rooms)       AS "需补房间数",
  (
    SELECT string_agg(DISTINCT onx."orderNumber", ', ')
    FROM occupancy_nights onx
    WHERE onx."hotelId" = ph."hotelId" AND onx.night = ph.night
  )                                             AS "涉及订单号"
FROM physical ph
JOIN "Hotel" h ON h.id = ph."hotelId"
WHERE ph.block_rooms > 0
  AND (ph.block_rooms - ph.physical_used) < 0
ORDER BY ph.night, h.name;

ROLLBACK;
