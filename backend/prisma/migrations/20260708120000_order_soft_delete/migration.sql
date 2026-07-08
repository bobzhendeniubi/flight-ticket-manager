-- AlterTable
-- 订单软删除：新增 deletedAt。非空 = 已删（从所有列表/导出/统计里消失，数据保留可追溯）。
-- 纯加可空列，Postgres 直接补 NULL 回填存量行，无需额外 UPDATE。
ALTER TABLE "Order" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
-- 查询口径统一挂 deletedAt: null 排除已删；建索引避免全表扫。
CREATE INDEX "Order_deletedAt_idx" ON "Order"("deletedAt");
