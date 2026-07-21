-- TICKETED 合一·老单回填（2026-07-20 拍板「老单也得合一」）：
-- 订单级「出票完成」（TICKETED/COMPLETED）是既成事实，但六态航段标记晚于状态机上线，
-- 老单标记大量为 false —— 以订单状态为准把航段开票标记补齐，让两本账从存量起就是一本。
-- 口径：有航段(≥1 个班次)补去程；往返(≥2 个班次)再补回程。纯地面单无票不动。
UPDATE "Order" o SET "outboundInvoiced" = true
WHERE o.status IN ('TICKETED', 'COMPLETED')
  AND o."outboundInvoiced" = false
  AND (SELECT COUNT(DISTINCT oi."flightScheduleId") FROM "OrderItem" oi
       WHERE oi."orderId" = o.id AND oi.kind = 'FLIGHT' AND oi."flightScheduleId" IS NOT NULL) >= 1;

UPDATE "Order" o SET "returnInvoiced" = true
WHERE o.status IN ('TICKETED', 'COMPLETED')
  AND o."returnInvoiced" = false
  AND (SELECT COUNT(DISTINCT oi."flightScheduleId") FROM "OrderItem" oi
       WHERE oi."orderId" = o.id AND oi.kind = 'FLIGHT' AND oi."flightScheduleId" IS NOT NULL) >= 2;
