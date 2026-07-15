-- 回滚 20260715080000：录单自定义产品名称不做（业务口径：订单产品名 = 前台产品名，不可改）。
-- 字段可空且写入入口从未开放使用，直接删除。
ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "productNameOverride";
