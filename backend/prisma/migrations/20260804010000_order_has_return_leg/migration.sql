-- 「本单有回程航段」物化列 Order.hasReturnLeg
--
-- 为什么要物化：Prisma 的 where 表达不了「关联行 ≥ 2 条」，而「回程未开」筛选
-- （returnInvoiced=false）必须排掉单程单 —— 单程单没有回程，returnInvoiced 恒为 false，
-- 天然误命中开票清单。判定回程本来只能在内存里做（determineFlightLegs：带班次的 FLIGHT 行
-- 按 departureTime 升序，存在第 2 段 = 有回程），导出路径已用内存过滤兜住，列表查询层则一直裸奔。
-- 物化成列后查询层可直接 hasReturnLeg=true 收口，导出内存过滤保留作双保险。
--
-- 回填口径与 determineFlightLegs 完全一致：kind=FLIGHT 且 flightScheduleId 非空、
-- 且班次真实存在（JOIN FlightSchedule，departureTime 是排序依据）的行 ≥ 2 条 → true。
-- 软删订单一并回填：本列描述订单结构，与删除态无关。

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "hasReturnLeg" BOOLEAN NOT NULL DEFAULT false;

-- Backfill：一次 GROUP BY 子查询圈出「带班次的 FLIGHT 行 ≥ 2」的订单
UPDATE "Order" o
SET "hasReturnLeg" = true
WHERE o."id" IN (
  SELECT oi."orderId"
  FROM "OrderItem" oi
  JOIN "FlightSchedule" fs ON fs."id" = oi."flightScheduleId"
  WHERE oi."kind" = 'FLIGHT'::"OrderItemKind"
    AND oi."flightScheduleId" IS NOT NULL
  GROUP BY oi."orderId"
  HAVING COUNT(*) >= 2
);
