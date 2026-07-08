-- AlterTable
-- 新增套餐「每人操作费」（CNY，默认 ¥20）——卖价侧，计入起价/人，下单按出行人头收。
-- 纯加列 + 默认值：Postgres 用 DEFAULT 20 直接回填所有存量行，无需额外 UPDATE。
-- 与 OrderCostItem.OPERATION_FEE（成本侧、每单固定 ¥20）是两个独立字段，互不关联。
ALTER TABLE "Bundle" ADD COLUMN "operationFeeCny" INTEGER NOT NULL DEFAULT 20;
