-- 存量语义迁移：旧版本在订单进入 REFUND_REQUESTED 时仍保留 FLIGHT sold，
-- 新语义则在申请退款时立即释放机位。部署时已处于 REFUND_REQUESTED 的未软删订单
-- 必须一次性从对应班次舱位的 sold 中扣除，否则批准退款会永久泄漏座位，驳回会二次占座。
-- Prisma migration history 保证本文件只执行一次；GREATEST(0, ...) 额外防止异常/脏数据把 sold 扣成负数。
WITH flight_items AS (
  SELECT
    oi."flightScheduleId" AS schedule_id,
    oi."flightCabin" AS original_cabin,
    GREATEST(0, oi.quantity) AS quantity,
    CASE
      WHEN oi."flightCabin" = 'ECONOMY'::"CabinClass"
       AND jsonb_typeof(COALESCE(oi.metadata, '{}'::jsonb)->'businessUpgradeCount') = 'number'
      THEN LEAST(
        GREATEST(0, oi.quantity),
        GREATEST(
          0,
          TRUNC((COALESCE(oi.metadata, '{}'::jsonb)->>'businessUpgradeCount')::numeric)::integer
        )
      )
      ELSE 0
    END AS business_qty
  FROM "OrderItem" oi
  JOIN "Order" o ON o.id = oi."orderId"
  WHERE o.status = 'REFUND_REQUESTED'::"OrderStatus"
    AND o."deletedAt" IS NULL
    AND oi.kind = 'FLIGHT'::"OrderItemKind"
    AND oi."flightScheduleId" IS NOT NULL
    AND oi."flightCabin" IS NOT NULL
), seat_deltas AS (
  SELECT
    schedule_id,
    'BUSINESS'::"CabinClass" AS cabin,
    -SUM(business_qty) AS delta
  FROM flight_items
  WHERE business_qty > 0
  GROUP BY schedule_id

  UNION ALL

  SELECT
    schedule_id,
    original_cabin AS cabin,
    -SUM(quantity - business_qty) AS delta
  FROM flight_items
  WHERE quantity - business_qty > 0
  GROUP BY schedule_id, original_cabin
)
UPDATE "FlightSeatClass" sc
SET sold = GREATEST(0, sc.sold + d.delta),
    "updatedAt" = NOW()
FROM seat_deltas d
WHERE sc."scheduleId" = d.schedule_id
  AND sc.cabin = d.cabin;
