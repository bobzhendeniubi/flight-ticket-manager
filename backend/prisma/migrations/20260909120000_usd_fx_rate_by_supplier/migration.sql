-- 美金汇率表按签证公司分开维护：supplier 空 = 通用/缺省行（只在该公司没有汇率时兜底）。
-- 唯一键从「生效日」改为「签证公司 × 生效日」；Postgres 多个 NULL 不互撞，通用行同日重复由服务层校验。
-- 存量行 supplier 一律为空 → 自动成为通用行，取数行为与改前一致（先按公司找，找不到才回落到它们）。
-- DropIndex
DROP INDEX "UsdFxRate_effectiveFrom_key";

-- AlterTable
ALTER TABLE "UsdFxRate" ADD COLUMN     "supplier" TEXT;

-- CreateIndex
CREATE INDEX "UsdFxRate_effectiveFrom_idx" ON "UsdFxRate"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "UsdFxRate_supplier_effectiveFrom_key" ON "UsdFxRate"("supplier", "effectiveFrom");
