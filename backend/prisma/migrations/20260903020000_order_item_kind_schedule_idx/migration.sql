-- OrderItem (kind, flightScheduleId) 复合索引。
--
-- 为什么要它：no-show 这一整条链路的每一次查询都从这两列起手 ——
--   · 贴名单匹配候选人：kind='FLIGHT' AND "flightScheduleId" = <班次>
--   · no-show 报表 / 房控超售告警：kind='FLIGHT' AND "flightScheduleId" IN (<本批班次>)
--   · 回程起飞后自动作废扫描 / 提醒规则 11：kind='FLIGHT' AND "flightScheduleId" IS NULL
-- 现有索引只有 (orderId) 与 (passengerId)，上面每一条都只能全表扫 OrderItem。
-- 一班几十人的名单要逐单预检，扫描 job 每小时跑一次，表随订单量单调增长。
--
-- 纯加索引：不改列、不改数据、不改约束，回滚只需 DROP INDEX。
-- IF NOT EXISTS —— 这个索引可能已被手工建过（线上排查慢查询时临时加的），重复建会让整次迁移失败。

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OrderItem_kind_flightScheduleId_idx" ON "OrderItem"("kind", "flightScheduleId");
