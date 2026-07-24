-- 结算价日历：运营按「出发日期 × 晚数 × 酒店档次」维护每人同业结算价（CNY）。
-- 代理下套餐单按去程出发日期 + 套餐配置的档次/晚数自动取价（服务端权威定价）。

-- CreateEnum
CREATE TYPE "SettlementTier" AS ENUM ('CITY_3STAR', 'CITY_4STAR', 'CITY_5STAR', 'INTL_5STAR');

-- CreateTable
CREATE TABLE "SettlementRate" (
    "id" TEXT NOT NULL,
    "tier" "SettlementTier" NOT NULL,
    "nights" INTEGER NOT NULL,
    "departDate" DATE NOT NULL,
    "pricePerPersonCny" INTEGER NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：同一 (档次, 晚数, 出发日期) 唯一一个每人价（批量 upsert 幂等键）
CREATE UNIQUE INDEX "SettlementRate_tier_nights_departDate_key" ON "SettlementRate"("tier", "nights", "departDate");

-- CreateIndex：按出发日期区间查网格
CREATE INDEX "SettlementRate_departDate_idx" ON "SettlementRate"("departDate");

-- AlterTable：套餐纳入日历取价的两个键（都空 = 不走日历，现状不变）
ALTER TABLE "Bundle" ADD COLUMN     "settlementTier" "SettlementTier";
ALTER TABLE "Bundle" ADD COLUMN     "settlementNights" INTEGER;
