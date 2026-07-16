-- =============================================================================
-- 存量体检：出行人「出生日期 / 证件有效期」里日月可能被写反的记录
-- =============================================================================
--
-- 【这是只读体检脚本，不修任何数据】
-- 全文包在 `SET TRANSACTION READ ONLY` 事务里，结尾 ROLLBACK。即使误加了写语句，
-- 数据库层也会直接拒绝执行。不要把这个约束删掉。
--
-- ---------------------------------------------------------------------------
-- 背景（为什么要查）
-- ---------------------------------------------------------------------------
-- 名单导入的日期解析长期存在两条**静默**通道，错的日期不声不响就进了库：
--
--   1. Excel 日期格：Excel 按它自己的 locale 把 `01-07-1990` 解释成日期再存成日期
--      单元格。解析拿到的**已经是 Excel 的解释结果，原始文本永久丢失**。
--      是 1 月 7 日还是 7 月 1 日，事后从文件里也查不出来。
--   2. 兜底猜测：三段数字全 ≤31（如 `05-06-07`）时，旧解析器**兜底当"年在前"**
--      并做两位年扩展 → 静默产出 `2005-06-07`，不发任何 warning。
--
-- 两条通道现已修复（模版日期列改文本格式 + 解析侧存疑一律 warning、歧义拒收，
-- 见 backend/src/modules/orders/roster.ts）。但**修复只对以后的导入生效**——
-- 之前进库的记录已经烂在那儿了，这个脚本就是把嫌疑的挑出来交人工核。
--
-- ---------------------------------------------------------------------------
-- ⚠️ 口径警告一：能机器找出来的只有「日 ≤ 12」这一个信号，别指望更多
-- ---------------------------------------------------------------------------
-- 库里只剩**结果**，没有原文。判断一条记录有没有可能被写反，唯一的依据是：
--
--   * 日 > 12  → **可以自证无误**。日和月互换后不可能还是合法日期（没有 13 月），
--                所以这条记录不存在"被写反"的可能。**不用查**。
--   * 日 ≤ 12  → 日和月互换后**依然是合法日期**（如 2030-01-07 ↔ 2030-07-01），
--                两个都讲得通 → **机器无法分辨，必须人工核护照原件**。
--
-- 再精确一格：**日 = 月**时（如 1990-05-05）互换等于没换 → 无风险，本脚本已排除。
--
-- 所以查询 A 列出来的是**「无法自证」的记录，不是「错的」记录**。
-- 里面绝大多数是对的。它回答的是"哪些必须人工看一眼"，**不是**"哪些错了"。
-- 这个脚本给不出后者，谁也给不出——原文已经没了。
--
-- ---------------------------------------------------------------------------
-- ⚠️ 口径警告二：名单导入不是唯一的写入口
-- ---------------------------------------------------------------------------
-- Passenger 的日期字段还可能来自：护照 OCR、人工录单、前台自助补录。
-- → 查询 A 命中 ≠ 导入造成的。别拿这个清单去推算"导入错了多少"。
--
-- ---------------------------------------------------------------------------
-- ⚠️ 口径警告三：查出来怎么处理，不由工程决定
-- ---------------------------------------------------------------------------
-- 这个脚本只负责**把嫌疑记录列出来**。核对要**看护照原件**（或护照图），
-- 不能靠猜、也不能拿另一个系统的同款脏数据互相印证。
-- 改数据动的是送签材料和值机身份信息 —— 由操作部/签证岗逐条核实后再动。
--
-- ---------------------------------------------------------------------------
-- 怎么跑（staging）
-- ---------------------------------------------------------------------------
--   ssh root@47.83.249.163
--   cd /opt/ftm
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U ftm -d ftm -f - < backend/scripts/audit-suspicious-dates.sql
--
--   # 或把文件拷进容器再跑：
--   docker compose -f docker-compose.prod.yml cp \
--     backend/scripts/audit-suspicious-dates.sql postgres:/tmp/a.sql
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U ftm -d ftm -f /tmp/a.sql
--
-- 时区：Passenger."dateOfBirth" 是 timestamp(3) without time zone（存 UTC），
--       "passportExpiry" 是 date；FlightSchedule."departureTime" 是 timestamp(3)，存 UTC。
--       只取年月日、不做时区换算 —— 生日/有效期本来就是无时区的日历日。
-- =============================================================================

\pset pager off
\timing off

BEGIN;
SET TRANSACTION READ ONLY;   -- ← 硬闸：本事务内任何写操作都会被 PG 拒绝

