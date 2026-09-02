-- 存量「取消航段」单的 legFlag 回填。
--
-- 取消航段功能早于 legFlag 列上线，那批单的 metadata 里已经有 returnLegCancelled 快照，
-- 不回填的话它们会一直停在 NONE，而导出列「航段状态」按快照现算已经写着「已作废」——
-- 同一张单在筛选与导出里对不上。
-- （no-show / 释放 / 恢复三态在 legFlag 列上线时线上尚无任何单，无需回填。）
--
-- 一张单可能两段都被取消过（先取消回程、再取消去程）：DISTINCT ON 让 OUTBOUND 那行优先，
-- 与 deriveLegStatus 的优先级和 syncOrderLegFlag 的映射一致。
-- 回填只认取消航段这一态；漏网或事后漂移由 backend/scripts/sync-order-leg-flag.ts 幂等自愈。
-- 幂等：按快照重算后覆盖写，重跑结果相同。
UPDATE "Order" AS o
SET "legFlag" = v."flag"::"OrderLegFlag"
FROM (
  SELECT DISTINCT ON (i."orderId")
    i."orderId" AS "orderId",
    CASE
      WHEN i."metadata" -> 'returnLegCancelled' ->> 'leg' = 'OUTBOUND' THEN 'OUTBOUND_VOIDED'
      ELSE 'RETURN_VOIDED'
    END AS "flag"
  FROM "OrderItem" i
  WHERE i."kind" = 'FLIGHT'
    AND i."metadata" -> 'returnLegCancelled' IS NOT NULL
  ORDER BY i."orderId", (i."metadata" -> 'returnLegCancelled' ->> 'leg') = 'OUTBOUND' DESC, i."id"
) AS v
WHERE o."id" = v."orderId"
  AND o."legFlag" IS DISTINCT FROM v."flag"::"OrderLegFlag";
