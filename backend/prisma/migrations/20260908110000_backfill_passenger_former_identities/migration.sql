-- 存量回填：把审计流水里的换人记录还原成乘客的「曾用身份」。
--
-- 背景：换人是就地覆盖同一条 Passenger 行，换前的姓名/证件号只剩审计流水里有一份，
-- 订单搜索的 where 够不着（AuditLog 与 Order 没有 Prisma 关系）。新列 Passenger.formerIdentities
-- 从此由换人/订正通道实时追加；这条迁移把上线之前已经换过的人补上，否则老单永远搜不到换前的人。
--
-- 段格式与运行时（formatFormerIdentitySegment）严格一致：
--   段内 = 拼音名 中文名 证件号（空格连接，跳过空值）；段间 = ' | '，按换人发生的先后排列。
-- 数据形状（实测库核对过）：SWAP_ORDER_PASSENGER 的 before =
--   { fullName, documentNumber, passengerId, snapshot: { chineseName, ... } }
--   —— 中文名在 snapshot 里，不在顶层；老记录可能整个没有 snapshot（一律按空处理）。
--
-- 幂等：只写当前为 NULL 的行。重跑不会重复堆段，也不会覆盖上线后实时写入的内容。
WITH swap AS (
  SELECT
    l."before"->>'passengerId' AS passenger_id,
    l."createdAt"              AS created_at,
    concat_ws(
      ' ',
      NULLIF(btrim(COALESCE(l."before"->>'fullName', '')), ''),
      NULLIF(btrim(COALESCE(l."before"->'snapshot'->>'chineseName', '')), ''),
      NULLIF(btrim(COALESCE(l."before"->>'documentNumber', '')), '')
    ) AS segment
  FROM "AuditLog" l
  WHERE l.action = 'SWAP_ORDER_PASSENGER'
    AND l."before"->>'passengerId' IS NOT NULL
),
-- 同一位出行人来回换回同一套身份时只留一段（与运行时的去重口径一致），保留首次出现的次序。
deduped AS (
  SELECT passenger_id, segment, MIN(created_at) AS first_at
  FROM swap
  WHERE segment <> ''
  GROUP BY passenger_id, segment
),
aggregated AS (
  SELECT passenger_id, string_agg(segment, ' | ' ORDER BY first_at) AS segments
  FROM deduped
  GROUP BY passenger_id
)
UPDATE "Passenger" p
SET "formerIdentities" = aggregated.segments
FROM aggregated
WHERE p.id = aggregated.passenger_id
  AND p."formerIdentities" IS NULL;