-- =============================================================================
-- 查询 A —— 主清单：日 ≤ 12 且 日 ≠ 月 → 日月可互换、无法自证 → 需人工核护照原件
-- =============================================================================
-- 每位出行人一行，两个字段各自标记；suspect_fields 直接告诉操作部这个人要核哪几项。
-- 故意**不加 deletedAt IS NULL**：软删单里的人一样可能被复活/被导出，用 order_deleted_at 区分。
\echo '=== [A] 日月可互换（日≤12 且 日≠月）· 需人工核护照原件 ==='
SELECT
  o."orderNumber",
  o.status                                          AS order_status,
  o."deletedAt"                                     AS order_deleted_at,
  p."fullName"                                      AS passenger,
  p."documentNumber"                                AS doc_no,
  p."dateOfBirth"::date                             AS date_of_birth,
  p."passportExpiry"                                AS passport_expiry,
  -- 逐字段标记：哪个字段无法自证
  CONCAT_WS(' + ',
    CASE WHEN p."dateOfBirth" IS NOT NULL
          AND EXTRACT(DAY FROM p."dateOfBirth") <= 12
          AND EXTRACT(DAY FROM p."dateOfBirth") <> EXTRACT(MONTH FROM p."dateOfBirth")
         THEN '出生日期' END,
    CASE WHEN p."passportExpiry" IS NOT NULL
          AND EXTRACT(DAY FROM p."passportExpiry") <= 12
          AND EXTRACT(DAY FROM p."passportExpiry") <> EXTRACT(MONTH FROM p."passportExpiry")
         THEN '证件有效期' END
  )                                                 AS suspect_fields,
  -- 「如果日月写反了会是哪天」一并算出来，方便对着护照原件比对
  CASE WHEN p."dateOfBirth" IS NOT NULL
        AND EXTRACT(DAY FROM p."dateOfBirth") <= 12
        AND EXTRACT(DAY FROM p."dateOfBirth") <> EXTRACT(MONTH FROM p."dateOfBirth")
       THEN MAKE_DATE(
              EXTRACT(YEAR  FROM p."dateOfBirth")::int,
              EXTRACT(DAY   FROM p."dateOfBirth")::int,   -- 日 ↔ 月 互换
              EXTRACT(MONTH FROM p."dateOfBirth")::int
            )
  END                                               AS dob_if_swapped,
  CASE WHEN p."passportExpiry" IS NOT NULL
        AND EXTRACT(DAY FROM p."passportExpiry") <= 12
        AND EXTRACT(DAY FROM p."passportExpiry") <> EXTRACT(MONTH FROM p."passportExpiry")
       THEN MAKE_DATE(
              EXTRACT(YEAR  FROM p."passportExpiry")::int,
              EXTRACT(DAY   FROM p."passportExpiry")::int,
              EXTRACT(MONTH FROM p."passportExpiry")::int
            )
  END                                               AS expiry_if_swapped,
  p."passportPhotoUrl" IS NOT NULL                  AS has_passport_photo,  -- true = 可直接照图核
  o."createdAt"                                     AS order_created_at
FROM "Passenger" p
JOIN "Order" o ON o.id = p."orderId"
WHERE
  (
    p."dateOfBirth" IS NOT NULL
    AND EXTRACT(DAY FROM p."dateOfBirth") <= 12
    AND EXTRACT(DAY FROM p."dateOfBirth") <> EXTRACT(MONTH FROM p."dateOfBirth")
  )
  OR
  (
    p."passportExpiry" IS NOT NULL
    AND EXTRACT(DAY FROM p."passportExpiry") <= 12
    AND EXTRACT(DAY FROM p."passportExpiry") <> EXTRACT(MONTH FROM p."passportExpiry")
  )
ORDER BY o."createdAt" DESC, o."orderNumber", p."fullName";

-- =============================================================================
-- 查询 B —— 高危：证件有效期早于出发日 → 这条记录**已经不可能对**
-- =============================================================================
-- 不需要人工判断"是不是写反了"——它已经自相矛盾了：
-- 要么日期录错（可能就是日月写反），要么这单根本不该放行。
-- 出发日口径与生产一致：取订单**最早**的航班出发日（行程第一段），
--   见 orders.service.ts applyPassportExpiryRule（scheds.reduce 取 min）。
-- 注意：护照有效期规则只在**下单时**校验；下单后改期/改护照都可能让存量记录漂进这里。
\echo ''
\echo '=== [B] 高危：证件有效期 < 出发日（已经不可能对）==='
SELECT
  o."orderNumber",
  o.status                                          AS order_status,
  o."deletedAt"                                     AS order_deleted_at,
  p."fullName"                                      AS passenger,
  p."documentNumber"                                AS doc_no,
  p."passportExpiry"                                AS passport_expiry,
  d.departure::date                                 AS departure_date,
  (p."passportExpiry" - d.departure::date)          AS days_expiry_minus_departure,  -- 负数 = 出发时已过期
  CASE
    WHEN EXTRACT(DAY FROM p."passportExpiry") <= 12
     AND EXTRACT(DAY FROM p."passportExpiry") <> EXTRACT(MONTH FROM p."passportExpiry")
    THEN '日月可互换 → 很可能就是写反了，核原件'
    ELSE '日>12 不可能是日月写反 → 另有原因（录错/真过期）'
  END                                               AS hint
