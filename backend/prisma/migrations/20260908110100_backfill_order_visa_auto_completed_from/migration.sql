-- 存量回填：把「自动办结前的录单签证口径」从审计流水搬进 Order.visaAutoCompletedFrom。
--
-- 背景：全员已送签的自动办结（AUTO_COMPLETE_VISA）把订单的 visaStatus 从「电子签 / 需要签证」
-- 改写成「已签证」，原值此前只留在审计的 before JSON 里。签证台的「签证口径」筛选改读
-- 「visaAutoCompletedFrom ?? visaStatus」之后，存量已办结单若不回填，仍会从「电子签」档里消失
-- （公测反馈：电子签的已送签单一条都筛不出来）。
--
-- 只回填「当前仍是已签证、且最近一条办结/回退审计是办结」的单：
--   · 最近一条是 REVERT → 已经退回过，当前的 HAS_VISA 不是派生值，不能碰；
--   · 没有任何办结审计 → 录单手选的已签证（客人自带签证），本就该留在「已签证」档。
-- 幂等：仅当该列当前为 NULL 才写；重复执行不改变结果。
UPDATE "Order" o
SET "visaAutoCompletedFrom" = (a."before" ->> 'visaStatus')::"VisaRequirement"
FROM (
  SELECT DISTINCT ON ("targetId") "targetId", "action", "before"
  FROM "AuditLog"
  WHERE "targetType" = 'ORDER'
    AND "targetId" IS NOT NULL
    AND "action" IN ('AUTO_COMPLETE_VISA', 'AUTO_COMPLETE_VISA_REVERT')
  ORDER BY "targetId", "createdAt" DESC, "id" DESC
) a
WHERE o."id" = a."targetId"
  AND a."action" = 'AUTO_COMPLETE_VISA'
  AND o."visaStatus" = 'HAS_VISA'
  AND o."visaAutoCompletedFrom" IS NULL
  -- 原值为空（录单没填过）或不是合法枚举成员的，留 NULL 不猜
  AND a."before" ->> 'visaStatus' IN ('NOT_NEEDED', 'NEEDED', 'E_VISA', 'HAS_VISA');
