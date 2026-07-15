-- 存量回填：录单签证状态 = E_VISA（电子签·三个月多次）的订单补建签证台任务。
--
-- 口径变更配套（公测反馈：签证台「签证类型」筛选与录单签证状态未关联，筛不出结果）：
-- 此前订单级兜底仅 visaStatus=NEEDED 建 VISA_APPLICATION 任务，E_VISA 不建，
-- 导致录单选「电子签(三个月多次)」的单子根本不进签证台。应用层新口径已把 E_VISA
-- 纳入建任务范围（下单 / PAID 两条路径），这里一次性补齐存量单：
--   · 父订单未软删，状态在运营计数口径内（排除取消族）
--   · 全单没有任何「活动」签证任务（CANCELLED 视为不存在，与应用层幂等口径一致）
--   · 任务挂到该单 id 最小的订单项（FulfillmentTask 仅有 orderItemId 外键，无 Order 直挂）
INSERT INTO "FulfillmentTask" ("id", "orderItemId", "type", "status", "attempts", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  anchor."itemId",
  'VISA_APPLICATION'::"FulfillmentType",
  'PENDING'::"FulfillmentStatus",
  0,
  now(),
  now()
FROM "Order" o
JOIN LATERAL (
  SELECT oi."id" AS "itemId"
  FROM "OrderItem" oi
  WHERE oi."orderId" = o."id"
  ORDER BY oi."id"
  LIMIT 1
) anchor ON true
WHERE o."visaStatus" = 'E_VISA'
  AND o."deletedAt" IS NULL
  AND o."status" IN (
    'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'TICKETED',
    'COMPLETED', 'REFUND_REQUESTED', 'CHANGE_REQUESTED', 'CHANGED'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "FulfillmentTask" ft
    JOIN "OrderItem" oi2 ON oi2."id" = ft."orderItemId"
    WHERE oi2."orderId" = o."id"
      AND ft."type" = 'VISA_APPLICATION'
      AND ft."status" <> 'CANCELLED'
  );