FROM "Passenger" p
JOIN "Order" o ON o.id = p."orderId"
JOIN (
  -- 每单的出发日 = 该单所有 FLIGHT 行里最早的班次出发时间
  SELECT oi."orderId", MIN(fs."departureTime") AS departure
  FROM "OrderItem" oi
  JOIN "FlightSchedule" fs ON fs.id = oi."flightScheduleId"
  WHERE oi."flightScheduleId" IS NOT NULL
  GROUP BY oi."orderId"
) d ON d."orderId" = o.id
WHERE p."passportExpiry" IS NOT NULL
  AND p."passportExpiry" < d.departure::date
ORDER BY (p."passportExpiry" - d.departure::date), o."orderNumber";

-- =============================================================================
-- 查询 C —— 数据损坏：出生日期在未来 / 年龄 > 120
-- =============================================================================
-- 这类不是"日月写反"，是明显的坏数据（两位年扩展猜错、录入手滑、OCR 看错）。
-- 举例：旧解析器把 `05-06-07` 兜底成 2005-06-07 —— 如果原意是 1905 或 2007 年，
--       结果就落在这里（或落在 A 里，取决于猜出来的年份）。
\echo ''
\echo '=== [C] 数据损坏：出生日期在未来 / 年龄 >120 ==='
SELECT
  o."orderNumber",
  o.status                                          AS order_status,
  o."deletedAt"                                     AS order_deleted_at,
  p."fullName"                                      AS passenger,
  p."documentNumber"                                AS doc_no,
  p."dateOfBirth"::date                             AS date_of_birth,
  p."passengerType"                                 AS passenger_type,
  EXTRACT(YEAR FROM AGE(p."dateOfBirth"))::int      AS age_years,
  CASE
    WHEN p."dateOfBirth" > (NOW() AT TIME ZONE 'UTC')       THEN '出生日期在未来'
    WHEN EXTRACT(YEAR FROM AGE(p."dateOfBirth")) > 120      THEN '年龄 >120'
  END                                               AS verdict
FROM "Passenger" p
JOIN "Order" o ON o.id = p."orderId"
WHERE p."dateOfBirth" IS NOT NULL
  AND (
    -- dateOfBirth 是 timestamp without time zone 且存 UTC；NOW() 是 timestamptz。
    -- 直接比会按会话 TimeZone 隐式换算 → 结果依赖跑脚本的人的时区设置。
    -- AT TIME ZONE 'UTC' 把 NOW() 落成 UTC 的 timestamp，与存储口径对齐。
    p."dateOfBirth" > (NOW() AT TIME ZONE 'UTC')
    OR EXTRACT(YEAR FROM AGE(p."dateOfBirth")) > 120
  )
ORDER BY p."dateOfBirth";

-- =============================================================================
-- 查询 D —— 汇总：人工核对的工作量有多大
-- =============================================================================
-- dob_self_provable 那一栏是**好消息**：这些记录日 >12，日月互换后不合法 → 不用核。
-- 用它给操作部一个"要核多少 / 一共多少"的比例感。
\echo ''
\echo '=== [D] 汇总：嫌疑面 vs 可自证面 ==='
SELECT
  COUNT(*)                                                     AS passengers_total,
  COUNT(*) FILTER (
    WHERE p."dateOfBirth" IS NOT NULL
      AND EXTRACT(DAY FROM p."dateOfBirth") <= 12
      AND EXTRACT(DAY FROM p."dateOfBirth") <> EXTRACT(MONTH FROM p."dateOfBirth")
  )                                                            AS dob_need_manual_check,
  COUNT(*) FILTER (
    WHERE p."passportExpiry" IS NOT NULL
      AND EXTRACT(DAY FROM p."passportExpiry") <= 12
      AND EXTRACT(DAY FROM p."passportExpiry") <> EXTRACT(MONTH FROM p."passportExpiry")
  )                                                            AS expiry_need_manual_check,
  COUNT(*) FILTER (
    WHERE p."dateOfBirth" IS NOT NULL
      AND EXTRACT(DAY FROM p."dateOfBirth") > 12
  )                                                            AS dob_self_provable,   -- 日>12 → 不用核
  COUNT(*) FILTER (WHERE p."dateOfBirth" IS NULL)              AS dob_null,
  COUNT(*) FILTER (WHERE p."passportExpiry" IS NULL)           AS expiry_null,
  COUNT(*) FILTER (WHERE p."passportPhotoUrl" IS NOT NULL)     AS has_passport_photo   -- 有图 = 核起来快
FROM "Passenger" p
JOIN "Order" o ON o.id = p."orderId";

ROLLBACK;   -- 只读体检，什么都不留下
